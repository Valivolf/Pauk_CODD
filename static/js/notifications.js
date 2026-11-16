// /notifications — история уведомлений диспетчера: проверки комплексов оператором, решения по запросам монтёров
// («отпустить без ремонта», демонтаж) и отчёты. Отдельно можно выбрать «Нужен повторный выезд» — комплексы, которые
// после выезда не заработали: что неисправно и что нужно для исправления (то, что монтёр написал в боте отдельно от
// отчёта). Лента собирается сервером из существующих данных (app/repositories/notifications_repository.py).
// Отдельная вкладка «Ошибки данных» — дубли точек в днях и одинаковые SIM у нескольких комплексов
// (app/repositories/data_issues_repository.py), с проверками «какой комплекс отвечает».
// $, esc, modal, fmtDateTime, openVisitJournal, openPointWebInterface, pointStatusBadge, btn*, fieldCls приходят из ui.js.
let CURRENT_USER = null;

const pad2n = (n) => String(n).padStart(2, '0');
const isoDay = (d) => `${d.getFullYear()}-${pad2n(d.getMonth() + 1)}-${pad2n(d.getDate())}`;
const daysAgo = (n) => { const d = new Date(); d.setDate(d.getDate() - n); return isoDay(d); };

const NF = { kind: '', from: daysAgo(13), to: isoDay(new Date()), q: '', limit: 100, items: [], total: 0, repeatTotal: 0 };

// Вкладка «Ошибки данных» (NF.kind === 'data'): sub — 'sim' (одинаковые SIM) или 'day' (дубли точек в днях).
// results — результаты пинга/порта по комплексам (живут, пока страница открыта, чтобы сравнивать комплексы в группе).
const DX = {
  sub: 'sim', from: isoDay(new Date()), to: '', q: '', hint: '', acked: false, limit: 50, seq: 0,
  items: [], total: 0, openTotal: 0, ackedTotal: 0, counts: { day: 0, sim: 0, link: 0, total: 0 },
  results: {}, shown: new Set(), pointsById: {}, sel: {}, notice: '', noticeTimer: null,
};
const DX_HINTS = [
  ['', 'Все совпадения'], ['mixed_types', 'Разные типы комплексов (Пульсар и POST…)'], ['diff_ip', 'Разные IP-адреса'],
  ['same_ip', 'Один IP, порты разные'], ['diff_full', 'Полные номера SIM отличаются'], ['gone', 'Есть демонтированный / на складе'],
];

const KIND_ICON = { check: '🔍', decision: '📨', report: '📝' };
const TONE_CLS = {
  ok: 'border-emerald-500/30 bg-emerald-500/10', bad: 'border-rose-500/30 bg-rose-500/10',
  warn: 'border-amber-500/30 bg-amber-500/10', info: 'border-slate-700/50 bg-slate-800/30',
};
const TONE_TEXT = { ok: 'text-emerald-300', bad: 'text-rose-300', warn: 'text-amber-300', info: 'text-slate-300' };

function nfQuery() {
  const p = new URLSearchParams({ limit: String(NF.limit), tz_offset: String(new Date().getTimezoneOffset()) });
  if (NF.kind) p.set('kind', NF.kind);
  if (NF.from) p.set('date_from', NF.from);
  if (NF.to) p.set('date_to', NF.to);
  if (NF.q) p.set('q', NF.q);
  return p.toString();
}

function nfCardHtml(it) {
  const when = fmtDateTime(it.ts, true);
  const resolved = it.resolved_at ? `решено ${fmtDateTime(it.resolved_at, true)}${it.resolved_by ? ' · ' + esc(it.resolved_by) : ''}` : '';
  const who = [it.person, it.crew].filter(Boolean).map(esc).join(' · ');
  const repeat = it.repeat_visit
    ? `<div class="mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs space-y-1">
        <div class="font-semibold text-rose-300">⚠ Комплекс не заработал — нужен повторный выезд</div>
        <div><span class="text-slate-400">Что неисправно:</span> ${it.fault ? `<span style="white-space:pre-wrap">${esc(it.fault)}</span>` : '<span class="text-slate-500">не указано</span>'}</div>
        <div><span class="text-slate-400">Что нужно для исправления:</span> ${it.needs ? `<span style="white-space:pre-wrap">${esc(it.needs)}</span>` : '<span class="text-slate-500">не указано</span>'}</div>
      </div>` : '';
  return `<div class="rounded-2xl border ${TONE_CLS[it.tone] || TONE_CLS.info} px-4 py-3" data-nf="${esc(it.id)}">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-semibold">${KIND_ICON[it.kind] || ''} ${esc(it.title)}</div>
        <div class="text-xs text-slate-400 mt-0.5"><button data-nfpoint="${esc(it.point_id)}" class="text-indigo-300 hover:underline font-semibold">${esc(it.point_id)}</button>${it.point_address ? ' · ' + esc(it.point_address) : ''}</div>
      </div>
      <div class="text-right shrink-0">
        <div class="text-[11px] text-slate-500">${esc(when)}</div>
        <div class="text-xs font-semibold ${TONE_TEXT[it.tone] || ''}">${esc(it.status)}</div>
      </div>
    </div>
    ${it.text ? `<div class="text-xs text-slate-300 mt-1.5" style="white-space:pre-wrap">${esc(it.text)}</div>` : ''}
    ${repeat}
    ${who || resolved ? `<div class="text-[11px] text-slate-500 mt-1.5">${[who, resolved].filter(Boolean).join(' · ')}</div>` : ''}
  </div>`;
}

function nfPaintTabs() {
  document.querySelectorAll('[data-nfkind]').forEach((b) => {
    const active = b.dataset.nfkind === NF.kind;
    b.className = `rounded-xl px-3.5 py-2 text-sm font-medium transition-colors whitespace-nowrap ${active ? 'bg-indigo-500 text-white shadow-lg shadow-indigo-500/25' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300 border border-slate-700'}`;
  });
  const badge = $('#nfRepeatBadge');
  if (badge) badge.textContent = NF.repeatTotal ? ` · ${NF.repeatTotal}` : '';
  const dataBadge = $('#nfDataBadge');
  if (dataBadge) dataBadge.textContent = DX.counts.total ? ` · ${DX.counts.total}` : '';
}

function nfPaint() {
  nfPaintTabs();
  const list = $('#nfList');
  if (!list) return;
  $('#nfSummary').textContent = NF.items.length ? `Показано ${NF.items.length} из ${NF.total}` : '';
  list.innerHTML = NF.items.length
    ? `<div class="space-y-2">${NF.items.map(nfCardHtml).join('')}</div>${NF.items.length < NF.total ? `<div class="text-center pt-3"><button id="nfMore" class="${btnGhost} text-xs">Показать ещё</button></div>` : ''}`
    : '<p class="text-sm text-slate-500 text-center py-8">Уведомлений за выбранный период нет</p>';
  list.querySelectorAll('[data-nfpoint]').forEach((b) => { b.onclick = () => openVisitJournal(b.dataset.nfpoint); });
  if ($('#nfMore')) $('#nfMore').onclick = () => { NF.limit += 100; nfReload(); };
}

