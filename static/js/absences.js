// Страница «Отсутствия»: кто сейчас отсутствует, у кого ближайшее отсутствие, календарь месяца по дням,
// список людей (сверху — те, у кого отсутствие идёт или скоро начнётся) и поиск по фамилии.
// Данные — /api/absences/*, те же отсутствия, что в календаре («Персонал → Отсутствия»).
let CURRENT_USER = null;
let PEOPLE = [];            // {id, full_name, role_type, active}
let ABS = [];               // {id, person_id, start_date, end_date, reason, created_by}
let VIEW = null;            // первое число показываемого месяца
let SEL_DAY = null;         // выбранный в календаре день (ISO)
let SOON_DAYS = 30;         // окно блока «Сейчас и скоро»
let STATE_FILTER = 'all';   // all | now | soon | none — отбор в списке людей
let LOADED = false;

const ROLE_LABELS = { fitter: 'Монтёр', driver: 'Водитель', operator: 'Оператор', warehouse: 'Склад' };
const REASONS = ['Отпуск', 'Больничный', 'Отгул', 'Командировка', 'Учёба'];
const MONTHS_RU = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

const canEdit = () => can('absences.edit');

// ---------- даты (локальные, по часам браузера) ----------
const pad2 = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseIso = (iso) => new Date(iso + 'T12:00:00');
const todayIso = () => isoOf(new Date());
const addDays = (iso, n) => { const d = parseIso(iso); d.setDate(d.getDate() + n); return isoOf(d); };
const diffDays = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000);   // b − a в днях
const plural = (n, one, few, many) => {
  const m = Math.abs(n) % 100, d = m % 10;
  if (m > 10 && m < 20) return many;
  if (d > 1 && d < 5) return few;
  return d === 1 ? one : many;
};
const daysWord = (n) => `${n} ${plural(n, 'день', 'дня', 'дней')}`;
const norm = (s) => String(s || '').toLowerCase().replace(/ё/g, 'е');
const spanDays = (a) => diffDays(a.start_date, a.end_date) + 1;
const surnameOf = (full) => String(full || '').trim().split(/\s+/)[0] || '';

// ---------- расчёт: у кого сейчас / скоро ----------
function groupByPerson() {
  const map = new Map();
  for (const a of ABS) {
    if (!map.has(a.person_id)) map.set(a.person_id, []);
    map.get(a.person_id).push(a);
  }
  for (const list of map.values()) list.sort((x, y) => (x.start_date < y.start_date ? -1 : x.start_date > y.start_date ? 1 : x.id - y.id));
  return map;
}

// Подряд идущие периоды (конец одного = начало следующего −1 день) считаются одним отсутствием:
// «отпуск до 10-го, потом больничный» — человек всё равно вернётся только после 11-го.
function personStatus(list, today) {
  const runs = [];
  for (const a of list) {
    if (a.end_date < today) continue;
    const last = runs[runs.length - 1];
    if (last && a.start_date <= addDays(last.end, 1)) {
      if (a.end_date > last.end) last.end = a.end_date;
      last.items.push(a);
    } else {
      runs.push({ start: a.start_date, end: a.end_date, items: [a] });
    }
  }
  for (const r of runs) r.reason = [...new Set(r.items.map((i) => i.reason).filter(Boolean))].join(', ');
  const now = runs.find((r) => r.start <= today);
  if (now) return { kind: 'now', run: now, runs };
  if (runs.length) return { kind: 'soon', run: runs[0], inDays: diffDays(today, runs[0].start), runs };
  return { kind: 'none', runs };
}

function visiblePeople() {
  const tokens = norm($('#absSearch').value).split(/\s+/).filter(Boolean);
  const role = $('#absRole').value;
  const inactive = $('#absInactive').checked;
  return PEOPLE.filter((p) => (inactive || p.active) && (role === 'all' || p.role_type === role)
    && tokens.every((t) => norm(p.full_name).includes(t)));
}

