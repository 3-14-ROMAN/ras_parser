/**
 * network/proxyPool.js — discover активных прокси аккаунта и сборка
 * per-proxy `RasProxyClient`'ов для multi-IP pipeline скачивания PDF.
 *
 * Один `apiToken` на аккаунт; на каждый купленный прокси у MobileProxy.Space
 * есть свой `proxy_id` + `proxy_key` + host:port + login:pass. Cooldown'ы
 * `changeIp/changeEquipment` — per-proxy_key, ddos-guard kad'а — per-IP,
 * поэтому 4 прокси = 4 независимых пайплайна.
 *
 * Используется в `pdf/pipeline.js` для запуска N параллельных downloader'ов.
 * Сам RAS-парсер метаданных (`parser.js`) этот модуль не трогает — там 1
 * поток оптимален (лимит RAS API 1000 актов/окно).
 */

import MobileProxyClient from "@mobileproxy/sdk";

import {
  MP_API_TOKEN,
  MP_PROXY_ID,
  MP_PROXY_KEY,
  PROXY_PASS,
  PROXY_SERVER,
  PROXY_USER,
} from "./config.js";

/**
 * @typedef {Object} ProxyEntry
 * @property {number}      proxyId   `proxy_id` из getMyProxy
 * @property {string}      proxyKey  `proxy_key` (для changeIp endpoint'а)
 * @property {string}      server    "http://host:port" для Chromium proxy=…
 * @property {string}      username  proxy_login
 * @property {string}      password  proxy_pass
 * @property {string|null} ip        текущий IP (для логов), если известен
 * @property {number|null} countryId `id_country` — для авто-клонирования при autoBuy
 * @property {string}      label     "p1@1.2.3.4" — короткая метка для логов
 */

/**
 * Резолв host:port для прокси из getMyProxy. У MobileProxy.Space две схемы:
 *
 *   1. "Independent" route (то, что используется в дефолтном MP_PROXY_SERVER):
 *      `proxy_independent_http_hostname:proxy_independent_port` →
 *      "mproxy.site:12695" — один host:port НА ВЕСЬ АККАУНТ, login:pass
 *      каждого прокси определяют, к какому мобильнику роутить. Идеально
 *      для multi-IP пула: один TCP-эндпоинт, N разных мобильных IP на выходе.
 *
 *   2. "Direct" route: `proxy_hostname:proxy_http_port` →
 *      "bn.mobileproxy.space:1489" — у каждого прокси свой порт. Используем
 *      как fallback, если independent-поля отсутствуют.
 *
 * SOCKS5 не используем — Chromium через playwright корректно прокидывает
 * HTTP CONNECT, а SOCKS5 в headless+playwright периодически течёт DNS.
 */
function _pick(obj, names) {
  for (const n of names) {
    const v = obj?.[n];
    if (v !== undefined && v !== null && v !== "") return v;
  }
  return null;
}

function _resolveServer(raw) {
  const independentHost = _pick(raw, ["proxy_independent_http_hostname"]);
  const independentPort = _pick(raw, ["proxy_independent_port"]);
  if (independentHost && independentPort) {
    return `http://${independentHost}:${independentPort}`;
  }
  const directHost = _pick(raw, ["proxy_hostname", "proxy_host_ip"]);
  const directPort = _pick(raw, ["proxy_http_port"]);
  if (directHost && directPort) {
    return `http://${directHost}:${directPort}`;
  }
  return null;
}

/**
 * @param {any} raw entry из getMyProxy[]
 * @returns {ProxyEntry | null}
 */
function _normalizeEntry(raw) {
  const proxyId = Number(_pick(raw, ["proxy_id", "id", "proxyid"]));
  const proxyKey = _pick(raw, ["proxy_key", "key", "proxyKey"]);
  if (!Number.isFinite(proxyId) || !proxyKey) return null;

  const server = _resolveServer(raw);
  if (!server) return null;

  const username = String(_pick(raw, ["proxy_login", "login", "username"]) ?? "");
  const password = String(_pick(raw, ["proxy_pass", "password", "proxy_password"]) ?? "");
  // У `getMyProxy` нет поля «текущий outbound IP» — это IP мобильника,
  // его отдаёт getProxyIp(proxyId) отдельным запросом. Для label берём
  // оператора+гео — этого достаточно, чтобы понять кто из воркеров что качает.
  const operator = _pick(raw, ["proxy_operator"]);
  const geo = _pick(raw, ["proxy_geo"]);
  const labelTag = [operator, geo]
    .filter(Boolean)
    .map((s) => String(s).replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 8))
    .join("-");

  const countryIdRaw = _pick(raw, ["id_country"]);
  const countryId = countryIdRaw !== null ? Number(countryIdRaw) : null;
  return {
    proxyId,
    proxyKey: String(proxyKey),
    server,
    username,
    password,
    ip: null,
    countryId: Number.isFinite(countryId) && countryId > 0 ? countryId : null,
    label: `p${proxyId}${labelTag ? `-${labelTag}` : ""}`,
  };
}

