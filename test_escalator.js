/**
 * Тест эскалатора. Главная проверяемая инвариантa: при «провайдер не
 * помогает вообще» эскалатор за КОНЕЧНОЕ число шагов кидает
 * `EscalationExhausted` и не уходит в вечный цикл changeIp ↔
 * changeEquipment.
 *
 * Запуск:  `node test_escalator.js`
 * (НИКАКИХ внешних запросов — все клиенты замоканы.)
 */

import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import {
  EscalationExhausted,
  ProxyEscalator,
  ESC_KINDS,
  ESC_LEVELS,
} from "./escalator.js";

const monotonic = () => performance.now() / 1000;

function makeMockClient(overrides = {}) {
  const calls = { rotateIp: 0, changeOperator: 0, changeGeo: 0 };
  return {
    calls,
    async rotateIp(reason) {
      calls.rotateIp += 1;
      return overrides.rotateIp
        ? await overrides.rotateIp(reason, calls.rotateIp)
        : { ok: true };
    },
    async changeOperator(reason) {
      calls.changeOperator += 1;
      return overrides.changeOperator
        ? await overrides.changeOperator(reason, calls.changeOperator)
        : { ok: true, kind: "operator" };
    },
    async changeGeo(reason) {
      calls.changeGeo += 1;
      return overrides.changeGeo
        ? await overrides.changeGeo(reason, calls.changeGeo)
        : { ok: true, kind: "geo" };
    },
  };
}

function makeFakeStealth() {
  return {
    waits: [],
    async smartWait(actionType) {
      this.waits.push(actionType);
      // в тестах НЕ спим реально, иначе тест будет идти 30 минут
    },
  };
}

const logs = [];
function logCollector(msg) {
  logs.push(msg);
}

// ───────────────────────────────────────────────────────────────
// Test 1. kind=net_down: полная лестница работает по порядку
// и упирается в потолок (changeGeo разрешён).
// ───────────────────────────────────────────────────────────────

async function test_ladder_terminates() {
  logs.length = 0;
  const client = makeMockClient(); // всегда «успешно сменили», но это нам не помогает
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 3,
    maxOperatorSwapsBeforeGeo: 2,
    maxGeoSwaps: 2,
    maxTotalFailures: 50,
    maxBudgetSec: 60,
  });

  const sequence = [];
  let attempts = 0;
  const HARD_CAP = 200;
  let exhausted = null;

  while (attempts < HARD_CAP) {
    attempts += 1;
    try {
      const r = await esc.recoverFrom(`fail#${attempts}`, {
        kind: ESC_KINDS.NET_DOWN,
      });
      sequence.push(r.level);
    } catch (e) {
      if (e instanceof EscalationExhausted) {
        exhausted = e;
        break;
      }
      throw e;
    }
  }

  assert(exhausted, "ожидали EscalationExhausted, не дождались");
  assert(attempts < HARD_CAP, `не должны крутиться до HARD_CAP=${HARD_CAP}, реально=${attempts}`);

  // Ожидаемая последовательность для этих лимитов:
  //   maxIp=3, maxOp=2, maxGeo=2.
  //
  // После operator/geo `consecutiveIp` сбрасывается в 0 — снова дешёвый
  // ip-цикл. Op-counter сбрасывается на geo. Geo-counter — глобальный.
  //
  //   3×ip → 1×op → 3×ip → 1×op → 3×ip → 1×geo (op сброшен)
  //              → 3×ip → 1×op → 3×ip → 1×op → 3×ip → 1×geo
  //                                                 → 3×ip → STOP
  //
  // Итого 27 эскалаций, 28-я падает в EscalationExhausted.
  const expected = [
    "ip", "ip", "ip", "operator",
    "ip", "ip", "ip", "operator",
    "ip", "ip", "ip", "geo",
    "ip", "ip", "ip", "operator",
    "ip", "ip", "ip", "operator",
    "ip", "ip", "ip", "geo",
    "ip", "ip", "ip",
  ];
  assert.deepEqual(
    sequence,
    expected,
    `последовательность эскалации:\nожидали ${JSON.stringify(expected)}\nполучили ${JSON.stringify(sequence)}`,
  );

  assert.equal(client.calls.rotateIp, 21);
  assert.equal(client.calls.changeOperator, 4);
  assert.equal(client.calls.changeGeo, 2);

  assert(
    /исчерпаны все уровни/.test(exhausted.message),
    `сообщение должно говорить про потолок: ${exhausted.message}`,
  );

  console.log("[ok] test_ladder_terminates");
  console.log(`     attempts=${attempts}, summary=${JSON.stringify(esc.summary())}`);
}