function buildInfo() {
  const today = todayIso();
  const byPerson = groupByPerson();
  const first = norm($('#absSearch').value).trim().split(/\s+/)[0] || '';
  return visiblePeople().map((p) => ({
    p, list: byPerson.get(p.id) || [], st: personStatus(byPerson.get(p.id) || [], today),
    // при поиске выше те, у кого фамилия НАЧИНАЕТСЯ с введённого
    starts: first && norm(p.full_name).startsWith(first) ? 0 : 1,
  }));
}

const roleBadge = (role) => `<span class="rounded-full bg-slate-700/60 text-slate-300 text-[11px] font-medium px-2 py-0.5">${esc(ROLE_LABELS[role] || role)}</span>`;
const byName = (a, b) => a.starts - b.starts || a.p.full_name.localeCompare(b.p.full_name, 'ru');

// ---------- «Сейчас и скоро» ----------
function accentOf(x) {
  if (x.st.kind === 'now') return '#f43f5e';
  return x.st.inDays <= 3 ? '#f59e0b' : '#38bdf8';
}

function statusLine(x, today) {
  const run = x.st.run;
  if (x.st.kind === 'now') {
    const left = diffDays(today, run.end);
    return `<b class="text-rose-300">Отсутствует сейчас</b> · по ${esc(fmtDate(run.end))}${left === 0 ? ' (сегодня последний день)' : ` (ещё ${esc(daysWord(left))})`}`;
  }
  const label = x.st.inDays === 1 ? 'Завтра' : `Через ${daysWord(x.st.inDays)}`;
  const days = diffDays(run.start, run.end) + 1;
  return `<b class="${x.st.inDays <= 3 ? 'text-amber-300' : 'text-sky-300'}">${esc(label)}</b> · ${esc(fmtPeriod(run.start, run.end))} (${esc(daysWord(days))})`;
}

