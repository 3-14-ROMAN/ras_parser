// RAS Search — Supply · клиент одностраничного веб-приложения.
// Тонкий клиент поверх /api/* (прокси в server.js → search-api + whisper).
// Без фреймворков и сборки. Зеркалит функционал Telegram-бота.

"use strict";

// ─── константы (синхронны с frontend/telegram/bot.js) ────────────────────────

const TOPN_MIN = 1, TOPN_MAX = 50;
const SUMMARY_TOPN_MIN = 1;

const HYDE_MODELS = [
  { id: "gemini-3.5-flash",       label: "Gemini 3.5 Flash (по умолчанию, быстро)" },
  { id: "gemini-flash-latest",    label: "Gemini Flash Latest (alias)" },
  { id: "gemini-pro-latest",      label: "Gemini Pro Latest (alias)" },
  { id: "gemini-3-pro-preview",   label: "Gemini 3 Pro Preview (качество)" },
  { id: "gemini-3.1-pro-preview", label: "Gemini 3.1 Pro Preview (последний pro)" },
  { id: "gemini-2.5-pro",         label: "Gemini 2.5 Pro (стабильный GA)" },
  { id: "gemini-2.5-flash",       label: "Gemini 2.5 Flash (стабильный GA, дёшево)" },
  { id: "gemini-3.1-flash-lite",  label: "Gemini 3.1 Flash Lite (минимум)" },
];
const isAllowedModel = (id) => HYDE_MODELS.some((m) => m.id === id);

const DEFAULTS = {
  topN:          9,
  use_hyde:      true,
  use_summary:   true,
  hyde_model:    "gemini-3.5-flash",
  summary_model: "gemini-3.1-pro-preview",
  summary_top_n: 4,
};

const TEST_QUERY =
  "Покупатель внёс предоплату по договору поставки, поставщик не поставил " +
  "товар в установленный срок. Есть платежное поручение и претензия. " +
  "Покупатель требует вернуть аванс и проценты по статье 487 ГК РФ.";

const VERDICT_LABELS = {
  grant:      { text: "удовлетворено",          cls: "tag--grant",   ico: "✅" },
  deny:       { text: "отказ",                   cls: "tag--deny",    ico: "❌" },
  partial:    { text: "частично",               cls: "tag--partial", ico: "🟡" },
  simplified: { text: "упрощённое производство", cls: "",             ico: "📄" },
  additional: { text: "дополнительное решение",  cls: "",             ico: "📄" },
};
const INSTANCE_LABELS = { 1: "1-я инстанция", 2: "апелляция", 3: "кассация" };

// ─── DOM ─────────────────────────────────────────────────────────────────────

const $ = (sel) => document.querySelector(sel);
const el = {
  query:        $("#queryInput"),
  charCount:    $("#charCount"),
  searchBtn:    $("#searchBtn"),
  exampleBtn:   $("#exampleBtn"),
  voiceBtn:     $("#voiceBtn"),
  settingsBtn:  $("#settingsBtn"),
  settings:     $("#settingsPanel"),
  progress:     $("#progress"),
  results:      $("#results"),
  menuStats:    $("#menuStats"),
  exampleQuery: $("#exampleQuery"),
  statusBody:   $("#statusBody"),
  // settings controls
  topN:         $("#topN"),
  topNOut:      $("#topNOut"),
  useHyde:      $("#useHyde"),
  hydeModel:    $("#hydeModel"),
  hydeModelRow: $("#hydeModelRow"),
  useSummary:   $("#useSummary"),
  summaryModel: $("#summaryModel"),
  summaryModelRow: $("#summaryModelRow"),
  summaryTopN:  $("#summaryTopN"),
  summaryTopNOut: $("#summaryTopNOut"),
  summaryTopNRow: $("#summaryTopNRow"),
  // voice
  voiceBar:     $("#voiceBar"),
  voiceTimer:   $("#voiceTimer"),
  voiceStopBtn: $("#voiceStopBtn"),
  voiceCancelBtn: $("#voiceCancelBtn"),
};

// ─── settings (localStorage) ─────────────────────────────────────────────────

const SETTINGS_KEY = "ras_web_settings_v1";

