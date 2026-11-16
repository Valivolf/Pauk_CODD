// Склад: вкладки «История» и «Отчёты и справочники» (остатки, оборудование на монтёрах, выгрузки,
// справочники категорий / моделей / состояний, импорт базы прежнего «Склада»). Помощники — equipment.js.

// ======================================================================= «История»

const eqHist = { q: '', action: '', from: '', to: '', limit: 200 };

async function renderHistoryTab() {
  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <input id="hiSearch" value="${esc(eqHist.q)}" placeholder="Серийный номер, комплекс, монтёр, комментарий…" class="${fieldCls} flex-1 min-w-[220px]">
      <select id="hiAction" class="${fieldCls} !w-auto"><option value="">Все операции</option></select>
      <input id="hiFrom" type="date" value="${esc(eqHist.from)}" title="Дата с" class="${fieldCls} !w-auto">
      <input id="hiTo" type="date" value="${esc(eqHist.to)}" title="Дата по" class="${fieldCls} !w-auto">
      <button id="hiExport" class="${btnGhost} !px-4">Excel</button>
      <button data-perm="warehouse.edit" id="hiDelete" class="${btnDanger} !px-4">Удалить по фильтру</button>
    </div>
    <div id="hiSummary" class="text-xs text-slate-500 mb-2"></div>
    <div id="hiList"></div>`;
  $('#hiSearch').oninput = eqDebounce(() => { eqHist.q = $('#hiSearch').value.trim(); eqHist.limit = 200; eqReloadHistory(); });
  $('#hiAction').onchange = (e) => { eqHist.action = e.target.value; eqHist.limit = 200; eqReloadHistory(); };
  $('#hiFrom').onchange = (e) => { eqHist.from = e.target.value; eqReloadHistory(); };
  $('#hiTo').onchange = (e) => { eqHist.to = e.target.value; eqReloadHistory(); };
  const q = () => new URLSearchParams({ ...(eqHist.q && { search: eqHist.q }), ...(eqHist.action && { action_type: eqHist.action }), ...(eqHist.from && { date_from: eqHist.from }), ...(eqHist.to && { date_to: eqHist.to }) }).toString();
  $('#hiExport').onclick = () => downloadFile('/api/equipment/export/history.xlsx?' + q()).catch((e) => alert(e.message));
  $('#hiDelete').onclick = async () => {
    if (!q()) { alert('Задайте период, операцию или поиск — без фильтра журнал не удаляется.'); return; }
    if (!confirm('Удалить ВСЕ записи журнала, подходящие под текущий фильтр? Это нельзя отменить.')) return;
    try { const r = await Api.del('/api/equipment/history?' + q()); alert('Удалено записей: ' + r.deleted); await eqReloadHistory(); } catch (e) { alert(e.message); }
  };
  await eqReloadHistory();
}

async function eqReloadHistory() {
  const box = $('#hiList');
  if (!box) return;
  const p = new URLSearchParams({ limit: String(eqHist.limit) });
  if (eqHist.q) p.set('search', eqHist.q);
  if (eqHist.action) p.set('action_type', eqHist.action);
  if (eqHist.from) p.set('date_from', eqHist.from);
  if (eqHist.to) p.set('date_to', eqHist.to);
  let r;
  try { r = await Api.get('/api/equipment/history?' + p); } catch (e) { box.innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  const sel = $('#hiAction');
  if (sel && sel.options.length <= 1) sel.innerHTML = '<option value="">Все операции</option>' + r.action_types.map((a) => `<option value="${esc(a)}" ${a === eqHist.action ? 'selected' : ''}>${esc(a)}</option>`).join('');
  $('#hiSummary').textContent = r.items.length ? `Показано ${r.items.length} из ${r.total}` : '';
  if (!r.items.length) { box.innerHTML = '<p class="text-sm text-slate-500 text-center py-8">Записей нет</p>'; return; }
  box.innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm">
    <thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60"><th class="py-2 pr-3">Дата</th><th class="py-2 pr-3">Операция</th><th class="py-2 pr-3">Оборудование</th><th class="py-2 pr-3">Комплекс</th><th class="py-2 pr-3">Монтёр</th><th class="py-2 pr-3">Выполнил</th><th class="py-2 pr-3">Комментарий</th><th></th></tr></thead>
    <tbody>${r.items.map((h) => `<tr class="border-b border-slate-800/80 align-top">
      <td class="py-2 pr-3 text-xs whitespace-nowrap">${esc(fmtDate(h.event_date || h.ts))}</td><td class="py-2 pr-3 text-xs font-semibold">${esc(h.action_type)}</td>
      <td class="py-2 pr-3 text-xs">${h.serial_number ? '<b>' + esc(h.serial_number) + '</b>' : ''}${h.model_name ? '<br><span class="text-slate-400">' + esc(h.model_name) + '</span>' : ''}</td>
      <td class="py-2 pr-3 text-xs">${esc(h.point_id || '')}</td><td class="py-2 pr-3 text-xs">${esc(h.person_name || '')}</td>
      <td class="py-2 pr-3 text-xs text-slate-400">${esc(h.performed_by || '')}</td><td class="py-2 pr-3 text-xs text-slate-400">${esc(h.comment || '')}</td>
      <td class="py-2 text-right whitespace-nowrap"><button data-perm="warehouse.edit" data-hedit="${h.id}" class="${btnGhost} !py-0.5 !px-2 text-xs">✎</button> <button data-perm="warehouse.edit" data-hdel="${h.id}" class="${btnDanger} !py-0.5 !px-2 text-xs">✕</button></td></tr>`).join('')}</tbody></table></div>
    ${r.items.length < r.total ? `<div class="text-center pt-3"><button id="hiMore" class="${btnGhost} text-xs">Показать ещё</button></div>` : ''}`;
  if ($('#hiMore')) $('#hiMore').onclick = () => { eqHist.limit += 200; eqReloadHistory(); };
  box.querySelectorAll('[data-hdel]').forEach((b) => {
    b.onclick = async () => { if (!confirm('Удалить эту запись журнала?')) return; try { await Api.del('/api/equipment/history/' + b.dataset.hdel); await eqReloadHistory(); } catch (e) { alert(e.message); } };
  });
  box.querySelectorAll('[data-hedit]').forEach((b) => {
    b.onclick = () => {
      const h = r.items.find((x) => x.id === +b.dataset.hedit);
      modal(`<h2 class="font-display text-lg font-bold mb-1">Запись журнала</h2>
        <p class="text-xs text-slate-400 mb-3">${esc(h.action_type)}${h.serial_number ? ' · №' + esc(h.serial_number) : ''} — тип операции и ссылки не меняются, правятся только дата, комментарий и «выполнил».</p>
        <form id="heForm" class="space-y-3">
          <label class="${labelCls}">Дата события<input type="date" name="date" value="${esc((h.event_date || h.ts || '').slice(0, 10))}" class="${fieldCls}"></label>
          <label class="${labelCls}">Комментарий<input name="comment" value="${esc(h.comment || '')}" class="${fieldCls}"></label>
          <label class="${labelCls}">Выполнил<input name="by" value="${esc(h.performed_by || '')}" class="${fieldCls}"></label>
          <div id="heMsg"></div>
          <div class="flex gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Сохранить</button></div>
        </form>`);
      $('#heForm').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target.elements;
        try { await Api.put('/api/equipment/history/' + h.id, { event_date: f.date.value || null, comment: f.comment.value.trim() || null, performed_by: f.by.value.trim() || null }); close(); }
        catch (err) { $('#heMsg').innerHTML = eqNote(err.message, 'err'); }
      };
    };
  });
}

