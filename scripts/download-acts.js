#!/usr/bin/env node
/**
 * scripts/download-acts.js — entry-point для пайплайна download → extract.
 *
 * Берёт из таблицы `acts` строки с `verdict_keep=TRUE AND pdf_downloaded=FALSE`,
 * скачивает PDF с kad.arbitr.ru (прогрев Playwright → опционально HTTP GET через
 * RAS_PDF_HTTP_ENABLED=1 → salto в Chromium), сохраняет на диск,
 * параллельно экстрактит текст через pdftotext и пишет в `acts.act_text`.
 *
 * Запуск:
 *
 *   npm run download:acts
 *     # или напрямую (см. package.json для xvfb-обёртки):
 *   xvfb-run -a --server-args="-screen 0 1366x900x24" \
 *     node --env-file=.env scripts/download-acts.js
 *
 * Headful (RAS_PDF_HEADLESS=0, по умолчанию) — pravocaptcha проверяет
 * canvas-fingerprint, headless chromium иногда срывается на image-captcha
 * (см. pdf/downloader.js). На сервере без X — заворачивай в xvfb-run.
 * Если в твоей среде headless проходит — выстави RAS_PDF_HEADLESS=1.
 *
 * Резюмируемость:
 *
 *   - Скачанные PDF лежат в RAS_PDF_DIR (по умолчанию /data/ras_pdf).
 *     pdf_downloaded=TRUE ставится СРАЗУ после fs.writeFile, до extract'а.
 *   - На старте отрабатывает resume-стадия: добивает extract по тем актам,
 *     у которых PDF уже на диске, а текста ещё нет.
 *   - Прервался посередине? Запусти заново — продолжит с того же места.
 *
 * Диагностика скорости: RAS_PDF_TIMING=1 — в логе [pdf/timing] / [pipe/timing]
 * (HTTP GET / salto+fetch в Chromium vs диск vs Postgres vs очередь vs pdftotext).
 *
 * Конфиг через .env (полный список — .env.example, раздел RAS_PDF_*).
 */

import "../network/loadEnv.js";

import path from "node:path";

import { closePool, isPgConfigured } from "../db/pgClient.js";
import { runPipeline } from "../pdf/pipeline.js";
import {
  cleanupLeases,
  inspectKeysBusyness,
} from "../db/proxyLeases.js";

const DEFAULT_WORKDIR = "/data/ras_pdf";

/** [YYYY-MM-DD HH:MM:SS.mmm] timestamp (local time) для каждой строки лога. */
function _ts() {
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, "0");
  const p3 = (n) => String(n).padStart(3, "0");
  return (
    `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ` +
    `${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}.${p3(d.getMilliseconds())}`
  );
}

function log(msg) {
  process.stdout.write(`[${_ts()}] ${msg}\n`);
}

function usage() {
  process.stderr.write(
    `Использование:
  npm run download:acts
  xvfb-run -a node --env-file=.env scripts/download-acts.js [--workdir <path>] [--ids <uuid,...>]

Опции:
  --workdir <path>   куда складывать PDF (по умолчанию ${DEFAULT_WORKDIR})
  --ids <uuid,...>   качать ТОЛЬКО эти id (минует фильтр verdict_keep — для
                     точечного re-download, smoke-теста и backfill legacy-строк)
  -h, --help         показать эту справку

Конфиг через .env (см. .env.example раздел RAS_PDF_*):
  RAS_PDF_DIR                  путь для PDF (override --workdir и default)
  RAS_PDF_HEADLESS             1/0 запускать chromium headless (default 0, нужен xvfb)
  RAS_PDF_PARALLEL_DOWNLOADERS auto (= все прокси из getMyProxy) или число N
  RAS_PDF_POOL_COUNTRY_IDS      CSV id_country для discover пула; all|* = все купленные линии
  RAS_PDF_TARGET_COUNTRY_IDS   CSV для changeGeo (L3): только эти id_country (если не задано — как пул или 1,22,82,145 при pool=all)
  MP_PROXY_KEYS                CSV proxy_key'ев для whitelist; пусто = все прокси
  RAS_PDF_EXTRACT_WORKERS      параллельных pdftotext-воркеров (default 6)
  RAS_PDF_QUEUE_BUFFER         размер очереди download→extract (default 32)
  RAS_PDF_BATCH                сколько акт-строк брать из БД за раз (default 320)
  RAS_PDF_MAX_RUN              stop after N PDFs (0 = unlimited)
  RAS_PDF_MAX_ATTEMPTS         сколько раз пытаться скачать один акт (default 5)
  RAS_PDF_PAUSE_MIN_MS         пауза после успешного PDF, нижняя граница (default 220)
  RAS_PDF_PAUSE_MAX_MS         верхняя граница (default 520)
  RAS_PDF_PAUSE_FAIL_*         пауза после фейла на уровне pipeline (default 90–200)
  RAS_PDF_KEEP_FILE            1/0 хранить .pdf после extract (default 1)
  RAS_PDF_EXTRACT_TIMEOUT_MS   таймаут pdftotext на файл (default 45000)
  RAS_PDF_MIN_TEXT_BYTES       порог «PDF — скан без OCR» (default 200)
  RAS_PDF_WARMUP_TIMEOUT_MS    таймаут goto ras/kad (default 25000)
  RAS_PDF_FETCH_TIMEOUT_MS     таймаут page.evaluate salto-fetch (default 45000)
  RAS_PDF_HTTP_ENABLED         1 = сначала undici+куки после прогрева; по умолчанию 0 (только Chromium/salto)
  RAS_PDF_HTTP_CONCURRENCY     лимит параллельных Node HTTP GET на процесс (default 16)
  RAS_PDF_HTTP_MAX_ATTEMPTS    ретраи HTTP при сети/5xx (default 3); HTML-ответ не ретраится
  RAS_PDF_HTTP_TIMEOUT_MS      таймаут одного HTTP GET (default 7000, min 5000)
  RAS_PDF_RL_NO_PROXY_SLEEP_MS пауза при 429 без proxy API (default 25000)
  RAS_PDF_TIMING=1            разбивка времени в лог (см. [pdf/timing], [pipe/timing])
`,
  );
}

