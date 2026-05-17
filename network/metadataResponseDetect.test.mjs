/**
 * Unit-тесты классификатора metadata-response. Без сети.
 * Запуск: `npm run test:meta-antifraud-smoke` (или `node network/metadataResponseDetect.test.mjs`).
 */

import assert from "node:assert/strict";

import { classifyMetadataResponse } from "./metadataResponseDetect.js";

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

// ── 1) Нормальный JSON-ответ /Search → json_ok ─────────────────────────────
test("application/json + valid body → json_ok", () => {
  const body =
    '{"Result":{"Items":[{"Id":"x"}],"TotalCount":1,"Page":1,"PagesCount":1,' +
    '"ReturnCount":1},"Success":true,"Message":null}';
  const r = classifyMetadataResponse({
    contentType: "application/json; charset=utf-8",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "json_ok");
  assert.deepEqual(r.markers, []);
  assert.equal(r.status, 200);
});

// ── 2) tokenFrom-HTML на 200 OK → antifraud_gate ───────────────────────────
test("html with tokenFrom 200 → antifraud_gate", () => {
  const body =
    `<html><body>${"x".repeat(2000)}<input id="tokenFrom" value="abc"/>` +
    `</body></html>`;
  const r = classifyMetadataResponse({
    contentType: "text/html; charset=utf-8",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "antifraud_gate");
  assert.ok(r.markers.includes("tokenFrom"));
  assert.match(r.reason, /tokenFrom/);
});

// ── 3) pravocaptcha-script на 200 OK → antifraud_gate ──────────────────────
test("pravocaptcha body 200 → antifraud_gate", () => {
  const body = `<html>${"y".repeat(5000)}var x = pravocaptcha.init();</html>`;
  const r = classifyMetadataResponse({
    contentType: "text/html",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "antifraud_gate");
  assert.ok(r.markers.includes("pravocaptcha"));
});

// ── 4) ddos-guard challenge на 200 OK → antifraud_gate ─────────────────────
test("ddos-guard body → antifraud_gate", () => {
  const body =
    "<html><body>DDoS-Guard challenge: please wait...</body></html>" +
    "z".repeat(3000);
  const r = classifyMetadataResponse({
    contentType: "text/html",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "antifraud_gate");
  assert.ok(r.markers.includes("ddos-guard"));
});

// ── 5) HTTP 451 → http_block (для логов; recover уже работает в parser) ────
test("status 451 → http_block", () => {
  const r = classifyMetadataResponse({
    contentType: "text/html",
    status: 451,
    bodyText: "<html>blocked</html>",
  });
  assert.equal(r.kind, "http_block");
  assert.ok(r.markers.includes("451"));
});

// ── 6) HTTP 403 → http_block ───────────────────────────────────────────────
test("status 403 → http_block", () => {
  const r = classifyMetadataResponse({
    status: 403,
    bodyText: "",
  });
  assert.equal(r.kind, "http_block");
  assert.ok(r.markers.includes("403"));
});

// ── 7) HTTP 429 → http_block ───────────────────────────────────────────────
test("status 429 → http_block", () => {
  const r = classifyMetadataResponse({
    status: 429,
    bodyText: "rate limited",
  });
  assert.equal(r.kind, "http_block");
  assert.ok(r.markers.includes("429"));
});

// ── 8) HTTP 5xx → http_block ───────────────────────────────────────────────
test("status 503 → http_block", () => {
  const r = classifyMetadataResponse({
    status: 503,
    bodyText: "service unavailable",
  });
  assert.equal(r.kind, "http_block");
  assert.ok(r.markers.includes("5xx"));
});

// ── 9) Короткий, но валидный JSON (пустая выдача RAS) → json_ok ────────────
test("short JSON body (empty RAS listing) → json_ok", () => {
  // Пустая выдача RAS: TotalCount=0, ~110 байт. НЕ должна срабатывать как tiny —
  // парсер сам обрабатывает Result.Items=[] / Result=null через
  // `_rasListingEmptyBeforeTopFilters`. Нам важно не задушить эту ветку.
  const body =
    '{"Result":{"Items":[],"TotalCount":0,"Page":1,"PagesCount":0,' +
    '"ReturnCount":0},"Success":true,"Message":null}';
  const r = classifyMetadataResponse({
    contentType: "application/json",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "json_ok");
});

// ── 10) Пустое тело → tiny ─────────────────────────────────────────────────
test("empty body → tiny", () => {
  const r = classifyMetadataResponse({
    contentType: "application/json",
    status: 200,
    bodyText: "",
  });
  assert.equal(r.kind, "tiny");
  assert.equal(r.bytes, 0);
});

// ── 11) HTML без маркеров → html_unknown (новая gate-страница?) ────────────
test("HTML without known markers → html_unknown", () => {
  const body =
    "<!doctype html><html><body>" + "a".repeat(5000) + "</body></html>";
  const r = classifyMetadataResponse({
    contentType: "text/html",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "html_unknown");
  assert.deepEqual(r.markers, []);
});

// ── 12) application/json header но tokenFrom в теле → antifraud_gate ───────
test("application/json + tokenFrom body → antifraud_gate (priority over ct)", () => {
  const body =
    '{"redirect":"<input id=tokenFrom value=...>"}' + "x".repeat(500);
  const r = classifyMetadataResponse({
    contentType: "application/json",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "antifraud_gate");
  assert.ok(r.markers.includes("tokenFrom"));
});

// ── 13) plain text → unknown (не баним без маркеров) ───────────────────────
test("plain text response → unknown", () => {
  const r = classifyMetadataResponse({
    contentType: "text/plain",
    status: 200,
    bodyText: "ok ok ok " + "k".repeat(500),
  });
  assert.equal(r.kind, "unknown");
});

// ── 14) Just a moment (cloudflare-style) → antifraud_gate ──────────────────
test("just a moment → antifraud_gate", () => {
  const body =
    "<html><body>Just a moment...<noscript>...</noscript></body></html>" +
    "x".repeat(2000);
  const r = classifyMetadataResponse({
    contentType: "text/html",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "antifraud_gate");
  assert.ok(r.markers.includes("just-a-moment"));
});

// ── 15) status вне списка блоков → не http_block (например 304) ────────────
test("status 304 → not http_block (kind tells about body)", () => {
  const r = classifyMetadataResponse({
    contentType: "application/json",
    status: 304,
    bodyText: "",
  });
  // 304 без тела попадает в tiny — это норм, parser отдельно лог.
  assert.notEqual(r.kind, "http_block");
});

// ── 16) Long json without markers → json_ok ────────────────────────────────
test("long json body → json_ok", () => {
  const items = [];
  for (let i = 0; i < 25; i += 1) {
    items.push(`{"Id":"id-${i}","CaseId":"c-${i}"}`);
  }
  const body = `{"Result":{"Items":[${items.join(",")}],"TotalCount":25}}`;
  const r = classifyMetadataResponse({
    contentType: "application/json; charset=utf-8",
    status: 200,
    bodyText: body,
  });
  assert.equal(r.kind, "json_ok");
});

if (fail > 0) {
  process.stdout.write(`\nFAIL: ${fail}, pass: ${pass}\n`);
  process.exit(1);
}
process.stdout.write(`\nall ${pass} tests passed\n`);
