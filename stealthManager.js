/**
 * StealthBrowserManager — фасад над Playwright `Page`, который полностью
 * инкапсулирует «человеческое» взаимодействие с DOM, чтобы обходить
 * поведенческий анализ продвинутых антифрод-систем.
 *
 * Бескомпромиссные принципы:
 *   - в этом модуле — единственный разрешённый источник пауз. Любая
 *     задержка проходит через `smartWait(actionType)` с long-tail
 *     распределением по бакетам с весами. Никаких голых
 *     `setTimeout`/`waitForTimeout` за пределами smartWait;
 *   - движения мыши идут по кривым Безье через `ghost-cursor-playwright`
 *     (форк ghost-cursor под Playwright; оригинальный `ghost-cursor`
 *     дёргает puppeteer-only API: `page.browser()`, `page._client()`,
 *     `page.target()._targetId` — в Playwright их нет, поэтому он там
 *     стабильно падает с `TypeError: this.page.browser is not a function`).
 *     Никаких телепортаций; перед каждым кликом — рандомная точка в
 *     «толстом ядре» элемента (30..70% от bbox) + 1..3 микро-«ёрзания»
 *     через `cursor.actions.move({x: prev.x+dx, y: prev.y+dy})`;
 *   - набор текста через `pressSequentially` с РАНДОМНОЙ per-char
 *     задержкой; при длине > 5 символов вставляем «задумчивую» паузу
 *     300..600 мс на случайной позиции в середине слова;
 *   - после каждого `click`/`type`/`pressKey`/`clickBelow` гарантированно
 *     вызывается `smartWait(afterWait)` (по умолчанию 'micro'), чтобы антифрод
 *     не видел мгновенной реакции скрипта на изменение DOM.
 *
 * Контексты smartWait:
 *   - 'micro'       — пост-action settle (80..280 мс, редкий tail до 1.6 с);
 *   - 'click'       — пауза «после действия» обычного клика;
 *   - 'reading'     — «прочитать страницу» (3..8 с, иногда 10..30, редко 60..240);
 *   - 'api_delay'   — между запросами к API арбитра (1.5..4 с, редкий tail до 10 с);
 *   - 'ip_cooldown' — после ротации мобильного IP (12..28 с, редкий tail до 50);
 *   - 'warmup'      — после goto, чтобы JS/jQuery/fingerprint доинициализировались;
 *   - 'proxy_flap'  — короткий backoff между ретраями, когда HTTP-туннель
 *                     прокси-провайдера дрогнул (CONNECT aborted /
 *                     ERR_EMPTY_RESPONSE / ERR_TUNNEL_CONNECTION_FAILED).
 *                     Это НЕ задача ротации IP: новый мобильный IP не
 *                     чинит сломанный апстрим прокси, поэтому здесь
 *                     быстрый ретрай (0.8..2.5 с), редко — длиннее.
 *   - 'equipment_swap' — settle после смены оборудования/оператора/гео
 *                     через MobileProxy API (`change_equipment`). Модему
 *                     надо физически переехать на другую SIM/гео, что
 *                     даже в быстром случае это десятки секунд, а в
 *                     худшем — минуты. Дёргать целевой сайт раньше нет
 *                     смысла: прокси может не отвечать вообще или ещё
 *                     не «прогреть» новый канал.
 */

import path from "node:path";
import fs from "node:fs";
import { createCursor } from "ghost-cursor-playwright";

/** Подробные `[stealth/…]` в консоль (паузы, каждый клик/набор). По умолчанию выкл. */
const RAS_TRACE_STEALTH = process.env.RAS_TRACE_STEALTH === "1";

/** Пометка на `Page`: уже подменили `mouse.move` clamp’ом по viewport. */
const MOUSE_CLAMP_INSTALLED = Symbol.for("ras_parser.stealth.mouseClampViewport");

const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randUniform(a, b) {
  return a + Math.random() * (b - a);
}

function randInt(a, b) {
  return Math.floor(randUniform(a, b + 1));
}

function isFiniteNumber(n) {
  return typeof n === "number" && Number.isFinite(n);
}

function isValidPoint(pt) {
  return !!pt && isFiniteNumber(pt.x) && isFiniteNumber(pt.y);
}

/**
 * Chromium/CDP отвергает mouse.move с координатами вне viewport (`Invalid parameters`).
 * В ghost-cursor `clampPositive` обнуляет только отрицательные оси; траектории Безье и
 * overshoot выводят X/Y за правый/нижний край — то же самое с `_fidgetCursor` у краёв.
 *
 * @param {number} n
 * @param {number} maxCssPx размер оси viewport (CSS px)
 */
