/**
 * actsRepo.js — батчевая upsert-запись в таблицу `acts` (Postgres).
 *
 * Используется parser.js как канонический sink вместо JSON-чанков. Контракт:
 * подаются объекты, собранные `_buildDecisionRecord` (см. parser.js).
 *
 * Поведение upsert:
 *   ON CONFLICT (id) DO UPDATE
 *     last_seen_at         = NOW()
 *     raw_metadata         = excluded.raw_metadata          — свежий сырой item
 *     verdict_*            = excluded.verdict_*             — кросс-CaseId резолвер
 *                                                             может поменять keep/note
 *                                                             для уже сохранённой записи,
 *                                                             когда в окно прилетела
 *                                                             апелляция/кассация по тому же делу.
 *     true_instance_level  = excluded.true_instance_level
 *     content_types*       = excluded.…                     — если RAS поменял
 *     type_*               = excluded.…                     — и категория тоже
 *
 *   Поля состояния RAG-pipeline (pdf_downloaded / act_text / vector_status / …)
 *   в upsert НЕ ОБНОВЛЯЮТСЯ: парсер ставит флаги один раз при инсерте, дальше
 *   их меняет downstream (PDF-loader / extractor / embedding-pipeline).
 *
 * Парсинг даты: registration_date приходит как 'DD.MM.YYYY' (строка) или null.
 * SQL делает приведение: `to_date(NULLIF($N::text,''), 'DD.MM.YYYY')`.
 */

import { getPool } from "./pgClient.js";

/**
 * Сохранить пачку записей. Безопасно вызывать на любом размере (внутри —
 * INSERT ... VALUES (...), (...), ... up to ~30k параметров, что для (26 cols * N rows)
 * даёт ~1000 строк за раз — берём ровно BATCH=1000 с запасом).
 *
 * @param {Array<object>} rows объекты из _buildDecisionRecord (parser.js)
 * @returns {Promise<{ inserted: number, updated: number }>}
 */
export async function upsertActs(rows) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return { inserted: 0, updated: 0 };
  }
  const pool = await getPool();

  const BATCH = 1000;
  let inserted = 0;
  let updated = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH);
    const { ins, upd } = await _writeChunk(pool, chunk);
    inserted += ins;
    updated += upd;
  }
  return { inserted, updated };
}

const COLS = [
  "id",
  "case_id",
  "case_number",
  "instance_number",
  "file_name",
  "registration_date",
  "display_date",
  "type_id",
  "type_name",
  "source_type_id",
  "decision_type_id",
  "content_types_string",
  "content_types",
  "raw_instance_level",
  "true_instance_level",
  "court",
  "pdf_link",
  "card_link",
  "signature_info",
  "sphinx_id",
  "document_count",
  "raw_metadata",
  "verdict_keep",
  "verdict_note",
  "verdict_action",
  "verdict_outcomes",
];

// Колонки, которые upsert обновляет на excluded.* при конфликте по id.
// pdf_downloaded / pdf_path / act_text / vector_status / vector_error и т.п.
// сюда НЕ включены — их пишет downstream pipeline, парсеру их трогать не надо.
const UPDATE_COLS = [
  "case_id",
  "case_number",
  "instance_number",
  "file_name",
  "registration_date",
  "display_date",
  "type_id",
  "type_name",
  "source_type_id",
  "decision_type_id",
  "content_types_string",
  "content_types",
  "raw_instance_level",
  "true_instance_level",
  "court",
  "pdf_link",
  "card_link",
  "signature_info",
  "sphinx_id",
  "document_count",
  "raw_metadata",
  "verdict_keep",
  "verdict_note",
  "verdict_action",
  "verdict_outcomes",
];

