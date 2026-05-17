/**
 * pdf/downloader.js — последовательное скачивание PDF с kad.arbitr.ru.
 *
 * Стратегия (закреплена boundary-условиями RAS, не нашей фантазией):
 *
 *  1) ОДИН Chromium на весь прогон: launchPersistentContext с тем же
 *     fingerprint, что parser.js (locale, timezone, viewport,
 *     `network/rasBrowserProfile.js`: UA = версия из playwright-core,
 *     без лишней подмены sec-ch-ua, ignoreDefaultArgs --enable-automation,
 *     init-script webdriver). Это критично — на дефолтных опциях
 *     pravocaptcha срабатывает image-captcha с 3-мин cooldown на IP.
 *
 *  2) Сессионный прогрев (лёгкий): ras.arbitr.ru → kad.arbitr.ru/
 *     (куки/fingerprint для домена kad). Без захода на /Card/<caseId> —
 *     salto-fetch обычно достаточно общих kad-кук; Card на каждое дело
 *     резал скорость. При 429 / needsWarmup — повторяем этот же прогон.
 *
 *  3) Скачивание: после прогрева сессии опционально пробуем прямой HTTP GET
 *     (undici + куки контекста, RAS_PDF_HTTP_ENABLED=1); по умолчанию HTTP выкл —
 *     основной путь `page.evaluate(saltoFetchSource(), { url })` в Chromium.
 *     При HTML/salto/403/429 с HTTP — сразу fallback на salto.
 *
 *     Прямая навигация page.goto(pdfUrl) НЕ подходит: Chromium перехватывает
 *     PDF во встроенный viewer и `response.body()` для него недоступен.
 *
 *  4) Между скачиваниями пауза RAS_PDF_PAUSE_* (дефолт ужат; без паузы
 *     ddos-guard чаще даёт 429 — подкрути env если полезло).
 *
 *  5) При 429 / pravocaptcha-редиректе:
 *        - `retry: true`   → rotateIp() + снова ras→kad
 *        - `needsWarmup`   → снова ras→kad, без ротации IP
 *
 *  6) Лимит ретраев per-PDF: см. RAS_PDF_MAX_ATTEMPTS (по умолчанию 5).
 *
 * Headless vs headful:
 *   - parser.js по умолчанию headless=true. Для downloader'а это спорно:
 *     pravocaptcha проверяет canvas-fingerprint, и в headless новый chromium
 *     иногда срабатывает image-captcha (видели в проде). Поэтому здесь
 *     RAS_PDF_HEADLESS=0 по умолчанию — рассчитано на запуск под `xvfb-run`.
 *     Если конкретный прогон работает в headless OK — выставь =1 в .env.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { fetch, ProxyAgent } from "undici";
import { chromium } from "playwright";

import {
  MP_API_TOKEN,
  MP_PROXY_KEY,
  MP_PROXY_ID,
  PROXY_PASS,
  PROXY_SERVER,
  PROXY_USER,
  CHANGE_IP_COOLDOWN_SEC,
  ESC_EQUIPMENT_COOLDOWN_SEC,
  CHANGE_GEO_COOLDOWN_SEC,
  PDF_AUTO_BUY_DEFAULT_COUNTRY_ID,
  PDF_GEO_FILTERS,
  PDF_POOL_COUNTRY_IDS,
  PDF_TARGET_COUNTRY_IDS,
  PDF_TARGET_COUNTRY_IDS_SOURCE,
} from "../network/config.js";
import { ESC_LEVELS, ProxyEscalator } from "../network/escalator.js";
import { RasProxyClient } from "../network/proxyClient.js";
import { saltoFetchSource } from "../network/saltoDecoder.js";
import {
  autoBuyProxies,
  discoverProxies,
  inferCountryIdFromExisting,
  readAllowedKeysFromEnv,
  readAutoBuyConfigFromEnv,
  singleProxyFromEnv,
} from "../network/proxyPool.js";
import {
  acquireMany as _leaseAcquireMany,
  makeHolderId as _leaseMakeHolderId,
  releaseDeadLocalLeases as _leaseReleaseDeadLocal,
  releaseExpiredGlobalLeases as _leaseReleaseExpiredGlobal,
  __test__ as _leaseInternals,
} from "../db/proxyLeases.js";
const { maskHolder: _leaseMaskHolder } = _leaseInternals;
import {
  attachRasAntiDetectToContext,
  buildRasBrowserFingerprint,
  getRasChromiumLaunchAntiDetect,
  resetRasBrowserFingerprintCache,
} from "../network/rasBrowserProfile.js";
import { fetchKadPdfViaHttp, withPdfHttpConcurrency, _resetHttpPdfSemaphoreForTest } from "./httpPdfFetch.js";
import {
  shouldBlockThirdPartyAnalyticsUrl,
  shouldLogPdfPageRequestFailed,
} from "./requestRouting.js";
import { BadGeoBlacklist } from "./badGeoBlacklist.js";

const PDF_PAUSE_MIN_MS = Number(process.env.RAS_PDF_PAUSE_MIN_MS ?? 220);
const PDF_PAUSE_MAX_MS = Number(process.env.RAS_PDF_PAUSE_MAX_MS ?? 520);
/** Короткая пауза между актами после неуспешного download (pipeline). */
const PDF_PAUSE_FAIL_MIN_MS = Math.max(
  0,
  Number(process.env.RAS_PDF_PAUSE_FAIL_MIN_MS ?? 90),
);
const PDF_PAUSE_FAIL_MAX_MS = Math.max(
  PDF_PAUSE_FAIL_MIN_MS,
  Number(process.env.RAS_PDF_PAUSE_FAIL_MAX_MS ?? 200),
);
/**
 * Сколько ждать ПОСЛЕ goto на /Card до первого fetch /Document/Pdf.
 * pravocaptcha-JS делает background challenge (canvas-fingerprint, MD5-trial,
 * cookie set) после DOMContentLoaded — на `waitUntil:"domcontentloaded"` JS
 * ещё не отработал. Без этой паузы fetch ловит tokenFrom-страницу даже
 * после rotateIp+clearCookies.
 */
const PDF_PRAVO_WAIT_MS = Number(process.env.RAS_PDF_PRAVO_WAIT_MS ?? 4200);
/**
 * После /Card, если дальше идёт thaw по pdfUrl, достаточно короче: основной
 * challenge всё равно отрабатывает на goto(pdfUrl). Снижает простой на
 * смене дела при том же числе IP.
 */
const PDF_PRAVO_AFTER_CARD_MS = Math.max(
  0,
  Number(process.env.RAS_PDF_PRAVO_AFTER_CARD_MS ?? 2600),
);
const PDF_MAX_ATTEMPTS = Math.max(1, Number(process.env.RAS_PDF_MAX_ATTEMPTS ?? 6));
/**
 * PDF-специфичные пороги эскалатора. Глобальные ESC_MAX_* (для парсера
 * метаданных) держим повыше: там много дешёвых ретраев и менять оператора
 * нет смысла на каждом 451. У качалки PDF другая экономика — 451 «жёсткий»
 * (pravocaptcha залочила IP+fingerprint), changeIp в пределах того же
 * gateway часто не помогает, а cooldowns стоят оплаченного времени.
 * Поэтому идём агрессивнее: 1 changeIp → 1 changeOperator → changeGeo.
 * С PDF_MAX_ATTEMPTS=6 это гарантирует, что в рамках одного PDF мы доберёмся
 * до changeGeo, а не сгораем на двух cooldowns на горящем IP.
 */
const PDF_ESC_MAX_IP_BEFORE_EQUIPMENT = Math.max(
  1,
  Number(process.env.RAS_PDF_ESC_MAX_IP_BEFORE_EQUIPMENT ?? 1),
);
const PDF_ESC_MAX_OPERATOR_BEFORE_GEO = Math.max(
  0,
  Number(process.env.RAS_PDF_ESC_MAX_OPERATOR_BEFORE_GEO ?? 1),
);
/**
 * Если воркер подряд завалил >= N PDF — на следующем 451 форсим L3 (changeGeo).
 * Сигнал «этот gateway/оператор полностью сожжён, IP-ротация по нему бесполезна».
 * 0 = выключено.
 */
const PDF_FORCE_GEO_AFTER_FAILS = Math.max(
  0,
  Number(process.env.RAS_PDF_FORCE_GEO_AFTER_FAILS ?? 2),
);
const PDF_HEADLESS = (process.env.RAS_PDF_HEADLESS ?? "0") === "1";
/**
 * После первого успешного PDF в сессии pravocaptcha-куки уже в context'е —
 * пропускаем Card+thaw на следующих актах, делаем сразу salto-fetch. Экономит
 * ~13с фикс-стоимости на каждый акт. Salto-decoder вернёт retry/needsWarmup
 * при редком редиректе на капчу, тогда полный warmup делается ровно один раз.
 * 0 → старое поведение (full warmup на каждый акт).
 */
const PDF_FAST_AFTER_FIRST_SUCCESS =
  (process.env.RAS_PDF_FAST_AFTER_FIRST_SUCCESS ?? "1") !== "0";
const WARMUP_NAV_TIMEOUT_MS = Number(process.env.RAS_PDF_WARMUP_TIMEOUT_MS ?? 25_000);
const FETCH_EVAL_TIMEOUT_MS = Number(process.env.RAS_PDF_FETCH_TIMEOUT_MS ?? 45_000);
/** 429 без RasProxyClient — ждём перед повтором (мс). */
const PDF_RL_NO_PROXY_SLEEP_MS = Number(process.env.RAS_PDF_RL_NO_PROXY_SLEEP_MS ?? 25_000);
/** 1 = лог разбивки времени на PDF (warmup / evaluate+fetch / write + kbps). */
const PDF_TIMING = (process.env.RAS_PDF_TIMING ?? "0") === "1";
/** Проверка egress после changeOperator (undici через тот же proxy, что Chromium). */
const PDF_EGRESS_PROBE_URL = String(
  process.env.RAS_PDF_EGRESS_PROBE_URL ?? "https://api.ipify.org?format=json",
).trim();
const PDF_EGRESS_PROBE_TIMEOUT_MS = Math.max(
  2000,
  Math.min(20_000, Number(process.env.RAS_PDF_EGRESS_PROBE_TIMEOUT_MS ?? 8000) || 8000),
);

/**
 * Fast bad-geo recovery (см. pdf/badGeoBlacklist.js + _recoverByGeoLoop):
 * вместо долгого quarantine sleep на 5-10 мин — быстро перебираем geo через
 * changeGeo (бесплатно у MobileProxy), пока не найдём живой. Каждый сожжённый
 * geo попадает в in-memory blacklist на RAS_PDF_BAD_GEO_COOLDOWN_MS, чтобы
 * recovery не возвращался в него повторно.
 *
 * RAS_PDF_BAD_GEO_RECOVERY=1 (default 1) — включён.
 *   =0 → старое поведение: rotateIp/escalator + quarantine sleep.
 * RAS_PDF_SAME_IP_ROTATE_ATTEMPTS — rotateIp после same-IP changeGeo (деф. 3).
 * RAS_PDF_ROTATE_IP_SLEEP_MS — пауза между такими rotateIp (деф. 4000).
 * RAS_PDF_GEO_CHECK_TIMEOUT_MS — опрос egress после changeGeo (деф. 120000).
 */
const PDF_BAD_GEO_RECOVERY_ENABLED =
  String(process.env.RAS_PDF_BAD_GEO_RECOVERY ?? "1").trim() !== "0";
/** Probation timeout: после changeGeo даём этому geo ровно столько мс на первый PDF OK. */
const PDF_GEO_CHECK_TIMEOUT_MS = Math.max(
  30_000,
  Number(process.env.RAS_PDF_GEO_CHECK_TIMEOUT_MS ?? 120_000),
);
/** Сколько раз подряд пробуем changeGeo, прежде чем сделать «exhausted pause». */
const PDF_RECOVER_MAX_ROUNDS = Math.max(
  1,
  Number(process.env.RAS_PDF_RECOVER_MAX_ROUNDS ?? 50),
);
/** Маленькая пауза между changeGeo чтобы не упереться в MP rate limit. */
const PDF_RECOVER_BETWEEN_MS_MIN = Math.max(
  0,
  Number(process.env.RAS_PDF_RECOVER_BETWEEN_MS_MIN ?? 3000),
);
const PDF_RECOVER_BETWEEN_MS_MAX = Math.max(
  PDF_RECOVER_BETWEEN_MS_MIN,
  Number(process.env.RAS_PDF_RECOVER_BETWEEN_MS_MAX ?? 5000),
);
/** После changeGeo с тем же checked IP — rotateIp в том же geo перед blacklist. */
const PDF_SAME_IP_ROTATE_ATTEMPTS = Math.max(
  1,
  Number(process.env.RAS_PDF_SAME_IP_ROTATE_ATTEMPTS ?? 3),
);
/** Пауза между rotateIp при same-IP recovery (мс). */
const PDF_ROTATE_IP_SLEEP_MS = Math.max(
  1000,
  Number(process.env.RAS_PDF_ROTATE_IP_SLEEP_MS ?? 4000) || 4000,
);
/** Интервал опроса egress после changeGeo (мс). */
const PDF_RECOVER_GEO_IP_POLL_MS = Math.max(
  2000,
  Math.min(15_000, Number(process.env.RAS_PDF_RECOVER_GEO_IP_POLL_MS ?? 5000) || 5000),
);
/** Если все RAS_PDF_RECOVER_MAX_ROUNDS подряд плохие — пауза, не fatal. */
const PDF_RECOVER_EXHAUSTED_PAUSE_MS = Math.max(
  0,
  Number(process.env.RAS_PDF_RECOVER_EXHAUSTED_PAUSE_MS ?? 120_000),
);

/**
 * Лёгкий HTTP probe ras.arbitr.ru/ + kad.arbitr.ru/ через текущий прокси —
 * выполняется после каждой смены IP (rotateIp / changeGeo) ДО запуска Chromium.
 * Если probe плохой (451, ERR, timeout, empty, tokenFrom/pravocaptcha/ddos-guard),
 * сразу markBad IP/geo/operator и идём дальше — не платим warmup впустую.
 *
 * RAS_PDF_PROBE_ENABLED=1 (default 1) — включён.
 *   =0 → отключить (только smoke-тесты или диагностика).
 * RAS_PDF_PROBE_TIMEOUT_MS — таймаут одного GET (default 8000).
 */
const PDF_PROBE_ENABLED =
  String(process.env.RAS_PDF_PROBE_ENABLED ?? "1").trim() !== "0";
const PDF_PROBE_TIMEOUT_MS = Math.max(
  2000,
  Math.min(30_000, Number(process.env.RAS_PDF_PROBE_TIMEOUT_MS ?? 8000) || 8000),
);
/**
 * Минимальная длина body, ниже которой считаем probe плохим (короткий ответ =
 * редирект на капчу / 451-stub / battle.html). У ras.arbitr.ru/ и kad.arbitr.ru/
 * нормальный body — десятки килобайт.
 */
const PDF_PROBE_MIN_BODY = Math.max(
  100,
  Number(process.env.RAS_PDF_PROBE_MIN_BODY ?? 500) || 500,
);
/**
 * Regex для детекта «страница блока» в теле ответа. Cover: pravocaptcha tokenFrom,
 * ddos-guard, cloudflare. Custom regex через RAS_PDF_PROBE_BLOCK_REGEX (case-insensitive).
 */
const PDF_PROBE_BLOCK_REGEX = (() => {
  const src =
    process.env.RAS_PDF_PROBE_BLOCK_REGEX ??
    "tokenFrom|pravocaptcha|ddos-?guard|Just a moment|Attention Required|cf-browser-verification";
  try {
    return new RegExp(src, "i");
  } catch {
    return /tokenFrom|pravocaptcha|ddos-?guard/i;
  }
})();

