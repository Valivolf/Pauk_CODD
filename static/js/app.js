// Calendar / crews / points / jobs — the core CRM screen.
// $, esc, modal, editing, fieldCls/labelCls/btn* are declared in ui.js —
// every script tag on this page shares one top-level scope.
let S = { tasks: [] };
let R = null, busy = false; // R stays null until the first successful load
let CURRENT_USER = null;
let DAY_CREWS = []; // крews (id/name/equip/members) for the selected date D — fetched separately from S, see renderDayCrews()
let DAY_CREWS_DAY = null;   // день, для которого DAY_CREWS уже получены: пока он не совпал с выбранным, вместо «бригад нет» пишем «Данные загружаются…»
let POINTS_LOADED = false;  // справочник комплексов хотя бы раз получен
// Points ("комплексы") are a shared per-row resource, not part of S/CAS —
// both the calendar and the separate /warehouse page edit them, see
// loadPoints() below and app/repositories/points_repository.py.
let POINTS = [];
// roleTypeLabel is declared in people.js — every script tag on this page shares one top-level scope.
// EQUIP_OPTIONS, personPickerHtml и crewQuickCreate — в ui.js (нужны и «Все АПК»).

// Matches app/api/routes_excel.py's _norm_point_id — 'T-100', ' t-100 ' and
// 'T-100 ' must all be treated as the same point, not spawn near-duplicates.
const normId = (x) => String(x ?? '').trim().toLowerCase();

// Номер, набранный в поле «Номер точки» с другим регистром, пробелом вместо дефиса, латинскими буквами вместо русских и т. п., приводится к настоящему номеру комплекса из справочника
// (то же правило, что на сервере: app/core/point_ref.py; foldName/compactName/digitsOf — в ui.js). Не нашёлся однозначно — остаётся как набрано (задание на комплекс, которого ещё нет
// в справочнике, тоже допустимо).
function canonPointId(typed) {
  const raw = String(typed ?? '').trim();
  if (!raw || POINTS.some((p) => p.id === raw)) return raw;
  const strict = (s) => foldName(s).replace(/\s+/g, ' ').trim();
  let hit = POINTS.filter((p) => strict(p.id) === strict(raw));
  if (hit.length === 1) return hit[0].id;
  if (hit.length > 1) return raw;
  const key = compactName(raw);
  hit = key ? POINTS.filter((p) => compactName(p.id) === key && digitsOf(p.id) === digitsOf(raw)) : [];
  return hit.length === 1 ? hit[0].id : raw;
}
const pad = (x) => String(x).padStart(2, '0');
const dateStr = (x) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}`;

let D = dateStr(new Date());
let V = new Date(D + 'T12:00:00');
// Перенос бригады на другой день: после кнопки «📅 Перенести» следующий клик по дню календаря — это выбор дня
// переноса (см. startCrewMove / pickMoveDay). { id, name, date, tasks } — снимок бригады на момент нажатия.
let MOVE_CREW = null;

const point = (id) => POINTS.find((x) => x.id === id);
const jobs = (d, id) => S.tasks.filter((x) => x.date === d && (id == null || +x.team === +id));

// Trip-aware version of jobs(D, crewId), for the crew card only: a бригада
// on a многодневная командировка (see app/core/trips.py) shows every one
// of its tasks for the WHOLE trip on any day of it, not just today's —
// deleteCrewCascade still uses plain jobs() since it only ever needs to
// know about tasks dated exactly this crew row's own day.
function crewVisibleJobs(crewId) {
  const crew = DAY_CREWS.find((c) => c.id === crewId);
  if (crew?.trip_id && crew.trip_crew_ids?.length) {
    const ids = new Set(crew.trip_crew_ids.map(Number));
    return S.tasks.filter((x) => ids.has(+x.team));
  }
  return jobs(D, crewId);
}

async function loadPoints() {
  try { POINTS = await Api.get('/api/points'); } catch { /* keep whatever was last loaded */ }
  POINTS_LOADED = true;
  renderPoints();
}

// ---------- data sync ----------
async function load(force = false) {
  if ((busy || editing) && !force) return;
  try {
    // since_rev lets the server skip re-sending the task list when nothing
    // changed since our last known revision (see routes_state.py) — most
    // of the 5s polls hit that path and come back with just {rev}.
    const qs = !force && R !== null ? `?since_rev=${R}` : '';
    const x = await Api.get('/api/state' + qs);
    if (!x.unchanged && (force || R === null || x.rev !== R)) { R = x.rev; S = x.data; render(); }
    else { R = x.rev; }
    $('#status').textContent = 'Подключено';
    $('#statusDot').classList.replace('bg-rose-400', 'bg-emerald-400');
  } catch (e) {
    $('#status').textContent = 'Сервер недоступен';
    $('#statusDot').classList.replace('bg-emerald-400', 'bg-rose-400');
  }
}

async function save(fn) {
  if (busy) return false;
  busy = true;
  const x = structuredClone(S);
  try {
    fn(x);
    let newRev;
    try {
      const res = await Api.put('/api/state', { rev: R, data: x });
      newRev = res.rev;
    } catch (err) {
      if (String(err.message).includes('Конфликт')) {
        await load(true);
        alert('Данные изменились на другом компьютере. Обновлено; повторите действие.');
        return false;
      }
      throw err;
    }
    R = newRev; S = x; render();
    return true;
  } catch (e) {
    alert('Не сохранено: ' + e.message);
    return false;
  } finally {
    busy = false;
  }
}

// ---------- выбор дней для выгрузки ----------
// Режим «📅 Выбрать дни для выгрузки»: щелчок по дню календаря отмечает / снимает его
// (Shift + щелчок — все дни от последнего отмеченного до этого), дни между крайними
// можно пропускать. Выбранные дни уходят в выгрузки списком (…?days=2026-10-01,2026-10-03).
let EXPORT_MODE = false;
const EXPORT_DAYS = new Set();
let EXPORT_LAST = null;      // от этого дня считается диапазон по Shift
let EXPORT_DESIGNS = null;   // отчёты из конструктора для выпадающего списка (грузятся при входе в режим)
const WEEKDAY_SHORT = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];
const addDaysIso = (iso, n) => { const d = new Date(iso + 'T12:00:00'); d.setDate(d.getDate() + n); return dateStr(d); };
const sortedExportDays = () => [...EXPORT_DAYS].sort();

function toggleExportDay(day, asRange) {
  if (asRange && EXPORT_LAST && EXPORT_LAST !== day) {
    const [a, b] = EXPORT_LAST < day ? [EXPORT_LAST, day] : [day, EXPORT_LAST];
    for (let d = a, guard = 0; d <= b && guard < 400; d = addDaysIso(d, 1), guard += 1) EXPORT_DAYS.add(d);
  } else if (EXPORT_DAYS.has(day)) {
    EXPORT_DAYS.delete(day);
  } else {
    EXPORT_DAYS.add(day);
  }
  EXPORT_LAST = day;
  renderExportBar();
  render();
}

function exportDayChip(iso) {
  const d = new Date(iso + 'T12:00:00');
  return `${WEEKDAY_SHORT[d.getDay()]} ${fmtDate(iso).slice(0, 5)}`;
}

function renderExportBar() {
  const bar = $('#exportBar');
  const btn = $('#exportModeBtn');
  if (!bar || !btn) return;
  btn.textContent = EXPORT_MODE ? '✓ Выйти из выбора дней' : '📅 Выбрать дни для выгрузки';
  btn.classList.toggle('!bg-emerald-500/20', EXPORT_MODE);
  bar.classList.toggle('hidden', !EXPORT_MODE);
  if (!EXPORT_MODE) return;
  const days = sortedExportDays();
  const years = new Set(days.map((d) => d.slice(0, 4)));
  const designs = EXPORT_DESIGNS || [];
  bar.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <b class="text-sm">Выгрузка по выбранным дням</b>
      <span class="text-xs text-slate-400">Выбрано дней: <b class="text-slate-200">${days.length}</b></span>
    </div>
    <p class="text-xs text-slate-400">Щёлкайте по дням календаря: день отмечается ✓, повторный щелчок снимает его. <b>Shift + щелчок</b> — сразу все дни от последнего отмеченного. Дни между крайними можно не выбирать.</p>
    <div class="flex flex-wrap gap-1.5 min-h-[28px]">
      ${days.length ? days.map((d) => `<span class="inline-flex items-center gap-1 rounded-lg bg-emerald-500/20 text-emerald-200 text-xs pl-2 pr-1 py-0.5">${exportDayChip(d)}${years.size > 1 ? ' ' + d.slice(2, 4) : ''}
          <button type="button" data-exp-del="${d}" class="rounded px-1 hover:bg-emerald-500/30" title="Убрать день">✕</button></span>`).join('')
        : '<span class="text-xs text-slate-500">Пока ничего не выбрано.</span>'}
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      <span class="text-xs text-slate-500">Быстро:</span>
      <button type="button" data-exp-quick="week" class="${btnGhost} !py-1 !px-3 text-xs">неделя выбранного дня</button>
      <button type="button" data-exp-quick="month" class="${btnGhost} !py-1 !px-3 text-xs">весь месяц</button>
      <button type="button" data-exp-quick="tasks" class="${btnGhost} !py-1 !px-3 text-xs" title="Только дни месяца, в которых есть задания">дни с заданиями</button>
      <button type="button" data-exp-quick="range" class="${btnGhost} !py-1 !px-3 text-xs">диапазон дат…</button>
      <button type="button" data-exp-quick="clear" class="${btnGhost} !py-1 !px-3 text-xs">сбросить</button>
    </div>
    <div class="flex flex-wrap items-center gap-2 pt-1">
      <button type="button" data-exp-go="xlsx" class="${btnPrimary} !py-1.5" ${days.length ? '' : 'disabled'}>⬇ Excel: выезды по дням</button>
      <select id="exportDesignSel" class="rounded-xl px-2.5 py-1.5 text-xs" ${designs.length ? '' : 'disabled'}>
        <option value="">${designs.length ? 'Отчёт из конструктора…' : 'Отчётов из конструктора пока нет'}</option>
        ${designs.map((d) => `<option value="${d.id}">${esc(d.name)} (${d.format.toUpperCase()})</option>`).join('')}
      </select>
      <button type="button" data-exp-go="design" class="${btnGhost} !py-1.5" ${days.length ? '' : 'disabled'}>Сформировать</button>
      <button type="button" data-exp-exit class="${btnGhost} !py-1.5 ml-auto">Готово</button>
    </div>
    <div id="exportMsg" class="hidden rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"></div>`;
  const keep = window.__exportDesignChoice;
  if (keep) { const sel = $('#exportDesignSel'); if (sel) sel.value = keep; }
}

function setExportMessage(text) {
  const el = $('#exportMsg');
  if (!el) return;
  el.textContent = text || '';
  el.classList.toggle('hidden', !text);
}

async function enterExportMode({ scroll = false } = {}) {
  EXPORT_MODE = true;
  if (!EXPORT_DAYS.size) { EXPORT_DAYS.add(D); EXPORT_LAST = D; }   // начинаем с выбранного дня
  renderExportBar();
  render();
  if (scroll) $('#exportBar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  if (!EXPORT_DESIGNS) {
    try { EXPORT_DESIGNS = await Api.get('/api/report-designs'); } catch { EXPORT_DESIGNS = []; }
    renderExportBar();
  }
}

function leaveExportMode() {
  EXPORT_MODE = false;
  renderExportBar();
  render();
}

function exportRangeForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Добавить диапазон дат</h2>
    <p class="text-sm text-slate-400 mb-4">Все дни от «с» до «по» будут отмечены на календаре. Лишние дни потом можно снять щелчком.</p>
    <form id="exportRangeForm" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">С<input type="date" name="date_from" required value="${esc(D)}" class="${fieldCls}"></label>
        <label class="${labelCls}">По<input type="date" name="date_to" required value="${esc(D)}" class="${fieldCls}"></label>
      </div>
      <div id="exportRangeError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Добавить</button>
      </div>
    </form>`);
  $('#exportRangeForm').onsubmit = (e) => {
    e.preventDefault();
    const from = e.target.elements.date_from.value, to = e.target.elements.date_to.value;
    const error = $('#exportRangeError');
    if (!from || !to || to < from) { error.textContent = 'Укажите даты: «по» не раньше «с»'; error.classList.remove('hidden'); return; }
    if ((new Date(to + 'T12:00:00') - new Date(from + 'T12:00:00')) / 86400000 + 1 > 366) { error.textContent = 'Не больше 366 дней'; error.classList.remove('hidden'); return; }
    for (let d = from; d <= to; d = addDaysIso(d, 1)) EXPORT_DAYS.add(d);
    EXPORT_LAST = to;
    close();
    renderExportBar();
    render();
  };
}

async function runExport(kind) {
  const days = sortedExportDays();
  if (!days.length) return;
  const todayIso = dateStr(new Date());
  const now = new Date();
  const localNow = `${todayIso}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const list = encodeURIComponent(days.join(','));
  let url, fallback;
  if (kind === 'xlsx') {
    url = `/api/excel/period-report?days=${list}&today=${todayIso}`;
    fallback = 'crews-by-days.xlsx';
  } else {
    const id = $('#exportDesignSel')?.value;
    if (!id) { setExportMessage('Выберите отчёт из конструктора в списке слева от кнопки.'); return; }
    window.__exportDesignChoice = id;
    url = `/api/report-designs/${id}/generate?days=${list}&today=${todayIso}&now=${encodeURIComponent(localNow)}`;
    fallback = 'report';
  }
  const buttons = [...document.querySelectorAll('#exportBar [data-exp-go]')];
  buttons.forEach((b) => { b.disabled = true; });
  setExportMessage('Формирую файл…');
  try {
    const res = await downloadFile(url, fallback);
    const warnings = Number(res.headers.get('X-Report-Warnings')) || 0;
    setExportMessage(warnings ? `Файл скачан. В шаблоне есть предупреждения (${warnings}) — откройте отчёт в конструкторе и посмотрите «Предпросмотр».` : '');
  } catch (err) {
    setExportMessage('Не удалось сформировать: ' + err.message);
  } finally {
    buttons.forEach((b) => { b.disabled = !EXPORT_DAYS.size; });
  }
}

// ---------- rendering ----------
function render() {
  const y = V.getFullYear(), m = V.getMonth();
  const off = (new Date(y, m, 1).getDay() + 6) % 7;
  const len = Math.ceil((off + new Date(y, m + 1, 0).getDate()) / 7) * 7;
  $('#month').textContent = new Intl.DateTimeFormat('ru-RU', { month: 'long', year: 'numeric' }).format(V);

  const days = Array.from({ length: len }, (_, i) => new Date(y, m, 1 + i - off));
  const dayButtonHtml = (z) => {
    const d = dateStr(z);
    const isSel = d === D, isToday = d === dateStr(new Date());
    const picked = EXPORT_MODE && EXPORT_DAYS.has(d);
    const base = 'relative min-h-[78px] rounded-xl p-2 text-left flex flex-col gap-2 border transition-all duration-300 hover:scale-[1.02]';
    const theme = picked
      ? 'bg-emerald-500/20 border-emerald-400/60 shadow-lg shadow-emerald-500/10'
      : isSel
        ? 'bg-indigo-500/20 border-indigo-400/50 shadow-lg shadow-indigo-500/10'
        : 'bg-slate-800/40 border-slate-700/60 hover:bg-slate-700/50';
    const dim = z.getMonth() === m ? '' : 'opacity-40';
    const crewsOn = new Set(jobs(d).map((x) => x.team)).size;
    const jobsN = jobs(d).length;
    return `<button data-day="${d}" class="${base} ${theme} ${dim}">
      ${picked ? '<span class="absolute top-1.5 right-2 text-xs font-bold text-emerald-300">✓</span>' : ''}
      <b class="text-sm ${isToday ? 'text-indigo-300' : ''}">${z.getDate()}</b>
      <small class="text-[11px] text-slate-400 leading-tight">${crewsOn} бр. · ${jobsN} зад.</small>
    </button>`;
  };
  // Keyed by date so an unrelated day's cell (most of the 28-42 shown)
  // isn't destroyed/recreated — see ui.js's patchKeyedList.
  patchKeyedList($('#cal'), days, dateStr, dayButtonHtml, '');
  $('#cal').classList.toggle('move-mode', !!MOVE_CREW);

  $('#day').textContent = fmtDayHeading(D);

  renderDayCrews();
  renderPoints();
}

// Task-type dot colour — shares the --vt-1..9 categorical palette with
// /stats (see theme.css), so the same work type always reads the same
// colour everywhere in the app, not just here.
function typeColor(type) {
  const i = VISIT_TYPES.indexOf(type);
  return i === -1 ? null : `var(--vt-${(i % 9) + 1})`;
}

// Бригады are their own resource, not part of S/CAS state — fetched fresh
// for the selected day whenever it (or the task list) changes.
async function renderDayCrews() {
  const day = D;
  let crews = [];
  try { crews = await Api.get('/api/crews?date=' + day); } catch { crews = []; }
  if (day !== D) return; // user navigated away before this resolved
  DAY_CREWS = crews;
  DAY_CREWS_DAY = day;
  renderPointsCrewFilter();
  renderPoints();
  renderTeamsList();
}