async function nfReload() {
  try {
    const res = await Api.get('/api/notifications?' + nfQuery());
    NF.items = res.items; NF.total = res.total; NF.repeatTotal = res.repeat_total;
  } catch (e) {
    $('#nfList').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  nfPaint();
}

const NF_TABS = [
  ['', 'Все'], ['report', '📝 Отчёты'], ['check', '🔍 Проверки'], ['decision', '📨 Решения по запросам'],
  ['repeat', '⚠ Нужен повторный выезд'], ['data', '🧩 Ошибки данных'],
];
const debounce = (fn, ms = 300) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

function renderNotificationsPage() {
  $('#content').innerHTML = `
    <p class="text-xs text-slate-400 mb-3">История того, о чём узнаёт диспетчер: проверки комплексов оператором, решения по запросам монтёров («отпустить без ремонта», демонтаж) и отчёты.
      Раздел «Нужен повторный выезд» — комплексы, которые после выезда не заработали: что неисправно и что нужно для исправления.
      «Ошибки данных» — дубли точек в днях и одинаковые SIM у нескольких комплексов.</p>
    <div class="flex flex-wrap gap-1.5 mb-3">${NF_TABS.map(([k, label]) => `<button data-nfkind="${k}">${label}${k === 'repeat' ? '<span id="nfRepeatBadge"></span>' : ''}${k === 'data' ? '<span id="nfDataBadge"></span>' : ''}</button>`).join('')}</div>
    <div id="nfBody"></div>`;
  document.querySelectorAll('[data-nfkind]').forEach((b) => { b.onclick = () => nfOpenTab(b.dataset.nfkind); });
  return nfOpenTab(NF.kind);
}

function nfOpenTab(kind) {
  NF.kind = kind;
  NF.limit = 100;
  nfPaintTabs();
  return kind === 'data' ? dxRender() : nfRenderFeed();
}

function nfRenderFeed() {
  $('#nfBody').innerHTML = `
    <div class="flex flex-wrap items-center gap-2 mb-2">
      <input id="nfSearch" value="${esc(NF.q)}" placeholder="Комплекс, адрес, текст, фамилия…" class="${fieldCls} flex-1 min-w-[220px]">
      <input id="nfFrom" type="date" value="${esc(NF.from)}" title="С даты" class="${fieldCls} !w-auto">
      <input id="nfTo" type="date" value="${esc(NF.to)}" title="По дату" class="${fieldCls} !w-auto">
      <button data-nfpreset="0" class="${btnGhost} !px-3 text-xs">Сегодня</button>
      <button data-nfpreset="6" class="${btnGhost} !px-3 text-xs">7 дней</button>
      <button data-nfpreset="29" class="${btnGhost} !px-3 text-xs">30 дней</button>
      <button data-nfpreset="all" class="${btnGhost} !px-3 text-xs">За всё время</button>
    </div>
    <div id="nfSummary" class="text-xs text-slate-500 mb-2"></div>
    <div id="nfList"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>`;
  $('#nfSearch').oninput = debounce(() => { NF.q = $('#nfSearch').value.trim(); NF.limit = 100; nfReload(); });
  $('#nfFrom').onchange = (e) => { NF.from = e.target.value; NF.limit = 100; nfReload(); };
  $('#nfTo').onchange = (e) => { NF.to = e.target.value; NF.limit = 100; nfReload(); };
  document.querySelectorAll('[data-nfpreset]').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.nfpreset;
      NF.from = v === 'all' ? '' : daysAgo(+v);
      NF.to = v === 'all' ? '' : isoDay(new Date());
      $('#nfFrom').value = NF.from; $('#nfTo').value = NF.to;
      NF.limit = 100; nfReload();
    };
  });
  return nfReload();
}

// ---------- «Ошибки данных»: одинаковые SIM и дубли точек в днях ----------

