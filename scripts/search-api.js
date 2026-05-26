#!/usr/bin/env node
/**
 * scripts/search-api.js — локальный HTTP API над embed/retrieval.js::searchAndRerank.
 *
 * Минимальный node:http сервер, два эндпоинта:
 *
 *   GET  /health
 *     → 200 {"ok": true, "ts": "<ISO>"}
 *
 *   POST /hyde     {"query": "..."}
 *   GET  /hyde?q=...
 *     → 200 {
 *         "query":     "<исходный запрос>",
 *         "model":     "gemini-flash-latest",
 *         "elapsed_ms": <int>,
 *         "hyde_text": "<синтетический фрагмент мотивировочной части акта>",
 *         "hyde_chars": <int>,
 *         "usage":     {"prompt_tokens":..., "candidates_tokens":..., "total_tokens":...}|null,
 *         "finish_reason": "STOP"|"MAX_TOKENS"|...|null
 *       }
 *     → 503 если GEMINI_API_KEY не задан.
 *     → 502 если Gemini вернул пусто / safety-block / таймаут.
 *
 *   POST /search   {"query": "...", "topN": 5}
 *   GET  /search?q=...&topN=5
 *     → 200 {
 *         "query":   "<исходный текст>",
 *         "topN":    <n>,
 *         "elapsed_ms": <int>,
 *         "results": [
 *           {
 *             "act_id":            "<uuid>",
 *             "case_number":       "А40-…",
 *             "court":             "АС …",
 *             "registration_date": "YYYY-MM-DD",
 *             "true_instance_level": 1|2|3|null,
 *             "verdict_keep":      true|false|null,
 *             "verdict_action":    "<строка>"|null,
 *             "pdf_link":          "<url>"|null,
 *             "rerank_score":      <float>|null,
 *             "rrf_score":         <float>,
 *             "rrf_rank":          <int>,
 *             "snippet":           "первые ~280 символов act_text…",
 *             "text_chars":        <int>
 *           }
 *         ]
 *       }
 *
 * Compact-only: ПОЛНЫЙ acts.act_text наружу НЕ отдаётся. В ответе есть только
 * `snippet` (первые ~280 символов) и `text_chars` (длина оригинала). Если
 * downstream-клиенту нужен полный текст — пусть тянет напрямую из Postgres
 * по act_id, это решение про API surface, не про возможности pipeline.
 *
 * Запуск:
 *   npm run search:api
 *   # затем:
 *   curl http://127.0.0.1:8091/health
 *   curl -X POST -H 'content-type: application/json' \
 *        -d '{"query":"взыскание задолженности","topN":3}' \
 *        http://127.0.0.1:8091/search
 *
 * ENV:
 *   RAS_SEARCH_API_HOST   127.0.0.1
 *   RAS_SEARCH_API_PORT   8091
 *   RAS_SEARCH_API_MAX_TOPN   10  (cap на topN запроса, чтобы случайно не
 *                                  отправить 200 в reranker)
 *   RAS_SEARCH_API_DEFAULT_TOPN 5
 *
 *   плюс все RAS_RERANK_* / RAS_RRF_* — пробрасываются как параметры
 *   searchAndRerank один-в-один, см. scripts/search-qdrant-rerank.js.
 */

import http from "node:http";
import process from "node:process";

import { closePool, getPool } from "../db/pgClient.js";
import { qdrant, COLLECTION as QDRANT_COLLECTION } from "../embed/clients.js";
import { generateHypotheticalAct } from "../llm/hydeGenerator.js";
import { logSearch, closeLogsPool, isLogsPgConfigured } from "../db/pgLogsClient.js";
import {
  runSearchPipeline,
  clampTopN,
  DEFAULT_TOPN,
  MAX_TOPN,
  HYDE_ENABLED,
  RRF_TOPK_FOR_RERANK,
  BRANCH_LIMIT,
  GROUP_SIZE,
  RRF_K,
  MAX_CHARS,
} from "./searchPipeline.js";
import { handleDoczillaRequest, doczillaStartupRecovery, doczillaStartupChecks } from "./doczilla-facade.js";

const HOST = process.env.RAS_SEARCH_API_HOST || "127.0.0.1";
const PORT = Number(process.env.RAS_SEARCH_API_PORT || 8091);
// DEFAULT_TOPN/MAX_TOPN/RRF_*/HYDE_* — все приехали из ./searchPipeline.js

