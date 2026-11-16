// /warehouse — dedicated page for admin/«склад»-role accounts. Lists the points
// currently «На складе» and keeps, for every point, the COMPONENTS it consists
// of: камера, ящик, плата… — any number of them, each with an «на складе» tick
// and a description (see app/repositories/point_components_repository.py).
// The status is a single «На складе»: anything ticked puts the point on the
// shelf; when not every component is there the page labels it «Частично на
// складе» (a label computed from the ticks, not a status). Any point from the
// directory can be opened here (+ «Добавить комплекс») to put one of its
// components on the shelf. Besides components a point has «статус паутины»,
// receipt date and free info. A point leaves this list (its warehouse data is
// cleared and components un-stocked) as soon as its status changes to anything
// else, from wherever it's edited.
// $, esc, modal, editing, fieldCls/labelCls/btn*, colorBadge,
// loadPointStatuses, pointStatusBadge, openVisitJournal come from ui.js.
let CURRENT_USER = null;
let whQuery = '';
let whStatusFilter = 'all';   // all | full | partial
let whComponentFilter = '';   // '' — any; otherwise the name of a component that is IN STOCK on the point
let whCategories = [];
// Set of category-id strings, plus '__none__' for "Без категории" — several
// can be active at once (OR'd server-side, see warehouse_items_repository).
let whCategoryFilter = new Set();

const WEB_STATUSES = ['Архив', 'Синий', 'Красный'];
const WH_STATUS = 'На складе';

// Не всё на складе: у комплекса есть компонент, которого там нет.
const whIsPartial = (p) => p.components.length > 0 && p.components_in_stock < p.components_total;

// Вкладки страницы: прежние «Комплексы на складе» (компоненты на полке) и учёт оборудования по
// серийным номерам (equipment.js / equipment_points.js / equipment_admin.js).
const WH_TABS = [
  { key: 'equipment', label: 'Оборудование', render: () => renderEquipmentTab() },
  { key: 'issue', label: 'Выдача и приём', perm: 'warehouse.edit', render: () => renderIssueTab() },
  { key: 'complexes', label: 'Оборудование на комплексах', render: () => renderComplexesTab() },
  { key: 'shelf', label: 'Комплексы на складе', render: () => renderWarehousePage() },
  { key: 'panels', label: 'Солнечные панели', render: () => renderPanelsTab() },
  { key: 'import', label: 'Импорт из Excel', perm: 'warehouse.edit', render: () => renderImportTab() },
  { key: 'history', label: 'История', render: () => renderHistoryTab() },
  { key: 'reports', label: 'Отчёты и справочники', render: () => renderReportsTab() },
];
let whTab = 'equipment';
try { const saved = localStorage.getItem('whTab'); if (WH_TABS.some((t) => t.key === saved)) whTab = saved; } catch { /* без localStorage — первая вкладка */ }
const whTabsVisible = () => WH_TABS.filter((t) => !t.perm || can(t.perm));      // вкладки, на которые у роли есть право

function paintWhTabs() {
  $('#whTabs').innerHTML = whTabsVisible().map((t) => `<button data-whtab="${t.key}" class="rounded-xl px-3.5 py-2 text-sm font-medium transition-colors whitespace-nowrap ${t.key === whTab ? 'bg-amber-500 text-white shadow-lg shadow-amber-500/25' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300 border border-slate-700'}">${esc(t.label)}</button>`).join('');
  $('#whTabs').querySelectorAll('[data-whtab]').forEach((b) => { b.onclick = () => showWhTab(b.dataset.whtab); });
}

async function showWhTab(key) {
  if (!whTabsVisible().some((t) => t.key === key)) key = whTabsVisible()[0].key;      // сохранённая вкладка могла стать недоступной
  whTab = key;
  try { localStorage.setItem('whTab', key); } catch { /* не критично */ }
  paintWhTabs();
  $('#content').innerHTML = '<p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p>';
  await WH_TABS.find((t) => t.key === key).render();
}