const dxDate = (iso) => String(iso || '').split('-').reverse().join('.');
const dxColor = (c) => (/^#[0-9a-fA-F]{3,8}$/.test(c || '') ? c : '#64748b');
const dxBtn = 'rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors';
// Название комплекса: оператору/админу открывает карточку для правки данных (в ней же — «История ремонта»), «только просмотр»
// по-прежнему открывается история.
const dxNameBtn = (id, cls) => `<button ${can('points.edit') ? 'data-dxedit' : 'data-dxjournal'}="${esc(id)}" class="${cls}" title="${can('points.edit') ? 'Данные комплекса и история ремонта' : 'История ремонта'}">${esc(id)}</button>`;

async function dxLoadCounts() {
  try {
    DX.counts = await Api.get('/api/notifications/data-issues/summary?date_from=' + encodeURIComponent(isoDay(new Date())));
  } catch { return; /* бейдж не критичен */ }
  nfPaintTabs();
  dxPaintSubTabs();
}

function dxQuery() {
  const p = new URLSearchParams({ kind: DX.sub, limit: String(DX.limit) });
  if (DX.sub === 'day') {
    if (DX.from) p.set('date_from', DX.from);
    if (DX.to) p.set('date_to', DX.to);
  }
  if (DX.q) p.set('q', DX.q);
  if (DX.sub === 'sim' && DX.hint) p.set('hint', DX.hint);
  if (DX.acked && DX.sub !== 'link') p.set('acked', 'true');
  return p.toString();
}

function dxPaintSubTabs() {
  [['sim', '📶 Одинаковые SIM', DX.counts.sim], ['day', '📅 Дубли точек в днях', DX.counts.day], ['link', '🔗 Связанные комплексы', DX.counts.link]].forEach(([k, label, n]) => {
    const b = document.querySelector(`[data-dxsub="${k}"]`);
    if (!b) return;
    const active = DX.sub === k;
    b.className = `rounded-xl px-3 py-1.5 text-xs font-medium transition-colors whitespace-nowrap ${active ? 'bg-slate-600 text-white' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300 border border-slate-700'}`;
    b.textContent = n ? `${label} · ${n}` : label;
  });
}

const DX_INTRO = {
  sim: `Один номер SIM записан в карточках сразу нескольких комплексов. Это бывает нормой (комплексы в одной сети, доступ по порту — в основном Пульсары),
         а бывает ошибкой в записи. <b>Показаны все совпадения, в том числе с разными портами</b> — у каждого комплекса видны тип, IP и порт.
         Нажмите «Проверить все»: по ответу комплексов видно, где SIM действительно стоит. Подсказки ниже — только справка, решение за вами.
         Если комплексы действительно работают на одной SIM — отметьте их и нажмите <b>«🔗 Связать»</b>: дальше при смене SIM на одном из них номер сам поменяется у остальных.
         Если выяснили, на каком комплексе SIM на самом деле, нажмите у него <b>«✔ Оставить здесь»</b>: SIM и IP останутся у него, а у остальных комплексов группы будут убраны.`,
  day: `Одна и та же точка в один день стоит в нескольких заданиях — дважды в одной бригаде или в разных бригадах. Обычно это ошибка планирования:
         одну из записей нужно убрать или перенести.`,
  link: `Комплексы, связанные общей SIM. Пока они связаны, смена номера SIM на любом из них (в карточке, в боте, при замене в учёте оборудования)
         сразу меняет её и у остальных, а в учёте оборудования SIM остаётся одной записью. Если комплекс перестал делить SIM с остальными — отвяжите его
         (номер SIM у него останется прежним). Очистка номера SIM у комплекса тоже выводит его из связки.`,
};
const DX_SEARCH_PLACEHOLDER = { sim: 'Номер SIM, комплекс, адрес, IP, тип…', day: 'Комплекс, адрес, бригада, фамилия…', link: 'Номер SIM, комплекс, адрес, IP, тип…' };

function dxRender() {
  const sims = DX.sub === 'sim';
  $('#nfBody').innerHTML = `
    <div class="flex flex-wrap gap-1.5 mb-3"><button data-dxsub="sim"></button><button data-dxsub="day"></button><button data-dxsub="link"></button></div>
    <p class="text-xs text-slate-400 mb-3">${DX_INTRO[DX.sub]}</p>
    <div id="dxNotice" class="hidden mb-2 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-300"></div>
    <div class="flex flex-wrap items-center gap-2 mb-2">
      <input id="dxSearch" value="${esc(DX.q)}" placeholder="${DX_SEARCH_PLACEHOLDER[DX.sub]}" class="${fieldCls} flex-1 min-w-[220px]">
      ${DX.sub === 'link' ? '' : sims
        ? `<select id="dxHint" class="${fieldCls} !w-auto" title="Показать только группы с такой особенностью (ничего не скрывается, пока фильтр не выбран)">${DX_HINTS.map(([v, l]) => `<option value="${v}" ${DX.hint === v ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`
        : `<input id="dxFrom" type="date" value="${esc(DX.from)}" title="С даты" class="${fieldCls} !w-auto">
           <input id="dxTo" type="date" value="${esc(DX.to)}" title="По дату" class="${fieldCls} !w-auto">
           <button data-dxpreset="today" class="${btnGhost} !px-3 text-xs">С сегодня</button>
           <button data-dxpreset="past" class="${btnGhost} !px-3 text-xs">Прошлые 30 дней</button>
           <button data-dxpreset="all" class="${btnGhost} !px-3 text-xs">За всё время</button>`}
    </div>
    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
      <div id="dxSummary" class="text-xs text-slate-500"></div>
      ${DX.sub === 'link' ? '' : `<label class="flex items-center gap-1.5 text-xs text-slate-400"><input id="dxAcked" type="checkbox" class="accent-indigo-500" ${DX.acked ? 'checked' : ''}> <span id="dxAckedLabel">Показать отмеченные «считать нормой»</span></label>`}
    </div>
    <div id="dxList"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>`;
  dxPaintSubTabs();
  document.querySelectorAll('[data-dxsub]').forEach((b) => {
    b.onclick = () => { if (DX.sub === b.dataset.dxsub) return; DX.sub = b.dataset.dxsub; DX.limit = 50; DX.acked = false; DX.q = ''; dxRender(); };
  });
  $('#dxSearch').oninput = debounce(() => { DX.q = $('#dxSearch').value.trim(); DX.limit = 50; dxReload(); });
  if ($('#dxHint')) $('#dxHint').onchange = (e) => { DX.hint = e.target.value; DX.limit = 50; dxReload(); };
  if ($('#dxFrom')) $('#dxFrom').onchange = (e) => { DX.from = e.target.value; DX.limit = 50; dxReload(); };
  if ($('#dxTo')) $('#dxTo').onchange = (e) => { DX.to = e.target.value; DX.limit = 50; dxReload(); };
  document.querySelectorAll('[data-dxpreset]').forEach((b) => {
    b.onclick = () => {
      const v = b.dataset.dxpreset;
      DX.from = v === 'today' ? isoDay(new Date()) : v === 'past' ? daysAgo(29) : '';
      DX.to = v === 'past' ? isoDay(new Date()) : '';
      $('#dxFrom').value = DX.from; $('#dxTo').value = DX.to;
      DX.limit = 50; dxReload();
    };
  });
  if ($('#dxAcked')) $('#dxAcked').onchange = (e) => { DX.acked = e.target.checked; DX.limit = 50; dxReload(); };
  $('#dxList').onclick = dxListClick;
  $('#dxList').onchange = dxListChange;
  dxShowNotice();
  dxLoadCounts();
  return dxReload();
}

async function dxReload() {
  const seq = ++DX.seq;
  let res;
  if ($('#dxList')) { if ($('#dxList').querySelector('[data-key], .space-y-2')) setListLoading($('#dxList'), true); else $('#dxList').innerHTML = loadingHtml('Данные загружаются…', 'text-sm text-slate-500 text-center py-8'); }
  try {
    res = await Api.get('/api/notifications/data-issues?' + dxQuery());
  } catch (e) {
    if ($('#dxList')) setListLoading($('#dxList'), false);
    if (seq === DX.seq && $('#dxList')) $('#dxList').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  if (seq !== DX.seq || NF.kind !== 'data' || !$('#dxList')) return;   // пришёл устаревший ответ или вкладку уже сменили
  setListLoading($('#dxList'), false);
  DX.items = res.items; DX.total = res.total; DX.openTotal = res.open_total; DX.ackedTotal = res.acked_total;
  DX.pointsById = {};
  DX.items.forEach((g) => (g.points || []).forEach((p) => { DX.pointsById[p.id] = p; }));
  dxPaint();
}

function dxCategoryBadge(p) {
  if (!p.category_name) return '<span class="text-[11px] text-slate-500">тип не указан</span>';
  const c = dxColor(p.category_color);
  return `<span class="rounded-full px-2 py-0.5 text-[11px] font-semibold" style="background:${c}26;color:${c};border:1px solid ${c}66">${esc(p.category_name)}</span>`;
}

function dxResultHtml(id) {
  const r = DX.results[id];
  if (!r) return '';
  const part = (label, x) => {
    if (!x) return '';
    if (x.pending) return `<span class="text-xs text-slate-400">${label}: …</span>`;
    return `<span class="text-xs ${x.ok ? 'text-emerald-400' : 'text-rose-400'}">${label}: ${x.ok ? '✓' : '✗'} ${esc(x.detail)}</span>`;
  };
  return [part('Пинг', r.ping), part('Порт', r.port)].filter(Boolean).join('<span class="text-slate-600"> · </span>');
}

function dxPaintResult(id) {
  document.querySelectorAll(`[data-dxres="${CSS.escape(id)}"]`).forEach((el) => { el.innerHTML = dxResultHtml(id); });
}

async function dxCheck(id, kind) {
  const r = (DX.results[id] ??= {});
  r[kind] = { pending: true };
  dxPaintResult(id);
  try {
    const res = await Api.get(`/api/points/${encodeURIComponent(id)}/${kind === 'ping' ? 'ping' : 'check-port'}`);
    const latency = res.latency_ms != null ? ` (${Math.round(res.latency_ms)} мс)` : '';
    r[kind] = { ok: !!res.ok, detail: (res.detail || '') + latency };
  } catch (e) {
    r[kind] = { ok: false, detail: 'ошибка: ' + e.message };
  }
  dxPaintResult(id);
}

// «Проверить все»: пинг и порт каждого комплекса группы (не больше 4 проверок одновременно), потом краткий итог по группе.
async function dxCheckAll(key) {
  const g = DX.items.find((x) => x.key === key);
  if (!g) return;
  g.points.forEach((p) => { DX.results[p.id] = { ping: { pending: true }, port: { pending: true } }; dxPaintResult(p.id); });
  const jobs = g.points.flatMap((p) => [() => dxCheck(p.id, 'ping'), () => dxCheck(p.id, 'port')]);
  let next = 0;
  const worker = async () => { while (next < jobs.length) { const job = jobs[next++]; await job(); } };
  await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, worker));
  DX.shown.add(key);
  dxPaintSummary(key);
}

function dxSummaryHtml(g) {
  const got = g.points.filter((p) => DX.results[p.id]?.ping || DX.results[p.id]?.port);
  if (!got.length || got.some((p) => DX.results[p.id].ping?.pending || DX.results[p.id].port?.pending)) return '';
  const ids = (list) => list.map((p) => `<b>${esc(p.id)}</b>`).join(', ');
  const portOk = got.filter((p) => DX.results[p.id].port?.ok);
  const pingOk = got.filter((p) => DX.results[p.id].ping?.ok);
  let tone = 'info';
  let text;
  if (portOk.length === 1) {
    tone = 'ok';
    text = `Порт отвечает только у ${ids(portOk)} — SIM, скорее всего, стоит именно на нём; у остальных номер в карточке стоит проверить.`;
  } else if (portOk.length > 1) {
    text = `Порт отвечает у нескольких комплексов (${ids(portOk)}) — по порту они не различаются (общая сеть либо один и тот же адрес). Сравните вручную через «Зайти».`;
  } else {
    tone = 'warn';
    text = `Порт не отвечает ни у одного комплекса.${pingOk.length ? ` Пинг проходит у: ${ids(pingOk)}.` : ' Пинг тоже не проходит — возможно, SIM сейчас недоступна.'}`;
  }
  return `<div class="mt-2 rounded-xl border ${TONE_CLS[tone]} px-3 py-2 text-xs ${TONE_TEXT[tone]}">🔎 Итог проверки: ${text}</div>`;
}

function dxPaintSummary(key) {
  const g = DX.items.find((x) => x.key === key);
  const el = document.querySelector(`[data-dxsummary="${CSS.escape(key)}"]`);
  if (g && el) el.innerHTML = dxSummaryHtml(g);
}

function dxPointRowHtml(g, p) {
  const holds = g.installed_point && g.installed_point === p.id;
  const selectable = g.kind === 'sim';
  const linkedBadge = p.link_group != null && g.kind === 'sim'
    ? `<span class="rounded-full px-2 py-0.5 text-[11px] font-semibold bg-indigo-500/20 text-indigo-200 border border-indigo-400/30" title="Уже в связке №${esc(p.link_group)} — при связывании связки сольются">🔗 связка №${esc(p.link_group)}</span>` : '';
  return `<div class="px-3 py-2 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0 flex items-start gap-2">
      ${selectable ? `<input type="checkbox" data-dxsel="${esc(g.key)}" value="${esc(p.id)}" ${DX.sel[g.key]?.has(p.id) ? 'checked' : ''} class="mt-1 rounded accent-indigo-500" title="Отметить для связывания">` : ''}
      <div class="min-w-0">
      <div class="flex flex-wrap items-center gap-1.5 text-sm">
        ${dxNameBtn(p.id, 'text-indigo-300 hover:underline font-semibold')}
        ${dxCategoryBadge(p)} ${p.status ? pointStatusBadge(p.status) : ''} ${linkedBadge}
        ${holds ? '<span class="text-[11px] text-slate-400" title="В учёте оборудования эта SIM числится на этом комплексе">🗂 SIM в учёте оборудования</span>' : ''}
      </div>
      ${p.address ? `<div class="text-[11px] text-slate-400">${esc(p.address)}</div>` : ''}
      <div class="text-[11px] text-slate-400">IP: <b class="text-slate-200">${esc(p.ip_address) || '—'}</b> · порт: <b class="text-slate-200">${esc(p.port) || '—'}</b> · SIM в карточке: <b class="text-slate-200">${esc(p.sim_raw)}</b></div>
      </div>
    </div>
    <div class="flex flex-wrap items-center gap-1.5">
      ${g.kind === 'link' ? `<button data-perm="notifications.resolve" data-dxunlinkpt="${esc(p.id)}" class="${dxBtn}" title="Убрать из связки (номер SIM у комплекса останется прежним)">✂ Отвязать</button>` : ''}
      ${g.kind === 'sim' ? `<button data-perm="notifications.resolve" data-dxkeep="${esc(g.key)}" data-dxkeeppt="${esc(p.id)}" class="rounded-lg px-2 py-1 text-xs font-semibold bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/30 text-emerald-200 transition-colors" title="SIM и IP остаются у этого комплекса, у остальных комплексов группы они убираются">✔ Оставить здесь</button>` : ''}
      <button data-perm="points.network" data-dxping="${esc(p.id)}" class="${dxBtn}">📡 Пинг</button>
      <button data-perm="points.network" data-dxport="${esc(p.id)}" class="${dxBtn}">🌐 Порт</button>
      <button data-dxjournal="${esc(p.id)}" class="${dxBtn}" title="История выездов и ремонтов этого комплекса">🕘 История выездов</button>
        <button data-perm="photos.view" data-point-photos="${esc(p.id)}" class="${dxBtn}" title="Фото этого комплекса по дням">📷 Фото</button>
      <button data-perm="points.network" data-dxopen="${esc(p.id)}" class="${dxBtn}" ${p.ip_address ? '' : 'disabled title="У точки не указан IP-адрес"'}>↗ Зайти</button>
      ${g.kind === 'day' ? '' : `<button data-dxmap="${esc(g.key)}" data-dxmappt="${esc(p.id)}" class="${dxBtn}" title="Показать этот комплекс на карте">📍</button>`}
      <span data-dxres="${esc(p.id)}">${dxResultHtml(p.id)}</span>
    </div>
  </div>`;
}

function dxAckButton(g) {
  return g.ack
    ? `<button data-perm="notifications.resolve" data-dxack="${esc(g.key)}" data-dxval="0" class="${dxBtn}" title="Вернуть в основной список">↩ Вернуть в список</button>`
    : `<button data-perm="notifications.resolve" data-dxack="${esc(g.key)}" data-dxval="1" class="${dxBtn}" title="Это не ошибка. Ничего не удаляется; если состав группы изменится, она появится снова">✓ Считать нормой</button>`;
}

function dxSimCardHtml(g) {
  return `<div class="rounded-2xl border ${g.ack ? TONE_CLS.info : TONE_CLS.warn} px-4 py-3" data-dxkey="${esc(g.key)}">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <div class="text-sm font-semibold">📶 SIM …${esc(g.sim)} <span class="text-xs font-normal text-slate-400">· записана у ${g.points.length} комплексов</span></div>
        ${g.installed_point ? `<div class="text-[11px] text-slate-500">В учёте оборудования SIM числится у: ${esc(g.installed_point)}</div>` : ''}
        ${g.ack ? `<div class="text-[11px] text-slate-500">Отмечено как норма: ${esc(g.ack.acked_by)}</div>` : ''}
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button data-perm="points.network" data-dxcheckall="${esc(g.key)}" class="rounded-lg px-2.5 py-1 text-xs font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 transition-colors">🔎 Проверить все</button>
        <button data-dxmap="${esc(g.key)}" class="${dxBtn}" title="Где находятся комплексы этой группы">🗺 На карте</button>
        <button data-dxselall="${esc(g.key)}" class="${dxBtn}">☑ Отметить все</button>
        <button data-perm="notifications.resolve" data-dxlink="${esc(g.key)}" class="${dxBtn}" ${(DX.sel[g.key]?.size || 0) >= 2 ? '' : 'disabled'} title="Связать отмеченные комплексы общей SIM: смена номера на одном меняет его у остальных">🔗 Связать отмеченные (${DX.sel[g.key]?.size || 0})</button>
        ${dxAckButton(g)}
      </div>
    </div>
    ${g.hints.length ? `<div class="mt-2 space-y-0.5 text-xs">${g.hints.map((h) => `<div class="${TONE_TEXT[h.tone] || TONE_TEXT.info}">💡 ${esc(h.text)}</div>`).join('')}</div>` : ''}
    <div class="mt-2 divide-y divide-slate-700/40 rounded-xl border border-slate-700/50">${g.points.map((p) => dxPointRowHtml(g, p)).join('')}</div>
    <div data-dxsummary="${esc(g.key)}">${DX.shown.has(g.key) ? dxSummaryHtml(g) : ''}</div>
  </div>`;
}

function dxLinkCardHtml(g) {
  return `<div class="rounded-2xl border ${g.drift ? TONE_CLS.bad : TONE_CLS.info} px-4 py-3" data-dxkey="${esc(g.key)}">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div>
        <div class="text-sm font-semibold">🔗 Связка №${esc(g.group_id)} · ${g.sim ? `SIM …${esc(g.sim)}` : 'номера SIM расходятся'} <span class="text-xs font-normal text-slate-400">· ${g.points.length} комплексов</span></div>
        <div class="text-[11px] text-slate-500">Смена SIM на любом из них меняет номер у остальных.</div>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button data-perm="points.network" data-dxcheckall="${esc(g.key)}" class="rounded-lg px-2.5 py-1 text-xs font-semibold bg-indigo-500/20 hover:bg-indigo-500/30 border border-indigo-400/30 transition-colors">🔎 Проверить все</button>
        <button data-dxmap="${esc(g.key)}" class="${dxBtn}" title="Где находятся комплексы связки">🗺 На карте</button>
        <button data-perm="notifications.resolve" data-dxunlinkgrp="${esc(g.group_id)}" class="${dxBtn}" title="Разорвать связку целиком (номера SIM у комплексов не меняются)">💔 Разорвать связку</button>
      </div>
    </div>
    ${g.drift ? '<div class="mt-2 text-xs text-rose-300">⚠ Номера SIM у комплексов этой связки не совпадают (их меняли в обход системы). Исправьте номер на любом из комплексов — он применится ко всем — либо разорвите связку.</div>' : ''}
    ${g.hints.length ? `<div class="mt-2 space-y-0.5 text-xs">${g.hints.map((h) => `<div class="${TONE_TEXT[h.tone] || TONE_TEXT.info}">💡 ${esc(h.text)}</div>`).join('')}</div>` : ''}
    <div class="mt-2 divide-y divide-slate-700/40 rounded-xl border border-slate-700/50">${g.points.map((p) => dxPointRowHtml(g, p)).join('')}</div>
    <div data-dxsummary="${esc(g.key)}">${DX.shown.has(g.key) ? dxSummaryHtml(g) : ''}</div>
  </div>`;
}

function dxDayCardHtml(g) {
  const kinds = [g.same_crew ? 'дважды в одной бригаде' : '', g.cross_crew ? 'в разных бригадах' : ''].filter(Boolean).join(' + ');
  const rows = g.tasks.map((t) => `<div class="px-3 py-2 text-xs flex flex-wrap items-start justify-between gap-3">
      <div class="min-w-0"><b>${esc(t.crew_name || 'Бригада №' + t.crew_id)}</b>${t.members.length ? `<span class="text-slate-400"> · ${esc(t.members.join(', '))}</span>` : ''}</div>
      <div class="text-slate-400">${esc(t.type || 'тип не указан')}${t.work ? ' · ' + esc(t.work) : ''}${t.hours ? ' · ' + esc(t.hours) + ' ч' : ''}</div>
      <div class="${t.done ? 'text-emerald-300' : 'text-slate-500'}">${t.done ? 'отчёт сдан' : 'отчёта нет'}</div>
    </div>`).join('');
  return `<div class="rounded-2xl border ${g.ack ? TONE_CLS.info : TONE_CLS.warn} px-4 py-3" data-dxkey="${esc(g.key)}">
    <div class="flex flex-wrap items-start justify-between gap-2">
      <div class="min-w-0">
        <div class="text-sm font-semibold">📅 ${esc(dxDate(g.date))} · ${dxNameBtn(g.point_id, 'text-indigo-300 hover:underline')}
          <span class="text-xs font-normal text-amber-300">· ${esc(kinds)} (${g.tasks.length} задания)</span></div>
        ${g.address ? `<div class="text-[11px] text-slate-400">${esc(g.address)}</div>` : ''}
        ${g.in_directory ? '' : '<div class="text-[11px] text-slate-500">Такой точки нет в справочнике «Все АПК» — возможно, опечатка в номере.</div>'}
        ${g.ack ? `<div class="text-[11px] text-slate-500">Отмечено как норма: ${esc(g.ack.acked_by)}</div>` : ''}
      </div>
      <div class="flex flex-wrap gap-1.5">
        <button data-dxjournal="${esc(g.point_id)}" class="${dxBtn}" title="История выездов и ремонтов этого комплекса">🕘 История выездов</button>
        <button data-perm="photos.view" data-point-photos="${esc(g.point_id)}" class="${dxBtn}" title="Фото этого комплекса по дням">📷 Фото</button>
        <a href="/?date=${esc(g.date)}" class="${dxBtn}" title="Открыть календарь на этом дне">📅 Открыть день</a>
        ${dxAckButton(g)}
      </div>
    </div>
    <div class="mt-2 divide-y divide-slate-700/40 rounded-xl border border-slate-700/50">${rows}</div>
  </div>`;
}

function dxPaint() {
  const list = $('#dxList');
  if (!list) return;
  const linkTab = DX.sub === 'link';
  $('#dxSummary').textContent = DX.items.length
    ? `Показано ${DX.items.length} из ${DX.total} ${DX.acked && !linkTab ? '(отмеченные как норма)' : ''}`
    : '';
  if ($('#dxAckedLabel')) $('#dxAckedLabel').textContent = `Показать отмеченные «считать нормой» (${DX.ackedTotal})`;
  const cardHtml = DX.sub === 'sim' ? dxSimCardHtml : linkTab ? dxLinkCardHtml : dxDayCardHtml;
  const empty = linkTab ? 'Связанных комплексов пока нет — связать можно в списке «Одинаковые SIM»'
    : DX.acked ? 'Отмеченных как норма нет' : `Подозрительных ${DX.sub === 'sim' ? 'групп' : 'дублей'} не найдено`;
  list.innerHTML = DX.items.length
    ? `<div class="space-y-2">${DX.items.map(cardHtml).join('')}</div>${DX.items.length < DX.total ? '<div class="text-center pt-3"><button id="dxMore" class="' + btnGhost + ' text-xs">Показать ещё</button></div>' : ''}`
    : `<p class="text-sm text-slate-500 text-center py-8">${empty}${DX.q || DX.hint ? ' — попробуйте сбросить поиск и фильтр' : ''}</p>`;
}

function dxListClick(e) {
  const b = e.target.closest('button');
  if (!b || b.disabled) return;
  const d = b.dataset;
  if (d.dxping) dxCheck(d.dxping, 'ping');
  else if (d.dxport) dxCheck(d.dxport, 'port');
  else if (d.dxopen) openPointWebInterface(DX.pointsById[d.dxopen]);
  else if (d.dxjournal) openVisitJournal(d.dxjournal);
  else if (d.dxedit) dxEditPoint(d.dxedit);
  else if (d.dxmap) dxOpenMap(d.dxmap, d.dxmappt || '');
  else if (d.dxcheckall) dxCheckAll(d.dxcheckall);
  else if (d.dxkeep) dxKeep(d.dxkeep, d.dxkeeppt);
  else if (d.dxselall) dxSelectAll(d.dxselall);
  else if (d.dxlink) dxLink(d.dxlink);
  else if (d.dxunlinkpt) dxUnlink({ point_id: d.dxunlinkpt }, `Убрать ${d.dxunlinkpt} из связки? Номер SIM у него останется прежним, но с остальными он больше меняться не будет.`);
  else if (d.dxunlinkgrp) dxUnlink({ group_id: +d.dxunlinkgrp }, 'Разорвать связку целиком? Номера SIM у комплексов не изменятся, но менять их вместе они перестанут.');
  else if (d.dxack) dxAck(d.dxack, d.dxval === '1');
  else if (b.id === 'dxMore') { DX.limit += 50; dxReload(); }
}

// ----- карта: где находятся комплексы группы

const dxCoords = (p) => {
  const lat = parseFloat(String(p.lat || '').replace(',', '.'));
  const lon = parseFloat(String(p.lon || '').replace(',', '.'));
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0) ? [lat, lon] : null;
};

// Расстояние между двумя точками, м (формула гаверсинусов).
function dxMeters([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return 6371000 * 2 * Math.asin(Math.min(1, Math.sqrt(a)));
}

const dxDist = (m) => (m < 1 ? 'в одном месте' : m < 1000 ? `${Math.round(m)} м` : `${(m / 1000).toFixed(m < 10000 ? 1 : 0)} км`);

let dxMap = null;                       // ymaps.Map открытого окна
function dxDestroyMap() {
  if (!dxMap) return;
  try { dxMap.destroy(); } catch { /* карта уже уничтожена */ }
  dxMap = null;
}

// Скрипт Яндекс.Карт грузится один раз за сессию страницы (как на «Все АПК»).
let _dxYmaps = null;
function dxLoadYandexMaps(apiKey) {
  if (window.ymaps) return Promise.resolve(window.ymaps);
  if (_dxYmaps) return _dxYmaps;
  _dxYmaps = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `https://api-maps.yandex.ru/2.1/?apikey=${encodeURIComponent(apiKey)}&lang=ru_RU`;
    script.onload = () => window.ymaps.ready(() => resolve(window.ymaps));
    script.onerror = () => { _dxYmaps = null; reject(new Error('Не удалось загрузить Яндекс.Карты — проверьте интернет-соединение и ключ API')); };
    document.head.appendChild(script);
  });
  return _dxYmaps;
}

