/**
 * backend/search/doczilla-facade.js — Doczilla-compatible API facade поверх
 * RAS Search — Supply.
 *
 * Зачем: внешним интеграторам, которые уже умеют ходить в Doczilla API
 * (https://help.doczilla.pro/articles/knowledge_base/api/q/api/qid/8135/qp/1),
 * хочется работать с RAS Search — Supply через знакомую сурфейс-модель
 * document/docz. Мы — НЕ конструктор документов; мы тонкий адаптер:
 * "Doczilla docz" = один поисковый отчёт. Все document-doc-методы
 * (move/copy/recycle/edit/...) — NO-OP с 501-stub'ом, потому что не
 * соответствуют сути сервиса.
 *
 * Маппинг сущностей:
 *   Doczilla template = шаблон отчёта (для MVP единственный: ras_supply_search)
 *   Doczilla docz     = одна search_reports-запись (db/search_reports_schema.sql)
 *   structureRead     = схема "анкеты" (какие поля принимает fillDocz)
 *   createDocz        = INSERT search_reports (status='created')
 *   fillDocz          = UPDATE answers + запуск runSearchPipeline + сохранение
 *   getById           = SELECT search_reports
 *   get               = SELECT search_reports + рендер в json|html (docx/pdf → 501)
 *
 * Endpoint prefix: /doczilla-api/*
 * Mount: search-api.js диспатчит сюда, если url.pathname.startsWith("/doczilla-api/").
 *
 * Контракт ответов:
 *   success: { "success": true, "data": {...} }
 *   error:   { "success": false, "error": "stable_code", "message": "human" }
 *
 * HTTP коды:
 *   200 success
 *   400 bad_request
 *   401 unauthorized
 *   404 not_found
 *   405 method_not_allowed
 *   409 report_not_completed
 *   501 not_implemented
 *   500 internal_error
 *
 * Стабильные error codes:
 *   bad_request, unauthorized, not_found, report_not_completed,
 *   not_implemented, internal_error, method_not_allowed, unsupported_template
 */

import crypto from "node:crypto";

import {
  runSearchPipeline,
  clampTopN,
  HYDE_ENABLED,
} from "./searchPipeline.js";
import {
  createReport,
  getReport,
  markRunning,
  markCompleted,
  markError,
  recoverStaleRunning,
} from "../db/searchReportsRepo.js";
import { logSearch } from "../db/pgLogsClient.js";

const PRODUCT_NAME = "RAS Search — Supply";
const TEMPLATE_ID  = "ras_supply_search";

// Compatibility-stub auth: если задан DOCZILLA_API_TOKEN, login проверяет
// apiKey против него (constant-time compare). Если нет — любой login проходит
// (dev-mode), при старте печатается warning. Это НЕ production auth и НЕ
// заменяет реальную авторизацию — facade-роуты НЕ проверяют токен ни в каком
// последующем запросе (createDocz/fillDocz/get).
const DOCZILLA_API_TOKEN = process.env.DOCZILLA_API_TOKEN || null;

// Recovery cleanup: на старте процесса помечать как 'error' отчёты, которые
// застряли в 'running' дольше N минут (предыдущий процесс упал посередине
// fillDocz). Настраиваемо через env, дефолт 60 минут.
const DOCZILLA_RUNNING_STALE_MINUTES = Number(process.env.DOCZILLA_RUNNING_STALE_MINUTES || 60);

// Doczilla document-методы, которые мы НЕ поддерживаем (документооборот).
// Все возвращают единообразный 501-stub. Источник — обзор Doczilla API:
// https://help.doczilla.pro/articles/knowledge_base/api/q/api/qid/8135/qp/1
// (методы: createDocz, fillDocz, get, getById, getByLink, set, create, move,
// copy, recycle, restore, share, publish, createVersion, structureRead).
// ВАЖНО: роутер проверяет UNSUPPORTED_DOCUMENT_METHODS ПОСЛЕ известных нам
// методов (createDocz, fillDocz, getById, get, structureRead), поэтому
// "create" в списке не перехватывает "createDocz" — это разные строки после
// path.slice("/doczilla-api/document/".length).
//
// getByLink — Doczilla метод "получить docz по shared-ссылке"; у нас нет share,
// поэтому 501. edit/publicationApply/publicationReject — нет в обзорной
// странице, но держим как страховку, чтобы клиент получил понятный 501,
// а не 404 если дёрнет.
const UNSUPPORTED_DOCUMENT_METHODS = new Set([
  "getByLink",
  "move", "copy", "recycle", "restore", "share",
  "publish", "publicationApply", "publicationReject",
  "edit", "createVersion", "set", "create",
]);

