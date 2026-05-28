'use strict';

async function rewriteLegalQuery(rawQuery) {
  if (!rawQuery || typeof rawQuery !== 'string' || rawQuery.trim() === '') {
    return { ok: false, query: '', reason: 'empty_query' };
  }

  const enabled = process.env.RAS_QUERY_REWRITE_ENABLED === '1';
  const apiKey = process.env.GEMINI_API_KEY;

  if (!enabled || !apiKey) {
    return { ok: false, query: rawQuery, reason: 'disabled' };
  }

  return { ok: false, query: rawQuery, reason: 'not_implemented' };
}

module.exports = { rewriteLegalQuery };
