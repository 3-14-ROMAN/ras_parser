#!/usr/bin/env node
/**
 * scripts/search-qdrant-rerank.js — CLI: полный pipeline до финального top-N.
 *
 *   query → 4 retrieval-ветки → RRF top-50 → hydrate (PG) → Jina reranker → top-N
 *
 * Тонкая обёртка над embed/retrieval.js::searchAndRerank. Печатает:
 *   • per-branch top-3 (диагностика)
 *   • RRF top-10
 *   • финальный top-N после reranker'а с снипетами
 *
 * Запуск:
 *   node --env-file=.env scripts/search-qdrant-rerank.js "взыскание задолженности"
 *   npm run embed:rerank -- "взыскание задолженности"
 *
 * ENV:
 *   RAS_RRF_TOPK_FOR_RERANK   сколько кандидатов в reranker (50)
 *   RAS_RERANK_TOPN           сколько в финале (5)
 *   RAS_RRF_BRANCH_LIMIT      лимит каждой ветки (100)
 *   RAS_RRF_GROUP_SIZE        group_size для long_* (3)
 *   RAS_RRF_K                 коэффициент RRF (60)
 *   RAS_RERANK_CHUNK_WINDOW   ± соседних чанков для long-актов (1)
 *   RAS_RERANK_MAX_CHARS      char-cap документа ДО /rerank (12000)
 *   RAS_RERANK_MAX_DOC_LENGTH token-cap документа В reranker'е (default из app.py: 2048).
 *                             Если jina-reranker-v3 .rerank() игнорирует параметр,
 *                             inference сам делает manual token-truncation.
 *   RAS_RERANK_MAX_QUERY_LENGTH token-cap query в reranker'е (default 512).
 *   Legacy-имена RAS_RERANKER_MAX_DOC_LENGTH / RAS_RERANKER_MAX_QUERY_LENGTH
 *   тоже читаются (в rerank.js), новые имена имеют приоритет.
 */

import process from "node:process";

import { searchAndRerank } from "../embed/retrieval.js";
import { closePool } from "../db/pgClient.js";

const query =
  process.argv.slice(2).join(" ") ||
  "Взыскание задолженности по договору поставки. Покупатель получил товар, но не оплатил его в срок.";

const RRF_TOPK_FOR_RERANK = Number(process.env.RAS_RRF_TOPK_FOR_RERANK ?? 50);
const RERANK_TOPN         = Number(process.env.RAS_RERANK_TOPN         ?? 5);
const BRANCH_LIMIT        = Number(process.env.RAS_RRF_BRANCH_LIMIT    ?? 100);
const GROUP_SIZE          = Number(process.env.RAS_RRF_GROUP_SIZE      ?? 3);
const RRF_K               = Number(process.env.RAS_RRF_K               ?? 60);
const CHUNK_WINDOW        = Number(process.env.RAS_RERANK_CHUNK_WINDOW ?? 1);

// Новые имена env (RAS_RERANK_MAX_*) — приоритет; legacy RAS_RERANKER_MAX_*
// читается как fallback в embed/rerank.js. Если ни то ни другое не задано,
// rerank.js использует свои DEFAULT_MAX_*_LENGTH (2048 / 512).
const RERANK_MAX_DOC_LENGTH = process.env.RAS_RERANK_MAX_DOC_LENGTH
  ? Number(process.env.RAS_RERANK_MAX_DOC_LENGTH)
  : null;
const RERANK_MAX_QUERY_LENGTH = process.env.RAS_RERANK_MAX_QUERY_LENGTH
  ? Number(process.env.RAS_RERANK_MAX_QUERY_LENGTH)
  : null;

