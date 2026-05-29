/**
 * Unit-тесты anti-cloak classifier'а (без сети / API).
 *
 * Запуск: `npm run test:probe-classifier` (или `node backend/proxy-tools/probe-classifier.test.mjs`).
 *
 * Проверяет:
 *   1) classifyAntiCloakResult: нормальный RAS html → recommended=true
 *   2) classifyAntiCloakResult: 451 / pravocaptcha / ddos-guard → recommended=false
 *   3) classifyAntiCloakResult: пустой / крошечный body → recommended=false
 *   4) parseAntiCloakTaskResult: разные shape-ы task result
 *   5) flattenCandidateCountriesFromGeoList: count_free=0 не пропускаем
 *   6) combineUrlVerdicts: страна ok только если ok на ВСЕХ URL
 */

import assert from "node:assert/strict";

import {
  classifyAntiCloakResult,
  combineUrlVerdicts,
  flattenCandidateCountriesFromGeoList,
  normalizeAntiCloakItem,
  parseAntiCloakTaskResult,
} from "./antiCloakClassifier.js";

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    process.stdout.write(`ok   ${name}\n`);
  } catch (e) {
    fail += 1;
    process.stdout.write(`FAIL ${name}\n  ${e && (e.stack ?? e.message ?? e)}\n`);
  }
}

// ── 1) Normal RAS html → recommended=true ──────────────────────────────────
test("normal ras html → recommended=true", () => {
  const body = "<html>" + "x".repeat(20_000) + "</html>";
  const r = classifyAntiCloakResult(
    { content: body, status: 200, time_ms: 800, id_country: 82 },
    { bodyMinBytes: 5000 },
  );
  assert.equal(r.recommended, true);
  assert.equal(r.httpStatus, 200);
  assert.equal(r.latencyMs, 800);
  assert.ok(r.bodyBytes >= 20_000);
  assert.deepEqual(r.markers, []);
});

// ── 2a) HTTP status 451 → bad ──────────────────────────────────────────────
test("status=451 → recommended=false", () => {
  const r = classifyAntiCloakResult(
    { content: "<html>blocked</html>", status: 451 },
    { bodyMinBytes: 5000 },
  );
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("451"));
});

// ── 2b) pravocaptcha в теле → bad ──────────────────────────────────────────
test("pravocaptcha marker → recommended=false", () => {
  const body = "<html>" + "y".repeat(8000) + " var tokenFrom = pravocaptcha.init(); </html>";
  const r = classifyAntiCloakResult({ content: body, status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("pravocaptcha"));
  assert.ok(r.markers.includes("tokenFrom"));
});

// ── 2c) ddos-guard в теле → bad ────────────────────────────────────────────
test("ddos-guard marker → recommended=false", () => {
  const body = "<html><body>DDoS-Guard Just a moment...</body></html>" + "z".repeat(10_000);
  const r = classifyAntiCloakResult({ content: body, status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("ddos-guard"));
});

// ── 3a) пустой body → bad ──────────────────────────────────────────────────
test("empty body → recommended=false marker=empty", () => {
  const r = classifyAntiCloakResult({ content: "" }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("empty"));
});

// ── 3b) tiny body → bad ────────────────────────────────────────────────────
test("tiny body → recommended=false marker=tiny-body", () => {
  const r = classifyAntiCloakResult(
    { content: "<html>short</html>" },
    { bodyMinBytes: 5000 },
  );
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("tiny-body"));
});

// ── 3c) null/undefined → bad ───────────────────────────────────────────────
test("null item → recommended=false", () => {
  const r = classifyAntiCloakResult(null, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.equal(r.bodyBytes, 0);
  assert.ok(r.markers.includes("no-data"));
});

// ── 3d) plain string body ──────────────────────────────────────────────────
test("string body → normalized", () => {
  const n = normalizeAntiCloakItem("hello".repeat(2000));
  assert.equal(n.bodyText.length, 5 * 2000);
  assert.equal(n.bodyBytes, 5 * 2000);
});

// ── 4a) parseAntiCloakTaskResult: by-country object ────────────────────────
test("parseAntiCloakTaskResult: object map by id_country", () => {
  const resp = {
    status: "ready",
    tasks_result: {
      82: { content: "<html>OK kaz</html>" + "k".repeat(20_000), status: 200 },
      2: { content: "<html>blocked</html>", status: 451 },
    },
  };
  const parsed = parseAntiCloakTaskResult(resp);
  assert.equal(parsed.status, "ready");
  assert.ok(parsed.byCountry[82]);
  assert.ok(parsed.byCountry[2]);
});

// ── 4b) parseAntiCloakTaskResult: array with id_country ────────────────────
test("parseAntiCloakTaskResult: array with id_country field", () => {
  const resp = {
    tasks_result: [
      { id_country: 82, content: "ok".repeat(10_000), status: 200 },
      { id_country: 2, content: "blocked", http_status: 451 },
    ],
  };
  const parsed = parseAntiCloakTaskResult(resp);
  assert.equal(parsed.status, "ready");
  assert.equal(Object.keys(parsed.byCountry).length, 2);
  assert.ok(parsed.byCountry[82]);
  assert.ok(parsed.byCountry[2]);
});

// ── 4c) parseAntiCloakTaskResult: pending ──────────────────────────────────
test("parseAntiCloakTaskResult: pending status", () => {
  const resp = { status: "in_progress" };
  const parsed = parseAntiCloakTaskResult(resp);
  assert.equal(parsed.status, "pending");
  assert.deepEqual(parsed.byCountry, {});
});

// ── 5a) flattenCandidateCountriesFromGeoList: count_free filtering ─────────
test("flattenCandidateCountriesFromGeoList: count_free=0 dropped", () => {
  const avail = {
    geo_operator_list: {
      "g1": {
        id_country: 82,
        geo_caption: "Алматы",
        count_free: { "tele2(KZ)": 2, "kcell(KZ)": 0 },
      },
      "g2": {
        id_country: 145,
        geo_caption: "Бишкек",
        count_free: { "megacom(KG)": 0 },
      },
    },
  };
  const candidates = flattenCandidateCountriesFromGeoList(avail);
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].countryId, 82);
  assert.equal(candidates[0].operator, "tele2(KZ)");
  assert.equal(candidates[0].count, 2);
});

