// /monitoring — кто из монтёров сейчас работает (бот), что требует ручной
// проверки, и фотоархив по дням. $, esc, modal, btn*, pointStatusBadge,
// loadPointStatuses приходят из ui.js.
let CURRENT_USER = null;

const pad2 = (n) => String(n).padStart(2, '0');
// День, когда отчёт реально отправлен (по часам браузера); у бригады в командировке задание стоит на день начала
// поездки, а отчёт могут сдать позже — показываем фактический день, а не дату задания.
const reportDay = (r) => (r.reported_at ? isoDate(new Date(r.reported_at)) : r.date);
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const _weekAgo = new Date(); _weekAgo.setDate(_weekAgo.getDate() - 6);
let summaryDateFrom = isoDate(_weekAgo);
let summaryDateTo = isoDate(new Date());
// «Итоги по комплексам»: по умолчанию — одним списком по порядку времени создания отчётов; по кнопке — по бригадам.
const _ls = {
  get(k, d) { try { return localStorage.getItem(k) || d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* не страшно */ } },
};
let summaryView = _ls.get('monSummaryView', 'time') === 'crew' ? 'crew' : 'time';
let summaryOrder = _ls.get('monSummaryOrder', 'asc') === 'desc' ? 'desc' : 'asc';
let summaryItems = [];

function elapsedLabel(startedAt) {
  const ms = Date.now() - new Date(startedAt).getTime();
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h ? `${h} ч ${m} мин` : `${m} мин`;
}

async function renderMonitoringPage() {
  $('#content').innerHTML = `
    <section class="mb-8">
      <h2 class="font-display text-lg font-bold mb-3">Сейчас в работе</h2>
      <div id="activeSessions" class="space-y-2"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    </section>

    <section class="mb-8 pt-4 border-t border-slate-700/50">
      <h2 class="font-display text-lg font-bold mb-3">Требует проверки</h2>
      <p class="text-xs text-slate-500 mb-3">Монтёр отчитался «Работает» после ремонта/установки, но автопроверка пинга/порта пока не согласна.</p>
      <div id="needsCheck" class="space-y-2"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    </section>

    <section class="mb-8 pt-4 border-t border-slate-700/50">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 class="font-display text-lg font-bold">Фото по дням</h2>
          <p class="text-xs text-slate-500">Все фото монтёров, разложенные по дням (новые сверху): просмотр, архив за день, удаление.</p>
        </div>
        <button id="photosOpenBtn" class="${btnPrimary} !px-4 !py-1.5 text-xs">📷 Открыть фото по дням</button>
      </div>
    </section>

    <section class="mb-8 pt-4 border-t border-slate-700/50">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 class="font-display text-lg font-bold">Итоги по комплексам</h2>
        <div class="flex items-center gap-2">
          <input type="date" id="summaryDateFrom" value="${summaryDateFrom}" class="rounded-lg px-2 py-1.5 text-xs">
          <span class="text-xs text-slate-500">—</span>
          <input type="date" id="summaryDateTo" value="${summaryDateTo}" class="rounded-lg px-2 py-1.5 text-xs">
        </div>
      </div>
      <div class="flex flex-wrap items-center gap-2 mb-3">
        <span class="text-xs text-slate-500">Список:</span>
        <span id="summaryViewSeg" class="inline-flex gap-1"></span>
        <button type="button" id="summaryOrderBtn" class="${btnGhost} !px-3 !py-1 text-xs"></button>
      </div>
      <p id="summaryHint" class="text-xs text-slate-500 mb-3"></p>
      <div id="pointSummaries"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    </section>

    <section class="pt-4 border-t border-slate-700/50">
      <h2 class="font-display text-lg font-bold mb-3">История проверок</h2>
      <div id="verificationHistory" class="space-y-2"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    </section>`;

  $('#photosOpenBtn').onclick = openPhotosModal;
  $('#summaryViewSeg').onclick = (e) => {
    const b = e.target.closest('[data-sview]');
    if (!b) return;
    summaryView = b.dataset.sview === 'crew' ? 'crew' : 'time';
    _ls.set('monSummaryView', summaryView);
    renderPointSummaries();
  };
  $('#summaryOrderBtn').onclick = () => {
    summaryOrder = summaryOrder === 'asc' ? 'desc' : 'asc';
    _ls.set('monSummaryOrder', summaryOrder);
    renderPointSummaries();
  };
  $('#pointSummaries').onclick = onSummaryClick;
  $('#summaryDateFrom').onchange = () => {
    summaryDateFrom = $('#summaryDateFrom').value || summaryDateFrom;
    loadPointSummaries();
  };
  $('#summaryDateTo').onchange = () => {
    summaryDateTo = $('#summaryDateTo').value || summaryDateTo;
    loadPointSummaries();
  };

  await Promise.all([loadActiveSessions(), loadNeedsCheck(), loadPointSummaries(), loadVerificationHistory()]);
}

const RESULT_STATUS_COLOR = {
  'Работает': 'text-emerald-400', 'Установлен': 'text-emerald-400',
  'Не работает': 'text-rose-400', 'Демонтирован': 'text-slate-400',
};

const SIM_STATE_WORD = { working: 'рабочая', defective: 'нерабочая' };
const POWER_ICON = { 'СЭС': '☀️', 'Электросеть': '🔌' };

