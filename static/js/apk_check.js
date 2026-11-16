// /apk → вкладка «Проверка»: вставили список комплексов (по одному названию на строку) — получили по каждому статус, питание, адрес, выезды, почему не работает и что
// нужно для восстановления, а дальше можно выгрузить всё в Excel, выбрав столбцы. Данные считает сервер (app/services/check_service.py) при КАЖДОЙ проверке — повторная
// проверка того же списка всегда показывает актуальное состояние; время проверки видно над списком. $, esc, Api, modal, btn*, fieldCls — из ui.js.
const ApkCheck = { text: '', result: null, filter: 'all', open: new Set(), busy: false, cols: null, seq: 0 };
const CHECK_TEXT_KEY = 'apkCheckText';
const CHECK_COLS_KEY = 'apkCheckCols';

function apkCheckMount(box) {
  try { if (!ApkCheck.text) ApkCheck.text = sessionStorage.getItem(CHECK_TEXT_KEY) || ''; } catch { /* память браузера недоступна */ }
  box.innerHTML = `<div class="space-y-3">
      <div>
        <h2 class="font-display text-lg font-bold">Проверка комплексов</h2>
        <p class="text-xs text-slate-400 mt-0.5">Вставьте названия комплексов: каждое с новой строки. Пробелы внутри названия сохраняются. Можно также указать SIM, IP-адрес или инвентарный номер. Система покажет статус, питание, адрес и выезды; результат можно выгрузить в Excel.</p>
      </div>
      <textarea id="chkText" rows="5" class="${fieldCls}" placeholder="Например:&#10;P-3&#10;P-17 1019771&#10;ARENA-1 +1&#10;10.20.30.40" spellcheck="false">${esc(ApkCheck.text)}</textarea>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="chkRun" class="${btnPrimary}">🔎 Проверить</button>
        <button type="button" id="chkClear" class="${btnGhost}">Очистить</button>
        <span class="text-[11px] text-slate-500">Ctrl+Enter — проверить. До ${500} номеров за раз.</span>
      </div>
      <div id="chkStatus"></div>
      <div id="chkResult"></div>
    </div>`;
  $('#chkText').oninput = (e) => { ApkCheck.text = e.target.value; try { sessionStorage.setItem(CHECK_TEXT_KEY, ApkCheck.text); } catch { /* не страшно */ } };
  $('#chkText').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); apkCheckRun(); } };
  $('#chkRun').onclick = () => apkCheckRun();
  $('#chkClear').onclick = () => { ApkCheck.text = ''; ApkCheck.result = null; $('#chkText').value = ''; try { sessionStorage.removeItem(CHECK_TEXT_KEY); } catch { /* ок */ } apkCheckPaint(); };
  apkCheckPaint();
}

async function apkCheckRun({ silent = false } = {}) {
  const text = (ApkCheck.text || '').trim();
  if (!text) { if (!silent) $('#chkStatus').innerHTML = '<p class="text-sm text-amber-300">Впишите номера комплексов.</p>'; return; }
  if (ApkCheck.busy) return;
  ApkCheck.busy = true;
  const mine = ++ApkCheck.seq;
  if (!silent) $('#chkStatus').innerHTML = '<p class="text-sm text-slate-400">⏳ Проверяю…</p>';
  try {
    const res = await Api.post('/api/check', { text }, { timeoutMs: 120000 });
    if (mine !== ApkCheck.seq) return;
    ApkCheck.result = res;
    $('#chkStatus')?.replaceChildren();
    apkCheckPaint();
  } catch (e) {
    if ($('#chkStatus')) $('#chkStatus').innerHTML = `<p class="text-sm text-rose-300">Не удалось проверить: ${esc(e.message)}</p>`;
  } finally { ApkCheck.busy = false; }
}

// Окно с карточкой закрыли (правка данных комплекса) — пересчитываем проверку, чтобы карточки показывали сохранённое.
function apkCheckAfterClose() {
  clearTimeout(apkCheckAfterClose._t);
  apkCheckAfterClose._t = setTimeout(() => { if (apkTab === 'check' && ApkCheck.result) apkCheckRun({ silent: true }); }, 250);
}

