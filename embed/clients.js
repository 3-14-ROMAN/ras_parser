/**
 * embed/clients.js — общие HTTP-хелперы и константы для индексеров.
 *
 * Зачем отдельный модуль: full-act и chunk-индексеры + worker зовут одни и
 * те же эндпоинты (/embed, Qdrant /collections/.../points). Хочется одну
 * точку конфигурации (env, таймауты) и одну точку для смены клиента
 * (например, на @qdrant/js-client-rest, если будем gRPC).
 */

import process from "node:process";
import { createHash } from "node:crypto";

import "../network/loadEnv.js";

export const QDRANT_URL =
  process.env.RAS_QDRANT_URL ||
  process.env.QDRANT_URL ||
  "http://127.0.0.1:6333";

export const COLLECTION =
  process.env.RAS_QDRANT_COLLECTION ||
  process.env.QDRANT_COLLECTION ||
  "ras_acts";

export const INFERENCE_URL =
  process.env.RAS_INFERENCE_URL ||
  process.env.INFERENCE_URL ||
  "http://127.0.0.1:8000";

// Точечный fail-safe: если /embed вернул >MAX_COLBERT_TOKENS токенов для
// одного point'а — Qdrant отвергнет multivector (flatten > 1MB).
export const MAX_COLBERT_TOKENS = Number(process.env.MAX_COLBERT_TOKENS ?? 8000);

// Char-based chunking (token-aware вариант — Шаг 3).
export const CHUNK_SIZE    = Number(process.env.RAS_EMBED_CHUNK_SIZE    ?? 3500);

// Сколько чанков отдавать в один POST /embed (ограничено VRAM V100 fp16).
export const EMBED_SUB_BATCH = Number(process.env.RAS_EMBED_SUB_BATCH ?? 4);

// Namespace для deterministic UUIDv5 chunk point id = uuidv5("act_id:chunk_id").
// Меняем — старые chunk-points становятся «бесхозными», подметает scope-delete
// в чанковом индексере.
export const QDRANT_ID_NAMESPACE = "b3f1c0a2-1e9d-4f7a-9b1d-7c3a2e4b8d0a";

// Таймаут на один POST /embed — длинный текст на V100 fp16 кодируется
// заметные секунды; вешать 30s рискованно.
const INFERENCE_TIMEOUT_MS = Number(process.env.RAS_EMBED_INFERENCE_TIMEOUT_MS ?? 180_000);
const QDRANT_TIMEOUT_MS    = Number(process.env.RAS_EMBED_QDRANT_TIMEOUT_MS    ?? 60_000);

async function _fetchJson(method, url, body, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: body === undefined ? undefined : { "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new Error(`${method} ${url} → ${res.status}: ${text.slice(0, 800)}`);
    }
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(t);
  }
}

export function inferencePost(path, body) {
  return _fetchJson("POST", `${INFERENCE_URL}${path}`, body, INFERENCE_TIMEOUT_MS);
}

export function qdrant(method, path, body) {
  return _fetchJson(method, `${QDRANT_URL}${path}`, body, QDRANT_TIMEOUT_MS);
}

/**
 * Зовёт /embed для массива текстов, валидирует структуру ответа.
 *
 * @param {string[]} texts
 * @param {{ task?: "retrieval.passage"|"retrieval.query", returnSparse?: boolean }} [opts]
 * @returns {Promise<{
 *   multivectors: number[][][],
 *   dense_vectors: number[][],
 *   token_counts: number[],
 *   sparse_vectors: { indices: number[], values: number[] }[] | null
 * }>}
 */