function close() {
  editing = false;
  $('#modal').innerHTML = '';
  keepScroll('#content', () => WH_TABS.find((t) => t.key === whTab).render());      // список не прыгает в начало
}

let whLastItems = [];

async function fetchWarehouseItems() {
  const params = new URLSearchParams();
  if (whQuery) params.set('search', whQuery);
  if (whCategoryFilter.has('__none__')) params.set('uncategorized', 'true');
  whCategoryFilter.forEach((v) => { if (v !== '__none__') params.append('category_id', v); });
  const qs = params.toString();
  const [items, categories] = await Promise.all([
    Api.get('/api/warehouse/points' + (qs ? '?' + qs : '')),
    whCategories.length ? Promise.resolve(whCategories) : Api.get('/api/point-categories'),
  ]);
  whCategories = categories;
  return items;
}

function whFilterRows(items) {
  const key = whComponentFilter.toLowerCase();
  return items.filter((p) => {
    if (whStatusFilter === 'full' && whIsPartial(p)) return false;
    if (whStatusFilter === 'partial' && !whIsPartial(p)) return false;
    if (key && !p.components.some((c) => c.in_stock && c.name.toLowerCase() === key)) return false;
    return true;
  });
}

// Names of components that are on the shelf somewhere in the current list,
// most frequent first — the second row of filter buttons.
function whComponentChips(items) {
  const counts = new Map();
  items.forEach((p) => p.components.forEach((c) => {
    if (!c.in_stock) return;
    const k = c.name.toLowerCase();
    const cur = counts.get(k) || { name: c.name, n: 0 };
    cur.n += 1;
    counts.set(k, cur);
  }));
  return [...counts.values()].sort((a, b) => b.n - a.n || a.name.localeCompare(b.name, 'ru'));
}

function wireWarehouseList() {
  $('#whList').querySelectorAll('[data-wpoint]').forEach((btn) => { btn.onclick = () => whPointForm(btn.dataset.wpoint); });
  $('#whList').querySelectorAll('[data-wjournal]').forEach((btn) => { btn.onclick = () => openVisitJournal(btn.dataset.wjournal); });
}

// Patches just the row list (see ui.js's patchKeyedList) — used by the 5s
// poll so an unrelated point's card isn't rebuilt every tick. The chrome
// (search box, chips, filter buttons) only rebuilds via renderWarehousePage,
// which explicit user actions (search submit, chip/filter click) call directly.
async function refreshWarehouseList() {
  let items;
  try { items = await fetchWarehouseItems(); } catch { return; }
  whLastItems = items;
  patchKeyedList($('#whList'), whFilterRows(items), (p) => p.id, whRowHtml, '<p class="text-sm text-slate-500 text-center py-6">На складе ничего нет</p>');
  wireWarehouseList();
}

