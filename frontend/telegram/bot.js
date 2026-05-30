#!/usr/bin/env node
/**
 * frontend/telegram/bot.js — тонкий Telegram бот поверх локального Search API.
 *
 * Архитектура:
 *   user → Telegram → (long polling getUpdates через SOCKS) → этот процесс
 *                  → POST http://127.0.0.1:8091/search → reranker pipeline
 *                  → форматированный plain-text ответ → sendMessage
 *
 * Используем встроенный node:https + socks-proxy-agent (минимальная зависимость).
 * Никакой node-telegram-bot-api / telegraf, чтобы не таскать тяжёлые SDK.
 *
 * Что бот понимает:
 *   /start, /help — короткая справка
 *   любой текст — поисковый запрос (top-3 актов, plain text)
 *
 * Security:
 *   - TELEGRAM_BOT_TOKEN — обязательный, никогда не логируется (даже маска).
 *   - TG_BOT_ALLOWED_USER_IDS=<csv numeric user IDs> — allowlist. Если пусто,
 *     бот в OPEN-режиме (стартует с громким WARN). Так удобно дать первый
 *     тестовый запрос; для прод/публичной выкладки заполнить ID-ами.
 *   - act_text наружу НЕ отдаётся: только snippet (~280 символов).
 *
 * ENV:
 *   TELEGRAM_BOT_TOKEN          (обязателен)
 *   TELEGRAM_PROXY_URL          socks5h://host:port (опционален; без него
 *                                идём напрямую — но Telegram заблокирован в РФ)
 *   RAS_SEARCH_API_URL          http://127.0.0.1:8091
 *   TG_BOT_ALLOWED_USER_IDS     csv numeric ids ("123,456"); пусто = open
 *   TG_BOT_TOPN                 сколько результатов в одно сообщение (3)
 *   TG_BOT_POLL_TIMEOUT         long-poll timeout в секундах (25)
 *   TG_BOT_FETCH_TIMEOUT_MS     HTTP timeout на запрос к Telegram (35000)
 *   TG_BOT_SEARCH_TIMEOUT_MS    HTTP timeout на запрос к Search API (120000)
 */

import https from "node:https";
import http from "node:http";
import process from "node:process";

import { SocksProxyAgent } from "socks-proxy-agent";
import fs from "node:fs/promises";
import path from "node:path";
import { connect as tlsConnect } from "node:tls";

import {
  Agent as UndiciAgent,
  fetch as undiciFetch,
} from "undici";
import { SocksClient } from "socks";

import { renderSummaryToPdf } from "../../backend/llm/summaryPdfRenderer.js";

// ─── env ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  process.stderr.write("[tg-bot] FATAL TELEGRAM_BOT_TOKEN is not set\n");
  process.exit(2);
}

const PROXY_URL      = process.env.TELEGRAM_PROXY_URL || "";
const SEARCH_API_URL = (process.env.RAS_SEARCH_API_URL || "http://127.0.0.1:8091").replace(/\/+$/, "");
const WHISPER_API_URL = (process.env.RAS_WHISPER_API_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");

// TopN: дефолт 10, allowed диапазон 1..50.
const TOPN_MIN = 1;
const TOPN_MAX = 50;
const TOPN     = Math.max(TOPN_MIN, Math.min(TOPN_MAX, Number(process.env.TG_BOT_TOPN || 9)));

// Сколько актов из топ-N реально уходит в Summary (grounding LLM). Меньше —
// дешевле/быстрее, выдача чище. Больше — шире анализ, но шумнее.
const SUMMARY_TOPN_MIN     = 1;
const SUMMARY_TOPN_DEFAULT = Math.max(SUMMARY_TOPN_MIN, Number(process.env.TG_BOT_SUMMARY_TOPN || 4));

// Whitelist моделей, которые показываем в подменю выбора. Полный список
// доступных по нашему API-ключу мы видели через ai.models.list(); сюда
// взяли только text-generation модели, актуальные на момент сборки.
const HYDE_MODELS = [
  { id: "gemini-3.5-flash",         label: "Gemini 3.5 Flash (GA, default, быстро)" },
  { id: "gemini-flash-latest",      label: "Gemini Flash Latest (alias)" },
  { id: "gemini-pro-latest",        label: "Gemini Pro Latest (alias)" },
  { id: "gemini-3-pro-preview",     label: "Gemini 3 Pro Preview (качество)" },
  { id: "gemini-3.1-pro-preview",   label: "Gemini 3.1 Pro Preview (последний pro)" },
  { id: "gemini-2.5-pro",           label: "Gemini 2.5 Pro (стабильный GA)" },
  { id: "gemini-2.5-flash",         label: "Gemini 2.5 Flash (стабильный GA, дешёво)" },
  { id: "gemini-3.1-flash-lite",    label: "Gemini 3.1 Flash Lite (минимум)" },
];
function isAllowedModel(id) { return HYDE_MODELS.some((m) => m.id === id); }
function modelLabel(id)     { return HYDE_MODELS.find((m) => m.id === id)?.label ?? id; }

// per-chat настройки. Persist в parsed_data/tg_bot_settings.json — JSON
// debounced-сохранением: на каждое изменение пишем через ~300ms тишины.
// При старте читаем; если файла нет/битый — chatSettings пустой, юзер
// получает env-дефолты до первого изменения.
const SETTINGS_FILE = path.resolve(
  process.cwd(),
  process.env.TG_BOT_SETTINGS_FILE || "data/parsed_data/tg_bot_settings.json",
);
const chatSettings = new Map();

function defaultSettings() {
  return {
    topN:           TOPN,
    use_hyde:       (process.env.TG_BOT_DEFAULT_USE_HYDE    ?? "1") !== "0",
    use_summary:    (process.env.TG_BOT_DEFAULT_USE_SUMMARY ?? "1") !== "0",
    hyde_model:     process.env.RAS_HYDE_MODEL || "gemini-3.5-flash",
    summary_model:  process.env.RAS_SUMMARY_MODEL || "gemini-3.1-pro-preview",
    summary_top_n:  SUMMARY_TOPN_DEFAULT,
  };
}

function getChatSettings(chatId) {
  const def = defaultSettings();
  const s = chatSettings.get(chatId) || {};
  const topN = Math.max(TOPN_MIN, Math.min(TOPN_MAX, Number(s.topN ?? def.topN)));
  // summary_top_n кламп к [1; topN] — нельзя саммаризировать больше актов
  // чем мы вообще вернули. Если юзер поставил 10, а потом снизил topN до 5,
  // в саммари уйдут 5 — без переключения настройки руками.
  const sumRaw = Number(s.summary_top_n ?? def.summary_top_n);
  const summaryTopN = Number.isFinite(sumRaw) && sumRaw >= 1
    ? Math.max(SUMMARY_TOPN_MIN, Math.min(topN, Math.floor(sumRaw)))
    : Math.min(topN, def.summary_top_n);
  return {
    topN,
    use_hyde:      typeof s.use_hyde    === "boolean" ? s.use_hyde    : def.use_hyde,
    use_summary:   typeof s.use_summary === "boolean" ? s.use_summary : def.use_summary,
    hyde_model:    isAllowedModel(s.hyde_model)    ? s.hyde_model    : def.hyde_model,
    summary_model: isAllowedModel(s.summary_model) ? s.summary_model : def.summary_model,
    summary_top_n: summaryTopN,
  };
}
function getChatTopN(chatId) { return getChatSettings(chatId).topN; }

function updateChatSettings(chatId, patch) {
  const cur = chatSettings.get(chatId) || {};
  const next = { ...cur, ...patch };
  chatSettings.set(chatId, next);
  schedulePersistSettings();
  return getChatSettings(chatId);
}
function setChatTopN(chatId, n) {
  const clamped = Math.max(TOPN_MIN, Math.min(TOPN_MAX, Number(n) || TOPN));
  return updateChatSettings(chatId, { topN: clamped }).topN;
}
function setChatSummaryTopN(chatId, n) {
  const cur = getChatSettings(chatId);
  const clamped = Math.max(SUMMARY_TOPN_MIN, Math.min(cur.topN, Number(n) || SUMMARY_TOPN_DEFAULT));
  return updateChatSettings(chatId, { summary_top_n: clamped }).summary_top_n;
}

let _persistTimer = null;
function schedulePersistSettings() {
  if (_persistTimer) clearTimeout(_persistTimer);
  _persistTimer = setTimeout(persistSettingsNow, 300);
  _persistTimer.unref?.();
}
async function persistSettingsNow() {
  _persistTimer = null;
  const dump = {};
  for (const [chatId, s] of chatSettings.entries()) dump[chatId] = s;
  try {
    await fs.mkdir(path.dirname(SETTINGS_FILE), { recursive: true });
    const tmp = SETTINGS_FILE + ".tmp";
    await fs.writeFile(tmp, JSON.stringify(dump, null, 2));
    await fs.rename(tmp, SETTINGS_FILE);
  } catch (e) {
    process.stderr.write(`[tg-bot] WARN settings persist failed: ${e?.message ?? e}\n`);
  }
}
// Pending-input для stateful flow («ввести число», подтверждение голоса).
// In-memory + fallback из текста сообщения с кнопкой «Искать» (переживает
// рестарт процесса; второй инстанс бота с тем же токеном по-прежнему ломает
// pending — не запускайте два poll-loop на одном TELEGRAM_BOT_TOKEN).
const _pendingInput = new Map(); // chatId -> { kind, ts, text? }
const PENDING_INPUT_TTL_MS = 5 * 60 * 1000; // 5 минут — потом «забываем»

// Многочастный INFO рендерится так: текущий menu-message edit'ится в PART1
// без клавиатуры, PART2 (последняя часть) шлётся отдельным sendMessage с
// MAIN_KEYBOARD — она становится новым «якорем» навигации. Все
// промежуточные части (PART1 на месте меню + PART2..N-1) — orphans:
// editToCallback на якоре их не трогает, и они висят в чате как тени.
// Лечим: на любую следующую editToCallback навигацию сначала удаляем orphan'ы.
const _infoOrphans = new Map(); // chatId -> [message_id, ...]

function normalizeChatId(chatId) {
  const n = Number(chatId);
  return Number.isFinite(n) ? n : chatId;
}

function setPendingInput(chatId, payload) {
  const key = normalizeChatId(chatId);
  if (payload === null || payload === undefined) {
    _pendingInput.delete(key);
  } else {
    _pendingInput.set(key, { ...payload, ts: Date.now() });
  }
}
function getPendingInput(chatId) {
  const key = normalizeChatId(chatId);
  const p = _pendingInput.get(key);
  if (!p) return null;
  if (Date.now() - p.ts > PENDING_INPUT_TTL_MS) {
    _pendingInput.delete(key);
    return null;
  }
  return p;
}
function clearPendingInput(chatId) { _pendingInput.delete(normalizeChatId(chatId)); }

/** Текст запроса из сообщения «🎤 Распознанный текст:» (если in-memory pending потерян). */
function extractVoiceQueryFromMessage(msg) {
  const raw = (msg?.text || msg?.caption || "").trim();
  if (!raw) return null;
  const m = /Распознанный текст:\s*\n([\s\S]+?)(?:\n\n|$)/u.exec(raw);
  if (!m) return null;
  const q = m[1].trim();
  return q.length >= 2 ? q : null;
}

function resolveVoiceConfirmQuery(chatId, cbMessage) {
  const p = getPendingInput(chatId);
  if (p?.kind === "voiceConfirm" && p.text) {
    return { text: p.text, source: "pending" };
  }
  const fromMsg = extractVoiceQueryFromMessage(cbMessage);
  if (fromMsg) return { text: fromMsg, source: "message" };
  return { text: null, source: null };
}

// Сериализация voice_confirm vs текстовой коррекции в том же чате.
const _voiceConfirmLocks = new Map();
async function withVoiceConfirmLock(chatId, fn) {
  const key = normalizeChatId(chatId);
  const prev = _voiceConfirmLocks.get(key) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  _voiceConfirmLocks.set(key, run);
  try {
    return await run;
  } finally {
    if (_voiceConfirmLocks.get(key) === run) _voiceConfirmLocks.delete(key);
  }
}

async function loadSettingsFromDisk() {
  try {
    const raw = await fs.readFile(SETTINGS_FILE, "utf8");
    const obj = JSON.parse(raw);
    for (const [chatId, s] of Object.entries(obj || {})) {
      if (s && typeof s === "object") chatSettings.set(Number(chatId), s);
    }
  } catch (e) {
    if (e?.code !== "ENOENT") {
      process.stderr.write(`[tg-bot] WARN settings load failed: ${e?.message ?? e}\n`);
    }
  }
}
const POLL_TIMEOUT_S    = Math.max(1, Math.min(50, Number(process.env.TG_BOT_POLL_TIMEOUT || 25)));
const FETCH_TIMEOUT_MS  = Math.max(5000, Number(process.env.TG_BOT_FETCH_TIMEOUT_MS  || 28000));
const SEARCH_TIMEOUT_MS = Math.max(5000, Number(process.env.TG_BOT_SEARCH_TIMEOUT_MS || 120000));

const ALLOWED_IDS = (() => {
  const raw = (process.env.TG_BOT_ALLOWED_USER_IDS || "").trim();
  if (!raw) return null; // null = open mode
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => Number(s))
      .filter((n) => Number.isFinite(n) && n > 0),
  );
})();

const TG_MAX_MSG = 4096;

