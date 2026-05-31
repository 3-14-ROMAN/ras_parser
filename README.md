# RAS Search — Supply

**Демо-версии:**

* 🌐 Веб-приложение — https://rassearchsupply.tech
* 🤖 Telegram-бот — https://t.me/ArbitrSupply_bot

RAS Search — Supply это сервис для поиска судебной практики по спорам из договоров поставки. Пользователь описывает ситуацию обычным языком или голосом, система находит релевантные арбитражные акты, ранжирует результаты и формирует краткую выжимку по найденной практике.

Пример запроса в Telegram-боте:

```text
Покупатель не оплатил поставленный товар, есть подписанные УПД, нужна практика по взысканию задолженности и неустойки
```

## Назначение

Проект предназначен для быстрого анализа судебной практики по поставочным спорам:

* взыскание задолженности по договору поставки;
* неустойка за просрочку поставки или оплаты;
* ненадлежащее качество товара;
* недопоставка, отказ от приёмки, возврат товара;
* иные типовые споры между поставщиком и покупателем.

Сервис помогает быстро найти релевантные судебные акты и получить первичное резюме по позиции судов.

## Основные возможности

* Поиск по судебной практике на естественном языке.
* Веб-приложение и Telegram-бот с единой логикой поиска.
* Поддержка голосовых запросов (Telegram и веб, hold-to-talk).
* Семантический поиск по базе арбитражных актов.
* Ранжирование найденных документов по релевантности.
* Краткая выжимка по топ найденных актов.
* HTTP Search API для интеграции с внешними системами.
* Doczilla-compatible API facade для сценария создания поисковых отчётов.

## Архитектура

```text
Telegram Bot / Web / HTTP API
        |
        v
Search API  (backend/search)
        |
        +--> HyDE (Gemini): запрос → гипотетический акт, которым эмбедится поиск
        +--> Embedding (Jina v4): dense 2048 + ColBERT multivector (128/токен) + sparse
        +--> Retrieval в Qdrant — гибрид по веткам:
        |       короткие акты (full_act):  ColBERT MaxSim, sparse/BM25
        |       длинные акты (late-chunk): dense, sparse, ColBERT — с group_by act_id
        +--> RRF fusion: слияние веток по рангам (а не по несравнимым score'ам)
        +--> Jina reranker v3: cross-encoder поверх полного текста топ-кандидатов
        +--> LLM summary (Gemini): краткая выжимка по топ-актам
        |
        v
Search results
```

Поиск гибридный: ни один сырой score Qdrant не сравнивается между ветками
(ColBERT MaxSim, dense Dot, sparse IDF — разные шкалы) — ветки сливаются только
по позициям через RRF, а финальную точность даёт cross-encoder reranker,
читающий полный текст акта. Подробности — в `backend/embed/retrieval.js`.

Основные компоненты:

* `frontend/telegram` Telegram-бот.
* `frontend/web` Веб-приложение (зеркало бота) и тонкий node-прокси.
* `backend/search` Search API и поисковый pipeline.
* `backend/embed` retrieval, rerank, индексация и работа с embeddings.
* `backend/inference` GPU inference service для Jina embeddings и reranker.
* `backend/db` Postgres-клиенты, схемы и репозитории.
* `backend/pdf` обработка PDF судебных актов.
* `backend/parser.js` сбор и обработка данных из источников.
* `ops` эксплуатационные скрипты, supervisor wrappers, backup и status команды.
* `docs` дополнительная техническая документация.
* `data` runtime-данные, модели, временные файлы. Папка не коммитится.

### Технологический стек

* Node.js 20+
* PostgreSQL 16
* Qdrant
* FastAPI
* Jina embeddings v4
* Jina reranker v3
* Whisper для распознавания голосовых запросов
* Gemini для HyDE и summary generation
* Telegram Bot API
* Docker Compose для инфраструктурных сервисов
* systemd для production services

## Структура репозитория

```text
.
├── backend/
│   ├── db/
│   ├── embed/
│   ├── inference/
│   ├── llm/
│   ├── network/
│   ├── pdf/
│   ├── search/
│   ├── indexing/
│   ├── proxy-tools/
│   ├── tools/
│   └── parser.js
│
├── frontend/
│   ├── telegram/
│   └── web/
│
├── ops/
├── docs/
├── data/
├── docker-compose.yml
├── package.json
├── .env.example
└── README.md
```

