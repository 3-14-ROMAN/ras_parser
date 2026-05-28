/**
 * embed/hydrate.js — hydration кандидатов из PostgreSQL для reranker'а.
 *
 * ИНВАРИАНТ (с момента перехода на full_act-only):
 *   Каждый документ, отправляемый в /rerank, использует ОРИГИНАЛЬНЫЙ
 *   acts.act_text из Postgres. Без исключений:
 *     - full_act-кандидаты (multivector unit=full_act)
 *     - chunk / late-chunk-кандидаты (unit=chunk, long_dense/long_sparse)
 *     - смешанные через RRF
 *   Retrieval по-прежнему может искать через chunk-вектора в Qdrant —
 *   но реранкер всегда видит полный акт. Так мы избегаем артефактов:
 *   режущиеся «окна» с потерянным контекстом, реконструкция чанков из
 *   неполного payload, разная семантика scoring у full vs window.
 *
 *   Token-budget (см. embed/rerank.js) считает суммарный счёт токенов по
 *   tokens_jina_v3 (из БД) и пропускает в реранкер ровно столько актов,
 *   сколько влезает в context window реранкера (jina-reranker-v3, 131K).
 *
 * Контракт:
 *   Вход:  topK = RRF merged [{ act_id, score, ranks }, ...] + branches
 *   Выход: [{ act_id, text: acts.act_text, kind: 'full_act'|'empty',
 *            tokens_jina_v3, matched_chunk_ids?, total_chunks?, ... }]
 *
 * Chunk-метаданные (matched_chunk_ids, total_chunks, used_chunk_ids=null)
 * сохраняются исключительно для debug-вывода — узнать, по каким именно
 * чанкам retrieval поднял акт.
 */

import { getPool } from "../db/pgClient.js";
import { CHUNK_SIZE, chunkText } from "./clients.js";

const DEFAULT_CHUNK_WINDOW = Number(process.env.RAS_RERANK_CHUNK_WINDOW ?? 1);
/**
 * RAS_RERANK_TEXT_MODE — какой текст уходит в /rerank.
 *   "postgres_full_act" (дефолт): acts.act_text из Postgres, всегда полный
 *     акт, независимо от того full_act это или chunk-кандидат. Production.
 *   (других режимов пока нет — поле существует ради явного лога и быстрого
 *    регресс-теста, если в будущем понадобится window-режим обратно.)
 */
const TEXT_MODE =
  process.env.RAS_RERANK_TEXT_MODE && process.env.RAS_RERANK_TEXT_MODE.trim() !== ""
    ? process.env.RAS_RERANK_TEXT_MODE.trim()
    : "postgres_full_act";
export { TEXT_MODE as HYDRATE_TEXT_MODE };
// Максимум символов на документ перед отправкой в /rerank.
//
// Историческая логика: у Jina v2-base нативный max_length=1024 токенов ≈ 4000
// символов русского; m0 — больше; дефолт 12000 — компромисс. truncateText()
// уже умеет 0/negative как «не резать».
//
// Авто-связка с RAS_RERANK_MAX_DOC_LENGTH:
//   - Если пользователь снял token-cap (RAS_RERANK_MAX_DOC_LENGTH<=0, режим
//     full_docs_no_per_doc_cap в embed/rerank.js), значит он явно хочет
//     полные акты в реранкере. Параллельный char-truncate в hydrate тогда
//     просто молча режет ради смысла — снимаем и его. Иначе budget-логика
//     отрабатывает, но реранкер всё равно видит хвосты по 12K символов.
//   - Если RAS_RERANK_MAX_CHARS задан явно — уважаем (приоритет выше).
const DEFAULT_MAX_CHARS = (() => {
  const explicit = process.env.RAS_RERANK_MAX_CHARS;
  if (explicit !== undefined && explicit !== "") {
    return Number(explicit);
  }
  const mdl = Number(process.env.RAS_RERANK_MAX_DOC_LENGTH);
  if (Number.isFinite(mdl) && mdl <= 0) return 0; // авто-снять при no-cap
  return 12000;
})();
// (CHUNK_SEPARATOR удалён вместе с window-режимом — реранкер видит полный
//  act_text, склеивать чанки больше не нужно.)

/**
 * Собрать map { actId → Set(chunkId) } из long_dense / long_sparse групп.
 *
 * Каждая group в Qdrant query/groups имеет:
 *   group.id    — значение group_by, у нас payload.act_id
 *   group.hits  — массив point'ов с payload (включая chunk_id)
 */
function collectMatchedChunkIds(branches) {
  const map = new Map();
  const addFromGroups = (groups) => {
    for (const g of groups ?? []) {
      const actId = g?.id;
      if (!actId) continue;
      const hits = g.hits ?? [];
      const set = map.get(actId) ?? new Set();
      for (const h of hits) {
        const cid = h?.payload?.chunk_id;
        if (cid !== null && cid !== undefined && Number.isFinite(Number(cid))) {
          set.add(Number(cid));
        }
      }
      if (set.size > 0) map.set(actId, set);
    }
  };
  addFromGroups(branches?.long_dense?.groups);
  addFromGroups(branches?.long_sparse?.groups);
  addFromGroups(branches?.long_colbert?.groups);
  return map;
}

