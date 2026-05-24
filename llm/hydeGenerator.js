// llm/hydeGenerator.js — HyDE-узел RAG-пайплайна.
//
// Принимает бытовой пользовательский запрос ("поставщик не доставил товар"),
// зовёт Gemini и возвращает синтетический «эталонный» фрагмент мотивировочной
// части решения арбитражного суда. Этот текст дальше идёт в локальный
// эмбеддер (Jina v4) и ищется в Qdrant против корпуса реальных актов.
//
// Идея: реальные акты в коллекции написаны строгим канцеляритом со ссылками
// на нормы ГК/АПК; запросы юзеров — бытовым языком. Прямое сравнение
// бытовой_текст ↔ судебный_акт в векторном пространстве работает плохо
// из-за разницы регистров и лексики. HyDE превращает запрос в текст того же
// "регистра", что и документы — и embedding-сходство резко растёт.
//
// SDK: @google/genai v2 (уже в package.json). API-ключ — GEMINI_API_KEY.
// ENV: RAS_HYDE_MODEL, RAS_HYDE_TEMPERATURE, RAS_HYDE_MAX_OUTPUT_TOKENS,
//      RAS_HYDE_TIMEOUT_MS, RAS_HYDE_PROXY_URL.

import { connect as tlsConnect } from "node:tls";

import { GoogleGenAI } from "@google/genai";
import {
  Agent as UndiciAgent,
  EnvHttpProxyAgent,
  fetch as undiciFetch,
} from "undici";
import { SocksClient } from "socks";

const DEFAULT_MODEL              = "gemini-3.1-pro-preview";
const DEFAULT_TEMPERATURE        = 0.3;
// Gemini 3.x reasoning-модели жгут часть выходного бюджета на thinking
// (внутренние рассуждения), и в 3.1 Pro thinking отключить нельзя
// (Budget=0 → API возвращает 400 "This model only works in thinking mode").
// Поэтому держим maxOutputTokens с запасом: ~1000-2000 на thinking + ~1500
// на текст. Под flash-модели можно уронить до 1024.
const DEFAULT_MAX_OUTPUT_TOKENS  = 4096;
const DEFAULT_THINKING_BUDGET    = -1; // -1 = AUTO, 0 = DISABLED (только не-3.x)
const DEFAULT_TIMEOUT_MS         = 30000;
const DEFAULT_TOP_P              = 0.95;

const MAX_QUERY_CHARS = 2000;

// safety filters Gemini регулярно режут юридические тексты (упоминание
// мошенничества, угроз, насилия в фабуле дела). В юридическом RAG это
// контрпродуктивно — выкручиваем фильтры в OFF.
const SAFETY_SETTINGS_OFF = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

