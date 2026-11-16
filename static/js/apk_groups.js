// /apk — «Подгруппы АПК»: именованные подборки комплексов внутри «Все АПК». Комплексы попадают в подгруппу вручную (списком номеров, отметкой в справочнике или
// на карте) или из файла Яндекс.Карт. У каждого комплекса в подгруппе СВОИ описание, «что нужно на выезде» и тип работы — они не связаны с описанием в карточке
// комплекса. Подгруппу можно смотреть списком или на карте; выезды, фото, пинг и правка данных комплекса доступны там же, где и в общем справочнике.
// Список подгруппы — тот же GET /api/points, только с group_id (app/repositories/points_repository.py::search_points), поэтому поиск, фильтры, карта и выделение
// рамкой/лассо работают так же, как везде. Бэкенд управления — app/api/routes_apk_groups.py. Зависит от apk.js (apkFilters, CURRENT_USER, apkSelected…) и ui.js.
let APK_GROUPS = [];

// Тумблер «Убирать комплексы после выезда» (подгруппа сама отпускает комплекс, когда по нему сдан отчёт о выезде) — свой небольшой стиль, не зависящий от сборки Tailwind.
(function mountSwitchStyle() {
  const css = document.createElement('style');
  css.textContent = `.apk-switch{display:inline-flex;align-items:center;gap:8px;cursor:pointer;user-select:none;position:relative}
    .apk-switch input{position:absolute;opacity:0;width:0;height:0}
    .apk-sw-track{width:38px;height:22px;border-radius:999px;background:rgb(var(--slate-500));position:relative;transition:background .15s;flex:none}
    .apk-sw-track::after{content:'';position:absolute;top:3px;left:3px;width:16px;height:16px;border-radius:50%;background:#fff;transition:transform .15s}
    .apk-switch input:checked + .apk-sw-track{background:rgb(var(--accent))}
    .apk-switch input:checked + .apk-sw-track::after{transform:translateX(16px)}
    .apk-switch input:focus-visible + .apk-sw-track{box-shadow:0 0 0 3px rgb(var(--accent) / .4)}
    .apk-switch input:disabled + .apk-sw-track{opacity:.5}
    .apk-switch input:disabled ~ span{opacity:.7}`;
  document.head.appendChild(css);
})();

const apkCanEdit = () => can('points.edit');
const apkCurrentGroup = () => (apkFilters.groupId == null ? null : APK_GROUPS.find((g) => g.id === apkFilters.groupId) || null);

async function loadApkGroups() {
  try { APK_GROUPS = await Api.get('/api/apk-groups'); } catch { /* остаётся прежний список */ }
  if (apkFilters.groupId != null && !APK_GROUPS.some((g) => g.id === apkFilters.groupId)) apkFilters.groupId = null;
}

// ---------- плашки подгрупп над поиском и панель выбранной подгруппы
function apkGroupsBarHtml() {
  const chip = (active, inner, attrs) => `<button type="button" ${attrs} class="rounded-full px-3 py-1 text-xs border transition-colors ${active ? 'border-indigo-400 bg-indigo-500/25 font-semibold' : 'border-slate-700 bg-slate-800/60 hover:bg-slate-700/60'}">${inner}</button>`;
  return `<span class="text-xs text-slate-400">Подгруппы:</span>
    ${chip(apkFilters.groupId == null, 'Все АПК', 'data-apkgroup=""')}
    ${APK_GROUPS.map((g) => chip(apkFilters.groupId === g.id, `${g.kind ? '⚠' : '📁'} ${esc(g.name)} <span class="text-slate-400">· ${g.count}</span>${g.auto_remove ? ' <span title="Комплексы уходят из подгруппы после выезда">⏱</span>' : ''}`, `data-apkgroup="${g.id}"`)).join('')}
    ${apkCanEdit() ? chip(false, '＋ Подгруппа', 'data-apkgroup-new="1"') : ''}`;
}