function parseArgs(argv) {
  const out = { workdir: null, ids: null };
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      usage();
      process.exit(0);
    }
    if (a === "--workdir") {
      out.workdir = argv[i + 1];
      i += 1;
      continue;
    }
    if (a === "--ids") {
      const raw = argv[i + 1] ?? "";
      out.ids = raw
        .split(/[,\s]+/)
        .map((s) => s.trim())
        .filter(Boolean);
      i += 1;
      continue;
    }
    process.stderr.write(`[${_ts()}] [args] неизвестный аргумент: ${a}\n`);
    usage();
    process.exit(1);
  }
  return out;
}

/**
 * Параметры supervisor'а: сколько раз перезапускать пайплайн при фатальной
 * ошибке (no-progress watchdog, краш всех воркеров, потеря PG надолго).
 * Дефолт 200 — на сутки запуска с 30-минутным backoff максимум ≈100 рестартов.
 * 0 = без supervisor'а (старое поведение: 1 прогон, при ошибке exit 1).
 */
const SUPERVISOR_MAX_RESTARTS = Math.max(
  0,
  Number(process.env.RAS_PDF_SUPERVISOR_MAX_RESTARTS ?? 200),
);
const SUPERVISOR_BACKOFF_MIN_MS = Math.max(
  1000,
  Number(process.env.RAS_PDF_SUPERVISOR_BACKOFF_MIN_MS ?? 10_000),
);
const SUPERVISOR_BACKOFF_MAX_MS = Math.max(
  SUPERVISOR_BACKOFF_MIN_MS,
  Number(process.env.RAS_PDF_SUPERVISOR_BACKOFF_MAX_MS ?? 600_000),
);

/**
 * SIGINT/SIGTERM, полученный во время backoff supervisor'а, должен прервать
 * sleep — иначе на Ctrl+C придётся ждать backoff. Флаг + один listener (выше
 * в pipeline.js свои есть; не мешают друг другу, оба once).
 */
let _supervisorStopRequested = false;
process.once("SIGINT", () => {
  _supervisorStopRequested = true;
});
process.once("SIGTERM", () => {
  _supervisorStopRequested = true;
});

/**
 * Глобальные хэндлеры — без них любой uncaught throw из глубины (например,
 * playwright internals, undici timeout-callback, рассинхрон Promise) убивает
 * процесс. На 24-часовом прогоне это критично — supervisor должен видеть
 * ошибку и принять решение, а не получить SIGABRT от node'ы.
 */
process.on("uncaughtException", (err) => {
  process.stderr.write(
    `[${_ts()}] [supervisor] uncaughtException (ловим, не выходим): ${err && (err.stack ?? err.message ?? err)}\n`,
  );
});
process.on("unhandledRejection", (reason) => {
  const msg = reason && (reason.stack ?? reason.message ?? reason);
  process.stderr.write(`[${_ts()}] [supervisor] unhandledRejection (ловим, не выходим): ${msg}\n`);
});

