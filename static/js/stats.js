// /stats — dashboard over a configurable date range. $, esc, colorBadge,
// pointStatusBadge, loadPointStatuses, barChart/dailyTrendChart come from
// ui.js/charts.js. VT_COLORS/RS_COLORS below read the CSS custom
// properties defined in stats.html's <style> (see that file's comment for
// where the hex values come from and how they were validated).
let CURRENT_USER = null;

const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

const PRESETS = [
  ['7', '7 дней', 7],
  ['30', '30 дней', 30],
  ['90', '90 дней', 90],
  ['all', 'Весь период', null],
];

let statsPeriod = { from: isoDate(new Date(Date.now() - 29 * 86400000)), to: isoDate(new Date()) };

function vtColor(i) { return `var(--vt-${(i % 9) + 1})`; }
const RS_COLOR_BY_NAME = { 'Работает': 'var(--rs-working)', 'Демонтирован': 'var(--rs-dismantled)', 'Установлен': 'var(--rs-installed)', 'Не работает': 'var(--rs-broken)' };

// Вкладки страницы: «Сводка» (период, исходы выездов, статусы…) и «Счётчики» (свои числа по выбранным условиям — static/js/stat_counters.js). Выбранная вкладка в адресе (#counters).
let statsTab = location.hash === '#counters' ? 'counters' : 'summary';
const STATS_TABS = [['summary', 'Сводка'], ['counters', 'Счётчики']];

