// Склад: учёт оборудования по серийным номерам (бывшее приложение «Склад»).
// Общие помощники + вкладки «Оборудование» (приёмка, список, карточка единицы) и «Выдача и приём»
// (выдать монтёру, принять снятое / вернуть). Остальные вкладки — equipment_points.js, equipment_admin.js.
// Бэкенд: app/api/routes_equipment.py. $, esc, modal, fieldCls/labelCls/btn*, colorBadge, fmtDate,
// downloadFile, Api — из ui.js / api.js; close() и переключение вкладок — в warehouse.js.

const EQ = { meta: { categories: [], models: [], statuses: [], people: [], places: [] } };

async function eqLoadMeta() {
  EQ.meta = await Api.get('/api/equipment/meta');
  return EQ.meta;
}

// Монтёры — только они получают оборудование и числятся с ним; водители/операторы/склад в выборах не показываются.
const eqFitters = () => EQ.meta.people.filter((p) => p.role_type === 'fitter');
// Частичный поиск по ФИО: слова в любом порядке, любой регистр («иван петр» найдёт «Петров Иван»).
const eqNameMatch = (name, query) => {
  const hay = String(name || '').toLowerCase();
  return String(query || '').toLowerCase().split(/\s+/).filter(Boolean).every((t) => hay.includes(t));
};

const eqDebounce = (fn, ms = 250) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function eqOptions(list, valueKey, labelKey, selected, emptyLabel) {
  const head = emptyLabel != null ? `<option value="">${esc(emptyLabel)}</option>` : '';
  return head + list.map((x) => `<option value="${esc(x[valueKey])}" ${String(x[valueKey]) === String(selected ?? '') ? 'selected' : ''}>${esc(typeof labelKey === 'function' ? labelKey(x) : x[labelKey])}</option>`).join('');
}

const eqStatusBadge = (it) => (it.status ? colorBadge(it.status, it.status_color) : '<span class="text-xs text-slate-500">—</span>');

function eqWhere(it) {
  if (it.place === 'person') {
    return `<span>${esc(it.person_name || '—')}</span>${it.awaiting_accept ? ' <span class="rounded-full bg-amber-500/15 text-amber-300 text-[10px] font-medium px-1.5 py-0.5 whitespace-nowrap">ждёт приёмки</span>' : ''}${it.kept ? ' <span class="rounded-full bg-sky-500/15 text-sky-300 text-[10px] font-medium px-1.5 py-0.5 whitespace-nowrap" title="Снятая SIM осталась у монтёра: сдавать на склад не обязательно, он может поставить её снова">снятая, осталась у монтёра</span>' : ''}${(it.awaiting_accept || it.kept) && it.removal_reason ? `<br><span class="text-[10px] text-slate-500">причина: ${esc(it.removal_reason)}</span>` : ''}`;
  }
  if (it.place === 'point') return `<b>${esc(it.point_id)}</b>`;
  if (it.place === 'unknown') {
    return `<span class="rounded-full bg-orange-500/15 text-orange-300 text-[10px] font-medium px-1.5 py-0.5 whitespace-nowrap">неизвестно</span>${it.removed_point_id ? `<br><span class="text-[10px] text-slate-500">числилось: ${esc(it.removed_point_id)}</span>` : ''}`;
  }
  // На складе после приёмки от монтёра: помним, кто и откуда снял.
  const from = it.removed_by || it.removed_point_id
    ? `<br><span class="text-[10px] text-slate-500">снято${it.removed_by ? ': ' + esc(it.removed_by) : ''}${it.removed_point_id ? ' · с ' + esc(it.removed_point_id) : ''}${it.removal_reason ? ' · ' + esc(it.removal_reason) : ''}</span>` : '';
  return `<span class="text-slate-300">Склад</span>${from}`;
}

const eqPlaceTitle = { stock: 'На складе', person: 'У монтёра', point: 'На комплексе', unknown: 'Неизвестное местонахождение' };
const eqItemDate = (it) => fmtDate(it.place === 'point' ? it.installed_date : it.place === 'person' || it.place === 'unknown' ? (it.removed_date || it.issued_date) : (it.accepted_date || it.received_date));