function apkGroupPanelHtml() {
  const g = apkCurrentGroup();
  if (!g) return '';
  const typed = Object.entries(g.types || {}).filter(([k]) => k).map(([k, n]) => `${esc(k)}: ${n}`);
  const untyped = (g.types || {})[''] || 0;
  const btn = 'rounded-lg px-2.5 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors';
  if (g.kind) {          // автоматическая подгруппа «Требуют повторного выезда»: состав ведёт программа, вручную не меняется (app/services/apk_group_auto.py)
    return `<div class="rounded-xl border border-amber-400/30 bg-amber-500/5 px-3 py-2.5 space-y-1.5">
      <div class="flex flex-wrap items-center gap-2"><b class="text-sm">⚠ ${esc(g.name)}</b><span class="text-xs text-slate-400">комплексов: ${g.count}</span><span class="rounded-lg px-2 py-0.5 text-[11px] bg-amber-500/15 text-amber-300">ведётся автоматически</span></div>
      ${g.description ? `<p class="text-xs text-slate-300" style="white-space:pre-wrap">${esc(g.description)}</p>` : ''}
      <p class="text-[11px] text-slate-500">Причина и «что нужно» взяты из отчёта о выезде (или из задания, которое не выполнили). Комплекс уходит отсюда сам, когда становится рабочим. Отметьте комплексы и нажмите «📌 В план…» или «Добавить в бригаду…», чтобы поехать на них снова.</p>
    </div>`;
  }
  return `<div class="rounded-xl border border-indigo-400/25 bg-indigo-500/5 px-3 py-2.5 space-y-2">
    <div class="flex flex-wrap items-center gap-2">
      <b class="text-sm">📁 ${esc(g.name)}</b><span class="text-xs text-slate-400">комплексов: ${g.count}</span>
      ${apkCanEdit() ? `<span class="ml-auto flex flex-wrap items-center gap-1.5">
        <button type="button" id="apkGrpAdd" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors" title="Добавить комплексы списком номеров или из файла Яндекс.Карт">＋ Добавить АПК…</button>
        <select id="apkGrpTypeAll" class="${fieldCls} !py-1 !text-xs !w-auto" title="Поставить этот тип работы всем комплексам подгруппы"><option value="">— тип всем —</option>${planVisitTypeOptions('')}</select>
        <button type="button" id="apkGrpTypeAllBtn" class="${btn}">Поставить всем</button>
        <button type="button" id="apkGrpEdit" class="${btn}" title="Название и описание подгруппы">✎</button>
        <button type="button" id="apkGrpDelete" class="rounded-lg px-2.5 py-1 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors" title="Удалить подгруппу (комплексы в справочнике останутся)">🗑</button>
      </span>` : ''}
    </div>
    ${g.description ? `<p class="text-xs text-slate-300" style="white-space:pre-wrap">${esc(g.description)}</p>` : ''}
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
      <label class="apk-switch" title="Как только по комплексу из этой подгруппы сдан отчёт о выезде (после того как он сюда попал), он сам убирается из подгруппы">
        <input type="checkbox" id="apkGrpAutoRemove" ${g.auto_remove ? 'checked' : ''} ${apkCanEdit() ? '' : 'disabled'}><span class="apk-sw-track"></span>
        <span class="text-xs">Убирать комплексы после выезда</span></label>
      <span class="text-[11px] text-slate-500">${g.auto_remove ? 'Включено: комплекс уходит отсюда, когда по нему сдан отчёт о выезде.' : 'Выключено: комплексы остаются в подгруппе, пока их не уберут вручную.'}</span>
    </div>
    <p class="text-[11px] text-slate-500">${typed.length || untyped ? `Типы работ: ${[...typed, untyped ? `без типа: ${untyped}` : ''].filter(Boolean).join(' · ')}. ` : ''}Описание и «что нужно на выезде» у каждого комплекса в подгруппе — свои, они не связаны с описанием в карточке комплекса. Полные данные, выезды, фото и пинг — кнопками в строке.</p>
  </div>`;
}

