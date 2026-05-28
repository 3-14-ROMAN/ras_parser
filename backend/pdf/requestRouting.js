/**
 * Playwright request routing + requestfailed filtering for pdf/downloader.js.
 * Блокируем только стороннюю аналитику/рекламу; kad.arbitr.ru / ras.arbitr.ru не трогаем.
 */

/**
 * @param {string} urlStr
 * @returns {boolean}
 */
export function isRasKadFirstPartyUrl(urlStr) {
  try {
    const h = new URL(urlStr).hostname.toLowerCase();
    return h === "kad.arbitr.ru" || h === "ras.arbitr.ru";
  } catch {
    return false;
  }
}

/**
 * URL скачивания PDF с KAD (salto-fetch) — сюда же попадают повторные GET/POST.
 * @param {string} pathnameLower — уже lowercased pathname
 */
export function isKadPdfDocumentPath(pathnameLower) {
  return pathnameLower.includes("/document/pdf");
}

/**
 * Сторонняя аналитика / реклама — abort в route handler.
 * @param {string} urlStr
 * @returns {boolean}
 */
export function shouldBlockThirdPartyAnalyticsUrl(urlStr) {
  if (isRasKadFirstPartyUrl(urlStr)) return false;
  let u;
  try {
    u = new URL(urlStr);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase();
  const p = u.pathname.toLowerCase();

  if (h === "google-analytics.com" || h.endsWith(".google-analytics.com")) return true;
  if (h === "analytics.google.com" || h.endsWith(".analytics.google.com")) return true;
  if (h === "googletagmanager.com" || h.endsWith(".googletagmanager.com")) return true;
  if (h === "mc.yandex.ru" || h.endsWith(".mc.yandex.ru")) return true;
  if (h === "top-fwz1.mail.ru" || h.endsWith(".top-fwz1.mail.ru")) return true;
  if (h === "vk.com" || h.endsWith(".vk.com")) return true;
  if (h === "doubleclick.net" || h.endsWith(".doubleclick.net")) return true;
  if (h === "privacy-cs.mail.ru" || h.endsWith(".privacy-cs.mail.ru")) return true;
  if ((h === "google.ru" || h.endsWith(".google.ru")) && p.startsWith("/ads")) return true;

  return false;
}

const _STATIC_EXT_RE =
  /\.(png|jpg|jpeg|gif|svg|ico|css|js|wasm|json|map|woff2?|ttf)$/i;

/**
 * Логировать requestfailed только для полезных сбоев kad/ras:
 * document / xhr / fetch, PDF /Document/Pdf, важные API; без статики и без
 * net::ERR_ABORTED на «лёгких» типах (кроме линии скачивания PDF).
 *
 * @param {string} urlStr
 * @param {string} resourceType Playwright Request.resourceType()
 * @param {{ errorText?: string|null }} [opts]
 * @returns {boolean}
 */
export function shouldLogPdfPageRequestFailed(urlStr, resourceType, opts = {}) {
  if (shouldBlockThirdPartyAnalyticsUrl(urlStr)) return false;
  if (!isRasKadFirstPartyUrl(urlStr)) return false;

  let pathname = "";
  try {
    pathname = new URL(urlStr).pathname.toLowerCase();
  } catch {
    return false;
  }

  if (_STATIC_EXT_RE.test(pathname)) return false;

  const rt = String(resourceType || "").toLowerCase();
  const noisyRt = new Set([
    "image",
    "font",
    "manifest",
    "stylesheet",
    "script",
    "media",
    "other",
  ]);
  if (noisyRt.has(rt)) return false;

  const errText = String(opts.errorText || "");
  const errAborted = /err_aborted/i.test(errText);
  const pdfLine = isKadPdfDocumentPath(pathname);

  if (errAborted && rt !== "document" && !pdfLine) {
    return false;
  }

  return rt === "document" || rt === "xhr" || rt === "fetch";
}