function eqNote(text, kind = 'info') {
  const cls = { info: 'border-slate-700 bg-slate-800/40 text-slate-300', ok: 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300', err: 'border-rose-500/30 bg-rose-500/10 text-rose-300', warn: 'border-amber-500/30 bg-amber-500/10 text-amber-300' }[kind];
  return `<div class="rounded-xl border ${cls} px-3 py-2 text-xs whitespace-pre-line">${esc(text)}</div>`;
}

function eqWide(size = 'max-w-3xl') {
  const box = document.querySelector('#modal > div > div');
  if (box) { box.classList.remove('max-w-xl'); box.classList.add(size); }
}

// Строки результата операции со «пропущенными»: «№R1 — причина».
function eqSkippedText(skipped) {
  return (skipped || []).map((s) => `№${s.serial_number || s.id} — ${s.reason}`).join('\n');
}

// ======================================================================= вкладка «Оборудование»

const eqState = { q: '', category: '', model: '', place: '', status: '', from: '', to: '', limit: 300, items: [], total: 0, select: false, selected: new Set() };

function eqQuery(extra = {}) {
  const p = new URLSearchParams();
  if (eqState.q) p.set('search', eqState.q);
  if (eqState.category) p.set('category_id', eqState.category);
  if (eqState.model) p.set('model_id', eqState.model);
  if (eqState.place) p.set('place', eqState.place);
  if (eqState.status) p.set('status_id', eqState.status);
  if (eqState.from) p.set('date_from', eqState.from);
  if (eqState.to) p.set('date_to', eqState.to);
  Object.entries(extra).forEach(([k, v]) => p.set(k, v));
  return p.toString();
}

async function renderEquipmentTab() {
  try { await eqLoadMeta(); } catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`; return; }
  const m = EQ.meta;
  const models = m.models.filter((x) => !eqState.category || String(x.category_id) === String(eqState.category));
  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="eqSearch" value="${esc(eqState.q)}" placeholder="Серийный номер, модель, комплекс, монтёр…" class="${fieldCls} flex-1 min-w-[220px]">
      <button data-perm="warehouse.edit" id="eqReceiveBtn" class="${btnPrimary} !px-4 whitespace-nowrap">+ Приёмка</button>
      <button data-perm="warehouse.edit" id="eqSelectBtn" class="${btnGhost} !px-4 whitespace-nowrap">${eqState.select ? 'Готово' : 'Выбрать несколько'}</button>
      <button id="eqExportBtn" class="${btnGhost} !px-4 whitespace-nowrap">Excel</button>
    </div>
    <div class="grid grid-cols-2 md:grid-cols-6 gap-2 mb-3">
      <select id="eqCat" class="${fieldCls}">${eqOptions(m.categories, 'id', 'name', eqState.category, 'Все категории')}</select>
      <select id="eqModel" class="${fieldCls}">${eqOptions(models, 'id', 'name', eqState.model, 'Все модели')}</select>
      <select id="eqPlace" class="${fieldCls}">${eqOptions(m.places, 'key', 'label', eqState.place, 'Везде')}</select>
      <select id="eqStatus" class="${fieldCls}">${eqOptions(m.statuses, 'id', 'name', eqState.status, 'Любое состояние')}</select>
      <input id="eqFrom" type="date" value="${esc(eqState.from)}" title="Дата с" class="${fieldCls}">
      <input id="eqTo" type="date" value="${esc(eqState.to)}" title="Дата по" class="${fieldCls}">
    </div>
    <div id="eqPending"></div>
    <div id="eqBulk" class="hidden flex flex-wrap items-center gap-2 mb-3 rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3 py-2"></div>
    <div id="eqSummary" class="text-xs text-slate-500 mb-2"></div>
    <div id="eqList"></div>`;

  const reload = () => eqReloadItems();
  const onSearch = eqDebounce(() => { eqState.q = $('#eqSearch').value.trim(); eqState.limit = 300; reload(); });
  $('#eqSearch').oninput = onSearch;
  $('#eqCat').onchange = (e) => { eqState.category = e.target.value; eqState.model = ''; eqState.limit = 300; renderEquipmentTab(); };
  $('#eqModel').onchange = (e) => { eqState.model = e.target.value; eqState.limit = 300; reload(); };
  $('#eqPlace').onchange = (e) => { eqState.place = e.target.value; eqState.limit = 300; reload(); };
  $('#eqStatus').onchange = (e) => { eqState.status = e.target.value; eqState.limit = 300; reload(); };
  $('#eqFrom').onchange = (e) => { eqState.from = e.target.value; reload(); };
  $('#eqTo').onchange = (e) => { eqState.to = e.target.value; reload(); };
  $('#eqReceiveBtn').onclick = () => eqReceiveForm();
  $('#eqSelectBtn').onclick = () => { eqState.select = !eqState.select; eqState.selected.clear(); renderEquipmentTab(); };
  $('#eqExportBtn').onclick = () => downloadFile('/api/equipment/export/items.xlsx?' + eqQuery()).catch((e) => alert(e.message));
  eqLoadPending();
  await reload();
}

// «Ждут привязки»: монтёр поставил оборудование на комплекс по последним символам номера, а в учёте его ещё нет. Как только такой номер примут на склад (или загрузят из Excel),
// оно само встанет на этот комплекс. Блок виден, только пока такие записи есть.
async function eqLoadPending() {
  const box = $('#eqPending');
  if (!box) return;
  let list = [];
  try { list = await Api.get('/api/equipment/pending-installs'); } catch { /* блок необязателен */ }
  if (!$('#eqPending')) return;
  if (!list.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 mb-3 text-xs">
    <b class="text-amber-300">⏳ Ждут привязки (${list.length})</b> — монтёр поставил оборудование на комплекс, указав только последние символы номера; в учёте его ещё нет. При приёмке такого номера оно само встанет на комплекс.
    <ul class="mt-1.5 space-y-0.5 text-slate-300">${list.slice(0, 12).map((p) => `<li>комплекс <b>${esc(p.point_id)}</b> · номер заканчивается на <b>…${esc(p.suffix)}</b>${p.category_name ? ' · ' + esc(p.category_name) : ''} · ${esc(p.person_name || 'монтёр не указан')}${p.install_date ? ' · ' + esc(fmtDate(p.install_date)) : ''}</li>`).join('')}</ul>
    ${list.length > 12 ? `<div class="text-slate-400 mt-1">…и ещё ${list.length - 12}</div>` : ''}</div>`;
}

async function eqReloadItems() {
  if (!$('#eqList')) return;
  let items; let total = 0;
  const shown = $('#eqList');
  if (shown.children.length) setListLoading(shown, true); else shown.innerHTML = loadingHtml('Данные загружаются…', 'text-sm text-slate-500 text-center py-8');
  try {
    const res = await Api.getPage('/api/equipment/items?' + eqQuery({ limit: eqState.limit }));
    items = res.items; total = res.total;
  } catch (e) { setListLoading(shown, false); $('#eqList').innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  setListLoading(shown, false);
  eqState.items = items; eqState.total = total;
  [...eqState.selected].forEach((id) => { if (!items.some((i) => i.id === id)) eqState.selected.delete(id); });
  eqPaintItems();
}

function eqPaintItems() {
  const items = eqState.items;
  $('#eqSummary').textContent = items.length ? `Показано ${items.length} из ${eqState.total}` : '';
  if (!items.length) { $('#eqList').innerHTML = '<p class="text-sm text-slate-500 text-center py-8">Ничего не найдено</p>'; eqPaintBulk(); return; }
  const sel = eqState.select;
  $('#eqList').innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm">
    <thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60">
      ${sel ? `<th class="py-2 pr-2"><input type="checkbox" id="eqAll" class="rounded accent-indigo-500"></th>` : ''}
      <th class="py-2 pr-3">Серийный номер</th><th class="py-2 pr-3">Категория · модель</th><th class="py-2 pr-3">Состояние</th><th class="py-2 pr-3">Где / у кого</th><th class="py-2 pr-3">Дата</th><th></th></tr></thead>
    <tbody>${items.map((it) => `<tr class="border-b border-slate-800/80 hover:bg-slate-800/30">
      ${sel ? `<td class="py-2 pr-2"><input type="checkbox" data-eqsel="${it.id}" class="rounded accent-indigo-500" ${eqState.selected.has(it.id) ? 'checked' : ''}></td>` : ''}
      <td class="py-2 pr-3 font-semibold whitespace-nowrap"><button data-eqopen="${it.id}" class="text-indigo-300 hover:underline text-left">${esc(it.serial_number)}</button></td>
      <td class="py-2 pr-3"><span class="text-slate-400 text-xs">${esc(it.category_name)}</span><br>${esc(it.model_name)}</td>
      <td class="py-2 pr-3">${eqStatusBadge(it)}</td>
      <td class="py-2 pr-3 text-xs">${eqWhere(it)}</td>
      <td class="py-2 pr-3 text-xs text-slate-400 whitespace-nowrap">${esc(eqItemDate(it))}</td>
      <td class="py-2 text-right"><button data-eqopen="${it.id}" class="${btnGhost} !py-1 !px-2 text-xs">Открыть</button></td>
    </tr>`).join('')}</tbody></table></div>
    ${items.length < eqState.total ? `<div class="text-center pt-3"><button id="eqMore" class="${btnGhost} text-xs">Показать ещё</button></div>` : ''}`;
  $('#eqList').querySelectorAll('[data-eqopen]').forEach((b) => { b.onclick = () => eqItemCard(+b.dataset.eqopen); });
  $('#eqList').querySelectorAll('[data-eqsel]').forEach((b) => {
    b.onchange = () => { if (b.checked) eqState.selected.add(+b.dataset.eqsel); else eqState.selected.delete(+b.dataset.eqsel); eqPaintBulk(); };
  });
  if ($('#eqAll')) {
    $('#eqAll').onchange = (e) => {
      items.forEach((i) => { if (e.target.checked) eqState.selected.add(i.id); else eqState.selected.delete(i.id); });
      eqPaintItems();
    };
  }
  if ($('#eqMore')) $('#eqMore').onclick = () => { eqState.limit += 300; eqReloadItems(); };
  eqPaintBulk();
}

function eqPaintBulk() {
  const box = $('#eqBulk');
  if (!box) return;
  if (!eqState.select) { box.classList.add('hidden'); return; }
  box.classList.remove('hidden');
  const n = eqState.selected.size;
  box.innerHTML = `<span class="text-xs text-slate-300">Выбрано: <b>${n}</b></span>
    <button id="eqBulkExport" class="${btnGhost} !py-1 !px-3 text-xs" ${n ? '' : 'disabled'}>Excel выбранного</button>
    <select id="eqBulkStatus" class="${fieldCls} !py-1 !w-auto text-xs">${eqOptions(EQ.meta.statuses, 'id', 'name', '', 'Сменить состояние на…')}</select>
    <button data-perm="warehouse.edit" id="eqBulkDelete" class="${btnDanger} !py-1 !px-3 text-xs" ${n ? '' : 'disabled'}>Удалить из базы</button>`;
  const ids = () => [...eqState.selected];
  $('#eqBulkExport').onclick = async () => {
    try {
      const res = await fetch('/api/equipment/export/items.xlsx', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: ids() }) });
      if (!res.ok) throw new Error((await res.json()).detail || res.statusText);
      const blob = await res.blob(); const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = 'oborudovanie_vybrannoe.xlsx'; document.body.appendChild(a); a.click(); a.remove();
    } catch (e) { alert(e.message); }
  };
  $('#eqBulkStatus').onchange = async (e) => {
    const sid = +e.target.value; if (!sid || !n) { e.target.value = ''; return; }
    const name = EQ.meta.statuses.find((s) => s.id === sid)?.name;
    if (!confirm(`Сменить состояние у ${n} ед. на «${name}»? Меняется только у оборудования на складе.`)) { e.target.value = ''; return; }
    try {
      const r = await Api.post('/api/equipment/items/bulk-status', { ids: ids(), status_id: sid });
      alert(`Изменено: ${r.changed.length}${r.skipped.length ? `\nПропущено:\n${eqSkippedText(r.skipped)}` : ''}`);
      eqState.selected.clear(); await eqReloadItems();
    } catch (err) { alert(err.message); }
  };
  $('#eqBulkDelete').onclick = async () => {
    if (!confirm(`Удалить из базы ${n} ед. оборудования? Это нельзя отменить. Удаляется только то, что лежит на складе.`)) return;
    try {
      const r = await Api.post('/api/equipment/items/bulk-delete', { ids: ids() });
      alert(`Удалено: ${r.deleted.length}${r.skipped.length ? `\nНе удалено:\n${eqSkippedText(r.skipped)}` : ''}`);
      eqState.selected.clear(); await eqReloadItems();
    } catch (err) { alert(err.message); }
  };
}