function log(level, msg, extra) {
  const stamp = new Date().toISOString();
  const line = extra
    ? `[tg-bot] ${stamp} ${level} ${msg} ${JSON.stringify(extra)}`
    : `[tg-bot] ${stamp} ${level} ${msg}`;
  if (level === "ERROR" || level === "WARN") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

// ─── HTTP agents ────────────────────────────────────────────────────────────

// tgAgent — mutable: при флапах SOCKS-туннеля keep-alive pool копит дохлые
// сокеты (=> ECONNRESET цепочкой). В pollLoop его пересоздают после N подряд
// poll-ошибок, тогда новый коннект идёт честно через SOCKS handshake.
function makeTgAgent() {
  return PROXY_URL
    ? new SocksProxyAgent(PROXY_URL)
    : new https.Agent({ keepAlive: true });
}
let tgAgent = makeTgAgent();

// search api — локалхост, прокси не нужен.
const searchAgent  = new http.Agent({ keepAlive: true });
const whisperAgent = new http.Agent({ keepAlive: true });

// ─── низкоуровневые http helpers ────────────────────────────────────────────

function requestJson({ url, method = "GET", body = null, agent, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const isHttps = u.protocol === "https:";
    const lib = isHttps ? https : http;
    const opts = {
      method,
      hostname: u.hostname,
      port:     u.port || (isHttps ? 443 : 80),
      path:     u.pathname + u.search,
      agent,
      headers: { accept: "application/json" },
    };
    let payload = null;
    if (body !== null) {
      payload = Buffer.from(JSON.stringify(body), "utf8");
      opts.headers["content-type"]   = "application/json; charset=utf-8";
      opts.headers["content-length"] = payload.length;
    }
    const req = lib.request(opts, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let json = null;
        try { json = raw ? JSON.parse(raw) : null; } catch {
          return reject(new Error(`non-JSON response status=${res.statusCode}: ${raw.slice(0, 200)}`));
        }
        resolve({ status: res.statusCode, body: json });
      });
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`request timeout after ${timeoutMs}ms`));
    });
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Telegram Bot API ───────────────────────────────────────────────────────

async function tg(method, params) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const { status, body } = await requestJson({
    url,
    method:    "POST",
    body:      params,
    agent:     tgAgent,
    timeoutMs: FETCH_TIMEOUT_MS,
  });
  if (status !== 200 || !body || body.ok !== true) {
    const desc = body?.description || `status=${status}`;
    const err = new Error(`telegram ${method} failed: ${desc}`);
    err.tg_status = status;
    err.tg_description = body?.description;
    throw err;
  }
  return body.result;
}

async function getUpdates(offset) {
  return tg("getUpdates", {
    offset,
    timeout:         POLL_TIMEOUT_S,
    allowed_updates: ["message", "callback_query"],
  });
}

