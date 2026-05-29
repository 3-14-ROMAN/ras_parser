#!/usr/bin/env node
/**
 * backend/tools/profile-search-pipeline.js — диагностический замер времени
 * на каждом этапе search pipeline. НЕ ХОДИТ через withSearchLease, чтобы
 * не вешать прод-сервис /search; вызывает все branch-функции напрямую.
 *
 * Прогоняет ОДИН и тот же запрос в двух режимах:
 *   1) original query (короткий бытовой текст)
 *   2) HyDE-текст (длинный синтетический акт от Gemini)
 *
 * На выходе — табличка по каждой ветке: query tokens, sparse terms,
 * limit/prefetch, elapsed_ms; плюс embedQuery, RRF merge, hydrate, rerank.
 *
 * Запуск:
 *   node --env-file=.env backend/tools/profile-search-pipeline.js
 *
 * Опц.: своя строка запроса:
 *   QUERY="хочу взыскать долг" node --env-file=.env backend/tools/profile-search-pipeline.js
 */

import {
  embedQuery,
  branchFullColbert,
  branchFullSparse,
  branchLongDense,
  branchLongSparse,
  branchLongColbert,
  rrfMerge,
} from "../embed/retrieval.js";
import { hydrateForRerank } from "../embed/hydrate.js";
import { rerank } from "../embed/rerank.js";
import { qdrant, COLLECTION } from "../embed/clients.js";
import { generateHypotheticalAct } from "../llm/hydeGenerator.js";
import { closePool } from "../db/pgClient.js";

const ORIGINAL_QUERY =
  process.env.QUERY ||
  "поставщик не привёз товар, заплатил предоплату 500 тысяч, неустойка по ст. 395 ГК";

const PER_BRANCH_LIMIT = 100;
const GROUP_SIZE       = 3;
const PREFETCH_LIMIT   = Math.max(500, PER_BRANCH_LIMIT * 5);
const RRF_TOPK         = 50;
const RRF_K            = 60;
const HYDRATE_TOP      = 50;
const RERANK_TOPN      = 3;

const ms = (n) => `${String(n).padStart(6)}ms`;

// ──────────────────────────────────────────────────────────────────────────
// 1. Qdrant collection config snapshot
// ──────────────────────────────────────────────────────────────────────────
async function dumpCollectionConfig() {
  console.log("=== Qdrant collection config ===");
  const info = await qdrant("GET", `/collections/${COLLECTION}`);
  const cfg = info?.result?.config || {};
  const params = cfg.params || {};
  const hnsw = cfg.hnsw_config || {};
  const opt = cfg.optimizer_config || {};

  console.log(`collection:              ${COLLECTION}`);
  console.log(`status:                  ${info?.result?.status}`);
  console.log(`points_count:            ${info?.result?.points_count}`);
  console.log(`indexed_vectors_count:   ${info?.result?.indexed_vectors_count}`);
  console.log(`segments_count:          ${info?.result?.segments_count}`);
  console.log("");
  console.log("Vectors:");
  for (const [name, v] of Object.entries(params.vectors || {})) {
    const m = v.hnsw_config?.m;
    const hnswStr = m === 0 ? "HNSW DISABLED (m=0, rerank-only)" : `m=${m ?? "(default)"}`;
    const mv = v.multivector_config?.comparator ? ` multivector=${v.multivector_config.comparator}` : "";
    console.log(`  ${name.padEnd(12)} size=${v.size} distance=${v.distance} ${hnswStr}${mv}`);
  }
  console.log("Sparse vectors:");
  for (const [name, v] of Object.entries(params.sparse_vectors || {})) {
    console.log(`  ${name.padEnd(12)} modifier=${v.modifier ?? "-"} on_disk=${v.index?.on_disk ?? "(default)"}`);
  }
  console.log("");
  console.log("RAM placement:");
  console.log(`  hnsw.on_disk:          ${hnsw.on_disk}   (${hnsw.on_disk === false ? "✓ HNSW в RAM" : "⚠ HNSW на диске"})`);
  console.log(`  memmap_threshold:      ${opt.memmap_threshold ?? "null"}  (null = векторы не mmap'ятся, в RAM)`);
  console.log(`  indexing_threshold:    ${opt.indexing_threshold}`);
  console.log(`  on_disk_payload:       ${params.on_disk_payload}      (payload на диске — норм, в RAM только векторы и индексы)`);
  console.log("");
  console.log(`payload indexes:         ${Object.keys(info?.result?.payload_schema || {}).length} fields`);
  console.log("");
}

