// Склад → вкладка «Импорт из Excel»: загрузка оборудования из таблиц (роутеры, SIM-карты, платы, БП, счётчики, панели…).
// Таблицы у каждого типа свои, поэтому импорт не привязан к шаблону: файлы разбираются, для каждого столбца
// предлагается роль (серийный номер, модель, комплекс, дата монтажа, монтёр, состояние…), всё остальное можно сохранить
// в ДОПОЛНИТЕЛЬНЫЕ ПОЛЯ. Сначала «Проверить» (в базу ничего не пишется), потом «Загрузить».
// Бэкенд: app/api/routes_equipment_import.py, app/services/equipment_import.py. Помощники — equipment.js.

const IMP = {
  files: [],          // выбранные File
  analysis: null,     // ответ /analyze: {sheets, errors, roles}
  cfg: {},            // настройки по листам: ключ «файл::лист»
  statusMap: {},      // значение столбца «статус» (в нижнем регистре) → действие
  mode: 'merge',
  unknown: 'skip',
  checked: false,     // проверка сделана с текущими настройками
  report: null,
  busy: false,
};

const IMP_ROLE_ORDER = ['ignore', 'serial', 'model', 'category', 'point', 'point_inv', 'status', 'person', 'issued_date',
  'installed_date', 'installed_by', 'received_date', 'notes', 'extra', 'serial_of'];

function impReset() {
  Object.assign(IMP, { analysis: null, cfg: {}, statusMap: {}, checked: false, report: null });
}

