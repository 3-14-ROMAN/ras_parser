/**
 * embed/worker.js — production indexer worker со smart-queue.
 *
 * Цикл:
 *   on start:
 *     ensureSingleWorker()           — pg_try_advisory_lock; если занят — exit 0
 *     recoverStaleEmbedding()        — сбросить indexing→pending после crash/restart
 *     repair-проход: rerouteShort+missing+oversized (skip >32768 / null v4)
 *   loop:
 *     pick phase = scheduleNextPhase(buckets)
 *     guards (search_active / disk / inference health)
 *     if phase == short:
 *         если pending мало и не прошёл MAX_WAIT_MS — sleep, ждём ещё (waiting_batch)
 *         иначе → pull batch (tokens ASC), embedFullActBatchSmart
 *     if phase == long_*:
 *         выбираем range (8001-15000 → 15001-22000 → 22001-32768) по приоритету,
 *         pull один long-акт (tokens_jina_v4 ASC), embed via chunk-индексер
 *     если очередь пуста полностью → idle sleep
 *
 * State machine в PG:
 *   selectPendingEmbed* — атомарный pending→indexing.
 *   embedFullActBatch / indexOneLongAct — индексируют, ставят indexed/error.
 *   recoverStaleEmbedding — на старте сбрасывает зомби indexing→pending.
 *
 * Single-worker guard: pg_try_advisory_lock на bigint id. На время выполнения
 * lock держится в выделенном PG client'е из пула; при exit'е процесса (включая
 * SIGTERM/crash) connection закрывается, lock освобождается.
 *
 * Search priority: runtime-flag `search_active` (см. db/runtimeFlags.js).
 * Перед каждым batch'ем worker делает busy-wait на флаге; во время паузы
 * выгружается reranker (best-effort).
 *
 * Disk guard: статвфс на CWD; если свободно < MIN_FREE_DISK_GB или usage > 90%,
 * заходим в disk_pause (sleep 300s, повторная проверка). Не убиваем Postgres/Qdrant.
 *
 * OOM handling: распознаём CUDA OOM / timeout по сообщениям; восстановление —
 * sleep(60), continue. На второй OOM по одному и тому же акту помечаем
 * skip:oom_late_chunking:tokens=N.
 *
 * Graceful shutdown: AbortSignal извне (SIGTERM/SIGINT → controller.abort()).
 * Текущая итерация дойдёт до конца — не убиваем в середине embed-вызова,
 * иначе индексирующий акт зависнет в indexing (recoverStaleEmbedding на старте
 * следующего инстанса вернёт его в pending).
 */

import { statfs as statfsAsync, readFile as readFileAsync } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

import {
  recoverStaleEmbedding,
  pipelineStats,
  pendingTokenBuckets,
  selectPendingShortByTokensAsc,
  selectPendingLongInTokenRange,
  peekPendingShortStats,
  countPendingLongInTokenRange,
  reroutePendingShortOverTokenGate,
  markMissingRerankerTokensForEmbedding,
  markOversizedActsAsSkip,
  markMissingTokensV4Long,
  markActSkip,
  markEmbedError,
  isActVerdictKeep,
  tryAcquireEmbedWorkerLock,
  releaseEmbedWorkerLock,
} from "../db/actsRepo.js";
import { getPool } from "../db/pgClient.js";
import {
  cleanupExpiredRuntimeFlags,
  isRuntimeFlagActive,
} from "../db/runtimeFlags.js";

import { embedFullActBatchSmart } from "./fullAct.js";
import { indexOneLongAct } from "./chunk.js";
import {
  unloadReranker,
  getRerankerState,
  fetchActMeta,
  INFERENCE_URL,
} from "./clients.js";

