/**
 * embed/fullAct.js — индексация коротких актов (is_long_act=FALSE) в Qdrant.
 *
 * Контракт:
 *   PG: vector_status='pending' AND is_long_act=FALSE → один акт = один point.
 *   Inference /embed: texts=[…] → { multivectors[i], dense_vectors[i] }.
 *   Qdrant point:
 *     id      = act.id (UUID),  идемпотентно
 *     vectors = { colbert: multivectors[i], dense: dense_vectors[i] }
 *     payload = { unit_type:'full_act', has_colbert:true, token_count, … }
 *
 * State machine: selectPendingEmbed уже перевёл строки в 'indexing'; здесь
 * либо markEmbedded → 'indexed', либо markEmbedError → 'error'.
 *
 * Batching (2026-05-23): из БД pull'ится `batchSize` актов за итерацию, дальше
 * упаковываются в sub-batches по `RAS_EMBED_TOKEN_BUDGET` (def 24000) на один
 * POST /embed. Это даёт реальный GPU-параллелизм: V100 fp16 умеет считать
 * forward на 4–16 текстах одновременно практически за то же время, что и
 * один. Качество идентично одиночному прогону — каждый текст имеет свою
 * attention-маску, multivector/dense/sparse возвращаются по индексам.
 *
 * Спец-кейс: если /embed вернул >MAX_COLBERT_TOKENS токенов — Qdrant не примет
 * multivector (flatten > 1MB). Помечаем error + переводим is_long_act=TRUE,
 * чтобы при следующем bump'е акт ушёл в chunk-пайплайн.
 */

import {
  selectPendingEmbed,
  markEmbedded,
  markEmbedError,
  reroutePendingShortOverTokenGate,
  markMissingRerankerTokensForEmbedding,
  isActVerdictKeep,
} from "../db/actsRepo.js";
import { getPool } from "../db/pgClient.js";

import {
  embedTexts,
  upsertPoints,
  fetchActMeta,
  isoDate,
  MAX_COLBERT_TOKENS,
} from "./clients.js";

// Pre-route gate: точный счёт через tokens_jina_v4 (наш embedder tokenizer).
// Считается на стадии extract в pdf/pipeline.js одним POST /count_tokens
// и кладётся в acts.tokens_jina_v4. Селектор selectPendingEmbed(false)
// уже фильтрует по tokens_jina_v4 <= 8000, плюс reroute-репеир ловит
// акты, у которых v4 NULL или > 8000 — они уходят в long pipeline.
//
// Старый char-based порог (LONG_ACT_CHAR_THRESHOLD=26000) убран: при
// настоящем late chunking символьная эвристика бесполезна — есть точный
// token count. Acts с tokens_jina_v4=NULL обрабатываются репеир-шагом
// (markMissingRerankerTokensForEmbedding), char-fallback больше не
// нужен.

// Бюджет «padded токенов» на один POST /embed (один GPU forward pass).
//
// ВАЖНО: это НЕ сумма токенов всех актов. Jina паддит все акты в batch'е
// до длины самого длинного, поэтому VRAM растёт как
//   peak ≈ batch_size × max_tokens_in_batch × const
// а не как сумма токенов. Поэтому budget сравнивается с
//   padded_total = batch_size × max_tokens_in_batch.
//
// 16000 даёт безопасный peak VRAM ≤ 22 GB на V100 fp16 при worst case
// (один акт 8k токенов + один 8k = padded 16000, peak ~21 GB).
// Можно поднимать осторожно — следить за peak_gb в inference.log.
const TOKEN_BUDGET = Number(process.env.RAS_EMBED_TOKEN_BUDGET ?? 16000);

// Hard cap на размер одного GPU sub-batch'а (число актов). Защита от
// «много мелких актов на ~500 токенов» — там бюджет может вместить 30+, но
// серверный EMBED_BATCH_SIZE=32 и стоимость JSON parse/upsert делают
// смысл резать раньше.
const MAX_SUB_BATCH = Number(process.env.RAS_EMBED_MAX_SUB_BATCH ?? 16);

