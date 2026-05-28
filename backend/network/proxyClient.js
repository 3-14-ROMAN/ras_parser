/**
 * RasProxyClient — обёртка над `@mobileproxy/sdk`: rate-limit под лимиты провайдера,
 * lazy-резолв `proxy_id`, и три действия — `rotateIp`, `changeOperator`, `changeGeo`.
 * Cooldowns hard-enforced: changeIp ≥120с, changeEquipment ≥180с.
 */

import { setTimeout as sleep } from "node:timers/promises";
import { performance } from "node:perf_hooks";

import MobileProxyClient, { RateLimitError } from "@mobileproxy/sdk";

const monotonic = () => performance.now() / 1000;

/**
 * Безопасное человекочитаемое описание ошибки SDK. ApiError у `@mobileproxy/sdk`
 * сериализуется через `${e}` как `ApiError: [object Object]` — теряем `status`,
 * `body`, `data`, `response` и всю полезную инфу. Возвращаем плоскую строку
 * с тем, что удалось вытащить.
 */
export function describeError(e) {
  if (!e) return "unknown";
  if (typeof e === "string") return e;
  const parts = [];

  if (e.name) parts.push(String(e.name));
  if (e.message) parts.push(String(e.message));

  for (const k of ["code", "status", "statusCode", "httpCode"]) {
    if (e[k] !== undefined) parts.push(`${k}=${e[k]}`);
  }

  // @mobileproxy/sdk кладёт response JSON в `responseBody` (см. ApiError).
  for (const k of ["responseBody", "data", "body", "response", "raw", "cause"]) {
    if (e[k] !== undefined) {
      try {
        parts.push(`${k}=${JSON.stringify(e[k])}`);
      } catch {
        parts.push(`${k}=${String(e[k])}`);
      }
    }
  }

  try {
    const json = JSON.stringify(e);
    if (json && json !== "{}") parts.push(`json=${json}`);
  } catch {}

  return parts.length ? parts.join(" ") : String(e);
}

/**
 * Сериализация ошибки в plain-object для возврата в `rawError`. В отличие от
 * describeError возвращает структуру, чтобы upstream мог достать поля.
 */
export function safeSerializeError(e) {
  if (!e) return null;
  if (typeof e !== "object") return { value: String(e) };
  const out = {};
  for (const k of ["name", "message", "code", "status", "statusCode", "httpCode"]) {
    if (e[k] !== undefined) out[k] = e[k];
  }
  for (const k of ["responseBody", "data", "body", "response", "raw", "cause"]) {
    if (e[k] !== undefined) {
      try {
        JSON.stringify(e[k]);
        out[k] = e[k];
      } catch {
        out[k] = String(e[k]);
      }
    }
  }
  return out;
}

/**
 * Распознать MobileProxy-style error в response body: `{status:"err", error:{...}, message?:"..."}`.
 * По OpenAPI change_equipment может вернуть HTTP 200 с `status="err"` —
 * это API-ошибка провайдера (например, "FAIL equipment busy or unavailable"),
 * НЕ исключение и НЕ RAS/KAD ban.
 *
 * @param {any} resp response body
 * @param {number|string|null} proxyId — для извлечения `error[proxy_id]`
 * @returns {{ isErr: boolean, errText: string|null, kind: 'equipment_busy'|'mobileproxy_error'|null }}
 */
