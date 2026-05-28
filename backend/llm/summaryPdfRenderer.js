// llm/summaryPdfRenderer.js — рендер grounded-summary в PDF.
//
// Gemini возвращает summary в markdown'е (заголовки, жирный, списки). В
// Telegram чанками текста это смотрится позорно: 4096-cap режет посередине
// абзаца, разметка перестаёт парситься. Решение — выпускать саммари как PDF
// document: marked → HTML с inline CSS → Playwright Chromium → page.pdf().
//
// Использование (в боте):
//   const buf = await renderSummaryToPdf({ query, summary });
//   await tgSendDocument(chatId, buf, "summary.pdf", caption);
//
// Playwright уже стоит как dep (parser.js), Chromium установлен. Браузер
// поднимается на каждый рендер — startup-overhead ~1.5с приемлем, для
// низкого RPS (тг-бот) держать persistent browser сложнее чем стоит.

import { chromium } from "playwright";
import { marked } from "marked";

// HTML escape для значений, которые мы сами вставляем в шапку. Тело саммари
// прогоняется через marked и НЕ требует ручного escape — marked сам всё чистит.
function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// marked настройки: gfm для таблиц/чек-боксов, breaks=false (одиночный \n не
// превращается в <br>, как в обычном markdown), без xhtml-self-close.
marked.setOptions({
  gfm: true,
  breaks: false,
  pedantic: false,
});

const CSS = `
  @page { size: A4; margin: 22mm 20mm 22mm 22mm; }
  * { box-sizing: border-box; }
  body {
    font-family: "Times New Roman", "Liberation Serif", Georgia, serif;
    font-size: 11.5pt;
    line-height: 1.55;
    color: #1a1a1a;
    margin: 0;
    padding: 0;
  }
  h1.doc-title {
    font-size: 18pt;
    font-weight: 700;
    margin: 0 0 4pt 0;
    color: #14202b;
    letter-spacing: 0.3pt;
  }
  .doc-subtitle {
    font-size: 9.5pt;
    color: #5a6573;
    margin: 0 0 14pt 0;
    font-style: italic;
  }
  .meta-block {
    border: 0.5pt solid #c8d0d8;
    background: #f7f9fb;
    border-radius: 3pt;
    padding: 8pt 10pt;
    margin: 0 0 16pt 0;
    font-size: 9.5pt;
    color: #2c3e50;
    line-height: 1.45;
    /* Два явных столбца: лейбл (узкая фикс. колонка) | значение (растяжимое).
       Раньше label был inline-block с min-width — длинные значения «съезжали»
       и колонки переставали выравниваться. CSS grid решает это однозначно. */
    display: grid;
    grid-template-columns: 130pt 1fr;
    grid-column-gap: 10pt;
    grid-row-gap: 3pt;
  }
  .meta-block .label { color: #6b7785; font-weight: 600; }
  .meta-block .value { color: #1a1a1a; word-break: break-word; }
  .meta-block code  { font-family: "Courier New", "Liberation Mono", monospace; font-size: 9.5pt; color: #1a1a1a; }
  .meta-block .value.query { font-style: italic; }
  hr.sep { border: none; border-top: 0.5pt solid #c8d0d8; margin: 12pt 0; }
  .body { text-align: justify; }
  .body h1, .body h2, .body h3, .body h4 { color: #14202b; line-height: 1.25; }
  .body h1 { font-size: 15pt; margin: 18pt 0 6pt; border-bottom: 1pt solid #c8d0d8; padding-bottom: 2pt; }
  .body h2 { font-size: 13pt; margin: 16pt 0 6pt; }
  .body h3 { font-size: 12pt; margin: 14pt 0 4pt; }
  .body h4 { font-size: 11pt; margin: 12pt 0 4pt; font-weight: 600; }
  .body p { margin: 0 0 8pt 0; }
  .body ul, .body ol { margin: 4pt 0 10pt 22pt; padding: 0; }
  .body li { margin: 3pt 0; }
  .body strong { font-weight: 700; color: #14202b; }
  .body em { font-style: italic; }
  .body blockquote {
    margin: 8pt 0 8pt 0;
    padding: 4pt 0 4pt 10pt;
    border-left: 2pt solid #6b7785;
    color: #3a4555;
    font-style: italic;
  }
  .body code {
    font-family: "Courier New", "Liberation Mono", monospace;
    font-size: 10pt;
    background: #f3f4f6;
    padding: 1pt 4pt;
    border-radius: 2pt;
  }
  .body pre {
    background: #f3f4f6;
    border: 0.5pt solid #d7dde3;
    padding: 6pt 8pt;
    border-radius: 3pt;
    font-size: 9.5pt;
    overflow-wrap: break-word;
    white-space: pre-wrap;
  }
  .body table {
    border-collapse: collapse;
    width: 100%;
    margin: 8pt 0;
    font-size: 10.5pt;
  }
  .body th, .body td {
    border: 0.4pt solid #c8d0d8;
    padding: 4pt 6pt;
    text-align: left;
    vertical-align: top;
  }
  .body th { background: #eef2f6; font-weight: 700; }
  .body hr {
    border: none;
    border-top: 0.5pt solid #c8d0d8;
    margin: 10pt 0;
  }
  .footer {
    margin-top: 18pt;
    padding-top: 6pt;
    border-top: 0.3pt solid #d7dde3;
    font-size: 8.5pt;
    color: #8a95a3;
    font-style: italic;
    text-align: center;
  }
  /* Случайные emoji/иконки от Gemini рендерим в Symbola-ish дефолтном фоллбэке —
     ничего отдельно не подключаем, и так читается. */

  .refs-block { margin-top: 20pt; }
  .refs-block h2 {
    font-size: 13pt;
    margin: 0 0 8pt 0;
    color: #14202b;
    border-bottom: 1pt solid #c8d0d8;
    padding-bottom: 3pt;
  }
  /* Две именованные группы: акты в саммари (зелёный «положительный» акцент) и
     остальные (нейтрально-серый). Цвет несёт смысл «эта пачка попала в LLM
     vs эта нет», без него юзеру приходилось бы вычитывать номера. */
  .refs-section { margin: 10pt 0 0 0; }
  .refs-section .section-title {
    font-size: 11pt;
    font-weight: 700;
    margin: 0 0 6pt 0;
    padding: 4pt 8pt;
    border-radius: 2pt;
  }
  .refs-section.in-summary .section-title {
    color: #15532b;
    background: #e6f2ea;
    border-left: 3pt solid #2f8a4a;
  }
  .refs-section.not-in-summary .section-title {
    color: #4a5560;
    background: #eef0f3;
    border-left: 3pt solid #8a95a3;
  }
  .ref-item {
    padding: 6pt 0 6pt 0;
    border-bottom: 0.3pt dashed #d7dde3;
    font-size: 10.5pt;
    line-height: 1.4;
    page-break-inside: avoid;
  }
  .ref-item.in-summary { background: #f3f9f5; padding-left: 8pt; padding-right: 8pt; border-radius: 2pt; }
  .ref-item .head { font-weight: 700; color: #14202b; margin-bottom: 2pt; }
  .ref-item .case { font-weight: 600; }
  .ref-item .meta { color: #4a5560; font-size: 10pt; margin: 1pt 0; }
  .ref-item .type { color: #5a6573; font-style: italic; font-size: 9.5pt; margin: 1pt 0; }
  .ref-item .links { margin-top: 3pt; font-size: 10pt; }
  .ref-item .links a {
    color: #1a4d80;
    text-decoration: none;
    margin-right: 14pt;
  }
  .ref-item .links a:hover { text-decoration: underline; }
`;

