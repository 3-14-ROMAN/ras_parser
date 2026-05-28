/**
 * Конфиг ras_parser. Все чувствительные значения — только из env
 * (см. `.env.example`). Секретов в коде быть не должно.
 * Запускать с `node --env-file=.env parser.js` либо экспортировать
 * переменные окружения вручную.
 */

export const PROXY_SERVER = process.env.MP_PROXY_SERVER ?? "http://mproxy.site:12695";
export const PROXY_USER = process.env.MP_PROXY_USER ?? "";
export const PROXY_PASS = process.env.MP_PROXY_PASS ?? "";

export const MP_API_TOKEN = process.env.MP_API_TOKEN ?? "";

export const MP_PROXY_KEY = process.env.MP_PROXY_KEY ?? "";

export const MP_PROXY_ID = process.env.MP_PROXY_ID
  ? Number(process.env.MP_PROXY_ID)
  : null;

// Cooldowns — единственное реальное ограничение провайдера MobileProxy.Space.
// Сами действия (changeIp/changeEquipment/changeGeo) бесплатные.
export const CHANGE_IP_COOLDOWN_SEC = Number(
  process.env.MP_CHANGE_IP_COOLDOWN_SEC ?? 120,
);
export const CHANGE_GEO_COOLDOWN_SEC = Number(
  process.env.MP_CHANGE_GEO_COOLDOWN_SEC ?? 180,
);
export const ESC_EQUIPMENT_COOLDOWN_SEC = Number(
  process.env.ESC_EQUIPMENT_COOLDOWN_SEC ?? 180,
);

// changeIp подряд до перехода на L2 (changeOperator).
export const ESC_MAX_IP_BEFORE_EQUIPMENT = Number(
  process.env.ESC_MAX_IP_BEFORE_EQUIPMENT ?? 3,
);
// changeOperator подряд до перехода на L3 (changeGeo).
export const ESC_MAX_OPERATOR_BEFORE_GEO = Number(
  process.env.ESC_MAX_OPERATOR_BEFORE_GEO ?? 2,
);

/**
 * Адаптивное дробление окна по latency (Query Downgrade + Circuit Breaker).
 *
 * Если один POST `/Search` отвечает дольше `SLOW_RESPONSE_THRESHOLD_MS`,
 * считаем, что пул прокси разогрет и сайт уже начал нас троттлить:
 * прерываем оставшуюся пагинацию, дробим текущее окно дат на
 * `WINDOW_SPLIT_FACTOR` подокон и ротейтим IP — следующий запрос
 * уйдёт уже более лёгкий, до того как RAS успеет накинуть нам 451.
 *
 *   - SLOW_RESPONSE_THRESHOLD_MS=0 — фича отключена, latency игнорируется.
 *   - WINDOW_MIN_DAYS — нижняя граница дробления; на этой длине
 *     вместо split'а только `_recoverFrom` и retry.
 */
export const SLOW_RESPONSE_THRESHOLD_MS = Number(
  process.env.RAS_SLOW_RESPONSE_THRESHOLD_MS ?? 5000,
);
export const WINDOW_SPLIT_FACTOR = Math.max(
  2,
  Number(process.env.RAS_WINDOW_SPLIT_FACTOR ?? 2),
);
export const WINDOW_MIN_DAYS = Math.max(
  1,
  Number(process.env.RAS_WINDOW_MIN_DAYS ?? 1),
);

/**
 * Geo-фильтры для эскалатора (ProxyEscalator → RasProxyClient.changeGeo).
 *
 * Работают при штатной L3 changeGeo.
 * Текущая политика (2026-05-15 после probe-geo): СТРОГО Казахстан / Беларусь /
 * Киргизия. РФ-мегафон и UA-Kyivstar → 451 на pravocaptcha даже с чистого IP,
 * KZ tele2 → 9/10 OK. Остальная СНГ (UZ/GE/AM/AZ/TJ/MD) — не проверена,
 * по умолчанию НЕ берём, чтобы не нарваться на тот же 451.
 *
 * - GEO_RU_ONLY=1     — берём только id_country=1 (Россия).
 * - GEO_BLOCK_CITY_IDS — список id_city через запятую. По дефолту
 *   1 (Москва) и 173 (Санкт-Петербург).
 * - GEO_BLOCK_CAPTION_REGEX — regexp по `geo_caption`. По дефолту
 *   режем все российские миллионники по подстроке (включая случаи
 *   "Томск, Новосибирск, Кемерово #1" — Новосибирск в строке → отвал).
 *
 * Если хочешь разрешить какой-то город — выкини его из обоих списков
 * либо проще: переопредели GEO_BLOCK_CAPTION_REGEX в .env на свою.
 */
