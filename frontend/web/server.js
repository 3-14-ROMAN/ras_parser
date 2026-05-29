#!/usr/bin/env node
/**
 * frontend/web/server.js — тонкий веб-сервер для RAS Search — Supply.
 *
 * Делает ровно две вещи:
 *   1. Отдаёт статику из frontend/web/public (одностраничное приложение).
 *   2. Проксирует /api/* на локальные сервисы, чтобы фронт работал
 *      same-origin (без CORS-головной боли) и легко заворачивался в nginx
 *      под будущий домен.
 *
 *   /api/search          → POST  RAS_SEARCH_API_URL/search
 *   /api/search/stream   → POST  RAS_SEARCH_API_URL/search/stream   (SSE)
 *   /api/hyde            → POST  RAS_SEARCH_API_URL/hyde
 *   /api/stats           → GET   RAS_SEARCH_API_URL/stats
 *   /api/transcribe      → POST  RAS_WHISPER_API_URL/transcribe
 *
 * Никаких новых зависимостей: только встроенные node:http/node:fs. SSE
 * проксируется без буферизации (pipe response → client как есть).
 *
 * ENV:
 *   RAS_WEB_HOST          127.0.0.1   (для прод за nginx оставляем loopback)
 *   RAS_WEB_PORT          8080
 *   RAS_SEARCH_API_URL    http://127.0.0.1:8091
 *   RAS_WHISPER_API_URL   http://127.0.0.1:8001
 *
 * Запуск:
 *   node frontend/web/server.js
 *   # или npm run web
 */

import http from "node:http";
import https from "node:https";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

const HOST = process.env.RAS_WEB_HOST || "127.0.0.1";
const PORT = Number(process.env.RAS_WEB_PORT || 8080);
const SEARCH_API  = (process.env.RAS_SEARCH_API_URL  || "http://127.0.0.1:8091").replace(/\/+$/, "");
const WHISPER_API = (process.env.RAS_WHISPER_API_URL || "http://127.0.0.1:8001").replace(/\/+$/, "");

// /api/<local> → { base, path } апстрима. Порядок не важен — точное совпадение.
const API_ROUTES = {
  "/api/search":        { base: SEARCH_API,  path: "/search" },
  "/api/search/stream": { base: SEARCH_API,  path: "/search/stream" },
  "/api/hyde":          { base: SEARCH_API,  path: "/hyde" },
  "/api/stats":         { base: SEARCH_API,  path: "/stats" },
  "/api/transcribe":    { base: WHISPER_API, path: "/transcribe" },
};

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css":  "text/css; charset=utf-8",
  ".js":   "text/javascript; charset=utf-8",
  ".mjs":  "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg":  "image/svg+xml",
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".ico":  "image/x-icon",
  ".woff2": "font/woff2",
  ".webmanifest": "application/manifest+json",
};

function log(level, msg, extra) {
  const stamp = new Date().toISOString();
  const line = extra
    ? `[web] ${stamp} ${level} ${msg} ${JSON.stringify(extra)}`
    : `[web] ${stamp} ${level} ${msg}`;
  if (level === "ERROR" || level === "WARN") process.stderr.write(line + "\n");
  else process.stdout.write(line + "\n");
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}

// ─── reverse proxy ───────────────────────────────────────────────────────────
//
// Пробрасывает req → апстрим и апстрим-ответ → res через pipe. Для SSE это и
// нужно: ничего не буферизуем, события текут к браузеру по мере прихода.
function proxy(req, res, route, search) {
  const target = new URL(route.base + route.path + (search || ""));
  const lib = target.protocol === "https:" ? https : http;

  // Чистый набор заголовков: апстрим локальный, незачем тащить hop-by-hop.
  const headers = {
    host: target.host,
    "content-type": req.headers["content-type"] || "application/json",
    accept: req.headers["accept"] || "*/*",
  };
  if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];

  const opts = {
    method:   req.method,
    hostname: target.hostname,
    port:     target.port || (target.protocol === "https:" ? 443 : 80),
    path:     target.pathname + target.search,
    headers,
  };

  const preq = lib.request(opts, (pres) => {
    // Стримим заголовки апстрима как есть (включая text/event-stream и
    // x-accel-buffering: no для SSE).
    res.writeHead(pres.statusCode || 502, pres.headers);
    pres.pipe(res);
  });

  preq.on("error", (e) => {
    log("ERROR", "upstream error", { target: target.href, msg: e?.message ?? String(e) });
    if (!res.headersSent) {
      sendJson(res, 502, { ok: false, error: "upstream unavailable", detail: e?.message ?? String(e) });
    } else {
      try { res.end(); } catch {}
    }
  });

  // Если клиент отвалился ДО штатного завершения ответа (например, закрыл
  // вкладку во время долгого SSE/summary) — рвём апстрим. На обычном
  // завершённом запросе res 'close' приходит уже с writableEnded=true, апстрим
  // не трогаем. NB: req 'close' для GET прилетает сразу после отправки и для
  // этого не годится — оборвёт апстрим до ответа.
  res.on("close", () => {
    if (!res.writableEnded) { try { preq.destroy(); } catch {} }
  });

  req.pipe(preq);
}

// ─── static ──────────────────────────────────────────────────────────────────
async function serveStatic(req, res, pathname) {
  // index.html для корня и для любого «маршрута» без расширения (SPA-fallback).
  let rel = pathname === "/" ? "/index.html" : pathname;
  // Защита от path traversal: резолвим и проверяем, что внутри PUBLIC_DIR.
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel));
  if (!filePath.startsWith(PUBLIC_DIR)) {
    sendJson(res, 403, { ok: false, error: "forbidden" });
    return;
  }
  try {
    const st = await stat(filePath);
    if (!st.isFile()) throw new Error("not a file");
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "content-type": MIME[ext] || "application/octet-stream",
      "content-length": data.length,
      // HTML не кэшируем (правки сразу видны); ассеты — короткий кэш.
      "cache-control": ext === ".html" ? "no-store" : "public, max-age=300",
    });
    res.end(data);
  } catch {
    // Нет файла → отдаём index.html (single-page) для GET, иначе 404.
    if (req.method === "GET" && !path.extname(pathname)) {
      try {
        const html = await readFile(path.join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
        res.end(html);
        return;
      } catch {}
    }
    sendJson(res, 404, { ok: false, error: "not found" });
  }
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  } catch {
    sendJson(res, 400, { ok: false, error: "bad request" });
    return;
  }

  const route = API_ROUTES[url.pathname];
  if (route) {
    proxy(req, res, route, url.search);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    serveStatic(req, res, url.pathname).catch((e) => {
      log("ERROR", "static failed", { msg: e?.message ?? String(e) });
      if (!res.headersSent) sendJson(res, 500, { ok: false, error: "internal" });
    });
    return;
  }

  sendJson(res, 404, { ok: false, error: "not found" });
});

server.on("clientError", (err, socket) => {
  try { socket.destroy(); } catch {}
});

function shutdown(signal) {
  log("INFO", `shutdown signal=${signal}`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 800).unref();
}
process.on("SIGINT",  () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

server.listen(PORT, HOST, () => {
  log("INFO", `RAS Search — Supply web listening http://${HOST}:${PORT}  search=${SEARCH_API}  whisper=${WHISPER_API}`);
});