function loadSettings() {
  let s = {};
  try { s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}") || {}; } catch {}
  const topN = clamp(Number(s.topN ?? DEFAULTS.topN), TOPN_MIN, TOPN_MAX);
  const sumRaw = Number(s.summary_top_n ?? DEFAULTS.summary_top_n);
  const summary_top_n = Number.isFinite(sumRaw) && sumRaw >= 1
    ? clamp(Math.floor(sumRaw), SUMMARY_TOPN_MIN, topN)
    : Math.min(topN, DEFAULTS.summary_top_n);
  return {
    topN,
    use_hyde:      typeof s.use_hyde    === "boolean" ? s.use_hyde    : DEFAULTS.use_hyde,
    use_summary:   typeof s.use_summary === "boolean" ? s.use_summary : DEFAULTS.use_summary,
    hyde_model:    isAllowedModel(s.hyde_model)    ? s.hyde_model    : DEFAULTS.hyde_model,
    summary_model: isAllowedModel(s.summary_model) ? s.summary_model : DEFAULTS.summary_model,
    summary_top_n,
  };
}

let settings = loadSettings();

function saveSettings() {
  // ре-кламп summary_top_n к актуальному topN перед записью
  settings.summary_top_n = clamp(settings.summary_top_n, SUMMARY_TOPN_MIN, settings.topN);
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch {}
}

function clamp(n, lo, hi) { n = Number(n); if (!Number.isFinite(n)) n = lo; return Math.max(lo, Math.min(hi, Math.round(n))); }

// ─── helpers ─────────────────────────────────────────────────────────────────

function fmtNum(n) {
  if (!Number.isFinite(Number(n))) return String(n ?? "?");
  return Number(n).toLocaleString("ru-RU").replace(/,/g, " ");
}
function fmtElapsed(ms) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} сек`;
  return `${Math.floor(s / 60)} мин ${s % 60} сек`;
}
function fmtPct(p) {
  if (p === null || p === undefined || !Number.isFinite(Number(p))) return "—";
  return Number(p).toFixed(2) + "%";
}
// «X назад» — как formatAgo в боте.
function formatAgo(ms) {
  ms = Number(ms);
  if (!Number.isFinite(ms) || ms < 0) return "только что";
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} с`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} мин`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} ч`;
  return `${Math.floor(h / 24)} д`;
}
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
function kadCardUrl(caseId) {
  if (!caseId || typeof caseId !== "string") return null;
  if (!/^[0-9a-f-]{36}$/i.test(caseId.trim())) return null;
  return `https://kad.arbitr.ru/Card/${caseId.trim()}`;
}

// Безопасный мини-markdown → HTML (escape-first). Summary от Gemini — абзацы,
// **жирный**, списки, заголовки. Поддерживаем именно это.
function renderMarkdown(src) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s0) => {
    let s = esc(s0);
    s = s.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__([^_]+)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>");
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  };
  const lines = String(src).replace(/\r\n/g, "\n").split("\n");
  const out = [];
  let list = null, para = [];
  const flushPara = () => { if (para.length) { out.push("<p>" + inline(para.join(" ")) + "</p>"); para = []; } };
  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) { flushPara(); closeList(); continue; }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { flushPara(); closeList(); const lvl = Math.min(6, h[1].length); out.push(`<h${lvl}>${inline(h[2])}</h${lvl}>`); continue; }
    const ul = /^[-*•]\s+(.*)$/.exec(line);
    const ol = /^\d+[.)]\s+(.*)$/.exec(line);
    if (ul) { flushPara(); if (list !== "ul") { closeList(); out.push("<ul>"); list = "ul"; } out.push("<li>" + inline(ul[1]) + "</li>"); continue; }
    if (ol) { flushPara(); if (list !== "ol") { closeList(); out.push("<ol>"); list = "ol"; } out.push("<li>" + inline(ol[1]) + "</li>"); continue; }
    if (list) closeList();
    para.push(line);
  }
  flushPara(); closeList();
  return out.join("\n");
}

