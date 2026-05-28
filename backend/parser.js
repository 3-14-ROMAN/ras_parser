/**
 * Сбор PDF-ссылок и справочника DocumentType с https://ras.arbitr.ru/.
 *
 * Поток: Chromium через мобильный прокси → форма поиска (категория 3.1, период,
 * РАК, статус) → первый POST /Search ловится для capture url/headers/body →
 * страницы 2..N идут прямым `page.request.post`. Бан/таймаут → `_recoverFrom`
 * через ProxyEscalator (changeIp → changeOperator → changeGeo, циклически).
 */

// Side-effect импорт первым: подхватывает .env через process.loadEnvFile()
// до того как config.js прочитает process.env на top-level.
import "./network/loadEnv.js";

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import util from "node:util";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { chromium } from "playwright";

import {
  CHANGE_GEO_COOLDOWN_SEC,
  CHANGE_IP_COOLDOWN_SEC,
  ESC_EQUIPMENT_COOLDOWN_SEC,
  ESC_MAX_IP_BEFORE_EQUIPMENT,
  ESC_MAX_OPERATOR_BEFORE_GEO,
  GEO_FILTERS,
  MP_API_TOKEN,
  MP_PROXY_ID,
  MP_PROXY_KEY,
  PROXY_PASS,
  PROXY_SERVER,
  PROXY_USER,
} from "./network/config.js";
import {
  ESC_LEVELS,
  EscalationExhausted,
  ProxyEscalator,
} from "./network/escalator.js";
import { RasProxyClient } from "./network/proxyClient.js";
import { StealthBrowserManager } from "./stealthManager.js";
import { closePool as _pgClosePool, isPgConfigured as _pgIsConfigured } from "./db/pgClient.js";
import {
  upsertActs as _pgUpsertActs,
  getActsDateBounds as _pgGetActsDateBounds,
} from "./db/actsRepo.js";
import { cleanupInvalidActs as _cleanupInvalidActs } from "./db/cleanupInvalidActs.js";
import {
  acquireSingleOrThrow as _leaseAcquire,
  releaseAll as _leaseReleaseAll,
  releaseDeadLocalLeases as _leaseReleaseDeadLocal,
  startHeartbeat as _leaseStartHeartbeat,
} from "./db/proxyLeases.js";
import {
  attachRasAntiDetectToContext,
  buildRasBrowserFingerprint,
  getRasChromiumLaunchAntiDetect,
} from "./network/rasBrowserProfile.js";
import { classifyMetadataResponse } from "./network/metadataResponseDetect.js";
import { probeRasViaProxy } from "./network/proxyPreflight.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PROJECT_DIR = __dirname;
// Транзитные артефакты (parsed_data/, debug/) живут в gitignored data/ в корне
// репозитория, а не рядом с исходником. Override — RAS_DATA_DIR.
const REPO_ROOT = path.resolve(__dirname, "..");
const DATA_DIR = process.env.RAS_DATA_DIR
  ? path.resolve(process.env.RAS_DATA_DIR)
  : path.join(REPO_ROOT, "data");

const BASE_URL = "https://ras.arbitr.ru/";
const PARSED_DATA_DIR = path.join(DATA_DIR, "parsed_data");
const OUT_PATH = path.join(PARSED_DATA_DIR, "document_types.json");

/**
 * Чекпоинт текущей позиции окна (дата) на диск — чтобы после краша / SIGINT
 * следующий запуск мог предложить «продолжить с того места».
 * Резюмировать дату из MAX(registration_date) в БД нельзя: если в текущем
 * окне ещё не успели сохраниться акты, или окно оказалось пустым (skip),
 * MAX отстаёт от реального положения. Поэтому ведём отдельный файл.
 */
const PARSER_STATE_PATH = path.join(PARSED_DATA_DIR, "parser_state.json");

const DEBUG_DIR = path.join(DATA_DIR, "debug");
/**
 * Панель комбобокса «Категория спора» по заголовку секции.
 * Якорь XPath устойчивее `#caseCategory` при дубликатах id / смене разметки.
 */
const RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG =
  "//h2[contains(@class,'b-part-header_category')]/following-sibling::div[contains(@class,'b-filter-padding')][1]";
const RAS_CATEGORY_COMBO_ROOT_XPATH =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}`;
const RAS_CATEGORY_DOWN_BUTTON_SEL =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}` +
  "//span[contains(@class,'down-button') and contains(@class,'js-down-button')]";
/** Если верстка потеряла `js-down-button`, остаётся `span.down-button`. */
const RAS_CATEGORY_DOWN_BUTTON_FALLBACK_SEL =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}` +
  "//span[contains(@class,'down-button')]";
/** Открытие списка категории кликом по полю, если стрелки нет в DOM. */
const RAS_CATEGORY_INPUT_CLICK_SEL =
  `xpath=${RAS_CATEGORY_COMBO_PANEL_XPATH_FRAG}` +
  "//input[contains(@class,'js-input')]";
/**
 * П. 3.1 в выпадающем списке категории: второй `.b-suggest_liquid-no-overflow`
 * на странице — панель «Категория спора» (первый — «Вид спора»).
 */
const RAS_SUPPLY_FILTER_31_LI_XPATH =
  "xpath=(//div[contains(@class,'b-suggest_liquid-no-overflow')])[2]" +
  "//li[contains(.,'3.1.') and contains(.,'договорам поставки')]";
const RAS_STATUS_FILTER_TOGGLE_XPATH =
  "xpath=//div[contains(@class,'ui-multiselect-bg')]" +
  "[.//span[contains(@class,'ui-multiselect-title') and contains(normalize-space(.),'Статус:')]]";
const RAS_STATUS_FINISHED_OPTION_XPATH =
  "xpath=//span[normalize-space(.)='Только завершенные']";
const RAS_DOC_TYPE_FILTER_TOGGLE_XPATH =
  "xpath=//div[contains(@class,'ui-multiselect-bg')]" +
  "[.//span[contains(@class,'ui-multiselect-title') and contains(normalize-space(.),'Тип документа:')]]";
const RAS_DOC_TYPE_DECISION_OPTION_XPATH =
  "xpath=//span[normalize-space(.)='Решение']";
const RAS_DOC_TYPE_APPEAL_OPTION_XPATH =
  "xpath=//span[contains(normalize-space(.),'Постановление апелляц')]";
const RAS_DOC_TYPE_CASSATION_OPTION_XPATH =
  "xpath=//span[contains(normalize-space(.),'Постановление кассац')]";
/** Период поиска: «с» и «по» (два поля дд.мм.гггг под #sug-dates). */
const RAS_PERIOD_DATE_FROM_XPATH =
  "xpath=(//div[@id='sug-dates']//input[@placeholder='дд.мм.гггг'])[1]";
const RAS_PERIOD_DATE_TO_XPATH =
  "xpath=(//div[@id='sug-dates']//input[@placeholder='дд.мм.гггг'])[2]";

/** «Ctrl→» внизу выдачи — следующая страница результатов. */
const RAS_PAGER_NEXT_XPATH =
  "xpath=//ul[@id='pages']/li[contains(@class,'rarr')]//a";
const DEBUG_RESPONSES = path.join(DEBUG_DIR, "debug_responses.txt");
const DEBUG_SCREENSHOT = path.join(DEBUG_DIR, "debug_page.png");
const DEBUG_HTML = path.join(DEBUG_DIR, "debug_page.html");
const DEBUG_SEARCH_DIR = path.join(DEBUG_DIR, "search");

/** Перезапусков браузера на одном окне при дубль-IP (защита от вечного цикла). */
const MAX_WINDOW_RECYCLES_AFTER_DUP_IP =
  Number.parseInt(process.env.RAS_MAX_DUP_IP_RECYCLES ?? "8", 10) || 8;

/** Детальные логи кликов и пауз stealthManager. */
const RAS_TRACE_STEALTH = process.env.RAS_TRACE_STEALTH === "1";

/** После changeIp пересоздавать Chromium (новые куки/сессия). */
const RECYCLE_BROWSER_AFTER_BANNED_L1 =
  (process.env.RAS_RECYCLE_BROWSER_AFTER_BANNED_L1 ?? "1") !== "0";

class RecycleWindowError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = "RecycleWindowError";
    this.lastPageNum = Number.isInteger(opts.lastPageNum) && opts.lastPageNum > 0
      ? opts.lastPageNum
      : null;
  }
}

/** Потолок страниц пейджера на одно календарное окно. */
const MAX_PAGES = Math.max(
  1,
  Number.parseInt(process.env.RAS_MAX_SEARCH_PAGES ?? "40", 10) || 40,
);

/** Раундов (8 попыток + recovery) на одну страницу до сдачи. */
const MAX_SEARCH_PAGE_DATA_ROUNDS = Math.max(
  5,
  Number.parseInt(process.env.RAS_MAX_SEARCH_PAGE_DATA_ROUNDS ?? "30", 10) || 30,
);

/** Подряд пустых окон до автостопа. ≤0 — без лимита. */
const RAS_EMPTY_WINDOW_STREAK_LIMIT = (() => {
  const n = Number.parseInt(process.env.RAS_EMPTY_WINDOW_STREAK_LIMIT ?? "0", 10);
  return Number.isFinite(n) ? n : 0;
})();
/** Каждые N страниц пейджера — проверка заголовков РАК/Статус. */
const FILTER_PAGER_TITLE_RECHECK_EVERY = 3;
/** Таймаут ожидания POST /Search после «Найти» (мс), минимум 5с. */
const WAIT_FOR_SEARCH_MS = Math.max(
  5_000,
  Number.parseInt(process.env.RAS_WAIT_SEARCH_MS ?? "60000", 10) || 60_000,
);
/**
 * Дополнительная пауза после goto BASE_URL и `smartWait('warmup')` —
 * pravocaptcha-JS на ras.arbitr.ru делает background challenge ПОСЛЕ
 * DOMContentLoaded; без неё первый POST /Search на свежем IP может
 * прилететь tokenFrom-HTML (видели в PDF-flow, см. PDF_PRAVO_WAIT_MS).
 * 0 → отключено (старое поведение).
 */
const RAS_META_PRAVO_WAIT_MS = Math.max(
  0,
  Number.parseInt(process.env.RAS_META_PRAVO_WAIT_MS ?? "2500", 10) || 0,
);
/** Сколько antifraud_gate подряд переживаем до эскалации `_recoverFrom`. */
const META_ANTIFRAUD_GATE_RECOVER_AFTER = Math.max(
  1,
  Number.parseInt(process.env.RAS_META_ANTIFRAUD_GATE_RECOVER_AFTER ?? "3", 10) || 3,
);

/**
 * Hard deadline на ОДНУ попытку `_setupSearchSession` (поднять сессию: goto →
 * 3.1 → «Найти» → РАК → Статус). Без него `_stealth.click()` без явного таймаута
 * мог зависнуть навечно — watchdog убивал процесс, supervisor рестартил,
 * терялся весь Map текущего прогона. С deadline неудачная попытка отваливается
 * сама, цикл переходит к следующей попытке.
 *
 * Бюджет на 1 attempt (см. логи реальных прогонов):
 *   warmup ~5с + pravocaptcha 2.5с + 3.1 ~5с + waitForResponse «Найти» 60с
 *   + 3 RAK-retry × 45с + статус ~30с ≈ 240с. С запасом — 270с.
 */
const SETUP_ATTEMPT_DEADLINE_MS = Math.max(
  60_000,
  Number.parseInt(process.env.RAS_SETUP_ATTEMPT_DEADLINE_MS ?? "270000", 10) || 270_000,
);

const _sleepMs = (ms) =>
  ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();

/**
 * Promise.race с таймаутом. На таймауте reject'ит с понятным сообщением;
 * исходный promise не отменяется (Playwright API не даёт отмены извне), но
 * результат игнорируется. Применяется к `_setupSearchSession` и подобным
 * длинным операциям, у которых внутри есть `await` без явного timeout
 * (`_stealth.click()`), чтобы залипание DOM не подвешивало процесс навечно.
 */
function _withTimeout(promise, ms, label) {
  let timer = null;
  const timed = new Promise((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`${label}: hard deadline ${Math.floor(ms / 1000)}s превышен`));
    }, ms);
    if (typeof timer.unref === "function") timer.unref();
  });
  return Promise.race([promise, timed]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

const DEFAULT_HEADLESS = (process.env.RAS_HEADLESS ?? "1") === "1";
const XVFB_DISPLAY_NUM = String(process.env.RAS_DISPLAY_NUM ?? "99").trim() || "99";
const XVFB_DISPLAY_ID = `:${XVFB_DISPLAY_NUM}`;
const XVFB_SCREEN_GEOMETRY = process.env.RAS_SCREEN_GEOMETRY ?? "1920x1080x24";

const documentTypes = {};
const decisionLinks = new Map();
const MODE_TYPES = "types";
const MODE_DECISION_LINKS = "decision_links";
/**
 * «Специфичные» TypeId — три RAS-категории, у которых InstanceLevel и Court
 * в метаданных всегда соответствуют документу. Это базовый набор для отбора
 * итоговых мотивированных актов. Можно переопределить через RAS_TARGET_TYPE_IDS
 * или CLI-промпт, но дефолт — именно эти три.
 */
const DEFAULT_DECISION_TYPE_IDS = [
  "75babf17-1eef-40df-b51a-92957310aab7", // Решение (1-я инст.)
  "edac92ae-4dbe-49d7-8412-2fc7f4d5e827", // Постановление апелляции
  "ae1a12e4-23b3-4f9a-9c26-3793218ea772", // Постановление кассации
];

/**
 * Зонтичный TypeId «Решения и постановления» — служебная категория RAS, в
 * которой смешаны и итоговые мотивированные акты, и резолютивки/судприказы.
 * Внутри зонта различает реальный жанр первый GUID `ContentTypesString`.
 *
 * Правило выведено по выборке март 2024/2025/2026 (47 991 запись) и
 * валидировано на 2-й неделе апреля 2022–2026 (20 144 raw → 8 131 KEEP).
 */
const UMBRELLA_DECISION_TYPE_ID = "23f4baa9-e7cc-407a-aba7-11dd8772aa3b";

/** Жанры внутри umbrella, которые считаем итоговыми мотивированными актами. */
const UMBRELLA_FINAL_GENRE_GUIDS = new Set([
  "1c35af3f-06d5-4b90-b4be-5a3c4148d8be", // Решение суда первой инстанции
  "08f888a2-83ad-4fdf-8985-f77fe2085f11", // Мотивированное решение упрощённого производства
  "1d294878-a2f8-471d-a55b-faee3b33da53", // Постановление апелляции
  "08cbe371-f82b-423b-9252-3211c4a3f52e", // Постановление апелляции (вариант, бывает IL=1)
  "b74eecb7-28bd-470d-89bc-bc7fe46e8f6f", // Постановление апелляции по существу спора
  "9d26156d-a770-43cf-81f9-def01baf3e77", // Постановление кассации
  "171b5aca-eaa6-4e2b-b68c-42489b2e100c", // Постановление кассации (вариант, бывает IL=1)
  "cfd700af-8d88-4171-99d5-7ed2008657c3", // Решение кассации (68-ФЗ, IL=1 — норма)
  "db0af13c-2d10-4677-812e-c55e90a894bd", // Дополнительное решение
  "8a67b151-5fb1-4fe0-9068-24a5895d41ba", // Дополнительное постановление
]);

/**
 * Маппинг жанра umbrella в реальный InstanceLevel. Для umbrella-записей
 * `InstanceLevel` отражает карточку дела, а не сам документ (пример: акты
 * 17-го ААС часто приходят с Court="АС Пермского края" и IL=1). Истинная
 * инстанция определяется по жанру.
 */
const GENRE_TO_INSTANCE_LEVEL = new Map([
  ["1c35af3f-06d5-4b90-b4be-5a3c4148d8be", 1],
  ["08f888a2-83ad-4fdf-8985-f77fe2085f11", 1],
  ["db0af13c-2d10-4677-812e-c55e90a894bd", 1],
  ["cfd700af-8d88-4171-99d5-7ed2008657c3", 1],
  ["1d294878-a2f8-471d-a55b-faee3b33da53", 2],
  ["08cbe371-f82b-423b-9252-3211c4a3f52e", 2],
  ["b74eecb7-28bd-470d-89bc-bc7fe46e8f6f", 2],
  ["8a67b151-5fb1-4fe0-9068-24a5895d41ba", 2],
  ["9d26156d-a770-43cf-81f9-def01baf3e77", 3],
  ["171b5aca-eaa6-4e2b-b68c-42489b2e100c", 3],
]);

const UMBRELLA_DECISION_TYPE_ID_NORMALIZED = UMBRELLA_DECISION_TYPE_ID; // hex-only — нормализуется в себя

/**
 * Специфичный TypeId → истинная инстанция документа. TypeId сам по себе фиксирует уровень
 * (решение 1-й, постановление апелляции, постановление кассации), `item.InstanceLevel`
 * для known TypeId мы НЕ используем — один источник правды (см. _resolveInstanceLevel).
 */
const SPECIFIC_TYPE_ID_TO_INSTANCE_LEVEL = new Map([
  ["75babf17-1eef-40df-b51a-92957310aab7", 1],
  ["edac92ae-4dbe-49d7-8412-2fc7f4d5e827", 2],
  ["ae1a12e4-23b3-4f9a-9c26-3793218ea772", 3],
]);

/** Известный «мусор» внутри umbrella — отбрасывается без алёрта (см. CLAUDE.md). */
const UMBRELLA_KNOWN_NOISE_GUIDS = new Set([
  "c922ae18-151f-4fda-93d7-b442d4555a06", // резолютивка упрощёнки
  "e6dd1e2a-d64e-44bb-8ef2-614d53e432a1", // судебный приказ
  "e2bf364f-e3a2-4431-8d45-aaf7f5732679", // банкротство физлица
]);

/**
 * Класс действия акта — для определения «качаем или параша» (verdict.keep).
 * Полярность из `outcome_polarity.json` говорит «полезно ли это инициатору», а action —
 * форма действия суда (что именно произошло), которая решает судьбу акта в RAG.
 */
const OUTCOME_ACTION = Object.freeze({
  GRANT: "grant",                   // удовлетворить иск/требование (substantive)
  DENY: "deny",                     // отказать в иске (substantive)
  UPHOLD_LOWER: "uphold_lower",     // оставить без изменения — финал лежит ниже
  CANCEL_NEW: "cancel_new",         // отменить + принять новый — этот акт ЕСТЬ финал
  MODIFY: "modify",                 // изменить + (часто) принять новый
  CANCEL_RESTORE_LOWER: "cancel_restore_lower", // касса отменила апелляцию, оставила в силе 1-ю
  REMAND: "remand",                 // направить на новое рассмотрение
  TERMINATE: "terminate",           // прекратить производство по делу/жалобе
  LEAVE_UNCONSIDERED: "leave_unconsidered", // оставить без рассмотрения / возврат заявления
  SETTLEMENT: "settlement",         // мировое соглашение
  WITHDRAWAL: "withdrawal",         // принять отказ от иска
  REOPEN: "reopen",                 // отменён по вновь открывшимся
  BANKRUPTCY_GRANT: "bankruptcy_grant", // признать банкротом (substantive в банкротном)
  PROCEDURAL: "procedural",         // расходы / пошлина / обеспечение — фон
  UNKNOWN: "unknown",
});

/** Action'ы, которые означают «есть рассмотрение по существу / выводы по делу». */
const SUBSTANTIVE_ACTIONS = new Set([
  OUTCOME_ACTION.GRANT,
  OUTCOME_ACTION.DENY,
  OUTCOME_ACTION.CANCEL_NEW,
  OUTCOME_ACTION.MODIFY,
  OUTCOME_ACTION.BANKRUPTCY_GRANT,
  OUTCOME_ACTION.UPHOLD_LOWER,
  OUTCOME_ACTION.CANCEL_RESTORE_LOWER,
]);

/** Action'ы, при которых дело не завершено по существу (новое рассмотрение / прекращение). */
const NON_RESOLVING_ACTIONS = new Set([
  OUTCOME_ACTION.REMAND,
  OUTCOME_ACTION.TERMINATE,
  OUTCOME_ACTION.SETTLEMENT,
  OUTCOME_ACTION.WITHDRAWAL,
  OUTCOME_ACTION.LEAVE_UNCONSIDERED,
  OUTCOME_ACTION.REOPEN,
]);

/** Action'ы, при которых акт точно НЕ финал по существу (per-act preliminary verdict). */
const SKIP_ACTIONS = new Set([
  OUTCOME_ACTION.REMAND,
  OUTCOME_ACTION.TERMINATE,
  OUTCOME_ACTION.SETTLEMENT,
  OUTCOME_ACTION.WITHDRAWAL,
  OUTCOME_ACTION.LEAVE_UNCONSIDERED,
  OUTCOME_ACTION.REOPEN,
  OUTCOME_ACTION.UPHOLD_LOWER,         // финал лежит на нижнем уровне
  OUTCOME_ACTION.CANCEL_RESTORE_LOWER, // финал — нижестоящий восстановленный акт
]);

/**
 * Приоритет при выборе ОДНОГО главного action из нескольких outcome-кодов одного акта.
 * Высший — решающий. «Процессуальный путь» (remand/...) > «уход в силу нижнего» >
 * «новый акт» > «удовлетворение по существу» > «фон».
 */
const ACTION_PRIORITY = Object.freeze({
  [OUTCOME_ACTION.REMAND]: 100,
  [OUTCOME_ACTION.TERMINATE]: 90,
  [OUTCOME_ACTION.SETTLEMENT]: 85,
  [OUTCOME_ACTION.WITHDRAWAL]: 85,
  [OUTCOME_ACTION.LEAVE_UNCONSIDERED]: 80,
  [OUTCOME_ACTION.REOPEN]: 75,
  [OUTCOME_ACTION.CANCEL_RESTORE_LOWER]: 70,
  [OUTCOME_ACTION.UPHOLD_LOWER]: 60,
  [OUTCOME_ACTION.CANCEL_NEW]: 55,
  [OUTCOME_ACTION.MODIFY]: 50,
  [OUTCOME_ACTION.GRANT]: 40,
  [OUTCOME_ACTION.DENY]: 35,
  [OUTCOME_ACTION.BANKRUPTCY_GRANT]: 30,
  [OUTCOME_ACTION.PROCEDURAL]: 5,
  [OUTCOME_ACTION.UNKNOWN]: 0,
});

let _currentMode = MODE_TYPES;

const _captured = {
  url: null,
  headers: null,
  body: null,
};

/** Растёт на каждый исходящий POST `/Search` — чтобы отличить новый поиск от уже пойманного шаблона. */
let _searchPostSeq = 0;

/**
 * Колбэк из `main()`: пересоздать Chromium + `_stealth` + перехват /Search.
 * Выставляется один раз при старте.
 * @type {null | (() => Promise<void>)}
 */
let _browserRecycleForDuplicateIp = null;
let _xvfbProcess = null;
/** true только когда main() уже в цикле окон — RecycleWindowError имеет смысл только там. */
let _inWindowLoop = false;
/**
 * Номер последней страницы, на которой стоял `_walkPagesForBody`, ОБНОВЛЯЕТСЯ
 * в начале каждой итерации pageNum. Нужен, чтобы при `_recoverFrom` →
 * `RecycleWindowError` сохранить позицию и main() после recycle браузера
 * продолжил окно с этой страницы, а не заново с 1-й (см. log:
 * `[main] resume с страницы N`). Без этого окно с TotalCount=685 (28 страниц)
 * на каждый таймаут вынужден был пройти первые N страниц вхолостую — POST
 * /Search × N жжёт прокси, ничего нового в Map не добавляет, риск watchdog.
 */
let _currentWalkPageNum = 1;

function _hasCmd(cmd) {
  const probe = spawnSync("bash", ["-lc", `command -v "${cmd}"`], {
    stdio: "ignore",
  });
  return probe.status === 0;
}

function _ensureVirtualDisplayForHeadful(sourceLabel) {
  if (process.platform !== "linux") return true;
  if (process.env.DISPLAY || process.env.WAYLAND_DISPLAY) return true;

  if (!_hasCmd("Xvfb")) {
    process.stdout.write(
      `[setup] ${sourceLabel}: DISPLAY не найден и Xvfb не установлен; ` +
        "переключаюсь в headless.\n",
    );
    return false;
  }

  process.stdout.write(
    `[setup] ${sourceLabel}: DISPLAY не найден; поднимаю Xvfb (${XVFB_DISPLAY_ID})...\n`,
  );
  try {
    _xvfbProcess = spawn("Xvfb", [XVFB_DISPLAY_ID, "-screen", "0", XVFB_SCREEN_GEOMETRY], {
      detached: true,
      stdio: "ignore",
    });
    _xvfbProcess.unref();
    process.env.DISPLAY = XVFB_DISPLAY_ID;
    process.stdout.write(`[setup] Xvfb запущен (DISPLAY=${XVFB_DISPLAY_ID}).\n`);
    return true;
  } catch (e) {
    process.stdout.write(
      `[setup] Xvfb не стартовал (${String(e)}); переключаюсь в headless.\n`,
    );
    _xvfbProcess = null;
    return false;
  }
}

function _sanitizeReplayHeaders(headers) {
  const h = { ...(headers || {}) };
  const dropList = new Set([
    "content-length",
    "host",
    ":authority",
    ":method",
    ":path",
    ":scheme",
  ]);
  for (const key of Object.keys(h)) {
    if (dropList.has(key.toLowerCase())) delete h[key];
  }
  return h;
}

// Rolling buffer для последних N XHR-событий — для диагностического дампа в
// `_dumpDebug` после первой сессии (см. ниже). Раньше был unbounded array,
// рос всю жизнь процесса; на месячных прогонах съедал заметную память.
const _RESPONSE_LOG_CAP = 200;
const _responseLog = [];
function _pushResponseLog(line) {
  _responseLog.push(line);
  if (_responseLog.length > _RESPONSE_LOG_CAP) {
    _responseLog.splice(0, _responseLog.length - _RESPONSE_LOG_CAP);
  }
}
let _firstItemLogged = false;
let _searchDumpIdx = 0;

/** @type {StealthBrowserManager | null} */
let _stealth = null;

let _escalator = null;

const monotonic = () => performance.now() / 1000;

function pad2(n) {
  return String(n).padStart(2, "0");
}

/**
 * Watchdog «тишины»: каждое log()-сообщение трактуется как heartbeat
 * прогресса. Если N миллисекунд (RAS_WATCHDOG_STUCK_MS, по умолчанию
 * 5 мин) ни одного лога — считаем процесс зависшим и аварийно выходим
 * с кодом 73, чтобы supervisor (pm2 / systemd / while-true wrapper)
 * пересоздал процесс с новой Playwright-сессией и (возможно) другим
 * proxy_key. Подробности — см. CLAUDE.md "Watchdog & автономность".
 */
let _lastProgressAt = Date.now();
let _watchdogTimer = null;
// Дефолт поднят со 120s до 300s после серии false-positive в setup-фазе:
// UI-recovery + 5 POST /Search × ~5–10с укладывались в 60–90с штатно, но на
// «горячем» прокси иногда тянулись 150–200с — watchdog убивал процесс зря,
// supervisor рестартил, Map текущего прогона терялся. С hard deadline на
// _setupSearchSession (150s) и _recoverListingUiAfterFailedRound (150s)
// watchdog должен срабатывать только когда деталь-уровневые таймауты НЕ
// поймали зависание — это уже настоящий ступор.
const _WATCHDOG_STUCK_MS = Math.max(
  60_000,
  Number(process.env.RAS_WATCHDOG_STUCK_MS) || 300_000,
);
const _WATCHDOG_INTERVAL_MS = Math.max(
  5_000,
  Number(process.env.RAS_WATCHDOG_INTERVAL_MS) || 30_000,
);
const _WATCHDOG_EXIT_CODE = 73;
let _watchdogStuckFired = false;
let _watchdogLastHeartbeatAt = 0;

function _noteProgress() {
  _lastProgressAt = Date.now();
}

function log(msg) {
  const d = new Date();
  const ts = `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  const text =
    typeof msg === "string"
      ? msg
      : msg instanceof Error
        ? `${msg.name}: ${msg.message}`
        : util.inspect(msg, {
            depth: 8,
            breakLength: 120,
            maxStringLength: 4_000,
          });
  process.stdout.write(`[${ts}] ${text}\n`);
  _noteProgress();
}

