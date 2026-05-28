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
        AND verdict_keep   IS TRUE
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
 * Опциональные:
 *   • `opts.tokensJinaV3` — счёт через jina-reranker-v3 (Qwen3) tokenizer.
 *     Гейтинг по RERANKER_MAX_DOC_LENGTH.
 *   • `opts.tokensJinaV4` — счёт через jina-embeddings-v4 tokenizer.
 *     Используется для is_long_act и роутинга full_act/late_chunks.
 *
 * Оба считаются одним POST /count_tokens в pdf/pipeline.js на этапе extract.
 * Если null/undefined — существующее значение колонки НЕ затирается (COALESCE),
 * чтобы повторный extract при resume не убил уже посчитанные числа.
 *
 * is_long_act: если есть tokensJinaV4 → точная граница 8000 (cap full_act);
 * иначе fallback на char-эвристику length>32000 (≈8k токенов русского текста).
 * После backfill'а для всех актов эвристику можно выпилить.
 *
 * Колонка token_count (legacy) — здесь не трогаем; её перезаписывает индексер
 * после реального /embed (forward-pass count). См. db/schema.sql.
 *
 * @param {string} id
 * @param {string} text
 * @param {{ tokensJinaV3?: number|null, tokensJinaV4?: number|null }} [opts]
 */
export async function markTextExtracted(id, text, opts = {}) {
  const pool = await getPool();
  const s = String(text ?? "");
  const tokensJinaV3 =
    opts.tokensJinaV3 == null || !Number.isFinite(Number(opts.tokensJinaV3))
      ? null
      : Math.max(0, Math.floor(Number(opts.tokensJinaV3)));
  const tokensJinaV4 =
    opts.tokensJinaV4 == null || !Number.isFinite(Number(opts.tokensJinaV4))
      ? null
      : Math.max(0, Math.floor(Number(opts.tokensJinaV4)));
  await pool.query(
    `UPDATE acts
        SET act_text          = $2,
            text_extracted_at = NOW(),
            pdf_error         = NULL,
            tokens_jina_v3    = COALESCE($3::INTEGER, tokens_jina_v3),
            tokens_jina_v4    = COALESCE($4::INTEGER, tokens_jina_v4),
            is_long_act       = CASE
                                  WHEN COALESCE($4::INTEGER, tokens_jina_v4) IS NOT NULL
                                    THEN COALESCE($4::INTEGER, tokens_jina_v4) > 8000
                                  ELSE length($2) > 32000
                                END
      WHERE id = $1::uuid`,
    [id, s, tokensJinaV3, tokensJinaV4],
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

// ───────────────────────────────────────────────────────────────────────────
// Repair-хелперы для short-очереди (см. embed/fullAct.js::embedFullActBatch).
//
// Контекст:
//   selectPendingEmbed(false) — short-селектор — фильтрует
//     `is_long_act=FALSE AND tokens_jina_v4 IS NOT NULL AND tokens_jina_v4 <= $`.
//   Это значит, что pending-строки с `is_long_act=FALSE` НО `tokens_jina_v4`
//   выше gate'а ИЛИ NULL не подбираются ни одним воркером (long-селектор
//   требует `is_long_act=TRUE`). Без репеир-шага они зависают навсегда.
//
// Важно про токенайзеры:
//   tokens_jina_v4 — счёт через tokenizer jina-embeddings-v4 (наш embedder).
//     Используется для роутинга short/long: gate = 8000 ≈ MAX_COLBERT_TOKENS.
//   tokens_jina_v3 — счёт через tokenizer jina-reranker-v3 (Qwen3). НЕ
//     embedding-токенизатор. Используется ТОЛЬКО reranker budget'ом в
//     embed/rerank.js (там 131K context Qwen3). Для роутинга embed-pipeline
//     НЕ применяется — раньше использовалось как прокси, переключено
//     на v4 (мигр. с tokens_jina_v3 → tokens_jina_v4).
// ───────────────────────────────────────────────────────────────────────────

/**
 * Перевести pending short-акты, у которых tokens_jina_v4 превышает gate, в
 * long-очередь. Vector_status остаётся 'pending' — chunk-индексер (или late
 * chunking) разберёт их в свою смену. vector_error содержит сигнал маршрута.
 *
 * @param {number} maxTokens порог embed-токенов для short-очереди (gate 8000)
 * @param {number} [limit=200] максимум строк за один вызов
 * @returns {Promise<{ count: number, rows: Array<{ id: string, tokens_jina_v4: number }> }>}
 */
export async function reroutePendingShortOverTokenGate(maxTokens, limit = 200) {
  const pool = await getPool();
  const cap = Math.max(1, Math.floor(maxTokens));
  const lim = Math.max(1, Math.floor(limit));
  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND is_long_act = FALSE
           AND tokens_jina_v4 IS NOT NULL
           AND tokens_jina_v4 > $1
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
           AND verdict_keep IS TRUE
         ORDER BY registration_date DESC NULLS LAST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
     )
     UPDATE acts a
        SET is_long_act  = TRUE,
            vector_error = 'pending_late_chunking:embed_token_gate'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id, a.tokens_jina_v4`,
    [cap, lim],
  );
  return { count: res.rowCount ?? 0, rows: res.rows };
}

/**
 * Пометить pending short-акты с NULL tokens_jina_v4 как error со внятным
 * vector_error. Без счёта embed-токенов мы не можем доверенно отнести акт ни к
 * short (gate=8000), ни к long. Перепосчёт tokens_jina_v4 — задача отдельного
 * pipeline (pdf/pipeline.js считает на этапе extract; старые строки до фичи
 * остаются с NULL).
 *
 * @param {number} [limit=200]
 * @returns {Promise<{ count: number, rows: Array<{ id: string }> }>}
 */
export async function markMissingRerankerTokensForEmbedding(limit = 200) {
  const pool = await getPool();
  const lim = Math.max(1, Math.floor(limit));
  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND is_long_act = FALSE
           AND tokens_jina_v4 IS NULL
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
           AND verdict_keep IS TRUE
         ORDER BY registration_date DESC NULLS LAST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     UPDATE acts a
        SET vector_status = 'error',
            vector_error  = 'skip:missing_tokens_jina_v4'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id`,
    [lim],
  );
  return { count: res.rowCount ?? 0, rows: res.rows };
}

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
 * @returns {Promise<Array<{ id: string, act_text: string, is_long_act: boolean, token_count: number|null }>>}
 */