// ─── Telegram multipart (sendDocument) через undici ────────────────────────
//
// node:http не умеет multipart искаропки, а sendDocument требует
// multipart/form-data. Используем undici.fetch (он умеет FormData + Blob), а
// для SOCKS-прокси Telegram'а делаем кастомный UndiciAgent с connect через
// пакет `socks` (тот же приём, что в llm/hydeGenerator.js).
let _tgUndiciDispatcher = null;
let _tgUndiciResolved   = false;
function makeTgSocksDispatcher(socksUrl) {
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
function getTgUndiciDispatcher() {
  if (_tgUndiciResolved) return _tgUndiciDispatcher;
  _tgUndiciResolved = true;
  if (!PROXY_URL) { _tgUndiciDispatcher = undefined; return undefined; }
  if (/^socks/i.test(PROXY_URL)) {
    _tgUndiciDispatcher = makeTgSocksDispatcher(PROXY_URL);
  } else {
    // http(s)-прокси не закладываемся — Telegram в РФ только через SOCKS.
    _tgUndiciDispatcher = undefined;
  }
  return _tgUndiciDispatcher;
}

/**
 * sendDocument для Telegram. buffer = Buffer с файлом, filename = имя для UI
 * (например "summary.pdf"), caption — опционально под parse_mode=HTML.
 * Возвращает body.result от Telegram. На ошибку — бросает.
 */
async function tgSendDocument(chatId, buffer, filename, caption, opts = {}) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`;
  const form = new FormData();
  form.append("chat_id", String(chatId));
  if (caption) {
    form.append("caption", caption);
    form.append("parse_mode", "HTML");
  }
  if (opts.reply_markup) {
    form.append("reply_markup", JSON.stringify(opts.reply_markup));
  }
  // Telegram API принимает PDF как application/pdf; Blob с правильным MIME
  // даёт корректный Content-Type в multipart.
  const blob = new Blob([buffer], { type: opts.contentType || "application/pdf" });
  form.append("document", blob, filename);

  const dispatcher = getTgUndiciDispatcher();
  const r = await undiciFetch(url, {
    method:        "POST",
    body:          form,
    dispatcher,
    headersTimeout: FETCH_TIMEOUT_MS,
    bodyTimeout:    FETCH_TIMEOUT_MS,
  });
  const json = await r.json().catch(() => null);
  if (!r.ok || !json || json.ok !== true) {
    const desc = json?.description || `status=${r.status}`;
    const err = new Error(`telegram sendDocument failed: ${desc}`);
    err.tg_status = r.status;
    err.tg_description = json?.description;
    throw err;
  }
  return json.result;
}

async function answerCallbackQuery(cbId, text = "") {
  try {
    await tg("answerCallbackQuery", { callback_query_id: cbId, text });
  } catch (e) {
    // Telegram сам инвалидирует cb_id через ~15 минут; ignore.
    log("WARN", "answerCallbackQuery failed", { msg: e?.message ?? String(e) });
  }
}

async function sendMessage(chatId, text, opts = {}) {
  const params = {
    chat_id: chatId,
    text:    text.length > TG_MAX_MSG ? text.slice(0, TG_MAX_MSG - 16) + "\n…[обрезано]" : text,
    disable_web_page_preview: true,
    ...opts,
  };
  return tg("sendMessage", params);
}

// Edit the message under which the callback button was tapped. Used for
// navigation callbacks (menu/info/help/...) so a single bot message keeps
// shapeshifting between sections instead of spamming new ones. Search
// results stay separate sendMessage's — that's the user-visible distinction.
//
// Safe fallback: if Telegram refuses to edit (cb_id expired, message too
// old, content identical → "message is not modified") we just drop —
// answerCallbackQuery already fired, so the UI button "unsticks" anyway.
async function editToCallback(cb, text, replyMarkup) {
  const chatId = cb.message?.chat?.id;
  const messageId = cb.message?.message_id;
  if (!chatId || !messageId) return;
  // Зачищаем orphan'ы из многочастного INFO: пользователь ушёл с инфо-блока,
  // дополнительные части без клавиатуры больше не нужны.
  const orphans = _infoOrphans.get(chatId);
  if (orphans?.length) {
    _infoOrphans.delete(chatId);
    log("INFO", "orphan cleanup", { chat_id: chatId, anchor: messageId, orphans });
    for (const mid of orphans) {
      if (mid === messageId) continue;
      try {
        await tg("deleteMessage", { chat_id: chatId, message_id: mid });
      } catch (e) {
        log("WARN", "orphan deleteMessage failed", {
          chat_id: chatId,
          message_id: mid,
          msg: e?.tg_description || e?.message || String(e),
        });
      }
    }
  }
  const safeText = text.length > TG_MAX_MSG
    ? text.slice(0, TG_MAX_MSG - 16) + "\n…[обрезано]"
    : text;
  const params = {
    chat_id: chatId,
    message_id: messageId,
    text: safeText,
    parse_mode: "HTML",
    disable_web_page_preview: true,
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  };
  try {
    await tg("editMessageText", params);
  } catch (e) {
    const desc = e?.tg_description || e?.message || "";
    if (/message is not modified/i.test(desc)) return;
    log("WARN", "editMessageText failed", { msg: desc });
  }
}

// Экранирует строку для безопасной вставки в HTML parse_mode Telegram.
// Telegram HTML понимает только <, >, &; кавычки оставляем как есть, но для
// атрибутов href пропускаем через тот же escape — Telegram это принимает.
function htmlEscape(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// ─── Search API ─────────────────────────────────────────────────────────────

function buildSearchPayload(query, opts) {
  const payload = { query };
  if (opts.topN          !== undefined) payload.topN          = opts.topN;
  if (opts.use_hyde      !== undefined) payload.use_hyde      = opts.use_hyde;
  if (opts.use_summary   !== undefined) payload.use_summary   = opts.use_summary;
  if (opts.hyde_model)                  payload.hyde_model    = opts.hyde_model;
  if (opts.summary_model)               payload.summary_model = opts.summary_model;
  if (opts.summary_top_n !== undefined) payload.summary_top_n = opts.summary_top_n;
  if (opts.chat_id  != null) payload.chat_id  = opts.chat_id;
  if (opts.user_id  != null) payload.user_id  = opts.user_id;
  if (opts.username)         payload.username = opts.username;
  return payload;
}

async function callSearchApi(query, opts = {}) {
  const payload = buildSearchPayload(query, opts);
  const { status, body } = await requestJson({
    url:       `${SEARCH_API_URL}/search`,
    method:    "POST",
    body:      payload,
    agent:     searchAgent,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  if (status !== 200 || !body?.ok) {
    const detail = body?.error || `status=${status}`;
    const err = new Error(`search api failed: ${detail}`);
    err.api_status = status;
    err.api_body = body;
    throw err;
  }
  return body;
}

// SSE parser: text/event-stream → последовательные { name, data } объекты.
// Спека SSE: каждое событие — блок строк, разделённый пустой строкой; поля
// `event:` (по дефолту "message"), `data:` (multiline, склеиваются через \n),
// строки начинающиеся с ":" — комментарии (мы используем под keep-alive ping).
function parseSseBlock(block) {
  let name = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? ""   : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  let data;
  try { data = JSON.parse(dataLines.join("\n")); }
  catch { return null; }
  return { name, data };
}

/**
 * Stream-версия /search. Подписывается на текущие реальные этапы pipeline'а
 * через text/event-stream и для каждого служебного события зовёт
 * onStage(name, data). Возвращает финальный responseBody (тот же что у /search).
 *
 * @param {string} query
 * @param {object} opts — те же поля, что у callSearchApi.
 * @param {(name: string, data: object) => void} onStage
 * @returns {Promise<object>}
 */
async function callSearchApiStream(query, opts, onStage) {
  const payload = buildSearchPayload(query, opts);
  const ac = new AbortController();
  const timeoutTimer = setTimeout(
    () => ac.abort(new Error(`stream timeout after ${SEARCH_TIMEOUT_MS}ms`)),
    SEARCH_TIMEOUT_MS,
  );

  let finalResult = null;
  try {
    const res = await undiciFetch(`${SEARCH_API_URL}/search/stream`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept":       "text/event-stream",
      },
      body: JSON.stringify(payload),
      signal: ac.signal,
      // localhost — никаких диспетчеров и keep-alive override не надо.
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      const err = new Error(`search/stream http ${res.status}: ${txt.slice(0, 200)}`);
      err.api_status = res.status;
      throw err;
    }

    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += decoder.decode(chunk, { stream: true });
      let idx;
      // Спека SSE: события разделены \n\n (или \r\n\r\n). У нас сервер
      // пишет \n\n, но на всякий нормализуем \r\n→\n.
      buf = buf.replace(/\r\n/g, "\n");
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const evt = parseSseBlock(block);
        if (!evt) continue;
        if (evt.name === "result") {
          finalResult = evt.data;
          continue;
        }
        if (evt.name === "done") {
          // конец стрима; цикл завершится сам, когда res.body закончится
          continue;
        }
        if (evt.name === "error") {
          const err = new Error(`server pipeline error: ${evt.data?.message ?? "unknown"} (stage=${evt.data?.stage ?? "?"})`);
          err.api_body = evt.data;
          throw err;
        }
        if (typeof onStage === "function") {
          try { onStage(evt.name, evt.data); }
          catch (e) { log("WARN", "onStage handler threw", { name: evt.name, msg: e?.message ?? String(e) }); }
        }
      }
    }
    if (!finalResult) {
      throw new Error("stream ended without result event");
    }
    if (!finalResult.ok) {
      const err = new Error(`search api result not ok: ${finalResult.error ?? "unknown"}`);
      err.api_body = finalResult;
      throw err;
    }
    return finalResult;
  } finally {
    clearTimeout(timeoutTimer);
  }
}

async function callStatsApi() {
  const { status, body } = await requestJson({
    url:       `${SEARCH_API_URL}/stats`,
    method:    "GET",
    agent:     searchAgent,
    timeoutMs: SEARCH_TIMEOUT_MS,
  });
  if (status !== 200 || !body?.ok) {
    const detail = body?.error || `status=${status}`;
    const err = new Error(`stats api failed: ${detail}`);
    err.api_status = status;
    err.api_body = body;
    throw err;
  }
  return body;
}

// ─── voice → text (Whisper STT) ─────────────────────────────────────────────

/**
 * Скачивает файл из Telegram через getFile API.
 * Возвращает Buffer с raw bytes.
 */
async function downloadTgFile(fileId) {
  const fileInfo = await tg("getFile", { file_id: fileId });
  const filePath = fileInfo.file_path;
  if (!filePath) throw new Error("getFile returned no file_path");
  const fileUrl = `https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`;

  return new Promise((resolve, reject) => {
    const u = new URL(fileUrl);
    const lib = u.protocol === "https:" ? https : http;
    const req = lib.get({ hostname: u.hostname, port: u.port || 443, path: u.pathname, agent: tgAgent }, (res) => {
      if (res.statusCode !== 200) {
        return reject(new Error(`download file status=${res.statusCode}`));
      }
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error("download timeout")));
  });
}

/**
 * POST audio bytes (base64) → whisper worker → text.
 */
async function callTranscribeApi(audioBuffer) {
  const audioBase64 = audioBuffer.toString("base64");
  const { status, body } = await requestJson({
    url:       `${WHISPER_API_URL}/transcribe`,
    method:    "POST",
    body:      { audio_base64: audioBase64 },
    agent:     whisperAgent,
    timeoutMs: 30000,
  });
  // Пустой text — легитимный ответ (тишина/галлюцинация отфильтрована воркером),
  // его разбирает вызывающий код ("не распознал речь"). Кидаем только на не-200.
  if (status !== 200) {
    const detail = body?.detail || body?.error || `status=${status}`;
    throw new Error(`transcribe failed: ${detail}`);
  }
  return body; // { text, no_speech, language, duration_sec, elapsed_ms, generate_ms }
}

// ─── форматирование ─────────────────────────────────────────────────────────

const TEST_QUERY =
  "Покупатель внёс предоплату по договору поставки, поставщик не поставил " +
  "товар в установленный срок. Есть платежное поручение и претензия. " +
  "Покупатель требует вернуть аванс и проценты по статье 487 ГК РФ.";

const MENU_TEXT_TOP =
  "⚖️ <b>RAS Search — Supply</b>\n" +
  "\n" +
  "Бот ищет арбитражную практику по спорам из договоров поставки.\n" +
  "\n" +
  "Отправьте описание ситуации текстом или голосом:\n" +
  "кто спорит, что произошло, какие документы есть и какой результат нужен.";

const MENU_TEXT_BOTTOM =
  "<b>Пример запроса:</b>\n" +
  "<code>" + TEST_QUERY + "</code>\n" +
  "\n" +
  "Нажмите /test, чтобы запустить пример.";

function buildMenuText(stats) {
  // Динамическая строка статистики живёт между секциями «настройки» и
  // «подробнее»: текст пользователю читается как «вот настройки → база
  // пополняется → подробнее во вкладке Инструкция».
  let statsLine = "";
  if (stats && !stats.warming_up && Number.isFinite(Number(stats.qdrant_acts))) {
    statsLine = `\n\nБаза пополняется. Сейчас в поиске <b>${fmtNum(stats.qdrant_acts)}</b> судебных актов.`;
  }
  return MENU_TEXT_TOP + statsLine + "\n\n" + MENU_TEXT_BOTTOM;
}

// Информация разделена на две части: текст не помещается в один Telegram-message
// (cap 4096 символов). Часть 1 — обзор + пайплайн пошагово; часть 2 —
// углубление (HyDE, late chunking, reranker, Summary, модели, дисклеймер).
// INFO рендерится одним editMessageText'ом — текст помещается в Telegram cap
// 4096. Раньше делили на PART1+PART2 и плодили orphan-сообщения, теперь
// единое сообщение чистенько edit'ится при навигации.
const INFO_TEXT_PART1 =
  "<b>ℹ️ Информация</b>\n" +
  "\n" +
  "⚖️ RAS Search — Supply помогает искать арбитражную практику по спорам из договоров поставки.\n" +
  "\n" +
  "База формируется из решений арбитражных судов (ras.arbitr.ru) и включает только акты по существу спора с мотивировочной частью. Технические и промежуточные акты, например определения об отложении заседания, в поисковую базу не попадают. Алгоритм отслеживает движение дела в первой, апелляционной и кассационной инстанциях, оставляя в поиске только финальный судебный акт. Благодаря этому отмененные решения нижестоящих судов исключаются из базы, и вы получаете выдачу только с актуальными правовыми позициями.\n" +
  "\n" +
  "<b>Что такое векторный поиск (RAG)</b>\n" +
  "Обычный поиск ищет только точные совпадения слов, терминов или номеров статей. Векторный поиск работает с фабулой дела: он переводит текст в смысловые векторы, поэтому находит нужную судебную практику, даже если вы и суд описали ситуацию совершенно разными словами.\n" +
  "\n" +
  "<b>Как проходит поиск</b>\n" +
  "1. Вы отправляете текстовый запрос или голосовое сообщение.\n" +
  "2. Если это голосовое, whisper-large-v3-russian переводит его в текст. Бот показывает распознанный текст, его можно подтвердить или исправить.\n" +
  "3. Исходный запрос сохраняется как главный вопрос пользователя.\n" +
  "4. Если включен HyDE, Gemini API (по умолчанию gemini-3.5-flash) переписывает запрос в стиль судебного акта.\n" +
  "5. Jina embeddings v4 превращает запрос или HyDE-текст в поисковые векторы.\n" +
  "6. Qdrant ищет похожие акты по нескольким каналам: смысловому, словарному и multivector.\n" +
  "7. RRF объединяет результаты каналов. Выше поднимаются акты, которые хорошо нашлись сразу несколькими способами.\n" +
  "8. Jina reranker v3 перечитывает найденные акты и сортирует их по близости к исходному запросу пользователя.\n" +
  "9. Если включен Summary, Gemini API (по умолчанию gemini-3.1-pro-preview) читает топ актов и формирует краткий ответ по практике.\n" +
  "10. Бот показывает Summary и список судебных актов. Если Summary выключен, показывает только найденные акты.";

const INFO_TEXT_PART2 =
  "<b>🤖 HyDE что это?</b>\n" +
  "HyDE (Hypothetical Document Embeddings) — это подход, при котором мы ищем не сам короткий запрос пользователя, а гипотетический пример документа, который должен быть найден. Векторная база не «понимает право» как юрист. Она ищет судебный акт, максимально похожий на входной текст. Поэтому LLM переписывает запрос в эталонный фрагмент судебного акта, и уже этот текст отправляется в векторный поиск. Реранкер при этом получает исходный запрос пользователя.\n" +
  "\n" +
  "<b>📋 Summary что это?</b>\n" +
  "Summary — краткий ответ по найденной практике. Он строится только на актах, которые нашёл бот. Если найденные акты нерелевантны, Summary тоже нужно проверять.\n" +
  "\n" +
  "<b>Late chunking и multivector</b>\n" +
  "Чтобы не вырывать фразы из контекста, мы используем late chunking — алгоритм сначала «читает» весь акт целиком, и только потом делит его на удобные для поиска фрагменты. А благодаря подходу multivector поиск умеет находить точные ответы, сравнивая ваш запрос как с документом в целом, так и с конкретными формулировками внутри него.\n" +
  "\n" +
  "<b>Reranker и RRF</b>\n" +
  "Алгоритм RRF собирает найденные документы вместе, после выстраивает их предварительный рейтинг: чем выше акт оценили разные механизмы поиска, тем больший вес он получает в общем списке. Затем в дело вступает Reranker — специализированная нейросеть, целенаправленно обученная глубокому смысловому анализу текстов. Она сопоставляет ваш изначальный запрос непосредственно с текстами отобранных актов и формирует итоговый топ выдачи, поднимая на самые верхние строчки наиболее точную судебную практику.\n" +
  "\n" +
  "<b>🪄 Используемые модели</b>\n" +
  "• голос: <code>antony66/whisper-large-v3-russian</code>\n" +
  "• embedding: <code>jinaai/jina-embeddings-v4</code>\n" +
  "• reranker: <code>jinaai/jina-reranker-v3</code>\n" +
  "• HyDE: API-модели <code>gemini-*</code>, по умолчанию <code>gemini-3.5-flash</code>\n" +
  "• Summary: API-модели <code>gemini-*</code>, по умолчанию <code>gemini-3.1-pro-preview</code>";

const INFO_TEXT = INFO_TEXT_PART1 + "\n\n" + INFO_TEXT_PART2;
// INFO рендерится одним сообщением (editMessageText): общий текст ~3894 симв,
// умещается в Telegram cap 4096. PART1/PART2 — просто логическое разбиение
// исходника. Если правки выведут сумму за 4096 — вернуть массив из двух частей.
const INFO_TEXT_PARTS = [INFO_TEXT];

const SEARCH_HELP_TEXT =
  "💡 <b>Инструкция</b>\n" +
  "\n" +
  "Напишите ситуацию обычным языком или отправьте голосовое сообщение.\n" +
  "\n" +
  "✍️ <b>Чтобы поиск был точнее, укажите:</b>\n" +
  "\n" +
  "• кто спорит: покупатель или поставщик\n" +
  "• что произошло: неоплата, просрочка, дефект, отказ принять товар или вернуть деньги\n" +
  "• какие есть документы: договор, УПД, акт приемки, претензия, переписка, экспертиза\n" +
  "• какой результат нужен: взыскать долг, вернуть оплату, найти практику в пользу покупателя или поставщика\n" +
  "• важные детали: вид товара, скрытые недостатки, монтаж, экспертиза, статья ГК РФ\n" +
  "\n" +
  "📖 <b>Как читать результат</b>\n" +
  "\n" +
  "Сначала бот показывает краткий вывод 📋 (summary) по найденной практике. Он нужен для быстрой ориентации, но не заменяет чтение судебных актов.\n" +
  "\n" +
  "Ниже идет список найденных актов. Их лучше читать сверху вниз: первый акт обычно самый близкий к запросу, дальше совпадения могут быть слабее.\n" +
  "\n" +
  "Бот ищет похожие документы, но не проверяет, подходят ли они юридически. В выдачу может попасть нерелевантный акт, если он похож на запрос по словам или общему смыслу.\n" +
  "\n" +
  "Окончательный вывод нужно делать по текстам самих судебных актов.";

const EXAMPLES_TEXT =
  "🧩 <b>Примеры запросов</b>\n" +
  "\n" +
  "1. <code>Покупатель подписал УПД без замечаний, но после монтажа выявил скрытые недостатки оборудования. Нужны дела в пользу покупателя и какие экспертизы помогли.</code>\n" +
  "\n" +
  "2. <code>Поставщик взыскал оплату по договору поставки, покупатель ссылался на недостатки товара и отсутствие качества. Нужны решения, где суд отказал покупателю.</code>\n" +
  "\n" +
  "3. <code>Просрочка поставки, покупатель требует неустойку и убытки. Нужны дела, где суд снизил неустойку по статье 333 ГК РФ.</code>";

const FEATURES_TEXT =
  "⚙️ <b>Возможности</b>\n" +
  "\n" +
  "• поиск практики по договорам поставки\n" +
  "• карточки актов с судом, датой, делом и исходом\n" +
  "• ссылка на PDF КАД\n" +
  "• настройка количества актов\n" +
  "• статус наполнения базы\n" +
  "• подбор по фактическому описанию ситуации";

// Системное меню Telegram (setMyCommands) — короткий список под полем ввода.
// /help, /status, /ping остаются текстовыми командами, в системном меню их
// нет, потому что главный канал — inline keyboard.
const BOT_COMMANDS = [
  { command: "menu",  description: "Меню" },
  { command: "start", description: "Restart" },
];

// Главное меню — inline keyboard под сообщением.
// Раскладка:
//   [        🏠 Меню         ]   ← одинокая, визуально самая крупная
//   [📊 Статус базы]  [⚙️ Настройки поиска]
//   [💡 Инструкция]   [ℹ️ Информация]
const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🏠 Меню",            callback_data: "menu" },
    ],
    [
      { text: "📊 Статус базы",     callback_data: "status" },
      { text: "⚙️ Настройки", callback_data: "search_settings" },
    ],
    [
      { text: "💡 Инструкция",      callback_data: "search_help" },
      { text: "ℹ️ Информация",            callback_data: "info" },
    ],
  ],
};

// In-memory LRU кэш HyDE-текстов под кнопкой «📝 Как Gemini переписал».
// Telegram callback_data ограничен 64 байтами — сам текст туда не положить,
// поэтому храним в памяти по короткому id и в callback'е достаём.
// Лимит 1000 записей: при превышении выкидываем самую старую.
const HYDE_CACHE_MAX = 1000;
const _hydeCache = new Map(); // id -> { text, model, model_version, chars, usage, elapsed_ms, finish, query, ts }
let   _hydeCacheCounter = 0;
function rememberHydeEntry(entry) {
  if (!entry?.text) return null;
  const id = (++_hydeCacheCounter).toString(36); // base36 — компактнее
  _hydeCache.set(id, { ...entry, ts: Date.now() });
  while (_hydeCache.size > HYDE_CACHE_MAX) {
    const firstKey = _hydeCache.keys().next().value;
    _hydeCache.delete(firstKey);
  }
  return id;
}
function recallHydeEntry(id) {
  return _hydeCache.get(id) || null;
}

// Аналогичный LRU кэш для саммари — кнопка «📋 Summary лог» под результатами
// показывает финальный grounded-ответ + метаданные генерации.
const SUMMARY_CACHE_MAX = 1000;
const _summaryCache = new Map();
let   _summaryCacheCounter = 0;
function rememberSummaryEntry(entry) {
  if (!entry?.text) return null;
  const id = (++_summaryCacheCounter).toString(36);
  _summaryCache.set(id, { ...entry, ts: Date.now() });
  while (_summaryCache.size > SUMMARY_CACHE_MAX) {
    const firstKey = _summaryCache.keys().next().value;
    _summaryCache.delete(firstKey);
  }
  return id;
}
function recallSummaryEntry(id) {
  return _summaryCache.get(id) || null;
}

// Inline-клавиатура под результатами поиска. Раскладка зеркалит MAIN_KEYBOARD:
//   [          🏠 Меню          ]
//   [📊 Статус базы]  [⚙️ Настройки поиска]
//   [💡 Инструкция ИЛИ 📝 HyDE лог]  [ℹ️ Информация ИЛИ 📋 Summary лог]
//
// «🏠 Меню» крупно сверху (без пары) и заменяет старую кнопку «Новый поиск» —
// меню и есть отправная точка для нового запроса. Логи / fallback'и в нижнем
// ряду: лево — HyDE-лог если был HyDE, иначе «Инструкция»; право — Summary
// лог если был саммари, иначе «Информация».
function buildResultsKeyboard(hydeId, summaryId) {
  return {
    inline_keyboard: [
      [{ text: "🏠 Меню", callback_data: "menu" }],
      [
        { text: "📊 Статус базы",      callback_data: "status" },
        { text: "⚙️ Настройки", callback_data: "search_settings" },
      ],
      [
        hydeId
          ? { text: "📝 HyDE лог",    callback_data: `show_hyde:${hydeId}` }
          : { text: "💡 Инструкция",  callback_data: "search_help" },
        summaryId
          ? { text: "📋 Summary лог", callback_data: `show_summary:${summaryId}` }
          : { text: "ℹ️ Информация",        callback_data: "info" },
      ],
    ],
  };
}

const RESULTS_KEYBOARD = buildResultsKeyboard(null, null);

// Клавиатура внутри HyDE/Summary лог-вью. Юзер кликает кнопку лога под
// карточками — то сообщение редактируется в лог-вью. Кнопки тут позволяют
// переключиться на «соседний» лог (если он есть), вернуться к шапке-якорю
// («↩️ Назад» — восстанавливает «🔎 Поиск — id …» с обычной клавиатурой
// выдачи) или уйти в главное меню. searchId передаём в callback_data, чтобы
// при возврате нарисовать ту же шапку, что была изначально.
function buildLogKeyboard({ peerHydeId, peerSummaryId, activeKind, searchId, ownHydeId, ownSummaryId }) {
  const row = [];
  if (activeKind !== "hyde" && peerHydeId) {
    row.push({ text: "📝 HyDE лог",    callback_data: `show_hyde:${peerHydeId}` });
  }
  if (activeKind !== "summary" && peerSummaryId) {
    row.push({ text: "📋 Summary лог", callback_data: `show_summary:${peerSummaryId}` });
  }
  const rows = [];
  if (row.length) rows.push(row);
  // back_results:<sid>:<hyde>:<summary> — «-» обозначает «нет соответствующего
  // лога». Используем «-» как sentinel, чтобы при возврате клавиатура шапки
  // правильно отрендерила доступные кнопки HyDE/Summary без обращения к
  // кэшу записей.
  const sid = searchId ? searchId : "-";
  const h   = ownHydeId    ?? peerHydeId    ?? "-";
  const s   = ownSummaryId ?? peerSummaryId ?? "-";
  rows.push([{ text: "↩️ Назад", callback_data: `back_results:${sid}:${h}:${s}` }]);
  rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

// «Настройки поиска» — главное меню. Каждая кнопка ведёт в подвью или
// тумблит флаг. Текст-карточка содержит текущие значения.
function searchSettingsText(chatId) {
  const s = getChatSettings(chatId);
  const flag = (v) => (v ? "✅ вкл" : "❌ выкл");
  const lines = [
    "⚙️ <b>Настройки</b>",
    "",
    `📊 <b>Кол-во актов в выдаче:</b> ${s.topN} <i>(1–${TOPN_MAX})</i>`,
    `🤖 <b>HyDE-обработка запроса:</b> ${flag(s.use_hyde)}`,
  ];
  if (s.use_hyde) {
    lines.push(`🪄 <b>Модель HyDE:</b> <code>${htmlEscape(s.hyde_model)}</code>`);
  }
  lines.push(`📋 <b>Summary результатов:</b> ${flag(s.use_summary)}`);
  if (s.use_summary) {
    lines.push(`📥 <b>Актов в Summary:</b> ${s.summary_top_n} <i>(1–${s.topN})</i>`);
    lines.push(`🪄 <b>Модель Summary:</b> <code>${htmlEscape(s.summary_model)}</code>`);
  }
  lines.push(
    "",
    "<i>Все настройки сохраняются для вашего чата и переживают рестарт бота.</i>",
  );
  return lines.join("\n");
}

function searchSettingsKeyboard(chatId) {
  const s = getChatSettings(chatId);
  // Строка с моделью показывается ТОЛЬКО когда соответствующий тумблер ON —
  // если фича выключена, выбирать модель не имеет смысла и кнопка путает.
  const rows = [
    [{ text: `✏️ Кол-во актов: ${s.topN}`, callback_data: "ss_edit_topn" }],
    [
      { text: `🤖 HyDE: ${s.use_hyde ? "✅" : "❌"}`,       callback_data: "ss_toggle_hyde"    },
      { text: `📋 Summary: ${s.use_summary ? "✅" : "❌"}`,  callback_data: "ss_toggle_summary" },
    ],
  ];
  if (s.use_hyde) {
    rows.push([{ text: `🪄 Модель HyDE: ${s.hyde_model}`, callback_data: "ss_pick_hyde_model" }]);
  }
  if (s.use_summary) {
    rows.push([{ text: `📥 Актов в Summary: ${s.summary_top_n}`, callback_data: "ss_edit_summary_topn" }]);
    rows.push([{ text: `🪄 Модель Summary: ${s.summary_model}`,  callback_data: "ss_pick_summary_model" }]);
  }
  rows.push([{ text: "🏠 Меню", callback_data: "menu" }]);
  return { inline_keyboard: rows };
}

function modelPickKeyboard(kind, current) {
  const prefix = kind === "hyde" ? "ss_set_hyde_model:" : "ss_set_summary_model:";
  const rows = HYDE_MODELS.map((m) => ([
    { text: (m.id === current ? "✅ " : "") + m.label, callback_data: prefix + m.id },
  ]));
  rows.push([{ text: "↩️ Назад", callback_data: "search_settings" }]);
  return { inline_keyboard: rows };
}

function modelPickText(kind, current) {
  const what = kind === "hyde" ? "HyDE" : "Summary";
  return (
    `🪄 <b>Модель ${what}</b>\n` +
    "\n" +
    `Сейчас: <code>${htmlEscape(current)}</code>\n` +
    "\n" +
    "Все модели — Gemini, доступные по нашему API-ключу. " +
    "Pro-варианты дают лучшее качество, flash — быстрее и дешевле."
  );
}

const VERDICT_LABELS = {
  grant:      "✅ удовлетворено",
  deny:       "❌ отказ",
  partial:    "🟡 частично",
  // Подменители для actов, у которых RAS не отдаёт текст исхода в метаданных,
  // но сам жанр документа — substantive финал по существу (umbrella + genre).
  // Derived в searchPipeline.compactResult по type_id + content_types_string.
  simplified: "📄 упрощённое производство",
  additional: "📄 дополнительное решение",
};

const INSTANCE_LABELS = {
  1: "1-я инст.",
  2: "апелляция",
  3: "кассация",
};

function cleanSnippet(s, maxChars = 280) {
  if (!s) return "";
  const t = String(s).replace(/\s+/g, " ").trim();
  if (t.length <= maxChars) return t;
  return t.slice(0, maxChars).trimEnd() + "…";
}

function fmtNum(n) {
  if (!Number.isFinite(Number(n))) return String(n ?? "?");
  // 112711 → "112 711"
  return Number(n).toLocaleString("ru-RU").replace(/,/g, " ");
}

function fmtPct(p) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "—";
  return Number(p).toFixed(2) + "%";
}

function formatVerdict(action) {
  if (!action) return null;
  const key = String(action).toLowerCase();
  return VERDICT_LABELS[key] || htmlEscape(action);
}

function formatInstance(il) {
  if (il === null || il === undefined) return null;
  return INSTANCE_LABELS[Number(il)] || `инст. ${il}`;
}

// Ссылка на карточку дела на kad.arbitr.ru по case_id (UUID).
function kadCardUrl(caseId) {
  if (!caseId || typeof caseId !== "string") return null;
  if (!/^[0-9a-f-]{36}$/i.test(caseId.trim())) return null;
  return `https://kad.arbitr.ru/Card/${caseId.trim()}`;
}

