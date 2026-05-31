/**
 * backend/search/searchPipeline.js — чистый pipeline поиска без HTTP-обвязки.
 *
 * Извлечён из backend/search/search-api.js (где он был приватной функцией) ради
 * переиспользования из backend/search/doczilla-facade.js. Логика поиска НЕ менялась —
 * это безопасный refactor-вытащить.
 *
 * Pipeline: HyDE (опционально) → searchAndRerank → summary (опционально).
 * На каждом этапе зовёт onStage(name, data) если он передан (SSE-стрим).
 *
 * Возвращает { responseBody, logRow }. responseBody — то, что отдаёт /search.
 * logRow — готовая строка для INSERT в ras_pg_logs.searches.
 *
 * Вызывается из:
 *   - backend/search/search-api.js → /search, /search/stream
 *   - backend/search/doczilla-facade.js → POST /doczilla-api/document/fillDocz
 */

import crypto from "node:crypto";

import { searchAndRerank } from "../embed/retrieval.js";
import { generateHypotheticalAct } from "../llm/hydeGenerator.js";
import { generateFinalAnswer } from "../llm/summaryGenerator.js";

// ── Конфиг (читается из env один раз при загрузке модуля) ────────────────────
export const DEFAULT_TOPN = Number(process.env.RAS_SEARCH_API_DEFAULT_TOPN || 5);
// Потолок актов в выдаче. Равен RRF_TOPK_FOR_RERANK — больше реранкер физически
// не видит (кандидатский пул = 50). UI (web/bot) предлагает до 50, поэтому сервер
// тоже должен принимать до 50, иначе topN=50 молча режется и юзер получает меньше.
export const MAX_TOPN     = Number(process.env.RAS_SEARCH_API_MAX_TOPN     || 50);

export const RRF_TOPK_FOR_RERANK = Number(process.env.RAS_RRF_TOPK_FOR_RERANK ?? 50);
export const BRANCH_LIMIT        = Number(process.env.RAS_RRF_BRANCH_LIMIT    ?? 100);
export const GROUP_SIZE          = Number(process.env.RAS_RRF_GROUP_SIZE      ?? 3);
export const RRF_K               = Number(process.env.RAS_RRF_K               ?? 60);
export const CHUNK_WINDOW        = Number(process.env.RAS_RERANK_CHUNK_WINDOW ?? 1);

export const HYDE_ENABLED = (process.env.RAS_SEARCH_HYDE_ENABLED ?? "1") !== "0";
export const HYDE_MAX_CHARS_FOR_EMBED = Number(process.env.RAS_HYDE_MAX_EMBED_CHARS ?? 1200);

const RERANK_MAX_DOC_LENGTH = process.env.RAS_RERANK_MAX_DOC_LENGTH
  ? Number(process.env.RAS_RERANK_MAX_DOC_LENGTH)
  : null;
const RERANK_MAX_QUERY_LENGTH = process.env.RAS_RERANK_MAX_QUERY_LENGTH
  ? Number(process.env.RAS_RERANK_MAX_QUERY_LENGTH)
  : null;

export const MAX_CHARS = (() => {
  const explicit = process.env.RAS_RERANK_MAX_CHARS;
  if (explicit !== undefined && explicit !== "") return Number(explicit);
  if (
    RERANK_MAX_DOC_LENGTH !== null &&
    Number.isFinite(RERANK_MAX_DOC_LENGTH) &&
    RERANK_MAX_DOC_LENGTH <= 0
  ) {
    return 0;
  }
  return 12000;
})();

export const SNIPPET_CHARS = Number(process.env.RAS_SEARCH_API_SNIPPET_CHARS || 280);

// ── Helpers ─────────────────────────────────────────────────────────────────
export function clampTopN(raw) {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TOPN;
  return Math.max(1, Math.min(MAX_TOPN, Math.floor(n)));
}

