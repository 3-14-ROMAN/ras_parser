/**
 * db/proxyLeases.js — координация занятых прокси между parser.js и
 * scripts/download-acts.js. Без этого оба процесса могут схватить один и
 * тот же `MP_PROXY_KEY` и крутить changeIp/смену оператора друг под друга,
 * сжигая cooldowns и куки.
 *
 * Подход: lease-таблица в Postgres (`proxy_leases`). Каждый процесс на старте
 * пытается атомарно занять свои proxy_key с TTL ~5 мин и продлевает раз в
 * ~heartbeat сек. Если процесс падает / kill -9 — TTL истекает, и другой
 * процесс может «увести» ключ.
 *
 * Контракт:
 *   - tryAcquire(key, role, holderId, ttl) — атомарный INSERT/UPDATE, вернёт
 *     true если ключ занят НАМИ (либо был свободен, либо был с истёкшим TTL).
 *     false если активная аренда у другого holder'а.
 *   - acquireMany([keys], role, holderId, ttl) — пытается занять все ключи,
 *     возвращает разделение { acquired, busy }.
 *   - renewAll(holderId, ttl) — продлевает все аренды этого holder'а.
 *   - releaseAll(holderId) — удаляет все аренды этого holder'а.
 *   - startHeartbeat(...) — крутит renewAll в фоне с интервалом, возвращает
 *     stop()-функцию.
 *
 * Если PG не сконфигурен — все функции no-op, lease отключается (логируется
 * предупреждение). Это нужно, чтобы parser.js в `MODE_TYPES` (без БД) не падал.
 */

import os from "node:os";
import crypto from "node:crypto";

import { getPool, isPgConfigured } from "./pgClient.js";

/**
 * Те же правила обрезки, что у makeHolderId; lower-case — чтобы сравнивать
 * holder с разным регистром hostname и с разными вариантами os.hostname().
 */
function normalizeLeaseHost(raw) {
  return String(raw ?? "")
    .replace(/[^a-zA-Z0-9._-]/g, "")
    .slice(0, 32)
    .toLowerCase();
}

/**
 * Разбор holder_id для cleanup / диагностики.
 * Каноника (makeHolderId): `<role>@<hostname>#<pid>-<rand>`.
 * Legacy: `pdf@pdf@<hostname>#<pid>-<rand>` — hostname после последнего `@`
 * до `#`; PID всегда сразу после последнего `#`.
 */
function parseHolderId(holderId) {
  const s = String(holderId ?? "");
  const hashIdx = s.lastIndexOf("#");
  if (hashIdx < 0) return null;
  const suffix = s.slice(hashIdx + 1);
  const tail = /^(\d+)-([0-9a-fA-F]+)$/.exec(suffix);
  if (!tail) return null;
  const pid = Number(tail[1]);
  if (!Number.isInteger(pid) || pid <= 0) return null;
  const rand = tail[2];
  const prefix = s.slice(0, hashIdx);
  const lastAt = prefix.lastIndexOf("@");
  if (lastAt < 0) return null;
  const role = prefix.slice(0, lastAt);
  const hostname = prefix.slice(lastAt + 1);
  if (!role || !hostname) return null;
  return { role, hostname, pid, rand };
}

/**
 * Жив ли процесс. `process.kill(pid, 0)` ничего не убивает, только проверяет.
 * ESRCH — нет такого процесса. EPERM — процесс есть, но не наш uid (считаем
 * живым: безопасный default, чтобы не угнать чужую аренду).
 */
function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === "EPERM";
  }
}

/**
 * Дефолты — поверх можно перегружать через env:
 *   RAS_PROXY_LEASE_TTL_SEC=300       — TTL аренды
 *   RAS_PROXY_LEASE_HEARTBEAT_SEC=60  — как часто продлеваем
 */
export const DEFAULT_TTL_SEC = Math.max(
  30,
  Number(process.env.RAS_PROXY_LEASE_TTL_SEC ?? 300),
);
export const DEFAULT_HEARTBEAT_SEC = Math.max(
  10,
  Number(process.env.RAS_PROXY_LEASE_HEARTBEAT_SEC ?? 60),
);