function defaultLog(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

// ── ENV ────────────────────────────────────────────────────────────────────
const SEARCH_PRIORITY_FLAG   = process.env.RAS_SEARCH_PRIORITY_FLAG ?? "search_active";
const SEARCH_PAUSE_SLEEP_MS  = Number(process.env.RAS_SEARCH_PAUSE_SLEEP_MS ?? 1000);

const SHORT_MAX_TOKENS       = Number(process.env.RAS_EMBED_SHORT_MAX_TOKENS ?? 8000);
const FULL_BATCH_TOKEN_BUDGET = Number(process.env.RAS_FULL_BATCH_TOKEN_BUDGET ?? 30000);
const FULL_BATCH_MAX_ACTS     = Number(process.env.RAS_FULL_BATCH_MAX_ACTS     ?? 8);
const FULL_BATCH_MIN_ACTS     = Number(process.env.RAS_FULL_BATCH_MIN_ACTS     ?? 2);
const FULL_BATCH_MAX_WAIT_MS  = Number(process.env.RAS_FULL_BATCH_MAX_WAIT_MS  ?? 30000);

const MIN_FREE_DISK_GB       = Number(process.env.RAS_MIN_FREE_DISK_GB ?? 20);
const DISK_USAGE_MAX_PCT     = Number(process.env.RAS_DISK_USAGE_MAX_PCT ?? 90);
const DISK_PAUSE_SLEEP_MS    = Number(process.env.RAS_DISK_PAUSE_SLEEP_MS ?? 300_000);

const INFERENCE_HEALTH_TIMEOUT_MS = Number(process.env.RAS_INFERENCE_HEALTH_TIMEOUT_MS ?? 5000);
const INFERENCE_RETRY_SLEEP_MS    = Number(process.env.RAS_INFERENCE_RETRY_SLEEP_MS    ?? 10_000);

const OOM_COOLDOWN_MS        = Number(process.env.RAS_OOM_COOLDOWN_MS ?? 60_000);

// RAM guard — защита от OOM-kill'а при росте Qdrant'а / памяти inference'а.
// `docker stats ras_qdrant` форкается раз в QDRANT_RSS_REFRESH_MS (5с по
// умолчанию), результат кешируется — иначе fork docker CLI на каждом batch'е
// дороже самого guard'а. Если docker exec'нуть нельзя (например, не в группе) —
// qdrant_rss остаётся null, проверяем только host-level (MemAvailable, swap).
// Двухпороговая логика: real memory pressure ≠ stale swap.
//  - MIN_AVAILABLE_RAM_GB: hard floor. Если меньше — pause без оглядки на swap.
//  - LOW_AVAILABLE_RAM_GB + MAX_SWAP_USED_GB: высокий swap опасен ТОЛЬКО когда
//    MemAvailable уже плывёт. Иначе swap = просто стейл-страницы старых idle
//    процессов (Linux любит свопать давно-неактивные пейджи), без active
//    thrashing'а.
//  - swap_used > MAX_SWAP_USED_GB и MemAvailable нормальный → WARN only,
//    embedding продолжается.
const MIN_AVAILABLE_RAM_GB    = Number(process.env.RAS_MIN_AVAILABLE_RAM_GB ?? 4);
const LOW_AVAILABLE_RAM_GB    = Number(process.env.RAS_LOW_AVAILABLE_RAM_GB ?? 8);
const MAX_SWAP_USED_GB        = Number(process.env.RAS_MAX_SWAP_USED_GB ?? 6);
// 0 = disabled. Если выставлен — pause когда qdrant_rss > порог.
const MAX_QDRANT_RSS_GB       = Number(process.env.RAS_MAX_QDRANT_RSS_GB ?? 0);
const RAM_PAUSE_SLEEP_MS      = Number(process.env.RAS_RAM_PAUSE_SLEEP_MS ?? 300_000);
// Throttle для WARN-логов (чтобы не спамить каждый iter, если swap высокий).
const RAM_WARN_INTERVAL_MS    = Number(process.env.RAS_RAM_WARN_INTERVAL_MS ?? 300_000);
let lastRamWarnAt = 0;

// Cache «дорогих» guard-проверок. search_active — НЕ кешируем, проверяем на
// каждый акт (user spec). Disk/RAM/inference — кешируем GUARD_CACHE_MS (30с),
// потому что они почти не меняются между актами (8с между батчами).
// Cache hit пропускает guard без проверки; cache miss переходит в обычный
// pause-loop. Pause-loop сам сбрасывает соответствующий timestamp.
const GUARD_CACHE_MS = Number(process.env.RAS_GUARD_CACHE_MS ?? 30_000);
const lastGuardOkAt  = { disk: 0, ram: 0, inference: 0 };

// pendingTokenBuckets — full scan на ~280k rows, 5с. Кешируем на 60с (по
// умолчанию). Stale-cache опасен только при transition между phase'ами:
// если processPhase вернул batch=0, инвалидируем cache и берём fresh
// snapshot — тогда переключение на следующий phase не задерживается дольше
// одной итерации.
const BUCKETS_CACHE_MS = Number(process.env.RAS_BUCKETS_CACHE_MS ?? 60_000);
let bucketsCache = { data: null, ts: 0 };
async function getBuckets(force = false) {
  if (!force && bucketsCache.data && Date.now() - bucketsCache.ts < BUCKETS_CACHE_MS) {
    return bucketsCache.data;
  }
  const data = await pendingTokenBuckets();
  bucketsCache = { data, ts: Date.now() };
  return data;
}
function invalidateBuckets() { bucketsCache.ts = 0; }
const QDRANT_RSS_REFRESH_MS   = Number(process.env.RAS_QDRANT_RSS_REFRESH_MS ?? 30_000);
const QDRANT_CONTAINER_NAME   = process.env.RAS_QDRANT_CONTAINER_NAME ?? "ras_qdrant";

let qdrantRssCache = { gb: null, ts: 0, supported: true };
// 2-strike skip: per-act OOM-счётчик в памяти worker'а. Restart процесса =
// счётчик обнуляется — это OK, акт переживёт ещё одну попытку.
const oomStrikeByActId = new Map();

const LONG_RANGES = [
  { name: "long_small",  min:  8001, max: 15000 },
  { name: "long_medium", min: 15001, max: 22000 },
  { name: "long_large",  min: 22001, max: 32768 },
];

const LONG_TIER_BATCH_SIZE = 1; // sequential, MODEL_LOCK serializes anyway

// ── utils ──────────────────────────────────────────────────────────────────
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    let done = false;
    let t = null;
    const finish = () => {
      if (done) return;
      done = true;
      if (t) clearTimeout(t);
      signal?.removeEventListener?.("abort", onAbort);
      resolve();
    };
    const onAbort = () => finish();
    t = setTimeout(finish, ms);
    signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}

