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
} from "../db/proxyLeases.js";
import {
  attachRasAntiDetectToContext,
  buildRasBrowserFingerprint,
  getRasChromiumLaunchAntiDetect,
} from "../network/rasBrowserProfile.js";
import { fetchKadPdfViaHttp, withPdfHttpConcurrency, _resetHttpPdfSemaphoreForTest } from "./httpPdfFetch.js";
import {
  shouldBlockThirdPartyAnalyticsUrl,
  shouldLogPdfPageRequestFailed,
} from "./requestRouting.js";

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

const PDF_HTTP_MAX_ATTEMPTS = Math.max(1, Number(process.env.RAS_PDF_HTTP_MAX_ATTEMPTS ?? 3));
const PDF_HTTP_TIMEOUT_MS = Math.max(
  5000,
  Math.min(120_000, Number(process.env.RAS_PDF_HTTP_TIMEOUT_MS ?? 7000)),
);

const RAS_HOME = "https://ras.arbitr.ru/";
const KAD_HOME = "https://kad.arbitr.ru/";
const KAD_CARD = (caseId) => `https://kad.arbitr.ru/Card/${encodeURIComponent(caseId)}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  }) {
    if (!workDir) throw new Error("PdfDownloader: workDir is required");
    this.workDir = workDir;
    this.label = label;
    const baseLog = logger ?? ((m) => process.stdout.write(`${m}\n`));
    this.log = (m) => baseLog(`[${label}] ${m}`);
    this.proxyClient = proxyClient ?? null;
    this.proxyServer = proxyServer || null;
    this.proxyUser = proxyUser ?? "";
    this.proxyPass = proxyPass ?? "";
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
      this.log(
        `[pdf/escalator] PDF-defaults: maxIp=${PDF_ESC_MAX_IP_BEFORE_EQUIPMENT}, ` +
          `maxOp=${PDF_ESC_MAX_OPERATOR_BEFORE_GEO}, ` +
          `forceGeoAfterFails=${PDF_FORCE_GEO_AFTER_FAILS || "off"}, ` +
          `geo=countries=[${PDF_POOL_COUNTRY_IDS.join(",")}]`,
      );
    }

    this._context = null;
    this._userDataDir = null;
    this._page = null;
    /** @type {boolean} ras→kad уже прогрели в этом контексте. */
    this._kadSessionReady = false;
    /** @type {string|null} последний caseId, на который мы заходили в /Card/<...>. */
    this._kadCardCaseId = null;
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
      `[pdf/browser] launch chromium (headless=${PDF_HEADLESS}, proxy=${this.proxyServer ?? "none"}, exe=${exe ?? "default"})`,
    );

    this._context = await chromium.launchPersistentContext(this._userDataDir, {
      headless: PDF_HEADLESS,
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      userAgent: rasFp.userAgent,
      viewport: { width: 1366, height: 900 },
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
        `http_concurrency=${Math.max(1, Number(process.env.RAS_PDF_HTTP_CONCURRENCY ?? process.env.PDF_HTTP_CONCURRENCY ?? 16) || 16)} ` +
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
    await this.init();
    this._sessionPdfSaved = wasSaved;
  }

  /**
   * Фактический egress IPv4/IPv6 через тот же HTTP-прокси, что и браузер.
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
          if (this._escalator) this._escalator.noteSuccess();
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
        // Сбрасываем счётчики эскалатора: следующее падение начнётся с дешёвого
        // changeIp, а не продолжит лестницу с того места, где остановились.
        if (this._escalator) this._escalator.noteSuccess();
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
        : (m) => process.stdout.write(`[${label}] ${m}\n`),
    });
  } else if (useProxyApi && !proxy.proxyKey) {
    (logger ?? ((m) => process.stdout.write(`${m}\n`)))(
      `[${label}] proxyKey не задан — без ротации IP при 429`,
    );
  }

  const downloader = new PdfDownloader({
    workDir,
    logger,
    proxyClient,
    proxyServer: proxy.server,
    proxyUser: proxy.username ?? "",
    proxyPass: proxy.password ?? "",
    label,
  });
  await downloader.init();
  return { downloader, proxyClient };
}

/**
 * Legacy-фабрика: один downloader из MP_PROXY_* env. Оставлена для обратной
 * совместимости (single-proxy режим без MP_API_TOKEN). Multi-IP флоу
 * использует createPdfPool().
 */
export async function createPdfDownloader({ workDir, logger, useProxyApi = true }) {
  return createPdfDownloaderForProxy({
    workDir,
    logger,
    label: "pdf",
    useProxyApi,
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
}) {
  const log = logger ?? ((m) => process.stdout.write(`${m}\n`));

  /** @type {import("../network/proxyPool.js").ProxyEntry[]} */
  let proxies = [];
  const pdfCountryFilter = [...PDF_POOL_COUNTRY_IDS];
  if (useProxyApi && MP_API_TOKEN) {
    try {
      proxies = await discoverProxies({
        apiToken: MP_API_TOKEN,
        allowedKeys: readAllowedKeysFromEnv(),
        allowedCountryIds: pdfCountryFilter,
        logger: log,
      });
    } catch (e) {
      if (e && e.code === "POOL_COUNTRY_FILTER_EMPTY") throw e;
      log(`[pool] discoverProxies упал: ${e && e.message} — fallback на single MP_PROXY_*`);
      const single = singleProxyFromEnv();
      if (single) proxies = [single];
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

  let n = proxies.length;
  if (Number.isFinite(maxWorkers) && maxWorkers > 0) {
    n = Math.min(n, Math.floor(maxWorkers));
  }
  if (n < proxies.length) {
    log(`[pool] RAS_PDF_PARALLEL_DOWNLOADERS=${maxWorkers}, ограничиваю до ${n} из ${proxies.length} прокси`);
    proxies = proxies.slice(0, n);
  }

  // ── Lease: проверяем, что ни один из proxy_key уже не занят парсером. ──
  // Заполучить ключ = взять «аренду» в proxy_leases. Если ключ занят чужим
  // процессом — выкидываем proxy из пула и логируем, кто его держит.
  const holderId = leaseHolderId ?? _leaseMakeHolderId("pdf");
  const keys = proxies.map((p) => p.proxyKey).filter(Boolean);
  // Self-healing после kill -9: подчищаем «свои же» аренды (этот хост, PID мёртв).
  // Без этого новый запуск долбится в свой висящий heartbeat-продлённый lease.
  try {
    await _leaseReleaseDeadLocal({ role: "pdf", logger: log });
  } catch (e) {
    log(`[pool/lease] releaseDeadLocalLeases упал: ${e && e.message}`);
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
        `[pool/lease] proxy_key=${b.key.slice(0, 6)}… занят '${b.role}@${b.holder}' ` +
          `до ${b.expiresAt ? new Date(b.expiresAt).toISOString() : "?"} — скипаю`,
      );
    }
    const busySet = new Set(leaseResult.busy.map((b) => b.key));
    proxies = proxies.filter((p) => !busySet.has(p.proxyKey));
  }
  if (leaseResult.acquired.length) {
    log(
      `[pool/lease] занято ${leaseResult.acquired.length} proxy_key (holder=${holderId})`,
    );
  }
  if (!proxies.length) {
    throw new Error(
      "[pool] все proxy_key заняты другими процессами (parser.js?). " +
        "Останови их или подожди истечения TTL аренды, либо подними больше прокси.",
    );
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
      });
      workers.push({ label, downloader, proxyClient, proxyKey: p.proxyKey ?? null });
    } catch (e) {
      log(`[pool] worker ${label} не поднялся: ${e && e.message} — пропускаю`);
    }
  }

  if (!workers.length) {
    throw new Error("[pool] ни один worker не поднялся — нечем скачивать");
  }

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
};
