# RAS Supply Search — семантический поиск по арбитражным актам

> ## 🤖 Живой бот: **https://t.me/ArbitrSupply_bot**
>
> **Открой и потыкай руками прямо сейчас.** Напиши запрос на обычном языке —
> например `взыскание неустойки за просрочку поставки товара` — и бот вернёт
> релевантные **мотивированные акты арбитражных судов** с краткой выжимкой по
> каждому. Можно надиктовать запрос голосом (распознаём через Whisper).

---

## Что это

Конвейер полного цикла, который превращает публичную выдачу
[ras.arbitr.ru](https://ras.arbitr.ru/) (Банк решений арбитражных судов РФ) в
**семантический поиск по судебной практике**:

1. **Сбор** — парсер обходит ras.arbitr.ru через мобильный прокси с ротацией
   IP/оператора/гео, отбирает *итоговые мотивированные акты* по спорам из
   договоров поставки (категория 3.1) и складывает метаданные в Postgres.
2. **PDF** — отдельный пул воркеров скачивает PDF актов с kad.arbitr.ru
   (обходя pravocaptcha и salto-challenge) и извлекает чистый текст.
3. **Индексация** — текст актов чанкуется, эмбеддится моделью **Jina v4** и
   складывается в **Qdrant**.
4. **Поиск** — запрос пользователя расширяется гипотетическим актом (**HyDE**,
   Gemini), идёт dense-retrieval в Qdrant, результаты **переранжируются**
   (Jina reranker v3), топ актов уходит в LLM на краткую выжимку.
5. **Выдача** — всё это отдаётся через **Telegram-бота** и **HTTP Search API**.

## Архитектура

```
 ┌──────────────┐   ┌───────────────┐   ┌────────────────┐   ┌─────────────┐
 │  RAS crawler │──▶│  PDF pipeline  │──▶│   indexing     │──▶│   Qdrant    │
 │  (parser.js) │   │ download+text  │   │  Jina v4 embed │   │ (vectors)   │
 └──────┬───────┘   └───────┬────────┘   └───────┬────────┘   └──────┬──────┘
        │                   │                    │                   │
        ▼                   ▼                    ▼                   ▼
 ┌──────────────────────────────────────────────────────────────────────┐
 │                          Postgres  (acts + RAG-state)                  │
 └──────────────────────────────────────────────────────────────────────┘
                                    ▲
                                    │
          ┌─────────────────────────┴───────────────────────────┐
          │              Search API  (HTTP, :8091)               │
          │   HyDE → retrieval → rerank → LLM-summary            │
          └───────────┬──────────────────────────┬──────────────┘
                      │                           │
            ┌─────────▼─────────┐       ┌─────────▼─────────────────┐
            │  Telegram bot     │       │  Inference (GPU, :8000)   │
            │ (frontend)        │       │  Jina embed v4 + rerank   │
            │  + Whisper :8001  │       │  v3                       │
            └───────────────────┘       └───────────────────────────┘
```

## Структура репозитория

```
.
├── backend/                  # вся серверная логика
│   ├── parser.js             # парсер ras.arbitr.ru (краулер) + вердикт-резолвер
│   ├── stealthManager.js     # обёртка над Playwright (anti-bot)
│   ├── outcome_polarity.json # справочник outcome-кодов
│   ├── network/              # мобильный прокси: ротация IP/оператора/гео, preflight
│   ├── db/                   # Postgres: схемы, репозитории, клиенты
│   ├── pdf/                  # скачивание PDF (pravocaptcha/salto) + извлечение текста
│   ├── embed/                # эмбеддинги: чанкинг, late-chunking, retrieval, rerank
│   ├── llm/                  # HyDE, переписывание запроса, генерация выжимки/PDF
│   ├── search/               # Search API + поисковый пайплайн + Doczilla-фасад
│   ├── indexing/             # batch-задачи индексации в Qdrant, embed-worker
│   ├── proxy-tools/          # CLI и пробы для управления прокси
│   ├── tools/                # операционные/диагностические CLI
│   └── inference/            # Python GPU-сервис: Jina embed v4 + reranker v3 + Whisper STT
│
├── frontend/
│   └── telegram/             # Telegram-бот (то, что видит пользователь)
│
├── ops/                      # эксплуатация: supervisor-обёртки, бэкапы, статус
├── docs/                     # документация (Doczilla API, MobileProxy API)
├── data/                     # 🚫 gitignored — все транзитные данные (модели, parsed_data, debug, tmp)
├── docker-compose.yml        # Postgres ×2 + Qdrant + Inference
├── .env.example              # все параметры с дефолтами
└── CLAUDE.md                 # подробный технический контекст по парсеру/пайплайну
```

> Всё тяжёлое и runtime-генерируемое (модели, виртуальные окружения, PDF,
> логи, снапшоты) лежит вне репозитория — в `data/`, `logs/` и на отдельных
> дисках, и не коммитится. Репозиторий = только исходники и конфиги.

## Технологии

- **Node.js ≥ 20** (ESM, встроенный fetch) — парсер, индексация, Search API, бот.
- **Playwright** (Chromium) — обход ras/kad.arbitr.ru.
- **Postgres 16** — `acts` (метаданные + текст + RAG-состояние) и отдельная база логов поиска.
- **Qdrant** — векторное хранилище.
- **Jina embeddings v4 + reranker v3** — GPU-инференс (FastAPI, порт 8000).
- **Whisper large-v3 (ru)** — голосовой ввод (порт 8001).
- **Gemini** — HyDE и генерация выжимки.
- **MobileProxy.Space** — мобильные прокси с ротацией.

## Быстрый старт

```bash
# 1. Зависимости
npm install
npx playwright install chromium

# 2. Конфиг — заполнить ключи (MP_*, RAS_PG_DSN, TELEGRAM_BOT_TOKEN, GEMINI_*, ...)
cp .env.example .env

# 3. Инфраструктура (Postgres ×2, Qdrant; inference поднимается отдельно — см. ниже)
docker compose up -d postgres postgres_logs qdrant

# 4. Миграции схем
npm run db:migrate            # таблица acts
npm run db:migrate-logs       # база логов поиска
npm run db:migrate-reports    # таблица отчётов Doczilla-фасада
```

GPU-сервис инференса (`backend/inference/`) — отдельное Python-окружение:

```bash
cd backend/inference
python3.12 -m venv venv
./venv/bin/pip install --upgrade pip
# torch собран под CUDA 11.8 — ставим с нужного индекса колёс:
./venv/bin/pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu118

# эмбеддинги + reranker (грузит модель Jina v4 на GPU):
./venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port 8000
# распознавание голоса (модель Whisper в data/models/ или RAS_WHISPER_MODEL_PATH):
./venv/bin/python -m uvicorn transcribe_worker:app --host 0.0.0.0 --port 8001
```

## Сервисы в проде (systemd)

| Сервис | Что делает | Порт | Юнит |
|---|---|---|---|
| Telegram bot | пользовательский фронт | — | `ras-tg-bot-supervised` (user) |
| Search API | HTTP-поиск (HyDE→rerank→summary) | 8091 | `ras-search-api` |
| Inference | Jina embed v4 + reranker v3 (GPU) | 8000 | `ras-inference` |
| Whisper | распознавание голоса | 8001 | `ras-whisper` |
| Embed worker | фоновая индексация в Qdrant | — | `ras-embed-worker` |

Бэкап Postgres — по cron в 03:00 (`ops/backup-pg.sh`). Общий статус — `bash ops/ras-status.sh`.

## Запуск компонентов вручную

```bash
npm start                 # парсер ras.arbitr.ru (под supervisor'ом с авто-рестартом)
npm run download:acts     # скачивание PDF + извлечение текста (пул прокси-воркеров)
npm run embed:worker      # индексация актов в Qdrant
npm run search:api        # HTTP Search API на :8091
npm run telegram:bot      # Telegram-бот
npm run proxy:list        # состояние прокси (см. также proxy:ip / proxy:operator / proxy:geo)
```

Полный список команд — в `package.json` (`scripts`).

## Тесты (без сети/GPU)

```bash
npm run test:probe-classifier      # классификатор анти-клоака
npm run test:quarantine-smoke      # карантин прокси-воркеров
npm run smoke:proxy-health         # scoring proxy-health
npm run test:meta-antifraud-smoke  # детектор анти-фрод страниц
npm run test:config-target-override
```

## Подробнее

- **`CLAUDE.md`** — глубокий технический контекст: логика отбора актов, аномалии
  метаданных RAS, вердикт-резолвер, эскалация прокси, watchdog'и, PDF-пайплайн.
- **`docs/`** — Doczilla-совместимый API-фасад, дамп API MobileProxy.
- **`.env.example`** — каждый параметр с дефолтом и комментарием.
