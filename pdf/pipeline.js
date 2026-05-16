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

import { PDF_GEO_FILTERS } from "../network/config.js";
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
 * No-progress watchdog. Если ни один PDF не сохранён за STUCK_TIMEOUT_MS —
 * логируем warning. Если за STUCK_FATAL_MS — кидаем ошибку, и supervisor в
 * scripts/download-acts.js перезапустит весь пайплайн (закроет Chromium-ы,
 * пересоздаст пул, освободит lease — чистый рестарт). Это страховка от ситуации,
 * когда все воркеры залипли в карантине / прокси-сервер тихо умер / PG ушла
 * в read-only.
 *
 * 0 в любой переменной = соответствующая ступень отключена.
 */
const STUCK_TIMEOUT_MS = Math.max(0, Number(process.env.RAS_PDF_STUCK_TIMEOUT_MS ?? 1_800_000));
const STUCK_FATAL_MS = Math.max(
  STUCK_TIMEOUT_MS,
  Number(process.env.RAS_PDF_STUCK_FATAL_MS ?? 5_400_000),
);
/** Сколько раз ретраить PG-запрос selectPendingPdf при транзиентных ошибках. */
const FETCH_BATCH_MAX_RETRIES = Math.max(
  1,
  Number(process.env.RAS_PDF_FETCH_BATCH_MAX_RETRIES ?? 6),
);
/** Начальный backoff между ретраями (мс), удваивается до 60с. */
const FETCH_BATCH_BACKOFF_MS = Math.max(
  100,
  Number(process.env.RAS_PDF_FETCH_BATCH_BACKOFF_MS ?? 2_000),
);
/** Пауза воркера после неожиданного исключения внутри основного цикла. */
const WORKER_UNEXPECTED_PAUSE_MS = Math.max(
  1_000,
  Number(process.env.RAS_PDF_WORKER_UNEXPECTED_PAUSE_MS ?? 30_000),
);

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

/** Интервал heartbeat-метрик пайплайна (мс). 0 = выключить лог. */
const HEARTBEAT_MS = Math.max(0, Number(process.env.RAS_PDF_HEARTBEAT_MS ?? 60_000));

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

/**
 * Ответ changeEquipment/changeGeo: `checked[proxy_id] === false` — смена не подтверждена провайдером.
 * @param {{ raw?: any, task?: any }} r
 * @param {number} proxyId
 */
function _equipmentCheckedFalseForProxy(r, proxyId) {
  const idNum = Number(proxyId);
  if (!Number.isFinite(idNum)) return false;
  const keys = [String(idNum), idNum];
  for (const src of [r?.raw, r?.task]) {
    if (!src || typeof src !== "object") continue;
    const c = src.checked;
    if (!c || typeof c !== "object" || Array.isArray(c)) continue;
    for (const k of keys) {
      if (Object.prototype.hasOwnProperty.call(c, k) && c[k] === false) return true;
    }
  }
  return false;
}

/**
 * Извлекает из ответа changeIp/changeEquipment поле `ipguardian.net.<proxy_id>`
 * и возвращает короткое описание, если IP найден в abuse-списках. Pravocaptcha
 * на kad.arbitr.ru почти наверняка 451'нит такие IP — пользователю важно это
 * видеть в логе, чтобы понимать: проблема не в коде, а в качестве прокси.
 *
 * @param {{ raw?: any, task?: any }} r
 * @param {number|string|null} proxyId
 * @returns {{ ip: string, found: boolean, sources: string[] } | null}
 */
function _extractIpGuardianAbuse(r, proxyId) {
  if (proxyId == null) return null;
  const keys = [String(proxyId), Number(proxyId)];
  for (const src of [r?.raw, r?.task]) {
    if (!src || typeof src !== "object") continue;
    const ipg = src["ipguardian.net"];
    if (!ipg || typeof ipg !== "object") continue;
    for (const k of keys) {
      const entry = ipg[k];
      if (!entry || typeof entry !== "object") continue;
      const found = entry.found === true;
      const ip = String(entry.ip ?? "").trim();
      const sources = Array.isArray(entry.sources)
        ? entry.sources
            .map((s) => s?.maintainer ?? s?.filename ?? s?.category ?? null)
            .filter(Boolean)
            .map(String)
        : [];
      if (!ip && !found && !sources.length) continue;
      return { ip, found, sources };
    }
  }
  return null;
}