export function detectMpResponseError(resp, proxyId = null) {
  if (!resp || typeof resp !== "object") {
    return { isErr: false, errText: null, kind: null };
  }
  const status = String(resp.status ?? "").toLowerCase();
  const errObj = resp.error;
  let errText = null;
  if (errObj && typeof errObj === "object") {
    const pidKeys = proxyId != null ? [String(proxyId), Number(proxyId)] : [];
    for (const k of pidKeys) {
      if (Object.prototype.hasOwnProperty.call(errObj, k) && errObj[k] != null) {
        errText = String(errObj[k]);
        break;
      }
    }
    if (errText === null) {
      for (const v of Object.values(errObj)) {
        if (v != null && String(v).trim()) {
          errText = String(v);
          break;
        }
      }
    }
  } else if (typeof errObj === "string" && errObj.trim()) {
    errText = errObj;
  }
  if (!errText && resp.message && status === "err") {
    errText = String(resp.message);
  }
  const isErr = status === "err" || !!errText;
  if (!isErr) return { isErr: false, errText: null, kind: null };
  const lc = String(errText ?? "").toLowerCase();
  let kind = "mobileproxy_error";
  if (
    lc.includes("equipment busy") ||
    lc.includes("equipment unavailable") ||
    lc.includes("busy or unavailable")
  ) {
    kind = "equipment_busy";
  } else if (lc.includes("unavailable")) {
    kind = "equipment_busy";
  }
  return { isErr, errText: errText ?? "mobileproxy_error", kind };
}

/**
 * Достать MobileProxy-style `{status:"err", error:{<proxy_id>:"..."}}` из
 * исключения SDK. SDK кидает ApiError(msg, httpCode, responseBody) для
 * любого `json.error` (см. node_modules/@mobileproxy/sdk/src/http-client.js).
 * Body — это `responseBody`; иногда дублируется в `data`. Нормализуем.
 */
export function detectMpResponseErrorFromException(e, proxyId = null) {
  if (!e || typeof e !== "object") return { isErr: false, errText: null, kind: null };
  const candidates = [e.responseBody, e.data, e.body, e.response, e.raw];
  for (const body of candidates) {
    if (!body) continue;
    const r = detectMpResponseError(body, proxyId);
    if (r.isErr) return r;
  }
  // ApiError.message может содержать `[object Object]` либо сериализованный
  // объект — пробуем разобрать.
  const msg = String(e.message ?? "").toLowerCase();
  if (msg.includes("equipment busy") || msg.includes("busy or unavailable")) {
    return { isErr: true, errText: e.message, kind: "equipment_busy" };
  }
  return { isErr: false, errText: null, kind: null };
}

function _envBool(name, def) {
  const v = process.env[name];
  if (v === undefined || v === null || v === "") return def;
  const s = String(v).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return def;
}

/**
 * Передавать ли `add_to_black_list=1` при `change_equipment`. По умолчанию НЕТ:
 * provider-side blacklist у MobileProxy и наш локальный `BadGeoBlacklist` —
 * разные вещи. RAS/KAD-recovery не должен засорять provider blacklist.
 * Включить можно через `RAS_MP_ADD_TO_BLACKLIST_ON_CHANGE_GEO=1`.
 */
const ADD_TO_BLACKLIST_DEFAULT = _envBool(
  "RAS_MP_ADD_TO_BLACKLIST_ON_CHANGE_GEO",
  false,
);

const SAME_REQUEST_LOCKOUT_SEC = 5;
const SAME_REQUEST_GUARD_MS = 200;
const RATE_LIMIT_RETRY_BACKOFF_MS = 7_000;
const TASK_POLL_INTERVAL_SEC = 5;
const TASK_POLL_MAX_ATTEMPTS = 30;

