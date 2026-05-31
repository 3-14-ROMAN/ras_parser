#!/usr/bin/env node
/**
 * backend/tools/ab-full-dense.js — слепой A/B «текущий прод (5 веток)» против
 * «+full_dense (6 веток)». НЕ ходит через withSearchLease, прод не трогает.
 *
 * Чистота эксперимента: на каждый запрос HyDE генерится ОДИН раз, embed ОДИН
 * раз, 6 веток гоняются ОДИН раз. Потом делаются ДВА RRF-слияния поверх одних
 * и тех же branch-результатов:
 *   Mode A (current): full_colbert + full_sparse + long_dense + long_sparse + long_colbert
 *   Mode B (+dense):  то же + full_dense
 * Дальше hydrate + rerank (топ-50 → топ-9) для каждого режима. Единственная
 * переменная — участвует ли full_dense в слиянии.
 *
 * Вывод — текстовый отчёт по каждому запросу: union топ-9 обоих режимов с
 * rerank-позицией в A и B, is_long, case, сниппет act_text для слепой оценки R.
 *
 * Запуск:
 *   node --env-file=.env backend/tools/ab-full-dense.js
 *   OUT=/tmp/ab.txt node --env-file=.env backend/tools/ab-full-dense.js
 */

import fs from "node:fs";
import {
  embedQuery,
  branchFullColbert,
  branchFullSparse,
  branchFullDense,
  branchLongDense,
  branchLongSparse,
  branchLongColbert,
  rrfMerge,
  DEFAULT_RRF_WEIGHTS,
} from "../embed/retrieval.js";
import { hydrateForRerank } from "../embed/hydrate.js";
import { rerank } from "../embed/rerank.js";
import { generateHypotheticalAct } from "../llm/hydeGenerator.js";
import { closePool } from "../db/pgClient.js";

const PER_BRANCH_LIMIT = 100;
const GROUP_SIZE       = 3;
const RRF_K            = 60;
const RRF_TOPK         = 50;
const TOPN             = 9;
const SNIPPET          = 480;
const OUT              = process.env.OUT || "/tmp/ab_full_dense.txt";

// Набор запросов — типичные сценарии споров по поставке (3.1). Можно
// переопределить через QUERIES (разделитель — '||').
const QUERIES = (process.env.QUERIES
  ? process.env.QUERIES.split("||").map((s) => s.trim()).filter(Boolean)
  : [
      "по договору поставки внесена предоплата, поставщик товар не поставил, хочу вернуть аванс и взыскать проценты по ст. 487 ГК РФ",
      "взыскание задолженности за поставленный товар и договорной неустойки за просрочку оплаты",
      "поставлен товар ненадлежащего качества, требую расторжения договора поставки и возврата уплаченных денег",
      "поставщик допустил недопоставку товара, взыскание убытков и неустойки по договору поставки",
      "просрочка поставки товара, начисление пени по договору, односторонний отказ покупателя от договора",
      "покупатель не оплатил поставленный товар в срок, взыскание основного долга и процентов по ст. 395 ГК РФ",
    ]);

const FIVE = ["full_colbert", "full_sparse", "long_dense", "long_sparse", "long_colbert"];
const SIX  = ["full_colbert", "full_sparse", "full_dense", "long_dense", "long_sparse", "long_colbert"];

function pickBranchIds(branchResults, names) {
  const o = {};
  for (const n of names) o[n] = branchResults[n]?.actIds ?? [];
  return o;
}

async function fuseHydrateRerank(query, branchResults, names) {
  const merged = rrfMerge(pickBranchIds(branchResults, names), DEFAULT_RRF_WEIGHTS, RRF_K);
  const topK = merged.slice(0, RRF_TOPK).map(([act_id, score, ranks]) => ({ act_id, score, ranks }));
  const hydrated = await hydrateForRerank(topK, branchResults, { chunkWindow: 1 });
  const r = await rerank(query, hydrated, { topN: TOPN });
  return { merged, ranked: r.ranked ?? [] };
}

