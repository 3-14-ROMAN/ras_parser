/**
 * pgClient.js — пул соединений к Postgres (lazy-load `pg`).
 *
 * Цель: parser.js должен мочь запуститься без установленного npm-пакета `pg`,
 * если режим — справочник TypeId (MODE_TYPES) и БД не нужна. Поэтому импорт
 * пакета вынесен в `getPool()`, который вызывается по требованию.
 *
 * Конфиг — `RAS_PG_DSN` в .env, формат postgresql://user:pass@host:port/db.
 * Если переменная не задана и кому-то нужен пул — выбрасываем понятную ошибку.
 *
 * Используется через:
 *   import { getPool, closePool } from "./db/pgClient.js";
 *   const pool = await getPool();
 *   await pool.query("SELECT 1");
 *
 * В конце процесса вызвать `await closePool()` — иначе процесс не выйдет.
 */

import "../network/loadEnv.js"; // подхватываем .env

// Принимаем оба имени: RAS_PG_DSN (исторически) и DATABASE_URL (де-факто стандарт
// в docker-compose / node-pg / Heroku-style деплоях). Если заданы оба — RAS_PG_DSN
// в приоритете (явная переменная парсера).
const DSN = process.env.RAS_PG_DSN ?? process.env.DATABASE_URL ?? null;

let _pgModule = null;
let _pool = null;

function _hasDsn() {
  return typeof DSN === "string" && DSN.trim().length > 0;
}

export function isPgConfigured() {
  return _hasDsn();
}

async function _loadPg() {
  if (_pgModule) return _pgModule;
  try {
    _pgModule = await import("pg");
  } catch (e) {
    throw new Error(
      "[pgClient] Не смог загрузить npm-пакет 'pg'. Поставь: `npm install pg`. " +
        `Исходная ошибка: ${e.message}`,
    );
  }
  return _pgModule;
}

/**
 * Лениво возвращает Pool, переиспользуя один экземпляр на процесс.
 * @returns {Promise<import('pg').Pool>}
 */
export async function getPool() {
  if (_pool) return _pool;
  if (!_hasDsn()) {
    throw new Error(
      "[pgClient] DSN не задан. Запиши строку подключения в .env как одно из:\n" +
        "  RAS_PG_DSN=postgresql://ras:ras@localhost:5432/ras_parser\n" +
        "  DATABASE_URL=postgresql://ras:ras@localhost:5432/ras_parser\n" +
        "и убедись что прокатил миграцию `psql \"$DSN\" -f db/schema.sql`.",
    );
  }
  const pg = await _loadPg();
  const Pool = pg.Pool ?? pg.default?.Pool;
  if (!Pool) {
    throw new Error("[pgClient] из 'pg' не достал Pool — проверь версию пакета");
  }
  _pool = new Pool({
    connectionString: DSN,
    max: Number.parseInt(process.env.RAS_PG_POOL_MAX ?? "8", 10) || 8,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });
  // Один pre-flight чтобы упасть на старте при кривом DSN, а не в середине прогона.
  await _pool.query("SELECT 1");
  return _pool;
}

export async function closePool() {
  if (!_pool) return;
  try {
    await _pool.end();
  } finally {
    _pool = null;
  }
}