function looksLikeOOM(errMsg) {
  const s = String(errMsg).toLowerCase();
  return (
    s.includes("cuda out of memory") ||
    s.includes("outofmemoryerror")   ||
    s.includes("out of memory")
  );
}

function looksLikeTimeout(errMsg) {
  const s = String(errMsg).toLowerCase();
  return (
    s.includes("aborterror") ||
    s.includes("the operation was aborted") ||
    s.includes("timeout") ||
    s.includes("etimedout") ||
    s.includes("econnrefused")
  );
}

// ── guards ─────────────────────────────────────────────────────────────────
async function ensureRerankerUnloaded(log, reason) {
  const state = await getRerankerState();
  if (state === "loaded" || state === "ready") {
    log(`[worker/reranker] state=${state} reason=${reason} → POST /reranker/unload`);
    const res = await unloadReranker();
    if (res?.state === "unloaded") {
      log(`[worker/reranker] unloaded freed_gb=${res.freed_gb ?? "?"}`);
    } else {
      log(`[worker/reranker] unload returned: ${JSON.stringify(res)}`);
    }
  }
}

async function waitForSearchPriority({ signal, log, state }) {
  let logged = false;
  while (!(signal?.aborted)) {
    await cleanupExpiredRuntimeFlags().catch(() => 0);
    const active = await isRuntimeFlagActive(SEARCH_PRIORITY_FLAG).catch((e) => {
      log(`[guard/search] flag check failed, continue: ${e?.message ?? e}`);
      return false;
    });
    if (!active) {
      if (logged) {
        log(`[guard/search/resume] ${SEARCH_PRIORITY_FLAG} cleared, continue embedding`);
        await ensureRerankerUnloaded(log, "search_resumed").catch((e) => {
          log(`[guard/search/reranker] unload failed: ${e?.message ?? e}`);
        });
      }
      return;
    }
    if (!logged) {
      state.current = "search_pause";
      log(`[state=search_pause] ${SEARCH_PRIORITY_FLAG} active, waiting`);
      logged = true;
    }
    await sleep(SEARCH_PAUSE_SLEEP_MS, signal);
  }
}

/**
 * Disk guard: проверка свободного места на CWD. Использует statfs (доступен
 * в Node 19+). Не убивает worker, только sleep'ит до восстановления.
 *
 * Throttle: после успешной проверки кешируем GUARD_CACHE_MS — диск не
 * наполняется за 30с между актами, нет смысла statfs'ить каждые 8с.
 */
async function waitForDisk({ signal, log, state }) {
  if (Date.now() - lastGuardOkAt.disk < GUARD_CACHE_MS) return;
  let logged = false;
  while (!(signal?.aborted)) {
    let stat;
    try {
      stat = await statfsAsync(process.cwd());
    } catch (e) {
      log(`[guard/disk] statfs failed: ${e?.message ?? e} (continue)`);
      return;
    }
    const blockSize = Number(stat.bsize ?? 0);
    const total     = Number(stat.blocks ?? 0) * blockSize;
    const free      = Number(stat.bavail ?? stat.bfree ?? 0) * blockSize;
    const used      = total - free;
    const usedPct   = total > 0 ? (used / total) * 100 : 0;
    const freeGb    = free / (1024 ** 3);

    const tooFull = freeGb < MIN_FREE_DISK_GB || usedPct > DISK_USAGE_MAX_PCT;
    if (!tooFull) {
      if (logged) {
        log(`[guard/disk/resume] free=${freeGb.toFixed(1)}GB used=${usedPct.toFixed(1)}%`);
      }
      lastGuardOkAt.disk = Date.now();
      return;
    }
    if (!logged) {
      state.current = "disk_pause";
      log(
        `[state=disk_pause] free=${freeGb.toFixed(1)}GB used=${usedPct.toFixed(1)}% ` +
        `(min=${MIN_FREE_DISK_GB}GB max_used=${DISK_USAGE_MAX_PCT}%) sleeping ${(DISK_PAUSE_SLEEP_MS/1000).toFixed(0)}s`,
      );
      logged = true;
    }
    await sleep(DISK_PAUSE_SLEEP_MS, signal);
  }
}

/**
 * Прочитать host-level memory из /proc/meminfo. Дёшево (один файл read).
 */
