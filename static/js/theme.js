// Темы оформления: готовые («Тёмная», «Светлая», «Океан», «Лес», «Закат»…), системная (как в Windows) и свои — цвет фона и акцента
// настраиваются ползунками. Кнопка темы (🌙/☀ в шапке) открывает меню; там же — «Фон»: эффекты и анимация по погоде в Краснодаре
// (static/js/fx.js).
//
// Как это устроено: вся разметка собрана на переменных CSS (--slate-50…950, --indigo-50…950, --bg-base, --l-*… — см. начало
// static/css/theme.css), а тема — это набор значений этих переменных. Выбор запоминается в localStorage («theme» — номер темы,
// «themeVars» — готовая строка переменных, «themeMode» — светлая/тёмная основа); маленький скрипт в <head> каждой страницы
// применяет их ещё до первой отрисовки, поэтому вспышки старой темы при загрузке нет.
(function () {
  'use strict';
  const root = document.documentElement;
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* приватный режим — тема просто не запомнится */ } },
  };

  // ---------- цвет ----------
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  function hsl(h, s, l) {      // h 0..360, s и l в процентах → строка «R G B»
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 100) / 100; l = clamp(l, 0, 100) / 100;
    const k = (n) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return [f(0), f(8), f(4)].map((x) => Math.round(x * 255)).join(' ');
  }
  const SLATE_L = { 50: 98, 100: 96, 200: 91, 300: 84, 400: 65, 500: 47, 600: 35, 700: 27, 800: 17, 900: 11, 950: 5 };
  const SLATE_S = { 50: 40, 100: 40, 200: 32, 300: 27, 400: 20, 500: 16, 600: 19, 700: 25, 800: 33, 900: 47, 950: 60 };
  const ACC_L = { 50: 97, 100: 94, 200: 88, 300: 81, 400: 74, 500: 67, 600: 59, 700: 51, 800: 41, 900: 32, 950: 21 };
  const ACC_S = { 50: 100, 100: 100, 200: 96, 300: 94, 400: 89, 500: 84, 600: 75, 700: 58, 800: 50, 900: 47, 950: 57 };

  // На ступенях 500…950 стоят заливки кнопок с белым текстом. Одинаковая «светлота» HSL у разных оттенков даёт разную яркость
  // для глаза: бирюзовый или оранжевый при том же уровне, что у индиго, заметно светлее, и белая надпись на нём не читается.
  // Поэтому для этих ступеней задан потолок относительной яркости (по WCAG); у индиго-оттенка по умолчанию он не срабатывает.
  const ACC_LUM_MAX = { 500: 0.21, 600: 0.15, 700: 0.105, 800: 0.075, 900: 0.048, 950: 0.028 };
  function luminance(rgb) {
    const [r, g, b] = rgb.split(' ').map((n) => { const c = Number(n) / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }
  function accentShade(ah, as, step) {
    let l = ACC_L[step], c = hsl(ah, ACC_S[step] * as, l);
    const max = ACC_LUM_MAX[step];
    while (max && l > 6 && luminance(c) > max) { l -= 1; c = hsl(ah, ACC_S[step] * as, l); }
    return c;
  }

  // Параметры темы: mode (dark|light), h/s — оттенок и насыщенность фона, ah/as — оттенок и насыщенность акцента, deep — глубокий чёрный,
  // glow — сила подсветки фона (0..2).
  function buildVars(t) {
    const v = {};
    const s = t.s == null ? 1 : t.s;
    const as = t.as == null ? 1 : t.as;
    const dark = t.mode !== 'light';
    const acc = {};
    Object.keys(ACC_L).forEach((k) => { acc[k] = accentShade(t.ah, as, k); v[`--indigo-${k}`] = acc[k]; });
    const glow = t.glow == null ? 1 : t.glow;
    if (dark) {
      const lift = t.deep ? { 800: 9, 900: 5, 950: 2 } : {};
      Object.keys(SLATE_L).forEach((k) => { v[`--slate-${k}`] = hsl(t.h, SLATE_S[k] * s, lift[k] != null ? lift[k] : SLATE_L[k]); });
      v['--bg-base'] = t.deep ? hsl(t.h, 10 * s, 1) : hsl(t.h, 42 * s, 6);
      v['--glow-1'] = acc['500']; v['--glow-1-a'] = (0.10 * glow).toFixed(3);
      v['--glow-2'] = hsl(t.ah + 140, 70, 45); v['--glow-2-a'] = (0.06 * glow).toFixed(3);
      v['--text'] = v['--slate-200'];
      v['--glass-1'] = v['--slate-800']; v['--glass-2'] = v['--slate-900'];
      v['--glass-border'] = v['--slate-400'];
      v['--field-bg'] = v['--slate-900']; v['--field-border'] = v['--slate-700']; v['--field-text'] = v['--slate-200']; v['--placeholder'] = v['--slate-500'];
      v['--scroll'] = v['--slate-700'];
    } else {
      v['--bg-base'] = hsl(t.h, 40 * s, 97);
      v['--glow-1'] = acc['500']; v['--glow-1-a'] = (0.08 * glow).toFixed(3);
      v['--glow-2'] = hsl(t.ah + 140, 70, 50); v['--glow-2-a'] = (0.05 * glow).toFixed(3);
      v['--text'] = hsl(t.h, 33 * s, 17);
      v['--glass-1'] = '255 255 255'; v['--glass-2'] = hsl(t.h, 40 * s, 98);
      v['--glass-border'] = hsl(t.h, 16 * s, 47);
      v['--field-bg'] = '255 255 255'; v['--field-border'] = hsl(t.h, 27 * s, 84); v['--field-text'] = hsl(t.h, 33 * s, 17); v['--placeholder'] = hsl(t.h, 16 * s, 62);
      v['--scroll'] = hsl(t.h, 27 * s, 84);
      v['--l-bg-soft'] = hsl(t.h, 40 * s, 95); v['--l-surface'] = '255 255 255'; v['--l-surface-2'] = hsl(t.h, 40 * s, 98);
      v['--l-surface-3'] = hsl(t.h, 32 * s, 92); v['--l-surface-4'] = hsl(t.h, 27 * s, 84); v['--l-border'] = hsl(t.h, 27 * s, 84);
      v['--l-text-strong'] = hsl(t.h, 47 * s, 11); v['--l-text'] = hsl(t.h, 25 * s, 27); v['--l-muted'] = hsl(t.h, 16 * s, 44);
      v['--l-hover'] = hsl(t.ah, 100, 96);
    }
    // Дополнительные параметры своей темы (у встроенных их нет — они выглядят как прежде)
    if (t.ca != null) { v['--glass-1-a'] = String(t.ca); v['--glass-2-a'] = String(t.ca); v['--field-bg-a'] = String(Math.min(1, t.ca + 0.05)); }   // прозрачность карточек
    if (t.rs != null && t.rs !== 1) v['--lc-rs'] = String(t.rs);                                                                                   // скругление углов
    if (t.fs != null && t.fs !== 1) v['--lc-fs'] = String(t.fs);                                                                                   // размер шрифта
    if (t.bh != null) { ['400', '500', '600'].forEach((k) => { v[`--lc-b${k}`] = accentShade(t.bh, as, k); }); }                                    // свой цвет кнопок
    return v;
  }
  // Признаки оформления кнопок — атрибуты data-* на <html> (их читает static/css/theme.css)
  function themeAttrs(t) {
    const a = {};
    if (t.bs === 'gradient' || t.bs === 'outline' || t.bs === 'glass') a.btn = t.bs;
    if (t.gl === 'none' || t.gl === 'strong') a.glow = t.gl;
    if (t.bh != null) a.bhue = '1';
    return a;
  }

  const BUILTIN = [
    { id: 'dark', name: 'Тёмная', mode: 'dark', base: true, preview: ['#080b14', '#1e293b', '#6366f1'] },
    { id: 'midnight', name: 'Полночь', mode: 'dark', h: 232, s: 1.35, ah: 258, glow: 1.5 },
    { id: 'ocean', name: 'Океан', mode: 'dark', h: 200, s: 1.2, ah: 188, glow: 1.3 },
    { id: 'forest', name: 'Лес', mode: 'dark', h: 152, s: 1.0, ah: 145, glow: 1.3 },
    { id: 'sunset', name: 'Закат', mode: 'dark', h: 345, s: 1.0, ah: 18, glow: 1.6 },
    { id: 'sakura', name: 'Сакура', mode: 'dark', h: 330, s: 0.85, ah: 334, glow: 1.4 },
    { id: 'cyber', name: 'Кибер', mode: 'dark', h: 268, s: 1.5, ah: 305, glow: 2.0 },
    { id: 'coffee', name: 'Кофе', mode: 'dark', h: 28, s: 0.9, ah: 32, glow: 1.0 },
    { id: 'graphite', name: 'Графит', mode: 'dark', h: 220, s: 0.12, ah: 210, glow: 0.6 },
    { id: 'amoled', name: 'Чёрная', mode: 'dark', h: 0, s: 0, ah: 220, deep: true, glow: 0.4 },
    { id: 'light', name: 'Светлая', mode: 'light', base: true, preview: ['#f6f8fc', '#ffffff', '#6366f1'] },
    { id: 'paper', name: 'Бумага', mode: 'light', h: 38, s: 0.9, ah: 24, glow: 0.9 },
    { id: 'mint', name: 'Мята', mode: 'light', h: 160, s: 0.9, ah: 162, glow: 1.0 },
    { id: 'sky', name: 'Небо', mode: 'light', h: 205, s: 1.0, ah: 212, glow: 1.0 },
    { id: 'lavender', name: 'Лаванда', mode: 'light', h: 265, s: 1.0, ah: 268, glow: 1.0 },
    { id: 'peach', name: 'Персик', mode: 'light', h: 18, s: 0.9, ah: 14, glow: 1.0 },
  ];

  // ---------- свои темы ----------
  function customThemes() {
    try { const list = JSON.parse(store.get('customThemes', '[]')); return Array.isArray(list) ? list : []; } catch (e) { return []; }
  }
  function saveCustom(list) { store.set('customThemes', JSON.stringify(list.slice(0, 12))); }

  function findTheme(id) {
    if (id === 'auto') return findTheme(window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
    return BUILTIN.find((t) => t.id === id) || customThemes().find((t) => t.id === id) || BUILTIN[0];
  }

  // ---------- применение ----------
  let pickedId = store.get('theme', null);
  const listeners = [];
  const mode = () => (root.getAttribute('data-theme') === 'light' ? 'light' : 'dark');

  function clearVars() {
    // убираем только наши переменные — стили, которые страница могла поставить сама, не трогаем
    const keep = [];
    for (let i = 0; i < root.style.length; i++) {
      const name = root.style[i];
      if (!/^--(slate|indigo|bg-base|glow|text|glass|field|placeholder|scroll|l-|lc-)/.test(name)) keep.push([name, root.style.getPropertyValue(name)]);
    }
    root.removeAttribute('style');
    keep.forEach(([n, val]) => root.style.setProperty(n, val));
  }

  function apply(id, opts) {
    const t = typeof id === 'object' ? id : findTheme(id);
    clearVars();
    let vars = {};
    if (!t.base) vars = buildVars(t);
    Object.keys(vars).forEach((k) => root.style.setProperty(k, vars[k]));
    if (t.mode === 'light') root.setAttribute('data-theme', 'light'); else root.removeAttribute('data-theme');
    const attrs = t.base ? {} : themeAttrs(t);
    ['btn', 'glow', 'bhue'].forEach((a) => root.removeAttribute('data-' + a));
    Object.keys(attrs).forEach((a) => root.setAttribute('data-' + a, attrs[a]));
    if (!opts || !opts.preview) {
      store.set('themeAttrs', Object.keys(attrs).map((k) => `${k}=${attrs[k]}`).join(';'));
      pickedId = typeof id === 'object' ? id.id : id;
      store.set('theme', pickedId);
      store.set('themeMode', t.mode);
      store.set('themeVars', Object.keys(vars).map((k) => `${k}:${vars[k]}`).join(';'));
    }
    const moon = document.getElementById('themeIconMoon');
    const sun = document.getElementById('themeIconSun');
    if (moon && sun) { moon.classList.toggle('hidden', t.mode === 'light'); sun.classList.toggle('hidden', t.mode !== 'light'); }
    listeners.forEach((fn) => { try { fn(t); } catch (e) { /* слушатель не должен ломать смену темы */ } });
    document.dispatchEvent(new CustomEvent('lc-theme', { detail: { id: t.id, mode: t.mode } }));
  }

  // Плавная смена (если браузер умеет) — без мерцания: весь экран «перетекает» в новую тему.
  function applyAnimated(id) {
    const reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (document.startViewTransition && !reduce && root.getAttribute('data-fx') !== 'off') document.startViewTransition(() => apply(id));
    else apply(id);
  }

  // ---------- меню ----------
  let menu = null;
  const esc = (x) => String(x == null ? '' : x).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function swatch(t) {
    let bg, surf, acc;
    if (t.preview) { [bg, surf, acc] = t.preview; } else {
      const v = buildVars(t);
      bg = `rgb(${v['--bg-base']})`; surf = `rgb(${t.mode === 'light' ? v['--l-surface'] : v['--slate-800']})`; acc = `rgb(${v['--indigo-500']})`;
    }
    return `<span class="lc-sw" style="background:${bg}"><i style="background:${surf}"></i><b style="background:${acc}"></b></span>`;
  }

  function themeCard(t, custom) {
    return `<button type="button" class="lc-card${pickedId === t.id ? ' lc-on' : ''}" data-lc-theme="${esc(t.id)}" title="${esc(t.name)}">${swatch(t)}
      <span class="lc-nm">${esc(t.name)}</span>${custom ? `<u class="lc-edit" data-lc-edit="${esc(t.id)}" title="Изменить тему">✎</u><u data-lc-del="${esc(t.id)}" title="Удалить тему">✕</u>` : ''}</button>`;
  }

  function weatherLabel() {
    return window.LCFx && window.LCFx.describe ? window.LCFx.describe() : 'загружается…';
  }

  // Праздничное оформление (static/js/seasons.js): по умолчанию выключено, включается здесь; настройка хранится в этом браузере.
  function seasonHtml() {
    const S = window.LCSeason;
    if (!S) return '';
    const cur = store.get('lcSeason', 'off');
    const opts = [['off', 'Выключено'], ['auto', 'По датам (само в праздники)'], ...S.EVENTS.map((e) => [e.id, e.label])];
    return `<div class="lc-row"><span>Праздники</span>
        <select class="lc-sel" data-lc-season>${opts.map(([val, label]) => `<option value="${val}"${cur === val ? ' selected' : ''}>${esc(label)}</option>`).join('')}</select></div>
      <div class="lc-note" data-lc-snote>Праздничное оформление: ${esc(S.describe())}. Только украшения — кликам не мешают.</div>`;
  }

  // Звуки (static/js/sounds.js): погода, мелодия и звуки праздника; всё по умолчанию выключено, громкость общая.
  function soundHtml() {
    const S = window.LCSound;
    if (!S) return '';
    const seg = (key) => [['0', 'Выкл'], ['1', 'Вкл']].map(([val, label]) => `<button type="button" class="lc-seg${S.get(key) === val ? ' lc-on' : ''}" data-lc-snd="${key}:${val}">${label}</button>`).join('');
    const vol = S.get('vol');
    return `<div class="lc-sec">Звуки</div>
      <div class="lc-row"><span>Погода</span><span class="lc-segs">${seg('wx')}</span></div>
      <div class="lc-row"><span>Мелодия праздника</span><span class="lc-segs">${seg('music')}</span></div>
      <div class="lc-row"><span>Звуки праздника</span><span class="lc-segs">${seg('fx')}</span></div>
      <label class="lc-f"><span>Громкость <b class="lc-val" data-lc-v="snd">${vol}%</b></span><input type="range" min="0" max="100" step="1" data-lc-sndvol value="${vol}"></label>
      <div class="lc-btns"><button type="button" class="lc-btn" data-lc-sndtest>▶ Проверить звук</button></div>
      <div class="lc-note">Погода — дождь, гром, ветер, птицы, сверчки (по погоде на фоне). Мелодия — у каждого праздника своя. Звуки праздника — на нажатие кнопок и в такт украшениям (залпы салюта). Праздничные звуки работают, когда выбран или наступил праздник. Звук начинается после первого нажатия на странице (так требует браузер); настройки хранятся в этом браузере.</div>`;
  }

  function menuHtml() {
    const customs = customThemes();
    const fx = store.get('fxLevel', 'auto'), wx = store.get('fxWeather', 'none'), sn = store.get('fxSnow', 'flakes');
    const seg = (key, cur, items) => items.map(([val, label]) => `<button type="button" class="lc-seg${cur === val ? ' lc-on' : ''}" data-lc-${key}="${val}">${label}</button>`).join('');
    return `<div class="lc-hd"><b>Оформление</b><button type="button" class="lc-x" data-lc-close title="Закрыть (Esc)">✕</button></div>
      <div class="lc-sec">Тёмные</div>
      <div class="lc-grid">${BUILTIN.filter((t) => t.mode === 'dark').map((t) => themeCard(t)).join('')}</div>
      <div class="lc-sec">Светлые</div>
      <div class="lc-grid">${BUILTIN.filter((t) => t.mode === 'light').map((t) => themeCard(t)).join('')}
        <button type="button" class="lc-card${pickedId === 'auto' ? ' lc-on' : ''}" data-lc-theme="auto" title="Светлая или тёмная — как в системе"><span class="lc-sw lc-auto"><i></i><b></b></span><span class="lc-nm">Как в системе</span></button></div>
      <div class="lc-sec">Свои темы</div>
      <div class="lc-grid">${customs.map((t) => themeCard(t, true)).join('')}<button type="button" class="lc-card lc-new" data-lc-new><span class="lc-sw lc-plus">＋</span><span class="lc-nm">Создать</span></button></div>
      <div class="lc-sec">Фон и анимации</div>
      <div class="lc-row"><span>Эффекты</span><span class="lc-segs">${seg('fx', fx, [['auto', 'Авто'], ['full', 'Полные'], ['lite', 'Лёгкие'], ['off', 'Выкл']])}</span></div>
      <div class="lc-row"><span>Погода на фоне</span>
        <select class="lc-sel" data-lc-weather>${[['auto', 'По погоде (авто)'], ['clear', 'Солнечно'], ['clouds', 'Облачно'], ['rain', 'Дождь'], ['snow', 'Снег'], ['storm', 'Гроза'], ['fog', 'Туман'], ['none', 'Без погоды']]
          .map(([val, label]) => `<option value="${val}"${wx === val ? ' selected' : ''}>${label}</option>`).join('')}</select></div>
      <div class="lc-row"><span>Снег</span><span class="lc-segs">${seg('snow', sn, [['flakes', 'Снежинки'], ['dots', 'Точки']])}</span></div>
      <div class="lc-note" data-lc-wnote>Сейчас: ${esc(weatherLabel())}</div>${seasonHtml()}${soundHtml()}
      <div class="lc-sec">Своё фото на фоне</div>
      <div class="lc-photos" data-lc-photos><span class="lc-note">загрузка…</span></div>
      <input type="file" accept="image/*" multiple hidden data-lc-photo-file>
      <div data-lc-photo-ctl class="hidden">
        <label class="lc-f"><span>Затемнение <b class="lc-val" data-lc-v="dim"></b></span><input type="range" min="0" max="92" step="1" data-lc-bgdim></label>
        <label class="lc-f"><span>Размытие <b class="lc-val" data-lc-v="blur"></b></span><input type="range" min="0" max="30" step="1" data-lc-bgblur></label>
      </div>
      <div class="lc-note" data-lc-photo-msg>Любое фото (JPG, PNG, WebP…) — оно сожмётся и сохранится только в этом браузере, на сервер не уходит. Можно до 8 штук.</div>`;
  }

  // Плитки своих фото в меню: «Без фото», загруженные (клик — выбрать, ✕ — удалить) и «＋».
  async function fillPhotos() {
    const box = menu && menu.querySelector('[data-lc-photos]');
    if (!box) return;
    const msg = menu.querySelector('[data-lc-photo-msg]');
    if (!window.LCBg || !window.LCBg.supported) { box.innerHTML = '<span class="lc-note">Этот браузер не умеет хранить свои фото.</span>'; return; }
    const items = await window.LCBg.list();
    if (!menu || !menu.contains(box)) return;
    const cur = window.LCBg.current();
    box.innerHTML = `<button type="button" class="lc-ph lc-none${cur ? '' : ' lc-on'}" data-lc-ph="" title="Обычный фон темы">Без фото</button>`
      + items.map((p) => `<button type="button" class="lc-ph${cur === p.id ? ' lc-on' : ''}" data-lc-ph="${esc(p.id)}" title="${esc(p.name)}"><img src="${p.thumb}" alt=""><u data-lc-ph-del="${esc(p.id)}" title="Удалить фото">✕</u></button>`).join('')
      + (items.length < window.LCBg.max ? '<button type="button" class="lc-ph lc-add" data-lc-ph-add title="Загрузить своё фото">＋</button>' : '');
    const ctl = menu.querySelector('[data-lc-photo-ctl]');
    ctl.classList.toggle('hidden', !cur);
    const dim = menu.querySelector('[data-lc-bgdim]'), blur = menu.querySelector('[data-lc-bgblur]');
    dim.value = window.LCBg.getDim(); blur.value = window.LCBg.getBlur();
    const showVals = () => { menu.querySelector('[data-lc-v="dim"]').textContent = `${dim.value}%`; menu.querySelector('[data-lc-v="blur"]').textContent = `${blur.value} px`; };
    showVals();
    dim.oninput = () => { window.LCBg.setDim(+dim.value); showVals(); };
    blur.oninput = () => { window.LCBg.setBlur(+blur.value); showVals(); };
    const file = menu.querySelector('[data-lc-photo-file]');
    box.onclick = async (e) => {
      const del = e.target.closest('[data-lc-ph-del]');
      const add = e.target.closest('[data-lc-ph-add]');
      const pick = e.target.closest('[data-lc-ph]');
      if (del) {
        e.stopPropagation();
        if (!confirm('Удалить это фото?')) return;
        await window.LCBg.remove(del.dataset.lcPhDel);
        fillPhotos();
      } else if (add) {
        file.click();
      } else if (pick) {
        await window.LCBg.select(pick.dataset.lcPh);
        fillPhotos();
      }
    };
    file.onchange = async () => {
      const files = [...file.files];
      file.value = '';
      if (!files.length) return;
      msg.textContent = `Загружаю и сжимаю: ${files.length}…`;
      const res = await window.LCBg.add(files);
      if (res.ids.length) await window.LCBg.select(res.ids[0]);
      msg.textContent = (res.added ? `Добавлено фото: ${res.added}. ` : '') + (res.errors.length ? res.errors.join('; ') : '');
      fillPhotos();
    };
  }

  const NEW_THEME_DEFAULTS = { id: '', name: '', mode: 'dark', h: 222, s: 1, ah: 239, as: 1, glow: 1, bs: 'solid', gl: 'soft', rs: 1, ca: null, fs: 1, bh: null };

  function builderHtml(t) {
    const segs = (key, cur, items) => `<span class="lc-segs">${items.map(([val, label]) => `<button type="button" class="lc-seg${cur === val ? ' lc-on' : ''}" data-b-seg="${key}:${val}">${label}</button>`).join('')}</span>`;
    const caDefault = t.mode === 'light' ? 95 : 88;
    return `<div class="lc-hd"><b>${t.id ? 'Своя тема' : 'Новая тема'}</b><button type="button" class="lc-x" data-lc-back title="Назад">←</button></div>
      <label class="lc-f">Название<input type="text" data-b="name" maxlength="24" value="${esc(t.name)}" placeholder="Например, «Наша»"></label>
      <div class="lc-f">Основа <span class="lc-segs"><button type="button" class="lc-seg${t.mode === 'dark' ? ' lc-on' : ''}" data-b-mode="dark">Тёмная</button><button type="button" class="lc-seg${t.mode === 'light' ? ' lc-on' : ''}" data-b-mode="light">Светлая</button></span></div>
      <label class="lc-f">Оттенок фона<input type="range" min="0" max="360" step="1" data-b="h" value="${t.h}" class="lc-hue"></label>
      <label class="lc-f">Насыщенность фона<input type="range" min="0" max="160" step="1" data-b="s" value="${Math.round(t.s * 100)}"></label>
      <label class="lc-f">Цвет акцента (кнопки, выделение)<input type="range" min="0" max="360" step="1" data-b="ah" value="${t.ah}" class="lc-hue"></label>
      <label class="lc-f">Яркость акцента<input type="range" min="40" max="130" step="1" data-b="as" value="${Math.round(t.as * 100)}"></label>
      <label class="lc-f">Подсветка фона<input type="range" min="0" max="200" step="1" data-b="glow" value="${Math.round(t.glow * 100)}"></label>
      <div class="lc-fold">Кнопки и форма</div>
      <div class="lc-f">Стиль кнопок ${segs('bs', t.bs || 'solid', [['solid', 'Заливка'], ['gradient', 'Градиент'], ['outline', 'Контур'], ['glass', 'Стекло']])}</div>
      <div class="lc-f">Свечение кнопок ${segs('gl', t.gl || 'soft', [['none', 'Нет'], ['soft', 'Мягкое'], ['strong', 'Сильное']])}</div>
      <label class="lc-f" style="grid-auto-flow:column;justify-content:start;align-items:center;gap:8px"><input type="checkbox" data-b-bhue ${t.bh != null ? 'checked' : ''}> Свой цвет кнопок (отдельно от акцента)</label>
      <label class="lc-f">Цвет кнопок<input type="range" min="0" max="360" step="1" data-b="bh" value="${t.bh != null ? t.bh : t.ah}" class="lc-hue" ${t.bh != null ? '' : 'disabled'}></label>
      <label class="lc-f"><span>Скругление углов <b class="lc-val" data-b-v="rs">${Math.round((t.rs == null ? 1 : t.rs) * 100)}%</b></span><input type="range" min="0" max="220" step="5" data-b="rs" value="${Math.round((t.rs == null ? 1 : t.rs) * 100)}"></label>
      <label class="lc-f"><span>Прозрачность карточек <b class="lc-val" data-b-v="ca">${t.ca == null ? caDefault : Math.round(t.ca * 100)}%</b></span><input type="range" min="35" max="100" step="1" data-b="ca" value="${t.ca == null ? caDefault : Math.round(t.ca * 100)}"></label>
      <label class="lc-f"><span>Размер шрифта <b class="lc-val" data-b-v="fs">${Math.round((t.fs == null ? 1 : t.fs) * 100)}%</b></span><input type="range" min="85" max="125" step="1" data-b="fs" value="${Math.round((t.fs == null ? 1 : t.fs) * 100)}"></label>
      <div class="lc-btns"><button type="button" class="lc-btn" data-lc-back>Отмена</button><button type="button" class="lc-btn lc-pri" data-b-save>Сохранить</button></div>`;
  }

  let previewing = false;      // в конструкторе показан черновик темы (ещё не сохранён)
  function closeMenu() {
    if (!menu) return;
    menu.remove(); menu = null;
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', place);
    if (previewing && pickedId) apply(pickedId);          // выход из конструктора без сохранения — вернуть выбранную тему
    previewing = false;
  }
  function onOutside(e) {
    if (menu && !menu.contains(e.target) && !e.target.closest('#themeToggle')) closeMenu();
  }
  function onKey(e) {
    if (e.key === 'Escape' && menu) { e.stopImmediatePropagation(); closeMenu(); }
  }
  function place() {
    const btn = document.getElementById('themeToggle');
    if (!menu || !btn) return;
    const r = btn.getBoundingClientRect();
    const w = Math.min(360, window.innerWidth - 16);
    menu.style.width = `${w}px`;
    menu.style.left = `${clamp(r.right - w, 8, window.innerWidth - w - 8)}px`;
    menu.style.top = `${r.bottom + 8}px`;
    menu.style.maxHeight = `${window.innerHeight - r.bottom - 20}px`;
  }

  function wireMenu() {
    menu.querySelectorAll('[data-lc-close]').forEach((b) => { b.onclick = closeMenu; });
    menu.querySelectorAll('[data-lc-theme]').forEach((b) => {
      b.onclick = (e) => {
        if (e.target.closest('[data-lc-del]')) return;
        applyAnimated(b.dataset.lcTheme);
        menu.querySelectorAll('.lc-card').forEach((c) => c.classList.toggle('lc-on', c === b));
      };
    });
    menu.querySelectorAll('[data-lc-del]').forEach((u) => {
      u.onclick = (e) => {
        e.stopPropagation();
        if (!confirm('Удалить эту тему?')) return;
        saveCustom(customThemes().filter((t) => t.id !== u.dataset.lcDel));
        if (pickedId === u.dataset.lcDel) apply('dark');
        render();
      };
    });
    menu.querySelectorAll('[data-lc-fx]').forEach((b) => {
      b.onclick = () => { store.set('fxLevel', b.dataset.lcFx); if (window.LCFx) window.LCFx.refresh(); render(); };
    });
    const w = menu.querySelector('[data-lc-weather]');
    if (w) w.onchange = () => { store.set('fxWeather', w.value); if (window.LCFx) window.LCFx.refresh(); };
    const se = menu.querySelector('[data-lc-season]');
    if (se) se.onchange = () => {
      store.set('lcSeason', se.value);
      if (window.LCSeason) window.LCSeason.refresh();
      const n = menu.querySelector('[data-lc-snote]');
      if (n && window.LCSeason) n.textContent = `Праздничное оформление: ${window.LCSeason.describe()}. Только украшения — кликам не мешают.`;
    };
    menu.querySelectorAll('[data-lc-snd]').forEach((b) => {
      b.onclick = () => { const [k, v] = b.dataset.lcSnd.split(':'); if (window.LCSound) window.LCSound.set(k, v); if (k === 'wx' && window.LCFx) window.LCFx.refresh(); render(); };
    });
    const sv = menu.querySelector('[data-lc-sndvol]');
    if (sv) sv.oninput = () => { if (window.LCSound) window.LCSound.setVolume(+sv.value); const lbl = menu.querySelector('[data-lc-v="snd"]'); if (lbl) lbl.textContent = `${sv.value}%`; };
    const st = menu.querySelector('[data-lc-sndtest]');
    if (st) st.onclick = () => { if (window.LCSound) window.LCSound.test(); };
    menu.querySelectorAll('[data-lc-snow]').forEach((b) => {
      b.onclick = () => { store.set('fxSnow', b.dataset.lcSnow); if (window.LCFx) window.LCFx.refresh(); render(); };
    });
    menu.querySelectorAll('[data-lc-edit]').forEach((u) => {
      u.onclick = (e) => {
        e.stopPropagation();
        const t = customThemes().find((x) => x.id === u.dataset.lcEdit);
        if (t) builder({ ...NEW_THEME_DEFAULTS, ...t });
      };
    });
    const nw = menu.querySelector('[data-lc-new]');
    if (nw) nw.onclick = () => builder({ ...NEW_THEME_DEFAULTS, mode: pickedId && findTheme(pickedId).mode === 'light' ? 'light' : 'dark' });
    fillPhotos();
  }

  function render() {
    if (!menu) return;
    menu.innerHTML = menuHtml();
    wireMenu();
    place();
  }

  function builder(t) {
    menu.innerHTML = builderHtml(t);
    const draft = { ...t };
    const live = () => { previewing = true; apply({ ...draft, id: draft.id || 'draft', base: false }, { preview: true }); };
    menu.querySelectorAll('[data-b]').forEach((inp) => {
      inp.oninput = () => {
        const k = inp.dataset.b;
        draft[k] = k === 'name' ? inp.value : (['s', 'as', 'glow', 'rs', 'ca', 'fs'].includes(k) ? +inp.value / 100 : +inp.value);
        const label = menu.querySelector(`[data-b-v="${k}"]`);
        if (label) label.textContent = `${Math.round(+inp.value)}%`;
        if (k !== 'name') live();
      };
    });
    menu.querySelectorAll('[data-b-seg]').forEach((b) => {
      b.onclick = () => {
        const [key, val] = b.dataset.bSeg.split(':');
        draft[key] = val;
        b.parentElement.querySelectorAll('[data-b-seg]').forEach((x) => x.classList.toggle('lc-on', x === b));
        live();
      };
    });
    const bhueChk = menu.querySelector('[data-b-bhue]'), bhueRange = menu.querySelector('[data-b="bh"]');
    bhueChk.onchange = () => {
      bhueRange.disabled = !bhueChk.checked;
      draft.bh = bhueChk.checked ? +bhueRange.value : null;
      live();
    };
    menu.querySelectorAll('[data-b-mode]').forEach((b) => {
      b.onclick = () => { draft.mode = b.dataset.bMode; menu.querySelectorAll('[data-b-mode]').forEach((x) => x.classList.toggle('lc-on', x === b)); live(); };
    });
    menu.querySelectorAll('[data-lc-back]').forEach((b) => { b.onclick = () => { if (previewing && pickedId) apply(pickedId); previewing = false; render(); }; });
    menu.querySelector('[data-b-save]').onclick = () => {
      const list = customThemes();
      const name = (draft.name || '').trim() || `Тема ${list.length + 1}`;
      const id = draft.id || `c${Date.now().toString(36)}`;
      const saved = { id, name, mode: draft.mode, h: draft.h, s: draft.s, ah: draft.ah, as: draft.as, glow: draft.glow,
        bs: draft.bs || 'solid', gl: draft.gl || 'soft', rs: draft.rs == null ? 1 : draft.rs, ca: draft.ca == null ? null : draft.ca, fs: draft.fs == null ? 1 : draft.fs, bh: draft.bh == null ? null : draft.bh };
      const i = list.findIndex((x) => x.id === id);
      if (i >= 0) list[i] = saved; else list.push(saved);
      saveCustom(list);
      previewing = false;
      apply(saved);
      render();
    };
    live();
    place();
  }

  function openMenu() {
    if (menu) { closeMenu(); return; }
    menu = document.createElement('div');
    menu.id = 'lcThemeMenu';
    menu.className = 'lc-menu';
    document.body.appendChild(menu);
    render();
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('resize', place);
  }

  // ---------- запуск ----------
  function init() {
    // тема уже применена скриптом в <head>; здесь — состояние кнопки и значок
    const t = findTheme(pickedId || (window.matchMedia && !window.matchMedia('(prefers-color-scheme: dark)').matches && !store.get('theme') ? 'light' : 'dark'));
    const moon = document.getElementById('themeIconMoon'), sun = document.getElementById('themeIconSun');
    if (moon && sun) { moon.classList.toggle('hidden', mode() === 'light'); sun.classList.toggle('hidden', mode() !== 'light'); }
    if (!pickedId) pickedId = t.id;
    if (pickedId === 'auto' && window.matchMedia) {
      window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => { if (pickedId === 'auto') apply('auto'); });
    }
    const btn = document.getElementById('themeToggle');
    if (btn) { btn.onclick = openMenu; btn.title = 'Тема и оформление'; btn.setAttribute('aria-haspopup', 'true'); }
  }

  // Совместимость со старым кодом страниц
  window.currentTheme = mode;
  window.applyTheme = (x) => apply(x === 'light' ? 'light' : x === 'dark' ? 'dark' : x);
  window.LCTheme = { mode, apply, current: () => pickedId, onChange: (fn) => listeners.push(fn), openMenu };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