// Карточка одного акта. Снэппет не показываем — он начинается с мусорной
// шапки суда и портит выдачу. Вместо него — две ссылки: PDF и карточка дела
// на КАД. type_name («Решения и постановления») не показываем — он у 99%
// записей одинаковый (umbrella-категория из RAS) и только шумит выдачу.
function formatResultCard(r, idx1Based) {
  const court      = htmlEscape(r.court || "?");
  const date       = htmlEscape(r.registration_date || "?");
  const caseNumber = htmlEscape(r.case_number || "?");
  const instance   = formatInstance(r.true_instance_level);
  const verdict    = formatVerdict(r.verdict_action);
  const notFinal   = r.verdict_keep === false ? " <i>(не финал)</i>" : "";
  const pdf        = r.pdf_link
    ? `\n🔗 <a href="${htmlEscape(r.pdf_link)}">Открыть PDF</a>`
    : "";
  const kadUrl     = kadCardUrl(r.case_id);
  const kad        = kadUrl
    ? `\n🗂 <a href="${htmlEscape(kadUrl)}">Карточка дела</a>`
    : "";

  const metaParts = [`📅 ${date}`];
  if (instance) metaParts.push(`🏛 ${htmlEscape(instance)}`);
  if (verdict) metaParts.push(verdict + notFinal);

  return (
    `<b>${idx1Based}) ⚖️ ${court}</b>\n` +
    `Дело: <b>${caseNumber}</b>\n` +
    metaParts.join(" · ") +
    pdf +
    kad
  );
}

// Граница безопасной длины Telegram-сообщения. TG_MAX_MSG=4096; держим запас
// под HTML-сущности после санитайза.
const SAFE_MSG_CHARS = 3900;

// ─── live-прогресс под /search ──────────────────────────────────────────────
//
// /search занимает 5-90 сек (HyDE 2-5с + retrieval 1-3с + rerank 2-5с + summary
// 20-60с). Голый «typing»-индикатор Telegram держит только 5 сек, после этого
// юзер смотрит в стену и не понимает что происходит. Решение: отправляем
// статус-сообщение, циклично крутим в нём стадии через editMessageText, и
// параллельно тикаем sendChatAction чтобы typing-dots не пропадал.
//
// Стадии формируются динамически по настройкам поиска: если HyDE выключен —
// этап «переписываю запрос» пропускается и т.д. По завершении/ошибке
// сообщение удаляется (deleteMessage), чтобы карточки результатов читались
// сверху без шума.

// Мапа серверных SSE-событий → пользовательских лейблов. Каждое *_start
// событие переводит UI на новый лейбл. *_done события не меняют UI сами по
// себе (просто фиксируют, что этап завершён); следующий *_start перебивает.
//
// Сервер шлёт:
//   pipeline_start  → ничего (просто разогрев, лейбл уже стоит «Запрос принят»)
//   hyde_start      → "🪄 LLM подготавливает запрос…"
//   hyde_done       → (no change)
//   hyde_skipped    → (no change — следующий стейдж перебьёт)
//   search_start    → "🔎 Ищу по базе судебных актов…"
//   search_done     → (no change)
//   summary_start   → "⚖️ LLM анализирует тексты найденных актов…"
//   summary_done    → (no change)
//   summary_skipped → (no change)
//   pipeline_done   → (no change — сейчас прилетит result)
//
// PDF-стейдж (📄) выставляется самим ботом ПОСЛЕ получения result, на время
// локального рендера PDF — это уже не сервер, поэтому в карте нет.
const PROGRESS_LABELS = {
  hyde_start:    { icon: "🪄", label: "LLM подготавливает запрос…" },
  search_start:  { icon: "🔎", label: "Ищу по базе судебных актов…" },
  summary_start: { icon: "⚖️", label: "LLM анализирует тексты найденных актов…" },
};