async function renderImportTab() {
  try { await eqLoadMeta(); } catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p>`; return; }
  $('#content').innerHTML = `
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mb-4">
      <h2 class="font-display text-base font-bold mb-1">Импорт оборудования из Excel</h2>
      <p class="text-xs text-slate-400 mb-3">Выберите файлы Excel (.xlsx) или целую папку с таблицами — например, «Роутеры», «SIM-карты», «Платы». Система сама найдёт строку заголовков и предложит, какой столбец что означает; вы проверите и поправите.
        Серийный номер — главное: по нему оборудование ищется в базе (повторная загрузка того же файла дублей не создаёт). Остальные столбцы (IMEI, № коробки, IP-адрес, «старый роутер»…) сохранятся как дополнительные поля.</p>
      <div class="flex flex-wrap items-center gap-2">
        <label class="${btnGhost} cursor-pointer">📄 Выбрать файлы<input id="impFiles" type="file" accept=".xlsx,.xlsm" multiple hidden></label>
        <label class="${btnGhost} cursor-pointer">📁 Выбрать папку<input id="impDir" type="file" webkitdirectory multiple hidden></label>
        <button id="impAnalyze" class="${btnPrimary}" disabled>Разобрать файлы</button>
        <span id="impFileInfo" class="text-xs text-slate-400"></span>
      </div>
      <div id="impMsg" class="mt-3"></div>
    </section>
    <div id="impBody"></div>`;
  const pick = (list) => {
    IMP.files = [...list].filter((f) => /\.(xlsx|xlsm)$/i.test(f.name) && !f.name.startsWith('~$'));
    impReset();
    const skipped = [...list].filter((f) => /\.xls$/i.test(f.name)).length;
    $('#impFileInfo').textContent = IMP.files.length ? `Выбрано файлов: ${IMP.files.length}` : 'Нет файлов .xlsx';
    $('#impMsg').innerHTML = skipped ? eqNote(`Файлов старого формата .xls: ${skipped} — они не читаются. Откройте их в Excel и сохраните как .xlsx.`, 'warn') : '';
    $('#impAnalyze').disabled = !IMP.files.length;
    $('#impBody').innerHTML = '';
  };
  $('#impFiles').onchange = (e) => pick(e.target.files);
  $('#impDir').onchange = (e) => pick(e.target.files);
  $('#impAnalyze').onclick = impAnalyzeAll;
  if (IMP.analysis) paintImport();
}

function impFormData(extra = {}) {
  const fd = new FormData();
  IMP.files.forEach((f) => fd.append('files', f, f.name));
  Object.entries(extra).forEach(([k, v]) => fd.append(k, v));
  return fd;
}

async function impAnalyze(headerRows) {
  $('#impMsg').innerHTML = eqNote('Читаю файлы…');
  $('#impAnalyze').disabled = true;
  try {
    const res = await Api.upload('/api/equipment/import/xlsx/analyze', impFormData(headerRows ? { header_rows: JSON.stringify(headerRows) } : {}));
    return res;
  } catch (e) {
    $('#impMsg').innerHTML = eqNote(e.message, 'err');
    return null;
  } finally {
    $('#impAnalyze').disabled = false;
  }
}

function impDefaultAction(s) {
  // Подсказка сервера → значение выпадающего списка.
  if (s.action === 'installed') return 'installed';
  if (s.action === 'removed') return 'removed';
  if (s.action === 'state') {
    const st = EQ.meta.statuses.find((x) => x.role === s.role);
    return st ? 'state:' + st.id : 'ignore';
  }
  return 'ignore';
}

function impInitSheet(sh) {
  const columns = {};
  sh.columns.forEach((c) => {
    if (c.role !== 'ignore') columns[c.index] = { role: c.role, field: c.field || '', category: '', model: '' };
  });
  IMP.cfg[sh.key] = {
    enabled: !!sh.enabled, header_row: sh.header_row, category: sh.category || '', model: '', target: sh.target || 'equipment',
    auto_serial: !!sh.auto_serial, serial_prefix: sh.serial_prefix || '', strip_spaces: true, columns, rownum_col: sh.rownum_col,
  };
  Object.entries(sh.status_suggest || {}).forEach(([k, v]) => { if (!(k in IMP.statusMap)) IMP.statusMap[k] = impDefaultAction(v); });
}

async function impAnalyzeAll() {
  const res = await impAnalyze();
  if (!res) return;
  IMP.analysis = res;
  IMP.cfg = {};
  IMP.statusMap = {};
  IMP.checked = false;
  IMP.report = null;
  res.sheets.forEach(impInitSheet);
  $('#impMsg').innerHTML = res.errors.length ? eqNote(res.errors.join('\n'), 'warn') : '';
  paintImport();
}

// ----------------------------------------------------------------------------------------------- листы и столбцы

const impSheet = (key) => IMP.analysis.sheets.find((s) => s.key === key);

function impColHtml(sh, col) {
  const cfg = IMP.cfg[sh.key];
  const c = cfg.columns[col.index] || { role: 'ignore', field: '' };
  const roleOpts = IMP_ROLE_ORDER.map((r) => `<option value="${r}" ${c.role === r ? 'selected' : ''}>${esc(IMP.analysis.roles[r])}</option>`).join('');
  let extra = '';
  if (c.role === 'extra') {
    extra = `<input data-impfield="${col.index}" list="impFieldList" value="${esc(c.field || col.header || '')}" placeholder="Название поля" class="${fieldCls} !py-1 text-xs">`;
  } else if (c.role === 'serial_of') {
    extra = `<input data-impcat="${col.index}" list="impCatList" value="${esc(c.category || '')}" placeholder="Категория" class="${fieldCls} !py-1 text-xs">`;
  }
  const sample = col.sample.slice(0, 3).map((s) => esc(s.length > 24 ? s.slice(0, 23) + '…' : s)).join(' · ');
  return `<tr class="border-b border-slate-800/70 align-top">
    <td class="py-1.5 pr-2 text-xs font-semibold whitespace-nowrap">${esc(col.header || '(без названия)')}</td>
    <td class="py-1.5 pr-2 text-[11px] text-slate-400" style="max-width:260px; overflow-wrap:anywhere">${sample || '<span class="text-slate-600">пусто</span>'}</td>
    <td class="py-1.5 pr-2 text-[11px] text-slate-500 text-center">${col.filled}</td>
    <td class="py-1.5 pr-2"><select data-improle="${col.index}" class="${fieldCls} !py-1 text-xs">${roleOpts}</select></td>
    <td class="py-1.5">${extra}</td></tr>`;
}

function impStatusBlock(sh) {
  const cfg = IMP.cfg[sh.key];
  const statusCols = sh.columns.filter((c) => (cfg.columns[c.index] || {}).role === 'status' && c.distinct);
  if (!statusCols.length) return '';
  const stateOpts = (sel) => ['<option value="ignore"' + (sel === 'ignore' ? ' selected' : '') + '>— не менять —</option>',
    `<option value="installed" ${sel === 'installed' ? 'selected' : ''}>Установлено на комплексе</option>`,
    `<option value="removed" ${sel === 'removed' ? 'selected' : ''}>Снято с комплекса → на склад (дефектное)</option>`,
    ...EQ.meta.statuses.map((s) => `<option value="state:${s.id}" ${sel === 'state:' + s.id ? 'selected' : ''}>Состояние: ${esc(s.name)}</option>`)].join('');
  const rows = statusCols.flatMap((c) => Object.entries(c.distinct).map(([value, n]) => {
    const k = value.toLowerCase();
    if (!(k in IMP.statusMap)) IMP.statusMap[k] = 'ignore';
    return `<div class="flex flex-wrap items-center gap-2 text-xs"><span class="w-56 shrink-0 truncate" title="${esc(value)}"><b>${esc(value)}</b> <span class="text-slate-500">× ${n}</span></span>
      <select data-impstatus="${esc(k)}" class="${fieldCls} !py-1 !w-auto text-xs">${stateOpts(IMP.statusMap[k])}</select></div>`;
  }));
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 mt-3 space-y-1.5">
    <b class="text-xs">Что означают значения столбца «статус»</b>
    <p class="text-[11px] text-slate-500">«Установлено» — оборудование ставится на комплекс из соседнего столбца; «снято» — уходит на склад дефектным и помнит, с какого комплекса.</p>
    ${rows.join('')}</div>`;
}

