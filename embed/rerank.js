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

// v3-нативные дефолты: до 2048 токенов на документ, 512 на запрос.
// Совпадают с RERANKER_MAX_*_LENGTH в inference/app.py.
const DEFAULT_MAX_DOC_LENGTH   = Number(process.env.RAS_RERANKER_MAX_DOC_LENGTH   ?? 2048);
const DEFAULT_MAX_QUERY_LENGTH = Number(process.env.RAS_RERANKER_MAX_QUERY_LENGTH ?? 512);

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

  let model = null;
  let scored = 0;
  const rerankedScorable = [];

  if (scorable.length > 0) {
    const resp = await inferencePost("/rerank", {
      query,
      documents:        scorable.map((s) => s.text),
      top_n:            null, // отдаём score'ы на ВСЕ — обрезаем уже после слияния с empties.
      max_doc_length:   maxDocLength,
      max_query_length: maxQueryLength,
    });
    model = resp?.model ?? null;
    scored = resp?.scored ?? scorable.length;

    // results уже отсортированы desc по score — заодно даёт rerank_rank.
    const results = Array.isArray(resp?.results) ? resp.results : [];
    results.forEach((r, rerankIdx) => {
      const src = scorable[r.index];
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
      });
    });
  }

  // Empties без score'а — в хвост, в RRF-порядке.
  const emptyTail = empties.map((e) => ({
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
  }));

  const full = [...rerankedScorable, ...emptyTail];
  const ranked = topN > 0 ? full.slice(0, topN) : full;

  return {
    model,
    scored,
    skipped_empty: empties.length,
    ranked,
  };
}