function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} сек`;
  const m = Math.floor(s / 60);
  return `${m} мин ${s % 60} сек`;
}

// ─── Search queue ───────────────────────────────────────────────────────────
//
// На 30+ одновременных пользователях handleMessage().catch() fire-and-forget
// бил всем по search-api сразу, и тот, в свою очередь, шёл параллельно в
// reranker (GPU) и Gemini (квоты). Очередь сериализует поиск через простой
// семафор:
//   TG_BOT_SEARCH_CONCURRENCY  одновременно «активных» поисков (def 2)
// Жёсткого потолка очереди НЕТ — сколько прилетит, столько и обслужим
// (или пользователи отменят сами через кнопку «❌ Отменить ожидание» в
// статус-сообщении). Per-chat dedup: один чат не может занимать больше
// одного слота сразу (повторное «Искать» из того же чата отбиваем).
const SEARCH_MAX_CONCURRENT = Math.max(1, Number(process.env.TG_BOT_SEARCH_CONCURRENCY || 2));

let _searchActive = 0;
let _searchJobCounter = 0;
/** @type {Map<string, {chatId:any, jobId:string, runFn:()=>Promise<any>, notify:(e:object)=>any|null, resolve:Function, reject:Function, canceled:boolean}>} */
const _searchJobs = new Map();   // jobId -> job (включая active)
const _searchQueue = [];          // FIFO of jobIds, только ожидающие
const _perChatBusy = new Set();

function searchQueueStats() {
  return { active: _searchActive, queued: _searchQueue.length };
}

function _queuePosition(jobId) {
  const idx = _searchQueue.indexOf(jobId);
  return idx === -1 ? null : idx + 1;
}

async function _runQueuedJob(job) {
  try {
    if (job.canceled) {
      const err = new Error("canceled");
      err.code = "CANCELED";
      job.reject(err);
      return;
    }
    if (job.notify) {
      try { await job.notify({ status: "start" }); } catch (e) {
        log("WARN", "queue notify(start) failed", { msg: e?.message ?? String(e) });
      }
    }
    const result = await job.runFn();
    job.resolve(result);
  } catch (e) {
    job.reject(e);
  } finally {
    _searchActive -= 1;
    _perChatBusy.delete(job.chatId);
    _searchJobs.delete(job.jobId);
    _pumpSearchQueue();
  }
}

function _pumpSearchQueue() {
  while (_searchActive < SEARCH_MAX_CONCURRENT && _searchQueue.length > 0) {
    const jobId = _searchQueue.shift();
    const job = _searchJobs.get(jobId);
    if (!job || job.canceled) continue;       // отменённые тихо пропускаем
    _searchActive += 1;
    _runQueuedJob(job);
  }
}

/**
 * Снимает job из очереди по jobId. Возвращает job, если успели отменить до
 * старта; null, если job уже активный/несуществующий. Освобождает per-chat
 * слот и шлёт rejected promise с code=CANCELED. Сообщение очереди caller
 * удаляет сам.
 */
function cancelQueuedJob(jobId) {
  const job = _searchJobs.get(jobId);
  if (!job) return null;
  const idx = _searchQueue.indexOf(jobId);
  if (idx === -1) return null;                // уже стартовал
  _searchQueue.splice(idx, 1);
  job.canceled = true;
  _searchJobs.delete(jobId);
  _perChatBusy.delete(job.chatId);
  const err = new Error("canceled");
  err.code = "CANCELED";
  job.reject(err);
  return job;
}

/**
 * Ставит поисковый job в очередь. notify(event) вызывается:
 *   - { status: "wait", position: N, jobId } — сразу при постановке, если
 *     активных слотов нет; N — позиция в очереди (1-based), jobId — токен
 *     для cancel-кнопки (≤ 12 символов, влезает в callback_data).
 *   - { status: "start" } — когда job снимается с очереди и стартует.
 * Бросает Error с code = "PER_CHAT_BUSY".
 * Резолвится тем, что вернул runFn. Reject с code=CANCELED, если юзер отменил.
 */
function enqueueSearch(chatId, runFn, notify) {
  if (_perChatBusy.has(chatId)) {
    const err = new Error("per_chat_busy");
    err.code = "PER_CHAT_BUSY";
    throw err;
  }
  _perChatBusy.add(chatId);

  const jobId = (++_searchJobCounter).toString(36);
  return new Promise((resolve, reject) => {
    const job = { chatId, jobId, runFn, notify: notify || null, resolve, reject, canceled: false };
    _searchJobs.set(jobId, job);
    if (_searchActive < SEARCH_MAX_CONCURRENT) {
      _searchActive += 1;
      _runQueuedJob(job);
    } else {
      _searchQueue.push(jobId);
      if (notify) {
        try { notify({ status: "wait", position: _searchQueue.length, jobId }); } catch (e) {
          log("WARN", "queue notify(wait) failed", { msg: e?.message ?? String(e) });
        }
      }
    }
  });
}

/**
 * Высокоуровневая обёртка: гарантированно проводит весь pipeline поиска через
 * очередь (queue → runWithProgress → sendSearchResults → finishProgress) и
 * шлёт юзеру статус-сообщение, если он попал в очередь. На повторном запросе
 * из того же чата — отвечает дружелюбной ошибкой и пробрасывает её наверх.
 */
async function runQueuedSearch(chatId, settings, queryText, opts, label) {
  let queueMsgId = null;
  const notify = async (event) => {
    if (event.status === "wait") {
      try {
        const m = await sendMessage(
          chatId,
          `🕒 <b>Вы в очереди</b>\n\nПозиция: <b>${event.position}</b>\n` +
            `Активных поисков сейчас: ${_searchActive} / ${SEARCH_MAX_CONCURRENT}\n` +
            `Как подойдёт ваша очередь — начну искать автоматически.\n` +
            `Если передумали — нажмите «Отменить ожидание».`,
          {
            parse_mode: "HTML",
            reply_markup: {
              inline_keyboard: [
                [{ text: "❌ Отменить ожидание", callback_data: `qcancel:${event.jobId}` }],
              ],
            },
          },
        );
        queueMsgId = m?.message_id ?? null;
      } catch (e) {
        log("WARN", "queue: wait msg send failed", { msg: e?.message ?? String(e) });
      }
    } else if (event.status === "start" && queueMsgId) {
      try {
        await tg("deleteMessage", { chat_id: chatId, message_id: queueMsgId });
      } catch {}
      queueMsgId = null;
    }
  };

  try {
    return await enqueueSearch(chatId, async () => {
      const { apiResp, finishProgress } = await runWithProgress(chatId, settings, queryText, opts);
      await sendSearchResults(chatId, queryText, apiResp);
      await finishProgress();
      log("INFO", `${label} answered`, {
        chat_id: chatId,
        search_id: apiResp.search_id,
        results: apiResp.results?.length ?? 0,
        elapsed_ms: apiResp.elapsed_ms,
      });
      return apiResp;
    }, notify);
  } catch (e) {
    if (e?.code === "CANCELED" && queueMsgId) {
      try { await tg("deleteMessage", { chat_id: chatId, message_id: queueMsgId }); } catch {}
    }
    throw e;
  }
}

async function notifyQueueError(chatId, err) {
  if (err?.code === "PER_CHAT_BUSY") {
    try {
      await sendMessage(
        chatId,
        "⏳ <b>У вас уже выполняется поиск.</b>\n\n" +
          "Дождитесь окончания — я пришлю результаты, а потом смогу принять новый запрос. " +
          "Если вы в очереди, нажмите «❌ Отменить ожидание» в сообщении-статусе.",
        { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
      );
    } catch {}
    return true;
  }
  if (err?.code === "CANCELED") {
    try {
      await sendMessage(
        chatId,
        "✅ <b>Запрос отменён.</b>\n\nОтправьте новый запрос, когда будете готовы.",
        { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
      );
    } catch {}
    return true;
  }
  return false;
}

/**
 * Открывает SSE-стрим /search/stream, отрисовывает реальные стадии в чат
 * (через editMessageText), возвращает финальный /search-ответ. Никаких
 * таймерных эвристик — UI меняется только когда сервер реально перешёл к
 * новой стадии.
 *
 * Возвращает apiResp (то же что callSearchApi), плюс side-effect:
 *   - до начала рендера PDF переводит лейбл в «📄 Оформляю PDF-отчёт» (если
 *     был summary).
 *   - удаляет статус-сообщение на самом верхнем уровне (см. вызывающий код).
 *
 * @returns {Promise<{ apiResp: object, progressMsgId: number|null, finishProgress: () => Promise<void> }>}
 */
async function runWithProgress(chatId, settings, queryText, opts) {
  const t0 = Date.now();
  const initialText =
    `⏳ <b>Запрос принят</b>\n\n` +
    `⏱ <code>0 сек</code>`;

  let progressMsg = null;
  try {
    progressMsg = await tg("sendMessage", {
      chat_id: chatId,
      text:    initialText,
      parse_mode: "HTML",
      disable_web_page_preview: true,
    });
  } catch (e) {
    log("WARN", "progress: sendMessage failed", { msg: e?.message ?? String(e) });
  }

  let currentLabel = { icon: "⏳", label: "Запрос принят" };
  const renderText = () => {
    const elapsed = fmtElapsed(Date.now() - t0);
    return `${currentLabel.icon} <b>${htmlEscape(currentLabel.label)}</b>\n\n` +
      `⏱ <code>${elapsed}</code>`;
  };

  // Lightweight таймер для обновления только секундомера ⏱ внутри текущего
  // лейбла, между серверными событиями. Так юзер видит что время идёт, даже
  // когда summary молотится 40 секунд. Текст лейбла НЕ меняем — только цифры.
  const tickTimer = setInterval(async () => {
    if (!progressMsg) return;
    try {
      await tg("editMessageText", {
        chat_id:    chatId,
        message_id: progressMsg.message_id,
        text:       renderText(),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e) {
      const d = e?.tg_description || "";
      if (!/message is not modified/i.test(d)) {
        log("WARN", "progress: tick edit failed", { msg: e?.message ?? String(e) });
      }
    }
  }, 5000);
  tickTimer.unref?.();

  // Telegram typing-индикатор живёт ~5 сек, нужно подталкивать.
  const typingTimer = setInterval(() => {
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  }, 4000);
  typingTimer.unref?.();
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

  // Хелпер для перевода UI на новую стадию (вызывается из onStage и из
  // финиша при рендере PDF). Сразу пишет editMessageText, чтобы юзер видел
  // переход моментально.
  const setLabel = async (icon, label) => {
    currentLabel = { icon, label };
    if (!progressMsg) return;
    try {
      await tg("editMessageText", {
        chat_id:    chatId,
        message_id: progressMsg.message_id,
        text:       renderText(),
        parse_mode: "HTML",
        disable_web_page_preview: true,
      });
    } catch (e) {
      const d = e?.tg_description || "";
      if (!/message is not modified/i.test(d)) {
        log("WARN", "progress: setLabel edit failed", { msg: e?.message ?? String(e) });
      }
    }
  };

  const onStage = (name, data) => {
    const lbl = PROGRESS_LABELS[name];
    if (lbl) {
      log("INFO", "stage", { chat_id: chatId, name, data });
      void setLabel(lbl.icon, lbl.label);
    } else {
      // pipeline_*, *_done, *_skipped — просто логируем в сервер-логи, UI не меняем.
      log("INFO", "stage", { chat_id: chatId, name, data });
    }
  };

  let apiResp;
  try {
    apiResp = await callSearchApiStream(queryText, opts, onStage);
  } catch (e) {
    // На ошибку — гасим таймеры и удаляем статус-сообщение перед пробросом.
    clearInterval(tickTimer);
    clearInterval(typingTimer);
    if (progressMsg) {
      try { await tg("deleteMessage", { chat_id: chatId, message_id: progressMsg.message_id }); } catch {}
    }
    throw e;
  }

  // Если будет PDF-рендер (есть summary) — переводим лейбл, и держим
  // сообщение живым пока caller рендерит и шлёт PDF. Caller вызовет
  // finishProgress() сам в конце.
  const willRenderPdf = !!(apiResp.summary?.used && apiResp.summary?.text);
  if (willRenderPdf) {
    await setLabel("📄", "Оформляю PDF-отчёт…");
  }

  const finishProgress = async () => {
    clearInterval(tickTimer);
    clearInterval(typingTimer);
    if (progressMsg) {
      try {
        await tg("deleteMessage", { chat_id: chatId, message_id: progressMsg.message_id });
      } catch (e) {
        log("WARN", "progress: deleteMessage failed", { msg: e?.message ?? String(e) });
      }
    }
  };

  return { apiResp, progressMsgId: progressMsg?.message_id ?? null, finishProgress };
}

// Отправка результатов поиска: заголовок + пачки карточек ≤ SAFE_MSG_CHARS.
// Последняя пачка содержит keyboard. Если в apiResp есть hyde.text — кладём
// его в LRU-кэш и добавляем в keyboard кнопку «📝 Как Gemini переписал запрос».
async function sendSearchResults(chatId, query, apiResp) {
  const results = (apiResp.results ?? []);

  // HyDE-текст под кнопку (если есть).
  const hyde = apiResp.hyde || null;
  const summary = apiResp.summary || null;
  const hydeId = (hyde && hyde.used && hyde.text)
    ? rememberHydeEntry({
        text:          hyde.text,
        model:         hyde.model,
        model_version: hyde.model_version,
        chars:         hyde.chars,
        usage:         hyde.usage,
        elapsed_ms:    hyde.elapsed_ms,
        finish:        hyde.finish_reason,
        truncated_from: hyde.truncated_from,
        query,
        search_id:     apiResp.search_id,
      })
    : null;
  // Summary-текст под кнопку (если есть). Дополнительно сохраняем top-N актов,
  // которые ушли в LLM (для отображения ссылок вместо тела ответа).
  const summaryActsN = summary?.acts_used ?? results.length;
  const summaryId = (summary && summary.used && summary.text)
    ? rememberSummaryEntry({
        text:          summary.text,
        model:         summary.model,
        model_version: summary.model_version,
        chars:         summary.chars,
        usage:         summary.usage,
        elapsed_ms:    summary.elapsed_ms,
        finish:        summary.finish_reason,
        acts_used:     summary.acts_used,
        acts_passed:   results.slice(0, summaryActsN),
        query,
        search_id:     apiResp.search_id,
      })
    : null;
  // Cross-link: в каждой записи знаем id «второго» лога, чтобы клавиатура
  // на View-странице давала кнопку переключения между HyDE ↔ Summary.
  if (hydeId) {
    const h = recallHydeEntry(hydeId);
    if (h) { h.peerSummaryId = summaryId; }
  }
  if (summaryId) {
    const s = recallSummaryEntry(summaryId);
    if (s) { s.peerHydeId = hydeId; }
  }
  const keyboard = buildResultsKeyboard(hydeId, summaryId);

  if (results.length === 0) {
    await sendMessage(chatId, "Ничего не найдено.", {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }

  // Две независимые «шапки» поиска:
  //   topHeader  — наверху, без клавиатуры: id, дата, метаданные (время,
  //                флаги HyDE/Summary, кол-во актов). Информативная подпись.
  //   footerAnchor — внизу, с клавиатурой: только «🔎 Поиск — id …» одной
  //                строкой. Это якорь под кнопки логов/меню; редактируется
  //                callback'ами, карточки актов выше остаются на месте.
  // Верстка верхней шапки — всё в столбик, каждое поле на своей строке.
  // Группы разделены пустой строкой:
  //   1) id-заголовок
  //   2) Дата, Время, Актов в выдаче, Актов в Summary (если Summary used)
  //   3) Флаги HyDE/Summary (только включённые) и модели (лейбл и значение
  //      на отдельных строках — модели имена длинные, в одну строку не лезут)
  // Слово «Summary» оставляем английским — совпадает с обозначением фичи.
  const idLine = apiResp.search_id
    ? `🔎 <b>Поиск</b> — id <code>${htmlEscape(apiResp.search_id)}</code>`
    : `🔎 <b>Поиск</b>`;
  const elapsedHuman = apiResp.elapsed_ms != null
    ? fmtElapsed(apiResp.elapsed_ms)
    : "?";
  const hydeUsed    = !!apiResp.hyde?.used;
  const summaryUsed = !!apiResp.summary?.used;
  const actsTotal   = results.length;
  const actsInSum   = summaryUsed ? (apiResp.summary.acts_used ?? actsTotal) : 0;

  const statsLines = [
    `📅 <b>Дата:</b> ${formatSearchTimestamp(new Date())}`,
    `⏱ <b>Время:</b> ${elapsedHuman}`,
    `📊 <b>Актов в выдаче:</b> ${actsTotal}`,
  ];
  if (summaryUsed) statsLines.push(`📥 <b>Актов в Summary:</b> ${actsInSum}`);

  const featureBlockLines = [];
  if (hydeUsed)    featureBlockLines.push("🤖 <b>HyDE:</b> ✅");
  if (summaryUsed) featureBlockLines.push("📋 <b>Summary:</b> ✅");
  if (hydeUsed && apiResp.hyde?.model) {
    featureBlockLines.push(`🪄 <b>Модель HyDE:</b>\n<code>${htmlEscape(apiResp.hyde.model)}</code>`);
  }
  if (summaryUsed && apiResp.summary?.model) {
    featureBlockLines.push(`🪄 <b>Модель Summary:</b>\n<code>${htmlEscape(apiResp.summary.model)}</code>`);
  }

  const groups = [idLine, statsLines.join("\n")];
  if (featureBlockLines.length) groups.push(featureBlockLines.join("\n"));
  const topHeader = groups.join("\n\n");
  const footerAnchor = idLine;

  await sendMessage(chatId, topHeader, { parse_mode: "HTML" });

  // Grounded-summary (если включена и сгенерилась) — отдельным PDF-документом
  // ПЕРЕД карточками. Раньше слали чанками по 3900 символов с экранированным
  // markdown'ом — выглядело позорно: разметка не рендерилась, текст рвался
  // посередине абзаца. Теперь marked → HTML → Playwright Chromium → PDF.
  log("INFO", "summary state", {
    chat_id:   chatId,
    used:      summary?.used ?? false,
    requested: summary?.requested ?? false,
    chars:     summary?.text?.length ?? 0,
    error:     summary?.error ?? null,
  });
  if (summary && summary.used && summary.text) {
    const modelLabel = summary.model_version || summary.model || "?";
    try {
      const pdfBuf = await renderSummaryToPdf({
        query,
        summary,
        hyde:         apiResp.hyde ?? null,
        searchId:     apiResp.search_id ?? null,
        results,
        summaryActsN: summaryActsN,
      });
      // Шапка PDF: первая строка — заголовок с search_id (тот же id, что
      // и у поиска в верхней шапке — связку «поиск → саммари» удобнее держать
      // на одном идентификаторе, чем плодить отдельный summary_id); вторая —
      // короткое пояснение, что такое Summary.
      const summaryIdLine = apiResp.search_id
        ? `📋 <b>Summary</b> — id <code>${htmlEscape(apiResp.search_id)}</code>`
        : `📋 <b>Summary</b>`;
      const caption =
        summaryIdLine + "\n" +
        `<i>Краткое изложение найденных актов под ваш запрос</i>`;
      // filename для UI Telegram — короткий, без спецсимволов. Используем
      // search_id из ras_pg_logs.searches: по нему отчёт однозначно
      // привязан к конкретному поиску. Fallback на timestamp на случай если
      // search_id вдруг отсутствует (старый /search без stream).
      let filename;
      if (apiResp.search_id) {
        filename = `summary_${apiResp.search_id}.pdf`;
      } else {
        const now = new Date();
        const stamp = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,"0")}${String(now.getDate()).padStart(2,"0")}-${String(now.getHours()).padStart(2,"0")}${String(now.getMinutes()).padStart(2,"0")}`;
        filename = `summary_${stamp}.pdf`;
      }
      await tgSendDocument(chatId, pdfBuf, filename, caption);
      log("INFO", "summary pdf sent", {
        chat_id:  chatId,
        bytes:    pdfBuf.length,
        chars:    summary.text.length,
        elapsed_ms: summary.elapsed_ms,
      });
    } catch (e) {
      // PDF упал — не теряем саммари, fallback на текст (чанкованный).
      log("ERROR", "summary pdf render/send failed", { msg: e?.message ?? String(e) });
      const header = `📋 <b>Ответ юриста</b> <i>(PDF не сгенерировался, шлю текстом)</i>\n` +
        `<i>На основе ${summary.acts_used ?? results.length} актов · ` +
        `${htmlEscape(modelLabel)}</i>\n\n`;
      const bodyHtml = htmlEscape(summary.text);
      const FIRST_CAP = SAFE_MSG_CHARS - header.length;
      if (bodyHtml.length <= FIRST_CAP) {
        await sendMessage(chatId, header + bodyHtml, { parse_mode: "HTML" });
      } else {
        await sendMessage(chatId, header + bodyHtml.slice(0, FIRST_CAP), { parse_mode: "HTML" });
        let pos = FIRST_CAP;
        while (pos < bodyHtml.length) {
          await sendMessage(chatId, bodyHtml.slice(pos, pos + SAFE_MSG_CHARS), { parse_mode: "HTML" });
          pos += SAFE_MSG_CHARS;
        }
      }
    }
  } else if (summary && summary.requested && summary.error) {
    // Юзер просил саммари, но Gemini упал. Скажем явно, чтобы не выглядело,
    // что фичу проигнорировали.
    await sendMessage(
      chatId,
      `📋 <i>Summary не сгенерировалось: ${htmlEscape(summary.error)}</i>`,
      { parse_mode: "HTML" },
    );
  }

  // Заголовок «Подборка практики» прикрепляется к первой пачке карточек одним
  // сообщением. Клавиатура НЕ навешивается на пачки актов — она живёт на
  // нижнем сообщении-шапке (footerText ниже), чтобы нажатие «лог» редактировало
  // именно его, а карточки оставались видны.
  const SEP = "\n\n";
  const PRACTICE_HEADER = "🔎 <b>Подборка практики:</b>";
  const batches = [];
  let buf = PRACTICE_HEADER;
  for (let i = 0; i < results.length; i++) {
    const card = formatResultCard(results[i], i + 1);
    const add = SEP + card;
    if (buf.length + add.length > SAFE_MSG_CHARS) {
      batches.push(buf);
      buf = card;
    } else {
      buf += add;
    }
  }
  if (buf) batches.push(buf);

  for (let i = 0; i < batches.length; i++) {
    await sendMessage(chatId, batches[i], { parse_mode: "HTML" });
  }

  // Нижняя шапка-якорь с клавиатурой. Всегда последнее сообщение в треде
  // поиска — именно его редактируют callback'и логов и меню. Текст — только
  // «🔎 Поиск — id …», чтобы выглядело как финальная плашка под список.
  await sendMessage(chatId, footerAnchor, {
    parse_mode: "HTML",
    reply_markup: keyboard,
  });
}