// Время отчёта по часам браузера: «14-10 12:05» (год не нужен — период выбран выше).
function reportTimeLabel(r) {
  const d = r.reported_at ? new Date(r.reported_at) : null;
  if (!d || Number.isNaN(d.getTime())) return fmtDate(r.date);
  return `${pad2(d.getDate())}-${pad2(d.getMonth() + 1)} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

// Карточка отчёта. showCrew — в общем списке по времени бригаду показываем в строке под названием, а при группировке
// по бригадам она уже в заголовке группы.
function summaryCardHtml(r, showCrew) {
  const wrap = 'white-space:pre-wrap; overflow-wrap:anywhere';
  const power = r.power_source
    ? `<span title="Тип питания комплекса">${POWER_ICON[r.power_source] || '⚡'} ${esc(r.power_source)}</span>`
    : '<span class="text-slate-600" title="Тип питания комплекса не указан">⚡ питание не указано</span>';
  const meta = [power, showCrew ? `👥 ${esc(r.crew_label)}` : '', r.created_by ? `👤 ${esc(r.created_by)}` : '',
    r.source === 'forms' ? '<span class="rounded px-1.5 py-0.5 bg-amber-500/15 text-amber-300" title="Отчёт загружен из таблицы Яндекс Форм">из Яндекс Формы</span>' : '']
    .filter(Boolean).join(' <span class="text-slate-600">·</span> ');
  const simLine = (r.sim_removed || r.sim_installed)
    ? `<div class="mt-1 text-[11px] text-slate-400">💳 SIM: ${r.sim_removed ? `снята ${esc(r.sim_removed)}${r.sim_removed_state ? ` (${SIM_STATE_WORD[r.sim_removed_state] || ''})` : ''}` : ''}${r.sim_removed && r.sim_installed ? ' → ' : ''}${r.sim_installed ? `установлена ${esc(r.sim_installed)}` : ''}</div>` : '';
  const eqLine = (r.equipment_removed || r.equipment_installed)
    ? `<div class="mt-1 text-[11px] text-slate-400" style="${wrap}">🔧 ${r.equipment_removed ? `Снято: ${esc(r.equipment_removed)}` : ''}${r.equipment_removed && r.equipment_installed ? ' · ' : ''}${r.equipment_installed ? `Установлено: ${esc(r.equipment_installed)}` : ''}</div>` : '';
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-2.5 flex flex-wrap items-start justify-between gap-2" data-key="${esc(r.task_id)}">
      <div class="min-w-0" style="flex:1 1 320px">
        <div class="text-sm font-semibold">${esc(r.point_id)} · ${esc(r.point_address || '')} <span class="text-slate-500 font-normal" title="Время отправки отчёта${r.date && r.date !== reportDay(r) ? ` (задание стояло на ${esc(fmtDate(r.date))})` : ''}">· ${esc(reportTimeLabel(r))} · ${esc(r.visit_type)}</span></div>
        <div class="mt-0.5 text-[11px] text-slate-400">${meta}</div>
        ${r.comment ? `<div class="mt-1 text-xs text-slate-300" style="${wrap}"><span class="text-slate-500">Итог работ:</span> ${esc(r.comment)}</div>` : ''}
        ${eqLine}${simLine}
        ${r.result_status === 'Не работает' ? `<div class="mt-1.5 rounded-lg border border-rose-500/30 bg-rose-500/10 px-2 py-1 text-[11px] space-y-0.5">
          <div class="font-semibold text-rose-300">⚠ Не заработал — нужен повторный выезд</div>
          <div style="${wrap}"><span class="text-slate-400">Неисправно:</span> ${r.fault ? esc(r.fault) : '<span class="text-slate-500">не указано</span>'}</div>
          <div style="${wrap}"><span class="text-slate-400">Нужно для исправления:</span> ${r.needs ? esc(r.needs) : '<span class="text-slate-500">не указано</span>'}</div></div>` : ''}
      </div>
      <span class="flex items-center gap-2 shrink-0">
        <span class="text-xs font-medium ${RESULT_STATUS_COLOR[r.result_status] || 'text-slate-400'}" style="max-width:220px; text-align:right; overflow-wrap:anywhere">${esc(r.outcome || r.result_status || '—')}</span>
        ${can('reports.edit') ? `<button data-edit-report="${esc(r.task_id)}" class="${btnGhost} !px-2.5 !py-1 text-xs" title="Править отчёт: исполнитель, тип, статус, итог работ, оборудование, SIM, питание, время">✎ Править</button>` : ''}
        ${can('monitoring.manage') ? `<button data-del-summary="${esc(r.task_id)}" class="${btnDanger} !px-2 !py-1 text-xs" title="Удалить отчёт">×</button>` : ''}
      </span>
    </div>`;
}

function renderSummaryToolbar() {
  const seg = $('#summaryViewSeg');
  if (!seg) return;
  const on = 'border-indigo-400 bg-indigo-500/25 font-semibold';
  const off = 'border-slate-700 bg-slate-800/60 hover:bg-slate-700/60';
  seg.innerHTML = [['time', '🕒 По времени'], ['crew', '👥 По бригадам']].map(([v, l]) =>
    `<button type="button" data-sview="${v}" class="rounded-lg px-3 py-1 text-xs border transition-colors ${summaryView === v ? on : off}">${l}</button>`).join('');
  $('#summaryOrderBtn').textContent = summaryOrder === 'asc' ? '↓ Сначала старые' : '↑ Сначала новые';
  $('#summaryOrderBtn').title = 'Порядок отчётов по времени их создания (внутри бригады — тоже)';
  $('#summaryHint').textContent = summaryView === 'crew'
    ? 'Отчёты монтёров за период, по бригадам (внутри бригады — по времени создания).'
    : 'Отчёты монтёров за период — одним списком, по порядку времени создания. «По бригадам» — группировка.';
}

