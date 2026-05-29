#!/usr/bin/env node
// backend/indexing/index-long-budgeted.mjs — one-off budgeted overnight indexer
// для длинных актов (is_long_act=TRUE) в выбранном диапазоне токенов.
//
// Зачем: production worker (embed/worker.js) индексирует по фиксированному
// batchSizeChunk; на 22k+ токенов параллельность даёт OOM/контроль VRAM
// плохой. Этот скрипт собирает batch не по числу актов, а по сумме
// tokens_jina_v4, и держит peak VRAM в безопасном коридоре.
//
// Логика:
//   1. selectPendingLongInTokenRange(limit, MIN_TOKENS, MAX_TOKENS) — атомарно
//      переводит pending → indexing.
//   2. Сортируем выбранное по tokens_jina_v4 ASC и жадно собираем batch:
//        - пока (parallel_count < MAX_PARALLEL_ACTS) и
//               (sum_tokens + cand.tokens <= MAX_TOKEN_BUDGET) и
//               (parallel_count < per-range cap)
//        - per-range cap снижает MAX_PARALLEL_ACTS на тяжёлых актах
//   3. await Promise.all(batch.map(indexOneLongAct)). Внутри: deletePointsByActId,
//      /embed_late_chunks, per-chunk colbert upsert.
//   4. Safety:
//        - перед каждым batch'ем проверяем search_active lease, спим если active
//        - после batch'а tail inference.log для max peak_gb по этому окну
//        - если в batch были OOM/timeout/upsert error → STOP (no fallback)
//   5. Continue до limit актов или пока selectPendingLongInTokenRange не пуст.
//
// Не трогает production worker. Параллельно безопасно работать вместе с ним
// (FOR UPDATE SKIP LOCKED). Но если worker'у тоже включен chunk indexing —
// они будут грызть одну очередь. Сейчас override.conf держит chunk=0,
// конфликта нет.
//
// Параметры (CLI флаги или env):
//   --limit=300              сколько актов всего обработать
//   --min-tokens=8001
//   --max-tokens=15000
//   --max-parallel=3
//   --budget=30000           MAX_TOKEN_BUDGET суммарно на batch
//   --stop-on-error=1        останавливаться при первой ошибке batch'а
//
// Пример:
//   node --env-file=.env backend/indexing/index-long-budgeted.mjs \
//     --limit=300 --min-tokens=8001 --max-tokens=15000 \
//     --max-parallel=3 --budget=30000
import { selectPendingLongInTokenRange, markEmbedError, isActVerdictKeep } from "../db/actsRepo.js";
import { getPool } from "../db/pgClient.js";
import { indexOneLongAct } from "../embed/chunk.js";
import { fetchActMeta } from "../embed/clients.js";
import { isRuntimeFlagActive, cleanupExpiredRuntimeFlags } from "../db/runtimeFlags.js";
import { promises as fs } from "node:fs";
import { resolve as pathResolve } from "node:path";

const SEARCH_FLAG = process.env.RAS_SEARCH_PRIORITY_FLAG ?? "search_active";
const SEARCH_PAUSE_MS = Number(process.env.RAS_SEARCH_PAUSE_SLEEP_MS ?? 1000);
const INFERENCE_LOG_PATH = pathResolve(process.cwd(), "inference/inference.log");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const m = a.match(/^--([\w-]+)(?:=(.*))?$/);
    if (!m) continue;
    let val = m[2];
    if (val === undefined) {
      // Поддержка `--key value` (space-separated). Если следующий arg
      // не начинается с --, считаем его значением.
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        val = next;
        i++;
      } else {
        val = "1";
      }
    }
    out[m[1]] = val;
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
// LIMIT=0 (или отсутствует) = unlimited (Infinity). Удобно для overnight run.
const rawLimit      = args["limit"];
const LIMIT         = rawLimit === undefined || Number(rawLimit) === 0 ? Infinity : Number(rawLimit);
const MIN_TOKENS    = Number(args["min-tokens"]   ?? 8001);
const MAX_TOKENS    = Number(args["max-tokens"]   ?? 15000);
// --parallel и --max-parallel — синонимы.
const MAX_PARALLEL  = Number(args["parallel"]     ?? args["max-parallel"] ?? 1);
const TOKEN_BUDGET  = Number(args["budget"]       ?? 30000);
const STOP_ON_ERROR = String(args["stop-on-error"] ?? "1") !== "0";

// Per-range hard cap parallel'а — даже если budget позволяет, тяжёлые акты
// не параллелим больше, чем безопасно для VRAM. Числа подобраны под V100 32GB.
function perRangeParallelCap(tokens) {
  if (tokens <= 9500)  return 3;
  if (tokens <= 15000) return 2;
  if (tokens <= 22000) return 1;
  return 1;
}

