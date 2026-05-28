#!/usr/bin/env node
/**
 * scripts/probe-ras-countries.js — country-level разведка через MobileProxy
 * Anti-cloaking API (`see_the_url_from_different_IPs`).
 *
 * Цель: до запуска тяжёлого download:acts найти страны, у которых пул IP
 * провайдера отдаёт нормальный ras.arbitr.ru / kad.arbitr.ru, а не 451.
 *
 * Endpoint работает на уровне страны (id_country, CSV), а не конкретного
 * оборудования (proxy_id/eid). Поэтому это PREFILTER: после получения списка
 * recommended стран всё равно нужен `changeGeo` через RasProxyClient — только
 * он проверяет, что конкретный proxy_id под рукой попал в живой geo/operator.
 *
 * Запуск:
 *   npm run probe:ras-countries
 *   # вручную, со своим списком стран:
 *   RAS_MP_ANTICLOAK_COUNTRIES=82,145,22,2,180 npm run probe:ras-countries
 *   # с несколькими URL (ras + kad):
 *   RAS_MP_ANTICLOAK_URLS=https://ras.arbitr.ru/,https://kad.arbitr.ru/ \
 *     npm run probe:ras-countries
 *
 * Env:
 *   RAS_MP_ANTICLOAK_URL=https://ras.arbitr.ru/   (один URL; перебивается URLS)
 *   RAS_MP_ANTICLOAK_URLS=...                      (CSV; если задан — основной)
 *   RAS_MP_ANTICLOAK_PDF_URL=...                   (advisory probe; не влияет на recommended)
 *   RAS_MP_ANTICLOAK_COUNTRIES=82,145,22,2,180     (CSV; пусто = взять из get_geo_operator_list)
 *   RAS_MP_ANTICLOAK_TIMEOUT_MS=120000             (общий таймаут на задачу)
 *   RAS_MP_ANTICLOAK_POLL_MS=5000                  (период polling tasks; min 5000)
 *   RAS_MP_ANTICLOAK_BODY_MIN_BYTES=5000           (порог "достаточный body" для recommended)
 */

import "../network/loadEnv.js";

import { MP_API_TOKEN, MP_PROXY_KEY, MP_PROXY_ID } from "../network/config.js";
import { RasProxyClient } from "../network/proxyClient.js";
import {
  classifyAntiCloakResult,
  combineUrlVerdicts,
  flattenCandidateCountriesFromGeoList,
  parseAntiCloakTaskResult,
} from "./antiCloakClassifier.js";

const COUNTRY_NAMES = {
  1: "Россия",
  2: "Украина",
  22: "Беларусь",
  82: "Казахстан",
  145: "Кыргызстан",
  180: "Таиланд",
  100: "Кыргызстан (alt)",
};

const log = (m) => process.stdout.write(`${m}\n`);
const err = (m) => process.stderr.write(`${m}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readUrls() {
  const csv = String(process.env.RAS_MP_ANTICLOAK_URLS ?? "").trim();
  if (csv) {
    const arr = csv
      .split(/[,\s]+/)
      .map((s) => s.trim())
      .filter(Boolean);
    if (arr.length) return arr;
  }
  const single = String(process.env.RAS_MP_ANTICLOAK_URL ?? "").trim();
  return [single || "https://ras.arbitr.ru/"];
}

function readCountries() {
  const csv = String(process.env.RAS_MP_ANTICLOAK_COUNTRIES ?? "").trim();
  if (!csv) return null;
  const arr = csv
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return arr.length ? arr : null;
}

function readPdfAdvisoryUrl() {
  const u = String(process.env.RAS_MP_ANTICLOAK_PDF_URL ?? "").trim();
  return u || null;
}

function readNumber(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === null || raw === "") return def;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : def;
}

const TIMEOUT_MS = readNumber("RAS_MP_ANTICLOAK_TIMEOUT_MS", 120_000);
const POLL_MS = Math.max(5000, readNumber("RAS_MP_ANTICLOAK_POLL_MS", 5000));
const BODY_MIN_BYTES = readNumber("RAS_MP_ANTICLOAK_BODY_MIN_BYTES", 5000);

/**
 * Прямой POST `see_the_url_from_different_IPs` — SDK берёт по одной стране,
 * а нам нужно сразу батч через `id_country=<csv>`.
 */
async function postAntiCloak(apiToken, url, countriesCsv) {
  const params = new URLSearchParams();
  params.set("command", "see_the_url_from_different_IPs");
  params.set("url", url);
  params.set("id_country", countriesCsv);
  const endpoint = `https://mobileproxy.space/api.html?command=${encodeURIComponent("see_the_url_from_different_IPs")}`;
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": "ras-parser/probe-ras-countries",
    },
    body: params.toString(),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`anti-cloak: невалидный JSON (http=${resp.status}): ${text.slice(0, 200)}`);
  }
  if (json && json.error) {
    throw new Error(`anti-cloak: API error: ${json.error}`);
  }
  return json;
}

