// Своё фото вместо цветного фона страниц. Подключается на всех страницах перед fx.js; управляется из меню «Оформление» (theme.js).
//
//  • Фото хранятся ТОЛЬКО в этом браузере (IndexedDB): на сервер ничего не уходит, у каждого сотрудника на своём компьютере свой фон.
//  • Загруженный снимок любого размера и формата, который понимает браузер (JPG, PNG, WebP…), сжимается до 1920 px по длинной стороне
//    и хранится как JPEG — так страница не тормозит, а в хранилище помещается до 8 фото.
//  • Поверх фото — затемнение (чтобы читались карточки и текст; в светлой теме вместо него осветление) и по желанию размытие. Слой
//    один, неподвижный (position: fixed), рисуется один раз — на скорость прокрутки и работу страницы не влияет.
//  • Погода (дождь, снег, облака, солнце) рисуется поверх фото, если не выключена в меню.
(function () {
  'use strict';
  const root = document.documentElement;
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* не страшно */ } },
  };
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const DB_NAME = 'lcBg', STORE = 'photos', MAX_PHOTOS = 8, MAX_SIDE = 1920, MAX_SOURCE = 40 * 1024 * 1024;
  let db = null, layer = null, objectUrl = '';

  function open() {
    return new Promise((resolve, reject) => {
      if (db) { resolve(db); return; }
      if (!window.indexedDB) { reject(new Error('Браузер не умеет хранить фото (нет IndexedDB)')); return; }
      let rq;
      try { rq = indexedDB.open(DB_NAME, 1); } catch (e) { reject(new Error('Браузер не даёт сохранить фото (возможно, приватное окно)')); return; }
      rq.onupgradeneeded = () => rq.result.createObjectStore(STORE, { keyPath: 'id' });
      rq.onsuccess = () => { db = rq.result; resolve(db); };
      rq.onerror = () => reject(new Error('Не удалось открыть хранилище фото в браузере'));
    });
  }
  const store$ = (mode) => open().then((d) => d.transaction(STORE, mode).objectStore(STORE));
  const wait = (r) => new Promise((resolve, reject) => { r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });

  async function list() {
    try {
      const all = await wait((await store$('readonly')).getAll());
      return all.sort((a, b) => a.created - b.created).map(({ id, name, thumb }) => ({ id, name, thumb }));
    } catch (e) { return []; }
  }
  async function getBlob(id) {
    const rec = await wait((await store$('readonly')).get(id));
    return rec ? rec.blob : null;
  }

  // Картинка из файла: createImageBitmap учитывает поворот из EXIF (снимки с телефона), запасной путь — обычный <img>.
  async function decode(file) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(file, { imageOrientation: 'from-image' }); } catch (e) { /* пробуем через <img> */ }
    }
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('не удалось прочитать картинку')); };
      img.src = url;
    });
  }
  const toBlob = (canvas, quality) => new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));

  async function shrink(img, maxSide, quality) {
    const w = img.width || img.naturalWidth, h = img.height || img.naturalHeight;
    const k = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * k)); c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext('2d');
    g.fillStyle = '#0b0f1a'; g.fillRect(0, 0, c.width, c.height);       // у PNG с прозрачностью фон не станет чёрным квадратом на светлой теме
    g.drawImage(img, 0, 0, c.width, c.height);
    return { canvas: c, blob: await toBlob(c, quality) };
  }

  // Добавляет выбранные файлы. Возвращает { added, errors: [текст] } — одна плохая картинка не мешает остальным.
  async function add(files) {
    const out = { added: 0, errors: [], ids: [] };
    let existing;
    try { existing = await list(); } catch (e) { out.errors.push(e.message); return out; }
    for (const file of [...files]) {
      if (existing.length + out.added >= MAX_PHOTOS) { out.errors.push(`Можно хранить до ${MAX_PHOTOS} фото — удалите ненужные`); break; }
      if (!/^image\//.test(file.type) && !/\.(jpe?g|png|webp|gif|bmp|avif|heic)$/i.test(file.name || '')) { out.errors.push(`«${file.name}»: это не картинка`); continue; }
      if (file.size > MAX_SOURCE) { out.errors.push(`«${file.name}»: файл больше 40 МБ`); continue; }
      try {
        const img = await decode(file);
        let { canvas, blob } = await shrink(img, MAX_SIDE, 0.86);
        if (blob && blob.size > 2.5 * 1024 * 1024) ({ blob } = await shrink(img, MAX_SIDE, 0.7));
        const thumb = (await shrink(img, 240, 0.72)).canvas.toDataURL('image/jpeg', 0.72);
        if (img.close) img.close();
        if (!blob) throw new Error('не удалось сжать');
        const id = `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
        await wait((await store$('readwrite')).put({ id, name: (file.name || 'фото').slice(0, 60), blob, thumb, created: Date.now() }));
        out.added += 1;
        out.ids.push(id);
      } catch (e) {
        out.errors.push(`«${file.name}»: ${e && e.message ? e.message : 'не удалось загрузить'}`);
      }
    }
    return out;
  }

  async function remove(id) {
    try { await wait((await store$('readwrite')).delete(id)); } catch (e) { /* уже нет */ }
    if (store.get('bgPhoto', '') === id) await select('');
  }

  // ---------- показ ----------
  function clear() {
    if (layer) { layer.remove(); layer = null; }
    if (objectUrl) { URL.revokeObjectURL(objectUrl); objectUrl = ''; }
    root.removeAttribute('data-bgphoto');
  }
  function paint() {
    if (!layer) return;
    const light = root.getAttribute('data-theme') === 'light';
    const dim = clamp(+store.get('bgDim', light ? 35 : 45), 0, 92) / 100;
    const blur = clamp(+store.get('bgBlur', 0), 0, 30);
    const tint = light ? '255,255,255' : '5,8,20';
    const sig = `${tint}|${dim}|${blur}|${objectUrl}`;
    if (layer._sig === sig) return;          // подбор цветов темы шлёт события часто — слой без изменений не трогаем
    layer._sig = sig;
    layer.style.backgroundImage = `linear-gradient(rgba(${tint},${dim}),rgba(${tint},${dim})), url("${objectUrl}")`;
    layer.style.filter = blur ? `blur(${blur}px)` : '';
  }
  async function apply() {
    const id = store.get('bgPhoto', '');
    if (!id) { clear(); return; }
    let blob = null;
    try { blob = await getBlob(id); } catch (e) { blob = null; }
    if (!blob) { store.set('bgPhoto', ''); clear(); return; }          // фото удалено/очищено браузером — возвращаем обычный фон
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'lcBgPhoto';
      layer.setAttribute('aria-hidden', 'true');
      document.body.insertBefore(layer, document.body.firstChild);
    }
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(blob);
    root.setAttribute('data-bgphoto', '1');
    paint();
  }
  async function select(id) {
    store.set('bgPhoto', id || '');
    await apply();
  }

  window.LCBg = {
    list, add, remove, select, apply,
    current: () => store.get('bgPhoto', ''),
    max: MAX_PHOTOS,
    getDim: () => clamp(+store.get('bgDim', root.getAttribute('data-theme') === 'light' ? 35 : 45), 0, 92),
    getBlur: () => clamp(+store.get('bgBlur', 0), 0, 30),
    setDim(v) { store.set('bgDim', String(clamp(Math.round(v), 0, 92))); paint(); },
    setBlur(v) { store.set('bgBlur', String(clamp(Math.round(v), 0, 30))); paint(); },
    supported: !!window.indexedDB,
  };

  document.addEventListener('lc-theme', paint);
  const boot = () => { if (store.get('bgPhoto', '')) apply(); else root.removeAttribute('data-bgphoto'); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
