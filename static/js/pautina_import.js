// «Импорт из Паутины»: обновление уже заведённых комплексов из выгрузки другой программы (серверная часть —
// app/services/pautina_import.py). Столбцы ищутся по названию, порядок и количество любые; новых комплексов не создаётся —
// тех, кого нет в системе, видно в окне и в Excel-файле итогов.

function ptCount(n) { return Number(n || 0).toLocaleString('ru-RU'); }

function ptSummaryHtml(r) {
  const row = (label, value, tone = '') => `<div class="flex justify-between gap-3 text-sm"><span class="text-slate-300">${label}</span><b class="${tone}">${value}</b></div>`;
  const parts = [];
  parts.push(`<div class="text-sm mb-2">${r.dry_run ? '<b>Проверка файла</b> — в систему пока ничего не записано.' : '<b class="text-emerald-300">Загрузка выполнена.</b>'} ${esc(r.filename)}</div>`);
  parts.push(`<div class="space-y-1 rounded-xl border border-slate-700/50 bg-slate-900/30 px-3 py-2">
      ${row('Комплексов в файле', ptCount(r.rows_used))}
      ${row('Найдено в системе', ptCount(r.matched))}
      ${row(r.dry_run ? 'Будет обновлено' : 'Обновлено', ptCount(r.dry_run ? r.to_update : r.updated), 'text-emerald-300')}
      ${row('Без изменений (данные уже такие же)', ptCount(r.unchanged))}
      ${row('Нет в системе (не создаются)', ptCount(r.not_found), r.not_found ? 'text-amber-300' : '')}
      ${row('Предупреждений (поле пропущено)', ptCount(r.warnings), r.warnings ? 'text-amber-300' : '')}
    </div>`);
  if (r.columns.length) {
    parts.push(`<div class="mt-3 text-xs text-slate-400">Столбцы файла → поля системы:</div>
      <div class="mt-1 text-xs text-slate-300">${r.columns.map((c) => `«${esc(c.header)}» → <b>${esc(c.label)}</b>`).join(' · ')}</div>`);
  }
  if (r.fields_changed.length) {
    parts.push(`<div class="mt-2 text-xs text-slate-400">${r.dry_run ? 'Изменятся' : 'Изменено'}: ${r.fields_changed.map((f) => `${esc(f.label)} — ${ptCount(f.count)}`).join('; ')}.</div>`);
  }
  if (r.ignored_columns.length) {
    parts.push(`<div class="mt-2 text-xs text-slate-400">В системе нет места для столбцов (не загружены): ${r.ignored_columns.map((h) => `«${esc(h)}»`).join(', ')}.</div>`);
  }
  (r.notes || []).forEach((n) => parts.push(`<div class="mt-2 text-xs text-slate-400">${esc(n)}</div>`));
  if (r.not_found) {
    parts.push(`<div class="mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-100">
      <b>Нет в системе — ${ptCount(r.not_found)}.</b> Например: ${r.not_found_sample.slice(0, 12).map(esc).join(', ')}${r.not_found > 12 ? '…' : ''}.
      Полный список — в файле итогов.</div>`);
  }
  if (r.warnings_sample.length) {
    parts.push(`<details class="mt-2 text-xs text-slate-300"><summary class="cursor-pointer">Предупреждения (${ptCount(r.warnings)})</summary>
      <div class="mt-1 space-y-0.5" style="max-height:140px; overflow:auto">${r.warnings_sample.map((w) => `<div>${esc(w)}</div>`).join('')}${r.warnings > r.warnings_sample.length ? `<div>… и ещё ${r.warnings - r.warnings_sample.length}</div>` : ''}</div></details>`);
  }
  if (r.report_id) {
    parts.push(`<div class="mt-3"><button type="button" id="ptReport" class="${btnGhost} !py-1.5 text-xs">⬇ Скачать итоги импорта (.xlsx)</button>
      <span class="text-[11px] text-slate-500 ml-2">«Итоги», «Не найдены в системе», «Обновлено», «Предупреждения»</span></div>`);
  }
  return parts.join('');
}

