/**
 * embed/worker.js — автономный indexer-worker.
 *
 * Цикл:
 *   on start:
 *     recoverStaleEmbedding()        — сбросить «зависшие» indexing→pending
 *   loop:
 *     embedFullActBatch(batchFull)   — короткие акты (is_long_act=FALSE)
 *     embedChunkActBatch(batchChunk) — длинные акты (is_long_act=TRUE)
 *     если оба батча пустые → idle sleep (intervalMs)
 *     иначе → сразу следующая итерация (не спим, пока есть очередь)
 *
 * Стейт-машина в PG: selectPendingEmbed уже атомарно переводит pending→indexing
 * (FOR UPDATE SKIP LOCKED), embedFullActBatch / embedChunkActBatch завершают
 * переход indexing→indexed/error. Если процесс умер с indexing-строками,
 * следующий старт recoverStaleEmbedding их подберёт.
 *
 * Idempotency:
 *   full_act: point_id = act.id (UUID) — re-upsert overwrites
 *   chunk:    point_id = uuidv5("<act_id>:<chunk_id>") — re-upsert overwrites,
 *             plus scope-delete (filter by act_id) перед партией чанков для
 *             страховки от изменения CHUNK_SIZE.
 *
 * Graceful shutdown: AbortSignal извне (SIGTERM/SIGINT → controller.abort()).
 * Текущая итерация дойдёт до конца — не убиваем в середине embed-вызова, иначе
 * получим зомби-row в indexing и потерянные point'ы Qdrant.
 */

import { recoverStaleEmbedding, pipelineStats } from "../db/actsRepo.js";
import {
  cleanupExpiredRuntimeFlags,
  isRuntimeFlagActive,
} from "../db/runtimeFlags.js";

import { embedFullActBatch } from "./fullAct.js";
import { embedChunkActBatch } from "./chunk.js";