/** Явно RAS_PDF_HTTP_ENABLED=1|true|on|yes — иначе только salto в Chromium. */
function _parsePdfHttpEnvExplicitOn() {
  const v = String(
    process.env.RAS_PDF_HTTP_ENABLED ?? process.env.RAS_PDF_HTTP ?? process.env.PDF_HTTP_ENABLED ?? "0",
  )
    .trim()
    .toLowerCase();
  return v === "1" || v === "true" || v === "on" || v === "yes";
}
const PDF_HTTP_ENV_EXPLICIT_ON = _parsePdfHttpEnvExplicitOn();

let _pdfHttpAutoDisabled = false;
let _pdfHttpAutoDiagAttempts = 0;
let _pdfHttpAutoDiagOk = 0;

const _pdfAggStats = {
  totalOk: 0,
  httpOk: 0,
  playwrightOk: 0,
  httpAttempts: 0,
  httpFail: 0,
};

function isPdfHttpFirstEnabled() {
  return PDF_HTTP_ENV_EXPLICIT_ON && !_pdfHttpAutoDisabled;
}

function _afterSingleHttpOutcome(httpOk, logFn) {
  if (!PDF_HTTP_ENV_EXPLICIT_ON || _pdfHttpAutoDisabled) return;
  _pdfHttpAutoDiagAttempts += 1;
  if (httpOk) _pdfHttpAutoDiagOk += 1;
  if (_pdfHttpAutoDiagAttempts === 20) {
    const ok = _pdfHttpAutoDiagOk;
    const fail = 20 - ok;
    const hr = ok / 20;
    if (ok === 0 || hr < 0.1) {
      _pdfHttpAutoDisabled = true;
      logFn(
        `[pdf/http] auto-disabled reason=low_hit_rate attempts=20 ok=${ok} fallback=${fail} hit_rate=${hr.toFixed(3)}`,
      );
    }
  }
}

/**
 * Итоговые счётчики по процессу (все PdfDownloader). Вызывать при shutdown пайплайна.
 * @param {(m: string) => void} logFn
 */
export function logPdfDownloadAggregateStats(logFn) {
  const a = _pdfAggStats.httpAttempts;
  const hr = a > 0 ? (_pdfAggStats.httpOk / a).toFixed(3) : "n/a";
  logFn(
    `[pdf/stats] total=${_pdfAggStats.totalOk} http_ok=${_pdfAggStats.httpOk} ` +
      `http_fallback=${_pdfAggStats.httpFail} playwright_ok=${_pdfAggStats.playwrightOk} ` +
      `http_hit_rate=${hr}`,
  );
}

function _resetPdfAggStatsForTest() {
  _pdfAggStats.totalOk = 0;
  _pdfAggStats.httpOk = 0;
  _pdfAggStats.playwrightOk = 0;
  _pdfAggStats.httpAttempts = 0;
  _pdfAggStats.httpFail = 0;
  _pdfHttpAutoDisabled = false;
  _pdfHttpAutoDiagAttempts = 0;
  _pdfHttpAutoDiagOk = 0;
}

const PDF_HTTP_MAX_ATTEMPTS = Math.max(
  1,
  Number(
    process.env.RAS_PDF_HTTP_MAX_ATTEMPTS ??
      process.env.PDF_HTTP_MAX_ATTEMPTS ??
      process.env.HTTP_RETRIES ??
      3,
  ),
);
const PDF_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Math.min(
    120_000,
    Number(
      process.env.RAS_PDF_HTTP_TIMEOUT_MS ??
        process.env.PDF_HTTP_TIMEOUT_MS ??
        process.env.HTTP_TIMEOUT_MS ??
        7000,
    ),
  ),
);