function impSheetHtml(sh) {
  const cfg = IMP.cfg[sh.key];
  const isPanels = cfg.target === 'panels';
  const notes = (sh.notes || []).map((n) => `<div class="mb-2">${eqNote(n, 'warn')}</div>`).join('');
  const hasSerial = Object.values(cfg.columns).some((c) => c.role === 'serial' || c.role === 'serial_of');
  return `<details data-impsheet="${esc(sh.key)}" class="rounded-2xl border border-slate-700/60 bg-slate-800/20 mb-2" ${cfg.enabled && IMP.analysis.sheets.length <= 3 ? 'open' : ''}>
    <summary class="cursor-pointer px-4 py-2.5 flex flex-wrap items-center gap-3">
      <input type="checkbox" data-impenable class="rounded accent-indigo-500" ${cfg.enabled ? 'checked' : ''} title="Загружать этот лист">
      <b class="text-sm">${esc(sh.file)}</b><span class="text-xs text-slate-400">лист «${esc(sh.sheet)}» · строк с данными: ${sh.data_rows}</span>
      ${cfg.category ? `<span class="text-[11px] rounded-full bg-indigo-500/15 text-indigo-200 px-2 py-0.5">${esc(cfg.category)}</span>` : ''}
      ${hasSerial || cfg.auto_serial ? '' : '<span class="text-[11px] rounded-full bg-amber-500/15 text-amber-300 px-2 py-0.5">нет серийного номера</span>'}
    </summary>
    <div class="px-4" style="padding-bottom:1rem">
      ${notes}
      <div class="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
        <label class="${labelCls}">Куда загружать
          <select data-imptarget class="${fieldCls}"><option value="equipment" ${isPanels ? '' : 'selected'}>Оборудование</option><option value="panels" ${isPanels ? 'selected' : ''}>Солнечные панели</option></select></label>
        <label class="${labelCls}">Категория ${isPanels ? '(не нужна)' : '(если нет столбца)'}
          <input data-impcategory list="impCatList" value="${esc(cfg.category)}" class="${fieldCls}" ${isPanels ? 'disabled' : ''}></label>
        <label class="${labelCls}">Модель ${isPanels ? '(не нужна)' : '(если нет столбца)'}
          <input data-impmodel value="${esc(cfg.model)}" placeholder="по умолчанию «Без модели»" class="${fieldCls}" ${isPanels ? 'disabled' : ''}></label>
        <label class="${labelCls}">Строка заголовков
          <input data-impheader type="number" min="1" value="${cfg.header_row}" class="${fieldCls}"></label>
      </div>
      <div class="flex flex-wrap items-center gap-3 mb-3 text-xs text-slate-300">
        <label class="flex items-center gap-1.5"><input type="checkbox" data-impauto class="rounded accent-indigo-500" ${cfg.auto_serial ? 'checked' : ''}> нет серийных номеров — присвоить автоматически (по порядковому № строки)</label>
        <input data-impprefix value="${esc(cfg.serial_prefix)}" placeholder="префикс номера" style="width:12rem" class="${fieldCls} !py-1 text-xs" ${cfg.auto_serial ? '' : 'disabled'}>
        <label class="flex items-center gap-1.5"><input type="checkbox" data-impstrip class="rounded accent-indigo-500" ${cfg.strip_spaces ? 'checked' : ''}> убирать пробелы внутри номера</label>
      </div>
      <div class="overflow-x-auto"><table class="w-full text-sm">
        <thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60"><th class="py-1.5 pr-2">Столбец</th><th class="py-1.5 pr-2">Что в нём</th><th class="py-1.5 pr-2 text-center">Строк</th><th class="py-1.5 pr-2">Это…</th><th class="py-1.5">Название поля / категория</th></tr></thead>
        <tbody>${sh.columns.filter((c) => c.filled || c.header).map((c) => impColHtml(sh, c)).join('')}</tbody></table></div>
      ${impStatusBlock(sh)}
    </div></details>`;
}

