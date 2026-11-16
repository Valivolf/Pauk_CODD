// «История выездов из Excel»: проверка файла (ничего не пишется) → загрузка → при ошибке можно отменить всю загрузку.
// Принимает и «Журнал выездов» (Номер, Статус, Причина, Выполненные работы, Исполнитель, Требуется, Примечания…) как есть — без правки файла;
// выезды, которые уже есть в системе (бот / форма / диспетчер / прежняя загрузка в тот же день), второй раз не создаются.
// Файл: Дата, Кто выезжал, Комплекс, Что было сделано, Статус (+ необязательно «Тип выезда», «Комментарий», «Что неисправно / причина»,
// «Что нужно для восстановления»); серверная часть —
// app/services/visit_history_import.py. Загруженные записи видны в «История выездов» у карточки комплекса.

function vhFmtCount(n) { return Number(n || 0).toLocaleString('ru-RU'); }

function vhSummaryHtml(r) {
  const li = (text) => `<li>${text}</li>`;
  const top = (items, key, limit = 12) => items.slice(0, limit).map((x) => `«${esc(x[key])}» — ${x.count}`).join('; ')
    + (items.length > limit ? ` и ещё ${items.length - limit}` : '');
  const parts = [];
  if (r.dry_run) {
    parts.push(`<div class="text-sm"><b>Проверка файла:</b> строк в файле — ${vhFmtCount(r.rows_read)}. <b class="text-emerald-300">Будет загружено: ${vhFmtCount(r.to_add)}</b>`
      + (r.date_from ? ` (за ${esc(fmtDate(r.date_from))} — ${esc(fmtDate(r.date_to))})` : '') + '.</div>');
  } else {
    parts.push(`<div class="text-sm"><b class="text-emerald-300">Загружено записей: ${vhFmtCount(r.added)}</b>`
      + (r.date_from ? ` (за ${esc(fmtDate(r.date_from))} — ${esc(fmtDate(r.date_to))})` : '') + '.</div>');
  }
  const notes = [];
  if (r.in_system) notes.push(li(`Выезд в тот же день уже есть в системе (отчёт бота, диспетчера или из таблицы Яндекс Форм): ${vhFmtCount(r.in_system)} — второй раз не создаётся. Если в таком отчёте нет причины, «что нужно» или комментария, они берутся из журнала.`));
  if (r.duplicates) notes.push(li(`Уже были загружены раньше и не изменились: ${vhFmtCount(r.duplicates)} — повторно не добавляются.`));
  if (r.enriched) notes.push(li(`<b>${r.dry_run ? 'Будут обновлены / дополнены' : 'Обновлены / дополнены'}</b> уже существующие записи (прежняя загрузка — по журналу; настоящие отчёты — только пустые поля): ${vhFmtCount(r.enriched)}.`));
  if (r.merged) notes.push(li(`${r.dry_run ? 'Будут убраны' : 'Убраны'} записи из журнала, вместо которых теперь есть настоящий отчёт за этот день: ${vhFmtCount(r.merged)} (причина и «что нужно» перенесены в отчёт).`));
  const FOUND = { sim: 'по коду ICC (SIM)', ip: 'по IP-адресу', inventory: 'по инвентарному номеру', address: 'по адресу' };
  const found = Object.entries(r.found_by || {}).filter(([, n]) => n).map(([k, n]) => `${FOUND[k] || k}: ${vhFmtCount(n)}`);
  if (found.length) notes.push(li(`Номера в строке не было или он не нашёлся — комплекс найден ${found.join('; ')}.`));
  if (r.skipped_unknown_points) notes.push(li(`Пропущено — комплекса нет в «Все АПК»: ${vhFmtCount(r.skipped_unknown_points)} строк. Номера: ${top(r.unknown_points, 'point')}. Добавьте эти комплексы или поправьте номера и загрузите файл ещё раз — загруженное не задвоится.`));
  if (r.loose_points) notes.push(li(`Номер распознан без учёта пробелов/дефисов («МЕ 123» = «МЕ-123»): ${vhFmtCount(r.loose_points)} строк.`));
  if (r.unknown_types.length) notes.push(li(`Типа выезда нет в справочнике (подставлен выбранный по умолчанию, написанное сохранено в тексте): ${top(r.unknown_types, 'type')}.`));
  if (r.unknown_statuses.length) notes.push(li(`Статус не распознан (запись загружена без статуса, написанное сохранено в тексте): ${top(r.unknown_statuses, 'status')}.`));
  (r.notes || []).forEach((n) => notes.push(li(esc(n))));
  if (notes.length) parts.push(`<ul class="text-xs text-slate-300 space-y-1 mt-2" style="list-style:disc; padding-left:1.1rem">${notes.join('')}</ul>`);
  if (r.error_count) {
    parts.push(`<div class="mt-2 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"><b>Строки с ошибками (пропущены): ${vhFmtCount(r.error_count)}</b>
      <div class="mt-1" style="max-height:140px; overflow:auto">${r.errors.map((e) => `<div>${esc(e)}</div>`).join('')}${r.error_count > r.errors.length ? `<div>… и ещё ${r.error_count - r.errors.length}</div>` : ''}</div></div>`);
  }
  if (r.dry_run && r.sample.length) {
    parts.push(`<div class="mt-3 text-xs text-slate-400">Так будут выглядеть первые записи:</div>
      <div class="mt-1 rounded-xl border border-slate-700/50 overflow-auto" style="max-height:180px"><table class="w-full text-xs">
        <thead><tr class="text-slate-400 text-left"><th class="px-2 py-1">Дата</th><th class="px-2 py-1">Кто</th><th class="px-2 py-1">Комплекс</th><th class="px-2 py-1">Тип</th><th class="px-2 py-1">Статус</th><th class="px-2 py-1">Что сделано / комментарий</th><th class="px-2 py-1">Из-за чего не работает</th><th class="px-2 py-1">Что нужно</th></tr></thead>
        <tbody>${r.sample.map((s) => `<tr class="border-t border-slate-700/40 align-top"><td class="px-2 py-1 whitespace-nowrap">${esc(fmtDate(s.date))}</td><td class="px-2 py-1">${esc(s.who)}</td><td class="px-2 py-1">${esc(s.point)}</td><td class="px-2 py-1">${esc(s.visit_type)}</td><td class="px-2 py-1">${esc(s.status || '—')}</td><td class="px-2 py-1">${esc(s.comment)}</td><td class="px-2 py-1">${esc(s.fault || '')}</td><td class="px-2 py-1">${esc(s.needs || '')}</td></tr>`).join('')}</tbody>
      </table></div>`);
  }
  return parts.join('');
}