export const GEO_RU_ONLY = (process.env.GEO_RU_ONLY ?? "0") === "1";
export const GEO_CIS_ONLY = (process.env.GEO_CIS_ONLY ?? "1") === "1";
// По умолчанию режем РФ (id=1) и Украину (id=2) — оба дают 451 на pravocaptcha.
const _DEFAULT_EXCLUDE_COUNTRY_IDS = [1, 2];
export const GEO_EXCLUDE_COUNTRY_IDS = (process.env.GEO_EXCLUDE_COUNTRY_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (GEO_EXCLUDE_COUNTRY_IDS.length === 0) {
  GEO_EXCLUDE_COUNTRY_IDS.push(..._DEFAULT_EXCLUDE_COUNTRY_IDS);
}
export const GEO_CIS_CAPTION_REGEX = (() => {
  if (!GEO_CIS_ONLY) return null;
  // Whitelist КЗ/БЛ/КГ. Если расширяешь до UZ/GE/AM/AZ/TJ/MD — переопредели
  // GEO_CIS_CAPTION_REGEX в .env на свою (и не забудь убрать страну из
  // GEO_EXCLUDE_COUNTRY_IDS, если она там).
  const src =
    process.env.GEO_CIS_CAPTION_REGEX ??
    "(?:Беларус|Казахстан|Киргиз|Кыргыз|Kazakhstan|Kyrgyz|Kyrgyzstan|Belarus)";
  if (!src) return null;
  try {
    return new RegExp(src, "iu");
  } catch (e) {
    process.stdout.write(
      `[config] GEO_CIS_CAPTION_REGEX невалидный regexp '${src}': ${e} — фильтр выключен\n`,
    );
    return null;
  }
})();

const _DEFAULT_BLOCK_CITY_IDS = [1, 173];
export const GEO_BLOCK_CITY_IDS = (process.env.GEO_BLOCK_CITY_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (GEO_BLOCK_CITY_IDS.length === 0) GEO_BLOCK_CITY_IDS.push(..._DEFAULT_BLOCK_CITY_IDS);

// Substring-match (без \b — JS-овые word-границы не работают на кириллице).
// Резаются:
//   - Москва (любое склонение / в любом контексте: «Москва, Видное», «Россия, Москва, Люблино»)
//   - подмосковные пригороды, которые у провайдера сидят в едином «московском»
//     антифрод-кластере (именно на одном из них — Подольске — и стоял ACL)
//   - СПб
//   - российские миллионники + Краснодар
const _DEFAULT_BLOCK_CAPTION_RE =
  "(?:Москва|Москов|МО,|МО #|Подольск|Люберц|Домодедово|Видное|Щербинк|" +
  "Балаших|Мытищ|Реутов|Химк|Одинцов|Долгопрудн|Котельник|Зеленоград|" +
  "Санкт[-\\s]?Петербург|С[\\.-]?Петербург|Питер|Ленинградск|" +
  "Новосибирск|Екатеринбург|Казан|Нижний\\s*Новгород|Самар|Челябинск|" +
  "Омск|Ростов|Уфа|Красноярск|Воронеж|Пермь|Волгоград|Краснодар)";

export const GEO_BLOCK_CAPTION_REGEX = (() => {
  const src = process.env.GEO_BLOCK_CAPTION_REGEX ?? _DEFAULT_BLOCK_CAPTION_RE;
  if (!src) return null;
  try {
    return new RegExp(src, "iu");
  } catch (e) {
    process.stdout.write(
      `[config] GEO_BLOCK_CAPTION_REGEX невалидный regexp '${src}': ${e} — фильтр выключен\n`,
    );
    return null;
  }
})();

export const GEO_FILTERS = Object.freeze({
  requireCountryId: GEO_RU_ONLY ? 1 : null,
  excludeCountryIds: GEO_EXCLUDE_COUNTRY_IDS.slice(),
  includeCaptionRegex: GEO_CIS_CAPTION_REGEX,
  excludeCityIds: GEO_BLOCK_CITY_IDS.slice(),
  excludeCaptionRegex: GEO_BLOCK_CAPTION_REGEX,
});

/**
 * PDF-пул (discover getMyProxy): фильтр по id_country купленных линий.
 * (Россия=1, Беларусь=22, Казахстан=82, Киргизия=145 — см. ответ API.)
 *
 * RAS_PDF_POOL_COUNTRY_IDS=22,82,145 (CSV). Пустая строка = дефолт ниже.
 * all или * — все активные proxy_id без фильтра по стране (Украина/Таиланд и т.д. тоже в пуле).
 *
 * Дефолт: только КЗ/БЛ/КГ — все остальные (РФ/UA/etc) у нас по probe 2026-05
 * уходят в 451 на pravocaptcha и тратят cooldowns впустую. Если докупаешь
 * новые гео — добавь в RAS_PDF_POOL_COUNTRY_IDS=22,82,145,<новый>.
 *
 * Смена региона (changeGeo) — отдельно: RAS_PDF_TARGET_COUNTRY_IDS.
 */
const _DEFAULT_PDF_POOL_COUNTRY_IDS = Object.freeze([22, 82, 145]);
function _parsePdfPoolCountryIds() {
  const raw = (process.env.RAS_PDF_POOL_COUNTRY_IDS ?? "").trim();
  if (!raw) return [..._DEFAULT_PDF_POOL_COUNTRY_IDS];
  const lowered = raw.toLowerCase();
  if (lowered === "all" || lowered === "*") return [];
  const ids = raw
    .split(/[,\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return ids.length ? ids : [..._DEFAULT_PDF_POOL_COUNTRY_IDS];
}

const _pdfPoolParsed = _parsePdfPoolCountryIds();
export const PDF_POOL_COUNTRY_IDS = Object.freeze(_pdfPoolParsed);

/**
 * Страны, в которые разрешён changeGeo (L3) для PDF-эскалатора / RasProxyClient.changeGeo.
 * Не влияет на состав пула — только на выбор нового geo из getAvailableEquipment.
 *
 * RAS_PDF_TARGET_COUNTRY_IDS=22,82,145 (CSV). all|* — без ограничения по стране при смене гео.
 * Если переменная не задана: копируем ограниченный пул (если он не all), иначе дефолт KZ/BY/KG
 * (отказались от РФ-таргета — pravocaptcha банит мобильные РФ-IP 451'ом).
 *
 * RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE имеет приоритет над RAS_PDF_TARGET_COUNTRY_IDS
 * (нужно, чтобы `npm run download:acts` мог быть переопределён без правки package.json:
 * жёсткий env в script-строке npm перекрывает обычный export, а *_OVERRIDE — нет).
 */
const _DEFAULT_PDF_TARGET_COUNTRY_IDS = Object.freeze([22, 82, 145]);
/**
 * @returns {{ ids: number[], source: 'override' | 'env' | 'pool' | 'default' | 'all' }}
 */
function _parsePdfTargetCountryIds(poolIds) {
  const overrideRaw = (process.env.RAS_PDF_TARGET_COUNTRY_IDS_OVERRIDE ?? "").trim();
  if (overrideRaw) {
    const lowered = overrideRaw.toLowerCase();
    if (lowered === "all" || lowered === "*") return { ids: [], source: "all" };
    const ids = overrideRaw
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) return { ids, source: "override" };
  }
  const raw = (process.env.RAS_PDF_TARGET_COUNTRY_IDS ?? "").trim();
  if (raw) {
    const lowered = raw.toLowerCase();
    if (lowered === "all" || lowered === "*") return { ids: [], source: "all" };
    const ids = raw
      .split(/[,\s]+/)
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isFinite(n) && n > 0);
    if (ids.length) return { ids, source: "env" };
    return { ids: [..._DEFAULT_PDF_TARGET_COUNTRY_IDS], source: "default" };
  }
  if (poolIds.length) return { ids: [...poolIds], source: "pool" };
  return { ids: [..._DEFAULT_PDF_TARGET_COUNTRY_IDS], source: "default" };
}

const _pdfTargetParsed = _parsePdfTargetCountryIds([..._pdfPoolParsed]);
export const PDF_TARGET_COUNTRY_IDS = Object.freeze(_pdfTargetParsed.ids);
export const PDF_TARGET_COUNTRY_IDS_SOURCE = _pdfTargetParsed.source;
/** Экспортирован для тестов: позволяет проверить override без перезапуска процесса. */
export { _parsePdfTargetCountryIds };

/** Фильтры changeGeo для PDF-эскалатора: RAS_PDF_TARGET_COUNTRY_IDS (не пул).
 *  excludeCityIds / excludeCaptionRegex берём те же, что у эскалатора парсера —
 *  иначе при разрешённом id_country=1 (РФ) downloader полезет в Москву/Питер,
 *  где у мобильных операторов есть участки без реального интернета или с
 *  жёстким ACL pravocaptcha. */
export const PDF_GEO_FILTERS = Object.freeze({
  requireCountryId: null,
  requireCountryIds: PDF_TARGET_COUNTRY_IDS.slice(),
  excludeCountryIds: [],
  includeCaptionRegex: null,
  excludeCityIds: GEO_BLOCK_CITY_IDS.slice(),
  excludeCaptionRegex: GEO_BLOCK_CAPTION_REGEX,
});

/** Fallback countryId для auto-buy, если нет RAS_AUTO_BUY_COUNTRY_ID и не вывели из существующих прокси. */
export const PDF_AUTO_BUY_DEFAULT_COUNTRY_ID =
  PDF_TARGET_COUNTRY_IDS[0] ?? PDF_POOL_COUNTRY_IDS[0] ?? 1;