export function makeSnippet(text, n) {
  if (!text) return "";
  const t = String(text).replace(/\s+/g, " ").trim();
  if (n <= 0) return "";
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function toDateString(d) {
  if (!d) return null;
  if (typeof d === "string") return d.slice(0, 10);
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return null;
}

// Umbrella TypeId + genre GUID'ы, для которых RAS не отдаёт текст исхода в
// `ContentTypes[1]`, но сам жанр документа уже substantive (мотивированный финал).
// Подменяем 'unknown' на конкретный жанр-маркер — чтобы UI бота не путал
// пользователя голым "unknown". См. parser.js:1180 (keep=true для umbrella+empty
// ContentTypes[1]) и CLAUDE.md «umbrella TypeId».
const UMBRELLA_TYPE_ID = "23f4baa9-e7cc-407a-aba7-11dd8772aa3b";
const GENRE_TO_DERIVED_ACTION = new Map([
  ["08f888a2-83ad-4fdf-8985-f77fe2085f11", "simplified"],   // упрощёнка
  ["db0af13c-2d10-4677-812e-c55e90a894bd", "additional"],   // доп. решение
  ["8a67b151-5fb1-4fe0-9068-24a5895d41ba", "additional"],   // доп. постановление
]);

function _deriveVerdictAction(rawAction, typeId, contentTypesString) {
  // Подменяем ТОЛЬКО 'unknown' / null. Если уже есть конкретный action — оставляем.
  const a = rawAction == null ? null : String(rawAction).toLowerCase();
  if (a && a !== "unknown") return rawAction;
  if (!typeId || String(typeId).toLowerCase() !== UMBRELLA_TYPE_ID) return rawAction;
  if (typeof contentTypesString !== "string" || !contentTypesString) return rawAction;
  const firstGuid = contentTypesString.split(/[,\s]+/)[0]?.toLowerCase();
  if (!firstGuid) return rawAction;
  return GENRE_TO_DERIVED_ACTION.get(firstGuid) ?? rawAction;
}

export function compactResult(r) {
  const meta = r.meta ?? {};
  const verdictAction = _deriveVerdictAction(
    meta.verdict_action,
    meta.type_id,
    meta.content_types_string,
  );
  return {
    act_id:              r.act_id,
    case_id:             meta.case_id ?? null,
    case_number:         meta.case_number ?? null,
    court:               meta.court ?? null,
    registration_date:   toDateString(meta.registration_date),
    type_name:           meta.type_name ?? null,
    true_instance_level: meta.true_instance_level ?? null,
    verdict_keep:        meta.verdict_keep ?? null,
    verdict_action:      verdictAction ?? null,
    pdf_link:            meta.pdf_link ?? null,
    tokens_jina_v4:      meta.tokens_jina_v4 ?? null,
    rerank_score:        r.rerank_score ?? null,
    rerank_rank:         r.rerank_rank ?? null,
    rrf_score:           r.rrf_score ?? null,
    rrf_rank:            r.rrf_rank ?? null,
    snippet:             makeSnippet(r.text, SNIPPET_CHARS),
    text_chars:          r.text_chars ?? 0,
    kind:                r.kind ?? null,
  };
}

function defaultLog(level, msg, extra) {
  const line = extra
    ? `[search-api] ${level} ${msg} ${JSON.stringify(extra)}`
    : `[search-api] ${level} ${msg}`;
  if (level === "ERROR" || level === "WARN") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

/**
 * Запустить полный pipeline. Принимает уже отвалидированные параметры.
 *
 * @param {object} params
 *   trimmed         — запрос (строка, без trailing/leading пробелов)
 *   topN            — int, [1; MAX_TOPN]
 *   useHyde         — boolean
 *   useSummary      — boolean
 *   hydeModelOpt    — string|null, override модели HyDE
 *   summaryModelOpt — string|null, override модели Summary
 *   summaryTopN     — int|null, ограничение по числу актов в summary
 *   clientChatId    — number|null (для logRow)
 *   clientUserId    — number|null
 *   clientUsername  — string|null
 *   rawRequest      — object|null (то, что прислал клиент; идёт в logRow.raw_request)
 *
 * @param {object} [opts]
 *   onStage     — function(name, data) — для SSE-стрима
 *   abortSignal — AbortSignal, пробрасывается в Gemini-summary
 *   log         — function(level, msg, extra) — кастомный логгер
 *
 * @returns {Promise<{responseBody: object, logRow: object}>}
 */
export async function runSearchPipeline(params, opts = {}) {
  const {
    trimmed, topN,
    useHyde, useSummary, hydeModelOpt, summaryModelOpt,
    summaryTopN,
  } = params;
  const onStage = typeof opts.onStage === "function" ? opts.onStage : null;
  const abortSignal = opts.abortSignal;
  const log = typeof opts.log === "function" ? opts.log : defaultLog;

  const emit = (name, data) => {
    if (!onStage) return;
    try { onStage(name, data || {}); }
    catch (e) { log("WARN", "onStage callback threw", { name, msg: e?.message ?? String(e) }); }
  };

  const searchId = crypto.randomBytes(6).toString("hex");
  const t0 = Date.now();
  log("INFO", "search/start", {
    search_id: searchId,
    q_len: trimmed.length,
    q: trimmed.length <= 200 ? trimmed : trimmed.slice(0, 200) + "…",
    topN,
    use_hyde: useHyde,
    use_summary: useSummary,
    hyde_model_override:    hydeModelOpt,
    summary_model_override: summaryModelOpt,
  });
  emit("pipeline_start", {
    search_id: searchId,
    use_hyde: useHyde,
    use_summary: useSummary,
    top_n: topN,
  });

  // HyDE pre-step.
  let hydeText        = null;
  let hydeModel       = null;
  let hydeModelVer    = null;
  let hydeUsage       = null;
  let hydeFinish      = null;
  let hydeElapsedMs   = null;
  let hydeError       = null;
  if (useHyde && process.env.GEMINI_API_KEY) {
    emit("hyde_start", { model: hydeModelOpt || process.env.RAS_HYDE_MODEL || null });
    const tHyde = Date.now();
    try {
      const r = await generateHypotheticalAct(trimmed, hydeModelOpt ? { model: hydeModelOpt } : {});
      hydeText      = r.text;
      hydeModel     = r.model;
      hydeModelVer  = r.model_version;
      hydeUsage     = r.usage;
      hydeFinish    = r.finish_reason;
      hydeElapsedMs = Date.now() - tHyde;
      log("INFO", "search/hyde-done", {
        search_id: searchId,
        elapsed_ms: hydeElapsedMs,
        chars: hydeText.length,
        model: hydeModel,
        model_version: hydeModelVer,
        usage: hydeUsage,
        finish: hydeFinish,
      });
      emit("hyde_done", {
        elapsed_ms: hydeElapsedMs,
        chars: hydeText.length,
        model: hydeModel,
        model_version: hydeModelVer,
      });
    } catch (e) {
      hydeError     = e?.message ?? String(e);
      hydeElapsedMs = Date.now() - tHyde;
      log("WARN", "search/hyde-fallback", { search_id: searchId, msg: hydeError, elapsed_ms: hydeElapsedMs });
      emit("hyde_done", { elapsed_ms: hydeElapsedMs, error: hydeError });
    }
  } else {
    log("INFO", "search/hyde-skipped", {
      search_id: searchId,
      use_hyde: useHyde,
      has_key: !!process.env.GEMINI_API_KEY,
    });
    emit("hyde_skipped", {
      reason: !useHyde ? "disabled" : "no_api_key",
    });
  }

  // Safety-truncate перед embed.
  let hydeTextForEmbed = hydeText;
  let hydeTruncatedFrom = 0;
  if (hydeText && HYDE_MAX_CHARS_FOR_EMBED > 0 && hydeText.length > HYDE_MAX_CHARS_FOR_EMBED) {
    hydeTruncatedFrom = hydeText.length;
    hydeTextForEmbed = hydeText.slice(0, HYDE_MAX_CHARS_FOR_EMBED);
    log("WARN", "search/hyde-truncated", { from: hydeTruncatedFrom, to: HYDE_MAX_CHARS_FOR_EMBED });
  }
  log("INFO", "search/before-rerank-pipeline", {
    hyde_text_chars: hydeTextForEmbed?.length ?? 0,
    hyde_truncated_from: hydeTruncatedFrom || null,
    top_n: topN,
    rerank_candidates: RRF_TOPK_FOR_RERANK,
  });

  emit("search_start", {});
  const tSearch = Date.now();
  let result;
  try {
    result = await searchAndRerank(trimmed, {
      perBranchLimit:        BRANCH_LIMIT,
      groupSize:             GROUP_SIZE,
      rrfK:                  RRF_K,
      // Всегда подаём в reranker ПОЛНЫЙ RRF-пул (50). Это даёт реранкеру шанс
      // вытащить «закопанные» в RRF-хвосте акты независимо от того, сколько
      // юзер просит в выдаче. На длинных юр. текстах реранкер pointwise → ~20с
      // на 50 актов вне зависимости от topN (см. project_topn_and_whisper_filter).
      rrfTopK:               RRF_TOPK_FOR_RERANK,
      topN,
      chunkWindow:           CHUNK_WINDOW,
      maxChars:              MAX_CHARS,
      rerankMaxDocLength:    RERANK_MAX_DOC_LENGTH ?? undefined,
      rerankMaxQueryLength:  RERANK_MAX_QUERY_LENGTH ?? undefined,
      queryForEmbedding:     hydeTextForEmbed ?? undefined,
    });
  } catch (e) {
    log("ERROR", "search failed", { msg: e?.message ?? String(e) });
    emit("error", { stage: "search", message: e?.message ?? String(e) });
    const err = new Error(`search failed: ${e?.message ?? String(e)}`);
    err.stage = "search";
    throw err;
  }
  const searchElapsedMs = Date.now() - tSearch;
  const rerankElapsed = Date.now() - t0;

  const topRanked = (result.rerank?.ranked ?? []).slice(0, topN);
  const compact = topRanked.map(compactResult);
  emit("search_done", {
    elapsed_ms:   searchElapsedMs,
    retrieval_ms: result.timing?.retrieval_ms ?? null,
    hydrate_ms:   result.timing?.hydrate_ms   ?? null,
    rerank_ms:    result.timing?.rerank_ms    ?? null,
    returned:     compact.length,
    candidates:   result.rerank?.scored ?? null,
  });

  // Summary (grounding) шаг.
  let summaryText      = null;
  let summaryModel     = null;
  let summaryModelVer  = null;
  let summaryUsage     = null;
  let summaryFinish    = null;
  let summaryElapsedMs = null;
  let summaryActsUsed  = null;
  let summaryError     = null;
  const summaryLimit = (typeof summaryTopN === "number" && summaryTopN > 0)
    ? Math.min(summaryTopN, topRanked.length)
    : topRanked.length;
  const summaryCandidates = topRanked
    .slice(0, summaryLimit)
    .filter((r) => r && typeof r.text === "string" && r.text.trim() && r.kind !== "empty")
    .map((r) => ({
      act_id:      r.act_id,
      case_number: r.meta?.case_number ?? null,
      text:        r.text,
    }));
  if (useSummary && process.env.GEMINI_API_KEY && summaryCandidates.length > 0) {
    emit("summary_start", {
      model:      summaryModelOpt || process.env.RAS_SUMMARY_MODEL || null,
      candidates: summaryCandidates.length,
    });
    const tSum = Date.now();
    try {
      const r = await generateFinalAnswer(trimmed, summaryCandidates, {
        ...(summaryModelOpt ? { model: summaryModelOpt } : {}),
        ...(abortSignal ? { signal: abortSignal } : {}),
      });
      summaryText      = r.text;
      summaryModel     = r.model;
      summaryModelVer  = r.model_version;
      summaryUsage     = r.usage;
      summaryFinish    = r.finish_reason;
      summaryElapsedMs = Date.now() - tSum;
      summaryActsUsed  = r.acts_used;
      log("INFO", "search/summary-done", {
        search_id: searchId,
        elapsed_ms: summaryElapsedMs,
        chars: summaryText.length,
        model: summaryModel,
        model_version: summaryModelVer,
        acts_used: summaryActsUsed,
        usage: summaryUsage,
        finish: summaryFinish,
      });
      emit("summary_done", {
        elapsed_ms:    summaryElapsedMs,
        chars:         summaryText.length,
        model_version: summaryModelVer,
        acts_used:     summaryActsUsed,
      });
    } catch (e) {
      summaryError     = e?.message ?? String(e);
      summaryElapsedMs = Date.now() - tSum;
      log("WARN", "search/summary-failed", { search_id: searchId, msg: summaryError, elapsed_ms: summaryElapsedMs });
      emit("summary_done", { elapsed_ms: summaryElapsedMs, error: summaryError });
    }
  } else {
    log("INFO", "search/summary-skipped", {
      search_id:    searchId,
      use_summary:  useSummary,
      has_key:      !!process.env.GEMINI_API_KEY,
      candidates:   summaryCandidates.length,
    });
    emit("summary_skipped", {
      reason: !useSummary
        ? "disabled"
        : (!process.env.GEMINI_API_KEY ? "no_api_key" : "no_candidates"),
    });
  }
  const elapsed = Date.now() - t0;

  log("INFO", "search", {
    search_id: searchId,
    q_len: trimmed.length,
    topN,
    returned: compact.length,
    total_ms:     elapsed,
    rerank_ms_total: rerankElapsed,
    hyde_ms:      hydeElapsedMs,
    summary_ms:   summaryElapsedMs,
    retrieval_ms: result.timing?.retrieval_ms,
    hydrate_ms:   result.timing?.hydrate_ms,
    rerank_ms:    result.timing?.rerank_ms,
    hyde_used:    hydeText !== null,
    hyde_chars:   hydeText?.length ?? 0,
    hyde_model:   hydeModel,
    hyde_model_version: hydeModelVer,
    hyde_total_tokens:  hydeUsage?.total_tokens ?? null,
    hyde_error:   hydeError,
    use_summary:  useSummary,
    summary_used: summaryText !== null,
    summary_chars: summaryText?.length ?? 0,
    summary_model: summaryModel,
    summary_model_version: summaryModelVer,
    summary_total_tokens: summaryUsage?.total_tokens ?? null,
    summary_error: summaryError,
    top_act_ids:  compact.map((c) => c.act_id),
  });

  const responseBody = {
    ok:         true,
    search_id:  searchId,
    query:      trimmed,
    topN,
    elapsed_ms: elapsed,
    timing:     result.timing ?? null,
    hyde: {
      used:          hydeText !== null,
      model:         hydeModel,
      model_version: hydeModelVer,
      chars:         hydeText?.length ?? 0,
      elapsed_ms:    hydeElapsedMs,
      usage:         hydeUsage,
      finish_reason: hydeFinish,
      truncated_from: hydeTruncatedFrom || null,
      error:         hydeError,
      text:          hydeText,
    },
    rerank: {
      model:         result.rerank?.model ?? null,
      scored:        result.rerank?.scored ?? 0,
      skipped_empty: result.rerank?.skipped_empty ?? 0,
    },
    summary: {
      used:          summaryText !== null,
      requested:     useSummary,
      model:         summaryModel,
      model_version: summaryModelVer,
      chars:         summaryText?.length ?? 0,
      elapsed_ms:    summaryElapsedMs,
      acts_used:     summaryActsUsed,
      usage:         summaryUsage,
      finish_reason: summaryFinish,
      error:         summaryError,
      text:          summaryText,
    },
    results: compact,
  };
  emit("pipeline_done", { total_ms: elapsed });

  const thinking = (hydeUsage?.total_tokens != null
                    && hydeUsage?.prompt_tokens != null
                    && hydeUsage?.candidates_tokens != null)
    ? hydeUsage.total_tokens - hydeUsage.prompt_tokens - hydeUsage.candidates_tokens
    : null;
  const summaryThinking = (summaryUsage?.total_tokens != null
                           && summaryUsage?.prompt_tokens != null
                           && summaryUsage?.candidates_tokens != null)
    ? summaryUsage.total_tokens - summaryUsage.prompt_tokens - summaryUsage.candidates_tokens
    : null;
  const logRow = {
    search_id:      searchId,
    ts:             new Date(),
    chat_id:        params.clientChatId,
    user_id:        params.clientUserId,
    username:       params.clientUsername,
    query:          trimmed,
    query_chars:    trimmed.length,
    top_n:          topN,
    use_hyde:       useHyde,
    use_summary:    useSummary,
    hyde_model_req:     hydeModelOpt    ?? (useHyde ? (process.env.RAS_HYDE_MODEL || null) : null),
    summary_model_req:  summaryModelOpt ?? null,
    hyde_used:      hydeText !== null,
    hyde_text:      hydeText,
    hyde_chars:     hydeText?.length ?? null,
    hyde_model_actual:   hydeModelVer,
    hyde_prompt_tokens:     hydeUsage?.prompt_tokens     ?? null,
    hyde_candidates_tokens: hydeUsage?.candidates_tokens ?? null,
    hyde_thinking_tokens:   thinking,
    hyde_total_tokens:      hydeUsage?.total_tokens      ?? null,
    hyde_finish_reason:     hydeFinish,
    hyde_elapsed_ms:        hydeElapsedMs,
    hyde_truncated_from:    hydeTruncatedFrom || null,
    hyde_error:             hydeError,
    summary_used:              summaryText !== null,
    summary_text:              summaryText,
    summary_chars:             summaryText?.length ?? null,
    summary_model_actual:      summaryModelVer,
    summary_acts_used:         summaryActsUsed,
    summary_prompt_tokens:     summaryUsage?.prompt_tokens     ?? null,
    summary_candidates_tokens: summaryUsage?.candidates_tokens ?? null,
    summary_thinking_tokens:   summaryThinking,
    summary_total_tokens:      summaryUsage?.total_tokens      ?? null,
    summary_finish_reason:     summaryFinish,
    summary_elapsed_ms:        summaryElapsedMs,
    summary_error:             summaryError,
    retrieval_ms:   result.timing?.retrieval_ms ?? null,
    hydrate_ms:     result.timing?.hydrate_ms   ?? null,
    rerank_ms:      result.timing?.rerank_ms    ?? null,
    total_ms:       elapsed,
    returned_count: compact.length,
    top_act_ids:    compact.map((c) => c.act_id),
    results:        JSON.stringify(compact),
    raw_request:    params.rawRequest ? JSON.stringify(params.rawRequest) : null,
    raw_response:   JSON.stringify(responseBody),
  };

  return { responseBody, logRow };
}
