#!/usr/bin/env node
/**
 * Diagnostic: правда ли что page.goto(pdfUrl) проходит pravocaptcha challenge,
 * который через fetch() не пройти (wasm fingerprint requires real navigation).
 *
 * Стратегия:
 *   1) Поднять Chromium через MP_PROXY_*
 *   2) Warm-up: goto ras→kad→/Card/<caseId>, дать pravocaptcha JS отработать
 *   3) Подписаться на page.on('response') и поймать PDF body
 *   4) page.goto(pdfUrl) — Chromium загрузит HTML с pravocaptcha.execute,
 *      execute спросит токен, форма автосабмит на тот же URL POST, ответ — PDF
 *   5) Захватить PDF body из перехватчика и сохранить
 */
import "../network/loadEnv.js";
import fs from "node:fs";
import { chromium } from "playwright";
import { buildRasBrowserFingerprint, attachRasAntiDetectToContext, getRasChromiumLaunchAntiDetect } from "../network/rasBrowserProfile.js";

const PROXY_SERVER = process.env.MP_PROXY_SERVER;
const PROXY_USER = process.env.MP_PROXY_USER;
const PROXY_PASS = process.env.MP_PROXY_PASS;

// Тестовый акт из БД — pending PDF
const TEST_CASE_ID = "1b4181a5-6fe7-4910-af47-b7b1bf117a59";
const TEST_PDF_URL =
  "https://kad.arbitr.ru/Document/Pdf/1b4181a5-6fe7-4910-af47-b7b1bf117a59/5fde018b-2866-473e-9521-62aefac0a0ea/А04-9414-2025__20251208.pdf";

function log(...args) {
  process.stdout.write(`[test] ${args.join(" ")}\n`);
}