function _startStuckWatchdog() {
  if (_watchdogTimer !== null) return;
  _noteProgress();
  _watchdogTimer = setInterval(() => {
    const silentMs = Date.now() - _lastProgressAt;
    // Heartbeat: после 50% порога тишины — пишем каждые INTERVAL «жив».
    // Так Roman видит, что watchdog не сдох и сколько осталось до exit.
    if (silentMs >= _WATCHDOG_STUCK_MS / 2 && silentMs <= _WATCHDOG_STUCK_MS) {
      if (Date.now() - _watchdogLastHeartbeatAt >= _WATCHDOG_INTERVAL_MS - 500) {
        _watchdogLastHeartbeatAt = Date.now();
        try {
          process.stderr.write(
            `[watchdog] alive, silent=${Math.floor(silentMs / 1000)}s / ` +
              `${Math.floor(_WATCHDOG_STUCK_MS / 1000)}s\n`,
          );
        } catch {}
      }
      return;
    }
    if (silentMs <= _WATCHDOG_STUCK_MS) return;
    if (_watchdogStuckFired) return;
    _watchdogStuckFired = true;
    const silentSec = Math.floor(silentMs / 1000);
    const limitSec = Math.floor(_WATCHDOG_STUCK_MS / 1000);
    // Пишем напрямую в stderr — _log()-pipeline может быть тем самым,
    // что залип (или промежуточный буфер забит).
    try {
      process.stderr.write(
        `\n[watchdog] STUCK: нет прогресса в логах ${silentSec}s ` +
          `(> ${limitSec}s). Аварийный выход с кодом ${_WATCHDOG_EXIT_CODE}, ` +
          `supervisor должен пересоздать процесс. ` +
          `Подними RAS_WATCHDOG_STUCK_MS если это false-positive.\n`,
      );
      const recent = _responseLog
        .slice(-10)
        .map((l) => `  ${l}`)
        .join("\n");
      if (recent) {
        process.stderr.write(`[watchdog] последние HTTP-ответы:\n${recent}\n`);
      }
    } catch {}
    // Подождать секунду, чтобы stderr слили, и убить процесс жёстко.
    // Не используем graceful shutdown — он сам может залипнуть в context.close().
    setTimeout(() => {
      try {
        process.exit(_WATCHDOG_EXIT_CODE);
      } catch {}
    }, 1_000);
  }, _WATCHDOG_INTERVAL_MS);
  if (typeof _watchdogTimer.unref === "function") _watchdogTimer.unref();
}

function _stopStuckWatchdog() {
  if (_watchdogTimer === null) return;
  try {
    clearInterval(_watchdogTimer);
  } catch {}
  _watchdogTimer = null;
}

function _dumpSearchResponse(label, body, suffix = "json") {
  if (!process.env.RAS_DUMP_SEARCH) return null;
  try {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "debug");
    fs.mkdirSync(dir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const safeLabel = String(label).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
    const file = path.join(dir, `search-${ts}-${safeLabel}.${suffix}`);
    if (Buffer.isBuffer(body)) {
      fs.writeFileSync(file, body);
    } else if (typeof body === "string") {
      fs.writeFileSync(file, body, "utf-8");
    } else {
      fs.writeFileSync(file, JSON.stringify(body, null, 2), "utf-8");
    }
    log(`[dump] ${file}`);
    return file;
  } catch (e) {
    log(`[dump] ${label}: ${e}`);
    return null;
  }
}

function _detectChromiumExecutable() {
  // Берём самый свежий chromium-* бинарь из ms-playwright кеша.
  // Это нужно, чтобы не залипнуть на старом chromium, у которого
  // некоторые мобильные прокси отдают ERR_TUNNEL_CONNECTION_FAILED.
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  let stat;
  try {
    stat = fs.statSync(cache);
  } catch {
    return null;
  }
  if (!stat.isDirectory()) return null;

  const candidates = [];
  let entries;
  try {
    entries = fs.readdirSync(cache);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!name.startsWith("chromium-")) continue;
    const suffix = name.slice("chromium-".length);
    if (!/^\d+$/.test(suffix)) continue;
    const exe = path.join(cache, name, "chrome-linux64", "chrome");
    let estat;
    try {
      estat = fs.statSync(exe);
    } catch {
      continue;
    }
    if (estat.isFile()) {
      candidates.push([parseInt(suffix, 10), exe]);
    }
  }
  if (!candidates.length) return null;
  candidates.sort((a, b) => b[0] - a[0]);
  return candidates[0][1];
}

function _launchKwargs() {
  const anti = getRasChromiumLaunchAntiDetect();
  const kwargs = {
    headless: DEFAULT_HEADLESS,
    proxy: {
      server: PROXY_SERVER,
      username: PROXY_USER,
      password: PROXY_PASS,
    },
    ignoreDefaultArgs: anti.ignoreDefaultArgs,
    args: anti.args,
  };
  const exe = process.env.RAS_CHROME || _detectChromiumExecutable();
  if (exe) {
    kwargs.executablePath = exe;
  }
  return kwargs;
}

/** Временный профиль или фиксированный каталог (куки/LocalStorage между прогонами). */
function _resolveParserBrowserUserDataDir() {
  const persist = process.env.RAS_BROWSER_USER_DATA_DIR?.trim();
  if (persist) {
    const dir = path.resolve(persist);
    fs.mkdirSync(dir, { recursive: true });
    return { dir, persistent: true };
  }
  return {
    dir: fs.mkdtempSync(path.join(os.tmpdir(), "ras_chromium_")),
    persistent: false,
  };
}

function _isSearchUrl(u) {
  let pathname;
  try {
    pathname = new URL(u).pathname;
  } catch {
    return false;
  }
  return pathname.toLowerCase().endsWith("/search");
}

function _loadExisting() {
  const sourcePath = OUT_PATH;
  if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
    log(`[load] ${OUT_PATH} нет — стартуем с пустого справочника`);
    return;
  }
  let raw;
  try {
    raw = fs.readFileSync(sourcePath, "utf-8");
  } catch (e) {
    log(`[load] не прочитал ${sourcePath}: ${e}`);
    return;
  }
  if (!raw.trim()) return;

  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log(`[load] ${sourcePath} битый JSON (${e}) — игнорирую, не перезаписываю`);
    return;
  }
  if (data === null || typeof data !== "object" || Array.isArray(data)) {
    log(`[load] ${sourcePath} не dict (${typeof data}) — игнорирую`);
    return;
  }
  const pairs = [];
  for (const [k, v] of Object.entries(data)) {
    if (typeof v === "string" && typeof k === "string") {
      pairs.push([k, v]);
    }
  }
  const idToKey = new Map();
  const idToVal = new Map();
  for (const [nameKey, idVal] of pairs) {
    const idStr = String(idVal);
    if (!idToVal.has(idStr)) idToVal.set(idStr, idVal);
    const prevKey = idToKey.get(idStr);
    if (!prevKey) {
      idToKey.set(idStr, nameKey);
    } else if (_shouldUpgradeTypeLabel(prevKey, nameKey, idStr)) {
      idToKey.set(idStr, nameKey);
    }
  }
  for (const k of Object.keys(documentTypes)) delete documentTypes[k];
  for (const [idStr, nameKey] of idToKey) {
    documentTypes[nameKey] = idToVal.get(idStr);
  }
  log(
    `[load] из ${sourcePath}: записей=${pairs.length}, уникальных id=${idToKey.size}`,
  );
}

function _save() {
  fs.writeFileSync(
    OUT_PATH,
    JSON.stringify(documentTypes, null, 4),
    "utf-8",
  );
}

function _extractDocType(item) {
  let typeId = item.TypeId ?? item.DocumentTypeId ?? null;
  let typeName = null;

  const raw = item.Type ?? item.DocumentType;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    typeName = raw.Name ?? raw.name ?? null;
    if (typeId === null || typeId === undefined) {
      typeId = raw.Id ?? raw.id ?? null;
    }
  } else if (typeof raw === "string") {
    typeName = raw;
  }

  if (!typeName) {
    typeName = item.TypeName ?? item.DocumentTypeName ?? null;
  }

  return [typeId, typeName];
}

function _normalizeTypeIdsInput(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  return Array.from(
    new Set(
      s
        .split(/[,\s;]+/)
        .map((v) => _normalizeTypeIdValue(v))
        .filter(Boolean),
    ),
  );
}

