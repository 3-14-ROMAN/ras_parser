/**
 * embed/hydrate.js — hydration кандидатов из PostgreSQL для reranker'а.
 *
 * Контракт (Шаг 5):
 *   Вход:  topK = RRF merged [{ act_id, score, ranks }, ...] + branches (для chunk_id'ов)
 *   Выход: [{ act_id, text, kind: 'full'|'window', meta, chunks?, payload? }, ...]
 *
 * Логика per-act:
 *
 *   1. Достать act_text + is_long_act из PG одним запросом по всем act_id.
 *
 *   2. Если is_long_act = FALSE (короткий акт):
 *      kind = 'full'
 *      text = act.act_text целиком
 *
 *   3. Если is_long_act = TRUE (длинный акт):
 *      kind = 'window'
 *      • Найти chunk_id'ы, которые попали в long_dense.groups[*].hits[*].payload.chunk_id
 *        и long_sparse.groups[*].hits[*].payload.chunk_id для этого act_id.
 *      • Расширить окно: для каждого matched_chunk_id добавить ±chunkWindow соседей
 *        (например, chunk_window=1 → matched + 1 слева + 1 справа = 3 чанка).
 *      • Перечанковать act.act_text тем же CHUNK_SIZE/CHUNK_OVERLAP, что и индексер
 *        (см. embed/clients.js::chunkText), взять выбранные chunk_id'ы по позиции,
 *        отсортировать по chunk_id ASC, склеить с разделителем.
 *      • Если матчей не нашлось (защита) — берём первые N чанков как fallback.
 *
 *   4. Truncation: если maxChars задан и text длиннее — урезаем «по центру»
 *      для коротких актов (сохраняем начало и конец как наиболее ценные части)
 *      и просто по правому хвосту для window.
 *
 * Why перечанковка вместо «достать chunk-тексты из Qdrant»:
 *   Qdrant хранит только эмбеддинги и payload (act_id, chunk_id, start_char,
 *   end_char). Полный текст чанка не лежит. Перечанковка детерминирована
 *   (CHUNK_SIZE/CHUNK_OVERLAP — env'ы) и даёт точно тот же фрагмент, что
 *   индексер взял для эмбеддинга. Альтернатива — slice по start_char/end_char
 *   из payload, но это лишние данные в Qdrant и не работает, если payload
 *   обрезан.
 */

import { getPool } from "../db/pgClient.js";
import { CHUNK_SIZE, CHUNK_OVERLAP, chunkText } from "./clients.js";

const DEFAULT_CHUNK_WINDOW = Number(process.env.RAS_RERANK_CHUNK_WINDOW ?? 1);
// Максимум символов на документ перед отправкой в /rerank. У Jina v2-base
// нативный max_length=1024 токенов ≈ 4000 символов русского. m0 — больше.
// 0 = без ограничения (модель сама обрежет).
const DEFAULT_MAX_CHARS = Number(process.env.RAS_RERANK_MAX_CHARS ?? 12000);
// Разделитель между чанками в window-режиме. Жирный, чтобы reranker'у было
// очевидно, где границы.
const CHUNK_SEPARATOR = "\n\n— — —\n\n";

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
  return map;
}

/**
 * Расширить окно: для каждого matched chunk_id добавить ±window соседей.
 * Кэп сверху — totalChunks (не выйдем за конец акта).
 *
 * Возвращает отсортированный массив уникальных chunk_id'ов.
 */
function expandWindow(matchedIds, totalChunks, window) {
  const out = new Set();
  for (const cid of matchedIds) {
    const lo = Math.max(0, cid - window);
    const hi = Math.min(totalChunks - 1, cid + window);
    for (let i = lo; i <= hi; i++) out.add(i);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * Урезать текст до maxChars. Для kind='full' оставляем начало и конец (резюме
 * + резолютивная часть обычно по краям акта). Для kind='window' урезаем
 * правый хвост — приоритет первого matched chunk'а.
 */
function truncateText(text, maxChars, kind) {
  if (!maxChars || maxChars <= 0 || !text || text.length <= maxChars) return text;
  if (kind === "full") {
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
            case_id::text           AS case_id,
            case_number             AS case_number,
            court                   AS court,
            registration_date       AS registration_date,
            type_name               AS type_name,
            true_instance_level     AS true_instance_level,
            verdict_keep            AS verdict_keep,
            verdict_action          AS verdict_action,
            pdf_link                AS pdf_link
       FROM acts
      WHERE id = ANY($1::uuid[])`,
    [actIds],
  );
  const map = new Map();
  for (const row of res.rows) {
    map.set(row.id, {
      actText:            row.act_text ?? null,
      isLongAct:          row.is_long_act ?? null,
      caseId:             row.case_id,
      caseNumber:         row.case_number,
      court:              row.court,
      registrationDate:   row.registration_date,
      typeName:           row.type_name,
      trueInstanceLevel:  row.true_instance_level,
      verdictKeep:        row.verdict_keep,
      verdictAction:      row.verdict_action,
      pdfLink:            row.pdf_link,
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
 * @param {{ chunkWindow?: number, maxChars?: number, chunkSize?: number,
 *           chunkOverlap?: number }} [opts]
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
  const chunkOverlap = opts.chunkOverlap ?? CHUNK_OVERLAP;

  if (!Array.isArray(candidates) || candidates.length === 0) return [];

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
        meta:              row ?? {},
      });
      continue;
    }

    const isLong = row.isLongAct === true;
    let text;
    let kind;
    let matchedIds = null;
    let usedIds = null;
    let totalChunks = null;

    if (!isLong) {
      text = row.actText;
      kind = "full";
    } else {
      const allChunks = chunkText(row.actText, chunkSize, chunkOverlap);
      totalChunks = allChunks.length;
      const matchedSet = matchedByAct.get(cand.act_id) ?? new Set();
      matchedIds = [...matchedSet].sort((a, b) => a - b);

      let pickedIds;
      if (matchedIds.length === 0) {
        // Edge case: act попал в RRF через full_colbert/full_sparse ветки
        // (где group_by нет, есть только act-level matches), но у нас он
        // is_long_act=TRUE — значит в Qdrant у него только chunks. Это
        // возможно, если ветка full_* промахнулась мимо acts из chunk-пула
        // (что нормально), а попал он через long_*; матчи там есть всегда.
        // Если оба long_* промазали — fallback на первые 3 чанка.
        pickedIds = allChunks.slice(0, Math.min(3, allChunks.length)).map((c) => c.id);
      } else {
        pickedIds = expandWindow(matchedIds, totalChunks, chunkWindow);
      }
      usedIds = pickedIds;

      const parts = pickedIds.map((cid) => allChunks[cid]?.text).filter(Boolean);
      text = parts.join(CHUNK_SEPARATOR);
      kind = "window";
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
      used_chunk_ids:    usedIds,
      total_chunks:      totalChunks,
      text_chars:        text.length,
      truncated,
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
      },
    });
  }

  return out;
}
