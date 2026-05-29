/**
 * embed/chunk.js — индексация длинных актов (is_long_act=TRUE) с REAL late chunking
 * + ColBERT multivector per chunk.
 *
 * Контракт (после переработки 2026-05-23):
 *   PG: vector_status='pending' AND is_long_act=TRUE → один акт = N chunk-points.
 *   Chunking: server-side balanced paragraph-aware,
 *     chunk_count = ceil(tokens / max_chunk_tokens=8000),
 *     target_per_chunk = ceil(tokens / chunk_count),
 *     границы тянутся к ближайшему \\n\\n в пределах ±12% от target,
 *     hard-clamp'ятся к max_chunk_tokens (forward snap не пробивает cap).
 *   На сервер шлём ОРИГИНАЛЬНЫЙ act.act_text без client-side chunks; сервер
 *   делает один forward pass Jina v4 → token embeddings с full-document
 *   attention, потом нарезает на чанки без overlap.
 *
 *   /embed_late_chunks вход:
 *     full_text:           act.act_text
 *     max_chunk_tokens:    8000 (env RAS_LATE_CHUNK_MAX_TOKENS)
 *     paragraph_tolerance: 0.12 (env RAS_LATE_CHUNK_PARAGRAPH_TOLERANCE)
 *     return_colbert:      true
 *   /embed_late_chunks выход:
 *     • dense_late_vectors[i] — 128-dim mean-pool токенов в спане chunk[i]
 *     • colbert_vectors[i]    — RAW multivector токенов чанка (без mean-pool),
 *                                 [n_tokens_in_chunk × 128]
 *     • sparse_vectors[i]     — sparse TF на slice full_text[start:end]
 *     • token_counts[i]       — токенов в спане
 *     • full_tokens, full_chars
 *
 *   Qdrant points (unit_type=chunk):
 *     id      = uuidv5("<act_id>:<chunk_id>", NAMESPACE) — детерминированно
 *     vectors = { dense_late, colbert (multivector, max_sim), sparse? }
 *     payload = { unit_type:'chunk', act_id, chunk_id, start_char, end_char,
 *                 has_colbert: true, ... }
 *
 * Идемпотентность:
 *   Scope-delete по payload.act_id перед upsert — при смене chunk strategy
 *   или количества чанков старые stale-points сметаются.
 *
 * Лимит акта: сервер возвращает error `too_long_for_late_chunking`, если
 * реальный token_count(prefix + act_text) > 32768. Сейчас обрабатываем как
 * markEmbedError; в будущем — windowed late chunking отдельным шагом.
 */

import {
  selectPendingEmbed,
  markEmbedded,
  markEmbedError,
  isActVerdictKeep,
} from "../db/actsRepo.js";

import {
  embedLateChunks,
  upsertPoints,
  deletePointsByActId,
  fetchActMeta,
  chunkPointId,
  isoDate,
} from "./clients.js";

// Qdrant отвергает point >1MB (multivector flatten). На chunk tokens >~8200
// (~2050 colbert vectors × 128 × 4B) ловим 422 «Total size of all vectors must
// be less than 1048576». Hard-clamp ниже cap'а с запасом: жирному chunk'у
// отрубаем colbert, оставляем dense_late + sparse — индексируем без потери
// chunk'а целиком, MaxSim просто не сработает на этом конкретном куске.
const COLBERT_MAX_TOKENS_PER_POINT = Number(
  process.env.RAS_COLBERT_MAX_TOKENS_PER_POINT ?? 7500,
);

