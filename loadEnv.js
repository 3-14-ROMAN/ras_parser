/**
 * Side-effect модуль автозагрузки .env.
 *
 * Должен импортироваться ПЕРВЫМ в любой entry-point, который читает
 * `process.env.MP_*` (parser.js и пр.). Это страховка от запуска
 * без `--env-file=.env`: видели как `node parser.js` уходит в 200
 * попыток `goto`, потому что `MP_PROXY_USER/PASS` пустые и провайдер
 * отдаёт 407 → `ERR_INVALID_AUTH_CREDENTIALS`.
 *
 * `process.loadEnvFile()` доступен с Node 20.12+ (в проекте Node 20.18+,
 * см. package.json `engines.node`). Если файла `.env` нет — просто
 * не делаем ничего, env-переменные могут быть выставлены руками.
 *
 * Если уже передан `--env-file=.env`, повторная загрузка идемпотентна:
 * Node не перезаписывает уже выставленные `process.env.*`.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ENV_PATH = path.join(__dirname, ".env");

if (typeof process.loadEnvFile === "function") {
  try {
    process.loadEnvFile(ENV_PATH);
  } catch (e) {
    if (e && e.code !== "ENOENT") {
      process.stderr.write(
        `[loadEnv] не смог загрузить ${ENV_PATH}: ${e}\n`,
      );
    }
  }
} else {
  process.stderr.write(
    `[loadEnv] process.loadEnvFile недоступен (Node ${process.version}), ` +
      `запускай через 'node --env-file=.env parser.js' или обнови Node до 20.12+\n`,
  );
}
