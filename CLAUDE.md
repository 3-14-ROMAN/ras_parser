# ras_parser — оперативный контекст для Claude Code

Парсер выдачи `ras.arbitr.ru` (банк решений арбитражных судов РФ). Собирает «итоговые мотивированные акты» по категории спора 3.1 («Договоры поставки») через прокси MobileProxy.Space. Sink — Postgres, единая таблица `acts`.

## Главное правило отбора актов

Запись = **итоговый акт с мотивировкой**, если выполняется одно из:

1. `TypeId ∈ {75babf17, edac92ae, ae1a12e4}` («специфичные»: решение 1-й инст., постановление апелляции, постановление кассации). Уровень инстанции фиксируется TypeId — `item.InstanceLevel` НЕ используется (один источник правды).
2. `TypeId == 23f4baa9-…` (зонтичная категория «Решения и постановления») И **первый GUID** в `ContentTypesString` ∈ allowlist:
   - `1c35af3f` — Решение 1-й инст. (IL=1)
   - `08f888a2` — Мотивированное решение упрощ. произв. (IL=1)
   - `db0af13c` — Дополнительное решение (IL=1) — да, тоже мотивированное (ст. 178 АПК)
   - `1d294878` — Постановление апелляции (IL=2)
   - `08cbe371` — Постановление апелляции, вариант (IL может быть 1 — см. аномалии)
   - `b74eecb7` — Постановление апелляции по существу спора (IL=2)
   - `8a67b151` — Дополнительное постановление апелляции (IL=2)
   - `9d26156d` — Постановление кассации (IL=3)
   - `171b5aca` — Постановление кассации, вариант (IL может быть 1 — см. аномалии)
   - `cfd700af` — Решение кассации по 68-ФЗ (IL=1, это семантически корректно)

Канонический список — в `parser.js` (`DEFAULT_DECISION_TYPE_IDS`, `UMBRELLA_DECISION_TYPE_ID`, `UMBRELLA_FINAL_GENRE_GUIDS`, `GENRE_TO_INSTANCE_LEVEL`, `SPECIFIC_TYPE_ID_TO_INSTANCE_LEVEL`). Хелперы — `_isFinalMotivatedAct(item, targetSet)` и `_resolveInstanceLevel(item)`.

## Аномалии метаданных (которые легко принять за баги)

В umbrella-записях `Court` и `InstanceLevel` отражают **карточку дела**, а не сам документ. Пример:
- `Court="АС Пермского края"`, `InstanceLevel=1`, но в PDF — постановление 17-го арбитражного апелляционного суда.
- `Court="АС Алтайского края"`, `InstanceLevel=1`, но в PDF — постановление АС Западно-Сибирского округа (кассация).

Реальную инстанцию определяет `_resolveInstanceLevel`: specific TypeId → жёсткая карта, umbrella → first-GUID жанра. В таблице `acts` лежит два столбца: `raw_instance_level` (как пришло) и `true_instance_level` (резолвнутое). В запросах для аналитики обычно нужен второй.

Для `cfd700af` IL=1 — это норма, не аномалия: окружной суд по 68-ФЗ (компенсация за разумные сроки) действует как 1-я инстанция.

## Сток данных (Postgres)

Канонический и единственный sink — PostgreSQL, таблица `acts`. Все поля item /Search (`Id, CaseId, CaseNumber, InstanceNumber, FileName, RegistrationDate, DisplayDate, InstanceLevel, Court, TypeId, Type, DecisionTypeId, ContentTypes, ContentTypesString, SignatureInfo, SphinxId, DocumentCount`) сохраняются как отдельные колонки + полный сырой item в `raw_metadata jsonb`. Сверху — вычисленные парсером (`true_instance_level`, `verdict_*`) и состояние RAG-пайплайна (`pdf_downloaded`, `act_text`, `vector_indexed`, `qdrant_point_id`).

PK = `id` (UUID документа из RAS). Схема в `db/schema.sql`, идемпотентна — повторный прогон ничего не ломает.

Запуск миграции:
```bash
npm run db:migrate              # docker exec -i ras_pg psql ... < db/schema.sql
# либо если psql установлен на хосте:
psql "$RAS_PG_DSN" -f db/schema.sql
```

`parser.js` пишет через `db/actsRepo.js`: батчевый upsert по 1000 строк, `ON CONFLICT (id) DO UPDATE … last_seen_at = NOW()`. Запись инкрементальная — на каждой странице /Search заливается только то, что в этом прогоне новое (`_pendingPgKeys` + `_markDecisionLinkPending`).