// expandWindow() удалён вместе с window-режимом — больше не используется.

/**
 * Урезать текст до maxChars. Для kind='full_act' оставляем начало и конец
 * (резюме + резолютивная часть обычно по краям акта). Для всего остального
 * (например, эвентуальный window-режим в будущем) — правый хвост.
 *
 * Этот char-cap — независимый от token-budget'а лимит. На проде обычно
 * выключен (RAS_RERANK_MAX_DOC_LENGTH=0 → RAS_RERANK_MAX_CHARS=0 авто).
 */
function truncateText(text, maxChars, kind) {
  if (!maxChars || maxChars <= 0 || !text || text.length <= maxChars) return text;
  if (kind === "full_act" || kind === "full") {
    const half = Math.floor((maxChars - 32) / 2);
    if (half <= 0) return text.slice(0, maxChars);
    return `${text.slice(0, half)}\n\n[…пропуск середины…]\n\n${text.slice(text.length - half)}`;
  }
  return text.slice(0, maxChars);
}

/**
 * Один SQL по всем act_id: текст + флаг длины.
 *
 * @param {string[]} actIds
 * @returns {Promise<Map<string, { actText: string|null, isLongAct: boolean|null,
 *                                   caseNumber, court, registrationDate, typeName,
 *                                   trueInstanceLevel, verdictKeep, verdictAction,
 *                                   pdfLink }>>}
 */
async function fetchActsForHydration(actIds) {
  if (!actIds.length) return new Map();
  const pool = await getPool();
  const res = await pool.query(
    `SELECT id::text                AS id,
            act_text                AS act_text,
            is_long_act             AS is_long_act,
            tokens_jina_v3          AS tokens_jina_v3,
            tokens_jina_v4          AS tokens_jina_v4,
            case_id::text           AS case_id,
            case_number             AS case_number,
            court                   AS court,
            registration_date       AS registration_date,
            type_name               AS type_name,
            true_instance_level     AS true_instance_level,
            verdict_keep            AS verdict_keep,
            verdict_action          AS verdict_action,
            pdf_link                AS pdf_link,
            type_id::text           AS type_id,
            content_types_string    AS content_types_string
       FROM acts
      WHERE id = ANY($1::uuid[])`,
    [actIds],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.id, {
      actText:            row.act_text ?? null,
      isLongAct:          row.is_long_act ?? null,
      // tokens_jina_v3 — счёт через tokenizer jina-reranker-v3 (Qwen3), считается
      // на этапе скачивания (см. pdf/pipeline.js). Кэшируется в БД, чтобы при
      // запросе не дёргать /count_tokens на каждый акт. Может быть null, если
      // акт скачан до фичи или inference был недоступен — rerank.js обработает.
      tokensJinaV3:       row.tokens_jina_v3 ?? null,
      tokensJinaV4:       row.tokens_jina_v4 ?? null,
      caseId:             row.case_id,
      caseNumber:         row.case_number,
      court:              row.court,
      registrationDate:   row.registration_date,
      typeName:           row.type_name,
      trueInstanceLevel:  row.true_instance_level,
      verdictKeep:        row.verdict_keep,
      verdictAction:      row.verdict_action,
      pdfLink:            row.pdf_link,
      typeId:             row.type_id ?? null,
      contentTypesString: row.content_types_string ?? null,
    });
  }
  return map;
}

/**
 * Hydration top-K кандидатов под reranker.
 *
 * @param {Array<{ act_id: string, score: number, ranks: Record<string,number> }>} candidates
 *   Отсортированный merged RRF top-K (обычно 50).
 * @param {{ long_dense: { groups: any[] }, long_sparse: { groups: any[] } }} branches
 *   Результат searchAll — нужен для chunk_id'ов длинных актов.
 * @param {{ chunkWindow?: number, maxChars?: number chunkSize?: number,
 *}} [opts]
 * @returns {Promise<Array<{
 *   act_id: string,
 *   text: string,
 *   kind: 'full'|'window'|'empty',
 *   rrf_score: number,
 *   rrf_ranks: Record<string, number>,
 *   matched_chunk_ids: number[] | null,
 *   used_chunk_ids:    number[] | null,
 *   total_chunks:      number    | null,
 *   text_chars:        number,
 *   truncated:         boolean,
 *   meta: object
 * }>>}
 */
