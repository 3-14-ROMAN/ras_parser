/**
 * Smoke-тест scoring'а proxy-health. Сеть НЕ дёргаем: гоняем чистый
 * `classifyAntiCloakResult` на фикстурах, имитирующих ответы
 * `see_the_url_from_different_IPs`.
 *
 * Цель: убедиться, что классификатор отсекает 451 / pravoCaptcha / forbidden /
 * empty html, при этом нормальный ras-ответ (good-marker ИЛИ body>=20KB) даёт
 * recommended=true. Без этого preflight выдаёт мусорные «recommended» страны
 * и весь download:acts отлетает в `tokenFrom` на первом же warmup'е.
 *
 * Запуск: npm run smoke:proxy-health
 */

import assert from "node:assert/strict";

import {
  classifyAntiCloakResult,
  combineUrlVerdicts,
  parseAntiCloakTaskResult,
} from "../scripts/antiCloakClassifier.js";

const TAG = "proxyHealth.smoke";

function log(m) {
  process.stdout.write(`[${TAG}] ${m}\n`);
}

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    log(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    log(`FAIL ${name}\n  ${e && (e.stack ?? e.message ?? e)}`);
  }
}

// ─────────────────────────── фикстуры ───────────────────────────

const FX = {
  // Большая «настоящая» страница ras с одним из good-marker'ов и body >> 20KB.
  rasOk: {
    content:
      "<!DOCTYPE html><html lang='ru'><head><title>Картотека арбитражных дел</title></head>" +
      "<body><h1>Поиск по документам</h1><div id='search'>" +
      "<label>Вид спора</label>" +
      "<div>" + "&nbsp;".repeat(40_000) + "</div>" +
      "</div></body></html>",
    status: 200,
    time_ms: 720,
    id_country: 82,
  },
  // 451 (HTTP + сообщение) — должны жёстко отсечь.
  ras451: {
    content: "<html><body>HTTP 451 Unavailable For Legal Reasons</body></html>",
    status: 451,
    time_ms: 200,
    id_country: 1,
  },
  // pravocaptcha — анти-бот gate, body > 20KB но содержит маркер.
  pravoCaptcha: {
    content:
      "<html><body>" +
      "<script>var tokenFrom = pravocaptcha.init('challenge');</script>" +
      "<div>" + "x".repeat(25_000) + "</div></body></html>",
    status: 200,
    time_ms: 1500,
    id_country: 2,
  },
  // Forbidden (403) — должны отсечь.
  ras403: {
    content: "<html><body><h1>403 Forbidden</h1><p>Access Denied</p></body></html>",
    status: 403,
    time_ms: 90,
    id_country: 145,
  },
  // ddos-guard challenge — Just a moment...
  ddosGuard: {
    content:
      "<html><body><h1>DDoS-Guard</h1><p>Just a moment...</p>" +
      "<div>" + "y".repeat(30_000) + "</div></body></html>",
    status: 200,
    time_ms: 800,
    id_country: 22,
  },
  // Пустой body — обычно proxy-tunnel прервался.
  emptyBody: {
    content: "",
    status: 200,
    time_ms: 50,
    id_country: 100,
  },
  // 25KB body без good-marker'а и без bad-marker'а — recommended (body-large).
  bigButGeneric: {
    content: "<html>" + "ok".repeat(15_000) + "</html>",
    status: 200,
    time_ms: 600,
    id_country: 152,
  },
  // body 7KB с good-marker — recommended (даже без body-large).
  smallButRas: {
    content:
      "<html><body><h2>Банк решений</h2>" +
      "<div>" + "z".repeat(6500) + "</div></body></html>",
    status: 200,
    time_ms: 400,
    id_country: 61,
  },
};

// ─────────────────────────── сценарии ───────────────────────────

test("rasOk → recommended=true с good-marker", () => {
  const r = classifyAntiCloakResult(FX.rasOk, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.ok(r.goodMarkers.includes("ras-search-title") || r.goodMarkers.includes("ras-dispute-type"));
  assert.equal(r.markers.length, 0);
});

test("ras451 → recommended=false, marker=451", () => {
  const r = classifyAntiCloakResult(FX.ras451, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("451"));
});

test("pravoCaptcha → recommended=false (good-marker не спасает)", () => {
  const r = classifyAntiCloakResult(FX.pravoCaptcha, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("pravocaptcha"));
  assert.ok(r.markers.includes("tokenFrom"));
});

test("ras403 → recommended=false, marker=forbidden/403", () => {
  const r = classifyAntiCloakResult(FX.ras403, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("403") || r.markers.includes("forbidden") || r.markers.includes("access-denied"));
});

test("ddosGuard → recommended=false, marker=ddos-guard/just-a-moment", () => {
  const r = classifyAntiCloakResult(FX.ddosGuard, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("ddos-guard") || r.markers.includes("just-a-moment"));
});

test("emptyBody → recommended=false, marker=empty", () => {
  const r = classifyAntiCloakResult(FX.emptyBody, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, false);
  assert.ok(r.markers.includes("empty"));
});

test("bigButGeneric (≥20KB) → recommended=true (body-large)", () => {
  const r = classifyAntiCloakResult(FX.bigButGeneric, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.ok(r.goodMarkers.includes("body-large"));
});

test("smallButRas (7KB + Банк решений) → recommended=true", () => {
  const r = classifyAntiCloakResult(FX.smallButRas, { bodyMinBytes: 5000 });
  assert.equal(r.recommended, true);
  assert.ok(r.goodMarkers.includes("ras-bank-title"));
});

// ─── e2e: имитируем ответ tasks → parse → classify per-country ─────────────
test("tasks-like response: parse + per-country classify", () => {
  const taskResp = {
    status: "ready",
    tasks_result: {
      82: FX.rasOk,
      1: FX.ras451,
      2: FX.pravoCaptcha,
      22: FX.ddosGuard,
      145: FX.ras403,
      152: FX.bigButGeneric,
    },
  };
  const parsed = parseAntiCloakTaskResult(taskResp);
  assert.equal(parsed.status, "ready");
  const perCountry = {};
  for (const cid of Object.keys(parsed.byCountry)) {
    perCountry[cid] = classifyAntiCloakResult(parsed.byCountry[cid], { bodyMinBytes: 5000 });
  }
  // Ровно KZ(82) и TR(152) должны быть recommended.
  const ok = Object.entries(perCountry)
    .filter(([, v]) => v.recommended)
    .map(([k]) => Number(k))
    .sort((a, b) => a - b);
  assert.deepEqual(ok, [82, 152], `recommended ожидаем [82,152], got ${JSON.stringify(ok)}`);
});

test("combineUrlVerdicts: страна good только если good на ВСЕХ URL", () => {
  const r1 = classifyAntiCloakResult(FX.rasOk, { bodyMinBytes: 5000 });
  const r2 = classifyAntiCloakResult(FX.pravoCaptcha, { bodyMinBytes: 5000 });
  const combined = combineUrlVerdicts(
    {
      "https://ras.arbitr.ru/": { 82: r1 },
      "https://kad.arbitr.ru/": { 82: r2 },
    },
    [82],
  );
  assert.equal(combined[82].recommended, false, "если на kad плохо — combined тоже плохо");
  assert.ok(combined[82].markers.includes("pravocaptcha"));
});

process.stdout.write(`\n[${TAG}] passed=${pass} failed=${fail}\n`);
process.exit(fail > 0 ? 1 : 0);
