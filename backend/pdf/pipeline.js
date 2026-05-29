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

import { MP_API_TOKEN, PDF_GEO_FILTERS } from "../network/config.js";
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
import {
  createPdfPool,
  isProbationRotateFirstTrigger,
  logPdfDownloadAggregateStats,
} from "./downloader.js";
import { extractPdfText } from "./extractor.js";
import { countActTokens } from "./jinaV3Tokens.js";
import {
  ProxyQuarantineRegistry,
  readQuarantineConfigFromEnv,
} from "./proxyQuarantine.js";
import {
  BadGeoBlacklist,
  readBadGeoBlacklistConfigFromEnv,
} from "./badGeoBlacklist.js";
import {
  probeRecommendedCountriesCached,
  readProbeOptsFromEnv,
} from "./proxyHealth.js";

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
 * backend/tools/download-acts.js перезапустит весь пайплайн (закроет Chromium-ы,
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

/**
 * Slow-proxy detection: после probation (первого PDF OK) recoverable-сигналы
 * вроде `evaluate timeout after Xms`, ERR_HTTP2_*, "ras/kad timeout" и пр.
 * раньше тихо скипались (paceAfterFailure + continue) — медленный воркер
 * продолжал ловить таймауты, теряя минуты на каждый цикл warmup'а.
 *
 * Считаем такие события в trailing-window. При длине ≥ THRESHOLD за окно
 * воркер делает changeGeo (через тот же _attemptProxyRecoverBeforeQuarantine,
 * что для infra/451) и продолжает работу. Cooldown не ставим — если новый
 * geo тоже окажется медленным, через окно снова накопится порог и снова
 * будет changeGeo. Здоровые воркеры всё это время разбирают общую очередь.
 *
 * RAS_PDF_SLOW_THRESHOLD=0 → детектор выключен.
 */
const SLOW_TIMEOUT_THRESHOLD = Math.max(
  0,
  Number(process.env.RAS_PDF_SLOW_THRESHOLD ?? 2),
);
const SLOW_TIMEOUT_WINDOW_MS = Math.max(
  0,
  Number(process.env.RAS_PDF_SLOW_WINDOW_MS ?? 300_000),
);

/** Интервал heartbeat-метрик пайплайна (мс). 0 = выключить лог. */
const HEARTBEAT_MS = Math.max(0, Number(process.env.RAS_PDF_HEARTBEAT_MS ?? 60_000));

/**
 * Сколько подряд `pravocaptcha_gate`-fails при `no_pdf_yet=1` нужно, чтобы
 * сработал recover (fast-geo-loop). Дефолт 1 — на свежем worker'е первый же
 * tokenFrom = bad-geo сигнал, не ждём второго (каждый act-warmup ~50с).
 * Поднять до 2-3 если есть подозрение на транзиентные срабатывания.
 */
const PRAVOCAPTCHA_GATE_STREAK_THRESHOLD = Math.max(
  1,
  Number(process.env.RAS_PDF_PRAVOCAPTCHA_GATE_STREAK ?? 1),
);

/**
 * Bad-geo fast recovery (см. pdf/downloader.js _recoverByGeoLoop):
 * вместо долгого quarantine sleep (5-10 мин) — быстро перебираем geo через
 * changeGeo, пока не найдём живой. Сожжённый geo попадает в in-memory blacklist
 * на RAS_PDF_BAD_GEO_COOLDOWN_MS, и recovery его не выбирает повторно.
 *
 * RAS_PDF_BAD_GEO_RECOVERY=1 (default 1) — включён для всех воркеров.
 * RAS_PDF_BAD_GEO_RECOVERY=0 → старое поведение (escalator+quarantine sleep).
 */
const BAD_GEO_RECOVERY_ENABLED =
  String(process.env.RAS_PDF_BAD_GEO_RECOVERY ?? "1").trim() !== "0";

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
/** [YYYY-MM-DD HH:MM:SS.mmm] для дефолтных fallback-логеров (только если caller не передал свой). */
function _pipelineTs() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  );
}

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
 *   451 → см. `_attempt451ProxyRecoverBeforeQuarantine` (changeGeo first для 451,
 *         потому что rotateIp часто возвращает тот же IP).
 *
 * Возвращает true, если recover успел сменить IP/гео И surface перезапустился.
 * `ok=false` от прокси-API чаще всего значит hard-cooldown (например, 24ч
 * между changeGeo) — тогда падаем в обычный quarantine sleep.
 *
 * @param {{
 *   label: string,
 *   downloader: any,
 *   log: (m: string) => void,
 *   reason: string,
 *   shouldStop?: () => boolean,
 *   tryRotateFirst?: boolean,
 *   loopUntilSuccess?: boolean,
 * }} opts
 * @returns {Promise<boolean>}
 */
