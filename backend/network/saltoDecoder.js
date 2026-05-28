/**
 * saltoDecoder.js — обход двух защит kad.arbitr.ru на эндпоинте
 * `https://kad.arbitr.ru/Document/Pdf/<caseId>/<docId>/<fileName>`:
 *
 *   1) pravocaptcha. Раньше снимали заходом на kad/Card/<caseId>; сейчас
 *      PdfDownloader делает лёгкий прогрев ras→kad и salto-fetch на куках
 *      контекста (см. ensureKadSession).
 *
 *   2) salto-challenge (HTML 33кб с обфусцированным JS — кастомная MD5-like
 *      хеш-функция). На первый GET /Document/Pdf приходит salto-страница,
 *      нужно её распарсить, посчитать hash = calc(token + salto) и сделать
 *      POST на тот же URL с (token, hash) — в ответ application/pdf.
 *
 * Этот файл — НЕ Node-код. Это исходник функции, которую мы целиком
 * передаём в `page.evaluate(saltoFetchSource, url)`. Он:
 *
 *   - запускает fetch внутри страницы (credentials="include" → автоматически
 *     подхватывает куки/fingerprint после ras→kad в PdfDownloader);
 *   - если первый GET вернул application/pdf — сразу отдаёт base64 в Node;
 *   - если вернул salto-HTML — декодирует datat, считает hash, делает POST,
 *     получает PDF и отдаёт base64;
 *   - на 429 / 403 / редирект на pravocaptcha возвращает структурированный
 *     отлуп `{ ok:false, status, needsWarmup, retry }` чтобы Node-сторона
 *     могла решить: rotateIp() + снова ras→kad, или пауза и retry.
 *   - 451 на GET или POST /Document/Pdf — `retry: true` (блок IP/гео/сессии),
 *     не финальный отказ до исчерпания лимита попыток на стороне PdfDownloader.
 *
 * Почему всё внутри page.evaluate, а не curl --proxy через Node:
 *   - pravocaptcha привязывает себя к canvas-fingerprint Chromium'а; внешний
 *     HTTP-клиент не пройдёт даже с правильными куками.
 *   - Salto-форма пытается автосабмитнуться JS-обработчиком; если просто
 *     навигировать (`page.goto`) — Chromium откроет встроенный PDF viewer
 *     и `response.body()` будет недоступен. Поэтому fetch + ArrayBuffer.
 */

/**
 * Возвращает source-код функции, выполняемой в браузере. Передаётся в
 * `page.evaluate(saltoFetchSource(), { url, ... })`.
 *
 * Контракт результата (то, что вернётся в Node):
 *   { ok: true,  base64, contentType, bytes, attempts }
 *   { ok: false, status, error, needsWarmup?, retry?, html?: string }
 *
 *   - status — финальный HTTP-status (от GET или POST, что упало).
 *   - needsWarmup — Node снова прогоняет ras→kad (ensureKadSession), без ротации IP.
 *     (редкий случай — pravocaptcha до salto).
 *   - retry — rotateIp() + снова ras→kad и повторить.
 *     Возникает на 429 и подозрении на rate-limit.
 */