function renderPointSummaries() {
  renderSummaryToolbar();
  const box = $('#pointSummaries');
  if (!box) return;
  if (!summaryItems.length) {
    setHtmlIfChanged(box, '<p class="text-sm text-slate-500">За этот период отчётов нет.</p>');
    return;
  }
  const byTime = (a, b) => (a.reported_at || '').localeCompare(b.reported_at || '') || String(a.task_id).localeCompare(String(b.task_id));
  const sorted = [...summaryItems].sort(summaryOrder === 'asc' ? byTime : (a, b) => byTime(b, a));
  let html;
  if (summaryView === 'time') {
    html = `<div class="space-y-1.5">${sorted.map((r) => summaryCardHtml(r, true)).join('')}</div>`;
  } else {
    const byCrew = new Map();
    for (const it of sorted) {
      if (!byCrew.has(it.crew_label)) byCrew.set(it.crew_label, { id: it.crew_id, rows: [] });
      byCrew.get(it.crew_label).rows.push(it);
    }
    const groups = [...byCrew.entries()].sort((a, b) => (a[1].id == null) - (b[1].id == null) || (a[1].id || 0) - (b[1].id || 0));
    html = groups.map(([crewLabel, g]) => `
      <div class="mb-4">
        <div class="text-xs font-semibold text-slate-400 mb-1.5">${esc(crewLabel)} <span class="font-normal text-slate-500">· отчётов: ${g.rows.length}</span></div>
        <div class="space-y-1.5">${g.rows.map((r) => summaryCardHtml(r, false)).join('')}</div>
      </div>`).join('');
  }
  // Неизменившийся список заново не рисуем (см. setHtmlIfChanged в ui.js) — иначе при опросе раз в 5 секунд он мигал бы.
  setHtmlIfChanged(box, html);
}

async function onSummaryClick(e) {
  const edit = e.target.closest('[data-edit-report]');
  const del = e.target.closest('[data-del-summary]');
  if (edit) {
    visitReportForm(edit.dataset.editReport, { onDone: loadPointSummaries });
    return;
  }
  if (del) {
    const r = summaryItems.find((x) => x.task_id === del.dataset.delSummary);
    if (!r) return;
    if (!confirm(`Удалить отчёт «${r.point_id}» за ${fmtDate(reportDay(r))}? Это нельзя отменить.`)) return;
    try { await Api.del(`/api/monitoring/point-summaries/${encodeURIComponent(r.task_id)}`); await loadPointSummaries(); }
    catch (err) { alert('Не удалось удалить: ' + err.message); }
  }
}

