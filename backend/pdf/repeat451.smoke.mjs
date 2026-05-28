/**
 * Unit-smoke: defer-after-recovery (451) + классификатор infra-ошибок warmup/proxy.
 * Запуск: npm run test:pdf-smoke
 */
import assert from "node:assert/strict";
import { __test__ } from "./downloader.js";
import { __test__ as proxyTest, RasProxyClient } from "../network/proxyClient.js";
import { BadGeoBlacklist } from "./badGeoBlacklist.js";

const {
  _repeat451DeferAfterRecovery,
  classifyPdfInfraError,
  buildKadSessionFailedReturn,
  _extractFailedChangeGeoCandidate,
  _markFailedChangeGeoCandidateBad,
  _isEquipmentBusyReason,
} = __test__;
const {
  _extractEquipmentCandidates,
  _extractBlacklistEquipment,
  _extractBlacklistOperators,
  detectMpResponseError,
  detectMpResponseErrorFromException,
  ADD_TO_BLACKLIST_DEFAULT,
} = proxyTest;

// ── 451 defer-after-recovery ──
assert.equal(_repeat451DeferAfterRecovery(451, true), true);
assert.equal(_repeat451DeferAfterRecovery(451, false), false);
assert.equal(_repeat451DeferAfterRecovery(429, true), false);
assert.equal(_repeat451DeferAfterRecovery(null, true), false);

// ── классификатор: proxy_tunnel_failed ──
for (const msg of [
  'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://ras.arbitr.ru/',
  "net::ERR_PROXY_CONNECTION_FAILED",
  "Failed: net::ERR_CONNECTION_RESET",
  "net::ERR_CONNECTION_CLOSED at https://kad.arbitr.ru/",
  "navigating: net::ERR_TIMED_OUT after 30s",
]) {
  const c = classifyPdfInfraError(msg);
  assert.ok(c, `expected proxy_tunnel match for: ${msg}`);
  assert.equal(c.infra, true);
  assert.equal(c.reason, "proxy_tunnel_failed");
}

// ── классификатор: warmup_failed ──
for (const msg of [
  'page.goto: Timeout 25000ms exceeded navigating to "https://ras.arbitr.ru/"',
  'Timeout 25000ms exceeded navigating to "https://kad.arbitr.ru/"',
  "kad session failed: something downstream",
  "Target page, context or browser has been closed",
  "Page has been closed during warmup",
]) {
  const c = classifyPdfInfraError(msg);
  assert.ok(c, `expected warmup match for: ${msg}`);
  assert.equal(c.infra, true);
  assert.equal(c.reason, "warmup_failed");
}

// ── классификатор: не инфра — null ──
for (const msg of [
  "tiny payload (4b) — likely not a real PDF",
  "max attempts reached (6). last: salto decode mismatch",
  "",
  null,
  undefined,
]) {
  assert.equal(classifyPdfInfraError(msg), null, `unexpected match for: ${String(msg)}`);
}

// ── buildKadSessionFailedReturn: ровно та форма, которую ждёт pipeline ──
// (recoverable + deferred + infra → pipeline уходит в deferAct, не markPdfFailed).
{
  const r = buildKadSessionFailedReturn(
    'page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://ras.arbitr.ru/',
  );
  assert.equal(r.ok, false);
  assert.equal(r.recoverable, true);
  assert.equal(r.deferred, true);
  assert.equal(r.infra, true);
  assert.equal(r.reason, "proxy_tunnel_failed");
  assert.match(r.error, /kad session failed:/);
  assert.match(r.error, /ERR_TUNNEL_CONNECTION_FAILED/);
}
{
  // Сообщение, для которого классификатор не находит конкретного reason —
  // всё равно warmup_failed (любая ошибка ensureKadSession = инфра).
  const r = buildKadSessionFailedReturn("strange weather today");
  assert.equal(r.ok, false);
  assert.equal(r.infra, true);
  assert.equal(r.deferred, true);
  assert.equal(r.recoverable, true);
  assert.equal(r.reason, "warmup_failed");
}
{
  const r = buildKadSessionFailedReturn(
    'Timeout 25000ms exceeded navigating to "https://kad.arbitr.ru/"',
  );
  assert.equal(r.reason, "warmup_failed");
  assert.equal(r.deferred, true);
}