// Doczilla users-методы (отдельная семья URL'ов /doczilla-api/users/*). У RAS
// Search — Supply нет собственной user-системы (login это compatibility stub),
// поэтому вся группа возвращает 501. Источник — тот же обзор Doczilla.
const UNSUPPORTED_USER_METHODS = new Set([
  "create", "copy", "read", "update", "destroy", "export-report", "preview",
]);

// ── Helpers ──────────────────────────────────────────────────────────────────

function log(level, msg, extra) {
  const line = extra
    ? `[doczilla] ${level} ${msg} ${JSON.stringify(extra)}`
    : `[doczilla] ${level} ${msg}`;
  if (level === "ERROR" || level === "WARN") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type":   "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control":  "no-store",
  });
  res.end(payload);
}

function sendHtml(res, status, html) {
  const buf = Buffer.from(html, "utf8");
  res.writeHead(status, {
    "content-type":   "text/html; charset=utf-8",
    "content-length": buf.length,
    "cache-control":  "no-store",
  });
  res.end(buf);
}

function ok(res, data, status = 200) {
  sendJson(res, status, { success: true, data });
}

function err(res, status, code, message, extra = null) {
  const body = { success: false, error: code, message };
  if (extra) body.detail = extra;
  sendJson(res, status, body);
}

async function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error(`body too large (>${limitBytes}B)`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error(`invalid JSON body: ${e.message}`));
      }
    });
    req.on("error", reject);
  });
}