async function dxOpenMap(key, focusId = '') {
  const g = DX.items.find((x) => x.key === key);
  if (!g || !g.points) return;
  const placed = g.points.map((p) => ({ p, xy: dxCoords(p) }));
  const located = placed.filter((x) => x.xy);
  const missing = placed.filter((x) => !x.xy).map((x) => x.p.id);
  let far = 0;
  located.forEach((a, i) => located.slice(i + 1).forEach((b) => { far = Math.max(far, dxMeters(a.xy, b.xy)); }));
  const title = g.kind === 'link' ? `Связка №${esc(g.group_id)}${g.sim ? ` · SIM …${esc(g.sim)}` : ''}` : `SIM …${esc(g.sim)}`;
  const rows = placed.map(({ p, xy }) => {
    const color = (_pointStatusCache[p.status] && _pointStatusCache[p.status].color) || '#64748b';
    return `<div class="flex flex-wrap items-center gap-2 py-1">
      <span class="inline-block h-2.5 w-2.5 rounded-full shrink-0" style="background:${esc(color)}"></span>
      <b>${esc(p.id)}</b>${p.category_name ? `<span class="text-slate-500">${esc(p.category_name)}</span>` : ''}
      <span class="text-slate-400 min-w-0" style="overflow-wrap:anywhere">${esc(p.address || 'адрес не указан')}</span>
      ${xy ? `<a href="https://yandex.ru/maps/?pt=${xy[1]},${xy[0]}&z=16&l=map" target="_blank" rel="noopener" class="text-indigo-300 hover:underline ml-auto whitespace-nowrap">↗ Яндекс.Карты</a>`
           : '<span class="text-amber-300 ml-auto">координат нет</span>'}
    </div>`;
  }).join('');
  modal(`<h2 class="font-display text-lg font-bold mb-1">Где находятся комплексы · ${title}</h2>
    <p class="text-xs text-slate-400 mb-3">${located.length
      ? (located.length > 1 ? `Комплексов на карте: <b>${located.length}</b>; самые удалённые друг от друга — <b>${esc(dxDist(far))}</b>.` : 'Координаты есть только у одного комплекса.')
      : 'Ни у одного комплекса группы не указаны координаты.'}${missing.length ? ` Без координат: ${esc(missing.join(', '))}.` : ''}
      Метки комплексов с одинаковыми координатами объединены в одну (оранжевую) — нажмите на неё, чтобы увидеть всех.</p>
    <div id="dxMapBox" class="rounded-xl border border-slate-700/50 overflow-hidden" style="height:min(55vh,460px)"></div>
    <div class="mt-3 divide-y divide-slate-700/40 text-xs">${rows}</div>
    <div class="pt-3"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`, { wide: true });
  const box = $('#dxMapBox');
  if (!located.length) { box.innerHTML = '<p class="text-sm text-slate-500 text-center py-10">Нет координат — показывать нечего</p>'; return; }
  const apiKey = document.body.dataset.yandexMapsKey || '';
  if (!apiKey) {
    box.innerHTML = '<p class="text-sm text-amber-300 text-center py-10 px-4">Карта не настроена — добавьте YANDEX_MAPS_API_KEY в .env на сервере и перезапустите приложение. Ниже у каждого комплекса есть ссылка на Яндекс.Карты по его координатам.</p>';
    return;
  }
  box.innerHTML = '<p class="text-sm text-slate-500 text-center py-10">Загружаю карту…</p>';
  let ymaps;
  try {
    ymaps = await dxLoadYandexMaps(apiKey);
  } catch (e) {
    if ($('#dxMapBox')) $('#dxMapBox').innerHTML = `<p class="text-sm text-rose-400 text-center py-10 px-4">${esc(e.message)}</p>`;
    return;
  }
  if (!$('#dxMapBox')) return;                    // окно закрыли, пока грузилась карта
  $('#dxMapBox').innerHTML = '';
  dxDestroyMap();
  dxMap = new ymaps.Map('dxMapBox', { center: located[0].xy, zoom: 15, controls: ['zoomControl', 'fullscreenControl'] });
  // Одна метка на место: комплексы с одинаковыми координатами лежат друг на друге — в выноске показаны все.
  const spots = new Map();
  located.forEach(({ p, xy }) => {
    const k = `${xy[0].toFixed(5)},${xy[1].toFixed(5)}`;
    if (!spots.has(k)) spots.set(k, { xy, pts: [] });
    spots.get(k).pts.push(p);
  });
  let focusMark = null;
  spots.forEach((spot) => {
    const first = spot.pts[0];
    const color = (_pointStatusCache[first.status] && _pointStatusCache[first.status].color) || '#64748b';
    const body = spot.pts.map((p) => `<div style="margin-bottom:6px"><b>${esc(p.id)}</b>${p.category_name ? ' · ' + esc(p.category_name) : ''}<br>${esc(p.address || '')}<br>IP: ${esc(p.ip_address || '—')}${p.port ? ':' + esc(p.port) : ''} · ${esc(p.status || 'не известно')}</div>`).join('');
    const mark = new ymaps.Placemark(spot.xy, {
      hintContent: spot.pts.map((p) => p.id).join(', '),
      balloonContentHeader: spot.pts.length > 1 ? `Комплексов в этом месте: ${spot.pts.length}` : `<b>${esc(first.id)}</b>`,
      balloonContentBody: body,
    }, { preset: 'islands#circleIcon', iconColor: spot.pts.length > 1 ? '#f59e0b' : color });
    dxMap.geoObjects.add(mark);
    if (focusId && spot.pts.some((p) => p.id === focusId)) focusMark = mark;
  });
  if (spots.size === 1) dxMap.setCenter([...spots.values()][0].xy, 16);
  else dxMap.setBounds(dxMap.geoObjects.getBounds(), { checkZoomRange: true, zoomMargin: 40 });
  if (focusMark) focusMark.balloon.open();
}

