/**
 * RasProxyClient — обёртка над `@mobileproxy/sdk` под нужды ras_parser.
 *
 * Решает задачи, которые SDK сам по себе не решает:
 *
 *   1. **Rate-limit под лимиты провайдера**:
 *      · 1 одинаковый запрос (по сигнатуре `command+args`) не чаще
 *        чем раз в 5 сек (иначе провайдер шлёт
 *        "Too many lonely requests. Timeout 5 second").
 *      · 3 × N запросов в секунду суммарно, где N = число активных
 *        прокси (получаем из `getMyProxy()`). По дефолту считаем 1
 *        прокси (3 req/sec) до того, как доехали до резолва.
 *      · `changeIp` идёт через rotation endpoint, у которого по доке
 *        нет лимита частоты — но у нас всё равно есть hard-cooldown
 *        `minIpRotateGapSec`, чтобы не сжечь модем 10 ротациями подряд.
 *
 *   2. **Lazy-резолв `proxy_id`** по `proxy_key` через `getMyProxy()`.
 *      Заодно подтягиваем `_activeProxyCount`, чтобы потолок
 *      глобального rate-limit был корректным.
 *
 *   3. **Эскалации до смены оборудования**:
 *      · `changeOperator(reason)` — выбирает eid другого оператора
 *        в том же гео (если есть), иначе фоллбекается на «любую другую
 *        SIM», + `addToBlackList=1`, чтобы не вернуться на ту же SIM
 *        в следующий раз.
 *      · `changeGeo(reason)` — то же, но другое гео.
 *      · обе ждут реального переезда модема через `getTaskResult`
 *        (если провайдер вернул `tasks_id`), плюс короткий health-poll.
 *
 * Этот модуль НЕ парсит ras.arbitr.ru — он только общается с
 * провайдером прокси. Поэтому стелс-инвариант про `smartWait`
 * на него не распространяется (это «дедлайны на отказ» / лимиты
 * провайдера, а не имитация человека). Точные паузы — через
 * `node:timers/promises`, а не голый `setTimeout`.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import MobileProxyClient, { RateLimitError } from "@mobileproxy/sdk";

const monotonic = () => performance.now() / 1000;

const SAME_REQUEST_LOCKOUT_SEC = 5;
const SAME_REQUEST_GUARD_MS = 200;
const RATE_LIMIT_RETRY_BACKOFF_MS = 7_000;
const TASK_POLL_INTERVAL_SEC = 5;
const TASK_POLL_MAX_ATTEMPTS = 30;

export class RasProxyClient {
  /**
   * @param {object} cfg
   * @param {string} cfg.apiToken          — API token MobileProxy
   * @param {string} cfg.proxyKey          — proxy_key из дашборда (для changeIp + резолва proxy_id)
   * @param {number} [cfg.proxyId]         — если знаем заранее, не дёргаем getMyProxy
   * @param {number} [cfg.minIpRotateGapSec=300] — hard-cooldown между changeIp
   * @param {number} [cfg.minEquipmentSwapGapSec=600] — hard-cooldown между changeEquipment (L2/L3 общий нижний предел)
   * @param {number} [cfg.minGeoSwapGapSec=180] — дополнительно между двумя changeGeo (max с equipment-gap)
   * @param {number} [cfg.requestTimeoutMs=90000]
   * @param {(msg:string)=>void} [cfg.logger]
   */
  constructor({
    apiToken,
    proxyKey,
    proxyId = null,
    minIpRotateGapSec = 300,
    minEquipmentSwapGapSec = 600,
    minGeoSwapGapSec = 180,
    requestTimeoutMs = 90_000,
    logger = (m) => process.stdout.write(`${m}\n`),
  }) {
    if (!apiToken) throw new Error("RasProxyClient: apiToken is required");
    if (!proxyKey) throw new Error("RasProxyClient: proxyKey is required");

    this.sdk = new MobileProxyClient(apiToken, { timeout: requestTimeoutMs });
    this.proxyKey = proxyKey;
    this.minIpRotateGapSec = minIpRotateGapSec;
    this.minEquipmentSwapGapSec = minEquipmentSwapGapSec;
    this.minGeoSwapGapSec = Math.max(0, Number(minGeoSwapGapSec) || 0);
    this.log = logger;

    this._proxyId = proxyId !== null ? Number(proxyId) : null;
    this._activeProxyCount = 1;
    this._myInfoCache = null;
    this._myInfoCacheAt = -Infinity;

    this._lastSameRequestAt = new Map();
    this._globalCallTimes = [];
    this._lastIpRotateAt = -Infinity;
    this._lastEquipmentSwapAt = -Infinity;
    this._lastGeoSwapAt = -Infinity;
    /** @type {string | null} последний `new_ip`, возвращённый changeIp (для детекта «ротация без смены»). */
    this._lastRotateReportedIp = null;
  }

  /**
   * Сброс детекта дубликата `new_ip` (после перезапуска браузера / новой сессии).
   */
  resetReportedIpTracking() {
    this._lastRotateReportedIp = null;
  }

  // ───────────────────────── rate limit ─────────────────────────

  _signature(command, args) {
    return `${command}::${JSON.stringify(args ?? {})}`;
  }

  async _waitGlobalRate() {
    while (true) {
      const now = monotonic();
      while (this._globalCallTimes.length && now - this._globalCallTimes[0] > 1.0) {
        this._globalCallTimes.shift();
      }
      const cap = Math.max(3, 3 * this._activeProxyCount);
      if (this._globalCallTimes.length < cap) {
        this._globalCallTimes.push(now);
        return;
      }
      const waitMs = Math.max(50, Math.ceil((1.0 - (now - this._globalCallTimes[0])) * 1000));
      await sleep(waitMs);
    }
  }

  async _waitSameRequest(sig) {
    const last = this._lastSameRequestAt.get(sig);
    if (last !== undefined) {
      const since = monotonic() - last;
      if (since < SAME_REQUEST_LOCKOUT_SEC) {
        const waitMs =
          Math.ceil((SAME_REQUEST_LOCKOUT_SEC - since) * 1000) + SAME_REQUEST_GUARD_MS;
        const cmd = sig.split("::")[0];
        this.log(
          `[mp/rl] same-request '${cmd}' cooldown ${(waitMs / 1000).toFixed(1)}с`,
        );
        await sleep(waitMs);
      }
    }
    this._lastSameRequestAt.set(sig, monotonic());
  }

  async _call(command, args, fn) {
    const sig = this._signature(command, args);
    await this._waitSameRequest(sig);
    await this._waitGlobalRate();
    try {
      return await fn();
    } catch (e) {
      if (e instanceof RateLimitError) {
        this.log(
          `[mp/rl] провайдер вернул RateLimit ('${e.message}'), backoff ${RATE_LIMIT_RETRY_BACKOFF_MS}мс и retry`,
        );
        await sleep(RATE_LIMIT_RETRY_BACKOFF_MS);
        await this._waitGlobalRate();
        return await fn();
      }
      throw e;
    }
  }

  // ───────────────────────── мета ─────────────────────────

  async getActiveProxies({ force = false } = {}) {
    if (!force && this._myInfoCache && monotonic() - this._myInfoCacheAt < 30) {
      return this._myInfoCache;
    }
    const resp = await this._call("get_my_proxy", {}, () => this.sdk.getMyProxy());
    const arr = _extractProxyArray(resp);
    if (Array.isArray(arr) && arr.length) {
      this._activeProxyCount = arr.length;
      this._myInfoCache = arr;
      this._myInfoCacheAt = monotonic();
    }
    return arr;
  }

  async _resolveProxyId() {
    if (this._proxyId !== null && Number.isFinite(this._proxyId)) {
      if (this._myInfoCache === null) {
        this.getActiveProxies().catch(() => {});
      }
      return this._proxyId;
    }
    const arr = await this.getActiveProxies();
    if (!Array.isArray(arr) || !arr.length) {
      throw new Error("[mp] getMyProxy вернул пусто — нечего использовать");
    }
    const found = arr.find(
      (p) => String(p.proxy_key ?? p.key ?? "") === String(this.proxyKey),
    );
    const picked = found ?? arr[0];
    this._proxyId = Number(picked.proxy_id ?? picked.id ?? picked.proxyid);
    if (!Number.isFinite(this._proxyId)) {
      throw new Error(
        `[mp] не смог достать proxy_id из getMyProxy(): ${JSON.stringify(picked).slice(0, 200)}`,
      );
    }
    if (!found) {
      this.log(
        `[mp] не нашёл прокси по proxyKey='${this.proxyKey}', беру первый: proxy_id=${this._proxyId}`,
      );
    }
    this.log(
      `[mp] active proxies=${this._activeProxyCount}, proxy_id=${this._proxyId}`,
    );
    return this._proxyId;
  }

  async _getMyInfo() {
    const arr = await this.getActiveProxies();
    if (!Array.isArray(arr) || !arr.length) return null;
    const id = await this._resolveProxyId();
    return (
      arr.find((p) => Number(p.proxy_id ?? p.id ?? p.proxyid) === id) ?? null
    );
  }

  // ───────────────────────── ротация IP ─────────────────────────

  async rotateIp(reason = "") {
    const since = monotonic() - this._lastIpRotateAt;
    if (since < this.minIpRotateGapSec) {
      const waitMs = Math.ceil((this.minIpRotateGapSec - since) * 1000) + 100;
      this.log(`[mp/ip] hard-cooldown: жду ${(waitMs / 1000).toFixed(1)}с между ротациями`);
      await sleep(waitMs);
    }
    const suffix = reason ? ` (${reason})` : "";
    this.log(`[mp/ip] changeIp${suffix}...`);
    this._lastIpRotateAt = monotonic();
    let resp;
    try {
      resp = await this.sdk.changeIp(this.proxyKey);
    } catch (e) {
      this.log(`[mp/ip] SDK changeIp упал: ${e}`);
      return { ok: false, reason: `${e}`, raw: null, newIp: null, duplicateIp: false };
    }
    const status = resp?.status;
    const ok = status === undefined || status === null || status === "OK";
    if (!ok) {
      this.log(`[mp/ip] провайдер не-OK: ${JSON.stringify(resp).slice(0, 300)}`);
      return { ok, raw: resp, newIp: null, duplicateIp: false };
    }
    const newIpRaw = resp?.new_ip;
    const newIp =
      newIpRaw !== undefined && newIpRaw !== null && String(newIpRaw).trim()
        ? String(newIpRaw).trim()
        : "";
    let duplicateIp = false;
    if (newIp && this._lastRotateReportedIp && newIp === this._lastRotateReportedIp) {
      duplicateIp = true;
      this.log(
        `[mp/ip] ВНИМАНИЕ: new_ip=${newIp} совпадает с прошлой ротацией — egress, возможно, не сменился`,
      );
    }
    if (newIp) this._lastRotateReportedIp = newIp;
    this.log(`[mp/ip] OK new_ip=${resp?.new_ip ?? "?"} rt=${resp?.rt ?? "?"}`);
    return { ok, raw: resp, newIp: newIp || null, duplicateIp };
  }

  // ───────────────────────── оборудование ─────────────────────────

  async getAvailableEquipment() {
    const id = await this._resolveProxyId();
    return this._call("get_geo_operator_list", { proxy_id: id }, () =>
      this.sdk.getAvailableEquipment(id),
    );
  }

  async _runChangeEquipment(opts, reason, { isGeoSwap = false } = {}) {
    const now0 = monotonic();
    const sinceEquip = now0 - this._lastEquipmentSwapAt;
    const sinceGeo = now0 - this._lastGeoSwapAt;
    let waitSec = Math.max(0, this.minEquipmentSwapGapSec - sinceEquip);
    if (isGeoSwap && this.minGeoSwapGapSec > 0) {
      waitSec = Math.max(waitSec, this.minGeoSwapGapSec - sinceGeo);
    }
    if (waitSec > 0) {
      const waitMs = Math.ceil(waitSec * 1000) + 100;
      const what = isGeoSwap ? "оборудования/гео" : "оборудования";
      this.log(`[mp/eq] hard-cooldown: жду ${(waitMs / 1000).toFixed(1)}с между сменами ${what}`);
      await sleep(waitMs);
    }
    const id = await this._resolveProxyId();
    const callOpts = { addToBlackList: 1, ...opts };
    this.log(`[mp/eq] change_equipment(${reason}) opts=${JSON.stringify(callOpts)}`);
    const tSwap = monotonic();
    this._lastEquipmentSwapAt = tSwap;
    if (isGeoSwap) this._lastGeoSwapAt = tSwap;

    let resp;
    try {
      resp = await this._call(
        "change_equipment",
        { proxy_id: id, ...callOpts },
        () => this.sdk.changeEquipment(id, callOpts),
      );
    } catch (e) {
      this.log(`[mp/eq] change_equipment SDK ошибка: ${e}`);
      return { ok: false, reason: `${e}`, raw: null };
    }

    const taskId = resp?.tasks_id ?? resp?.task_id ?? null;
    if (taskId) {
      this.log(`[mp/eq] получили tasks_id=${taskId}, поллю до завершения`);
      const taskResult = await this._pollTask(Number(taskId));
      this._myInfoCache = null;
      return { ok: true, raw: resp, task: taskResult };
    }

    this.log(`[mp/eq] resp без tasks_id: ${JSON.stringify(resp).slice(0, 300)}`);
    this._myInfoCache = null;
    return { ok: true, raw: resp, task: null };
  }

  async _pollTask(taskId) {
    for (let i = 1; i <= TASK_POLL_MAX_ATTEMPTS; i += 1) {
      await sleep(TASK_POLL_INTERVAL_SEC * 1000 + 100);
      let res;
      try {
        res = await this._call(
          "tasks",
          { tasks_id: taskId },
          () => this.sdk.getTaskResult(taskId),
        );
      } catch (e) {
        this.log(`[mp/task ${taskId}] getTaskResult упал: ${e}`);
        continue;
      }
      const st = String(res?.status ?? res?.task_status ?? "").toLowerCase();
      const done = res?.done ?? res?.completed ?? null;
      this.log(
        `[mp/task ${taskId}] poll ${i}/${TASK_POLL_MAX_ATTEMPTS}: status=${st || "?"}, done=${done ?? "?"}`,
      );
      if (st === "ok" || st === "done" || st === "complete" || done === true || done === 1) {
        return res;
      }
      if (st === "error" || st === "failed") {
        this.log(
          `[mp/task ${taskId}] провайдер сообщил ошибку: ${JSON.stringify(res).slice(0, 300)}`,
        );
        return res;
      }
    }
    this.log(
      `[mp/task ${taskId}] не дождался завершения за ${
        TASK_POLL_MAX_ATTEMPTS * TASK_POLL_INTERVAL_SEC
      }с — иду дальше`,
    );
    return null;
  }

  /**
   * Сменить оборудование на ДРУГОГО оператора в том же гео.
   *
   * ВАЖНО: эта операция СТРОГО в текущем geo. Никаких слепых фоллбеков
   * на «любое другое eid». Если в текущем гео нет альтернативного
   * оператора — возвращаем `ok:false reason='no-same-geo-operator'`,
   * чтобы вышестоящий код мог решить, эскалироваться ли в L3 changeGeo
   * (а это уже платно у провайдера). Раньше тут был фоллбек, и он мог
   * молча увезти SIM в другой регион — теперь так нельзя.
   */
  async changeOperator(reason = "") {
    let avail;
    try {
      avail = await this.getAvailableEquipment();
    } catch (e) {
      this.log(
        `[mp/eq] getAvailableEquipment упал: ${e} — НЕ делаю слепой ` +
          `change_equipment (мог бы уехать в другой регион). reason=${reason}`,
      );
      return {
        ok: false,
        reason: `getAvailableEquipment failed: ${e}`,
        kind: "operator",
        raw: null,
      };
    }

    let currentOperator = null;
    let currentGeoId = null;
    try {
      const me = await this._getMyInfo();
      currentOperator = me?.operator ?? me?.proxy_operator ?? me?.operator_name ?? null;
      const g = me?.geoid ?? me?.geo_id ?? me?.id_geo ?? null;
      currentGeoId = g !== null ? Number(g) : null;
    } catch (e) {
      this.log(`[mp/eq] не вытащил текущего оператора/гео: ${e}`);
    }

    if (currentGeoId === null) {
      this.log(
        `[mp/eq] не знаю текущий geoid — НЕ делаю change_equipment без явного ` +
          `gegio-замка (риск платной смены региона). reason=${reason}`,
      );
      return {
        ok: false,
        reason: "unknown-current-geoid",
        kind: "operator",
        raw: null,
      };
    }

    const candidates = _extractEquipmentCandidates(avail, {
      excludeOperator: currentOperator,
      sameGeoId: currentGeoId,
    });
    if (!candidates.length) {
      this.log(
        `[mp/eq] нет альтернативного оператора в текущем гео (geoid=${currentGeoId}) — ` +
          `НЕ делаю слепой фоллбек на «любое другое eid» (мог бы уехать в платный ` +
          `другой регион). reason=${reason}. Возвращаю ok=false, пусть верхний слой ` +
          `решает, эскалироваться ли в changeGeo.`,
      );
      return {
        ok: false,
        reason: "no-same-geo-operator",
        kind: "operator",
        raw: null,
        currentGeoId,
        currentOperator,
      };
    }

    const pick = candidates[0];
    const opts = { checkAfterChange: 1 };
    if (pick.eid !== null && pick.eid !== undefined) opts.eid = pick.eid;
    if (pick.operator) opts.operator = pick.operator;
    // geoId-замок ОБЯЗАТЕЛЕН: явно говорим провайдеру «остаться в этом geo»,
    // даже если sameGeoId-фильтр выше дал нам нужного кандидата. Это
    // защита от того, что провайдер «оптимизирует» и подсунет другое eid
    // в другом регионе.
    opts.geoId = pick.geoid ?? currentGeoId;
    this.log(
      `[mp/eq] выбран оператор '${pick.operator ?? "?"}' ` +
        `(geoid=${opts.geoId}, eid=${pick.eid ?? "auto"}), ` +
        `reason=${reason}, было='${currentOperator ?? "?"}'`,
    );
    const r = await this._runChangeEquipment(opts, reason, { isGeoSwap: false });
    return { ...r, kind: "operator", operator: pick.operator, oldOperator: currentOperator };
  }

  /**
   * Сменить географию — взять eid в другом geoid.
   *
   * @param {string}  [reason]
   * @param {object}  [opts]
   * @param {object}  [opts.filters]                — ограничения на выбор гео
   * @param {number}  [opts.filters.requireCountryId]  — если задан, разрешён только id_country
   * @param {number[]}[opts.filters.excludeCountryIds] — id_country, которые запрещены
   * @param {RegExp}  [opts.filters.includeCaptionRegex] — whitelist regexp по geo_caption
   * @param {number[]}[opts.filters.excludeGeoIds]     — список geoid, которые не брать
   * @param {number[]}[opts.filters.excludeCityIds]    — список id_city, которые не брать
   * @param {RegExp}  [opts.filters.excludeCaptionRegex] — regexp по geo_caption (миллионники и т.п.)
   * @param {boolean} [opts.allowFallbackOperator=true] — если кандидатов 0,
   *        падать на `changeOperator()` (true) или возвращать `{ ok:false }` (false).
   */
  async changeGeo(reason = "", { filters = null, allowFallbackOperator = true } = {}) {
    let avail;
    try {
      avail = await this.getAvailableEquipment();
    } catch (e) {
      this.log(`[mp/eq] getAvailableEquipment упал: ${e} — фоллбек на смену оператора`);
      if (allowFallbackOperator) return await this.changeOperator(`fallback-from-geo: ${reason}`);
      return { ok: false, reason: `getAvailableEquipment failed: ${e}`, kind: "geo", raw: null };
    }

    let currentGeoId = null;
    try {
      const me = await this._getMyInfo();
      const g = me?.geoid ?? me?.geo_id ?? me?.id_geo ?? null;
      currentGeoId = g !== null ? Number(g) : null;
    } catch {}

    const allCandidates = _extractEquipmentCandidates(avail, {
      excludeGeoId: currentGeoId,
    });

    let candidates = allCandidates;
    if (filters) {
      candidates = candidates.filter((c) => {
        if (
          filters.requireCountryId !== undefined &&
          filters.requireCountryId !== null &&
          c.countryId !== null &&
          Number(c.countryId) !== Number(filters.requireCountryId)
        ) {
          return false;
        }
        if (Array.isArray(filters.excludeCountryIds) && filters.excludeCountryIds.length) {
          if (
            c.countryId !== null &&
            filters.excludeCountryIds.map(Number).includes(Number(c.countryId))
          ) {
            return false;
          }
        }
        if (filters.includeCaptionRegex instanceof RegExp) {
          const caption = c.caption ? String(c.caption) : "";
          if (!filters.includeCaptionRegex.test(caption)) return false;
        }
        if (Array.isArray(filters.excludeGeoIds) && filters.excludeGeoIds.length) {
          if (filters.excludeGeoIds.map(Number).includes(Number(c.geoid))) return false;
        }
        if (Array.isArray(filters.excludeCityIds) && filters.excludeCityIds.length) {
          if (
            c.cityId !== null &&
            filters.excludeCityIds.map(Number).includes(Number(c.cityId))
          ) {
            return false;
          }
        }
        if (filters.excludeCaptionRegex instanceof RegExp && c.caption) {
          if (filters.excludeCaptionRegex.test(c.caption)) return false;
        }
        return true;
      });
      this.log(
        `[mp/eq] geo-фильтр: ${allCandidates.length} -> ${candidates.length} ` +
          `(country=${filters.requireCountryId ?? "any"}, ` +
          `excludeCountries=${(filters.excludeCountryIds ?? []).join(",") || "-"}, ` +
          `includeRegex=${filters.includeCaptionRegex ? "yes" : "no"}, ` +
          `excludeCities=${(filters.excludeCityIds ?? []).join(",") || "-"}, ` +
          `regex=${filters.excludeCaptionRegex ? "yes" : "no"})`,
      );
    }

    if (candidates.length) {
      const pick = candidates[0];
      const opts = { checkAfterChange: 1 };
      if (pick.eid !== null && pick.eid !== undefined) opts.eid = pick.eid;
      if (pick.geoid) opts.geoId = pick.geoid;
      if (pick.operator) opts.operator = pick.operator;
      this.log(
        `[mp/eq] выбрано гео '${pick.caption ?? pick.geoid ?? "?"}' ` +
          `(geoid=${pick.geoid}, eid=${pick.eid ?? "auto"}, operator='${pick.operator ?? "?"}', ` +
          `country=${pick.countryId ?? "?"}), reason=${reason}, было geoid='${currentGeoId ?? "?"}'`,
      );
      const r = await this._runChangeEquipment(opts, reason, { isGeoSwap: true });
      return {
        ...r,
        kind: "geo",
        geoid: pick.geoid,
        caption: pick.caption ?? null,
        operator: pick.operator ?? null,
        oldGeoId: currentGeoId,
      };
    }

    if (filters) {
      this.log(
        "[mp/eq] под фильтр не подходит ни одно гео — НЕ делаю слепой changeOperator " +
          "(иначе вернёмся в Москву). Возвращаю ok=false.",
      );
      return {
        ok: false,
        reason: "no-allowed-geo",
        kind: "geo",
        oldGeoId: currentGeoId,
        raw: null,
      };
    }

    this.log("[mp/eq] нет альтернативного гео — фоллбек на смену оператора");
    if (allowFallbackOperator) return await this.changeOperator(`fallback-from-geo: ${reason}`);
    return { ok: false, reason: "no-alt-geo", kind: "geo", raw: null };
  }
}

