// /reports/builder — онлайн-конструктор отчётов (Excel и Word).
//
// Шаблон — JSON (формат описан в app/models/report_design.py): секции →
// абзацы / таблицы / отступы. Секция может повторяться «для каждой бригады»,
// строка таблицы — «для каждого задания» бригады. Переменные {{…}}
// перетаскиваются из списка слева в ячейку или абзац. Предпросмотр и файлы
// строит сервер (app/services/report_designer.py), здесь только редактор.
// $, esc, modal, editing, fieldCls/labelCls/btn*, ROLE_DISPLAY_LABEL — из ui.js.
let CURRENT_USER = null;

const RB = {
  id: null,
  name: '',
  format: 'xlsx',
  design: null,
  dirty: false,
  saving: false,
  sel: null,           // {s, b, r1, c1, r2, c2} — ячейки таблицы; {s, b, text: true} — абзац
  anchor: null,        // ячейка, с которой начато выделение (для Shift+клик)
  lastField: null,     // поле, где последний раз стоял курсор (куда вставляется переменная по щелчку)
  draggingVar: null,   // {{переменная}}, которую сейчас тащат из списка слева
  vars: [],
  filter: '',
  period: null,
};

const FORMAT_LABEL = { xlsx: 'Excel (.xlsx)', docx: 'Word (.docx)' };
const TEXT_COLORS = ['#0f172a', '#dc2626', '#16a34a', '#2563eb', '#d97706', '#7c3aed', '#64748b', '#ffffff'];
const FILL_COLORS = ['#ffffff', '#f1f5f9', '#e0e7ff', '#dcfce7', '#fee2e2', '#fef3c7', '#dbeafe', '#fce7f3'];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 24];

const uid = () => Math.random().toString(36).slice(2, 8);
const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const localNow = () => { const d = new Date(); return `${isoDate(d)}T${pad2(d.getHours())}:${pad2(d.getMinutes())}`; };
const colLetter = (i) => { let n = i + 1, s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };

function close() { editing = false; $('#modal').innerHTML = ''; }

// ---------------------------------------------------------------- стили и модель
function cleanStyle(style) {
  const out = {};
  for (const [k, v] of Object.entries(style || {})) {
    if (k === 'bd' || k === 'wrap') { if (v === false) out[k] = false; continue; }   // по умолчанию включены
    if (v === true || (typeof v === 'string' && v) || (typeof v === 'number' && v)) out[k] = v;
  }
  return out;
}

function textCss(st) {
  const s = st || {};
  const css = [];
  if (s.b) css.push('font-weight:700');
  if (s.i) css.push('font-style:italic');
  if (s.u) css.push('text-decoration:underline');
  if (s.al) css.push(`text-align:${s.al}`);
  if (s.fg) css.push(`color:${s.fg}`);
  if (s.sz) css.push(`font-size:${s.sz}pt`);
  return css.join(';');
}
function tdCss(st) {
  const s = st || {};
  const css = [];
  if (s.bg) css.push(`background-color:${s.bg}`);
  const va = { top: 'top', middle: 'middle', bottom: 'bottom' }[s.va];
  if (va) css.push(`vertical-align:${va}`);
  return css.join(';');
}

const newCell = (text = '', style) => (style ? { text, cs: 1, rs: 1, style: { ...style } } : { text, cs: 1, rs: 1 });

function newTable(ncols, fmt) {
  const head = Array.from({ length: ncols }, (_, i) => newCell(`Колонка ${i + 1}`, { b: true, bg: '#f1f5f9' }));
  const row = () => ({ cells: Array.from({ length: ncols }, () => newCell('')) });
  const tbl = { type: 'table', border: true, rows: [{ cells: head }, row(), row()] };
  if (fmt === 'docx') tbl.cols = Array(ncols).fill(10);
  return tbl;
}
const newText = (text = '') => ({ type: 'text', text });
function newSection(fmt, title = 'Новая секция') {
  return { id: uid(), title, repeat: 'none', gap: fmt === 'docx' ? 1 : 2, page_break: false, skip_empty: true, blocks: [newText('')] };
}

// Матрица таблицы: ячейка в каждой позиции сетки — либо «якорь» (ячейка начинается
// здесь), либо ссылка на якорь, чей span её накрывает. Ссылки — на объекты ячеек,
// поэтому вставка/удаление строк и колонок не ломает связи.
function matrixFrom(tbl) {
  const rows = tbl.rows;
  const cover = new Map();
  const anchors = [];
  let ncols = 0;
  rows.forEach((row, r) => {
    let c = 0;
    row.cells.forEach((cell) => {
      while (cover.has(`${r},${c}`)) c += 1;
      anchors.push({ r, c, cell });
      for (let dr = 0; dr < cell.rs; dr += 1) {
        for (let dc = 0; dc < cell.cs; dc += 1) {
          if ((dr || dc) && r + dr < rows.length) cover.set(`${r + dr},${c + dc}`, cell);
        }
      }
      c += cell.cs;
    });
    while (cover.has(`${r},${c}`)) c += 1;
    ncols = Math.max(ncols, c);
  });
  cover.forEach((_, key) => { ncols = Math.max(ncols, Number(key.split(',')[1]) + 1); });
  const M = rows.map(() => Array.from({ length: ncols }, () => null));
  anchors.forEach(({ r, c, cell }) => { M[r][c] = { anchor: true, cell }; });
  cover.forEach((cell, key) => {
    const [r, c] = key.split(',').map(Number);
    if (M[r] && !M[r][c]) M[r][c] = { anchor: false, ref: cell };
  });
  M.forEach((row) => row.forEach((it, c) => { if (!it) row[c] = { anchor: true, cell: newCell('') }; }));
  return { M, ncols };
}
function posMap(M) {
  const pos = new Map();
  M.forEach((row, r) => row.forEach((it, c) => { if (it.anchor) pos.set(it.cell, { r, c }); }));
  return pos;
}
function rowsFromMatrix(M, repeats) {
  return M.map((row, r) => {
    const out = { cells: row.filter((it) => it.anchor).map((it) => it.cell) };
    if (repeats[r]) out.repeat = 'task';
    return out;
  });
}
const repeatsOf = (tbl) => tbl.rows.map((r) => r.repeat === 'task');
const tableCols = (tbl) => matrixFrom(tbl).ncols;

function addRowAt(tbl, at) {
  const { M, ncols } = matrixFrom(tbl);
  const pos = posMap(M);
  const repeats = repeatsOf(tbl);
  const bumped = new Set();
  const row = [];
  for (let c = 0; c < ncols; c += 1) {
    const here = at > 0 && at < M.length ? M[at][c] : null;
    const spanning = here && !here.anchor && pos.get(here.ref).r < at ? here.ref : null;
    if (spanning) {
      row.push({ anchor: false, ref: spanning });
      if (!bumped.has(spanning)) { spanning.rs += 1; bumped.add(spanning); }
    } else {
      row.push({ anchor: true, cell: newCell('') });
    }
  }
  M.splice(at, 0, row);
  repeats.splice(at, 0, false);
  tbl.rows = rowsFromMatrix(M, repeats);
}

function deleteRowAt(tbl, r) {
  if (tbl.rows.length <= 1) return false;
  const { M, ncols } = matrixFrom(tbl);
  const pos = posMap(M);
  const repeats = repeatsOf(tbl);
  const done = new Set();
  for (let c = 0; c < ncols; c += 1) {
    const it = M[r][c];
    if (it.anchor) {
      if (it.cell.rs > 1) { it.cell.rs -= 1; M[r + 1][c] = { anchor: true, cell: it.cell }; }
    } else if (!done.has(it.ref) && pos.get(it.ref).r < r) {
      it.ref.rs -= 1;
      done.add(it.ref);
    }
  }
  M.splice(r, 1);
  repeats.splice(r, 1);
  tbl.rows = rowsFromMatrix(M, repeats);
  return true;
}

function addColAt(tbl, at, fmt) {
  const { M } = matrixFrom(tbl);
  const pos = posMap(M);
  const repeats = repeatsOf(tbl);
  const bumped = new Set();
  M.forEach((row, r) => {
    const here = at < row.length ? row[at] : null;
    const spanning = here && !here.anchor && pos.get(here.ref).c < at ? here.ref : null;
    if (spanning) {
      row.splice(at, 0, { anchor: false, ref: spanning });
      if (!bumped.has(spanning)) { spanning.cs += 1; bumped.add(spanning); }
    } else {
      row.splice(at, 0, { anchor: true, cell: newCell('') });
    }
  });
  tbl.rows = rowsFromMatrix(M, repeats);
  if (fmt === 'docx') { tbl.cols = tbl.cols || []; tbl.cols.splice(at, 0, 10); }
}