/** Уникальный id процесса для holder_id. Один на запуск. */
export function makeHolderId(role = "proc") {
  const host = os.hostname().replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 32);
  const rand = crypto.randomBytes(4).toString("hex");
  return `${role}@${host}#${process.pid}-${rand}`;
}

/**
 * Попытка атомарно занять ключ. Возвращает true если ключ теперь наш.
 *
 * SQL-логика: INSERT, если есть конфликт по PK — UPDATE только при условии
 * `expires_at < NOW() OR holder_id = $holderId`. RETURNING покажет, кто
 * сейчас держит. Если RETURNING пуст — значит активная аренда у другого.
 *
 * @param {string} key
 * @param {string} role
 * @param {string} holderId
 * @param {number} ttlSec
 * @returns {Promise<{ ok: boolean, holder?: string, role?: string, expiresAt?: Date }>}
 */
export async function tryAcquire(key, role, holderId, ttlSec = DEFAULT_TTL_SEC) {
  if (!isPgConfigured()) return { ok: true, holder: holderId, role };
  if (!key) throw new Error("[lease] tryAcquire: пустой proxy_key");
  const pool = await getPool();
  // Один атомарный UPSERT. Условие в WHERE гарантирует, что UPDATE не
  // перетрёт активную аренду чужого процесса.
  const res = await pool.query(
    `INSERT INTO proxy_leases (proxy_key, role, holder_id, expires_at, renewed_at)
     VALUES ($1, $2, $3, NOW() + ($4::int * INTERVAL '1 second'), NOW())
     ON CONFLICT (proxy_key) DO UPDATE
       SET role = EXCLUDED.role,
           holder_id = EXCLUDED.holder_id,
           acquired_at = NOW(),
           renewed_at = NOW(),
           expires_at = EXCLUDED.expires_at
       WHERE proxy_leases.expires_at < NOW()
          OR proxy_leases.holder_id = EXCLUDED.holder_id
     RETURNING role, holder_id, expires_at`,
    [key, role, holderId, ttlSec],
  );
  if (res.rowCount > 0 && res.rows[0].holder_id === holderId) {
    return {
      ok: true,
      holder: holderId,
      holderMasked: maskHolder(holderId),
      role,
      expiresAt: res.rows[0].expires_at,
    };
  }
  // INSERT/UPDATE не прошёл (живая аренда у другого) — узнаем, у кого.
  const who = await pool.query(
    `SELECT role, holder_id, expires_at FROM proxy_leases WHERE proxy_key = $1`,
    [key],
  );
  const row = who.rows[0];
  return {
    ok: false,
    holder: row?.holder_id ?? "?",
    holderMasked: maskHolder(row?.holder_id ?? "?"),
    role: row?.role ?? "?",
    expiresAt: row?.expires_at ?? null,
  };
}

/**
 * Попытаться занять несколько ключей. Возвращает разделение.
 * @param {string[]} keys
 * @param {string} role
 * @param {string} holderId
 * @param {number} ttlSec
 * @returns {Promise<{ acquired: string[], busy: Array<{ key: string, holder: string, role: string, expiresAt: Date|null }> }>}
 */
export async function acquireMany(keys, role, holderId, ttlSec = DEFAULT_TTL_SEC) {
  const acquired = [];
  const busy = [];
  for (const k of keys) {
    if (!k) continue;
    // Можно было бы параллелить, но keys обычно ≤ десятка — последовательно проще.
    // eslint-disable-next-line no-await-in-loop
    const r = await tryAcquire(k, role, holderId, ttlSec);
    if (r.ok) acquired.push(k);
    else
      busy.push({
        key: k,
        keyMasked: maskKey(k),
        holder: r.holder ?? "?",
        holderMasked: r.holderMasked ?? maskHolder(r.holder ?? "?"),
        role: r.role ?? "?",
        expiresAt: r.expiresAt ?? null,
      });
  }
  return { acquired, busy };
}

/**
 * Продлить ВСЕ активные аренды этого holder'а. Возвращает сколько строк продлили.
 */
