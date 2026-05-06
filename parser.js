/**
 * Сбор справочника DocumentType с https://ras.arbitr.ru/.
 *
 * Логика:
 * 1. Поднимаем Chromium через мобильный прокси (HTTP, авторизация по
 *    user/pass из config.js).
 * 2. Открываем ras.arbitr.ru, после load-event прогреваем страницу
 *    через `_stealth.smartWait('warmup')` — рандомное ожидание из
 *    бакетов 5..10с / 10..18с / 25..45с, чтоб WASM-fingerprint и
 *    jQuery успели инициализироваться без машинного «ровно 8 секунд».
 * 3. Опционально: п. 3.1 «поставки» на форме — перед каждым «Найти», если режим включён;
 *    затем период (поля под `#sug-dates`),
 *    затем жмём «Найти» через `_stealth.click(...)` (несколько селекторов +
 *    jQuery-fallback) и ждём первый POST на .../Search; после выдачи — типы РАК
 *    и «Только завершенные», если включены в настройках.
 * 4. Перехватываем url/headers/body первого POST -> /Search и
 *    сохраняем шаблон.
 * 5. Для каждого календарного окна подставляем DateFrom/DateTo в форму
 *    (период поиска), жмём «Найти» и ждём POST /Search — страница 1.
 *    Страницы 2..MAX_PAGES — клик по «вперёд» в пейджере (`ul#pages`),
 *    снова ждём /Search. Между страницами —
 *    `_stealth.smartWait('api_delay')`.
 * 6. Из каждого item достаём TypeId / Type (имя) и копим в dict
 *    (один ключ на id: подпись улучшается, если приходит более длинное
 *    имя или заменяется синтетический id_<uuid>), инкрементально пишем
 *    document_types.json.
 *    Режим decision_links: при включённом фильтре 3.1 на форме доверяем выдаче RAS и
 *    отбору по TypeId; дополнительную проверку карточки kad на 3.1 не делаем.
 * 7. Если страница падает (исключение / not-200 / json-decode) —
 *    идём в `_recoverFrom(...)` через ProxyEscalator (changeIp /
 *    changeOperator / changeGeo по политике kind), затем retry.
 *
 * Антифрод-инвариант: в этом файле НЕТ ни одного `setTimeout`,
 * `waitForTimeout`, `waitForLoadState` и фиксированных числовых
 * пауз — все ожидания идут через бакеты `StealthBrowserManager.smartWait`.
 */

// ВАЖНО: side-effect-импорт ДОЛЖЕН быть первым. Он загружает .env через
// process.loadEnvFile() ДО того, как config.js прочитает process.env.*
// на top-level. Без этого `node parser.js` (без --env-file) уходит
// в 200 попыток goto с ERR_INVALID_AUTH_CREDENTIALS, потому что
// MP_PROXY_USER/PASS пустые.
import "./network/loadEnv.js";

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import util from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import {
  CHANGE_GEO_COOLDOWN_SEC,
  CHANGE_IP_COOLDOWN_SEC,
  ESC_EQUIPMENT_COOLDOWN_SEC,
  ESC_MAX_BUDGET_SEC,
  ESC_MAX_GEO_SWAPS,
  ESC_MAX_IP_BEFORE_EQUIPMENT,
  ESC_MAX_OPERATOR_BEFORE_GEO,
  ESC_PRE_EQUIPMENT_IP_ROTATIONS,
  ESC_MAX_TOTAL_FAILURES,
  GEO_FILTERS,
  MP_API_TOKEN,
  MP_PROXY_ID,
  MP_PROXY_KEY,
  PROXY_PASS,
  PROXY_SERVER,
  PROXY_USER,
  SLOW_RESPONSE_THRESHOLD_MS,
  WINDOW_MIN_DAYS,
  WINDOW_SPLIT_FACTOR,
} from "./network/config.js";
import {
  ESC_KINDS,
  ESC_LEVELS,
  EscalationExhausted,
  ProxyEscalator,
} from "./network/escalator.js";
import { RasProxyClient } from "./network/proxyClient.js";
import { StealthBrowserManager } from "./stealthManager.js";
import { splitWindow } from "./windowSplit.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = __dirname;

const BASE_URL = "https://ras.arbitr.ru/";
const PARSED_DATA_DIR = path.join(PROJECT_DIR, "parsed_data");
const OUT_PATH = path.join(PARSED_DATA_DIR, "document_types.json");

const DEBUG_DIR = path.join(PROJECT_DIR, "debug");
const LINKS_OUT_PATH = path.join(PARSED_DATA_DIR, "decision_links.json");
/** NDJSON отладочной сессии (дублирует ingest; не зависит от localhost:7437). */
const AGENT_DEBUG_LOG_PATH = path.join(
  PROJECT_DIR,
  ".cursor",
  "debug-5afdb1.log",
);

/**
 * Панель комбобокса «Категория спора» по заголовку секции.
 * Якорь XPath устойчивее `#caseCategory` при дубликатах id / смене разметки.
 */
const RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG =
  "//h2[contains(@class,'b-part-header_category')]/following-sibling::div[contains(@class,'b-filter-padding')][1]";
const RAS_CATEGORY_COMBO_ROOT_XPATH =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}`;
const RAS_CATEGORY_DOWN_BUTTON_SEL =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}` +
  "//span[contains(@class,'down-button') and contains(@class,'js-down-button')]";
/** Если верстка потеряла `js-down-button`, остаётся `span.down-button`. */
const RAS_CATEGORY_DOWN_BUTTON_FALLBACK_SEL =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}` +
  "//span[contains(@class,'down-button')]";
/** Открытие списка категории кликом по полю, если стрелки нет в DOM. */
const RAS_CATEGORY_INPUT_CLICK_SEL =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}` +
  "//input[contains(@class,'js-input')]";
/**
 * П. 3.1 в выпадающем списке категории: второй `.b-suggest_liquid-no-overflow`
 * на странице — панель «Категория спора» (первый — «Вид спора»).
 */
const RAS_SUPPLY_FILTER_31_LI_XPATH =
  "xpath=(//div[contains(@class,'b-suggest_liquid-no-overflow')])[2]" +
  "//li[contains(.,'3.1.') and contains(.,'договорам поставки')]";
const RAS_STATUS_FILTER_TOGGLE_XPATH =
  "xpath=//div[contains(@class,'ui-multiselect-bg')]" +
  "[.//span[contains(@class,'ui-multiselect-title') and contains(normalize-space(.),'Статус:')]]";
const RAS_STATUS_FINISHED_OPTION_XPATH =
  "xpath=//span[normalize-space(.)='Только завершенные']";
const RAS_DOC_TYPE_FILTER_TOGGLE_XPATH =
  "xpath=//div[contains(@class,'ui-multiselect-bg')]" +
  "[.//span[contains(@class,'ui-multiselect-title') and contains(normalize-space(.),'Тип документа:')]]";
const RAS_DOC_TYPE_DECISION_OPTION_XPATH =
  "xpath=//span[normalize-space(.)='Решение']";
const RAS_DOC_TYPE_APPEAL_OPTION_XPATH =
  "xpath=//span[contains(normalize-space(.),'Постановление апелляц')]";
const RAS_DOC_TYPE_CASSATION_OPTION_XPATH =
  "xpath=//span[contains(normalize-space(.),'Постановление кассац')]";
/** Период поиска: «с» и «по» (два поля дд.мм.гггг под #sug-dates). */
const RAS_PERIOD_DATE_FROM_XPATH =
  "xpath=(//div[@id='sug-dates']//input[@placeholder='дд.мм.гггг'])[1]";
const RAS_PERIOD_DATE_TO_XPATH =
  "xpath=(//div[@id='sug-dates']//input[@placeholder='дд.мм.гггг'])[2]";

/** П. 3.1 на карточке kad — совпадает с подписью в фильтре RAS «Категория спора». */
const KAD_SUPPLY_DISPUTE_CATEGORY_31_TEXT =
  "3.1. Споры о неисполнении или ненадлежащем исполнении обязательств по договорам поставки";

function _normalizeCategoryProbeBlob(s) {
  return String(s ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

const KAD_SUPPLY_CATEGORY_31_NEEDLE_NORM = _normalizeCategoryProbeBlob(
  KAD_SUPPLY_DISPUTE_CATEGORY_31_TEXT,
);
const KAD_CATEGORY_FIELD_LABEL_NORM = _normalizeCategoryProbeBlob("Категория спора");

function _htmlToPlainForCategoryProbe(html) {
  return String(html ?? "")
    .replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, " ")
    .replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|td|th|li|h\d)\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function _kadHtmlShowsSupplyCategory31(html) {
  const blob = _normalizeCategoryProbeBlob(_htmlToPlainForCategoryProbe(html));
  if (!blob.includes(KAD_CATEGORY_FIELD_LABEL_NORM)) return false;
  return blob.includes(KAD_SUPPLY_CATEGORY_31_NEEDLE_NORM);
}

/** «Ctrl→» внизу выдачи — следующая страница результатов. */
const RAS_PAGER_NEXT_XPATH =
  "xpath=//ul[@id='pages']/li[contains(@class,'rarr')]//a";
const DEBUG_RESPONSES = path.join(DEBUG_DIR, "debug_responses.txt");
const DEBUG_SCREENSHOT = path.join(DEBUG_DIR, "debug_page.png");
const DEBUG_HTML = path.join(DEBUG_DIR, "debug_page.html");
const DEBUG_SEARCH_DIR = path.join(DEBUG_DIR, "search");

/**
 * Сколько раз подряд разрешено перезапустить браузер и заново прогнать
 * то же календарное окно, если провайдер вернул тот же `new_ip` подряд.
 */
const MAX_WINDOW_RECYCLES_AFTER_DUP_IP =
  Number.parseInt(process.env.RAS_MAX_DUP_IP_RECYCLES ?? "8", 10) || 8;

/** Детальные логи клика «Найти» (probe handlers). Без этого — тише. */
const RAS_TRACE_STEALTH = process.env.RAS_TRACE_STEALTH === "1";

/**
 * После успешного L1 `changeIp` при `kind=banned` заново поднять Chromium,
 * снова открыть ras, «Найти» и перехватить POST — те же даты подставит
 * `main` при повторе окна. По умолчанию выключено, чтобы не плодить
 * дополнительные окна браузера в headful-режиме.
 */
const RECYCLE_BROWSER_AFTER_BANNED_L1 =
  (process.env.RAS_RECYCLE_BROWSER_AFTER_BANNED_L1 ?? "0") !== "0";

class RecycleWindowError extends Error {
  constructor(message) {
    super(message);
    this.name = "RecycleWindowError";
  }
}

/**
 * Сигнал «текущее окно дат — слишком тяжёлая выборка для RAS».
 *
 * Бросается из `_walkPagesForBody`, когда один POST `/Search` ответил
 * дольше `SLOW_RESPONSE_THRESHOLD_MS`. Это первый признак, что пул
 * прокси разогрет: антиабуз RAS уже начал нам троттлить, и через
 * несколько запросов прилетит 451. Обработчик в `main()` дробит
 * окно на `WINDOW_SPLIT_FACTOR` подокон, ротейтит IP через
 * `_recoverFrom('banned')` и повторяет запрос на более лёгкой
 * выборке (Query Downgrade + Circuit Breaker).
 *
 * Уже собранные на странице items не теряются — `_walkPagesForBody`
 * сохраняет их через `_save()` после каждой успешной страницы и
 * `documentTypes` дедуплицируется по `TypeId`.
 *
 * @typedef {{ endDay: Date, daysSpan: number, latencyMs: number, pageNum: number }} WindowDowngradeInfo
 */
class WindowDowngradeError extends Error {
  /**
   * @param {string} message
   * @param {WindowDowngradeInfo} info
   */
  constructor(message, info) {
    super(message);
    this.name = "WindowDowngradeError";
    this.info = info;
  }
}

/** Потолок страниц пейджера на одно календарное окно. RAS_MAX_SEARCH_PAGES в .env. */
const MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.RAS_MAX_SEARCH_PAGES ?? "40", 10) || 40,
);

/**
 * Сколько полных раундов (8 попыток + recovery) допустимо на одну страницу
 * выдачи без успешного JSON. Иначе `while (data === null)` крутится вечно.
 */
const MAX_SEARCH_PAGE_DATA_ROUNDS = Math.max(
  5,
  Number.parseInt(process.env.RAS_MAX_SEARCH_PAGE_DATA_ROUNDS ?? "30", 10) || 30,
);

/**
 * Автостоп при подряд идущих пустых «внешних» окнах (нет дел в интервале).
 * ≤0 — выключено (без лимита). Раньше было захардкожено 60.
 */
const RAS_EMPTY_WINDOW_STREAK_LIMIT = (() => {
  const n = Number.parseInt(process.env.RAS_EMPTY_WINDOW_STREAK_LIMIT ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
})();
/** Каждые N страниц пейджера — контроль заголовков РАК/«Статус» (без POST-починки на месте). */
const FILTER_PAGER_TITLE_RECHECK_EVERY = 3;
/** Ожидание POST /Search после «Найти» в heartbeat-режиме (мс). RAS_WAIT_SEARCH_MS, минимум 5с. */
const WAIT_FOR_SEARCH_MS = Math.max(
  5_000,
  Number.parseInt(process.env.RAS_WAIT_SEARCH_MS ?? "60000", 10) || 60_000,
);

const DEFAULT_HEADLESS = (process.env.RAS_HEADLESS ?? "1") === "1";
const XVFB_DISPLAY_NUM = String(process.env.RAS_DISPLAY_NUM ?? "99").trim() || "99";
const XVFB_DISPLAY_ID = `:${XVFB_DISPLAY_NUM}`;
const XVFB_SCREEN_GEOMETRY = process.env.RAS_SCREEN_GEOMETRY ?? "1920x1080x24";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36";
const SEC_CH_UA =
  '"Google Chrome";v="124", "Chromium";v="124", "Not.A/Brand";v="99"';
const SEC_CH_UA_PLATFORM = '"Linux"';

const documentTypes = {};
const decisionLinks = new Map();
const MODE_TYPES = "types";
const MODE_DECISION_LINKS = "decision_links";
const DEFAULT_DECISION_TYPE_IDS = [
  "75babf17-1eef-40df-b51a-92957310aab7",
  "edac92ae-4dbe-49d7-8412-2fc7f4d5e827",
  "ae1a12e4-23b3-4f9a-9c26-3793218ea772",
];
let _currentMode = MODE_TYPES;

const _captured = {
  url: null,
  headers: null,
  body: null,
};

/** Растёт на каждый исходящий POST `/Search` — чтобы отличить новый поиск от уже пойманного шаблона. */
let _searchPostSeq = 0;

/**
 * Колбэк из `main()`: пересоздать Chromium + `_stealth` + перехват /Search.
 * Выставляется один раз при старте.
 * @type {null | (() => Promise<void>)}
 */
let _browserRecycleForDuplicateIp = null;
let _xvfbProcess = null;

function _hasCmd(cmd) {
  const probe = spawnSync("bash", ["-lc", `command -v "${cmd}"`], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function _ensureVirtualDisplayForHeadful(sourceLabel) {
  if (process.platform !== "linux") return true;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;

  if (!_hasCmd("Xvfb")) {
    process.stdout.write(
      `[setup] ${sourceLabel}: DISPLAY не найден и Xvfb не установлен; ` +
        "переключаюсь в headless.\n",
    );
    return false;
  }

  process.stdout.write(
    `[setup] ${sourceLabel}: DISPLAY не найден; поднимаю Xvfb (${XVFB_DISPLAY_ID})...\n`,
  );
  try {
    _xvfbProcess = spawn("Xvfb", [XVFB_DISPLAY_ID, "-screen", "0", XVFB_SCREEN_GEOMETRY], {
      detached: true,
      stdio: "ignore",
    });
    _xvfbProcess.unref();
    process.env.DISPLAY = XVFB_DISPLAY_ID;
    process.stdout.write(`[setup] Xvfb запущен (DISPLAY=${XVFB_DISPLAY_ID}).\n`);
    return true;
  } catch (e) {
    process.stdout.write(
      `[setup] Xvfb не стартовал (${String(e)}); переключаюсь в headless.\n`,
    );
    _xvfbProcess = null;
    return false;
  }
}

function _sanitizeReplayHeaders(headers) {
  const h = { ...(headers || {}) };
  const dropList = new Set([
    "content-length",
    "host",
    ":authority",
    ":method",
    ":path",
    ":scheme",
  ]);
  for (const key of Object.keys(h)) {
    if (dropList.has(key.toLowerCase())) delete h[key];
  }
  return h;
}

const _responseLog = [];
let _firstItemLogged = false;
let _searchDumpIdx = 0;

/**
 * Единственный «легальный» источник пауз во всём parser.js — это
 * `_stealth.smartWait(...)`. В этом файле НЕТ ни одного `setTimeout`,
 * `waitForTimeout`, `waitForLoadState` и фиксированных числовых
 * интервалов в логике парсинга. Все ожидания идут через бакеты
 * рандомизатора в StealthBrowserManager.
 *
 * @type {StealthBrowserManager | null}
 */
let _stealth = null;

/**
 * Эскалатор восстановления (обязательный): ProxyEscalator
 * с лестницей changeIp → changeOperator → changeGeo.
 *
 * @type {ProxyEscalator | null}
 */
let _escalator = null;

const monotonic = () => performance.now() / 1000;

// #region agent log
function _agentDebugLog(location, message, data, hypothesisId) {
  const payload = {
    sessionId: "5afdb1",
    location,
    message,
    data,
    hypothesisId,
    timestamp: Date.now(),
  };
  try {
    fs.mkdirSync(path.dirname(AGENT_DEBUG_LOG_PATH), { recursive: true });
    fs.appendFileSync(AGENT_DEBUG_LOG_PATH, `${JSON.stringify(payload)}\n`, "utf8");
  } catch (e) {
    log(`[agent-debug] запись ${AGENT_DEBUG_LOG_PATH}: ${e}`);
  }
  fetch("http://localhost:7437/ingest/92c381b7-7965-4e93-9977-dd75f5f783f1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "5afdb1",
    },
    body: JSON.stringify(payload),
  }).catch(() => {});
}
// #endregion

function pad2(n) {
  return String(n).padStart(2, "0");
}

function log(msg) {
  const d = new Date();
  const ts = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const text =
    typeof msg === "string"
      ? msg
      : msg instanceof Error
        ? `${msg.name}: ${msg.message}`
        : util.inspect(msg, {
            depth: 8,
            breakLength: 120,
            maxStringLength: 4_000,
          });
  process.stdout.write(`[${ts}] ${text}\n`);
}

function _dumpSearchResponse(label, body, suffix = "json") {
  if (body === null || body === undefined) return null;
  try {
    fs.mkdirSync(DEBUG_SEARCH_DIR, { recursive: true });
  } catch (e) {
    log(`[debug/search] не создал ${DEBUG_SEARCH_DIR}: ${e}`);
    return null;
  }
  _searchDumpIdx += 1;
  const safeLabel = Array.from(String(label))
    .map((c) => (/[A-Za-z0-9\-_]/.test(c) ? c : "_"))
    .join("");
  const fname = `${String(_searchDumpIdx).padStart(3, "0")}_${safeLabel}.${suffix}`;
  const p = path.join(DEBUG_SEARCH_DIR, fname);
  try {
    if (Buffer.isBuffer(body)) {
      fs.writeFileSync(p, body);
    } else {
      fs.writeFileSync(p, body, "utf-8");
    }
    const length = Buffer.isBuffer(body) ? body.length : Buffer.byteLength(body, "utf-8");
    log(`[debug/search] сохранил ${p} (${length} байт)`);
    return p;
  } catch (e) {
    log(`[debug/search] не записал ${p}: ${e}`);
    return null;
  }
}

function _detectChromiumExecutable() {
  // Берём самый свежий chromium-* бинарь из ms-playwright кеша.
  // Это нужно, чтобы не залипнуть на старом chromium, у которого
  // некоторые мобильные прокси отдают ERR_TUNNEL_CONNECTION_FAILED.
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  let stat;
  try {
    stat = fs.statSync(cache);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(cache);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith("chromium-")) continue;
    const suffix = name.slice("chromium-".length);
    if (!/^\d+$/.test(suffix)) continue;
    const exe = path.join(cache, name, "chrome-linux64", "chrome");
    let estat;
    try {
      estat = fs.statSync(exe);
    } catch {
      continue;
    }
    if (estat.isFile()) {
      candidates.push([parseInt(suffix, 10), exe]);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b[0] - a[0]);
  return candidates[0][1];
}

function _launchKwargs() {
  const kwargs = {
    headless: DEFAULT_HEADLESS,
    proxy: {
      server: PROXY_SERVER,
      username: PROXY_USER,
      password: PROXY_PASS,
    },
    args: [
      "--disable-blink-features=AutomationControlled",
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--window-size=1366,900",
    ],
  };
  const exe = process.env.RAS_CHROME || _detectChromiumExecutable();
  if (exe) {
    kwargs.executablePath = exe;
  }
  return kwargs;
}

function _isSearchUrl(u) {
  let pathname;
  try {
    pathname = new URL(u).pathname;
  } catch {
    return false;
  }
  return pathname.toLowerCase().endsWith("/search");
}

function _loadExisting() {
  const sourcePath = OUT_PATH;
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    log(`[load] ${OUT_PATH} нет — стартуем с пустого справочника`);
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(sourcePath, "utf-8");
  } catch (e) {
    log(`[load] не прочитал ${sourcePath}: ${e}`);
    return;
  }
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log(`[load] ${sourcePath} битый JSON (${e}) — игнорирую, не перезаписываю`);
    return;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    log(`[load] ${sourcePath} не dict (${typeof data}) — игнорирую`);
    return;
  }
  const pairs = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && typeof k === "string") {
      pairs.push([k, v]);
    }
  }
  const idToKey = new Map();
  const idToVal = new Map();
  for (const [nameKey, idVal] of pairs) {
    const idStr = String(idVal);
    if (!idToVal.has(idStr)) idToVal.set(idStr, idVal);
    const prevKey = idToKey.get(idStr);
    if (!prevKey) {
      idToKey.set(idStr, nameKey);
    } else if (_shouldUpgradeTypeLabel(prevKey, nameKey, idStr)) {
      idToKey.set(idStr, nameKey);
    }
  }
  for (const k of Object.keys(documentTypes)) delete documentTypes[k];
  for (const [idStr, nameKey] of idToKey) {
    documentTypes[nameKey] = idToVal.get(idStr);
  }
  log(
    `[load] из ${sourcePath}: записей=${pairs.length}, уникальных id=${idToKey.size}`,
  );
}