function clampPixelToViewportAxis(n, maxCssPx) {
  if (!Number.isFinite(n) || maxCssPx <= 0) return 0;
  const hi = Math.max(0, maxCssPx - 1);
  return Math.round(Math.min(Math.max(n, 0), hi));
}

/**
 * Подмена `page.mouse.move`: все координаты приводятся к целым и к пределам viewport.
 * Вызывать до `createCursor()`, чтобы и стартовая точка ghost-cursor проходила через clamp.
 *
 * @param {import('playwright').Page} page
 */
function installViewportClampedMouseMove(page) {
  if (page[MOUSE_CLAMP_INSTALLED]) return;
  page[MOUSE_CLAMP_INSTALLED] = true;
  const origMove = page.mouse.move.bind(page.mouse);
  page.mouse.move = async (x, y, moveOpts) => {
    const vs = page.viewportSize();
    const vw = vs?.width ?? 4096;
    const vh = vs?.height ?? 2160;
    const cx = clampPixelToViewportAxis(x, vw);
    const cy = clampPixelToViewportAxis(y, vh);
    return origMove(cx, cy, moveOpts);
  };
}

function buildTargetFromBox(box) {
  if (
    !box ||
    !isFiniteNumber(box.x) ||
    !isFiniteNumber(box.y) ||
    !isFiniteNumber(box.width) ||
    !isFiniteNumber(box.height) ||
    box.width <= 0 ||
    box.height <= 0
  ) {
    return null;
  }
  const FX_MIN = 0.3, FX_MAX = 0.7;
  const FY_MIN = 0.3, FY_MAX = 0.7;
  return {
    x: box.x + box.width * FX_MIN,
    y: box.y + box.height * FY_MIN,
    width: box.width * (FX_MAX - FX_MIN),
    height: box.height * (FY_MAX - FY_MIN),
  };
}

/**
 * Выбор бакета по весам.
 * @param {Array<{weight:number,range:[number,number],label:string}>} buckets
 */
function pickWeighted(buckets) {
  const total = buckets.reduce((s, b) => s + b.weight, 0);
  let r = Math.random() * total;
  for (const b of buckets) {
    r -= b.weight;
    if (r < 0) return b;
  }
  return buckets[buckets.length - 1];
}

/**
 * Распределения пауз. Веса в условных «человеческих долях», не процентах,
 * чтобы было удобно дописывать новые тиры без пересчёта.
 */
const WAIT_BUCKETS = {
  micro: [
    { weight: 80, range: [80, 280], label: "micro/twitch" },
    { weight: 15, range: [350, 750], label: "micro/blink" },
    { weight: 5, range: [900, 1600], label: "micro/glance" },
  ],
  click: [
    { weight: 90, range: [300, 1500], label: "click/normal" },
    { weight: 10, range: [2000, 5000], label: "click/hesitation" },
  ],
  reading: [
    { weight: 75, range: [3000, 8000], label: "reading/short" },
    { weight: 20, range: [10000, 30000], label: "reading/medium" },
    { weight: 5, range: [60000, 240000], label: "reading/distracted" },
  ],
  api_delay: [
    { weight: 85, range: [1500, 4000], label: "api/normal" },
    { weight: 12, range: [4000, 7000], label: "api/slow" },
    { weight: 3, range: [7500, 10000], label: "api/stall" },
  ],
  /** Между кликами пейджера в одной выдаче — короче, чем `api_delay` (без «читал страницу»). */
  pager: [
    { weight: 82, range: [320, 850], label: "pager/quick" },
    { weight: 15, range: [850, 1600], label: "pager/settle" },
    { weight: 3, range: [1700, 3200], label: "pager/stall" },
  ],
  ip_cooldown: [
    { weight: 70, range: [12000, 18000], label: "ip/normal" },
    { weight: 25, range: [18000, 28000], label: "ip/slow" },
    { weight: 5, range: [30000, 50000], label: "ip/long" },
  ],
  warmup: [
    { weight: 70, range: [5000, 10000], label: "warmup/quick" },
    { weight: 25, range: [10000, 18000], label: "warmup/slow" },
    { weight: 5, range: [25000, 45000], label: "warmup/long" },
  ],
  proxy_flap: [
    { weight: 75, range: [800, 2500], label: "proxy_flap/quick" },
    { weight: 20, range: [2500, 6000], label: "proxy_flap/slow" },
    { weight: 5, range: [6000, 12000], label: "proxy_flap/stall" },
  ],
  equipment_swap: [
    { weight: 70, range: [30000, 60000], label: "equipment_swap/normal" },
    { weight: 25, range: [60000, 120000], label: "equipment_swap/slow" },
    { weight: 5, range: [120000, 180000], label: "equipment_swap/stall" },
  ],
  /** Интервал между проверками «п. 3.1 ещё на месте» (без искусственных пауз в парсере). */
  filter31_recheck: [
    { weight: 85, range: [180_000, 240_000], label: "filter31_recheck/normal" },
    { weight: 12, range: [240_000, 300_000], label: "filter31_recheck/stretch" },
    { weight: 3, range: [300_000, 420_000], label: "filter31_recheck/long" },
  ],
};