const VERDICT_PLAIN = {
  grant:   "удовлетворено",
  deny:    "отказ",
  partial: "частично",
};
const INSTANCE_PLAIN = {
  1: "1-я инст.",
  2: "апелляция",
  3: "кассация",
};

function plainVerdict(action) {
  if (!action) return null;
  return VERDICT_PLAIN[String(action).toLowerCase()] || String(action);
}

function plainInstance(il) {
  if (il === null || il === undefined) return null;
  return INSTANCE_PLAIN[Number(il)] || `инст. ${il}`;
}

function caseCardUrl(caseId) {
  if (!caseId || typeof caseId !== "string") return null;
  if (!/^[0-9a-f-]{36}$/i.test(caseId.trim())) return null;
  return `https://kad.arbitr.ru/Card/${caseId.trim()}`;
}

// Рендерит одну запись акта в HTML-блок: суд, дело, дата/инстанция/исход,
// ссылки на PDF и карточку дела. type_name («Решения и постановления») не
// показываем — у 99% записей это одна и та же umbrella-категория RAS, поле
// зашумляет карточку. То же решение принято для Telegram-карточки.
function renderActRef(r, idx1Based, inSummary) {
  const court    = escapeHtml(r.court || "?");
  const num      = escapeHtml(r.case_number || "?");
  const date     = escapeHtml(r.registration_date || "?");
  const instance = plainInstance(r.true_instance_level);
  const verdict  = plainVerdict(r.verdict_action);
  const notFinal = r.verdict_keep === false ? " (не финал)" : "";

  const metaParts = [date];
  if (instance) metaParts.push(escapeHtml(instance));
  if (verdict)  metaParts.push(escapeHtml(verdict + notFinal));
  // tokens_jina_v4 — размер акта в токенах Jina v4 (embedder). Округляем до
  // сотен — точное значение в карточке не нужно, а порядок величины помогает
  // понять, насколько «тяжёлый» документ ушёл в LLM-контекст.
  const tok = Number(r.tokens_jina_v4);
  if (Number.isFinite(tok) && tok > 0) {
    const rounded = Math.round(tok / 100) * 100;
    metaParts.push(escapeHtml(`~${rounded.toLocaleString("ru-RU").replace(/,/g, " ")} токенов`));
  }

  const links = [];
  if (r.pdf_link) {
    links.push(`<a href="${escapeHtml(r.pdf_link)}">Открыть PDF</a>`);
  }
  const kad = caseCardUrl(r.case_id);
  if (kad) {
    links.push(`<a href="${escapeHtml(kad)}">Карточка дела</a>`);
  }

  return `
    <div class="ref-item ${inSummary ? "in-summary" : ""}">
      <div class="head">${idx1Based}) ${court}</div>
      <div class="case">Дело: ${num}</div>
      <div class="meta">${metaParts.join(" · ")}</div>
      ${links.length ? `<div class="links">${links.join("")}</div>` : ""}
    </div>`;
}