// Строка «вспомогательной точки» в карточке бригады: метка с информацией для карты, не работа —
// без отчёта о выезде, с её координатами.
function auxJobHtml(j, ji) {
  // Монтёр нажал в боте «Принято» — точка выполнена (зелёная, как и на карте бригады).
  const done = !!j.reported;
  return `<div class="rounded-xl bg-slate-900/40 border p-2.5 flex items-start justify-between gap-2" style="border-color:${done ? 'rgba(16,185,129,.45)' : 'rgba(167,139,250,.5)'}">
    <span class="text-xs leading-relaxed">
      ${done ? '' : `<input type="checkbox" data-perm="calendar.edit" data-sel-task="${esc(j.id)}" ${SEL_TASKS.has(j.id) ? 'checked' : ''} class="rounded accent-indigo-500 mr-1.5 align-middle" title="Отметить, чтобы перенести в другую бригаду или на другой день">`}<span class="text-slate-500 mr-1" title="Номер метки на карте бригады">${ji + 1}.</span><span class="inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle" style="background:${done ? '#10b981' : '#a78bfa'}"></span>
      <b>${esc(j.point || 'Без названия')}</b>
      <span class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium" style="background:rgba(167,139,250,.15);color:#c4b5fd">ℹ️ Вспомогательная точка</span>
      ${done ? '<span class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-300">✅ Принято</span>' : ''}<br>
      <span class="text-slate-400">${esc(j.work || 'Без описания')} · ${esc(j.aux_lat)}, ${esc(j.aux_lon)}</span>
    </span>
    <span class="flex items-center gap-1.5 shrink-0">
      <button data-perm="calendar.edit" data-job="${esc(j.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors">✎</button>
    </span>
  </div>`;
}

// Which бригады currently have their point list expanded — collapsed by
// default (see crewCardHtml's toggle header) so a day with several
// многодневная-командировка crews (each now showing every not-yet-closed
// trip point, not just today's) doesn't turn into a wall of cards. Keyed
// by crew id, so it naturally forgets once that day's crew rows are gone.
let EXPANDED_CREWS = new Set();
// Отмеченные галочкой задания (id) в карточках бригад — для «Перенести выбранные…». Выполненные (с отчётом) не отмечаются и не переносятся.
let SEL_TASKS = new Set();

// Pure re-render from the already-fetched DAY_CREWS/S.tasks — no network
// call, so expand/collapse toggling (and anything else that only needs a
// redraw) can call this directly instead of renderDayCrews().
function renderTeamsList() {
  { const alive = new Set(S.tasks.filter((t) => !t.reported).map((t) => t.id)); SEL_TASKS = new Set([...SEL_TASKS].filter((id) => alive.has(id))); }     // выбранное, что исчезло или выполнено, из выбора уходит
  const crewCardHtml = (c) => {
    const jobsList = crewVisibleJobs(c.id);
    const workJobs = jobsList.filter((x) => !isAuxTask(x));
    const auxCount = jobsList.length - workJobs.length;
    const hrs = workJobs.reduce((n, x) => n + (+x.hours || 0) + (+x.travel || 0), 0);
    const peopleLine = [
      ...c.members.map((p) => (p.role_type === 'driver' && p.driver_kind ? `${p.full_name} (${p.driver_kind === 'tower' ? 'вышка' : 'прикрытие'})` : p.full_name)),
      ...(c.contractor ? [`Подрядчик${c.contractor_note ? ': ' + c.contractor_note : ''}`] : []),
    ].join(', ');
    const tripBadge = c.trip_id
      ? `<span class="rounded-lg px-2 py-0.5 text-[11px] font-medium bg-amber-500/15 text-amber-300" title="Командировка с ${esc(fmtDate(c.trip_from))} по ${esc(fmtDate(c.trip_to))}">🧳 в командировке до ${esc(fmtDate(c.trip_to))}</span>`
      : '';
    const expanded = EXPANDED_CREWS.has(c.id);
    const selectable = jobsList.filter((x) => !x.reported);
    const selectedHere = selectable.filter((x) => SEL_TASKS.has(x.id));
    const selectionBar = expanded && selectable.length ? `<div class="flex flex-wrap items-center gap-2 text-xs" data-perm="calendar.edit">
        <label class="inline-flex items-center gap-1.5 text-slate-300 cursor-pointer"><input type="checkbox" data-sel-all="${c.id}" ${selectedHere.length === selectable.length ? 'checked' : ''} class="rounded accent-indigo-500"> выбрать все невыполненные</label>
        ${selectedHere.length ? `<span class="text-slate-400">Выбрано: <b>${selectedHere.length}</b></span>
          <button type="button" data-move-tasks="${c.id}" class="${btnPrimary} !py-1 !px-2.5 text-xs" title="Перенести отмеченные точки в другую бригаду — этого дня, другого дня или в новую">↪ Перенести выбранные…</button>
          <button type="button" data-move-plan="${c.id}" class="${btnGhost} !py-1 !px-2.5 text-xs" title="Убрать отмеченные точки из бригады и положить в «План» — без дня и бригады">📋 В план…</button>
          <button type="button" data-sel-clear="${c.id}" class="${btnGhost} !py-1 !px-2.5 text-xs">Снять выбор</button>` : '<span class="text-slate-500">отметьте точки галочкой (хоть все, хоть несколько), чтобы перенести их другой бригаде, на другой день или в план</span>'}
      </div>` : '';
    return `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 space-y-3">
      <div class="flex items-center justify-between gap-2 cursor-pointer select-none" data-toggle-crew="${c.id}">
        <span class="flex items-center gap-1.5">
          <small class="text-slate-500">${expanded ? '▾' : '▸'}</small>
          <b class="text-sm">${esc(c.name)}</b>
        </span>
        <span class="flex items-center gap-2">${tripBadge}<small class="text-xs text-slate-400">${hrs} ч · ${workJobs.length} зад.${auxCount ? ` · ℹ️ ${auxCount}` : ''}</small></span>
      </div>
      <div class="text-xs text-slate-400">${peopleLine ? esc(peopleLine) : '<span class="text-amber-300">состав не указан</span>'}</div>
      <div class="flex flex-wrap items-center gap-2">
        <select data-equip="${c.id}" class="rounded-lg px-2 py-1 text-xs">
          ${EQUIP_OPTIONS.map((z) => `<option ${c.equip === z ? 'selected' : ''}>${z}</option>`).join('')}
        </select>
        <button data-perm="calendar.edit" data-rename-crew="${c.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Название, место работ, ссылка на карту и состав бригады">✏️ Изменить</button>
        ${c.trip_id
          ? `<button data-perm="calendar.edit" data-cancel-trip="${c.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-amber-500/15 text-amber-300 hover:bg-amber-500/25 transition-colors">🧳 Завершить командировку</button>`
          : `<button data-perm="calendar.edit" data-trip="${c.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-slate-700/60 hover:bg-slate-600/60 transition-colors">🧳 Командировка</button>`}
        <button data-copy-crew="${c.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Скопировать текст бригады (место, работы, состав, ссылка на карту)">📋 Текст</button>
        <button data-perm="calendar.edit" data-move-crew="${c.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Перенести бригаду с её точками на другой день: нажмите и выберите день в календаре">📅 Перенести</button>
        ${hasYandexMapLink(c) ? `<a href="${esc(c.map_link.trim())}" target="_blank" rel="noopener" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25 transition-colors" title="Ссылка на карту бригады в Яндексе">🔗 Ссылка</a>` : ''}
        <button data-perm="calendar.edit" data-del-crew="${c.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors">Удалить</button>
        <button data-perm="calendar.edit" data-add="${c.id}" class="ml-auto rounded-lg px-2.5 py-1 text-xs font-medium bg-slate-700/60 hover:bg-slate-600/60 transition-colors">+ Точка</button>
      </div>
      ${selectionBar}
      ${expanded ? jobsList.map((j, ji) => isAuxTask(j) ? auxJobHtml(j, ji) : `<div class="rounded-xl bg-slate-900/40 border ${j.reported ? 'border-emerald-500/40' : 'border-slate-700/40'} p-2.5 flex items-start justify-between gap-2">
        <span class="text-xs leading-relaxed">
          ${j.reported ? '' : `<input type="checkbox" data-perm="calendar.edit" data-sel-task="${esc(j.id)}" ${SEL_TASKS.has(j.id) ? 'checked' : ''} class="rounded accent-indigo-500 mr-1.5 align-middle" title="Отметить, чтобы перенести в другую бригаду или на другой день">`}<span class="text-slate-500 mr-1" title="Номер метки на карте бригады">${ji + 1}.</span><span class="inline-block h-1.5 w-1.5 rounded-full mr-1.5 align-middle" style="background:${typeColor(j.type) || '#64748b'}"></span>
          <b>${esc(j.point || 'Без точки')}</b> · ${esc(point(j.point)?.address || j.address || 'Адрес не указан')}
          ${j.reported ? '<span class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-300">✅ Выполнено</span>' : ''}<br>
          <span class="text-slate-400">${esc(j.work || point(j.point)?.description || 'Работа не указана')}${j.type ? ` · ${esc(j.type)}` : ''}</span>
        </span>
        <span class="flex items-center gap-1.5 shrink-0">
          ${j.point ? `<button data-point-history="${esc(j.point)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="История выездов по этому комплексу">🕘</button>` : ''}
          ${j.point ? `<button data-perm="photos.view" data-point-photos="${esc(j.point)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Фото по этому комплексу по дням">📷</button>` : ''}
          ${j.point && point(j.point) && canAny('points.view', 'points.edit', 'calendar.view') ? `<button data-point-card="${esc(point(j.point).id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Информация о точке: открыть карточку комплекса и изменить">📍</button>` : ''}
          ${j.point ? `<button data-report="${esc(j.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Отчёт о выезде">📋</button>` : ''}
          <button data-perm="calendar.edit" data-job="${esc(j.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Изменить задание (тип работ, описание, часы)">✎</button>
        </span>
      </div>`).join('') : ''}
    </div>`;
  };
  // Keyed by crew id — editing one crew (or one of its tasks) no longer
  // rebuilds every other crew's card, see ui.js's patchKeyedList.
  patchKeyedList(
    $('#teams'), DAY_CREWS, (c) => c.id, crewCardHtml,
    DAY_CREWS_DAY !== D ? loadingHtml() : '<p class="text-sm text-slate-500 text-center py-6">На этот день бригад ещё нет — импортируйте KML или добавьте задание, чтобы собрать бригаду.</p>',
  );
}

// Populates the crew filter <select> from the day's crews (DAY_CREWS,
// see renderDayCrews) — called from render()/renderDayCrews() whenever
// the selected day changes, so the filter always matches D.
function renderPointsCrewFilter() {
  const sel = $('#pointsCrewFilter');
  const prev = sel.value;
  sel.innerHTML = '<option value="">Все бригады</option>'
    + DAY_CREWS.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  sel.value = DAY_CREWS.some((c) => String(c.id) === prev) ? prev : '';
}

// "Точки на день" only lists points that actually have a task on the
// selected day D (optionally narrowed to one crew; плюс точки заданий всей
// поездки у бригады в командировке — см. tripNote ниже) — with 500+ real
// points in the directory, showing the whole thing here isn't useful for
// a dispatcher checking today's work; the full searchable directory now
// lives on the separate /apk page.
function renderPoints() {
  const crewFilter = $('#pointsCrewFilter').value;
  const dayTasks = S.tasks.filter((t) => t.date === D && !isAuxTask(t) && (!crewFilter || String(t.team) === crewFilter));
  const dayPointIds = new Set(dayTasks.map((t) => t.point).filter(Boolean));
  // Бригада в командировке (с предыдущего дня) ведёт точки всей своей поездки — так же, как её карточка
  // (crewVisibleJobs): их задания датированы другими днями, поэтому одним только `t.date === D` они сюда не
  // попадали, хотя саму бригаду в фильтре выбрать было можно. Такие точки помечаем, откуда они.
  const tripNote = new Map();   // id точки → дата задания (только для точек, которых нет среди заданий самого дня)
  // Задания каждой точки (в бригадах дня и в поездке) — по ним на карточке видно, выполнена ли точка, и открывается её отчёт
  const tasksByPoint = new Map();
  const addTask = (t) => {
    if (!t.point || isAuxTask(t)) return;
    if (!tasksByPoint.has(t.point)) tasksByPoint.set(t.point, []);
    const list = tasksByPoint.get(t.point);
    if (!list.some((x) => x.id === t.id)) list.push(t);
  };
  dayTasks.forEach(addTask);
  DAY_CREWS
    .filter((c) => c.date === D && c.trip_id && (!crewFilter || String(c.id) === crewFilter))
    .forEach((c) => crewVisibleJobs(c.id).forEach((t) => {
      addTask(t);
      if (!t.point || isAuxTask(t) || dayPointIds.has(t.point)) return;
      if (!tripNote.has(t.point)) tripNote.set(t.point, t.date);
    }));
  tripNote.forEach((_, id) => dayPointIds.add(id));

  const q = $('#search').value;
  const filtered = POINTS
    .filter((p) => dayPointIds.has(p.id))
    .filter((p) => matchesQuery(q, p.id, p.address, p.description));

  // Выполнена ли точка в этот день: по отчётам её заданий (сдан отчёт — выполнено); у точки несколько заданий — «выполнено 1 из 2»
  const progressBadge = (ts) => {
    if (!ts.length) return '';
    const done = ts.filter((t) => t.reported).length;
    if (done === ts.length) return '<span class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-emerald-500/15 text-emerald-300" title="По точке сдан отчёт о выезде">✅ Выполнено</span>';
    if (done) return `<span class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300">◐ Выполнено ${done} из ${ts.length}</span>`;
    return '<span class="rounded px-1.5 py-0.5 text-[10px] font-medium bg-slate-700/60 text-slate-300" title="Отчёта о выезде по этой точке ещё нет">⏳ Не выполнено</span>';
  };
  const pointCardHtml = (p) => {
    const ts = tasksByPoint.get(p.id) || [];
    const allDone = ts.length > 0 && ts.every((t) => t.reported);
    const reportTask = ts.find((t) => !t.reported) || ts[ts.length - 1];       // отчёт — по первому невыполненному заданию точки, иначе по последнему
    const crewNames = [...new Set(ts.map((t) => (DAY_CREWS.find((c) => +c.id === +t.team) || {}).name).filter(Boolean))];
    return `<div data-brick="${esc(p.id)}" class="rounded-xl border ${allDone ? 'border-emerald-500/40' : 'border-slate-700/50'} bg-slate-800/30 p-3 flex flex-col gap-2">
    <div class="flex items-start justify-between gap-2">
      <span class="text-xs leading-relaxed"><b data-brick-name title="Открыть карточку комплекса">${esc(p.id)}</b> · ${esc(p.address || '')} ${progressBadge(ts)}${crewNames.length ? `<br><span class="text-slate-500">бригада: ${crewNames.map(esc).join(', ')}</span>` : ''}<br><span class="text-slate-400">${esc(p.description || '')}</span>${p.category_name ? `<br>${colorBadge(p.category_name, p.category_color)}` : ''}${tripNote.has(p.id) ? `<br><span class="text-amber-300" title="Бригада в командировке: точка из задания другого дня поездки">🧳 из командировки · задание на ${esc(fmtDate(tripNote.get(p.id)))}</span>` : ''}${stockPartialNoteHtml(p)}</span>
      <span class="flex items-center gap-1 shrink-0">
        ${pointStatusBadge(p.status, p.stock_partial)}
        <button data-perm="reports.view,monitoring.view,calendar.view,notifications.view" data-point-history="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="История выездов по этому комплексу">🕘</button>
        <button data-perm="photos.view" data-point-photos="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Фото по этому комплексу по дням">📷</button>
        ${reportTask ? `<button data-report="${esc(reportTask.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="${allDone ? 'Отчёт о выезде (посмотреть или поправить)' : 'Заполнить отчёт о выезде вручную'}">📋</button>` : ''}
        <button data-perm="points.view,points.edit,calendar.view" data-point="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Карточка комплекса: просмотр и правка">🗂</button>
        <button data-perm="points.edit" data-delete="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors">×</button>
      </span>
    </div>
    ${pointNetButtonsHtml(p)}
  </div>`;
  };
  // Keyed by point id — a ping/port check result on one point's card no
  // longer forces every other point's card to be rebuilt mid-check, see
  // ui.js's patchKeyedList (and the _netCheckPending note above it).
  patchKeyedList($('#points'), filtered, (p) => p.id, pointCardHtml,
    !POINTS_LOADED || DAY_CREWS_DAY !== D ? loadingHtml() : '<p class="text-sm text-slate-500 text-center py-6">На выбранный день (и бригаду) точек нет.</p>');
}

// modal()/fieldCls/labelCls/btn* live in ui.js — this page's own close()
// (called by modal()'s .cancel button and every successful save) is the
// only piece specific to the calendar.
function close() {
  editing = false;
  $('#modal').innerHTML = '';
  // Бригады and points live outside S/CAS state (see renderDayCrews /
  // loadPoints), so a mutation to either alone wouldn't bump rev and
  // load() would skip re-rendering — refresh both unconditionally
  // whenever a modal closes. keepScroll: пролистанный список точек дня не возвращается в начало.
  keepScroll(document.body, () => Promise.all([load(), renderDayCrews(), loadPoints()])).catch(() => {});
}

// ---------- job / point / crew forms ----------

// «Планы» — точки оператор заметил как нуждающиеся в выезде, сохранил с
// описанием, но ещё не привязал к бригаде/дате (app/repositories/
// point_plans_repository.py). Открывается из jobForm's «Из плана…» — с
// поиском и теми же фильтрами, что на «Все АПК». «Выбрать» у строки
// открывает jobForm заново с её номером и описанием (через тот же draft,
// что и вложенный crewQuickCreate; planId нужен, чтобы запись плана
// удалилась, только когда задание реально сохранится — см. consumePlan()
// в jobForm). Если отметить галочками несколько — «Добавить выбранные»
// создаёт сразу пачку заданий, с типом работы по каждой точке, как при
// импорте KML (POST /api/point-plans/assign), а запись плана при этом
// расходуется.
async function pointPlanPicker(jobId, date, crewId, draft, keepFilter) {
  let plans;
  try { plans = await Api.get('/api/point-plans'); }
  catch (e) { alert('Не удалось загрузить планы: ' + e.message); return; }

  const f = keepFilter || newPlanFilter();
  const ticked = new Set();

  modal(`<h2 class="font-display text-lg font-bold mb-1">Точки в плане</h2>
    <p class="text-sm text-slate-400 mb-3">«Выбрать» — форма задания откроется с номером и описанием точки. Или отметьте несколько и нажмите «Добавить выбранные» — тип работы можно задать сразу всем.</p>
    <div id="ppFilters"></div>
    <div class="flex items-center justify-between gap-2 mb-2">
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" id="ppAll" class="rounded accent-indigo-500"> Все найденные</label>
      <button type="button" id="ppBulk" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors"></button>
    </div>
    <div id="ppList" class="space-y-2 max-h-[340px] overflow-auto pr-1"></div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);

  const pick = (p) => {
    // modal() тут же снесёт этот пикер — jobForm откроется заново с
    // draft'ом, как и при вложенном crewQuickCreate().
    jobForm(jobId, crewId, { ...draft, point: p.point_id, work: p.description, address: p.point_address || draft.address || '', planId: p.id, priority: p.priority, type: p.work_type || draft.type || '' });
  };

  const rowHtml = (p) => `<div class="rounded-xl border ${p.priority ? 'border-amber-500/40' : 'border-slate-700/50'} bg-slate-800/30 p-3 flex items-start gap-2">
    <input type="checkbox" data-pp-check="${p.id}" class="rounded accent-indigo-500 mt-0.5" ${ticked.has(p.id) ? 'checked' : ''}>
    <span class="text-xs leading-relaxed min-w-0 flex-1">
      <b>${esc(p.point_id)}</b>${p.point_address ? ' · ' + esc(p.point_address) : ''}
      ${p.priority ? '<span class="ml-1.5 rounded px-1.5 py-0.5 text-[10px] font-medium bg-amber-500/15 text-amber-300">🟡 Приоритет</span>' : ''}<br>
      <span class="text-slate-400">${esc(p.description) || '—'}</span>
      ${p.work_type ? `<br><span class="inline-block mt-0.5 rounded px-1.5 py-0.5 text-[10px] bg-indigo-500/15 text-indigo-300">${esc(p.work_type)}</span>` : ''}
    </span>
    <span class="flex items-center gap-1.5 shrink-0">
      <button type="button" data-pick="${p.id}" class="rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors">Выбрать</button>
      <button data-perm="plans.edit" type="button" data-remove="${p.id}" class="rounded-lg px-2 py-1 text-xs bg-rose-500/15 text-rose-300 hover:bg-rose-500/25 transition-colors">✕</button>
    </span>
  </div>`;

  const drawBulk = () => {
    const visible = plans.filter((p) => planFilterMatches(p, f));
    $('#ppBulk').textContent = ticked.size ? `Добавить выбранные (${ticked.size})` : 'Добавить выбранные';
    $('#ppBulk').classList.toggle('opacity-50', !ticked.size);
    $('#ppAll').checked = visible.length > 0 && visible.every((p) => ticked.has(p.id));
  };

  const drawList = () => {
    const visible = plans.filter((p) => planFilterMatches(p, f));
    const groupHead = (g) => `<div class="flex flex-wrap items-center gap-2 rounded-xl ${g.name ? 'bg-indigo-500/10 border border-indigo-400/25' : 'bg-slate-800/40 border border-slate-700/40'} px-3 py-2 mt-1">
      <input type="checkbox" data-pp-group-check="${esc(g.name)}" class="rounded accent-indigo-500" ${g.items.every((p) => ticked.has(p.id)) ? 'checked' : ''} title="Отметить всю группу">
      <b class="text-sm">${g.name ? '📁 ' + esc(g.name) : 'Без группы'}</b><span class="text-xs text-slate-400">${g.items.length}</span>
      ${g.name ? `<button type="button" data-pp-group-add="${esc(g.name)}" class="ml-auto rounded-lg px-2.5 py-1 text-xs font-medium bg-indigo-500 hover:bg-indigo-400 text-white transition-colors" title="Записать всю группу на эту бригаду">Добавить группу…</button>` : ''}
    </div>`;
    $('#ppList').innerHTML = planGroupsOf(visible).map((g) => groupHead(g) + g.items.map(rowHtml).join('')).join('')
      || `<p class="text-sm text-slate-500 text-center py-6">${plans.length ? 'Ничего не найдено' : 'Планов пока нет — добавляются со страницы «Все АПК».'}</p>`;
    $('#ppList').querySelectorAll('[data-pp-group-check]').forEach((chk) => {
      chk.onchange = () => {
        visible.filter((p) => (p.group_name || '') === chk.dataset.ppGroupCheck).forEach((p) => { if (chk.checked) ticked.add(p.id); else ticked.delete(p.id); });
        drawList();
      };
    });
    $('#ppList').querySelectorAll('[data-pp-group-add]').forEach((btn) => {
      btn.onclick = () => {                      // вся группа (не только найденное фильтром) — окно «Добавить из плана» с уже выбранными типами
        plans.filter((p) => (p.group_name || '') === btn.dataset.ppGroupAdd).forEach((p) => ticked.add(p.id));
        $('#ppBulk').click();
      };
    });
    $('#ppList').querySelectorAll('[data-pp-check]').forEach((chk) => {
      chk.onchange = () => { if (chk.checked) ticked.add(+chk.dataset.ppCheck); else ticked.delete(+chk.dataset.ppCheck); drawBulk(); };
    });
    $('#ppList').querySelectorAll('[data-pick]').forEach((btn) => {
      btn.onclick = () => { const p = plans.find((x) => x.id === +btn.dataset.pick); if (p) pick(p); };
    });
    $('#ppList').querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Убрать точку из плана без создания задания?')) return;
        try { await Api.del('/api/point-plans/' + btn.dataset.remove); pointPlanPicker(jobId, date, crewId, draft, f); }
        catch (err) { alert(err.message); }
      };
    });
    drawBulk();
  };

  $('#ppAll').onchange = (e) => {
    plans.filter((p) => planFilterMatches(p, f)).forEach((p) => { if (e.target.checked) ticked.add(p.id); else ticked.delete(p.id); });
    drawList();
  };
  $('#ppBulk').onclick = () => {
    const sel = plans.filter((p) => ticked.has(p.id));
    if (!sel.length) { alert('Отметьте хотя бы одну точку в списке.'); return; }
    if (sel.length === 1) { pick(sel[0]); return; }
    bulkAssignForm({
      title: `Добавить из плана · точек: ${sel.length}`,
      items: sel.map((p) => ({ key: p.id, label: p.point_id, type: p.work_type || '', sub: [p.group_name ? '📁 ' + p.group_name : '', p.point_address, p.description].filter(Boolean).join(' · ') })),
      date,
      crewId,
      onSubmit: async (r) => {
        const res = await Api.post('/api/point-plans/assign', {
          items: r.items.map((i) => ({ plan_id: i.key, type: i.type })), date: r.date, team: r.team, hours: r.hours, travel: r.travel,
        });
        D = r.date; V = new Date(D + 'T12:00:00');
        await load(true);
        alert(assignResultMessage(res));
      },
    });
  };

  mountPlanFilters($('#ppFilters'), plans, f, drawList);
  drawList();
}

