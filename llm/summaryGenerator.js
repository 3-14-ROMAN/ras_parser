// llm/summaryGenerator.js — Grounding-узел RAG-пайплайна.
//
// Финальный шаг после Qdrant+rerank: берёт исходный запрос пользователя и
// top-N найденных актов (case_number + полный act_text), отдаёт всё это в
// Gemini с системным промптом «старший юрист-аналитик» и получает
// структурированный ответ — краткий вывод, анализ практики, риски, список
// изученных дел. Привязан строго к контексту: модели запрещено выдумывать
// статьи закона и ссылаться на акты вне переданных текстов.
//
// SDK / прокси / safety / abort-логика — идентичны hydeGenerator.js
// (тот же @google/genai, тот же SOCKS-туннель через RAS_HYDE_PROXY_URL,
// тот же scope-локальный патч globalThis.fetch). Здесь же не дублируем
// объяснения этой механики — см. llm/hydeGenerator.js.

import { connect as tlsConnect } from "node:tls";

import { GoogleGenAI } from "@google/genai";
import {
  Agent as UndiciAgent,
  ProxyAgent,
  fetch as undiciFetch,
} from "undici";
import { SocksClient } from "socks";

const DEFAULT_MODEL              = "gemini-3.1-pro-preview";
// Низкая температура: на этапе саммаризации нужна сухая аналитика и строгое
// следование фактам, не креативность.
const DEFAULT_TEMPERATURE        = 0.2;
// Финальный ответ юристу — длиннее HyDE (4 блока × несколько абзацев + список
// дел). Держим запас и под reasoning-thinking 3.x Pro.
const DEFAULT_MAX_OUTPUT_TOKENS  = 8192;
const DEFAULT_THINKING_BUDGET    = -1; // -1 = AUTO
const DEFAULT_TIMEOUT_MS         = 90_000;
const DEFAULT_TOP_P              = 0.95;

const MAX_QUERY_CHARS = 2000;

// Per-act cap перед склейкой в user_prompt — защита от обвала контекстного
// окна на длинных актах. Длинные акты в hydrate уже усекаются до MAX_CHARS
// (12k по дефолту), но если RAS_RERANK_MAX_DOC_LENGTH=0 (no-cap) — текст
// придёт полный, и 5×80k символов в одном запросе уже перебор.
const DEFAULT_PER_ACT_MAX_CHARS = 18_000;

const SAFETY_SETTINGS_OFF = [
  { category: "HARM_CATEGORY_HARASSMENT",        threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_HATE_SPEECH",       threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_NONE" },
  { category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_NONE" },
];

const SYSTEM_INSTRUCTION = `Ты — старший юрист-аналитик. Твоя задача — ответить на вопрос пользователя, основываясь ИСКЛЮЧИТЕЛЬНО на предоставленных текстах судебных актов.

ПРАВИЛА (КРИТИЧЕСКИ ВАЖНО):
1. Отвечай только на основе приложенных судебных актов. Если в текстах нет ответа на вопрос, честно напиши: "В предоставленной судебной практике не найдено прямого ответа на ваш вопрос".
2. НЕ выдумывай статьи закона, если они прямо не процитированы в предоставленных текстах.
3. НЕ ссылайся на акты, которых нет в контексте.
4. Обязательно указывай номера дел (А...), на которые ты опираешься при формулировании вывода (например: "Как указал суд в деле № А32-..., ...").
5. Пиши понятным, профессиональным языком. Избегай излишнего цитирования воды из актов.

СТРУКТУРА ОТВЕТА:
1. Краткий вывод (Да/Нет и почему).
2. Анализ судебной практики (как суды решают этот вопрос, на что обращают внимание).
3. Риски (что нужно доказать или чего стоит опасаться, исходя из актов).
4. Список изученных дел.`;

let _client = null;
let _proxyDispatcher = null;
let _proxyResolved  = false;

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

function getProxyDispatcher() {
  if (_proxyResolved) return _proxyDispatcher;
  _proxyResolved = true;
  const url = (process.env.RAS_HYDE_PROXY_URL || process.env.RAS_HYDE_HTTP_PROXY)?.trim();
  if (!url) return null;
  if (/^socks(5h?|4a?)?:\/\//i.test(url)) {
    _proxyDispatcher = makeSocksDispatcher(url);
  } else if (/^https?:\/\//i.test(url)) {
    _proxyDispatcher = new ProxyAgent(url);
  } else {
    throw new Error(`summary: unsupported RAS_HYDE_PROXY_URL scheme: "${url.slice(0, 12)}…"`);
  }
  return _proxyDispatcher;
}

function getClient() {
  if (_client) return _client;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error("summary: GEMINI_API_KEY is not set");
  }
  _client = new GoogleGenAI({ apiKey });
  return _client;
}

