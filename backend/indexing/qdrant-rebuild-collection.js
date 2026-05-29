#!/usr/bin/env node
/**
 * backend/indexing/qdrant-rebuild-collection.js — пересборка Qdrant-коллекции `ras_acts`.
 *
 * Зачем: миграция Шага 1 (model fixation) ломает старую vector-схему
 *   {colbert, muvera}
 * и заменяет её на новую
 *   vectors_config:        dense(2048,DOT), colbert(128,COSINE,MAX_SIM, hnsw m=0),
 *                          dense_late(2048,DOT)
 *   sparse_vectors_config: sparse  (заполнение в Шаге 2)
 *
 * Идея: одна коллекция, два типа point'ов:
 *   unit_type=full_act  — короткие акты (1 акт = 1 point):
 *                         dense + colbert (+ позже sparse)
 *   unit_type=chunk     — длинные акты (1 акт = N points c chunk_id):
 *                         dense_late (+ позже sparse, opt. colbert per chunk)
 *
 * Полный текст в PG (`acts.act_text`); Qdrant хранит только поисковые карточки.
 *
 * Действия:
 *   1. DROP collection `ras_acts` (если есть).
 *   2. CREATE с новой vector-схемой и payload-индексами.
 *   3. bumpVectorVersionAll() в PG — сбрасываем `vector_status='indexed'`
 *      обратно в 'pending', чтобы индексер пересобрал точки.
 *
 * Запуск:
 *   node --env-file=.env backend/indexing/qdrant-rebuild-collection.js
 *
 * После прогона:
 *   npm run db:migrate          # no-op, проверка схемы
 *   node --env-file=.env backend/indexing/index-acts-qdrant-fullact.js 5    # smoke
 */

import process from "node:process";

import { bumpVectorVersionAll, pipelineStats } from "../db/actsRepo.js";
import { closePool } from "../db/pgClient.js";

const QDRANT_URL =
  process.env.RAS_QDRANT_URL ||
  process.env.QDRANT_URL ||
  "http://127.0.0.1:6333";
const COLLECTION =
  process.env.RAS_QDRANT_COLLECTION ||
  process.env.QDRANT_COLLECTION ||
  "ras_acts";

const DENSE_DIM    = Number(process.env.RAS_DENSE_DIM    ?? 2048); // Jina v4 single-vec
const COLBERT_DIM  = Number(process.env.RAS_COLBERT_DIM  ?? 128);  // Jina v4 multi-vec

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function qdrant(method, path, body) {
  const url = `${QDRANT_URL}${path}`;
  const opts = {
    method,
    headers: { "content-type": "application/json" },
  };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 800)}`);
  }
  return text ? JSON.parse(text) : null;
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  log(`[setup] qdrant=${QDRANT_URL} collection=${COLLECTION} dryRun=${dryRun}`);

  const cfg = buildCollectionConfig();

  const list = await qdrant("GET", "/collections");
  const has = (list.result?.collections ?? []).some((c) => c.name === COLLECTION);
  log(`[setup] collection_exists=${has}`);

  if (has) {
    const pre = await qdrant("GET", `/collections/${COLLECTION}`);
    const vecNames = Object.keys(pre.result?.config?.params?.vectors ?? {});
    const sparseNames = Object.keys(pre.result?.config?.params?.sparse_vectors ?? {});
    log(`[pre] points=${pre.result?.points_count} vectors=[${vecNames.join(",")}] sparse=[${sparseNames.join(",")}]`);
  }

  if (dryRun) {
    log("[dry-run] propose:");
    log(JSON.stringify(cfg, null, 2));
    return;
  }

  if (has) {
    log(`[step] drop ${COLLECTION}`);
    await qdrant("DELETE", `/collections/${COLLECTION}`);
  }

  log(`[step] create ${COLLECTION}`);
  await qdrant("PUT", `/collections/${COLLECTION}`, cfg);

  log(`[step] payload indexes`);
  await createPayloadIndexes();

  log(`[step] verify`);
  const info = await qdrant("GET", `/collections/${COLLECTION}`);
  const params = info.result?.config?.params ?? {};
  const vecNames = Object.keys(params.vectors ?? {});
  const sparseNames = Object.keys(params.sparse_vectors ?? {});
  log(`[verify] vectors=[${vecNames.join(",")}] sparse=[${sparseNames.join(",")}] points=${info.result?.points_count}`);

  log(`[step] PG: bump vector_version + reset indexed→pending`);
  const { bumped, reset } = await bumpVectorVersionAll();
  log(`[pg] bumped=${bumped} reset=${reset}`);

  const stats = await pipelineStats();
  log(`[pg/stats] embed_pending=${stats.embed_pending} embed_indexed=${stats.embed_indexed} embed_error=${stats.embed_error}`);
}

function buildCollectionConfig() {
  return {
    vectors: {
      // dense — основное dense retrieval для full_act. Jina v4 single-vector
      // (2048, normalized → DOT эквивалентен cosine).
      dense: {
        size: DENSE_DIM,
        distance: "Dot",
      },
      // colbert — late-interaction rerank по full_act (token-level multivector,
      // 128 per token, MaxSim). hnsw_config.m=0: rerank-only, без графа.
      colbert: {
        size: COLBERT_DIM,
        distance: "Cosine",
        multivector_config: { comparator: "max_sim" },
        hnsw_config: { m: 0 },
      },
      // dense_late — dense retrieval для chunk'ов через REAL late chunking:
      // один forward pass акта → mean-pool multivector-токенов чанка → 128-dim.
      // ВАЖНО: 128, а не DENSE_DIM (2048) — это размерность Jina v4 multivector.
      dense_late: {
        size: COLBERT_DIM,
        distance: "Cosine",
      },
    },
    sparse_vectors: {
      // sparse — BM25/SPLADE-style. Модель wire'нём в Шаге 2; слот сейчас
      // пустой. modifier="idf" даёт Qdrant считать IDF на стороне сервера.
      sparse: {
        modifier: "idf",
      },
    },
    on_disk_payload: true,
  };
}

async function createPayloadIndexes() {
  // Payload schemas для фильтров и группировки. Без них Qdrant делает
  // full-scan filter — на 1k+ point'ов уже больно.
  const fields = [
    { name: "act_id",              schema: "keyword" }, // UUID акта в PG
    { name: "unit_type",           schema: "keyword" }, // 'full_act' | 'chunk'
    { name: "has_colbert",         schema: "bool"    }, // v1.12.4 fallback под has_vector filter
    { name: "case_id",             schema: "keyword" },
    { name: "case_number",         schema: "keyword" },
    { name: "court",               schema: "keyword" },
    { name: "true_instance_level", schema: "integer" },
    { name: "verdict_keep",        schema: "bool"    },
    { name: "verdict_action",      schema: "keyword" },
    { name: "type_name",           schema: "keyword" },
    { name: "chunk_id",            schema: "integer" }, // только у chunk
    { name: "registration_date",   schema: "keyword" }, // 'YYYY-MM-DD'
    { name: "is_long_act",         schema: "bool"    },
  ];
  for (const f of fields) {
    try {
      await qdrant("PUT", `/collections/${COLLECTION}/index`, {
        field_name: f.name,
        field_schema: f.schema,
      });
      log(`  payload-index ${f.name}:${f.schema}`);
    } catch (e) {
      log(`  payload-index ${f.name}:${f.schema} ERROR: ${e.message ?? e}`);
    }
  }
}

main()
  .catch((e) => {
    process.stderr.write(`[fatal] ${e.stack ?? e.message ?? e}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
