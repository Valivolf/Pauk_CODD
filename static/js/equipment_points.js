// Склад: вкладки «Оборудование на комплексах» (карточка комплекса — что стоит, установка / замена /
// снятие, солнечная панель, журнал) и «Солнечные панели». Общие помощники — equipment.js.

// ---------- выбор единицы оборудования: со склада или у монтёра (для установки и замены)
function eqPickerHtml(prefix, { category = '' } = {}) {
  return `<div data-picker="${prefix}" class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 space-y-2">
    <div class="grid grid-cols-3 gap-2">
      <select data-psource class="${fieldCls}">
        <option value="stock">Со склада (годное)</option>
        ${eqFitters().map((p) => `<option value="${p.id}">У монтёра: ${esc(p.full_name)}</option>`).join('')}
      </select>
      <select data-pcat class="${fieldCls}">${eqOptions(EQ.meta.categories, 'id', 'name', category, 'Все категории')}</select>
      <input data-psearch placeholder="Серийный номер…" autocomplete="off" class="${fieldCls}">
    </div>
    <div data-presults class="space-y-1 max-h-40 overflow-auto"></div>
    <div data-ppicked class="text-xs text-slate-500">Оборудование не выбрано</div>
  </div>`;
}

// Возвращает объект с .picked (выбранная единица) и .source ('stock' | id монтёра, у которого она).
function wireEqPicker(root, prefix) {
  const box = root.querySelector(`[data-picker="${prefix}"]`);
  const state = { picked: null, source: 'stock', onChange: () => {} };
  const results = box.querySelector('[data-presults]');
  const paintPicked = () => {
    box.querySelector('[data-ppicked]').innerHTML = state.picked
      ? `Выбрано: <b class="text-indigo-300">№${esc(state.picked.serial_number)}</b> <span class="text-slate-400">${esc(state.picked.category_name)} · ${esc(state.picked.model_name)}</span>`
      : 'Оборудование не выбрано';
    state.onChange();
  };
  const run = async () => {
    const source = box.querySelector('[data-psource]').value;
    state.source = source;
    const p = new URLSearchParams({ limit: '20' });
    if (source === 'stock') { p.set('place', 'stock'); p.set('usable', 'true'); } else { p.set('place', 'person'); p.set('person_id', source); }
    if (box.querySelector('[data-pcat]').value) p.set('category_id', box.querySelector('[data-pcat]').value);
    const q = box.querySelector('[data-psearch]').value.trim();
    if (q) p.set('search', q);
    let list = [];
    try { list = await Api.get('/api/equipment/items?' + p); } catch { return; }
    if (source !== 'stock') list = list.filter((i) => i.held_reason === 'issued' || i.held_reason === 'kept');
    results.innerHTML = list.map((i) => `<button type="button" data-pick="${i.id}" class="w-full text-left rounded-lg border ${state.picked && state.picked.id === i.id ? 'border-indigo-400/60' : 'border-slate-700/50'} bg-slate-800/30 hover:bg-slate-700/40 px-3 py-1.5 text-xs">
      <b>${esc(i.serial_number)}</b> · ${esc(i.category_name)} · ${esc(i.model_name)} ${eqStatusBadge(i)}</button>`).join('')
      || `<p class="text-xs text-slate-500">${source === 'stock' ? 'На складе нет подходящего годного оборудования' : 'У монтёра нет выданного оборудования этой категории'}</p>`;
    results.querySelectorAll('[data-pick]').forEach((b) => {
      b.onclick = () => { state.picked = list.find((x) => x.id === +b.dataset.pick); paintPicked(); run(); };
    });
  };
  box.querySelector('[data-psource]').onchange = () => { state.picked = null; paintPicked(); run(); };
  box.querySelector('[data-pcat]').onchange = run;
  box.querySelector('[data-psearch]').oninput = eqDebounce(run);
  box.querySelector('[data-psearch]').onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('[data-pick]')?.click(); } };
  run();
  return state;
}

// ======================================================================= «Оборудование на комплексах»

const eqPts = { q: '', category: '', hasEq: false, hasPanel: false, limit: 200 };

