#!/usr/bin/env node
/**
 * Diagnostic: попробовать СКАЧАТЬ PDF минуя warmup, через page.goto(pdfUrl) +
 * response capture. Гипотеза: текущий путь (Card warmup + fetch с cookies)
 * выдаёт server'у session-fingerprint, на котором pravocaptcha 451-ит.
 * Если page.goto без warmup → pravocaptcha сразу challenge'нет → JS выполнит
 * fingerprint, server отдаст PDF (или salto challenge).
 */
import "../network/loadEnv.js";
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRasBrowserFingerprint, attachRasAntiDetectToContext, getRasChromiumLaunchAntiDetect } from "../network/rasBrowserProfile.js";

const PROXY_SERVER = process.env.MP_PROXY_SERVER;
const PROXY_USER = process.env.MP_PROXY_USER;
const PROXY_PASS = process.env.MP_PROXY_PASS;

const PDF_URL = process.argv[2] ||
  "https://kad.arbitr.ru/Document/Pdf/69facd83-ba87-4336-b856-5a4c08a2ba67/a560e3f5-ee89-41f2-919d-7ace2fb6a776/А40-45761-2024__20251212.pdf";

function log(...args) {
  process.stdout.write(`[test] ${args.join(" ")}\n`);
}

async function main() {
  const rasFp = buildRasBrowserFingerprint();
  const anti = getRasChromiumLaunchAntiDetect();
  const userDataDir = fs.mkdtempSync("/tmp/ras_pdf_direct_");

  const args = [
    ...anti.args,
    // Принудительно скачивать вместо открытия в встроенном viewer'е
    "--disable-features=PdfPlugin,PDFPlugin,PdfViewer",
  ];
  log(`launching chromium proxy=${PROXY_SERVER}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    userAgent: rasFp.userAgent,
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: rasFp.extraHTTPHeaders,
    proxy: { server: PROXY_SERVER, username: PROXY_USER, password: PROXY_PASS },
    ignoreDefaultArgs: anti.ignoreDefaultArgs,
    args,
    executablePath: "/usr/bin/google-chrome-stable",
    acceptDownloads: true,
  });

  await attachRasAntiDetectToContext(context);
  const page = context.pages()[0] || (await context.newPage());

  /** @type {Array<{method:string,status:number,url:string,ct:string}>} */
  const responses = [];
  /** @type {Map<string, Buffer>} */
  const bodies = new Map();
  page.on("response", async (resp) => {
    const url = resp.url();
    if (url.includes("/Document/Pdf/")) {
      const ct = resp.headers()["content-type"] || "";
      responses.push({
        method: resp.request().method(),
        status: resp.status(),
        url: url.slice(0, 100),
        ct,
      });
      try {
        const body = await resp.body();
        if (body && body.length > 100) {
          bodies.set(`${resp.request().method()}@${responses.length}`, body);
          log(`response: ${resp.request().method()} ${resp.status()} ct=${ct.slice(0, 40)} body=${body.length}B firstHex=${body.slice(0, 4).toString("hex")}`);
        }
      } catch (e) {
        log(`body() failed: ${e.message}`);
      }
    }
  });

  page.on("download", async (download) => {
    log(`DOWNLOAD started: ${download.suggestedFilename()} url=${download.url().slice(0, 80)}`);
    try {
      const path = await download.path();
      log(`DOWNLOAD path: ${path}`);
      if (path) {
        const data = fs.readFileSync(path);
        bodies.set("download", data);
        log(`DOWNLOAD body: ${data.length}B firstHex=${data.slice(0, 4).toString("hex")}`);
      }
    } catch (e) {
      log(`download failed: ${e.message}`);
    }
  });

  log(`=== TEST 1: direct page.goto(pdfUrl) WITHOUT warmup ===`);
  log(`URL: ${PDF_URL}`);
  try {
    await page.goto(PDF_URL, { waitUntil: "load", timeout: 60000 }).catch((e) => {
      log(`goto returned: ${e.message.slice(0, 100)}`);
    });
  } catch (e) {
    log(`goto threw: ${e.message}`);
  }

  // Дать pravocaptcha JS отработать (WASM fingerprint + POST auto-submit)
  log(`waiting 10s for pravocaptcha JS to run + auto-submit...`);
  await page.waitForTimeout(10000);

  log(`=== responses captured: ===`);
  for (const r of responses) {
    log(`  ${r.method} ${r.status} ct=${r.ct.slice(0, 50)} url=${r.url.slice(-80)}`);
  }
  log(`=== bodies captured: ${bodies.size} ===`);

  let pdfBuffer = null;
  for (const [key, body] of bodies.entries()) {
    if (body.slice(0, 4).equals(Buffer.from("%PDF"))) {
      log(`PDF found in: ${key}, bytes=${body.length}`);
      pdfBuffer = body;
      break;
    }
  }

  if (pdfBuffer) {
    fs.writeFileSync("/tmp/test_direct.pdf", pdfBuffer);
    log(`SUCCESS! saved ${pdfBuffer.length} bytes to /tmp/test_direct.pdf`);
  } else {
    log(`NO PDF captured. Bodies preview:`);
    for (const [key, body] of bodies.entries()) {
      const preview = body.slice(0, 200).toString("utf8", 0, Math.min(200, body.length)).replace(/[\r\n]/g, "·");
      log(`  ${key} (${body.length}B): ${preview.slice(0, 150)}`);
    }
  }

  // Дополнительный тест: вынести cookies на следующем шаге
  const cookies = await context.cookies(["https://kad.arbitr.ru"]);
  log(`cookies on kad after attempt: ${cookies.length}`);
  for (const c of cookies) log(`  ${c.name}=${String(c.value).slice(0, 40)}`);

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  log(e.stack);
  process.exit(1);
});
