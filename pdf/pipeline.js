/**
 * pdf/pipeline.js — координатор download → extract.
 *
 * Архитектура (выбрана осознанно, не по умолчанию):
 *
 *   ┌────────────────────┐    bounded     ┌─────────────────────┐
 *   │ DownloadPool       │──── queue ────▶│ ExtractWorker #1..M │──▶ Postgres (UPDATE acts)
 *   │ N×(Chromium+proxy) │   (in-memory)  │ (M=4 параллельных,  │
 *   │                    │                │  pdftotext spawn)   │
 *   └────────────────────┘                └─────────────────────┘
 *
 *   - DownloadPool — N независимых Chromium'ов, у каждого свой прокси (MP_*).
 *     N = число активных прокси аккаунта (см. network/proxyPool.js), либо
 *     RAS_PDF_PARALLEL_DOWNLOADERS (override / cap).
 *     Параллелим именно download, потому что ddos-guard kad.arbitr.ru
 *     троттлит по IP, а IP у нас теперь несколько. Каждый воркер сам
 *     ротирует свой IP при 429 (rate-limit per-proxy_key).
 *   - SharedActQueue — каждый воркер атомарно берёт следующий акт через
 *     `claimNext()`. PG-upsert идемпотентен, гонок на конкретный id нет.
 *   - ExtractWorkerPool — общий, pdftotext-воркеры (M = RAS_PDF_EXTRACT_WORKERS).
 *     pdftotext CPU-bound, IO мелкое. M=6 default (override через env).
 *
 * Очередь download→extract:
 *   - In-memory `_buffer` ёмкостью PDF_QUEUE_BUFFER (=32). Когда буфер
 *     заполнен, downloader-воркер ждёт. Мягкий backpressure — если
 *     pdftotext тормозит, не нальём 200 PDF на диск.
 *   - На SIGINT/SIGTERM downloader'ы перестают push'ить новые, ExtractPool
 *     допивает буфер, потом закрываем все Chromium + pool.
 *   - Resume: если процесс упал между UPDATE'ами — следующий прогон
 *     `_drainPendingTextFromDb` подберёт `pdf_downloaded=TRUE AND act_text IS NULL`
 *     ДО того как начнём скачивать новые. Это критично для consistency.
 *
 * Лимиты и тюнинг через env:
 *   RAS_PDF_PARALLEL_DOWNLOADERS=auto  ← N (auto = число прокси из getMyProxy)
 *   RAS_PDF_EXTRACT_WORKERS=6
 *   RAS_PDF_QUEUE_BUFFER=32
 *   RAS_PDF_BATCH=320          ← сколько acts брать из БД за раз (общий батч на N воркеров)
 *   RAS_PDF_MAX_RUN=0          ← stop after N PDFs (0 = unlimited)
 */

import fs from "node:fs";

import {
  markExtractFailed,
  markPdfDownloaded,
  markPdfFailed,
  markTextExtracted,
  pipelineStats,
  selectByIds,
  selectPendingPdf,
  selectPendingText,
} from "../db/actsRepo.js";
import {
  releaseAll as leaseReleaseAll,
  startHeartbeat as leaseStartHeartbeat,
} from "../db/proxyLeases.js";
import { createPdfPool, logPdfDownloadAggregateStats } from "./downloader.js";
import { extractPdfText } from "./extractor.js";
import {
  ProxyQuarantineRegistry,
  readQuarantineConfigFromEnv,
} from "./proxyQuarantine.js";

const EXTRACT_WORKERS = Math.max(1, Number(process.env.RAS_PDF_EXTRACT_WORKERS ?? 6));
const QUEUE_BUFFER = Math.max(1, Number(process.env.RAS_PDF_QUEUE_BUFFER ?? 32));
const BATCH_SIZE = Math.max(1, Number(process.env.RAS_PDF_BATCH ?? 320));
const MAX_RUN = Math.max(0, Number(process.env.RAS_PDF_MAX_RUN ?? 0));
const KEEP_PDF_ON_DISK = (process.env.RAS_PDF_KEEP_FILE ?? "1") === "1";
/** См. pdf/downloader.js — разбивка download / PG / очередь / extract. */
const PDF_TIMING = (process.env.RAS_PDF_TIMING ?? "0") === "1";

