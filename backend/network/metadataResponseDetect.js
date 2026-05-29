/**
 * metadataResponseDetect.js — классификатор тела ответа POST /Search
 * на ras.arbitr.ru. Используется parser.js перед `JSON.parse`, чтобы
 * отделить настоящий JSON от pravocaptcha/ddos-guard gate-страницы.
 *
 * Контекст: kad.arbitr.ru при PDF-flow умеет различать tokenFrom-HTML
 * (см. pdf/downloader.js + network/saltoDecoder.js). У ras.arbitr.ru
 * та же защита применима к POST /Search, но parser.js этого не знал:
 * tokenFrom-страница, прилетевшая на 200 OK, валилась `JSON.parse` на
 * SyntaxError и крутилась 8 раз на тех же куках до forсного
 * `_recoverFrom('banned')`. Этот модуль возвращает явный kind, чтобы
 * pipeline сразу сделал UI-recovery (reload+warmup) — pravocaptcha-JS
 * успеет поставить challenge-куки на следующей попытке.
 *
 * Output kind'ы:
 *   - "json_ok"        — content-type=application/json + тело > tiny → парсить
 *   - "antifraud_gate" — есть маркер pravocaptcha/tokenFrom/ddos-guard/cloudflare
 *   - "http_block"     — status ∈ {451, 403, 429, 5xx} (для логов; recover в parser)
 *   - "html_unknown"   — HTML без распознанных маркеров (новая gate-страница?)
 *   - "tiny"           — тело подозрительно короткое (<TINY_BODY_BYTES)
 *   - "unknown"        — content-type не распознан, маркеров нет
 *
 * Маркеры намеренно дублируются с backend/proxy-tools/antiCloakClassifier.js: тут
 * — узкий single-purpose классификатор без зависимостей от чужого формата
 * (item/raw/bodyMinBytes), его проще покрыть unit-тестом.
 */

/**
 * Тело меньше этого порога считаем "tiny" — реальный /Search-ответ RAS даже
 * пустой (TotalCount:0) выдаёт >300 байт (Result/Success/Message). Если меньше —
 * это либо заглушка, либо обрезанный ответ.
 */
const TINY_BODY_BYTES = 200;

const MARKER_TESTS = [
  ["tokenFrom", /tokenFrom/i],
  ["pravocaptcha", /pravocaptcha/i],
  ["ddos-guard", /ddos[-_ ]?guard/i],
  ["cloudflare", /cf-browser-verification|\bcloudflare\b/i],
  ["just-a-moment", /just a moment/i],
  ["attention-required", /attention required/i],
];

/**
 * @typedef {{
 *   kind: "json_ok" | "antifraud_gate" | "http_block" | "html_unknown" | "tiny" | "unknown",
 *   markers: string[],
 *   reason: string,
 *   contentType: string,
 *   status: number|null,
 *   bytes: number,
 * }} MetadataResponseVerdict
 */

/**
 * Классифицировать ответ /Search.
 *
 * @param {{ contentType?: string|null, status?: number|null, bodyText?: string|null }} input
 * @returns {MetadataResponseVerdict}
 */
export function classifyMetadataResponse({
  contentType = "",
  status = null,
  bodyText = "",
} = {}) {
  const ct = String(contentType || "").toLowerCase();
  const text = bodyText == null ? "" : String(bodyText);
  const bytes = text.length;
  const markers = [];

  if (typeof status === "number") {
    if (status === 451) markers.push("451");
    else if (status === 403) markers.push("403");
    else if (status === 429) markers.push("429");
    else if (status >= 500 && status <= 599) markers.push("5xx");
  }
  const httpBlock = markers.length > 0;

  for (const [tag, re] of MARKER_TESTS) {
    if (re.test(text) && !markers.includes(tag)) markers.push(tag);
  }

  if (httpBlock) {
    return {
      kind: "http_block",
      markers,
      reason: `http=${status}`,
      contentType: ct,
      status,
      bytes,
    };
  }

  // Antifraud-маркер в теле приоритетнее content-type: иногда RAS отдаёт
  // pravocaptcha-страницу даже с заголовком application/json (видели на kad).
  const bodyMarkers = markers.filter((m) =>
    MARKER_TESTS.some(([tag]) => tag === m),
  );
  if (bodyMarkers.length > 0) {
    return {
      kind: "antifraud_gate",
      markers,
      reason: `markers=[${bodyMarkers.join(",")}]`,
      contentType: ct,
      status,
      bytes,
    };
  }

  const isJson = ct.includes("application/json") || ct.includes("text/json");
  const isHtml = ct.includes("text/html") || ct.includes("application/xhtml");

  // application/json — happy path. Пустые выдачи RAS (TotalCount:0) дают
  // ответы ~80-110 байт, поэтому НЕ режем по TINY_BODY_BYTES, если ct это JSON.
  // Совсем пустое тело (bytes=0) всё-таки tiny — иначе JSON.parse упадёт молча.
  if (isJson && bytes > 0) {
    return {
      kind: "json_ok",
      markers,
      reason: "",
      contentType: ct,
      status,
      bytes,
    };
  }

  if (bytes < TINY_BODY_BYTES) {
    return {
      kind: "tiny",
      markers,
      reason: `bytes=${bytes}`,
      contentType: ct,
      status,
      bytes,
    };
  }

  if (isHtml || text.trimStart().startsWith("<")) {
    return {
      kind: "html_unknown",
      markers,
      reason: `html ct=${ct || "?"}`,
      contentType: ct,
      status,
      bytes,
    };
  }

  return {
    kind: "unknown",
    markers,
    reason: `ct=${ct || "?"} bytes=${bytes}`,
    contentType: ct,
    status,
    bytes,
  };
}

export const __test__ = { TINY_BODY_BYTES, MARKER_TESTS };