async function renderWarehousePage() {
  let items;
  try {
    items = await fetchWarehouseItems();
  } catch (e) {
    $('#content').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  whLastItems = items;

  const statusChips = [['all', `Все (${items.length})`], ['full', `На складе целиком (${items.filter((p) => !whIsPartial(p)).length})`], ['partial', `Частично (${items.filter(whIsPartial).length})`]];
  const compChips = whComponentChips(items);
  const chipCls = (active) => `rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'bg-amber-500 text-white' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300'}`;

  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <form id="whSearchForm" class="flex-1 min-w-[200px] flex gap-1.5">
        <input name="q" value="${esc(whQuery)}" placeholder="Поиск по номеру, адресу, инвентарному, компоненту" class="${fieldCls} flex-1">
        <button class="${btnGhost} !px-4 whitespace-nowrap">Найти</button>
      </form>
      <button data-perm="warehouse.edit" id="whAddBtn" class="${btnPrimary} !px-4 whitespace-nowrap">+ Добавить комплекс</button>
      <button data-perm="warehouse.edit" id="whTemplateBtn" class="${btnGhost} !px-4 whitespace-nowrap">Шаблон импорта</button>
      <button data-perm="warehouse.edit" id="whImportBtn" class="${btnGhost} !px-4 whitespace-nowrap">Импорт Excel</button>
    </div>
    <div class="mb-4">${filterPanelHtml(
      filterRowHtml('Категория', filterChipsHtml('wh-category', [{ value: '__none__', label: 'Без категории' }, ...whCategories.map((c) => ({ value: String(c.id), label: c.name }))], whCategoryFilter)) +
      filterRowHtml('Состояние', statusChips.map(([key, label]) => `<button data-wstatus="${key}" class="${chipCls(whStatusFilter === key)}">${esc(label)}</button>`).join('')) +
      (compChips.length ? filterRowHtml('Компонент', `<button data-wcomp="" class="${chipCls(!whComponentFilter)}">любой на складе</button>
        ${compChips.map((c) => `<button data-wcomp="${esc(c.name)}" class="${chipCls(whComponentFilter.toLowerCase() === c.name.toLowerCase())}">${esc(c.name)} (${c.n})</button>`).join('')}`) : '')
    )}</div>
    <div id="whList" class="space-y-2 max-h-[560px] overflow-auto pr-1"></div>`;

  patchKeyedList($('#whList'), whFilterRows(items), (p) => p.id, whRowHtml, '<p class="text-sm text-slate-500 text-center py-6">На складе ничего нет</p>');

  $('#content').querySelectorAll('[data-wstatus]').forEach((btn) => {
    btn.onclick = () => { whStatusFilter = btn.dataset.wstatus; renderWarehousePage(); };
  });
  $('#content').querySelectorAll('[data-wcomp]').forEach((btn) => {
    btn.onclick = () => { whComponentFilter = btn.dataset.wcomp; renderWarehousePage(); };
  });
  $('#whSearchForm').onsubmit = (e) => { e.preventDefault(); whQuery = e.target.elements.q.value.trim(); renderWarehousePage(); };
  wireFilterChips($('#content'), 'wh-category', whCategoryFilter, renderWarehousePage);
  $('#whAddBtn').onclick = () => whAddPointForm();
  $('#whTemplateBtn').onclick = () => { window.location.href = '/api/warehouse/template'; };
  $('#whImportBtn').onclick = () => $('#whImportFile').click();
  wireWarehouseList();
}

function whComponentChipHtml(c) {
  const cls = c.in_stock ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-700/50 text-slate-400';
  return `<span class="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] ${cls}" title="${c.in_stock ? 'на складе' : 'не на складе'}">${c.in_stock ? '●' : '○'} ${esc(c.name)}${c.description ? ` — ${esc(c.description)}` : ''}</span>`;
}

function whRowHtml(p) {
  const webLine = p.web_status || p.received_at
    ? `<br><span class="text-slate-500">${p.web_status ? 'Паутина: ' + esc(p.web_status) : ''}${p.web_status && p.received_at ? ' · ' : ''}${p.received_at ? 'поступила ' + esc(fmtDate(p.received_at)) : ''}</span>`
    : '';
  const comps = p.components.length
    ? `<div class="flex flex-wrap items-center gap-1 mt-1">${p.components.map(whComponentChipHtml).join('')}<span class="text-[11px] text-slate-500 ml-1">на складе ${p.components_in_stock} из ${p.components_total}</span></div>`
    : '<div class="text-[11px] text-slate-500 mt-1">Компоненты не заданы — комплекс целиком</div>';
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 flex items-start justify-between gap-2">
    <span class="text-xs leading-relaxed min-w-0">
      <b>${esc(p.id)}</b>${p.inventory_number ? ` · инв. ${esc(p.inventory_number)}` : ''}${p.category_name ? ' · ' + colorBadge(p.category_name, p.category_color) : ''} ${pointStatusBadge(p.status, whIsPartial(p))}<br>
      <span class="text-slate-400">${esc(p.address || 'адрес не указан')}</span>
      ${webLine}
      ${comps}
    </span>
    <span class="flex items-center gap-1.5 shrink-0">
      <button data-wjournal="${esc(p.id)}" class="${btnGhost} !py-1 !px-2 text-xs" title="История выездов">🕘</button>
      <button data-point-photos="${esc(p.id)}" class="${btnGhost} !py-1 !px-2 text-xs" title="Фото по этому комплексу по дням">📷</button>
      <button data-perm="warehouse.edit" data-wpoint="${esc(p.id)}" class="${btnGhost} !py-1 !px-2 text-xs">✎</button>
    </span>
  </div>`;
}

// «+ Добавить комплекс» — любой комплекс из справочника можно открыть здесь и
// положить на склад один из его компонентов (например, только камеру): он
// станет «На складе» с подписью «Частично на складе».
function whAddPointForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Добавить комплекс на склад</h2>
    <p class="text-sm text-slate-400 mb-3">Найдите комплекс из справочника — откроется его карточка, где отмечаются компоненты на складе.</p>
    <input id="whAddSearch" placeholder="Номер, адрес или инвентарный номер" autocomplete="off" class="${fieldCls}">
    <div id="whAddResults" class="space-y-1.5 mt-3 max-h-[320px] overflow-auto"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);
  let timer;
  const input = $('#whAddSearch');
  input.focus();
  const run = async () => {
    const q = input.value.trim();
    if (!q) { $('#whAddResults').innerHTML = ''; return; }
    let items = [];
    $('#whAddResults').innerHTML = loadingHtml('Ищу…', 'text-sm text-slate-500 text-center py-4');
    try { ({ items } = await Api.getPage(`/api/points?search=${encodeURIComponent(q)}&limit=10`)); } catch { $('#whAddResults').innerHTML = ''; return; }
    if (input.value.trim() !== q) return;
    $('#whAddResults').innerHTML = items.map((p) => `<button data-perm="warehouse.edit" type="button" data-wadd="${esc(p.id)}" class="w-full text-left rounded-xl border border-slate-700/50 bg-slate-800/30 hover:bg-slate-700/40 px-3 py-2 text-sm transition-colors">
      <b>${esc(p.id)}</b> ${pointStatusBadge(p.status, p.stock_partial)}<br><span class="text-xs text-slate-400">${esc(p.address || 'адрес не указан')}</span>
    </button>`).join('') || '<p class="text-sm text-slate-500 text-center py-4">Ничего не найдено</p>';
    $('#whAddResults').querySelectorAll('[data-wadd]').forEach((btn) => { btn.onclick = () => whPointForm(btn.dataset.wadd); });
  };
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(run, 250); };
  input.onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#whAddResults [data-wadd]')?.click(); }
  };
}