function renderApkGroups() {
  const bar = $('#apkGroupsBar');
  if (!bar) return;
  bar.innerHTML = apkGroupsBarHtml();
  bar.querySelectorAll('[data-apkgroup]').forEach((b) => { b.onclick = () => apkSelectGroup(b.dataset.apkgroup === '' ? null : +b.dataset.apkgroup); });
  bar.querySelector('[data-apkgroup-new]')?.addEventListener('click', () => apkGroupForm(null));
  const panel = $('#apkGroupPanel');
  panel.innerHTML = apkGroupPanelHtml();
  panel.classList.toggle('mb-3', !!apkFilters.groupId);
  if ($('#apkGrpAdd')) $('#apkGrpAdd').onclick = apkGroupAddForm;
  if ($('#apkGrpEdit')) $('#apkGrpEdit').onclick = () => apkGroupForm(apkCurrentGroup());
  if ($('#apkGrpDelete')) $('#apkGrpDelete').onclick = apkGroupDelete;
  if ($('#apkGrpTypeAllBtn')) $('#apkGrpTypeAllBtn').onclick = apkGroupTypeAll;
  if ($('#apkGrpAutoRemove')) $('#apkGrpAutoRemove').onchange = apkGroupToggleAutoRemove;
}

async function apkSelectGroup(id) {
  if (apkFilters.groupId === id) return;
  apkFilters.groupId = id;
  apkSelected.clear();                          // выбор относился к другому списку
  renderApkGroups();
  await applyApkFilters();
}

async function apkReloadGroups() {
  await loadApkGroups();
  renderApkGroups();
}

// ---------- создать / переименовать / удалить подгруппу
function apkGroupForm(group) {
  const isNew = !group;
  modal(`<h2 class="font-display text-lg font-bold mb-4">${isNew ? 'Новая подгруппа' : 'Подгруппа «' + esc(group.name) + '»'}</h2>
    <form id="apkGroupForm" class="space-y-4">
      <label class="${labelCls}">Название<input name="name" required maxlength="60" value="${esc(group ? group.name : '')}" class="${fieldCls}" placeholder="например: Рейд на Ейск" autocomplete="off"></label>
      <label class="${labelCls}">Описание подгруппы (необязательно)<textarea name="description" rows="3" class="${fieldCls}" placeholder="зачем собрана подгруппа, общая задача">${esc(group ? group.description : '')}</textarea></label>
      <label class="apk-switch" title="Как только по комплексу из этой подгруппы сдан отчёт о выезде (после того как он сюда попал), он сам убирается из подгруппы">
        <input type="checkbox" name="auto_remove" ${group && group.auto_remove ? 'checked' : ''}><span class="apk-sw-track"></span><span class="text-sm">Убирать комплексы после выезда</span></label>
      <div id="apkGroupFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">${isNew ? 'Создать' : 'Сохранить'}</button>
      </div>
    </form>`);
  $('#apkGroupForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      if (isNew) {
        const created = await Api.post('/api/apk-groups', { name: f.name.value, description: f.description.value, auto_remove: f.auto_remove.checked });
        await loadApkGroups();
        apkFilters.groupId = created.id;
        apkSelected.clear();
      } else {
        await Api.put(`/api/apk-groups/${group.id}`, { name: f.name.value, description: f.description.value, auto_remove: f.auto_remove.checked });
        await loadApkGroups();
      }
      renderApkGroups();
      close();
    } catch (err) {
      $('#apkGroupFormError').textContent = err.message;
      $('#apkGroupFormError').classList.remove('hidden');
    }
  };
}

async function apkGroupToggleAutoRemove(e) {
  const g = apkCurrentGroup();
  if (!g) return;
  const box = e.target;
  box.disabled = true;
  try {
    const res = await Api.put(`/api/apk-groups/${g.id}`, { auto_remove: box.checked });
    await loadApkGroups();
    renderApkGroups();
    if (res.removed_visited) {
      toast(`Убрано комплексов, по которым уже был выезд: ${res.removed_visited}`, 'ok');
      await applyApkFilters();
    } else toast(box.checked ? 'Включено: комплексы будут уходить из подгруппы после выезда' : 'Выключено: комплексы остаются в подгруппе', 'ok');
  } catch (err) {
    box.checked = !box.checked;
    box.disabled = false;
    alert('Не удалось переключить: ' + err.message);
  }
}

