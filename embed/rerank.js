/**
 * embed/rerank.js — Node-обёртка над POST /rerank инференса.
 *
 * Контракт (Шаг 5):
 *   Вход:  query, hydrated = [{ act_id, text, kind, rrf_score, ... }, ...] (после hydrate.js)
 *   Выход: ranked = [{ act_id, rerank_score, rrf_score, rerank_rank, rrf_rank, kind,
 *                       meta, ... }, ...], отсортирован по rerank_score desc, обрезан до topN.
 *
 * /rerank ожидает {query, documents}, возвращает [{index, score}] (sorted desc).
 * Мы маппим index обратно в hydrated[index] и сохраняем оригинальные поля.
 *
 * Пустые тексты (kind='empty') фильтруются: rerank им не нужен, они уходят в
 * конец финального списка с rerank_score=null. Это редкий edge-case (PG-row без
 * act_text при vector_status=indexed) — не теряем кандидата, но и не ломаемся.
 */

import { inferencePost } from "./clients.js";
import { countJinaV3Tokens } from "../pdf/jinaV3Tokens.js";

// v3-нативные дефолты: до 2048 токенов на документ, 512 на запрос.
// Совпадают с RERANKER_MAX_*_LENGTH в inference/app.py.
// Приоритет env-имён: новое RAS_RERANK_MAX_*  >  legacy RAS_RERANKER_MAX_*.
const DEFAULT_MAX_DOC_LENGTH = Number(
  process.env.RAS_RERANK_MAX_DOC_LENGTH ??
    process.env.RAS_RERANKER_MAX_DOC_LENGTH ??
    2048,
);
const DEFAULT_MAX_QUERY_LENGTH = Number(
  process.env.RAS_RERANK_MAX_QUERY_LENGTH ??
    process.env.RAS_RERANKER_MAX_QUERY_LENGTH ??
    512,
);

/**
 * Token budget для /rerank. Конфиг:
 *   - MAX_CONTEXT_TOKENS — полный context window модели (jina-reranker-v3 на
 *     Qwen3, 131072 токена). Технически модель умеет больше — оставляем 131K
 *     как практический потолок, чтобы не разогревать GPU OOM.
 *   - RESERVE_TOKENS — резерв на system/user prompt реранкера, query, JSON
 *     overhead. 4096 — с запасом под query (512 max) + промпт-обвязку.
 *   - BUDGET = MAX_CONTEXT - RESERVE — то, что можно потратить на сумму
 *     токенов всех documents в одном POST /rerank.
 *
 * Per-doc токены считаем как min(real_token_count, max_doc_length): реранкер
 * всё равно режет каждый doc до max_doc_length, нет смысла учитывать сверху.
 *
 * Разрешение токенов для конкретного doc'а (по приоритету):
 *   1) hydrated.tokens_jina_v3 — посчитано на скачивании, лежит в БД.
 *   2) POST /count_tokens — если в БД NULL (старый акт / inference был down
 *      на скачивании).
 *   3) estimateTokens(text) — char-based fallback, если /count_tokens не
 *      отвечает. Грубо, но не блокирует pipeline.
 */
const MAX_CONTEXT_TOKENS = Math.max(
  1024,
  Number(process.env.RAS_RERANK_MAX_CONTEXT_TOKENS ?? 131072),
);
const RESERVE_TOKENS = Math.max(
  0,
  Number(process.env.RAS_RERANK_RESERVE_TOKENS ?? 4096),
);
const BUDGET_VERBOSE =
  String(process.env.RAS_RERANK_BUDGET_VERBOSE ?? "0").trim() === "1";

/**
 * Char-based эстимат токенов для русского/смешанного юр. текста.
 * ~3.5 символа на токен — измеренное среднее на корпусе актов (jina-reranker-v3).
 * Используется только когда /count_tokens недоступен.
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  return Math.ceil(s.length / 3.5);
}

/**
 * Разрешить число токенов для одного hydrated-кандидата.
 *
 * После перехода на full_act-only (см. embed/hydrate.js, TEXT_MODE) реранкер
 * всегда видит полный acts.act_text. acts.tokens_jina_v3 хранит счёт именно
 * этого текста — значит можно безусловно доверять кэшу БД.
 *
 *   (1) item.tokens_jina_v3 → "db"           (норма; pdf-pipeline посчитал)
 *   (2) POST /count_tokens  → "inference"    (старые акты до фичи, NULL в БД)
 *   (3) estimateTokens      → "estimate"     (inference down — char-based)
 *
 * @param {{ text: string, tokens_jina_v3?: number|null, kind?: string }} item
 * @returns {Promise<{ tokens: number, source: 'db'|'inference'|'estimate' }>}
 */