// ── _extractFailedChangeGeoCandidate ──
{
  // Плоский формат (как сейчас возвращает proxyClient.changeGeo при ok:false).
  const c = _extractFailedChangeGeoCandidate({
    ok: false,
    reason: "ApiError name=ApiError status=503",
    geoid: 478,
    operator: "tele2(KZ)",
    caption: "Казахстан, Петропавловск",
  });
  assert.ok(c, "expected candidate from flat proxyClient response");
  assert.equal(c.geoid, 478);
  assert.equal(c.operator, "tele2(KZ)");
  assert.equal(c.ip, null);
}
{
  // Вложенный candidate.* — fallback path.
  const c = _extractFailedChangeGeoCandidate({
    ok: false,
    candidate: { geoid: 145, operator: "kievstar", ip: "1.2.3.4" },
  });
  assert.ok(c);
  assert.equal(c.geoid, 145);
  assert.equal(c.operator, "kievstar");
  assert.equal(c.ip, "1.2.3.4");
}
{
  // Пусто — нет ни geoid, ни operator, ни ip.
  const c = _extractFailedChangeGeoCandidate({ ok: false, reason: "x" });
  assert.equal(c, null);
}
{
  assert.equal(_extractFailedChangeGeoCandidate(null), null);
  assert.equal(_extractFailedChangeGeoCandidate(undefined), null);
}

// ── _markFailedChangeGeoCandidateBad: основной фикс ──
{
  const bl = new BadGeoBlacklist({ cooldownMs: 60_000 });
  const r = {
    ok: false,
    reason: "ApiError name=ApiError status=503 body={\"err\":\"x\"}",
    geoid: 478,
    operator: "tele2(KZ)",
    caption: "Казахстан, Петропавловск",
  };
  const res = _markFailedChangeGeoCandidateBad(bl, r, r.reason);
  assert.equal(res.marked, true);
  assert.equal(res.geoid, 478);
  assert.equal(res.operator, "tele2(KZ)");

  // После markBad — кандидата надо отсечь через excludeGeoIds/excludeOperators.
  const badGeoIds = bl.badGeoIds();
  const badOperators = bl.badOperators();
  assert.deepEqual(badGeoIds, [478]);
  assert.deepEqual(badOperators, ["tele2(KZ)"]);
  assert.equal(bl.isGeoBad(478), true);
  assert.equal(bl.isOperatorBad("tele2(KZ)"), true);
}
{
  // Без blacklist — no-op, не падает.
  const res = _markFailedChangeGeoCandidateBad(null, { geoid: 1 }, "x");
  assert.equal(res.marked, false);
}
{
  // Без кандидата (например no-allowed-geo) — no-op.
  const bl = new BadGeoBlacklist({ cooldownMs: 60_000 });
  const res = _markFailedChangeGeoCandidateBad(
    bl,
    { ok: false, reason: "no-allowed-geo" },
    "no-allowed-geo",
  );
  assert.equal(res.marked, false);
  assert.equal(bl.size(), 0);
}


// ── _isEquipmentBusyReason ──
assert.equal(_isEquipmentBusyReason("equipment_busy"), true);
assert.equal(_isEquipmentBusyReason("FAIL equipment busy or unavailable"), true);
assert.equal(
  _isEquipmentBusyReason("mobileproxy_error:FAIL equipment busy or unavailable"),
  true,
);
assert.equal(_isEquipmentBusyReason("equipment unavailable"), true);
assert.equal(_isEquipmentBusyReason("ApiError status=500"), false);
assert.equal(_isEquipmentBusyReason("probe:451"), false);
assert.equal(_isEquipmentBusyReason(""), false);
assert.equal(_isEquipmentBusyReason(null), false);

// ── _markFailedChangeGeoCandidateBad: equipment_busy → operator НЕ блочим ──
{
  const bl = new BadGeoBlacklist({ cooldownMs: 60_000 });
  const r = {
    ok: false,
    reason: "equipment_busy",
    mpErrorKind: "equipment_busy",
    geoid: 478,
    operator: "tele2(KZ)",
  };
  const res = _markFailedChangeGeoCandidateBad(bl, r, r.reason);
  assert.equal(res.marked, true);
  assert.equal(res.equipmentBusy, true);
  assert.equal(res.operatorBlacklisted, false);
  assert.deepEqual(bl.badGeoIds(), [478]);
  assert.deepEqual(bl.badOperators(), []);
  assert.equal(bl.isGeoBad(478), true);
  assert.equal(bl.isOperatorBad("tele2(KZ)"), false);
}