/**
 * Backoff после одиночной infra-ошибки (warmup/proxy tunnel) на этом воркере.
 * Минимум 10с — иначе один битый прокси прогоняет всю очередь за секунды.
 */
const INFRA_BACKOFF_MIN_MS = Math.max(0, Number(process.env.RAS_PDF_INFRA_BACKOFF_MIN_MS ?? 10_000));
const INFRA_BACKOFF_MAX_MS = Math.max(
  INFRA_BACKOFF_MIN_MS,
  Number(process.env.RAS_PDF_INFRA_BACKOFF_MAX_MS ?? 30_000),
);
/** N подряд infra-ошибок → срабатывает breaker, recovery + при неудаче пауза. */
const INFRA_BREAKER_THRESHOLD = Math.max(
  1,
  Number(process.env.RAS_PDF_INFRA_BREAKER_THRESHOLD ?? 3),
);
/** Если recovery не помог — пауза на воркере (не помечаем акты failed). */
const INFRA_PAUSE_MIN_MS = Math.max(0, Number(process.env.RAS_PDF_INFRA_PAUSE_MIN_MS ?? 60_000));
const INFRA_PAUSE_MAX_MS = Math.max(
  INFRA_PAUSE_MIN_MS,
  Number(process.env.RAS_PDF_INFRA_PAUSE_MAX_MS ?? 120_000),
);

/**
 * RAS_PDF_PARALLEL_DOWNLOADERS:
 *   - "auto" / пусто / 0 → использовать ВСЕ найденные через getMyProxy прокси
 *   - число N → ограничить пул до N воркеров (даже если прокси больше)
 */
const _PARALLEL_RAW = String(process.env.RAS_PDF_PARALLEL_DOWNLOADERS ?? "auto").trim().toLowerCase();
const PARALLEL_MAX =
  _PARALLEL_RAW === "" || _PARALLEL_RAW === "auto" || _PARALLEL_RAW === "0"
    ? null
    : Math.max(1, Number(_PARALLEL_RAW));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _randIntInclusive(lo, hi) {
  const a = Math.max(0, Math.floor(lo));
  const b = Math.max(a, Math.floor(hi));
  return a + Math.floor(Math.random() * (b - a + 1));
}

/**
 * Прерываемый sleep — на SIGINT (shouldStop()=true) выходит, не дожидаясь конца.
 * Чтобы 120-секундная пауза не блокировала graceful shutdown.
 */
async function _interruptibleSleep(totalMs, shouldStop) {
  const step = 500;
  let elapsed = 0;
  while (elapsed < totalMs) {
    if (typeof shouldStop === "function" && shouldStop()) return;
    const chunk = Math.min(step, totalMs - elapsed);
    await sleep(chunk);
    elapsed += chunk;
  }
}

/**
 * Recovery воркера после серии infra-ошибок: rotateIp (если есть proxyClient)
 * + полный рестарт surface (Chromium). Возвращает true ТОЛЬКО если IP реально
 * сменился (ok=true) и surface перезапустился. rotateIp возвращает
 * {ok:false} на TimeoutError/неответ API — surface restart один в этом случае
 * бесполезен (IP остался тот же, проблема инфра-уровня сохранится).
 */
async function _attemptWorkerRecovery({ label, downloader, log }) {
  let ipRotated = false;
  let ipRotateAttempted = false;
  if (downloader.proxyClient && typeof downloader.proxyClient.rotateIp === "function") {
    ipRotateAttempted = true;
    log(`[${label}] breaker recovery: rotateIp`);
    try {
      const r = await downloader.proxyClient.rotateIp("pdf-worker breaker infra fails");
      ipRotated = r?.ok === true;
      if (!ipRotated) {
        log(`[${label}] breaker rotateIp не сменил IP (ok=false reason=${r?.reason ?? "?"})`);
      }
    } catch (e) {
      log(`[${label}] breaker rotateIp threw: ${e && e.message}`);
    }
  }
  try {
    log(`[${label}] breaker recovery: _restartPdfSurface`);
    await downloader._restartPdfSurface("worker breaker after consecutive infra fails");
  } catch (e) {
    log(`[${label}] breaker _restartPdfSurface failed: ${e && e.message}`);
    return false;
  }
  // Без proxyClient (single-proxy без MP API): surface restart — единственное,
  // что мы можем; считаем за успех.
  if (!ipRotateAttempted) return true;
  return ipRotated;
}

