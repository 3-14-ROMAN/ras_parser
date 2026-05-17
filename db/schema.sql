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

    -- ── embedding state machine (см. ниже DO-block для миграции legacy) ──
    -- token_count       — реальный счёт токенов из инференса (Jina v4 tokenizer).
    --                     NULL до первого индексирования; заполняется индексером.
    -- is_long_act       — TRUE если token_count > 8192 (или, до подсчёта,
    --                     эвристика по length(act_text) > 32000). Routing:
    --                     FALSE → unit_type=full_act (один point на акт)
    --                     TRUE  → unit_type=chunk    (много point'ов с late chunking)
    -- vector_status     — 'pending' (в очереди) | 'indexing' (worker взял в обработку)
    --                     'indexed' (точки в Qdrant) | 'error' (см. vector_error).
    -- vector_error      — текст последней ошибки (включая skip-reasons типа
    --                     'too_many_colbert_tokens'). Запись с 'error' можно
    --                     перезапустить, подняв vector_version.
    -- vector_version    — bump для invalidation (пересборка коллекции, смена модели,
    --                     смена схемы). Индексер сравнивает свою версию с этой
    --                     и переиндексирует, если меньше.
    -- indexed_at        — момент успешного indexed-перехода.
    token_count           INTEGER,
    is_long_act           BOOLEAN,
    vector_status         TEXT NOT NULL DEFAULT 'pending'
        CHECK (vector_status IN ('pending', 'indexing', 'indexed', 'error')),
    vector_error          TEXT,
    vector_version        SMALLINT NOT NULL DEFAULT 0,
    indexed_at            TIMESTAMPTZ,

    -- ── аудит ──
    first_seen_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_seen_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─────────────────────────────────────────────────────────────────────────────
-- Для существующей БД CREATE TABLE IF NOT EXISTS — no-op, поэтому новые поля
-- надо добавить отдельным ALTER TABLE … ADD COLUMN IF NOT EXISTS. На свежей
-- БД эти ALTER тоже no-op (колонки уже созданы выше в CREATE TABLE).
-- ─────────────────────────────────────────────────────────────────────────────
ALTER TABLE acts ADD COLUMN IF NOT EXISTS token_count    INTEGER;
ALTER TABLE acts ADD COLUMN IF NOT EXISTS is_long_act    BOOLEAN;
ALTER TABLE acts ADD COLUMN IF NOT EXISTS vector_status  TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE acts ADD COLUMN IF NOT EXISTS vector_error   TEXT;
ALTER TABLE acts ADD COLUMN IF NOT EXISTS vector_version SMALLINT NOT NULL DEFAULT 0;
ALTER TABLE acts ADD COLUMN IF NOT EXISTS indexed_at     TIMESTAMPTZ;

-- CHECK на vector_status: добавляем отдельно, чтобы не дублировать при
-- повторном прогоне (ADD COLUMN IF NOT EXISTS не добавит CHECK к уже
-- существующей колонке).
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'acts_vector_status_check'
    ) THEN
        ALTER TABLE acts
            ADD CONSTRAINT acts_vector_status_check
            CHECK (vector_status IN ('pending', 'indexing', 'indexed', 'error'));
    END IF;
END
$$;

-- ─────────────────────────────────────────────────────────────────────────────
-- Миграция legacy embedding-полей (vector_indexed / vector_indexed_at /
-- qdrant_point_id) на новую state-machine. Идемпотентно: при втором прогоне
-- legacy-колонок уже нет, блок ничего не делает.
--
-- Маппинг:
--   vector_indexed = TRUE              → vector_status = 'indexed',
--                                         indexed_at = vector_indexed_at
--   qdrant_point_id LIKE 'skip:%'      → vector_status = 'error',
--                                         vector_error = qdrant_point_id
--   иначе                              → vector_status = 'pending' (default)
--
-- is_long_act backfill по эвристике length(act_text) > 32000 (≈ 8k токенов
-- русского текста). После подсчёта реального token_count индексер
-- перезапишет.
-- ─────────────────────────────────────────────────────────────────────────────
DO $$
BEGIN
    IF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'acts' AND column_name = 'vector_indexed'
    ) THEN
        -- 1. Перенос состояния из legacy-полей в новые.
        UPDATE acts
        SET vector_status = CASE
                WHEN vector_indexed                  THEN 'indexed'
                WHEN qdrant_point_id LIKE 'skip:%'   THEN 'error'
                ELSE 'pending'
            END,
            vector_error = CASE
                WHEN qdrant_point_id LIKE 'skip:%' THEN qdrant_point_id
                ELSE NULL
            END,
            indexed_at = CASE
                WHEN vector_indexed THEN vector_indexed_at
                ELSE NULL
            END;

        -- 2. Сносим legacy-колонки и старый индекс.
        DROP INDEX IF EXISTS idx_acts_pending_vector;
        ALTER TABLE acts DROP COLUMN vector_indexed;
        ALTER TABLE acts DROP COLUMN vector_indexed_at;
        ALTER TABLE acts DROP COLUMN qdrant_point_id;
    END IF;

    -- is_long_act backfill: ставим только там, где есть текст и поле ещё пусто.
    UPDATE acts
    SET is_long_act = (length(act_text) > 32000)
    WHERE act_text IS NOT NULL AND is_long_act IS NULL;
END
$$;

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

-- Очередь embedding-пайплайна: pending-акты с готовым текстом, по убыванию
-- даты решения. Индексер берёт сверху, выставляет vector_status='indexing'
-- (FOR UPDATE SKIP LOCKED — в будущем для параллельных воркеров).
CREATE INDEX IF NOT EXISTS idx_acts_pending_vector ON acts (registration_date DESC NULLS LAST, id)
    WHERE vector_status = 'pending' AND act_text IS NOT NULL;
-- Селектор по статусу (для пагинации и наблюдения за состоянием очереди).
CREATE INDEX IF NOT EXISTS idx_acts_vector_status   ON acts (vector_status);

CREATE INDEX IF NOT EXISTS idx_acts_metadata_gin    ON acts USING GIN (raw_metadata jsonb_path_ops);

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