async function _writeChunk(pool, chunk) {
  const placeholders = [];
  const values = [];
  let p = 1;
  for (const row of chunk) {
    const verdict = row.verdict ?? {};
    const tuple = [
      _asUuid(row.id),                                  // id
      _asUuid(row.caseId),                              // case_id
      _asText(row.caseNumber),                          // case_number
      _asText(row.instanceNumber),                      // instance_number
      _asText(row.fileName),                            // file_name
      _asText(row.registrationDate),                    // registration_date (DD.MM.YYYY string)
      _asText(row.displayDate),                         // display_date
      _asUuid(row.typeId),                              // type_id
      _asText(row.typeName),                            // type_name
      _asText(row.sourceTypeId),                        // source_type_id
      _asUuid(row.decisionTypeId),                      // decision_type_id
      _asText(row.contentTypesString),                  // content_types_string
      _asJsonb(row.contentTypes),                       // content_types
      _asSmallint(row.rawInstanceLevel),                // raw_instance_level
      _asSmallint(row.trueInstanceLevel),               // true_instance_level
      _asText(row.court),                               // court
      _asText(row.pdfLink ?? row.link),                 // pdf_link
      _asText(row.cardLink),                            // card_link
      _asJsonb(row.signatureInfo),                      // signature_info
      _asBigint(row.sphinxId),                          // sphinx_id
      _asInteger(row.documentCount),                    // document_count
      _asJsonb(row.metadata),                           // raw_metadata
      _asBool(verdict.keep),                            // verdict_keep
      _asText(verdict.note),                            // verdict_note
      _asText(verdict.action),                          // verdict_action
      _asJsonb(verdict.outcomes ?? []),                 // verdict_outcomes
    ];
    placeholders.push(
      `(` +
        `$${p++}::uuid, $${p++}::uuid, $${p++}::text, $${p++}::text, $${p++}::text, ` +
        `to_date(NULLIF($${p++}::text, ''), 'DD.MM.YYYY'), $${p++}::text, ` +
        `$${p++}::uuid, $${p++}::text, $${p++}::text, $${p++}::uuid, ` +
        `$${p++}::text, $${p++}::jsonb, ` +
        `$${p++}::smallint, $${p++}::smallint, $${p++}::text, ` +
        `$${p++}::text, $${p++}::text, ` +
        `$${p++}::jsonb, $${p++}::bigint, $${p++}::integer, ` +
        `$${p++}::jsonb, ` +
        `$${p++}::boolean, $${p++}::text, $${p++}::text, $${p++}::jsonb` +
      `)`,
    );
    for (const v of tuple) values.push(v);
  }

  const updateSet = UPDATE_COLS.map((c) => `${c} = EXCLUDED.${c}`).join(", ");

  const sql =
    `INSERT INTO acts (` +
      COLS.join(",") +
    `) VALUES ` +
    placeholders.join(",") +
    ` ON CONFLICT (id) DO UPDATE SET ` +
    updateSet + `, last_seen_at = NOW()` +
    ` RETURNING (xmax = 0) AS inserted`;

  const res = await pool.query(sql, values);
  let ins = 0;
  let upd = 0;
  for (const r of res.rows) {
    if (r.inserted) ins += 1;
    else upd += 1;
  }
  return { ins, upd };
}

function _asUuid(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s.length === 0 ? null : s;
}

function _asText(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  return String(v);
}