const _chkTime = (iso) => { try { return new Date(iso).toLocaleTimeString('ru-RU'); } catch { return ''; } };
const _chkCopyText = (r) => `${r.point_id}: ${r.summary}`;

function apkCheckCardHtml(r) {
  if (!r.found) {
    return `<div class="rounded-xl border ${r.match === 'ambiguous' ? 'border-amber-500/40' : 'border-rose-500/30'} bg-slate-800/30 p-3 space-y-1" data-chk-card>
      <div class="flex items-center gap-2"><b class="text-sm">${esc(r.query)}</b><span class="text-xs ${r.match === 'ambiguous' ? 'text-amber-300' : 'text-rose-300'}">${r.match === 'ambiguous' ? 'неоднозначно' : 'не найден'}</span></div>
      <div class="text-xs text-slate-400">${esc(r.summary)}</div></div>`;
  }
  const color = (_pointStatusCache[r.status] && _pointStatusCache[r.status].color) || '#64748b';
  const lv = r.last_visit;
  const row = (label, value) => (value ? `<div class="text-xs leading-relaxed"><span class="text-slate-500">${label}:</span> ${value}</div>` : '');
  const down = r.down_since && r.status !== 'Работает' ? ` <span class="text-rose-400">· нет связи с ${esc(r.down_since)}${r.down_days ? `, ${r.down_days} дн.` : ''}</span>` : '';
  const open = ApkCheck.open.has(r.point_id);
  const visits = r.visits.map((v) => `<li class="py-1 border-t border-slate-700/40 first:border-0"><b>${esc(v.date_text)}</b> · ${esc(v.visit_type || 'выезд')}${v.result ? ` · <span class="${v.result === 'Не работает' ? 'text-rose-300' : v.result === 'Работает' ? 'text-emerald-300' : ''}">${esc(v.result)}</span>` : ''}${v.executor ? ` · ${esc(v.executor)}` : ''}${v.crew ? ` · ${esc(v.crew)}` : ''}${v.comment ? `<br><span class="text-slate-400">${esc(v.comment)}</span>` : ''}${v.fault ? `<br><span class="text-amber-300/90">Причина: ${esc(v.fault)}</span>` : ''}${v.needs ? `<br><span class="text-amber-300/90">Нужно: ${esc(v.needs)}</span>` : ''}</li>`).join('');
  const coords = r.lat && r.lon ? `<a class="text-indigo-300 hover:underline" target="_blank" rel="noopener" href="https://yandex.ru/maps/?pt=${encodeURIComponent(r.lon)},${encodeURIComponent(r.lat)}&z=17&l=map">${esc(r.lat)}, ${esc(r.lon)}</a>` : '';
  const net = [r.ip_address ? `IP ${esc(r.ip_address)}${r.port ? ':' + esc(r.port) : ''}` : '', r.sim_number ? `SIM ${esc(r.sim_number)}` : '', r.inventory_number ? `инв. ${esc(r.inventory_number)}` : ''].filter(Boolean).join(' · ');
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 space-y-1.5" data-chk-card="${esc(r.point_id)}">
    <div class="flex flex-wrap items-center justify-between gap-2">
      <span class="flex items-center gap-2 min-w-0"><b class="text-sm">${esc(r.point_id)}</b>${r.category ? colorBadge(r.category, '') : ''}
        ${r.match_text ? `<span class="text-[10px] text-slate-500">(${esc(r.match_text)}; запрос «${esc(r.query)}»)</span>` : ''}${r.duplicate ? '<span class="text-[10px] text-amber-300">повтор в списке</span>' : ''}</span>
      <span class="text-xs font-semibold" style="color:${color}">● ${esc(r.status || 'не известен')}</span>
    </div>
    <div class="text-xs text-slate-400">${esc(r.address || 'адрес не указан')}</div>
    ${row('Статус', `<span style="color:${color}">${esc(r.status || 'не известен')}</span>${down}`)}
    ${row('Питание', esc(r.power_source) || '<span class="text-slate-500">не указано</span>')}
    ${row('Выезды', r.visits_count ? `всего <b>${r.visits_count}</b>, последний <b>${esc(lv.date_text)}</b>${lv.visit_type ? ' · ' + esc(lv.visit_type) : ''}${lv.result ? ` · итог «${esc(lv.result)}»` : ''}${lv.executor ? ' · ' + esc(lv.executor) : ''}` : '<span class="text-slate-500">по отчётам выездов не было</span>')}
    ${r.fault_reason ? `<div class="text-xs leading-relaxed text-amber-300"><b>Почему не работает:</b> ${esc(r.fault_reason)}</div>` : ''}
    ${r.fault_need ? `<div class="text-xs leading-relaxed text-amber-300"><b>Нужно для восстановления:</b> ${esc(r.fault_need)}</div>` : ''}
    ${!r.fault_reason && !r.fault_need && r.status === 'Не работает' ? '<div class="text-xs text-slate-500">Причина в отчётах не указана.</div>' : ''}
    ${r.fault_source ? `<div class="text-[10px] text-slate-500">${esc(r.fault_source)}</div>` : ''}
    ${row('Запланировано', r.planned.map(esc).join('; '))}
    ${row('В плане выездов', r.in_plan ? esc(r.in_plan.text) : '')}
    ${row('Подгруппы', r.groups.map((g) => `📁 ${esc(g.name)}${g.work_type ? ' (' + esc(g.work_type) + ')' : ''}${g.need ? ' — нужно: ' + esc(g.need) : ''}`).join('<br>'))}
    <div class="flex flex-wrap items-center gap-1.5 pt-1">
      <button type="button" data-chk-more="${esc(r.point_id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors">${open ? '▾ Скрыть подробности' : '▸ Подробнее'}</button>
      ${!can('points.edit') ? '' : `<button type="button" data-chk-edit="${esc(r.point_id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Все данные комплекса">✎ Данные</button>`}
      <button type="button" data-chk-journal="${esc(r.point_id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="История выездов">🕘 Выезды</button>
      <button type="button" data-chk-photos="${esc(r.point_id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Фото по дням">📷 Фото</button>
      <button type="button" data-chk-copy="${esc(r.point_id)}" class="rounded-lg px-2 py-1 text-xs bg-slate-700/60 hover:bg-slate-600/60 transition-colors" title="Скопировать сводку по комплексу">📋 Копировать</button>
    </div>
    ${open ? `<div class="rounded-lg bg-slate-900/40 border border-slate-700/40 p-2.5 space-y-1.5">
      ${row('Адрес', esc(r.address))}${row('Категория', esc(r.category))}${row('Связь', net)}${row('Координаты', coords)}${row('Сертификат поверки', esc(r.certificate))}
      ${row('Описание в карточке', esc(r.description))}${row('Примечание', esc(r.notes))}
      ${r.visits.length ? `<div class="text-xs text-slate-500 pt-1">Последние выезды (${r.visits.length}${r.visits_count > r.visits.length ? ' из ' + r.visits_count : ''}):</div><ul class="text-xs">${visits}</ul>` : ''}
    </div>` : ''}
  </div>`;
}

function apkCheckFiltered() {
  const items = (ApkCheck.result && ApkCheck.result.items) || [];
  switch (ApkCheck.filter) {
    case 'bad': return items.filter((i) => i.found && i.status === 'Не работает');
    case 'ok': return items.filter((i) => i.found && i.status === 'Работает');
    case 'other': return items.filter((i) => i.found && i.status !== 'Работает' && i.status !== 'Не работает');
    case 'missing': return items.filter((i) => !i.found);
    default: return items;
  }
}

function apkCheckPaint() {
  const box = $('#chkResult');
  if (!box) return;
  const res = ApkCheck.result;
  if (!res) { box.innerHTML = ''; return; }
  const st = res.stats;
  const chip = (id, label, n) => `<button type="button" data-chk-filter="${id}" class="rounded-full px-3 py-1 text-xs border transition-colors ${ApkCheck.filter === id ? 'border-indigo-400 bg-indigo-500/25 font-semibold' : 'border-slate-700 bg-slate-800/60 hover:bg-slate-700/60'}">${label} · ${n}</button>`;
  const other = st.found - st.working - st.not_working;
  const list = apkCheckFiltered();
  box.innerHTML = `<div class="space-y-3">
      <div class="rounded-xl border border-slate-700/40 bg-slate-800/20 px-3 py-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span class="text-sm">Проверено: <b>${st.total}</b> · найдено <b>${st.found}</b>${st.missing ? ` · <span class="text-rose-300">не найдено ${st.missing}</span>` : ''}${st.ambiguous ? ` · <span class="text-amber-300">неоднозначно ${st.ambiguous}</span>` : ''}</span>
        <span class="text-xs text-slate-400">данные на ${esc(_chkTime(res.checked_at))}</span>
        <span class="ml-auto flex flex-wrap items-center gap-2">
          <button type="button" id="chkRefresh" class="${btnGhost} !py-1 !px-2.5 text-xs" title="Прочитать данные из системы заново">🔄 Проверить заново</button>
          <button type="button" id="chkExcel" class="rounded-lg px-3 py-1 text-xs font-semibold bg-emerald-500/20 text-emerald-300 hover:bg-emerald-500/30 transition-colors">📥 Выгрузить в Excel…</button>
        </span>
      </div>
      ${res.truncated ? `<p class="text-xs text-amber-300">В списке больше ${res.max_items} номеров — проверены первые ${res.max_items}.</p>` : ''}
      <div class="flex flex-wrap items-center gap-2">
        ${chip('all', 'Все', st.total)}${chip('bad', 'Не работают', st.not_working)}${chip('ok', 'Работают', st.working)}${other > 0 ? chip('other', 'Другой статус', other) : ''}${chip('missing', 'Не найдены', st.missing + st.ambiguous)}
      </div>
      <div class="grid grid-cols-1 lg:grid-cols-2 gap-3">${list.map(apkCheckCardHtml).join('') || '<p class="text-sm text-slate-500 py-4">В этой подборке пусто.</p>'}</div>
    </div>`;
  box.querySelectorAll('[data-chk-filter]').forEach((b) => { b.onclick = () => { ApkCheck.filter = b.dataset.chkFilter; apkCheckPaint(); }; });
  $('#chkRefresh').onclick = () => apkCheckRun();
  $('#chkExcel').onclick = apkCheckExcelDialog;
  box.querySelectorAll('[data-chk-more]').forEach((b) => { b.onclick = () => { const id = b.dataset.chkMore; if (ApkCheck.open.has(id)) ApkCheck.open.delete(id); else ApkCheck.open.add(id); apkCheckPaint(); }; });
  box.querySelectorAll('[data-chk-edit]').forEach((b) => { b.onclick = () => apkPointForm(b.dataset.chkEdit); });
  box.querySelectorAll('[data-chk-journal]').forEach((b) => { b.onclick = () => openVisitJournal(b.dataset.chkJournal); });
  box.querySelectorAll('[data-chk-photos]').forEach((b) => { b.onclick = () => openPointPhotos(b.dataset.chkPhotos); });
  box.querySelectorAll('[data-chk-copy]').forEach((b) => {
    b.onclick = async () => {
      const r = ApkCheck.result.items.find((x) => x.point_id === b.dataset.chkCopy);
      if (!r) return;
      try { await navigator.clipboard.writeText(_chkCopyText(r)); b.textContent = '✓ Скопировано'; setTimeout(() => { b.textContent = '📋 Копировать'; }, 1500); }
      catch { prompt('Скопируйте сводку:', _chkCopyText(r)); }
    };
  });
}

// ---------- выгрузка в Excel с выбором столбцов
async function apkCheckExcelDialog() {
  if (!ApkCheck.result) return;
  let cols;
  try { cols = await Api.get('/api/check/columns'); } catch (e) { alert(e.message); return; }
  let chosen;
  try { chosen = JSON.parse(localStorage.getItem(CHECK_COLS_KEY) || 'null'); } catch { chosen = null; }
  const known = new Set(cols.map((c) => c.key));
  const picked = new Set((Array.isArray(chosen) ? chosen : cols.filter((c) => c.default).map((c) => c.key)).filter((k) => known.has(k)));
  const st = ApkCheck.result.stats;
  modal(`<h2 class="font-display text-lg font-bold mb-1">Выгрузка в Excel</h2>
    <p class="text-xs text-slate-400 mb-3">Строк в файле: ${st.total} (по одной на каждый номер из списка; не найденные — тоже, с пометкой). Отметьте данные, которые нужны, — столбцы идут в таком же порядке, как ниже. Данные при выгрузке читаются из системы заново.</p>
    <div class="flex flex-wrap items-center gap-2 mb-2">
      <button type="button" id="chkColsAll" class="${btnGhost} !py-1 !px-2.5 text-xs">Выбрать всё</button>
      <button type="button" id="chkColsNone" class="${btnGhost} !py-1 !px-2.5 text-xs">Снять всё</button>
      <button type="button" id="chkColsDef" class="${btnGhost} !py-1 !px-2.5 text-xs">По умолчанию</button>
      <span id="chkColsCount" class="text-xs text-slate-400 ml-auto"></span>
    </div>
    <div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1 max-h-[46vh] overflow-auto pr-1 mb-3" id="chkColsList">
      ${cols.map((c) => `<label class="flex items-center gap-2 text-sm py-0.5"><input type="checkbox" data-chk-col="${esc(c.key)}" class="rounded accent-indigo-500" ${picked.has(c.key) ? 'checked' : ''}> ${esc(c.label)}</label>`).join('')}
    </div>
    <div id="chkColsError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 mb-2"></div>
    <div class="flex items-center gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button type="button" id="chkColsGo" class="${btnPrimary}">Скачать Excel</button></div>`);
  const boxes = () => [...document.querySelectorAll('[data-chk-col]')];
  const count = () => { $('#chkColsCount').textContent = `Выбрано столбцов: ${boxes().filter((b) => b.checked).length} из ${cols.length}`; };
  const setAll = (fn) => { boxes().forEach((b) => { b.checked = fn(b.dataset.chkCol); }); count(); };
  $('#chkColsAll').onclick = () => setAll(() => true);
  $('#chkColsNone').onclick = () => setAll(() => false);
  $('#chkColsDef').onclick = () => setAll((k) => cols.find((c) => c.key === k).default);
  boxes().forEach((b) => { b.onchange = count; });
  count();
  $('#chkColsGo').onclick = async (e) => {
    const keys = boxes().filter((b) => b.checked).map((b) => b.dataset.chkCol);
    if (!keys.length) { $('#chkColsError').textContent = 'Отметьте хотя бы один столбец.'; $('#chkColsError').classList.remove('hidden'); return; }
    try { localStorage.setItem(CHECK_COLS_KEY, JSON.stringify(keys)); } catch { /* не страшно */ }
    e.target.disabled = true;
    e.target.textContent = 'Готовим файл…';
    try {
      const res = await fetch('/api/check/export', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: ApkCheck.text, columns: keys }) });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (!res.ok) {
        let msg = res.statusText;
        try { msg = (await res.json()).detail || msg; } catch { /* не JSON */ }
        throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
      }
      const blob = await res.blob();
      const name = decodeURIComponent((/filename\*=UTF-8''([^;]+)/.exec(res.headers.get('Content-Disposition') || '') || [])[1] || 'proverka.xlsx');
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(link.href), 5000);
      close();
    } catch (err) {
      $('#chkColsError').textContent = 'Не удалось выгрузить: ' + err.message;
      $('#chkColsError').classList.remove('hidden');
      e.target.disabled = false;
      e.target.textContent = 'Скачать Excel';
    }
  };
}
