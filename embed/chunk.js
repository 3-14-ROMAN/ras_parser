/**
 * embed/chunk.js — индексация длинных актов (is_long_act=TRUE) с REAL late chunking.
 *
 * Контракт (Шаг 3):
 *   PG: vector_status='pending' AND is_long_act=TRUE → один акт = N chunk-points.
 *   Chunking: char-based, CHUNK_SIZE / CHUNK_OVERLAP, последовательные chunk_id.
 *   Inference /embed_late_chunks: ОДИН forward pass всего акта →
 *     • dense_late_vectors[i] (128-dim mean-pool токенов чанка i) — long-context
 *       awareness внутри каждого чанка.
 *     • sparse_vectors[i]    — sparse TF чанка (Qdrant считает IDF).
 *     • token_counts[i]       — фактическое число токенов.
 *   Qdrant points:
 *     id      = uuidv5("<act_id>:<chunk_id>", NAMESPACE) — детерминированно
 *     vectors = { dense_late, sparse? }   (colbert per-chunk — Шаг 4 optional)
 *     payload = { unit_type:'chunk', act_id, chunk_id, start_char, end_char, … }
 *
 * Идемпотентность:
 *   Scope-delete по payload.act_id перед upsert — если меняется CHUNK_SIZE
 *   или количество чанков, старые stale-points сметаются.
 *
 * Сложность truncation: encode_text(max_length=32768) обрежет вход; если акт
 * длиннее ~32k токенов, последние чанки могут оказаться без покрытия —
 * /embed_late_chunks вернёт всё-таки результат через token_alignment_mismatch
 * либо обрежет offsets. Эти кейсы редкие (32k токенов = ~100k символов).
 */

import {
  selectPendingEmbed,
  markEmbedded,
  markEmbedError,
} from "../db/actsRepo.js";

import {
  embedLateChunks,
  upsertPoints,
  deletePointsByActId,
  fetchActMeta,
  chunkText,
  chunkPointId,
  isoDate,
  CHUNK_SIZE,
  CHUNK_OVERLAP,
} from "./clients.js";

function buildChunkPoint(act, meta, chunk, denseLate, sparse, tokens) {
  const v = {
    dense_late: denseLate,
  };
  if (sparse && Array.isArray(sparse.indices) && sparse.indices.length > 0) {
    v.sparse = sparse;
  }
  return {
    id: chunkPointId(act.id, chunk.id),
    vector: v,
    payload: {
      act_id:              act.id,
      unit_type:           "chunk",
      has_colbert:         false,
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

async function indexOne(act, meta, log) {
  const t0 = Date.now();
  const chunks = chunkText(act.act_text, CHUNK_SIZE, CHUNK_OVERLAP);
  log(
    `  [chunk act=${act.id}] text_len=${act.act_text.length} → ${chunks.length} чанков (size=${CHUNK_SIZE}/overlap=${CHUNK_OVERLAP})`,
  );

  // Scope-delete старых chunks (на случай смены чанк-размера).
  await deletePointsByActId(act.id);

  // ОДИН forward pass на акт — late chunking.
  const tEmbed = Date.now();
  const out = await embedLateChunks(chunks.map((c) => c.text), {
    task: "retrieval.passage",
    returnSparse: true,
  });
  log(
    `    [embed/late] ${chunks.length} chunks, full_tokens=${out.full_tokens}, in ${Date.now() - tEmbed}ms`,
  );

  const points = chunks.map((c, i) =>
    buildChunkPoint(
      act,
      meta,
      c,
      out.dense_late_vectors[i],
      out.sparse_vectors?.[i] ?? null,
      out.token_counts[i],
    ),
  );
  await upsertPoints(points);

  const totalTokens = out.token_counts.reduce((a, b) => a + (b | 0), 0);
  await markEmbedded(act.id, { tokenCount: totalTokens, isLongAct: true });
  log(
    `  [ok act=${act.id}] indexed ${points.length} chunks, total_tokens=${totalTokens} in ${Date.now() - t0}ms`,
  );
  return { ok: true, chunks: points.length, tokens: totalTokens };
}

/**
 * Прогнать одну пачку длинных актов: pull batchSize, late-chunk-embed, upsert.
 *
 * @param {number} batchSize  число актов (не chunks!) за итерацию
 * @param {(msg:string)=>void} [log=console.log]
 * @returns {Promise<{ batchSize: number, indexed: number, errored: number, totalChunks: number }>}
 */
export async function embedChunkActBatch(batchSize, log = console.log) {
  const batch = await selectPendingEmbed(batchSize, true);
  if (batch.length === 0) {
    return { batchSize: 0, indexed: 0, errored: 0, totalChunks: 0 };
  }
  const meta = await fetchActMeta(batch.map((r) => r.id));

  let indexed = 0;
  let errored = 0;
  let totalChunks = 0;
  for (const act of batch) {
    try {
      const r = await indexOne(act, meta.get(act.id), log);
      if (r.ok) {
        indexed += 1;
        totalChunks += r.chunks;
      } else {
        errored += 1;
      }
    } catch (e) {
      const msg = String(e?.stack ?? e?.message ?? e);
      log(`  [err act=${act.id}] ${msg.slice(0, 400)}`);
      await markEmbedError(act.id, msg).catch(() => {});
      errored += 1;
    }
  }
  return { batchSize: batch.length, indexed, errored, totalChunks };
}
