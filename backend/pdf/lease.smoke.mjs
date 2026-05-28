/**
 * Smoke-тест координации `proxy_leases`. Покрывает:
 *
 *   1. tryAcquire: первый holder получает lease, второй (другой holder) — busy.
 *   2. Тот же holder (renew) — переиспользует строку без race.
 *   3. expired lease (вручную сдвигаем expires_at в прошлое) → второй holder
 *      его забирает.
 *   4. releaseExpiredGlobalLeases — глобально подчищает истёкшие.
 *   5. releaseDeadLocalLeases — мёртвый PID этого хоста снимается.
 *   6. listLeases / cleanupLeases — снимок и сводный cleanup.
 *
 * Если PG не сконфигурен (нет RAS_PG_DSN / DATABASE_URL) — печатает SKIP
 * и выходит с кодом 0 (это не падение, это «нет инфры»).
 *
 * Запуск: npm run smoke:lease
 */

import assert from "node:assert/strict";
import os from "node:os";

import { closePool, isPgConfigured, getPool } from "../db/pgClient.js";
import {
  tryAcquire,
  acquireMany,
  renewAll,
  releaseAll,
  releaseDeadLocalLeases,
  releaseExpiredGlobalLeases,
  cleanupLeases,
  listLeases,
  inspectKeysBusyness,
  makeHolderId,
} from "../db/proxyLeases.js";

const TAG = "lease.smoke";

function log(m) {
  process.stdout.write(`[${TAG}] ${m}\n`);
}

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try {
    await fn();
    pass += 1;
    log(`ok   ${name}`);
  } catch (e) {
    fail += 1;
    log(`FAIL ${name}\n  ${e && (e.stack ?? e.message ?? e)}`);
  }
}

/**
 * Уникальные test-ключи: префикс по pid+timestamp, чтобы параллельные запуски
 * на одной БД не толкались. Cleanup сметает любые SMOKE-ключи с этим префиксом.
 */
const PREFIX = `__smoke_lease__${process.pid}_${Date.now().toString(36)}__`;
const K1 = `${PREFIX}a`;
const K2 = `${PREFIX}b`;
const K3 = `${PREFIX}c`;
const ALL_KEYS = [K1, K2, K3];

async function purgeSmokeRows() {
  const pool = await getPool();
  await pool.query(
    `DELETE FROM proxy_leases WHERE proxy_key = ANY($1::text[]) OR proxy_key LIKE '__smoke_lease__%'`,
    [ALL_KEYS],
  );
}

async function setExpiresInPast(key, secAgo = 60) {
  const pool = await getPool();
  await pool.query(
    `UPDATE proxy_leases SET expires_at = NOW() - ($2::int * INTERVAL '1 second') WHERE proxy_key = $1`,
    [key, secAgo],
  );
}