function _unwrapList(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    for (const key of ["list", "proxies", "data", "result"]) {
      if (Array.isArray(resp[key])) return resp[key];
    }
  }
  return [];
}

/**
 * Discover активных прокси аккаунта.
 *
 * @param {{
 *   apiToken?: string,
 *   allowedKeys?: string[] | null,   // если задан — фильтр MP_PROXY_KEYS
 *   allowedCountryIds?: number[] | null, // если задан — только id_country из списка (PDF-пул)
 *   logger?: (m: string) => void,
 *   requestTimeoutMs?: number,
 *   statsOut?: { providerTotal?: number, discoverEligible?: number } | null,
 * }} [opts]
 * @returns {Promise<ProxyEntry[]>}
 */
export async function discoverProxies({
  apiToken = MP_API_TOKEN,
  allowedKeys = null,
  allowedCountryIds = null,
  logger = (m) => process.stdout.write(`${m}\n`),
  requestTimeoutMs = 60_000,
  statsOut = null,
} = {}) {
  if (!apiToken) {
    throw new Error(
      "[pool] MP_API_TOKEN не задан — без него getMyProxy не вызвать. " +
        "Поставь MP_API_TOKEN в .env.",
    );
  }
  const sdk = new MobileProxyClient(apiToken, { timeout: requestTimeoutMs });
  let resp;
  try {
    resp = await sdk.getMyProxy();
  } catch (e) {
    throw new Error(`[pool] getMyProxy упал: ${e && e.message}`);
  }
  const list = _unwrapList(resp);
  if (!list.length) {
    logger("[pool] getMyProxy вернул пустой список — на аккаунте нет активных прокси");
    return [];
  }
  const all = list.map(_normalizeEntry).filter(Boolean);
  if (statsOut) statsOut.providerTotal = all.length;
  if (!all.length) {
    throw new Error(
      "[pool] getMyProxy вернул прокси, но не удалось извлечь host/port/key/id из ответа: " +
        `${JSON.stringify(list).slice(0, 400)}…`,
    );
  }

  let chosen = all;
  if (Array.isArray(allowedKeys) && allowedKeys.length) {
    const set = new Set(allowedKeys.map(String));
    chosen = all.filter((p) => set.has(p.proxyKey));
    if (!chosen.length) {
      throw new Error(
        `[pool] MP_PROXY_KEYS=${[...set].join(",")} не совпал ни с одним прокси из getMyProxy ` +
          `(${all.map((p) => p.proxyKey).join(",")}).`,
      );
    }
  }
  if (Array.isArray(allowedCountryIds) && allowedCountryIds.length) {
    const cset = new Set(allowedCountryIds.map(Number).filter((n) => Number.isFinite(n)));
    const before = chosen.length;
    chosen = chosen.filter((p) => p.countryId != null && cset.has(Number(p.countryId)));
    if (before !== chosen.length) {
      logger(
        `[pool] фильтр id_country∈{${[...cset].sort((a, b) => a - b).join(",")}}: ` +
          `${before} → ${chosen.length} прокси (остальные — вне allowlist или без id_country)`,
      );
    }
    if (!chosen.length) {
      const err = new Error(
        `[pool] после фильтра по странам id∈{${[...cset].sort((a, b) => a - b).join(",")}} ` +
          "не осталось ни одного прокси. Купи линии с нужной страной в MobileProxy " +
          "или укажи MP_PROXY_KEYS только на подходящие proxy_key.",
      );
      err.code = "POOL_COUNTRY_FILTER_EMPTY";
      throw err;
    }
  }
  logger(
    `[pool] нашёл ${all.length} прокси, использую ${chosen.length}: ${chosen
      .map((p) => `${p.label}(key=${p.proxyKey.slice(0, 6)}…)`)
      .join(", ")}`,
  );
  if (statsOut) statsOut.discoverEligible = chosen.length;
  return chosen;
}

/**
 * Fallback: один прокси из старых MP_PROXY_* переменных окружения.
 * Используется, когда auto-discover через MP_API_TOKEN не доступен
 * (legacy-режим, локальная отладка).
 *
 * @returns {ProxyEntry | null}
 */
export function singleProxyFromEnv() {
  if (!PROXY_SERVER) return null;
  const proxyId = Number.isFinite(MP_PROXY_ID) ? MP_PROXY_ID : 0;
  const proxyKey = MP_PROXY_KEY || "";
  return {
    proxyId,
    proxyKey,
    server: PROXY_SERVER,
    username: PROXY_USER,
    password: PROXY_PASS,
    ip: null,
    label: `p${proxyId || "env"}`,
  };
}