export async function selectPendingEmbed(limit, isLongAct = null) {
  const pool = await getPool();
  const shortMaxTokens = Number(process.env.RAS_EMBED_SHORT_MAX_TOKENS ?? 8000);
  const isLongCond =
    isLongAct === null ? ""
    : isLongAct === true  ? "AND is_long_act = TRUE"
    : "AND is_long_act = FALSE AND tokens_jina_v4 IS NOT NULL AND tokens_jina_v4 <= $2";
  const params = isLongAct === false
    ? [Math.max(1, limit | 0), shortMaxTokens]
    : [Math.max(1, limit | 0)];

  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
           AND verdict_keep IS TRUE
           ${isLongCond}
         ORDER BY registration_date DESC NULLS LAST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     UPDATE acts a
        SET vector_status = 'indexing'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id, a.act_text, a.is_long_act, a.token_count,
                a.tokens_jina_v3, a.tokens_jina_v4`,
    params,
  );
  return res.rows;
}

/**
 * Подобрать pending long-акты в заданном диапазоне tokens_jina_v4 и сразу
 * перевести в indexing. Нужен для budgeted overnight-индексера, который
 * хочет фильтровать «не самые тяжёлые» акты (например 8001..15000 токенов)
 * и параллелить их по token-бюджету.
 *
 * Контракт совпадает с selectPendingEmbed: FOR UPDATE SKIP LOCKED атомарно
 * переводит pending → indexing; вызывающий ОБЯЗАН закрыть каждую запись
 * через markEmbedded / markEmbedError (иначе она зависнет в indexing до
 * recoverStaleEmbedding).
 *
 * @param {number} limit
 * @param {number} minTokens   inclusive нижняя граница (например 8001)
 * @param {number} maxTokens   inclusive верхняя граница (например 15000)
 * @returns {Promise<Array<{ id: string, act_text: string, is_long_act: boolean, token_count: number|null, tokens_jina_v3: number|null, tokens_jina_v4: number|null }>>}
 */
export async function selectPendingLongInTokenRange(limit, minTokens, maxTokens) {
  const pool = await getPool();
  const lim = Math.max(1, limit | 0);
  const lo  = Math.max(0, Math.floor(minTokens));
  const hi  = Math.max(lo, Math.floor(maxTokens));
  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND is_long_act   = TRUE
           AND verdict_keep  IS TRUE
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
           AND tokens_jina_v4 IS NOT NULL
           AND tokens_jina_v4 BETWEEN $2 AND $3
         ORDER BY tokens_jina_v4 ASC, registration_date DESC NULLS LAST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     UPDATE acts a
        SET vector_status = 'indexing'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id, a.act_text, a.is_long_act, a.token_count,
                a.tokens_jina_v3, a.tokens_jina_v4`,
    [lim, lo, hi],
  );
  return res.rows;
}

