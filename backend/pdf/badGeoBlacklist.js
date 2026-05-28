/**
 * pdf/badGeoBlacklist.js — in-memory blacklist плохих geo/operator/checked_ip
 * на время процесса. Не персистится: рестарт = чистый старт.
 *
 * Зачем: MobileProxy.Space даёт changeGeo бесплатно, но провайдер не помнит,
 * что мы только что сожгли это гео на 451/timeout. Без локального blacklist'а
 * recovery будет крутить changeGeo по кругу и снова попадать на тот же geoid.
 *
 * Cooldown — `RAS_PDF_BAD_GEO_COOLDOWN_MS` (default 30 мин). За это время гео
 * (или checked IP, или оператор) могут «остыть» у RAS — pravocaptcha снимет
 * 451-fingerprint, IP выведут из abuse-листов и т.п.
 *
 * Используется:
 *  - как фильтр при changeGeo (excludeGeoIds);
 *  - как ранний detect: если pool вернул нам прокси, чьи geoid/operator/IP
 *    в blacklist'е — не тратим warmup, сразу changeGeo.
 */

const _DEFAULT_COOLDOWN_MS = 30 * 60 * 1000;

export function readBadGeoBlacklistConfigFromEnv() {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    cooldownMs: Math.max(
      60_000,
      num(process.env.RAS_PDF_BAD_GEO_COOLDOWN_MS, _DEFAULT_COOLDOWN_MS),
    ),
  };
}

export class BadGeoBlacklist {
  /**
   * @param {{ cooldownMs?: number, now?: () => number, logger?: (m: string) => void }} [opts]
   */
  constructor({ cooldownMs = _DEFAULT_COOLDOWN_MS, now, logger } = {}) {
    this._cooldownMs = Math.max(1000, cooldownMs);
    this._now = now ?? (() => Date.now());
    this._log = logger ?? (() => {});
    /** @type {Map<string, { until: number, reason: string, kind: 'geo'|'op'|'ip' }>} */
    this._entries = new Map();
  }

  _key(kind, value) {
    return `${kind}:${String(value)}`;
  }

  /**
   * Добавить плохие признаки в blacklist. Любой непустой признак учитывается.
   * @param {{ geoid?: number|string|null, operator?: string|null, ip?: string|null, reason?: string }} sig
   */
  markBad({ geoid = null, operator = null, ip = null, reason = "" } = {}) {
    const until = this._now() + this._cooldownMs;
    const safeReason = String(reason ?? "").slice(0, 80);
    if (geoid !== null && geoid !== undefined && String(geoid) !== "") {
      this._entries.set(this._key("geo", geoid), {
        until,
        reason: safeReason,
        kind: "geo",
      });
    }
    if (operator) {
      this._entries.set(this._key("op", operator), {
        until,
        reason: safeReason,
        kind: "op",
      });
    }
    if (ip) {
      this._entries.set(this._key("ip", ip), {
        until,
        reason: safeReason,
        kind: "ip",
      });
    }
  }

  _isStillBad(kind, value) {
    if (value === null || value === undefined || value === "") return false;
    const k = this._key(kind, value);
    const e = this._entries.get(k);
    if (!e) return false;
    if (e.until <= this._now()) {
      this._entries.delete(k);
      return false;
    }
    return true;
  }

  isGeoBad(geoid) {
    return this._isStillBad("geo", geoid);
  }
  isOperatorBad(op) {
    return this._isStillBad("op", op);
  }
  isIpBad(ip) {
    return this._isStillBad("ip", ip);
  }

  /** True если хоть один признак в blacklist'е. */
  isAnyBad({ geoid = null, operator = null, ip = null } = {}) {
    return this.isGeoBad(geoid) || this.isOperatorBad(operator) || this.isIpBad(ip);
  }

  /** Список ещё активных bad geoid (числа) — для excludeGeoIds в changeGeo. */
  badGeoIds() {
    const out = [];
    const now = this._now();
    for (const [k, v] of this._entries.entries()) {
      if (v.kind !== "geo") continue;
      if (v.until <= now) {
        this._entries.delete(k);
        continue;
      }
      const geoid = Number(k.slice("geo:".length));
      if (Number.isFinite(geoid)) out.push(geoid);
    }
    return out;
  }

  /** Список ещё активных bad operator names — для excludeOperators в changeGeo. */
  badOperators() {
    const out = [];
    const now = this._now();
    for (const [k, v] of this._entries.entries()) {
      if (v.kind !== "op") continue;
      if (v.until <= now) {
        this._entries.delete(k);
        continue;
      }
      const name = k.slice("op:".length);
      if (name) out.push(name);
    }
    return out;
  }

  size() {
    return this._entries.size;
  }

  /** Удалить просроченные записи. */
  prune() {
    const now = this._now();
    for (const [k, v] of this._entries.entries()) {
      if (v.until <= now) this._entries.delete(k);
    }
  }

  /**
   * Удалить ВСЕ operator-блэклисты (geoid+ip оставить).
   * Нужно когда geo-filter:`countries=[...], excludeOps=[...]` отдаёт 0
   * candidates — у нас 4 оператора в KZ/BY/KG, заблэклистив все по разу мы
   * перекрываем весь пул. Operator слишком широкий ключ; geo+ip достаточно.
   * @returns {number} сколько записей удалено
   */
  clearOperators() {
    let n = 0;
    for (const k of [...this._entries.keys()]) {
      if (k.startsWith("op:")) {
        this._entries.delete(k);
        n += 1;
      }
    }
    return n;
  }

  /**
   * Аналогично для geoid'ов (когда даже после clearOperators не помогло —
   * cascade полной очистки, держим только ip-blacklist).
   * @returns {number} сколько записей удалено
   */
  clearGeos() {
    let n = 0;
    for (const k of [...this._entries.keys()]) {
      if (k.startsWith("geo:")) {
        this._entries.delete(k);
        n += 1;
      }
    }
    return n;
  }
}

export const __test__ = { _DEFAULT_COOLDOWN_MS };