async function readHostMemInfo() {
  try {
    const raw = await readFileAsync("/proc/meminfo", "utf8");
    const get = (key) => {
      const m = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, "m"));
      return m ? Number(m[1]) * 1024 : null;
    };
    const memAvail   = get("MemAvailable");
    const memFree    = get("MemFree");
    const memTotal   = get("MemTotal");
    const swapTotal  = get("SwapTotal");
    const swapFree   = get("SwapFree");
    const swapUsed   = (swapTotal != null && swapFree != null) ? swapTotal - swapFree : null;
    return {
      availableGb: memAvail   != null ? memAvail   / (1024 ** 3) : null,
      freeGb:      memFree    != null ? memFree    / (1024 ** 3) : null,
      totalGb:     memTotal   != null ? memTotal   / (1024 ** 3) : null,
      swapUsedGb:  swapUsed   != null ? swapUsed   / (1024 ** 3) : null,
    };
  } catch {
    return { availableGb: null, freeGb: null, totalGb: null, swapUsedGb: null };
  }
}

/**
 * Best-effort qdrant container RSS через `docker stats --no-stream`.
 * Кешируется QDRANT_RSS_REFRESH_MS, форк CLI не на каждый guard tick.
 *
 * Если docker CLI недоступен или таймаутит — отключаем эту проверку до
 * следующего рестарта (cache.supported=false).
 */
async function tryGetQdrantRssGb() {
  if (!qdrantRssCache.supported) return null;
  if (Date.now() - qdrantRssCache.ts < QDRANT_RSS_REFRESH_MS) {
    return qdrantRssCache.gb;
  }
  try {
    const { stdout } = await execFileP(
      "docker",
      ["stats", "--no-stream", "--format", "{{.MemUsage}}", QDRANT_CONTAINER_NAME],
      { timeout: 5000 },
    );
    // "13.31GiB / 31.27GiB" → 13.31
    const m = stdout.match(/^([\d.]+)\s*GiB/);
    const gb = m ? Number(m[1]) : null;
    qdrantRssCache = { gb, ts: Date.now(), supported: true };
    return gb;
  } catch (e) {
    // Один раз помечаем, что docker CLI недоступен — больше не дёргаем.
    // (Это не должно случаться: worker запускается под user'ом, который
    // обычно в docker group; но на CI/test/headless системе docker может
    // отсутствовать.)
    qdrantRssCache = { gb: null, ts: Date.now(), supported: false };
    return null;
  }
}

/**
 * Главный RAM guard. Двухпороговая логика — отделяет реальное memory pressure
 * от стейл-swap'а.
 *
 *   if MemAvailable < MIN_AVAILABLE_RAM_GB                                  → PAUSE
 *   elif MemAvailable < LOW_AVAILABLE_RAM_GB and swap_used > MAX_SWAP_USED_GB → PAUSE
 *   elif qdrant_rss limit включён and qdrant_rss > MAX_QDRANT_RSS_GB        → PAUSE
 *   elif swap_used > MAX_SWAP_USED_GB                                       → WARN (continue)
 *   else                                                                     → OK
 *
 * Не убивает inference / Qdrant / PG — только sleep'ит наш embedding loop.
 *
 * Почему такая логика, а не голый OR:
 *   Linux при долгом простое инференса свопает 1-3 GB стейл-страниц моделей,
 *   а MemAvailable остаётся 20+ GB. Это не повод тормозить embedding — реальной
 *   нехватки нет, swap разгребётся сам при первом /embed, либо останется как
 *   безопасная стейл-резервная копия. Pause тут означал бы permanent stall
 *   (см. incident 2026-05-24: swap 4.7 GB / MemAvailable 25 GB / Qdrant 13 GB).
 *
 *   Реальный thrashing идёт, когда MemAvailable плывёт ВНИЗ И swap растёт
 *   одновременно. Их связка под порог LOW_AVAILABLE_RAM_GB + MAX_SWAP_USED_GB
 *   и есть сигнал на pause.
 */