async function renderComplexesTab() {
  try { await eqLoadMeta(); } catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  const cats = await Api.get('/api/point-categories').catch(() => []);
  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="pcSearch" value="${esc(eqPts.q)}" placeholder="Номер, адрес, инвентарный номер комплекса или серийный номер оборудования" class="${fieldCls} flex-1 min-w-[220px]">
      <select id="pcCat" class="${fieldCls} !w-auto">${eqOptions(cats, 'id', 'name', eqPts.category, 'Все категории')}</select>
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" id="pcHasEq" class="rounded accent-indigo-500" ${eqPts.hasEq ? 'checked' : ''}> с оборудованием</label>
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" id="pcHasPanel" class="rounded accent-indigo-500" ${eqPts.hasPanel ? 'checked' : ''}> с панелью</label>
      <button id="pcExport" class="${btnGhost} !px-4">Excel</button>
    </div>
    <div id="pcSummary" class="text-xs text-slate-500 mb-2"></div>
    <div id="pcList"></div>`;
  const reload = () => eqReloadPoints();
  $('#pcSearch').oninput = eqDebounce(() => { eqPts.q = $('#pcSearch').value.trim(); eqPts.limit = 200; reload(); });
  $('#pcCat').onchange = (e) => { eqPts.category = e.target.value; reload(); };
  $('#pcHasEq').onchange = (e) => { eqPts.hasEq = e.target.checked; reload(); };
  $('#pcHasPanel').onchange = (e) => { eqPts.hasPanel = e.target.checked; reload(); };
  $('#pcExport').onclick = () => downloadFile('/api/equipment/export/points.xlsx?' + eqPointsQuery()).catch((e) => alert(e.message));
  await reload();
}

function eqPointsQuery(extra = {}) {
  const p = new URLSearchParams();
  if (eqPts.q) p.set('search', eqPts.q);
  if (eqPts.category) p.set('category_id', eqPts.category);
  if (eqPts.hasEq) p.set('has_equipment', 'true');
  if (eqPts.hasPanel) p.set('has_panel', 'true');
  Object.entries(extra).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

async function eqReloadPoints() {
  const box = $('#pcList');
  if (!box) return;
  let res;
  if (box.children.length) setListLoading(box, true); else box.innerHTML = loadingHtml('Данные загружаются…', 'text-sm text-slate-500 text-center py-8');
  try { res = await Api.getPage('/api/equipment/points?' + eqPointsQuery({ limit: eqPts.limit })); } catch (e) { setListLoading(box, false); box.innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  setListLoading(box, false);
  $('#pcSummary').textContent = res.items.length ? `Показано ${res.items.length} из ${res.total}` : '';
  if (!res.items.length) { box.innerHTML = '<p class="text-sm text-slate-500 text-center py-8">Комплексы не найдены</p>'; return; }
  box.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm">
    <thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60"><th class="py-2 pr-3">Комплекс</th><th class="py-2 pr-3">Инв. №</th><th class="py-2 pr-3">Адрес</th><th class="py-2 pr-3">Категория</th><th class="py-2 pr-3">Панель</th><th class="py-2 pr-3 text-center">Оборудование</th></tr></thead>
    <tbody>${res.items.map((p) => `<tr data-pcopen="${esc(p.id)}" class="border-b border-slate-800/80 hover:bg-slate-800/30 cursor-pointer">
      <td class="py-2 pr-3 font-semibold text-indigo-300">${esc(p.id)}</td><td class="py-2 pr-3 text-xs">${esc(p.inventory_number)}</td>
      <td class="py-2 pr-3 text-xs text-slate-400">${esc(p.address)}</td><td class="py-2 pr-3">${colorBadge(p.category_name, p.category_color)}</td>
      <td class="py-2 pr-3 text-xs">${esc(p.panel_number)}</td><td class="py-2 pr-3 text-center">${p.equipment_count || '<span class="text-slate-600">—</span>'}</td></tr>`).join('')}</tbody></table></div>
    ${res.items.length < res.total ? `<div class="text-center pt-3"><button id="pcMore" class="${btnGhost} text-xs">Показать ещё</button></div>` : ''}`;
  box.querySelectorAll('[data-pcopen]').forEach((tr) => { tr.onclick = () => eqPointCard(tr.dataset.pcopen); });
  if ($('#pcMore')) $('#pcMore').onclick = () => { eqPts.limit += 200; eqReloadPoints(); };
}

