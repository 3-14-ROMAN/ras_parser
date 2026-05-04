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
 *   - движения мыши идут по кривым Безье через ghost-cursor, никаких
 *     телепортаций; перед каждым кликом — рандомный offset от центра
 *     элемента + 1..3 микро-«ёрзания» (`cursor.moveBy`);
 *   - набор текста через `pressSequentially` с РАНДОМНОЙ per-char
 *     задержкой; при длине > 5 символов вставляем «задумчивую» паузу
 *     300..600 мс на случайной позиции в середине слова;
 *   - после каждого `click`/`type` гарантированно вызывается
 *     `smartWait(afterWait)` (по умолчанию 'micro'), чтобы антифрод
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
import { createCursor } from "ghost-cursor";

const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function randUniform(a, b) {
  return a + Math.random() * (b - a);
}

function randInt(a, b) {
  return Math.floor(randUniform(a, b + 1));
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
};

export class StealthBrowserManager {
  /**
   * @param {import('playwright').Page} page
   * @param {{logger?: (msg: string) => void}} [options]
   */
  constructor(page, options = {}) {
    if (!page) {
      throw new Error("StealthBrowserManager: page is required");
    }
    this.page = page;
    this.cursor = createCursor(page);
    this.log = options.logger ?? ((msg) => process.stdout.write(`${msg}\n`));
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
    this.log(
      `[stealth/wait] ${bucket.label}: сплю ${(waitMs / 1000).toFixed(2)}с`,
    );
    await SLEEP(waitMs);
    return waitMs;
  }

  /**
   * 1..3 микро-«ёрзания» курсором по 2..6 пикселей в случайных направлениях,
   * с микропаузами между ними. Имитирует человека, который «уже навёлся,
   * но ещё не нажал».
   */
  async _fidgetCursor() {
    const twitches = randInt(1, 3);
    for (let i = 0; i < twitches; i += 1) {
      const dx = randUniform(-5, 5);
      const dy = randUniform(-3, 3);
      try {
        await this.cursor.moveBy({ x: dx, y: dy });
      } catch (e) {
        this.log(`[stealth/fidget] moveBy упал, игнорирую: ${e}`);
        return;
      }
      await SLEEP(randUniform(20, 90));
    }
  }

  /**
   * Человечный клик по селектору:
   *   1. scrollIntoViewIfNeeded;
   *   2. вычисляем рандомный offset внутри «толстого ядра» элемента
   *      (30..70% по обеим осям) — НЕ кликаем в center/center;
   *   3. ghost-cursor двигает мышь в эту точку по кривой Безье;
   *   4. 1..3 микро-ёрзания через cursor.moveBy;
   *   5. кликаем «по месту» (selector=undefined) с рандомными
   *      hesitate/waitForClick;
   *   6. автоматический `smartWait(afterWait)` на выходе.
   *
   * @param {string} selector
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none'}} [options]
   * @returns {Promise<boolean>}
   */
  async click(selector, options = {}) {
    const { afterWait = "micro" } = options;
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      this.log(`[stealth/click] ${selector} -> элемент не найден`);
      return false;
    }

    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    } catch (e) {
      this.log(`[stealth/click] scrollIntoView упал, продолжаю: ${e}`);
    }

    let box = null;
    try {
      box = await locator.boundingBox();
    } catch (e) {
      this.log(`[stealth/click] boundingBox упал: ${e}`);
    }

    let destination = null;
    if (box) {
      const fx = randUniform(0.3, 0.7);
      const fy = randUniform(0.3, 0.7);
      destination = { x: box.width * fx, y: box.height * fy };
    }

    try {
      if (destination) {
        await this.cursor.move(selector, { destination });
      } else {
        await this.cursor.move(selector);
      }
    } catch (e) {
      this.log(
        `[stealth/click] cursor.move упал, fallback на cursor.click: ${e}`,
      );
      try {
        await this.cursor.click(
          selector,
          destination
            ? {
                destination,
                hesitate: Math.round(randUniform(40, 220)),
                waitForClick: Math.round(randUniform(25, 110)),
              }
            : {
                hesitate: Math.round(randUniform(40, 220)),
                waitForClick: Math.round(randUniform(25, 110)),
              },
        );
        if (afterWait !== "none") await this.smartWait(afterWait);
        return true;
      } catch (e2) {
        this.log(`[stealth/click] fallback cursor.click тоже упал: ${e2}`);
        return false;
      }
    }

    await this._fidgetCursor();

    const clickOpts = {
      hesitate: Math.round(randUniform(40, 220)),
      waitForClick: Math.round(randUniform(25, 110)),
    };
    try {
      await this.cursor.click(undefined, clickOpts);
      const offsetStr = destination
        ? `offset=(${destination.x.toFixed(0)},${destination.y.toFixed(0)})`
        : "offset=n/a";
      this.log(
        `[stealth/click] ${selector} OK ${offsetStr}, ` +
          `hesitate=${clickOpts.hesitate}мс, hold=${clickOpts.waitForClick}мс`,
      );
    } catch (e) {
      this.log(`[stealth/click] cursor.click (at-current) упал: ${e}`);
      return false;
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
        this.log(
          `[stealth/type] ${selector} <- "${chunk}" ` +
            `(per-char≈${charDelay.toFixed(0)}мс)`,
        );
        if (i === thinkPauseAfter) {
          const thinkMs = randUniform(300, 600);
          this.log(
            `[stealth/type] «задумчивая» пауза ${thinkMs.toFixed(0)}мс ` +
              `после "${chunk}"`,
          );
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

export default StealthBrowserManager;