async function renderStatsPage() {
  $('#content').innerHTML = `<div class="st-tabs" role="tablist">${STATS_TABS.map(([key, label]) => `<button class="st-tab" role="tab" data-st-tab="${key}" aria-selected="${key === statsTab}">${label}</button>`).join('')}</div><div id="statsPane"></div>`;
  $('#content').querySelectorAll('[data-st-tab]').forEach((btn) => {
    btn.onclick = () => {
      if (statsTab === btn.dataset.stTab) return;
      statsTab = btn.dataset.stTab;
      history.replaceState(null, '', statsTab === 'counters' ? '#counters' : location.pathname + location.search);
      $('#content').querySelectorAll('[data-st-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.stTab === statsTab)));
      renderStatsTab();
    };
  });
  await renderStatsTab();
}

async function renderStatsTab() {
  const host = $('#statsPane');
  if (statsTab === 'counters') await renderCountersTab(host);
  else await renderSummaryTab(host);
}

// Раз в 20 с (и при возврате на вкладку браузера) обновляется то, что сейчас открыто.
async function refreshStatsTab() {
  if (statsTab === 'counters') await scLoad();
  else await loadStatsBody();
}

async function renderSummaryTab(host) {
  host.onclick = null;
  host.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
      <h2 class="font-display text-lg font-bold">Период</h2>
      <div class="flex flex-wrap items-center gap-2">
        ${PRESETS.map(([key, label]) => `<button data-preset="${key}" class="rounded-lg px-3 py-1.5 text-xs font-medium bg-slate-800/70 hover:bg-slate-700/70 text-slate-300 transition-colors">${label}</button>`).join('')}
        <input type="date" id="statsFrom" value="${statsPeriod.from}" class="rounded-lg px-2 py-1.5 text-xs">
        <span class="text-xs text-slate-500">—</span>
        <input type="date" id="statsTo" value="${statsPeriod.to}" class="rounded-lg px-2 py-1.5 text-xs">
        <button id="statsApplyBtn" class="${btnPrimary} !px-4 !py-1.5 text-xs">Применить</button>
        <button id="statsExportBtn" class="${btnGhost} !px-4 !py-1.5 text-xs">Экспорт истории в Excel</button>
        <button id="statsStatusExportBtn" class="${btnGhost} !px-4 !py-1.5 text-xs" title="Лист «Сводка» — таблица «По категориям» с этой страницы, лист «Детально» — каждый комплекс: статус, дней не работает, IP, адрес">Выгрузка статусов АПК (.xlsx)</button>
      </div>
    </div>
    <div id="statsBody"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>`;

  $('#statsExportBtn').onclick = () => exportVisitReportsForm();
  $('#statsStatusExportBtn').onclick = () => { window.location.href = '/api/stats/status-export'; };

  host.querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      const [, , days] = PRESETS.find((p) => p[0] === btn.dataset.preset);
      statsPeriod.to = isoDate(new Date());
      statsPeriod.from = days ? isoDate(new Date(Date.now() - (days - 1) * 86400000)) : '2000-01-01';
      $('#statsFrom').value = statsPeriod.from;
      $('#statsTo').value = statsPeriod.to;
      loadStatsBody();
    };
  });
  $('#statsApplyBtn').onclick = () => {
    statsPeriod.from = $('#statsFrom').value || statsPeriod.from;
    statsPeriod.to = $('#statsTo').value || statsPeriod.to;
    loadStatsBody();
  };

  await loadStatsBody();
}

function statTileHtml(label, value, colorClass, hint) {
  return `<div class="rounded-2xl border border-slate-700/50 bg-slate-800/30 p-4">
    <div class="text-2xl font-bold ${colorClass}">${value}</div>
    <div class="text-xs text-slate-400 mt-1">${esc(label)}</div>
    ${hint ? `<div class="text-[11px] text-slate-500 mt-1">${esc(hint)}</div>` : ''}
  </div>`;
}

// Small coloured-dot number cards — one per outcome (visit type / result
// status / current status), so every outcome has an explicit, always-
// visible count instead of only being readable off a bar's length.
function statGridHtml(items) {
  return `<div class="grid grid-cols-2 sm:grid-cols-3 gap-2">
    ${items.map(({ label, count, color }) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 flex items-center gap-2.5">
      <span class="inline-block h-2.5 w-2.5 rounded-full shrink-0" style="background:${color}"></span>
      <span class="min-w-0">
        <div class="text-lg font-bold leading-tight">${count}</div>
        <div class="text-[11px] text-slate-400 leading-tight truncate" title="${esc(label)}">${esc(label)}</div>
      </span>
    </div>`).join('')}
  </div>`;
}

function categoryMatrixHtml(rows) {
  const categories = [...new Set(rows.map((r) => r.category))];
  const statuses = [...new Set(rows.map((r) => r.status))];
  if (!categories.length) return '<p class="text-sm text-slate-500 text-center py-6">Нет данных</p>';
  const countFor = (cat, st) => rows.find((r) => r.category === cat && r.status === st)?.count || 0;
  return `<div class="overflow-auto">
    <table class="w-full text-xs">
      <thead><tr class="text-left text-slate-400">
        <th class="py-1.5 pr-3">Категория</th>
        ${statuses.map((s) => `<th class="py-1.5 px-2 text-right whitespace-nowrap">${esc(s)}</th>`).join('')}
      </tr></thead>
      <tbody>
        ${categories.map((cat) => `<tr class="border-t border-slate-700/40">
          <td class="py-1.5 pr-3">${esc(cat)}</td>
          ${statuses.map((s) => `<td class="py-1.5 px-2 text-right">${countFor(cat, s) || '—'}</td>`).join('')}
        </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function loadStatsBody() {
  if (!$('#statsBody')) return;       // открыта другая вкладка
  let data;
  try {
    data = await Api.get(`/api/stats/summary?date_from=${statsPeriod.from}&date_to=${statsPeriod.to}`);
  } catch (e) {
    $('#statsBody').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }

  const totalVisits = data.visit_types.reduce((n, x) => n + x.count, 0);
  const totalPoints = data.current_status.reduce((n, x) => n + x.count, 0);
  const workingNow = data.current_status.find((s) => s.status === 'Работает')?.count || 0;
  const downNow = data.current_status.find((s) => s.status === 'Не работает')?.count || 0;

  const html = `
    <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
      ${statTileHtml('Работает сейчас', workingNow, 'text-emerald-400')}
      ${statTileHtml('Не работает сейчас', downNow, 'text-rose-400')}
      ${statTileHtml('Отвалилось', data.transitions.went_down, 'text-rose-400', `на ${esc(fmtDate(statsPeriod.to))} · без учёта тех, что уже восстановились`)}
      ${statTileHtml('Восстановлено за период', data.transitions.recovered, 'text-emerald-400', 'был ремонт, либо не работал 2+ дня и восстановился сам')}
    </div>
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Исходы выездов за период <span class="text-slate-500 font-normal">(${totalVisits} отчётов)</span></h3>
      ${statGridHtml(data.result_statuses.map((v) => ({ label: v.result_status, count: v.count, color: RS_COLOR_BY_NAME[v.result_status] || 'var(--vt-1)' })))}
    </section>
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Типы выездов за период</h3>
      ${statGridHtml(data.visit_types.map((v, i) => ({ label: v.visit_type, count: v.count, color: vtColor(i) })))}
    </section>
    ${data.outcomes && data.outcomes.length ? `<section class="mb-6">
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Статусы выезда за период <span class="text-slate-500 font-normal">(итоги работ по типам; на статус комплекса не влияют)</span></h3>
      ${statGridHtml(data.outcomes.map((o, i) => ({ label: `${o.visit_type} · ${o.outcome}`, count: o.count, color: vtColor(i) })))}
    </section>` : ''}
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Текущее распределение статусов <span class="text-slate-500 font-normal">(${totalPoints} точек)</span></h3>
      ${statGridHtml(data.current_status.map((v) => ({ label: v.status, count: v.count, color: (_pointStatusCache[v.status] && _pointStatusCache[v.status].color) || '#64748b' })))}
    </section>
    <section class="mb-6">
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Отвалившиеся комплексы по дням</h3>
      <div id="chartDailyFailures"></div>
    </section>
    <section>
      <h3 class="text-sm font-semibold text-slate-300 mb-3">По категориям (текущий срез)</h3>
      ${categoryMatrixHtml(data.category_matrix)}
    </section>`;

  // Skip the write (and the chart redraw below) entirely when a 5s poll
  // comes back with numbers identical to what's already on screen — see
  // ui.js's setHtmlIfChanged.
  if (!setHtmlIfChanged($('#statsBody'), html)) return;
  dailyTrendChart($('#chartDailyFailures'), data.daily_failures.map((d) => ({ date: fmtDate(d.date), count: d.count })));
}

// «История ремонта» Excel-экспорт — тот же период, что выбран на странице
// (statsPeriod), плюс чекбоксы для выбора нужных колонок (см. VISIT_EXPORT_FIELDS
// в ui.js — зеркалит app/repositories/task_visit_reports_repository.py::EXPORT_FIELDS).
function exportVisitReportsForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Экспорт истории ремонта</h2>
    <p class="text-xs text-slate-400 mb-4">Период: ${esc(fmtDate(statsPeriod.from))} — ${esc(fmtDate(statsPeriod.to))} (меняется в фильтре периода на странице).</p>
    <form id="exportFieldsForm" class="space-y-1.5">
      <div class="flex items-center gap-2 pb-1">
        <button type="button" id="exportFieldsAll" class="${btnGhost} !py-1 !px-2.5 text-xs">Все поля</button>
        <button type="button" id="exportFieldsNone" class="${btnGhost} !py-1 !px-2.5 text-xs">Снять все</button>
      </div>
      ${VISIT_EXPORT_FIELDS.map(([key, label]) => `<label class="flex items-center gap-2 text-sm py-1">
        <input type="checkbox" name="field" value="${key}" checked class="rounded accent-indigo-500">
        ${esc(label)}
      </label>`).join('')}
      <div id="exportFieldsError" class="hidden mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-3">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Скачать .xlsx</button>
      </div>
    </form>`);

  $('#exportFieldsAll').onclick = () => { $('#exportFieldsForm').querySelectorAll('[name="field"]').forEach((cb) => { cb.checked = true; }); };
  $('#exportFieldsNone').onclick = () => { $('#exportFieldsForm').querySelectorAll('[name="field"]').forEach((cb) => { cb.checked = false; }); };

  $('#exportFieldsForm').onsubmit = (e) => {
    e.preventDefault();
    const fields = [...e.target.querySelectorAll('[name="field"]:checked')].map((cb) => cb.value);
    if (!fields.length) {
      $('#exportFieldsError').textContent = 'Выберите хотя бы одно поле';
      $('#exportFieldsError').classList.remove('hidden');
      return;
    }
    const params = new URLSearchParams({ date_from: statsPeriod.from, date_to: statsPeriod.to });
    fields.forEach((f) => params.append('fields', f));
    window.location.href = '/api/task-visit-reports/export?' + params.toString();
    close();
  };
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
  if (!can('stats.view')) { window.location.href = '/'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  await loadPointStatuses();
  await renderStatsPage();
  // Обновление раз в 20 с (сводка — это агрегаты по истории статусов, пересчитывать её каждые 5 с, как календарь, незачем и
  // дорого для сервера): не во время открытого окна (экспорт, смена пароля) и не в скрытой вкладке; при возврате на вкладку
  // обновляем сразу, чтобы цифры не были устаревшими.
  const refresh = () => {
    if (editing || document.hidden) return;
    refreshStatsTab().catch(() => {});
  };
  setInterval(refresh, 20000);
  document.addEventListener('visibilitychange', refresh);
}
boot();