function _randIntInclusive(lo, hi) {
  const a = Math.max(0, Math.floor(lo));
  const b = Math.max(a, Math.floor(hi));
  return a + Math.floor(Math.random() * (b - a + 1));
}

/**
 * Ретрай PG-запроса при транзиентных ошибках (потеря соединения, рестарт сервера,
 * read-only, рестарт docker-compose и т.п.). Экспоненциальный backoff,
 * максимум FETCH_BATCH_MAX_RETRIES попыток, прерывается shouldStop().
 *
 * Используется для `selectPendingPdf` / `selectByIds` — это бьющие в БД запросы,
 * без них пайплайн не может ехать. UPDATE'ы внутри worker'а (markPdf*) уже
 * обёрнуты try/catch на месте — там фейл одного UPDATE не блокирует пайплайн.
 *
 * @template T
 * @param {() => Promise<T>} fn
 * @param {string} label
 * @param {(m: string) => void} log
 * @param {(() => boolean) | undefined} shouldStop
 * @returns {Promise<T>}
 */
async function _retryPgCall(fn, label, log, shouldStop) {
  let lastErr;
  let backoffMs = FETCH_BATCH_BACKOFF_MS;
  for (let i = 1; i <= FETCH_BATCH_MAX_RETRIES; i += 1) {
    if (typeof shouldStop === "function" && shouldStop()) {
      throw lastErr ?? new Error(`${label}: stopped before retry`);
    }
    try {
      return await fn();
    } catch (e) {
      lastErr = e;
      log(
        `[pipe/pg-retry] ${label} attempt ${i}/${FETCH_BATCH_MAX_RETRIES} упал: ` +
          `${e && (e.message ?? e)} — backoff ${backoffMs}ms`,
      );
      if (i >= FETCH_BATCH_MAX_RETRIES) break;
      await _interruptibleSleep(backoffMs, shouldStop);
      backoffMs = Math.min(60_000, backoffMs * 2);
    }
  }
  throw lastErr ?? new Error(`${label}: max retries reached`);
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
 * Last-ditch попытка вернуть прокси к жизни ПЕРЕД уходом в quarantine-sleep.
 * Вызывается ровно в момент превышения порога карантина — даём один шанс
 * сменой IP/гео без жжения PDF_MAX_ATTEMPTS на уровне акта.
 *
 *   reason="infra" → changeGeo (туннель/warmup гнилые — меняем gateway/регион).
 *   451 → см. `_attempt451ProxyRecoverBeforeQuarantine` (чередование IP/гео на воркере).
 *
 * Возвращает true, если recover успел сменить IP/гео И surface перезапустился.
 * `ok=false` от прокси-API чаще всего значит hard-cooldown (например, 24ч
 * между changeGeo) — тогда падаем в обычный quarantine sleep.
 *
 * @param {{ label: string, downloader: any, log: (m: string) => void, reason: "infra" }} opts
 * @returns {Promise<boolean>}
 */
async function _attemptProxyRecoverBeforeQuarantine({ label, downloader, log, reason }) {
  const client = downloader.proxyClient;
  if (!client) return false;
  const action = "changeGeo";
  const apiName = "changeGeo";
  if (typeof client[apiName] !== "function") return false;
  let ok = false;
  let detail = "";
  let r = null;
  try {
    const recoverReason = `pdf-quarantine recover ${reason}`;
    const geoFilters = downloader.geoFilters ?? PDF_GEO_FILTERS;
    r = await client.changeGeo(recoverReason, { filters: geoFilters });
    ok = r?.ok === true;
    if (!ok && r?.reason) detail = ` reason=${String(r.reason).slice(0, 80)}`;
  } catch (e) {
    detail = ` threw=${e && e.message}`;
  }
  if (ok && r) {
    try {
      const pid = await client.getResolvedProxyId();
      if (_equipmentCheckedFalseForProxy(r, pid)) {
        ok = false;
        detail = " checked=false";
      }
    } catch {
      // без proxy_id не сопоставляем checked — оставляем ok как вернул клиент
    }
  }
  log(`[pdf/proxy-recover] action=${action} reason=${reason} ok=${ok}${detail}`);
  if (!ok) return false;
  try {
    await downloader._restartPdfSurface(`proxy-recover ${reason} before quarantine`);
  } catch (e) {
    log(`[${label}] proxy-recover _restartPdfSurface failed: ${e && e.message}`);
    return false;
  }
  return true;
}

/**
 * Last-ditch 451 recover: чередование rotateIp / changeGeo на этом воркере
 * (next451RecoverAction снаружи). Тот же recoverReason, что и раньше для 451.
 *
 * @param {{ label: string, downloader: any, log: (m: string) => void, action: "ip"|"geo" }} opts
 * @returns {Promise<boolean>}
 */
async function _attempt451ProxyRecoverBeforeQuarantine({ label, downloader, log, action }) {
  const client = downloader.proxyClient;
  if (!client) return false;
  const recoverReason = "pdf-quarantine recover 451";
  let ok = false;
  let detail = "";
  let r = null;
  const apiLabel = action === "ip" ? "rotateIp" : "changeGeo";
  try {
    if (action === "ip") {
      if (typeof client.rotateIp !== "function") return false;
      r = await client.rotateIp(recoverReason);
    } else {
      if (typeof client.changeGeo !== "function") return false;
      const geoFilters = downloader.geoFilters ?? PDF_GEO_FILTERS;
      r = await client.changeGeo(recoverReason, { filters: geoFilters });
    }
    ok = r?.ok === true;
    if (!ok && r?.reason) detail = ` reason=${String(r.reason).slice(0, 80)}`;
  } catch (e) {
    detail = ` threw=${e && e.message}`;
  }
  if (action === "geo" && ok && r) {
    try {
      const pid = await client.getResolvedProxyId();
      if (_equipmentCheckedFalseForProxy(r, pid)) {
        ok = false;
        detail = " checked=false";
      }
    } catch {
      // без proxy_id не сопоставляем checked — оставляем ok как вернул клиент
    }
  }
  log(`[pdf/proxy-recover] action=${apiLabel} reason=451 ok=${ok}${detail}`);
  if (!ok) return false;
  try {
    await downloader._restartPdfSurface("proxy-recover 451 before quarantine");
  } catch (e) {
    log(`[${label}] proxy-recover _restartPdfSurface failed: ${e && e.message}`);
    return false;
  }
  return true;
}

/**
 * Достать текущий id_country у воркера. Первый источник — поле `countryId`
 * на самом worker'е (createPdfPool пробрасывает его из getMyProxy). Фоллбек
 * через `proxyClient._getMyInfo()` — на случай, если discoverProxies не
 * заполнил countryId (single-proxy fallback из MP_PROXY_* env).
 *
 * @param {{ proxyClient?: any, countryId?: number | null }} worker
 * @returns {Promise<number | null>}
 */
async function _resolveWorkerCountryId(worker) {
  if (Number.isFinite(worker?.countryId) && worker.countryId > 0) {
    return Number(worker.countryId);
  }
  const c = worker?.proxyClient;
  if (!c || typeof c._getMyInfo !== "function") return null;
  try {
    const info = await c._getMyInfo();
    const raw = info?.id_country ?? info?.country_id ?? null;
    const n = raw != null ? Number(raw) : null;
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/**
 * Preflight: для каждого воркера, у которого стартовый прокси в РФ
 * (id_country=1), один раз сделать changeGeo в не-РФ (фильтр PDF_GEO_FILTERS
 * + safety-net excludeCountryIds=[1] из network/config.js). После успешного
 * changeGeo перезапускаем surface, чтобы Chromium перепогрел сессию с новым IP.
 *
 * Не критично: changeGeo может упасть на cooldown / no-allowed-geo — просто
 * логируем и продолжаем. Воркер тогда поймает первый 451 и сработает обычный
 * L3 force-geo recovery.
 *
 * @param {{ workers: any[], log: (m: string) => void }} opts
 */
async function _preflightLeaveRussiaIfNeeded({ workers, log }) {
  for (const w of workers) {
    const countryId = await _resolveWorkerCountryId(w);
    if (countryId !== 1) {
      log(`[pipe/preflight] ${w.label} country_id=${countryId ?? "?"} — пропускаю (не РФ)`);
      continue;
    }
    if (!w.proxyClient || typeof w.proxyClient.changeGeo !== "function") {
      log(`[pipe/preflight] ${w.label} country_id=1 (РФ), но proxyClient/changeGeo нет — пропускаю`);
      continue;
    }
    log(`[pipe/preflight] ${w.label} стартовый прокси в РФ — делаю changeGeo на не-РФ`);
    let r;
    try {
      r = await w.proxyClient.changeGeo("pdf-preflight leave RU", {
        filters: PDF_GEO_FILTERS,
      });
    } catch (e) {
      log(`[pipe/preflight] ${w.label} changeGeo threw: ${e && e.message} — продолжаю как есть`);
      continue;
    }
    if (!r?.ok) {
      log(
        `[pipe/preflight] ${w.label} changeGeo не сработал (reason=${r?.reason ?? "?"}) — ` +
          `продолжаю как есть, дальше сработает обычный force-geo recovery`,
      );
      continue;
    }
    log(
      `[pipe/preflight] ${w.label} changeGeo OK geo='${r.caption ?? "?"}' ` +
        `country=${r.detail?.countryId ?? "?"} — рестарт Chromium surface`,
    );
    try {
      const proxyId =
        (typeof w.proxyClient.getResolvedProxyId === "function"
          ? await w.proxyClient.getResolvedProxyId()
          : null) ?? null;
      const abuse = _extractIpGuardianAbuse(r, proxyId);
      if (abuse?.found) {
        log(
          `[pipe/preflight] ${w.label} ВНИМАНИЕ: новый IP ${abuse.ip} в abuse-списках ` +
            `(${abuse.sources.join(", ") || "?"}) — pravocaptcha kad.arbitr.ru скорее всего ` +
            `отдаст 451. Если 451 продолжится — нужны другие/качественные прокси.`,
        );
      }
    } catch {}
    try {
      await w.downloader._restartPdfSurface("preflight leave RU");
    } catch (e) {
      log(`[pipe/preflight] ${w.label} _restartPdfSurface failed: ${e && e.message}`);
    }
  }
}

/**
 * Heartbeat-метрики пайплайна. Чистая observability — не влияет на путь
 * скачивания/extract'а, только периодически логирует сводку.
 *
 *   [pipe/metrics] pdf/min 1m=N 5m=N.N 15m=N.N | since_last: ok=N deferred=N
 *     dl_failed=N ex_failed=N | avg_ms: download=N extract=N mark_pg=N
 *     queue_wait=N pace=N | queue=N/CAP session_saved=N
 *
 *   pdf/min     — sliding rate за 1 / 5 / 15 минут (по timestamp'ам успехов)
 *   since_last  — счётчики событий между двумя report'ами
 *   avg_ms      — средние длительности этапов между двумя report'ами
 *   queue       — глубина download→extract буфера на момент report'а
 *
 * Все timestamp'ы через Date.now(), длительности через performance.now() —
 * замеры локальные в _downloadWorker / _processOne, передаются сюда noteXxx().
 *
 * Включается RAS_PDF_HEARTBEAT_MS (default 60_000). 0 = выключено.
 */
class MetricsReporter {
  constructor() {
    /** @type {number[]} timestamps (Date.now()) успешных PDF, ring до 15 мин. */
    this._okTs = [];
    this._sumDownloadMs = 0;
    this._countDownload = 0;
    this._sumExtractMs = 0;
    this._countExtract = 0;
    this._sumMarkPgMs = 0;
    this._countMarkPg = 0;
    this._sumQueueWaitMs = 0;
    this._countQueueWait = 0;
    this._sumPaceMs = 0;
    this._countPace = 0;
    this._intervalOk = 0;
    this._intervalDeferred = 0;
    this._intervalDlFailed = 0;
    this._intervalExFailed = 0;
  }

  /**
   * @param {{ downloadMs: number, markMs: number, queueWaitMs: number, paceMs?: number }} t
   */
  noteDownloadOk(t) {
    this._okTs.push(Date.now());
    if (Number.isFinite(t.downloadMs)) {
      this._sumDownloadMs += t.downloadMs;
      this._countDownload += 1;
    }
    if (Number.isFinite(t.markMs)) {
      this._sumMarkPgMs += t.markMs;
      this._countMarkPg += 1;
    }
    if (Number.isFinite(t.queueWaitMs)) {
      this._sumQueueWaitMs += t.queueWaitMs;
      this._countQueueWait += 1;
    }
    if (Number.isFinite(t.paceMs)) {
      this._sumPaceMs += t.paceMs;
      this._countPace += 1;
    }
    this._intervalOk += 1;
    this._trimOldTimestamps();
  }

  noteDeferred() {
    this._intervalDeferred += 1;
  }

  noteDlFailed() {
    this._intervalDlFailed += 1;
  }

  /**
   * @param {{ extractMs: number, markMs: number }} t
   */
  noteExtractOk(t) {
    if (Number.isFinite(t.extractMs)) {
      this._sumExtractMs += t.extractMs;
      this._countExtract += 1;
    }
    if (Number.isFinite(t.markMs)) {
      this._sumMarkPgMs += t.markMs;
      this._countMarkPg += 1;
    }
  }

  noteExFailed() {
    this._intervalExFailed += 1;
  }

  _trimOldTimestamps() {
    const cutoff = Date.now() - 15 * 60 * 1000;
    let i = 0;
    while (i < this._okTs.length && this._okTs[i] < cutoff) i += 1;
    if (i > 0) this._okTs.splice(0, i);
  }

  /**
   * Сколько PDF успешных за последние `minutes` минут (sliding).
   * @param {number} minutes
   */
  _countSince(minutes) {
    const cutoff = Date.now() - minutes * 60 * 1000;
    let i = 0;
    while (i < this._okTs.length && this._okTs[i] < cutoff) i += 1;
    return this._okTs.length - i;
  }

  /**
   * Собрать строку метрик. Сбрасывает per-interval средние и счётчики событий,
   * но НЕ ring `_okTs` (он нужен для sliding rate).
   *
   * @param {{ queueSize: number, queueCap: number, sessionSaved: number }} ctx
   * @returns {string}
   */
  buildReport({ queueSize, queueCap, sessionSaved }) {
    this._trimOldTimestamps();
    const r1 = this._countSince(1);
    const r5 = this._countSince(5);
    const r15 = this._countSince(15);
    const avg = (sum, n) => (n > 0 ? Math.round(sum / n) : 0);
    const avgDownload = avg(this._sumDownloadMs, this._countDownload);
    const avgExtract = avg(this._sumExtractMs, this._countExtract);
    const avgMark = avg(this._sumMarkPgMs, this._countMarkPg);
    const avgQueueWait = avg(this._sumQueueWaitMs, this._countQueueWait);
    const avgPace = avg(this._sumPaceMs, this._countPace);
    const intervalOk = this._intervalOk;
    const intervalDef = this._intervalDeferred;
    const intervalDlFail = this._intervalDlFailed;
    const intervalExFail = this._intervalExFailed;

    this._sumDownloadMs = 0;
    this._countDownload = 0;
    this._sumExtractMs = 0;
    this._countExtract = 0;
    this._sumMarkPgMs = 0;
    this._countMarkPg = 0;
    this._sumQueueWaitMs = 0;
    this._countQueueWait = 0;
    this._sumPaceMs = 0;
    this._countPace = 0;
    this._intervalOk = 0;
    this._intervalDeferred = 0;
    this._intervalDlFailed = 0;
    this._intervalExFailed = 0;

    const rate5 = (r5 / 5).toFixed(1);
    const rate15 = (r15 / 15).toFixed(1);
    return (
      `[pipe/metrics] pdf/min 1m=${r1} 5m=${rate5} 15m=${rate15} | ` +
      `since_last: ok=${intervalOk} deferred=${intervalDef} ` +
      `dl_failed=${intervalDlFail} ex_failed=${intervalExFail} | ` +
      `avg_ms: download=${avgDownload} extract=${avgExtract} mark_pg=${avgMark} ` +
      `queue_wait=${avgQueueWait} pace=${avgPace} | ` +
      `queue=${queueSize}/${queueCap} session_saved=${sessionSaved}`
    );
  }
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

  // Startup PG-запросы прячем за тем же retry, что и worker'ные: если БД
  // на старте мигнула (docker-compose restart, рестарт postgres) — supervisor
  // не должен пинать пайплайн раз в секунду, мы сами подождём.
  const stats0 = await _retryPgCall(
    () => pipelineStats(),
    "pipelineStats(initial)",
    log,
    undefined,
  );
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

  // Preflight: если стартовый прокси воркера в РФ (id_country=1), pravocaptcha
  // на kad.arbitr.ru банит его 451 на первом же запросе. Лучше потратить
  // одну changeGeo (≤180с cooldown) до старта, чем сжечь N актов на 451+defer
  // и потом всё равно уйти в quarantine. Не блокирующее: если changeGeo не
  // помог (cooldown/no-candidates) — продолжаем как раньше, в надежде на
  // L3 force-geo по ходу работы.
  if (String(process.env.RAS_PDF_PREFLIGHT_GEO_IF_RU ?? "0").trim() === "1") {
    await _preflightLeaveRussiaIfNeeded({ workers, log });
  }

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
  const runState = {
    totalSeen: 0,
    lastSuccessAt: Date.now(),     // обновляется на любом markPdfDownloaded
    stuckWarned: false,            // чтобы не спамить warning'ом каждые 30с
  };
  const shouldStop = () => stopRequested || (MAX_RUN > 0 && runState.totalSeen >= MAX_RUN);

  // ── Heartbeat-метрики: read-only observability, не влияет на путь скачивания. ──
  const metrics = new MetricsReporter();

  // ── Шаг 3: shared-source актов (БД-батчи или явный список). ──
  const explicitIds = Array.isArray(ids) && ids.length ? ids : null;
  let explicitConsumed = false;
  const source = new SharedActQueue({
    fetchBatch: async () => {
      if (explicitIds) {
        if (explicitConsumed) return [];
        explicitConsumed = true;
        const batch = await _retryPgCall(
          () => selectByIds(explicitIds),
          "selectByIds",
          log,
          shouldStop,
        );
        log(`[pipe/claim] explicit ids: запрошено=${explicitIds.length}, найдено=${batch.length}`);
        return batch;
      }
      return _retryPgCall(
        () => selectPendingPdf(BATCH_SIZE),
        "selectPendingPdf",
        log,
        shouldStop,
      );
    },
    refillable: !explicitIds,
    logger: log,
  });

  // ── Шаг 5: extract-pool. ──
  const extractWorkers = Array.from({ length: EXTRACT_WORKERS }, (_, i) =>
    _extractWorker({ id: i + 1, queue, log, counters, metrics }),
  );

  // ── Шаг 6a: heartbeat-метрики каждые HEARTBEAT_MS. ──
  // Простой setInterval, без race с pool — на shutdown'е чистим в finally.
  let heartbeatTimer = null;
  if (HEARTBEAT_MS > 0) {
    log(`[pipe] heartbeat: каждые ${HEARTBEAT_MS}ms ([pipe/metrics] ...)`);
    heartbeatTimer = setInterval(() => {
      if (shouldStop()) return;
      let sessionSaved = 0;
      for (const w of workers) {
        const fn = w.downloader?.getSessionPdfSavedCount;
        if (typeof fn === "function") {
          try {
            sessionSaved += Number(fn.call(w.downloader)) || 0;
          } catch {}
        }
      }
      const line = metrics.buildReport({
        queueSize: queue.size,
        queueCap: QUEUE_BUFFER,
        sessionSaved,
      });
      log(line);
    }, HEARTBEAT_MS);
    if (heartbeatTimer.unref) heartbeatTimer.unref();
  }

  // ── Шаг 6: no-progress watchdog. ──
  // Если PDF не идут — либо все воркеры в карантине надолго, либо что-то
  // отвалилось тихо (прокси-сервер, kad.arbitr.ru, MP API). Мы хотим:
  //   - после STUCK_TIMEOUT_MS залогировать warning (это сигнал supervisor'у/админу);
  //   - после STUCK_FATAL_MS — кинуть исключение, supervisor в download-acts.js
  //     закроет всё и перезапустит пайплайн с чистого листа.
  // Если STUCK_TIMEOUT_MS=0 — watchdog отключён.
  let watchdogReject = null;
  const watchdogPromise = new Promise((_, rej) => {
    watchdogReject = rej;
  });
  let watchdogTimer = null;
  if (STUCK_TIMEOUT_MS > 0) {
    watchdogTimer = setInterval(() => {
      if (shouldStop()) return;
      const since = Date.now() - runState.lastSuccessAt;
      if (since >= STUCK_FATAL_MS) {
        const msg =
          `[pipe/watchdog] FATAL: нет успешных PDF за ${Math.round(since / 60_000)} мин ` +
          `(STUCK_FATAL_MS=${STUCK_FATAL_MS}ms) — перезапускаю пайплайн`;
        log(msg);
        if (watchdogReject) watchdogReject(new Error("pipeline_stuck_fatal"));
        return;
      }
      if (since >= STUCK_TIMEOUT_MS && !runState.stuckWarned) {
        log(
          `[pipe/watchdog] WARN: нет успешных PDF за ${Math.round(since / 60_000)} мин ` +
            `(STUCK_TIMEOUT_MS=${STUCK_TIMEOUT_MS}ms) — продолжаю, fatal в ${Math.round(STUCK_FATAL_MS / 60_000)} мин`,
        );
        runState.stuckWarned = true;
      }
    }, 30_000);
    if (watchdogTimer.unref) watchdogTimer.unref();
  }

  // ── Шаг 7: download-pool. Promise.allSettled + watchdog race. ──
  try {
    const poolPromise = Promise.allSettled(
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
          metrics,
        }),
      ),
    );
    const winner = await Promise.race([
      poolPromise.then((r) => ({ kind: "pool", results: r })),
      watchdogPromise, // отклонится только при stuck-fatal
    ]);
    // Pool отработал. Проверим, не упали ли ВСЕ воркеры — это значит, что
    // пайплайн дальше работать не может, рестарт нужен.
    if (winner && winner.kind === "pool") {
      const results = winner.results;
      const rejected = results.filter((r) => r.status === "rejected");
      for (const r of rejected) {
        log(`[pipe] worker rejected: ${r.reason && (r.reason.message ?? r.reason)}`);
      }
      if (results.length > 0 && rejected.length === results.length) {
        throw new Error(
          `all ${results.length} download workers crashed: ` +
            rejected
              .slice(0, 3)
              .map((r) => String(r.reason?.message ?? r.reason).slice(0, 200))
              .join(" | "),
        );
      }
    }
  } finally {
    if (watchdogTimer) clearInterval(watchdogTimer);
    if (heartbeatTimer) clearInterval(heartbeatTimer);
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

  // На финале БД может быть недоступна — не валим прогон из-за этого, лог-only.
  let stats1;
  try {
    stats1 = await pipelineStats();
  } catch (e) {
    log(`[pipe] финальный pipelineStats упал: ${e && e.message} — лог без него`);
    stats1 = { pdf_done: -1, text_done: -1, pending_pdf: -1, pending_text: -1, total_keep: -1 };
  }
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
  metrics,
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
  /**
   * Ставится в true после успешного recover перед quarantine (`_attemptProxyRecoverBeforeQuarantine`
   * для infra или `_attempt451ProxyRecoverBeforeQuarantine` для 451) —
   * чтобы следующая итерация цикла пропустила проверку isQuarantined и дала
   * воркеру шанс на свежем IP/гео, несмотря на установленный cooldown.
   * Cooldown в registry остаётся; если recover не реально помог и пойдёт
   * новый infra/451 — нового quarantine-входа не будет (entered=false при
   * активном cooldown), но воркер продолжит попытки до естественного выхода.
   */
  let skipQuarantineCheckOnce = false;
  /** Следующий шаг last-ditch recover при пороге 451: ip → rotateIp, geo → changeGeo. */
  let next451RecoverAction = "ip";
  /**
   * Подряд неожиданных исключений в теле цикла (не штатный результат
   * downloadAndSave, а throw из claimNext / markPdfDownloaded / etc).
   * После порога считаем воркер сломанным и выходим — supervisor рестартанёт
   * весь пайплайн.
   */
  const WORKER_UNEXPECTED_FAIL_LIMIT = 5;
  let consecutiveUnexpectedFails = 0;
  while (true) {
    if (shouldStop()) {
      logWorkerEnd(`[${label}] стоп-сигнал — выхожу из download loop`);
      return;
    }
    try {
    // Карантин: пока прокси на скамейке — спим прерываемыми чанками, очередь
    // не дёргаем. Здоровые воркеры тем временем разбирают общий буфер
    // (включая deferred-акты этого воркера).
    if (skipQuarantineCheckOnce) {
      skipQuarantineCheckOnce = false;
    } else if (quarantine && proxyKey && quarantine.isQuarantined(proxyKey)) {
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

    const metricsDlT0 = performance.now();
    const tDl0 = PDF_TIMING ? performance.now() : 0;
    const r = await downloader.downloadAndSave(act);
    const metricsDlMs = performance.now() - metricsDlT0;
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
        if (metrics) metrics.noteDeferred();
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
            // Last-ditch recover ПЕРЕД sleep: меняем гео (тяжелее IP, но
            // для infra/туннеля чаще помогает). Если hard-cooldown — падаем
            // в обычный quarantine sleep.
            const recovered = await _attemptProxyRecoverBeforeQuarantine({
              label,
              downloader,
              log,
              reason: "infra",
            });
            if (recovered) {
              counters.worker_restarts += 1;
              consecutiveInfraFails = 0;
              skipQuarantineCheckOnce = true;
              continue;
            }
            log(`[pdf/quarantine] proxy_key_sleep reason=recover_failed_or_cooldown`);
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
        if (metrics) metrics.noteDeferred();
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
            // Last-ditch recover ПЕРЕД sleep: пробуем сменить IP. Если ок —
            // restart Chromium и continue, обходя quarantine-sleep на этой
            // итерации (флаг skipQuarantineCheckOnce). Cooldown в registry
            // остаётся как safety-net.
            const recovered = await _attempt451ProxyRecoverBeforeQuarantine({
              label,
              downloader,
              log,
              action: next451RecoverAction,
            });
            if (recovered) {
              counters.worker_restarts += 1;
              next451RecoverAction = next451RecoverAction === "ip" ? "geo" : "ip";
              skipQuarantineCheckOnce = true;
              continue;
            }
            log(`[pdf/quarantine] proxy_key_sleep reason=recover_failed_or_cooldown`);
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
      if (metrics) metrics.noteDlFailed();
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
    const tDb0 = performance.now();
    try {
      await markPdfDownloaded(act.id, { pdfPath: r.pdfPath, pdfBytes: r.bytes });
    } catch (e) {
      log(`[${label}] markPdfDownloaded: ${e}`);
    }
    dbMs = performance.now() - tDb0;

    counters.downloaded += 1;
    runState.lastSuccessAt = Date.now();
    runState.stuckWarned = false;
    consecutiveUnexpectedFails = 0;
    if (quarantine && proxyKey) quarantine.recordSuccess(proxyKey);

    // Передаём в extract-pool. queue.push() блокируется, если буфер заполнен —
    // мягкий backpressure.
    const tQ0 = performance.now();
    try {
      await queue.push({ id: act.id, pdfPath: r.pdfPath });
    } catch (e) {
      logWorkerEnd(`[${label}] queue closed mid-push: ${e}`);
      return;
    }
    qMs = performance.now() - tQ0;

    const paceMs = await downloader.paceAfterSuccess();
    if (metrics) {
      metrics.noteDownloadOk({
        downloadMs: metricsDlMs,
        markMs: dbMs,
        queueWaitMs: qMs,
        paceMs,
      });
    }
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
    } catch (e) {
      // Неожиданное исключение В ТЕЛЕ цикла (не штатный r.ok=false из downloadAndSave).
      // Чаще всего: PG потеряла соединение (markPdfDownloaded), Chromium умер вне
      // _safeRewarmup, queue.push на закрытой очереди и т.п. НЕ паникуем, не
      // помечаем акт как failed (источник причины может быть не в нём) —
      // спим WORKER_UNEXPECTED_PAUSE_MS и идём дальше.
      consecutiveUnexpectedFails += 1;
      log(
        `[${label}] неожиданное исключение в worker loop (#${consecutiveUnexpectedFails}/${WORKER_UNEXPECTED_FAIL_LIMIT}): ` +
          `${e && (e.stack ?? e.message ?? e)}`,
      );
      if (consecutiveUnexpectedFails >= WORKER_UNEXPECTED_FAIL_LIMIT) {
        log(
          `[${label}] >= ${WORKER_UNEXPECTED_FAIL_LIMIT} неожиданных исключений подряд — выхожу, ` +
            `supervisor рестартанёт пайплайн`,
        );
        throw e;
      }
      await _interruptibleSleep(WORKER_UNEXPECTED_PAUSE_MS, shouldStop);
      continue;
    }
  }
}

async function _extractWorker({ id, queue, log, counters, metrics }) {
  while (true) {
    const { done, value } = await queue.shift();
    if (done) return;
    await _processOne(value, log, counters, `ex#${id}`, metrics);
  }
}

async function _processOne({ id, pdfPath }, log, counters, who, metrics) {
  const t0 = performance.now();
  const r = await extractPdfText(pdfPath);
  const exMs = performance.now() - t0;
  if (PDF_TIMING) {
    log(`[pipe/timing] ${who} id=${id} extract_pdftotext=${exMs.toFixed(0)}ms`);
  }
  if (!r.ok) {
    counters.ex_failed += 1;
    if (metrics) metrics.noteExFailed();
    log(`[pipe/${who}] EXTRACT FAIL id=${id} code=${r.code}: ${r.error}`);
    try {
      await markExtractFailed(id, `${r.code}: ${r.error}`);
    } catch (e) {
      log(`[pipe/${who}] markExtractFailed: ${e}`);
    }
    return;
  }
  const markT0 = performance.now();
  try {
    await markTextExtracted(id, r.text);
    const markMs = performance.now() - markT0;
    counters.extracted += 1;
    if (metrics) metrics.noteExtractOk({ extractMs: exMs, markMs });
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

export const __test__ = { BoundedQueue, SharedActQueue, MetricsReporter, _downloadWorker };