async function resolveTokensForItem(item) {
  if (
    Number.isFinite(Number(item.tokens_jina_v3)) &&
    Number(item.tokens_jina_v3) >= 0
  ) {
    return { tokens: Math.floor(Number(item.tokens_jina_v3)), source: "db" };
  }
  const live = await countJinaV3Tokens(item.text);
  if (live != null) return { tokens: live, source: "inference" };
  return { tokens: estimateTokens(item.text), source: "estimate" };
}

/**
 * Отобрать кандидатов под token-budget. Stop-on-first-overflow: идём сверху
 * вниз по RRF rank'у, накапливаем сумму effective-токенов; первый, кто не
 * влезает — отсечка, все ниже в `dropped`. Так сохраняется детерминизм
 * порядка («лучшие N по retrieval-score, где N = max что влезло»).
 *
 * Per-doc cap (`maxDocLength`):
 *   - > 0  → effective = min(real_tokens, maxDocLength). Реранкер режет
 *            каждый doc до maxDocLength, поэтому учитывать сверху бессмысленно.
 *            mode='per_doc_cap'.
 *   - <= 0 → no cap, effective = real_tokens. Пакуем полные тексты, пока
 *            суммарно влезают в `budget`. mode='full_docs_no_per_doc_cap'.
 *
 * @param {Array<{ text: string, tokens_jina_v3?: number|null, kind: string }>} scorable
 * @param {{ maxDocLength: number, budget: number }} cfg
 * @returns {Promise<{
 *   included: Array<any & { _tokens_effective: number, _tokens_real: number, _tokens_source: string }>,
 *   dropped: any[],
 *   used_tokens: number,
 *   max_candidate_tokens: number,
 *   mode: 'per_doc_cap' | 'full_docs_no_per_doc_cap',
 *   counts: { db: number, inference: number, estimate: number },
 * }>}
 */
export async function applyTokenBudget(scorable, { maxDocLength, budget }) {
  const noCap = !Number.isFinite(maxDocLength) || maxDocLength <= 0;
  const mode = noCap ? "full_docs_no_per_doc_cap" : "per_doc_cap";
  const included = [];
  let usedTokens = 0;
  let stoppedAt = scorable.length;
  let maxCandidateTokens = 0;
  const counts = { db: 0, inference: 0, estimate: 0 };
  for (let i = 0; i < scorable.length; i++) {
    const s = scorable[i];
    const { tokens, source } = await resolveTokensForItem(s);
    counts[source] += 1;
    if (tokens > maxCandidateTokens) maxCandidateTokens = tokens;
    const effective = noCap ? tokens : Math.min(tokens, maxDocLength);
    if (usedTokens + effective > budget) {
      stoppedAt = i;
      if (BUDGET_VERBOSE) {
        // eslint-disable-next-line no-console
        console.log(
          `[rerank/budget] stop at rrf_rank=${i + 1} act=${s.act_id} ` +
            `tokens=${tokens}(src=${source}) effective=${effective} ` +
            `used=${usedTokens}/${budget} would_overflow_by=${
              usedTokens + effective - budget
            } mode=${mode}`,
        );
      }
      break;
    }
    included.push({
      ...s,
      _tokens_effective: effective,
      _tokens_real: tokens,
      _tokens_source: source,
    });
    usedTokens += effective;
  }
  const dropped = scorable.slice(stoppedAt);
  return {
    included,
    dropped,
    used_tokens: usedTokens,
    max_candidate_tokens: maxCandidateTokens,
    mode,
    counts,
  };
}