function _asSmallint(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function _asInteger(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isInteger(n) ? n : null;
}

function _asBigint(v) {
  if (v === null || v === undefined) return null;
  // pg драйвер принимает строку для bigint — это безопаснее для значений > 2^53.
  if (typeof v === "bigint") return v.toString();
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return Number.isInteger(n) ? String(n) : null;
}

function _asBool(v) {
  if (v === null || v === undefined) return null;
  return Boolean(v);
}

function _asJsonb(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Очередь PDF-pipeline (download → extract). Используется scripts/download-acts.js.
//
// Стейт-машина одной строки `acts` по полям этого модуля:
//
//   pdf_downloaded=FALSE & act_text IS NULL      ← очередь скачивания
//      │  PdfDownloader.downloadOne()
//      ▼
//   pdf_downloaded=TRUE  & act_text IS NULL      ← очередь экстракта (resume-safe)
//      │  pdftotext через extractor.js
//      ▼
//   pdf_downloaded=TRUE  & act_text IS NOT NULL  ← готово к эмбеддингу (Qdrant отдельный сервис)
//
// Фильтр очереди скачивания: verdict_keep=TRUE — это значит «финальный
// мотивированный акт по делу» (см. CLAUDE.md, _resolveCaseVerdicts).
// Качать не-финалы для RAG бессмысленно: они в индекс не пойдут.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Выбрать следующую пачку актов для скачивания.
 *
 * @param {number} limit
 * @returns {Promise<Array<{ id: string, pdf_link: string, case_id: string, file_name: string, pdf_attempts: number }>>}
 */
export async function selectPendingPdf(limit) {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT id::text AS id, pdf_link, case_id::text AS case_id, file_name, pdf_attempts
       FROM acts
      WHERE pdf_downloaded = FALSE
        AND verdict_keep   IS TRUE
        AND pdf_link       IS NOT NULL
        AND (pdf_attempts < $2 OR pdf_attempts IS NULL)
      ORDER BY registration_date DESC NULLS LAST, id
      LIMIT $1`,
    [Math.max(1, limit | 0), MAX_PDF_ATTEMPTS],
  );
  return res.rows;
}

/**
 * Выбрать конкретные акты по их id (минует все фильтры verdict_keep / attempts).
 * Используется для точечного re-download через `download-acts.js --ids ...`,
 * smoke-тестов и ручного бэкфилла legacy-строк без verdict_keep.
 *
 * @param {string[]} ids
 * @returns {Promise<Array<{ id: string, pdf_link: string, case_id: string, file_name: string, pdf_attempts: number }>>}
 */
export async function selectByIds(ids) {
  const list = (ids ?? []).map((s) => String(s ?? "").trim()).filter(Boolean);
  if (list.length === 0) return [];
  const pool = await getPool();
  const res = await pool.query(
    `SELECT id::text AS id, pdf_link, case_id::text AS case_id, file_name, pdf_attempts
       FROM acts
      WHERE id = ANY($1::uuid[])
        AND pdf_link IS NOT NULL`,
    [list],
  );
  return res.rows;
}

/**
 * Выбрать акты, у которых PDF скачан, но текст ещё не извлечён.
 * Нужно для resume после краша между downloader'ом и extractor'ом
 * (или если downloader просто работает быстрее extractor'а).
 *
 * @param {number} limit
 * @returns {Promise<Array<{ id: string, pdf_path: string }>>}
 */
export async function selectPendingText(limit) {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT id::text AS id, pdf_path
       FROM acts
      WHERE pdf_downloaded = TRUE
        AND pdf_path       IS NOT NULL
        AND act_text       IS NULL
      ORDER BY registration_date DESC NULLS LAST, id
      LIMIT $1`,
    [Math.max(1, limit | 0)],
  );
  return res.rows;
}

/**
 * Пометить, что PDF успешно скачан.
 *
 * @param {string} id
 * @param {{ pdfPath: string, pdfBytes: number }} info
 */
export async function markPdfDownloaded(id, { pdfPath, pdfBytes }) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET pdf_downloaded    = TRUE,
            pdf_path          = $2,
            pdf_bytes         = $3,
            pdf_downloaded_at = NOW(),
            pdf_error         = NULL,
            pdf_attempts      = COALESCE(pdf_attempts, 0) + 1
      WHERE id = $1::uuid`,
    [id, pdfPath, pdfBytes | 0],
  );
}

/**
 * Пометить ошибку скачивания. attempts инкрементится, но pdf_downloaded
 * остаётся FALSE — строка снова попадёт в selectPendingPdf при следующем
 * прогоне (до MAX_PDF_ATTEMPTS).
 *
 * @param {string} id
 * @param {string} errorText
 */
export async function markPdfFailed(id, errorText) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET pdf_error    = LEFT($2, 2000),
            pdf_attempts = COALESCE(pdf_attempts, 0) + 1
      WHERE id = $1::uuid`,
    [id, String(errorText ?? "")],
  );
}

/**
 * Записать извлечённый текст.
 *
 * Помимо act_text ставим is_long_act по эвристике length > 32000 — чтобы
 * embedding-pipeline сразу видел в очереди, какой кейс (full_act vs chunk).
 * Реальный token_count перепишет индексер, увидев его в ответе инференса.
 *
 * @param {string} id
 * @param {string} text
 */
export async function markTextExtracted(id, text) {
  const pool = await getPool();
  const s = String(text ?? "");
  await pool.query(
    `UPDATE acts
        SET act_text          = $2,
            text_extracted_at = NOW(),
            pdf_error         = NULL,
            is_long_act       = (length($2) > 32000)
      WHERE id = $1::uuid`,
    [id, s],
  );
}

/**
 * Зафиксировать ошибку pdftotext'а (PDF скачан, но текст не вытащить —
 * например, скан без OCR). В очередь скачивания не вернёт, в очередь
 * экстракта — тоже (act_text IS NULL ∧ pdf_downloaded=TRUE), поэтому
 * специально пишем маркер вида `__EXTRACT_FAILED__\n<error>`, чтобы
 * следующий прогон extractor'а его пропустил, а downstream-OCR-сервис
 * мог отловить.
 *
 * @param {string} id
 * @param {string} errorText
 */