// ───────────────────────────────────────────────────────────────
// Test 2. После noteSuccess счётчики сбрасываются и L1 снова доступен.
// ───────────────────────────────────────────────────────────────

async function test_recovery_after_success() {
  logs.length = 0;
  const client = makeMockClient();
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 3,
    maxOperatorSwapsBeforeGeo: 2,
    maxGeoSwaps: 2,
    maxTotalFailures: 50,
    maxBudgetSec: 60,
  });

  // 3 ротации IP, успех, и снова цикл должен начаться с L1, не с L2
  for (let i = 0; i < 3; i += 1) {
    const r = await esc.recoverFrom(`bad#${i + 1}`);
    assert.equal(r.level, ESC_LEVELS.IP);
    assert.equal(r.kind, ESC_KINDS.BANNED, "kind по умолчанию должен быть 'banned'");
  }
  assert.equal(esc.consecutiveIpRotations, 3);

  esc.noteSuccess(ESC_LEVELS.IP);
  assert.equal(esc.consecutiveIpRotations, 0);

  const next = await esc.recoverFrom("after-recovery");
  assert.equal(next.level, ESC_LEVELS.IP);

  console.log("[ok] test_recovery_after_success");
}

// ───────────────────────────────────────────────────────────────
// Test 3. Бюджет по времени тоже отрубает зацикленность.
// ───────────────────────────────────────────────────────────────

async function test_time_budget() {
  logs.length = 0;
  const client = makeMockClient({
    rotateIp: async () => {
      await sleep(60);
      return { ok: true };
    },
    changeOperator: async () => {
      await sleep(60);
      return { ok: true };
    },
    changeGeo: async () => {
      await sleep(60);
      return { ok: true };
    },
  });
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 100,
    maxOperatorSwapsBeforeGeo: 100,
    maxGeoSwaps: 100,
    maxTotalFailures: 10_000,
    maxBudgetSec: 0.3,
  });

  const t0 = monotonic();
  let exhausted = null;
  for (let i = 0; i < 500; i += 1) {
    try {
      await esc.recoverFrom(`spam#${i + 1}`, { kind: ESC_KINDS.NET_DOWN });
    } catch (e) {
      if (e instanceof EscalationExhausted) {
        exhausted = e;
        break;
      }
      throw e;
    }
  }
  const elapsed = monotonic() - t0;

  assert(exhausted, "по бюджету должны были упасть EscalationExhausted");
  assert(elapsed < 5, `тест не должен идти долго, elapsed=${elapsed.toFixed(2)}с`);
  assert(/исчерпан общий бюджет/.test(exhausted.message), exhausted.message);

  console.log(`[ok] test_time_budget (elapsed=${elapsed.toFixed(2)}с)`);
}

// ───────────────────────────────────────────────────────────────
// Test 4. maxTotalFailures — независимый ограничитель.
// ───────────────────────────────────────────────────────────────

async function test_total_failures_cap() {
  logs.length = 0;
  const client = makeMockClient();
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 100,
    maxOperatorSwapsBeforeGeo: 100,
    maxGeoSwaps: 100,
    maxTotalFailures: 7,
    maxBudgetSec: 60,
  });

  let exhausted = null;
  let attempts = 0;
  for (let i = 0; i < 50; i += 1) {
    attempts += 1;
    try {
      await esc.recoverFrom(`x#${i + 1}`, { kind: ESC_KINDS.NET_DOWN });
    } catch (e) {
      if (e instanceof EscalationExhausted) {
        exhausted = e;
        break;
      }
      throw e;
    }
  }
  assert(exhausted, "должны были упереться в maxTotalFailures");
  assert.equal(attempts, 7, `attempts=${attempts}, ждали 7`);
  assert(
    /исчерпан лимит totalFailures/i.test(exhausted.message),
    `сообщение про total failures, факт: ${exhausted.message}`,
  );
  console.log("[ok] test_total_failures_cap");
}

// ───────────────────────────────────────────────────────────────
// Test 5. Стелс получает корректные actionType: ip_cooldown vs equipment_swap.
// ───────────────────────────────────────────────────────────────

