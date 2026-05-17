/**
 * embed/retrieval.js — retrieval layer с 4-ветвенным поиском + RRF.
 *
 * Архитектура (Roman's Step 4):
 *   ┌──────────────────────────┐
 *   │ /embed(query)            │   /embed возвращает colbert, dense, sparse.
 *   └──────────┬───────────────┘   (sparse — token-id → tf, IDF на Qdrant.)
 *              │
 *      ┌───────┴───────┬────────────────┬─────────────┐
 *      ▼               ▼                ▼             ▼
 *   full_colbert    full_sparse     long_dense    long_sparse
 *   (full_act +     (full_act,     (chunk,       (chunk,
 *    has_colbert,    sparse-only)   dense_late,   sparse,
 *    dense prefetch                 group_by      group_by
 *    → colbert                      act_id)       act_id)
 *    MaxSim rerank)
 *      │               │                │             │
 *      └──────┬────────┴────────┬───────┴──────┬──────┘
 *             ▼                 ▼              ▼
 *      ranked act_id     ranked act_id   ranked act_id    (4 списка)
 *             │
 *             ▼
 *         RRF merge (по рангам, не по score'ам)
 *             │
 *             ▼
 *         финальный ranked список act_id
 *
 * Главный принцип: **сырые Qdrant score никогда не сравниваются между ветками**
 * (colbert MaxSim, dense Dot, sparse IDF·TF — разные шкалы). RRF учитывает
 * только позицию в каждой ветке: score(act) = Σ_b w_b / (k + rank_b(act)).
 *
 * Веса по умолчанию (можно тюнить env / argument):
 *   full_colbert : 1.15  — самый точный сигнал для коротких актов (token-level)
 *   full_sparse  : 1.00  — точные юридические термины / статьи / номера
 *   long_dense   : 1.00  — late-chunk dense для длинных актов
 *   long_sparse  : 1.00  — точные термы внутри длинных актов
 */

import {
  QDRANT_URL,
  COLLECTION,
  inferencePost,
  qdrant,
} from "./clients.js";
import { hydrateForRerank } from "./hydrate.js";
import { rerank } from "./rerank.js";

// ─────────────────────────────────────────────────────────────────────────────
// Эмбеддинг запроса
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Эмбедит запрос в три представления через /embed (task=retrieval.query):
 *   colbert — multivector (n_query_tokens × 128), для colbert-rerank
 *   dense   — 2048-dim, для dense prefetch
 *   sparse  — {indices, values} term frequencies, IDF Qdrant досчитает
 *   colbertMeanPool — 128-dim mean(colbert по токенам), для dense_late
 *                      (chunks хранят 128-dim late-chunked dense)
 *
 * @param {string} text
 * @returns {Promise<{ colbert, dense, sparse, colbertMeanPool, tokens }>}
 */
