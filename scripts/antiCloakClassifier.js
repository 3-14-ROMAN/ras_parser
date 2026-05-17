/**
 * scripts/antiCloakClassifier.js — defensive parser/classifier для ответа
 * MobileProxy.Space anti-cloaking task (`see_the_url_from_different_IPs`).
 *
 * Контракт API нестабильный — поля встречаются под разными именами в разных
 * версиях. Поэтому здесь только best-effort:
 *   1) парсим task result в форму `{ status, byCountry: { <id>: item } }`;
 *   2) классификатор смотрит item и говорит recommended/нет + список marker'ов.
 *
 * Никакой логики «pollить тут» — это делает probe-ras-countries.js. Только
 * чистые функции, чтобы их можно было покрыть unit-тестами без сети.
 */

const BAD_MARKERS = [
  // HTTP-маркеры
  { re: /\b451\b/, tag: "451" },
  { re: /\b403\b/, tag: "403" },
  { re: /\b429\b/, tag: "429" },
  { re: /\b50[0-9]\b/, tag: "5xx" },
  // Капча/анти-бот
  { re: /pravocaptcha/i, tag: "pravocaptcha" },
  { re: /tokenFrom/i, tag: "tokenFrom" },
  { re: /ddos[-_ ]?guard/i, tag: "ddos-guard" },
  { re: /cf-browser-verification/i, tag: "cloudflare-verify" },
  { re: /cloudflare/i, tag: "cloudflare" },
  { re: /captcha/i, tag: "captcha" },
  { re: /attention required/i, tag: "attention-required" },
  { re: /just a moment/i, tag: "just-a-moment" },
  // Доступ
  { re: /access denied/i, tag: "access-denied" },
  { re: /\bforbidden\b/i, tag: "forbidden" },
  { re: /\bblocked\b/i, tag: "blocked" },
  // Сетевые/таймауты
  { re: /timeout|timed?[ _-]?out/i, tag: "timeout" },
  { re: /ERR_TUNNEL/i, tag: "err-tunnel" },
  { re: /ERR_PROXY/i, tag: "err-proxy" },
];

/**
 * Маркеры «нормального» ras.arbitr.ru ответа. Достаточно ОДНОГО — это
 * собственные подписи UI/SSR-страницы. Если хотя бы один встречается, можно
 * довериться, что страница реально открылась (а не кэш / ddos-guard / 451 HTML).
 *
 * "Банк решений" — title раздела с актами; "Поиск по документам" — заголовок
 * формы поиска; "Текст документа" — заголовок просмотра; "Вид спора" — селектор
 * категории. Эти строки не лежат в captcha-страницах.
 */
const GOOD_RAS_MARKERS = [
  { re: /Поиск\s+по\s+документам/iu, tag: "ras-search-title" },
  { re: /Текст\s+документа/iu, tag: "ras-text-title" },
  { re: /Вид\s+спора/iu, tag: "ras-dispute-type" },
  { re: /Банк\s+решений/iu, tag: "ras-bank-title" },
];

/** Порог «крупного» html, при котором без good-marker'а можно довериться (≥20KB). */
const GOOD_BODY_THRESHOLD_BYTES = Math.max(
  10_000,
  Number(process.env.RAS_PROBE_GOOD_BODY_BYTES ?? 20_000),
);

/**
 * @typedef {{
 *   bodyText: string,
 *   bodyBytes: number,
 *   httpStatus: number|null,
 *   latencyMs: number|null,
 *   ip: string|null,
 *   countryId: number|null,
 *   raw: any,
 * }} AntiCloakItem
 */

/**
 * @typedef {{
 *   recommended: boolean,
 *   bodyBytes: number,
 *   httpStatus: number|null,
 *   latencyMs: number|null,
 *   markers: string[],
 *   reason: string,
 * }} AntiCloakVerdict
 */

function _toString(x) {
  if (x === null || x === undefined) return "";
  if (typeof x === "string") return x;
  if (typeof x === "number" || typeof x === "boolean") return String(x);
  try {
    return JSON.stringify(x);
  } catch {
    return "";
  }
}

function _firstNumber(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined || v === "") continue;
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function _firstString(...vals) {
  for (const v of vals) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.length) return v;
  }
  return null;
}

/**
 * Из одного элемента task-result достать унифицированную форму.
 * Item бывает строкой (body) или объектом — много возможных полей.
 *
 * @param {any} item
 * @returns {AntiCloakItem}
 */