/**
 * Bounded async queue с close() — простой и понятный без зависимостей.
 * shift() блокируется, пока не появится элемент ИЛИ очередь не закроется.
 */
class BoundedQueue {
  constructor(capacity) {
    this._cap = capacity;
    /** @type {any[]} */
    this._buf = [];
    /** @type {Array<() => void>} ожидают place в очереди */
    this._waitersPush = [];
    /** @type {Array<(v: any) => void>} ожидают элемент */
    this._waitersShift = [];
    this._closed = false;
  }
  get size() {
    return this._buf.length;
  }
  get closed() {
    return this._closed;
  }
  async push(item) {
    if (this._closed) throw new Error("queue closed");
    while (this._buf.length >= this._cap) {
      await new Promise((res) => this._waitersPush.push(res));
      if (this._closed) throw new Error("queue closed");
    }
    this._buf.push(item);
    const waiter = this._waitersShift.shift();
    if (waiter) waiter(this._buf.shift());
  }
  /**
   * @returns {Promise<{ done: boolean, value?: any }>}
   */
  async shift() {
    if (this._buf.length > 0) {
      const v = this._buf.shift();
      const w = this._waitersPush.shift();
      if (w) w();
      return { done: false, value: v };
    }
    if (this._closed) return { done: true };
    return new Promise((res) => {
      this._waitersShift.push((v) => {
        if (v === undefined) res({ done: true });
        else res({ done: false, value: v });
      });
    });
  }
  close() {
    if (this._closed) return;
    this._closed = true;
    // Разбудить всех ожидающих push (бросят throw — ловится в downloadLoop).
    for (const w of this._waitersPush.splice(0)) w();
    // Разбудить всех ожидающих shift со done.
    for (const w of this._waitersShift.splice(0)) w(undefined);
  }
}

/**
 * Общий источник «следующего акта» для N download-воркеров.
 * JS-event-loop сериализует await'ы, так что claimNext() не имеет гонок:
 * пока один await selectPendingPdf() висит, остальные воркеры ждут на
 * `_loading`-флаге и не дёргают БД повторно.
 */
class SharedActQueue {
  /**
   * @param {{
   *   fetchBatch: () => Promise<any[]>,    // как пополнять буфер (DB или статический список)
   *   refillable: boolean,                  // true = можно пополнять, false = одноразовый source
   *   logger: (m: string) => void,
   * }} opts
   */
  constructor({ fetchBatch, refillable, logger }) {
    this._buf = [];
    /** @type {any[]} отложенные (451 repeat) — в хвост следующего наполнения _buf */
    this._deferred = [];
    this._loading = false;
    this._exhausted = false;
    this._fetchBatch = fetchBatch;
    this._refillable = refillable;
    this._log = logger;
  }

  /** Отложить акт до конца текущего «волны» батча (без permanent fail в БД). */
  deferAct(act) {
    if (act) this._deferred.push(act);
  }

  /** @returns {Promise<any | null>} следующий акт, либо null если все исчерпано */
  async claimNext() {
    while (true) {
      if (this._buf.length > 0) return this._buf.shift();
      if (this._exhausted) return null;
      if (this._loading) {
        // Другой воркер уже тащит батч — подождём чуть-чуть.
        await sleep(20);
        continue;
      }
      this._loading = true;
      try {
        const next = await this._fetchBatch();
        if (!next.length) {
          if (this._deferred.length) {
            this._buf = this._deferred.splice(0);
            this._log(`[pool/claim] отложенные после пустого батча: ${this._buf.length} актов`);
            continue;
          }
          if (this._refillable) {
            this._exhausted = true;
            this._log("[pool/claim] БД пуста — больше актов нет");
          } else {
            this._exhausted = true;
          }
          return null;
        }
        const deferred = this._deferred.splice(0);
        const defIds = new Set(deferred.map((a) => a && a.id).filter(Boolean));
        const filtered = next.filter((a) => a && !defIds.has(a.id));
        this._buf = [...filtered, ...deferred];
        if (deferred.length) {
          this._log(
            `[pool/claim] подтянул ${next.length} актов из БД + хвост отложенных=${deferred.length}`,
          );
        } else {
          this._log(`[pool/claim] подтянул ${next.length} актов из БД`);
        }
      } finally {
        this._loading = false;
      }
    }
  }
}