const RAS_HOME = "https://ras.arbitr.ru/";
const KAD_HOME = "https://kad.arbitr.ru/";
const KAD_CARD = (caseId) => `https://kad.arbitr.ru/Card/${encodeURIComponent(caseId)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** [YYYY-MM-DD HH:MM:SS.mmm] для дефолтных fallback-логеров (только когда caller не передал свой). */
function _dlTs() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  );
}

/**
 * Жёсткая проверка «строка похожа на IPv4». Отсекает HTML/error pages
 * (`<html>...`), JSON-объекты (`{...}`), пустые/null, IPv6 (`::1`),
 * нечисловые мусор. По спеке: «если IP невалидный, пустой, html, null или
 * ошибка, повторить измерение несколько раз».
 *
 * IPv6 умышленно не валидируем как «валидный» — RAS/ipify через MobileProxy
 * всегда отдаёт IPv4; IPv6-ответ = аномалия, лучше повторить.
 *
 * @param {unknown} v
 * @returns {boolean}
 */
function _isValidIpv4(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(s)) return false;
  for (const oct of s.split(".")) {
    const n = Number(oct);
    if (!Number.isInteger(n) || n < 0 || n > 255) return false;
  }
  return true;
}

function _randomPause() {
  const lo = Math.max(0, PDF_PAUSE_MIN_MS);
  const hi = Math.max(lo, PDF_PAUSE_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _randomFailPause() {
  const lo = PDF_PAUSE_FAIL_MIN_MS;
  const hi = Math.max(lo, PDF_PAUSE_FAIL_MAX_MS);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function _recoverPauseRandom() {
  const lo = PDF_RECOVER_BETWEEN_MS_MIN;
  const hi = Math.max(lo, PDF_RECOVER_BETWEEN_MS_MAX);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

/**
 * Прерываемый sleep для recover-loop (shouldStop из pipeline).
 * @param {number} totalMs
 * @param {(() => boolean) | undefined} shouldStop
 */
async function _recoverSleep(totalMs, shouldStop) {
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
 * Ответ changeEquipment/changeGeo: `checked[proxy_id] === false` означает, что
 * провайдер сделал смену, но проверка после неё не прошла. Дублируем мини-хелпер
 * из pipeline.js/proxyClient.js чтобы не делать circular import.
 *
 * @param {{ raw?: any, task?: any } | null | undefined} r
 * @param {number|string|null|undefined} proxyId
 */
function _checkedFalseForProxy(r, proxyId) {
  if (proxyId === null || proxyId === undefined) return false;
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

/** @param {string} server @param {string} user @param {string} pass */
function _pdfProxyUri(server, user, pass) {
  const u = new URL(server);
  if (user) u.username = encodeURIComponent(user);
  if (pass) u.password = encodeURIComponent(pass);
  return u.toString();
}

function _detectChromiumExecutable() {
  // Та же логика, что в parser.js — берём самый свежий chromium-* бинарь.
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  let entries;
  try {
    entries = fs.readdirSync(cache);
  } catch {
    return null;
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith("chromium-")) continue;
    const suffix = name.slice("chromium-".length);
    if (!/^\d+$/.test(suffix)) continue;
    const exe = path.join(cache, name, "chrome-linux64", "chrome");
    try {
      if (fs.statSync(exe).isFile()) candidates.push([parseInt(suffix, 10), exe]);
    } catch {}
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b[0] - a[0]);
  return candidates[0][1];
}

/**
 * Второй 451 на том же акте после успешного rewarmup — defer, без L2/L3.
 * @param {number|null|undefined} lastStatus
 * @param {boolean} recoveryOk
 */
export function _repeat451DeferAfterRecovery(lastStatus, recoveryOk) {
  return lastStatus === 451 && recoveryOk === true;
}

/**
 * Классификатор «recovery-триггера» для логики «до первого PDF OK сначала
 * rotateIp×N, потом changeGeo». По plan'у: 451, pravocaptcha_gate, infra,
 * evaluate timeout, ras/kad timeout, ERR_HTTP_*, ERR_TUNNEL_*, ERR_HTTP2_*,
 * Execution context destroyed, chrome-error — все триггерят rotateIp-first
 * на probation. Чистый 451 семантически про «geo бан», но и его пробуем
 * rotateIp'ом (по plan'у user'а): pravocaptcha-fingerprint иногда отвязывается
 * вместе с IP в пределах того же gateway.
 *
 * @param {{ status?: number|null, error?: string|null, reason?: string|null }} input
 * @returns {boolean} true → стоит пробовать rotateIp до markBad geo
 */
export function isProbationRotateFirstTrigger({ status = null, error = null, reason = null } = {}) {
  if (status === 451) return true;
  const haystack = `${reason ?? ""} ${error ?? ""}`.toLowerCase();
  if (!haystack.trim()) return false;
  return (
    haystack.includes("pravocaptcha_gate") ||
    haystack.includes("pravocaptcha gate") ||
    haystack.includes("proxy_tunnel_failed") ||
    haystack.includes("warmup_failed") ||
    haystack.includes("evaluate timeout") ||
    /timeout.*navigating to/i.test(haystack) ||
    haystack.includes("err_tunnel_connection_failed") ||
    haystack.includes("err_proxy_connection_failed") ||
    haystack.includes("err_http_response_code_failure") ||
    haystack.includes("err_http2_protocol_error") ||
    haystack.includes("err_empty_response") ||
    haystack.includes("err_connection_reset") ||
    haystack.includes("err_connection_closed") ||
    haystack.includes("err_timed_out") ||
    haystack.includes("execution context was destroyed") ||
    haystack.includes("chrome-error")
  );
}

/**
 * Классификатор инфраструктурных ошибок: туннель прокси / сессия kad /
 * warmup-навигация. Не связаны с конкретным актом — акт надо deferAct,
 * а не markPdfFailed.
 *
 * @param {string|null|undefined} message
 * @returns {{ infra: true, reason: "proxy_tunnel_failed" | "warmup_failed" } | null}
 */
export function classifyPdfInfraError(message) {
  if (message == null) return null;
  const s = String(message);
  if (!s) return null;
  if (
    /ERR_TUNNEL_CONNECTION_FAILED/i.test(s) ||
    /ERR_PROXY_CONNECTION_FAILED/i.test(s) ||
    /ERR_CONNECTION_RESET/i.test(s) ||
    /ERR_CONNECTION_CLOSED/i.test(s) ||
    /ERR_TIMED_OUT/i.test(s)
  ) {
    return { infra: true, reason: "proxy_tunnel_failed" };
  }
  if (
    /Timeout.*navigating to "https?:\/\/ras\.arbitr\.ru\//i.test(s) ||
    /Timeout.*navigating to "https?:\/\/kad\.arbitr\.ru\//i.test(s) ||
    /kad session failed/i.test(s) ||
    /has been closed/i.test(s)
  ) {
    return { infra: true, reason: "warmup_failed" };
  }
  return null;
}

/**
 * Сформировать `downloadAndSave` failure-shape для отказа warmup/сессии.
 * Любая ошибка `ensureKadSession` — это инфраструктура (прокси/таймаут), не
 * проблема акта. Конкретный `reason` берётся из классификатора, иначе fallback
 * на "warmup_failed".
 *
 * @param {string} underlyingMessage
 * @returns {{ ok: false, recoverable: true, deferred: true, infra: true, reason: string, error: string }}
 */
/**
 * Извлечь candidate metadata из ответа proxyClient.changeGeo при ok:false.
 * Возвращает `{ geoid, operator, ip }` либо `null`, если ничего полезного нет.
 * Чистая функция — без сайд-эффектов, проще тестировать.
 *
 * @param {object|null|undefined} r ответ proxyClient.changeGeo
 * @returns {{ geoid: number|null, operator: string|null, ip: string|null } | null}
 */
export function _extractFailedChangeGeoCandidate(r) {
  if (!r || typeof r !== "object") return null;
  const geoid =
    r.geoid ?? r.geoId ?? r.candidate?.geoid ?? r.candidate?.geoId ?? null;
  const operator =
    r.operator ?? r.candidate?.operator ?? r.candidate?.operatorName ?? null;
  const ip = r.ip ?? r.newIp ?? r.checkedIp ?? r.candidate?.ip ?? null;
  if (geoid == null && !operator && !ip) return null;
  return {
    geoid: geoid != null ? geoid : null,
    operator: operator || null,
    ip: ip || null,
  };
}

/**
 * Распознать «временную» MobileProxy-ошибку (equipment busy / unavailable):
 * это API-уровень провайдера, не RAS/KAD ban. В таких случаях оператор НЕ
 * виноват — занят конкретный eid на этом geo. Помечаем geoid+ip, оператор
 * оставляем чистым, чтобы потом ещё попробовать его в другом geo.
 */
export function _isEquipmentBusyReason(failReason) {
  const s = String(failReason ?? "").toLowerCase();
  if (!s) return false;
  if (s.startsWith("equipment_busy")) return true;
  if (s.includes("equipment busy")) return true;
  if (s.includes("busy or unavailable")) return true;
  if (s.includes("equipment unavailable")) return true;
  // Узкий случай: текстовое «unavailable» в MobileProxy error — тоже busy.
  if (s.includes(":unavailable") || /\bunavailable\b/.test(s)) return true;
  return false;
}

/**
 * markBad на сожжённого changeGeo candidate'а из !r.ok ветки recovery.
 * Для `equipment_busy` блочим только geoid+ip (operator не виноват), для
 * RAS/KAD-ошибок — geoid+operator+ip.
 *
 * @param {object} blacklist BadGeoBlacklist
 * @param {object} r ответ proxyClient.changeGeo (ok:false)
 * @param {string} failReason для записи в blacklist.reason
 * @returns {{ marked: boolean, geoid: number|null, operator: string|null, ip: string|null,
 *             operatorBlacklisted: boolean, equipmentBusy: boolean }}
 */
export function _markFailedChangeGeoCandidateBad(blacklist, r, failReason) {
  const cand = _extractFailedChangeGeoCandidate(r);
  const equipmentBusy = _isEquipmentBusyReason(failReason);
  if (!blacklist || !cand) {
    return {
      marked: false,
      geoid: null,
      operator: null,
      ip: null,
      operatorBlacklisted: false,
      equipmentBusy,
    };
  }
  // Operator целиком в blacklist больше НЕ кладём — у MP только 4 оператора в
  // нашем target-пуле (kcell/tele2 KZ, mts/A1 BY), и одно «kcell(KZ) bad» режет
  // ВСЕ KZ-kcell гео сразу. После 4 фейлов pool=0. Достаточно geo+ip:
  // конкретный geoid выдал плохой IP — пометим этот geoid; следующий
  // changeGeo выберет другой geoid с тем же оператором, и если он тоже умрёт —
  // пометим уже его. Локализация на geoid, а не на operator.
  blacklist.markBad({
    geoid: cand.geoid,
    // operator: namesake — намеренно не блэклистим
    ip: cand.ip,
    reason: `changeGeo_failed:${String(failReason ?? "unknown").slice(0, 120)}`,
  });
  return {
    marked: true,
    geoid: cand.geoid,
    operator: cand.operator,
    ip: cand.ip,
    operatorBlacklisted: false,
    equipmentBusy,
  };
}

export function buildKadSessionFailedReturn(underlyingMessage) {
  const msg = underlyingMessage == null ? "" : String(underlyingMessage);
  const classified = classifyPdfInfraError(msg);
  return {
    ok: false,
    recoverable: true,
    deferred: true,
    infra: true,
    reason: classified?.reason ?? "warmup_failed",
    error: `kad session failed: ${msg}`,
  };
}

export class PdfDownloader {
  /**
   * @param {{
   *   workDir: string,                     // куда писать .pdf
   *   logger?: (msg: string) => void,
   *   proxyClient?: RasProxyClient | null, // если null — без ротации IP при 429
   *   proxyServer?: string | null,         // "http://host:port"; null = без прокси
   *   proxyUser?: string,
   *   proxyPass?: string,
   *   label?: string,                      // префикс для логов ([pdf/w1] и т.п.)
   * }} opts
   */
  constructor({
    workDir,
    logger,
    proxyClient,
    proxyServer = PROXY_SERVER,
    proxyUser = PROXY_USER,
    proxyPass = PROXY_PASS,
    label = "pdf",
    badGeoBlacklist = null,
  }) {
    if (!workDir) throw new Error("PdfDownloader: workDir is required");
    this.workDir = workDir;
    this.label = label;
    const baseLog = logger ?? ((m) => process.stdout.write(`[${_dlTs()}] ${m}\n`));
    this.log = (m) => baseLog(`[${label}] ${m}`);
    this.proxyClient = proxyClient ?? null;
    this.proxyServer = proxyServer || null;
    this.proxyUser = proxyUser ?? "";
    this.proxyPass = proxyPass ?? "";
    this._badGeoBlacklist = badGeoBlacklist ?? null;
    /** @type {boolean} true сразу после changeGeo — пока не получим первый PDF OK. */
    this._geoProbation = false;
    /** @type {number} performance.now() аналог: Date.now() начала probation. */
    this._geoProbationStartedAt = 0;
    /** @type {{ geoid: number|null, operator: string|null, ip: string|null }} */
    this._currentGeoSig = { geoid: null, operator: null, ip: null };
    /**
     * Сколько rotateIp подряд сделали в текущем geo без первого PDF OK.
     * Bounded на PDF_SAME_IP_ROTATE_ATTEMPTS — после порога recovery переходит
     * к changeGeo (markBad geoid+operator). Сбрасывается на:
     *   - successful changeGeo (новое geo → счётчик с нуля)
     *   - первый PDF OK (`_clearGeoProbationOnSuccess`)
     */
    this._rotateAttemptsInCurrentGeo = 0;
    // Эскалатор: changeIp×N → changeOperator×M → changeGeo (бесконечный круг).
    // Без него на «горящих» IP мы вечно крутим только rotateIp в одном и
    // том же proxy_key и сжигаем ретраи, не выбираясь из бана.
    this._escalator = this.proxyClient
      ? new ProxyEscalator({
          proxyClient: this.proxyClient,
          logger: (m) => this.log(m),
          maxIpRotationsBeforeEquipment: PDF_ESC_MAX_IP_BEFORE_EQUIPMENT,
          maxOperatorSwapsBeforeGeo: PDF_ESC_MAX_OPERATOR_BEFORE_GEO,
          geoFilters: PDF_GEO_FILTERS,
        })
      : null;
    if (this._escalator) {
      const poolLog = PDF_POOL_COUNTRY_IDS.length
        ? PDF_POOL_COUNTRY_IDS.join(",")
        : "all";
      const geoLog = PDF_TARGET_COUNTRY_IDS.length
        ? PDF_TARGET_COUNTRY_IDS.join(",")
        : "any";
      this.log(
        `[pdf/escalator] PDF-defaults: maxIp=${PDF_ESC_MAX_IP_BEFORE_EQUIPMENT}, ` +
          `maxOp=${PDF_ESC_MAX_OPERATOR_BEFORE_GEO}, ` +
          `forceGeoAfterFails=${PDF_FORCE_GEO_AFTER_FAILS || "off"}, ` +
          `pool=id_country=[${poolLog}] changeGeo=target=[${geoLog}] ` +
          `source=${PDF_TARGET_COUNTRY_IDS_SOURCE}`,
      );
    }

    this._context = null;
    this._userDataDir = null;
    this._page = null;
    /** @type {boolean} ras→kad уже прогрели в этом контексте. */
    this._kadSessionReady = false;
    /** @type {string|null} последний caseId, на который мы заходили в /Card/<...>. */
    this._kadCardCaseId = null;
    /**
     * @type {boolean} Включается ПОСЛЕ первого успешного PDF в сессии.
     * Пока true — ensureKadSession скипает Card+thaw на новых caseId. Сбрасывается
     * на ЛЮБОЙ retry/needsWarmup из salto-fetch (один раз тяжёлый warmup → опять
     * fast-path). Сбрасывается также на restart/_recyclePdfSurface/clearCookies.
     */
    this._fastWarmupOk = false;
    /** @type {number} сколько PDF реально записано на диск за жизнь этого экземпляра (сессия Chromium). */
    this._sessionPdfSaved = 0;
    /** @type {number} монотонный счётчик подряд успешных PDF — для метрик. */
    this._consecutiveOk = 0;
    /** @type {number} счётчик ПОДРЯД проваленных PDF — для force-geo триггера. */
    this._consecutiveFails = 0;
    /** >0 пока идёт ensureKadSession — не шумим requestfailed (Card/thaw abort и т.п.). */
    this._kadWarmupSuppressRequestfailed = 0;
  }

  // ───────────────────────── жизненный цикл ─────────────────────────

  async init() {
    if (this._context) return;
    fs.mkdirSync(this.workDir, { recursive: true });

    this._userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), `ras_pdf_chromium_${this.label.replace(/[^a-z0-9]/gi, "_")}_`),
    );
    const exe = process.env.RAS_CHROME || _detectChromiumExecutable();
    const rasFp = buildRasBrowserFingerprint();
    const anti = getRasChromiumLaunchAntiDetect();

    this.log(
      `[pdf/browser] launch chromium (headless=${PDF_HEADLESS}, proxy=${this.proxyServer ?? "none"}, exe=${exe ?? "default"}, ` +
        `chrome=${rasFp.chromeFullVersion}, viewport=${rasFp.viewport.width}x${rasFp.viewport.height}, ` +
        `fp_seed=${rasFp.canvasNoiseSeed})`,
    );

    this._context = await chromium.launchPersistentContext(this._userDataDir, {
      headless: PDF_HEADLESS,
      locale: rasFp.locale,
      timezoneId: rasFp.timezoneId,
      userAgent: rasFp.userAgent,
      viewport: rasFp.viewport,
      extraHTTPHeaders: rasFp.extraHTTPHeaders,
      proxy: this.proxyServer
        ? {
            server: this.proxyServer,
            username: this.proxyUser,
            password: this.proxyPass,
          }
        : undefined,
      ignoreDefaultArgs: anti.ignoreDefaultArgs,
      args: anti.args,
      executablePath: exe ?? undefined,
    });

    await attachRasAntiDetectToContext(this._context);

    const pages = this._context.pages();
    this._page = pages.length ? pages[0] : await this._context.newPage();
    this.log(
      `[pdf/config] http_first(env)=${PDF_HTTP_ENV_EXPLICIT_ON ? "on" : "off"} ` +
        `http_concurrency=${Math.max(1, Number(process.env.RAS_PDF_HTTP_CONCURRENCY ?? process.env.PDF_HTTP_CONCURRENCY ?? process.env.HTTP_CONCURRENCY ?? 16) || 16)} ` +
        `http_retries=${PDF_HTTP_MAX_ATTEMPTS} http_timeout_ms=${PDF_HTTP_TIMEOUT_MS}`,
    );

    await this._context.route("**/*", async (route, request) => {
      const url = request.url();
      if (shouldBlockThirdPartyAnalyticsUrl(url)) {
        await route.abort();
        return;
      }
      await route.continue();
    });

    this._attachPdfPageRequestFailedListener(this._page);
  }

  /**
   * @param {import("playwright").Page} page
   */
  _attachPdfPageRequestFailedListener(page) {
    page.on("requestfailed", (req) => {
      if (this._kadWarmupSuppressRequestfailed > 0) return;
      const url = req.url();
      const f = req.failure();
      if (
        !shouldLogPdfPageRequestFailed(url, req.resourceType(), {
          errorText: f?.errorText,
        })
      ) {
        return;
      }
      this.log(`[pdf/page] requestfailed: ${req.method()} ${url} — ${f && f.errorText}`);
    });
  }

  /**
   * Новая вкладка после 429/451: сбрасываем привязку KAD-сессии к старому page
   * (cookies чистит _safeRewarmup, маршрут analytics остаётся на context).
   */
  async _recyclePdfSurface() {
    if (!this._context) return;
    const prev = this._page;
    if (!prev) return;
    this.log("[pdf/session] recycle page (rate-limit / geo block — degraded PDF surface)");
    // Нельзя сначала prev.close(): при launchPersistentContext это часто
    // единственная вкладка — Chromium закрывает весь context, newPage() падает
    // с «Failed to open a new tab» / «context has been closed».
    let next;
    try {
      next = await this._context.newPage();
    } catch (e) {
      this.log(`[pdf/session] newPage() during recycle failed: ${e && e.message}`);
      throw e;
    }
    this._attachPdfPageRequestFailedListener(next);
    this._page = next;
    this._kadSessionReady = false;
    this._kadCardCaseId = null;
    this._fastWarmupOk = false;
    try {
      await prev.close({ runBeforeUnload: false }).catch(() => {});
    } catch {}
  }

  /**
   * Полный перезапуск Chromium (после фатального warmup / битой сессии).
   * @param {string} reason
   */
  async _restartPdfSurface(reason) {
    this.log(`[pdf/session] browser surface restart: ${reason}`);
    const wasSaved = this._sessionPdfSaved;
    await this.close();
    if (this.proxyClient?.resetReportedIpTracking) {
      this.proxyClient.resetReportedIpTracking();
    }
    // Regenerate browser fingerprint: new Chrome version + viewport + canvas
    // noise seed. pravocaptcha хранит pr_fp в blacklist; если бы fingerprint
    // оставался прежним, новый IP не помог бы — pr_fp тот же → 451. Перегенерим.
    resetRasBrowserFingerprintCache();
    await this.init();
    this._sessionPdfSaved = wasSaved;
  }

  /**
   * Лёгкий HTTP probe ras.arbitr.ru/ + kad.arbitr.ru/ через текущий прокси.
   * Запускается ПОСЛЕ смены IP (rotateIp / changeGeo), ДО запуска Chromium.
   * Если probe плох (451, ERR, timeout, empty, tokenFrom/pravocaptcha/ddos-guard),
   * сразу markBad и идём дальше — не платим warmup впустую.
   *
   * @param {{ timeoutMs?: number }} [opts]
   * @returns {Promise<{ ok: true } | { ok: false, reason: string, url?: string, status?: number }>}
   */
  async _probeRasKadOverProxy({ timeoutMs = PDF_PROBE_TIMEOUT_MS } = {}) {
    if (!PDF_PROBE_ENABLED) return { ok: true };
    if (!this.proxyServer) return { ok: true };
    const urls = [RAS_HOME, KAD_HOME];
    for (const url of urls) {
      let dispatcher = null;
      let host = url;
      try {
        host = new URL(url).host;
      } catch {}
      try {
        dispatcher = new ProxyAgent(
          _pdfProxyUri(this.proxyServer, this.proxyUser, this.proxyPass),
        );
      } catch (e) {
        return { ok: false, reason: `proxy_agent_init:${e && e.message}`, url };
      }
      let resp = null;
      let bodyText = "";
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      try {
        resp = await fetch(url, {
          dispatcher,
          signal: ac.signal,
          headers: {
            "User-Agent": buildRasBrowserFingerprint().userAgent,
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "ru-RU,ru;q=0.9",
          },
        });
        // Стрим до ~16KB — body на ras/kad ~20-60KB, нам нужно увидеть HTML/маркеры.
        const reader = resp.body?.getReader?.();
        if (reader) {
          const chunks = [];
          let total = 0;
          while (total < 16_384) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              chunks.push(value);
              total += value.byteLength;
            }
          }
          try {
            reader.releaseLock?.();
          } catch {}
          try {
            await reader.cancel?.();
          } catch {}
          bodyText = Buffer.concat(chunks.map((c) => Buffer.from(c))).toString(
            "utf8",
            0,
            Math.min(total, 16_384),
          );
        } else {
          bodyText = await resp.text();
          if (bodyText.length > 16_384) bodyText = bodyText.slice(0, 16_384);
        }
      } catch (e) {
        const msg = String(e && e.message ? e.message : e).toLowerCase();
        const reason =
          msg.includes("aborted") || msg.includes("timeout")
            ? "timeout"
            : `fetch_err:${msg.slice(0, 60)}`;
        clearTimeout(t);
        try {
          dispatcher?.close();
        } catch {}
        return { ok: false, reason: `${host}_${reason}`, url };
      }
      clearTimeout(t);
      try {
        dispatcher?.close();
      } catch {}
      if (!resp) return { ok: false, reason: `${host}_no_resp`, url };
      const status = resp.status;
      if (status === 451) return { ok: false, reason: `${host}_451`, url, status };
      if (status === 403) return { ok: false, reason: `${host}_403`, url, status };
      if (status >= 500) return { ok: false, reason: `${host}_${status}`, url, status };
      if (!bodyText || bodyText.length < PDF_PROBE_MIN_BODY) {
        return {
          ok: false,
          reason: `${host}_short_${bodyText.length}`,
          url,
          status,
        };
      }
      if (PDF_PROBE_BLOCK_REGEX.test(bodyText)) {
        return { ok: false, reason: `${host}_block_page`, url, status };
      }
    }
    return { ok: true };
  }

  /**
   * Сколько rotateIp подряд сделали в текущем geo (без changeGeo / без PDF OK).
   * Используется в `_recoverByGeoLoop`: до первого PDF OK сначала пробуем
   * rotateIp×N в этом geo, только потом markBad+changeGeo. Счётчик сбрасывается
   * на success PDF (`_clearGeoProbationOnSuccess`) и на удачном changeGeo.
   * @returns {number}
   */
  getRotateAttemptsInCurrentGeo() {
    return this._rotateAttemptsInCurrentGeo;
  }

  /**
   * Фактический egress IPv4/IPv6 через тот же HTTP-прокси, что и браузер.
   * Одна попытка, без валидации (raw). См. `_measureEgressIpVerified` для
   * вызовов, которым нужна гарантия «получили валидный новый IPv4».
   * @returns {Promise<string|null>}
   */
  async _measureEgressIp() {
    if (!this.proxyServer) return null;
    let dispatcher;
    try {
      dispatcher = new ProxyAgent(_pdfProxyUri(this.proxyServer, this.proxyUser, this.proxyPass));
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), PDF_EGRESS_PROBE_TIMEOUT_MS);
      const resp = await fetch(PDF_EGRESS_PROBE_URL, {
        dispatcher,
        signal: ac.signal,
      }).finally(() => clearTimeout(t));
      const text = await resp.text();
      if (!resp.ok) return null;
      try {
        const j = JSON.parse(text);
        const ip = j?.ip != null ? String(j.ip).trim() : "";
        return ip || null;
      } catch {
        const ip = String(text).trim();
        return ip || null;
      }
    } catch (e) {
      this.log(`[pdf/rl] egress probe failed: ${e && e.message}`);
      return null;
    } finally {
      try {
        dispatcher?.close();
      } catch {}
    }
  }

  /**
   * Verified egress measurement: повторяет `_measureEgressIp` до `retries` раз,
   * валидирует ответ как IPv4 (а не HTML/error page/мусор). Используется после
   * rotateIp/changeGeo как **единственный** источник правды о смене IP — API
   * ответы провайдера (newIp) использовать как факт **нельзя** (могут лгать).
   *
   * @param {{ retries?: number, pauseMs?: number }} [opts]
   * @returns {Promise<string|null>} valid IPv4 string или null если все попытки провалились
   */
  async _measureEgressIpVerified({ retries = 3, pauseMs = 1500 } = {}) {
    for (let i = 1; i <= retries; i += 1) {
      let ip = null;
      try {
        ip = await this._measureEgressIp();
      } catch {
        ip = null;
      }
      if (_isValidIpv4(ip)) return ip;
      this.log(
        `[pdf/rl] measure attempt ${i}/${retries} → ` +
          `${ip ? `invalid="${String(ip).slice(0, 40)}"` : "null"}`,
      );
      if (i < retries) await sleep(pauseMs);
    }
    return null;
  }

  async close() {
    if (!this._context) return;
    try {
      await this._context.close();
    } catch (e) {
      this.log(`[pdf/browser] close failed: ${e}`);
    } finally {
      const saved = this._sessionPdfSaved;
      this._context = null;
      this._page = null;
      this._kadSessionReady = false;
      this._kadCardCaseId = null;
      this._fastWarmupOk = false;
      if (this._userDataDir) {
        try {
          fs.rmSync(this._userDataDir, { recursive: true, force: true });
        } catch {}
        this._userDataDir = null;
      }
      this.log(`[pdf/session] Chromium закрыт; PDF сохранено за сессию: ${saved}`);
    }
  }

  /** Сколько PDF успешно записано на диск за текущую сессию этого Chromium. */
  getSessionPdfSavedCount() {
    return this._sessionPdfSaved;
  }

  /**
   * Куки + заголовки браузера для прямого GET pdf_link (после ensureKadSession).
   * @param {{ pdfUrl: string, caseId: string|null }} p
   * @returns {Promise<{ cookieHeader: string, headers: Record<string,string> }>}
   */
  async _buildKadHttpFetchAuth({ pdfUrl, caseId }) {
    const cookies = await this._context.cookies([pdfUrl]);
    const cookieHeader = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    let userAgent;
    try {
      userAgent = await this._page.evaluate(() => navigator.userAgent);
    } catch {
      userAgent = buildRasBrowserFingerprint().userAgent;
    }
    const fp = buildRasBrowserFingerprint();
    const referer = caseId
      ? `https://kad.arbitr.ru/Card/${encodeURIComponent(caseId)}`
      : KAD_HOME;
    /** @type {Record<string,string>} */
    const headers = {
      "User-Agent": userAgent,
      Referer: referer,
      Origin: "https://kad.arbitr.ru",
    };
    for (const [k, v] of Object.entries(fp.extraHTTPHeaders)) {
      if (v == null || v === "") continue;
      if (!headers[k]) headers[k] = v;
    }
    return { cookieHeader, headers };
  }

  /**
   * @param {{ id: string, pdf_link: string, case_id?: string|null }} act
   * @param {string|null} caseId
   * @returns {Promise<
   *   | { ok: true, buffer: Buffer, attempts: number }
   *   | { ok: false, reason: string, status?: number, logFail?: boolean }
   * >}
   */
  async _tryKadPdfHttpAfterWarmup(act, caseId) {
    const { cookieHeader, headers } = await this._buildKadHttpFetchAuth({
      pdfUrl: act.pdf_link,
      caseId,
    });
    return fetchKadPdfViaHttp({
      url: act.pdf_link,
      cookieHeader,
      headers,
      proxyServer: this.proxyServer,
      proxyUser: this.proxyUser,
      proxyPass: this.proxyPass,
      maxAttempts: PDF_HTTP_MAX_ATTEMPTS,
      timeoutMs: PDF_HTTP_TIMEOUT_MS,
    });
  }

  // ───────────────────────── kad session (ras→kad, без /Card) ─────────────────────────

  /**
   * Прогрев сессии: ras → kad → /Card/<caseId>. /Card шаг критичен — без него
   * kad.arbitr.ru при GET /Document/Pdf отдаёт pravocaptcha-страницу с
   * #tokenFrom (видели в проде 2026-05). Раньше его сняли «ради скорости» —
   * сейчас вернули обратно.
   *
   * /Card идемпотентен per-caseId: пока качаем PDF из того же дела, второй
   * раз не ходим. Когда воркер берёт акт с новым caseId — ходим заново.
   *
   * @param {{ force?: boolean, caseId?: string|null, pdfUrl?: string|null }} [opts]
   */
  async ensureKadSession({ force = false, caseId = null, pdfUrl = null } = {}) {
    if (!this._page) throw new Error("PdfDownloader.ensureKadSession: init() first");
    // FAST-PATH: после первого успешного PDF в сессии pravocaptcha-cookies стоят
    // на весь домен kad.arbitr.ru, Card+thaw повторно делать НЕ нужно — это
    // экономит ~13с на каждый акт (PDF_PRAVO_AFTER_CARD_MS + PDF_PRAVO_WAIT_MS +
    // 2× page.goto). Salto-fetch сам распознает редкий редирект на капчу через
    // retry/needsWarmup → тогда сбрасываем флаг и делаем полный warmup.
    // Выключить: RAS_PDF_FAST_AFTER_FIRST_SUCCESS=0.
    if (!force && this._fastWarmupOk && this._kadSessionReady) return;
    const cardCached =
      caseId && this._kadCardCaseId === caseId && this._kadSessionReady;
    if (!force && cardCached) return;
    // Если базовая сессия уже готова, но caseId сменился — гоним только Card.
    const needBase = force || !this._kadSessionReady;

    const page = this._page;
    this._kadWarmupSuppressRequestfailed += 1;
    try {
    if (needBase) {
      this.log(`[pdf/kad] session warmup (ras→kad)`);
      try {
        await page.goto(RAS_HOME, {
          waitUntil: "domcontentloaded",
          timeout: WARMUP_NAV_TIMEOUT_MS,
        });
        await page.waitForSelector("#b-form-submit", { timeout: WARMUP_NAV_TIMEOUT_MS });
      } catch (e) {
        this.log(`[pdf/kad] step1 ras.arbitr.ru failed: ${e && e.message}`);
        throw e;
      }

      try {
        await page.goto(KAD_HOME, {
          waitUntil: "domcontentloaded",
          timeout: WARMUP_NAV_TIMEOUT_MS,
        });
      } catch (e) {
        this.log(`[pdf/kad] step2 kad.arbitr.ru/ failed: ${e && e.message}`);
        throw e;
      }
      this._kadSessionReady = true;
      this._kadCardCaseId = null;
    }

    if (caseId) {
      const cardUrl = KAD_CARD(caseId);
      this.log(`[pdf/kad] card warmup ${caseId}`);
      try {
        await page.goto(cardUrl, {
          waitUntil: "domcontentloaded",
          timeout: WARMUP_NAV_TIMEOUT_MS,
        });
      } catch (e) {
        this.log(`[pdf/kad] step3 /Card/${caseId} failed: ${e && e.message}`);
        // /Card не критичен сам по себе — если упал, оставим _kadCardCaseId=null,
        // следующий downloadAndSave попробует снова. На pravocaptcha-страницы
        // page.goto не падает (отдаёт 200), так что сюда попадаем только при
        // сетевой ошибке/таймауте.
        throw e;
      }
      // pravocaptcha-JS делает фоновый challenge ПОСЛЕ DOMContentLoaded —
      // ждём `load` + ещё пауза, чтобы он успел проставить cap-cookies. Без
      // этого последующий fetch /Document/Pdf бьёт в tokenFrom-страницу.
      await page
        .waitForLoadState("load", { timeout: WARMUP_NAV_TIMEOUT_MS })
        .catch(() => {});
      // На ветке Card→thaw(pdfUrl) короткая пауза здесь; полный PRAVO — после thaw.
      const cardPravoMs =
        pdfUrl && PDF_PRAVO_AFTER_CARD_MS > 0
          ? Math.min(PDF_PRAVO_WAIT_MS, PDF_PRAVO_AFTER_CARD_MS)
          : PDF_PRAVO_WAIT_MS;
      if (cardPravoMs > 0) await sleep(cardPravoMs);
      this._kadCardCaseId = caseId;
    }

    // pravocaptcha-thaw: ходим на сам pdfUrl ЧЕРЕЗ page.goto (а не fetch
    // в evaluate). Chromium при этом сам отрендерит pravocaptcha-страницу,
    // её JS отработает в реальном DOM-контексте → cap-cookies проставятся.
    // После thaw возвращаемся на about:blank, чтобы PDF viewer не мешал
    // следующему page.evaluate.
    //
    // Почему недостаточно /Card: /Card в проде 2026-05 НЕ запускает
    // pravocaptcha challenge сама по себе (видели — после /Card следующий
    // fetch снова tokenFrom). А goto pdfUrl ТРИГЕРИТ challenge всегда.
    if (pdfUrl) {
      this.log(`[pdf/kad] pravocaptcha thaw`);
      try {
        await page
          .goto(pdfUrl, {
            waitUntil: "domcontentloaded",
            timeout: WARMUP_NAV_TIMEOUT_MS,
          })
          .catch(() => {}); // PDF viewer / abort — нам всё равно
        await page
          .waitForLoadState("load", { timeout: WARMUP_NAV_TIMEOUT_MS })
          .catch(() => {});
        if (PDF_PRAVO_WAIT_MS > 0) await sleep(PDF_PRAVO_WAIT_MS);
        // Выйти на чистую страницу: иначе page.evaluate ниже выполнится
        // в контексте PDF viewer'а или salto-страницы, и fetch отработает
        // не на том origin.
        await page
          .goto("about:blank", { timeout: WARMUP_NAV_TIMEOUT_MS })
          .catch(() => {});
        // Для fetch'a с credentials:"include" нам нужен НЕ about:blank, а
        // origin kad.arbitr.ru. Возвращаемся на kad/.
        await page
          .goto(KAD_HOME, {
            waitUntil: "domcontentloaded",
            timeout: WARMUP_NAV_TIMEOUT_MS,
          })
          .catch(() => {});
      } catch (e) {
        this.log(`[pdf/kad] thaw failed: ${e && e.message} — продолжаю`);
      }
    }

    this.log(
      `[pdf/kad] session OK${caseId ? ` (card=${caseId})` : ""}${pdfUrl ? " (thaw)" : ""}`,
    );
    // pravocaptcha-cookies стоят на весь домен kad.arbitr.ru уже после thaw,
    // не нужно ждать успешного PDF чтобы включить fast-path. Если первый акт
    // вернул 404 (markPdfFailed) — следующие не платят warmup впустую.
    // Если challenge на самом деле не прошёл — salto-fetch вернёт retry/needsWarmup,
    // и downloadAndSave сбросит _fastWarmupOk → один тяжёлый warmup и снова fast.
    if (PDF_FAST_AFTER_FIRST_SUCCESS) this._fastWarmupOk = true;
    } finally {
      this._kadWarmupSuppressRequestfailed -= 1;
    }
  }

  // ───────────────────────── download ─────────────────────────

  /**
   * Скачать ОДИН PDF и сохранить на диск. Внутри есть retry-логика
   * (ротация IP при 429, re-warmup при pravocaptcha-редиректе).
   *
   * @param {{ id: string, pdf_link: string, case_id: string, file_name: string }} act
   * @returns {Promise<{ ok: true, pdfPath: string, bytes: number, attempts: number, timings?: { warmupMs: number, evalMs: number, writeMs: number, wallMs: number } }
   *           | { ok: false, error: string, status?: number, deferred?: boolean, recoverable?: boolean }>}
   */
  async downloadAndSave(act) {
    if (!this._page) throw new Error("PdfDownloader.downloadAndSave: init() first");
    if (!act?.id || !act?.pdf_link) {
      return { ok: false, error: "missing id or pdf_link" };
    }

    const caseId = act.case_id ?? null;
    const pdfUrl = act.pdf_link ?? null;
    const wall0 = performance.now();
    let warmupMs = 0;
    try {
      const w0 = performance.now();
      await this.ensureKadSession({ caseId, pdfUrl });
      warmupMs = performance.now() - w0;
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      return buildKadSessionFailedReturn(msg);
    }

    const targetPath = path.join(this.workDir, `${act.id}.pdf`);
    let lastErr = "unknown";
    let lastStatus = null;

    const httpFirst = isPdfHttpFirstEnabled();
    if (httpFirst) {
      _pdfAggStats.httpAttempts += 1;
      let httpMs = 0;
      try {
        const h0 = performance.now();
        const httpRes = await withPdfHttpConcurrency(() => this._tryKadPdfHttpAfterWarmup(act, caseId));
        httpMs = performance.now() - h0;
        if (httpRes.ok) {
          const bin = httpRes.buffer;
          const wf0 = performance.now();
          await fs.promises.writeFile(targetPath, bin);
          const writeMs = performance.now() - wf0;
          const wallMs = performance.now() - wall0;
          this._sessionPdfSaved += 1;
          this._consecutiveOk += 1;
          this._consecutiveFails = 0;
          if (PDF_FAST_AFTER_FIRST_SUCCESS) this._fastWarmupOk = true;
          if (this._escalator) this._escalator.noteSuccess();
          this._clearGeoProbationOnSuccess();
          _pdfAggStats.httpOk += 1;
          _pdfAggStats.totalOk += 1;
          _afterSingleHttpOutcome(true, this.log.bind(this));
          this.log(
            `[pdf/http] OK id=${act.id} bytes=${bin.length} attempts=${httpRes.attempts}`,
          );
          const timings = { warmupMs, evalMs: httpMs, writeMs, wallMs };
          if (PDF_TIMING) {
            const kEval = httpMs > 0 ? (bin.length / 1024 / (httpMs / 1000)).toFixed(1) : "?";
            const kWall = wallMs > 0 ? (bin.length / 1024 / (wallMs / 1000)).toFixed(1) : "?";
            this.log(
              `[pdf/timing] ${act.id} warmup=${warmupMs.toFixed(0)}ms http=${httpMs.toFixed(0)}ms ` +
                `write=${writeMs.toFixed(0)}ms wall=${wallMs.toFixed(0)}ms ` +
                `payload_KiB_s≈http:${kEval} wall:${kWall} (http=undici GET)`,
            );
          }
          return { ok: true, pdfPath: targetPath, bytes: bin.length, attempts: httpRes.attempts, timings };
        }
        const st = httpRes.status ?? httpRes.lastStatus;
        const logFail =
          st === 401 ||
          st === 403 ||
          st === 429 ||
          st === 0 ||
          (typeof st === "number" && st >= 500);
        if (logFail) this.log(`[pdf/http] fail id=${act.id} status=${st ?? "?"}`);
        this.log(`[pdf/http] fallback id=${act.id} reason=${httpRes.reason}`);
        _pdfAggStats.httpFail += 1;
        _afterSingleHttpOutcome(false, this.log.bind(this));
      } catch (e) {
        this.log(`[pdf/http] fail id=${act.id} status=0`);
        this.log(`[pdf/http] fallback id=${act.id} reason=exception:${e && e.message}`);
        _pdfAggStats.httpFail += 1;
        _afterSingleHttpOutcome(false, this.log.bind(this));
      }
    }

    /**
     * После первого 451 на этом акте прошли _handleRateLimit и rewarmup успешно.
     * Второй 451 подряд — не жечь L2/L3, отложить акт в batch.
     */
    let pdf451RecoverySucceeded = false;

    for (let attempt = 1; attempt <= PDF_MAX_ATTEMPTS; attempt += 1) {
      let result;
      let evalMs = 0;
      const eval0 = performance.now();
      try {
        // Playwright Page.evaluate принимает только (fn, arg); третий объект
        // { timeout } больше не опция evaluate — он уходил вторым аргументом
        // в браузер и давал «Too many arguments…».
        let evalTimeoutId;
        const evalTimeout = new Promise((_, reject) => {
          evalTimeoutId = setTimeout(
            () => reject(new Error(`evaluate timeout after ${FETCH_EVAL_TIMEOUT_MS}ms`)),
            FETCH_EVAL_TIMEOUT_MS,
          );
        });
        const evalWork = this._page.evaluate(saltoFetchSource(), { url: act.pdf_link });
        try {
          result = await Promise.race([evalWork, evalTimeout]);
        } finally {
          clearTimeout(evalTimeoutId);
        }
      } catch (e) {
        evalMs = performance.now() - eval0;
        lastErr = `evaluate threw: ${e && e.message}`;
        this.log(`[pdf/get] ${act.id} attempt ${attempt}/${PDF_MAX_ATTEMPTS}: ${lastErr}`);
        if (PDF_TIMING) {
          this.log(`[pdf/timing] ${act.id} attempt=${attempt} eval_ms=${evalMs.toFixed(0)} (fail)`);
        }
        // Чаще всего — навигация в PDF viewer или timeout. Делаем re-warmup.
        await this._safeRewarmup(caseId, { pdfUrl });
        await sleep(_randomPause());
        continue;
      }
      evalMs = performance.now() - eval0;

      if (result?.ok) {
        const bin = Buffer.from(result.base64, "base64");
        if (!bin.length || bin.length < 200) {
          // Защита от пустого/мусорного ответа (видели когда POST приходил
          // PDF-«заглушку» из 4 байт).
          lastErr = `tiny payload (${bin.length}b) — likely not a real PDF`;
          this.log(`[pdf/get] ${act.id}: ${lastErr}`);
          await this._safeRewarmup();
          await sleep(_randomPause());
          continue;
        }
        const wf0 = performance.now();
        await fs.promises.writeFile(targetPath, bin);
        const writeMs = performance.now() - wf0;
        const wallMs = performance.now() - wall0;
        this._sessionPdfSaved += 1;
        this._consecutiveOk += 1;
        this._consecutiveFails = 0;
        if (PDF_FAST_AFTER_FIRST_SUCCESS) this._fastWarmupOk = true;
        // Сбрасываем счётчики эскалатора: следующее падение начнётся с дешёвого
        // changeIp, а не продолжит лестницу с того места, где остановились.
        if (this._escalator) this._escalator.noteSuccess();
        this._clearGeoProbationOnSuccess();
        _pdfAggStats.totalOk += 1;
        _pdfAggStats.playwrightOk += 1;
        this.log(
          `[pdf/get] ${act.id} OK bytes=${bin.length} attempts=${attempt} ` +
            `(streak=${this._consecutiveOk}, session_saved=${this._sessionPdfSaved})`,
        );
        const timings = { warmupMs, evalMs, writeMs, wallMs };
        if (PDF_TIMING) {
          const kEval = evalMs > 0 ? (bin.length / 1024 / (evalMs / 1000)).toFixed(1) : "?";
          const kWall = wallMs > 0 ? (bin.length / 1024 / (wallMs / 1000)).toFixed(1) : "?";
          this.log(
            `[pdf/timing] ${act.id} warmup=${warmupMs.toFixed(0)}ms eval=${evalMs.toFixed(0)}ms ` +
              `write=${writeMs.toFixed(0)}ms wall=${wallMs.toFixed(0)}ms ` +
              `payload_KiB_s≈eval:${kEval} wall:${kWall} (eval=salto+fetch в Chromium)`,
          );
        }
        return { ok: true, pdfPath: targetPath, bytes: bin.length, attempts: attempt, timings };
      }

      // Не-OK. Разбираем что делать.
      lastErr = result?.error ?? "unknown";
      lastStatus = result?.status ?? null;
      this._consecutiveOk = 0;
      this.log(
        `[pdf/get] ${act.id} attempt ${attempt}/${PDF_MAX_ATTEMPTS} failed: ` +
          `status=${lastStatus ?? "?"} error="${lastErr}"`,
      );
      if (PDF_TIMING) {
        this.log(
          `[pdf/timing] ${act.id} attempt=${attempt} eval_ms=${evalMs.toFixed(0)} warmup_ms=${warmupMs.toFixed(0)} (!ok)`,
        );
      }
      // Диагностика декодера salto: если сторона браузера вернула decoded_preview —
      // дампим в лог, чтобы увидеть РЕАЛЬНУЮ структуру JS на этом IP/сессии.
      if (result?.decoded_preview) {
        this.log(
          `[pdf/get] ${act.id} decoded_len=${result.decoded_len} datat_len=${result.datat_len} ` +
            `preview="${result.decoded_preview.replace(/\n/g, "\\n").slice(0, 400)}"`,
        );
      }
      if (result?.html) {
        this.log(`[pdf/get] ${act.id} html_peek="${result.html.replace(/\n/g, "\\n").slice(0, 300)}"`);
      }

      if (result?.retry) {
        // Fast-path выдал не-OK → cookies могли стухнуть, в следующий раз
        // принудительно делаем полный warmup (Card+thaw). Это safety-net:
        // нормальный pravocaptcha-gate ниже всё равно уходит в defer, но если
        // он повторится — следующий запуск получит свежие cookies.
        this._fastWarmupOk = false;
        // tokenFrom / pravocaptcha gate (часто status=200) — как первый 451:
        // defer в batch, без escalator и без сжигания PDF_MAX_ATTEMPTS.
        if (String(lastErr).toLowerCase().includes("pravocaptcha gate")) {
          this.log(`[pdf/defer] id=${act.id} reason=pravocaptcha_gate next=batch_later`);
          return {
            ok: false,
            deferred: true,
            recoverable: true,
            status: 200,
            reason: "pravocaptcha_gate",
            error: lastErr,
          };
        }
        // 451 → defer сразу, не жжём PDF_MAX_ATTEMPTS и не дёргаем escalator на
        // этом акте. pipeline.js сделает source.deferAct + record451 + (если
        // порог) уведёт proxy_key в карантин. Пусть здоровый воркер попробует
        // позже.
        if (lastStatus === 451) {
          this.log(`[pdf/defer] id=${act.id} reason=451_first_hit next=batch_later`);
          return {
            ok: false,
            deferred: true,
            recoverable: true,
            status: 451,
            error: lastErr || "451_defer_first_hit",
          };
        }
        if (_repeat451DeferAfterRecovery(lastStatus, pdf451RecoverySucceeded)) {
          // Dead code для 451 (выше уже return), оставлено как safety-net.
          this.log(
            `[pdf/defer] id=${act.id} reason=repeat_451_after_recovery next=batch_later`,
          );
          return {
            ok: false,
            deferred: true,
            recoverable: true,
            status: 451,
            error: "repeat_451_after_recovery",
          };
        }
        const rl = await this._handleRateLimit(caseId, pdfUrl);
        if (lastStatus === 451 && rl.sessionOk) {
          pdf451RecoverySucceeded = true;
        }
        if (!rl.sessionOk) {
          const classified = classifyPdfInfraError(rl.error);
          if (classified) {
            return {
              ok: false,
              recoverable: true,
              deferred: true,
              infra: true,
              reason: classified.reason,
              status: lastStatus,
              error: rl.error ?? "rate-limit recovery: kad session invalid",
            };
          }
          return {
            ok: false,
            recoverable: true,
            error: rl.error ?? "rate-limit recovery: kad session invalid",
            status: lastStatus,
          };
        }
        await sleep(_randomPause());
        continue;
      }
      if (result?.needsWarmup) {
        this._fastWarmupOk = false;
        await this._safeRewarmup(caseId, { pdfUrl });
        await sleep(_randomPause());
        continue;
      }

      // Нерекуперабельная ошибка — отдаём как есть.
      this._consecutiveFails += 1;
      return { ok: false, error: lastErr, status: lastStatus };
    }

    this._consecutiveFails += 1;
    const finalErr = `max attempts reached (${PDF_MAX_ATTEMPTS}). last: ${lastErr}`;
    const classifiedFinal = classifyPdfInfraError(finalErr);
    if (classifiedFinal) {
      return {
        ok: false,
        recoverable: true,
        deferred: true,
        infra: true,
        reason: classifiedFinal.reason,
        status: lastStatus,
        error: finalErr,
      };
    }
    return {
      ok: false,
      error: finalErr,
      status: lastStatus,
    };
  }

  // ───────────────────────── внутренние помощники ─────────────────────────

  /**
   * @returns {Promise<{ ok: true } | { ok: false, error: string }>}
   */
  async _safeRewarmup(caseId = null, { clearCookies = false, pdfUrl = null } = {}) {
    // _safeRewarmup всегда означает «текущий fast-path не годится» — сброс флага.
    this._fastWarmupOk = false;
    if (clearCookies && this._context) {
      try {
        await this._context.clearCookies();
        this._kadSessionReady = false;
        this._kadCardCaseId = null;
        this.log(`[pdf/kad] cookies очищены (post rotateIp)`);
      } catch (e) {
        this.log(`[pdf/kad] clearCookies failed: ${e && e.message}`);
      }
    }
    try {
      await this.ensureKadSession({ force: true, caseId, pdfUrl });
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      return { ok: false, error: msg };
    }
    if (!this._kadSessionReady) {
      return { ok: false, error: "kad session not ready after rewarmup" };
    }
    return { ok: true };
  }

  /**
   * @returns {Promise<{
   *   sessionOk: boolean,
   *   error?: string,
   *   levelsTouched: string[],
   * }>}
   */
  async _handleRateLimit(caseId = null, pdfUrl = null) {
    /** @type {string[]} */
    const levelsTouched = [];
    const egressBefore = await this._measureEgressIp();

    if (this._escalator) {
      let reason = "pdf-downloader 429/451";
      if (
        PDF_FORCE_GEO_AFTER_FAILS > 0 &&
        this._consecutiveFails >= PDF_FORCE_GEO_AFTER_FAILS
      ) {
        this._escalator.consecutiveIpRotations = this._escalator.ipBeforeOperator;
        this._escalator.operatorSwapsThisCycle = this._escalator.operatorBeforeGeo;
        reason = `pdf-downloader force-geo (consecutiveFails=${this._consecutiveFails})`;
        this.log(`[pdf/rl] ${this._consecutiveFails} провалов подряд — форс L3 changeGeo`);
      }
      try {
        const r = await this._escalator.recoverFrom(reason);
        levelsTouched.push(r.level);
        const d = r.detail || {};
        const extras = [];
        if (d.newIp) extras.push(`new_ip=${d.newIp}`);
        if (d.caption) extras.push(`geo='${d.caption}'`);
        if (d.geoid) extras.push(`geoid=${d.geoid}`);
        if (d.operator) extras.push(`operator='${d.operator}'`);
        this.log(
          `[pdf/rl] escalator level=${r.level} ok=${d.ok}` +
            (extras.length ? ` ${extras.join(" ")}` : ""),
        );

        if (
          r.level === ESC_LEVELS.OPERATOR &&
          d.ok &&
          egressBefore &&
          this.proxyServer
        ) {
          const egressAfter = await this._measureEgressIp();
          if (egressAfter && egressBefore === egressAfter) {
            this.log(
              `[pdf/rl] operator changed but ip unchanged old_ip=${egressBefore} new_ip=${egressAfter}`,
            );
            this._escalator.operatorSwapsThisCycle = this._escalator.operatorBeforeGeo;
            try {
              const r2 = await this._escalator.recoverFrom(
                "pdf-rl operator same egress — advance escalation",
              );
              levelsTouched.push(r2.level);
              const d2 = r2.detail || {};
              const ex2 = [];
              if (d2.newIp) ex2.push(`new_ip=${d2.newIp}`);
              if (d2.caption) ex2.push(`geo='${d2.caption}'`);
              if (d2.geoid) ex2.push(`geoid=${d2.geoid}`);
              if (d2.operator) ex2.push(`operator='${d2.operator}'`);
              this.log(
                `[pdf/rl] escalator follow-up level=${r2.level} ok=${d2.ok}` +
                  (ex2.length ? ` ${ex2.join(" ")}` : ""),
              );
            } catch (e) {
              this.log(`[pdf/rl] follow-up escalator threw: ${e && e.message}`);
            }
          }
        }
      } catch (e) {
        this.log(`[pdf/rl] escalator threw: ${e && e.message}`);
      }
    } else if (this.proxyClient) {
      this.log(`[pdf/rl] 429/451 — крутим rotateIp() (no escalator)`);
      try {
        const r = await this.proxyClient.rotateIp("pdf-downloader 429/451");
        this.log(`[pdf/rl] rotateIp ok=${r?.ok} new_ip=${r?.newIp ?? "?"}`);
        levelsTouched.push(ESC_LEVELS.IP);
      } catch (e) {
        this.log(`[pdf/rl] rotateIp failed: ${e && e.message}`);
      }
    } else {
      this.log(`[pdf/rl] 429/451, no proxyClient — sleeping ${PDF_RL_NO_PROXY_SLEEP_MS}ms`);
      await sleep(PDF_RL_NO_PROXY_SLEEP_MS);
    }

    await this._recyclePdfSurface();
    const rw = await this._safeRewarmup(caseId, { clearCookies: true, pdfUrl });
    if (rw.ok) {
      this.log("[pdf/rl] rewarmup OK after escalation");
      return { sessionOk: true, levelsTouched };
    }

    this.log(`[pdf/rl] rewarmup failed after escalation: ${rw.error ?? "unknown"}`);
    try {
      await this._restartPdfSurface("rewarmup failed after 429/451");
    } catch (e) {
      const msg = e && e.message ? String(e.message) : String(e);
      return { sessionOk: false, error: `browser restart failed: ${msg}`, levelsTouched };
    }

    try {
      await this.ensureKadSession({ force: true, caseId, pdfUrl });
    } catch (e2) {
      const msg = e2 && e2.message ? String(e2.message) : String(e2);
      return {
        sessionOk: false,
        error: `kad session after restart: ${msg}`,
        levelsTouched,
      };
    }
    if (!this._kadSessionReady) {
      return {
        sessionOk: false,
        error: "kad session not ready after browser restart",
        levelsTouched,
      };
    }
    this.log("[pdf/session] browser surface restart OK after rewarmup failure");
    return { sessionOk: true, levelsTouched };
  }

  // ───────────────────────── fast bad-geo recovery ─────────────────────────

  /** True если bad-geo recovery enabled И есть proxyClient.changeGeo. */
  hasFastGeoRecovery() {
    return (
      PDF_BAD_GEO_RECOVERY_ENABLED &&
      this.proxyClient !== null &&
      typeof this.proxyClient.changeGeo === "function"
    );
  }

  /**
   * Override фильтров changeGeo в runtime (вызывается preflight'ом pipeline.js
   * после anti-cloak probe). Эффект:
   *   - `_recoverByGeoLoop` берёт `this.geoFilters ?? PDF_GEO_FILTERS` — теперь
   *     L3 changeGeo будет выбирать только из recommended-стран.
   *   - escalator получает тот же override → L3 эскалатора тоже идёт в target.
   */
  setGeoFilters(filters) {
    this.geoFilters = filters;
    if (this._escalator && typeof this._escalator.setGeoFilters === "function") {
      this._escalator.setGeoFilters(filters);
    }
  }

  /**
   * Узнать (геоid, оператор) текущего прокси через MP API + измерить egress IP.
   * Вызывается в _recoverByGeoLoop — нужен снимок ДО смены, чтобы записать в blacklist.
   * @returns {Promise<{ geoid: number|null, operator: string|null, ip: string|null }>}
   */
  async _readCurrentGeoSig() {
    if (!this.proxyClient) return { geoid: null, operator: null, ip: null };
    let geoid = null;
    let operator = null;
    try {
      const me = await this.proxyClient._getMyInfo();
      const g = me?.geoid ?? me?.geo_id ?? me?.id_geo ?? null;
      if (g !== null && g !== undefined) {
        const n = Number(g);
        geoid = Number.isFinite(n) ? n : null;
      }
      operator = me?.operator ?? me?.proxy_operator ?? me?.operator_name ?? null;
      if (operator) operator = String(operator);
    } catch {}
    let ip = null;
    try {
      ip = await this._measureEgressIp();
    } catch {}
    return { geoid, operator, ip };
  }

  /**
   * После changeGeo: опрос egress до PDF_GEO_CHECK_TIMEOUT_MS (деф. 120с),
   * пока IP не сменится относительно снимка до смены.
   *
   * @param {string|null} oldIp
   * @param {(() => boolean) | undefined} shouldStop
   * @returns {Promise<{ ip: string|null, changed: boolean, stopped?: boolean }>}
   */
  async _waitEgressIpChangeAfterGeo(oldIp, shouldStop) {
    const deadline = Date.now() + PDF_GEO_CHECK_TIMEOUT_MS;
    let last = null;
    while (Date.now() < deadline) {
      if (typeof shouldStop === "function" && shouldStop()) {
        return { ip: last, changed: false, stopped: true };
      }
      let measured = null;
      try {
        measured = await this._measureEgressIp();
      } catch {
        measured = null;
      }
      // По спеке: «если IP невалидный, пустой, html, null или ошибка,
      // повторить измерение несколько раз». Только валидный IPv4 годится
      // для возврата как «changed». Невалидный — продолжаем poll.
      if (_isValidIpv4(measured)) {
        last = measured;
        if (!oldIp || measured !== oldIp) {
          return { ip: measured, changed: true };
        }
      } else if (measured) {
        this.log(
          `[pdf/recover] invalid egress response "${String(measured).slice(0, 40)}" — retry`,
        );
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await _recoverSleep(Math.min(PDF_RECOVER_GEO_IP_POLL_MS, remaining), shouldStop);
      if (typeof shouldStop === "function" && shouldStop()) {
        return { ip: last, changed: false, stopped: true };
      }
    }
    // Финальная попытка с verified-retry (короткая, не блокирующая).
    const final = await this._measureEgressIpVerified({ retries: 2, pauseMs: 1000 });
    if (final) last = final;
    return {
      ip: last,
      changed: !!(last && oldIp && last !== oldIp),
    };
  }

  /**
   * rotateIp + verified egress до/после (API new_ip — только hint в логах).
   * Успешная смена = валидный IPv4 после ротации И отличается от measured до.
   *
   * @param {string} reason
   * @param {(() => boolean) | undefined} shouldStop
   * @returns {Promise<{
   *   changed: boolean,
   *   ipBefore: string|null,
   *   ipAfter: string|null,
   *   apiIp: string|null,
   *   rotateRaw: object|null,
   *   stopped?: boolean,
   * }>}
   */
  async _rotateIpWithVerifiedEgressChange(reason, shouldStop) {
    if (!this.proxyClient || typeof this.proxyClient.rotateIp !== "function") {
      return {
        changed: false,
        ipBefore: null,
        ipAfter: null,
        apiIp: null,
        rotateRaw: null,
      };
    }
    if (typeof shouldStop === "function" && shouldStop()) {
      return {
        changed: false,
        ipBefore: null,
        ipAfter: null,
        apiIp: null,
        rotateRaw: null,
        stopped: true,
      };
    }
    const ipBefore = await this._measureEgressIpVerified();
    let rotateRaw;
    try {
      rotateRaw = await this.proxyClient.rotateIp(reason, { skipCooldown: true });
    } catch (e) {
      this.log(`[pdf/rotate] rotateIp threw: ${e && e.message}`);
      rotateRaw = { ok: false };
    }
    await _recoverSleep(PDF_ROTATE_IP_SLEEP_MS, shouldStop);
    if (typeof shouldStop === "function" && shouldStop()) {
      return {
        changed: false,
        ipBefore,
        ipAfter: null,
        apiIp: null,
        rotateRaw,
        stopped: true,
      };
    }
    const ipAfter = await this._measureEgressIpVerified();
    const apiIp =
      rotateRaw?.newIp !== undefined &&
      rotateRaw?.newIp !== null &&
      String(rotateRaw.newIp).trim()
        ? String(rotateRaw.newIp).trim()
        : null;
    const changed = !!(ipAfter && ipBefore && ipAfter !== ipBefore);
    return { changed, ipBefore, ipAfter, apiIp, rotateRaw, stopped: false };
  }

  /**
   * changeGeo оставил тот же egress IP — rotateIp 2–3 раза с короткой паузой,
   * после каждого — проверка measured/current IP.
   *
   * @param {string|null} oldIp
   * @param {string} reason
   * @param {(() => boolean) | undefined} shouldStop
   * @returns {Promise<{ ok: boolean, newIp?: string|null, attempt?: number, reason?: string }>}
   */
  async _tryRotateIpAfterSameGeo(oldIp, reason, shouldStop) {
    if (!this.proxyClient || typeof this.proxyClient.rotateIp !== "function") {
      return { ok: false, reason: "no_rotate_ip" };
    }
    for (let attempt = 1; attempt <= PDF_SAME_IP_ROTATE_ATTEMPTS; attempt += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        return { ok: false, reason: "stopped" };
      }
      this.log(
        `[pdf/recover] same IP after changeGeo (${oldIp ?? "?"}) — ` +
          `rotateIp ${attempt}/${PDF_SAME_IP_ROTATE_ATTEMPTS}`,
      );
      const rot = await this._rotateIpWithVerifiedEgressChange(
        `pdf-recover same-ip ${reason} #${attempt}`,
        shouldStop,
      );
      if (rot.stopped) {
        return { ok: false, reason: "stopped" };
      }
      const dup =
        rot.ipBefore && rot.ipAfter && rot.ipAfter === rot.ipBefore ? "1" : "0";
      this.log(
        `[pdf/recover] rotateIp #${attempt} measured=${rot.ipAfter ?? "null"} ` +
          `before=${rot.ipBefore ?? "?"} api_hint=${rot.apiIp ?? "?"} dup=${dup}`,
      );
      if (
        rot.changed &&
        rot.ipAfter &&
        (!oldIp || rot.ipAfter !== oldIp)
      ) {
        this.log(
          `[pdf/recover] rotateIp #${attempt} new IP ${rot.ipAfter}` +
            (rot.apiIp && rot.apiIp !== rot.ipAfter
              ? ` (api_hint=${rot.apiIp})`
              : ""),
        );
        return { ok: true, newIp: rot.ipAfter, attempt };
      }
      this.log(
        `[pdf/recover] rotateIp #${attempt} — same/invalid egress, continue`,
      );
    }
    return { ok: false, reason: "same_ip_after_rotates" };
  }

  /**
   * Успешный исход раунда recover: restart surface + probation.
   *
   * @param {{ geoid?: number|null, operator?: string|null, caption?: string|null }} geoMeta
   * @param {string|null} newIp
   * @param {number} round
   */
  async _completeRecoverGeoRoundSuccess(geoMeta, newIp, round) {
    if (this.proxyClient?.resetReportedIpTracking) {
      this.proxyClient.resetReportedIpTracking();
    }
    await this._restartPdfSurface(`recover round ${round} after changeGeo`);
    this._geoProbation = true;
    this._geoProbationStartedAt = Date.now();
    this._currentGeoSig = {
      geoid: geoMeta.geoid ?? null,
      operator: geoMeta.operator ?? null,
      ip: newIp ?? null,
    };
    // Сменили geo — счётчик rotateIp-attempts в новом geo с нуля.
    this._rotateAttemptsInCurrentGeo = 0;
    this.log(
      `[pdf/recover] OK geo=${geoMeta.geoid ?? "?"} caption='${geoMeta.caption ?? "?"}' ` +
        `op=${geoMeta.operator ?? "?"} ip=${newIp ?? "?"} round=${round} → ` +
        `probation start (timeout ${PDF_GEO_CHECK_TIMEOUT_MS}ms)`,
    );
  }

  /**
   * Pre-changeGeo попытка восстановиться в ТЕКУЩЕМ geo через rotateIp×N.
   * До первого PDF OK триггер-ошибка (451, pravocaptcha_gate, ERR_*, evaluate
   * timeout и т.п.) может быть отвязана от geo — иногда достаточно сменить IP
   * в пределах того же gateway. Если probe ras/kad после rotateIp проходит —
   * принимаем geo как работающий (probation), не сжигаем changeGeo квоту.
   *
   * Бюджет attempts разделён между вызовами recovery в одном geo — счётчик
   * `_rotateAttemptsInCurrentGeo` живёт пока не сменился geo или не прилетел
   * первый PDF OK. После исчерпания бюджета (default 3) — фолбэк на changeGeo.
   *
   * @param {string} reason
   * @param {(() => boolean) | undefined} shouldStop
   * @returns {Promise<{ ok: boolean, mode?: "rotate", ip?: string|null, attempt?: number, reason?: string }>}
   */
  async _tryRotateInCurrentGeoFirst(reason, shouldStop) {
    if (!this.proxyClient || typeof this.proxyClient.rotateIp !== "function") {
      return { ok: false, reason: "no_rotate_ip" };
    }
    const budget = PDF_SAME_IP_ROTATE_ATTEMPTS;
    const used = this._rotateAttemptsInCurrentGeo;
    if (used >= budget) {
      this.log(
        `[pdf/recover/rotate-first] budget exhausted (${used}/${budget}) — fallback на changeGeo`,
      );
      return { ok: false, reason: "rotate_budget_exhausted" };
    }
    const remaining = budget - used;
    if (!this._currentGeoSig.ip) {
      const snap = await this._measureEgressIpVerified();
      if (snap) {
        this._currentGeoSig = { ...this._currentGeoSig, ip: snap };
        this.log(
          `[pdf/recover/rotate-first] initial egress ip=${snap} (захвачен сейчас)`,
        );
      }
    }
    this.log(
      `[pdf/recover/rotate-first] probation: пробую rotateIp×${remaining} в текущем geo ` +
        `(used=${used}/${budget}, reason=${reason}, initial_ip=${this._currentGeoSig.ip ?? "?"})`,
    );
    for (let i = 1; i <= remaining; i += 1) {
      if (typeof shouldStop === "function" && shouldStop()) {
        return { ok: false, reason: "stopped" };
      }
      this._rotateAttemptsInCurrentGeo += 1;
      const attemptIdx = this._rotateAttemptsInCurrentGeo;
      this.log(`[pdf/recover/rotate-first] rotateIp ${attemptIdx}/${budget}`);
      const rot = await this._rotateIpWithVerifiedEgressChange(
        `pdf-recover rotate-first ${reason} #${attemptIdx}`,
        shouldStop,
      );
      if (rot.stopped) {
        return { ok: false, reason: "stopped" };
      }
      const newIp = rot.ipAfter;
      const dup =
        rot.ipBefore && rot.ipAfter && rot.ipAfter === rot.ipBefore ? "1" : "0";
      this.log(
        `[pdf/recover/rotate-first] rotateIp ${attemptIdx}: measured=${newIp ?? "null"} ` +
          `before=${rot.ipBefore ?? "?"} api_hint=${rot.apiIp ?? "?"} dup=${dup}`,
      );

      if (!newIp) {
        this.log(
          `[pdf/recover/rotate-first] no valid IPv4 after rotate ${attemptIdx} — continue`,
        );
        continue;
      }

      if (!rot.changed) {
        this.log(
          `[pdf/recover/rotate-first] same IP ${newIp} as before rotate — failed, continue`,
        );
        continue;
      }

      if (this._badGeoBlacklist && this._badGeoBlacklist.isIpBad(newIp)) {
        this.log(
          `[pdf/recover/rotate-first] new IP ${newIp} в blacklist — продолжаю`,
        );
        continue;
      }

      // HTTP probe — лёгкая проверка ras/kad через текущий прокси.
      const probe = await this._probeRasKadOverProxy();
      if (!probe.ok) {
        this.log(
          `[pdf/recover/rotate-first] probe BAD: ${probe.reason} (status=${probe.status ?? "?"})`,
        );
        if (newIp && this._badGeoBlacklist) {
          this._badGeoBlacklist.markBad({
            ip: newIp,
            reason: `probe:${probe.reason}`,
          });
        }
        continue;
      }

      // Probe OK — geo жив. Restart surface + probation. Geo не меняли,
      // operator/geoid в _currentGeoSig оставляем, ip обновляем.
      try {
        if (this.proxyClient.resetReportedIpTracking) {
          this.proxyClient.resetReportedIpTracking();
        }
        await this._restartPdfSurface(
          `recover rotate-first #${attemptIdx} probe ok`,
        );
      } catch (e) {
        this.log(
          `[pdf/recover/rotate-first] _restartPdfSurface failed: ${e && e.message}`,
        );
        if (newIp && this._badGeoBlacklist) {
          this._badGeoBlacklist.markBad({
            ip: newIp,
            reason: "restart_failed",
          });
        }
        continue;
      }
      this._currentGeoSig = { ...this._currentGeoSig, ip: newIp };
      this._geoProbation = true;
      this._geoProbationStartedAt = Date.now();
      this.log(
        `[pdf/recover/rotate-first] OK ip=${newIp ?? "?"} attempt=${attemptIdx}/${budget} → probation`,
      );
      return { ok: true, mode: "rotate", ip: newIp, attempt: attemptIdx };
    }
    this.log(
      `[pdf/recover/rotate-first] исчерпан бюджет (${this._rotateAttemptsInCurrentGeo}/${budget}) — fallback на changeGeo`,
    );
    return { ok: false, reason: "rotate_attempts_exhausted" };
  }

  /**
   * Быстрый recovery loop: помечает текущий geo/IP/operator как bad и крутит
   * changeGeo (с exclude по blacklist'у geos+operators+ips), пока не найдёт
   * живой. На каждой успешной смене — HTTP probe ras/kad через прокси: если
   * bad → markBad и идём дальше, не платим Chromium warmup. После
   * RAS_PDF_RECOVER_MAX_ROUNDS подряд плохих делает паузу
   * RAS_PDF_RECOVER_EXHAUSTED_PAUSE_MS. Поведение после паузы:
   *   - loopUntilSuccess=false (default): возвращает {ok:false} — pipeline
   *     уведёт прокси в quarantine sleep (multi-worker сценарий, другие воркеры
   *     забирают очередь).
   *   - loopUntilSuccess=true: после паузы продолжает поиск с round=1
   *     (single-worker / probation — нет смысла спать дальше, никто не возьмёт).
   *
   * `tryRotateFirst=true` (probation + recovery-triggers по
   * `isProbationRotateFirstTrigger`): до первого PDF OK сначала rotateIp×N
   * в текущем geo с HTTP probe; только если бюджет исчерпан или все rotateIp
   * фейлят probe — фоллбэк на mark-bad + changeGeo.
   *
   * @param {{
   *   reason: string,
   *   caseId?: string|null,
   *   pdfUrl?: string|null,
   *   shouldStop?: () => boolean,
   *   tryRotateFirst?: boolean,
   *   loopUntilSuccess?: boolean,
   * }} opts
   * @returns {Promise<{ ok: boolean, geoid?: number|null, operator?: string|null,
   *                     ip?: string|null, round?: number, mode?: "rotate"|"geo",
   *                     attempt?: number, reason?: string }>}
   */
  async _recoverByGeoLoop({
    reason,
    caseId = null,
    pdfUrl = null,
    shouldStop,
    tryRotateFirst = false,
    loopUntilSuccess = false,
  } = {}) {
    if (!this.hasFastGeoRecovery()) {
      return { ok: false, reason: "disabled_or_no_proxy_client" };
    }

    void caseId;
    void pdfUrl;

    // Снимок текущего geo/operator/ip — для rotate-first и для пометки bad'ом
    // на фоллбэке.
    if (
      this._currentGeoSig.geoid === null &&
      this._currentGeoSig.operator === null &&
      this._currentGeoSig.ip === null
    ) {
      try {
        this._currentGeoSig = await this._readCurrentGeoSig();
      } catch {}
    }

    // PRE-STEP: до первого PDF OK на этом geo пробуем rotateIp+probe в текущем
    // geo. Только если бюджет исчерпан или все rotateIp плохие → mark-bad + changeGeo.
    if (tryRotateFirst) {
      const r = await this._tryRotateInCurrentGeoFirst(reason, shouldStop);
      if (r.reason === "stopped") {
        return { ok: false, reason: "stopped" };
      }
      if (r.ok) {
        return {
          ok: true,
          geoid: this._currentGeoSig.geoid ?? null,
          operator: this._currentGeoSig.operator ?? null,
          ip: r.ip ?? null,
          mode: "rotate",
          attempt: r.attempt ?? null,
        };
      }
      // Все попытки в этом geo неудачные → mark-bad geo/operator/ip и идём
      // в changeGeo loop ниже.
    }

    if (this._badGeoBlacklist) {
      const sig = this._currentGeoSig;
      if (sig.geoid != null || sig.ip) {
        // Операторов НЕ блэклистим целиком: у MP всего ~4 оператора в нашем
        // target-пуле (kcell/tele2 KZ + mts/A1 BY + BeelineKG), и блэклист по
        // одному имени отрезает ВСЕ их гео сразу. Geo+IP достаточно — а если
        // другой geo на том же операторе тоже умрёт, мы пометим и его geoid.
        // Видели в проде 2026-05-17: 2286 PDF скачались, потом kcell IP 451,
        // recover пометил kcell(KZ) → отрезало все KZ-kcell гео сразу.
        this._badGeoBlacklist.markBad({
          geoid: sig.geoid,
          ip: sig.ip,
          // operator: null  ← намеренно, см. коммент выше
          reason,
        });
        this.log(
          `[pdf/bad-geo] mark bad geo=${sig.geoid ?? "?"} op=${sig.operator ?? "?"}(skipped) ` +
            `ip=${sig.ip ?? "?"} reason=${reason}`,
        );
      }
    }

    let pid = null;
    try {
      if (typeof this.proxyClient.getResolvedProxyId === "function") {
        pid = await this.proxyClient.getResolvedProxyId();
      }
    } catch {}

    // Diagnostic: provider-side blacklist у MobileProxy. Помогает понять,
    // когда наш changeGeo получает "FAIL equipment busy or unavailable" из-за
    // того, что оборудование заблочено провайдером. Лог только: чистка
    // отдельной командой, см. _maybeClearProviderBlacklistOnce().
    try {
      if (typeof this.proxyClient.getProviderBlacklist === "function") {
        const snap = await this.proxyClient.getProviderBlacklist();
        if (snap.ok) {
          const eqHead = snap.equipment
            .slice(0, 10)
            .map((e) => `geo=${e.geoid ?? "?"}/eid=${e.eid ?? "?"}/op=${e.operator ?? "?"}`)
            .join(", ");
          const opHead = snap.operators
            .slice(0, 10)
            .map((o) => o.operator ?? `id=${o.operatorId}`)
            .join(", ");
          this.log(
            `[mp/blacklist] black_list_equipment=${snap.equipment.length} ` +
              `black_list_operators=${snap.operators.length}` +
              (snap.equipment.length ? ` head_eq=[${eqHead}]` : "") +
              (snap.operators.length ? ` head_op=[${opHead}]` : ""),
          );
        }
      }
    } catch (e) {
      this.log(`[mp/blacklist] snapshot failed: ${e && e.message}`);
    }

    const baseFilters = this.geoFilters ?? PDF_GEO_FILTERS;

    // Внешний цикл — при `loopUntilSuccess` после exhausted_pause возвращаемся
    // на round=1 (blacklist частично остыл по прошествии 30 мин, плюс могло
    // освободиться оборудование у MP). Иначе — break из while после первого
    // exhausted.
    while (true) {
      let exhausted = true;
      for (let round = 1; round <= PDF_RECOVER_MAX_ROUNDS; round += 1) {
        if (typeof shouldStop === "function" && shouldStop()) {
          return { ok: false, reason: "stopped" };
        }

        const badGeoIds = this._badGeoBlacklist
          ? this._badGeoBlacklist.badGeoIds()
          : [];
        const badOperators = this._badGeoBlacklist
          ? this._badGeoBlacklist.badOperators()
          : [];
        const filters =
          badGeoIds.length || badOperators.length
            ? {
                ...baseFilters,
                excludeGeoIds: [
                  ...((baseFilters && baseFilters.excludeGeoIds) ?? []),
                  ...badGeoIds,
                ],
                excludeOperators: [
                  ...((baseFilters && baseFilters.excludeOperators) ?? []),
                  ...badOperators,
                ],
              }
            : baseFilters;

        this.log(
          `[pdf/recover] round ${round}/${PDF_RECOVER_MAX_ROUNDS} changeGeo ` +
            `(blacklist_geos=${badGeoIds.length}, blacklist_ops=${badOperators.length}, ` +
            `reason=${reason})`,
        );
        let r;
        try {
          r = await this.proxyClient.changeGeo(`pdf-recover-loop ${reason}`, {
            filters,
          });
        } catch (e) {
          this.log(`[pdf/recover] changeGeo threw: ${e && e.message}`);
          r = { ok: false, reason: `threw:${e && e.message}` };
        }

        if (!r?.ok) {
          const failReason = r?.reason ?? "unknown";
          this.log(`[pdf/recover] round ${round} changeGeo not ok: ${failReason}`);

          // Сам сожжённый candidate должен попасть в blacklist, иначе
          // следующий changeGeo выберет того же кандидата → bесконечный цикл
          // на одном geoid/operator. Кандидата proxyClient возвращает даже
          // при ok:false (см. network/proxyClient.js → changeGeo).
          if (failReason !== "no-allowed-geo") {
            if (this._badGeoBlacklist) {
              const marked = _markFailedChangeGeoCandidateBad(
                this._badGeoBlacklist,
                r,
                failReason,
              );
              if (marked.marked) {
                this.log(
                  `[pdf/bad-geo] mark failed changeGeo candidate ` +
                    `geo=${marked.geoid ?? "?"} op=${marked.operator ?? "?"} ` +
                    `ip=${marked.ip ?? "?"} ` +
                    `operator_blacklisted=${marked.operatorBlacklisted ? 1 : 0} ` +
                    `equipment_busy=${marked.equipmentBusy ? 1 : 0} ` +
                    `reason=changeGeo_failed:${String(failReason).slice(0, 120)}`,
                );
              } else {
                this.log(
                  `[pdf/bad-geo] failed changeGeo candidate unknown — cannot markBad ` +
                    `(reason=${String(failReason).slice(0, 120)})`,
                );
              }
            } else {
              this.log(
                `[pdf/bad-geo] no blacklist instance — cannot markBad failed changeGeo candidate ` +
                  `(reason=${String(failReason).slice(0, 120)})`,
              );
            }
          }

          if (failReason === "no-allowed-geo") {
            // Pool исчерпан blacklist'ом. У 1-proxy юзера это значит «жди
            // 30 мин cooldown'а» — что неприемлемо. Каскадно чистим:
            //   1) operator-blacklist (мы его уже не пишем, но legacy записи
            //      могут остаться) и geo-blacklist
            //   2) пробуем ещё раз; если опять 0 → IP-blacklist тоже
            // Логика: лучше повторно попасть на IP который недавно был bad'ом,
            // чем стоять впустую. Если он реально мёртв — мы это снова поймаем
            // через probe и заблэклистим заново, потеряв 30с.
            if (this._badGeoBlacklist) {
              const opsCleared = this._badGeoBlacklist.clearOperators();
              const geosCleared = this._badGeoBlacklist.clearGeos();
              this.log(
                `[pdf/recover] no-allowed-geo → auto-clear blacklist ` +
                  `(ops=${opsCleared}, geos=${geosCleared}) и retry round`,
              );
              await _recoverSleep(_recoverPauseRandom(), shouldStop);
              continue; // retry с пустым blacklist'ом
            }
            this.log(`[pdf/recover] no-allowed-geo — нет blacklist'а, выхожу`);
            break;
          }
          // На equipment_busy / mobileproxy_error change_equipment у провайдера
          // НЕ произошла, hard-cooldown в proxyClient НЕ начат — значит
          // следующий round может сразу попробовать другого candidate. Только
          // _recoverPauseRandom (3–5с) для соблюдения MP global rate limit.
          const pauseMs = _recoverPauseRandom();
          if (_isEquipmentBusyReason(failReason)) {
            this.log(
              `[pdf/recover] equipment_busy → no hard-cooldown, next round in ${pauseMs}ms`,
            );
          }
          await _recoverSleep(pauseMs, shouldStop);
          continue;
        }

        // По спеке: `checked[proxy_id]=false` — только подсказка для логов.
        // Финальное решение «жив ли этот geo» принимаем по measure egress IPv4
        // + probe ras/kad ниже, не верим API-флагу. Раньше тут было
        // markBad+continue — это давало ложные срабатывания и впустую
        // выкидывало geo, который при measure+probe оказался бы живым.
        if (_checkedFalseForProxy(r, pid)) {
          this.log(
            `[pdf/recover] checked[${pid ?? "?"}]=false — hint only, проверяю measure+probe`,
          );
        }

        const oldIp = this._currentGeoSig.ip;
        const waitIp = await this._waitEgressIpChangeAfterGeo(oldIp, shouldStop);
        if (waitIp.stopped) {
          return { ok: false, reason: "stopped" };
        }
        let newIp = waitIp.ip;

        if (oldIp && newIp && newIp === oldIp) {
          this.log(
            `[pdf/recover] same checked IP after changeGeo (${newIp}) — ` +
              `пробуем rotateIp перед blacklist`,
          );
          const rot = await this._tryRotateIpAfterSameGeo(oldIp, reason, shouldStop);
          if (rot.reason === "stopped") {
            return { ok: false, reason: "stopped" };
          }
          if (rot.ok && rot.newIp) {
            newIp = rot.newIp;
          } else {
            if (this._badGeoBlacklist) {
              this._badGeoBlacklist.markBad({
                geoid: r.geoid ?? null,
                operator: r.operator ?? null,
                ip: newIp,
                reason: "same_ip_after_geoswap_and_rotates",
              });
            }
            await _recoverSleep(_recoverPauseRandom(), shouldStop);
            continue;
          }
        }

        // Раньше тут был fast-reject `isIpBad(newIp)` — но measure-egress сразу
        // после changeGeo гонит api.ipify.org через модем, который в этот момент
        // ещё может отдавать кешированный/предыдущий IP (см. лог 2026-05-17:
        // changeGeo→KZ Алматы #11, factual egress = 2.72.146.121 KZ Kcell,
        // но _waitEgressIpChangeAfterGeo вернул IP с прошлого BY-rotate'а
        // 178.168.218.50, blacklist его реджектнул, и мы сожгли живой KZ-геозу).
        // Источник правды о «живо ли это гео» — HTTP probe ras/kad ниже, IP-
        // blacklist оставляем только для rotateIp-флоу (там IP стабильный).
        if (newIp && this._badGeoBlacklist && this._badGeoBlacklist.isIpBad(newIp)) {
          this.log(
            `[pdf/recover] new IP ${newIp} формально в blacklist, но это может ` +
              `быть stale-measurement сразу после changeGeo — иду на probe`,
          );
        }

        // HTTP probe — лёгкая проверка ras/kad через прокси до старта warmup.
        let probe = await this._probeRasKadOverProxy();
        if (!probe.ok) {
          this.log(
            `[pdf/recover] round ${round} probe BAD: ${probe.reason} (status=${probe.status ?? "?"})`,
          );
          // По спеке пункт 4: «если probe bad, не делать сразу следующий
          // changeGeo, сначала крутить rotateIp внутри этого geo». Бюджет —
          // PDF_SAME_IP_ROTATE_ATTEMPTS попыток локально для этого раунда.
          // Если хотя бы одна даёт probe OK → принимаем geo. Если все плохи —
          // markBad и идём к следующему changeGeo (старый flow).
          let rotateOk = false;
          let rotateIp = newIp;
          for (
            let rotAttempt = 1;
            rotAttempt <= PDF_SAME_IP_ROTATE_ATTEMPTS;
            rotAttempt += 1
          ) {
            if (typeof shouldStop === "function" && shouldStop()) {
              return { ok: false, reason: "stopped" };
            }
            this.log(
              `[pdf/recover] round ${round} probe-bad → rotateIp ` +
                `${rotAttempt}/${PDF_SAME_IP_ROTATE_ATTEMPTS} в новом geo=${r.geoid ?? "?"}`,
            );
            const rot = await this._rotateIpWithVerifiedEgressChange(
              `pdf-recover probe-bad round=${round} #${rotAttempt}`,
              shouldStop,
            );
            if (rot.stopped) {
              return { ok: false, reason: "stopped" };
            }
            const measured = rot.ipAfter;
            const dup =
              rot.ipBefore && rot.ipAfter && rot.ipAfter === rot.ipBefore
                ? "1"
                : "0";
            this.log(
              `[pdf/recover] round ${round} rotate ${rotAttempt}: measured=${measured ?? "null"} ` +
                `before=${rot.ipBefore ?? "?"} dup=${dup}`,
            );
            if (!measured) {
              this.log(
                `[pdf/recover] round ${round} rotate ${rotAttempt}: no valid IPv4 — next`,
              );
              continue;
            }
            if (!rot.changed) {
              this.log(
                `[pdf/recover] round ${round} rotate ${rotAttempt}: same IP as before rotate — next`,
              );
              continue;
            }
            if (
              this._badGeoBlacklist &&
              this._badGeoBlacklist.isIpBad(measured)
            ) {
              this.log(
                `[pdf/recover] round ${round} rotate ${rotAttempt}: ip=${measured} в blacklist — next`,
              );
              continue;
            }
            probe = await this._probeRasKadOverProxy();
            if (probe.ok) {
              rotateOk = true;
              rotateIp = measured;
              this.log(
                `[pdf/recover] round ${round} rotate ${rotAttempt} probe OK ip=${measured}`,
              );
              break;
            }
            this.log(
              `[pdf/recover] round ${round} rotate ${rotAttempt} probe BAD: ` +
                `${probe.reason} ip=${measured}`,
            );
            if (this._badGeoBlacklist) {
              this._badGeoBlacklist.markBad({
                ip: measured,
                reason: `probe:${probe.reason}`,
              });
            }
          }

          if (!rotateOk) {
            if (this._badGeoBlacklist) {
              this._badGeoBlacklist.markBad({
                geoid: r.geoid ?? null,
                operator: r.operator ?? null,
                ip: newIp,
                reason: `probe:${probe.reason ?? "bad"}_after_rotate`,
              });
            }
            await _recoverSleep(_recoverPauseRandom(), shouldStop);
            continue;
          }
          newIp = rotateIp;
        }

        try {
          await this._completeRecoverGeoRoundSuccess(
            { geoid: r.geoid, operator: r.operator, caption: r.caption },
            newIp,
            round,
          );
        } catch (e) {
          this.log(
            `[pdf/recover] _restartPdfSurface failed: ${e && e.message} — mark bad and retry`,
          );
          if (this._badGeoBlacklist) {
            this._badGeoBlacklist.markBad({
              geoid: r.geoid ?? null,
              operator: r.operator ?? null,
              ip: newIp,
              reason: "restart_failed",
            });
          }
          await _recoverSleep(_recoverPauseRandom(), shouldStop);
          continue;
        }

        return {
          ok: true,
          geoid: r.geoid ?? null,
          operator: r.operator ?? null,
          ip: newIp ?? null,
          round,
          mode: "geo",
        };
      }

      // Pre-условие: exhausted всегда true, кроме break из-за no-allowed-geo
      // (тогда пауза тоже имеет смысл — blacklist остынет).
      void exhausted;

      if (PDF_RECOVER_EXHAUSTED_PAUSE_MS > 0) {
        this.log(
          `[pdf/recover] exhausted ${PDF_RECOVER_MAX_ROUNDS} rounds — pause ` +
            `${PDF_RECOVER_EXHAUSTED_PAUSE_MS}ms${loopUntilSuccess ? " then continue search" : " then return"}`,
        );
        await _interruptibleSleep(PDF_RECOVER_EXHAUSTED_PAUSE_MS, shouldStop);
        if (typeof shouldStop === "function" && shouldStop()) {
          return { ok: false, reason: "stopped" };
        }
      }
      if (!loopUntilSuccess) {
        return { ok: false, reason: "max_rounds_or_no_candidates" };
      }
      // loopUntilSuccess: продолжаем поиск (blacklist частично остыл за время паузы).
    }
  }

  /**
   * Сбросить probation после успешного PDF.
   */
  _clearGeoProbationOnSuccess() {
    if (this._rotateAttemptsInCurrentGeo > 0) {
      this._rotateAttemptsInCurrentGeo = 0;
    }
    if (!this._geoProbation) return;
    this._geoProbation = false;
    const elapsed = Date.now() - this._geoProbationStartedAt;
    this.log(
      `[pdf/probation] cleared after first PDF OK (elapsed=${elapsed}ms) — geo рабочий`,
    );
  }

  /**
   * Probation timeout: если probation активна и прошло > PDF_GEO_CHECK_TIMEOUT_MS
   * без PDF OK — geo «считается плохим».
   */
  _isGeoProbationExpired() {
    if (!this._geoProbation) return false;
    return Date.now() - this._geoProbationStartedAt > PDF_GEO_CHECK_TIMEOUT_MS;
  }

  /**
   * Утилита: пауза между PDF, чтоб не словить ddos-guard.
   * Вызывать после каждого УСПЕШНОГО downloadAndSave (вышестоящим pipeline.js).
   */
  async paceAfterSuccess() {
    const ms = _randomPause();
    await sleep(ms);
    return ms;
  }

  /**
   * Пауза после неуспешного PDF (pipeline). Короче success-паузы — без лишнего
   * простоя на фейлах, но не нулём, чтобы не долбить kad с тем же IP пакетом.
   */
  async paceAfterFailure() {
    const ms = _randomFailPause();
    await sleep(ms);
    return ms;
  }
}