function buildPoint(act, meta, vectors) {
  const v = {
    colbert: vectors.colbert,
    dense:   vectors.dense,
  };
  // Sparse — пустой {indices:[],values:[]} пропускаем (Qdrant нормально живёт
  // с отсутствующим sparse-named-vector для point'а; не засоряем индекс).
  if (vectors.sparse && Array.isArray(vectors.sparse.indices) && vectors.sparse.indices.length > 0) {
    v.sparse = vectors.sparse;
  }
  return {
    id: act.id, // point id = act.id для full_act
    vector: v,
    payload: {
      act_id:              act.id,
      unit_type:           "full_act",
      has_colbert:         true,
      chunk_id:            null,
      token_count:         vectors.tokens,
      is_long_act:         false,
      case_id:             meta?.case_id ?? null,
      case_number:         meta?.case_number ?? null,
      court:               meta?.court ?? null,
      registration_date:   isoDate(meta?.registration_date),
      type_name:           meta?.type_name ?? null,
      true_instance_level: meta?.true_instance_level ?? null,
      verdict_keep:        meta?.verdict_keep ?? null,
      verdict_action:      meta?.verdict_action ?? null,
      pdf_link:            meta?.pdf_link ?? null,
    },
  };
}

/**
 * Pre-route guard: до /embed выкидываем акты, которые по точному счёту
 * tokens_jina_v4 заведомо не влезут в multivector (>MAX_COLBERT_TOKENS).
 * Они едут в chunk pipeline.
 *
 * Используем тройной приоритет источников счёта (от точного к менее точному):
 *   1. tokens_jina_v4 (счёт embedder'а из /count_tokens, заполняется на extract)
 *   2. token_count    (legacy, forward-pass count после /embed)
 *
 * Если оба NULL — пропускаем pre-route guard и ждём, что post-embed gate
 * (MAX_COLBERT_TOKENS после /embed) поймает переразмерные акты. Это редкий
 * edge-case, обычно tokens_jina_v4 заполнено к моменту embed-pipeline.
 *
 * @returns {string|null} reason если переводим в long, null если ОК идти в /embed
 */
function _preRouteReason(act) {
  const v4 = Number.isFinite(act.tokens_jina_v4) ? Number(act.tokens_jina_v4) : null;
  const legacy = Number.isFinite(act.token_count) ? Number(act.token_count) : null;
  const known = v4 ?? legacy;

  if (known !== null && known > MAX_COLBERT_TOKENS) {
    const source = v4 !== null ? "tokens_jina_v4" : "token_count";
    return `pre_route_long_act:${source}=${known}>${MAX_COLBERT_TOKENS}`;
  }
  return null;
}

async function _markPreRoutedLong(act, reason) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET is_long_act   = TRUE,
            vector_status = 'pending',
            vector_error  = $2
      WHERE id = $1::uuid`,
    [act.id, reason],
  );
}

async function _markPostRoutedLong(actId, tokens, reason) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET is_long_act   = TRUE,
            token_count   = $2,
            vector_status = 'pending',
            vector_error  = $3
      WHERE id = $1::uuid`,
    [actId, tokens, `re-route:${reason}`],
  );
}

function _estimateTokens(act) {
  // tokens_jina_v4 — точный счёт от embedder'а (заполняется на extract).
  // Это правильный счёт для GPU padding: padded ≈ batch × max(tokens_jina_v4).
  // Fallback на tokens_jina_v3 (reranker токены) если v4 NULL — близко по
  // порядку величины, но менее точно. Финальный fallback — char/3.
  const v4 = Number(act.tokens_jina_v4);
  if (Number.isFinite(v4) && v4 > 0) return v4;
  const v3 = Number(act.tokens_jina_v3);
  if (Number.isFinite(v3) && v3 > 0) return v3;
  return Math.max(1, Math.ceil((act.act_text?.length ?? 0) / 3));
}