function _save() {
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(documentTypes, null, 4),
    "utf-8",
  );
}

function _extractDocType(item) {
  let typeId = item.TypeId ?? item.DocumentTypeId ?? null;
  let typeName = null;

  const raw = item.Type ?? item.DocumentType;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    typeName = raw.Name ?? raw.name ?? null;
    if (typeId === null || typeId === undefined) {
      typeId = raw.Id ?? raw.id ?? null;
    }
  } else if (typeof raw === "string") {
    typeName = raw;
  }

  if (!typeName) {
    typeName = item.TypeName ?? item.DocumentTypeName ?? null;
  }

  return [typeId, typeName];
}

function _normalizeTypeIdsInput(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return Array.from(
    new Set(
      s
        .split(/[,\s;]+/)
        .map((v) => _normalizeTypeIdValue(v))
        .filter(Boolean),
    ),
  );
}

function _normalizeTypeIdValue(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // Терминальный ввод часто приходит как "uuid", 'uuid', [uuid], {uuid}.
  const cleaned = s.replace(/^[\s"'`[{(]+|[\s"'`\]})]+$/g, "").trim();
  return cleaned.toLowerCase();
}

function _buildDecisionPdfUrl(item) {
  const caseId = item?.CaseId ?? null;
  const docId = item?.Id ?? null;
  const fileName = item?.FileName ?? null;
  if (!caseId || !docId || !fileName) return null;
  return `https://kad.arbitr.ru/Document/Pdf/${caseId}/${docId}/${fileName}`;
}

function _buildCaseCardUrl(item) {
  const caseId = item?.CaseId ?? null;
  if (!caseId) return null;
  return `https://kad.arbitr.ru/Card/${caseId}`;
}

function _buildDecisionMetadata(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return {};
  return { ...item };
}

function _buildDecisionRecord(item, typeId, pdfUrl) {
  const [typeIdFromItem, typeName] = _extractDocType(item);
  const cardUrl = _buildCaseCardUrl(item);
  return {
    link: pdfUrl,
    pdfLink: pdfUrl,
    cardLink: cardUrl,
    typeId,
    typeName: typeName != null ? String(typeName).trim() || null : null,
    id: item?.Id ?? null,
    caseId: item?.CaseId ?? null,
    fileName: item?.FileName ?? null,
    registrationDate: item?.RegistrationDate ?? null,
    displayDate: item?.DisplayDate ?? null,
    metadata: _buildDecisionMetadata(item),
    // На случай редкого расхождения сырого и нормализованного id типа.
    sourceTypeId: typeIdFromItem ?? null,
  };
}

function _extractDocumentTypeId(item) {
  // В ответе RAS id типа документа чаще всего приходит в `TypeId`.
  // Пользователь задаёт именно DocumentTypeId, поэтому здесь считаем
  // TypeId и DocumentTypeId эквивалентными представлениями одного id.
  const raw =
    item?.DocumentTypeId ?? item?.TypeId ?? item?.DocumentType?.Id ?? item?.Type?.Id ?? null;
  if (raw === null || raw === undefined) return "";
  return _normalizeTypeIdValue(raw);
}

function _saveDecisionLinks() {
  const rows = [...decisionLinks.values()].map((row, idx) => ({
    n: idx + 1,
    ...row,
  }));
  const payload = {
    summary: { total: rows.length },
    results: rows,
  };
  fs.writeFileSync(LINKS_OUT_PATH, JSON.stringify(payload, null, 2), "utf-8");
}

/**
 * Карточка дела на kad (HTML): в блоке «Категория спора» должен быть п. 3.1 (поставки).
 * GET через контекст страницы RAS — вкладка выдачи не уходит с arbitr.ru.
 *
 * @returns {Promise<boolean>}
 */
async function _verifyKadCardShowsSupplyCategory31(page, cardUrl) {
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const resp = await page.request.get(cardUrl, { timeout: 120_000 });
      const status = resp.status();
      if (status !== 200) {
        lastErr = `http=${status}`;
        await _stealth.smartWait("reading");
        continue;
      }
      const html = await resp.text();
      if (_kadHtmlShowsSupplyCategory31(html)) return true;
      return false;
    } catch (e) {
      lastErr = String(e && e.message ? e.message : e);
      await _stealth.smartWait("reading");
    }
  }
  log(`[links-category] не удалось проверить карточку ${cardUrl}: ${lastErr}`);
  return false;
}

/**
 * @param {Map<string, boolean> | null} [kadCaseCategory31Cache]
 *        один запрос kad на CaseId за проход `_walkPagesForBody` (в выдаче одно дело
 *        может повторяться на нескольких страницах с разными Id документов).
 * @param {Set<string> | null} [kadCategorySkipLogged] ключ CaseId или cardUrl — один `[links-skip]` на дело за окно.
 * @param {boolean} [trustRasSupplyCategory31=false] фильтр 3.1 уже задан на RAS — не ходим на kad.
 * @returns {Promise<{ added: number, skippedCategory: number }>}
 */
async function _collectDecisionLinks(
  items,
  targetTypeIdsSet,
  page,
  kadCaseCategory31Cache = null,
  kadCategorySkipLogged = null,
  trustRasSupplyCategory31 = false,
) {
  let added = 0;
  let skippedCategory = 0;
  for (const item of items) {
    const documentTypeId = _extractDocumentTypeId(item);
    if (!documentTypeId || !targetTypeIdsSet.has(documentTypeId)) continue;

    const pdfUrl = _buildDecisionPdfUrl(item);
    if (!pdfUrl) continue;

    const key =
      String(item?.Id ?? "").trim() ||
      [item?.CaseId ?? "", item?.FileName ?? "", item?.RegistrationDate ?? ""].join("|");
    if (!key || decisionLinks.has(key)) continue;

    const cardUrl = _buildCaseCardUrl(item);
    if (!cardUrl) continue;

    const caseIdRaw = item?.CaseId;
    const caseId =
      caseIdRaw !== undefined && caseIdRaw !== null
        ? String(caseIdRaw).trim()
        : "";

    let categoryOk;
    if (trustRasSupplyCategory31) {
      categoryOk = true;
    } else if (caseId && kadCaseCategory31Cache && kadCaseCategory31Cache.has(caseId)) {
      categoryOk = kadCaseCategory31Cache.get(caseId);
    } else {
      categoryOk = await _verifyKadCardShowsSupplyCategory31(page, cardUrl);
      if (caseId && kadCaseCategory31Cache) {
        kadCaseCategory31Cache.set(caseId, categoryOk);
      }
    }

    if (!categoryOk) {
      skippedCategory += 1;
      const logKey = caseId || cardUrl;
      const shouldLog =
        !kadCategorySkipLogged || !kadCategorySkipLogged.has(logKey);
      if (shouldLog) {
        if (kadCategorySkipLogged) kadCategorySkipLogged.add(logKey);
        log(
          `[links-skip] дело ${caseId || "?"} — на карточке kad нет категории спора 3.1 (поставки)`,
        );
      }
      await _stealth.smartWait("api_delay");
      continue;
    }

    decisionLinks.set(key, _buildDecisionRecord(item, documentTypeId, pdfUrl));
    added += 1;
    await _stealth.smartWait("api_delay");
  }
  return { added, skippedCategory };
}

function _rebuildIdToKeyIndex() {
  const m = new Map();
  for (const k of Object.keys(documentTypes)) {
    m.set(String(documentTypes[k]), k);
  }
  return m;
}

function _isSyntheticTypeKey(key, idStr) {
  return key === `id_${idStr}`;
}

function _shouldUpgradeTypeLabel(oldKey, newName, idStr) {
  const nn = newName != null ? String(newName).trim() : "";
  if (!nn) return false;
  if (_isSyntheticTypeKey(oldKey, idStr)) return true;
  const ok = String(oldKey);
  if (nn.length > ok.length) return true;
  if (nn.length < ok.length) return false;
  return nn !== ok;
}

function _nameKeyTakenByOtherId(nameTrim, idStr) {
  if (!Object.prototype.hasOwnProperty.call(documentTypes, nameTrim)) {
    return false;
  }
  return String(documentTypes[nameTrim]) !== idStr;
}

function _processItems(items) {
  if (items.length && !_firstItemLogged) {
    const sample = items[0];
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      log(`[items] ключи первого item: ${JSON.stringify(Object.keys(sample).sort())}`);
    }
    _firstItemLogged = true;
  }

  const idToKey = _rebuildIdToKeyIndex();
  let added = 0;
  let relabeled = 0;

  for (const item of items) {
    const [typeId, typeName] = _extractDocType(item);
    if (typeId === null || typeId === undefined) continue;

    const idStr = String(typeId);
    const nameTrim =
      typeName != null && String(typeName).trim()
        ? String(typeName).trim()
        : null;
    const placeholderKey = `id_${idStr}`;

    const curKey = idToKey.get(idStr);

    if (!nameTrim) {
      if (!curKey) {
        documentTypes[placeholderKey] = typeId;
        idToKey.set(idStr, placeholderKey);
        added += 1;
      }
      continue;
    }

    if (!curKey) {
      let storeKey = nameTrim;
      if (_nameKeyTakenByOtherId(nameTrim, idStr)) {
        log(
          `[items] id=${idStr}: имя «${nameTrim}» занято другим типом — ` +
            `ключ ${placeholderKey}`,
        );
        storeKey = placeholderKey;
      }
      documentTypes[storeKey] = typeId;
      idToKey.set(idStr, storeKey);
      added += 1;
      continue;
    }

    if (curKey === nameTrim) continue;

    if (!_shouldUpgradeTypeLabel(curKey, nameTrim, idStr)) continue;

    if (_nameKeyTakenByOtherId(nameTrim, idStr)) {
      log(
        `[items] id=${idStr}: не переименовываю в «${nameTrim}» — ` +
          "ключ занят другим id",
      );
      continue;
    }

    delete documentTypes[curKey];
    documentTypes[nameTrim] = typeId;
    idToKey.set(idStr, nameTrim);
    relabeled += 1;
  }

  return { added, relabeled };
}

function _onRequest(request) {
  if (request.method() === "POST" && _isSearchUrl(request.url())) {
    _searchPostSeq += 1;
  }
  const rtype = request.resourceType();
  if (rtype === "xhr" || rtype === "fetch" || rtype === "document") {
    _responseLog.push(`REQ ${request.method()} ${rtype} ${request.url()}`);
  }
}

function _onRequestFailed(request) {
  const failure = request.failure()?.errorText || "<no failure text>";
  _responseLog.push(
    `FAIL ${request.method()} ${request.resourceType()} ${request.url()} :: ${failure}`,
  );
  if (_isSearchUrl(request.url())) {
    log(`[net] /Search FAILED: ${failure}`);
  }
}

async function _onResponse(response) {
  const request = response.request();
  const rtype = request.resourceType();
  if (rtype === "xhr" || rtype === "fetch" || rtype === "document") {
    _responseLog.push(
      `${response.status()} ${request.method()} ${rtype} ${response.url()}`,
    );
  }

  if (!_isSearchUrl(response.url())) return;
  if (request.method() !== "POST") return;

  const headers = response.headers();
  log(
    `[capture] /Search ответ status=${response.status()}, ct=${headers["content-type"] ?? "?"}`,
  );

  if (response.status() !== 200) {
    log(`[capture] /Search status=${response.status()} — пропуск захвата`);
    return;
  }

  // Только метаданные запроса — не трогаем response.body()/json(), иначе гонка
  // с `waitForResponse` в `_uiRunSearchFromForm` / `_uiClickPagerNext`.
  if (_captured.url === null) {
    _captured.url = response.url();
    _captured.headers = request.headers();
    _captured.body = request.postData();
    log(`[capture] Перехвачен POST ${response.url()}`);
    const reqBody = _captured.body;
    if (reqBody) {
      try {
        _dumpSearchResponse("page1-request", String(reqBody), "json");
      } catch (e) {
        log(`[capture] дамп тела запроса упал: ${e}`);
      }
    }
  }
}

function _findItemsAnywhere(data) {
  const candidates = [];
  if (data.Result && typeof data.Result === "object" && !Array.isArray(data.Result)) {
    candidates.push(data.Result.Items);
    candidates.push(data.Result.items);
  }
  candidates.push(data.Items);
  candidates.push(data.items);
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    candidates.push(data.data.Items);
  }
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
}

/**
 * Ответ /Search сразу после «Найти» по периоду: если дел нет, блок с фильтрами
 * «Тип документа» / «Статус» не появляется — их нельзя кликать.
 *
 * @param {object|null} parsed тело ответа /Search (JSON)
 * @returns {boolean} true — выдача пустая, верхние фильтры трогать нельзя
 */
function _rasListingEmptyBeforeTopFilters(parsed) {
  if (!parsed || typeof parsed !== "object") return true;
  const result = parsed.Result;
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    return true;
  }
  const tc = result.TotalCount;
  if (typeof tc === "number") return tc === 0;
  return _findItemsAnywhere(parsed).length === 0;
}

/** Обновить шаблон POST /Search из ответа (request headers/body). */
function _syncCapturedFromSearchResponse(response) {
  try {
    const req = response.request();
    _captured.url = response.url();
    _captured.headers = req.headers();
    const pd = req.postData();
    if (pd) _captured.body = pd;
  } catch (e) {
    log(`[capture] _syncCapturedFromSearchResponse: ${e}`);
  }
}

/**
 * Дождаться конкретного ответа POST `/Search`, синхронизировать шаблон `_captured`,
 * вернуть разобранный JSON (для верхних фильтров РАК/«Статус», где подряд идут
 * несколько POST и нельзя цепляться за первый ответ).
 *
 * @param {Promise<import('playwright').Response>} respPromise
 * @param {string} dumpLabelPrefix
 * @param {number} [roundtripStartPerf] — `performance.now()` сразу перед `waitForResponse`
 *        для этого POST; если задан, в успешном ответе будет `roundtripMs` (ожидание до
 *        прихода ответа `/Search`, без парсинга JSON и без UI до клика).
 * @returns {Promise<{ ok: true, parsed: object, roundtripMs?: number } | { ok: false, reason: string }>}
 */
async function _awaitPostSearchJson(respPromise, dumpLabelPrefix, roundtripStartPerf) {
  let response;
  try {
    response = await respPromise;
  } catch (e) {
    void respPromise.catch(() => {});
    return { ok: false, reason: `wait-response: ${e}` };
  }
  const roundtripMs =
    typeof roundtripStartPerf === "number"
      ? performance.now() - roundtripStartPerf
      : undefined;
  _syncCapturedFromSearchResponse(response);
  let raw = null;
  try {
    raw = await response.body();
  } catch (e) {
    log(`[filter] ${dumpLabelPrefix} resp.body() упал: ${e}`);
  }
  if (raw !== null && raw !== undefined) {
    _dumpSearchResponse(
      `${dumpLabelPrefix}-status${response.status()}`,
      raw,
      "bin",
    );
  }
  if (response.status() !== 200) {
    return { ok: false, reason: `status=${response.status()}` };
  }
  try {
    const text =
      raw !== null && raw !== undefined
        ? raw.toString("utf8")
        : await response.text();
    const parsed = JSON.parse(text);
    return { ok: true, parsed, roundtripMs };
  } catch (e) {
    return { ok: false, reason: `json-decode: ${e}` };
  }
}

const ESC_KIND_BANNED = ESC_KINDS.BANNED;
const ESC_KIND_NET_DOWN = ESC_KINDS.NET_DOWN;

/**
 * «Прокси-туннель дрогнул»: HTTP-CONNECT к мобильному прокси не открылся
 * или закрылся в момент TLS-туннелирования. Это НЕ лечится ротацией IP —
 * виноват апстрим прокси-провайдера, новый IP не починит сломанный
 * туннелировщик. Лечится коротким backoff'ом и повторной попыткой
 * на том же IP (см. `'proxy_flap'`-бакет в `stealthManager.js`).
 *
 * Покрывает Chromium-коды, которые в наших измерениях соответствуют
 * `Proxy CONNECT aborted` / `connection to proxy closed`:
 *   - ERR_EMPTY_RESPONSE        — прокси принял CONNECT и оборвал;
 *   - ERR_TUNNEL_CONNECTION_FAILED;
 *   - ERR_PROXY_CONNECTION_FAILED;
 *   - ERR_SOCKS_CONNECTION_FAILED;
 *   - ERR_CONNECTION_CLOSED      — закрытие на полпути;
 *   - ERR_CONNECTION_ABORTED     — то же.
 *
 * `ERR_CONNECTION_RESET` сюда сознательно НЕ включён: сайт за прокси
 * тоже может прислать TCP RST (например, при бане), и для нас это
 * `_isRotatableNetworkError`, а не флап.
 */
function _isProxyTunnelFlap(err) {
  if (!err) return false;
  const s = `${err && err.message ? err.message : err}`;
  return /net::ERR_(EMPTY_RESPONSE|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_CLOSED|CONNECTION_ABORTED)\b/i.test(
    s,
  );
}

/**
 * `ERR_INVALID_AUTH_CREDENTIALS` (Chromium) и связанные коды —
 * провайдер отверг логин/пароль на CONNECT. Ротация IP, смена
 * оборудования и cooldown'ы тут БЕСПОЛЕЗНЫ: это конфиг, а не сеть.
 * Любой такой код = fail-fast, чтобы не сжигать 200 попыток впустую,
 * как было видно в логе при запуске без `--env-file=.env`.
 */
function _isProxyAuthError(err) {
  if (!err) return false;
  const s = `${err && err.message ? err.message : err}`;
  return /net::ERR_(INVALID_AUTH_CREDENTIALS|PROXY_AUTH_REQUESTED|PROXY_AUTH_UNSUPPORTED)\b/i.test(
    s,
  );
}

/**
 * «Настоящая сетевая ошибка/таймаут», для которой имеет смысл крутить
 * мобильный IP: либо сеть на нашей стороне сдохла, либо сайт нас
 * целенаправленно режет.
 *
 * Покрывает:
 *   - Chromium net::ERR_* — CONNECTION_RESET/REFUSED/TIMED_OUT,
 *     NAME_NOT_RESOLVED, NETWORK_CHANGED, INTERNET_DISCONNECTED и пр.;
 *   - Playwright-таймауты `page.goto`/`request.post`
 *     ("Timeout 60000ms exceeded");
 *   - Node-уровень: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENETUNREACH,
 *     EAI_AGAIN.
 *
 * Флапы прокси-туннеля (см. `_isProxyTunnelFlap`) сюда НЕ входят.
 */
