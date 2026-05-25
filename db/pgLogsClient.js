/**
 * db/pgLogsClient.js — пул соединений к отдельному Postgres под логи
 * поисковых запросов (контейнер ras_pg_logs на порту 5433, volume на HDD).
 *
 * Спроектирован максимально defensive: если БД недоступна / DSN не задан /
 * INSERT падает — приложение НЕ должно валиться. Логи это observability,
 * не критичный путь. Все ошибки уходят в stderr, наружу не пробрасываются.
 *
 * Конфиг:
 *   RAS_PG_LOGS_DSN=postgresql://ras_logs:ras_logs@127.0.0.1:5433/ras_logs
 *
 * Использование:
 *   import { logSearch, closeLogsPool } from "./db/pgLogsClient.js";
 *   await logSearch({...}); // fire-and-forget-ish, ошибки только в stderr
 */

import "../network/loadEnv.js";

const DSN = process.env.RAS_PG_LOGS_DSN ?? null;
let _pgModule = null;
let _pool     = null;
let _warnedNoDsn = false;
let _warnedConnect = false;

function _hasDsn() {
  return typeof DSN === "string" && DSN.trim().length > 0;
}

export function isLogsPgConfigured() {
  return _hasDsn();
}

async function _loadPg() {
  if (_pgModule) return _pgModule;
  _pgModule = await import("pg");
  return _pgModule;
}

async function getLogsPool() {
  if (_pool) return _pool;
  if (!_hasDsn()) {
    if (!_warnedNoDsn) {
      process.stderr.write("[pgLogsClient] RAS_PG_LOGS_DSN не задан — search logging выключен\n");
      _warnedNoDsn = true;
    }
    return null;
  }
  try {
    const pg = await _loadPg();
    const { Pool } = pg.default ?? pg;
    _pool = new Pool({
      connectionString: DSN,
      max: 4,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
    });
    _pool.on("error", (e) => {
      process.stderr.write(`[pgLogsClient] pool error: ${e?.message ?? e}\n`);
    });
    return _pool;
  } catch (e) {
    if (!_warnedConnect) {
      process.stderr.write(`[pgLogsClient] init failed: ${e?.message ?? e}\n`);
      _warnedConnect = true;
    }
    return null;
  }
}

export async function closeLogsPool() {
  if (!_pool) return;
  const p = _pool;
  _pool = null;
  try { await p.end(); } catch {}
}

/**
 * Записать одну строку в searches. Все ошибки только в stderr,
 * наружу не пробрасываются — поиск НЕ должен ломаться из-за логирования.
 *
 * @param {object} row — поля соответствуют колонкам searches (см. db/logs_schema.sql).
 */
export async function logSearch(row) {
  const pool = await getLogsPool();
  if (!pool) return;
  try {
    const cols = [
      "search_id", "ts",
      "chat_id", "user_id", "username",
      "query", "query_chars", "top_n",
      "use_hyde", "use_summary", "hyde_model_req", "summary_model_req",
      "hyde_used", "hyde_text", "hyde_chars", "hyde_model_actual",
      "hyde_prompt_tokens", "hyde_candidates_tokens", "hyde_thinking_tokens", "hyde_total_tokens",
      "hyde_finish_reason", "hyde_elapsed_ms", "hyde_truncated_from", "hyde_error",
      "retrieval_ms", "hydrate_ms", "rerank_ms", "total_ms",
      "returned_count", "top_act_ids", "results",
      "raw_request", "raw_response",
    ];
    const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
    const values = cols.map((c) => row[c] ?? null);
    const sql = `
      INSERT INTO searches (${cols.join(", ")})
      VALUES (${placeholders})
      ON CONFLICT (search_id) DO NOTHING
    `;
    await pool.query(sql, values);
  } catch (e) {
    process.stderr.write(`[pgLogsClient] logSearch failed (search_id=${row?.search_id}): ${e?.message ?? e}\n`);
  }
}
