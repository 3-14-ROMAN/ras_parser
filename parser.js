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
 * 3. Жмём кнопку «Найти» через `_stealth.click(...)` (несколько
 *    селекторов + jQuery-fallback) и ждём первый POST на .../Search.
 * 4. Перехватываем url/headers/body первого POST -> /Search и
 *    сохраняем шаблон.
 * 5. Для страниц 2..MAX_PAGES сами вызываем page.request.post с тем
 *    же телом (только меняем "Page"). Запрос идёт из контекста
 *    браузера — куки/anti-bot токены те же. Между страницами —
 *    `_stealth.smartWait('api_delay')` (1.5..4с с редкими выбросами
 *    до 10с).
 * 6. Из каждого item достаём TypeId / Type (имя) и копим в dict
 *    (один ключ на id: подпись улучшается, если приходит более длинное
 *    имя или заменяется синтетический id_<uuid>), инкрементально пишем
 *    document_types.json.
 * 7. Если страница падает (исключение / not-200 / json-decode) —
 *    дёргаем CHANGE_IP_URL у мобильного прокси, после ротации даём
 *    `_stealth.smartWait('ip_cooldown')`, повторяем запрос.
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
import "./loadEnv.js";

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import {
  CHANGE_IP_COOLDOWN_SEC,
  CHANGE_IP_URL,
  ESC_MAX_BUDGET_SEC,
  ESC_MAX_GEO_SWAPS,
  ESC_MAX_IP_BEFORE_EQUIPMENT,
  ESC_MAX_OPERATOR_BEFORE_GEO,
  ESC_MAX_TOTAL_FAILURES,
  GEO_FILTERS,
  MP_API_TOKEN,
  MP_PROXY_ID,
  MP_PROXY_KEY,
  PROXY_PASS,
  PROXY_SERVER,
  PROXY_USER,
} from "./config.js";
import { ESC_KINDS, EscalationExhausted, ProxyEscalator } from "./escalator.js";
import { RasProxyClient } from "./proxyClient.js";
import { StealthBrowserManager } from "./stealthManager.js";

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
 * Эскалатор. Если задан `MP_API_TOKEN` — создаём `ProxyEscalator`
 * с лестницей changeIp → changeOperator → changeGeo. Если токена
 * нет — остаёмся на legacy-логике `fetch(CHANGE_IP_URL)` (только
 * ротация IP), `_recoverFrom` фоллбекается на неё.
 *
 * @type {ProxyEscalator | null}
 */
let _escalator = null;

const monotonic = () => performance.now() / 1000;

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
    `[load] из ${OUT_PATH}: записей=${pairs.length}, уникальных id=${idToKey.size}`,
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
    const reqBody = _captured.body;
    if (reqBody) {
      try {
        _dumpSearchResponse("page1-request", String(reqBody), "json");
      } catch (e) {
        log(`[capture] дамп тела запроса упал: ${e}`);
      }
    }
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
  const { added, relabeled } = _processItems(items);
  if (items.length) {
    _save();
    log(
      `[response] страница 1: items=${items.length}, ` +
        `новых типов=${added}, обновлено подписей=${relabeled}, ` +
        `всего=${Object.keys(documentTypes).length}`,
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
 *   - строку с кодом внутри (например `"status=429"` от `_postSearchPage`).
 *
 * Триггерим ротацию IP на:
 *   - 403 (Forbidden) — типичный «по IP отлуп»;
 *   - 429 (Too Many Requests) — rate limit;
 *   - 500..525 — серверная пятисотка / Cloudflare 520..525, которая в
 *     90% случаев у арбитров означает, что наш IP попал в throttle.
 * 401, 404 и прочие 4xx — нет смысла крутить IP, это «корректный отказ».
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
  return code === 403 || code === 429 || (code >= 500 && code <= 525);
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
    const clicked = await _stealth.click(sel, { afterWait: "micro" });
    anyClicked = anyClicked || clicked;
    if (!clicked) continue;
    if (await _waitBrieflyForSearch(3.0)) {
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
      if (await _waitBrieflyForSearch(3.0)) {
        log("[click] /Search пойман после jQuery trigger");
        return true;
      }
    }
  } catch (e) {
    log(`[click] JS fallback -> ${e}`);
  }

  return anyClicked;
}

