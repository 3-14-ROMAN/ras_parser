/**
 * network/proxyPreflight.js — лёгкий HTTP-probe ras.arbitr.ru через текущий
 * Chromium-прокси БЕЗ браузера. Используется parser.js перед первым (и каждым
 * retry) `page.goto()`, чтобы быстро (5-8с) обнаружить мёртвый прокси, не
 * ожидая 45с в Playwright. Если probe вернул 451/timeout — parser.js крутит
 * `_recoverFrom`, не открывая дорогой Chromium-таб.
 *
 * Отличие от `pdf/proxyHealth.js`: тот ходит через MobileProxy.Space anti-cloak
 * API (батч на все страны через 30-60с), а это — голый GET через текущий
 * туннель. Дешёвый, быстрый, делается перед каждой попыткой goto.
 *
 * Контракт чисто-функциональный: только undici + classify, никаких глобалов.
 */

import { ProxyAgent, request } from "undici";

const DEFAULT_TARGET_URL = "https://ras.arbitr.ru/";
const DEFAULT_TIMEOUT_MS = 8_000;
const RAS_BODY_GOOD_MARKER = /b-form-submit|Картотека\s+арбитражных|ras\.arbitr/i;

/**
 * @param {string} proxyServer  e.g. "http://mproxy.site:12695"
 * @param {string} proxyUser
 * @param {string} proxyPass
 * @returns {ProxyAgent | null}
 */
function _buildAgent(proxyServer, proxyUser, proxyPass) {
  if (!proxyServer) return null;
  try {
    const url = new URL(proxyServer);
    if (proxyUser) url.username = encodeURIComponent(proxyUser);
    if (proxyPass) url.password = encodeURIComponent(proxyPass);
    return new ProxyAgent({ uri: url.toString() });
  } catch {
    return null;
  }
}

/**
 * Делает один GET через прокси и классифицирует результат.
 *
 * @param {{
 *   proxyServer: string,
 *   proxyUser?: string,
 *   proxyPass?: string,
 *   targetUrl?: string,
 *   timeoutMs?: number,
 *   userAgent?: string,
 * }} opts
 * @returns {Promise<{ok: boolean, status: number|null, latencyMs: number, reason: string, kind: "ok"|"banned"|"timeout"|"net"|"auth"|"unknown"}>}
 */
export async function probeRasViaProxy(opts) {
  const {
    proxyServer,
    proxyUser = "",
    proxyPass = "",
    targetUrl = DEFAULT_TARGET_URL,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    userAgent = "Mozilla/5.0 ras-parser-preflight/1.0",
  } = opts || {};

  if (!proxyServer) {
    return {
      ok: false,
      status: null,
      latencyMs: 0,
      reason: "no proxy_server configured",
      kind: "unknown",
    };
  }

  const agent = _buildAgent(proxyServer, proxyUser, proxyPass);
  if (!agent) {
    return {
      ok: false,
      status: null,
      latencyMs: 0,
      reason: `bad proxy_server URL: ${proxyServer}`,
      kind: "unknown",
    };
  }

  const t0 = Date.now();
  let status = null;
  let bodySnippet = "";
  try {
    const resp = await request(targetUrl, {
      method: "GET",
      dispatcher: agent,
      headers: {
        "user-agent": userAgent,
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "accept-language": "ru,en;q=0.7",
      },
      bodyTimeout: timeoutMs,
      headersTimeout: timeoutMs,
      signal: AbortSignal.timeout(timeoutMs),
    });
    status = resp.statusCode;
    try {
      const buf = await resp.body.arrayBuffer();
      bodySnippet = Buffer.from(buf).slice(0, 4096).toString("utf8");
    } catch {
      bodySnippet = "";
    }
  } catch (e) {
    const latencyMs = Date.now() - t0;
    const msg = e && e.message ? String(e.message) : String(e);
    let kind = "net";
    if (/UND_ERR_HEADERS_TIMEOUT|UND_ERR_BODY_TIMEOUT|TimeoutError|aborted/i.test(msg)) {
      kind = "timeout";
    } else if (/407|proxy authentication|invalid auth|auth required/i.test(msg)) {
      kind = "auth";
    } else if (/ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(msg)) {
      kind = "net";
    }
    try {
      agent.close().catch(() => {});
    } catch {}
    return {
      ok: false,
      status: null,
      latencyMs,
      reason: `fetch failed [${kind}]: ${msg.slice(0, 200)}`,
      kind,
    };
  } finally {
    try {
      agent.close().catch(() => {});
    } catch {}
  }

  const latencyMs = Date.now() - t0;

  // 451/403/429/5xx — бан/throttle от RAS или провайдера.
  if (status === 451 || status === 403 || status === 429 || (status >= 500 && status <= 525)) {
    return {
      ok: false,
      status,
      latencyMs,
      reason: `http ${status} (likely RAS-bann)`,
      kind: "banned",
    };
  }

  // 200, но без RAS-маркеров в body — это страница капчи/тех-страница.
  if (status >= 200 && status < 300) {
    if (RAS_BODY_GOOD_MARKER.test(bodySnippet)) {
      return { ok: true, status, latencyMs, reason: "ras markers present", kind: "ok" };
    }
    return {
      ok: false,
      status,
      latencyMs,
      reason: "no RAS markers in body — possible captcha/tech page",
      kind: "banned",
    };
  }

  // Другие 3xx/4xx — считаем неудачей с типом banned (RAS обычно 200 либо 451).
  return {
    ok: false,
    status,
    latencyMs,
    reason: `unexpected http ${status}`,
    kind: status >= 400 ? "banned" : "unknown",
  };
}
