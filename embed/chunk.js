/**
 * embed/chunk.js — индексация длинных актов (is_long_act=TRUE) с REAL late chunking.
 *
 * Контракт (после fix 2026-05-18):
 *   PG: vector_status='pending' AND is_long_act=TRUE → один акт = N chunk-points.
 *   Chunking: server-side token-aware chunks, target ~2000 tokens.
 *   На сервер шлём ОРИГИНАЛЬНЫЙ act.act_text без client-side chunks; сервер
 *   сам строит token-aware spans и токенизирует именно act_text.
 *
 *   /embed_late_chunks вход:
 *     full_text:    act.act_text
 *     target_chunk_tokens: 2000
 *   /embed_late_chunks выход:
 *     • dense_late_vectors[i] — 128-dim mean-pool токенов в спане chunk[i]
 *     • sparse_vectors[i]    — sparse TF на slice full_text[start:end]
 *     • token_counts[i]       — токенов в спане
 *     • full_tokens, full_chars
 *
 *   Qdrant points:
 *     id      = uuidv5("<act_id>:<chunk_id>", NAMESPACE) — детерминированно
 *     vectors = { dense_late, sparse? }
 *     payload = { unit_type:'chunk', act_id, chunk_id, start_char, end_char, … }
 *
 * Идемпотентность:
 *   Scope-delete по payload.act_id перед upsert — при смене chunk strategy
 *   старые stale-points сметаются.
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
  if (process.env.RAS_ENABLE_CHUNK_INDEXING !== "1") {
    throw new Error("chunk indexing disabled until token-aware ~2000-token late chunking is explicitly enabled");
  }

  const t0 = Date.now();
  const targetChunkTokens = Number(process.env.RAS_LATE_CHUNK_TARGET_TOKENS ?? 2000);

  log(
    `  [chunk act=${act.id}] text_len=${act.act_text.length} target_chunk_tokens=${targetChunkTokens} mode=token_auto`,
  );

  await deletePointsByActId(act.id);

  const tEmbed = Date.now();
  const out = await embedLateChunks(act.act_text, null, {
    task: "retrieval.passage",
    returnSparse: true,
    targetChunkTokens,
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

  log(
    `    [embed/late] mode=${out.chunk_mode} target_chunk_tokens=${out.target_chunk_tokens} ` +
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
      out.sparse_vectors?.[i] ?? null,
      out.token_counts[i],
    ),
  );

  await upsertPoints(points);

  const sumChunkTokens = out.token_counts.reduce((a, b) => a + (b | 0), 0);
  const fullTokens = out.full_tokens || sumChunkTokens;

  await markEmbedded(act.id, { tokenCount: fullTokens, isLongAct: true });

  log(
    `  [ok act=${act.id}] indexed ${points.length} token-aware chunks, ` +
    `full_tokens=${fullTokens} sum_chunk_tokens=${sumChunkTokens} in ${Date.now() - t0}ms`,
  );

  return { ok: true, chunks: points.length, tokens: fullTokens };
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
      log(`  [err act=${act.id}] ${msg.slice(0, 400)}`);
      await markEmbedError(act.id, msg).catch(() => {});
      errored += 1;
    }
  }
  return { batchSize: batch.length, indexed, errored, staleVerdict, totalChunks };
}