async function loadPointSummaries() {
  let items;
  try {
    items = await Api.get(`/api/monitoring/point-summaries?date_from=${summaryDateFrom}&date_to=${summaryDateTo}&tz_offset=${new Date().getTimezoneOffset()}`);
  } catch (e) {
    // Не получилось (плохая связь) — прежний список остаётся на экране, добавляем только пометку.
    if (!summaryItems.length) $('#pointSummaries').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  summaryItems = items;
  renderPointSummaries();
}

function sessionCardHtml(s) {
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-2 flex flex-wrap items-center justify-between gap-2" data-session-card="${s.id}">
      <div class="min-w-0">
        <div class="text-sm font-semibold">${esc(s.point_id)} · ${esc(s.point_address || '')}</div>
        <div class="text-[11px] text-slate-500">${esc(s.person_name || 'Монтёр')}</div>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <span class="text-xs text-amber-300 font-medium">${elapsedLabel(s.started_at)}</span>
        <button data-perm="monitoring.manage" data-session-release="${s.id}" class="${btnGhost} !px-2 !py-1 text-xs">Без ремонта</button>
        <button data-perm="monitoring.manage" data-session-demontage="${s.id}" class="${btnDanger} !px-2 !py-1 text-xs">Демонтаж</button>
        <button data-perm="monitoring.manage" data-session-del="${s.id}" class="${btnGhost} !px-2 !py-1 text-xs" title="Убрать из списка без отчёта">×</button>
      </div>
    </div>`;
}

async function loadActiveSessions() {
  let items;
  try {
    items = await Api.get('/api/monitoring/active-sessions');
  } catch (e) {
    $('#activeSessions').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  patchKeyedList($('#activeSessions'), items, (s) => s.id, sessionCardHtml, '<p class="text-sm text-slate-500">Сейчас никто не работает через бота.</p>');
  items.forEach((s) => {
    const card = document.querySelector(`[data-session-card="${s.id}"]`);
    if (!card) return;
    card.querySelector('[data-session-release]').onclick = async () => {
      if (!confirm(`Отпустить бригаду без ремонта по «${s.point_id}»?`)) return;
      try { await Api.post(`/api/monitoring/active-sessions/${s.id}/release`, {}); await loadActiveSessions(); }
      catch (e) { alert('Не удалось: ' + e.message); }
    };
    card.querySelector('[data-session-demontage]').onclick = async () => {
      const reason = prompt(`Причина демонтажа «${s.point_id}»:`);
      if (!reason || !reason.trim()) return;
      try { await Api.post(`/api/monitoring/active-sessions/${s.id}/demontage`, { reason: reason.trim() }); await loadActiveSessions(); }
      catch (e) { alert('Не удалось: ' + e.message); }
    };
    card.querySelector('[data-session-del]').onclick = async () => {
      if (!confirm(`Убрать «${s.point_id}» из списка «Сейчас в работе»? Отчёт при этом НЕ отправляется.`)) return;
      try { await Api.del(`/api/monitoring/active-sessions/${s.id}`); await loadActiveSessions(); }
      catch (e) { alert('Не удалось: ' + e.message); }
    };
  });
}

function needsCheckCardHtml(it) {
  return `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
      <div>
        <div class="text-sm font-semibold">${esc(it.point_id)} · ${esc(it.point_address || '')}</div>
        <div class="text-[11px] text-slate-500">Отчёт «Работает»: ${esc(fmtDateTime(it.reported_at, true))}</div>
      </div>
      ${pointStatusBadge(it.current_status)}
    </div>`;
}

async function loadNeedsCheck() {
  let items;
  try {
    items = await Api.get('/api/monitoring/needs-check');
  } catch (e) {
    $('#needsCheck').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  patchKeyedList($('#needsCheck'), items, (it) => it.point_id, needsCheckCardHtml, '<p class="text-sm text-slate-500">Расхождений нет.</p>');
}

// ---------- Фото по дням: окно со всеми днями, новые сверху ----------
// День раскрывается по нажатию (картинки грузятся только у раскрытых дней), самый свежий — сразу.
// Фото открывается в новой вкладке; «Архив» отдаёт все фото дня одним .zip.
const WEEKDAYS_SHORT = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб'];
const dayLabel = (iso) => `${fmtDate(iso)} (${WEEKDAYS_SHORT[new Date(iso + 'T12:00:00').getDay()]})`;
const plural = (n, one, few, many) => {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m100 >= 11 && m100 <= 14 ? many : m10 === 1 ? one : m10 >= 2 && m10 <= 4 ? few : many}`;
};

function photoThumbHtml(ph) {
  const url = `/api/monitoring/photos/${ph.id}/file`;
  const who = [ph.name, ph.uploaded_by, ph.uploaded_at ? fmtDateTime(ph.uploaded_at, true) : ''].filter(Boolean).join(' · ');
  return `<span class="relative block" data-photo-box="${ph.id}">
    <a href="${url}" target="_blank" rel="noopener" data-pv data-pv-title="${esc(who)}" data-pv-sub="${esc(ph.date ? fmtDate(ph.date) : '')}" title="${esc(who)}" class="block">
      <img src="${url}" loading="lazy" alt="" style="width:100%; aspect-ratio:1/1; object-fit:cover; border-radius:10px; background:#0f172a; display:block">
    </a>
    ${ppBadge(ph)}
    ${photoDownloadBtn(ph.id)}
    ${!can('photos.delete') || ph.imported ? '' : `<button data-del-photo="${ph.id}" title="Удалить это фото" class="absolute rounded-lg px-1.5 text-xs" style="top:4px; right:4px; background:rgba(244,63,94,.88); color:#fff">×</button>`}
  </span>`;
}

function photoGroupHtml(g) {
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3" data-photo-group="${esc(g.point_id)}">
    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
      <div class="text-sm font-semibold">${esc(g.point_id)} · ${esc(g.point_address || '')} <span class="text-slate-500 font-normal">· ${plural(g.photos.length, 'фото', 'фото', 'фото')}</span></div>
      <span class="flex items-center gap-2">
        <button data-perm="photos.view" data-point-photos="${esc(g.point_id)}" data-pp-back="1" class="${btnGhost} !px-3 !py-1 text-xs" title="Все фото этого комплекса по дням">📷 Все фото комплекса</button>
        ${!can('photos.delete') || g.photos.every((p) => p.imported) ? '' : `<button data-del-group="${esc(g.point_id)}" class="${btnDanger} !px-3 !py-1 text-xs" title="Прежние фото из архива на диске не удаляются">Удалить все</button>`}
      </span>
    </div>
    <div style="display:grid; grid-template-columns:repeat(auto-fill,minmax(130px,1fr)); gap:8px">${g.photos.map(photoThumbHtml).join('')}</div>
  </div>`;
}

async function fillPhotoDay(dayEl, date) {
  const body = dayEl.querySelector('[data-day-body]');
  body.innerHTML = '<p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p>';
  let groups;
  try {
    groups = await Api.get(`/api/monitoring/photos/day-items?date=${date}`);
  } catch (e) {
    body.innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  body.innerHTML = groups.length ? `<div class="space-y-2">${groups.map(photoGroupHtml).join('')}</div>` : '<p class="text-sm text-slate-500">Фото за этот день нет.</p>';
  body.querySelectorAll('[data-del-group]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm(`Удалить все фото «${btn.dataset.delGroup}» за ${fmtDate(date)}?`)) return;
      try {
        await Api.del(`/api/monitoring/photos?point_id=${encodeURIComponent(btn.dataset.delGroup)}&date=${date}`);
        await loadPhotoDays();
      } catch (e) { alert('Не удалось удалить: ' + e.message); }
    };
  });
  body.querySelectorAll('[data-del-photo]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Удалить это фото?')) return;
      try {
        await Api.del(`/api/monitoring/photos/${btn.dataset.delPhoto}`);
        await loadPhotoDays();
      } catch (e) { alert('Не удалось удалить: ' + e.message); }
    };
  });
}

const _openPhotoDays = new Set();

async function loadPhotoDays() {
  const box = $('#photoDays');
  if (!box) return;
  let days;
  try {
    days = await Api.get('/api/monitoring/photos/days');
  } catch (e) {
    box.innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  if (!days.length) {
    box.innerHTML = '<p class="text-sm text-slate-500">Фото пока нет.</p>';
    return;
  }
  // Раскрытые дни остаются раскрытыми после удаления фото; при первом открытии раскрыт самый свежий.
  if (!box.dataset.init) { box.dataset.init = '1'; _openPhotoDays.clear(); _openPhotoDays.add(days[0].date); }
  box.innerHTML = days.map((d) => `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/20" data-photo-day="${d.date}">
      <div class="flex flex-wrap items-center justify-between gap-2 px-4 py-3 cursor-pointer select-none" data-day-head="${d.date}">
        <span class="text-sm font-semibold"><small class="text-slate-500 mr-1" data-day-arrow>${_openPhotoDays.has(d.date) ? '▾' : '▸'}</small>${esc(dayLabel(d.date))}
          <span class="text-slate-500 font-normal">· ${plural(d.photos, 'фото', 'фото', 'фото')} · ${plural(d.points, 'комплекс', 'комплекса', 'комплексов')}</span></span>
        <a href="/api/monitoring/photos/export?date=${d.date}" data-day-zip class="${btnGhost} !px-3 !py-1 text-xs" title="Скачать все фото этого дня одним архивом">Архив .zip</a>
      </div>
      <div data-day-body data-pv-scope class="px-4 ${_openPhotoDays.has(d.date) ? '' : 'hidden'}" style="padding-bottom:1rem"></div>
    </div>`).join('');
  box.querySelectorAll('[data-photo-day]').forEach((dayEl) => {
    const date = dayEl.dataset.photoDay;
    const body = dayEl.querySelector('[data-day-body]');
    dayEl.querySelector('[data-day-zip]').onclick = (e) => e.stopPropagation();
    dayEl.querySelector('[data-day-head]').onclick = () => {
      const open = body.classList.contains('hidden');
      body.classList.toggle('hidden', !open);
      dayEl.querySelector('[data-day-arrow]').textContent = open ? '▾' : '▸';
      if (open) { _openPhotoDays.add(date); if (!body.dataset.loaded) { body.dataset.loaded = '1'; fillPhotoDay(dayEl, date); } }
      else _openPhotoDays.delete(date);
    };
    if (_openPhotoDays.has(date)) { body.dataset.loaded = '1'; fillPhotoDay(dayEl, date); }
  });
}

// ---------- Хранилище фото: сетевой диск вместо диска сервера (app/services/photo_storage.py) ----------

const fmtBytes = (n) => {
  if (n == null) return '—';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i += 1; }
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
};
const diskText = (d) => (d ? `свободно ${fmtBytes(d.free)} из ${fmtBytes(d.total)}` : 'место неизвестно');
let _photoStorageTimer = null;
let _photoWorkWas = false;      // шёл ли перенос/поиск при прошлом обновлении: когда закончился — обновить список фото (значки ☁/💾)

async function loadPhotoStorage() {
  const box = $('#photoStorage');
  if (!box) { clearInterval(_photoStorageTimer); return; }
  let s;
  try { s = await Api.get('/api/photo-storage'); } catch { box.innerHTML = ''; return; }
  const admin = can('admin.settings');
  const m = s.migration || {};
  const sc = s.scan;
  const btn = (id, text, title) => `<button type="button" id="${id}" class="${btnGhost} !px-3 !py-1 text-xs" title="${esc(title)}">${text}</button>`;
  const where = s.mode === 'smb' ? `сетевая папка <b>${esc(s.path)}</b>` : `папка на сервере <b>${esc(s.path)}</b>`;
  let head;
  let tone;
  if (!s.configured) {
    tone = 'border-slate-700/60 bg-slate-800/30';
    head = `<b>💾 Фото лежат на диске сервера</b> (${esc(diskText(s.local_disk))}).${admin ? ' Чтобы не занимать диск сервера, подключите сетевую папку Windows — кнопка «Настроить сетевой диск».' : ''}`;
  } else if (s.available) {
    tone = 'border-emerald-500/30 bg-emerald-500/10';
    head = `<b>☁ Фото хранятся на сетевом диске:</b> ${where} — доступна, ${esc(diskText(s.share_disk))}. Диск сервера: ${esc(diskText(s.local_disk))}.`;
  } else {
    tone = 'border-amber-500/30 bg-amber-500/10';
    head = `<b>⚠ Сетевой диск с фото недоступен</b> (${where}): ${esc(s.reason || 'нет связи')}. Новые фото пока сохраняются на сервере и сами переедут на диск, когда он вернётся.`;
  }
  const lines = [];
  if (sc) {
    const part = (label, x) => (x ? `${label}: ${x.files} (${fmtBytes(x.bytes)})` : '');
    lines.push([part('на сетевом диске', sc.share), part('во временном буфере сервера', sc.spool), part('старые, на диске сервера', sc.local)].filter(Boolean).join(' · '));
  }
  const sf = s.server_files;
  if (s.configured && sf && (sf.server.files || sf.buffer.files)) {
    lines.push(`<span class="text-amber-300">💾 На диске сервера ещё лежит ${sf.server.files} фото (${fmtBytes(sf.server.bytes)})${sf.buffer.files ? `, во временном буфере ${sf.buffer.files}` : ''}</span> — значок 💾 у снимка; кнопка «Перенести старые фото на сетевой диск» переносит их и удаляет с сервера.`);
  } else if (s.configured && sf) {
    lines.push('✓ На диске сервера фото не осталось — все на сетевом диске (значок ☁ у снимка).');
  }
  const ix = s.index || {};
  if (ix.state === 'running') lines.push(`Поиск фото на диске: просмотрено папок комплексов ${ix.done} из ${ix.matched}, найдено ${ix.found}, добавлено ${ix.added}${ix.renamed ? `, папок переименовано ${ix.renamed}` : ''}${ix.moved ? `, разложено по датам ${ix.moved}` : ''}…`);
  else if (ix.state === 'done' || ix.state === 'finished_with_errors') {
    const un = ix.unmatched_count ? ` Папок без пары среди комплексов: ${ix.unmatched_count}${(ix.unmatched || []).length ? ` (${esc(ix.unmatched.slice(0, 6).join(', '))}${ix.unmatched_count > 6 ? '…' : ''})` : ''}.` : '';
    lines.push(`Поиск фото на диске (${fmtDateTime(ix.finished_at)}): папок комплексов ${ix.matched} из ${ix.folders}, найдено ${ix.found}, добавлено ${ix.added}${ix.renamed ? `, папок дня переименовано в ДД-ММ-ГГГГ ${ix.renamed}` : ''}${ix.moved ? `, разложено по датам ${ix.moved}` : ''}${ix.removed ? `, пропавших убрано ${ix.removed}` : ''}.${un}${ix.errors ? ` Ошибок: ${ix.errors} (${esc(ix.message || '')}).` : ''}`);
  } else if (ix.state === 'error') lines.push(`Поиск фото на диске не удался: ${esc(ix.message || '')}`);
  if (m.state === 'running') lines.push(`Перенос на сетевой диск: ${m.done} из ${m.total}${m.failed ? `, ошибок ${m.failed}` : ''}…`);
  else if (m.state === 'done') lines.push(`Перенос завершён: ${m.done} фото (${fmtBytes(m.bytes)}) — место на сервере освобождено.`);
  else if (m.state === 'finished_with_errors' || m.state === 'error') lines.push(`Перенос завершён с ошибками (${m.failed || 0}): ${esc(m.message || '')}`);
  const controls = admin ? `<div class="flex flex-wrap items-center gap-2 pt-2">
      ${btn('psSettings', s.configured ? '⚙ Настройки сетевого диска' : '⚙ Настроить сетевой диск', 'Путь к сетевой папке Windows, логин и пароль')}
      ${s.configured && s.needs_marker && !s.available ? btn('psPrepare', '🔧 Подготовить диск', 'Один раз, когда к серверу подключён нужный диск: кладёт в его папку метку хранилища') : ''}
      ${s.configured && s.available ? btn('psIndex', '🔍 Найти фото, что уже лежат на диске', 'Просмотреть папки комплексов на сетевом диске: найти фото (регистр букв не важен), разложить лежащие в корне по папкам-датам и показать здесь. Сами делается раз в час.') : ''}
      ${s.configured ? btn('psScan', '🔎 Пересчитать файлы', 'Сколько фото на сетевом диске, в буфере и на диске сервера (на большом диске — долго)') : ''}
      ${s.configured && s.available ? btn('psMigrate', '📦 Перенести старые фото на сетевой диск', 'Фото, которые лежат на диске сервера, переедут на сетевой диск — место на сервере освободится') : ''}
      ${s.configured && s.available ? btn('psFlush', '↻ Перенести буфер сейчас', 'Фото, сохранённые на сервере, пока диск был недоступен') : ''}
    </div>` : '';
  box.innerHTML = `<div class="rounded-xl border ${tone} px-3 py-2 text-xs space-y-1">
      <div>${head}</div>${lines.filter(Boolean).map((l) => `<div class="text-slate-300">${l}</div>`).join('')}${controls}
    </div>`;
  const act = (id, fn) => { const b = $('#' + id); if (b) b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { alert(e.message); } loadPhotoStorage(); }; };
  if ($('#psSettings')) $('#psSettings').onclick = () => openPhotoStorageSettings(s);
  act('psPrepare', () => (confirm('Подготовить диск? Убедитесь, что к серверу подключён именно тот сетевой диск, где должны лежать фото: на него будет записана метка.')
    ? Api.post('/api/photo-storage/marker', {}) : null));
  act('psScan', () => Api.post('/api/photo-storage/scan', {}));
  act('psIndex', () => Api.post('/api/photo-storage/index', {}));
  act('psMigrate', () => (confirm('Перенести фото с диска сервера на сетевой диск? Идёт в фоне, окно можно закрыть. После переноса файлы на сервере удаляются.')
    ? Api.post('/api/photo-storage/migrate', {}) : null));
  act('psFlush', () => Api.post('/api/photo-storage/flush', {}));
  const working = m.state === 'running' || ix.state === 'running';
  if (_photoWorkWas && !working) { loadPhotoDays(); if (!$('#photoPoints')?.classList.contains('hidden')) loadPhotoPoints(); }
  _photoWorkWas = working;
  clearInterval(_photoStorageTimer);
  if (m.state === 'running' || ix.state === 'running') _photoStorageTimer = setInterval(loadPhotoStorage, 3000);
}

// Настройка сетевой папки Windows: путь в том виде, как его показывает проводник, + логин и пароль. Приложение подключается само.
function openPhotoStorageSettings(s) {
  const c = s.config || {};
  const smb = c.mode === 'smb';
  modal(`<h2 class="font-display text-lg font-bold mb-1">Сетевой диск для фото</h2>
    <p class="text-xs text-slate-400 mb-4">Фото выездов будут храниться в сетевой папке Windows (или NAS), а не на диске сервера. Приложение подключается к ней само —
      на сервере ничего монтировать не нужно. В указанной папке оно ведёт свои папки: <b>номер комплекса → дата → фото</b>
      (в папку «со списком комплексов» можно указать ту, где уже лежат папки комплексов).</p>
    <form id="psForm" class="space-y-3">
      <label class="${labelCls}">Путь к папке со списком комплексов
        <input name="path" value="${esc(smb ? c.path : '')}" placeholder="\\\\192.168.1.10\\photos\\Комплексы" class="${fieldCls}" autocomplete="off">
        <span class="text-[11px] text-slate-500 font-normal">Как в проводнике Windows: \\\\сервер\\общая_папка\\папка. Русские имена и пробелы можно, путь можно вставить как есть (в том числе в кавычках). Сервер — лучше IP-адрес.</span></label>
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Логин<input name="username" value="${esc(c.username || '')}" autocomplete="off" class="${fieldCls}" placeholder="например photo"></label>
        <label class="${labelCls}">Пароль<input name="password" type="password" autocomplete="new-password" class="${fieldCls}" placeholder="${c.password_set ? 'сохранён — оставьте пустым, чтобы не менять' : ''}"></label>
        <label class="${labelCls}">Домен (если есть)<input name="domain" value="${esc(c.domain || '')}" autocomplete="off" class="${fieldCls}" placeholder="обычно пусто"></label>
        <label class="${labelCls}">Порт<input name="port" type="number" min="1" max="65535" value="${esc(c.port || 445)}" class="${fieldCls}"></label>
      </div>
      <label class="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" name="organize" class="mt-0.5" ${c.organize === false ? '' : 'checked'}>
        <span>Фото, лежащие прямо в папке комплекса (без папки с датой), раскладывать по папкам «ГГГГ-ММ-ДД» по дате сохранения файла. Делается само, файлы переносятся на сервере, ничего не копируется и не затирается.</span></label>
      <div id="psResult" class="text-xs"></div>
      ${c.env_folder ? `<p class="text-[11px] text-slate-500">Сейчас фото могут храниться в папке, подключённой на сервере (${esc(c.env_folder)}). Если сохранить сетевую папку здесь, будет использоваться она.</p>` : ''}
      <div class="flex flex-wrap items-center gap-2 pt-2">
        <button type="button" id="psBack" class="${btnGhost}">Назад</button>
        <button type="button" id="psTest" class="${btnGhost}">Проверить подключение</button>
        <button class="${btnPrimary}">Сохранить</button>
        ${smb ? `<button type="button" id="psOff" class="${btnDanger} ml-auto" title="Новые фото снова пойдут на диск сервера">Отключить</button>` : ''}
      </div>
    </form>`, { wide: false });
  const form = $('#psForm');
  const values = () => ({
    mode: 'smb', path: form.path.value.trim(), username: form.username.value.trim(), password: form.password.value,
    domain: form.domain.value.trim(), port: +form.port.value || 445, organize: form.organize.checked,
  });
  const result = (html, ok) => { $('#psResult').innerHTML = `<div class="rounded-xl border px-3 py-2 ${ok ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300' : 'border-rose-500/30 bg-rose-500/10 text-rose-300'}">${html}</div>`; };
  $('#psBack').onclick = () => openPhotosModal();
  $('#psTest').onclick = async () => {
    const b = $('#psTest');
    b.disabled = true;
    $('#psResult').innerHTML = '<div class="text-slate-400">Подключаюсь…</div>';
    try {
      const r = await Api.post('/api/photo-storage/test', values());
      if (r.ok) {
        const names = (r.names || []).length ? ` Папки: ${esc(r.names.join(', '))}${r.folders > r.names.length ? '…' : ''}.` : ' Пока пустая.';
        const fixed = r.share_fixed ? ` Имя общей папки исправлено на «${esc(r.share)}» — как её называет сервер (нажмите «Сохранить», чтобы запомнить).` : '';
        if (r.share_fixed) form.path.value = r.target;
        result(`✓ Подключение работает: ${esc(r.target)}. Папок внутри: ${r.folders ?? 0}.${names}${r.disk ? ` Свободно ${esc(fmtBytes(r.disk.free))} из ${esc(fmtBytes(r.disk.total))}.` : ''}${fixed}`, true);
      } else {
        const read = r.server ? `<div class="mt-1 text-[11px] opacity-80">Путь понят так: сервер «${esc(r.server)}», общая папка «${esc(r.share)}»${r.folder ? `, папка «${esc(r.folder)}»` : ''}.</div>` : '';
        result(`✗ Не удалось: ${esc(r.message || 'неизвестная ошибка')}${read}`, false);
      }
    } catch (e) { result(`✗ ${esc(e.message)}`, false); }
    b.disabled = false;
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    if (smb && form.path.value.trim() !== c.path && !confirm('Диск меняется: фото, которые уже лежат на прежнем диске, перестанут открываться в приложении (останутся на самом диске). Продолжить?')) return;
    try {
      await Api.put('/api/photo-storage/config', values());
      await openPhotosModal();
    } catch (err) { result(`✗ ${esc(err.message)}`, false); }
  };
  if ($('#psOff')) $('#psOff').onclick = async () => {
    if (!confirm('Отключить сетевой диск? Новые фото пойдут на диск сервера, а фото, уже лежащие на сетевом диске, перестанут открываться в приложении (останутся на самом диске).')) return;
    try {
      await Api.put('/api/photo-storage/config', { mode: 'none' });
      await openPhotosModal();
    } catch (err) { result(`✗ ${esc(err.message)}`, false); }
  };
}

async function openPhotosModal() {
  modal(`<div class="flex items-center justify-between gap-3 mb-4">
      <h2 class="font-display text-lg font-bold">Фото по дням</h2>
      <div class="flex items-center gap-2">
        <a id="photosAllZip" href="/api/monitoring/photos/export-all" class="${btnPrimary} !px-4 !py-1.5 text-xs" title="Все фото за все дни одним архивом: комплексы → папки по дням с датой">⬇ Скачать всё за все дни</a>
        <button type="button" class="cancel ${btnGhost} !px-4 !py-1.5 text-xs">Закрыть</button>
      </div>
    </div>
    <div id="photoStorage" class="mb-4"></div>
    <div class="flex flex-wrap items-center gap-2 mb-3">
      <button type="button" id="phTabDays" class="${btnPrimary} !px-4 !py-1.5 text-xs">По дням</button>
      <button type="button" id="phTabPoints" class="${btnGhost} !px-4 !py-1.5 text-xs">По комплексам</button>
      <input id="phPointSearch" placeholder="Найти комплекс: номер или адрес" class="${fieldCls} hidden" style="max-width:340px" autocomplete="off">
    </div>
    <div id="photoDays" class="space-y-3"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    <div id="photoPoints" class="space-y-2 hidden"></div>`, { wide: true });
  const tab = (name) => {
    const days = name === 'days';
    $('#photoDays').classList.toggle('hidden', !days);
    $('#photoPoints').classList.toggle('hidden', days);
    $('#phPointSearch').classList.toggle('hidden', days);
    $('#phTabDays').className = `${days ? btnPrimary : btnGhost} !px-4 !py-1.5 text-xs`;
    $('#phTabPoints').className = `${days ? btnGhost : btnPrimary} !px-4 !py-1.5 text-xs`;
    if (!days) loadPhotoPoints();
  };
  $('#phTabDays').onclick = () => tab('days');
  $('#phTabPoints').onclick = () => tab('points');
  $('#phPointSearch').oninput = () => renderPhotoPoints();
  loadPhotoStorage();
  await loadPhotoDays();
}

// Вкладка «По комплексам»: все комплексы, по которым есть фото (в том числе лежавшие на диске до программы); по нажатию — фото по дням.
let _photoPoints = [];

async function loadPhotoPoints() {
  const box = $('#photoPoints');
  if (!box) return;
  box.innerHTML = '<p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p>';
  try { _photoPoints = await Api.get('/api/monitoring/photos/by-point'); }
  catch (e) { box.innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`; return; }
  renderPhotoPoints();
}