function impInvalidate() {
  IMP.checked = false;
  const run = $('#impRun');
  if (run) run.disabled = true;
}

function impWireSheet(box, sh) {
  const cfg = IMP.cfg[sh.key];
  const q = (sel) => box.querySelector(sel);
  const repaint = () => {
    const open = box.open;
    const tmp = document.createElement('div');
    tmp.innerHTML = impSheetHtml(sh);
    const fresh = tmp.firstElementChild;
    fresh.open = open;
    box.replaceWith(fresh);
    impWireSheet(fresh, sh);
  };
  q('[data-impenable]').onclick = (e) => { e.stopPropagation(); };
  q('[data-impenable]').onchange = (e) => { cfg.enabled = e.target.checked; impInvalidate(); };
  q('[data-imptarget]').onchange = (e) => { cfg.target = e.target.value; impInvalidate(); repaint(); };
  q('[data-impcategory]').oninput = (e) => { cfg.category = e.target.value.trim(); impInvalidate(); };
  q('[data-impmodel]').oninput = (e) => { cfg.model = e.target.value.trim(); impInvalidate(); };
  q('[data-impauto]').onchange = (e) => { cfg.auto_serial = e.target.checked; q('[data-impprefix]').disabled = !e.target.checked; impInvalidate(); };
  q('[data-impprefix]').oninput = (e) => { cfg.serial_prefix = e.target.value.trim(); impInvalidate(); };
  q('[data-impstrip]').onchange = (e) => { cfg.strip_spaces = e.target.checked; impInvalidate(); };
  q('[data-impheader]').onchange = async (e) => {
    const n = Math.max(1, +e.target.value || 1);
    const res = await impAnalyze({ [sh.key]: n });
    if (!res) return;
    const fresh = res.sheets.find((s) => s.key === sh.key);
    if (!fresh) return;
    const idx = IMP.analysis.sheets.findIndex((s) => s.key === sh.key);
    IMP.analysis.sheets[idx] = fresh;
    const keep = { enabled: cfg.enabled, category: cfg.category, model: cfg.model, target: cfg.target };
    impInitSheet(fresh);
    Object.assign(IMP.cfg[sh.key], keep, { header_row: n });
    $('#impMsg').innerHTML = '';
    impInvalidate();
    const tmp = document.createElement('div');
    tmp.innerHTML = impSheetHtml(fresh);
    const el = tmp.firstElementChild;
    el.open = true;
    box.replaceWith(el);
    impWireSheet(el, fresh);
  };
  box.querySelectorAll('[data-improle]').forEach((sel) => {
    sel.onchange = () => {
      const idx = +sel.dataset.improle;
      const role = sel.value;
      const header = sh.columns.find((c) => c.index === idx)?.header || '';
      // Однозначные роли (серийный номер, комплекс…) — у одного столбца: прежний владелец роли сбрасывается.
      if (!['ignore', 'extra', 'serial_of'].includes(role)) {
        Object.entries(cfg.columns).forEach(([k, v]) => { if (+k !== idx && v.role === role) v.role = 'ignore'; });
      }
      if (role === 'ignore') delete cfg.columns[idx];
      else cfg.columns[idx] = { role, field: role === 'extra' ? header : '', category: role === 'serial_of' ? cfg.category : '', model: '' };
      impInvalidate();
      repaint();
    };
  });
  box.querySelectorAll('[data-impfield]').forEach((inp) => { inp.oninput = () => { cfg.columns[+inp.dataset.impfield].field = inp.value.trim(); impInvalidate(); }; });
  box.querySelectorAll('[data-impcat]').forEach((inp) => { inp.oninput = () => { cfg.columns[+inp.dataset.impcat].category = inp.value.trim(); impInvalidate(); }; });
  box.querySelectorAll('[data-impstatus]').forEach((sel) => { sel.onchange = () => { IMP.statusMap[sel.dataset.impstatus] = sel.value; impInvalidate(); }; });
}