const SYSTEM_INSTRUCTION = `Ты — генератор поисковых текстов для базы судебных актов Арбитражного суда РФ.

Твоя задача: стилизовать запрос пользователя в фрагмент мотивировочной части решения суда. Этот текст будет переведен в вектор для поиска похожих реальных дел.

ГЛАВНЫЙ ПРИНЦИП: ты только переводишь информацию из запроса пользователя в канцелярский стиль. Никаких новых данных, отсутствующих в запросе, ты не добавляешь. Любые конкретные ссылки на нормы права, законы, постановления, судебные акты, разъяснения, а также числовые/именные/датированные факты должны быть взяты строго из запроса.

ПРАВИЛА:
1. Не здоровайся, не пиши пояснений. Выдавай только текст судебного акта.
1.1. ТОЛЬКО plain text. Никакого markdown: запрещены **жирный**, *курсив*, __подчёркивание__, ~~зачёркивание~~, заголовки # / ## / ###, маркированные списки (- / * / +), горизонтальные линии (---), цитаты (>), inline-code (\`...\`), html-теги (<b>, <i>, <u>, <strong>). Названия блоков «Обстоятельства спора», «Позиция сторон», «Оценка суда» пиши обычными словами в начале абзаца без выделения, либо естественной фразой («Как следует из материалов дела…», «Истец указывает…», «Оценив представленные доказательства…»).
2. ЗАПРЕЩЕНО вводить любые конкретные нормы права, которых НЕТ в запросе:
   - конкретные статьи и пункты кодексов (ст. N ГК РФ, ст. N АПК РФ, НК, КоАП и т.п.);
   - конкретные федеральные законы, постановления Пленума ВС/ВАС, обзоры практики, информационные письма;
   - ссылки на конкретные пункты, абзацы, части нормативных актов.
   Даже если норма юридически валидна и идеально ложится на спор — добавлять её нельзя, если пользователь её не назвал.
3. Если в запросе НЕТ ни одной конкретной нормы — пиши только общими формулировками: «нормы о возврате предварительной оплаты», «общие положения о договоре поставки», «нормы о последствиях нарушения обязательства», «общие положения об обязательствах», «нормы процессуального законодательства», «положения действующего законодательства», «нормы о доказательствах в арбитражном процессе» и т.п. Никаких номеров статей и названий законов не упоминай.
4. Если в запросе есть конкретные нормы — используй ТОЛЬКО их, дословно. Не «расшифровывай» через смежные статьи (например, по «ст. 395 ГК РФ» НЕЛЬЗЯ ввести в текст ст. 309/310/314/393/487 ГК или ст. 71 АПК), не цитируй пункты, которых пользователь не назвал.
5. ЗАПРЕЩЕНО выдумывать любые конкретные факты, не указанные пользователем: номера дел (А...), даты, сроки, периоды, ФИО судей и сторон, названия компаний, ИНН, ОГРН, города, реквизиты документов, конкретные суммы. Если пользователь назвал сумму или срок — используй именно их, в остальном — обобщения («в заявленном размере», «в установленный договором срок», «согласно представленным в материалы дела документам»).
6. Используй строгий канцелярский язык арбитражных судов РФ (обороты: «суд установил», «истец указывает», «оценив представленные доказательства», «исследовав материалы дела», «суд приходит к выводу»).
7. Сфокусируйся на обстоятельствах спора, доводах сторон и правовой оценке — оперируй ТЕМИ фактами, что названы в запросе.

Обязательная структура ответа:
- Обстоятельства спора (в чем суть конфликта).
- Позиция сторон (кратко доводы).
- Оценка суда (почему суд принял такое решение).`;

let _client = null;
let _proxyInstalled = false;

// Google AI Studio (generativelanguage.googleapis.com) блокирует ряд стран,
// включая РФ — отдаёт 400 "User location is not supported for the API use".
// Обходим через RAS_HYDE_PROXY_URL. Поддержанные схемы:
//   - http://[user:pass@]host:port  → undici EnvHttpProxyAgent
//   - https://...                    → то же
//   - socks5h://host:port или socks5://[user:pass@]host:port
//                                    → undici Agent c custom connect через
//                                      пакет `socks` (DNS у socks5h резолвится
//                                      на стороне прокси, что важно для
//                                      обхода locally-poisoned DNS).
//
// Чтобы не задеть остальные fetch в процессе (Qdrant/inference на localhost,
// MobileProxy management API, etc.), подменяем globalThis.fetch wrapper'ом,
// который пускает через наш dispatcher ТОЛЬКО Gemini-домены. Все остальные
// URL уходят оригинальному fetch без изменений.
const GEMINI_HOST_RE = /(?:generativelanguage|aiplatform)\.googleapis\.com/i;

function makeSocksDispatcher(socksUrl) {
  const u = new URL(socksUrl);
  const proxy = {
    host: u.hostname,
    port: Number(u.port) || 1080,
    type: 5,
    userId:   u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
  };
  return new UndiciAgent({
    connect: (options, callback) => {
      const port = Number(options.port) || (options.protocol === "https:" ? 443 : 80);
      const host = options.servername || options.hostname || options.host;
      SocksClient.createConnection({
        proxy,
        command: "connect",
        destination: { host, port },
      })
        .then(({ socket }) => {
          if (options.protocol === "https:") {
            const tls = tlsConnect({
              socket,
              servername: host,
              ALPNProtocols: options.ALPNProtocols,
              rejectUnauthorized: options.rejectUnauthorized !== false,
            });
            tls.once("secureConnect", () => callback(null, tls));
            tls.once("error", (err) => callback(err));
          } else {
            callback(null, socket);
          }
        })
        .catch((err) => callback(err));
    },
  });
}

