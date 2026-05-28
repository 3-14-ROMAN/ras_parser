/**
 * ProxyEscalator — циклическая лестница восстановления при бане/таймауте.
 *
 * Раньше тут была политика «changeGeo платно — кидаем EscalationExhausted
 * если L1+L2 не помогли при kind=banned». Это была ошибка: у MobileProxy.Space
 * смены оборудования и региона бесплатные, ограничение только по частоте
 * (cooldowns ≥120с на changeIp, ≥180с на changeEquipment). Под месячные
 * прогоны эскалатор не должен останавливаться вообще — он крутит лестницу
 * IP→Operator→Geo→IP бесконечно с соблюдением cooldowns.
 *
 * Уровни (по нарастанию веса):
 *
 *   L1 «changeIp»          — `ipBeforeOperator` штук подряд
 *   L2 «changeOperator»    — `operatorBeforeGeo` штук подряд (в текущем geoid)
 *   L3 «changeGeo»         — 1 шаг, после которого счётчики L1/L2 сбрасываются
 *                            и цикл начинается заново с L1
 *
 * `recoverFrom` НИКОГДА не кидает `EscalationExhausted` в штатном флоу.
 * Класс `EscalationExhausted` оставлен для обратной совместимости в catch'ах.
 */

import { performance } from "node:perf_hooks";

const monotonic = () => performance.now() / 1000;

export class EscalationExhausted extends Error {
  constructor(message, summary) {
    super(message);
    this.name = "EscalationExhausted";
    this.summary = summary;
  }
}

export const ESC_LEVELS = Object.freeze({
  IP: "ip",
  OPERATOR: "operator",
  GEO: "geo",
});

/** Оставлено для обратной совместимости с parser.js — эскалатор kind не использует. */
export const ESC_KINDS = Object.freeze({
  BANNED: "banned",
  NET_DOWN: "net_down",
});

export class ProxyEscalator {
  /**
   * @param {object} cfg
   * @param {import('./proxyClient.js').RasProxyClient} cfg.proxyClient
   * @param {{smartWait:(t:string)=>Promise<unknown>}|null} [cfg.stealth]
   * @param {(msg:string)=>void} [cfg.logger]
   * @param {number} [cfg.maxIpRotationsBeforeEquipment=3]
   *        Сколько changeIp подряд до перехода на L2.
   * @param {number} [cfg.maxOperatorSwapsBeforeGeo=2]
   *        Сколько changeOperator подряд до перехода на L3.
   * @param {object|null} [cfg.geoFilters]
   *        Прокидывается в `proxyClient.changeGeo({ filters })`.
   */
  constructor({
    proxyClient,
    stealth = null,
    logger = (m) => process.stdout.write(`${m}\n`),
    maxIpRotationsBeforeEquipment = 3,
    maxOperatorSwapsBeforeGeo = 2,
    geoFilters = null,
    // принимаем старые ключи без эффекта — чтобы не ломать парсер,
    // который ещё передаёт maxGeoSwaps / maxBudgetSec / maxTotalFailures
    // и т.п. Все они теперь = «без лимита».
    ...rest
  }) {
    if (!proxyClient) throw new Error("ProxyEscalator: proxyClient is required");
    this.client = proxyClient;
    this.stealth = stealth;
    this.log = logger;
    this.geoFilters = geoFilters;
    this.ipBeforeOperator = Math.max(1, maxIpRotationsBeforeEquipment);
    this.operatorBeforeGeo = Math.max(0, maxOperatorSwapsBeforeGeo);
    void rest;

    this.consecutiveIpRotations = 0;
    this.operatorSwapsThisCycle = 0;
    this.totalIpRotations = 0;
    this.totalOperatorSwaps = 0;
    this.totalGeoSwaps = 0;
    this.totalFailures = 0;
    this.startedAt = monotonic();
    this.lastAction = null;
  }

  /**
   * Заменить geoFilters в runtime. Используется preflight'ом pipeline.js: после
   * anti-cloak probe мы знаем «работающие» страны и сужаем фильтры под них
   * (changeGeo на L3 будет выбирать только из этого списка).
   */
  setGeoFilters(filters) {
    this.geoFilters = filters;
  }

  summary() {
    return {
      consecutiveIpRotations: this.consecutiveIpRotations,
      operatorSwapsThisCycle: this.operatorSwapsThisCycle,
      totalIpRotations: this.totalIpRotations,
      totalOperatorSwaps: this.totalOperatorSwaps,
      totalGeoSwaps: this.totalGeoSwaps,
      totalFailures: this.totalFailures,
      elapsedSec: Math.round(monotonic() - this.startedAt),
      lastAction: this.lastAction,
    };
  }

  async _settle(level) {
    if (!this.stealth) return;
    if (level === ESC_LEVELS.IP) {
      await this.stealth.smartWait("ip_cooldown");
    } else {
      await this.stealth.smartWait("equipment_swap");
    }
  }

