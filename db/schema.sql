-- ras_parser: единая таблица `acts` — собранные судебные акты + RAG-пайплайн.
--
-- Применить:
--   docker exec -i ras_pg psql -U ras -d ras < db/schema.sql
--   # либо если psql установлен на хосте:
--   psql "$RAS_PG_DSN" -f db/schema.sql
--
-- DSN формат: postgresql://user:pass@host:5432/dbname
-- В docker-compose БД называется так же, как POSTGRES_DB (по умолчанию `ras`).
--
-- Файл идемпотентен: повторный прогон ничего не ломает (CREATE … IF NOT EXISTS,
-- DROP INDEX IF EXISTS перед CREATE для индексов, у которых менялся предикат).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ─────────────────────────────────────────────────────────────────────────────
-- Главная таблица. Одна строка = один судебный акт (PDF + метаданные + текст).
-- PK по `id` (item.Id из RAS — уникальный UUID документа).
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS acts (
    -- ── идентификаторы и даты (из item /Search) ──
    id                    UUID PRIMARY KEY,             -- item.Id
    case_id               UUID NOT NULL,                 -- item.CaseId
    case_number           TEXT,                          -- item.CaseNumber
    instance_number       TEXT,                          -- item.InstanceNumber
    file_name             TEXT NOT NULL,                 -- item.FileName
    registration_date     DATE,                          -- item.RegistrationDate ('DD.MM.YYYY' → date)
    display_date          TEXT,                          -- item.DisplayDate (редкое поле)

    -- ── классификация документа ──
    type_id               UUID NOT NULL,                 -- item.TypeId (нормализованный uuid)
    type_name             TEXT,                          -- item.Type
    source_type_id        TEXT,                          -- сырой type id (если расходится с нормализованным)
    decision_type_id      UUID,                          -- item.DecisionTypeId
    content_types_string  TEXT,                          -- item.ContentTypesString (CSV GUIDов)
    content_types         JSONB,                         -- item.ContentTypes (массив текстов)

    -- ── инстанция: сырое значение vs резолвнутое ──
    -- raw_instance_level   — item.InstanceLevel. Для umbrella TypeId (23f4baa9-…)
    --                        отражает уровень КАРТОЧКИ ДЕЛА, не сам документ.
    -- true_instance_level  — расчёт по TypeId / firstCts ContentTypesString
    --                        (SPECIFIC_TYPE_ID_TO_INSTANCE_LEVEL + GENRE_TO_INSTANCE_LEVEL
    --                        в parser.js). Источник правды для кросс-CaseId резолюции.
    raw_instance_level    SMALLINT,
    true_instance_level   SMALLINT,
    court                 TEXT,                          -- item.Court (для umbrella — карточка дела)

    -- ── ссылки ──
    pdf_link              TEXT NOT NULL,                 -- https://kad.arbitr.ru/Document/Pdf/...
    card_link             TEXT,                          -- https://kad.arbitr.ru/Card/...

    -- ── прочее из item ──
    signature_info        JSONB,                         -- item.SignatureInfo (null / объект)
    sphinx_id             BIGINT,                        -- item.SphinxId
    document_count        INTEGER,                       -- item.DocumentCount

    -- ── сырой item целиком (forward-compat: всё, что не разобрали колонками) ──
    raw_metadata          JSONB NOT NULL DEFAULT '{}'::jsonb,

    -- ── вердикт «качаем (1) / параша (0)» из parser._resolveCaseVerdicts ──
    --   verdict_keep      — финал по существу спора (qualifies for RAG download)
    --   verdict_note      — комментарий: «засилено апелляцией», «отменено кассацией» и т.п.
    --                       NULL для простого случая (ИСХОД 1.А — только 1-я инст.).
    --   verdict_action    — главное per-act действие (grant/deny/cancel_new/uphold_lower/...).
    --   verdict_outcomes  — массив распознанных кодов исхода (для отладки/downstream).
    verdict_keep          BOOLEAN,
    verdict_note          TEXT,
    verdict_action        TEXT,
    verdict_outcomes      JSONB NOT NULL DEFAULT '[]'::jsonb,

    -- ── состояние RAG-пайплайна (PDF → text → embedding → Qdrant) ──
    pdf_downloaded        BOOLEAN NOT NULL DEFAULT FALSE,
    pdf_path              TEXT,
    pdf_downloaded_at     TIMESTAMPTZ,
    pdf_bytes             INTEGER,                       -- размер скачанного PDF
    pdf_error             TEXT,                          -- последняя ошибка download/extract
    pdf_attempts          INTEGER NOT NULL DEFAULT 0,    -- сколько раз пытались скачать
    act_text              TEXT,
    text_extracted_at     TIMESTAMPTZ,
    vector_indexed        BOOLEAN NOT NULL DEFAULT FALSE,
    vector_indexed_at     TIMESTAMPTZ,
    qdrant_point_id       TEXT,

    -- ── аудит ──
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Индексы.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_acts_case_id          ON acts (case_id);
CREATE INDEX IF NOT EXISTS idx_acts_type_id          ON acts (type_id);
CREATE INDEX IF NOT EXISTS idx_acts_reg_date         ON acts (registration_date);
CREATE INDEX IF NOT EXISTS idx_acts_true_il          ON acts (true_instance_level);
CREATE INDEX IF NOT EXISTS idx_acts_court            ON acts (court);
CREATE INDEX IF NOT EXISTS idx_acts_verdict_keep     ON acts (verdict_keep) WHERE verdict_keep IS TRUE;

-- Очередь PDF-пайплайна. DROP+CREATE: индексы с теми же именами могли быть
-- созданы ранее со старым предикатом — CREATE INDEX IF NOT EXISTS не перепишет.
DROP INDEX IF EXISTS idx_acts_pending_pdf;
DROP INDEX IF EXISTS idx_acts_pending_text;
CREATE INDEX idx_acts_pending_pdf  ON acts (registration_date DESC NULLS LAST, id)
    WHERE pdf_downloaded = FALSE AND verdict_keep IS TRUE;
CREATE INDEX idx_acts_pending_text ON acts (registration_date DESC NULLS LAST, id)
    WHERE pdf_downloaded = TRUE AND act_text IS NULL;
CREATE INDEX IF NOT EXISTS idx_acts_pending_vector   ON acts (id)
    WHERE vector_indexed = FALSE AND act_text IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_acts_metadata_gin     ON acts USING GIN (raw_metadata jsonb_path_ops);

-- ─────────────────────────────────────────────────────────────────────────────
-- Координация прокси между процессами (parser.js ↔ scripts/download-acts.js).
-- Без неё оба процесса могут вцепиться в один MP_PROXY_KEY и крутить changeIp
-- друг на друга → разнос куки/IP, лишний расход cooldown'ов.
--
-- Каждый процесс на старте «лизит» свои proxy_key с TTL и продлевает раз в
-- ~heartbeat сек. Если процесс умер — TTL истекает, ключ становится свободным.
-- ─────────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS proxy_leases (
    proxy_key    TEXT PRIMARY KEY,
    role         TEXT NOT NULL,                  -- 'parser' | 'pdf' (или своё)
    holder_id    TEXT NOT NULL,                  -- уникальный id процесса (host-pid-rand)
    acquired_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    renewed_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at   TIMESTAMPTZ NOT NULL,
    meta         JSONB NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS idx_proxy_leases_holder  ON proxy_leases (holder_id);
CREATE INDEX IF NOT EXISTS idx_proxy_leases_expires ON proxy_leases (expires_at);
