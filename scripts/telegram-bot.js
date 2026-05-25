#!/usr/bin/env node
/**
 * scripts/telegram-bot.js — тонкий Telegram бот поверх локального Search API.
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

// ─── env ────────────────────────────────────────────────────────────────────

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
if (!BOT_TOKEN) {
  process.stderr.write("[tg-bot] FATAL TELEGRAM_BOT_TOKEN is not set\n");
  process.exit(2);
}

const PROXY_URL      = process.env.TELEGRAM_PROXY_URL || "";
const SEARCH_API_URL = (process.env.RAS_SEARCH_API_URL || "http://127.0.0.1:8091").replace(/\/+$/, "");

// TopN: дефолт 10, allowed диапазон 3..20. Per-chat override хранится
// в chatSettings и приоритетнее ENV-дефолта.
const TOPN_MIN = 3;
const TOPN_MAX = 20;
const TOPN     = Math.max(TOPN_MIN, Math.min(TOPN_MAX, Number(process.env.TG_BOT_TOPN || 10)));

// per-chat настройки: { topN }. In-memory; рестарт = всем дефолт.
const chatSettings = new Map();

function getChatTopN(chatId) {
  const s = chatSettings.get(chatId);
  return Math.max(TOPN_MIN, Math.min(TOPN_MAX, Number(s?.topN || TOPN)));
}

function setChatTopN(chatId, n) {
  const clamped = Math.max(TOPN_MIN, Math.min(TOPN_MAX, Number(n) || TOPN));
  const s = chatSettings.get(chatId) || {};
  s.topN = clamped;
  chatSettings.set(chatId, s);
  return clamped;
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
const searchAgent = new http.Agent({ keepAlive: true });

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

async function callSearchApi(query, topN) {
  const { status, body } = await requestJson({
    url:       `${SEARCH_API_URL}/search`,
    method:    "POST",
    body:      { query, topN },
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

// ─── форматирование ─────────────────────────────────────────────────────────

const TEST_QUERY =
  "Покупатель подписал УПД без замечаний, но при монтаже выявил скрытые " +
  "недостатки оборудования. Нужны дела, где суд поддержал покупателя.";

const MENU_TEXT_TOP =
  "⚖️ <b>RAS Supply Search</b>\n" +
  "\n" +
  "Поиск судебной практики по спорам из договоров поставки.\n" +
  "\n" +
  "<b>Что можно искать:</b>\n" +
  "• скрытые недостатки товара после приемки\n" +
  "• неоплата поставки и взыскание долга\n" +
  "• неустойка за просрочку поставки\n" +
  "• возврат денег за некачественный товар\n" +
  "• экспертизы, УПД, ТОРГ-12, переписка, претензии\n" +
  "\n" +
  "<b>Как пользоваться:</b>\n" +
  "Опишите ситуацию обычным текстом. Чем больше фактов, тем точнее подборка. " +
  "Первый акт в ответе бота более релевантен вашему вопросу, последний менее.\n" +
  "\n" +
  "Подробнее о системе вы можете узнать в поле ИНФО.";

const MENU_TEXT_BOTTOM =
  "Пример (нажмите /test чтобы запустить):\n" +
  "<code>" + TEST_QUERY + "</code>";

function buildMenuText(stats) {
  let statsLine = "";
  if (stats && !stats.warming_up && Number.isFinite(Number(stats.qdrant_acts))) {
    statsLine = `\n\nВ данный момент база пополняется, в ней <b>${fmtNum(stats.qdrant_acts)}</b> актов.`;
  }
  return MENU_TEXT_TOP + statsLine + "\n\n" + MENU_TEXT_BOTTOM;
}

const INFO_TEXT =
  "ℹ️ <b>Инфо</b>\n" +
  "\n" +
  "<b>Что ищет бот</b>\n" +
  "Бот помогает искать судебную практику по арбитражным спорам из договоров поставки.\n" +
  "\n" +
  "Фокус базы:\n" +
  "• оплата и взыскание долга\n" +
  "• качество товара и скрытые недостатки\n" +
  "• приемка товара\n" +
  "• универсальный передаточный документ и ТОРГ-12\n" +
  "• претензии, переписка, экспертизы\n" +
  "• неустойка, возврат денег, расторжение договора\n" +
  "\n" +
  "<b>Источник данных</b>\n" +
  "База собирается из банка решений арбитражных судов: ras.arbitr.ru\n" +
  "\n" +
  "В базу попадают мотивированные судебные акты по существу спора:\n" +
  "• решения первой инстанции\n" +
  "• постановления апелляции\n" +
  "• постановления кассации\n" +
  "\n" +
  "Технические и промежуточные определения, например об отложении заседания или истребовании документов, не попадают в векторную базу.\n" +
  "\n" +
  "<b>Как устроена база</b>\n" +
  "• Postgres хранит карточки дел, метаданные и полный текст актов\n" +
  "• Qdrant хранит поисковые векторы\n" +
  "• Полный текст акта не хранится в Qdrant\n" +
  "• При поиске бот находит кандидатов в Qdrant, затем берет полный текст из Postgres\n" +
  "\n" +
  "<b>Как индексируются акты</b>\n" +
  "Короткие акты до ~8 000 токенов индексируются целиком как один акт:\n" +
  "• dense-вектор для смыслового поиска\n" +
  "• sparse-вектор для словарных совпадений\n" +
  "• multivector MaxSim для более точного сопоставления фрагментов\n" +
  "\n" +
  "Длинные акты от ~8 000 до ~32 000 токенов обрабатываются через late chunking: модель видит акт целиком, после чего в Qdrant сохраняются поисковые векторы его смысловых частей.\n" +
  "\n" +
  "<b>Как работает поиск</b>\n" +
  "1. Запрос превращается в поисковые векторы.\n" +
  "2. Qdrant ищет кандидатов по нескольким каналам: смысловому, словарному и multivector.\n" +
  "3. Результаты каналов объединяются через RRF: выше поднимаются акты, которые хорошо нашлись сразу несколькими способами.\n" +
  "4. Полные тексты кандидатов берутся из Postgres.\n" +
  "5. Реранкер перечитывает тексты актов и ставит выше те, которые ближе к запросу.\n" +
  "6. Бот возвращает топ-N актов. Количество можно выбрать в меню.\n" +
  "\n" +
  "<b>Модели</b>\n" +
  "• embedding: <code>jinaai/jina-embeddings-v4</code>\n" +
  "• reranker: <code>jinaai/jina-reranker-v3</code>\n" +
  "\n" +
  "<b>Что важно понимать</b>\n" +
  "• Это не поиск по точному совпадению слов.\n" +
  "• Можно описывать ситуацию своими словами.\n" +
  "• Работают синонимы и юридические формулировки.\n" +
  "• Первый акт обычно ближе к запросу, последний слабее.\n" +
  "• Не каждый акт в выдаче гарантированно подходит, выдачу нужно проверять.\n" +
  "• База еще пополняется, часть скачанных актов может быть не в векторной базе.\n" +
  "• Бот не дает юридическое заключение, а помогает быстрее найти практику и PDF актов..";

const SEARCH_HELP_TEXT =
  "🔎 <b>Как искать практику</b>\n" +
  "\n" +
  "Чем больше юридически значимых фактов в запросе, тем точнее подборка.\n" +
  "\n" +
  "<b>Что стоит указать:</b>\n" +
  "• кто спорит: покупатель или поставщик\n" +
  "• предмет поставки: оборудование, товар, партия, комплектующие\n" +
  "• что произошло: неоплата, просрочка, скрытые недостатки, отказ вернуть деньги, отказ принять товар\n" +
  "• какие документы есть: договор поставки, универсальный передаточный документ, ТОРГ-12, акт приемки, претензия, переписка, заключение эксперта\n" +
  "• какой исход нужен: в пользу покупателя, в пользу поставщика, взыскать долг, вернуть оплату, отказать в иске\n" +
  "• какие доказательства важны: экспертиза, фото/видео, акты осмотра, переписка, претензии, монтажные документы\n" +
  "\n" +
  "<b>Пример хорошего запроса:</b>\n" +
  "<code>Покупатель подписал универсальный передаточный документ без замечаний, но при монтаже оборудования выявил скрытые недостатки. Поставщик отказался вернуть деньги. Нужны дела в пользу покупателя и какие доказательства помогли.</code>\n" +
  "\n" +
  "<b>Как улучшить выдачу:</b>\n" +
  "• добавьте сторону: «в пользу покупателя» или «иск поставщика»\n" +
  "• добавьте вид нарушения: качество, оплата, просрочка, приемка, возврат денег\n" +
  "• добавьте редкие детали: вид товара, дефект, статья ГК, вид экспертизы\n" +
  "• не смешивайте разные споры в одном сообщении\n" +
  "\n" +
  "Сверху будут самые близкие по смыслу акты. Количество актов меняется кнопкой 🎛 <b>Кол-во актов</b>.";

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
const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "🏠 Меню",         callback_data: "menu" },
    ],
    [
      { text: "🔎 Как искать",   callback_data: "search_help" },
      { text: "🎛 Кол-во актов", callback_data: "top_settings" },
    ],
    [
      { text: "📊 Статус базы",  callback_data: "status" },
      { text: "ℹ️ Инфо",         callback_data: "info" },
    ],
  ],
};

// In-memory LRU кэш HyDE-текстов под кнопкой «📝 Как Gemini переписал».
// Telegram callback_data ограничен 64 байтами — сам текст туда не положить,
// поэтому храним в памяти по короткому id и в callback'е достаём.
// Лимит 1000 записей: при превышении выкидываем самую старую.
const HYDE_CACHE_MAX = 1000;
const _hydeCache = new Map(); // id -> { text, model, chars, query, ts }
let   _hydeCacheCounter = 0;
function rememberHydeText({ text, model, chars, query }) {
  if (!text) return null;
  const id = (++_hydeCacheCounter).toString(36); // base36 — компактнее
  _hydeCache.set(id, { text, model, chars, query, ts: Date.now() });
  while (_hydeCache.size > HYDE_CACHE_MAX) {
    const firstKey = _hydeCache.keys().next().value;
    _hydeCache.delete(firstKey);
  }
  return id;
}
function recallHydeText(id) {
  return _hydeCache.get(id) || null;
}

// Сборка inline-клавиатуры под результатами поиска. Если есть HyDE-текст —
// добавляем кнопку «📝 Как Gemini переписал запрос» первой строкой.
function buildResultsKeyboard(hydeId) {
  const rows = [];
  if (hydeId) {
    rows.push([{ text: "📝 Как Gemini переписал запрос", callback_data: `show_hyde:${hydeId}` }]);
  }
  rows.push(
    [{ text: "🏠 Меню", callback_data: "menu" }],
    [
      { text: "🔎 Новый поиск",  callback_data: "new_search" },
      { text: "📊 Статус базы",  callback_data: "status" },
    ],
    [
      { text: "🎛 Кол-во актов", callback_data: "top_settings" },
      { text: "ℹ️ Инфо",         callback_data: "info" },
    ],
  );
  return { inline_keyboard: rows };
}

const RESULTS_KEYBOARD = buildResultsKeyboard(null); // дефолт без HyDE-кнопки

// Клавиатура выбора TopN. Cb_data set_top_N — N валидно ∈ {3,5,10,15,20}.
const TOP_SETTINGS_KEYBOARD = {
  inline_keyboard: [
    [
      { text: "3",  callback_data: "set_top_3"  },
      { text: "5",  callback_data: "set_top_5"  },
      { text: "10", callback_data: "set_top_10" },
      { text: "15", callback_data: "set_top_15" },
      { text: "20", callback_data: "set_top_20" },
    ],
    [
      { text: "🏠 Меню", callback_data: "menu" },
    ],
  ],
};

function topSettingsText(currentN) {
  return (
    "🎛 <b>Количество актов в выдаче</b>\n" +
    "\n" +
    `Сейчас: <b>${currentN}</b>\n` +
    "\n" +
    "Выберите, сколько актов показывать после поиска:"
  );
}

const VERDICT_LABELS = {
  grant:   "✅ удовлетворено",
  deny:    "❌ отказ",
  partial: "🟡 частично",
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
// на КАД.
function formatResultCard(r, idx1Based) {
  const court      = htmlEscape(r.court || "?");
  const date       = htmlEscape(r.registration_date || "?");
  const caseNumber = htmlEscape(r.case_number || "?");
  const instance   = formatInstance(r.true_instance_level);
  const verdict    = formatVerdict(r.verdict_action);
  const notFinal   = r.verdict_keep === false ? " <i>(не финал)</i>" : "";
  const type       = r.type_name ? `\n📄 ${htmlEscape(r.type_name)}` : "";
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
    type +
    pdf +
    kad
  );
}

// Граница безопасной длины Telegram-сообщения. TG_MAX_MSG=4096; держим запас
// под HTML-сущности после санитайза.
const SAFE_MSG_CHARS = 3900;

// Отправка результатов поиска: заголовок + пачки карточек ≤ SAFE_MSG_CHARS.
// Последняя пачка содержит keyboard. Если в apiResp есть hyde.text — кладём
// его в LRU-кэш и добавляем в keyboard кнопку «📝 Как Gemini переписал запрос».
async function sendSearchResults(chatId, query, apiResp) {
  const results = (apiResp.results ?? []);

  // HyDE-текст под кнопку (если есть).
  const hyde = apiResp.hyde || null;
  const hydeId = (hyde && hyde.used && hyde.text)
    ? rememberHydeText({
        text:  hyde.text,
        model: hyde.model,
        chars: hyde.chars,
        query,
      })
    : null;
  const keyboard = buildResultsKeyboard(hydeId);

  if (results.length === 0) {
    await sendMessage(chatId, "Ничего не найдено.", {
      parse_mode: "HTML",
      reply_markup: keyboard,
    });
    return;
  }

  const elapsedSec = apiResp.elapsed_ms != null
    ? (apiResp.elapsed_ms / 1000).toFixed(1)
    : "?";

  await sendMessage(
    chatId,
    `🔎 <b>Подборка практики</b>\n` +
      `Найдено: <b>${results.length}</b> · время: ${elapsedSec} сек`,
    { parse_mode: "HTML" },
  );

  // Бьём на пачки по бюджету символов; внутри пачки склеиваем \n\n.
  const SEP = "\n\n";
  const batches = [];
  let buf = "";
  for (let i = 0; i < results.length; i++) {
    const card = formatResultCard(results[i], i + 1);
    const add = buf ? SEP + card : card;
    if (buf && buf.length + add.length > SAFE_MSG_CHARS) {
      batches.push(buf);
      buf = card;
    } else {
      buf += add;
    }
  }
  if (buf) batches.push(buf);

  for (let i = 0; i < batches.length; i++) {
    const isLast = i === batches.length - 1;
    await sendMessage(chatId, batches[i], {
      parse_mode: "HTML",
      ...(isLast ? { reply_markup: keyboard } : {}),
    });
  }
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
    `🧠 В векторной базе: <b>${fmtNum(stats.qdrant_acts)}</b>` +
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
  const topN = getChatTopN(chatId);
  log("INFO", "test command", { user_id: userId, chat_id: chatId });
  log("INFO", "query", { user_id: userId, chat_id: chatId, q_len: TEST_QUERY.length, topN });
  try {
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const apiResp = await callSearchApi(TEST_QUERY, topN);
    await sendSearchResults(chatId, TEST_QUERY, apiResp);
    log("INFO", "answered", {
      user_id: userId,
      chat_id: chatId,
      results: apiResp.results?.length ?? 0,
      elapsed_ms: apiResp.elapsed_ms,
    });
  } catch (e) {
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

  if (!chatId || !userId || !text) return;

  if (!isAllowed(userId)) {
    log("WARN", "denied", { user_id: userId, chat_id: chatId });
    try {
      await sendMessage(chatId, "Доступ запрещён. Обратись к администратору бота.");
    } catch {}
    return;
  }

  if (matchesCommand(text, "start") || matchesCommand(text, "menu") || matchesCommand(text, "help")) {
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

  const topN = getChatTopN(chatId);
  log("INFO", "query", { user_id: userId, chat_id: chatId, q_len: text.length, topN });

  try {
    // Лёгкий «typing» — Telegram держит ~5 секунд.
    tg("sendChatAction", { chat_id: chatId, action: "typing" }).catch(() => {});
    const apiResp = await callSearchApi(text, topN);
    await sendSearchResults(chatId, text, apiResp);
    log("INFO", "answered", {
      user_id: userId,
      chat_id: chatId,
      results: apiResp.results?.length ?? 0,
      elapsed_ms: apiResp.elapsed_ms,
    });
  } catch (e) {
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
    // set_top_<N> — отдельная семья callback'ов: меняем число и
    // редактируем сообщение, оставляя пользователя в TopN-вью.
    const m = /^set_top_(\d+)$/.exec(data);
    if (m) {
      const n = setChatTopN(chatId, Number(m[1]));
      log("INFO", "topN set", { user_id: userId, chat_id: chatId, topN: n });
      await editToCallback(cb, topSettingsText(n), TOP_SETTINGS_KEYBOARD);
      return;
    }

    // show_hyde:<id> — показать HyDE-текст под кнопкой. Достаём из LRU-кэша
    // (см. rememberHydeText в sendSearchResults). Если кэш потерян (рестарт
    // бота или вытеснение по LRU) — отвечаем дружелюбной заглушкой.
    const hm = /^show_hyde:(\w+)$/.exec(data);
    if (hm) {
      const entry = recallHydeText(hm[1]);
      if (!entry) {
        await tg("answerCallbackQuery", {
          callback_query_id: cb.id,
          text: "Запрос устарел, повторите поиск",
          show_alert: true,
        });
        return;
      }
      const HEADER =
        `📝 <b>Как Gemini переписал запрос</b>\n` +
        `<i>Ваш запрос → синтетический «эталонный» текст, ` +
        `который ищется в базе судебных актов.</i>\n\n` +
        `<b>Исходный запрос:</b>\n<code>${htmlEscape(entry.query || "")}</code>\n\n` +
        `<b>Переписанный (HyDE, model=${htmlEscape(entry.model || "?")}, ${entry.chars} симв.):</b>\n`;
      // HyDE-текст обёрнут в <pre>, чтобы переносы строк и кавычки
      // отрисовались как есть, без Markdown-интерпретации.
      const body = `<pre>${htmlEscape(entry.text)}</pre>`;
      const full = HEADER + body;
      await sendMessage(chatId, full, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [[{ text: "🏠 Меню", callback_data: "menu" }]] },
      });
      // Закрываем «спиннер» на кнопке.
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
      case "info":
        await editToCallback(cb, INFO_TEXT, MAIN_KEYBOARD);
        return;
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
        await editToCallback(cb, topSettingsText(getChatTopN(chatId)), TOP_SETTINGS_KEYBOARD);
        return;
      case "new_search":
        await editToCallback(cb, "🔎 Отправьте новый запрос текстом.", MAIN_KEYBOARD);
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
  // На старте — getMe, чтобы убедиться что токен живой и прокси работает.
  // Имя бота в логах НЕ пишет токен.
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