function deleteColAt(tbl, c, fmt) {
  const { M, ncols } = matrixFrom(tbl);
  if (ncols <= 1) return false;
  const pos = posMap(M);
  const repeats = repeatsOf(tbl);
  const done = new Set();
  M.forEach((row) => {
    const it = row[c];
    if (it.anchor) {
      if (it.cell.cs > 1) { it.cell.cs -= 1; row[c + 1] = { anchor: true, cell: it.cell }; }
    } else if (!done.has(it.ref) && pos.get(it.ref).c < c) {
      it.ref.cs -= 1;
      done.add(it.ref);
    }
  });
  M.forEach((row) => row.splice(c, 1));
  tbl.rows = rowsFromMatrix(M, repeats);
  if (fmt === 'docx' && tbl.cols) tbl.cols.splice(c, 1);
  return true;
}

// Прямоугольник выделения, расширенный так, чтобы не разрезать объединённые ячейки.
function expandRect(tbl, rect) {
  const { M } = matrixFrom(tbl);
  const pos = posMap(M);
  let { r1, c1, r2, c2 } = rect;
  r1 = Math.max(0, r1); c1 = Math.max(0, c1);
  r2 = Math.min(M.length - 1, r2); c2 = Math.min((M[0] || []).length - 1, c2);
  let changed = true;
  while (changed) {
    changed = false;
    for (let r = r1; r <= r2; r += 1) {
      for (let c = c1; c <= c2; c += 1) {
        const it = M[r][c];
        const cell = it.anchor ? it.cell : it.ref;
        const p = pos.get(cell);
        const n1 = Math.min(r1, p.r), m1 = Math.min(c1, p.c);
        const n2 = Math.max(r2, p.r + cell.rs - 1), m2 = Math.max(c2, p.c + cell.cs - 1);
        if (n1 !== r1 || m1 !== c1 || n2 !== r2 || m2 !== c2) { r1 = n1; c1 = m1; r2 = n2; c2 = m2; changed = true; }
      }
    }
  }
  return { r1, c1, r2, c2 };
}

function mergeRect(tbl, rect) {
  const { r1, c1, r2, c2 } = expandRect(tbl, rect);
  if (r1 === r2 && c1 === c2) return 'Выделите несколько ячеек подряд (Shift + щелчок по второй ячейке).';
  const repeats = repeatsOf(tbl);
  if (r1 !== r2 && repeats.slice(r1, r2 + 1).some(Boolean)) return 'Строки «для каждого задания» нельзя объединять по вертикали — их число заранее неизвестно.';
  const { M } = matrixFrom(tbl);
  const anchorCell = M[r1][c1].cell;
  const texts = [];
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) {
      const it = M[r][c];
      if (it.anchor && it.cell.text) texts.push(it.cell.text);
    }
  }
  anchorCell.text = texts.join(' ');
  anchorCell.cs = c2 - c1 + 1;
  anchorCell.rs = r2 - r1 + 1;
  for (let r = r1; r <= r2; r += 1) {
    for (let c = c1; c <= c2; c += 1) if (r !== r1 || c !== c1) M[r][c] = { anchor: false, ref: anchorCell };
  }
  tbl.rows = rowsFromMatrix(M, repeats);
  return '';
}

function unmergeAt(tbl, rect) {
  const { M } = matrixFrom(tbl);
  const pos = posMap(M);
  const repeats = repeatsOf(tbl);
  const seen = new Set();
  for (let r = rect.r1; r <= rect.r2; r += 1) {
    for (let c = rect.c1; c <= rect.c2; c += 1) {
      const it = M[r]?.[c];
      if (!it) continue;
      const cell = it.anchor ? it.cell : it.ref;
      if (seen.has(cell) || (cell.cs === 1 && cell.rs === 1)) continue;
      seen.add(cell);
      const p = pos.get(cell);
      for (let rr = p.r; rr < p.r + cell.rs; rr += 1) {
        for (let cc = p.c; cc < p.c + cell.cs; cc += 1) {
          if (rr !== p.r || cc !== p.c) M[rr][cc] = { anchor: true, cell: newCell('', cell.style) };
        }
      }
      cell.cs = 1; cell.rs = 1;
    }
  }
  tbl.rows = rowsFromMatrix(M, repeats);
}

// ---------------------------------------------------------------- состояние / сохранение
const block = (s, b) => RB.design?.sections[s]?.blocks[b];

function markDirty() {
  RB.dirty = true;
  updateSaveState();
}
function updateSaveState(message) {
  const el = $('#rbSaveState');
  if (!el) return;
  el.textContent = message || (RB.saving ? 'Сохраняю…' : RB.dirty ? 'Есть несохранённые изменения' : 'Сохранено');
  el.className = `text-xs ml-auto ${RB.dirty && !message ? 'text-amber-400' : 'text-slate-500'}`;
}

async function saveNow() {
  if (!RB.id || RB.saving) return false;
  RB.saving = true;
  updateSaveState();
  try {
    const saved = await Api.put(`/api/report-designs/${RB.id}`, { name: RB.name, design: RB.design });
    const changed = JSON.stringify(saved.design) !== JSON.stringify(RB.design);
    RB.design = saved.design;
    RB.name = saved.name;
    RB.dirty = false;
    if (changed) { renderCanvas(); refreshSelection(); }
    return true;
  } catch (err) {
    alert('Не удалось сохранить: ' + err.message);
    return false;
  } finally {
    RB.saving = false;
    updateSaveState();
  }
}

window.addEventListener('beforeunload', (e) => {
  if (RB.dirty) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's' && RB.design) { e.preventDefault(); saveNow(); }
});

// ---------------------------------------------------------------- старт: создание отчёта
function renderStart() {
  $('#content').innerHTML = `<div class="max-w-3xl mx-auto space-y-6 py-2">
    <div>
      <h2 class="font-display text-xl font-bold">Новый отчёт</h2>
      <p class="text-sm text-slate-400 mt-1">Выберите тип файла — дальше отчёт собирается в редакторе перетаскиванием: таблицы, абзацы и переменные (бригада, комплекс, задание, итог…). Блок можно повторять для каждой бригады.</p>
    </div>
    <label class="${labelCls}">Название отчёта
      <input id="rbNewName" class="${fieldCls}" maxlength="100" value="Отчёт по бригадам" placeholder="Например: Выезды бригад за неделю">
    </label>
    <label class="${labelCls}">Кому будет доступен
      <select id="rbNewVisibility" class="${fieldCls}"><option value="private">Только мне</option><option value="public">Всем сотрудникам</option></select>
      <span class="block text-[11px] text-slate-500 mt-1">Доступ для выбранных учётных записей можно настроить после создания.</span>
    </label>
    <div>
      <div class="text-xs font-medium text-slate-400 mb-2">Тип файла</div>
      <div class="grid sm:grid-cols-2 gap-3" id="rbFmtChoices">
        ${[['xlsx', 'Excel (.xlsx)', 'Лист с таблицами: у каждой бригады своя таблица, между ними — заданное число пустых строк. Ширина колонок, объединение ячеек, заливка, границы.'],
           ['docx', 'Word (.docx)', 'Документ с абзацами и таблицами, как план-наряд: блок на каждую бригаду, при желании — каждая бригада с новой страницы.']]
          .map(([v, title, text], i) => `<label class="rb-card cursor-pointer block" data-choice="${v}">
            <span class="flex items-center gap-2"><input type="radio" name="fmt" value="${v}" ${i === 0 ? 'checked' : ''} class="accent-indigo-500"><b class="text-sm">${title}</b></span>
            <span class="block text-xs text-slate-400 mt-1.5">${text}</span>
          </label>`).join('')}
      </div>
    </div>
    <div>
      <div class="text-xs font-medium text-slate-400 mb-2">С чего начать</div>
      <div class="grid sm:grid-cols-2 gap-3">
        ${[['crews', 'Таблица на каждую бригаду', 'Готовая заготовка: заголовок, затем по таблице на бригаду (состав, комплексы, задания, итог) и общий итог. Дальше правите как нужно.'],
           ['blank', 'Пустой отчёт', 'Один абзац — всё остальное добавляете сами.']]
          .map(([v, title, text], i) => `<label class="rb-card cursor-pointer block">
            <span class="flex items-center gap-2"><input type="radio" name="kind" value="${v}" ${i === 0 ? 'checked' : ''} class="accent-indigo-500"><b class="text-sm">${title}</b></span>
            <span class="block text-xs text-slate-400 mt-1.5">${text}</span>
          </label>`).join('')}
      </div>
    </div>
    <div id="rbStartError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
    <div class="flex items-center gap-2">
      <button id="rbCreateBtn" class="${btnPrimary}">Создать и открыть редактор</button>
      <a href="/reports" class="${btnGhost}">Отмена</a>
    </div>
  </div>`;
  $('#rbCreateBtn').onclick = async () => {
    const name = $('#rbNewName').value.trim();
    const error = $('#rbStartError');
    if (!name) { error.textContent = 'Укажите название отчёта'; error.classList.remove('hidden'); return; }
    $('#rbCreateBtn').disabled = true;
    try {
      const created = await Api.post('/api/report-designs', {
        name,
        format: document.querySelector('input[name="fmt"]:checked').value,
        kind: document.querySelector('input[name="kind"]:checked').value,
        visibility: $('#rbNewVisibility').value,
      });
      RB.dirty = false;
      window.location.href = `/reports/builder?id=${created.id}`;
    } catch (err) {
      error.textContent = err.message;
      error.classList.remove('hidden');
      $('#rbCreateBtn').disabled = false;
    }
  };
}