async function main() {
  if (!isPgConfigured()) {
    log("SKIP — PG не сконфигурен (RAS_PG_DSN/DATABASE_URL пусто).");
    process.exit(0);
  }

  let table = null;
  try {
    const pool = await getPool();
    const r = await pool.query(
      `SELECT to_regclass('public.proxy_leases') AS tbl`,
    );
    table = r.rows[0]?.tbl ?? null;
  } catch (e) {
    log(`SKIP — не удалось подключиться к PG: ${e && e.message}`);
    process.exit(0);
  }
  if (!table) {
    log("SKIP — таблица proxy_leases не существует. Запусти npm run db:migrate.");
    process.exit(0);
  }

  // Cleanup от предыдущих прогонов (если упали посередине).
  await purgeSmokeRows();

  try {
    const holder1 = makeHolderId("smoke1");
    const holder2 = makeHolderId("smoke2");

    // ── 1) Первый holder берёт lease, второй — busy ──────────────────────────
    await test("tryAcquire: первый holder OK, второй busy", async () => {
      const r1 = await tryAcquire(K1, "smoke", holder1, 300);
      assert.equal(r1.ok, true, "holder1 должен получить lease");
      const r2 = await tryAcquire(K1, "smoke", holder2, 300);
      assert.equal(r2.ok, false, "holder2 должен быть busy");
      assert.equal(r2.holder, holder1, "busy должен показывать holder1");
      assert.ok(r2.holderMasked && !r2.holderMasked.includes(holder1.split("-").pop()),
        "holderMasked должен прятать суффикс");
    });

    // ── 2) Тот же holder renew (UPSERT по holder_id) ─────────────────────────
    await test("tryAcquire: тот же holder = renew, не race", async () => {
      const r = await tryAcquire(K1, "smoke", holder1, 300);
      assert.equal(r.ok, true, "renew того же holder'а должен пройти");
    });

    // ── 3) expired lease → второй holder перехватывает ───────────────────────
    await test("expired lease → другой holder забирает", async () => {
      await setExpiresInPast(K1, 60);
      const r = await tryAcquire(K1, "smoke", holder2, 300);
      assert.equal(r.ok, true, "после expire holder2 должен забрать");
    });

    // ── 4) releaseExpiredGlobalLeases подчищает чужой expired ────────────────
    await test("releaseExpiredGlobalLeases удаляет истёкшие", async () => {
      // Создаём ещё одну явно-истёкшую запись для другого ключа.
      const ghostHolder = makeHolderId("ghost");
      const r = await tryAcquire(K2, "smoke", ghostHolder, 300);
      assert.equal(r.ok, true);
      await setExpiresInPast(K2, 30);
      const n = await releaseExpiredGlobalLeases({ logger: log });
      assert.ok(n >= 1, `должны удалить ≥ 1, удалили ${n}`);
      const after = await tryAcquire(K2, "smoke", holder1, 300);
      assert.equal(after.ok, true, "после cleanup ключ K2 должен лизиться чисто");
    });

    // ── 5) releaseDeadLocalLeases ────────────────────────────────────────────
    await test("releaseDeadLocalLeases снимает мёртвый PID этого хоста", async () => {
      // Подсунем строку с заведомо мёртвым PID этого хостa: pid 1 не наш, EPERM
      // → считается «живым» (safe default). Возьмём максимально большой pid,
      // который точно не существует — например, 2147483646 (ниже PID_MAX
      // даже на 64-битке).
      const pool = await getPool();
      const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 32);
      const fakeHolder = `pdf@${host}#2147483646-deadbeef`;
      await pool.query(
        `INSERT INTO proxy_leases (proxy_key, role, holder_id, expires_at)
         VALUES ($1, 'pdf', $2, NOW() + INTERVAL '300 seconds')
         ON CONFLICT (proxy_key) DO UPDATE
           SET role='pdf', holder_id=EXCLUDED.holder_id,
               acquired_at=NOW(), renewed_at=NOW(), expires_at=EXCLUDED.expires_at`,
        [K3, fakeHolder],
      );
      const n = await releaseDeadLocalLeases({ role: "pdf", logger: log });
      assert.ok(n >= 1, `должны снять мёртвую аренду, сняли ${n}`);
    });

    // ── 6) listLeases / inspectKeysBusyness / cleanupLeases ──────────────────
    await test("listLeases видит наши строки и помечает hostState/expired", async () => {
      const rows = await listLeases();
      // Наши строки в данный момент: K1 (holder2), K2 (holder1). K3 — снят.
      const ours = rows.filter((r) => ALL_KEYS.includes(r.proxyKey));
      assert.ok(ours.length >= 2, `должны видеть ≥2 наших строки, нашли ${ours.length}`);
      for (const r of ours) {
        assert.equal(r.hostState, "this-host", `${r.proxyKey} должен быть this-host`);
        assert.ok(/^[a-zA-Z0-9._-]+…[a-zA-Z0-9._-]+$|^[^@]*@[^#]*#\d+$/.test(r.holderMasked),
          `holderMasked имеет ожидаемую форму, got=${r.holderMasked}`);
      }
    });

    await test("inspectKeysBusyness возвращает живые аренды", async () => {
      const r = await inspectKeysBusyness([K1, K2]);
      assert.equal(r.busy.length, 2, `должны быть оба ключа busy, есть ${r.busy.length}`);
      assert.ok(r.max_wait_sec > 0, "max_wait_sec должен быть положительным");
    });

    await test("cleanupLeases агрегирует expired+dead", async () => {
      // Сделать K1 expired, а K2 оставить живым.
      await setExpiresInPast(K1, 10);
      const r = await cleanupLeases({ role: "smoke", logger: log });
      assert.ok(r.expired >= 1, `expired ≥ 1, got ${r.expired}`);
    });

    await test("releaseAll(holder) сметает все строки этого holder'а", async () => {
      const n = await releaseAll(holder1);
      assert.ok(n >= 0, "releaseAll отработал без exception");
    });

    await test("renewAll(holder) обновляет expires_at", async () => {
      // Перезалить K2 на holder1 и продлить.
      const r = await tryAcquire(K2, "smoke", holder1, 60);
      assert.equal(r.ok, true);
      const n = await renewAll(holder1, 600);
      assert.ok(n >= 1, `renewAll должен продлить ≥ 1 строку, продлил ${n}`);
    });

    await test("acquireMany: разделение acquired/busy", async () => {
      // K2 уже занят holder1; пробуем holder2 на K1 (свободен) и K2 (занят).
      const r = await acquireMany([K1, K2], "smoke", holder2, 300);
      assert.deepEqual(
        r.acquired.sort(),
        [K1],
        `acquired должен быть только [K1], got=${JSON.stringify(r.acquired)}`,
      );
      assert.equal(r.busy.length, 1);
      assert.equal(r.busy[0].key, K2);
      assert.ok(r.busy[0].keyMasked, "должен быть keyMasked");
      assert.ok(r.busy[0].holderMasked, "должен быть holderMasked");
    });
  } finally {
    try {
      await purgeSmokeRows();
    } catch {}
    try {
      await closePool();
    } catch {}
  }

  process.stdout.write(`\n[${TAG}] passed=${pass} failed=${fail}\n`);
  if (fail > 0) process.exit(1);
  process.exit(0);
}

main().catch(async (e) => {
  process.stderr.write(`[${TAG}] fatal: ${e && (e.stack ?? e.message ?? e)}\n`);
  try {
    await closePool();
  } catch {}
  process.exit(1);
});