// Есть ли уже такая точка в заданиях: в тот же день у любой бригады либо
// у бригады той же командировки (на любой её день) — тогда новая не
// добавляется (см. state_repository.point_ids_on — то же правило на сервере
// для массовых добавлений). `crew` — бригада, которой добавляют (для
// trip_crew_ids), `exceptTaskId` — редактируемое задание, оно себе не дубль.
function findExistingPointTask(pointId, day, crew, exceptTaskId) {
  const key = normId(pointId);
  if (!key) return null;
  const tripIds = new Set((crew?.trip_crew_ids || []).map(Number));
  return S.tasks.find((t) => t.id !== exceptTaskId && !isAuxTask(t) && normId(t.point) === key
    && (t.date === day || (tripIds.size && tripIds.has(+t.team)))) || null;
}

// `draft` resumes the form after a nested crewQuickCreate() round-trip —
// modal() is a single slot, not stackable, so opening the "new crew"
// dialog from inside this one destroys this form's DOM; the draft is how
// its in-progress field values survive that and get restored.
async function jobForm(id, presetCrewId, draft) {
  const o = S.tasks.find((x) => x.id === id);
  const j = draft || o || { date: D, team: presetCrewId || '', point: '', work: '', address: '', hours: 1, travel: 0, type: '', note: '', priority: false, aux_lat: '', aux_lon: '' };
  if (presetCrewId) j.team = presetCrewId;

  const loadCrews = async (date) => { try { return await Api.get('/api/crews?date=' + date); } catch { return []; } };
  let crews = await loadCrews(j.date);
  if (!crews.length) {
    const created = await crewQuickCreate(j.date);
    if (!created) return;
    crews = [created];
    j.team = created.id;
  }

  const teamOptions = (list, selected) =>
    list.map((c) => `<option value="${c.id}" ${c.id === +selected ? 'selected' : ''}>${esc(c.name)}</option>`).join('')
    + '<option value="__new__">+ Новая бригада…</option>';

  modal(`<h2 class="font-display text-lg font-bold mb-5">Задание</h2>
    <form id="form" class="space-y-4">
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Дата<input name="date" type="date" required value="${esc(j.date)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Бригада<select name="team" id="jobTeamSelect" required class="${fieldCls}">${teamOptions(crews, j.team)}</select></label>
        <div class="col-span-2">
          <label class="${labelCls}"><span id="jobPointLabel">Номер точки</span><input name="point" list="opts" value="${esc(j.point)}" class="${fieldCls}"><datalist id="opts">${POINTS.map((p) => `<option value="${esc(p.id)}">`).join('')}</datalist></label>
          <button type="button" id="fromPlanBtn" data-work-only class="${btnGhost} !py-1.5 !px-3 text-xs mt-1.5">📋 Из плана…</button>
        </div>
        <label class="${labelCls} col-span-2"><span id="jobWorkLabel">Работа</span><input name="work" value="${esc(j.work)}" class="${fieldCls}"></label>
        <label class="${labelCls} col-span-2" data-work-only>Адрес вручную<input name="address" value="${esc(j.address)}" class="${fieldCls}"></label>
        <label class="${labelCls} hidden" data-aux-only>Широта<input name="aux_lat" inputmode="decimal" placeholder="45.0355" value="${esc(j.aux_lat || '')}" class="${fieldCls}"></label>
        <label class="${labelCls} hidden" data-aux-only>Долгота<input name="aux_lon" inputmode="decimal" placeholder="38.9753" value="${esc(j.aux_lon || '')}" class="${fieldCls}"></label>
        <label class="${labelCls}" data-work-only>Работа, ч<input name="hours" type="number" step=".25" min="0" value="${esc(j.hours)}" class="${fieldCls}"></label>
        <label class="${labelCls}" data-work-only>Дорога, ч<input name="travel" type="number" step=".25" min="0" value="${esc(j.travel)}" class="${fieldCls}"></label>
        <label class="${labelCls} col-span-2">Тип работы<select name="type" required class="${fieldCls}"><option value="">— выберите —</option>${VISIT_TYPES.map((z) => `<option ${z === j.type ? 'selected' : ''}>${z}</option>`).join('')}</select></label>
      </div>
      <p class="hidden text-xs" style="color:#c4b5fd" data-aux-only>Вспомогательная точка — метка с информацией на карте бригады (например, откуда подключать SIP до комплекса). Хранится только в заданиях этого дня: в «Все АПК» не попадает, монтёру в боте как точка работы не показывается. Координаты можно вставить из Яндекс.Карт парой «широта, долгота».</p>
      <label class="flex items-center gap-2 text-xs text-slate-300" data-work-only>
        <input type="checkbox" name="priority" class="rounded accent-amber-500" ${j.priority ? 'checked' : ''}> Приоритет — жёлтый маркер и пометка в Excel-экспорте для Яндекс.Карт
      </label>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Сохранить</button>
        ${o ? `<button type="button" id="removejob" class="${btnDanger} ml-auto">Удалить</button>` : ''}
      </div>
    </form>`);

  const form = $('#form');
  const dateInput = form.elements.date;
  const teamSelect = $('#jobTeamSelect');
  const readDraft = () => {
    const f = form.elements;
    return { ...j, date: f.date.value, point: f.point.value, work: f.work.value, address: f.address.value, hours: +f.hours.value || 0, travel: +f.travel.value || 0, type: f.type.value, priority: f.priority.checked, aux_lat: f.aux_lat.value, aux_lon: f.aux_lon.value };
  };
  // «Вспомогательная точка»: вместо номера из справочника — название и свои координаты, без часов,
  // приоритета и плана (см. app/core/work_types.py::AUX_TYPE_NAME).
  const applyType = () => {
    const f = form.elements;
    const aux = f.type.value === AUX_TYPE;
    form.querySelectorAll('[data-work-only]').forEach((el) => el.classList.toggle('hidden', aux));
    form.querySelectorAll('[data-aux-only]').forEach((el) => el.classList.toggle('hidden', !aux));
    $('#jobPointLabel').textContent = aux ? 'Название точки' : 'Номер точки';
    $('#jobWorkLabel').textContent = aux ? 'Описание — что это за точка и зачем' : 'Работа';
    if (aux) f.point.removeAttribute('list'); else f.point.setAttribute('list', 'opts');
    f.aux_lat.required = aux;
    f.aux_lon.required = aux;
  };
  form.elements.type.onchange = applyType;
  // Пара «45.0355, 38.9753» (так копируются координаты из Яндекс.Карт) целиком в поле широты — раскладываем по полям.
  form.elements.aux_lat.addEventListener('input', (e) => {
    const m = e.target.value.match(/^\s*(-?\d+(?:[.,]\d+)?)\s*[,;\s]\s*(-?\d+(?:[.,]\d+)?)\s*$/);
    if (m) { e.target.value = m[1]; form.elements.aux_lon.value = m[2]; }
  });
  applyType();
  dateInput.onchange = async () => {
    crews = await loadCrews(dateInput.value);
    teamSelect.innerHTML = teamOptions(crews, crews[0]?.id || '');
  };
  teamSelect.onchange = async () => {
    if (teamSelect.value !== '__new__') return;
    const resumeDraft = readDraft();
    const created = await crewQuickCreate(resumeDraft.date);
    // modal() just tore this form down to show the crew dialog — reopen
    // it fresh with whatever the dispatcher had already typed, rather
    // than poking at now-detached form elements.
    jobForm(id, created?.id, resumeDraft);
  };
  $('#fromPlanBtn').onclick = () => pointPlanPicker(id, dateInput.value, +teamSelect.value || presetCrewId, readDraft());

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (f.team.value === '__new__') return alert('Выберите бригаду или создайте новую.');
    const isAux = f.type.value === AUX_TYPE;
    let auxLat = '', auxLon = '';
    if (isAux) {
      const num = (raw, lim) => { const n = parseFloat(String(raw).trim().replace(',', '.')); return Number.isFinite(n) && Math.abs(n) <= lim ? n : null; };
      const lat = num(f.aux_lat.value, 90), lon = num(f.aux_lon.value, 180);
      if (!f.point.value.trim()) return alert('Укажите название вспомогательной точки.');
      if (lat === null || lon === null || (lat === 0 && lon === 0)) return alert('Укажите координаты вспомогательной точки числами: широта и долгота (например 45.0355 и 38.9753).');
      auxLat = String(lat); auxLon = String(lon);
    }
    const submitBtn = e.target.querySelector('button:not([type="button"])');
    if (submitBtn.disabled) return; // guards against a double-click re-firing this
    submitBtn.disabled = true;
    const startDate = f.date.value;
    const crewId = +f.team.value;
    const base = isAux
      ? { point: f.point.value.trim(), work: f.work.value.trim(), address: '', hours: 0, travel: 0, type: f.type.value, priority: false, aux_lat: auxLat, aux_lon: auxLon }
      : { point: canonPointId(f.point.value), work: f.work.value.trim(), address: f.address.value.trim(), hours: +f.hours.value, travel: +f.travel.value, type: f.type.value, priority: f.priority.checked, aux_lat: '', aux_lon: '' };
    // A point picked "Из плана" is consumed only once the task actually
    // saves — cancelling the form must leave the plan entry intact.
    const consumePlan = () => { if (j.planId) Api.del(`/api/point-plans/${j.planId}`).catch(() => {}); };

    // Такая точка уже есть (в тот же день у любой бригады или в той же
    // командировке) — новое задание не создаём. Для правки существующего
    // задания проверяем только если номер точки поменяли.
    if (!isAux && base.point && (!o || normId(o.point) !== normId(base.point))) {
      const dup = findExistingPointTask(base.point, startDate, crews.find((c) => c.id === crewId), o?.id);
      if (dup) {
        const owner = crews.concat(DAY_CREWS).find((c) => c.id === +dup.team);
        alert(`Такая точка уже добавлена: ${dup.point}${owner ? ` — ${owner.name}, ${fmtDate(dup.date)}` : ` — ${fmtDate(dup.date)}`}.\nНовая пропущена.`);
        submitBtn.disabled = false;
        return;
      }
    }

    const v = { ...j, id: o?.id || 't' + crypto.randomUUID(), date: startDate, team: crewId, ...base };
    const ok = await save((s) => {
      if (!o) { s.tasks.push(v); return; }
      Object.assign(s.tasks.find((x) => x.id === id), v);
      // Legacy per-task trip clones (tasks.trip_id, see app/core/trips.py)
      // from before командировка moved to the crew level — still kept in
      // sync for whatever old rows are still around.
      if (o.trip_id) {
        for (const t of s.tasks) {
          if (t.id !== id && t.trip_id === o.trip_id) Object.assign(t, { point: v.point, work: v.work, address: v.address });
        }
      }
    });
    if (ok) { consumePlan(); D = v.date; V = new Date(D + 'T12:00:00'); close(); render(); }
    else submitBtn.disabled = false;
  };
  $('#removejob')?.addEventListener('click', async () => {
    if (confirm('Удалить задание?') && await save((s) => (s.tasks = s.tasks.filter((x) => x.id !== id)))) close();
  });
}

