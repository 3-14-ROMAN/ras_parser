/**
 * Общий fingerprint для parser.js и pdf/downloader.js.
 *
 * Раньше в коде были зашиты Chrome/124 и Chrome/131 при том, что Playwright
 * тянет другой Chromium — несовпадение UA / sec-ch-ua / TLS легко триггерит
 * pravocaptcha и DDoS-Guard. Здесь версия читается из
 * `playwright-core/browsers.json` (install-by-default chromium).
 *
 * По умолчанию не подменяем sec-ch-ua* в extraHTTPHeaders: браузер сам шлёт
 * Client Hints, согласованные с бинарником. Переопределение — только через env.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const BROWSERS_JSON = path.join(
  __dirname,
  "..",
  "node_modules",
  "playwright-core",
  "browsers.json",
);

/** Если browsers.json недоступен (редкий деплой без devDeps). */
const FALLBACK_CHROMIUM_VERSION = "147.0.0.0";

let _cachedBundledVersion = null;

function readBundledChromiumBrowserVersion() {
  if (_cachedBundledVersion) return _cachedBundledVersion;
  try {
    const raw = fs.readFileSync(BROWSERS_JSON, "utf-8");
    const data = JSON.parse(raw);
    const row = data.browsers?.find((b) => b.name === "chromium");
    const v = row?.browserVersion;
    if (typeof v === "string" && v.trim()) {
      _cachedBundledVersion = v.trim();
      return _cachedBundledVersion;
    }
  } catch {
    /* ignore */
  }
  _cachedBundledVersion = FALLBACK_CHROMIUM_VERSION;
  return _cachedBundledVersion;
}

/**
 * Полная версия Chrome/Chromium для сегмента `Chrome/x.y.z` в User-Agent.
 * `RAS_CHROME_VERSION` — override, если используете свой `RAS_CHROME` и
 * знаете точную версию движка.
 */
export function getRasChromiumFullVersion() {
  const fromEnv = process.env.RAS_CHROME_VERSION?.trim();
  if (fromEnv) return fromEnv;
  return readBundledChromiumBrowserVersion();
}

/**
 * Per-process детерминированный random seed. Каждый процесс получает свой,
 * но в рамках одного процесса все вызовы `buildRasBrowserFingerprint()`
 * возвращают один и тот же fingerprint (это важно — Card warmup, salto-fetch
 * и POST с hash'ом должны быть на одной session/fingerprint, иначе сервер
 * 451-ит за «session+fingerprint mismatch»).
 *
 * Чтобы изменить fingerprint между процессами (что нам и нужно — pravocaptcha
 * хранит pr_fp blacklist), достаточно перезапустить процесс.
 *
 * Хочешь явно зафиксировать «как раньше» — `RAS_PDF_FP_RANDOMIZE=0`.
 */
const _RANDOMIZE = String(process.env.RAS_PDF_FP_RANDOMIZE ?? "1").trim() !== "0";
function _computeSessionSeed() {
  // Берём env override если есть — позволяет воспроизвести fingerprint при дебаге.
  const ovr = (process.env.RAS_PDF_FP_SEED ?? "").trim();
  if (ovr) {
    let h = 0;
    for (let i = 0; i < ovr.length; i += 1) h = (h * 31 + ovr.charCodeAt(i)) | 0;
    return Math.abs(h);
  }
  // pid + start time + крошечный counter, чтобы reset → новый seed.
  _sessionSeedCounter = (_sessionSeedCounter + 1) | 0;
  return (
    ((process.pid | 0) * 1664525 +
      Date.now() +
      _sessionSeedCounter * 2654435761) &
    0x7fffffff
  );
}
let _sessionSeedCounter = 0;
let _SESSION_SEED = _computeSessionSeed();