let _toastTimer = null;
function toast(msg, kind = "") {
  let t = $("#toast");
  if (!t) { t = document.createElement("div"); t.id = "toast"; document.body.appendChild(t); }
  t.className = "toast" + (kind ? " toast--" + kind : "");
  t.textContent = msg;
  t.classList.add("is-shown");
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => t.classList.remove("is-shown"), 3500);
}

// ─── render settings panel from state ────────────────────────────────────────

function populateModelSelects() {
  for (const sel of [el.hydeModel, el.summaryModel]) {
    sel.innerHTML = "";
    for (const m of HYDE_MODELS) {
      const o = document.createElement("option");
      o.value = m.id; o.textContent = m.label;
      sel.appendChild(o);
    }
  }
}

function syncSettingsUI() {
  el.topN.value = settings.topN;
  el.topNOut.textContent = settings.topN;
  el.useHyde.checked = settings.use_hyde;
  el.useSummary.checked = settings.use_summary;
  el.hydeModel.value = settings.hyde_model;
  el.summaryModel.value = settings.summary_model;
  el.summaryTopN.max = String(settings.topN);
  el.summaryTopN.value = Math.min(settings.summary_top_n, settings.topN);
  el.summaryTopNOut.textContent = el.summaryTopN.value;
  el.hydeModelRow.classList.toggle("hidden", !settings.use_hyde);
  el.summaryModelRow.classList.toggle("hidden", !settings.use_summary);
  el.summaryTopNRow.classList.toggle("hidden", !settings.use_summary);
}

function wireSettings() {
  el.topN.addEventListener("input", () => {
    settings.topN = clamp(el.topN.value, TOPN_MIN, TOPN_MAX);
    el.topNOut.textContent = settings.topN;
    // summary_top_n не может превышать topN
    el.summaryTopN.max = String(settings.topN);
    if (settings.summary_top_n > settings.topN) settings.summary_top_n = settings.topN;
    el.summaryTopN.value = Math.min(settings.summary_top_n, settings.topN);
    el.summaryTopNOut.textContent = el.summaryTopN.value;
    saveSettings();
  });
  el.summaryTopN.addEventListener("input", () => {
    settings.summary_top_n = clamp(el.summaryTopN.value, SUMMARY_TOPN_MIN, settings.topN);
    el.summaryTopNOut.textContent = settings.summary_top_n;
    saveSettings();
  });
  el.useHyde.addEventListener("change", () => {
    settings.use_hyde = el.useHyde.checked;
    el.hydeModelRow.classList.toggle("hidden", !settings.use_hyde);
    saveSettings();
  });
  el.useSummary.addEventListener("change", () => {
    settings.use_summary = el.useSummary.checked;
    el.summaryModelRow.classList.toggle("hidden", !settings.use_summary);
    el.summaryTopNRow.classList.toggle("hidden", !settings.use_summary);
    saveSettings();
  });
  el.hydeModel.addEventListener("change", () => {
    if (isAllowedModel(el.hydeModel.value)) { settings.hyde_model = el.hydeModel.value; saveSettings(); }
  });
  el.summaryModel.addEventListener("change", () => {
    if (isAllowedModel(el.summaryModel.value)) { settings.summary_model = el.summaryModel.value; saveSettings(); }
  });
  el.settingsBtn.addEventListener("click", () => {
    const open = el.settings.classList.toggle("hidden");
    el.settingsBtn.setAttribute("aria-expanded", String(!open));
    el.settingsBtn.classList.toggle("is-active", !open);
  });
}

// ─── stats / db pill ─────────────────────────────────────────────────────────

let _lastStats = null;

async function refreshStats() {
  try {
    const r = await fetch("/api/stats", { headers: { accept: "application/json" } });
    const j = await r.json();
    _lastStats = j;
    // Строка статистики в меню — дословно как buildMenuText в боте.
    if (!j.warming_up && Number.isFinite(Number(j.qdrant_acts))) {
      el.menuStats.innerHTML = `База пополняется. Сейчас в поиске <b>${fmtNum(j.qdrant_acts)}</b> судебных актов.`;
      el.menuStats.classList.remove("hidden");
    } else {
      el.menuStats.classList.add("hidden");
    }
  } catch {
    _lastStats = null;
    el.menuStats.classList.add("hidden");
  }
}