// ---------------------------------------------------------------- редактор: каркас
async function openDesign(id) {
  let found;
  try { found = await Api.get(`/api/report-designs/${id}`); }
  catch (err) { $('#content').innerHTML = `<p class="text-sm text-rose-400">Не удалось открыть отчёт: ${esc(err.message)}</p>`; return; }
  if (!found.can_edit) { window.location.href = '/reports'; return; }
  RB.id = found.id;
  RB.name = found.name;
  RB.format = found.format;
  RB.design = found.design;
  RB.dirty = false;
  const t = new Date();
  RB.period = { from: isoDate(t), to: isoDate(t) };
  renderEditor();
}

function renderEditor() {
  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="rbName" class="${fieldCls} !w-auto flex-1 min-w-[220px] max-w-md" maxlength="100" value="${esc(RB.name)}" title="Название отчёта">
      <span class="rounded-full bg-indigo-500/15 text-indigo-300 text-xs font-medium px-2.5 py-1">${FORMAT_LABEL[RB.format]}</span>
      <label class="text-xs text-slate-400 flex items-center gap-1.5">Страница
        <select id="rbOrient" class="rounded-lg px-2 py-1 text-xs">
          <option value="portrait" ${RB.design.page.orientation === 'portrait' ? 'selected' : ''}>книжная</option>
          <option value="landscape" ${RB.design.page.orientation === 'landscape' ? 'selected' : ''}>альбомная</option>
        </select>
      </label>
      <label class="text-xs text-slate-400 flex items-center gap-1.5">Шрифт
        <select id="rbFont" class="rounded-lg px-2 py-1 text-xs">
          ${[9, 10, 11, 12, 14].map((n) => `<option value="${n}" ${RB.design.page.font_size === n ? 'selected' : ''}>${n} pt</option>`).join('')}
        </select>
      </label>
      <span id="rbSaveState" class="text-xs text-slate-500 ml-auto">Сохранено</span>
      <button id="rbSaveBtn" class="${btnGhost} !py-1.5">💾 Сохранить</button>
      <button id="rbPreviewBtn" class="${btnGhost} !py-1.5">👁 Предпросмотр</button>
      <button id="rbDownloadBtn" class="${btnPrimary} !py-1.5">⬇ Скачать за период…</button>
    </div>
    <details id="rbHelp" class="rb-card mb-3" open>
      <summary class="cursor-pointer text-xs font-semibold text-slate-300">Как собрать отчёт</summary>
      <ol class="text-xs text-slate-400 mt-2 space-y-1 list-decimal pl-5">
        <li><b>Перетащите переменную</b> из списка слева в ячейку или абзац (или щёлкните по ней — она вставится туда, где мигает курсор).</li>
        <li><b>Секция «⟳ Для каждой бригады»</b> повторяется для каждой бригады каждого дня периода: внутри можно писать <span class="text-emerald-400">{{crew.…}}</span> и строить таблицы. Между повторами — заданное число пустых строк (в Word можно с новой страницы).</li>
        <li><b>Кнопка ⟳ у строки таблицы</b> — «повторять для каждого задания» бригады: в такой строке работают <span class="text-amber-400">{{task.…}}</span>.</li>
        <li>Выделите ячейки (<b>Shift + щелчок</b>, либо номер строки / буква колонки) — справа форматирование, объединение, строки и колонки.</li>
        <li>«Предпросмотр» показывает отчёт с настоящими данными за выбранные дни, «Скачать» отдаёт готовый файл.</li>
      </ol>
    </details>
    <div class="rb-layout">
      <aside class="rb-side"><div class="rb-card" id="rbPalette"></div></aside>
      <section class="min-w-0"><div class="rb-paper" id="rbCanvas"></div></section>
      <aside class="rb-side"><div class="rb-card" id="rbInspector"></div></aside>
    </div>`;

  $('#rbName').oninput = (e) => { RB.name = e.target.value; markDirty(); };
  $('#rbOrient').onchange = (e) => { RB.design.page.orientation = e.target.value; markDirty(); };
  $('#rbFont').onchange = (e) => { RB.design.page.font_size = +e.target.value; markDirty(); };
  $('#rbSaveBtn').onclick = saveNow;
  $('#rbPreviewBtn').onclick = openPreview;
  $('#rbDownloadBtn').onclick = downloadForm;
  renderPalette();
  renderCanvas();
  wireCanvas();
  refreshSelection();
}

// ---------------------------------------------------------------- палитра переменных
function renderPalette() {
  const q = RB.filter.trim().toLowerCase();
  const groups = [];
  RB.vars.forEach((v) => {
    if (q && !`${v.key} ${v.label}`.toLowerCase().includes(q)) return;
    let g = groups.find((x) => x.name === v.group);
    if (!g) { g = { name: v.group, scope: v.scope, items: [] }; groups.push(g); }
    g.items.push(v);
  });
  const notes = {
    crew: 'Работают внутри секции «⟳ Для каждой бригады».',
    task: 'Работают в строке таблицы с включённым ⟳ («для каждого задания»).',
  };
  $('#rbPalette').innerHTML = `<h3>Переменные</h3>
    <input id="rbVarSearch" type="search" placeholder="Найти переменную…" value="${esc(RB.filter)}" class="${fieldCls} !py-1.5 !text-xs mb-2">
    <div class="space-y-2">
      ${groups.map((g) => `<details ${q || g.scope !== 'global' || g.name === 'Период' ? 'open' : ''}>
        <summary class="cursor-pointer text-[11px] font-semibold text-slate-400 mb-1">${esc(g.name)} <span class="text-slate-600">(${g.items.length})</span></summary>
        ${notes[g.scope] ? `<p class="text-[10px] text-slate-500 mb-1.5">${notes[g.scope]}</p>` : ''}
        <div class="flex flex-wrap gap-1.5 mb-2">
          ${g.items.map((v) => `<span class="rb-chip rb-chip-${v.scope}" draggable="true" data-var="${esc(v.key)}" title="{{${esc(v.key)}}}">${esc(v.label.length > 44 ? v.label.slice(0, 42) + '…' : v.label)}</span>`).join('')}
        </div>
      </details>`).join('') || '<p class="text-xs text-slate-500">Ничего не найдено</p>'}
    </div>`;
  const search = $('#rbVarSearch');
  search.oninput = (e) => { RB.filter = e.target.value; const pos = e.target.selectionStart; renderPalette(); const s = $('#rbVarSearch'); s.focus(); s.setSelectionRange(pos, pos); };
  $('#rbPalette').querySelectorAll('.rb-chip').forEach((chip) => {
    chip.addEventListener('dragstart', (e) => {
      RB.draggingVar = `{{${chip.dataset.var}}}`;
      e.dataTransfer.setData('text/plain', RB.draggingVar);
      e.dataTransfer.effectAllowed = 'copy';
    });
    chip.addEventListener('dragend', () => { RB.draggingVar = null; });
    chip.addEventListener('click', () => insertVariable(chip.dataset.var));
  });
}

function fieldSelector(f) {
  if (!f) return null;
  const base = `#rbCanvas textarea[data-s="${f.s}"][data-b="${f.b}"]`;
  return f.kind === 'cell' ? `${base}[data-kind="cell"][data-r="${f.r}"][data-k="${f.k}"]` : `${base}[data-kind="text"]`;
}

