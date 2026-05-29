#!/usr/bin/env node
/**
 * backend/indexing/index-acts-qdrant.js — CLI: одна пачка chunk-индексации (длинные акты).
 *
 * Тонкая обёртка над embed/chunk.js. Worker — `backend/indexing/embed-worker.js`
 * (бесконечный цикл); этот скрипт — для разового прогона / smoke / отладки.
 *
 * Запуск:
 *   node --env-file=.env backend/indexing/index-acts-qdrant.js [LIMIT]
 *   npm run embed:chunk -- 2
 *
 * ВАЖНО: chunk-индексация использует только REAL late chunking:
 * полный act.act_text + spans -> /embed_late_chunks -> dense_late vectors.
 * Старый режим /embed по независимым чанкам запрещён и удалён из активного кода.
 */

import process from "node:process";

import { embedChunkActBatch } from "../embed/chunk.js";
import { pipelineStats } from "../db/actsRepo.js";
import { closePool } from "../db/pgClient.js";

const LIMIT = Number(process.argv[2] || 2);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  log(`[chunk] limit=${LIMIT}`);
  const before = await pipelineStats();
  log(
    `[chunk/before] pending=${before.embed_pending} indexed=${before.embed_indexed} error=${before.embed_error}`,
  );

  const r = await embedChunkActBatch(LIMIT, log);

  const after = await pipelineStats();
  log(
    `[chunk/done] batch=${r.batchSize} indexed=${r.indexed} chunks=${r.totalChunks} error=${r.errored} | pending=${after.embed_pending} indexed=${after.embed_indexed} error=${after.embed_error}`,
  );
}

main()
  .catch((e) => {
    process.stderr.write(`[fatal] ${e?.stack ?? e?.message ?? e}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