export async function hydrateForRerank(candidates, branches, opts = {}) {
  const chunkWindow  = opts.chunkWindow  ?? DEFAULT_CHUNK_WINDOW;
  const maxChars     = opts.maxChars     ?? DEFAULT_MAX_CHARS;
  const chunkSize    = opts.chunkSize    ?? CHUNK_SIZE;

  if (!Array.isArray(candidates) || candidates.length === 0) return [];

  // Лог конфига — чтобы было видно, обрезается ли тут текст и до скольки,
  // в каком режиме идём (full_act vs ...). Особенно важно при включённом
  // no-cap в реранкере (RAS_RERANK_MAX_DOC_LENGTH<=0).
  // eslint-disable-next-line no-console
  console.log(
    `[hydrate] candidates=${candidates.length} ` +
      `text_mode=${TEXT_MODE} ` +
      `max_chars=${maxChars > 0 ? maxChars : "off"} ` +
      `chunk_window=${chunkWindow}(debug-only) ` +
      `chunk_size=${chunkSize}`,
  );

  const actIds = candidates.map((c) => c.act_id);
  const [rows, matchedByAct] = await Promise.all([
    fetchActsForHydration(actIds),
    Promise.resolve(collectMatchedChunkIds(branches)),
  ]);

  const out = [];
  for (const cand of candidates) {
    const row = rows.get(cand.act_id);
    if (!row || !row.actText) {
      // PG row есть, но act_text NULL/пустой — пропускаем (попадает редко,
      // обычно если acts.act_text не extractnut'ed yet, но vector_status уже
      // indexed — этого быть не должно). Возвращаем плэйсхолдер, чтобы reranker
      // не сдвинул индексы.
      // act_text NULL/пустой — реранкер не может это скоррить. Помечаем
      // как empty, попадёт в хвост финального ranking без rerank_score.
      // (Должно быть редко: vector_status=indexed без act_text — баг
      // в pipeline. Не падаем, просто пропускаем.)
      out.push({
        act_id:            cand.act_id,
        text:              "",
        kind:              "empty",
        rrf_score:         cand.score,
        rrf_ranks:         cand.ranks ?? {},
        matched_chunk_ids: null,
        used_chunk_ids:    null,
        total_chunks:      null,
        text_chars:        0,
        truncated:         false,
        tokens_jina_v3:    row?.tokensJinaV3 ?? null,
        meta:              row ?? {},
      });
      continue;
    }

    // === Инвариант: text = acts.act_text целиком, всегда. ===
    // Реранкер видит полный акт независимо от того, какой unit его поднял
    // (full_act point или один из chunk points). Это спасает от потери
    // контекста при window-реконструкции и упрощает budget-логику: счёт
    // токенов = acts.tokens_jina_v3, без отдельных формул на window.
    let text = row.actText;
    const kind = "full_act";
    // Chunk-метаданные — только debug. Не используются для построения текста.
    let matchedIds = null;
    let totalChunks = null;
    if (row.isLongAct === true) {
      // Дёрнем chunkText только чтобы знать total_chunks для debug-вывода.
      // (Дёшево: O(act_text/CHUNK_SIZE) на короткий top-K — приемлемо.)
      const allChunks = chunkText(row.actText, chunkSize);
      totalChunks = allChunks.length;
      const matchedSet = matchedByAct.get(cand.act_id);
      if (matchedSet && matchedSet.size > 0) {
        matchedIds = [...matchedSet].sort((a, b) => a - b);
      }
    }

    const before = text.length;
    text = truncateText(text, maxChars, kind);
    const truncated = text.length < before;

    out.push({
      act_id:            cand.act_id,
      text,
      kind,
      rrf_score:         cand.score,
      rrf_ranks:         cand.ranks ?? {},
      matched_chunk_ids: matchedIds,
      // used_chunk_ids всегда null — мы не используем chunks как window,
      // полный act_text уходит в реранкер целиком.
      used_chunk_ids:    null,
      total_chunks:      totalChunks,
      text_chars:        text.length,
      truncated,
      // tokens_jina_v3 — счёт через jina-reranker-v3 tokenizer от полного
      // акта (см. pdf/pipeline.js). После перехода на full_act-only это
      // ровно тот счёт, который budget-логика и должна сравнивать с budget'ом.
      // Если NULL (старые акты до фичи) — rerank.js fall-back'нется на
      // /count_tokens, потом на estimateTokens.
      tokens_jina_v3:    row.tokensJinaV3 ?? null,
      tokens_jina_v4:    row.tokensJinaV4 ?? null,
      meta: {
        case_id:             row.caseId,
        case_number:         row.caseNumber,
        court:               row.court,
        registration_date:   row.registrationDate,
        type_name:           row.typeName,
        true_instance_level: row.trueInstanceLevel,
        verdict_keep:        row.verdictKeep,
        verdict_action:      row.verdictAction,
        pdf_link:            row.pdfLink,
        is_long_act:         row.isLongAct,
        tokens_jina_v4:      row.tokensJinaV4 ?? null,
        type_id:             row.typeId ?? null,
        content_types_string: row.contentTypesString ?? null,
      },
    });
  }

  return out;
}