function insertVariable(key) {
  const sel = fieldSelector(RB.lastField);
  const field = sel ? document.querySelector(sel) : null;
  if (!field) { updateSaveState('Сначала щёлкните по ячейке или абзацу, куда вставить переменную'); setTimeout(() => updateSaveState(), 2500); return; }
  field.focus();
  field.setRangeText(`{{${key}}}`, field.selectionStart, field.selectionEnd, 'end');
  field.dispatchEvent(new Event('input', { bubbles: true }));
}

// ---------------------------------------------------------------- холст
const dropHtml = (kind, s, at) => `<div class="rb-drop" data-drop="${kind}" data-s="${s}" data-at="${at ?? ''}"></div>`;

function renderCanvas() {
  const d = RB.design;
  $('#rbCanvas').innerHTML = d.sections.map((sec, s) => dropHtml('section', s, s) + sectionHtml(sec, s)).join('')
    + dropHtml('section', d.sections.length, d.sections.length)
    + `<div class="rb-add"><button data-act="add-section">+ Добавить секцию</button></div>`;
  $('#rbCanvas').querySelectorAll('textarea').forEach(autosize);
}

function sectionHtml(sec, s) {
  const crew = sec.repeat === 'crew';
  const docx = RB.format === 'docx';
  return `<div class="rb-section ${crew ? 'rb-repeat' : ''}" data-s="${s}">
    <div class="rb-section-head">
      <span class="rb-mini rb-handle" draggable="true" data-drag="section" data-s="${s}" title="Перетащить секцию">⠿</span>
      <input type="text" data-sec="title" data-s="${s}" value="${esc(sec.title)}" placeholder="Название секции" size="20">
      <select data-sec="repeat" data-s="${s}">
        <option value="none" ${crew ? '' : 'selected'}>Один раз</option>
        <option value="crew" ${crew ? 'selected' : ''}>⟳ Для каждой бригады</option>
      </select>
      ${crew ? `<label class="flex items-center gap-1"><input type="checkbox" data-sec="skip_empty" data-s="${s}" ${sec.skip_empty !== false ? 'checked' : ''}> без бригад без заданий</label>` : ''}
      ${crew && docx ? `<label class="flex items-center gap-1"><input type="checkbox" data-sec="page_break" data-s="${s}" ${sec.page_break ? 'checked' : ''}> каждая бригада с новой страницы</label>` : ''}
      <label class="flex items-center gap-1">${docx ? 'пустых абзацев после' : 'пустых строк после'}
        <input type="number" min="0" max="20" data-sec="gap" data-s="${s}" value="${sec.gap}" style="width:54px"></label>
      <span class="ml-auto flex gap-1">
        <button class="rb-mini" data-act="sec-up" data-s="${s}" title="Выше">↑</button>
        <button class="rb-mini" data-act="sec-down" data-s="${s}" title="Ниже">↓</button>
        <button class="rb-mini" data-act="sec-del" data-s="${s}" title="Удалить секцию">✕</button>
      </span>
    </div>
    <div class="rb-section-body">
      ${sec.blocks.map((blk, b) => dropHtml('block', s, b) + blockHtml(blk, s, b)).join('')}
      ${dropHtml('block', s, sec.blocks.length)}
      <div class="rb-add"><span class="text-[11px] text-slate-500">Добавить:</span>
        <button data-act="add-text" data-s="${s}">+ Абзац</button>
        <button data-act="add-table" data-s="${s}">+ Таблица</button>
        <button data-act="add-spacer" data-s="${s}">+ Отступ</button>
      </div>
    </div>
  </div>`;
}

function blockHtml(blk, s, b) {
  const tools = `<div class="rb-block-tools">
    <span class="rb-mini rb-handle" draggable="true" data-drag="block" data-s="${s}" data-b="${b}" title="Перетащить блок">⠿</span>
    <button class="rb-mini" data-act="blk-up" data-s="${s}" data-b="${b}" title="Выше">↑</button>
    <button class="rb-mini" data-act="blk-down" data-s="${s}" data-b="${b}" title="Ниже">↓</button>
    <button class="rb-mini" data-act="blk-del" data-s="${s}" data-b="${b}" title="Удалить блок">✕</button>
  </div>`;
  let body = '';
  if (blk.type === 'text') {
    body = `<textarea class="rb-text" rows="1" data-kind="text" data-s="${s}" data-b="${b}" style="${textCss(blk.style)}" placeholder="Текст абзаца — можно вставлять переменные {{…}}">${esc(blk.text)}</textarea>`;
  } else if (blk.type === 'spacer') {
    body = `<div class="rb-spacer">Пустых строк: <input type="number" min="1" max="20" data-blk="rows" data-s="${s}" data-b="${b}" value="${blk.rows}"></div>`;
  } else if (blk.type === 'table') {
    body = tableHtml(blk, s, b);
  }
  return `<div class="rb-block" data-s="${s}" data-b="${b}">${tools}${body}</div>`;
}

function columnWidths(tbl, ncols) {
  if (RB.format === 'xlsx') {
    const cols = RB.design.columns;
    while (cols.length < ncols) cols.push(14);
    return cols.slice(0, ncols);
  }
  tbl.cols = tbl.cols || [];
  while (tbl.cols.length < ncols) tbl.cols.push(10);
  return tbl.cols.slice(0, ncols);
}

function tableHtml(tbl, s, b) {
  const { M, ncols } = matrixFrom(tbl);
  const pos = posMap(M);
  const widths = columnWidths(tbl, ncols);
  const xlsx = RB.format === 'xlsx';
  const total = widths.reduce((a, w) => a + w, 0) || 1;
  const colgroup = `<colgroup><col style="width:84px">${widths.map((w) => `<col style="width:max(56px, ${(w / total * 100).toFixed(2)}%)">`).join('')}</colgroup>`;
  const head = `<tr><th class="rb-colhead"></th>${widths.map((w, c) => `<th class="rb-colhead"><div class="rb-colhead-in">
      <button class="rb-mini" data-act="col-sel" data-s="${s}" data-b="${b}" data-c="${c}" title="Выделить колонку">${xlsx ? colLetter(c) : c + 1}</button>
      <input type="number" min="3" max="${xlsx ? 80 : 200}" step="${xlsx ? 1 : 1}" data-col="${c}" data-s="${s}" data-b="${b}" value="${w}" title="${xlsx ? 'Ширина колонки листа, знаков' : 'Относительная ширина колонки'}">
    </div></th>`).join('')}</tr>`;
  const rows = tbl.rows.map((row, r) => {
    const repeat = row.repeat === 'task';
    let k = 0;
    const cells = [];
    for (let c = 0; c < ncols; c += 1) {
      const it = M[r][c];
      if (!it.anchor) continue;
      const cell = it.cell;
      const st = cell.style || {};
      cells.push(`<td colspan="${cell.cs}" rowspan="${cell.rs}" data-r="${r}" data-c="${pos.get(cell).c}" data-cs="${cell.cs}" data-rs="${cell.rs}" style="${tdCss(st)}">
        <textarea class="rb-cell" rows="1" data-kind="cell" data-s="${s}" data-b="${b}" data-r="${r}" data-k="${k}" style="${textCss(st)}">${esc(cell.text)}</textarea></td>`);
      k += 1;
    }
    return `<tr class="${repeat ? 'rb-repeat-row' : ''}"><th class="rb-gutter"><div class="rb-gutter-in">
      <button class="rb-mini" data-act="row-sel" data-s="${s}" data-b="${b}" data-r="${r}" title="Выделить строку">${r + 1}</button>
      <button class="rb-mini ${repeat ? 'rb-on' : ''}" data-act="row-repeat" data-s="${s}" data-b="${b}" data-r="${r}" title="Повторять эту строку для каждого задания бригады">⟳</button>
    </div></th>${cells.join('')}</tr>`;
  }).join('');
  return `<table class="rb-table ${tbl.border === false ? 'rb-noborder' : ''}" data-s="${s}" data-b="${b}" style="${xlsx ? '' : ''}">${colgroup}<thead>${head}</thead><tbody>${rows}</tbody></table>`;
}

function autosize(el) {
  el.style.height = 'auto';
  el.style.height = `${Math.max(26, el.scrollHeight)}px`;
}

// ---------------------------------------------------------------- выделение
const cellRef = (el) => block(+el.dataset.s, +el.dataset.b)?.rows[+el.dataset.r]?.cells[+el.dataset.k];

