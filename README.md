# ras_parser (Node.js)

Сбор справочника `DocumentType` с [ras.arbitr.ru](https://ras.arbitr.ru/) через Playwright + мобильный прокси с ротацией IP.

Логика:
1. Поднимается Chromium с прокси (`config.js`).
2. Открывается `ras.arbitr.ru`, ждём JS/jQuery/fingerprint.
3. Кликаем «Найти», ловим первый POST `/Search`, сохраняем `url + headers + body`.
4. Дальше сами шлём `page.request.post(...)` для страниц 2..40 (тот же body, меняем `Page`, `DateFrom`, `DateTo`).
5. Из каждого item достаём `TypeId` / `Type` и инкрементально пишем в `document_types.json`.
6. Сетевые фейлы разбираются в два слоя:
   - **Flap прокси-туннеля** (`ERR_EMPTY_RESPONSE` / `ERR_TUNNEL_CONNECTION_FAILED` и т.п.) — короткий backoff `smartWait('proxy_flap')` и ретрай на том же IP (новый IP сломанный туннель не чинит). При 5 флапах подряд — эскалация с `kind='net_down'`.
   - **HTTP-бан** (`403/429/5xx`, sentinel-нет, тихий бан) — эскалация с `kind='banned'`. **changeGeo (платная смена региона) НЕ запускается** — только `changeIp` и `changeOperator` в текущем гео. Смотри «Политика смены региона» ниже.
   - **Реальный отвал сети** (`ERR_CONNECTION_RESET`, `timeout`, Playwright-таймаут goto, `ECONNRESET`) — эскалация с `kind='net_down'`. Полная лестница: `changeIp` → `changeOperator` → `changeGeo` (RU-only, под `GEO_*`-фильтрами).
   - Когда жёсткие лимиты исчерпаны — кидаем `EscalationExhausted` и завершаем прогон (страховка от вечного цикла).

---

## Требования

- **Node.js >= 20** (нужен встроенный `fetch` и `AbortSignal.timeout`).
- Linux: автодетект бинаря Chromium заточен под `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`. На macOS/Windows придётся задать путь руками через `RAS_CHROME=/path/to/chrome`.

Проверить:
```bash
node --version
```

---

## Установка

```bash
cd /home/roman/ras_parser
npm install
npx playwright install chromium
cp .env.example .env   # и заполни значения
```

`npm install` поставит `playwright`, `@mobileproxy/sdk`, `ghost-cursor`. `npx playwright install chromium` скачает сам браузер в `~/.cache/ms-playwright/`.

В `.env` **обязательно** (в коде больше нет fallback-значений с реальными кредами):
- `MP_PROXY_KEY` — `proxy_key` из дашборда. Нужен и для `changeIp` (rotation endpoint), и для резолва `proxy_id` через `getMyProxy()`. Без него **не будет работать даже legacy-ротация** — `CHANGE_IP_URL` просто не соберётся.
- `MP_PROXY_USER`, `MP_PROXY_PASS` — креды HTTP-прокси, который ставится в Chromium.
- `MP_API_TOKEN` — API token MobileProxy.Space. Без него отключается эскалация до `changeEquipment`, остаётся только L1 (legacy-ротация IP через `CHANGE_IP_URL`).

Опционально:
- `MP_PROXY_SERVER` — дефолт `http://mproxy.site:12695`.
- `MP_PROXY_ID` — если знаешь `proxy_id` заранее, можно не дёргать `getMyProxy()` на старте.
- `GEO_RU_ONLY`, `GEO_BLOCK_CITY_IDS`, `GEO_BLOCK_CAPTION_REGEX` — фильтры для `changeGeo` (чтобы не уехать обратно в Москву/СПб/миллионники, где у провайдера стоит ACL на `*.arbitr.ru`). Подробности и дефолты — в `.env.example`.

---

## Запуск

### Самый простой способ

```bash
npm start
```

(под капотом `node --env-file=.env parser.js`).

или, если уже экспортировал переменные руками:

```bash
node parser.js
```

Скрипт спросит в консоли:
```
Сколько циклов прогнать (например 1 или 200):
```

Введи число (например `1` для тестового прогона) — поехали.

### С параметрами через env

```bash
RAS_CYCLES=200 RAS_WINDOW_DAYS=1 RAS_START_DATE=03.05.2026 node parser.js
```

Поддерживаемые env-переменные:

| Переменная | По умолчанию | Что значит |
|---|---|---|
| `RAS_CYCLES` | спросит руками | сколько циклов прогнать (1 цикл = 1 успешное окно с непустыми данными) |
| `RAS_WINDOW_DAYS` | `1` | размер окна в днях для одного цикла |
| `RAS_START_DATE` | сегодня | стартовая дата окна в формате `DD.MM.YYYY`, дальше идём назад по времени |
| `RAS_HEADLESS` | `1` | `0` — показать окно браузера (удобно для отладки) |
| `RAS_CHROME` | автодетект | путь к конкретному `chrome` бинарю, если автодетект ошибается |

### Показать браузер (отладка)

```bash
RAS_HEADLESS=0 node parser.js
```

---

## Результаты

- `document_types.json` — собранный справочник `{ "Имя типа": "uuid" }`. Файл инкрементально дополняется между запусками, не затирается.
- `debug/` — пересоздаётся при каждом запуске:
  - `debug_page.png` — скриншот после ожидания ответа
  - `debug_page.html` — HTML страницы
  - `debug_responses.txt` — лог всех XHR/fetch/document запросов и фейлов
  - `debug/search/NNN_<label>.bin|json` — сырые тела всех ответов `/Search` и тело первого запроса

---

## Прокси, ротация IP и эскалация до смены оборудования

Настройки идут из env (см. `.env.example`):

```env
MP_API_TOKEN=...                 # API token MobileProxy.Space
MP_PROXY_KEY=...                 # proxy_key из дашборда
MP_PROXY_SERVER=http://...:NNN
MP_PROXY_USER=...
MP_PROXY_PASS=...
MP_CHANGE_IP_COOLDOWN_SEC=15

ESC_MAX_IP_BEFORE_EQUIPMENT=8    # changeIp подряд до changeOperator
ESC_MAX_OPERATOR_BEFORE_GEO=2    # changeOperator (в том же гео) до changeGeo
ESC_MAX_GEO_SWAPS=5              # потолок changeGeo на весь прогон
ESC_MAX_TOTAL_FAILURES=40        # суммарный потолок recoverFrom
ESC_MAX_BUDGET_SEC=3600          # таймбюджет работы эскалатора
```

Браузер ходит через `MP_PROXY_SERVER`. На сетевой ошибке / бане / таймауте парсер зовёт `_recoverFrom(reason, { kind })`, где `kind` определяет, что эскалатору разрешено делать:

| Уровень | Что делает | Когда уходим выше |
|---|---|---|
| L1 — `changeIp` | rotation endpoint (без API rate-limit, но с hard-cooldown `MP_CHANGE_IP_COOLDOWN_SEC`), settle через `smartWait('ip_cooldown')` | после `ESC_MAX_IP_BEFORE_EQUIPMENT` подряд |
| L2 — `changeOperator` | `change_equipment` СТРОГО в текущем geoid (никаких слепых фоллбеков на «любое другое eid» — раньше такой фоллбек мог тихо увезти SIM в другой регион). Если в текущем гео нет альтернативного оператора — `ok:false reason='no-same-geo-operator'`, и эскалатор уходит выше. Settle через `smartWait('equipment_swap')` | после `ESC_MAX_OPERATOR_BEFORE_GEO` подряд |
| L3 — `changeGeo` | `change_equipment` с другим `geoid` под `GEO_*`-фильтрами (RU-only). **Запускается ТОЛЬКО при `kind='net_down'`** — см. «Политика смены региона» | после `ESC_MAX_GEO_SWAPS` за прогон |
| STOP | бросаем `EscalationExhausted`, прогон завершается с понятным саммари в логах | — |

Также:
- На каждый успешный шаг `consecutiveIpRotations` сбрасывается → следующий цикл атак снова начинается с дешёвого `changeIp`.
- После смены гео сбрасывается операторный счётчик внутри гео.
- `MP_CHANGE_IP_COOLDOWN_SEC` — hard-cooldown между двумя `changeIp`.
- `ESC_MAX_BUDGET_SEC` и `ESC_MAX_TOTAL_FAILURES` — две независимые страховки от бесконечности.

### Политика смены региона (`changeGeo`) — платно у провайдера

У провайдера mobileproxy.space смена региона (а не просто SIM или IP) — **платная** операция. Поэтому в эскалаторе она строго гейтится через `kind`:

| `kind` | Когда передаётся | L3 changeGeo разрешён? |
|---|---|---|
| `'banned'` | HTTP 403/429/5xx, sentinel не найден, тихий бан (страница загрузилась, JS не отработал) | **НЕТ.** Эскалатор использует только L1 и L2 в текущем гео. После исчерпания обоих кидает `EscalationExhausted` с явным сообщением «changeGeo ПОЛИТИКОЙ ЗАПРЕЩЁН» |
| `'net_down'` | `ERR_CONNECTION_RESET/REFUSED/TIMED_OUT`, Playwright-таймаут goto, `ECONNRESET/ETIMEDOUT`, **5+ флапов прокси-туннеля подряд** (включая ACL у провайдера) | **ДА**, но всё равно сначала отрабатывает L1 (changeIp). L3 запускается только когда L1+L2 в текущем гео исчерпаны и `totalGeoSwaps < ESC_MAX_GEO_SWAPS`. RU-only через `GEO_FILTERS` |

Дополнительно `ProxyEscalator.recoverFrom` на невалидный `kind` (опечатка) кидает явный `Error` — никаких немых деградаций до дефолта.

### Flap прокси-туннеля vs бан

Между сетевыми ошибками `parser.js` различает:

- **`proxy_flap`** (`ERR_EMPTY_RESPONSE`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_CONNECTION_CLOSED/ABORTED` и т.п.) — HTTP-CONNECT к прокси сорвался, это шум апстрима провайдера. Новый IP не починит. Делаем `smartWait('proxy_flap')` (короткий backoff 0.8..2.5с с хвостами) и ретраим **на том же IP**. Эскалация (`_recoverFrom('net_down')`) запускается только если флапов подряд набралось `PROXY_FLAP_ROTATE_AFTER` (5).
- **`proxy/net`** (`ERR_CONNECTION_RESET/REFUSED/TIMED_OUT`, Playwright-таймауты, `ECONNRESET/ETIMEDOUT/ENETUNREACH`) — это уже либо сайт нас режет, либо сеть умерла. Сразу в эскалатор с `kind='net_down'`.
- **`banned`** — HTTP-уровень: 403, 429, 500..525. В эскалатор с `kind='banned'` — без права на changeGeo.

### ACL у провайдера (CONNECT 403)

У `mobileproxy.space` часть SIM-ок сидит в ACL-чёрном списке по hostname `*.arbitr.ru` (чаще всего — Москва/СПб/миллионники). На таких SIM провайдер отвечает `HTTP 403 "Access control list denies you"` на сам CONNECT, и Chromium это видит одинаково с обычным флапом как `ERR_TUNNEL_CONNECTION_FAILED`.

Раньше при детекте ACL парсер делал «fast-track» сразу в L3 `changeGeo`, минуя L1/L2 — это было удобно, но **обходило политику пользователя про платную смену региона**. Сейчас fast-track ВЫКЛЮЧЕН: при каждом `proxy_flap` мы делаем «голый» CONNECT к прокси (`_diagnoseProxyAcl`) **только для лога** (закешировано на 30с), а сама эскалация идёт обычным путём — после 5+ флапов подряд через `_recoverFrom('net_down')` доходим по лестнице L1 → L2 → L3. То есть changeIp пробуем первым, потом меняем SIM в том же гео, и только если ничего не помогло — едем менять регион. Фильтры `GEO_*` из `.env` применяются на L3, чтобы случайно не «переехать» в очередной заблокированный/московский город.

### Rate-limit на API провайдера

`proxyClient.js` сам соблюдает лимиты MobileProxy:
- 1 одинаковый запрос (по сигнатуре `command + args`) не чаще раза в 5 сек (защищает от `"Too many lonely requests. Timeout 5 second"`).
- 3 × N запросов/сек суммарно, где N = число активных прокси (резолвится через `getMyProxy()` лениво при первом вызове).
- `RateLimitError` от провайдера ловится один раз с backoff 7 сек и retry.
- `changeIp` (rotation endpoint) идёт мимо общего бакета — у него по доке провайдера лимита частоты нет.

### Если `MP_API_TOKEN` не задан

Эскалатор не включается, `_recoverFrom` фоллбекается на `fetch(CHANGE_IP_URL)` (только L1, без смены оборудования/гео). Для этого фоллбека всё равно **нужен `MP_PROXY_KEY`** — без него `CHANGE_IP_URL` пустой и legacy-ротация сразу вернёт `false`, то есть ни ip, ни оборудование менять будет нечем, и парсер сможет только честно лезть на сайт без какой-либо реакции на бан.

---

## Структура

```
ras_parser/
├── parser.js           # основной скрипт: сессия /Search, пагинация, proxy_flap/ACL
├── stealthManager.js   # антифрод-обёртка вокруг Playwright Page (smartWait/click/type)
├── proxyClient.js      # обёртка над @mobileproxy/sdk + rate-limit + resolve proxy_id
├── escalator.js        # лестница changeIp → changeOperator → changeGeo + лимиты
├── config.js           # читает env, экспортирует константы (секретов в коде нет)
├── test_escalator.js   # юнит-тесты эскалатора (без сети)
├── .env.example        # шаблон env, закоммичен
├── .env                # реальные секреты, в .gitignore
├── package.json        # deps: playwright, ghost-cursor, @mobileproxy/sdk
├── document_types.json # результат (инкрементально)
└── debug/              # артефакты последнего прогона
    ├── debug_page.png
    ├── debug_page.html
    ├── debug_responses.txt
    └── search/         # сырые ответы /Search
```

## Тесты

```bash
npm test
```

Запускает `test_escalator.js` — 8 юнит-тестов с замоканным `proxyClient`:
- `test_ladder_terminates` — при `kind='net_down'` и «провайдер ничего не помогает» эскалатор за **28 шагов** с дефолтными лимитами кидает `EscalationExhausted` (никакой бесконечности).
- `test_recovery_after_success` — `noteSuccess` корректно сбрасывает `consecutiveIp`, следующая итерация снова идёт через дешёвый `changeIp`. Заодно проверяет, что дефолтный `kind` — `'banned'`.
- `test_time_budget` — превышение `ESC_MAX_BUDGET_SEC` тоже отрубает цикл.
- `test_total_failures_cap` — независимый ограничитель по числу попыток.
- `test_stealth_wait_buckets` — после `changeIp` settle идёт через `'ip_cooldown'`, после `changeEquipment` — через `'equipment_swap'`.
- **`test_banned_never_changes_geo`** — на `kind='banned'` эскалатор НИКОГДА не зовёт `changeGeo`, после исчерпания L1+L2 кидает `EscalationExhausted` с явным сообщением про политику.
- **`test_net_down_tries_ip_first`** — на `kind='net_down'` первый же провал идёт в L1 `changeIp`, не в L3, даже если бюджет на geo не исчерпан.
- **`test_invalid_kind_throws`** — опечатка в `kind` ловится явной `Error`, без немой деградации.

Тесты не делают сетевых запросов и работают за ~0.3 секунды.

---

## Типичные проблемы

- **`Executable doesn't exist at ...`** — не выполнил `npx playwright install chromium`. На не-Linux задай `RAS_CHROME=/path/to/chrome`.
- **`ERR_TUNNEL_CONNECTION_FAILED`** подряд и много — прокси не отвечает или старый бинарь Chromium. Поставь свежий: `npx playwright install chromium` (скрипт сам выберет самый свежий `chromium-*` из кеша). Единичные флапы — штатный `proxy_flap`, парсер сам переживает.
- **В логах `[acl] CONNECT ... → 403`** — на текущей SIM провайдер забанил hostname арбитра. Сейчас это **только лог**, fast-track в `changeGeo` отключён по политике «менять регион — последнее средство, и только при отвале сети». Парсер дойдёт до `changeGeo` сам через лестницу: 5+ флапов подряд → `_recoverFrom('net_down')` → `changeIp` × `ESC_MAX_IP_BEFORE_EQUIPMENT` → `changeOperator` (в том же гео) × `ESC_MAX_OPERATOR_BEFORE_GEO` → `changeGeo` под `GEO_*`-фильтрами. Если под фильтр не подходит ни одно гео — увидишь `no-allowed-geo`, расширяй `GEO_BLOCK_CAPTION_REGEX`/`GEO_BLOCK_CITY_IDS` в `.env`.
- **В логах `[esc] ... changeGeo ПОЛИТИКОЙ ЗАПРЕЩЁН ...`** — мы уперлись в HTTP-бан (`kind='banned'`), `changeIp` × N и `changeOperator` × M не помогли, политика не разрешает платную смену региона на просто HTTP-бане. Если уверен, что бан реально требует смены гео — рестартни парсер (он начнёт новый прогон, бан-IP может за это время отлежаться) или поправь логику классификации `_isLikelyBanned`/`_isRotatableNetworkError` в `parser.js`.
- **`/Search` не ловится 60 секунд** — посмотри `debug/debug_page.png` и `debug/debug_responses.txt`. Часто помогает `RAS_HEADLESS=0` чтобы глазами увидеть, что происходит. Если сессия так и не поднялась — парсер сам зовёт `_recoverFrom` и переоткрывает главную (до 5 попыток).
- **Запрос есть, но `Result=null`** — окно дат пустое, скрипт идёт назад. Если 60 пустых подряд — останавливается.
- **`[escalator] исчерпан: ...`** — эскалатор выгреб все ip+operator+geo и не вытащил нас из бана. В логе будет summary с числом шагов. Стоит проверить `getBalance` (есть ли что менять оборудование на), доступность других гео в дашборде MobileProxy и поднять `ESC_MAX_*` лимиты, если думаешь, что просто нужно больше попыток.
- **`Too many lonely requests`** или **`Too many requests per second`** от провайдера — значит баг в `proxyClient.js`-rate-limiter'е. Открой issue, в `_call` есть детальные логи `[mp/rl]`.
- **`RasProxyClient: proxyKey is required`** на старте — забыл заполнить `MP_PROXY_KEY` в `.env` (в коде больше нет hardcoded fallback).