/**
 * Фабрика одного PdfDownloader для конкретного прокси.
 * Используется и в single-proxy режиме, и в multi-IP пуле.
 *
 * @param {{
 *   workDir: string,
 *   logger?: (msg: string) => void,
 *   label?: string,
 *   proxy: {
 *     server: string,
 *     username?: string,
 *     password?: string,
 *     proxyKey?: string,    // для RasProxyClient.changeIp()
 *     proxyId?: number,
 *   },
 *   useProxyApi?: boolean,  // 1 = поднять RasProxyClient (если есть key+token)
 * }} opts
 */
export async function createPdfDownloaderForProxy({
  workDir,
  logger,
  label = "pdf",
  proxy,
  useProxyApi = true,
  badGeoBlacklist = null,
}) {
  if (!proxy?.server) throw new Error("createPdfDownloaderForProxy: proxy.server обязателен");

  let proxyClient = null;
  if (useProxyApi && MP_API_TOKEN && proxy.proxyKey) {
    proxyClient = new RasProxyClient({
      apiToken: MP_API_TOKEN,
      proxyKey: proxy.proxyKey,
      proxyId: proxy.proxyId ?? null,
      minIpRotateGapSec: CHANGE_IP_COOLDOWN_SEC,
      minEquipmentSwapGapSec: ESC_EQUIPMENT_COOLDOWN_SEC,
      minGeoSwapGapSec: CHANGE_GEO_COOLDOWN_SEC,
      logger: logger
        ? (m) => logger(`[${label}] ${m}`)
        : (m) => process.stdout.write(`[${_dlTs()}] [${label}] ${m}\n`),
    });
  } else if (useProxyApi && !proxy.proxyKey) {
    (logger ?? ((m) => process.stdout.write(`[${_dlTs()}] ${m}\n`)))(
      `[${label}] proxyKey не задан — без ротации IP при 429`,
    );
  }

  // Если caller (например legacy direct call) не передал shared blacklist —
  // создаём локальный per-downloader. Основной pipeline в pdf/pipeline.js
  // прокидывает shared instance — там это noop.
  const effectiveBadGeoBlacklist = badGeoBlacklist ?? new BadGeoBlacklist();

  const downloader = new PdfDownloader({
    workDir,
    logger,
    proxyClient,
    proxyServer: proxy.server,
    proxyUser: proxy.username ?? "",
    proxyPass: proxy.password ?? "",
    label,
    badGeoBlacklist: effectiveBadGeoBlacklist,
  });
  await downloader.init();
  await _maybeClearProviderBlacklistOnStart(proxyClient, logger, label);
  return { downloader, proxyClient };
}