function setSelFromTd(td) {
  const tbl = td.closest('table');
  const r = +td.dataset.r, c = +td.dataset.c;
  RB.sel = { s: +tbl.dataset.s, b: +tbl.dataset.b, r1: r, c1: c, r2: r + (+td.dataset.rs) - 1, c2: c + (+td.dataset.cs) - 1 };
  RB.anchor = { r, c, rs: +td.dataset.rs, cs: +td.dataset.cs };
}

function refreshSelection() {
  document.querySelectorAll('#rbCanvas td.rb-sel').forEach((td) => td.classList.remove('rb-sel'));
  const sel = RB.sel;
  if (sel && !sel.text) {
    const tbl = document.querySelector(`#rbCanvas table[data-s="${sel.s}"][data-b="${sel.b}"]`);
    if (!tbl) RB.sel = null;
    else {
      tbl.querySelectorAll('td').forEach((td) => {
        const r = +td.dataset.r, c = +td.dataset.c, r2 = r + (+td.dataset.rs) - 1, c2 = c + (+td.dataset.cs) - 1;
        if (!(r > sel.r2 || r2 < sel.r1 || c > sel.c2 || c2 < sel.c1)) td.classList.add('rb-sel');
      });
    }
  }
  renderInspector();
}

function selectedTargets() {
  const sel = RB.sel;
  if (!sel) return [];
  const blk = block(sel.s, sel.b);
  if (!blk) return [];
  if (sel.text) return [blk];
  const { M } = matrixFrom(blk);
  const seen = new Set();
  const out = [];
  for (let r = sel.r1; r <= sel.r2; r += 1) {
    for (let c = sel.c1; c <= sel.c2; c += 1) {
      const it = M[r]?.[c];
      if (!it) continue;
      const cell = it.anchor ? it.cell : it.ref;
      if (!seen.has(cell)) { seen.add(cell); out.push(cell); }
    }
  }
  return out;
}

function applyStyle(patch) {
  const targets = selectedTargets();
  if (!targets.length) return;
  targets.forEach((t) => { t.style = cleanStyle({ ...(t.style || {}), ...patch }); if (!Object.keys(t.style).length) delete t.style; });
  markDirty();
  const keep = RB.sel;
  renderCanvas();
  RB.sel = keep;
  refreshSelection();
}

function toggleStyle(key, defaultOn = false) {
  const targets = selectedTargets();
  if (!targets.length) return;
  const isOn = (t) => (defaultOn ? (t.style || {})[key] !== false : !!(t.style || {})[key]);
  applyStyle({ [key]: defaultOn ? !targets.every(isOn) : !targets.every(isOn) });
}

function selectionLabel() {
  const sel = RB.sel;
  if (!sel) return 'Ничего не выделено — щёлкните по ячейке или абзацу.';
  if (sel.text) return 'Абзац';
  const a = `${RB.format === 'xlsx' ? colLetter(sel.c1) : sel.c1 + 1}${sel.r1 + 1}`;
  if (sel.r1 === sel.r2 && sel.c1 === sel.c2) return `Ячейка ${a}`;
  return `Диапазон ${a}:${RB.format === 'xlsx' ? colLetter(sel.c2) : sel.c2 + 1}${sel.r2 + 1}`;
}

function renderInspector() {
  const targets = selectedTargets();
  const sel = RB.sel;
  const isTable = sel && !sel.text && targets.length;
  const has = (key, defaultOn) => targets.length && targets.every((t) => (defaultOn ? (t.style || {})[key] !== false : !!(t.style || {})[key]));
  const first = targets[0]?.style || {};
  const btn = (act, label, on, title, extra = '') => `<button class="rb-tool-btn ${on ? 'rb-on' : ''}" data-ins="${act}" title="${esc(title)}" ${extra} ${targets.length ? '' : 'disabled'}>${label}</button>`;
  const swatches = (kind, colors) => colors.map((c) => `<button class="rb-swatch" data-ins="${kind}" data-color="${c}" style="background:${c}" title="${c}" ${targets.length ? '' : 'disabled'}></button>`).join('');
  const blk = sel ? block(sel.s, sel.b) : null;
  const repeatRows = isTable ? Array.from({ length: sel.r2 - sel.r1 + 1 }, (_, i) => blk.rows[sel.r1 + i]).filter(Boolean) : [];
  const allRepeat = repeatRows.length && repeatRows.every((r) => r.repeat === 'task');
  const stNote = isTable ? '' : '';

  $('#rbInspector').innerHTML = `<h3>Оформление</h3>
    <p class="text-[11px] text-slate-400 mb-2">${esc(selectionLabel())}</p>
    <div class="flex flex-wrap gap-1 mb-2">
      ${btn('b', '<b>Ж</b>', has('b'), 'Жирный')}${btn('i', '<i>К</i>', has('i'), 'Курсив')}${btn('u', '<u>Ч</u>', has('u'), 'Подчёркнутый')}
    </div>
    <div class="flex flex-wrap gap-1 mb-2">
      ${btn('al:left', '⯇', first.al === 'left' || !first.al, 'По левому краю')}${btn('al:center', '≡', first.al === 'center', 'По центру')}${btn('al:right', '⯈', first.al === 'right', 'По правому краю')}
      ${isTable ? `${btn('va:top', '⤒', !first.va || first.va === 'top', 'Сверху')}${btn('va:middle', '↕', first.va === 'middle', 'По центру по высоте')}${btn('va:bottom', '⤓', first.va === 'bottom', 'Снизу')}` : ''}
    </div>
    <label class="flex items-center gap-2 text-[11px] text-slate-400 mb-2">Размер, pt
      <select data-ins="sz" class="rounded-lg px-2 py-1 text-xs" ${targets.length ? '' : 'disabled'}>
        <option value="">по умолчанию</option>
        ${FONT_SIZES.map((n) => `<option value="${n}" ${first.sz === n ? 'selected' : ''}>${n}</option>`).join('')}
      </select>
    </label>
    <div class="text-[11px] text-slate-400 mb-1">Цвет текста</div>
    <div class="flex flex-wrap gap-1 mb-2">${swatches('fg', TEXT_COLORS)}<button class="rb-tool-btn" data-ins="fg" data-color="" title="Сбросить цвет" ${targets.length ? '' : 'disabled'}>✕</button></div>
    <div class="text-[11px] text-slate-400 mb-1">Заливка</div>
    <div class="flex flex-wrap gap-1 mb-3">${swatches('bg', FILL_COLORS)}<button class="rb-tool-btn" data-ins="bg" data-color="" title="Без заливки" ${targets.length ? '' : 'disabled'}>✕</button></div>
    ${isTable ? `
      <div class="flex flex-wrap gap-1 mb-3">
        ${btn('merge', '⧉ Объединить', false, 'Объединить выделенные ячейки')}${btn('unmerge', '▭ Разъединить', false, 'Разъединить объединённую ячейку')}
      </div>
      <div class="flex flex-wrap gap-1 mb-3">
        ${btn('wrap', '↵ Перенос', has('wrap', true), 'Переносить длинный текст на новую строку')}${btn('bd', '▦ Рамка', has('bd', true), 'Рамка вокруг ячейки')}
      </div>
      <h3 class="!mt-3">Строки и колонки</h3>
      <div class="grid grid-cols-2 gap-1 mb-2">
        <button class="rb-tool-btn !h-auto py-1.5 text-[11px]" data-ins="row-above">↑ строка выше</button>
        <button class="rb-tool-btn !h-auto py-1.5 text-[11px]" data-ins="row-below">↓ строка ниже</button>
        <button class="rb-tool-btn !h-auto py-1.5 text-[11px]" data-ins="col-left">← колонка слева</button>
        <button class="rb-tool-btn !h-auto py-1.5 text-[11px]" data-ins="col-right">→ колонка справа</button>
        <button class="rb-tool-btn !h-auto py-1.5 text-[11px]" data-ins="row-del">✕ удалить строки</button>
        <button class="rb-tool-btn !h-auto py-1.5 text-[11px]" data-ins="col-del">✕ удалить колонки</button>
      </div>
      <button class="rb-tool-btn !h-auto py-1.5 text-[11px] w-full mb-2 ${allRepeat ? 'rb-on' : ''}" data-ins="repeat" title="Строка повторится для каждого задания бригады">⟳ Строка «для каждого задания»${allRepeat ? ' — включено' : ''}</button>
      <label class="flex items-center gap-2 text-[11px] text-slate-400"><input type="checkbox" data-ins="table-border" ${blk.border === false ? '' : 'checked'}> рамки у всей таблицы</label>
    ` : ''}
    ${stNote}`;
}