// Статус базы — formatStats из бота.
function renderStatus() {
  const s = _lastStats;
  if (!s) { el.statusBody.textContent = "Статистика недоступна, попробуйте позже."; return; }
  if (s.warming_up) { el.statusBody.textContent = "⏳ Статистика обновляется, попробуйте через минуту."; return; }
  el.statusBody.innerHTML = [
    `🔗 Собрано ссылок: <b>${fmtNum(s.total_links)}</b>`,
    `✅ Валидных ссылок: <b>${fmtNum(s.valid_links)}</b>`,
    `📄 Скачано текстов: <b>${fmtNum(s.downloaded_acts)}</b> · ${fmtPct(s.downloaded_pct_of_valid)}`,
    `🪄 В векторной базе: <b>${fmtNum(s.qdrant_acts)}</b> · ${fmtPct(s.qdrant_pct_of_downloaded)}`,
    `🕒 Обновлено: ${formatAgo(s.age_ms)} назад`,
  ].map((l) => `<div class="statbox__row">${l}</div>`).join("");
}

// ─── progress (live SSE stages) ──────────────────────────────────────────────

function buildStages() {
  const stages = [];
  if (settings.use_hyde)    stages.push({ id: "hyde",    ico: "🪄", label: "LLM подготавливает запрос" });
  stages.push({ id: "search", ico: "🔎", label: "Ищу по базе судебных актов" });
  if (settings.use_summary) stages.push({ id: "summary", ico: "⚖️", label: "LLM анализирует тексты найденных актов" });
  return stages;
}

let _progressTimer = null, _progressStart = 0;

function renderProgress(stages) {
  _progressStart = Date.now();
  el.progress.classList.remove("hidden");
  el.progress.innerHTML =
    `<div class="progress__head">
       <span class="progress__title"><span class="spinner"></span> Идёт поиск</span>
       <span class="progress__timer" id="progTimer">0 сек</span>
     </div>` +
    stages.map((s) =>
      `<div class="stage" data-stage="${s.id}">
         <span class="stage__ico">${s.ico}</span>
         <span class="stage__label">${escapeHtml(s.label)}</span>
       </div>`).join("");
  clearInterval(_progressTimer);
  _progressTimer = setInterval(() => {
    const t = $("#progTimer");
    if (t) t.textContent = fmtElapsed(Date.now() - _progressStart);
  }, 500);
}

function setStage(id, state) {
  const order = [...el.progress.querySelectorAll(".stage")];
  const idx = order.findIndex((n) => n.dataset.stage === id);
  if (idx === -1) return;
  if (state === "active") {
    order.forEach((n, i) => {
      n.classList.remove("is-active");
      if (i < idx) { n.classList.add("is-done"); }
    });
    order[idx].classList.remove("is-done");
    order[idx].classList.add("is-active");
  } else if (state === "done") {
    order[idx].classList.remove("is-active");
    order[idx].classList.add("is-done");
  }
}

function stopProgress() {
  clearInterval(_progressTimer);
  _progressTimer = null;
  el.progress.classList.add("hidden");
  el.progress.innerHTML = "";
}

function onStage(name) {
  switch (name) {
    case "hyde_start":    setStage("hyde", "active"); break;
    case "hyde_done":     setStage("hyde", "done"); break;
    case "search_start":  setStage("hyde", "done"); setStage("search", "active"); break;
    case "search_done":   setStage("search", "done"); break;
    case "summary_start": setStage("search", "done"); setStage("summary", "active"); break;
    case "summary_done":
    case "summary_skipped": setStage("summary", "done"); break;
  }
}

// ─── SSE search ──────────────────────────────────────────────────────────────

function parseSseBlock(block) {
  let name = "message";
  const dataLines = [];
  for (const line of block.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    const value = colon === -1 ? "" : line.slice(colon + 1).replace(/^ /, "");
    if (field === "event") name = value;
    else if (field === "data") dataLines.push(value);
  }
  if (!dataLines.length) return null;
  try { return { name, data: JSON.parse(dataLines.join("\n")) }; }
  catch { return null; }
}

let _activeAbort = null;