/**
 * Если выставлен `RAS_MP_CLEAR_PROVIDER_BLACKLIST_ON_START=1`, единожды на
 * старте downloader'а чистим provider-side blacklist (equipment + operators).
 * По умолчанию НЕ чистим — это «ядерная» операция, без явного флага не лезем.
 */
async function _maybeClearProviderBlacklistOnStart(proxyClient, logger, label) {
  const flag = String(
    process.env.RAS_MP_CLEAR_PROVIDER_BLACKLIST_ON_START ?? "",
  )
    .trim()
    .toLowerCase();
  if (!["1", "true", "yes", "on"].includes(flag)) return;
  if (!proxyClient || typeof proxyClient.clearProviderBlacklist !== "function") {
    return;
  }
  const log = logger ?? ((m) => process.stdout.write(`[${_dlTs()}] ${m}\n`));
  try {
    const res = await proxyClient.clearProviderBlacklist();
    log(
      `[${label}] [mp/blacklist] cleared on start: equipment=${res.equipmentRemoved} ` +
        `operators=${res.operatorsRemoved} errors=${res.errors.length}`,
    );
    for (const err of res.errors.slice(0, 5)) {
      log(`[${label}] [mp/blacklist] clear err: ${err}`);
    }
  } catch (e) {
    log(`[${label}] [mp/blacklist] clear упал: ${e && e.message}`);
  }
}

