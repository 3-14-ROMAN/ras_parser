/**
 * pdf/extractor.js — `pdftotext` (poppler) + лёгкая нормализация.
 *
 * Используем `-layout` (сохраняет колонки и табличный лейаут — для решений
 * это часто важно, особенно для резолютивной части), `-enc UTF-8`,
 * `-nopgbrk` (убираем \f-разделители страниц — для эмбеддинговой модели это
 * шум). Запись через stdout, чтобы не плодить временный .txt на диске.
 *
 * Нормализация — намеренно консервативная, чтобы НЕ испортить юр.текст:
 *   - заменяем неразрывные пробелы (U+00A0, U+202F) на обычные;
 *   - схлопываем последовательности >2 пробелов в один (после `-layout`
 *     pdftotext часто оставляет 6-8 пробелов между «колонками»);
 *   - убираем «висячий» дефис-перенос внутри слова (`из-\nсудительный` →
 *     `изсудительный`? нет — это редко в юр.тексте, и часто это ЦЕЛЕВОЙ
 *     дефис, потому НЕ удаляем — оставляем как есть);
 *   - схлопываем >3 пустых строк в две;
 *   - trim каждой строки справа.
 *
 * Что НЕ трогаем:
 *   - регистр (важен для имён);
 *   - пунктуацию;
 *   - кавычки/тире (стилистически разные кавычки могут попасть в текст,
 *     но эмбеддингу всё равно).
 *
 * Если PDF — скан без OCR (текстового слоя нет), pdftotext вернёт пустую
 * строку. Это ловится по длине ниже `MIN_TEXT_BYTES` — наверх отдаём
 * {ok:false, code:"empty"} чтобы downstream-OCR-сервис мог взять файл.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";

const EXTRACT_TIMEOUT_MS = Number(process.env.RAS_PDF_EXTRACT_TIMEOUT_MS ?? 45_000);
const MIN_TEXT_BYTES = Number(process.env.RAS_PDF_MIN_TEXT_BYTES ?? 200);

/**
 * Извлечь текст из PDF на указанном пути.
 *
 * @param {string} pdfPath
 * @returns {Promise<{ ok: true, text: string, bytes: number }
 *                  | { ok: false, code: 'missing'|'empty'|'pdftotext_failed'|'timeout', error: string }>}
 */
export async function extractPdfText(pdfPath) {
  if (!pdfPath) return { ok: false, code: "missing", error: "no pdfPath" };
  try {
    const stat = await fs.promises.stat(pdfPath);
    if (!stat.isFile() || stat.size === 0) {
      return { ok: false, code: "missing", error: `not a file or empty: ${pdfPath}` };
    }
  } catch (e) {
    return { ok: false, code: "missing", error: `stat failed: ${e && e.message}` };
  }

  let rawText;
  try {
    rawText = await _runPdftotext(pdfPath);
  } catch (e) {
    if (e?.code === "TIMEOUT") {
      return { ok: false, code: "timeout", error: e.message };
    }
    return { ok: false, code: "pdftotext_failed", error: e?.message ?? String(e) };
  }

  const cleaned = _normalize(rawText);
  const bytes = Buffer.byteLength(cleaned, "utf-8");
  if (bytes < MIN_TEXT_BYTES) {
    return {
      ok: false,
      code: "empty",
      error: `extracted ${bytes} bytes — likely scanned PDF without OCR`,
    };
  }
  return { ok: true, text: cleaned, bytes };
}

/**
 * Запускает `pdftotext -layout -enc UTF-8 -nopgbrk <pdf> -`, читает stdout.
 * Возвращает сырой UTF-8 текст.
 */
function _runPdftotext(pdfPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      "pdftotext",
      ["-layout", "-enc", "UTF-8", "-nopgbrk", pdfPath, "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let stdoutChunks = [];
    let stderrChunks = [];
    let timedOut = false;

    const t = setTimeout(() => {
      timedOut = true;
      try {
        proc.kill("SIGKILL");
      } catch {}
    }, EXTRACT_TIMEOUT_MS);

    proc.stdout.on("data", (c) => stdoutChunks.push(c));
    proc.stderr.on("data", (c) => stderrChunks.push(c));

    proc.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });

    proc.on("close", (code) => {
      clearTimeout(t);
      if (timedOut) {
        const err = new Error(`pdftotext timeout after ${EXTRACT_TIMEOUT_MS}ms on ${pdfPath}`);
        // @ts-ignore
        err.code = "TIMEOUT";
        return reject(err);
      }
      if (code !== 0) {
        const stderr = Buffer.concat(stderrChunks).toString("utf-8").trim();
        return reject(
          new Error(`pdftotext exit=${code} stderr=${stderr.slice(0, 500)}`),
        );
      }
      resolve(Buffer.concat(stdoutChunks).toString("utf-8"));
    });
  });
}

function _normalize(s) {
  if (!s) return "";
  // 1) неразрывные пробелы → обычные (NBSP, NNBSP).
  let out = s.replace(/[  ]/g, " ");
  // 2) zero-width и BOM — выкинуть.
  out = out.replace(/[​-‍﻿]/g, "");
  // 3) trim right у каждой строки.
  out = out
    .split("\n")
    .map((line) => line.replace(/[\t ]+$/g, ""))
    .join("\n");
  // 4) схлопываем >2 пробелов в один (после -layout колонки даны 6-8 пробелов).
  out = out.replace(/ {3,}/g, " ");
  // 5) >3 подряд пустых строк → 2.
  out = out.replace(/\n{4,}/g, "\n\n\n");
  // 6) trim тотальный.
  return out.trim();
}

export const __test__ = { _normalize, _runPdftotext };