export async function embedTexts(texts, opts = {}) {
  const task = opts.task ?? "retrieval.passage";
  const returnSparse = opts.returnSparse ?? true;
  if (!Array.isArray(texts) || texts.length === 0) {
    throw new Error("embedTexts: empty texts");
  }
  const data = await inferencePost("/embed", { texts, task, return_sparse: returnSparse });
  if (
    !Array.isArray(data.multivectors)  || data.multivectors.length  !== texts.length ||
    !Array.isArray(data.dense_vectors) || data.dense_vectors.length !== texts.length
  ) {
    throw new Error(
      `embed bad shape: mv=${data.multivectors?.length} dense=${data.dense_vectors?.length} expected=${texts.length}`,
    );
  }
  const tokenCounts = Array.isArray(data.token_counts)
    ? data.token_counts.map((n) => Number(n) || 0)
    : data.multivectors.map((mv) => mv?.length ?? 0);
  return {
    multivectors:   data.multivectors,
    dense_vectors:  data.dense_vectors,
    token_counts:   tokenCounts,
    sparse_vectors: Array.isArray(data.sparse_vectors) ? data.sparse_vectors : null,
  };
}

/**
 * Late chunking через /embed_late_chunks.
 *
 * Контракт (fix 2026-05-18): на сервер шлём **оригинальный** `fullText` + spans
 * чанков `[{chunk_id, start_char, end_char}]`. Сервер тоkенизирует именно
 * `fullText`, один forward pass,
 * mean-pool токенов в спане каждого чанка → 128-dim dense_late. Sparse
 * считается на slice оригинала `fullText[start:end]`.
 *
 * @param {string} fullText
 *   Полный текст акта (act.act_text целиком).
 * @param {Array<{ chunk_id: number, start_char: number, end_char: number }>} chunkSpans
 *   Уже посчитанные на Node-стороне (chunkText) спаны.
 * @param {{ task?: string, maxLength?: number, returnSparse?: boolean }} [opts]
 * @returns {Promise<{
 *   dense_late_vectors: number[][],
 *   sparse_vectors: { indices: number[], values: number[] }[] | null,
 *   token_counts: number[],
 *   full_tokens: number,
 *   full_chars: number,
 * }>}
 *
 * Бросает Error, если сервер вернул error-поле (too_long_for_late_chunking,
 * bad_chunk_span, token_alignment_mismatch и пр.).
 */
export async function embedLateChunks(fullText, chunkSpans = null, opts = {}) {
  const task              = opts.task              ?? "retrieval.passage";
  const maxLength         = opts.maxLength         ?? 32768;
  const returnSparse      = opts.returnSparse      ?? true;
  const targetChunkTokens = opts.targetChunkTokens ?? 2000;

  if (typeof fullText !== "string" || fullText.length === 0) {
    throw new Error("embedLateChunks: empty fullText");
  }

  const hasExplicitSpans = Array.isArray(chunkSpans) && chunkSpans.length > 0;

  const body = {
    full_text: fullText,
    task,
    max_length: maxLength,
    return_sparse: returnSparse,
    target_chunk_tokens: targetChunkTokens,
  };

  if (hasExplicitSpans) {
    body.chunks = chunkSpans.map((c) => ({
      chunk_id:   c.chunk_id ?? c.id,
      start_char: c.start_char ?? c.start,
      end_char:   c.end_char ?? c.end,
    }));
  }

  const data = await inferencePost("/embed_late_chunks", body);

  if (data.error) {
    throw new Error(`/embed_late_chunks error: ${data.error} (${JSON.stringify(data).slice(0, 500)})`);
  }

  const chunks = Array.isArray(data.chunks)
    ? data.chunks.map((c) => ({
        id:         Number(c.chunk_id),
        chunk_id:   Number(c.chunk_id),
        start:      Number(c.start_char),
        end:        Number(c.end_char),
        start_char: Number(c.start_char),
        end_char:   Number(c.end_char),
      }))
    : (hasExplicitSpans ? body.chunks.map((c) => ({
        id:         Number(c.chunk_id),
        chunk_id:   Number(c.chunk_id),
        start:      Number(c.start_char),
        end:        Number(c.end_char),
        start_char: Number(c.start_char),
        end_char:   Number(c.end_char),
      })) : []);

  if (!Array.isArray(data.dense_late_vectors) || data.dense_late_vectors.length !== chunks.length) {
    throw new Error(
      `late_chunks bad shape: dense_late=${data.dense_late_vectors?.length} chunks=${chunks.length}`,
    );
  }

  const tokenCounts = (data.token_counts ?? []).map((n) => Number(n) || 0);
  if (tokenCounts.length !== chunks.length) {
    throw new Error(`late_chunks bad token_counts: ${tokenCounts.length} chunks=${chunks.length}`);
  }

  return {
    dense_late_vectors: data.dense_late_vectors,
    sparse_vectors:     Array.isArray(data.sparse_vectors) ? data.sparse_vectors : null,
    token_counts:       tokenCounts,
    full_tokens:        Number(data.full_tokens) || 0,
    full_chars:         Number(data.full_chars) || 0,
    chunk_mode:         data.chunk_mode ?? (hasExplicitSpans ? "explicit" : "token_auto"),
    target_chunk_tokens: Number(data.target_chunk_tokens ?? targetChunkTokens),
    chunks,
  };
}