async function _interruptibleBackoff(totalMs) {
  const step = 500;
  let elapsed = 0;
  while (elapsed < totalMs && !_supervisorStopRequested) {
    const chunk = Math.min(step, totalMs - elapsed);
    await new Promise((r) => setTimeout(r, chunk));
    elapsed += chunk;
  }
}

/**
 * Верхний предел паузы при «все proxy_key заняты» — даже если TTL аренды
 * улетел далеко в будущее, не зависаем до самого конца, потом пере-проверяем.
 * 5 минут — компромисс: больше дефолтного TTL (5мин), но не часовое ожидание.
 */
const POOL_ALL_LEASED_MAX_WAIT_MS = Math.max(
  10_000,
  Number(process.env.RAS_PDF_POOL_ALL_LEASED_MAX_WAIT_MS ?? 300_000),
);
/**
 * Минимальная пауза после cleanup при POOL_ALL_LEASED, если PG говорит «уже
 * пусто, но лизинг всё равно не прошёл». Защита от tight loop, если кто-то
 * параллельно выгребает аренды быстрее, чем мы успеваем рестартануть.
 */
const POOL_ALL_LEASED_MIN_RECHECK_MS = Math.max(
  1_000,
  Number(process.env.RAS_PDF_POOL_ALL_LEASED_MIN_RECHECK_MS ?? 5_000),
);

/**
 * Обработать ошибку «все proxy_key заняты»:
 *   1. cleanup expired/dead-pid (если кто-то умер kill -9 — снимем зомби);
 *   2. посмотреть, у каких ключей лизинг ещё живой → подождать min(expires_at);
 *   3. если живых нет — короткая пауза и сразу retry.
 *
 * Возвращает количество ms, которое supervisor должен подождать перед
 * следующим runPipeline. `restartCount` НЕ инкрементируется (мы не «упали»,
 * мы координируемся с другим процессом) — это вне SUPERVISOR_MAX_RESTARTS.
 *
 * @param {Error & { details?: { busy?: Array<{ key: string, expiresAt: Date|null }> } }} err
 * @returns {Promise<number>} delayMs
 */
async function _handlePoolAllLeased(err) {
  const details = err.details ?? {};
  const busyKeys = Array.isArray(details.busy)
    ? details.busy.map((b) => b.key).filter(Boolean)
    : [];
  log(
    `[supervisor/lease] POOL_ALL_LEASED: ${busyKeys.length} ключ(ей) занято — ` +
      `делаю cleanup expired+dead-local`,
  );
  let cleaned = { expired: 0, dead: 0 };
  try {
    cleaned = await cleanupLeases({ role: "pdf", logger: log });
  } catch (e) {
    log(`[supervisor/lease] cleanup упал: ${e && e.message}`);
  }
  log(
    `[supervisor/lease] cleanup expired=${cleaned.expired} dead_local=${cleaned.dead}`,
  );
  if (cleaned.expired > 0 || cleaned.dead > 0) {
    // Что-то освободилось — пробуем сразу, не ждём.
    log(
      `[supervisor/lease] аренды освобождены — рестарт пайплайна без backoff`,
    );
    return POOL_ALL_LEASED_MIN_RECHECK_MS;
  }
  // cleanup ничего не нашёл — значит все аренды действительно живые.
  // Спим до самого позднего expires_at (но не дольше потолка).
  let waitMs = POOL_ALL_LEASED_MIN_RECHECK_MS;
  try {
    const status = await inspectKeysBusyness(busyKeys);
    if (status.busy.length) {
      // max_wait_sec — до самого позднего expires_at; +5с jitter, иначе
      // попадаем в гонку с heartbeat-renew другого процесса.
      const ms = (status.max_wait_sec + 5) * 1000;
      waitMs = Math.min(POOL_ALL_LEASED_MAX_WAIT_MS, Math.max(POOL_ALL_LEASED_MIN_RECHECK_MS, ms));
      log(
        `[supervisor/lease] все ${status.busy.length} аренд(ы) живые, ` +
          `жду до самого позднего expires_at (${status.max_wait_sec}с, ` +
          `cap=${Math.round(POOL_ALL_LEASED_MAX_WAIT_MS / 1000)}с)`,
      );
    } else {
      log(
        `[supervisor/lease] inspectKeysBusyness не нашёл живых аренд — ` +
          `пере-пробую через ${Math.round(waitMs / 1000)}с`,
      );
    }
  } catch (e) {
    log(`[supervisor/lease] inspectKeysBusyness упал: ${e && e.message} — короткая пауза`);
  }
  return waitMs;
}