// ----------------------------------------------------------------------------------------------- страница

function paintImport() {
  const a = IMP.analysis;
  if (!a) return;
  const sheets = a.sheets;
  $('#impBody').innerHTML = `
    <datalist id="impCatList">${EQ.meta.categories.map((c) => `<option value="${esc(c.name)}">`).join('')}</datalist>
    <datalist id="impFieldList">${(EQ.meta.fields || []).map((f) => `<option value="${esc(f.name)}">`).join('')}</datalist>
    <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
      <b class="text-sm">Найдено листов: ${sheets.length}</b>
      <span class="flex gap-2"><button id="impAll" class="${btnGhost} !py-1 text-xs">Отметить все</button><button id="impNone" class="${btnGhost} !py-1 text-xs">Снять все</button></span>
    </div>
    <div id="impSheets">${sheets.map(impSheetHtml).join('')}</div>
    <section class="rounded-2xl border border-slate-700/60 bg-slate-800/20 p-4 mt-4">
      <div class="grid md:grid-cols-2 gap-3 mb-3">
        <label class="${labelCls}">Если оборудование с таким серийным номером уже есть в базе
          <select id="impMode" class="${fieldCls}">
            <option value="merge" ${IMP.mode === 'merge' ? 'selected' : ''}>Не менять его место и состояние — только дополнить пустое</option>
            <option value="overwrite" ${IMP.mode === 'overwrite' ? 'selected' : ''}>Подтянуть место, состояние и поля из таблицы</option></select></label>
        <label class="${labelCls}">Если комплекс из таблицы не найден в календаре
          <select id="impUnknown" class="${fieldCls}">
            <option value="skip" ${IMP.unknown === 'skip' ? 'selected' : ''}>Пропустить такую строку (список покажу в отчёте)</option>
            <option value="stock" ${IMP.unknown === 'stock' ? 'selected' : ''}>Занести на склад с пометкой «Комплекс по таблице: …»</option></select></label>
      </div>
      <div class="flex flex-wrap gap-2 items-center">
        <button id="impCheck" class="${btnGhost}">Проверить — ничего не записывается</button>
        <button id="impRun" class="${btnPrimary}" disabled>Загрузить в базу</button>
        <span class="text-[11px] text-slate-500">Перед загрузкой можно сделать резервную копию (Настройки → Резервные копии).</span>
      </div>
      <div id="impReport" class="mt-3"></div>
    </section>`;
  $('#impSheets').querySelectorAll('[data-impsheet]').forEach((box) => impWireSheet(box, impSheet(box.dataset.impsheet)));
  const setAll = (v) => {
    sheets.forEach((s) => { IMP.cfg[s.key].enabled = v; });
    $('#impSheets').querySelectorAll('[data-impenable]').forEach((c) => { c.checked = v; });
    impInvalidate();
  };
  $('#impAll').onclick = () => setAll(true);
  $('#impNone').onclick = () => setAll(false);
  $('#impMode').onchange = (e) => { IMP.mode = e.target.value; impInvalidate(); };
  $('#impUnknown').onchange = (e) => { IMP.unknown = e.target.value; impInvalidate(); };
  $('#impCheck').onclick = () => impRun(true);
  $('#impRun').onclick = () => impRun(false);
  if (IMP.report) $('#impReport').innerHTML = impReportHtml(IMP.report);
  $('#impRun').disabled = !IMP.checked;
}

