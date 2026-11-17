// /apk — "Все АПК": a flat, filterable directory of every point, for
// dispatchers ("user"/«Оператор») and admins. Search + category filter +
// health-status icon + the three network buttons (Пинг / Веб-интерфейс /
// Зайти) — the full-directory counterpart to the calendar's day-scoped
// "Точки на день" list (see app.js's renderPoints). $, esc, modal,
// editing, fieldCls/labelCls/btn*, pointHealthIndicator/pointNetButtonsHtml/
// colorBadge/setupCategoryCombobox come from ui.js.
//
// With ~3000 points, fetching the whole table on every open/search
// keystroke doesn't scale — search and category filtering happen
// server-side (GET /api/points?search=&category_id=&limit=&offset=, see
// app/api/routes_points.py) and the list loads a page at a time via
// "Показать ещё", not all at once.
let CURRENT_USER = null;
// Отмечать комплексы (галочки и панель действий над отмеченными) имеет смысл, когда есть хотя бы одно действие: подгруппа, план, бригада, карта
const apkCanSelect = () => canAny('points.edit', 'plans.edit', 'calendar.edit', 'maps.manage');
let APK_CATEGORIES = [];
let apkItems = [];   // currently loaded rows (accumulates as more pages load)
let apkTotal = 0;    // total matching rows on the server, for "Показать ещё"
// categories/statuses are Sets of string values — several chips can be
// active at once (OR'd server-side). '__none__' in categories means the
// "Без категории" chip.
let apkFilters = { search: '', categories: new Set(), statuses: new Set(), sort: '', certificate: '', groupId: null };   // groupId — выбранная подгруппа (apk_groups.js); null — весь справочник
let apkTab = (() => { try { return location.hash === '#check' ? 'check' : 'dir'; } catch { return 'dir'; } })();   // 'dir' — справочник, 'check' — «Проверка» (apk_check.js)
let apkSearchDebounce;
let apkSelected = new Map(); // id -> точка; отмеченные галочкой, переживают фильтры/«Показать ещё»/обновление списка
let apkView = 'list'; // 'list' | 'map' — same search/filters drive both, see renderApkContentArea
let apkMapPoints = [];       // every point matching the current filters that HAS lat/lon
let apkMapMissingCount = 0;  // matching points without usable coordinates, not shown on the map
let apkSearchSuggestions = []; // last-fetched dropdown suggestions (map view search, see loadApkSearchSuggestions)

const PAGE_SIZE = 50;
// Статусы — управляемый справочник; _pointStatusCache заполняется
// loadPointStatuses() (ui.js) в boot() ниже.

// In map view, closing ANY modal (the point popup, the edit form, plan
// form, journal — cancelled or saved) must not force a full page re-render:
// renderApkPage()/renderApkMap() would destroy and recreate the Yandex map,
// resetting whatever pan/zoom the dispatcher had set. refreshApkMap()
// re-syncs markers to current data in place instead — same effect on what's
// shown, without moving the map out from under them. List view has no such
// state to lose, so it keeps the simple full re-render.
function close() {
  editing = false;
  $('#modal').innerHTML = '';
  if (apkTab !== 'dir') { if (typeof apkCheckAfterClose === 'function') apkCheckAfterClose(); return; }      // вкладка «Проверка» пересчитывает свои карточки
  if (apkView === 'map') refreshApkMap();
  else apkRefreshAfterClose();
}

// Список после закрытия окна (в том числе просмотра фото): строки обновляются на месте, а не страница рисуется заново —
// иначе длинный пролистанный список сжимался до первых 50 строк и прыгал в начало.
async function apkRefreshAfterClose() {
  if (!$('#apkList')) { renderApkPage(); return; }              // список ещё не нарисован
  try { await Promise.all([apkReloadGroups(), refreshApkList()]); }
  catch { renderApkPage(); }
}

function apkQueryString(offset, limit) {
  const params = new URLSearchParams();
  if (apkFilters.search) params.set('search', apkFilters.search);
  if (apkFilters.categories.has('__none__')) params.set('uncategorized', 'true');
  apkFilters.categories.forEach((v) => { if (v !== '__none__') params.append('category_id', v); });
  apkFilters.statuses.forEach((v) => params.append('status', v));
  if (apkFilters.sort) params.set('sort', apkFilters.sort);
  if (apkFilters.certificate) params.set('certificate', apkFilters.certificate);
  if (apkFilters.groupId != null) params.set('group_id', apkFilters.groupId);
  params.set('limit', limit || PAGE_SIZE);
  params.set('offset', offset);
  return params.toString();
}

// reset=true starts over from the first page (new search/filter, or the
// list re-opening after an edit); reset=false appends the next page.
// opts.limit overrides the page size for the reset=true fetch — used by
// the 5s live refresh (see refreshApkList) to re-fetch however many rows
// are already loaded via "Показать ещё", instead of collapsing the list
// back down to the first 50 on every poll.
async function loadApkPage(reset, opts = {}) {
  const offset = reset ? 0 : apkItems.length;
  const limit = reset ? (opts.limit || PAGE_SIZE) : PAGE_SIZE;
  const { items, total } = await Api.getPage(`/api/points?${apkQueryString(offset, limit)}`);
  apkTotal = total;
  apkItems = reset ? items : apkItems.concat(items);
}

function apkRowHtml(p) {
  // port_down_since tracks "port unreachable" (see points_repository.
  // search_points) — shown even when status is only "Есть только пинг",
  // not just the full "Не работает".
  const downtime = formatDowntime(p.port_down_since);
  const techLine = [
    p.sim_number ? 'SIM: ' + esc(p.sim_number) : '',
    p.ip_address ? 'IP: ' + esc(p.ip_address) + (p.port ? ':' + esc(p.port) : '') : '',
    p.power_source ? '⚡ ' + esc(p.power_source) : '',
  ].filter(Boolean).join(' · ');
  return `<div data-brick="${esc(p.id)}" class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 flex flex-col gap-2">
    <div class="flex items-start justify-between gap-2">
      <span class="flex items-start gap-2 min-w-0">
        ${!apkCanSelect() ? '' : `<input type="checkbox" data-apk-check="${esc(p.id)}" class="rounded accent-indigo-500 mt-0.5 shrink-0" ${apkSelected.has(p.id) ? 'checked' : ''}>`}
        <span class="text-xs leading-relaxed min-w-0">
          <b data-brick-name title="Открыть карточку комплекса">${esc(p.id)}</b>${p.inventory_number ? ` · инв. ${esc(p.inventory_number)}` : ''} ${colorBadge(p.category_name, p.category_color)}<br>
          <span class="text-slate-400">${esc(p.address || 'адрес не указан')}</span>${p.description ? `<br><span class="text-slate-500">${esc(p.description)}</span>` : ''}${faultLineHtml(p)}${lastVisitLineHtml(p)}
          ${techLine ? `<br><span class="text-slate-500">${techLine}</span>` : ''}
          ${certificateBadgeHtml(p.verification_valid_until)}
          ${stockPartialNoteHtml(p)}
        </span>
      </span>
      <span class="flex items-center gap-2 shrink-0">
        <span class="flex flex-col items-end gap-0.5">
          ${pointHealthIndicator(p.status, p.stock_partial)}
          ${downtime ? `<span class="text-[11px] text-rose-400 whitespace-nowrap">недоступен: ${esc(downtime)}</span>` : ''}
          ${p.health_checked_at ? `<span class="text-[10px] text-slate-500 whitespace-nowrap" title="Когда автоматическая проверка в последний раз обходила этот комплекс">${esc(formatCheckedAgo(p.health_checked_at))}</span>` : ''}
        </span>
        <button data-perm="reports.view,monitoring.view,calendar.view,notifications.view" data-journal="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors shrink-0" title="История выездов">🕘</button>
        <button data-perm="photos.view" data-point-photos="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors shrink-0" title="Фото по этому комплексу по дням">📷</button>
        <button data-perm="plans.edit,calendar.edit" data-plan="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors shrink-0" title="Добавить в план выезда">📌</button>
        <button data-perm="points.view" data-edit="${esc(p.id)}" title="Карточка комплекса: просмотр и правка" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors shrink-0">🗂</button>
      </span>
    </div>
    ${apkInGroup(p) ? apkGroupBoxHtml(p) : ''}
    ${pointNetButtonsHtml(p)}
  </div>`;
}

// Небольшая форма "точка нуждается в выезде" — с описанием того, что
// нужно сделать; сохраняется в /api/point-plans и позже выбирается при
// добавлении задания бригаде (jobForm's «Из плана…», см. app.js). Принимает один номер или список (отмеченные на «Все АПК»):
// у списка общая группа, тип работы и описание. Группа — подпись, под которой точки собраны в плане; тип работы можно поставить
// сразу, независимо от группы.
async function addToPlanForm(pointIdOrIds, defaults = {}) {
  const ids = [].concat(pointIdOrIds);
  const many = ids.length > 1;
  const typeMap = defaults.types || {};
  const hasTypes = Object.keys(typeMap).length > 0;
  let groups = [];
  try { groups = await Api.get('/api/point-plans/groups'); } catch { /* подсказка не обязательна */ }
  modal(`<h2 class="font-display text-lg font-bold mb-4">В план выезда · ${many ? `точек: ${ids.length}` : esc(ids[0])}</h2>
    <form id="planForm" class="space-y-4">
      <label class="${labelCls}">Что нужно сделать${many ? ' (общее для всех, необязательно)' : ''}<textarea name="description" rows="3" class="${fieldCls}" placeholder="например, заменить камеру, нет доступа по IP..."></textarea></label>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="${labelCls}">Группа (необязательно)<input name="group_name" list="planFormGroups" maxlength="60" autocomplete="off" value="${esc(defaults.groupName || '')}" placeholder="например: Рейд на Ейск" class="${fieldCls}"></label>
        <datalist id="planFormGroups">${groups.map((g) => `<option value="${esc(g)}">`).join('')}</datalist>
        <label class="${labelCls}">Тип работы (необязательно)<select name="work_type" class="${fieldCls}"><option value="">${hasTypes ? '— как в подгруппе (у каждого свой) —' : '— выберу позже —'}</option>${planVisitTypeOptions('')}</select></label>
      </div>
      <p class="text-xs text-slate-500 -mt-2">Группа и тип не зависят друг от друга: тип можно поставить и точке без группы. Потом всю группу можно записать на бригаду одним действием («План» → «В бригаду на день…»).</p>
      <label class="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" name="priority" class="rounded accent-amber-500"> Приоритет — жёлтый маркер и пометка в Excel-экспорте для Яндекс.Карт
      </label>
      <div id="planFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Добавить в план</button>
      </div>
    </form>`);
  $('#planForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const common = { description: f.description.value.trim(), priority: f.priority.checked, group_name: f.group_name.value.trim(), work_type: f.work_type.value };
    try {
      if (many) {
        const res = await Api.post('/api/point-plans/bulk', { point_ids: ids, ...common, ...(hasTypes && !common.work_type ? { types: typeMap } : {}) });
        close();
        const lines = [`Добавлено в план: ${res.created}.`];
        if (res.already) lines.push(`Уже были в плане: ${res.already}${common.group_name || common.work_type ? ' (группа/тип им тоже выставлены)' : ''}.`);
        if (res.unknown?.length) lines.push(`Не найдены в справочнике: ${res.unknown.slice(0, 20).join(', ')}.`);
        alert(lines.join('\n'));
      } else {
        const res = await Api.post('/api/point-plans', { point_id: ids[0], ...common });
        close();
        if (res.duplicate) alert(`Такая точка уже добавлена в план: ${ids[0]}. Новая не создана${common.group_name || common.work_type ? ' (группа/тип выставлены уже существующей записи)' : ''}.`);
      }
    } catch (err) {
      $('#planFormError').textContent = err.message;
      $('#planFormError').classList.remove('hidden');
    }
  };
}