function _isRotatableNetworkError(err) {
  if (!err) return false;
  if (_isProxyTunnelFlap(err)) return false;
  if (_isProxyAuthError(err)) return false;
  const s = `${err && err.message ? err.message : err}`;
  return (
    /net::ERR_/i.test(s) ||
    /Timeout\s+\d+ms\s+exceeded/i.test(s) ||
    /timeout exceeded/i.test(s) ||
    /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(s)
  );
}

/**
 * «Похоже на бан/throttle от целевого сайта» — HTTP-уровень.
 *
 * Принимает:
 *   - число (HTTP status, например 403);
 *   - строку с кодом внутри (например `"status=429"` от `_browseSearchPage`).
 *
 * Триггерим ротацию IP на:
 *   - 403 (Forbidden) — типичный «по IP отлуп»;
 *   - 429 (Too Many Requests) — rate limit;
 *   - 451 (Unavailable For Legal Reasons) — RAS использует именно этот
 *     код как «ваш IP в чёрном списке». Тело ответа — статическая HTML
 *     страница `<title>Доступ заблокирован</title>` + `/static/img/blocked.png`.
 *     Снимается ТОЛЬКО ротацией IP. См. инцидент 2026-05-04: 270 страниц
 *     подряд скипнулось без единой ротации, потому что 451 не был в
 *     списке (всё, кстати, было дополнительно прикрыто failsafe в
 *     `_walkPagesForBody` — тогда же).
 *   - 500..525 — серверная пятисотка / Cloudflare 520..525, которая в
 *     90% случаев у арбитров означает, что наш IP попал в throttle.
 * 401, 404 и прочие 4xx — нет смысла крутить IP, это «корректный отказ».
 *
 * ВНИМАНИЕ: если RAS однажды переедет на ещё один новый «бан-код»
 * (например, 418/498), парсер всё равно его поймает: при 8 неудачных
 * попытках подряд `_walkPagesForBody` сам форсит `_recoverFrom('banned')`
 * перед следующим раундом — то есть этот предикат — оптимизация
 * («крутить IP с 1-й попытки, а не с 9-й»), а не единственная защита.
 */
function _isLikelyBanned(errOrStatus) {
  if (errOrStatus === null || errOrStatus === undefined) return false;
  let code = null;
  if (typeof errOrStatus === "number") {
    code = errOrStatus;
  } else {
    const s = `${errOrStatus && errOrStatus.message ? errOrStatus.message : errOrStatus}`;
    const m = s.match(/status\s*[=:]?\s*(\d{3})/i);
    if (m) code = Number(m[1]);
  }
  if (code === null) return false;
  return (
    code === 403 ||
    code === 429 ||
    code === 451 ||
    (code >= 500 && code <= 525)
  );
}

/**
 * Единый предикат «нужно крутить мобильный IP, прежде чем ретраить».
 * Флапы прокси-туннеля сюда НЕ попадают — они лечатся коротким
 * `proxy_flap`-backoff'ом, см. `_isProxyTunnelFlap`.
 */
function _shouldRotateIp(err) {
  return _isRotatableNetworkError(err) || _isLikelyBanned(err);
}

/**
 * Сколько подряд `proxy_flap`-провалов мы готовы пережить через
 * короткий backoff на одном IP, прежде чем эскалируемся до
 * полноценной ротации мобильного IP. Идея: один флап — это шум
 * апстрима провайдера, 5 подряд — это уже что-то системное (порт
 * упал на нашем мобильном IP, апстрим деградирует), и тогда стоит
 * хотя бы попробовать переехать.
 */
const PROXY_FLAP_ROTATE_AFTER = 5;

/**
 * Кэш «диагноз ACL» по hostname:port. Раз в `ACL_DIAG_TTL_MS` пере-
 * проверяем, не пускает ли провайдер CONNECT (актуально только если
 * мы где-то поймали `proxy_flap`). На каждом флапе бьёмся не дольше
 * чем ACL_DIAG_TIMEOUT_MS.
 */
const ACL_DIAG_TTL_MS = 30_000;
const ACL_DIAG_TIMEOUT_MS = 6_000;
const _aclDiagCache = new Map();

/**
 * Парсит URL прокси из `MP_PROXY_SERVER` в `{ host, port, isHttps }`.
 * Возвращает null, если URL не распарсился.
 */
function _parseProxyEndpoint(server) {
  if (!server) return null;
  try {
    const u = new URL(server);
    const isHttps = u.protocol === "https:";
    const port = u.port ? Number(u.port) : isHttps ? 443 : 80;
    return { host: u.hostname, port, isHttps };
  } catch {
    return null;
  }
}

/**
 * Делает «голый» CONNECT-запрос на прокси и читает первую строку
 * ответа. Используем чтобы отличить ACL у провайдера (HTTP 403
 * на CONNECT с телом «Access control list denies you») от обычного
 * флапа апстрима. Chromium это всё показывает одинаково как
 * `ERR_TUNNEL_CONNECTION_FAILED`, без HTTP-кода.
 *
 * @returns {Promise<{kind:'acl'|'ok'|'auth'|'other'|'unreachable', code:number|null, line:string|null}>}
 */
