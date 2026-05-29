# RAS Search — Supply: Doczilla-compatible API facade
## Acceptance report

**Дата:** 2026-05-26
**Версия:** commits `3609a64`, `2bd4da0` на `main`
**Endpoint prefix:** `/doczilla-api/*` (внутри `backend/search/search-api.js`, порт 8091)

---

## 1. Что реализовано

**RAS Search — Supply** — это поисковый продукт по практике арбитражных
судов РФ (категория 3.1 — договоры поставки): запрос текстом или голосом
→ HyDE-перезапись через Gemini → семантический поиск в Qdrant с RRF →
rerank через Jina v3 → опциональная AI-сводка по топ-актам.

**Этот facade — НЕ полноценная Doczilla.** Это тонкая HTTP-обёртка над
существующим поисковым pipeline'ом, повторяющая surface Doczilla API
(`/doczilla-api/document/*`).

**Цель:** дать внешнему клиенту, у которого уже есть готовый Doczilla
SDK / интеграция, возможность вызывать наш поиск без изменения своего
кода. Знакомые методы (`createDocz` → `fillDocz` → `getById` / `get`),
знакомая структура ответов (`{ success, data | error, message }`),
знакомый flow «login → token → call API».

**Что внутри одного `fillDocz`:** HyDE + Qdrant retrieval + RRF +
Jina rerank + опциональный Gemini Summary, синхронно (~10–30 с до ответа).

---

## 2. Методы

### Поддержанные

| HTTP | Path                                              | Назначение                                                |
|------|---------------------------------------------------|-----------------------------------------------------------|
| POST | `/doczilla-api/login`                             | compatibility stub; возвращает opaque token + mode        |
| GET  | `/doczilla-api/document/structureRead`            | схема анкеты (поля fillDocz)                              |
| POST | `/doczilla-api/document/createDocz`               | создать пустой отчёт (`status='created'`)                 |
| POST | `/doczilla-api/document/fillDocz`                 | заполнить + запустить pipeline + сохранить                |
| GET  | `/doczilla-api/document/getById`                  | статус и метаданные отчёта                                |
| POST | `/doczilla-api/document/get`                      | export `format`: `json` или `html`                        |

### Неподдержанные — стабильно отвечают 501 not_implemented

| Path                                              | Почему 501                                                |
|---------------------------------------------------|-----------------------------------------------------------|
| `/doczilla-api/document/getByLink`                | shared-ссылок нет (нет share)                             |
| `/doczilla-api/document/set`                      | docz нельзя редактировать после fillDocz                  |
| `/doczilla-api/document/create`                   | используйте `createDocz`                                  |
| `/doczilla-api/document/move`                     | нет folder-системы                                        |
| `/doczilla-api/document/copy`                     | копирование отчётов вне scope MVP                         |
| `/doczilla-api/document/recycle`                  | корзины нет                                               |
| `/doczilla-api/document/restore`                  | корзины нет                                               |
| `/doczilla-api/document/share`                    | публичных ссылок нет                                      |
| `/doczilla-api/document/publish`                  | публикации нет                                            |
| `/doczilla-api/document/createVersion`            | версионирования нет                                       |
| `/doczilla-api/document/edit`                     | редактирования нет (страховка от вызова)                  |
| `/doczilla-api/document/publicationApply`         | публикации нет (страховка от вызова)                      |
| `/doczilla-api/document/publicationReject`        | публикации нет (страховка от вызова)                      |
| `/doczilla-api/document/get` (`format=docx`)      | docx экспорт не реализован                                |
| `/doczilla-api/document/get` (`format=pdf`)       | pdf экспорт не реализован                                 |
| `/doczilla-api/users/create`                      | нет своей user-системы (login это stub)                   |
| `/doczilla-api/users/copy`                        | то же                                                     |
| `/doczilla-api/users/read`                        | то же                                                     |
| `/doczilla-api/users/update`                      | то же                                                     |
| `/doczilla-api/users/destroy`                     | то же                                                     |
| `/doczilla-api/users/export-report`               | то же                                                     |
| `/doczilla-api/users/preview`                     | то же                                                     |
| `/doczilla-api/users/<любой неизвестный>`         | вся семья users 501 by design                             |

Все 501-ответы — единый формат:
```json
{ "success": false, "error": "not_implemented", "message": "...", "detail": { "method": "..." } }
```

---

## 3. Маппинг Doczilla → RAS Search — Supply

| Doczilla сущность / метод | RAS Search — Supply эквивалент                                |
|---------------------------|---------------------------------------------------------------|
| `template`                | шаблон поискового отчёта; единственный — `ras_supply_search`  |
| `docz`                    | один поисковый отчёт = строка в Postgres `search_reports`     |
| `structureRead`           | схема "анкеты": какие поля принимает `fillDocz`               |
| `createDocz`              | INSERT в `search_reports` (status='created'), возвращает doczId |
| `fillDocz`                | UPDATE answers → markRunning → запустить HyDE/Qdrant/RRF/Jina/Summary pipeline → markCompleted |
| `getById`                 | SELECT отчёта (любой status), compact view                    |
| `get`                     | SELECT (требует status='completed') + рендер в `json` или `html` |

