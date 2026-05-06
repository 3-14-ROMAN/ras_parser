/**
 * Чистая дата-функция для адаптивного дробления окна по latency
 * (Query Downgrade в parser.js). Вынесена в отдельный модуль, чтобы
 * её можно было покрыть unit-тестами (`test_window_split.js`) без
 * импорта `parser.js` целиком — он на верхнем уровне зовёт `main()`
 * и пытается поднять Chromium.
 */

/**
 * Разбить под-окно `{ endDay, daysSpan }` на `factor` подокон, покрывающих
 * тот же диапазон дат.
 *
 * Дни распределяются как можно ровнее (бо́льшие куски — впереди),
 * `endDay` идёт «вглубь прошлого» по мере набора чанков:
 *   - первый чанк имеет `endDay = sub.endDay`;
 *   - каждый следующий — `endDay = previous.endDay - previous.daysSpan` дней.
 *
 * Контракт:
 *   - `factor >= 2`. Если `factor < 2` — возвращаем массив из одного
 *     элемента, равного входному (без копий — но `endDay` всегда новый объект).
 *   - `daysSpan <= 1` — нечего дробить, возвращаем массив из одного элемента.
 *   - `endDay` всегда — новый `Date`-объект, входной не мутируется.
 *   - Сумма `daysSpan` всех элементов === `sub.daysSpan`.
 *
 * Примеры:
 *   splitWindow({endDay: April 7, daysSpan: 7}, 2)
 *     -> [{end: Apr 7, days: 4}, {end: Apr 3, days: 3}]
 *
 *   splitWindow({endDay: April 7, daysSpan: 7}, 4)
 *     -> [{end: Apr 7, days: 2}, {end: Apr 5, days: 2},
 *         {end: Apr 3, days: 2}, {end: Apr 1, days: 1}]
 *
 * @param {{ endDay: Date, daysSpan: number }} sub
 * @param {number} factor
 * @returns {Array<{ endDay: Date, daysSpan: number }>}
 */
export function splitWindow(sub, factor) {
  if (!sub || !(sub.endDay instanceof Date)) {
    throw new Error("splitWindow: sub.endDay должен быть Date");
  }
  const totalDays = Number(sub.daysSpan);
  if (!Number.isFinite(totalDays) || totalDays < 1) {
    throw new Error(`splitWindow: некорректный daysSpan=${sub.daysSpan}`);
  }
  if (!Number.isFinite(factor) || factor < 2 || totalDays <= 1) {
    return [{ endDay: new Date(sub.endDay), daysSpan: totalDays }];
  }

  const parts = [];
  let remaining = totalDays;
  let chunksLeft = factor;
  while (remaining > 0 && chunksLeft > 0) {
    const take = Math.ceil(remaining / chunksLeft);
    parts.push(take);
    remaining -= take;
    chunksLeft -= 1;
  }

  const result = [];
  let curEnd = new Date(sub.endDay);
  for (const days of parts) {
    result.push({ endDay: new Date(curEnd), daysSpan: days });
    curEnd = new Date(
      curEnd.getFullYear(),
      curEnd.getMonth(),
      curEnd.getDate() - days,
    );
  }
  return result;
}