export function normalizeAntiCloakItem(item) {
  if (item === null || item === undefined) {
    return {
      bodyText: "",
      bodyBytes: 0,
      httpStatus: null,
      latencyMs: null,
      ip: null,
      countryId: null,
      raw: item,
    };
  }
  if (typeof item === "string") {
    return {
      bodyText: item,
      bodyBytes: Buffer.byteLength(item, "utf8"),
      httpStatus: null,
      latencyMs: null,
      ip: null,
      countryId: null,
      raw: item,
    };
  }
  if (typeof item !== "object") {
    const s = String(item);
    return {
      bodyText: s,
      bodyBytes: Buffer.byteLength(s, "utf8"),
      httpStatus: null,
      latencyMs: null,
      ip: null,
      countryId: null,
      raw: item,
    };
  }
  const bodyText = _firstString(
    item.content,
    item.body,
    item.html,
    item.text,
    item.response,
    item.page,
    item.result,
    item.data,
  ) ?? "";
  // MP's see_the_url_from_different_IPs нестит метаданные под `item.info`:
  //   { body, info: { http_code, total_time, ... }, header, parse_header, error }
  // Поэтому при резолве httpStatus/latencyMs смотрим и flat-поля, и item.info.*.
  const info = item.info && typeof item.info === "object" ? item.info : null;
  const httpStatus = _firstNumber(
    item.status,
    item.http_status,
    item.httpStatus,
    item.code,
    item.response_code,
    item.responseCode,
    info?.http_code,
    info?.httpCode,
    info?.status,
  );
  const totalTimeSec = _firstNumber(info?.total_time, info?.totalTime);
  const latencyMs = _firstNumber(
    item.time_ms,
    item.duration_ms,
    item.elapsed_ms,
    item.elapsed,
    item.speed_ms,
    item.load_time_ms,
    item.load_time,
    item.latency_ms,
    item.latency,
    totalTimeSec !== null ? Math.round(totalTimeSec * 1000) : null,
  );
  const ip = _firstString(item.ip, item.ip_address, item.egress_ip, item.client_ip);
  const countryId = _firstNumber(item.id_country, item.country_id, item.countryId);
  return {
    bodyText,
    bodyBytes: Buffer.byteLength(bodyText, "utf8"),
    httpStatus,
    latencyMs,
    ip,
    countryId,
    raw: item,
  };
}

/**
 * Парсит финальный JSON `tasks?tasks_id=...` ответа в форму
 * `{ status, byCountry: Record<countryId, item> }`.
 *
 * status:
 *   - 'ready' — task завершён, byCountry заполнен
 *   - 'pending' — task ещё в процессе
 *   - 'unknown' — формат не разобрали (всё равно byCountry best-effort)
 *
 * @param {any} resp
 * @returns {{ status: 'ready' | 'pending' | 'unknown', byCountry: Record<number, any>, raw: any }}
 */