// Форма «Отчёт о выезде» (visitReportForm) живёт в report_form.js — она общая для календаря и «Мониторинга».

// Привязка техники к точке живёт только на отдельной странице /warehouse
// (роль «Склад»/админ) — отсюда, из календаря, точку можно только
// заводить/редактировать её собственные поля, как и договаривались.
// Статусы — управляемый справочник (см. statusesManagerForm ниже), а не
// хардкод-список; _pointStatusCache заполняется loadPointStatuses() в boot().

// Карточка комплекса — полноэкранная, сначала просмотр (по правам роли), правка по кнопке «Редактировать»; живёт в point_card.js и общая с «Все АПК».
async function pointForm(id) {
  return openPointCard(id || null, { edit: !id });
}

// Настройки → Категории АПК: add/rename/recolor/delete the free-form
// point-category dictionary (app/api/routes_point_categories.py) that the
// point form's category combobox reads from — get-or-create there means
// this is the only place to fix a typo or retire an unused category.
async function categoriesManagerForm() {
  let categories;
  try { categories = await Api.get('/api/point-categories'); }
  catch (e) { alert('Не удалось загрузить категории: ' + e.message); return; }

  modal(`<h2 class="font-display text-lg font-bold mb-1">Категории АПК</h2>
    <p class="text-xs text-slate-400 mb-4">«Автораспознавание» — если название/номер комплекса содержит эту подстроку (без учёта регистра), категория присвоится сама при создании/импорте точки. Кнопка ниже расставляет категории и уже существующим точкам без категории. «Старый» — у точек этой категории нет веб-интерфейса: кнопка «Зайти» на карточке точки скачает RDP-файл для подключения к Windows на комплексе вместо обычной ссылки в браузере.</p>
    <button type="button" id="catAutoAssignBtn" class="${btnGhost} w-full mb-4 !py-2">Автоматически расставить категории по уже сохранённым точкам</button>
    <div id="catList" class="space-y-2 max-h-[360px] overflow-auto pr-1 mb-4"></div>
    <form id="catAddForm" class="flex items-center gap-2 flex-wrap">
      <input name="name" placeholder="Новая категория" required class="${fieldCls} flex-1 min-w-[140px]">
      <input name="match_pattern" placeholder="Автораспознавание, напр. ARENA" class="${fieldCls} flex-1 min-w-[140px]">
      <input type="color" name="color" value="#6366f1" class="h-9 w-12 rounded cursor-pointer bg-transparent border border-slate-700 shrink-0">
      <label class="text-xs text-slate-400 shrink-0 flex items-center gap-1 whitespace-nowrap">
        <input type="checkbox" name="is_legacy">Старый
      </label>
      <button class="${btnPrimary} shrink-0">Добавить</button>
    </form>
    <div id="catFormError" class="hidden mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);

  const renderList = (list) => {
    $('#catList').innerHTML = list.map((c) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-2.5 flex items-center gap-2 flex-wrap">
      <input type="color" data-cat-color="${c.id}" value="${c.color}" class="h-8 w-10 rounded cursor-pointer bg-transparent border border-slate-700 shrink-0">
      <input type="text" data-cat-name="${c.id}" value="${esc(c.name)}" class="${fieldCls} flex-1 !py-1.5 min-w-[100px]">
      <input type="text" data-cat-pattern="${c.id}" value="${esc(c.match_pattern || '')}" placeholder="Автораспознавание" class="${fieldCls} flex-1 !py-1.5 min-w-[100px]">
      <label class="text-xs text-slate-400 shrink-0 flex items-center gap-1 whitespace-nowrap">
        <input type="checkbox" data-cat-legacy="${c.id}" ${c.is_legacy ? 'checked' : ''}>Старый
      </label>
      <span class="text-xs text-slate-500 shrink-0 whitespace-nowrap">${c.point_count} точ.</span>
      <button type="button" data-cat-save="${c.id}" class="${btnGhost} !py-1.5 !px-2.5 text-xs shrink-0">Сохранить</button>
      <button type="button" data-cat-del="${c.id}" class="${btnDanger} !py-1.5 !px-2.5 text-xs shrink-0">Удалить</button>
    </div>`).join('') || '<p class="text-sm text-slate-500 text-center py-4">Категорий пока нет</p>';

    $('#catList').querySelectorAll('[data-cat-save]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.catSave;
        const name = $(`[data-cat-name="${id}"]`).value.trim();
        const color = $(`[data-cat-color="${id}"]`).value;
        const match_pattern = $(`[data-cat-pattern="${id}"]`).value.trim();
        const is_legacy = $(`[data-cat-legacy="${id}"]`).checked;
        if (!name) return alert('Название не может быть пустым');
        try { await Api.put(`/api/point-categories/${id}`, { name, color, match_pattern, is_legacy }); await reload(); loadPoints(); }
        catch (err) { alert(err.message); }
      };
    });
    $('#catList').querySelectorAll('[data-cat-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Удалить категорию?')) return;
        try { await Api.del(`/api/point-categories/${btn.dataset.catDel}`); await reload(); loadPoints(); }
        catch (err) { alert(err.message); }
      };
    });
  };

  const reload = async () => { renderList(await Api.get('/api/point-categories')); };
  renderList(categories);

  $('#catAutoAssignBtn').onclick = async () => {
    $('#catAutoAssignBtn').disabled = true;
    try {
      const r = await Api.post('/api/point-categories/auto-assign', {});
      alert(`Расставлено категорий: ${r.assigned}`);
      await reload();
      loadPoints();
    } catch (err) {
      alert(err.message);
    } finally {
      $('#catAutoAssignBtn').disabled = false;
    }
  };

  $('#catAddForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await Api.post('/api/point-categories', { name: f.name.value.trim(), color: f.color.value, match_pattern: f.match_pattern.value.trim(), is_legacy: f.is_legacy.checked });
      f.name.value = '';
      f.match_pattern.value = '';
      f.is_legacy.checked = false;
      await reload();
    } catch (err) {
      $('#catFormError').textContent = err.message;
      $('#catFormError').classList.remove('hidden');
    }
  };
}

// Настройки → Статусы АПК: add/rename/recolor the point-status dictionary
// (app/api/routes_point_statuses.py) that the point form's status datalist
// reads from. "Работает"/"Есть только пинг"/"Не работает"/"На складе"
// нельзя удалить (значок 🔒) — их используют фоновая проверка доступности
// и страница «Склад»; у «На складе» дополнительно нельзя менять название.
// «Типы выездов» — справочник, из которого выбирается «Тип работы» в задании:
// добавить, переименовать, убрать; у каждого признак «связан с ремонтом» (в
// боте такой тип получает меню ремонта, остальные — меню «фото / отчёт /
// завершить» с кнопкой «Перейти в режим ремонта») и, у не связанных с
// ремонтом, список «статусов выезда» — кнопки итога в боте при завершении
// («Найден» / «Не найден»…). Статус выезда — только запись в отчётах и
// статистике, статус комплекса он не меняет. Удаление убирает тип только из
// выбора — созданные задания и отчёты сохраняют название (см.
// app/api/routes_work_types.py).
const LOCKED_WORK_TYPES = new Set(['Ремонт', 'Установка', 'Демонтаж', 'Инвентаризация', 'Вспомогательная точка']);
const STANDARD_OUTCOMES = 'Работает / Не работает / Демонтирован / Установлен';

async function workTypesManagerForm() {
  let types;
  try { types = await Api.get('/api/work-types'); }
  catch (e) { alert('Не удалось загрузить типы выездов: ' + e.message); return; }

  modal(`<h2 class="font-display text-lg font-bold mb-1">Типы выездов</h2>
    <p class="text-xs text-slate-400 mb-4">Из этого списка выбирается «Тип работы» в задании. «Связан с ремонтом» — в боте такой тип получает меню ремонта (проверка доступности, замена оборудования и SIM), итоги у него стандартные. У остальных типов можно включить <b>«Проверка комплекса и SIM в боте»</b> — в меню появятся «Проверка доступности» (результат видит только монтёр, диспетчеру на проверку он не уходит) и «Замена SIM-карты» — и задать <b>статусы выезда</b> — кнопки итога при завершении в боте (например, у инвентаризации «Найден» / «Не найден»): они только записываются в отчёты и статистику и не меняют статус комплекса. Удаление убирает тип только из выбора — созданные задания и отчёты сохраняют название. 🔒 — у типа встроенное поведение, его нельзя переименовать.</p>
    <div id="wtList" class="space-y-2 max-h-[420px] overflow-auto pr-1 mb-4"></div>
    <form id="wtAddForm" class="space-y-2">
      <div class="flex items-center gap-2">
        <input name="name" placeholder="Новый тип выезда" required maxlength="60" class="${fieldCls} flex-1">
        <button class="${btnPrimary} shrink-0">Добавить</button>
      </div>
      <label class="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" name="is_repair" class="rounded accent-indigo-500"> Связан с ремонтом
      </label>
      <label class="flex items-center gap-2 text-xs text-slate-300">
        <input type="checkbox" name="bot_tools" class="rounded accent-indigo-500"> Проверка комплекса и SIM в боте <span class="text-slate-500">(не для ремонта: там это есть всегда)</span>
      </label>
    </form>
    <div id="wtError" class="hidden mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);

  const showError = (msg) => { $('#wtError').textContent = msg; $('#wtError').classList.remove('hidden'); };
  const clearError = () => $('#wtError').classList.add('hidden');
  const reload = async (focusAddFor) => {
    types = await Api.get('/api/work-types');
    await loadWorkTypes();
    renderList();
    if (focusAddFor) {
      [...$('#wtList').querySelectorAll('[data-wt-outcome-add]')].find((i) => i.dataset.wtOutcomeAdd === focusAddFor)?.focus();
    }
  };
  const saveOutcomes = async (name, labels) => {
    try { await Api.put(`/api/work-types/${encodeURIComponent(name)}/outcomes`, { outcomes: labels }); clearError(); await reload(name); }
    catch (err) { showError(err.message); }
  };

  const renderList = () => {
    $('#wtList').innerHTML = types.map((t) => {
      const locked = LOCKED_WORK_TYPES.has(t.name);
      return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 space-y-2">
        <div class="flex items-center gap-2">
          <span class="inline-block h-2.5 w-2.5 rounded-full shrink-0" style="background:${typeColor(t.name) || '#64748b'}"></span>
          <input type="text" data-wt-name="${esc(t.name)}" value="${esc(t.name)}" maxlength="60" ${locked ? 'disabled' : ''} class="${fieldCls} flex-1 !py-1.5 min-w-0">
          ${locked ? '<span class="text-xs text-slate-500 shrink-0" title="У типа встроенное поведение — переименовать нельзя">🔒</span>' : ''}
          <label class="text-xs text-slate-300 shrink-0 flex items-center gap-1.5 whitespace-nowrap">
            <input type="checkbox" data-wt-repair="${esc(t.name)}" class="rounded accent-indigo-500" ${t.is_repair ? 'checked' : ''}>Связан с ремонтом
          </label>
          <button type="button" data-wt-del="${esc(t.name)}" class="${btnDanger} !py-1.5 !px-2.5 text-xs shrink-0">Удалить</button>
        </div>
        ${(t.tasks || t.reports) ? `<div class="text-[11px] text-slate-500">заданий: ${t.tasks} · отчётов: ${t.reports}</div>` : ''}
        ${t.is_repair
          ? `<div class="text-xs text-slate-400">Итоги стандартные: ${STANDARD_OUTCOMES}</div>`
          : `<label class="flex items-center gap-1.5 text-xs text-slate-300" title="В простом меню бота: «Проверка доступности» (без запроса проверки диспетчером) и «Замена SIM-карты»">
              <input type="checkbox" data-wt-tools="${esc(t.name)}" class="rounded accent-indigo-500" ${t.bot_tools ? 'checked' : ''}>Проверка комплекса и SIM в боте
              <span class="text-slate-500">— «Проверка доступности» и «Замена SIM-карты»</span>
            </label>
            <div class="flex flex-wrap items-center gap-1.5">
              <span class="text-xs text-slate-400">Статусы выезда:</span>
              ${t.outcomes.map((o, i) => `<span class="inline-flex items-center gap-1 rounded-full bg-indigo-500/15 text-indigo-200 text-xs pl-2.5 pr-1 py-0.5">${esc(o)}<button type="button" data-wt-outcome-del="${esc(t.name)}" data-i="${i}" class="rounded-full w-4 h-4 grid place-items-center hover:bg-indigo-500/30" title="Убрать">✕</button></span>`).join('')}
              ${t.outcomes.length >= 8 ? '' : `<input type="text" data-wt-outcome-add="${esc(t.name)}" maxlength="30" placeholder="+ статус, Enter" class="${fieldCls} !py-1 !px-2 !text-xs !w-36">`}
            </div>
            ${t.outcomes.length ? '' : '<div class="text-[11px] text-slate-500">Не заданы — в боте стандартные итоги (' + STANDARD_OUTCOMES + ').</div>'}`}
      </div>`;
    }).join('') || '<p class="text-sm text-slate-500 text-center py-4">Типов пока нет</p>';

    $('#wtList').querySelectorAll('[data-wt-name]').forEach((input) => {
      input.onchange = async () => {
        const old = input.dataset.wtName;
        const name = input.value.trim();
        if (!name || name === old) { input.value = old; return; }
        try { await Api.put(`/api/work-types/${encodeURIComponent(old)}`, { name }); clearError(); await reload(); }
        catch (err) { showError(err.message); input.value = old; }
      };
    });
    $('#wtList').querySelectorAll('[data-wt-repair]').forEach((box) => {
      box.onchange = async () => {
        try { await Api.put(`/api/work-types/${encodeURIComponent(box.dataset.wtRepair)}`, { is_repair: box.checked }); clearError(); await reload(); }
        catch (err) { showError(err.message); box.checked = !box.checked; }
      };
    });
    $('#wtList').querySelectorAll('[data-wt-tools]').forEach((box) => {
      box.onchange = async () => {
        try { await Api.put(`/api/work-types/${encodeURIComponent(box.dataset.wtTools)}`, { bot_tools: box.checked }); clearError(); await reload(); }
        catch (err) { showError(err.message); box.checked = !box.checked; }
      };
    });
    $('#wtList').querySelectorAll('[data-wt-del]').forEach((btn) => {
      btn.onclick = async () => {
        const t = types.find((x) => x.name === btn.dataset.wtDel);
        const used = t && (t.tasks || t.reports)
          ? `Тип «${t.name}» используется: заданий ${t.tasks}, отчётов ${t.reports}. Они сохранят название, но тип пропадёт из выбора. Убрать?`
          : `Убрать тип «${btn.dataset.wtDel}» из выбора?`;
        if (!confirm(used)) return;
        try { await Api.del(`/api/work-types/${encodeURIComponent(btn.dataset.wtDel)}`); clearError(); await reload(); }
        catch (err) { showError(err.message); }
      };
    });
    $('#wtList').querySelectorAll('[data-wt-outcome-add]').forEach((input) => {
      input.onkeydown = (e) => {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        const label = input.value.trim();
        if (!label) return;
        const t = types.find((x) => x.name === input.dataset.wtOutcomeAdd);
        saveOutcomes(t.name, [...t.outcomes, label]);
      };
    });
    $('#wtList').querySelectorAll('[data-wt-outcome-del]').forEach((btn) => {
      btn.onclick = () => {
        const t = types.find((x) => x.name === btn.dataset.wtOutcomeDel);
        saveOutcomes(t.name, t.outcomes.filter((_, i) => i !== +btn.dataset.i));
      };
    });
  };
  renderList();

  $('#wtAddForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await Api.post('/api/work-types', { name: f.name.value, is_repair: f.is_repair.checked, bot_tools: f.bot_tools.checked });
      f.name.value = ''; f.is_repair.checked = false; f.bot_tools.checked = false;
      clearError();
      await reload();
    } catch (err) { showError(err.message); }
  };
}