// -------- приёмка

function eqReceiveForm() {
  const m = EQ.meta;
  const today = new Date().toISOString().slice(0, 10);
  modal(`<h2 class="font-display text-lg font-bold mb-1">Приёмка оборудования</h2>
    <p class="text-xs text-slate-400 mb-4">Оприходовать на склад партию по серийным номерам. Состояние — «Исправно».</p>
    <form id="eqReceiveForm" class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Категория<select name="category" required class="${fieldCls}">${eqOptions(m.categories, 'id', 'name', '', '— выберите —')}</select></label>
        <label class="${labelCls}">Модель<select name="model" required class="${fieldCls}"></select></label>
      </div>
      <div class="flex items-center gap-2">
        <input name="newModel" placeholder="Новая модель (если нет в списке)" class="${fieldCls} flex-1">
        <button data-perm="warehouse.edit" type="button" id="eqAddModel" class="${btnGhost} !px-3 whitespace-nowrap text-xs">+ Добавить модель</button>
      </div>
      <label class="${labelCls}">Дата приёмки<input type="date" name="date" value="${today}" class="${fieldCls}"></label>
      <label class="${labelCls}">Серийные номера <span class="font-normal">(по одному в строке — можно вставить список из Excel или со сканера; для SIM-карт — полный номер, сохранятся последние 7 цифр)</span>
        <textarea name="serials" rows="6" required placeholder="SN00123&#10;SN00124" class="${fieldCls}"></textarea></label>
      <label class="${labelCls}">Примечание<input name="notes" class="${fieldCls}"></label>
      <div id="eqReceiveMsg"></div>
      <div class="flex items-center gap-2 pt-1">
        <button type="button" class="cancel ${btnGhost}">Закрыть</button>
        <button class="${btnPrimary}">Оприходовать</button>
      </div>
    </form>`);
  const f = $('#eqReceiveForm');
  const fillModels = (selected) => {
    const cid = f.elements.category.value;
    // EQ.meta заменяется после добавления модели — читаем свежий справочник, а не копию на момент открытия.
    const list = EQ.meta.models.filter((x) => String(x.category_id) === cid);
    f.elements.model.innerHTML = eqOptions(list, 'id', 'name', selected, list.length ? '— выберите —' : '— в категории нет моделей —');
  };
  fillModels();
  f.elements.category.onchange = () => fillModels();
  $('#eqAddModel').onclick = async () => {
    const name = f.elements.newModel.value.trim(); const cid = +f.elements.category.value;
    if (!cid) { $('#eqReceiveMsg').innerHTML = eqNote('Сначала выберите категорию', 'warn'); return; }
    if (!name) { $('#eqReceiveMsg').innerHTML = eqNote('Введите название модели', 'warn'); return; }
    try {
      const created = await Api.post('/api/equipment/models', { category_id: cid, name });
      await eqLoadMeta();
      f.elements.newModel.value = '';
      fillModels(created.id);
      $('#eqReceiveMsg').innerHTML = eqNote(`Модель «${name}» добавлена`, 'ok');
    } catch (err) { $('#eqReceiveMsg').innerHTML = eqNote(err.message, 'err'); }
  };
  f.onsubmit = async (e) => {
    e.preventDefault();
    const serials = f.elements.serials.value.split(/[\r\n;,]+/).map((s) => s.trim()).filter(Boolean);
    try {
      const r = await Api.post('/api/equipment/receive', {
        model_id: +f.elements.model.value, serial_numbers: serials, received_date: f.elements.date.value || null, notes: f.elements.notes.value.trim() || null,
      });
      let text = `Оприходовано: ${r.created.length}`;
      if (r.duplicates.length) text += `\nУже есть в базе (пропущено): ${r.duplicates.join(', ')}`;
      $('#eqReceiveMsg').innerHTML = eqNote(text, r.created.length ? 'ok' : 'warn');
      if (r.created.length) { f.elements.serials.value = r.duplicates.join('\n'); await eqReloadItems?.(); }
    } catch (err) { $('#eqReceiveMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}

// -------- карточка единицы

async function eqItemCard(id, { back } = {}) {
  let it;
  try { await eqLoadMeta(); it = await Api.get('/api/equipment/items/' + id); } catch (e) { alert(e.message); return; }
  const row = (k, v) => (v ? `<div class="flex gap-2 text-xs"><span class="w-40 shrink-0 text-slate-500">${esc(k)}</span><span class="min-w-0">${v}</span></div>` : '');
  const prov = [];
  if (it.removed_date || it.removed_by || it.removed_point_id) {
    prov.push(row('Снято', `${esc(fmtDate(it.removed_date))}${it.removed_by ? ' · ' + esc(it.removed_by) : ''}${it.removed_point_id ? ' · с комплекса «' + esc(it.removed_point_id) + '»' : ''}`));
  }
  if (it.removal_reason) prov.push(row('Причина снятия', `<b class="text-amber-300">${esc(it.removal_reason)}</b>`));
  if (it.accepted_date || it.accepted_by) prov.push(row('Принято на склад', `${esc(fmtDate(it.accepted_date))}${it.accepted_by ? ' · ' + esc(it.accepted_by) : ''}`));
  const today = new Date().toISOString().slice(0, 10);
  // Дополнительные поля: общие и относящиеся к категории единицы + те, что уже заполнены.
  const filled = new Map((it.extra || []).map((e) => [e.field_id, e.value]));
  const fieldDefs = (EQ.meta.fields || []).filter((f) => !f.category_id || f.category_id === it.category_id || filled.has(f.id));
  const isSim = it.category_kind === 'sim';
  const canStatus = it.place === 'stock';
  modal(`<h2 class="font-display text-lg font-bold mb-1">№ ${esc(it.serial_number)}</h2>
    <p class="text-xs text-slate-400 mb-3">${esc(it.category_name)} · ${esc(it.model_name)} &nbsp; ${eqStatusBadge(it)}
      &nbsp;<button data-perm="warehouse.edit" id="eqCardRename" class="${btnGhost} !py-0.5 !px-2 text-[11px]" title="Номер был записан неверно — исправить, история сохранится">✏️ Исправить номер</button></p>
    ${isSim ? '<p class="text-[11px] text-slate-500 mb-3">SIM-карта: номер — последние 7 цифр номера с карты. Если она стоит на комплексе, поле «Номер SIM» комплекса меняется вместе с ней.</p>' : ''}
    <div class="space-y-1.5 mb-4">
      ${row('Где', `${esc(eqPlaceTitle[it.place])}${it.place === 'person' ? ': ' + eqWhere(it) : it.place === 'unknown' ? (it.removed_point_id ? ' (числилось на «' + esc(it.removed_point_id) + '»)' : '') : it.place === 'point' ? ': <b>' + esc(it.point_id) + '</b>' + (it.point_address ? ' · ' + esc(it.point_address) : '') : ''}`)}
      ${row('Принято', esc(fmtDate(it.received_date)))}
      ${it.place === 'person' && it.issued_date ? row('Выдано', esc(fmtDate(it.issued_date))) : ''}
      ${it.place === 'point' ? row('Установлено', `${esc(fmtDate(it.installed_date))}${it.installed_by ? ' · ' + esc(it.installed_by) : ''}`) : ''}
      ${prov.join('')}
    </div>
    ${it.place === 'unknown' ? `<div class="mb-3">${eqNote('Это оборудование числилось в другом месте, но фактически там было другое: где оно сейчас, неизвестно.' + (it.removed_point_id ? ' Числилось на комплексе «' + it.removed_point_id + '».' : '') + ' Когда найдётся — нажмите «Нашлось».', 'warn')}</div>` : ''}
    <div class="flex flex-wrap gap-2 mb-4">
      ${it.place === 'person' ? `<button data-perm="warehouse.edit" id="eqCardAccept" class="${btnPrimary} !py-1.5 text-xs">${it.awaiting_accept ? 'Принять на склад (снятое)' : 'Вернуть на склад'}</button>` : ''}
      ${it.place === 'point' ? `<button id="eqCardPoint" class="${btnGhost} !py-1.5 text-xs">Открыть комплекс «${esc(it.point_id)}»</button>` : ''}
      ${it.place === 'unknown' ? `<button data-perm="warehouse.edit" id="eqCardFound" class="${btnPrimary} !py-1.5 text-xs">Нашлось — вернуть на склад</button>` : ''}
      ${it.place === 'stock' || it.place === 'unknown' ? `<button data-perm="warehouse.edit" id="eqCardDelete" class="${btnDanger} !py-1.5 text-xs">Удалить из базы</button>` : ''}
    </div>
    ${canStatus ? `<form data-perm="warehouse.edit" id="eqStatusForm" class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 space-y-2 mb-4">
      <b class="text-xs">Сменить состояние</b>
      <div class="grid grid-cols-2 gap-2">
        <select name="status" class="${fieldCls}">${eqOptions(EQ.meta.statuses, 'id', (s) => s.name + (s.usable ? '' : ' (не годится для выдачи)'), it.status_id)}</select>
        <input name="comment" placeholder="Комментарий (необязательно)" class="${fieldCls}">
      </div>
      <button class="${btnGhost} !py-1.5 text-xs">Сменить</button>
    </form>` : `<p class="text-[11px] text-slate-500 mb-4">Состояние меняется у оборудования на складе. ${it.place === 'point' ? 'Сначала снимите его с комплекса.' : 'Сначала примите его от монтёра.'}</p>`}
    <form data-perm="warehouse.edit" id="eqNotesForm" class="mb-4 space-y-2">
      <label class="${labelCls}">Примечание<textarea name="notes" rows="2" class="${fieldCls}">${esc(it.notes || '')}</textarea></label>
      ${fieldDefs.length ? `<div class="grid grid-cols-2 gap-2 pt-1">${fieldDefs.map((f) => `<label class="${labelCls}">${esc(f.name)}<input data-eqextra="${f.id}" value="${esc(filled.get(f.id) || '')}" class="${fieldCls}"></label>`).join('')}</div>` : ''}
      <button class="${btnGhost} !py-1.5 text-xs">Сохранить</button>
      <span class="text-[11px] text-slate-500">${(EQ.meta.fields || []).length ? '' : 'Дополнительные поля (IMEI, MAC, гарантия…) заводятся во вкладке «Отчёты и справочники».'}</span>
    </form>
    <b class="text-xs block mb-2">История</b>
    <div class="space-y-1 max-h-56 overflow-auto mb-3">${it.history.map((h) => `<div class="rounded-lg border border-slate-700/40 bg-slate-800/20 px-2.5 py-1.5 text-xs">
      <span class="text-slate-500">${esc(fmtDate(h.event_date || h.ts))}</span> · <b>${esc(h.action_type)}</b>${h.point_id ? ' · ' + esc(h.point_id) : ''}${h.person_name ? ' · ' + esc(h.person_name) : ''}
      ${h.comment ? `<br><span class="text-slate-400">${esc(h.comment)}</span>` : ''}${h.performed_by ? `<br><span class="text-slate-600">${esc(h.performed_by)}</span>` : ''}
    </div>`).join('') || '<p class="text-xs text-slate-500">Записей нет</p>'}</div>
    <form data-perm="warehouse.edit" id="eqHistNote" class="flex flex-wrap items-end gap-2 mb-4">
      <label class="${labelCls} flex-1 min-w-[160px]">Добавить запись в историю<input name="comment" placeholder="Что было сделано" class="${fieldCls}"></label>
      <label class="${labelCls}">Дата<input type="date" name="date" value="${today}" class="${fieldCls}"></label>
      <button class="${btnGhost} !py-2 text-xs">Добавить</button>
    </form>
    <div id="eqCardMsg" class="mb-3"></div>
    <div class="flex"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
  eqWide('max-w-2xl');
  const reopen = () => eqItemCard(id, { back });
  const fail = (err) => { $('#eqCardMsg').innerHTML = eqNote(err.message, 'err'); };
  if ($('#eqStatusForm')) {
    $('#eqStatusForm').onsubmit = async (e) => {
      e.preventDefault();
      try { await Api.post(`/api/equipment/items/${id}/set-status`, { status_id: +e.target.elements.status.value, comment: e.target.elements.comment.value.trim() || null }); await reopen(); } catch (err) { fail(err); }
    };
  }
  $('#eqNotesForm').onsubmit = async (e) => {
    e.preventDefault();
    const extra = {};
    e.target.querySelectorAll('[data-eqextra]').forEach((inp) => { extra[inp.dataset.eqextra] = inp.value.trim(); });
    try { await Api.put('/api/equipment/items/' + id, { notes: e.target.elements.notes.value.trim() || null, extra }); await reopen(); } catch (err) { fail(err); }
  };
  $('#eqCardRename').onclick = async () => {
    const next = prompt(isSim ? 'Правильный номер SIM-карты (можно полный номер — сохранятся последние 7 цифр):' : 'Правильный серийный номер:', it.serial_number);
    if (next === null || !next.trim() || next.trim() === it.serial_number) return;
    try { await Api.post(`/api/equipment/items/${id}/rename`, { serial_number: next.trim() }); await reopen(); } catch (err) { fail(err); }
  };
  $('#eqHistNote').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.comment.value.trim()) { fail(new Error('Опишите, что было сделано')); return; }
    try { await Api.post(`/api/equipment/items/${id}/note`, { comment: f.comment.value.trim(), date: f.date.value || null }); await reopen(); } catch (err) { fail(err); }
  };
  if ($('#eqCardAccept')) {
    $('#eqCardAccept').onclick = async () => {
      try { const r = await Api.post('/api/equipment/accept', { equipment_ids: [id] }); if (r.skipped.length) throw new Error(eqSkippedText(r.skipped)); await reopen(); } catch (err) { fail(err); }
    };
  }
  if ($('#eqCardPoint')) $('#eqCardPoint').onclick = () => eqPointCard(it.point_id);
  if ($('#eqCardFound')) {
    $('#eqCardFound').onclick = async () => {
      try { await Api.post(`/api/equipment/items/${id}/found`, {}); await reopen(); } catch (err) { fail(err); }
    };
  }
  if ($('#eqCardDelete')) {
    $('#eqCardDelete').onclick = async () => {
      if (!confirm(`Удалить №${it.serial_number} из базы? Это нельзя отменить.`)) return;
      try { await Api.del('/api/equipment/items/' + id); close(); } catch (err) { fail(err); }
    };
  }
}

// ======================================================================= вкладка «Выдача и приём»

const eqIssue = { person: '', date: '', comment: '', chosen: new Map() };

async function renderIssueTab() {
  try { await eqLoadMeta(); } catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`; return; }
  if (!eqIssue.date) eqIssue.date = new Date().toISOString().slice(0, 10);
  $('#content').innerHTML = `
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-6">
      <h2 class="font-display text-base font-bold mb-3">Выдать монтёру</h2>
      <div class="grid grid-cols-2 gap-3 mb-3">
        <div class="${labelCls} relative">Монтёр
          <div id="isPersonChosen" class="hidden"></div>
          <input id="isPersonSearch" placeholder="Начните вводить фамилию или имя…" autocomplete="off" class="${fieldCls}">
          <div id="isPersonList" class="hidden absolute left-0 right-0 top-full mt-1 z-10 rounded-xl border border-slate-700 bg-slate-900 shadow-xl max-h-56 overflow-auto p-1 space-y-0.5"></div>
        </div>
        <label class="${labelCls}">Дата выдачи<input id="isDate" type="date" value="${esc(eqIssue.date)}" class="${fieldCls}"></label>
      </div>
      <label class="${labelCls} mb-1">Оборудование — поиск на складе по серийному номеру, модели или категории <span class="font-normal">(только годное к выдаче)</span></label>
      <div class="grid grid-cols-3 gap-2">
        <select id="isCat" class="${fieldCls}">${eqOptions(EQ.meta.categories, 'id', 'name', '', 'Все категории')}</select>
        <input id="isSearch" placeholder="Серийный номер или модель…" autocomplete="off" class="${fieldCls} col-span-2">
      </div>
      <div id="isResults" class="mt-2 space-y-1 max-h-48 overflow-auto"></div>
      <div id="isChips" class="flex flex-wrap gap-1.5 mt-3"></div>
      <label class="${labelCls} mt-3">Комментарий<input id="isComment" value="${esc(eqIssue.comment)}" class="${fieldCls}"></label>
      <div id="isMsg" class="mt-3"></div>
      <div class="mt-3"><button id="isSubmit" class="${btnPrimary}">Выдать</button></div>
    </section>
    <section>
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="font-display text-base font-bold">Оборудование на монтёрах</h2>
        <div class="flex gap-2">
          <select id="onFilter" class="${fieldCls} !w-auto"><option value="">Все монтёры</option></select>
          <button id="onExport" class="${btnGhost} !py-1.5 text-xs">Excel</button>
        </div>
      </div>
      <div id="onList"></div>
    </section>`;
  const paintChips = () => {
    $('#isChips').innerHTML = [...eqIssue.chosen.values()].map((it) => `<span class="inline-flex items-center gap-1.5 rounded-full bg-indigo-500/15 border border-indigo-400/30 text-indigo-200 text-xs px-2.5 py-1">
      ${esc(it.serial_number)} <span class="text-slate-400">${esc(it.model_name)}</span><button data-unchoose="${it.id}" class="text-slate-400 hover:text-rose-300">✕</button></span>`).join('')
      || '<span class="text-xs text-slate-500">Ничего не выбрано</span>';
    $('#isChips').querySelectorAll('[data-unchoose]').forEach((b) => { b.onclick = () => { eqIssue.chosen.delete(+b.dataset.unchoose); paintChips(); runSearch(); }; });
  };
  const runSearch = async () => {
    const p = new URLSearchParams({ place: 'stock', usable: 'true', limit: '15' });
    if ($('#isSearch').value.trim()) p.set('search', $('#isSearch').value.trim());
    if ($('#isCat').value) p.set('category_id', $('#isCat').value);
    let list = [];
    try { list = await Api.get('/api/equipment/items?' + p); } catch { return; }
    list = list.filter((i) => !eqIssue.chosen.has(i.id));
    $('#isResults').innerHTML = list.map((i) => `<button type="button" data-choose="${i.id}" class="w-full text-left rounded-lg border border-slate-700/50 bg-slate-800/30 hover:bg-slate-700/40 px-3 py-1.5 text-xs">
      <b>${esc(i.serial_number)}</b> · ${esc(i.category_name)} · ${esc(i.model_name)} ${eqStatusBadge(i)}</button>`).join('')
      || '<p class="text-xs text-slate-500">На складе нет подходящего оборудования</p>';
    $('#isResults').querySelectorAll('[data-choose]').forEach((b) => {
      b.onclick = () => { const it = list.find((x) => x.id === +b.dataset.choose); eqIssue.chosen.set(it.id, it); paintChips(); runSearch(); };
    });
  };
  $('#isSearch').oninput = eqDebounce(runSearch);
  $('#isCat').onchange = runSearch;
  // Монтёр: поиск по части ФИО среди монтёров персонала (водители, операторы и склад не показываются).
  const paintPerson = () => {
    const chosen = eqFitters().find((p) => String(p.id) === String(eqIssue.person));
    $('#isPersonChosen').classList.toggle('hidden', !chosen);
    $('#isPersonSearch').classList.toggle('hidden', !!chosen);
    $('#isPersonList').classList.add('hidden');
    if (chosen) {
      $('#isPersonChosen').innerHTML = `<span class="inline-flex items-center gap-2 rounded-xl border border-indigo-400/40 bg-indigo-500/10 px-3 py-2 text-sm text-indigo-100">${esc(chosen.full_name)}${chosen.phone ? ` <span class="text-xs text-slate-400">${esc(chosen.phone)}</span>` : ''}
        <button type="button" id="isPersonClear" class="text-slate-400 hover:text-rose-300" title="Выбрать другого">✕</button></span>`;
      $('#isPersonClear').onclick = () => { eqIssue.person = ''; $('#isPersonSearch').value = ''; paintPerson(); $('#isPersonSearch').focus(); showMatches(); };
    }
  };
  const showMatches = () => {
    const q = $('#isPersonSearch').value.trim();
    const all = eqFitters().filter((p) => eqNameMatch(p.full_name, q));
    const list = all.slice(0, 10);
    $('#isPersonList').innerHTML = list.map((p) => `<button type="button" data-pickperson="${p.id}" class="w-full text-left rounded-lg hover:bg-slate-800 px-3 py-1.5 text-sm">${esc(p.full_name)}${p.phone ? ` <span class="text-xs text-slate-500">${esc(p.phone)}</span>` : ''}</button>`).join('')
      + (all.length > list.length ? `<p class="px-3 py-1 text-[11px] text-slate-500">…ещё ${all.length - list.length} — уточните поиск</p>` : '')
      || '<p class="px-3 py-2 text-xs text-slate-500">Монтёров с таким именем нет</p>';
    $('#isPersonList').classList.remove('hidden');
    $('#isPersonList').querySelectorAll('[data-pickperson]').forEach((b) => {
      b.onmousedown = (e) => { e.preventDefault(); eqIssue.person = b.dataset.pickperson; paintPerson(); };
    });
  };
  $('#isPersonSearch').oninput = showMatches;
  $('#isPersonSearch').onfocus = showMatches;
  $('#isPersonSearch').onblur = () => setTimeout(() => $('#isPersonList').classList.add('hidden'), 150);
  $('#isPersonSearch').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); $('#isPersonList [data-pickperson]')?.onmousedown?.(new Event('mousedown')); }
    if (e.key === 'Escape') $('#isPersonList').classList.add('hidden');
  };
  paintPerson();
  $('#isDate').onchange = (e) => { eqIssue.date = e.target.value; };
  $('#isComment').oninput = (e) => { eqIssue.comment = e.target.value; };
  $('#isSearch').onkeydown = (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault(); $('#isResults [data-choose]')?.click();
  };
  $('#isSubmit').onclick = async () => {
    if (!eqIssue.person) { $('#isMsg').innerHTML = eqNote('Выберите монтёра', 'warn'); return; }
    if (!eqIssue.chosen.size) { $('#isMsg').innerHTML = eqNote('Выберите оборудование', 'warn'); return; }
    try {
      const r = await Api.post('/api/equipment/issue', { person_id: +eqIssue.person, equipment_ids: [...eqIssue.chosen.keys()], date: eqIssue.date || null, comment: eqIssue.comment.trim() || null });
      eqIssue.chosen.clear();
      await renderIssueTab();
      $('#isMsg').innerHTML = eqNote(`Выдано: ${r.issued.length}${r.skipped.length ? '\nНе выдано:\n' + eqSkippedText(r.skipped) : ''}`, r.issued.length ? 'ok' : 'warn');
    } catch (err) { $('#isMsg').innerHTML = eqNote(err.message, 'err'); }
  };
  $('#onFilter').onchange = (e) => paintOnPeople(e.target.value);
  $('#onExport').onclick = () => downloadFile('/api/equipment/export/people.xlsx' + ($('#onFilter').value ? '?person_id=' + $('#onFilter').value : '')).catch((e) => alert(e.message));
  paintChips(); runSearch();
  await paintOnPeople('');
}

async function paintOnPeople(personId) {
  const box = $('#onList');
  let groups;
  try { groups = await Api.get('/api/equipment/people-summary' + (personId ? '?person_id=' + personId : '')); } catch (e) { box.innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  if (!groups.length) { box.innerHTML = '<p class="text-sm text-slate-500 text-center py-6">Ни на ком ничего не числится</p>'; return; }
  box.innerHTML = groups.map((g) => `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-3 mb-3" data-person="${g.person_id}">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
      <b class="text-sm">${esc(g.full_name)}</b>
      <span class="text-xs text-slate-400">всего ${g.count}${g.awaiting ? ` · <span class="text-amber-300">снято, ждёт приёмки: ${g.awaiting}</span>` : ''}${g.kept ? ` · <span class="text-sky-300" title="Сдавать на склад не обязательно">снятые SIM у монтёра: ${g.kept}</span>` : ''}</span>
    </div>
    <div class="space-y-1">${g.items.map((it) => `<label class="flex items-center gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-2.5 py-1.5 text-xs cursor-pointer">
      <input type="checkbox" data-acc="${it.id}" class="rounded accent-indigo-500" ${it.awaiting_accept ? 'checked' : ''}>
      <b>${esc(it.serial_number)}</b><span class="text-slate-400">${esc(it.category_name)} · ${esc(it.model_name)}</span>
      ${it.awaiting_accept ? `<span class="text-amber-300">снято${it.removed_point_id ? ' с ' + esc(it.removed_point_id) : ''}${it.removal_reason ? ' · ' + esc(it.removal_reason) : ''}</span> ${eqStatusBadge(it)}` : it.kept ? `<span class="text-sky-300">снятая SIM${it.removed_point_id ? ' с ' + esc(it.removed_point_id) : ''}${it.removal_reason ? ' · ' + esc(it.removal_reason) : ''} · остаётся у монтёра</span> ${eqStatusBadge(it)}` : `<span class="text-slate-500">выдано ${esc(fmtDate(it.issued_date))}</span>`}
      <button data-perm="warehouse.edit" type="button" data-subst="${it.id}" class="${btnGhost} !py-0.5 !px-2 text-[11px] ml-auto whitespace-nowrap" title="Монтёр сдал оборудование с другим номером">🔁 Другой номер</button>
    </label>`).join('')}</div>
    <div class="flex flex-wrap items-center gap-2 mt-3">
      <select data-accstatus class="${fieldCls} !w-auto !py-1 text-xs">${eqOptions(EQ.meta.statuses, 'id', 'name', '', 'Состояние после приёмки: как есть')}</select>
      <input data-acccomment placeholder="Комментарий" class="${fieldCls} !py-1 flex-1 min-w-[140px] text-xs">
      <button data-perm="warehouse.edit" data-accept class="${btnPrimary} !py-1.5 !px-3 text-xs">Принять выбранное на склад</button>
    </div>
    <div data-accmsg class="mt-2"></div>
  </div>`).join('');
  if (!personId && $('#onFilter')) {
    const cur = $('#onFilter').value;
    $('#onFilter').innerHTML = '<option value="">Все монтёры</option>' + groups.map((g) => `<option value="${g.person_id}" ${String(g.person_id) === cur ? 'selected' : ''}>${esc(g.full_name)}</option>`).join('');
  }
  box.querySelectorAll('[data-subst]').forEach((b) => {
    b.onclick = (e) => {
      e.preventDefault(); e.stopPropagation();
      const item = groups.flatMap((g) => g.items).find((x) => x.id === +b.dataset.subst);
      eqSubstituteForm(item);
    };
  });
  box.querySelectorAll('[data-person]').forEach((card) => {
    card.querySelector('[data-accept]').onclick = async () => {
      const ids = [...card.querySelectorAll('[data-acc]:checked')].map((c) => +c.dataset.acc);
      if (!ids.length) { card.querySelector('[data-accmsg]').innerHTML = eqNote('Отметьте, что принять', 'warn'); return; }
      const sid = card.querySelector('[data-accstatus]').value;
      try {
        const r = await Api.post('/api/equipment/accept', { equipment_ids: ids, status_id: sid ? +sid : null, comment: card.querySelector('[data-acccomment]').value.trim() || null });
        await paintOnPeople($('#onFilter').value);
        alert(`Принято на склад: ${r.accepted.length}${r.skipped.length ? '\nПропущено:\n' + eqSkippedText(r.skipped) : ''}`);
      } catch (err) { card.querySelector('[data-accmsg]').innerHTML = eqNote(err.message, 'err'); }
    };
  });
}


// ======================================================================= «стоит / сдан другой номер»

// Поиск оборудования, которое РЕАЛЬНО стояло (или сдано), если номер не тот, что числится в системе.
// `collapsible` — сворачиваемый блок в формах снятия/замены; иначе блок открыт сразу.
function eqFinderHtml(prefix, { expectedSerial, collapsible = true } = {}) {
  const body = `<div class="space-y-2 ${collapsible ? 'mt-2' : ''}">
      <input data-fsearch placeholder="Номер оборудования, которое было на самом деле (часть номера)" autocomplete="off" class="${fieldCls}">
      <div data-fresults class="space-y-1 max-h-40 overflow-auto"></div>
      <div data-fpicked class="text-xs text-slate-500">Не выбрано</div>
      <label class="flex items-start gap-1.5 text-xs text-slate-300"><input type="checkbox" data-fcreate class="rounded accent-indigo-500 mt-0.5"> такого номера нет в базе — записать его как новое оборудование (модель как у №${esc(expectedSerial || '')})</label>
      <p class="text-[11px] text-slate-500">Выбранное считается снятым (сданным) на самом деле, а №${esc(expectedSerial || '')} получает пометку «неизвестное местонахождение».</p>
    </div>`;
  return collapsible
    ? `<details data-finder="${prefix}" class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3"><summary class="cursor-pointer text-xs font-medium text-amber-300">🔁 Стоял другой номер?</summary>${body}</details>`
    : `<div data-finder="${prefix}" class="rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">${body}</div>`;
}

function wireEqFinder(root, prefix, excludeId) {
  const box = root.querySelector(`[data-finder="${prefix}"]`);
  const state = { picked: null };
  const input = box.querySelector('[data-fsearch]');
  const results = box.querySelector('[data-fresults]');
  const paint = () => {
    box.querySelector('[data-fpicked]').innerHTML = state.picked
      ? `Выбрано: <b class="text-indigo-300">№${esc(state.picked.serial_number)}</b> <span class="text-slate-400">${esc(state.picked.category_name)} · ${esc(state.picked.model_name)} · ${esc(eqPlaceTitle[state.picked.place])}</span>`
      : 'Не выбрано';
  };
  const run = async () => {
    const q = input.value.trim();
    state.picked = null; paint();
    if (!q) { results.innerHTML = ''; return; }
    let list = [];
    try { list = await Api.get('/api/equipment/items?limit=15&search=' + encodeURIComponent(q)); } catch { return; }
    list = list.filter((i) => i.id !== excludeId);
    results.innerHTML = list.map((i) => `<button type="button" data-fpick="${i.id}" class="w-full text-left rounded-lg border border-slate-700/50 bg-slate-800/30 hover:bg-slate-700/40 px-3 py-1.5 text-xs">
      <b>${esc(i.serial_number)}</b> · ${esc(i.category_name)} · ${esc(i.model_name)} · <span class="text-slate-400">${esc(eqPlaceTitle[i.place])}${i.place === 'point' ? ' ' + esc(i.point_id) : i.place === 'person' ? ' ' + esc(i.person_name || '') : ''}</span> ${eqStatusBadge(i)}</button>`).join('')
      || '<p class="text-xs text-slate-500">Такого номера в базе нет — отметьте «записать как новое», если оно действительно было.</p>';
    results.querySelectorAll('[data-fpick]').forEach((b) => {
      b.onclick = () => { state.picked = list.find((x) => x.id === +b.dataset.fpick); paint(); };
    });
  };
  input.oninput = eqDebounce(run);
  input.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); results.querySelector('[data-fpick]')?.click(); } };
  // Что отправить на сервер: выбранная единица, либо набранный номер (+ создать, если разрешили).
  state.payload = () => {
    if (state.picked) return { actual_equipment_id: state.picked.id };
    const typed = input.value.trim();
    if (!typed) return {};
    return { actual_serial: typed, create_missing: box.querySelector('[data-fcreate]').checked };
  };
  return state;
}