// ---------- Менеджер плана («📋 План» на «Все АПК») ----------
// Общий список всех point_plans с поиском и теми же фильтрами, что на «Все
// АПК», и массовыми действиями — отметить несколько/все найденные,
// поставить/снять приоритет пачкой, удалить пачкой, или разом превратить
// выбранные в задания одной бригаде на один день, с типом работы по каждой
// точке (общее окно bulkAssignForm из ui.js — такое же, как при импорте
// KML; app/api/routes_point_plans.py::assign_point_plans). Плюс импорт
// списка из Excel (только номер + описание — тип и приоритет расставляются
// уже тут, после импорта).
let PLAN_ENTRIES = [];
let PLAN_GROUP_NAMES = [];          // группы, которые уже есть в плане — подсказка при вводе названия
const planFilter = newPlanFilter(); // живёт, пока страница открыта
let planTicked = new Set();         // id отмеченных записей

async function loadPlanEntries() {
  try { PLAN_ENTRIES = await Api.get('/api/point-plans'); }
  catch (e) { alert('Не удалось загрузить план: ' + e.message); PLAN_ENTRIES = []; }
  planTicked = new Set([...planTicked].filter((id) => PLAN_ENTRIES.some((p) => p.id === id)));
  PLAN_GROUP_NAMES = [...new Set(PLAN_ENTRIES.map((p) => p.group_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'ru', { numeric: true }));
}

const visiblePlans = () => PLAN_ENTRIES.filter((p) => planFilterMatches(p, planFilter));

function planRowHtml(p) {
  return `<div class="rounded-xl border ${p.priority ? 'border-amber-500/40' : 'border-slate-700/50'} bg-slate-800/30 p-3 flex items-start gap-2 ${p.group_name ? 'ml-3' : ''}">
    <input type="checkbox" data-plan-check="${p.id}" class="rounded accent-indigo-500 mt-0.5" ${planTicked.has(p.id) ? 'checked' : ''}>
    <span class="flex-1 text-xs leading-relaxed min-w-0">
      <b>${esc(p.point_id)}</b>${p.point_address ? ' · ' + esc(p.point_address) : ''}
      ${p.priority ? '<span class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300">🟡 Приоритет</span>' : ''}<br>
      <span class="text-slate-400">${esc(p.description) || '—'}</span>
    </span>
    <span class="flex items-center gap-1.5 shrink-0">
      <select data-plan-type="${p.id}" title="Тип работы — можно поставить заранее, и в группе, и без неё" class="rounded-lg px-2 py-1 text-xs" style="max-width:150px">
        <option value="">— тип —</option>${planVisitTypeOptions(p.work_type)}</select>
      <button type="button" data-plan-toggle-priority="${p.id}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Переключить приоритет">${p.priority ? '🟡' : '⚪'}</button>
      <button type="button" data-plan-del-one="${p.id}" class="rounded-lg px-2 py-1 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors">✕</button>
    </span>
  </div>`;
}

// Заголовок группы: отметка «вся группа», название, число точек и действия над группой целиком — тип работы всем, переименовать,
// записать на бригаду разом, расформировать. У записей без группы заголовок «Без группы» без действий.
function planGroupHeaderHtml(g) {
  const allTicked = g.items.length > 0 && g.items.every((p) => planTicked.has(p.id));
  const btn = 'rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors';
  const named = g.name
    ? `<select data-plan-group-type="${esc(g.name)}" title="Поставить тип работы всем точкам группы" class="rounded-lg px-2 py-1 text-xs" style="min-width:200px">
         <option value="">— тип для всей группы —</option>${planVisitTypeOptions('')}</select>
       <button type="button" data-plan-group-rename="${esc(g.name)}" class="${btn}" title="Переименовать группу">✎</button>
       <button type="button" data-plan-group-dissolve="${esc(g.name)}" class="${btn}" title="Расформировать: точки останутся в плане, но без группы">Расформировать</button>
       <button type="button" data-plan-group-assign="${esc(g.name)}" class="ml-auto rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors">В бригаду на день…</button>`
    : '';
  return `<div class="flex flex-wrap items-center gap-2 rounded-xl ${g.name ? 'bg-indigo-500/10 border border-indigo-400/25' : 'bg-slate-800/40 border border-slate-700/40'} px-3 py-2 mt-1">
    <input type="checkbox" data-plan-group-check="${esc(g.name)}" class="rounded accent-indigo-500" ${allTicked ? 'checked' : ''} title="Отметить всю группу">
    <b class="text-sm">${g.name ? '📁 ' + esc(g.name) : 'Без группы'}</b>
    <span class="text-xs text-slate-400">${g.items.length}</span>${named}
  </div>`;
}

async function planManagerForm() {
  planTicked = new Set();
  await loadPlanEntries();
  renderPlanManagerModal();
}

function renderPlanManagerModal() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">План выездов</h2>
    <p class="text-sm text-slate-400 mb-3">Точки, которые нужно посетить, но ещё не привязаны к бригаде/дате. Их можно собирать в группы с подписью и заранее ставить тип работы — потом всю группу записывают на бригаду одним действием.</p>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <button type="button" id="planImportBtn" class="${btnGhost} !py-1.5 !px-3 text-xs">📥 Импорт из Excel</button>
      <a href="/api/point-plans/import-template" download class="text-xs text-indigo-300 hover:underline">Шаблон</a>
      <input type="file" id="planImportFile" accept=".xlsx,.xlsm" class="hidden">
    </div>
    <div id="planImportError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 mb-2"></div>
    <div id="planFilters"></div>
    <div class="space-y-2 mb-2 rounded-xl border border-slate-700/40 bg-slate-800/20 p-2.5">
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1.5 text-xs text-slate-300">
          <input type="checkbox" id="planSelectAll" class="rounded accent-indigo-500"> Все найденные
        </label>
        <span id="planSelectedCount" class="text-xs text-slate-400"></span>
        <button type="button" id="planPrioritySelBtn" class="${btnGhost} !py-1 !px-2.5 text-xs">🟡 Приоритет</button>
        <button type="button" id="planUnprioritySelBtn" class="${btnGhost} !py-1 !px-2.5 text-xs">⚪ Снять приоритет</button>
        <button type="button" id="planDeleteSelBtn" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors">Удалить отмеченные</button>
        <button type="button" id="planAssignSelBtn" class="ml-auto rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors">В бригаду на день…</button>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <input id="planGroupName" list="planGroupOpts" maxlength="60" autocomplete="off" placeholder="Название группы" class="${fieldCls} !py-1 !text-xs" style="width:11rem">
        <datalist id="planGroupOpts">${PLAN_GROUP_NAMES.map((n) => `<option value="${esc(n)}">`).join('')}</datalist>
        <button type="button" id="planGroupSelBtn" class="${btnGhost} !py-1 !px-2.5 text-xs" title="Собрать отмеченные точки в группу с таким названием">📁 В группу</button>
        <button type="button" id="planUngroupSelBtn" class="${btnGhost} !py-1 !px-2.5 text-xs" title="Убрать отмеченные из групп">Из группы</button>
        <span class="text-slate-600">|</span>
        <select id="planTypeSel" class="${fieldCls} !py-1 !text-xs !w-auto"><option value="">— тип работы —</option>${planVisitTypeOptions('')}</select>
        <button type="button" id="planTypeSelBtn" class="${btnGhost} !py-1 !px-2.5 text-xs" title="Поставить этот тип всем отмеченным точкам (в группе они или нет)">Поставить тип</button>
      </div>
    </div>
    <div id="planList" class="space-y-1.5 max-h-[340px] overflow-auto pr-1"></div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`, { wide: true });
  mountPlanFilters($('#planFilters'), PLAN_ENTRIES, planFilter, drawPlanList);
  drawPlanList();
  wirePlanManagerModal();
}

function drawPlanSelectionState() {
  const list = visiblePlans();
  $('#planSelectAll').checked = list.length > 0 && list.every((p) => planTicked.has(p.id));
  $('#planSelectedCount').textContent = planTicked.size ? `Выбрано: ${planTicked.size}` : '';
}

function drawPlanList() {
  const list = visiblePlans();
  $('#planList').innerHTML = planGroupsOf(list).map((g) => planGroupHeaderHtml(g) + g.items.map(planRowHtml).join('')).join('')
    || `<p class="text-sm text-slate-500 text-center py-6">${PLAN_ENTRIES.length ? 'Ничего не найдено' : 'Планов пока нет.'}</p>`;
  drawPlanSelectionState();
}

// Перечитать план и перерисовать окно (отметки сохраняются).
async function planRefresh() {
  await loadPlanEntries();
  renderPlanManagerModal();
}

const planIdsOfGroup = (name) => PLAN_ENTRIES.filter((p) => (p.group_name || '') === name).map((p) => p.id);

function wirePlanManagerModal() {
  $('#planSelectAll').onchange = (e) => {
    visiblePlans().forEach((p) => { if (e.target.checked) planTicked.add(p.id); else planTicked.delete(p.id); });
    drawPlanList();
  };
  $('#planImportBtn').onclick = () => $('#planImportFile').click();
  $('#planImportFile').onchange = async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    const fd = new FormData();
    fd.append('file', f);
    try {
      const res = await Api.upload('/api/point-plans/import', fd);
      await planRefresh();
      const lines = [`Импортировано записей: ${res.created}.`];
      if (res.skipped_points?.length) lines.push(`Такие точки уже в плане (пропущены): ${res.skipped_points.slice(0, 30).join(', ')}${res.skipped_points.length > 30 ? '…' : ''}.`);
      if (res.row_errors?.length) lines.push('', 'Ошибки:', ...res.row_errors.slice(0, 20));
      alert(lines.join('\n'));
    } catch (err) {
      $('#planImportError').textContent = 'Не удалось импортировать: ' + err.message;
      $('#planImportError').classList.remove('hidden');
    }
  };
  $('#planPrioritySelBtn').onclick = () => setPrioritySelected(true);
  $('#planUnprioritySelBtn').onclick = () => setPrioritySelected(false);
  $('#planDeleteSelBtn').onclick = () => deleteSelectedPlans();
  $('#planAssignSelBtn').onclick = () => assignSelectedPlansForm();
  $('#planGroupSelBtn').onclick = () => {
    const name = $('#planGroupName').value.trim();
    if (!name) { alert('Впишите название группы.'); return; }
    planSetGroup([...planTicked], name);
  };
  $('#planUngroupSelBtn').onclick = () => planSetGroup([...planTicked], '');
  $('#planTypeSelBtn').onclick = () => {
    const type = $('#planTypeSel').value;
    if (!type) { alert('Выберите тип работы.'); return; }
    planSetType([...planTicked], type);
  };

  $('#planList').onclick = (e) => {
    const tog = e.target.closest('[data-plan-toggle-priority]');
    const del = e.target.closest('[data-plan-del-one]');
    const ren = e.target.closest('[data-plan-group-rename]');
    const dis = e.target.closest('[data-plan-group-dissolve]');
    const asg = e.target.closest('[data-plan-group-assign]');
    if (tog) togglePlanPriority(+tog.dataset.planTogglePriority);
    if (del) deleteOnePlan(+del.dataset.planDelOne);
    if (ren) planRenameGroup(ren.dataset.planGroupRename);
    if (dis) planDissolveGroup(dis.dataset.planGroupDissolve);
    if (asg) {                                    // вся группа (а не только найденное фильтром) — на бригаду
      planTicked = new Set(planIdsOfGroup(asg.dataset.planGroupAssign));
      assignSelectedPlansForm();
    }
  };
  $('#planList').onchange = (e) => {
    const chk = e.target.closest('[data-plan-check]');
    const gchk = e.target.closest('[data-plan-group-check]');
    const typeSel = e.target.closest('[data-plan-type]');
    const groupType = e.target.closest('[data-plan-group-type]');
    if (chk) {
      const id = +chk.dataset.planCheck;
      if (chk.checked) planTicked.add(id); else planTicked.delete(id);
      drawPlanList();
    } else if (gchk) {
      const name = gchk.dataset.planGroupCheck;
      visiblePlans().filter((p) => (p.group_name || '') === name).forEach((p) => { if (gchk.checked) planTicked.add(p.id); else planTicked.delete(p.id); });
      drawPlanList();
    } else if (typeSel) {
      planSetType([+typeSel.dataset.planType], typeSel.value, { quiet: true });
    } else if (groupType) {
      if (groupType.value) planSetType(planIdsOfGroup(groupType.dataset.planGroupType), groupType.value);
    }
  };
}

// Собрать записи в группу (пустое имя — убрать из группы).
async function planSetGroup(ids, name) {
  if (!ids.length) { alert('Отметьте хотя бы одну запись.'); return; }
  try {
    await Api.post('/api/point-plans/group', { plan_ids: ids, name });
    await planRefresh();
  } catch (err) { alert(err.message); }
}

// Поставить тип работы записям (quiet — не перерисовывать список, когда правят одну строку).
async function planSetType(ids, type, { quiet = false } = {}) {
  if (!ids.length) { alert('Отметьте хотя бы одну запись.'); return; }
  try {
    await Api.post('/api/point-plans/work-type', { plan_ids: ids, type });
    if (quiet) { PLAN_ENTRIES.forEach((p) => { if (ids.includes(p.id)) p.work_type = type; }); return; }
    await planRefresh();
  } catch (err) { alert(err.message); await planRefresh(); }
}

async function planRenameGroup(name) {
  const next = prompt('Новое название группы', name);
  if (next === null) return;
  const clean = next.trim();
  if (!clean || clean === name) return;
  planSetGroup(planIdsOfGroup(name), clean);
}

async function planDissolveGroup(name) {
  if (!confirm(`Расформировать группу «${name}»? Точки останутся в плане, но без группы.`)) return;
  planSetGroup(planIdsOfGroup(name), '');
}

async function setPrioritySelected(priority) {
  const ids = [...planTicked];
  if (!ids.length) { alert('Отметьте хотя бы одну запись.'); return; }
  try {
    await Api.post('/api/point-plans/priority', { plan_ids: ids, priority });
    await planRefresh();
  } catch (err) { alert(err.message); }
}

async function togglePlanPriority(id) {
  const p = PLAN_ENTRIES.find((x) => x.id === id);
  if (!p) return;
  try {
    await Api.post('/api/point-plans/priority', { plan_ids: [id], priority: !p.priority });
    await planRefresh();
  } catch (err) { alert(err.message); }
}

async function deleteOnePlan(id) {
  if (!confirm('Убрать точку из плана?')) return;
  try {
    await Api.del(`/api/point-plans/${id}`);
    await planRefresh();
  } catch (err) { alert(err.message); }
}

async function deleteSelectedPlans() {
  const ids = [...planTicked];
  if (!ids.length) { alert('Отметьте хотя бы одну запись.'); return; }
  if (!confirm(`Удалить выбранные записи (${ids.length}) из плана?`)) return;
  try {
    await Promise.all(ids.map((id) => Api.del(`/api/point-plans/${id}`)));
    await planRefresh();
  } catch (err) { alert(err.message); }
}

const todayIso = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// Окно с типом работы по каждой точке, датой и бригадой — то же самое, что
// при импорте KML. Тип, заранее поставленный в плане, уже выбран (его можно
// поменять). Сами задания создаются на сервере одним запросом
// (routes_point_plans.py::assign_point_plans), а не через /api/state: у этой
// страницы нет календарного состояния. После успеха менеджер плана
// открывается заново, чтобы можно было сразу продолжить с остальными.
function assignSelectedPlansForm() {
  const sel = PLAN_ENTRIES.filter((p) => planTicked.has(p.id));
  if (!sel.length) { alert('Отметьте хотя бы одну точку в списке.'); return; }
  const groups = [...new Set(sel.map((p) => p.group_name || ''))];
  const groupNote = groups.length === 1 && groups[0] ? ` · группа «${groups[0]}»` : '';
  bulkAssignForm({
    title: `В бригаду на день${groupNote} · точек: ${sel.length}`,
    items: sel.map((p) => ({
      key: p.id, label: p.point_id, type: p.work_type || '',
      sub: [groups.length > 1 && p.group_name ? '📁 ' + p.group_name : '', p.point_address, p.description].filter(Boolean).join(' · '),
    })),
    date: todayIso(),
    crewId: null,
    onSubmit: async (r) => {
      const res = await Api.post('/api/point-plans/assign', {
        items: r.items.map((i) => ({ plan_id: i.key, type: i.type })), date: r.date, team: r.team, hours: r.hours, travel: r.travel,
      });
      planTicked.clear();
      alert(assignResultMessage(res));
      setTimeout(planManagerForm, 0);
    },
  });
}

// ---------- Карта: та же выборка (поиск/фильтры), что и список, только
// без пагинации ("Показать ещё" тут не нужно — все совпадающие точки с
// координатами сразу видны на карте). Движок — Яндекс.Карты (JS API),
// ключ приходит из data-yandex-maps-key на <body> (см. app/config.py::
// yandex_maps_api_key, задаётся в .env на сервере) — у операторов и
// сервера есть интернет, так что настоящая подложка (улицы/спутник), а
// не абстрактный разброс точек.

function apkMapQueryString() {
  const params = new URLSearchParams();
  if (apkFilters.search) params.set('search', apkFilters.search);
  if (apkFilters.categories.has('__none__')) params.set('uncategorized', 'true');
  apkFilters.categories.forEach((v) => { if (v !== '__none__') params.append('category_id', v); });
  apkFilters.statuses.forEach((v) => params.append('status', v));
  if (apkFilters.sort) params.set('sort', apkFilters.sort);
  if (apkFilters.certificate) params.set('certificate', apkFilters.certificate);
  if (apkFilters.groupId != null) params.set('group_id', apkFilters.groupId);
  // Намеренно без limit/offset — routes_points.list_points() без них (но
  // с хотя бы одним другим фильтром) отдаёт ВСЕ совпадающие строки разом.
  return params.toString();
}

let apkMapLoadSeq = 0;
async function loadApkMapData() {
  const qs = apkMapQueryString();
  const mine = ++apkMapLoadSeq;
  const { items, total } = await Api.getPage(`/api/points${qs ? '?' + qs : ''}`);
  // При плохой связи ответы приходят не по порядку: пока ждали этот, мог уйти и вернуться более новый запрос (другие фильтры, свежие
  // данные). Устаревший ответ выбрасываем — иначе метки то появлялись бы, то пропадали.
  if (mine !== apkMapLoadSeq) return false;
  apkMapMissingCount = total - items.filter((p) => _hasCoords(p)).length;
  apkMapPoints = items.filter((p) => _hasCoords(p));
  const el = $('#apkTotalCount');
  if (el) el.textContent = `(${total})`;
  return true;
}

function _hasCoords(p) {
  const lat = parseFloat(p.lat), lon = parseFloat(p.lon);
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

// ---------- Поиск на карте: подсказки без перерисовки карты ----------
// Раньше набор текста в поиске (даже с задержкой) в итоге пересобирал
// всю карту на каждую паузу — масштаб/положение постоянно сбивались.
// Теперь ввод только подгружает подсказки (номер + адрес), а сама карта
// не трогается, пока не выбрана конкретная точка (клик по подсказке или
// Enter) — см. #apkSearch.oninput/.keydown в renderApkPage().

async function loadApkSearchSuggestions(query) {
  const q = query.trim();
  if (!q) { apkSearchSuggestions = []; hideApkSearchDropdown(); return; }
  const params = new URLSearchParams();
  params.set('search', q);
  params.set('limit', '8');
  if (apkFilters.categories.has('__none__')) params.set('uncategorized', 'true');
  apkFilters.categories.forEach((v) => { if (v !== '__none__') params.append('category_id', v); });
  apkFilters.statuses.forEach((v) => params.append('status', v));
  if (apkFilters.certificate) params.set('certificate', apkFilters.certificate);
  if (apkFilters.groupId != null) params.set('group_id', apkFilters.groupId);
  let items;
  try {
    ({ items } = await Api.getPage(`/api/points?${params.toString()}`));
  } catch {
    return;
  }
  // Поле могли уже очистить/поменять, пока шёл запрос — не показываем
  // подсказки, устаревшие относительно текущего текста.
  if (($('#apkSearch')?.value || '').trim() !== q) return;
  apkSearchSuggestions = items;
  renderApkSearchDropdown(items);
}

function renderApkSearchDropdown(items) {
  const box = $('#apkSearchDropdown');
  if (!box) return;
  if (!items.length) { hideApkSearchDropdown(); return; }
  box.innerHTML = items.map((p) => `
    <div data-suggest="${esc(p.id)}" class="px-3 py-2 text-sm cursor-pointer hover:bg-slate-700/60">
      <b>${esc(p.id)}</b>${p.address ? ` <span class="text-slate-400">· ${esc(p.address)}</span>` : ''}
    </div>`).join('');
  box.querySelectorAll('[data-suggest]').forEach((el) => {
    el.onclick = () => apkLocatePoint(el.dataset.suggest);
  });
  box.classList.remove('hidden');
}

function hideApkSearchDropdown() {
  const box = $('#apkSearchDropdown');
  if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
}

// Выбор точки (клик по подсказке или Enter) — ПОКАЗЫВАЕТ её на карте:
// центрирует, приближает и открывает над меткой выноску с номером, адресом
// и статусом; карточка с кнопками открывается только по клику на саму метку.
// Список меток на карте при этом не сужается (это не применение фильтра, а
// просто "показать эту точку").
function apkLocatePoint(pointId) {
  hideApkSearchDropdown();
  const input = $('#apkSearch');
  if (input) input.value = pointId;
  const note = $('#apkLocateNote');
  const showNote = (text) => { if (note) { note.textContent = text; note.classList.toggle('hidden', !text); } };
  const placemark = apkMapPlacemarks.get(pointId);
  if (!apkYmap || !placemark) {
    const found = apkSearchSuggestions.find((x) => x.id === pointId);
    showNote(found && !_hasCoords(found)
      ? `У комплекса ${pointId} не указаны координаты — на карте его показать нельзя.`
      : `Комплекс ${pointId} не показан на карте — проверьте фильтры над картой.`);
    return;
  }
  showNote('');
  apkYmap.setCenter(placemark.geometry.getCoordinates(), Math.max(apkYmap.getZoom(), 15), { checkZoomRange: true, duration: 300 });
  try {
    const state = apkClusterer && apkClusterer.getObjectState(placemark);
    if (state && state.isClustered) openApkMapStack(pointId);             // метка внутри группы — обычная карточка (или несколько по одному), а не текстовая выноска
    else placemark.balloon.open();
  } catch { /* выноска не открылась — метка всё равно показана по центру */ }
}

// Once — не в renderApkPage() (который перевызывается на каждый
// перерендер), иначе на document накапливались бы дубликаты слушателя.
document.addEventListener('click', (e) => {
  if (!e.target.closest('#apkSearch') && !e.target.closest('#apkSearchDropdown')) hideApkSearchDropdown();
});

// Скрипт Яндекс.Карт грузится один раз за всю сессию страницы (переключение
// список↔карта туда-обратно не должно повторно вставлять тег <script>).
let _yandexMapsLoadPromise = null;
function loadYandexMapsApi(apiKey) {
  // Один общий «обещанный» результат на всех: пока скрипт ещё грузится (или модули карты не готовы — ymaps.ready), повторный вызов
  // раньше получал window.ymaps сразу, и `new ymaps.Map` падал — на медленной связи карта то появлялась, то нет.
  if (_yandexMapsLoadPromise) return _yandexMapsLoadPromise;
  _yandexMapsLoadPromise = new Promise((resolve, reject) => {
    const fail = (text) => { _yandexMapsLoadPromise = null; reject(new Error(text)); };
    const ready = () => window.ymaps.ready(() => resolve(window.ymaps));
    if (window.ymaps) { ready(); return; }
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    const timer = setTimeout(() => { script.remove(); fail('Яндекс.Карты не загрузились за 40 секунд — проверьте интернет-соединение'); }, 40000);
    script.onload = () => { clearTimeout(timer); ready(); };
    script.onerror = () => { clearTimeout(timer); script.remove(); fail('Не удалось загрузить Яндекс.Карты — проверьте интернет-соединение и ключ API'); };
    document.head.appendChild(script);
  });
  return _yandexMapsLoadPromise;
}

let apkYmap = null;                    // текущий экземпляр ymaps.Map, пока открыт вид "Карта"
let apkClusterer = null;               // ymaps.Clusterer: при малом масштабе метки сливаются в кружки с числом — карта не тормозит
let apkMapPlacemarks = new Map();      // pointId -> ymaps.Placemark, для точечного обновления вместо пересоздания карты
let apkMapSig = new Map();             // pointId -> подпись (координаты, цвет, выбор…): что изменилось с прошлого обновления
let apkClusterOn = (() => { try { return localStorage.getItem('apkCluster') !== '0'; } catch { return true; } })();

// Подсказка при наведении и выноска над меткой (её открывает поиск по Enter /
// клику на подсказку — см. apkLocatePoint): номер, адрес и статус цветом
// из «Настройки → Статусы АПК».
function _placemarkProps(p, color) {
  const status = p.status ? statusLabel(p.status, p.stock_partial) : UNKNOWN_STATUS;
  const stock = stockPartialText(p);
  return {
    pointId: p.id,
    hintContent: `${p.id}${p.address ? ' · ' + p.address : ''}${p.stock_partial ? ' · частично на складе' : ''}${p.group_work_type ? ' · ' + p.group_work_type : ''}`,
    balloonContentHeader: `<b>${esc(p.id)}</b>`,
    balloonContentBody: `${p.address ? esc(p.address) + '<br>' : ''}<span style="color:${color};font-weight:600">● ${esc(status)}</span>${stock ? '<br><span style="font-size:12px">' + esc(stock) + '</span>' : ''}`
      + `${p.group_work_type ? '<br><span style="font-size:12px">Тип работы: ' + esc(p.group_work_type) + '</span>' : ''}${p.group_note ? '<br><span style="font-size:12px">' + esc(p.group_note) + '</span>' : ''}${p.group_need ? '<br><span style="font-size:12px"><b>Нужно:</b> ' + esc(p.group_need) + '</span>' : ''}`
      + `${p.fault_reason || p.fault_need ? '<br><span style="font-size:12px;color:#b45309">⚠ ' + esc([p.fault_reason ? 'Почему: ' + p.fault_reason : '', p.fault_need ? 'Нужно: ' + p.fault_need : ''].filter(Boolean).join(' · ')) + '</span>' : ''}`,
    balloonContentFooter: '<span style="color:#64748b;font-size:11px">Нажмите на метку — карточка комплекса</span>',
  };
}

// Метка комплекса «Частично на складе»: кружок цвета статуса, закрашенный наполовину (обычная метка — сплошной кружок).
const _partialIconCache = new Map();
function _partialIconHref(color, selected) {
  const key = color + (selected ? '*' : '');
  if (!_partialIconCache.has(key)) {
    const ring = selected ? '<circle cx="14" cy="14" r="12.5" fill="none" stroke="#0f172a" stroke-width="2"/>' : '';
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">${ring}<circle cx="14" cy="14" r="8.5" fill="#fff" stroke="${color}" stroke-width="3"/><path d="M14 5.5a8.5 8.5 0 0 0 0 17z" fill="${color}"/></svg>`;
    _partialIconCache.set(key, 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg));
  }
  return _partialIconCache.get(key);
}