// Дата поиска для шапки результатов: dd.MM.yyyy в локальной TZ контейнера.
// Без времени — юзер просил только дату.
function formatSearchTimestamp(d) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function formatAgo(ageMs) {
  const ms = Number(ageMs);
  if (!Number.isFinite(ms) || ms < 0) return "только что";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  const d = Math.floor(h / 24);
  return `${d} д`;
}

function formatStats(stats) {
  if (stats.warming_up) {
    return "⏳ Статистика обновляется, попробуйте через минуту.";
  }
  return (
    "📊 <b>Статус базы</b>\n" +
    `🔗 Собрано ссылок: <b>${fmtNum(stats.total_links)}</b>\n` +
    `✅ Валидных ссылок: <b>${fmtNum(stats.valid_links)}</b>\n` +
    `📄 Скачано текстов: <b>${fmtNum(stats.downloaded_acts)}</b>` +
    ` · ${fmtPct(stats.downloaded_pct_of_valid)}\n` +
    `🪄 В векторной базе: <b>${fmtNum(stats.qdrant_acts)}</b>` +
    ` · ${fmtPct(stats.qdrant_pct_of_downloaded)}\n` +
    `🕒 Обновлено: ${formatAgo(stats.age_ms)} назад`
  );
}

// ─── обработка апдейтов ─────────────────────────────────────────────────────

function isAllowed(userId) {
  if (ALLOWED_IDS === null) return true; // open mode
  return ALLOWED_IDS.has(Number(userId));
}

function matchesCommand(text, name) {
  // /cmd, /cmd@bot, /cmd arg…
  const re = new RegExp(`^\\/${name}(?:@\\S+)?(?:\\s|$)`, "i");
  return re.test(text);
}

async function sendMenu(chatId, text = null) {
  let body = text;
  if (body === null) {
    let stats = null;
    try {
      stats = await callStatsApi();
    } catch (e) {
      log("WARN", "menu stats failed", { msg: e?.message ?? String(e) });
    }
    body = buildMenuText(stats);
  }
  await sendMessage(chatId, body, {
    parse_mode: "HTML",
    reply_markup: MAIN_KEYBOARD,
  });
}

