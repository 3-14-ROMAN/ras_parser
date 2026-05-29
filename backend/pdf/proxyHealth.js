/**
 * pdf/proxyHealth.js — pre-flight probe ras.arbitr.ru через MobileProxy.Space
 * Anti-cloak API. Используется ДВУМЯ потребителями:
 *
 *   - `backend/proxy-tools/preflight-proxy-health.js` — диагностический CLI, печатает таблицу
 *     и выдаёт CSV с recommended-странами в stdout.
 *   - `pdf/pipeline.js` — встроенный preflight. Если `RAS_PDF_PREFLIGHT_GEO=1` и
 *     есть `MP_API_TOKEN`, runPipeline ДО старта worker loop'а:
 *       1) дёргает probe (один раз на процесс, in-memory cache на 30 мин),
 *       2) override'ит `geoFilters` каждого воркера (downloader + escalator)
 *          → recommended-страны,
 *       3) `_preflightEscapeBadCountry` использует recommended вместо статичного
 *          BAD-list'а — если страна воркера не в recommended, триггерит
 *          fast-geo-loop с целевым фильтром.
 *
 * Шаги probe'а:
 *   1) get_my_proxy — список купленных прокси и их id_country.
 *   2) get_geo_operator_list(proxy_id) — куда можно прыгнуть через changeGeo.
 *   3) Объединяем direct + reachable, исключаем BAD, приоритезируем TARGET.
 *   4) POST see_the_url_from_different_IPs(url, id_country=<csv>) — батчем.
 *   5) GET tasks(tasks_id) до status=ready (polling, cap по timeout).
 *   6) classifyAntiCloakResult — good=ras-markers/body≥20KB, bad=451/captcha/etc.
 *
 * Контракт чисто-функциональный: модуль не дёргает Chromium, не пишет в БД, не
 * меняет глобальное состояние. Только fetch + classify.
 */

import {
  classifyAntiCloakResult,
  flattenCandidateCountriesFromGeoList,
  parseAntiCloakTaskResult,
} from "../proxy-tools/antiCloakClassifier.js";

const MP_ENDPOINT = "https://mobileproxy.space/api.html";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function _readCsvFromEnv(name, fallback = []) {
  const raw = String(process.env[name] ?? "").trim();
  if (!raw) return fallback.slice();
  return raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
}

// ──────────────────────── low-level MP API ────────────────────────