/**
 * Главная функция: запустить полный пайплайн.
 *
 * @param {{
 *   workDir: string,
 *   logger?: (m: string) => void,
 *   ids?: string[] | null,   // если задан — качаем ровно эти id, минуя фильтр verdict_keep
 * }} opts
 */
export async function runPipeline({ workDir, logger, ids = null }) {
  const log = logger ?? ((m) => process.stdout.write(`${m}\n`));
  fs.mkdirSync(workDir, { recursive: true });

  const stats0 = await pipelineStats();
  log(
    `[pipe] стартую: total_keep=${stats0.total_keep}, pdf_done=${stats0.pdf_done}, ` +
      `text_done=${stats0.text_done}, pending_pdf=${stats0.pending_pdf}, pending_text=${stats0.pending_text}`,
  );
  log(
    `[pipe] config: workDir=${workDir}, extractWorkers=${EXTRACT_WORKERS}, ` +
      `queueBuffer=${QUEUE_BUFFER}, batch=${BATCH_SIZE}, maxRun=${MAX_RUN || "∞"}, ` +
      `keepPdf=${KEEP_PDF_ON_DISK}, parallel=${PARALLEL_MAX ?? "auto"}, timing=${PDF_TIMING ? "on" : "off"}`,
  );

  // Карантин per proxy_key (in-memory). Воркер на сбойном прокси уйдёт в idle,
  // здоровые доедают очередь (deferred-акты вернутся в пул через SharedActQueue).
  const quarantineCfg = readQuarantineConfigFromEnv();
  const quarantine = new ProxyQuarantineRegistry(quarantineCfg);
  log(
    `[pipe] quarantine: infra=${quarantineCfg.infraThreshold} fails/${quarantineCfg.windowMs}ms ` +
      `→ cd=${quarantineCfg.infraCooldownMs}ms; ` +
      `451=${quarantineCfg.fourFiftyOneThreshold} fails/${quarantineCfg.windowMs}ms ` +
      `→ cd=${quarantineCfg.fourFiftyOneCooldownMs}ms`,
  );

  // ── Шаг 0: до начала скачивания добиваем висящие в очереди экстракта. ──
  await _drainPendingTextFromDb(log);

  // ── Шаг 1: поднять пул Chromium'ов под все прокси. ──
  // createPdfPool сам лизит proxy_key через `proxy_leases` и скипает те,
  // что уже заняты parser.js. Возвращает holderId — нам надо его
  // продлевать heartbeat'ом и освободить на shutdown'е.
  const { workers, closeAll, leaseHolderId } = await createPdfPool({
    workDir,
    logger: log,
    maxWorkers: PARALLEL_MAX,
  });
  log(`[pipe] download pool: ${workers.length} воркер(ов)`);

  // Общий стейт для лога «все воркеры в карантине». Один раз шумим, при
  // первом же релизе сбрасываем флаг — следующий all-sleeping тоже залогируется.
  const allWorkerKeys = workers.map((w) => w.proxyKey).filter(Boolean);
  const allSleepingState = { announced: false };
  const announceAllSleepingIfApplicable = () => {
    if (!allWorkerKeys.length) return;
    const sleeping = allWorkerKeys.filter((k) => quarantine.isQuarantined(k));
    if (sleeping.length === allWorkerKeys.length) {
      if (!allSleepingState.announced) {
        log(
          `[pdf/quarantine] all_workers_sleeping active=0 quarantined=${sleeping.length}`,
        );
        allSleepingState.announced = true;
      }
    } else if (allSleepingState.announced) {
      allSleepingState.announced = false;
    }
  };

  const stopHeartbeat = leaseStartHeartbeat({
    holderId: leaseHolderId,
    logger: log,
  });

  // ── Шаг 2: очередь extract + graceful shutdown. ──
  const queue = new BoundedQueue(QUEUE_BUFFER);
  let stopRequested = false;
  const onSignal = (sig) => {
    log(`[pipe] получил ${sig} — останавливаю downloader'ы, дожимаю экстракт`);
    stopRequested = true;
    queue.close();
  };
  process.once("SIGINT", () => onSignal("SIGINT"));
  process.once("SIGTERM", () => onSignal("SIGTERM"));

  // ── Шаг 3: shared-source актов (БД-батчи или явный список). ──
  const explicitIds = Array.isArray(ids) && ids.length ? ids : null;
  let explicitConsumed = false;
  const source = new SharedActQueue({
    fetchBatch: async () => {
      if (explicitIds) {
        if (explicitConsumed) return [];
        explicitConsumed = true;
        const batch = await selectByIds(explicitIds);
        log(`[pipe/claim] explicit ids: запрошено=${explicitIds.length}, найдено=${batch.length}`);
        return batch;
      }
      return selectPendingPdf(BATCH_SIZE);
    },
    refillable: !explicitIds,
    logger: log,
  });

  // ── Шаг 4: счётчики/стопы — общие для пула. ──
  const counters = {
    downloaded: 0,
    dl_failed: 0,
    dl_deferred: 0,
    infra_deferred: 0,
    worker_restarts: 0,
    worker_paused: 0,
    extracted: 0,
    ex_failed: 0,
  };
  const runState = { totalSeen: 0 };
  const shouldStop = () => stopRequested || (MAX_RUN > 0 && runState.totalSeen >= MAX_RUN);

  // ── Шаг 5: extract-pool. ──
  const extractWorkers = Array.from({ length: EXTRACT_WORKERS }, (_, i) =>
    _extractWorker({ id: i + 1, queue, log, counters }),
  );

  // ── Шаг 6: download-pool. ──
  try {
    await Promise.all(
      workers.map((w) =>
        _downloadWorker({
          label: w.label,
          downloader: w.downloader,
          proxyKey: w.proxyKey ?? null,
          quarantine,
          announceAllSleepingIfApplicable,
          source,
          queue,
          log,
          counters,
          runState,
          shouldStop,
        }),
      ),
    );
  } finally {
    queue.close();
    await Promise.all(extractWorkers).catch((e) => log(`[pipe] extract pool error: ${e}`));
    try {
      await closeAll();
    } catch (e) {
      log(`[pipe] closeAll: ${e}`);
    }
    try {
      logPdfDownloadAggregateStats(log);
    } catch (e) {
      log(`[pipe] pdf aggregate stats: ${e && e.message}`);
    }
    try {
      stopHeartbeat();
    } catch {}
    try {
      const n = await leaseReleaseAll(leaseHolderId);
      log(`[pipe] proxy_leases освобождены: ${n}`);
    } catch (e) {
      log(`[pipe] leaseReleaseAll упал: ${e && e.message}`);
    }
  }

  const stats1 = await pipelineStats();
  log(
    `[pipe] финал: PDF за сессию=${counters.downloaded} (ошибок скачивания=${counters.dl_failed}, ` +
      `отложено=${counters.dl_deferred}), ` +
      `извлечено текста=${counters.extracted} (ошибок извлечения=${counters.ex_failed})`,
  );
  log(
    `[pdf/stats] infra_deferred=${counters.infra_deferred} ` +
      `worker_restarts=${counters.worker_restarts} ` +
      `worker_paused=${counters.worker_paused}`,
  );
  log(
    `[pipe] итого в БД: pdf_done=${stats1.pdf_done}, text_done=${stats1.text_done}, ` +
      `pending_pdf=${stats1.pending_pdf}, pending_text=${stats1.pending_text}`,
  );

  return { counters, stats: stats1, workers: workers.length };
}