// Stats: background refresh, /stats отвечает мгновенно из кэша.
const STATS_REFRESH_MS = Number(process.env.RAS_STATS_REFRESH_MS || 300_000);
let _statsPayload = null;       // последний успешный snapshot (без cache-meta)
let _statsAt      = 0;          // ms epoch последнего успешного refresh
let _refreshPromise = null;     // single-flight guard
let _statsTimer   = null;       // setInterval handle

function nowIso() {
  return new Date().toISOString();
}

function log(level, msg, extra) {
  const line = extra
    ? `[search-api] ${level} ${msg} ${JSON.stringify(extra)}`
    : `[search-api] ${level} ${msg}`;
  if (level === "ERROR" || level === "WARN") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

async function readJsonBody(req, limitBytes = 64 * 1024) {
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

function pct(num, den) {
  if (!Number.isFinite(num) || !Number.isFinite(den) || den <= 0) return null;
  return Math.round((num / den) * 10000) / 100;
}

async function qdrantCount(filter) {
  const body = { exact: true };
  if (filter) body.filter = filter;
  const r = await qdrant("POST", `/collections/${QDRANT_COLLECTION}/points/count`, body);
  return Number(r?.result?.count ?? 0);
}

async function qdrantDistinctChunkActs() {
  const filter = { must: [{ key: "unit_type", match: { value: "chunk" } }] };
  const ids = new Set();
  let offset = null;
  // защита от бесконечного цикла: разумный потолок страниц.
  for (let page = 0; page < 1000; page++) {
    const body = {
      limit: 1000,
      with_payload: ["act_id"],
      with_vector: false,
      filter,
    };
    if (offset !== null) body.offset = offset;
    const r = await qdrant("POST", `/collections/${QDRANT_COLLECTION}/points/scroll`, body);
    const points = r?.result?.points ?? [];
    for (const p of points) {
      const aid = p?.payload?.act_id;
      if (aid !== undefined && aid !== null) ids.add(String(aid));
    }
    const next = r?.result?.next_page_offset;
    if (!next) break;
    offset = next;
  }
  return ids.size;
}

async function computeStats() {
  const pool = await getPool();
  const pgQ = pool.query(`
    SELECT
      count(*)::bigint AS total_links,
      count(*) FILTER (WHERE verdict_keep IS TRUE)::bigint AS valid_links,
      count(*) FILTER (
        WHERE verdict_keep IS TRUE
          AND act_text IS NOT NULL
          AND length(btrim(act_text)) > 0
      )::bigint AS downloaded_acts
    FROM acts
  `);
  // Qdrant: full_act-точки + distinct act_id среди chunk-точек.
  const qdrantP = (async () => {
    const fullAct = await qdrantCount({
      must: [{ key: "unit_type", match: { value: "full_act" } }],
    });
    const lateActs = await qdrantDistinctChunkActs();
    return fullAct + lateActs;
  })();

  const [pgRes, qdrantActs] = await Promise.all([pgQ, qdrantP]);
  const row = pgRes.rows[0];
  const total_links     = Number(row.total_links);
  const valid_links     = Number(row.valid_links);
  const downloaded_acts = Number(row.downloaded_acts);

  return {
    ok: true,
    total_links,
    valid_links,
    downloaded_acts,
    downloaded_pct_of_valid:   pct(downloaded_acts, valid_links),
    qdrant_acts:               qdrantActs,
    qdrant_pct_of_downloaded:  pct(qdrantActs, downloaded_acts),
  };
}

// Single-flight: запускает refresh, если ничего не крутится; иначе возвращает
// текущий промис. Ошибки не пробрасываются — пишутся в лог, _statsPayload
// остаётся прежним (stale-but-served).
function refreshStats() {
  if (_refreshPromise) return _refreshPromise;
  const t0 = Date.now();
  _refreshPromise = (async () => {
    try {
      const payload = await computeStats();
      _statsPayload = payload;
      _statsAt = Date.now();
      log("INFO", "[stats] refreshed", {
        elapsed_ms: _statsAt - t0,
        total_links: payload.total_links,
        valid_links: payload.valid_links,
        downloaded_acts: payload.downloaded_acts,
        qdrant_acts: payload.qdrant_acts,
      });
    } catch (e) {
      log("ERROR", "[stats] refresh failed", {
        elapsed_ms: Date.now() - t0,
        msg: e?.message ?? String(e),
      });
    } finally {
      _refreshPromise = null;
    }
  })();
  return _refreshPromise;
}

function startStatsRefresher() {
  // Сразу пнули фоновый refresh, не await — /stats должен подняться мгновенно.
  refreshStats();
  if (_statsTimer) clearInterval(_statsTimer);
  _statsTimer = setInterval(() => {
    refreshStats();
  }, STATS_REFRESH_MS);
  _statsTimer.unref?.();
}

async function handleStats(req, res) {
  if (req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  if (_statsPayload === null) {
    // Первый запрос до завершения первичного refresh — отвечаем мгновенно
    // с warming_up, кикаем refresh если по какой-то причине он не идёт.
    if (!_refreshPromise) refreshStats();
    sendJson(res, 200, {
      ok: true,
      warming_up: true,
      cached: true,
      updated_at: null,
      age_ms: null,
      refresh_in_progress: _refreshPromise !== null,
      total_links: null,
      valid_links: null,
      downloaded_acts: null,
      downloaded_pct_of_valid: null,
      qdrant_acts: null,
      qdrant_pct_of_downloaded: null,
    });
    return;
  }
  sendJson(res, 200, {
    ...(_statsPayload),
    cached: true,
    updated_at: new Date(_statsAt).toISOString(),
    age_ms: Date.now() - _statsAt,
    refresh_in_progress: _refreshPromise !== null,
  });
}

// Парсит входные параметры из POST body / GET query string в единый объект
// PipelineParams. Возвращает { ok: true, params } или { ok: false, status, error }.
// Используется обоими эндпоинтами (/search и /search/stream), чтобы поведение
// валидации было одинаковое.
async function parseSearchParams(req, url) {
  let query = null;
  let topN = DEFAULT_TOPN;
  let useHyde       = HYDE_ENABLED;
  let useSummary    = false;
  let hydeModelOpt  = null;
  let summaryModelOpt = null;
  // null = берём весь topN под summary; число = ограничение «сколько актов
  // в выдаче скармливать grounding-модели». Клампится к [1; topN] перед
  // использованием в pipeline.
  let summaryTopN   = null;
  let clientChatId   = null;
  let clientUserId   = null;
  let clientUsername = null;
  let rawRequest     = null;

  if (req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return { ok: false, status: 400, error: e.message };
    }
    query = typeof body.query === "string" ? body.query : null;
    if (body.topN !== undefined) topN = clampTopN(body.topN);
    if (body.use_hyde       !== undefined) useHyde     = !!body.use_hyde;
    if (body.use_summary    !== undefined) useSummary  = !!body.use_summary;
    if (typeof body.hyde_model    === "string" && body.hyde_model.trim())    hydeModelOpt    = body.hyde_model.trim();
    if (typeof body.summary_model === "string" && body.summary_model.trim()) summaryModelOpt = body.summary_model.trim();
    if (body.summary_top_n !== undefined && body.summary_top_n !== null) {
      const n = Number(body.summary_top_n);
      if (Number.isFinite(n) && n >= 1) summaryTopN = Math.floor(n);
    }
    if (Number.isFinite(Number(body.chat_id)))  clientChatId   = Number(body.chat_id);
    if (Number.isFinite(Number(body.user_id)))  clientUserId   = Number(body.user_id);
    if (typeof body.username === "string")      clientUsername = body.username.slice(0, 64);
    rawRequest = body;
  } else if (req.method === "GET") {
    query = url.searchParams.get("q") || url.searchParams.get("query");
    if (url.searchParams.has("topN")) topN = clampTopN(url.searchParams.get("topN"));
    if (url.searchParams.has("use_hyde"))    useHyde    = url.searchParams.get("use_hyde") !== "0";
    if (url.searchParams.has("use_summary")) useSummary = url.searchParams.get("use_summary") !== "0";
    if (url.searchParams.get("hyde_model"))    hydeModelOpt    = url.searchParams.get("hyde_model");
    if (url.searchParams.get("summary_model")) summaryModelOpt = url.searchParams.get("summary_model");
    if (url.searchParams.has("summary_top_n")) {
      const n = Number(url.searchParams.get("summary_top_n"));
      if (Number.isFinite(n) && n >= 1) summaryTopN = Math.floor(n);
    }
  } else {
    return { ok: false, status: 405, error: "method not allowed" };
  }

  if (!query || typeof query !== "string" || !query.trim()) {
    return { ok: false, status: 400, error: "missing or empty 'query'" };
  }
  const trimmed = query.trim();
  if (trimmed.length > 2000) {
    return { ok: false, status: 400, error: "query too long (>2000 chars)" };
  }

  // Кламп summary_top_n к [1; topN] — нельзя скормить summary больше актов,
  // чем мы вернули из поиска.
  if (summaryTopN !== null) {
    summaryTopN = Math.max(1, Math.min(topN, summaryTopN));
  }

  return {
    ok: true,
    params: {
      trimmed, topN,
      useHyde, useSummary, hydeModelOpt, summaryModelOpt,
      summaryTopN,
      clientChatId, clientUserId, clientUsername, rawRequest,
    },
  };
}


// ── HTTP-фасады поверх runSearchPipeline ─────────────────────────────────────

async function handleSearch(req, res, url) {
  const parsed = await parseSearchParams(req, url);
  if (!parsed.ok) {
    sendJson(res, parsed.status, { ok: false, error: parsed.error });
    return;
  }
  // Abort summary если клиент HTTP закрыл соединение раньше времени.
  const ac = new AbortController();
  const onClose = () => ac.abort(new Error("client closed connection"));
  req.on("close", onClose);
  let result;
  try {
    result = await runSearchPipeline(parsed.params, { abortSignal: ac.signal });
  } catch (e) {
    req.off("close", onClose);
    log("ERROR", "pipeline failed", { msg: e?.message ?? String(e), stage: e?.stage });
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "search failed", detail: e?.message ?? String(e) });
    }
    return;
  }
  req.off("close", onClose);

  sendJson(res, 200, result.responseBody);
  try { void logSearch(result.logRow); }
  catch (e) { log("WARN", "log_search wrap failed", { msg: e?.message ?? String(e) }); }
}