async function test_stealth_wait_buckets() {
  logs.length = 0;
  // L1=0, чтобы IP-уровень был вообще недоступен и эскалатор сразу
  // прыгал в operator/geo. Иначе после успеха operator/geo
  // `consecutiveIp` сбрасывается и следующая итерация снова идёт в IP.
  const client = makeMockClient();
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 0,
    maxOperatorSwapsBeforeGeo: 1,
    maxGeoSwaps: 5,
    maxTotalFailures: 50,
    maxBudgetSec: 60,
  });

  // operator(L2), geo(L3 после исчерпания op), operator снова (geo сбросил op).
  // L3 — только при kind=net_down.
  const r1 = await esc.recoverFrom("force-op-1", { kind: ESC_KINDS.NET_DOWN });
  const r2 = await esc.recoverFrom("force-geo", { kind: ESC_KINDS.NET_DOWN });
  const r3 = await esc.recoverFrom("force-op-2", { kind: ESC_KINDS.NET_DOWN });

  assert.equal(r1.level, ESC_LEVELS.OPERATOR);
  assert.equal(r2.level, ESC_LEVELS.GEO);
  assert.equal(r3.level, ESC_LEVELS.OPERATOR);

  assert.deepEqual(
    stealth.waits,
    ["equipment_swap", "equipment_swap", "equipment_swap"],
    `bucket-последовательность, факт: ${JSON.stringify(stealth.waits)}`,
  );

  const stealthIp = makeFakeStealth();
  const escIp = new ProxyEscalator({
    proxyClient: makeMockClient(),
    stealth: stealthIp,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 1,
    maxOperatorSwapsBeforeGeo: 1,
    maxGeoSwaps: 1,
    maxTotalFailures: 50,
    maxBudgetSec: 60,
  });
  await escIp.recoverFrom("ip-only");
  assert.deepEqual(stealthIp.waits, ["ip_cooldown"]);

  console.log("[ok] test_stealth_wait_buckets");
}

// ───────────────────────────────────────────────────────────────
// Test 6. kind='banned' НИКОГДА не вызывает changeGeo. Когда
// L1+L2 в текущем гео исчерпаны — кидает EscalationExhausted
// с понятным сообщением про политику.
// ───────────────────────────────────────────────────────────────

async function test_banned_never_changes_geo() {
  logs.length = 0;
  const client = makeMockClient();
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 3,
    maxOperatorSwapsBeforeGeo: 2,
    maxGeoSwaps: 2,
    maxTotalFailures: 50,
    maxBudgetSec: 60,
  });

  const sequence = [];
  let exhausted = null;
  let attempts = 0;
  const HARD_CAP = 100;
  while (attempts < HARD_CAP) {
    attempts += 1;
    try {
      const r = await esc.recoverFrom(`http403#${attempts}`, {
        kind: ESC_KINDS.BANNED,
      });
      sequence.push(r.level);
      assert.notEqual(
        r.level,
        ESC_LEVELS.GEO,
        `kind=banned не должен запускать changeGeo, level=${r.level} attempt=${attempts}`,
      );
    } catch (e) {
      if (e instanceof EscalationExhausted) {
        exhausted = e;
        break;
      }
      throw e;
    }
  }

  assert(exhausted, "ожидали EscalationExhausted, не дождались");
  // L1×3 → L2 → L1×3 → L2 (op cap) → L1×3 → STOP
  // 11 эскалаций, 12-я кидает. Никаких 'geo'.
  const expected = [
    "ip", "ip", "ip", "operator",
    "ip", "ip", "ip", "operator",
    "ip", "ip", "ip",
  ];
  assert.deepEqual(
    sequence,
    expected,
    `kind=banned последовательность:\nожидали ${JSON.stringify(expected)}\n` +
      `получили ${JSON.stringify(sequence)}`,
  );
  assert.equal(client.calls.changeGeo, 0, "kind=banned НЕ должен звать changeGeo");
  assert.equal(client.calls.changeOperator, 2);
  assert.equal(client.calls.rotateIp, 9);
  assert(
    /changeGeo ПОЛИТИКОЙ ЗАПРЕЩЁН/i.test(exhausted.message),
    `сообщение должно явно говорить про политику запрета changeGeo: ${exhausted.message}`,
  );

  console.log("[ok] test_banned_never_changes_geo");
}

// ───────────────────────────────────────────────────────────────
// Test 7. kind='net_down' разрешает changeGeo, но всё равно сначала
// должен отработать L1 (changeIp) — пользователь явно сказал
// «менять локацию только если смена IP не помогает».
// ───────────────────────────────────────────────────────────────

