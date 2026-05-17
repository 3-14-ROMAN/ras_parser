#!/usr/bin/env node
/**
 * scripts/embed-worker.js — CLI-обёртка над embed/worker.js.
 *
 * Запуск:
 *   node --env-file=.env scripts/embed-worker.js
 *   npm run embed:worker
 *
 * ENV:
 *   RAS_EMBED_INTERVAL_MS       sleep между итерациями, когда очередь пуста (5000)
 *   RAS_EMBED_BATCH_FULL        акты за итерацию в full-act ветке  (5)
 *   RAS_EMBED_BATCH_CHUNK       акты за итерацию в chunk-ветке     (2)
 *   RAS_EMBED_MAX_ITERATIONS    остановиться после N итераций      (∞)
 *
 * Stop: SIGINT/SIGTERM — worker дорабатывает текущую итерацию и выходит.
 */

import process from "node:process";

import { runWorker } from "../embed/worker.js";
import { closePool } from "../db/pgClient.js";

const intervalMs     = Number(process.env.RAS_EMBED_INTERVAL_MS     ?? 5000);
const batchSizeFull  = Number(process.env.RAS_EMBED_BATCH_FULL      ?? 5);
const batchSizeChunk = Number(process.env.RAS_EMBED_BATCH_CHUNK     ?? 2);
const maxIterations  = process.env.RAS_EMBED_MAX_ITERATIONS
  ? Number(process.env.RAS_EMBED_MAX_ITERATIONS) || null
  : null;

const controller = new AbortController();
let stopRequested = false;
function stop(sig) {
  if (stopRequested) {
    process.stderr.write(`\n[worker] второй ${sig}, форсирую exit\n`);
    process.exit(130);
  }
  stopRequested = true;
  process.stderr.write(`\n[worker] получил ${sig}, ставлю abort (дождёмся итерации)\n`);
  controller.abort();
}
process.on("SIGINT",  () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));

runWorker({
  intervalMs,
  batchSizeFull,
  batchSizeChunk,
  signal: controller.signal,
  maxIterations,
})
  .catch((e) => {
    process.stderr.write(`[fatal] ${e?.stack ?? e?.message ?? e}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