function _rngFromSeed(seed) {
  let s = seed | 0 || 1;
  return () => {
    // mulberry32
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _CHROME_VERSIONS_POOL = [
  // Реальные релизы Chromium last 6 месяцев — pravocaptcha не палит на нестандартной версии.
  "144.0.7390.118",
  "145.0.7488.46",
  "146.0.7556.155",
  "147.0.7635.110",
  "147.0.7660.119",
  "148.0.7778.96",
  "148.0.7754.135",
  "149.0.7855.45",
];
const _VIEWPORTS_POOL = [
  { width: 1366, height: 900 },
  { width: 1440, height: 900 },
  { width: 1536, height: 864 },
  { width: 1600, height: 900 },
  { width: 1680, height: 1050 },
  { width: 1920, height: 1080 },
];

let _cachedFp = null;

/**
 * Сбросить кэш fingerprint'а — для случая когда мы знаем что текущий «горит»
 * и нужно перегенерить (например, на supervisor-restart pipeline'а).
 */
export function resetRasBrowserFingerprintCache() {
  _cachedFp = null;
  // Перегенерим SESSION_SEED — иначе rng даёт ТОТ ЖЕ выбор UA/viewport.
  if (!(process.env.RAS_PDF_FP_SEED ?? "").trim()) {
    _SESSION_SEED = _computeSessionSeed();
  }
}

/**
 * @returns {{ userAgent: string, extraHTTPHeaders: Record<string,string>,
 *             viewport: {width:number,height:number}, locale: string,
 *             timezoneId: string, chromeFullVersion: string,
 *             canvasNoiseSeed: number }}
 */
export function buildRasBrowserFingerprint() {
  if (_cachedFp) return _cachedFp;

  const uaOverride = process.env.RAS_USER_AGENT?.trim();
  let chromeFullVersion;
  let viewport;
  let locale = "ru-RU";
  let timezoneId = "Europe/Moscow";

  if (uaOverride) {
    chromeFullVersion = getRasChromiumFullVersion();
    viewport = _VIEWPORTS_POOL[0];
  } else if (!_RANDOMIZE) {
    chromeFullVersion = getRasChromiumFullVersion();
    viewport = { width: 1366, height: 900 };
  } else {
    const rng = _rngFromSeed(_SESSION_SEED);
    chromeFullVersion = _CHROME_VERSIONS_POOL[Math.floor(rng() * _CHROME_VERSIONS_POOL.length)];
    viewport = _VIEWPORTS_POOL[Math.floor(rng() * _VIEWPORTS_POOL.length)];
    // Tz/locale пока не варьируем — RAS русскоязычный, иначе можем получить
    // другой фронт-language.
  }

  const userAgent =
    uaOverride ||
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) " +
      `Chrome/${chromeFullVersion} Safari/537.36`;

  const extraHTTPHeaders = {
    "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
  };

  const secChUa = process.env.RAS_SEC_CH_UA?.trim();
  if (secChUa) {
    extraHTTPHeaders["sec-ch-ua"] = secChUa;
    extraHTTPHeaders["sec-ch-ua-mobile"] = process.env.RAS_SEC_CH_UA_MOBILE?.trim() || "?0";
    extraHTTPHeaders["sec-ch-ua-platform"] =
      process.env.RAS_SEC_CH_UA_PLATFORM?.trim() || '"Linux"';
  }

  _cachedFp = {
    userAgent,
    extraHTTPHeaders,
    viewport,
    locale,
    timezoneId,
    chromeFullVersion,
    // Канонический seed для canvas/audio шума — на нём строим INIT_SCRIPT
    canvasNoiseSeed: _SESSION_SEED & 0xffff,
  };
  return _cachedFp;
}

/**
 * Опции запуска Chromium: убрать маркер автоматизации и выровнять флаги
 * с теми, что уже использовались в проекте.
 */
export function getRasChromiumLaunchAntiDetect() {
  return {
    ignoreDefaultArgs: ["--enable-automation"],
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1366,900",
    ],
  };
}

/**
 * Init-script с anti-detect патчами:
 *   - navigator.webdriver = false
 *   - window.chrome stub
 *   - canvas/audio/webgl/fonts fingerprint noise — рандомизирует pravocaptcha pr_fp
 *
 * pravocaptcha (см. /Content/Static/js/pravocaptcha.202603261714.js) считает
 * pr_fp по canvas getImageData + audioContext + webgl renderer + screen + UA.
 * Без шума pr_fp детерминирован для нашей сборки Chromium → как только pravocaptcha
 * 451-ит этот pr_fp, новый Chromium запуск получает тот же pr_fp → тоже 451.
 *
 * @param {number} seed
 */
