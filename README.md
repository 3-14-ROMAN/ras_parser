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
cp .env.example .env   # заполни
```

В `.env` обязательные ключи:

- `MP_API_TOKEN` — API token MobileProxy.Space.
- `MP_PROXY_KEY` — `proxy_key` из дашборда (для `changeIp` и резолва `proxy_id`).
- `MP_PROXY_USER`, `MP_PROXY_PASS` — креды HTTP-прокси для Chromium.

Опциональное — см. `.env.example`.

## Запуск

```bash
npm start
```

(под капотом `node --env-file=.env parser.js`)

При старте парсер интерактивно спросит:

1. Headless или с окном.
2. Режим: `types` или `decision_links`.
3. Фильтр 3.1 (поставки), фильтр статуса, фильтр РАК.
4. Список `TypeId` (для `decision_links`).
5. Циклы (`0` или Enter — без лимита).
6. Дата «до» (правый край первого окна) и дата «с» (нижняя граница).

Любой ответ можно зафиксировать через env (`RAS_MODE`, `RAS_CYCLES`, `RAS_DATE_TO`, `RAS_DATE_FROM`, `RAS_SUPPLY_FILTER_31`, `RAS_STATUS_FINISHED_ONLY`, `RAS_DOC_FILTER_RAK`, `RAS_TARGET_TYPE_IDS`, `RAS_HEADLESS`).

### С графикой через VNC (на сервере)

```bash
sudo apt install -y xvfb x11vnc fluxbox
RAS_HEADLESS=0 scripts/start_visible_parser.sh
```

С локального ноутбука: `ssh -L 5900:127.0.0.1:5900 user@server` → VNC-клиентом на `127.0.0.1:5900`.

## Результаты

- `parsed_data/document_types.json` — `{ "Имя типа": "uuid" }`. Дописывается инкрементально.
- `parsed_data/decision_links_NNNN.json` — chunks по 3000 записей. Каждая запись: `link/pdfLink/cardLink/typeId/typeName/id/caseId/fileName/registrationDate/displayDate/metadata`.
- `debug/` пересоздаётся при запуске: `debug_page.png`, `debug_page.html`, `debug_responses.txt`.

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
├── parser.js            # основной поток: сессия /Search, пагинация, recovery
├── stealthManager.js    # тонкая обёртка над Playwright Page (smartWait/click/type)
├── network/
│   ├── config.js        # env + GEO_FILTERS
│   ├── proxyClient.js   # @mobileproxy/sdk + rate-limit + rotateIp/changeOperator/changeGeo
│   ├── escalator.js     # циклическая лестница L1→L2→L3→L1
│   └── loadEnv.js       # автозагрузка .env
├── scripts/
│   ├── mp-proxy-api.js          # CLI для ручных операций над прокси
│   └── start_visible_parser.sh  # Xvfb + fluxbox + x11vnc + parser
├── parsed_data/         # результаты
└── debug/               # артефакты последнего прогона
```

## Типичные проблемы

- **`Executable doesn't exist`** — `npx playwright install chromium` не выполнен. На не-Linux: `RAS_CHROME=/path`.
- **`ERR_TUNNEL_CONNECTION_FAILED` подряд** — прокси не отвечает или старый Chromium. Поставь свежий: `npx playwright install chromium`.
- **`/Search` не ловится 60с** — смотри `debug/debug_page.png` и `debug/debug_responses.txt`. Парсер сам зовёт `_recoverFrom` и переоткрывает главную.
- **`[filter] фильтр 3.1 не применился`** — UI-клик по пункту 3.1 промахнулся; есть retry+fallback через нативный `<select>`. Если падает все попытки — смотри HTML дамп.
- **`Too many lonely requests`** от провайдера — баг в rate-limiter'е `proxyClient.js`. Лог `[mp/rl]` подскажет.
- **`MP_API_TOKEN обязателен`** на старте — в `.env` не задан токен.
