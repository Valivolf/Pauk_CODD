// «Все АПК» → карта: выделение комплексов областью — рамкой или «лассо» (произвольная линия). Выделяются только комплексы,
// которые сейчас есть на карте, то есть уже прошли текущие фильтры (поиск, категории, статусы, сертификат); отметки те же, что
// в списке (apkSelected) — над картой те же действия: «Добавить в бригаду…», «Карта из выбранных», «Снять выбор».
// Нужны глобальные apkYmap, apkMapPoints, apkSelected, apkView, CURRENT_USER и функции renderApkSelectionBar/_syncMapPlacemarks (apk.js).
//
// Выделение — слой поверх карты: пока инструмент включён, карту не двигают (колесо мыши масштабирует как обычно); выключить —
// повторное нажатие на кнопку или Esc. Каждая метка переводится в пиксели экрана проекцией карты и проверяется на попадание в рамку
// или многоугольник.

let apkSelTool = null;          // null | 'rect' | 'lasso'
let apkSelRemove = false;       // false — добавлять в выбор, true — убирать из выбора
let _apkSelDrag = null;         // { x0, y0, points: [[x,y]...], el }

function apkSelToolsHtml() {
  // Инлайн-стили: кнопки лежат поверх светлой карты, а нужных утилит Tailwind (полупрозрачные тёмные фоны) в собранном css нет.
  const base = 'border-radius:10px; padding:6px 10px; font-size:12px; font-weight:600; cursor:pointer; box-shadow:0 2px 6px rgba(0,0,0,.35); border:1px solid rgba(148,163,184,.55); transition:background .15s, transform .15s;';
  const off = 'background:rgba(15,23,42,.93); color:#e2e8f0;';
  const style = (on, onBg) => `${base} ${on ? `background:${onBg}; color:#fff;` : off}`;
  return `
    <button type="button" data-apksel="rect" style="${style(apkSelTool === 'rect', '#6366f1')}" title="Выделить комплексы рамкой: тяните по карте">▭ Рамкой</button>
    <button type="button" data-apksel="lasso" style="${style(apkSelTool === 'lasso', '#6366f1')}" title="Выделить комплексы «лассо»: обведите их линией">✎ Лассо</button>
    ${apkSelTool ? `<button type="button" data-apksel="mode" style="${style(apkSelRemove, '#e11d48')}" title="Что делает выделение: добавляет в выбор или убирает из него (Alt при выделении — наоборот)">${apkSelRemove ? '− Убирать из выбора' : '＋ Добавлять в выбор'}</button>` : ''}
    ${apkSelected.size ? `<button type="button" data-apksel="clear" style="${style(false, '')}" title="Снять весь выбор">✕ Снять выбор (${apkSelected.size})</button>` : ''}`;
}

function apkSelRenderTools() {
  const box = document.getElementById('apkMapTools');
  if (!box) return;
  box.innerHTML = apkSelToolsHtml();
  const hint = document.getElementById('apkSelHint');
  if (hint) {
    hint.classList.toggle('hidden', !apkSelTool);
    hint.textContent = apkSelTool === 'rect' ? 'Тяните по карте, чтобы обвести комплексы рамкой. Esc — выйти из выделения.'
      : apkSelTool === 'lasso' ? 'Обведите нужные комплексы линией, не отпуская кнопку. Esc — выйти из выделения.' : '';
  }
  box.querySelectorAll('[data-apksel]').forEach((b) => {
    b.onclick = () => {
      const act = b.dataset.apksel;
      if (act === 'mode') apkSelRemove = !apkSelRemove;
      else if (act === 'clear') { apkSelected.clear(); _syncMapPlacemarks(); renderApkSelectionBar(); }
      else apkSelSetTool(apkSelTool === act ? null : act);
      apkSelRenderTools();
    };
  });
}

function apkSelSetTool(tool) {
  apkSelTool = tool;
  const layer = document.getElementById('apkSelLayer');
  if (layer) {
    layer.style.display = tool ? 'block' : 'none';
    if (!tool) layer.innerHTML = '';
  }
}

// Пиксель метки внутри контейнера карты (с учётом масштаба и сдвига).
function apkSelPixel(p) {
  const projection = apkYmap.options.get('projection');
  const zoom = apkYmap.getZoom();
  const center = apkYmap.getGlobalPixelCenter();
  const size = apkYmap.container.getSize();
  const g = projection.toGlobalPixels([parseFloat(p.lat), parseFloat(p.lon)], zoom);
  return [g[0] - center[0] + size[0] / 2, g[1] - center[1] + size[1] / 2];
}

function apkSelInPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// Что попало в область: (x, y) -> true. Работает по всем меткам карты, включая те, что скрыты группировкой.
function apkSelApply(test, remove) {
  if (!apkYmap) return 0;
  let n = 0;
  for (const p of apkMapPoints) {
    const [x, y] = apkSelPixel(p);
    if (!test(x, y)) continue;
    if (remove) { if (apkSelected.delete(p.id)) n += 1; } else if (!apkSelected.has(p.id)) { apkSelected.set(p.id, p); n += 1; }
  }
  _syncMapPlacemarks();
  renderApkSelectionBar();
  apkSelRenderTools();
  return n;
}

function apkSelInit() {
  const layer = document.getElementById('apkSelLayer');
  if (!layer || layer._wired) return;
  layer._wired = true;
  const pos = (e) => { const r = layer.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; };

  layer.addEventListener('pointerdown', (e) => {
    if (!apkSelTool || e.button > 0) return;
    e.preventDefault();
    try { layer.setPointerCapture(e.pointerId); } catch { /* синтетическое событие или указатель уже снят */ }
    const [x, y] = pos(e);
    layer.innerHTML = '';
    if (apkSelTool === 'rect') {
      const el = document.createElement('div');
      el.style.cssText = 'position:absolute; border:2px solid #6366f1; background:rgba(99,102,241,.18); border-radius:4px; pointer-events:none';
      layer.appendChild(el);
      _apkSelDrag = { x0: x, y0: y, el, remove: apkSelRemove !== e.altKey };
    } else {
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('style', 'position:absolute; inset:0; width:100%; height:100%; pointer-events:none; overflow:visible');
      const poly = document.createElementNS('http://www.w3.org/2000/svg', 'polygon');
      poly.setAttribute('fill', 'rgba(99,102,241,.18)');
      poly.setAttribute('stroke', '#6366f1');
      poly.setAttribute('stroke-width', '2');
      poly.setAttribute('stroke-linejoin', 'round');
      svg.appendChild(poly);
      layer.appendChild(svg);
      _apkSelDrag = { points: [[x, y]], el: poly, remove: apkSelRemove !== e.altKey };
    }
  });

  layer.addEventListener('pointermove', (e) => {
    if (!_apkSelDrag) return;
    const [x, y] = pos(e);
    const d = _apkSelDrag;
    if (apkSelTool === 'rect') {
      d.el.style.left = `${Math.min(d.x0, x)}px`;
      d.el.style.top = `${Math.min(d.y0, y)}px`;
      d.el.style.width = `${Math.abs(x - d.x0)}px`;
      d.el.style.height = `${Math.abs(y - d.y0)}px`;
    } else {
      const last = d.points[d.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) >= 4) {      // не копим десятки тысяч точек, пока ведут линию
        d.points.push([x, y]);
        d.el.setAttribute('points', d.points.map((q) => q.join(',')).join(' '));
      }
    }
  });

  const finish = (e) => {
    if (!_apkSelDrag) return;
    const d = _apkSelDrag;
    _apkSelDrag = null;
    try { layer.releasePointerCapture(e.pointerId); } catch { /* уже отпущен */ }
    layer.innerHTML = '';
    if (e.type === 'pointercancel') return;
    const [x, y] = pos(e);
    if (apkSelTool === 'rect') {
      const x1 = Math.min(d.x0, x), x2 = Math.max(d.x0, x), y1 = Math.min(d.y0, y), y2 = Math.max(d.y0, y);
      if (x2 - x1 < 4 && y2 - y1 < 4) return;                // простой клик без движения — не выделение
      apkSelApply((px, py) => px >= x1 && px <= x2 && py >= y1 && py <= y2, d.remove);
    } else if (d.points.length >= 3) {
      apkSelApply((px, py) => apkSelInPolygon(px, py, d.points), d.remove);
    }
  };
  layer.addEventListener('pointerup', finish);
  layer.addEventListener('pointercancel', finish);

  // Колесо мыши по слою масштабирует карту, как и без выделения.
  layer.addEventListener('wheel', (e) => {
    if (!apkYmap) return;
    e.preventDefault();
    apkYmap.setZoom(apkYmap.getZoom() + (e.deltaY < 0 ? 1 : -1), { checkZoomRange: true, duration: 200 });
  }, { passive: false });
}

function apkSelDestroy() {
  apkSelTool = null;
  _apkSelDrag = null;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && apkSelTool) {
    apkSelSetTool(null);
    apkSelRenderTools();
  }
});
