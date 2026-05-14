/**
 * pdf/proxyQuarantine.js — in-memory карантин per `proxy_key`.
 *
 * Зачем: воркер привязан к одному прокси на всю жизнь. Если прокси разовый —
 * туннель до ras.arbitr.ru не открывается (ERR_TUNNEL_CONNECTION_FAILED) или
 * IP/гео уже забанены сайтом (HTTP 451) — `rotateIp()` внутри того же
 * `proxy_key` часто даёт тот же плохой пул. Воркер бесконечно пытается на нём,
 * сжигая ретраи. Карантин временно ВЫВОДИТ прокси из ротации: воркер уходит
 * в idle (спит), а здоровые воркеры доедают общую очередь (включая deferred-
 * акты этого воркера).
 *
 * Реестр НЕ персистится — рестарт процесса = чистый старт (это ок, проблемные
 * IP к тому моменту обычно «остывают» сами).
 */

const _DEFAULTS = {
  infraThreshold: 5,
  fourFiftyOneThreshold: 3,
  windowMs: 180_000,
  infraCooldownMs: 600_000,
  fourFiftyOneCooldownMs: 1_800_000,
};

export function readQuarantineConfigFromEnv() {
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    infraThreshold: Math.max(
      1,
      num(process.env.RAS_PDF_QUARANTINE_INFRA_THRESHOLD, _DEFAULTS.infraThreshold),
    ),
    fourFiftyOneThreshold: Math.max(
      1,
      num(process.env.RAS_PDF_QUARANTINE_451_THRESHOLD, _DEFAULTS.fourFiftyOneThreshold),
    ),
    windowMs: Math.max(
      1000,
      num(process.env.RAS_PDF_QUARANTINE_WINDOW_MS, _DEFAULTS.windowMs),
    ),
    infraCooldownMs: Math.max(
      1000,
      num(process.env.RAS_PDF_QUARANTINE_MS, _DEFAULTS.infraCooldownMs),
    ),
    fourFiftyOneCooldownMs: Math.max(
      1000,
      num(
        process.env.RAS_PDF_QUARANTINE_451_MS,
        _DEFAULTS.fourFiftyOneCooldownMs,
      ),
    ),
  };
}

/**
 * @typedef {Object} QuarantineEventResult
 * @property {boolean} entered    true = карантин ВПЕРВЫЕ установлен этим событием
 * @property {number}  fails      сколько событий накопилось в окне (включая текущее)
 * @property {number}  windowMs   ширина окна (для лога)
 * @property {number|null} until  Date.now()+cooldown если в карантине, иначе null
 * @property {"infra"|"451"} reason
 */

export class ProxyQuarantineRegistry {
  /**
   * @param {{
   *   infraThreshold: number,
   *   fourFiftyOneThreshold: number,
   *   windowMs: number,
   *   infraCooldownMs: number,
   *   fourFiftyOneCooldownMs: number,
   *   now?: () => number,
   * }} cfg
   */
  constructor({
    infraThreshold,
    fourFiftyOneThreshold,
    windowMs,
    infraCooldownMs,
    fourFiftyOneCooldownMs,
    now,
  }) {
    this._infraThr = infraThreshold;
    this._451Thr = fourFiftyOneThreshold;
    this._windowMs = windowMs;
    this._infraCdMs = infraCooldownMs;
    this._451CdMs = fourFiftyOneCooldownMs;
    this._now = now ?? (() => Date.now());
    /** @type {Map<string, number[]>} per-key timestamps (sliding window) */
    this._infraEvents = new Map();
    /** @type {Map<string, number[]>} */
    this._451Events = new Map();
    /** @type {Map<string, { until: number, reason: "infra"|"451" }>} */
    this._cooldown = new Map();
  }

  _key(k) {
    return k == null ? "" : String(k);
  }

  _pruneWindow(arr, nowMs) {
    const cutoff = nowMs - this._windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
  }

  /**
   * Зарегистрировать infra-фейл (proxy tunnel / warmup) для этого proxy_key.
   * @param {string|null|undefined} key
   * @returns {QuarantineEventResult}
   */
  recordInfra(key) {
    return this._record(key, this._infraEvents, this._infraThr, this._infraCdMs, "infra");
  }

  /**
   * Зарегистрировать 451-defer для этого proxy_key.
   * @param {string|null|undefined} key
   * @returns {QuarantineEventResult}
   */
  record451(key) {
    return this._record(key, this._451Events, this._451Thr, this._451CdMs, "451");
  }

  _record(rawKey, bucket, threshold, cooldownMs, reason) {
    const k = this._key(rawKey);
    const now = this._now();
    const arr = bucket.get(k) ?? [];
    arr.push(now);
    this._pruneWindow(arr, now);
    bucket.set(k, arr);
    const existing = this._cooldown.get(k);
    if (existing && existing.until > now) {
      return {
        entered: false,
        fails: arr.length,
        windowMs: this._windowMs,
        until: existing.until,
        reason: existing.reason,
      };
    }
    if (arr.length >= threshold) {
      const until = now + cooldownMs;
      this._cooldown.set(k, { until, reason });
      return {
        entered: true,
        fails: arr.length,
        windowMs: this._windowMs,
        until,
        reason,
      };
    }
    return {
      entered: false,
      fails: arr.length,
      windowMs: this._windowMs,
      until: null,
      reason,
    };
  }

  /** Любой успешный PDF чистит окна (cooldown остаётся — истекает по времени). */
  recordSuccess(key) {
    const k = this._key(key);
    this._infraEvents.delete(k);
    this._451Events.delete(k);
  }

  /** @returns {boolean} */
  isQuarantined(key) {
    const k = this._key(key);
    const c = this._cooldown.get(k);
    if (!c) return false;
    if (c.until <= this._now()) {
      this._cooldown.delete(k);
      return false;
    }
    return true;
  }

  /** @returns {number|null} */
  getQuarantineUntil(key) {
    const k = this._key(key);
    const c = this._cooldown.get(k);
    if (!c) return null;
    if (c.until <= this._now()) {
      this._cooldown.delete(k);
      return null;
    }
    return c.until;
  }

  /** @returns {"infra"|"451"|null} */
  getQuarantineReason(key) {
    const k = this._key(key);
    const c = this._cooldown.get(k);
    if (!c) return null;
    if (c.until <= this._now()) {
      this._cooldown.delete(k);
      return null;
    }
    return c.reason;
  }
}

export const __test__ = { _DEFAULTS };