async function runTestQuery(chatId, userId) {
  const settings = getChatSettings(chatId);
  log("INFO", "test command", { user_id: userId, chat_id: chatId });
  log("INFO", "query", {
    user_id: userId, chat_id: chatId,
    q_len: TEST_QUERY.length,
    topN: settings.topN,
    use_hyde: settings.use_hyde,
    use_summary: settings.use_summary,
    hyde_model: settings.hyde_model,
    summary_model: settings.summary_model,
    source: "test_cmd",
  });
  try {
    // /test тоже должен уважать настройки чата (HyDE/Summary/модели), иначе
    // пользователь не видит реального поведения системы. Через очередь —
    // как и обычные запросы: иначе /test от 30 человек разом ляжет.
    await runQueuedSearch(chatId, settings, TEST_QUERY, {
      topN:          settings.topN,
      use_hyde:      settings.use_hyde,
      use_summary:   settings.use_summary,
      hyde_model:    settings.hyde_model,
      summary_model: settings.summary_model,
      summary_top_n: settings.summary_top_n,
      chat_id:       chatId,
      user_id:       userId,
    }, "test");
  } catch (e) {
    if (await notifyQueueError(chatId, e)) return;
    log("ERROR", "test failed", {
      user_id: userId,
      chat_id: chatId,
      msg: e?.message ?? String(e),
    });
    try {
      await sendMessage(
        chatId,
        "Ошибка поиска: " + htmlEscape(e?.message ?? "unknown"),
        { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
      );
    } catch {}
  }
}

async function sendStatusReply(chatId) {
  tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
  try {
    const stats = await callStatsApi();
    await sendMessage(chatId, formatStats(stats), {
      parse_mode: "HTML",
      reply_markup: MAIN_KEYBOARD,
    });
  } catch (e) {
    log("ERROR", "status failed", { msg: e?.message ?? String(e) });
    try {
      await sendMessage(
        chatId,
        "Не удалось получить статистику: " + htmlEscape(e?.message ?? "unknown"),
        { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
      );
    } catch {}
  }
}

async function handleMessage(msg) {
  const chatId = msg.chat?.id;
  const userId = msg.from?.id;
  const text   = (msg.text || "").trim();
  // Аудио источники, которые шлёт Telegram:
  //   msg.voice      — голосовое сообщение (OGG/Opus)
  //   msg.audio      — обычный аудиофайл (mp3/m4a/…)
  //   msg.video_note — «кружок» (mp4 c H.264+AAC; камера + микрофон)
  // Whisper-воркер декодирует через ffmpeg любой контейнер, поэтому видеотрек
  // в кружке нам не мешает — звуковую дорожку он вытащит сам.
  const voice  = msg.voice || msg.audio || msg.video_note;

  if (!chatId || !userId) return;
  if (!text && !voice) return;

  if (!isAllowed(userId)) {
    log("WARN", "denied", { user_id: userId, chat_id: chatId });
    try {
      await sendMessage(chatId, "Доступ запрещён. Обратись к администратору бота.");
    } catch {}
    return;
  }

  // Stateful input для «Кол-во актов»: после ss_edit_topn ждём от юзера
  // число следующим сообщением. Если приходит что-то другое — снимаем
  // ожидание и обрабатываем как обычное сообщение.
  const pending = getPendingInput(chatId);
  if (pending?.kind === "topN" && !text.startsWith("/")) {
    clearPendingInput(chatId);
    const num = Number(text.replace(/\s+/g, ""));
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < TOPN_MIN || num > TOPN_MAX) {
      await sendMessage(
        chatId,
        `❌ Ожидал целое число от ${TOPN_MIN} до ${TOPN_MAX}, получил: <code>${htmlEscape(text.slice(0,40))}</code>\n\nНастройка не изменилась.`,
        { parse_mode: "HTML", reply_markup: searchSettingsKeyboard(chatId) },
      );
      return;
    }
    const n = setChatTopN(chatId, num);
    log("INFO", "topN set (input)", { user_id: userId, chat_id: chatId, topN: n });
    await sendMessage(chatId, searchSettingsText(chatId), {
      parse_mode: "HTML",
      reply_markup: searchSettingsKeyboard(chatId),
    });
    return;
  }

  // Stateful input для «Актов в Summary»: то же что topN, но клампим к
  // текущему topN (нельзя саммаризировать больше, чем выдаём).
  if (pending?.kind === "summaryTopN" && !text.startsWith("/")) {
    clearPendingInput(chatId);
    const cur = getChatSettings(chatId);
    const num = Number(text.replace(/\s+/g, ""));
    if (!Number.isFinite(num) || !Number.isInteger(num) || num < SUMMARY_TOPN_MIN || num > cur.topN) {
      await sendMessage(
        chatId,
        `❌ Ожидал целое число от ${SUMMARY_TOPN_MIN} до ${cur.topN} ` +
          `(текущее «Кол-во актов в выдаче»), получил: <code>${htmlEscape(text.slice(0,40))}</code>\n\nНастройка не изменилась.`,
        { parse_mode: "HTML", reply_markup: searchSettingsKeyboard(chatId) },
      );
      return;
    }
    const n = setChatSummaryTopN(chatId, num);
    log("INFO", "summary_top_n set (input)", { user_id: userId, chat_id: chatId, summary_top_n: n });
    await sendMessage(chatId, searchSettingsText(chatId), {
      parse_mode: "HTML",
      reply_markup: searchSettingsKeyboard(chatId),
    });
    return;
  }

  // Voice confirm pending: юзер отправил текст (коррекция) или голосовуху
  // (перезапись). Чистим pending — текст уйдёт в поиск ниже, голосовуха
  // перетранскрибируется в voice handler.
  if (pending?.kind === "voiceConfirm" && !text.startsWith("/")) {
    clearPendingInput(chatId);
    // fall through
  }

  if (matchesCommand(text, "start") || matchesCommand(text, "menu") || matchesCommand(text, "help")) {
    clearPendingInput(chatId);
    await sendMenu(chatId);
    return;
  }

  if (matchesCommand(text, "ping")) {
    await sendMessage(chatId, "✅ Бот работает", { reply_markup: MAIN_KEYBOARD });
    return;
  }

  if (matchesCommand(text, "test")) {
    await runTestQuery(chatId, userId);
    return;
  }

  if (matchesCommand(text, "status")) {
    log("INFO", "status", { user_id: userId, chat_id: chatId });
    await sendStatusReply(chatId);
    return;
  }

  if (text.startsWith("/")) {
    await sendMessage(chatId, "Неизвестная команда.", { reply_markup: MAIN_KEYBOARD });
    return;
  }

  // ── Voice message → Whisper STT → подтверждение ──────────────────────────
  if (voice) {
    log("INFO", "voice", {
      user_id: userId, chat_id: chatId,
      duration: voice.duration, file_size: voice.file_size,
    });
    try {
      tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});

      const audioBuffer = await downloadTgFile(voice.file_id);
      const result = await callTranscribeApi(audioBuffer);

      log("INFO", "transcribed", {
        user_id: userId, chat_id: chatId,
        text_len: result.text.length,
        duration_sec: result.duration_sec,
        elapsed_ms: result.elapsed_ms,
      });

      if (!result.text || result.text.trim().length < 2) {
        await sendMessage(
          chatId,
          "🎤 Не удалось распознать речь. Попробуйте ещё раз или введите запрос текстом.",
          { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
        );
        return;
      }

      const transcribed = result.text.trim();
      setPendingInput(chatId, { kind: "voiceConfirm", text: transcribed });

      await sendMessage(
        chatId,
        `🎤 <b>Распознанный текст:</b>\n` +
          `<code>${htmlEscape(transcribed)}</code>\n\n` +
          `<i>⏱ ${result.duration_sec}с аудио → ${(result.elapsed_ms / 1000).toFixed(1)}с распознавание</i>\n\n` +
          `Нажмите <b>✅ Искать</b> чтобы запустить поиск, или <b>✏️ Изменить</b> чтобы переписать запрос.`,
        {
          parse_mode: "HTML",
          reply_markup: {
            inline_keyboard: [
              [
                { text: "✅ Искать",   callback_data: "voice_confirm" },
                { text: "✏️ Изменить", callback_data: "voice_change"  },
              ],
            ],
          },
        },
      );
    } catch (e) {
      log("ERROR", "voice failed", {
        user_id: userId, chat_id: chatId, msg: e?.message ?? String(e),
      });
      try {
        await sendMessage(
          chatId,
          "🎤 Ошибка распознавания: " + htmlEscape(e?.message ?? "unknown") +
            "\nПопробуйте ещё раз или введите запрос текстом.",
          { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
        );
      } catch {}
    }
    return;
  }

  const settings = getChatSettings(chatId);
  log("INFO", "query", {
    user_id: userId,
    chat_id: chatId,
    q_len: text.length,
    topN: settings.topN,
    use_hyde: settings.use_hyde,
    use_summary: settings.use_summary,
    hyde_model: settings.hyde_model,
  });

  try {
    // Через очередь: при 30+ одновременных юзерах прямой вызов SSE-стрима
    // ляжет на reranker/Gemini. enqueueSearch ограничивает одновременные
    // поиски (TG_BOT_SEARCH_CONCURRENCY), остальные ждут с уведомлением о
    // позиции в очереди.
    await runQueuedSearch(chatId, settings, text, {
      topN:          settings.topN,
      use_hyde:      settings.use_hyde,
      use_summary:   settings.use_summary,
      hyde_model:    settings.hyde_model,
      summary_model: settings.summary_model,
      summary_top_n: settings.summary_top_n,
      chat_id:       chatId,
      user_id:       userId,
      username:      msg.from?.username || null,
    }, "query");
  } catch (e) {
    if (await notifyQueueError(chatId, e)) return;
    log("ERROR", "query failed", {
      user_id: userId,
      chat_id: chatId,
      msg: e?.message ?? String(e),
    });
    try {
      await sendMessage(
        chatId,
        "Ошибка поиска: " + htmlEscape(e?.message ?? "unknown") + "\nПопробуй ещё раз чуть позже.",
        { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
      );
    } catch {}
  }
}

// ─── callback_query (inline keyboard) ───────────────────────────────────────

async function handleCallback(cb) {
  const chatId = cb.message?.chat?.id;
  const userId = cb.from?.id;
  const data   = cb.data;

  // Quick ack — даже если что-то дальше упадёт, кнопка в UI «отщёлкнется».
  await answerCallbackQuery(cb.id, "");

  if (!chatId || !userId || !data) return;

  if (!isAllowed(userId)) {
    log("WARN", "denied cb", { user_id: userId, chat_id: chatId, data });
    try {
      await sendMessage(chatId, "Доступ запрещён. Обратись к администратору бота.");
    } catch {}
    return;
  }

  log("INFO", "callback", { user_id: userId, chat_id: chatId, data });

  try {
    // set_top_<N> — старая семья кнопок (3/5/10/15/20). Оставлена для
    // обратной совместимости со старыми keyboard'ами в истории сообщений
    // (новый UI использует stateful-ввод числа через ss_edit_topn).
    const m = /^set_top_(\d+)$/.exec(data);
    if (m) {
      const n = setChatTopN(chatId, Number(m[1]));
      log("INFO", "topN set", { user_id: userId, chat_id: chatId, topN: n });
      await editToCallback(cb, searchSettingsText(chatId), searchSettingsKeyboard(chatId));
      return;
    }

    // ss_set_hyde_model:<id> / ss_set_summary_model:<id> — выбор модели.
    const mm = /^ss_set_(hyde|summary)_model:(.+)$/.exec(data);
    if (mm) {
      const kind = mm[1];
      const modelId = mm[2];
      if (!isAllowedModel(modelId)) {
        await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Неизвестная модель", show_alert: true });
        return;
      }
      const patch = kind === "hyde" ? { hyde_model: modelId } : { summary_model: modelId };
      updateChatSettings(chatId, patch);
      log("INFO", "model set", { user_id: userId, chat_id: chatId, kind, model: modelId });
      await editToCallback(cb, searchSettingsText(chatId), searchSettingsKeyboard(chatId));
      return;
    }

    // qcancel:<jobId> — снять собственный запрос с очереди ожидания. Не
    // отменяет уже стартовавший поиск (мог упасть mid-Gemini-стрим), только
    // ещё не дошедший до своего слота. cancelQueuedJob освобождает per-chat
    // busy-флаг, runQueuedSearch ловит CANCELED и удаляет статус-сообщение.
    const qm = /^qcancel:(\w+)$/.exec(data);
    if (qm) {
      const job = cancelQueuedJob(qm[1]);
      if (!job) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Поиск уже стартовал — дождитесь результата.",
          show_alert: true,
        });
        return;
      }
      log("INFO", "queue canceled", { user_id: userId, chat_id: chatId, job_id: qm[1] });
      await tg("answerCallbackQuery", { callback_query_id: cb.id, text: "Запрос отменён" });
      return;
    }

    // back_results:<sid>:<hyde>:<summary> — возврат из лог-вью в шапку-якорь
    // выдачи. Восстанавливаем «🔎 Поиск — id …» + клавиатуру с кнопками логов
    // (📝 HyDE / 📋 Summary) и 🏠 Меню. «-» в любой позиции = «нет данных».
    const bm = /^back_results:([^:]+):([^:]+):([^:]+)$/.exec(data);
    if (bm) {
      const sid       = bm[1] === "-" ? null : bm[1];
      const hydeId    = bm[2] === "-" ? null : bm[2];
      const summaryId = bm[3] === "-" ? null : bm[3];
      const idLine = sid
        ? `🔎 <b>Поиск</b> — id <code>${htmlEscape(sid)}</code>`
        : `🔎 <b>Поиск</b>`;
      await editToCallback(cb, idLine, buildResultsKeyboard(hydeId, summaryId));
      return;
    }

    // show_hyde:<id> — показать HyDE-текст + метаданные генерации.
    // Достаём из LRU-кэша. Если кэш потерян (рестарт бота / LRU eviction) —
    // alert «Запрос устарел».
    const hm = /^show_hyde:(\w+)$/.exec(data);
    if (hm) {
      const entry = recallHydeEntry(hm[1]);
      if (!entry) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Запрос устарел, повторите поиск",
          show_alert: true,
        });
        return;
      }
      const u = entry.usage || {};
      const tokParts = [];
      if (u.prompt_tokens     != null) tokParts.push(`prompt=${u.prompt_tokens}`);
      if (u.candidates_tokens != null) tokParts.push(`output=${u.candidates_tokens}`);
      if (u.total_tokens != null && u.prompt_tokens != null && u.candidates_tokens != null) {
        const thinking = u.total_tokens - u.prompt_tokens - u.candidates_tokens;
        if (thinking > 0) tokParts.push(`thinking=${thinking}`);
      }
      if (u.total_tokens != null) tokParts.push(`total=${u.total_tokens}`);
      const tokensLine = tokParts.length ? tokParts.join(", ") : "—";

      const elapsedSec = entry.elapsed_ms != null
        ? (entry.elapsed_ms / 1000).toFixed(2) + " сек"
        : "—";

      const modelLine = entry.model_version && entry.model_version !== entry.model
        ? `<code>${htmlEscape(entry.model)}</code> → API: <code>${htmlEscape(entry.model_version)}</code>`
        : `<code>${htmlEscape(entry.model || "?")}</code>`;

      const truncLine = entry.truncated_from
        ? `\n⚠️ Текст обрезан до ${entry.chars} символов (из ${entry.truncated_from}) перед embedding'ом.`
        : "";

      const HEADER =
        `📝 <b>HyDE запрос</b>\n` +
        `<i>Ваш запрос → синтетический «эталонный» фрагмент акта, который ищется в базе.</i>\n\n` +
        `<b>Search ID:</b> <code>${htmlEscape(entry.search_id || "—")}</code>\n` +
        `<b>Модель:</b> ${modelLine}\n` +
        `<b>Токены:</b> ${tokensLine}\n` +
        `<b>Время:</b> ${elapsedSec}\n` +
        `<b>Длина:</b> ${entry.chars} симв.\n` +
        `<b>Finish:</b> ${htmlEscape(entry.finish || "—")}` +
        truncLine + `\n\n` +
        `<b>Исходный запрос:</b>\n<code>${htmlEscape(entry.query || "")}</code>\n\n` +
        `<b>Переписанный текст:</b>\n`;
      // HyDE-текст в <pre> — переносы строк/кавычки рендерятся как есть.
      // Длинный HyDE обрезаем под Telegram cap; полный текст всё равно лежит
      // в ras_pg_logs.searches и доступен по search_id.
      const body = `<pre>${htmlEscape(entry.text)}</pre>`;
      let full = HEADER + body;
      if (full.length > SAFE_MSG_CHARS) {
        const cutChars = SAFE_MSG_CHARS - HEADER.length - 64;
        const cut = htmlEscape(entry.text).slice(0, Math.max(0, cutChars));
        full = HEADER + `<pre>${cut}\n…[обрезано, полный текст по search_id]</pre>`;
      }
      const kb = buildLogKeyboard({
        peerHydeId:    null,
        peerSummaryId: entry.peerSummaryId,
        activeKind:    "hyde",
        searchId:      entry.search_id,
        ownHydeId:     hm[1],
        ownSummaryId:  entry.peerSummaryId,
      });
      await editToCallback(cb, full, kb);
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    // show_summary:<id> — показать финальный grounded-ответ + метаданные.
    // По формату повторяет show_hyde, чтобы юзер видел одинаковую раскладку
    // и для HyDE, и для саммари: header с моделью/токенами/таймингом + тело
    // в <pre>. На LRU-eviction после рестарта бота — alert «Запрос устарел».
    const sm = /^show_summary:(\w+)$/.exec(data);
    if (sm) {
      const entry = recallSummaryEntry(sm[1]);
      if (!entry) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Запрос устарел, повторите поиск",
          show_alert: true,
        });
        return;
      }
      const u = entry.usage || {};
      const tokParts = [];
      if (u.prompt_tokens     != null) tokParts.push(`prompt=${u.prompt_tokens}`);
      if (u.candidates_tokens != null) tokParts.push(`output=${u.candidates_tokens}`);
      if (u.total_tokens != null && u.prompt_tokens != null && u.candidates_tokens != null) {
        const thinking = u.total_tokens - u.prompt_tokens - u.candidates_tokens;
        if (thinking > 0) tokParts.push(`thinking=${thinking}`);
      }
      if (u.total_tokens != null) tokParts.push(`total=${u.total_tokens}`);
      const tokensLine = tokParts.length ? tokParts.join(", ") : "—";

      const elapsedSec = entry.elapsed_ms != null
        ? (entry.elapsed_ms / 1000).toFixed(2) + " сек"
        : "—";

      const modelLine = entry.model_version && entry.model_version !== entry.model
        ? `<code>${htmlEscape(entry.model)}</code> → API: <code>${htmlEscape(entry.model_version)}</code>`
        : `<code>${htmlEscape(entry.model || "?")}</code>`;

      const HEADER =
        `📋 <b>Summary лог</b>\n` +
        `<i>Финальный ответ юриста на основе top-${entry.acts_used ?? "?"} актов из поиска.</i>\n\n` +
        `<b>Search ID:</b> <code>${htmlEscape(entry.search_id || "—")}</code>\n` +
        `<b>Модель:</b> ${modelLine}\n` +
        `<b>Токены:</b> ${tokensLine}\n` +
        `<b>Время:</b> ${elapsedSec}\n` +
        `<b>Длина:</b> ${entry.chars} симв.\n` +
        `<b>Finish:</b> ${htmlEscape(entry.finish || "—")}\n\n` +
        `<b>Исходный запрос:</b>\n<code>${htmlEscape(entry.query || "")}</code>\n\n` +
        `<b>Акты, переданные в LLM:</b>\n`;
      // Список ссылок на акты, которые ушли в саммаризатор. Тело LLM-ответа
      // целиком тут не показываем — он уходит юзеру отдельным PDF в выдаче.
      // Без хэша/source link'ом тыкаешь на кадастровую карточку.
      const acts = Array.isArray(entry.acts_passed) ? entry.acts_passed : [];
      const lines = acts.map((r, i) => {
        const num   = i + 1;
        const cn    = htmlEscape(r.case_number || "?");
        const court = htmlEscape(r.court || "?");
        const date  = htmlEscape(r.registration_date || "?");
        const kadUrl = kadCardUrl(r.case_id);
        const link   = kadUrl
          ? `<a href="${htmlEscape(kadUrl)}">${cn}</a>`
          : `<b>${cn}</b>`;
        // tokens_jina_v4 — счёт токенов через tokenizer Jina v4 (наш embedder).
        // Это размер акта, который реально ушёл в LLM-контекст (с округлением
        // вверх до сотни — точное значение тут не критично).
        const tok = Number(r.tokens_jina_v4);
        const tokStr = Number.isFinite(tok) && tok > 0
          ? ` · ~${fmtNum(Math.round(tok / 100) * 100)} ток.`
          : "";
        return `${num}) ${link} — ${court} · ${date}${tokStr}`;
      });
      const body = lines.length
        ? lines.join("\n")
        : "<i>(нет переданных актов)</i>";
      const full = HEADER + body;
      const kb = buildLogKeyboard({
        peerHydeId:    entry.peerHydeId,
        peerSummaryId: null,
        activeKind:    "summary",
        searchId:      entry.search_id,
        ownHydeId:     entry.peerHydeId,
        ownSummaryId:  sm[1],
      });
      await editToCallback(cb, full, kb);
      await tg("answerCallbackQuery", { callback_query_id: cb.id });
      return;
    }

    switch (data) {
      case "menu": {
        let stats = null;
        try { stats = await callStatsApi(); }
        catch (e) { log("WARN", "menu stats failed", { msg: e?.message ?? String(e) }); }
        await editToCallback(cb, buildMenuText(stats), MAIN_KEYBOARD);
        return;
      }
      case "info": {
        // INFO разделён на несколько частей (текст не помещается в 4096-char
        // Telegram-cap). Первую часть рендерим editMessageText'ом поверх
        // меню — UX как раньше; остальные части шлём отдельными
        // sendMessage. MAIN_KEYBOARD прикрепляем к последней, чтобы юзеру
        // было откуда вернуться в навигацию.
        if (INFO_TEXT_PARTS.length === 1) {
          await editToCallback(cb, INFO_TEXT_PARTS[0], MAIN_KEYBOARD);
          return;
        }
        await editToCallback(cb, INFO_TEXT_PARTS[0], null);
        // PART1 живёт в месте, где раньше было меню — это orphan, без
        // клавиатуры; настоящий якорь будет на последней части.
        const orphans = [cb.message.message_id];
        for (let i = 1; i < INFO_TEXT_PARTS.length; i++) {
          const isLast = i === INFO_TEXT_PARTS.length - 1;
          const sent = await sendMessage(chatId, INFO_TEXT_PARTS[i], {
            parse_mode: "HTML",
            ...(isLast ? { reply_markup: MAIN_KEYBOARD } : {}),
          });
          if (!isLast && sent?.message_id) orphans.push(sent.message_id);
        }
        _infoOrphans.set(chatId, orphans);
        return;
      }
      case "search_help":
        await editToCallback(cb, SEARCH_HELP_TEXT, MAIN_KEYBOARD);
        return;
      case "examples":
        await editToCallback(cb, EXAMPLES_TEXT, MAIN_KEYBOARD);
        return;
      case "ping":
        await editToCallback(cb, "✅ Бот работает", MAIN_KEYBOARD);
        return;
      case "features":
        await editToCallback(cb, FEATURES_TEXT, MAIN_KEYBOARD);
        return;
      case "status": {
        let stats = null;
        try {
          stats = await callStatsApi();
        } catch (e) {
          log("ERROR", "status failed", { msg: e?.message ?? String(e) });
          await editToCallback(
            cb,
            "Не удалось получить статистику: " + htmlEscape(e?.message ?? "unknown"),
            MAIN_KEYBOARD,
          );
          return;
        }
        await editToCallback(cb, formatStats(stats), MAIN_KEYBOARD);
        return;
      }
      case "top_settings":
      case "search_settings":
        await editToCallback(cb, searchSettingsText(chatId), searchSettingsKeyboard(chatId));
        return;
      case "ss_edit_topn":
        setPendingInput(chatId, { kind: "topN" });
        await editToCallback(
          cb,
          `✏️ <b>Кол-во актов в выдаче</b>\n\nОтправьте число от <b>${TOPN_MIN}</b> до <b>${TOPN_MAX}</b> ` +
            "следующим сообщением.\n\n" +
            "<i>Или нажмите «Назад», чтобы оставить как было.</i>",
          { inline_keyboard: [[{ text: "↩️ Назад", callback_data: "search_settings" }]] },
        );
        return;
      case "ss_edit_summary_topn": {
        const cur = getChatSettings(chatId);
        setPendingInput(chatId, { kind: "summaryTopN" });
        await editToCallback(
          cb,
          `📥 <b>Актов в Summary</b>\n\n` +
            `Из найденных <b>${cur.topN}</b> актов сколько передавать в LLM для составления заключения? ` +
            `Меньше — быстрее и фокуснее, больше — шире анализ.\n\n` +
            `Отправьте число от <b>${SUMMARY_TOPN_MIN}</b> до <b>${cur.topN}</b> следующим сообщением.\n\n` +
            "<i>Или нажмите «Назад», чтобы оставить как было.</i>",
          { inline_keyboard: [[{ text: "↩️ Назад", callback_data: "search_settings" }]] },
        );
        return;
      }
      case "ss_toggle_hyde": {
        const cur = getChatSettings(chatId);
        updateChatSettings(chatId, { use_hyde: !cur.use_hyde });
        log("INFO", "toggle use_hyde", { user_id: userId, chat_id: chatId, value: !cur.use_hyde });
        await editToCallback(cb, searchSettingsText(chatId), searchSettingsKeyboard(chatId));
        return;
      }
      case "ss_toggle_summary": {
        const cur = getChatSettings(chatId);
        updateChatSettings(chatId, { use_summary: !cur.use_summary });
        log("INFO", "toggle use_summary", { user_id: userId, chat_id: chatId, value: !cur.use_summary });
        await editToCallback(cb, searchSettingsText(chatId), searchSettingsKeyboard(chatId));
        return;
      }
      case "ss_pick_hyde_model": {
        const cur = getChatSettings(chatId);
        await editToCallback(cb, modelPickText("hyde", cur.hyde_model), modelPickKeyboard("hyde", cur.hyde_model));
        return;
      }
      case "ss_pick_summary_model": {
        const cur = getChatSettings(chatId);
        await editToCallback(cb, modelPickText("summary", cur.summary_model), modelPickKeyboard("summary", cur.summary_model));
        return;
      }
      case "new_search":
        setPendingInput(chatId, null);
        await editToCallback(cb, "🔎 Отправьте новый запрос текстом или голосовое.", MAIN_KEYBOARD);
        return;
      case "voice_confirm":
        await withVoiceConfirmLock(chatId, async () => {
          const { text: queryText, source: querySource } = resolveVoiceConfirmQuery(chatId, cb.message);
          if (!queryText) {
            log("WARN", "voice_confirm: no query", { user_id: userId, chat_id: chatId });
            await editToCallback(
              cb,
              "⏳ Не удалось прочитать запрос. Отправьте голосовое или текст заново.",
              { inline_keyboard: [] },
            );
            await sendMessage(
              chatId,
              "⏳ Не нашёл текст для поиска (сессия бота могла перезапуститься). " +
                "Отправьте голосовое или введите запрос текстом.",
              { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
            );
            return;
          }
          clearPendingInput(chatId);

          await editToCallback(
            cb,
            `🔎 Ищу: <code>${htmlEscape(queryText)}</code>`,
            { inline_keyboard: [] },
          );

          const settings = getChatSettings(chatId);
          log("INFO", "voice search", {
            user_id: userId, chat_id: chatId,
            q_len: queryText.length,
            topN: settings.topN,
            use_hyde: settings.use_hyde,
            query_source: querySource,
          });

          try {
            await runQueuedSearch(chatId, settings, queryText, {
              topN:          settings.topN,
              use_hyde:      settings.use_hyde,
              use_summary:   settings.use_summary,
              hyde_model:    settings.hyde_model,
              summary_model: settings.summary_model,
              summary_top_n: settings.summary_top_n,
              chat_id:       chatId,
              user_id:       userId,
              username:      cb.from?.username || null,
            }, "voice");
          } catch (e) {
            if (await notifyQueueError(chatId, e)) return;
            log("ERROR", "voice search failed", {
              user_id: userId, chat_id: chatId, msg: e?.message ?? String(e),
            });
            try {
              await sendMessage(
                chatId,
                "Ошибка поиска: " + htmlEscape(e?.message ?? "unknown") +
                  "\nПопробуйте ещё раз.",
                { parse_mode: "HTML", reply_markup: MAIN_KEYBOARD },
              );
            } catch {}
          }
        });
        return;
      case "voice_change": {
        // Юзер хочет переписать запрос. Pending-состояние НЕ чистим: при
        // следующем сообщении (текст/voice/video_note) handleMessage увидит
        // pending=voiceConfirm и пройдёт обычный путь, заменяя распознанный
        // текст новым. Просто обновляем сообщение, объясняя что делать.
        await editToCallback(
          cb,
          "✏️ <b>Отправьте новый запрос</b>\n" +
            "\n" +
            "Можно перепечатать текст или записать заново — голосовым сообщением 🎤 либо видео-кружком 🎥. " +
            "Новый запрос заменит распознанный.",
          null,
        );
        return;
      }
      case "voice_cancel":
        // Совместимость со старыми клавиатурами в истории чата: ведём себя
        // так же, как voice_change — даём юзеру переписать запрос.
        await editToCallback(
          cb,
          "✏️ <b>Отправьте новый запрос</b>\n" +
            "\n" +
            "Можно перепечатать текст или записать заново — голосовым сообщением 🎤 либо видео-кружком 🎥.",
          null,
        );
        return;
      default:
        log("WARN", "unknown callback_data", { data });
    }
  } catch (e) {
    log("ERROR", "callback handler failed", {
      user_id: userId,
      chat_id: chatId,
      data,
      msg: e?.message ?? String(e),
    });
  }
}

