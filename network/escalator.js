/**
 * ProxyEscalator — лестница восстановления, когда нас бьют по IP.
 *
 * Идея: вышестоящий код (parser.js) при «надо что-то сделать с
 * прокси, чтобы не получать 403/429/таймауты» больше не дёргает
 * `changeIp` сам. Он зовёт `escalator.recoverFrom(reason, { kind })`,
 * и эскалатор сам решает, что делать на текущем уровне.
 *
 * Уровни:
 *
 *   L1 «changeIp»
 *      └─ дешёвая ротация мобильного IP. Пытаемся
 *         `maxIpRotationsBeforeEquipment` раз подряд.
 *
 *   L2 «changeOperator» (changeEquipment строго в текущем geoid,
 *      без слепого фоллбека на «любой другой eid»)
 *      └─ если N подряд `changeIp` не вытащили нас из бана,
 *         меняем SIM в том же гео. Долгая операция.
 *         Делаем не больше `maxOperatorSwapsBeforeGeo` штук.
 *
 *   L3 «changeGeo» (changeEquipment с другим geoid, RU-only,
 *      под `geoFilters`).
 *      └─ ВНИМАНИЕ: смена региона у провайдера ПЛАТНАЯ. Поэтому
 *         L3 запускается ТОЛЬКО если `kind === 'net_down'`, т.е.
 *         вышестоящий код подтвердил, что это полный отвал сети
 *         (timeout / ERR_CONNECTION_* / 5+ флапов туннеля подряд),
 *         а не просто HTTP-бан 403/429 от сайта на текущем IP.
 *         Не больше `maxGeoSwaps` штук на весь прогон.
 *
 *   STOP «EscalationExhausted»
 *      └─ если все доступные уровни выгребены, либо (если заданы
 *         `maxBudgetSec`/`maxTotalFailures` > 0) превышен тайм-бюджет
 *         или число вызовов `recoverFrom` — бросаем исключение наверх.
 *         Сама лестница L1→L2→(L3) уже конечна; опциональные бюджеты —
 *         дополнительный предохранитель для тех, кто их включит в .env.
 *
 * Контракт `kind`:
 *
 *   - `'banned'` (по умолчанию) — HTTP-бан сайтом (403/429/5xx),
 *     капча, sentinel не найден, тихий бан и т.п. На таком kind
 *     L3 (changeGeo) НЕ запускается никогда. Если L1+L2 уже
 *     исчерпаны в текущем geo, эскалатор кидает
 *     `EscalationExhausted` вместо платной смены региона.
 *
 *   - `'net_down'` — реальный отвал сети: net::ERR_TIMED_OUT,
 *     ERR_CONNECTION_RESET/REFUSED, Playwright-таймаут на goto,
 *     ECONNRESET/ETIMEDOUT, 5+ флапов прокси-туннеля подряд.
 *     На таком kind L3 разрешён, но всё равно сначала отрабатывает
 *     L1 (changeIp) — пользователь явно сказал «менять локацию
 *     только когда смена IP не помогает».
 *
 * После каждой эскалации у вышестоящего кода есть один шанс снова
 * попробовать: если запрос прошёл — `escalator.noteSuccess(level)`
 * сбрасывает счётчик нижних уровней. Например, успех после `changeIp`
 * сбрасывает `consecutiveIpRotations` в 0; успех после `changeOperator`
 * — ещё и `operatorSwapsThisGeo`. То есть «новый цикл атак» снова
 * начнётся с дешёвого `changeIp`.
 *
 * Этот модуль НЕ знает про Playwright и про сам ras.arbitr.ru. Он
 * только дёргает `RasProxyClient` и считает попытки.
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

export const ESC_KINDS = Object.freeze({
  BANNED: "banned",
  NET_DOWN: "net_down",
});

export class ProxyEscalator {
  /**
   * @param {object} cfg
   * @param {import('./proxyClient.js').RasProxyClient} cfg.proxyClient
   * @param {{smartWait:(t:string)=>Promise<unknown>}} [cfg.stealth]
   *        Если передан — после каждой эскалации делаем
   *        `smartWait('ip_cooldown' | 'equipment_swap')`, чтобы дать
   *        провайдеру/модему доехать. Если не передан — ничего не ждём
   *        (для unit-тестов).
   * @param {(msg:string)=>void} [cfg.logger]
   * @param {number} [cfg.maxIpRotationsBeforeEquipment=3]
   *        Сколько раз подряд пробовать `changeIp` до эскалации.
   * @param {number} [cfg.preEquipmentIpRotations=0]
   *        Сколько ДОПОЛНИТЕЛЬНЫХ `changeIp` сделать перед первой
   *        сменой оборудования (L2/L3) после исчерпания L1.
   * @param {number} [cfg.maxOperatorSwapsBeforeGeo=2]
   *        Сколько раз подряд менять оператора до эскалации в гео.
 * @param {number} [cfg.maxGeoSwaps=2]
 *        Потолок смен гео за прогон (**≤0 — без лимита**; частоту режет
 *        `minGeoSwapGapSec` в RasProxyClient).
 * @param {number} [cfg.maxTotalFailures=0]
 *        Сколько всего вызовов `recoverFrom` готовы пережить.
 *        **0 или меньше — без лимита** (долгие фоновые прогоны).
 * @param {number} [cfg.maxBudgetSec=0]
 *        Полный таймбюджет на работу эскалатора (с момента создания).
 *        **0 или меньше — без лимита.** Иначе превысили — `EscalationExhausted`.
   * @param {object} [cfg.geoFilters]
   *        Ограничения, которые применяются при L3 changeGeo (запуск
   *        ТОЛЬКО при `recoverFrom(reason, {kind:'net_down'})` —
   *        политика «менять регион только при полном отвале сети»).
   *        Прокидываются в `proxyClient.changeGeo({ filters })`.
   *        Подробности — JSDoc `RasProxyClient.changeGeo`. Передавайте,
   *        если у провайдера часть гео в ACL по hostname (так у
   *        mobileproxy.space сейчас с `*.arbitr.ru` в Москве/СПб/
   *        миллионниках).
   */
  constructor({
    proxyClient,
    stealth = null,
    logger = (m) => process.stdout.write(`${m}\n`),
    maxIpRotationsBeforeEquipment = 3,
    preEquipmentIpRotations = 0,
    maxOperatorSwapsBeforeGeo = 2,
    maxGeoSwaps = 2,
    maxTotalFailures = 0,
    maxBudgetSec = 0,
    geoFilters = null,
  }) {
    if (!proxyClient) throw new Error("ProxyEscalator: proxyClient is required");
    this.client = proxyClient;
    this.stealth = stealth;
    this.log = logger;
    this.geoFilters = geoFilters;

    this.limits = {
      maxIpRotationsBeforeEquipment,
      preEquipmentIpRotations: Math.max(0, preEquipmentIpRotations),
      maxOperatorSwapsBeforeGeo,
      maxGeoSwaps,
      maxTotalFailures,
      maxBudgetSec,
    };

    this.consecutiveIpRotations = 0;
    this.operatorSwapsThisGeo = 0;
    this.totalIpRotations = 0;
    this.totalOperatorSwaps = 0;
    this.totalGeoSwaps = 0;
    this.totalFailures = 0;
    this.startedAt = monotonic();
    this.lastAction = null;
    this.preEquipmentBurstDone = false;
  }

  summary() {
    return {
      consecutiveIpRotations: this.consecutiveIpRotations,
      operatorSwapsThisGeo: this.operatorSwapsThisGeo,
      totalIpRotations: this.totalIpRotations,
      totalOperatorSwaps: this.totalOperatorSwaps,
      totalGeoSwaps: this.totalGeoSwaps,
      totalFailures: this.totalFailures,
      elapsedSec: Math.round(monotonic() - this.startedAt),
      lastAction: this.lastAction,
    };
  }

  _checkBudget(reason) {
    const elapsed = monotonic() - this.startedAt;
    if (
      this.limits.maxBudgetSec > 0 &&
      elapsed > this.limits.maxBudgetSec
    ) {
      throw new EscalationExhausted(
        `[esc] исчерпан общий бюджет ${this.limits.maxBudgetSec}с, причина=${reason}`,
        this.summary(),
      );
    }
    if (
      this.limits.maxTotalFailures > 0 &&
      this.totalFailures >= this.limits.maxTotalFailures
    ) {
      throw new EscalationExhausted(
        `[esc] исчерпан лимит totalFailures=${this.limits.maxTotalFailures}, причина=${reason}`,
        this.summary(),
      );
    }
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
   * Главная точка. Вышестоящий код должен звать ровно её, когда решил,
   * что текущий IP/SIM пора менять (бан, таймаут, и т.п.).
   *
   * @param {string} reason  human-readable, попадает в логи
   * @param {object} [opts]
   * @param {'banned'|'net_down'} [opts.kind='banned']
   *        Природа сбоя. Управляет, разрешена ли L3 changeGeo:
   *        - `'banned'` — HTTP-бан/sentinel-нет/тихий бан. L3 ЗАПРЕЩЁН.
   *           Идём L1 → L2 → STOP. Это защищает от платных смен
   *           региона на ровном месте.
   *        - `'net_down'` — полный отвал сети (timeout, ERR_CONNECTION_*,
   *           5+ флапов туннеля подряд). L3 разрешён, но всё равно
   *           только после исчерпания L1 (по политике «менять регион
   *           только если changeIp не помог»).
   * @returns {Promise<{level: 'ip'|'operator'|'geo', detail: object, kind: 'banned'|'net_down'}>}
   * @throws {EscalationExhausted}
   */
  async recoverFrom(reason, opts = {}) {
    const kind = opts.kind ?? ESC_KINDS.BANNED;
    if (kind !== ESC_KINDS.BANNED && kind !== ESC_KINDS.NET_DOWN) {
      throw new Error(
        `ProxyEscalator.recoverFrom: invalid kind='${kind}', ожидаю 'banned' | 'net_down'`,
      );
    }
    this.totalFailures += 1;
    this._checkBudget(reason);

    if (this.consecutiveIpRotations < this.limits.maxIpRotationsBeforeEquipment) {
      this.log(
        `[esc] L1 changeIp #${this.consecutiveIpRotations + 1}/` +
          `${this.limits.maxIpRotationsBeforeEquipment} kind=${kind} (${reason})`,
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
      return { level: ESC_LEVELS.IP, detail: res, kind };
    }

    if (!this.preEquipmentBurstDone && this.limits.preEquipmentIpRotations > 0) {
      this.log(
        `[esc] pre-L2 burst: ${this.limits.preEquipmentIpRotations}x changeIp ` +
          `перед сменой оборудования (${reason})`,
      );
      for (let i = 1; i <= this.limits.preEquipmentIpRotations; i += 1) {
        this.log(
          `[esc] pre-L2 changeIp #${i}/${this.limits.preEquipmentIpRotations} kind=${kind}`,
        );
        let res;
        try {
          res = await this.client.rotateIp(`pre-equipment#${i}: ${reason}`);
        } catch (e) {
          this.log(`[esc] pre-L2 rotateIp кинул ${e} — продолжаю к оборудованию`);
          res = { ok: false };
        }
        this.totalIpRotations += 1;
        this.lastAction = ESC_LEVELS.IP;
        await this._settle(ESC_LEVELS.IP);
        if (res && res.ok) {
          this.consecutiveIpRotations += 1;
        }
      }
      this.preEquipmentBurstDone = true;
    }

    const geoCapOk =
      this.limits.maxGeoSwaps <= 0 || this.totalGeoSwaps < this.limits.maxGeoSwaps;
    if (geoCapOk && this.operatorSwapsThisGeo < this.limits.maxOperatorSwapsBeforeGeo) {
      this.log(
        `[esc] L2 changeOperator #${this.operatorSwapsThisGeo + 1}/` +
          `${this.limits.maxOperatorSwapsBeforeGeo} kind=${kind} (${reason})`,
      );
      let res;
      try {
        res = await this.client.changeOperator(reason);
      } catch (e) {
        this.log(`[esc] changeOperator кинул ${e} — иду выше`);
        res = { ok: false };
      }
      this.operatorSwapsThisGeo += 1;
      this.totalOperatorSwaps += 1;
      this.consecutiveIpRotations = 0;
      this.preEquipmentBurstDone = false;
      this.lastAction = ESC_LEVELS.OPERATOR;
      await this._settle(ESC_LEVELS.OPERATOR);
      return { level: ESC_LEVELS.OPERATOR, detail: res, kind };
    }

    if (kind === ESC_KINDS.NET_DOWN && geoCapOk) {
      this.log(
        `[esc] L3 changeGeo #${this.totalGeoSwaps + 1}/${
          this.limits.maxGeoSwaps <= 0 ? "off" : this.limits.maxGeoSwaps
        } ` +
          `kind=net_down (${reason}) — \u0421\u041c\u0415\u041d\u042f\u042e \u0420\u0415\u0413\u0418\u041e\u041d ` +
          `(\u043f\u043b\u0430\u0442\u043d\u043e \u0443 \u043f\u0440\u043e\u0432\u0430\u0439\u0434\u0435\u0440\u0430)`,
      );
      let res;
      try {
        res = await this.client.changeGeo(reason, { filters: this.geoFilters });
      } catch (e) {
        this.log(`[esc] changeGeo кинул ${e} — пишу неудачу, считаю как фатал`);
        res = { ok: false };
      }
      this.totalGeoSwaps += 1;
      this.operatorSwapsThisGeo = 0;
      this.consecutiveIpRotations = 0;
      this.preEquipmentBurstDone = false;
      this.lastAction = ESC_LEVELS.GEO;
      await this._settle(ESC_LEVELS.GEO);
      return { level: ESC_LEVELS.GEO, detail: res, kind };
    }

    if (kind === ESC_KINDS.BANNED && geoCapOk) {
      throw new EscalationExhausted(
        `[esc] L1+L2 исчерпаны в текущем geo (ip×${this.totalIpRotations}, ` +
          `op×${this.totalOperatorSwaps}), kind=banned — changeGeo ПОЛИТИКОЙ ЗАПРЕЩЁН ` +
          `(смена региона у провайдера платная, разрешена только при kind=net_down). ` +
          `причина=${reason}`,
        this.summary(),
      );
    }

    throw new EscalationExhausted(
      `[esc] исчерпаны все уровни (ip×${this.totalIpRotations}, ` +
        `op×${this.totalOperatorSwaps}, geo×${this.totalGeoSwaps}), ` +
        `kind=${kind}, причина=${reason}`,
      this.summary(),
    );
  }

  /**
   * Провайдер вернул OK на changeIp, но `new_ip` совпал с прошлым вызовом —
   * эскалация «не была реальной». Откатываем инкременты последнего L1-шага,
   * чтобы не сжигать лестницу и totalFailures впустую (см. parser.js:
   * перезапуск браузера и повтор окна).
   *
   * @param {string} reason
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
    this.log(
      `[esc] откат счётчиков после duplicate new_ip (failures/ip/consecutive −1): ${reason}`,
    );
  }

  /**
   * Сбрасываем счётчики нижних уровней, увидев успешный запрос.
   * Если уровень не передали — успех «общий», сбрасываем всё подряд
   * (consecutive только; total/перманентные — нет).
   *
   * @param {'ip'|'operator'|'geo'|null} [level]
   */
  noteSuccess(level = null) {
    if (level === null || level === ESC_LEVELS.IP) {
      this.consecutiveIpRotations = 0;
    }
    if (level === ESC_LEVELS.OPERATOR || level === ESC_LEVELS.GEO) {
      this.consecutiveIpRotations = 0;
      this.operatorSwapsThisGeo = 0;
    }
  }
}

