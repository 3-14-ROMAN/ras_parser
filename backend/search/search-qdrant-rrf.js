#!/usr/bin/env node
/**
 * backend/search/search-qdrant-rrf.js — CLI: 4-ветвенный retrieval + RRF.
 *
 * Тонкая обёртка над embed/retrieval.js — печатает per-branch top-5 и
 * финальный RRF top-N. Пайплайн merge'а и сами ветки — в модуле,
 * чтобы их можно было переиспользовать из reranker'а (Шаг 5) и
 * будущего HTTP-API.
 *
 * Запуск:
 *   node --env-file=.env backend/search/search-qdrant-rrf.js "взыскание задолженности"
 *   npm run embed:search -- "взыскание задолженности"
 *
 * ENV:
 *   RAS_RRF_TOPK            сколько финал-кандидатов печатать (20)
 *   RAS_RRF_BRANCH_LIMIT    лимит каждой ветки (100)
 *   RAS_RRF_GROUP_SIZE      group_size для long_* веток (3)
 *   RAS_RRF_K               коэффициент RRF (60)
 */

import process from "node:process";

import { searchAll } from "../embed/retrieval.js";
import { closePool } from "../db/pgClient.js";

const query =
  process.argv.slice(2).join(" ") ||
  "Взыскание задолженности по договору поставки. Покупатель получил товар, но не оплатил его в срок.";

const TOP_K           = Number(process.env.RAS_RRF_TOPK         ?? 20);
const BRANCH_LIMIT    = Number(process.env.RAS_RRF_BRANCH_LIMIT ?? 100);
const GROUP_SIZE      = Number(process.env.RAS_RRF_GROUP_SIZE   ?? 3);
const RRF_K           = Number(process.env.RAS_RRF_K            ?? 60);

function printBranchPoints(name, payload, n = 5) {
  const points = payload.points ?? [];
  console.log(`\n[${name}] points=${points.length} unique_acts=${payload.actIds.length}`);
  for (let i = 0; i < Math.min(points.length, n); i++) {
    const p = points[i];
    const pl = p.payload ?? {};
    console.log(
      `  ${i + 1}. score=${(p.score ?? 0).toFixed(4)} act=${pl.act_id} case=${pl.case_number} unit=${pl.unit_type} chunk=${pl.chunk_id ?? "-"}`,
    );
  }
}

function printBranchGroups(name, payload, n = 5) {
  const groups = payload.groups ?? [];
  console.log(`\n[${name}] groups=${groups.length} unique_acts=${payload.actIds.length}`);
  for (let i = 0; i < Math.min(groups.length, n); i++) {
    const g = groups[i];
    const topHit = g.hits?.[0];
    const pl = topHit?.payload ?? {};
    const hitsCount = g.hits?.length ?? 0;
    console.log(
      `  ${i + 1}. act=${g.id} top_score=${(topHit?.score ?? 0).toFixed(4)} case=${pl.case_number} hits=${hitsCount} top_chunk=${pl.chunk_id}`,
    );
  }
}

async function main() {
  console.log(`[query] "${query}"`);

  const t0 = Date.now();
  const result = await searchAll(query, {
    perBranchLimit: BRANCH_LIMIT,
    groupSize:      GROUP_SIZE,
    rrfK:           RRF_K,
    topK:           TOP_K,
  });
  console.log(
    `[embed] query_tokens=${result.query.tokens} sparse_terms=${result.query.sparseTerms} | took=${Date.now() - t0}ms`,
  );

  printBranchPoints("full_colbert", result.branches.full_colbert);
  printBranchPoints("full_sparse",  result.branches.full_sparse);
  printBranchGroups("long_dense",   result.branches.long_dense);
  printBranchGroups("long_sparse",  result.branches.long_sparse);

  console.log(`\n[RRF top-${TOP_K}]`);
  if (result.topK.length === 0) {
    console.log("  (пусто) — индекс пуст или ни одна ветка ничего не вернула");
  }
  for (let i = 0; i < result.topK.length; i++) {
    const r = result.topK[i];
    const ranks = Object.entries(r.ranks)
      .map(([b, rank]) => `${b}=${rank}`)
      .join(" ");
    console.log(
      `  ${String(i + 1).padStart(2)}. ${r.score.toFixed(6)} act=${r.act_id} [${ranks}]`,
    );
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