async function apkGroupDelete() {
  const g = apkCurrentGroup();
  if (!g) return;
  if (!confirm(`Удалить подгруппу «${g.name}»? Комплексы в справочнике останутся, пропадут только их описания и «что нужно» из этой подгруппы.`)) return;
  try {
    await Api.del(`/api/apk-groups/${g.id}`);
    apkFilters.groupId = null;
    apkSelected.clear();
    await loadApkGroups();
    renderApkGroups();
    await applyApkFilters();
  } catch (err) { alert(err.message); }
}

// Тип работы — сразу всем комплексам подгруппы (а не только найденным фильтром).
async function apkGroupTypeAll() {
  const g = apkCurrentGroup();
  const type = $('#apkGrpTypeAll')?.value;
  if (!g || !type) { alert('Выберите тип работы.'); return; }
  if (!confirm(`Поставить тип «${type}» всем комплексам подгруппы «${g.name}» (${g.count})?`)) return;
  try {
    const ids = await apkGroupAllIds(g.id);
    await Api.post(`/api/apk-groups/${g.id}/points/update`, { point_ids: ids, work_type: type });
    await apkReloadGroups();
    await applyApkFilters();
  } catch (err) { alert(err.message); }
}

async function apkGroupAllIds(groupId) {
  const { items } = await Api.getPage(`/api/points?group_id=${groupId}`);
  return items.map((p) => p.id);
}

// ---------- строка комплекса в подгруппе: тип работы, описание, «что нужно» — свои
const apkInGroup = (p) => apkFilters.groupId != null && p.group_note != null;

function apkGroupBoxHtml(p) {
  const auto = !!(apkCurrentGroup() || {}).kind;       // у автоматической подгруппы тексты берутся из отчётов — только чтение
  const ro = !apkCanEdit() || auto;
  const id = esc(p.id);
  return `<div class="rounded-lg border border-indigo-400/20 bg-indigo-500/5 p-2 grid grid-cols-1 md:grid-cols-[170px_1fr_1fr_auto] gap-2 items-start" data-grp-box="${id}" data-no-brick>
    <label class="text-[11px] text-slate-400">Тип работы
      <select data-grp-type="${id}" ${ro ? 'disabled' : ''} class="${fieldCls} !py-1 !text-xs mt-0.5"><option value="">— не выбран —</option>${planVisitTypeOptions(p.group_work_type || '')}</select></label>
    <label class="text-[11px] text-slate-400">Описание в подгруппе
      <textarea data-grp-note="${id}" rows="2" ${ro ? 'readonly' : ''} maxlength="2000" class="${fieldCls} !py-1 !text-xs mt-0.5" placeholder="что за комплекс, особенности">${esc(p.group_note || '')}</textarea></label>
    <label class="text-[11px] text-slate-400">Что нужно на выезде
      <textarea data-grp-need="${id}" rows="2" ${ro ? 'readonly' : ''} maxlength="2000" class="${fieldCls} !py-1 !text-xs mt-0.5" placeholder="материалы, доступ, техника">${esc(p.group_need || '')}</textarea></label>
    ${ro ? '' : `<button type="button" data-grp-remove="${id}" class="rounded-lg px-2 py-1 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors" title="Убрать из подгруппы (в справочнике комплекс останется)">✕</button>`}
  </div>`;
}

const _GRP_FIELD_OF = { work_type: 'group_work_type', note: 'group_note', need: 'group_need' };