// ── 5b) flattenCandidateCountriesFromGeoList: list as array ────────────────
test("flattenCandidateCountriesFromGeoList: list as array also works", () => {
  const avail = {
    geo_operator_list: [
      { id_country: 22, count_free: { "a1(BY)": 1 } },
      { id_country: 1, count_free: { "megafon(RU)": 5 } },
    ],
  };
  const candidates = flattenCandidateCountriesFromGeoList(avail);
  assert.equal(candidates.length, 2);
});

// ── 5c) flattenCandidateCountriesFromGeoList: empty / unknown shape ────────
test("flattenCandidateCountriesFromGeoList: nothing", () => {
  assert.deepEqual(flattenCandidateCountriesFromGeoList(null), []);
  assert.deepEqual(flattenCandidateCountriesFromGeoList({}), []);
  assert.deepEqual(
    flattenCandidateCountriesFromGeoList({ geo_operator_list: "garbage" }),
    [],
  );
});

// ── 6a) combineUrlVerdicts: ok only if ok everywhere ───────────────────────
test("combineUrlVerdicts: ok across ALL URLs", () => {
  const perUrlPerCountry = {
    "https://ras.arbitr.ru/": {
      82: { recommended: true, bodyBytes: 30_000, httpStatus: 200, latencyMs: 100, markers: [], reason: "" },
      2: { recommended: false, bodyBytes: 100, httpStatus: 451, latencyMs: 100, markers: ["451"], reason: "" },
    },
    "https://kad.arbitr.ru/": {
      82: { recommended: true, bodyBytes: 40_000, httpStatus: 200, latencyMs: 100, markers: [], reason: "" },
      2: { recommended: true, bodyBytes: 40_000, httpStatus: 200, latencyMs: 100, markers: [], reason: "" },
    },
  };
  const combined = combineUrlVerdicts(perUrlPerCountry, [82, 2]);
  assert.equal(combined[82].recommended, true);
  assert.equal(combined[82].bodyBytes, 30_000); // min across URLs
  assert.equal(combined[2].recommended, false);
  assert.ok(combined[2].markers.includes("451"));
});

// ── 6b) combineUrlVerdicts: missing on one URL = not recommended ───────────
test("combineUrlVerdicts: missing URL data = not recommended", () => {
  const perUrlPerCountry = {
    "https://ras.arbitr.ru/": {
      82: { recommended: true, bodyBytes: 30_000, httpStatus: 200, latencyMs: 100, markers: [], reason: "" },
    },
    "https://kad.arbitr.ru/": {},
  };
  const combined = combineUrlVerdicts(perUrlPerCountry, [82]);
  assert.equal(combined[82].recommended, false);
  assert.ok(combined[82].markers.includes("no-data"));
});