function impConfig() {
  const statusMap = {};
  Object.entries(IMP.statusMap).forEach(([k, v]) => {
    if (v === 'ignore') statusMap[k] = { action: 'ignore' };
    else if (v === 'installed' || v === 'removed') statusMap[k] = { action: v };
    else if (v.startsWith('state:')) statusMap[k] = { action: 'state', state_id: +v.slice(6) };
  });
  return {
    mode: IMP.mode, unknown_point: IMP.unknown, status_map: statusMap,
    sheets: IMP.analysis.sheets.map((s) => {
      const c = IMP.cfg[s.key];
      return {
        file: s.file, sheet: s.sheet, enabled: c.enabled, header_row: c.header_row, category: c.category, model: c.model, target: c.target,
        auto_serial: c.auto_serial, serial_prefix: c.serial_prefix, strip_spaces: c.strip_spaces, rownum_col: c.rownum_col, columns: c.columns,
      };
    }),
  };
}

async function impRun(dry) {
  if (IMP.busy) return;
  const enabled = IMP.analysis.sheets.filter((s) => IMP.cfg[s.key].enabled);
  if (!enabled.length) { $('#impReport').innerHTML = eqNote('Отметьте хотя бы один лист', 'warn'); return; }
  const noSerial = enabled.filter((s) => IMP.cfg[s.key].target !== 'panels' && !IMP.cfg[s.key].auto_serial
    && !Object.values(IMP.cfg[s.key].columns).some((c) => c.role === 'serial' || c.role === 'serial_of'));
  if (noSerial.length) {
    $('#impReport').innerHTML = eqNote('Нет серийного номера на листах:\n' + noSerial.map((s) => `• ${s.file} / ${s.sheet}`).join('\n') + '\nУкажите столбец с номером («Это…» → «Серийный номер»), включите автонумерацию или снимите отметку с листа.', 'warn');
    return;
  }
  if (!dry && !confirm('Загрузить оборудование из таблиц в общую базу? Проверка уже показала, что произойдёт.')) return;
  IMP.busy = true;
  $('#impCheck').disabled = true;
  $('#impRun').disabled = true;
  $('#impReport').innerHTML = eqNote(dry ? 'Проверяю…' : 'Загружаю…');
  try {
    const res = await Api.upload('/api/equipment/import/xlsx/run', impFormData({ config: JSON.stringify(impConfig()), dry_run: dry ? 'true' : 'false' }));
    IMP.report = res;
    IMP.checked = dry;
    $('#impReport').innerHTML = impReportHtml(res);
    if (!dry) { await eqLoadMeta(); IMP.checked = false; }
  } catch (e) {
    $('#impReport').innerHTML = eqNote(e.message, 'err');
    IMP.checked = false;
  } finally {
    IMP.busy = false;
    $('#impCheck').disabled = false;
    $('#impRun').disabled = !IMP.checked;
  }
}

// ----------------------------------------------------------------------------------------------- отчёт

