#!/usr/bin/env node
/**
 * backend/proxy-tools/preflight-proxy-health.js — диагностический CLI поверх
 * `pdf/proxyHealth.js`. Тот же probe, что встроен в pipeline (download:acts),
 * только запускается отдельно: печатает таблицу + CSV в stdout.
 *
 * Когда нужно отдельно:
 *   - Хочешь увидеть полную картину «какие страны живые сейчас» перед запуском
 *     download:acts (например, после смены провайдера / закупки прокси).
 *   - Хочешь подставить CSV в скрипты CI / shell-pipe:
 *       export CSV=$(npm run --silent preflight:proxy-health | tail -1)
 *
 * При обычном запуске download:acts отдельная команда НЕ нужна — pipeline сам
 * вызовет тот же probe (gated by RAS_PDF_PREFLIGHT_GEO=1 + RAS_PDF_PREFLIGHT_PROBE=1).
 *
 * Конфиг — те же env, что у pipeline (см. .env.example «Preflight pre-download»).
 * Exit codes: 0 = есть recommended, 2 = ни одной, 1 = фатальная ошибка.
 */

import "../network/loadEnv.js";

import { MP_API_TOKEN } from "../network/config.js";
import {
  probeRecommendedCountries,
  readProbeOptsFromEnv,
} from "../pdf/proxyHealth.js";

const COUNTRY_NAMES = {
  1: "Россия",
  2: "Украина",
  15: "Грузия",
  22: "Беларусь",
  61: "Молдова",
  72: "Армения",
  82: "Казахстан",
  100: "Таджикистан",
  122: "Узбекистан",
  145: "Кыргызстан",
  147: "Туркменистан",
  148: "Азербайджан",
  152: "Турция",
  180: "Таиланд",
};

function log(m) {
  process.stdout.write(`${m}\n`);
}
function err(m) {
  process.stderr.write(`${m}\n`);
}

function renderTable(perCountry) {
  log("\n========== РЕЗУЛЬТАТЫ ==========");
  log(
    "cid | страна        | recommended | body  | http | latency | good-markers | bad-markers",
  );
  log("----+---------------+-------------+-------+------+---------+--------------+------------");
  const rows = Object.entries(perCountry).sort(
    ([, a], [, b]) =>
      (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0) ||
      b.bodyBytes - a.bodyBytes,
  );
  for (const [cid, v] of rows) {
    const name = (COUNTRY_NAMES[cid] ?? `id=${cid}`).padEnd(13);
    const rec = v.recommended ? "OK   " : "BAD  ";
    log(
      `${String(cid).padStart(3)} | ${name} | ${rec}       ` +
        `| ${String(v.bodyBytes).padStart(5)}b | ${(v.httpStatus ?? "?").toString().padStart(4)} ` +
        `| ${(v.latencyMs ?? "?").toString().padStart(7)} ` +
        `| ${(v.goodMarkers ?? []).slice(0, 3).join(",").padEnd(12)} ` +
        `| ${v.markers.slice(0, 4).join(",")}`,
    );
  }
}

async function main() {
  if (!MP_API_TOKEN) {
    err("[preflight] MP_API_TOKEN не задан в .env — без него нет доступа к MobileProxy API");
    process.exit(1);
  }
  const opts = readProbeOptsFromEnv();
  log(
    `[preflight] url=${opts.url} exclude={${opts.excludeCountryIds.join(",")}} ` +
      `target={${opts.targetCountryIds.join(",") || "—"}}`,
  );
  let result;
  try {
    result = await probeRecommendedCountries({
      apiToken: MP_API_TOKEN,
      ...opts,
      logger: log,
    });
  } catch (e) {
    err(`[preflight] probe упал: ${e && (e.stack ?? e.message ?? e)}`);
    process.exit(1);
  }
  renderTable(result.perCountry);
  log("\n========== РЕКОМЕНДАЦИЯ ==========");
  if (!result.recommended.length) {
    log("Ни одна страна не прошла probe — RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE оставить пустым.");
    log("Что делать:");
    log("  1) RAS_AUTO_BUY_PROXIES=1 + RAS_AUTO_BUY_COUNTRY_ID=<id> — докупить в стране-кандидате.");
    log("  2) Поменять proxy_key — текущая линия может быть полностью сожжённой.");
    log("  3) Поменять RAS_PROBE_URL если тестируем не ту страницу.");
    log("");
    process.exit(2);
  }
  const csv = result.recommended.join(",");
  log(`Recommended: [${csv}]`);
  log("Подставь в download:acts:");
  log(`  RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE=${csv} npm run download:acts`);
  log("");
  log(csv); // последняя строка stdout = CSV для shell-pipe
  process.exit(0);
}

main().catch((e) => {
  err(`[preflight] fatal: ${e && (e.stack ?? e.message ?? e)}`);
  process.exit(1);
});