/**
 * Один download-воркер пула: тянет акты из общей `source`, скачивает через
 * свой Chromium+прокси, пушит в `queue` для extract-pool'а.
 */
async function _downloadWorker({
  label,
  downloader,
  proxyKey,
  quarantine,
  announceAllSleepingIfApplicable,
  source,
  queue,
  log,
  counters,
  runState,
  shouldStop,
}) {
  const notifyQuarantineStateChange = () => {
    if (typeof announceAllSleepingIfApplicable === "function") {
      announceAllSleepingIfApplicable();
    }
  };
  const logWorkerEnd = (tailMsg) => {
    log(
      `${tailMsg} | PDF за сессию этого воркера: ${downloader.getSessionPdfSavedCount()}`,
    );
  };
  const proxyTag = proxyKey ? `${proxyKey.slice(0, 8)}…` : label;
  /**
   * Подряд infra-ошибок на этом воркере. Сбрасывается на любом не-infra исходе
   * (success, recoverable не-infra, fail, defer 451). На пороге INFRA_BREAKER_THRESHOLD
   * запускаем recovery; если не помог — пауза 60-120с (см. _attemptWorkerRecovery).
   */
  let consecutiveInfraFails = 0;
  let wasQuarantined = false;
  while (true) {
    if (shouldStop()) {
      logWorkerEnd(`[${label}] стоп-сигнал — выхожу из download loop`);
      return;
    }
    // Карантин: пока прокси на скамейке — спим прерываемыми чанками, очередь
    // не дёргаем. Здоровые воркеры тем временем разбирают общий буфер
    // (включая deferred-акты этого воркера).
    if (quarantine && proxyKey && quarantine.isQuarantined(proxyKey)) {
      wasQuarantined = true;
      const until = quarantine.getQuarantineUntil(proxyKey) ?? Date.now();
      const remaining = Math.max(0, until - Date.now());
      const chunk = Math.min(remaining, 5000);
      await _interruptibleSleep(chunk, shouldStop);
      continue;
    }
    if (wasQuarantined) {
      log(`[pdf/quarantine] proxy=${proxyTag} released`);
      wasQuarantined = false;
      // Свежий старт: дать breaker'у право снова считать infra-фейлы с нуля.
      consecutiveInfraFails = 0;
      // Снимаем флаг «all sleeping», чтобы следующий all-sleeping тоже залогировался.
      notifyQuarantineStateChange();
    }
    const act = await source.claimNext();
    if (!act) {
      logWorkerEnd(`[${label}] источник пуст — выхожу`);
      return;
    }
    // MAX_RUN — мягкий cap. Сначала инкрементим totalSeen, потом сравниваем
    // с MAX_RUN — это даёт чуть-больше-MAX_RUN за счёт уже-в-полёте воркеров,
    // но без жёстких блокировок (overrun ≤ workers-1, ок).
    runState.totalSeen += 1;
    if (MAX_RUN > 0 && runState.totalSeen > MAX_RUN) {
      logWorkerEnd(`[${label}] достиг RAS_PDF_MAX_RUN=${MAX_RUN}, останавливаюсь`);
      return;
    }

    const tDl0 = PDF_TIMING ? performance.now() : 0;
    const r = await downloader.downloadAndSave(act);
    if (!r.ok) {
      // Инфраструктурная ошибка (proxy tunnel / warmup / kad session) — НЕ markPdfFailed.
      // Возвращаем акт в хвост батча и тормозим этот воркер (backoff + breaker).
      if (r.infra === true) {
        const reason = r.reason ?? "warmup_failed";
        // 1) Вернуть акт в общий пул ПЕРВЫМ — пока считаем счётчики/карантин,
        //    другой здоровый воркер уже может его подобрать.
        try {
          source.deferAct(act);
        } catch (e) {
          log(`[${label}] deferAct: ${e}`);
        }
        counters.infra_deferred += 1;
        counters.dl_deferred += 1;
        consecutiveInfraFails += 1;
        log(
          `[pdf/defer] id=${act.id} reason=infra_${reason} worker=${label} next=batch_later`,
        );
        // 2) Зарегистрировать infra-фейл per proxy_key. Если порог в окне
        //    превышен — уводим прокси в карантин и СРАЗУ continue
        //    (следующая итерация уснёт в quarantine-loop'е выше).
        if (quarantine && proxyKey) {
          const q = quarantine.recordInfra(proxyKey);
          if (q.entered) {
            log(
              `[pdf/quarantine] proxy=${proxyTag} reason=infra fails=${q.fails}/${q.windowMs}ms`,
            );
            log(
              `[pdf/quarantine] proxy=${proxyTag} sleep_until=${new Date(q.until).toISOString()}`,
            );
            counters.worker_paused += 1;
            notifyQuarantineStateChange();
            continue;
          }
        }
        // 3) Не в карантине — старая логика: лёгкий backoff + breaker.
        const backoffMs = _randIntInclusive(INFRA_BACKOFF_MIN_MS, INFRA_BACKOFF_MAX_MS);
        await _interruptibleSleep(backoffMs, shouldStop);
        if (consecutiveInfraFails >= INFRA_BREAKER_THRESHOLD && !shouldStop()) {
          log(
            `[${label}] breaker tripped: ${consecutiveInfraFails} consecutive infra failures ` +
              `(reason=${reason}) — recovery`,
          );
          const recovered = await _attemptWorkerRecovery({ label, downloader, log });
          if (recovered) {
            counters.worker_restarts += 1;
            log(`[${label}] breaker recovered — resuming`);
            consecutiveInfraFails = 0;
          } else {
            const pauseMs = _randIntInclusive(INFRA_PAUSE_MIN_MS, INFRA_PAUSE_MAX_MS);
            log(
              `[pdf/worker] unhealthy worker=${label} reason=${reason} action=pause ` +
                `pause_ms=${pauseMs}`,
            );
            counters.worker_paused += 1;
            await _interruptibleSleep(pauseMs, shouldStop);
            // После паузы даём воркеру шанс попробовать снова — следующий
            // infra-фейл начнёт новый счёт, не залипнем в вечной паузе.
            consecutiveInfraFails = 0;
          }
        }
        continue;
      }
      // 451 (или repeat_451_after_recovery): deferred + recoverable — только deferAct,
      // не markPdfFailed. С новой downloader-логикой первый же 451 возвращает
      // {deferred:true,status:451}, не жжём PDF_MAX_ATTEMPTS.
      const deferBatchLater =
        r.deferred === true ||
        (r.recoverable === true && r.error === "repeat_451_after_recovery");
      if (deferBatchLater) {
        // 1) Defer первым.
        try {
          source.deferAct(act);
        } catch (e) {
          log(`[${label}] deferAct: ${e}`);
        }
        counters.dl_deferred += 1;
        consecutiveInfraFails = 0;
        // 2) Если это 451 — записываем в реестр и при необходимости карантиним.
        if (quarantine && proxyKey && r.status === 451) {
          const q = quarantine.record451(proxyKey);
          if (q.entered) {
            log(
              `[pdf/quarantine] proxy=${proxyTag} reason=451 fails=${q.fails}/${q.windowMs}ms`,
            );
            log(
              `[pdf/quarantine] proxy=${proxyTag} sleep_until=${new Date(q.until).toISOString()}`,
            );
            counters.worker_paused += 1;
            notifyQuarantineStateChange();
            continue;
          }
        }
        await downloader.paceAfterFailure();
        continue;
      }
      if (r.recoverable) {
        log(`[${label}] recoverable skip id=${act.id}: ${r.error} (status=${r.status ?? "?"})`);
        consecutiveInfraFails = 0;
        await downloader.paceAfterFailure();
        continue;
      }
      counters.dl_failed += 1;
      consecutiveInfraFails = 0;
      log(`[${label}] FAIL id=${act.id}: ${r.error} (status=${r.status ?? "?"})`);
      try {
        await markPdfFailed(act.id, r.error);
      } catch (e) {
        log(`[${label}] markPdfFailed: ${e}`);
      }
      await downloader.paceAfterFailure();
      continue;
    }
    consecutiveInfraFails = 0;

    // PDF на диске. Сразу пишем в БД pdf_downloaded=true — на случай краша
    // между write и extract, чтобы при resume извлёкли уже скачанный.
    let dbMs = 0;
    let qMs = 0;
    const tDb0 = PDF_TIMING ? performance.now() : 0;
    try {
      await markPdfDownloaded(act.id, { pdfPath: r.pdfPath, pdfBytes: r.bytes });
    } catch (e) {
      log(`[${label}] markPdfDownloaded: ${e}`);
    }
    if (PDF_TIMING) dbMs = performance.now() - tDb0;

    counters.downloaded += 1;
    if (quarantine && proxyKey) quarantine.recordSuccess(proxyKey);

    // Передаём в extract-pool. queue.push() блокируется, если буфер заполнен —
    // мягкий backpressure.
    const tQ0 = PDF_TIMING ? performance.now() : 0;
    try {
      await queue.push({ id: act.id, pdfPath: r.pdfPath });
    } catch (e) {
      logWorkerEnd(`[${label}] queue closed mid-push: ${e}`);
      return;
    }
    if (PDF_TIMING) qMs = performance.now() - tQ0;

    const paceMs = await downloader.paceAfterSuccess();
    if (PDF_TIMING) {
      const pipeMs = performance.now() - tDl0;
      const t = r.timings;
      log(
        `[pipe/timing] ${label} id=${act.id} ` +
          `download_wall=${t ? `${t.wallMs.toFixed(0)}ms` : "?"} ` +
          `(warmup=${t ? t.warmupMs.toFixed(0) : "?"} eval=${t ? t.evalMs.toFixed(0) : "?"} ` +
          `write=${t ? t.writeMs.toFixed(0) : "?"}) ` +
          `mark_pg=${dbMs.toFixed(0)}ms queue_push=${qMs.toFixed(0)}ms pace=${paceMs}ms ` +
          `pipe_total=${pipeMs.toFixed(0)}ms`,
      );
    }
  }
}

