/**
 * Smoke-тест на applyTokenBudget из embed/rerank.js.
 *
 * Цель: проверить stop-on-first-overflow и effective = min(tokens, maxDoc)
 * без реальных HTTP-вызовов (используем заранее заданные tokens_jina_v3 +
 * kind != "window", чтобы код шёл по пути "db").
 *
 * Запуск:
 *   node embed/rerank.budget.smoke.mjs
 */

import assert from "node:assert/strict";

import { applyTokenBudget, estimateTokens } from "./rerank.js";

function makeItem(actId, tokens, kind = "full_act") {
  return {
    act_id: actId,
    text: "x".repeat(Math.max(1, tokens * 3)), // примерно соответствует counted
    kind,
    tokens_jina_v3: tokens,
    rrf_score: 1 / (Number(actId.replace(/\D/g, "")) || 1),
    rrf_ranks: {},
    meta: {},
    text_chars: tokens * 3,
    truncated: false,
  };
}

// ── Сценарий A: per-doc cap, все влезают. ─────────────────────────────────
{
  const items = [
    makeItem("a1", 1000),
    makeItem("a2", 5000), // effective = 2000
    makeItem("a3", 1500),
    makeItem("a4", 800),
    makeItem("a5", 1200),
  ];
  const r = await applyTokenBudget(items, { maxDocLength: 2000, budget: 8000 });
  // effective sums: 1000 + 2000 + 1500 + 800 + 1200 = 6500
  assert.equal(r.included.length, 5, "A: все 5 должны влезть");
  assert.equal(r.dropped.length, 0);
  assert.equal(r.used_tokens, 6500);
  assert.equal(r.mode, "per_doc_cap", "A: mode=per_doc_cap");
  assert.equal(r.max_candidate_tokens, 5000, "A: max_candidate из real tokens, не из effective");
  assert.equal(r.counts.db, 5, "A: все из БД (kind=full + tokens_jina_v3 есть)");
  console.log("[ok] A: per-doc cap=2000, все влезают (used=6500/8000, max_cand=5000)");
}

// ── Сценарий A2: тот же набор, что A, но maxDocLength=2048 (как продовый). ─
//                Это явная проверка пункта 7: "max_doc_length=2048 still caps as before".
{
  const items = [
    makeItem("a1", 500),
    makeItem("a2", 10000), // effective=2048
    makeItem("a3", 3000),  // effective=2048
    makeItem("a4", 1500),
  ];
  const r = await applyTokenBudget(items, { maxDocLength: 2048, budget: 8000 });
  // effective: 500 + 2048 + 2048 + 1500 = 6096
  assert.equal(r.mode, "per_doc_cap");
  assert.equal(r.included.length, 4);
  assert.equal(r.used_tokens, 6096, `A2: used=${r.used_tokens} expected 6096`);
  assert.equal(r.max_candidate_tokens, 10000);
  console.log("[ok] A2: max_doc_length=2048 caps as before (used=6096)");
}

// ── Сценарий B: stop-on-first-overflow. ────────────────────────────────────
{
  const items = [
    makeItem("b1", 1000), // +1000 = 1000
    makeItem("b2", 2500), // effective=2000, +2000 = 3000
    makeItem("b3", 1500), // +1500 = 4500 > 4000 → STOP
    makeItem("b4", 100),  // не пробуем (stop-on-first-overflow)
    makeItem("b5", 50),
  ];
  const r = await applyTokenBudget(items, { maxDocLength: 2000, budget: 4000 });
  assert.equal(r.included.length, 2, "B: только 2 влезли (b1, b2)");
  assert.equal(r.dropped.length, 3, "B: b3, b4, b5 в dropped (stop-on-first)");
  assert.deepEqual(r.included.map((x) => x.act_id), ["b1", "b2"]);
  assert.deepEqual(r.dropped.map((x) => x.act_id), ["b3", "b4", "b5"]);
  assert.equal(r.used_tokens, 3000);
  console.log("[ok] B: stop-on-first-overflow (included=2, dropped=3)");
}

// ── Сценарий C: первый кандидат сам по себе больше budget'а. ───────────────
{
  const items = [makeItem("c1", 10000), makeItem("c2", 100)];
  const r = await applyTokenBudget(items, { maxDocLength: 5000, budget: 4000 });
  // effective c1 = 5000 > 4000 → STOP at i=0
  assert.equal(r.included.length, 0, "C: ничего не влезло");
  assert.equal(r.dropped.length, 2);
  assert.equal(r.used_tokens, 0);
  console.log("[ok] C: первый не влезает — пустой included");
}