function inspectorAction(el) {
  const act = el.dataset.ins;
  const sel = RB.sel;
  const fmt = RB.format;
  if (act === 'b' || act === 'i' || act === 'u') return toggleStyle(act);
  if (act === 'wrap') return toggleStyle('wrap', true);
  if (act === 'bd') return toggleStyle('bd', true);
  if (act.startsWith('al:')) return applyStyle({ al: act.slice(3) });
  if (act.startsWith('va:')) return applyStyle({ va: act.slice(3) });
  if (act === 'fg' || act === 'bg') return applyStyle({ [act]: el.dataset.color || '' });
  if (!sel || sel.text) return undefined;
  const tbl = block(sel.s, sel.b);
  const afterStructure = (nextSel) => {
    markDirty();
    RB.sel = nextSel;
    RB.anchor = { r: nextSel.r1, c: nextSel.c1, rs: 1, cs: 1 };
    renderCanvas();
    refreshSelection();
  };
  if (act === 'merge') {
    const msg = mergeRect(tbl, sel);
    if (msg) { alert(msg); return undefined; }
    const rect = expandRect(tbl, sel);
    return afterStructure({ s: sel.s, b: sel.b, ...rect });
  }
  if (act === 'unmerge') { unmergeAt(tbl, sel); return afterStructure({ ...sel }); }
  if (act === 'row-above') { addRowAt(tbl, sel.r1); return afterStructure({ ...sel, r1: sel.r1, r2: sel.r1, c2: sel.c1 + 0 }); }
  if (act === 'row-below') { addRowAt(tbl, sel.r2 + 1); return afterStructure({ s: sel.s, b: sel.b, r1: sel.r2 + 1, r2: sel.r2 + 1, c1: sel.c1, c2: sel.c1 }); }
  if (act === 'row-del') {
    for (let r = sel.r2; r >= sel.r1; r -= 1) { if (!deleteRowAt(tbl, r)) { alert('В таблице должна остаться хотя бы одна строка.'); break; } }
    const last = Math.max(0, Math.min(sel.r1, tbl.rows.length - 1));
    return afterStructure({ s: sel.s, b: sel.b, r1: last, r2: last, c1: 0, c2: 0 });
  }
  if (act === 'col-left') { addColAt(tbl, sel.c1, fmt); return afterStructure({ s: sel.s, b: sel.b, r1: sel.r1, r2: sel.r1, c1: sel.c1, c2: sel.c1 }); }
  if (act === 'col-right') { addColAt(tbl, sel.c2 + 1, fmt); return afterStructure({ s: sel.s, b: sel.b, r1: sel.r1, r2: sel.r1, c1: sel.c2 + 1, c2: sel.c2 + 1 }); }
  if (act === 'col-del') {
    for (let c = sel.c2; c >= sel.c1; c -= 1) { if (!deleteColAt(tbl, c, fmt)) { alert('В таблице должна остаться хотя бы одна колонка.'); break; } }
    const ncols = tableCols(tbl);
    const c = Math.max(0, Math.min(sel.c1, ncols - 1));
    return afterStructure({ s: sel.s, b: sel.b, r1: 0, r2: 0, c1: c, c2: c });
  }
  if (act === 'repeat') return toggleRowRepeat(sel.s, sel.b, sel.r1, sel.r2);
  return undefined;
}

function toggleRowRepeat(s, b, r1, r2) {
  const tbl = block(s, b);
  const rows = [];
  for (let r = r1; r <= r2; r += 1) rows.push(r);
  const turningOn = !rows.every((r) => tbl.rows[r].repeat === 'task');
  if (turningOn) {
    const { M, ncols } = matrixFrom(tbl);
    const pos = posMap(M);
    for (const r of rows) {
      for (let c = 0; c < ncols; c += 1) {
        const it = M[r][c];
        const cell = it.anchor ? it.cell : it.ref;
        if (cell.rs > 1 || pos.get(cell).r !== r) {
          alert('Строку с объединёнными по вертикали ячейками нельзя повторять для каждого задания.');
          return;
        }
      }
    }
  }
  rows.forEach((r) => { if (turningOn) tbl.rows[r].repeat = 'task'; else delete tbl.rows[r].repeat; });
  markDirty();
  const keep = RB.sel;
  renderCanvas();
  RB.sel = keep;
  refreshSelection();
}

// ---------------------------------------------------------------- события холста
function moveItem(list, from, to) {
  if (from < 0 || from >= list.length) return;
  const [it] = list.splice(from, 1);
  list.splice(Math.max(0, Math.min(to, list.length)), 0, it);
}

