#!/usr/bin/env node
/**
 * Ручной вызов API MobileProxy.Space через RasProxyClient.
 *
 * Смена оборудования (change_equipment) — подкоманды operator | geo.
 * Дополнительно: ip (rotate), list (get_geo_operator_list).
 *
 * Запуск (из корня репозитория):
 *   node --env-file=.env scripts/mp-proxy-api.js operator
 *   node --env-file=.env scripts/mp-proxy-api.js geo
 *   node --env-file=.env scripts/mp-proxy-api.js geo --raw
 *   node --env-file=.env scripts/mp-proxy-api.js ip
 *   node --env-file=.env scripts/mp-proxy-api.js list
 *
 * По умолчанию cooldown между сменами оборудования отключён (0),
 * чтобы ручной запрос не ждал лишних секунд. Флаг --respect-cooldown
 * включает паузы как у парсера (IP / оборудование / geo из .env).
 */

import "../network/loadEnv.js";
import {
  CHANGE_GEO_COOLDOWN_SEC,
  ESC_EQUIPMENT_COOLDOWN_SEC,
  GEO_FILTERS,
  MP_API_TOKEN,
  MP_PROXY_KEY,
  MP_PROXY_ID,
} from "../network/config.js";
import { RasProxyClient } from "../network/proxyClient.js";

function usage() {
  process.stderr.write(
    `Использование:
  node --env-file=.env scripts/mp-proxy-api.js <команда> [опции]

Команды:
  operator   — сменить оператора в текущем гео (L2 эскалатора)
  geo        — сменить регион (платно у провайдера); применяются GEO_* из .env
  ip         — только смена IP (rotation), без смены модема/SIM
  list       — список доступного оборудования (JSON в stdout)

Опции:
  --raw      — для geo: не применять GEO_FILTERS (осторожно: можно уехать куда угодно)
  --respect-cooldown — ждать cooldown'ы из .env (IP / оборудование / geo)

Требуются MP_API_TOKEN и MP_PROXY_KEY в окружении.
`,
  );
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const flags = new Set();
  const positionals = [];
  for (const a of args) {
    if (a.startsWith("--")) flags.add(a.slice(2));
    else positionals.push(a);
  }
  return { positionals, flags };
}

async function main() {
  const { positionals, flags } = parseArgs(process.argv);
  const cmd = positionals[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    process.exit(cmd ? 0 : 1);
  }

  if (!MP_API_TOKEN || !MP_PROXY_KEY) {
    process.stderr.write(
      "[mp-cli] Задайте MP_API_TOKEN и MP_PROXY_KEY в .env или окружении.\n",
    );
    process.exit(1);
  }

  const respectCooldown = flags.has("respect-cooldown");
  const minEq = respectCooldown ? ESC_EQUIPMENT_COOLDOWN_SEC : 0;
  const minIp = respectCooldown
    ? Number(process.env.MP_CHANGE_IP_COOLDOWN_SEC ?? 300)
    : 0;
  const minGeo = respectCooldown ? CHANGE_GEO_COOLDOWN_SEC : 0;

  const client = new RasProxyClient({
    apiToken: MP_API_TOKEN,
    proxyKey: MP_PROXY_KEY,
    proxyId: MP_PROXY_ID,
    minIpRotateGapSec: minIp,
    minEquipmentSwapGapSec: minEq,
    minGeoSwapGapSec: minGeo,
    logger: (m) => process.stderr.write(`${m}\n`),
  });

  const reason = `cli:${cmd}`;

  try {
    if (cmd === "list") {
      const data = await client.getAvailableEquipment();
      process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
      process.exit(0);
    }

    if (cmd === "ip") {
      const r = await client.rotateIp(reason);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exit(r.ok ? 0 : 1);
    }

    if (cmd === "operator") {
      const r = await client.changeOperator(reason);
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exit(r.ok ? 0 : 1);
    }

    if (cmd === "geo") {
      const raw = flags.has("raw");
      const r = await client.changeGeo(reason, {
        filters: raw ? null : GEO_FILTERS,
        allowFallbackOperator: true,
      });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      process.exit(r.ok ? 0 : 1);
    }

    process.stderr.write(`[mp-cli] неизвестная команда: ${cmd}\n\n`);
    usage();
    process.exit(1);
  } catch (e) {
    process.stderr.write(`[mp-cli] ошибка: ${e}\n`);
    process.exit(1);
  }
}

await main();