async function streamSearch(query, onEvent) {
  const ac = new AbortController();
  _activeAbort = ac;
  const payload = {
    query,
    topN:          settings.topN,
    use_hyde:      settings.use_hyde,
    use_summary:   settings.use_summary,
    hyde_model:    settings.hyde_model,
    summary_model: settings.summary_model,
    summary_top_n: settings.summary_top_n,
  };
  const res = await fetch("/api/search/stream", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "text/event-stream" },
    body: JSON.stringify(payload),
    signal: ac.signal,
  });
  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    throw new Error(`HTTP ${res.status}: ${txt.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", finalResult = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, "\n");
    let idx;
    while ((idx = buf.indexOf("\n\n")) !== -1) {
      const block = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      const evt = parseSseBlock(block);
      if (!evt) continue;
      if (evt.name === "result") { finalResult = evt.data; continue; }
      if (evt.name === "done") continue;
      if (evt.name === "error") {
        const e = new Error(evt.data?.message || "ошибка пайплайна");
        e.stage = evt.data?.stage;
        throw e;
      }
      onEvent(evt.name, evt.data);
    }
  }
  if (!finalResult) throw new Error("стрим завершился без результата");
  if (!finalResult.ok) throw new Error(finalResult.error || "поиск не удался");
  return finalResult;
}

// ─── render results ──────────────────────────────────────────────────────────

function verdictTag(action, keep) {
  if (!action) return "";
  const v = VERDICT_LABELS[String(action).toLowerCase()];
  const notFinal = keep === false ? `<span class="tag tag--notfinal">не финал</span>` : "";
  if (!v) return `<span class="tag">${escapeHtml(action)}</span>${notFinal}`;
  return `<span class="tag ${v.cls}">${v.ico} ${v.text}</span>${notFinal}`;
}

function actCard(r, i) {
  const court = escapeHtml(r.court || "Суд не указан");
  const date = escapeHtml(r.registration_date || "—");
  const caseNumber = escapeHtml(r.case_number || "—");
  const inst = INSTANCE_LABELS[Number(r.true_instance_level)];
  const tags = [`<span class="tag">📅 ${date}</span>`];
  if (inst) tags.push(`<span class="tag">🏛 ${escapeHtml(inst)}</span>`);
  const vt = verdictTag(r.verdict_action, r.verdict_keep);
  if (vt) tags.push(vt);

  const links = [];
  if (r.pdf_link) {
    links.push(`<a class="act__link" href="${escapeHtml(r.pdf_link)}" target="_blank" rel="noopener noreferrer">🔗 Открыть PDF</a>`);
  }
  const kad = kadCardUrl(r.case_id);
  if (kad) links.push(`<a class="act__link" href="${escapeHtml(kad)}" target="_blank" rel="noopener noreferrer">🗂 Карточка дела</a>`);

  return `<div class="act">
    <div class="act__rank">${i}</div>
    <div class="act__main">
      <p class="act__court">⚖️ ${court}</p>
      <p class="act__case">Дело: <b>${caseNumber}</b></p>
      <div class="act__meta">${tags.join("")}</div>
      <div class="act__links">${links.join("")}</div>
    </div>
  </div>`;
}

function summaryCard(resp) {
  const s = resp.summary;
  if (!s || !s.used || !s.text) return "";
  const meta = [];
  if (s.model_version || s.model) meta.push(`модель: ${escapeHtml(s.model_version || s.model)}`);
  if (Number.isFinite(s.acts_used)) meta.push(`актов в анализе: ${s.acts_used}`);
  if (Number.isFinite(s.elapsed_ms)) meta.push(`${(s.elapsed_ms / 1000).toFixed(1)} сек`);
  return `<div class="card summary">
    <div class="summary__head">📋 Краткий вывод по практике</div>
    <div class="summary__body">${renderMarkdown(s.text)}</div>
    ${meta.length ? `<div class="summary__foot">${meta.map((m) => `<span>${m}</span>`).join("")}<span>⚠️ проверяйте по текстам актов</span></div>` : ""}
  </div>`;
}

function logDetails(resp) {
  const parts = [];
  const h = resp.hyde;
  if (h && h.used && h.text) {
    const meta = [];
    if (h.model_version || h.model) meta.push(`модель: ${escapeHtml(h.model_version || h.model)}`);
    if (Number.isFinite(h.chars)) meta.push(`${h.chars} символов`);
    if (Number.isFinite(h.elapsed_ms)) meta.push(`${(h.elapsed_ms / 1000).toFixed(1)} сек`);
    parts.push(`<details class="log">
      <summary>📝 Как HyDE переписал запрос</summary>
      <div class="log__body">
        <div class="log__meta">${meta.map((m) => `<span>${m}</span>`).join("")}</div>
        <div class="log__text">${escapeHtml(h.text)}</div>
      </div>
    </details>`);
  }
  const s = resp.summary;
  if (s && s.used && s.text) {
    parts.push(`<details class="log">
      <summary>📋 Текст Summary (полностью)</summary>
      <div class="log__body">
        <div class="log__text">${escapeHtml(s.text)}</div>
      </div>
    </details>`);
  }
  return parts.length ? `<div class="logbox">${parts.join("")}</div>` : "";
}

function renderResults(resp) {
  const results = Array.isArray(resp.results) ? resp.results : [];
  if (!results.length) {
    el.results.innerHTML = `<div class="note">
      <span class="note__icon">🔍</span>
      По вашему запросу ничего не нашлось. Попробуйте переформулировать или добавить деталей
      (стороны спора, документы, нужный исход).
    </div>`;
    el.results.scrollIntoView({ behavior: "smooth", block: "start" });
    return;
  }
  const head = `<div class="results__head">
    <span class="results__count">Найдено актов: ${results.length}</span>
    <span class="results__meta">за ${fmtElapsed(resp.elapsed_ms || 0)}${resp.hyde?.used ? " · HyDE вкл" : ""}</span>
  </div>`;
  const cards = `<div class="card">${results.map((r, i) => actCard(r, i + 1)).join("")}</div>`;
  el.results.innerHTML = head + summaryCard(resp) + cards + logDetails(resp);
  el.results.scrollIntoView({ behavior: "smooth", block: "start" });
}

function renderError(msg) {
  el.results.innerHTML = `<div class="note note--error">
    <span class="note__icon">⚠️</span>
    Не удалось выполнить поиск: ${escapeHtml(msg)}.<br>Попробуйте ещё раз через несколько секунд.
  </div>`;
}

// ─── search flow ─────────────────────────────────────────────────────────────

let _searching = false;

async function doSearch() {
  if (_searching) return;
  const query = el.query.value.trim();
  if (query.length < 3) { toast("Опишите ситуацию подробнее (минимум несколько слов)."); el.query.focus(); return; }
  if (query.length > 2000) { toast("Запрос слишком длинный (максимум 2000 символов)."); return; }

  _searching = true;
  el.searchBtn.disabled = true;
  el.searchBtn.textContent = "Идёт поиск…";
  el.results.innerHTML = "";
  renderProgress(buildStages());

  try {
    const resp = await streamSearch(query, (name) => onStage(name));
    stopProgress();
    renderResults(resp);
  } catch (e) {
    stopProgress();
    if (e?.name === "AbortError") { /* отменено пользователем */ }
    else renderError(e?.message || String(e));
  } finally {
    _searching = false;
    _activeAbort = null;
    el.searchBtn.disabled = false;
    el.searchBtn.textContent = "🔎 Искать";
  }
}

// ─── voice (MediaRecorder → /api/transcribe) ─────────────────────────────────

let _mediaRecorder = null, _voiceChunks = [], _voiceStream = null;
let _voiceTimerId = null, _voiceStart = 0;

function abToBase64(ab) {
  const bytes = new Uint8Array(ab);
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

async function startVoice() {
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
    toast("Голосовой ввод недоступен в этом браузере.");
    return;
  }
  try {
    _voiceStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch {
    toast("Не удалось получить доступ к микрофону.");
    return;
  }
  _voiceChunks = [];
  _mediaRecorder = new MediaRecorder(_voiceStream);
  _mediaRecorder.ondataavailable = (e) => { if (e.data && e.data.size) _voiceChunks.push(e.data); };
  _mediaRecorder.onstop = onVoiceStop;
  _mediaRecorder.start();

  el.voiceBar.classList.remove("hidden");
  el.voiceBtn.classList.add("is-active");
  _voiceStart = Date.now();
  el.voiceTimer.textContent = "0:00";
  clearInterval(_voiceTimerId);
  _voiceTimerId = setInterval(() => {
    const s = Math.floor((Date.now() - _voiceStart) / 1000);
    el.voiceTimer.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    if (s >= 120) stopVoice(); // safety cap 2 мин
  }, 250);
}

function teardownVoiceUi() {
  clearInterval(_voiceTimerId); _voiceTimerId = null;
  el.voiceBar.classList.add("hidden");
  el.voiceBtn.classList.remove("is-active");
}

function stopVoice() {
  if (_mediaRecorder && _mediaRecorder.state !== "inactive") _mediaRecorder.stop();
  teardownVoiceUi();
}

function cancelVoice() {
  if (_mediaRecorder) _mediaRecorder.onstop = null;
  if (_mediaRecorder && _mediaRecorder.state !== "inactive") _mediaRecorder.stop();
  if (_voiceStream) _voiceStream.getTracks().forEach((t) => t.stop());
  _voiceStream = null; _mediaRecorder = null; _voiceChunks = [];
  teardownVoiceUi();
}

async function onVoiceStop() {
  if (_voiceStream) _voiceStream.getTracks().forEach((t) => t.stop());
  _voiceStream = null;
  const blob = new Blob(_voiceChunks, { type: _voiceChunks[0]?.type || "audio/webm" });
  _voiceChunks = [];
  if (!blob.size) { toast("Пустая запись."); return; }
  el.voiceBtn.disabled = true;
  el.voiceBtn.textContent = "⏳ Распознаю…";
  try {
    const ab = await blob.arrayBuffer();
    const r = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ audio_base64: abToBase64(ab) }),
    });
    const j = await r.json();
    const text = (j?.text || "").trim();
    if (!text) throw new Error(j?.detail || j?.error || "пустой результат");
    el.query.value = text;
    el.query.dispatchEvent(new Event("input"));
    el.query.focus();
    toast("Распознано — проверьте текст и нажмите «Искать».", "ok");
  } catch (e) {
    toast("Не удалось распознать голос: " + (e?.message || e));
  } finally {
    el.voiceBtn.disabled = false;
    el.voiceBtn.textContent = "🎤 Голос";
  }
}

// ─── modals ──────────────────────────────────────────────────────────────────

function openModal(name) {
  if (name === "status") renderStatus();
  const m = document.getElementById("modal-" + name);
  if (m) m.classList.remove("hidden");
}
function closeModals() {
  document.querySelectorAll(".modal").forEach((m) => m.classList.add("hidden"));
}

// ─── init ────────────────────────────────────────────────────────────────────

function init() {
  populateModelSelects();
  syncSettingsUI();
  wireSettings();

  // char counter
  const updateCount = () => { el.charCount.textContent = `${el.query.value.length} / 2000`; };
  el.query.addEventListener("input", updateCount);
  updateCount();

  // search
  el.searchBtn.addEventListener("click", doSearch);
  el.query.addEventListener("keydown", (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "Enter") { e.preventDefault(); doSearch(); }
  });

  // example (как /test в боте — подставляет пример и запускает поиск)
  el.exampleQuery.textContent = TEST_QUERY;
  el.exampleBtn.addEventListener("click", () => {
    el.query.value = TEST_QUERY;
    el.query.dispatchEvent(new Event("input"));
    doSearch();
  });

  // voice
  el.voiceBtn.addEventListener("click", () => {
    if (_mediaRecorder && _mediaRecorder.state === "recording") stopVoice();
    else startVoice();
  });
  el.voiceStopBtn.addEventListener("click", stopVoice);
  el.voiceCancelBtn.addEventListener("click", cancelVoice);

  // modals
  document.querySelectorAll("[data-modal]").forEach((b) =>
    b.addEventListener("click", () => openModal(b.dataset.modal)));
  document.querySelectorAll("[data-close]").forEach((b) =>
    b.addEventListener("click", closeModals));
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeModals(); });

  // stats
  refreshStats();
  setInterval(refreshStats, 60_000);
}

document.addEventListener("DOMContentLoaded", init);