function renderSoon(info) {
  const today = todayIso();
  const now = info.filter((x) => x.st.kind === 'now').sort((a, b) => (a.st.run.end < b.st.run.end ? -1 : a.st.run.end > b.st.run.end ? 1 : byName(a, b)));
  const soon = info.filter((x) => x.st.kind === 'soon' && x.st.inDays <= SOON_DAYS)
    .sort((a, b) => a.st.inDays - b.st.inDays || byName(a, b));
  const card = (x) => `<div class="abs-card" data-person="${x.p.id}" style="border-left-color:${accentOf(x)}" title="Открыть все отсутствия: ${esc(x.p.full_name)}">
      <div class="flex items-center justify-between gap-2"><b class="text-sm">${esc(x.p.full_name)}</b>${roleBadge(x.p.role_type)}</div>
      <div class="text-xs mt-1">${statusLine(x, today)}</div>
      ${x.st.run.reason ? `<div class="text-xs text-slate-400 mt-0.5">${esc(x.st.run.reason)}</div>` : ''}
    </div>`;
  const windowSel = `<select id="soonDays" class="rounded-lg px-2 py-1 text-xs">${[7, 14, 30, 60, 90].map((n) => `<option value="${n}" ${n === SOON_DAYS ? 'selected' : ''}>на ${n} дней вперёд</option>`).join('')}</select>`;
  $('#soonBlock').innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-display text-lg font-bold">Сейчас и скоро <span class="text-sm font-normal text-slate-400">· отсутствуют сейчас: ${now.length} · скоро: ${soon.length}</span></h2>
      ${windowSel}
    </div>
    ${now.length || soon.length ? `<div class="abs-cards">${[...now, ...soon].map(card).join('')}</div>`
      : `<p class="text-sm text-slate-500">${PEOPLE.length ? `Сейчас никто не отсутствует, и в ближайшие ${SOON_DAYS} дней отсутствий не отмечено.` : 'Список людей пуст.'}</p>`}`;
  $('#soonDays').onchange = (e) => {
    SOON_DAYS = +e.target.value;
    try { localStorage.setItem('absSoonDays', String(SOON_DAYS)); } catch { /* не критично */ }
    renderAll();
  };
}

// ---------- календарь месяца ----------
function dayMapFor(info, gridStart, gridEnd) {
  const map = new Map();
  for (const x of info) {
    for (const a of x.list) {
      if (a.end_date < gridStart || a.start_date > gridEnd) continue;
      let d = a.start_date < gridStart ? gridStart : a.start_date;
      const stop = a.end_date > gridEnd ? gridEnd : a.end_date;
      while (d <= stop) {
        if (!map.has(d)) map.set(d, new Map());
        if (!map.get(d).has(x.p.id)) map.get(d).set(x.p.id, { p: x.p, a });
        d = addDays(d, 1);
      }
    }
  }
  return map;
}

function renderCalendar(info) {
  const today = todayIso();
  const y = VIEW.getFullYear(), m = VIEW.getMonth();
  $('#calTitle').textContent = `${MONTHS_RU[m]} ${y}`;
  const first = new Date(y, m, 1, 12);
  const offset = (first.getDay() + 6) % 7;                 // понедельник = 0
  const cells = Math.ceil((offset + new Date(y, m + 1, 0).getDate()) / 7) * 7;
  const gridStart = isoOf(new Date(y, m, 1 - offset, 12));
  const gridEnd = addDays(gridStart, cells - 1);
  const map = dayMapFor(info, gridStart, gridEnd);
  let html = '';
  for (let i = 0; i < cells; i++) {
    const iso = addDays(gridStart, i);
    const d = parseIso(iso);
    const here = [...(map.get(iso)?.values() || [])].sort((a, b) => a.p.full_name.localeCompare(b.p.full_name, 'ru'));
    const alpha = here.length ? Math.min(0.1 + 0.07 * here.length, 0.45) : 0;
    const weekend = d.getDay() === 0 || d.getDay() === 6;
    html += `<div class="abs-day${d.getMonth() !== m ? ' abs-other' : ''}${iso === today ? ' abs-today' : ''}${iso === SEL_DAY ? ' abs-sel' : ''}" data-day="${iso}"
        style="${alpha ? `background:rgba(244,63,94,${alpha.toFixed(2)})` : ''}" title="${here.length ? esc(here.map((h) => h.p.full_name).join(', ')) : ''}">
        <div class="abs-num${weekend ? ' abs-weekend' : ''}">${d.getDate()}</div>
        ${here.slice(0, 2).map((h) => `<div class="abs-name">${esc(surnameOf(h.p.full_name))}</div>`).join('')}
        ${here.length > 2 ? `<div class="abs-more">+ ещё ${here.length - 2}</div>` : ''}
        ${here.length ? `<div class="abs-cnt">👤 ${here.length}</div>` : ''}
      </div>`;
  }
  $('#absCal').innerHTML = html;
  $('#absCal').querySelectorAll('[data-day]').forEach((el) => {
    el.onclick = () => { SEL_DAY = el.dataset.day; renderAll(); };
  });
  return map;
}

function renderDay(info) {
  const today = todayIso();
  const day = SEL_DAY || today;
  const map = dayMapFor(info, day, day);
  const here = [...(map.get(day)?.values() || [])].sort((a, b) => a.p.full_name.localeCompare(b.p.full_name, 'ru'));
  $('#dayBlock').innerHTML = `<h2 class="font-display text-lg font-bold">${esc(fmtDayHeading(day))}${day === today ? ' <span class="text-xs font-normal text-indigo-300">· сегодня</span>' : ''}</h2>
    <p class="text-sm text-slate-400">${here.length ? `Отсутствуют: ${here.length}` : 'В этот день отсутствий не отмечено.'}</p>
    <div class="space-y-2">
      ${here.map((h) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 text-sm cursor-pointer" data-person="${h.p.id}">
        <div class="flex items-center justify-between gap-2"><b>${esc(h.p.full_name)}</b>${roleBadge(h.p.role_type)}</div>
        <div class="text-xs text-slate-400 mt-1">${esc(fmtPeriod(h.a.start_date, h.a.end_date))} · ${esc(daysWord(spanDays(h.a)))}${h.a.reason ? ` · ${esc(h.a.reason)}` : ''}</div>
      </div>`).join('')}
    </div>
    ${canEdit() ? `<button type="button" id="dayAdd" class="rounded-xl px-3 py-1.5 text-xs font-medium bg-indigo-500/20 hover:bg-indigo-500/30 text-indigo-200 border border-indigo-400/30">＋ Отметить отсутствие с этого дня</button>` : ''}`;
  const add = $('#dayAdd');
  if (add) add.onclick = () => openPicker(day);
}

// ---------- список людей ----------
function renderPeople(info) {
  const today = todayIso();
  const counts = { all: info.length, now: 0, soon: 0, none: 0 };
  info.forEach((x) => { counts[x.st.kind === 'soon' && x.st.inDays > SOON_DAYS ? 'none' : x.st.kind]++; });
  const pass = (x) => STATE_FILTER === 'all'
    || (STATE_FILTER === 'now' && x.st.kind === 'now')
    || (STATE_FILTER === 'soon' && x.st.kind === 'soon' && x.st.inDays <= SOON_DAYS)
    || (STATE_FILTER === 'none' && (x.st.kind === 'none' || (x.st.kind === 'soon' && x.st.inDays > SOON_DAYS)));
  const rank = (x) => (x.st.kind === 'now' ? 0 : x.st.kind === 'soon' ? 1 : 2);
  const rows = info.filter(pass).sort((a, b) => rank(a) - rank(b)
    || (a.st.kind === 'now' ? (a.st.run.end < b.st.run.end ? -1 : a.st.run.end > b.st.run.end ? 1 : 0) : 0)
    || (a.st.kind === 'soon' ? a.st.inDays - b.st.inDays : 0)
    || byName(a, b));
  const seg = (key, label) => `<button type="button" class="abs-seg${STATE_FILTER === key ? ' on' : ''}" data-state="${key}">${label} · ${counts[key]}</button>`;
  const rowHtml = (x) => {
    const upcoming = x.st.runs.slice(0, 4);
    return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3" style="border-left:4px solid ${x.st.kind === 'none' ? 'transparent' : accentOf(x)}">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <span class="flex items-center gap-2 min-w-0 flex-wrap">
          <b class="text-sm cursor-pointer" data-person="${x.p.id}">${esc(x.p.full_name)}</b>${roleBadge(x.p.role_type)}
          ${x.p.active ? '' : '<span class="text-[11px] text-slate-500">неактивен</span>'}
        </span>
        <span class="flex items-center gap-1.5 shrink-0">
          ${canEdit() ? `<button type="button" data-add-for="${x.p.id}" class="${btnPrimary} !py-1 !px-3 text-xs">＋ Отсутствие</button>` : ''}
          <button type="button" data-person="${x.p.id}" class="${btnGhost} !py-1 !px-3 text-xs">Все периоды</button>
        </span>
      </div>
      ${x.st.kind === 'none' ? '<div class="text-xs text-slate-500 mt-1">Отсутствий не отмечено</div>'
        : `<div class="text-xs mt-1">${statusLine(x, today)}${x.st.run.reason ? ` · <span class="text-slate-400">${esc(x.st.run.reason)}</span>` : ''}</div>
        <div>${upcoming.map((r) => `<span class="abs-chip">${esc(fmtPeriod(r.start, r.end))}${r.reason ? ` · ${esc(r.reason)}` : ''}</span>`).join('')}${x.st.runs.length > 4 ? `<span class="abs-chip">+ ещё ${x.st.runs.length - 4}</span>` : ''}</div>`}
    </div>`;
  };
  $('#peopleBlock').innerHTML = `<div class="flex flex-wrap items-center justify-between gap-2">
      <h2 class="font-display text-lg font-bold">Люди <span class="text-sm font-normal text-slate-400">· сначала у кого отсутствие идёт или ближайшее</span></h2>
      <span class="flex flex-wrap items-center gap-1.5">${seg('all', 'Все')}${seg('now', 'Отсутствуют сейчас')}${seg('soon', `Скоро (${SOON_DAYS} дн.)`)}${seg('none', 'Без отсутствий')}</span>
    </div>
    <div class="space-y-2">${rows.map(rowHtml).join('') || `<p class="text-sm text-slate-500">${PEOPLE.length ? 'Никого не найдено' : 'Список людей пуст — добавьте персонал в календаре (Настройки → Персонал).'}</p>`}</div>`;
  $('#peopleBlock').querySelectorAll('[data-state]').forEach((b) => { b.onclick = () => { STATE_FILTER = b.dataset.state; renderAll(); }; });
}

function renderAll() {
  if (!LOADED) return;
  const info = buildInfo();
  renderSoon(info);
  renderCalendar(info);
  renderDay(info);
  renderPeople(info);
}

// ---------- загрузка ----------
async function loadData() {
  const from = addDays(todayIso(), -400);   // год назад хватает для просмотра прошлых месяцев; вся история человека — в его окне
  const [people, absences] = await Promise.all([
    Api.get('/api/absences/people?include_inactive=true'),
    Api.get('/api/absences?date_from=' + from),
  ]);
  PEOPLE = people;
  ABS = absences;
  LOADED = true;
}

async function reload() {
  try { await loadData(); renderAll(); } catch (e) { /* связь пропала — оставляем то, что на экране */ }
}

function close() {
  editing = false;
  $('#modal').innerHTML = '';
  reload();
}

// ---------- окно человека: все его периоды + форма ----------
async function openPerson(personId, { start = null, notice = '', editId = null } = {}) {
  const person = PEOPLE.find((p) => p.id === personId);
  if (!person) return;
  let list;
  try { list = await Api.get(`/api/absences/person/${personId}`); }
  catch (e) { alert('Не удалось загрузить отсутствия: ' + e.message); return; }
  const today = todayIso();
  const current = list.filter((a) => a.end_date >= today).sort((a, b) => (a.start_date < b.start_date ? -1 : 1));
  const past = list.filter((a) => a.end_date < today);       // уже новые сверху
  const editing_ = editId ? list.find((a) => a.id === editId) : null;
  const periodHtml = (a) => {
    const live = a.start_date <= today && a.end_date >= today;
    return `<div class="rounded-xl border ${live ? 'border-rose-400/50' : 'border-slate-700/50'} bg-slate-800/30 p-3 flex items-center justify-between gap-2">
      <span class="text-sm">${live ? '<span class="text-rose-300 text-xs font-semibold mr-1">сейчас</span>' : ''}${esc(fmtPeriod(a.start_date, a.end_date))} <span class="text-slate-400 text-xs">· ${esc(daysWord(spanDays(a)))}</span>
        ${a.reason ? `<br><span class="text-slate-300 text-xs">${esc(a.reason)}</span>` : ''}${a.created_by ? `<br><span class="text-slate-500 text-[11px]">отметил: ${esc(a.created_by)}</span>` : ''}</span>
      ${canEdit() ? `<span class="flex items-center gap-1.5 shrink-0">
        <button type="button" data-edit-abs="${a.id}" class="${btnGhost} !py-1 !px-2 text-xs" title="Изменить даты или причину">✎</button>
        <button type="button" data-del-abs="${a.id}" class="${btnDanger} !py-1 !px-2 text-xs">Удалить</button></span>` : ''}
    </div>`;
  };
  const startVal = editing_ ? editing_.start_date : (start || today);
  const endVal = editing_ ? editing_.end_date : startVal;
  modal(`<h2 class="font-display text-lg font-bold mb-1">${esc(person.full_name)}</h2>
    <p class="text-xs text-slate-400 mb-3">${esc(ROLE_LABELS[person.role_type] || '')} · отсутствия</p>
    ${notice ? `<div class="mb-3 rounded-xl px-3 py-2 text-xs text-amber-300" style="border:1px solid rgba(251,191,36,.45); background:rgba(245,158,11,.10)">${notice}</div>` : ''}
    <div class="space-y-2 mb-3 overflow-auto pr-1" style="max-height:15rem">
      ${current.map(periodHtml).join('') || '<p class="text-sm text-slate-500">Текущих и будущих отсутствий нет</p>'}
    </div>
    ${past.length ? `<details class="mb-4"><summary class="text-xs text-slate-400 cursor-pointer select-none">Прошедшие отсутствия (${past.length})</summary>
      <div class="space-y-2 mt-2 max-h-48 overflow-auto pr-1">${past.map(periodHtml).join('')}</div></details>` : ''}
    ${canEdit() ? `<form id="absForm" class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 space-y-3">
      <b class="text-sm block">${editing_ ? 'Изменить отсутствие' : 'Отметить отсутствие'}</b>
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">С<input type="date" name="start_date" required value="${esc(startVal)}" class="${fieldCls}"></label>
        <label class="${labelCls}">По (включительно)<input type="date" name="end_date" required value="${esc(endVal)}" class="${fieldCls}"></label>
      </div>
      <div class="flex flex-wrap gap-1.5" id="reasonChips">${REASONS.map((r) => `<button type="button" class="abs-seg" data-reason="${esc(r)}">${esc(r)}</button>`).join('')}</div>
      <label class="${labelCls}">Причина<input name="reason" maxlength="200" value="${esc(editing_ ? editing_.reason : '')}" placeholder="отпуск, больничный…" class="${fieldCls}"></label>
      <div id="absError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2">
        <button class="${btnPrimary}">${editing_ ? 'Сохранить' : 'Добавить период'}</button>
        ${editing_ ? `<button type="button" id="absCancelEdit" class="${btnGhost}">Не менять</button>` : ''}
      </div>
    </form>` : ''}
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);

  const form = $('#absForm');
  if (form) {
    const f = form.elements;
    const syncChips = () => form.querySelectorAll('[data-reason]').forEach((b) => b.classList.toggle('on', b.dataset.reason === f.reason.value.trim()));
    form.querySelectorAll('[data-reason]').forEach((b) => { b.onclick = () => { f.reason.value = b.dataset.reason; syncChips(); }; });
    f.reason.oninput = syncChips;
    syncChips();
    // «По» не бывает раньше «С»: сдвинули начало вперёд — конец подтягивается.
    f.start_date.addEventListener('change', () => { if (f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value; });
    form.onsubmit = async (e) => {
      e.preventDefault();
      const body = { person_id: personId, start_date: f.start_date.value, end_date: f.end_date.value, reason: f.reason.value.trim() };
      try {
        const res = editing_ ? await Api.put(`/api/absences/${editing_.id}`, body) : await Api.post('/api/absences', body);
        await loadData();
        const parts = [];
        if (res.duplicate) parts.push('Такой период уже был отмечен — второй раз не добавлен.');
        if (res.conflicts?.length) {
          parts.push(`⚠ В эти дни ${esc(person.full_name)} уже стоит в бригадах: ${res.conflicts.slice(0, 8).map((c) => `${esc(fmtDate(c.date))} «${esc(c.crew)}»`).join(', ')}${res.conflicts.length > 8 ? ` и ещё ${res.conflicts.length - 8}` : ''}. Из бригад его не убрали — поправьте состав в календаре.`);
        }
        renderAll();
        await openPerson(personId, { notice: parts.join('<br>') });
      } catch (err) {
        $('#absError').textContent = err.message;
        $('#absError').classList.remove('hidden');
      }
    };
    const cancel = $('#absCancelEdit');
    if (cancel) cancel.onclick = () => openPerson(personId);
  }
  document.querySelectorAll('#modal [data-edit-abs]').forEach((b) => { b.onclick = () => openPerson(personId, { editId: +b.dataset.editAbs }); });
  document.querySelectorAll('#modal [data-del-abs]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Удалить этот период отсутствия?')) return;
      try { await Api.del(`/api/absences/${b.dataset.delAbs}`); await loadData(); renderAll(); await openPerson(personId); }
      catch (err) { alert(err.message); }
    };
  });
}