function escapeHtml(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// safeUrl(url) — пропускает только http://… и https://… URL. Защищает HTML
// export от javascript:/data:/file:/vbscript: и прочих опасных схем (rel/href
// XSS), которые escapeHtml не отсекает. Возвращает escaped безопасный URL или
// null. Caller сам решает, рендерить ли ссылку.
function safeUrl(url) {
  if (url === null || url === undefined) return null;
  const s = String(url).trim();
  if (!s) return null;
  let parsed;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  return parsed.toString();
}

// ── Структура анкеты (structureRead) ─────────────────────────────────────────

function buildStructure() {
  return {
    templateId: TEMPLATE_ID,
    name: `${PRODUCT_NAME} — поисковый отчёт по практике договоров поставки`,
    fields: [
      {
        id:          "query",
        type:        "textarea",
        label:       "Запрос юриста",
        description: "Опишите спор словами или вставьте кусок мотивировочной части.",
        required:    true,
        maxLength:   2000,
      },
      {
        id:          "use_hyde",
        type:        "boolean",
        label:       "Включить HyDE-перезапись",
        description: "Перед поиском Gemini переписывает бытовой запрос в стиль судебного акта.",
        required:    false,
        default:     HYDE_ENABLED,
      },
      {
        id:          "use_summary",
        type:        "boolean",
        label:       "Сформировать итоговый ответ",
        description: "Gemini Summary прочитает найденные акты и выдаст краткую сводку с цитатами.",
        required:    false,
        default:     true,
      },
      {
        id:          "top_k",
        type:        "number",
        label:       "Сколько актов вернуть",
        description: "Top-K после reranker. Клампится сервером к допустимому диапазону.",
        required:    false,
        default:     10,
        min:         1,
        max:         20,
      },
      {
        id:          "filters",
        type:        "object",
        label:       "Дополнительные фильтры",
        description: "Зарезервировано для будущих фильтров (instance_level, court, registration_date).",
        required:    false,
        default:     {},
      },
    ],
  };
}

// ── Compact report ───────────────────────────────────────────────────────────

// Compact-only safe view: то, что мы готовы отдавать наружу через get(json) и
// getById. Намеренно НЕ включает:
//   - полный act_text (он и так не попадает: snippet уже compact в pipeline)
//   - env, токены, stack traces, исходный raw_request / raw_response
//   - полный hyde.text / summary.text usage / finish_reason (внутренние LLM
//     метаданные, которые могут утечь промпт-структуру)
function compactActsForExport(acts) {
  if (!Array.isArray(acts)) return [];
  return acts.map((a) => ({
    act_id:              a?.act_id              ?? null,
    case_id:             a?.case_id             ?? null,
    case_number:         a?.case_number         ?? null,
    court:               a?.court               ?? null,
    registration_date:   a?.registration_date   ?? null,
    type_name:           a?.type_name           ?? null,
    true_instance_level: a?.true_instance_level ?? null,
    verdict_keep:        a?.verdict_keep        ?? null,
    verdict_action:      a?.verdict_action      ?? null,
    pdf_link:            a?.pdf_link            ?? null,
    rerank_score:        a?.rerank_score        ?? null,
    rerank_rank:         a?.rerank_rank         ?? null,
    rrf_score:           a?.rrf_score           ?? null,
    rrf_rank:            a?.rrf_rank            ?? null,
    snippet:             a?.snippet             ?? "",
    text_chars:          a?.text_chars          ?? 0,
  }));
}

function buildCompactReport(report) {
  const result   = report.result_json ?? {};
  const acts     = compactActsForExport(result.results ?? []);
  return {
    id:           report.id,
    doczId:       report.id,
    templateId:   report.template_id,
    name:         report.name,
    status:       report.status,
    answers:      report.answers_json ?? null,
    query:        result.query ?? report.answers_json?.query ?? null,
    summary:      report.summary_text ?? null,
    topActs:      acts,
    timings: {
      total_ms:     result.elapsed_ms ?? null,
      retrieval_ms: result.timing?.retrieval_ms ?? null,
      hydrate_ms:   result.timing?.hydrate_ms   ?? null,
      rerank_ms:    result.timing?.rerank_ms    ?? null,
      hyde_ms:      result.hyde?.elapsed_ms     ?? null,
      summary_ms:   result.summary?.elapsed_ms  ?? null,
    },
    hyde: {
      used:          result.hyde?.used          ?? false,
      model_version: result.hyde?.model_version ?? null,
      chars:         result.hyde?.chars         ?? 0,
    },
    rerank: {
      model:  result.rerank?.model  ?? null,
      scored: result.rerank?.scored ?? 0,
    },
    summary_meta: {
      used:          result.summary?.used          ?? false,
      model_version: result.summary?.model_version ?? null,
      chars:         result.summary?.chars         ?? 0,
      acts_used:     result.summary?.acts_used     ?? null,
    },
    search_id:    report.search_id ?? null,
    error:        report.error     ?? null,
    created_at:   report.created_at,
    updated_at:   report.updated_at,
    availableFormats: report.status === "completed" ? ["json", "html"] : [],
  };
}

// ── Handlers ─────────────────────────────────────────────────────────────────

// POST /doczilla-api/login
//
// ⚠ COMPATIBILITY STUB — НЕ production auth. RAS Search — Supply не имеет
// собственной системы пользователей; этот endpoint существует только чтобы
// внешние Doczilla-клиенты, которые делают login → token → call API, не
// падали на первом шаге своего flow.
//
// Поведение:
//   - Если задан env DOCZILLA_API_TOKEN: apiKey сравнивается с ним
//     constant-time. Несовпадение или отсутствие apiKey → 401 unauthorized.
//   - Если DOCZILLA_API_TOKEN не задан: принимаем любой login/password или
//     apiKey (dev-mode), при старте процесса печатается WARN.
//
// Возвращённый token — opaque, нигде не проверяется в последующих запросах
// (createDocz/fillDocz/get НЕ требуют Authorization-заголовка).
// Защита публичных endpoint'ов делается на уровне reverse-proxy/firewall.
function constantTimeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function handleLogin(req, res) {
  if (req.method !== "POST") {
    return err(res, 405, "method_not_allowed", "Use POST");
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return err(res, 400, "bad_request", e.message);
  }
  const apiKey   = typeof body.apiKey   === "string" ? body.apiKey   : null;
  const login    = typeof body.login    === "string" ? body.login    : null;
  const password = typeof body.password === "string" ? body.password : null;

  if (!apiKey && !login && !password) {
    return err(res, 400, "bad_request", "Provide either apiKey or login+password");
  }

  const mode = DOCZILLA_API_TOKEN ? "token-required" : "dev-open";

  if (DOCZILLA_API_TOKEN) {
    if (!apiKey) {
      return err(res, 401, "unauthorized", "DOCZILLA_API_TOKEN required: pass it as 'apiKey'");
    }
    if (!constantTimeEqual(apiKey, DOCZILLA_API_TOKEN)) {
      log("WARN", "login rejected: bad apiKey");
      return err(res, 401, "unauthorized", "Invalid apiKey");
    }
  }

  const seed  = `${apiKey || ""}|${login || ""}|${Date.now()}|${crypto.randomBytes(8).toString("hex")}`;
  const token = crypto.createHash("sha256").update(seed).digest("hex");
  const userId = login
    ? crypto.createHash("md5").update(login).digest("hex").slice(0, 16)
    : crypto.createHash("md5").update(apiKey || "anonymous").digest("hex").slice(0, 16);

  log("INFO", "login", {
    has_api_key: !!apiKey,
    has_login:   !!login,
    user_id:     userId,
    mode,
  });
  ok(res, { token, userId, mode });
}

// GET /doczilla-api/document/structureRead
async function handleStructureRead(req, res, url) {
  if (req.method !== "GET") {
    return err(res, 405, "method_not_allowed", "Use GET");
  }
  const templateId = url.searchParams.get("templateId") || TEMPLATE_ID;
  if (templateId !== TEMPLATE_ID) {
    return err(res, 404, "unsupported_template",
      `Unknown templateId "${templateId}". Supported: ${TEMPLATE_ID}`);
  }
  ok(res, buildStructure());
}

// POST /doczilla-api/document/createDocz
async function handleCreateDocz(req, res) {
  if (req.method !== "POST") {
    return err(res, 405, "method_not_allowed", "Use POST");
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return err(res, 400, "bad_request", e.message);
  }
  const templateId = typeof body.templateId === "string" ? body.templateId : TEMPLATE_ID;
  if (templateId !== TEMPLATE_ID) {
    return err(res, 400, "unsupported_template",
      `Unknown templateId "${templateId}". Supported: ${TEMPLATE_ID}`);
  }
  const name = typeof body.name === "string" ? body.name.slice(0, 500) : null;

  let row;
  try {
    row = await createReport({ templateId, name });
  } catch (e) {
    log("ERROR", "createDocz failed", { msg: e?.message ?? String(e) });
    return err(res, 500, "internal_error", "Failed to create report", e?.message);
  }
  log("INFO", "createDocz", { id: row.id, template_id: row.template_id, name: row.name });
  ok(res, {
    doczId:     row.id,
    id:         row.id,
    templateId: row.template_id,
    name:       row.name,
    status:     row.status,
    created_at: row.created_at,
  });
}

// POST /doczilla-api/document/fillDocz
//
// State machine:
//   1. validate body  → 400 если пусто/некорректно
//   2. getReport(id)  → 404 если нет
//   3. markRunning    → status=running. Если упало здесь → 500, status=created остался.
//   4. runSearchPipeline (HyDE + search + rerank + summary)
//      - throw → markError + 500
//   5. markCompleted  → status=completed
//      - throw → markError("storage_failed:") + 500. КЛИЕНТ НЕ ВИДИТ "completed",
//        пока DB-апдейт не подтверждён.
//   6. ok(res, {... status: "completed", ...})
async function handleFillDocz(req, res) {
  if (req.method !== "POST") {
    return err(res, 405, "method_not_allowed", "Use POST");
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return err(res, 400, "bad_request", e.message);
  }
  const doczId  = body.doczId || body.id;
  const answers = body.answers;
  if (!doczId || typeof doczId !== "string") {
    return err(res, 400, "bad_request", "Missing 'doczId'");
  }
  if (!answers || typeof answers !== "object" || Array.isArray(answers)) {
    return err(res, 400, "bad_request", "Missing or invalid 'answers' (must be object)");
  }
  const query = typeof answers.query === "string" ? answers.query.trim() : "";
  if (!query) {
    return err(res, 400, "bad_request", "Missing or empty 'answers.query'");
  }
  if (query.length > 2000) {
    return err(res, 400, "bad_request", "answers.query too long (>2000 chars)");
  }

  // Проверяем, что отчёт существует. createDocz → fillDocz обязателен.
  let report;
  try {
    report = await getReport(doczId);
  } catch (e) {
    log("ERROR", "fillDocz getReport failed", { docz_id: doczId, msg: e?.message ?? String(e) });
    return err(res, 500, "internal_error", "Failed to read report", e?.message);
  }
  if (!report) {
    return err(res, 404, "not_found", `Report ${doczId} not found`);
  }

  const useHyde       = answers.use_hyde       !== undefined ? !!answers.use_hyde       : HYDE_ENABLED;
  const useSummary    = answers.use_summary    !== undefined ? !!answers.use_summary    : true;
  const topN          = clampTopN(answers.top_k ?? answers.topN ?? 10);
  const hydeModelOpt  = typeof answers.hyde_model    === "string" && answers.hyde_model.trim()    ? answers.hyde_model.trim()    : null;
  const summaryModelOpt = typeof answers.summary_model === "string" && answers.summary_model.trim() ? answers.summary_model.trim() : null;
  let summaryTopN = null;
  if (answers.summary_top_n !== undefined && answers.summary_top_n !== null) {
    const n = Number(answers.summary_top_n);
    if (Number.isFinite(n) && n >= 1) summaryTopN = Math.max(1, Math.min(topN, Math.floor(n)));
  }

  // Step 3: markRunning. Если упало здесь, клиент получает 500 и status
  // отчёта остался 'created' (или прежний 'completed'/'error', если он
  // перезапускался).
  try {
    await markRunning(doczId, answers);
  } catch (e) {
    log("ERROR", "fillDocz markRunning failed", { docz_id: doczId, msg: e?.message ?? String(e) });
    return err(res, 500, "internal_error", "Failed to update report state", e?.message);
  }

  log("INFO", "fillDocz/start", { docz_id: doczId, q_len: query.length, top_n: topN, use_hyde: useHyde, use_summary: useSummary });

  // Abort summary если клиент закрыл коннект.
  const ac = new AbortController();
  const onClose = () => ac.abort(new Error("client closed connection"));
  req.on("close", onClose);

  let pipelineResult;
  try {
    pipelineResult = await runSearchPipeline({
      trimmed:        query,
      topN,
      useHyde,
      useSummary,
      hydeModelOpt,
      summaryModelOpt,
      summaryTopN,
      clientChatId:   null,
      clientUserId:   null,
      clientUsername: `doczilla:${doczId.slice(0, 8)}`,
      rawRequest:     { doczilla: true, doczId, answers },
    }, { abortSignal: ac.signal });
  } catch (e) {
    req.off("close", onClose);
    const msg = e?.message ?? String(e);
    log("ERROR", "fillDocz pipeline failed", { docz_id: doczId, stage: e?.stage, msg });
    try { await markError(doczId, msg); } catch (e2) {
      log("WARN", "fillDocz markError failed", { docz_id: doczId, msg: e2?.message ?? String(e2) });
    }
    return err(res, 500, "internal_error", "Search pipeline failed", msg);
  }
  req.off("close", onClose);

  const summaryText = pipelineResult.responseBody?.summary?.text ?? null;
  const searchId    = pipelineResult.responseBody?.search_id ?? null;

  // Step 5: markCompleted. Если БД упала здесь — pipeline уже отработал, но
  // отчёт остался в 'running'. Помечаем error и отвечаем 500. Клиент НЕ
  // получает status="completed", пока storage не подтвердил запись.
  let completedRow;
  try {
    completedRow = await markCompleted(doczId, {
      resultJson:  pipelineResult.responseBody,
      summaryText,
      searchId,
    });
  } catch (e) {
    const msg = e?.message ?? String(e);
    log("ERROR", "fillDocz markCompleted failed", { docz_id: doczId, msg });
    try { await markError(doczId, `storage_failed: ${msg}`); }
    catch (e2) { log("WARN", "fillDocz markError after storage_failed", { docz_id: doczId, msg: e2?.message ?? String(e2) }); }
    return err(res, 500, "internal_error",
      "Search completed but persisting the report failed; report marked as error",
      msg);
  }

  // Логируем в ras_pg_logs (fire-and-forget; ошибки в stderr).
  try { void logSearch(pipelineResult.logRow); }
  catch (e) { log("WARN", "fillDocz logSearch failed", { msg: e?.message ?? String(e) }); }

  log("INFO", "fillDocz/done", {
    docz_id: doczId,
    search_id: searchId,
    results: pipelineResult.responseBody?.results?.length ?? 0,
    total_ms: pipelineResult.responseBody?.elapsed_ms ?? null,
  });

  // Compact-only response. Полный pipeline-responseBody НЕ отдаём — он есть в
  // result_json в БД, но наружу через facade выходит только compact view.
  ok(res, {
    doczId,
    id:           doczId,
    status:       completedRow?.status ?? "completed",
    templateId:   report.template_id,
    name:         report.name,
    searchId,
    summary:      summaryText,
    topActs:      compactActsForExport(pipelineResult.responseBody?.results ?? []),
    timings: {
      total_ms:     pipelineResult.responseBody?.elapsed_ms ?? null,
      retrieval_ms: pipelineResult.responseBody?.timing?.retrieval_ms ?? null,
      hydrate_ms:   pipelineResult.responseBody?.timing?.hydrate_ms   ?? null,
      rerank_ms:    pipelineResult.responseBody?.timing?.rerank_ms    ?? null,
      hyde_ms:      pipelineResult.responseBody?.hyde?.elapsed_ms     ?? null,
      summary_ms:   pipelineResult.responseBody?.summary?.elapsed_ms  ?? null,
    },
    hyde: {
      used:          pipelineResult.responseBody?.hyde?.used          ?? false,
      model_version: pipelineResult.responseBody?.hyde?.model_version ?? null,
      chars:         pipelineResult.responseBody?.hyde?.chars         ?? 0,
    },
    rerank: {
      model:  pipelineResult.responseBody?.rerank?.model  ?? null,
      scored: pipelineResult.responseBody?.rerank?.scored ?? 0,
    },
  });
}

// GET /doczilla-api/document/getById?id=... | ?doczId=...
async function handleGetById(req, res, url) {
  if (req.method !== "GET") {
    return err(res, 405, "method_not_allowed", "Use GET");
  }
  const id = url.searchParams.get("id") || url.searchParams.get("doczId");
  if (!id) {
    return err(res, 400, "bad_request", "Missing 'id' or 'doczId' query param");
  }
  let report;
  try {
    report = await getReport(id);
  } catch (e) {
    log("ERROR", "getById failed", { id, msg: e?.message ?? String(e) });
    return err(res, 500, "internal_error", "Failed to read report", e?.message);
  }
  if (!report) {
    return err(res, 404, "not_found", `Report ${id} not found`);
  }
  ok(res, buildCompactReport(report));
}

// POST /doczilla-api/document/get { doczId, format: "json"|"html"|"docx"|"pdf" }
async function handleGet(req, res) {
  if (req.method !== "POST") {
    return err(res, 405, "method_not_allowed", "Use POST");
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return err(res, 400, "bad_request", e.message);
  }
  const id     = body.doczId || body.id;
  const format = (typeof body.format === "string" ? body.format : "json").toLowerCase();
  if (!id) {
    return err(res, 400, "bad_request", "Missing 'doczId'");
  }

  let report;
  try {
    report = await getReport(id);
  } catch (e) {
    log("ERROR", "get failed", { id, msg: e?.message ?? String(e) });
    return err(res, 500, "internal_error", "Failed to read report", e?.message);
  }
  if (!report) {
    return err(res, 404, "not_found", `Report ${id} not found`);
  }
  if (report.status !== "completed") {
    return err(res, 409, "report_not_completed",
      `Report is not completed yet (status="${report.status}")`);
  }

  if (format === "json") {
    return ok(res, {
      format: "json",
      report: buildCompactReport(report),
    });
  }
  if (format === "html") {
    const html = renderReportHtml(report);
    return sendHtml(res, 200, html);
  }
  if (format === "docx" || format === "pdf") {
    return err(res, 501, "not_implemented", "Export format is not supported yet", { format });
  }
  return err(res, 400, "bad_request", `Unknown format "${format}". Use json|html|docx|pdf`);
}

// XSS-safe HTML rendering. Все user/LLM-provided поля проходят escapeHtml
// или safeUrl. Summary рендерится как escaped pre-line text (без marked.parse,
// который мог бы выпустить inline <script>/<a href="javascript:…"> и пр.).
function renderReportHtml(report) {
  const result = report.result_json ?? {};
  const acts   = compactActsForExport(result.results ?? []);
  const summary = report.summary_text || "";
  const summaryHtml = summary
    ? `<pre class="summary-text">${escapeHtml(summary)}</pre>`
    : "<p><em>Summary не сгенерирован.</em></p>";
  const query = result.query || report.answers_json?.query || "";
  const name  = report.name || "";
  const createdIso = report.created_at instanceof Date
    ? report.created_at.toISOString()
    : (report.created_at ?? "");

  const actsHtml = acts.map((a, i) => {
    const href = safeUrl(a?.pdf_link);
    return `
    <li class="act">
      <div class="act-head">
        <span class="rank">#${i + 1}</span>
        <strong>${escapeHtml(a?.case_number ?? a?.act_id ?? "")}</strong>
        <span class="court">${escapeHtml(a?.court ?? "")}</span>
        <span class="date">${escapeHtml(a?.registration_date ?? "")}</span>
      </div>
      <div class="meta">
        instance_level=${escapeHtml(String(a?.true_instance_level ?? "-"))}
        verdict_keep=${escapeHtml(String(a?.verdict_keep ?? "-"))}
        verdict_action=${escapeHtml(String(a?.verdict_action ?? "-"))}
        rerank_score=${escapeHtml(String(a?.rerank_score ?? "-"))}
      </div>
      <div class="snippet">${escapeHtml(a?.snippet ?? "")}</div>
      ${href ? `<div class="link"><a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">PDF</a></div>` : ""}
    </li>
  `;
  }).join("");

  return `<!doctype html>
<html lang="ru">
<head>
<meta charset="utf-8">
<title>${escapeHtml(PRODUCT_NAME)} — отчёт ${escapeHtml(report.id)}</title>
<style>
  body { font-family: Georgia, "Times New Roman", serif; max-width: 880px; margin: 24px auto; padding: 0 16px; color: #1a1a1a; line-height: 1.55; }
  h1 { font-size: 22px; border-bottom: 1px solid #ddd; padding-bottom: 8px; }
  h2 { font-size: 18px; margin-top: 28px; }
  .head-meta { font-size: 13px; color: #555; margin-bottom: 16px; }
  .query { background: #f4f4f4; padding: 10px 14px; border-left: 3px solid #888; font-style: italic; white-space: pre-wrap; }
  .summary-text { background: #fafafa; padding: 12px 16px; border: 1px solid #eee; white-space: pre-wrap; font-family: inherit; font-size: 14px; }
  ul.acts { list-style: none; padding: 0; }
  li.act { border: 1px solid #e0e0e0; padding: 10px 14px; margin-bottom: 10px; border-radius: 4px; }
  .act-head { font-size: 15px; }
  .act-head .rank { color: #888; margin-right: 6px; }
  .act-head .court, .act-head .date { font-size: 13px; color: #666; margin-left: 8px; }
  .meta { font-family: monospace; font-size: 11px; color: #888; margin: 6px 0; }
  .snippet { font-size: 13px; color: #333; white-space: pre-wrap; }
  .link { font-size: 12px; margin-top: 4px; }
  footer { margin-top: 32px; font-size: 11px; color: #999; border-top: 1px solid #eee; padding-top: 8px; }
</style>
</head>
<body>
  <h1>${escapeHtml(PRODUCT_NAME)} — поисковый отчёт</h1>
  <div class="head-meta">
    docz_id: <code>${escapeHtml(report.id)}</code>
    | name: ${escapeHtml(name)}
    | template: <code>${escapeHtml(report.template_id)}</code>
    | status: <strong>${escapeHtml(report.status)}</strong>
    | created: ${escapeHtml(createdIso)}
  </div>
  <h2>Запрос</h2>
  <div class="query">${escapeHtml(query)}</div>
  <h2>Итоговый ответ</h2>
  ${summaryHtml}
  <h2>Найденные акты (${acts.length})</h2>
  <ul class="acts">${actsHtml || "<li><em>Нет результатов.</em></li>"}</ul>
  <footer>
    search_id: ${escapeHtml(result.search_id ?? "—")}
    | elapsed: ${escapeHtml(String(result.elapsed_ms ?? "—"))}ms
    | rerank model: ${escapeHtml(result.rerank?.model ?? "—")}
  </footer>
</body>
</html>`;
}

// 501-stub для документооборотных методов Doczilla.
function handleUnsupportedDocumentMethod(req, res, method) {
  log("INFO", "unsupported_document_method", { method, http_method: req.method });
  return err(res, 501, "not_implemented",
    `This Doczilla method is not supported by ${PRODUCT_NAME} compatibility API`,
    { method });
}

// 501-stub для users-методов Doczilla. RAS Search — Supply не имеет своей
// user-системы — login это compatibility stub без persistence пользователей.
function handleUnsupportedUserMethod(req, res, method) {
  log("INFO", "unsupported_user_method", { method, http_method: req.method });
  return err(res, 501, "not_implemented",
    `${PRODUCT_NAME} has no user management system; /doczilla-api/users/* is not supported`,
    { method });
}

// ── Router ───────────────────────────────────────────────────────────────────

/**
 * Главная точка входа. Возвращает true если запрос обработан, false если
 * pathname вообще не относится к /doczilla-api/* (caller тогда продолжит свой
 * роутинг).
 *
 * Порядок матчинга важен: поддерживаемые методы (createDocz/fillDocz/getById/
 * get/structureRead) обрабатываются ДО UNSUPPORTED_DOCUMENT_METHODS, поэтому
 * "create" в наборе unsupported НЕ перехватывает "createDocz".
 */
export async function handleDoczillaRequest(req, res, url) {
  const path = url.pathname;
  if (!path.startsWith("/doczilla-api/")) return false;

  try {
    // login
    if (path === "/doczilla-api/login") {
      await handleLogin(req, res);
      return true;
    }

    // document/* family
    if (path.startsWith("/doczilla-api/document/")) {
      const method = path.slice("/doczilla-api/document/".length);

      // Поддерживаемые методы — обрабатываем явно.
      if (method === "structureRead") { await handleStructureRead(req, res, url); return true; }
      if (method === "createDocz")    { await handleCreateDocz(req, res);         return true; }
      if (method === "fillDocz")      { await handleFillDocz(req, res);           return true; }
      if (method === "getById")       { await handleGetById(req, res, url);       return true; }
      if (method === "get")           { await handleGet(req, res);                return true; }

      // Документооборотные методы Doczilla → единообразный 501-stub.
      if (UNSUPPORTED_DOCUMENT_METHODS.has(method)) {
        handleUnsupportedDocumentMethod(req, res, method);
        return true;
      }

      err(res, 404, "not_found", `Unknown document method "${method}"`);
      return true;
    }

    // users/* family — у RAS Search — Supply нет user-системы → вся группа 501.
    if (path.startsWith("/doczilla-api/users/")) {
      const method = path.slice("/doczilla-api/users/".length);
      if (UNSUPPORTED_USER_METHODS.has(method)) {
        handleUnsupportedUserMethod(req, res, method);
        return true;
      }
      // Неизвестный users-метод — всё равно 501 (а не 404), потому что вся
      // семья изначально не поддерживается.
      handleUnsupportedUserMethod(req, res, method);
      return true;
    }

    err(res, 404, "not_found", `Unknown path "${path}"`);
    return true;
  } catch (e) {
    log("ERROR", "unhandled", { path, msg: e?.message ?? String(e) });
    if (!res.headersSent) {
      err(res, 500, "internal_error", e?.message ?? String(e));
    } else {
      try { res.end(); } catch {}
    }
    return true;
  }
}

// ── Startup hooks (вызываются из search-api.js при listen-callback) ──────────

/**
 * Чисто диагностические warning'и про конфигурацию: засветить факт что auth-
 * stub в dev-режиме. Не падает ни на чём.
 */
export function doczillaStartupChecks() {
  if (DOCZILLA_API_TOKEN) {
    log("INFO", `${PRODUCT_NAME} doczilla-facade auth-mode=token-required (DOCZILLA_API_TOKEN configured)`);
  } else {
    log("WARN", `${PRODUCT_NAME} doczilla-facade auth-mode=dev-open: DOCZILLA_API_TOKEN не задан, /doczilla-api/login принимает ЛЮБОЙ apiKey/login. Перед боевой публикацией задай env DOCZILLA_API_TOKEN или закрой /doczilla-api/* на reverse-proxy.`);
  }
}

/**
 * Recovery: поднимем зависшие 'running' отчёты от прошлой инкарнации процесса.
 * Безопасно при единственном процессе search-api. См. recoverStaleRunning.
 */
export async function doczillaStartupRecovery() {
  try {
    const n = await recoverStaleRunning(DOCZILLA_RUNNING_STALE_MINUTES);
    if (n > 0) {
      log("INFO", `recovered ${n} stale 'running' reports (>${DOCZILLA_RUNNING_STALE_MINUTES}min) → status='error'`);
    } else {
      log("INFO", `no stale 'running' reports to recover (threshold ${DOCZILLA_RUNNING_STALE_MINUTES}min)`);
    }
  } catch (e) {
    log("WARN", "stale-running recovery failed", { msg: e?.message ?? String(e) });
  }
}