// ── _markFailedChangeGeoCandidateBad: RAS/KAD-ошибка → operator БЛОЧИМ ──
{
  const bl = new BadGeoBlacklist({ cooldownMs: 60_000 });
  const r = { ok: false, reason: "probe:451_after_rotate", geoid: 478, operator: "tele2(KZ)" };
  const res = _markFailedChangeGeoCandidateBad(bl, r, r.reason);
  assert.equal(res.marked, true);
  assert.equal(res.equipmentBusy, false);
  assert.equal(res.operatorBlacklisted, true);
  assert.deepEqual(bl.badGeoIds(), [478]);
  assert.deepEqual(bl.badOperators(), ["tele2(KZ)"]);
}

// ── detectMpResponseError: распознаём status=err + error[proxy_id] ──
{
  const resp = {
    status: "err",
    error: { 12345: "FAIL equipment busy or unavailable" },
    checked: {},
  };
  const r = detectMpResponseError(resp, 12345);
  assert.equal(r.isErr, true);
  assert.equal(r.kind, "equipment_busy");
  assert.match(r.errText, /equipment busy/i);
}
{
  // Ключ как строка тоже резолвится.
  const resp = { status: "err", error: { "999": "FAIL equipment busy or unavailable" } };
  const r = detectMpResponseError(resp, 999);
  assert.equal(r.isErr, true);
  assert.equal(r.kind, "equipment_busy");
}
{
  // Не-busy → mobileproxy_error fallback.
  const r = detectMpResponseError(
    { status: "err", error: { 1: "something else weird" } },
    1,
  );
  assert.equal(r.isErr, true);
  assert.equal(r.kind, "mobileproxy_error");
}
{
  // status=ok → не ошибка.
  const r = detectMpResponseError({ status: "ok", checked: { 1: true } }, 1);
  assert.equal(r.isErr, false);
  assert.equal(r.kind, null);
}

// ── _extractEquipmentCandidates: count_free object → flatten с count > 0 ──
{
  const avail = {
    geo_operator_list: {
      g1: {
        geoid: 478,
        geo_caption: "Казахстан, Петропавловск",
        id_country: 82,
        count_free: { "tele2(KZ)": 2, "kcell(KZ)": 0 },
      },
      g2: {
        geoid: 145,
        geo_caption: "Украина, Киев",
        id_country: 22,
        count_free: { "kievstar": 0 },
      },
    },
  };
  const c = _extractEquipmentCandidates(avail);
  // Только tele2(KZ) count=2 проходит фильтр.
  assert.equal(c.length, 1, `expected 1 candidate, got ${c.length}`);
  assert.equal(c[0].geoid, 478);
  assert.equal(c[0].operator, "tele2(KZ)");
  assert.equal(c[0].count, 2);
  assert.equal(c[0].countryId, 82);
}

// ── addToBlackList default: OFF, если env не задан или 0 ──
// Тест читает захваченный на module-load default; стоит обязательно остаться false.
assert.equal(
  ADD_TO_BLACKLIST_DEFAULT,
  false,
  `RAS_MP_ADD_TO_BLACKLIST_ON_CHANGE_GEO default должен быть false (got ${ADD_TO_BLACKLIST_DEFAULT})`,
);

// ── _extractBlacklistEquipment / _extractBlacklistOperators ──
{
  const resp = {
    black_list: [
      { black_list_id: 1, eid: 111, operator: "x", geoid: 478 },
    ],
    black_list_operators: [
      { operator_id: 7, operator: "tele2(KZ)" },
    ],
  };
  const eq = _extractBlacklistEquipment(resp);
  const ops = _extractBlacklistOperators(resp);
  assert.equal(eq.length, 1);
  assert.equal(eq[0].eid, 111);
  assert.equal(ops.length, 1);
  assert.equal(ops[0].operatorId, 7);
}


// ── detectMpResponseErrorFromException: ApiError.responseBody ──
{
  // SDK кидает ApiError(msg, httpCode, responseBody=json). Эмулируем.
  const e = Object.assign(new Error("[object Object]"), {
    name: "ApiError",
    httpCode: 200,
    responseBody: {
      status: "err",
      error: { 490645: "FAIL equipment busy or unavailable" },
      checked: {},
    },
  });
  const r = detectMpResponseErrorFromException(e, 490645);
  assert.equal(r.isErr, true);
  assert.equal(r.kind, "equipment_busy");
  assert.match(r.errText, /equipment busy/i);
}
{
  // Если SDK message содержит equipment busy, тоже определяется как busy.
  const e = Object.assign(
    new Error("FAIL equipment busy or unavailable"),
    { name: "ApiError" },
  );
  const r = detectMpResponseErrorFromException(e, 1);
  assert.equal(r.isErr, true);
  assert.equal(r.kind, "equipment_busy");
}
{
  // Сетевая ошибка / таймаут — не MP-style.
  const e = Object.assign(new Error("Network error: ECONNRESET"), {
    name: "ApiError",
  });
  const r = detectMpResponseErrorFromException(e, 1);
  assert.equal(r.isErr, false);
}

