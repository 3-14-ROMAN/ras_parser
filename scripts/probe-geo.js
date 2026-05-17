#!/usr/bin/env node
/**
 * scripts/probe-geo.js — диагностический пробник «какие страны/гео реально
 * открывают kad.arbitr.ru без 451».
 *
 * Для каждой страны из PROBE_COUNTRIES (default: 1,22,82,145 — РФ/BY/KZ/KG):
 *   1) changeGeo с фильтром requireCountryIds=[country]
 *   2) логируем выбранное гео, IP, флаг abuse из ipguardian.net
 *   3) рестартим Chromium surface (новые куки/fingerprint)
 *   4) PROBE_ACTS попыток скачать реальный PDF из БД
 *   5) в конце — таблица: куда зайти можно, куда — нет.
 *
 * Один прокси из MP_PROXY_*. changeGeo cooldown 180с, так что 4 страны ≈ 13 минут.
 *
 * Запуск:
 *   npm run probe:geo
 *   # или:
 *   PROBE_COUNTRIES=82,145 PROBE_ACTS=3 npm run probe:geo
 */

import "../network/loadEnv.js";

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { MP_API_TOKEN } from "../network/config.js";
import { RasProxyClient } from "../network/proxyClient.js";
import { discoverProxies, singleProxyFromEnv } from "../network/proxyPool.js";
import { PdfDownloader } from "../pdf/downloader.js";
import { selectPendingPdf } from "../db/actsRepo.js";
import { closePool, isPgConfigured } from "../db/pgClient.js";

const COUNTRY_NAMES = {
  1: "Россия",
  2: "Украина",
  22: "Беларусь",
  82: "Казахстан",
  145: "Кыргызстан",
};

const COUNTRIES = String(process.env.PROBE_COUNTRIES ?? "1,22,82,145")
  .split(/[,\s]+/)
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);

const ACTS_PER_COUNTRY = Math.max(1, Number(process.env.PROBE_ACTS ?? 2));

const log = (m) => process.stdout.write(`${m}\n`);

function _abuseFromGeoResp(raw, proxyId) {
  if (!raw || typeof raw !== "object") return null;
  const ipg = raw["ipguardian.net"];
  if (!ipg || typeof ipg !== "object") return null;
  const entry = ipg[String(proxyId)] ?? ipg[Number(proxyId)];
  if (!entry || typeof entry !== "object") return null;
  const sources = Array.isArray(entry.sources)
    ? entry.sources
        .map((s) => s?.maintainer ?? s?.filename ?? s?.category ?? null)
        .filter(Boolean)
        .map(String)
    : [];
  return {
    ip: String(entry.ip ?? "").trim() || "?",
    found: entry.found === true,
    sources,
  };
}