function _isPoolAllLeasedErr(e) {
  if (!e) return false;
  if (e.code === "POOL_ALL_LEASED") return true;
  // Fallback на substring (если кто-то перехватит ошибку и потеряет code).
  const msg = String(e.message ?? "");
  return /все proxy_key заняты другими процессами/i.test(msg);
}

async function main() {
  const args = parseArgs(process.argv);

  if (!isPgConfigured()) {
    process.stderr.write(
      `[${_ts()}] [setup] DSN не задан. Поставь RAS_PG_DSN (или DATABASE_URL) в .env\n`,
    );
    process.exit(1);
  }

  const workDir = path.resolve(
    process.env.RAS_PDF_DIR ?? args.workdir ?? DEFAULT_WORKDIR,
  );
  log(`[setup] workDir=${workDir}`);
  log(
    `[supervisor] enabled max_restarts=${SUPERVISOR_MAX_RESTARTS} ` +
      `backoff=${SUPERVISOR_BACKOFF_MIN_MS}..${SUPERVISOR_BACKOFF_MAX_MS}ms`,
  );

  let exitCode = 0;
  let restartCount = 0;
  let backoffMs = SUPERVISOR_BACKOFF_MIN_MS;
  // Если задан --ids (точечный re-download), supervisor не имеет смысла —
  // это «один раз и выходим». Никакого 24h-loop'а тут не нужно.
  const supervised = !args.ids && SUPERVISOR_MAX_RESTARTS > 0;

  while (true) {
    try {
      const start = Date.now();
      await runPipeline({ workDir, logger: log, ids: args.ids });
      const durSec = Math.round((Date.now() - start) / 1000);
      log(`[supervisor] runPipeline вернулся штатно (длительность ${durSec}с)`);
      // Штатный return — либо очередь иссякла, либо stop-сигнал. Выходим без рестарта.
      break;
    } catch (e) {
      const msg = e && (e.stack ?? e.message ?? e);
      process.stderr.write(`[${_ts()}] [supervisor] runPipeline упал: ${msg}\n`);
      if (_supervisorStopRequested) {
        process.stderr.write(`[${_ts()}] [supervisor] получен stop-сигнал — выход без рестарта\n`);
        exitCode = 130;
        break;
      }
      // ── Особый случай: POOL_ALL_LEASED. Не считаем это «падением» — это
      // координация с другим процессом (parser.js / зомби). Делаем cleanup +
      // ждём до expires_at вместо crash-loop. Не инкрементируем restartCount,
      // не пересчитываем backoff, не теряем supervised-бюджет.
      if (_isPoolAllLeasedErr(e)) {
        const delayMs = await _handlePoolAllLeased(e);
        try {
          await closePool();
        } catch {}
        log(`[supervisor/lease] жду ${Math.round(delayMs / 1000)}с и пере-пробую`);
        await _interruptibleBackoff(delayMs);
        if (_supervisorStopRequested) {
          exitCode = 130;
          break;
        }
        // НЕ инкрементируем restartCount и НЕ умножаем backoff — это lease wait.
        continue;
      }
      if (!supervised) {
        process.stderr.write(
          `[${_ts()}] [supervisor] supervisor отключён (max_restarts=${SUPERVISOR_MAX_RESTARTS}, ids=${args.ids ? "yes" : "no"}) — выход\n`,
        );
        exitCode = 1;
        break;
      }
      restartCount += 1;
      if (restartCount > SUPERVISOR_MAX_RESTARTS) {
        process.stderr.write(
          `[${_ts()}] [supervisor] исчерпан лимит рестартов (${SUPERVISOR_MAX_RESTARTS}) — выход\n`,
        );
        exitCode = 1;
        break;
      }
      // Закрываем PG-pool между рестартами: возможно, проблема была в PG-сокете
      // и новый pool откроется чисто. На следующей итерации getPool() поднимет
      // его снова лениво.
      try {
        await closePool();
      } catch {}
      log(
        `[supervisor] рестарт #${restartCount}/${SUPERVISOR_MAX_RESTARTS} через ${Math.round(backoffMs / 1000)}с`,
      );
      await _interruptibleBackoff(backoffMs);
      if (_supervisorStopRequested) {
        exitCode = 130;
        break;
      }
      backoffMs = Math.min(SUPERVISOR_BACKOFF_MAX_MS, Math.round(backoffMs * 1.5));
    }
  }

  try {
    await closePool();
  } catch {}
  process.exit(exitCode);
}

await main();
