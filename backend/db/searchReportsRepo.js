/**
 * db/searchReportsRepo.js — CRUD над таблицей search_reports.
 *
 * Используется Doczilla-фасадом (scripts/doczilla-facade.js): создание
 * "Doczilla docz" → запуск поиска → отдача результата по getById/get.
 *
 * Все методы кидают исключение при сетевой/sql-ошибке — caller (HTTP-handler)
 * сам решает что отдать клиенту (500/404/...).
 *
 * Схема: db/search_reports_schema.sql (мигрируется через npm run db:migrate-reports).
 */

import { getPool } from "./pgClient.js";

/**
 * Создать пустой отчёт. Возвращает {id, template_id, name, status, created_at, updated_at}.
 *
 * @param {{templateId: string, name?: string|null}} params
 */
export async function createReport({ templateId, name = null }) {
  if (!templateId || typeof templateId !== "string") {
    throw new Error("createReport: templateId required");
  }
  const pool = await getPool();
  const sql = `
    INSERT INTO search_reports (template_id, name, status)
    VALUES ($1, $2, 'created')
    RETURNING id, template_id, name, status, created_at, updated_at
  `;
  const { rows } = await pool.query(sql, [templateId, name]);
  return rows[0];
}

/**
 * Прочитать по id. Возвращает row или null.
 */
export async function getReport(id) {
  if (!id || typeof id !== "string") return null;
  const pool = await getPool();
  const sql = `
    SELECT id, template_id, name, status, answers_json, result_json,
           summary_text, error, search_id, created_at, updated_at
    FROM search_reports
    WHERE id = $1
  `;
  let res;
  try {
    res = await pool.query(sql, [id]);
  } catch (e) {
    // Невалидный uuid → "invalid input syntax for type uuid"; обрабатываем
    // как not-found, чтобы caller не возвращал 500 на user input.
    if (/uuid/i.test(e?.message ?? "")) return null;
    throw e;
  }
  return res.rows[0] ?? null;
}

/**
 * Пометить отчёт как 'running' и сохранить заполненные answers.
 */
export async function markRunning(id, answersJson) {
  const pool = await getPool();
  const sql = `
    UPDATE search_reports
       SET status       = 'running',
           answers_json = $2,
           error        = NULL,
           updated_at   = NOW()
     WHERE id = $1
     RETURNING id, template_id, name, status, updated_at
  `;
  const { rows } = await pool.query(sql, [id, answersJson]);
  return rows[0] ?? null;
}

/**
 * Сохранить успешный результат: status='completed', result_json + summary_text + search_id.
 */
export async function markCompleted(id, { resultJson, summaryText = null, searchId = null }) {
  const pool = await getPool();
  const sql = `
    UPDATE search_reports
       SET status       = 'completed',
           result_json  = $2,
           summary_text = $3,
           search_id    = $4,
           error        = NULL,
           updated_at   = NOW()
     WHERE id = $1
     RETURNING id, status, updated_at
  `;
  const { rows } = await pool.query(sql, [id, resultJson, summaryText, searchId]);
  return rows[0] ?? null;
}

/**
 * Сохранить ошибку: status='error', error=<text>.
 */
export async function markError(id, errorText) {
  const pool = await getPool();
  const sql = `
    UPDATE search_reports
       SET status     = 'error',
           error      = $2,
           updated_at = NOW()
     WHERE id = $1
     RETURNING id, status, updated_at
  `;
  const { rows } = await pool.query(sql, [id, String(errorText ?? "unknown error").slice(0, 4000)]);
  return rows[0] ?? null;
}

/**
 * Startup recovery: пометить как 'error' все отчёты, висящие в 'running'
 * дольше maxAgeMinutes (default 60). Используется при старте процесса — если
 * он крашнулся посередине fillDocz, отчёт навсегда остался бы в 'running'.
 * Pipeline синхронный per-request: после рестарта эти запросы точно НЕ
 * продолжатся.
 *
 * Текст ошибки фиксирован — 'recovered_stale_running_report_after_process_restart',
 * чтобы downstream-клиенты могли отличить этот тип ошибки от прикладных.
 *
 * Возвращает количество поднятых строк.
 *
 * Note: при горизонтальном масштабировании (несколько процессов search-api)
 * этот cleanup нужно либо отключить (другой процесс может быть РЕАЛЬНО занят
 * этим doczId), либо переписать через advisory-lock per doczId. Сейчас single
 * process — безопасно.
 */
export async function recoverStaleRunning(maxAgeMinutes = 60) {
  const pool = await getPool();
  const sql = `
    UPDATE search_reports
       SET status     = 'error',
           error      = 'recovered_stale_running_report_after_process_restart',
           updated_at = NOW()
     WHERE status = 'running'
       AND updated_at < NOW() - ($1 || ' minutes')::interval
     RETURNING id
  `;
  const { rows } = await pool.query(sql, [String(maxAgeMinutes)]);
  return rows.length;
}