async function _mpGet(apiToken, command, params = {}, { timeoutMs = 60_000 } = {}) {
  if (!apiToken) throw new Error("[proxyHealth] MP_API_TOKEN не задан");
  const q = new URLSearchParams();
  q.set("command", command);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(k, String(v));
  }
  const url = `${MP_ENDPOINT}?${q.toString()}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "User-Agent": "ras-parser/proxyHealth",
    },
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`[proxyHealth/${command}] невалидный JSON (http=${resp.status}): ${text.slice(0, 200)}`);
  }
  if (json && json.error) {
    throw new Error(`[proxyHealth/${command}] error: ${json.error}`);
  }
  return json;
}

async function _mpPost(apiToken, command, body = {}, { timeoutMs = 60_000 } = {}) {
  if (!apiToken) throw new Error("[proxyHealth] MP_API_TOKEN не задан");
  const form = new URLSearchParams();
  for (const [k, v] of Object.entries(body)) {
    if (v === null || v === undefined || v === "") continue;
    form.set(k, String(v));
  }
  const url = `${MP_ENDPOINT}?command=${encodeURIComponent(command)}`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ras-parser/proxyHealth",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`[proxyHealth/${command}] невалидный JSON (http=${resp.status}): ${text.slice(0, 200)}`);
  }
  if (json && json.error) {
    throw new Error(`[proxyHealth/${command}] error: ${json.error}`);
  }
  return json;
}

// ──────────────────────── discovery ────────────────────────

/**
 * Собрать страны-кандидаты: direct (id_country активных прокси) +
 * reachable (count_free>0 у первого прокси через get_geo_operator_list).
 *
 * @param {string} apiToken
 * @param {(m: string) => void} logger
 * @returns {Promise<{ proxies: any[], candidates: number[] }>}
 */
export async function discoverActiveCountries(apiToken, logger) {
  const log = logger ?? (() => {});
  const my = await _mpGet(apiToken, "get_my_proxy");
  const list = Array.isArray(my)
    ? my
    : Array.isArray(my?.list)
      ? my.list
      : Array.isArray(my?.proxies)
        ? my.proxies
        : Array.isArray(my?.data)
          ? my.data
          : [];
  /** @type {Set<number>} */
  const direct = new Set();
  for (const p of list) {
    const cid = Number(p?.id_country ?? p?.country_id);
    if (Number.isFinite(cid) && cid > 0) direct.add(cid);
  }
  log(
    `[proxyHealth] get_my_proxy: ${list.length} прокси; ` +
      `direct id_country={${[...direct].sort((a, b) => a - b).join(",")}}`,
  );

  /** @type {Set<number>} */
  const reachable = new Set(direct);
  const firstId = Number(list[0]?.proxy_id ?? list[0]?.id);
  if (Number.isFinite(firstId) && firstId > 0) {
    try {
      const geoList = await _mpGet(apiToken, "get_geo_operator_list", { proxy_id: firstId });
      const cands = flattenCandidateCountriesFromGeoList(geoList);
      for (const c of cands) {
        if (Number.isFinite(c.countryId) && c.countryId > 0) reachable.add(c.countryId);
      }
      log(
        `[proxyHealth] get_geo_operator_list(proxy_id=${firstId}): ` +
          `${cands.length} (geo,op) count_free>0, ` +
          `reachable={${[...reachable].sort((a, b) => a - b).join(",")}}`,
      );
    } catch (e) {
      log(`[proxyHealth] get_geo_operator_list упал: ${e && e.message} — иду на direct-странах`);
    }
  }
  return { proxies: list, candidates: [...reachable] };
}

// ──────────────────────── filter / order ────────────────────────

/**
 * Применить фильтры к списку стран:
 *   - excludeCountryIds (BAD) — выкинуть;
 *   - targetCountryIds (TARGET) — поднять в начало порядка.
 *
 * @param {number[]} candidates
 * @param {{ excludeCountryIds?: Iterable<number>, targetCountryIds?: number[] }} opts
 * @returns {{ pool: number[], targetMatched: number[] }}
 */
export function applyCountryFilters(candidates, { excludeCountryIds = [], targetCountryIds = [] } = {}) {
  const bad = new Set([...excludeCountryIds].map(Number).filter(Number.isFinite));
  const target = new Set([...targetCountryIds].map(Number).filter(Number.isFinite));
  const pool0 = candidates.filter((c) => !bad.has(Number(c)));
  let targetMatched = [];
  let rest = pool0;
  if (target.size > 0) {
    targetMatched = pool0.filter((c) => target.has(Number(c)));
    rest = pool0.filter((c) => !target.has(Number(c)));
  }
  return { pool: [...targetMatched, ...rest], targetMatched };
}

// ──────────────────────── tasks polling ────────────────────────

async function _waitForTask(apiToken, tasksId, { timeoutMs, pollMs, logger }) {
  const log = logger ?? (() => {});
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await _mpGet(apiToken, "tasks", { tasks_id: tasksId });
    } catch (e) {
      const msg = String(e && e.message);
      if (/in[_ -]?progress|pending|wait/i.test(msg)) {
        await sleep(pollMs);
        continue;
      }
      throw e;
    }
    const parsed = parseAntiCloakTaskResult(resp);
    if (parsed.status === "ready") return resp;
    if (parsed.status === "pending") {
      log(`[proxyHealth] task ${tasksId} pending…`);
      await sleep(pollMs);
      continue;
    }
    return resp;
  }
  throw new Error(`[proxyHealth] task ${tasksId} timeout ${timeoutMs}ms`);
}

// ──────────────────────── public ────────────────────────

/**
 * Высокоуровневая функция: пробить страны через anti-cloak API, вернуть
 * recommended-список + per-country verdict'ы.
 *
 * @param {{
 *   apiToken: string,
 *   url?: string,
 *   excludeCountryIds?: Iterable<number>,
 *   targetCountryIds?: number[],
 *   timeoutMs?: number,
 *   pollMs?: number,
 *   bodyMinBytes?: number,
 *   maxCountriesPerReq?: number,
 *   logger?: (m: string) => void,
 *   candidatesOverride?: number[] | null,  // для тестов: пропустить discovery
 * }} opts
 * @returns {Promise<{
 *   recommended: number[],
 *   perCountry: Record<number, ReturnType<typeof classifyAntiCloakResult>>,
 *   probedCountries: number[],
 *   durationMs: number,
 *   url: string,
 * }>}
 */
export async function probeRecommendedCountries({
  apiToken,
  url = "https://ras.arbitr.ru/",
  excludeCountryIds = [],
  targetCountryIds = [],
  timeoutMs = 120_000,
  pollMs = 5000,
  bodyMinBytes = 5000,
  maxCountriesPerReq = 12,
  logger = () => {},
  candidatesOverride = null,
}) {
  if (!apiToken) throw new Error("[proxyHealth] apiToken пустой");
  const t0 = Date.now();
  /** @type {number[]} */
  let candidates;
  if (Array.isArray(candidatesOverride) && candidatesOverride.length) {
    candidates = candidatesOverride.slice();
    logger(`[proxyHealth] candidatesOverride=[${candidates.join(",")}] — discover пропущен`);
  } else {
    const d = await discoverActiveCountries(apiToken, logger);
    candidates = d.candidates;
  }
  const { pool, targetMatched } = applyCountryFilters(candidates, {
    excludeCountryIds,
    targetCountryIds,
  });
  logger(
    `[proxyHealth] фильтры: ` +
      `exclude={${[...excludeCountryIds].join(",")}} ` +
      `target={${targetCountryIds.join(",") || "—"}} → ` +
      `пробую в порядке: [${pool.join(",")}]` +
      (targetMatched.length ? ` (target_matched=${targetMatched.length})` : ""),
  );

  if (!pool.length) {
    return {
      recommended: [],
      perCountry: {},
      probedCountries: [],
      durationMs: Date.now() - t0,
      url,
    };
  }

  /** @type {Record<number, ReturnType<typeof classifyAntiCloakResult>>} */
  const perCountry = {};
  for (let i = 0; i < pool.length; i += maxCountriesPerReq) {
    const chunk = pool.slice(i, i + maxCountriesPerReq);
    logger(`[proxyHealth] see_the_url_from_different_IPs url=${url} ids=[${chunk.join(",")}]`);
    let start;
    try {
      start = await _mpPost(apiToken, "see_the_url_from_different_IPs", {
        url,
        id_country: chunk.join(","),
      });
    } catch (e) {
      logger(`[proxyHealth] чанк [${chunk.join(",")}] POST упал: ${e && e.message}`);
      for (const cid of chunk) {
        perCountry[cid] = {
          recommended: false,
          bodyBytes: 0,
          httpStatus: null,
          latencyMs: null,
          markers: ["probe-error"],
          goodMarkers: [],
          reason: String(e && e.message).slice(0, 200),
        };
      }
      continue;
    }
    const tid = start?.tasks_id ?? start?.task_id ?? start?.id ?? null;
    if (!tid) {
      logger(`[proxyHealth] нет tasks_id для чанка [${chunk.join(",")}]`);
      continue;
    }
    let final;
    try {
      final = await _waitForTask(apiToken, tid, { timeoutMs, pollMs, logger });
    } catch (e) {
      logger(`[proxyHealth] tasks polling упал: ${e && e.message}`);
      for (const cid of chunk) {
        if (!perCountry[cid]) {
          perCountry[cid] = {
            recommended: false,
            bodyBytes: 0,
            httpStatus: null,
            latencyMs: null,
            markers: ["probe-timeout"],
            goodMarkers: [],
            reason: String(e && e.message).slice(0, 200),
          };
        }
      }
      continue;
    }
    const parsed = parseAntiCloakTaskResult(final);
    for (const cid of chunk) {
      const item = parsed.byCountry[cid] ?? null;
      perCountry[cid] = classifyAntiCloakResult(item, { bodyMinBytes });
    }
  }

  const recommended = Object.entries(perCountry)
    .filter(([, v]) => v.recommended)
    .map(([cid]) => Number(cid))
    .sort((a, b) => a - b);

  logger(
    `[proxyHealth] probe complete за ${Math.round((Date.now() - t0) / 1000)}с, ` +
      `recommended=[${recommended.join(",") || "—"}] (из ${pool.length} пробованных)`,
  );

  return {
    recommended,
    perCountry,
    probedCountries: pool,
    durationMs: Date.now() - t0,
    url,
  };
}

// ──────────────────────── env helpers ────────────────────────

export function readProbeOptsFromEnv() {
  return {
    url: String(process.env.RAS_PROBE_URL ?? "https://ras.arbitr.ru/").trim(),
    timeoutMs: Math.max(10_000, Number(process.env.RAS_PROBE_TIMEOUT_MS ?? 120_000)),
    pollMs: Math.max(5000, Number(process.env.RAS_PROBE_POLL_MS ?? 5000)),
    bodyMinBytes: Math.max(1000, Number(process.env.RAS_MP_ANTICLOAK_BODY_MIN_BYTES ?? 5000)),
    maxCountriesPerReq: Math.max(1, Number(process.env.RAS_PROBE_MAX_COUNTRIES ?? 12)),
    excludeCountryIds: _readCsvFromEnv("RAS_PDF_BAD_COUNTRY_IDS", [1, 2]),
    targetCountryIds: _readCsvFromEnv("RAS_PDF_TARGET_COUNTRY_IDS", []),
  };
}

// ──────────────────────── per-process cache ────────────────────────

let _cachedResult = null;
let _cachedAt = 0;
const DEFAULT_CACHE_MS = Math.max(
  60_000,
  Number(process.env.RAS_PDF_PROBE_CACHE_MS ?? 30 * 60 * 1000),
);

/**
 * In-memory per-process cache: supervisor рестартует runPipeline в цикле, и
 * каждый раз делать ~30-60с probe — медленно. Если последний probe < 30 мин
 * назад И вернул хотя бы одну recommended-страну, переиспользуем.
 *
 * @param {Parameters<typeof probeRecommendedCountries>[0]} opts
 */
export async function probeRecommendedCountriesCached(opts, { cacheMs = DEFAULT_CACHE_MS } = {}) {
  const log = opts?.logger ?? (() => {});
  if (
    _cachedResult &&
    _cachedResult.recommended.length > 0 &&
    Date.now() - _cachedAt < cacheMs
  ) {
    const ageSec = Math.round((Date.now() - _cachedAt) / 1000);
    log(
      `[proxyHealth/cache] переиспользую recommended=[${_cachedResult.recommended.join(",")}] ` +
        `(${ageSec}с назад, TTL=${Math.round(cacheMs / 1000)}с)`,
    );
    return _cachedResult;
  }
  const r = await probeRecommendedCountries(opts);
  if (r.recommended.length > 0) {
    _cachedResult = r;
    _cachedAt = Date.now();
  }
  return r;
}

export function _resetProbeCacheForTest() {
  _cachedResult = null;
  _cachedAt = 0;
}