function maybeInstallProxy() {
  if (_proxyInstalled) return;
  _proxyInstalled = true;
  // RAS_HYDE_PROXY_URL — основной, RAS_HYDE_HTTP_PROXY оставлен как алиас
  // для обратной совместимости с прошлой версией модуля.
  const url = (process.env.RAS_HYDE_PROXY_URL || process.env.RAS_HYDE_HTTP_PROXY)?.trim();
  if (!url) return;

  let dispatcher;
  if (/^socks(5h?|4a?)?:\/\//i.test(url)) {
    dispatcher = makeSocksDispatcher(url);
  } else if (/^https?:\/\//i.test(url)) {
    if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = url;
    if (!process.env.HTTP_PROXY)  process.env.HTTP_PROXY  = url;
    if (!process.env.NO_PROXY)    process.env.NO_PROXY    = "localhost,127.0.0.1,::1";
    dispatcher = new EnvHttpProxyAgent();
  } else {
    throw new Error(`hyde: unsupported RAS_HYDE_PROXY_URL scheme: "${url.slice(0, 12)}…"`);
  }

  const originalFetch = globalThis.fetch;
  globalThis.fetch = function patchedFetch(input, init) {
    const target = typeof input === "string"
      ? input
      : input?.url ?? (input?.href ?? "");
    if (GEMINI_HOST_RE.test(target)) {
      return undiciFetch(input, { ...(init || {}), dispatcher });
    }
    return originalFetch(input, init);
  };
}

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("hyde: GEMINI_API_KEY is not set");
  }
  maybeInstallProxy();
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

