/**
 * embed/fullAct.js — индексация коротких актов (is_long_act=FALSE) в Qdrant.
 *
 * Контракт:
 *   PG: vector_status='pending' AND is_long_act=FALSE → один акт = один point.
 *   Inference /embed: texts=[act_text] → { multivectors[0], dense_vectors[0] }.
 *   Qdrant point:
 *     id      = act.id (UUID),  идемпотентно
 *     vectors = { colbert: multivectors[0], dense: dense_vectors[0] }
 *     payload = { unit_type:'full_act', has_colbert:true, token_count, … }
 *
 * State machine: selectPendingEmbed уже перевёл строки в 'indexing'; здесь
 * либо markEmbedded → 'indexed', либо markEmbedError → 'error'.
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

// Эвристика «акт слишком длинный для full_act пайплайна» — применяется ДО
// /embed, чтобы не платить 13–17s GPU-времени на акты, которые всё равно
// будут зареroute'ены в chunk. Порог в символах подобран по факту: акты
// 8k–11k токенов на русском legal-тексте — это примерно >24k символов.
//
// Точный gate (token-based MAX_COLBERT_TOKENS) остаётся после /embed, на
// случай ошибки эвристики (text короткий, но плотный — много токенов).
const LONG_ACT_CHAR_THRESHOLD = Number(
  process.env.RAS_LONG_ACT_CHAR_THRESHOLD ?? 26000,
);

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

async function indexOne(act, meta, log) {
  // ── Cheap pre-route: до /embed решаем по уже известному token_count или
  // по эвристике length(act_text). Это экономит 13–17s GPU-времени на актах,
  // которые всё равно ушли бы в chunk pipeline по too_many_colbert_tokens.
  const textLen = act.act_text?.length ?? 0;
  const knownTokens = Number.isFinite(act.token_count) ? Number(act.token_count) : null;

  let preRouteReason = null;
  if (knownTokens !== null && knownTokens > MAX_COLBERT_TOKENS) {
    preRouteReason = `pre_route_long_act:token_count=${knownTokens}>${MAX_COLBERT_TOKENS}`;
  } else if (textLen > LONG_ACT_CHAR_THRESHOLD) {
    preRouteReason = `pre_route_long_act:text_len=${textLen}>${LONG_ACT_CHAR_THRESHOLD}`;
  }

  if (preRouteReason) {
    const pool = await getPool();
    await pool.query(
      `UPDATE acts
          SET is_long_act   = TRUE,
              vector_status = 'pending',
              vector_error  = $2
        WHERE id = $1::uuid`,
      [act.id, preRouteReason],
    );
    log(
      `  [pre_route_long_act] act=${act.id} text_len=${textLen} ` +
      `token_count=${knownTokens ?? "(unknown)"} threshold=${LONG_ACT_CHAR_THRESHOLD} ` +
      `→ is_long_act=TRUE, pending для chunk-пайплайна`,
    );
    return { ok: false, rerouted: true };
  }

  const t0 = Date.now();
  const out = await embedTexts([act.act_text], { task: "retrieval.passage", returnSparse: true });
  const colbert = out.multivectors[0];
  const dense   = out.dense_vectors[0];
  const sparse  = out.sparse_vectors?.[0] ?? null;
  const tokens  = out.token_counts[0];
  log(
    `  [embed act=${act.id}] tokens=${tokens} colbert=${colbert.length}x${colbert[0]?.length ?? 0} dense=${dense.length} sparse=${sparse?.indices?.length ?? 0} in ${Date.now() - t0}ms`,
  );

  if (tokens > MAX_COLBERT_TOKENS) {
    const reason = `too_many_colbert_tokens:${tokens}`;
    // Safety gate: если char-эвристика ошиблась (text короткий, но плотный
    // по токенам), всё ещё страхуемся. НЕ markEmbedError — переадресация
    // в chunk-пайплайн, как делали раньше.
    const pool = await getPool();
    await pool.query(
      `UPDATE acts
          SET is_long_act   = TRUE,
              token_count   = $2,
              vector_status = 'pending',
              vector_error  = $3
        WHERE id = $1::uuid`,
      [act.id, tokens, `re-route:${reason}`],
    );
    log(`  [reroute act=${act.id}] ${reason} → is_long_act=TRUE, pending для chunk-пайплайна`);
    return { ok: false, rerouted: true };
  }

  // Pre-upsert verdict guard: между selectPendingEmbed (фильтрует verdict_keep=TRUE)
  // и моментом upsert'а прошло >10с GPU-времени, за которые резолвер parser.js
  // мог флипнуть verdict_keep в FALSE. В этом случае точку в Qdrant не пишем —
  // помечаем 'error' и отдаём cleanup'у (он подберёт по vector_status='error' +
  // verdict_keep IS FALSE и обнулит RAG-state).
  const stillKeep = await isActVerdictKeep(act.id);
  if (stillKeep !== true) {
    const reason = `verdict_keep_flipped:${stillKeep === false ? "false" : "null"}`;
    await markEmbedError(act.id, reason).catch(() => {});
    log(`  [skip act=${act.id}] ${reason} — Qdrant upsert отменён, cleanup подберёт`);
    return { ok: false, staleVerdict: true };
  }

  const point = buildPoint(act, meta, { colbert, dense, sparse, tokens });
  await upsertPoints([point]);
  await markEmbedded(act.id, { tokenCount: tokens, isLongAct: false });
  log(`  [ok act=${act.id}] indexed full_act`);
  return { ok: true };
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
 * Прогнать одну пачку: pull batchSize, embed, upsert, mark.
 *
 * @param {number} batchSize
 * @param {(msg:string)=>void} [log=console.log]
 * @returns {Promise<{ batchSize: number, indexed: number, errored: number, rerouted: number, rerouted_pre: number, missing_marked: number }>}
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
      rerouted_pre:   repair.rerouted_pre,
      missing_marked: repair.missing_marked,
    };
  }
  const meta = await fetchActMeta(batch.map((r) => r.id));

  let indexed = 0;
  let errored = 0;
  let rerouted = 0;
  let staleVerdict = 0;
  for (const act of batch) {
    try {
      const r = await indexOne(act, meta.get(act.id), log);
      if (r.ok)                 indexed     += 1;
      else if (r.rerouted)      rerouted    += 1;
      else if (r.staleVerdict)  staleVerdict += 1;
      else                      errored     += 1;
    } catch (e) {
      const msg = String(e?.stack ?? e?.message ?? e);
      log(`  [err act=${act.id}] ${msg.slice(0, 400)}`);
      await markEmbedError(act.id, msg).catch(() => {});
      errored += 1;
    }
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