// ── Сценарий D: full_act всегда доверяет db-кэшу. ─────────────────────────
//                После перехода на full_act-only window-логики нет; счёт
//                из БД tokens_jina_v3 — авторитет. Никаких HTTP-вызовов.
{
  const items = [
    {
      act_id: "d1",
      text: "x".repeat(50000), // длина мало значит — мы доверяем db
      kind: "full_act",
      tokens_jina_v3: 1500,
      rrf_score: 0.5,
      rrf_ranks: {},
      meta: {},
      text_chars: 50000,
      truncated: false,
    },
    {
      act_id: "d2",
      kind: "full_act",
      tokens_jina_v3: 800,
      text: "y".repeat(20000),
      rrf_score: 0.4,
      rrf_ranks: {},
      meta: {},
      text_chars: 20000,
      truncated: false,
    },
  ];
  const r = await applyTokenBudget(items, { maxDocLength: 0, budget: 10000 });
  assert.equal(r.included.length, 2, "D: оба влезают");
  assert.equal(r.used_tokens, 2300, "D: 1500 + 800 = 2300 из db");
  assert.equal(r.counts.db, 2, "D: source counts должен быть только db");
  assert.equal(r.counts.inference, 0, "D: никакого HTTP");
  assert.equal(r.counts.estimate, 0, "D: никакого estimate");
  console.log("[ok] D: full_act всегда из db (counts={db:2,inference:0,estimate:0})");
}

// ── Сценарий E: estimateTokens — сам по себе. ──────────────────────────────
{
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens(null), 0);
  assert.equal(estimateTokens(undefined), 0);
  assert.equal(estimateTokens("xxxxxxx"), 2, "7/3.5 = 2");
  console.log("[ok] E: estimateTokens edge cases");
}

// ── Сценарий F: maxDocLength=0 — no cap, effective = full token count. ────
{
  const items = [
    makeItem("f1", 3000),  // > старого cap 2048 — теперь должно зайти как 3000
    makeItem("f2", 8000),
    makeItem("f3", 12000),
    makeItem("f4", 2500),
  ];
  const r = await applyTokenBudget(items, { maxDocLength: 0, budget: 50000 });
  // effective = full tokens, sum = 3000 + 8000 + 12000 + 2500 = 25500
  assert.equal(r.mode, "full_docs_no_per_doc_cap", "F: mode=full_docs_no_per_doc_cap");
  assert.equal(r.included.length, 4, "F: все 4 акта влезают в 50K без cap'а");
  assert.equal(r.dropped.length, 0);
  assert.equal(r.used_tokens, 25500, `F: used=${r.used_tokens}, ждали 25500`);
  assert.equal(r.max_candidate_tokens, 12000);
  // Проверяем что каждый _tokens_effective = real (не cap'нут).
  assert.equal(r.included[2]._tokens_effective, 12000, "F: f3 effective=12000 (full)");
  console.log("[ok] F: maxDocLength=0 → no cap, full tokens packed (used=25500)");
}

// ── Сценарий G: maxDocLength=0 + stop-on-first-overflow. ──────────────────
{
  const items = [
    makeItem("g1", 5000),   // +5000 = 5000
    makeItem("g2", 8000),   // +8000 = 13000
    makeItem("g3", 9000),   // +9000 = 22000 > 20000 → STOP
    makeItem("g4", 100),    // не пробуем
    makeItem("g5", 50),
  ];
  const r = await applyTokenBudget(items, { maxDocLength: 0, budget: 20000 });
  assert.equal(r.mode, "full_docs_no_per_doc_cap");
  assert.equal(r.included.length, 2, "G: только g1+g2 влезли");
  assert.equal(r.dropped.length, 3, "G: g3, g4, g5 в dropped (stop-on-first)");
  assert.deepEqual(r.included.map((x) => x.act_id), ["g1", "g2"]);
  assert.equal(r.used_tokens, 13000);
  console.log("[ok] G: no-cap + stop-on-first-overflow (included=2, dropped=3)");
}

// ── Сценарий H: maxDocLength=-1 (negative тоже трактуется как no-cap). ────
{
  const items = [makeItem("h1", 4096), makeItem("h2", 4096)];
  const r = await applyTokenBudget(items, { maxDocLength: -1, budget: 10000 });
  assert.equal(r.mode, "full_docs_no_per_doc_cap", "H: negative тоже no-cap");
  assert.equal(r.included.length, 2);
  assert.equal(r.used_tokens, 8192, "H: 4096+4096 без обрезки");
  console.log("[ok] H: maxDocLength=-1 trated as no-cap");
}

console.log("\nALL BUDGET SMOKE SCENARIOS OK");