export async function renewAll(holderId, ttlSec = DEFAULT_TTL_SEC) {
  if (!isPgConfigured()) return 0;
  const pool = await getPool();
  const res = await pool.query(
    `UPDATE proxy_leases
        SET renewed_at = NOW(),
            expires_at = NOW() + ($2::int * INTERVAL '1 second')
      WHERE holder_id = $1`,
    [holderId, ttlSec],
  );
  return res.rowCount ?? 0;
}

/**
 * Снять все аренды holder'а. Безопасно вызывать в finally/shutdown несколько раз.
 */
export async function releaseAll(holderId) {
  if (!isPgConfigured()) return 0;
  if (!holderId) return 0;
  const pool = await getPool();
  const res = await pool.query(
    `DELETE FROM proxy_leases WHERE holder_id = $1`,
    [holderId],
  );
  return res.rowCount ?? 0;
}

/**
 * Запустить heartbeat: каждые `heartbeatSec` сек продлевает аренды.
 * Возвращает stop()-функцию (вызвать в shutdown ПЕРЕД releaseAll).
 *
 * @param {{ holderId: string, ttlSec?: number, heartbeatSec?: number, logger?: (m: string) => void }} opts
 */
export function startHeartbeat({
  holderId,
  ttlSec = DEFAULT_TTL_SEC,
  heartbeatSec = DEFAULT_HEARTBEAT_SEC,
  logger = (m) => process.stdout.write(`${m}\n`),
}) {
  if (!isPgConfigured()) {
    logger(`[lease] PG не сконфигурен — heartbeat отключён`);
    return () => {};
  }
  let stopped = false;
  const tick = async () => {
    if (stopped) return;
    try {
      const n = await renewAll(holderId, ttlSec);
      if (n === 0) {
        logger(
          `[lease] heartbeat: НИ ОДНА аренда не продлилась для holder=${holderId}. ` +
            `Возможно, кто-то увёл ключ или TTL уже истёк.`,
        );
      }
    } catch (e) {
      logger(`[lease] heartbeat упал: ${e && e.message}`);
    }
  };
  const handle = setInterval(tick, heartbeatSec * 1000);
  if (handle.unref) handle.unref(); // не держим event loop
  return () => {
    stopped = true;
    clearInterval(handle);
  };
}

/**
 * Снять аренды этого хоста, у которых PID не живой. Нужно для self-healing
 * после kill -9 / краша: heartbeat успел продлить lease в будущее, а процесс
 * умер. Новый запуск с другим PID не может перехватить «свою» аренду через
 * tryAcquire (там условие holder_id = EXCLUDED.holder_id или expires_at < NOW),
 * поэтому отдельный шаг.
 *
 * Безопасно: режем только записи с нашим hostname и dead PID. Если процесс
 * под другим uid (EPERM) — считаем живым, не трогаем. Чужие хосты — не трогаем
 * никогда (PID на другой машине нам не виден).
 *
 * @param {{ role?: string|null, logger?: (m: string) => void }} opts
 * @returns {Promise<number>} сколько строк удалили
 */
export async function releaseDeadLocalLeases({ role = null, logger } = {}) {
  if (!isPgConfigured()) return 0;
  const log = logger ?? (() => {});
  const pool = await getPool();
  const hostnameKey = normalizeLeaseHost(os.hostname());
  const params = [hostnameKey];
  // Без LIKE: в шаблоне `_`/`%` из hostname не превращаются в wildcards;
  // lower(holder_id) + needle в lower — и `pdf@host#…`, и `pdf@pdf@host#…`.
  let sql =
    `SELECT proxy_key, role, holder_id FROM proxy_leases ` +
    `WHERE position(('@' || $1::text || '#') IN lower(holder_id)) > 0`;
  if (role) {
    sql += ` AND role = $2`;
    params.push(role);
  }
  const res = await pool.query(sql, params);
  const deadHolders = new Set();
  for (const row of res.rows) {
    const parsed = parseHolderId(row.holder_id);
    if (!parsed) continue;
    if (normalizeLeaseHost(parsed.hostname) !== hostnameKey) continue;
    if (parsed.pid === process.pid) continue;
    if (!isPidAlive(parsed.pid)) deadHolders.add(row.holder_id);
  }
  if (!deadHolders.size) return 0;
  const del = await pool.query(
    `DELETE FROM proxy_leases WHERE holder_id = ANY($1::text[])`,
    [[...deadHolders]],
  );
  log(
    `[lease] зачистил ${del.rowCount ?? 0} мёртвых аренд этого хоста ` +
      `(holders: ${[...deadHolders].map((h) => maskHolder(h)).join(", ")})`,
  );
  return del.rowCount ?? 0;
}