/**
 * Упаковать acts в sub-batches с учётом padding waste.
 *
 * Стратегия:
 *  1. SORT ASC by tokens — короткие акты группируются, длинные идут одни/парами.
 *     Без сортировки [5000, 800, 6000] паддит ВСЁ до 6000 (батч = 3×6000 = 18000).
 *     После сортировки → [800], [5000, 6000] (или раздельно), padding waste ↓.
 *  2. GREEDY pack — добавляем акт пока `(batch_size+1) × max(tokens) ≤ budget`.
 *     budget сравнивается с PADDED total, не sum, потому что peak VRAM Jina
 *     зависит от `batch × max_seq`, а не от `sum(seq)`.
 *  3. MAX_SUB_BATCH cap — серверный EMBED_BATCH_SIZE=32 и JSON-overhead делают
 *     batch>16 малополезным даже для коротких актов.
 *  4. Single act > budget — берётся одним (batch=1, padded = его длина).
 *     Это бывает редко (`RAS_EMBED_SHORT_MAX_TOKENS=8000` отсекает крупное).
 *
 * @param {Array<{id:string, act_text:string, tokens_jina_v3:number|null}>} acts
 * @param {number} budget — Max padded tokens per sub-batch.
 * @returns {Array<Array<object>>}
 */
function _packByTokens(acts, budget) {
  const sorted = [...acts].sort((a, b) => _estimateTokens(a) - _estimateTokens(b));

  const subBatches = [];
  let current = [];
  let currentMax = 0;

  for (const act of sorted) {
    const tokens = _estimateTokens(act);
    const newMax = Math.max(currentMax, tokens);
    const paddedTotal = (current.length + 1) * newMax;

    const wouldExceed = current.length > 0 && (
      paddedTotal > budget ||
      current.length >= MAX_SUB_BATCH
    );

    if (wouldExceed) {
      subBatches.push(current);
      current = [];
      currentMax = 0;
    }
    current.push(act);
    currentMax = Math.max(currentMax, tokens);
  }

  if (current.length > 0) subBatches.push(current);
  return subBatches;
}

/**
 * Обработать один GPU sub-batch:
 *  - один POST /embed на все acts
 *  - per-act post-route gate (если tokens > MAX_COLBERT_TOKENS)
 *  - per-act verdict guard (vredict_keep мог флипнуться за время GPU)
 *  - один upsertPoints на оставшихся
 *  - per-act markEmbedded
 *
 * Если /embed выкинул исключение — все acts в этом sub-batch'е помечаются
 * markEmbedError с текстом исключения (как было в одиночной ветке).
 *
 * @returns {Promise<{ indexed:number, errored:number, rerouted:number, staleVerdict:number }>}
 */
