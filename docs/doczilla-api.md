# RAS Search — Supply Doczilla-compatible API facade

## Что это такое

Тонкий HTTP-фасад над поиском `RAS Search — Supply`, который повторяет surface
Doczilla API (`/doczilla-api/document/*`). Цель — дать внешним интеграторам,
которые уже умеют ходить в Doczilla, возможность вызывать наш поиск, не меняя
свои клиенты: знакомые методы `createDocz` / `fillDocz` / `getById` / `get` /
`structureRead`, знакомая структура ответов `{ success, data | error, message }`.

Endpoint prefix: `/doczilla-api/*`. Mount внутри `scripts/search-api.js`.

## Что это НЕ

Это **не полноценная Doczilla**. Мы не конструктор документов, не CMS, не DMS.
Мы поисковый продукт по практике договоров поставки (категория 3.1 ВАС/АС РФ),
который умеет одно: принять текст ситуации → отдать топ релевантных судебных
актов + опциональную AI-сводку.

Поэтому:

- Шаблон один и зафиксирован: `ras_supply_search`.
- Документооборотные методы (`move`, `copy`, `recycle`, `restore`, `share`,
  `publish`, `publicationApply`, `publicationReject`, `edit`, `createVersion`,
  `set`, `create`) возвращают **501 not_implemented**.
- Форматы экспорта `docx` / `pdf` — **501 not_implemented**.
- `/doczilla-api/login` — **compatibility stub**, не полноценная авторизация
  (см. ниже).
- `fillDocz` синхронный: HTTP-ответ возвращается только когда pipeline отработал
  целиком (HyDE → search → rerank → summary). Это может занять ~10–30 с.

## Маппинг сущностей

| Doczilla     | RAS Search — Supply                                                     |
|--------------|-------------------------------------------------------------------------|
| template     | шаблон поискового отчёта; единственный — `ras_supply_search`            |
| docz         | один поисковый отчёт = строка в таблице `search_reports`                |
| structureRead| схема полей анкеты (`query`, `use_hyde`, `use_summary`, `top_k`, …)     |
| createDocz   | INSERT пустого отчёта в `search_reports` (status='created')             |
| fillDocz     | UPDATE answers + запуск pipeline + сохранение (status='completed')      |
| getById      | SELECT отчёта (любой status)                                            |
| get          | SELECT + рендер в `json` или `html` (только когда status='completed')   |

## Поддержанные методы

- `POST /doczilla-api/login`
- `GET  /doczilla-api/document/structureRead?templateId=ras_supply_search`
- `POST /doczilla-api/document/createDocz`
- `POST /doczilla-api/document/fillDocz`
- `GET  /doczilla-api/document/getById?id=...`
- `POST /doczilla-api/document/get` (`format`: `json` | `html`)

## Неподдержанные методы

Все возвращают **501 not_implemented** с телом
`{ success: false, error: "not_implemented", message: "...", detail: { method } }`:

- `move`, `copy`, `recycle`, `restore`, `share`
- `publish`, `publicationApply`, `publicationReject`
- `edit`, `createVersion`, `set`, `create`

`get` с `format=docx` или `format=pdf` также возвращает **501**.

## State machine fillDocz

```
created  ─fillDocz─▶  running  ─pipeline OK + markCompleted OK─▶  completed
                          │
                          ├─pipeline failed───────────▶  error
                          │
                          └─markCompleted failed──────▶  error  (storage_failed:...)
```

- Клиент **никогда не получает** `status: "completed"` пока DB не подтвердила
  запись результата. Если `markCompleted` упал — клиент получит **500
  internal_error**, и отчёт в БД будет помечен `status='error'`.
- На старте процесса search-api запускается recovery: все отчёты, висящие в
  `running` дольше `DOCZILLA_RUNNING_STALE_MINUTES` минут (default 60),
  переводятся в `status='error'` с
  `error='recovered_stale_running_report_after_process_restart'`.

## Контракт ответов

### Success

```json
{ "success": true, "data": { ... } }
```

### Error

```json
{ "success": false, "error": "stable_code", "message": "human readable" }
```

Стабильные коды:

| HTTP | error                       | смысл                                                              |
|------|-----------------------------|--------------------------------------------------------------------|
| 200  | —                           | ok                                                                 |
| 400  | `bad_request`               | невалидный body / отсутствует обязательное поле                    |
| 400  | `unsupported_template`      | передан templateId ≠ `ras_supply_search`                           |
| 401  | `unauthorized`              | login: apiKey не совпал с DOCZILLA_API_TOKEN                       |
| 404  | `not_found`                 | отчёт по doczId не существует / неизвестный document-метод         |
| 404  | `unsupported_template`      | structureRead: запрошенный templateId не наш                       |
| 405  | `method_not_allowed`        | HTTP-метод не подходит (например, GET вместо POST)                 |
| 409  | `report_not_completed`      | get: отчёт ещё не в status='completed'                             |
| 500  | `internal_error`            | DB / pipeline failure                                              |
| 501  | `not_implemented`           | unsupported document method или unsupported format (docx/pdf)      |

## Compatibility-stub login

`POST /doczilla-api/login` существует только чтобы Doczilla-клиенты, у которых
hard-coded шаг `login → token`, не падали на старте. Возвращаемый token — opaque,
**нигде не проверяется** в последующих запросах (createDocz/fillDocz/get НЕ
требуют Authorization-заголовка).

Реальную защиту публичных endpoint'ов делайте через reverse-proxy/firewall.

### Режимы

- **token-required**: задан env `DOCZILLA_API_TOKEN`. login принимает только
  `apiKey`, равный этому токену (constant-time compare). Иначе → 401.