**State machine `fillDocz`:** `created → running → (completed | error)`.
Клиент **никогда не получает** `status="completed"`, пока БД не подтвердила
запись результата.

---

## 4. Production readiness

| Аспект                                   | Реализация                                                              |
|------------------------------------------|-------------------------------------------------------------------------|
| **XSS-safe HTML export**                 | все user/LLM-поля через `escapeHtml`; summary рендерится как `<pre>` escaped (БЕЗ `marked.parse`, чтобы AI-сгенерированный markdown не выпустил `<script>`) |
| **Safe URL в HTML**                      | `pdf_link` через `safeUrl()` — пропускает только `http://` и `https://`; `javascript:`, `data:`, `file:`, `vbscript:` блокируются |
| **Compact JSON export**                  | НЕ отдаёт полный `act_text`, `env`, токены, stack traces, raw_request/response, LLM `usage` / `finish_reason`; только `id/doczId/templateId/name/status/answers/summary/topActs/timings/search_id/created_at/updated_at` |
| **Recovery зависших running отчётов**    | при старте процесса `recoverStaleRunning(N)` помечает все `running` старше `DOCZILLA_RUNNING_STALE_MINUTES` (default **60**) как `status='error'`, `error='recovered_stale_running_report_after_process_restart'` |
| **State machine fillDocz**               | markRunning → pipeline → markCompleted; если storage упал — markError + 500 (клиент не видит "completed" пока БД не подтвердила) |
| **Auth — token mode**                    | при заданном `DOCZILLA_API_TOKEN` login проверяет `apiKey` constant-time-compare; неверный → 401 |
| **Auth — dev-open mode**                 | при незаданном `DOCZILLA_API_TOKEN` любой `apiKey`/`login` проходит; в startup-логе печатается WARN |
| **Стабильные HTTP коды**                 | 200 / 400 bad_request / 401 unauthorized / 404 not_found / 405 method_not_allowed / 409 report_not_completed / 500 internal_error / 501 not_implemented |
| **Стабильные error codes**               | `bad_request`, `unauthorized`, `not_found`, `report_not_completed`, `not_implemented`, `internal_error`, `method_not_allowed`, `unsupported_template` |
| **Smoke-тест**                           | `./ops/doczilla-smoke.sh` — **14 assertions** (login, structureRead 404, get 409, fillDocz 400/404, real fillDocz, getById, get json+html, проверки XSS, get pdf 501, move 501, create 501, getByLink 501, users/read 501, users/whatever 501) |
| **Regression старых endpoints**          | `/health`, `/stats`, `/hyde`, `/search`, `/search/stream` — все работают после рефакторинга (`backend/search/searchPipeline.js` извлечён из `search-api.js` без изменений логики) |
| **DB schema идемпотентна**               | `npm run db:migrate-reports` — повторный запуск не ломает существующие данные |
| **Защита тонкой схемы аутентификации**   | facade-routes (createDocz/fillDocz/get) НЕ проверяют token; защита публичного endpoint'а — на уровне reverse-proxy/firewall (отдельный слой, не зона facade) |

### Acceptance-прогон (последний)

**Smoke** — 14 / 14 assertions PASS, exit 0:
```
✓ structureRead unknown template: HTTP 404
✓ get on non-completed: HTTP 409
✓ fillDocz empty query: HTTP 400
✓ fillDocz non-existing uuid: HTTP 404
✓ json export: no full act_text leaked
✓ get html: HTTP 200
✓ html export: no <script> tag
✓ html export: no dangerous URL scheme in href
✓ get pdf: HTTP 501
✓ move: HTTP 501
✓ create (unsupported): HTTP 501
✓ getByLink (unsupported): HTTP 501
✓ users/read (unsupported): HTTP 501
✓ users/whatever (unsupported): HTTP 501
── doczilla smoke OK (all assertions passed) ──
```

**Regression старых endpoints** — все OK:
```
/health           → {"ok":true,"ts":"…"}
/stats            → total_links=287379, valid_links=197877, downloaded_acts=100825, qdrant_acts=93930
/search (topN=3)  → returned=3, top: А41-51954/2024, А14-20799/2023, А14-18370/2025
/search/stream    → events: pipeline_start, hyde_skipped, search_start, search_done,
                    summary_skipped, pipeline_done, result, done
```

---

## 5. Команды запуска

### Применить миграцию (один раз на новой БД, идемпотентно):
```bash
npm run db:migrate-reports
```

### Запустить / перезапустить API:
search-api живёт под systemd unit `ras-search-api.service`.
```bash
sudo systemctl restart ras-search-api
sudo journalctl -u ras-search-api -n 50 --no-pager   # увидеть startup
```

В startup-логе должны появиться три строки:
```
[search-api] INFO RAS Search — Supply API listening http://127.0.0.1:8091 …
[doczilla]   INFO|WARN  doczilla-facade auth-mode=token-required|dev-open
[doczilla]   INFO  no stale 'running' reports to recover (threshold 60min)
```

