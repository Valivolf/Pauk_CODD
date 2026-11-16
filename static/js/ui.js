// Shared UI primitives used by every page: DOM helper, HTML-escaping, the
// single-slot modal system, and the button/field style constants. Each
// page defines its own `close()` — what "closing a modal" should refresh
// differs between the calendar and /warehouse.
const $ = (q) => document.querySelector(q);
const esc = (x) => String(x ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let editing = false;

// Сравнение названий «без разбора» (то же правило, что на сервере: app/core/names.py, app/core/point_ref.py): регистр, ё/е, пробелы, дефисы и знаки не важны, латинские буквы-двойники
// русских («TO-5» и «ТО-5») равны. Номер комплекса набирают по-разному («ARENA 0901205», «arena0901205», «то 5»), а в названии — дефис и свои буквы.
const LOOKALIKE = { a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у' };
const foldName = (x) => String(x ?? '').normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/[abcehkmopxty]/g, (ch) => LOOKALIKE[ch]);
const compactName = (x) => foldName(x).replace(/[^\p{L}\p{N}]+/gu, '');
const digitsOf = (x) => (String(x ?? '').match(/\d+/g) || []).join('');
// Подходит ли запрос под поля записи: как подстрока (без регистра), либо все слова запроса «без разбора» входят в поля вместе. Пустой запрос подходит всему.
function matchesQuery(query, ...fields) {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return true;
  const texts = fields.map((f) => String(f ?? ''));
  if (texts.some((t) => t.toLowerCase().includes(q))) return true;
  const hay = compactName(texts.join(' '));
  const words = q.split(/\s+/).map(compactName).filter(Boolean);
  return words.length > 0 && (hay.includes(compactName(q)) || words.every((w) => hay.includes(w)));
}

// Shared short role label for the "username · role" header shown on every
// page — each page still picks its own fallback for a role it can't
// actually reach (e.g. warehouse never sees this, apk.js has no
// 'warehouse' case), but every page that can be opened by 'viewer' needs
// this one label in common.
const ROLE_DISPLAY_LABEL = { admin: 'админ', user: 'оператор', warehouse: 'склад', viewer: 'только просмотр', absences: 'отсутствия' };

// ---------- права роли ----------
// Права приходят с /api/auth/me (CURRENT_USER.permissions; у администратора ['*']). Скрытие кнопок и разделов — удобство: запрет на сервере действует всегда
// (app/core/perm_guard.py), даже если кнопку показали по ошибке. В разметке: data-perm="a,b" — скрыть, если нет НИ ОДНОГО из прав; data-perm-show="a,b" — элемент
// скрыт по умолчанию и показывается, если есть любое из прав. В кодe, собирающем разметку: can('право') ? '<button…>' : ''.
function can(key) {
  const u = typeof CURRENT_USER !== 'undefined' ? CURRENT_USER : null;
  const p = (u && u.permissions) || [];
  return p.includes('*') || p.includes(key);
}
function canAny(...keys) { return keys.some((k) => can(k)); }
function userRoleLabel(u) { return (u && (u.role_name || ROLE_DISPLAY_LABEL[u.role] || u.role)) || ''; }
// Страницы по порядку предпочтения — как на сервере (app/core/permissions.py::PAGES): куда вести человека, если «своей» страницы у него нет
const PAGE_ORDER = [['/', 'calendar.view', 'Календарь'], ['/apk', ['points.view', 'check.use'], 'Все АПК'], ['/warehouse', 'warehouse.view', 'Склад'], ['/reports', 'reports.view', 'Отчёты'],
  ['/monitoring', 'monitoring.view', 'Мониторинг'], ['/notifications', 'notifications.view', 'Уведомления'], ['/stats', 'stats.view', 'Статистика'], ['/absences', 'absences.view', 'Отсутствия'],
  ['/assistant', 'assistant.use', 'Помощник']];
function firstPageFor(exceptPath) {
  const hit = PAGE_ORDER.find(([path, key]) => path !== exceptPath && canAny(...[].concat(key)));
  return hit ? { path: hit[0], label: hit[2] } : null;
}
function applyPerms(root) {
  if (typeof CURRENT_USER === 'undefined' || !CURRENT_USER) return;
  const scope = root && root.querySelectorAll ? root : document;
  const nodes = [...scope.querySelectorAll('[data-perm],[data-perm-show]')];
  if (scope.matches && scope.matches('[data-perm],[data-perm-show]')) nodes.push(scope);
  const list = (v) => v.split(',').map((x) => x.trim()).filter(Boolean);
  for (const el of nodes) {
    if (el.dataset.perm !== undefined) el.toggleAttribute('data-perm-denied', !canAny(...list(el.dataset.perm)));
    if (el.dataset.permShow !== undefined) el.classList.toggle('hidden', !canAny(...list(el.dataset.permShow)));
  }
}
let permsObserver = null;
// Вызывается страницей сразу после загрузки CURRENT_USER: подпись в шапке, скрытие кнопок по правам (в том числе в разметке, которую страница дорисует позже), ссылка на помощника
function initUserUi() {
  const label = document.getElementById('userLabel');
  if (label && CURRENT_USER) label.textContent = `${CURRENT_USER.username} · ${userRoleLabel(CURRENT_USER)}`;
  applyPerms(document);
  if (!permsObserver && document.body) {
    permsObserver = new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) applyPerms(n); });
    permsObserver.observe(document.body, { childList: true, subtree: true });
  }
  mountAssistantLink();
  mountGamesLink();
}

// Closing happens via an explicit button (.cancel, or the form's own
// submit/close action) or the Esc key — no click-outside-to-close. That
// used to fire on stray clicks whenever a text selection drag ended
// outside the box.
function modal(html, opts = {}) {
  editing = true;
  // opts.wide — широкое окно (галерея фото, таблицы); по умолчанию узкое окно формы.
  $('#modal').innerHTML = `<div class="fixed inset-0 bg-slate-950/70 grid place-items-center p-4 z-30 animate-fade-in">
    <div class="glass lc-pop rounded-3xl p-6 md:p-8 w-full max-w-xl max-h-[90vh] overflow-auto shadow-2xl"${opts.wide ? ' style="max-width:1100px"' : ''}>${html}</div>
  </div>`;
  $('.cancel')?.addEventListener('click', close);
}

// Периодический опрос сервера только пока вкладку видно: у скрытой вкладки (другое окно, свёрнутый браузер) запросов нет, а когда
// к ней возвращаются после паузы дольше периода — данные обновляются сразу, не дожидаясь следующего тика.
function visiblePoll(fn, ms) {
  let last = Date.now();
  const timer = setInterval(() => { if (!document.hidden) { last = Date.now(); fn(); } }, ms);
  document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > ms) { last = Date.now(); fn(); } });
  return timer;
}

// Esc closes whatever modal() currently has open, same as clicking .cancel
// — each page's own close() (called here via the bare global name, defined
// after ui.js loads) handles that page's own refresh-on-close logic.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editing && typeof close === 'function') close();
});

// Some source data (Yandex Constructor files, tables pasted out of a web
// page) carries Cyrillic as literal HTML entities — "&#1052;&#1045;..."
// instead of "МЕ..." — see app/core/text.py, which does the same on the
// server. Only numeric and a few semicolon-terminated named entities are
// decoded (not the browser's own HTML decoding, which also rewrites legacy
// no-semicolon names like "&region=5"); repeated since a value encoded
// twice needs two passes.
const _ENTITY_RE = /&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|(amp|lt|gt|quot|apos|nbsp));/g;
const _NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
function decodeEntities(value) {
  let s = String(value ?? '');
  for (let i = 0; i < 3; i++) {
    const decoded = s.replace(_ENTITY_RE, (m, dec, hex, name) => {
      if (name) return _NAMED_ENTITIES[name];
      const code = dec ? parseInt(dec, 10) : parseInt(hex, 16);
      if (!code || (code >= 0xD800 && code <= 0xDFFF) || code > 0x10FFFF) return m;
      return String.fromCodePoint(code);
    });
    if (decoded === s) break;
    s = decoded;
  }
  return s;
}

// Скачивание файла с сервера через fetch: понятное сообщение при ошибке (вместо
// перехода на страницу с JSON) и имя файла из заголовка. Возвращает ответ.
async function downloadFile(url, fallbackName = 'file') {
  const res = await fetch(url, { credentials: 'same-origin' });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Требуется вход в систему'); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).detail || msg; } catch { /* не JSON */ }
    throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
  }
  const disposition = res.headers.get('Content-Disposition') || '';
  const star = /filename\*=UTF-8''([^;]+)/.exec(disposition);
  const plain = /filename="([^"]+)"/.exec(disposition);
  const filename = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : fallbackName);
  const blob = await res.blob();
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  return res;
}

// ---------- даты: всегда ДД-ММ-ГГГГ ----------
// Внутри (API, база, сравнение строк, <input type=date>) дата — ISO
// "ГГГГ-ММ-ДД"; человеку она показывается только так: "05-10-2026", со
// временем — "05-10-2026 12:30". Зеркало app/core/dates.py (Excel, печать,
// отчёты). Всё, что не похоже на дату, возвращается как есть.
const _ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;
function fmtDate(v) {
  if (v == null || v === '') return '';
  const m = _ISO_DATE_RE.exec(String(v).trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(v);
}
function fmtDateTime(v, withSeconds = false) {
  if (v == null || v === '') return '';
  const m = _ISO_DATE_RE.exec(String(v).trim());
  if (!m) return String(v);
  let out = `${m[3]}-${m[2]}-${m[1]}`;
  if (m[4] != null) {
    out += ` ${m[4]}:${m[5]}`;
    if (withSeconds && m[6] != null) out += `:${m[6]}`;
  }
  return out;
}
const fmtPeriod = (from, to) => (from === to ? fmtDate(from) : `${fmtDate(from)} — ${fmtDate(to)}`);
// "30-09-2026, среда" — заголовок выбранного дня в календаре.
function fmtDayHeading(iso) {
  const weekday = new Intl.DateTimeFormat('ru-RU', { weekday: 'long' }).format(new Date(iso + 'T12:00:00'));
  return `${fmtDate(iso)}, ${weekday}`;
}

// Поле даты. Родной <input type=date> рисует дату так, как решит браузер
// (дд.мм.гггг, мм/дд/гггг, …) — и формат не переопределить. Поэтому каждый
// такой input (и тот, что появится позже) остаётся в DOM невидимым и
// продолжает быть источником правды — его .value, change/input, min/max,
// required и form.elements работают как раньше, в ISO, — а перед ним
// показывается текстовое поле «ДД-ММ-ГГГГ» с маской и кнопкой календаря,
// которое с ним синхронизируется в обе стороны (в том числе когда код
// присваивает input.value).
const _nativeDateValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');

function _maskDate(raw) {
  const iso = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw);
  if (iso) return `${iso[3]}-${iso[2]}-${iso[1]}`; // вставили ISO целиком
  const d = raw.replace(/\D/g, '').slice(0, 8);
  if (d.length > 4) return `${d.slice(0, 2)}-${d.slice(2, 4)}-${d.slice(4)}`;
  if (d.length > 2) return `${d.slice(0, 2)}-${d.slice(2)}`;
  return d;
}