async function _diagnoseProxyAcl(targetHost, targetPort = 443) {
  const ep = _parseProxyEndpoint(PROXY_SERVER);
  if (!ep || ep.isHttps) {
    return { kind: "unreachable", code: null, line: "no-http-proxy-endpoint" };
  }
  const cacheKey = `${ep.host}:${ep.port}|${targetHost}:${targetPort}`;
  const cached = _aclDiagCache.get(cacheKey);
  if (cached && Date.now() - cached.at < ACL_DIAG_TTL_MS) return cached.value;

  const auth =
    PROXY_USER && PROXY_PASS
      ? Buffer.from(`${PROXY_USER}:${PROXY_PASS}`).toString("base64")
      : null;
  const req =
    `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
    `Host: ${targetHost}:${targetPort}\r\n` +
    (auth ? `Proxy-Authorization: Basic ${auth}\r\n` : "") +
    `Connection: close\r\n\r\n`;

  const result = await new Promise((resolve) => {
    let buf = "";
    let resolved = false;
    const finish = (value) => {
      if (resolved) return;
      resolved = true;
      try {
        socket.destroy();
      } catch {}
      resolve(value);
    };
    const socket = net.createConnection({ host: ep.host, port: ep.port });
    socket.setTimeout(ACL_DIAG_TIMEOUT_MS);
    socket.on("connect", () => socket.write(req));
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const eol = buf.indexOf("\r\n");
      if (eol === -1 && buf.length < 8192) return;
      const line = (eol === -1 ? buf : buf.slice(0, eol)).trim();
      const m = line.match(/^HTTP\/\d\.\d\s+(\d{3})/);
      const code = m ? Number(m[1]) : null;
      let kind = "other";
      if (code === 200) kind = "ok";
      else if (code === 403) kind = "acl";
      else if (code === 407) kind = "auth";
      finish({ kind, code, line });
    });
    socket.on("timeout", () =>
      finish({ kind: "unreachable", code: null, line: "timeout" }),
    );
    socket.on("error", (e) =>
      finish({ kind: "unreachable", code: null, line: `${e}` }),
    );
    socket.on("close", () => {
      if (!resolved) finish({ kind: "unreachable", code: null, line: "closed" });
    });
  });

  _aclDiagCache.set(cacheKey, { at: Date.now(), value: result });
  return result;
}

function _aclDiagDropCache() {
  _aclDiagCache.clear();
}

/**
 * Открывает страницу, крутя мобильный IP при сетевых/прокси-ошибках
 * И при бан/throttle-сигналах от целевого сайта.
 *
 * Логика на каждую попытку:
 *   1) `_isProxyTunnelFlap`-исключение (CONNECT aborted / EMPTY_RESPONSE /
 *      TUNNEL_CONNECTION_FAILED) → НЕ эскалируем, делаем
 *      `smartWait('proxy_flap')` и retry. Это шум апстрима провайдера,
 *      новый IP не лечит. Считаем подряд-флапы в `flapStreak`; если их
 *      набралось `PROXY_FLAP_ROTATE_AFTER` — эскалируемся через
 *      `_recoverFrom(...)`, потому что апстрим прокси может зацепиться
 *      за другой IP/SIM, а на нашем IP «висит» (5+ подряд — уже не
 *      случайность).
 *   2) `_isRotatableNetworkError` (REFUSED/TIMED_OUT/RESET/таймаут goto
 *      и т.п.) → `_recoverFrom(...)`, retry. Эскалатор сам решит:
 *      changeIp, changeOperator или changeGeo. Если внутри упал —
 *      отдельный `smartWait('ip_cooldown')` и снова retry.
 *   3) HTTP-ответ с бан-кодом (403/429/5xx — см. `_isLikelyBanned`)
 *      → `_recoverFrom(...)` + retry.
 *   4) `sentinelSelector` задан, страница вернула 200, но селектора
 *      в DOM нет → считаем «капча/тех.работы», `_recoverFrom(...)` + retry.
 *   5) любое другое исключение (не сеть, не бан) → `smartWait('reading')`
 *      и retry без эскалации (трогать прокси бесполезно — это, например,
 *      парсерная ошибка селектора).
 *   * Эскалатор может бросить `EscalationExhausted` — мы НЕ ловим его
 *     здесь, оно прорастает до `main()` и завершает прогон. Это и
 *     гарантирует, что цикл смены IP/оборудования не уйдёт в вечность.
 *
 * `maxAttempts` — страховка, чтобы не висеть совсем вечно при
 * системной проблеме (нет конфига, выключен прокси-аккаунт и т.п.).
 */
async function _safeGoto(
  page,
  url,
  { maxAttempts = 200, sentinelSelector = null } = {},
) {
  let lastExc = null;
  let lastBanReason = null;
  let flapStreak = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let banReason = null;
    let flapErr = null;
    try {
      log(`[goto] Попытка ${attempt}/${maxAttempts}: GET ${url}`);
      const resp = await page.goto(url, { waitUntil: "load", timeout: 120_000 });
      const status = resp ? resp.status() : null;

      if (status !== null && _isLikelyBanned(status)) {
        banReason = `http=${status}`;
        log(
          `[goto] Попытка ${attempt}/${maxAttempts}: HTTP ${status} — похоже на бан/throttle сайтом`,
        );
      } else if (sentinelSelector) {
        const sentinelOk = await page
          .locator(sentinelSelector)
          .first()
          .count()
          .then((c) => c > 0)
          .catch(() => false);
        if (!sentinelOk) {
          banReason = `no-sentinel(${sentinelSelector})`;
          log(
            `[goto] Попытка ${attempt}/${maxAttempts}: HTTP ${status}, ` +
              `но селектора ${sentinelSelector} нет — похоже на капчу/тех.страницу`,
          );
        } else {
          log(`[goto] Страница загружена (load, http=${status}, sentinel ok)`);
          return;
        }
      } else {
        log(`[goto] Страница загружена (load, http=${status})`);
        return;
      }
    } catch (e) {
      lastExc = e;
      if (_isProxyAuthError(e)) {
        log(
          `[goto] Попытка ${attempt}/${maxAttempts} провалена [proxy/auth]: ${e}`,
        );
        log(
          "[goto] провайдер отверг логин/пароль прокси — это НЕ лечится ротацией. " +
            "Проверь MP_PROXY_USER/MP_PROXY_PASS в .env и что parser запущен через " +
            "'npm start' / 'node --env-file=.env parser.js' (или что .env читается).",
        );
        throw e;
      }
      if (_isProxyTunnelFlap(e)) {
        flapErr = e;
        log(
          `[goto] Попытка ${attempt}/${maxAttempts} провалена [proxy/flap streak=${flapStreak + 1}]: ${e}`,
        );
      } else if (_isRotatableNetworkError(e)) {
        banReason = `net ${e && e.message ? e.message : e}`;
        log(`[goto] Попытка ${attempt}/${maxAttempts} провалена [proxy/net]: ${e}`);
      } else {
        log(`[goto] Попытка ${attempt}/${maxAttempts} провалена: ${e}`);
      }
    }

    if (banReason !== null) lastBanReason = banReason;
    if (attempt >= maxAttempts) break;

    if (flapErr !== null) {
      flapStreak += 1;
      // Диагностический CONNECT — только в лог, без авто-эскалации в changeGeo.
      // Раньше тут был ACL fast-track сразу в L3, сейчас политика «менять
      // регион — последнее средство». Если ACL реальный, лестница ниже
      // (changeOperator → changeGeo) до него доедет сама.
      await _logAclDiagnostic(url);
      if (flapStreak >= PROXY_FLAP_ROTATE_AFTER) {
        log(
          `[goto] ${flapStreak} прокси-флапов подряд — kind=net_down, ` +
            `эскалирую через _recoverFrom, апстрим провайдера может ` +
            `зацепиться за другой IP/SIM`,
        );
        const rotated = await _recoverFrom(
          `safeGoto flap-streak=${flapStreak}`,
          { kind: ESC_KIND_NET_DOWN },
        );
        if (!rotated) {
          log(
            "[goto] _recoverFrom не сработал — отдельный ip_cooldown и продолжаю",
          );
          await _stealth.smartWait("ip_cooldown");
        }
        flapStreak = 0;
      } else {
        await _stealth.smartWait("proxy_flap");
      }
    } else if (banReason !== null) {
      flapStreak = 0;
      // Различаем «сайт нас режет» (HTTP 403/429/5xx, sentinel-нет) и
      // «реальный отвал сети» (Playwright-таймаут goto, ERR_CONNECTION_*,
      // ECONNRESET и т.п.). Платный changeGeo (L3) разрешён эскалатору
      // только при kind=net_down.
      const isNetDown =
        banReason.startsWith("net ") || /timeout|timed out/i.test(banReason);
      const kind = isNetDown ? ESC_KIND_NET_DOWN : ESC_KIND_BANNED;
      const rotated = await _recoverFrom(`safeGoto ${banReason}`, { kind });
      if (!rotated) {
        log("[goto] _recoverFrom не сработал — отдельный ip_cooldown и пробую снова");
        await _stealth.smartWait("ip_cooldown");
      }
    } else {
      flapStreak = 0;
      await _stealth.smartWait("reading");
    }
  }
  if (lastExc !== null) throw lastExc;
  if (lastBanReason !== null) {
    throw new Error(
      `[goto] ${url}: исчерпано ${maxAttempts} попыток, последняя причина: ${lastBanReason}`,
    );
  }
}

async function _dumpButtonHandlers(page) {
  try {
    const info = await page.evaluate(`(() => {
      const el = document.getElementById('b-form-submit');
      const inner = el && el.querySelector('button[type="submit"]');
      const $ = window.jQuery;
      const evOuter = ($ && $._data && el) ? $._data(el, 'events') : null;
      const evInner = ($ && $._data && inner) ? $._data(inner, 'events') : null;
      const evDoc = ($ && $._data) ? ($._data(document, 'events') || {}) : {};
      return {
        hasJQuery: !!$,
        hasOuter: !!el,
        hasInner: !!inner,
        outerEvents: evOuter ? Object.keys(evOuter) : [],
        innerEvents: evInner ? Object.keys(evInner) : [],
        docClickHandlers: Array.isArray(evDoc.click) ? evDoc.click.length : 0,
        docSubmitHandlers: Array.isArray(evDoc.submit) ? evDoc.submit.length : 0,
      };
    })()`);
    log(`[click/probe] handlers: ${JSON.stringify(info)}`);
  } catch (e) {
    log(`[click/probe] page.evaluate упал: ${e}`);
  }
}

function _searchCaptured() {
  return _captured.url !== null;
}

async function _waitBrieflyForSearch(seconds) {
  const deadline = monotonic() + seconds;
  while (monotonic() < deadline) {
    if (_searchCaptured()) return true;
    await _stealth.smartWait("micro");
  }
  return _searchCaptured();
}

async function _categoryNativeSelectShowsSupply31(page) {
  try {
    const wrap = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    if ((await wrap.count()) === 0) return false;
    const sel = wrap.locator("select.select").first();
    if ((await sel.count()) === 0) return false;
    return await sel.evaluate((el) => {
      if (!el || el.selectedIndex < 0) return false;
      const opt = el.options[el.selectedIndex];
      if (!opt) return false;
      if (String(opt.value || "") === "3.1") return true;
      const t = (opt.textContent || "").replace(/\s+/g, " ").toLowerCase();
      return t.includes("3.1") && t.includes("поставк");
    });
  } catch {
    return false;
  }
}

/**
 * После тяжёлого обновления фильтров блок категории может кратко отсутствовать в DOM
 * или уехать из зоны рендера — прокручиваем заголовок и ждём появления стрелки комбобокса.
 *
 * @returns {Promise<boolean>}
 */
async function _ensureSupplyCategoryComboboxReady(page) {
  const header = page.locator("h2.b-part-header_category").first();
  try {
    if ((await header.count()) > 0) {
      await header.scrollIntoViewIfNeeded({ timeout: 15_000 });
    }
  } catch (e) {
    log(`[filter] scroll к заголовку «Категория спора»: ${e}`);
  }
  await _stealth.smartWait("micro");

  const deadline = monotonic() + 18;
  while (monotonic() < deadline) {
    const wrap = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    let probe = {
      hasWrap: false,
      downCount: 0,
      strictDownCount: 0,
      inputCount: 0,
    };
    if ((await wrap.count()) > 0) {
      probe = {
        hasWrap: true,
        downCount: await wrap.locator("span.down-button").count(),
        strictDownCount: await wrap
          .locator("span.down-button.js-down-button")
          .count(),
        inputCount: await wrap.locator("input.js-input").count(),
      };
    }
    if (probe.hasWrap && (probe.downCount > 0 || probe.inputCount > 0)) {
      try {
        if (probe.downCount > 0) {
          await page
            .locator(RAS_CATEGORY_DOWN_BUTTON_FALLBACK_SEL)
            .first()
            .scrollIntoViewIfNeeded({ timeout: 5_000 });
        } else {
          await page
            .locator(RAS_CATEGORY_INPUT_CLICK_SEL)
            .first()
            .scrollIntoViewIfNeeded({ timeout: 5_000 });
        }
      } catch {
        /* ignore */
      }
      // #region agent log
      _agentDebugLog(
        "parser.js:_ensureSupplyCategoryComboboxReady",
        "category combobox ready",
        probe,
        "H2",
      );
      // #endregion
      log(`[filter-debug] категория UI готово: ${JSON.stringify(probe)}`);
      return true;
    }
    await _stealth.smartWait("micro");
  }

  const wrapEnd = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
  /** @type {{hasWrap:boolean,downCount:number,strictDownCount:number,inputCount:number}} */
  let probeEnd = {
    hasWrap: false,
    downCount: 0,
    strictDownCount: 0,
    inputCount: 0,
  };
  if ((await wrapEnd.count()) > 0) {
    probeEnd = {
      hasWrap: true,
      downCount: await wrapEnd.locator("span.down-button").count(),
      strictDownCount: await wrapEnd
        .locator("span.down-button.js-down-button")
        .count(),
      inputCount: await wrapEnd.locator("input.js-input").count(),
    };
  }
  // #region agent log
  _agentDebugLog(
    "parser.js:_ensureSupplyCategoryComboboxReady",
    "category combobox wait exhausted",
    probeEnd,
    "H3",
  );
  // #endregion
  log(`[filter-debug] категория UI не появилась за ожидание: ${JSON.stringify(probeEnd)}`);
  return false;
}

async function _categoryShowsSupply31(page) {
  if (await _categoryNativeSelectShowsSupply31(page)) {
    // #region agent log
    _agentDebugLog(
      "parser.js:_categoryShowsSupply31",
      "3.1 detected via native select",
      {},
      "H1",
    );
    // #endregion
    return true;
  }
  try {
    const box = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    if ((await box.count()) === 0) return false;
    const text = (await box.innerText()).replace(/\s+/g, " ").toLowerCase();
    return text.includes("3.1") && text.includes("поставк");
  } catch {
    return false;
  }
}

async function _rakDocFilterTitleLooksComplete(page) {
  try {
    const toggle = page.locator(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH).first();
    const t = (await toggle.innerText()).replace(/\s+/g, " ").toLowerCase();
    return (
      t.includes("решение") &&
      t.includes("апелляц") &&
      t.includes("кассац")
    );
  } catch {
    return false;
  }
}

async function _statusFilterTitleShowsFinished(page) {
  try {
    const toggle = page.locator(RAS_STATUS_FILTER_TOGGLE_XPATH).first();
    const t = (await toggle.innerText()).replace(/\s+/g, " ").toLowerCase();
    if (t.includes("только заверш")) return true;
    return t.includes("заверш") && !t.includes("не заверш");
  } catch {
    return false;
  }
}

/**
 * После «Найти», reload или иных сбоев — заголовки верхних фильтров должны
 * совпадать с выбранными режимами; иначе добиваем через UI (с POST только если
 * реально что-то поменяли).
 *
 * Порядок добива: РАК и «Статус», затем категория 3.1 — последний POST должен
 * соответствовать уже включённым верхним фильтрам (иначе можно было вернуть
 * JSON выдачи «до» выбора 3.1 и получить огромный TotalCount при уже узкой форме).
 *
 * @returns {Promise<{ ok: boolean, listingRepairParsed: object | null }>}
 */
async function _verifyListingFiltersOrRepair(page, uiFilters, supplyFilter31 = false) {
  const {
    rakDocumentTypeFilter = false,
    statusFinishedOnly = false,
  } = uiFilters;

  if (
    rakDocumentTypeFilter &&
    !(await _rakDocFilterTitleLooksComplete(page))
  ) {
    log("[filter-check] «Тип документа» по заголовку неполный — добиваю");
    if (!(await _applyRakDocumentTypeFilter(page))) {
      return { ok: false, listingRepairParsed: null };
    }
  }
  if (
    statusFinishedOnly &&
    !(await _statusFilterTitleShowsFinished(page))
  ) {
    log("[filter-check] «Статус» по заголовку не «завершённые» — добиваю");
    if (!(await _applyFinishedStatusFilter(page))) {
      return { ok: false, listingRepairParsed: null };
    }
  }

  if (supplyFilter31 && !(await _categoryShowsSupply31(page))) {
    log("[filter-check] категория 3.1 на форме не видна — добиваю дерево категории");
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const picked = await _applySupplyDisputeFilter31(page);
    if (!picked) {
      void respPromise.catch(() => {});
      return { ok: false, listingRepairParsed: null };
    }
    try {
      const response = await respPromise;
      if (response.status() !== 200) {
        log(
          `[filter-check] /Search после добива категории: status=${response.status()}`,
        );
        return { ok: false, listingRepairParsed: null };
      }
      _syncCapturedFromSearchResponse(response);
      let raw = null;
      try {
        raw = await response.body();
      } catch (e) {
        log(`[filter-check] resp.body() после добива категории: ${e}`);
      }
      const text =
        raw !== null && raw !== undefined
          ? raw.toString("utf8")
          : await response.text();
      const listingRepairParsed = JSON.parse(text);
      return { ok: true, listingRepairParsed };
    } catch (e) {
      log(`[filter-check] нет валидного /Search после добива категории: ${e}`);
      return { ok: false, listingRepairParsed: null };
    }
  }

  return { ok: true, listingRepairParsed: null };
}

/**
 * Открыть выпадающий список категорий и выбрать п. 3.1 (поставки).
 * Вызывается после warmup и до клика «Найти».
 *
 * @returns {Promise<boolean>}
 */
async function _applySupplyDisputeFilter31(page) {
  if (await _categoryShowsSupply31(page)) {
    log("[filter] категория 3.1 (поставки) уже выбрана — пропуск кликов");
    return true;
  }
  log("[filter] категория спора 3.1 (договоры поставки): раскрываю список…");
  if (!(await _ensureSupplyCategoryComboboxReady(page))) {
    log(
      "[filter] контрол «Категория спора» не готов (нет панели по XPath / стрелки / поля ввода)",
    );
    return false;
  }
  const categoryClickSelectors = [
    RAS_CATEGORY_DOWN_BUTTON_SEL,
    RAS_CATEGORY_DOWN_BUTTON_FALLBACK_SEL,
    RAS_CATEGORY_INPUT_CLICK_SEL,
  ];
  let opened = false;
  for (let i = 0; i < categoryClickSelectors.length; i += 1) {
    const sel = categoryClickSelectors[i];
    log(
      `[filter-debug] категория: открытие списка, способ ${i + 1}/${categoryClickSelectors.length}`,
    );
    opened = await _stealth.click(sel, { afterWait: "click" });
    if (opened) break;
    await _stealth.smartWait("micro");
  }
  if (!opened) {
    log("[filter] не удалось кликнуть по кнопке раскрытия категории");
    return false;
  }

  const item = page.locator(RAS_SUPPLY_FILTER_31_LI_XPATH).first();
  try {
    await item.waitFor({ state: "visible", timeout: 15_000 });
  } catch (e) {
    log(`[filter] пункт 3.1 не появился в DOM: ${e}`);
    return false;
  }

  await _stealth.smartWait("micro");
  const picked = await _stealth.click(RAS_SUPPLY_FILTER_31_LI_XPATH, {
    afterWait: "micro",
  });
  if (!picked) {
    log("[filter] клик по пункту 3.1 не удался");
    return false;
  }
  log("[filter] выбран п. 3.1 (поставки)");
  return true;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.searchPostBaselineSeq] если задан — считаем успех только после нового POST `/Search`
 *        (строго больше этого счётчика); иначе поведение как при первом подъёме сессии.
 */
async function _clickFind(page, opts = {}) {
  const baselineSeq =
    typeof opts.searchPostBaselineSeq === "number"
      ? opts.searchPostBaselineSeq
      : null;
  const requireNewSearch = baselineSeq !== null;

  if (RAS_TRACE_STEALTH) {
    log("[click] Ищу кнопку «Найти» и пытаюсь кликнуть...");
    await _dumpButtonHandlers(page);
  }

  const sawFreshSearch = async () => {
    if (!requireNewSearch) {
      return await _waitBrieflyForSearch(3.0);
    }
    const deadline = monotonic() + 22;
    while (monotonic() < deadline) {
      if (_searchPostSeq > baselineSeq) return true;
      await _stealth.smartWait("micro");
    }
    return _searchPostSeq > baselineSeq;
  };

  const targets = [
    "#b-form-submit",
    "#b-form-submit .b-button-container",
    '#b-form-submit button[type="submit"]',
  ];
  let anyClicked = false;
  for (const sel of targets) {
    if (!requireNewSearch && _searchCaptured()) return true;
    const clicked = await _stealth.click(sel, { afterWait: "micro" });
    anyClicked = anyClicked || clicked;
    if (!clicked) continue;
    if (await sawFreshSearch()) {
      log(`[click] /Search пойман после клика по ${sel}`);
      return true;
    }
    log(
      `[click] после клика по ${sel} /Search ещё нет, пробую следующий вариант`,
    );
  }

  try {
    const ok = await page.evaluate(`(() => {
      const $ = window.jQuery;
      if (!$) return 'no-jq';
      const $btn = $('#b-form-submit button[type="submit"]');
      if ($btn.length) { $btn.trigger('click'); return 'jquery-trigger-inner'; }
      const $b = $('#b-form-submit');
      if ($b.length) { $b.trigger('click'); return 'jquery-trigger-outer'; }
      return 'no-element';
    })()`);
    log(`[click] JS-fallback (jQuery trigger): ${ok}`);
    if (ok === "jquery-trigger-inner" || ok === "jquery-trigger-outer") {
      anyClicked = true;
      // jQuery-триггер — синтетика без курсора, поэтому даём антифроду
      // увидеть реалистичную «реакцию пользователя» через micro-паузу,
      // прежде чем поллить /Search.
      await _stealth.smartWait("micro");
      if (await sawFreshSearch()) {
        log("[click] /Search пойман после jQuery trigger");
        return true;
      }
    }
  } catch (e) {
    log(`[click] JS fallback -> ${e}`);
  }

  return requireNewSearch ? false : anyClicked;
}

/**
 * Раскрыть «Статус» и выбрать «Только завершенные» (без ожидания /Search).
 * Для setup см. `_applyFinishedStatusFilter`.
 *
 * @returns {Promise<boolean>}
 */
async function _applyFinishedStatusFilterUntilPick(page) {
  log("[filter] верхний статус: раскрываю фильтр «Статус»…");
  const toggle = page.locator(RAS_STATUS_FILTER_TOGGLE_XPATH).first();
  try {
    await toggle.waitFor({ state: "visible", timeout: 20_000 });
  } catch (e) {
    log(`[filter] фильтр «Статус» не появился после поиска: ${e}`);
    return false;
  }

  const opened = await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  if (!opened) {
    log("[filter] не удалось раскрыть фильтр «Статус»");
    return false;
  }

  const option = page.locator(RAS_STATUS_FINISHED_OPTION_XPATH).first();
  try {
    await option.waitFor({ state: "visible", timeout: 15_000 });
  } catch (e) {
    log(`[filter] пункт «Только завершенные» не появился: ${e}`);
    return false;
  }

  return true;
}

async function _applyFinishedStatusFilterPick(page) {
  const option = page.locator(RAS_STATUS_FINISHED_OPTION_XPATH).first();
  let already = false;
  try {
    already = await option.evaluate((el) => {
      const li = el.closest("li");
      const inp = li?.querySelector('input[type="checkbox"]');
      return inp ? inp.checked : false;
    });
  } catch {
    already = false;
  }
  if (already) {
    log('[filter] «Только завершенные» уже отмечено — пропуск клика');
    return { ok: true, changed: false, parsed: null };
  }

  const searchT0 = performance.now();
  const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
    timeout: 120_000,
  });
  const picked = await _stealth.click(RAS_STATUS_FINISHED_OPTION_XPATH, {
    afterWait: "micro",
  });
  if (!picked) {
    void respPromise.catch(() => {});
    log("[filter] не удалось выбрать «Только завершенные»");
    return { ok: false, changed: false, parsed: null };
  }

  const ing = await _awaitPostSearchJson(
    respPromise,
    "filter-status-finished",
    searchT0,
  );
  if (!ing.ok) {
    log(`[filter] после «Только завершенные» нет валидного /Search: ${ing.reason}`);
    return { ok: false, changed: false, parsed: null };
  }
  await _stealth.smartWait("click");
  return {
    ok: true,
    changed: true,
    parsed: ing.parsed,
    searchRoundtripMs: ing.roundtripMs,
  };
}

/**
 * Полный UI выбора статуса (без сброса `_captured` и без heartbeat).
 *
 * @returns {Promise<{ ok: boolean, changed: boolean, parsed: object|null }>}
 */
async function _applyFinishedStatusFilterUi(page) {
  if (await _statusFilterTitleShowsFinished(page)) {
    log('[filter] статус «Только завершенные» уже по заголовку — пропуск');
    return { ok: true, changed: false, parsed: null };
  }
  if (!(await _applyFinishedStatusFilterUntilPick(page))) {
    return { ok: false, changed: false, parsed: null };
  }
  const pick = await _applyFinishedStatusFilterPick(page);
  if (!pick.ok) return { ok: false, changed: false, parsed: null };
  if (!pick.changed) {
    await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
      afterWait: "click",
    });
    return { ok: true, changed: false, parsed: null };
  }
  await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  return {
    ok: true,
    changed: true,
    parsed: pick.parsed,
    searchRoundtripMs: pick.searchRoundtripMs,
  };
}

/**
 * После первого поиска раскрыть верхний фильтр «Статус» и выбрать
 * «Только завершенные», затем перехватить новый POST `/Search`.
 *
 * @returns {Promise<boolean>}
 */
async function _applyFinishedStatusFilter(page) {
  if (await _statusFilterTitleShowsFinished(page)) {
    log("[filter] статус уже «Только завершенные» — новый /Search не жду");
    return true;
  }
  if (!(await _applyFinishedStatusFilterUntilPick(page))) return false;

  const pick = await _applyFinishedStatusFilterPick(page);
  if (!pick.ok) return false;
  if (!pick.changed) {
    await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
      afterWait: "click",
    });
    return true;
  }

  log(
    "[filter] выбран статус «Только завершенные», ответ /Search обработан внутри клика",
  );
  await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  return true;
}

/**
 * РАК: выбрать три типа документа в UI (без сброса `_captured` и без heartbeat).
 * Уже отмеченные пункты не кликаем повторно (повторный клик снимает выбор).
 *
 * После каждого нового выбора пункта ждём свой POST `/Search` и только затем
 * идём дальше — иначе серия запросов даёт гонку и шаблон `_captured` остаётся
 * от первого ответа.
 *
 * @returns {Promise<{ ok: boolean, changed: boolean, parsed: object|null }>}
 */
async function _applyRakDocumentTypeFilterUi(page) {
  if (await _rakDocFilterTitleLooksComplete(page)) {
    log('[filter] РАК: по заголовку «Тип документа» все три типа уже выбраны');
    return { ok: true, changed: false, parsed: null };
  }

  log("[filter] РАК: раскрываю фильтр «Тип документа»…");
  const toggle = page.locator(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH).first();
  try {
    await toggle.waitFor({ state: "visible", timeout: 20_000 });
  } catch (e) {
    log(`[filter] РАК: фильтр «Тип документа» не появился: ${e}`);
    return { ok: false, changed: false, parsed: null };
  }

  const opened = await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  if (!opened) {
    log("[filter] РАК: не удалось раскрыть фильтр «Тип документа»");
    return { ok: false, changed: false, parsed: null };
  }

  const options = [
    {
      xpath: RAS_DOC_TYPE_DECISION_OPTION_XPATH,
      label: "Решение",
      dumpSlug: "rak-decision",
    },
    {
      xpath: RAS_DOC_TYPE_APPEAL_OPTION_XPATH,
      label: "Постановление апелляции",
      dumpSlug: "rak-appeal",
    },
    {
      xpath: RAS_DOC_TYPE_CASSATION_OPTION_XPATH,
      label: "Постановление кассации",
      dumpSlug: "rak-cassation",
    },
  ];

  let changed = false;
  /** @type {object|null} */
  let lastParsed = null;
  /** @type {number|undefined} */
  let lastRakSearchMs;
  for (const opt of options) {
    const option = page.locator(opt.xpath).first();
    try {
      await option.waitFor({ state: "visible", timeout: 15_000 });
    } catch (e) {
      log(`[filter] РАК: пункт «${opt.label}» не появился: ${e}`);
      await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, {
        afterWait: "click",
      });
      return { ok: false, changed, parsed: lastParsed };
    }
    let already = false;
    try {
      already = await option.evaluate((el) => {
        const li = el.closest("li");
        if (!li) return false;
        const inp = li.querySelector('input[type="checkbox"]');
        if (inp) return inp.checked;
        return li.classList.contains("ui-state-active");
      });
    } catch {
      already = false;
    }
    if (already) {
      log(`[filter] РАК: «${opt.label}» уже выбран — пропуск`);
      continue;
    }

    const searchT0 = performance.now();
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const picked = await _stealth.click(opt.xpath, { afterWait: "micro" });
    if (!picked) {
      void respPromise.catch(() => {});
      log(`[filter] РАК: не удалось выбрать «${opt.label}»`);
      await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, {
        afterWait: "click",
      });
      return { ok: false, changed, parsed: lastParsed };
    }
    changed = true;
    log(`[filter] РАК: выбран пункт «${opt.label}», жду соответствующий /Search…`);
    const ing = await _awaitPostSearchJson(
      respPromise,
      `filter-${opt.dumpSlug}`,
      searchT0,
    );
    if (!ing.ok) {
      log(`[filter] РАК: после «${opt.label}» нет валидного /Search: ${ing.reason}`);
      await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, {
        afterWait: "click",
      });
      return { ok: false, changed, parsed: lastParsed };
    }
    lastParsed = ing.parsed;
    lastRakSearchMs = ing.roundtripMs;
    await _stealth.smartWait("click");
  }

  await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  return {
    ok: true,
    changed,
    parsed: lastParsed,
    searchRoundtripMs: changed ? lastRakSearchMs : undefined,
  };
}

/**
 * После первого поиска раскрыть фильтр «Тип документа», выбрать:
 * - «Решение»
 * - «Постановление апелляции/апелляционной инстанции»
 * - «Постановление кассации/кассационной инстанции»
 * Затем перехватить новый POST `/Search`.
 *
 * @returns {Promise<boolean>}
 */
async function _applyRakDocumentTypeFilter(page) {
  const ui = await _applyRakDocumentTypeFilterUi(page);
  if (!ui.ok) return false;
  if (!ui.changed) {
    log("[filter] РАК: типы документов уже были в цели — новый /Search не жду");
    return true;
  }

  if (_captured.url !== null && _captured.body !== null) {
    log(
      "[filter] РАК: фильтр «Тип документа» применён, шаблон POST из последнего /Search",
    );
    return true;
  }

  log("[filter] РАК: после выборов типов шаблон POST пуст — fallback heartbeat");
  _captured.url = null;
  _captured.headers = null;
  _captured.body = null;

  log(
    `[wait] РАК: жду POST /Search после фильтра «Тип документа» до ${Math.floor(
      WAIT_FOR_SEARCH_MS / 1000,
    )}с...`,
  );
  await _waitForSearchWithHeartbeat(WAIT_FOR_SEARCH_MS);
  if (_captured.url === null) {
    log("[filter] РАК: после выбора типов документов новый /Search не пришёл");
    return false;
  }

  log("[filter] РАК: фильтр «Тип документа» применён, новый /Search пойман");
  return true;
}

/**
 * Единая точка восстановления при «надо сделать что-то с прокси».
 *
 * Эскалатор сам решает, крутить IP / менять оператора / менять гео,
 * и сам делает settle через
 * `smartWait('ip_cooldown' | 'equipment_swap')`. Если эскалатор кидает
 * `EscalationExhausted` — пробрасываем НАВЕРХ, ловится в `main()`,
 * это сигнал «всё, дальше парсить бессмысленно». Это страховка от
 * бесконечного цикла ip↔eq↔ip↔eq.
 *
 * @param {string} reason
 * @param {object} [opts]
 * @param {'banned'|'net_down'} [opts.kind='banned']
 *        Природа сбоя — управляет, разрешена ли эскалатору ПЛАТНАЯ
 *        смена региона (L3 changeGeo). Подробности — JSDoc
 *        `ProxyEscalator.recoverFrom`.
 * @returns {Promise<boolean>} true если что-то получилось сделать (хоть
 * IP покрутили, хоть оборудование сменили), false — если SDK тоже сломался.
 * @throws {EscalationExhausted}
 */
async function _recoverFrom(reason = "", opts = {}) {
  const r = await _escalator.recoverFrom(reason, opts);
  if (
    r.level === ESC_LEVELS.IP &&
    r.detail &&
    r.detail.ok &&
    r.detail.duplicateIp
  ) {
    log(
      `[recover] changeIp вернул тот же new_ip — считаю ротацию фиктивной, ` +
        "откат счётчиков эскалатора + recycle браузера",
    );
    _escalator.revertLastIpRotationForDuplicateEgress(reason);
    if (_browserRecycleForDuplicateIp) await _browserRecycleForDuplicateIp();
    throw new RecycleWindowError(
      `duplicate new_ip после changeIp (${reason}) — браузер пересоздан, повтори окно`,
    );
  }
  if (
    RECYCLE_BROWSER_AFTER_BANNED_L1 &&
    opts.kind === ESC_KIND_BANNED &&
    r.level === ESC_LEVELS.IP &&
    r.detail?.ok &&
    !r.detail.duplicateIp &&
    _browserRecycleForDuplicateIp
  ) {
    log(
      "[recover] после changeIp по бану (новый new_ip) — пересоздаю браузер, " +
        "заново «Найти» и перехват POST; main повторит то же календарное окно",
    );
    await _browserRecycleForDuplicateIp();
    throw new RecycleWindowError(
      `banned L1 после changeIp (${reason}) — браузер пересоздан, повтори окно`,
    );
  }
  log(
    `[recover] level=${r.level} kind=${r.kind} OK; ` +
      `summary=${JSON.stringify(_escalator.summary())}`,
  );
  return true;
}

/**
 * Диагностика «есть ли у провайдера ACL на наш hostname на текущей SIM»
 * (HTTP 403 на CONNECT к прокси). Раньше тут был fast-track сразу в L3
 * changeGeo. Сейчас политика пользователя: «менять регион — платно,
 * делать только при полном отвале сети, когда смена IP не помогла».
 * ACL под это формально не подходит (это не отвал сети, это блок
 * hostname), поэтому автоматический fast-track выключен и эта функция
 * работает чисто как информативный лог: при `proxy_flap` мы делаем
 * один CONNECT, пишем в лог что это ACL/обычный флап/таймаут — и
 * идём дальше в обычную лестницу через `_recoverFrom('net_down')`
 * после streak'а.
 *
 * Если ACL действительно есть, лестница доберётся до changeGeo сама,
 * но сначала отработают changeIp и changeOperator (в том же гео).
 * Это и хотел пользователь — менять регион в самую последнюю очередь.
 */
async function _logAclDiagnostic(url) {
  let host = "ras.arbitr.ru";
  let port = 443;
  try {
    const u = new URL(url);
    host = u.hostname || host;
    port = u.port ? Number(u.port) : u.protocol === "http:" ? 80 : 443;
  } catch {}

  const diag = await _diagnoseProxyAcl(host, port);
  if (diag.kind === "acl") {
    log(
      `[acl] CONNECT ${host}:${port} → ${diag.code} '${diag.line ?? ""}' — ` +
        `провайдер блокирует hostname на текущей SIM. ACL fast-track ВЫКЛЮЧЕН ` +
        `(политика: смена региона — последнее средство). Идём по лестнице ` +
        `changeIp → changeOperator (в том же гео) → changeGeo.`,
    );
  } else if (diag.kind === "ok") {
    log(`[acl] CONNECT ${host}:${port} → 200 (туннель ОК) — это шум апстрима, не ACL`);
  } else {
    log(
      `[acl] CONNECT ${host}:${port} диагностика: ${diag.kind} ` +
        `${diag.code ?? ""} ${diag.line ?? ""}`,
    );
  }
  _aclDiagDropCache();
}

/** ISO `2025-05-01T00:00:00` → `01.05.2025` для полей периода. */
function _isoDateTimeToDdMmYyyy(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

async function _clearPeriodDateInputs(page) {
  for (const sel of [RAS_PERIOD_DATE_FROM_XPATH, RAS_PERIOD_DATE_TO_XPATH]) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) return false;
    await loc.evaluate((el) => {
      el.value = "";
    });
  }
  return true;
}

async function _dismissPeriodDatePickerOverlay() {
  log("[ui-search] закрываю оверлей календаря (Enter — без кликов «в пустоту»)");
  await _stealth.pressKey("Enter", { afterWait: "micro" });
}

async function _fillPeriodDatesFromBody(page, bodyObj) {
  const df = _isoDateTimeToDdMmYyyy(bodyObj.DateFrom);
  const dt = _isoDateTimeToDdMmYyyy(bodyObj.DateTo);
  if (!df || !dt) {
    log(`[ui-search] не разобрал DateFrom/DateTo в body — нужен ISO YYYY-MM-DD`);
    return false;
  }
  log(`[ui-search] период в форме: ${df} — ${dt}`);
  if (!(await _clearPeriodDateInputs(page))) {
    log("[ui-search] поля периода не найдены (#sug-dates)");
    return false;
  }
  const fromOk = await _stealth.type(RAS_PERIOD_DATE_FROM_XPATH, df, {
    afterWait: "micro",
  });
  const toOk = await _stealth.type(RAS_PERIOD_DATE_TO_XPATH, dt, {
    afterWait: "micro",
  });
  if (!fromOk || !toOk) return false;
  await _dismissPeriodDatePickerOverlay();
  return true;
}

function _searchPostResponsePredicate(r) {
  const req = r.request();
  return _isSearchUrl(r.url()) && req.method() === "POST";
}

/**
 * Подставить даты и «Найти» по новому периоду (шаблон POST — `_captured`).
 * Кнопка «Найти» сбрасывает «Тип документа» и «Статус»; если выдача не пустая,
 * выставляем их в UI без повторного «Найти». Если дел в периоде нет, верхних
 * фильтров на странице нет — только меняют обобщённые параметры (даты и т.д.).
 *
 * Обновляет `_captured` из последнего актуального `/Search` (шаблон окна, Page=1).
 *
 * @param {object} [uiFilters]
 * @param {boolean} [uiFilters.rakDocumentTypeFilter=false]
 * @param {boolean} [uiFilters.statusFinishedOnly=false]
 * @param {boolean} [supplyFilter31=false] перед «Найти» выставить п. 3.1 (поставки), если ещё нет.
 * @param {boolean} [_forceSupplyFilter31=false] зарезервировано (категория выставляется перед каждым «Найти»).
 * @returns {Promise<[number|null, object|null, string, number]>}
 */
async function _uiRunSearchFromForm(
  page,
  bodyObj,
  label,
  uiFilters = {},
  supplyFilter31 = false,
  _forceSupplyFilter31 = false,
) {
  const {
    rakDocumentTypeFilter = false,
    statusFinishedOnly = false,
  } = uiFilters;

  const t0 = performance.now();
  bodyObj.Page = 1;

  if (supplyFilter31) {
    const ok31 = await _applySupplyDisputeFilter31(page);
    if (!ok31) {
      log("[filter] перед «Найти»: категория 3.1 не выставлена — продолжаю");
    }
  }

  const filled = await _fillPeriodDatesFromBody(page, bodyObj);
  if (!filled) {
    return [null, null, "fill-dates-failed", performance.now() - t0];
  }

  await _dismissPeriodDatePickerOverlay();
  await _stealth.smartWait("micro");

  const usesRakUi = rakDocumentTypeFilter === true;
  const usesStatusUi = statusFinishedOnly === true;

  /** Latency последнего успешного POST `/Search` (как у пейджера), без набора дат и без последующего UI. */
  let searchRoundtripMs = 0;
  let response;
  try {
    const searchBaseline = _searchPostSeq;
    const searchT0 = performance.now();
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const clicked = await _clickFind(page, {
      searchPostBaselineSeq: searchBaseline,
    });
    if (!clicked) {
      void respPromise.catch(() => {});
      return [null, null, "find-click-failed", performance.now() - t0];
    }
    response = await respPromise;
    searchRoundtripMs = performance.now() - searchT0;
  } catch (e) {
    return [null, null, `wait-response: ${e}`, performance.now() - t0];
  }

  let raw = null;
  try {
    raw = await response.body();
  } catch (e) {
    log(`[ui-search] resp.body() упал: ${e}`);
  }
  if (raw !== null && raw !== undefined) {
    _dumpSearchResponse(`${label}-status${response.status()}`, raw, "bin");
  }

  if (response.status() !== 200) {
    return [response.status(), null, `status=${response.status()}`, searchRoundtripMs];
  }

  let parsed;
  try {
    _syncCapturedFromSearchResponse(response);
    const text =
      raw !== null && raw !== undefined ? raw.toString("utf8") : await response.text();
    parsed = JSON.parse(text);
  } catch (e) {
    return [response.status(), null, `json-decode: ${e}`, searchRoundtripMs];
  }

  if (!usesRakUi && !usesStatusUi) {
    if (!_rasListingEmptyBeforeTopFilters(parsed)) {
      const verifyOut = await _verifyListingFiltersOrRepair(
        page,
        uiFilters,
        supplyFilter31,
      );
      if (!verifyOut.ok) {
        return [
          null,
          null,
          "filter-verify-repair-failed",
          performance.now() - t0,
        ];
      }
      if (
        verifyOut.listingRepairParsed !== null &&
        verifyOut.listingRepairParsed !== undefined
      ) {
        parsed = verifyOut.listingRepairParsed;
      }
    }
    return [200, parsed, "", searchRoundtripMs];
  }

  if (_rasListingEmptyBeforeTopFilters(parsed)) {
    log(
      "[ui-search] после «Найти» выдача пустая — верхние фильтры РАК/«Статус» не трогаю; " +
        "проверку заголовков фильтров пропускаю (на пустой выдаче RAS их часто прячет)",
    );
    return [200, parsed, "", searchRoundtripMs];
  }

  try {
    if (usesRakUi) {
      const rakUi = await _applyRakDocumentTypeFilterUi(page);
      if (!rakUi.ok) {
        return [null, null, "rak-filter-ui-failed", performance.now() - t0];
      }
      if (rakUi.changed) {
        if (rakUi.parsed === null || rakUi.parsed === undefined) {
          return [
            null,
            null,
            "rak-filter-no-json",
            performance.now() - t0,
          ];
        }
        parsed = rakUi.parsed;
        if (typeof rakUi.searchRoundtripMs === "number") {
          searchRoundtripMs = rakUi.searchRoundtripMs;
        }
      }
    }
    if (usesStatusUi) {
      const stUi = await _applyFinishedStatusFilterUi(page);
      if (!stUi.ok) {
        return [null, null, "status-filter-ui-failed", performance.now() - t0];
      }
      if (stUi.changed) {
        if (stUi.parsed === null || stUi.parsed === undefined) {
          return [
            null,
            null,
            "status-filter-no-json",
            performance.now() - t0,
          ];
        }
        parsed = stUi.parsed;
        if (typeof stUi.searchRoundtripMs === "number") {
          searchRoundtripMs = stUi.searchRoundtripMs;
        }
      }
    }
  } catch (e) {
    return [null, null, `wait-response: ${e}`, performance.now() - t0];
  }

  const verifyOut = await _verifyListingFiltersOrRepair(
    page,
    uiFilters,
    supplyFilter31,
  );
  if (!verifyOut.ok) {
    return [null, null, "filter-verify-repair-failed", performance.now() - t0];
  }
  if (
    verifyOut.listingRepairParsed !== null &&
    verifyOut.listingRepairParsed !== undefined
  ) {
    parsed = verifyOut.listingRepairParsed;
  }
  return [200, parsed, "", searchRoundtripMs];
}

async function _pagerNextIsVisible(page) {
  const next = page.locator(RAS_PAGER_NEXT_XPATH).first();
  try {
    return await next.isVisible();
  } catch {
    return false;
  }
}

/**
 * Клик «вперёд» в пейджере, ждём следующий POST /Search.
 *
 * @returns {Promise<[number|null, object|null, string, number]>}
 */
async function _uiClickPagerNext(page, label) {
  const t0 = performance.now();
  const nextLoc = page.locator(RAS_PAGER_NEXT_XPATH).first();
  try {
    if (!(await nextLoc.isVisible())) {
      return [null, null, "pager-next-hidden", performance.now() - t0];
    }
  } catch (e) {
    return [null, null, `pager-check: ${e}`, performance.now() - t0];
  }

  /**
   * Раньше ждали «любой» POST /Search через waitForResponse — при сбое клика
   * (пейджер вне видимой зоны hit-test, перекрытие списком дел) POST не уходил,
   * а таймаут 120с ошибочно выглядел как «сеть». Цепляемся к конкретному Request.
   */
  const reqPromise = page.waitForRequest(
    (req) => req.method() === "POST" && _isSearchUrl(req.url()),
    { timeout: 120_000 },
  );

  const tBeforeClick = performance.now();
  // scrollIntoView по умолчанию true у _stealth.click — иначе после длинной
  // выдачи «Ctrl→» часто не получает mousedown и POST не уходит.
  const clicked = await _stealth.click(RAS_PAGER_NEXT_XPATH, {
    afterWait: "none",
  });
  const tAfterClick = performance.now();
  if (!clicked) {
    void reqPromise.catch(() => {});
    return [null, null, "pager-click-failed", performance.now() - t0];
  }

  let searchRequest;
  try {
    searchRequest = await reqPromise;
  } catch (e) {
    return [null, null, `wait-response: ${e}`, performance.now() - t0];
  }

  let response;
  try {
    response = await searchRequest.response();
    if (response === null) {
      return [null, null, "pager-no-response", performance.now() - t0];
    }
  } catch (e) {
    return [null, null, `wait-response: ${e}`, performance.now() - t0];
  }

  const tAfterResp = performance.now();
  /** POST /Search: время после завершения клика до ответа (без паузы «чтения»). */
  const elapsedMs = tAfterResp - tAfterClick;

  /** Сразу читаем тело до пауз/логов: иначе CDP может вытеснить ресурс ответа. */
  let raw = null;
  try {
    raw = await response.body();
  } catch (e) {
    log(`[ui-pager] resp.body() упал: ${e}`);
  }

  const agentPayload = {
    sessionId: "7805f8",
    runId: "post-fix",
    hypothesisId: "H1-verify",
    location: "parser.js:_uiClickPagerNext",
    message: "pager phase timings",
    data: {
      label,
      prepMs: tBeforeClick - t0,
      clickNoAfterWaitMs: tAfterClick - tBeforeClick,
      awaitRespAfterClickMs: tAfterResp - tAfterClick,
      elapsedMsReported: elapsedMs,
      respUrlSuffix: (() => {
        try {
          return response.url().slice(-48);
        } catch {
          return "";
        }
      })(),
    },
    timestamp: Date.now(),
  };
  // #region agent log
  fetch("http://localhost:7437/ingest/92c381b7-7965-4e93-9977-dd75f5f783f1", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "7805f8",
    },
    body: JSON.stringify(agentPayload),
  }).catch(() => {});
  try {
    fs.appendFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), ".cursor", "debug-7805f8.log"),
      `${JSON.stringify(agentPayload)}\n`,
    );
  } catch {
    /* ignore */
  }
  // #endregion agent log

  await _stealth.smartWait("micro");

  if (raw !== null && raw !== undefined) {
    _dumpSearchResponse(`${label}-status${response.status()}`, raw, "bin");
  }

  if (response.status() !== 200) {
    return [response.status(), null, `status=${response.status()}`, elapsedMs];
  }

  try {
    const text = raw !== null && raw !== undefined ? raw.toString("utf8") : await response.text();
    const parsed = JSON.parse(text);
    return [200, parsed, "", elapsedMs];
  } catch (e) {
    return [response.status(), null, `json-decode: ${e}`, elapsedMs];
  }
}

/**
 * Сверяет `Result.Page` из JSON с ожидаемым номером страницы пейджера.
 * При «съезде» сессии RAS нередко отвечает 200 и телом первой страницы —
 * тогда парсер думает, что листает вперёд, и уходит в долгие пустые раунды.
 *
 * @returns {[number|null, object|null, string, number]}
 */
function _guardSearchResponsePage(out, pageNum, label) {
  const [st, parsed, err, elapsedMs] = out;
  if (st !== 200 || parsed === null || parsed === undefined) return out;
  const got = parsed?.Result?.Page;
  if (typeof got === "number" && Number.isFinite(got) && got !== pageNum) {
    log(
      `[pager-check] ${label}: Result.Page=${got}, ожидалось ${pageNum} — ` +
        "ответ отброшен (протух контекст поиска / неверный POST)",
    );
    return [st, null, `pager-page-mismatch: expected ${pageNum} got ${got}`, elapsedMs];
  }
  return out;
}

/**
 * Страница 1 — даты + «Найти»; при необходимости РАК/статус (см. `_uiRunSearchFromForm`);
 * дальше — клик по пейджеру.
 *
 * @param {object} [uiFilters] передаётся только для `pageNum === 1` (и для редкого контроля на пейджере).
 * @param {boolean} [supplyFilter31=false] только для `pageNum === 1`.
 * @returns {Promise<[number|null, object|null, string, number]>}
 */
async function _browseSearchPage(
  page,
  pageNum,
  bodyObj,
  label,
  uiFilters = {},
  supplyFilter31 = false,
  _forceSupplyFilter31 = false,
) {
  if (pageNum === 1) {
    return _guardSearchResponsePage(
      await _uiRunSearchFromForm(
        page,
        bodyObj,
        label,
        uiFilters,
        supplyFilter31,
        _forceSupplyFilter31,
      ),
      pageNum,
      label,
    );
  }
  const out = await _uiClickPagerNext(page, label);
  const [st] = out;
  if (
    FILTER_PAGER_TITLE_RECHECK_EVERY > 0 &&
    st === 200 &&
    pageNum % FILTER_PAGER_TITLE_RECHECK_EVERY === 0 &&
    (uiFilters.rakDocumentTypeFilter || uiFilters.statusFinishedOnly)
  ) {
    const rakOk =
      !uiFilters.rakDocumentTypeFilter ||
      (await _rakDocFilterTitleLooksComplete(page));
    const statOk =
      !uiFilters.statusFinishedOnly ||
      (await _statusFilterTitleShowsFinished(page));
    if (!rakOk || !statOk) {
      log(
        `[filter-check] ${label}: стр.${pageNum} — заголовки фильтров ` +
          `(РАК=${rakOk}, статус=${statOk}) не совпадают с настройкой; ` +
          "на пейджере починку без повторного окна не делаю",
      );
    }
  }
  return _guardSearchResponsePage(out, pageNum, label);
}

/**
 * После провального раунда POST `/Search`: перезагрузка главной и восстановление
 * контекста выдачи. На страницах пейджера > 1 без этого сайт нередко «теряет»
 * нумерацию — повторный Ctrl→ идёт без актуального поиска / даёт первую страницу.
 *
 * Страница 1: достаточно reload + прогрева + опционально п. 3.1 — следующая
 * попытка сама вызовет `_uiRunSearchFromForm`.
 *
 * Страница N>1: после reload — снова «Найти» с тем же телом/фильтрами и промотка
 * пейджера до (N−1), чтобы следующий `_browseSearchPage(N)` сделал один Ctrl→ на N.
 *
 * @returns {Promise<boolean>} false если форма или промотка не удались
 */
async function _recoverListingUiAfterFailedRound(
  page,
  bodyObj,
  pageNum,
  labelPrefix,
  uiFilters,
  supplyFilter31,
) {
  log(
    `[${labelPrefix}] UI-recovery: reload главной и восстановление выдачи ` +
      `(перед следующим раундом страницы ${pageNum})`,
  );
  await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });
  await _stealth.smartWait("warmup");
  if (supplyFilter31) {
    const applied = await _applySupplyDisputeFilter31(page);
    if (!applied) {
      log(
        `[${labelPrefix}] UI-recovery: фильтр 3.1 не применился — ` +
          "продолжаю (как при стартовой сессии при том же сбое)",
      );
    }
  }
  if (pageNum <= 1) {
    return true;
  }

  const [, parsed, err] = await _uiRunSearchFromForm(
    page,
    bodyObj,
    `${labelPrefix}-recover-form`,
    uiFilters,
    supplyFilter31,
    false,
  );
  if (parsed !== null && parsed !== undefined) {
    log(
      `[${labelPrefix}] UI-recovery: после «Найти» открыта страница 1 выдачи, ` +
        `промотка к ${pageNum}…`,
    );
    for (let p = 2; p < pageNum; p += 1) {
      const [, parsedNav, errNav] = await _uiClickPagerNext(
        page,
        `${labelPrefix}-recover-advance-${p}`,
      );
      if (parsedNav === null || parsedNav === undefined) {
        log(
          `[${labelPrefix}] UI-recovery: промотка к странице ${pageNum} ` +
            `остановилась на шаге ${p}: ${errNav}`,
        );
        return false;
      }
      await _stealth.smartWait("api_delay");
    }
    log(
      `[${labelPrefix}] UI-recovery: промотка готова, следующий запрос — страница ${pageNum}`,
    );
    return true;
  }

  log(`[${labelPrefix}] UI-recovery: повтор «Найти» не дал JSON: ${err}`);
  return false;
}

/**
 * Проходит все страницы окна, инкрементально дописывая `documentTypes`.
 *
 * КОНТРАКТ: данные на странице НЕ ТЕРЯЮТСЯ. Если страницу не удалось
 * достать с первой пачки попыток — функция продолжает крутить раунды
 * (8 быстрых попыток + один `_recoverFrom('banned')` если эскалатор за
 * раунд так и не вызвался; затем reload главной и повтор параметров поиска,
 * для страницы > 1 — промотка пейджера) на той же странице выдачи, пока:
 *
 *   • либо страница придёт успешно → идём дальше;
 *   • либо эскалатор сам кинет `EscalationExhausted` (выгребен бюджет
 *     или лимит totalFailures) — функция НЕ ловит это исключение,
 *     оно всплывает в `main()` (см. `parser.js:` обработчик возле конца),
 *     где штатно выводится саммари и закрывается браузер. Уже
 *     записанные в `document_types.json` данные не теряются — он
 *     дописывается инкрементально через `_save()` после каждой
 *     успешной страницы.
 *
 * Никаких `пропуск страницы` / `continue` — это было причиной потери
 * 1+ страниц подряд в инциденте 2026-05-04 (270 страниц подряд
 * проскипалось со status=451 без единой ротации IP).
 */
/**
 * @param {object} [subWindow] — `{ endDay: Date, daysSpan: number }`
 *        текущего под-окна. Используется для триггера
 *        `WindowDowngradeError`: если latency ответа `/Search` превысила
 *        порог И `daysSpan > WINDOW_MIN_DAYS`, бросаем сигнал в
 *        `main()`, который дробит окно. Если не передан — фича
 *        выключена в этом вызове.
 * @param {object} [uiFilters] — флаги `rakDocumentTypeFilter` / `statusFinishedOnly`
 *        для страницы 1: после смены дат всегда «Найти»; РАК/статус — только если
 *        выдача по периоду не пустая (иначе их нет в DOM).
 * @param {boolean} [supplyFilter31=false] — при UI-recovery после провала раунда
 *        снова выбрать п. 3.1 до «Найти» (как в `_setupSearchSession`).
 */
async function _walkPagesForBody(
  page,
  _url,
  _headers,
  bodyObj,
  labelPrefix,
  mode,
  targetTypeIdsSet,
  subWindow = null,
  uiFilters = {},
  supplyFilter31 = false,
) {
  const kadCaseCategory31Cache =
    mode === MODE_DECISION_LINKS && !supplyFilter31 ? new Map() : null;
  const kadCategorySkipLogged =
    mode === MODE_DECISION_LINKS && !supplyFilter31 ? new Set() : null;

  const stats = {
    total: null,
    return_count: null,
    pages_seen: 0,
    items: 0,
    added: 0,
    relabeled: 0,
    links_added: 0,
    links_skipped_category: 0,
  };

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    log(`[${labelPrefix}] страница ${pageNum}...`);

    let data = null;
    let lastSuccessElapsedMs = 0;
    const maxPageAttempts = 8;
    let pageRound = 0;
    while (data === null) {
      pageRound += 1;
      if (pageRound > MAX_SEARCH_PAGE_DATA_ROUNDS) {
        throw new Error(
          `[${labelPrefix}] страница ${pageNum}: превышен лимит ` +
            `${MAX_SEARCH_PAGE_DATA_ROUNDS} раундов без валидного JSON — см. логи пейджера/сеть`,
        );
      }
      let flapStreak = 0;
      let escalatedThisRound = false;
      let stuckStatus = null;
      let stuckStatusStreak = 0;

      for (let attempt = 1; attempt <= maxPageAttempts; attempt += 1) {
        const [status, parsed, err, elapsedMs] = await _browseSearchPage(
          page,
          pageNum,
          bodyObj,
          `${labelPrefix}-p${pageNum}-r${pageRound}-t${attempt}`,
          uiFilters,
          supplyFilter31,
        );
        if (parsed !== null && parsed !== undefined) {
          data = parsed;
          lastSuccessElapsedMs = elapsedMs;
          break;
        }

        if (typeof status === "number" && status !== 200) {
          if (status === stuckStatus) {
            stuckStatusStreak += 1;
          } else {
            stuckStatus = status;
            stuckStatusStreak = 1;
          }
        } else {
          stuckStatus = null;
          stuckStatusStreak = 0;
        }

        const isFlap = _isProxyTunnelFlap(err);
        const rotate = !isFlap && _shouldRotateIp(err);
        const tag = isFlap
          ? ` [proxy/flap streak=${flapStreak + 1}]`
          : rotate
            ? _isRotatableNetworkError(err)
              ? " [proxy/net]"
              : " [banned]"
            : "";
        log(
          `[${labelPrefix} p${pageNum} r${pageRound}] ` +
            `попытка ${attempt}/${maxPageAttempts}${tag}: ${err}`,
        );
        if (attempt >= maxPageAttempts) break;

        if (isFlap) {
          flapStreak += 1;
          await _logAclDiagnostic(_url);
          if (flapStreak >= PROXY_FLAP_ROTATE_AFTER) {
            log(
              `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                `${flapStreak} прокси-флапов подряд — kind=net_down, эскалирую через _recoverFrom`,
            );
            const rotated = await _recoverFrom(
              `${labelPrefix} p${pageNum} r${pageRound} flap-streak=${flapStreak}`,
              { kind: ESC_KIND_NET_DOWN },
            );
            escalatedThisRound = true;
            if (!rotated) {
              log(
                `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                  `_recoverFrom не сработал — отдельный ip_cooldown`,
              );
              await _stealth.smartWait("ip_cooldown");
            } else {
              const uiOk = await _recoverListingUiAfterFailedRound(
                page,
                bodyObj,
                pageNum,
                `${labelPrefix}-p${pageNum}-r${pageRound}-post-esc-flap`,
                uiFilters,
                supplyFilter31,
              );
              if (!uiOk) {
                log(
                  `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                    `post-esc (flap) UI-recovery не удался — api_delay`,
                );
                await _stealth.smartWait("api_delay");
              }
            }
            flapStreak = 0;
          } else {
            await _stealth.smartWait("proxy_flap");
          }
        } else if (rotate) {
          flapStreak = 0;
          // _isRotatableNetworkError → реальный отвал сети (timeout, ECONNRESET и т.п.),
          // L3 changeGeo для эскалатора разрешён.
          // _isLikelyBanned → HTTP 403/429/451/5xx, ban сайтом — менять регион запрещено.
          const isNetDown = _isRotatableNetworkError(err);
          const kind = isNetDown ? ESC_KIND_NET_DOWN : ESC_KIND_BANNED;
          const rotated = await _recoverFrom(
            `${labelPrefix} p${pageNum} r${pageRound} ${err}`,
            { kind },
          );
          escalatedThisRound = true;
          if (!rotated) {
            log(
              `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                `_recoverFrom не сработал — отдельный ip_cooldown`,
            );
            await _stealth.smartWait("ip_cooldown");
          } else {
            const uiOk = await _recoverListingUiAfterFailedRound(
              page,
              bodyObj,
              pageNum,
              `${labelPrefix}-p${pageNum}-r${pageRound}-post-esc`,
              uiFilters,
              supplyFilter31,
            );
            if (!uiOk) {
              log(
                `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                  `post-esc UI-recovery не удался — api_delay`,
              );
              await _stealth.smartWait("api_delay");
            }
          }
        } else {
          flapStreak = 0;
          if (
            typeof err === "string" &&
            (err === "pager-next-hidden" ||
              err.startsWith("pager-next-hidden") ||
              err === "pager-page-mismatch" ||
              err.startsWith("pager-page-mismatch"))
          ) {
            const slip =
              typeof err === "string" && err.startsWith("pager-page-mismatch");
            const uiOk = await _recoverListingUiAfterFailedRound(
              page,
              bodyObj,
              pageNum,
              `${labelPrefix}-p${pageNum}-r${pageRound}-` +
                (slip ? "pager-slip" : "pager-hidden"),
              uiFilters,
              supplyFilter31,
            );
            if (!uiOk) await _stealth.smartWait("api_delay");
          } else {
            await _stealth.smartWait("api_delay");
          }
        }
      }

      if (data !== null) break;

      // Раунд провалился целиком. Никаких пропусков — стоим и крутим
      // дальше. Единственный легитимный выход без данных —
      // `EscalationExhausted` от эскалатора (всплывёт в main()).
      // Если эскалатор за раунд ни разу не позвался — значит ни одна
      // ошибка не была классифицирована как «надо крутить IP» (новый
      // бан-код, не учтённый в `_isLikelyBanned`). Форсим один
      // `_recoverFrom('banned')` принудительно, чтобы следующий раунд
      // пошёл на свежем IP.
      if (!escalatedThisRound) {
        const reason =
          stuckStatus !== null
            ? `stuck-status=${stuckStatus}×${stuckStatusStreak}`
            : "no-rotation-trigger";
        log(
          `[${labelPrefix} p${pageNum} r${pageRound}] failsafe: раунд провалился ` +
            `(${reason}), эскалатор не вызывался — форс _recoverFrom(banned). ` +
            `Если повторяется на новом HTTP-коде — занеси его в _isLikelyBanned.`,
        );
        await _recoverFrom(`${labelPrefix} p${pageNum} r${pageRound} ${reason}`, {
          kind: ESC_KIND_BANNED,
        });
      }

      await _recoverListingUiAfterFailedRound(
        page,
        bodyObj,
        pageNum,
        `${labelPrefix}-p${pageNum}-r${pageRound}`,
        uiFilters,
        supplyFilter31,
      );

      log(
        `[${labelPrefix} p${pageNum}] раунд ${pageRound} без данных — ` +
          `данные обязательны, иду в раунд ${pageRound + 1}`,
      );
    }

    const isObj = data && typeof data === "object" && !Array.isArray(data);
    if (pageNum === 1) {
      const success = isObj ? data.Success : null;
      const message = isObj ? data.Message : null;
      const result = isObj ? data.Result : null;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        stats.total = result.TotalCount ?? null;
        stats.return_count = result.ReturnCount ?? null;
        const pc = result.PagesCount ?? null;
        const rcNote =
          typeof stats.return_count === "number" &&
          stats.return_count === 0 &&
          typeof stats.total === "number" &&
          stats.total > 0
            ? " — типично для RAS при фильтрах РАК/«Статус», ориентир TotalCount"
            : "";
        log(
          `[${labelPrefix}] Success=${success}, ` +
            `TotalCount=${stats.total}, ` +
            `ReturnCount=${stats.return_count}${rcNote}, PagesCount=${pc}`,
        );
        if (typeof stats.return_count === "number" && stats.return_count >= 1000) {
          log(
            `[${labelPrefix}] ВНИМАНИЕ: окно упёрлось в лимит ` +
              `ReturnCount=${stats.return_count} — сузь окно`,
          );
        }
      } else {
        log(
          `[${labelPrefix}] Result=null, Success=${success}, ` +
            `Message=${JSON.stringify(message)} — окно пустое`,
        );
      }
    }

    const items = _findItemsAnywhere(data);
    if (!items.length) {
      const topKeys = isObj ? Object.keys(data).sort() : [];
      log(`[${labelPrefix} p${pageNum}] пусто (top-keys=${JSON.stringify(topKeys)}) — конец окна`);
      break;
    }

    let added = 0;
    let relabeled = 0;
    let linksAdded = 0;
    let linksSkippedCategoryPage = 0;
    if (mode === MODE_TYPES) {
      const typeStats = _processItems(items);
      added = typeStats.added;
      relabeled = typeStats.relabeled;
      _save();
    } else {
      const linkOut = await _collectDecisionLinks(
        items,
        targetTypeIdsSet,
        page,
        kadCaseCategory31Cache,
        kadCategorySkipLogged,
        supplyFilter31,
      );
      linksAdded = linkOut.added;
      linksSkippedCategoryPage = linkOut.skippedCategory;
      stats.links_skipped_category += linkOut.skippedCategory;
      _saveDecisionLinks();
    }
    stats.pages_seen += 1;
    stats.items += items.length;
    stats.added += added;
    stats.relabeled += relabeled;
    stats.links_added += linksAdded;
    if (mode === MODE_TYPES) {
      log(
        `[${labelPrefix} p${pageNum}] items=${items.length}, ` +
          `новых типов=${added}, обновлено подписей=${relabeled}, ` +
          `всего=${Object.keys(documentTypes).length}, ` +
          `latency=${lastSuccessElapsedMs.toFixed(0)}мс`,
      );
    } else {
      log(
        `[${labelPrefix} p${pageNum}] items=${items.length}, ` +
          `новых pdf-ссылок=${linksAdded}, пропуск по категории kad (стр)=${linksSkippedCategoryPage}, ` +
          `всего пропусков за окно=${stats.links_skipped_category}, ` +
          `всего ссылок=${decisionLinks.size}, ` +
          `latency=${lastSuccessElapsedMs.toFixed(0)}мс`,
      );
    }

    // Query Downgrade + Circuit Breaker: latency ответа `/Search` превысила
    // порог → пул прокси разогрет, RAS уже начал нас троттлить. Прерываем
    // оставшуюся пагинацию, наверх в main() уйдёт сигнал «дроби окно».
    // Items уже сохранены через `_save()` выше, так что данные не теряются.
    if (
      SLOW_RESPONSE_THRESHOLD_MS > 0 &&
      lastSuccessElapsedMs > SLOW_RESPONSE_THRESHOLD_MS &&
      subWindow !== null
    ) {
      if (subWindow.daysSpan > WINDOW_MIN_DAYS) {
        const msg =
          `[${labelPrefix} p${pageNum}] latency=${lastSuccessElapsedMs.toFixed(0)}мс > ` +
          `порог ${SLOW_RESPONSE_THRESHOLD_MS}мс — окно ` +
          `daysSpan=${subWindow.daysSpan} слишком тяжёлое, прерываю пагинацию ` +
          `(items уже сохранены), иду в Query Downgrade`;
        log(msg);
        throw new WindowDowngradeError(msg, {
          endDay: subWindow.endDay,
          daysSpan: subWindow.daysSpan,
          latencyMs: lastSuccessElapsedMs,
          pageNum,
        });
      }
      log(
        `[${labelPrefix} p${pageNum}] latency=${lastSuccessElapsedMs.toFixed(0)}мс > ` +
          `порог ${SLOW_RESPONSE_THRESHOLD_MS}мс, но daysSpan=${subWindow.daysSpan} ` +
          `уже на минимуме (WINDOW_MIN_DAYS=${WINDOW_MIN_DAYS}) — дальше не дроблю, ` +
          `продолжаю текущее окно`,
      );
    }

    if (pageNum >= MAX_PAGES) {
      continue;
    }
    if (!(await _pagerNextIsVisible(page))) {
      log(
        `[${labelPrefix} p${pageNum}] в пейджере нет «вперёд» — ` +
          "это последняя страница выдачи",
      );
      break;
    }
    log(
      `[${labelPrefix} p${pageNum}] пауза до следующей страницы через ` +
        "smartWait('api_delay') (как между POST /Search в шапке модуля)",
    );
    await _stealth.smartWait("api_delay");
  }

  return stats;
}

