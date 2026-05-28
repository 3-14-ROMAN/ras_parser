/**
 * Unit-тест приоритета `RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE`.
 *
 * Запуск: `npm run test:config-target-override`
 *
 * Проверяет:
 *   1) при OVERRIDE=2,180 и базовом RAS_PDF_TARGET_COUNTRY_IDS=82,145,22 → [2,180] (source=override)
 *   2) без OVERRIDE, c RAS_PDF_TARGET_COUNTRY_IDS=82,145,22 → [82,145,22] (source=env)
 *   3) без обоих, с poolIds → копирует пул (source=pool)
 *   4) без обоих и без пула → default (source=default)
 *   5) OVERRIDE=all → [] (source=all, без ограничения)
 *   6) OVERRIDE с мусором → fallback на env (source=env)
 */

import assert from "node:assert/strict";

import { _parsePdfTargetCountryIds } from "./config.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  const saved = {
    OVR: process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE,
    BASE: process.env.RAS_PDF_TARGET_COUNTRY_IDS,
  };
  try {
    fn();
    pass += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (e) {
    fail += 1;
    process.stdout.write(`FAIL ${name}\n  ${e && (e.stack ?? e.message ?? e)}\n`);
  } finally {
    if (saved.OVR === undefined) delete process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE;
    else process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE = saved.OVR;
    if (saved.BASE === undefined) delete process.env.RAS_PDF_TARGET_COUNTRY_IDS;
    else process.env.RAS_PDF_TARGET_COUNTRY_IDS = saved.BASE;
  }
}

// ── 1) override wins over env ───────────────────────────────────────────────
test("override beats env: OVR=[2,180], env=[82,145,22] → [2,180]", () => {
  process.env.RAS_PDF_TARGET_COUNTRY_IDS = "82,145,22";
  process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE = "2,180";
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, [2, 180]);
  assert.equal(r.source, "override");
});

// ── 2) no override, env present ────────────────────────────────────────────
test("no override → env wins: env=[82,145,22] → [82,145,22]", () => {
  delete process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE;
  process.env.RAS_PDF_TARGET_COUNTRY_IDS = "82,145,22";
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, [82, 145, 22]);
  assert.equal(r.source, "env");
});

// ── 3) no override / no env, pool present ──────────────────────────────────
test("no env, poolIds=[22,82,145] → copy pool", () => {
  delete process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE;
  delete process.env.RAS_PDF_TARGET_COUNTRY_IDS;
  const r = _parsePdfTargetCountryIds([22, 82, 145]);
  assert.deepEqual(r.ids, [22, 82, 145]);
  assert.equal(r.source, "pool");
});

// ── 4) no env, no pool → default ───────────────────────────────────────────
test("no env, no pool → default [22,82,145]", () => {
  delete process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE;
  delete process.env.RAS_PDF_TARGET_COUNTRY_IDS;
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, [22, 82, 145]);
  assert.equal(r.source, "default");
});

// ── 5) OVERRIDE=all → unrestricted ─────────────────────────────────────────
test("OVERRIDE=all → [] (no restriction)", () => {
  process.env.RAS_PDF_TARGET_COUNTRY_IDS = "82,145,22";
  process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE = "all";
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, []);
  assert.equal(r.source, "all");
});

// ── 6) OVERRIDE с мусором (нет валидных id) → fallback на env ──────────────
test("OVERRIDE garbage → fallback to env", () => {
  process.env.RAS_PDF_TARGET_COUNTRY_IDS = "82,145,22";
  process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE = "abc, , -1";
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, [82, 145, 22]);
  assert.equal(r.source, "env");
});

// ── 7) OVERRIDE пустая строка → как будто не задан ─────────────────────────
test("OVERRIDE='' → ignored, env wins", () => {
  process.env.RAS_PDF_TARGET_COUNTRY_IDS = "82,145,22";
  process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE = "";
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, [82, 145, 22]);
  assert.equal(r.source, "env");
});

// ── 8) OVERRIDE с whitespace разделителями ─────────────────────────────────
test("OVERRIDE='2 180' (whitespace) → [2,180]", () => {
  delete process.env.RAS_PDF_TARGET_COUNTRY_IDS;
  process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE = "2 180";
  const r = _parsePdfTargetCountryIds([]);
  assert.deepEqual(r.ids, [2, 180]);
  assert.equal(r.source, "override");
});

if (fail > 0) {
  process.stdout.write(`\nFAIL: ${fail}, pass: ${pass}\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${pass} tests passed\n`);