/**
 * Монотонное время последнего вызова `fetch(CHANGE_IP_URL)`. Используется
 * legacy-фоллбеком `_legacyRotateIp` (когда MP_API_TOKEN не задан), чтобы
 * выдержать hard-cooldown между ротациями.
 */
let _lastRotateAt = -Infinity;

async function _legacyRotateIp(reason = "") {
  if (!CHANGE_IP_URL) {
    log("[ip/legacy] CHANGE_IP_URL не задан — пропуск ротации");
    return false;
  }

  const since = monotonic() - _lastRotateAt;
  if (since < CHANGE_IP_COOLDOWN_SEC) {
    log(
      `[ip/legacy] hard-cooldown: с прошлой ротации прошло ${since.toFixed(1)}с, ` +
        `минимум ${CHANGE_IP_COOLDOWN_SEC}с — жду через smartWait('ip_cooldown')`,
    );
    await _stealth.smartWait("ip_cooldown");
  }

  const suffix = reason ? ` (${reason})` : "";
  log(`[ip/legacy] ротация мобильного IP${suffix}...`);
  _lastRotateAt = monotonic();
  let resp;
  try {
    resp = await fetch(CHANGE_IP_URL, {
      headers: { "User-Agent": "ras_parser/ip-rotator" },
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e) {
    log(`[ip/legacy] ошибка вызова changeip: ${e}`);
    return false;
  }

  if (resp.status >= 400) {
    log(`[ip/legacy] HTTPError ${resp.status}: ${resp.statusText}`);
    return false;
  }

  let body;
  try {
    body = (await resp.text()).slice(0, 4096).trim();
  } catch (e) {
    log(`[ip/legacy] ошибка чтения body: ${e}`);
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
      `[ip/legacy] changeip http=${resp.status}, status=${apiStatus}, ` +
        `code=${apiCode}, new_ip=${newIp}, rt=${rt}`,
    );
    if (apiStatus !== undefined && apiStatus !== null && apiStatus !== "OK") {
      log(`[ip/legacy] провайдер вернул не-OK: ${JSON.stringify(body)}`);
      return false;
    }
  } else {
    log(
      `[ip/legacy] changeip http=${resp.status}, body(не JSON)=${JSON.stringify(body.slice(0, 200))}`,
    );
  }

  log("[ip/legacy] cooldown через smartWait('ip_cooldown'), чтобы IP переехал");
  await _stealth.smartWait("ip_cooldown");
  return true;
}

/**
 * Единая точка восстановления при «надо сделать что-то с прокси».
 *
 * Если включён эскалатор (`MP_API_TOKEN` задан) — он сам решает,
 * крутить IP / менять оператора / менять гео, и сам делает settle через
 * `smartWait('ip_cooldown' | 'equipment_swap')`. Если эскалатор кидает
 * `EscalationExhausted` — пробрасываем НАВЕРХ, ловится в `main()`,
 * это сигнал «всё, дальше парсить бессмысленно». Это страховка от
 * бесконечного цикла ip↔eq↔ip↔eq.
 *
 * Если эскалатор не включён — фоллбек на legacy `fetch(CHANGE_IP_URL)`,
 * без эскалации; парсер ведёт себя как раньше до интеграции SDK.
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
  if (_escalator) {
    const r = await _escalator.recoverFrom(reason, opts);
    log(
      `[recover] level=${r.level} kind=${r.kind} OK; ` +
        `summary=${JSON.stringify(_escalator.summary())}`,
    );
    return true;
  }
  return await _legacyRotateIp(reason);
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
    relabeled: 0,
  };

  for (let pageNum = 1; pageNum <= MAX_PAGES; pageNum += 1) {
    bodyObj.Page = pageNum;
    const newBody = JSON.stringify(bodyObj);

    log(`[${labelPrefix}] страница ${pageNum}...`);

    let data = null;
    const maxPageAttempts = 8;
    let flapStreak = 0;
    for (let attempt = 1; attempt <= maxPageAttempts; attempt += 1) {
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
        `[${labelPrefix} p${pageNum}] попытка ${attempt}/${maxPageAttempts}${tag}: ${err}`,
      );
      if (attempt >= maxPageAttempts) break;

      if (isFlap) {
        flapStreak += 1;
        await _logAclDiagnostic(url);
        if (flapStreak >= PROXY_FLAP_ROTATE_AFTER) {
          log(
            `[${labelPrefix} p${pageNum}] ${flapStreak} прокси-флапов подряд — ` +
              `kind=net_down, эскалирую через _recoverFrom`,
          );
          const rotated = await _recoverFrom(
            `${labelPrefix} p${pageNum} flap-streak=${flapStreak}`,
            { kind: ESC_KIND_NET_DOWN },
          );
          if (!rotated) {
            log(
              `[${labelPrefix} p${pageNum}] _recoverFrom не сработал — отдельный ip_cooldown`,
            );
            await _stealth.smartWait("ip_cooldown");
          }
          flapStreak = 0;
        } else {
          await _stealth.smartWait("proxy_flap");
        }
      } else if (rotate) {
        flapStreak = 0;
        // _isRotatableNetworkError → реальный отвал сети (timeout, ECONNRESET и т.п.),
        // L3 changeGeo для эскалатора разрешён.
        // _isLikelyBanned → HTTP 403/429/5xx, ban сайтом — менять регион запрещено.
        const isNetDown = _isRotatableNetworkError(err);
        const kind = isNetDown ? ESC_KIND_NET_DOWN : ESC_KIND_BANNED;
        const rotated = await _recoverFrom(
          `${labelPrefix} p${pageNum} ${err}`,
          { kind },
        );
        if (!rotated) {
          log(
            `[${labelPrefix} p${pageNum}] _recoverFrom не сработал — отдельный ip_cooldown`,
          );
          await _stealth.smartWait("ip_cooldown");
        }
      } else {
        flapStreak = 0;
        await _stealth.smartWait("api_delay");
      }
    }

    if (data === null) {
      log(`[${labelPrefix} p${pageNum}] все попытки провалены, пропуск страницы`);
      continue;
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
      const topKeys = isObj ? Object.keys(data).sort() : [];
      log(`[${labelPrefix} p${pageNum}] пусто (top-keys=${JSON.stringify(topKeys)}) — конец окна`);
      break;
    }

    const { added, relabeled } = _processItems(items);
    _save();
    stats.pages_seen += 1;
    stats.items += items.length;
    stats.added += added;
    stats.relabeled += relabeled;
    log(
      `[${labelPrefix} p${pageNum}] items=${items.length}, ` +
        `новых типов=${added}, обновлено подписей=${relabeled}, ` +
        `всего=${Object.keys(documentTypes).length}`,
    );

    if (pageNum < MAX_PAGES) {
      log(
        `[${labelPrefix} p${pageNum}] пауза до следующей страницы через ` +
          "smartWait('api_delay')",
      );
      await _stealth.smartWait("api_delay");
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
 * Не «жжёт» ротации без надобности: ротация триггерится только если
 * `/Search` так и не был пойман за `WAIT_FOR_SEARCH_MS` (живая сессия
 * сюда не доходит — она вернётся после первого же успешного клика).
 *
 * @returns {Promise<boolean>} true — сессия поднята (`_captured.url` не null).
 */
async function _setupSearchSession(page, { maxAttempts = 5 } = {}) {
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

    if (!(await _clickFind(page))) {
      log("[click] НЕ удалось кликнуть ни одним способом");
    }

    log(
      `[wait] жду первый POST /Search до ${Math.floor(WAIT_FOR_SEARCH_MS / 1000)}с...`,
    );
    await _waitForSearchWithHeartbeat(WAIT_FOR_SEARCH_MS);

    if (_captured.url !== null) {
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
    log(
      `[browser] запускаю Chromium (headless=${HEADLESS}, прокси=${PROXY_SERVER}, ` +
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
    const page = pages.length ? pages[0] : await context.newPage();
    _stealth = new StealthBrowserManager(page, { logger: log });
    log("[stealth] StealthBrowserManager инициализирован");

    if (MP_API_TOKEN) {
      const proxyClient = new RasProxyClient({
        apiToken: MP_API_TOKEN,
        proxyKey: MP_PROXY_KEY,
        proxyId: MP_PROXY_ID,
        minIpRotateGapSec: CHANGE_IP_COOLDOWN_SEC,
        logger: log,
      });
      _escalator = new ProxyEscalator({
        proxyClient,
        stealth: _stealth,
        logger: log,
        maxIpRotationsBeforeEquipment: ESC_MAX_IP_BEFORE_EQUIPMENT,
        maxOperatorSwapsBeforeGeo: ESC_MAX_OPERATOR_BEFORE_GEO,
        maxGeoSwaps: ESC_MAX_GEO_SWAPS,
        maxTotalFailures: ESC_MAX_TOTAL_FAILURES,
        maxBudgetSec: ESC_MAX_BUDGET_SEC,
        geoFilters: GEO_FILTERS,
      });
      log(
        `[escalator] включён: maxIp=${ESC_MAX_IP_BEFORE_EQUIPMENT}, ` +
          `maxOp=${ESC_MAX_OPERATOR_BEFORE_GEO}, ` +
          `maxGeo=${ESC_MAX_GEO_SWAPS}, ` +
          `maxFails=${ESC_MAX_TOTAL_FAILURES}, ` +
          `budget=${ESC_MAX_BUDGET_SEC}с`,
      );
      log(
        `[escalator] geoFilters: country=${GEO_FILTERS.requireCountryId ?? "any"}, ` +
          `excludeCities=[${GEO_FILTERS.excludeCityIds.join(",")}], ` +
          `captionRegex=${GEO_FILTERS.excludeCaptionRegex ? GEO_FILTERS.excludeCaptionRegex.source : "off"}`,
      );
    } else {
      log(
        "[escalator] MP_API_TOKEN не задан — эскалация выключена, " +
          "_recoverFrom фоллбекается на legacy fetch(CHANGE_IP_URL)",
      );
    }
    page.on("request", _onRequest);
    page.on("requestfailed", _onRequestFailed);
    page.on("response", (resp) => {
      _onResponse(resp).catch((e) => log(`[on_response] ${e}`));
    });
    log(
      "[browser] подписался на page.on('request' | 'requestfailed' | 'response', ...)",
    );

    await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });

    const sessionUp = await _setupSearchSession(page);

    log("[wait] grace-пауза перед сбросом дебага через smartWait('reading')");
    await _stealth.smartWait("reading");
    await _dumpDebug(page);

    if (!sessionUp) {
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
                `новых типов=${stats.added}, обновлено подписей=${stats.relabeled} ===`,
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
    if (e instanceof EscalationExhausted) {
      log(`[escalator] исчерпан: ${e.message}`);
      log(`[escalator] summary=${JSON.stringify(e.summary)}`);
      log(
        "[escalator] больше менять прокси нечем, прекращаю прогон. " +
          "Проверь баланс/доступность гео и перезапусти.",
      );
    } else {
      log(`Error: ${e}`);
      if (e && e.stack) process.stderr.write(`${e.stack}\n`);
    }
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