export async function markExtractFailed(id, errorText) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET pdf_error         = LEFT($2, 2000),
            act_text          = '__EXTRACT_FAILED__\n' || LEFT($2, 2000),
            text_extracted_at = NOW()
      WHERE id = $1::uuid`,
    [id, String(errorText ?? "")],
  );
}

// ───────────────────────────────────────────────────────────────────────────
// Очередь embedding-pipeline (act_text → Qdrant). State machine vector_status:
//
//   pending  ─selectPendingEmbed→  indexing  ─markEmbedded─→  indexed
//                                       │
//                                       └──markEmbedError─→  error
//
// Воркер берёт батч `selectPendingEmbed(limit)` (FOR UPDATE SKIP LOCKED), сразу
// выставляет 'indexing' — в БД фактически делается одной транзакцией внутри
// помощника. По итогу embedding'а зовёт markEmbedded / markEmbedError. Если
// процесс умер с 'indexing' — recoverStaleEmbedding() сбросит застрявшие
// строки обратно в 'pending' (TTL 1 час).
//
// Bump vector_version (bumpVectorVersionAll) инвалидирует уже indexed строки:
// поднимаем глобально, всё indexed возвращается в pending. Используется при
// пересборке коллекции Qdrant / смене embedding-модели.
// ───────────────────────────────────────────────────────────────────────────

/**
 * Снять очередную пачку pending-актов и атомарно перевести их в indexing.
 * Возвращает строки, которые worker может начать индексировать.
 *
 * Параметр isLongAct:
 *   null     — берём оба типа (full_act + chunk)
 *   false    — только short (is_long_act = FALSE) для full-act индексера
 *   true     — только long  (is_long_act = TRUE)  для chunk-индексера
 *
 * Используется FOR UPDATE SKIP LOCKED — два параллельных воркера на одни и
 * те же строки не вцепятся.
 *
 * @param {number} limit
 * @param {boolean|null} [isLongAct=null]
 * @returns {Promise<Array<{ id: string, act_text: string, is_long_act: boolean }>>}
 */
export async function selectPendingEmbed(limit, isLongAct = null) {
  const pool = await getPool();
  const isLongCond =
    isLongAct === null ? ""
    : isLongAct === true  ? "AND is_long_act = TRUE"
    : "AND is_long_act = FALSE";
  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
           ${isLongCond}
         ORDER BY registration_date DESC NULLS LAST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     UPDATE acts a
        SET vector_status = 'indexing'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id, a.act_text, a.is_long_act`,
    [Math.max(1, limit | 0)],
  );
  return res.rows;
}

/**
 * Пометить акт как успешно проиндексированный в Qdrant.
 * Опционально записать реальный token_count, увиденный в ответе инференса.
 *
 * @param {string} id
 * @param {{ tokenCount?: number, isLongAct?: boolean }} [info]
 */
export async function markEmbedded(id, info = {}) {
  const pool = await getPool();
  const tokenCount = Number.isInteger(info.tokenCount) ? info.tokenCount : null;
  const isLongAct  = typeof info.isLongAct === "boolean" ? info.isLongAct : null;
  await pool.query(
    `UPDATE acts
        SET vector_status = 'indexed',
            indexed_at    = NOW(),
            vector_error  = NULL,
            token_count   = COALESCE($2, token_count),
            is_long_act   = COALESCE($3, is_long_act)
      WHERE id = $1::uuid`,
    [id, tokenCount, isLongAct],
  );
}

/**
 * Пометить ошибку индексирования. Запись остаётся в error до bump'а
 * vector_version, либо пока её вручную не сбросят в pending.
 *
 * @param {string} id
 * @param {string} errorText
 */