async function main() {
  if (!isPgConfigured()) {
    process.stderr.write("[setup] DSN не задан в .env (RAS_PG_DSN/DATABASE_URL)\n");
    process.exit(1);
  }
  if (!MP_API_TOKEN) {
    process.stderr.write("[setup] MP_API_TOKEN не задан в .env\n");
    process.exit(1);
  }

  log(`[probe] countries=[${COUNTRIES.join(",")}] acts_per_country=${ACTS_PER_COUNTRY}`);

  const acts = await selectPendingPdf(ACTS_PER_COUNTRY * COUNTRIES.length);
  if (!acts.length) {
    process.stderr.write(
      "[probe] в БД нет актов pending_pdf — нечего пробовать качать. Сначала прогон парсера.\n",
    );
    process.exit(2);
  }
  log(`[probe] подтянул ${acts.length} актов из БД`);

  let proxies = [];
  try {
    proxies = await discoverProxies({
      apiToken: MP_API_TOKEN,
      allowedCountryIds: null,
      logger: log,
    });
  } catch (e) {
    log(`[probe] discoverProxies упал: ${e && e.message} — fallback на single MP_PROXY_*`);
  }
  const p = proxies[0] ?? singleProxyFromEnv();
  if (!p) {
    process.stderr.write("[probe] нет прокси (ни в MP API, ни в MP_PROXY_* env)\n");
    process.exit(1);
  }
  log(`[probe] выбран прокси: ${p.label} (key=${p.proxyKey.slice(0, 8)}…)`);

  const proxyClient = new RasProxyClient({
    apiToken: MP_API_TOKEN,
    proxyKey: p.proxyKey,
    proxyId: p.proxyId,
    logger: (m) => log(`[mp] ${m}`),
  });

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ras_probe_"));
  log(`[probe] tmp PDF dir: ${tmpDir}`);

  const downloader = new PdfDownloader({
    workDir: tmpDir,
    logger: log,
    proxyClient,
    proxyServer: p.server,
    proxyUser: p.username,
    proxyPass: p.password,
    label: "probe",
  });
  await downloader.init();

  /**
   * @type {Array<{
   *   cid: number,
   *   ok: boolean,
   *   error?: string,
   *   geo?: string,
   *   ip?: string,
   *   abuseFound?: boolean,
   *   abuseSources?: string[],
   *   tries?: Array<{ ok: boolean, status: any, reason: string, ms: number, bytes?: number }>,
   * }>}
   */
  const results = [];

  for (const cid of COUNTRIES) {
    const cName = COUNTRY_NAMES[cid] ?? `id_country=${cid}`;
    log(`\n========== probe country_id=${cid} (${cName}) ==========`);

    let geoR;
    try {
      geoR = await proxyClient.changeGeo(`probe-${cid}`, {
        filters: {
          requireCountryIds: [cid],
          excludeCountryIds: [],
          includeCaptionRegex: null,
          excludeCityIds: [],
          excludeCaptionRegex: null,
        },
        allowFallbackOperator: false,
      });
    } catch (e) {
      log(`  changeGeo threw: ${e && e.message}`);
      results.push({ cid, ok: false, error: `changeGeo threw: ${e && e.message}` });
      continue;
    }
    if (!geoR?.ok) {
      log(`  changeGeo не ok: reason=${geoR?.reason ?? "?"}`);
      results.push({ cid, ok: false, error: `changeGeo: ${geoR?.reason ?? "?"}` });
      continue;
    }

    const proxyId = await proxyClient.getResolvedProxyId();
    const abuse = _abuseFromGeoResp(geoR.raw, proxyId) ?? { ip: "?", found: false, sources: [] };
    log(
      `  geo='${geoR.caption ?? "?"}' geoid=${geoR.geoid ?? "?"} operator='${geoR.operator ?? "?"}' ` +
        `ip=${abuse.ip} abuse=${abuse.found}${abuse.found ? ` sources=[${abuse.sources.join("; ")}]` : ""}`,
    );

    try {
      await downloader._restartPdfSurface(`probe ${cid}`);
    } catch (e) {
      log(`  _restartPdfSurface failed: ${e && e.message} — пропускаю эту страну`);
      results.push({
        cid,
        ok: false,
        error: `surface restart: ${e && e.message}`,
        geo: geoR.caption,
        ip: abuse.ip,
        abuseFound: abuse.found,
        abuseSources: abuse.sources,
      });
      continue;
    }

    /** @type {Array<{ ok: boolean, status: any, reason: string, ms: number, bytes?: number }>} */
    const tries = [];
    for (let i = 0; i < ACTS_PER_COUNTRY; i += 1) {
      if (!acts.length) break;
      const a = acts.shift();
      log(`  попытка ${i + 1}/${ACTS_PER_COUNTRY} act=${a.id}`);
      const t0 = Date.now();
      let r;
      try {
        r = await downloader.downloadAndSave(a);
      } catch (e) {
        r = { ok: false, error: `downloadAndSave threw: ${e && e.message}`, status: null };
      }
      const ms = Date.now() - t0;
      const ok = r?.ok === true;
      const status = r?.status ?? null;
      const reason = ok ? "PDF saved" : String(r?.reason ?? r?.error ?? "?");
      const bytes = ok ? Number(r?.bytes ?? 0) : undefined;
      tries.push({ ok, status, reason, ms, bytes });
      log(
        `    -> ${ok ? "OK" : "FAIL"} status=${status ?? "?"} ms=${ms}` +
          (ok ? ` bytes=${bytes}` : ` reason="${reason.slice(0, 80)}"`),
      );
      if (ok && r?.pdfPath) {
        try {
          fs.unlinkSync(r.pdfPath);
        } catch {}
      }
    }

    results.push({
      cid,
      ok: true,
      geo: geoR.caption,
      ip: abuse.ip,
      abuseFound: abuse.found,
      abuseSources: abuse.sources,
      tries,
    });
  }

  log("\n\n========== SUMMARY ==========");
  for (const r of results) {
    const cName = COUNTRY_NAMES[r.cid] ?? `id_country=${r.cid}`;
    if (!r.ok || !r.tries) {
      log(`country=${r.cid} (${cName}): SKIPPED — ${r.error ?? "?"}`);
      continue;
    }
    const okN = r.tries.filter((t) => t.ok).length;
    const failN = r.tries.length - okN;
    const abuseTag = r.abuseFound ? ` abuse=YES[${(r.abuseSources ?? []).join("; ")}]` : " abuse=no";
    log(
      `country=${r.cid} (${cName}): geo='${r.geo}' ip=${r.ip}${abuseTag} -> ${okN} OK / ${failN} FAIL`,
    );
    for (const t of r.tries) {
      const tag = t.ok ? "OK" : "FAIL";
      const extra = t.ok
        ? `bytes=${t.bytes}`
        : `reason="${String(t.reason).slice(0, 60)}"`;
      log(`    ${tag} status=${t.status ?? "?"} ms=${t.ms} ${extra}`);
    }
  }

  log("\n========== РЕКОМЕНДАЦИЯ ==========");
  const winners = results.filter((r) => r.ok && r.tries.some((t) => t.ok));
  if (!winners.length) {
    log(
      "Ни одна страна не дала ни одного успешного PDF. Это значит, что pravocaptcha на " +
        "kad.arbitr.ru блокирует все IP, что выдаёт MobileProxy.Space на этом прокси-ключе. " +
        "Варианты: 1) попробовать с другим proxy_key (купи ещё линий с конкретной страной); " +
        "2) запустить probe-geo на нескольких прокси параллельно — может в другом сегменте чище; " +
        "3) сменить провайдера прокси.",
    );
  } else {
    const ids = winners.map((r) => r.cid).join(",");
    log(
      `Рабочие страны: [${ids}]. Поставь в команде download:acts ` +
        `RAS_PDF_TARGET_COUNTRY_IDS=${ids} — changeGeo при 451 будет ` +
        `выбирать только из них.`,
    );
  }

  try {
    await downloader.close();
  } catch {}
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {}
  try {
    await closePool();
  } catch {}
}

main().catch((e) => {
  process.stderr.write(`[fatal] ${e && (e.stack ?? e.message ?? e)}\n`);
  process.exit(1);
});