export async function embedQuery(text) {
  const data = await inferencePost("/embed", {
    texts: [text],
    task: "retrieval.query",
    return_sparse: true,
  });
  const colbert = data.multivectors?.[0];
  const dense   = data.dense_vectors?.[0];
  const sparse  = data.sparse_vectors?.[0] ?? { indices: [], values: [] };
  const tokens  = data.token_counts?.[0] ?? colbert?.length ?? 0;
  if (!Array.isArray(colbert) || !Array.isArray(colbert[0])) {
    throw new Error("embedQuery: bad multivectors");
  }
  if (!Array.isArray(dense)) {
    throw new Error("embedQuery: bad dense_vectors");
  }
  const dim = colbert[0].length;
  const sum = new Array(dim).fill(0);
  for (const tokVec of colbert) {
    for (let i = 0; i < dim; i++) sum[i] += tokVec[i];
  }
  const colbertMeanPool = sum.map((s) => s / colbert.length);
  return { colbert, dense, sparse, colbertMeanPool, tokens };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

const DEFAULT_PAYLOAD_FIELDS = [
  "act_id",
  "case_number",
  "court",
  "registration_date",
  "unit_type",
  "chunk_id",
  "verdict_keep",
  "verdict_action",
];

function rankedUniqueActIds(points) {
  const out = [];
  const seen = new Set();
  for (const p of points || []) {
    const id = p?.payload?.act_id ?? p?.id;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

function actIdsFromGroups(groups) {
  // У групп Qdrant поле `id` = значение group_by ("act_id" payload).
  return (groups || []).map((g) => g.id).filter(Boolean);
}

// ─────────────────────────────────────────────────────────────────────────────
// Branches
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ветка A — короткие акты, full-act colbert.
 *   filter: unit_type=full_act AND has_colbert=true
 *   search: dense prefetch (2048) → colbert MaxSim rerank
 *
 * Возвращает массив point'ов и уникальные ранжированные act_id'шки.
 */
export async function branchFullColbert(q, opts = {}) {
  const limit = opts.limit ?? 100;
  const prefetchLimit = opts.prefetchLimit ?? Math.max(500, limit * 5);
  const flt = {
    must: [
      { key: "unit_type",   match: { value: "full_act" } },
      { key: "has_colbert", match: { value: true        } },
    ],
  };
  const body = {
    prefetch: {
      query: q.dense,
      using: "dense",
      filter: flt,
      limit: prefetchLimit,
    },
    query:  q.colbert,
    using:  "colbert",
    filter: flt,
    limit,
    with_payload: DEFAULT_PAYLOAD_FIELDS,
    with_vector:  false,
  };
  const res = await qdrant("POST", `/collections/${COLLECTION}/points/query`, body);
  const points = res?.result?.points ?? [];
  return { points, actIds: rankedUniqueActIds(points) };
}

/**
 * Ветка B — короткие акты, sparse/BM25.
 *   filter: unit_type=full_act
 *   search: sparse {indices, values} (IDF на Qdrant)
 *
 * Не требует has_colbert, потому что sparse может быть у любого full_act.
 */
export async function branchFullSparse(q, opts = {}) {
  const limit = opts.limit ?? 100;
  if (!q.sparse?.indices?.length) return { points: [], actIds: [] };
  const flt = {
    must: [{ key: "unit_type", match: { value: "full_act" } }],
  };
  const body = {
    query: { indices: q.sparse.indices, values: q.sparse.values },
    using: "sparse",
    filter: flt,
    limit,
    with_payload: DEFAULT_PAYLOAD_FIELDS,
    with_vector:  false,
  };
  const res = await qdrant("POST", `/collections/${COLLECTION}/points/query`, body);
  const points = res?.result?.points ?? [];
  return { points, actIds: rankedUniqueActIds(points) };
}

/**
 * Ветка C — длинные акты, late-chunk dense.
 *   filter: unit_type=chunk
 *   search: dense_late (128-dim mean-pool colbert query)
 *   group_by: act_id  (один длинный акт → одна позиция в выдаче)
 */
export async function branchLongDense(q, opts = {}) {
  const limit     = opts.limit     ?? 100;
  const groupSize = opts.groupSize ?? 3;
  const flt = {
    must: [{ key: "unit_type", match: { value: "chunk" } }],
  };
  const body = {
    query:    q.colbertMeanPool,
    using:    "dense_late",
    filter:   flt,
    group_by: "act_id",
    limit,
    group_size: groupSize,
    with_payload: DEFAULT_PAYLOAD_FIELDS,
    with_vector:  false,
  };
  const res = await qdrant(
    "POST",
    `/collections/${COLLECTION}/points/query/groups`,
    body,
  );
  const groups = res?.result?.groups ?? [];
  return { groups, actIds: actIdsFromGroups(groups) };
}

/**
 * Ветка D — длинные акты, sparse/BM25 chunks.
 *   filter: unit_type=chunk
 *   search: sparse {indices, values}
 *   group_by: act_id
 */
export async function branchLongSparse(q, opts = {}) {
  const limit     = opts.limit     ?? 100;
  const groupSize = opts.groupSize ?? 3;
  if (!q.sparse?.indices?.length) return { groups: [], actIds: [] };
  const flt = {
    must: [{ key: "unit_type", match: { value: "chunk" } }],
  };
  const body = {
    query: { indices: q.sparse.indices, values: q.sparse.values },
    using: "sparse",
    filter: flt,
    group_by: "act_id",
    limit,
    group_size: groupSize,
    with_payload: DEFAULT_PAYLOAD_FIELDS,
    with_vector:  false,
  };
  const res = await qdrant(
    "POST",
    `/collections/${COLLECTION}/points/query/groups`,
    body,
  );
  const groups = res?.result?.groups ?? [];
  return { groups, actIds: actIdsFromGroups(groups) };
}

// ─────────────────────────────────────────────────────────────────────────────
// RRF — Reciprocal Rank Fusion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * RRF merge нескольких ranked-листов act_id.
 *
 * score(act) = Σ_b w_b / (k + rank_b(act))
 *
 * rank_b — позиция (1-based) в ветке b. Если act не появился в ветке —
 * вклад от неё 0. k обычно 60 (стандарт из оригинальной статьи Cormack et al.).
 *
 * @param {Record<string, string[]>} branches  { branchName: [act_id, …] }
 * @param {Record<string, number>}   weights   { branchName: weight }
 * @param {number}                   k
 * @returns {Array<[string, number, Record<string, number>]>}  [actId, score, {branch: rank}]
 */
export function rrfMerge(branches, weights = {}, k = 60) {
  const scores = new Map();
  const breakdown = new Map();
  for (const [branchName, actIds] of Object.entries(branches)) {
    const w = weights[branchName] ?? 1.0;
    const seen = new Set();
    actIds.forEach((actId, idx) => {
      if (!actId || seen.has(actId)) return;
      seen.add(actId);
      const rank = idx + 1;
      scores.set(actId, (scores.get(actId) || 0) + w / (k + rank));
      const bd = breakdown.get(actId) ?? {};
      bd[branchName] = rank;
      breakdown.set(actId, bd);
    });
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id, score]) => [id, score, breakdown.get(id) ?? {}]);
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level entrypoint
// ─────────────────────────────────────────────────────────────────────────────

export const DEFAULT_RRF_WEIGHTS = {
  full_colbert: 1.15,
  full_sparse:  1.00,
  long_dense:   1.00,
  long_sparse:  1.00,
};

/**
 * Прогнать все 4 ветки параллельно, склеить через RRF.
 *
 * @param {string} queryText
 * @param {object} [opts]
 *   @param {number} [opts.perBranchLimit=100]  лимит каждой ветки
 *   @param {number} [opts.groupSize=3]          point'ов на группу (long_*)
 *   @param {Record<string,number>} [opts.weights]
 *   @param {number} [opts.rrfK=60]
 *   @param {number} [opts.topK=20]               сколько вернуть в финале
 *
 * @returns {Promise<{
 *   query: { tokens: number, sparseTerms: number },
 *   branches: {
 *     full_colbert: { points: any[], actIds: string[] },
 *     full_sparse:  { points: any[], actIds: string[] },
 *     long_dense:   { groups: any[], actIds: string[] },
 *     long_sparse:  { groups: any[], actIds: string[] },
 *   },
 *   merged: Array<[string, number, Record<string,number>]>,
 *   topK:   Array<{ act_id: string, score: number, ranks: Record<string,number> }>,
 * }>}
 */
export async function searchAll(queryText, opts = {}) {
  const perBranchLimit = opts.perBranchLimit ?? 100;
  const groupSize      = opts.groupSize      ?? 3;
  const weights        = opts.weights        ?? DEFAULT_RRF_WEIGHTS;
  const rrfK           = opts.rrfK           ?? 60;
  const topK           = opts.topK           ?? 20;

  const q = await embedQuery(queryText);

  const branchOpts       = { limit: perBranchLimit };
  const longBranchOpts   = { limit: perBranchLimit, groupSize };

  // 4 ветки параллельно. Promise.all потому, что они независимы — пока одна
  // ветка ждёт ответа Qdrant, другие тоже летят.
  const [full_colbert, full_sparse, long_dense, long_sparse] = await Promise.all([
    branchFullColbert(q, branchOpts),
    branchFullSparse(q, branchOpts),
    branchLongDense(q, longBranchOpts),
    branchLongSparse(q, longBranchOpts),
  ]);

  const merged = rrfMerge(
    {
      full_colbert: full_colbert.actIds,
      full_sparse:  full_sparse.actIds,
      long_dense:   long_dense.actIds,
      long_sparse:  long_sparse.actIds,
    },
    weights,
    rrfK,
  );

  return {
    query: {
      tokens:      q.tokens,
      sparseTerms: q.sparse.indices?.length ?? 0,
    },
    branches: { full_colbert, full_sparse, long_dense, long_sparse },
    merged,
    topK: merged.slice(0, topK).map(([act_id, score, ranks]) => ({ act_id, score, ranks })),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 5 — searchAndRerank: full pipeline retrieval → hydration → reranker.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Полный pipeline до финального top-5:
 *
 *   1. searchAll(query, topK=rrfTopK)             — 4 ветки + RRF
 *   2. hydrateForRerank(merged, branches, …)      — PG hydration:
 *        short → full act_text
 *        long  → matched chunks ± window, склеенные
 *   3. rerank(query, hydrated, topN)              — Jina reranker:
 *        cross-encoder (query, doc) → top-N финал
 *
 * @param {string} queryText
 * @param {object} [opts]
 *   @param {number} [opts.perBranchLimit=100]   лимит каждой ветки retrieval
 *   @param {number} [opts.groupSize=3]          group_size для long_* веток
 *   @param {Record<string,number>} [opts.weights]
 *   @param {number} [opts.rrfK=60]              коэффициент RRF
 *   @param {number} [opts.rrfTopK=50]           сколько кандидатов в reranker
 *   @param {number} [opts.topN=5]               финальный top-N после reranker
 *   @param {number} [opts.chunkWindow=1]        ± соседних чанков для long-актов
 *   @param {number} [opts.maxChars=12000]       cap на длину документа в /rerank (char-уровень)
 *   @param {number} [opts.rerankMaxDocLength=2048]   max_doc_length токенов (Jina v3)
 *   @param {number} [opts.rerankMaxQueryLength=512]  max_query_length токенов (Jina v3)
 *
 * @returns {Promise<{
 *   query: { tokens: number, sparseTerms: number },
 *   branches: object,
 *   merged: Array<[string, number, Record<string,number>]>,
 *   topK:   Array<{ act_id, score, ranks }>,                      // RRF top-K, что подаётся в hydrate
 *   hydrated: Array<{ act_id, text, kind, ... }>,
 *   rerank: {
 *     model: string,
 *     scored: number,
 *     skipped_empty: number,
 *     ranked: Array<{ act_id, rerank_score, rerank_rank, rrf_score, rrf_rank, ... }>,
 *   },
 *   timing: { retrieval_ms, hydrate_ms, rerank_ms, total_ms },
 * }>}
 */
export async function searchAndRerank(queryText, opts = {}) {
  const perBranchLimit = opts.perBranchLimit  ?? 100;
  const groupSize      = opts.groupSize       ?? 3;
  const weights        = opts.weights         ?? DEFAULT_RRF_WEIGHTS;
  const rrfK           = opts.rrfK            ?? 60;
  const rrfTopK        = opts.rrfTopK         ?? 50;
  const topN           = opts.topN            ?? 5;
  const chunkWindow    = opts.chunkWindow     ?? 1;
  const maxChars       = opts.maxChars;        // undefined → дефолт hydrate.js
  const rerankMaxDoc   = opts.rerankMaxDocLength;
  const rerankMaxQ     = opts.rerankMaxQueryLength;

  const tStart = Date.now();

  // 1) Retrieval + RRF (поднимаем topK до rrfTopK, чтобы reranker'у было что
  // переcортировать; ничего не теряем — merged всё равно есть).
  const retrieved = await searchAll(queryText, {
    perBranchLimit,
    groupSize,
    weights,
    rrfK,
    topK: rrfTopK,
  });
  const tRetrieval = Date.now();

  // 2) Hydration из PG.
  const hydrated = await hydrateForRerank(
    retrieved.topK,
    retrieved.branches,
    { chunkWindow, maxChars },
  );
  const tHydrate = Date.now();

  // 3) Reranker.
  const rerankResult = await rerank(queryText, hydrated, {
    topN,
    maxDocLength:   rerankMaxDoc,
    maxQueryLength: rerankMaxQ,
  });
  const tRerank = Date.now();

  return {
    ...retrieved,
    hydrated,
    rerank: rerankResult,
    timing: {
      retrieval_ms: tRetrieval - tStart,
      hydrate_ms:   tHydrate   - tRetrieval,
      rerank_ms:    tRerank    - tHydrate,
      total_ms:     tRerank    - tStart,
    },
  };
}