// ──────────────────────────────────────────────────────────────────────────
// 2. Per-branch profile
// ──────────────────────────────────────────────────────────────────────────
async function profileBranches(q) {
  const tokens = q.tokens;
  const sparseTerms = q.sparse?.indices?.length ?? 0;

  const list = [
    ["full_colbert", branchFullColbert, { limit: PER_BRANCH_LIMIT, prefetchLimit: PREFETCH_LIMIT },
      { uses_tokens: true,  uses_sparse: false, prefetch_using: "dense",      query_using: "colbert"  }],
    ["full_sparse",  branchFullSparse,  { limit: PER_BRANCH_LIMIT },
      { uses_tokens: false, uses_sparse: true,  prefetch_using: null,         query_using: "sparse"   }],
    ["long_dense",   branchLongDense,   { limit: PER_BRANCH_LIMIT, groupSize: GROUP_SIZE },
      { uses_tokens: false, uses_sparse: false, prefetch_using: null,         query_using: "dense_late" }],
    ["long_sparse",  branchLongSparse,  { limit: PER_BRANCH_LIMIT, groupSize: GROUP_SIZE },
      { uses_tokens: false, uses_sparse: true,  prefetch_using: null,         query_using: "sparse"   }],
    ["long_colbert", branchLongColbert, { limit: PER_BRANCH_LIMIT, groupSize: GROUP_SIZE /* prefetchLimit берётся из env-default RAS_LONG_COLBERT_PREFETCH */ },
      { uses_tokens: true,  uses_sparse: false, prefetch_using: "dense_late", query_using: "colbert"  }],
  ];

  const results = {};
  for (const [name, fn, opts, meta] of list) {
    const t = Date.now();
    let elapsed, count, err = null;
    try {
      const r = await fn(q, opts);
      elapsed = Date.now() - t;
      count = r.points?.length ?? r.groups?.length ?? r.actIds?.length ?? 0;
      results[name] = { ...r, elapsed_ms: elapsed };
    } catch (e) {
      elapsed = Date.now() - t;
      err = e?.message?.slice(0, 200) || String(e);
      results[name] = { actIds: [], points: [], groups: [], elapsed_ms: elapsed };
    }
    const cols = [
      ms(elapsed),
      `using=${meta.query_using.padEnd(10)}`,
      `prefetch=${(meta.prefetch_using ?? "-").padEnd(10)}`,
      `limit=${String(opts.limit).padEnd(3)}`,
      `pf_limit=${String(opts.prefetchLimit ?? (name === "long_colbert" ? (process.env.RAS_LONG_COLBERT_PREFETCH ?? "100(def)") : "-")).padEnd(3)}`,
      meta.uses_tokens  ? `query_tok=${String(tokens).padEnd(4)}` : "query_tok=  -",
      meta.uses_sparse  ? `sparse_terms=${String(sparseTerms).padEnd(4)}` : "sparse_terms=  -",
      `results=${count ?? "-"}`,
    ];
    console.log(`  ${name.padEnd(14)} ${cols.join("  ")}${err ? "  ERR=" + err : ""}`);
  }
  return results;
}