async function getTaskResult(apiToken, tasksId) {
  const url = `https://mobileproxy.space/api.html?command=tasks&tasks_id=${encodeURIComponent(tasksId)}`;
  const resp = await fetch(url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiToken}`,
      Accept: "application/json",
      "User-Agent": "ras-parser/probe-ras-countries",
    },
    signal: AbortSignal.timeout(60_000),
  });
  const text = await resp.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`tasks: невалидный JSON (http=${resp.status}): ${text.slice(0, 200)}`);
  }
  if (json && json.error) {
    const msg = String(json.error);
    if (/in progress|in_progress|pending|wait/i.test(msg)) return { pending: true, raw: json };
    throw new Error(`tasks: API error: ${msg}`);
  }
  return { pending: false, raw: json };
}

/**
 * Polling tasks API. Возвращает финальный JSON ответа или кидает на таймаут.
 */
async function waitForTask(apiToken, tasksId, { timeoutMs, pollMs }) {
  const deadline = Date.now() + timeoutMs;
  let lastRaw = null;
  while (Date.now() < deadline) {
    let resp;
    try {
      resp = await getTaskResult(apiToken, tasksId);
    } catch (e) {
      log(`  [tasks] ошибка polling: ${e && e.message}; sleep ${pollMs}ms`);
      await sleep(pollMs);
      continue;
    }
    lastRaw = resp.raw;
    if (!resp.pending) {
      const parsed = parseAntiCloakTaskResult(resp.raw);
      if (parsed.status === "pending") {
        await sleep(pollMs);
        continue;
      }
      return resp.raw;
    }
    await sleep(pollMs);
  }
  throw new Error(
    `anti-cloak: task timeout ${timeoutMs}ms (last raw keys: ${
      lastRaw ? Object.keys(lastRaw).slice(0, 6).join(",") : "?"
    })`,
  );
}

async function probeOneUrl({ apiToken, url, countries, label }) {
  log(`\n========== probe URL=${url} countries=[${countries.join(",")}] ==========`);
  const t0 = Date.now();
  const startResp = await postAntiCloak(apiToken, url, countries.join(","));
  const tasksId =
    startResp?.tasks_id ?? startResp?.task_id ?? startResp?.id ?? null;
  if (!tasksId) {
    throw new Error(
      `anti-cloak: API не вернул tasks_id (keys=${Object.keys(startResp ?? {}).join(",")})`,
    );
  }
  const approxEnd = startResp?.approximate_end_time ?? null;
  log(
    `  tasks_id=${tasksId}` +
      (approxEnd ? ` approximate_end_time=${approxEnd}` : "") +
      ` (poll каждые ${POLL_MS}ms, таймаут ${TIMEOUT_MS}ms)`,
  );
  const final = await waitForTask(apiToken, tasksId, {
    timeoutMs: TIMEOUT_MS,
    pollMs: POLL_MS,
  });
  log(`  task complete за ${Math.round((Date.now() - t0) / 1000)}s`);
  const parsed = parseAntiCloakTaskResult(final);
  if (parsed.status !== "ready") {
    log(
      `  [warn] task в статусе '${parsed.status}' — пытаемся вытащить items как есть`,
    );
  }
  /** @type {Record<number, ReturnType<typeof classifyAntiCloakResult>>} */
  const perCountry = {};
  for (const cid of countries) {
    const item = parsed.byCountry[cid] ?? null;
    const cls = classifyAntiCloakResult(item, { bodyMinBytes: BODY_MIN_BYTES });
    perCountry[cid] = cls;
    const cName = COUNTRY_NAMES[cid] ?? `id=${cid}`;
    log(
      `  ${label}: cid=${cid} ${cName.padEnd(15)} status=${
        cls.recommended ? "OK  " : "BAD "
      } body=${String(cls.bodyBytes).padStart(7)}b http=${
        cls.httpStatus ?? "?"
      } lat=${cls.latencyMs ?? "-"}ms markers=[${cls.markers.join(",") || "-"}]`,
    );
  }
  return perCountry;
}

async function pickCountriesFromGeoList() {
  log("[probe] RAS_MP_ANTICLOAK_COUNTRIES пуст — тяну страны из get_geo_operator_list");
  const proxyClient = new RasProxyClient({
    apiToken: MP_API_TOKEN,
    proxyKey: MP_PROXY_KEY,
    proxyId: MP_PROXY_ID,
    logger: (m) => log(`[mp] ${m}`),
  });
  const avail = await proxyClient.getAvailableEquipment();
  const candidates = flattenCandidateCountriesFromGeoList(avail);
  if (!candidates.length) {
    throw new Error(
      "get_geo_operator_list не дал ни одной страны с count_free>0 — пул пустой?",
    );
  }
  // Уникальные id_country с count_free>0.
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (c.countryId === null) continue;
    if (seen.has(c.countryId)) continue;
    seen.add(c.countryId);
    out.push(c.countryId);
  }
  log(`[probe] взял ${out.length} стран из get_geo_operator_list: [${out.join(",")}]`);
  return out;
}

function fmtMarkers(m) {
  if (!m || !m.length) return "-";
  return m.slice(0, 4).join(",") + (m.length > 4 ? `+${m.length - 4}` : "");
}

function renderSummary(urls, perUrlPerCountry, combined, advisory) {
  log("\n\n========== SUMMARY (per-URL × per-country) ==========");
  const allCountries = Array.from(
    new Set(urls.flatMap((u) => Object.keys(perUrlPerCountry[u] ?? {}).map(Number))),
  ).sort((a, b) => a - b);
  for (const cid of allCountries) {
    const cName = COUNTRY_NAMES[cid] ?? `id=${cid}`;
    const parts = [`cid=${String(cid).padStart(3)} ${cName.padEnd(15)}`];
    for (const u of urls) {
      const cls = perUrlPerCountry[u]?.[cid];
      if (!cls) {
        parts.push(`[${u}] —`);
        continue;
      }
      parts.push(
        `[${u}] ${cls.recommended ? "OK " : "BAD"} body=${cls.bodyBytes}b http=${
          cls.httpStatus ?? "?"
        } markers=${fmtMarkers(cls.markers)}`,
      );
    }
    parts.push(combined[cid]?.recommended ? "→ RECOMMENDED" : "→ -");
    log(parts.join("  "));
  }

  if (advisory) {
    log("\n========== PDF advisory probe ==========");
    for (const cid of Object.keys(advisory)) {
      const cls = advisory[cid];
      const cName = COUNTRY_NAMES[cid] ?? `id=${cid}`;
      log(
        `  cid=${cid} ${cName.padEnd(15)} body=${cls.bodyBytes}b http=${
          cls.httpStatus ?? "?"
        } markers=[${cls.markers.join(",") || "-"}] (advisory only)`,
      );
    }
  }
}

function renderRecommendation(combined) {
  log("\n========== РЕКОМЕНДАЦИЯ ==========");
  const recommended = Object.entries(combined)
    .filter(([, v]) => v.recommended)
    .map(([cid]) => Number(cid));
  if (!recommended.length) {
    const sorted = Object.entries(combined)
      .map(([cid, v]) => ({ cid: Number(cid), bytes: v.bodyBytes, markers: v.markers }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 5);
    log("no recommended countries from anti-cloak probe");
    log("Top countries by body_bytes (recommended=false):");
    for (const s of sorted) {
      const cName = COUNTRY_NAMES[s.cid] ?? `id=${s.cid}`;
      log(`  cid=${s.cid} ${cName} body=${s.bytes}b markers=[${s.markers.join(",") || "-"}]`);
    }
    log("\nДальше делать download НЕ запускать (вернётся 451). Что попробовать:");
    log("  1) докупить прокси в новых странах (RAS_AUTO_BUY_PROXIES=1 + RAS_AUTO_BUY_COUNTRY_ID=<id>);");
    log("  2) сменить proxy_key целиком — текущая линия p* может быть сожжённой;");
    log("  3) проверить fingerprint/session — pravocaptcha видит наш Chromium, а не IP.");
    return null;
  }
  const ids = recommended.join(",");
  log(`Рекомендованные страны (по anti-cloak): [${ids}]`);
  log("");
  log("export RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE=" + ids);
  log("");
  log("Запуск download с этим override (без засорения provider-blacklist):");
  log("");
  log(
    `RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE=${ids} \\`,
  );
  log("  RAS_MP_ADD_TO_BLACKLIST_ON_CHANGE_GEO=0 \\");
  log("  RAS_MP_CLEAR_PROVIDER_BLACKLIST_ON_START=0 \\");
  log("  RAS_PDF_HEARTBEAT_MS=30000 \\");
  log("  npm run download:acts | tee /tmp/ras_pdf_live.log");
  return recommended;
}

async function main() {
  if (!MP_API_TOKEN) {
    err("[setup] MP_API_TOKEN не задан в .env");
    process.exit(1);
  }
  if (!MP_PROXY_KEY) {
    err("[setup] MP_PROXY_KEY не задан в .env (нужен для get_geo_operator_list)");
    process.exit(1);
  }

  const urls = readUrls();
  let countries = readCountries();
  if (!countries) {
    try {
      countries = await pickCountriesFromGeoList();
    } catch (e) {
      err(`[setup] не смог взять страны из get_geo_operator_list: ${e && e.message}`);
      process.exit(1);
    }
  } else {
    log(`[probe] countries из env: [${countries.join(",")}]`);
  }
  log(`[probe] urls=[${urls.join(", ")}]`);

  /** @type {Record<string, Record<number, ReturnType<typeof classifyAntiCloakResult>>>} */
  const perUrlPerCountry = {};
  for (const url of urls) {
    try {
      perUrlPerCountry[url] = await probeOneUrl({
        apiToken: MP_API_TOKEN,
        url,
        countries,
        label: url,
      });
    } catch (e) {
      err(`[probe] URL=${url} провалился: ${e && e.message}`);
      perUrlPerCountry[url] = {};
    }
  }

  const advisoryUrl = readPdfAdvisoryUrl();
  /** @type {Record<number, ReturnType<typeof classifyAntiCloakResult>>|null} */
  let advisory = null;
  if (advisoryUrl) {
    try {
      advisory = await probeOneUrl({
        apiToken: MP_API_TOKEN,
        url: advisoryUrl,
        countries,
        label: `[advisory] ${advisoryUrl}`,
      });
    } catch (e) {
      err(`[probe] advisory PDF URL=${advisoryUrl} провалился: ${e && e.message}`);
    }
  }

  const combined = combineUrlVerdicts(perUrlPerCountry, countries);
  renderSummary(urls, perUrlPerCountry, combined, advisory);
  renderRecommendation(combined);
}

main().catch((e) => {
  err(`[fatal] ${e && (e.stack ?? e.message ?? e)}`);
  process.exit(1);
});