async function _attemptProxyRecoverBeforeQuarantine({
  label,
  downloader,
  log,
  reason,
  shouldStop,
  tryRotateFirst = false,
  loopUntilSuccess = false,
}) {
  const client = downloader.proxyClient;
  if (!client) return false;
  // Fast bad-geo recovery: вместо одного changeGeo — крутим до RAS_PDF_RECOVER_MAX_ROUNDS
  // в downloader._recoverByGeoLoop, помечая сожжённые geo в blacklist.
  if (
    BAD_GEO_RECOVERY_ENABLED &&
    typeof downloader.hasFastGeoRecovery === "function" &&
    downloader.hasFastGeoRecovery()
  ) {
    const r = await downloader._recoverByGeoLoop({
      reason: `pdf-quarantine ${reason}`,
      shouldStop,
      tryRotateFirst,
      loopUntilSuccess,
    });
    log(
      `[pdf/proxy-recover] fast-geo-loop reason=${reason} ok=${r.ok}` +
        (r.ok
          ? ` mode=${r.mode ?? "?"} geo=${r.geoid ?? "?"} round=${r.round ?? r.attempt ?? "?"}`
          : ` reason=${r.reason ?? "?"}`),
    );
    return r.ok === true;
  }
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
 * Last-ditch 451 recover: при включённом BAD_GEO_RECOVERY_ENABLED → fast-geo-loop
 * в downloader (rotateIp-first до первого PDF OK, changeGeo иначе, blacklist
 * по geo+operator+IP, HTTP probe ras/kad до warmup, exhausted pause).
 * При loopUntilSuccess=true (single-worker) — не выходит до успеха или stop.
 * Иначе — старая логика чередования rotateIp/changeGeo (legacy fallback).
 *
 * @param {{
 *   label: string,
 *   downloader: any,
 *   log: (m: string) => void,
 *   action: "ip"|"geo",
 *   shouldStop?: () => boolean,
 *   tryRotateFirst?: boolean,
 *   loopUntilSuccess?: boolean,
 * }} opts
 * @returns {Promise<boolean>}
 */
async function _attempt451ProxyRecoverBeforeQuarantine({
  label,
  downloader,
  log,
  action,
  shouldStop,
  tryRotateFirst = false,
  loopUntilSuccess = false,
}) {
  const client = downloader.proxyClient;
  if (!client) return false;
  if (
    BAD_GEO_RECOVERY_ENABLED &&
    typeof downloader.hasFastGeoRecovery === "function" &&
    downloader.hasFastGeoRecovery()
  ) {
    const r = await downloader._recoverByGeoLoop({
      reason: "pdf-quarantine 451",
      shouldStop,
      tryRotateFirst,
      loopUntilSuccess,
    });
    log(
      `[pdf/proxy-recover] fast-geo-loop reason=451 ok=${r.ok}` +
        (r.ok
          ? ` mode=${r.mode ?? "?"} geo=${r.geoid ?? "?"} round=${r.round ?? r.attempt ?? "?"}`
          : ` reason=${r.reason ?? "?"}`),
    );
    return r.ok === true;
  }
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
 * Bad-country list: страны, в которых pravocaptcha бьёт 451 / отдаёт tokenFrom
 * даже на свежих IP. Probe 2026-05: РФ-megafone, UA-Kyivstar/vodafone стабильно
 * горят. KZ/BY/KG проходят 9/10.
 *
 * Дефолт `1,2` (RU, UA). Переопределение `RAS_PDF_BAD_COUNTRY_IDS=1,2,180`.
 *
 * @returns {Set<number>}
 */
function _readBadCountryIdsFromEnv() {
  const raw = String(process.env.RAS_PDF_BAD_COUNTRY_IDS ?? "1,2").trim();
  if (!raw) return new Set([1, 2]);
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return new Set(ids.length ? ids : [1, 2]);
}

/**
 * Preflight: для каждого воркера, у которого стартовый прокси в стране из
 * bad-country-листа (RU=1, UA=2 по дефолту), ДО старта worker-loop'а вызываем
 * полноценный fast-geo-loop в downloader'e:
 *
 *   markBad текущий geo+operator+ip → changeGeo(requireCountryIds=22,82,145)
 *   → HTTP probe ras/kad → restart surface. Если probe не ok — markBad новый
 *   geo и идём дальше до RECOVER_MAX_ROUNDS. С `loopUntilSuccess=true` (это
 *   старт, других воркеров нет) — после exhausted_pause продолжаем поиск.
 *
 * Это экономит ~100с per-worker (warmup ras→kad/Card ~50с × N=2 актов с
 * tokenFrom → consecutivePravocaptchaGate триггерит то же самое позже).
 *
 * Не критично: если recover полностью провалился — продолжаем как есть, в
 * worker loop'е сработает обычный bad-geo trigger.
 *
 * @param {{ workers: any[], log: (m: string) => void, shouldStop?: () => boolean }} opts
 */
/**
 * @param {{
 *   workers: any[],
 *   log: (m: string) => void,
 *   shouldStop?: () => boolean,
 *   recommendedCountries?: number[]|null,
 *   escapeFilters?: object|null,
 * }} opts
 */
async function _preflightEscapeBadCountry({
  workers,
  log,
  shouldStop,
  recommendedCountries = null,
  escapeFilters = null,
}) {
  const badCountries = _readBadCountryIdsFromEnv();
  const hasRecommended =
    Array.isArray(recommendedCountries) && recommendedCountries.length > 0;
  const recommendedSet = hasRecommended ? new Set(recommendedCountries) : null;
  const effectiveFilters = escapeFilters ?? PDF_GEO_FILTERS;
  log(
    `[pipe/preflight] bad_country_ids={${[...badCountries].join(",")}}, ` +
      `target={${effectiveFilters.requireCountryIds?.join(",") || "any"}}` +
      (hasRecommended ? ` recommended={${recommendedCountries.join(",")}}` : ""),
  );
  for (const w of workers) {
    if (typeof shouldStop === "function" && shouldStop()) return;
    const countryId = await _resolveWorkerCountryId(w);
    if (countryId == null) {
      log(`[pipe/preflight] ${w.label} country_id=? — пропускаю (не смог резолвнуть)`);
      continue;
    }
    // Решение «нужен escape?»:
    //   - если probe вернул recommended-список и страна воркера в нём → OK, skip;
    //   - если probe вернул recommended-список и страны воркера в нём НЕТ → escape;
    //   - если probe не дал результата, fall back на статичный bad-list.
    let needsEscape = false;
    let escapeReason = "";
    if (hasRecommended) {
      if (recommendedSet.has(countryId)) {
        log(
          `[pipe/preflight] ${w.label} country_id=${countryId} IN recommended ` +
            `{${recommendedCountries.join(",")}} — OK`,
        );
        continue;
      }
      needsEscape = true;
      escapeReason = `country_id=${countryId} NOT in recommended {${recommendedCountries.join(",")}}`;
    } else {
      if (!badCountries.has(countryId)) {
        log(
          `[pipe/preflight] ${w.label} country_id=${countryId} OK (не в bad-list) — пропускаю`,
        );
        continue;
      }
      needsEscape = true;
      escapeReason = `country_id=${countryId} in bad-list {${[...badCountries].join(",")}}`;
    }
    if (!w.proxyClient || typeof w.proxyClient.changeGeo !== "function") {
      log(
        `[pipe/preflight] ${w.label} ${escapeReason}, но proxyClient/changeGeo нет — пропускаю`,
      );
      continue;
    }
    if (
      typeof w.downloader?.hasFastGeoRecovery !== "function" ||
      !w.downloader.hasFastGeoRecovery()
    ) {
      // Fallback: прямой changeGeo + restart, без probe и без blacklist.
      log(
        `[pipe/preflight] ${w.label} ${escapeReason} — fast-geo-loop недоступен, прямой changeGeo`,
      );
      try {
        const r = await w.proxyClient.changeGeo(
          "pdf-preflight escape (fallback)",
          { filters: effectiveFilters },
        );
        log(
          `[pipe/preflight] ${w.label} changeGeo ok=${r?.ok === true} ` +
            `reason=${r?.reason ?? "?"} caption='${r?.caption ?? "?"}'`,
        );
        if (r?.ok) {
          await w.downloader._restartPdfSurface("preflight escape (fallback)");
        }
      } catch (e) {
        log(`[pipe/preflight] ${w.label} fallback changeGeo threw: ${e && e.message}`);
      }
      continue;
    }
    log(
      `[pipe/preflight] ${w.label} ${escapeReason} — fast-geo-loop ` +
        `(target=[${effectiveFilters.requireCountryIds?.join(",") || "any"}])`,
    );
    let r;
    try {
      r = await w.downloader._recoverByGeoLoop({
        reason: hasRecommended
          ? `preflight_not_recommended_${countryId}`
          : `preflight_bad_country_${countryId}`,
        shouldStop,
        // Не пробуем rotateIp в текущем geo — мы знаем, что country целиком плох.
        tryRotateFirst: false,
        // На старте больше некому брать очередь — крутимся до успеха.
        loopUntilSuccess: true,
      });
    } catch (e) {
      log(`[pipe/preflight] ${w.label} fast-geo-loop threw: ${e && e.message} — продолжаю как есть`);
      continue;
    }
    if (r?.ok) {
      log(
        `[pipe/preflight] ${w.label} escape OK mode=${r.mode ?? "?"} geo=${r.geoid ?? "?"} ` +
          `round=${r.round ?? r.attempt ?? "?"}`,
      );
    } else {
      log(
        `[pipe/preflight] ${w.label} escape FAILED reason=${r?.reason ?? "?"} — ` +
          `продолжаю как есть; обычный force-geo recovery сработает в worker loop`,
      );
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
    // Jina v3 reranker tokens — lifetime агрегаты (для avg/max), плюс
    // per-interval счётчики (для since_last в heartbeat).
    this._tokensSumLife = 0;
    this._tokensCountLife = 0;
    this._tokensMaxLife = 0;
    this._tokensMaxIdLife = null;
    this._intervalTokensSum = 0;
    this._intervalTokensCount = 0;
    this._intervalTokensMissing = 0;
    this._intervalTokensLast = null;
    this._intervalTokensLastId = null;
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

  /**
   * Записать token_count акта (jina-reranker-v3 tokenizer).
   * Кормит lifetime avg/max + per-interval since_last.
   * @param {number} n
   * @param {string} id
   */
  noteTokens(n, id) {
    if (!Number.isFinite(n) || n < 0) return;
    this._tokensSumLife += n;
    this._tokensCountLife += 1;
    if (n > this._tokensMaxLife) {
      this._tokensMaxLife = n;
      this._tokensMaxIdLife = id ?? null;
    }
    this._intervalTokensSum += n;
    this._intervalTokensCount += 1;
    this._intervalTokensLast = n;
    this._intervalTokensLastId = id ?? null;
  }

  /**
   * Текст есть, но inference /count_tokens вернул null (inference down).
   * Считаем отдельно — это не «нет текста», это «нет числа токенов».
   */
  noteTokensMissing() {
    this._intervalTokensMissing += 1;
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
    // Tokens since_last + lifetime snapshot (для avg/max в строке).
    const intervalTokSum = this._intervalTokensSum;
    const intervalTokCnt = this._intervalTokensCount;
    const intervalTokMiss = this._intervalTokensMissing;
    const intervalTokLast = this._intervalTokensLast;
    const intervalTokLastId = this._intervalTokensLastId;
    const tokAvgLife = this._tokensCountLife > 0
      ? Math.round(this._tokensSumLife / this._tokensCountLife)
      : 0;
    const tokMaxLife = this._tokensMaxLife;
    const tokMaxIdLife = this._tokensMaxIdLife;
    const tokCountedLife = this._tokensCountLife;

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
    this._intervalTokensSum = 0;
    this._intervalTokensCount = 0;
    this._intervalTokensMissing = 0;
    this._intervalTokensLast = null;
    this._intervalTokensLastId = null;

    const rate5 = (r5 / 5).toFixed(1);
    const rate15 = (r15 / 15).toFixed(1);
    const mainLine =
      `[pipe/metrics] pdf/min 1m=${r1} 5m=${rate5} 15m=${rate15} | ` +
      `since_last: ok=${intervalOk} deferred=${intervalDef} ` +
      `dl_failed=${intervalDlFail} ex_failed=${intervalExFail} | ` +
      `avg_ms: download=${avgDownload} extract=${avgExtract} mark_pg=${avgMark} ` +
      `queue_wait=${avgQueueWait} pace=${avgPace} | ` +
      `queue=${queueSize}/${queueCap} session_saved=${sessionSaved}`;
    if (tokCountedLife === 0 && intervalTokMiss === 0) {
      return mainLine;
    }
    const intervalAvg = intervalTokCnt > 0
      ? Math.round(intervalTokSum / intervalTokCnt)
      : null;
    const lastTag = intervalTokLast != null
      ? ` last=${intervalTokLast}` +
        (intervalTokLastId ? `(id=${intervalTokLastId})` : "")
      : "";
    const maxTag = tokMaxLife > 0
      ? ` max=${tokMaxLife}` + (tokMaxIdLife ? `(id=${tokMaxIdLife})` : "")
      : "";
    const tokensLine =
      `[pipe/metrics] tokens jina-v3: counted=${tokCountedLife} ` +
      `avg=${tokAvgLife}${maxTag} | ` +
      `since_last: n=${intervalTokCnt}` +
      (intervalAvg != null ? ` avg=${intervalAvg}` : "") +
      lastTag +
      ` no_count=${intervalTokMiss}`;
    return `${mainLine}\n${tokensLine}`;
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
  const log = logger ?? ((m) => process.stdout.write(`[${_pipelineTs()}] ${m}\n`));
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

  // Bad-geo blacklist: in-memory, общий на пайплайн. Recovery loop в
  // downloader.js читает его, чтобы не возвращаться к сожжённым geo.
  const badGeoCfg = readBadGeoBlacklistConfigFromEnv();
  const badGeoBlacklist = new BadGeoBlacklist({
    cooldownMs: badGeoCfg.cooldownMs,
    logger: log,
  });
  log(
    `[pipe] bad-geo recovery: enabled=${BAD_GEO_RECOVERY_ENABLED} ` +
      `cooldown=${badGeoCfg.cooldownMs}ms`,
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
    badGeoBlacklist,
  });
  log(`[pipe] download pool: ${workers.length} воркер(ов)`);

  // Preflight: до старта worker-loop'а решаем, нужно ли каждому воркеру
  // changeGeo. Источник правды — anti-cloak probe ras.arbitr.ru через
  // MobileProxy API (если есть MP_API_TOKEN и не отключён env'ом). Probe даёт
  // recommended-страны; ниже мы override'им geoFilters воркеров на этот список,
  // и _preflightEscapeBadCountry триггерит fast-geo-loop для тех, чья текущая
  // страна не в recommended. Если probe вернул пусто или сломался — fall back
  // на статичный RAS_PDF_BAD_COUNTRY_IDS bad-list (старое поведение).
  //
  // Если recovery полностью провалился — пайплайн всё равно стартует, в worker
  // loop'е сработает обычный bad-geo trigger.
  //
  // Выключить весь preflight: RAS_PDF_PREFLIGHT_GEO=0
  // Выключить только probe (оставить static bad-list): RAS_PDF_PREFLIGHT_PROBE=0
  const preflightFlag = String(
    process.env.RAS_PDF_PREFLIGHT_GEO ??
      process.env.RAS_PDF_PREFLIGHT_GEO_IF_RU ??
      "1",
  ).trim();
  if (preflightFlag !== "0" && preflightFlag.toLowerCase() !== "off") {
    /** @type {number[]|null} */
    let recommendedCountries = null;
    /** @type {object|null} */
    let escapeFilters = null;
    const probeFlag = String(process.env.RAS_PDF_PREFLIGHT_PROBE ?? "1").trim();
    const probeEnabled =
      probeFlag !== "0" &&
      probeFlag.toLowerCase() !== "off" &&
      Boolean(MP_API_TOKEN);
    if (!MP_API_TOKEN) {
      log(`[pipe/preflight-probe] MP_API_TOKEN пуст — пропускаю anti-cloak probe`);
    } else if (!probeEnabled) {
      log(`[pipe/preflight-probe] RAS_PDF_PREFLIGHT_PROBE=0 — пропускаю anti-cloak probe`);
    } else {
      const probeOpts = readProbeOptsFromEnv();
      // Reuse страны из workers'ов — createPdfPool только что дёргал getMyProxy,
      // повторный raw fetch в proxyHealth поймает MP-rate-limit «Too many same
      // requests, wait 3 seconds». Берём id_country, которые уже в workers,
      // объединяем с target/probe candidates, передаём как candidatesOverride.
      const workerCountries = workers
        .map((w) => Number(w.countryId))
        .filter((n) => Number.isFinite(n) && n > 0);
      const candidatesSet = new Set(workerCountries);
      for (const cid of probeOpts.targetCountryIds) {
        if (Number.isFinite(cid) && cid > 0) candidatesSet.add(cid);
      }
      for (const cid of probeOpts.excludeCountryIds) {
        candidatesSet.delete(cid);
      }
      const candidatesOverride = [...candidatesSet];
      log(
        `[pipe/preflight-probe] anti-cloak probe ${probeOpts.url} ` +
          `worker_countries=[${workerCountries.join(",")}] ` +
          `target={${probeOpts.targetCountryIds.join(",") || "—"}} ` +
          `exclude={${probeOpts.excludeCountryIds.join(",")}} → ` +
          `пробую [${candidatesOverride.join(",")}]`,
      );
      try {
        const r = await probeRecommendedCountriesCached({
          apiToken: MP_API_TOKEN,
          ...probeOpts,
          // Override: не вызывать get_my_proxy повторно (MP rate-limit 3с).
          candidatesOverride: candidatesOverride.length ? candidatesOverride : null,
          logger: log,
        });
        if (r.recommended.length > 0) {
          recommendedCountries = r.recommended;
          escapeFilters = {
            ...PDF_GEO_FILTERS,
            requireCountryIds: r.recommended.slice(),
            requireCountryId: null,
          };
          // Override geoFilters на каждом воркере — следующие changeGeo (из
          // preflight и из worker-loop'а) пойдут в recommended-страны.
          for (const w of workers) {
            if (w.downloader && typeof w.downloader.setGeoFilters === "function") {
              w.downloader.setGeoFilters(escapeFilters);
            }
          }
          log(
            `[pipe/preflight-probe] установил geoFilters.requireCountryIds=` +
              `[${r.recommended.join(",")}] для ${workers.length} воркеров`,
          );
        } else {
          log(
            `[pipe/preflight-probe] probe не нашёл recommended-стран — ` +
              `использую статичный bad-list fallback`,
          );
        }
      } catch (e) {
        log(
          `[pipe/preflight-probe] probe упал: ${e && e.message} — ` +
            `использую статичный bad-list fallback`,
        );
      }
    }
    await _preflightEscapeBadCountry({
      workers,
      log,
      shouldStop: () => false,
      recommendedCountries,
      escapeFilters,
    });
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
    // Jina v3 reranker tokenizer (см. pdf/jinaV3Tokens.js).
    // Считается в _processOne для каждого успешно извлечённого текста.
    // tokens_no_count — текст есть, но inference /count_tokens вернул null
    // (inference недоступен) → в БД tokens_jina_v3 = NULL, добивается backfill'ом.
    tokens_sum: 0,
    tokens_counted: 0,
    tokens_max: 0,
    tokens_max_id: null,
    tokens_no_count: 0,
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
  const singleWorker = workers.length === 1;
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
          singleWorker,
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
  if (counters.tokens_counted > 0 || counters.tokens_no_count > 0) {
    const avgTok = counters.tokens_counted > 0
      ? Math.round(counters.tokens_sum / counters.tokens_counted)
      : 0;
    log(
      `[pipe] tokens jina-v3: counted=${counters.tokens_counted} avg=${avgTok} ` +
        `max=${counters.tokens_max}` +
        (counters.tokens_max_id ? ` (id=${counters.tokens_max_id})` : "") +
        ` sum=${counters.tokens_sum} no_count=${counters.tokens_no_count}`,
    );
  }
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
  singleWorker = false,
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
  /**
   * Следующий шаг last-ditch recover при пороге 451: geo → changeGeo, ip → rotateIp.
   * ВАЖНО: для 451 первым ходим в changeGeo (а не в rotateIp), потому что
   * pravocaptcha банит IP+fingerprint, а rotateIp в пределах того же gateway
   * часто возвращает тот же IP — это «recover», который не recover. Сразу geo.
   * При BAD_GEO_RECOVERY_ENABLED действие игнорируется — fast-geo-loop сам всё рулит.
   */
  let next451RecoverAction = "geo";
  /**
   * Подряд событий pravocaptcha_gate без единого PDF OK за сессию воркера.
   * Если getSessionPdfSavedCount()===0 и счётчик ≥ 2 — текущий geo/IP считается
   * плохим и форсим changeGeo, не уходим по кругу defer и не ждём quarantine sleep.
   * Сбрасывается на любом не-pravocaptcha исходе, на PDF OK и после самой смены geo.
   */
  let consecutivePravocaptchaGate = 0;
  /**
   * Подряд неожиданных исключений в теле цикла (не штатный результат
   * downloadAndSave, а throw из claimNext / markPdfDownloaded / etc).
   * После порога считаем воркер сломанным и выходим — supervisor рестартанёт
   * весь пайплайн.
   */
  const WORKER_UNEXPECTED_FAIL_LIMIT = 5;
  let consecutiveUnexpectedFails = 0;
  /**
   * Trailing-window timestamps of slow-class recoverable events на этом
   * воркере (см. SLOW_TIMEOUT_THRESHOLD). При длине ≥ порога — changeGeo.
   */
  const slowEventTs = [];
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
      // Single-worker pre-first-PDF: пайплайн «не идёт», пока единственный
      // воркер в карантинном sleep. Bypass'им sleep и крутим recovery loop
      // с loopUntilSuccess=true. Если ок → markRecovered (cooldown снят),
      // продолжаем; если shouldStop пришёл во время recovery → выход.
      if (singleWorker && downloader.getSessionPdfSavedCount() === 0) {
        log(
          `[pdf/quarantine] proxy=${proxyTag} single-worker pre-first-OK — bypass sleep, recover-loop`,
        );
        const recovered = await _attempt451ProxyRecoverBeforeQuarantine({
          label,
          downloader,
          log,
          action: "geo",
          shouldStop,
          tryRotateFirst: true,
          loopUntilSuccess: true,
        });
        if (recovered) {
          counters.worker_restarts += 1;
          quarantine.markRecovered(proxyKey);
          consecutiveInfraFails = 0;
          notifyQuarantineStateChange();
          continue;
        }
        logWorkerEnd(`[${label}] стоп во время bypass recovery — выхожу`);
        return;
      }
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
        consecutivePravocaptchaGate = 0;
        log(
          `[pdf/defer] id=${act.id} reason=infra_${reason} worker=${label} next=batch_later`,
        );
        // До первого PDF OK за сессию воркера трактуем infra как bad-geo сигнал.
        // Probation-логика: сначала пробуем rotateIp×N в текущем geo (см.
        // _tryRotateInCurrentGeoFirst в downloader.js), и только если rotateIp
        // не дал probe ok — markBad + changeGeo. Для single-worker заворачиваем
        // в loopUntilSuccess: один-воркер пайплайн не может ждать, пока «другие»
        // воркеры разгребут, других нет — recovery должен сам найти живой geo.
        if (downloader.getSessionPdfSavedCount() === 0) {
          log(
            `[pdf/bad-geo] proxy=${proxyTag} reason=infra_${reason} no_pdf_yet=1 — recover (rotate-first)`,
          );
          // Pre-first-OK → loopUntilSuccess=true всегда (не только singleWorker):
          // по спеке «процесс должен продолжать искать живой вариант, а не
          // уходить в длинный quarantine sleep». В multi-worker этот воркер
          // будет крутить recover, остальные продолжают своё.
          const recovered = await _attemptProxyRecoverBeforeQuarantine({
            label,
            downloader,
            log,
            reason: `infra_${reason}_bad_geo`,
            shouldStop,
            tryRotateFirst: true,
            loopUntilSuccess: true,
          });
          if (recovered) {
            counters.worker_restarts += 1;
            consecutiveInfraFails = 0;
            skipQuarantineCheckOnce = true;
            if (quarantine && proxyKey) quarantine.markRecovered(proxyKey);
            continue;
          }
        }
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
            // для infra/туннеля чаще помогает). При BAD_GEO_RECOVERY_ENABLED —
            // быстрый changeGeo loop с blacklist (см. downloader._recoverByGeoLoop):
            // не ждём 5-10 мин quarantine, перебираем geo пока не найдём живой.
            // Single-worker → loopUntilSuccess: не уходим в sleep, других воркеров нет.
            // Pre-first-OK → tryRotateFirst: до markBad geo пробуем rotateIp+probe.
            const noPdfOkYet = downloader.getSessionPdfSavedCount() === 0;
            const recovered = await _attemptProxyRecoverBeforeQuarantine({
              label,
              downloader,
              log,
              reason: "infra",
              shouldStop,
              tryRotateFirst: noPdfOkYet,
              // Pre-first-OK или single-worker → не уходим в quarantine sleep.
              loopUntilSuccess: noPdfOkYet || singleWorker,
            });
            if (recovered) {
              counters.worker_restarts += 1;
              consecutiveInfraFails = 0;
              skipQuarantineCheckOnce = true;
              if (quarantine && proxyKey) quarantine.markRecovered(proxyKey);
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

        const noPdfOkInSession = downloader.getSessionPdfSavedCount() === 0;

        // pravocaptcha_gate без единого PDF OK — bad-geo сигнал. На втором
        // подряд событии форсим recover: пробуем сначала rotateIp×N в текущем
        // geo, потом changeGeo (см. downloader._recoverByGeoLoop). Если PDF OK
        // уже был — счётчик сбрасываем (gate скорее всего транзиентный).
        if (r.reason === "pravocaptcha_gate") {
          if (noPdfOkInSession) {
            consecutivePravocaptchaGate += 1;
            if (consecutivePravocaptchaGate >= PRAVOCAPTCHA_GATE_STREAK_THRESHOLD) {
              log(
                `[pdf/bad-geo] proxy=${proxyTag} reason=pravocaptcha_gate ` +
                  `streak=${consecutivePravocaptchaGate} no_pdf_yet=1 — recover (rotate-first)`,
              );
              const recovered = await _attemptProxyRecoverBeforeQuarantine({
                label,
                downloader,
                log,
                reason: "pravocaptcha_gate_bad_geo",
                shouldStop,
                tryRotateFirst: true,
                // Pre-first-OK → не уходим в quarantine sleep ни в каком случае.
                loopUntilSuccess: true,
              });
              consecutivePravocaptchaGate = 0;
              if (recovered) {
                counters.worker_restarts += 1;
                skipQuarantineCheckOnce = true;
                if (quarantine && proxyKey) quarantine.markRecovered(proxyKey);
                continue;
              }
            }
          } else {
            consecutivePravocaptchaGate = 0;
          }
        } else {
          consecutivePravocaptchaGate = 0;
        }

        // 451 без единого PDF OK — recover loop с rotate-first (по plan'у юзера:
        // pravocaptcha-fingerprint иногда отвязывается ВМЕСТЕ с IP в пределах
        // того же gateway; до markBad geo пробуем rotateIp+probe). Не ждём
        // quarantine threshold. Если recover удался — пропускаем запись в
        // реестр на этой итерации. Single-worker → loopUntilSuccess.
        if (
          quarantine &&
          proxyKey &&
          r.status === 451 &&
          noPdfOkInSession
        ) {
          log(
            `[pdf/bad-geo] proxy=${proxyTag} reason=451 no_pdf_yet=1 — recover (rotate-first)`,
          );
          const recovered = await _attempt451ProxyRecoverBeforeQuarantine({
            label,
            downloader,
            log,
            action: "geo",
            shouldStop,
            tryRotateFirst: true,
            // Pre-first-OK → не уходим в quarantine sleep ни в каком случае.
            loopUntilSuccess: true,
          });
          if (recovered) {
            counters.worker_restarts += 1;
            // next451RecoverAction оставляем "geo" — пока pre-first-OK
            // альтернация на rotateIp бессмысленна.
            skipQuarantineCheckOnce = true;
            if (quarantine && proxyKey) quarantine.markRecovered(proxyKey);
            continue;
          }
        }

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
            // Last-ditch recover ПЕРЕД sleep:
            // - BAD_GEO_RECOVERY_ENABLED: fast-geo-loop с blacklist + probe + rotate-first.
            //   До первого PDF OK rotateIp×N в текущем geo перед markBad+changeGeo
            //   (pravocaptcha-fingerprint иногда отвязывается с IP в том же gateway).
            //   После PDF OK rotateIp-first выключен (probation_clear=true).
            // - иначе: чередование geo/ip (legacy fallback).
            // Single-worker → loopUntilSuccess (нет смысла ждать «других» воркеров,
            // их нет — recovery loop сам найдёт живой geo).
            const action = noPdfOkInSession ? "geo" : next451RecoverAction;
            const recovered = await _attempt451ProxyRecoverBeforeQuarantine({
              label,
              downloader,
              log,
              action,
              shouldStop,
              tryRotateFirst: noPdfOkInSession,
              // Pre-first-OK или single-worker → не уходим в quarantine sleep.
              loopUntilSuccess: noPdfOkInSession || singleWorker,
            });
            if (recovered) {
              counters.worker_restarts += 1;
              if (!noPdfOkInSession) {
                next451RecoverAction =
                  next451RecoverAction === "geo" ? "ip" : "geo";
              }
              skipQuarantineCheckOnce = true;
              if (quarantine && proxyKey) quarantine.markRecovered(proxyKey);
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
        // По спеке пункт 7: до первого PDF OK триггеры вроде evaluate timeout,
        // ERR_HTTP2_*, execution context destroyed, chrome-error, empty
        // response — это bad-geo сигнал, а не «акт виноват». Вместо тихого
        // paceAfterFailure запускаем тот же recovery loop, что для 451/infra:
        // rotateIp×N в текущем geo, дальше changeGeo.
        const noPdfOkInSession = downloader.getSessionPdfSavedCount() === 0;
        if (
          noPdfOkInSession &&
          isProbationRotateFirstTrigger({
            status: r.status ?? null,
            error: r.error ?? null,
            reason: r.reason ?? null,
          })
        ) {
          // Возвращаем акт в общий пул — другой воркер может его подобрать,
          // пока этот крутит recover. (Если pool пустой / single-worker —
          // он же его потом и заберёт после recover.)
          try {
            source.deferAct(act);
          } catch (e) {
            log(`[${label}] deferAct: ${e}`);
          }
          counters.dl_deferred += 1;
          if (metrics) metrics.noteDeferred();
          log(
            `[pdf/bad-geo] proxy=${proxyTag} recoverable=${r.error ?? r.reason ?? "?"} ` +
              `status=${r.status ?? "?"} no_pdf_yet=1 — recover (rotate-first)`,
          );
          const recovered = await _attemptProxyRecoverBeforeQuarantine({
            label,
            downloader,
            log,
            reason: `recoverable_${String(r.reason ?? r.error ?? "trigger").slice(0, 40)}`,
            shouldStop,
            tryRotateFirst: true,
            loopUntilSuccess: true,
          });
          if (recovered) {
            counters.worker_restarts += 1;
            consecutiveInfraFails = 0;
            skipQuarantineCheckOnce = true;
            if (quarantine && proxyKey) quarantine.markRecovered(proxyKey);
          }
          continue;
        }
        // Slow-proxy detect (см. SLOW_TIMEOUT_THRESHOLD / SLOW_TIMEOUT_WINDOW_MS).
        // Probation выше уже отработал (либо noPdfOkInSession=false, либо триггер
        // другой). Здесь ловим тот же класс событий ВНЕ probation: evaluate
        // timeout / ERR_HTTP2 / ras-kad timeout. При пороге за окно — changeGeo
        // на этом воркере без cooldown, акт возвращаем в общий пул.
        if (
          SLOW_TIMEOUT_THRESHOLD > 0 &&
          isProbationRotateFirstTrigger({
            status: r.status ?? null,
            error: r.error ?? null,
            reason: r.reason ?? null,
          })
        ) {
          const now = Date.now();
          slowEventTs.push(now);
          while (
            slowEventTs.length > 0 &&
            now - slowEventTs[0] > SLOW_TIMEOUT_WINDOW_MS
          ) {
            slowEventTs.shift();
          }
          if (slowEventTs.length >= SLOW_TIMEOUT_THRESHOLD) {
            const cnt = slowEventTs.length;
            slowEventTs.length = 0;
            try {
              source.deferAct(act);
            } catch (e) {
              log(`[${label}] deferAct: ${e}`);
            }
            counters.dl_deferred += 1;
            if (metrics) metrics.noteDeferred();
            log(
              `[pdf/slow] proxy=${proxyTag} ${cnt} slow events in ${SLOW_TIMEOUT_WINDOW_MS}ms ` +
                `(last=${r.error ?? r.reason ?? "?"}) → changeGeo`,
            );
            const recovered = await _attemptProxyRecoverBeforeQuarantine({
              label,
              downloader,
              log,
              reason: `slow_${cnt}_events`,
              shouldStop,
              tryRotateFirst: false,
              loopUntilSuccess: false,
            });
            if (recovered) {
              counters.worker_restarts += 1;
              consecutiveInfraFails = 0;
            }
            continue;
          }
        }
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
    consecutivePravocaptchaGate = 0;
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
  // Подсчёт токенов через оба tokenizer'а (Jina v3 reranker + Jina v4 embed)
  // одним POST /count_tokens к inference. При недоступности inference оба
  // вернут null — pipeline не блокируется, NULL'ы добиваются backfill'ом.
  // tokens_jina_v3 → гейтинг по RERANKER_MAX_DOC_LENGTH.
  // token_count    → is_long_act и роутинг full_act / late_chunks.
  const { jinaV3: tokensJinaV3, jinaV4: tokensJinaV4 } = await countActTokens(r.text);
  if (tokensJinaV3 != null) {
    counters.tokens_sum += tokensJinaV3;
    counters.tokens_counted += 1;
    if (tokensJinaV3 > counters.tokens_max) {
      counters.tokens_max = tokensJinaV3;
      counters.tokens_max_id = id;
    }
    if (metrics) metrics.noteTokens(tokensJinaV3, id);
  } else {
    counters.tokens_no_count += 1;
    if (metrics) metrics.noteTokensMissing();
  }
  const markT0 = performance.now();
  try {
    await markTextExtracted(id, r.text, { tokensJinaV3, tokensJinaV4 });
    const markMs = performance.now() - markT0;
    counters.extracted += 1;
    if (metrics) metrics.noteExtractOk({ extractMs: exMs, markMs });
    const tokTag = tokensJinaV3 != null ? ` tok_v3=${tokensJinaV3}` : ` tok_v3=?`;
    const tokV4Tag = tokensJinaV4 != null ? ` tok_v4=${tokensJinaV4}` : ` tok_v4=?`;
    log(`[pipe/${who}] OK id=${id} bytes=${r.bytes}${tokTag}${tokV4Tag}`);
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
        const { jinaV3: tokensJinaV3, jinaV4: tokensJinaV4 } = await countActTokens(r.text);
        await markTextExtracted(row.id, r.text, { tokensJinaV3, tokensJinaV4 });
        const tokTag = tokensJinaV3 != null ? ` tok_v3=${tokensJinaV3}` : ` tok_v3=?`;
        const tokV4Tag = tokensJinaV4 != null ? ` tok_v4=${tokensJinaV4}` : ` tok_v4=?`;
        log(`[pipe/resume] id=${row.id} OK bytes=${r.bytes}${tokTag}${tokV4Tag}`);
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