// Список топ-N актов из выдачи: первые `summaryActsN` ушли в LLM (секция «в
// саммари», зелёный акцент), остальные — секция «не попали» (серый акцент).
// Сохраняем сквозную нумерацию из результатов поиска (1..N), чтобы юзер
// мог сопоставить номера с тем, что видит в Telegram.
function renderRefsBlock(results, summaryActsN) {
  if (!Array.isArray(results) || results.length === 0) return "";
  const usedN = Math.max(0, Math.min(summaryActsN ?? 0, results.length));

  const usedItems    = [];
  const notUsedItems = [];
  for (let i = 0; i < results.length; i++) {
    const html = renderActRef(results[i], i + 1, i < usedN);
    if (i < usedN) usedItems.push(html);
    else           notUsedItems.push(html);
  }

  const usedSection = usedItems.length
    ? `
      <div class="refs-section in-summary">
        <div class="section-title">📋 Акты, направленные в саммари (${usedItems.length})</div>
        ${usedItems.join("")}
      </div>`
    : "";
  const notUsedSection = notUsedItems.length
    ? `
      <div class="refs-section not-in-summary">
        <div class="section-title">📄 Акты, не попавшие в саммари (${notUsedItems.length})</div>
        ${notUsedItems.join("")}
      </div>`
    : "";

  return `
    <div class="refs-block">
      <h2>Найденные акты</h2>
      ${usedSection}
      ${notUsedSection}
    </div>`;
}

/**
 * @param {object} args
 * @param {string} args.query — исходный запрос пользователя.
 * @param {object} args.summary — поле summary из /search ответа.
 * @param {object} [args.hyde] — поле hyde из /search ответа (used, model,
 *   model_version). Идёт отдельной строкой в шапке PDF.
 * @param {string} [args.searchId] — 12-hex код поиска из ras_pg_logs.searches.
 *   Идёт в верхнюю строку шапки PDF — по нему оператор может поднять полный
 *   ответ /search в логах.
 * @param {Array<object>} [args.results] — полный список актов из /search (все
 *   top-N). Будут отрендерены ссылочным блоком в конце PDF, с пометкой, какие
 *   из них реально пошли в LLM.
 * @param {number} [args.summaryActsN] — сколько первых актов из `results`
 *   ушло в LLM. По умолчанию берём `summary.acts_used` либо `results.length`.
 * @param {object} [args.options]
 * @param {number} [args.options.timeoutMs] — таймаут запуска браузера.
 * @returns {Promise<Buffer>} — PDF буфер.
 */