async function _embedSubBatch(acts, meta, log) {
  const texts = acts.map((a) => a.act_text);
  const t0 = Date.now();

  let out;
  try {
    out = await embedTexts(texts, { task: "retrieval.passage", returnSparse: true });
  } catch (e) {
    const msg = String(e?.stack ?? e?.message ?? e);
    log(`  [err batch size=${acts.length}] ${msg.slice(0, 400)}`);
    for (const act of acts) {
      await markEmbedError(act.id, msg).catch(() => {});
    }
    return { indexed: 0, errored: acts.length, rerouted: 0, staleVerdict: 0 };
  }

  const elapsedMs = Date.now() - t0;
  const tokensSeen = out.token_counts;
  log(
    `  [embed batch=${acts.length}] in ${elapsedMs}ms ` +
    `tokens=[${tokensSeen.join(",")}] ` +
    `sum=${tokensSeen.reduce((s, x) => s + x, 0)} ` +
    `per_act_avg=${Math.round(elapsedMs / acts.length)}ms`,
  );

  const points = [];
  const toMark = []; // { id, tokens } для markEmbedded после успешного upsert
  let rerouted = 0;
  let staleVerdict = 0;

  for (let i = 0; i < acts.length; i += 1) {
    const act     = acts[i];
    const tokens  = out.token_counts[i];
    const colbert = out.multivectors[i];
    const dense   = out.dense_vectors[i];
    const sparse  = out.sparse_vectors?.[i] ?? null;

    // Post-embed safety gate (char-эвристика могла промахнуться).
    if (tokens > MAX_COLBERT_TOKENS) {
      const reason = `too_many_colbert_tokens:${tokens}`;
      await _markPostRoutedLong(act.id, tokens, reason);
      log(`  [reroute act=${act.id}] ${reason} → is_long_act=TRUE`);
      rerouted += 1;
      continue;
    }

    // Verdict-flip guard (за время GPU резолвер мог флипнуть verdict_keep).
    const stillKeep = await isActVerdictKeep(act.id);
    if (stillKeep !== true) {
      const reason = `verdict_keep_flipped:${stillKeep === false ? "false" : "null"}`;
      await markEmbedError(act.id, reason).catch(() => {});
      log(`  [skip act=${act.id}] ${reason}`);
      staleVerdict += 1;
      continue;
    }

    points.push(buildPoint(act, meta.get(act.id), { colbert, dense, sparse, tokens }));
    toMark.push({ id: act.id, tokens });
  }

  if (points.length === 0) {
    return { indexed: 0, errored: 0, rerouted, staleVerdict };
  }

  // Per-point upsert: один multivector с 5000+ токенов = 5000×128×float ≈
  // 10-15 MB JSON. Qdrant дефолтный payload limit = 32 MB. Batched upsert
  // даже на 3-4 длинных актах вылетает в 400 "Payload error". GPU-параллелизм
  // уже взяли через batched /embed; экономия на Qdrant batch'е незначительна
  // (HTTP overhead vs payload size). Шлём по одному.
  let indexed = 0;
  let errored = 0;
  for (let i = 0; i < points.length; i += 1) {
    const m = toMark[i];
    try {
      await upsertPoints([points[i]]);
      await markEmbedded(m.id, { tokenCount: m.tokens, isLongAct: false });
      indexed += 1;
    } catch (e) {
      const msg = String(e?.stack ?? e?.message ?? e);
      log(`  [err upsert act=${m.id}] ${msg.slice(0, 300)}`);
      await markEmbedError(m.id, msg).catch(() => {});
      errored += 1;
    }
  }
  log(`  [ok batch=${indexed}/${points.length}] indexed full_act${errored > 0 ? ` (errored=${errored})` : ""}`);

  return { indexed, errored, rerouted, staleVerdict };
}

/**
 * Repair-проход перед обычным `selectPendingEmbed(false)`:
 *
 *  1) Pending short-акты с `tokens_jina_v3 > shortMaxTokens` → переводим в
 *     long-очередь (`is_long_act=TRUE`, vector_status остаётся 'pending'),
 *     vector_error='pending_late_chunking:reranker_token_gate'. Эти rows
 *     учитываются как `rerouted_pre`, не как errored.
 *  2) Pending short-акты с `tokens_jina_v3 IS NULL` → 'error',
 *     vector_error='skip:missing_tokens_jina_v3'. Без счёта токенов мы не
 *     можем безопасно ни эмбедить short, ни маршрутизировать в chunk.
 *
 * Без этого прохода такие rows зависают навсегда: short-селектор фильтрует
 * по gate'у, long-селектор требует is_long_act=TRUE.
 *
 * Лимиты — небольшая партия каждый раз. На большой backlog покрывается за
 * несколько итераций worker'а (idle-loop всё равно крутится).
 *
 * @returns {Promise<{ rerouted_pre: number, missing_marked: number }>}
 */