async function apkGroupSaveMember(pointId, patch) {
  const gid = apkFilters.groupId;
  if (gid == null) return;
  try {
    await Api.put(`/api/apk-groups/${gid}/points/${encodeURIComponent(pointId)}`, patch);
  } catch (err) {
    alert('Не удалось сохранить: ' + err.message);
    return;
  }
  // Данные в памяти обновляем сразу, чтобы строка не «откатилась» до ответа следующего опроса.
  for (const list of [apkItems, apkMapPoints]) {
    const row = list.find((x) => x.id === pointId);
    if (row) for (const [k, v] of Object.entries(patch)) row[_GRP_FIELD_OF[k]] = v;
  }
  const sel = apkSelected.get(pointId);
  if (sel) for (const [k, v] of Object.entries(patch)) sel[_GRP_FIELD_OF[k]] = v;
  if (patch.work_type !== undefined) apkReloadGroups();            // разбивка по типам в панели
}

async function apkGroupRemoveFromGroup(pointIds) {
  const g = apkCurrentGroup();
  if (!g || !pointIds.length) return;
  try {
    await Api.post(`/api/apk-groups/${g.id}/points/remove`, { point_ids: pointIds });
    pointIds.forEach((id) => apkSelected.delete(id));
    await apkReloadGroups();
    if (apkView === 'map') { close(); await refreshApkMap(); } else { await applyApkFilters(); }
  } catch (err) { alert(err.message); }
}

function wireApkGroupBoxes(root) {
  root.querySelectorAll('[data-grp-type]').forEach((el) => { el.onchange = () => apkGroupSaveMember(el.dataset.grpType, { work_type: el.value }); });
  root.querySelectorAll('[data-grp-note]').forEach((el) => { el.onchange = () => apkGroupSaveMember(el.dataset.grpNote, { note: el.value.trim() }); });
  root.querySelectorAll('[data-grp-need]').forEach((el) => { el.onchange = () => apkGroupSaveMember(el.dataset.grpNeed, { need: el.value.trim() }); });
  root.querySelectorAll('[data-grp-remove]').forEach((el) => {
    el.onclick = () => {
      if (!confirm(`Убрать комплекс ${el.dataset.grpRemove} из подгруппы? В справочнике он останется, пропадут его описание и «что нужно» из этой подгруппы.`)) return;
      apkGroupRemoveFromGroup([el.dataset.grpRemove]);
    };
  });
}

// ---------- добавить в подгруппу: списком номеров или файлом Яндекс.Карт
function apkGroupResultHtml(res) {
  const lines = [`Добавлено в подгруппу: <b>${res.added}</b>${res.already ? `, уже были: ${res.already}` : ''}. Всего в подгруппе: ${res.total}.`];
  if (res.created?.length) lines.push(`Заведены в справочнике (их не было): ${res.created.map(esc).join(', ')}.`);
  if (res.unknown?.length) lines.push(`<span class="text-amber-300">Не найдены в справочнике${res.unknown.length > 40 ? ` (первые 40 из ${res.unknown.length})` : ''}: ${res.unknown.slice(0, 40).map(esc).join(', ')}.</span>`);
  if (res.ambiguous?.length) lines.push(`<span class="text-amber-300">Подходит несколько комплексов — не добавлены: ${res.ambiguous.slice(0, 20).map((a) => `${esc(a.label)} → ${a.candidates.map(esc).join(' / ')}`).join('; ')}.</span>`);
  return lines.map((l) => `<div class="text-sm">${l}</div>`).join('');
}