async function main() {
  if (!PROXY_SERVER) throw new Error("MP_PROXY_SERVER не задан");

  const rasFp = buildRasBrowserFingerprint();
  const anti = getRasChromiumLaunchAntiDetect();
  const userDataDir = fs.mkdtempSync("/tmp/ras_pdf_test_");
  const exe = process.env.RAS_CHROME || "/usr/bin/google-chrome-stable";

  log(`launching chromium proxy=${PROXY_SERVER} exe=${exe} userDataDir=${userDataDir}`);
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    locale: "ru-RU",
    timezoneId: "Europe/Moscow",
    userAgent: rasFp.userAgent,
    viewport: { width: 1366, height: 900 },
    extraHTTPHeaders: rasFp.extraHTTPHeaders,
    proxy: { server: PROXY_SERVER, username: PROXY_USER, password: PROXY_PASS },
    ignoreDefaultArgs: anti.ignoreDefaultArgs,
    args: [
      ...anti.args,
      // Отключаем встроенный PDF viewer — Chromium должен будет скачать файл
      // вместо рендеринга. Это даёт нам шанс получить bytes через CDP/response.
      "--disable-features=PdfViewer,PDFViewer",
    ],
    executablePath: exe,
    acceptDownloads: true,
  });

  await attachRasAntiDetectToContext(context);
  const page = context.pages()[0] || (await context.newPage());

  page.on("console", (msg) => log(`browser console [${msg.type()}]:`, msg.text().slice(0, 200)));

  log("=== Step 1: warmup ras → kad → Card ===");
  try {
    await page.goto("https://ras.arbitr.ru/", { waitUntil: "domcontentloaded", timeout: 60000 });
    log("ras OK");
  } catch (e) {
    log(`ras FAILED: ${e.message}`);
  }

  try {
    await page.goto("https://kad.arbitr.ru/", { waitUntil: "domcontentloaded", timeout: 60000 });
    log("kad OK");
  } catch (e) {
    log(`kad FAILED: ${e.message}`);
  }

  try {
    await page.goto(`https://kad.arbitr.ru/Card/${TEST_CASE_ID}`, { waitUntil: "domcontentloaded", timeout: 60000 });
    log("Card OK");
  } catch (e) {
    log(`Card FAILED: ${e.message}`);
  }

  log("=== Step 2: ждём pravocaptcha cookies (5s) ===");
  await page.waitForTimeout(5000);

  log("=== Step 3: проверка cookies + pravocaptcha namespace ===");
  const cookies = await context.cookies(["https://kad.arbitr.ru"]);
  log(`cookies on kad: ${cookies.length}`);
  for (const c of cookies) log(`  ${c.name}=${String(c.value).slice(0, 40)}...`);

  try {
    const pravocapInfo = await page.evaluate(() => ({
      hasPravocaptcha: typeof window.pravocaptcha,
      hasExecute: typeof window.pravocaptcha?.execute,
      jQuery: typeof window.$,
    }));
    log(`pravocaptcha state: ${JSON.stringify(pravocapInfo)}`);
  } catch (e) {
    log(`eval failed: ${e.message}`);
  }

  log("=== Step 4: download attempt #1 — fetch in evaluate (текущий способ) ===");
  try {
    const r = await page.evaluate(async (url) => {
      const resp = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept: "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8",
        },
      });
      const ct = resp.headers.get("content-type") || "";
      const txt = ct.includes("html") ? (await resp.text()).slice(0, 500) : null;
      return {
        status: resp.status,
        contentType: ct,
        size: resp.headers.get("content-length"),
        htmlPreview: txt,
      };
    }, TEST_PDF_URL);
    log(`fetch result: ${JSON.stringify(r).slice(0, 800)}`);
  } catch (e) {
    log(`fetch FAILED: ${e.message}`);
  }

  log("=== Step 5: download attempt #2 — page.goto + response capture ===");
  const responsePromise = page.waitForResponse(
    (resp) =>
      resp.url() === TEST_PDF_URL &&
      (resp.request().method() === "POST" ||
        (resp.request().method() === "GET" && (resp.headers()["content-type"] || "").includes("pdf"))),
    { timeout: 90000 },
  );

  // Параллельно слушаем все ответы на PDF URL чтобы видеть полный путь
  const allResponses = [];
  page.on("response", (resp) => {
    if (resp.url() === TEST_PDF_URL) {
      allResponses.push({
        method: resp.request().method(),
        status: resp.status(),
        ct: resp.headers()["content-type"],
      });
    }
  });

  let pdfBuffer = null;
  try {
    // ВАЖНО: page.goto на PDF может HANG если viewer открывается. Используем
    // 'commit' — возвращается сразу как только пришёл первый response header.
    const gotoPromise = page.goto(TEST_PDF_URL, { waitUntil: "commit", timeout: 90000 }).catch((e) => {
      log(`goto threw (ожидаемо для PDF): ${e.message.slice(0, 100)}`);
      return null;
    });
    const resp = await responsePromise;
    await gotoPromise;
    log(`captured response: method=${resp.request().method()} status=${resp.status()} ct=${resp.headers()["content-type"]}`);
    try {
      const body = await resp.body();
      log(`body bytes: ${body.length}, first4: ${body.slice(0, 4).toString("hex")}`);
      if (body.slice(0, 4).equals(Buffer.from("%PDF"))) {
        pdfBuffer = body;
      }
    } catch (e) {
      log(`body() failed: ${e.message}`);
    }
  } catch (e) {
    log(`waitForResponse failed: ${e.message}`);
  }

  log(`all responses on PDF URL: ${JSON.stringify(allResponses)}`);

  if (pdfBuffer) {
    const out = "/tmp/test_navigate.pdf";
    fs.writeFileSync(out, pdfBuffer);
    log(`SUCCESS: saved ${pdfBuffer.length} bytes to ${out}`);
    log(`pdftotext check:`);
    const { execSync } = await import("node:child_process");
    try {
      const txt = execSync(`pdftotext "${out}" - | head -c 500`, { timeout: 10000 }).toString();
      log(`text preview: ${txt.slice(0, 500)}`);
    } catch (e) {
      log(`pdftotext failed: ${e.message}`);
    }
  } else {
    log("FAILURE: no PDF body captured");
  }

  await context.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
}

main().catch((e) => {
  log(`fatal: ${e.message}`);
  log(e.stack);
  process.exit(1);
});