**Resume:** при перезапуске in-memory Map пуст, но PG отдаёт по своим первичным ключам — повторно собираемые row'ы UPDATE'ятся (не INSERT'ятся), счётчик `[save/pg] acts` это пишет. Если нужен честный счётчик «новых-в-PG за прогон» — смотри суммы `inserted` в логах, а не «новых pdf-ссылок» (это про in-memory).

Конфиг — `RAS_PG_DSN` или `DATABASE_URL` в `.env` (формат `postgresql://user:pass@host:port/db`). pgClient принимает оба, `RAS_PG_DSN` в приоритете. Если оба пустые и режим = acts, parser.js падает на старте с понятной ошибкой.

`pg`-зависимость лениво загружается из `db/pgClient.js`, чтобы режим `types` (справочник DocumentType) продолжал работать без PG.

### Verdict-резолвер (кросс-CaseId)

`_resolveCaseVerdicts` группирует акты Map по `caseId`, выбирает «главный» акт инстанции (`_pickMainActOfLevel`) для каждого IL=1/2/3 и через `_resolveCaseFinal` определяет, какой из них финал по существу спора (4 ИСХОДа из спеки: только 1-я; апелляция; кассация; нет финала). Финальный акт получает `verdict_keep=true`, остальные — `false` + `verdict_note` («засилено апелляцией», «отменено кассацией» и т.п.). Outcome-action классификатор берёт текст из `ContentTypes[1]` (umbrella) или GUID'ы `ContentTypesString` (specific) и матчит regexp'ом.

Резолвер вызывается перед каждым `_saveDecisionLinks`. Если verdict изменился у уже залитой в PG записи (например, по делу прилетела апелляция, и решение 1-й перестало быть финалом) — она помечается pending и переапсертится. Полярность по GUID хранится в `outcome_polarity.json` (lazy-loaded).

## Технические ограничения RAS

- **Потолок 40 страниц × 25 items = 1000 актов на /Search.** Серверный лимит, обойти нельзя. На «горячих» днях (понедельники после праздников, конец квартала) теряется хвост.
- **DateFrom/DateTo по времени сервер игнорирует/округляет до даты.** Сплит дня по часам почти бесполезен — возвращает те же 1000 items в новом порядке.
- **Поля сортировки в body /Search нет** (схема: `GroupByCase, Count, Page, StatDisputeCategory, DateFrom, DateTo, Sides, Judges, Cases, Text`). Двойной проход с инвертированной сортировкой невозможен без знания недокументированных параметров.
- **Реальные способы добрать хвост cap-дней:** сплит по судам (мульти-селект «Суд» в UI) — пока не реализовано.

## Прокси и анти-бот

- MobileProxy.Space, креды в `.env` (`MP_PROXY_SERVER/USER/PASS` + `MP_API_TOKEN` + `MP_PROXY_KEY`).
- `network/loadEnv.js` подхватывает `.env` автоматически.
- Эскалатор: changeIp ×N → changeOperator ×M → changeGeo, бесконечный круг (`network/escalator.js`, лимиты в `.env`).
- Geo-фильтры через `GEO_*` env (`network/config.js`): по умолчанию РФ исключена, разрешён whitelist СНГ, миллионники режутся regex'ом.

## Запуск

```bash
# Один раз:
npm install
npx playwright install chromium
cp .env.example .env            # заполни MP_* и RAS_PG_DSN
docker compose up -d postgres   # БД на /data/postgres
npm run db:migrate              # схема `acts`

# Основной парсер
npm start                       # bash scripts/run-parser-supervised.sh (с авто-рестартом)

# Управление прокси
npm run proxy:ip
npm run proxy:operator
npm run proxy:geo
npm run proxy:list
```

## Что важно знать

- `parser.js` — единственный парсер.
  - **Sink: Postgres, таблица `acts`.** JSON-чанков нет. Без DSN режим `acts` падает.
  - Фильтр: двухуровневый (specific TypeId + umbrella с allowlist firstCts).
  - Resume через `ON CONFLICT (id) DO UPDATE`.
  - Кросс-CaseId verdict-резолвер (`_resolveCaseVerdicts`) каждые `_saveDecisionLinks`.
  - Интерактивный план окон или CLI-режим (`MODE_TYPES` для справочника типов / `MODE_DECISION_LINKS` aka `acts` для актов).
- `RAS_MODE=acts` и `RAS_MODE=decision_links` — алиасы, оба работают (для обратной совместимости со старыми `.env`).

## Preflight через текущий прокси (parser.js)

`network/proxyPreflight.js` — лёгкий HTTP-probe ras.arbitr.ru через тот же прокси, что отдан Chromium'у. Дёргается внутри `_safeGoto` перед каждой попыткой `page.goto(BASE_URL)`:

- `undici.request` через `ProxyAgent`, таймаут `RAS_PARSER_PREFLIGHT_TIMEOUT_MS` (8с по умолчанию).
- Классификация: `ok` если 2xx и body содержит RAS-маркеры (`b-form-submit` / `Картотека арбитражных`); иначе `banned`/`timeout`/`net`/`auth`.
- Если probe `ok=false` — пропускаем Chromium-goto (он бы повис на 45с) и сразу зовём `_recoverFrom("preflight:<kind>")`. Эскалатор крутит IP/operator/geo, на следующей итерации probe снова.
- ENV: `RAS_PARSER_PREFLIGHT` (1/0), `RAS_PARSER_PREFLIGHT_TIMEOUT_MS`.

**Почему не используем `pdf/proxyHealth.js`**: тот ходит через MobileProxy anti-cloak API батчем по странам (30-60с), нужен для PDF-пула чтобы выбрать стартовую страну. Для parser.js (1 прокси, 1 контекст) хватает голого GET через текущий туннель.

**Почему не вынесли всю сетевую логику в `network_parser/`**: shared-код уже в `network/` (`escalator.js`, `proxyClient.js`, `config.js`, `proxyPreflight.js`); PDF-специфика (`proxyHealth.js`, `httpPdfFetch.js`, `requestRouting.js`) — в `pdf/`. Структура устаканилась, переименование папок ради переименования = churn без пользы.

## Watchdog «тишины» в parser.js + supervisor

`parser.js` имеет один Playwright-контекст и один прокси. Если что-то залипает немо (Playwright потерял ответ, jQuery-callback не дёрнулся, зомби-await на Network) — у нет внутреннего пула, чтобы переключиться, как в pdf-пайплайне. Защита: глобальный watchdog по тишине в логах.

- Каждое сообщение `log()` обновляет `_lastProgressAt`.
- `setInterval(RAS_WATCHDOG_INTERVAL_MS, 30s)` сверяет: если `now - _lastProgressAt > RAS_WATCHDOG_STUCK_MS` (по умолчанию 5 мин) — пишет diagnostic dump в stderr (последние 10 HTTP-ответов) и делает `process.exit(73)`. graceful shutdown НЕ дёргаем — `context.close()` может сам залипнуть.
- Запускай через `npm start` — bash-обёртка (`scripts/run-parser-supervised.sh`) рестартит парсер при ненулевых exit-кодах (включая 73), но НЕ рестартит при `0` / `130` (Ctrl+C) / `143` (SIGTERM). Сигналы Ctrl+C/SIGTERM пробрасывает в node, чтобы не оставлять зомби-Chromium. Чтобы запустить parser.js напрямую (без рестартов, для отладки): `node --env-file=.env parser.js`.
- ENV: `RAS_WATCHDOG_STUCK_MS`, `RAS_WATCHDOG_INTERVAL_MS`, `RAS_PARSER_RESTART_DELAY_SEC`, `RAS_PARSER_MAX_RESTARTS` — см. `.env.example`.

**Почему НЕ скопировали pdf-quarantine целиком**: у parser.js один proxy_key и один Playwright-контекст, per-key карантин не имеет смысла (карантинить нечего, выбора нет). Эскалатор IP→operator→geo уже делает recovery когда вызван явно (`_recoverFrom`); watchdog добавляет защиту для случаев когда ни один error-handler не сработал.

## PDF pipeline — operational notes

- **Карантин per `proxy_key`** (`pdf/proxyQuarantine.js`): сбойный прокси (туннель не открывается / RAS отдаёт 451) уходит в cooldown, воркер засыпает, очередь разгребают здоровые воркеры. In-memory, рестарт процесса = чистый старт. Параметры — `RAS_PDF_QUARANTINE_*` в `.env.example`.
- **Если ВСЕ воркеры в карантине** — пайплайн просто ждёт, в логе будет одна строка `[pdf/quarantine] all_workers_sleeping active=0 quarantined=N`. Это **нормальное** поведение: воркеры спят, очередь не молотится, ничего не теряется. Когда первый воркер выйдет — `[pdf/quarantine] proxy=… released` и работа возобновится.
- **Если такая ситуация повторяется регулярно** — проблема не в downloader'е, а в `proxy pool`: твои купленные MobileProxy линии битые/в бане. Что делать: `npm run proxy:list` посмотреть состояние, потом `npm run proxy:operator` / `npm run proxy:geo` чтобы прокрутить оператора/гео, или докупить новые (`RAS_AUTO_BUY_PROXIES=1`).
- **Дефолт `RAS_PDF_PARALLEL_DOWNLOADERS`** — оставляем ручной настройкой (значение из `.env`). `auto` (= все прокси аккаунта) НЕ включаем по умолчанию.
- **Для диагностики живьём** запускать с консервативными HTTP-параметрами, чтобы не маскировать события прокси-уровня шумом ретраев:
  ```
  RAS_PDF_HTTP_CONCURRENCY=1
  RAS_PDF_HTTP_MAX_ATTEMPTS=1
  RAS_PDF_HTTP_TIMEOUT_MS=20000
  RAS_PDF_MAX_RUN=10
  ```
- Smoke-тест quarantine-логики: `npm run test:quarantine-smoke` (детерминированный, без сети/PG/прокси).

## Открытые задачи

1. ~~Двухуровневый фильтр в parser.js.~~ Сделано (`_isFinalMotivatedAct`, `_resolveInstanceLevel`).
2. ~~Сток в Postgres.~~ Сделано (единая таблица `acts`, `db/schema.sql`, `db/pgClient.js`, `db/actsRepo.js`).
3. Опционально: сплит по судам для cap-дней (мульти-селект «Суд» в UI) — добрать хвосты «горячих» дней.
4. RAG-пайплайн дальше: PDF-loader (есть рабочий PoC по pravocaptcha + salto, не в репо — отдельным сервисом), extractor (pdftotext / OCR) пока не написан, эмбеддинги Jina v4 → Qdrant — отдельный сервис.