function renderPhotoPoints() {
  const box = $('#photoPoints');
  if (!box) return;
  const q = ($('#phPointSearch')?.value || '').trim();
  const list = _photoPoints.filter((p) => !q || matchesQuery(q, p.point_id, p.point_address));
  if (!list.length) {
    box.innerHTML = `<p class="text-sm text-slate-500">${_photoPoints.length ? 'Ничего не найдено.' : 'Фото пока нет.'}</p>`;
    return;
  }
  box.innerHTML = list.slice(0, 400).map((p) => `<button data-perm="photos.view" type="button" data-point-photos="${esc(p.point_id)}" data-pp-back="1" class="w-full text-left rounded-xl border border-slate-700/60 bg-slate-800/20 hover:bg-slate-700/30 px-4 py-2.5 transition-colors">
      <span class="text-sm font-semibold">${esc(p.point_id)}</span> <span class="text-sm text-slate-400">· ${esc(p.point_address || '')}</span>
      <span class="block text-xs text-slate-500">${ppPlural(p.count, 'фото', 'фото', 'фото')}${p.archive ? ` (из прежнего архива на диске: ${p.archive})` : ''} · с ${fmtDate(p.first)} по ${fmtDate(p.last)}</span>
    </button>`).join('') + (list.length > 400 ? `<p class="text-xs text-slate-500 pt-1">Показаны первые 400 из ${list.length} — уточните поиск.</p>` : '');
}