function _windowIso(endDay, windowDays) {
  const startDay = new Date(
    endDay.getFullYear(),
    endDay.getMonth(),
    endDay.getDate() - (windowDays - 1),
  );
  const df =
    `${startDay.getFullYear()}-${pad2(startDay.getMonth() + 1)}-${pad2(startDay.getDate())}T00:00:00`;
  const dt =
    `${endDay.getFullYear()}-${pad2(endDay.getMonth() + 1)}-${pad2(endDay.getDate())}T23:59:59`;
  return [df, dt];
}

function _formatDdMmYyyy(d) {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function _parseDdMmYyyy(s) {
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

/** Календарный день 00:00 локально — для сравнения границ диапазона. */
function _startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function _ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      resolve(answer);
      rl.close();
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

/** да/нет; пустой ввод и Enter (= "") считаются как нет. */
function _parseYesNoDefaultNo(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (
    s === "" ||
    s === "нет" ||
    s === "н" ||
    s === "n" ||
    s === "no" ||
    s === "2"
  ) {
    return false;
  }
  if (
    s === "да" ||
    s === "д" ||
    s === "y" ||
    s === "yes" ||
    s === "1"
  ) {
    return true;
  }
  return null;
}

/** да/нет; пустой ввод и Enter (= "") считаются как да. */
function _parseYesNoDefaultYes(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (
    s === "" ||
    s === "да" ||
    s === "д" ||
    s === "y" ||
    s === "yes" ||
    s === "1"
  ) {
    return true;
  }
  if (s === "нет" || s === "н" || s === "n" || s === "no" || s === "2") {
    return false;
  }
  return null;
}

async function _askYesNoDefaultYes(prompt) {
  while (true) {
    const raw = await _ask(prompt);
    const v = _parseYesNoDefaultYes(raw);
    if (v !== null) return v;
    process.stdout.write('Введи «да» или «нет» (Enter = да).\n');
  }
}

async function _askYesNoDefaultNo(prompt) {
  while (true) {
    const raw = await _ask(prompt);
    const v = _parseYesNoDefaultNo(raw);
    if (v !== null) return v;
    process.stdout.write('Введи «да» или «нет» (Enter = нет).\n');
  }
}

function _parseDateFromEnv(raw, label) {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  if (/^(none|off|-|0)$/i.test(s)) return null;
  const parsed = _parseDdMmYyyy(s);
  if (parsed === null) {
    log(`[setup] ${label}='${s}' не дата DD.MM.YYYY, игнорирую`);
    return undefined;
  }
  return _startOfDay(parsed);
}

/** @param {number} cycles конечное число или Infinity (без лимита циклов) */
function _cyclesLabel(cycles) {
  return cycles === Infinity ? "∞" : String(cycles);
}

/**
 * Первый интерактивный шаг: окно браузера или headless.
 * Вызывать до любых тяжёлых операций в `main()` (mkdir/debug и т.д.).
 *
 * @returns {Promise<boolean>} true = headless (без окна)
 */
async function _resolveHeadlessFromEnvOrPrompt() {
  const normalizeHeadfulRequest = (headless, sourceLabel) => {
    if (!headless) {
      const ok = _ensureVirtualDisplayForHeadful(sourceLabel);
      if (!ok) return true;
    }
    return headless;
  };

  if (process.env.RAS_HEADLESS !== undefined) {
    const headless = normalizeHeadfulRequest(DEFAULT_HEADLESS, "RAS_HEADLESS");
    process.stdout.write(
      `[setup] RAS_HEADLESS=${process.env.RAS_HEADLESS} -> ` +
        `${headless ? "без UI (headless)" : "показывать браузер (headful)"}\n`,
    );
    return headless;
  }
  if (!process.stdin.isTTY) {
    process.stdout.write(
      `[setup] stdin не интерактивный — вопрос про экран браузера пропущен, ` +
        `RAS_HEADLESS по умолчанию (${DEFAULT_HEADLESS ? "headless" : "headful"})\n`,
    );
    return normalizeHeadfulRequest(DEFAULT_HEADLESS, "non-TTY stdin");
  }
  while (true) {
    const raw = (await _ask("Показывать экран браузера? [1] да, [2] нет: ")).trim();
    if (raw === "1") return normalizeHeadfulRequest(false, "интерактивный выбор");
    if (raw === "2") return true;
    process.stdout.write("Введи 1 или 2.\n");
  }
}

/**
 * @param {boolean} headless — уже выбрано в начале `main()` или из `RAS_HEADLESS`.
 */
async function _promptSetup(headless) {
  const now = new Date();
  const todayDt = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const defaultEndDay = new Date(
    todayDt.getFullYear(),
    todayDt.getMonth(),
    todayDt.getDate() - 1,
  );

  const MAX_CYCLES_INTERACTIVE = 200;

  const modeEnv = String(process.env.RAS_MODE ?? "").trim().toLowerCase();
  let mode = null;
  if (modeEnv === MODE_TYPES || modeEnv === "typeid" || modeEnv === "typeids") {
    mode = MODE_TYPES;
    log("[setup] режим=types (RAS_MODE)");
  } else if (
    modeEnv === MODE_DECISION_LINKS ||
    modeEnv === "links" ||
    modeEnv === "pdf_links"
  ) {
    mode = MODE_DECISION_LINKS;
    log("[setup] режим=decision_links (RAS_MODE)");
  } else if (modeEnv) {
    log(`[setup] RAS_MODE='${modeEnv}' не распознан, спрошу в терминале`);
  }
  if (mode === null) {
    while (true) {
      const raw = (
        await _ask(
          "Что парсим? [1] справочник TypeId, [2] ссылки на решения [Enter = ссылки]: ",
        )
      ).trim();
      if (raw === "" || raw === "2") {
        mode = MODE_DECISION_LINKS;
        break;
      }
      if (raw === "1") {
        mode = MODE_TYPES;
        break;
      }
      process.stdout.write("Введи 1 (справочник), 2 (ссылки) или Enter (ссылки).\n");
    }
  }

  const filterEnv = String(process.env.RAS_SUPPLY_FILTER_31 ?? "")
    .trim()
    .toLowerCase();
  /** @type {boolean | null} */
  let supplyFilter31 = null;
  if (filterEnv === "1" || filterEnv === "yes" || filterEnv === "on") {
    supplyFilter31 = true;
    log("[setup] фильтр категории 3.1 (поставки)=вкл (RAS_SUPPLY_FILTER_31)");
  } else if (
    filterEnv === "0" ||
    filterEnv === "no" ||
    filterEnv === "off"
  ) {
    supplyFilter31 = false;
    log("[setup] фильтр категории 3.1 (поставки)=выкл (RAS_SUPPLY_FILTER_31)");
  }
  if (supplyFilter31 === null) {
    supplyFilter31 = await _askYesNoDefaultYes(
      "Категория спора 3.1 (поставка)? да/нет [Enter = да]: ",
    );
  }

  const rakEnv = String(process.env.RAS_DOC_FILTER_RAK ?? "")
    .trim()
    .toLowerCase();
  /** @type {boolean | null} */
  let rakDocumentTypeFilter = null;
  if (rakEnv === "1" || rakEnv === "yes" || rakEnv === "on") {
    rakDocumentTypeFilter = true;
    log("[setup] фильтр РАК (Тип документа)=вкл (RAS_DOC_FILTER_RAK)");
  } else if (rakEnv === "0" || rakEnv === "no" || rakEnv === "off") {
    rakDocumentTypeFilter = false;
    log("[setup] фильтр РАК (Тип документа)=выкл (RAS_DOC_FILTER_RAK)");
  }
  if (rakDocumentTypeFilter === null) {
    rakDocumentTypeFilter = await _askYesNoDefaultNo(
      "Тип документа РАК? да/нет [Enter = нет]: ",
    );
  }

  const finishedEnv = String(process.env.RAS_STATUS_FINISHED_ONLY ?? "")
    .trim()
    .toLowerCase();
  /** @type {boolean | null} */
  let statusFinishedOnly = null;
  if (finishedEnv === "1" || finishedEnv === "yes" || finishedEnv === "on") {
    statusFinishedOnly = true;
    log("[setup] статус «только завершенные»=вкл (RAS_STATUS_FINISHED_ONLY)");
  } else if (
    finishedEnv === "0" ||
    finishedEnv === "no" ||
    finishedEnv === "off"
  ) {
    statusFinishedOnly = false;
    log("[setup] статус «только завершенные»=выкл (RAS_STATUS_FINISHED_ONLY)");
  }
  if (statusFinishedOnly === null) {
    statusFinishedOnly = await _askYesNoDefaultNo(
      "Статус только завершённые? да/нет [Enter = нет]: ",
    );
  }

  let targetTypeIds = [];
  if (mode === MODE_DECISION_LINKS) {
    const envTypeIds = _normalizeTypeIdsInput(process.env.RAS_TARGET_TYPE_IDS);
    if (envTypeIds.length > 0) {
      targetTypeIds = envTypeIds;
      log(`[setup] target TypeId: ${targetTypeIds.length} шт. (RAS_TARGET_TYPE_IDS)`);
    } else {
      while (true) {
        const raw = (
          await _ask(
            "TypeId через запятую (Enter = дефолтные 3 DecisionTypeId): ",
          )
        ).trim();
        if (raw === "") {
          targetTypeIds = [...DEFAULT_DECISION_TYPE_IDS];
          log("[setup] target TypeId: взял дефолтные 3 DecisionTypeId (Enter)");
          break;
        }
        const ids = _normalizeTypeIdsInput(raw);
        if (ids.length > 0) {
          targetTypeIds = ids;
          break;
        }
        process.stdout.write("Нужен хотя бы один TypeId.\n");
      }
    }
  }

  const cyclesEnv = (process.env.RAS_CYCLES ?? "").trim();
  let cycles = null;
  if (cyclesEnv) {
    const parsed = parseInt(cyclesEnv, 10);
    if (!Number.isNaN(parsed)) {
      if (parsed === 0) {
        cycles = Infinity;
        log(`[setup] cycles=∞ (RAS_CYCLES=0, без лимита)`);
      } else if (parsed >= 1) {
        cycles = parsed;
        log(`[setup] cycles=${cycles} (RAS_CYCLES)`);
      } else {
        log(`[setup] RAS_CYCLES=${parsed} некорректно, спрошу руками`);
      }
    } else {
      log(`[setup] RAS_CYCLES='${cyclesEnv}' не число, спрошу руками`);
    }
  }
  if (cycles === null) {
    while (true) {
      const raw = (
        await _ask(
          `Сколько циклов (1–${MAX_CYCLES_INTERACTIVE}; ` +
            `Enter или 0 = без лимита): `,
        )
      ).trim();
      if (raw === "" || raw === "0") {
        cycles = Infinity;
        break;
      }
      const parsed = parseInt(raw, 10);
      if (
        !Number.isNaN(parsed) &&
        parsed >= 1 &&
        parsed <= MAX_CYCLES_INTERACTIVE
      ) {
        cycles = parsed;
        break;
      }
      process.stdout.write(
        `Нужно целое от 1 до ${MAX_CYCLES_INTERACTIVE}, или 0, или пустой ввод ` +
          `(без лимита по числу циклов).\n`,
      );
    }
  }

  const windowEnv = (process.env.RAS_WINDOW_DAYS ?? "").trim();
  let windowDays = 1;
  if (windowEnv) {
    const parsed = parseInt(windowEnv, 10);
    if (!Number.isNaN(parsed)) {
      windowDays = Math.max(1, parsed);
    }
  }

  const toRaw = (process.env.RAS_DATE_TO ?? "").trim();
  let endDay = null;
  if (toRaw) {
    const parsed = _parseDdMmYyyy(toRaw);
    if (parsed === null) {
      log(`[setup] дата «до» '${toRaw}' не DD.MM.YYYY — спрошу в терминале`);
    } else {
      endDay = _startOfDay(parsed);
      log(`[setup] дата «до»=${_formatDdMmYyyy(endDay)} (RAS_DATE_TO)`);
    }
  }
  if (endDay === null && !process.stdin.isTTY) {
    endDay = defaultEndDay;
    log(
      "[setup] stdin не интерактивный и RAS_DATE_TO не задан — " +
        `дата «до»=вчера ${_formatDdMmYyyy(endDay)} (как Enter на вопросе «дата до»)`,
    );
  }
  if (endDay === null) {
    while (true) {
      const raw = (
        await _ask(
          `Дата «до» — правый край первого окна, DD.MM.YYYY ` +
            `[Enter = вчера ${_formatDdMmYyyy(defaultEndDay)} ` +
            `(сегодня ${_formatDdMmYyyy(todayDt)})]: `,
        )
      ).trim();
      if (raw === "") {
        endDay = defaultEndDay;
        break;
      }
      const parsed = _parseDdMmYyyy(raw);
      if (parsed !== null) {
        endDay = _startOfDay(parsed);
        break;
      }
      process.stdout.write("Формат DD.MM.YYYY, например 03.05.2026.\n");
    }
  }

  let oldestDay = undefined;
  if (process.env.RAS_DATE_FROM !== undefined) {
    oldestDay = _parseDateFromEnv(process.env.RAS_DATE_FROM, "RAS_DATE_FROM");
    if (oldestDay === undefined && String(process.env.RAS_DATE_FROM).trim() !== "") {
      log(`[setup] RAS_DATE_FROM задан некорректно — спрошу в терминале`);
    } else if (oldestDay !== undefined) {
      log(
        `[setup] дата «с» (нижняя граница)=` +
          `${oldestDay === null ? "нет" : _formatDdMmYyyy(oldestDay)} (RAS_DATE_FROM)`,
      );
    }
  }
  if (oldestDay === undefined && !process.stdin.isTTY) {
    log(
      "[setup] stdin не интерактивный и RAS_DATE_FROM не задан — " +
        "нижняя граница дат: нет (как пустой Enter на вопросе «дата с»)",
    );
    oldestDay = null;
  }
  if (oldestDay === undefined) {
    while (true) {
      const raw = (
        await _ask(
          `Дата «с» — не сдвигать окна дальше назад, если конец окна раньше этой даты ` +
            `(DD.MM.YYYY; Enter = без нижней границы, только лимит циклов): `,
        )
      ).trim();
      if (raw === "") {
        oldestDay = null;
        break;
      }
      const parsed = _parseDdMmYyyy(raw);
      if (parsed !== null) {
        oldestDay = _startOfDay(parsed);
        break;
      }
      process.stdout.write("Формат DD.MM.YYYY или пустой ввод.\n");
    }
  }

  if (oldestDay !== null && _startOfDay(endDay).getTime() < oldestDay.getTime()) {
    log(
      `[setup] дата «до» раньше даты «с» — меняю местами: ` +
        `${_formatDdMmYyyy(endDay)} ↔ ${_formatDdMmYyyy(oldestDay)}`,
    );
    const t = endDay;
    endDay = oldestDay;
    oldestDay = _startOfDay(t);
  }

  log(
    `[setup] mode=${mode}, show_browser=${!headless}, supply_filter_31=${supplyFilter31}, ` +
      `status_finished_only=${statusFinishedOnly}, ` +
      `rak_doc_type_filter=${rakDocumentTypeFilter}, ` +
      `cycles=${_cyclesLabel(cycles)}, window_days=${windowDays}, ` +
      `дата_до=${_formatDdMmYyyy(endDay)}` +
      (oldestDay === null
        ? ""
        : `, дата_с=${_formatDdMmYyyy(oldestDay)} (стоп при сдвиге окна назад)`) +
      ` (пустые дни пропускаются, не считаются за цикл)`,
  );
  return [
    mode,
    targetTypeIds,
    cycles,
    windowDays,
    endDay,
    oldestDay,
    supplyFilter31,
    statusFinishedOnly,
    rakDocumentTypeFilter,
  ];
}

function _resetDebugDir() {
  if (fs.existsSync(DEBUG_DIR)) {
    try {
      fs.rmSync(DEBUG_DIR, { recursive: true, force: true });
    } catch (e) {
      log(`[debug] не удалось очистить ${DEBUG_DIR}: ${e}`);
    }
  }
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  } catch (e) {
    log(`[debug] не удалось создать ${DEBUG_DIR}: ${e}`);
  }
}

async function _dumpDebug(page) {
  log("[debug] Сохраняю скриншот, html и список XHR в ./debug");
  try {
    fs.writeFileSync(DEBUG_RESPONSES, _responseLog.join("\n"), "utf-8");
  } catch (e) {
    log(`[debug] не записал ${DEBUG_RESPONSES}: ${e}`);
  }
  try {
    await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true });
  } catch (e) {
    log(`[debug] не записал ${DEBUG_SCREENSHOT}: ${e}`);
  }
  try {
    fs.writeFileSync(DEBUG_HTML, await page.content(), "utf-8");
  } catch (e) {
    log(`[debug] не записал ${DEBUG_HTML}: ${e}`);
  }
}