// ======================================================================= «Отчёты и справочники»

const eqRep = { category: '', status: '', from: '', to: '' };

async function renderReportsTab() {
  try { await eqLoadMeta(); } catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  const m = EQ.meta;
  $('#content').innerHTML = `
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-5">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3"><h2 class="font-display text-base font-bold">Остатки по категориям</h2>
        <button id="rpExport" class="${btnGhost} !py-1.5 text-xs">Excel</button></div>
      <div class="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3">
        <select id="rpCat" class="${fieldCls}">${eqOptions(m.categories, 'id', 'name', eqRep.category, 'Все категории')}</select>
        <select id="rpStatus" class="${fieldCls}">${eqOptions(m.statuses, 'id', 'name', eqRep.status, 'Любое состояние')}</select>
        <input id="rpFrom" type="date" value="${esc(eqRep.from)}" title="Дата с" class="${fieldCls}">
        <input id="rpTo" type="date" value="${esc(eqRep.to)}" title="Дата по" class="${fieldCls}">
      </div>
      <div id="rpMatrix"></div>
    </section>
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-5">
      <h2 class="font-display text-base font-bold mb-3">Выгрузки в Excel</h2>
      <div class="flex flex-wrap gap-2">
        <button data-xl="/api/equipment/export/items.xlsx" class="${btnGhost} text-xs">Всё оборудование</button>
        <button data-xl="/api/equipment/export/people.xlsx" class="${btnGhost} text-xs">Оборудование на монтёрах</button>
        <button data-xl="/api/equipment/export/points.xlsx?has_equipment=true" class="${btnGhost} text-xs">Комплексы и их оборудование</button>
        <button data-xl="/api/equipment/export/history.xlsx" class="${btnGhost} text-xs">Журнал</button>
        <button data-xl="/api/solar-panels/export.xlsx" class="${btnGhost} text-xs">Солнечные панели</button>
      </div>
    </section>
    <div class="grid md:grid-cols-2 gap-4 mb-5">
      <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4"><h2 class="font-display text-base font-bold mb-3">Категории оборудования</h2><div id="dcCats"></div></section>
      <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4"><h2 class="font-display text-base font-bold mb-3">Модели оборудования</h2><div id="dcModels"></div></section>
    </div>
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-5">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-1"><h2 class="font-display text-base font-bold">SIM-карты: один номер у нескольких комплексов</h2>
        <button id="simDupBtn" class="${btnGhost} !py-1.5 text-xs">Показать</button></div>
      <p class="text-xs text-slate-400 mb-2">Одна SIM стоит только в одном месте. Если один и тот же номер записан в карточках нескольких комплексов, в учёт оборудования он попадает один раз; остальные стоит исправить («Оборудование на комплексах» → комплекс → «✏️ Номер») или загрузить таблицу SIM-карт (вкладка «Импорт из Excel»).</p>
      <div id="simDupBox"></div>
    </section>
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-5">
      <h2 class="font-display text-base font-bold mb-1">Дополнительные поля оборудования</h2>
      <p class="text-xs text-slate-400 mb-3">Любая дополнительная информация по единице оборудования: IMEI, MAC-адрес, ICCID SIM-карты, дата гарантии, № накладной, № коробки… Поле можно сделать общим для всего оборудования или только для одной категории. Значения заполняются в карточке единицы и подхватываются из столбцов Excel при импорте (вкладка «Импорт из Excel»), попадают в выгрузки и поиск.</p>
      <div id="dcFields"></div>
    </section>
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-5">
      <h2 class="font-display text-base font-bold mb-1">Состояния оборудования</h2>
      <p class="text-xs text-slate-400 mb-3">Что склад может присвоить единице оборудования (в панели и в боте): «Отремонтировано», «Не подлежит восстановлению»… Добавляйте, переименовывайте, красьте и удаляйте свои. «Годно к выдаче» — можно ли выдавать и ставить на комплекс оборудование с таким состоянием. Два служебных нельзя удалить: «исправно» ставится при приёмке, «дефектное» — автоматически снятому с комплекса.</p>
      <div id="dcStatuses"></div>
    </section>
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4">
      <h2 class="font-display text-base font-bold mb-1">Импорт базы прежнего «Склада»</h2>
      <p class="text-xs text-slate-400 mb-3">Загрузите файл <b>warehouse.db</b> из приложения «Склад» (можно в архиве .gz) — в том числе с большим объёмом данных, чем при прошлом импорте. Комплексы сопоставятся с точками календаря (по инвентарному номеру, затем по названию), монтёры — с персоналом (нет — будут добавлены), оборудование — по серийному номеру. Сначала нажмите «Проверить»: ничего не запишется, вы увидите, что произойдёт.</p>
      <div class="grid md:grid-cols-2 gap-3 mb-3">
        <label class="${labelCls}">Файл базы<input type="file" id="imFile" accept=".db,.sqlite,.gz" class="${fieldCls}"></label>
        <label class="${labelCls}">Если оборудование с таким серийным номером уже есть
          <select id="imMode" class="${fieldCls}"><option value="merge">Не менять его место и состояние, только дополнить пустое</option><option value="overwrite">Заменить место и состояние данными из файла</option></select></label>
      </div>
      <label class="flex items-center gap-1.5 text-xs text-slate-300 mb-3"><input type="checkbox" id="imHist" checked class="rounded accent-indigo-500"> загрузить и журнал операций (повторы пропускаются)</label>
      <div class="flex flex-wrap gap-2 mb-3"><button data-perm="warehouse.edit" id="imCheck" class="${btnGhost}">Проверить</button><button data-perm="warehouse.edit" id="imRun" class="${btnPrimary}" disabled>Импортировать</button></div>
      <div id="imReport"></div>
    </section>`;
  const rq = () => ({ category_id: $('#rpCat').value, status_id: $('#rpStatus').value, date_from: $('#rpFrom').value, date_to: $('#rpTo').value });
  const qs = () => new URLSearchParams(Object.entries(rq()).filter(([, v]) => v)).toString();
  const loadMatrix = async () => {
    eqRep.category = $('#rpCat').value; eqRep.status = $('#rpStatus').value; eqRep.from = $('#rpFrom').value; eqRep.to = $('#rpTo').value;
    let s;
    try { s = await Api.get('/api/equipment/reports/summary?' + qs()); } catch (e) { $('#rpMatrix').innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
    if (!s.rows.length) { $('#rpMatrix').innerHTML = '<p class="text-sm text-slate-500">Оборудования нет</p>'; return; }
    $('#rpMatrix').innerHTML = `<div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60">
      <th class="py-2 pr-3">Категория</th>${s.columns.map((c) => `<th class="py-2 pr-3 text-center whitespace-nowrap"><span class="inline-block h-2 w-2 rounded-full mr-1" style="background:${esc(c.color)}"></span>${esc(c.label)}</th>`).join('')}<th class="py-2 text-center">Итого</th></tr></thead>
      <tbody>${s.rows.map((r) => `<tr class="border-b border-slate-800/80"><td class="py-1.5 pr-3 font-semibold">${esc(r.category)}</td>${s.columns.map((c) => `<td class="py-1.5 pr-3 text-center">${r.counts[c.key] || '<span class="text-slate-600">0</span>'}</td>`).join('')}<td class="py-1.5 text-center font-semibold">${r.total}</td></tr>`).join('')}
      <tr class="font-semibold"><td class="py-1.5 pr-3">Итого</td>${s.columns.map((c) => `<td class="py-1.5 pr-3 text-center">${s.totals[c.key] || 0}</td>`).join('')}<td class="py-1.5 text-center">${s.total}</td></tr></tbody></table></div>`;
  };
  ['rpCat', 'rpStatus', 'rpFrom', 'rpTo'].forEach((id) => { $('#' + id).onchange = loadMatrix; });
  $('#rpExport').onclick = () => downloadFile('/api/equipment/export/summary.xlsx?' + qs()).catch((e) => alert(e.message));
  $('#content').querySelectorAll('[data-xl]').forEach((b) => { b.onclick = () => downloadFile(b.dataset.xl).catch((e) => alert(e.message)); });
  $('#simDupBtn').onclick = async () => {
    const box = $('#simDupBox');
    box.innerHTML = eqNote('Ищу…');
    let d;
    try { d = await Api.get('/api/equipment/sim-duplicates'); } catch (e) { box.innerHTML = eqNote(e.message, 'err'); return; }
    if (!d.total_groups) { box.innerHTML = eqNote('Повторяющихся номеров SIM нет.', 'ok'); return; }
    box.innerHTML = `<p class="text-xs text-slate-400 mb-2">Номеров, повторяющихся у нескольких комплексов: <b>${d.total_groups}</b>, комплексов: <b>${d.total_points}</b>${d.groups.length < d.total_groups ? ` (показаны первые ${d.groups.length})` : ''}.</p>
      <div class="max-h-72 overflow-auto"><table class="w-full text-xs"><thead><tr class="text-left text-slate-400 border-b border-slate-700/60"><th class="py-1 pr-3">Номер SIM</th><th class="py-1">Комплексы (жирным — где SIM числится в учёте оборудования)</th></tr></thead>
      <tbody>${d.groups.map((g) => `<tr class="border-b border-slate-800/70 align-top"><td class="py-1 pr-3 font-semibold whitespace-nowrap">${esc(g.sim)}</td>
        <td class="py-1">${g.points.map((p) => `<button data-simdup="${esc(p.id)}" class="text-indigo-300 hover:underline ${p.id === g.installed_point ? 'font-bold' : ''}" title="${esc(p.address)}">${esc(p.id)}</button>`).join(' · ')}</td></tr>`).join('')}</tbody></table></div>`;
    box.querySelectorAll('[data-simdup]').forEach((b) => { b.onclick = () => eqPointCard(b.dataset.simdup); });
  };
  await loadMatrix();
  paintDictionaries();
  wireImport();
}

// ---------- справочники

async function paintDictionaries() {
  await eqLoadMeta();
  const m = EQ.meta;
  const reload = async () => { await paintDictionaries(); };
  const safe = (fn) => async (...a) => { try { await fn(...a); await reload(); } catch (e) { alert(e.message); } };

  $('#dcCats').innerHTML = `<div class="flex gap-2 mb-3"><input data-perm="warehouse.edit" id="dcCatName" placeholder="Новая категория" class="${fieldCls}"><button data-perm="warehouse.edit" id="dcCatAdd" class="${btnPrimary} !px-3">+</button></div>
    <div class="space-y-1 max-h-72 overflow-auto">${m.categories.map((c) => `<div class="flex items-center justify-between gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-1.5 text-sm">
      <span>${esc(c.name)} ${c.system ? '<span class="text-[10px] rounded-full bg-slate-700/60 text-slate-300 px-1.5 py-0.5" title="Служебная категория: её нельзя переименовать и удалить. SIM-карты комплексов учитываются в ней автоматически.">служебная</span>' : ''} <span class="text-xs text-slate-500">моделей: ${c.model_count} · ед.: ${c.equipment_count}</span></span>
      ${c.system ? '' : `<span class="flex gap-1"><button data-perm="warehouse.edit" data-catren="${c.id}" class="${btnGhost} !py-0.5 !px-2 text-xs">✎</button><button data-perm="warehouse.edit" data-catdel="${c.id}" class="${btnDanger} !py-0.5 !px-2 text-xs">✕</button></span>`}</div>`).join('')}</div>`;
  $('#dcCatAdd').onclick = safe(async () => { const n = $('#dcCatName').value.trim(); if (n) await Api.post('/api/equipment/categories', { name: n }); });
  $('#dcCatName').onkeydown = (e) => { if (e.key === 'Enter') $('#dcCatAdd').click(); };
  $('#dcCats').querySelectorAll('[data-catren]').forEach((b) => {
    b.onclick = safe(async () => { const c = m.categories.find((x) => x.id === +b.dataset.catren); const n = prompt('Новое название категории', c.name); if (n && n.trim() && n.trim() !== c.name) await Api.put('/api/equipment/categories/' + c.id, { name: n.trim() }); });
  });
  $('#dcCats').querySelectorAll('[data-catdel]').forEach((b) => {
    b.onclick = safe(async () => { const c = m.categories.find((x) => x.id === +b.dataset.catdel); if (confirm(`Удалить категорию «${c.name}»?`)) await Api.del('/api/equipment/categories/' + c.id); });
  });

  $('#dcModels').innerHTML = `<div class="grid grid-cols-5 gap-2 mb-3"><select id="dcModCat" class="${fieldCls} col-span-2">${eqOptions(m.categories, 'id', 'name', '', 'Категория')}</select>
    <input data-perm="warehouse.edit" id="dcModName" placeholder="Новая модель" class="${fieldCls} col-span-2"><button data-perm="warehouse.edit" id="dcModAdd" class="${btnPrimary} !px-3">+</button></div>
    <div class="space-y-1 max-h-72 overflow-auto">${m.models.map((x) => `<div class="flex items-center justify-between gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-1.5 text-sm">
      <span><span class="text-xs text-slate-500">${esc(x.category_name)} ·</span> ${esc(x.name)} <span class="text-xs text-slate-500">ед.: ${x.equipment_count}</span></span>
      <span class="flex gap-1"><button data-perm="warehouse.edit" data-modren="${x.id}" class="${btnGhost} !py-0.5 !px-2 text-xs">✎</button><button data-perm="warehouse.edit" data-moddel="${x.id}" class="${btnDanger} !py-0.5 !px-2 text-xs">✕</button></span></div>`).join('')}</div>`;
  $('#dcModAdd').onclick = safe(async () => {
    const cid = +$('#dcModCat').value; const n = $('#dcModName').value.trim();
    if (!cid) throw new Error('Выберите категорию'); if (n) await Api.post('/api/equipment/models', { category_id: cid, name: n });
  });
  $('#dcModels').querySelectorAll('[data-modren]').forEach((b) => {
    b.onclick = safe(async () => { const x = m.models.find((y) => y.id === +b.dataset.modren); const n = prompt('Новое название модели', x.name); if (n && n.trim() && n.trim() !== x.name) await Api.put('/api/equipment/models/' + x.id, { category_id: x.category_id, name: n.trim() }); });
  });
  $('#dcModels').querySelectorAll('[data-moddel]').forEach((b) => {
    b.onclick = safe(async () => { const x = m.models.find((y) => y.id === +b.dataset.moddel); if (confirm(`Удалить модель «${x.name}»?`)) await Api.del('/api/equipment/models/' + x.id); });
  });

  const fields = m.fields || [];
  $('#dcFields').innerHTML = `<form data-perm="warehouse.edit" id="dcFdForm" class="grid grid-cols-12 gap-2 mb-3 items-center">
      <input name="name" placeholder="Новое поле, например «IMEI»" required class="${fieldCls} col-span-5">
      <select name="category" class="${fieldCls} col-span-5">${eqOptions(m.categories, 'id', 'name', '', 'Для всего оборудования')}</select>
      <button class="${btnPrimary} !px-3 col-span-2">Добавить</button></form>
    <div class="space-y-1">${fields.map((f) => `<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-1.5 text-sm">
      <span>${esc(f.name)} <span class="text-xs text-slate-500">${f.category_name ? 'категория: ' + esc(f.category_name) : 'для всего оборудования'} · заполнено у ${f.value_count} ед.</span></span>
      <span class="flex gap-1"><button data-perm="warehouse.edit" data-fdedit="${f.id}" class="${btnGhost} !py-0.5 !px-2 text-xs">✎</button><button data-perm="warehouse.edit" data-fddel="${f.id}" class="${btnDanger} !py-0.5 !px-2 text-xs">✕</button></span></div>`).join('')
      || '<p class="text-xs text-slate-500">Полей пока нет — они появятся сами при импорте из Excel или можно добавить здесь.</p>'}</div>`;
  $('#dcFdForm').onsubmit = safe(async (e) => {
    e.preventDefault(); const f = e.target.elements;
    await Api.post('/api/equipment/fields', { name: f.name.value.trim(), category_id: f.category.value ? +f.category.value : null });
  });
  $('#dcFields').querySelectorAll('[data-fddel]').forEach((b) => {
    b.onclick = safe(async () => {
      const f = fields.find((x) => x.id === +b.dataset.fddel);
      if (confirm(`Удалить поле «${f.name}»${f.value_count ? ` вместе со значениями у ${f.value_count} ед. оборудования` : ''}?`)) await Api.del('/api/equipment/fields/' + f.id);
    });
  });
  $('#dcFields').querySelectorAll('[data-fdedit]').forEach((b) => {
    b.onclick = () => {
      const f = fields.find((x) => x.id === +b.dataset.fdedit);
      modal(`<h2 class="font-display text-lg font-bold mb-3">Поле «${esc(f.name)}»</h2>
        <form id="fdEdit" class="space-y-3">
          <label class="${labelCls}">Название<input name="name" required value="${esc(f.name)}" class="${fieldCls}"></label>
          <label class="${labelCls}">Для категории<select name="category" class="${fieldCls}">${eqOptions(m.categories, 'id', 'name', f.category_id || '', 'Для всего оборудования')}</select></label>
          <div id="fdMsg"></div>
          <div class="flex gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Сохранить</button></div>
        </form>`);
      $('#fdEdit').onsubmit = async (e) => {
        e.preventDefault(); const el = e.target.elements;
        try { await Api.put('/api/equipment/fields/' + f.id, { name: el.name.value.trim(), category_id: el.category.value ? +el.category.value : null }); close(); }
        catch (err) { $('#fdMsg').innerHTML = eqNote(err.message, 'err'); }
      };
    };
  });

  $('#dcStatuses').innerHTML = `<form data-perm="warehouse.edit" id="dcStForm" class="grid grid-cols-12 gap-2 mb-3 items-center">
      <input name="name" placeholder="Новое состояние" required class="${fieldCls} col-span-5"><input name="color" type="color" value="#64748b" class="h-9 w-full rounded-lg col-span-2 bg-transparent">
      <label class="col-span-3 flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" name="usable" class="rounded accent-indigo-500"> годно к выдаче</label>
      <button class="${btnPrimary} !px-3 col-span-2">Добавить</button></form>
    <div class="space-y-1">${m.statuses.map((s) => `<div class="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-3 py-1.5 text-sm">
      <span class="flex items-center gap-2">${colorBadge(s.name, s.color)}
        <span class="text-xs ${s.usable ? 'text-emerald-300' : 'text-slate-500'}">${s.usable ? 'годно к выдаче' : 'не выдаётся'}</span>
        ${s.role === 'ok' ? '<span class="text-[10px] rounded-full bg-slate-700/60 text-slate-300 px-1.5 py-0.5">служебное: при приёмке</span>' : ''}
        ${s.role === 'defect' ? '<span class="text-[10px] rounded-full bg-slate-700/60 text-slate-300 px-1.5 py-0.5">служебное: для снятого</span>' : ''}
        <span class="text-xs text-slate-500">ед.: ${s.equipment_count}</span></span>
      <span class="flex gap-1"><button data-perm="warehouse.edit" data-stedit="${s.id}" class="${btnGhost} !py-0.5 !px-2 text-xs">✎</button>
        ${s.protected || s.role ? '' : `<button data-perm="warehouse.edit" data-stdel="${s.id}" class="${btnDanger} !py-0.5 !px-2 text-xs">✕</button>`}</span></div>`).join('')}</div>`;
  $('#dcStForm').onsubmit = safe(async (e) => {
    e.preventDefault(); const f = e.target.elements;
    await Api.post('/api/equipment/statuses', { name: f.name.value.trim(), color: f.color.value, usable: f.usable.checked });
  });
  $('#dcStatuses').querySelectorAll('[data-stdel]').forEach((b) => {
    b.onclick = safe(async () => { const s = m.statuses.find((x) => x.id === +b.dataset.stdel); if (confirm(`Удалить состояние «${s.name}»?`)) await Api.del('/api/equipment/statuses/' + s.id); });
  });
  $('#dcStatuses').querySelectorAll('[data-stedit]').forEach((b) => {
    b.onclick = () => {
      const s = m.statuses.find((x) => x.id === +b.dataset.stedit);
      modal(`<h2 class="font-display text-lg font-bold mb-3">Состояние «${esc(s.name)}»</h2>
        <form id="stEdit" class="space-y-3">
          <label class="${labelCls}">Название<input name="name" required value="${esc(s.name)}" class="${fieldCls}"></label>
          <label class="${labelCls}">Цвет<input name="color" type="color" value="${esc(s.color)}" class="h-9 w-24 rounded-lg bg-transparent"></label>
          ${s.role ? `<p class="text-xs text-slate-500">Служебное состояние: «${s.role === 'ok' ? 'годно к выдаче' : 'не выдаётся'}» не меняется.</p>`
            : `<label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" name="usable" class="rounded accent-indigo-500" ${s.usable ? 'checked' : ''}> годно к выдаче и установке</label>`}
          <div id="stMsg"></div>
          <div class="flex gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Сохранить</button></div>
        </form>`);
      $('#stEdit').onsubmit = async (e) => {
        e.preventDefault(); const f = e.target.elements;
        try { await Api.put('/api/equipment/statuses/' + s.id, { name: f.name.value.trim(), color: f.color.value, usable: f.usable ? f.usable.checked : s.usable }); close(); }
        catch (err) { $('#stMsg').innerHTML = eqNote(err.message, 'err'); }
      };
    };
  });
}

// ---------- импорт базы «Склада»

function eqImportReportHtml(r) {
  const line = (label, html) => `<div class="flex gap-3 text-xs py-1 border-b border-slate-800/70"><span class="w-44 shrink-0 text-slate-400">${esc(label)}</span><span class="min-w-0">${html}</span></div>`;
  const e = r.equipment; const p = r.points; const pe = r.people;
  const conflicts = e.conflict_count
    ? `<br><span class="text-amber-300">Отличается место/состояние у ${e.conflict_count} ед.${r.mode === 'overwrite' ? ' — будет заменено данными файла' : ' — останется как сейчас'}:</span>
       ${e.conflicts.map((c) => `<br><span class="text-slate-400">№${esc(c.serial_number)}: сейчас «${esc(c.now)}», в файле «${esc(c.in_file)}»</span>`).join('')}${e.conflict_count > e.conflicts.length ? '<br>…' : ''}` : '';
  return `<div class="rounded-xl border ${r.dry_run ? 'border-indigo-400/40 bg-indigo-500/10' : 'border-emerald-500/30 bg-emerald-500/10'} p-3">
    <b class="text-sm block mb-2">${r.dry_run ? 'Проверка (в базу ничего не записано)' : 'Импорт выполнен'}</b>
    ${line('В файле', `оборудования ${r.source.equipment}, комплексов ${r.source.complexes}, монтёров ${r.source.installers}, панелей ${r.source.solar_panels}, записей журнала ${r.source.history}`)}
    ${line('Оборудование', `новых: <b>${e.created}</b>, уже есть: ${e.existing}${e.updated ? `, обновлено: ${e.updated}` : ''}${e.filled ? `, дополнено полей у ${e.filled}` : ''}${conflicts}`)}
    ${line('Комплексы', `найдено в календаре: <b>${p.matched}</b>, ${r.dry_run ? 'будет создано' : 'создано'}: <b>${p.created}</b>${p.created_names.length ? ` (${p.created_names.map(esc).join(', ')}${p.created > p.created_names.length ? '…' : ''})` : ''}${p.filled ? `, дополнено у ${p.filled}` : ''}`)}
    ${line('Монтёры', `найдено в персонале: ${pe.matched}, ${r.dry_run ? 'будет добавлено' : 'добавлено'}: <b>${pe.created}</b>${pe.created_names.length ? ` (${pe.created_names.map(esc).join(', ')})` : ''}`)}
    ${line('Категории и модели', `категорий оборудования +${r.equipment_categories.created}, моделей +${r.models.created}, категорий комплексов +${r.point_categories.created}`)}
    ${line('Солнечные панели', `новых: ${r.panels.created}, уже есть: ${r.panels.existing}, привязано к комплексам: ${r.panels.linked}`)}
    ${line('Журнал', `${r.dry_run ? 'будет добавлено' : 'добавлено'}: ${r.history.added}, повторов пропущено: ${r.history.duplicates}`)}
    ${r.warnings.length ? `<div class="mt-2 text-xs text-amber-300 whitespace-pre-line">Предупреждения:\n${r.warnings.slice(0, 30).map(esc).join('\n')}${r.warnings.length > 30 ? '\n…' : ''}</div>` : ''}
  </div>`;
}

function wireImport() {
  let checked = false;
  const invalidate = () => { checked = false; $('#imRun').disabled = true; };
  $('#imFile').onchange = invalidate; $('#imMode').onchange = invalidate; $('#imHist').onchange = invalidate;
  const send = async (dryRun) => {
    const file = $('#imFile').files[0];
    if (!file) throw new Error('Выберите файл warehouse.db');
    const fd = new FormData();
    fd.append('file', file); fd.append('mode', $('#imMode').value); fd.append('dry_run', dryRun ? 'true' : 'false'); fd.append('import_history', $('#imHist').checked ? 'true' : 'false');
    return Api.upload('/api/equipment/import/sklad', fd);
  };
  $('#imCheck').onclick = async () => {
    $('#imReport').innerHTML = eqNote('Читаю файл…');
    try { const r = await send(true); $('#imReport').innerHTML = eqImportReportHtml(r); checked = true; $('#imRun').disabled = false; }
    catch (e) { $('#imReport').innerHTML = eqNote(e.message, 'err'); invalidate(); }
  };
  $('#imRun').onclick = async () => {
    if (!checked) return;
    if (!confirm('Импортировать данные из файла в общую базу? Перед этим стоит сделать резервную копию (Настройки → Резервные копии).')) return;
    $('#imRun').disabled = true;
    $('#imReport').innerHTML = eqNote('Импортирую…');
    try { const r = await send(false); $('#imReport').innerHTML = eqImportReportHtml(r); await paintDictionaries(); }
    catch (e) { $('#imReport').innerHTML = eqNote(e.message, 'err'); }
  };
}