async function repairMisroutedShortPending(batchSize, log) {
  const shortMaxTokens = Number(process.env.RAS_EMBED_SHORT_MAX_TOKENS ?? 8000);
  // Repair-лимит держим в 4× от batchSize: достаточно, чтобы за пару
  // итераций разобрать любой реалистичный backlog (десятки-сотни строк),
  // и не блокируем основной embed на тысячах UPDATE'ов в одной транзакции.
  const repairLimit = Math.max(50, batchSize * 4);

  const rerouted = await reroutePendingShortOverTokenGate(shortMaxTokens, repairLimit);
  for (const r of rerouted.rows) {
    log(`  [route/long] act=${r.id} tokens_jina_v3=${r.tokens_jina_v3} reason=reranker_token_gate`);
  }

  const missing = await markMissingRerankerTokensForEmbedding(repairLimit);
  for (const r of missing.rows) {
    log(`  [route/missing_tokens] act=${r.id}`);
  }

  return { rerouted_pre: rerouted.count, missing_marked: missing.count };
}

/**
 * Прогнать одну пачку: pull batchSize, pre-route filter, pack into GPU
 * sub-batches по TOKEN_BUDGET, embed+upsert+mark на каждый sub-batch.
 *
 * @param {number} batchSize  Сколько актов pull'ить из БД за итерацию (рекомендую 16-32).
 * @param {(msg:string)=>void} [log=console.log]
 * @returns {Promise<{ batchSize: number, indexed: number, errored: number, rerouted: number, staleVerdict?: number, rerouted_pre: number, missing_marked: number }>}
 */
export async function embedFullActBatch(batchSize, log = console.log) {
  const repair = await repairMisroutedShortPending(batchSize, log).catch((e) => {
    log(`  [route/repair_failed] ${String(e?.message ?? e).slice(0, 200)}`);
    return { rerouted_pre: 0, missing_marked: 0 };
  });

  const batch = await selectPendingEmbed(batchSize, false);
  if (batch.length === 0) {
    return {
      batchSize:      0,
      indexed:        0,
      errored:        0,
      rerouted:       0,
      staleVerdict:   0,
      rerouted_pre:   repair.rerouted_pre,
      missing_marked: repair.missing_marked,
    };
  }

  // Cheap pre-route: до /embed выкидываем заведомо long акты по tokens_jina_v4.
  const eligible = [];
  let rerouted = 0;
  for (const act of batch) {
    const reason = _preRouteReason(act);
    if (reason) {
      try {
        await _markPreRoutedLong(act, reason);
        log(
          `  [pre_route_long_act] act=${act.id} ` +
          `tokens_jina_v4=${Number.isFinite(act.tokens_jina_v4) ? act.tokens_jina_v4 : "(null)"} ` +
          `token_count=${Number.isFinite(act.token_count) ? act.token_count : "(null)"} ` +
          `→ is_long_act=TRUE, pending для chunk-пайплайна`,
        );
        rerouted += 1;
      } catch (e) {
        const msg = String(e?.stack ?? e?.message ?? e);
        log(`  [err pre_route act=${act.id}] ${msg.slice(0, 300)}`);
        await markEmbedError(act.id, msg).catch(() => {});
      }
    } else {
      eligible.push(act);
    }
  }

  if (eligible.length === 0) {
    return {
      batchSize:      batch.length,
      indexed:        0,
      errored:        0,
      rerouted,
      staleVerdict:   0,
      rerouted_pre:   repair.rerouted_pre,
      missing_marked: repair.missing_marked,
    };
  }

  const meta = await fetchActMeta(eligible.map((r) => r.id));
  const subBatches = _packByTokens(eligible, TOKEN_BUDGET);

  // Лог формата: sizes=[ N1×Maxtok1, N2×Maxtok2, ... ]
  // Так видно и количество актов в sub-batch'е, и какой длиной он будет
  // паддиться (== реальный peak VRAM пропорционально N × Maxtok).
  const packSummary = subBatches.map((s) => {
    const maxTok = s.reduce((m, a) => Math.max(m, _estimateTokens(a)), 0);
    return `${s.length}×${maxTok}`;
  }).join(",");
  log(
    `  [pack] eligible=${eligible.length} sub_batches=${subBatches.length} ` +
    `[${packSummary}] budget=${TOKEN_BUDGET}`,
  );

  let indexed = 0;
  let errored = 0;
  let staleVerdict = 0;

  for (const sub of subBatches) {
    const r = await _embedSubBatch(sub, meta, log);
    indexed      += r.indexed;
    errored      += r.errored;
    rerouted     += r.rerouted;
    staleVerdict += r.staleVerdict;
  }

  return {
    batchSize:      batch.length,
    indexed,
    errored,
    rerouted,
    staleVerdict,
    rerouted_pre:   repair.rerouted_pre,
    missing_marked: repair.missing_marked,
  };
}

