// /stats → вкладка «Счётчики»: свои числа с названием, каждое считается по набору выбранных условий (категория, статус, поверка, выезды, смены статуса, период…).
// Подсчёт и проверка условий — на сервере (app/services/stat_counters.py, app/api/routes_stat_counters.py); здесь плитки с числами, окно «Список комплексов» и редактор с
// живым предпросмотром. Видят все, у кого есть право на «Статистику»; создавать, менять и удалять — право «stats.counters» (can('stats.counters')).
// Зависит от ui.js ($, esc, can, Api, modal, toast, setHtmlIfChanged, fmtDate, btnPrimary/btnGhost/btnDanger/fieldCls) и stats.js (close, statsTab).
const SC = { list: [], options: null };
const SC_UNITS = { points: ['комплекс', 'комплекса', 'комплексов'], visits: ['выезд', 'выезда', 'выездов'], changes: ['смена статуса', 'смены статуса', 'смен статуса'] };
const SC_ON = { points: ['комплексе', 'комплексах', 'комплексах'], visits: [], changes: [] };
const SC_PERIODS = [['all', 'За всё время'], ['today', 'Сегодня'], ['days', 'Последние N дней'], ['month', 'Этот месяц'], ['prev_month', 'Прошлый месяц'], ['year', 'Этот год'], ['range', 'Свои даты']];
const SC_TEMPLATES = [
  ['Работают сейчас', { statuses: ['Работает'] }],
  ['Не работают сейчас', { statuses: ['Не работает'] }],
  ['Сломалось за месяц', { changes: 'had', change_to: ['Не работает'], period: { kind: 'month' } }],
  ['Выезды за 30 дней', { count: 'visits', period: { kind: 'days', days: 30 } }],
  ['Работают, и на них были выезды (30 дней)', { statuses: ['Работает'], visits: 'had', period: { kind: 'days', days: 30 } }],
  ['Поверка просрочена', { verification: 'expired' }],
  ['Поверка истекает в ближайшие 30 дней', { verification: 'soon', verification_days: 30 }],
  ['Без выездов 90 дней', { visits: 'none', period: { kind: 'days', days: 90 } }],
  ['Не работают дольше 7 дней', { statuses: ['Не работает'], days_in_status: 7 }],
];

const scNum = (n) => Number(n || 0).toLocaleString('ru-RU');
function scPlural(n, forms) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return forms[2];
  if (b > 1 && b < 5) return forms[1];
  return b === 1 ? forms[0] : forms[2];
}

