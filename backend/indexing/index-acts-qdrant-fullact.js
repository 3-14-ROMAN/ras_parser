#!/usr/bin/env node
/**
 * backend/indexing/index-acts-qdrant-fullact.js — CLI: одна пачка full-act индексации.
 *
 * Тонкая обёртка над embed/fullAct.js. Worker — `backend/indexing/embed-worker.js`
 * (бесконечный цикл); этот скрипт — для разового прогона / smoke / отладки.
 *
 * Запуск:
 *   node --env-file=.env backend/indexing/index-acts-qdrant-fullact.js [LIMIT]
 *   npm run embed:fullact -- 10
 */

import process from "node:process";

import { embedFullActBatch } from "../embed/fullAct.js";
import { pipelineStats } from "../db/actsRepo.js";
import { closePool } from "../db/pgClient.js";

const LIMIT = Number(process.argv[2] || 3);

function log(msg) {
  process.stdout.write(`${msg}\n`);
}

async function main() {
  log(`[fullact] limit=${LIMIT}`);
  const before = await pipelineStats();
  log(
    `[fullact/before] pending=${before.embed_pending} indexed=${before.embed_indexed} error=${before.embed_error}`,
  );

  const r = await embedFullActBatch(LIMIT, log);

  const after = await pipelineStats();
  log(
    `[fullact/done] batch=${r.batchSize} indexed=${r.indexed} error=${r.errored} | pending=${after.embed_pending} indexed=${after.embed_indexed} error=${after.embed_error}`,
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