// Какой статус получит комплекс по отметкам «на складе» (то же правило, что на
// сервере — point_components_repository.recompute_status).
function whDerivedStatus(comps, currentStatus) {
  if (!comps.length) return currentStatus;
  const stocked = comps.filter((c) => c.in_stock).length;
  if (stocked === comps.length) return WH_STATUS;
  if (stocked > 0) return STOCK_PARTIAL_LABEL;
  return currentStatus === WH_STATUS ? 'не на складе (статус сбросится, проверка доступности выставит настоящий)' : currentStatus;
}

async function whPointForm(pointId) {
  let item, names = [];
  try {
    [item, names] = await Promise.all([
      Api.get('/api/warehouse/points/' + encodeURIComponent(pointId)),
      Api.get('/api/warehouse/component-names').catch(() => []),
    ]);
  } catch (e) { alert('Не удалось загрузить точку: ' + e.message); return; }

  const compRowHtml = (c) => `<div class="flex items-center gap-2" data-comp-row>
      <input data-cname list="whCompNames" value="${esc(c.name)}" maxlength="60" placeholder="Компонент (камера, ящик…)" class="${fieldCls} !py-1.5 w-[34%] min-w-0">
      <label class="flex items-center gap-1 text-xs text-slate-300 whitespace-nowrap shrink-0"><input type="checkbox" data-cstock class="rounded accent-amber-500" ${c.in_stock ? 'checked' : ''}> на складе</label>
      <input data-cdesc value="${esc(c.description || '')}" maxlength="500" placeholder="Описание" class="${fieldCls} !py-1.5 flex-1 min-w-0">
      <button data-perm="warehouse.edit" type="button" data-cdel class="${btnDanger} !py-1 !px-2 text-xs shrink-0" title="Убрать компонент">✕</button>
    </div>`;

  modal(`<h2 class="font-display text-lg font-bold mb-1">Склад · ${esc(item.id)}</h2>
    <p class="text-xs text-slate-400 mb-4">${esc(item.address || 'адрес не указан')}${item.category_name ? ' · ' + colorBadge(item.category_name, item.category_color) : ''}</p>
    <form id="whItemForm" class="space-y-4">
      <label class="${labelCls}">Статус<select name="status" class="${fieldCls}">
        ${Object.keys(_pointStatusCache).map((s) => `<option value="${esc(s)}" ${item.status === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
        ${_pointStatusCache[item.status] || !item.status ? '' : `<option value="${esc(item.status)}" selected>${esc(item.status)}</option>`}
      </select></label>
      <div>
        <div class="flex items-center justify-between mb-1.5">
          <span class="text-xs font-medium text-slate-400">Компоненты комплекса</span>
          <span id="whCompSummary" class="text-[11px] text-slate-500"></span>
        </div>
        <div id="whComps" class="space-y-2"></div>
        <datalist id="whCompNames">${names.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <div class="flex flex-wrap items-center gap-1.5 mt-2">
          <button data-perm="warehouse.edit" type="button" id="whCompAdd" class="${btnGhost} !py-1 !px-3 text-xs">+ Добавить компонент</button>
          <span id="whCompQuick" class="flex flex-wrap items-center gap-1.5"></span>
        </div>
        <p class="text-[11px] text-slate-500 mt-2">Галочка «на складе» — компонент физически на складе. Статус один — «На складе»; если на складе не все компоненты, комплекс показывается как «Частично на складе». Компонентов можно добавить сколько угодно.</p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Статус паутины<select name="web_status" class="${fieldCls}">
          <option value="">— не указан —</option>
          ${WEB_STATUSES.map((s) => `<option value="${s}" ${item.web_status === s ? 'selected' : ''}>${s}</option>`).join('')}
        </select></label>
        <label class="${labelCls}">Дата поступления<input type="date" name="received_at" value="${esc(item.received_at || '')}" class="${fieldCls}"></label>
      </div>
      <label class="${labelCls}">Информация<textarea name="info" rows="3" placeholder="Например: экспертиза от 15-01-2026, причина демонтажа и т.д." class="${fieldCls}">${esc(item.info || '')}</textarea></label>
      <div id="whItemFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);

  const form = $('#whItemForm');
  const readComps = () => [...form.querySelectorAll('[data-comp-row]')].map((row) => ({
    name: row.querySelector('[data-cname]').value.trim(),
    in_stock: row.querySelector('[data-cstock]').checked,
    description: row.querySelector('[data-cdesc]').value.trim(),
  })).filter((c) => c.name);
  const updateSummary = () => {
    const comps = readComps();
    const stocked = comps.filter((c) => c.in_stock).length;
    const derived = whDerivedStatus(comps, item.status);
    $('#whCompSummary').textContent = comps.length
      ? `на складе ${stocked} из ${comps.length} → ${derived}`
      : 'компонентов нет — комплекс целиком';
    // Выпадающий статус следует за галочками (как это сделает сервер при
    // сохранении): хоть один компонент на складе — «На складе».
    if (stocked > 0 && form.elements.status.value !== WH_STATUS) form.elements.status.value = WH_STATUS;
    const present = new Set(comps.map((c) => c.name.toLowerCase()));
    $('#whCompQuick').innerHTML = ['Камера', 'Ящик', 'Плата'].filter((n) => !present.has(n.toLowerCase()))
      .map((n) => `<button data-perm="warehouse.edit" type="button" data-cquick="${n}" class="${btnGhost} !py-1 !px-2.5 text-xs">+ ${n}</button>`).join('');
    $('#whCompQuick').querySelectorAll('[data-cquick]').forEach((b) => { b.onclick = () => addRow({ name: b.dataset.cquick, in_stock: true, description: '' }); });
  };
  const wireRow = (row) => {
    row.querySelector('[data-cdel]').onclick = () => { row.remove(); updateSummary(); };
    row.querySelector('[data-cstock]').onchange = updateSummary;
    row.querySelector('[data-cname]').oninput = updateSummary;
  };
  const addRow = (c) => {
    const holder = document.createElement('div');
    holder.innerHTML = compRowHtml(c);
    const row = holder.firstElementChild;
    $('#whComps').appendChild(row);
    wireRow(row);
    updateSummary();
    return row;
  };
  item.components.forEach((c) => addRow(c));
  updateSummary();
  $('#whCompAdd').onclick = () => addRow({ name: '', in_stock: true, description: '' }).querySelector('[data-cname]').focus();
  // Выбрали статус вручную — отметки приводим в соответствие (как на сервере):
  // «На складе» — все компоненты на складе, любой другой статус — ни один.
  form.elements.status.onchange = (e) => {
    const target = e.target.value;
    form.querySelectorAll('[data-cstock]').forEach((box) => { box.checked = target === WH_STATUS; });
    updateSummary();
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const newStatus = f.status.value;
    const comps = readComps();
    try {
      // Status is set separately (a narrower endpoint — doesn't touch
      // address/coords/etc.) only when it was changed by hand: leaving «На
      // складе» (points_repository then clears the warehouse data and
      // un-stocks the components, so saving the fields below would be
      // pointless) or putting a complex without components on the shelf.
      // Otherwise the server derives it from the ticks when saving them.
      if (newStatus !== item.status && (newStatus !== WH_STATUS || !comps.length)) {
        await Api.put('/api/points/' + encodeURIComponent(pointId) + '/status', { status: newStatus });
        if (newStatus !== WH_STATUS) { close(); return; }
      }
      const v = {
        web_status: f.web_status.value || null,
        received_at: f.received_at.value || null,
        info: f.info.value.trim() || null,
        components: comps,
      };
      await Api.put('/api/warehouse/points/' + encodeURIComponent(pointId), v);
      close();
    } catch (err) {
      $('#whItemFormError').textContent = err.message;
      $('#whItemFormError').classList.remove('hidden');
    }
  };
}

async function importWarehouseFile(f) {
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await Api.upload('/api/warehouse/import', fd);
    const lines = [`Обновлено комплексов: ${r.updated}`];
    if (r.created) lines.push(`Создано новых комплексов: ${r.created}`);
    if (r.components) lines.push(`Строк с компонентами: ${r.components}`);
    if (r.row_errors?.length) lines.push('', 'Ошибки:', ...r.row_errors.slice(0, 20));
    alert(lines.join('\n'));
    await renderWarehousePage();
  } catch (e) { alert('Не удалось импортировать файл: ' + e.message); }
}
$('#whImportFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importWarehouseFile(f); };

// ---------- Page chrome: auth guard, user menu, password change ----------

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

async function boot() {
  try {
    CURRENT_USER = await Api.get('/api/auth/me');
  } catch {
    return; // Api.get already redirects to /login on 401
  }
  if (!can('warehouse.view')) { window.location.href = '/'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  await loadPointStatuses();
  await showWhTab(whTab);
  // Live refresh, matching the calendar's 5s poll — only for the «Комплексы на складе» tab,
  // skipped while a modal is open (editing) or the search box has focus/unsent text.
  setInterval(() => {
    if (whTab !== 'shelf' || editing || document.hidden || document.activeElement?.name === 'q') return;
    refreshWarehouseList().catch(() => {});
  }, 5000);
}
boot();