// Монтёр сдал оборудование с другим номером, чем числится на нём (по системе — `item`).
function eqSubstituteForm(item) {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Сдан другой номер</h2>
    <p class="text-sm mb-3">По системе на <b>${esc(item.person_name || 'монтёре')}</b> числится
      <b>№ ${esc(item.serial_number)}</b> <span class="text-slate-400">${esc(item.category_name)} · ${esc(item.model_name)}</span>${item.removed_point_id ? ` (снято с «${esc(item.removed_point_id)}»)` : ''}.</p>
    <form id="subForm" class="space-y-3">
      ${eqFinderHtml('sub', { expectedSerial: item.serial_number, collapsible: false })}
      <label class="${labelCls}">Состояние принятого<select name="status" class="${fieldCls}">${eqOptions(EQ.meta.statuses, 'id', 'name', '', item.awaiting_accept ? 'Дефектное (как у снятого)' : 'Как есть')}</select></label>
      <label class="${labelCls}">Комментарий<input name="comment" class="${fieldCls}"></label>
      <div id="subMsg"></div>
      <div class="flex gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Принять этот номер</button></div>
    </form>`);
  eqWide('max-w-xl');
  const finder = wireEqFinder($('#subForm'), 'sub', item.id);
  $('#subForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements; const pl = finder.payload();
    if (!pl.actual_equipment_id && !pl.actual_serial) { $('#subMsg').innerHTML = eqNote('Найдите или введите номер, который сдал монтёр', 'warn'); return; }
    try {
      const r = await Api.post('/api/equipment/accept-substitute', { expected_id: item.id, ...pl, status_id: f.status.value ? +f.status.value : null, comment: f.comment.value.trim() || null });
      close();
      alert(`Принято на склад: №${r.accepted}.\n№${r.unknown} помечен как «неизвестное местонахождение».`);
    } catch (err) { $('#subMsg').innerHTML = eqNote(err.message, 'err'); }
  };
}