export async function markEmbedError(id, errorText) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET vector_status = 'error',
            vector_error  = LEFT($2, 2000)
      WHERE id = $1::uuid`,
    [id, String(errorText ?? "")],
  );
}

/**
 * Сбросить ВСЕ строки в статусе indexing обратно в pending. Используется на
 * старте воркера как «hammer reset», поскольку отдельной метки времени старта
 * индексирования сейчас нет (single-worker pipeline). Когда заведём
 * параллелизм в Шаге 2 — добавим indexing_started_at и сделаем TTL-recovery.
 *
 * @returns {Promise<number>} число восстановленных строк
 */
export async function recoverStaleEmbedding() {
  const pool = await getPool();
  const res = await pool.query(
    `UPDATE acts
        SET vector_status = 'pending'
      WHERE vector_status = 'indexing'`,
  );
  return res.rowCount ?? 0;
}

/**
 * Bump vector_version глобально и сбросить indexed-строки в pending. Нужен
 * при пересборке коллекции Qdrant или смене embedding-модели.
 *
 * Делается двумя UPDATE'ами в одной транзакции, потому что в PG обновить одну
 * и ту же строку из двух data-modifying CTE — undefined behaviour.
 *
 * @returns {Promise<{ bumped: number, reset: number }>}
 */
export async function bumpVectorVersionAll() {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reset = await client.query(
      `UPDATE acts
          SET vector_status = 'pending',
              indexed_at    = NULL
        WHERE vector_status = 'indexed'`,
    );
    const bumped = await client.query(
      `UPDATE acts
          SET vector_version = vector_version + 1`,
    );
    await client.query("COMMIT");
    return {
      bumped: bumped.rowCount ?? 0,
      reset:  reset.rowCount  ?? 0,
    };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

/**
 * Границы дат и количество актов в таблице. Используется интерактивным
 * setup'ом parser.js, чтобы предложить «продолжить с прошлого прогона»
 * (добрать свежие до сегодня, либо идти ещё дальше в прошлое).
 *
 * Даты возвращаются как 'YYYY-MM-DD' (то, что pg отдаёт для date::text).
 *
 * @returns {Promise<{ minDate: string|null, maxDate: string|null, total: number }>}
 */
export async function getActsDateBounds() {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT MIN(registration_date)::text AS min_date,
            MAX(registration_date)::text AS max_date,
            COUNT(*)::bigint              AS total
       FROM acts
      WHERE registration_date IS NOT NULL`,
  );
  const r = res.rows[0] || {};
  return {
    minDate: r.min_date || null,
    maxDate: r.max_date || null,
    total: Number(r.total ?? 0),
  };
}

/**
 * Сводка прогресса pipeline (для CLI-логов).
 *
 * @returns {Promise<{ total_keep: number, pdf_done: number, text_done: number,
 *                     pending_pdf: number, pending_text: number,
 *                     embed_pending: number, embed_indexing: number,
 *                     embed_indexed: number, embed_error: number }>}
 */
export async function pipelineStats() {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT
        COUNT(*) FILTER (WHERE verdict_keep IS TRUE)                                                  AS total_keep,
        COUNT(*) FILTER (WHERE verdict_keep IS TRUE AND pdf_downloaded = TRUE)                        AS pdf_done,
        COUNT(*) FILTER (WHERE verdict_keep IS TRUE AND act_text IS NOT NULL
                              AND act_text NOT LIKE '__EXTRACT_FAILED__%')                            AS text_done,
        COUNT(*) FILTER (WHERE verdict_keep IS TRUE AND pdf_downloaded = FALSE
                              AND pdf_attempts < $1)                                                  AS pending_pdf,
        COUNT(*) FILTER (WHERE pdf_downloaded = TRUE AND act_text IS NULL)                            AS pending_text,
        COUNT(*) FILTER (WHERE vector_status = 'pending'  AND act_text IS NOT NULL)                   AS embed_pending,
        COUNT(*) FILTER (WHERE vector_status = 'indexing')                                            AS embed_indexing,
        COUNT(*) FILTER (WHERE vector_status = 'indexed')                                             AS embed_indexed,
        COUNT(*) FILTER (WHERE vector_status = 'error')                                               AS embed_error
       FROM acts`,
    [MAX_PDF_ATTEMPTS],
  );
  const r = res.rows[0] || {};
  return {
    total_keep:    Number(r.total_keep    ?? 0),
    pdf_done:      Number(r.pdf_done      ?? 0),
    text_done:     Number(r.text_done     ?? 0),
    pending_pdf:   Number(r.pending_pdf   ?? 0),
    pending_text:  Number(r.pending_text  ?? 0),
    embed_pending:  Number(r.embed_pending  ?? 0),
    embed_indexing: Number(r.embed_indexing ?? 0),
    embed_indexed:  Number(r.embed_indexed  ?? 0),
    embed_error:    Number(r.embed_error    ?? 0),
  };
}

const MAX_PDF_ATTEMPTS = Number(process.env.RAS_PDF_MAX_ATTEMPTS ?? 5);