/**
 * Выбрать длительность паузы из бакета без самого сна (планирование таймеров и т.п.).
 * @param {keyof typeof WAIT_BUCKETS} [actionType='click']
 * @returns {number}
 */
export function sampleSmartWaitMs(actionType = "click") {
  const buckets = WAIT_BUCKETS[actionType];
  if (!buckets) {
    return sampleSmartWaitMs("click");
  }
  const bucket = pickWeighted(buckets);
  return randUniform(bucket.range[0], bucket.range[1]);
}

export class StealthBrowserManager {
  /**
   * Прямой конструктор не вызывать — `createCursor()` в
   * `ghost-cursor-playwright` async. Используй `await
   * StealthBrowserManager.create(page, options)`.
   *
   * @param {import('playwright').Page} page
   * @param {import('ghost-cursor-playwright').Cursor} cursor
   * @param {{logger?: (msg: string) => void}} [options]
   */
  constructor(page, cursor, options = {}) {
    if (!page) {
      throw new Error("StealthBrowserManager: page is required");
    }
    if (!cursor) {
      throw new Error(
        "StealthBrowserManager: cursor is required (use StealthBrowserManager.create)",
      );
    }
    this.page = page;
    this.cursor = cursor;
    this.log = options.logger ?? ((msg) => process.stdout.write(`${msg}\n`));
  }

  /**
   * Асинхронная фабрика: поднимает ghost-cursor-playwright и возвращает
   * готовый `StealthBrowserManager`.
   *
   * @param {import('playwright').Page} page
   * @param {{logger?: (msg: string) => void}} [options]
   * @returns {Promise<StealthBrowserManager>}
   */
  static async create(page, options = {}) {
    if (!page) {
      throw new Error("StealthBrowserManager.create: page is required");
    }
    installViewportClampedMouseMove(page);
    const cursor = await createCursor(page, {
      debug: false,
      overshootRadius: 0,
    });
    return new StealthBrowserManager(page, cursor, options);
  }

  /**
   * Единственный «легальный» источник пауз во всём проекте.
   *
   * @param {keyof typeof WAIT_BUCKETS} [actionType='click']
   * @returns {Promise<number>} фактически проспанные миллисекунды
   */
  async smartWait(actionType = "click") {
    const buckets = WAIT_BUCKETS[actionType];
    if (!buckets) {
      this.log(
        `[stealth/wait] неизвестный actionType='${actionType}', fallback->'click'`,
      );
      return this.smartWait("click");
    }
    const bucket = pickWeighted(buckets);
    const waitMs = randUniform(bucket.range[0], bucket.range[1]);
    if (RAS_TRACE_STEALTH) {
      this.log(
        `[stealth/wait] ${bucket.label}: сплю ${(waitMs / 1000).toFixed(2)}с`,
      );
    }
    await SLEEP(waitMs);
    return waitMs;
  }

