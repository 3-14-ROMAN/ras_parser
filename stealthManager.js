/**
 * StealthBrowserManager — тонкая обёртка над Playwright `Page`.
 *
 * Раньше тут жил театр анти-детекции (ghost-cursor с Безье-кривыми,
 * микро-ёрзания, паузы 1.5-4 сек на каждый клик/page). RAS детектит по
 * rate-limit на IP, а не по тому, как «по-человечески» движется мышь —
 * поэтому весь этот обвес был пустым жжением времени.
 *
 * Маркер автоматизации и рассинхрон UA/Client-Hints закрываются на уровне
 * контекста в `network/rasBrowserProfile.js` (ignoreDefaultArgs, init-script).
 *
 * Сохраняем тот же API (smartWait/click/type/pressKey/clickBelow/downloadPdf),
 * но реализуем через стандартные Playwright-методы и короткие фикс-паузы.
 */

import path from "node:path";
import fs from "node:fs";

const RAS_TRACE_STEALTH = process.env.RAS_TRACE_STEALTH === "1";

const SLEEP = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Короткие фиксированные паузы по контекстам. Все значения в миллисекундах.
 * Это то, что осталось от прежних long-tail распределений: достаточно
 * чтобы DOM/JS успел отрабатывать, но не превращается в час пустого ожидания.
 */
const WAIT_MS = {
  micro: 50,
  click: 80,
  reading: 300,
  api_delay: 150,
  pager: 120,
  ip_cooldown: 2000,
  warmup: 1500,
  proxy_flap: 800,
  equipment_swap: 8000,
  filter31_recheck: 90_000,
};

/**
 * Выбрать длительность паузы (мс) без сна — для планирования внешних таймеров.
 * @param {keyof typeof WAIT_MS} [actionType='click']
 */
export function sampleSmartWaitMs(actionType = "click") {
  return WAIT_MS[actionType] ?? WAIT_MS.click;
}

export class StealthBrowserManager {
  /**
   * @param {import('playwright').Page} page
   * @param {{logger?: (msg: string) => void}} [options]
   */
  constructor(page, options = {}) {
    if (!page) throw new Error("StealthBrowserManager: page is required");
    this.page = page;
    this.log = options.logger ?? ((msg) => process.stdout.write(`${msg}\n`));
  }

  /**
   * Async-фабрика осталась для обратной совместимости (раньше нужна была
   * для async-инициализации ghost-cursor; теперь — просто конструктор).
   * @param {import('playwright').Page} page
   * @param {{logger?: (msg: string) => void}} [options]
   * @returns {Promise<StealthBrowserManager>}
   */
  static async create(page, options = {}) {
    return new StealthBrowserManager(page, options);
  }

  /**
   * Единственный источник пауз в проекте.
   * @param {keyof typeof WAIT_MS} [actionType='click']
   * @returns {Promise<number>}
   */
  async smartWait(actionType = "click") {
    const ms = WAIT_MS[actionType] ?? WAIT_MS.click;
    if (RAS_TRACE_STEALTH) this.log(`[stealth/wait] ${actionType}: ${ms}мс`);
    await SLEEP(ms);
    return ms;
  }

  /**
   * Клик по селектору через стандартный Playwright `locator.click()`.
   * Параметр `afterWait` оставлен для совместимости со старыми вызовами.
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
    try {
      await locator.click({ timeout: 10_000 });
      if (RAS_TRACE_STEALTH) this.log(`[stealth/click] ${selector} OK`);
    } catch (e) {
      this.log(`[stealth/click] ${selector} упал: ${e}`);
      return false;
    }
    if (afterWait !== "none") await this.smartWait(afterWait);
    return true;
  }

  /**
   * Заполнение текстового поля. Используем `fill()` — мгновенно и без
   * перехвата input-event'ов сторонним JS.
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
      await locator.fill(text, { timeout: 10_000 });
      if (RAS_TRACE_STEALTH) this.log(`[stealth/type] ${selector} <- "${text}"`);
    } catch (e) {
      this.log(`[stealth/type] fill упал: ${e}`);
      return false;
    }
    if (afterWait !== "none") await this.smartWait(afterWait);
    return true;
  }

  /**
   * Нажатие клавиши в активном фокусе.
   * @param {string} key
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none'}} [options]
   * @returns {Promise<boolean>}
   */
  async pressKey(key, options = {}) {
    const { afterWait = "micro" } = options;
    if (!key || typeof key !== "string") return false;
    try {
      await this.page.keyboard.press(key);
    } catch (e) {
      this.log(`[stealth/key] press '${key}' упал: ${e}`);
      return false;
    }
    if (afterWait !== "none") await this.smartWait(afterWait);
    return true;
  }

  /**
   * Клик по точке сразу под нижней границей элемента — закрывает оверлей
   * календаря, который перекрывает кнопку «Найти».
   * @param {string} selector
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none', gapMin?: number, gapMax?: number}} [options]
   * @returns {Promise<boolean>}
   */
  async clickBelow(selector, options = {}) {
    const { afterWait = "micro", gapMin = 40, gapMax = 80 } = options;
    const locator = this.page.locator(selector).first();
    if ((await locator.count()) === 0) {
      this.log(`[stealth/clickBelow] ${selector} -> элемент не найден`);
      return false;
    }
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: 5_000 });
    } catch {
      /* ignore */
    }
    let box;
    try {
      box = await locator.boundingBox();
    } catch (e) {
      this.log(`[stealth/clickBelow] boundingBox упал: ${e}`);
      return false;
    }
    if (!box || box.width <= 0 || box.height <= 0) {
      this.log(`[stealth/clickBelow] ${selector} -> невалидный bbox`);
      return false;
    }
    const vp = this.page.viewportSize();
    const gap = (gapMin + gapMax) / 2;
    let x = box.x + box.width / 2;
    let y = box.y + box.height + gap;
    if (vp) {
      x = Math.min(Math.max(x, 8), vp.width - 8);
      y = Math.min(y, vp.height - 8);
    }
    try {
      await this.page.mouse.click(Math.round(x), Math.round(y));
    } catch (e) {
      this.log(`[stealth/clickBelow] mouse.click упал: ${e}`);
      return false;
    }
    if (afterWait !== "none") await this.smartWait(afterWait);
    return true;
  }

  /**
   * Скачивание PDF. Listener на 'download' ставится ДО клика —
   * иначе Playwright теряет событие.
   * @param {string} selector
   * @param {string} downloadPath
   * @param {{afterWait?: 'micro' | 'click' | 'reading' | 'none'}} [options]
   * @returns {Promise<string>}
   */
  async downloadPdf(selector, downloadPath, options = {}) {
    const { afterWait = "micro" } = options;
    if (!downloadPath) {
      throw new Error("downloadPdf: downloadPath is required");
    }
    try {
      fs.mkdirSync(path.dirname(downloadPath), { recursive: true });
    } catch (e) {
      this.log(`[stealth/download] не создал ${path.dirname(downloadPath)}: ${e}`);
    }
    const downloadPromise = this.page.waitForEvent("download", { timeout: 120_000 });
    const clickPromise = this.click(selector, { afterWait: "none" });
    const [download] = await Promise.all([downloadPromise, clickPromise]);
    await download.saveAs(downloadPath);
    this.log(`[stealth/download] ${selector} -> ${downloadPath}`);
    if (afterWait !== "none") await this.smartWait(afterWait);
    return downloadPath;
  }
}
