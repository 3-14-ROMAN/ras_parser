import crypto from "node:crypto";

import { getPool } from "./pgClient.js";

export async function setRuntimeFlag(key, { value = "1", ttlSeconds = 120 } = {}) {
  const pool = await getPool();
  await pool.query(
    `INSERT INTO runtime_flags (key, value, expires_at, updated_at)
     VALUES ($1, $2, NOW() + ($3::int * INTERVAL '1 second'), NOW())
     ON CONFLICT (key)
     DO UPDATE SET
       value = EXCLUDED.value,
       expires_at = EXCLUDED.expires_at,
       updated_at = NOW()`,
    [String(key), String(value), Math.max(1, ttlSeconds | 0)],
  );
}

export async function clearRuntimeFlag(key) {
  const pool = await getPool();
  await pool.query(
    `DELETE FROM runtime_flags WHERE key = $1`,
    [String(key)],
  );
}

// Flag считается active, если есть либо точный ключ, либо любой ключ-«лиз»
// с тем же префиксом (`<key>:<uuid>`). Это позволяет нескольким одновременным
// держателям (например, параллельные поисковые запросы) сосуществовать —
// каждый создаёт свой `<prefix>:<uuid>` через acquireRuntimeLease, релиз одного
// не сносит другой.
export async function isRuntimeFlagActive(key) {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT EXISTS (
       SELECT 1
       FROM runtime_flags
       WHERE (key = $1 OR starts_with(key, $1 || ':'))
         AND (expires_at IS NULL OR expires_at > NOW())
     ) AS active`,
    [String(key)],
  );
  return Boolean(res.rows[0]?.active);
}

export async function cleanupExpiredRuntimeFlags() {
  const pool = await getPool();
  const res = await pool.query(
    `DELETE FROM runtime_flags
      WHERE expires_at IS NOT NULL
        AND expires_at <= NOW()`,
  );
  return res.rowCount ?? 0;
}

// Берём «лиз» под префиксом: создаём уникальный ключ `<prefix>:<uuid>`, чтобы
// несколько одновременных холдеров не топтали друг друга. isRuntimeFlagActive
// видит флаг активным, пока жив хотя бы один лиз. Возвращаем полный ключ —
// его надо передать в releaseRuntimeLease, чтобы снести именно свою запись.
export async function acquireRuntimeLease(prefix, { ttlSeconds = 180, value = "1" } = {}) {
  const leaseKey = `${String(prefix)}:${crypto.randomUUID()}`;
  await setRuntimeFlag(leaseKey, { value, ttlSeconds });
  return leaseKey;
}

export async function releaseRuntimeLease(leaseKey) {
  await clearRuntimeFlag(leaseKey);
}