async function _waitForSearchWithHeartbeat(timeoutMs) {
  const deadline = monotonic() + timeoutMs / 1000;
  let lastTick = 0.0;
  while (monotonic() < deadline) {
    if (_captured.url !== null) {
      log("[wait] Ответ /Search получен.");
      return true;
    }
    const now = monotonic();
    if (now - lastTick >= 1.0) {
      const remaining = Math.floor(deadline - now);
      log(
        `[wait] жду /Search... ещё ${remaining}с, ` +
          `пойманных XHR: ${_responseLog.length}`,
      );
      lastTick = now;
    }
    await _stealth.smartWait("micro");
  }
  log("[wait] Таймаут — ответ /Search так и не пришёл.");
  return false;
}

/**
 * Поднять «боевую сессию» поиска: открыть главную, прогреть страницу,
 * нажать «Найти», поймать первый POST `/Search`.
 *
 * Лечит «тихий бан» арбитра: страница грузится, кнопка кликается, но
 * клик «холостой» — JS не отправляет POST на `/Search`. В этом случае:
 *   1) ротируем IP (с hard-cooldown ≥ `CHANGE_IP_COOLDOWN_SEC`),
 *   2) переоткрываем главную через `_safeGoto`,
 *   3) повторяем клик и ожидание.
 *
 * Если по периоду дел нет, RAS не показывает верхние фильтры «Тип документа»
 * / «Статус». После первого `/Search` это видно из JSON (`_rasListingEmptyBeforeTopFilters`);
 * тогда РАК/статус не трогаем и не считаем ситуацию баном (не крутим IP).
 *
 * Не «жжёт» ротации без надобности: ротация триггерится только если
 * `/Search` так и не был пойман за `WAIT_FOR_SEARCH_MS` (живая сессия
 * сюда не доходит — она вернётся после первого же успешного клика).
 *
 * @param {object} [opts]
 * @param {boolean} [opts.supplyFilter31=false] перед «Найти» выбрать п. 3.1 (поставки).
 * @param {boolean} [opts.statusFinishedOnly=false] после первого поиска выбрать верхний фильтр
 *        «Статус -> Только завершенные» и перехватить обновлённый `/Search`.
 * @param {boolean} [opts.rakDocumentTypeFilter=false] после первого поиска выбрать
 *        «Тип документа -> Решение + Постановление апелляции + Постановление кассации».
 * @param {object|null} [opts.periodBody=null] ISO `{ DateFrom, DateTo }` для полей периода:
 *        после п. 3.1 и до первого «Найти» (как ручной порядок на сайте).
 * @returns {Promise<boolean>} true — сессия поднята (`_captured.url` не null).
 */