export async function renderSummaryToPdf({ query, summary, hyde, searchId, results, summaryActsN, options = {} }) {
  if (!summary || typeof summary.text !== "string" || !summary.text.trim()) {
    throw new Error("renderSummaryToPdf: summary.text is empty");
  }

  const model = summary.model_version || summary.model || "—";
  const actsUsed = summary.acts_used ?? "—";
  const elapsedSec = summary.elapsed_ms != null
    ? (summary.elapsed_ms / 1000).toFixed(1)
    : "—";
  // Сплитим токены на вход/выход — нужно для калькуляции стоимости генерации
  // (price на input ≠ price на output у всех Gemini-моделей). Thinking-токены
  // у Gemini считаются как output → не выделяем их отдельно.
  const inTokens    = summary?.usage?.prompt_tokens;
  const outTokens   = summary?.usage?.candidates_tokens;
  const totalTokens = summary?.usage?.total_tokens;
  const fmtTok = (n) => Number.isFinite(Number(n))
    ? Number(n).toLocaleString("ru-RU").replace(/,/g, " ")
    : "—";
  const tokensLine = (Number.isFinite(Number(inTokens)) || Number.isFinite(Number(outTokens)))
    ? `${fmtTok(inTokens)} вход + ${fmtTok(outTokens)} выход`
    : (Number.isFinite(Number(totalTokens)) ? `${fmtTok(totalTokens)} токенов` : "—");

  // HyDE: если был применён — показываем модель (model_version фактический);
  // если выключен — явная пометка «нет», чтобы читатель PDF понимал, что поиск
  // шёл по сырому запросу.
  const hydeUsed     = !!hyde?.used;
  const hydeModelStr = hydeUsed
    ? (hyde?.model_version || hyde?.model || "—")
    : null;

  // marked НЕ экранирует уже валидный HTML внутри markdown'а, но Gemini
  // обычно выдаёт чистый md без html-вкраплений. На всякий вырубаем
  // потенциально опасный sanitize в постпроцессе через marked.parse не нужен
  // (мы рендерим в headless chromium для печати — XSS невозможен).
  const bodyHtml = marked.parse(summary.text);

  // Шапка — двухколоночный grid: «лейбл | значение». Каждый row — отдельный
  // .label + .value, CSS grid сам выравнивает столбцы. Поле «Дата» — реальная
  // дата генерации отчёта в локальной TZ контейнера (dd.MM.yyyy), чтобы PDF,
  // отправленный в чат, был самодостаточен без оглядки на timestamp сообщения.
  const now = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  const dateStr = `${pad(now.getDate())}.${pad(now.getMonth() + 1)}.${now.getFullYear()}`;

  const rows = [];
  rows.push(`<div class="label">Дата:</div><div class="value">${escapeHtml(dateStr)}</div>`);
  if (searchId) {
    rows.push(`<div class="label">Поиск ID:</div><div class="value"><code>${escapeHtml(searchId)}</code></div>`);
  }
  if (hydeUsed) {
    rows.push(`<div class="label">HyDE:</div><div class="value">✓ применён · модель <code>${escapeHtml(hydeModelStr)}</code></div>`);
  } else if (hyde) {
    rows.push(`<div class="label">HyDE:</div><div class="value">— не применялся, поиск по исходному запросу</div>`);
  }
  rows.push(`<div class="label">Модель Summary:</div><div class="value"><code>${escapeHtml(model)}</code></div>`);
  rows.push(`<div class="label">Актов в анализе:</div><div class="value">${escapeHtml(String(actsUsed))}</div>`);
  rows.push(`<div class="label">Время генерации Summary:</div><div class="value">${escapeHtml(elapsedSec)} сек · ${escapeHtml(tokensLine)}</div>`);
  rows.push(`<div class="label">Запрос:</div><div class="value query">${escapeHtml(query || "")}</div>`);

  // Кол-во актов, попавших в LLM. Дефолтим к summary.acts_used, потом к длине
  // results — оба варианта были у вызывающего кода раньше.
  const usedN = Number.isFinite(Number(summaryActsN))
    ? Number(summaryActsN)
    : (Number.isFinite(Number(summary.acts_used)) ? Number(summary.acts_used) : (results?.length ?? 0));
  const refsHtml = renderRefsBlock(results || [], usedN);

  const html = `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>RAS Search — Supply · ${escapeHtml(searchId || "summary")}</title>
<style>${CSS}</style>
</head>
<body>
  <div class="meta-block">
    ${rows.join("\n    ")}
  </div>

  <hr class="sep" />

  <div class="body">${bodyHtml}</div>

  ${refsHtml}

  <div class="footer">
    Документ сгенерирован автоматически системой ras-parser RAG.
    Содержит выжимку из ${escapeHtml(String(actsUsed))} актов арбитражной практики
    и не является официальной правовой консультацией.
  </div>
</body>
</html>`;

  const browser = await chromium.launch({ headless: true, timeout: options.timeoutMs ?? 30_000 });
  try {
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    // load=domcontentloaded достаточно: нет внешних ресурсов, всё inline.
    await page.setContent(html, { waitUntil: "domcontentloaded" });
    const pdf = await page.pdf({
      format: "A4",
      printBackground: true,
      preferCSSPageSize: true,
      margin: { top: "22mm", bottom: "22mm", left: "22mm", right: "20mm" },
    });
    return pdf;
  } finally {
    try { await browser.close(); } catch {}
  }
}

export const __test = { CSS, escapeHtml };