  /**
   * Главная точка. Никогда не кидает `EscalationExhausted` — крутит лестницу
   * по кругу. Cooldowns между вызовами одного и того же действия (changeIp /
   * changeEquipment) соблюдаются внутри `RasProxyClient` через
   * `minIpRotateGapSec` / `minEquipmentSwapGapSec`: если зашли «слишком рано»,
   * клиент сам спит до окна. Вызывающему коду не надо знать про cooldowns.
   *
   * Параметр `opts.kind` оставлен для обратной совместимости и игнорируется.
   *
   * @param {string} reason
   * @param {object} [_opts]
   * @returns {Promise<{level:'ip'|'operator'|'geo', detail:object}>}
   */
  async recoverFrom(reason, _opts = {}) {
    this.totalFailures += 1;

    if (this.consecutiveIpRotations < this.ipBeforeOperator) {
      this.log(
        `[esc] L1 changeIp #${this.consecutiveIpRotations + 1}/${this.ipBeforeOperator} (${reason})`,
      );
      let res;
      try {
        res = await this.client.rotateIp(reason);
      } catch (e) {
        this.log(`[esc] rotateIp кинул ${e} — считаю как «не помогло» и иду выше`);
        res = { ok: false };
      }
      this.consecutiveIpRotations += 1;
      this.totalIpRotations += 1;
      this.lastAction = ESC_LEVELS.IP;
      await this._settle(ESC_LEVELS.IP);
      return { level: ESC_LEVELS.IP, detail: res };
    }

    if (this.operatorSwapsThisCycle < this.operatorBeforeGeo) {
      this.log(
        `[esc] L2 changeOperator #${this.operatorSwapsThisCycle + 1}/${this.operatorBeforeGeo} (${reason})`,
      );
      let res;
      try {
        res = await this.client.changeOperator(reason);
      } catch (e) {
        this.log(`[esc] changeOperator кинул ${e}`);
        res = { ok: false };
      }
      this.operatorSwapsThisCycle += 1;
      this.totalOperatorSwaps += 1;
      this.consecutiveIpRotations = 0;
      this.lastAction = ESC_LEVELS.OPERATOR;
      // L2 fail — типично «нет альтернативного оператора в текущем гео».
      // Не возвращаем fail с reset'ом L1 (это запустит вечный цикл L1×8 → L2 fail
      // → L1×8 опять, не дойдя до L3 changeGeo минут за 30). Сразу эскалируем на
      // L3 в этом же recoverFrom, чтобы реально сменить страну.
      if (!res || res.ok === false) {
        this.log(
          `[esc] L2 fail — сразу эскалирую на L3 changeGeo без отката счётчиков`,
        );
        // fall through к L3 ниже
      } else {
        await this._settle(ESC_LEVELS.OPERATOR);
        return { level: ESC_LEVELS.OPERATOR, detail: res };
      }
    }

    // L3: changeGeo. У провайдера операция бесплатна, ограничение только по
    // частоте (`minGeoSwapGapSec`). После успешного шага сбрасываем оба
    // нижних счётчика — следующий цикл начнётся опять с дешёвого changeIp.
    this.log(`[esc] L3 changeGeo (${reason})`);
    let res;
    try {
      res = await this.client.changeGeo(reason, { filters: this.geoFilters });
    } catch (e) {
      this.log(`[esc] changeGeo кинул ${e}`);
      res = { ok: false };
    }
    this.totalGeoSwaps += 1;
    this.consecutiveIpRotations = 0;
    this.operatorSwapsThisCycle = 0;
    this.lastAction = ESC_LEVELS.GEO;
    await this._settle(ESC_LEVELS.GEO);
    return { level: ESC_LEVELS.GEO, detail: res };
  }

  /**
   * Провайдер вернул OK на changeIp, но `new_ip` совпал с прошлым вызовом —
   * эскалация «не была реальной». Откатываем инкременты последнего L1-шага,
   * чтобы лестница не схлопывалась впустую.
   */
  revertLastIpRotationForDuplicateEgress(reason) {
    if (this.lastAction !== ESC_LEVELS.IP) {
      this.log(
        `[esc] revertLastIpRotation: lastAction=${this.lastAction} — не после L1, пропуск`,
      );
      return;
    }
    this.totalFailures = Math.max(0, this.totalFailures - 1);
    this.totalIpRotations = Math.max(0, this.totalIpRotations - 1);
    this.consecutiveIpRotations = Math.max(0, this.consecutiveIpRotations - 1);
    this.log(`[esc] откат счётчиков после duplicate new_ip: ${reason}`);
  }

  /**
   * Сбрасываем счётчики нижних уровней, увидев успешный запрос.
   * @param {'ip'|'operator'|'geo'|null} [level]
   */
  noteSuccess(level = null) {
    if (level === null || level === ESC_LEVELS.IP) {
      this.consecutiveIpRotations = 0;
    }
    if (level === ESC_LEVELS.OPERATOR || level === ESC_LEVELS.GEO) {
      this.consecutiveIpRotations = 0;
      this.operatorSwapsThisCycle = 0;
    }
  }
}
