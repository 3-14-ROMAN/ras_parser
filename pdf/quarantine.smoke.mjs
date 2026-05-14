/**
 * Fault-injection smoke для quarantine + _downloadWorker.
 *
 * Реальные ras.arbitr.ru / Chromium / MobileProxy не дёргаются — подменяем
 * только PdfDownloader (downloadAndSave возвращает программируемые r-shape).
 * Используем настоящие `SharedActQueue` и `_downloadWorker` из pipeline.js,
 * настоящий `ProxyQuarantineRegistry`. DB не трогается, потому что все сценарии
 * заканчиваются deferAct (success-path в worker'е не выполняется).
 *
 * Запуск: node pdf/quarantine.smoke.mjs
 */
import assert from "node:assert/strict";

// Зафиксировать env ДО импорта pipeline.js (он читает RAS_PDF_* на module-eval).
process.env.RAS_PDF_QUARANTINE_INFRA_THRESHOLD = "2";
process.env.RAS_PDF_QUARANTINE_451_THRESHOLD = "2";
process.env.RAS_PDF_QUARANTINE_WINDOW_MS = "180000";
process.env.RAS_PDF_QUARANTINE_MS = "300000";
process.env.RAS_PDF_QUARANTINE_451_MS = "900000";
// Уменьшаем infra-backoff чтоб тест быстрее проходил (на проде дефолт 10-30с).
process.env.RAS_PDF_INFRA_BACKOFF_MIN_MS = "20";
process.env.RAS_PDF_INFRA_BACKOFF_MAX_MS = "30";