export function saltoFetchSource() {
  // Возвращаем АНОНИМНУЮ функцию-исходник: page.evaluate сериализует её
  // в строку, отправит в браузер, и вызовет с переданным аргументом.
  return async ({ url, salto, postHeaders }) => {
    const PDF_CT = "application/pdf";
    const HTML_CT_HINTS = ["text/html", "application/xhtml"];

    const decode = (response) => ({
      status: response.status,
      contentType: (response.headers.get("content-type") || "").toLowerCase(),
      url: response.url,
    });

    const arrayBufferToBase64 = (buf) => {
      const bytes = new Uint8Array(buf);
      const CHUNK = 0x8000; // безопасный chunk для String.fromCharCode.apply
      let binary = "";
      for (let i = 0; i < bytes.length; i += CHUNK) {
        const slice = bytes.subarray(i, Math.min(i + CHUNK, bytes.length));
        binary += String.fromCharCode.apply(null, slice);
      }
      return btoa(binary);
    };

    // ── 1. Первый GET. Куки/fingerprint браузера прилетят сами (credentials="include"). ──
    let firstResp;
    try {
      firstResp = await fetch(url, {
        method: "GET",
        credentials: "include",
        headers: {
          Accept:
            "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
        },
        redirect: "follow",
      });
    } catch (e) {
      return { ok: false, status: 0, error: `GET network error: ${e && e.message}` };
    }

    const firstMeta = decode(firstResp);

    // 429 → рейт-лимит ddos-guard на текущем IP. Просим Node rotateIp().
    if (firstResp.status === 429) {
      return { ok: false, status: 429, retry: true, error: "rate limited" };
    }

    // 451 → «жёсткий» бан pravocaptcha на этот IP/fingerprint
    // (видели в проде 2026-05: curl без куков на тот же URL возвращает
    // обычную pravocaptcha-страницу 200/HTML, а fetch внутри Chromium
    // с куками/JS-чаленджем — 451). Лечится только ротацией IP.
    if (firstResp.status === 451) {
      return { ok: false, status: 451, retry: true, error: "451 ban — rotate IP" };
    }

    // Редирект/200 на pravocaptcha-страницу: URL сменился, либо HTML с
    // #tokenFrom. Просим Node прогреть карточку заново.
    if (
      firstMeta.url.includes("/captcha") ||
      firstMeta.url.includes("pravocaptcha")
    ) {
      return { ok: false, status: firstResp.status, needsWarmup: true, error: "redirect to captcha" };
    }

    // ── happy path: первый GET сразу вернул PDF (умеренно редко, но бывает). ──
    if (firstMeta.contentType.includes(PDF_CT)) {
      const buf = await firstResp.arrayBuffer();
      return {
        ok: true,
        base64: arrayBufferToBase64(buf),
        contentType: firstMeta.contentType,
        bytes: buf.byteLength,
        attempts: 1,
      };
    }

    // Не-OK статус и не-PDF — отдаём как ошибку, сторона Node сама решает.
    if (!firstResp.ok && firstResp.status !== 200) {
      return {
        ok: false,
        status: firstResp.status,
        error: `unexpected GET status (${firstResp.status})`,
      };
    }

    const isHtml = HTML_CT_HINTS.some((h) => firstMeta.contentType.includes(h));
    if (!isHtml) {
      return {
        ok: false,
        status: firstResp.status,
        error: `unexpected content-type '${firstMeta.contentType}'`,
      };
    }

    // ── 2. Парсим salto-HTML. ──
    const html = await firstResp.text();

    // pravocaptcha-маркер: HTML с #tokenFrom = на текущем IP/fingerprint
    // нас не пускают к salto, нужно сменить IP. Сам /Card-warmup pravocaptcha
    // НЕ снимает (видели в проде 2026-05: и при ras→kad, и при ras→kad→Card
    // на «горящем» IP стабильно возвращается tokenFrom). retry:true → Node
    // делает rotateIp + повторный warmup на новом IP.
    if (/id\s*=\s*["']tokenFrom["']/i.test(html)) {
      return {
        ok: false,
        status: firstResp.status,
        retry: true,
        error: "pravocaptcha gate (tokenFrom present)",
      };
    }

    // Достаём token / salto / datat. Структура HTML salto-страницы:
    //   <input id="token" value="...">         (32-символьный токен)
    //   <div   id="salto">...</div>             (текст-соль для calc(token+salto))
    //   <input id="datat" value="...">         (закодированный JS — tabs/spaces)
    const pickInputValue = (id) => {
      const re = new RegExp(
        `<input[^>]*id\\s*=\\s*["']${id}["'][^>]*?value\\s*=\\s*["']([\\s\\S]*?)["']`,
        "i",
      );
      const m = html.match(re);
      if (m) return m[1];
      const re2 = new RegExp(
        `<input[^>]*value\\s*=\\s*["']([\\s\\S]*?)["'][^>]*id\\s*=\\s*["']${id}["']`,
        "i",
      );
      const m2 = html.match(re2);
      return m2 ? m2[1] : null;
    };
    const pickDivText = (id) => {
      // <div id="salto">XYZ</div>. Тег закрывается на ближайший </div>.
      const re = new RegExp(
        `<div[^>]*id\\s*=\\s*["']${id}["'][^>]*>([\\s\\S]*?)<\\/div>`,
        "i",
      );
      const m = html.match(re);
      if (!m) return null;
      // Внутри div'а голый текст — никакой разметки в salto не бывает.
      return m[1].trim();
    };

    // HTML entity decode. В attribute value переводы строк кодируются как `&#10;`
    // (а \t как `&#9;`), и raw response.text() их НЕ декодирует — это делает
    // только HTML-парсер браузера при построении DOM. Без декодирования datat
    // склеивается в одну длинную бинарку, parseInt(.., 2) переполняется и
    // возвращает мусор. Декодим через textarea-трюк — браузер сам нормализует.
    const decodeHtmlEntities = (s) => {
      if (s == null) return s;
      const ta = document.createElement("textarea");
      ta.innerHTML = s;
      return ta.value;
    };

    const token = decodeHtmlEntities(pickInputValue("token"));
    // salto — в <div>, не в <input>. На всякий случай делаем фоллбек на input
    // (если RAS поменяет HTML — не упадём сразу).
    const saltoVal = decodeHtmlEntities(pickDivText("salto") ?? pickInputValue("salto"));
    const datat = decodeHtmlEntities(pickInputValue("datat"));
    if (!token || !saltoVal || !datat) {
      return {
        ok: false,
        status: firstResp.status,
        error: `salto inputs missing (token=${!!token}, salto=${!!saltoVal}, datat=${!!datat})`,
        html: html.slice(0, 800),
      };
    }

    // ── 3. Декодируем datat. ──
    // Алгоритм (зафиксирован эмпирически на реальных ответах RAS):
    //   - datat состоит из «строк», разделённых \n; каждая строка — последовательность
    //     табов (=1) и пробелов (=0), кодирующая один char source-кода;
    //   - parseInt(line, 2) даёт char code напрямую (НЕ удвоенный — старая версия
    //     PoC писала `>> 1`, но на текущих ответах char='f'(102) соответствует
    //     строке из 7 бит `1100110`, parseInt = 102 = 'f' — без сдвига).
    //   - Также важно: \n в HTML attribute value приходят как `&#10;` —
    //     decodeHtmlEntities выше превращает их в реальный \n.
    let decodedJs = "";
    try {
      const lines = datat.split(/\r?\n/);
      const chars = [];
      for (const rawLine of lines) {
        // Берём только символы tab/space — остальное (\r, мусор) игнорим.
        const line = rawLine.replace(/[^\t ]/g, "");
        if (!line) continue;
        const bits = line.replace(/\t/g, "1").replace(/ /g, "0");
        const code = parseInt(bits, 2);
        if (!Number.isFinite(code)) continue;
        if (code > 0 && code < 0x110000) chars.push(String.fromCharCode(code));
      }
      decodedJs = chars.join("");
    } catch (e) {
      return {
        ok: false,
        status: firstResp.status,
        error: `datat decode failed: ${e && e.message}`,
      };
    }

    // Обрезаем хвост `var token=...; ...submit()` — иначе при компиляции
    // запустится автосабмит формы внутри iframe-less контекста.
    const tokenVarIdx = decodedJs.search(/var\s+token\s*=/);
    const fnSrc = tokenVarIdx > 0 ? decodedJs.slice(0, tokenVarIdx) : decodedJs;

    // ── 4. Запускаем decoded JS в GLOBAL scope страницы. ──
    // Тонкость: декодированный код использует `this.utf8_encode(...)` внутри
    // calc() — то есть рассчитывает, что вызов идёт в global scope (где
    // `this` указывает на window, и var-объявления оседают как window.xxx).
    // `new Function(body)` помещает var-ы в локальный scope фабрики, поэтому
    // обращение через this к соседней функции ломается. Indirect eval
    // (`(0, eval)(src)`) выполняет код в global scope — туда же оседают
    // `var calc`, `var utf8_encode`, и this в calc() становится window.
    //
    // Заодно изолируем имена: проверяем, не было ли calc/utf8_encode уже
    // в window, чтобы понимать, не получили ли мы ложную функцию.
    let hash;
    try {
      const win = globalThis;
      win.__rasSaltoPrev = {
        calc: win.calc,
        utf8_encode: win.utf8_encode,
      };
      // (0, eval)(...) — indirect eval, executes in global scope.
      (0, eval)(fnSrc);
      if (typeof win.calc !== "function") {
        throw new Error("compiled salto JS has no calc()");
      }
      // Вызываем calc как метод window — this станет window, и this.utf8_encode
      // отрезолвится в свежеопределённую функцию из того же decoded JS.
      hash = win.calc(String(token) + String(saltoVal));
      // Откатываем globals — чтобы между вызовами не накапливать состояние.
      win.calc = win.__rasSaltoPrev.calc;
      win.utf8_encode = win.__rasSaltoPrev.utf8_encode;
      delete win.__rasSaltoPrev;
    } catch (e) {
      return {
        ok: false,
        status: firstResp.status,
        error: `salto JS exec failed: ${e && e.message}`,
        decoded_preview: decodedJs.slice(0, 600),
        decoded_len: decodedJs.length,
        datat_len: datat.length,
      };
    }
    if (!hash || typeof hash !== "string") {
      return {
        ok: false,
        status: firstResp.status,
        error: `calc() returned non-string: ${typeof hash}`,
      };
    }

    // ── 6. POST на тот же URL с token и hash. ──
    const body = `token=${encodeURIComponent(token)}&hash=${encodeURIComponent(hash)}`;
    let postResp;
    try {
      postResp = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept:
            "application/pdf,application/octet-stream,text/html;q=0.9,*/*;q=0.8",
          "Accept-Language": "ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7",
          ...(postHeaders || {}),
        },
        body,
        redirect: "follow",
      });
    } catch (e) {
      return { ok: false, status: 0, error: `POST network error: ${e && e.message}` };
    }

    const postMeta = decode(postResp);

    if (postResp.status === 429) {
      return { ok: false, status: 429, retry: true, error: "rate limited on POST" };
    }
    // Как и на GET: 451 на POST — блок по IP/гео/сессии, не «финальный отказ акта».
    if (postResp.status === 451) {
      return {
        ok: false,
        status: 451,
        retry: true,
        error: "451 on POST — rotate IP / reset session",
      };
    }
    if (!postResp.ok) {
      return {
        ok: false,
        status: postResp.status,
        error: `POST returned ${postResp.status}`,
      };
    }
    if (!postMeta.contentType.includes(PDF_CT)) {
      // Иногда возвращается ещё одна salto-страница (повторный challenge).
      // Это сигнал, что hash был неверный — просим Node прогреть warmup.
      const peek = await postResp.text();
      return {
        ok: false,
        status: postResp.status,
        needsWarmup: true,
        error: `POST returned ${postMeta.contentType} instead of PDF`,
        html: peek.slice(0, 400),
      };
    }

    const buf = await postResp.arrayBuffer();
    return {
      ok: true,
      base64: arrayBufferToBase64(buf),
      contentType: postMeta.contentType,
      bytes: buf.byteLength,
      attempts: 2,
    };
  };
}

export default saltoFetchSource;