async function waitForRam({ signal, log, state }) {
  if (Date.now() - lastGuardOkAt.ram < GUARD_CACHE_MS) return;
  let pauseLogged = false;
  while (!(signal?.aborted)) {
    const mem = await readHostMemInfo();
    const qdrantRss = await tryGetQdrantRssGb();

    const avail = mem.availableGb;
    const swap  = mem.swapUsedGb;

    const reasons = [];
    // 1. Hard floor: реально мало памяти, неважно что со swap'ом.
    if (avail != null && avail < MIN_AVAILABLE_RAM_GB) {
      reasons.push(`available_gb=${avail.toFixed(1)}<${MIN_AVAILABLE_RAM_GB}`);
    }
    // 2. Combined: давление по avail + большой swap = близкое thrashing.
    else if (
      avail != null && avail < LOW_AVAILABLE_RAM_GB &&
      swap  != null && swap  > MAX_SWAP_USED_GB
    ) {
      reasons.push(
        `available_gb=${avail.toFixed(1)}<${LOW_AVAILABLE_RAM_GB} ` +
        `AND swap_used_gb=${swap.toFixed(1)}>${MAX_SWAP_USED_GB}`,
      );
    }
    // 3. Qdrant RSS лимит (по умолчанию off).
    if (MAX_QDRANT_RSS_GB > 0 && qdrantRss != null && qdrantRss > MAX_QDRANT_RSS_GB) {
      reasons.push(`qdrant_rss_gb=${qdrantRss.toFixed(1)}>${MAX_QDRANT_RSS_GB}`);
    }

    const fmt = `available_gb=${avail?.toFixed(1) ?? "?"} ` +
                `swap_used_gb=${swap?.toFixed(1) ?? "?"} ` +
                `qdrant_rss_gb=${qdrantRss?.toFixed(1) ?? "?"}`;

    if (reasons.length === 0) {
      if (pauseLogged) {
        log(`[guard/ram/resume] [ram_guard] ${fmt}`);
      }
      // Warn-only: swap высокий, но avail в норме. Throttle лог.
      if (
        swap != null && swap > MAX_SWAP_USED_GB &&
        Date.now() - lastRamWarnAt > RAM_WARN_INTERVAL_MS
      ) {
        log(`[guard/ram/warn] [ram_guard] ${fmt} note=stale_swap_avail_ok continue`);
        lastRamWarnAt = Date.now();
      }
      lastGuardOkAt.ram = Date.now();
      return;
    }

    if (!pauseLogged) {
      state.current = "ram_pause";
      log(
        `[state=ram_pause] [ram_guard] ${fmt} ` +
        `triggers=[${reasons.join("; ")}] sleeping ${(RAM_PAUSE_SLEEP_MS/1000).toFixed(0)}s`,
      );
      pauseLogged = true;
    }
    await sleep(RAM_PAUSE_SLEEP_MS, signal);
  }
}

async function waitForInferenceHealth({ signal, log, state }) {
  if (Date.now() - lastGuardOkAt.inference < GUARD_CACHE_MS) return;
  let logged = false;
  while (!(signal?.aborted)) {
    let ok = false;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), INFERENCE_HEALTH_TIMEOUT_MS);
    try {
      const res = await fetch(`${INFERENCE_URL}/health`, { signal: ctrl.signal });
      if (res.ok) {
        const body = await res.json().catch(() => null);
        ok = body?.status === "ok" || body?.cuda_available === true;
      }
    } catch {
      ok = false;
    } finally {
      clearTimeout(t);
    }
    if (ok) {
      if (logged) log(`[guard/inference/resume] /health ok`);
      lastGuardOkAt.inference = Date.now();
      return;
    }
    if (!logged) {
      state.current = "error_recovery";
      log(`[state=error_recovery] inference /health unhealthy, sleeping ${(INFERENCE_RETRY_SLEEP_MS/1000).toFixed(0)}s`);
      logged = true;
    }
    await sleep(INFERENCE_RETRY_SLEEP_MS, signal);
  }
}

async function runAllGuards({ signal, log, state }) {
  await waitForSearchPriority({ signal, log, state });
  if (signal?.aborted) return false;
  await waitForDisk({ signal, log, state });
  if (signal?.aborted) return false;
  await waitForRam({ signal, log, state });
  if (signal?.aborted) return false;
  await waitForInferenceHealth({ signal, log, state });
  if (signal?.aborted) return false;
  return true;
}

// ── phase scheduling ───────────────────────────────────────────────────────
/**
 * @param {object} buckets pendingTokenBuckets()
 * @returns {"short"|"long_small"|"long_medium"|"long_large"|"idle"}
 */
function pickPhase(buckets) {
  if (buckets.short > 0)       return "short";
  if (buckets.long_small > 0)  return "long_small";
  if (buckets.long_medium > 0) return "long_medium";
  if (buckets.long_large > 0)  return "long_large";
  return "idle";
}

function rangeForPhase(phase) {
  return LONG_RANGES.find((r) => r.name === phase) ?? null;
}

// ── batching: short ────────────────────────────────────────────────────────
/**
 * Smart short-batch scheduling:
 *   - peek pending count + min/max tokens
 *   - если count >= FULL_BATCH_MAX_ACTS → pull & embed немедленно
 *   - если count >= FULL_BATCH_MIN_ACTS И прошло >= FULL_BATCH_MAX_WAIT_MS с
 *     первого "waiting" события → pull & embed
 *   - иначе → sleep tick, отметить waiting_batch
 *
 * waitStartedAt — момент, когда мы впервые увидели "недоборный" batch (мало,
 * но >0). Сбрасывается, когда либо ушли в embed, либо очередь стала 0.
 */