function buildChunkPoint(act, meta, chunk, denseLate, colbert, sparse, tokens, log) {
  const v = {
    dense_late: denseLate,
  };
  // ColBERT multivector per chunk — основной качественный сигнал для длинных
  // актов (паритет с full_act). MaxSim в ветке long_colbert через named vector
  // "colbert" с multivector_config max_sim (та же схема, что для short).
  const tooFatForColbert =
    Number.isFinite(tokens) && tokens > COLBERT_MAX_TOKENS_PER_POINT;
  const hasColbert =
    !tooFatForColbert &&
    Array.isArray(colbert) && colbert.length > 0 && Array.isArray(colbert[0]);
  if (hasColbert) {
    v.colbert = colbert;
  } else if (tooFatForColbert && typeof log === "function") {
    log(
      `    [chunk/colbert_skip act=${act.id} chunk=${chunk.id}] tokens=${tokens} > ${COLBERT_MAX_TOKENS_PER_POINT} — colbert dropped (Qdrant 1MB point cap)`,
    );
  }
  if (sparse && Array.isArray(sparse.indices) && sparse.indices.length > 0) {
    v.sparse = sparse;
  }
  return {
    id: chunkPointId(act.id, chunk.id),
    vector: v,
    payload: {
      act_id:              act.id,
      unit_type:           "chunk",
      has_colbert:         hasColbert,
      chunk_id:            chunk.id,
      start_char:          chunk.start,
      end_char:            chunk.end,
      token_count:         tokens,
      is_long_act:         true,
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
 * Проиндексировать один long-акт: late chunks + per-chunk colbert → Qdrant.
 *
 * Сюда передают уже выбранный из PG акт (vector_status='indexing' выставлен
 * вызывающим — например selectPendingEmbed / selectPendingLongInTokenRange).
 * meta — результат fetchActMeta для построения payload.
 *
 * @param {{id:string,act_text:string}} act
 * @param {object|null} meta  Payload-метаданные акта (case_id, court, …).
 *                            null = недостающие поля payload запишутся null'ами.
 * @param {(msg:string)=>void} log
 * @returns {Promise<{ok:boolean, staleVerdict?:boolean, chunks:number, tokens:number}>}
 */
async function indexOne(act, meta, log) {
  if (process.env.RAS_ENABLE_CHUNK_INDEXING !== "1") {
    throw new Error("chunk indexing disabled — set RAS_ENABLE_CHUNK_INDEXING=1 to enable balanced late chunking with colbert per chunk");
  }

  const t0 = Date.now();
  const maxChunkTokens     = Number(process.env.RAS_LATE_CHUNK_MAX_TOKENS ?? 8000);
  const paragraphTolerance = Number(process.env.RAS_LATE_CHUNK_PARAGRAPH_TOLERANCE ?? 0.12);

  log(
    `  [chunk act=${act.id}] text_len=${act.act_text.length} ` +
    `max_chunk_tokens=${maxChunkTokens} tol=${paragraphTolerance} mode=balanced_paragraph_aware`,
  );

  await deletePointsByActId(act.id);

  const tEmbed = Date.now();
  const out = await embedLateChunks(act.act_text, null, {
    task: "retrieval.passage",
    returnSparse: true,
    returnColbert: true,
    maxChunkTokens,
    paragraphTolerance,
  });

  if (out.full_chars !== act.act_text.length) {
    throw new Error(
      `late_chunks: full_chars mismatch server=${out.full_chars} client=${act.act_text.length} act=${act.id}`,
    );
  }

  const chunks = out.chunks ?? [];
  if (chunks.length === 0) {
    throw new Error(`late_chunks: empty server chunks act=${act.id}`);
  }

  if (chunks.length !== out.dense_late_vectors.length || chunks.length !== out.token_counts.length) {
    throw new Error(
      `late_chunks: shape mismatch chunks=${chunks.length} dense=${out.dense_late_vectors.length} tokens=${out.token_counts.length} act=${act.id}`,
    );
  }

  if (!Array.isArray(out.colbert_vectors) || out.colbert_vectors.length !== chunks.length) {
    throw new Error(
      `late_chunks: missing colbert per chunk (expected ${chunks.length}, got ${out.colbert_vectors?.length ?? "null"}) act=${act.id}`,
    );
  }

  log(
    `    [embed/late] mode=${out.chunk_mode} max_chunk_tokens=${out.max_chunk_tokens} ` +
    `tol=${out.paragraph_tolerance} ` +
    `chunks=${chunks.length} full_chars=${out.full_chars} full_tokens=${out.full_tokens} ` +
    `chunk_tokens=[${out.token_counts.join(",")}] in ${Date.now() - tEmbed}ms`,
  );

  // Pre-upsert verdict guard: pendant late_chunks GPU-времени могло пройти
  // десятки секунд — резолвер parser.js мог флипнуть verdict_keep в FALSE.
  // Если так — Qdrant write отменяем; cleanup подберёт акт по
  // vector_status='error' + verdict_keep IS FALSE.
  const stillKeep = await isActVerdictKeep(act.id);
  if (stillKeep !== true) {
    const reason = `verdict_keep_flipped:${stillKeep === false ? "false" : "null"}`;
    await markEmbedError(act.id, reason).catch(() => {});
    log(`  [skip act=${act.id}] ${reason} — Qdrant upsert отменён, cleanup подберёт`);
    return { ok: false, staleVerdict: true, chunks: 0, tokens: 0 };
  }

  const points = chunks.map((c, i) =>
    buildChunkPoint(
      act,
      meta,
      c,
      out.dense_late_vectors[i],
      out.colbert_vectors[i],
      out.sparse_vectors?.[i] ?? null,
      out.token_counts[i],
      log,
    ),
  );

  // Per-point upsert (а не batch) — multivector chunk на ~7000 токенов даёт
  // 7000×128 float ≈ 3.5MB payload. Batch'ить даже по 2-3 → за лимит Qdrant.
  let upserted = 0;
  for (const p of points) {
    try {
      await upsertPoints([p]);
      upserted += 1;
    } catch (e) {
      const msg = String(e?.stack ?? e?.message ?? e);
      throw new Error(
        `upsert chunk failed act=${act.id} chunk_id=${p.payload.chunk_id} tokens=${p.payload.token_count}: ${msg.slice(0, 300)}`,
      );
    }
  }

  const sumChunkTokens = out.token_counts.reduce((a, b) => a + (b | 0), 0);
  const fullTokens = out.full_tokens || sumChunkTokens;

  await markEmbedded(act.id, { tokenCount: fullTokens, isLongAct: true });

  log(
    `  [ok act=${act.id}] indexed ${upserted}/${points.length} chunks (with colbert), ` +
    `full_tokens=${fullTokens} sum_chunk_tokens=${sumChunkTokens} in ${Date.now() - t0}ms`,
  );

  return { ok: true, chunks: upserted, tokens: fullTokens };
}

/**
 * Прогнать одну пачку длинных актов: pull batchSize, late-chunk-embed, upsert.
 *
 * @param {number} batchSize  число актов (не chunks!) за итерацию
 * @param {(msg:string)=>void} [log=console.log]
 * @returns {Promise<{ batchSize: number, indexed: number, errored: number, totalChunks: number }>}
 */
export async function embedChunkActBatch(batchSize, log = console.log) {
  if (process.env.RAS_ENABLE_CHUNK_INDEXING !== "1") {
    log("[chunk/disabled] set RAS_ENABLE_CHUNK_INDEXING=1 to enable token-aware late chunk indexing");
    return { batchSize: 0, indexed: 0, errored: 0, totalChunks: 0 };
  }

  const batch = await selectPendingEmbed(batchSize, true);
  if (batch.length === 0) {
    return { batchSize: 0, indexed: 0, errored: 0, totalChunks: 0 };
  }
  const meta = await fetchActMeta(batch.map((r) => r.id));

  let indexed = 0;
  let errored = 0;
  let staleVerdict = 0;
  let totalChunks = 0;
  for (const act of batch) {
    try {
      const r = await indexOne(act, meta.get(act.id), log);
      if (r.ok) {
        indexed += 1;
        totalChunks += r.chunks;
      } else if (r.staleVerdict) {
        staleVerdict += 1;
      } else {
        errored += 1;
      }
    } catch (e) {
      const msg = String(e?.stack ?? e?.message ?? e);
      // Distinct clean marker для >32k actов (limit jina v4 embedding context).
      // Парсим real_token_count из ошибки сервера, чтобы downstream запросы могли
      // фильтровать через `vector_error LIKE 'skip:gt_32k_context_limit:%'`.
      let mark = msg;
      const m = msg.match(/too_long_for_late_chunking[\s\S]*?"real_token_count"\s*:\s*(\d+)/);
      if (m) {
        mark = `skip:gt_32k_context_limit:tokens=${m[1]}`;
      } else if (/too_long_for_late_chunking/.test(msg)) {
        mark = "skip:gt_32k_context_limit:tokens=unknown";
      }
      log(`  [err act=${act.id}] ${mark === msg ? msg.slice(0, 400) : mark}`);
      await markEmbedError(act.id, mark).catch(() => {});
      errored += 1;
    }
  }
  return { batchSize: batch.length, indexed, errored, staleVerdict, totalChunks };
}

// Public alias для one-off скриптов (см. backend/indexing/index-long-budgeted.mjs):
// они сами выбирают акты по своим критериям (token range, parallel budget),
// им нужен только тонкий wrapper на одну индексацию.
export { indexOne as indexOneLongAct };