(function mountCountersStyle() {
  const css = document.createElement('style');
  css.textContent = `
    .st-tabs{display:flex;gap:4px;margin:0 0 22px;border-bottom:1px solid rgb(var(--glass-border) / .25);overflow-x:auto;overflow-y:hidden}
    .st-tab{padding:9px 16px;font-size:14px;font-weight:600;color:rgb(var(--slate-400));background:transparent;border:0;border-bottom:2px solid transparent;margin-bottom:-1px;cursor:pointer;white-space:nowrap}
    .st-tab:hover{color:inherit}
    .st-tab[aria-selected=true]{color:inherit;border-bottom-color:rgb(var(--accent))}
    .sc-muted{color:rgb(var(--slate-400))}
    .sc-head{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px}
    .sc-head p{font-size:12px;margin-top:4px}
    .sc-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(270px,1fr));gap:14px}
    .sc-tile{border:1px solid rgb(var(--glass-border) / .28);background:rgb(var(--glass-1) / .45);border-radius:18px;padding:14px 16px;display:flex;flex-direction:column;gap:6px;min-width:0}
    .sc-top{display:flex;align-items:flex-start;justify-content:space-between;gap:8px}
    .sc-top h3{font-size:14px;font-weight:700;line-height:1.3;overflow-wrap:anywhere}
    .sc-acts{display:flex;gap:2px;flex:none}
    .sc-ico{border:0;background:transparent;color:rgb(var(--slate-400));border-radius:8px;width:28px;height:28px;cursor:pointer;font-size:14px;line-height:1}
    .sc-ico:hover:not(:disabled){background:rgb(var(--slate-500) / .25);color:inherit}
    .sc-ico:disabled{opacity:.3;cursor:default}
    .sc-num{align-self:flex-start;border:0;background:transparent;color:inherit;font-size:40px;font-weight:800;line-height:1.1;padding:0;cursor:pointer;font-variant-numeric:tabular-nums}
    .sc-num:hover{color:rgb(var(--accent))}
    .sc-unit{font-size:12px;color:rgb(var(--slate-400))}
    .sc-err{font-size:12px;color:#fb7185}
    .sc-bd{display:grid;grid-template-columns:minmax(0,1fr) 70px auto;gap:8px;align-items:center;font-size:12px;margin-top:2px}
    .sc-bd span.l{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
    .sc-bd .bar{height:6px;border-radius:4px;background:rgb(var(--slate-500) / .25);overflow:hidden}
    .sc-bd .bar i{display:block;height:100%;background:rgb(var(--accent));border-radius:4px}
    .sc-bd b{font-variant-numeric:tabular-nums}
    .sc-cond{font-size:12px;margin-top:2px}
    .sc-cond summary{cursor:pointer;color:rgb(var(--slate-400))}
    .sc-cond ul{margin:6px 0 0;padding-left:16px;list-style:disc;display:grid;gap:2px}
    .sc-foot{display:flex;gap:8px;margin-top:auto;padding-top:8px;flex-wrap:wrap}
    .sc-link{border:1px solid rgb(var(--glass-border) / .3);background:transparent;color:inherit;border-radius:10px;padding:5px 11px;font-size:12px;cursor:pointer;text-decoration:none}
    .sc-link:hover{background:rgb(var(--slate-500) / .2)}
    .sc-empty{border:1px dashed rgb(var(--glass-border) / .4);border-radius:18px;padding:28px 20px;text-align:center}
    .sce{display:grid;grid-template-columns:minmax(0,1fr) 310px;gap:22px;align-items:start}
    @media (max-width:880px){.sce{grid-template-columns:1fr}}
    .sce-sec{border:1px solid rgb(var(--glass-border) / .25);border-radius:14px;padding:12px 14px 14px;margin:0 0 12px;display:grid;gap:10px;min-width:0}
    .sce-sec legend{padding:0 6px;font-size:12px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:rgb(var(--slate-400))}
    .sce-row{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}
    .sce-lab{display:grid;gap:5px;font-size:12px;font-weight:500;color:rgb(var(--slate-400));min-width:0}
    .sc-chips{display:flex;flex-wrap:wrap;gap:6px}
    .sc-chip{border:1px solid rgb(var(--glass-border) / .35);background:transparent;color:inherit;border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer}
    .sc-chip:hover{background:rgb(var(--slate-500) / .2)}
    .sc-chip.on{background:rgb(var(--accent));border-color:rgb(var(--accent));color:#fff}
    .sc-seg{display:inline-flex;border:1px solid rgb(var(--glass-border) / .35);border-radius:10px;overflow:hidden}
    .sc-seg button{border:0;background:transparent;color:inherit;padding:6px 12px;font-size:13px;cursor:pointer}
    .sc-seg button.on{background:rgb(var(--accent));color:#fff}
    .sce-side{position:sticky;top:0;border:1px solid rgb(var(--glass-border) / .3);background:rgb(var(--glass-1) / .55);border-radius:16px;padding:14px 16px;display:grid;gap:8px}
    .sce-side .sc-num{cursor:default;font-size:44px}
    .sce-side .sc-num:hover{color:inherit}
    .sce-list{max-height:260px;overflow:auto;font-size:12px;border-top:1px solid rgb(var(--glass-border) / .25);padding-top:6px}
    .sc-tbl{width:100%;border-collapse:collapse;font-size:12px}
    .sc-tbl th{position:sticky;top:0;background:rgb(var(--glass-2) / 1);text-align:left;padding:6px 8px;color:rgb(var(--slate-400));font-weight:600;white-space:nowrap}
    .sc-tbl td{padding:5px 8px;border-top:1px solid rgb(var(--glass-border) / .18);vertical-align:top}
    .sc-tbl td.n{text-align:right;font-variant-numeric:tabular-nums}`;
  document.head.appendChild(css);
})();