function defaultLog(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

const SEARCH_PRIORITY_FLAG = process.env.RAS_SEARCH_PRIORITY_FLAG ?? "search_active";
const SEARCH_PAUSE_SLEEP_MS = Number(process.env.RAS_SEARCH_PAUSE_SLEEP_MS ?? 1000);

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

async function waitForSearchPriority({ signal, log, phase }) {
  let logged = false;

  while (!(signal?.aborted)) {
    await cleanupExpiredRuntimeFlags().catch(() => 0);

    const active = await isRuntimeFlagActive(SEARCH_PRIORITY_FLAG).catch((e) => {
      log(`[worker/pause] flag check failed, continue embedding: ${e?.message ?? e}`);
      return false;
    });

    if (!active) {
      if (logged) log(`[worker/resume] ${SEARCH_PRIORITY_FLAG} cleared, continue embedding`);
      return;
    }

    if (!logged) {
      log(
        `[worker/pause] ${phase}: ${SEARCH_PRIORITY_FLAG} active, ` +
        `waiting before next embedding batch`,
      );
      logged = true;
    }

    await sleep(SEARCH_PAUSE_SLEEP_MS, signal);
  }
}

/**
 * Запустить worker. Возвращает promise, который резолвится, когда signal
 * abort'ится (либо если loop крашится).
 *
 * @param {object} opts
 * @param {number} [opts.intervalMs=5000]   sleep между итерациями, если очередь пуста
 * @param {number} [opts.batchSizeFull=5]   акты за итерацию в full-act ветке
 * @param {number} [opts.batchSizeChunk=2]  акты за итерацию в chunk-ветке
 *                                          (chunks дороже, держим меньше)
 * @param {AbortSignal} [opts.signal]       SIGTERM/SIGINT
 * @param {(msg:string)=>void} [opts.log]   логгер
 * @param {number} [opts.maxIterations]     null = бесконечно (для smoke полезно ограничить)
 */
export async function runWorker(opts = {}) {
  const {
    intervalMs       = 5000,
    batchSizeFull    = 5,
    batchSizeChunk   = 2,
    signal,
    log              = defaultLog,
    maxIterations    = null,
  } = opts;

  log(`[worker/start] intervalMs=${intervalMs} batchFull=${batchSizeFull} batchChunk=${batchSizeChunk} maxIterations=${maxIterations ?? "∞"}`);

  const recovered = await recoverStaleEmbedding();
  log(`[worker/recovery] reset indexing→pending: ${recovered}`);

  const stats0 = await pipelineStats();
  log(
    `[worker/stats0] pending=${stats0.embed_pending} indexing=${stats0.embed_indexing} indexed=${stats0.embed_indexed} error=${stats0.embed_error}`,
  );

  let iter = 0;
  let totalIndexed = 0;
  let totalErrored = 0;
  let totalChunks  = 0;

  while (!(signal?.aborted)) {
    iter += 1;
    const iterStart = Date.now();
    let didWork = false;

    await waitForSearchPriority({ signal, log, phase: `iter ${iter}/before_full` });
    if (signal?.aborted) break;

    let shortIndexed = 0;
    try {
      const fr = await embedFullActBatch(batchSizeFull, log);
      // rerouted_pre / missing_marked — это repair-проход. Даже если batchSize=0
      // (selectPendingEmbed ничего не вернул), сам repair мог изменить
      // десятки строк — логируем такой шаг, иначе backlog «исчезает» молча.
      const repaired = (fr.rerouted_pre ?? 0) + (fr.missing_marked ?? 0);
      if (fr.batchSize > 0 || repaired > 0) {
        didWork = true;
        totalIndexed += fr.indexed;
        totalErrored += fr.errored;
        log(
          `[iter ${iter}/full] processed=${fr.batchSize} indexed=${fr.indexed} ` +
          `rerouted=${fr.rerouted} error=${fr.errored} ` +
          `rerouted_pre=${fr.rerouted_pre ?? 0} missing_marked=${fr.missing_marked ?? 0}`,
        );
      }
      shortIndexed = fr.batchSize;
    } catch (e) {
      log(`[iter ${iter}/full] FATAL ${e?.stack ?? e?.message ?? e}`);
    }

    if (signal?.aborted) break;

    // Priority: пока в short-очереди есть pending — НЕ трогаем chunk (long).
    // Long-акты дороже (sub-batching, late chunking) и могут блокировать
    // короткие надолго. Сначала разгребаем ≤8k токенов, потом —
    // длинные. Когда обе очереди пусты → idle sleep.
    if (shortIndexed === 0) {
      await waitForSearchPriority({ signal, log, phase: `iter ${iter}/before_chunk` });
      if (signal?.aborted) break;

      try {
        const cr = await embedChunkActBatch(batchSizeChunk, log);
        if (cr.batchSize > 0) {
          didWork = true;
          totalIndexed += cr.indexed;
          totalErrored += cr.errored;
          totalChunks  += cr.totalChunks;
          log(`[iter ${iter}/chunk] processed=${cr.batchSize} indexed=${cr.indexed} chunks=${cr.totalChunks} error=${cr.errored}`);
        }
      } catch (e) {
        log(`[iter ${iter}/chunk] FATAL ${e?.stack ?? e?.message ?? e}`);
      }
    }

    const iterMs = Date.now() - iterStart;
    log(`[iter ${iter}/done] in ${iterMs}ms idle=${!didWork}`);

    if (maxIterations !== null && iter >= maxIterations) {
      log(`[worker/stop] reached maxIterations=${maxIterations}`);
      break;
    }

    if (!didWork) {
      // Очередь пуста — спим intervalMs. Если abort придёт — sleep сам резолвится.
      await sleep(intervalMs, signal);
    }
    // Если работали — сразу следующая итерация, без sleep'а.
  }

  const statsF = await pipelineStats();
  log(
    `[worker/stop] iters=${iter} totalIndexed=${totalIndexed} totalErrored=${totalErrored} totalChunks=${totalChunks} | pending=${statsF.embed_pending} indexed=${statsF.embed_indexed} error=${statsF.embed_error}`,
  );
}