async function processShortPhase({ ctx, signal, log, state }) {
  // peek без перевода в indexing — иначе мы заблокируем другие worker'ы на
  // ровном месте.
  const peek = await peekPendingShortStats(SHORT_MAX_TOKENS);
  if (peek.count === 0) {
    ctx.shortWaitStartedAt = null;
    return { didWork: false, phase: "short", processed: 0 };
  }

  // Если уже накопилось много — берём сразу.
  // Если мало — копим до MIN или до timeout'а.
  const haveEnough = peek.count >= FULL_BATCH_MAX_ACTS;
  const haveMin    = peek.count >= FULL_BATCH_MIN_ACTS;
  const now = Date.now();
  if (ctx.shortWaitStartedAt === null) ctx.shortWaitStartedAt = now;
  const waited = now - ctx.shortWaitStartedAt;

  if (!haveEnough && !haveMin && waited < FULL_BATCH_MAX_WAIT_MS) {
    state.current = "waiting_batch";
    log(
      `[state=waiting_batch/short] pending=${peek.count} min=${peek.min_tokens} ` +
      `wait_ms=${waited}/${FULL_BATCH_MAX_WAIT_MS} (need ${FULL_BATCH_MIN_ACTS}+)`,
    );
    await sleep(2000, signal);
    return { didWork: false, phase: "short", processed: 0, waiting: true };
  }
  if (!haveEnough && haveMin && waited < FULL_BATCH_MAX_WAIT_MS) {
    // У нас есть MIN_ACTS, но ещё в пределах max wait — посмотрим, не догонят ли.
    state.current = "waiting_batch";
    log(
      `[state=waiting_batch/short] pending=${peek.count} (≥min=${FULL_BATCH_MIN_ACTS}) ` +
      `wait_ms=${waited}/${FULL_BATCH_MAX_WAIT_MS} — ждём дополнения`,
    );
    await sleep(2000, signal);
    return { didWork: false, phase: "short", processed: 0, waiting: true };
  }

  // Триггерим: либо много, либо ждали достаточно.
  ctx.shortWaitStartedAt = null;
  state.current = "embedding_short";

  // Pull до MAX_ACTS актов (tokens ASC), embed-сабчанком соберём token-budget.
  const limit = Math.max(FULL_BATCH_MIN_ACTS, FULL_BATCH_MAX_ACTS);
  log(`[state=embedding_short] trigger pending=${peek.count} pull_limit=${limit} budget=${FULL_BATCH_TOKEN_BUDGET}`);

  let r;
  try {
    r = await embedFullActBatchSmart({
      pull:        (n) => selectPendingShortByTokensAsc(n, SHORT_MAX_TOKENS),
      maxActs:     limit,
      tokenBudget: FULL_BATCH_TOKEN_BUDGET,
      log,
    });
  } catch (e) {
    const msg = String(e?.stack ?? e?.message ?? e);
    log(`[short/FATAL] ${msg.slice(0, 600)}`);
    return { didWork: true, phase: "short", processed: 0, error: e };
  }
  log(
    `[short/done] processed=${r.batchSize} indexed=${r.indexed} errored=${r.errored} ` +
    `rerouted=${r.rerouted} stale=${r.staleVerdict}`,
  );
  return { didWork: r.batchSize > 0, phase: "short", processed: r.batchSize };
}

// ── batching: long ────────────────────────────────────────────────────────
/**
 * Process one long-act in the given range (tokens_jina_v4 ASC inside range).
 */
