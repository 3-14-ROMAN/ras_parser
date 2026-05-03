/**
 * StealthBrowserManager — фасад над Playwright `Page`, который полностью
 * инкапсулирует работу с DOM «по-человечески», чтобы обходить
 * поведенческий анализ продвинутых антифрод-систем.
 *
 * Базовые принципы:
 *   - движения мыши идут по кривым Безье через ghost-cursor
 *     (createCursor(page).click(selector)) — никаких телепортаций;
 *   - набор текста через locator.pressSequentially с рандомной задержкой
 *     50..200 мс между нажатиями — имитируем живого набирающего;
 *   - паузы между действиями имеют long-tail распределение
 *     (короткие сценарии перебиваются «отвлечениями» на минуты),
 *     чтобы временные интервалы не выглядели машинно-равномерно;
 *   - скачивание PDF идёт через page.waitForEvent('download'),
 *     запускается в параллель с человечным кликом, файл сохраняется
 *     по указанному пути.
 */

import path from "node:path";
import fs from "node:fs";
import { createCursor } from "ghost-cursor";

const DEFAULT_TYPE_DELAY_MIN_MS = 50;
const DEFAULT_TYPE_DELAY_RANGE_MS = 150;

/**
 * Равномерное случайное число в [a, b).
 */
function randUniform(a, b) {
  return a + Math.random() * (b - a);
}

/**
 * sleep на ms миллисекунд (как `await sleep(1000)`).
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class StealthBrowserManager {
  /**
   * @param {import('playwright').Page} page — активная страница Playwright.
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
   * Человечный клик по селектору: ghost-cursor сам разыгрывает траекторию
   * (Bezier-кривая + микро-паузы) и добивает кликом. Перед самим кликом
   * прокручиваем элемент в зону видимости — без этого ghost-cursor
   * иногда мажет.
   *
   * @param {string} selector
   */
  async click(selector) {
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

    try {
      await this.cursor.click(selector);
      this.log(`[stealth/click] human-click по ${selector} OK`);
      return true;
    } catch (e) {
      this.log(`[stealth/click] ghost-cursor упал на ${selector}: ${e}`);
      return false;
    }
  }

  /**
   * Человечный набор текста: pressSequentially с рандомной задержкой
   * 50..200 мс на символ. Перед набором фокусируем поле кликом
   * через ghost-cursor, иначе антифрод видит фокус «из ниоткуда».
   *
   * @param {string} selector
   * @param {string} text
   */
  async type(selector, text) {
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

    try {
      await this.cursor.click(selector);
    } catch (e) {
      this.log(`[stealth/type] фокус-клик упал, fallback на locator.click: ${e}`);
      try {
        await locator.click();
      } catch (e2) {
        this.log(`[stealth/type] locator.click тоже упал: ${e2}`);
        return false;
      }
    }

    const delay =
      DEFAULT_TYPE_DELAY_MIN_MS + Math.random() * DEFAULT_TYPE_DELAY_RANGE_MS;
    try {
      await locator.pressSequentially(text, { delay });
      this.log(
        `[stealth/type] ${selector} <- "${text}" (avg-delay≈${delay.toFixed(0)}мс)`,
      );
      return true;
    } catch (e) {
      this.log(`[stealth/type] pressSequentially упал: ${e}`);
      return false;
    }
  }

  /**
   * Long-tail рандомизация пауз. Идея: реальный пользователь не
   * выдерживает одинаковые интервалы — иногда он отвлекается
   * на минуты. Машинный паттерн «всегда 1.5с между кликами»
   * легко детектится.
   *
   * actionType:
   *   - 'reading': 75% — 3..8с, 20% — 10..30с, 5% — 60..240с (отвлечение).
   *   - 'click':   90% — 0.3..1.5с, 10% — 2..5с.
   *
   * @param {'click' | 'reading'} [actionType='click']
   */
  async smartWait(actionType = "click") {
    const r = Math.random();
    let waitMs;
    let bucket;

    if (actionType === "reading") {
      if (r < 0.75) {
        waitMs = randUniform(3_000, 8_000);
        bucket = "reading/short";
      } else if (r < 0.95) {
        waitMs = randUniform(10_000, 30_000);
        bucket = "reading/medium";
      } else {
        waitMs = randUniform(60_000, 240_000);
        bucket = "reading/distracted";
      }
    } else {
      if (r < 0.9) {
        waitMs = randUniform(300, 1_500);
        bucket = "click/normal";
      } else {
        waitMs = randUniform(2_000, 5_000);
        bucket = "click/hesitation";
      }
    }

    this.log(
      `[stealth/wait] ${bucket}: сплю ${(waitMs / 1000).toFixed(2)}с`,
    );
    await sleep(waitMs);
    return waitMs;
  }

  /**
   * Скачивание PDF: открывает race между human-кликом и
   * page.waitForEvent('download'). Playwright требует, чтобы listener на
   * 'download' был установлен ДО клика, поэтому сначала Promise, потом
   * клик.
   *
   * @param {string} selector — кнопка/ссылка, инициирующая скачивание.
   * @param {string} downloadPath — куда сохранить файл (полный путь).
   * @returns {Promise<string>} — фактический путь сохранённого файла.
   */
  async downloadPdf(selector, downloadPath) {
    if (!downloadPath) {
      throw new Error("StealthBrowserManager.downloadPdf: downloadPath is required");
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
      [download] = await Promise.all([
        downloadPromise,
        this.cursor.click(selector),
      ]);
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
      `[stealth/download] ${selector} -> ${downloadPath} (server suggested: ${suggested})`,
    );
    return downloadPath;
  }
}

export default StealthBrowserManager;