function _extractProxyArray(resp) {
  if (Array.isArray(resp)) return resp;
  if (resp && typeof resp === "object") {
    if (Array.isArray(resp.list)) return resp.list;
    if (Array.isArray(resp.proxies)) return resp.proxies;
    if (Array.isArray(resp.data)) return resp.data;
    if (Array.isArray(resp.result)) return resp.result;
  }
  return [];
}

/**
 * Парсим ответ `get_geo_operator_list`. Реальная схема провайдера:
 *
 * ```
 * { status: "ok", geo_operator_list: {
 *     "<geoid>": {
 *       geoid, geo_caption, id_city, id_country,
 *       count_free: { "<operator>": "<count>", ... }
 *     }, ...
 * }}
 * ```
 *
 * Возвращаем «плоский» список кандидатов уровня (geoid, operator) с
 * метаданными `caption / cityId / countryId / count`. На всякий случай
 * рекурсия запасным путём ловит и старый формат с явным `eid` (если
 * провайдер вдруг такое отдаст в будущем).
 */
function _extractEquipmentCandidates(avail, filters = {}) {
  const out = [];

  const list = avail?.geo_operator_list;
  if (list && typeof list === "object" && !Array.isArray(list)) {
    for (const node of Object.values(list)) {
      if (!node || typeof node !== "object") continue;
      const geoid = node.geoid !== undefined ? Number(node.geoid) : null;
      const caption = node.geo_caption !== undefined ? String(node.geo_caption) : null;
      const cityId = node.id_city !== undefined ? Number(node.id_city) : null;
      const countryId = node.id_country !== undefined ? Number(node.id_country) : null;
      const cf = node.count_free;
      if (cf && typeof cf === "object") {
        for (const [op, cnt] of Object.entries(cf)) {
          out.push({
            eid: null,
            operator: op || null,
            geoid,
            caption,
            cityId,
            countryId,
            count: Number(cnt) || 0,
          });
        }
      } else {
        out.push({
          eid: null,
          operator: null,
          geoid,
          caption,
          cityId,
          countryId,
          count: 0,
        });
      }
    }
  }

  if (out.length === 0) {
    const visit = (node, geoid, operator, caption, cityId, countryId) => {
      if (node === null || node === undefined) return;
      if (Array.isArray(node)) {
        for (const x of node) visit(x, geoid, operator, caption, cityId, countryId);
        return;
      }
      if (typeof node !== "object") return;
      const here = {
        geoid:
          node.geoid !== undefined
            ? Number(node.geoid)
            : node.geo_id !== undefined
              ? Number(node.geo_id)
              : geoid,
        operator: node.operator !== undefined ? String(node.operator) : operator,
        caption: node.geo_caption !== undefined ? String(node.geo_caption) : caption,
        cityId: node.id_city !== undefined ? Number(node.id_city) : cityId,
        countryId:
          node.id_country !== undefined ? Number(node.id_country) : countryId,
      };
      if (node.eid !== undefined) {
        out.push({
          eid: Number(node.eid),
          operator: here.operator ?? null,
          geoid: here.geoid ?? null,
          caption: here.caption ?? null,
          cityId: here.cityId ?? null,
          countryId: here.countryId ?? null,
          count: node.count !== undefined ? Number(node.count) : 0,
        });
      }
      for (const v of Object.values(node)) {
        if (v && typeof v === "object")
          visit(v, here.geoid, here.operator, here.caption, here.cityId, here.countryId);
      }
    };
    visit(avail, null, null, null, null, null);
  }

  let filtered = out;
  if (filters.excludeOperator) {
    filtered = filtered.filter(
      (c) =>
        c.operator !== null &&
        String(c.operator).toLowerCase() !== String(filters.excludeOperator).toLowerCase(),
    );
  }
  if (filters.sameGeoId !== null && filters.sameGeoId !== undefined) {
    filtered = filtered.filter((c) => Number(c.geoid) === Number(filters.sameGeoId));
  }
  if (filters.excludeGeoId !== null && filters.excludeGeoId !== undefined) {
    filtered = filtered.filter(
      (c) => c.geoid !== null && Number(c.geoid) !== Number(filters.excludeGeoId),
    );
  }
  filtered = filtered.filter((c) => (Number(c.count) || 0) > 0 || c.eid !== null);
  filtered.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
  return filtered;
}