function numFromEnv(envName, fallback) {
  const raw = process.env[envName];
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function truncateAct(text, maxChars) {
  if (!text) return "";
  const s = String(text);
  if (!maxChars || maxChars <= 0 || s.length <= maxChars) return s;
  const half = Math.floor((maxChars - 32) / 2);
  if (half <= 0) return s.slice(0, maxChars);
  return `${s.slice(0, half)}\n\n[…пропуск середины…]\n\n${s.slice(s.length - half)}`;
}

/**
 * Собирает user_prompt в формате, описанном в ТЗ.
 */
function buildUserPrompt(query, acts, perActMaxChars) {
  const lines = [];
  lines.push("ВОПРОС ПОЛЬЗОВАТЕЛЯ:");
  lines.push(query);
  lines.push("");
  lines.push("НАЙДЕННЫЕ СУДЕБНЫЕ АКТЫ:");
  acts.forEach((a, i) => {
    const num = a.case_number ? `Дело № ${a.case_number}` : `act_id ${a.act_id ?? "?"}`;
    lines.push("");
    lines.push(`--- Акт ${i + 1} (${num}) ---`);
    lines.push(truncateAct(a.text, perActMaxChars));
  });
  return lines.join("\n");
}

/**
 * Сгенерировать финальный grounded-ответ по запросу + top-N актам.
 *
 * @param {string} rawQuery — пользовательский запрос.
 * @param {Array<{ act_id?: string, case_number?: string|null, text: string }>} acts
 *   Top-N актов с полным act_text. Пустые/без текста актов отбрасываются.
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.temperature]
 * @param {number} [opts.maxOutputTokens]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.thinkingBudget]
 * @param {number} [opts.perActMaxChars]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{
 *   text: string,
 *   model: string,
 *   model_version: string|null,
 *   elapsed_ms: number,
 *   acts_used: number,
 *   usage: { prompt_tokens: number|null, candidates_tokens: number|null, total_tokens: number|null }|null,
 *   finish_reason: string|null
 * }>}
 */
export async function generateFinalAnswer(rawQuery, acts, opts = {}) {
  if (typeof rawQuery !== "string" || !rawQuery.trim()) {
    throw new Error("summary: rawQuery must be a non-empty string");
  }
  const query = rawQuery.trim();
  if (query.length > MAX_QUERY_CHARS) {
    throw new Error(`summary: query too long (${query.length} > ${MAX_QUERY_CHARS} chars)`);
  }
  if (!Array.isArray(acts) || acts.length === 0) {
    throw new Error("summary: acts must be a non-empty array");
  }
  const filtered = acts.filter((a) => a && typeof a.text === "string" && a.text.trim());
  if (filtered.length === 0) {
    throw new Error("summary: no acts with non-empty text");
  }

  const model           = opts.model           || process.env.RAS_SUMMARY_MODEL || DEFAULT_MODEL;
  const temperature     = opts.temperature     ?? numFromEnv("RAS_SUMMARY_TEMPERATURE",       DEFAULT_TEMPERATURE);
  const maxOutputTokens = opts.maxOutputTokens ?? numFromEnv("RAS_SUMMARY_MAX_OUTPUT_TOKENS", DEFAULT_MAX_OUTPUT_TOKENS);
  const timeoutMs       = opts.timeoutMs       ?? numFromEnv("RAS_SUMMARY_TIMEOUT_MS",        DEFAULT_TIMEOUT_MS);
  const thinkingBudget  = opts.thinkingBudget  ?? numFromEnv("RAS_SUMMARY_THINKING_BUDGET",   DEFAULT_THINKING_BUDGET);
  const perActMaxChars  = opts.perActMaxChars  ?? numFromEnv("RAS_SUMMARY_PER_ACT_MAX_CHARS", DEFAULT_PER_ACT_MAX_CHARS);

  const userPrompt = buildUserPrompt(query, filtered, perActMaxChars);

  const ai = getClient();
  const dispatcher = getProxyDispatcher();

  const ac = new AbortController();
  const onExternalAbort = () => ac.abort(opts.signal?.reason);
  if (opts.signal) {
    if (opts.signal.aborted) ac.abort(opts.signal.reason);
    else opts.signal.addEventListener("abort", onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => ac.abort(new Error(`summary timeout ${timeoutMs}ms`)), timeoutMs);
  timer.unref?.();

  let originalFetch = null;
  if (dispatcher) {
    originalFetch = globalThis.fetch;
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

  const t0 = Date.now();
  let response;
  try {
    response = await ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
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
    if (originalFetch) globalThis.fetch = originalFetch;
  }

  const elapsedMs = Date.now() - t0;
  const rawText = response?.text;
  const finishReason = response?.candidates?.[0]?.finishReason ?? null;

  if (!rawText || !rawText.trim()) {
    const blockReason = response?.promptFeedback?.blockReason
                     || response?.candidates?.[0]?.finishReason
                     || "unknown";
    throw new Error(`summary: empty completion (reason=${blockReason})`);
  }

  const usage = response?.usageMetadata
    ? {
        prompt_tokens:     response.usageMetadata.promptTokenCount     ?? null,
        candidates_tokens: response.usageMetadata.candidatesTokenCount ?? null,
        total_tokens:      response.usageMetadata.totalTokenCount      ?? null,
      }
    : null;

  return {
    text: rawText.trim(),
    model,
    model_version: response?.modelVersion ?? null,
    elapsed_ms: elapsedMs,
    acts_used: filtered.length,
    usage,
    finish_reason: finishReason,
  };
}

export const __test = { SYSTEM_INSTRUCTION, MAX_QUERY_CHARS, buildUserPrompt };