function apkGroupAddForm() {
  const g = apkCurrentGroup();
  if (!g) return;
  modal(`<h2 class="font-display text-lg font-bold mb-1">Добавить АПК в «${esc(g.name)}»</h2>
    <p class="text-xs text-slate-400 mb-3">Общие поля ниже применятся ко всем добавляемым комплексам (можно оставить пустыми и заполнить потом в списке или на карте).</p>
    <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-3">
      <label class="${labelCls}">Тип работы<select id="apkGrpAddType" class="${fieldCls}"><option value="">— выберу позже —</option>${planVisitTypeOptions('')}</select></label>
      <label class="${labelCls}">Описание в подгруппе<input id="apkGrpAddNote" maxlength="2000" class="${fieldCls}" autocomplete="off"></label>
      <label class="${labelCls}">Что нужно на выезде<input id="apkGrpAddNeed" maxlength="2000" class="${fieldCls}" autocomplete="off"></label>
    </div>
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/20 p-3 mb-3 space-y-2">
      <b class="text-sm">1. Списком номеров</b>
      <textarea id="apkGrpPaste" rows="4" class="${fieldCls}" placeholder="Номера комплексов через пробел, запятую или с новой строки"></textarea>
      <button type="button" id="apkGrpPasteBtn" class="${btnGhost} !py-1.5 !px-3 text-xs">Добавить списком</button>
    </div>
    <div class="rounded-xl border border-slate-700/50 bg-slate-800/20 p-3 mb-3 space-y-2">
      <b class="text-sm">2. Файл из Яндекс.Карт</b>
      <p class="text-[11px] text-slate-500">KML / KMZ, GeoJSON, GPX, Excel (.xlsx — в том числе выгрузка «🗺 В Яндекс.Карты»), CSV или текст со списком номеров. Метка файла — номер комплекса.</p>
      <input type="file" id="apkGrpFile" accept=".kml,.kmz,.geojson,.json,.gpx,.xlsx,.xlsm,.csv,.tsv,.txt" class="${fieldCls}">
      <label class="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" id="apkGrpCreate" class="rounded accent-indigo-500" checked> Завести в справочнике комплексы, которых там нет (если у метки есть координаты)</label>
      <label class="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" id="apkGrpUseDesc" class="rounded accent-indigo-500"> Описание метки из файла записать как «описание в подгруппе» (если выше оно не заполнено)</label>
      <button type="button" id="apkGrpFileBtn" class="${btnGhost} !py-1.5 !px-3 text-xs">Загрузить файл</button>
    </div>
    <p class="text-[11px] text-slate-500 mb-2">3. Ещё способ: отметьте комплексы галочками в справочнике (или рамкой / лассо на карте) и нажмите «📁 В подгруппу…».</p>
    <div id="apkGrpAddResult" class="space-y-1 mb-2"></div>
    <div class="flex items-center gap-2 pt-2"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
  const out = $('#apkGrpAddResult');
  const say = (html, bad) => { out.innerHTML = `<div class="rounded-xl border ${bad ? 'border-rose-500/30 bg-rose-500/10 text-rose-300' : 'border-emerald-500/30 bg-emerald-500/10'} px-3 py-2">${html}</div>`; };
  const common = () => {
    const c = {};
    if ($('#apkGrpAddType').value) c.work_type = $('#apkGrpAddType').value;
    if ($('#apkGrpAddNote').value.trim()) c.note = $('#apkGrpAddNote').value.trim();
    if ($('#apkGrpAddNeed').value.trim()) c.need = $('#apkGrpAddNeed').value.trim();
    return c;
  };
  const run = async (btn, fn) => {
    btn.disabled = true;
    out.innerHTML = '<div class="text-sm text-slate-400">Добавляю…</div>';
    try {
      const res = await fn();
      say(apkGroupResultHtml(res));
      await apkReloadGroups();
    } catch (err) { say(esc(err.message), true); }
    finally { btn.disabled = false; }
  };
  $('#apkGrpPasteBtn').onclick = (e) => {
    const text = $('#apkGrpPaste').value.trim();
    if (!text) { say('Впишите номера комплексов.', true); return; }
    run(e.target, () => Api.post(`/api/apk-groups/${g.id}/paste`, { text, ...common() }));
  };
  $('#apkGrpFileBtn').onclick = (e) => {
    const file = $('#apkGrpFile').files[0];
    if (!file) { say('Выберите файл.', true); return; }
    const c = common();
    const fd = new FormData();
    fd.append('file', file);
    fd.append('work_type', c.work_type || '');
    fd.append('note', c.note || '');
    fd.append('need', c.need || '');
    fd.append('create_missing', String($('#apkGrpCreate').checked));
    fd.append('use_description', String($('#apkGrpUseDesc').checked));
    run(e.target, () => Api.upload(`/api/apk-groups/${g.id}/import`, fd));
  };
}

// ---------- отмеченные в справочнике / на карте → подгруппа (существующая или новая)
function apkAddSelectedToGroup() {
  const pts = [...apkSelected.values()];
  if (!pts.length) return;
  const manual = APK_GROUPS.filter((g) => !g.kind);          // в автоматическую «Требуют повторного выезда» вручную не добавляют
  const current = apkCurrentGroup() && !apkCurrentGroup().kind ? apkCurrentGroup() : null;
  modal(`<h2 class="font-display text-lg font-bold mb-1">В подгруппу · комплексов: ${pts.length}</h2>
    <p class="text-xs text-slate-400 mb-3">Отмеченные комплексы войдут в выбранную подгруппу; те, что уже в ней, не задвоятся.</p>
    <form id="apkToGroupForm" class="space-y-3">
      <label class="${labelCls}">Подгруппа<select name="group" class="${fieldCls}">
        ${manual.map((g) => `<option value="${g.id}" ${current && current.id === g.id ? 'selected' : ''}>📁 ${esc(g.name)} (${g.count})</option>`).join('')}
        <option value="new" ${manual.length ? '' : 'selected'}>＋ Новая подгруппа…</option></select></label>
      <label class="${labelCls}" id="apkToGroupNameRow">Название новой подгруппы<input name="new_name" maxlength="60" class="${fieldCls}" autocomplete="off" placeholder="например: Рейд на Ейск"></label>
      <div class="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label class="${labelCls}">Тип работы<select name="work_type" class="${fieldCls}"><option value="">— не менять —</option>${planVisitTypeOptions('')}</select></label>
        <label class="${labelCls}">Описание в подгруппе<input name="note" maxlength="2000" class="${fieldCls}" autocomplete="off"></label>
        <label class="${labelCls}">Что нужно на выезде<input name="need" maxlength="2000" class="${fieldCls}" autocomplete="off"></label>
      </div>
      <div id="apkToGroupError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Добавить в подгруппу</button></div>
    </form>`);
  const form = $('#apkToGroupForm');
  const sync = () => $('#apkToGroupNameRow').classList.toggle('hidden', form.elements.group.value !== 'new');
  form.elements.group.onchange = sync;
  sync();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const err = (m) => { $('#apkToGroupError').textContent = m; $('#apkToGroupError').classList.remove('hidden'); };
    try {
      let gid = f.group.value;
      if (gid === 'new') {
        if (!f.new_name.value.trim()) return err('Впишите название новой подгруппы.');
        gid = (await Api.post('/api/apk-groups', { name: f.new_name.value })).id;
      }
      const body = { point_ids: pts.map((p) => p.id) };
      if (f.work_type.value) body.work_type = f.work_type.value;
      if (f.note.value.trim()) body.note = f.note.value.trim();
      if (f.need.value.trim()) body.need = f.need.value.trim();
      const res = await Api.post(`/api/apk-groups/${gid}/points`, body);
      await loadApkGroups();
      renderApkGroups();
      close();
      alert(`Добавлено в подгруппу: ${res.added}${res.already ? `, уже были: ${res.already}` : ''}. Всего в подгруппе: ${res.total}.`);
    } catch (e2) { err(e2.message); }
  };
}

// Тип работы выбранным комплексам подгруппы — прямо на карте или в списке.
async function apkGroupSetTypeSelected(type) {
  const g = apkCurrentGroup();
  const ids = [...apkSelected.keys()];
  if (!g || !ids.length) return;
  if (!type) { alert('Выберите тип работы.'); return; }
  try {
    await Api.post(`/api/apk-groups/${g.id}/points/update`, { point_ids: ids, work_type: type });
    ids.forEach((id) => {
      for (const list of [apkItems, apkMapPoints]) { const row = list.find((x) => x.id === id); if (row) row.group_work_type = type; }
      const sel = apkSelected.get(id); if (sel) sel.group_work_type = type;
    });
    await apkReloadGroups();
    if (apkView === 'map') { _syncMapPlacemarks(); renderApkSelectionBar(); } else renderApkList();
  } catch (err) { alert(err.message); }
}