async function processLongPhase({ phase, ctx, signal, log, state }) {
  const range = rangeForPhase(phase);
  if (!range) return { didWork: false, phase, processed: 0 };

  state.current = "embedding_long";

  const batch = await selectPendingLongInTokenRange(LONG_TIER_BATCH_SIZE, range.min, range.max);
  if (batch.length === 0) {
    return { didWork: false, phase, processed: 0 };
  }

  if (process.env.RAS_ENABLE_CHUNK_INDEXING !== "1") {
    log(`[long/disabled] RAS_ENABLE_CHUNK_INDEXING≠1 — возвращаем в pending`);
    for (const a of batch) {
      // markEmbedError — пометит error; но мы хотим вернуть в pending. Пишем напрямую.
      const pool = await getPool();
      await pool.query(
        `UPDATE acts SET vector_status='pending' WHERE id=$1::uuid`,
        [a.id],
      );
    }
    return { didWork: false, phase, processed: 0 };
  }

  const act = batch[0];
  const tokens = act.tokens_jina_v4;
  log(`[state=embedding_long/${range.name}] act=${act.id} tokens_jina_v4=${tokens}`);

  // verdict guard перед GPU-времязатратной операцией.
  const stillKeep = await isActVerdictKeep(act.id);
  if (stillKeep !== true) {
    const reason = `verdict_keep_flipped:${stillKeep === false ? "false" : "null"}`;
    await markActSkip(act.id, reason).catch(() => {});
    log(`[long/skip act=${act.id}] ${reason}`);
    return { didWork: true, phase, processed: 1 };
  }

  const meta = await fetchActMeta([act.id]);
  try {
    const r = await indexOneLongAct(act, meta.get(act.id) ?? null, log);
    if (r?.ok) {
      log(`[long/ok act=${act.id}] chunks=${r.chunks} tokens=${r.tokens}`);
      // успех — сбросим OOM-strike если был
      oomStrikeByActId.delete(act.id);
    } else if (r?.staleVerdict) {
      log(`[long/stale act=${act.id}]`);
    }
    return { didWork: true, phase, processed: 1 };
  } catch (e) {
    const msg = String(e?.stack ?? e?.message ?? e);
    const isOOM     = looksLikeOOM(msg);
    const isTimeout = looksLikeTimeout(msg);

    if (isOOM || isTimeout) {
      const strikes = (oomStrikeByActId.get(act.id) ?? 0) + 1;
      oomStrikeByActId.set(act.id, strikes);

      if (strikes >= 2) {
        const skipMark = `skip:oom_late_chunking:tokens=${tokens}`;
        await markActSkip(act.id, skipMark).catch(() => {});
        log(`[long/oom act=${act.id} strike=${strikes}] ${skipMark}`);
        oomStrikeByActId.delete(act.id);
      } else {
        // вернём в pending, дадим ещё одну попытку после cooldown'а
        const pool = await getPool();
        await pool.query(
          `UPDATE acts SET vector_status='pending', vector_error=$2 WHERE id=$1::uuid`,
          [act.id, `oom_retry_pending:strike=${strikes}:${msg.slice(0, 200)}`],
        );
        log(`[long/oom act=${act.id} strike=${strikes}] return to pending, cooldown ${OOM_COOLDOWN_MS}ms`);
        state.current = "error_recovery";
        await sleep(OOM_COOLDOWN_MS, signal);
        // здоровье inference после OOM могло провалиться — следующий guard поймает
      }
    } else {
      // Обычная ошибка (например too_long_for_late_chunking, upsert fail)
      // — переиспользуем парсинг из chunk.js
      let mark = msg;
      const m = msg.match(/too_long_for_late_chunking[\s\S]*?"real_token_count"\s*:\s*(\d+)/);
      if (m) {
        mark = `skip:gt_32k_context_limit:tokens=${m[1]}`;
      } else if (/too_long_for_late_chunking/.test(msg)) {
        mark = `skip:gt_32k_context_limit:tokens=${tokens ?? "unknown"}`;
      }
      await markEmbedError(act.id, mark).catch(() => {});
      log(`[long/err act=${act.id}] ${mark.slice(0, 400)}`);
    }
    return { didWork: true, phase, processed: 1, error: e };
  }
}

// ── repair ──────────────────────────────────────────────────────────────────
async function repairOnce(log) {
  // Short overshoot → long pipeline
  const rs = await reroutePendingShortOverTokenGate(SHORT_MAX_TOKENS, 500).catch(() => ({ count: 0, rows: [] }));
  if (rs.count > 0) log(`[repair/short→long] rerouted=${rs.count}`);

  // Short с NULL tokens_jina_v4 → skip
  const ms = await markMissingRerankerTokensForEmbedding(500).catch(() => ({ count: 0 }));
  if (ms.count > 0) log(`[repair/short_null_v4] marked_skip=${ms.count}`);

  // Long с NULL tokens_jina_v4 → skip
  const ml = await markMissingTokensV4Long(500).catch(() => ({ count: 0 }));
  if (ml.count > 0) log(`[repair/long_null_v4] marked_skip=${ml.count}`);

  // >32768 → skip (любая ветка)
  const mo = await markOversizedActsAsSkip(32768, 500).catch(() => ({ count: 0 }));
  if (mo.count > 0) log(`[repair/oversized] marked_skip=${mo.count}`);
}

// ── single-worker guard ─────────────────────────────────────────────────────
async function acquireSingleWorker(log) {
  const pool = await getPool();
  const client = await pool.connect();
  const ok = await tryAcquireEmbedWorkerLock(client);
  if (!ok) {
    client.release();
    log(`[lock/REFUSED] another embed-worker holds advisory lock — exiting`);
    return null;
  }
  log(`[lock/ACQUIRED] single-worker advisory lock held by pid=${process.pid}`);
  return {
    release: async () => {
      await releaseEmbedWorkerLock(client).catch(() => {});
      try { client.release(); } catch {}
    },
  };
}

// ── main loop ───────────────────────────────────────────────────────────────
/**
 * @param {object} opts
 * @param {number} [opts.intervalMs=5000]   idle sleep когда очередь пуста
 * @param {AbortSignal} [opts.signal]
 * @param {(msg:string)=>void} [opts.log]
 * @param {number} [opts.maxIterations]     null = бесконечно
 */
