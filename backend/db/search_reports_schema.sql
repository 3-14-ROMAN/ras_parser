-- db/search_reports_schema.sql — таблица search_reports для Doczilla-совместимого
-- API facade'а (см. scripts/doczilla-facade.js). Идемпотентна.
--
-- Применить:
--   docker exec -i ras_pg psql -U ras -d ras < db/search_reports_schema.sql
--   # либо если psql установлен на хосте:
--   psql "$RAS_PG_DSN" -f db/search_reports_schema.sql
--   # либо:
--   npm run db:migrate-reports
--
-- Сущность: один search_report = один "Doczilla docz" = один поисковый отчёт.
-- Создаётся пустым через createDocz, заполняется через fillDocz (тогда же
-- запускается основной search pipeline и сохраняется его результат).
--
-- Хранится в основной БД (ras_pg, та же где acts), а не в ras_pg_logs:
-- это бизнес-сущность со state-машиной, а не append-only лог.

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS search_reports (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    template_id   TEXT NOT NULL,                 -- 'ras_supply_search' для MVP
    name          TEXT,                          -- человекочитаемое название

    -- created → running → completed | error
    status        TEXT NOT NULL DEFAULT 'created'
        CHECK (status IN ('created', 'running', 'completed', 'error')),

    -- что прислал клиент через fillDocz.answers
    answers_json  JSONB,
    -- что вернул pipeline (responseBody из runSearchPipeline)
    result_json   JSONB,
    -- shortcut для удобства getById (дубликат result_json.summary.text)
    summary_text  TEXT,
    -- если status='error' — сюда падает причина
    error         TEXT,

    -- search_id из ras_pg_logs.searches (когда поиск состоялся) — null если
    -- отчёт ещё не запускался или pipeline упал до выдачи searchId
    search_id     TEXT,

    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_search_reports_status      ON search_reports (status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_reports_template_id ON search_reports (template_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_search_reports_search_id   ON search_reports (search_id) WHERE search_id IS NOT NULL;
