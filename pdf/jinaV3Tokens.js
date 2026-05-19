/**
 * pdf/jinaV3Tokens.js — подсчёт токенов через tokenizer `jina-reranker-v3`.
 *
 * Зачем: в момент markTextExtracted (download:acts) хотим сразу знать,
 * сколько токенов стоит акт для реранкера, чтобы понимать укладывается ли
 * он в RERANKER_MAX_DOC_LENGTH без обрезки. Без этой цифры приходится
 * либо считать на лету в каждом /rerank, либо делать отдельный backfill.
 *
 * Как: POST /count_tokens к inference (см. inference/app.py). Тот использует
 * тот же `rerank_model._tokenizer`, что и реальный /rerank — гарантия
 * 1-в-1 совпадения с фактическим режущим лимитом.
 *
 * Поведение при недоступности inference:
 *   - HTTP fail / connection refused / timeout → возвращаем null.
 *   - pipeline продолжает работу, в БД tokens_jina_v3 остаётся NULL.
 *   - WARN в лог дросселим (≤1/мин), чтобы не засорять heartbeat.
 *   - Когда inference поднимется — следующие акты посчитаются нормально,
 *     старые NULL'ы добивает отдельный backfill (см. ниже countAndStore).
 */

import { inferencePost } from "../embed/clients.js";

const WARN_INTERVAL_MS = 60_000;
let _lastWarnAt = 0;

function _warnThrottled(msg) {
  const now = Date.now();
  if (now - _lastWarnAt < WARN_INTERVAL_MS) return;
  _lastWarnAt = now;
  console.error(`[jina-v3-tokens] ${msg} — token_count → NULL до восстановления`);
}

/**
 * Посчитать токены акта через reranker-v3 tokenizer.
 * Возвращает целое ≥0 или null, если inference недоступен/упал.
 *
 * @param {string|null|undefined} text
 * @returns {Promise<number|null>}
 */
export async function countJinaV3Tokens(text) {
  const s = String(text ?? "");
  if (!s) return 0;
  try {
    const r = await inferencePost("/count_tokens", { text: s });
    const n = Number(r?.token_count);
    if (!Number.isFinite(n) || n < 0) {
      _warnThrottled(`unexpected response shape: ${JSON.stringify(r).slice(0, 200)}`);
      return null;
    }
    return Math.floor(n);
  } catch (e) {
    _warnThrottled(`POST /count_tokens failed: ${e && e.message ? e.message : e}`);
    return null;
  }
}
