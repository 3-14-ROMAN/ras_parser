/**
 * Smoke для cleanupInvalidActs + race-сценариев.
 *
 * Создаёт synthetic-акт через прямой INSERT в acts, артефакты:
 *   - act_text (PG)
 *   - PDF-файл на диске (tmp)
 *   - Qdrant point с payload.act_id
 *
 * Тестирует:
 *   A. verdict_keep TRUE → FALSE + cleanup → артефакты вычищены, метаданные на месте
 *   B. verdict_keep FALSE → TRUE → selectPendingPdf видит акт
 *   C. selectPendingEmbed НЕ выбирает verdict_keep=FALSE
 *   D. Race: vector_status='indexing' + verdict_keep=FALSE → cleanup пропускает
 *      строку (worker должен сам поймать через isActVerdictKeep guard)
 *
 * Запуск:
 *   node --env-file=.env db/cleanupInvalidActs.smoke.mjs
 *
 * Прибирает за собой: DELETE по test_act_id'у в finally, файл удаляется, Qdrant
 * points сметаются filter'ом. Безопасно гонять много раз.
 */

import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import assert from "node:assert/strict";

import "../network/loadEnv.js";

import { getPool, closePool } from "./pgClient.js";
import { cleanupInvalidActs } from "./cleanupInvalidActs.js";
import {
  selectPendingPdf,
  selectPendingEmbed,
  isActVerdictKeep,
} from "./actsRepo.js";
import { qdrant, deletePointsByActId } from "../embed/clients.js";

// Synthetic UUIDs (валидные v4): хорошо детектируются глазами в БД, не пересекаются с реальными.
const TEST_ACT_ID  = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1";
const TEST_CASE_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2";
const TEST_PDF_PATH = path.join("/tmp", `cleanup-smoke-${TEST_ACT_ID}.pdf`);
const COLLECTION = process.env.RAS_QDRANT_COLLECTION || process.env.QDRANT_COLLECTION || "ras_acts";

function log(msg) {
  process.stdout.write(`[smoke] ${msg}\n`);
}

async function pgCleanup(pool) {
  await pool.query(`DELETE FROM acts WHERE id = $1::uuid`, [TEST_ACT_ID]);
  await fs.unlink(TEST_PDF_PATH).catch(() => {});
  await deletePointsByActId(TEST_ACT_ID).catch(() => {});
}

async function countQdrantPoints(actId) {
  const res = await qdrant("POST", `/collections/${COLLECTION}/points/count`, {
    exact: true,
    filter: { must: [{ key: "act_id", match: { value: actId } }] },
  });
  return res?.result?.count ?? 0;
}

async function insertTestAct(pool, { verdictKeep, vectorStatus = "indexed", withArtifacts = true }) {
  await pgCleanup(pool);

  if (withArtifacts) {
    await fs.writeFile(TEST_PDF_PATH, Buffer.from("test pdf content"));
  }

  await pool.query(
    `INSERT INTO acts (
       id, case_id, pdf_link, raw_metadata,
       case_number, court, type_name, file_name,
       registration_date, true_instance_level,
       verdict_keep, verdict_note, verdict_action, verdict_outcomes,
       act_text, text_extracted_at,
       pdf_downloaded, pdf_path, pdf_bytes, pdf_downloaded_at,
       vector_status, indexed_at,
       is_long_act, token_count
     ) VALUES (
       $1::uuid, $2::uuid, 'http://test/cleanup.pdf', '{"_smoke": true}'::jsonb,
       'A12-345/2024', 'Test Court', 'Решение', 'cleanup-smoke.pdf',
       '2024-01-01'::date, 1,
       $3::boolean, 'smoke-test-note', null, '[]'::jsonb,
       $4::text, NOW(),
       $5::boolean, $6::text, 42, NOW(),
       $7::text, NOW(),
       false, 100
     )`,
    [
      TEST_ACT_ID,
      TEST_CASE_ID,
      verdictKeep,
      withArtifacts ? "synthetic test text from smoke" : null,
      withArtifacts,
      withArtifacts ? TEST_PDF_PATH : null,
      vectorStatus,
    ],
  );

  if (withArtifacts && vectorStatus === "indexed") {
    // Pseudo qdrant point — используем UUID самого акта как id (как для full_act).
    // Дим-ы взяты из коллекции: dense=2048, colbert=128 (multivector), dense_late=128.
    await qdrant("PUT", `/collections/${COLLECTION}/points?wait=true`, {
      points: [
        {
          id: TEST_ACT_ID,
          vector: {
            dense:   new Array(2048).fill(0.01),
            colbert: [new Array(128).fill(0.01)],
          },
          payload: {
            act_id: TEST_ACT_ID,
            unit_type: "full_act",
            _smoke: true,
          },
        },
      ],
    });
  }
}