- **dev-open**: env не задан. Принимаются любые `apiKey` ИЛИ `login+password`.
  При старте процесса печатается WARN в stderr.

`mode` возвращается в ответе: `data: { token, userId, mode: "token-required" | "dev-open" }`.

## Форматы экспорта

### `get` format=`json`

Возвращает compact-отчёт (НЕ полный pipeline-responseBody):

```json
{
  "success": true,
  "data": {
    "format": "json",
    "report": {
      "id": "...", "doczId": "...", "templateId": "...", "name": "...",
      "status": "completed",
      "answers": { ... },
      "query": "...",
      "summary": "AI-сгенерированный текст или null",
      "topActs": [
        {
          "act_id": "...", "case_id": "...", "case_number": "...",
          "court": "...", "registration_date": "...", "type_name": "...",
          "true_instance_level": 1|2|3|null,
          "verdict_keep": true|false|null, "verdict_action": "...",
          "pdf_link": "...", "rerank_score": 0.97, "rrf_score": 0.016,
          "snippet": "первые ~280 символов act_text…", "text_chars": 12345
        }
      ],
      "timings": { "total_ms": ..., "retrieval_ms": ..., "hydrate_ms": ..., "rerank_ms": ..., "hyde_ms": ..., "summary_ms": ... },
      "hyde": { "used": true|false, "model_version": "...", "chars": ... },
      "rerank": { "model": "...", "scored": ... },
      "summary_meta": { "used": true|false, "model_version": "...", "chars": ..., "acts_used": ... },
      "search_id": "...", "error": null,
      "created_at": "...", "updated_at": "...",
      "availableFormats": ["json", "html"]
    }
  }
}
```

**Намеренно НЕ отдаются:** полный `act_text`, env-переменные, токены, stack
traces, исходный `raw_request`/`raw_response`, usage / finish_reason LLM.
Snippet в `topActs[].snippet` — первые ~280 символов; полный текст акта тянется
из Postgres напрямую по `act_id`, это решение про API surface, а не про
возможности pipeline.

### `get` format=`html`

Возвращает `text/html; charset=utf-8`. Все user/LLM-provided поля — `name`,
`query`, `summary`, `caseNumber`, `court`, `date`, `snippet`, `score` —
пропускаются через HTML-escape. `pdf_link` — через `safeUrl`: разрешены только
`http://` и `https://`, схемы `javascript:`, `data:`, `file:`, `vbscript:` и
прочие не рендерятся. `summary` рендерится как escaped pre-formatted text (БЕЗ
markdown-парсера — это сознательное MVP-решение, чтобы исключить XSS-вектора
через AI-генерированный markdown).

### `get` format=`docx` | `format=pdf`

→ **501 not_implemented**. Не на дорожной карте MVP.

## Ограничения MVP

- `fillDocz` синхронный (нет очереди задач, нет async-uuid'a с polling).
- `docx` / `pdf` экспорт не реализован.
- `login` — compatibility stub, не настоящая авторизация.
- Только один template: `ras_supply_search`. Нет шаблонизации, нет шаблонов
  пользователя.
- Доп. фильтры (`filters` в structureRead) зарезервированы, но pipeline их
  пока не использует.
- Все доп-методы Doczilla (документооборот) → 501.

## ENV

| ENV                                  | default | смысл                                                            |
|--------------------------------------|---------|------------------------------------------------------------------|
| `DOCZILLA_API_TOKEN`                 | —       | если задан, login требует apiKey равный этому токену             |
| `DOCZILLA_RUNNING_STALE_MINUTES`     | 60      | старт-recovery: running старше N мин → status='error'            |

## curl examples

```bash
BASE=http://127.0.0.1:8091

# 1. login (dev-open)
curl -sS -X POST -H "content-type: application/json" \
  -d '{"login":"alice","password":"any"}' \
  "$BASE/doczilla-api/login"

# 1b. login (token-required: DOCZILLA_API_TOKEN=secret123)
curl -sS -X POST -H "content-type: application/json" \
  -d '{"apiKey":"secret123"}' \
  "$BASE/doczilla-api/login"

# 2. structureRead
curl -sS "$BASE/doczilla-api/document/structureRead?templateId=ras_supply_search"

# 3. createDocz
curl -sS -X POST -H "content-type: application/json" \
  -d '{"templateId":"ras_supply_search","name":"Спор с поставщиком X"}' \
  "$BASE/doczilla-api/document/createDocz"
# → {"success":true,"data":{"doczId":"<uuid>", ...}}

# 4. fillDocz (синхронно ~10-30s)
DOCZ=<uuid из createDocz>
curl -sS -X POST -H "content-type: application/json" \
  --max-time 120 \
  -d "{
    \"doczId\":\"$DOCZ\",
    \"answers\":{
      \"query\":\"взыскание неустойки за просрочку поставки\",
      \"use_hyde\":true,
      \"use_summary\":true,
      \"top_k\":5
    }
  }" \
  "$BASE/doczilla-api/document/fillDocz"

# 5. getById
curl -sS "$BASE/doczilla-api/document/getById?id=$DOCZ"

# 6. get (json)
curl -sS -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ\",\"format\":\"json\"}" \
  "$BASE/doczilla-api/document/get"

# 7. get (html)
curl -sS -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ\",\"format\":\"html\"}" \
  "$BASE/doczilla-api/document/get" -o /tmp/report.html
```

## Smoke

```bash
# В одном окне:
npm run search:api
# В другом:
npm run db:migrate-reports       # один раз, идемпотентно
./scripts/doczilla-smoke.sh
```