async function openVisitHistoryImport() {
  const types = VISIT_TYPES.filter((t) => t !== AUX_TYPE);
  const defaultType = types.includes('Ремонт') ? 'Ремонт' : (types[0] || '');
  let batches = [];
  try { batches = await Api.get('/api/visit-history/batches'); } catch { /* список прошлых загрузок — не критично */ }

  modal(`<h2 class="font-display text-lg font-bold mb-1">История выездов из Excel</h2>
    <p class="text-xs text-slate-400 mb-3"><b>Журнал выездов можно загружать как есть</b> — лист «Выезды» со столбцами «Номер», «Статус», «Причина», «Выполненные работы», «Исполнитель», «Требуется», «Примечания» (лишнее — «Код ICC», «IP», «Адрес», «Инв. №» и служебные листы — используется только для поиска комплекса или отбрасывается), править его не нужно. Своя таблица: «Дата», «Кто выезжал», «Комплекс», «Что было сделано», «Статус» (и, если нужно, «Тип выезда»); необязательно «Комментарий», «Что неисправно / причина», «Что нужно для восстановления» — они появятся в истории комплекса. Столбцы ищутся по заголовку, порядок любой. Выезд, который в тот же день уже записан (бот, форма, диспетчер или прежняя загрузка), не дублируется.
      Загрузка <b>не меняет</b> текущий статус комплексов и не создаёт заданий — записи появятся в «История выездов» у карточки комплекса и в статистике за свои даты.
      <a href="#" id="vhTemplate" class="text-indigo-300 underline">Скачать шаблон</a></p>
    <form id="vhForm" class="space-y-3">
      <label class="${labelCls}">Файл<input type="file" id="vhFile" accept=".xlsx,.xlsm" class="${fieldCls}"></label>
      <label class="${labelCls}">Тип выезда, если в файле не указан
        <select id="vhType" class="${fieldCls}">${types.map((t) => `<option ${t === defaultType ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select></label>
      <label class="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" id="vhUnknown" class="rounded accent-indigo-500"> Загружать и комплексы, которых ещё нет в «Все АПК» (запись появится у комплекса, когда он будет добавлен)</label>
      <div id="vhResult"></div>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" class="cancel ${btnGhost}">Закрыть</button>
        <button type="button" id="vhCheck" class="${btnGhost}">Проверить файл</button>
        <button type="button" id="vhApply" class="${btnPrimary}" disabled>Загрузить</button>
      </div>
    </form>
    ${batches.length ? `<div class="mt-4 rounded-2xl border border-slate-700/60 bg-slate-800/30 p-3">
      <b class="text-sm block mb-2">Прошлые загрузки</b>
      <div class="space-y-1.5" id="vhBatches">${batches.map((b) => `<div class="flex items-center justify-between gap-2 text-xs">
        <span>${esc(fmtDateTime(b.imported_at))} · записей ${b.count} · за ${esc(fmtDate(b.date_from))} — ${esc(fmtDate(b.date_to))}</span>
        <button type="button" data-vh-undo="${esc(b.batch)}" class="${btnDanger} !py-0.5 !px-2 text-xs">Отменить загрузку</button></div>`).join('')}</div>
    </div>` : ''}`, { wide: true });

  const fileInput = $('#vhFile'), result = $('#vhResult'), applyBtn = $('#vhApply'), checkBtn = $('#vhCheck');
  let checked = false;
  const reset = () => { checked = false; applyBtn.disabled = true; result.innerHTML = ''; };
  fileInput.onchange = reset;
  $('#vhType').onchange = reset;
  $('#vhUnknown').onchange = reset;
  $('#vhTemplate').onclick = (e) => {
    e.preventDefault();
    downloadFile('/api/visit-history/template', 'visit-history-template.xlsx').catch((err) => alert(err.message));
  };

  const send = async (dryRun) => {
    const f = fileInput.files[0];
    if (!f) { alert('Выберите файл .xlsx'); return null; }
    const fd = new FormData();
    fd.append('file', f);
    const q = new URLSearchParams({ dry_run: dryRun ? 'true' : 'false', default_type: $('#vhType').value, allow_unknown_points: $('#vhUnknown').checked ? 'true' : 'false' });
    return Api.upload('/api/visit-history/import?' + q.toString(), fd);
  };

  checkBtn.onclick = async () => {
    checkBtn.disabled = true; checkBtn.textContent = 'Проверяю…';
    try {
      const r = await send(true);
      if (!r) return;
      result.innerHTML = `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-3">${vhSummaryHtml(r)}</div>`;
      checked = r.to_add > 0 || r.enriched > 0 || r.merged > 0;
      applyBtn.disabled = !checked;
      applyBtn.textContent = checked ? (r.to_add ? `Загрузить ${vhFmtCount(r.to_add)}` : `Обновить ${vhFmtCount(r.enriched + r.merged)}`) : 'Загрузить';
    } catch (err) {
      result.innerHTML = `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">${esc(err.message)}</div>`;
      applyBtn.disabled = true;
    } finally { checkBtn.disabled = false; checkBtn.textContent = 'Проверить файл'; }
  };

  applyBtn.onclick = async () => {
    if (!checked) return;
    applyBtn.disabled = true; checkBtn.disabled = true; applyBtn.textContent = 'Загружаю…';
    try {
      const r = await send(false);
      if (!r) return;
      checked = false;
      result.innerHTML = `<div class="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-3">${vhSummaryHtml(r)}
        ${r.batch ? `<div class="mt-2"><button type="button" id="vhUndoNow" class="${btnDanger} !py-1 !px-2 text-xs">Отменить эту загрузку</button></div>` : ''}</div>`;
      const undo = $('#vhUndoNow');
      if (undo) undo.onclick = () => vhUndo(r.batch, true);
      applyBtn.textContent = 'Загружено';
    } catch (err) {
      result.innerHTML = `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300">${esc(err.message)}</div>`;
      applyBtn.disabled = false; applyBtn.textContent = 'Загрузить';
    } finally { checkBtn.disabled = false; }
  };

  document.querySelectorAll('#modal [data-vh-undo]').forEach((btn) => { btn.onclick = () => vhUndo(btn.dataset.vhUndo, false); });
}

async function vhUndo(batch, stayClosed) {
  if (!confirm('Удалить все записи этой загрузки из истории выездов? Остальные записи не затрагиваются.')) return;
  try {
    const r = await Api.del('/api/visit-history/batches/' + encodeURIComponent(batch));
    alert(`Загрузка отменена, удалено записей: ${r.deleted}.`);
    if (stayClosed) close(); else await openVisitHistoryImport();
  } catch (err) { alert(err.message); }
}