// SSE-эндпоинт: тот же pipeline, но прогресс утекает клиенту в реальном
// времени через text/event-stream. Финальный event "result" несёт полный
// /search-ответ (то же тело что у /search). После него — endmarker "done"
// и закрытие соединения.
//
// Формат каждого события:
//   event: <name>
//   data: <json>
//   <пустая строка>
//
// Keep-alive: каждые 10с пишем ': ping' (комментарий по спеке SSE) чтобы
// прокси (nginx и т.п.) не закрыл idle-коннект на долгой саммари.
async function handleSearchStream(req, res, url) {
  if (req.method !== "POST" && req.method !== "GET") {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }
  const parsed = await parseSearchParams(req, url);
  if (!parsed.ok) {
    sendJson(res, parsed.status, { ok: false, error: parsed.error });
    return;
  }

  res.writeHead(200, {
    "content-type":      "text/event-stream; charset=utf-8",
    "cache-control":     "no-cache, no-transform",
    "connection":        "keep-alive",
    "x-accel-buffering": "no",   // nginx — не буферизуй
  });
  // initial comment — некоторые клиенты ждут первого байта чтобы открыть стрим.
  res.write(":ok\n\n");

  const sendEvent = (name, data) => {
    if (res.writableEnded) return;
    try {
      res.write(`event: ${name}\n`);
      res.write(`data: ${JSON.stringify(data ?? {})}\n\n`);
    } catch (e) {
      log("WARN", "sse write failed", { event: name, msg: e?.message ?? String(e) });
    }
  };

  const pingTimer = setInterval(() => {
    if (res.writableEnded) return;
    try { res.write(":ping\n\n"); } catch {}
  }, 10_000);
  pingTimer.unref?.();

  const ac = new AbortController();
  const onClose = () => ac.abort(new Error("client closed connection"));
  req.on("close", onClose);

  let result;
  try {
    result = await runSearchPipeline(parsed.params, {
      abortSignal: ac.signal,
      onStage:     sendEvent,
    });
  } catch (e) {
    log("ERROR", "stream pipeline failed", { msg: e?.message ?? String(e), stage: e?.stage });
    sendEvent("error", { stage: e?.stage ?? "pipeline", message: e?.message ?? String(e) });
    sendEvent("done", { ok: false });
    clearInterval(pingTimer);
    req.off("close", onClose);
    try { res.end(); } catch {}
    return;
  }
  req.off("close", onClose);

  sendEvent("result", result.responseBody);
  sendEvent("done", { ok: true });
  clearInterval(pingTimer);
  try { res.end(); } catch {}

  try { void logSearch(result.logRow); }
  catch (e) { log("WARN", "log_search wrap failed", { msg: e?.message ?? String(e) }); }
}