function _placemarkColor(p) {
  return (_pointStatusCache[p.status] && _pointStatusCache[p.status].color) || '#64748b';
}

// Добавляет/красит/убирает метки под текущий apkMapPoints, не трогая
// карту саму по себе (масштаб/положение) — используется и при первой
// отрисовке, и при живом 5с обновлении, и после выделения области.
// Меняется только то, что действительно изменилось (подпись метки) — у 3000
// комплексов повторное обновление при тех же данных ничего не перерисовывает.
function _placemarkOptions(p, color) {
  const selected = apkSelected.has(p.id);
  if (p.stock_partial) {
    return { iconLayout: 'default#image', iconImageHref: _partialIconHref(color, selected), iconImageSize: [28, 28], iconImageOffset: [-14, -14], openBalloonOnClick: false };
  }
  return { preset: selected ? 'islands#circleDotIcon' : 'islands#circleIcon', iconColor: color, openBalloonOnClick: false };
}
function _applyPlacemarkOptions(placemark, p, color) {
  placemark.options.unset(['iconLayout', 'iconImageHref', 'iconImageSize', 'iconImageOffset']);     // метка могла быть «частично на складе» и перестать
  placemark.options.set(_placemarkOptions(p, color));
}

function _syncMapPlacemarks() {
  if (!apkYmap || !window.ymaps) return;
  const seen = new Set();
  const toAdd = [];
  for (const p of apkMapPoints) {
    seen.add(p.id);
    const lat = parseFloat(p.lat), lon = parseFloat(p.lon);
    const color = _placemarkColor(p);
    const sig = `${lat},${lon},${color},${apkSelected.has(p.id) ? 1 : 0},${p.status || ''},${p.address || ''},${p.stock_partial ? 1 : 0},${(p.stock_in || []).join('|')},${(p.stock_out || []).join('|')},${p.group_work_type || ''}|${p.group_note || ''}|${p.group_need || ''}|${p.fault_reason || ''}|${p.fault_need || ''}`;
    const existing = apkMapPlacemarks.get(p.id);
    if (existing) {
      if (apkMapSig.get(p.id) === sig) continue;
      existing.geometry.setCoordinates([lat, lon]);
      existing.properties.set(_placemarkProps(p, color));
      _applyPlacemarkOptions(existing, p, color);
    } else {
      const placemark = new window.ymaps.Placemark([lat, lon], _placemarkProps(p, color), _placemarkOptions(p, color));
      placemark.events.add('click', () => openApkMapStack(p.id));
      apkMapPlacemarks.set(p.id, placemark);
      toAdd.push(placemark);
    }
    apkMapSig.set(p.id, sig);
  }
  const toRemove = [];
  for (const [id, placemark] of apkMapPlacemarks) {
    if (!seen.has(id)) {
      toRemove.push(placemark);
      apkMapPlacemarks.delete(id);
      apkMapSig.delete(id);
    }
  }
  if (apkClusterer) {
    if (toAdd.length) apkClusterer.add(toAdd);
    if (toRemove.length) apkClusterer.remove(toRemove);
  } else {
    toAdd.forEach((pm) => apkYmap.geoObjects.add(pm));
    toRemove.forEach((pm) => apkYmap.geoObjects.remove(pm));
  }
}

