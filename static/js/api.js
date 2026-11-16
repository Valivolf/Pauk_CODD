// Thin fetch wrapper: JSON in/out, cookie-based auth, 401 -> redirect to /login.
const Api = (() => {
  // При плохой связи запрос может «зависнуть» навсегда — тогда обновление страницы (опрос каждые 5 секунд) вставало бы насовсем.
  // Поэтому у каждого запроса есть предел ожидания; по истечении — понятная ошибка, а следующий опрос пробует снова.
  const TIMEOUT_MS = 45000;
  function withTimeout(opts0) {
    const { timeoutMs, ...opts } = opts0;                       // timeoutMs — свой предел ожидания для долгих запросов
    if (opts.signal || typeof AbortController === 'undefined') return { opts, done() {} };
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs || TIMEOUT_MS);
    return { opts: { ...opts, signal: ctl.signal }, done() { clearTimeout(timer); } };
  }
  const netError = (e) => (e && e.name === 'AbortError' ? new Error('Сервер не ответил вовремя — проверьте соединение')
    : e instanceof TypeError ? new Error('Нет связи с сервером — проверьте соединение; уже загруженные данные остаются на экране') : e);

  // Связь с сервером: страница узнаёт о пропаже и возвращении (ui.js показывает полоску «Нет связи…»), чтение (GET) при обрыве или 502/503/504 повторяется само.
  let netDown = false;
  function netState(ok) {
    if (netDown === !ok) return;
    netDown = !ok;
    try { window.dispatchEvent(new CustomEvent('lc-net', { detail: { ok } })); } catch { /* старые браузеры */ }
  }
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const RETRY_CODES = new Set([502, 503, 504]);
  // Текст ошибки из ответа сервера: строка как есть; список ошибок проверки — по строке на поле.
  function detailText(payload, fallback) {
    const d = (payload && (payload.detail || payload.error)) || fallback;
    if (typeof d === 'string') return d;
    if (Array.isArray(d)) return d.map((x) => (x && x.msg) || JSON.stringify(x)).join('; ');
    return JSON.stringify(d);
  }

  async function request(path, opts0 = {}) {
    const method = String(opts0.method || 'GET').toUpperCase();
    const attempts = method === 'GET' ? 3 : 1;                  // повторять можно только чтение: повторная запись могла бы задвоиться
    let res, text, lastErr;
    for (let i = 0; i < attempts; i += 1) {
      if (i) await sleep(500 * 2 ** (i - 1));
      const t = withTimeout(opts0);
      const opts = t.opts;
      try {
        res = await fetch(path, {
          credentials: 'same-origin',
          headers: opts.body instanceof FormData ? {} : { 'Content-Type': 'application/json' },
          ...opts,
        });
        text = await res.text();
        lastErr = null;
        if (!RETRY_CODES.has(res.status) || i === attempts - 1) break;
      } catch (e) {
        lastErr = netError(e);
        if (i === attempts - 1) { netState(false); throw lastErr; }
      } finally { t.done(); }
    }
    netState(true);
    if (res.status === 401) {
      window.location.href = '/login';
      throw new Error('Требуется вход в систему');
    }
    let payload = null;
    if (text) {
      try { payload = JSON.parse(text); } catch { payload = text; }
    }
    if (!res.ok) {
      throw new Error(detailText(payload, res.status === 502 || res.status === 503 || res.status === 504 ? 'Сервер временно недоступен — повторите через несколько секунд' : res.statusText));
    }
    return payload;
  }

  // Same as get(), but also surfaces the X-Total-Count response header —
  // used by paginated list endpoints (e.g. GET /api/points?limit=...) so
  // the caller knows how many more rows exist without fetching them.
  async function getPage(path) {
    let res, text;
    for (let i = 0; i < 3; i += 1) {
      if (i) await sleep(500 * 2 ** (i - 1));
      const t = withTimeout({});
      try {
        res = await fetch(path, { credentials: 'same-origin', ...t.opts });
        if (res.status === 401) {
          window.location.href = '/login';
          throw new Error('Требуется вход в систему');
        }
        text = await res.text();
        if (!RETRY_CODES.has(res.status) || i === 2) break;
      } catch (e) {
        if (e && e.message === 'Требуется вход в систему') throw e;
        if (i === 2) { netState(false); throw netError(e); }
      } finally { t.done(); }
    }
    netState(true);
    let payload = null;
    try { payload = text ? JSON.parse(text) : null; } catch (e) { throw new Error('Ответ сервера пришёл не полностью — проверьте соединение'); }
    if (!res.ok) {
      throw new Error(detailText(payload, res.statusText));
    }
    const totalHeader = res.headers.get('X-Total-Count');
    return { items: payload || [], total: totalHeader != null ? +totalHeader : (payload || []).length };
  }

  // Загрузка файла с индикатором: fetch не умеет сообщать, сколько уже отправлено,
  // поэтому XHR. onProgress(отправлено, всего) — пока файл уходит на сервер,
  // onSent() — файл целиком отправлен, дальше сервер обрабатывает запрос.
  function uploadWithProgress(path, formData, { onProgress, onSent, timeoutMs = 600000 } = {}) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', path);
      xhr.withCredentials = true;
      xhr.timeout = timeoutMs;
      xhr.upload.onprogress = (e) => { if (e.lengthComputable && onProgress) onProgress(e.loaded, e.total); };
      xhr.upload.onload = () => { if (onSent) onSent(); };
      xhr.onerror = () => reject(new Error('Нет связи с сервером — запрос оборвался'));
      xhr.ontimeout = () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 60000)} мин`));
      xhr.onload = () => {
        if (xhr.status === 401) {
          window.location.href = '/login';
          reject(new Error('Требуется вход в систему'));
          return;
        }
        let payload = null;
        const text = xhr.responseText;
        if (text) {
          try { payload = JSON.parse(text); } catch { payload = text; }
        }
        if (xhr.status < 200 || xhr.status >= 300) {
          const detail = (payload && payload.detail) || (payload && payload.error) || xhr.statusText;
          reject(new Error(typeof detail === 'string' ? detail : JSON.stringify(detail)));
          return;
        }
        resolve(payload);
      };
      xhr.send(formData);
    });
  }

  return {
    uploadWithProgress,
    get: (path, opts) => request(path, opts || {}),
    getPage,
    post: (path, body, opts) => request(path, { method: 'POST', body: JSON.stringify(body), ...(opts || {}) }),
    put: (path, body) => request(path, { method: 'PUT', body: JSON.stringify(body) }),
    patch: (path, body) => request(path, { method: 'PATCH', body: JSON.stringify(body) }),
    del: (path) => request(path, { method: 'DELETE' }),
    upload: (path, formData, method = 'POST') => request(path, { method, body: formData }),
  };
})();