function log(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function waitForSearchPriority() {
  let pausedAt = null;
  while (true) {
    await cleanupExpiredRuntimeFlags().catch(() => 0);
    const active = await isRuntimeFlagActive(SEARCH_FLAG).catch(() => false);
    if (!active) {
      if (pausedAt) log(`[resume] search_active cleared, waited ${((Date.now()-pausedAt)/1000).toFixed(1)}s`);
      return;
    }
    if (!pausedAt) { pausedAt = Date.now(); log(`[pause] ${SEARCH_FLAG} active, sleeping ${SEARCH_PAUSE_MS}ms`); }
    await sleep(SEARCH_PAUSE_MS);
  }
}

// Собрать жадный batch: max MAX_PARALLEL, sum_tokens <= TOKEN_BUDGET,
// также не превышать per-range cap, который берётся от первого (самого
// лёгкого) акта в batch'е.
function buildBudgetedBatch(pool) {
  if (pool.length === 0) return [];
  const sorted = [...pool].sort((a, b) => (a.tokens_jina_v4 ?? 0) - (b.tokens_jina_v4 ?? 0));
  const head = sorted.shift();
  const headTokens = Number(head.tokens_jina_v4) || 0;
  const rangeCap = Math.min(MAX_PARALLEL, perRangeParallelCap(headTokens));

  const batch = [head];
  let sum = headTokens;
  while (batch.length < rangeCap && sorted.length > 0) {
    const cand = sorted[0];
    const candTokens = Number(cand.tokens_jina_v4) || 0;
    // Перебираем кандидата только если он не нарушает ни budget, ни per-range cap
    // (cap пересчитывается по максимальному в batch'е, чтобы тяжёлые не
    // подтягивали лишних коллег).
    const effectiveCap = Math.min(rangeCap, perRangeParallelCap(Math.max(headTokens, candTokens)));
    if (batch.length >= effectiveCap) break;
    if (sum + candTokens > TOKEN_BUDGET) break;
    batch.push(cand);
    sum += candTokens;
    sorted.shift();
  }
  // Вернуть оставшихся обратно в pool, чтобы следующий buildBudgetedBatch
  // их подобрал.
  pool.length = 0;
  pool.push(...sorted);
  return batch;
}

// Прочитать хвост inference.log и достать max peak_gb из строк,
// modtime которых после `sinceMs`. Best-effort — если файл не открылся,
// возвращаем null.
async function maxPeakGbSince(sinceMs) {
  try {
    const stat = await fs.stat(INFERENCE_LOG_PATH);
    // Считаем небольшой хвост — 32k bytes хватит на десятки записей.
    const fh = await fs.open(INFERENCE_LOG_PATH, "r");
    try {
      const tailSize = Math.min(stat.size, 32 * 1024);
      const buf = Buffer.alloc(tailSize);
      await fh.read(buf, 0, tailSize, stat.size - tailSize);
      const lines = buf.toString("utf8").split("\n");
      let mx = null;
      for (const line of lines) {
        if (!line.includes("late_chunks_timing")) continue;
        const m = line.match(/peak_gb=([0-9.]+)/);
        if (!m) continue;
        const v = parseFloat(m[1]);
        if (mx === null || v > mx) mx = v;
      }
      return mx;
    } finally {
      await fh.close();
    }
  } catch {
    return null;
  }
}

async function countPendingInRange(minTokens, maxTokens) {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT count(*)::int AS c FROM acts
      WHERE vector_status = 'pending'
        AND is_long_act   = TRUE
        AND verdict_keep  IS TRUE
        AND act_text IS NOT NULL
        AND act_text NOT LIKE '__EXTRACT_FAILED__%'
        AND tokens_jina_v4 IS NOT NULL
        AND tokens_jina_v4 BETWEEN $1 AND $2`,
    [minTokens, maxTokens],
  );
  return res.rows[0]?.c ?? 0;
}

function looksLikeFatal(errMsg) {
  const s = String(errMsg).toLowerCase();
  return (
    s.includes("cuda out of memory") ||
    s.includes("outofmemory") ||
    s.includes("timeout") ||
    s.includes("econnrefused") ||
    s.includes("upsert chunk failed") ||
    s.includes("token_alignment_mismatch")
  );
}

async function indexBatch(batch, batchIdx) {
  const metaMap = await fetchActMeta(batch.map((r) => r.id));
  const t0 = Date.now();
  const results = await Promise.allSettled(
    batch.map((act) =>
      indexOneLongAct(act, metaMap.get(act.id) ?? null, log)
    ),
  );
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  let indexed = 0, errored = 0, stale = 0, chunks = 0;
  const errors = [];
  for (let i = 0; i < results.length; i++) {
    const act = batch[i];
    const res = results[i];
    if (res.status === "fulfilled") {
      const r = res.value;
      if (r?.ok) { indexed++; chunks += r.chunks; }
      else if (r?.staleVerdict) stale++;
      else { errored++; errors.push({ id: act.id, msg: "ok=false" }); }
    } else {
      const msg = String(res.reason?.stack ?? res.reason?.message ?? res.reason);
      errored++;
      errors.push({ id: act.id, msg: msg.slice(0, 400) });
      // Помечаем error самостоятельно — indexOne ловит только внутренние
      // ошибки; Promise.allSettled-reject означает что в PG строка
      // осталась 'indexing'. Закрываем её.
      await markEmbedError(act.id, msg).catch(() => {});
    }
  }

  const peakGb = await maxPeakGbSince(t0);
  const sumTokens = batch.reduce((a, b) => a + (Number(b.tokens_jina_v4) || 0), 0);

  log(
    `[batch ${batchIdx}] parallel=${batch.length} ` +
    `acts=[${batch.map((b) => `${b.id.slice(0,8)}:${b.tokens_jina_v4}t`).join(", ")}] ` +
    `total_tokens=${sumTokens} indexed=${indexed} errors=${errored} stale=${stale} ` +
    `chunks=${chunks} peak_gb=${peakGb ?? "?"} elapsed=${elapsed}s`
  );
  for (const e of errors) log(`  err act=${e.id}: ${e.msg.slice(0, 200)}`);

  return { indexed, errored, stale, chunks, errors };
}

async function main() {
  log(
    `[start] limit=${LIMIT} range=[${MIN_TOKENS},${MAX_TOKENS}] ` +
    `max_parallel=${MAX_PARALLEL} budget=${TOKEN_BUDGET} stop_on_error=${STOP_ON_ERROR}`
  );

  let totalProcessed = 0;
  let totalIndexed   = 0;
  let totalErrored   = 0;
  let totalStale     = 0;
  let totalChunks    = 0;
  let batchIdx       = 0;
  const tStart = Date.now();

  // Запасный «пул» актов: подгружаем по chunked fetch'у. Чанк больше batch'а,
  // чтобы buildBudgetedBatch имел из чего выбирать.
  const FETCH_CHUNK = Math.max(MAX_PARALLEL * 4, 8);
  let pool = [];

  while (totalProcessed < LIMIT) {
    // Догружаем pool, если иссяк.
    if (pool.length < MAX_PARALLEL) {
      const remaining = LIMIT - totalProcessed;
      const want = Math.min(FETCH_CHUNK, remaining);
      const fresh = await selectPendingLongInTokenRange(want, MIN_TOKENS, MAX_TOKENS);
      if (fresh.length === 0 && pool.length === 0) {
        log(`[stop] queue drained in range [${MIN_TOKENS},${MAX_TOKENS}] after ${totalProcessed} acts`);
        break;
      }
      pool.push(...fresh);
    }

    await waitForSearchPriority();

    const batch = buildBudgetedBatch(pool);
    if (batch.length === 0) break;
    batchIdx++;

    // Pre-verdict double-check: между select'ом и batch'ем мог пройти
    // sleep по search_active; верификация недорогая.
    const stillKeep = await Promise.all(batch.map((a) => isActVerdictKeep(a.id)));
    const surviving = [];
    for (let i = 0; i < batch.length; i++) {
      if (stillKeep[i] === true) {
        surviving.push(batch[i]);
      } else {
        const reason = `verdict_keep_flipped:${stillKeep[i] === false ? "false" : "null"}`;
        await markEmbedError(batch[i].id, reason).catch(() => {});
        log(`  [skip act=${batch[i].id}] ${reason}`);
        totalStale++; totalProcessed++;
      }
    }
    if (surviving.length === 0) continue;

    const r = await indexBatch(surviving, batchIdx);
    totalIndexed   += r.indexed;
    totalErrored   += r.errored;
    totalStale     += r.stale;
    totalChunks    += r.chunks;
    totalProcessed += surviving.length;

    // Прогресс каждые 10 batch'ей: pending в нашем range + avg_sec/act.
    if (batchIdx % 10 === 0) {
      const elapsedSec = (Date.now() - tStart) / 1000;
      const avgSec = totalProcessed > 0 ? (elapsedSec / totalProcessed).toFixed(1) : "?";
      const stillPending = await countPendingInRange(MIN_TOKENS, MAX_TOKENS).catch(() => null);
      log(
        `[progress batches=${batchIdx}] processed=${totalProcessed} indexed=${totalIndexed} ` +
        `errors=${totalErrored} stale=${totalStale} chunks=${totalChunks} ` +
        `pending_in_range=${stillPending ?? "?"} avg_sec=${avgSec}`
      );
    }

    // Fatal-detect: если в batch'е есть OOM/timeout/upsert-fail, остановка.
    if (STOP_ON_ERROR && r.errors.some((e) => looksLikeFatal(e.msg))) {
      log(`[FATAL] detected OOM/timeout/upsert error in batch ${batchIdx}, stopping`);
      break;
    }
  }

  const elapsedSec = (Date.now() - tStart) / 1000;
  const avgSec = totalProcessed > 0 ? (elapsedSec / totalProcessed).toFixed(1) : "?";
  const stillPending = await countPendingInRange(MIN_TOKENS, MAX_TOKENS).catch(() => null);
  log(
    `[done] processed=${totalProcessed} indexed=${totalIndexed} errored=${totalErrored} ` +
    `stale=${totalStale} chunks=${totalChunks} elapsed=${elapsedSec.toFixed(0)}s ` +
    `batches=${batchIdx} avg_sec=${avgSec} pending_in_range=${stillPending ?? "?"}`
  );
  process.exit(0);
}

main().catch((e) => {
  log(`[FATAL] ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