// ----- правка данных комплекса прямо из вкладки (после сохранения список пересчитывается)

async function dxEditPoint(pointId) {
  let p;
  try {
    try { p = await Api.get(`/api/points/${encodeURIComponent(pointId)}`); } catch { p = null; }      // по точному номеру; поиск — запасной путь
    if (!p) {
      const found = await Api.get(`/api/points?search=${encodeURIComponent(pointId)}&limit=500`);
      p = found.find((x) => x.id === pointId);
    }
  } catch (e) { alert(e.message); return; }
  if (!p) { alert('Комплекс не найден — возможно, его уже переименовали или удалили.'); return; }
  modal(`<div class="flex flex-wrap items-center justify-between gap-2 mb-5">
      <h2 class="font-display text-lg font-bold">АПК ${esc(p.id)}</h2>
      <div class="flex items-center gap-1.5">
        <button type="button" id="dxpJournal" class="${dxBtn}" title="История выездов и ремонтов">🕘 История ремонта</button>
        <button data-perm="photos.view" type="button" data-point-photos="${esc(p.id)}" class="${dxBtn}" title="Фото этого комплекса по дням">📷 Фото</button>
        ${dxCoords(p) ? `<button type="button" id="dxpMap" class="${dxBtn}">🗺 На карте</button>` : ''}
      </div>
    </div>
    <form id="dxpForm" class="space-y-4">
      <label class="${labelCls}">Номер<input name="id" required value="${esc(p.id)}" class="${fieldCls}"></label>
      <label class="${labelCls}">Адрес<input name="address" value="${esc(p.address)}" class="${fieldCls}"></label>
      <label class="${labelCls}">Неисправность / описание<textarea name="description" rows="2" class="${fieldCls}">${esc(p.description)}</textarea></label>
      <label class="${labelCls}">Статус<input name="status" list="dxpStatusOpts" value="${esc(p.status)}" class="${fieldCls}" placeholder="Работает"><datalist id="dxpStatusOpts">${Object.keys(_pointStatusCache).map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
      <div class="relative">
        <label class="${labelCls}">Категория (АПК)<input name="category_name" id="dxpCategoryName" value="${esc(p.category_name)}" autocomplete="off" class="${fieldCls}" placeholder="Начните вводить..."></label>
        <div id="dxpCategoryResults" class="hidden absolute z-10 mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 shadow-xl max-h-48 overflow-auto"></div>
        <div id="dxpCategoryColorRow" class="hidden items-center gap-2 mt-1.5 text-xs text-slate-400">
          <span>Цвет новой категории:</span>
          <input type="color" id="dxpCategoryColor" name="category_color" value="${esc(p.category_color) || '#6366f1'}" class="h-7 w-10 rounded cursor-pointer bg-transparent border border-slate-700">
        </div>
      </div>
      <div id="simLinkNote" class="hidden rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200"></div>
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">Широта<input name="lat" value="${esc(p.lat)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Долгота<input name="lon" value="${esc(p.lon)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Инвентарный номер (серийник)<input name="inventory_number" value="${esc(p.inventory_number)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Номер SIM<input name="sim_number" value="${esc(p.sim_number)}" class="${fieldCls}"></label>
        <label class="${labelCls}">IP-адрес<input name="ip_address" value="${esc(p.ip_address)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Порт<input name="port" value="${esc(p.port)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Логин от веб-интерфейса<input name="login" autocomplete="off" value="${esc(p.login)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Пароль от веб-интерфейса<input name="password" autocomplete="off" value="${esc(p.password)}" class="${fieldCls}"></label>
        <label class="${labelCls}">Сертификат поверки до<input name="verification_valid_until" type="date" value="${esc(p.verification_valid_until)}" class="${fieldCls}"></label>
        ${powerSourceFieldHtml(p.power_source)}
      </div>
      <p class="text-[11px] text-slate-500 -mt-2">Логин/пароль видны только оператору и админу. Если у комплекса общая SIM в связке, новый номер SIM применится ко всей связке.</p>
      <label class="${labelCls}">Примечание<textarea name="notes" rows="2" class="${fieldCls}">${esc(p.notes)}</textarea></label>
      <div id="dxpError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);
  showSimLinkNote(p.id);
  wirePowerSourceField($('#dxpForm'));
  setupCategoryCombobox($('#dxpCategoryName'), $('#dxpCategoryResults'), $('#dxpCategoryColorRow'), $('#dxpCategoryColor')).reset(p.category_name, p.category_color);
  $('#dxpJournal').onclick = () => openVisitJournal(p.id);
  if ($('#dxpMap')) $('#dxpMap').onclick = () => {
    const holder = DX.items.find((g) => (g.points || []).some((x) => x.id === p.id));
    if (holder) dxOpenMap(holder.key, p.id);
  };
  $('#dxpForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    const v = {
      id: f.id.value.trim(), address: f.address.value.trim(), description: f.description.value.trim(),
      lat: f.lat.value.trim(), lon: f.lon.value.trim(), status: f.status.value.trim(),
      inventory_number: f.inventory_number.value.trim(), sim_number: f.sim_number.value.trim(),
      ip_address: f.ip_address.value.trim(), port: f.port.value.trim(), notes: f.notes.value.trim(),
      category_name: f.category_name.value.trim(), category_color: f.category_color.value,
      login: f.login.value.trim(), password: f.password.value.trim(),
      verification_valid_until: f.verification_valid_until.value.trim(),
      power_source: readPowerSource(e.target),
    };
    try {
      await Api.put(`/api/points/${encodeURIComponent(p.id)}`, v);
    } catch (err) {
      $('#dxpError').textContent = err.message;
      $('#dxpError').classList.remove('hidden');
      return;
    }
    close();
    dxShowNotice(`✓ Данные комплекса ${v.id} сохранены.`);
    await dxReload();
    dxLoadCounts();
  };
}

// ----- «Оставить здесь»: SIM и IP остаются у выбранного комплекса, у остальных группы убираются

async function dxKeep(key, pointId) {
  const g = DX.items.find((x) => x.key === key);
  if (!g) return;
  const keep = g.points.find((p) => p.id === pointId);
  const others = g.points.filter((p) => p.id !== pointId);
  if (!keep || !others.length) return;
  const list = others.map((p) => `  • ${p.id}${p.ip_address ? ` (IP ${p.ip_address})` : ''}`).join('\n');
  if (!confirm(`Оставить SIM …${g.sim}${keep.ip_address ? ` и IP ${keep.ip_address}` : ''} на комплексе ${keep.id}?\n\nУ остальных комплексов номер SIM и IP будут УБРАНЫ (порт и остальное не меняются):\n${list}\n\nПрежние значения запишутся в журнал SIM в «Складе». Продолжить?`)) return;
  try {
    const res = await Api.post('/api/notifications/data-issues/keep-sim', { point_id: pointId });
    delete DX.sel[key];
    dxShowNotice(`✓ SIM …${res.sim} и IP оставлены на ${res.kept}. Убраны у: ${res.cleared.map((c) => `${c.id}${c.ip_address ? ` (был IP ${c.ip_address})` : ''}`).join(', ')}.`);
  } catch (err) {
    alert(err.message);
    return;
  }
  await dxReload();
  dxLoadCounts();
}

// ----- связывание комплексов общей SIM

function dxShowNotice(text) {
  if (text !== undefined) {
    DX.notice = text;
    clearTimeout(DX.noticeTimer);
    if (text) DX.noticeTimer = setTimeout(() => { DX.notice = ''; dxShowNotice(); }, 12000);
  }
  const el = $('#dxNotice');
  if (!el) return;
  el.textContent = DX.notice;
  el.classList.toggle('hidden', !DX.notice);
}

function dxSyncLinkButton(key) {
  const n = DX.sel[key]?.size || 0;
  document.querySelectorAll(`[data-dxlink="${CSS.escape(key)}"]`).forEach((b) => {
    b.disabled = n < 2;
    b.textContent = `🔗 Связать отмеченные (${n})`;
  });
}

function dxListChange(e) {
  const cb = e.target.closest('[data-dxsel]');
  if (!cb) return;
  const key = cb.dataset.dxsel;
  const set = (DX.sel[key] ??= new Set());
  if (cb.checked) set.add(cb.value); else set.delete(cb.value);
  dxSyncLinkButton(key);
}

function dxSelectAll(key) {
  const g = DX.items.find((x) => x.key === key);
  if (!g) return;
  const set = (DX.sel[key] ??= new Set());
  const all = g.points.every((p) => set.has(p.id));
  g.points.forEach((p) => { if (all) set.delete(p.id); else set.add(p.id); });
  document.querySelectorAll(`[data-dxsel="${CSS.escape(key)}"]`).forEach((cb) => { cb.checked = set.has(cb.value); });
  dxSyncLinkButton(key);
}

async function dxLink(key) {
  const ids = [...(DX.sel[key] || [])];
  if (ids.length < 2) return;
  if (!confirm(`Связать комплексы: ${ids.join(', ')}?\n\nДальше при смене номера SIM на любом из них он будет меняться и у остальных. Делайте это, только если они действительно работают на одной SIM.`)) return;
  try {
    const res = await Api.post('/api/notifications/data-issues/link', { point_ids: ids });
    delete DX.sel[key];
    dxShowNotice(`✓ Связаны (связка №${res.group_id}): ${res.members.join(', ')}. Теперь смена SIM на одном из них меняет её у остальных.`);
  } catch (err) {
    alert(err.message);
    return;
  }
  await dxReload();
  dxLoadCounts();
}

async function dxUnlink(body, question) {
  if (!confirm(question)) return;
  try {
    await Api.post('/api/notifications/data-issues/unlink', body);
    dxShowNotice('✓ Готово. Номера SIM у комплексов не менялись.');
  } catch (err) {
    alert(err.message);
  }
  await dxReload();
  dxLoadCounts();
}

async function dxAck(key, value) {
  try {
    await Api.post('/api/notifications/data-issues/ack', { kind: DX.sub, key, value });
  } catch (err) {
    alert(err.message);
  }
  await dxReload();
  dxLoadCounts();
}

// ---------- Page chrome: auth guard, user menu, password change ----------

function close() { dxDestroyMap(); editing = false; $('#modal').innerHTML = ''; }

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
  if (!can('notifications.view')) { window.location.href = '/'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  await loadPointStatuses();
  await renderNotificationsPage();
  dxLoadCounts();
  setInterval(() => {
    if (editing || document.hidden || NF.kind === 'data' || document.activeElement === $('#nfSearch')) return;
    nfReload().catch(() => {});
  }, 20000);
  // Счётчик «Ошибок данных» на вкладке; сам список этой вкладки сам не перерисовывается — идущие проверки комплексов не сбиваются.
  setInterval(() => { if (!editing && !document.hidden) dxLoadCounts(); }, 60000);
}
boot();
