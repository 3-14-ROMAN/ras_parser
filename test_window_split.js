/**
 * Юнит-тесты `splitWindow` — чистой функции дробления окна дат для
 * Query Downgrade в parser.js. Сетевых вызовов не делаем.
 *
 * Запуск:  `node test_window_split.js`
 * (или вместе с эскалатором через `npm test`).
 */

import assert from "node:assert/strict";

import { splitWindow } from "./windowSplit.js";

function ymd(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

const tests = [];
function test(name, fn) {
  tests.push([name, fn]);
}

// ───────────────────────────────────────────────────────────────
// 1. factor=2 для 7 дней → [4, 3] и endDay сдвигается корректно.
// ───────────────────────────────────────────────────────────────

test("split_7_by_2_gives_4_and_3", () => {
  const sub = { endDay: new Date(2026, 3, 7), daysSpan: 7 }; // 2026-04-07
  const parts = splitWindow(sub, 2);
  assert.equal(parts.length, 2);
  assert.equal(parts[0].daysSpan, 4);
  assert.equal(parts[1].daysSpan, 3);
  assert.equal(ymd(parts[0].endDay), "2026-04-07");
  assert.equal(ymd(parts[1].endDay), "2026-04-03");
  const sum = parts.reduce((s, p) => s + p.daysSpan, 0);
  assert.equal(sum, 7);
});

// ───────────────────────────────────────────────────────────────
// 2. factor=4 для 7 дней → [2, 2, 2, 1].
// ───────────────────────────────────────────────────────────────

test("split_7_by_4_gives_2_2_2_1", () => {
  const sub = { endDay: new Date(2026, 3, 7), daysSpan: 7 };
  const parts = splitWindow(sub, 4);
  assert.equal(parts.length, 4);
  assert.deepEqual(
    parts.map((p) => p.daysSpan),
    [2, 2, 2, 1],
  );
  assert.equal(ymd(parts[0].endDay), "2026-04-07");
  assert.equal(ymd(parts[1].endDay), "2026-04-05");
  assert.equal(ymd(parts[2].endDay), "2026-04-03");
  assert.equal(ymd(parts[3].endDay), "2026-04-01");
  const sum = parts.reduce((s, p) => s + p.daysSpan, 0);
  assert.equal(sum, 7);
});

// ───────────────────────────────────────────────────────────────
// 3. daysSpan=1 → возвращаем одно окно неизменным (нечего дробить).
// ───────────────────────────────────────────────────────────────

test("split_1_returns_single_window", () => {
  const sub = { endDay: new Date(2026, 3, 7), daysSpan: 1 };
  const parts = splitWindow(sub, 2);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].daysSpan, 1);
  assert.equal(ymd(parts[0].endDay), "2026-04-07");
});

// ───────────────────────────────────────────────────────────────
// 4. factor=2 для 2 дней → [1, 1].
// ───────────────────────────────────────────────────────────────

test("split_2_by_2_gives_1_and_1", () => {
  const sub = { endDay: new Date(2026, 3, 7), daysSpan: 2 };
  const parts = splitWindow(sub, 2);
  assert.deepEqual(
    parts.map((p) => p.daysSpan),
    [1, 1],
  );
  assert.equal(ymd(parts[0].endDay), "2026-04-07");
  assert.equal(ymd(parts[1].endDay), "2026-04-06");
});

// ───────────────────────────────────────────────────────────────
// 5. Сумма daysSpan строго равна исходному при разных размерах.
// ───────────────────────────────────────────────────────────────

test("split_preserves_total_days", () => {
  for (const days of [1, 2, 3, 5, 7, 10, 14, 30]) {
    for (const factor of [2, 3, 4]) {
      const sub = { endDay: new Date(2026, 3, 30), daysSpan: days };
      const parts = splitWindow(sub, factor);
      const sum = parts.reduce((s, p) => s + p.daysSpan, 0);
      assert.equal(
        sum,
        days,
        `daysSpan=${days}, factor=${factor}: сумма=${sum}, ожидал ${days}`,
      );
    }
  }
});

// ───────────────────────────────────────────────────────────────
// 6. Входной endDay не мутируется (новый Date в каждом элементе).
// ───────────────────────────────────────────────────────────────

test("split_does_not_mutate_input", () => {
  const sub = { endDay: new Date(2026, 3, 7), daysSpan: 7 };
  const before = sub.endDay.getTime();
  const parts = splitWindow(sub, 2);
  const after = sub.endDay.getTime();
  assert.equal(before, after, "splitWindow не должен мутировать sub.endDay");
  assert.notEqual(
    parts[0].endDay,
    sub.endDay,
    "splitWindow должен вернуть НОВЫЙ Date для endDay",
  );
});

// ───────────────────────────────────────────────────────────────
// 7. factor < 2 — возвращаем одно окно (минимум 2 части по контракту).
// ───────────────────────────────────────────────────────────────

test("split_factor_lt_2_returns_single", () => {
  const sub = { endDay: new Date(2026, 3, 7), daysSpan: 7 };
  const parts = splitWindow(sub, 1);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].daysSpan, 7);
});

// ───────────────────────────────────────────────────────────────
// 8. Корректный сдвиг через границу месяца.
// ───────────────────────────────────────────────────────────────

test("split_handles_month_boundary", () => {
  // 2026-04-02, daysSpan=4 → covers 2026-03-30..2026-04-02.
  // factor=2 → [{2026-04-02, 2}, {2026-03-31, 2}].
  const sub = { endDay: new Date(2026, 3, 2), daysSpan: 4 };
  const parts = splitWindow(sub, 2);
  assert.equal(parts.length, 2);
  assert.equal(ymd(parts[0].endDay), "2026-04-02");
  assert.equal(parts[0].daysSpan, 2);
  assert.equal(ymd(parts[1].endDay), "2026-03-31");
  assert.equal(parts[1].daysSpan, 2);
});

(async () => {
  let failed = 0;
  for (const [name, fn] of tests) {
    try {
      await fn();
      process.stdout.write(`  ok  ${name}\n`);
    } catch (e) {
      failed += 1;
      process.stdout.write(`  FAIL ${name}\n${e}\n`);
    }
  }
  if (failed > 0) {
    process.stdout.write(`\n${failed} тест(а) упали\n`);
    process.exit(1);
  }
  process.stdout.write(`\nвсе ${tests.length} тестов прошли\n`);
})();