// ---------- карточка комплекса

async function eqPointCard(pointId) {
  let d; let panels = [];
  try {
    await eqLoadMeta();
    [d, panels] = await Promise.all([Api.get('/api/equipment/points/' + encodeURIComponent(pointId)), Api.get('/api/solar-panels?linked=no')]);
  } catch (e) { alert(e.message); return; }
  const today = new Date().toISOString().slice(0, 10);
  modal(`<div class="flex flex-wrap items-start justify-between gap-2 mb-1">
      <h2 class="font-display text-lg font-bold">Комплекс ${esc(d.id)}</h2>
      <span class="flex items-center gap-1.5">${colorBadge(d.category_name, d.category_color)} ${pointStatusBadge(d.status)}</span></div>
    <p class="text-xs text-slate-400 mb-3">${d.inventory_number ? 'инв. ' + esc(d.inventory_number) + ' · ' : ''}${esc(d.address || 'адрес не указан')}</p>
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 mb-4 flex flex-wrap items-center gap-2">
      <span class="text-xs">☀ Солнечная панель: ${d.panel ? `<b>${esc(d.panel.panel_number)}</b>` : '<span class="text-slate-500">не привязана</span>'}</span>
      ${d.panel ? `<button data-perm="warehouse.edit" id="pcUnlink" class="${btnGhost} !py-1 !px-2 text-xs">Отвязать</button>` : `
        <select id="pcPanelSel" class="${fieldCls} !w-auto !py-1 text-xs">${eqOptions(panels, 'id', 'panel_number', '', 'Выберите свободную панель')}</select>
        <button data-perm="warehouse.edit" id="pcLink" class="${btnGhost} !py-1 !px-2 text-xs">Привязать</button>`}
    </div>
    <div class="flex items-center justify-between mb-2"><b class="text-sm">Установленное оборудование</b>
      <span class="flex gap-1.5">${d.equipment.some((x) => x.category_kind === 'sim') ? '' : `<button data-perm="warehouse.edit" id="pcSimNew" class="${btnGhost} !py-1.5 !px-3 text-xs">💳 Указать SIM</button>`}
      <button data-perm="warehouse.edit" id="pcAttach" class="${btnPrimary} !py-1.5 !px-3 text-xs">+ Установить</button></span></div>
    <div class="space-y-1.5 mb-5">${d.equipment.map((it) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
      <span class="text-xs min-w-0"><span class="text-slate-400">${esc(it.category_name)}</span> · ${esc(it.model_name)}<br>
        <button data-pcitem="${it.id}" class="text-sm font-semibold text-indigo-300 hover:underline">№ ${esc(it.serial_number)}</button>
        <span class="text-slate-500">${it.installed_date ? ' · с ' + esc(fmtDate(it.installed_date)) : ''}${it.installed_by ? ' · ' + esc(it.installed_by) : ''}</span> ${eqStatusBadge(it)}</span>
      <span class="flex gap-1.5">${it.category_kind === 'sim'
        ? `<button data-perm="warehouse.edit" data-pcsimreplace="${it.id}" class="${btnGhost} !py-1 !px-2 text-xs">Заменить SIM</button>
           <button data-perm="warehouse.edit" data-pcsimfix="${it.id}" class="${btnGhost} !py-1 !px-2 text-xs" title="Номер был записан неверно">✏️ Номер</button>`
        : `<button data-perm="warehouse.edit" data-pcreplace="${it.id}" class="${btnGhost} !py-1 !px-2 text-xs">Заменить</button>`}
        <button data-perm="warehouse.edit" data-pcdetach="${it.id}" class="${btnDanger} !py-1 !px-2 text-xs">Снять</button></span></div>`).join('')
      || '<p class="text-sm text-slate-500">На комплексе нет оборудования</p>'}</div>
    <b class="text-sm block mb-2">История комплекса</b>
    <div class="space-y-1 max-h-52 overflow-auto mb-3">${d.history.map((h) => `<div class="rounded-lg border border-slate-700/40 bg-slate-800/20 px-2.5 py-1.5 text-xs">
      <span class="text-slate-500">${esc(fmtDate(h.event_date || h.ts))}</span> · <b>${esc(h.action_type)}</b>${h.serial_number ? ' · №' + esc(h.serial_number) : ''}${h.model_name ? ' ' + esc(h.model_name) : ''}${h.person_name ? ' · ' + esc(h.person_name) : ''}
      ${h.comment ? `<br><span class="text-slate-400">${esc(h.comment)}</span>` : ''}${h.performed_by ? `<br><span class="text-slate-600">${esc(h.performed_by)}</span>` : ''}</div>`).join('')
      || '<p class="text-xs text-slate-500">История пуста</p>'}</div>
    <form id="pcNote" class="flex flex-wrap items-end gap-2 mb-4">
      <label class="${labelCls} flex-1 min-w-[160px]">Добавить запись<input name="comment" placeholder="Что было сделано" class="${fieldCls}"></label>
      <label class="${labelCls}">Дата<input type="date" name="date" value="${today}" class="${fieldCls}"></label>
      <button class="${btnGhost} !py-2 text-xs">Добавить</button></form>
    <div id="pcMsg" class="mb-3"></div>
    <div class="flex"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
  eqWide('max-w-3xl');
  const reopen = () => eqPointCard(pointId);
  const fail = (err) => { $('#pcMsg').innerHTML = eqNote(err.message, 'err'); };
  const act = async (fn) => { try { await fn(); await reopen(); } catch (err) { fail(err); } };
  if ($('#pcUnlink')) $('#pcUnlink').onclick = () => act(() => Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/link-panel`, { panel_id: null }));
  if ($('#pcLink')) $('#pcLink').onclick = () => { const v = $('#pcPanelSel').value; if (!v) { fail(new Error('Выберите панель')); return; } act(() => Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/link-panel`, { panel_id: +v })); };
  $('#pcNote').onsubmit = (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.comment.value.trim()) { fail(new Error('Опишите, что было сделано')); return; }
    act(() => Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/note`, { comment: f.comment.value.trim(), date: f.date.value || null }));
  };
  $('#pcAttach').onclick = () => eqAttachForm(pointId, reopen);
  if ($('#pcSimNew')) $('#pcSimNew').onclick = () => eqSimFixForm(pointId, null, reopen);
  $('#modal').querySelectorAll('[data-pcitem]').forEach((b) => { b.onclick = () => eqItemCard(+b.dataset.pcitem); });
  $('#modal').querySelectorAll('[data-pcreplace]').forEach((b) => { b.onclick = () => eqReplaceForm(pointId, d.equipment.find((x) => x.id === +b.dataset.pcreplace), reopen); });
  $('#modal').querySelectorAll('[data-pcsimreplace]').forEach((b) => { b.onclick = () => eqSimReplaceForm(pointId, d.equipment.find((x) => x.id === +b.dataset.pcsimreplace), reopen); });
  $('#modal').querySelectorAll('[data-pcsimfix]').forEach((b) => { b.onclick = () => eqSimFixForm(pointId, d.equipment.find((x) => x.id === +b.dataset.pcsimfix), reopen); });
  $('#modal').querySelectorAll('[data-pcdetach]').forEach((b) => { b.onclick = () => eqDetachForm(pointId, d.equipment.find((x) => x.id === +b.dataset.pcdetach), reopen); });
}

function eqAttachForm(pointId, onDone) {
  const today = new Date().toISOString().slice(0, 10);
  modal(`<h2 class="font-display text-lg font-bold mb-1">Установить на комплекс ${esc(pointId)}</h2>
    <p class="text-xs text-slate-400 mb-3">Со склада (только годное) или из того, что выдано монтёру.</p>
    <form id="atForm" class="space-y-3">
      ${eqPickerHtml('at')}
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Дата установки<input type="date" name="date" value="${today}" class="${fieldCls}"></label>
        <label class="${labelCls}">Кто установил<input name="by" placeholder="по умолчанию — монтёр, у которого оборудование" class="${fieldCls}"></label>
      </div>
      <label class="${labelCls}">Комментарий<input name="comment" class="${fieldCls}"></label>
      <div id="atMsg"></div>
      <div class="flex gap-2"><button type="button" id="atBack" class="${btnGhost}">Назад</button><button class="${btnPrimary}">Установить</button></div>
    </form>`);
  eqWide('max-w-2xl');
  const pick = wireEqPicker($('#atForm'), 'at');
  $('#atBack').onclick = onDone;
  $('#atForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!pick.picked) { $('#atMsg').innerHTML = eqNote('Выберите оборудование', 'warn'); return; }
    const f = e.target.elements;
    try {
      await Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/attach`, {
        equipment_id: pick.picked.id, person_id: pick.source === 'stock' ? null : +pick.source,
        installed_by: f.by.value.trim() || null, date: f.date.value || null, comment: f.comment.value.trim() || null,
      });
      await onDone();
    } catch (err) { $('#atMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}

function eqReplaceForm(pointId, old, onDone) {
  const today = new Date().toISOString().slice(0, 10);
  const defect = EQ.meta.statuses.find((s) => s.role === 'defect');
  modal(`<h2 class="font-display text-lg font-bold mb-1">Замена на комплексе ${esc(pointId)}</h2>
    <p class="text-sm mb-3">Снимается: <b>№ ${esc(old.serial_number)}</b> <span class="text-slate-400">${esc(old.category_name)} · ${esc(old.model_name)}</span></p>
    <form id="rpForm" class="space-y-3">
      <b class="text-xs">Что ставим взамен</b>
      ${eqPickerHtml('rp', { category: old.category_id })}
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Дата<input type="date" name="date" value="${today}" class="${fieldCls}"></label>
        <label class="${labelCls}">Снятое числится на монтёре<select name="person" class="${fieldCls}">${eqOptions(eqFitters(), 'id', 'full_name', '', 'Сразу на склад (никто не числится)')}</select></label>
        <label class="${labelCls}">Состояние снятого<select name="status" class="${fieldCls}">${eqOptions(EQ.meta.statuses, 'id', 'name', defect ? defect.id : '')}</select></label>
        <label class="${labelCls}">Комментарий<input name="comment" class="${fieldCls}"></label>
        ${eqReasonField()}
      </div>
      <p class="text-[11px] text-slate-500">Если новое берётся у монтёра, снятое записывается на него. Снятое получает состояние «${esc(defect ? defect.name : 'Дефектное')}» и ждёт приёмки на склад (снятая SIM-карта остаётся у монтёра — сдавать её на склад не обязательно).</p>
      ${eqFinderHtml('rpf', { expectedSerial: old.serial_number })}
      <div id="rpMsg"></div>
      <div class="flex gap-2"><button type="button" id="rpBack" class="${btnGhost}">Назад</button><button class="${btnPrimary}">Заменить</button></div>
    </form>`);
  eqWide('max-w-2xl');
  const pick = wireEqPicker($('#rpForm'), 'rp');
  const finder = wireEqFinder($('#rpForm'), 'rpf', old.id);
  const personSel = $('#rpForm').elements.person;
  pick.onChange = () => { if (pick.picked && pick.source !== 'stock') personSel.value = pick.source; };
  $('#rpBack').onclick = onDone;
  $('#rpForm').onsubmit = async (e) => {
    e.preventDefault();
    if (!pick.picked) { $('#rpMsg').innerHTML = eqNote('Выберите, что ставим взамен', 'warn'); return; }
    const f = e.target.elements;
    try {
      const r = await Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/replace`, {
        old_equipment_id: old.id, new_equipment_id: pick.picked.id, person_id: f.person.value ? +f.person.value : null,
        date: f.date.value || null, comment: f.comment.value.trim() || null, removed_status_id: f.status.value ? +f.status.value : null,
        reason: f.reason.value.trim() || null, ...finder.payload(),
      });
      if (r.unknown) alert(`№${r.unknown} помечен как «неизвестное местонахождение» — на комплексе стоял №${r.removed}.`);
      await onDone();
    } catch (err) { $('#rpMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}

function eqDetachForm(pointId, it, onDone) {
  const today = new Date().toISOString().slice(0, 10);
  const defect = EQ.meta.statuses.find((s) => s.role === 'defect');
  modal(`<h2 class="font-display text-lg font-bold mb-1">Снять с комплекса ${esc(pointId)}</h2>
    <p class="text-sm mb-3"><b>№ ${esc(it.serial_number)}</b> <span class="text-slate-400">${esc(it.category_name)} · ${esc(it.model_name)}</span></p>
    <form id="dtForm" class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Куда<select name="person" class="${fieldCls}">${eqOptions(eqFitters(), 'id', (p) => 'На монтёра: ' + p.full_name, '', 'Сразу на склад')}</select></label>
        <label class="${labelCls}">Состояние<select name="status" class="${fieldCls}">${eqOptions(EQ.meta.statuses, 'id', 'name', defect ? defect.id : '')}</select></label>
        <label class="${labelCls}">Дата<input type="date" name="date" value="${today}" class="${fieldCls}"></label>
        <label class="${labelCls}">Комментарий<input name="comment" class="${fieldCls}"></label>
        ${eqReasonField()}
      </div>
      ${eqFinderHtml('dtf', { expectedSerial: it.serial_number })}
      <div id="dtMsg"></div>
      <div class="flex gap-2"><button type="button" id="dtBack" class="${btnGhost}">Назад</button><button class="${btnDanger}">Снять</button></div>
    </form>`);
  $('#dtBack').onclick = onDone;
  const finder = wireEqFinder($('#dtForm'), 'dtf', it.id);
  $('#dtForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const r = await Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/detach/${it.id}`, {
        to_person_id: f.person.value ? +f.person.value : null, status_id: f.status.value ? +f.status.value : null,
        date: f.date.value || null, comment: f.comment.value.trim() || null, reason: f.reason.value.trim() || null, ...finder.payload(),
      });
      if (r.unknown) alert(`№${r.unknown} помечен как «неизвестное местонахождение» — на комплексе стоял №${r.removed}.`);
      await onDone();
    } catch (err) { $('#dtMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}

// Поле «Причина снятия» с подсказками (те же готовые причины, что в боте): почему оборудование снимают — какая проблема.
function eqReasonField() {
  return `<label class="${labelCls} col-span-2">Причина снятия <span class="font-normal">(почему снимается — какая проблема)</span>
    <input name="reason" list="eqReasonList" placeholder="Неисправно, не включается, нет связи…" class="${fieldCls}">
    <datalist id="eqReasonList">${(EQ.meta.removal_reasons || []).map((r) => `<option value="${esc(r)}">`).join('')}</datalist></label>`;
}

// SIM-карта комплекса: замена (новая — по номеру, если её нет в базе, она заведётся) и исправление номера.
function eqSimReplaceForm(pointId, old, onDone) {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Замена SIM-карты · комплекс ${esc(pointId)}</h2>
    <p class="text-sm mb-3">Сейчас: <b>${esc(old.serial_number)}</b> <span class="text-slate-400">${esc(old.model_name)}</span></p>
    <form id="smForm" class="space-y-3">
      <label class="${labelCls}">Номер новой SIM <span class="font-normal">(полный номер с карты — сохранятся последние 7 цифр)</span><input name="serial" required autocomplete="off" class="${fieldCls}"></label>
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Старая SIM остаётся у монтёра (сдача не обязательна)<select name="person" class="${fieldCls}">${eqOptions(eqFitters(), 'id', 'full_name', '', 'Сразу на склад (никто не числится)')}</select></label>
        ${eqReasonField().replace('col-span-2', '')}
      </div>
      <p class="text-[11px] text-slate-500">Поле «Номер SIM» комплекса и IP из реестра SIM↔IP обновятся. Если нужно просто исправить ошибочный номер — закройте это окно и нажмите «✏️ Номер».</p>
      <div id="smMsg"></div>
      <div class="flex gap-2"><button type="button" id="smBack" class="${btnGhost}">Назад</button><button class="${btnPrimary}">Заменить</button></div>
    </form>`);
  $('#smBack').onclick = onDone;
  $('#smForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const r = await Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/sim/replace`, {
        serial_number: f.serial.value.trim(), person_id: f.person.value ? +f.person.value : null, reason: f.reason.value.trim() || null,
      });
      if (!r.ip_known) alert('Новой SIM пока нет в реестре SIM↔IP — IP комплекса остался прежним.');
      await onDone();
    } catch (err) { $('#smMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}

function eqSimFixForm(pointId, current, onDone) {
  modal(`<h2 class="font-display text-lg font-bold mb-1">${current ? 'Исправить номер SIM' : 'Указать SIM комплекса'} · ${esc(pointId)}</h2>
    <p class="text-sm mb-3">${current ? `Сейчас записано: <b>${esc(current.serial_number)}</b>` : 'На комплексе SIM-карта в учёте не числится.'}</p>
    <form id="sfForm" class="space-y-3">
      <label class="${labelCls}">${current ? 'Правильный номер' : 'Номер SIM'} <span class="font-normal">(полный номер с карты — сохранятся последние 7 цифр)</span><input name="serial" required autocomplete="off" class="${fieldCls}"></label>
      <p class="text-[11px] text-slate-500">${current ? 'Это исправление ошибки в записи: SIM не меняли, ничего не снимается, история остаётся.' : 'Карта встанет на комплекс, поле «Номер SIM» заполнится.'}</p>
      <div id="sfMsg"></div>
      <div class="flex gap-2"><button type="button" id="sfBack" class="${btnGhost}">Назад</button><button class="${btnPrimary}">Сохранить</button></div>
    </form>`);
  $('#sfBack').onclick = onDone;
  $('#sfForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await Api.post(`/api/equipment/points/${encodeURIComponent(pointId)}/sim/fix`, { serial_number: e.target.elements.serial.value.trim() });
      await onDone();
    } catch (err) { $('#sfMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}

// ======================================================================= «Солнечные панели»

const eqPanels = { q: '', linked: '', wh: false };

async function renderPanelsTab() {
  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="spSearch" value="${esc(eqPanels.q)}" placeholder="Номер панели, местонахождение, комплекс" class="${fieldCls} flex-1 min-w-[220px]">
      <select id="spLinked" class="${fieldCls} !w-auto"><option value="">Все панели</option><option value="yes" ${eqPanels.linked === 'yes' ? 'selected' : ''}>Привязанные к комплексу</option><option value="no" ${eqPanels.linked === 'no' ? 'selected' : ''}>Без комплекса</option></select>
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" id="spWh" class="rounded accent-indigo-500" ${eqPanels.wh ? 'checked' : ''}> на складе</label>
      <button data-perm="warehouse.edit" id="spAdd" class="${btnPrimary} !px-4">+ Добавить панель</button>
      <button id="spExport" class="${btnGhost} !px-4">Excel</button>
    </div>
    <div id="spList"></div>`;
  const reload = () => eqReloadPanels();
  $('#spSearch').oninput = eqDebounce(() => { eqPanels.q = $('#spSearch').value.trim(); reload(); });
  $('#spLinked').onchange = (e) => { eqPanels.linked = e.target.value; reload(); };
  $('#spWh').onchange = (e) => { eqPanels.wh = e.target.checked; reload(); };
  $('#spAdd').onclick = () => eqPanelForm();
  $('#spExport').onclick = () => downloadFile('/api/solar-panels/export.xlsx?' + eqPanelQuery()).catch((e) => alert(e.message));
  await reload();
}

function eqPanelQuery() {
  const p = new URLSearchParams();
  if (eqPanels.q) p.set('search', eqPanels.q);
  if (eqPanels.linked) p.set('linked', eqPanels.linked);
  if (eqPanels.wh) p.set('at_warehouse', 'true');
  return p.toString();
}

async function eqReloadPanels() {
  const box = $('#spList');
  if (!box) return;
  let list;
  if (box.children.length) setListLoading(box, true); else box.innerHTML = loadingHtml('Данные загружаются…', 'text-sm text-slate-500 text-center py-8');
  try { list = await Api.get('/api/solar-panels?' + eqPanelQuery()); } catch (e) { setListLoading(box, false); box.innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  setListLoading(box, false);
  if (!list.length) { box.innerHTML = '<p class="text-sm text-slate-500 text-center py-8">Панели не найдены</p>'; return; }
  box.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm">
    <thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60"><th class="py-2 pr-3">Номер панели</th><th class="py-2 pr-3">Комплекс</th><th class="py-2 pr-3">Местонахождение</th><th class="py-2 pr-3">Примечание</th><th></th></tr></thead>
    <tbody>${list.map((p) => `<tr class="border-b border-slate-800/80">
      <td class="py-2 pr-3 font-semibold">☀ ${esc(p.panel_number)}${p.at_warehouse ? ' <span class="rounded-full bg-slate-700/60 text-[10px] px-1.5 py-0.5 text-slate-300">на складе</span>' : ''}</td>
      <td class="py-2 pr-3 text-xs">${p.point_id ? `<button data-sppoint="${esc(p.point_id)}" class="text-indigo-300 hover:underline">${esc(p.point_id)}</button>` : '<span class="text-slate-600">—</span>'}</td>
      <td class="py-2 pr-3 text-xs text-slate-400">${esc(p.location || '')}</td><td class="py-2 pr-3 text-xs text-slate-400">${esc(p.notes || '')}</td>
      <td class="py-2 text-right whitespace-nowrap"><button data-perm="warehouse.edit" data-spedit="${p.id}" class="${btnGhost} !py-1 !px-2 text-xs">Изменить</button>
        <button data-perm="warehouse.edit" data-spdel="${p.id}" class="${btnDanger} !py-1 !px-2 text-xs">Удалить</button></td></tr>`).join('')}</tbody></table></div>`;
  box.querySelectorAll('[data-sppoint]').forEach((b) => { b.onclick = () => eqPointCard(b.dataset.sppoint); });
  box.querySelectorAll('[data-spedit]').forEach((b) => { b.onclick = () => eqPanelForm(list.find((x) => x.id === +b.dataset.spedit)); });
  box.querySelectorAll('[data-spdel]').forEach((b) => {
    b.onclick = async () => {
      const p = list.find((x) => x.id === +b.dataset.spdel);
      if (!confirm(`Удалить панель ${p.panel_number}?${p.point_id ? ' Она будет отвязана от комплекса ' + p.point_id + '.' : ''}`)) return;
      try { await Api.del('/api/solar-panels/' + p.id); await eqReloadPanels(); } catch (err) { alert(err.message); }
    };
  });
}

function eqPanelForm(panel) {
  modal(`<h2 class="font-display text-lg font-bold mb-3">${panel ? 'Панель ' + esc(panel.panel_number) : 'Новая солнечная панель'}</h2>
    <form id="spForm" class="space-y-3">
      <label class="${labelCls}">Номер панели<input name="number" required value="${esc(panel?.panel_number || '')}" class="${fieldCls}"></label>
      <label class="${labelCls}">Комплекс <span class="font-normal">(номер точки; пусто — не привязана)</span>
        <input name="point" list="spPoints" autocomplete="off" value="${esc(panel?.point_id || '')}" class="${fieldCls}"><datalist id="spPoints"></datalist></label>
      <label class="${labelCls}">Местонахождение<input name="location" value="${esc(panel?.location || '')}" class="${fieldCls}"></label>
      <label class="${labelCls}">Примечание<input name="notes" value="${esc(panel?.notes || '')}" class="${fieldCls}"></label>
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" name="wh" class="rounded accent-indigo-500" ${panel?.at_warehouse ? 'checked' : ''}> лежит на складе</label>
      <div id="spMsg"></div>
      <div class="flex gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Сохранить</button></div>
    </form>`);
  const f = $('#spForm').elements;
  f.point.oninput = eqDebounce(async () => {
    const q = f.point.value.trim();
    if (!q) return;
    try { const { items } = await Api.getPage(`/api/points?search=${encodeURIComponent(q)}&limit=10`); $('#spPoints').innerHTML = items.map((p) => `<option value="${esc(p.id)}">${esc(p.address || '')}</option>`).join(''); } catch { /* не критично */ }
  });
  $('#spForm').onsubmit = async (e) => {
    e.preventDefault();
    const body = { panel_number: f.number.value.trim(), point_id: f.point.value.trim() || null, location: f.location.value.trim() || null, notes: f.notes.value.trim() || null, at_warehouse: f.wh.checked };
    try {
      if (panel) await Api.put('/api/solar-panels/' + panel.id, body); else await Api.post('/api/solar-panels', body);
      close();
    } catch (err) { $('#spMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}
