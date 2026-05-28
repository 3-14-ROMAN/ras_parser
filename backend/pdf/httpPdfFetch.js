/**
 * Прямой HTTP GET PDF с kad.arbitr.ru после Playwright-прогрева (куки + заголовки).
 * Salto-challenge (HTML + JS) здесь не обрабатывается — см. fallback на saltoFetch в PdfDownloader.
 */

import { Buffer } from "node:buffer";

import { fetch, ProxyAgent } from "undici";

const PDF_MAGIC = Buffer.from("%PDF");

/** @returns {string} */
function _proxyUri(server, user, pass) {
  const u = new URL(server);
  if (user) u.username = encodeURIComponent(user);
  if (pass) u.password = encodeURIComponent(pass);
  return u.toString();
}

class Semaphore {
  /** @param {number} n */
  constructor(n) {
    this._n = Math.max(1, n);
    /** @type {Array<() => void>} */
    this._wait = [];
  }
  async acquire() {
    if (this._n > 0) {
      this._n -= 1;
      return;
    }
    await new Promise((resolve) => this._wait.push(resolve));
  }
  release() {
    const next = this._wait.shift();
    if (next) next();
    else this._n += 1;
  }
}

let _httpSlots = null;

function _httpConcurrency() {
  const raw =
    process.env.RAS_PDF_HTTP_CONCURRENCY ??
    process.env.PDF_HTTP_CONCURRENCY ??
    process.env.HTTP_CONCURRENCY ??
    "16";
  return Math.max(1, Number(raw) || 16);
}

export function _getHttpPdfSemaphoreForTest() {
  return _httpSlots;
}

export function _resetHttpPdfSemaphoreForTest() {
  _httpSlots = null;
}

function _slots() {
  if (!_httpSlots) _httpSlots = new Semaphore(_httpConcurrency());
  return _httpSlots;
}

/**
 * Ограничение параллельных Node HTTP GET по всему процессу (несколько Chromium-воркеров).
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withPdfHttpConcurrency(fn) {
  const s = _slots();
  await s.acquire();
  try {
    return await fn();
  } finally {
    s.release();
  }
}

/**
 * @param {string | null | undefined} server
 * @param {string} user
 * @param {string} pass
 * @returns {import('undici').ProxyAgent | undefined}
 */
function _makeProxyDispatcher(server, user, pass) {
  if (!server) return undefined;
  const uri = _proxyUri(server, user, pass);
  return new ProxyAgent({ uri });
}

/**
 * @param {Buffer} buf
 * @param {string} ctLower
 */
function _looksLikePdf(buf, ctLower) {
  if (buf.length >= 4 && buf.subarray(0, 4).equals(PDF_MAGIC)) return true;
  if (ctLower.includes("pdf")) return true;
  return false;
}

/**
 * @param {Buffer} buf
 */
function _looksLikeHtml(buf) {
  const s = buf.subarray(0, Math.min(64, buf.length)).toString("utf8").trimStart();
  return s.startsWith("<") || s.toLowerCase().startsWith("<!doctype");
}

/**
 * @param {{
 *   url: string,
 *   cookieHeader: string,
 *   headers: Record<string, string>,
 *   proxyServer?: string | null,
 *   proxyUser?: string,
 *   proxyPass?: string,
 *   maxAttempts?: number,
 *   timeoutMs?: number,
 *   outerSignal?: AbortSignal,
 * }} opts
 * @returns {Promise<
 *   | { ok: true, buffer: Buffer, attempts: number }
 *   | { ok: false, reason: string, status?: number, lastStatus?: number }
 * >}
 */
export async function fetchKadPdfViaHttp(opts) {
  const {
    url,
    cookieHeader,
    headers,
    proxyServer = null,
    proxyUser = "",
    proxyPass = "",
    maxAttempts = 3,
    timeoutMs = 7000,
    outerSignal,
  } = opts;

  const dispatcher = _makeProxyDispatcher(proxyServer, proxyUser, proxyPass);
  const merged = {
    ...headers,
    Accept:
      "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8",
    "Accept-Language":
      headers["Accept-Language"] ||
      headers["accept-language"] ||
      "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  };
  if (cookieHeader) merged.Cookie = cookieHeader;

  let lastStatus;
  let lastReason = "unknown";

  try {
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const onOuter = () => ctrl.abort();
      if (outerSignal) {
        if (outerSignal.aborted) {
          clearTimeout(t);
          return { ok: false, reason: "aborted", lastStatus };
        }
        outerSignal.addEventListener("abort", onOuter, { once: true });
      }
      try {
        /** @type {import('undici').RequestInit} */
        const init = {
          method: "GET",
          redirect: "follow",
          headers: merged,
          signal: ctrl.signal,
        };
        if (dispatcher) init.dispatcher = dispatcher;

        let resp;
        try {
          resp = await fetch(url, init);
        } catch (e) {
          lastStatus = 0;
          lastReason = `network:${e && e.message}`;
          if (attempt < maxAttempts) continue;
          return { ok: false, reason: lastReason, status: 0, lastStatus };
        }

        const status = resp.status;
        lastStatus = status;

        if (status === 401 || status === 403 || status === 429) {
          lastReason = `http_${status}`;
          return { ok: false, reason: lastReason, status, lastStatus: status };
        }

        if (status !== 200) {
          lastReason = `http_${status}`;
          if (attempt < maxAttempts && (status >= 500 || status === 408)) continue;
          return { ok: false, reason: lastReason, status, lastStatus: status };
        }

        const ct = (resp.headers.get("content-type") || "").toLowerCase();

        // Salto / pravocaptcha / защита — повторять HTTP-бессмысленно: сразу наружу (без maxAttempts).
        if (ct.includes("text/html") || ct.includes("application/xhtml")) {
          lastReason = "html_content_type";
          return { ok: false, reason: lastReason, status: 200, lastStatus: 200, attempts: attempt };
        }

        const buf = Buffer.from(await resp.arrayBuffer());

        if (_looksLikeHtml(buf)) {
          lastReason = "html_body";
          return { ok: false, reason: lastReason, status: 200, lastStatus: 200, attempts: attempt };
        }

        if (!_looksLikePdf(buf, ct)) {
          lastReason = "not_pdf";
          if (attempt < maxAttempts) continue;
          return { ok: false, reason: lastReason, status: 200, lastStatus: 200 };
        }

        if (buf.length < 200) {
          lastReason = "tiny_payload";
          if (attempt < maxAttempts) continue;
          return { ok: false, reason: lastReason, status: 200, lastStatus: 200 };
        }

        return { ok: true, buffer: buf, attempts: attempt };
      } catch (e) {
        lastStatus = 0;
        lastReason = e && e.name === "AbortError" ? "timeout" : `throw:${e && e.message}`;
        if (attempt < maxAttempts) continue;
        return { ok: false, reason: lastReason, status: 0, lastStatus };
      } finally {
        clearTimeout(t);
        if (outerSignal) outerSignal.removeEventListener("abort", onOuter);
      }
    }

    return { ok: false, reason: lastReason, status: lastStatus, lastStatus };
  } finally {
    if (dispatcher && typeof dispatcher.close === "function") {
      try {
        await dispatcher.close();
      } catch {
        /* ignore */
      }
    }
  }
}