function wireCanvas() {
  const canvas = $('#rbCanvas');
  const dnd = { kind: null, s: -1, b: -1 };

  canvas.addEventListener('input', (e) => {
    const t = e.target;
    if (t.matches('textarea[data-kind="cell"]')) {
      const cell = cellRef(t);
      if (cell) { cell.text = t.value; markDirty(); }
      autosize(t);
    } else if (t.matches('textarea[data-kind="text"]')) {
      const blk = block(+t.dataset.s, +t.dataset.b);
      if (blk) { blk.text = t.value; markDirty(); }
      autosize(t);
    } else if (t.dataset.sec === 'title') {
      RB.design.sections[+t.dataset.s].title = t.value; markDirty();
    } else if (t.dataset.sec === 'gap') {
      RB.design.sections[+t.dataset.s].gap = Math.max(0, Math.min(20, parseInt(t.value || '0', 10) || 0)); markDirty();
    } else if (t.dataset.blk === 'rows') {
      block(+t.dataset.s, +t.dataset.b).rows = Math.max(1, Math.min(20, parseInt(t.value || '1', 10) || 1)); markDirty();
    }
  });

  canvas.addEventListener('change', (e) => {
    const t = e.target;
    if (t.dataset.sec === 'repeat') {
      RB.design.sections[+t.dataset.s].repeat = t.value;
      markDirty(); renderCanvas(); refreshSelection();
    } else if (t.dataset.sec === 'skip_empty' || t.dataset.sec === 'page_break') {
      RB.design.sections[+t.dataset.s][t.dataset.sec] = t.checked; markDirty();
    } else if (t.dataset.col !== undefined) {
      const w = Math.max(3, Math.min(RB.format === 'xlsx' ? 80 : 200, parseFloat(t.value) || 10));
      const blk = block(+t.dataset.s, +t.dataset.b);
      columnWidths(blk, tableCols(blk));
      if (RB.format === 'xlsx') RB.design.columns[+t.dataset.col] = w; else blk.cols[+t.dataset.col] = w;
      markDirty(); renderCanvas(); refreshSelection();
    }
  });

  canvas.addEventListener('focusin', (e) => {
    const t = e.target;
    if (t.matches('textarea[data-kind="cell"]')) {
      setSelFromTd(t.closest('td'));
      RB.lastField = { kind: 'cell', s: +t.dataset.s, b: +t.dataset.b, r: +t.dataset.r, k: +t.dataset.k };
    } else if (t.matches('textarea[data-kind="text"]')) {
      RB.sel = { s: +t.dataset.s, b: +t.dataset.b, text: true };
      RB.anchor = null;
      RB.lastField = { kind: 'text', s: +t.dataset.s, b: +t.dataset.b };
    } else return;
    refreshSelection();
  });

  // Shift + щелчок по второй ячейке — прямоугольное выделение.
  canvas.addEventListener('mousedown', (e) => {
    if (!e.shiftKey) return;
    const td = e.target.closest?.('td[data-r]');
    if (!td || !RB.sel || RB.sel.text || !RB.anchor) return;
    const tbl = td.closest('table');
    if (+tbl.dataset.s !== RB.sel.s || +tbl.dataset.b !== RB.sel.b) return;
    e.preventDefault();
    const r = +td.dataset.r, c = +td.dataset.c;
    const a = RB.anchor;
    const rect = {
      r1: Math.min(a.r, r), c1: Math.min(a.c, c),
      r2: Math.max(a.r + a.rs - 1, r + (+td.dataset.rs) - 1), c2: Math.max(a.c + a.cs - 1, c + (+td.dataset.cs) - 1),
    };
    RB.sel = { s: RB.sel.s, b: RB.sel.b, ...expandRect(block(RB.sel.s, RB.sel.b), rect) };
    refreshSelection();
  });

  canvas.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.dataset.act;
    const s = +btn.dataset.s, b = +btn.dataset.b, d = RB.design;
    const fmt = RB.format;
    if (act === 'add-section') { d.sections.push(newSection(fmt)); }
    else if (act === 'sec-up') moveItem(d.sections, s, s - 1);
    else if (act === 'sec-down') moveItem(d.sections, s, s + 1);
    else if (act === 'sec-del') {
      if (d.sections[s].blocks.length && !confirm(`Удалить секцию «${d.sections[s].title || 'без названия'}» со всем содержимым?`)) return;
      d.sections.splice(s, 1);
    } else if (act === 'add-text') d.sections[s].blocks.push(newText(''));
    else if (act === 'add-spacer') d.sections[s].blocks.push({ type: 'spacer', rows: 1 });
    else if (act === 'add-table') d.sections[s].blocks.push(newTable(fmt === 'xlsx' ? Math.min(d.columns.length, 5) : 4, fmt));
    else if (act === 'blk-up') {
      const list = d.sections[s].blocks;
      if (b > 0) moveItem(list, b, b - 1);
      else if (s > 0) { d.sections[s - 1].blocks.push(list.splice(0, 1)[0]); }
    } else if (act === 'blk-down') {
      const list = d.sections[s].blocks;
      if (b < list.length - 1) moveItem(list, b, b + 1);
      else if (s < d.sections.length - 1) { d.sections[s + 1].blocks.unshift(list.splice(b, 1)[0]); }
    } else if (act === 'blk-del') d.sections[s].blocks.splice(b, 1);
    else if (act === 'row-sel') {
      const tbl = block(s, b);
      // Целая строка / колонка — без расширения до объединённых ячеек: «удалить
      // строку» должна удалять ровно её, а не всю вертикально объединённую область.
      RB.sel = { s, b, r1: +btn.dataset.r, r2: +btn.dataset.r, c1: 0, c2: tableCols(tbl) - 1 };
      RB.anchor = { r: RB.sel.r1, c: 0, rs: 1, cs: 1 };
      refreshSelection();
      return;
    } else if (act === 'col-sel') {
      const tbl = block(s, b);
      RB.sel = { s, b, r1: 0, r2: tbl.rows.length - 1, c1: +btn.dataset.c, c2: +btn.dataset.c };
      RB.anchor = { r: 0, c: RB.sel.c1, rs: 1, cs: 1 };
      refreshSelection();
      return;
    } else if (act === 'row-repeat') { toggleRowRepeat(s, b, +btn.dataset.r, +btn.dataset.r); return; }
    else return;
    markDirty();
    RB.sel = null;
    renderCanvas();
    refreshSelection();
  });

  // Перетаскивание секций и блоков (переменные из списка слева перетаскиваются
  // обычным текстом прямо в поле — это умеет сам браузер).
  canvas.addEventListener('dragstart', (e) => {
    const h = e.target.closest?.('[data-drag]');
    if (!h) return;
    dnd.kind = h.dataset.drag; dnd.s = +h.dataset.s; dnd.b = +(h.dataset.b ?? -1);
    e.dataTransfer.setData('application/x-rb', `${dnd.kind}:${dnd.s}:${dnd.b}`);
    e.dataTransfer.effectAllowed = 'move';
  });
  canvas.addEventListener('dragover', (e) => {
    const zone = e.target.closest?.('.rb-drop');
    if (!zone || !dnd.kind || zone.dataset.drop !== dnd.kind) return;
    e.preventDefault();
    zone.classList.add('rb-over');
  });
  canvas.addEventListener('dragleave', (e) => e.target.closest?.('.rb-drop')?.classList.remove('rb-over'));
  // Переменную из списка браузер вставляет в поле сам (в точку отпускания). Если
  // он этого не сделал — вставляем в конец поля, чтобы перетаскивание не пропадало зря.
  canvas.addEventListener('drop', (e) => {
    const field = e.target.closest?.('textarea.rb-cell, textarea.rb-text');
    const text = RB.draggingVar;
    if (!field || !text) return;
    const before = field.value;
    setTimeout(() => {
      if (field.value !== before) return;
      field.setRangeText(text, field.value.length, field.value.length, 'end');
      field.dispatchEvent(new Event('input', { bubbles: true }));
    }, 0);
  });
  canvas.addEventListener('dragend', () => { dnd.kind = null; canvas.querySelectorAll('.rb-over').forEach((z) => z.classList.remove('rb-over')); });
  canvas.addEventListener('drop', (e) => {
    const zone = e.target.closest?.('.rb-drop');
    if (!zone || !dnd.kind || zone.dataset.drop !== dnd.kind) return;
    e.preventDefault();
    const d = RB.design;
    const at = +zone.dataset.at;
    if (dnd.kind === 'section') {
      moveItem(d.sections, dnd.s, dnd.s < at ? at - 1 : at);
    } else {
      const ts = +zone.dataset.s;
      const [blk] = d.sections[dnd.s].blocks.splice(dnd.b, 1);
      let to = at;
      if (ts === dnd.s && dnd.b < at) to -= 1;
      d.sections[ts].blocks.splice(Math.max(0, to), 0, blk);
    }
    dnd.kind = null;
    markDirty();
    RB.sel = null;
    renderCanvas();
    refreshSelection();
  });

  // Инспектор: делегирование на контейнере (его содержимое перерисовывается).
  $('#rbInspector').addEventListener('mousedown', (e) => { if (e.target.closest('button')) e.preventDefault(); });
  $('#rbInspector').addEventListener('click', (e) => {
    const el = e.target.closest('button[data-ins]');
    if (el && !el.disabled) inspectorAction(el);
  });
  $('#rbInspector').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.ins === 'sz') applyStyle({ sz: el.value ? +el.value : 0 });
    else if (el.dataset.ins === 'table-border' && RB.sel && !RB.sel.text) {
      block(RB.sel.s, RB.sel.b).border = el.checked;
      markDirty();
      const keep = RB.sel; renderCanvas(); RB.sel = keep; refreshSelection();
    }
  });
}

// ---------------------------------------------------------------- предпросмотр
const PRESETS = [
  ['Сегодня', () => { const t = new Date(); return [isoDate(t), isoDate(t)]; }],
  ['Вчера', () => { const t = new Date(Date.now() - 86400000); return [isoDate(t), isoDate(t)]; }],
  ['Неделя', () => { const t = new Date(); const day = (t.getDay() + 6) % 7; const s = new Date(t); s.setDate(t.getDate() - day); const e = new Date(s); e.setDate(s.getDate() + 6); return [isoDate(s), isoDate(e)]; }],
  ['Месяц', () => { const t = new Date(); return [isoDate(new Date(t.getFullYear(), t.getMonth(), 1)), isoDate(new Date(t.getFullYear(), t.getMonth() + 1, 0))]; }],
];

function periodControlsHtml(prefix) {
  return `<div class="flex flex-wrap items-end gap-2">
    <label class="${labelCls}">С<input type="date" id="${prefix}From" value="${RB.period.from}" class="${fieldCls}"></label>
    <label class="${labelCls}">По<input type="date" id="${prefix}To" value="${RB.period.to}" class="${fieldCls}"></label>
    <div class="flex flex-wrap gap-1.5 pb-0.5">${PRESETS.map(([label], i) => `<button type="button" data-preset="${i}" class="${btnGhost} !py-1.5 !px-3 text-xs">${label}</button>`).join('')}</div>
  </div>`;
}
function wirePeriod(prefix, onChange) {
  const read = () => { RB.period = { from: $(`#${prefix}From`).value, to: $(`#${prefix}To`).value }; };
  const root = $(`#${prefix}From`).closest('.flex').parentElement;
  let timer = null;
  // Смена любой из дат (в том числе кнопкой «Сегодня / Неделя…») — один пересчёт.
  const changed = () => { read(); if (onChange) { clearTimeout(timer); timer = setTimeout(onChange, 80); } };
  [`${prefix}From`, `${prefix}To`].forEach((id) => $(`#${id}`).addEventListener('change', changed));
  root.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => {
      const [from, to] = PRESETS[+b.dataset.preset][1]();
      for (const [id, value] of [[`${prefix}From`, from], [`${prefix}To`, to]]) {
        const input = $(`#${id}`);
        input.value = value;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    };
  });
  return read;
}