/**
 * Парсит env `MP_PROXY_KEYS` (CSV/пробелы) — whitelist proxy_key'ев, которые
 * брать из getMyProxy. Пусто = брать все.
 *
 * @returns {string[] | null}
 */
export function readAllowedKeysFromEnv() {
  const raw = process.env.MP_PROXY_KEYS ?? "";
  if (!raw.trim()) return null;
  const parts = raw
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : null;
}

// ────────────────────────── auto-buy ──────────────────────────

/**
 * Текущий баланс аккаунта (монеты MobileProxy.Space).
 *
 * @param {{ apiToken?: string }} [opts]
 * @returns {Promise<number>}
 */
export async function getAccountBalance({ apiToken = MP_API_TOKEN } = {}) {
  if (!apiToken) throw new Error("[pool] getAccountBalance: MP_API_TOKEN не задан");
  const sdk = new MobileProxyClient(apiToken, { timeout: 30_000 });
  const r = await sdk.getBalance();
  const n = Number(r?.balance ?? r?.amount ?? 0);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Найти самый дешёвый тариф `period`-дневной аренды для конкретной страны.
 *
 * `getPrices(countryId)` отдаёт список планов period=1/7/30/90/365. Берём
 * первый, у которого `period === periodDays` (если есть) — иначе самый
 * дешёвый из доступных.
 *
 * @param {{ countryId: number, periodDays?: number, apiToken?: string }} opts
 * @returns {Promise<{ amount: number, period: number, isoCountry: string|null, countryName: string|null } | null>}
 */
export async function findPriceForCountry({
  countryId,
  periodDays = 1,
  apiToken = MP_API_TOKEN,
}) {
  if (!apiToken) throw new Error("[pool] findPriceForCountry: MP_API_TOKEN не задан");
  const sdk = new MobileProxyClient(apiToken, { timeout: 30_000 });
  const r = await sdk.getPrices(countryId);
  const list = Array.isArray(r?.price) ? r.price : [];
  if (!list.length) return null;
  const normalized = list
    .map((p) => ({
      amount: Number(p.amount),
      period: Number(p.period),
      isoCountry: p.iso ?? null,
      countryName: p.country_name ?? null,
    }))
    .filter((p) => Number.isFinite(p.amount) && Number.isFinite(p.period));
  if (!normalized.length) return null;
  const exact = normalized.find((p) => p.period === periodDays);
  if (exact) return exact;
  return normalized.sort((a, b) => a.amount - b.amount)[0];
}

/**
 * @typedef {Object} AutoBuyResult
 * @property {boolean} bought          купили ли хоть один
 * @property {number}  count           сколько купили
 * @property {number}  spent           сколько потрачено монет
 * @property {number}  unitPrice       цена за прокси (period дней)
 * @property {number}  periodDays
 * @property {number}  countryId
 * @property {number}  balanceBefore
 * @property {number}  balanceAfter
 * @property {any}     raw             сырой ответ buyProxy (для логов)
 */

/**
 * Авто-покупка прокси на свободный баланс. Логика:
 *
 *   1. Узнаём текущий баланс и кол-во активных прокси.
 *   2. Берём cap `maxTotalCount` (включая уже купленные) — больше этого не покупаем.
 *   3. Цена: самый дешёвый `periodDays`-тариф для `countryId`.
 *   4. Сколько влезает в баланс: `floor(balance / price)`.
 *   5. Покупаем `min(влезает, cap - текущее)` штук одним вызовом `buyProxy({num})`.
 *
 * Безопасность:
 *   - НИКОГДА не вызывается без явного `RAS_AUTO_BUY_PROXIES=1`.
 *   - Если на старте уже `maxTotalCount` прокси — no-op.
 *   - Никаких retry'ев при ошибке — провайдер сам разрулит, у нас вторая
 *     попытка может списать ещё денег.
 *
 * @param {{
 *   apiToken?: string,
 *   countryId: number,
 *   periodDays?: number,
 *   maxTotalCount: number,
 *   currentCount: number,
 *   logger?: (m: string) => void,
 * }} opts
 * @returns {Promise<AutoBuyResult>}
 */
export async function autoBuyProxies({
  apiToken = MP_API_TOKEN,
  countryId,
  periodDays = 1,
  maxTotalCount,
  currentCount,
  logger = (m) => process.stdout.write(`${m}\n`),
}) {
  if (!apiToken) throw new Error("[pool/buy] MP_API_TOKEN не задан");
  if (!Number.isFinite(countryId)) {
    throw new Error("[pool/buy] countryId обязателен (RAS_AUTO_BUY_COUNTRY_ID или клонируется из существующего прокси)");
  }
  const slotsFree = Math.max(0, Math.floor(maxTotalCount) - Math.floor(currentCount));
  if (slotsFree <= 0) {
    logger(
      `[pool/buy] уже ${currentCount} прокси, cap=${maxTotalCount} — ничего не покупаю`,
    );
    return _emptyBuy({ countryId, periodDays });
  }

  const balance = await getAccountBalance({ apiToken });
  const price = await findPriceForCountry({ apiToken, countryId, periodDays });
  if (!price) {
    throw new Error(`[pool/buy] не нашёл прайс для countryId=${countryId}, period=${periodDays}`);
  }
  if (price.period !== periodDays) {
    logger(
      `[pool/buy] нет тарифа period=${periodDays}д для countryId=${countryId}, ` +
        `беру ближайший period=${price.period}д цена=${price.amount}`,
    );
  }
  const affordable = Math.floor(balance / price.amount);
  const toBuy = Math.min(slotsFree, affordable);
  if (toBuy <= 0) {
    logger(
      `[pool/buy] баланс=${balance}, цена=${price.amount} (${price.countryName ?? countryId}, ${price.period}д) ` +
        `— не хватает даже на 1 прокси, пропускаю покупку`,
    );
    return _emptyBuy({ countryId, periodDays, balanceBefore: balance, unitPrice: price.amount });
  }
  const totalCost = toBuy * price.amount;
  logger(
    `[pool/buy] баланс=${balance}, цена=${price.amount}/${price.period}д (${price.countryName ?? countryId}); ` +
      `текущих прокси=${currentCount}, cap=${maxTotalCount}; ` +
      `покупаю ${toBuy} шт за ${totalCost} (остаток=${balance - totalCost})`,
  );

  const sdk = new MobileProxyClient(apiToken, { timeout: 60_000 });
  let raw;
  try {
    raw = await sdk.buyProxy({
      countryId,
      period: price.period,
      num: toBuy,
    });
  } catch (e) {
    throw new Error(`[pool/buy] buyProxy упал: ${e && (e.message ?? e)}`);
  }
  const okStatus = String(raw?.status ?? "").toLowerCase();
  if (okStatus && okStatus !== "ok" && okStatus !== "success") {
    throw new Error(`[pool/buy] провайдер ответил не-OK: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  logger(`[pool/buy] buyProxy ответ: ${JSON.stringify(raw).slice(0, 300)}`);

  let balanceAfter = balance - totalCost;
  try {
    balanceAfter = await getAccountBalance({ apiToken });
  } catch {}
  logger(`[pool/buy] баланс после покупки: ${balanceAfter}`);

  return {
    bought: true,
    count: toBuy,
    spent: totalCost,
    unitPrice: price.amount,
    periodDays: price.period,
    countryId,
    balanceBefore: balance,
    balanceAfter,
    raw,
  };
}

function _emptyBuy({ countryId, periodDays, balanceBefore = null, unitPrice = null }) {
  return {
    bought: false,
    count: 0,
    spent: 0,
    unitPrice: unitPrice ?? 0,
    periodDays,
    countryId,
    balanceBefore: balanceBefore ?? 0,
    balanceAfter: balanceBefore ?? 0,
    raw: null,
  };
}

/** Парсит env `RAS_AUTO_BUY_*` в нормализованный конфиг. */
export function readAutoBuyConfigFromEnv() {
  const enabled = String(process.env.RAS_AUTO_BUY_PROXIES ?? "0").trim() === "1";
  const maxTotalCount = Math.max(0, Number(process.env.RAS_AUTO_BUY_MAX_COUNT ?? 10));
  const periodDays = Math.max(1, Number(process.env.RAS_AUTO_BUY_PERIOD_DAYS ?? 1));
  const countryIdRaw = process.env.RAS_AUTO_BUY_COUNTRY_ID;
  const countryId =
    countryIdRaw !== undefined && countryIdRaw !== "" ? Number(countryIdRaw) : null;
  return {
    enabled,
    maxTotalCount,
    periodDays,
    countryId: Number.isFinite(countryId) && countryId > 0 ? countryId : null,
  };
}

/**
 * Извлечь countryId из существующего прокси (для «клонировать страну»).
 * Используется, когда RAS_AUTO_BUY_COUNTRY_ID не задан, но есть хотя бы один
 * купленный прокси — берём ту же страну, что у уже работающего.
 *
 * @param {ProxyEntry[]} proxies
 * @returns {number | null}
 */
export function inferCountryIdFromExisting(proxies) {
  if (!Array.isArray(proxies)) return null;
  for (const p of proxies) {
    if (Number.isFinite(p?.countryId) && p.countryId > 0) return p.countryId;
  }
  return null;
}