// ──────────────────────────────────────────────────────────────────────────
// 3. RRF merge + hydrate + rerank
// ──────────────────────────────────────────────────────────────────────────
async function profilePostRetrieval(queryTextForRerank, branchResults) {
  const tRrf0 = Date.now();
  const merged = rrfMerge(
    {
      full_colbert: branchResults.full_colbert?.actIds ?? [],
      full_sparse:  branchResults.full_sparse?.actIds  ?? [],
      long_dense:   branchResults.long_dense?.actIds   ?? [],
      long_sparse:  branchResults.long_sparse?.actIds  ?? [],
      long_colbert: branchResults.long_colbert?.actIds ?? [],
    },
    undefined,
    RRF_K,
  );
  const rrfMs = Date.now() - tRrf0;
  console.log(`  rrf_merge      ${ms(rrfMs)}  merged_total=${merged.length}  topK=${RRF_TOPK}`);

  const topK = merged.slice(0, HYDRATE_TOP).map(([act_id, score, ranks]) => ({ act_id, score, ranks }));

  const tHyd0 = Date.now();
  const hydrated = await hydrateForRerank(topK, branchResults, { chunkWindow: 1 });
  const hydMs = Date.now() - tHyd0;
  console.log(`  hydrate(PG)    ${ms(hydMs)}  candidates_in=${topK.length}  hydrated_out=${hydrated.length}`);

  const tRer0 = Date.now();
  const r = await rerank(queryTextForRerank, hydrated, { topN: RERANK_TOPN });
  const rerMs = Date.now() - tRer0;
  console.log(`  rerank(Jina)   ${ms(rerMs)}  scored=${r.scored}  skipped_empty=${r.skipped_empty}  topN=${RERANK_TOPN}`);
  return { rrfMs, hydMs, rerMs };
}

// ──────────────────────────────────────────────────────────────────────────
// 4. Full run for one query text
// ──────────────────────────────────────────────────────────────────────────
async function profileRun(label, queryTextForEmbed, queryTextForRerank) {
  console.log(`\n==================== ${label} ====================`);
  console.log(`embed_text_chars=${queryTextForEmbed.length}  rerank_text_chars=${queryTextForRerank.length}`);
  console.log("");

  const tTotal = Date.now();

  const tEmb0 = Date.now();
  const q = await embedQuery(queryTextForEmbed);
  const embedMs = Date.now() - tEmb0;
  console.log(`embedQuery     ${ms(embedMs)}  tokens=${q.tokens}  sparse_terms=${q.sparse?.indices?.length ?? 0}  dense_dim=${q.dense.length}  colbert_dim=${q.colbert?.length}×${q.colbert?.[0]?.length}`);
  console.log("");

  console.log("Per-branch:");
  const branchResults = await profileBranches(q);
  const branchSum = Object.values(branchResults).reduce((s, b) => s + (b.elapsed_ms || 0), 0);
  console.log(`  (sum of branches sequentially: ${branchSum}ms; в пайплайне они идут параллельно, реальное retrieval ~ max + RRF)`);
  console.log("");

  console.log("Post-retrieval:");
  const post = await profilePostRetrieval(queryTextForRerank, branchResults);

  const totalMs = Date.now() - tTotal;
  console.log("");
  console.log(`TOTAL (sequential, including HyDE generation if any): ${totalMs}ms`);
  return { embedMs, branchResults, ...post, totalMs };
}

// ──────────────────────────────────────────────────────────────────────────
// 5. main
// ──────────────────────────────────────────────────────────────────────────
async function main() {
  await dumpCollectionConfig();

  console.log("=== HyDE generation ===");
  console.log(`input: ${ORIGINAL_QUERY}`);
  const tHyde0 = Date.now();
  let hydeText;
  try {
    const h = await generateHypotheticalAct(ORIGINAL_QUERY);
    hydeText = h.text;
    console.log(`elapsed_ms=${Date.now() - tHyde0}  model=${h.model}  out_chars=${h.text.length}  finish=${h.finish_reason}  usage=${JSON.stringify(h.usage)}`);
  } catch (e) {
    console.log(`FAIL: ${e?.message}`);
    throw e;
  }

  // Прогон 1: original query во всех ветках (как было до HyDE).
  await profileRun("RUN A: original short query (no HyDE)", ORIGINAL_QUERY, ORIGINAL_QUERY);

  // Прогон 2: HyDE в embed (во всех ветках), rerank на оригинале.
  // Это текущее «полное HyDE» поведение, которое 60+ секунд.
  await profileRun("RUN B: HyDE-text in embed (all branches), rerank on original", hydeText, ORIGINAL_QUERY);

  console.log("\n=== HyDE text (для справки) ===");
  console.log(hydeText);

  await closePool().catch(() => {});
}

main().catch((e) => {
  console.error("FATAL:", e?.stack || e?.message || e);
  process.exit(1);
});