const snip = (t) => (t ? String(t).replace(/\s+/g, " ").trim().slice(0, SNIPPET) : "");

function rerankPos(ranked, actId) {
  const hit = ranked.find((r) => r.act_id === actId);
  return hit ? hit.rerank_rank : null;
}

async function runQuery(idx, query, out) {
  out(`\n\n################ Q${idx + 1} ################`);
  out(`QUERY: ${query}`);

  let hyde = query;
  try {
    const h = await generateHypotheticalAct(query);
    hyde = h.text;
    out(`hyde_chars=${h.text.length} model=${h.model}`);
  } catch (e) {
    out(`hyde_FAIL (${e?.message}) — embed on original query`);
  }

  const q = await embedQuery(hyde);
  const bOpts = { limit: PER_BRANCH_LIMIT };
  const lOpts = { limit: PER_BRANCH_LIMIT, groupSize: GROUP_SIZE };
  const [full_colbert, full_sparse, full_dense, long_dense, long_sparse, long_colbert] =
    await Promise.all([
      branchFullColbert(q, bOpts),
      branchFullSparse(q, bOpts),
      branchFullDense(q, bOpts),
      branchLongDense(q, lOpts),
      branchLongSparse(q, lOpts),
      branchLongColbert(q, lOpts),
    ]);
  const branchResults = { full_colbert, full_sparse, full_dense, long_dense, long_sparse, long_colbert };

  // Rerank на ОРИГИНАЛЬНОМ запросе (как в проде), retrieval — на HyDE.
  const A = await fuseHydrateRerank(query, branchResults, FIVE);
  const B = await fuseHydrateRerank(query, branchResults, SIX);

  const topA = A.ranked.slice(0, TOPN);
  const topB = B.ranked.slice(0, TOPN);
  out(`\nMode A (current 5):  ${topA.map((r) => r.act_id.slice(0, 8)).join(" ")}`);
  out(`Mode B (+full_dense): ${topB.map((r) => r.act_id.slice(0, 8)).join(" ")}`);

  // Union, с позициями в обоих.
  const union = new Map();
  for (const r of [...topA, ...topB]) {
    if (!union.has(r.act_id)) union.set(r.act_id, r);
  }
  out(`\n  ${"act".padEnd(8)} ${"A".padStart(2)} ${"B".padStart(2)}  ${"long".padEnd(4)} ${"case".padEnd(18)} snippet`);
  for (const [actId, r] of union) {
    const a = rerankPos(topA, actId);
    const b = rerankPos(topB, actId);
    const isLong = r.meta?.is_long_act === true ? "long" : "shrt";
    const cs = (r.meta?.case_number ?? "-").padEnd(18);
    const flag = (a == null || b == null) ? " <DIFF>" : "";
    out(`  ${actId.slice(0, 8)} ${String(a ?? "—").padStart(2)} ${String(b ?? "—").padStart(2)}  ${isLong.padEnd(4)} ${cs}${flag}`);
    out(`      ${snip(r.text)}`);
  }
}

async function main() {
  const lines = [];
  const out = (s) => { lines.push(s); process.stdout.write(s + "\n"); };
  out(`=== A/B full_dense — ${new Date().toISOString()} ===`);
  out(`queries=${QUERIES.length} per_branch_limit=${PER_BRANCH_LIMIT} rrf_topk=${RRF_TOPK} topN=${TOPN}`);

  for (let i = 0; i < QUERIES.length; i++) {
    try {
      await runQuery(i, QUERIES[i], out);
    } catch (e) {
      out(`\nQ${i + 1} FAILED: ${e?.stack || e?.message || e}`);
    }
  }
  fs.writeFileSync(OUT, lines.join("\n"), "utf8");
  out(`\n\n=== written to ${OUT} ===`);
  await closePool().catch(() => {});
}

main().catch((e) => { console.error("FATAL:", e?.stack || e); process.exit(1); });