export class RasProxyClient {
  constructor({
    apiToken,
    proxyKey,
    proxyId = null,
    minIpRotateGapSec = 120,
    minEquipmentSwapGapSec = 180,
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

  /** Числовой proxy_id этого клиента (для сверки с `checked` в ответах changeEquipment). */
  async getResolvedProxyId() {
    return this._resolveProxyId();
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

  /**
   * @param {string} reason — для логов.
   * @param {{ skipCooldown?: boolean }} [opts]
   *   skipCooldown=true → не ждём `minIpRotateGapSec` перед вызовом API.
   *   Используется PDF bad-geo recovery'ем: внутри recovery нам нужно
   *   попробовать rotateIp ×N с короткой паузой `RAS_PDF_ROTATE_IP_SLEEP_MS=4000`,
   *   а 120с между вызовами тут — наш собственный safety, не лимит провайдера.
   *   Escalator (network/escalator.js) НЕ должен передавать skipCooldown —
   *   ему нужна защита от частых rotateIp по сети.
   *   `_lastIpRotateAt` обновляется в любом случае — чтобы escalator после
   *   серии recovery-ротаций всё ещё видел реальную историю.
   */
  async rotateIp(reason = "", opts = {}) {
    const { skipCooldown = false } = opts;
    const since = monotonic() - this._lastIpRotateAt;
    if (since < this.minIpRotateGapSec) {
      if (skipCooldown) {
        this.log(
          `[mp/ip] skip hard-cooldown (since=${since.toFixed(1)}с < ${this.minIpRotateGapSec}с, ` +
            `reason=${reason || "?"})`,
        );
      } else {
        const waitMs = Math.ceil((this.minIpRotateGapSec - since) * 1000) + 100;
        this.log(`[mp/ip] hard-cooldown: жду ${(waitMs / 1000).toFixed(1)}с между ротациями`);
        await sleep(waitMs);
      }
    }
    const suffix = reason ? ` (${reason})` : "";
    this.log(`[mp/ip] changeIp${suffix}...`);
    this._lastIpRotateAt = monotonic();
    let resp;
    try {
      resp = await this.sdk.changeIp(this.proxyKey);
    } catch (e) {
      const errText = describeError(e);
      this.log(`[mp/ip] SDK changeIp упал: ${errText}`);
      return {
        ok: false,
        reason: errText,
        raw: null,
        newIp: null,
        duplicateIp: false,
        rawError: safeSerializeError(e),
      };
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

  /**
   * Provider-side blacklist (equipment + operators). По OpenAPI:
   *   GET /api.html?command=get_black_list&proxy_id=...
   * Возвращает `{black_list, black_list_operators}` (точные имена ключей —
   * у разных аккаунтов отличаются, ниже резолвим best-effort).
   */
  async getProviderBlacklist() {
    const id = await this._resolveProxyId();
    let resp;
    try {
      resp = await this._call("get_black_list", { proxy_id: id }, () =>
        this.sdk.getBlackList(id),
      );
    } catch (e) {
      const errText = describeError(e);
      this.log(`[mp/blacklist] get_black_list упал: ${errText}`);
      return { ok: false, reason: errText, raw: null, equipment: [], operators: [] };
    }
    const equipment = _extractBlacklistEquipment(resp);
    const operators = _extractBlacklistOperators(resp);
    return { ok: true, raw: resp, equipment, operators };
  }

  /**
   * Очистить provider-side blacklist (equipment + operators). По умолчанию
   * НЕ вызывать — это «ядерная» операция, после неё провайдер может снова
   * подсунуть только что сожжённое оборудование. Только в ответ на явный
   * `RAS_MP_CLEAR_PROVIDER_BLACKLIST_ON_START=1`.
   */
  async clearProviderBlacklist() {
    const id = await this._resolveProxyId();
    const result = { equipmentRemoved: 0, operatorsRemoved: 0, errors: [] };
    let snapshot;
    try {
      snapshot = await this.getProviderBlacklist();
    } catch (e) {
      result.errors.push(`snapshot: ${describeError(e)}`);
      return result;
    }
    if (!snapshot.ok) {
      result.errors.push(`snapshot: ${snapshot.reason}`);
      return result;
    }
    for (const entry of snapshot.equipment) {
      try {
        await this._call(
          "remove_black_list",
          { proxy_id: id, black_list_id: entry.blackListId ?? null, eid: entry.eid ?? null },
          () =>
            this.sdk.removeFromBlackList(
              id,
              entry.blackListId ?? 0,
              entry.eid ?? 0,
            ),
        );
        result.equipmentRemoved += 1;
      } catch (e) {
        result.errors.push(`equipment ${entry.eid ?? "?"}: ${describeError(e)}`);
      }
    }
    for (const op of snapshot.operators) {
      if (op.operatorId == null) continue;
      try {
        await this._call(
          "remove_operator_black_list",
          { proxy_id: id, operator_id: op.operatorId },
          () => this.sdk.removeOperatorFromBlackList(id, op.operatorId),
        );
        result.operatorsRemoved += 1;
      } catch (e) {
        result.errors.push(`op ${op.operatorId}: ${describeError(e)}`);
      }
    }
    this._myInfoCache = null;
    return result;
  }

  async _runChangeEquipment(
    opts,
    reason,
    { isGeoSwap = false, addToBlackList = ADD_TO_BLACKLIST_DEFAULT } = {},
  ) {
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
    // По OpenAPI MobileProxy:
    //  - add_to_black_list — добавить ТЕКУЩЕЕ оборудование в provider-side
    //    blacklist перед сменой. У нас RAS/KAD-recovery, мы НЕ хотим засорять
    //    провайдерский blacklist на каждом changeGeo. Default = false. Можно
    //    включить через RAS_MP_ADD_TO_BLACKLIST_ON_CHANGE_GEO=1.
    //  - check_after_change / check_spam — лёгкие проверки, оставляем как есть.
    const callOpts = {
      ...opts,
      addToBlackList: addToBlackList ? 1 : 0,
      checkAfterChange: true,
      checkSpam: true,
    };
    this.log(`[mp/eq] change_equipment(${reason}) opts=${JSON.stringify(callOpts)}`);

    // Cooldown timestamp ставим ТОЛЬКО на success — change_equipment, который
    // вернул status:"err" / equipment_busy / ApiError, на стороне провайдера
    // ничего не сменил, значит hard-cooldown 175с ждать бессмысленно. Иначе
    // recover-loop крутится по кругу: failed attempt → 175с пауза → следующий
    // failed attempt → ещё 175с, и так до бесконечности.
    let resp;
    try {
      resp = await this._call(
        "change_equipment",
        { proxy_id: id, ...callOpts },
        () => this.sdk.changeEquipment(id, callOpts),
      );
    } catch (e) {
      // SDK кидает ApiError, когда `json.error` truthy — это в т.ч. наш
      // "FAIL equipment busy or unavailable". Достаём `responseBody` и
      // возвращаем чистый reason="equipment_busy" вместо ApiError JSON.
      const mpErr = detectMpResponseErrorFromException(e, id);
      if (mpErr.isErr) {
        const reasonText =
          mpErr.kind === "equipment_busy"
            ? "equipment_busy"
            : `mobileproxy_error:${String(mpErr.errText).slice(0, 120)}`;
        this.log(
          `[mp/eq] change_equipment провайдер вернул status=err через ApiError ` +
            `(${mpErr.kind}): "${String(mpErr.errText).slice(0, 200)}"`,
        );
        this.log(
          `[mp/eq] equipment_busy — no equipment change happened, cooldown not started`,
        );
        return {
          ok: false,
          reason: reasonText,
          mpErrorKind: mpErr.kind,
          mpErrorText: mpErr.errText,
          raw: e?.responseBody ?? null,
          rawError: safeSerializeError(e),
        };
      }
      const errText = describeError(e);
      this.log(`[mp/eq] change_equipment SDK ошибка: ${errText}`);
      this.log(
        `[mp/eq] sdk_error — no equipment change happened, cooldown not started`,
      );
      return {
        ok: false,
        reason: errText,
        raw: null,
        rawError: safeSerializeError(e),
      };
    }

    // По OpenAPI MobileProxy change_equipment может вернуть HTTP 200 с
    // `status:"err"` и `error[proxy_id]="FAIL equipment busy or unavailable"`.
    // Это API-ошибка провайдера, не исключение — раньше она проскакивала как
    // успех и upstream дальше ждал нового IP, которого не будет.
    const mpErr = detectMpResponseError(resp, id);
    if (mpErr.isErr) {
      const reasonText = mpErr.kind === "equipment_busy"
        ? "equipment_busy"
        : `mobileproxy_error:${String(mpErr.errText).slice(0, 120)}`;
      this.log(
        `[mp/eq] change_equipment провайдер вернул status=err ` +
          `(${mpErr.kind}): "${String(mpErr.errText).slice(0, 200)}"`,
      );
      this.log(
        `[mp/eq] equipment_busy — no equipment change happened, cooldown not started`,
      );
      return {
        ok: false,
        reason: reasonText,
        mpErrorKind: mpErr.kind,
        mpErrorText: mpErr.errText,
        raw: resp,
      };
    }

    // Реально успешный change_equipment: ТЕПЕРЬ ставим cooldown, чтобы
    // следующий вызов соблюдал minEquipmentSwapGapSec / minGeoSwapGapSec.
    const tSwap = monotonic();
    this._lastEquipmentSwapAt = tSwap;
    if (isGeoSwap) this._lastGeoSwapAt = tSwap;

    // По спеке: `checked` из change_equipment — только подсказка для логов.
    // Финальным IP его НЕ считаем; реальный успех определяется upstream
    // (measure egress IPv4 + probe ras/kad). Возвращаем ok=true даже при
    // checked=false, чтобы _recoverByGeoLoop сам решал по measured/probe.
    const checkedFalseImmediate = _equipmentCheckedFalseForProxy(resp, id);
    if (checkedFalseImmediate) {
      this.log(
        `[mp/eq] checked[${id}]=false после change_equipment — hint only, ` +
          `upstream проверит через measure+probe`,
      );
    }

    const taskId = resp?.tasks_id ?? resp?.task_id ?? null;
    if (taskId) {
      this.log(`[mp/eq] получили tasks_id=${taskId}, поллю до завершения`);
      const taskResult = await this._pollTask(Number(taskId));
      const checkedFalseTask =
        !!taskResult && _equipmentCheckedFalseForProxy(taskResult, id);
      if (checkedFalseTask) {
        this.log(
          `[mp/eq] checked[${id}]=false в task result — hint only, ` +
            `upstream проверит через measure+probe`,
        );
      }
      this._myInfoCache = null;
      return {
        ok: true,
        raw: resp,
        task: taskResult,
        checkedFalse: checkedFalseImmediate || checkedFalseTask,
      };
    }

    this.log(`[mp/eq] resp без tasks_id: ${JSON.stringify(resp).slice(0, 300)}`);
    this._myInfoCache = null;
    return { ok: true, raw: resp, task: null, checkedFalse: checkedFalseImmediate };
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
        this.log(`[mp/task ${taskId}] getTaskResult упал: ${describeError(e)}`);
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

  /** Сменить SIM/оператора в текущем geo. Если нет альтернатив — вернёт ok=false → переход на L3. */
  async changeOperator(reason = "", { addToBlackList = ADD_TO_BLACKLIST_DEFAULT } = {}) {
    let avail;
    try {
      avail = await this.getAvailableEquipment();
    } catch (e) {
      const errText = describeError(e);
      this.log(`[mp/eq] getAvailableEquipment упал: ${errText}; reason=${reason}`);
      return {
        ok: false,
        reason: `getAvailableEquipment failed: ${errText}`,
        kind: "operator",
        raw: null,
        rawError: safeSerializeError(e),
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
      this.log(`[mp/eq] не вытащил текущего оператора/гео: ${describeError(e)}`);
    }

    if (currentGeoId === null) {
      this.log(
        `[mp/eq] не знаю текущий geoid — пропускаю changeOperator (нужен geo-замок). ` +
          `reason=${reason}`,
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
        `[mp/eq] нет альтернативного оператора в текущем гео (geoid=${currentGeoId}); ` +
          `reason=${reason}. Возвращаю ok=false, верхний слой пойдёт в changeGeo.`,
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
    const opts = {};
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
    const r = await this._runChangeEquipment(opts, reason, {
      isGeoSwap: false,
      addToBlackList,
    });
    return { ...r, kind: "operator", operator: pick.operator, oldOperator: currentOperator };
  }

  /** Сменить регион. `filters` (см. config.js GEO_FILTERS) могут отсечь нежелательные гео. */
  async changeGeo(
    reason = "",
    {
      filters = null,
      allowFallbackOperator = true,
      addToBlackList = ADD_TO_BLACKLIST_DEFAULT,
    } = {},
  ) {
    let avail;
    try {
      avail = await this.getAvailableEquipment();
    } catch (e) {
      const errText = describeError(e);
      this.log(`[mp/eq] getAvailableEquipment упал: ${errText} — фоллбек на смену оператора`);
      if (allowFallbackOperator) return await this.changeOperator(`fallback-from-geo: ${reason}`);
      return {
        ok: false,
        reason: `getAvailableEquipment failed: ${errText}`,
        kind: "geo",
        raw: null,
        rawError: safeSerializeError(e),
      };
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
    // По OpenAPI get_geo_operator_list[].count_free — {operator: count_free}.
    // Кандидата валиден только если count_free > 0; ниже логируем head'ы для
    // диагностики, когда после фильтров вдруг 0.
    const top = allCandidates
      .slice(0, 5)
      .map(
        (c) =>
          `country=${c.countryId ?? "?"}/geo=${c.geoid ?? "?"}/op=${c.operator ?? "?"}/cnt=${c.count ?? 0}`,
      )
      .join(", ");
    this.log(
      `[mp/eq] candidates after count_free>0: ${allCandidates.length}` +
        (allCandidates.length ? `; top=[${top}]` : ""),
    );

    let candidates = allCandidates;
    if (filters) {
      const allowCountries =
        Array.isArray(filters.requireCountryIds) && filters.requireCountryIds.length
          ? filters.requireCountryIds.map(Number).filter((n) => Number.isFinite(n))
          : null;
      candidates = candidates.filter((c) => {
        if (allowCountries && allowCountries.length) {
          if (c.countryId === null || !allowCountries.includes(Number(c.countryId))) return false;
        } else if (
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
        if (
          Array.isArray(filters.excludeOperators) &&
          filters.excludeOperators.length &&
          c.operator
        ) {
          const op = String(c.operator).toLowerCase().trim();
          const banned = filters.excludeOperators
            .map((s) => (s == null ? "" : String(s).toLowerCase().trim()))
            .filter(Boolean);
          if (banned.includes(op)) return false;
        }
        return true;
      });
      const countryLog =
        allowCountries && allowCountries.length
          ? `countries=[${allowCountries.join(",")}]`
          : `country=${filters.requireCountryId ?? "any"}`;
      this.log(
        `[mp/eq] geo-фильтр: ${allCandidates.length} -> ${candidates.length} ` +
          `(${countryLog}, ` +
          `excludeCountries=${(filters.excludeCountryIds ?? []).join(",") || "-"}, ` +
          `includeRegex=${filters.includeCaptionRegex ? "yes" : "no"}, ` +
          `excludeCities=${(filters.excludeCityIds ?? []).join(",") || "-"}, ` +
          `excludeGeoIds=${(filters.excludeGeoIds ?? []).join(",") || "-"}, ` +
          `excludeOps=${(filters.excludeOperators ?? []).join(",") || "-"}, ` +
          `regex=${filters.excludeCaptionRegex ? "yes" : "no"})`,
      );
    }

    if (candidates.length) {
      const pick = candidates[0];
      const opts = {};
      if (pick.eid !== null && pick.eid !== undefined) opts.eid = pick.eid;
      if (pick.geoid) opts.geoId = pick.geoid;
      if (pick.operator) opts.operator = pick.operator;
      this.log(
        `[mp/eq] выбрано гео '${pick.caption ?? pick.geoid ?? "?"}' ` +
          `(geoid=${pick.geoid}, eid=${pick.eid ?? "auto"}, operator='${pick.operator ?? "?"}', ` +
          `country=${pick.countryId ?? "?"}), reason=${reason}, было geoid='${currentGeoId ?? "?"}'`,
      );
      const r = await this._runChangeEquipment(opts, reason, {
        isGeoSwap: true,
        addToBlackList,
      });
      // Кандидата возвращаем ВСЕГДА — даже при r.ok=false, чтобы upstream
      // (pdf/downloader._recoverByGeoLoop) мог сделать markBad на сожжённом
      // candidate'е и в следующем раунде отфильтровать его через
      // excludeGeoIds/excludeOperators.
      return {
        ...r,
        kind: "geo",
        geoid: pick.geoid,
        caption: pick.caption ?? null,
        operator: pick.operator ?? null,
        countryId: pick.countryId ?? null,
        candidate: pick,
        oldGeoId: currentGeoId,
      };
    }

    if (filters) {
      this.log(`[mp/eq] под фильтр не подходит ни одно гео — ok=false, reason=${reason}`);
      return { ok: false, reason: "no-allowed-geo", kind: "geo", oldGeoId: currentGeoId, raw: null };
    }
    this.log("[mp/eq] нет альтернативного гео — фоллбек на смену оператора");
    if (allowFallbackOperator) return await this.changeOperator(`fallback-from-geo: ${reason}`);
    return { ok: false, reason: "no-alt-geo", kind: "geo", raw: null };
  }
}

/** `checked[proxy_id] === false` в ответе change_equipment / task — смена не подтверждена. */
function _equipmentCheckedFalseForProxy(respLike, proxyId) {
  const idNum = Number(proxyId);
  if (!Number.isFinite(idNum)) return false;
  const keys = [String(idNum), idNum];
  if (!respLike || typeof respLike !== "object") return false;
  const c = respLike.checked;
  if (!c || typeof c !== "object" || Array.isArray(c)) return false;
  for (const k of keys) {
    if (Object.prototype.hasOwnProperty.call(c, k) && c[k] === false) return true;
  }
  return false;
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

/** Плоский список кандидатов (geoid, operator) из `geo_operator_list` провайдера. */
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
  // По OpenAPI count_free — это object {operator: count}; candidate валиден
  // только если count > 0 (или у нас есть прямой eid из fallback-visit).
  filtered = filtered.filter((c) => (Number(c.count) || 0) > 0 || c.eid !== null);
  filtered.sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0));
  return filtered;
}

/**
 * Извлечь записи equipment blacklist из ответа `get_black_list`. Имена ключей
 * у MobileProxy в разных версиях отличаются — пробуем несколько вариантов.
 */
function _extractBlacklistEquipment(resp) {
  if (!resp || typeof resp !== "object") return [];
  const candidates = [
    resp.black_list,
    resp.blacklist,
    resp.equipment_black_list,
    resp.list,
    resp.data?.black_list,
  ];
  const out = [];
  for (const c of candidates) {
    if (!c) continue;
    const iter = Array.isArray(c) ? c : typeof c === "object" ? Object.values(c) : null;
    if (!iter) continue;
    for (const item of iter) {
      if (!item || typeof item !== "object") continue;
      out.push({
        blackListId:
          item.black_list_id ?? item.id ?? item.blacklist_id ?? null,
        eid: item.eid ?? item.equipment_id ?? null,
        operator: item.operator ?? item.operator_name ?? null,
        geoid: item.geoid ?? item.geo_id ?? null,
        caption: item.geo_caption ?? item.caption ?? null,
      });
    }
    if (out.length) break;
  }
  return out;
}

function _extractBlacklistOperators(resp) {
  if (!resp || typeof resp !== "object") return [];
  const candidates = [
    resp.black_list_operators,
    resp.blacklist_operators,
    resp.operator_black_list,
    resp.operators,
  ];
  const out = [];
  for (const c of candidates) {
    if (!c) continue;
    const iter = Array.isArray(c) ? c : typeof c === "object" ? Object.values(c) : null;
    if (!iter) continue;
    for (const item of iter) {
      if (typeof item === "string") {
        out.push({ operatorId: null, operator: item });
        continue;
      }
      if (!item || typeof item !== "object") continue;
      out.push({
        operatorId: item.operator_id ?? item.id ?? null,
        operator: item.operator ?? item.operator_name ?? null,
      });
    }
    if (out.length) break;
  }
  return out;
}

export const __test__ = {
  _extractEquipmentCandidates,
  _extractBlacklistEquipment,
  _extractBlacklistOperators,
  detectMpResponseError,
  detectMpResponseErrorFromException,
  describeError,
  safeSerializeError,
  ADD_TO_BLACKLIST_DEFAULT,
};