async function statusesManagerForm() {
  let statuses;
  try { statuses = await Api.get('/api/point-statuses'); }
  catch (e) { alert('Не удалось загрузить статусы: ' + e.message); return; }

  modal(`<h2 class="font-display text-lg font-bold mb-1">Статусы АПК</h2>
    <p class="text-xs text-slate-400 mb-4">«Авто» — статус может выставить фоновая проверка доступности точек. 🔒 — системный статус, его нельзя удалить (у «На складе» также нельзя менять название).</p>
    <div id="statusList" class="space-y-2 max-h-[360px] overflow-auto pr-1 mb-4"></div>
    <form id="statusAddForm" class="flex items-center gap-2">
      <input name="name" placeholder="Новый статус" required class="${fieldCls} flex-1">
      <input type="color" name="color" value="#64748b" class="h-9 w-12 rounded cursor-pointer bg-transparent border border-slate-700 shrink-0">
      <button class="${btnPrimary} shrink-0">Добавить</button>
    </form>
    <div id="statusFormError" class="hidden mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);

  const LOCKED_NAMES = new Set(['На складе']);
  const renderList = (list) => {
    $('#statusList').innerHTML = list.map((s) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-2.5 flex items-center gap-2">
      <input type="color" data-st-color="${s.id}" value="${s.color}" class="h-8 w-10 rounded cursor-pointer bg-transparent border border-slate-700 shrink-0">
      <input type="text" data-st-name="${s.id}" value="${esc(s.name)}" ${s.protected && LOCKED_NAMES.has(s.name) ? 'disabled' : ''} class="${fieldCls} flex-1 !py-1.5">
      <label class="text-xs text-slate-400 shrink-0 flex items-center gap-1 whitespace-nowrap">
        <input type="checkbox" data-st-auto="${s.id}" ${s.is_auto ? 'checked' : ''}>Авто
      </label>
      ${s.protected ? '<span class="text-xs text-slate-500 shrink-0" title="Системный статус">🔒</span>' : ''}
      <button type="button" data-st-save="${s.id}" class="${btnGhost} !py-1.5 !px-2.5 text-xs shrink-0">Сохранить</button>
      ${!s.protected ? `<button type="button" data-st-del="${s.id}" class="${btnDanger} !py-1.5 !px-2.5 text-xs shrink-0">Удалить</button>` : ''}
    </div>`).join('') || '<p class="text-sm text-slate-500 text-center py-4">Статусов пока нет</p>';

    $('#statusList').querySelectorAll('[data-st-save]').forEach((btn) => {
      btn.onclick = async () => {
        const id = btn.dataset.stSave;
        const name = $(`[data-st-name="${id}"]`).value.trim();
        const color = $(`[data-st-color="${id}"]`).value;
        const is_auto = $(`[data-st-auto="${id}"]`).checked;
        if (!name) return alert('Название не может быть пустым');
        try { await Api.put(`/api/point-statuses/${id}`, { name, color, is_auto }); await reload(); await loadPointStatuses(); }
        catch (err) { alert(err.message); }
      };
    });
    $('#statusList').querySelectorAll('[data-st-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Удалить статус?')) return;
        try { await Api.del(`/api/point-statuses/${btn.dataset.stDel}`); await reload(); await loadPointStatuses(); }
        catch (err) { alert(err.message); }
      };
    });
  };

  const reload = async () => { renderList(await Api.get('/api/point-statuses')); };
  renderList(statuses);

  $('#statusAddForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await Api.post('/api/point-statuses', { name: f.name.value.trim(), color: f.color.value, is_auto: false });
      f.name.value = '';
      await reload();
      await loadPointStatuses();
    } catch (err) {
      $('#statusFormError').textContent = err.message;
      $('#statusFormError').classList.remove('hidden');
    }
  };
}

// Бригада целиком в одном окне: название, место работ, ссылка на карту / заметка и состав.
// Для бригады в командировке правка применяется ко всем её дням (см.
// crew_repository.update_crew).
async function editCrewInfo(crewId) {
  const crew = DAY_CREWS.find((c) => c.id === crewId);
  if (!crew) return;
  let people, busyIds, absentMap;
  try {
    [people, busyIds, absentMap] = await Promise.all([
      Api.get('/api/people?active_only=true'),
      Api.get('/api/crews?date=' + crew.date).then((crews) => {
        const s = new Set();
        crews.forEach((c) => { if (c.id !== crewId) c.members.forEach((p) => s.add(p.id)); });
        return s;
      }),
      Api.get('/api/people/absent-on/' + crew.date),
    ]);
  } catch (e) { alert('Не удалось загрузить персонал: ' + e.message); return; }

  const mine = new Set(crew.members.map((p) => p.id));
  const mapLink = (crew.map_link || '').trim();
  modal(`<h2 class="font-display text-lg font-bold mb-1">Бригада</h2>
    <p class="text-sm text-slate-400 mb-4">На ${esc(fmtDate(crew.date))}${crew.trip_id ? ' · командировка: правка применится ко всем дням' : ''}</p>
    <form id="crewInfoForm" class="space-y-4">
      <label class="${labelCls}">Название<input name="name" required value="${esc(crew.name)}" class="${fieldCls}"></label>
      <label class="${labelCls}">Место работ<input name="place" value="${esc(crew.place || '')}" placeholder="например: г. Тихорецк, ст. Северская или по дороге А-147" class="${fieldCls}"></label>
      <p class="text-xs text-slate-500 -mt-2">Место идёт в план-задание («на местах дислокации …») и в текст бригады для копирования.</p>
      <div>
        <label class="${labelCls} block">Ссылка на карту / заметка<input name="mapLink" value="${esc(mapLink)}" placeholder="ссылка на карту бригады или любая заметка — попадёт в текст бригады и в бота" class="${fieldCls}"></label>
        <div class="flex flex-wrap items-center gap-2 mt-2">
          <button data-perm="maps.manage" type="button" id="crewMapRobotBtn" class="${btnGhost} !py-1 !px-3 text-xs" title="Робот создаст карту в Конструкторе карт Яндекса (с подписями меток) или обновит уже созданную и вставит ссылку сюда">🤖 Создать / обновить карту в Яндексе</button>
          <a id="crewMapLinkOpen" href="${hasYandexMapLink(crew) ? esc(mapLink) : '#'}" target="_blank" rel="noopener" class="${hasYandexMapLink(crew) ? '' : 'hidden '}text-xs text-indigo-400 hover:underline">открыть карту ↗</a>
          <span id="crewMapLinkNote" class="text-[11px] text-slate-500"></span>
        </div>
      </div>
      <div>
        <b class="text-sm block mb-2">Состав бригады</b>
        ${personPickerHtml(people, { checkedIds: mine, busyIds, absentMap, contractor: { on: crew.contractor, note: crew.contractor_note } })}
      </div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);

  $('#crewMapRobotBtn').onclick = (e) => createCrewMapInline(crew, {
    input: $('#crewInfoForm').elements.mapLink, note: $('#crewMapLinkNote'), btn: e.currentTarget, open: $('#crewMapLinkOpen'),
  });
  $('#crewInfoForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const name = f.name.value.trim();
    if (!name) return;
    const ids = [...e.target.querySelectorAll('input[name="person"]:checked')].map((el) => +el.value);
    try {
      await Api.put(`/api/crews/${crewId}`, { name, place: f.place.value.trim(), map_link: f.mapLink.value.trim(), person_ids: ids, ...crewContractorFields(e.target) });
      close();
    } catch (err) { alert(err.message); }
  };
}

// ---------- Текст бригады для копирования (в чат/рассылку) ----------
// «1) Командировка Псебай 30.09.2026-02.10.2026 / Восстановление / монтеры:
// … / водители: … / ссылка на карту». Места берутся из «Места работ»
// бригады (без «г.»/«ст.»…; нет места — название бригады), виды работ —
// из типов её заданий (для командировки — за всю командировку), ссылка —
// из поля «Ссылка на карту / заметка» окна «Изменить» бригады. Даты в тексте — как в
// рассылке: «30.09» (день) и «30.09.2026-02.10.2026» (командировка).
const COPY_TYPE_LABEL = { 'Ремонт': 'Восстановление' };
const ddmm = (iso) => fmtDate(iso).slice(0, 5).replace('-', '.');
const ddmmyyyy = (iso) => fmtDate(iso).replaceAll('-', '.');
const cleanPlace = (p) => String(p || '').trim()
  .replace(/^(в|на)\s+/i, '').replace(/^по\s+дороге\s+/i, '')
  .replace(/^(г|ст|пгт|пос|п|с|х|аул)\.\s*/i, '').replace(/^(г|ст|пгт|пос|аул)\s+/i, '').trim();
const INITIALS_RE = /^([А-ЯЁA-Z]\.?)+$/;

function personInitials(fullName, all) {
  const letters = String(fullName || '').trim().split(/\s+/).slice(1).flatMap((tok) => (
    INITIALS_RE.test(tok) ? tok.replace(/\./g, '').split('') : [tok[0]?.toUpperCase() || '']
  )).filter(Boolean).map((l) => l + '.');
  return all ? letters.join('') : (letters[0] || '');
}

// Фамилия; если у двух разных людей в бригадах этого дня одна фамилия —
// с инициалом («Савченко И.»), а если и инициал совпал — с обоими.
function surnameLabeler() {
  const people = new Map();
  DAY_CREWS.forEach((c) => c.members.forEach((p) => people.set(p.id, p)));
  const surname = (p) => String(p.full_name || '').trim().split(/\s+/)[0] || '';
  const bySurname = new Map();
  people.forEach((p) => {
    const k = surname(p).toLowerCase();
    if (!bySurname.has(k)) bySurname.set(k, []);
    bySurname.get(k).push(p);
  });
  return (p) => {
    const same = bySurname.get(surname(p).toLowerCase()) || [p];
    if (same.length < 2) return surname(p);
    const short = `${surname(p)} ${personInitials(p.full_name, false)}`.trim();
    const clash = same.some((o) => o.id !== p.id && `${surname(o)} ${personInitials(o.full_name, false)}`.trim() === short);
    return clash ? `${surname(p)} ${personInitials(p.full_name, true)}`.trim() : short;
  };
}

function crewCopyText(crew, number) {
  if (!crew) return '';
  const label = surnameLabeler();
  const jobsList = crewVisibleJobs(crew.id).filter((j) => !isAuxTask(j));
  const types = [...new Set(jobsList.map((j) => COPY_TYPE_LABEL[j.type] || j.type).filter(Boolean))];
  const notes = [...new Set(jobsList.map((j) => (j.note || '').trim()).filter((n) => n && n !== 'Импорт KML'))];
  const equip = ['Лестница', 'Автовышка'].includes(crew.equip) ? [crew.equip.toLowerCase()] : [];
  const works = [types.join(' + '), ...notes.map((n) => `(${n})`), ...equip.map((z) => `(${z})`)].filter(Boolean).join(' ');

  const fitters = crew.members.filter((p) => p.role_type === 'fitter').map(label).join(', ');
  const drivers = crew.members.filter((p) => p.role_type === 'driver').map(label).join(', ');
  const place = cleanPlace(crew.place) || crew.name;
  const when = crew.trip_id ? `${ddmmyyyy(crew.trip_from)}-${ddmmyyyy(crew.trip_to)}` : ddmm(crew.date);
  const head = `${number ? number + ') ' : ''}${crew.trip_id ? 'Командировка ' : ''}${place} ${when}`;

  const lines = [head, ''];
  if (works) lines.push(works, '');
  if (fitters) lines.push(`монтеры: ${fitters}`);
  if (drivers) lines.push(`водители: ${drivers}`);
  if (crew.contractor) lines.push(`подрядчик${crew.contractor_note ? ': ' + crew.contractor_note : ''}`);
  if (fitters || drivers || crew.contractor) lines.push('');
  if ((crew.map_link || '').trim()) lines.push(crew.map_link.trim());
  return lines.join('\n').replace(/\n+$/, '');
}

function allCrewsCopyText() {
  return DAY_CREWS.filter((c) => crewVisibleJobs(c.id).some((j) => !isAuxTask(j)))
    .map((c, i) => crewCopyText(c, i + 1)).join('\n\n');
}

// Копирование в буфер с запасным путём (старый браузер / не-HTTPS) и
// короткой подсказкой на самой кнопке; если и так не вышло — текст
// показывается в окне, откуда его можно скопировать вручную.
async function copyText(text, btn) {
  if (!text) { alert('Нечего копировать — у бригад на этот день нет заданий.'); return; }
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; }
  catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (!ok) {
    modal(`<h2 class="font-display text-lg font-bold mb-3">Текст для копирования</h2>
      <textarea readonly rows="12" class="${fieldCls} font-mono text-xs">${esc(text)}</textarea>
      <button type="button" class="cancel ${btnGhost} mt-3">Закрыть</button>`);
    $('#modal textarea')?.select();
    return;
  }
  if (btn) {
    const old = btn.textContent;
    btn.textContent = '✅ Скопировано';
    setTimeout(() => { btn.textContent = old; }, 1600);
  }
}

// ---------- KML ----------
async function fileText(f) {
  const b = await f.arrayBuffer();
  let t = new TextDecoder('utf-8').decode(b);
  if (t.includes('�')) t = new TextDecoder('windows-1251').decode(b);
  return t.replace(/^﻿/, '');
}
function kmlMarks(text) {
  const x = new DOMParser().parseFromString(text, 'application/xml');
  if (x.querySelector('parsererror')) throw Error('Файл KML повреждён');
  return [...x.getElementsByTagNameNS('*', 'Placemark')].map((p) => {
    const n = decodeEntities(p.getElementsByTagNameNS('*', 'name')[0]?.textContent).trim();
    const d = decodeEntities(p.getElementsByTagNameNS('*', 'description')[0]?.textContent).trim();
    const c = p.getElementsByTagNameNS('*', 'coordinates')[0]?.textContent.trim().split(/\s+/)[0]?.split(',') || [];
    return { id: n, description: d, lon: c[0] || '', lat: c[1] || '' };
  }).filter((p) => p.id && p.lat && p.lon);
}
function mapMenu() {
  modal(`<h2 class="font-display text-lg font-bold mb-2">Карты KML</h2>
    <p class="text-sm text-slate-400 mb-4">Один загружаемый KML-файл — это задания одной бригады на выбранную дату; состав бригады собирается тут же при импорте.</p>
    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-3">
      <b class="text-sm">Импорт из Конструктора карт</b>
      <p class="text-xs text-slate-400 mt-1 mb-3">Имена меток станут номерами точек, координаты и описания сохранятся в общем справочнике.</p>
      <button data-perm="calendar.edit" id="pickKml" class="${btnPrimary}">Выбрать KML</button>
    </div>
    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 space-y-1.5">
      <b class="text-sm">Экспорт</b>
      <p class="text-sm"><a data-perm="calendar.print,maps.manage,points.export" href="/api/kml/day/${D}" download class="text-indigo-300 hover:underline">Задания за ${fmtDate(D)}</a></p>
      <p class="text-sm"><a data-perm="calendar.print,maps.manage,points.export" href="/api/kml/points" download class="text-indigo-300 hover:underline">Все точки с координатами</a></p>
    </div>
    <button type="button" class="cancel ${btnGhost} mt-4">Закрыть</button>`);
  $('#pickKml').onclick = () => $('#kmlFile').click();
}
async function previewKml(f) {
  try {
    const marks = kmlMarks(await fileText(f));
    if (!marks.length) throw Error('В файле нет подписанных точек с координатами');

    let people = [];
    try { people = await Api.get('/api/people?active_only=true'); } catch { /* non-fatal — picker just shows nothing */ }

    const peopleBlock = async (date) => {
      const [busyIds, absentMap] = await Promise.all([
        Api.get('/api/crews?date=' + date).then((crews) => new Set(crews.flatMap((c) => c.members.map((p) => p.id)))).catch(() => new Set()),
        Api.get('/api/people/absent-on/' + date).catch(() => ({})),
      ]);
      return personPickerHtml(people, { busyIds, absentMap });
    };

    modal(`<h2 class="font-display text-lg font-bold mb-4">Импорт KML</h2>
      <form id="kmlForm" class="space-y-4">
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls} col-span-2">Дата заданий<input name="date" type="date" required value="${D}" class="${fieldCls}"></label>
        </div>
        <div class="space-y-2 rounded-xl border border-slate-700/40 bg-slate-800/20 p-3">
          <label class="flex items-center gap-2 text-sm"><input type="radio" name="crewMode" value="new" class="accent-indigo-500" checked> Создать новую бригаду</label>
          <label class="flex items-center gap-2 text-sm" id="kmlExistingLabel"><input type="radio" name="crewMode" value="existing" class="accent-indigo-500"> Добавить в уже существующую бригаду (с её точками и составом)</label>
          <select name="existingCrew" id="kmlExistingCrew" class="${fieldCls} hidden"></select>
          <p id="kmlExistingNote" class="text-xs text-slate-500 hidden"></p>
        </div>
        <div id="kmlNewCrewFields" class="space-y-4">
          <div class="grid grid-cols-2 gap-3">
            <label class="${labelCls}">Транспорт<select name="equip" class="${fieldCls}">${EQUIP_OPTIONS.map((z) => `<option>${z}</option>`).join('')}</select></label>
            <label class="${labelCls} col-span-2">Название бригады (необязательно)<input name="crewName" placeholder="например: трасса М-4" class="${fieldCls}"></label>
            <label class="${labelCls} col-span-2">Место работ (необязательно)<input name="place" placeholder="например: г. Тихорецк, ст. Северская или по дороге А-147" class="${fieldCls}"></label>
          </div>
          <div id="kmlPeople">${await peopleBlock(D)}</div>
        </div>
        <p class="text-sm"><b>Найдено меток: ${marks.length}</b></p>
        <p class="text-xs text-slate-500 -mt-2">Выберите тип работы для каждой точки — описание рядом подскажет, что там делать. Если тип один для всех (или для большинства) — отметьте нужные точки и примените его сразу пачкой.</p>
        <div class="flex flex-wrap items-center gap-2 rounded-xl border border-slate-700/40 bg-slate-800/20 p-2.5">
          <label class="flex items-center gap-1.5 text-xs text-slate-300">
            <input type="checkbox" id="kmlSelectAll" class="rounded accent-indigo-500" checked> Все
          </label>
          <select id="kmlBulkType" class="${fieldCls} !py-1 !text-xs !w-auto">
            <option value="">— тип для выбранных —</option>
            ${VISIT_TYPES.map((z) => `<option>${esc(z)}</option>`).join('')}
          </select>
          <button type="button" id="kmlBulkApply" class="${btnGhost} !py-1 !px-2.5 text-xs">Применить к отмеченным</button>
        </div>
        <div class="max-h-64 overflow-auto space-y-1.5 pr-1">
          ${marks.slice(0, 150).map((p, i) => `<div class="rounded-xl bg-slate-800/40 border border-slate-700/40 p-2.5 text-xs space-y-1.5">
            <div class="flex items-start gap-2">
              <input type="checkbox" data-mark-check="${i}" class="rounded accent-indigo-500 mt-0.5" checked>
              <div><b>${esc(p.id)}</b><br><span class="text-slate-400">${esc(p.description || 'Без описания')} · ${esc(p.lat)}, ${esc(p.lon)}</span></div>
            </div>
            <select data-mark-type="${i}" class="${fieldCls} !py-1 !text-xs" required>
              <option value="">— тип работы —</option>
              ${VISIT_TYPES.map((z) => `<option>${esc(z)}</option>`).join('')}
            </select>
          </div>`).join('')}
          ${marks.length > 150 ? '<p class="text-xs text-slate-500">Показаны первые 150 меток — у остальных тип нужно будет выставить вручную после импорта.</p>' : ''}
        </div>
        <div id="kmlError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
        <div class="flex items-center gap-2 pt-2">
          <button type="button" class="cancel ${btnGhost}">Отмена</button>
          <button class="${btnPrimary}" id="kmlSubmit">Создать бригаду и добавить точки</button>
        </div>
      </form>`);

    // Бригады выбранной даты для режима «в существующую»: название, состав, сколько точек уже в ней.
    let dayCrews = [];
    const crewModeIsExisting = () => $('#kmlForm').elements.crewMode.value === 'existing';
    const syncKmlMode = () => {
      const existing = crewModeIsExisting();
      $('#kmlNewCrewFields').classList.toggle('hidden', existing);
      $('#kmlExistingCrew').classList.toggle('hidden', !existing);
      $('#kmlExistingNote').classList.toggle('hidden', !existing);
      $('#kmlSubmit').textContent = existing ? 'Добавить точки в бригаду' : 'Создать бригаду и добавить точки';
    };
    const loadDayCrews = async (date) => {
      try { dayCrews = await Api.get('/api/crews?date=' + date); } catch { dayCrews = []; }
      const sel = $('#kmlExistingCrew');
      const countOf = (c) => ((typeof S !== 'undefined' && S.tasks) ? S.tasks.filter((t) => t.date === date && t.team === c.id && !isAuxTask(t)).length : 0);
      sel.innerHTML = dayCrews.map((c) => `<option value="${c.id}">${esc(c.name || 'Бригада')} · ${esc((c.members || []).map((m) => m.full_name).join(', ') || 'без состава')} · точек: ${countOf(c)}</option>`).join('');
      const radio = $('#kmlForm').elements.crewMode;
      const none = !dayCrews.length;
      [...radio].forEach((r) => { if (r.value === 'existing') r.disabled = none; });
      $('#kmlExistingLabel').classList.toggle('opacity-50', none);
      $('#kmlExistingNote').textContent = none ? `На ${fmtDate(date)} бригад ещё нет — создайте новую.` : 'Новые точки добавятся к заданиям этой бригады; состав и транспорт останутся прежними. Точка, которая в этот день уже есть в заданиях, не добавляется второй раз.';
      $('#kmlExistingNote').classList.toggle('hidden', !crewModeIsExisting());
      if (none && crewModeIsExisting()) { radio.value = 'new'; }
      syncKmlMode();
    };
    $('#kmlForm').elements.crewMode.forEach((r) => { r.onchange = syncKmlMode; });
    $('#kmlForm').elements.date.onchange = async (e) => { $('#kmlPeople').innerHTML = await peopleBlock(e.target.value); await loadDayCrews(e.target.value); };
    await loadDayCrews(D);

    $('#kmlSelectAll').onchange = (e) => {
      $('#modal').querySelectorAll('[data-mark-check]').forEach((chk) => { chk.checked = e.target.checked; });
    };
    $('#kmlBulkApply').onclick = () => {
      const bulkType = $('#kmlBulkType').value;
      if (!bulkType) { alert('Сначала выберите тип работы для применения.'); return; }
      const checked = $('#modal').querySelectorAll('[data-mark-check]:checked');
      if (!checked.length) { alert('Отметьте хотя бы одну точку в списке ниже.'); return; }
      checked.forEach((chk) => {
        const sel = $('#modal').querySelector(`[data-mark-type="${chk.dataset.markCheck}"]`);
        if (sel) sel.value = bulkType;
      });
    };

    $('#kmlForm').onsubmit = async (e) => {
      e.preventDefault();
      const f = e.target.elements;
      const day = f.date.value;
      const person_ids = [...e.target.querySelectorAll('input[name="person"]:checked')].map((el) => +el.value);

      const markType = {};
      e.target.querySelectorAll('[data-mark-type]').forEach((el) => { markType[+el.dataset.markType] = el.value; });
      if (marks.slice(0, 150).some((_, i) => !markType[i])) {
        $('#kmlError').textContent = 'Выберите тип работы для каждой точки в списке ниже.';
        $('#kmlError').classList.remove('hidden');
        return;
      }

      let crew;
      const toExisting = crewModeIsExisting();
      if (toExisting) {
        crew = dayCrews.find((c) => String(c.id) === String(f.existingCrew.value));
        if (!crew) {
          $('#kmlError').textContent = 'Выберите бригаду, в которую добавить точки.';
          $('#kmlError').classList.remove('hidden');
          return;
        }
      } else {
        try {
          crew = await Api.post('/api/crews', { date: day, name: f.crewName.value.trim(), equip: f.equip.value, place: f.place.value.trim(), person_ids, ...crewContractorFields(e.target) });
        } catch (err) {
          $('#kmlError').textContent = 'Не удалось создать бригаду: ' + err.message;
          $('#kmlError').classList.remove('hidden');
          return;
        }
      }
      const team = crew.id;

      // Points are their own resource now (not part of S) — upsert them
      // first (in parallel, one request per mark), then attach tasks.
      // «Вспомогательные точки» в справочник не попадают — они остаются заданием этого дня.
      // Какой уже заведённый комплекс скрывается за меткой (регистр, пробелы, «+1»/«+2», инвентарный номер) — решает сервер,
      // чтобы не плодить новые точки «НОМЕР +1»; повторы одной метки в файле становятся одним новым комплексом.
      let resolved = [];
      try { resolved = (await Api.post('/api/points/resolve', { labels: marks.map((m) => m.id) })).items; } catch { /* без подсказки сервера — по номеру, как раньше */ }
      const creating = new Map();
      const recognised = [];
      const results = await Promise.all(marks.map(async (m, i) => {
        if (markType[i] === AUX_TYPE) return [m.id, m.id];
        const hint = resolved[i];
        const existing = (hint?.point_id && POINTS.find((x) => x.id === hint.point_id)) || POINTS.find((x) => normId(x.id) === normId(m.id));
        try {
          if (existing) {
            if (existing.id !== m.id) recognised.push(`${m.id} → ${existing.id}`);
            // Метка-повтор («НОМЕР +1») не перекраивает координаты основного комплекса.
            if (!hint?.dup) await Api.put(`/api/points/${encodeURIComponent(existing.id)}`, { ...existing, lat: m.lat, lon: m.lon, description: existing.description || m.description });
            return [m.id, existing.id];
          }
          const newId = hint?.create_as || m.id;
          if (!creating.has(newId)) creating.set(newId, Api.post('/api/points', { id: newId, address: '', description: m.description, lat: m.lat, lon: m.lon }).then((c) => c.id));
          return [m.id, await creating.get(newId)];
        } catch { return [m.id, hint?.create_as || m.id]; } // keep the raw id — the task still gets created even if the point upsert failed
      }));
      const pointIdByMarkId = Object.fromEntries(results);
      await loadPoints();

      // Точка, которая в этот день уже есть в заданиях (у любой бригады, или
      // повторяется в самом файле), не добавляется второй раз.
      let added = 0;
      let auxAdded = 0;
      let skippedPoints = [];
      if (await save((s) => {
        added = 0;
        auxAdded = 0;
        skippedPoints = [];
        marks.forEach((m, i) => {
          if (markType[i] === AUX_TYPE) {
            if (s.tasks.some((t) => t.date === day && isAuxTask(t) && normId(t.point) === normId(m.id) && String(t.aux_lat) === String(m.lat) && String(t.aux_lon) === String(m.lon))) return;
            s.tasks.push({ id: 't' + crypto.randomUUID(), date: day, team, point: m.id, work: m.description, address: '', hours: 0, travel: 0, type: AUX_TYPE, note: 'Импорт KML', aux_lat: String(m.lat), aux_lon: String(m.lon) });
            auxAdded++;
            return;
          }
          const pointId = pointIdByMarkId[m.id];
          if (s.tasks.some((t) => t.date === day && !isAuxTask(t) && normId(t.point) === normId(pointId))) { skippedPoints.push(pointId); return; }
          s.tasks.push({ id: 't' + crypto.randomUUID(), date: day, team, point: pointId, work: m.description, address: '', hours: 1, travel: 0, type: markType[i] || '', note: 'Импорт KML' });
          added++;
        });
      })) {
        D = day; V = new Date(D + 'T12:00:00'); close();
        const lines = [toExisting ? `Импорт завершён. Точки добавлены в существующую бригаду «${crew.name || 'Бригада'}». Добавлено заданий: ${added}.` : `Импорт завершён. Бригада «${crew.name}» создана. Добавлено заданий: ${added}.`];
        if (auxAdded) lines.push(`Вспомогательных точек (только на карте этого дня): ${auxAdded}.`);
        if (recognised.length) lines.push(`Узнал уже заведённые комплексы, новые не созданы (${recognised.length}): ${recognised.slice(0, 10).join('; ')}${recognised.length > 10 ? '…' : ''}.`);
        if (skippedPoints.length === 1) lines.push(`Такая точка уже добавлена: ${skippedPoints[0]}. Новая пропущена.`);
        else if (skippedPoints.length) lines.push(`Такие точки уже добавлены (пропущены): ${skippedPoints.join(', ')}.`);
        alert(lines.join('\n'));
      }
    };
  } catch (e) { alert('Не удалось импортировать KML: ' + e.message); }
}

// ---------- Excel ----------
async function importExcelFile(f) {
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await Api.upload('/api/excel/import', fd);
    const lines = [
      `Новых точек: ${r.added}`,
      `Обновлено точек: ${r.updated}`,
    ];
    if (r.row_errors?.length) lines.push('', 'Ошибки:', ...r.row_errors.slice(0, 20));
    alert(lines.join('\n'));
    await loadPoints();
  } catch (e) { alert('Не удалось импортировать файл: ' + e.message); }
}

// Единый импорт SIM/IP (app/services/sim_import.py): комплекс в строке необязателен.
async function importSimFile(f) {
  const fd = new FormData();
  fd.append('file', f);
  try {
    const r = await Api.upload('/api/excel/sim-import', fd);
    const li = (n, text) => (n ? `<li><b>${n}</b> — ${text}</li>` : '');
    modal(`<h2 class="font-display text-lg font-bold mb-1">Загрузка SIM/IP — итоги</h2>
      <p class="text-xs text-slate-400 mb-3">Строк в таблице: ${r.rows}</p>
      <ul class="text-sm space-y-1 list-disc pl-5">
        ${li(r.registry_new, 'новых пар «SIM — IP» добавлено в реестр')}
        ${li(r.registry_changed, 'пар, у которых изменился IP (обновлено)')}
        ${li(r.registry_same, 'пар совпали с реестром (без изменений)')}
        ${li(r.bound, 'комплексов обновлено (SIM/IP записаны в карточку)')}
        ${li(r.bound_same, 'комплексов уже были заполнены так же')}
        ${li(r.points_synced, 'комплексам подтянулись изменения из реестра (по SIM или IP)')}
        ${li(r.no_point, 'комплексов из таблицы не найдено в справочнике')}
        ${li(r.skipped, 'строк пропущено')}
      </ul>
      ${r.notes?.length ? `<div class="mt-3 text-xs text-amber-200/90 space-y-0.5 max-h-56 overflow-auto rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">${r.notes.map((n) => `<div>${esc(n)}</div>`).join('')}${r.notes_total > r.notes.length ? `<div>… и ещё ${r.notes_total - r.notes.length}</div>` : ''}</div>` : ''}
      <div class="pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
    await loadPoints();
  } catch (e) { alert('Не удалось импортировать файл: ' + e.message); }
}