async function test_net_down_tries_ip_first() {
  logs.length = 0;
  const client = makeMockClient();
  const stealth = makeFakeStealth();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth,
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 3,
    maxOperatorSwapsBeforeGeo: 2,
    maxGeoSwaps: 1,
    maxTotalFailures: 20,
    maxBudgetSec: 60,
  });

  // Первый же провал — даже на kind=net_down — должен пойти в L1.
  const r1 = await esc.recoverFrom("net1", { kind: ESC_KINDS.NET_DOWN });
  assert.equal(r1.level, ESC_LEVELS.IP);
  assert.equal(client.calls.changeGeo, 0);

  // Доводим L1 до конца — следующий должен быть L2 (всё ещё не geo).
  await esc.recoverFrom("net2", { kind: ESC_KINDS.NET_DOWN });
  await esc.recoverFrom("net3", { kind: ESC_KINDS.NET_DOWN });
  const r4 = await esc.recoverFrom("net4", { kind: ESC_KINDS.NET_DOWN });
  assert.equal(r4.level, ESC_LEVELS.OPERATOR);
  assert.equal(client.calls.changeGeo, 0);

  // Полностью выгребаем L1+L2 в текущем гео. Только тогда — geo.
  await esc.recoverFrom("net5", { kind: ESC_KINDS.NET_DOWN });
  await esc.recoverFrom("net6", { kind: ESC_KINDS.NET_DOWN });
  await esc.recoverFrom("net7", { kind: ESC_KINDS.NET_DOWN });
  const r8 = await esc.recoverFrom("net8", { kind: ESC_KINDS.NET_DOWN });
  assert.equal(r8.level, ESC_LEVELS.OPERATOR);
  await esc.recoverFrom("net9", { kind: ESC_KINDS.NET_DOWN });
  await esc.recoverFrom("net10", { kind: ESC_KINDS.NET_DOWN });
  await esc.recoverFrom("net11", { kind: ESC_KINDS.NET_DOWN });
  const r12 = await esc.recoverFrom("net12", { kind: ESC_KINDS.NET_DOWN });
  assert.equal(r12.level, ESC_LEVELS.GEO, "L3 changeGeo должен сработать после L1+L2 выгреба");
  assert.equal(client.calls.changeGeo, 1);

  console.log("[ok] test_net_down_tries_ip_first");
}

// ───────────────────────────────────────────────────────────────
// Test 8. invalid kind кидается явной ошибкой (защита от опечаток
// в parser.js).
// ───────────────────────────────────────────────────────────────

async function test_invalid_kind_throws() {
  logs.length = 0;
  const client = makeMockClient();
  const esc = new ProxyEscalator({
    proxyClient: client,
    stealth: makeFakeStealth(),
    logger: logCollector,
    maxIpRotationsBeforeEquipment: 3,
    maxOperatorSwapsBeforeGeo: 2,
    maxGeoSwaps: 2,
    maxTotalFailures: 50,
    maxBudgetSec: 60,
  });

  let thrown = null;
  try {
    await esc.recoverFrom("bad-kind", { kind: "WHATEVER" });
  } catch (e) {
    thrown = e;
  }
  assert(thrown, "ожидали ошибку про невалидный kind");
  assert(
    /invalid kind=/.test(thrown.message),
    `сообщение про invalid kind, факт: ${thrown.message}`,
  );
  // Не должно быть вызовов клиента — мы выходим до них.
  assert.equal(client.calls.rotateIp, 0);

  console.log("[ok] test_invalid_kind_throws");
}

// ───────────────────────────────────────────────────────────────
// Runner
// ───────────────────────────────────────────────────────────────

async function main() {
  const tests = [
    test_ladder_terminates,
    test_recovery_after_success,
    test_time_budget,
    test_total_failures_cap,
    test_stealth_wait_buckets,
    test_banned_never_changes_geo,
    test_net_down_tries_ip_first,
    test_invalid_kind_throws,
  ];
  let passed = 0;
  let failed = 0;
  const t0 = monotonic();
  for (const t of tests) {
    try {
      await t();
      passed += 1;
    } catch (e) {
      failed += 1;
      console.error(`[FAIL] ${t.name}: ${e?.message ?? e}`);
      if (e?.stack) console.error(e.stack);
    }
  }
  const elapsed = monotonic() - t0;
  console.log(
    `\n=== тесты эскалатора: passed=${passed}/${tests.length}, ` +
      `failed=${failed}, elapsed=${elapsed.toFixed(2)}с ===`,
  );
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("runner упал:", e);
  process.exit(1);
});