// ---------- «Отметить отсутствие»: сначала выбрать человека (поиск по фамилии) ----------
function openPicker(startDay = null) {
  modal(`<h2 class="font-display text-lg font-bold mb-3">Кому отметить отсутствие${startDay ? ` · с ${esc(fmtDate(startDay))}` : ''}</h2>
    <input id="pickQ" type="search" autocomplete="off" placeholder="Начните вводить фамилию…" class="${fieldCls} mb-3">
    <div id="pickList" class="space-y-1.5 max-h-72 overflow-auto pr-1"></div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
  const draw = () => {
    const tokens = norm($('#pickQ').value).split(/\s+/).filter(Boolean);
    const list = PEOPLE.filter((p) => p.active && tokens.every((t) => norm(p.full_name).includes(t)))
      .sort((a, b) => (norm(b.full_name).startsWith(tokens[0] || '\0') ? 1 : 0) - (norm(a.full_name).startsWith(tokens[0] || '\0') ? 1 : 0) || a.full_name.localeCompare(b.full_name, 'ru'));
    $('#pickList').innerHTML = list.slice(0, 60).map((p) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-3 py-2 text-sm cursor-pointer flex items-center justify-between gap-2" data-pick="${p.id}">
        <span>${esc(p.full_name)}</span>${roleBadge(p.role_type)}</div>`).join('')
      || '<p class="text-sm text-slate-500">Никого не найдено</p>';
    $('#pickList').querySelectorAll('[data-pick]').forEach((el) => { el.onclick = () => openPerson(+el.dataset.pick, { start: startDay }); });
  };
  $('#pickQ').oninput = draw;
  $('#pickQ').onkeydown = (e) => {
    if (e.key === 'Enter') { e.preventDefault(); const first = $('#pickList [data-pick]'); if (first) first.click(); }
  };
  draw();
  $('#pickQ').focus();
}