async function handleHyde(req, res, url) {
  let query = null;

  if (req.method === "POST") {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      sendJson(res, 400, { ok: false, error: e.message });
      return;
    }
    query = typeof body.query === "string" ? body.query : null;
  } else if (req.method === "GET") {
    query = url.searchParams.get("q") || url.searchParams.get("query");
  } else {
    sendJson(res, 405, { ok: false, error: "method not allowed" });
    return;
  }

  if (!query || typeof query !== "string" || !query.trim()) {
    sendJson(res, 400, { ok: false, error: "missing or empty 'query'" });
    return;
  }
  const trimmed = query.trim();
  if (trimmed.length > 2000) {
    sendJson(res, 400, { ok: false, error: "query too long (>2000 chars)" });
    return;
  }

  if (!process.env.GEMINI_API_KEY) {
    sendJson(res, 503, { ok: false, error: "GEMINI_API_KEY not configured" });
    return;
  }

  // Пробрасываем abort клиента в SDK: если юзер закрыл соединение,
  // нет смысла дожимать запрос в Gemini.
  const ac = new AbortController();
  const onClose = () => ac.abort(new Error("client closed connection"));
  req.on("close", onClose);

  let result;
  try {
    result = await generateHypotheticalAct(trimmed, { signal: ac.signal });
  } catch (e) {
    req.off("close", onClose);
    log("ERROR", "hyde failed", { msg: e?.message ?? String(e) });
    sendJson(res, 502, { ok: false, error: "hyde generation failed", detail: e?.message ?? String(e) });
    return;
  }
  req.off("close", onClose);

  log("INFO", "hyde", {
    q_len: trimmed.length,
    out_chars: result.text.length,
    model: result.model,
    elapsed_ms: result.elapsed_ms,
    total_tokens: result.usage?.total_tokens ?? null,
  });

  sendJson(res, 200, {
    ok:           true,
    query:        trimmed,
    model:        result.model,
    elapsed_ms:   result.elapsed_ms,
    hyde_text:    result.text,
    hyde_chars:   result.text.length,
    usage:        result.usage,
    finish_reason: result.finish_reason,
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  try {
    if (url.pathname === "/health" && req.method === "GET") {
      sendJson(res, 200, { ok: true, ts: nowIso() });
      return;
    }
    if (url.pathname === "/search") {
      await handleSearch(req, res, url);
      return;
    }
    if (url.pathname === "/search/stream") {
      await handleSearchStream(req, res, url);
      return;
    }
    if (url.pathname === "/hyde") {
      await handleHyde(req, res, url);
      return;
    }
    if (url.pathname === "/stats") {
      await handleStats(req, res);
      return;
    }
    // Doczilla-compatible API facade (scripts/doczilla-facade.js).
    // Возвращает true если сам обработал запрос; false — значит pathname
    // не /doczilla-api/*, продолжаем дефолтный 404.
    if (url.pathname.startsWith("/doczilla-api/")) {
      const handled = await handleDoczillaRequest(req, res, url);
      if (handled) return;
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  } catch (e) {
    log("ERROR", "unhandled", { msg: e?.message ?? String(e) });
    if (!res.headersSent) {
      sendJson(res, 500, { ok: false, error: "internal" });
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.on("clientError", (err, socket) => {
  try { socket.destroy(); } catch {}
  log("WARN", "client error", { msg: err?.message ?? String(err) });
});

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log("INFO", `shutdown signal=${signal}`);
  if (_statsTimer) { clearInterval(_statsTimer); _statsTimer = null; }
  server.close(() => log("INFO", "http closed"));
  try { await closePool(); } catch {}
  try { await closeLogsPool(); } catch {}
  setTimeout(() => process.exit(0), 500).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  log(
    "INFO",
    `RAS Search — Supply API listening http://${HOST}:${PORT}  default_topN=${DEFAULT_TOPN}  max_topN=${MAX_TOPN}  ` +
    `rrf_topk=${RRF_TOPK_FOR_RERANK} branch_limit=${BRANCH_LIMIT} group_size=${GROUP_SIZE} rrf_k=${RRF_K} ` +
    `max_chars=${MAX_CHARS > 0 ? MAX_CHARS : "off"} ` +
    `stats_refresh_ms=${STATS_REFRESH_MS}`,
  );
  startStatsRefresher();
  // Doczilla facade startup: warn про auth-stub если нет DOCZILLA_API_TOKEN,
  // recovery зависших 'running'-отчётов от прошлой инкарнации процесса.
  doczillaStartupChecks();
  doczillaStartupRecovery().catch((e) => {
    log("WARN", "doczilla startup recovery failed", { msg: e?.message ?? String(e) });
  });
});