// Включает/выключает группировку меток (кружки с числом при малом масштабе): метки переезжают из группировщика на карту и обратно.
function apkSetClustering(on) {
  apkClusterOn = on;
  try { localStorage.setItem('apkCluster', on ? '1' : '0'); } catch { /* не страшно */ }
  if (!apkYmap) return;
  const pins = [...apkMapPlacemarks.values()];
  if (apkClusterer) { apkClusterer.removeAll(); apkYmap.geoObjects.remove(apkClusterer); apkClusterer = null; }
  else pins.forEach((pm) => apkYmap.geoObjects.remove(pm));
  _attachMapLayer(pins);
}

function _attachMapLayer(pins) {
  if (apkClusterOn) {
    apkClusterer = new window.ymaps.Clusterer({
      preset: 'islands#invertedDarkBlueClusterIcons', groupByCoordinates: false, gridSize: 72,
      clusterDisableClickZoom: true, clusterHasBalloon: false, geoObjectHideIconOnBalloonOpen: false,
    });
    apkClusterer.events.add('click', _onMapClusterClick);
    apkClusterer.add(pins);
    apkYmap.geoObjects.add(apkClusterer);
  } else {
    pins.forEach((pm) => apkYmap.geoObjects.add(pm));
  }
}

function apkMapLegendHtml() {
  const statuses = [...new Set(apkMapPoints.map((p) => p.status || UNKNOWN_STATUS))];
  const dot = (color, half) => `<span class="inline-block h-2.5 w-2.5 rounded-full" style="${half ? `background:linear-gradient(90deg, ${color} 50%, #fff 50%); border:1.5px solid ${color}` : `background:${color}`}"></span>`;
  const items = statuses.map((s) => `<span class="inline-flex items-center gap-1.5 text-xs text-slate-400">${dot((_pointStatusCache[s] && _pointStatusCache[s].color) || '#64748b', false)}${esc(s)}</span>`);
  const partial = apkMapPoints.filter((p) => p.stock_partial).length;
  if (partial) {
    const color = (_pointStatusCache['На складе'] && _pointStatusCache['На складе'].color) || '#64748b';
    items.push(`<span class="inline-flex items-center gap-1.5 text-xs text-slate-400" title="Комплекс «На складе», у которого не все компоненты лежат на складе — что именно, видно в карточке">${dot(color, true)}Частично на складе · ${partial}</span>`);
  }
  return items.join('');
}

function _updateApkMapChrome() {
  const note = $('#apkMapMissingNote');
  if (note) {
    note.textContent = apkMapMissingCount
      ? `${apkMapMissingCount} точ${apkMapMissingCount === 1 ? 'ка' : 'ек'} без координат не показан${apkMapMissingCount === 1 ? 'а' : 'ы'} на карте`
      : '';
  }
  const legend = $('#apkMapLegend');
  if (legend) legend.innerHTML = apkMapLegendHtml();
}

function destroyApkMap() {
  if (apkYmap) { apkYmap.destroy(); apkYmap = null; }
  apkClusterer = null;
  apkMapPlacemarks = new Map();
  apkMapSig = new Map();
  if (typeof apkSelDestroy === 'function') apkSelDestroy();
}

// Подключает кнопки карточки комплекса (✎, 🕘, 📌, пинг/порт/веб-интерфейс, отметка выбора) внутри окна на карте.
function wireApkPopupRow(box) {
  wireApkGroupBoxes(box);
  box.querySelectorAll('[data-edit]').forEach((btn) => { btn.onclick = () => apkPointForm(btn.dataset.edit); });
  box.querySelectorAll('[data-journal]').forEach((btn) => { btn.onclick = () => openVisitJournal(btn.dataset.journal); });
  box.querySelectorAll('[data-plan]').forEach((btn) => { btn.onclick = () => addToPlanForm(btn.dataset.plan); });
  box.querySelectorAll('[data-apk-check]').forEach((chk) => {
    chk.onchange = () => {
      const p = apkMapPoints.find((x) => x.id === chk.dataset.apkCheck);
      if (!p) return;
      if (chk.checked) apkSelected.set(p.id, p); else apkSelected.delete(p.id);
      _syncMapPlacemarks();
      renderApkSelectionBar();
      if (typeof apkSelRenderTools === 'function') apkSelRenderTools();
    };
  });
  wirePointNetButtons(box, (id) => apkMapPoints.find((x) => x.id === id));
}

// Открывает те же данные/кнопки, что и строка списка (apkRowHtml) — "всей
// информации о точке и кнопки изменения данных" из карты, без отдельного
// read-only представления.
function openApkMapPopup(pointId) {
  const p = apkMapPoints.find((x) => x.id === pointId);
  if (!p) return;
  modal(`<h2 class="font-display text-lg font-bold mb-4">АПК ${esc(p.id)}</h2>
    <div id="apkMapPopupRow">${apkRowHtml(p)}</div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);
  wireApkPopupRow($('#apkMapPopupRow'));
}

// Метки комплексов с одинаковыми координатами (или так близкими, что на текущем масштабе лежат друг на друге) закрывают
// одна другую. Поэтому клик собирает ВСЕ комплексы рядом с меткой — те же координаты плюс всё, что в пределах
// APK_MAP_STACK_PX пикселей на нынешнем масштабе, — и показывает их по одному: у каждого обычная карточка со всеми кнопками,
// переключатель сверху («‹ 2 из 3 ›» и вкладки с номерами).
const APK_MAP_STACK_PX = 16;

function apkMapPointsNear(pointId) {
  const base = apkMapPoints.find((x) => x.id === pointId);
  if (!base) return [];
  const lat0 = parseFloat(base.lat);
  const lon0 = parseFloat(base.lon);
  const same = (p) => parseFloat(p.lat) === lat0 && parseFloat(p.lon) === lon0;
  let near = apkMapPoints.filter(same);
  try {
    const projection = apkYmap.options.get('projection');
    const zoom = apkYmap.getZoom();
    const [bx, by] = projection.toGlobalPixels([lat0, lon0], zoom);
    near = apkMapPoints.filter((p) => {
      if (same(p)) return true;
      const [x, y] = projection.toGlobalPixels([parseFloat(p.lat), parseFloat(p.lon)], zoom);
      return Math.hypot(x - bx, y - by) <= APK_MAP_STACK_PX;
    });
  } catch { /* проекция карты недоступна — остаются комплексы с теми же координатами */ }
  return near.sort((a, b) => (a.id === pointId ? -1 : b.id === pointId ? 1 : a.id.localeCompare(b.id, 'ru', { numeric: true })));
}

// Клик по метке (или по группе меток на одном месте): один комплекс — обычное окно, несколько — те же карточки по одному.
// ids — явный список (клик по группе меток); без него соседи ищутся по координатам.
function openApkMapStack(pointId, ids) {
  const group = ids ? ids.map((id) => apkMapPoints.find((x) => x.id === id)).filter(Boolean) : apkMapPointsNear(pointId);
  if (group.length < 2) { openApkMapPopup(group[0] ? group[0].id : pointId); return; }
  let cur = Math.max(0, group.findIndex((p) => p.id === pointId));
  modal(`<h2 class="font-display text-lg font-bold mb-1">Комплексы в этой точке · ${group.length}</h2>
    <p class="text-xs text-slate-400 mb-3">Метки лежат друг на друге (одинаковые или почти одинаковые координаты). Переключайте комплексы стрелками или по номеру — у каждого своя карточка со всеми кнопками.</p>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <button type="button" id="apkStackPrev" class="${btnGhost} !px-3 !py-1.5" title="Предыдущий комплекс">‹</button>
      <span id="apkStackPos" class="text-xs text-slate-400 text-center" style="min-width:4.5rem"></span>
      <button type="button" id="apkStackNext" class="${btnGhost} !px-3 !py-1.5" title="Следующий комплекс">›</button>
      <div id="apkStackTabs" class="flex flex-wrap gap-1.5"></div>
    </div>
    <div id="apkStackBody"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);
  const draw = () => {
    const p = group[cur];
    $('#apkStackPos').textContent = `${cur + 1} из ${group.length}`;
    $('#apkStackTabs').innerHTML = group.map((q, i) => `<button type="button" data-stack="${i}" class="rounded-lg px-2.5 py-1 text-xs border transition-colors ${i === cur ? 'border-indigo-400 bg-indigo-500/25 font-semibold' : 'border-slate-700 bg-slate-800/60 hover:bg-slate-700/60'}">
      <span class="inline-block h-2 w-2 rounded-full mr-1" style="background:${_placemarkColor(q)}"></span>${esc(q.id)}</button>`).join('');
    $('#apkStackBody').innerHTML = `<h3 class="font-display text-base font-bold mb-2">АПК ${esc(p.id)}</h3><div id="apkMapPopupRow">${apkRowHtml(p)}</div>`;
    $('#apkStackTabs').querySelectorAll('[data-stack]').forEach((b) => { b.onclick = () => { cur = parseInt(b.dataset.stack, 10); draw(); }; });
    wireApkPopupRow($('#apkMapPopupRow'));
  };
  $('#apkStackPrev').onclick = () => { cur = (cur - 1 + group.length) % group.length; draw(); };
  $('#apkStackNext').onclick = () => { cur = (cur + 1) % group.length; draw(); };
  draw();
}

// Клик по кружку-группе меток: если все метки в нём лежат друг на друге (или масштаб уже максимальный) — открываем их по одному,
// иначе приближаем карту к группе, чтобы метки разошлись.
function _onMapClusterClick(e) {
  const target = e.get('target');
  if (!target || typeof target.getGeoObjects !== 'function') return;       // одиночную метку обрабатывает она сама
  const ids = target.getGeoObjects().map((o) => o.properties.get('pointId')).filter(Boolean);
  if (!ids.length) return;
  let tight = false;
  try {
    const projection = apkYmap.options.get('projection'), zoom = apkYmap.getZoom();
    const px = ids.map((id) => apkMapPoints.find((x) => x.id === id)).filter(Boolean).map((p) => projection.toGlobalPixels([parseFloat(p.lat), parseFloat(p.lon)], zoom));
    const xs = px.map((q) => q[0]), ys = px.map((q) => q[1]);
    tight = Math.max(...xs) - Math.min(...xs) <= APK_MAP_STACK_PX && Math.max(...ys) - Math.min(...ys) <= APK_MAP_STACK_PX;
  } catch { tight = false; }
  if (tight || apkYmap.getZoom() >= 18) openApkMapStack(ids[0], ids);
  else apkYmap.setBounds(target.getBounds(), { checkZoomRange: true, zoomMargin: 70, duration: 250 });
}

let apkMapRerender = false;       // пока карта строилась, фильтры/вид поменяли — после неё строим ещё раз уже по новым условиям
async function renderApkMap() {
  if (apkMapBusy) { apkMapRerender = true; return; }
  apkMapBusy = true;
  try {
    do { apkMapRerender = false; await _renderApkMap(); } while (apkMapRerender);
  } finally { apkMapBusy = false; }
}

// Пометка «нет связи» над картой: метки при этом остаются на месте — показаны последние полученные данные.
function setApkMapNetNote(text) {
  const el = $('#apkMapNetNote');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}
const _clock = () => new Date().toLocaleTimeString('ru-RU');

async function _renderApkMap() {
  const apiKey = document.body.dataset.yandexMapsKey || '';
  if (!apiKey) {
    destroyApkMap();
    $('#apkContentArea').innerHTML = '<p class="text-sm text-amber-300 text-center py-10">Карта не настроена — добавьте YANDEX_MAPS_API_KEY в .env на сервере и перезапустите приложение.</p>';
    return;
  }
  // Карта уже на экране (меняли фильтры, повторное построение): пока грузятся новые данные, она остаётся как есть. Раньше её
  // сносили сразу — при медленном ответе или обрыве связи метки пропадали и пустой экран висел до конца ожидания.
  const hadMap = !!apkYmap && !!$('#apkMap');
  if (!hadMap) {
    destroyApkMap();
    $('#apkContentArea').innerHTML = '<p class="text-sm text-slate-500 text-center py-10">Загружаю карту…</p>';
  }
  let fresh;
  try {
    fresh = await loadApkMapData();
  } catch (e) {
    if (hadMap) { setApkMapNetNote(`Нет связи с сервером (${e.message}) — на карте последние полученные метки. Повторю автоматически · ${_clock()}`); return; }
    $('#apkContentArea').innerHTML = `<div class="text-center py-10"><p class="text-sm text-rose-400 mb-3">Не удалось загрузить: ${esc(e.message)}</p><button type="button" id="apkMapRetry" class="${btnGhost}">Повторить</button><p class="text-xs text-slate-500 mt-2">Попробую ещё раз и сама, через несколько секунд.</p></div>`;
    $('#apkMapRetry').onclick = () => renderApkMap();
    return;
  }
  if (!fresh) return;                                   // пришёл устаревший ответ — свежий построит карту сам
  if (hadMap) destroyApkMap();                          // данные получены — теперь можно перестроить
  $('#apkContentArea').innerHTML = `
    <p id="apkMapNetNote" class="hidden text-xs text-amber-300 mb-2"></p>
    <p id="apkMapMissingNote" class="text-xs text-slate-500 mb-2"></p>
    <p id="apkLocateNote" class="hidden text-xs text-amber-300 mb-2"></p>
    <div id="apkMapWrap" class="relative">
      <div id="apkMap" class="rounded-xl border border-slate-700/50 overflow-hidden" style="height:560px"></div>
      <div id="apkMapTools" class="absolute z-10 flex flex-wrap items-center gap-1.5" style="top:10px; left:56px; max-width:calc(100% - 150px)"></div>
      <p id="apkSelHint" class="hidden absolute z-10 rounded-lg px-2.5 py-1 text-xs" style="bottom:34px; left:10px; background:rgba(15,23,42,.9); color:#f1f5f9"></p>
      <div id="apkSelLayer" style="display:none; position:absolute; inset:0; z-index:5; cursor:crosshair; touch-action:none; border-radius:12px"></div>
    </div>
    <div id="apkMapLegend" class="flex flex-wrap items-center gap-3 mt-3"></div>`;
  _updateApkMapChrome();

  if (!apkMapPoints.length) {
    $('#apkMap').innerHTML = '<p class="text-sm text-slate-500 text-center py-10">Нет точек с указанными координатами</p>';
    return;
  }

  let ymaps;
  try {
    ymaps = await loadYandexMapsApi(apiKey);
  } catch (e) {
    $('#apkMap').innerHTML = `<p class="text-sm text-rose-400 text-center py-10">${esc(e.message)}</p>`;
    return;
  }
  // Вид могли переключить обратно на список, пока грузился SDK — не
  // рисуем карту в уже отсоединённый/подменённый контейнер.
  if (apkView !== 'map' || !$('#apkMap')) return;

  apkYmap = new ymaps.Map('apkMap', {
    center: [55.75, 37.61], zoom: 9, controls: ['zoomControl', 'fullscreenControl'],
  });
  _attachMapLayer([]);
  _syncMapPlacemarks();
  try {
    const bounds = apkClusterer ? apkClusterer.getBounds() : apkYmap.geoObjects.getBounds();
    if (bounds) apkYmap.setBounds(bounds, { checkZoomRange: true, zoomMargin: 40 });
  } catch { /* границы не посчитались — остаётся вид по умолчанию */ }
  if (apkCanSelect() && typeof apkSelInit === 'function') {
    apkSelInit();
    apkSelRenderTools();
  }
  renderApkSelectionBar();
}

// 5с живое обновление карты — в отличие от списка, НЕ пересоздаёт карту
// (это сбросило бы масштаб/положение, которое диспетчер мог покрутить
// руками), только точечно обновляет метки под свежие данные.
let apkMapBusy = false;           // карта сейчас строится (грузится скрипт Яндекса, данные) — второй раз её строить нельзя
let apkMapRefreshing = false;    // идёт живое обновление меток — следующий опрос его не перебивает
async function refreshApkMap() {
  if (apkMapBusy || apkMapRefreshing) return;       // раньше на медленной связи опрос каждые 5 с запускал построение карты заново, не дожидаясь первого, и метки сносились
  if (!apkYmap) { await renderApkMap(); return; }
  apkMapRefreshing = true;
  try {
    if (!(await loadApkMapData())) return;           // пришёл устаревший ответ — свежий уже учтён
    if (!apkYmap) return;                            // пока ждали, карту закрыли или перестроили
    setApkMapNetNote('');
    _updateApkMapChrome();
    _syncMapPlacemarks();
    renderApkSelectionBar();
  } catch (e) {
    // Очередной опрос попробует снова; метки остаются на месте — только предупреждаем, что данные могли устареть.
    if (apkYmap) setApkMapNetNote(`Нет связи с сервером (${e.message}) — на карте последние полученные метки. Повторю автоматически · ${_clock()}`);
  } finally {
    apkMapRefreshing = false;
  }
}

function apkLoadMoreHtml() {
  return apkItems.length < apkTotal
    ? `<button id="apkLoadMoreBtn" class="${btnGhost} w-full !py-2.5 text-sm">Показать ещё (${apkItems.length} из ${apkTotal})</button>`
    : '';
}

// Patches #apkList in place (see ui.js's patchKeyedList) instead of blowing
// away and recreating every row on each 5s poll — a row whose data didn't
// change keeps its exact DOM node, so the list no longer flickers as a
// whole every time a single point's status changes somewhere else.
function renderApkList() {
  patchKeyedList($('#apkList'), apkItems, (p) => p.id, apkRowHtml, '<p class="text-sm text-slate-500 text-center py-6">Ничего не найдено</p>');
  setHtmlIfChanged($('#apkLoadMoreWrap'), apkLoadMoreHtml());
  wireApkList();
  renderApkSelectionBar();
}

// Панель над списком: «Выбрать все загруженные», счётчик и массовые
// действия над отмеченными точками. Поиск и фильтры выше — те же, что и
// раньше, они просто сужают то, что можно отметить; отметки при этом не
// сбрасываются. На карте и у роли «только просмотр» панели нет.
function renderApkSelectionBar() {
  const bar = $('#apkSelectionBar');
  if (!bar) return;
  if (!apkCanSelect()) { setHtmlIfChanged(bar, ''); return; }
  const onMap = apkView === 'map';
  const pool = onMap ? apkMapPoints : apkItems;
  const allSelected = pool.length > 0 && pool.every((p) => apkSelected.has(p.id));
  if (onMap && !apkSelected.size) {      // на карте, пока ничего не выбрано, панель не нужна — подсказка про выделение
    setHtmlIfChanged(bar, `<div class="rounded-xl border border-slate-700/40 bg-slate-800/20 px-3 py-2 text-xs text-slate-400">
      Выделить комплексы на карте: «▭ Рамкой» или «✎ Лассо» на карте. Выделяются только показанные на карте (с учётом фильтров).
      <label class="ml-2 inline-flex items-center gap-1.5 text-slate-300"><input type="checkbox" id="apkSelectAll" class="rounded accent-indigo-500"> Выбрать все на карте</label>
      <label class="ml-3 inline-flex items-center gap-1.5 text-slate-300" title="Метки при малом масштабе сливаются в кружки с числом — карта работает быстрее"><input type="checkbox" id="apkClusterChk" class="rounded accent-indigo-500" ${apkClusterOn ? 'checked' : ''}> Группировать метки</label></div>`);
  } else {
    setHtmlIfChanged(bar, `<div class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/20 px-3 py-2">
    <label class="flex items-center gap-1.5 text-xs text-slate-300">
      <input type="checkbox" id="apkSelectAll" class="rounded accent-indigo-500" ${allSelected ? 'checked' : ''}> ${onMap ? 'Выбрать все на карте' : 'Выбрать все загруженные'}
    </label>
    <span class="text-xs text-slate-400">Выбрано: <b>${apkSelected.size}</b></span>
    ${onMap ? `<label class="inline-flex items-center gap-1.5 text-xs text-slate-300" title="Метки при малом масштабе сливаются в кружки с числом — карта работает быстрее"><input type="checkbox" id="apkClusterChk" class="rounded accent-indigo-500" ${apkClusterOn ? 'checked' : ''}> Группировать метки</label>` : ''}
    ${apkSelected.size ? `${apkCanEdit() ? `<button type="button" id="apkBulkGroup" class="${btnGhost} !py-1 !px-2.5 text-xs ml-auto" title="Добавить отмеченные комплексы в подгруппу АПК (существующую или новую)">📁 В подгруппу…</button>` : ''}
    ${apkCurrentGroup() && !apkCurrentGroup().kind && apkCanEdit() ? `<select id="apkSelType" class="${fieldCls} !py-1 !text-xs !w-auto" title="Тип работы отмеченным комплексам в этой подгруппе"><option value="">— тип отмеченным —</option>${planVisitTypeOptions('')}</select>
    <button type="button" id="apkSelTypeBtn" class="${btnGhost} !py-1 !px-2.5 text-xs">Поставить тип</button>
    <button type="button" id="apkSelRemoveGroup" class="rounded-lg px-2.5 py-1 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors" title="Убрать отмеченные из подгруппы (в справочнике они останутся)">Убрать из подгруппы</button>` : ''}
    <button type="button" data-perm="plans.edit,calendar.edit" id="apkBulkPlan" class="${btnGhost} !py-1 !px-2.5 text-xs${apkCanEdit() ? '' : ' ml-auto'}" title="Добавить отмеченные комплексы в план выезда — сразу в группу и с типом работы">📌 В план…</button>
    <button type="button" data-perm="maps.manage" id="apkSelLiveMap" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors" title="Карта в Яндекс.Картах из выбранных комплексов: цвет меток сам следует за их статусами">🗺 Карта из выбранных…</button>
    <button type="button" data-perm="calendar.edit" id="apkBulkAssign" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors">Добавить в бригаду…</button>
    <button type="button" id="apkClearSel" class="${btnGhost} !py-1 !px-2.5 text-xs">Снять выбор</button>` : ''}
  </div>`);
  }
  $('#apkSelectAll').onchange = (e) => {
    pool.forEach((p) => { if (e.target.checked) apkSelected.set(p.id, p); else apkSelected.delete(p.id); });
    if (onMap) { _syncMapPlacemarks(); renderApkSelectionBar(); if (typeof apkSelRenderTools === 'function') apkSelRenderTools(); } else renderApkList();
  };
  const cluster = $('#apkClusterChk');
  if (cluster) cluster.onchange = (e) => apkSetClustering(e.target.checked);
  const bulkPlan = $('#apkBulkPlan');
  if (bulkPlan) bulkPlan.onclick = () => {
    const g = apkCurrentGroup();
    addToPlanForm([...apkSelected.keys()], g ? { groupName: g.name, types: Object.fromEntries([...apkSelected.values()].filter((p) => p.group_work_type).map((p) => [p.id, p.group_work_type])) } : {});
  };
  if ($('#apkBulkGroup')) $('#apkBulkGroup').onclick = apkAddSelectedToGroup;
  if ($('#apkSelTypeBtn')) $('#apkSelTypeBtn').onclick = () => apkGroupSetTypeSelected($('#apkSelType').value);
  if ($('#apkSelRemoveGroup')) $('#apkSelRemoveGroup').onclick = () => {
    const ids = [...apkSelected.keys()];
    if (confirm(`Убрать из подгруппы комплексов: ${ids.length}? В справочнике они останутся.`)) apkGroupRemoveFromGroup(ids);
  };
  const assign = $('#apkBulkAssign');
  if (assign) assign.onclick = () => assignSelectedPointsForm();
  const selMap = $('#apkSelLiveMap');
  if (selMap) selMap.onclick = async () => {
    // Список окна «Живые карты» нужен формой (интервалы, лимиты) — подгружаем, если окно ещё не открывали.
    try { _lmData = await Api.get('/api/live-maps'); } catch { /* форма обойдётся значениями по умолчанию */ }
    openLiveMapForm({ kind: 'list', ids: [...apkSelected.keys()] });
  };
  const clear = $('#apkClearSel');
  if (clear) clear.onclick = () => {
    apkSelected.clear();
    if (onMap) { _syncMapPlacemarks(); renderApkSelectionBar(); if (typeof apkSelRenderTools === 'function') apkSelRenderTools(); } else renderApkList();
  };
}

// Отмеченные точки -> задания одной бригаде на один день, с типом работы по
// каждой (общее окно bulkAssignForm из ui.js — как при импорте KML).
// Создаются на сервере одним запросом (routes_points.py::assign_points);
// уже стоящая у этой бригады на этот день точка пропускается.
function assignSelectedPointsForm() {
  const pts = [...apkSelected.values()];
  if (!pts.length) return;
  bulkAssignForm({
    title: `Добавить в бригаду · точек: ${pts.length}`,
    items: pts.map((p) => ({ key: p.id, label: p.id, type: p.group_work_type || '', sub: [p.address, p.group_need ? 'Нужно: ' + p.group_need : '', p.group_note || p.description].filter(Boolean).join(' · ') })),
    date: todayIso(),
    crewId: null,
    onSubmit: async (r) => {
      const res = await Api.post('/api/points/assign', {
        items: r.items.map((i) => ({ point_id: i.key, type: i.type })), date: r.date, team: r.team, hours: r.hours, travel: r.travel,
      });
      apkSelected.clear();
      alert(assignResultMessage(res));
    },
  });
}

function wireApkList() {
  $('#apkList').querySelectorAll('[data-apk-check]').forEach((chk) => {
    chk.onchange = () => {
      const p = apkItems.find((x) => x.id === chk.dataset.apkCheck);
      if (!p) return;
      if (chk.checked) apkSelected.set(p.id, p); else apkSelected.delete(p.id);
      renderApkSelectionBar();
    };
  });
  wireApkGroupBoxes($('#apkList'));
  $('#apkList').querySelectorAll('[data-edit]').forEach((btn) => { btn.onclick = () => apkPointForm(btn.dataset.edit); });
  $('#apkList').querySelectorAll('[data-journal]').forEach((btn) => { btn.onclick = () => openVisitJournal(btn.dataset.journal); });
  $('#apkList').querySelectorAll('[data-plan]').forEach((btn) => { btn.onclick = () => addToPlanForm(btn.dataset.plan); });
  wirePointNetButtons($('#apkList'), (id) => apkItems.find((p) => p.id === id));
  $('#apkLoadMoreBtn')?.addEventListener('click', async () => {
    const btn = $('#apkLoadMoreBtn');
    btn.disabled = true;
    btn.textContent = 'Загрузка…';
    try {
      await loadApkPage(false);
      renderApkList();
    } catch (err) {
      btn.disabled = false;
      alert('Не удалось загрузить: ' + err.message);
    }
  });
}

// «🗺 В Яндекс.Карты» — Excel для импорта в Конструктор карт со ВСЕМИ комплексами,
// подходящими под текущие фильтры (поиск, категории, статусы, сертификат), а не
// только с загруженной страницей списка. Скачивается через fetch, чтобы показать,
// сколько комплексов выгружено и сколько пропущено из-за отсутствия координат.
async function apkYandexExport() {
  const btn = $('#apkYandexBtn');
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Готовим файл…';
  try {
    const qs = apkMapQueryString();
    const res = await fetch('/api/excel/yandex-points' + (qs ? '?' + qs : ''), { credentials: 'same-origin' });
    if (res.status === 401) { window.location.href = '/login'; return; }
    if (!res.ok) {
      let msg = res.statusText;
      try { msg = (await res.json()).detail || msg; } catch { /* не JSON */ }
      throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
    }
    const blob = await res.blob();
    const exported = res.headers.get('X-Points-Exported');
    const skipped = Number(res.headers.get('X-Points-Skipped')) || 0;
    const name = /filename="?([^";]+)"?/.exec(res.headers.get('Content-Disposition') || '')?.[1] || 'yandex-points.xlsx';
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 5000);
    alert([
      `Выгружено комплексов: ${exported}`,
      skipped ? `Без координат пропущено: ${skipped}` : '',
      '',
      'Файл загружается в Конструктор карт Яндекса: «Импорт» → Excel.',
    ].filter((line, i) => line || i === 2).join('\n'));
  } catch (err) {
    alert('Не удалось выгрузить: ' + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

function apkCategoryChipsHtml() {
  const categoryOptions = [
    { value: '__none__', label: 'Без категории' },
    ...APK_CATEGORIES.map((c) => ({ value: String(c.id), label: `${c.name} (${c.point_count ?? c.count ?? 0})` })),
  ];
  return filterChipsHtml('apk-category', categoryOptions, apkFilters.categories);
}

function apkStatusChipsHtml() {
  const statusOptions = [
    // «Не известно» — точки с пустым статусом (не указаны SIM/IP — проверять нечем).
    { value: '__none__', label: UNKNOWN_STATUS, color: '#64748b' },
    ...Object.keys(_pointStatusCache).map((s) => ({ value: s, label: s, color: _pointStatusCache[s].color })),
  ];
  return filterChipsHtml('apk-status', statusOptions, apkFilters.statuses);
}

function apkViewToggleHtml() {
  const btnCls = (active) => `rounded-lg px-3 py-1.5 text-xs font-medium transition-colors ${active ? 'bg-indigo-500 text-white' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300'}`;
  return `<div class="inline-flex items-center gap-1">
    <button type="button" data-apkview="list" class="${btnCls(apkView === 'list')}">📋 Список</button>
    <button type="button" data-apkview="map" class="${btnCls(apkView === 'map')}">🗺 Карта</button>
  </div>`;
}

// Список и карта делят один и тот же контейнер — переключение вида не
// трогает поиск/фильтры/чипы над ним, только перерисовывает #apkContentArea.
async function renderApkContentArea() {
  if (apkView === 'map') {
    // Карта уже на экране (поменяли фильтр) — не стираем её на время загрузки: при медленной связи метки не пропадают.
    if (!(apkYmap && $('#apkMap'))) $('#apkContentArea').innerHTML = loadingHtml('Данные загружаются…', 'text-sm text-slate-500 text-center py-10');
    await renderApkMap();
  } else {
    destroyApkMap();
    // Поиск/фильтр: прежний список остаётся, но над ним «Обновляю данные…»; первая загрузка — «Данные загружаются…» вместо пустоты.
    const shown = $('#apkList');
    if (shown) setListLoading(shown, true); else $('#apkContentArea').innerHTML = loadingHtml();
    try { await loadApkPage(true); }
    finally { if (shown) setListLoading(shown, false); }
    $('#apkTotalCount').textContent = `(${apkTotal})`;
    $('#apkContentArea').innerHTML = `<div class="max-h-[640px] overflow-auto pr-1">
      <div id="apkList" class="space-y-2"></div>
      <div id="apkLoadMoreWrap" class="mt-2"></div>
    </div>`;
    renderApkList();
  }
}

function apkTabsHtml() {
  const tab = (id, label) => `<button type="button" data-apktab="${id}" class="rounded-xl px-4 py-2 text-sm font-semibold transition-colors ${apkTab === id ? 'bg-indigo-500 text-white' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300'}">${label}</button>`;
  return `<div class="flex flex-wrap items-center gap-2 mb-4">${can('points.view') ? tab('dir', '📋 Справочник АПК') : ''}${can('check.use') ? tab('check', '🔎 Проверка') : ''}</div>`;
}

function wireApkTabs() {
  document.querySelectorAll('[data-apktab]').forEach((b) => {
    b.onclick = () => {
      if (apkTab === b.dataset.apktab) return;
      apkTab = b.dataset.apktab;
      try { history.replaceState(null, '', apkTab === 'check' ? '#check' : location.pathname + location.search); } catch { /* адрес не меняем */ }
      renderApkPage();
    };
  });
}

async function renderApkPage() {
  if (apkTab === 'dir' && !can('points.view') && can('check.use')) apkTab = 'check';      // нет права на справочник — только «Проверка»
  if (apkTab === 'check' && !can('check.use')) apkTab = 'dir';
  try {
    APK_CATEGORIES = await Api.get('/api/point-categories');
  } catch (e) {
    $('#content').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  $('#content').innerHTML = apkTabsHtml() + '<div id="apkTabBody"></div>';
  wireApkTabs();
  if (apkTab === 'check') {                                   // «Проверка» — свой файл (apk_check.js)
    destroyApkMap();
    apkCheckMount($('#apkTabBody'));
    return;
  }
  await loadApkGroups();

  $('#apkTabBody').innerHTML = `
    <div class="flex items-center justify-between mb-4 gap-2 flex-wrap">
      <h2 class="font-display text-lg font-bold">Справочник АПК <span id="apkTotalCount" class="text-sm font-normal text-slate-500"></span></h2>
      <div class="flex flex-wrap items-center gap-2">
        <div id="apkViewToggle">${apkViewToggleHtml()}</div>
        <button id="apkLiveMapsBtn" title="Карты в Яндекс.Картах, которые сами обновляются каждые несколько минут: цвет точек меняется вслед за статусами" class="rounded-xl px-3.5 py-2 text-sm font-semibold bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors">🗺 Живые карты</button>
        <button id="apkYandexBtn" data-perm="calendar.print,maps.manage" title="Выгрузить в Excel для импорта в Конструктор карт Яндекса все комплексы по текущим фильтрам" class="rounded-xl px-3.5 py-2 text-sm font-semibold bg-slate-700/60 hover:bg-slate-600/60 transition-colors">🗺 В Яндекс.Карты</button>
        <button id="apkPlanBtn" class="rounded-xl px-3.5 py-2 text-sm font-semibold bg-slate-700/60 hover:bg-slate-600/60 transition-colors">📋 План</button>
        <button id="apkAddBtn" class="rounded-xl px-3.5 py-2 text-sm font-semibold bg-sky-500 hover:bg-sky-400 text-white shadow-lg shadow-sky-500/25 transition-all duration-300 hover:scale-[1.02]">+ АПК</button>
      </div>
    </div>
    <div id="apkGroupsBar" class="flex flex-wrap items-center gap-2 mb-3"></div>
    <div id="apkGroupPanel"></div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <div class="relative flex-1 min-w-[220px]">
        <input id="apkSearch" value="${esc(apkFilters.search)}" placeholder="Поиск по номеру, названию или инвентарному (серийнику)" class="w-full rounded-xl px-3.5 py-2.5 text-sm accent-ring transition-all duration-300" autocomplete="off">
        <div id="apkSearchDropdown" class="hidden absolute z-20 mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 shadow-xl max-h-64 overflow-auto"></div>
      </div>
      <select id="apkSortFilter" class="rounded-xl px-3 py-2.5 text-sm accent-ring transition-all duration-300">
        <option value="">По номеру</option>
        <option value="recent_down" ${apkFilters.sort === 'recent_down' ? 'selected' : ''}>Сначала недавно отвалившиеся</option>
        <option value="down_duration" ${apkFilters.sort === 'down_duration' ? 'selected' : ''}>Сначала дольше не работает</option>
      </select>
      <select id="apkCertificateFilter" class="rounded-xl px-3 py-2.5 text-sm accent-ring transition-all duration-300">
        <option value="">Сертификат поверки: любой</option>
        <option value="valid" ${apkFilters.certificate === 'valid' ? 'selected' : ''}>Действует</option>
        <option value="invalid" ${apkFilters.certificate === 'invalid' ? 'selected' : ''}>Нет или истёк (без поверки)</option>
        <option value="expired" ${apkFilters.certificate === 'expired' ? 'selected' : ''}>Только истёк</option>
        <option value="missing" ${apkFilters.certificate === 'missing' ? 'selected' : ''}>Отсутствует</option>
      </select>
    </div>
    <div class="mb-4">${filterPanelHtml(
      filterRowHtml('Категория', apkCategoryChipsHtml(), 'id="apkCategoryChips"') +
      filterRowHtml('Статус', apkStatusChipsHtml(), 'id="apkStatusChips"')
    )}</div>
    <div id="apkSelectionBar" class="mb-2"></div>
    <div id="apkContentArea"></div>`;

  renderApkGroups();
  $('#apkYandexBtn').onclick = apkYandexExport;
  $('#apkLiveMapsBtn').onclick = () => openLiveMaps();
  if (!can('points.edit')) $('#apkAddBtn').classList.add('hidden');
  if (!canAny('plans.edit', 'calendar.edit')) $('#apkPlanBtn').classList.add('hidden');
  $('#apkAddBtn').onclick = () => apkPointForm(null);
  $('#apkPlanBtn').onclick = () => planManagerForm();
  $('#apkSearch').oninput = (e) => {
    const value = e.target.value;
    clearTimeout(apkSearchDebounce);
    if (apkView === 'map') {
      // На карте ввод НЕ трогает apkFilters.search и не перерисовывает
      // карту на каждую паузу набора (это раньше сбивало масштаб/положение
      // почти на каждую буквы) — только показывает подсказки; сама точка
      // "показывается" на карте по Enter или клику на подсказку (см.
      // apkLocatePoint).
      apkSearchDebounce = setTimeout(() => loadApkSearchSuggestions(value), 200);
    } else {
      apkSearchDebounce = setTimeout(() => { apkFilters.search = value; applyApkFilters(); }, 300);
    }
  };
  $('#apkSearch').addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || apkView !== 'map') return;
    e.preventDefault();
    if (apkSearchSuggestions.length) apkLocatePoint(apkSearchSuggestions[0].id);
  });
  $('#apkSortFilter').onchange = (e) => { apkFilters.sort = e.target.value; applyApkFilters(); };
  $('#apkCertificateFilter').onchange = (e) => { apkFilters.certificate = e.target.value; applyApkFilters(); };
  wireFilterChips($('#apkCategoryChips'), 'apk-category', apkFilters.categories, applyApkFilters);
  wireFilterChips($('#apkStatusChips'), 'apk-status', apkFilters.statuses, applyApkFilters);
  wireApkViewToggle();

  await renderApkContentArea();
}

