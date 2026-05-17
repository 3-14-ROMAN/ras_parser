const QDRANT_URL =
  process.env.QDRANT_URL ||
  process.env.RAS_QDRANT_URL ||
  "http://127.0.0.1:6333";

const INFERENCE_URL =
  process.env.INFERENCE_URL ||
  process.env.RAS_INFERENCE_URL ||
  "http://127.0.0.1:8000";

const COLLECTION =
  process.env.QDRANT_COLLECTION ||
  process.env.RAS_QDRANT_COLLECTION ||
  "ras_acts";

const query =
  process.argv.slice(2).join(" ") ||
  "Взыскание задолженности по договору поставки. Покупатель получил товар, но не оплатил его в срок.";

async function postJson(url, body, timeoutMs = 180000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });

    const text = await res.text();

    if (!res.ok) {
      throw new Error(`${res.status} ${url}: ${text.slice(0, 1000)}`);
    }

    return JSON.parse(text);
  } finally {
    clearTimeout(t);
  }
}

function filterUnit(unitType) {
  return {
    must: [
      { key: "unit_type", match: { value: unitType } },
      { key: "has_colbert", match: { value: true } },
    ],
  };
}

function actIdFromPoint(p) {
  return p?.payload?.act_id || p?.id;
}

function rankedUniqueActIds(points) {
  const out = [];
  const seen = new Set();

  for (const p of points || []) {
    const actId = actIdFromPoint(p);
    if (!actId || seen.has(actId)) continue;
    seen.add(actId);
    out.push(actId);
  }

  return out;
}

function rrfMerge(branches, weights = {}, k = 60) {
  const scores = new Map();

  for (const [branchName, actIds] of Object.entries(branches)) {
    const w = weights[branchName] ?? 1.0;
    const seen = new Set();

    actIds.forEach((actId, idx) => {
      if (!actId || seen.has(actId)) return;
      seen.add(actId);

      const rank = idx + 1;
      scores.set(actId, (scores.get(actId) || 0) + w / (k + rank));
    });
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1]);
}

async function queryBranch(name, unitType, colbert, muvera, limit = 20) {
  const flt = filterUnit(unitType);

  const body = {
    prefetch: {
      query: muvera,
      using: "muvera",
      filter: flt,
      limit: Math.max(50, limit * 5),
    },
    query: colbert,
    using: "colbert",
    filter: flt,
    limit,
    with_payload: [
      "act_id",
      "case_number",
      "court",
      "registration_date",
      "unit_type",
      "chunk_id",
    ],
    with_vector: false,
  };

  const res = await postJson(
    `${QDRANT_URL}/collections/${COLLECTION}/points/query`,
    body,
  );

  const points = res?.result?.points || [];

  console.log(`\n[${name}] points=${points.length}`);
  points.slice(0, 5).forEach((p, i) => {
    const pl = p.payload || {};
    console.log(
      `${i + 1}. score=${p.score} act=${pl.act_id} case=${pl.case_number} unit=${pl.unit_type} chunk=${pl.chunk_id}`,
    );
  });

  return { points, actIds: rankedUniqueActIds(points) };
}

async function main() {
  console.log(`[query] ${query}`);

  const emb = await postJson(`${INFERENCE_URL}/embed`, { texts: [query] });
  const colbert = emb.multivectors?.[0];
  const muvera = emb.muvera_vectors?.[0];

  if (!Array.isArray(colbert) || !Array.isArray(colbert[0])) {
    throw new Error("bad multivectors from /embed");
  }

  if (!Array.isArray(muvera)) {
    throw new Error("bad muvera_vectors from /embed");
  }

  console.log(`[embed] colbert=${colbert.length}x${colbert[0].length} muvera=${muvera.length}`);

  const full = await queryBranch("full_colbert", "full_act", colbert, muvera, 20);
  const chunks = await queryBranch("chunk_colbert", "chunk", colbert, muvera, 20);

  const merged = rrfMerge(
    {
      full_colbert: full.actIds,
      chunk_colbert: chunks.actIds,
    },
    {
      full_colbert: 1.15,
      chunk_colbert: 1.0,
    },
  );

  console.log("\n[RRF top]");
  merged.slice(0, 20).forEach(([actId, score], i) => {
    console.log(`${i + 1}. ${score.toFixed(6)} ${actId}`);
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