/**
 * Legacy-фабрика: один downloader из MP_PROXY_* env. Оставлена для обратной
 * совместимости (single-proxy режим без MP_API_TOKEN). Multi-IP флоу
 * использует createPdfPool().
 */
export async function createPdfDownloader({
  workDir,
  logger,
  useProxyApi = true,
  badGeoBlacklist = null,
}) {
  return createPdfDownloaderForProxy({
    workDir,
    logger,
    label: "pdf",
    useProxyApi,
    badGeoBlacklist,
    proxy: {
      server: PROXY_SERVER,
      username: PROXY_USER,
      password: PROXY_PASS,
      proxyKey: MP_PROXY_KEY,
      proxyId: MP_PROXY_ID,
    },
  });
}

/**
 * Multi-IP pool: discover активных прокси аккаунта (или взять whitelist
 * из `MP_PROXY_KEYS`), поднять N параллельных PdfDownloader'ов.
 *
 * Координация с parser.js: каждый proxy_key пытаемся занять в `proxy_leases`
 * (PG). Если ключ уже занят парсером — скипаем его, не поднимаем воркера на
 * нём. Возвращаем `leaseHolderId` — pipeline должен запустить heartbeat и
 * release в shutdown.
 *
 * @param {{
 *   workDir: string,
 *   logger?: (msg: string) => void,
 *   maxWorkers?: number | null,   // null/0 = «auto» = число найденных прокси
 *   useProxyApi?: boolean,
 *   leaseHolderId?: string | null, // если задан — используем его (для shutdown)
 * }} opts
 * @returns {Promise<{
 *   workers: Array<{
 *     label: string,
 *     downloader: PdfDownloader,
 *     proxyClient: RasProxyClient | null,
 *     proxyKey: string | null,
 *   }>,
 *   closeAll: () => Promise<void>,
 *   leaseHolderId: string,
 * }>}
 */