function wireApkViewToggle() {
  $('#apkViewToggle').querySelectorAll('[data-apkview]').forEach((btn) => {
    btn.onclick = () => {
      if (apkView === btn.dataset.apkview) return;
      apkView = btn.dataset.apkview;
      $('#apkViewToggle').innerHTML = apkViewToggleHtml();
      wireApkViewToggle();
      renderApkContentArea();
    };
  });
}

// Re-runs the query and refreshes just the chip active-states + list +
// count — never touches #apkSearch itself, so typing doesn't lose focus
// when the debounced search triggers this. Always resets to the first
// PAGE_SIZE rows — used for an actual search/filter change.
async function applyApkFilters() {
  $('#apkCategoryChips').innerHTML = apkCategoryChipsHtml();
  $('#apkStatusChips').innerHTML = apkStatusChipsHtml();
  wireFilterChips($('#apkCategoryChips'), 'apk-category', apkFilters.categories, applyApkFilters);
  wireFilterChips($('#apkStatusChips'), 'apk-status', apkFilters.statuses, applyApkFilters);
  await renderApkContentArea();
}

// Live 5s refresh — for the list view, re-fetches the SAME rows already on
// screen (as many as "Показать ещё" has loaded so far), not just the first
// PAGE_SIZE, so the background poll doesn't quietly collapse a longer,
// scrolled-through list back down to 50 out from under the user. The map
// view updates its markers in place (see refreshApkMap) instead of
// rebuilding the whole map, so panning/zooming survives the poll. Chips
// aren't re-rendered here (their selection state didn't change).
async function refreshApkList() {
  if (apkView === 'map') {
    await refreshApkMap();
    return;
  }
  await loadApkPage(true, { limit: Math.max(PAGE_SIZE, apkItems.length) });
  renderApkList();
  $('#apkTotalCount').textContent = `(${apkTotal})`;
}