// ── 7) httpStatus 200 + clean body, no markers ─────────────────────────────
test("clean body with status 200 and large enough body", () => {
  const html = "<!DOCTYPE html><html><head><title>Картотека</title></head><body>" +
    "<div>" + "OK".repeat(20_000) + "</div></body></html>";
  const r = classifyAntiCloakResult({ body: html, http_status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.equal(r.httpStatus, 200);
});

// ── 8a) good marker: «Поиск по документам» (small body) ────────────────────
test("good marker 'Поиск по документам' on smallish body → recommended=true", () => {
  const html =
    "<!DOCTYPE html><html><body>" +
    "<h1>Поиск по документам</h1>" +
    "<p>" + "ok".repeat(3000) + "</p></body></html>";
  const r = classifyAntiCloakResult({ body: html, http_status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.ok(r.goodMarkers.includes("ras-search-title"));
});

// ── 8b) no good marker, no body-large → not recommended ────────────────────
test("body just under 20KB, no good marker, no bad → not recommended", () => {
  // Длиннее bodyMinBytes (5KB), но меньше GOOD_BODY_THRESHOLD (20KB), без good-marker.
  const html = "<html>" + "x".repeat(10_000) + "</html>";
  const r = classifyAntiCloakResult({ content: html, status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.deepEqual(r.markers, []);
  assert.deepEqual(r.goodMarkers, []);
});

// ── 8c) good marker «Банк решений» ─────────────────────────────────────────
test("good marker 'Банк решений' → recommended even with smallish body", () => {
  const html = "<html><body><h2>Банк решений</h2>" + "y".repeat(7000) + "</body></html>";
  const r = classifyAntiCloakResult({ body: html, http_status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.ok(r.goodMarkers.includes("ras-bank-title"));
});

// ── 8d) good marker + 451 → still bad (fatal trumps good) ──────────────────
test("good marker + 451 → still recommended=false", () => {
  const html = "<html><body>Поиск по документам</body></html>" + "z".repeat(20_000);
  const r = classifyAntiCloakResult({ body: html, http_status: 451 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("451"));
  assert.ok(r.goodMarkers.includes("ras-search-title"));
});

// ── 8e) body >= 20KB with no marker → recommended via body-large ───────────
test("body >= 20KB with no good marker → recommended via body-large", () => {
  const html = "<html>" + "q".repeat(25_000) + "</html>";
  const r = classifyAntiCloakResult({ content: html, status: 200 }, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.ok(r.goodMarkers.includes("body-large"));
});

// ── 9a) MP envelope: tasks_status=2 + JSON-string tasks_result ─────────────
test("MP envelope tasks_status=2 + nested tasks_result → ready + byCountry", () => {
  const inner = {
    82: {
      url: "https://ras.arbitr.ru/",
      data: {
        body: "<html><body>Поиск по документам " + "x".repeat(30_000) + "</body></html>",
        info: { http_code: 200, total_time: 0.85 },
        header: "HTTP/2 200 ...",
        parse_header: {},
        error: "",
      },
    },
    148: {
      url: "https://ras.arbitr.ru/",
      data: {
        body: "blocked",
        info: { http_code: 451, total_time: 0.12 },
        header: "HTTP/2 451 ...",
        error: "",
      },
    },
  };
  const mpResp = {
    status: "ok",
    tasks: {
      "108948": {
        tasks_id: "108948",
        tasks_start_time: "17-05-2026 11:17:11",
        tasks_end_time: "17-05-2026 11:17:12",
        tasks_status: "2",
        tasks_result: JSON.stringify(inner),
      },
    },
  };
  const parsed = parseAntiCloakTaskResult(mpResp);
  assert.equal(parsed.status, "ready");
  assert.ok(parsed.byCountry[82]);
  assert.ok(parsed.byCountry[148]);
  // classify должен поймать good-marker для 82 и 451 для 148
  const r82 = classifyAntiCloakResult(parsed.byCountry[82], { bodyMinBytes: 5000 });
  assert.equal(r82.recommended, true);
  assert.equal(r82.httpStatus, 200);
  assert.equal(r82.latencyMs, 850);
  assert.ok(r82.goodMarkers.includes("ras-search-title"));
  const r148 = classifyAntiCloakResult(parsed.byCountry[148], { bodyMinBytes: 5000 });
  assert.equal(r148.recommended, false);
  assert.equal(r148.httpStatus, 451);
  assert.ok(r148.markers.includes("451"));
});

// ── 9b) MP envelope: tasks_status=1 → pending ──────────────────────────────
test("MP envelope tasks_status=1 → pending", () => {
  const mpResp = {
    status: "ok",
    tasks: {
      "108949": {
        tasks_id: "108949",
        tasks_status: "1",
        tasks_result: null,
      },
    },
  };
  const parsed = parseAntiCloakTaskResult(mpResp);
  assert.equal(parsed.status, "pending");
  assert.deepEqual(parsed.byCountry, {});
});

// ── 9c) MP envelope: top-level status=ok без tasks_result → не считать ready ─
test("MP envelope status=ok без полного результата → pending", () => {
  // Case: см. реальное поведение — see_the_url возвращает {status:ok, tasks_id},
  // tasks endpoint при сразу-после-create тоже отдаёт {status:ok, tasks:{<id>:{tasks_status:1}}}.
  // Старый код принимал /ok\b/ как ready и заканчивал probe пустым.
  const mpResp = {
    status: "ok",
    tasks: {
      "108950": {
        tasks_id: "108950",
        tasks_status: "1",
        tasks_start_time: "17-05-2026 11:17:11",
      },
    },
  };
  const parsed = parseAntiCloakTaskResult(mpResp);
  assert.equal(parsed.status, "pending", "не должно ошибочно считаться ready");
});

if (fail > 0) {
  process.stdout.write(`\nFAIL: ${fail}, pass: ${pass}\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${pass} tests passed\n`);