function numFromEnv(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * Чистит markdown/html-разметку из текста модели до того, как он уйдёт в
 * эмбеддер. Это страховка: в промпте мы и так запрещаем разметку, но
 * модели иногда срываются на привычные `**заголовки**`. Лишние ``*`_# в
 * векторном пространстве — артефактные токены, которых в реальном корпусе
 * актов нет.
 *
 * Не трогает: нумерацию «1.» / «2)» (она в актах есть), кавычки «»/„",
 * длинные/короткие тире, перечисление с цифрами.
 */
export function normalizeHydeText(input) {
  if (!input) return "";
  let t = String(input);

  // html-инлайн-теги
  t = t.replace(/<\/?(?:b|i|u|em|strong|mark|span|small|sup|sub)\b[^>]*>/gi, "");

  // fenced code-блоки целиком + inline code
  t = t.replace(/```[\s\S]*?```/g, "");
  t = t.replace(/`([^`\n]+)`/g, "$1");

  // markdown-заголовки в начале строки: «### Оценка суда» / «## Позиция»
  t = t.replace(/^[ \t]*#{1,6}[ \t]+/gm, "");

  // bold/italic парами: **x**, __x__
  t = t.replace(/\*\*([^*\n]+?)\*\*/g, "$1");
  t = t.replace(/__([^_\n]+?)__/g, "$1");

  // italic одинарными *x* / _x_ — осторожнее, чтобы не съесть legit '_'
  // в нерусских токенах: ловим только пары вокруг непустого фрагмента,
  // граничные символы — пробел/кавычка/скобка/начало/конец строки.
  t = t.replace(/(^|[\s«("'])\*([^*\n]+?)\*(?=[\s.,;:!?»)"']|$)/g, "$1$2");
  t = t.replace(/(^|[\s«("'])_([^_\n]+?)_(?=[\s.,;:!?»)"']|$)/g, "$1$2");

  // strikethrough
  t = t.replace(/~~([^~\n]+?)~~/g, "$1");

  // блок-цитаты «> текст»
  t = t.replace(/^[ \t]*>[ \t]?/gm, "");

  // горизонтальные линии: ---, ***, ___
  t = t.replace(/^[ \t]*(?:[-*_][ \t]*){3,}$/gm, "");

  // маркеры bullet-списков в начале строки (нумерованные «1.»/«1)» НЕ трогаем)
  t = t.replace(/^[ \t]*[-*+][ \t]+/gm, "");

  // двойные пробелы внутри строки
  t = t.replace(/[ \t]{2,}/g, " ");

  // trailing whitespace на каждой строке
  t = t.replace(/[ \t]+$/gm, "");

  // лишние пустые строки (3+ → 2)
  t = t.replace(/\n{3,}/g, "\n\n");

  return t.trim();
}

/**
 * Сгенерировать HyDE-текст по запросу юзера.
 *
 * @param {string} rawQuery — пользовательский запрос (бытовой язык).
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxOutputTokens]
 * @param {number} [opts.timeoutMs]
 * @param {AbortSignal} [opts.signal] — внешняя отмена (например, от HTTP-клиента).
 * @returns {Promise<{
 *   text: string,
 *   model: string,
 *   elapsed_ms: number,
 *   usage: { prompt_tokens: number|null, candidates_tokens: number|null, total_tokens: number|null }|null,
 *   finish_reason: string|null
 * }>}
 */
export async function generateHypotheticalAct(rawQuery, opts = {}) {
  if (typeof rawQuery !== "string" || !rawQuery.trim()) {
    throw new Error("hyde: rawQuery must be a non-empty string");
  }
  const query = rawQuery.trim();
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`hyde: query too long (${query.length} > ${MAX_QUERY_CHARS} chars)`);
  }

  const model           = opts.model           || process.env.RAS_HYDE_MODEL || DEFAULT_MODEL;
  const temperature     = opts.temperature     ?? numFromEnv("RAS_HYDE_TEMPERATURE",       DEFAULT_TEMPERATURE);
  const maxOutputTokens = opts.maxOutputTokens ?? numFromEnv("RAS_HYDE_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutMs       = opts.timeoutMs       ?? numFromEnv("RAS_HYDE_TIMEOUT_MS",        DEFAULT_TIMEOUT_MS);
  // Бюджет на thinking. -1 = AUTO, 0 = OFF (для 3.x Pro невозможно — API
  // вернёт 400 "This model only works in thinking mode"). Под reasoning-
  // модели держим AUTO и компенсируем общим maxOutputTokens.
  const thinkingBudget  = opts.thinkingBudget  ?? numFromEnv("RAS_HYDE_THINKING_BUDGET",   DEFAULT_THINKING_BUDGET);

  const ai = getClient();

  // Внутренний AbortController на таймаут + объединение с внешним signal,
  // если он передан. Это нужно, чтобы клиент HTTP-сервера мог отменить
  // долгий запрос разрывом соединения, а внутренний таймер всё равно
  // дожимал ситуацию когда внешний signal не пришёл.
  const ac = new AbortController();
  const onExternalAbort = () => ac.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error(`hyde timeout ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();

  const t0 = Date.now();
  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: query }] }],
      config: {
        systemInstruction: SYSTEM_INSTRUCTION,
        temperature,
        maxOutputTokens,
        topP: DEFAULT_TOP_P,
        safetySettings: SAFETY_SETTINGS_OFF,
        thinkingConfig: { thinkingBudget },
        abortSignal: ac.signal,
      },
    });
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener?.("abort", onExternalAbort);
  }

  const elapsedMs = Date.now() - t0;
  const rawText = response?.text;
  const finishReason = response?.candidates?.[0]?.finishReason ?? null;

  if (!rawText || !rawText.trim()) {
    const blockReason = response?.promptFeedback?.blockReason
                     || response?.candidates?.[0]?.finishReason
                     || "unknown";
    throw new Error(`hyde: empty completion (reason=${blockReason})`);
  }

  const text = normalizeHydeText(rawText);

  const usage = response?.usageMetadata
    ? {
        prompt_tokens:     response.usageMetadata.promptTokenCount     ?? null,
        candidates_tokens: response.usageMetadata.candidatesTokenCount ?? null,
        total_tokens:      response.usageMetadata.totalTokenCount      ?? null,
      }
    : null;

  return {
    text,
    model,
    elapsed_ms: elapsedMs,
    usage,
    finish_reason: finishReason,
  };
}

export const __test = { SYSTEM_INSTRUCTION, MAX_QUERY_CHARS };