// ---------------------------------------------------------------- вкладка
async function renderCountersTab(host) {
  host.onclick = scOnClick;
  host.innerHTML = `<div class="sc-head">
      <div><h2 class="font-display text-lg font-bold">Счётчики</h2>
        <p class="sc-muted">Свои числа по любым условиям: категория, статус, поверка, выезды, смены статуса, период. Кликните число — увидите, какие комплексы в него вошли.</p></div>
      ${can('stats.counters') ? `<button id="scNew" class="${btnPrimary}">＋ Новый счётчик</button>` : ''}
    </div>
    <div id="scGrid"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>`;
  if ($('#scNew')) $('#scNew').onclick = () => scEdit(null);
  await scLoad();
}

async function scLoad() {
  const grid = $('#scGrid');
  if (!grid) return;
  let data;
  try {
    data = await Api.get('/api/stat-counters');
  } catch (e) {
    grid.innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  SC.list = data.counters || [];
  const html = SC.list.length
    ? `<div class="sc-grid">${SC.list.map((c, i) => scTile(c, i, SC.list.length)).join('')}</div>`
    : `<div class="sc-empty"><p class="font-semibold">Счётчиков пока нет</p>
        <p class="sc-muted text-xs mt-1 mb-3">Например: «сколько комплексов категории X работают сейчас и на них были выезды за месяц» или «сколько сломалось за месяц с действующей поверкой».</p>
        ${can('stats.counters') ? `<button data-sc="new" class="${btnPrimary}">Создать первый счётчик</button>` : '<p class="sc-muted text-xs">Счётчики создаёт тот, у кого есть право «Создавать и менять счётчики в Статистике».</p>'}</div>`;
  setHtmlIfChanged(grid, html);
}

function scBreakdown(r) {
  if (!r.breakdown || !r.breakdown.length) return '';
  const max = Math.max(...r.breakdown.map((b) => b.count), 1);
  const rows = r.breakdown.slice(0, 12).map((b) => `<div class="sc-bd"><span class="l" title="${esc(b.label)}">${esc(b.label)}</span><span class="bar"><i style="width:${Math.max(4, Math.round(b.count / max * 100))}%"></i></span><b>${scNum(b.count)}</b></div>`).join('');
  return `<div>${rows}${r.breakdown.length > 12 ? `<div class="sc-muted text-xs mt-1">…и ещё ${r.breakdown.length - 12}</div>` : ''}</div>`;
}

function scSub(r) {
  const parts = [];
  if (r.what === 'points') parts.push(`из ${scNum(r.total)} в справочнике`);
  else parts.push(`на ${scNum(r.points)} ${scPlural(r.points, SC_ON.points)}`);
  if (r.period) parts.push(`${fmtDate(r.period.from)} — ${fmtDate(r.period.to)}`);
  return parts.join(' · ');
}

function scTile(c, i, n) {
  const r = c.result;
  const edit = can('stats.counters');
  const acts = edit ? `<div class="sc-acts">
      <button class="sc-ico" data-sc="up" title="Выше" ${i === 0 ? 'disabled' : ''}>↑</button><button class="sc-ico" data-sc="down" title="Ниже" ${i === n - 1 ? 'disabled' : ''}>↓</button>
      <button class="sc-ico" data-sc="edit" title="Изменить">✎</button><button class="sc-ico" data-sc="dup" title="Создать копию">⧉</button><button class="sc-ico" data-sc="del" title="Удалить">🗑</button></div>` : '';
  const body = c.error || !r
    ? `<p class="sc-err">${esc(c.error || 'Не удалось посчитать')}</p>`
    : `<button class="sc-num" data-sc="list" title="Показать, какие комплексы вошли в число">${scNum(r.count)}</button>
       <div class="sc-unit">${scPlural(r.count, SC_UNITS[r.what])}<br>${esc(scSub(r))}</div>${scBreakdown(r)}`;
  const foot = c.error || !r ? '' : `<div class="sc-foot"><button class="sc-link" data-sc="list">Список комплексов</button><a class="sc-link" data-sc="export" href="/api/stat-counters/${c.id}/export">⬇ Excel</a></div>`;
  return `<article class="sc-tile" data-sc-id="${c.id}">
    <div class="sc-top"><h3>${esc(c.name)}</h3>${acts}</div>${body}
    ${(c.summary || []).length ? `<details class="sc-cond"><summary>Условия</summary><ul>${c.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>` : ''}${foot}</article>`;
}

async function scOnClick(e) {
  const b = e.target.closest('[data-sc]');
  if (!b || b.disabled) return;
  const act = b.dataset.sc;
  if (act === 'export') return;                         // обычная ссылка на выгрузку
  if (act === 'new') return scEdit(null);
  const id = Number(b.closest('[data-sc-id]')?.dataset.scId);
  const c = SC.list.find((x) => x.id === id);
  if (!c) return;
  if (act === 'list') return scShowList(c);
  if (act === 'edit') return scEdit(c);
  if (act === 'dup') return scEdit(null, { name: `${c.name} (копия)`, filters: c.filters });
  if (act === 'up' || act === 'down') {
    try { await Api.post(`/api/stat-counters/${id}/move`, { direction: act === 'up' ? -1 : 1 }); } catch (err) { toast(`Не удалось: ${err.message}`); }
    return scLoad();
  }
  if (act === 'del') {
    if (!confirm(`Удалить счётчик «${c.name}»? Сами комплексы и данные не затрагиваются.`)) return;
    try { await Api.del(`/api/stat-counters/${id}`); toast('Удалён'); } catch (err) { toast(`Не удалось удалить: ${err.message}`); }
    return scLoad();
  }
}

// ---------------------------------------------------------------- список комплексов
function scRowsTable(d, limit) {
  const rows = d.rows.slice(0, limit);
  const showDays = rows.some((r) => r.days_in_status != null);
  const status = (s) => (typeof pointStatusBadge === 'function' ? pointStatusBadge(s) : esc(s));
  const ver = (r) => (r.verification ? `<span style="${r.verification_state === 'expired' ? 'color:#fb7185' : ''}">${esc(fmtDate(r.verification))}</span>` : '<span class="sc-muted">—</span>');
  return `<table class="sc-tbl"><thead><tr><th>Номер</th><th>Адрес</th><th>Категория</th><th>Статус</th><th>Поверка до</th><th>Выездов</th><th>Смен статуса</th>${showDays ? '<th>Дней в статусе</th>' : ''}</tr></thead>
    <tbody>${rows.map((r) => `<tr><td class="font-semibold">${esc(r.id)}</td><td>${esc(r.address)}</td><td>${esc(r.category)}</td><td>${status(r.status)}</td><td>${ver(r)}</td>
      <td class="n">${r.visits || '—'}</td><td class="n">${r.changes || '—'}</td>${showDays ? `<td class="n">${r.days_in_status ?? '—'}</td>` : ''}</tr>`).join('')}</tbody></table>`;
}

async function scShowList(c) {
  modal(`<h2 class="font-display text-lg font-bold mb-1">${esc(c.name)}</h2><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p>`, { wide: true });
  let d;
  try {
    d = await Api.post('/api/stat-counters/points', { filters: c.filters });
  } catch (e) {
    $('#modal .glass').innerHTML = `<h2 class="font-display text-lg font-bold mb-2">${esc(c.name)}</h2><p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p><div class="pt-3"><button class="cancel ${btnGhost}">Закрыть</button></div>`;
    $('.cancel')?.addEventListener('click', close);
    return;
  }
  const r = d.result;
  $('#modal .glass').innerHTML = `<h2 class="font-display text-lg font-bold mb-1">${esc(c.name)}</h2>
    <p class="text-sm mb-1"><b>${scNum(r.count)}</b> ${scPlural(r.count, SC_UNITS[r.what])} · ${esc(scSub(r))}</p>
    <details class="sc-cond mb-3"><summary>Условия</summary><ul>${d.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>
    ${d.rows.length ? `<div style="max-height:58vh;overflow:auto">${scRowsTable(d, d.rows.length)}</div><p class="text-xs sc-muted mt-2">Комплексов в списке: <b>${scNum(d.rows.length)}</b>.</p>` : '<p class="text-sm sc-muted py-6 text-center">Под эти условия не подходит ни один комплекс.</p>'}
    ${d.truncated ? `<p class="text-xs sc-muted mt-2">Показаны первые ${scNum(d.limit || d.rows.length)} комплексов.</p>` : ''}
    <div class="flex items-center gap-2 pt-4"><button class="cancel ${btnGhost}">Закрыть</button><a class="${btnPrimary}" href="/api/stat-counters/${c.id}/export">⬇ Скачать Excel</a></div>`;
  $('.cancel')?.addEventListener('click', close);
}

// ---------------------------------------------------------------- редактор
const scDefaults = () => ({
  count: 'points', period: { kind: 'all', days: 30, from: '', to: '' }, categories: [], statuses: [], power: [], verification: '', verification_days: 30, sim: '', ip: '', fault: '',
  groups: [], text: '', days_in_status: null, visits: '', visit_types: [], visit_results: [], visits_min: null, changes: '', change_to: [], change_from: [], group_by: '',
});
function scMerge(filters) {
  const f = Object.assign(scDefaults(), JSON.parse(JSON.stringify(filters || {})));
  f.period = Object.assign({ kind: 'all', days: 30, from: '', to: '' }, f.period || {});
  return f;
}

let scEd = null;       // { id|null, name, f, opts, seq, timer }

async function scEdit(counter, copy) {
  if (!can('stats.counters')) return;
  try {
    SC.options = await Api.get('/api/stat-counters/options');       // справочники могли измениться — берём свежие при каждом открытии
  } catch (e) { toast(`Не удалось открыть редактор: ${e.message}`); return; }
  const src = counter || copy || {};
  scEd = { id: counter ? counter.id : null, name: src.name || '', f: scMerge(src.filters), seq: 0, timer: null, listOpen: false };
  modal(`<form id="sceForm" novalidate></form>`, { wide: true });
  scRenderForm();
}

const scSel = (key, value, options, attr = 'data-f') => `<select ${attr}="${key}" class="${fieldCls}">${options.map(([v, l]) => `<option value="${esc(v)}"${String(v) === String(value) ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>`;
function scChips(key, items, label) {
  const sel = scEd.f[key];
  return items.length
    ? `<div class="sc-chips">${items.map((v) => { const val = typeof v === 'object' ? v.id : v; const on = sel.includes(val); return `<button type="button" class="sc-chip${on ? ' on' : ''}" data-chip="${key}" data-v="${esc(val)}" aria-pressed="${on}">${esc(typeof v === 'object' ? v.name : (label ? label(v) : v))}</button>`; }).join('')}</div>`
    : '<span class="sc-muted text-xs">нет значений в справочнике</span>';
}

function scRenderForm() {
  const { f, name } = scEd, o = SC.options, p = f.period;
  const num = (key, v, ph, extra = '') => `<input type="number" min="1" data-n="${key}" value="${v ?? ''}" placeholder="${esc(ph || '')}" class="${fieldCls}" ${extra}>`;
  $('#sceForm').innerHTML = `
    <h2 class="font-display text-lg font-bold mb-3">${scEd.id ? 'Изменить счётчик' : 'Новый счётчик'}</h2>
    <div class="sce"><div>
      <fieldset class="sce-sec"><legend>Название и что считаем</legend>
        <label class="sce-lab">Название<input id="sceName" maxlength="80" value="${esc(name)}" placeholder="Например: Старые камеры в строю" class="${fieldCls}"></label>
        ${scEd.id ? '' : `<label class="sce-lab">Начать с шаблона<select id="sceTpl" class="${fieldCls}"><option value="">— свой счётчик —</option>${SC_TEMPLATES.map(([t], i) => `<option value="${i}">${esc(t)}</option>`).join('')}</select></label>`}
        <div><div class="sce-lab mb-1">Что считаем</div><div class="sc-seg" role="group">${[['points', 'Комплексы'], ['visits', 'Выезды'], ['changes', 'Смены статуса']].map(([v, l]) => `<button type="button" data-count="${v}" class="${f.count === v ? 'on' : ''}">${l}</button>`).join('')}</div></div>
        <label class="sce-lab">Разбить итог по${scSel('group_by', f.group_by, [['', '— не разбивать —'], ['category', 'категориям'], ['status', 'статусам'], ['power', 'питанию'], ['verification', 'поверке']])}</label>
      </fieldset>
      <fieldset class="sce-sec"><legend>Какие комплексы</legend>
        <div><div class="sce-lab mb-1">Категория (любая из выбранных)</div>${scChips('categories', o.categories)}</div>
        <div><div class="sce-lab mb-1">Статус сейчас</div>${scChips('statuses', o.statuses)}</div>
        <div><div class="sce-lab mb-1">Питание</div>${scChips('power', o.power)}</div>
        <div class="sce-row">
          <label class="sce-lab">Поверка${scSel('verification', f.verification, [['', 'Любая'], ['valid', 'Действует'], ['expired', 'Просрочена'], ['none', 'Нет данных о сроке'], ['soon', 'Истекает в ближайшие N дней']])}</label>
          <label class="sce-lab" id="sceVerDays" style="${f.verification === 'soon' ? '' : 'display:none'}">Сколько дней${num('verification_days', f.verification_days, '30')}</label>
          <label class="sce-lab">SIM${scSel('sim', f.sim, [['', 'Любой'], ['yes', 'Есть'], ['no', 'Нет']])}</label>
          <label class="sce-lab">IP-адрес${scSel('ip', f.ip, [['', 'Любой'], ['yes', 'Указан'], ['no', 'Не указан']])}</label>
          <label class="sce-lab">Причина неисправности${scSel('fault', f.fault, [['', 'Любая'], ['yes', 'Заполнена'], ['no', 'Не заполнена']])}</label>
        </div>
        ${o.groups.length ? `<div><div class="sce-lab mb-1">В подгруппе (любой из выбранных)</div>${scChips('groups', o.groups)}</div>` : ''}
        <div class="sce-row">
          <label class="sce-lab">Текст в номере, адресе или описании<input data-t="text" maxlength="100" value="${esc(f.text)}" placeholder="например: ARENA или ул. Красная" class="${fieldCls}"></label>
          <label class="sce-lab">В текущем статусе не менее, дней${num('days_in_status', f.days_in_status, 'любой')}</label>
        </div>
      </fieldset>
      <fieldset class="sce-sec"><legend>Период (для выездов и смен статуса)</legend>
        <div class="sce-row">
          <label class="sce-lab">Период${scSel('kind', p.kind, SC_PERIODS, 'data-p')}</label>
          <label class="sce-lab" id="sceDays" style="${p.kind === 'days' ? '' : 'display:none'}">Сколько дней<input type="number" min="1" data-pn="days" value="${p.days ?? 30}" class="${fieldCls}"></label>
          <label class="sce-lab sceRange" style="${p.kind === 'range' ? '' : 'display:none'}">С<input type="date" data-pd="from" value="${esc(p.from)}" class="${fieldCls}"></label>
          <label class="sce-lab sceRange" style="${p.kind === 'range' ? '' : 'display:none'}">По<input type="date" data-pd="to" value="${esc(p.to)}" class="${fieldCls}"></label>
        </div>
      </fieldset>
      <fieldset class="sce-sec"><legend>Выезды (отчёты о выездах)</legend>
        <div class="sce-row"><label class="sce-lab">Выезды на комплекс${scSel('visits', f.visits, [['', 'Не важно'], ['had', 'Были'], ['none', 'Не было']])}</label>
          <label class="sce-lab">Выездов не менее${num('visits_min', f.visits_min, 'любое')}</label></div>
        <div><div class="sce-lab mb-1">Тип работ (любой из выбранных)</div>${scChips('visit_types', o.work_types)}</div>
        <div><div class="sce-lab mb-1">Итог выезда</div>${scChips('visit_results', o.visit_results)}</div>
        <p class="sc-muted text-xs">Выбрали тип работ или итог — считаются только комплексы, на которых такие выезды были (даже если выше «Не важно»).</p>
      </fieldset>
      <fieldset class="sce-sec"><legend>Смены статуса</legend>
        <label class="sce-lab" style="max-width:260px">Смены статуса у комплекса${scSel('changes', f.changes, [['', 'Не важно'], ['had', 'Были'], ['none', 'Не было']])}</label>
        <div><div class="sce-lab mb-1">Перешёл в статус</div>${scChips('change_to', o.statuses)}</div>
        <div><div class="sce-lab mb-1">Перешёл из статуса</div>${scChips('change_from', o.statuses)}</div>
        <p class="sc-muted text-xs">Выбрали статус «в» или «из» — считаются только комплексы, у которых такая смена была (даже если выше «Не важно»).</p>
      </fieldset>
    </div>
    <aside class="sce-side"><div class="sce-lab">Сейчас получится</div><div id="sceResult"><p class="sc-muted text-xs">Считаю…</p></div>
      <div id="sceError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-1 flex-wrap"><button type="button" class="cancel ${btnGhost}">Отмена</button><button type="submit" class="${btnPrimary}">Сохранить</button></div></aside></div>`;
  $('.cancel')?.addEventListener('click', () => { scEd = null; close(); });
  scBindForm();
  scPreview();
}

function scBindForm() {
  const form = $('#sceForm');
  const touch = () => { scSchedule(); };
  form.onclick = (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip) {
      const key = chip.dataset.chip, raw = chip.dataset.v, val = key === 'groups' ? Number(raw) : raw, arr = scEd.f[key];
      const at = arr.indexOf(val);
      if (at >= 0) arr.splice(at, 1); else arr.push(val);
      chip.classList.toggle('on', at < 0);
      chip.setAttribute('aria-pressed', String(at < 0));
      return touch();
    }
    const cnt = e.target.closest('[data-count]');
    if (cnt) {
      scEd.f.count = cnt.dataset.count;
      form.querySelectorAll('[data-count]').forEach((b) => b.classList.toggle('on', b === cnt));
      touch();
    }
    const list = e.target.closest('[data-show-list]');
    if (list) scShowInline();
  };
  const handle = (e) => {
    const t = e.target, f = scEd.f;
    if (t.id === 'sceName') { scEd.name = t.value; return; }
    if (t.id === 'sceTpl') {
      if (t.value === '') return;
      const [title, tpl] = SC_TEMPLATES[Number(t.value)];
      scEd.f = scMerge(tpl);
      if (!scEd.name.trim()) scEd.name = title;
      scRenderForm();
      return;
    }
    if (t.dataset.f !== undefined) {
      f[t.dataset.f] = t.value;
      if (t.dataset.f === 'verification') $('#sceVerDays').style.display = t.value === 'soon' ? '' : 'none';
    } else if (t.dataset.n !== undefined) f[t.dataset.n] = t.value === '' ? null : Number(t.value);
    else if (t.dataset.t !== undefined) f[t.dataset.t] = t.value;
    else if (t.dataset.p !== undefined) {
      f.period.kind = t.value;
      $('#sceDays').style.display = t.value === 'days' ? '' : 'none';
      form.querySelectorAll('.sceRange').forEach((el) => { el.style.display = t.value === 'range' ? '' : 'none'; });
    } else if (t.dataset.pn !== undefined) f.period.days = t.value === '' ? null : Number(t.value);
    else if (t.dataset.pd !== undefined) f.period[t.dataset.pd] = t.value;
    else return;
    touch();
  };
  form.addEventListener('input', (e) => { if (e.target.tagName !== 'SELECT') handle(e); });      // текст, числа, даты — по мере набора
  form.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT') handle(e); });     // списки — по выбору
  form.onsubmit = scSave;
}

function scSchedule() {
  clearTimeout(scEd.timer);
  scEd.timer = setTimeout(scPreview, 350);
}

function scResultHtml(d) {
  const r = d.result;
  return `<div class="sc-num">${scNum(r.count)}</div><div class="sc-unit">${scPlural(r.count, SC_UNITS[r.what])}<br>${esc(scSub(r))}</div>${scBreakdown(r)}
    <details class="sc-cond" open><summary>Условия</summary><ul>${d.summary.map((s) => `<li>${esc(s)}</li>`).join('')}</ul></details>
    <button type="button" class="sc-link" data-show-list style="justify-self:start">Показать комплексы</button><div id="sceList"></div>`;
}

async function scPreview() {
  if (!scEd) return;
  const mine = ++scEd.seq, box = $('#sceResult'), err = $('#sceError');
  try {
    const d = await Api.post('/api/stat-counters/preview', { filters: scEd.f });
    if (!scEd || mine !== scEd.seq || !box) return;
    box.innerHTML = scResultHtml(d);
    err.classList.add('hidden');
  } catch (e) {
    if (!scEd || mine !== scEd.seq || !box) return;
    box.innerHTML = '<p class="sc-muted text-xs">Число появится, когда условия будут заполнены верно.</p>';
    err.textContent = e.message;
    err.classList.remove('hidden');
  }
}

async function scShowInline() {
  const box = $('#sceList');
  if (!box) return;
  box.innerHTML = '<p class="sc-muted text-xs py-2">Загрузка…</p>';
  try {
    const d = await Api.post('/api/stat-counters/points', { filters: scEd.f });
    box.innerHTML = d.rows.length
      ? `<div class="sce-list">${scRowsTable(d, 300)}</div><p class="sc-muted text-xs mt-1">${d.rows.length > 300 ? `Показаны первые 300 из ${scNum(d.rows.length)}. ` : `Комплексов: ${scNum(d.rows.length)}. `}Полный список — в плитке счётчика после сохранения.</p>`
      : '<p class="sc-muted text-xs py-2">Не подходит ни один комплекс.</p>';
  } catch (e) { box.innerHTML = `<p class="text-xs text-rose-400">${esc(e.message)}</p>`; }
}

async function scSave(e) {
  e.preventDefault();
  const err = $('#sceError'), name = (scEd.name || '').trim();
  if (!name) { err.textContent = 'Впишите название счётчика'; err.classList.remove('hidden'); $('#sceName').focus(); return; }
  try {
    if (scEd.id) await Api.put(`/api/stat-counters/${scEd.id}`, { name, filters: scEd.f });
    else await Api.post('/api/stat-counters', { name, filters: scEd.f });
  } catch (ex) { err.textContent = ex.message; err.classList.remove('hidden'); return; }
  clearTimeout(scEd.timer);
  scEd = null;
  close();
  toast('Сохранено');
  await scLoad();
}
