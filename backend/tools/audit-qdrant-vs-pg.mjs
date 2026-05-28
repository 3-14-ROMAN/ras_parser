#!/usr/bin/env node
import "../network/loadEnv.js";
import { getPool } from "../db/pgClient.js";

const QDRANT = process.env.RAS_QDRANT_URL || "http://127.0.0.1:6333";
const COLLECTION = process.env.RAS_QDRANT_COLLECTION || "ras_acts";

async function scrollAllActIds() {
  const seen = new Set();
  let offset = null;
  let pages = 0;
  while (true) {
    const body = {
      limit: 10000,
      with_payload: ["act_id"],
      with_vector: false,
    };
    if (offset !== null) body.offset = offset;
    const r = await fetch(`${QDRANT}/collections/${COLLECTION}/points/scroll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`scroll ${r.status}: ${await r.text()}`);
    const data = await r.json();
    const pts = data.result?.points ?? [];
    for (const p of pts) {
      const aid = p.payload?.act_id;
      if (aid) seen.add(aid);
    }
    pages += 1;
    process.stdout.write(`  page=${pages} got=${pts.length} unique_act_ids=${seen.size}\n`);
    offset = data.result?.next_page_offset ?? null;
    if (!offset) break;
  }
  return seen;
}

async function main() {
  console.log("[audit] scrolling Qdrant for distinct act_id…");
  const qdrantActIds = await scrollAllActIds();
  console.log(`[audit] Qdrant distinct act_ids: ${qdrantActIds.size}`);

  const pool = await getPool();
  const indexedRes = await pool.query(
    `SELECT id::text FROM acts WHERE vector_status='indexed'`,
  );
  const pgIndexed = new Set(indexedRes.rows.map((r) => r.id));
  console.log(`[audit] PG indexed: ${pgIndexed.size}`);

  // 1) Orphan в Qdrant — есть в Qdrant, но нет в PG (вообще нет или не indexed)
  const allInPgRes = await pool.query(`SELECT id::text FROM acts`);
  const pgAll = new Set(allInPgRes.rows.map((r) => r.id));
  const orphansNotInPg = [];
  const inQdrantButNotIndexedPg = [];
  for (const aid of qdrantActIds) {
    if (!pgAll.has(aid)) orphansNotInPg.push(aid);
    else if (!pgIndexed.has(aid)) inQdrantButNotIndexedPg.push(aid);
  }
  console.log(`[audit] orphans in Qdrant NOT in PG at all: ${orphansNotInPg.length}`);
  if (orphansNotInPg.length > 0) console.log("  examples:", orphansNotInPg.slice(0, 10));
  console.log(`[audit] in Qdrant but PG status != indexed: ${inQdrantButNotIndexedPg.length}`);
  if (inQdrantButNotIndexedPg.length > 0) {
    const sample = await pool.query(
      `SELECT id::text, vector_status, verdict_keep, vector_error FROM acts WHERE id::text = ANY($1::text[]) LIMIT 20`,
      [inQdrantButNotIndexedPg.slice(0, 50)],
    );
    console.log("  sample:", sample.rows);
  }

  // 2) PG indexed но нет в Qdrant — embed-worker сказал что indexed, а точки нет
  const indexedNotInQdrant = [];
  for (const aid of pgIndexed) {
    if (!qdrantActIds.has(aid)) indexedNotInQdrant.push(aid);
  }
  console.log(`[audit] PG indexed but NOT in Qdrant: ${indexedNotInQdrant.length}`);
  if (indexedNotInQdrant.length > 0) console.log("  examples:", indexedNotInQdrant.slice(0, 10));

  // 3) verdict_keep аудит — если в Qdrant есть act_id с verdict_keep=false в PG
  const keepFalseInQdrant = await pool.query(
    `SELECT count(*)::int AS n FROM acts WHERE id::text = ANY($1::text[]) AND verdict_keep IS NOT TRUE`,
    [[...qdrantActIds]],
  );
  console.log(`[audit] Qdrant acts whose PG verdict_keep IS NOT TRUE: ${keepFalseInQdrant.rows[0].n}`);

  // 4) typeid sanity — все Qdrant act'ы должны проходить filter
  const SPECIFIC = new Set([
    "75babf17-1eef-40df-b51a-92957310aab7",
    "edac92ae-4dbe-49d7-8412-2fc7f4d5e827",
    "ae1a12e4-23b3-4f9a-9c26-3793218ea772",
  ]);
  const UMBRELLA = "23f4baa9-e7cc-407a-aba7-11dd8772aa3b";
  const UMBRELLA_OK = new Set([
    "1c35af3f-06d5-4b90-b4be-5a3c4148d8be",
    "08f888a2-83ad-4fdf-8985-f77fe2085f11",
    "1d294878-a2f8-471d-a55b-faee3b33da53",
    "08cbe371-f82b-423b-9252-3211c4a3f52e",
    "b74eecb7-28bd-470d-89bc-bc7fe46e8f6f",
    "9d26156d-a770-43cf-81f9-def01baf3e77",
    "171b5aca-eaa6-4e2b-b68c-42489b2e100c",
    "cfd700af-8d88-4171-99d5-7ed2008657c3",
    "db0af13c-2d10-4677-812e-c55e90a894bd",
    "8a67b151-5fb1-4fe0-9068-24a5895d41ba",
  ]);
  const tidRes = await pool.query(
    `SELECT id::text, lower(type_id::text) AS tid,
            lower(coalesce(split_part(content_types_string,' ',1),'')) AS first_cts
       FROM acts WHERE id::text = ANY($1::text[])`,
    [[...qdrantActIds]],
  );
  let bad = 0;
  const badExamples = [];
  for (const row of tidRes.rows) {
    let ok = false;
    if (SPECIFIC.has(row.tid)) ok = true;
    else if (row.tid === UMBRELLA && UMBRELLA_OK.has(row.first_cts)) ok = true;
    if (!ok) {
      bad += 1;
      if (badExamples.length < 10) badExamples.push(row);
    }
  }
  console.log(`[audit] Qdrant acts FAILING filter logic (specific OR umbrella+allowlist): ${bad}`);
  if (bad > 0) console.log("  examples:", badExamples);

  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