## Быстрый старт

### 1. Установка Node.js зависимостей

```bash
npm install
npx playwright install chromium
```

### 2. Настройка окружения

```bash
cp .env.example .env
```

Заполните значения в `.env`:

* PostgreSQL DSN;
* Qdrant URL;
* Telegram Bot Token;
* Gemini API key;
* параметры inference-сервисов;
* параметры внешних источников.

### 3. Запуск инфраструктуры

```bash
docker compose up -d postgres postgres_logs qdrant
```

### 4. Миграции

```bash
npm run db:migrate
npm run db:migrate-logs
npm run db:migrate-reports
```

### 5. Inference service

Production inference запускается отдельным Python-окружением из `backend/inference`:

```bash
cd backend/inference
python3.12 -m venv venv
./venv/bin/pip install --upgrade pip
./venv/bin/pip install -r requirements.txt --extra-index-url https://download.pytorch.org/whl/cu118
./venv/bin/python -m uvicorn app:app --host 0.0.0.0 --port 8000
```

Whisper service:

```bash
cd backend/inference
./venv/bin/python -m uvicorn transcribe_worker:app --host 0.0.0.0 --port 8001
```

### 6. Search API

```bash
npm run search:api
```

### 7. Telegram-бот

```bash
npm run telegram:bot
```

### 8. Веб-приложение

```bash
npm run web
```

Веб-приложение слушает порт `8080` и проксирует запросы в Search API (`8091`)
и Whisper (`8001`) на том же origin. Голосовой ввод требует HTTPS (в production
обеспечивается обратным прокси).

## Production services

В production используются systemd-сервисы:

| Service                          | Purpose                      | Port |
| -------------------------------- | ---------------------------- | ---- |
| `ras-search-api`                 | HTTP Search API              | 8091 |
| `ras-inference`                  | Jina embeddings и reranker   | 8000 |
| `ras-whisper`                    | Voice transcription          | 8001 |
| `ras-web`                        | Веб-приложение               | 8080 |
| `ras-tg-bot-supervised` (user)   | Telegram interface           | -    |
| `ras-embed-worker`               | Background indexing          | -    |

Проверка статуса:

```bash
sudo systemctl status ras-search-api --no-pager -l
sudo systemctl status ras-inference --no-pager -l
sudo systemctl status ras-whisper --no-pager -l
systemctl --user status ras-tg-bot-supervised --no-pager -l
sudo systemctl status ras-embed-worker --no-pager -l
```

Health checks:

```bash
curl -s http://127.0.0.1:8091/health
curl -s http://127.0.0.1:8000/health
curl -s http://127.0.0.1:8001/health
```

## API

Основной Search API работает на порту `8091`.

Ключевые endpoints:

```text
GET  /health
GET  /stats
POST /search
GET  /search/stream
POST /hyde
```

Doczilla-compatible facade:

```text
POST /doczilla-api/login
GET  /doczilla-api/document/structureRead
POST /doczilla-api/document/createDocz
POST /doczilla-api/document/fillDocz
GET  /doczilla-api/document/getById
POST /doczilla-api/document/get
```

Неподдержанные методы Doczilla возвращают `501 Not Implemented`.

## Тесты и проверки

```bash
npm run test:probe-classifier
npm run test:quarantine-smoke
npm run smoke:proxy-health
npm run test:meta-antifraud-smoke
npm run test:config-target-override
```

Doczilla smoke test:

```bash
./ops/doczilla-smoke.sh
```

Полный список npm-команд см. в `package.json`.

## Runtime data

Runtime-данные не хранятся в git:

* модели;
* временные файлы;
* логи;
* PDF;
* parsed data;
* debug output;
* virtual environments.

Для этого используется папка `data/`, которая указана в `.gitignore`.

## Документация

Дополнительные материалы:

* `docs/doczilla-api.md`
* `docs/doczilla-acceptance-report.md`
* `CLAUDE.md`
* `.env.example`
