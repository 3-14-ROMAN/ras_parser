/**
 * Сбор справочника DocumentType с https://ras.arbitr.ru/.
 *
 * Логика:
 * 1. Поднимаем Chromium через мобильный прокси (HTTP, авторизация по
 *    user/pass из config.js).
 * 2. Открываем ras.arbitr.ru, ждём load-event и ещё 8с (чтоб WASM-
 *    fingerprint и jQuery успели инициализироваться).
 * 3. Жмём кнопку «Найти» (несколько селекторов + jQuery-fallback) и
 *    ждём первый POST на .../Search.
 * 4. Перехватываем url/headers/body первого POST -> /Search и сохраняем шаблон.
 * 5. Для страниц 2..MAX_PAGES сами вызываем page.request.post с тем же телом
 *    (только меняем "Page"). Запрос идёт из контекста браузера —
 *    куки/anti-bot токены те же.
 * 6. Из каждого item достаём TypeId / Type (имя) и копим в dict,
 *    инкрементально пишем document_types.json.
 * 7. Если страница падает (исключение / not-200 / json-decode) —
 *    дёргаем CHANGE_IP_URL у мобильного прокси, ждём, повторяем запрос.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import {
  CHANGE_IP_COOLDOWN_SEC,
  CHANGE_IP_URL,
  PAGE_DELAY_MAX_SEC,
  PAGE_DELAY_MIN_SEC,
  PROXY_PASS,
  PROXY_SERVER,
  PROXY_USER,
} from "./config.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = __dirname;

const BASE_URL = "https://ras.arbitr.ru/";
const OUT_PATH = path.join(PROJECT_DIR, "document_types.json");

const DEBUG_DIR = path.join(PROJECT_DIR, "debug");
const DEBUG_RESPONSES = path.join(DEBUG_DIR, "debug_responses.txt");
const DEBUG_SCREENSHOT = path.join(DEBUG_DIR, "debug_page.png");
const DEBUG_HTML = path.join(DEBUG_DIR, "debug_page.html");
const DEBUG_SEARCH_DIR = path.join(DEBUG_DIR, "search");

const MAX_PAGES = 40;
const WAIT_FOR_SEARCH_MS = 60_000;

const HEADLESS = (process.env.RAS_HEADLESS ?? "1") === "1";

const USER_AGENT =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0.6367.207 Safari/537.36";
const SEC_CH_UA =
  '"Google Chrome";v="124", "Chromium";v="124", "Not.A/Brand";v="99"';
const SEC_CH_UA_PLATFORM = '"Linux"';

const documentTypes = {};

const _captured = {
  url: null,
  headers: null,
  body: null,
};

const _responseLog = [];
let _firstItemLogged = false;
let _searchDumpIdx = 0;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const monotonic = () => performance.now() / 1000;
const randUniform = (a, b) => a + Math.random() * (b - a);

function pad2(n) {
  return String(n).padStart(2, "0");
}

function log(msg) {
  const d = new Date();
  const ts = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  process.stdout.write(`[${ts}] ${msg}\n`);
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
    headless: HEADLESS,
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
  return pathname.endsWith("/Search");
}

function _loadExisting() {
  if (!fs.existsSync(OUT_PATH) || !fs.statSync(OUT_PATH).isFile()) {
    log(`[load] ${OUT_PATH} нет — стартуем с пустого справочника`);
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(OUT_PATH, "utf-8");
  } catch (e) {
    log(`[load] не прочитал ${OUT_PATH}: ${e}`);
    return;
  }
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log(`[load] ${OUT_PATH} битый JSON (${e}) — игнорирую, не перезаписываю`);
    return;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    log(`[load] ${OUT_PATH} не dict (${typeof data}) — игнорирую`);
    return;
  }
  let count = 0;
  for (const [k, v] of Object.entries(data)) {
    if (typeof k === "string" && typeof v === "string") {
      documentTypes[k] = v;
      count += 1;
    }
  }
  log(`[load] подхватил ${count} существующих типов из ${OUT_PATH}`);
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

  let raw = item.Type;
  if (raw === null || raw === undefined) raw = item.DocumentType;

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

  return [typeId ?? null, typeName ?? null];
}

function _processItems(items) {
  if (items.length && !_firstItemLogged) {
    const sample = items[0];
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      log(`[items] ключи первого item: ${JSON.stringify(Object.keys(sample).sort())}`);
    }
    _firstItemLogged = true;
  }

  let added = 0;
  for (const item of items) {
    const [typeId, typeName] = _extractDocType(item);
    if (typeId === null || typeId === undefined) continue;
    const key = typeName !== null && typeName !== undefined && typeName !== ""
      ? typeName
      : `id_${typeId}`;
    if (Object.prototype.hasOwnProperty.call(documentTypes, key)) continue;
    documentTypes[key] = typeId;
    added += 1;
  }
  return added;
}

function _onRequest(request) {
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

  let rawBytes = null;
  try {
    rawBytes = await response.body();
  } catch (e) {
    log(`[capture] response.body() упал: ${e}`);
  }

  if (rawBytes !== null && rawBytes !== undefined) {
    _dumpSearchResponse("page1-raw", rawBytes, "bin");
  }

  if (response.status() !== 200) {
    log(`[capture] /Search status=${response.status()} — пропуск парсинга`);
    return;
  }

  if (_captured.url === null) {
    _captured.url = response.url();
    _captured.headers = request.headers();
    _captured.body = request.postData();
    log(`[capture] Перехвачен POST ${response.url()}`);
    try {
      const reqBody = _captured.body;
      if (reqBody) {
        _dumpSearchResponse("page1-request", String(reqBody), "json");
      }
    } catch {}
  }

  let data = null;
  try {
    data = await response.json();
  } catch (e) {
    log(`[capture] response.json() упал: ${e}`);
    return;
  }

  if (!data || typeof data !== "object" || Array.isArray(data)) {
    log(`[capture] неожиданный тип ответа: ${typeof data}`);
    return;
  }

  log(`[capture] top-level ключи ответа: ${JSON.stringify(Object.keys(data).sort())}`);
  const result = data.Result;
  if (result && typeof result === "object" && !Array.isArray(result)) {
    log(`[capture] Result-ключи: ${JSON.stringify(Object.keys(result).sort())}`);
  }

  const items = _findItemsAnywhere(data);
  log(`[capture] найдено items=${items.length}`);
  const added = _processItems(items);
  if (items.length) {
    _save();
    log(
      `[response] страница 1: items=${items.length}, ` +
        `новых типов=${added}, всего=${Object.keys(documentTypes).length}`,
    );
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

async function _safeGoto(page, url, retries = 5, delay = 3.0) {
  let lastExc = null;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      log(`[goto] Попытка ${attempt}/${retries}: GET ${url}`);
      await page.goto(url, { waitUntil: "load", timeout: 120_000 });
      log("[goto] Страница загружена (load event)");
      return;
    } catch (e) {
      lastExc = e;
      log(`[goto] Попытка ${attempt}/${retries} провалена: ${e}`);
      await sleep(delay * 1000);
    }
  }
  if (lastExc !== null) throw lastExc;
}

async function _humanClick(page, selector) {
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) {
      log(`[click] ${selector} -> элемент не найден`);
      return false;
    }
    await loc.scrollIntoViewIfNeeded({ timeout: 5_000 });
    const box = await loc.boundingBox();
    if (!box) {
      log(`[click] ${selector} -> нет bounding_box (скрыт?)`);
      return false;
    }
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    await page.mouse.move(cx - 30, cy - 20, { steps: 10 });
    await page.waitForTimeout(200);
    await page.mouse.move(cx, cy, { steps: 10 });
    await page.waitForTimeout(150);
    await page.mouse.click(cx, cy, { delay: 80 });
    log(`[click] mouse click по ${selector} в (${cx.toFixed(0)},${cy.toFixed(0)})`);
    return true;
  } catch (e) {
    log(`[click] mouse ${selector} -> ${e}`);
    return false;
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

async function _waitBrieflyForSearch(page, seconds) {
  const deadline = monotonic() + seconds;
  while (monotonic() < deadline) {
    if (_searchCaptured()) return true;
    await page.waitForTimeout(200);
  }
  return _searchCaptured();
}

async function _clickFind(page) {
  log("[click] Ищу кнопку «Найти» и пытаюсь кликнуть...");
  await _dumpButtonHandlers(page);

  const targets = [
    "#b-form-submit",
    "#b-form-submit .b-button-container",
    '#b-form-submit button[type="submit"]',
  ];
  let anyClicked = false;
  for (const sel of targets) {
    if (_searchCaptured()) return true;
    const clicked = await _humanClick(page, sel);
    anyClicked = anyClicked || clicked;
    if (!clicked) continue;
    if (await _waitBrieflyForSearch(page, 3.0)) {
      log(`[click] /Search пойман после клика по ${sel}`);
      return true;
    }
    log(`[click] после клика по ${sel} /Search ещё нет, пробую следующий вариант`);
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
      if (await _waitBrieflyForSearch(page, 3.0)) {
        log("[click] /Search пойман после jQuery trigger");
        return true;
      }
    }
  } catch (e) {
    log(`[click] JS fallback -> ${e}`);
  }

  return anyClicked;
}

async function _rotateIp(reason = "") {
  if (!CHANGE_IP_URL) {
    log("[ip] CHANGE_IP_URL не задан — пропуск ротации");
    return false;
  }

  const suffix = reason ? ` (${reason})` : "";
  log(`[ip] ротация мобильного IP${suffix}...`);
  let resp;
  try {
    resp = await fetch(CHANGE_IP_URL, {
      headers: { "User-Agent": "ras_parser/ip-rotator" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    log(`[ip] ошибка вызова changeip: ${e}`);
    return false;
  }

  if (resp.status >= 400) {
    log(`[ip] HTTPError ${resp.status}: ${resp.statusText}`);
    return false;
  }

  let body;
  try {
    body = (await resp.text()).slice(0, 4096).trim();
  } catch (e) {
    log(`[ip] ошибка чтения body: ${e}`);
    return false;
  }

  let parsed = null;
  try {
    parsed = JSON.parse(body);
  } catch {}

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const apiStatus = parsed.status;
    const apiCode = parsed.code;
    const newIp = parsed.new_ip;
    const rt = parsed.rt;
    log(
      `[ip] changeip http=${resp.status}, status=${apiStatus}, ` +
        `code=${apiCode}, new_ip=${newIp}, rt=${rt}`,
    );
    if (apiStatus !== undefined && apiStatus !== null && apiStatus !== "OK") {
      log(`[ip] провайдер вернул не-OK: ${JSON.stringify(body)}`);
      return false;
    }
  } else {
    log(
      `[ip] changeip http=${resp.status}, body(не JSON)=${JSON.stringify(body.slice(0, 200))}`,
    );
  }

  log(`[ip] жду ${CHANGE_IP_COOLDOWN_SEC}с, чтобы IP переехал`);
  await sleep(CHANGE_IP_COOLDOWN_SEC * 1000);
  return true;
}

async function _postSearchPage(page, url, headers, body, label = "replay") {
  let resp;
  try {
    resp = await page.request.post(url, {
      headers,
      data: body,
      timeout: 60_000,
    });
  } catch (e) {
    return [null, null, `request-exc: ${e}`];
  }

  let raw = null;
  try {
    raw = await resp.body();
  } catch (e) {
    log(`[replay] resp.body() упал: ${e}`);
  }
  if (raw !== null && raw !== undefined) {
    _dumpSearchResponse(`${label}-status${resp.status()}`, raw, "bin");
  }

  if (resp.status() !== 200) {
    return [resp.status(), null, `status=${resp.status()}`];
  }

  try {
    return [resp.status(), await resp.json(), ""];
  } catch (e) {
    return [resp.status(), null, `json-decode: ${e}`];
  }
}

async function _walkPagesForBody(page, url, headers, bodyObj, labelPrefix) {
  const stats = {
    total: null,
    return_count: null,
    pages_seen: 0,
    items: 0,
    added: 0,
  };

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    bodyObj.Page = pageNum;
    const newBody = JSON.stringify(bodyObj);

    log(`[${labelPrefix}] страница ${pageNum}...`);

    let data = null;
    for (const attempt of [1, 2]) {
      const [, parsed, err] = await _postSearchPage(
        page,
        url,
        headers,
        newBody,
        `${labelPrefix}-p${pageNum}-t${attempt}`,
      );
      if (parsed !== null && parsed !== undefined) {
        data = parsed;
        break;
      }
      log(`[${labelPrefix} p${pageNum}] попытка ${attempt}/2: ${err}`);
      if (attempt === 1) {
        await _rotateIp(`${labelPrefix} p${pageNum} ${err}`);
      }
    }

    if (data === null) {
      log(`[${labelPrefix} p${pageNum}] обе попытки провалены, пропуск страницы`);
      continue;
    }

    if (pageNum === 1) {
      const success = (data && typeof data === "object") ? data.Success : null;
      const message = (data && typeof data === "object") ? data.Message : null;
      const result = (data && typeof data === "object") ? data.Result : null;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        stats.total = result.TotalCount ?? null;
        stats.return_count = result.ReturnCount ?? null;
        const pc = result.PagesCount ?? null;
        log(
          `[${labelPrefix}] Success=${success}, ` +
            `TotalCount=${stats.total}, ` +
            `ReturnCount=${stats.return_count}, PagesCount=${pc}`,
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
      const topKeys = (data && typeof data === "object" && !Array.isArray(data))
        ? Object.keys(data).sort()
        : [];
      log(`[${labelPrefix} p${pageNum}] пусто (top-keys=${JSON.stringify(topKeys)}) — конец окна`);
      break;
    }

    const added = _processItems(items);
    _save();
    stats.pages_seen += 1;
    stats.items += items.length;
    stats.added += added;
    log(
      `[${labelPrefix} p${pageNum}] items=${items.length}, ` +
        `новых типов=${added}, всего=${Object.keys(documentTypes).length}`,
    );

    if (pageNum < MAX_PAGES) {
      const delay = randUniform(PAGE_DELAY_MIN_SEC, PAGE_DELAY_MAX_SEC);
      log(`[${labelPrefix} p${pageNum}] пауза ${delay.toFixed(2)}с до следующей страницы`);
      await sleep(delay * 1000);
    }
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

async function _promptSetup() {
  const now = new Date();
  const todayDt = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  const cyclesEnv = (process.env.RAS_CYCLES ?? "").trim();
  let cycles = null;
  if (cyclesEnv) {
    const parsed = parseInt(cyclesEnv, 10);
    if (!Number.isNaN(parsed)) {
      cycles = Math.max(1, parsed);
      log(`[setup] cycles=${cycles} (RAS_CYCLES)`);
    } else {
      log(`[setup] RAS_CYCLES='${cyclesEnv}' не число, спрошу руками`);
    }
  }
  if (cycles === null) {
    while (true) {
      const raw = (await _ask("Сколько циклов прогнать (например 1 или 200): ")).trim();
      const parsed = parseInt(raw, 10);
      if (!Number.isNaN(parsed) && parsed >= 1) {
        cycles = parsed;
        break;
      }
      process.stdout.write("Нужно целое число >= 1, попробуй ещё раз.\n");
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

  const startEnv = (process.env.RAS_START_DATE ?? "").trim();
  let endDay;
  if (startEnv) {
    const parsed = _parseDdMmYyyy(startEnv);
    if (parsed === null) {
      log(`[setup] RAS_START_DATE='${startEnv}' не дата, ставлю сегодня`);
      endDay = todayDt;
    } else {
      endDay = parsed;
    }
  } else {
    endDay = todayDt;
  }

  log(
    `[setup] cycles=${cycles}, window_days=${windowDays}, ` +
      `end_day=${_formatDdMmYyyy(endDay)} ` +
      `(пустые дни пропускаются, не считаются за цикл)`,
  );
  return [cycles, windowDays, endDay];
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

async function _waitForSearchWithHeartbeat(page, timeoutMs) {
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
      log(`[wait] жду /Search... ещё ${remaining}с, пойманных XHR: ${_responseLog.length}`);
      lastTick = now;
    }
    await page.waitForTimeout(250);
  }
  log("[wait] Таймаут — ответ /Search так и не пришёл.");
  return false;
}

async function main() {
  log("=== старт parser.js ===");
  _resetDebugDir();
  log("[debug] папка ./debug пересоздана");

  _loadExisting();

  const [cycles, windowDays, endDay] = await _promptSetup();

  let context = null;
  let userDataDir = null;
  try {
    log("[browser] запускаю Playwright...");
    const launchKwargs = _launchKwargs();
    log(
      `[browser] запускаю Chromium (headless=${HEADLESS}, прокси=${PROXY_SERVER}, ` +
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
    const page = pages.length ? pages[0] : await context.newPage();
    page.on("request", _onRequest);
    page.on("requestfailed", _onRequestFailed);
    page.on("response", (resp) => {
      _onResponse(resp).catch((e) => log(`[on_response] ${e}`));
    });
    log("[browser] подписался на page.on('request' | 'requestfailed' | 'response', ...)");

    await _safeGoto(page, BASE_URL);

    log("[load] жду 8с, чтобы JS/jQuery/fingerprint доинициализировались");
    for (let i = 8; i >= 1; i -= 1) {
      log(`[load] ...осталось ${i}с`);
      await page.waitForTimeout(1000);
    }

    try {
      const hasJq = await page.evaluate(
        () => !!window.jQuery && !!window.jQuery("#b-form-submit").length,
      );
      log(`[load] jQuery + #b-form-submit готовы: ${hasJq}`);
    } catch (e) {
      log(`[load] проверка jQuery упала: ${e}`);
    }

    if (!(await _clickFind(page))) {
      log("[click] НЕ удалось кликнуть ни одним способом");
    }

    log(`[wait] жду первый POST /Search до ${Math.floor(WAIT_FOR_SEARCH_MS / 1000)}с...`);
    await _waitForSearchWithHeartbeat(page, WAIT_FOR_SEARCH_MS);

    await page.waitForTimeout(2000);
    await _dumpDebug(page);

    if (_captured.url === null) {
      log("[result] Запрос /Search не пойман. Смотри ./debug/ артефакты.");
    } else {
      const url = String(_captured.url);
      const headers = { ...(_captured.headers || {}) };
      const dropList = new Set([
        "content-length",
        "host",
        ":authority",
        ":method",
        ":path",
        ":scheme",
      ]);
      for (const h of Object.keys(headers)) {
        if (dropList.has(h.toLowerCase())) {
          delete headers[h];
        }
      }

      let bodyTemplate = null;
      try {
        bodyTemplate = JSON.parse(_captured.body);
      } catch (e) {
        log(`[main] тело запроса не JSON: ${e} — выхожу`);
        bodyTemplate = null;
      }

      if (bodyTemplate !== null) {
        let currentEnd = endDay;
        let cycle = 0;
        let emptyStreak = 0;
        const emptyStreakLimit = 60;
        while (cycle < cycles) {
          const [df, dt] = _windowIso(currentEnd, windowDays);
          bodyTemplate.DateFrom = df;
          bodyTemplate.DateTo = dt;
          const label = `c${String(cycle + 1).padStart(3, "0")}`;
          log(
            `=== пробую окно ${_formatDdMmYyyy(currentEnd)} ` +
              `(${df}..${dt}); набрано циклов: ${cycle}/${cycles} ===`,
          );
          const stats = await _walkPagesForBody(
            page,
            url,
            headers,
            bodyTemplate,
            label,
          );
          if (stats.items === 0) {
            emptyStreak += 1;
            log(
              `[skip] ${_formatDdMmYyyy(currentEnd)} пусто ` +
                `(подряд пустых: ${emptyStreak}/${emptyStreakLimit}) — ` +
                `не засчитываю за цикл, иду назад`,
            );
            if (emptyStreak >= emptyStreakLimit) {
              log(
                `[skip] ${emptyStreak} пустых окон подряд — ` +
                  `останавливаюсь, что-то не так`,
              );
              break;
            }
          } else {
            cycle += 1;
            emptyStreak = 0;
            log(
              `=== цикл ${cycle}/${cycles} готов ` +
                `(${_formatDdMmYyyy(currentEnd)}): ` +
                `TotalCount=${stats.total}, ` +
                `страниц=${stats.pages_seen}, ` +
                `items=${stats.items}, ` +
                `новых типов=${stats.added} ===`,
            );
          }
          currentEnd = new Date(
            currentEnd.getFullYear(),
            currentEnd.getMonth(),
            currentEnd.getDate() - windowDays,
          );
        }
      }
    }

    log(
      `=== готово. DocumentType собрано: ${Object.keys(documentTypes).length} -> ${OUT_PATH} ===`,
    );
  } catch (e) {
    log(`Error: ${e}`);
    if (e && e.stack) process.stderr.write(`${e.stack}\n`);
  } finally {
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
    log("[shutdown] всё, выход");
  }
}

main();