// ── _runChangeEquipment не двигает cooldown timestamp при equipment_busy ──
// Поднимаем RasProxyClient + stub'аем sdk.changeEquipment + sdk.getMyProxy.
// Цель: показать, что при ApiError с responseBody={status:"err"} следующий
// вызов change_equipment НЕ ждёт hard-cooldown ~175с.
{
  const logs = [];
  const c = new RasProxyClient({
    apiToken: "test-token",
    proxyKey: "test-key",
    proxyId: 490645,
    minIpRotateGapSec: 0,
    minEquipmentSwapGapSec: 180, // нужно бОльшое значение для теста
    minGeoSwapGapSec: 180,
    logger: (m) => logs.push(m),
  });

  // Stub'аем sdk-методы. RasProxyClient не вызовет getMyProxy, так как
  // proxyId передан в конструкторе.
  c.sdk.changeEquipment = async () => {
    throw Object.assign(new Error("[object Object]"), {
      name: "ApiError",
      httpCode: 200,
      responseBody: {
        status: "err",
        error: { 490645: "FAIL equipment busy or unavailable" },
        checked: {},
      },
    });
  };

  const t0 = performance.now();
  const r1 = await c._runChangeEquipment(
    { geoId: 478, operator: "tele2(KZ)" },
    "test busy round 1",
    { isGeoSwap: true, addToBlackList: false },
  );
  assert.equal(r1.ok, false, "expected ok:false on busy");
  assert.equal(r1.reason, "equipment_busy", `reason was ${r1.reason}`);

  // Проверяем, что cooldown НЕ начат. Иначе следующий _runChangeEquipment
  // должен был бы спать ~180с. Делаем второй вызов и проверяем, что он
  // быстрый (<2с) и в логах нет hard-cooldown.
  const t1 = performance.now();
  const r2 = await c._runChangeEquipment(
    { geoId: 999, operator: "x" },
    "test busy round 2",
    { isGeoSwap: true, addToBlackList: false },
  );
  const t2 = performance.now();
  assert.equal(r2.ok, false);
  assert.equal(r2.reason, "equipment_busy");
  assert.ok(
    t2 - t1 < 2000,
    `expected next round <2s without hard-cooldown, got ${(t2 - t1).toFixed(0)}ms`,
  );
  assert.ok(t1 - t0 < 2000);
  assert.ok(
    !logs.some((m) => /hard-cooldown: жду/.test(m)),
    "expected NO hard-cooldown wait between busy rounds, logs:\n" + logs.join("\n"),
  );
  assert.ok(
    logs.some((m) => /equipment_busy — no equipment change happened, cooldown not started/.test(m)),
    "expected explicit 'cooldown not started' log, logs:\n" + logs.join("\n"),
  );
}

// ── _runChangeEquipment ставит cooldown ТОЛЬКО на real success ──
{
  const logs = [];
  const c = new RasProxyClient({
    apiToken: "t",
    proxyKey: "k",
    proxyId: 1,
    minEquipmentSwapGapSec: 180,
    minGeoSwapGapSec: 180,
    logger: (m) => logs.push(m),
  });
  // success response, no tasks_id
  c.sdk.changeEquipment = async () => ({ status: "ok", checked: { 1: true } });
  await c._runChangeEquipment(
    { geoId: 1, operator: "x" },
    "test success",
    { isGeoSwap: true, addToBlackList: false },
  );
  // После success cooldown timestamp поднят: следующий вызов должен ждать
  // ~180с — но мы не хотим реально ждать. Достаточно проверить, что значение
  // выставилось > 0.
  assert.ok(c._lastEquipmentSwapAt > 0, "expected cooldown timestamp set on success");
  assert.ok(c._lastGeoSwapAt > 0, "expected geo cooldown timestamp set on success");
}

console.log(
  "pdf repeat451 + infra-classifier + bad-geo-recovery + equipment-busy + mp-openapi + cooldown-gating smoke OK",
);