/**
 * Smart wrapper для production worker'а: принимает пользовательский pull
 * (например, selectPendingShortByTokensAsc — tokens_jina_v4 ASC) и заданный
 * tokenBudget. Логика packing'а та же, что у embedFullActBatch.
 *
 * Repair-проход и null/oversized маркировки делает worker сам (см. embed/worker.js).
 *
 * @param {object} opts
 * @param {(n:number)=>Promise<Array<object>>} opts.pull   функция, которая атомарно
 *                                                          переводит pending→indexing
 * @param {number} opts.maxActs                              верхняя граница pull (def 8)
 * @param {number} opts.tokenBudget                          бюджет padded tokens на sub-batch
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{ batchSize:number, indexed:number, errored:number, rerouted:number, staleVerdict:number }>}
 */
export async function embedFullActBatchSmart(opts) {
  const {
    pull,
    maxActs,
    tokenBudget,
    log = console.log,
  } = opts;

  const batch = await pull(maxActs);
  if (batch.length === 0) {
    return { batchSize: 0, indexed: 0, errored: 0, rerouted: 0, staleVerdict: 0 };
  }

  const eligible = [];
  let rerouted = 0;
  for (const act of batch) {
    const reason = _preRouteReason(act);
    if (reason) {
      try {
        await _markPreRoutedLong(act, reason);
        log(`  [pre_route_long_act] act=${act.id} tokens_jina_v4=${act.tokens_jina_v4 ?? "(null)"}`);
        rerouted += 1;
      } catch (e) {
        const msg = String(e?.stack ?? e?.message ?? e);
        log(`  [err pre_route act=${act.id}] ${msg.slice(0, 300)}`);
        await markEmbedError(act.id, msg).catch(() => {});
      }
    } else {
      eligible.push(act);
    }
  }

  if (eligible.length === 0) {
    return { batchSize: batch.length, indexed: 0, errored: 0, rerouted, staleVerdict: 0 };
  }

  const meta = await fetchActMeta(eligible.map((r) => r.id));
  const subBatches = _packByTokens(eligible, tokenBudget);

  const packSummary = subBatches.map((s) => {
    const maxTok = s.reduce((m, a) => Math.max(m, _estimateTokens(a)), 0);
    return `${s.length}×${maxTok}`;
  }).join(",");
  log(
    `  [pack] eligible=${eligible.length} sub_batches=${subBatches.length} ` +
    `[${packSummary}] budget=${tokenBudget}`,
  );

  let indexed = 0;
  let errored = 0;
  let staleVerdict = 0;
  for (const sub of subBatches) {
    const r = await _embedSubBatch(sub, meta, log);
    indexed      += r.indexed;
    errored      += r.errored;
    rerouted     += r.rerouted;
    staleVerdict += r.staleVerdict;
  }

  return { batchSize: batch.length, indexed, errored, rerouted, staleVerdict };
}