export function parseAntiCloakTaskResult(resp) {
  if (!resp || typeof resp !== "object") {
    return { status: "unknown", byCountry: {}, raw: resp };
  }

  // ── MP API формат: { status:"ok", tasks: { "<id>": { tasks_status, tasks_result:"<JSON string>" } } } ──
  // tasks_status: "1" = pending, "2" = done. tasks_result — JSON-строка с
  // {"<cid>": {url, data:{body, info:{http_code,total_time,...}, header, ...}}}.
  // Top-level `status:"ok"` означает «команда принята», не «задача готова», —
  // полагаемся только на tasks_status и наличие tasks_result.
  if (resp.tasks && typeof resp.tasks === "object" && !Array.isArray(resp.tasks)) {
    const keys = Object.keys(resp.tasks);
    if (keys.length) {
      const task = resp.tasks[keys[0]];
      if (task && typeof task === "object") {
        const tStatus = String(task.tasks_status ?? "").trim();
        let resultObj = task.tasks_result;
        if (typeof resultObj === "string" && resultObj.trim()) {
          try {
            resultObj = JSON.parse(resultObj);
          } catch {
            resultObj = null;
          }
        }
        const isReady = tStatus === "2" || tStatus.toLowerCase() === "done";
        if (!isReady && !resultObj) {
          return { status: "pending", byCountry: {}, raw: resp };
        }
        /** @type {Record<number, any>} */
        const byCountry = {};
        if (resultObj && typeof resultObj === "object" && !Array.isArray(resultObj)) {
          for (const [k, v] of Object.entries(resultObj)) {
            const cid = Number(k);
            if (!Number.isFinite(cid) || cid <= 0) continue;
            // entry = { url, data: { body, info, ... } } — для классификации
            // важнее всего data: там body/info. Передаём её, fall back на entry.
            byCountry[cid] = v?.data ?? v;
          }
        }
        return { status: isReady ? "ready" : "pending", byCountry, raw: resp };
      }
    }
  }

  // ── Legacy / альтернативные формы (массив с id_country, плоский map) ──
  const statusRaw = String(
    resp.status ?? resp.task_status ?? resp.state ?? "",
  ).toLowerCase();
  let status = "unknown";
  if (
    /ready|done|finish|complete|success/.test(statusRaw) ||
    resp.tasks_result !== undefined ||
    resp.result !== undefined
  ) {
    status = "ready";
  } else if (/pending|wait|progress|run/.test(statusRaw)) {
    status = "pending";
  }
  const candidates = [
    resp.tasks_result,
    resp.task_result,
    resp.taskResult,
    resp.result,
    resp.results,
    resp.data,
    resp.response,
  ];
  /** @type {Record<number, any>} */
  const byCountry = {};
  for (const container of candidates) {
    if (!container) continue;
    if (Array.isArray(container)) {
      for (const entry of container) {
        if (!entry || typeof entry !== "object") continue;
        const cid =
          _firstNumber(
            entry.id_country,
            entry.country_id,
            entry.countryId,
            entry.country,
          ) ?? null;
        if (cid === null) continue;
        byCountry[cid] = entry;
      }
      if (Object.keys(byCountry).length) break;
    } else if (typeof container === "object") {
      for (const [k, v] of Object.entries(container)) {
        const cid = Number(k);
        if (Number.isFinite(cid) && cid > 0) {
          byCountry[cid] = v?.data ?? v;
        }
      }
      if (Object.keys(byCountry).length) break;
    }
  }
  if (status === "unknown" && Object.keys(byCountry).length) {
    status = "ready";
  }
  return { status, byCountry, raw: resp };
}

/**
 * Классифицирует один item: recommended или нет, + список marker'ов.
 *
 * @param {any} rawItem — то, что лежит в byCountry[cid]
 * @param {{ bodyMinBytes?: number }} [opts]
 * @returns {AntiCloakVerdict}
 */
export function classifyAntiCloakResult(rawItem, opts = {}) {
  const bodyMinBytes = Number(opts.bodyMinBytes ?? 5000);
  const item = normalizeAntiCloakItem(rawItem);
  const markers = [];
  const goodMarkers = [];
  if (rawItem === null || rawItem === undefined) {
    return {
      recommended: false,
      bodyBytes: 0,
      httpStatus: null,
      latencyMs: null,
      markers: ["no-data"],
      goodMarkers: [],
      reason: "no item in task result",
    };
  }
  // HTTP status сам по себе — если есть и плохой.
  if (item.httpStatus !== null) {
    if (item.httpStatus === 451) markers.push("451");
    else if (item.httpStatus === 403) markers.push("403");
    else if (item.httpStatus === 429) markers.push("429");
    else if (item.httpStatus >= 500 && item.httpStatus <= 599) markers.push("5xx");
  }
  // Маркеры в теле — берём больший срез (200KB), чтобы поймать good-маркер
  // даже если он ниже в HTML (footer/JS payload).
  const hay = item.bodyText
    ? item.bodyText.slice(0, 200_000)
    : _toString(item.raw).slice(0, 5000);
  for (const m of BAD_MARKERS) {
    if (m.re.test(hay) && !markers.includes(m.tag)) markers.push(m.tag);
  }
  for (const m of GOOD_RAS_MARKERS) {
    if (m.re.test(hay) && !goodMarkers.includes(m.tag)) goodMarkers.push(m.tag);
  }
  if (item.bodyBytes === 0) markers.push("empty");
  else if (item.bodyBytes < bodyMinBytes) markers.push("tiny-body");
  if (item.bodyBytes >= GOOD_BODY_THRESHOLD_BYTES) goodMarkers.push("body-large");

  const hasFatalMarker = markers.some(
    (t) =>
      t !== "tiny-body" &&
      t !== "empty" &&
      t !== "cloudflare" /* cloudflare без verify ещё ок */,
  );
  // recommended: фатальных нет, тело не маленькое, И есть хотя бы один
  // good-marker (или body >= GOOD_BODY_THRESHOLD_BYTES — body-large сам по
  // себе это даёт). good-marker отсекает «вернулся 200 OK с пустой шапкой /
  // редиректом / пустой обёрткой DNS-преобразователя» — body есть, marker'ов
  // плохих нет, а контента ras.arbitr.ru тоже нет.
  const recommended =
    !hasFatalMarker &&
    !markers.includes("tiny-body") &&
    !markers.includes("empty") &&
    item.bodyBytes >= bodyMinBytes &&
    goodMarkers.length > 0;
  const reason = recommended
    ? `body ok (${item.bodyBytes}b), good=${goodMarkers.join(",")}`
    : markers.length
      ? `markers: ${markers.join(",")}${goodMarkers.length ? ` good=${goodMarkers.join(",")}` : ""}`
      : goodMarkers.length === 0
        ? "no ras markers found — looks like wrong page"
        : "body too short / unrecognized";
  return {
    recommended,
    bodyBytes: item.bodyBytes,
    httpStatus: item.httpStatus,
    latencyMs: item.latencyMs,
    markers,
    goodMarkers,
    reason,
  };
}

