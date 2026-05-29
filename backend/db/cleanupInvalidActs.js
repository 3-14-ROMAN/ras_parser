/**
 * cleanupInvalidActs.js — гарантирует консистентность RAG-артефактов с verdict_keep.
 *
 * Контракт: акт, у которого `verdict_keep IS FALSE`, НЕ должен иметь скачанного
 * PDF / извлечённого `act_text` / point'ов в Qdrant. Метаданные (id, case_id,
 * raw_metadata, verdict_*, content_types и пр.) сохраняются — это позволяет
 * резолверу позже снова сделать акт финальным, и pipeline просто заново скачает
 * PDF, извлечёт текст и проиндексирует его (idx_acts_pending_pdf поймает по
 * `verdict_keep IS TRUE AND pdf_downloaded = FALSE`).
 *
 * Когда вызывать:
 *   1) parser.js после _saveDecisionLinks — если резолвер только что флипнул
 *      какие-то акты в keep=false, мы их подбираем синхронно.
 *   2) Standalone-скрипт `backend/tools/cleanup-invalid-acts.js` — для one-shot
 *      sweep'а (например, после введения этого механизма для legacy-сирот).
 *
 * Идемпотентность: повторный вызов на «уже чистой» БД ничего не делает (запрос
 * сразу возвращает 0 строк). Безопасно вызывать параллельно с PDF/embed
 * worker'ом — если worker как раз сидит в `vector_status='indexing'` для
 * флипнутого акта, в этом проходе пропустим его, следующий проход добьёт
 * (когда worker завершит markEmbedded / markEmbedError).
 */

import fs from "node:fs/promises";

import { getPool } from "./pgClient.js";
import { deletePointsByActId } from "../embed/clients.js";

const DEFAULT_BATCH = 200;

function defaultLog(msg) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  process.stdout.write(`[${ts}] ${msg}\n`);
}

/**
 * Найти акты с `verdict_keep IS FALSE`, у которых остались RAG-артефакты, и
 * вычистить артефакты. Метаданные не трогает.
 *
 * @param {object} [opts]
 * @param {number} [opts.batchSize=200]  максимум актов за один проход
 * @param {(msg:string)=>void} [opts.log]
 * @returns {Promise<{
 *   scanned: number,
 *   qdrant_deleted: number,
 *   pdf_deleted: number,
 *   rows_reset: number,
 *   errors: number,
 * }>}
 */
export async function cleanupInvalidActs(opts = {}) {
  const batchSize = Math.max(1, Math.floor(opts.batchSize ?? DEFAULT_BATCH));
  const log = opts.log ?? defaultLog;
  const pool = await getPool();

  let scanned = 0;
  let qdrantDeleted = 0;
  let pdfDeleted = 0;
  let rowsReset = 0;
  let errors = 0;

  // Цикл «батч → ещё батч» на случай если за один заход больше batchSize.
  // Защита от бесконечного цикла: если за пачку ничего не сбросилось (все
  // ошибки), выходим.
  while (true) {
    // vector_status='indexing' исключаем: worker сейчас держит row, пусть
    // доведёт до indexed/error, следующий проход подберёт.
    const sel = await pool.query(
      `SELECT id::text AS id,
              pdf_path,
              (act_text IS NOT NULL)        AS has_text,
              pdf_downloaded                AS pdf_done,
              vector_status                 AS vec_status
         FROM acts
        WHERE verdict_keep IS FALSE
          AND vector_status <> 'indexing'
          AND (
            act_text       IS NOT NULL
            OR pdf_downloaded = TRUE
            OR pdf_path    IS NOT NULL
            OR vector_status IN ('indexed', 'error')
          )
        ORDER BY id
        LIMIT $1`,
      [batchSize],
    );

    if (sel.rows.length === 0) break;
    scanned += sel.rows.length;

    let resetInBatch = 0;

    for (const r of sel.rows) {
      try {
        // 1) Qdrant — удаляем все points с этим act_id (full_act + chunks).
        //    Делаем ПЕРВЫМ: если упадёт, не трогаем PG, чтобы не осиротить
        //    points в Qdrant с висящим act_text=NULL в БД.
        if (r.vec_status === "indexed" || r.vec_status === "error") {
          try {
            await deletePointsByActId(r.id);
            qdrantDeleted += 1;
          } catch (e) {
            log(`[cleanup] qdrant delete failed act=${r.id}: ${e.message ?? e}`);
            errors += 1;
            continue;
          }
        } else {
          // vector_status='pending' — points в Qdrant быть не должно, но на
          // всякий случай дёрнем delete (он идемпотентен, без эффекта).
          try {
            await deletePointsByActId(r.id);
          } catch (e) {
            // Не критично: pending → в Qdrant нет ничего; залогируем и продолжим.
            log(`[cleanup] qdrant delete (pending) act=${r.id}: ${e.message ?? e}`);
          }
        }

        // 2) PDF-файл с диска (если был).
        if (r.pdf_path) {
          try {
            await fs.unlink(r.pdf_path);
            pdfDeleted += 1;
          } catch (e) {
            if (e?.code !== "ENOENT") {
              log(`[cleanup] pdf unlink failed act=${r.id} path=${r.pdf_path}: ${e.message ?? e}`);
              errors += 1;
              // Не выходим: PG state-сброс важнее остаточного файла.
            }
          }
        }

        // 3) Сбрасываем все RAG-state колонки. Метаданные не трогаем.
        await pool.query(
          `UPDATE acts
              SET act_text          = NULL,
                  text_extracted_at = NULL,
                  pdf_downloaded    = FALSE,
                  pdf_downloaded_at = NULL,
                  pdf_path          = NULL,
                  pdf_bytes         = NULL,
                  pdf_error         = NULL,
                  pdf_attempts      = 0,
                  token_count       = NULL,
                  is_long_act       = NULL,
                  tokens_jina_v3    = NULL,
                  vector_status     = 'pending',
                  vector_error      = NULL,
                  indexed_at        = NULL
            WHERE id = $1::uuid`,
          [r.id],
        );
        rowsReset += 1;
        resetInBatch += 1;
      } catch (e) {
        log(`[cleanup] act=${r.id} unexpected: ${e?.stack ?? e?.message ?? e}`);
        errors += 1;
      }
    }

    // Если за весь батч ни одного reset'а — выходим (иначе зацикливаемся
    // на тех же строках, что упали).
    if (resetInBatch === 0) break;
    // Если batch неполный — это был последний.
    if (sel.rows.length < batchSize) break;
  }

  if (scanned > 0) {
    log(
      `[cleanup] scanned=${scanned} reset=${rowsReset} ` +
      `qdrant_deleted=${qdrantDeleted} pdf_deleted=${pdfDeleted} errors=${errors}`,
    );
  }
  return {
    scanned,
    qdrant_deleted: qdrantDeleted,
    pdf_deleted: pdfDeleted,
    rows_reset: rowsReset,
    errors,
  };
}