  /**
   * 1..3 микро-«ёрзания» курсором по 2..6 пикселей в случайных направлениях,
   * с микропаузами между ними. Имитирует человека, который «уже навёлся,
   * но ещё не нажал».
   *
   * `ghost-cursor-playwright` не имеет `moveBy(dx, dy)` (был в puppeteer-
   * версии), поэтому считаем абсолютные координаты от `cursor.previous` —
   * это последняя точка, в которую двигался курсор. Передаём не объект
   * с >2 ключами, иначе пакет посчитает его BoundingBox-ом и пойдёт в
   * `getRandomPointInsideElem` (см. `instanceOfVector` в cursor.js).
   */
  async _fidgetCursor() {
    const twitches = randInt(1, 3);
    for (let i = 0; i < twitches; i += 1) {
      const dx = randUniform(-5, 5);
      const dy = randUniform(-3, 3);
      const prev = this.cursor.previous;
      if (!isValidPoint(prev)) {
        if (RAS_TRACE_STEALTH) {
          this.log(`[stealth/fidget] нет previous-позиции, пропускаю ёрзания`);
        }
        return;
      }
      const target = { x: prev.x + dx, y: prev.y + dy };
      if (!isValidPoint(target)) {
        if (RAS_TRACE_STEALTH) {
          this.log(`[stealth/fidget] невалидная target-позиция, пропускаю ёрзания`);
        }
        return;
      }
      try {
        await this.cursor.actions.move(target);
      } catch (e) {
        this.log(`[stealth/fidget] actions.move(by) упал, игнорирую: ${e}`);
        return;
      }
      await SLEEP(randUniform(20, 90));
    }
  }

  /**
   * Человечный клик по селектору:
   *   1. scrollIntoViewIfNeeded;
   *   2. снимаем bbox локатором, сужаем его до «толстого ядра» 30..70%
   *      по обеим осям — НЕ кликаем в center/center и не на самый край;
   *   3. ghost-cursor-playwright двигает мышь по кривой Безье в случайную
   *      точку внутри суженного bbox (`cursor.actions.move(box)`);
   *   4. 1..3 микро-ёрзания через `_fidgetCursor()`;
   *   5. кликаем «по месту» — `cursor.actions.click()` без `target` →
   *      mousedown/mouseup по текущей позиции; `waitBeforeClick` ≈ старый
   *      `hesitate` (пауза перед нажатием), `waitBetweenClick` ≈ старый
   *      `waitForClick` (длина hold);
   *   6. автоматический `smartWait(afterWait)` на выходе.
   *
   * Если bbox получить не удалось — отдаём селектор пакету как fallback,
   * он сам найдёт и применит `getRandomPointInsideElem` без сужения.
   *
   * @param {string} selector
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none', scrollIntoView?: boolean}} [options]
   * @returns {Promise<boolean>}
   */
  async click(selector, options = {}) {
    const { afterWait = "micro", scrollIntoView = true } = options;
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      this.log(`[stealth/click] ${selector} -> элемент не найден`);
      return false;
    }

    if (scrollIntoView) {
      try {
        await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
      } catch (e) {
        this.log(`[stealth/click] scrollIntoView упал, продолжаю: ${e}`);
      }
    }

    let box = null;
    try {
      box = await locator.boundingBox();
    } catch (e) {
      this.log(`[stealth/click] boundingBox упал: ${e}`);
    }

    let target;
    const boxedTarget = buildTargetFromBox(box);
    if (boxedTarget) {
      target = boxedTarget;
    } else {
      target = selector;
      if (box) {
        this.log(
          `[stealth/click] bbox невалидный, fallback на selector: ${JSON.stringify(box)}`,
        );
      }
    }

    const waitBeforeClick = [
      Math.round(randUniform(40, 120)),
      Math.round(randUniform(140, 220)),
    ];
    const waitBetweenClick = [
      Math.round(randUniform(25, 60)),
      Math.round(randUniform(60, 110)),
    ];

    try {
      await this.cursor.actions.move(target);
    } catch (e) {
      this.log(
        `[stealth/click] actions.move упал, fallback на actions.click(target): ${e}`,
      );
      try {
        await this.cursor.actions.click({
          target,
          waitBeforeClick,
          waitBetweenClick,
        });
        if (afterWait !== "none") await this.smartWait(afterWait);
        return true;
      } catch (e2) {
        this.log(`[stealth/click] fallback actions.click(target) тоже упал: ${e2}`);
        return false;
      }
    }

    try {
      await this._fidgetCursor();
    } catch (e) {
      if (RAS_TRACE_STEALTH) {
        this.log(`[stealth/fidget] неожиданная ошибка, продолжаю без ёрзания: ${e}`);
      }
    }