/**
 * Read verdict_keep для одного акта. Используется embed/fullAct и embed/chunk
 * как pre-upsert guard: между selectPendingEmbed (которое снэпшотит pending→indexing
 * + проверяет verdict_keep IS TRUE) и upsertPoints в Qdrant проходит 13-17с GPU-времени;
 * за это окно резолвер parser.js мог флипнуть verdict_keep в FALSE по факту
 * новой апелляции/кассации. Если так — отменяем upsert, акт отдадим cleanup'у.
 *
 * Возвращает TRUE / FALSE / null (если акт не найден).
 *
 * @param {string} id UUID акта
 * @returns {Promise<boolean|null>}
 */
export async function isActVerdictKeep(id) {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT verdict_keep FROM acts WHERE id = $1::uuid`,
    [id],
  );
  if (res.rows.length === 0) return null;
  const v = res.rows[0].verdict_keep;
  return v === true ? true : v === false ? false : null;
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
 * Tokens-ASC variant of selectPendingEmbed для short-очереди: атомарно
 * pending→indexing, но порядок — `tokens_jina_v4 ASC` (самые мелкие акты
 * сначала). Используется новым smart-scheduler'ом, чтобы packing получал
 * однородные акты по длине и padding waste минимизировался.
 *
 * Контракт идентичен selectPendingEmbed(limit, false), за вычетом ORDER BY.
 *
 * @param {number} limit
 * @param {number} maxTokens  верхняя граница short (def 8000)
 */
export async function selectPendingShortByTokensAsc(limit, maxTokens) {
  const pool = await getPool();
  const lim = Math.max(1, limit | 0);
  const cap = Math.max(1, Math.floor(maxTokens));
  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
           AND verdict_keep IS TRUE
           AND is_long_act = FALSE
           AND tokens_jina_v4 IS NOT NULL
           AND tokens_jina_v4 <= $2
         ORDER BY tokens_jina_v4 ASC, registration_date DESC NULLS LAST, id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     UPDATE acts a
        SET vector_status = 'indexing'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id, a.act_text, a.is_long_act, a.token_count,
                a.tokens_jina_v3, a.tokens_jina_v4`,
    [lim, cap],
  );
  return res.rows;
}

/**
 * Подсчитать pending short-акты и их минимальный/максимальный токен-счёт без
 * перевода в indexing. Нужно scheduler'у, чтобы решать «ждём ли мы ещё мелких
 * или batch собран».
 *
 * @param {number} maxTokens
 * @returns {Promise<{ count: number, min_tokens: number|null, max_tokens: number|null, sum_tokens: number }>}
 */
export async function peekPendingShortStats(maxTokens) {
  const pool = await getPool();
  const cap = Math.max(1, Math.floor(maxTokens));
  const res = await pool.query(
    `SELECT count(*)::int AS count,
            MIN(tokens_jina_v4)::int AS min_tokens,
            MAX(tokens_jina_v4)::int AS max_tokens,
            COALESCE(SUM(tokens_jina_v4), 0)::bigint AS sum_tokens
       FROM acts
      WHERE vector_status = 'pending'
        AND act_text IS NOT NULL
        AND act_text NOT LIKE '__EXTRACT_FAILED__%'
        AND verdict_keep IS TRUE
        AND is_long_act = FALSE
        AND tokens_jina_v4 IS NOT NULL
        AND tokens_jina_v4 <= $1`,
    [cap],
  );
  const r = res.rows[0] || {};
  return {
    count:      Number(r.count ?? 0),
    min_tokens: r.min_tokens === null ? null : Number(r.min_tokens),
    max_tokens: r.max_tokens === null ? null : Number(r.max_tokens),
    sum_tokens: Number(r.sum_tokens ?? 0),
  };
}

