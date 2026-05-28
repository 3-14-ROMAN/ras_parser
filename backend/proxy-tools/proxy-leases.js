#!/usr/bin/env node
/**
 * scripts/proxy-leases.js — ручное управление таблицей `proxy_leases`.
 *
 * Зачем: парсер падает с «все proxy_key заняты» после kill -9 / SIGKILL —
 * heartbeat не успел снять lease, expires_at улетел в будущее. Этот тул
 * показывает состояние и подчищает зомби-аренды без необходимости лезть в psql.
 *
 * Команды:
 *   status                    — JSON-снимок всех аренд + флаг expired / dead-pid
 *   cleanup [--role pdf]      — releaseExpiredGlobal + releaseDeadLocal (этот хост)
 *   release-key <proxy_key>   — DELETE по ключу (для аварийного освобождения)
 *
 * Запуск:
 *   npm run proxy:leases:status
 *   npm run proxy:leases:cleanup
 *   node --env-file=.env scripts/proxy-leases.js release-key <full-key>
 *
 * Без PG (RAS_PG_DSN не задан): говорит об этом и выходит с кодом 2.
 */

import "../network/loadEnv.js";

import { closePool, isPgConfigured } from "../db/pgClient.js";
import {
  cleanupLeases,
  listLeases,
  releaseOneKey,
} from "../db/proxyLeases.js";

function usage() {
  process.stderr.write(
    `Использование:
  npm run proxy:leases:status
  npm run proxy:leases:cleanup [-- --role pdf]
  node --env-file=.env scripts/proxy-leases.js release-key <proxy_key>

Команды:
  status                    JSON-снимок таблицы proxy_leases (этот хост помечен,
                            expired / dead-pid тоже).
  cleanup [--role <r>]      Снять expired (любой хост) + dead-pid (этот хост).
                            --role pdf|parser — фильтр (по умолчанию: все).
  release-key <proxy_key>   Удалить конкретную аренду. Использовать аккуратно:
                            если процесс реально живой — он получит lease-loss
                            на следующем heartbeat'е.

PG: берём из RAS_PG_DSN или DATABASE_URL (.env подхватывается автоматически).
`,
  );
}

function log(m) {
  process.stdout.write(`${m}\n`);
}

function fmtDate(d) {
  if (!d) return "?";
  try {
    return new Date(d).toISOString();
  } catch {
    return String(d);
  }
}

async function cmdStatus() {
  const rows = await listLeases();
  if (!rows.length) {
    log(JSON.stringify({ leases: [], summary: { total: 0 } }, null, 2));
    return 0;
  }
  const summary = {
    total: rows.length,
    expired: rows.filter((r) => r.expired).length,
    this_host: rows.filter((r) => r.hostState === "this-host").length,
    dead_pid_this_host: rows.filter(
      (r) => r.hostState === "this-host" && r.pidAlive === false,
    ).length,
  };
  const out = rows.map((r) => ({
    proxy_key: r.proxyKeyMasked,
    role: r.role,
    holder: r.holderMasked,
    holder_host: r.holderHost,
    holder_pid: r.holderPid,
    host_state: r.hostState,
    pid_alive: r.pidAlive,
    expired: r.expired,
    acquired_at: fmtDate(r.acquiredAt),
    renewed_at: fmtDate(r.renewedAt),
    expires_at: fmtDate(r.expiresAt),
  }));
  log(JSON.stringify({ summary, leases: out }, null, 2));
  return 0;
}

async function cmdCleanup({ role }) {
  const r = await cleanupLeases({ role, logger: log });
  log(
    `[cleanup] expired=${r.expired} dead_local=${r.dead}` +
      (role ? ` role=${role}` : ""),
  );
  return 0;
}

async function cmdReleaseKey(key) {
  if (!key) {
    process.stderr.write("[release-key] нужен аргумент: <proxy_key>\n");
    return 1;
  }
  const ok = await releaseOneKey(key);
  log(ok ? `[release-key] удалил аренду на key=${maskCli(key)}` : `[release-key] ничего не найдено по key=${maskCli(key)}`);
  return ok ? 0 : 2;
}

function maskCli(k) {
  if (!k) return "?";
  const s = String(k);
  if (s.length <= 8) return s;
  return `${s.slice(0, 6)}…${s.slice(-2)}`;
}

function parseArgs(argv) {
  const out = { cmd: null, role: null, key: null };
  const rest = [];
  for (let i = 2; i < argv.length; i += 1) {
    const a = argv[i];
    if (!out.cmd) {
      out.cmd = a;
      continue;
    }
    if (a === "--role") {
      out.role = argv[i + 1] ?? null;
      i += 1;
      continue;
    }
    if (a === "-h" || a === "--help") {
      out.cmd = "help";
      continue;
    }
    rest.push(a);
  }
  if (out.cmd === "release-key") out.key = rest[0] ?? null;
  return out;
}

async function main() {
  const args = parseArgs(process.argv);
  if (!args.cmd || args.cmd === "help") {
    usage();
    process.exit(args.cmd === "help" ? 0 : 1);
  }
  if (!isPgConfigured()) {
    process.stderr.write(
      "[lease/cli] DSN не задан (RAS_PG_DSN/DATABASE_URL). Не могу читать таблицу.\n",
    );
    process.exit(2);
  }
  let code = 0;
  try {
    if (args.cmd === "status") code = await cmdStatus();
    else if (args.cmd === "cleanup") code = await cmdCleanup({ role: args.role });
    else if (args.cmd === "release-key") code = await cmdReleaseKey(args.key);
    else {
      process.stderr.write(`[lease/cli] неизвестная команда: ${args.cmd}\n\n`);
      usage();
      code = 1;
    }
  } catch (e) {
    process.stderr.write(`[lease/cli] ошибка: ${e && (e.stack ?? e.message ?? e)}\n`);
    code = 1;
  } finally {
    try {
      await closePool();
    } catch {}
  }
  process.exit(code);
}

await main();