export async function runWorker(opts = {}) {
  const {
    intervalMs    = 5000,
    signal,
    log           = defaultLog,
    maxIterations = null,
  } = opts;

  log(
    `[worker/start] intervalMs=${intervalMs} short_max=${SHORT_MAX_TOKENS} ` +
    `batch_budget=${FULL_BATCH_TOKEN_BUDGET} batch_acts=[${FULL_BATCH_MIN_ACTS}..${FULL_BATCH_MAX_ACTS}] ` +
    `batch_wait_ms=${FULL_BATCH_MAX_WAIT_MS} min_free_disk_gb=${MIN_FREE_DISK_GB} ` +
    `min_avail_gb=${MIN_AVAILABLE_RAM_GB} low_avail_gb=${LOW_AVAILABLE_RAM_GB} ` +
    `max_swap_gb=${MAX_SWAP_USED_GB} max_qdrant_rss_gb=${MAX_QDRANT_RSS_GB || "off"} ` +
    `oom_cooldown_ms=${OOM_COOLDOWN_MS} chunk_enabled=${process.env.RAS_ENABLE_CHUNK_INDEXING === "1"}`,
  );

  // Single-worker guard — pg_try_advisory_lock. Без этого можно случайно
  // запустить два worker'а (npm run embed:worker + systemd), они будут
  // друг друга гонять через SELECT FOR UPDATE SKIP LOCKED, но дублировать
  // payload и тратить GPU.
  const lock = await acquireSingleWorker(log);
  if (!lock) {
    process.exitCode = 0;
    return;
  }

  try {
    const recovered = await recoverStaleEmbedding();
    log(`[worker/recovery] reset indexing→pending: ${recovered}`);

    await repairOnce(log).catch((e) => log(`[repair/err] ${e?.message ?? e}`));

    const stats0 = await pipelineStats();
    log(
      `[worker/stats0] pending=${stats0.embed_pending} indexing=${stats0.embed_indexing} ` +
      `indexed=${stats0.embed_indexed} error=${stats0.embed_error}`,
    );

    const state = { current: "idle" };
    const ctx = { shortWaitStartedAt: null, idleLogged: false };
    let iter = 0;
    let totalProcessed = 0;
    let lastRepairAt = Date.now();
    const REPAIR_INTERVAL_MS = Number(process.env.RAS_EMBED_REPAIR_INTERVAL_MS ?? 120_000);

    while (!(signal?.aborted)) {
      iter += 1;

      if (Date.now() - lastRepairAt > REPAIR_INTERVAL_MS) {
        await repairOnce(log).catch((e) => log(`[repair/err] ${e?.message ?? e}`));
        lastRepairAt = Date.now();
      }

      const ok = await runAllGuards({ signal, log, state });
      if (!ok || signal?.aborted) break;

      const buckets = await getBuckets().catch((e) => {
        log(`[buckets/err] ${e?.message ?? e}`);
        return { short: 0, long_small: 0, long_medium: 0, long_large: 0, oversized: 0, null_v4: 0 };
      });

      if (buckets.oversized > 0 || buckets.null_v4 > 0) {
        // быстрый repair-pass, иначе фантомные backlog'и. Свежий repair
        // мог изменить bucket'ы — сбросим cache, иначе следующая итерация
        // будет работать со stale-state'ом.
        await repairOnce(log).catch(() => {});
        invalidateBuckets();
      }

      const phase = pickPhase(buckets);

      if (phase === "idle") {
        if (!ctx.idleLogged) {
          state.current = "idle";
          log(
            `[state=idle] queue empty (short=0 long_small=0 long_medium=0 long_large=0); ` +
            `sleep ${intervalMs}ms`,
          );
          ctx.idleLogged = true;
        }
        await sleep(intervalMs, signal);
        continue;
      }
      ctx.idleLogged = false;

      log(
        `[iter ${iter}] phase=${phase} buckets=[short=${buckets.short} ` +
        `8001-15k=${buckets.long_small} 15001-22k=${buckets.long_medium} ` +
        `22001-32k=${buckets.long_large} oversized=${buckets.oversized} null_v4=${buckets.null_v4}]`,
      );

      let r;
      if (phase === "short") {
        r = await processShortPhase({ ctx, signal, log, state });
      } else {
        r = await processLongPhase({ phase, ctx, signal, log, state });
      }

      totalProcessed += r.processed ?? 0;

      // Phase транзишн / drift cache: если selectPendingLongInTokenRange
      // вернул 0 актов (или processShortPhase ничего не нашёл peek'ом), кешированные
      // buckets устарели — сбросим, чтобы следующий iter пересчитал и переключился
      // на следующий phase без задержки до BUCKETS_CACHE_MS.
      if (!r.didWork && !r.waiting) {
        invalidateBuckets();
      }

      if (maxIterations !== null && iter >= maxIterations) {
        log(`[worker/stop] reached maxIterations=${maxIterations}`);
        break;
      }

      // Если не было работы и не ждём batch — мини-sleep, чтобы не крутить tight loop.
      if (!r.didWork && !r.waiting) {
        await sleep(intervalMs, signal);
      }
    }

    const statsF = await pipelineStats();
    log(
      `[worker/stop] iters=${iter} totalProcessed=${totalProcessed} | ` +
      `pending=${statsF.embed_pending} indexed=${statsF.embed_indexed} error=${statsF.embed_error}`,
    );
  } finally {
    await lock.release();
    log(`[lock/RELEASED]`);
  }
}