/**
 * Один-в-один helper для парсера: занять один ключ или упасть с понятной ошибкой.
 * Возвращает holderId (его потом передавать в releaseAll).
 */
export async function acquireSingleOrThrow({
  key,
  role,
  ttlSec = DEFAULT_TTL_SEC,
  logger = (m) => process.stdout.write(`${m}\n`),
}) {
  if (!isPgConfigured()) {
    logger(
      `[lease] PG не сконфигурен — координация прокси отключена. ` +
        `Если параллельно запускаешь parser+download-acts, дашь в один MP_PROXY_KEY.`,
    );
    return { holderId: makeHolderId(role), leased: false };
  }
  if (!key) {
    logger(`[lease] proxy_key пустой — пропускаю lease (single-proxy без API?)`);
    return { holderId: makeHolderId(role), leased: false };
  }
  const holderId = makeHolderId(role);
  const r = await tryAcquire(key, role, holderId, ttlSec);
  if (!r.ok) {
    const err = new Error(
      `[lease] proxy_key=${maskKey(key)} занят процессом '${r.holder}' (role=${r.role}), ` +
        `TTL до ${r.expiresAt?.toISOString?.() ?? "?"}. Останови этот процесс или подожди ` +
        `истечения TTL (по умолчанию ${DEFAULT_TTL_SEC}с).`,
    );
    err.code = "POOL_ALL_LEASED";
    err.details = {
      busy: [
        {
          key,
          holder: r.holder,
          role: r.role,
          expiresAt: r.expiresAt ?? null,
        },
      ],
    };
    throw err;
  }
  logger(
    `[lease] proxy_key=${maskKey(key)} занят (role=${role}, holder=${maskHolder(holderId)}, ttl=${ttlSec}s)`,
  );
  return { holderId, leased: true };
}

function maskKey(k) {
  if (!k) return "?";
  const s = String(k);
  if (s.length <= 8) return s;
  return `${s.slice(0, 6)}…${s.slice(-2)}`;
}

/**
 * holder_id формата `role@host#pid-rand`. Для логов оставляем role+host+pid,
 * rand-суффикс прячем — это просто разделитель параллельных запусков и в логе
 * сбивает с толку.
 */
function maskHolder(h) {
  const parsed = parseHolderId(h);
  if (!parsed) return String(h ?? "?");
  return `${parsed.role}@${parsed.hostname}#${parsed.pid}`;
}

// ──────────────────────── lease admin helpers ────────────────────────

/**
 * Глобально удалить все lease-строки с истёкшим TTL (любой хост, любой role).
 * Безопасно: TTL — контракт, после `expires_at` строка ничего не «защищает».
 * Используется на старте supervisor'а перед тем, как ругаться на «всё занято».
 *
 * @param {{ logger?: (m: string) => void }} [opts]
 * @returns {Promise<number>}
 */
export async function releaseExpiredGlobalLeases({ logger } = {}) {
  if (!isPgConfigured()) return 0;
  const log = logger ?? (() => {});
  const pool = await getPool();
  const res = await pool.query(
    `DELETE FROM proxy_leases WHERE expires_at <= NOW()`,
  );
  const n = res.rowCount ?? 0;
  if (n > 0) log(`[lease] подчистил ${n} expired lease(ов) (TTL прошёл)`);
  return n;
}

/**
 * Снять одну lease-строку (по proxy_key) — для ручного cleanup'а через CLI.
 * Возвращает true если удалили.
 */
export async function releaseOneKey(key) {
  if (!isPgConfigured()) return false;
  if (!key) return false;
  const pool = await getPool();
  const res = await pool.query(
    `DELETE FROM proxy_leases WHERE proxy_key = $1`,
    [key],
  );
  return (res.rowCount ?? 0) > 0;
}