function _displayToIso(text) {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(text);
  if (!m) return '';
  const [d, mo, y] = [+m[1], +m[2], +m[3]];
  const probe = new Date(y, mo - 1, d);
  if (probe.getFullYear() !== y || probe.getMonth() !== mo - 1 || probe.getDate() !== d) return '';
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function enhanceDateInput(native) {
  if (native.dataset.dateEnhanced) return;
  native.dataset.dateEnhanced = '1';

  const wrap = document.createElement('span');
  wrap.className = 'date-input' + (native.classList.contains('w-full') ? ' date-input-block' : '');
  native.parentNode.insertBefore(wrap, native);
  wrap.appendChild(native);
  native.tabIndex = -1;
  native.setAttribute('aria-hidden', 'true');
  const fieldClasses = native.className;
  native.classList.add('date-input-native');

  const text = document.createElement('input');
  text.type = 'text';
  text.inputMode = 'numeric';
  text.autocomplete = 'off';
  text.placeholder = 'ДД-ММ-ГГГГ';
  text.maxLength = 10;
  text.size = 10;
  text.className = `${fieldClasses} date-input-text`;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.tabIndex = -1;
  btn.className = 'date-input-btn';
  btn.title = 'Выбрать дату в календаре';
  btn.setAttribute('aria-label', 'Выбрать дату в календаре');
  btn.innerHTML = '<svg viewBox="0 0 20 20" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><rect x="3" y="4.5" width="14" height="12.5" rx="2"/><path d="M3 8.5h14M7 2.5v3M13 2.5v3"/></svg>';
  wrap.append(text, btn);

  const nativeValue = () => _nativeDateValue.get.call(native);
  const fire = () => {
    native.dispatchEvent(new Event('input', { bubbles: true }));
    native.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // Сообщения о неверной дате пишем сами — встроенные браузерные называют
  // границы диапазона в своём формате («30.09.2026»).
  const markValidity = () => {
    const iso = _displayToIso(text.value);
    let msg = '';
    if (text.value !== '' && !iso) msg = 'Введите дату в формате ДД-ММ-ГГГГ';
    else if (iso && native.min && iso < native.min) msg = `Дата не может быть раньше ${fmtDate(native.min)}`;
    else if (iso && native.max && iso > native.max) msg = `Дата не может быть позже ${fmtDate(native.max)}`;
    text.classList.toggle('date-input-invalid', !!msg && text.value.length === 10);
    native.setCustomValidity(msg);
  };
  const refreshText = () => {
    const shown = fmtDate(nativeValue());
    if (text.value !== shown) text.value = shown;
    markValidity();
  };

  // Код страницы присваивает input.value = 'ГГГГ-ММ-ДД' (кнопки периодов,
  // подстановка даты и т.п.) — перехватываем, чтобы видимое поле не отстало.
  Object.defineProperty(native, 'value', {
    configurable: true,
    get() { return _nativeDateValue.get.call(this); },
    set(v) { _nativeDateValue.set.call(this, v); refreshText(); },
  });
  native.addEventListener('change', refreshText);

  text.addEventListener('input', () => {
    const before = text.value;
    const digitsBeforeCaret = before.slice(0, text.selectionStart ?? before.length).replace(/\D/g, '').length;
    const masked = _maskDate(before);
    if (masked !== before) {
      text.value = masked;
      let pos = 0, seen = 0;
      while (pos < masked.length && seen < digitsBeforeCaret) { if (/\d/.test(masked[pos])) seen++; pos++; }
      try { text.setSelectionRange(pos, pos); } catch { /* не критично */ }
    }
    const iso = _displayToIso(text.value);
    markValidity();
    const prev = nativeValue();
    if (iso === prev) return;
    _nativeDateValue.set.call(native, iso);
    // Неполный ввод не шлём наружу — как и родной date-input, сообщаем о
    // смене только когда дата стала целой (или поле очистили совсем).
    if (iso || text.value === '') fire();
  });

  btn.addEventListener('click', () => {
    try { native.showPicker(); } catch { native.focus(); native.click(); }
  });

  refreshText();
}

function enhanceDateInputs(root) {
  (root || document).querySelectorAll('input[type="date"]:not([data-date-enhanced])').forEach(enhanceDateInput);
}
enhanceDateInputs(document);
new MutationObserver((mutations) => {
  for (const m of mutations) {
    for (const n of m.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (n.matches?.('input[type="date"]')) enhanceDateInput(n);
      else enhanceDateInputs(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

const fieldCls = 'w-full rounded-xl px-3 py-2 text-sm accent-ring transition-all duration-300';
const labelCls = 'grid gap-1.5 text-xs font-medium text-slate-400';
const btnPrimary = 'rounded-xl px-4 py-2 text-sm font-semibold bg-indigo-500 hover:bg-indigo-400 text-white shadow-lg shadow-indigo-500/25 transition-all duration-300 hover:scale-[1.02]';
const btnGhost = 'rounded-xl px-4 py-2 text-sm font-medium bg-slate-800/70 hover:bg-slate-700/70 border border-slate-700 transition-all duration-300';
const btnDanger = 'rounded-xl px-4 py-2 text-sm font-medium bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-all duration-300';

// A coloured pill for a free-form, get-or-create dictionary value (point
// category, equipment category, …) — same visual language as the
// Sklad warehouse app's category/status badges: text + border in the
// dictionary's own colour, on a translucent tint of it.
function colorBadge(name, color) {
  if (!name) return '';
  const c = color || '#6b7280';
  return `<span class="inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium" style="background:${c}22;color:${c};border:1px solid ${c}55">${esc(name)}</span>`;
}

// ---------- reactive re-render: patch instead of replace ----------
// Every page's 5s live-refresh poll used to blindly replace a whole
// list/section's innerHTML on every tick, even when only one row (or
// nothing at all) had actually changed — every row flashed together,
// buttons visibly blinked, scroll position/hover state was lost. These two
// helpers avoid that:
//  - patchKeyedList only touches the DOM node(s) whose rendered HTML
//    actually differs, keyed by keyFn(item); everything else keeps its
//    exact node, so an unrelated row never flickers.
//  - setHtmlIfChanged skips the DOM write entirely for a non-list block
//    (a dashboard section, a form shell) when the freshly computed HTML is
//    byte-identical to what's already there.
function patchKeyedList(container, items, keyFn, itemHtml, emptyHtml) {
  if (!container) return;
  if (!items.length) {
    if (container.innerHTML !== (emptyHtml || '')) container.innerHTML = emptyHtml || '';
    return;
  }
  // A previous empty-state placeholder (or first render) has no data-key
  // children — start clean rather than trying to key-match against it.
  if ([...container.children].some((el) => el.dataset.key == null)) container.innerHTML = '';
  const scratch = document.createElement('div');
  const existing = new Map();
  for (const el of container.children) {
    if (el.dataset.key != null) existing.set(el.dataset.key, el);
  }
  let cursor = container.firstChild;
  for (const item of items) {
    const key = String(keyFn(item));
    scratch.innerHTML = itemHtml(item).trim();
    const fresh = scratch.firstElementChild;
    if (!fresh) continue;
    fresh.dataset.key = key;
    const old = existing.get(key);
    existing.delete(key);
    let node;
    if (old && old.outerHTML === fresh.outerHTML) {
      node = old;
      if (node !== cursor) container.insertBefore(node, cursor);
    } else if (old) {
      // replaceWith drops `fresh` in exactly where `old` was — if that was
      // also the current cursor, position is already correct and `cursor`
      // (still referencing the now-detached `old`) must NOT be passed to
      // insertBefore, or it throws ("not a child of this node").
      const wasCursor = old === cursor;
      old.replaceWith(fresh);
      node = fresh;
      if (!wasCursor && node !== cursor) container.insertBefore(node, cursor);
    } else {
      node = fresh;
      if (node !== cursor) container.insertBefore(node, cursor);
    }
    cursor = node.nextSibling;
  }
  for (const leftover of existing.values()) leftover.remove();
}

const _lastHtmlByEl = new WeakMap();
function setHtmlIfChanged(el, html) {
  if (!el || _lastHtmlByEl.get(el) === html) return false;
  el.innerHTML = html;
  _lastHtmlByEl.set(el, html);
  return true;
}

// Пока ответ сервера не пришёл, пустой список не значит «данных нет»: вместо «Ничего не найдено» пишем «Данные загружаются…».
function loadingHtml(text = 'Данные загружаются…', cls = 'text-sm text-slate-500 text-center py-6') {
  return `<p class="${cls} lc-pulse" data-loading>${esc(text)}</p>`;
}

// Список уже на экране, а данные перечитываются (поиск, фильтр, обновление): над ним строка «Обновляю данные…», старые строки тускнеют, но остаются.
// on=false убирает пояснение. Список не пересоздаётся, поэтому прокрутка и фокус не теряются.
function setListLoading(listEl, on, text = 'Обновляю данные…') {
  if (!listEl || !listEl.parentNode) return;
  let bar = listEl.previousElementSibling;
  if (!bar || !bar.hasAttribute('data-list-status')) {
    if (!on) return;
    bar = document.createElement('div');
    bar.setAttribute('data-list-status', '');
    bar.className = 'text-xs text-slate-400 lc-pulse mb-1 hidden';
    listEl.parentNode.insertBefore(bar, listEl);
  }
  bar.textContent = text;
  bar.classList.toggle('hidden', !on);
  listEl.style.opacity = on ? '.55' : '';
}

// Перерисовка списков не должна возвращать прокрутку в начало: запоминает прокрутку страницы и всех прокручиваемых блоков внутри
// root (по порядку), выполняет fn (может быть асинхронной) и ставит прокрутку на место. Нужна, когда после закрытия окна список рисуется заново.
async function keepScroll(root, fn) {
  const host = typeof root === 'string' ? document.querySelector(root) : root;
  const boxes = () => (host ? [...host.querySelectorAll('*')].filter((el) => el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY)) : []);
  const saved = boxes().map((el) => el.scrollTop);
  const pageY = window.scrollY;
  try { return await fn(); }
  finally {
    const put = () => { boxes().forEach((el, i) => { if (saved[i]) el.scrollTop = saved[i]; }); if (pageY) window.scrollTo(0, pageY); };
    put();
    requestAnimationFrame(put);                       // после отрисовки высота могла дорасти — ставим ещё раз
  }
}

// ---------- point network checks (Пинг / Веб-интерфейс / Зайти) ----------
// Shared by the calendar's "Точки на день" list (app.js) and the "Все
// АПК" directory page (apk.js) — same three buttons, same backend
// endpoints (app/api/routes_points.py).

// Point statuses are a managed dictionary now (app/api/routes_point_statuses.py,
// "Настройки → Статусы АПК") — pointStatusBadge reads colours from a cache
// populated by loadPointStatuses(), called once at each page's boot(), so a
// custom status looks as good as the built-in ones instead of falling back
// to grey.
let _pointStatusCache = {};
async function loadPointStatuses() {
  try {
    const list = await Api.get('/api/point-statuses');
    _pointStatusCache = {};
    list.forEach((s) => { _pointStatusCache[s.name] = s; });
  } catch { /* keep whatever was last loaded; badges fall back to grey */ }
  return _pointStatusCache;
}
// «Частично на складе» — не статус, а подпись: у комплекса со статусом «На
// складе» часть компонентов не на складе (сервер отдаёт p.stock_partial). Цвет
// остаётся цветом «На складе» из «Настройки → Статусы АПК».
const STOCK_PARTIAL_LABEL = 'Частично на складе';
// Пустой статус (точка ни разу не проверялась — например, не указаны SIM и IP).
const UNKNOWN_STATUS = 'Не известно';
const statusLabel = (status, partial) => (partial && status === 'На складе' ? STOCK_PARTIAL_LABEL : status);
// Что именно из комплекса «Частично на складе» лежит на складе, а что нет (сервер отдаёт p.stock_in / p.stock_out только для таких
// комплексов). Показывается в карточке комплекса: в списке «Все АПК», в окне на карте, в календаре и в форме правки.
function stockPartialNoteHtml(p) {
  if (!p || !p.stock_partial) return '';
  const names = (list) => (list || []).map((n) => esc(n)).join(', ');
  const inn = names(p.stock_in), out = names(p.stock_out);
  return `<div class="lc-stock mt-1.5 rounded-lg px-2.5 py-1.5 text-[11px] leading-snug" title="Комплекс со статусом «На складе», у которого не все компоненты лежат на складе">
    <b>📦 Частично на складе</b>
    ${inn ? `<br><span>На складе: <b>${inn}</b></span>` : ''}${out ? `<br><span>Не на складе: ${out}</span>` : ''}</div>`;
}
// То же одной строкой — для выноски и подсказки на карте.
function stockPartialText(p) {
  if (!p || !p.stock_partial) return '';
  const inn = (p.stock_in || []).join(', '), out = (p.stock_out || []).join(', ');
  return `Частично на складе${inn ? ': на складе — ' + inn : ''}${out ? '; не на складе — ' + out : ''}`;
}
const pointStatusBadge = (status, partial = false) => status
  ? `<span class="inline-flex items-center text-[11px] font-medium px-2 py-0.5 rounded-full text-white shrink-0" style="background:${(_pointStatusCache[status] && _pointStatusCache[status].color) || '#64748b'}">${esc(statusLabel(status, partial))}</span>`
  : '';

// Labeled health-status indicator (dot + text) for the "Все АПК" list —
// the four states a dispatcher actually cares about at a glance: green
// (доступен), amber (есть только пинг), red (недоступен), grey (нет
// данных — never checked). Any other set status (a manual inventory state
// like "На складе"/"Демонтирована", which the health
// check deliberately skips) is shown by its own name and dictionary colour.
const POINT_HEALTH_LABEL = { 'Работает': 'Есть доступ', 'Есть только пинг': 'Есть только пинг', 'Не работает': 'Нет доступа' };
const POINT_HEALTH_DOT_COLOR = { 'Работает': 'bg-emerald-500', 'Есть только пинг': 'bg-amber-400', 'Не работает': 'bg-rose-500' };
function pointHealthIndicator(status, partial = false) {
  if (status && !POINT_HEALTH_LABEL[status]) {
    // Любой другой заданный статус («На складе» — с подписью «Частично…», если
    // не все компоненты на складе, «Установлен», «Нет питания»…) показываем его же названием и цветом из
    // «Настройки → Статусы АПК», а не безликим «Не известно».
    const color = (_pointStatusCache[status] && _pointStatusCache[status].color) || '#64748b';
    const label = statusLabel(status, partial);
    return `<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0 whitespace-nowrap" title="${esc(label)}">
      <span class="inline-block h-2.5 w-2.5 rounded-full" style="background:${color}"></span>${esc(label)}
    </span>`;
  }
  const label = POINT_HEALTH_LABEL[status] || UNKNOWN_STATUS;
  const color = POINT_HEALTH_DOT_COLOR[status] || 'bg-slate-500';
  return `<span class="inline-flex items-center gap-1.5 text-[11px] text-slate-400 shrink-0 whitespace-nowrap" title="${esc(status || UNKNOWN_STATUS)}">
    <span class="inline-block h-2.5 w-2.5 rounded-full ${color}"></span>${esc(label)}
  </span>`;
}

// "N дней/часов" — points_repository.search_points's port_down_since is
// an ISO timestamp of when the point's port (or plain ping, if it has no
// port) last started failing. Used on the "Все АПК" list next to a point
// whose port is unreachable, and for the "дольше всех не работает" sort.
// «проверено 3 мин назад» — когда проверка доступности последний раз обошла точку.
function formatCheckedAgo(iso) {
  if (!iso) return '';
  const ms = Date.now() - new Date(iso).getTime();
  if (!(ms >= 0)) return '';
  const min = Math.floor(ms / 60000);
  if (min < 1) return 'проверено только что';
  if (min < 60) return `проверено ${min} мин назад`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `проверено ${hours} ч назад`;
  return `проверено ${Math.floor(hours / 24)} дн назад`;
}

function formatDowntime(portDownSince) {
  if (!portDownSince) return '';
  const ms = Date.now() - new Date(portDownSince).getTime();
  if (!(ms > 0)) return '';
  const hours = Math.floor(ms / 3600000);
  if (hours < 1) return 'меньше часа';
  const days = Math.floor(hours / 24);
  if (days < 1) return `${hours} ч`;
  const restHours = hours % 24;
  return `${days} дн${restHours ? ' ' + restHours + ' ч' : ''}`;
}

// "Поверка до …" badge — green if still valid, red if the date has
// passed, nothing at all if never set (missing isn't itself alarming,
// just unknown — see the apk-certificate filter for finding those on
// purpose). verification_valid_until is always "YYYY-MM-DD" or "" — a
// plain string compare against today's ISO date works for the
// expired check, but always shown to a person as "ДД-ММ-ГГГГ" (see
// excel_service.py's _cert_date/_format_cert_date for the same rule on
// the import/export side).
function certificateBadgeHtml(verificationValidUntil) {
  if (!verificationValidUntil) return '';
  const today = new Date().toISOString().slice(0, 10);
  const expired = verificationValidUntil < today;
  const cls = expired ? 'text-rose-400' : 'text-emerald-400';
  return `<br><span class="${cls}">Поверка до ${esc(fmtDate(verificationValidUntil))}${expired ? ' (истёк)' : ''}</span>`;
}

// Multi-select filter chips — several can be active at once (OR'd server-
// side, see points_repository.search_points). `selected` is a Set of
// string values; the caller re-renders on change. Used for the category/
// status filters on "Все АПК" and "Склад".
function filterChipsHtml(name, options, selected) {
  return options.map(({ value, label, color }) => `<button type="button" data-chip="${esc(name)}" data-chip-value="${esc(value)}" class="rounded-lg px-2.5 py-1 text-xs font-medium transition-colors ${selected.has(value) ? 'bg-indigo-500 text-white' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300'}">${color ? `<span class="inline-block h-2 w-2 rounded-full mr-1.5 align-middle" style="background:${esc(color)}"></span>` : ''}${esc(label)}</button>`).join('');
}

// Подписанные группы фильтров («Категория», «Статус»…): каждая — отдельная
// строка с названием слева и чипами справа, все вместе в одной рамке, чтобы
// фильтры по категориям и по статусам не сливались в одну кучу кнопок.
// `attrs` — атрибуты контейнера чипов (id=… / data-…), который вызывающий код
// перерисовывает сам.
function filterRowHtml(label, chipsHtml, attrs = '') {
  return `<div class="flex items-start gap-3 px-3 py-2">
    <span class="w-[4.5rem] shrink-0 pt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">${esc(label)}</span>
    <div ${attrs} class="flex flex-wrap items-center gap-1.5 min-w-0 flex-1">${chipsHtml}</div>
  </div>`;
}
const filterPanelHtml = (rowsHtml) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/20 divide-y divide-slate-700/40">${rowsHtml}</div>`;

// Wires every `[data-chip="name"]` button inside `container` — clicking
// toggles its value in `selected` and calls onChange(). Direct .onclick
// assignment (not addEventListener), same reasoning as wirePointNetButtons:
// callers re-render the same persistent container repeatedly.
function wireFilterChips(container, name, selected, onChange) {
  container.querySelectorAll(`[data-chip="${name}"]`).forEach((btn) => {
    btn.onclick = () => {
      const v = btn.dataset.chipValue;
      if (selected.has(v)) selected.delete(v); else selected.add(v);
      onChange();
    };
  });
}

// Проверки живут дольше одного рендера: apk.js/app.js перерисовывают
// список точек на каждое изменение фильтра/поиска, стирая innerHTML — без
// этого кэша результат «мигал» и пропадал почти сразу же, хотя реально
// должен быть виден 10 секунд. Ключ — id точки, значение — что показывать
// и когда результат считается устаревшим.
const _netResultCache = {};
const NET_RESULT_TTL_MS = 10000;
// Список точек (apk.js/app.js/monitoring.js) перерисовывается заново каждые
// 5с живым опросом — если он попадёт ровно на момент, пока идёт проверка
// пинга/порта, старые DOM-узлы (btn/resultEl), которые runNetCheck держит в
// замыкании, отсоединяются от документа, и итог проверки пишется "в никуда":
// кнопка выглядит как будто молча вернулась в исходное состояние, а на
// самом деле результат просто ушёл в невидимый узел. _netCheckPending
// делает состояние "идёт проверка" видимым через сам HTML (переживает
// любой ре-рендер), а на запись результата ищем актуальный узел заново.
const _netCheckPending = {}; // pointId -> Set('ping'|'port')

function _isNetCheckPending(pointId, kind) {
  return !!_netCheckPending[pointId]?.has(kind);
}

function _netResultSpanHtml(pointId) {
  if (_netCheckPending[pointId]?.size) {
    return `<span data-netresult="${esc(pointId)}" class="text-xs text-slate-400">Проверка…</span>`;
  }
  const cached = _netResultCache[pointId];
  if (cached && cached.expiresAt > Date.now()) {
    return `<span data-netresult="${esc(pointId)}" class="${esc(cached.className)}">${esc(cached.text)}</span>`;
  }
  delete _netResultCache[pointId];
  return `<span data-netresult="${esc(pointId)}" class="text-xs text-slate-500"></span>`;
}

function pointNetButtonsHtml(p) {
  const pingPending = _isNetCheckPending(p.id, 'ping');
  const portPending = _isNetCheckPending(p.id, 'port');
  return `<div class="flex items-center gap-1.5 flex-wrap" data-no-brick>
    <button data-perm="points.network" data-ping="${esc(p.id)}" ${pingPending ? 'disabled' : ''} class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors">📡 ${pingPending ? 'Проверка…' : 'Пинг'}</button>
    <button data-perm="points.network" data-checkport="${esc(p.id)}" ${portPending ? 'disabled' : ''} class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors">🌐 ${portPending ? 'Проверка…' : 'Веб-интерфейс'}</button>
    <button data-perm="points.network" data-openweb="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" ${p.ip_address ? '' : 'disabled title="У точки не указан IP-адрес"'}>↗ Зайти на веб-интерфейс</button>
    ${_netResultSpanHtml(p.id)}
  </div>`;
}

async function runNetCheck(pointId, kind) {
  const btnSelector = `[data-${kind === 'ping' ? 'ping' : 'checkport'}="${CSS.escape(pointId)}"]`;
  (_netCheckPending[pointId] ??= new Set()).add(kind);
  delete _netResultCache[pointId];
  const liveBtn = document.querySelector(btnSelector);
  const liveResultEl = document.querySelector(`[data-netresult="${CSS.escape(pointId)}"]`);
  if (liveBtn) { liveBtn.disabled = true; liveBtn.textContent = (kind === 'ping' ? '📡 ' : '🌐 ') + 'Проверка…'; }
  if (liveResultEl) { liveResultEl.textContent = ''; liveResultEl.className = 'text-xs text-slate-500'; }
  try {
    const res = await Api.get(`/api/points/${encodeURIComponent(pointId)}/${kind === 'ping' ? 'ping' : 'check-port'}`);
    const latency = res.latency_ms != null ? ` (${res.latency_ms.toFixed(0)} мс)` : '';
    const text = (res.ok ? '✓ ' : '✗ ') + res.detail + latency;
    const className = `text-xs ${res.ok ? 'text-emerald-400' : 'text-rose-400'}`;
    _netResultCache[pointId] = { text, className, expiresAt: Date.now() + NET_RESULT_TTL_MS };
  } catch (err) {
    _netResultCache[pointId] = { text: 'Ошибка: ' + err.message, className: 'text-xs text-rose-400', expiresAt: Date.now() + NET_RESULT_TTL_MS };
  } finally {
    _netCheckPending[pointId]?.delete(kind);
    if (_netCheckPending[pointId] && !_netCheckPending[pointId].size) delete _netCheckPending[pointId];
    // Ищем узлы заново (не переиспользуем btn/liveResultEl выше) — за время
    // ожидания ответа список мог перерисоваться, и старые узлы уже не те,
    // что сейчас в документе.
    const btn = document.querySelector(btnSelector);
    const resultEl = document.querySelector(`[data-netresult="${CSS.escape(pointId)}"]`);
    const cached = _netResultCache[pointId];
    if (btn) { btn.disabled = false; btn.textContent = kind === 'ping' ? '📡 Пинг' : '🌐 Веб-интерфейс'; }
    if (resultEl && cached) { resultEl.textContent = cached.text; resultEl.className = cached.className; }
    setTimeout(() => {
      if (_netResultCache[pointId]?.expiresAt > Date.now()) return; // перезаписали новой проверкой
      delete _netResultCache[pointId];
      const el = document.querySelector(`[data-netresult="${CSS.escape(pointId)}"]`);
      if (el) { el.textContent = ''; el.className = 'text-xs text-slate-500'; }
    }, NET_RESULT_TTL_MS);
  }
}

// Opens the point's own web interface (its camera/DVR management page).
// "Старый" (category_is_legacy) complexes don't have a modern web UI — их
// настройки живут в Windows на самом комплексе, куда попадают по RDP.
// Реальные веб-морды комплексов (камеры, СКАТ-ПП, Пульсар — проверено на
// сохранённых страницах входа) — это свои формы логина на JS (AJAX-запрос
// на ?r=login и т.п.), а не HTTP Basic Auth. Подставить логин/пароль в URL
// вида http://login:password@ip/ бесполезно (и вызывает ошибку входа —
// сервер получает эти данные не так, как их ждёт форма) и не сработает:
// со своей страницы нельзя дотянуться в DOM чужого источника (ip-адреса
// комплекса), чтобы заполнить поля за пользователя. Единственный
// работающий путь — обычная ссылка + автозаполнение самого браузера
// (сохранённый пароль подставится, как на любом сайте, после первого
// ручного входа с сохранением) — здесь только помогаем: пароль тихо
// уходит в буфер обмена как подстраховка на первый раз/на новом профиле,
// без всплывающих окон, чтобы не мешать обычному одноклику.
// Копирование в буфер обмена, которое не зависит ни от фокуса страницы, ни от «защищённого контекста»: сначала синхронно через
// execCommand (работает и по http://IP, и сразу после клика), потом — Clipboard API. Вызывать прямо в обработчике клика. Раньше
// пароль копировался ПОСЛЕ window.open: фокус уже уходил в новую вкладку, и браузер молча отказывал в записи в буфер.
function copyToClipboardNow(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0;pointer-events:none';
    document.body.appendChild(ta);
    ta.focus({ preventScroll: true });
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch { return false; }
}

function copyToClipboard(text) {
  if (copyToClipboardNow(text)) return Promise.resolve(true);
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
  return Promise.resolve(false);
}

// Короткое сообщение внизу по центру (не блокирует работу, как alert).
function showToast(html, ms = 4000) {
  let box = document.getElementById('appToast');
  if (!box) {
    box = document.createElement('div');
    box.id = 'appToast';
    box.style.cssText = 'position:fixed;left:50%;bottom:1.25rem;transform:translateX(-50%);z-index:60;max-width:min(92vw,520px)';
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = 'glass rounded-2xl shadow-2xl px-4 py-2.5 text-sm mt-2';
  el.innerHTML = html;
  box.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function openPointWebInterface(point) {
  if (!point || !point.ip_address) { alert('У точки не указан IP-адрес'); return; }
  if (point.category_is_legacy) { openLegacyPointRdp(point); return; }
  const port = (point.port || '').trim();
  // Пароль — в буфер ДО открытия вкладки (после window.open фокус уходит в неё, и копирование не проходит).
  const copying = point.password ? copyToClipboard(point.password) : null;
  window.open(`http://${point.ip_address}${port ? ':' + port : ''}/`, '_blank', 'noopener');
  if (copying) {
    copying.then((ok) => showToast(
      ok ? '🔑 Пароль комплекса скопирован — вставьте его в окне входа (Ctrl+V)'
         : `⚠ Пароль не скопировался сам. Скопируйте вручную: <b style="user-select:all">${esc(point.password)}</b>`,
      ok ? 4000 : 20000,
    ));
  }
}

// «Старый» комплекс — веб-интерфейса нет, вход только через Windows на
// самом комплексе по RDP, на порту, указанном в поле «Порт» точки (у
// старых комплексов это поле не занято под веб-интерфейс, как у новых, —
// используется как порт RDP; без него mstsc стучится в 3389 по умолчанию,
// а этот порт обычно другой, отсюда и «не пускает»). Из браузера нельзя
// ни запустить RDP-клиент, ни вписать пароль в его окно за пользователя
// (Windows шифрует пароль в .rdp-файле ключом, привязанным к конкретному
// компьютеру/учётке — сервер в принципе не может сгенерировать такой блок
// для чужой машины). Поэтому максимум, что можно сделать отсюда: скачать
// .rdp с уже подставленными адресом/портом/логином и скопировать пароль в
// буфер обмена, чтобы его оставалось только вставить в окно входа Windows.
async function openLegacyPointRdp(point) {
  const port = (point.port || '').trim();
  const address = point.ip_address + (port ? ':' + port : '');
  // Подключение сразу на весь экран: screen mode id:i:2 — полноэкранный режим (разрешение берётся по монитору, поэтому
  // desktopwidth/desktopheight не задаются), use multimon:i:0 — только основной монитор, smart sizing — картинка
  // подгоняется под окно, dynamic resolution — разрешение следует за размером окна (где сервер это умеет).
  const lines = [
    'screen mode id:i:2', 'use multimon:i:0', 'smart sizing:i:1', 'dynamic resolution:i:1',
    'full address:s:' + address, 'prompt for credentials:i:1', 'authentication level:i:0',
  ];
  if (point.login) lines.splice(5, 0, 'username:s:' + point.login);
  const blob = new Blob([lines.join('\r\n')], { type: 'application/x-rdp' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${point.id || 'rdp'}.rdp`;
  a.click();
  URL.revokeObjectURL(a.href);
  if (!point.password) {
    alert('Скачан RDP-файл для подключения к комплексу — откройте его.');
    return;
  }
  if (await copyToClipboard(point.password)) {
    alert('Скачан RDP-файл — откройте его для подключения. Пароль скопирован в буфер обмена: вставьте его в окне входа Windows (ввести его автоматически RDP не даёт — так устроено шифрование пароля в .rdp-файлах).');
  } else {
    alert(`Скачан RDP-файл — откройте его для подключения. Буфер обмена недоступен, пароль: ${point.password}`);
  }
}

// Wires the three network buttons within a container via direct .onclick
// assignment (not addEventListener) — callers like apk.js's renderApkList()
// re-run this against the SAME persistent container element on every
// keystroke (only its innerHTML is replaced), and addEventListener-based
// delegation would stack a new listener on every call; plain .onclick
// always overwrites instead, so it's safe to call repeatedly.
// В карточке комплекса: если он связан общей SIM с другими («Уведомления → Ошибки данных → Связанные комплексы»), показываем
// с какими — смена номера SIM здесь поменяет его и у них. Заполняет блок #simLinkNote формы; ошибки молча игнорируются.
async function showSimLinkNote(pointId) {
  const box = document.getElementById('simLinkNote');
  if (!box || !pointId) return;
  try {
    const res = await Api.get(`/api/points/${encodeURIComponent(pointId)}/sim-links`);
    if (!res.linked.length || !document.getElementById('simLinkNote')) return;
    box.innerHTML = `🔗 Этот комплекс связан общей SIM с: <b>${res.linked.map((x) => esc(x.id)).join(', ')}</b>. Если поменять здесь номер SIM, он поменяется и у них. Очистка номера выведет комплекс из связки.`;
    box.classList.remove('hidden');
  } catch { /* подсказка не критична */ }
}

function wirePointNetButtons(container, pointsById) {
  container.querySelectorAll('[data-ping]').forEach((btn) => {
    btn.onclick = () => runNetCheck(btn.dataset.ping, 'ping');
  });
  container.querySelectorAll('[data-checkport]').forEach((btn) => {
    btn.onclick = () => runNetCheck(btn.dataset.checkport, 'port');
  });
  container.querySelectorAll('[data-openweb]').forEach((btn) => {
    btn.onclick = () => openPointWebInterface(pointsById(btn.dataset.openweb));
  });
}

// ---------- visit reports (задание → что сделано на точке) ----------
// Shared by app.js's visitReportForm (opened from a task card) and the
// point card's "История" journal viewer in apk.js/warehouse.js — mirrors
// app/repositories/task_visit_reports_repository.py's constants exactly.
// Типы выездов — управляемый справочник («Настройки → Типы выездов», таблица
// work_types): эти значения только запасные до первой загрузки, а
// loadWorkTypes() (вызывается в boot() страницы) подменяет их на актуальные
// ПРЯМО В ЭТИХ ЖЕ массивах, чтобы ссылки на них не терялись.
const VISIT_TYPES = [
  'Опиловка', 'Ремонт', 'Юстировка', 'Проверка точки подключения', 'Инвентаризация',
  'Подключение кабеля', 'Совместный выезд', 'Замер зон фиксации', 'Установка', 'Демонтаж',
  'Вспомогательная точка',
];
// «Вспомогательная точка» — метка с информацией на карте бригады («откуда подключать SIP до
// комплекса»): живёт только в задании своего дня, в справочник «Все АПК» не попадает и монтёру в
// боте как точка работы не показывается (см. app/core/work_types.py).
const AUX_TYPE = 'Вспомогательная точка';
const isAuxTask = (t) => !!t && t.type === AUX_TYPE;
const RESULT_STATUSES = ['Работает', 'Не работает', 'Демонтирован', 'Установлен'];
// Типы, связанные с ремонтом: у них в отчёте есть «что сняли / что поставили».
const EQUIPMENT_VISIT_TYPES = new Set(['Ремонт', 'Установка', 'Подключение кабеля', 'Демонтаж']);
// «Статусы выезда» не связанных с ремонтом типов («Найден» / «Не найден»…) —
// итог ручного отчёта у такого типа выбирается из них, а не из RESULT_STATUSES
// (те — для типов, связанных с ремонтом, и для типов без своих статусов).
const WORK_TYPE_OUTCOMES = {};
async function loadWorkTypes() {
  try {
    const list = await Api.get('/api/work-types');
    if (!list.length) return list;
    VISIT_TYPES.splice(0, VISIT_TYPES.length, ...list.map((t) => t.name));
    EQUIPMENT_VISIT_TYPES.clear();
    list.filter((t) => t.is_repair).forEach((t) => EQUIPMENT_VISIT_TYPES.add(t.name));
    Object.keys(WORK_TYPE_OUTCOMES).forEach((k) => delete WORK_TYPE_OUTCOMES[k]);
    list.filter((t) => !t.is_repair && (t.outcomes || []).length).forEach((t) => { WORK_TYPE_OUTCOMES[t.name] = [...t.outcomes]; });
    return list;
  } catch { return []; /* остаются прежние значения */ }
}

// Питание комплекса: два взаимоисключающих флажка «СЭС» / «Электросеть» (оба
// сняты — не указано; бот тогда спросит у монтёра). Общая для форм точки в
// календаре и на «Все АПК»; значение читается readPowerSource(form).
function powerSourceFieldHtml(value) {
  return `<div class="${labelCls} col-span-2">Питание
    <div class="flex items-center gap-5 pt-1" data-power-field>
      ${['СЭС', 'Электросеть'].map((v) => `<label class="flex items-center gap-1.5 text-sm text-slate-200 font-normal">
        <input type="checkbox" data-power="${v}" class="rounded accent-indigo-500" ${value === v ? 'checked' : ''}> ${v}
      </label>`).join('')}
    </div>
  </div>`;
}
function wirePowerSourceField(form) {
  form.querySelectorAll('[data-power]').forEach((box) => {
    box.onchange = () => {
      if (box.checked) form.querySelectorAll('[data-power]').forEach((o) => { if (o !== box) o.checked = false; });
    };
  });
}
const readPowerSource = (form) => form.querySelector('[data-power]:checked')?.dataset.power || '';

// Mirrors app/repositories/task_visit_reports_repository.py's EXPORT_FIELDS
// exactly (key, label, in export column order) — the field picker for the
// "история ремонта" Excel export on /stats.
const VISIT_EXPORT_FIELDS = [
  ['created_at', 'Дата/время'], ['point_id', 'Комплекс'], ['point_address', 'Адрес'],
  ['category_name', 'Категория'], ['inventory_number', 'Инвентарный номер'],
  ['visit_type', 'Тип выезда'], ['result_status', 'Статус'], ['outcome', 'Статус выезда'], ['comment', 'Комментарий'],
  ['equipment_removed', 'Снято оборудование'], ['equipment_installed', 'Установлено оборудование'],
  ['sim_removed', 'SIM снята'], ['sim_removed_state', 'Состояние снятой SIM'], ['sim_installed', 'SIM установлена'],
  ['fault', 'Что неисправно'], ['needs', 'Что нужно для исправления'],
  ['created_by', 'Исполнитель'],
];

// Mirrors app/repositories/monitoring_repository.py's EXPORT_FIELDS exactly
// (key, label, in export column order) — the field picker for the «Итоги
// по комплексам» Excel export on /reports.
const POINT_SUMMARY_EXPORT_FIELDS = [
  ['date', 'Дата'], ['crew_label', 'Бригада'], ['point_id', 'Комплекс'], ['point_address', 'Адрес'], ['power_source', 'Тип питания'],
  ['work', 'Что нужно сделать (план)'], ['visit_type', 'Тип выезда'],
  ['comment', 'Что сделано (комментарий)'], ['result_status', 'Статус (работает/не работает)'],
  ['outcome', 'Статус выезда'], ['equipment_removed', 'Снято оборудование'], ['equipment_installed', 'Установлено оборудование'],
  ['sim_removed', 'SIM снята'], ['sim_removed_state', 'Состояние снятой SIM'], ['sim_installed', 'SIM установлена'],
  ['fault', 'Что неисправно'], ['needs', 'Что нужно для исправления'],
  ['created_by', 'Исполнитель'],
];

// Быстрая правка ИТОГОВОГО ТИПА выезда в готовом отчёте — когда монтёр случайно включил режим ремонта, а был,
// например, замер зон фиксации: в отчётах и выгрузках светилось «… + Ремонт». Меняется только тип в отчёте
// (статус, комментарий и состояние комплекса не трогаются). `report` — запись отчёта (task_id, point_id, visit_type);
// `onDone` вызывается после сохранения. Доступно диспетчеру и админу.
function openVisitTypeEditor(report, onDone) {
  const stored = report.visit_type || '';
  const storedRepair = / \+ Ремонт$/.test(stored);
  const storedBase = stored.replace(/ \+ Ремонт$/, '');
  const names = VISIT_TYPES.filter((n) => n !== 'Вспомогательная точка');
  if (storedBase && !names.includes(storedBase)) names.push(storedBase);
  modal(`<h2 class="font-display text-lg font-bold mb-1">Итоговый тип выезда</h2>
    <p class="text-xs text-slate-400 mb-4">${esc(report.point_id || '')} · сейчас в отчёте: <b>${esc(stored || '—')}</b></p>
    <form id="vtEditForm" class="space-y-3">
      <label class="${labelCls}">Тип выезда<select name="vt" class="${fieldCls}">
        ${names.map((n) => `<option value="${esc(n)}" ${n === storedBase ? 'selected' : ''}>${esc(n)}</option>`).join('')}
      </select></label>
      <label id="vtEditRepair" class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" name="repair" class="rounded accent-indigo-500" ${storedRepair ? 'checked' : ''}> был ремонт (записать «… + Ремонт»)</label>
      <p class="text-[11px] text-slate-500">Меняется только тип в этом отчёте — статус комплекса, комментарий и оборудование остаются как были.</p>
      <div id="vtEditError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-1">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);
  const f = $('#vtEditForm').elements;
  const sync = () => $('#vtEditRepair').classList.toggle('hidden', EQUIPMENT_VISIT_TYPES.has(f.vt.value));
  f.vt.onchange = sync;
  sync();
  $('#vtEditForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await Api.put('/api/task-visit-reports/' + encodeURIComponent(report.task_id) + '/visit-type', {
        visit_type: f.vt.value, with_repair: !EQUIPMENT_VISIT_TYPES.has(f.vt.value) && f.repair.checked,
      });
      if (onDone) await onDone(); else close();
    } catch (err) {
      $('#vtEditError').textContent = err.message;
      $('#vtEditError').classList.remove('hidden');
    }
  };
}

// Read-only journal of past visit reports for one point — "остаётся только
// в журнале истории выезда" for a demontage, and generally useful for any
// point. Reuses the page's own modal()/close(); the "Закрыть" button is
// wired by modal() itself via the .cancel class.
async function openVisitJournal(pointId) {
  let reports;
  try { reports = await Api.get('/api/task-visit-reports/by-point/' + encodeURIComponent(pointId) + '?limit=1000'); }
  catch (e) { alert('Не удалось загрузить журнал: ' + e.message); return; }
  let state = null;
  try { state = await Api.get('/api/task-visit-reports/point-state/' + encodeURIComponent(pointId)); } catch { /* верх журнала — не критично */ }
  // Записи, загруженные из Excel («Документы → История выездов из Excel»), может удалить диспетчер/админ.
  const canDeleteImported = can('reports.edit');
  const block = (label, text, tone) => `<div class="mt-2 rounded-lg border px-2.5 py-1.5 ${tone}">
      <div class="text-[11px] font-semibold uppercase tracking-wide opacity-80">${esc(label)}</div>
      <div style="white-space:pre-wrap">${esc(text)}</div></div>`;
  const statusBadge = (r) => {
    const st = r.outcome || r.result_status;
    if (!st) return '';
    const tone = st === 'Не работает' ? 'bg-rose-500/15 text-rose-300' : st === 'Работает' ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700/60 text-slate-200';
    return `<span class="ml-1 rounded px-1.5 py-0.5 text-[11px] font-medium ${tone}" title="${r.outcome ? 'Статус выезда' : 'Статус комплекса после выезда'}">${esc(st)}</span>`;
  };
  const rowHtml = (r) => {
    // У загруженной записи времени суток нет — только дата.
    const when = r.imported ? fmtDate(r.created_at) : fmtDateTime(r.created_at);
    const who = r.created_by ? (r.imported ? 'Кто выезжал: ' : 'Исполнитель: ') + esc(r.created_by) : '';
    return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 text-sm">
        <div class="flex items-start justify-between gap-2">
          <div><b>${esc(r.visit_type)}</b>${r.imported ? ` <span class="ml-1 rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-700/60 text-slate-300" title="${r.source === 'forms' ? 'Отчёт из таблицы Яндекс Форм (задания на этот день не было)' : 'Запись загружена из Excel (история выездов)'}">${r.source === 'forms' ? 'из Яндекс Формы' : 'из архива'}</span>` : ''}${statusBadge(r)}</div>
          <span class="flex items-center gap-2 shrink-0">
            <span class="text-xs text-slate-400">${esc(when)}</span>
            ${canDeleteImported ? `<button type="button" data-edit-vtype="${esc(r.task_id)}" class="rounded-lg px-1.5 text-xs bg-slate-700/60 text-slate-300 hover:bg-slate-600/60" title="Изменить итоговый тип выезда">✎</button>` : ''}
            ${r.imported && canDeleteImported ? `<button type="button" data-del-imported="${esc(r.task_id)}" class="rounded-lg px-1.5 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25" title="Удалить эту загруженную запись">×</button>` : ''}
          </span>
        </div>
        ${who ? `<div class="text-xs text-slate-400 mt-0.5">${who}</div>` : ''}
        ${r.comment ? block(r.imported ? 'Что сделано / комментарий' : 'Комментарий', r.comment, 'border-slate-700/50 bg-slate-900/30 text-slate-200') : ''}
        ${r.fault ? block('Из-за чего не работало / не работает', r.fault, 'border-rose-500/30 bg-rose-500/10 text-rose-100') : ''}
        ${r.needs ? block('Что нужно для восстановления', r.needs, 'border-amber-500/30 bg-amber-500/10 text-amber-100') : ''}
        ${r.equipment_removed || r.equipment_installed ? `<div class="text-xs text-slate-500 mt-2">${r.equipment_removed ? 'Снято: ' + esc(r.equipment_removed) : ''}${r.equipment_removed && r.equipment_installed ? ' · ' : ''}${r.equipment_installed ? 'Установлено: ' + esc(r.equipment_installed) : ''}</div>` : ''}
        ${r.sim_removed || r.sim_installed ? `<div class="text-xs text-slate-500 mt-1">SIM-карта: ${r.sim_removed ? 'снята ' + esc(r.sim_removed) + (r.sim_removed_state ? ' (' + (r.sim_removed_state === 'working' ? 'рабочая' : 'нерабочая') + ')' : '') : ''}${r.sim_removed && r.sim_installed ? ' → ' : ''}${r.sim_installed ? 'установлена ' + esc(r.sim_installed) : ''}</div>` : ''}
      </div>`;
  };
  // Верх журнала: что с комплексом сейчас и — если он не работает — почему и что нужно для восстановления (из последнего отчёта).
  let head = '';
  if (state && state.status && state.status !== 'Работает') {
    const lf = state.last_fault;
    head = `<div class="mb-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm">
        <div><b>Сейчас: ${esc(state.status)}</b>${state.down_since ? ` <span class="text-slate-400 text-xs">· с ${esc(fmtDateTime(state.down_since))}</span>` : ''}</div>
        ${lf ? `${lf.fault ? `<div class="mt-1"><span class="text-slate-400">Причина:</span> <span style="white-space:pre-wrap">${esc(lf.fault)}</span></div>` : ''}
          ${lf.needs ? `<div class="mt-0.5"><span class="text-slate-400">Что нужно для восстановления:</span> <span style="white-space:pre-wrap">${esc(lf.needs)}</span></div>` : ''}
          <div class="text-xs text-slate-500 mt-1">Из отчёта от ${esc(lf.imported ? fmtDate(lf.created_at) : fmtDateTime(lf.created_at))}${lf.created_by ? ' · ' + esc(lf.created_by) : ''}</div>`
          : '<div class="text-xs text-slate-400 mt-1">Причина и «что нужно для восстановления» в отчётах после последнего «Работает» не записаны.</div>'}
      </div>`;
  }
  modal(`<h2 class="font-display text-lg font-bold mb-1">История выездов · ${esc(pointId)}</h2>
    <p class="text-xs text-slate-500 mb-3">${reports.length ? `Записей: ${reports.length} (новые сверху)` : ''}</p>
    ${head}
    <div class="space-y-2">
      ${reports.map(rowHtml).join('') || '<p class="text-sm text-slate-500 text-center py-6">Отчётов пока нет</p>'}
    </div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`, { wide: true });
  document.querySelectorAll('#modal [data-edit-vtype]').forEach((btn) => {
    btn.onclick = () => {
      const rep = reports.find((x) => x.task_id === btn.dataset.editVtype);
      if (rep) openVisitTypeEditor(rep, () => openVisitJournal(pointId));
    };
  });
  document.querySelectorAll('#modal [data-del-imported]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Удалить эту запись из истории выездов?')) return;
      try { await Api.del('/api/visit-history/' + encodeURIComponent(btn.dataset.delImported)); await openVisitJournal(pointId); }
      catch (err) { alert(err.message); }
    };
  });
}

// "Категория" combobox: free-text input with a live-search dropdown of
// existing dictionary entries (name + colour swatch); picking one or
// typing an exact existing name hides the colour picker (reuses that
// entry's colour), typing a new name reveals it so a colour can be
// chosen for the entry that'll be created on save. Mirrors the pattern
// from the Sklad warehouse app's category/status pickers.
function setupCategoryCombobox(input, resultsBox, colorRow, colorInput, opts) {
  const searchUrl = (opts && opts.searchUrl) || '/api/point-categories/search';
  let cache = [];
  let debounceTimer;

  function exactMatch() {
    const q = input.value.trim().toLowerCase();
    if (!q) return null;
    return cache.find((c) => c.name.toLowerCase() === q) || null;
  }

  function updateColorVisibility() {
    const match = exactMatch();
    if (match) {
      colorRow.classList.add('hidden');
      colorInput.value = match.color;
    } else if (input.value.trim()) {
      colorRow.classList.remove('hidden');
    } else {
      colorRow.classList.add('hidden');
    }
  }

  function renderResults(items) {
    cache = items;
    if (!items.length) {
      resultsBox.classList.add('hidden');
      resultsBox.innerHTML = '';
      return;
    }
    resultsBox.innerHTML = items.map((c) => `
      <div data-name="${esc(c.name)}" data-color="${esc(c.color)}"
           class="px-3 py-1.5 text-sm cursor-pointer hover:bg-slate-700/60 flex items-center gap-2">
        <span class="inline-block w-2.5 h-2.5 rounded-full shrink-0" style="background:${c.color}"></span>${esc(c.name)}
      </div>`).join('');
    resultsBox.querySelectorAll('[data-name]').forEach((el) => {
      el.addEventListener('click', () => {
        input.value = el.dataset.name;
        colorInput.value = el.dataset.color;
        resultsBox.classList.add('hidden');
        resultsBox.innerHTML = '';
        updateColorVisibility();
        input.focus();
      });
    });
    resultsBox.classList.remove('hidden');
  }

  const runSearch = () => {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(async () => {
      const q = input.value.trim();
      try {
        const items = await Api.get(`${searchUrl}?q=${encodeURIComponent(q)}&limit=8`);
        renderResults(items);
      } catch { /* live search failing silently is fine — save still validates */ }
    }, 200);
  };

  input.addEventListener('input', () => { updateColorVisibility(); runSearch(); });
  input.addEventListener('focus', runSearch);
  document.addEventListener('click', (e) => {
    if (e.target !== input && !resultsBox.contains(e.target)) resultsBox.classList.add('hidden');
  });

  return {
    reset(name, color) {
      input.value = name || '';
      colorInput.value = color || '#6366f1';
      resultsBox.classList.add('hidden');
      resultsBox.innerHTML = '';
      updateColorVisibility();
    },
  };
}

// ---------- live dispatcher popups (every authenticated page) ----------
// Запросы к диспетчеру приходят карточками в правом нижнем углу, на любой странице:
//  * проверка комплекса — монтёр починил, пинг/порт отвечают, но человек должен подтвердить
//    (verification_requests_repository.py): «полностью работает» / «работает, но с замечанием —
//    отпустить» / «продолжить работу»;
//  * нет доступа к комплексу — решение по бригаде (access_issue_requests);
//  * запрос монтёра на демонтаж или «отпустить без ремонта» (demontage_requests).
// Опрос не зависит от того, что страница обновляет сама, а карточки — свои плавающие, а не общий
// modal(), чтобы не затирать форму, которую диспетчер как раз заполняет.
//
// Новая карточка сопровождается звуком и — если вкладка скрыта или окно не в фокусе — системным
// уведомлением браузера (как уведомление сайта: видно поверх других окон). Звук и уведомления
// включаются кнопкой-колокольчиком слева внизу (браузер разрешает их только по нажатию).
const DispatcherNotify = (function () {
  const LS_SOUND = 'notifySound', LS_DESKTOP = 'notifyDesktop';
  const flag = (key, def) => { try { const v = localStorage.getItem(key); return v === null ? def : v === '1'; } catch { return def; } };
  const setFlag = (key, on) => { try { localStorage.setItem(key, on ? '1' : '0'); } catch { /* приватный режим */ } };
  let ctx = null;

  function audioCtx() {
    if (ctx) return ctx;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    try { ctx = new AC(); } catch { ctx = null; }
    return ctx;
  }
  // Браузер разрешает звук только после действия пользователя на странице — «будим» его при первом нажатии.
  function unlock() {
    const c = audioCtx();
    if (c && c.state === 'suspended') c.resume().catch(() => {});
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, unlock, { passive: true }));

  // Короткий переливчатый сигнал из трёх нот (без звуковых файлов: сервер без интернета, всё рисуется само).
  function chime(urgent) {
    const c = audioCtx();
    if (!c) return false;
    if (c.state === 'suspended') c.resume().catch(() => {});
    if (c.state !== 'running') return false;
    const notes = urgent ? [988, 740, 988, 740, 988] : [659, 880, 1319];
    const t0 = c.currentTime + 0.02;
    notes.forEach((freq, i) => {
      const osc = c.createOscillator();
      const gain = c.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      const start = t0 + i * 0.2;
      gain.gain.setValueAtTime(0.0001, start);
      gain.gain.exponentialRampToValueAtTime(0.35, start + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.36);
      osc.connect(gain).connect(c.destination);
      osc.start(start);
      osc.stop(start + 0.4);
    });
    return true;
  }

  const desktopSupported = () => 'Notification' in window;
  const permission = () => (desktopSupported() ? Notification.permission : 'unsupported');

  function showDesktop(title, body, tag) {
    if (!flag(LS_DESKTOP, true) || permission() !== 'granted') return false;
    // Пока диспетчер смотрит на вкладку, достаточно карточки и звука.
    if (!document.hidden && document.hasFocus()) return false;
    try {
      const n = new Notification(title, { body, tag, requireInteraction: true, icon: '/static/apple-touch-icon.png' });
      n.onclick = () => { try { window.focus(); } catch { /* ignore */ } n.close(); };
      return true;
    } catch { return false; }
  }

  // Одну и ту же заявку не объявляем дважды: ни при переходе между страницами, ни из двух открытых вкладок —
  // кто первый заметил, тот и сигналит (отметка в localStorage, старые отметки чистятся).
  function claim(key) {
    try {
      const now = Date.now();
      const mark = 'ntf:' + key;
      if (localStorage.getItem(mark)) return false;
      localStorage.setItem(mark, String(now));
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('ntf:') && now - Number(localStorage.getItem(k)) > 86400000) localStorage.removeItem(k);
      }
    } catch { /* без localStorage — объявляем при каждом новом показе */ }
    return true;
  }

  function announce(key, title, body, urgent) {
    if (!claim(key)) return;
    if (flag(LS_SOUND, true)) chime(urgent);
    showDesktop(title, body, key);
  }

  async function askPermission() {
    if (!desktopSupported()) return 'unsupported';
    try { return await Notification.requestPermission(); } catch { return permission(); }
  }

  // ---- кнопка-колокольчик и маленькая панель настроек
  let bell = null, panel = null;
  const bellStyle = 'position:fixed; left:1rem; bottom:1rem; z-index:41; width:2.5rem; height:2.5rem; border-radius:9999px; '
    + 'display:grid; place-items:center; font-size:1.1rem; cursor:pointer; border:1px solid rgba(100,116,139,.5); '
    + 'background:rgba(15,23,42,.88); color:#e2e8f0; box-shadow:0 6px 20px rgba(0,0,0,.35);';

  function bellState() {
    const sound = flag(LS_SOUND, true);
    const desk = flag(LS_DESKTOP, true) && permission() === 'granted';
    const blocked = sound && (!ctx || ctx.state !== 'running');
    return { sound, desk, blocked, needsPermission: desktopSupported() && permission() === 'default' && flag(LS_DESKTOP, true) };
  }

  function paintBell() {
    if (!bell) return;
    const st = bellState();
    bell.textContent = st.sound || st.desk ? '🔔' : '🔕';
    bell.title = 'Уведомления диспетчера: звук и окна на рабочем столе';
    bell.style.boxShadow = (st.needsPermission || st.blocked) ? '0 0 0 3px rgba(251,191,36,.55), 0 6px 20px rgba(0,0,0,.35)' : '0 6px 20px rgba(0,0,0,.35)';
    if (panel) paintPanel();
  }

  function paintPanel() {
    const st = bellState();
    const perm = permission();
    const deskLine = perm === 'unsupported'
      ? '<div class="text-xs text-slate-400">Этот браузер не умеет показывать уведомления сайта.</div>'
      : perm === 'denied'
        ? '<div class="text-xs text-amber-300">Уведомления запрещены в браузере: нажмите на значок замка в адресной строке → «Уведомления» → «Разрешить», затем обновите страницу.</div>'
        : perm === 'default'
          ? `<button data-ntf-allow class="${btnPrimary} !px-3 !py-1 text-xs">Разрешить уведомления на рабочем столе</button>`
          : `<label class="flex items-center gap-2 text-sm"><input type="checkbox" data-ntf-desktop class="rounded accent-indigo-500" ${flag(LS_DESKTOP, true) ? 'checked' : ''}> Показывать окном поверх других программ</label>`;
    panel.innerHTML = `<div class="text-sm font-semibold mb-2">Уведомления диспетчера</div>
      <div class="space-y-2">
        <label class="flex items-center gap-2 text-sm"><input type="checkbox" data-ntf-sound class="rounded accent-indigo-500" ${st.sound ? 'checked' : ''}> Звуковой сигнал</label>
        ${st.sound && st.blocked ? '<div class="text-xs text-amber-300">Браузер пока не разрешил звук — нажмите «Проверить» (или любое место страницы).</div>' : ''}
        ${deskLine}
        <button data-ntf-test class="${btnGhost} !px-3 !py-1 text-xs">Проверить звук и уведомление</button>
        <div class="text-[11px] text-slate-500">Сигнал и окно приходят, когда монтёру нужно решение диспетчера. Вкладку с календарём нужно держать открытой.</div>
      </div>`;
    panel.querySelector('[data-ntf-sound]')?.addEventListener('change', (e) => { setFlag(LS_SOUND, e.target.checked); unlock(); paintBell(); });
    panel.querySelector('[data-ntf-desktop]')?.addEventListener('change', (e) => { setFlag(LS_DESKTOP, e.target.checked); paintBell(); });
    panel.querySelector('[data-ntf-allow]')?.addEventListener('click', async () => { setFlag(LS_DESKTOP, true); await askPermission(); paintBell(); });
    panel.querySelector('[data-ntf-test]')?.addEventListener('click', async () => {
      unlock();
      if (permission() === 'default') { setFlag(LS_DESKTOP, true); await askPermission(); }
      const played = chime(false);
      let shown = false;
      if (flag(LS_DESKTOP, true) && permission() === 'granted') {
        try { const n = new Notification('Проверка уведомлений', { body: 'Так будут приходить запросы от монтёров.', tag: 'ntf-test' }); n.onclick = () => n.close(); setTimeout(() => n.close(), 6000); shown = true; } catch { /* ignore */ }
      }
      paintBell();
      const note = document.createElement('div');
      note.className = 'text-xs text-slate-300';
      note.textContent = `${played ? 'Звук сыграл.' : 'Звук не сыграл (браузер заблокировал — нажмите ещё раз).'} ${shown ? 'Уведомление показано.' : 'Уведомление не показано.'}`;
      panel.querySelector('[data-ntf-test]').after(note);
    });
  }

  function mountBell() {
    if (bell) return;
    bell = document.createElement('button');
    bell.id = 'notifyBell';
    bell.type = 'button';
    bell.style.cssText = bellStyle;
    document.body.appendChild(bell);
    panel = document.createElement('div');
    panel.id = 'notifyPanel';
    panel.className = 'glass rounded-2xl shadow-2xl p-4 hidden';
    panel.style.cssText = 'position:fixed; left:1rem; bottom:4rem; z-index:41; width:min(320px, calc(100vw - 2rem));';
    document.body.appendChild(panel);
    bell.onclick = () => { unlock(); panel.classList.toggle('hidden'); if (!panel.classList.contains('hidden')) paintPanel(); };
    document.addEventListener('click', (e) => {
      if (!panel.classList.contains('hidden') && !e.target.closest('#notifyPanel') && !e.target.closest('#notifyBell')) panel.classList.add('hidden');
    });
    paintBell();
    setInterval(paintBell, 4000);
    showHintOnce();
  }

  // Один раз на браузер подсказываем, что звук и окна нужно разрешить кнопкой (сам браузер включить их не даёт).
  function showHintOnce() {
    const st = bellState();
    if (!(st.needsPermission || st.blocked) || flag('notifyHintShown', false)) return;
    setFlag('notifyHintShown', true);
    const hint = document.createElement('div');
    hint.className = 'glass rounded-2xl shadow-2xl p-3 text-xs';
    hint.style.cssText = 'position:fixed; left:1rem; bottom:4rem; z-index:41; max-width:280px;';
    hint.innerHTML = `<div class="mb-2">Чтобы слышать сигнал и видеть уведомления, когда монтёру нужно решение диспетчера, нажмите 🔔 и разрешите их.</div>
      <button class="${btnPrimary} !px-3 !py-1 text-xs">Настроить</button>`;
    document.body.appendChild(hint);
    const remove = () => hint.remove();
    hint.querySelector('button').onclick = () => { remove(); unlock(); panel.classList.remove('hidden'); paintPanel(); };
    setTimeout(remove, 20000);
  }

  return { announce, mountBell, unlock };
})();

(function () {
  const shownVr = new Set();
  const shownAi = new Set();
  const shownDr = new Set();
  let container = null;
  const baseTitle = document.title;

  // Positioning is set inline rather than via bottom-4/z-40 utility
  // classes — this app ships a pre-purged tailwind.min.css containing
  // only the classes actually used elsewhere at build time, so a brand
  // new utility combination silently has no effect (no build step here
  // to regenerate it). Every other class below was verified present.
  function ensureContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.id = 'vrToastContainer';
    container.className = 'fixed right-4 flex flex-col gap-2 w-full';
    container.style.cssText = 'bottom:1rem; z-index:40; max-width:360px;';
    document.body.appendChild(container);
    return container;
  }

  function updateTitle() {
    const n = shownVr.size + shownAi.size + shownDr.size;
    document.title = n ? `(${n}) ${baseTitle}` : baseTitle;
  }

  async function copyIpPort(item) {
    const text = item.ip_address + (item.port ? ':' + item.port : '');
    if (await copyToClipboard(text)) showToast('⧉ Скопировано: ' + esc(text), 2500);
    else prompt('Скопируйте вручную:', text);
  }

  function pointLinkButtonsHtml(item) {
    if (!item.ip_address) return '';
    return `<div class="flex items-center gap-1.5">
      <button data-open-web class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors">🌐 Веб-интерфейс</button>
      <button data-copy-ip class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors">⧉ Скопировать IP:порт</button>
    </div>`;
  }

  function wirePointLinkButtons(card, item) {
    card.querySelector('[data-open-web]')?.addEventListener('click', () => openPointWebInterface(item));
    card.querySelector('[data-copy-ip]')?.addEventListener('click', () => copyIpPort(item));
  }

  // ---------- verification requests («доступ есть — правда всё чинили?») ----------

  function vrCardHtml(item) {
    return `<div class="glass rounded-2xl shadow-2xl p-4 space-y-2" data-vr-card="${item.id}">
      <div class="text-xs font-semibold text-amber-300">Требуется проверка комплекса</div>
      <div class="text-sm font-semibold">${esc(item.point_id)} · ${esc(item.point_address || '')}</div>
      ${pointLinkButtonsHtml(item)}
      <div data-perm="notifications.resolve" data-vr-actions></div>
    </div>`;
  }

  async function resolveVr(id, ok, comment, remark) {
    await Api.post(`/api/verification-requests/${id}/resolve`, { ok, issue_comment: comment || null, remark: !!remark });
    shownVr.delete(id);
    container?.querySelector(`[data-vr-card="${id}"]`)?.remove();
    updateTitle();
  }

  // Три решения диспетчера. «Работает, но с замечанием — отпустить» и «Продолжить работу» открывают
  // поле для замечания (у первого оно обязательно) и кнопку «Назад».
  function renderVrActions(card, item) {
    const box = card.querySelector('[data-vr-actions]');
    box.innerHTML = `<div class="flex flex-col gap-1.5 pt-2">
      <button data-vr-ok class="${btnPrimary} !px-4 !py-1 text-xs">Полностью работает</button>
      <button data-vr-remark class="${btnGhost} !px-4 !py-1 text-xs">Работает, но с замечанием — отпустить</button>
      <button data-vr-issue class="${btnDanger} !px-4 !py-1 text-xs">Продолжить работу</button>
    </div>`;
    box.querySelector('[data-vr-ok]').onclick = () => resolveVr(item.id, true).catch((e) => alert(e.message));
    box.querySelector('[data-vr-remark]').onclick = () => renderVrCommentForm(card, item, {
      placeholder: 'Замечание — уйдёт монтёру и попадёт в отчёт', submit: 'Отпустить с замечанием', required: true,
      send: (comment) => resolveVr(item.id, true, comment, true),
    });
    box.querySelector('[data-vr-issue]').onclick = () => renderVrCommentForm(card, item, {
      placeholder: 'Что нужно доделать (можно не писать)', submit: 'Продолжить работу', required: false,
      send: (comment) => resolveVr(item.id, false, comment, false),
    });
  }

  function renderVrCommentForm(card, item, opts) {
    const box = card.querySelector('[data-vr-actions]');
    box.innerHTML = `<div class="space-y-2 pt-2">
      <textarea data-vr-comment rows="2" placeholder="${esc(opts.placeholder)}" class="${fieldCls} text-xs"></textarea>
      <div class="flex items-center gap-2">
        <button data-vr-back class="${btnGhost} !px-3 !py-1 text-xs">Назад</button>
        <button data-vr-submit class="${opts.required ? btnPrimary : btnDanger} !px-4 !py-1 text-xs">${esc(opts.submit)}</button>
      </div>
    </div>`;
    box.querySelector('[data-vr-comment]').focus();
    box.querySelector('[data-vr-back]').onclick = () => renderVrActions(card, item);
    box.querySelector('[data-vr-submit]').onclick = () => {
      const comment = box.querySelector('[data-vr-comment]').value.trim();
      if (opts.required && !comment) { box.querySelector('[data-vr-comment]').focus(); return; }
      opts.send(comment).catch((e) => alert(e.message));
    };
  }

  function addVrCard(item) {
    shownVr.add(item.id);
    ensureContainer().insertAdjacentHTML('beforeend', vrCardHtml(item));
    const card = container.querySelector(`[data-vr-card="${item.id}"]`);
    wirePointLinkButtons(card, item);
    renderVrActions(card, item);
    DispatcherNotify.announce(`vr:${item.id}`, 'Требуется проверка комплекса', `${item.point_id}${item.point_address ? ' · ' + item.point_address : ''}`, false);
  }

  // ---------- access issues («доступа всё ещё нет, монтёр позвонил») ----------

  function aiCardHtml(item) {
    return `<div class="glass rounded-2xl shadow-2xl p-4 space-y-2" data-ai-card="${item.id}">
      <div class="text-xs font-semibold text-rose-300">Нет доступа к комплексу — решение по бригаде</div>
      <div class="text-sm font-semibold">${esc(item.point_id)} · ${esc(item.point_address || '')}</div>
      ${pointLinkButtonsHtml(item)}
      <div class="flex items-center gap-2 pt-2" data-perm="notifications.resolve" data-ai-actions>
        <button data-ai-release class="${btnGhost} !px-4 !py-1 text-xs">Отпустить без ремонта</button>
        <button data-ai-demontage class="${btnDanger} !px-4 !py-1 text-xs">Оформить демонтаж</button>
      </div>
    </div>`;
  }

  async function resolveAi(id, decision, demontageNote) {
    await Api.post(`/api/access-issues/${id}/resolve`, { decision, demontage_note: demontageNote || null });
    shownAi.delete(id);
    container?.querySelector(`[data-ai-card="${id}"]`)?.remove();
    updateTitle();
  }

  function addAiCard(item) {
    shownAi.add(item.id);
    ensureContainer().insertAdjacentHTML('beforeend', aiCardHtml(item));
    const card = container.querySelector(`[data-ai-card="${item.id}"]`);
    wirePointLinkButtons(card, item);
    card.querySelector('[data-ai-release]').onclick = () => {
      if (!confirm('Отпустить бригаду без ремонта? Комплекс останется в текущем состоянии.')) return;
      resolveAi(item.id, 'released').catch((e) => alert(e.message));
    };
    card.querySelector('[data-ai-demontage]').onclick = () => {
      card.querySelector('[data-ai-actions]').outerHTML = `
        <div class="space-y-2 pt-2">
          <textarea data-ai-note rows="2" placeholder="Что демонтировать" class="${fieldCls} text-xs"></textarea>
          <button data-ai-submit class="${btnDanger} !px-4 !py-1 text-xs">Отправить</button>
        </div>`;
      card.querySelector('[data-ai-submit]').onclick = () => {
        const note = card.querySelector('[data-ai-note]').value.trim();
        if (!note) return;
        resolveAi(item.id, 'demontage', note).catch((e) => alert(e.message));
      };
    };
    DispatcherNotify.announce(`ai:${item.id}`, 'Нет доступа к комплексу', `${item.point_id}${item.point_address ? ' · ' + item.point_address : ''} — нужно решение по бригаде`, true);
  }

  // ---------- demontage requests (монтёр сам просит демонтаж) ----------

  // kind: 'demontage' (по умолчанию) или 'release' (отпустить без ремонта
  // — монтёр запросил это с кнопки при «Завершить», когда комплекс так и
  // остался недоступен, см. bot/service/mechanic.py::repair_finish).
  function drCardHtml(item) {
    const isRelease = item.kind === 'release';
    return `<div class="glass rounded-2xl shadow-2xl p-4 space-y-2" data-dr-card="${item.id}">
      <div class="text-xs font-semibold text-amber-300">${isRelease ? 'Запрос: отпустить без ремонта' : 'Запрос на демонтаж'}</div>
      <div class="text-sm font-semibold">${esc(item.point_id)} · ${esc(item.point_address || '')}</div>
      <div class="text-xs text-slate-400">${esc(item.reason)}</div>
      ${pointLinkButtonsHtml(item)}
      <div class="flex items-center gap-2 pt-2" data-perm="notifications.resolve" data-dr-actions>
        <button data-dr-approve class="${btnDanger} !px-4 !py-1 text-xs">${isRelease ? 'Подтвердить отпуск' : 'Одобрить демонтаж'}</button>
        <button data-dr-decline class="${btnGhost} !px-4 !py-1 text-xs">Отклонить</button>
      </div>
    </div>`;
  }

  async function resolveDr(id, approve, declineComment) {
    await Api.post(`/api/demontage-requests/${id}/resolve`, { approve, decline_comment: declineComment || null });
    shownDr.delete(id);
    container?.querySelector(`[data-dr-card="${id}"]`)?.remove();
    updateTitle();
  }

  function addDrCard(item) {
    shownDr.add(item.id);
    ensureContainer().insertAdjacentHTML('beforeend', drCardHtml(item));
    const card = container.querySelector(`[data-dr-card="${item.id}"]`);
    wirePointLinkButtons(card, item);
    card.querySelector('[data-dr-approve]').onclick = () => {
      const confirmMsg = item.kind === 'release'
        ? 'Подтвердить отпуск бригады без ремонта? Задание закроется статусом «Не работает».'
        : 'Одобрить демонтаж? Монтёру придёт запрос фото демонтажа.';
      if (!confirm(confirmMsg)) return;
      resolveDr(item.id, true).catch((e) => alert(e.message));
    };
    card.querySelector('[data-dr-decline]').onclick = () => {
      card.querySelector('[data-dr-actions]').outerHTML = `
        <div class="space-y-2 pt-2">
          <textarea data-dr-comment rows="2" placeholder="Почему отклонено" class="${fieldCls} text-xs"></textarea>
          <button data-dr-submit class="${btnGhost} !px-4 !py-1 text-xs">Отправить</button>
        </div>`;
      card.querySelector('[data-dr-submit]').onclick = () => {
        const comment = card.querySelector('[data-dr-comment]').value.trim();
        if (!comment) return;
        resolveDr(item.id, false, comment).catch((e) => alert(e.message));
      };
    };
    DispatcherNotify.announce(
      `dr:${item.id}`, item.kind === 'release' ? 'Запрос: отпустить без ремонта' : 'Запрос на демонтаж',
      `${item.point_id}${item.point_address ? ' · ' + item.point_address : ''}${item.reason ? ' — ' + item.reason : ''}`, false,
    );
  }

  let bellMounted = false;
  let stopped = false;
  async function poll() {
    // Пока страница не узнала, кто вошёл (CURRENT_USER ещё не объявлен или пуст), не спрашиваем: роль без права получала бы отказ, записанный в журнал безопасности
    if (typeof CURRENT_USER === 'undefined' || !CURRENT_USER) return;
    if (!canAny('notifications.view', 'calendar.view')) { stopped = true; return; }   // этих запросов роль не видит — не опрашиваем
    let vrItems = [], aiItems = [], drItems = [];
    try {
      try {                                                   // один запрос вместо трёх (так сервер нагружается втрое меньше)
        const all = await Api.get('/api/notifications/pending-requests');
        vrItems = all.verification || []; aiItems = all.access || []; drItems = all.demontage || [];
      } catch (e1) {
        if (!/Not Found|не найден/i.test((e1 && e1.message) || '')) throw e1;       // сервер старый (без общего запроса) — спрашиваем по-прежнему тремя
        [vrItems, aiItems, drItems] = await Promise.all([
          Api.get('/api/verification-requests?status=pending'),
          Api.get('/api/access-issues?status=pending'),
          Api.get('/api/demontage-requests?status=pending'),
        ]);
      }
    } catch (e) {
      // Роль «отсутствия» этих запросов не видит (403 «доступны только отсутствия людей») — опрашивать каждые 5 секунд бесполезно; случайный сбой связи/входа ошибками не засоряем
      if (/Нет права|доступны только отсутствия/.test(e && e.message)) stopped = true;
      return;
    }
    if (!bellMounted) { bellMounted = true; DispatcherNotify.mountBell(); }

    const stillVr = new Set(vrItems.map((i) => i.id));
    for (const id of [...shownVr]) {
      if (!stillVr.has(id)) { shownVr.delete(id); container?.querySelector(`[data-vr-card="${id}"]`)?.remove(); }
    }
    for (const item of vrItems) { if (!shownVr.has(item.id)) addVrCard(item); }

    const stillAi = new Set(aiItems.map((i) => i.id));
    for (const id of [...shownAi]) {
      if (!stillAi.has(id)) { shownAi.delete(id); container?.querySelector(`[data-ai-card="${id}"]`)?.remove(); }
    }
    for (const item of aiItems) { if (!shownAi.has(item.id)) addAiCard(item); }

    const stillDr = new Set(drItems.map((i) => i.id));
    for (const id of [...shownDr]) {
      if (!stillDr.has(id)) { shownDr.delete(id); container?.querySelector(`[data-dr-card="${id}"]`)?.remove(); }
    }
    for (const item of drItems) { if (!shownDr.has(item.id)) addDrCard(item); }
    updateTitle();
  }

  // Опрос идёт от таймера в отдельном потоке (Worker): у скрытой вкладки обычные таймеры браузер
  // замедляет до раза в минуту, а запрос диспетчеру нужно заметить за секунды.
  function startTicker(fn, ms) {
    try {
      const url = URL.createObjectURL(new Blob([`setInterval(function(){ postMessage(1); }, ${ms});`], { type: 'text/javascript' }));
      const worker = new Worker(url);
      worker.onmessage = fn;
      return;
    } catch { /* без Worker — обычный таймер */ }
    setInterval(fn, ms);
  }

  let polling = false;
  const pollOnce = async () => {
    if (polling || stopped) return;   // прошлый опрос ещё не закончился / роль этих запросов не видит
    polling = true;
    try { await poll(); } finally { polling = false; }
  };
  pollOnce();
  startTicker(pollOnce, 5000);
})();

// ---------- Добавление нескольких точек бригаде: общие куски ----------
// Используются календарём («+ Точка», «Из плана»), страницей «Все АПК» и
// менеджером плана — всё, что нужно, чтобы выбрать сразу несколько точек,
// задать тип работы каждой (или всем сразу) и создать задания пачкой.

// Поиск и фильтры для списка «плана» (point_plans) — те же поиск/категории/
// статусы/сертификат, что и на «Все АПК», но в браузере: план — короткий
// список, а не тысячи строк, серверная фильтрация тут ни к чему. `f` —
// обычный объект состояния, который вызывающий код хранит между
// перерисовками списка.
function newPlanFilter() {
  return { search: '', categories: new Set(), statuses: new Set(), certificate: '', priorityOnly: false };
}

// Группы в плане выездов: точки плана собираются в группы с подписью (group_name) и могут заранее получить тип работы (work_type) —
// независимо друг от друга; потом всю группу записывают на бригаду разом. Группы идут по алфавиту, «без группы» — последними.
function planGroupsOf(list) {
  const map = new Map();
  list.forEach((p) => { const g = p.group_name || ''; if (!map.has(g)) map.set(g, []); map.get(g).push(p); });
  const names = [...map.keys()].filter(Boolean).sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
  return [...names, ...(map.has('') ? [''] : [])].map((name) => ({ name, items: map.get(name) }));
}
const planVisitTypeOptions = (selected = '') => VISIT_TYPES.filter((z) => z !== AUX_TYPE).map((z) => `<option ${z === selected ? 'selected' : ''}>${esc(z)}</option>`).join('');

function planFilterMatches(p, f) {
  if (f.priorityOnly && !p.priority) return false;
  if (f.search) {
    if (!matchesQuery(f.search, p.point_id, p.description, p.point_address, p.group_name, p.work_type)) return false;
  }
  if (f.categories.size && !f.categories.has(p.category_id == null ? '__none__' : String(p.category_id))) return false;
  if (f.statuses.size && !f.statuses.has(p.point_status || '__none__')) return false;
  if (f.certificate) {
    const v = p.verification_valid_until || '';
    const today = new Date().toISOString().slice(0, 10);
    if (f.certificate === 'missing' && v) return false;
    if (f.certificate === 'valid' && !(v && v >= today)) return false;
    if (f.certificate === 'expired' && !(v && v < today)) return false;
  }
  return true;
}

// Рисует строку поиска + фильтры в `container` один раз (поле поиска не
// пересоздаётся на каждую букву — иначе терялся бы фокус), чипы
// перерисовываются по клику. Чипы категорий/статусов строятся из того, что
// реально есть в плане. onChange() — перерисовать сам список.
function mountPlanFilters(container, plans, f, onChange) {
  const cats = new Map();
  const statuses = new Set();
  let noCat = false, noStatus = false;
  for (const p of plans) {
    if (p.category_id == null) noCat = true; else cats.set(String(p.category_id), p.category_name || 'Категория');
    if (p.point_status) statuses.add(p.point_status); else noStatus = true;
  }
  const catOpts = [...(noCat ? [{ value: '__none__', label: 'Без категории' }] : []), ...[...cats].map(([value, label]) => ({ value, label }))];
  const stOpts = [
    ...(noStatus ? [{ value: '__none__', label: UNKNOWN_STATUS, color: '#64748b' }] : []),
    ...[...statuses].map((v) => ({ value: v, label: v, color: _pointStatusCache[v]?.color })),
  ];

  container.innerHTML = `<div class="space-y-2 mb-2">
    <input data-plan-search value="${esc(f.search)}" placeholder="Поиск по номеру, адресу, описанию, группе" class="${fieldCls}" autocomplete="off">
    <div class="flex flex-wrap items-center gap-2">
      <select data-plan-cert class="rounded-xl px-2.5 py-1.5 text-xs accent-ring">
        <option value="">Сертификат поверки: любой</option>
        <option value="valid" ${f.certificate === 'valid' ? 'selected' : ''}>Действует</option>
        <option value="expired" ${f.certificate === 'expired' ? 'selected' : ''}>Истёк</option>
        <option value="missing" ${f.certificate === 'missing' ? 'selected' : ''}>Отсутствует</option>
      </select>
      <label class="flex items-center gap-1.5 text-xs text-slate-300">
        <input type="checkbox" data-plan-priority-only class="rounded accent-amber-500" ${f.priorityOnly ? 'checked' : ''}> только приоритетные
      </label>
    </div>
    ${filterPanelHtml(filterRowHtml('Категория', '', 'data-plan-chips="cat"') + filterRowHtml('Статус', '', 'data-plan-chips="st"'))}
  </div>`;

  const drawChips = () => {
    [['cat', 'plan-category', catOpts, f.categories], ['st', 'plan-status', stOpts, f.statuses]].forEach(([slot, name, opts, set]) => {
      const box = container.querySelector(`[data-plan-chips="${slot}"]`);
      box.innerHTML = filterChipsHtml(name, opts, set);
      wireFilterChips(box, name, set, () => { drawChips(); onChange(); });
    });
  };
  drawChips();
  container.querySelector('[data-plan-search]').oninput = (e) => { f.search = e.target.value; onChange(); };
  container.querySelector('[data-plan-cert]').onchange = (e) => { f.certificate = e.target.value; onChange(); };
  container.querySelector('[data-plan-priority-only]').onchange = (e) => { f.priorityOnly = e.target.checked; onChange(); };
}

// Шаг «тип работы по каждой точке» — такой же, как при импорте KML: по
// строке на точку со своим типом, плюс «Все» / «Применить к отмеченным» на
// случай, когда у всей пачки один тип. Сверху — дата, бригада и часы
// (заполнены тем, что уже известно из контекста). items: [{ key, label, sub }].
// Итог массового добавления точек бригаде (ответ /api/points/assign и
// /api/point-plans/assign) — с пометкой, какие точки пропущены как уже
// добавленные (в тот же день у любой бригады или в той же командировке).
function assignResultMessage(res) {
  const skipped = res.skipped_points || [];
  const parts = [];
  if (res.created) parts.push(`Добавлено заданий: ${res.created}.`);
  if (skipped.length === 1) parts.push(`Такая точка уже добавлена: ${skipped[0]}. Новая пропущена.`);
  else if (skipped.length) parts.push(`Такие точки уже добавлены (пропущены): ${skipped.join(', ')}.`);
  return parts.join('\n') || 'Новых заданий нет.';
}

// onSubmit({ date, team, hours, travel, items: [{ key, type }] }) делает сам
// запрос; если бросает — текст ошибки показывается в окне, и форму можно
// поправить и отправить снова, если нет — окно закрывается.
function bulkAssignForm({ title, items, date, crewId, onSubmit, hours = 1, travel = 0 }) {
  const loadCrews = async (d) => { try { return await Api.get('/api/crews?date=' + d); } catch { return []; } };
  const crewOptions = (list, selected) => list.map((c) => `<option value="${c.id}" ${c.id === +selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    || '<option value="">— нет бригад на эту дату —</option>';

  (async () => {
    const crews = await loadCrews(date);
    modal(`<h2 class="font-display text-lg font-bold mb-4">${esc(title)}</h2>
      <form id="bulkForm" class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls}">Дата<input name="date" type="date" required value="${esc(date)}" class="${fieldCls}"></label>
          <label class="${labelCls}">Бригада<select name="team" required class="${fieldCls}">${crewOptions(crews, crewId)}</select></label>
          <label class="${labelCls}">Работа, ч<input name="hours" type="number" step=".25" min="0" value="${esc(hours)}" class="${fieldCls}"></label>
          <label class="${labelCls}">Дорога, ч<input name="travel" type="number" step=".25" min="0" value="${esc(travel)}" class="${fieldCls}"></label>
        </div>
        <div class="flex flex-wrap items-center gap-2 -mt-2">
          <button type="button" id="bulkNewCrew" class="${btnGhost} !py-1 !px-3 text-xs" title="Собрать новую бригаду на эту дату (состав, транспорт) и добавить точки в неё">＋ Новая бригада на эту дату</button>
          <span class="text-[11px] text-slate-500">Нет подходящей бригады — создайте её здесь, выбранные точки и типы работ сохранятся.</span>
        </div>
        <p class="text-sm"><b>Точек: ${items.length}</b></p>
        <p class="text-xs text-slate-500 -mt-2">Выберите тип работы для каждой точки. Если тип один для всех (или для большинства) — отметьте нужные точки и примените его сразу пачкой.</p>
        <div class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/20 p-2.5">
          <label class="flex items-center gap-1.5 text-xs text-slate-300">
            <input type="checkbox" id="bulkSelectAll" class="rounded accent-indigo-500" checked> Все
          </label>
          <select id="bulkType" class="${fieldCls} !py-1 !text-xs !w-auto">
            <option value="">— тип для выбранных —</option>
            ${VISIT_TYPES.filter((z) => z !== AUX_TYPE).map((z) => `<option>${esc(z)}</option>`).join('')}
          </select>
          <button type="button" id="bulkApply" class="${btnGhost} !py-1 !px-2.5 text-xs">Применить к отмеченным</button>
        </div>
        <div class="max-h-64 overflow-auto space-y-1.5 pr-1">
          ${items.map((it, i) => `<div class="rounded-xl bg-slate-800/40 border border-slate-700/40 p-2.5 text-xs space-y-1.5">
            <div class="flex items-start gap-2">
              <input type="checkbox" data-bulk-check="${i}" class="rounded accent-indigo-500 mt-0.5" checked>
              <div><b>${esc(it.label)}</b>${it.sub ? `<br><span class="text-slate-400">${esc(it.sub)}</span>` : ''}</div>
            </div>
            <select data-bulk-type="${i}" class="${fieldCls} !py-1 !text-xs">
              <option value="">— тип работы —</option>
              ${VISIT_TYPES.filter((z) => z !== AUX_TYPE).map((z) => `<option ${z === it.type ? 'selected' : ''}>${esc(z)}</option>`).join('')}
            </select>
          </div>`).join('')}
        </div>
        <div id="bulkError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
        <div class="flex items-center gap-2 pt-2">
          <button type="button" class="cancel ${btnGhost}">Отмена</button>
          <button class="${btnPrimary}">Добавить в бригаду</button>
        </div>
      </form>`);

    const form = $('#bulkForm');
    const showErr = (msg) => { $('#bulkError').textContent = msg; $('#bulkError').classList.remove('hidden'); };
    form.elements.date.onchange = async (e) => {
      form.elements.team.innerHTML = crewOptions(await loadCrews(e.target.value), '');
    };
    $('#bulkNewCrew').onclick = async () => {
      // Диалог бригады занимает то же окно: запоминаем выбранное (дату, часы, типы) и после него открываем форму заново — уже с новой бригадой.
      const f = form.elements;
      const keep = {
        date: f.date.value, hours: +f.hours.value || 0, travel: +f.travel.value || 0, team: f.team.value ? +f.team.value : crewId,
        items: items.map((it, i) => ({ ...it, type: form.querySelector(`[data-bulk-type="${i}"]`).value })),
      };
      if (!keep.date) { showErr('Сначала выберите дату.'); return; }
      const crew = await crewQuickCreate(keep.date);
      bulkAssignForm({ title, items: keep.items, date: keep.date, crewId: crew ? crew.id : keep.team, onSubmit, hours: keep.hours, travel: keep.travel });
    };
    $('#bulkSelectAll').onchange = (e) => {
      form.querySelectorAll('[data-bulk-check]').forEach((chk) => { chk.checked = e.target.checked; });
    };
    $('#bulkApply').onclick = () => {
      const t = $('#bulkType').value;
      if (!t) return showErr('Сначала выберите тип работы для применения.');
      const checked = form.querySelectorAll('[data-bulk-check]:checked');
      if (!checked.length) return showErr('Отметьте хотя бы одну точку в списке ниже.');
      $('#bulkError').classList.add('hidden');
      checked.forEach((chk) => { form.querySelector(`[data-bulk-type="${chk.dataset.bulkCheck}"]`).value = t; });
    };
    form.onsubmit = async (e) => {
      e.preventDefault();
      const types = items.map((_, i) => form.querySelector(`[data-bulk-type="${i}"]`).value);
      if (types.some((t) => !t)) return showErr('Выберите тип работы для каждой точки в списке ниже.');
      const f = form.elements;
      if (!f.team.value) return showErr('На эту дату нет бригад — создайте её на календаре.');
      const btn = form.querySelector('button:not([type="button"])');
      btn.disabled = true;
      try {
        await onSubmit({
          date: f.date.value, team: +f.team.value, hours: +f.hours.value || 0, travel: +f.travel.value || 0,
          items: items.map((it, i) => ({ key: it.key, type: types[i] })),
        });
        close();
      } catch (err) {
        showErr(err.message);
        btn.disabled = false;
      }
    };
  })();
}

// ---------- Фото комплекса по дням: кнопка «📷 Фото» на карточке точки (на любой странице) ----------
// Показывает все фото комплекса — и те, что прислали через бота, и те, что уже лежали в его папке на сетевом диске
// («прежний архив»), — по дням, новые сверху. На каждом снимке значок, где лежит файл: ☁ сетевой диск, 💾 диск сервера.
const PP_WHERE = {
  disk: ['☁', 'Лежит на сетевом диске'],
  server: ['💾', 'Лежит на диске сервера — на сетевой диск ещё не перенесено'],
  buffer: ['⏳', 'Временно на сервере: сетевой диск был недоступен, фото переедет само'],
  missing: ['❓', 'Файл фото не найден'],
};

function ppBadge(ph) {
  const [icon, hint] = PP_WHERE[ph.where] || PP_WHERE.disk;
  return `<span title="${esc(hint)}" class="absolute rounded-md px-1 text-[11px] leading-5" style="left:4px; bottom:4px; background:rgba(15,23,42,.78)">${icon}</span>`
    + (ph.imported ? `<span title="Фото уже лежало в папке комплекса на сетевом диске (прежний архив)" class="absolute rounded-md px-1 text-[10px] leading-5 text-slate-200" style="right:4px; bottom:4px; background:rgba(15,23,42,.78)">архив</span>` : '');
}

const ppPlural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m100 >= 11 && m100 <= 14 ? many : m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many}`;
};
const PP_WEEKDAYS = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const ppDayLabel = (iso) => `${fmtDate(iso)} (${PP_WEEKDAYS[new Date(iso + 'T12:00:00').getDay()]})`;

function ppThumb(ph) {
  const url = `/api/monitoring/photos/${ph.id}/file`;
  const who = [ph.name, ph.uploaded_by, ph.uploaded_at ? fmtDateTime(ph.uploaded_at, true) : ''].filter(Boolean).join(' · ');
  const canDelete = !ph.imported && can('photos.delete');
  return `<span class="relative block">
    <a href="${url}" target="_blank" rel="noopener" data-pv data-pv-title="${esc(who)}" data-pv-sub="${esc(ph.date ? fmtDate(ph.date) : '')}" title="${esc(who)}" class="block">
      <img src="${url}" loading="lazy" alt="" style="width:100%; aspect-ratio:1/1; object-fit:cover; border-radius:10px; background:#0f172a; display:block">
    </a>${ppBadge(ph)}
    ${photoDownloadBtn(ph.id)}
    ${canDelete ? `<button data-pp-del="${ph.id}" title="Удалить это фото" class="absolute rounded-lg px-1.5 text-xs" style="top:4px; right:4px; background:rgba(244,63,94,.88); color:#fff">×</button>` : ''}
  </span>`;
}

// Кнопка «⬇» в углу миниатюры: скачать ОДНО фото файлом (имя «<комплекс>_<дата>_<номер>.jpg» ставит сервер по ?download=1). Без права просмотра фото кнопки нет.
function photoDownloadBtn(id) {
  return `<a href="/api/monitoring/photos/${id}/file?download=1" download data-photo-dl title="Скачать это фото" class="absolute rounded-lg px-1.5 text-xs" style="bottom:4px; right:4px; background:rgba(15,23,42,.82); color:#fff; text-decoration:none">⬇</a>`;
}

// Ссылка скачивания для просмотра на всё окно: у фото из архива помощника/чата — как есть, у фото комплекса — с понятным именем.
function photoDownloadUrl(url) {
  return /^\/api\/monitoring\/photos\/\d+\/file$/.test(url) ? url + '?download=1' : url;
}

const ppLocalIso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const PP_MAX_FILE = 15 * 1024 * 1024;                                  // как на сервере (routes_monitoring.MAX_UPLOAD_PHOTO_BYTES)

// «Фото комплекса» по дням + добавление фото вручную: выбрать файлы и дату, к которой они относятся (одна на всех либо у каждого файла своя — по дате съёмки/изменения файла).
async function openPointPhotos(pointId, back = null, focusDate = null, opts = {}) {
  const listUrl = '/api/monitoring/photos/point-items?point_id=' + encodeURIComponent(pointId);
  let data;
  try { data = await Api.get(listUrl); }
  catch (e) { alert('Не удалось загрузить фото: ' + e.message); return; }
  const open = new Set(focusDate ? [focusDate] : data.days.slice(0, 1).map((d) => d.date));
  const canUpload = can('photos.upload');
  const today = ppLocalIso(new Date());
  let picked = [];                                                     // выбрано для загрузки: { file, url }
  let busy = false;
  const info = () => {
    const archive = data.days.reduce((n, d) => n + d.photos.filter((p) => p.imported).length, 0);
    const onServer = data.days.reduce((n, d) => n + d.photos.filter((p) => p.where === 'server' || p.where === 'buffer').length, 0);
    return `${esc(data.point_address || '')}${data.point_address ? ' · ' : ''}${data.total ? `всего ${ppPlural(data.total, 'фото', 'фото', 'фото')}${archive ? `, из них ${archive} из прежнего архива на диске` : ''}` : ''}
      ${onServer ? `<span class="text-amber-300"> · ${onServer} ещё на диске сервера (💾)</span>` : ''}`;
  };
  const refresh = async (focus) => {
    data = await Api.get(listUrl);
    if (focus) open.add(focus);
    if ($('#ppDays')) { render(); $('#ppInfo').innerHTML = info(); }
    if (typeof opts.onChange === 'function') opts.onChange(data);          // карточка комплекса обновляет свою полосу фото
  };
  const render = () => {
    $('#ppDays').innerHTML = data.days.map((d) => `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/20">
        <div class="flex items-center justify-between gap-2 px-4 py-2.5 cursor-pointer select-none" data-pp-head="${d.date}">
          <span class="text-sm font-semibold"><small class="text-slate-500 mr-1">${open.has(d.date) ? '▾' : '▸'}</small>${esc(ppDayLabel(d.date))}
            <span class="text-slate-500 font-normal">· ${ppPlural(d.photos.length, 'фото', 'фото', 'фото')}</span></span>
          <a href="/api/monitoring/photos/export?date=${d.date}" data-pp-zip class="${btnGhost} !px-3 !py-1 text-xs" title="Архив всех фото этого дня (по всем комплексам)">Архив .zip</a>
        </div>
        <div class="px-4 pb-3" style="display:${open.has(d.date) ? 'grid' : 'none'}; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:8px">
          ${d.photos.map((ph) => ppThumb({ ...ph, date: d.date })).join('')}</div>
      </div>`).join('') || '<p class="text-sm text-slate-500 text-center py-6">Фото по этому комплексу пока нет.</p>';
    document.querySelectorAll('#ppDays [data-pp-head]').forEach((head) => {
      head.onclick = (e) => {
        if (e.target.closest('[data-pp-zip]')) return;
        const date = head.dataset.ppHead;
        if (open.has(date)) open.delete(date); else open.add(date);
        render();
      };
    });
    document.querySelectorAll('#ppDays [data-pp-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Удалить это фото?')) return;
        try { await Api.del('/api/monitoring/photos/' + btn.dataset.ppDel); await refresh(); }
        catch (e) { alert('Не удалось удалить: ' + e.message); }
      };
    });
  };
  modal(`<div class="flex flex-wrap items-start justify-between gap-3 mb-1">
      <h2 class="font-display text-lg font-bold">Фото · ${esc(pointId)}</h2>
      <span class="flex flex-wrap items-center justify-end gap-2">
        ${canUpload ? `<button type="button" id="ppAdd" class="${btnPrimary} !px-4 !py-1.5 text-xs" title="Загрузить фото к этому комплексу и выбрать, к какой дате они относятся">➕ Добавить фото</button>` : ''}
        ${back ? `<button type="button" id="ppBack" class="${btnGhost} !px-4 !py-1.5 text-xs">← К списку</button>` : ''}
        <button type="button" class="cancel ${btnGhost} !px-4 !py-1.5 text-xs">Закрыть</button>
      </span>
    </div>
    <p id="ppInfo" class="text-xs text-slate-400 mb-3">${info()}</p>
    ${canUpload ? `<div id="ppUpload" class="hidden rounded-2xl border border-indigo-400/30 bg-indigo-500/5 p-3 mb-3 space-y-2.5">
      <div class="text-sm font-semibold">Добавить фото к комплексу ${esc(pointId)}</div>
      <div class="flex flex-wrap items-end gap-x-4 gap-y-2">
        <label class="${labelCls}">Дата, к которой относятся фото
          <input type="date" id="ppUpDate" value="${today}" max="${today}" class="${fieldCls}" style="width:auto"></label>
        <label class="flex items-center gap-1.5 text-xs text-slate-300 pb-2 cursor-pointer" title="Для каждого фото берётся дата из самого файла (когда снято или изменено) — удобно, если выбрали фото за разные дни">
          <input type="checkbox" id="ppUpByFile"> у каждого фото — дата файла</label>
      </div>
      <div class="flex flex-wrap items-center gap-3">
        <label class="${btnGhost} cursor-pointer !py-1.5 text-xs">📁 Выбрать фото…
          <input type="file" id="ppUpFiles" accept="image/jpeg,image/png,image/webp,image/gif,image/bmp" multiple style="display:none"></label>
        <span id="ppUpInfo" class="text-xs text-slate-400">Фото не выбраны. Можно сразу несколько (JPEG, PNG, WebP; до 15 МБ каждое).</span>
      </div>
      <div id="ppUpList" class="flex flex-wrap gap-2"></div>
      <div id="ppUpErr" class="text-xs text-rose-300 space-y-0.5" style="white-space:pre-wrap"></div>
      <div class="flex flex-wrap items-center gap-3"><button type="button" id="ppUpGo" class="${btnPrimary} !py-1.5 text-xs" disabled>Загрузить</button>
        <span id="ppUpStatus" class="text-xs text-slate-300"></span></div>
    </div>` : ''}
    <div id="ppDays" class="space-y-2" data-pv-scope></div>`, { wide: true });
  render();
  if (back && $('#ppBack')) $('#ppBack').onclick = back;
  if (!canUpload) return;
  if (opts.openUpload && $('#ppUpload')) $('#ppUpload').classList.remove('hidden');      // «➕ Загрузить фото» в карточке: панель выбора даты и файлов сразу открыта

  const byFile = () => !!($('#ppUpByFile') && $('#ppUpByFile').checked);
  const dateOf = (f) => {
    if (byFile()) { const iso = ppLocalIso(new Date(f.lastModified || Date.now())); return iso > today ? today : iso; }
    return ($('#ppUpDate') && $('#ppUpDate').value) || today;
  };
  const setStatus = (text) => { if ($('#ppUpStatus')) $('#ppUpStatus').textContent = text; };
  const paintPicked = () => {
    const list = $('#ppUpList');
    if (!list) return;
    list.innerHTML = picked.slice(0, 24).map((p, i) => `<span class="relative block text-center" title="${esc(p.file.name)}">
        <img src="${p.url}" alt="" style="width:72px; height:72px; object-fit:cover; border-radius:8px; display:block; background:#0f172a">
        ${busy ? '' : `<button type="button" data-pp-unpick="${i}" title="Не загружать это фото" class="absolute rounded-lg px-1.5 text-xs" style="top:2px; right:2px; background:rgba(15,23,42,.85); color:#fff">×</button>`}
        <small class="block text-[10px] text-slate-400">${esc(fmtDate(dateOf(p.file)))}</small></span>`).join('')
      + (picked.length > 24 ? `<span class="text-xs text-slate-400 self-center">и ещё ${picked.length - 24}</span>` : '');
    list.querySelectorAll('[data-pp-unpick]').forEach((b) => {
      b.onclick = () => { const [gone] = picked.splice(+b.dataset.ppUnpick, 1); if (gone) URL.revokeObjectURL(gone.url); paintPicked(); };
    });
    $('#ppUpInfo').textContent = picked.length ? `Выбрано: ${ppPlural(picked.length, 'фото', 'фото', 'фото')}` : 'Фото не выбраны. Можно сразу несколько (JPEG, PNG, WebP; до 15 МБ каждое).';
    $('#ppUpGo').disabled = busy || !picked.length;
    $('#ppUpGo').textContent = picked.length ? `Загрузить ${ppPlural(picked.length, 'фото', 'фото', 'фото')}` : 'Загрузить';
  };
  $('#ppAdd').onclick = () => $('#ppUpload').classList.toggle('hidden');
  $('#ppUpDate').onchange = paintPicked;
  $('#ppUpByFile').onchange = () => { $('#ppUpDate').disabled = byFile(); paintPicked(); };
  $('#ppUpFiles').onchange = (e) => {
    for (const f of e.target.files) {
      if (!picked.some((p) => p.file.name === f.name && p.file.size === f.size && p.file.lastModified === f.lastModified)) picked.push({ file: f, url: URL.createObjectURL(f) });
    }
    e.target.value = '';                                               // чтобы тот же файл можно было выбрать снова
    paintPicked();
  };
  $('#ppUpGo').onclick = async () => {
    if (busy || !picked.length) return;
    busy = true;
    paintPicked();
    $('#ppUpErr').textContent = '';
    const queue = picked.slice();
    const failed = [];
    let ok = 0;
    let lastDate = null;
    for (let i = 0; i < queue.length; i += 1) {
      const p = queue[i];
      const date = dateOf(p.file);
      setStatus(`Загружаю ${i + 1} из ${queue.length}…`);
      try {
        if (p.file.size > PP_MAX_FILE) throw new Error(`слишком большой (${Math.round(p.file.size / 1e6)} МБ, можно до 15 МБ)`);
        const fd = new FormData();
        fd.append('point_id', pointId);
        fd.append('date', date);
        fd.append('file', p.file, p.file.name);
        await Api.uploadWithProgress('/api/monitoring/photos/upload', fd, { timeoutMs: 180000, onProgress: (a, b) => setStatus(`Загружаю ${i + 1} из ${queue.length}… ${Math.round((a * 100) / b)}%`) });
        ok += 1;
        lastDate = date;
        URL.revokeObjectURL(p.url);
        picked = picked.filter((x) => x !== p);
      } catch (err) { failed.push(`${p.file.name}: ${err.message}`); }
    }
    busy = false;
    try { await refresh(lastDate); } catch { /* список обновится при следующем открытии окна */ }
    if (ok) toast(`Загружено: ${ppPlural(ok, 'фото', 'фото', 'фото')}${failed.length ? `, не загружено: ${failed.length}` : ''}`, failed.length ? 'warn' : 'ok');
    if ($('#ppUpErr')) $('#ppUpErr').textContent = failed.length ? `Не удалось загрузить:\n${failed.join('\n')}` : '';
    setStatus(failed.length ? 'Не загруженные фото остались в списке — можно нажать «Загрузить» ещё раз.' : ok ? '✓ Готово' : '');
    paintPicked();
  };
}

// Кнопка «📷» на карточке точки — одна на все страницы: достаточно data-point-photos="номер комплекса".
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-point-photos]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  openPointPhotos(btn.dataset.pointPhotos, btn.dataset.ppBack && typeof openPhotosModal === 'function' ? () => openPhotosModal() : null);
}, true);


// ---------- Просмотр фото на всё окно: крестик, Esc, стрелки «‹ ›» (и ← → на клавиатуре, свайп на телефоне) ----------
// Работает для любой ссылки <a data-pv> (миниатюра фото): листается набор ссылок внутри ближайшего [data-pv-scope].
// Ctrl/Shift/средняя кнопка — как обычно, в новой вкладке.
function closePhotoViewer() {
  const box = document.getElementById('pvBox');
  if (box && box._pvCleanup) box._pvCleanup();
  if (box) box.remove();
}

function openPhotoViewer(items, start = 0) {
  if (!items.length) return;
  closePhotoViewer();
  let i = Math.min(Math.max(start, 0), items.length - 1);
  const btn = 'border:0; cursor:pointer; color:#e2e8f0; background:rgba(51,65,85,.75); border-radius:12px;';
  const arrow = `${btn} position:absolute; top:50%; transform:translateY(-50%); width:48px; height:72px; font-size:34px; line-height:1;`;
  const box = document.createElement('div');
  box.id = 'pvBox';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.style.cssText = 'position:fixed; inset:0; z-index:1000; background:rgba(2,6,23,.96); display:flex; flex-direction:column;';
  box.innerHTML = `
    <div style="display:flex; align-items:center; gap:12px; padding:10px 16px; color:#e2e8f0; font-size:14px">
      <b id="pvCount" style="white-space:nowrap"></b>
      <span id="pvTitle" style="flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#94a3b8"></span>
      <a id="pvDl" download style="${btn} padding:6px 12px; text-decoration:none; font-size:13px; white-space:nowrap">⬇ Скачать</a>
      <button type="button" id="pvClose" title="Закрыть (Esc)" aria-label="Закрыть" style="${btn} width:40px; height:40px; font-size:22px; line-height:1">✕</button>
    </div>
    <div style="position:relative; flex:1; min-height:0; display:flex; align-items:center; justify-content:center; padding:0 64px 16px">
      <button type="button" id="pvPrev" title="Назад (←)" aria-label="Предыдущее фото" style="${arrow} left:8px">‹</button>
      <img id="pvImg" alt="" style="max-width:100%; max-height:100%; object-fit:contain; border-radius:6px; user-select:none">
      <div id="pvErr" style="display:none; max-width:420px; text-align:center; color:#cbd5e1; font-size:14px">Это фото не получается показать в браузере (формат или файл недоступен). Его можно скачать кнопкой «Скачать».</div>
      <button type="button" id="pvNext" title="Вперёд (→)" aria-label="Следующее фото" style="${arrow} right:8px">›</button>
    </div>`;
  document.body.appendChild(box);
  const prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  const $$ = (id) => box.querySelector('#' + id);
  const img = $$('pvImg'), err = $$('pvErr');

  const show = (n) => {
    i = Math.min(Math.max(n, 0), items.length - 1);
    const it = items[i];
    err.style.display = 'none';
    img.style.display = '';
    img.src = it.url;
    $$('pvCount').textContent = `${i + 1} / ${items.length}`;
    $$('pvTitle').textContent = [it.sub, it.title].filter(Boolean).join(' · ');
    const dl = $$('pvDl');
    dl.href = photoDownloadUrl(it.url);
    dl.setAttribute('download', it.name || '');
    $$('pvPrev').style.visibility = i > 0 ? 'visible' : 'hidden';
    $$('pvNext').style.visibility = i < items.length - 1 ? 'visible' : 'hidden';
    [i - 1, i + 1].forEach((k) => { if (items[k]) { const pre = new Image(); pre.src = items[k].url; } });   // соседние грузятся заранее
  };
  img.onerror = () => { img.style.display = 'none'; err.style.display = 'block'; };

  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closePhotoViewer(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); show(i - 1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); show(i + 1); }
    else if (e.key === 'Home') { e.preventDefault(); show(0); }
    else if (e.key === 'End') { e.preventDefault(); show(items.length - 1); }
  };
  document.addEventListener('keydown', onKey, true);
  let x0 = null;
  box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
  box.addEventListener('touchend', (e) => {
    if (x0 === null) return;
    const dx = e.changedTouches[0].clientX - x0;
    x0 = null;
    if (Math.abs(dx) > 60) show(i + (dx < 0 ? 1 : -1));
  });
  box._pvCleanup = () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = prevOverflow; };
  $$('pvClose').onclick = closePhotoViewer;
  $$('pvPrev').onclick = () => show(i - 1);
  $$('pvNext').onclick = () => show(i + 1);
  show(i);
  $$('pvClose').focus();
}

document.addEventListener('click', (e) => {
  const a = e.target.closest('a[data-pv]');
  if (!a || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey) return;
  e.preventDefault();
  e.stopPropagation();
  const scope = a.closest('[data-pv-scope]') || document;
  const links = [...scope.querySelectorAll('a[data-pv]')];
  openPhotoViewer(links.map((el) => ({ url: el.getAttribute('href'), title: el.dataset.pvTitle || '', sub: el.dataset.pvSub || '' })), links.indexOf(a));
}, true);


// ---------- ссылка «🤖 Помощник» на страницах: видна, когда помощник включён (администратору — всегда, чтобы мог открыть и проверить) ----------
function mountAssistantLink() {
  const link = document.getElementById('assistantPageLink');
  if (!link || !can('assistant.use')) return;
  Api.get('/api/assistant/info').then((info) => { if (info.enabled || can('admin.settings')) link.classList.remove('hidden'); }).catch(() => {});
}

// Пункт «🎮 Игры» в меню пользователя — только тем, кому администратор включил игры (страница /games, app/services/games.py)
function mountGamesLink() {
  const menu = document.getElementById('userMenu');
  if (!menu || document.getElementById('gamesMenuLink') || location.pathname === '/games') return;
  Api.get('/api/games/me').then((info) => {
    if (!info || !info.enabled || !info.games.length || document.getElementById('gamesMenuLink')) return;
    const a = document.createElement('a');
    a.id = 'gamesMenuLink'; a.href = '/games'; a.textContent = '🎮 Игры';
    a.className = 'block w-full text-left px-3 py-2 rounded-xl text-sm hover:bg-slate-700/50 transition-colors';
    menu.insertBefore(a, menu.firstElementChild);
  }).catch(() => {});
}

// ---------- Бригада: выбор оснащения и персонала (общее для календаря и «Все АПК») ----------
const EQUIP_OPTIONS = ['Лестница', 'Автовышка', 'Пешая', 'Другое'];

// Shared by editCrewInfo/crewQuickCreate/previewKml — a fitters/drivers/
// operator checkbox picker with busy-elsewhere and absence greyed out.
function personPickerHtml(people, { checkedIds = new Set(), busyIds = new Set(), absentMap = {}, contractor = {} } = {}) {
  const roleLabel = { fitter: 'Монтёры', driver: 'Водители', operator: 'Операторы' };
  const roleWord = { fitter: 'монтёр монтер', driver: 'водитель', operator: 'оператор' }; // для поиска
  const kindWord = { tower: 'вышки', cover: 'прикрытия' };                                 // вид водителя
  const groups =['fitter', 'driver', 'operator'].map((rt) => {
    const list = people.filter((p) => p.role_type === rt);
    if (!list.length) return '';
    return `<div class="mb-3" data-person-group><b class="text-xs text-slate-400 block mb-1.5">${roleLabel[rt]}</b>
      ${list.map((p) => {
        const absentReason = absentMap[p.id];
        // Fitters/drivers are physically in one place — busy-elsewhere still
        // blocks them. Operators routinely watch several crews' cameras at
        // once, so "busy" is shown as a hint only, never disabling the box.
        const busy = busyIds.has(p.id) && !checkedIds.has(p.id);
        const blockingBusy = busy && rt !== 'operator';
        const disabled = blockingBusy || absentReason !== undefined;
        const note = absentReason !== undefined
          ? ` <span class="text-rose-400">(нет${absentReason ? ': ' + esc(absentReason) : ''})</span>`
          : busy ? ' <span class="text-slate-500">(занят в другой бригаде)</span>' : '';
        const kind = rt === 'driver' ? kindWord[p.driver_kind] : '';
        const hay = [p.full_name, p.phone, roleLabel[rt], roleWord[rt], kind].filter(Boolean).join(' ').toLowerCase();
        return `<label data-person-row data-search="${esc(hay)}" class="flex items-center gap-2 text-sm py-1 ${disabled ? 'opacity-40' : ''}">
          <input type="checkbox" name="person" value="${p.id}" ${checkedIds.has(p.id) ? 'checked' : ''} ${disabled ? 'disabled' : ''} class="rounded accent-indigo-500">
          ${esc(p.full_name)}${kind ? ` <span class="rounded-full bg-indigo-500/15 text-indigo-300 text-[10px] px-1.5 py-0.5">водитель ${kind}</span>` : ''}${p.phone ? ` <span class="text-slate-500">· ${esc(p.phone)}</span>` : ''}${note}
        </label>`;
      }).join('')}
    </div>`;
  }).join('');
  // «Подрядчик» — не человек из персонала (подрядчики часто разные), а отметка на бригаде: её можно поставить в нескольких бригадах
  // одного дня сразу («занят в другой бригаде» к ней не относится), а в план-задание она не печатается.
  const contractorBlock = `<div class="mb-3" data-contractor-block>
      <b class="text-xs text-slate-400 block mb-1.5">Подрядчик</b>
      <label class="flex items-center gap-2 text-sm py-1"><input type="checkbox" name="contractor" ${contractor.on ? 'checked' : ''} class="rounded accent-indigo-500"> Подрядчик в составе бригады</label>
      <input name="contractor_note" value="${esc(contractor.note || '')}" maxlength="120" placeholder="кто или какая организация (необязательно)" class="${fieldCls} mt-1 ${contractor.on ? '' : 'hidden'}">
      <p class="text-[11px] text-slate-500 mt-1">Не из персонала: можно отметить в нескольких бригадах сразу. В план-задание не печатается.</p>
    </div>`;
  return `<div data-person-picker>
    <input type="search" data-person-search placeholder="Поиск по ФИО или телефону…" autocomplete="off" class="${fieldCls} mb-3">
    ${groups || '<p class="text-sm text-slate-500 mb-3">Нет активного персонала — добавьте в разделе «Персонал».</p>'}
    <p data-person-empty class="hidden text-sm text-slate-500 mb-3">Никого не найдено</p>
    ${contractorBlock}
  </div>`;
}

// Поиск в выборе персонала: прячет неподходящих (отметки у спрятанных сохраняются и
// уходят в форму как есть). Слова ищутся в любом порядке: «иван петров» найдёт «Петров Иван».
document.addEventListener('input', (e) => {
  const inp = e.target.closest?.('[data-person-search]');
  if (!inp) return;
  const box = inp.closest('[data-person-picker]');
  const tokens = inp.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
  let shown = 0;
  box.querySelectorAll('[data-person-row]').forEach((row) => {
    const hit = tokens.every((t) => row.dataset.search.includes(t));
    row.classList.toggle('hidden', !hit);
    if (hit) shown++;
  });
  box.querySelectorAll('[data-person-group]').forEach((g) => g.classList.toggle('hidden', !g.querySelector('[data-person-row]:not(.hidden)')));
  box.querySelector('[data-person-empty]').classList.toggle('hidden', shown > 0);
});
// Отметка «Подрядчик» показывает/прячет поле «кто именно».
document.addEventListener('change', (e) => {
  const chk = e.target.closest?.('input[name="contractor"]');
  if (!chk) return;
  chk.closest('[data-contractor-block]')?.querySelector('input[name="contractor_note"]')?.classList.toggle('hidden', !chk.checked);
});
// Отметка «Подрядчик» из формы бригады — для запроса /api/crews.
function crewContractorFields(form) {
  return {
    contractor: !!form.querySelector('input[name="contractor"]:checked'),
    contractor_note: (form.querySelector('input[name="contractor_note"]')?.value || '').trim(),
  };
}
// Enter в строке поиска не должен отправлять форму бригады.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.closest?.('[data-person-search]')) e.preventDefault();
});

// Opens the "assemble a crew" dialog for a date and resolves with the
// created crew, or null if the dispatcher cancelled.
async function crewQuickCreate(date) {
  let people, busyIds, absentMap;
  try {
    [people, busyIds, absentMap] = await Promise.all([
      Api.get('/api/people?active_only=true'),
      Api.get('/api/crews?date=' + date).then((crews) => new Set(crews.flatMap((c) => c.members.map((p) => p.id)))),
      Api.get('/api/people/absent-on/' + date),
    ]);
  } catch (e) { alert('Не удалось загрузить персонал: ' + e.message); return null; }

  return new Promise((resolve) => {
    modal(`<h2 class="font-display text-lg font-bold mb-1">Новая бригада</h2>
      <p class="text-sm text-slate-400 mb-4">На ${esc(fmtDate(date))}</p>
      <form id="quickCrewForm" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls}">Название (необязательно)<input name="name" placeholder="например: трасса М-4" class="${fieldCls}"></label>
          <label class="${labelCls}">Транспорт<select name="equip" class="${fieldCls}">${EQUIP_OPTIONS.map((z) => `<option>${z}</option>`).join('')}</select></label>
          <label class="${labelCls} col-span-2">Место работ (необязательно)<input name="place" placeholder="например: г. Тихорецк, ст. Северская или по дороге А-147" class="${fieldCls}"></label>
        </div>
        ${personPickerHtml(people, { busyIds, absentMap })}
        <div id="quickCrewError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
        <div class="flex items-center gap-2 pt-2">
          <button type="button" class="cancel ${btnGhost}">Отмена</button>
          <button class="${btnPrimary}">Создать бригаду</button>
        </div>
      </form>`);
    $('.cancel')?.addEventListener('click', () => resolve(null));
    $('#quickCrewForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const submitBtn = e.target.querySelector('button:not(.cancel)');
      if (submitBtn.disabled) return; // guards against a double-click firing this twice
      submitBtn.disabled = true;
      const person_ids = [...e.target.querySelectorAll('input[name="person"]:checked')].map((el) => +el.value);
      try {
        const crew = await Api.post('/api/crews', { date, name: f.name.value.trim(), equip: f.equip.value, place: f.place.value.trim(), person_ids, ...crewContractorFields(e.target) });
        $('#modal').innerHTML = '';
        resolve(crew);
      } catch (err) {
        submitBtn.disabled = false;
        $('#quickCrewError').textContent = err.message;
        $('#quickCrewError').classList.remove('hidden');
      }
    };
  });
}

// ---------- Неисправность из отчётов в карточке комплекса ----------
// Раздел «Неисправность / описание»: под обычным описанием два поля заполняются сами из последнего отчёта выезда — почему не работает и что нужно для
// восстановления (app/core/fault.py). Отчёт «Работает» их очищает; вручную править можно, следующий более свежий отчёт заменит их новыми данными.
function faultFieldsHtml(p) {
  const src = p.fault_at ? `из отчёта от ${esc(fmtDateTime(p.fault_at, true))}${p.fault_by ? ', ' + esc(p.fault_by) : ''}` : 'заполнится из отчёта выезда';
  return `<div class="rounded-xl border border-amber-500/25 bg-amber-500/5 p-3 space-y-2.5" data-fault-fields>
    <label class="${labelCls}">Почему не работает<textarea name="fault_reason" rows="2" class="${fieldCls}" placeholder="например: нет питания, обрыв линии">${esc(p.fault_reason || '')}</textarea></label>
    <label class="${labelCls}">Что нужно для восстановления<textarea name="fault_need" rows="2" class="${fieldCls}" placeholder="например: блок питания, кабель 50 м, автовышка">${esc(p.fault_need || '')}</textarea></label>
    <p class="text-[11px] text-slate-500">${src}. Можно поправить вручную; когда выезд закончится итогом «Работает», поля очистятся сами.</p>
  </div>`;
}
const readFaultFields = (form) => ({ fault_reason: form.elements.fault_reason?.value.trim() ?? '', fault_need: form.elements.fault_need?.value.trim() ?? '' });
// Короткая подпись для строки комплекса в списках: «⚠ Почему: … · Нужно: …».
function faultLineHtml(p) {
  if (!p.fault_reason && !p.fault_need) return '';
  return `<br><span class="text-amber-300/90" title="Из последнего отчёта выезда${p.fault_at ? ' от ' + esc(fmtDateTime(p.fault_at, true)) : ''}">⚠ ${p.fault_reason ? 'Почему: ' + esc(p.fault_reason) : ''}${p.fault_reason && p.fault_need ? ' · ' : ''}${p.fault_need ? 'Нужно: ' + esc(p.fault_need) : ''}</span>`;
}

// Строка в карточке комплекса: когда был последний выезд, какой и чем кончился; если не починили — что нужно для восстановления (из того же отчёта).
// Прежняя строка «⚠ Почему / Нужно» (faultLineHtml) остаётся; «Нужно» из отчёта не повторяется, если оно уже показано там.
function lastVisitLineHtml(p) {
  const lv = p.last_visit;
  if (!lv || !lv.date) return '';
  const fixed = !lv.result || lv.result === 'Работает';
  const head = [fmtDate(lv.date), lv.type, lv.result ? 'итог: ' + lv.result : ''].filter(Boolean).map(esc).join(' · ');
  const need = !fixed && lv.needs && lv.needs.trim().toLowerCase() !== (p.fault_need || '').trim().toLowerCase() ? lv.needs : '';
  const why = !fixed && lv.fault && !p.fault_reason ? lv.fault : '';
  return `<br><span data-last-visit class="${fixed ? 'text-slate-500' : 'text-amber-300/90'}" title="По отчёту последнего выезда">🕘 Последний выезд: ${head}</span>`
    + (why ? `<br><span data-last-why class="text-amber-300/90">Что неисправно: ${esc(why)}</span>` : '')
    + (need ? `<br><span data-last-need class="text-amber-300/90">Нужно для восстановления: ${esc(need)}</span>` : '');
}

// ---------- Выпадающие меню шапки («Документы», «Настройки», пользователь) всегда помещаются в экран ----------
// Меню открывается под своей кнопкой с выравниванием по левому или правому краю; когда шапка переносится на узком окне или при увеличенном масштабе, кнопка оказывается у края
// экрана, и окно меню выезжало за него (обрезались пункты, не было видно «Копия», «Восстановить»). После каждого нажатия и при изменении размера окна открытые меню сдвигаются внутрь экрана,
// ширина ограничивается шириной окна, а если меню ниже экрана — ограничивается высота и появляется прокрутка.
function fitHeaderMenus() {
  const vw = document.documentElement.clientWidth;
  const vh = window.innerHeight;
  document.querySelectorAll('[id$="Menu"].absolute:not(.hidden)').forEach((el) => {
    el.style.maxWidth = `${vw - 16}px`;
    el.style.transform = '';
    el.style.maxHeight = '';
    el.style.overflowY = '';
    const r = el.getBoundingClientRect();
    let dx = 0;
    if (r.left < 8) dx = 8 - r.left;
    else if (r.right > vw - 8) dx = vw - 8 - r.right;
    if (dx) el.style.transform = `translateX(${Math.round(dx)}px)`;
    if (r.bottom > vh - 8) {
      el.style.maxHeight = `${Math.max(180, vh - r.top - 12)}px`;
      el.style.overflowY = 'auto';
    }
  });
}
document.addEventListener('click', () => requestAnimationFrame(fitHeaderMenus), true);
window.addEventListener('resize', fitHeaderMenus);

// ---------- Уведомления (toast) вместо блокирующих alert() ----------
// alert() останавливает страницу, пока на него не нажмут «ОК», а длинные итоги (импорт, выгрузка) в нём плохо читаются. Теперь alert() показывает уведомление в углу экрана, не блокируя работу:
// короткое — исчезает само (чем длиннее текст, тем дольше), длинное или многострочное — остаётся, пока его не закроют. Нужен настоящий блокирующий диалог (перед переходом на другую
// страницу) — alertNow(). confirm() и prompt() остаются обычными.
const alertNow = window.alert.bind(window);
(function mountToasts() {
  const css = document.createElement('style');
  css.textContent = `#lcToasts{position:fixed;right:14px;bottom:14px;z-index:80;display:flex;flex-direction:column;gap:8px;max-width:min(440px,calc(100vw - 28px));pointer-events:none}
    .lc-toast{pointer-events:auto;display:flex;gap:10px;align-items:flex-start;padding:10px 12px;border-radius:14px;border:1px solid rgba(148,163,184,.35);border-left-width:4px;
      background:rgba(15,23,42,.97);color:#f1f5f9;font-size:13px;line-height:1.45;box-shadow:0 12px 34px rgba(0,0,0,.45);animation:lcToastIn .22s ease-out;white-space:pre-wrap;overflow-wrap:anywhere;max-height:60vh;overflow:auto}
    .lc-toast.ok{border-left-color:#34d399}.lc-toast.warn{border-left-color:#fbbf24}.lc-toast.error{border-left-color:#fb7185}.lc-toast.info{border-left-color:#818cf8}
    .lc-toast button{margin-left:auto;flex:none;background:none;border:0;color:#94a3b8;font-size:16px;line-height:1;cursor:pointer;padding:0 2px}
    @keyframes lcToastIn{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:none}}
    #lcNetBar{position:fixed;left:0;right:0;top:0;z-index:90;display:none;padding:6px 12px;text-align:center;font-size:13px;background:#b45309;color:#fff7ed}`;
  document.head.appendChild(css);
})();

function toast(message, kind) {
  const text = String(message ?? '').trim();
  if (!text) return;
  let box = document.getElementById('lcToasts');
  if (!box) { box = document.createElement('div'); box.id = 'lcToasts'; document.body.appendChild(box); }
  const k = kind || (/^(не удалось|ошибка|нельзя|не получилось|не найден|нет связи|не хватает)/i.test(text) ? 'error'
    : /^(добавлено|готово|сохранено|✓|выгружено|импортировано|создан|удален|скопирован)/i.test(text) ? 'ok' : /^(внимание|предупреждение|⚠)/i.test(text) ? 'warn' : 'info');
  const el = document.createElement('div');
  el.className = `lc-toast ${k}`;
  el.setAttribute('role', k === 'error' ? 'alert' : 'status');
  const body = document.createElement('div');
  body.textContent = text;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', 'Закрыть');
  close.textContent = '×';
  el.append(body, close);
  const remove = () => { el.remove(); };
  close.onclick = remove;
  box.appendChild(el);
  while (box.children.length > 5) box.firstElementChild.remove();
  const sticky = text.length > 160 || text.includes('\n') || k === 'error';
  if (!sticky) setTimeout(remove, Math.min(9000, 3500 + text.length * 40));
}
window.alert = (message) => toast(message);

// ---------- Полоска «нет связи с сервером» ----------
// api.js сообщает событием lc-net, что запросы перестали (или снова стали) проходить: страница остаётся на экране с последними данными, а наверху видно, что они могут быть устаревшими.
window.addEventListener('lc-net', (e) => {
  let bar = document.getElementById('lcNetBar');
  if (!bar) { bar = document.createElement('div'); bar.id = 'lcNetBar'; bar.setAttribute('role', 'status'); document.body.appendChild(bar); }
  if (e.detail && e.detail.ok) {
    if (bar.style.display === 'block') { bar.textContent = '✓ Связь с сервером восстановлена'; bar.style.background = '#047857'; setTimeout(() => { bar.style.display = 'none'; }, 2200); }
  } else {
    bar.textContent = '⚠ Нет связи с сервером — на экране последние полученные данные, они могут быть устаревшими. Пробую подключиться снова…';
    bar.style.background = '#b45309';
    bar.style.display = 'block';
  }
});
// Необработанная ошибка в запросе не должна пропадать молча: человек увидит, что что-то не получилось.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e && e.reason && e.reason.message;
  if (msg && !/Требуется вход/.test(msg)) toast(msg, 'error');
});

// ---------- Автоматический выход при бездействии ----------
// Время бездействия задаёт администратор сервера (SESSION_IDLE_MINUTES в .env, 0 — выключено; рекомендуется 30–60). Без нажатий клавиш, движения мыши, касаний и прокрутки сеанс
// завершается, и открывается страница входа: оставленное без присмотра окно не должно давать доступ к данным. Страницы-«дежурные» (мониторинг, уведомления) при включении этой
// настройки тоже выходят — для них оставьте 0 или используйте отдельную учётную запись.
let _idleTimer = null;
function startIdleLogout(limitMinutes, tickMs = 15000) {
  if (!limitMinutes || _idleTimer) return;
  let last = Date.now();
  const touch = () => { last = Date.now(); };
  ['mousemove', 'keydown', 'click', 'touchstart', 'wheel', 'scroll'].forEach((ev) => window.addEventListener(ev, touch, { passive: true, capture: true }));
  _idleTimer = setInterval(() => {
    if (Date.now() - last < limitMinutes * 60000) return;
    clearInterval(_idleTimer);
    fetch('/api/auth/logout?idle=true', { method: 'POST', credentials: 'same-origin' }).finally(() => { window.location.href = '/login'; });
  }, tickMs);
}
(function mountIdleLogout() {
  if (typeof Api === 'undefined' || location.pathname === '/login') return;
  Api.get('/api/security/policy').then((p) => startIdleLogout((p && p.idle_minutes) || 0)).catch(() => { /* политика недоступна — выход по бездействию не включается */ });
})();
