# ras_parser

Сбор PDF-ссылок на решения и справочника `DocumentType` с [ras.arbitr.ru](https://ras.arbitr.ru/) через Playwright + мобильный прокси с ротацией IP/оборудования/гео.

## Логика

1. Chromium через `MP_PROXY_SERVER` идёт на `ras.arbitr.ru`.
2. Применяются фильтры: категория 3.1 (поставки), период `DateFrom/DateTo`, опционально РАК (Тип документа) и «Только завершённые».
3. Кликается «Найти» → ловится первый POST `/Search`, сохраняется его url/headers/body.
4. Страницы 2..40 идут прямым `page.request.post(url, body)` — без UI-кликов по пейджеру.
5. Из items парсера достаются `TypeId`/`Type` (mode `types`) или PDF-ссылки (mode `decision_links`).
6. На бан/таймаут/флап — `ProxyEscalator.recoverFrom`: циклическая лестница `changeIp → changeOperator → changeGeo → changeIp ...` с cooldown'ами.

## Требования

- Node.js ≥ 20 (нужны встроенный `fetch` и `AbortSignal.timeout`).
- На Linux Chromium берётся из `~/.cache/ms-playwright/chromium-*/`. На macOS/Windows укажи `RAS_CHROME=/path/to/chrome`.

## Установка

```bash
cd /home/roman/ras_parser
npm install
npx playwright install chromium
cp .env.example .env   # заполни (MP_*, RAS_PG_DSN или DATABASE_URL)

# Postgres через docker-compose, datadir на /data/postgres:
docker compose up -d postgres
npm run db:migrate     # прокат db/schema.sql (создаёт таблицу acts)
```

В `.env` обязательные ключи:

- `MP_API_TOKEN` — API token MobileProxy.Space.
- `MP_PROXY_KEY` — `proxy_key` из дашборда (для `changeIp` и резолва `proxy_id`).
- `MP_PROXY_USER`, `MP_PROXY_PASS` — креды HTTP-прокси для Chromium.
- `RAS_PG_DSN` (или `DATABASE_URL`) — DSN Postgres, обязателен для `RAS_MODE=acts`.

Опциональное — см. `.env.example`.

## Запуск

```bash
npm start
```

(под капотом `bash scripts/run-parser-supervised.sh` — supervisor с авто-рестартом при ненулевых exit-кодах, включая `73` от watchdog'а «тишины». Чтобы запустить parser.js напрямую без рестартов — `node --env-file=.env parser.js`.)

При старте парсер интерактивно спросит:

1. Headless или с окном.
2. Режим: `types` (справочник DocumentType) или `acts` (PDF-ссылки + метаданные в Postgres).
3. Фильтр 3.1 (поставки), фильтр статуса, фильтр РАК.
4. Список `TypeId` (для режима `acts`).
5. Циклы (`0` или Enter — без лимита).
6. Дата «до» (правый край первого окна) и дата «с» (нижняя граница).

Любой ответ можно зафиксировать через env (`RAS_MODE`, `RAS_CYCLES`, `RAS_DATE_TO`, `RAS_DATE_FROM`, `RAS_SUPPLY_FILTER_31`, `RAS_STATUS_FINISHED_ONLY`, `RAS_DOC_FILTER_RAK`, `RAS_TARGET_TYPE_IDS`, `RAS_HEADLESS`). `RAS_MODE=acts` и `RAS_MODE=decision_links` принимаются как алиасы.

### С графикой через VNC (на сервере)

```bash
sudo apt install -y xvfb x11vnc fluxbox
RAS_HEADLESS=0 scripts/start_visible_parser.sh
```

С локального ноутбука: `ssh -L 5900:127.0.0.1:5900 user@server` → VNC-клиентом на `127.0.0.1:5900`.

## Результаты

- Режим `acts` — единственный продакшн-sink — Postgres, таблица `acts` (см. `db/schema.sql`). Одна строка = один судебный акт: все поля из item /Search + `verdict_*` + состояние RAG-пайплайна (`pdf_downloaded`, `act_text`, `vector_indexed`, `qdrant_point_id`). Upsert по PK `id`, инкрементальный (батчи по 1000, `ON CONFLICT (id) DO UPDATE`).
- Режим `types` — `parsed_data/document_types.json` (`{ "Имя типа": "uuid" }`), дописывается инкрементально.
- `debug/` пересоздаётся при запуске для артефактов первой сессии: `debug_page.png`, `debug_page.html`, `debug_responses.txt`.

## PDF download + extract (RAG-пайплайн)

Отдельный CLI `scripts/download-acts.js` — для финальной стадии RAG: качает PDF-ы с `kad.arbitr.ru` и заливает чистый текст в `acts.act_text` для дальнейшей выдачи в эмбеддинговую модель.

```bash
npm run download:acts                                      # все verdict_keep=TRUE, не скачанные
npm run download:acts -- --workdir /custom/path
npm run download:acts -- --ids 11111111-...,22222222-...   # точечный re-download / smoke
```

Архитектура:
- **N параллельных download-воркеров (multi-IP пул).** На старте `download-acts.js` дёргает `getMyProxy()` через `MP_API_TOKEN` и поднимает по одному Chromium-инстансу на каждый активный прокси аккаунта. У каждого свой `proxy_key` + `proxy_id` + персональный `userDataDir` + независимый `RasProxyClient` для `changeIp` (rate-limit per-proxy_key, ddos-guard kad — per-IP). 4 прокси = 4 параллельных воркера ≈ ×4 скорость скачивания. Pравоcaptcha снимается warmup-цепочкой `ras.arbitr.ru → kad.arbitr.ru/ → kad/Card/<caseId>` (по fingerprint, без человека). Salto-challenge (`network/saltoDecoder.js`) — обфусцированный JS на `/Document/Pdf/...`, парсится и считается hash в `page.evaluate`. Случайная пауза ~0.22–0.52 с между успешными PDF на каждый воркер (свой IP); после фейла на уровне пайплайна — короче (`RAS_PDF_PAUSE_FAIL_*`).
- **Auto-discover прокси.** `network/proxyPool.js` достаёт host/port/login/pass для каждого прокси из `getMyProxy()` — ничего конфигурировать руками не надо. Override: `RAS_PDF_PARALLEL_DOWNLOADERS=N` (cap), `MP_PROXY_KEYS=key1,key2` (whitelist). Если `MP_API_TOKEN` пустой — fallback на single-proxy режим из `MP_PROXY_SERVER/USER/PASS` (обратная совместимость).
- **N=6 параллельных extract-воркеров (default).** `pdftotext -layout -enc UTF-8 -nopgbrk`. Bounded in-memory queue (`RAS_PDF_QUEUE_BUFFER=32`) даёт мягкий backpressure: если экстракт тормозит — downloader сам притормаживает.
- **Resume через БД.** `pdf_downloaded=TRUE` ставится сразу после `fs.writeFile`, до экстракта. Падение посередине → следующий прогон сначала добивает `pdf_downloaded=TRUE AND act_text IS NULL` (selectPendingText), потом продолжает download. PDF лежат в `/data/ras_pdf/<id>.pdf` (227 GB свободно на `/dev/nvme0n1p2`).
- **Shared-claim queue.** Все воркеры тянут акты из общего `SharedActQueue` через атомарный `claimNext()` — гонок на конкретный `id` нет (JS-event-loop сериализует await'ы). При исчерпании очередь сама пополняется батчем из БД (`RAS_PDF_BATCH=320`).
- **Headless: NO по умолчанию.** Pravoсaptcha проверяет canvas-fingerprint, headless chromium иногда срывается на image-captcha. `npm run download:acts` оборачивает запуск в `xvfb-run` — все N Chromium'ов сидят на одном виртуальном DISPLAY. Если в твоей среде headless проходит — `RAS_PDF_HEADLESS=1` или `npm run download:acts:headless`.
- **429 / rate-limit per-worker.** При 429 от ddos-guard воркер вызывает `RasProxyClient.rotateIp()` для СВОЕГО прокси и re-warmup, остальные продолжают качать. Cooldown ротации 120с — per-proxy_key.

Тюнинг через `.env` (раздел `RAS_PDF_*`): `RAS_PDF_DIR`, `RAS_PDF_PARALLEL_DOWNLOADERS`, `MP_PROXY_KEYS`, `RAS_PDF_EXTRACT_WORKERS`, `RAS_PDF_QUEUE_BUFFER`, `RAS_PDF_BATCH`, `RAS_PDF_MAX_RUN`, `RAS_PDF_MAX_ATTEMPTS`, `RAS_PDF_PAUSE_MIN_MS`, `RAS_PDF_PAUSE_MAX_MS`, `RAS_PDF_PAUSE_FAIL_MIN_MS`, `RAS_PDF_PAUSE_FAIL_MAX_MS`, `RAS_PDF_PRAVO_WAIT_MS`, `RAS_PDF_PRAVO_AFTER_CARD_MS`, `RAS_PDF_KEEP_FILE`. Полный список с дефолтами — `.env.example`.

**Авто-покупка прокси** (тратит реальные деньги аккаунта, OFF по умолчанию). При `RAS_AUTO_BUY_PROXIES=1` пайплайн на старте дёргает `getBalance()` + `getPrices(countryId)`, вычисляет `floor(balance / price)` и через `buyProxy({num})` покупает `min(влезает в баланс, RAS_AUTO_BUY_MAX_COUNT - текущих)` штук. Параметры: `RAS_AUTO_BUY_MAX_COUNT` (cap общего числа прокси, default 10), `RAS_AUTO_BUY_PERIOD_DAYS` (1 — самый дешёвый тариф), `RAS_AUTO_BUY_COUNTRY_ID` (если пусто — клонирует страну существующего прокси, или Кыргызстан как safe default). Несовместимо с `MP_PROXY_KEYS` whitelist'ом — там фича пропускается, чтобы не путаться, кого считать «уже купленным».

Зависимости: `pdftotext` (poppler-utils) и `xvfb-run` уже стоят в системе. Если переустанавливаешь — `sudo apt install poppler-utils xvfb`.

### Координация прокси между процессами (`proxy_leases`)

Каждый запуск (parser.js / download:acts) атомарно берёт `proxy_key` в Postgres-таблице `proxy_leases` с TTL ~5 мин, продлевает heartbeat'ом раз в ~60с, освобождает на graceful shutdown. На SIGKILL / OOM lease переживает процесс — поэтому:

- `RAS_PDF_LEASE_CLEANUP_ON_START=1` (default) — перед стартом downloader снимает **expired-global** (TTL прошёл, безопасно) и **dead-local** (`pid` мёртв на этом hostname).
- Если новый запуск всё-таки видит «все proxy_key заняты», supervisor:
  1. ещё раз дёргает cleanup;
  2. читает `expires_at` живых аренд и спит до самого позднего (cap `RAS_PDF_POOL_ALL_LEASED_MAX_WAIT_MS=300000`);
  3. пере-пытается **без** инкремента `restartCount` — это не падение, это lease-wait.

CLI для разбора:

```bash
npm run proxy:leases:status              # JSON: this-host / dead-pid / expired
npm run proxy:leases:cleanup             # expired-global + dead-local
node --env-file=.env scripts/proxy-leases.js release-key <full-key>  # ядерное освобождение
```

### Preflight: проверить, в каких странах ras.arbitr.ru реально открывается

Перед запуском `download:acts` стоит прогнать:

```bash
npm run preflight:proxy-health
```

Скрипт через MobileProxy.Space API дёргает `get_my_proxy` + `get_geo_operator_list`, собирает кандидатов в страны (с учётом `RAS_PDF_BAD_COUNTRY_IDS` / `RAS_PDF_TARGET_COUNTRY_IDS`), POST'ит `see_the_url_from_different_IPs` на `https://ras.arbitr.ru/`, polling'ит `tasks`, классифицирует ответы — good = «Поиск по документам / Текст документа / Вид спора / Банк решений / body ≥ 20KB», bad = 451 / 403 / captcha / pravoCaptcha / Forbidden / Access Denied / blocked / empty html. Последняя строка stdout — CSV `id_country` для подстановки:

```bash
RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE=$(npm run --silent preflight:proxy-health | tail -1) \
  npm run download:acts
```

### Smoke-тесты

```bash
npm run smoke:lease           # lease tryAcquire / renew / expired / dead-pid / cleanup (нужен PG)
npm run smoke:proxy-health    # scoring классификатора на фикстурах (без сети)
npm run test:quarantine-smoke # quarantine + worker loop (без сети)
npm run test:probe-classifier # unit-тесты антиклоака
```

## Прокси и эскалация

```env
MP_CHANGE_IP_COOLDOWN_SEC=120     # changeIp не чаще раза в 2 мин
ESC_EQUIPMENT_COOLDOWN_SEC=180    # changeEquipment/changeGeo не чаще раза в 3 мин
MP_CHANGE_GEO_COOLDOWN_SEC=180

ESC_MAX_IP_BEFORE_EQUIPMENT=8     # changeIp подряд до перехода на L2
ESC_MAX_OPERATOR_BEFORE_GEO=2     # changeOperator подряд до перехода на L3
```

При сетевой ошибке/бане парсер зовёт `_recoverFrom(reason)`:

| Уровень | Действие | Когда уходим выше |
|---|---|---|
| L1 `changeIp` | rotation endpoint, cooldown ≥120с | после `ESC_MAX_IP_BEFORE_EQUIPMENT` подряд |
| L2 `changeOperator` | смена SIM в текущем geoid, cooldown ≥180с | после `ESC_MAX_OPERATOR_BEFORE_GEO` подряд |
| L3 `changeGeo` | другой регион под фильтрами `GEO_*`, cooldown ≥180с | после успеха сбрасываем счётчики и снова с L1 |

Лестница циклическая. `EscalationExhausted` в штатном флоу не кидается — парсер рассчитан на месячные прогоны. Все действия у MobileProxy.Space бесплатные, ограничение только по частоте.

После успешного `changeIp` Chromium пересоздаётся (`RAS_RECYCLE_BROWSER_AFTER_BANNED_L1=1` по умолчанию) — иначе сайт сидит со старыми куками и продолжает банить.

### Flap прокси-туннеля vs бан

- **`proxy_flap`** (`ERR_EMPTY_RESPONSE`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_CONNECTION_CLOSED/ABORTED`) — апстрим провайдера, новый IP не лечит. Короткий backoff и retry на том же IP. После 5 флапов подряд — эскалация.
- **`proxy/net`** (`ERR_CONNECTION_RESET/REFUSED/TIMED_OUT`, `ECONNRESET`) — сразу `_recoverFrom`.
- **HTTP-бан** (403, 429, 451, 5xx) — сразу `_recoverFrom`. RAS на «IP в чёрном списке» отдаёт ровно 451 («Доступ заблокирован» с `/static/img/blocked.png`).

### Гео-фильтры

`GEO_*` в `.env` ограничивают выбор `changeGeo`:

- `GEO_RU_ONLY=1` — только Россия.
- `GEO_CIS_ONLY=1` — whitelist по СНГ через `GEO_CIS_CAPTION_REGEX`.
- `GEO_EXCLUDE_COUNTRY_IDS` — id_country, которые запрещены.
- `GEO_BLOCK_CITY_IDS` — id_city не брать (по умолчанию Москва=1, СПб=173).
- `GEO_BLOCK_CAPTION_REGEX` — regexp по `geo_caption` (по умолчанию режет миллионники, т.к. на них чаще всего ACL у RAS).

## Структура

```
ras_parser/
├── parser.js                  # основной поток: сессия /Search, пагинация, recovery, вердикт-резолвер
├── stealthManager.js          # тонкая обёртка над Playwright Page (smartWait/click/type)
├── outcome_polarity.json      # справочник outcome-кодов (action-классификатор)
├── network/
│   ├── config.js              # env + GEO_FILTERS
│   ├── proxyClient.js         # @mobileproxy/sdk + rate-limit + rotateIp/changeOperator/changeGeo
│   ├── escalator.js           # циклическая лестница L1→L2→L3→L1
│   └── loadEnv.js             # автозагрузка .env
├── db/
│   ├── schema.sql             # таблица `acts` (идемпотентная миграция)
│   ├── pgClient.js            # lazy-Pool, accepts RAS_PG_DSN или DATABASE_URL
│   └── actsRepo.js            # батчевый upsert ON CONFLICT (id) DO UPDATE + очередь PDF
├── pdf/
│   ├── downloader.js          # warmup ras→kad→Card + salto-challenge через page.evaluate
│   ├── extractor.js           # pdftotext + лёгкая нормализация
│   └── pipeline.js            # 1 download → N extract воркеров через bounded queue
├── docker-compose.yml         # postgres:16-alpine, datadir /data/postgres
├── scripts/
│   ├── mp-proxy-api.js        # CLI для ручных операций над прокси (npm run proxy:*)
│   ├── download-acts.js       # CLI для PDF-pipeline (npm run download:acts)
│   └── start_visible_parser.sh # Xvfb + fluxbox + x11vnc + parser
└── debug/                     # артефакты последнего прогона (создаётся на старте)
```

## Типичные проблемы

- **`Executable doesn't exist`** — `npx playwright install chromium` не выполнен. На не-Linux: `RAS_CHROME=/path`.
- **`ERR_TUNNEL_CONNECTION_FAILED` подряд** — прокси не отвечает или старый Chromium. Поставь свежий: `npx playwright install chromium`.
- **`/Search` не ловится 60с** — смотри `debug/debug_page.png` и `debug/debug_responses.txt`. Парсер сам зовёт `_recoverFrom` и переоткрывает главную.
- **`[filter] фильтр 3.1 не применился`** — UI-клик по пункту 3.1 промахнулся; есть retry+fallback через нативный `<select>`. Если падает все попытки — смотри HTML дамп.
- **`Too many lonely requests`** от провайдера — баг в rate-limiter'е `proxyClient.js`. Лог `[mp/rl]` подскажет.
- **`MP_API_TOKEN обязателен`** на старте — в `.env` не задан токен.