// MAX_CHARS — char-truncate документа в hydrate.js до отправки в /rerank.
// Резолвится той же ладдер-логикой, что и DEFAULT_MAX_CHARS внутри hydrate.js
// (зеркалим, потому что entry point передаёт maxChars в searchAndRerank явно
// и перекрывает hydrate-резолвер — без зеркала фича авто-снятия молча
// ломалась).
//   1) RAS_RERANK_MAX_CHARS задан явно → его значение.
//   2) RAS_RERANK_MAX_DOC_LENGTH <= 0 (no per-doc cap) → 0 (тоже снять,
//      иначе budget логика разрешит 30K токенов, а реранкер увидит 12K
//      символов).
//   3) Иначе 12000 (исторический дефолт).
const MAX_CHARS = (() => {
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

// TEXT_MODE — какой текст уходит в /rerank. Дефолт "postgres_full_act":
// реранкер ВСЕГДА видит acts.act_text целиком (см. embed/hydrate.js
// HYDRATE_TEXT_MODE). Прокидываем сюда только ради явного лога.
const TEXT_MODE =
  process.env.RAS_RERANK_TEXT_MODE && process.env.RAS_RERANK_TEXT_MODE.trim() !== ""
    ? process.env.RAS_RERANK_TEXT_MODE.trim()
    : "postgres_full_act";

function printBranchPoints(name, payload, n = 3) {
  const points = payload?.points ?? [];
  console.log(`\n[${name}] points=${points.length} unique_acts=${payload?.actIds?.length ?? 0}`);
  for (let i = 0; i < Math.min(points.length, n); i++) {
    const p = points[i];
    const pl = p.payload ?? {};
    console.log(
      `  ${i + 1}. score=${(p.score ?? 0).toFixed(4)} act=${pl.act_id} case=${pl.case_number} unit=${pl.unit_type}`,
    );
  }
}

function printBranchGroups(name, payload, n = 3) {
  const groups = payload?.groups ?? [];
  console.log(`\n[${name}] groups=${groups.length} unique_acts=${payload?.actIds?.length ?? 0}`);
  for (let i = 0; i < Math.min(groups.length, n); i++) {
    const g = groups[i];
    const top = g.hits?.[0];
    const pl = top?.payload ?? {};
    console.log(
      `  ${i + 1}. act=${g.id} top_score=${(top?.score ?? 0).toFixed(4)} case=${pl.case_number} hits=${g.hits?.length ?? 0} top_chunk=${pl.chunk_id}`,
    );
  }
}

function snippet(text, n = 280) {
  if (!text) return "(пусто)";
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

async function main() {
  console.log(`[query] "${query}"`);
  console.log(
    `[cfg] text_mode=${TEXT_MODE} ` +
    `rrf_topk=${RRF_TOPK_FOR_RERANK} rerank_topn=${RERANK_TOPN} ` +
    `branch_limit=${BRANCH_LIMIT} group_size=${GROUP_SIZE} rrf_k=${RRF_K} ` +
    `chunk_window=${CHUNK_WINDOW}(debug-only) max_chars=${MAX_CHARS > 0 ? MAX_CHARS : "off"} ` +
    `max_doc_length=${RERANK_MAX_DOC_LENGTH ?? "(default)"} ` +
    `max_query_length=${RERANK_MAX_QUERY_LENGTH ?? "(default)"}`,
  );

  const t0 = Date.now();
  const result = await searchAndRerank(query, {
    perBranchLimit:        BRANCH_LIMIT,
    groupSize:             GROUP_SIZE,
    rrfK:                  RRF_K,
    rrfTopK:               RRF_TOPK_FOR_RERANK,
    topN:                  RERANK_TOPN,
    chunkWindow:           CHUNK_WINDOW,
    maxChars:              MAX_CHARS,
    rerankMaxDocLength:    RERANK_MAX_DOC_LENGTH ?? undefined,
    rerankMaxQueryLength:  RERANK_MAX_QUERY_LENGTH ?? undefined,
  });
  console.log(
    `\n[embed] query_tokens=${result.query.tokens} sparse_terms=${result.query.sparseTerms} | total=${Date.now() - t0}ms`,
  );
  console.log(
    `[timing] retrieval=${result.timing.retrieval_ms}ms hydrate=${result.timing.hydrate_ms}ms rerank=${result.timing.rerank_ms}ms`,
  );

  printBranchPoints("full_colbert", result.branches.full_colbert);
  printBranchPoints("full_sparse",  result.branches.full_sparse);
  printBranchGroups("long_dense",   result.branches.long_dense);
  printBranchGroups("long_sparse",  result.branches.long_sparse);

  console.log(`\n[RRF top-10] (из ${result.merged.length}, top-${RRF_TOPK_FOR_RERANK} пошли в reranker)`);
  for (let i = 0; i < Math.min(result.topK.length, 10); i++) {
    const r = result.topK[i];
    const ranks = Object.entries(r.ranks).map(([b, k]) => `${b}=${k}`).join(" ");
    console.log(`  ${String(i + 1).padStart(2)}. ${r.score.toFixed(6)} act=${r.act_id} [${ranks}]`);
  }

  console.log(`\n[reranker] model=${result.rerank.model ?? "(none)"} scored=${result.rerank.scored} skipped_empty=${result.rerank.skipped_empty}`);
  console.log(`\n[FINAL top-${RERANK_TOPN}]`);
  if (result.rerank.ranked.length === 0) {
    console.log("  (пусто) — ни один кандидат не дошёл до reranker'а");
  }
  for (let i = 0; i < result.rerank.ranked.length; i++) {
    const r = result.rerank.ranked[i];
    const meta = r.meta ?? {};
    const date = meta.registration_date
      ? (typeof meta.registration_date === "string"
          ? meta.registration_date.slice(0, 10)
          : meta.registration_date.toISOString().slice(0, 10))
      : "?";
    const rerankStr = r.rerank_score === null ? "N/A" : r.rerank_score.toFixed(4);
    // Chunk-инфа теперь debug-only: показывает по каким chunk_id'ам ретривал
    // поднял акт в long_dense/long_sparse. На текст, идущий в реранкер, не
    // влияет — реранкер всегда видит acts.act_text целиком.
    const matched = r.matched_chunk_ids ?? [];
    const debugChunks =
      matched.length > 0
        ? ` matched_chunks=[${matched.join(",")}]/total=${r.total_chunks ?? "?"}`
        : "";
    const tokTag =
      r.tokens_jina_v3 != null
        ? `${r.tokens_jina_v3}${r.tokens_source ? `(${r.tokens_source})` : ""}`
        : "?";
    const textSource = r.text_source ?? (r.kind === "empty" ? "(none)" : "postgres.act_text");
    console.log(
      `  ${String(i + 1).padStart(2)}. rerank=${rerankStr} rrf_rank=${r.rrf_rank} rrf_score=${r.rrf_score.toFixed(4)}`,
    );
    console.log(
      `      act=${r.act_id} case=${meta.case_number ?? "?"} court="${meta.court ?? "?"}" date=${date} il=${meta.true_instance_level ?? "?"} action=${meta.verdict_action ?? "?"}`,
    );
    console.log(
      `      kind=${r.kind} text_source=${textSource} text_chars=${r.text_chars}${r.truncated ? "(truncated)" : ""} tokens_jina_v3=${tokTag}${debugChunks}`,
    );
    console.log(`      snippet: ${snippet(r.text, 240)}`);
  }
}

main()
  .catch((e) => {
    process.stderr.write(`[fatal] ${e?.stack ?? e?.message ?? e}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool().catch(() => {});
  });