export async function createPdfPool({
  workDir,
  logger,
  maxWorkers = null,
  useProxyApi = true,
  leaseHolderId = null,
  badGeoBlacklist = null,
}) {
  const log = logger ?? ((m) => process.stdout.write(`[${_dlTs()}] ${m}\n`));
  // Один shared blacklist на все воркеры пула: bad-geo, прожжённый одним
  // воркером, не должен повторно сжигаться другим. Если caller передал свой
  // (pipeline.js) — используем его.
  const sharedBadGeoBlacklist = badGeoBlacklist ?? new BadGeoBlacklist();

  /** @type {import("../network/proxyPool.js").ProxyEntry[]} */
  let proxies = [];
  const poolMeta = { providerTotal: 0, discoverEligible: 0 };
  const pdfCountryFilter = [...PDF_POOL_COUNTRY_IDS];
  if (useProxyApi && MP_API_TOKEN) {
    try {
      proxies = await discoverProxies({
        apiToken: MP_API_TOKEN,
        allowedKeys: readAllowedKeysFromEnv(),
        allowedCountryIds: pdfCountryFilter,
        logger: log,
        statsOut: poolMeta,
      });
    } catch (e) {
      if (e && e.code === "POOL_COUNTRY_FILTER_EMPTY") throw e;
      log(`[pool] discoverProxies упал: ${e && e.message} — fallback на single MP_PROXY_*`);
      const single = singleProxyFromEnv();
      if (single) {
        proxies = [single];
        poolMeta.providerTotal = 1;
        poolMeta.discoverEligible = 1;
      }
    }

    // Auto-buy перед формированием пула — если в .env opt-in и баланс позволяет.
    // ВНИМАНИЕ: эта ветка реально тратит деньги аккаунта. См. RAS_AUTO_BUY_* в .env.example.
    const autoBuy = readAutoBuyConfigFromEnv();
    if (autoBuy.enabled) {
      const allowedKeys = readAllowedKeysFromEnv();
      if (allowedKeys && allowedKeys.length) {
        log(
          `[pool/buy] RAS_AUTO_BUY_PROXIES=1 + MP_PROXY_KEYS whitelist одновременно — ` +
            `пропускаю авто-покупку (не понятно какие из whitelist'а уже куплены)`,
        );
      } else {
        const countryId =
          autoBuy.countryId ??
          inferCountryIdFromExisting(proxies) ??
          PDF_AUTO_BUY_DEFAULT_COUNTRY_ID;
        try {
          const result = await autoBuyProxies({
            apiToken: MP_API_TOKEN,
            countryId,
            periodDays: autoBuy.periodDays,
            maxTotalCount: autoBuy.maxTotalCount,
            currentCount: proxies.length,
            logger: log,
          });
          if (result.bought && result.count > 0) {
            log(`[pool/buy] куплено ${result.count} прокси, перерезолвлю getMyProxy()`);
            // MP'у нужно время чтобы новые прокси появились в getMyProxy.
            // На практике ~2-5с; даём 10с с polling.
            for (let i = 0; i < 5; i += 1) {
              await new Promise((r) => setTimeout(r, 2000));
              const fresh = await discoverProxies({
                apiToken: MP_API_TOKEN,
                allowedKeys: null,
                allowedCountryIds: pdfCountryFilter,
                logger: log,
                statsOut: poolMeta,
              });
              if (fresh.length > proxies.length) {
                proxies = fresh;
                break;
              }
            }
          }
        } catch (e) {
          log(`[pool/buy] авто-покупка упала: ${e && e.message} — продолжаю с тем что есть`);
        }
      }
    }
  } else {
    const single = singleProxyFromEnv();
    if (single) proxies = [single];
    poolMeta.providerTotal = proxies.length ? 1 : 0;
    poolMeta.discoverEligible = proxies.length;
    log(
      `[pool] useProxyApi=${useProxyApi}, MP_API_TOKEN=${MP_API_TOKEN ? "set" : "empty"} ` +
        `→ single-proxy fallback (n=${proxies.length})`,
    );
  }

  if (!proxies.length) {
    throw new Error(
      "[pool] нет ни одного прокси — ни через MP_API_TOKEN+getMyProxy, ни через MP_PROXY_SERVER. " +
        "Поставь хотя бы одно в .env (или включи RAS_AUTO_BUY_PROXIES=1 при положительном балансе).",
    );
  }

  let cap = null;
  if (Number.isFinite(maxWorkers) && maxWorkers > 0) cap = Math.floor(maxWorkers);
  const envMaxWorkers = Number(process.env.RAS_PDF_MAX_WORKERS ?? "0");
  if (Number.isFinite(envMaxWorkers) && envMaxWorkers > 0) {
    cap = cap === null ? envMaxWorkers : Math.min(cap, envMaxWorkers);
  }
  let n = proxies.length;
  if (cap !== null && cap > 0) {
    n = Math.min(n, cap);
  }
  if (n < proxies.length) {
    log(
      `[pool] cap=${cap} (RAS_PDF_PARALLEL_DOWNLOADERS / RAS_PDF_MAX_WORKERS), ` +
        `ограничиваю до ${n} из ${proxies.length} прокси`,
    );
    proxies = proxies.slice(0, n);
  }
  const eligibleCount = proxies.length;

  // ── Lease: проверяем, что ни один из proxy_key уже не занят парсером. ──
  // Заполучить ключ = взять «аренду» в proxy_leases. Если ключ занят чужим
  // процессом — выкидываем proxy из пула и логируем, кто его держит.
  const holderId = leaseHolderId ?? _leaseMakeHolderId("pdf");
  const keys = proxies.map((p) => p.proxyKey).filter(Boolean);
  // Self-healing после kill -9: подчищаем «свои же» аренды (этот хост, PID мёртв).
  // Без этого новый запуск долбится в свой висящий heartbeat-продлённый lease.
  const leaseCleanupOnStart = (process.env.RAS_PDF_LEASE_CLEANUP_ON_START ?? "1").trim() !== "0";
  if (leaseCleanupOnStart) {
    // Сначала expired-global: TTL прошёл — строка ничего не «защищает». Безопасно
    // на любом хосте, даже если PID жив но heartbeat почему-то завис.
    try {
      await _leaseReleaseExpiredGlobal({ logger: log });
    } catch (e) {
      log(`[pool/lease] releaseExpiredGlobalLeases упал: ${e && e.message}`);
    }
    try {
      await _leaseReleaseDeadLocal({ role: "pdf", logger: log });
    } catch (e) {
      log(`[pool/lease] releaseDeadLocalLeases упал: ${e && e.message}`);
    }
  } else {
    log(`[pool/lease] RAS_PDF_LEASE_CLEANUP_ON_START=0 — пропускаю cleanup`);
  }
  let leaseResult = { acquired: keys, busy: [] };
  if (keys.length) {
    try {
      leaseResult = await _leaseAcquireMany(keys, "pdf", holderId);
    } catch (e) {
      log(
        `[pool/lease] упал на acquireMany: ${e && e.message} — продолжаю без координации ` +
          `(параллельный парсер может занять тот же IP)`,
      );
    }
  }
  if (leaseResult.busy.length) {
    for (const b of leaseResult.busy) {
      log(
        `[pool/lease] proxy_key=${b.keyMasked ?? b.key?.slice(0, 6) + "…"} занят '${b.role ?? "?"}@${b.holderMasked ?? b.holder}' ` +
          `до ${b.expiresAt ? new Date(b.expiresAt).toISOString() : "?"} — скипаю`,
      );
    }
    const busySet = new Set(leaseResult.busy.map((b) => b.key));
    proxies = proxies.filter((p) => !busySet.has(p.proxyKey));
  }
  if (leaseResult.acquired.length) {
    log(
      `[pool/lease] занято ${leaseResult.acquired.length} proxy_key ` +
        `(holder=${_leaseMaskHolder(holderId)})`,
    );
  }
  if (!proxies.length) {
    // Tagged error: supervisor может отличить «всё занято» от других фатальных
    // ошибок и сделать cleanup+wait вместо crash-loop'а.
    const err = new Error(
      "[pool] все proxy_key заняты другими процессами (parser.js?). " +
        "Supervisor сделает cleanup+wait или остановится по TTL.",
    );
    err.code = "POOL_ALL_LEASED";
    err.details = {
      busy: leaseResult.busy.map((b) => ({
        key: b.key,
        keyMasked: b.keyMasked,
        holder: b.holder,
        holderMasked: b.holderMasked,
        role: b.role,
        expiresAt: b.expiresAt ?? null,
      })),
    };
    throw err;
  }

  const workers = [];
  for (let i = 0; i < proxies.length; i += 1) {
    const p = proxies[i];
    const label = `pdf/w${i + 1}-${p.label}`;
    log(`[pool] поднимаю worker ${label} server=${p.server}`);
    try {
      const { downloader, proxyClient } = await createPdfDownloaderForProxy({
        workDir,
        logger: log,
        label,
        proxy: {
          server: p.server,
          username: p.username,
          password: p.password,
          proxyKey: p.proxyKey,
          proxyId: p.proxyId,
        },
        useProxyApi,
        badGeoBlacklist: sharedBadGeoBlacklist,
      });
      workers.push({
        label,
        downloader,
        proxyClient,
        proxyKey: p.proxyKey ?? null,
        countryId: Number.isFinite(p.countryId) ? Number(p.countryId) : null,
      });
    } catch (e) {
      log(`[pool] worker ${label} не поднялся: ${e && e.message} — пропускаю`);
    }
  }

  if (!workers.length) {
    throw new Error("[pool] ни один worker не поднялся — нечем скачивать");
  }

  const allowedLabel =
    pdfCountryFilter.length > 0 ? pdfCountryFilter.join(",") : "all";
  const leasedCount = proxies.length;
  log(
    `[pdf/proxy-pool] provider_total=${poolMeta.providerTotal} ` +
      `allowed_countries=${allowedLabel} eligible=${eligibleCount} leased=${leasedCount} ` +
      `workers=${workers.length}`,
  );

  const closeAll = async () => {
    await Promise.all(
      workers.map((w) =>
        w.downloader.close().catch((e) => log(`[pool] close ${w.label}: ${e}`)),
      ),
    );
  };

  return { workers, closeAll, leaseHolderId: holderId };
}

export const __test__ = {
  _randomPause,
  _detectChromiumExecutable,
  _resetHttpPdfSemaphoreForTest,
  _resetPdfAggStatsForTest,
  isPdfHttpFirstEnabled,
  _repeat451DeferAfterRecovery,
  classifyPdfInfraError,
  buildKadSessionFailedReturn,
  _extractFailedChangeGeoCandidate,
  _markFailedChangeGeoCandidateBad,
  _isEquipmentBusyReason,
};