    try {
      await this.cursor.actions.click({
        waitBeforeClick,
        waitBetweenClick,
      });
      if (RAS_TRACE_STEALTH) {
        const offsetStr =
          typeof target === "object"
            ? `target-box=(x=${target.x.toFixed(0)},y=${target.y.toFixed(0)},` +
              `w=${target.width.toFixed(0)},h=${target.height.toFixed(0)})`
            : "target=selector";
        this.log(
          `[stealth/click] ${selector} OK ${offsetStr}, ` +
            `waitBeforeClick=[${waitBeforeClick.join("..")}]мс, ` +
            `waitBetweenClick=[${waitBetweenClick.join("..")}]мс`,
        );
      }
    } catch (e) {
      this.log(
        `[stealth/click] actions.click (at-current) упал, fallback на click(target): ${e}`,
      );
      try {
        await this.cursor.actions.click({
          target,
          waitBeforeClick,
          waitBetweenClick,
        });
      } catch (e2) {
        this.log(`[stealth/click] fallback click(target) тоже упал: ${e2}`);
        return false;
      }
    }

    if (afterWait !== "none") {
      await this.smartWait(afterWait);
    }
    return true;
  }

  /**
   * Человечный набор текста:
   *   - фокусируем поле через стелс-клик (без post-wait, чтобы не задвоить);
   *   - per-char delay рандомизируется ОТДЕЛЬНО для каждого чанка
   *     (один общий delay на весь текст — палево);
   *   - при длине текста > 5 символов с вероятностью 85% делим текст на
   *     2 чанка и вставляем «задумчивую» паузу 300..600 мс на случайной
   *     позиции в середине слова;
   *   - на выходе — `smartWait(afterWait)`.
   *
   * @param {string} selector
   * @param {string} text
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none'}} [options]
   * @returns {Promise<boolean>}
   */
  async type(selector, text, options = {}) {
    const { afterWait = "micro" } = options;
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      this.log(`[stealth/type] ${selector} -> элемент не найден`);
      return false;
    }

    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    } catch (e) {
      this.log(`[stealth/type] scrollIntoView упал, продолжаю: ${e}`);
    }

    const focused = await this.click(selector, { afterWait: "none" });
    if (!focused) {
      this.log(`[stealth/type] не смог сфокусировать ${selector}`);
      return false;
    }
    await this.smartWait("micro");

    const chunks = [];
    let thinkPauseAfter = -1;
    if (text.length > 5 && Math.random() < 0.85) {
      const minIdx = Math.max(2, Math.floor(text.length * 0.25));
      const maxIdx = Math.min(text.length - 2, Math.ceil(text.length * 0.75));
      const pauseAt = randInt(minIdx, maxIdx);
      chunks.push(text.slice(0, pauseAt));
      chunks.push(text.slice(pauseAt));
      thinkPauseAfter = 0;
    } else {
      chunks.push(text);
    }

    try {
      for (let i = 0; i < chunks.length; i += 1) {
        const chunk = chunks[i];
        const charDelay = randUniform(55, 215);
        await locator.pressSequentially(chunk, { delay: charDelay });
        if (RAS_TRACE_STEALTH) {
          this.log(
            `[stealth/type] ${selector} <- "${chunk}" ` +
              `(per-char≈${charDelay.toFixed(0)}мс)`,
          );
        }
        if (i === thinkPauseAfter) {
          const thinkMs = randUniform(300, 600);
          if (RAS_TRACE_STEALTH) {
            this.log(
              `[stealth/type] «задумчивая» пауза ${thinkMs.toFixed(0)}мс ` +
                `после "${chunk}"`,
            );
          }
          await SLEEP(thinkMs);
        }
      }
    } catch (e) {
      this.log(`[stealth/type] pressSequentially упал: ${e}`);
      return false;
    }

    if (afterWait !== "none") {
      await this.smartWait(afterWait);
    }
    return true;
  }

  /**
   * Нажатие клавиши в активном фокусе страницы (`page.keyboard`).
   * Для закрытия datepicker после набора даты и т.п.
   *
   * @param {string} key — имя клавиши Playwright, например `'Enter'`, `'Escape'`.
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none'}} [options]
   * @returns {Promise<boolean>}
   */
  async pressKey(key, options = {}) {
    const { afterWait = "micro" } = options;
    if (!key || typeof key !== "string") {
      this.log("[stealth/key] пустой key");
      return false;
    }
    try {
      await this.page.keyboard.press(key);
      if (RAS_TRACE_STEALTH) {
        this.log(`[stealth/key] press '${key}'`);
      }
    } catch (e) {
      this.log(`[stealth/key] press '${key}' упало: ${e}`);
      return false;
    }
    if (afterWait !== "none") {
      await this.smartWait(afterWait);
    }
    return true;
  }

  /**
   * Клик по случайной точке на странице сразу **под** нижней границей
   * элемента (в координатах viewport). Закрывает перекрывающий календарь,
   * когда кнопка «Найти» оказывается под выпадашкой.
   *
   * @param {string} selector
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none', gapMin?: number, gapMax?: number}} [options]
   * @returns {Promise<boolean>}
   */
  async clickBelow(selector, options = {}) {
    const {
      afterWait = "micro",
      gapMin = 40,
      gapMax = 140,
    } = options;
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      this.log(`[stealth/clickBelow] ${selector} -> элемент не найден`);
      return false;
    }

    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    } catch (e) {
      this.log(`[stealth/clickBelow] scrollIntoView упал, продолжаю: ${e}`);
    }

    let box = null;
    try {
      box = await locator.boundingBox();
    } catch (e) {
      this.log(`[stealth/clickBelow] boundingBox упал: ${e}`);
    }
    if (
      !box ||
      !isFiniteNumber(box.width) ||
      !isFiniteNumber(box.height) ||
      box.width <= 0 ||
      box.height <= 0
    ) {
      this.log(`[stealth/clickBelow] ${selector} -> невалидный bbox`);
      return false;
    }

    const vp = this.page.viewportSize();
    const gap = randUniform(gapMin, gapMax);
    let x = box.x + box.width * randUniform(0.35, 0.65);
    let y = box.y + box.height + gap;
    if (vp) {
      const margin = randUniform(6, 18);
      x = Math.min(Math.max(x, margin), vp.width - margin);
      y = Math.min(y, vp.height - margin);
    }
    if (y <= box.y + box.height) {
      y = box.y + box.height + randUniform(25, 55);
      if (vp) {
        const margin = randUniform(6, 18);
        y = Math.min(y, vp.height - margin);
      }
    }

    const target = { x, y };
    const waitBeforeClick = [
      Math.round(randUniform(40, 120)),
      Math.round(randUniform(140, 220)),
    ];
    const waitBetweenClick = [
      Math.round(randUniform(25, 60)),
      Math.round(randUniform(60, 110)),
    ];

    try {
      await this.cursor.actions.move(target);
    } catch (e) {
      this.log(`[stealth/clickBelow] actions.move упал: ${e}`);
      return false;
    }

    try {
      await this._fidgetCursor();
    } catch (e) {
      this.log(`[stealth/clickBelow] fidget: ${e}`);
    }

    try {
      await this.cursor.actions.click({
        waitBeforeClick,
        waitBetweenClick,
      });
      if (RAS_TRACE_STEALTH) {
        this.log(
          `[stealth/clickBelow] ${selector} OK точка≈(${x.toFixed(0)},${y.toFixed(0)})`,
        );
      }
    } catch (e) {
      this.log(`[stealth/clickBelow] actions.click упал: ${e}`);
      return false;
    }

    if (afterWait !== "none") {
      await this.smartWait(afterWait);
    }
    return true;
  }

  /**
   * Скачивание PDF: открывает race между человечным `click` и
   * `page.waitForEvent('download')`. Listener на 'download' ставится ДО
   * клика — иначе Playwright теряет событие.
   *
   * @param {string} selector
   * @param {string} downloadPath
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none'}} [options]
   * @returns {Promise<string>}
   */
  async downloadPdf(selector, downloadPath, options = {}) {
    const { afterWait = "micro" } = options;
    if (!downloadPath) {
      throw new Error(
        "StealthBrowserManager.downloadPdf: downloadPath is required",
      );
    }

    const dir = path.dirname(downloadPath);
    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (e) {
      this.log(`[stealth/download] не создал ${dir}: ${e}`);
    }

    const downloadPromise = this.page.waitForEvent("download", {
      timeout: 120_000,
    });

    let download;
    try {
      const clickPromise = this.click(selector, { afterWait: "none" });
      [download] = await Promise.all([downloadPromise, clickPromise]);
    } catch (e) {
      this.log(`[stealth/download] клик/ожидание download упало: ${e}`);
      throw e;
    }

    try {
      await download.saveAs(downloadPath);
    } catch (e) {
      this.log(`[stealth/download] saveAs(${downloadPath}) упал: ${e}`);
      throw e;
    }

    const suggested = download.suggestedFilename();
    this.log(
      `[stealth/download] ${selector} -> ${downloadPath} ` +
        `(server suggested: ${suggested})`,
    );

    if (afterWait !== "none") {
      await this.smartWait(afterWait);
    }
    return downloadPath;
  }
}

