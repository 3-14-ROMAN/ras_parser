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
} from "../db/actsRepo.js";
import { getPool } from "../db/pgClient.js";

import {
  embedTexts,
  upsertPoints,
  fetchActMeta,
  isoDate,
  MAX_COLBERT_TOKENS,
} from "./clients.js";

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
    // НЕ markEmbedError — мы не хотим терминальный 'error', мы хотим
    // переадресацию в chunk-пайплайн. Возвращаемся в 'pending' с
    // is_long_act=TRUE — следующий проход worker'а заберёт через
    // embedChunkActBatch.
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

  const point = buildPoint(act, meta, { colbert, dense, sparse, tokens });
  await upsertPoints([point]);
  await markEmbedded(act.id, { tokenCount: tokens, isLongAct: false });
  log(`  [ok act=${act.id}] indexed full_act`);
  return { ok: true };
}

/**
 * Прогнать одну пачку: pull batchSize, embed, upsert, mark.
 *
 * @param {number} batchSize
 * @param {(msg:string)=>void} [log=console.log]
 * @returns {Promise<{ batchSize: number, indexed: number, errored: number, rerouted: number }>}
 */
export async function embedFullActBatch(batchSize, log = console.log) {
  const batch = await selectPendingEmbed(batchSize, false);
  if (batch.length === 0) {
    return { batchSize: 0, indexed: 0, errored: 0, rerouted: 0 };
  }
  const meta = await fetchActMeta(batch.map((r) => r.id));

  let indexed = 0;
  let errored = 0;
  let rerouted = 0;
  for (const act of batch) {
    try {
      const r = await indexOne(act, meta.get(act.id), log);
      if (r.ok)            indexed  += 1;
      else if (r.rerouted) rerouted += 1;
      else                 errored  += 1;
    } catch (e) {
      const msg = String(e?.stack ?? e?.message ?? e);
      log(`  [err act=${act.id}] ${msg.slice(0, 400)}`);
      await markEmbedError(act.id, msg).catch(() => {});
      errored += 1;
    }
  }
  return { batchSize: batch.length, indexed, errored, rerouted };
}