async function openPreview() {
  const box = $('#rbPreview');
  box.innerHTML = `<div class="rb-preview-wrap"><div class="rb-preview-box glass">
    <div class="flex flex-wrap items-start justify-between gap-3 mb-3">
      <div><h2 class="font-display text-lg font-bold">Предпросмотр</h2><p class="text-xs text-slate-400">Так будет выглядеть отчёт с настоящими данными за выбранные дни (${FORMAT_LABEL[RB.format]}).</p></div>
      <div class="flex gap-2"><button id="rbPvDownload" class="${btnPrimary} !py-1.5">⬇ Скачать</button><button id="rbPvClose" class="${btnGhost} !py-1.5">Закрыть</button></div>
    </div>
    <div class="mb-3">${periodControlsHtml('rbPv')}</div>
    <div id="rbPvWarn"></div>
    <div id="rbPvBody" class="rb-paper"><p class="text-sm" style="color:#64748b">Загрузка…</p></div>
  </div></div>`;
  $('#rbPvClose').onclick = closePreview;
  const run = async () => {
    wireRead();
    $('#rbPvBody').innerHTML = '<p class="text-sm" style="color:#64748b">Загрузка…</p>';
    try {
      const exp = await Api.post('/api/report-designs/preview', {
        design: RB.design, date_from: RB.period.from, date_to: RB.period.to, today: isoDate(new Date()), now: localNow(),
      });
      $('#rbPvBody').innerHTML = previewHtml(exp);
      const notes = [];
      if (exp.empty_crew_sections) notes.push('За выбранные дни нет бригад с заданиями — секции «для каждой бригады» пусты. Выберите другие дни.');
      notes.push(...exp.warnings);
      $('#rbPvWarn').innerHTML = notes.length ? `<div class="mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 space-y-1">${notes.map((n) => `<div>⚠ ${esc(n)}</div>`).join('')}</div>` : '';
    } catch (err) {
      $('#rbPvBody').innerHTML = `<p class="text-sm" style="color:#be123c">Не удалось построить предпросмотр: ${esc(err.message)}</p>`;
    }
  };
  const wireRead = wirePeriod('rbPv', run);
  $('#rbPvDownload').onclick = () => { closePreview(); downloadForm(); };
  await run();
}
function closePreview() { $('#rbPreview').innerHTML = ''; }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && $('#rbPreview')?.innerHTML) closePreview(); });

function previewHtml(exp) {
  const xlsx = exp.format === 'xlsx';
  const out = [];
  exp.items.forEach((item) => {
    if (item.type === 'text') {
      out.push(`<p class="rb-pv-text" style="${textCss(item.style)}${item.style?.bg ? `;background:${item.style.bg}` : ''}">${esc(item.text) || '&nbsp;'}</p>`);
    } else if (item.type === 'gap') {
      out.push(`<div style="height:${item.rows * 1.35}em"></div>`);
    } else if (item.type === 'pagebreak') {
      out.push('<div class="rb-pv-break">— новая страница —</div>');
    } else if (item.type === 'table') {
      const ncols = Math.max(...item.rows.map((r) => r.cells.reduce((a, c) => a + c.cs, 0)), (item.cols || exp.columns || []).length, 1);
      const widths = xlsx ? (exp.columns || []).slice(0, ncols) : (item.cols || []).slice(0, ncols);
      const total = widths.reduce((a, w) => a + w, 0) || 1;
      const colgroup = widths.length ? `<colgroup>${widths.map((w) => `<col style="width:max(40px, ${(w / total * 100).toFixed(2)}%)">`).join('')}</colgroup>` : '';
      out.push(`<table class="rb-pv-table ${item.border === false ? 'rb-noborder' : ''}">${colgroup}<tbody>${item.rows.map((r) => `<tr>${r.cells.map((c) => {
        const st = c.style || {};
        const borderOff = st.bd === false ? 'border-color:transparent;' : '';
        return `<td colspan="${c.cs}" rowspan="${c.rs}" style="${borderOff}${tdCss(st)};${textCss(st)}">${esc(c.text)}</td>`;
      }).join('')}</tr>`).join('')}</tbody></table>`);
    }
  });
  return out.join('') || '<p class="text-sm" style="color:#64748b">Отчёт пуст — добавьте в шаблон абзацы или таблицы.</p>';
}

// ---------------------------------------------------------------- скачивание
function downloadForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Скачать «${esc(RB.name)}»</h2>
    <p class="text-xs text-slate-400 mb-4">Выберите дни — отчёт соберётся из бригад и заданий этого периода (${FORMAT_LABEL[RB.format]}).</p>
    <div class="mb-3">${periodControlsHtml('rbDl')}</div>
    <div id="rbDlStatus" class="hidden mb-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"></div>
    <div class="flex items-center gap-2 pt-2">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button id="rbDlBtn" class="${btnPrimary}">Скачать</button>
    </div>`);
  const read = wirePeriod('rbDl');
  $('#rbDlBtn').onclick = async () => {
    read();
    const { from, to } = RB.period;
    const status = $('#rbDlStatus');
    if (!from || !to) { status.textContent = 'Укажите обе даты'; status.classList.remove('hidden'); return; }
    $('#rbDlBtn').disabled = true;
    $('#rbDlBtn').textContent = 'Формирую…';
    try {
      if (RB.dirty && !(await saveNow())) throw new Error('не удалось сохранить изменения шаблона');
      const res = await fetch(`/api/report-designs/${RB.id}/generate?date_from=${from}&date_to=${to}&today=${isoDate(new Date())}&now=${encodeURIComponent(localNow())}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.detail) || res.statusText);
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const star = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      const plain = /filename="([^"]+)"/.exec(disposition);
      const filename = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : `report.${RB.format}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      const warnings = Number(res.headers.get('X-Report-Warnings')) || 0;
      if (warnings) {
        status.textContent = `Файл скачан. В отчёте есть предупреждения (${warnings}) — например, переменные не на своём месте; посмотрите «Предпросмотр».`;
        status.classList.remove('hidden');
        $('#rbDlBtn').disabled = false;
        $('#rbDlBtn').textContent = 'Скачать ещё раз';
      } else {
        close();
      }
    } catch (err) {
      status.textContent = 'Не удалось сформировать отчёт: ' + err.message;
      status.classList.remove('hidden');
      $('#rbDlBtn').disabled = false;
      $('#rbDlBtn').textContent = 'Скачать';
    }
  };
}

// ---------------------------------------------------------------- шапка страницы
function changePasswordForm({ forced = false } = {}) {
  modal(`<h2 class="font-display text-lg font-bold mb-2">Смена пароля</h2>
    ${forced ? '<p class="text-sm text-amber-300 mb-4">Это пароль по умолчанию. Установите новый, прежде чем продолжить.</p>' : ''}
    <form id="pwForm" class="space-y-4">
      <label class="${labelCls}">Текущий пароль<input name="current_password" type="password" required class="${fieldCls}"></label>
      <label class="${labelCls}">Новый пароль<input name="new_password" type="password" required minlength="8" placeholder="не короче 8 знаков: буквы и цифры" autocomplete="new-password" class="${fieldCls}"></label>
      <div id="pwError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        ${forced ? '' : `<button type="button" class="cancel ${btnGhost}">Отмена</button>`}
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await Api.post('/api/auth/password', { current_password: f.current_password.value, new_password: f.new_password.value });
      CURRENT_USER.must_change_password = false;
      close();
      window.location.reload();
    } catch (err) {
      $('#pwError').textContent = err.message;
      $('#pwError').classList.remove('hidden');
    }
  };
}
$('#userMenuBtn').onclick = () => $('#userMenu').classList.toggle('hidden');
document.addEventListener('click', (e) => {
  if (!e.target.closest('#userMenuBtn') && !e.target.closest('#userMenu')) $('#userMenu').classList.add('hidden');
});
$('#changePwBtn').onclick = () => { $('#userMenu').classList.add('hidden'); changePasswordForm({ forced: false }); };
$('#logoutBtn').onclick = async () => { await Api.post('/api/auth/logout', {}); window.location.href = '/login'; };
$('#backLink').addEventListener('click', (e) => {
  if (RB.dirty && !confirm('Есть несохранённые изменения. Уйти без сохранения?')) e.preventDefault();
  else RB.dirty = false;
});

async function boot() {
  try {
    CURRENT_USER = await Api.get('/api/auth/me');
  } catch {
    return; // Api.get уже перенаправил на /login
  }
  if (!can('reports.builder')) { window.location.href = '/reports'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) { changePasswordForm({ forced: true }); return; }
  try { RB.vars = (await Api.get('/api/report-designs/variables')).variables; }
  catch (err) { $('#content').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить список переменных: ${esc(err.message)}</p>`; return; }
  const id = Number(new URLSearchParams(location.search).get('id'));
  if (id) await openDesign(id);
  else renderStart();
}
boot();