// ─── main loop ──────────────────────────────────────────────────────────────

let lastOffset = 0;
let running = true;

// Регистрируем команды в Telegram, чтобы под полем ввода появилась кнопка
// «Меню» со списком. Не критично для работы — если упало, продолжаем.
async function registerBotCommands() {
  try {
    await tg("setMyCommands", { commands: BOT_COMMANDS });
    log("INFO", "commands registered", { count: BOT_COMMANDS.length });
  } catch (e) {
    log("WARN", "setMyCommands failed", { msg: e?.message ?? String(e) });
    return;
  }
  try {
    await tg("setChatMenuButton", { menu_button: { type: "commands" } });
    log("INFO", "menu button set", { type: "commands" });
  } catch (e) {
    log("WARN", "setChatMenuButton failed", { msg: e?.message ?? String(e) });
  }
}

async function pollLoop() {
  // На старте — загружаем persistent per-chat settings и проверяем токен/прокси.
  await loadSettingsFromDisk();
  log("INFO", "settings loaded", { file: SETTINGS_FILE, chats: chatSettings.size });
  try {
    const me = await tg("getMe", {});
    log("INFO", "ready", {
      bot_username: me.username,
      bot_id:       me.id,
      proxy:        PROXY_URL ? "socks (via TELEGRAM_PROXY_URL)" : "direct",
      search_api:   SEARCH_API_URL,
      allowlist:    ALLOWED_IDS === null ? "OPEN" : `${ALLOWED_IDS.size} ids`,
    });
    if (ALLOWED_IDS === null) {
      log("WARN", "TG_BOT_ALLOWED_USER_IDS is empty — bot in OPEN mode, anyone who knows the bot can use it");
    }
    await registerBotCommands();
  } catch (e) {
    log("ERROR", "getMe failed at startup", { msg: e?.message ?? String(e) });
    // Не выходим: возможно прокси временно недоступен. Войдём в цикл с
    // бэкоффом — если токен реально невалидный, Telegram будет стабильно
    // возвращать 401 и мы это увидим в логах.
  }

  let backoffMs = 1000;

  // Watchdog: SOCKS-туннель к Telegram периодически отваливается; без
  // активной реакции бот молча висит на ретраях по 15-30 минут.
  // - после 2 подряд ошибок: пересоздаём tgAgent (=> новый SOCKS handshake,
  //   keep-alive pool с дохлыми сокетами выбрасывается);
  // - после >=5 подряд ошибок ИЛИ >=2 мин без удачного poll: process.exit(1),
  //   systemd через RestartSec=5 поднимает чистый процесс.
  let pollErrCount = 0;
  let lastGoodPollAt = Date.now();
  const AGENT_RESET_AFTER = 2;
  const HARD_EXIT_AFTER_ERRS = 5;
  const HARD_EXIT_AFTER_MS = 2 * 60_000;
  const BACKOFF_MAX_MS = 5_000;

  while (running) {
    try {
      const updates = await getUpdates(lastOffset);
      backoffMs = 1000;
      pollErrCount = 0;
      lastGoodPollAt = Date.now();
      for (const upd of updates) {
        lastOffset = Math.max(lastOffset, (upd.update_id ?? 0) + 1);
        if (upd.message) {
          // Не await'им последовательно, чтобы один долгий запрос не блокировал
          // обработку других. Search API в любом случае держит свою серилизацию
          // через runtime-lease.
          handleMessage(upd.message).catch((e) => {
            log("ERROR", "handler crashed", { msg: e?.message ?? String(e) });
          });
        }
        if (upd.callback_query) {
          handleCallback(upd.callback_query).catch((e) => {
            log("ERROR", "cb handler crashed", { msg: e?.message ?? String(e) });
          });
        }
      }
    } catch (e) {
      pollErrCount += 1;
      const sinceGoodMs = Date.now() - lastGoodPollAt;
      log("WARN", "poll error", {
        msg: e?.message ?? String(e),
        backoff_ms: backoffMs,
        err_streak: pollErrCount,
        since_good_ms: sinceGoodMs,
      });

      if (pollErrCount === AGENT_RESET_AFTER) {
        log("WARN", "poll: rotating tgAgent (SOCKS keep-alive pool reset)", {
          err_streak: pollErrCount,
        });
        try { tgAgent.destroy?.(); } catch {}
        tgAgent = makeTgAgent();
      }

      if (pollErrCount >= HARD_EXIT_AFTER_ERRS || sinceGoodMs >= HARD_EXIT_AFTER_MS) {
        log("ERROR", "poll: telegram unreachable too long, exiting for systemd restart", {
          err_streak: pollErrCount,
          since_good_ms: sinceGoodMs,
        });
        process.exit(1);
      }

      await new Promise((r) => setTimeout(r, backoffMs));
      backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
    }
  }
}

function shutdown(signal) {
  if (!running) return;
  log("INFO", `shutdown signal=${signal}`);
  running = false;
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

pollLoop().catch((e) => {
  log("ERROR", "fatal", { msg: e?.message ?? String(e) });
  process.exit(1);
});