async function _extractWorker({ id, queue, log, counters }) {
  while (true) {
    const { done, value } = await queue.shift();
    if (done) return;
    await _processOne(value, log, counters, `ex#${id}`);
  }
}

async function _processOne({ id, pdfPath }, log, counters, who) {
  const t0 = PDF_TIMING ? performance.now() : 0;
  const r = await extractPdfText(pdfPath);
  if (PDF_TIMING) {
    const exMs = performance.now() - t0;
    log(`[pipe/timing] ${who} id=${id} extract_pdftotext=${exMs.toFixed(0)}ms`);
  }
  if (!r.ok) {
    counters.ex_failed += 1;
    log(`[pipe/${who}] EXTRACT FAIL id=${id} code=${r.code}: ${r.error}`);
    try {
      await markExtractFailed(id, `${r.code}: ${r.error}`);
    } catch (e) {
      log(`[pipe/${who}] markExtractFailed: ${e}`);
    }
    return;
  }
  try {
    await markTextExtracted(id, r.text);
    counters.extracted += 1;
    log(`[pipe/${who}] OK id=${id} bytes=${r.bytes}`);
  } catch (e) {
    log(`[pipe/${who}] markTextExtracted: ${e}`);
  }
  if (!KEEP_PDF_ON_DISK) {
    fs.promises
      .unlink(pdfPath)
      .catch((e) => log(`[pipe/${who}] unlink ${pdfPath}: ${e && e.message}`));
  }
}

