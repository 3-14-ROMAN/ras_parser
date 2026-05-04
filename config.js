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

export const CHANGE_IP_URL = MP_PROXY_KEY
  ? `https://changeip.mobileproxy.space/?proxy_key=${MP_PROXY_KEY}&format=json`
  : "";

export const CHANGE_IP_COOLDOWN_SEC = Number(
  process.env.MP_CHANGE_IP_COOLDOWN_SEC ?? 15,
);

export const PAGE_DELAY_MIN_SEC = 1.2;
export const PAGE_DELAY_MAX_SEC = 3.8;

// changeIp подряд до changeOperator. Дефолт 8 (а не 3) — пользователь
// просит «менять локацию только когда смена IP не помогла», поэтому
// дешёвую ротацию IP пробуем побольше раз, прежде чем эскалироваться.
export const ESC_MAX_IP_BEFORE_EQUIPMENT = Number(
  process.env.ESC_MAX_IP_BEFORE_EQUIPMENT ?? 8,
);
// changeOperator (строго в текущем geoid) подряд до changeGeo.
export const ESC_MAX_OPERATOR_BEFORE_GEO = Number(
  process.env.ESC_MAX_OPERATOR_BEFORE_GEO ?? 2,
);
// changeGeo на весь прогон. ВНИМАНИЕ: смена региона у провайдера
// ПЛАТНАЯ (см. README → «Политика смены региона»). Эскалатор в принципе
// делает её только при kind='net_down' (полный отвал сети) и только
// после того, как L1 changeIp не помог. Этот лимит — дополнительная
// верхняя граница на весь прогон. По умолчанию 5 (раньше было 2);
// сами строгие правила kind гарантируют, что без реального net-down
// до неё мы не доедем.
export const ESC_MAX_GEO_SWAPS = Number(process.env.ESC_MAX_GEO_SWAPS ?? 5);
export const ESC_MAX_TOTAL_FAILURES = Number(
  process.env.ESC_MAX_TOTAL_FAILURES ?? 40,
);
export const ESC_MAX_BUDGET_SEC = Number(process.env.ESC_MAX_BUDGET_SEC ?? 3600);

/**
 * Geo-фильтры для эскалатора (ProxyEscalator → RasProxyClient.changeGeo).
 *
 * Работают и при штатной L3 changeGeo, и при ACL-fast-track в _safeGoto:
 * провайдер mobileproxy.space держит ACL по hostname `*.arbitr.ru`
 * на московских/крупных-городовых SIM-ках, поэтому при выборе нового
 * гео мы строго требуем Россию и отрезаем заведомо «грязные» города.
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
export const GEO_RU_ONLY = (process.env.GEO_RU_ONLY ?? "1") === "1";

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
  excludeCityIds: GEO_BLOCK_CITY_IDS.slice(),
  excludeCaptionRegex: GEO_BLOCK_CAPTION_REGEX,
});
