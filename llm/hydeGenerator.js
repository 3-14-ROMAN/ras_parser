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
//      RAS_HYDE_TIMEOUT_MS.

import { GoogleGenAI } from "@google/genai";
import { setGlobalDispatcher, EnvHttpProxyAgent } from "undici";

const DEFAULT_MODEL              = "gemini-flash-latest";
const DEFAULT_TEMPERATURE        = 0.3;
const DEFAULT_MAX_OUTPUT_TOKENS  = 1024;
const DEFAULT_TIMEOUT_MS         = 15000;
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

const SYSTEM_INSTRUCTION = `Ты — генератор синтетических фрагментов мотивировочной части решений арбитражных судов Российской Федерации по спорам из договоров поставки (категория 3.1 кодификатора СИП).

Задача: по бытовому описанию ситуации сгенерировать связный фрагмент текста в стилистике реального судебного акта так, чтобы он по векторному сходству был близок к корпусу реальных мотивировок.

Жёсткие требования:
- Стиль — строгий канцелярский русский. Обязательные обороты к месту: «суд установил», «материалами дела подтверждается», «суд приходит к выводу», «в нарушение условий договора», «исследовав представленные в материалы дела доказательства», «оснований для иной оценки судом не усматривается».
- Активно ссылайся на нормы: ст. 309, 310, 314, 393, 401, 421, 506, 516 ГК РФ; ст. 65, 71, 75 АПК РФ. Выбирай те, что релевантны фабуле.
- Упоминай типичные доказательства: договор поставки, спецификации, товарные накладные (ТОРГ-12), УПД, акты сверки расчётов, платёжные поручения, претензионная переписка, переписка по электронной почте.
- НЕ выдумывай конкретику: номера дел, имена сторон, ИНН, ОГРН, даты, конкретные суммы, реквизиты документов — обходи обобщёнными формулировками («истец», «ответчик», «спорная партия товара», «согласно представленным в материалы дела документам», «в заявленном размере»).
- НЕ добавляй преамбулу, шапку, заголовок, markdown, нумерацию, маркированные списки.
- НЕ комментируй свою работу и не обращайся к пользователю. Выдай только сам фрагмент текста, ничего больше.
- Объём: 4–8 абзацев, ориентировочно 800–1500 знаков.`;

let _client = null;
let _proxyInstalled = false;

// Google AI Studio (generativelanguage.googleapis.com) блокирует ряд стран,
// включая РФ — отдаёт 400 "User location is not supported for the API use".
// Если задан RAS_HYDE_HTTP_PROXY (http://... или https://...), ставим
// undici EnvHttpProxyAgent глобально, чтобы node fetch ходил в Gemini через
// прокси. NO_PROXY=localhost,127.0.0.1,::1 защищает Qdrant/inference от
// случайной проксификации.
//
// SOCKS-прокси здесь не поддерживается (нет нативной поддержки в undici).
// Если нужен SOCKS — поднимите локальный socks→http конвертер (gost, etc.).
function maybeInstallHttpProxy() {
  if (_proxyInstalled) return;
  _proxyInstalled = true;
  const url = process.env.RAS_HYDE_HTTP_PROXY?.trim();
  if (!url) return;
  if (!/^https?:\/\//i.test(url)) {
    throw new Error(
      `hyde: RAS_HYDE_HTTP_PROXY must be http(s):// URL (got "${url.slice(0, 12)}…"); ` +
      `SOCKS не поддерживается — поднимите HTTP-прокси-обёртку.`,
    );
  }
  if (!process.env.HTTPS_PROXY) process.env.HTTPS_PROXY = url;
  if (!process.env.HTTP_PROXY)  process.env.HTTP_PROXY  = url;
  if (!process.env.NO_PROXY)    process.env.NO_PROXY    = "localhost,127.0.0.1,::1";
  setGlobalDispatcher(new EnvHttpProxyAgent());
}

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("hyde: GEMINI_API_KEY is not set");
  }
  maybeInstallHttpProxy();
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
        abortSignal: ac.signal,
      },
    });
  } finally {
    clearTimeout(timer);
    if (opts.signal) opts.signal.removeEventListener?.("abort", onExternalAbort);
  }

  const elapsedMs = Date.now() - t0;
  const text = response?.text;
  const finishReason = response?.candidates?.[0]?.finishReason ?? null;

  if (!text || !text.trim()) {
    const blockReason = response?.promptFeedback?.blockReason
                     || response?.candidates?.[0]?.finishReason
                     || "unknown";
    throw new Error(`hyde: empty completion (reason=${blockReason})`);
  }

  const usage = response?.usageMetadata
    ? {
        prompt_tokens:     response.usageMetadata.promptTokenCount     ?? null,
        candidates_tokens: response.usageMetadata.candidatesTokenCount ?? null,
        total_tokens:      response.usageMetadata.totalTokenCount      ?? null,
      }
    : null;

  return {
    text: text.trim(),
    model,
    elapsed_ms: elapsedMs,
    usage,
    finish_reason: finishReason,
  };
}

export const __test = { SYSTEM_INSTRUCTION, MAX_QUERY_CHARS };