// ---------- шапка страницы: меню пользователя, пароль ----------
function changePasswordForm({ forced = false } = {}) {
  modal(`<h2 class="font-display text-lg font-bold mb-2">Смена пароля</h2>
    ${forced ? '<p class="text-sm text-amber-300 mb-4">Это временный пароль. Установите новый, прежде чем продолжить.</p>' : ''}
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
  const person = e.target.closest('[data-person]');
  if (person && !e.target.closest('#modal')) openPerson(+person.dataset.person);
  const add = e.target.closest('[data-add-for]');
  if (add && !e.target.closest('#modal')) openPerson(+add.dataset.addFor);
});
$('#changePwBtn').onclick = () => { $('#userMenu').classList.add('hidden'); changePasswordForm({ forced: false }); };
$('#logoutBtn').onclick = async () => { await Api.post('/api/auth/logout', {}); window.location.href = '/login'; };

$('#absSearch').oninput = renderAll;
$('#absSearch').onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
$('#absRole').onchange = renderAll;
$('#absInactive').onchange = renderAll;
$('#absAddBtn').onclick = () => openPicker(null);
$('#calPrev').onclick = () => { VIEW = new Date(VIEW.getFullYear(), VIEW.getMonth() - 1, 1, 12); renderAll(); };
$('#calNext').onclick = () => { VIEW = new Date(VIEW.getFullYear(), VIEW.getMonth() + 1, 1, 12); renderAll(); };
$('#calToday').onclick = () => { const t = new Date(); VIEW = new Date(t.getFullYear(), t.getMonth(), 1, 12); SEL_DAY = todayIso(); renderAll(); };

async function boot() {
  try {
    CURRENT_USER = await Api.get('/api/auth/me');
  } catch {
    return; // Api.get сам уводит на /login при 401
  }
  if (!can('absences.view')) { window.location.href = '/'; return; }
  initUserUi();                  // подпись, кнопки по правам (ссылка «Календарь» — по праву на календарь)
  if (canEdit()) $('#absAddBtn').classList.remove('hidden');
  try { SOON_DAYS = +localStorage.getItem('absSoonDays') || 30; } catch { SOON_DAYS = 30; }
  const t = new Date();
  VIEW = new Date(t.getFullYear(), t.getMonth(), 1, 12);
  SEL_DAY = todayIso();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  try { await loadData(); }
  catch (e) { $('#soonBlock').innerHTML = `<p class="text-sm text-rose-300">Не удалось загрузить: ${esc(e.message)}</p>`; return; }
  renderAll();
  // Чужие правки подхватываем сами — пока открыто окно (идёт редактирование), страницу не трогаем.
  setInterval(() => { if (!editing && document.visibilityState === 'visible') reload(); }, 30000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && !editing) reload(); });
}
boot();