function _normalizeTypeIdValue(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  // Терминальный ввод часто приходит как "uuid", 'uuid', [uuid], {uuid}.
  const cleaned = s.replace(/^[\s"'`[{(]+|[\s"'`\]})]+$/g, "").trim();
  return cleaned.toLowerCase();
}

function _buildDecisionPdfUrl(item) {
  const caseId = item?.CaseId ?? null;
  const docId = item?.Id ?? null;
  const fileName = item?.FileName ?? null;
  if (!caseId || !docId || !fileName) return null;
  return `https://kad.arbitr.ru/Document/Pdf/${caseId}/${docId}/${fileName}`;
}

function _buildCaseCardUrl(item) {
  const caseId = item?.CaseId ?? null;
  if (!caseId) return null;
  return `https://kad.arbitr.ru/Card/${caseId}`;
}

function _buildDecisionMetadata(item) {
  if (!item || typeof item !== "object" || Array.isArray(item)) return {};
  return { ...item };
}

function _buildDecisionRecord(item, typeId, pdfUrl) {
  const [typeIdFromItem, typeName] = _extractDocType(item);
  const cardUrl = _buildCaseCardUrl(item);
  const verdict = _classifyAct(item);
  const decisionTypeIdRaw = item?.DecisionTypeId ?? null;
  return {
    link: pdfUrl,
    pdfLink: pdfUrl,
    cardLink: cardUrl,
    typeId,
    typeName: typeName != null ? String(typeName).trim() || null : null,
    id: item?.Id ?? null,
    caseId: item?.CaseId ?? null,
    caseNumber: item?.CaseNumber ?? null,
    instanceNumber: item?.InstanceNumber ?? null,
    fileName: item?.FileName ?? null,
    registrationDate: item?.RegistrationDate ?? null,
    displayDate: item?.DisplayDate ?? null,
    court: item?.Court ?? null,
    decisionTypeId: decisionTypeIdRaw ? _normalizeTypeIdValue(decisionTypeIdRaw) : null,
    contentTypesString: item?.ContentTypesString ?? null,
    contentTypes: Array.isArray(item?.ContentTypes) ? item.ContentTypes : null,
    signatureInfo: item?.SignatureInfo ?? null,
    sphinxId: Number.isFinite(item?.SphinxId) ? item.SphinxId : null,
    documentCount: Number.isInteger(item?.DocumentCount) ? item.DocumentCount : null,
    // Сырой `InstanceLevel` из /Search (как RAS отдал; для umbrella отражает
    // уровень КАРТОЧКИ ДЕЛА, не самого документа — может расходиться с trueInstanceLevel).
    rawInstanceLevel: Number.isInteger(item?.InstanceLevel) ? item.InstanceLevel : null,
    // Истинный уровень инстанции документа: specific TypeId → жёсткая карта,
    // umbrella → жанр (firstCts). По этому полю кросс-резолвер группирует акты дела.
    trueInstanceLevel: verdict.realCourtLevel,
    // Финальный вердикт «качаем (1) / параша (0)». До первого _saveDecisionLinks
    // здесь стоит per-act preliminary значение; _resolveCaseVerdicts перед апсертом
    // в PG пересчитает с учётом цепочки инстанций (4 ИСХОДа из спеки).
    //   note=null      — простой случай (только 1-я инст. финал) либо не главный акт;
    //   note="засилено …" — финал ниже, потому что вышестоящие оставили в силе;
    //   note="отменено …" — финал на этом уровне;
    //   note="новое рассмотрение" / "прекращение" — keep=0, нет финала по существу.
    verdict: {
      keep: verdict.keep,
      note: null,
      action: verdict.action,
      outcomes: verdict.outcomes,
    },
    metadata: _buildDecisionMetadata(item),
    // На случай редкого расхождения сырого и нормализованного id типа.
    sourceTypeId: typeIdFromItem ?? null,
  };
}

/** Первый GUID из `ContentTypesString` (или пустая строка). */
function _firstContentTypesGuid(item) {
  const raw = item?.ContentTypesString;
  if (typeof raw !== "string" || !raw) return "";
  const idx = raw.indexOf(",");
  return (idx === -1 ? raw : raw.slice(0, idx)).trim();
}

/**
 * Двухуровневый фильтр «итоговый мотивированный акт?» для одной /Search-записи.
 *
 *   final_motivated_act =
 *     TypeId ∈ targetSpecificTids (нормализованный Set)
 *     OR (TypeId == UMBRELLA_DECISION_TYPE_ID
 *         AND firstGuid(ContentTypesString) ∈ UMBRELLA_FINAL_GENRE_GUIDS)
 *
 * Подробный разбор аномалий и обоснование — в CLAUDE.md, разделы
 * «Главное правило отбора» и «Аномалии метаданных».
 *
 * @param {any} item raw /Search-item
 * @param {Set<string>} targetSpecificTids нормализованные id «специфичных» TypeId
 * @returns {boolean}
 */
function _isFinalMotivatedAct(item, targetSpecificTids) {
  const tid = _extractDocumentTypeId(item);
  if (!tid) return false;
  if (targetSpecificTids && targetSpecificTids.has(tid)) return true;
  if (tid !== UMBRELLA_DECISION_TYPE_ID_NORMALIZED) return false;
  return UMBRELLA_FINAL_GENRE_GUIDS.has(_firstContentTypesGuid(item));
}

/**
 * Истинный уровень инстанции документа — НЕ доверяет `item.InstanceLevel`:
 *   1. Специфичный TypeId → SPECIFIC_TYPE_ID_TO_INSTANCE_LEVEL (TypeId сам фиксирует уровень).
 *   2. Umbrella → первый GUID `ContentTypesString` (жанр) через GENRE_TO_INSTANCE_LEVEL.
 *   3. Иначе (кастомный TypeId через RAS_TARGET_TYPE_IDS) → fallback на item.InstanceLevel.
 *
 * Зачем так: для umbrella `item.InstanceLevel` отражает карточку дела (например, IL=1
 * при постановлении 17-го ААС с Court="АС Пермского края"). Для consistency и для
 * specific TypeId тоже игнорируем `item.InstanceLevel` — один источник правды.
 * Сырое значение сохраняется отдельно в record.rawInstanceLevel для отладки/анализа.
 *
 * @param {any} item raw /Search-item
 * @param {string} [normalizedTid] заранее нормализованный TypeId (опционально, для скорости)
 * @returns {number|null}
 */
function _resolveInstanceLevel(item, normalizedTid) {
  const tid = normalizedTid ?? _extractDocumentTypeId(item);
  if (!tid) {
    const il = item?.InstanceLevel;
    return Number.isInteger(il) ? il : null;
  }
  const specific = SPECIFIC_TYPE_ID_TO_INSTANCE_LEVEL.get(tid);
  if (specific !== undefined) return specific;
  if (tid === UMBRELLA_DECISION_TYPE_ID_NORMALIZED) {
    const il = GENRE_TO_INSTANCE_LEVEL.get(_firstContentTypesGuid(item));
    if (Number.isInteger(il)) return il;
  }
  const fallback = item?.InstanceLevel;
  return Number.isInteger(fallback) ? fallback : null;
}

function _extractDocumentTypeId(item) {
  // В ответе RAS id типа документа чаще всего приходит в `TypeId`.
  // Пользователь задаёт именно DocumentTypeId, поэтому здесь считаем
  // TypeId и DocumentTypeId эквивалентными представлениями одного id.
  const raw =
    item?.DocumentTypeId ?? item?.TypeId ?? item?.DocumentType?.Id ?? item?.Type?.Id ?? null;
  if (raw === null || raw === undefined) return "";
  return _normalizeTypeIdValue(raw);
}

// ═════════════════════════════════════════════════════════════════════════════
//   КЛАССИФИКАТОР ИСХОДОВ + PER-ACT VERDICT
// ═════════════════════════════════════════════════════════════════════════════

/**
 * Классификация русского outcome-текста (полярность + action). Порядок regexp
 * важен — специфичные паттерны идут раньше. Покрывает 100% всех 81 GUID из
 * `outcome_polarity.json` и все 50 уникальных umbrella-текстов из выборки
 * `parsed_data3/`. Возвращает `OUTCOME_ACTION.UNKNOWN` при отсутствии совпадений.
 */
function _classifyActionByText(rawText) {
  const t = String(rawText ?? "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return OUTCOME_ACTION.UNKNOWN;

  // 1. Касса: отменить нижестоящее, оставить в силе ещё более нижнее (ст. 287 п.5 АПК)
  if (/отменить.+оставить в силе/.test(t)) return OUTCOME_ACTION.CANCEL_RESTORE_LOWER;

  // 2. Направление на новое рассмотрение (даже если перед этим отмена)
  if (/(направить|передать).+(на новое рассмотрение|новый рассмотр)/.test(t)) {
    return OUTCOME_ACTION.REMAND;
  }
  if (/направить вопрос на новое рассмотрение/.test(t)) return OUTCOME_ACTION.REMAND;

  // 3. Мировое / отказ от иска
  if (/(утвердить мировое|мировое соглашение)/.test(t)) return OUTCOME_ACTION.SETTLEMENT;
  if (/принять отказ от иска/.test(t)) return OUTCOME_ACTION.WITHDRAWAL;

  // 4. Прекращение производства
  if (/прекратить производство по делу/.test(t)) return OUTCOME_ACTION.TERMINATE;
  if (/прекратить производство по (апелляционной|кассационной|встречн)/.test(t)) {
    return OUTCOME_ACTION.TERMINATE;
  }

  // 5. Оставить без рассмотрения / возвратить заявление
  if (/оставить без рассмотрения/.test(t)) return OUTCOME_ACTION.LEAVE_UNCONSIDERED;
  if (/возвратить заявление/.test(t)) return OUTCOME_ACTION.LEAVE_UNCONSIDERED;

  // 6. Вновь открывшиеся / новые обстоятельства
  if (/(вновь открывшимся|новым обстоятельствам)/.test(t)) return OUTCOME_ACTION.REOPEN;
  if (/(назначить.+заседание|предварительное судебное заседание).+(вновь открывшимся|новым обстоятельствам)/.test(t)) {
    return OUTCOME_ACTION.REOPEN;
  }

  // 7. Оставить без изменения — нижестоящий акт остаётся финалом.
  //    Polarity: «Оставить без изменения <X>». Umbrella: «Оставить <X> без изменения, жалобу...».
  if (/оставить(?:.{0,160}?)?без изменения/.test(t)) return OUTCOME_ACTION.UPHOLD_LOWER;

  // 8. Отменить + принять новый / разрешить вопрос по существу — этот акт ЕСТЬ финал
  if (/(отменить|изменить).+(принять новый|разрешить вопрос по существу|и принять по делу новый)/.test(t)) {
    return /изменить/.test(t) ? OUTCOME_ACTION.MODIFY : OUTCOME_ACTION.CANCEL_NEW;
  }

  // 9. "Изменить решение/постановление/определение" — в polarity встречается
  if (/^изменить (решение|постановление|определение)/.test(t)) return OUTCOME_ACTION.MODIFY;

  // 10. "Отменить решение/постановление/определение [полностью|в части]" без сопутствующих —
  //     самостоятельный финал.
  if (/^отменить (полностью |в части )?(решение|постановление|определение|судебный акт)/.test(t)) {
    return OUTCOME_ACTION.CANCEL_NEW;
  }

  // 11. Удовлетворение иска/требования/ходатайства/заявления
  if (/(удовлетворить иск|иск удовлетворить|удовлетворить требование|удовлетворить (встречный иск|иное требование|ходатайство|заявление)|удовлетворить заявление)/.test(t)) {
    if (/(фз о несостоятельности|банкрот|финансового управляющего)/.test(t)) {
      return OUTCOME_ACTION.BANKRUPTCY_GRANT;
    }
    return OUTCOME_ACTION.GRANT;
  }
  if (/признать.+обоснованным.+банкрот/.test(t) || /признать.+гражданина банкротом/.test(t)) {
    return OUTCOME_ACTION.BANKRUPTCY_GRANT;
  }

  // 12. Отказ в иске / в удовлетворении ходатайства / в признании акта незаконным
  if (/(в иске отказать|отказать в иске|отказать во встречном иске)/.test(t)) {
    return OUTCOME_ACTION.DENY;
  }
  if (/отказать в удовлетворении (заявления|ходатайства)/.test(t)) {
    return OUTCOME_ACTION.DENY;
  }
  if (/отказать в признании/.test(t)) return OUTCOME_ACTION.DENY;
  if (/признать.+(незаконн|недействительн)/.test(t)) return OUTCOME_ACTION.GRANT;

  // 13. Процессуальные коды (расходы, пошлина, обеспечение, замена стороны, ...)
  if (/восстановить срок/.test(t)) return OUTCOME_ACTION.PROCEDURAL;
  if (/(судебные расходы|госпошлин|депозитного счета|правопреемник|обеспечительн|наложение ареста|отменить обеспечение|управляющ|веб-конференц|уменьшить размер госпошлины)/.test(t)) {
    return OUTCOME_ACTION.PROCEDURAL;
  }

  return OUTCOME_ACTION.UNKNOWN;
}

/**
 * Лениво загружает справочник полярности из `outcome_polarity.json`.
 * Map: guid → { polarity, text, action }. action — из `_classifyActionByText(text)`.
 */
let _OUTCOME_POL_BY_GUID = null;
function _getOutcomePolarityByGuid() {
  if (_OUTCOME_POL_BY_GUID) return _OUTCOME_POL_BY_GUID;
  _OUTCOME_POL_BY_GUID = new Map();
  const polarityPath = path.join(PROJECT_DIR, "outcome_polarity.json");
  let raw;
  try {
    raw = fs.readFileSync(polarityPath, "utf-8");
  } catch (e) {
    log(`[outcome] ⚠ ${polarityPath} не прочитан: ${e}. Verdict.action будет UNKNOWN для specific TypeId.`);
    return _OUTCOME_POL_BY_GUID;
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (e) {
    log(`[outcome] ⚠ ${polarityPath} битый JSON: ${e}.`);
    return _OUTCOME_POL_BY_GUID;
  }
  for (const polarity of ["positive", "negative", "neutral"]) {
    const arr = Array.isArray(data?.[polarity]) ? data[polarity] : [];
    for (const c of arr) {
      const guid = _normalizeTypeIdValue(c?.guid);
      if (!guid) continue;
      const text = typeof c?.text === "string" ? c.text : "";
      _OUTCOME_POL_BY_GUID.set(guid, {
        polarity,
        text,
        action: _classifyActionByText(text),
      });
    }
  }
  log(`[outcome] загружено ${_OUTCOME_POL_BY_GUID.size} outcome-кодов из ${polarityPath}`);
  return _OUTCOME_POL_BY_GUID;
}

/**
 * Возвращает список outcome-ов одного акта.
 * - specific TypeId: GUIDs из `ContentTypesString` (lookup по polarity dict);
 *     если GUID не в polarity — text-fallback по соответствующему `ContentTypes[i]`.
 * - umbrella TypeId: текст `ContentTypes[1]` (genre = ContentTypes[0] игнорируем).
 *     У genre'ов 08f888a2 / db0af13c / 8a67b151 (упрощёнка / доп. решение / доп.
 *     постановление) outcome в /Search отсутствует — список пуст, action верхнего уровня UNKNOWN.
 */
function _extractActOutcomes(item) {
  const typeId = _extractDocumentTypeId(item);
  const dict = _getOutcomePolarityByGuid();
  /** @type {Array<{ guid: string|null, text: string, polarity: string|null, action: string }>} */
  const out = [];

  if (typeId === UMBRELLA_DECISION_TYPE_ID_NORMALIZED) {
    const ct = Array.isArray(item?.ContentTypes) ? item.ContentTypes : [];
    const outcomeText = (ct[1] ?? "").trim();
    if (outcomeText) {
      out.push({
        guid: null,
        text: outcomeText,
        polarity: null,
        action: _classifyActionByText(outcomeText),
      });
    }
    return out;
  }

  // specific / кастомные TypeIds: outcome'ы — GUID'ы в ContentTypesString.
  // Параллельный массив `item.ContentTypes` обычно содержит соответствующие тексты;
  // используем как fallback, если GUID не в polarity (определения по обесп. мерам и т.п.).
  const raw = item?.ContentTypesString;
  if (typeof raw !== "string" || !raw) return out;
  const ctTexts = Array.isArray(item?.ContentTypes) ? item.ContentTypes : [];
  const guids = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < guids.length; i++) {
    const guid = _normalizeTypeIdValue(guids[i]);
    if (!guid) continue;
    const meta = dict.get(guid);
    if (meta) {
      out.push({ guid, text: meta.text, polarity: meta.polarity, action: meta.action });
      continue;
    }
    const fbText = typeof ctTexts[i] === "string" ? ctTexts[i].trim() : "";
    const fbAction = fbText ? _classifyActionByText(fbText) : OUTCOME_ACTION.UNKNOWN;
    out.push({ guid, text: fbText, polarity: null, action: fbAction });
  }
  return out;
}

/** Главный action из массива outcome'ов — по `ACTION_PRIORITY`. */
function _pickPrimaryAction(outcomes) {
  let best = OUTCOME_ACTION.UNKNOWN;
  let bestP = -1;
  for (const o of outcomes) {
    const p = ACTION_PRIORITY[o.action] ?? 0;
    if (p > bestP) {
      bestP = p;
      best = o.action;
    }
  }
  return best;
}

/**
 * Per-act preliminary вердикт «качаем или параша». Финальное значение проставит
 * кросс-CaseId резолвер (_resolveCaseVerdicts) перед апсертом в Postgres.
 *
 *   keep=false:  REMAND/TERMINATE/SETTLEMENT/WITHDRAWAL/LEAVE_UNCONSIDERED/REOPEN
 *                /UPHOLD_LOWER/CANCEL_RESTORE_LOWER/PROCEDURAL → точно НЕ финал.
 *   keep=false:  unknown action с непустыми outcomes — нераспознанная шелуха.
 *   keep=true:   umbrella + пустой ContentTypes[1] — это упрощёнка / доп. решение,
 *                жанр уже substantive, outcome RAS просто не отдал. Финал по сути.
 *   keep=true:   GRANT/DENY/CANCEL_NEW/MODIFY/BANKRUPTCY_GRANT.
 *
 * Кросс-резолвер далее пересчитает keep/note с учётом цепочки инстанций по делу.
 */
function _classifyAct(item) {
  const realCourtLevel = _resolveInstanceLevel(item);
  const outcomes = _extractActOutcomes(item);
  const action = _pickPrimaryAction(outcomes);

  let keep = true;
  if (SKIP_ACTIONS.has(action)) {
    keep = false;
  } else if (action === OUTCOME_ACTION.UNKNOWN) {
    keep =
      outcomes.length === 0
      && _extractDocumentTypeId(item) === UMBRELLA_DECISION_TYPE_ID_NORMALIZED;
  } else if (action === OUTCOME_ACTION.PROCEDURAL) {
    keep = false;
  }

  return { keep, action, realCourtLevel, outcomes };
}

/**
 * Очередь несохранённых ключей `decisionLinks` (id строки). Постгрес-апсерт
 * делаем инкрементально — на каждой странице /Search заливаем только новые
 * записи, а не весь Map целиком. На больших окнах это экономит сотни мегабайт
 * сетевого трафика и uppertime.
 */
const _pendingPgKeys = new Set();

/** Помечает строку как «нужно залить в PG в ближайший _saveDecisionLinks». */
function _markDecisionLinkPending(key) {
  if (key) _pendingPgKeys.add(key);
}

// ═════════════════════════════════════════════════════════════════════════════
//   КРОСС-CaseId РЕЗОЛВЕР (4 ИСХОДа из пользовательской спеки)
// ═════════════════════════════════════════════════════════════════════════════

/** "DD.MM.YYYY" → число YYYYMMDD для дешёвой сортировки. 0, если формат не тот. */
function _dateKey(s) {
  const m = String(s ?? "").match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  return m ? Number(m[3] + m[2] + m[1]) : 0;
}

/**
 * Выбирает «главный» акт инстанции из набора актов одного дела одного уровня.
 * Приоритет: substantive > non-resolving > procedural > unknown.
 * Внутри одной категории — самый поздний по registrationDate.
 */
function _pickMainActOfLevel(acts) {
  if (!acts || !acts.length) return null;
  const bucket = (a) => {
    const ac = a?.verdict?.action ?? OUTCOME_ACTION.UNKNOWN;
    if (SUBSTANTIVE_ACTIONS.has(ac)) return 3;
    if (NON_RESOLVING_ACTIONS.has(ac)) return 2;
    if (ac === OUTCOME_ACTION.PROCEDURAL) return 1;
    return 0;
  };
  let best = acts[0];
  for (const a of acts) {
    const bb = bucket(best);
    const ba = bucket(a);
    if (ba > bb) { best = a; continue; }
    if (ba < bb) continue;
    if (_dateKey(a.registrationDate) > _dateKey(best.registrationDate)) best = a;
  }
  return best;
}

/**
 * Определяет финал дела по цепочке main1 → main2 → main3 (4 ИСХОДа из спеки).
 * Возвращает { finalActId, notes } — id акта-финала и notes[actId] для комментариев.
 *
 *   ИСХОД 0:  любое NON_RESOLVING_ACTIONS на любом уровне → финала нет, все keep=0.
 *   ИСХОД 1:  1-я финал. Варианты: А (нет апел./касс.) / Б (апел. uphold) /
 *             В (апел.+касс. uphold) / Г (касс. cancel_restore_lower).
 *   ИСХОД 2:  Апелляция финал. А (касс. нет) / Б (касс. uphold апелляцию).
 *   ИСХОД 3:  Касс. финал (cancel_new / modify / grant / deny / bankruptcy_grant).
 */
function _resolveCaseFinal({ main1, main2, main3 }) {
  /** @type {Object<string,string>} actId → note */
  const notes = {};

  // ИСХОД 0
  for (const m of [main3, main2, main1]) {
    if (m && NON_RESOLVING_ACTIONS.has(m.verdict.action)) {
      return { finalActId: null, notes };
    }
  }

  // Касса substantive
  if (main3) {
    const a3 = main3.verdict.action;
    if (a3 === OUTCOME_ACTION.CANCEL_RESTORE_LOWER) {
      // ИСХОД 1.Г
      if (main1) {
        notes[main1.id] = "отменено апелляцией, восстановлено кассацией";
        return { finalActId: main1.id, notes };
      }
      return { finalActId: null, notes };
    }
    if (a3 === OUTCOME_ACTION.UPHOLD_LOWER) {
      if (main2 && (main2.verdict.action === OUTCOME_ACTION.CANCEL_NEW
                 || main2.verdict.action === OUTCOME_ACTION.MODIFY
                 || main2.verdict.action === OUTCOME_ACTION.GRANT
                 || main2.verdict.action === OUTCOME_ACTION.DENY)) {
        // ИСХОД 2.Б
        notes[main2.id] = "отменено решение 1-й инстанции, засилено кассацией";
        return { finalActId: main2.id, notes };
      }
      if (main1) {
        // ИСХОД 1.В (апел. + касс. uphold) или 1.Б+касс.
        notes[main1.id] = (main2 && main2.verdict.action === OUTCOME_ACTION.UPHOLD_LOWER)
          ? "засилено апелляцией и кассацией"
          : "засилено кассацией";
        return { finalActId: main1.id, notes };
      }
      return { finalActId: null, notes };
    }
    if (a3 === OUTCOME_ACTION.CANCEL_NEW
     || a3 === OUTCOME_ACTION.MODIFY
     || a3 === OUTCOME_ACTION.GRANT
     || a3 === OUTCOME_ACTION.DENY
     || a3 === OUTCOME_ACTION.BANKRUPTCY_GRANT) {
      // ИСХОД 3
      const hadSubstAppeal = main2 && (main2.verdict.action === OUTCOME_ACTION.CANCEL_NEW
                                    || main2.verdict.action === OUTCOME_ACTION.MODIFY
                                    || main2.verdict.action === OUTCOME_ACTION.GRANT
                                    || main2.verdict.action === OUTCOME_ACTION.DENY);
      notes[main3.id] = hadSubstAppeal
        ? "отменено решение апелляции, новый акт принят кассацией"
        : "отменено решение 1-й инстанции, новый акт принят кассацией";
      return { finalActId: main3.id, notes };
    }
    // a3 = procedural / unknown — касса нерешающая, фоллбэк ниже
  }

  // Апелляция (без substantive кассации)
  if (main2) {
    const a2 = main2.verdict.action;
    if (a2 === OUTCOME_ACTION.UPHOLD_LOWER) {
      // ИСХОД 1.Б
      if (main1) {
        notes[main1.id] = "засилено апелляцией";
        return { finalActId: main1.id, notes };
      }
      return { finalActId: null, notes };
    }
    if (a2 === OUTCOME_ACTION.CANCEL_NEW
     || a2 === OUTCOME_ACTION.MODIFY
     || a2 === OUTCOME_ACTION.GRANT
     || a2 === OUTCOME_ACTION.DENY
     || a2 === OUTCOME_ACTION.BANKRUPTCY_GRANT) {
      // ИСХОД 2.А
      notes[main2.id] = "отменено решение 1-й инстанции";
      return { finalActId: main2.id, notes };
    }
    if (a2 === OUTCOME_ACTION.CANCEL_RESTORE_LOWER) {
      if (main1) {
        notes[main1.id] = "восстановлено апелляцией";
        return { finalActId: main1.id, notes };
      }
      return { finalActId: null, notes };
    }
  }

  // Только 1-я (ИСХОД 1.А)
  if (main1) {
    const a1 = main1.verdict.action;
    if (a1 === OUTCOME_ACTION.GRANT
     || a1 === OUTCOME_ACTION.DENY
     || a1 === OUTCOME_ACTION.CANCEL_NEW
     || a1 === OUTCOME_ACTION.MODIFY
     || a1 === OUTCOME_ACTION.BANKRUPTCY_GRANT) {
      return { finalActId: main1.id, notes };
    }
    if (a1 === OUTCOME_ACTION.UNKNOWN) {
      // Только umbrella + пустой ContentTypes[1] (упрощёнка / доп. решение) → substantive финал.
      const isUmbrellaEmptyOutcome =
        (main1.verdict.outcomes?.length ?? 0) === 0
        && main1.typeId === UMBRELLA_DECISION_TYPE_ID_NORMALIZED;
      if (isUmbrellaEmptyOutcome) return { finalActId: main1.id, notes };
      return { finalActId: null, notes };
    }
    return { finalActId: null, notes };
  }

  return { finalActId: null, notes };
}

/** Объяснение для keep=0 акта: почему этот акт — не финал в своём деле. */
function _whyNotFinal(act, { main1, main2, main3, finalActId }) {
  const a = act?.verdict?.action;
  const sameLevelMain =
    act.trueInstanceLevel === 1 ? main1
    : act.trueInstanceLevel === 2 ? main2
    : act.trueInstanceLevel === 3 ? main3
    : null;
  if (sameLevelMain && sameLevelMain.id !== act.id) {
    return "вторичный акт инстанции (есть основной)";
  }
  if (finalActId == null) {
    if (a === OUTCOME_ACTION.REMAND) return "дело направлено на новое рассмотрение";
    if (a === OUTCOME_ACTION.TERMINATE) return "прекращение производства";
    if (a === OUTCOME_ACTION.SETTLEMENT) return "мировое соглашение";
    if (a === OUTCOME_ACTION.WITHDRAWAL) return "принят отказ от иска";
    if (a === OUTCOME_ACTION.LEAVE_UNCONSIDERED) return "оставлено без рассмотрения";
    if (a === OUTCOME_ACTION.REOPEN) return "пересмотр по новым/вновь открывшимся";
    if (a === OUTCOME_ACTION.PROCEDURAL) return "процессуальный акт";
    if (a === OUTCOME_ACTION.UPHOLD_LOWER) {
      return act.trueInstanceLevel === 3
        ? "кассация оставила в силе нижестоящее (нет нижестоящего в выгрузке)"
        : "апелляция оставила в силе 1-ю (нет 1-й в выгрузке)";
    }
    if (a === OUTCOME_ACTION.CANCEL_RESTORE_LOWER) {
      return "кассация вернула 1-ю в силу (нет 1-й в выгрузке)";
    }
    if (a === OUTCOME_ACTION.UNKNOWN) {
      return "outcome не распознан (нет GUID в outcome_polarity.json)";
    }
    if (main3 && NON_RESOLVING_ACTIONS.has(main3.verdict.action)) return "не финал: кассация прекратила/направила";
    if (main2 && NON_RESOLVING_ACTIONS.has(main2.verdict.action)) return "не финал: апелляция прекратила/направила";
    return "не финал";
  }
  // Финал есть, но это не он
  if (a === OUTCOME_ACTION.UPHOLD_LOWER) return "оставил в силе нижестоящее";
  if (a === OUTCOME_ACTION.CANCEL_RESTORE_LOWER) return "восстановил нижестоящее";
  if (act.trueInstanceLevel === 1) {
    if (main3 && (main3.id === finalActId)) return "отменено кассацией";
    if (main2 && (main2.id === finalActId)) return "отменено апелляцией";
  }
  if (act.trueInstanceLevel === 2) {
    if (main3 && (main3.id === finalActId)) return "отменено кассацией";
    if (main1 && (main1.id === finalActId)) return "1-я инстанция осталась финалом";
  }
  if (act.trueInstanceLevel === 3) {
    if (main1 && (main1.id === finalActId)) return "кассация вернула 1-ю в силу";
    if (main2 && (main2.id === finalActId)) return "кассация засилила апелляцию";
  }
  return "не финал";
}

/**
 * Кросс-CaseId резолвер: пересчитывает verdict.keep и verdict.note для всех актов
 * на основе цепочки инстанций каждого дела. Мутирует записи в `decisionLinksMap`.
 *
 * Идемпотентен: повторный вызов даст тот же результат. Безопасен к инкрементальному
 * добавлению актов — каждый _saveDecisionLinks вызывает резолвер заново.
 *
 * Если verdict.keep или verdict.note у записи изменился относительно предыдущего
 * состояния — `onChange(key)` помечает её как pending для свежего апсерта в PG.
 * Это критично: когда в окно прилетает апелляция/кассация по делу, по которому 1-я
 * инст. уже была залита в PG, мы должны обновить её verdict в БД.
 *
 * Видимость: резолвер видит только акты, уже в Map (записи, которые залиты в PG
 * до перезапуска парсера, в Map не подгружаются — см. _loadExistingDecisionLinks).
 *
 * @param {Map<string,object>} decisionLinksMap
 * @param {(key: string) => void} [onChange]
 */
function _resolveCaseVerdicts(decisionLinksMap, onChange) {
  /** @type {Map<string, Array<{ key: string, row: object }>>} caseId → pairs */
  const byCase = new Map();
  /** @type {Array} acts без caseId — оставляем per-act preliminary verdict */
  const orphans = [];
  for (const [key, row] of decisionLinksMap.entries()) {
    if (!row?.verdict) continue;
    const caseId = row.caseId;
    if (!caseId) { orphans.push({ key, row }); continue; }
    if (!byCase.has(caseId)) byCase.set(caseId, []);
    byCase.get(caseId).push({ key, row });
  }

  let keepCount = 0;
  let skipCount = 0;
  let casesWithFinal = 0;
  let casesNoFinal = 0;
  let changedCount = 0;

  for (const [caseId, pairs] of byCase.entries()) {
    const acts = pairs.map((p) => p.row);
    const il1 = acts.filter((a) => a.trueInstanceLevel === 1);
    const il2 = acts.filter((a) => a.trueInstanceLevel === 2);
    const il3 = acts.filter((a) => a.trueInstanceLevel === 3);
    const main1 = _pickMainActOfLevel(il1);
    const main2 = _pickMainActOfLevel(il2);
    const main3 = _pickMainActOfLevel(il3);
    const { finalActId, notes } = _resolveCaseFinal({ main1, main2, main3 });

    if (finalActId) casesWithFinal += 1; else casesNoFinal += 1;

    for (const { key, row } of pairs) {
      const isFinal = row.id != null && row.id === finalActId;
      const newKeep = isFinal;
      const newNote = isFinal
        ? (notes[row.id] ?? null)
        : _whyNotFinal(row, { main1, main2, main3, finalActId });
      const prevKeep = row.verdict.keep;
      const prevNote = row.verdict.note;
      if (prevKeep !== newKeep || prevNote !== newNote) {
        row.verdict.keep = newKeep;
        row.verdict.note = newNote;
        changedCount += 1;
        if (onChange) onChange(key);
      }
      if (newKeep) keepCount += 1; else skipCount += 1;
    }
  }

  for (const { row } of orphans) {
    if (row.verdict.keep) keepCount += 1; else skipCount += 1;
  }

  log(
    `[verdict] кросс-резолюция: дел=${byCase.size} ` +
      `(с финалом=${casesWithFinal}, без=${casesNoFinal}), ` +
      `keep=${keepCount}, skip=${skipCount}` +
      (orphans.length ? `, без caseId=${orphans.length}` : "") +
      (changedCount ? `, изменено=${changedCount}` : ""),
  );
  return { changedCount, keepCount, skipCount };
}

/**
 * Записать накопившийся буфер decisionLinks в Postgres (upsert в таблицу `acts`).
 *
 * Раньше тут писались JSON-чанки в parsed_data/decision_links_NNNN.json,
 * теперь канонический sink — таблица `acts` в PG (см. db/schema.sql).
 * Если RAS_PG_DSN/DATABASE_URL не задан и есть что писать — фатальная ошибка.
 *
 * Перед апсертом — кросс-CaseId пересчёт verdict.keep/note. Если он меняет
 * verdict ранее сохранённой записи (например, после апелляции по делу с уже
 * залитой 1-й инст.), такая запись помечается pending и переапсертится.
 *
 * Returns: { inserted, updated, skipped } для логирования.
 */
async function _saveDecisionLinks() {
  // Кросс-CaseId резолюция: мутирует verdict.keep/note по всему набору, помечает
  // изменённые записи как pending через _markDecisionLinkPending — чтобы они
  // тоже попали в текущий upsert, а не зависли в старом состоянии в PG.
  _resolveCaseVerdicts(decisionLinks, _markDecisionLinkPending);

  if (_pendingPgKeys.size === 0) {
    return { inserted: 0, updated: 0, skipped: 0 };
  }
  if (!_pgIsConfigured()) {
    throw new Error(
      "[save] DSN не задан, а парсер собирается писать acts. " +
        "Postgres теперь канонический sink (см. CLAUDE.md и db/schema.sql). " +
        "Поставь RAS_PG_DSN или DATABASE_URL в .env, прокати миграцию " +
        '`psql "$DSN" -f db/schema.sql` и запусти снова.',
    );
  }
  const rowsToWrite = [];
  for (const key of _pendingPgKeys) {
    const row = decisionLinks.get(key);
    if (row) rowsToWrite.push(row);
  }
  const t0 = performance.now();
  const { inserted, updated } = await _pgUpsertActs(rowsToWrite);
  const elapsed = (performance.now() - t0).toFixed(0);
  _pendingPgKeys.clear();
  // Счётчики по итогу кросс-резолюции (для оперативной видимости)
  let keepInBatch = 0;
  for (const r of rowsToWrite) if (r?.verdict?.keep) keepInBatch += 1;
  log(
    `[save/pg] acts: inserted=${inserted}, updated=${updated}, ` +
      `буфер=${rowsToWrite.length} (keep=${keepInBatch}), ` +
      `всего в Map=${decisionLinks.size}, ${elapsed}мс`,
  );

  // Cleanup безусловно после каждого save: идемпотентно, на чистой БД быстро
  // (LIMIT 200 partial scan). Не гейтим по changedCount, потому что:
  //   а) changedCount считается только по in-memory Map; если резолвер во
  //      время прошлого прогона флипнул вердикт, а cleanup не дожил (краш) —
  //      в этом прогоне changedCount был бы 0, но артефакт остался;
  //   б) гонка embed-worker'а: между селектором и upsert'ом верд может флипнуться,
  //      pre-upsert guard в embed/fullAct + embed/chunk помечает 'error',
  //      cleanup подбирает по vector_status='error' + verdict_keep IS FALSE.
  // Wrap'ом в try/catch: упадёт Qdrant/диск — парсер не валим, standalone-скрипт
  // `npm run cleanup:invalid` подберёт позже.
  try {
    await _cleanupInvalidActs({ log });
  } catch (e) {
    log(`[cleanup] FAIL ${e?.stack ?? e?.message ?? e}`);
  }

  return { inserted, updated, skipped: rowsToWrite.length - inserted - updated };
}

function _decisionLinkKeyFromRow(row) {
  const idKey = String(row?.id ?? "").trim();
  if (idKey) return idKey;
  return [
    String(row?.caseId ?? "").trim(),
    String(row?.fileName ?? "").trim(),
    String(row?.registrationDate ?? "").trim(),
  ].join("|");
}

/**
 * Раньше тут загружались JSON-чанки `decision_links_NNNN.json`. С переходом
 * на Postgres функция-стаб: канонический sink теперь PG, resume обеспечивается
 * через `ON CONFLICT (id) DO UPDATE` в actsRepo. В Map
 * остаются только записи, собранные в ТЕКУЩЕМ прогоне; счётчик «новых»
 * в логе считается относительно этого.
 *
 * Если когда-то надо будет в Map подгружать уже существующие id
 * (например, для in-memory dedup на resume) — сюда поселить
 * `SELECT id, file_name, ... FROM acts`.
 */
function _loadExistingDecisionLinks() {
  // no-op: см. комментарий выше + db/actsRepo.js (ON CONFLICT)
}

/**
 * Карточка дела на kad (HTML): в блоке «Категория спора» должен быть п. 3.1 (поставки).
 * GET через контекст страницы RAS — вкладка выдачи не уходит с arbitr.ru.
 *
 * @returns {Promise<boolean>}
 */
/**
 * Категория 3.1 (поставки) уже задана фильтром на RAS — серверной выдаче доверяем,
 * на kad.arbitr.ru за каждой карточкой не лезем. Если supplyFilter31 не выставлен,
 * собираем ссылки без проверки категории.
 *
 * @returns {Promise<{ added: number, skippedCategory: number }>}
 */
function _collectDecisionLinks(items, targetTypeIdsSet) {
  let added = 0;
  let umbrellaAdded = 0;
  for (const item of items) {
    if (!_isFinalMotivatedAct(item, targetTypeIdsSet)) continue;

    const documentTypeId = _extractDocumentTypeId(item);
    const pdfUrl = _buildDecisionPdfUrl(item);
    if (!pdfUrl) continue;

    const key =
      String(item?.Id ?? "").trim() ||
      [item?.CaseId ?? "", item?.FileName ?? "", item?.RegistrationDate ?? ""].join("|");
    if (!key || decisionLinks.has(key)) continue;

    decisionLinks.set(key, _buildDecisionRecord(item, documentTypeId, pdfUrl));
    _markDecisionLinkPending(key);
    added += 1;
    if (documentTypeId === UMBRELLA_DECISION_TYPE_ID_NORMALIZED) umbrellaAdded += 1;
  }
  return { added, umbrellaAdded, skippedCategory: 0 };
}

function _rebuildIdToKeyIndex() {
  const m = new Map();
  for (const k of Object.keys(documentTypes)) {
    m.set(String(documentTypes[k]), k);
  }
  return m;
}

function _isSyntheticTypeKey(key, idStr) {
  return key === `id_${idStr}`;
}

function _shouldUpgradeTypeLabel(oldKey, newName, idStr) {
  const nn = newName != null ? String(newName).trim() : "";
  if (!nn) return false;
  if (_isSyntheticTypeKey(oldKey, idStr)) return true;
  const ok = String(oldKey);
  if (nn.length > ok.length) return true;
  if (nn.length < ok.length) return false;
  return nn !== ok;
}

function _nameKeyTakenByOtherId(nameTrim, idStr) {
  if (!Object.prototype.hasOwnProperty.call(documentTypes, nameTrim)) {
    return false;
  }
  return String(documentTypes[nameTrim]) !== idStr;
}

function _processItems(items) {
  if (items.length && !_firstItemLogged) {
    const sample = items[0];
    if (sample && typeof sample === "object" && !Array.isArray(sample)) {
      log(`[items] ключи первого item: ${JSON.stringify(Object.keys(sample).sort())}`);
    }
    _firstItemLogged = true;
  }

  const idToKey = _rebuildIdToKeyIndex();
  let added = 0;
  let relabeled = 0;

  for (const item of items) {
    const [typeId, typeName] = _extractDocType(item);
    if (typeId === null || typeId === undefined) continue;

    const idStr = String(typeId);
    const nameTrim =
      typeName != null && String(typeName).trim()
        ? String(typeName).trim()
        : null;
    const placeholderKey = `id_${idStr}`;

    const curKey = idToKey.get(idStr);

    if (!nameTrim) {
      if (!curKey) {
        documentTypes[placeholderKey] = typeId;
        idToKey.set(idStr, placeholderKey);
        added += 1;
      }
      continue;
    }

    if (!curKey) {
      let storeKey = nameTrim;
      if (_nameKeyTakenByOtherId(nameTrim, idStr)) {
        log(
          `[items] id=${idStr}: имя «${nameTrim}» занято другим типом — ` +
            `ключ ${placeholderKey}`,
        );
        storeKey = placeholderKey;
      }
      documentTypes[storeKey] = typeId;
      idToKey.set(idStr, storeKey);
      added += 1;
      continue;
    }

    if (curKey === nameTrim) continue;

    if (!_shouldUpgradeTypeLabel(curKey, nameTrim, idStr)) continue;

    if (_nameKeyTakenByOtherId(nameTrim, idStr)) {
      log(
        `[items] id=${idStr}: не переименовываю в «${nameTrim}» — ` +
          "ключ занят другим id",
      );
      continue;
    }

    delete documentTypes[curKey];
    documentTypes[nameTrim] = typeId;
    idToKey.set(idStr, nameTrim);
    relabeled += 1;
  }

  return { added, relabeled };
}

function _onRequest(request) {
  if (request.method() === "POST" && _isSearchUrl(request.url())) {
    _searchPostSeq += 1;
  }
  const rtype = request.resourceType();
  if (rtype === "xhr" || rtype === "fetch" || rtype === "document") {
    _pushResponseLog(`REQ ${request.method()} ${rtype} ${request.url()}`);
  }
}

function _onRequestFailed(request) {
  const failure = request.failure()?.errorText || "<no failure text>";
  _pushResponseLog(
    `FAIL ${request.method()} ${request.resourceType()} ${request.url()} :: ${failure}`,
  );
  if (_isSearchUrl(request.url())) {
    log(`[net] /Search FAILED: ${failure}`);
  }
}

async function _onResponse(response) {
  const request = response.request();
  const rtype = request.resourceType();
  if (rtype === "xhr" || rtype === "fetch" || rtype === "document") {
    _pushResponseLog(
      `${response.status()} ${request.method()} ${rtype} ${response.url()}`,
    );
  }

  if (!_isSearchUrl(response.url())) return;
  if (request.method() !== "POST") return;

  const headers = response.headers();
  log(
    `[capture] /Search ответ status=${response.status()}, ct=${headers["content-type"] ?? "?"}`,
  );

  if (response.status() !== 200) {
    log(`[capture] /Search status=${response.status()} — пропуск захвата`);
    return;
  }

  // Только метаданные запроса — не трогаем response.body()/json(), иначе гонка
  // с `waitForResponse` в `_uiRunSearchFromForm` / `_uiClickPagerNext`.
  if (_captured.url === null) {
    _captured.url = response.url();
    _captured.headers = request.headers();
    _captured.body = request.postData();
    log(`[capture] Перехвачен POST ${response.url()}`);
    const reqBody = _captured.body;
    if (reqBody) {
      try {
        _dumpSearchResponse("page1-request", String(reqBody), "json");
      } catch (e) {
        log(`[capture] дамп тела запроса упал: ${e}`);
      }
    }
  }
}

function _findItemsAnywhere(data) {
  const candidates = [];
  if (data.Result && typeof data.Result === "object" && !Array.isArray(data.Result)) {
    candidates.push(data.Result.Items);
    candidates.push(data.Result.items);
  }
  candidates.push(data.Items);
  candidates.push(data.items);
  if (data.data && typeof data.data === "object" && !Array.isArray(data.data)) {
    candidates.push(data.data.Items);
  }
  for (const c of candidates) {
    if (Array.isArray(c) && c.length) return c;
  }
  return [];
}

/**
 * Ответ /Search сразу после «Найти» по периоду: если дел нет, блок с фильтрами
 * «Тип документа» / «Статус» не появляется — их нельзя кликать.
 *
 * @param {object|null} parsed тело ответа /Search (JSON)
 * @returns {boolean} true — выдача пустая, верхние фильтры трогать нельзя
 */
function _rasListingEmptyBeforeTopFilters(parsed) {
  if (!parsed || typeof parsed !== "object") return true;
  const result = parsed.Result;
  if (result == null || typeof result !== "object" || Array.isArray(result)) {
    return true;
  }
  const tc = result.TotalCount;
  if (typeof tc === "number") return tc === 0;
  return _findItemsAnywhere(parsed).length === 0;
}

/** Обновить шаблон POST /Search из ответа (request headers/body). */
function _syncCapturedFromSearchResponse(response) {
  try {
    const req = response.request();
    _captured.url = response.url();
    _captured.headers = req.headers();
    const pd = req.postData();
    if (pd) _captured.body = pd;
  } catch (e) {
    log(`[capture] _syncCapturedFromSearchResponse: ${e}`);
  }
}

/**
 * Дождаться конкретного ответа POST `/Search`, синхронизировать шаблон `_captured`,
 * вернуть разобранный JSON (для верхних фильтров РАК/«Статус», где подряд идут
 * несколько POST и нельзя цепляться за первый ответ).
 *
 * @param {Promise<import('playwright').Response>} respPromise
 * @param {string} dumpLabelPrefix
 * @param {number} [roundtripStartPerf] — `performance.now()` сразу перед `waitForResponse`
 *        для этого POST; если задан, в успешном ответе будет `roundtripMs` (ожидание до
 *        прихода ответа `/Search`, без парсинга JSON и без UI до клика).
 * @returns {Promise<{ ok: true, parsed: object, roundtripMs?: number } | { ok: false, reason: string }>}
 */
async function _awaitPostSearchJson(respPromise, dumpLabelPrefix, roundtripStartPerf) {
  let response;
  try {
    response = await respPromise;
  } catch (e) {
    void respPromise.catch(() => {});
    return { ok: false, reason: `wait-response: ${e}` };
  }
  const roundtripMs =
    typeof roundtripStartPerf === "number"
      ? performance.now() - roundtripStartPerf
      : undefined;
  _syncCapturedFromSearchResponse(response);
  let raw = null;
  try {
    raw = await response.body();
  } catch (e) {
    log(`[filter] ${dumpLabelPrefix} resp.body() упал: ${e}`);
  }
  if (raw !== null && raw !== undefined) {
    _dumpSearchResponse(
      `${dumpLabelPrefix}-status${response.status()}`,
      raw,
      "bin",
    );
  }
  if (response.status() !== 200) {
    return { ok: false, reason: `status=${response.status()}` };
  }
  let text = "";
  try {
    text =
      raw !== null && raw !== undefined
        ? raw.toString("utf8")
        : await response.text();
  } catch (e) {
    return { ok: false, reason: `read-body: ${e}` };
  }
  const ct = response.headers()["content-type"] ?? "";
  const cls = classifyMetadataResponse({
    contentType: ct,
    status: 200,
    bodyText: text,
  });
  if (
    cls.kind === "antifraud_gate" ||
    cls.kind === "html_unknown" ||
    cls.kind === "tiny"
  ) {
    log(
      `[antifraud] /Search ${dumpLabelPrefix}: kind=${cls.kind} ` +
        `markers=[${cls.markers.join(",")}] ct=${ct || "?"} bytes=${cls.bytes}`,
    );
    const tag = cls.markers.length ? cls.markers.join(",") : cls.kind;
    return { ok: false, reason: `antifraud_gate: ${tag}` };
  }
  try {
    const parsed = JSON.parse(text);
    return { ok: true, parsed, roundtripMs };
  } catch (e) {
    return { ok: false, reason: `json-decode: ${e}` };
  }
}


/** Прокси-туннель дрогнул: апстрим провайдера, не лечится ротацией IP — короткий backoff. */
function _isProxyTunnelFlap(err) {
  if (!err) return false;
  const s = `${err && err.message ? err.message : err}`;
  return /net::ERR_(EMPTY_RESPONSE|TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED|CONNECTION_CLOSED|CONNECTION_ABORTED)\b/i.test(
    s,
  );
}

/** Провайдер отверг логин/пароль прокси (конфиг, не сеть) — fail-fast, не крутим. */
function _isProxyAuthError(err) {
  if (!err) return false;
  const s = `${err && err.message ? err.message : err}`;
  return /net::ERR_(INVALID_AUTH_CREDENTIALS|PROXY_AUTH_REQUESTED|PROXY_AUTH_UNSUPPORTED)\b/i.test(
    s,
  );
}

/** Реальный отвал сети/таймаут — нужно крутить IP. Флапы туннеля сюда не входят. */
function _isRotatableNetworkError(err) {
  if (!err) return false;
  if (_isProxyTunnelFlap(err)) return false;
  if (_isProxyAuthError(err)) return false;
  const s = `${err && err.message ? err.message : err}`;
  return (
    /net::ERR_/i.test(s) ||
    /Timeout\s+\d+ms\s+exceeded/i.test(s) ||
    /timeout exceeded/i.test(s) ||
    /ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENETUNREACH|EAI_AGAIN/i.test(s)
  );
}

/** «Бан/throttle сайтом» по HTTP-коду: 403/429/451/5xx. Принимает число или строку с `status=NNN`. */
function _isLikelyBanned(errOrStatus) {
  if (errOrStatus === null || errOrStatus === undefined) return false;
  let code = null;
  if (typeof errOrStatus === "number") {
    code = errOrStatus;
  } else {
    const s = `${errOrStatus && errOrStatus.message ? errOrStatus.message : errOrStatus}`;
    const m = s.match(/status\s*[=:]?\s*(\d{3})/i);
    if (m) code = Number(m[1]);
  }
  if (code === null) return false;
  return (
    code === 403 ||
    code === 429 ||
    code === 451 ||
    (code >= 500 && code <= 525)
  );
}

function _shouldRotateIp(err) {
  return _isRotatableNetworkError(err) || _isLikelyBanned(err);
}

/** Сколько подряд `proxy_flap`-провалов терпим перед эскалацией ротации IP. */
const PROXY_FLAP_ROTATE_AFTER = 5;

/** Timeout для page.goto: настраивается, по умолчанию 45с.
 *  Раньше был хардкод 120с — на медленной/мёртвой прокси Roman прерывал
 *  процесс, не дождавшись Playwright-таймаута. 45с с большим запасом для
 *  голого GET через мобильный прокси. ENV: RAS_GOTO_TIMEOUT_MS. */
const GOTO_TIMEOUT_MS = Math.max(
  10_000,
  Number(process.env.RAS_GOTO_TIMEOUT_MS) || 45_000,
);

/** Timeout для прямого POST /Search через page.request.post. Раньше был хардкод
 *  60с × 8 попыток = до 8 минут на одну страницу с мёртвой прокси. Теперь
 *  30с — на здоровом канале запрос укладывается в 1-3с, 30с уже сигнал «прокси
 *  гниёт». ENV: RAS_SEARCH_POST_TIMEOUT_MS. */
const SEARCH_POST_TIMEOUT_MS = Math.max(
  5_000,
  Number(process.env.RAS_SEARCH_POST_TIMEOUT_MS) || 30_000,
);

/** Максимум попыток на одну страницу /Search. С recycle-after-rotate (см.
 *  _recoverFrom) дрочить старый TCP-туннель не надо — после первого fail
 *  крутим IP и recycle браузера. 4 попытки = две полных лестницы recovery.
 *  ENV: RAS_SEARCH_PAGE_MAX_ATTEMPTS. */
const SEARCH_PAGE_MAX_ATTEMPTS = Math.max(
  1,
  Number(process.env.RAS_SEARCH_PAGE_MAX_ATTEMPTS) || 4,
);

/** Preflight через undici перед каждым page.goto: лёгкий HTTP-probe через
 *  тот же прокси. Если 451/timeout — пропускаем дорогой Playwright-goto
 *  и сразу идём в _recoverFrom. По умолчанию ВКЛ, выключение `RAS_PARSER_PREFLIGHT=0`.
 *  Таймаут отдельный (быстро hands off, чтобы суммарно укладываться в watchdog). */
const PARSER_PREFLIGHT_ENABLED = !/^(0|off|no|false)$/i.test(
  String(process.env.RAS_PARSER_PREFLIGHT ?? "1").trim(),
);
const PARSER_PREFLIGHT_TIMEOUT_MS = Math.max(
  2_000,
  Number(process.env.RAS_PARSER_PREFLIGHT_TIMEOUT_MS) || 8_000,
);

/**
 * Возвращает true, если preflight через текущий прокси проходит (RAS отдал HTML).
 * Иначе false + лог. Никогда не throw'ит — preflight это «оптимизация», а не
 * жёсткий контракт; при ошибке вызывающий код просто пойдёт в обычный goto.
 */
async function _preflightCurrentProxy() {
  if (!PARSER_PREFLIGHT_ENABLED) return { ok: true, skipped: true };
  if (!PROXY_SERVER) return { ok: true, skipped: true };
  const res = await probeRasViaProxy({
    proxyServer: PROXY_SERVER,
    proxyUser: PROXY_USER,
    proxyPass: PROXY_PASS,
    targetUrl: BASE_URL,
    timeoutMs: PARSER_PREFLIGHT_TIMEOUT_MS,
  }).catch((e) => ({
    ok: false,
    status: null,
    latencyMs: 0,
    reason: `preflight crashed: ${e && e.message ? e.message : e}`,
    kind: "unknown",
  }));
  if (res.ok) {
    log(`[preflight] OK http=${res.status} ${res.latencyMs}ms (${res.reason})`);
  } else {
    log(
      `[preflight] FAIL kind=${res.kind} http=${res.status ?? "-"} ${res.latencyMs}ms: ${res.reason}`,
    );
  }
  return res;
}

/** Открывает страницу с ретраями: flap → smartWait, net/ban → `_recoverFrom`. */
async function _safeGoto(
  page,
  url,
  { maxAttempts = 200, sentinelSelector = null } = {},
) {
  let lastExc = null;
  let lastBanReason = null;
  let flapStreak = 0;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let banReason = null;
    let flapErr = null;
    // Preflight через текущий прокси (быстро, ~5-8с): если RAS отдаёт 451
    // или прокси таймаутит — пропускаем тяжёлый Chromium-goto и сразу идём
    // в _recoverFrom. Экономим до ~40с на каждой попытке с мёртвым IP.
    if (url.startsWith(BASE_URL) || url === BASE_URL.replace(/\/$/, "")) {
      const pf = await _preflightCurrentProxy();
      if (!pf.ok && !pf.skipped) {
        banReason = `preflight:${pf.kind}${pf.status ? `/http=${pf.status}` : ""}`;
        log(
          `[goto] Попытка ${attempt}/${maxAttempts}: preflight FAIL — ` +
            `пропускаю Chromium-goto, иду сразу в _recoverFrom (${banReason})`,
        );
        if (attempt >= maxAttempts) {
          lastBanReason = banReason;
          break;
        }
        lastBanReason = banReason;
        const rotated = await _recoverFrom(`safeGoto ${banReason}`);
        if (!rotated) {
          log("[goto] _recoverFrom не сработал — ip_cooldown и пробую снова");
          await _stealth.smartWait("ip_cooldown");
        }
        continue;
      }
    }
    try {
      log(`[goto] Попытка ${attempt}/${maxAttempts}: GET ${url}`);
      const resp = await page.goto(url, { waitUntil: "load", timeout: GOTO_TIMEOUT_MS });
      const status = resp ? resp.status() : null;

      if (status !== null && _isLikelyBanned(status)) {
        banReason = `http=${status}`;
        log(
          `[goto] Попытка ${attempt}/${maxAttempts}: HTTP ${status} — похоже на бан/throttle сайтом`,
        );
      } else if (sentinelSelector) {
        const sentinelOk = await page
          .locator(sentinelSelector)
          .first()
          .count()
          .then((c) => c > 0)
          .catch(() => false);
        if (!sentinelOk) {
          banReason = `no-sentinel(${sentinelSelector})`;
          log(
            `[goto] Попытка ${attempt}/${maxAttempts}: HTTP ${status}, ` +
              `но селектора ${sentinelSelector} нет — похоже на капчу/тех.страницу`,
          );
        } else {
          log(`[goto] Страница загружена (load, http=${status}, sentinel ok)`);
          return;
        }
      } else {
        log(`[goto] Страница загружена (load, http=${status})`);
        return;
      }
    } catch (e) {
      lastExc = e;
      if (_isProxyAuthError(e)) {
        log(
          `[goto] Попытка ${attempt}/${maxAttempts} провалена [proxy/auth]: ${e}`,
        );
        log(
          "[goto] провайдер отверг логин/пароль прокси — это НЕ лечится ротацией. " +
            "Проверь MP_PROXY_USER/MP_PROXY_PASS в .env и что parser запущен через " +
            "'npm start' / 'node --env-file=.env parser.js' (или что .env читается).",
        );
        throw e;
      }
      if (_isProxyTunnelFlap(e)) {
        flapErr = e;
        log(
          `[goto] Попытка ${attempt}/${maxAttempts} провалена [proxy/flap streak=${flapStreak + 1}]: ${e}`,
        );
      } else if (_isRotatableNetworkError(e)) {
        banReason = `net ${e && e.message ? e.message : e}`;
        log(`[goto] Попытка ${attempt}/${maxAttempts} провалена [proxy/net]: ${e}`);
      } else {
        log(`[goto] Попытка ${attempt}/${maxAttempts} провалена: ${e}`);
      }
    }

    if (banReason !== null) lastBanReason = banReason;
    if (attempt >= maxAttempts) break;

    if (flapErr !== null) {
      flapStreak += 1;
      if (flapStreak >= PROXY_FLAP_ROTATE_AFTER) {
        log(
          `[goto] ${flapStreak} прокси-флапов подряд — эскалирую через _recoverFrom, ` +
            `апстрим провайдера может зацепиться за другой IP/SIM`,
        );
        const rotated = await _recoverFrom(
          `safeGoto flap-streak=${flapStreak}`,
        );
        if (!rotated) {
          log(
            "[goto] _recoverFrom не сработал — отдельный ip_cooldown и продолжаю",
          );
          await _stealth.smartWait("ip_cooldown");
        }
        flapStreak = 0;
      } else {
        await _stealth.smartWait("proxy_flap");
      }
    } else if (banReason !== null) {
      flapStreak = 0;
      const rotated = await _recoverFrom(`safeGoto ${banReason}`);
      if (!rotated) {
        log("[goto] _recoverFrom не сработал — отдельный ip_cooldown и пробую снова");
        await _stealth.smartWait("ip_cooldown");
      }
    } else {
      flapStreak = 0;
      await _stealth.smartWait("reading");
    }
  }
  if (lastExc !== null) throw lastExc;
  if (lastBanReason !== null) {
    throw new Error(
      `[goto] ${url}: исчерпано ${maxAttempts} попыток, последняя причина: ${lastBanReason}`,
    );
  }
}


function _searchCaptured() {
  return _captured.url !== null;
}

async function _waitBrieflyForSearch(seconds) {
  const deadline = monotonic() + seconds;
  while (monotonic() < deadline) {
    if (_searchCaptured()) return true;
    await _stealth.smartWait("micro");
  }
  return _searchCaptured();
}

async function _categoryNativeSelectShowsSupply31(page) {
  try {
    const wrap = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    if ((await wrap.count()) === 0) return false;
    const sel = wrap.locator("select.select").first();
    if ((await sel.count()) === 0) return false;
    return await sel.evaluate((el) => {
      if (!el || el.selectedIndex < 0) return false;
      const opt = el.options[el.selectedIndex];
      if (!opt) return false;
      if (String(opt.value || "") === "3.1") return true;
      const t = (opt.textContent || "").replace(/\s+/g, " ").toLowerCase();
      return t.includes("3.1") && t.includes("поставк");
    });
  } catch {
    return false;
  }
}

/**
 * После тяжёлого обновления фильтров блок категории может кратко отсутствовать в DOM
 * или уехать из зоны рендера — прокручиваем заголовок и ждём появления стрелки комбобокса.
 *
 * @returns {Promise<boolean>}
 */
async function _ensureSupplyCategoryComboboxReady(page) {
  const header = page.locator("h2.b-part-header_category").first();
  try {
    if ((await header.count()) > 0) {
      await header.scrollIntoViewIfNeeded({ timeout: 15_000 });
    }
  } catch (e) {
    log(`[filter] scroll к заголовку «Категория спора»: ${e}`);
  }
  await _stealth.smartWait("micro");

  const deadline = monotonic() + 18;
  while (monotonic() < deadline) {
    const wrap = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    let probe = {
      hasWrap: false,
      downCount: 0,
      strictDownCount: 0,
      inputCount: 0,
    };
    if ((await wrap.count()) > 0) {
      probe = {
        hasWrap: true,
        downCount: await wrap.locator("span.down-button").count(),
        strictDownCount: await wrap
          .locator("span.down-button.js-down-button")
          .count(),
        inputCount: await wrap.locator("input.js-input").count(),
      };
    }
    if (probe.hasWrap && (probe.downCount > 0 || probe.inputCount > 0)) {
      try {
        if (probe.downCount > 0) {
          await page
            .locator(RAS_CATEGORY_DOWN_BUTTON_FALLBACK_SEL)
            .first()
            .scrollIntoViewIfNeeded({ timeout: 5_000 });
        } else {
          await page
            .locator(RAS_CATEGORY_INPUT_CLICK_SEL)
            .first()
            .scrollIntoViewIfNeeded({ timeout: 5_000 });
        }
      } catch {
        /* ignore */
      }
      log(`[filter-debug] категория UI готово: ${JSON.stringify(probe)}`);
      return true;
    }
    await _stealth.smartWait("micro");
  }

  const wrapEnd = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
  /** @type {{hasWrap:boolean,downCount:number,strictDownCount:number,inputCount:number}} */
  let probeEnd = {
    hasWrap: false,
    downCount: 0,
    strictDownCount: 0,
    inputCount: 0,
  };
  if ((await wrapEnd.count()) > 0) {
    probeEnd = {
      hasWrap: true,
      downCount: await wrapEnd.locator("span.down-button").count(),
      strictDownCount: await wrapEnd
        .locator("span.down-button.js-down-button")
        .count(),
      inputCount: await wrapEnd.locator("input.js-input").count(),
    };
  }
  log(`[filter-debug] категория UI не появилась за ожидание: ${JSON.stringify(probeEnd)}`);
  return false;
}

async function _categoryShowsSupply31(page) {
  if (await _categoryNativeSelectShowsSupply31(page)) {
    return true;
  }
  try {
    const box = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    if ((await box.count()) === 0) return false;
    const text = (await box.innerText()).replace(/\s+/g, " ").toLowerCase();
    return text.includes("3.1") && text.includes("поставк");
  } catch {
    return false;
  }
}

const RAK_TYPE_TITLE_NEEDLE = {
  decision: "решение",
  appeal: "апелляц",
  cassation: "кассац",
};

async function _rakDocFilterTitleLooksComplete(page, requestedSet) {
  if (!(requestedSet instanceof Set) || requestedSet.size === 0) return true;
  try {
    const toggle = page.locator(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH).first();
    const t = (await toggle.innerText()).replace(/\s+/g, " ").toLowerCase();
    for (const key of requestedSet) {
      const needle = RAK_TYPE_TITLE_NEEDLE[key];
      if (!needle || !t.includes(needle)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function _statusFilterTitleMatches(page, mode) {
  if (mode === null || mode === undefined) return true;
  if (mode !== "finished") return false;
  try {
    const toggle = page.locator(RAS_STATUS_FILTER_TOGGLE_XPATH).first();
    const t = (await toggle.innerText()).replace(/\s+/g, " ").toLowerCase();
    if (t.includes("только заверш")) return true;
    return t.includes("заверш") && !t.includes("не заверш") && !t.includes("незаверш");
  } catch {
    return false;
  }
}

/**
 * После «Найти», reload или иных сбоев — заголовки верхних фильтров должны
 * совпадать с выбранными режимами; иначе добиваем через UI (с POST только если
 * реально что-то поменяли).
 *
 * Порядок добива: РАК и «Статус», затем категория 3.1 — последний POST должен
 * соответствовать уже включённым верхним фильтрам (иначе можно было вернуть
 * JSON выдачи «до» выбора 3.1 и получить огромный TotalCount при уже узкой форме).
 *
 * @returns {Promise<{ ok: boolean, listingRepairParsed: object | null }>}
 */
async function _verifyListingFiltersOrRepair(page, uiFilters, supplyFilter31 = false) {
  const {
    rakDocumentTypeFilter = null,
    statusFinishedOnly = null,
  } = uiFilters;

  const rakActive = rakDocumentTypeFilter instanceof Set && rakDocumentTypeFilter.size > 0;
  if (
    rakActive &&
    !(await _rakDocFilterTitleLooksComplete(page, rakDocumentTypeFilter))
  ) {
    log("[filter-check] «Тип документа» по заголовку неполный — добиваю");
    if (!(await _applyRakDocumentTypeFilter(page, rakDocumentTypeFilter))) {
      return { ok: false, listingRepairParsed: null };
    }
  }
  if (
    statusFinishedOnly &&
    !(await _statusFilterTitleMatches(page, statusFinishedOnly))
  ) {
    log(
      `[filter-check] «Статус» по заголовку не «${statusFinishedOnly}» — добиваю`,
    );
    if (!(await _applyStatusFilter(page, statusFinishedOnly))) {
      return { ok: false, listingRepairParsed: null };
    }
  }

  if (supplyFilter31 && !(await _categoryShowsSupply31(page))) {
    log("[filter-check] категория 3.1 на форме не видна — добиваю дерево категории");
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const picked = await _applySupplyDisputeFilter31(page);
    if (!picked) {
      void respPromise.catch(() => {});
      return { ok: false, listingRepairParsed: null };
    }
    try {
      const response = await respPromise;
      if (response.status() !== 200) {
        log(
          `[filter-check] /Search после добива категории: status=${response.status()}`,
        );
        return { ok: false, listingRepairParsed: null };
      }
      _syncCapturedFromSearchResponse(response);
      let raw = null;
      try {
        raw = await response.body();
      } catch (e) {
        log(`[filter-check] resp.body() после добива категории: ${e}`);
      }
      const text =
        raw !== null && raw !== undefined
          ? raw.toString("utf8")
          : await response.text();
      const listingRepairParsed = JSON.parse(text);
      return { ok: true, listingRepairParsed };
    } catch (e) {
      log(`[filter-check] нет валидного /Search после добива категории: ${e}`);
      return { ok: false, listingRepairParsed: null };
    }
  }

  return { ok: true, listingRepairParsed: null };
}

/**
 * Открыть выпадающий список категорий и выбрать п. 3.1 (поставки).
 * Вызывается после warmup и до клика «Найти».
 *
 * @returns {Promise<boolean>}
 */
/**
 * Forсированный выбор 3.1 через нативный `<select>`. Используем когда UI-клик
 * по выпадающему `<li>` не сработал (RAS-комбобокс закрылся «слишком быстро»,
 * клик попал мимо и т.п.). jQuery-комбо подписан на `change` нативного select —
 * `selectOption` + явный dispatch гарантирует синхронизацию обоих.
 *
 * @returns {Promise<boolean>}
 */
async function _forceSupplyCategory31ViaNativeSelect(page) {
  try {
    const wrap = page.locator(RAS_CATEGORY_COMBO_ROOT_XPATH).first();
    if ((await wrap.count()) === 0) return false;
    const sel = wrap.locator("select.select").first();
    if ((await sel.count()) === 0) return false;
    await sel.selectOption({ value: "3.1" }, { timeout: 5_000 });
    // Триггерим события — RAS-комбо реагирует и на change, и на input.
    await sel.evaluate((el) => {
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("input", { bubbles: true }));
      if (window.jQuery) {
        try {
          window.jQuery(el).trigger("change");
        } catch {}
      }
    });
    return true;
  } catch (e) {
    log(`[filter] forceSupply via select упал: ${e}`);
    return false;
  }
}

async function _applySupplyDisputeFilter31(page) {
  if (await _categoryShowsSupply31(page)) {
    log("[filter] категория 3.1 (поставки) уже выбрана — пропуск кликов");
    return true;
  }
  log("[filter] категория спора 3.1 (договоры поставки): раскрываю список…");
  if (!(await _ensureSupplyCategoryComboboxReady(page))) {
    log(
      "[filter] контрол «Категория спора» не готов (нет панели по XPath / стрелки / поля ввода)",
    );
    return false;
  }
  const categoryClickSelectors = [
    RAS_CATEGORY_DOWN_BUTTON_SEL,
    RAS_CATEGORY_DOWN_BUTTON_FALLBACK_SEL,
    RAS_CATEGORY_INPUT_CLICK_SEL,
  ];

  const MAX_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let opened = false;
    for (let i = 0; i < categoryClickSelectors.length; i += 1) {
      const sel = categoryClickSelectors[i];
      log(
        `[filter] категория: попытка ${attempt}/${MAX_ATTEMPTS}, ` +
          `открытие списка способом ${i + 1}/${categoryClickSelectors.length}`,
      );
      opened = await _stealth.click(sel, { afterWait: "click" });
      if (opened) break;
      await _stealth.smartWait("micro");
    }
    if (!opened) {
      log(`[filter] попытка ${attempt}/${MAX_ATTEMPTS}: список не открылся`);
      continue;
    }

    const item = page.locator(RAS_SUPPLY_FILTER_31_LI_XPATH).first();
    try {
      await item.waitFor({ state: "visible", timeout: 8_000 });
    } catch (e) {
      log(
        `[filter] попытка ${attempt}/${MAX_ATTEMPTS}: пункт 3.1 не появился: ${e}`,
      );
      continue;
    }

    await _stealth.smartWait("micro");
    const picked = await _stealth.click(RAS_SUPPLY_FILTER_31_LI_XPATH, {
      afterWait: "click",
    });
    if (!picked) {
      log(`[filter] попытка ${attempt}/${MAX_ATTEMPTS}: клик по пункту 3.1 не удался`);
      continue;
    }

    // КРИТИЧНО: проверяем что 3.1 реально выбралась. Без этой проверки парсер
    // может молча идти дальше с пустым фильтром и собрать «грязные» данные
    // по ВСЕМ категориям (см. инцидент с 6283 нерелевантными записями).
    await _stealth.smartWait("click");
    if (await _categoryShowsSupply31(page)) {
      log(`[filter] выбран п. 3.1 (поставки) с попытки ${attempt}/${MAX_ATTEMPTS}`);
      return true;
    }
    log(
      `[filter] попытка ${attempt}/${MAX_ATTEMPTS}: после клика 3.1 не отобразилась — повторяю`,
    );
  }

  // Все UI-попытки промахнулись — fallback через selectOption на нативном <select>.
  log("[filter] UI-кликом 3.1 не выбралась, fallback через нативный select…");
  const forced = await _forceSupplyCategory31ViaNativeSelect(page);
  if (forced) {
    await _stealth.smartWait("click");
    if (await _categoryShowsSupply31(page)) {
      log("[filter] 3.1 выставлена через нативный select (fallback)");
      return true;
    }
    log("[filter] fallback через select прошёл, но проверка _categoryShowsSupply31=false");
  }
  log("[filter] не удалось выставить 3.1 ни UI-кликом, ни через нативный select");
  return false;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.searchPostBaselineSeq] если задан — считаем успех только после нового POST `/Search`
 *        (строго больше этого счётчика); иначе поведение как при первом подъёме сессии.
 */
async function _clickFind(page, opts = {}) {
  const baselineSeq =
    typeof opts.searchPostBaselineSeq === "number"
      ? opts.searchPostBaselineSeq
      : null;
  const requireNewSearch = baselineSeq !== null;

  if (RAS_TRACE_STEALTH) {
    log("[click] Ищу кнопку «Найти» и пытаюсь кликнуть...");
  }

  const sawFreshSearch = async () => {
    if (!requireNewSearch) {
      return await _waitBrieflyForSearch(3.0);
    }
    const deadline = monotonic() + 22;
    while (monotonic() < deadline) {
      if (_searchPostSeq > baselineSeq) return true;
      await _stealth.smartWait("micro");
    }
    return _searchPostSeq > baselineSeq;
  };

  const targets = [
    "#b-form-submit",
    "#b-form-submit .b-button-container",
    '#b-form-submit button[type="submit"]',
  ];
  let anyClicked = false;
  for (const sel of targets) {
    if (!requireNewSearch && _searchCaptured()) return true;
    const clicked = await _stealth.click(sel, { afterWait: "micro" });
    anyClicked = anyClicked || clicked;
    if (!clicked) continue;
    if (await sawFreshSearch()) {
      log(`[click] /Search пойман после клика по ${sel}`);
      return true;
    }
    log(
      `[click] после клика по ${sel} /Search ещё нет, пробую следующий вариант`,
    );
  }

  try {
    const ok = await page.evaluate(`(() => {
      const $ = window.jQuery;
      if (!$) return 'no-jq';
      const $btn = $('#b-form-submit button[type="submit"]');
      if ($btn.length) { $btn.trigger('click'); return 'jquery-trigger-inner'; }
      const $b = $('#b-form-submit');
      if ($b.length) { $b.trigger('click'); return 'jquery-trigger-outer'; }
      return 'no-element';
    })()`);
    log(`[click] JS-fallback (jQuery trigger): ${ok}`);
    if (ok === "jquery-trigger-inner" || ok === "jquery-trigger-outer") {
      anyClicked = true;
      // jQuery-триггер — синтетика без курсора, поэтому даём антифроду
      // увидеть реалистичную «реакцию пользователя» через micro-паузу,
      // прежде чем поллить /Search.
      await _stealth.smartWait("micro");
      if (await sawFreshSearch()) {
        log("[click] /Search пойман после jQuery trigger");
        return true;
      }
    }
  } catch (e) {
    log(`[click] JS fallback -> ${e}`);
  }

  return requireNewSearch ? false : anyClicked;
}

// «Только не завершённые» в JS-бандле RAS присутствует, но в коде НЕ поддержан:
// интерактивный промпт throw'нёт раньше, чем сюда что-то долетит. Если когда-нибудь
// понадобится — добавь сюда ветку not_finished + XPath на пункт.
const STATUS_OPTION_BY_MODE = {
  finished: {
    xpath: RAS_STATUS_FINISHED_OPTION_XPATH,
    label: "Только завершенные",
    dumpSlug: "filter-status-finished",
  },
};

/**
 * Раскрыть «Статус» и подождать видимости нужного пункта (без ожидания /Search).
 * Для setup см. `_applyStatusFilter`.
 *
 * @param {"finished"} mode
 * @returns {Promise<boolean>}
 */
async function _applyStatusFilterUntilPick(page, mode) {
  const opt = STATUS_OPTION_BY_MODE[mode];
  if (!opt) {
    log(`[filter] неизвестный режим статуса: ${mode}`);
    return false;
  }
  log("[filter] верхний статус: раскрываю фильтр «Статус»…");
  const toggle = page.locator(RAS_STATUS_FILTER_TOGGLE_XPATH).first();
  try {
    await toggle.waitFor({ state: "visible", timeout: 20_000 });
  } catch (e) {
    log(`[filter] фильтр «Статус» не появился после поиска: ${e}`);
    return false;
  }

  const opened = await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  if (!opened) {
    log("[filter] не удалось раскрыть фильтр «Статус»");
    return false;
  }

  const option = page.locator(opt.xpath).first();
  try {
    await option.waitFor({ state: "visible", timeout: 15_000 });
  } catch (e) {
    log(`[filter] пункт «${opt.label}» не появился: ${e}`);
    return false;
  }

  return true;
}

async function _applyStatusFilterPick(page, mode) {
  const opt = STATUS_OPTION_BY_MODE[mode];
  if (!opt) return { ok: false, changed: false, parsed: null };
  const option = page.locator(opt.xpath).first();
  let already = false;
  try {
    already = await option.evaluate((el) => {
      const li = el.closest("li");
      const inp = li?.querySelector('input[type="checkbox"]');
      return inp ? inp.checked : false;
    });
  } catch {
    already = false;
  }
  if (already) {
    log(`[filter] «${opt.label}» уже отмечено — пропуск клика`);
    return { ok: true, changed: false, parsed: null };
  }

  const searchT0 = performance.now();
  const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
    timeout: 120_000,
  });
  const picked = await _stealth.click(opt.xpath, {
    afterWait: "micro",
  });
  if (!picked) {
    void respPromise.catch(() => {});
    log(`[filter] не удалось выбрать «${opt.label}»`);
    return { ok: false, changed: false, parsed: null };
  }

  const ing = await _awaitPostSearchJson(respPromise, opt.dumpSlug, searchT0);
  if (!ing.ok) {
    log(`[filter] после «${opt.label}» нет валидного /Search: ${ing.reason}`);
    return { ok: false, changed: false, parsed: null };
  }
  await _stealth.smartWait("click");
  return {
    ok: true,
    changed: true,
    parsed: ing.parsed,
    searchRoundtripMs: ing.roundtripMs,
  };
}

/**
 * UI выбора пункта «Статус» с verify+retry. После клика проверяем заголовок
 * через `_statusFilterTitleMatches`; если не сошёлся — повторяем (до 3 попыток).
 *
 * @param {"finished"} mode
 * @returns {Promise<{ ok: boolean, changed: boolean, parsed: object|null, searchRoundtripMs?: number }>}
 */
async function _applyStatusFilterUi(page, mode) {
  const opt = STATUS_OPTION_BY_MODE[mode];
  if (!opt) return { ok: false, changed: false, parsed: null };
  if (await _statusFilterTitleMatches(page, mode)) {
    log(`[filter] статус «${opt.label}» уже по заголовку — пропуск`);
    return { ok: true, changed: false, parsed: null };
  }

  const MAX_ATTEMPTS = 3;
  let cumulativeChanged = false;
  let lastParsed = null;
  let lastRoundtripMs;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    log(`[filter] статус (${mode}): попытка ${attempt}/${MAX_ATTEMPTS}`);
    if (!(await _applyStatusFilterUntilPick(page, mode))) {
      log(`[filter] статус: не раскрыл фильтр (попытка ${attempt})`);
      continue;
    }
    const pick = await _applyStatusFilterPick(page, mode);
    await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, { afterWait: "click" });
    if (!pick.ok) {
      log(`[filter] статус: pick fail (попытка ${attempt})`);
      continue;
    }
    if (pick.changed) {
      cumulativeChanged = true;
      lastParsed = pick.parsed;
      lastRoundtripMs = pick.searchRoundtripMs;
    }
    await _stealth.smartWait("click");
    if (await _statusFilterTitleMatches(page, mode)) {
      log(`[filter] статус: применён успешно с попытки ${attempt}/${MAX_ATTEMPTS}`);
      return {
        ok: true,
        changed: cumulativeChanged,
        parsed: lastParsed,
        searchRoundtripMs: cumulativeChanged ? lastRoundtripMs : undefined,
      };
    }
    log(`[filter] статус: после попытки ${attempt} заголовок не подтверждает выбор — retry`);
  }

  log("[filter] статус: исчерпаны попытки — возвращаю ok=false");
  return { ok: false, changed: cumulativeChanged, parsed: lastParsed };
}