function _buildInitScript(seed) {
  // Шум через простой LCG из seed (передаётся в браузер как литерал).
  return `(() => {
  try {
    Object.defineProperty(navigator, "webdriver", {
      get: () => false,
      configurable: true,
    });
  } catch (e) {}
  try {
    if (!window.chrome) window.chrome = {};
    if (!window.chrome.runtime) window.chrome.runtime = {};
  } catch (e) {}

  // Per-session seed для шума (передан с Node).
  const __SEED = ${(seed & 0x7fffffff) | 0};
  let __s = __SEED || 1;
  function __rng() {
    __s = (__s * 1664525 + 1013904223) | 0;
    return ((__s >>> 0) % 256) / 256;
  }

  // 1. Canvas noise: чуть-чуть портим getImageData / toDataURL.
  try {
    const origGetImageData = CanvasRenderingContext2D.prototype.getImageData;
    CanvasRenderingContext2D.prototype.getImageData = function(...args) {
      const data = origGetImageData.apply(this, args);
      // Делаем шум только если canvas похож на fingerprint (<=300px), иначе
      // мешаем нормальной отрисовке.
      if (data.data.length < 1000000) {
        for (let i = 0; i < data.data.length; i += 4) {
          if ((i & 0xff) === ((__SEED >> 4) & 0xff)) {
            data.data[i + 0] ^= 1;
            data.data[i + 1] ^= 1;
            data.data[i + 2] ^= 1;
          }
        }
      }
      return data;
    };
    const origToDataURL = HTMLCanvasElement.prototype.toDataURL;
    HTMLCanvasElement.prototype.toDataURL = function(...args) {
      // Перерисовываем 1px со случайным цветом перед serialize, чтобы
      // итоговый hash отличался от canonical.
      try {
        const ctx = this.getContext("2d");
        if (ctx) {
          const orig = ctx.fillStyle;
          ctx.fillStyle = "rgba(" + (__SEED & 0xff) + "," +
            ((__SEED >> 8) & 0xff) + "," + ((__SEED >> 16) & 0xff) + ",0.005)";
          ctx.fillRect(__SEED % 7, (__SEED >> 3) % 5, 1, 1);
          ctx.fillStyle = orig;
        }
      } catch (e) {}
      return origToDataURL.apply(this, args);
    };
  } catch (e) {}

  // 2. AudioContext noise.
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (AC) {
      const origCopyFromChannel = AnalyserNode.prototype.getFloatFrequencyData;
      AnalyserNode.prototype.getFloatFrequencyData = function(arr) {
        origCopyFromChannel.apply(this, arguments);
        for (let i = 0; i < arr.length; i += 1) {
          arr[i] = arr[i] + (__rng() - 0.5) * 0.0001;
        }
      };
    }
  } catch (e) {}

  // 3. WebGL renderer/vendor варьируем чуть-чуть.
  try {
    const renderers = [
      "ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)",
      "ANGLE (NVIDIA, NVIDIA GeForce GTX 1060/PCIe/SSE2, OpenGL 4.6.0 NVIDIA 535.183.01)",
      "ANGLE (AMD, AMD Radeon RX 580 Series, OpenGL 4.6.16978 Compatibility Profile)",
      "ANGLE (Intel, Mesa Intel(R) Iris Xe Graphics (TGL GT2), OpenGL 4.6)",
    ];
    const vendors = ["Google Inc. (Intel)", "Google Inc. (NVIDIA)", "Google Inc. (AMD)"];
    const pickRenderer = renderers[__SEED % renderers.length];
    const pickVendor = vendors[__SEED % vendors.length];
    const wrap = (proto) => {
      if (!proto) return;
      const orig = proto.getParameter;
      proto.getParameter = function(p) {
        if (p === 37445) return pickVendor;   // UNMASKED_VENDOR_WEBGL
        if (p === 37446) return pickRenderer; // UNMASKED_RENDERER_WEBGL
        return orig.call(this, p);
      };
    };
    wrap(WebGLRenderingContext && WebGLRenderingContext.prototype);
    wrap(WebGL2RenderingContext && WebGL2RenderingContext.prototype);
  } catch (e) {}

  // 4. navigator.hardwareConcurrency и deviceMemory варьируем.
  try {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: () => 4 + (__SEED % 8), // 4..11
      configurable: true,
    });
    Object.defineProperty(navigator, "deviceMemory", {
      get: () => [4, 8, 16, 32][__SEED % 4],
      configurable: true,
    });
  } catch (e) {}
})();`;
}

/**
 * Подмешивает патчи во все страницы контекста (включая будущие).
 * `RAS_DISABLE_BROWSER_ANTIDETECT=1` — для отладки.
 * @param {import('playwright').BrowserContext} context
 */
export async function attachRasAntiDetectToContext(context) {
  if (process.env.RAS_DISABLE_BROWSER_ANTIDETECT === "1") return;
  const fp = buildRasBrowserFingerprint();
  await context.addInitScript(_buildInitScript(fp.canvasNoiseSeed));
}
