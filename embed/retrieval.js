/**
 * embed/retrieval.js — retrieval layer с 5-ветвенным поиском + RRF.
 *
 * Архитектура (после переработки 2026-05-23: добавлена ветка long_colbert):
 *   ┌──────────────────────────┐
 *   │ /embed(query)            │   /embed возвращает colbert, dense, sparse.
 *   └──────────┬───────────────┘   (sparse — token-id → tf, IDF на Qdrant.)
 *              │
 *      ┌───────┴───────┬───────────────┬──────────────┬──────────────┐
 *      ▼               ▼               ▼              ▼              ▼
 *   full_colbert   full_sparse     long_dense     long_sparse    long_colbert
 *   (full_act,     (full_act,     (chunk,        (chunk,        (chunk,
 *    has_colbert,   sparse-only)   dense_late,    sparse,        has_colbert,
 *    dense prefetch                 group_by       group_by       dense_late prefetch
 *    → colbert                      act_id)        act_id)        → colbert MaxSim,
 *    MaxSim rerank)                                                group_by act_id)
 *      │              │              │              │              │
 *      └──────┬───────┴───────┬──────┴──────┬───────┴───────┬──────┘
 *             ▼               ▼             ▼               ▼
 *      ranked act_id   ranked act_id  ranked act_id  ranked act_id    (5 списков)
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
 *   long_dense   : 1.00  — late-chunk dense mean-pool для длинных актов
 *   long_sparse  : 1.00  — точные термы внутри длинных актов
 *   long_colbert : 1.15  — late-chunk colbert MaxSim (паритет с short colbert)
 *
 * long_colbert использует те же 128-dim multivector токены, что и short-акты,
 * но посчитанные через late chunking: один forward pass на весь акт, потом
 * raw tokens нарезаны на чанки без overlap. Хранится в Qdrant в том же
 * named-vector "colbert" (multivector_config max_sim), отличается только
 * payload (unit_type=chunk vs full_act).
 */

import {
  QDRANT_URL,
  COLLECTION,
  inferencePost,
  qdrant,
  loadReranker,
} from "./clients.js";
import { hydrateForRerank } from "./hydrate.js";
import { rerank } from "./rerank.js";
import {
  acquireRuntimeLease,
  releaseRuntimeLease,
} from "../db/runtimeFlags.js";

// ─────────────────────────────────────────────────────────────────────────────
// Search-priority lease: пока идёт поисковый запрос, индексер должен уступить
// inference (см. embed/worker.js::waitForSearchPriority). Каждый search берёт
// свой ключ `search_active:<uuid>` через acquireRuntimeLease, чтобы релиз
// одного запроса не сносил другой одновременный. Acquire — до embedQuery,
// release — в finally; ошибки релиза не валят поиск, только логируются.
// ─────────────────────────────────────────────────────────────────────────────

const SEARCH_LEASE_PREFIX = "search_active";

function resolveSearchLeaseTtlSeconds() {
  const raw = process.env.RAS_SEARCH_LEASE_TTL_SECONDS;
  if (raw === undefined || raw === "") return 180;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 180;
}

async function withSearchLease(fn) {
  const ttlSeconds = resolveSearchLeaseTtlSeconds();
  let leaseKey = null;
  try {
    leaseKey = await acquireRuntimeLease(SEARCH_LEASE_PREFIX, { ttlSeconds });
    console.log(`[search/lease] acquired key=${leaseKey} ttl=${ttlSeconds}s`);
  } catch (e) {
    console.warn(`[search/lease] acquire failed err=${e?.message ?? e} — running search without lease`);
  }
  try {
    return await fn();
  } finally {
    if (leaseKey) {
      try {
        await releaseRuntimeLease(leaseKey);
        console.log(`[search/lease] released key=${leaseKey}`);
      } catch (e) {
        console.warn(`[search/lease] release failed key=${leaseKey} err=${e?.message ?? e}`);
      }
    }
  }
}

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

/**
 * Ветка E — длинные акты, ColBERT MaxSim per chunk.
 *   filter: unit_type=chunk AND has_colbert=true
 *   prefetch: dense_late (128-dim mean-pool) → грубая отсортировка top-N
 *   search:   colbert (multivector token-level) → MaxSim rerank внутри N
 *   group_by: act_id (один длинный акт → одна позиция в выдаче)
 *
 * Это паритет с full_colbert для длинных актов: late chunking даёт raw
 * token embeddings per chunk, MaxSim матчит токены query с токенами чанка
 * без усреднения. Главный качественный сигнал для коротких запросов
 * с конкретными терминами по длинным актам.
 *
 * Prefetch limit держим побольше (≈ limit × 5), потому что dense_late
 * на mean-pool достаточно грубый — MaxSim переcортирует.
 */