/**
 * Снимок всех аренд + статус «живой PID / мёртвый PID на этом хосте / чужой хост».
 *
 * @returns {Promise<Array<{ proxyKey: string, proxyKeyMasked: string, role: string, holderId: string, holderMasked: string, holderHost: string|null, holderPid: number|null, hostState: 'this-host'|'other-host'|'unknown', pidAlive: boolean|null, acquiredAt: Date, renewedAt: Date, expiresAt: Date, expired: boolean }>>}
 */
export async function listLeases() {
  if (!isPgConfigured()) return [];
  const pool = await getPool();
  const res = await pool.query(
    `SELECT proxy_key, role, holder_id, acquired_at, renewed_at, expires_at
       FROM proxy_leases
       ORDER BY expires_at ASC`,
  );
  const hostnameKey = normalizeLeaseHost(os.hostname());
  const now = Date.now();
  return res.rows.map((row) => {
    const parsed = parseHolderId(row.holder_id);
    let hostState = "unknown";
    let pidAlive = null;
    if (parsed) {
      const sameHost = normalizeLeaseHost(parsed.hostname) === hostnameKey;
      hostState = sameHost ? "this-host" : "other-host";
      if (sameHost) pidAlive = isPidAlive(parsed.pid);
    }
    const expiresAt = row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at);
    return {
      proxyKey: row.proxy_key,
      proxyKeyMasked: maskKey(row.proxy_key),
      role: row.role,
      holderId: row.holder_id,
      holderMasked: maskHolder(row.holder_id),
      holderHost: parsed?.hostname ?? null,
      holderPid: parsed?.pid ?? null,
      hostState,
      pidAlive,
      acquiredAt: row.acquired_at,
      renewedAt: row.renewed_at,
      expiresAt,
      expired: expiresAt.getTime() <= now,
    };
  });
}

/**
 * Сводный cleanup: убрать expired-global + dead-local. Возвращает счётчики.
 * Безопасно вызывать многократно; чужие живые аренды не трогает.
 *
 * @param {{ role?: string|null, logger?: (m: string) => void }} [opts]
 */
export async function cleanupLeases({ role = null, logger } = {}) {
  const log = logger ?? (() => {});
  const expired = await releaseExpiredGlobalLeases({ logger: log });
  const dead = await releaseDeadLocalLeases({ role, logger: log });
  return { expired, dead };
}

/**
 * Подождать, пока заданные keys можно будет занять (expired или удалены).
 * Возвращает количество секунд до самого позднего TTL, либо 0 если уже свободны.
 *
 * Используется supervisor'ом: если cleanup не помог (все аренды живые), мы
 * вычисляем maxExpiresAt и спим до него + jitter, а не молотим в crash-loop.
 *
 * @param {string[]} keys
 * @returns {Promise<{ all_busy: boolean, max_wait_sec: number, busy: Array<{ key: string, holder: string, role: string, expiresAt: Date }> }>}
 */
export async function inspectKeysBusyness(keys) {
  if (!isPgConfigured() || !keys?.length) {
    return { all_busy: false, max_wait_sec: 0, busy: [] };
  }
  const pool = await getPool();
  const res = await pool.query(
    `SELECT proxy_key, role, holder_id, expires_at
       FROM proxy_leases
      WHERE proxy_key = ANY($1::text[])
        AND expires_at > NOW()`,
    [keys],
  );
  const now = Date.now();
  let maxWait = 0;
  const busy = res.rows.map((r) => {
    const exp = r.expires_at instanceof Date ? r.expires_at : new Date(r.expires_at);
    const waitMs = exp.getTime() - now;
    if (waitMs > maxWait) maxWait = waitMs;
    return {
      key: r.proxy_key,
      holder: r.holder_id,
      role: r.role,
      expiresAt: exp,
    };
  });
  return {
    all_busy: busy.length >= keys.length,
    max_wait_sec: Math.max(0, Math.ceil(maxWait / 1000)),
    busy,
  };
}

export const __test__ = { maskKey, maskHolder, parseHolderId, normalizeLeaseHost };
