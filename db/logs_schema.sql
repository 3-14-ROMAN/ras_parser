-- db/logs_schema.sql — схема отдельной БД ras_logs для логов поисковых
-- запросов. Идемпотентна: повторный прогон через `npm run db:migrate-logs`
-- ничего не ломает.
--
-- Зачем: основной Postgres (ras_pg, acts) — критичный, на NVMe. Логи юзер-
-- запросов растут линейно и нужны для аналитики качества (какие запросы,
-- какие модели лучше, где провалы по релевантности). Их держим отдельно
-- на HDD, чтобы не раздувать боевую БД и не плодить роли/гранты в ней.

-- ── searches: одна строка на /search вызов ────────────────────────────────
CREATE TABLE IF NOT EXISTS searches (
  search_id          TEXT PRIMARY KEY,          -- 12 hex, генерируется search-api
  ts                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Кто (заполняет бот, опционально; если /search дёргают напрямую — NULL)
  chat_id            BIGINT,
  user_id            BIGINT,
  username           TEXT,

  -- Запрос как пришёл от юзера
  query              TEXT NOT NULL,
  query_chars        INTEGER NOT NULL,
  top_n              INTEGER NOT NULL,

  -- Настройки поиска (то, что прислал клиент)
  use_hyde           BOOLEAN NOT NULL,
  use_summary        BOOLEAN NOT NULL DEFAULT FALSE,
  hyde_model_req     TEXT,                      -- gemini-3.5-flash etc.
  summary_model_req  TEXT,

  -- HyDE результат
  hyde_used          BOOLEAN NOT NULL DEFAULT FALSE,
  hyde_text          TEXT,                      -- сам синтетический акт
  hyde_chars         INTEGER,
  hyde_model_actual  TEXT,                      -- modelVersion из API
  hyde_prompt_tokens     INTEGER,
  hyde_candidates_tokens INTEGER,
  hyde_thinking_tokens   INTEGER,               -- total - prompt - candidates
  hyde_total_tokens      INTEGER,
  hyde_finish_reason TEXT,
  hyde_elapsed_ms    INTEGER,
  hyde_truncated_from INTEGER,                  -- если safety-truncate сработал
  hyde_error         TEXT,

  -- Тайминги pipeline'а
  retrieval_ms       INTEGER,
  hydrate_ms         INTEGER,
  rerank_ms          INTEGER,
  total_ms           INTEGER NOT NULL,

  -- Результат
  returned_count     INTEGER NOT NULL,
  top_act_ids        TEXT[],                    -- упорядоченный список UUID актов
  results            JSONB,                     -- compact-results как в /search ответе
                                                -- (act_id, case_number, court, scores, ...)

  -- Сырой ответ /search и сырые входные настройки (на случай если схема расширится)
  raw_request        JSONB,
  raw_response       JSONB
);

CREATE INDEX IF NOT EXISTS searches_ts_idx       ON searches (ts DESC);
CREATE INDEX IF NOT EXISTS searches_chat_id_idx  ON searches (chat_id, ts DESC) WHERE chat_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS searches_user_id_idx  ON searches (user_id, ts DESC) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS searches_use_hyde_idx ON searches (use_hyde, ts DESC);
CREATE INDEX IF NOT EXISTS searches_hyde_model_idx ON searches (hyde_model_actual) WHERE hyde_used;

-- top_act_ids — GIN для запросов «какие searches вернули act X»
CREATE INDEX IF NOT EXISTS searches_top_act_ids_gin ON searches USING GIN (top_act_ids);