// «Документы» собраны в группы: у каждой — окно со всеми действиями и пояснением к каждому.
function docsPanel(title, intro, allItems) {
  const items = allItems.filter((it) => !it.perm || canAny(...[].concat(it.perm)));      // действия, на которые у роли нет права, не показываются
  modal(`<h2 class="font-display text-lg font-bold mb-1">${esc(title)}</h2>
    <p class="text-xs text-slate-400 mb-4">${esc(intro)}</p>
    <div class="space-y-2">${items.map((it, i) => `<button type="button" data-doc="${i}" class="w-full text-left rounded-xl border border-slate-700/60 bg-slate-800/40 hover:bg-slate-700/50 px-3.5 py-2.5 transition-colors">
        <span class="block text-sm font-medium">${esc(it.label)}</span>
        <span class="block text-[11px] text-slate-400 mt-0.5">${esc(it.hint)}</span></button>`).join('')}</div>
    <div class="pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
  document.querySelectorAll('#modal [data-doc]').forEach((b) => {
    b.onclick = () => { close(); items[+b.dataset.doc].run(); };
  });
}

function docsPointsPanel() {
  docsPanel('Точки (комплексы)', 'Справочник комплексов «Все АПК»: загрузка и выгрузка в Excel.', [
    { perm: 'points.import', label: 'Скачать шаблон Excel', hint: 'Пустая таблица с нужными столбцами и инструкцией: заполните её и загрузите кнопкой ниже.', run: () => { window.location.href = '/api/excel/template'; } },
    { perm: 'points.import', label: 'Импорт точек из Excel', hint: 'Новые комплексы добавятся, у уже заведённых обновятся заполненные поля. Пустая ячейка ничего не затирает.', run: () => $('#excelFile').click() },
    { perm: 'points.export', label: 'Скачать все точки (.xlsx)', hint: 'Весь справочник в том же формате, что и шаблон: можно поправить в Excel и загрузить обратно.', run: () => { window.location.href = '/api/excel/export'; } },
    { perm: 'points.import', label: 'Импорт из «Паутины»…', hint: 'Выгрузка из другой программы: столбцы ищутся по названию, обновляются только заведённые комплексы, не найденные попадут в Excel-файл итогов.', run: () => openPautinaImport() },    // pautina_import.js
  ]);
}

function docsSimPanel() {
  docsPanel('SIM-карты', 'Один шаблон для всего: номер SIM (ICC) и IP, а комплекс указывать необязательно.', [
    { perm: 'points.import', label: 'Скачать шаблон SIM/IP', hint: 'Столбцы: номер SIM (ICC), IP-адрес и «Комплекс (необязательно)». Инструкция — на втором листе.', run: () => { window.location.href = '/api/excel/sim-template'; } },
    { perm: 'points.import', label: 'Загрузить таблицу SIM/IP…', hint: 'Комплекса в строке нет — программа сверяет номер SIM и IP с реестром (новые пары добавляются, изменившийся IP обновляется). Комплекс указан — то же самое и SIM с IP привязываются к нему.', run: () => $('#simImportFile').click() },
    { perm: 'points.network', label: 'Выгрузка SIM и IP (.xlsx)…', hint: 'SIM и IP в Excel: по категориям комплексов, по статусам или только те, что нигде не числятся.', run: () => openSimExport() },    // sim_export.js
  ]);
}

function docsReportsPanel() {
  docsPanel('Отчёты и история выездов', 'Отчёты, которые сдавались вне бота, и старые выезды.', [
    { perm: 'reports.edit', label: 'Отчёты из таблицы Яндекс Форм…', hint: 'Выгрузка ответов формы: по номеру комплекса находится задание (±1 день), по нему создаётся отчёт; фото из ссылок скачиваются через браузер робота карт.', run: () => openFormsImport() },    // forms_import.js
    { perm: 'reports.edit', label: 'История выездов из Excel…', hint: 'Старые выезды: когда, кто, комплекс, что сделано, статус — попадут в «История выездов» у карточки комплекса.', run: () => openVisitHistoryImport() },    // visit_history.js
  ]);
}

// ---------- wiring ----------
function closeDropdowns() { $('#excelMenu').classList.add('hidden'); $('#settingsMenu').classList.add('hidden'); $('#userMenu').classList.add('hidden'); }
document.addEventListener('click', (e) => {
  if (!e.target.closest('#excelMenuBtn') && !e.target.closest('#excelMenu')) $('#excelMenu').classList.add('hidden');
  if (!e.target.closest('#settingsMenuBtn') && !e.target.closest('#settingsMenu')) $('#settingsMenu').classList.add('hidden');
  if (!e.target.closest('#userMenuBtn') && !e.target.closest('#userMenu')) $('#userMenu').classList.add('hidden');
});
$('#excelMenuBtn').onclick = () => { $('#settingsMenu').classList.add('hidden'); $('#userMenu').classList.add('hidden'); $('#excelMenu').classList.toggle('hidden'); };
$('#settingsMenuBtn').onclick = () => { $('#excelMenu').classList.add('hidden'); $('#userMenu').classList.add('hidden'); $('#settingsMenu').classList.toggle('hidden'); };
$('#planTemplateSettingsBtn').onclick = () => { $('#settingsMenu').classList.add('hidden'); openPlanTemplateSettings(); };
$('#userMenuBtn').onclick = () => { $('#excelMenu').classList.add('hidden'); $('#settingsMenu').classList.add('hidden'); $('#userMenu').classList.toggle('hidden'); };
$('#categoriesBtn').onclick = () => { closeDropdowns(); categoriesManagerForm(); };
$('#statusesBtn').onclick = () => { closeDropdowns(); statusesManagerForm(); };
$('#workTypesBtn').onclick = () => { closeDropdowns(); workTypesManagerForm(); };
$('#dupPointsBtn').onclick = () => { closeDropdowns(); openPointDuplicates(); };   // point_merge.js
$('#weatherSettingsBtn').onclick = () => { closeDropdowns(); openWeatherSettings(); };   // weather_settings.js (только админ)
$('#aiSettingsBtn').onclick = () => { closeDropdowns(); openAiSettings(); };                // ai_settings.js (только админ)
$('#encryptionBtn').onclick = () => { closeDropdowns(); openEncryptionKey(); };            // encryption_key.js (только админ)
$('#systemHealthBtn').onclick = () => { closeDropdowns(); openSystemHealth(true); };      // system_health.js (только админ)
$('#securityLogBtn').onclick = () => { closeDropdowns(); openSecurityLog(); };            // security_log.js (только админ)

// Бот VK работает из двух мест (сервер организации + иногда ноутбук для
// тестов) — VK Long Poll одинаково отдаёт события обоим, так что два
// живых бота одновременно дублируют ответы и расходятся по состоянию.
// Этот переключатель — единственный способ быстро "заглушить" один из
// них, не трогая сам процесс (см. app/api/routes_bot_settings.py).
function renderBotToggleStatus(enabled) {
  const el = $('#botToggleStatus');
  el.textContent = enabled ? 'включён' : 'выключен';
  el.classList.toggle('text-emerald-400', enabled);
  el.classList.toggle('text-rose-400', !enabled);
}
async function loadBotToggle() {
  try { renderBotToggleStatus((await Api.get('/api/bot-settings')).enabled); }
  catch { $('#botToggleStatus').textContent = '?'; }
}
$('#botToggleBtn').onclick = async () => {
  closeDropdowns();
  let current;
  try { current = (await Api.get('/api/bot-settings')).enabled; }
  catch (e) { alert('Не удалось получить статус бота: ' + e.message); return; }
  const next = !current;
  const msg = next
    ? 'Включить бота VK? Отвечать будет этот процесс — если параллельно запущен ещё один (например, на ноутбуке), выключите его.'
    : 'Выключить бота VK? Он перестанет отвечать монтёрам, пока его не включат обратно.';
  if (!confirm(msg)) return;
  try {
    renderBotToggleStatus((await Api.put('/api/bot-settings', { enabled: next })).enabled);
  } catch (e) { alert('Не удалось изменить статус бота: ' + e.message); }
};

$('#cal').onclick = (e) => {
  const b = e.target.closest('[data-day]');
  if (!b) return;
  if (MOVE_CREW) { pickMoveDay(b.dataset.day); return; }
  if (EXPORT_MODE) { toggleExportDay(b.dataset.day, e.shiftKey); return; }
  D = b.dataset.day;
  render();
};
$('#exportModeBtn').onclick = () => { if (EXPORT_MODE) leaveExportMode(); else enterExportMode({ scroll: true }); };
$('#exportBar').onclick = (e) => {
  const del = e.target.closest('[data-exp-del]');
  const quick = e.target.closest('[data-exp-quick]');
  const go = e.target.closest('[data-exp-go]');
  if (del) { EXPORT_DAYS.delete(del.dataset.expDel); renderExportBar(); render(); return; }
  if (e.target.closest('[data-exp-exit]')) { leaveExportMode(); return; }
  if (go && !go.disabled) { runExport(go.dataset.expGo); return; }
  if (!quick) return;
  const kind = quick.dataset.expQuick;
  if (kind === 'clear') { EXPORT_DAYS.clear(); EXPORT_LAST = null; }
  else if (kind === 'range') { exportRangeForm(); return; }
  else if (kind === 'week') {
    const base = new Date(D + 'T12:00:00');
    const monday = addDaysIso(D, -((base.getDay() + 6) % 7));
    for (let i = 0; i < 7; i += 1) EXPORT_DAYS.add(addDaysIso(monday, i));
  } else if (kind === 'month') {
    const y = V.getFullYear(), m = V.getMonth();
    for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d += 1) EXPORT_DAYS.add(dateStr(new Date(y, m, d)));
  } else if (kind === 'tasks') {
    const y = V.getFullYear(), m = V.getMonth();
    for (let d = 1; d <= new Date(y, m + 1, 0).getDate(); d += 1) { const iso = dateStr(new Date(y, m, d)); if (jobs(iso).length) EXPORT_DAYS.add(iso); }
  }
  renderExportBar();
  render();
};
$('#exportBar').addEventListener('change', (e) => { if (e.target.id === 'exportDesignSel') window.__exportDesignChoice = e.target.value; });
$('#teams').onchange = async (e) => {
  const id = +e.target.dataset.equip;
  if (!id) return;
  try { await Api.put(`/api/crews/${id}`, { equip: e.target.value }); const c = DAY_CREWS.find((x) => x.id === id); if (c) c.equip = e.target.value; }
  catch (err) { alert(err.message); }
};
// ---------- Перенос выбранных заданий в другую бригаду / на другой день ----------
// Галочками в карточке бригады отмечаются точки → «↪ Перенести выбранные…»: выбрать день (по умолчанию тот же) и бригаду этого дня (или новую). Выполненные не переносятся.
// Сервер: POST /api/crews/move-tasks (app/repositories/crew_move_repository.py::move_tasks).
async function moveTasksForm(crewId, preset) {
  const src = DAY_CREWS.find((c) => c.id === crewId);
  const tasks = crewVisibleJobs(crewId).filter((j) => !j.reported && SEL_TASKS.has(j.id));
  if (!tasks.length) return;
  const noPlan = tasks.filter((t) => isAuxTask(t));        // вспомогательные точки — метки карты, в план не идут
  const ids = tasks.map((t) => t.id);
  const crewsCache = {};
  const crewsOf = async (day) => {
    if (!crewsCache[day]) { try { crewsCache[day] = await Api.get('/api/crews?date=' + encodeURIComponent(day)); } catch { crewsCache[day] = []; } }
    return crewsCache[day];
  };
  const names = tasks.slice(0, 8).map((t) => esc(t.point || 'без названия')).join(', ') + (tasks.length > 8 ? ` и ещё ${tasks.length - 8}` : '');
  modal(`<h2 class="font-display text-lg font-bold mb-2">Перенос заданий</h2>
    <p class="text-sm mb-1">Выбрано точек: <b>${tasks.length}</b> — ${names}</p>
    <p class="text-xs text-slate-400 mb-3">Сейчас они в бригаде «${esc(src ? src.name : '')}» на ${esc(fmtDate(D))}.</p>
    <form id="mtForm" class="space-y-3">
      <div class="flex flex-wrap gap-x-4 gap-y-1 text-sm">
        <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="dest" value="crew" checked class="accent-indigo-500"> В бригаду (этого или другого дня)</label>
        <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="dest" value="plan" class="accent-indigo-500"> В план</label>
      </div>
      <div id="mtCrewPart" class="space-y-3">
      <label class="${labelCls}">День<input type="date" name="day" value="${D}" required class="${fieldCls}"></label>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" data-mt-day="${D}" class="${btnGhost} !py-1 !px-2.5 text-xs">Этот же день</button>
        <button type="button" data-mt-day="${addDaysIso(D, 1)}" class="${btnGhost} !py-1 !px-2.5 text-xs">Следующий день · ${esc(fmtDate(addDaysIso(D, 1)))}</button>
      </div>
      <label class="${labelCls}">В какую бригаду<select name="crew" class="${fieldCls}"></select></label>
      <div id="mtNew" class="hidden space-y-2 rounded-xl border border-slate-700/50 bg-slate-800/30 p-3">
        <label class="${labelCls}">Название новой бригады<input name="newname" maxlength="120" value="${esc(src ? src.name : '')}" class="${fieldCls}"></label>
        <label class="flex items-center gap-1.5 text-xs text-slate-300"><input type="checkbox" name="copy" class="rounded accent-indigo-500"> с тем же составом, транспортом и местом работ</label>
      </div>
      </div>
      <div id="mtPlanPart" class="hidden space-y-2">
        <label class="${labelCls}">Группа плана (необязательно)<input name="plangroup" list="mtGroups" maxlength="60" autocomplete="off" placeholder="например: Рейд на Ейск" class="${fieldCls}"></label>
        <datalist id="mtGroups"></datalist>
        <p class="text-xs text-slate-400">Задания уйдут из бригады, а комплексы встанут в «План»: тип работы, описание и приоритет сохранятся, дня и бригады не будет. Назначить их бригаде можно потом кнопкой «Из плана». Если комплекс уже в плане, второй раз он не добавится.</p>
        ${noPlan.length ? `<p class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Вспомогательные точки (${noPlan.map((t) => esc(t.point || 'без названия')).join(', ')}) — метки карты, а не комплексы: в план они не переносятся. Снимите с них отметку.</p>` : ''}
      </div>
      <div id="mtWarn" class="hidden rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"></div>
      <div id="mtError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button id="mtGo" class="${btnPrimary}">Перенести</button>
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
      </div>
    </form>`);
  const form = $('#mtForm');
  const f = form.elements;
  let warned = false;
  const refresh = async () => {
    const day = f.day.value;
    const crews = day ? (await crewsOf(day)).filter((c) => !c.trip_id && c.id !== crewId) : [];
    const keep = f.crew.value;
    f.crew.innerHTML = crews.map((c) => `<option value="${c.id}">${esc(c.name)}${c.members?.length ? ' — ' + esc(c.members.map((m) => m.full_name).join(', ')) : ''}</option>`).join('')
      + '<option value="new">＋ Новая бригада на этот день</option>';
    f.crew.value = [...f.crew.options].some((o) => o.value === keep) ? keep : (crews[0] ? String(crews[0].id) : 'new');
    if (f.crew.value === 'new' && !f.copy.dataset.touched) f.copy.checked = day !== D;      // на другой день состав обычно тот же; на этот же день те же люди уже заняты в прежней бригаде
    $('#mtNew').classList.toggle('hidden', f.crew.value !== 'new');
    // Точки, которые на выбранном дне уже есть (в любой бригаде) — предупреждение; перенос тогда требует отдельного «Всё равно»
    const target = f.crew.value === 'new' ? null : crews.find((c) => String(c.id) === f.crew.value);
    const targetDay = target ? target.date : day;
    const here = new Set(S.tasks.filter((t) => t.date === targetDay && !isAuxTask(t) && !ids.includes(t.id)).map((t) => String(t.point || '').trim().toLowerCase()));
    const dup = [...new Set(tasks.filter((t) => !isAuxTask(t) && here.has(String(t.point || '').trim().toLowerCase())).map((t) => t.point))];
    warned = dup.length > 0;
    $('#mtWarn').classList.toggle('hidden', !warned);
    $('#mtWarn').innerHTML = warned ? `<b>Обратите внимание:</b> эти точки на выбранном дне уже есть в заданиях: <b>${dup.map(esc).join(', ')}</b> — после переноса они будут дважды.` : '';
    $('#mtGo').textContent = warned ? 'Всё равно перенести' : 'Перенести';
  };
  f.day.onchange = refresh;
  f.crew.onchange = refresh;
  f.copy.onchange = () => { f.copy.dataset.touched = '1'; };
  form.querySelectorAll('[data-mt-day]').forEach((b) => { b.onclick = () => { f.day.value = b.dataset.mtDay; refresh(); }; });
  // «В бригаду» / «В план»: у плана нет ни дня, ни бригады — их поля прячутся (и перестают быть обязательными)
  const toPlan = () => f.dest.value === 'plan';
  const showDest = () => {
    const plan = toPlan();
    $('#mtCrewPart').classList.toggle('hidden', plan);
    $('#mtPlanPart').classList.toggle('hidden', !plan);
    f.day.required = !plan;
    $('#mtWarn').classList.toggle('hidden', plan || !warned);
    $('#mtGo').textContent = plan ? 'Перенести в план' : (warned ? 'Всё равно перенести' : 'Перенести');
  };
  form.querySelectorAll('input[name="dest"]').forEach((r) => { r.onchange = showDest; });
  Api.get('/api/point-plans/groups').then((names) => { $('#mtGroups').innerHTML = (names || []).map((n) => `<option value="${esc(n)}">`).join(''); }).catch(() => {});
  await refresh();
  if (preset === 'plan') { f.dest.value = 'plan'; showDest(); }
  form.onsubmit = async (e) => {
    e.preventDefault();
    const err = $('#mtError');
    err.classList.add('hidden');
    if (toPlan()) {
      $('#mtGo').disabled = true;
      try {
        const res = await Api.post('/api/crews/move-tasks', { task_ids: ids, to_plan: true, plan_group: f.plangroup.value.trim() });
        ids.forEach((id) => SEL_TASKS.delete(id));
        close();
        await load(true);
        render();
        showToast(`📋 В план перенесено точек: <b>${res.moved}</b>${res.already ? ` (уже были в плане: ${res.already})` : ''}${res.plan_group ? ` · группа «${esc(res.plan_group)}»` : ''}`, 6000);
      } catch (ex) {
        err.textContent = ex.message;
        err.classList.remove('hidden');
        $('#mtGo').disabled = false;
      }
      return;
    }
    const body = { task_ids: ids, allow_duplicates: warned };
    if (f.crew.value === 'new') { body.date = f.day.value; body.new_crew_name = f.newname.value.trim(); body.copy_members = f.copy.checked; } else body.crew_id = +f.crew.value;
    $('#mtGo').disabled = true;
    try {
      const res = await Api.post('/api/crews/move-tasks', body);
      ids.forEach((id) => SEL_TASKS.delete(id));
      const crews = await crewsOf(res.date).catch(() => []);
      const dest = (crews.find((c) => c.id === res.crew_id) || {}).name || (res.created_crew ? body.new_crew_name || 'новая бригада' : 'бригада');
      close();
      if (res.date !== D) { D = res.date; V = new Date(D + 'T12:00:00'); }      // перешли на день, куда перенесли
      EXPANDED_CREWS.add(res.crew_id);
      await load(true);
      render();
      showToast(`✅ Перенесено точек: <b>${res.moved}</b> → «${esc(dest)}» на ${esc(fmtDate(res.date))}`, 5000);
    } catch (ex) {
      err.textContent = ex.message;
      err.classList.remove('hidden');
      $('#mtGo').disabled = false;
    }
  };
}

// ---------- Перенос бригады на другой день ----------
// «📅 Перенести» у бригады → в календаре появляется жёлтая полоса «выберите день» → клик по нужному дню →
// окно подтверждения (сколько точек поедет, что уже выполнено и останется, дубли, занятые и отсутствующие люди) →
// перенос. Сервер: app/repositories/crew_move_repository.py.
function renderMoveBar() {
  const bar = $('#moveBar');
  if (!bar) return;
  bar.classList.toggle('hidden', !MOVE_CREW);
  $('#cal')?.classList.toggle('move-mode', !!MOVE_CREW);
  if (!MOVE_CREW) { bar.innerHTML = ''; return; }
  const next = addDaysIso(MOVE_CREW.date, 1);
  bar.innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2">
    <div class="text-sm"><b>Перенос бригады «${esc(MOVE_CREW.name)}»</b> <span class="text-slate-400">(${fmtDate(MOVE_CREW.date)}, точек: ${MOVE_CREW.tasks})</span><br>
      <span class="text-xs text-amber-300">Нажмите в календаре на день, куда перенести.</span></div>
    <div class="flex items-center gap-2">
      <button type="button" data-move-next class="${btnPrimary} !px-3 !py-1.5 text-xs">На следующий день · ${esc(fmtDate(next))}</button>
      <button type="button" data-move-cancel class="${btnGhost} !px-3 !py-1.5 text-xs">Отмена</button>
    </div>
  </div>`;
}

function startCrewMove(crewId) {
  const crew = DAY_CREWS.find((c) => c.id === crewId);
  if (!crew) return;
  MOVE_CREW = { id: crew.id, name: crew.name, date: crew.date, tasks: crewVisibleJobs(crew.id).filter((j) => !isAuxTask(j)).length };
  if (EXPORT_MODE) leaveExportMode();
  renderMoveBar();
  render();
  $('#moveBar')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function cancelCrewMove() {
  MOVE_CREW = null;
  renderMoveBar();
  render();
}

async function pickMoveDay(date) {
  const mv = MOVE_CREW;
  if (!mv) return;
  let info;
  try {
    info = await Api.get(`/api/crews/${mv.id}/move-check?date=${encodeURIComponent(date)}`);
  } catch (err) {
    alert('Не удалось проверить перенос: ' + err.message);
    return;
  }
  const li = (items) => items.map((x) => `<li>${x}</li>`).join('');
  const warns = [];
  if (info.duplicates.length) warns.push(`Эти точки на выбранном дне уже есть в заданиях: <b>${info.duplicates.map(esc).join(', ')}</b> — после переноса они будут дважды.`);
  info.busy_members.forEach((m) => warns.push(`${esc(m.full_name)} в этот день уже в бригаде «${esc(m.crew_name)}».`));
  info.absent_members.forEach((m) => warns.push(`${esc(m.full_name)} в этот день отсутствует${m.reason ? ` (${esc(m.reason)})` : ''}.`));
  const split = info.mode === 'split';
  modal(`<h2 class="font-display text-lg font-bold mb-3">Перенос бригады</h2>
    <p class="text-sm mb-2"><b>${esc(info.crew.name)}</b>: ${esc(fmtDayHeading(info.crew.date))} → <b>${esc(fmtDayHeading(date))}</b></p>
    ${info.blocked
      ? `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300">${esc(info.blocked)}</div>`
      : `<ul class="text-sm space-y-1 pl-5 mb-3" style="list-style:disc">
          <li>Точек поедет: <b>${info.movable}</b>${info.tasks_total === 0 ? ' (в бригаде пока нет точек — переедет только состав)' : ''}</li>
          ${split ? `<li>Уже выполнено: <b>${info.done}</b> — они останутся в этой бригаде на ${esc(fmtDate(info.crew.date))}, а на новом дне будет такая же бригада (с тем же составом) с оставшимися точками.</li>` : ''}
          <li>Состав, транспорт и место работ сохранятся.</li>
        </ul>
        ${warns.length ? `<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300 mb-3"><b>Обратите внимание:</b><ul class="pl-5 mt-1 space-y-0.5" style="list-style:disc">${li(warns)}</ul></div>` : ''}`}
    <div id="moveError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 mb-3"></div>
    <div class="flex items-center gap-2 pt-2">
      <button type="button" id="moveBack" class="${btnGhost}">${info.blocked ? 'Выбрать другой день' : 'Назад'}</button>
      ${info.blocked ? '' : `<button type="button" id="moveGo" class="${btnPrimary}">${warns.length ? 'Всё равно перенести' : 'Перенести'}</button>`}
      <button type="button" id="moveStop" class="${btnGhost} ml-auto">Отмена переноса</button>
    </div>`);
  // «Назад» — вернуться к выбору дня (полоса остаётся), «Отмена переноса» — выйти из режима.
  $('#moveBack').onclick = () => { editing = false; $('#modal').innerHTML = ''; };
  $('#moveStop').onclick = () => { editing = false; $('#modal').innerHTML = ''; cancelCrewMove(); };
  const go = $('#moveGo');
  if (go) go.onclick = async () => {
    go.disabled = true;
    try {
      const res = await Api.post(`/api/crews/${mv.id}/move`, { date, allow_duplicates: info.duplicates.length > 0 });
      MOVE_CREW = null;
      renderMoveBar();
      D = date; V = new Date(D + 'T12:00:00');
      EXPANDED_CREWS.add(res.crew_id);
      close();
      render();
    } catch (err) {
      $('#moveError').textContent = err.message;
      $('#moveError').classList.remove('hidden');
      go.disabled = false;
    }
  };
}

$('#moveBar').onclick = (e) => {
  if (e.target.closest('[data-move-cancel]')) { cancelCrewMove(); return; }
  if (e.target.closest('[data-move-next]') && MOVE_CREW) pickMoveDay(addDaysIso(MOVE_CREW.date, 1));
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && MOVE_CREW && !editing) cancelCrewMove(); });

// Удаляет бригаду. Если у неё есть задания — просит отдельное,
// подтверждение с указанием числа заданий, и при согласии сначала снимает
// их через обычный CAS save() (как «Удалить задание» в jobForm), только
// потом удаляет саму бригаду — DELETE /api/crews/{id} по-прежнему
// отказывает бригаде с непустыми заданиями, так что порядок важен.
async function deleteCrewCascade(crewId) {
  const crew = DAY_CREWS.find((c) => c.id === crewId);
  const crewTasks = crew ? jobs(crew.date, crewId) : [];
  if (crewTasks.length) {
    if (!confirm(`У бригады «${crew.name}» есть задания (${crewTasks.length}). Удалить бригаду ВМЕСТЕ со всеми её заданиями на этот день? Это нельзя отменить.`)) return;
    if (!await save((s) => { s.tasks = s.tasks.filter((x) => +x.team !== crewId); })) return;
  } else if (!confirm('Удалить бригаду?')) {
    return;
  }
  try { await Api.del(`/api/crews/${crewId}`); renderDayCrews(); }
  catch (err) { alert(err.message); }
}

// Командировка — бригада (не задание) помечена как «в разъезде» с этого
// дня по выбранную дату (см. app/core/trips.py). Задания на точки в эти
// дни создаются как обычно, по одной, кнопкой «+ Точка» на любой день из
// диапазона — они сами становятся видны бригаде на все дни командировки.
function crewTripForm(crewId) {
  const crew = DAY_CREWS.find((c) => c.id === crewId);
  if (!crew) return;
  modal(`<h2 class="font-display text-lg font-bold mb-4">Командировка — «${esc(crew.name)}»</h2>
    <form id="tripForm" class="space-y-4">
      <label class="${labelCls}">По какой день<input name="dateTo" type="date" required min="${esc(crew.date)}" class="${fieldCls}"></label>
      <p class="text-xs text-slate-500 -mt-2">Бригада будет помечена «в командировке» на все дни диапазона. Задания на точки добавляются как обычно, в любой из этих дней — и видны бригаде во все остальные дни командировки, пока не закрыты.</p>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Оформить</button>
      </div>
    </form>`);
  $('#tripForm').onsubmit = async (e) => {
    e.preventDefault();
    const dateTo = e.target.elements.dateTo.value;
    try {
      await Api.post(`/api/crews/${crewId}/trip`, { date_to: dateTo });
      close(); renderDayCrews();
    } catch (err) { alert(err.message); }
  };
}

async function cancelCrewTrip(crewId) {
  if (!confirm('Завершить командировку? Бригада перестанет считаться «в разъезде» — уже созданные задания сохранятся.')) return;
  try { await Api.del(`/api/crews/${crewId}/trip`); renderDayCrews(); }
  catch (err) { alert(err.message); }
}

$('#teams').onclick = (e) => {
  const a = e.target.closest('[data-add]'), j = e.target.closest('[data-job]'), d = e.target.closest('[data-del-crew]'), r = e.target.closest('[data-report]');
  const t = e.target.closest('[data-trip]'), ct = e.target.closest('[data-cancel-trip]');
  const toggle = e.target.closest('[data-toggle-crew]');
  const rename = e.target.closest('[data-rename-crew]'), copyBtn = e.target.closest('[data-copy-crew]');
  const moveBtn = e.target.closest('[data-move-crew]');
  const histBtn = e.target.closest('[data-point-history]'), cardBtn = e.target.closest('[data-point-card]');
  const selTask = e.target.closest('[data-sel-task]'), selAll = e.target.closest('[data-sel-all]'), moveTasks = e.target.closest('[data-move-tasks]'), selClear = e.target.closest('[data-sel-clear]');
  const movePlan = e.target.closest('[data-move-plan]');
  if (movePlan) { moveTasksForm(+movePlan.dataset.movePlan, 'plan'); return; }
  if (selTask) { if (selTask.checked) SEL_TASKS.add(selTask.dataset.selTask); else SEL_TASKS.delete(selTask.dataset.selTask); renderTeamsList(); return; }
  if (selAll) {
    crewVisibleJobs(+selAll.dataset.selAll).filter((x) => !x.reported).forEach((x) => { if (selAll.checked) SEL_TASKS.add(x.id); else SEL_TASKS.delete(x.id); });
    renderTeamsList();
    return;
  }
  if (selClear) { crewVisibleJobs(+selClear.dataset.selClear).forEach((x) => SEL_TASKS.delete(x.id)); renderTeamsList(); return; }
  if (moveTasks) { moveTasksForm(+moveTasks.dataset.moveTasks); return; }
  if (histBtn) { openVisitJournal(histBtn.dataset.pointHistory); return; }
  if (cardBtn) { pointForm(cardBtn.dataset.pointCard); return; }
  if (moveBtn) { startCrewMove(+moveBtn.dataset.moveCrew); return; }
  if (rename) { editCrewInfo(+rename.dataset.renameCrew); return; }
  if (copyBtn) { copyText(crewCopyText(DAY_CREWS.find((c) => c.id === +copyBtn.dataset.copyCrew)), copyBtn); return; }
  if (toggle) {
    const id = +toggle.dataset.toggleCrew;
    if (EXPANDED_CREWS.has(id)) EXPANDED_CREWS.delete(id); else EXPANDED_CREWS.add(id);
    renderTeamsList();
    return;
  }
  if (a) jobForm(null, +a.dataset.add);
  if (j) jobForm(j.dataset.job);
  if (r) visitReportForm(r.dataset.report);
  if (d) deleteCrewCascade(+d.dataset.delCrew);
  if (t) crewTripForm(+t.dataset.trip);
  if (ct) cancelCrewTrip(+ct.dataset.cancelTrip);
};
$('#points').onclick = (e) => {
  const a = e.target.closest('[data-point]'), b = e.target.closest('[data-delete]');
  const hist = e.target.closest('[data-point-history]'), rep = e.target.closest('[data-report]');
  if (hist) { openVisitJournal(hist.dataset.pointHistory); return; }
  if (rep) { visitReportForm(rep.dataset.report); return; }
  const pingBtn = e.target.closest('[data-ping]'), portBtn = e.target.closest('[data-checkport]'), openBtn = e.target.closest('[data-openweb]');
  if (a) pointForm(a.dataset.point);
  if (b && confirm('Удалить точку? Задания сохранятся.')) {
    Api.del(`/api/points/${encodeURIComponent(b.dataset.delete)}`).then(loadPoints).catch((err) => alert(err.message));
  }
  if (pingBtn) runNetCheck(pingBtn.dataset.ping, 'ping');
  if (portBtn) runNetCheck(portBtn.dataset.checkport, 'port');
  if (openBtn) openPointWebInterface(point(openBtn.dataset.openweb));
};
$('#search').oninput = renderPoints;
$('#pointsCrewFilter').onchange = renderPoints;
$('#addjob').onclick = () => jobForm();
$('#copyAllCrewsBtn').onclick = (e) => copyText(allCrewsCopyText(), e.currentTarget);
$('#robotMapsAllBtn').onclick = () => robotMapsModal(DAY_CREWS.filter((c) => crewVisibleJobs(c.id).length));
$('#yandexRobotBtn').onclick = () => openYandexAccount(); // yandex_robot.js грузится после app.js
$('#yandexFormsBtn').onclick = () => openFormsAccount(); // forms_account.js — тоже после app.js
$('#addpoint').onclick = () => pointForm();
$('#prev').onclick = () => { V = new Date(V.getFullYear(), V.getMonth() - 1, 1); render(); };
$('#next').onclick = () => { V = new Date(V.getFullYear(), V.getMonth() + 1, 1); render(); };
$('#today').onclick = () => { D = dateStr(new Date()); V = new Date(D + 'T12:00:00'); render(); };

$('#mapBtn').onclick = mapMenu;
$('#kmlFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) previewKml(f); };

$('#planPrintBtn').onclick = () => {
  closeDropdowns();
  // Весь текст бланка (в т.ч. "место работ") теперь редактируется прямо
  // на самой странице плана-задания перед печатью/скачиванием.
  window.open('/plan-print/' + D, '_blank');
};
$('#docsPointsBtn').onclick = () => { closeDropdowns(); docsPointsPanel(); };
$('#docsSimBtn').onclick = () => { closeDropdowns(); docsSimPanel(); };
$('#docsReportsBtn').onclick = () => { closeDropdowns(); docsReportsPanel(); };
$('#excelFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importExcelFile(f); };
$('#simImportFile').onchange = (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) importSimFile(f); };

$('#backup').onclick = () => (window.location.href = '/api/backup');
$('#restore').onclick = () => $('#file').click();
// Полное восстановление — сервер меняет весь файл базы целиком (см.
// app/api/routes_backup.py) прямо в работающем приложении, без перезапуска:
// загружаем файл, ждём ответ с итогом и обновляем страницу. Если файл от другой
// версии не подошёл, сервер сам возвращает прежнюю базу и пишет причину.
$('#file').onchange = async (e) => {
  const f = e.target.files[0]; e.target.value = ''; if (!f) return;
  if (!confirm(`Полностью заменить базу данных файлом «${f.name}»? Все текущие данные (точки, задания, персонал, склад, история) будут заменены содержимым файла. Текущая база перед этим сохранится в резервную копию на сервере.`)) return;
  modal(`<h2 class="font-display text-lg font-bold mb-2">Восстановление базы</h2>
    <p class="text-sm text-slate-400">«${esc(f.name)}» — обычно это занимает несколько секунд. Не закрывайте страницу.</p>
    <p id="restoreStatus" class="text-sm mt-3">Загружаю файл на сервер…</p>
    <div class="mt-2" style="height:8px;border-radius:9999px;overflow:hidden;background:rgba(100,116,139,.35)"><div id="restoreBar" style="height:100%;width:0%;background:#10b981;transition:width .2s"></div></div>
    <p id="restoreHint" class="hidden text-xs text-amber-300 mt-3"></p>`);
  // Что именно «ждём» — видно по строке состояния: идёт ли загрузка файла (процент)
  // или файл уже на сервере и тот его обрабатывает (секунды). Если ответа нет долго —
  // подсказка, что делать, вместо молчаливого «ожидайте».
  const status = (text) => { const el = $('#restoreStatus'); if (el) el.textContent = text; };
  const mb = (n) => (n / 1048576).toFixed(1);
  const fmtSec = (s) => (s < 90 ? `${Math.max(1, Math.round(s))} с` : `${Math.round(s / 60)} мин`);
  // База хорошо сжимается (в 4–5 раз), а канал до сервера бывает медленным, поэтому
  // файл уходит в виде .gz — сервер его сам распаковывает (см. routes_backup.py).
  let upload = f;
  let uploadName = f.name;
  let packedNote = '';
  if (typeof CompressionStream === 'function' && f.size > 65536) {
    status('Сжимаю файл перед отправкой…');
    try {
      const packed = await new Response(f.stream().pipeThrough(new CompressionStream('gzip'))).blob();
      if (packed.size < f.size) {
        upload = packed;
        uploadName = f.name + '.gz';
        packedNote = `сжато с ${mb(f.size)} до ${mb(packed.size)} МБ; `;
      }
    } catch { /* без сжатия — отправим как есть */ }
  }
  const fd = new FormData();
  fd.append('file', upload, uploadName);
  let sentAt = null;
  let startedAt = null;
  const timer = setInterval(() => {
    if (sentAt === null) return;
    const sec = Math.round((Date.now() - sentAt) / 1000);
    status(`Файл на сервере, идёт проверка и подмена базы… ${sec} с`);
    if (sec >= 45) {
      const hint = $('#restoreHint');
      if (hint) {
        hint.classList.remove('hidden');
        hint.textContent = 'Ответа нет дольше обычного. Не нажимайте «Восстановить» повторно — подождите ещё немного; если окно не пропадёт, обновите страницу и проверьте данные. Ход восстановления виден в журнале сервера (строки «Restore:»).';
      }
    }
  }, 1000);
  let res;
  try {
    res = await Api.uploadWithProgress('/api/backup/restore', fd, {
      onProgress: (loaded, total) => {
        const pct = Math.round((loaded / total) * 100);
        if (startedAt === null) startedAt = Date.now();
        const elapsed = (Date.now() - startedAt) / 1000;
        const rate = elapsed > 1 ? loaded / elapsed : 0; // байт/с
        const eta = rate > 0 ? ` · осталось ~${fmtSec((total - loaded) / rate)}` : '';
        status(`Загружаю файл на сервер… ${pct}% (${packedNote}${mb(loaded)} из ${mb(total)} МБ${rate ? ', ' + Math.round(rate / 1024) + ' КБ/с' : ''}${eta})`);
        const bar = $('#restoreBar'); if (bar) bar.style.width = pct + '%';
      },
      onSent: () => { sentAt = Date.now(); const bar = $('#restoreBar'); if (bar) bar.style.width = '100%'; status('Файл на сервере, идёт проверка и подмена базы…'); },
    });
  } catch (err) {
    clearInterval(timer);
    close();
    alert('Не удалось восстановить: ' + err.message);
    return;
  }
  clearInterval(timer);
  close();
  const s = res.summary || {};
  const lines = [`База восстановлена: комплексов — ${s.points ?? '?'}, заданий — ${s.tasks ?? '?'}, пользователей — ${s.users ?? '?'}.`];
  if (res.relogin) lines.push('', 'Учётные записи теперь из восстановленной базы — войдите заново (логин и пароль с того сервера, откуда взят файл).');
  if (res.encryption_warning) lines.push('', res.encryption_warning);
  alertNow(lines.join('\n'));
  window.location.href = res.relogin ? '/login' : '/';
};

$('#logoutBtn').onclick = async () => { await Api.post('/api/auth/logout', {}); window.location.href = '/login'; };

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
$('#changePwBtn').onclick = () => { closeDropdowns(); changePasswordForm({ forced: false }); };

// ---------- boot ----------
async function boot() {
  try {
    CURRENT_USER = await Api.get('/api/auth/me');
  } catch {
    return; // Api.get already redirects to /login on 401
  }
  // Нет права на календарь — на первую страницу, где право есть (сервер делает то же самое, это запасной путь)
  if (!can('calendar.view')) { window.location.href = (firstPageFor('/') || { path: '/no-access' }).path; return; }
  initUserUi();                  // подпись в шапке; кнопки и разделы скрываются по data-perm (static/js/ui.js)
  if (can('admin.system')) {
    // system_health.js подключён после app.js: при быстром ответе сервера boot доходит сюда раньше, чем он выполнится — ждём, пока функция появится
    const mountHealth = (left = 40) => { if (typeof mountSystemHealth === 'function') mountSystemHealth(); else if (left > 0) setTimeout(() => mountHealth(left - 1), 250); };
    mountHealth();
  }
  if (can('admin.keys')) {
    // Ключ шифрования не подходит к базе (например, восстановлена копия с другого сервера) или что-то осталось открытым текстом — заметно сразу
    Api.get('/api/encryption').then((st) => {
      if (st.ok && !st.failures) return;
      $('#encryptionBtn').textContent = '⚠ Ключ шифрования: есть проблема…';
      $('#encryptionBtn').classList.add('text-rose-300');
      $('#settingsMenuBtn').textContent = 'Настройки ⚠ ▾';
    }).catch(() => { /* не критично */ });
  }
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  // Ссылка вида /?date=2026-10-15 (например, из «Уведомления → Ошибки данных») открывает календарь сразу на этом дне.
  const linkedDay = new URLSearchParams(window.location.search).get('date');
  if (/^\d{4}-\d{2}-\d{2}$/.test(linkedDay || '') && !Number.isNaN(new Date(linkedDay + 'T12:00:00').getTime())) {
    D = linkedDay;
    V = new Date(D + 'T12:00:00');
  }
  await loadPointStatuses();
  await loadWorkTypes();
  await load(true);
  await loadPoints();
  await loadBotToggle();
  visiblePoll(load, 5000);
  if (new URLSearchParams(window.location.search).get('settings') === 'plan-template' && can('reports.edit')) {
    const openSettings = (left = 40) => {
      if (typeof openPlanTemplateSettings === 'function') openPlanTemplateSettings();
      else if (left > 0) setTimeout(() => openSettings(left - 1), 250);
    };
    openSettings();
  }
}
boot();