/**
 * Combine per-URL verdicts: страна recommended ТОЛЬКО если recommended на КАЖДОМ URL.
 *
 * @param {Record<string, Record<number, AntiCloakVerdict>>} perUrlPerCountry
 * @param {number[]} countries
 * @returns {Record<number, AntiCloakVerdict>}
 */
export function combineUrlVerdicts(perUrlPerCountry, countries) {
  const urls = Object.keys(perUrlPerCountry);
  /** @type {Record<number, AntiCloakVerdict>} */
  const out = {};
  for (const cid of countries) {
    const verdicts = urls.map((u) => perUrlPerCountry[u]?.[cid] ?? null);
    if (verdicts.every((v) => v && v.recommended)) {
      const minBytes = Math.min(...verdicts.map((v) => v.bodyBytes));
      out[cid] = {
        recommended: true,
        bodyBytes: minBytes,
        httpStatus: verdicts[0].httpStatus,
        latencyMs: verdicts[0].latencyMs,
        markers: [],
        reason: `ok across ${urls.length} URLs`,
      };
    } else {
      const allMarkers = new Set();
      let minBytes = Infinity;
      for (const v of verdicts) {
        if (!v) {
          allMarkers.add("no-data");
          continue;
        }
        for (const m of v.markers) allMarkers.add(m);
        if (v.bodyBytes < minBytes) minBytes = v.bodyBytes;
      }
      out[cid] = {
        recommended: false,
        bodyBytes: Number.isFinite(minBytes) ? minBytes : 0,
        httpStatus: null,
        latencyMs: null,
        markers: [...allMarkers],
        reason: `failed on at least one URL`,
      };
    }
  }
  return out;
}

/**
 * Из ответа `get_geo_operator_list` достать страны, у которых хотя бы один
 * оператор имеет count_free > 0. Используется как fallback для списка стран
 * anti-cloak проба, когда RAS_MP_ANTICLOAK_COUNTRIES не задан.
 *
 * По OpenAPI count_free — это object `{ "<operator>": <int> }`, поэтому делаем
 * flatten на (geo, operator) и фильтруем по `Number(count) > 0`.
 *
 * @param {any} avail — ответ get_geo_operator_list
 * @returns {Array<{ countryId: number|null, operator: string|null, count: number }>}
 */
export function flattenCandidateCountriesFromGeoList(avail) {
  const out = [];
  const list = avail?.geo_operator_list;
  if (!list || typeof list !== "object") return out;
  // list может быть как массивом, так и объектом — поддерживаем оба.
  const entries = Array.isArray(list) ? list : Object.values(list);
  for (const node of entries) {
    if (!node || typeof node !== "object") continue;
    const countryId = _firstNumber(node.id_country, node.country_id);
    const cf = node.count_free;
    if (!cf || typeof cf !== "object") continue;
    for (const [op, cntRaw] of Object.entries(cf)) {
      const cnt = Number(cntRaw);
      if (Number.isFinite(cnt) && cnt > 0) {
        out.push({ countryId, operator: op || null, count: cnt });
      }
    }
  }
  return out;
}
