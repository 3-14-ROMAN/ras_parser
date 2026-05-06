# ras_parser (Node.js)

Сбор справочника `DocumentType` с [ras.arbitr.ru](https://ras.arbitr.ru/) через Playwright + мобильный прокси с ротацией IP.

Логика:
1. Поднимается Chromium с прокси (`network/config.js`).
2. Открывается `ras.arbitr.ru`, ждём JS/jQuery/fingerprint.
3. Кликаем «Найти», ловим первый POST `/Search`, сохраняем `url + headers + body`.
4. Дальше сами шлём `page.request.post(...)` для страниц 2..40 (тот же body, меняем `Page`, `DateFrom`, `DateTo`).
5. Из каждого item достаём `TypeId` / `Type` и инкрементально пишем в `parsed_data/document_types.json`.
6. Сетевые фейлы разбираются в два слоя:
   - **Flap прокси-туннеля** (`ERR_EMPTY_RESPONSE` / `ERR_TUNNEL_CONNECTION_FAILED` и т.п.) — короткий backoff `smartWait('proxy_flap')` и ретрай на том же IP (новый IP сломанный туннель не чинит). При 5 флапах подряд — эскалация с `kind='net_down'`.
   - **HTTP-бан** (`403/429/451/5xx`, sentinel-нет, тихий бан) — эскалация с `kind='banned'`. **changeGeo (платная смена региона) НЕ запускается** — только `changeIp` и `changeOperator` в текущем гео. Смотри «Политика смены региона» ниже.

> **Страницы НИКОГДА не пропускаются.** В `_walkPagesForBody` нет `continue` по неудаче. Если страница не отдалась за 8 быстрых попыток — парсер крутит следующий «раунд» на той же странице (8 попыток + один `_recoverFrom` если эскалатор за раунд не позвался) и так дальше, пока либо страница не получится, либо эскалатор не выкинет `EscalationExhausted`. Это единственный легитимный способ закончить прогон без данных — он всплывает в `main()`, где аккуратно выводит саммари. Уже собранные данные не теряются: `parsed_data/document_types.json` дописывается инкрементально через `_save()` после каждой успешной страницы.
  - **Реальный отвал сети** (`ERR_CONNECTION_RESET`, `timeout`, Playwright-таймаут goto, `ECONNRESET`) — эскалация с `kind='net_down'`. Полная лестница: `changeIp` → `changeOperator` → `changeGeo` (по `GEO_*`-фильтрам; по умолчанию whitelist СНГ).
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

`npm install` поставит `playwright`, `@mobileproxy/sdk`, `ghost-cursor-playwright`. `npx playwright install chromium` скачает сам браузер в `~/.cache/ms-playwright/`.

В `.env` **обязательно** (в коде больше нет fallback-значений с реальными кредами):
- `MP_PROXY_KEY` — `proxy_key` из дашборда. Нужен для `changeIp` и резолва `proxy_id` через `getMyProxy()`.
- `MP_PROXY_USER`, `MP_PROXY_PASS` — креды HTTP-прокси, который ставится в Chromium.
- `MP_API_TOKEN` — API token MobileProxy.Space. **Обязателен**: без него парсер завершается ошибкой (режим без SDK удалён).

Опционально:
- `MP_PROXY_SERVER` — дефолт `http://mproxy.site:12695`.
- `MP_PROXY_ID` — если знаешь `proxy_id` заранее, можно не дёргать `getMyProxy()` на старте.
- `GEO_RU_ONLY`, `GEO_CIS_ONLY`, `GEO_EXCLUDE_COUNTRY_IDS`, `GEO_CIS_CAPTION_REGEX`, `GEO_BLOCK_CITY_IDS`, `GEO_BLOCK_CAPTION_REGEX` — фильтры для `changeGeo` (по умолчанию whitelist СНГ и явный запрет РФ). Подробности и дефолты — в `.env.example`.

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

Скрипт спросит в консоли (если соответствующие значения не заданы через env):

1. **Показывать браузер** — `1` = да (headful), `2` = нет (headless).
2. **Циклы** — `1`…`200`; пустой Enter или **`0`** = **без лимита** (пока не упрётся в дату «с», пустые окна подряд, эскалатор и т.п.).
3. **Дата «до»** — правый край первого календарного окна (`DD.MM.YYYY`); пустой Enter = **сегодня**.
4. **Дата «с»** — нижняя граница: как только при сдвиге окон назад конец окна окажется раньше этой даты, прогон остановится (раньше, чем исчерпается лимит циклов, если он задан). Пустой Enter = **без нижней границы** (останов только по лимиту циклов или защитам вроде пустых окон подряд).
5. **Выбор РАК** — включать ли фильтр `Тип документа` с выбором `Решение`, `Постановление апелляции`, `Постановление кассации`.

### С параметрами через env

```bash
RAS_CYCLES=200 RAS_WINDOW_DAYS=1 RAS_DATE_TO=03.05.2026 RAS_DATE_FROM=01.01.2020 node parser.js
```

Поддерживаемые env-переменные:

| Переменная | По умолчанию | Что значит |
|---|---|---|
| `RAS_MODE` | спросит в терминале | режим: `types` (сбор `document_types.json`) или `decision_links` (сбор PDF-ссылок в `decision_links.json`) |
| `RAS_DOC_FILTER_RAK` | спросит в терминале | после первого поиска применить фильтр `Тип документа` и выбрать `Решение + Постановление апелляции + Постановление кассации` |
| `RAS_TARGET_TYPE_IDS` | спросит в терминале (только `decision_links`) | список `DocumentTypeId` через запятую/пробел/перенос строки, для которых собирать решения |
| `RAS_CYCLES` | в терминале: пустой Enter или `0` = без лимита | сколько циклов прогнать (1 цикл = 1 успешное окно с непустыми данными); `RAS_CYCLES=0` = без лимита; в интерактиве конечное число — только `1`…`200` |
| `RAS_WINDOW_DAYS` | `1` | размер окна в днях для одного цикла |
| `RAS_DATE_TO` | сегодня / спросит | самая **новая** дата диапазона, `DD.MM.YYYY` — правый край первого окна |
| `RAS_DATE_FROM` | спросит | самая **старая** дата; дальше назад не идём. Значения `none`, `-`, `0`, `off` = без нижней границы |
| `RAS_HEADLESS` | `1` | `0` — показать окно браузера (удобно для отладки) |
| `RAS_CHROME` | автодетект | путь к конкретному `chrome` бинарю, если автодетект ошибается |

### Показать браузер (отладка)

```bash
RAS_HEADLESS=0 node parser.js
```

### Показать браузер на SSH-сервере (через VNC)

Если парсер крутится на удалённом Linux без GUI, используй виртуальный дисплей:

```bash
sudo apt update
sudo apt install -y xvfb x11vnc fluxbox
```

Один раз создай пароль для VNC (рекомендуется):

```bash
x11vnc -storepasswd
```

Запуск:

```bash
cd /home/roman/ras_parser
RAS_HEADLESS=0 scripts/start_visible_parser.sh
```

С ноутбука (локально) пробрось порт:

```bash
ssh -L 5900:127.0.0.1:5900 <user>@<server>
```

Дальше открой любой VNC-клиент и подключись к `127.0.0.1:5900`.

Примечание: скрипт поднимает `Xvfb + fluxbox + x11vnc`, а затем стартует парсер с `DISPLAY=:99`.

---

## Результаты

- `parsed_data/document_types.json` — собранный справочник `{ "Имя типа": "uuid" }`. Файл инкрементально дополняется между запусками, не затирается.
- `parsed_data/decision_links.json` — ссылки на PDF-решения в режиме `decision_links` c расширенными метаданными по каждому документу:
  - верхний уровень: `link`, `typeId`, `typeName`, `id`, `caseId`, `fileName`, `registrationDate`, `displayDate`
  - `metadata` — полный исходный `item` из ответа RAS (для последующей фильтрации/аналитики без повторного парсинга)
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
MP_CHANGE_IP_COOLDOWN_SEC=300
ESC_EQUIPMENT_COOLDOWN_SEC=600

ESC_MAX_IP_BEFORE_EQUIPMENT=8    # changeIp подряд до changeOperator
ESC_PRE_EQUIPMENT_IP_ROTATIONS=3 # доп. changeIp прямо перед сменой оборудования
ESC_MAX_OPERATOR_BEFORE_GEO=2    # changeOperator (в том же гео) до changeGeo
ESC_MAX_GEO_SWAPS=5              # потолок changeGeo на весь прогон
ESC_MAX_TOTAL_FAILURES=0         # 0 = без лимита; иначе потолок recoverFrom
ESC_MAX_BUDGET_SEC=0             # 0 = без лимита; иначе секунды с запуска
```

Браузер ходит через `MP_PROXY_SERVER`. На сетевой ошибке / бане / таймауте парсер зовёт `_recoverFrom(reason, { kind })`, где `kind` определяет, что эскалатору разрешено делать:

| Уровень | Что делает | Когда уходим выше |
|---|---|---|
| L1 — `changeIp` | rotation endpoint (без API rate-limit, но с hard-cooldown `MP_CHANGE_IP_COOLDOWN_SEC`), settle через `smartWait('ip_cooldown')` | после `ESC_MAX_IP_BEFORE_EQUIPMENT` подряд |
| L2 — `changeOperator` | `change_equipment` СТРОГО в текущем geoid (никаких слепых фоллбеков на «любое другое eid» — раньше такой фоллбек мог тихо увезти SIM в другой регион). Если в текущем гео нет альтернативного оператора — `ok:false reason='no-same-geo-operator'`, и эскалатор уходит выше. Settle через `smartWait('equipment_swap')` | после `ESC_MAX_OPERATOR_BEFORE_GEO` подряд |
| L3 — `changeGeo` | `change_equipment` с другим `geoid` под `GEO_*`-фильтрами (по умолчанию whitelist СНГ). **Запускается ТОЛЬКО при `kind='net_down'`** — см. «Политика смены региона» | после `ESC_MAX_GEO_SWAPS` за прогон |
| STOP | бросаем `EscalationExhausted`, прогон завершается с понятным саммари в логах | — |

Также:
- На каждый успешный шаг `consecutiveIpRotations` сбрасывается → следующий цикл атак снова начинается с дешёвого `changeIp`.
- Перед первой сменой оборудования после исчерпания L1 эскалатор делает доп. `changeIp`-burst (`ESC_PRE_EQUIPMENT_IP_ROTATIONS`), чтобы несколько раз попробовать сменить egress без платной операции.
- После смены гео сбрасывается операторный счётчик внутри гео.
- `MP_CHANGE_IP_COOLDOWN_SEC` — hard-cooldown между двумя `changeIp` (по умолчанию 300с / 5 минут).
- `ESC_EQUIPMENT_COOLDOWN_SEC` — hard-cooldown между `changeEquipment`/`changeGeo` (по умолчанию 600с / 10 минут).
- `ESC_MAX_BUDGET_SEC` и `ESC_MAX_TOTAL_FAILURES` — опциональные страховки (**значение ≤0 = выключено**, дефолт в коде 0). Конечность «451 → IP → снова 451» обеспечивает лестница L1/L2 (и L3 только при `net_down`), а не эти счётчики.

### Политика смены региона (`changeGeo`) — платно у провайдера

У провайдера mobileproxy.space смена региона (а не просто SIM или IP) — **платная** операция. Поэтому в эскалаторе она строго гейтится через `kind`:

| `kind` | Когда передаётся | L3 changeGeo разрешён? |
|---|---|---|
| `'banned'` | HTTP 403/429/451/5xx, sentinel не найден, тихий бан (страница загрузилась, JS не отработал) | **НЕТ.** Эскалатор использует только L1 и L2 в текущем гео. После исчерпания обоих кидает `EscalationExhausted` с явным сообщением «changeGeo ПОЛИТИКОЙ ЗАПРЕЩЁН» |
| `'net_down'` | `ERR_CONNECTION_RESET/REFUSED/TIMED_OUT`, Playwright-таймаут goto, `ECONNRESET/ETIMEDOUT`, **5+ флапов прокси-туннеля подряд** (включая ACL у провайдера) | **ДА**, но всё равно сначала отрабатывает L1 (changeIp). L3 запускается только когда L1+L2 в текущем гео исчерпаны и `totalGeoSwaps < ESC_MAX_GEO_SWAPS`, с фильтрами `GEO_FILTERS` (по умолчанию whitelist СНГ) |

Дополнительно `ProxyEscalator.recoverFrom` на невалидный `kind` (опечатка) кидает явный `Error` — никаких немых деградаций до дефолта.

### Flap прокси-туннеля vs бан

Между сетевыми ошибками `parser.js` различает:

- **`proxy_flap`** (`ERR_EMPTY_RESPONSE`, `ERR_TUNNEL_CONNECTION_FAILED`, `ERR_CONNECTION_CLOSED/ABORTED` и т.п.) — HTTP-CONNECT к прокси сорвался, это шум апстрима провайдера. Новый IP не починит. Делаем `smartWait('proxy_flap')` (короткий backoff 0.8..2.5с с хвостами) и ретраим **на том же IP**. Эскалация (`_recoverFrom('net_down')`) запускается только если флапов подряд набралось `PROXY_FLAP_ROTATE_AFTER` (5).
- **`proxy/net`** (`ERR_CONNECTION_RESET/REFUSED/TIMED_OUT`, Playwright-таймауты, `ECONNRESET/ETIMEDOUT/ENETUNREACH`) — это уже либо сайт нас режет, либо сеть умерла. Сразу в эскалатор с `kind='net_down'`.
- **`banned`** — HTTP-уровень: 403, 429, **451** (RAS отдаёт ровно его на «IP в чёрном списке»: тело — статическая HTML-страница «Доступ заблокирован» с `/static/img/blocked.png`), 500..525. В эскалатор с `kind='banned'` — без права на changeGeo.

> **Failsafe для неизвестных бан-кодов.** Если за «раунд» (8 попыток на странице) эскалатор ни разу не позвался (т.е. ни одна ошибка не классифицировалась как «надо крутить IP»), `_walkPagesForBody` форсит один `_recoverFrom('banned')` перед следующим раундом и пишет в лог `failsafe: раунд провалился (...) — форс _recoverFrom(banned)`. Это страховка от ситуации «RAS подкинул новый бан-код, которого нет в `_isLikelyBanned`» — парсер всё равно сменит IP и не залипнет на мёртвой SIM. Если такое сообщение появилось — занеси код в `_isLikelyBanned`, чтобы ротация шла с 1-й попытки, а не с 9-й.

### Адаптивное дробление окна по latency (Query Downgrade + Circuit Breaker)

**Идея:** не ждать 451. Когда RAS начинает нас троттлить, это видно ещё до бана — `/Search` начинает отвечать аномально долго (5–7+ секунд вместо обычной секунды-двух). Это первый признак, что пул прокси разогрет и антиабуз-система RAS уже накапливает «штрафные баллы» за тяжёлые выборки. Если в этот момент сразу облегчить запрос (сузить окно дат) и сменить IP, до 451 дело не дойдёт и пул не будет сожжён зря.

**Триггер:** один POST `/Search` ответил дольше `RAS_SLOW_RESPONSE_THRESHOLD_MS` (по умолчанию 5000 мс). Замер делается монотонно вокруг `page.request.post(...)` в `_postSearchPage`.

**Реакция (по порядку, как только сработал триггер):**

1. Текущая страница уже сохранена через `_save()` — данные не теряются.
2. Прерываем оставшуюся пагинацию текущего под-окна (Circuit Breaker), `_walkPagesForBody` бросает `WindowDowngradeError` с `{ endDay, daysSpan, latencyMs, pageNum }`.
3. `main()` ловит это исключение и дробит текущее под-окно на `RAS_WINDOW_SPLIT_FACTOR` примерно равных кусков через чистый хелпер `splitWindow` (`windowSplit.js`). Куски кладутся в LIFO-стек подокон, чтобы первой обрабатывалась самая «свежая» половина (естественный временной порядок).
4. Зовём `_recoverFrom('banned')` — `kind=banned` означает, что в эскалаторе разрешены только L1 `changeIp` и L2 `changeOperator` в текущем гео; платный L3 `changeGeo` ПРИНЦИПИАЛЬНО не запускается на «софтовом» сигнале (правильно — это всё ещё то же поведение, что на 451).
5. Если у `_recoverFrom` сработал `RECYCLE_BROWSER_AFTER_BANNED_L1` (рестарт Chromium с новой `/Search`-сессией) — `bodyTemplate`/`url`/`headers` обновляются из свежего `_captured`, под-окна остаются в стеке.
6. Возвращаемся к началу outer-цикла, забираем из стека следующее под-окно (одну из половин дроблёнки).

**Параметры (`.env`):**

| Переменная | Дефолт | Что значит |
|---|---|---|
| `RAS_SLOW_RESPONSE_THRESHOLD_MS` | `5000` | latency `/Search`-POST'а, при которой считаем окно «тяжёлым». `0` — фича выключена, latency игнорируется (поведение как до фичи) |
| `RAS_WINDOW_SPLIT_FACTOR` | `2` | на сколько кусков дробить окно при срабатывании. Минимум 2 |
| `RAS_WINDOW_MIN_DAYS` | `1` | нижняя граница дробления; на под-окне такой длины split не делается — только `_recoverFrom` и retry на тех же датах |

**Что считается «циклом» (`RAS_CYCLES`):** один outer-цикл = один полный диапазон длиной `RAS_WINDOW_DAYS` от текущего `endDay`. Если он был раздроблен на N под-окон — это всё равно один цикл; в конце outer-цикла лог `=== цикл K/N готов (DD.MM.YYYY, Wд): sub-окон=N, downgrades=M, ... ===` показывает, сколько раз сработало дробление (при безлимите циклов в логе **N = ∞**). Пустые outer (все под-окна вернули 0 items) считаются как раньше — через `emptyStreak`, не за цикл.

**Данные не теряются:**

- `_walkPagesForBody` сохраняет items через `_save()` после КАЖДОЙ успешной страницы, до того как может бросить `WindowDowngradeError`.
- `_processItems` дедуплицирует по `TypeId` — пересечение под-окон после дробления не приводит к двойным записям.
- При recycle браузера `documentTypes` в памяти и `parsed_data/document_types.json` на диске сохраняются.

> **Что НЕ делаем сейчас.** Не меряем latency первой страницы (она ловится через `_onResponse` в момент клика «Найти»). Если RAS начнёт давить ещё до начала пагинации, сработает обычная ban-ловушка по 451/403, не Query Downgrade. Также не реализован «авто-restore» окна обратно после серии быстрых ответов — каждый новый outer стартует с `RAS_WINDOW_DAYS` снова.

### ACL у провайдера (CONNECT 403)

У `mobileproxy.space` часть SIM-ок сидит в ACL-чёрном списке по hostname `*.arbitr.ru` (чаще всего — Москва/СПб/миллионники). На таких SIM провайдер отвечает `HTTP 403 "Access control list denies you"` на сам CONNECT, и Chromium это видит одинаково с обычным флапом как `ERR_TUNNEL_CONNECTION_FAILED`.

Раньше при детекте ACL парсер делал «fast-track» сразу в L3 `changeGeo`, минуя L1/L2 — это было удобно, но **обходило политику пользователя про платную смену региона**. Сейчас fast-track ВЫКЛЮЧЕН: при каждом `proxy_flap` мы делаем «голый» CONNECT к прокси (`_diagnoseProxyAcl`) **только для лога** (закешировано на 30с), а сама эскалация идёт обычным путём — после 5+ флапов подряд через `_recoverFrom('net_down')` доходим по лестнице L1 → L2 → L3. То есть changeIp пробуем первым, потом меняем SIM в том же гео, и только если ничего не помогло — едем менять регион. Фильтры `GEO_*` из `.env` применяются на L3, чтобы случайно не «переехать» в очередной заблокированный/московский город.

### Rate-limit на API провайдера

`network/proxyClient.js` сам соблюдает лимиты MobileProxy:
- 1 одинаковый запрос (по сигнатуре `command + args`) не чаще раза в 5 сек (защищает от `"Too many lonely requests. Timeout 5 second"`).
- 3 × N запросов/сек суммарно, где N = число активных прокси (резолвится через `getMyProxy()` лениво при первом вызове).
- `RateLimitError` от провайдера ловится один раз с backoff 7 сек и retry.
- `changeIp` (rotation endpoint) идёт мимо общего бакета — у него по доке провайдера лимита частоты нет.

### Если `MP_API_TOKEN` не задан

Парсер завершится с ошибкой на старте: legacy-режим без SDK удалён, `_recoverFrom` работает только через `ProxyEscalator`.

---

## Структура

```
ras_parser/
├── parser.js               # основной скрипт: сессия /Search, пагинация, proxy_flap/ACL,
│                           #   Query Downgrade при slow /Search-ответе
├── stealthManager.js       # антифрод-обёртка вокруг Playwright Page (smartWait/click/type)
├── network/
│   ├── config.js           # сетевой/env-конфиг (прокси, geo-фильтры, лимиты)
│   ├── proxyClient.js      # обёртка над @mobileproxy/sdk + rate-limit + resolve proxy_id
│   ├── escalator.js        # лестница changeIp → changeOperator → changeGeo + лимиты
│   └── loadEnv.js          # автозагрузка .env для entry-point
├── windowSplit.js          # чистый хелпер дробления окна дат для Query Downgrade
├── test_escalator.js       # юнит-тесты эскалатора (без сети)
├── test_window_split.js    # юнит-тесты splitWindow (без сети)
├── .env.example            # шаблон env, закоммичен
├── .env                    # реальные секреты, в .gitignore
├── package.json            # deps: playwright, ghost-cursor-playwright, @mobileproxy/sdk
├── parsed_data/            # итоговые данные парсинга
│   ├── document_types.json
│   └── decision_links.json
└── debug/                  # артефакты последнего прогона
    ├── debug_page.png
    ├── debug_page.html
    ├── debug_responses.txt
    └── search/             # сырые ответы /Search
```

## Тесты

```bash
npm test
```

Запускает `test_escalator.js` — юнит-тесты с замоканным `proxyClient`:
- `test_ladder_terminates` — при `kind='net_down'` и «провайдер ничего не помогает» эскалатор за **28 шагов** с дефолтными лимитами кидает `EscalationExhausted` (никакой бесконечности).
- `test_recovery_after_success` — `noteSuccess` корректно сбрасывает `consecutiveIp`, следующая итерация снова идёт через дешёвый `changeIp`. Заодно проверяет, что дефолтный `kind` — `'banned'`.
- `test_time_budget` — превышение `ESC_MAX_BUDGET_SEC` тоже отрубает цикл.
- `test_total_failures_cap` — независимый ограничитель по числу попыток.
- `test_stealth_wait_buckets` — после `changeIp` settle идёт через `'ip_cooldown'`, после `changeEquipment` — через `'equipment_swap'`.
- **`test_banned_never_changes_geo`** — на `kind='banned'` эскалатор НИКОГДА не зовёт `changeGeo`, после исчерпания L1+L2 кидает `EscalationExhausted` с явным сообщением про политику.
- **`test_net_down_tries_ip_first`** — на `kind='net_down'` первый же провал идёт в L1 `changeIp`, не в L3, даже если бюджет на geo не исчерпан.
- **`test_invalid_kind_throws`** — опечатка в `kind` ловится явной `Error`, без немой деградации.
- **`test_revert_duplicate_ip_counters`** — `revertLastIpRotationForDuplicateEgress` корректно откатывает счётчики при duplicate `new_ip`.

И `test_window_split.js` — юнит-тесты чистой функции `splitWindow` для Query Downgrade (8 проверок: `factor=2` для 7 дней → `[4,3]`, `factor=4` для 7 дней → `[2,2,2,1]`, `daysSpan=1` → одно окно неизменным, корректный сдвиг через границу месяца, неизменность входного `Date`, и т.д.).

Тесты не делают сетевых запросов и работают за ~0.3 секунды.

---

## Типичные проблемы

- **`Executable doesn't exist at ...`** — не выполнил `npx playwright install chromium`. На не-Linux задай `RAS_CHROME=/path/to/chrome`.
- **`ERR_TUNNEL_CONNECTION_FAILED`** подряд и много — прокси не отвечает или старый бинарь Chromium. Поставь свежий: `npx playwright install chromium` (скрипт сам выберет самый свежий `chromium-*` из кеша). Единичные флапы — штатный `proxy_flap`, парсер сам переживает.
- **В логах `[acl] CONNECT ... → 403`** — на текущей SIM провайдер забанил hostname арбитра. Сейчас это **только лог**, fast-track в `changeGeo` отключён по политике «менять регион — последнее средство, и только при отвале сети». Парсер дойдёт до `changeGeo` сам через лестницу: 5+ флапов подряд → `_recoverFrom('net_down')` → `changeIp` × `ESC_MAX_IP_BEFORE_EQUIPMENT` → `changeOperator` (в том же гео) × `ESC_MAX_OPERATOR_BEFORE_GEO` → `changeGeo` под `GEO_*`-фильтрами. Если под фильтр не подходит ни одно гео — увидишь `no-allowed-geo`, расширяй `GEO_BLOCK_CAPTION_REGEX`/`GEO_BLOCK_CITY_IDS` в `.env`.
- **В логах `[esc] ... changeGeo ПОЛИТИКОЙ ЗАПРЕЩЁН ...`** — мы уперлись в HTTP-бан (`kind='banned'`), `changeIp` × N и `changeOperator` × M не помогли, политика не разрешает платную смену региона на просто HTTP-бане. Если уверен, что бан реально требует смены гео — рестартни парсер (он начнёт новый прогон, бан-IP может за это время отлежаться) или поправь логику классификации `_isLikelyBanned`/`_isRotatableNetworkError` в `parser.js`.
- **В логах `failsafe: раунд провалился (...) — форс _recoverFrom(banned)`** — в течение одного раунда (8 попыток) эскалатор не позвался ни разу, парсер сам форсит ротацию IP перед следующим раундом. Чаще всего — RAS отдал новый, не учтённый в `_isLikelyBanned` HTTP-код. Парсер сам разрулит, но стоит занести код в `_isLikelyBanned`, чтобы ротация шла с первой попытки.
- **В логах `[downgrade] DD.MM.YYYY/Wд → дроблю на N: ...`** — сработал Query Downgrade: latency `/Search` превысила `RAS_SLOW_RESPONSE_THRESHOLD_MS`, парсер дробит окно и ротейтит IP до того, как RAS успеет накинуть 451. Это штатная превентивная реакция, не ошибка. Если срабатывает слишком часто — либо подними порог (`RAS_SLOW_RESPONSE_THRESHOLD_MS=7000`), либо изначально стартуй с меньшим `RAS_WINDOW_DAYS`. Если хочешь полностью отключить фичу — `RAS_SLOW_RESPONSE_THRESHOLD_MS=0`.
- **В логах `latency=Xмс > порог Yмс, но daysSpan=1 уже на минимуме`** — окно уже минимальное (`RAS_WINDOW_MIN_DAYS=1` день), дробить дальше некуда, продолжаем тянуть страницы. Если на минимальном окне всё равно срабатывает slow — RAS под серьёзной нагрузкой, имеет смысл подождать или поднять `RAS_SLOW_RESPONSE_THRESHOLD_MS`.
- **В логах `раунд N без данных — данные обязательны, иду в раунд N+1`** — нормальная работа в условиях бана: данные на странице терять нельзя, поэтому `_walkPagesForBody` не пропускает страницу, а крутит её раундами, пока эскалатор не вытащит из бана (или не выкинет `EscalationExhausted`).
- **`/Search` не ловится 60 секунд** — посмотри `debug/debug_page.png` и `debug/debug_responses.txt`. Часто помогает `RAS_HEADLESS=0` чтобы глазами увидеть, что происходит. Если сессия так и не поднялась — парсер сам зовёт `_recoverFrom` и переоткрывает главную (до 5 попыток).
- **Запрос есть, но `Result=null`** — окно дат пустое, скрипт идёт назад. Если 60 пустых подряд — останавливается.
- **`[escalator] исчерпан: ...`** — эскалатор выгреб все ip+operator+geo и не вытащил нас из бана. В логе будет summary с числом шагов. Стоит проверить `getBalance` (есть ли что менять оборудование на), доступность других гео в дашборде MobileProxy и поднять `ESC_MAX_*` лимиты, если думаешь, что просто нужно больше попыток.
- **`Too many lonely requests`** или **`Too many requests per second`** от провайдера — значит баг в `network/proxyClient.js`-rate-limiter'е. Открой issue, в `_call` есть детальные логи `[mp/rl]`.
- **`RasProxyClient: proxyKey is required`** на старте — забыл заполнить `MP_PROXY_KEY` в `.env` (в коде больше нет hardcoded fallback).