const VR_STATUS_LABEL = { pending: 'Ожидает', confirmed: 'Подтверждено', remark: 'Работает с замечанием — отпустили', issue: 'Продолжить работу' };
const VR_STATUS_COLOR = { pending: 'text-amber-300', confirmed: 'text-emerald-400', remark: 'text-amber-300', issue: 'text-rose-400' };

function verificationHistoryCardHtml(it) {
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-2 flex flex-wrap items-center justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-semibold">${esc(it.point_id)} · ${esc(it.point_address || '')}</div>
        ${it.issue_comment ? `<div class="text-[11px] text-slate-400">${esc(it.issue_comment)}</div>` : ''}
      </div>
      <span class="flex items-center gap-2 shrink-0">
        <span class="text-xs font-medium ${VR_STATUS_COLOR[it.status] || ''}">${esc(VR_STATUS_LABEL[it.status] || it.status)}</span>
        <button data-perm="notifications.resolve" data-del-vr="${it.id}" class="${btnDanger} !px-2 !py-1 text-xs">×</button>
      </span>
    </div>`;
}

async function loadVerificationHistory() {
  let items;
  try {
    items = await Api.get('/api/verification-requests?limit=20');
  } catch (e) {
    $('#verificationHistory').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  patchKeyedList($('#verificationHistory'), items, (it) => it.id, verificationHistoryCardHtml, '<p class="text-sm text-slate-500">Пока пусто.</p>');
  items.forEach((it) => {
    const btn = document.querySelector(`[data-del-vr="${it.id}"]`);
    if (!btn) return;
    btn.onclick = async () => {
      if (!confirm(`Удалить запись «${it.point_id}» из истории проверок?`)) return;
      try { await Api.del(`/api/verification-requests/${it.id}`); await loadVerificationHistory(); }
      catch (e) { alert('Не удалось удалить: ' + e.message); }
    };
  });
}

// ---------- Page chrome: auth guard, user menu, password change ----------

function close() { editing = false; $('#modal').innerHTML = ''; }

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
  if (!can('monitoring.view')) { window.location.href = '/'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  await loadPointStatuses();
  await loadWorkTypes();         // типы выездов и их «статусы выезда» нужны форме отчёта (✎ Править)
  await renderMonitoringPage();
  setInterval(() => {
    if (editing || document.hidden) return;
    loadActiveSessions().catch(() => {});
    loadNeedsCheck().catch(() => {});
    loadVerificationHistory().catch(() => {});
    if (document.activeElement !== $('#summaryDateFrom') && document.activeElement !== $('#summaryDateTo')) {
      loadPointSummaries().catch(() => {});
    }
  }, 5000);
}
boot();