async function apkFetchPoint(id) {
  // Сначала — комплекс по точному номеру; поиск (с запасом по числу строк) — только если такого запроса не поймёт старая версия сервера.
  try { return await Api.get(`/api/points/${encodeURIComponent(id)}`); } catch { /* ниже — поиском */ }
  try {
    const found = await Api.get(`/api/points?search=${encodeURIComponent(id)}&limit=500`);
    return found.find((p) => p.id === id) || null;
  } catch (e) { alert(e.message); return null; }
}

// Карточка комплекса — полноэкранная, сначала просмотр (по правам роли), правка по кнопке «Редактировать»; живёт в point_card.js и общая с календарём.
async function apkPointForm(id) {
  return openPointCard(id || null, { edit: !id });
}

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
  if (!canAny('points.view', 'check.use')) { window.location.href = '/'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  await loadPointStatuses();
  await loadWorkTypes();
  await renderApkPage();
  // Live refresh, matching the calendar's 5s poll — skipped while a modal
  // is open (editing) or the search box has focus, so a background
  // refresh never wipes out an in-progress edit or unsent keystroke.
  let pollBusy = false;      // медленный ответ не должен плодить новые запросы поверх старого
  let ticks = 0;
  const typingInList = () => {          // пишет описание комплекса в подгруппе — обновление строк его набор не сбросит
    const a = document.activeElement;
    return !!a && /^(TEXTAREA|INPUT|SELECT)$/.test(a.tagName) && a.type !== 'checkbox' && !!a.closest('#apkContentArea');
  };
  setInterval(() => {
    if (apkTab !== 'dir' || editing || document.hidden || pollBusy || document.activeElement === $('#apkSearch') || typingInList()) return;
    pollBusy = true;
    if (++ticks % 6 === 0) apkReloadGroups().catch(() => {});      // числа в плашках подгрупп — раз в полминуты
    refreshApkList().catch(() => {}).finally(() => { pollBusy = false; });
  }, 5000);
}
boot();
