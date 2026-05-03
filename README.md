# ras_parser (Node.js)

Сбор справочника `DocumentType` с [ras.arbitr.ru](https://ras.arbitr.ru/) через Playwright + мобильный прокси с ротацией IP.

Логика:
1. Поднимается Chromium с прокси (`config.js`).
2. Открывается `ras.arbitr.ru`, ждём JS/jQuery/fingerprint.
3. Кликаем «Найти», ловим первый POST `/Search`, сохраняем `url + headers + body`.
4. Дальше сами шлём `page.request.post(...)` для страниц 2..40 (тот же body, меняем `Page`, `DateFrom`, `DateTo`).
5. Из каждого item достаём `TypeId` / `Type` и инкрементально пишем в `document_types.json`.
6. На ошибке/пустоте дёргаем `CHANGE_IP_URL` и повторяем.

---

## Требования

- **Node.js >= 20** (нужен встроенный `fetch` и `AbortSignal.timeout`).
- Linux (логика поиска бинаря Chromium заточена под `~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`).

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
```

`npm install` поставит `playwright`, `npx playwright install chromium` скачает сам браузер в `~/.cache/ms-playwright/`.

---

## Запуск

### Самый простой способ

```bash
npm start
```

или

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

## Прокси и ротация IP

Настройки в `config.js`:

```js
PROXY_SERVER = "http://mproxy.site:12695"
PROXY_USER   = "uc2ady"
PROXY_PASS   = "Ed3rUdFYYvAp"

CHANGE_IP_URL          = "https://changeip.mobileproxy.space/?proxy_key=...&format=json"
CHANGE_IP_COOLDOWN_SEC = 15
```

Браузер ходит через `PROXY_SERVER`. На любой ошибке `/Search` (исключение, не-200, json-decode) скрипт сам дёргает `CHANGE_IP_URL` (control-URL, идёт мимо прокси), ждёт `CHANGE_IP_COOLDOWN_SEC` секунд и повторяет запрос.

---

## Структура

```
ras_parser/
├── parser.js           # основной скрипт
├── config.js           # прокси, тайминги, changeip URL
├── package.json        # deps: playwright
├── document_types.json # результат (инкрементально)
└── debug/              # артефакты последнего прогона
    ├── debug_page.png
    ├── debug_page.html
    ├── debug_responses.txt
    └── search/         # сырые ответы /Search
```

---

## Типичные проблемы

- **`Executable doesn't exist at ...`** — не выполнил `npx playwright install chromium`.
- **`ERR_TUNNEL_CONNECTION_FAILED`** — прокси не отвечает или старый бинарь Chromium. Поставь свежий: `npx playwright install chromium` (скрипт сам выберет самый свежий `chromium-*` из кеша).
- **`/Search` не ловится 60 секунд** — посмотри `debug/debug_page.png` и `debug/debug_responses.txt`. Часто помогает `RAS_HEADLESS=0` чтобы глазами увидеть, что происходит.
- **Запрос есть, но `Result=null`** — окно дат пустое, скрипт идёт назад. Если 60 пустых подряд — останавливается.