/**
 * Resume-шаг перед запуском downloader'а: добиваем экстракт у тех актов,
 * у которых PDF на диске есть, а текста ещё нет (краш между UPDATE'ами
 * или прерванный прогон).
 */
async function _drainPendingTextFromDb(log) {
  let drained = 0;
  while (true) {
    const batch = await selectPendingText(64);
    if (!batch.length) break;
    log(`[pipe/resume] добиваю extract: ${batch.length} актов`);
    // Можно параллелить, но resume-обычно <100 актов — не критично.
    for (const row of batch) {
      if (!row.pdf_path || !fs.existsSync(row.pdf_path)) {
        // PDF удалён вне нашего ведома — отметим как «нечего экстрактить»
        // и снимем pdf_downloaded флаг, чтобы при следующем прогоне
        // download его взял заново. Иначе строка вечно будет в pending_text.
        log(`[pipe/resume] id=${row.id}: PDF файл пропал (${row.pdf_path}) — помечаю extract failed`);
        try {
          await markExtractFailed(row.id, `pdf file missing: ${row.pdf_path}`);
        } catch (e) {
          log(`[pipe/resume] markExtractFailed: ${e}`);
        }
        continue;
      }
      const r = await extractPdfText(row.pdf_path);
      if (r.ok) {
        await markTextExtracted(row.id, r.text);
        log(`[pipe/resume] id=${row.id} OK bytes=${r.bytes}`);
      } else {
        await markExtractFailed(row.id, `${r.code}: ${r.error}`);
        log(`[pipe/resume] id=${row.id} FAIL ${r.code}: ${r.error}`);
      }
      drained += 1;
    }
  }
  if (drained > 0) log(`[pipe/resume] добил ${drained} актов`);
}

export const __test__ = { BoundedQueue, SharedActQueue, _downloadWorker };