async function getActState(pool) {
  const res = await pool.query(
    `SELECT id::text AS id, case_id::text AS case_id, case_number, court, type_name,
            verdict_keep, verdict_note, verdict_action,
            raw_metadata, pdf_link, registration_date,
            act_text IS NOT NULL AS has_text,
            length(act_text)        AS text_len,
            pdf_downloaded, pdf_path, pdf_bytes, pdf_downloaded_at,
            text_extracted_at, indexed_at,
            vector_status, vector_error,
            token_count, tokens_jina_v3, is_long_act
       FROM acts WHERE id = $1::uuid`,
    [TEST_ACT_ID],
  );
  return res.rows[0] ?? null;
}

async function main() {
  const pool = await getPool();
  log(`collection=${COLLECTION}`);
  let failed = 0;

  try {
    // ───── A. verdict_keep TRUE → FALSE → cleanup ────────────────────
    log("=== A. verdict_keep TRUE → FALSE → cleanup ===");
    await insertTestAct(pool, { verdictKeep: true, vectorStatus: "indexed", withArtifacts: true });
    let st = await getActState(pool);
    assert.equal(st.has_text, true, "A0: text должен быть");
    assert.equal(st.pdf_downloaded, true, "A0: pdf_downloaded=true");
    assert.equal(st.vector_status, "indexed", "A0: vector_status=indexed");
    const pointsBefore = await countQdrantPoints(TEST_ACT_ID);
    assert.equal(pointsBefore, 1, `A0: ожидаем 1 point в Qdrant, видим ${pointsBefore}`);
    const fileExists = await fs.access(TEST_PDF_PATH).then(() => true).catch(() => false);
    assert.equal(fileExists, true, "A0: PDF файл должен быть на диске");
    log("A0: пред-условие ок (всё на месте)");

    // Флипаем verdict_keep на FALSE — имитируем то что делает резолвер parser.js.
    await pool.query(`UPDATE acts SET verdict_keep = false WHERE id = $1::uuid`, [TEST_ACT_ID]);
    log("A1: verdict_keep флипнут в FALSE");

    const res = await cleanupInvalidActs({ batchSize: 10, log: (m) => log(`  ${m}`) });
    log(`A2: cleanup → scanned=${res.scanned} reset=${res.rows_reset} qdrant=${res.qdrant_deleted} pdf=${res.pdf_deleted}`);
    assert.ok(res.rows_reset >= 1, "A2: rows_reset >= 1");

    st = await getActState(pool);
    assert.equal(st.has_text, false, "A3: act_text должно быть NULL");
    assert.equal(st.pdf_downloaded, false, "A3: pdf_downloaded должно быть FALSE");
    assert.equal(st.pdf_path, null, "A3: pdf_path должно быть NULL");
    assert.equal(st.pdf_bytes, null, "A3: pdf_bytes NULL");
    assert.equal(st.pdf_downloaded_at, null, "A3: pdf_downloaded_at NULL");
    assert.equal(st.text_extracted_at, null, "A3: text_extracted_at NULL");
    assert.equal(st.indexed_at, null, "A3: indexed_at NULL");
    assert.equal(st.vector_status, "pending", "A3: vector_status=pending");
    assert.equal(st.token_count, null, "A3: token_count NULL");
    assert.equal(st.is_long_act, null, "A3: is_long_act NULL");
    log("A3: state-columns сброшены ✓");

    // Метаданные ДОЛЖНЫ быть нетронуты:
    assert.equal(st.case_id, TEST_CASE_ID, "A4: case_id жив");
    assert.equal(st.case_number, "A12-345/2024", "A4: case_number жив");
    assert.equal(st.court, "Test Court", "A4: court жив");
    assert.equal(st.type_name, "Решение", "A4: type_name жив");
    assert.equal(st.verdict_keep, false, "A4: verdict_keep остался FALSE");
    assert.equal(st.verdict_note, "smoke-test-note", "A4: verdict_note жив");
    assert.equal(st.pdf_link, "http://test/cleanup.pdf", "A4: pdf_link жив");
    assert.equal(st.raw_metadata?._smoke, true, "A4: raw_metadata жив");
    log("A4: метаданные нетронуты ✓");

    const pointsAfter = await countQdrantPoints(TEST_ACT_ID);
    assert.equal(pointsAfter, 0, `A5: Qdrant 0 points, видим ${pointsAfter}`);
    const fileAfter = await fs.access(TEST_PDF_PATH).then(() => true).catch(() => false);
    assert.equal(fileAfter, false, "A5: PDF файл удалён с диска");
    log("A5: Qdrant + PDF файл очищены ✓");

    // ───── B. verdict_keep FALSE → TRUE — downloader queue видит акт ─
    log("=== B. verdict_keep FALSE → TRUE — selectPendingPdf видит ===");
    await pool.query(`UPDATE acts SET verdict_keep = true WHERE id = $1::uuid`, [TEST_ACT_ID]);
    // selectPendingPdf сортирует по registration_date DESC и LIMIT'ит — наш
    // тестовый акт (2024-01-01) затеряется среди тысяч реальных. Проверяем,
    // что строка СООТВЕТСТВУЕТ предикату селектора (другие фильтры в actsRepo).
    const visBefore = await pool.query(
      `SELECT id FROM acts
        WHERE id = $1::uuid
          AND pdf_downloaded = FALSE
          AND verdict_keep   IS TRUE
          AND pdf_link       IS NOT NULL`,
      [TEST_ACT_ID],
    );
    assert.equal(visBefore.rows.length, 1, "B: после flip TRUE предикат selectPendingPdf матчит акт");

    // Для надёжности также крутим registration_date в будущее и зовём настоящий селектор:
    await pool.query(
      `UPDATE acts SET registration_date = '2099-12-31'::date WHERE id = $1::uuid`,
      [TEST_ACT_ID],
    );
    const pdfQueue = await selectPendingPdf(50);
    const inQueue = pdfQueue.some((r) => r.id === TEST_ACT_ID);
    assert.equal(inQueue, true, "B: настоящий selectPendingPdf(50) тоже видит акт (после bump date)");
    log(`B: акт виден downloader-очередью ✓ (в окне: ${pdfQueue.length})`);

    // ───── C. selectPendingEmbed НЕ выбирает verdict_keep=FALSE ──────
    log("=== C. selectPendingEmbed игнорирует verdict_keep=FALSE ===");
    await pool.query(
      `UPDATE acts SET verdict_keep = false, act_text = 'fake text for embed test',
                       vector_status = 'pending', is_long_act = false,
                       tokens_jina_v3 = 100
       WHERE id = $1::uuid`,
      [TEST_ACT_ID],
    );
    const shortQueue = await selectPendingEmbed(1000, false);
    const longQueue  = await selectPendingEmbed(1000, true);
    const anyQueue   = await selectPendingEmbed(1000, null);
    // selectPendingEmbed уже атомарно переводит pending→indexing, поэтому после
    // первого вызова state нашей строки изменится. Откатим:
    await pool.query(
      `UPDATE acts SET vector_status = 'pending' WHERE id = $1::uuid AND vector_status = 'indexing'`,
      [TEST_ACT_ID],
    );
    const inShort = shortQueue.some((r) => r.id === TEST_ACT_ID);
    const inLong  = longQueue.some((r) => r.id === TEST_ACT_ID);
    const inAny   = anyQueue.some((r) => r.id === TEST_ACT_ID);
    assert.equal(inShort, false, "C: selectPendingEmbed(short) не отдаёт verdict_keep=FALSE");
    assert.equal(inLong,  false, "C: selectPendingEmbed(long) не отдаёт verdict_keep=FALSE");
    assert.equal(inAny,   false, "C: selectPendingEmbed(any) не отдаёт verdict_keep=FALSE");
    log("C: embed-селекторы фильтруют verdict_keep ✓");

    // ───── D. Race: vector_status='indexing' + verdict_keep=FALSE ───
    log("=== D. Race: indexing + verdict_keep=FALSE ===");
    await pool.query(
      `UPDATE acts SET verdict_keep = false, vector_status = 'indexing',
                       act_text = 'race-text',
                       pdf_downloaded = true, pdf_path = $2::text
       WHERE id = $1::uuid`,
      [TEST_ACT_ID, TEST_PDF_PATH],
    );
    await fs.writeFile(TEST_PDF_PATH, Buffer.from("race pdf"));

    // D1. cleanup в этом проходе должен ПРОПУСТИТЬ строку (vector_status='indexing')
    const resD1 = await cleanupInvalidActs({ batchSize: 10, log: (m) => log(`  ${m}`) });
    log(`D1: cleanup при indexing → scanned=${resD1.scanned} reset=${resD1.rows_reset}`);
    const stD1 = await getActState(pool);
    assert.equal(stD1.vector_status, "indexing", "D1: vector_status остаётся 'indexing'");
    assert.equal(stD1.has_text, true, "D1: act_text не тронут — ждём worker'а");

    // D2. Worker через isActVerdictKeep видит FALSE и должен пометить error
    const keep = await isActVerdictKeep(TEST_ACT_ID);
    assert.equal(keep, false, "D2: isActVerdictKeep вернул false (pre-upsert guard сработает)");
    log("D2: isActVerdictKeep correctly returned FALSE — guard в embed/fullAct/chunk сработает ✓");

    // D3. Имитация worker'а: после guard'а он зовёт markEmbedError(...)
    //     → vector_status='error'. Теперь cleanup ДОЛЖЕН подобрать строку.
    await pool.query(
      `UPDATE acts SET vector_status = 'error', vector_error = 'verdict_keep_flipped:false' WHERE id = $1::uuid`,
      [TEST_ACT_ID],
    );
    const resD3 = await cleanupInvalidActs({ batchSize: 10, log: (m) => log(`  ${m}`) });
    log(`D3: cleanup после worker error → scanned=${resD3.scanned} reset=${resD3.rows_reset}`);
    assert.ok(resD3.rows_reset >= 1, "D3: cleanup подобрал строку после vector_status='error'");
    const stD3 = await getActState(pool);
    assert.equal(stD3.has_text, false, "D3: act_text NULL");
    assert.equal(stD3.vector_status, "pending", "D3: vector_status='pending'");
    log("D3: race-сценарий закрыт ✓");

    log("=== ВСЕ СМОУК-ТЕСТЫ ПРОШЛИ ===");
  } catch (e) {
    failed = 1;
    process.stderr.write(`[FAIL] ${e?.stack ?? e?.message ?? e}\n`);
  } finally {
    await pgCleanup(pool);
    await closePool().catch(() => {});
  }

  process.exitCode = failed;
}

main().catch((e) => {
  process.stderr.write(`[fatal] ${e?.stack ?? e?.message ?? e}\n`);
  process.exitCode = 1;
});