async function openPautinaImport() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Импорт из «Паутины»</h2>
    <p class="text-xs text-slate-400 mb-3">Выгрузка комплексов из другой программы (.xlsx). Столбцы ищутся <b>по названию</b>, порядок и количество любые:
      нужен хотя бы один столбец с названием или номером комплекса («Наименование», «Номер», «Комплекс»…), остальные необязательны — например,
      «Сертификат поверки до», «Адрес», «Широта», «Долгота», «IP-адрес», «Порт», «Номер SIM», «Инвентарный номер», «Категория», «Статус».
      Обновляются <b>только комплексы, которые уже есть в системе</b> (регистр и пробелы не важны); пустая ячейка ничего не затирает.
      Тех, кого нет, программа не создаёт, а выписывает в Excel-файл итогов, который можно скачать.</p>
    <form id="ptForm" class="space-y-3">
      <label class="${labelCls}">Файл<input type="file" id="ptFile" accept=".xlsx,.xlsm" class="${fieldCls}"></label>
      <div id="ptResult"></div>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" class="cancel ${btnGhost}">Закрыть</button>
        <button type="button" id="ptCheck" class="${btnGhost}">Проверить файл</button>
        <button type="button" id="ptApply" class="${btnPrimary}" disabled>Загрузить</button>
      </div>
    </form>`, { wide: true });

  const fileInput = $('#ptFile'), result = $('#ptResult'), applyBtn = $('#ptApply'), checkBtn = $('#ptCheck');
  let checked = false;
  const reset = () => { checked = false; applyBtn.disabled = true; applyBtn.textContent = 'Загрузить'; result.innerHTML = ''; };
  fileInput.onchange = reset;

  const send = async (dryRun) => {
    const f = fileInput.files[0];
    if (!f) { alert('Выберите файл .xlsx'); return null; }
    const fd = new FormData();
    fd.append('file', f);
    return Api.upload('/api/pautina/import?dry_run=' + (dryRun ? 'true' : 'false'), fd);
  };
  const show = (r, tone) => {
    result.innerHTML = `<div class="rounded-2xl border ${tone} p-3">${ptSummaryHtml(r)}</div>`;
    const rb = $('#ptReport');
    if (rb) rb.onclick = () => downloadFile('/api/pautina/report/' + encodeURIComponent(r.report_id), 'pautina-import-itogi.xlsx').catch((e) => alert(e.message));
  };
  const showError = (e) => { result.innerHTML = `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">${esc(e.message)}</div>`; };

  checkBtn.onclick = async () => {
    checkBtn.disabled = true; checkBtn.textContent = 'Проверяю…';
    try {
      const r = await send(true);
      if (!r) return;
      show(r, 'border-slate-700/60 bg-slate-800/30');
      checked = r.to_update > 0;
      applyBtn.disabled = !checked;
      applyBtn.textContent = checked ? `Обновить ${ptCount(r.to_update)}` : 'Загрузить';
    } catch (e) { showError(e); applyBtn.disabled = true; } finally { checkBtn.disabled = false; checkBtn.textContent = 'Проверить файл'; }
  };
  applyBtn.onclick = async () => {
    if (!checked) return;
    applyBtn.disabled = true; checkBtn.disabled = true; applyBtn.textContent = 'Обновляю… (несколько секунд на каждую тысячу)';
    try {
      const r = await send(false);
      if (!r) return;
      checked = false;
      show(r, 'border-emerald-500/40 bg-emerald-500/10');
      applyBtn.textContent = 'Загружено';
      if (typeof loadPoints === 'function') await loadPoints();
    } catch (e) { showError(e); applyBtn.disabled = false; applyBtn.textContent = 'Загрузить'; } finally { checkBtn.disabled = false; }
  };
}