/**
 * После первого поиска раскрыть верхний фильтр «Статус» и выбрать пункт,
 * соответствующий `mode` ("finished"); затем перехватить новый POST `/Search`.
 *
 * @param {"finished"} mode
 * @returns {Promise<boolean>}
 */
async function _applyStatusFilter(page, mode) {
  const opt = STATUS_OPTION_BY_MODE[mode];
  if (!opt) return false;
  if (await _statusFilterTitleMatches(page, mode)) {
    log(`[filter] статус уже «${opt.label}» — новый /Search не жду`);
    return true;
  }
  if (!(await _applyStatusFilterUntilPick(page, mode))) return false;

  const pick = await _applyStatusFilterPick(page, mode);
  if (!pick.ok) return false;
  if (!pick.changed) {
    await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
      afterWait: "click",
    });
    return true;
  }

  log(
    `[filter] выбран статус «${opt.label}», ответ /Search обработан внутри клика`,
  );
  await _stealth.click(RAS_STATUS_FILTER_TOGGLE_XPATH, {
    afterWait: "click",
  });
  return true;
}

/**
 * РАК: до 3 типов документа в UI с verify+retry. Принимает Set ключей
 * ("decision" | "appeal" | "cassation") — кликаются только включённые.
 * После применения проверяем заголовок через `_rakDocFilterTitleLooksComplete`;
 * если не сошёлся — повторяем (до 3 попыток).
 *
 * @param {Set<"decision"|"appeal"|"cassation">} requestedSet
 * @returns {Promise<{ ok: boolean, changed: boolean, parsed: object|null, searchRoundtripMs?: number }>}
 */