/**
 * Подсчитать pending long-акты в заданном диапазоне tokens_jina_v4. Нужно
 * scheduler'у для решения «есть ли работа в этом диапазоне».
 *
 * @param {number} minTokens inclusive
 * @param {number} maxTokens inclusive
 * @returns {Promise<number>}
 */
export async function countPendingLongInTokenRange(minTokens, maxTokens) {
  const pool = await getPool();
  const lo = Math.max(0, Math.floor(minTokens));
  const hi = Math.max(lo, Math.floor(maxTokens));
  const res = await pool.query(
    `SELECT count(*)::int AS c FROM acts
      WHERE vector_status = 'pending'
        AND is_long_act   = TRUE
        AND verdict_keep  IS TRUE
        AND act_text IS NOT NULL
        AND act_text NOT LIKE '__EXTRACT_FAILED__%'
        AND tokens_jina_v4 IS NOT NULL
        AND tokens_jina_v4 BETWEEN $1 AND $2`,
    [lo, hi],
  );
  return Number(res.rows[0]?.c ?? 0);
}

/**
 * Маркировать pending-акты с tokens_jina_v4 > maxLateChunking (32768) как
 * skip:gt_32k_context_limit. Без счёта v4 пропускаем (markMissing* отдельно).
 *
 * @param {number} maxLateChunkingTokens обычно 32768
 * @param {number} [limit=500]
 * @returns {Promise<{ count: number, rows: Array<{ id: string, tokens_jina_v4: number }> }>}
 */
export async function markOversizedActsAsSkip(maxLateChunkingTokens, limit = 500) {
  const pool = await getPool();
  const cap = Math.max(1, Math.floor(maxLateChunkingTokens));
  const lim = Math.max(1, Math.floor(limit));
  const res = await pool.query(
    `WITH picked AS (
        SELECT id, tokens_jina_v4 FROM acts
         WHERE vector_status = 'pending'
           AND verdict_keep  IS TRUE
           AND tokens_jina_v4 IS NOT NULL
           AND tokens_jina_v4 > $1
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $2
     )
     UPDATE acts a
        SET vector_status = 'error',
            vector_error  = 'skip:gt_32k_context_limit:tokens=' || picked.tokens_jina_v4::text
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id, picked.tokens_jina_v4`,
    [cap, lim],
  );
  return { count: res.rowCount ?? 0, rows: res.rows };
}

/**
 * Маркировать pending long-акты, у которых tokens_jina_v4 IS NULL (не
 * посчитаны — без счёта мы не можем ни выбрать диапазон, ни решить >32k).
 *
 * @param {number} [limit=200]
 * @returns {Promise<{ count: number, rows: Array<{ id: string }> }>}
 */
export async function markMissingTokensV4Long(limit = 200) {
  const pool = await getPool();
  const lim = Math.max(1, Math.floor(limit));
  const res = await pool.query(
    `WITH picked AS (
        SELECT id FROM acts
         WHERE vector_status = 'pending'
           AND verdict_keep  IS TRUE
           AND is_long_act   = TRUE
           AND tokens_jina_v4 IS NULL
           AND act_text IS NOT NULL
           AND act_text NOT LIKE '__EXTRACT_FAILED__%'
         ORDER BY id
         FOR UPDATE SKIP LOCKED
         LIMIT $1
     )
     UPDATE acts a
        SET vector_status = 'error',
            vector_error  = 'skip:missing_tokens_jina_v4'
       FROM picked
      WHERE a.id = picked.id
      RETURNING a.id::text AS id`,
    [lim],
  );
  return { count: res.rowCount ?? 0, rows: res.rows };
}

/**
 * Pre-mark indexing one act as embed_error без перевода в indexing (нужен
 * worker'у для скорого fail-fast при OOM 2-strike). Используется ТОЛЬКО когда
 * акт уже находится в статусе indexing.
 *
 * @param {string} id
 * @param {string} reason  Должен быть префиксован 'skip:' если это не ошибка.
 */
export async function markActSkip(id, reason) {
  const pool = await getPool();
  await pool.query(
    `UPDATE acts
        SET vector_status = 'error',
            vector_error  = LEFT($2, 2000)
      WHERE id = $1::uuid`,
    [id, String(reason ?? "")],
  );
}