async function _setupSearchSession(
  page,
  {
    maxAttempts = 5,
    supplyFilter31 = false,
    statusFinishedOnly = false,
    rakDocumentTypeFilter = false,
    periodBody = null,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      _captured.url = null;
      _captured.headers = null;
      _captured.body = null;

      log(
        `[setup] попытка ${attempt}/${maxAttempts}: «тихий бан» — ` +
          `kind=banned (страница загрузилась, JS не отработал — это бан сайтом, ` +
          `не отвал сети), эскалирую через _recoverFrom и переоткрываю главную`,
      );
      const rotated = await _recoverFrom(`silent-ban setup#${attempt}`, {
        kind: ESC_KIND_BANNED,
      });
      if (!rotated) {
        log("[setup] _recoverFrom не сработал — отдельный ip_cooldown");
        await _stealth.smartWait("ip_cooldown");
      }
      await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });
    }

    log(
      "[load] прогреваю страницу через smartWait('warmup') — " +
        "JS/jQuery/fingerprint должны успеть проинициализироваться",
    );
    await _stealth.smartWait("warmup");

    try {
      const hasJq = await page.evaluate(
        () => !!window.jQuery && !!window.jQuery("#b-form-submit").length,
      );
      log(`[load] jQuery + #b-form-submit готовы: ${hasJq}`);
    } catch (e) {
      log(`[load] проверка jQuery упала: ${e}`);
    }

    if (supplyFilter31) {
      const applied = await _applySupplyDisputeFilter31(page);
      if (!applied) {
        log(
          "[filter] не удалось применить фильтр 3.1 — продолжаю поиск без него",
        );
      }
    }

    if (
      periodBody !== null &&
      periodBody.DateFrom &&
      periodBody.DateTo
    ) {
      const filled = await _fillPeriodDatesFromBody(page, periodBody);
      if (!filled) {
        log(
          "[setup] период в форме перед «Найти» не выставлен — остаются значения страницы",
        );
      }
      await _stealth.smartWait("micro");
    }

    // Закрытие календаря/оверлея иногда шлёт POST /Search раньше «Найти».
    // Если не сбросить захват, `_onResponse` запомнит чужое тело запроса,
    // heartbeat решит что всё ок, а РАК/статус повиснут на DOM до таймаута.
    _captured.url = null;
    _captured.headers = null;
    _captured.body = null;

    log(
      `[wait] жду POST /Search после «Найти» до ${Math.floor(WAIT_FOR_SEARCH_MS / 1000)}с...`,
    );
    const searchBaseline = _searchPostSeq;
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const clicked = await _clickFind(page, {
      searchPostBaselineSeq: searchBaseline,
    });

    let firstSearchResponse = null;
    if (!clicked) {
      void respPromise.catch(() => {});
      log("[click] НЕ удалось кликнуть ни одним способом");
    } else {
      try {
        firstSearchResponse = await respPromise;
      } catch (e) {
        void respPromise.catch(() => {});
        log(`[setup] waitForResponse(/Search): ${e}`);
      }
    }

    if (firstSearchResponse !== null) {
      let raw = null;
      try {
        raw = await firstSearchResponse.body();
      } catch (e) {
        log(`[setup] первый /Search resp.body() упал: ${e}`);
      }
      if (raw !== null && raw !== undefined) {
        _dumpSearchResponse(
          `setup-p${attempt}-first-search-status${firstSearchResponse.status()}`,
          raw,
          "bin",
        );
      }
      if (firstSearchResponse.status() === 200) {
        try {
          _syncCapturedFromSearchResponse(firstSearchResponse);
        } catch (e) {
          log(`[setup] _syncCapturedFromSearchResponse: ${e}`);
        }
        let parsed = null;
        try {
          const text =
            raw !== null && raw !== undefined
              ? raw.toString("utf8")
              : await firstSearchResponse.text();
          parsed = JSON.parse(text);
        } catch (e) {
          log(`[setup] первый /Search JSON: ${e}`);
        }
        if (parsed !== null && _rasListingEmptyBeforeTopFilters(parsed)) {
          log(
            "[setup] выдача по периоду пустая — фильтры РАК/«Статус» в DOM нет, " +
              "пропускаю их (это не бан, IP не кручу)",
          );
          log(
            `[setup] сессия поднята с попытки ${attempt}/${maxAttempts}: ` +
              `${_captured.url}`,
          );
          return true;
        }
      }
    }

    if (_captured.url === null) {
      await _waitForSearchWithHeartbeat(WAIT_FOR_SEARCH_MS);
    }

    if (_captured.url !== null) {
      if (rakDocumentTypeFilter) {
        const filteredRak = await _applyRakDocumentTypeFilter(page);
        if (!filteredRak) {
          log(
            `[setup] попытка ${attempt}/${maxAttempts}: не удалось применить ` +
              "фильтр РАК «Тип документа»",
          );
          continue;
        }
      }
      if (statusFinishedOnly) {
        const filtered = await _applyFinishedStatusFilter(page);
        if (!filtered) {
          log(
            `[setup] попытка ${attempt}/${maxAttempts}: не удалось применить ` +
              "статус «Только завершенные»",
          );
          continue;
        }
      }
      log(
        `[setup] сессия поднята с попытки ${attempt}/${maxAttempts}: ` +
          `${_captured.url}`,
      );
      return true;
    }

    log(
      `[setup] попытка ${attempt}/${maxAttempts}: /Search так и не пришёл — ` +
        `похоже на тихий бан`,
    );
  }
  log(
    `[setup] исчерпано ${maxAttempts} попыток поднять сессию — ` +
      `сдаюсь, дальше пагинация не пойдёт`,
  );
  return false;
}

function _bindPageDebugListeners(page) {
  page.on("request", _onRequest);
  page.on("requestfailed", _onRequestFailed);
  page.on("response", (resp) => {
    _onResponse(resp).catch((e) => log(`[on_response] ${e}`));
  });
}