async function _applyRakDocumentTypeFilterUi(page, requestedSet) {
  if (!(requestedSet instanceof Set) || requestedSet.size === 0) {
    return { ok: true, changed: false, parsed: null };
  }
  if (await _rakDocFilterTitleLooksComplete(page, requestedSet)) {
    log(
      `[filter] РАК: по заголовку выбранный набор [${[...requestedSet].join(",")}] уже стоит — пропуск`,
    );
    return { ok: true, changed: false, parsed: null };
  }
  const allOptions = [
    { key: "decision", xpath: RAS_DOC_TYPE_DECISION_OPTION_XPATH, label: "Решение", dumpSlug: "rak-decision" },
    { key: "appeal", xpath: RAS_DOC_TYPE_APPEAL_OPTION_XPATH, label: "Постановление апелляции", dumpSlug: "rak-appeal" },
    { key: "cassation", xpath: RAS_DOC_TYPE_CASSATION_OPTION_XPATH, label: "Постановление кассации", dumpSlug: "rak-cassation" },
  ];
  const options = allOptions.filter((o) => requestedSet.has(o.key));
  if (options.length === 0) {
    return { ok: true, changed: false, parsed: null };
  }

  const MAX_ATTEMPTS = 3;
  let lastParsed = null;
  let lastRakSearchMs;
  let cumulativeChanged = false;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    log(`[filter] РАК: попытка ${attempt}/${MAX_ATTEMPTS}, раскрываю фильтр…`);
    const toggle = page.locator(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH).first();
    try {
      await toggle.waitFor({ state: "visible", timeout: 20_000 });
    } catch (e) {
      log(`[filter] РАК: фильтр не появился (попытка ${attempt}): ${e}`);
      continue;
    }
    if (!(await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, { afterWait: "click" }))) {
      log(`[filter] РАК: не раскрылся (попытка ${attempt})`);
      continue;
    }

    let attemptOk = true;
    let changed = false;
    for (const opt of options) {
      const option = page.locator(opt.xpath).first();
      try {
        await option.waitFor({ state: "visible", timeout: 15_000 });
      } catch (e) {
        log(`[filter] РАК: пункт «${opt.label}» не появился: ${e}`);
        attemptOk = false;
        break;
      }
      let already = false;
      try {
        already = await option.evaluate((el) => {
          const li = el.closest("li");
          if (!li) return false;
          const inp = li.querySelector('input[type="checkbox"]');
          if (inp) return inp.checked;
          return li.classList.contains("ui-state-active");
        });
      } catch {
        already = false;
      }
      if (already) {
        log(`[filter] РАК: «${opt.label}» уже выбран — пропуск`);
        continue;
      }
      const searchT0 = performance.now();
      // 45с (было 120с): 3 RAK-retry × 45с = 135с укладывается в attempt
      // setup deadline (150с). На bad IP с залипом UI быстрее переходим к
      // следующему attempt, который дёрнет _recoverFrom (changeIp).
      const respPromise = page.waitForResponse(_searchPostResponsePredicate, { timeout: 45_000 });
      const picked = await _stealth.click(opt.xpath, { afterWait: "micro" });
      if (!picked) {
        void respPromise.catch(() => {});
        log(`[filter] РАК: не удалось выбрать «${opt.label}» (попытка ${attempt})`);
        attemptOk = false;
        break;
      }
      changed = true;
      log(`[filter] РАК: выбран «${opt.label}», жду /Search…`);
      const ing = await _awaitPostSearchJson(respPromise, `filter-${opt.dumpSlug}`, searchT0);
      if (!ing.ok) {
        log(`[filter] РАК: после «${opt.label}» нет валидного /Search: ${ing.reason}`);
        attemptOk = false;
        break;
      }
      lastParsed = ing.parsed;
      lastRakSearchMs = ing.roundtripMs;
      await _stealth.smartWait("click");
    }
    if (changed) cumulativeChanged = true;
    await _stealth.click(RAS_DOC_TYPE_FILTER_TOGGLE_XPATH, { afterWait: "click" });

    if (!attemptOk) {
      log(`[filter] РАК: попытка ${attempt}/${MAX_ATTEMPTS} провалилась — retry`);
      continue;
    }

    await _stealth.smartWait("click");
    if (await _rakDocFilterTitleLooksComplete(page, requestedSet)) {
      log(`[filter] РАК: применён успешно с попытки ${attempt}/${MAX_ATTEMPTS}`);
      return {
        ok: true,
        changed: cumulativeChanged,
        parsed: lastParsed,
        searchRoundtripMs: cumulativeChanged ? lastRakSearchMs : undefined,
      };
    }
    log(`[filter] РАК: после попытки ${attempt} заголовок не подтверждает выбор — retry`);
  }

  log("[filter] РАК: исчерпаны попытки — возвращаю ok=false");
  return { ok: false, changed: cumulativeChanged, parsed: lastParsed };
}

/**
 * После первого поиска раскрыть фильтр «Тип документа», выбрать пункты по
 * `requestedSet` ⊆ {decision, appeal, cassation} и перехватить новый POST `/Search`.
 *
 * @param {Set<"decision"|"appeal"|"cassation">} requestedSet
 * @returns {Promise<boolean>}
 */
async function _applyRakDocumentTypeFilter(page, requestedSet) {
  if (!(requestedSet instanceof Set) || requestedSet.size === 0) return true;
  const ui = await _applyRakDocumentTypeFilterUi(page, requestedSet);
  if (!ui.ok) return false;
  if (!ui.changed) {
    log("[filter] РАК: типы документов уже были в цели — новый /Search не жду");
    return true;
  }

  if (_captured.url !== null && _captured.body !== null) {
    log(
      "[filter] РАК: фильтр «Тип документа» применён, шаблон POST из последнего /Search",
    );
    return true;
  }

  log("[filter] РАК: после выборов типов шаблон POST пуст — fallback heartbeat");
  _captured.url = null;
  _captured.headers = null;
  _captured.body = null;

  log(
    `[wait] РАК: жду POST /Search после фильтра «Тип документа» до ${Math.floor(
      WAIT_FOR_SEARCH_MS / 1000,
    )}с...`,
  );
  await _waitForSearchWithHeartbeat(WAIT_FOR_SEARCH_MS);
  if (_captured.url === null) {
    log("[filter] РАК: после выбора типов документов новый /Search не пришёл");
    return false;
  }

  log("[filter] РАК: фильтр «Тип документа» применён, новый /Search пойман");
  return true;
}

/** Единая точка recovery: эскалатор крутит IP/operator/geo. В цикле окон при changeIp/duplicate
 *  пересоздаёт браузер и кидает RecycleWindowError, чтобы main подхватил новые куки.
 *  В setup-фазе (вне цикла окон) recycle НЕ делаем — `page` живёт в локали main и
 *  пересоздание ломает уже работающий вызов _safeGoto.
 *
 *  ВАЖНО: даже если changeIp не сработал (rate-limit / сеть провайдера) — в
 *  window-loop делаем recycle браузера. Без этого Playwright продолжит
 *  держать keep-alive TCP с тем же мёртвым IP, и следующие POST /Search
 *  отвалятся точно так же. Recycle закрывает все keepalive-туннели; даже
 *  если IP не сменился, новое TCP-соединение часто проходит. */
async function _recoverFrom(reason = "", _opts = {}) {
  const r = await _escalator.recoverFrom(reason, _opts);
  if (r.level === ESC_LEVELS.IP && r.detail?.ok && r.detail.duplicateIp) {
    log(`[recover] changeIp вернул тот же new_ip`);
    _escalator.revertLastIpRotationForDuplicateEgress(reason);
    if (_inWindowLoop && _browserRecycleForDuplicateIp) {
      const lastPageNum = _currentWalkPageNum;
      await _browserRecycleForDuplicateIp();
      throw new RecycleWindowError(`duplicate new_ip (${reason})`, {
        lastPageNum,
      });
    }
    return true;
  }
  if (
    _inWindowLoop &&
    RECYCLE_BROWSER_AFTER_BANNED_L1 &&
    _browserRecycleForDuplicateIp
  ) {
    const tag = r.detail?.ok ? "ok" : "fail";
    log(
      `[recover] level=${r.level} ${tag} — recycle браузера (сбросить TCP-keepalive)`,
    );
    const lastPageNum = _currentWalkPageNum;
    await _browserRecycleForDuplicateIp();
    throw new RecycleWindowError(
      `recycle after recover level=${r.level} ${tag} (${reason})`,
      { lastPageNum },
    );
  }
  log(`[recover] level=${r.level} OK; summary=${JSON.stringify(_escalator.summary())}`);
  return true;
}

/** ISO `2025-05-01T00:00:00` → `01.05.2025` для полей периода. */
function _isoDateTimeToDdMmYyyy(iso) {
  const m = String(iso ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

async function _clearPeriodDateInputs(page) {
  for (const sel of [RAS_PERIOD_DATE_FROM_XPATH, RAS_PERIOD_DATE_TO_XPATH]) {
    const loc = page.locator(sel).first();
    if ((await loc.count()) === 0) return false;
    await loc.evaluate((el) => {
      el.value = "";
    });
  }
  return true;
}

async function _dismissPeriodDatePickerOverlay() {
  log("[ui-search] закрываю оверлей календаря (Enter — без кликов «в пустоту»)");
  await _stealth.pressKey("Enter", { afterWait: "micro" });
}

async function _fillPeriodDatesFromBody(page, bodyObj) {
  const df = _isoDateTimeToDdMmYyyy(bodyObj.DateFrom);
  const dt = _isoDateTimeToDdMmYyyy(bodyObj.DateTo);
  if (!df || !dt) {
    log(`[ui-search] не разобрал DateFrom/DateTo в body — нужен ISO YYYY-MM-DD`);
    return false;
  }
  log(`[ui-search] период в форме: ${df} — ${dt}`);
  if (!(await _clearPeriodDateInputs(page))) {
    log("[ui-search] поля периода не найдены (#sug-dates)");
    return false;
  }
  const fromOk = await _stealth.type(RAS_PERIOD_DATE_FROM_XPATH, df, {
    afterWait: "micro",
  });
  const toOk = await _stealth.type(RAS_PERIOD_DATE_TO_XPATH, dt, {
    afterWait: "micro",
  });
  if (!fromOk || !toOk) return false;
  await _dismissPeriodDatePickerOverlay();
  return true;
}

function _searchPostResponsePredicate(r) {
  const req = r.request();
  return _isSearchUrl(r.url()) && req.method() === "POST";
}

/**
 * Подставить даты и «Найти» по новому периоду (шаблон POST — `_captured`).
 * Кнопка «Найти» сбрасывает «Тип документа» и «Статус»; если выдача не пустая,
 * выставляем их в UI без повторного «Найти». Если дел в периоде нет, верхних
 * фильтров на странице нет — только меняют обобщённые параметры (даты и т.д.).
 *
 * Обновляет `_captured` из последнего актуального `/Search` (шаблон окна, Page=1).
 *
 * @param {object} [uiFilters]
 * @param {Set<"decision"|"appeal"|"cassation">|null} [uiFilters.rakDocumentTypeFilter=null]
 * @param {"finished"|null} [uiFilters.statusFinishedOnly=null]
 * @param {boolean} [supplyFilter31=false] перед «Найти» выставить п. 3.1 (поставки), если ещё нет.
 * @returns {Promise<[number|null, object|null, string, number]>}
 */
async function _uiRunSearchFromForm(
  page,
  bodyObj,
  label,
  uiFilters = {},
  supplyFilter31 = false,
) {
  const {
    rakDocumentTypeFilter = null,
    statusFinishedOnly = null,
  } = uiFilters;

  const t0 = performance.now();
  bodyObj.Page = 1;

  if (supplyFilter31) {
    const ok31 = await _applySupplyDisputeFilter31(page);
    if (!ok31) {
      log(
        "[filter] перед «Найти»: 3.1 не выставлена — НЕ кликаю «Найти», " +
          "иначе соберём ВСЕ категории. Возвращаю ошибку, _walkPagesForBody " +
          "поднимет recovery (reload + _applySupplyDisputeFilter31 заново).",
      );
      return [null, null, "supply-filter-31-not-applied", performance.now() - t0];
    }
  }

  const filled = await _fillPeriodDatesFromBody(page, bodyObj);
  if (!filled) {
    return [null, null, "fill-dates-failed", performance.now() - t0];
  }

  await _dismissPeriodDatePickerOverlay();
  await _stealth.smartWait("micro");

  const usesRakUi =
    rakDocumentTypeFilter instanceof Set && rakDocumentTypeFilter.size > 0;
  const usesStatusUi = statusFinishedOnly === "finished";

  /** Latency последнего успешного POST `/Search` (как у пейджера), без набора дат и без последующего UI. */
  let searchRoundtripMs = 0;
  let response;
  try {
    const searchBaseline = _searchPostSeq;
    const searchT0 = performance.now();
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const clicked = await _clickFind(page, {
      searchPostBaselineSeq: searchBaseline,
    });
    if (!clicked) {
      void respPromise.catch(() => {});
      return [null, null, "find-click-failed", performance.now() - t0];
    }
    response = await respPromise;
    searchRoundtripMs = performance.now() - searchT0;
  } catch (e) {
    return [null, null, `wait-response: ${e}`, performance.now() - t0];
  }

  let raw = null;
  try {
    raw = await response.body();
  } catch (e) {
    log(`[ui-search] resp.body() упал: ${e}`);
  }
  if (raw !== null && raw !== undefined) {
    _dumpSearchResponse(`${label}-status${response.status()}`, raw, "bin");
  }

  if (response.status() !== 200) {
    return [response.status(), null, `status=${response.status()}`, searchRoundtripMs];
  }

  _syncCapturedFromSearchResponse(response);
  let text = "";
  try {
    text =
      raw !== null && raw !== undefined
        ? raw.toString("utf8")
        : await response.text();
  } catch (e) {
    return [response.status(), null, `read-body: ${e}`, searchRoundtripMs];
  }
  const ct = response.headers()["content-type"] ?? "";
  const cls = classifyMetadataResponse({
    contentType: ct,
    status: 200,
    bodyText: text,
  });
  if (
    cls.kind === "antifraud_gate" ||
    cls.kind === "html_unknown" ||
    cls.kind === "tiny"
  ) {
    log(
      `[antifraud] /Search ${label}: kind=${cls.kind} ` +
        `markers=[${cls.markers.join(",")}] ct=${ct || "?"} bytes=${cls.bytes}`,
    );
    const tag = cls.markers.length ? cls.markers.join(",") : cls.kind;
    return [200, null, `antifraud_gate: ${tag}`, searchRoundtripMs];
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return [response.status(), null, `json-decode: ${e}`, searchRoundtripMs];
  }

  if (!usesRakUi && !usesStatusUi) {
    if (!_rasListingEmptyBeforeTopFilters(parsed)) {
      const verifyOut = await _verifyListingFiltersOrRepair(
        page,
        uiFilters,
        supplyFilter31,
      );
      if (!verifyOut.ok) {
        return [
          null,
          null,
          "filter-verify-repair-failed",
          performance.now() - t0,
        ];
      }
      if (
        verifyOut.listingRepairParsed !== null &&
        verifyOut.listingRepairParsed !== undefined
      ) {
        parsed = verifyOut.listingRepairParsed;
      }
    }
    return [200, parsed, "", searchRoundtripMs];
  }

  if (_rasListingEmptyBeforeTopFilters(parsed)) {
    log(
      "[ui-search] после «Найти» выдача пустая — верхние фильтры РАК/«Статус» не трогаю; " +
        "проверку заголовков фильтров пропускаю (на пустой выдаче RAS их часто прячет)",
    );
    return [200, parsed, "", searchRoundtripMs];
  }

  try {
    if (usesRakUi) {
      const rakUi = await _applyRakDocumentTypeFilterUi(
        page,
        rakDocumentTypeFilter,
      );
      if (!rakUi.ok) {
        return [null, null, "rak-filter-ui-failed", performance.now() - t0];
      }
      if (rakUi.changed) {
        if (rakUi.parsed === null || rakUi.parsed === undefined) {
          return [
            null,
            null,
            "rak-filter-no-json",
            performance.now() - t0,
          ];
        }
        parsed = rakUi.parsed;
        if (typeof rakUi.searchRoundtripMs === "number") {
          searchRoundtripMs = rakUi.searchRoundtripMs;
        }
      }
    }
    if (usesStatusUi) {
      const stUi = await _applyStatusFilterUi(page, statusFinishedOnly);
      if (!stUi.ok) {
        return [null, null, "status-filter-ui-failed", performance.now() - t0];
      }
      if (stUi.changed) {
        if (stUi.parsed === null || stUi.parsed === undefined) {
          return [
            null,
            null,
            "status-filter-no-json",
            performance.now() - t0,
          ];
        }
        parsed = stUi.parsed;
        if (typeof stUi.searchRoundtripMs === "number") {
          searchRoundtripMs = stUi.searchRoundtripMs;
        }
      }
    }
  } catch (e) {
    return [null, null, `wait-response: ${e}`, performance.now() - t0];
  }

  const verifyOut = await _verifyListingFiltersOrRepair(
    page,
    uiFilters,
    supplyFilter31,
  );
  if (!verifyOut.ok) {
    return [null, null, "filter-verify-repair-failed", performance.now() - t0];
  }
  if (
    verifyOut.listingRepairParsed !== null &&
    verifyOut.listingRepairParsed !== undefined
  ) {
    parsed = verifyOut.listingRepairParsed;
  }
  return [200, parsed, "", searchRoundtripMs];
}

async function _pagerNextIsVisible(page) {
  const next = page.locator(RAS_PAGER_NEXT_XPATH).first();
  try {
    return await next.isVisible();
  } catch {
    return false;
  }
}

/**
 * Клик «вперёд» в пейджере, ждём следующий POST /Search.
 *
 * @returns {Promise<[number|null, object|null, string, number]>}
 */
/**
 * Страницы 2..N: прямой POST `/Search` через `page.request.post` вместо клика
 * по пейджеру. Имя функции оставлено как было (вызывается из `_browseSearchPage`
 * и `_recoverListingUiAfterFailedRound`); реальной работы с UI больше нет.
 *
 * Куки/прокси берутся из browser context'а (page.request шарит контекст с page).
 * URL/headers — из `_captured`, обновлённых после первого «Найти» в окне.
 *
 * @param {import('playwright').Page} page
 * @param {string} label
 * @param {object} bodyObj — будет мутирован: bodyObj.Page = pageNum
 * @param {number} pageNum
 * @returns {Promise<[number|null, object|null, string, number]>}
 */
async function _uiClickPagerNext(page, label, bodyObj, pageNum) {
  const t0 = performance.now();
  const url = _captured.url ? String(_captured.url) : "";
  if (!url) return [null, null, "no-captured-url", performance.now() - t0];
  const headers = _sanitizeReplayHeaders(_captured.headers);
  bodyObj.Page = pageNum;

  let response;
  try {
    response = await page.request.post(url, {
      headers,
      data: JSON.stringify(bodyObj),
      timeout: SEARCH_POST_TIMEOUT_MS,
    });
  } catch (e) {
    return [null, null, `request: ${e}`, performance.now() - t0];
  }

  const elapsed = performance.now() - t0;
  const status = response.status();
  if (status !== 200) {
    return [status, null, `status=${status}`, elapsed];
  }

  let text = "";
  try {
    text = await response.text();
  } catch (e) {
    return [status, null, `read-body: ${e}`, elapsed];
  }
  const ct = (() => {
    try {
      const h = response.headers();
      return h?.["content-type"] ?? "";
    } catch {
      return "";
    }
  })();
  const cls = classifyMetadataResponse({
    contentType: ct,
    status: 200,
    bodyText: text,
  });
  if (
    cls.kind === "antifraud_gate" ||
    cls.kind === "html_unknown" ||
    cls.kind === "tiny"
  ) {
    log(
      `[antifraud] /Search ${label}: kind=${cls.kind} ` +
        `markers=[${cls.markers.join(",")}] ct=${ct || "?"} bytes=${cls.bytes}`,
    );
    const tag = cls.markers.length ? cls.markers.join(",") : cls.kind;
    return [200, null, `antifraud_gate: ${tag}`, elapsed];
  }

  try {
    const parsed = JSON.parse(text);
    return [200, parsed, "", elapsed];
  } catch (e) {
    return [status, null, `json-decode: ${e}`, elapsed];
  }
}

/**
 * Сверяет `Result.Page` из JSON с ожидаемым номером страницы пейджера.
 * При «съезде» сессии RAS нередко отвечает 200 и телом первой страницы —
 * тогда парсер думает, что листает вперёд, и уходит в долгие пустые раунды.
 *
 * @returns {[number|null, object|null, string, number]}
 */
function _guardSearchResponsePage(out, pageNum, label) {
  const [st, parsed, err, elapsedMs] = out;
  if (st !== 200 || parsed === null || parsed === undefined) return out;
  const got = parsed?.Result?.Page;
  if (typeof got === "number" && Number.isFinite(got) && got !== pageNum) {
    log(
      `[pager-check] ${label}: Result.Page=${got}, ожидалось ${pageNum} — ` +
        "ответ отброшен (протух контекст поиска / неверный POST)",
    );
    return [st, null, `pager-page-mismatch: expected ${pageNum} got ${got}`, elapsedMs];
  }
  return out;
}

/** Страница 1 — UI «Найти», 2..N — direct POST через `_uiClickPagerNext`. */
async function _browseSearchPage(
  page,
  pageNum,
  bodyObj,
  label,
  uiFilters = {},
  supplyFilter31 = false,
) {
  if (pageNum === 1) {
    return _guardSearchResponsePage(
      await _uiRunSearchFromForm(page, bodyObj, label, uiFilters, supplyFilter31),
      pageNum,
      label,
    );
  }
  const out = await _uiClickPagerNext(page, label, bodyObj, pageNum);
  const [st] = out;
  const rakActive =
    uiFilters.rakDocumentTypeFilter instanceof Set &&
    uiFilters.rakDocumentTypeFilter.size > 0;
  const statusActive = uiFilters.statusFinishedOnly === "finished";
  if (
    FILTER_PAGER_TITLE_RECHECK_EVERY > 0 &&
    st === 200 &&
    pageNum % FILTER_PAGER_TITLE_RECHECK_EVERY === 0 &&
    (rakActive || statusActive)
  ) {
    const rakOk =
      !rakActive ||
      (await _rakDocFilterTitleLooksComplete(page, uiFilters.rakDocumentTypeFilter));
    const statOk =
      !statusActive ||
      (await _statusFilterTitleMatches(page, uiFilters.statusFinishedOnly));
    if (!rakOk || !statOk) {
      log(
        `[filter-check] ${label}: стр.${pageNum} — заголовки фильтров ` +
          `(РАК=${rakOk}, статус=${statOk}) не совпадают с настройкой; ` +
          "на пейджере починку без повторного окна не делаю",
      );
    }
  }
  return _guardSearchResponsePage(out, pageNum, label);
}

/**
 * После провального раунда POST `/Search`: перезагрузка главной и восстановление
 * контекста выдачи. На страницах пейджера > 1 без этого сайт нередко «теряет»
 * нумерацию — повторный Ctrl→ идёт без актуального поиска / даёт первую страницу.
 *
 * Страница 1: достаточно reload + прогрева + опционально п. 3.1 — следующая
 * попытка сама вызовет `_uiRunSearchFromForm`.
 *
 * Страница N>1: после reload — снова «Найти» с тем же телом/фильтрами и промотка
 * пейджера до (N−1), чтобы следующий `_browseSearchPage(N)` сделал один Ctrl→ на N.
 *
 * @returns {Promise<boolean>} false если форма или промотка не удались
 */
async function _recoverListingUiAfterFailedRound(...args) {
  try {
    return await _withTimeout(
      _recoverListingUiAfterFailedRoundInner(...args),
      SETUP_ATTEMPT_DEADLINE_MS,
      `[ui-recovery]`,
    );
  } catch (e) {
    const label = (args && args[3]) || "ui-recovery";
    log(`[${label}] UI-recovery deadline: ${e && e.message}`);
    return false;
  }
}

async function _recoverListingUiAfterFailedRoundInner(
  page,
  bodyObj,
  pageNum,
  labelPrefix,
  uiFilters,
  supplyFilter31,
) {
  log(
    `[${labelPrefix}] UI-recovery: reload главной и восстановление выдачи ` +
      `(перед следующим раундом страницы ${pageNum})`,
  );
  await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });
  await _stealth.smartWait("warmup");
  if (RAS_META_PRAVO_WAIT_MS > 0) {
    log(
      `[${labelPrefix}] UI-recovery: pravocaptcha pause ${RAS_META_PRAVO_WAIT_MS}мс ` +
        "(cap-cookies ставятся после DOMContentLoaded)",
    );
    await _sleepMs(RAS_META_PRAVO_WAIT_MS);
  }
  if (supplyFilter31) {
    const applied = await _applySupplyDisputeFilter31(page);
    if (!applied) {
      log(
        `[${labelPrefix}] UI-recovery: фильтр 3.1 не применился — ` +
          "продолжаю (как при стартовой сессии при том же сбое)",
      );
    }
  }
  if (pageNum <= 1) {
    return true;
  }

  const [, parsed, err] = await _uiRunSearchFromForm(
    page,
    bodyObj,
    `${labelPrefix}-recover-form`,
    uiFilters,
    supplyFilter31,
    false,
  );
  if (parsed !== null && parsed !== undefined) {
    log(
      `[${labelPrefix}] UI-recovery: после «Найти» страница 1 восстановлена, ` +
        `следующий direct POST — страница ${pageNum}`,
    );
    return true;
  }

  log(`[${labelPrefix}] UI-recovery: повтор «Найти» не дал JSON: ${err}`);
  return false;
}

