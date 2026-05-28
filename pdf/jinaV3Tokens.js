/**
 * pdf/jinaV3Tokens.js — подсчёт токенов через inference-сервис.
 *
 * Зачем: в момент markTextExtracted (download:acts) хотим сразу знать,
 * сколько токенов стоит акт для:
 *   • реранкера (Jina v3 / Qwen3)  — гейтинг по RERANKER_MAX_DOC_LENGTH.
 *   • эмбеддера  (Jina v4)          — is_long_act и роутинг
 *                                     full_act (≤8192) / late_chunks (>8192).
 *
 * Без этих цифр пришлось бы либо считать на лету в каждом /rerank и /embed,
 * либо запускать отдельный backfill.
 *
 * Как: один POST /count_tokens к inference (см. inference/app.py). Сервер
 * считает оба токенайзера за один RTT и возвращает
 *   { tokens_jina_v3, tokens_jina_v4, errors[], … }.
 *
 * Поведение при недоступности inference:
 *   - HTTP fail / connection refused / timeout → возвращаем { jinaV3: null, jinaV4: null }.
 *   - pipeline продолжает работу, в БД tokens_jina_v3 / token_count остаются NULL.
 *   - WARN в лог дросселим (≤1/мин), чтобы не засорять heartbeat.
 *   - Когда inference поднимется — следующие акты посчитаются нормально,
 *     старые NULL'ы добивает отдельный backfill.
 *
 * Per-tokenizer partial failure: сервер возвращает 200 с `errors:[…]`,
 * напр. reranker_unavailable но v4 посчитан — в этом случае одно число
 * приходит, другое = null. Логируем дросселированно, но не падаем.
 */

import { inferencePost } from "../embed/clients.js";

const WARN_INTERVAL_MS = 60_000;
let _lastWarnAt = 0;
let _lastPartialWarnAt = 0;

function _warnThrottled(msg) {
  const now = Date.now();
  if (now - _lastWarnAt < WARN_INTERVAL_MS) return;
  _lastWarnAt = now;
  console.error(`[count-tokens] ${msg} — tokens → NULL до восстановления`);
}

function _warnPartial(msg) {
  const now = Date.now();
  if (now - _lastPartialWarnAt < WARN_INTERVAL_MS) return;
  _lastPartialWarnAt = now;
  console.error(`[count-tokens] partial: ${msg}`);
}

function _coerce(n) {
  const v = Number(n);
  return Number.isFinite(v) && v >= 0 ? Math.floor(v) : null;
}

/**
 * Посчитать токены акта обоими токенайзерами (Jina v3 reranker + Jina v4 embed).
 *
 * @param {string|null|undefined} text
 * @returns {Promise<{ jinaV3: number|null, jinaV4: number|null }>}
 */
export async function countActTokens(text) {
  const s = String(text ?? "");
  if (!s) return { jinaV3: 0, jinaV4: 0 };
  try {
    const r = await inferencePost("/count_tokens", { text: s });
    // Новая схема ответа: { tokens_jina_v3, tokens_jina_v4, errors }.
    // На случай старого inference, который ещё не задеплоен: fallback
    // на legacy-поле token_count (это был v3).
    const v3 = _coerce(r?.tokens_jina_v3 ?? r?.token_count);
    const v4 = _coerce(r?.tokens_jina_v4);
    if (Array.isArray(r?.errors) && r.errors.length > 0) {
      _warnPartial(r.errors.join("; "));
    }
    return { jinaV3: v3, jinaV4: v4 };
  } catch (e) {
    _warnThrottled(`POST /count_tokens failed: ${e && e.message ? e.message : e}`);
    return { jinaV3: null, jinaV4: null };
  }
}

/**
 * Backward-compat обёртка: возвращает только число токенов реранкера.
 * Используется в embed/rerank.js как fallback когда в БД tokens_jina_v3 = NULL.
 *
 * @param {string|null|undefined} text
 * @returns {Promise<number|null>}
 */
export async function countJinaV3Tokens(text) {
  const { jinaV3 } = await countActTokens(text);
  return jinaV3;
}