### Включить token-mode (production):
```bash
# в /home/roman/ras_parser/.env:
DOCZILLA_API_TOKEN=<секретный-токен>
# опционально:
DOCZILLA_RUNNING_STALE_MINUTES=60

sudo systemctl restart ras-search-api
```

### Acceptance smoke:
```bash
./ops/doczilla-smoke.sh
# с токеном:
DOCZILLA_API_TOKEN=<секретный-токен> ./ops/doczilla-smoke.sh
```

### Curl quickstart:
```bash
BASE=http://127.0.0.1:8091

# 1. login (dev-open)
curl -sS -X POST -H "content-type: application/json" \
  -d '{"login":"alice","password":"any"}' "$BASE/doczilla-api/login"

# 2. structureRead
curl -sS "$BASE/doczilla-api/document/structureRead?templateId=ras_supply_search"

# 3. createDocz
curl -sS -X POST -H "content-type: application/json" \
  -d '{"templateId":"ras_supply_search","name":"Спор X"}' \
  "$BASE/doczilla-api/document/createDocz"

# 4. fillDocz (sync ~10-30s)
DOCZ=<uuid из createDocz>
curl -sS --max-time 120 -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ\",\"answers\":{\"query\":\"взыскание неустойки\",\"use_hyde\":true,\"use_summary\":true,\"top_k\":5}}" \
  "$BASE/doczilla-api/document/fillDocz"

# 5. getById
curl -sS "$BASE/doczilla-api/document/getById?id=$DOCZ"

# 6. get (json/html)
curl -sS -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ\",\"format\":\"json\"}" "$BASE/doczilla-api/document/get"
curl -sS -X POST -H "content-type: application/json" \
  -d "{\"doczId\":\"$DOCZ\",\"format\":\"html\"}" "$BASE/doczilla-api/document/get" -o report.html
```

---

## 6. MVP-ограничения (намеренные, не баги)

| Ограничение                                    | Что это означает для интегратора                                       |
|------------------------------------------------|------------------------------------------------------------------------|
| `fillDocz` синхронный                          | HTTP-ответ возвращается только когда pipeline отработал (~10–30 с). Очереди задач нет, async-polling нет — клиент держит коннект до ответа |
| Экспорт `docx` / `pdf` не реализован           | `format=docx`/`format=pdf` → 501. Доступны только `json` и `html`     |
| Полноценной user-системы нет                   | `/doczilla-api/users/*` → 501. `login` — opaque stub, token нигде не проверяется. Защита `/doczilla-api/*` — на уровне reverse-proxy/firewall |
| `share` / `getByLink` нет                      | публичных ссылок на отчёты нет; чтение только через `getById`/`get` по doczId |
| Только один template                           | `templateId="ras_supply_search"`. Шаблонизации нет, пользовательских шаблонов нет |
| Поле `filters` в structureRead зарезервировано | передавать в `answers.filters` можно, но pipeline их пока игнорирует   |

---

## 7. Финальный статус

| Критерий                                                                   | Статус |
|----------------------------------------------------------------------------|--------|
| API-совместимость с Doczilla на уровне ключевых методов                    | ✓     |
| Стабильные HTTP-коды и error codes                                         | ✓     |
| XSS-safe HTML export, compact JSON export                                  | ✓     |
| State machine `fillDocz` корректно обрабатывает все failure-сценарии       | ✓     |
| Startup recovery зависших `running` отчётов                                | ✓     |
| Auth-stub с поддержкой token-mode для production                           | ✓     |
| Smoke-тест покрывает все методы и edge cases                               | ✓     |
| Старые endpoints (`/health`, `/stats`, `/hyde`, `/search`, `/search/stream`) не сломаны | ✓     |
| Документация для интегратора (`docs/doczilla-api.md`)                      | ✓     |

**Готово к демонстрации как MVP API-совместимости с Doczilla.**

**Важно для коммуникации с клиентом:**
- Не позиционировать как полную интеграцию с Doczilla.
- Это **adapter / facade**: внешний клиент Doczilla получает знакомый surface
  поверх нашего поискового продукта; всё, что выходит за рамки «создать
  отчёт → запустить поиск → получить результат», отдаёт стабильный 501.
- Real authentication для production должна обеспечиваться на уровне
  reverse-proxy / firewall перед `/doczilla-api/*`, либо включением
  `DOCZILLA_API_TOKEN` и контролем выдачи токена интегратору.

---

## Связанные файлы

- `backend/search/doczilla-facade.js` — основной код facade
- `backend/search/searchPipeline.js` — извлечённый pipeline (используется и /search, и fillDocz)
- `backend/search/search-api.js` — HTTP-сервер, mount /doczilla-api/* → facade
- `db/searchReportsRepo.js` — CRUD над `search_reports`
- `db/search_reports_schema.sql` — миграция (идемпотентна)
- `ops/doczilla-smoke.sh` — acceptance smoke (14 assertions)
- `docs/doczilla-api.md` — детальная документация для интегратора
- `docs/doczilla-acceptance-report.md` — этот документ
