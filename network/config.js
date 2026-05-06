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

export const CHANGE_IP_COOLDOWN_SEC = Number(
  process.env.MP_CHANGE_IP_COOLDOWN_SEC ?? 300,
);
/** Минимум секунд между двумя вызовами changeGeo (не суммируется сугубо с L2 — берётся max с общим cooldown оборудования). */
export const CHANGE_GEO_COOLDOWN_SEC = Number(
  process.env.MP_CHANGE_GEO_COOLDOWN_SEC ?? 180,
);
export const ESC_EQUIPMENT_COOLDOWN_SEC = Number(
  process.env.ESC_EQUIPMENT_COOLDOWN_SEC ?? 600,
);
export const ESC_PRE_EQUIPMENT_IP_ROTATIONS = Math.max(
  0,
  Number(process.env.ESC_PRE_EQUIPMENT_IP_ROTATIONS ?? 3),
);

// changeIp подряд до changeOperator. Дефолт 5 — сначала автоматически
// выгребаем дешёвую ротацию IP с паузами (`MP_CHANGE_IP_COOLDOWN_SEC` +
// smartWait ip_cooldown), затем L2/L3.
export const ESC_MAX_IP_BEFORE_EQUIPMENT = Number(
  process.env.ESC_MAX_IP_BEFORE_EQUIPMENT ?? 5,
);
// changeOperator (строго в текущем geoid) подряд до changeGeo.
export const ESC_MAX_OPERATOR_BEFORE_GEO = Number(
  process.env.ESC_MAX_OPERATOR_BEFORE_GEO ?? 2,
);
// Потолок changeGeo на весь прогон. **≤0 — без лимита** (частота всё равно
// ограничена `MP_CHANGE_GEO_COOLDOWN_SEC` в RasProxyClient). ВНИМАНИЕ: смена
// региона у провайдера платная; штатно L3 только при kind='net_down'.
export const ESC_MAX_GEO_SWAPS = Number(process.env.ESC_MAX_GEO_SWAPS ?? 0);
// 0 = без лимита. От бесконечного «recover без прогресса» защищает лестница
// L1/L2/L3 в escalator.js, а не эти счётчики.
export const ESC_MAX_TOTAL_FAILURES = Number(
  process.env.ESC_MAX_TOTAL_FAILURES ?? 0,
);
// 0 = без лимита по времени жизни эскалатора (недельные фоновые прогоны).
export const ESC_MAX_BUDGET_SEC = Number(process.env.ESC_MAX_BUDGET_SEC ?? 0);

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
 * Текущая политика: РФ не используем вообще, приоритет на страны СНГ
 * (Беларусь, Казахстан, Кыргызстан, Узбекистан, Грузия и т.д.).
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
const _DEFAULT_EXCLUDE_COUNTRY_IDS = [1];
export const GEO_EXCLUDE_COUNTRY_IDS = (process.env.GEO_EXCLUDE_COUNTRY_IDS ?? "")
  .split(",")
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n > 0);
if (GEO_EXCLUDE_COUNTRY_IDS.length === 0) {
  GEO_EXCLUDE_COUNTRY_IDS.push(..._DEFAULT_EXCLUDE_COUNTRY_IDS);
}
export const GEO_CIS_CAPTION_REGEX = (() => {
  if (!GEO_CIS_ONLY) return null;
  const src =
    process.env.GEO_CIS_CAPTION_REGEX ??
    "(?:Беларус|Казахстан|Киргиз|Кыргыз|Узбекистан|Грузи|Армени|Азербайджан|Таджикистан|Молдова|Kazakhstan|Kyrgyz|Kyrgyzstan|Belarus|Uzbekistan|Georgia|Armenia|Azerbaijan|Tajikistan|Moldova)";
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