/**
 * Upsert points в Qdrant (`PUT /collections/:c/points?wait=true`). Если
 * Qdrant вернёт 400 (multivector flatten limit и т.п.) — выбросит ошибку.
 */
export async function upsertPoints(points) {
  if (!Array.isArray(points) || points.length === 0) return;
  await qdrant("PUT", `/collections/${COLLECTION}/points?wait=true`, { points });
}

/**
 * Удалить все point'ы данного акта (full_act + любые его chunks).
 * Нужно chunk-индексеру: при пересборке акта новые chunks могут иметь меньше
 * кусков, чем старые → старые stale-points иначе остаются.
 *
 * @param {string} actId UUID акта
 */
export async function deletePointsByActId(actId) {
  await qdrant("POST", `/collections/${COLLECTION}/points/delete?wait=true`, {
    filter: {
      must: [{ key: "act_id", match: { value: actId } }],
    },
  });
}

/**
 * Deterministic UUIDv5 для chunk point id.
 *
 *   uuidv5("<act_id>:<chunk_id>", QDRANT_ID_NAMESPACE)
 *
 * Гарантирует, что повторная индексация того же чанка не создаст дубли.
 */
export function chunkPointId(actId, chunkId) {
  const ns = Buffer.from(QDRANT_ID_NAMESPACE.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(`${actId}:${chunkId}`).digest();
  const b = Buffer.from(hash.subarray(0, 16));
  b[6] = (b[6] & 0x0f) | 0x50; // version 5
  b[8] = (b[8] & 0x3f) | 0x80; // RFC 4122 variant
  const h = b.toString("hex");
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

/**
 * Char-based чанкование. Возвращает массив { id, text, start, end }.
 * id — последовательный chunk_id (0..N-1).
 */
export function chunkText(text, size = CHUNK_SIZE) {
  const stride = size;
  const out = [];
  if (!text) return out;
  let id = 0;
  for (let start = 0; start < text.length; start += stride) {
    const end = Math.min(start + size, text.length);
    out.push({ id, text: text.slice(start, end), start, end });
    id += 1;
    if (end >= text.length) break;
  }
  return out;
}

/**
 * Тащит метаданные акта из PG (нужно для payload в Qdrant).
 *
 * Импорт getPool вынесен сюда, чтобы fullAct и chunk не дублировали запрос.
 */
export async function fetchActMeta(actIds) {
  if (!Array.isArray(actIds) || actIds.length === 0) return new Map();
  const { getPool } = await import("../db/pgClient.js");
  const pool = await getPool();
  const res = await pool.query(
    `SELECT id::text AS id, case_id::text AS case_id, case_number, court,
            registration_date, type_name, true_instance_level,
            verdict_keep, verdict_action, pdf_link
       FROM acts
      WHERE id = ANY($1::uuid[])`,
    [actIds],
  );
  const map = new Map();
  for (const row of res.rows) map.set(row.id, row);
  return map;
}

/**
 * Сериализатор registration_date → "YYYY-MM-DD" | null.
 */
export function isoDate(d) {
  if (!d) return null;
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d);
}
