#!/usr/bin/env node
/**
 * scripts/cleanup-invalid-acts.js — one-shot sweep по актам с
 * `verdict_keep IS FALSE`, у которых остались RAG-артефакты (act_text,
 * pdf-файл, points в Qdrant). Удаляет артефакты, метаданные оставляет.
 *
 * Используется:
 *   - после ввода в работу cleanup-механики, чтобы вычистить legacy-сирот;
 *   - вручную если что-то пошло не так / для отладки.
 *
 * Запуск:
 *   node --env-file=.env scripts/cleanup-invalid-acts.js
 *   npm run cleanup:invalid
 *
 * ENV:
 *   RAS_CLEANUP_BATCH       размер пачки за проход (200)
 */

import process from "node:process";

import { cleanupInvalidActs } from "../db/cleanupInvalidActs.js";
import { closePool } from "../db/pgClient.js";

const batchSize = Number(process.env.RAS_CLEANUP_BATCH ?? 200);

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

log(`[cleanup/start] batchSize=${batchSize}`);

cleanupInvalidActs({ batchSize, log })
  .then((res) => {
    log(
      `[cleanup/done] scanned=${res.scanned} reset=${res.rows_reset} ` +
      `qdrant_deleted=${res.qdrant_deleted} pdf_deleted=${res.pdf_deleted} errors=${res.errors}`,
    );
    if (res.errors > 0) process.exitCode = 1;
  })
  .catch((e) => {
    process.stderr.write(`[fatal] ${e?.stack ?? e?.message ?? e}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