function impReportHtml(r) {
  const t = r.totals || {};
  const chip = (label, n, cls = 'bg-slate-700/50 text-slate-200') => (n ? `<span class="rounded-full ${cls} text-xs px-2.5 py-1">${esc(label)}: <b>${n}</b></span>` : '');
  const sheetRows = r.sheets.map((s) => `<tr class="border-b border-slate-800/70 text-xs">
    <td class="py-1 pr-3">${esc(s.file)} <span class="text-slate-500">/ ${esc(s.sheet)}</span></td>
    <td class="py-1 pr-3 text-center">${s.records}</td><td class="py-1 pr-3 text-center text-emerald-300">${s.created}</td>
    <td class="py-1 pr-3 text-center">${s.updated}</td><td class="py-1 pr-3 text-center text-slate-400">${s.existing}</td>
    <td class="py-1 text-center ${s.skipped ? 'text-amber-300' : 'text-slate-500'}">${s.skipped}</td></tr>`).join('');
  const listObj = (obj, title) => {
    const entries = Object.entries(obj || {});
    if (!entries.length) return '';
    return `<div class="mt-3"><b class="text-xs">${esc(title)}</b><div class="text-xs text-slate-400 mt-1">${entries.map(([k, n]) => `${esc(k)} <span class="text-slate-500">×${n}</span>`).join(' · ')}</div></div>`;
  };
  const created = r.created_names || {};
  const createdLines = [
    created.categories?.length ? `новые категории: ${created.categories.join(', ')}` : '',
    created.fields?.length ? `новые дополнительные поля: ${created.fields.join(', ')}` : '',
    created.states?.length ? `новые состояния: ${created.states.join(', ')}` : '',
  ].filter(Boolean);
  return `<div class="rounded-xl border ${r.dry_run ? 'border-indigo-400/40 bg-indigo-500/10' : 'border-emerald-500/30 bg-emerald-500/10'} p-3">
    <b class="text-sm block mb-2">${r.dry_run ? 'Проверка — в базу ничего не записано. Вот что будет:' : '✅ Загрузка выполнена'}</b>
    <div class="flex flex-wrap gap-1.5 mb-2">
      ${chip('новых единиц', t.created, 'bg-emerald-500/20 text-emerald-200')}${chip('панелей', t.panels_created, 'bg-emerald-500/20 text-emerald-200')}
      ${chip('обновится', (t.updated || 0) + (t.panels_updated || 0))}${chip('уже было', t.existing)}
      ${chip('на комплексах', t.placed_point, 'bg-sky-500/20 text-sky-200')}${chip('у монтёров', t.placed_person, 'bg-amber-500/20 text-amber-200')}${chip('на складе', t.placed_stock)}
      ${chip('расхождений с базой', t.conflicts, 'bg-orange-500/20 text-orange-200')}${chip('пропущено: комплекса нет в календаре', t.skipped_no_point, 'bg-orange-500/20 text-orange-200')}
      ${chip('новых моделей', t.models_created)}${chip('новых категорий', t.categories_created)}${chip('новых полей', t.fields_created)}
    </div>
    ${createdLines.length ? `<p class="text-xs text-slate-400 mb-2">${createdLines.map(esc).join('<br>')}</p>` : ''}
    <div class="overflow-x-auto"><table class="w-full"><thead><tr class="text-left text-xs text-slate-400 border-b border-slate-700/60"><th class="py-1 pr-3">Лист</th><th class="py-1 pr-3 text-center">Строк</th><th class="py-1 pr-3 text-center">Новых</th><th class="py-1 pr-3 text-center">Обновится</th><th class="py-1 pr-3 text-center">Уже было</th><th class="py-1 text-center">Пропущено</th></tr></thead><tbody>${sheetRows}</tbody></table></div>
    ${r.conflict_samples?.length ? `<div class="mt-3"><b class="text-xs text-orange-300">Место в базе отличается от таблицы (${r.mode === 'overwrite' ? 'будет заменено данными таблицы' : 'останется как сейчас'}):</b>
      <div class="text-xs text-slate-400 mt-1">${r.conflict_samples.map((c) => `№${esc(c.serial)}: сейчас «${esc(c.now)}», в таблице «${esc(c.in_file)}»`).join('<br>')}</div></div>` : ''}
    ${listObj(r.unmatched_points, 'Комплексы из таблиц, которых нет в календаре (сколько строк):')}
    ${listObj(r.unmatched_people, 'Фамилии из таблиц, которых нет среди монтёров (оборудование «у монтёра» не записано):')}
    ${r.warnings?.length ? `<div class="mt-3 text-xs text-amber-300 whitespace-pre-line">Предупреждения:\n${r.warnings.slice(0, 40).map(esc).join('\n')}${r.warnings.length > 40 ? '\n…' : ''}</div>` : ''}
  </div>`;
}