async function main() {
  const headless = await _resolveHeadlessFromEnvOrPrompt();

  let mode = MODE_TYPES;
  let cycles = 1;
  let windowDays = 1;
  let endDay = _startOfDay(new Date());
  let oldestDay = null;
  let supplyFilter31 = false;
  let statusFinishedOnly = false;
  let rakDocumentTypeFilter = false;
  let targetTypeIdsSet = new Set();

  let context = null;
  let userDataDir = null;
  let page = null;
  let mpProxyClient = null;

  // Все вопросы должны быть завершены до старта парсера и поднятия браузера.
  const setup = await _promptSetup(headless);
  [
    mode,
    ,
    cycles,
    windowDays,
    endDay,
    oldestDay,
    supplyFilter31,
    statusFinishedOnly,
    rakDocumentTypeFilter,
  ] = setup;
  const targetTypeIds = setup[1];
  targetTypeIdsSet = new Set(targetTypeIds.map((v) => _normalizeTypeIdValue(v)));
  _currentMode = mode;

  log("=== старт parser.js ===");
  fs.mkdirSync(PARSED_DATA_DIR, { recursive: true });
  log(`[data] папка результатов: ${PARSED_DATA_DIR}`);
  _resetDebugDir();
  log("[debug] папка ./debug пересоздана");
  if (mode === MODE_TYPES) {
    _loadExisting();
  } else {
    decisionLinks.clear();
    _saveDecisionLinks();
    log(`[setup] сбор только PDF-ссылок по TypeId (${targetTypeIds.length} шт.) -> ${LINKS_OUT_PATH}`);
  }

  try {
    log("[browser] запускаю Playwright...");

    // Fail-fast по конфигу: пустые PROXY_USER/PROXY_PASS — это почти
    // всегда «.env не загрузился» (запуск `node parser.js` без
    // --env-file). Без этого пойдут 200 попыток с
    // ERR_INVALID_AUTH_CREDENTIALS, сжигая cooldowns.
    if (PROXY_SERVER && (!PROXY_USER || !PROXY_PASS)) {
      throw new Error(
        `[config] PROXY_SERVER='${PROXY_SERVER}' задан, но MP_PROXY_USER/MP_PROXY_PASS пустые. ` +
          `Скорее всего .env не загружен. Запускай через 'npm start' либо ` +
          `'node --env-file=.env parser.js'. Если запускаешь как 'node parser.js' — ` +
          `loadEnv.js должен подхватывать .env автоматически (Node ${process.version}, ` +
          `process.loadEnvFile=${typeof process.loadEnvFile}).`,
      );
    }

    const launchKwargs = _launchKwargs();
    launchKwargs.headless = headless;
    log(
      `[browser] запускаю Chromium (headless=${headless}, прокси=${PROXY_SERVER}, ` +
        `proxy_auth=${PROXY_USER ? `${PROXY_USER}:***` : "none"}, ` +
        `executable=${launchKwargs.executablePath ?? "default"})`,
    );
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ras_chromium_"));
    context = await chromium.launchPersistentContext(userDataDir, {
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      userAgent: USER_AGENT,
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: {
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": SEC_CH_UA_PLATFORM,
        "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
      },
      ...launchKwargs,
    });
    log("[browser] persistent-context готов");

    const pages = context.pages();
    page = pages.length ? pages[0] : await context.newPage();
    _stealth = await StealthBrowserManager.create(page, { logger: log });
    log("[stealth] StealthBrowserManager инициализирован");

    if (!MP_API_TOKEN) {
      throw new Error(
        "MP_API_TOKEN обязателен: legacy-режим без SDK удалён, " +
          "без токена эскалация недоступна",
      );
    }
    mpProxyClient = new RasProxyClient({
      apiToken: MP_API_TOKEN,
      proxyKey: MP_PROXY_KEY,
      proxyId: MP_PROXY_ID,
      minIpRotateGapSec: CHANGE_IP_COOLDOWN_SEC,
      minEquipmentSwapGapSec: ESC_EQUIPMENT_COOLDOWN_SEC,
      minGeoSwapGapSec: CHANGE_GEO_COOLDOWN_SEC,
      logger: log,
    });
    _escalator = new ProxyEscalator({
      proxyClient: mpProxyClient,
      stealth: _stealth,
      logger: log,
      maxIpRotationsBeforeEquipment: ESC_MAX_IP_BEFORE_EQUIPMENT,
      preEquipmentIpRotations: ESC_PRE_EQUIPMENT_IP_ROTATIONS,
      maxOperatorSwapsBeforeGeo: ESC_MAX_OPERATOR_BEFORE_GEO,
      maxGeoSwaps: ESC_MAX_GEO_SWAPS,
      maxTotalFailures: ESC_MAX_TOTAL_FAILURES,
      maxBudgetSec: ESC_MAX_BUDGET_SEC,
      geoFilters: GEO_FILTERS,
    });
    log(
      `[escalator] включён: maxIp=${ESC_MAX_IP_BEFORE_EQUIPMENT}, ` +
        `preEqIp=${ESC_PRE_EQUIPMENT_IP_ROTATIONS}, ` +
        `maxOp=${ESC_MAX_OPERATOR_BEFORE_GEO}, ` +
        `maxGeo=${ESC_MAX_GEO_SWAPS <= 0 ? "off" : ESC_MAX_GEO_SWAPS}, ` +
        `maxFails=${ESC_MAX_TOTAL_FAILURES <= 0 ? "off" : ESC_MAX_TOTAL_FAILURES}, ` +
        `budget=${ESC_MAX_BUDGET_SEC <= 0 ? "off" : `${ESC_MAX_BUDGET_SEC}с`}, ` +
        `maxSearchPages=${MAX_PAGES}, ` +
        `emptyStreakStop=${RAS_EMPTY_WINDOW_STREAK_LIMIT <= 0 ? "off" : RAS_EMPTY_WINDOW_STREAK_LIMIT}, ` +
        `waitSearchMs=${WAIT_FOR_SEARCH_MS}`,
    );
    log(
      `[escalator] geoFilters: country=${GEO_FILTERS.requireCountryId ?? "any"}, ` +
        `includeRegex=${GEO_FILTERS.includeCaptionRegex ? GEO_FILTERS.includeCaptionRegex.source : "off"}, ` +
        `excludeCities=[${GEO_FILTERS.excludeCityIds.join(",")}], ` +
        `captionRegex=${GEO_FILTERS.excludeCaptionRegex ? GEO_FILTERS.excludeCaptionRegex.source : "off"}`,
    );

    const [initialSetupDf, initialSetupDt] = _windowIso(endDay, windowDays);
    const setupPeriodRef = {
      DateFrom: initialSetupDf,
      DateTo: initialSetupDt,
    };

    const recycleBrowserAfterDupIp = async () => {
      log(
        "[browser] recycle: duplicate new_ip — новый persistent-context и сессия /Search",
      );
      _captured.url = null;
      _captured.headers = null;
      _captured.body = null;
      if (mpProxyClient) mpProxyClient.resetReportedIpTracking();

      if (context !== null) {
        try {
          await context.close();
        } catch (e) {
          log(`[browser] recycle: context.close() ${e}`);
        }
      }
      context = null;
      if (userDataDir) {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {}
      }
      userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ras_chromium_"));
      context = await chromium.launchPersistentContext(userDataDir, {
        locale: "ru-RU",
        timezoneId: "Europe/Moscow",
        userAgent: USER_AGENT,
        viewport: { width: 1366, height: 900 },
        extraHTTPHeaders: {
          "sec-ch-ua": SEC_CH_UA,
          "sec-ch-ua-mobile": "?0",
          "sec-ch-ua-platform": SEC_CH_UA_PLATFORM,
          "accept-language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        ...launchKwargs,
      });
      const freshPages = context.pages();
      page = freshPages.length ? freshPages[0] : await context.newPage();
      _stealth = await StealthBrowserManager.create(page, { logger: log });
      if (_escalator) _escalator.stealth = _stealth;
      _bindPageDebugListeners(page);
      log(
        "[browser] recycle: подписался на page.on('request' | 'requestfailed' | 'response', ...)",
      );
      await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });
      const maxRecycleSetup = 4;
      let up = false;
      for (let rs = 1; rs <= maxRecycleSetup; rs += 1) {
        up = await _setupSearchSession(page, {
          supplyFilter31,
          statusFinishedOnly,
          rakDocumentTypeFilter,
          periodBody: setupPeriodRef,
        });
        if (up) break;
        log(
          `[browser] recycle: POST /Search не пойман (попытка setup ${rs}/${maxRecycleSetup})`,
        );
        if (rs < maxRecycleSetup) await _stealth.smartWait("reading");
      }
      if (!up) {
        throw new Error(
          "[browser] recycle: не пойман POST /Search после перезапуска — см. ./debug/",
        );
      }
    };
    _browserRecycleForDuplicateIp = recycleBrowserAfterDupIp;

    _bindPageDebugListeners(page);
    log(
      "[browser] подписался на page.on('request' | 'requestfailed' | 'response', ...)",
    );

    await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });

    const sessionUp = await _setupSearchSession(page, {
      supplyFilter31,
      statusFinishedOnly,
      rakDocumentTypeFilter,
      periodBody: setupPeriodRef,
    });

    log("[wait] grace-пауза перед сбросом дебага через smartWait('reading')");
    await _stealth.smartWait("reading");
    await _dumpDebug(page);

    if (!sessionUp) {
      log("[result] Запрос /Search не пойман. Смотри ./debug/ артефакты.");
    } else {
      let url = String(_captured.url);
      let headers = _sanitizeReplayHeaders(_captured.headers);

      let bodyTemplate = null;
      const maxBodyParseAttempts = 5;
      for (let bpa = 1; bpa <= maxBodyParseAttempts; bpa += 1) {
        try {
          bodyTemplate = JSON.parse(_captured.body);
          break;
        } catch (e) {
          log(`[main] тело /Search не JSON (попытка ${bpa}/${maxBodyParseAttempts}): ${e}`);
          if (bpa >= maxBodyParseAttempts) {
            bodyTemplate = null;
            break;
          }
          log("[main] повторно поднимаю сессию поиска после битого шаблона...");
          const upAgain = await _setupSearchSession(page, {
            supplyFilter31,
            statusFinishedOnly,
            rakDocumentTypeFilter,
            periodBody: setupPeriodRef,
          });
          if (!upAgain) {
            log("[main] повторный setup не поднял /Search — шаблон недоступен");
            bodyTemplate = null;
            break;
          }
          url = String(_captured.url);
          headers = _sanitizeReplayHeaders(_captured.headers);
        }
      }

      if (bodyTemplate !== null) {
        let outerEnd = endDay;
        let cycle = 0;
        let emptyStreak = 0;

        // Стек под-окон текущего outer-цикла. Изначально содержит ровно
        // одно полное окно `windowDays`. При срабатывании Query Downgrade
        // (latency `/Search` > SLOW_RESPONSE_THRESHOLD_MS) текущее под-окно
        // дробится на WINDOW_SPLIT_FACTOR кусков и кладётся обратно — LIFO,
        // чтобы первой обрабатывалась самая «свежая» половина.
        let pendingSubs = [{ endDay: outerEnd, daysSpan: windowDays }];
        let outerHadItems = false;
        let outerStats = {
          totalItems: 0,
          addedTypes: 0,
          relabeledTypes: 0,
          pagesSeen: 0,
          subsDone: 0,
          downgrades: 0,
          linksSkippedCategory: 0,
        };

        while (cycle < cycles) {
          if (pendingSubs.length === 0) {
            if (outerHadItems) {
              cycle += 1;
              emptyStreak = 0;
              log(
                `=== цикл ${cycle}/${_cyclesLabel(cycles)} готов ` +
                  `(${_formatDdMmYyyy(outerEnd)}, ${windowDays}д): ` +
                  `sub-окон=${outerStats.subsDone}, ` +
                  `downgrades=${outerStats.downgrades}, ` +
                  `страниц=${outerStats.pagesSeen}, ` +
                  `items=${outerStats.totalItems}, ` +
                  (mode === MODE_TYPES
                    ? `новых типов=${outerStats.addedTypes}, ` +
                      `обновлено подписей=${outerStats.relabeledTypes}`
                    : `новых pdf-ссылок=${outerStats.addedTypes}, ` +
                      `пропуск kad-категории=${outerStats.linksSkippedCategory}, ` +
                      `всего ссылок=${decisionLinks.size}`) +
                  ` ===`,
              );
            } else {
              emptyStreak += 1;
              log(
                `[skip] ${_formatDdMmYyyy(outerEnd)} пусто ` +
                  `(подряд пустых: ${emptyStreak}` +
                  (RAS_EMPTY_WINDOW_STREAK_LIMIT > 0
                    ? `/${RAS_EMPTY_WINDOW_STREAK_LIMIT}`
                    : ", лимит выкл.") +
                  `) — не засчитываю за цикл, иду назад`,
              );
              if (
                RAS_EMPTY_WINDOW_STREAK_LIMIT > 0 &&
                emptyStreak >= RAS_EMPTY_WINDOW_STREAK_LIMIT
              ) {
                log(
                  `[skip] ${emptyStreak} пустых окон подряд — автостоп ` +
                    `(RAS_EMPTY_WINDOW_STREAK_LIMIT=${RAS_EMPTY_WINDOW_STREAK_LIMIT}). ` +
                    `Чтобы убрать лимит: RAS_EMPTY_WINDOW_STREAK_LIMIT=0`,
                );
                break;
              }
            }
            if (cycle >= cycles) break;
            outerEnd = new Date(
              outerEnd.getFullYear(),
              outerEnd.getMonth(),
              outerEnd.getDate() - windowDays,
            );
            if (
              oldestDay !== null &&
              _startOfDay(outerEnd).getTime() < oldestDay.getTime()
            ) {
              log(
                `[range] следующий конец окна ${_formatDdMmYyyy(outerEnd)} раньше ` +
                  `нижней границы ${_formatDdMmYyyy(oldestDay)} — останавливаюсь`,
              );
              break;
            }
            pendingSubs = [{ endDay: outerEnd, daysSpan: windowDays }];
            outerHadItems = false;
            outerStats = {
              totalItems: 0,
              addedTypes: 0,
              relabeledTypes: 0,
              pagesSeen: 0,
              subsDone: 0,
              downgrades: 0,
              linksSkippedCategory: 0,
            };
            continue;
          }

          const sub = pendingSubs.pop();
          const [df, dt] = _windowIso(sub.endDay, sub.daysSpan);
          bodyTemplate.DateFrom = df;
          bodyTemplate.DateTo = dt;
          setupPeriodRef.DateFrom = df;
          setupPeriodRef.DateTo = dt;
          const cycleNumStr = String(cycle + 1).padStart(3, "0");
          const label =
            sub.daysSpan === windowDays
              ? `c${cycleNumStr}`
              : `c${cycleNumStr}d${sub.daysSpan}`;
          log(
            `=== пробую окно ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д ` +
              `(${df}..${dt}); завершено циклов: ${cycle}/${_cyclesLabel(cycles)}, ` +
              `в стеке ещё: ${pendingSubs.length} ===`,
          );

          let stats = null;
          let dupRecycleAttempts = 0;
          let downgradeRetry = false;
          while (true) {
            try {
              stats = await _walkPagesForBody(
                page,
                url,
                headers,
                bodyTemplate,
                label,
                mode,
                targetTypeIdsSet,
                sub,
                {
                  rakDocumentTypeFilter,
                  statusFinishedOnly,
                },
                supplyFilter31,
              );
              break;
            } catch (err) {
              if (err instanceof WindowDowngradeError) {
                outerStats.downgrades += 1;
                const halves = splitWindow(sub, WINDOW_SPLIT_FACTOR);
                log(
                  `[downgrade] ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д ` +
                    `→ дроблю на ${halves.length}: ` +
                    halves
                      .map(
                        (h) =>
                          `${_formatDdMmYyyy(h.endDay)}/${h.daysSpan}д`,
                      )
                      .join(", "),
                );
                for (const h of [...halves].reverse()) pendingSubs.push(h);
                try {
                  await _recoverFrom(
                    `window downgrade ${err.info.latencyMs.toFixed(0)}мс ` +
                      `на ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д p${err.info.pageNum}`,
                    { kind: ESC_KIND_BANNED },
                  );
                } catch (recErr) {
                  if (recErr instanceof RecycleWindowError) {
                    log(
                      `[downgrade] _recoverFrom вызвал recycle браузера — ` +
                        `это ОК, под-окно уже в стеке, продолжаю`,
                    );
                  } else {
                    throw recErr;
                  }
                }
                url = String(_captured.url);
                headers = _sanitizeReplayHeaders(_captured.headers);
                try {
                  bodyTemplate = JSON.parse(_captured.body);
                } catch (pe) {
                  throw new Error(
                    `[main] downgrade: шаблон запроса битый: ${pe}`,
                  );
                }
                downgradeRetry = true;
                break;
              }
              if (!(err instanceof RecycleWindowError)) throw err;
              dupRecycleAttempts += 1;
              if (dupRecycleAttempts > MAX_WINDOW_RECYCLES_AFTER_DUP_IP) {
                throw new Error(
                  `[main] duplicate new_ip: исчерпано ${MAX_WINDOW_RECYCLES_AFTER_DUP_IP} ` +
                    `перезапусков браузера на одном окне`,
                );
              }
              log(
                `[main] ${err.message} — снова прогоняю окно ` +
                  `${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д ` +
                  `(recycle ${dupRecycleAttempts}/${MAX_WINDOW_RECYCLES_AFTER_DUP_IP})`,
              );
              url = String(_captured.url);
              headers = _sanitizeReplayHeaders(_captured.headers);
              let freshTmpl = null;
              try {
                freshTmpl = JSON.parse(_captured.body);
              } catch (pe) {
                throw new Error(`[main] recycle: шаблон запроса битый: ${pe}`);
              }
              bodyTemplate = freshTmpl;
              bodyTemplate.DateFrom = df;
              bodyTemplate.DateTo = dt;
              setupPeriodRef.DateFrom = df;
              setupPeriodRef.DateTo = dt;
            }
          }

          if (downgradeRetry) continue;

          outerStats.subsDone += 1;
          outerStats.totalItems += stats.items;
          outerStats.addedTypes += mode === MODE_TYPES ? stats.added : stats.links_added;
          outerStats.relabeledTypes += stats.relabeled;
          outerStats.pagesSeen += stats.pages_seen;
          outerStats.linksSkippedCategory +=
            mode === MODE_DECISION_LINKS ? stats.links_skipped_category : 0;
          if (stats.items > 0) outerHadItems = true;
          if (mode === MODE_TYPES) {
            log(
              `[sub] ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д готово: ` +
                `TotalCount=${stats.total}, ` +
                `страниц=${stats.pages_seen}, items=${stats.items}, ` +
                `новых типов=${stats.added}, ` +
                `обновлено подписей=${stats.relabeled}`,
            );
          } else {
            log(
              `[sub] ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д готово: ` +
                `TotalCount=${stats.total}, ` +
                `страниц=${stats.pages_seen}, items=${stats.items}, ` +
                `новых pdf-ссылок=${stats.links_added}, ` +
                `пропуск по категории kad=${stats.links_skipped_category}, ` +
                `всего ссылок=${decisionLinks.size}`,
            );
          }
        }
      }
    }

    if (mode === MODE_TYPES) {
      log(
        `=== готово. DocumentType собрано: ${Object.keys(documentTypes).length} -> ${OUT_PATH} ===`,
      );
    } else {
      _saveDecisionLinks();
      log(`=== готово. PDF-ссылки собраны: ${decisionLinks.size} -> ${LINKS_OUT_PATH} ===`);
    }
  } catch (e) {
    if (e instanceof EscalationExhausted) {
      log(`[escalator] исчерпан: ${e.message}`);
      log(`[escalator] summary=${JSON.stringify(e.summary)}`);
      if (/исчерпан общий бюджет/i.test(e.message)) {
        log(
          "[escalator] сработал ESC_MAX_BUDGET_SEC (тайм-лимит эскалатора). " +
            "Для длительных прогонов поставь в .env ESC_MAX_BUDGET_SEC=0 (без лимита) " +
            "или увеличь значение, затем перезапусти.",
        );
      } else if (/исчерпан лимит totalFailures/i.test(e.message)) {
        log(
          "[escalator] сработал ESC_MAX_TOTAL_FAILURES. " +
            "Для длительных прогонов поставь ESC_MAX_TOTAL_FAILURES=0 (без лимита) " +
            "или увеличь значение. Защита от зацикливания на одном IP — лестница L1/L2.",
        );
      } else {
        log(
          "[escalator] больше менять прокси нечем (лестница L1/L2/L3), прекращаю прогон. " +
            "Проверь баланс/доступность гео и перезапусти.",
        );
      }
    } else if (e instanceof RecycleWindowError) {
      log(`[main] RecycleWindowError вне цикла окон: ${e.message}`);
    } else if (e instanceof WindowDowngradeError) {
      log(`[main] WindowDowngradeError вне цикла окон: ${e.message}`);
    } else {
      log(`Error: ${e}`);
      if (e && e.stack) process.stderr.write(`${e.stack}\n`);
    }
  } finally {
    _browserRecycleForDuplicateIp = null;
    log("[shutdown] закрываю браузер");
    if (context !== null) {
      try {
        await context.close();
      } catch (e) {
        log(`[shutdown] context.close() упал: ${e}`);
      }
    }
    if (userDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
    if (_xvfbProcess !== null) {
      try {
        process.kill(_xvfbProcess.pid, "SIGTERM");
        log(`[shutdown] Xvfb остановлен (pid=${_xvfbProcess.pid})`);
      } catch {}
      _xvfbProcess = null;
    }
    log("[shutdown] всё, выход");
  }
}

main();