/**
 * Прогон reranker'а.
 *
 * @param {string} query
 * @param {Array<{ act_id: string, text: string, kind: string, rrf_score: number,
 *                  rrf_ranks: Record<string,number>, meta: object,
 *                  matched_chunk_ids?: number[]|null, used_chunk_ids?: number[]|null,
 *                  total_chunks?: number|null, text_chars: number,
 *                  truncated: boolean }>} hydrated
 * @param {{ topN?: number, maxDocLength?: number, maxQueryLength?: number }} [opts]
 * @returns {Promise<{
 *   model: string,
 *   scored: number,
 *   skipped_empty: number,
 *   ranked: Array<{
 *     act_id: string,
 *     rerank_score: number|null,
 *     rerank_rank: number|null,
 *     rrf_score: number,
 *     rrf_rank: number,
 *     rrf_ranks: Record<string, number>,
 *     kind: string,
 *     meta: object,
 *     matched_chunk_ids: number[]|null,
 *     used_chunk_ids:    number[]|null,
 *     total_chunks:      number|null,
 *     text_chars:        number,
 *     truncated:         boolean,
 *     text:              string
 *   }>
 * }>}
 */
export async function rerank(query, hydrated, opts = {}) {
  const topN           = opts.topN           ?? 5;
  const maxDocLength   = opts.maxDocLength   ?? DEFAULT_MAX_DOC_LENGTH;
  const maxQueryLength = opts.maxQueryLength ?? DEFAULT_MAX_QUERY_LENGTH;

  if (!Array.isArray(hydrated) || hydrated.length === 0) {
    return { model: null, scored: 0, skipped_empty: 0, ranked: [] };
  }

  // Делим: что отдать в reranker vs что хвостом приклеить (empty).
  const scorable = [];
  const empties  = [];
  hydrated.forEach((h, rrfIdx) => {
    const enriched = { ...h, rrf_rank: rrfIdx + 1 };
    if (!h.text || h.kind === "empty") empties.push(enriched);
    else                                 scorable.push(enriched);
  });

  // ── Token budget: отсекаем хвост, который не влез бы в context window. ──
  // Идём сверху вниз по RRF rank'у, останавливаемся на первом, что не помещается.
  // Дроп-кандидаты получают rerank_score=null и идут в общий хвост (по rrf_rank).
  // maxDocLength <= 0 → no per-doc cap (effective = full tokens, mode='full_docs_*').
  const noCapMode = !Number.isFinite(maxDocLength) || maxDocLength <= 0;
  const budget = Math.max(0, MAX_CONTEXT_TOKENS - RESERVE_TOKENS);
  const budgeted = await applyTokenBudget(scorable, {
    maxDocLength,
    budget,
  });
  const includedScorable = budgeted.included;
  const droppedByBudget = budgeted.dropped;
  const usedTokens = budgeted.used_tokens;
  const remainingTokens = Math.max(0, budget - usedTokens);
  const maxCandidateTokens = budgeted.max_candidate_tokens;
  const budgetMode = budgeted.mode;
  // eslint-disable-next-line no-console
  console.log(
    `[rerank/budget] mode=${budgetMode} ` +
      `candidates_before=${scorable.length} ` +
      `included=${includedScorable.length} dropped=${droppedByBudget.length} ` +
      `used_tokens=${usedTokens} budget_tokens=${budget} ` +
      `remaining_tokens=${remainingTokens} ` +
      `max_candidate_tokens=${maxCandidateTokens} ` +
      `max_context=${MAX_CONTEXT_TOKENS} reserve=${RESERVE_TOKENS} ` +
      `max_doc_length=${noCapMode ? "off" : maxDocLength} ` +
      `sources={db:${budgeted.counts.db},inference:${budgeted.counts.inference},` +
      `estimate:${budgeted.counts.estimate}}`,
  );

  let model = null;
  let scored = 0;
  const rerankedScorable = [];

  if (includedScorable.length > 0) {
    // POST max_doc_length:
    //   per_doc_cap            → передаём фактический maxDocLength (реранкер режет
    //                            каждый doc до него — наш budget уже это учёл).
    //   full_docs_no_per_doc_cap → передаём MAX_CONTEXT_TOKENS как safe-large value.
    //                            В inference/app.py: `if req.max_doc_length else
    //                            RERANKER_MAX_DOC_LENGTH` — если опустим/передадим 0,
    //                            сервер силой режет до дефолта (обычно 2048), и
    //                            мы потеряем полные тексты, ради которых сняли cap.
    //                            131072 практически = «не режь, документы все < этого».
    const postMaxDocLength = noCapMode ? MAX_CONTEXT_TOKENS : maxDocLength;
    // Лог входа в /rerank — пригодится для отладки, когда непонятно
    // «применился ли мой RAS_RERANK_MAX_DOC_LENGTH или нет».
    // eslint-disable-next-line no-console
    console.log(
      `[rerank] POST /rerank docs=${includedScorable.length} ` +
      `max_doc_length=${postMaxDocLength}${noCapMode ? "(safe-large, cap off)" : ""} ` +
      `max_query_length=${maxQueryLength} top_n=${topN}`,
    );
    const resp = await inferencePost("/rerank", {
      query,
      documents:        includedScorable.map((s) => s.text),
      top_n:            null, // отдаём score'ы на ВСЕ — обрезаем уже после слияния с empties.
      max_doc_length:   postMaxDocLength,
      max_query_length: maxQueryLength,
    });
    model = resp?.model ?? null;
    scored = resp?.scored ?? includedScorable.length;

    // results уже отсортированы desc по score — заодно даёт rerank_rank.
    const results = Array.isArray(resp?.results) ? resp.results : [];
    results.forEach((r, rerankIdx) => {
      const src = includedScorable[r.index];
      if (!src) return;
      rerankedScorable.push({
        act_id:            src.act_id,
        rerank_score:      Number(r.score),
        rerank_rank:       rerankIdx + 1,
        rrf_score:         src.rrf_score,
        rrf_rank:          src.rrf_rank,
        rrf_ranks:         src.rrf_ranks,
        kind:              src.kind,
        meta:              src.meta,
        matched_chunk_ids: src.matched_chunk_ids ?? null,
        used_chunk_ids:    src.used_chunk_ids ?? null,
        total_chunks:      src.total_chunks ?? null,
        text_chars:        src.text_chars,
        truncated:         src.truncated,
        text:              src.text,
        // Прокидываем разрешённый счёт токенов наверх — нужно для финального
        // вывода (text_source/tokens_jina_v3) и для downstream-фильтров.
        // _tokens_real — что получили из БД/inference/estimate, без cap'а.
        tokens_jina_v3:    src._tokens_real ?? src.tokens_jina_v3 ?? null,
        tokens_source:     src._tokens_source ?? null,
        text_source:       "postgres.act_text",
      });
    });
  }

  // Хвост без score: budget-dropped + изначально пустые. Сортируем по rrf_rank,
  // чтобы порядок был детерминирован (а не зависел от порядка двух листов).
  const tailRaw = [...droppedByBudget, ...empties].sort(
    (a, b) => (a.rrf_rank ?? 1e9) - (b.rrf_rank ?? 1e9),
  );
  const tail = tailRaw.map((e) => ({
    act_id:            e.act_id,
    rerank_score:      null,
    rerank_rank:       null,
    rrf_score:         e.rrf_score,
    rrf_rank:          e.rrf_rank,
    rrf_ranks:         e.rrf_ranks,
    kind:              e.kind,
    meta:              e.meta,
    matched_chunk_ids: e.matched_chunk_ids ?? null,
    used_chunk_ids:    e.used_chunk_ids ?? null,
    total_chunks:      e.total_chunks ?? null,
    text_chars:        e.text_chars,
    truncated:         e.truncated,
    text:              e.text,
    tokens_jina_v3:    e.tokens_jina_v3 ?? null,
    tokens_source:     null,
    text_source:       e.kind === "empty" ? null : "postgres.act_text",
  }));

  const full = [...rerankedScorable, ...tail];
  const ranked = topN > 0 ? full.slice(0, topN) : full;

  return {
    model,
    scored,
    skipped_empty: empties.length,
    budget: {
      mode:                 budgetMode,
      max_context_tokens:   MAX_CONTEXT_TOKENS,
      reserve_tokens:       RESERVE_TOKENS,
      budget_tokens:        budget,
      used_tokens:          usedTokens,
      remaining_tokens:     remainingTokens,
      candidates_before:    scorable.length,
      included:             includedScorable.length,
      dropped:              droppedByBudget.length,
      max_candidate_tokens: maxCandidateTokens,
      max_doc_length:       noCapMode ? null : maxDocLength,
      sources:              budgeted.counts,
    },
    ranked,
  };
}