export async function branchLongColbert(q, opts = {}) {
  const limit         = opts.limit         ?? 100;
  const prefetchLimit = opts.prefetchLimit ?? Math.max(500, limit * 5);
  const groupSize     = opts.groupSize     ?? 3;
  const flt = {
    must: [
      { key: "unit_type",   match: { value: "chunk" } },
      { key: "has_colbert", match: { value: true   } },
    ],
  };
  const body = {
    prefetch: {
      query:  q.colbertMeanPool,
      using:  "dense_late",
      filter: flt,
      limit:  prefetchLimit,
    },
    query:    q.colbert,
    using:    "colbert",
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
  long_colbert: 1.15,
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
async function _searchAllImpl(queryText, opts = {}) {
  const perBranchLimit = opts.perBranchLimit ?? 100;
  const groupSize      = opts.groupSize      ?? 3;
  const weights        = opts.weights        ?? DEFAULT_RRF_WEIGHTS;
  const rrfK           = opts.rrfK           ?? 60;
  const topK           = opts.topK           ?? 20;

  // HyDE-режим: если задан queryForDense — это синтетический акт, который
  // эмбедится в dense-вектор для смысло-поиска. Параллельно эмбедится
  // оригинальный (короткий) queryText — его ColBERT-multivector и sparse
  // используются в лексических ветках. Так dense ловит «о чём дело» через
  // богатую HyDE-форму, а ColBERT/sparse матчатся пословно с коротким
  // user-query (избегаем O(N×M) взрыва ColBERT MaxSim на длинном тексте).
  const queryForDense = (typeof opts.queryForDense === "string"
                         && opts.queryForDense.trim())
    ? opts.queryForDense
    : null;

  let q;
  if (queryForDense) {
    const [qLex, qDense] = await Promise.all([
      embedQuery(queryText),
      embedQuery(queryForDense),
    ]);
    q = {
      colbert:         qLex.colbert,          // multivector → короткий оригинал
      sparse:          qLex.sparse,           // sparse terms → короткий оригинал
      dense:           qDense.dense,          // 2048-d → HyDE
      colbertMeanPool: qDense.colbertMeanPool,// 128-d late-dense → HyDE
      tokens:          qLex.tokens,
      tokensDense:     qDense.tokens,
    };
  } else {
    q = await embedQuery(queryText);
  }

  const branchOpts       = { limit: perBranchLimit };
  const longBranchOpts   = { limit: perBranchLimit, groupSize };

  // 5 веток параллельно. Promise.all потому, что они независимы — пока одна
  // ветка ждёт ответа Qdrant, другие тоже летят.
  const [
    full_colbert,
    full_sparse,
    long_dense,
    long_sparse,
    long_colbert,
  ] = await Promise.all([
    branchFullColbert(q, branchOpts),
    branchFullSparse(q, branchOpts),
    branchLongDense(q, longBranchOpts),
    branchLongSparse(q, longBranchOpts),
    branchLongColbert(q, longBranchOpts),
  ]);

  const merged = rrfMerge(
    {
      full_colbert: full_colbert.actIds,
      full_sparse:  full_sparse.actIds,
      long_dense:   long_dense.actIds,
      long_sparse:  long_sparse.actIds,
      long_colbert: long_colbert.actIds,
    },
    weights,
    rrfK,
  );

  return {
    query: {
      tokens:      q.tokens,
      sparseTerms: q.sparse.indices?.length ?? 0,
    },
    branches: {
      full_colbert,
      full_sparse,
      long_dense,
      long_sparse,
      long_colbert,
    },
    merged,
    topK: merged.slice(0, topK).map(([act_id, score, ranks]) => ({ act_id, score, ranks })),
  };
}

export async function searchAll(queryText, opts = {}) {
  return withSearchLease(() => _searchAllImpl(queryText, opts));
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
 *   @param {string} [opts.queryForEmbedding]    HyDE-текст; идёт в embedQuery
 *                                               для retrieval. Rerank остаётся
 *                                               на оригинальном queryText.
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
async function _searchAndRerankImpl(queryText, opts = {}) {
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
  // HyDE: текст для DENSE-веток (dense full + dense_late). ColBERT-
  // multivector и sparse остаются на оригинальном queryText — они
  // лексические, длинный синтетический текст там даёт нелинейный взрыв
  // стоимости поиска. Rerank (Jina v3 cross-encoder) тоже видит
  // оригинал — он обучен на парах (user-query, doc).
  const queryForDense = (typeof opts.queryForEmbedding === "string"
                          && opts.queryForEmbedding.trim())
    ? opts.queryForEmbedding
    : null;

  const tStart = Date.now();

  // Fire-and-forget reranker load. При RAS_RERANKER_AUTO_LIFECYCLE=1 на
  // стороне inference reranker по дефолту выгружен; пока мы retrieval'им
  // и hydrate'им (~300-1000 ms), reranker подгружается в VRAM параллельно.
  // /rerank на стороне inference имеет auto-load fallback на случай race
  // condition (если retrieval оказался быстрее load'а — /rerank сам ждёт).
  loadReranker().catch(() => {});

  // 1) Retrieval + RRF (поднимаем topK до rrfTopK, чтобы reranker'у было что
  // переcортировать; ничего не теряем — merged всё равно есть).
  // Зовём _searchAllImpl напрямую — внешний withSearchLease уже держит лиз
  // на весь pipeline, второй acquire здесь был бы лишним.
  const retrieved = await _searchAllImpl(queryText, {
    perBranchLimit,
    groupSize,
    weights,
    rrfK,
    topK: rrfTopK,
    queryForDense,
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

export async function searchAndRerank(queryText, opts = {}) {
  return withSearchLease(() => _searchAndRerankImpl(queryText, opts));
}
