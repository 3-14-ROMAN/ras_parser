#!/usr/bin/env node
/**
 * scripts/backfill-token-count.mjs — добить tokens_jina_v4 / tokens_jina_v3
 * для уже скачанных актов, у которых хотя бы одно из чисел NULL.
 *
 * Запуск:
 *   node --env-file=.env scripts/backfill-token-count.mjs
 *
 * ENV:
 *   RAS_BACKFILL_BATCH     размер пачки за UPDATE (default 200)
 *   RAS_BACKFILL_MAX       максимум актов за прогон (default ∞)
 *   RAS_BACKFILL_ONLY      v3|v4|both (default both — добиваем строки где
 *                          NULL любое из двух чисел; v3/v4 — только конкретное)
 *
 * Что делает:
 *   - SELECT id, act_text FROM acts WHERE act_text IS NOT NULL
 *                                     AND act_text NOT LIKE '__EXTRACT_FAILED__%'
 *                                     AND (tokens_jina_v4 IS NULL OR tokens_jina_v3 IS NULL)
 *   - Для каждой строки: POST /count_tokens.
 *   - UPDATE acts SET tokens_jina_v4 = …, tokens_jina_v3 = …,
 *                     is_long_act = (tokens_jina_v4 > 8192)
 *           WHERE id = …;
 *
 * Тихо пропускает строки, по которым inference вернул NULL (например,
 * reranker выгружен и v3 не доступен) — следующий прогон их добьёт.
 *
 * Идемпотентно: фильтр в SELECT выбирает только строки с NULL'ами.
 */

import process from "node:process";

import { getPool, closePool } from "../db/pgClient.js";
import { countActTokens } from "../pdf/jinaV3Tokens.js";

const BATCH = Number(process.env.RAS_BACKFILL_BATCH ?? 200);
const MAX = Number(process.env.RAS_BACKFILL_MAX ?? Infinity);
const ONLY = String(process.env.RAS_BACKFILL_ONLY ?? "both").toLowerCase();

if (!["both", "v3", "v4"].includes(ONLY)) {
  console.error(`RAS_BACKFILL_ONLY=${ONLY} not in (both|v3|v4)`);
  process.exit(2);
}

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function whereClause() {
  if (ONLY === "v3") return "tokens_jina_v3 IS NULL";
  if (ONLY === "v4") return "tokens_jina_v4 IS NULL";
  return "(tokens_jina_v4 IS NULL OR tokens_jina_v3 IS NULL)";
}

async function selectBatch(pool, limit) {
  const { rows } = await pool.query(
    `SELECT id::text AS id, act_text
       FROM acts
      WHERE act_text IS NOT NULL
        AND act_text NOT LIKE '__EXTRACT_FAILED__%'
        AND ${whereClause()}
      ORDER BY id
      LIMIT $1`,
    [limit],
  );
  return rows;
}

async function updateRow(pool, id, jinaV3, jinaV4) {
  // Пишем только не-null значения; is_long_act обновляем когда v4 известен.
  await pool.query(
    `UPDATE acts
        SET tokens_jina_v3 = COALESCE($2::INTEGER, tokens_jina_v3),
            tokens_jina_v4 = COALESCE($3::INTEGER, tokens_jina_v4),
            is_long_act    = CASE
                               WHEN $3::INTEGER IS NOT NULL THEN $3::INTEGER > 8000
                               ELSE is_long_act
                             END
      WHERE id = $1::uuid`,
    [id, jinaV3, jinaV4],
  );
}

async function main() {
  log(`[backfill/start] batch=${BATCH} max=${MAX === Infinity ? "∞" : MAX} only=${ONLY}`);
  const pool = await getPool();
  let processed = 0;
  let okV3 = 0;
  let okV4 = 0;
  let missing = 0;

  while (processed < MAX) {
    const remaining = MAX - processed;
    const limit = Math.min(BATCH, remaining);
    const rows = await selectBatch(pool, limit);
    if (!rows.length) {
      log(`[backfill/done] нет больше актов для backfill`);
      break;
    }
    log(`[backfill] взял ${rows.length} актов`);
    for (const row of rows) {
      const { jinaV3, jinaV4 } = await countActTokens(row.act_text);
      if (jinaV3 == null && jinaV4 == null) {
        missing += 1;
      } else {
        await updateRow(pool, row.id, jinaV3, jinaV4);
        if (jinaV3 != null) okV3 += 1;
        if (jinaV4 != null) okV4 += 1;
      }
      processed += 1;
    }
    log(`[backfill] progress=${processed} okV3=${okV3} okV4=${okV4} missing=${missing}`);
    if (rows.length < limit) break;
  }
  log(`[backfill/end] processed=${processed} okV3=${okV3} okV4=${okV4} missing=${missing}`);
}

main()
  .catch((e) => {
    console.error(`[backfill/fatal] ${e && e.stack ? e.stack : e}`);
    process.exitCode = 1;
  })
  .finally(() => closePool().catch(() => {}));