/**
 * Обходит все страницы окна. Страница 1 — UI-«Найти», 2..N — direct POST.
 * Контракт: данные не теряются — на неудаче крутим раунды до успеха или
 * пока эскалатор сам не кинет EscalationExhausted.
 *
 * @param {object} [uiFilters] — флаги `rakDocumentTypeFilter` / `statusFinishedOnly`
 *        для страницы 1: после смены дат всегда «Найти»; РАК/статус — только если
 *        выдача по периоду не пустая (иначе их нет в DOM).
 * @param {boolean} [supplyFilter31=false] — при UI-recovery после провала раунда
 *        снова выбрать п. 3.1 до «Найти» (как в `_setupSearchSession`).
 */
async function _walkPagesForBody(
  page,
  bodyObj,
  labelPrefix,
  mode,
  targetTypeIdsSet,
  uiFilters = {},
  supplyFilter31 = false,
  startPageNum = 1,
) {
  const stats = {
    total: null,
    return_count: null,
    pages_seen: 0,
    items: 0,
    added: 0,
    relabeled: 0,
    links_added: 0,
    links_added_umbrella: 0,
    links_skipped_category: 0,
  };

  const firstPage = Math.max(1, Number.isInteger(startPageNum) ? startPageNum : 1);
  if (firstPage > 1) {
    log(
      `[${labelPrefix}] resume пейджера: стартую сразу со страницы ${firstPage} ` +
        `(прогон после RecycleWindowError, страницы 1..${firstPage - 1} уже в Map)`,
    );
  }
  for (let pageNum = firstPage; pageNum <= MAX_PAGES; pageNum += 1) {
    _currentWalkPageNum = pageNum;
    log(`[${labelPrefix}] страница ${pageNum}...`);

    let data = null;
    let lastSuccessElapsedMs = 0;
    const maxPageAttempts = SEARCH_PAGE_MAX_ATTEMPTS;
    let pageRound = 0;
    while (data === null) {
      pageRound += 1;
      if (pageRound > MAX_SEARCH_PAGE_DATA_ROUNDS) {
        throw new Error(
          `[${labelPrefix}] страница ${pageNum}: превышен лимит ` +
            `${MAX_SEARCH_PAGE_DATA_ROUNDS} раундов без валидного JSON — см. логи пейджера/сеть`,
        );
      }
      let flapStreak = 0;
      let escalatedThisRound = false;
      let stuckStatus = null;
      let stuckStatusStreak = 0;
      let antifraudGateStreak = 0;

      for (let attempt = 1; attempt <= maxPageAttempts; attempt += 1) {
        const [status, parsed, err, elapsedMs] = await _browseSearchPage(
          page,
          pageNum,
          bodyObj,
          `${labelPrefix}-p${pageNum}-r${pageRound}-t${attempt}`,
          uiFilters,
          supplyFilter31,
        );
        if (parsed !== null && parsed !== undefined) {
          data = parsed;
          lastSuccessElapsedMs = elapsedMs;
          break;
        }

        if (typeof status === "number" && status !== 200) {
          if (status === stuckStatus) {
            stuckStatusStreak += 1;
          } else {
            stuckStatus = status;
            stuckStatusStreak = 1;
          }
        } else {
          stuckStatus = null;
          stuckStatusStreak = 0;
        }

        const isAntifraudGate =
          typeof err === "string" && err.startsWith("antifraud_gate");
        const isFlap = !isAntifraudGate && _isProxyTunnelFlap(err);
        const rotate = !isAntifraudGate && !isFlap && _shouldRotateIp(err);
        const tag = isAntifraudGate
          ? ` [antifraud/gate streak=${antifraudGateStreak + 1}]`
          : isFlap
            ? ` [proxy/flap streak=${flapStreak + 1}]`
            : rotate
              ? _isRotatableNetworkError(err)
                ? " [proxy/net]"
                : " [banned]"
              : "";
        log(
          `[${labelPrefix} p${pageNum} r${pageRound}] ` +
            `попытка ${attempt}/${maxPageAttempts}${tag}: ${err}`,
        );
        if (attempt >= maxPageAttempts) break;

        if (isAntifraudGate) {
          // pravocaptcha/ddos-guard прислала HTML вместо JSON. ip-ротация
          // не помогает (cap привязана к canvas-fingerprint, не к IP); даём
          // pravocaptcha-JS пройти через полный UI-recovery (reload + warmup +
          // pravocaptcha pause), он поставит cap-cookies на следующую попытку.
          // Если так подряд META_ANTIFRAUD_GATE_RECOVER_AFTER раз — это уже
          // похоже на бан IP/гео, эскалируем через _recoverFrom.
          antifraudGateStreak += 1;
          flapStreak = 0;
          if (antifraudGateStreak >= META_ANTIFRAUD_GATE_RECOVER_AFTER) {
            log(
              `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                `antifraud_gate ${antifraudGateStreak}× подряд — эскалирую _recoverFrom ` +
                `(возможен реальный бан IP/гео, не только cap)`,
            );
            const rotated = await _recoverFrom(
              `${labelPrefix} p${pageNum} r${pageRound} antifraud-streak=${antifraudGateStreak}`,
            );
            escalatedThisRound = true;
            antifraudGateStreak = 0;
            if (!rotated) {
              await _stealth.smartWait("ip_cooldown");
            } else {
              const uiOk = await _recoverListingUiAfterFailedRound(
                page,
                bodyObj,
                pageNum,
                `${labelPrefix}-p${pageNum}-r${pageRound}-post-esc-antifraud`,
                uiFilters,
                supplyFilter31,
              );
              if (!uiOk) await _stealth.smartWait("api_delay");
            }
          } else {
            const uiOk = await _recoverListingUiAfterFailedRound(
              page,
              bodyObj,
              pageNum,
              `${labelPrefix}-p${pageNum}-r${pageRound}-antifraud`,
              uiFilters,
              supplyFilter31,
            );
            if (!uiOk) await _stealth.smartWait("api_delay");
          }
        } else if (isFlap) {
          antifraudGateStreak = 0;
          flapStreak += 1;
          if (flapStreak >= PROXY_FLAP_ROTATE_AFTER) {
            log(
              `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                `${flapStreak} прокси-флапов подряд — эскалирую через _recoverFrom`,
            );
            const rotated = await _recoverFrom(
              `${labelPrefix} p${pageNum} r${pageRound} flap-streak=${flapStreak}`,
            );
            escalatedThisRound = true;
            if (!rotated) {
              log(
                `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                  `_recoverFrom не сработал — отдельный ip_cooldown`,
              );
              await _stealth.smartWait("ip_cooldown");
            } else {
              const uiOk = await _recoverListingUiAfterFailedRound(
                page,
                bodyObj,
                pageNum,
                `${labelPrefix}-p${pageNum}-r${pageRound}-post-esc-flap`,
                uiFilters,
                supplyFilter31,
              );
              if (!uiOk) {
                log(
                  `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                    `post-esc (flap) UI-recovery не удался — api_delay`,
                );
                await _stealth.smartWait("api_delay");
              }
            }
            flapStreak = 0;
          } else {
            await _stealth.smartWait("proxy_flap");
          }
        } else if (rotate) {
          flapStreak = 0;
          antifraudGateStreak = 0;
          const rotated = await _recoverFrom(
            `${labelPrefix} p${pageNum} r${pageRound} ${err}`,
          );
          escalatedThisRound = true;
          if (!rotated) {
            log(
              `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                `_recoverFrom не сработал — отдельный ip_cooldown`,
            );
            await _stealth.smartWait("ip_cooldown");
          } else {
            const uiOk = await _recoverListingUiAfterFailedRound(
              page,
              bodyObj,
              pageNum,
              `${labelPrefix}-p${pageNum}-r${pageRound}-post-esc`,
              uiFilters,
              supplyFilter31,
            );
            if (!uiOk) {
              log(
                `[${labelPrefix} p${pageNum} r${pageRound}] ` +
                  `post-esc UI-recovery не удался — api_delay`,
              );
              await _stealth.smartWait("api_delay");
            }
          }
        } else {
          flapStreak = 0;
          antifraudGateStreak = 0;
          if (
            typeof err === "string" &&
            (err === "pager-next-hidden" ||
              err.startsWith("pager-next-hidden") ||
              err === "pager-page-mismatch" ||
              err.startsWith("pager-page-mismatch"))
          ) {
            const slip =
              typeof err === "string" && err.startsWith("pager-page-mismatch");
            const uiOk = await _recoverListingUiAfterFailedRound(
              page,
              bodyObj,
              pageNum,
              `${labelPrefix}-p${pageNum}-r${pageRound}-` +
                (slip ? "pager-slip" : "pager-hidden"),
              uiFilters,
              supplyFilter31,
            );
            if (!uiOk) await _stealth.smartWait("api_delay");
          } else {
            await _stealth.smartWait("api_delay");
          }
        }
      }

      if (data !== null) break;

      // Раунд провалился целиком. Никаких пропусков — стоим и крутим
      // дальше. Единственный легитимный выход без данных —
      // `EscalationExhausted` от эскалатора (всплывёт в main()).
      // Если эскалатор за раунд ни разу не позвался — значит ни одна
      // ошибка не была классифицирована как «надо крутить IP» (новый
      // бан-код, не учтённый в `_isLikelyBanned`). Форсим один
      // `_recoverFrom('banned')` принудительно, чтобы следующий раунд
      // пошёл на свежем IP.
      if (!escalatedThisRound) {
        const reason =
          stuckStatus !== null
            ? `stuck-status=${stuckStatus}×${stuckStatusStreak}`
            : "no-rotation-trigger";
        log(
          `[${labelPrefix} p${pageNum} r${pageRound}] failsafe: раунд провалился ` +
            `(${reason}), эскалатор не вызывался — форс _recoverFrom. ` +
            `Если повторяется на новом HTTP-коде — занеси его в _isLikelyBanned.`,
        );
        await _recoverFrom(`${labelPrefix} p${pageNum} r${pageRound} ${reason}`);
      }

      await _recoverListingUiAfterFailedRound(
        page,
        bodyObj,
        pageNum,
        `${labelPrefix}-p${pageNum}-r${pageRound}`,
        uiFilters,
        supplyFilter31,
      );

      log(
        `[${labelPrefix} p${pageNum}] раунд ${pageRound} без данных — ` +
          `данные обязательны, иду в раунд ${pageRound + 1}`,
      );
    }

    const isObj = data && typeof data === "object" && !Array.isArray(data);
    if (pageNum === 1) {
      const success = isObj ? data.Success : null;
      const message = isObj ? data.Message : null;
      const result = isObj ? data.Result : null;
      if (result && typeof result === "object" && !Array.isArray(result)) {
        stats.total = result.TotalCount ?? null;
        stats.return_count = result.ReturnCount ?? null;
        const pc = result.PagesCount ?? null;
        const rcNote =
          typeof stats.return_count === "number" &&
          stats.return_count === 0 &&
          typeof stats.total === "number" &&
          stats.total > 0
            ? " — типично для RAS при фильтрах РАК/«Статус», ориентир TotalCount"
            : "";
        log(
          `[${labelPrefix}] Success=${success}, ` +
            `TotalCount=${stats.total}, ` +
            `ReturnCount=${stats.return_count}${rcNote}, PagesCount=${pc}`,
        );
        if (typeof stats.return_count === "number" && stats.return_count >= 1000) {
          log(
            `[${labelPrefix}] ВНИМАНИЕ: окно упёрлось в лимит ` +
              `ReturnCount=${stats.return_count} — сузь окно`,
          );
        }
      } else {
        log(
          `[${labelPrefix}] Result=null, Success=${success}, ` +
            `Message=${JSON.stringify(message)} — окно пустое`,
        );
      }
    }

    const items = _findItemsAnywhere(data);
    if (!items.length) {
      const topKeys = isObj ? Object.keys(data).sort() : [];
      log(`[${labelPrefix} p${pageNum}] пусто (top-keys=${JSON.stringify(topKeys)}) — конец окна`);
      break;
    }

    let added = 0;
    let relabeled = 0;
    let linksAdded = 0;
    let linksAddedUmbrellaPage = 0;
    let linksSkippedCategoryPage = 0;
    if (mode === MODE_TYPES) {
      const typeStats = _processItems(items);
      added = typeStats.added;
      relabeled = typeStats.relabeled;
      _save();
    } else {
      const linkOut = _collectDecisionLinks(items, targetTypeIdsSet);
      linksAdded = linkOut.added;
      linksAddedUmbrellaPage = linkOut.umbrellaAdded ?? 0;
      linksSkippedCategoryPage = linkOut.skippedCategory;
      stats.links_skipped_category += linkOut.skippedCategory;
      stats.links_added_umbrella += linksAddedUmbrellaPage;
      await _saveDecisionLinks();
      // Чекпоинт страницы. Если процесс упадёт после этой строки (watchdog,
      // SIGKILL, OOM, supervisor-restart), следующий запуск прочитает state и
      // продолжит окно со страницы pageNum+1, а не с 1-й. _saveDecisionLinks
      // уже залил все новые ID этой страницы в PG, так что page pageNum
      // действительно закрыта.
      if (
        _currentParserState !== null &&
        mode === MODE_DECISION_LINKS &&
        Number.isInteger(pageNum) &&
        pageNum > 0
      ) {
        _currentParserState.currentLastPage = pageNum;
        _saveParserState(_currentParserState);
      }
    }
    stats.pages_seen += 1;
    stats.items += items.length;
    stats.added += added;
    stats.relabeled += relabeled;
    stats.links_added += linksAdded;
    if (mode === MODE_TYPES) {
      log(
        `[${labelPrefix} p${pageNum}] items=${items.length}, ` +
          `новых типов=${added}, обновлено подписей=${relabeled}, ` +
          `всего=${Object.keys(documentTypes).length}, ` +
          `latency=${lastSuccessElapsedMs.toFixed(0)}мс`,
      );
    } else {
      log(
        `[${labelPrefix} p${pageNum}] items=${items.length}, ` +
          `новых pdf-ссылок=${linksAdded} (из umbrella=${linksAddedUmbrellaPage}), ` +
          `пропуск по категории kad (стр)=${linksSkippedCategoryPage}, ` +
          `всего пропусков за окно=${stats.links_skipped_category}, ` +
          `всего ссылок=${decisionLinks.size}, ` +
          `latency=${lastSuccessElapsedMs.toFixed(0)}мс`,
      );
    }

    if (pageNum >= MAX_PAGES) {
      continue;
    }
    if (!(await _pagerNextIsVisible(page))) {
      log(
        `[${labelPrefix} p${pageNum}] в пейджере нет «вперёд» — ` +
          "это последняя страница выдачи",
      );
      break;
    }
    log(
      `[${labelPrefix} p${pageNum}] пауза до следующей страницы через ` +
        "smartWait('api_delay') (как между POST /Search в шапке модуля)",
    );
    await _stealth.smartWait("api_delay");
  }

  return stats;
}

function _windowIso(endDay) {
  const df =
    `${endDay.getFullYear()}-${pad2(endDay.getMonth() + 1)}-${pad2(endDay.getDate())}T00:00:00`;
  const dt =
    `${endDay.getFullYear()}-${pad2(endDay.getMonth() + 1)}-${pad2(endDay.getDate())}T23:59:59`;
  return [df, dt];
}

function _formatDdMmYyyy(d) {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

function _parseDdMmYyyy(s) {
  const m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return new Date(year, month - 1, day);
}

/** Парсит 'YYYY-MM-DD' (то, что отдаёт pg для date::text). */
function _parseIsoDate(s) {
  const m = String(s ?? "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10));
}

// ───────────────────────────────────────────────────────────────────────────
// Чекпоинт позиции окна парсера (parser_state.json)
//
// Зачем: парсер идёт окнами назад во времени. Если процесс упал в середине
// прогона (Chrome повис, прокси разорвал TCP, машина перезагрузилась) —
// в БД остались акты до момента сбоя, но «где мы сейчас» нигде не записано.
// MAX(registration_date) в БД использовать нельзя: окно могло оказаться
// пустым (skip), MAX тогда отстаёт. Поэтому ведём отдельный файл.
//
// Контракт state:
//   nextEndDay  — DD.MM.YYYY, окно, которое ЕЩЁ НЕ обработано (или обработано
//                 не полностью). Следующий запуск стартует с него.
//   oldestDay   — DD.MM.YYYY | null, нижняя граница исходного прогона.
//   updatedAt   — ISO timestamp последнего сохранения.
//
// Когда пишется:
//   - При входе в цикл окон (initial state = endDay из setup).
//   - После каждой смены outerEnd (окно завершено успешно, теперь edit shift).
//   - При SIGINT (graceful Ctrl+C) — синхронно перед exit.
//
// Когда удаляется:
//   - После успешного завершения цикла окон (break по oldestDay/autostop) —
//     прогон закончился, ресюмить нечего.
//   - По запросу пользователя в _promptSetup («нет, начать заново»).
// ───────────────────────────────────────────────────────────────────────────

let _currentParserState = null;
let _parserStateSigintInstalled = false;

function _loadParserState() {
  try {
    if (!fs.existsSync(PARSER_STATE_PATH)) return null;
    const raw = fs.readFileSync(PARSER_STATE_PATH, "utf-8");
    const j = JSON.parse(raw);
    const nextEndDay = _parseDdMmYyyy(String(j.nextEndDay ?? ""));
    if (!nextEndDay) return null;
    let oldestDay = null;
    if (j.oldestDay) {
      const od = _parseDdMmYyyy(String(j.oldestDay));
      if (od) oldestDay = _startOfDay(od);
    }
    // currentLastPage — последняя успешно обработанная страница внутри окна
    // nextEndDay. Если > 0 — продолжим со страницы currentLastPage+1, что
    // экономит ходки по уже залитым в PG страницам при рестарте процесса
    // (watchdog kill, supervisor restart). Поле опциональное: legacy state без
    // него интерпретируется как currentLastPage=0 (полный прогон окна).
    let currentLastPage = 0;
    if (Number.isInteger(j.currentLastPage) && j.currentLastPage > 0) {
      currentLastPage = j.currentLastPage;
    }
    return {
      nextEndDay: _startOfDay(nextEndDay),
      oldestDay,
      currentLastPage,
      updatedAt: String(j.updatedAt ?? ""),
    };
  } catch (e) {
    log(`[state] не смог прочитать ${PARSER_STATE_PATH}: ${e && e.message}`);
    return null;
  }
}

function _saveParserState(state) {
  if (!state || !state.nextEndDay) return;
  try {
    fs.mkdirSync(PARSED_DATA_DIR, { recursive: true });
    const payload = {
      nextEndDay: _formatDdMmYyyy(state.nextEndDay),
      oldestDay: state.oldestDay ? _formatDdMmYyyy(state.oldestDay) : null,
      currentLastPage:
        Number.isInteger(state.currentLastPage) && state.currentLastPage > 0
          ? state.currentLastPage
          : 0,
      updatedAt: new Date().toISOString(),
    };
    const tmp = PARSER_STATE_PATH + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), "utf-8");
    fs.renameSync(tmp, PARSER_STATE_PATH);
  } catch (e) {
    log(`[state] не смог записать ${PARSER_STATE_PATH}: ${e && e.message}`);
  }
}

function _clearParserState() {
  _currentParserState = null;
  try {
    if (fs.existsSync(PARSER_STATE_PATH)) fs.unlinkSync(PARSER_STATE_PATH);
  } catch (e) {
    log(`[state] не смог удалить ${PARSER_STATE_PATH}: ${e && e.message}`);
  }
}

function _installParserStateSigintOnce() {
  if (_parserStateSigintInstalled) return;
  _parserStateSigintInstalled = true;
  process.on("SIGINT", () => {
    if (_currentParserState && _currentParserState.nextEndDay) {
      _saveParserState(_currentParserState);
      process.stderr.write(
        `\n[state] SIGINT — позиция сохранена, продолжишь с ` +
          `${_formatDdMmYyyy(_currentParserState.nextEndDay)}\n`,
      );
    }
    process.exit(130);
  });
}

/** Календарный день 00:00 локально — для сравнения границ диапазона. */
function _startOfDay(d) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function _ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let answered = false;
    rl.question(question, (answer) => {
      answered = true;
      resolve(answer);
      rl.close();
    });
    rl.on("close", () => {
      if (!answered) resolve("");
    });
  });
}

/** да/нет; пустой ввод и Enter (= "") считаются как нет. */
function _parseYesNoDefaultNo(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (
    s === "" ||
    s === "нет" ||
    s === "н" ||
    s === "n" ||
    s === "no" ||
    s === "2"
  ) {
    return false;
  }
  if (
    s === "да" ||
    s === "д" ||
    s === "y" ||
    s === "yes" ||
    s === "1"
  ) {
    return true;
  }
  return null;
}

/** да/нет; пустой ввод и Enter (= "") считаются как да. */
function _parseYesNoDefaultYes(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (
    s === "" ||
    s === "да" ||
    s === "д" ||
    s === "y" ||
    s === "yes" ||
    s === "1"
  ) {
    return true;
  }
  if (s === "нет" || s === "н" || s === "n" || s === "no" || s === "2") {
    return false;
  }
  return null;
}

async function _askYesNoDefaultYes(prompt) {
  while (true) {
    const raw = await _ask(prompt);
    const v = _parseYesNoDefaultYes(raw);
    if (v !== null) return v;
    process.stdout.write('Введи «да» или «нет» (Enter = да).\n');
  }
}

async function _askYesNoDefaultNo(prompt) {
  while (true) {
    const raw = await _ask(prompt);
    const v = _parseYesNoDefaultNo(raw);
    if (v !== null) return v;
    process.stdout.write('Введи «да» или «нет» (Enter = нет).\n');
  }
}

function _parseDateFromEnv(raw, label) {
  const s = String(raw ?? "").trim();
  if (!s) return undefined;
  if (/^(none|off|-|0)$/i.test(s)) return null;
  const parsed = _parseDdMmYyyy(s);
  if (parsed === null) {
    log(`[setup] ${label}='${s}' не дата DD.MM.YYYY, игнорирую`);
    return undefined;
  }
  return _startOfDay(parsed);
}

/**
 * «Интерактивен ли запуск».
 *
 * Возвращает true только если stdin привязан к TTY И не задан опт-аут
 * `RAS_NONINTERACTIVE=1`. На supervised-рестартах (см.
 * `scripts/run-parser-supervised.sh`) `RAS_NONINTERACTIVE=1` ставится для
 * `attempt>=2`, чтобы парсер не зависал на `_ask()` промптах в Cursor-
 * терминале с прицепленным stdin. Первый запуск в TTY остаётся
 * интерактивным — даём человеку настроить параметры.
 *
 * Применяется во всех setup-промптах (`_resolveHeadlessFromEnvOrPrompt`,
 * `_promptSetup`) ВМЕСТО голого `process.stdin.isTTY`.
 *
 * @returns {boolean}
 */
function _isInteractive() {
  if (!process.stdin.isTTY) return false;
  const v = String(process.env.RAS_NONINTERACTIVE ?? "").trim().toLowerCase();
  if (v === "1" || v === "yes" || v === "on" || v === "true") return false;
  return true;
}

let _nonInteractiveWarned = false;
function _warnNonInteractiveOnce(why) {
  if (_nonInteractiveWarned) return;
  _nonInteractiveWarned = true;
  log(`[setup] RAS_NONINTERACTIVE=${process.env.RAS_NONINTERACTIVE ?? ""} — ${why}`);
}

/**
 * Первый интерактивный шаг: окно браузера или headless.
 * Вызывать до любых тяжёлых операций в `main()` (mkdir/debug и т.д.).
 *
 * @returns {Promise<boolean>} true = headless (без окна)
 */
async function _resolveHeadlessFromEnvOrPrompt() {
  const normalizeHeadfulRequest = (headless, sourceLabel) => {
    if (!headless) {
      const ok = _ensureVirtualDisplayForHeadful(sourceLabel);
      if (!ok) return true;
    }
    return headless;
  };

  // TTY + не задан RAS_NONINTERACTIVE → всегда спрашиваем (человек настраивает).
  // TTY + RAS_NONINTERACTIVE=1 (supervised restart) → пропускаем промпт, идём по env.
  // non-TTY → пропускаем промпт, идём по env.
  if (_isInteractive()) {
    while (true) {
      const raw = (await _ask("Показывать экран браузера? [1] да, [2] нет: ")).trim();
      if (raw === "1") return normalizeHeadfulRequest(false, "интерактивный выбор");
      if (raw === "2") return true;
      process.stdout.write("Введи 1 или 2.\n");
    }
  }

  if (process.stdin.isTTY) {
    _warnNonInteractiveOnce("пропускаю интерактивные промпты, беру параметры из env");
  }

  // env-driven путь. DEFAULT_HEADLESS уже учитывает RAS_HEADLESS (см. константу).
  if (process.env.RAS_HEADLESS !== undefined) {
    const headless = normalizeHeadfulRequest(DEFAULT_HEADLESS, "RAS_HEADLESS");
    process.stdout.write(
      `[setup] RAS_HEADLESS=${process.env.RAS_HEADLESS} -> ` +
        `${headless ? "без UI (headless)" : "показывать браузер (headful)"}\n`,
    );
    return headless;
  }
  process.stdout.write(
    `[setup] RAS_HEADLESS не задан — ` +
      `RAS_HEADLESS по умолчанию (${DEFAULT_HEADLESS ? "headless" : "headful"})\n`,
  );
  return normalizeHeadfulRequest(DEFAULT_HEADLESS, "non-interactive fallback");
}

/**
 * @param {boolean} headless — уже выбрано в начале `main()` или из `RAS_HEADLESS`.
 */
async function _promptSetup(headless) {
  // Контракт интерактивного режима:
  //   TTY + не задан RAS_NONINTERACTIVE → спрашиваем всё, env-defaults игнорируются.
  //     Это режим для человека за клавиатурой.
  //   TTY + RAS_NONINTERACTIVE=1 → ведём как non-TTY. Это supervised-рестарт:
  //     stdin физически привязан к терминалу (Cursor / `npm start`), но мы
  //     обязаны пройти без вопросов. Параметры берём из env + parser_state.json.
  //   non-TTY (cron / API / pipe / CI) → читаем из env / state.json.
  const interactive = _isInteractive();
  if (interactive) {
    log(
      "[setup] интерактивный режим (TTY): спрашиваю все параметры, " +
        "env-defaults (RAS_DATE_*, RAS_SUPPLY_FILTER_31, RAS_DOC_FILTER_RAK, " +
        "RAS_STATUS_FINISHED_ONLY) игнорируются",
    );
  } else {
    log(
      "[setup] неинтерактивный режим (non-TTY): беру параметры из env " +
        "(RAS_DATE_*, RAS_SUPPLY_FILTER_31, RAS_DOC_FILTER_RAK, " +
        "RAS_STATUS_FINISHED_ONLY)",
    );
  }

  const now = new Date();
  const todayDt = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const defaultEndDay = new Date(
    todayDt.getFullYear(),
    todayDt.getMonth(),
    todayDt.getDate() - 1,
  );

  // Режим всегда = acts -> Postgres. Справочник TypeId выпилен из интерактива
  // (если когда-нибудь понадобится — будет отдельная утилита). MODE_TYPES-ветки
  // в коде пока живы, как наследие, но недостижимы из промпта.
  const mode = MODE_DECISION_LINKS;

  // === Категория спора ===
  // Сейчас в коде захардкожен только XPath на «3.1 поставки». Другие категории —
  // отдельная задача (нужно перебить UI-логику выбора). Любая другая категория →
  // понятная ошибка.
  let supplyFilter31;
  if (interactive) {
    while (true) {
      const raw = (
        await _ask("Введите категорию спора [Enter = 3.1 поставки]: ")
      ).trim();
      const norm = raw.toLowerCase().replace(/\s+/g, " ");
      if (raw === "" || norm === "3.1" || norm.startsWith("3.1 ") || norm.startsWith("3.1.")) {
        supplyFilter31 = true;
        break;
      }
      if (norm === "off" || norm === "игнор" || norm === "0") {
        // Скрытая лазейка для отладки — даём явно вырубить фильтр.
        supplyFilter31 = false;
        break;
      }
      throw new Error(
        `[setup] категория '${raw}' пока не поддерживается. ` +
          "Поддерживаемые: 3.1 (поставки). Жми Enter, чтобы выбрать её по умолчанию.",
      );
    }
  } else {
    const filterEnv = String(process.env.RAS_SUPPLY_FILTER_31 ?? "").trim().toLowerCase();
    supplyFilter31 = !(filterEnv === "0" || filterEnv === "no" || filterEnv === "off");
    log(
      `[setup] фильтр категории 3.1 (поставки)=${supplyFilter31 ? "вкл" : "выкл"} ` +
        `(RAS_SUPPLY_FILTER_31)`,
    );
  }

  // === Тип акта (РАК) ===
  // Per-option: 1=решения, 2=апелляции, 3=кассации, можно «1,3» и т.п.
  // Enter / «рак» / «1,2,3» = полный РАК, 4 / «игнор» = выкл (null).
  /** @type {Set<"decision"|"appeal"|"cassation">|null} */
  let rakDocumentTypeFilter;
  const RAK_DIGIT_TO_KEY = { 1: "decision", 2: "appeal", 3: "cassation" };
  if (interactive) {
    while (true) {
      const raw = (
        await _ask(
          "Тип акта: [1] решения, [2] апелляции, [3] кассации (через запятую), " +
            "[4] игнор фильтра [Enter = РАК (все три)]: ",
        )
      ).trim();
      const norm = raw.toLowerCase().replace(/\s+/g, "");
      if (raw === "" || norm === "рак" || norm === "1,2,3") {
        rakDocumentTypeFilter = new Set(["decision", "appeal", "cassation"]);
        break;
      }
      if (raw === "4" || norm === "игнор" || norm === "off") {
        rakDocumentTypeFilter = null;
        break;
      }
      const parts = norm.split(",").filter((p) => p.length > 0);
      const keys = new Set();
      let bad = false;
      for (const p of parts) {
        if (p === "4") {
          bad = true;
          break;
        }
        const k = RAK_DIGIT_TO_KEY[p];
        if (!k) {
          bad = true;
          break;
        }
        keys.add(k);
      }
      if (!bad && keys.size > 0) {
        rakDocumentTypeFilter = keys;
        break;
      }
      process.stdout.write(
        "Введи цифры 1/2/3 через запятую (например «1,3»), либо 4 (игнор), либо Enter (все три).\n",
      );
    }
  } else {
    const rakEnv = String(process.env.RAS_DOC_FILTER_RAK ?? "").trim().toLowerCase();
    if (rakEnv === "0" || rakEnv === "no" || rakEnv === "off") {
      rakDocumentTypeFilter = null;
    } else if (rakEnv === "" || rakEnv === "1" || rakEnv === "yes" || rakEnv === "on") {
      rakDocumentTypeFilter = new Set(["decision", "appeal", "cassation"]);
    } else {
      const keys = new Set();
      for (const p of rakEnv.split(",").map((s) => s.trim()).filter(Boolean)) {
        const k = RAK_DIGIT_TO_KEY[p] ?? (["decision", "appeal", "cassation"].includes(p) ? p : null);
        if (k) keys.add(k);
      }
      rakDocumentTypeFilter = keys.size > 0
        ? keys
        : new Set(["decision", "appeal", "cassation"]);
    }
    log(
      `[setup] фильтр РАК (Тип документа)=` +
        `${rakDocumentTypeFilter === null ? "выкл" : [...rakDocumentTypeFilter].join(",")} ` +
        `(RAS_DOC_FILTER_RAK)`,
    );
  }

  // === Статус ===
  // 1/Enter = «Только завершенные», 3 = игнор (null).
  // 2 («Только не завершённые») — в коде не поддержано: бросаем понятный throw.
  // Если когда-нибудь понадобится — XPath на пункт есть в JS-бандле RAS
  // (`Только не завершённые`, с пробелом и через ё), плюс ветка `not_finished`
  // в STATUS_OPTION_BY_MODE и в _statusFilterTitleMatches.
  /** @type {"finished"|null} */
  let statusFinishedOnly;
  if (interactive) {
    while (true) {
      const raw = (
        await _ask(
          "Статус: [1] завершённые, [2] незавершённые, [3] игнор фильтра " +
            "[Enter = завершённые]: ",
        )
      ).trim();
      const norm = raw.toLowerCase();
      if (raw === "" || raw === "1" || norm.startsWith("заверш")) {
        statusFinishedOnly = "finished";
        break;
      }
      if (raw === "3" || norm === "игнор" || norm === "off") {
        statusFinishedOnly = null;
        break;
      }
      if (raw === "2" || norm.startsWith("незаверш") || norm.startsWith("не заверш")) {
        throw new Error(
          "[setup] статус 'только незавершённые' пока не поддерживается. " +
            "Поддерживаемые: Enter/1 (завершённые) или 3 (игнор).",
        );
      }
      process.stdout.write("Введи 1, 3 или Enter (2 пока не поддерживается).\n");
    }
  } else {
    const finishedEnv = String(process.env.RAS_STATUS_FINISHED_ONLY ?? "")
      .trim()
      .toLowerCase();
    if (
      finishedEnv === "0" ||
      finishedEnv === "no" ||
      finishedEnv === "off" ||
      finishedEnv === "ignore" ||
      finishedEnv === "игнор"
    ) {
      statusFinishedOnly = null;
    } else if (
      finishedEnv === "not_finished" ||
      finishedEnv === "notfinished" ||
      finishedEnv === "2" ||
      finishedEnv === "незаверш" ||
      finishedEnv === "незавершенные"
    ) {
      throw new Error(
        "[setup] RAS_STATUS_FINISHED_ONLY='not_finished' пока не поддерживается. " +
          "Допустимые значения: 1/yes/on (завершённые) или 0/no/off (игнор).",
      );
    } else {
      statusFinishedOnly = "finished";
    }
    log(
      `[setup] статус=${statusFinishedOnly === null ? "выкл" : statusFinishedOnly} ` +
        `(RAS_STATUS_FINISHED_ONLY)`,
    );
  }

  // === Мотивировка ===
  // Канонический набор фильтров: 3 specific TypeId ∪ umbrella с allowlist жанров.
  // «Все подряд» (без отсева резолютивок / судприказов) — пока не поддерживается,
  // планируется отдельной БД. См. CLAUDE.md «Главное правило отбора актов».
  if (interactive) {
    while (true) {
      const raw = (
        await _ask(
          "Тащим акты с мотивировочной частью или все подряд? " +
            "[Enter = с мотивировкой]: ",
        )
      ).trim().toLowerCase();
      if (raw === "" || raw.includes("мотив") || raw === "1") break;
      if (raw.includes("все") || raw.includes("всё") || raw === "2") {
        throw new Error(
          "[setup] режим 'все подряд' (без фильтра мотивировки) пока не " +
            "поддерживается. Под него планируется отдельная БД. " +
            "Жми Enter, чтобы взять акты с мотивировочной частью.",
        );
      }
      throw new Error(`[setup] выбор '${raw}' не распознан. Жми Enter или введи 'с мотивировкой'.`);
    }
  }
  const targetTypeIds = [...DEFAULT_DECISION_TYPE_IDS];

  // === Продолжить с прошлого прогона? ===
  // Два уровня приоритета:
  //
  //   1. Чекпоинт parser_state.json (есть только если прошлый прогон не
  //      завершился — упал, был убит SIGINT, или дошёл до oldestDay
  //      без чистого `_clearParserState`). Это самое точное «откуда продолжить».
  //
  //   2. Если чекпоинта нет — смотрим границы дат в `acts` и предлагаем
  //      готовые сценарии:
  //        a) Свежие     — endDay = вчера, oldestDay = MAX(date) в БД
  //                        (добрать хвост от последнего собранного дня до сегодня).
  //        b) В прошлое  — endDay = MIN(date) - 1 день, oldestDay спросим
  //                        отдельно (бесконечно назад по дефолту).
  //        c) Вручную    — старое поведение.
  //
  // Всё это только в интерактивном режиме (TTY). Non-TTY (cron / API) —
  // берёт даты из env (RAS_DATE_TO / RAS_DATE_FROM), state-файл игнорирует
  // (cron всё равно знает, что хочет — env переопределяет).
  let preEndDay = null;
  let preOldestDay;

  if (interactive) {
    const state = _loadParserState();
    if (state && state.nextEndDay) {
      const updatedHuman = state.updatedAt
        ? state.updatedAt.replace("T", " ").replace(/\..*Z$/, " UTC")
        : "?";
      while (true) {
        const raw = (
          await _ask(
            `Найден незавершённый прогон: остановился на ${_formatDdMmYyyy(state.nextEndDay)} ` +
              `(нижняя граница ${state.oldestDay === null ? "нет" : _formatDdMmYyyy(state.oldestDay)}, ` +
              `сохранён ${updatedHuman}). Продолжить? [Enter=да, n=нет]: `,
          )
        ).trim().toLowerCase();
        if (
          raw === "" || raw === "y" || raw === "yes" ||
          raw === "д" || raw === "да"
        ) {
          preEndDay = state.nextEndDay;
          preOldestDay = state.oldestDay;
          log(
            `[setup] продолжаю незавершённый прогон: ` +
              `дата_до=${_formatDdMmYyyy(preEndDay)}, ` +
              `дата_с=${state.oldestDay === null ? "нет" : _formatDdMmYyyy(state.oldestDay)}`,
          );
          break;
        }
        if (raw === "n" || raw === "no" || raw === "нет" || raw === "н") {
          _clearParserState();
          log("[setup] чекпоинт удалён по запросу пользователя — начнём заново");
          break;
        }
        process.stdout.write("Введи y/n или Enter (= да).\n");
      }
    }
  }

  if (preEndDay === null && preOldestDay === undefined && interactive && _pgIsConfigured()) {
    let bounds = null;
    try {
      bounds = await _pgGetActsDateBounds();
    } catch (e) {
      log(`[setup] не смог запросить границы дат из БД (${e.message}) — спрошу даты с нуля`);
    }
    if (bounds && bounds.total > 0 && bounds.minDate && bounds.maxDate) {
      const minD = _parseIsoDate(bounds.minDate);
      const maxD = _parseIsoDate(bounds.maxDate);
      const haveFreshGap = maxD && _startOfDay(maxD).getTime() < defaultEndDay.getTime();
      log(
        `[setup] в БД ${bounds.total} актов: ` +
          `${_formatDdMmYyyy(minD)} → ${_formatDdMmYyyy(maxD)}` +
          (haveFreshGap
            ? ""
            : ` (свежие до ${_formatDdMmYyyy(defaultEndDay)} уже есть, опция «добрать свежие» недоступна)`),
      );
      while (true) {
        const freshLabel = haveFreshGap
          ? `[1] добрать свежие (${_formatDdMmYyyy(maxD)} → ${_formatDdMmYyyy(defaultEndDay)}), `
          : "";
        const raw = (
          await _ask(
            `Продолжить с прошлого прогона? ` +
              freshLabel +
              `[2] идти назад от ${_formatDdMmYyyy(minD)} вглубь прошлого, ` +
              `[3] задать даты вручную ` +
              `[Enter = 2]: `,
          )
        ).trim();
        if (raw === "1") {
          if (!haveFreshGap) {
            process.stdout.write(
              `В БД уже есть данные за ${_formatDdMmYyyy(defaultEndDay)} (последний акт — ` +
                `${_formatDdMmYyyy(maxD)}). Нечего добирать. Выбери 2 или 3.\n`,
            );
            continue;
          }
          preEndDay = defaultEndDay;
          preOldestDay = _startOfDay(maxD);
          log(
            `[setup] продолжаю свежие: дата_до=${_formatDdMmYyyy(preEndDay)}, ` +
              `дата_с=${_formatDdMmYyyy(preOldestDay)} (= MAX(date) в БД, перепроверим день)`,
          );
          break;
        }
        if (raw === "" || raw === "2") {
          const newEnd = new Date(
            minD.getFullYear(),
            minD.getMonth(),
            minD.getDate() - 1,
          );
          preEndDay = _startOfDay(newEnd);
          log(
            `[setup] идём в прошлое: дата_до=${_formatDdMmYyyy(preEndDay)} ` +
              `(день до самого раннего акта в БД ${_formatDdMmYyyy(minD)}). ` +
              `Спрошу нижнюю границу отдельно.`,
          );
          break;
        }
        if (raw === "3") {
          // Старое поведение: спросить обе даты руками.
          break;
        }
        process.stdout.write(
          `Введи ${haveFreshGap ? "1, " : ""}2, 3 или Enter (= 2).\n`,
        );
      }
    }
  }

  // Non-interactive: приоритет parser_state.json над env, чтобы supervised-
  // рестарт продолжал с точки падения, а не с «вчера». В TTY-интерактиве
  // state.json подсасывается выше через явный вопрос «продолжить?».
  if (!interactive && preEndDay === null && preOldestDay === undefined) {
    const state = _loadParserState();
    if (state && state.nextEndDay) {
      preEndDay = state.nextEndDay;
      preOldestDay = state.oldestDay;
      log(
        `[setup] non-interactive: подхватываю parser_state.json — ` +
          `дата_до=${_formatDdMmYyyy(preEndDay)}, ` +
          `дата_с=${state.oldestDay === null ? "нет" : _formatDdMmYyyy(state.oldestDay)}` +
          (state.updatedAt ? ` (сохранён ${state.updatedAt})` : ""),
      );
    }
  }

  const toRaw = interactive ? "" : (process.env.RAS_DATE_TO ?? "").trim();
  let endDay = preEndDay;
  if (toRaw && endDay === null) {
    // state.json не подхватился — пробуем env RAS_DATE_TO.
    const parsed = _parseDdMmYyyy(toRaw);
    if (parsed === null) {
      log(`[setup] дата «до» '${toRaw}' не DD.MM.YYYY — спрошу в терминале`);
    } else {
      endDay = _startOfDay(parsed);
      log(`[setup] дата «до»=${_formatDdMmYyyy(endDay)} (RAS_DATE_TO)`);
    }
  } else if (toRaw && endDay !== null) {
    log(`[setup] RAS_DATE_TO='${toRaw}' проигнорирован — state.json приоритетнее`);
  }
  if (endDay === null && !interactive) {
    endDay = defaultEndDay;
    log(
      "[setup] non-interactive и нет state.json/RAS_DATE_TO — " +
        `дата «до»=вчера ${_formatDdMmYyyy(endDay)} (как Enter на вопросе «дата до»)`,
    );
  }
  if (endDay === null) {
    while (true) {
      const raw = (
        await _ask(
          `Дата «до» — правый край первого окна, DD.MM.YYYY ` +
            `[Enter = вчера ${_formatDdMmYyyy(defaultEndDay)} ` +
            `(сегодня ${_formatDdMmYyyy(todayDt)})]: `,
        )
      ).trim();
      if (raw === "") {
        endDay = defaultEndDay;
        break;
      }
      const parsed = _parseDdMmYyyy(raw);
      if (parsed !== null) {
        endDay = _startOfDay(parsed);
        break;
      }
      process.stdout.write("Формат DD.MM.YYYY, например 03.05.2026.\n");
    }
  }

  let oldestDay = preOldestDay;
  if (!interactive && oldestDay === undefined && process.env.RAS_DATE_FROM !== undefined) {
    // state.json не подхватился — пробуем env RAS_DATE_FROM.
    oldestDay = _parseDateFromEnv(process.env.RAS_DATE_FROM, "RAS_DATE_FROM");
    if (oldestDay === undefined && String(process.env.RAS_DATE_FROM).trim() !== "") {
      log(`[setup] RAS_DATE_FROM задан некорректно — спрошу в терминале`);
    } else if (oldestDay !== undefined) {
      log(
        `[setup] дата «с» (нижняя граница)=` +
          `${oldestDay === null ? "нет" : _formatDdMmYyyy(oldestDay)} (RAS_DATE_FROM)`,
      );
    }
  } else if (!interactive && oldestDay !== undefined && process.env.RAS_DATE_FROM !== undefined) {
    log(`[setup] RAS_DATE_FROM игнорирован — state.json приоритетнее`);
  }
  if (oldestDay === undefined && !interactive) {
    log(
      "[setup] non-interactive и нет state.json/RAS_DATE_FROM — " +
        "нижняя граница дат: нет (как пустой Enter на вопросе «дата с»)",
    );
    oldestDay = null;
  }
  if (oldestDay === undefined) {
    while (true) {
      const raw = (
        await _ask(
          `Дата «с» — не сдвигать окна дальше назад, если конец окна раньше этой даты ` +
            `(DD.MM.YYYY; Enter = без нижней границы, парсер идёт бесконечно назад): `,
        )
      ).trim();
      if (raw === "") {
        oldestDay = null;
        break;
      }
      const parsed = _parseDdMmYyyy(raw);
      if (parsed !== null) {
        oldestDay = _startOfDay(parsed);
        break;
      }
      process.stdout.write("Формат DD.MM.YYYY или пустой ввод.\n");
    }
  }

  if (oldestDay !== null && _startOfDay(endDay).getTime() < oldestDay.getTime()) {
    log(
      `[setup] дата «до» раньше даты «с» — меняю местами: ` +
        `${_formatDdMmYyyy(endDay)} ↔ ${_formatDdMmYyyy(oldestDay)}`,
    );
    const t = endDay;
    endDay = oldestDay;
    oldestDay = _startOfDay(t);
  }

  const rakLabel =
    rakDocumentTypeFilter === null
      ? "off"
      : `[${[...rakDocumentTypeFilter].join(",")}]`;
  log(
    `[setup] mode=acts (Postgres sink), show_browser=${!headless}, ` +
      `supply_filter_31=${supplyFilter31}, ` +
      `status_filter=${statusFinishedOnly ?? "off"}, ` +
      `rak_doc_type_filter=${rakLabel}, ` +
      `дата_до=${_formatDdMmYyyy(endDay)}` +
      (oldestDay === null
        ? ", дата_с=нет (идём бесконечно назад)"
        : `, дата_с=${_formatDdMmYyyy(oldestDay)} (стоп при сдвиге окна за неё)`) +
      ` (пустые дни пропускаются)`,
  );
  log(
    `[setup] фильтр: specific TypeId (${targetTypeIds.length}) ∪ ` +
      `umbrella ${UMBRELLA_DECISION_TYPE_ID} с allowlist жанров ` +
      `(${UMBRELLA_FINAL_GENRE_GUIDS.size} GUID); verdict-резолвер кросс-CaseId ` +
      `на каждый flush в acts`,
  );
  return [
    mode,
    targetTypeIds,
    endDay,
    oldestDay,
    supplyFilter31,
    statusFinishedOnly,
    rakDocumentTypeFilter,
  ];
}

function _resetDebugDir() {
  if (fs.existsSync(DEBUG_DIR)) {
    try {
      fs.rmSync(DEBUG_DIR, { recursive: true, force: true });
    } catch (e) {
      log(`[debug] не удалось очистить ${DEBUG_DIR}: ${e}`);
    }
  }
  try {
    fs.mkdirSync(DEBUG_DIR, { recursive: true });
  } catch (e) {
    log(`[debug] не удалось создать ${DEBUG_DIR}: ${e}`);
  }
}

async function _dumpDebug(page) {
  log("[debug] Сохраняю скриншот, html и список XHR в ./debug");
  try {
    fs.writeFileSync(DEBUG_RESPONSES, _responseLog.join("\n"), "utf-8");
  } catch (e) {
    log(`[debug] не записал ${DEBUG_RESPONSES}: ${e}`);
  }
  try {
    await page.screenshot({ path: DEBUG_SCREENSHOT, fullPage: true });
  } catch (e) {
    log(`[debug] не записал ${DEBUG_SCREENSHOT}: ${e}`);
  }
  try {
    fs.writeFileSync(DEBUG_HTML, await page.content(), "utf-8");
  } catch (e) {
    log(`[debug] не записал ${DEBUG_HTML}: ${e}`);
  }
}

async function _waitForSearchWithHeartbeat(timeoutMs) {
  const deadline = monotonic() + timeoutMs / 1000;
  let lastTick = 0.0;
  while (monotonic() < deadline) {
    if (_captured.url !== null) {
      log("[wait] Ответ /Search получен.");
      return true;
    }
    const now = monotonic();
    if (now - lastTick >= 1.0) {
      const remaining = Math.floor(deadline - now);
      log(
        `[wait] жду /Search... ещё ${remaining}с, ` +
          `пойманных XHR: ${_responseLog.length}`,
      );
      lastTick = now;
    }
    await _stealth.smartWait("micro");
  }
  log("[wait] Таймаут — ответ /Search так и не пришёл.");
  return false;
}

/** Поднимает сессию поиска: goto → форма (3.1/период) → «Найти» → ловит первый POST /Search. */
async function _setupSearchSession(
  page,
  {
    maxAttempts = 5,
    supplyFilter31 = false,
    statusFinishedOnly = null,
    rakDocumentTypeFilter = null,
    periodBody = null,
  } = {},
) {
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (attempt > 1) {
      _captured.url = null;
      _captured.headers = null;
      _captured.body = null;

      log(
        `[setup] попытка ${attempt}/${maxAttempts}: «тихий бан» — ` +
          `страница загрузилась, JS не отработал, эскалирую через _recoverFrom ` +
          `и переоткрываю главную`,
      );
      const rotated = await _recoverFrom(`silent-ban setup#${attempt}`);
      if (!rotated) {
        log("[setup] _recoverFrom не сработал — отдельный ip_cooldown");
        await _stealth.smartWait("ip_cooldown");
      }
      await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });
    }

    log(
      "[load] прогреваю страницу через smartWait('warmup') — " +
        "JS/jQuery/fingerprint должны успеть проинициализироваться",
    );
    await _stealth.smartWait("warmup");
    if (RAS_META_PRAVO_WAIT_MS > 0) {
      log(
        `[load] pravocaptcha pause ${RAS_META_PRAVO_WAIT_MS}мс — cap-cookies ` +
          "ставятся background-JS после DOMContentLoaded; без этого первый " +
          "POST /Search на свежем IP может вернуть tokenFrom-HTML",
      );
      await _sleepMs(RAS_META_PRAVO_WAIT_MS);
    }

    try {
      const hasJq = await page.evaluate(
        () => !!window.jQuery && !!window.jQuery("#b-form-submit").length,
      );
      log(`[load] jQuery + #b-form-submit готовы: ${hasJq}`);
    } catch (e) {
      log(`[load] проверка jQuery упала: ${e}`);
    }

    if (supplyFilter31) {
      const applied = await _applySupplyDisputeFilter31(page);
      if (!applied) {
        log(
          `[setup] попытка ${attempt}/${maxAttempts}: фильтр 3.1 не применился. ` +
            `БЕЗ ФИЛЬТРА «Найти» собирает дела ВСЕХ категорий — это мусор. ` +
            `Перезапускаю сессию через _recoverFrom + reload вместо тихого продолжения.`,
        );
        continue;
      }
    }

    if (
      periodBody !== null &&
      periodBody.DateFrom &&
      periodBody.DateTo
    ) {
      const filled = await _fillPeriodDatesFromBody(page, periodBody);
      if (!filled) {
        log(
          "[setup] период в форме перед «Найти» не выставлен — остаются значения страницы",
        );
      }
      await _stealth.smartWait("micro");
    }

    // Закрытие календаря/оверлея иногда шлёт POST /Search раньше «Найти».
    // Если не сбросить захват, `_onResponse` запомнит чужое тело запроса,
    // heartbeat решит что всё ок, а РАК/статус повиснут на DOM до таймаута.
    _captured.url = null;
    _captured.headers = null;
    _captured.body = null;

    log(
      `[wait] жду POST /Search после «Найти» до ${Math.floor(WAIT_FOR_SEARCH_MS / 1000)}с...`,
    );
    const searchBaseline = _searchPostSeq;
    const respPromise = page.waitForResponse(_searchPostResponsePredicate, {
      timeout: 120_000,
    });
    const clicked = await _clickFind(page, {
      searchPostBaselineSeq: searchBaseline,
    });

    let firstSearchResponse = null;
    if (!clicked) {
      void respPromise.catch(() => {});
      log("[click] НЕ удалось кликнуть ни одним способом");
    } else {
      try {
        firstSearchResponse = await respPromise;
      } catch (e) {
        void respPromise.catch(() => {});
        log(`[setup] waitForResponse(/Search): ${e}`);
      }
    }

    if (firstSearchResponse !== null) {
      let raw = null;
      try {
        raw = await firstSearchResponse.body();
      } catch (e) {
        log(`[setup] первый /Search resp.body() упал: ${e}`);
      }
      if (raw !== null && raw !== undefined) {
        _dumpSearchResponse(
          `setup-p${attempt}-first-search-status${firstSearchResponse.status()}`,
          raw,
          "bin",
        );
      }
      if (firstSearchResponse.status() === 200) {
        try {
          _syncCapturedFromSearchResponse(firstSearchResponse);
        } catch (e) {
          log(`[setup] _syncCapturedFromSearchResponse: ${e}`);
        }
        let parsed = null;
        try {
          const text =
            raw !== null && raw !== undefined
              ? raw.toString("utf8")
              : await firstSearchResponse.text();
          parsed = JSON.parse(text);
        } catch (e) {
          log(`[setup] первый /Search JSON: ${e}`);
        }
        if (parsed !== null && _rasListingEmptyBeforeTopFilters(parsed)) {
          log(
            "[setup] выдача по периоду пустая — фильтры РАК/«Статус» в DOM нет, " +
              "пропускаю их (это не бан, IP не кручу)",
          );
          log(
            `[setup] сессия поднята с попытки ${attempt}/${maxAttempts}: ` +
              `${_captured.url}`,
          );
          return true;
        }
      }
    }

    if (_captured.url === null) {
      await _waitForSearchWithHeartbeat(WAIT_FOR_SEARCH_MS);
    }

    if (_captured.url !== null) {
      const rakActive =
        rakDocumentTypeFilter instanceof Set && rakDocumentTypeFilter.size > 0;
      if (rakActive) {
        const filteredRak = await _applyRakDocumentTypeFilter(
          page,
          rakDocumentTypeFilter,
        );
        if (!filteredRak) {
          log(
            `[setup] попытка ${attempt}/${maxAttempts}: не удалось применить ` +
              "фильтр РАК «Тип документа»",
          );
          continue;
        }
      }
      if (statusFinishedOnly === "finished") {
        const filtered = await _applyStatusFilter(page, statusFinishedOnly);
        if (!filtered) {
          log(
            `[setup] попытка ${attempt}/${maxAttempts}: не удалось применить ` +
              `статус «${statusFinishedOnly}»`,
          );
          continue;
        }
      }
      log(
        `[setup] сессия поднята с попытки ${attempt}/${maxAttempts}: ` +
          `${_captured.url}`,
      );
      return true;
    }

    log(
      `[setup] попытка ${attempt}/${maxAttempts}: /Search так и не пришёл — ` +
        `похоже на тихий бан`,
    );
  }
  log(
    `[setup] исчерпано ${maxAttempts} попыток поднять сессию — ` +
      `сдаюсь, дальше пагинация не пойдёт`,
  );
  return false;
}

function _bindPageDebugListeners(page) {
  page.on("request", _onRequest);
  page.on("requestfailed", _onRequestFailed);
  page.on("response", (resp) => {
    _onResponse(resp).catch((e) => log(`[on_response] ${e}`));
  });
}

async function main() {
  const headless = await _resolveHeadlessFromEnvOrPrompt();

  let mode = MODE_TYPES;
  let endDay = _startOfDay(new Date());
  let oldestDay = null;
  let supplyFilter31 = false;
  /** @type {"finished"|null} */
  let statusFinishedOnly = null;
  /** @type {Set<"decision"|"appeal"|"cassation">|null} */
  let rakDocumentTypeFilter = null;
  let targetTypeIdsSet = new Set();

  let context = null;
  let userDataDir = null;
  /** Профиль из RAS_BROWSER_USER_DATA_DIR — не удаляем каталог при recycle. */
  let userDataDirPersistent = false;
  let page = null;
  let mpProxyClient = null;
  /** holder_id для proxy_leases — фиксируется на старте, освобождается в finally. */
  let leaseHolderId = null;
  /** stop()-callback для heartbeat. */
  let leaseStopHeartbeat = null;

  // Все вопросы должны быть завершены до старта парсера и поднятия браузера.
  const setup = await _promptSetup(headless);
  [
    mode,
    ,
    endDay,
    oldestDay,
    supplyFilter31,
    statusFinishedOnly,
    rakDocumentTypeFilter,
  ] = setup;
  const targetTypeIds = setup[1];
  targetTypeIdsSet = new Set(targetTypeIds.map((v) => _normalizeTypeIdValue(v)));
  _currentMode = mode;

  log("=== старт parser.js ===");
  fs.mkdirSync(PARSED_DATA_DIR, { recursive: true });
  log(`[data] папка результатов: ${PARSED_DATA_DIR}`);
  _resetDebugDir();
  log("[debug] папка ./debug пересоздана");
  if (mode === MODE_TYPES) {
    _loadExisting();
  } else {
    if (!_pgIsConfigured()) {
      throw new Error(
        "[setup] DSN не задан. Postgres теперь канонический sink для acts " +
          "(см. CLAUDE.md и db/schema.sql). Поставь RAS_PG_DSN или DATABASE_URL в .env, " +
          "прокати миграцию `psql \"$DSN\" -f db/schema.sql` и запусти снова.",
      );
    }
    _loadExistingDecisionLinks();
    log(
      `[setup] сбор PDF-ссылок по TypeId (${targetTypeIds.length} специфичных + ` +
        `umbrella ${UMBRELLA_DECISION_TYPE_ID} с allowlist жанров) -> Postgres table acts`,
    );
    // Startup sweep: ловим legacy-сирот (verdict_keep=FALSE + RAG-артефакты),
    // которые могли накопиться до ввода cleanup-механики, либо после кр crashes
    // прошлого прогона между upsert'ом нового вердикта и собственно cleanup'ом.
    try {
      const swept = await _cleanupInvalidActs({ log });
      log(
        `[cleanup/startup] scanned=${swept.scanned} reset=${swept.rows_reset} ` +
          `qdrant_deleted=${swept.qdrant_deleted} pdf_deleted=${swept.pdf_deleted} errors=${swept.errors}`,
      );
    } catch (e) {
      log(`[cleanup/startup] FAIL ${e?.stack ?? e?.message ?? e}`);
    }
  }

  try {
    _startStuckWatchdog();
    log(
      `[watchdog] stuck-limit=${Math.floor(_WATCHDOG_STUCK_MS / 1000)}s, ` +
        `check=${Math.floor(_WATCHDOG_INTERVAL_MS / 1000)}s, exit_code=${_WATCHDOG_EXIT_CODE}`,
    );
    log("[browser] запускаю Playwright...");

    // Fail-fast по конфигу: пустые PROXY_USER/PROXY_PASS — это почти
    // всегда «.env не загрузился» (запуск `node parser.js` без
    // --env-file). Без этого пойдут 200 попыток с
    // ERR_INVALID_AUTH_CREDENTIALS, сжигая cooldowns.
    if (PROXY_SERVER && (!PROXY_USER || !PROXY_PASS)) {
      throw new Error(
        `[config] PROXY_SERVER='${PROXY_SERVER}' задан, но MP_PROXY_USER/MP_PROXY_PASS пустые. ` +
          `Скорее всего .env не загружен. Запускай через 'npm start' либо ` +
          `'node --env-file=.env parser.js'. Если запускаешь как 'node parser.js' — ` +
          `loadEnv.js должен подхватывать .env автоматически (Node ${process.version}, ` +
          `process.loadEnvFile=${typeof process.loadEnvFile}).`,
      );
    }

    const launchKwargs = _launchKwargs();
    launchKwargs.headless = headless;
    log(
      `[browser] запускаю Chromium (headless=${headless}, прокси=${PROXY_SERVER}, ` +
        `proxy_auth=${PROXY_USER ? `${PROXY_USER}:***` : "none"}, ` +
        `executable=${launchKwargs.executablePath ?? "default"})`,
    );
    const rasFp = buildRasBrowserFingerprint();
    const udd = _resolveParserBrowserUserDataDir();
    userDataDir = udd.dir;
    userDataDirPersistent = udd.persistent;
    log(
      `[browser] userDataDir=${userDataDirPersistent ? `persistent (${userDataDir})` : "temp"}, ` +
        `ua_Chrome=${rasFp.userAgent.match(/Chrome\/([\d.]+)/)?.[1] ?? "?"}`,
    );
    context = await chromium.launchPersistentContext(userDataDir, {
      locale: "ru-RU",
      timezoneId: "Europe/Moscow",
      userAgent: rasFp.userAgent,
      viewport: { width: 1366, height: 900 },
      extraHTTPHeaders: rasFp.extraHTTPHeaders,
      ...launchKwargs,
    });
    await attachRasAntiDetectToContext(context);
    log("[browser] persistent-context готов");

    const pages = context.pages();
    page = pages.length ? pages[0] : await context.newPage();
    _stealth = await StealthBrowserManager.create(page, { logger: log });
    log("[stealth] StealthBrowserManager инициализирован");

    if (!MP_API_TOKEN) {
      throw new Error(
        "MP_API_TOKEN обязателен: legacy-режим без SDK удалён, " +
          "без токена эскалация недоступна",
      );
    }
    mpProxyClient = new RasProxyClient({
      apiToken: MP_API_TOKEN,
      proxyKey: MP_PROXY_KEY,
      proxyId: MP_PROXY_ID,
      minIpRotateGapSec: CHANGE_IP_COOLDOWN_SEC,
      minEquipmentSwapGapSec: ESC_EQUIPMENT_COOLDOWN_SEC,
      minGeoSwapGapSec: CHANGE_GEO_COOLDOWN_SEC,
      logger: log,
    });

    // Координация прокси с pdf/downloader: занимаем MP_PROXY_KEY в proxy_leases.
    // Если ключ занят качалкой PDF — падаем с понятным сообщением, чтобы не
    // ловить хаос changeIp/cookie от обоих процессов на одном gateway.
    //
    // Retry-цикл: supervisor рестартит парсер через 5с после kill. Старый PID
    // может ещё доумирать (Chromium закрывается), `process.kill(pid, 0)` пока
    // не даёт ESRCH → `releaseDeadLocalLeases` не чистит «нашу» аренду. До
    // фикса это приводило к crash-loop'у через `lease conflict` пока TTL (5
    // мин) не истечёт. Теперь: ждём 5–15с между попытками, повторяем cleanup,
    // даём системе доubrать зомби. До 4 попыток ≈ 30с — потом сдаёмся, exit=1,
    // supervisor рестартит с большим интервалом.
    const leaseCleanupOnStart =
      (process.env.RAS_PDF_LEASE_CLEANUP_ON_START ?? "1").trim() !== "0";
    let leaseRes = null;
    const leaseAcquireMaxAttempts = 4;
    let lastLeaseError = null;
    for (let attempt = 1; attempt <= leaseAcquireMaxAttempts; attempt += 1) {
      if (leaseCleanupOnStart) {
        try {
          await _leaseReleaseDeadLocal({ logger: log });
        } catch (e) {
          log(`[lease] releaseDeadLocalLeases перед claim: ${e && e.message}`);
        }
      }
      try {
        leaseRes = await _leaseAcquire({
          key: MP_PROXY_KEY,
          role: "parser",
          logger: log,
        });
        lastLeaseError = null;
        break;
      } catch (e) {
        lastLeaseError = e;
        if (attempt >= leaseAcquireMaxAttempts) break;
        const waitMs = 5_000 * attempt;
        log(
          `[lease] попытка ${attempt}/${leaseAcquireMaxAttempts} не удалась ` +
            `(${e && e.message?.split("\n")[0]}), жду ${Math.floor(waitMs / 1000)}с и ` +
            `повторяю cleanup+claim (если старый PID ещё доумирает — успеет)`,
        );
        await _sleepMs(waitMs);
      }
    }
    if (!leaseRes) {
      throw lastLeaseError ?? new Error("[lease] acquire: неизвестная ошибка");
    }
    leaseHolderId = leaseRes.holderId;
    if (leaseRes.leased) {
      leaseStopHeartbeat = _leaseStartHeartbeat({
        holderId: leaseHolderId,
        logger: log,
      });
    }
    _escalator = new ProxyEscalator({
      proxyClient: mpProxyClient,
      stealth: _stealth,
      logger: log,
      maxIpRotationsBeforeEquipment: ESC_MAX_IP_BEFORE_EQUIPMENT,
      maxOperatorSwapsBeforeGeo: ESC_MAX_OPERATOR_BEFORE_GEO,
      geoFilters: GEO_FILTERS,
    });
    log(
      `[escalator] включён: maxIp=${ESC_MAX_IP_BEFORE_EQUIPMENT}, ` +
        `maxOp=${ESC_MAX_OPERATOR_BEFORE_GEO}, ` +
        `maxSearchPages=${MAX_PAGES}, ` +
        `emptyStreakStop=${RAS_EMPTY_WINDOW_STREAK_LIMIT <= 0 ? "off" : RAS_EMPTY_WINDOW_STREAK_LIMIT}, ` +
        `waitSearchMs=${WAIT_FOR_SEARCH_MS}`,
    );
    log(
      `[escalator] geoFilters: country=${GEO_FILTERS.requireCountryId ?? "any"}, ` +
        `includeRegex=${GEO_FILTERS.includeCaptionRegex ? GEO_FILTERS.includeCaptionRegex.source : "off"}, ` +
        `excludeCities=[${GEO_FILTERS.excludeCityIds.join(",")}], ` +
        `captionRegex=${GEO_FILTERS.excludeCaptionRegex ? GEO_FILTERS.excludeCaptionRegex.source : "off"}`,
    );

    const [initialSetupDf, initialSetupDt] = _windowIso(endDay);
    const setupPeriodRef = {
      DateFrom: initialSetupDf,
      DateTo: initialSetupDt,
    };

    const recycleBrowserAfterDupIp = async () => {
      log(
        "[browser] recycle: duplicate new_ip — новый persistent-context и сессия /Search",
      );
      _captured.url = null;
      _captured.headers = null;
      _captured.body = null;
      if (mpProxyClient) mpProxyClient.resetReportedIpTracking();

      if (context !== null) {
        try {
          await context.close();
        } catch (e) {
          log(`[browser] recycle: context.close() ${e}`);
        }
      }
      context = null;
      if (userDataDir && !userDataDirPersistent) {
        try {
          fs.rmSync(userDataDir, { recursive: true, force: true });
        } catch {}
      }
      if (!userDataDirPersistent) {
        userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "ras_chromium_"));
      }
      const recycleFp = buildRasBrowserFingerprint();
      context = await chromium.launchPersistentContext(userDataDir, {
        locale: "ru-RU",
        timezoneId: "Europe/Moscow",
        userAgent: recycleFp.userAgent,
        viewport: { width: 1366, height: 900 },
        extraHTTPHeaders: recycleFp.extraHTTPHeaders,
        ...launchKwargs,
      });
      await attachRasAntiDetectToContext(context);
      const freshPages = context.pages();
      page = freshPages.length ? freshPages[0] : await context.newPage();
      _stealth = await StealthBrowserManager.create(page, { logger: log });
      if (_escalator) _escalator.stealth = _stealth;
      _bindPageDebugListeners(page);
      log(
        "[browser] recycle: подписался на page.on('request' | 'requestfailed' | 'response', ...)",
      );
      await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });
      const maxRecycleSetup = 3;
      let up = false;
      for (let rs = 1; rs <= maxRecycleSetup; rs += 1) {
        try {
          up = await _withTimeout(
            _setupSearchSession(page, {
              supplyFilter31,
              statusFinishedOnly,
              rakDocumentTypeFilter,
              periodBody: setupPeriodRef,
            }),
            SETUP_ATTEMPT_DEADLINE_MS,
            `[browser] recycle setup ${rs}/${maxRecycleSetup}`,
          );
        } catch (e) {
          log(`[browser] recycle setup ${rs}/${maxRecycleSetup}: ${e && e.message}`);
          up = false;
        }
        if (up) break;
        log(
          `[browser] recycle: POST /Search не пойман (попытка setup ${rs}/${maxRecycleSetup})`,
        );
        if (rs < maxRecycleSetup) await _stealth.smartWait("reading");
      }
      if (!up) {
        throw new Error(
          "[browser] recycle: не пойман POST /Search после перезапуска — см. ./debug/",
        );
      }
    };
    _browserRecycleForDuplicateIp = recycleBrowserAfterDupIp;

    _bindPageDebugListeners(page);
    log(
      "[browser] подписался на page.on('request' | 'requestfailed' | 'response', ...)",
    );

    await _safeGoto(page, BASE_URL, { sentinelSelector: "#b-form-submit" });

    let sessionUp = false;
    try {
      sessionUp = await _withTimeout(
        _setupSearchSession(page, {
          supplyFilter31,
          statusFinishedOnly,
          rakDocumentTypeFilter,
          periodBody: setupPeriodRef,
        }),
        SETUP_ATTEMPT_DEADLINE_MS * 2,
        "[setup] initial",
      );
    } catch (e) {
      log(`[setup] initial deadline: ${e && e.message}`);
      sessionUp = false;
    }

    log("[wait] grace-пауза перед сбросом дебага через smartWait('reading')");
    await _stealth.smartWait("reading");
    await _dumpDebug(page);

    if (!sessionUp) {
      // КРИТИЧЕСКИ ВАЖНО: бросаем error, чтобы main catch выставил
      // process.exitCode=1 и supervisor пересоздал процесс. Без throw парсер
      // тихо завершался с exit=0, supervisor НЕ рестартил → парсинг
      // останавливался навсегда. Видели в реальном прогоне: RAS залип на
      // кликах РАК-фильтра, initial setup deadline 300с пробил Promise.race,
      // sessionUp=false, log + exit, supervisor: «parser exit=0 — выхожу без
      // рестарта». Это ровно противоположно тому, что нужно для долгого
      // аптайма: bad IP должен триггерить рестарт со свежим прокси.
      throw new Error(
        "[result] Запрос /Search не пойман после initial setup — рестарт через supervisor"
      );
    } else {
      let bodyTemplate = null;
      const maxBodyParseAttempts = 5;
      for (let bpa = 1; bpa <= maxBodyParseAttempts; bpa += 1) {
        try {
          bodyTemplate = JSON.parse(_captured.body);
          break;
        } catch (e) {
          log(`[main] тело /Search не JSON (попытка ${bpa}/${maxBodyParseAttempts}): ${e}`);
          if (bpa >= maxBodyParseAttempts) {
            bodyTemplate = null;
            break;
          }
          log("[main] повторно поднимаю сессию поиска после битого шаблона...");
          const upAgain = await _setupSearchSession(page, {
            supplyFilter31,
            statusFinishedOnly,
            rakDocumentTypeFilter,
            periodBody: setupPeriodRef,
          });
          if (!upAgain) {
            log("[main] повторный setup не поднял /Search — шаблон недоступен");
            bodyTemplate = null;
            break;
          }
        }
      }

      if (bodyTemplate !== null) {
        let outerEnd = endDay;
        let cycle = 0;
        let emptyStreak = 0;

        let pendingSubs = [{ endDay: outerEnd, daysSpan: 1 }];
        let outerHadItems = false;
        let outerStats = {
          totalItems: 0,
          addedTypes: 0,
          relabeledTypes: 0,
          pagesSeen: 0,
          subsDone: 0,
          linksSkippedCategory: 0,
        };

        // Чекпоинт позиции окна: пишем при старте (если процесс упадёт сейчас,
        // следующий запуск стартанёт с endDay), потом обновляем после каждой
        // успешной смены outerEnd. SIGINT-handler сохранит текущее значение.
        //
        // resumeForFirstWindow: если предыдущий прогон упал внутри окна
        // (state.currentLastPage > 0) и текущий outerEnd совпадает с
        // state.nextEndDay — продолжаем со страницы currentLastPage+1, чтобы
        // не молотить впустую POST /Search по уже залитым в PG страницам.
        // Срабатывает только для ПЕРВОГО окна прогона; дальше каждое окно
        // стартует с 1.
        let resumeForFirstWindow = 0;
        if (mode === MODE_DECISION_LINKS) {
          const loaded = _loadParserState();
          if (
            loaded &&
            loaded.nextEndDay &&
            Number.isInteger(loaded.currentLastPage) &&
            loaded.currentLastPage > 0 &&
            _startOfDay(loaded.nextEndDay).getTime() === _startOfDay(outerEnd).getTime()
          ) {
            resumeForFirstWindow = loaded.currentLastPage;
            log(
              `[state] resume после рестарта: окно ${_formatDdMmYyyy(outerEnd)} ` +
                `продолжаю со страницы ${resumeForFirstWindow + 1} ` +
                `(прошлый прогон завершил ${resumeForFirstWindow})`,
            );
          }
          _currentParserState = {
            nextEndDay: outerEnd,
            oldestDay,
            currentLastPage: resumeForFirstWindow,
          };
          _saveParserState(_currentParserState);
          _installParserStateSigintOnce();
        }
        let firstWindowResumeConsumed = false;

        _inWindowLoop = true;
        while (true) {
          if (pendingSubs.length === 0) {
            if (outerHadItems) {
              cycle += 1;
              emptyStreak = 0;
              log(
                `=== цикл ${cycle} готов ` +
                  `(${_formatDdMmYyyy(outerEnd)}, 1д): ` +
                  `sub-окон=${outerStats.subsDone}, ` +
                  `страниц=${outerStats.pagesSeen}, ` +
                  `items=${outerStats.totalItems}, ` +
                  (mode === MODE_TYPES
                    ? `новых типов=${outerStats.addedTypes}, ` +
                      `обновлено подписей=${outerStats.relabeledTypes}`
                    : `новых pdf-ссылок=${outerStats.addedTypes}, ` +
                      `пропуск kad-категории=${outerStats.linksSkippedCategory}, ` +
                      `всего ссылок=${decisionLinks.size}`) +
                  ` ===`,
              );
            } else {
              emptyStreak += 1;
              log(
                `[skip] ${_formatDdMmYyyy(outerEnd)} пусто ` +
                  `(подряд пустых: ${emptyStreak}` +
                  (RAS_EMPTY_WINDOW_STREAK_LIMIT > 0
                    ? `/${RAS_EMPTY_WINDOW_STREAK_LIMIT}`
                    : ", лимит выкл.") +
                  `) — не засчитываю за цикл, иду назад`,
              );
              if (
                RAS_EMPTY_WINDOW_STREAK_LIMIT > 0 &&
                emptyStreak >= RAS_EMPTY_WINDOW_STREAK_LIMIT
              ) {
                log(
                  `[skip] ${emptyStreak} пустых окон подряд — автостоп ` +
                    `(RAS_EMPTY_WINDOW_STREAK_LIMIT=${RAS_EMPTY_WINDOW_STREAK_LIMIT}). ` +
                    `Чтобы убрать лимит: RAS_EMPTY_WINDOW_STREAK_LIMIT=0`,
                );
                if (mode === MODE_DECISION_LINKS) _clearParserState();
                break;
              }
            }
            outerEnd = new Date(
              outerEnd.getFullYear(),
              outerEnd.getMonth(),
              outerEnd.getDate() - 1,
            );
            if (
              oldestDay !== null &&
              _startOfDay(outerEnd).getTime() < oldestDay.getTime()
            ) {
              log(
                `[range] следующий конец окна ${_formatDdMmYyyy(outerEnd)} раньше ` +
                  `нижней границы ${_formatDdMmYyyy(oldestDay)} — останавливаюсь`,
              );
              if (mode === MODE_DECISION_LINKS) _clearParserState();
              break;
            }
            if (mode === MODE_DECISION_LINKS) {
              _currentParserState = {
                nextEndDay: outerEnd,
                oldestDay,
                currentLastPage: 0,
              };
              _saveParserState(_currentParserState);
            }
            pendingSubs = [{ endDay: outerEnd, daysSpan: 1 }];
            outerHadItems = false;
            outerStats = {
              totalItems: 0,
              addedTypes: 0,
              relabeledTypes: 0,
              pagesSeen: 0,
              subsDone: 0,
              linksSkippedCategory: 0,
            };
            continue;
          }

          const sub = pendingSubs.pop();
          const [df, dt] = _windowIso(sub.endDay);
          bodyTemplate.DateFrom = df;
          bodyTemplate.DateTo = dt;
          setupPeriodRef.DateFrom = df;
          setupPeriodRef.DateTo = dt;
          const cycleNumStr = String(cycle + 1).padStart(3, "0");
          const label =
            sub.daysSpan === 1
              ? `c${cycleNumStr}`
              : `c${cycleNumStr}d${sub.daysSpan}`;
          log(
            `=== пробую окно ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д ` +
              `(${df}..${dt}); завершено циклов: ${cycle}, ` +
              `в стеке ещё: ${pendingSubs.length} ===`,
          );

          let stats = null;
          let dupRecycleAttempts = 0;
          let resumeFromPage = 1;
          if (!firstWindowResumeConsumed && resumeForFirstWindow > 0) {
            resumeFromPage = resumeForFirstWindow + 1;
            firstWindowResumeConsumed = true;
          }
          while (true) {
            try {
              stats = await _walkPagesForBody(
                page,
                bodyTemplate,
                label,
                mode,
                targetTypeIdsSet,
                { rakDocumentTypeFilter, statusFinishedOnly },
                supplyFilter31,
                resumeFromPage,
              );
              break;
            } catch (err) {
              if (!(err instanceof RecycleWindowError)) throw err;
              dupRecycleAttempts += 1;
              if (dupRecycleAttempts > MAX_WINDOW_RECYCLES_AFTER_DUP_IP) {
                throw new Error(
                  `[main] duplicate new_ip: исчерпано ${MAX_WINDOW_RECYCLES_AFTER_DUP_IP} ` +
                    `перезапусков браузера на одном окне`,
                );
              }
              const fellOn = err.lastPageNum && err.lastPageNum > 0
                ? err.lastPageNum
                : 1;
              resumeFromPage = fellOn;
              log(
                `[main] ${err.message} — снова прогоняю окно ` +
                  `${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д ` +
                  `со страницы ${resumeFromPage} ` +
                  `(recycle ${dupRecycleAttempts}/${MAX_WINDOW_RECYCLES_AFTER_DUP_IP})`,
              );
              try {
                bodyTemplate = JSON.parse(_captured.body);
              } catch (pe) {
                throw new Error(`[main] recycle: шаблон запроса битый: ${pe}`);
              }
              bodyTemplate.DateFrom = df;
              bodyTemplate.DateTo = dt;
              setupPeriodRef.DateFrom = df;
              setupPeriodRef.DateTo = dt;
            }
          }

          outerStats.subsDone += 1;
          outerStats.totalItems += stats.items;
          outerStats.addedTypes += mode === MODE_TYPES ? stats.added : stats.links_added;
          outerStats.relabeledTypes += stats.relabeled;
          outerStats.pagesSeen += stats.pages_seen;
          outerStats.linksSkippedCategory +=
            mode === MODE_DECISION_LINKS ? stats.links_skipped_category : 0;
          if (stats.items > 0) outerHadItems = true;
          if (mode === MODE_TYPES) {
            log(
              `[sub] ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д готово: ` +
                `TotalCount=${stats.total}, ` +
                `страниц=${stats.pages_seen}, items=${stats.items}, ` +
                `новых типов=${stats.added}, ` +
                `обновлено подписей=${stats.relabeled}`,
            );
          } else {
            log(
              `[sub] ${_formatDdMmYyyy(sub.endDay)}/${sub.daysSpan}д готово: ` +
                `TotalCount=${stats.total}, ` +
                `страниц=${stats.pages_seen}, items=${stats.items}, ` +
                `новых pdf-ссылок=${stats.links_added}, ` +
                `пропуск по категории kad=${stats.links_skipped_category}, ` +
                `всего ссылок=${decisionLinks.size}`,
            );
          }
        }
      }
    }

    if (mode === MODE_TYPES) {
      log(
        `=== готово. DocumentType собрано: ${Object.keys(documentTypes).length} -> ${OUT_PATH} ===`,
      );
    } else {
      await _saveDecisionLinks();
      log(
        `=== готово. PDF-ссылки собраны (в Postgres, таблица acts): ` +
          `${decisionLinks.size} в Map за прогон ===`,
      );
    }
  } catch (e) {
    if (e instanceof EscalationExhausted) {
      // В штатном флоу эскалатор больше это не кидает; ловим как страховку
      // на случай ручного `throw EscalationExhausted` где-то в коде или
      // несовместимого старого кода в catch-цепочке.
      log(`[escalator] неожиданный EscalationExhausted: ${e.message}`);
      log(`[escalator] summary=${JSON.stringify(e.summary)}`);
    } else if (e instanceof RecycleWindowError) {
      log(`[main] RecycleWindowError вне цикла окон: ${e.message}`);
    } else {
      log(`Error: ${e}`);
      if (e && e.stack) process.stderr.write(`${e.stack}\n`);
    }
    // Любая необработанная ошибка (lease conflict, сеть, бан и т.п.) — не штатный
    // выход. Выставляем ненулевой код, чтобы supervisor (npm start) перезапустил
    // процесс. Раньше catch просто проглатывал ошибку, parser выходил с exit=0,
    // и supervisor не рестартил → парсер навсегда падал. lease conflict особенно
    // болезнен: после kill старого процесса нужен авто-retry через ~5с.
    process.exitCode = 1;
  } finally {
    _browserRecycleForDuplicateIp = null;
    _inWindowLoop = false;
    log("[shutdown] закрываю браузер");
    if (context !== null) {
      try {
        await context.close();
      } catch (e) {
        log(`[shutdown] context.close() упал: ${e}`);
      }
    }
    if (userDataDir) {
      try {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      } catch {}
    }
    if (_xvfbProcess !== null) {
      try {
        process.kill(_xvfbProcess.pid, "SIGTERM");
        log(`[shutdown] Xvfb остановлен (pid=${_xvfbProcess.pid})`);
      } catch {}
      _xvfbProcess = null;
    }
    if (leaseStopHeartbeat) {
      try {
        leaseStopHeartbeat();
      } catch {}
      leaseStopHeartbeat = null;
    }
    if (leaseHolderId) {
      try {
        const n = await _leaseReleaseAll(leaseHolderId);
        log(`[shutdown] proxy_leases освобождены: ${n}`);
      } catch (e) {
        log(`[shutdown] _leaseReleaseAll упал: ${e && e.message}`);
      }
    }
    try {
      await _pgClosePool();
    } catch (e) {
      log(`[shutdown] pg pool.end() упал: ${e}`);
    }
    _stopStuckWatchdog();
    log("[shutdown] всё, выход");
  }
}

main();