const { __test__: pipelineTest } = await import("./pipeline.js");
const { SharedActQueue, _downloadWorker } = pipelineTest;
const { ProxyQuarantineRegistry, readQuarantineConfigFromEnv } = await import(
  "./proxyQuarantine.js"
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────── вспомогательные ───────────────────────

function makeRecordingLogger() {
  const lines = [];
  const log = (m) => {
    lines.push(m);
    process.stdout.write(`${m}\n`);
  };
  return { log, lines };
}

/**
 * Фейковый PdfDownloader: на каждый акт возвращает заранее заданный r-shape
 * из карты `outcomesByProxy.get(proxyKey)` (FIFO). Если очередь пуста — успех-заглушка
 * (не должен попадаться в наших сценариях).
 */
function makeFakeDownloader({ proxyKey, outcomesByProxy, log, paceMs = 1 }) {
  const outcomes = outcomesByProxy.get(proxyKey) ?? [];
  let n = 0;
  const inst = {
    proxyClient: null,
    getSessionPdfSavedCount: () => 0,
    async paceAfterSuccess() {
      return 0;
    },
    async paceAfterFailure() {
      await sleep(paceMs);
      return paceMs;
    },
    async _restartPdfSurface(reason) {
      log(`[fake/${proxyKey}] _restartPdfSurface: ${reason}`);
    },
    async downloadAndSave(act) {
      n += 1;
      const idx = Math.min(n - 1, outcomes.length - 1);
      const r = outcomes[idx];
      if (!r) {
        return { ok: false, error: "no outcome configured", status: null };
      }
      log(
        `[fake/${proxyKey}] downloadAndSave id=${act.id} → ` +
          `${r.ok ? "ok" : `fail ${r.error}${r.status ? ` status=${r.status}` : ""}${r.infra ? " infra" : ""}${r.deferred ? " deferred" : ""}`}`,
      );
      // Симулируем небольшую задержку, чтобы воркеры успели чередоваться.
      await sleep(2);
      return r;
    },
  };
  return inst;
}

function makeRefillableSource({ acts, log }) {
  let given = false;
  return new SharedActQueue({
    fetchBatch: async () => {
      if (given) return [];
      given = true;
      log(`[src] выдаю стартовый батч из ${acts.length} актов`);
      return acts.slice();
    },
    refillable: true,
    logger: log,
  });
}

function countLines(lines, substr) {
  return lines.filter((l) => l.includes(substr)).length;
}

// ─────────────────────── SCENARIO A: infra quarantine ───────────────────────

async function scenarioInfraQuarantine() {
  process.stdout.write("\n══════ SCENARIO A: infra quarantine ══════\n");
  const { log, lines } = makeRecordingLogger();

  // 20 актов, 2 воркера. Воркер «pA» возвращает ERR_TUNNEL_CONNECTION_FAILED
  // (infra), воркер «pB» — «recoverable skip» (no-DB). Запас по актам нужен,
  // чтобы pA гарантированно успел поймать ≥ infraThreshold фейлов до того,
  // как pB разгребёт очередь (pB цикл ~3ms, pA с backoff ~25ms).
  const acts = Array.from({ length: 20 }, (_, i) => ({
    id: `act-${i + 1}`,
    pdf_link: "x",
    case_id: "c1",
  }));
  const infraR = {
    ok: false,
    recoverable: true,
    deferred: true,
    infra: true,
    reason: "proxy_tunnel_failed",
    status: null,
    error: "kad session failed: net::ERR_TUNNEL_CONNECTION_FAILED",
  };
  const benignSkipR = {
    ok: false,
    recoverable: true,
    error: "stub-skip",
    status: null,
  };

  const outcomes = new Map();
  // pA: бесконечный infra
  outcomes.set("pA", Array.from({ length: 20 }, () => infraR));
  // pB: безобидный recoverable skip — просто крутит claimNext, ничего в БД
  outcomes.set("pB", Array.from({ length: 20 }, () => benignSkipR));

  const source = makeRefillableSource({ acts, log });
  const cfg = readQuarantineConfigFromEnv();
  const quarantine = new ProxyQuarantineRegistry(cfg);

  const counters = {
    downloaded: 0,
    dl_failed: 0,
    dl_deferred: 0,
    infra_deferred: 0,
    worker_restarts: 0,
    worker_paused: 0,
    extracted: 0,
    ex_failed: 0,
  };
  const runState = { totalSeen: 0 };
  let stop = false;
  const shouldStop = () => stop;

  // pB замедляем (40ms между актами) — иначе он за пару миллисекунд
  // выгребает всю очередь и pA не успевает на второй infra-defer.
  const workers = ["pA", "pB"].map((pk) => ({
    label: `w-${pk}`,
    proxyKey: pk,
    downloader: makeFakeDownloader({
      proxyKey: pk,
      outcomesByProxy: outcomes,
      log,
      paceMs: pk === "pB" ? 40 : 1,
    }),
  }));

  // Запускаем оба воркера; через 1.5с останавливаем.
  const tasks = workers.map((w) =>
    _downloadWorker({
      label: w.label,
      downloader: w.downloader,
      proxyKey: w.proxyKey,
      quarantine,
      source,
      queue: { push: async () => {}, close: () => {} }, // не дойдём
      log,
      counters,
      runState,
      shouldStop,
    }),
  );

  await sleep(1500);
  stop = true;
  await Promise.all(tasks);

  // Проверки:
  // 1) pA получил >=2 infra-фейла (порог), карантин включился.
  const infraDefers = lines.filter((l) =>
    /\[pdf\/defer\] id=.* reason=infra_/.test(l),
  );
  assert.ok(infraDefers.length >= 2, `expected ≥2 infra defers, got ${infraDefers.length}`);
  const quarantineEntered = lines.filter((l) =>
    /\[pdf\/quarantine\] proxy=pA…?\s? reason=infra/.test(l),
  );
  assert.equal(
    quarantineEntered.length,
    1,
    `expected exactly 1 [pdf/quarantine] reason=infra line, got ${quarantineEntered.length}`,
  );
  // 2) Логи в правильном порядке: deferAct до record — проверяем по индексам.
  const firstInfraDeferIdx = lines.findIndex((l) => l.includes("[pdf/defer] id=") && l.includes("reason=infra_"));
  const firstQuarantineIdx = lines.findIndex((l) =>
    /\[pdf\/quarantine\] proxy=pA…? reason=infra/.test(l),
  );
  assert.ok(
    firstInfraDeferIdx < firstQuarantineIdx,
    "infra defer log should appear BEFORE quarantine record",
  );
  // 3) После карантина pA НЕ делал claimNext (downloadAndSave) — между
  //    quarantine-log и stop в логе не должно быть pA downloadAndSave.
  const pAcalls = lines.filter((l) => l.startsWith("[fake/pA] downloadAndSave"));
  const pAcallsAfterQuarantine = pAcalls.filter(
    (l) => lines.indexOf(l) > firstQuarantineIdx,
  );
  assert.equal(
    pAcallsAfterQuarantine.length,
    0,
    `expected 0 pA downloadAndSave calls after quarantine, got ${pAcallsAfterQuarantine.length}`,
  );
  // 4) pB продолжал работать ПОСЛЕ карантина pA.
  const pBcalls = lines.filter((l) => l.startsWith("[fake/pB] downloadAndSave"));
  const pBcallsAfterQuarantine = pBcalls.filter(
    (l) => lines.indexOf(l) > firstQuarantineIdx,
  );
  assert.ok(
    pBcallsAfterQuarantine.length > 0,
    "pB should keep working after pA goes to quarantine",
  );

  process.stdout.write(
    `\nSCENARIO A: infra defers=${infraDefers.length}, ` +
      `quarantine_entered=${quarantineEntered.length}, ` +
      `pA calls after quarantine=${pAcallsAfterQuarantine.length}, ` +
      `pB calls after pA-quarantine=${pBcallsAfterQuarantine.length}\n`,
  );
  return lines;
}

// ─────────────────────── SCENARIO B: 451 quarantine ───────────────────────

async function scenarioFourFiftyOneQuarantine() {
  process.stdout.write("\n══════ SCENARIO B: 451 quarantine ══════\n");
  const { log, lines } = makeRecordingLogger();

  const acts = Array.from({ length: 20 }, (_, i) => ({
    id: `act-${10 + i + 1}`,
    pdf_link: "x",
    case_id: "c1",
  }));
  // ВАЖНО: r-shape, который возвращает наш downloader.js при первом 451 после моих правок.
  const four51R = {
    ok: false,
    deferred: true,
    recoverable: true,
    status: 451,
    error: "451_defer_first_hit",
  };
  const benignSkipR = {
    ok: false,
    recoverable: true,
    error: "stub-skip",
    status: null,
  };
  const outcomes = new Map();
  outcomes.set("pX", Array.from({ length: 20 }, () => four51R));
  outcomes.set("pY", Array.from({ length: 20 }, () => benignSkipR));

  const source = makeRefillableSource({ acts, log });
  const cfg = readQuarantineConfigFromEnv();
  const quarantine = new ProxyQuarantineRegistry(cfg);

  const counters = {
    downloaded: 0,
    dl_failed: 0,
    dl_deferred: 0,
    infra_deferred: 0,
    worker_restarts: 0,
    worker_paused: 0,
    extracted: 0,
    ex_failed: 0,
  };
  const runState = { totalSeen: 0 };
  let stop = false;
  const shouldStop = () => stop;

  const workers = ["pX", "pY"].map((pk) => ({
    label: `w-${pk}`,
    proxyKey: pk,
    downloader: makeFakeDownloader({
      proxyKey: pk,
      outcomesByProxy: outcomes,
      log,
      paceMs: pk === "pY" ? 40 : 1,
    }),
  }));

  const tasks = workers.map((w) =>
    _downloadWorker({
      label: w.label,
      downloader: w.downloader,
      proxyKey: w.proxyKey,
      quarantine,
      source,
      queue: { push: async () => {}, close: () => {} },
      log,
      counters,
      runState,
      shouldStop,
    }),
  );

  await sleep(1000);
  stop = true;
  await Promise.all(tasks);

  // 1) Никаких rotateIp/_handleRateLimit в логе (мы их не вызываем — fake'у нечего вызывать;
  //    важнее: downloader на воркере pX вызван не больше 3 раз (2 порог + 1 заскочивший).
  const pXcalls = lines.filter((l) => l.startsWith("[fake/pX] downloadAndSave"));
  assert.ok(
    pXcalls.length >= 2 && pXcalls.length <= 4,
    `pX downloadAndSave должно быть 2..4 (порог 451=2 + race), got ${pXcalls.length}`,
  );
  // 2) Quarantine line с reason=451 ровно один раз.
  const quarantineEntered = lines.filter((l) =>
    /\[pdf\/quarantine\] proxy=pX…? reason=451/.test(l),
  );
  assert.equal(
    quarantineEntered.length,
    1,
    `expected exactly 1 [pdf/quarantine] reason=451 line, got ${quarantineEntered.length}`,
  );
  // 3) Каждый акт у pX получает РОВНО один downloadAndSave (не 6 retry).
  //    Проверяем по уникальным id среди pX calls.
  const pXids = new Set(
    pXcalls.map((l) => l.match(/id=(\S+)/)?.[1]).filter(Boolean),
  );
  assert.equal(
    pXcalls.length,
    pXids.size,
    `pX caught one act >1 time — ожидался ровно 1 attempt per act, got ${pXcalls.length} calls for ${pXids.size} unique ids`,
  );
  // 4) deferAct до record — порядок логов.
  const firstDeferIdx = lines.findIndex((l) => /\[fake\/pX\] downloadAndSave/.test(l));
  const firstQIdx = lines.findIndex((l) =>
    /\[pdf\/quarantine\] proxy=pX…? reason=451/.test(l),
  );
  assert.ok(firstDeferIdx < firstQIdx, "451 defer should precede quarantine entry");

  process.stdout.write(
    `\nSCENARIO B: pX 451-attempts=${pXcalls.length}, unique acts=${pXids.size}, ` +
      `quarantine_entered=${quarantineEntered.length}\n`,
  );
  return lines;
}

// ─────────────────── SCENARIO C: success clears window, cooldown stays ───────────────────

async function scenarioSuccessClears() {
  process.stdout.write("\n══════ SCENARIO C: success чистит окно, cooldown остаётся ══════\n");
  let t = 0;
  const reg = new ProxyQuarantineRegistry({
    infraThreshold: 3,
    fourFiftyOneThreshold: 3,
    windowMs: 10_000,
    infraCooldownMs: 5000,
    fourFiftyOneCooldownMs: 30_000,
    now: () => t,
  });
  // Накапливаем 2 infra-фейла (ниже порога).
  reg.recordInfra("k1");
  reg.recordInfra("k1");
  assert.equal(reg.isQuarantined("k1"), false);
  // recordSuccess чистит окно.
  reg.recordSuccess("k1");
  // Теперь 2 infra-фейла снова — НЕ должны триггернуть карантин (счёт с нуля).
  const r1 = reg.recordInfra("k1");
  const r2 = reg.recordInfra("k1");
  assert.equal(r1.entered, false);
  assert.equal(r2.entered, false);
  assert.equal(r2.fails, 2);
  // Третий — триггер.
  const r3 = reg.recordInfra("k1");
  assert.equal(r3.entered, true);
  assert.equal(reg.isQuarantined("k1"), true);
  // recordSuccess после установки cooldown — окно чистится, но cooldown остаётся.
  reg.recordSuccess("k1");
  assert.equal(
    reg.isQuarantined("k1"),
    true,
    "cooldown НЕ должен сбрасываться recordSuccess'ом",
  );
  // Cooldown истекает по времени.
  t += 5001;
  assert.equal(reg.isQuarantined("k1"), false);
  process.stdout.write("SCENARIO C: ok — success чистит окна, cooldown истекает по времени\n");
}

// ─────────────────── SCENARIO D: SIGINT во время quarantine-sleep ───────────────────

async function scenarioSigintDuringSleep() {
  process.stdout.write("\n══════ SCENARIO D: SIGINT во время quarantine sleep ══════\n");
  const { log, lines } = makeRecordingLogger();
  const acts = [
    { id: "act-21", pdf_link: "x", case_id: "c1" },
    { id: "act-22", pdf_link: "x", case_id: "c1" },
  ];
  const infraR = {
    ok: false,
    recoverable: true,
    deferred: true,
    infra: true,
    reason: "proxy_tunnel_failed",
    status: null,
    error: "kad session failed: ERR_TUNNEL_CONNECTION_FAILED",
  };
  const outcomes = new Map();
  outcomes.set("pZ", Array.from({ length: 20 }, () => infraR));

  const source = makeRefillableSource({ acts, log });
  const cfg = readQuarantineConfigFromEnv();
  const quarantine = new ProxyQuarantineRegistry(cfg);

  const counters = {
    downloaded: 0,
    dl_failed: 0,
    dl_deferred: 0,
    infra_deferred: 0,
    worker_restarts: 0,
    worker_paused: 0,
    extracted: 0,
    ex_failed: 0,
  };
  const runState = { totalSeen: 0 };
  let stop = false;
  const shouldStop = () => stop;

  const downloader = makeFakeDownloader({
    proxyKey: "pZ",
    outcomesByProxy: outcomes,
    log,
  });
  const task = _downloadWorker({
    label: "w-pZ",
    downloader,
    proxyKey: "pZ",
    quarantine,
    source,
    queue: { push: async () => {}, close: () => {} },
    log,
    counters,
    runState,
    shouldStop,
  });

  // Ждём пока воркер войдёт в карантин.
  let waited = 0;
  while (waited < 2000 && !quarantine.isQuarantined("pZ")) {
    await sleep(20);
    waited += 20;
  }
  assert.ok(
    quarantine.isQuarantined("pZ"),
    "worker must enter quarantine within 2s",
  );
  process.stdout.write(`SCENARIO D: worker вошёл в карантин за ${waited}ms; шлю stop\n`);

  // Имитируем SIGINT — воркер спит в quarantine chunk'ах по 5с, должен выйти за <=5с.
  const t0 = Date.now();
  stop = true;
  await Promise.race([
    task,
    sleep(6000).then(() => {
      throw new Error("worker не вышел за 6с после stop");
    }),
  ]);
  const exitedAfter = Date.now() - t0;
  assert.ok(exitedAfter <= 5500, `exit ${exitedAfter}ms > 5500ms`);
  process.stdout.write(`SCENARIO D: воркер вышел за ${exitedAfter}ms после stop\n`);
}

// ─────────── SCENARIO E: all_workers_sleeping лог ───────────

async function scenarioAllSleeping() {
  process.stdout.write("\n══════ SCENARIO E: all_workers_sleeping ══════\n");
  const { log, lines } = makeRecordingLogger();
  const acts = Array.from({ length: 20 }, (_, i) => ({
    id: `act-${100 + i}`,
    pdf_link: "x",
    case_id: "c1",
  }));
  const infraR = {
    ok: false,
    recoverable: true,
    deferred: true,
    infra: true,
    reason: "proxy_tunnel_failed",
    status: null,
    error: "kad session failed: ERR_TUNNEL_CONNECTION_FAILED",
  };
  const outcomes = new Map();
  outcomes.set("pQ1", Array.from({ length: 20 }, () => infraR));
  outcomes.set("pQ2", Array.from({ length: 20 }, () => infraR));

  const source = makeRefillableSource({ acts, log });
  const cfg = readQuarantineConfigFromEnv();
  const quarantine = new ProxyQuarantineRegistry(cfg);

  const allWorkerKeys = ["pQ1", "pQ2"];
  const allSleepingState = { announced: false };
  const announceAllSleepingIfApplicable = () => {
    const sleeping = allWorkerKeys.filter((k) => quarantine.isQuarantined(k));
    if (sleeping.length === allWorkerKeys.length) {
      if (!allSleepingState.announced) {
        log(
          `[pdf/quarantine] all_workers_sleeping active=0 quarantined=${sleeping.length}`,
        );
        allSleepingState.announced = true;
      }
    } else if (allSleepingState.announced) {
      allSleepingState.announced = false;
    }
  };

  const counters = {
    downloaded: 0,
    dl_failed: 0,
    dl_deferred: 0,
    infra_deferred: 0,
    worker_restarts: 0,
    worker_paused: 0,
    extracted: 0,
    ex_failed: 0,
  };
  const runState = { totalSeen: 0 };
  let stop = false;
  const shouldStop = () => stop;
  const tasks = allWorkerKeys.map((pk) =>
    _downloadWorker({
      label: `w-${pk}`,
      downloader: makeFakeDownloader({
        proxyKey: pk,
        outcomesByProxy: outcomes,
        log,
      }),
      proxyKey: pk,
      quarantine,
      announceAllSleepingIfApplicable,
      source,
      queue: { push: async () => {}, close: () => {} },
      log,
      counters,
      runState,
      shouldStop,
    }),
  );

  await sleep(1500);
  stop = true;
  await Promise.all(tasks);

  const allSleeping = lines.filter((l) =>
    l.includes("[pdf/quarantine] all_workers_sleeping"),
  );
  assert.equal(
    allSleeping.length,
    1,
    `expected exactly 1 all_workers_sleeping log, got ${allSleeping.length}`,
  );
  assert.match(allSleeping[0], /active=0 quarantined=2/);
  process.stdout.write(`SCENARIO E: ok — '${allSleeping[0]}'\n`);
  return lines;
}

// ─────────────────────── main ───────────────────────

const linesA = await scenarioInfraQuarantine();
const linesB = await scenarioFourFiftyOneQuarantine();
await scenarioSuccessClears();
await scenarioSigintDuringSleep();
await scenarioAllSleeping();

// Печатаем фрагменты логов для глаз.
process.stdout.write("\n\n──────── фрагмент SCENARIO A (infra) ────────\n");
for (const l of linesA.filter(
  (l) =>
    l.includes("[fake/pA]") ||
    l.includes("[pdf/defer]") ||
    l.includes("[pdf/quarantine]") ||
    l.includes("[fake/pB] downloadAndSave"),
)) {
  process.stdout.write(`${l}\n`);
}
process.stdout.write("\n──────── фрагмент SCENARIO B (451) ────────\n");
for (const l of linesB.filter(
  (l) =>
    l.includes("[fake/pX]") ||
    l.includes("[pdf/defer]") ||
    l.includes("[pdf/quarantine]"),
)) {
  process.stdout.write(`${l}\n`);
}

process.stdout.write("\nALL SCENARIOS OK\n");