/**
 * Сводный счёт «работы для embed-worker'а» по бакетам: short ≤8000,
 * long 8001-15000, long 15001-22000, long 22001-32768, oversized >32768,
 * null v4. Используется scheduler'ом для выбора фазы.
 *
 * @returns {Promise<{ short:number, long_small:number, long_medium:number, long_large:number, oversized:number, null_v4:number }>}
 */
export async function pendingTokenBuckets() {
  const pool = await getPool();
  const res = await pool.query(
    `SELECT
        count(*) FILTER (WHERE is_long_act = FALSE AND tokens_jina_v4 IS NOT NULL AND tokens_jina_v4 <= 8000)::int AS short_q,
        count(*) FILTER (WHERE is_long_act = TRUE  AND tokens_jina_v4 BETWEEN  8001 AND 15000)::int                AS long_small,
        count(*) FILTER (WHERE is_long_act = TRUE  AND tokens_jina_v4 BETWEEN 15001 AND 22000)::int                AS long_medium,
        count(*) FILTER (WHERE is_long_act = TRUE  AND tokens_jina_v4 BETWEEN 22001 AND 32768)::int                AS long_large,
        count(*) FILTER (WHERE tokens_jina_v4 IS NOT NULL AND tokens_jina_v4 > 32768)::int                          AS oversized,
        count(*) FILTER (WHERE tokens_jina_v4 IS NULL)::int                                                          AS null_v4
       FROM acts
      WHERE vector_status = 'pending'
        AND verdict_keep  IS TRUE
        AND act_text IS NOT NULL
        AND act_text NOT LIKE '__EXTRACT_FAILED__%'`,
  );
  const r = res.rows[0] || {};
  return {
    short:        Number(r.short_q ?? 0),
    long_small:   Number(r.long_small ?? 0),
    long_medium:  Number(r.long_medium ?? 0),
    long_large:   Number(r.long_large ?? 0),
    oversized:    Number(r.oversized ?? 0),
    null_v4:      Number(r.null_v4 ?? 0),
  };
}

/**
 * Postgres advisory lock — single-worker guard. Заводит pg_try_advisory_lock
 * под фиксированным 64-бит int'ом. Если уже занят — возвращает false без
 * блокировки. Снимается через releaseEmbedWorkerLock() или при разрыве
 * connection'а (любое graceful/нет shutdown).
 *
 * Lock id = 0x52415345_4D424557 ("RASE_MBEW" — ras embed worker, 8 bytes).
 *
 * @param {import('pg').PoolClient} client клиент, на котором lock держится
 * @returns {Promise<boolean>}
 */
const EMBED_WORKER_LOCK_ID = "5931145559638030679"; // 0x523732314D426577 -> "Rr21MBew"
export async function tryAcquireEmbedWorkerLock(client) {
  const res = await client.query(
    `SELECT pg_try_advisory_lock($1::bigint) AS ok`,
    [EMBED_WORKER_LOCK_ID],
  );
  return Boolean(res.rows[0]?.ok);
}

export async function releaseEmbedWorkerLock(client) {
  await client.query(
    `SELECT pg_advisory_unlock($1::bigint)`,
    [EMBED_WORKER_LOCK_ID],
  ).catch(() => {});
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
 * Bump vector_version и сброс в pending ТОЛЬКО для длинных актов
 * (is_long_act = TRUE). Нужен при смене chunking-стратегии / добавлении
 * colbert per chunk — short full_act трогать не надо, их вектора не меняются.
 *
 * Также сметает stale-точки в Qdrant побочно: chunk-индексер при
 * indexOne() делает deletePointsByActId(act_id) перед upsert, поэтому
 * старые chunk-точки уходят вместе с переиндексацией.
 *
 * @returns {Promise<{ bumped: number, reset: number }>}
 */
export async function bumpVectorVersionLong() {
  const pool = await getPool();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const reset = await client.query(
      `UPDATE acts
          SET vector_status = 'pending',
              indexed_at    = NULL
        WHERE vector_status = 'indexed'
          AND is_long_act   = TRUE`,
    );
    const bumped = await client.query(
      `UPDATE acts
          SET vector_version = vector_version + 1
        WHERE is_long_act = TRUE`,
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
