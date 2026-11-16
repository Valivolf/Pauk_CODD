// «Документы → Отчёты и история выездов → Отчёты из таблицы Яндекс Форм…» (app/services/forms_import.py).
// 1) загрузить таблицу ответов формы и «Проверить» — по номеру комплекса ищется отчёт за эту дату (есть — строка пропускается)
//    и задание (±1 день), ничего не пишется;
// 2) «Загрузить» — отчёты создаются по ВСЕМ остальным строкам (у задания — оно становится выполненным; без задания — в историю
//    комплекса), статус комплекса по умолчанию не меняется; фото по ссылкам скачиваются сами, фоном: через браузер робота карт, потому
//    что файлы формы открываются только её создателю; если в папке комплекса за эту дату фото уже есть — пропускаются;
// 3) «Фото загруженных ранее…» — докачать/повторить скачивание вручную.
// Подключается после ui.js; на странице должны быть close() и #modal.
const FI_ACTIONS = {
  create: ['отчёт по заданию', 'text-emerald-300'], created: ['отчёт создан, задание выполнено', 'text-emerald-300'],
  create_free: ['отчёт без задания', 'text-sky-300'], created_free: ['отчёт создан (без задания)', 'text-sky-300'],
  exists: ['за эту дату отчёт уже есть', 'text-slate-400'], done_before: ['уже загружено раньше', 'text-slate-400'],
  duplicate: ['повтор (отчёт уже есть)', 'text-slate-400'],
  no_point: ['комплекс не найден', 'text-rose-300'], ambiguous: ['неоднозначно', 'text-rose-300'], error: ['ошибка', 'text-rose-300'],
};
let _fiTimer = null;
let _fiAiTimer = null;

function _fiClock(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}:\d{2})/.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]} ${m[4]}` : String(iso || '');
}

function openFormsImport() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Отчёты из таблицы Яндекс Форм</h2>
    <p class="text-xs text-slate-400 mb-3">Загрузите таблицу ответов формы (.xlsx). По номеру комплекса (название отбрасывается, сравниваются цифры) программа добавит отчёты по <b>всем</b> строкам:
      если по комплексу за дату из формы отчёт уже есть (бот, диспетчер, журнал, прошлая загрузка) — строка пропускается; если на комплекс было задание в пределах ±1 дня — отчёт создаётся по нему от имени бригады
      и задание становится <b>выполненным</b>; если задания не было — отчёт записывается в историю комплекса. Фото по ссылкам скачиваются сами, сразу после загрузки; если в папке комплекса за эту дату фото уже есть — они пропускаются.</p>
    <div class="space-y-3">
      <input type="file" id="fiFile" accept=".xlsx,.xlsm" class="${fieldCls}">
      <label class="flex items-start gap-2 text-xs text-slate-300"><input type="checkbox" id="fiStatus" class="rounded accent-indigo-500 mt-0.5">
        <span>Менять статус комплекса по итогу отчёта («Восстановлен» → «Работает» и т. п.). Обычно не нужно: отчёты запоздалые, а статус комплекса и так проверяется автоматически.</span></label>
      <div id="fiMsg" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div id="fiResult"></div>
      <div id="fiAi" class="rounded-xl border border-slate-700/60 bg-slate-800/30 px-3 py-2.5 text-xs space-y-1.5"><span class="text-slate-500">🤖 Загружаю состояние ИИ-разбора…</span></div>
    </div>
    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button type="button" id="fiCheck" class="${btnPrimary}">Проверить</button>
      <button type="button" id="fiApply" class="${btnPrimary} hidden">Загрузить отчёты и фото</button>
      <button type="button" id="fiPhotos" class="${btnGhost}" title="Строки ранее загруженных таблиц: скачать фото по ссылкам">📷 Фото загруженных ранее…</button>
    </div>`, { wide: true });

  let lastFile = null;
  let lastRows = [];
  const msg = (text) => { const m = $('#fiMsg'); m.textContent = text || ''; m.classList.toggle('hidden', !text); };
  const send = async (dry) => {
    const f = $('#fiFile').files[0] || lastFile;
    if (!f) { msg('Выберите файл с таблицей.'); return null; }
    lastFile = f;
    const fd = new FormData();
    fd.append('file', f);
    fd.append('dry_run', dry ? 'true' : 'false');
    fd.append('apply_status', $('#fiStatus').checked ? 'true' : 'false');
    if (!dry) fd.append('only_json', JSON.stringify([...document.querySelectorAll('#fiResult [data-fi-row]:checked')].map((c) => c.dataset.fiRow)));
    return Api.upload('/api/forms-import/import', fd);
  };
  const render = (res) => {
    const s = res.summary || {};
    lastRows = res.rows;
    const chips = Object.entries(FI_ACTIONS).filter(([k]) => s[k]).map(([k, [label, cls]]) => `<span class="${cls}">${s[k]} — ${label}</span>`).join(' · ');
    $('#fiResult').innerHTML = `<div class="text-xs mb-2">Строк в таблице: <b>${s.total || 0}</b>${chips ? ' · ' + chips : ''}${s.photos ? ` · фото по ссылкам: <b>${s.photos}</b>` : ''}${s.split ? ` · ячейки с несколькими комплексами поделены, получено строк: <b>${s.split}</b>` : ''}</div>
      ${(res.errors || []).length ? `<div class="text-[11px] text-amber-200/90 mb-2">${res.errors.slice(0, 6).map(esc).join('<br>')}</div>` : ''}
      <div class="rounded-xl border border-slate-700/60 overflow-auto" style="max-height:48vh">
      <table class="w-full text-xs">
        <thead class="bg-slate-800/70 text-slate-400"><tr>
          <th class="px-2 py-1.5 text-left" style="width:28px">${res.dry_run ? '<input type="checkbox" id="fiAllRows" class="rounded accent-indigo-500" checked>' : ''}</th>
          <th class="px-2 py-1.5 text-left">Время</th><th class="px-2 py-1.5 text-left">Номер в форме → комплекс</th>
          <th class="px-2 py-1.5 text-left">Бригада</th><th class="px-2 py-1.5 text-left">Что будет</th><th class="px-2 py-1.5 text-left">Итог из формы</th></tr></thead>
        <tbody>${res.rows.map((r) => {
          const [label, cls] = FI_ACTIONS[r.action] || [r.action, ''];
          const canPick = res.dry_run && (r.action === 'create' || r.action === 'create_free');
          return `<tr class="border-t border-slate-700/40 align-top">
            <td class="px-2 py-1.5">${canPick ? `<input type="checkbox" data-fi-row="${esc(r.hash)}" class="rounded accent-indigo-500" checked>` : ''}</td>
            <td class="px-2 py-1.5 whitespace-nowrap">${esc(_fiClock(r.time))}</td>
            <td class="px-2 py-1.5"><span class="text-slate-400">${esc(r.raw_point)}</span>${r.part ? ` <span class="rounded-full bg-indigo-500/20 text-indigo-200 text-[10px] px-1.5" title="В одной ячейке было несколько комплексов: строка поделена, описание и фото те же">часть ${esc(r.part)}</span>` : ''}${r.point_id ? ` → <b>${esc(r.point_id)}</b>` : ''}${r.task ? `<div class="text-[11px] text-slate-500">задание ${esc(fmtDate(r.task.date))} · ${esc(r.task.type)}${r.task.crew ? ' · ' + esc(r.task.crew) : ''}</div>` : ''}</td>
            <td class="px-2 py-1.5">${esc(r.crew_text)}${r.task && r.task.crew && !r.task.crew_hit ? '<div class="text-[11px] text-amber-300">не совпала с бригадой задания</div>' : ''}</td>
            <td class="px-2 py-1.5"><span class="${cls}">${esc(label)}</span>${r.note ? `<div class="text-[11px] text-slate-500">${esc(r.note)}</div>` : ''}${r.existing ? `<div class="text-[11px] text-slate-500">сдал: ${esc(r.existing.by || '—')}${r.existing.status ? ' · ' + esc(r.existing.status) : ''}</div>` : ''}</td>
            <td class="px-2 py-1.5" style="white-space:pre-wrap; overflow-wrap:anywhere; max-width:260px">${esc(r.status_text)}${r.status_text && r.result_text ? ' — ' : ''}${esc(r.result_text)}${r.photos ? ` <span class="text-slate-500">· 📷 ${r.photos}</span>` : ''}</td></tr>`;
        }).join('')}</tbody></table></div>`;
    const all = $('#fiAllRows');
    if (all) all.onchange = () => document.querySelectorAll('#fiResult [data-fi-row]').forEach((c) => { c.checked = all.checked; });
  };

  $('#fiCheck').onclick = async () => {
    msg('');
    $('#fiCheck').disabled = true; $('#fiCheck').textContent = 'Проверяю…';
    try {
      const res = await send(true);
      if (!res) return;
      render(res);
      const n = (res.summary || {}).to_create || 0;
      $('#fiApply').classList.toggle('hidden', !n);
      $('#fiApply').textContent = `Загрузить отчёты и фото (${n})`;
      if (!n) msg('Создавать нечего: по всем строкам отчёты за эти даты уже есть или комплекс не найден. Фото загруженных ранее можно докачать кнопкой «📷 Фото загруженных ранее…».');
    } catch (e) { msg(e.message); } finally { $('#fiCheck').disabled = false; $('#fiCheck').textContent = 'Проверить'; }
  };
  $('#fiApply').onclick = async () => {
    const picked = document.querySelectorAll('#fiResult [data-fi-row]:checked').length;
    if (!picked) { msg('Отметьте хотя бы одну строку.'); return; }
    if (!confirm(`Создать отчётов: ${picked}? Задания, по которым они создаются, станут выполненными; фото начнут скачиваться сами.`)) return;
    msg('');
    $('#fiApply').disabled = true; $('#fiApply').textContent = 'Создаю…';
    try {
      const res = await send(false);
      if (!res) return;
      render(res);
      $('#fiApply').classList.add('hidden');
      $('#fiResult').insertAdjacentHTML('afterbegin', `<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-xs text-emerald-200 mb-2">
        Создано отчётов: <b>${res.created + res.created_free}</b> — по заданиям <b>${res.created}</b> (задания выполнены), без задания <b>${res.created_free}</b> (в истории комплекса).
        <div id="fiPhotoLine" class="mt-1"></div></div>`);
      $('#fiPhotos').dataset.batch = res.batch;
      watchPhotos(res.photos || {});
    } catch (e) { msg(e.message); } finally { $('#fiApply').disabled = false; }
  };
  // Фото качаются сами: показываем ход, пока идёт задание, и итог (скачано / пропущено — уже есть в папке / ошибки).
  const watchPhotos = (job) => {
    const line = () => $('#fiPhotoLine');
    const skipped = (j) => (j.skipped ? ` Пропущено (в папке комплекса за эту дату фото уже есть): ${j.skipped}.` : '');
    const show = (j) => {
      const el = line();
      if (!el) return false;
      if (j.running) { el.textContent = `📷 Скачиваю фото: ${j.done + j.failed} из ${j.total}${j.current ? ' · ' + j.current : ''}${j.failed ? ` · ошибок: ${j.failed}` : ''}.${skipped(j)}`; return true; }
      if (j.started === false && j.reason) { el.textContent = `📷 ${j.reason}`; return false; }
      el.textContent = `📷 Фото: скачано ${j.done} из ${j.total}${j.failed ? `, ошибок: ${j.failed}${j.error ? ' — ' + j.error : ''} (повторить — «📷 Фото загруженных ранее…»; причину покажет «Настройки → Яндекс Формы: вход и автозагрузка → Проверить скачивание»)` : ''}.${skipped(j)}`;
      return false;
    };
    clearInterval(_fiTimer);
    if (!show(job)) return;
    _fiTimer = setInterval(async () => {
      if (!line()) { clearInterval(_fiTimer); return; }
      try {
        const j = await Api.get('/api/forms-import/photos/status');
        if (!show(j)) clearInterval(_fiTimer);
      } catch { /* следующий опрос */ }
    }, 1500);
  };
  $('#fiPhotos').onclick = () => formsPhotosPanel($('#fiPhotos').dataset.batch || '');
  fiAiPanel();
}

// ИИ-разбор неисправных отчётов (app/services/ai/forms_fault.py): отчёты, где «не удалось починить» — из текста «итог работ» берётся «что неисправно» и «что нужно», и это попадает
// в отчёт и в карточку комплекса. Автоматически — если включено в «Настройки → ИИ»; кнопки — вручную.
async function fiAiPanel() {
  clearInterval(_fiAiTimer);
  const box = () => $('#fiAi');
  const paint = (s) => {
    const el = box();
    if (!el) return false;
    const line = [`ждут разбора: <b>${s.pending}</b>`, `разобрано и записано: <b>${s.ok}</b>`, s.empty ? `в тексте нечего достать: ${s.empty}` : '', s.rejected ? `ответ отброшен проверкой: ${s.rejected}` : '',
      s.skipped ? `пропущено (правили вручную): ${s.skipped}` : '', s.error ? `сбой модели: ${s.error}` : ''].filter(Boolean).join(' · ');
    el.innerHTML = `<div><b>🤖 ИИ: что неисправно и что нужно</b> — для отчётов, где не удалось починить, ИИ читает «итог работ» из формы и записывает в отчёт и в карточку комплекса, в чём проблема и что нужно для восстановления.
        ${s.enabled ? '<span class="text-emerald-300">Автоматический разбор включён.</span>' : '<span class="text-slate-400">Автоматический разбор выключен (включает администратор: «Настройки → ИИ»).</span>'}</div>
      <div class="text-slate-300">${line}</div>
      ${s.running ? '<div class="text-amber-300">⏳ Идёт разбор — модель читает отчёты по одному…</div>' : ''}
      ${!s.llm_ready ? `<div class="text-amber-300">Языковая модель сейчас не отвечает${s.last_error ? ': ' + esc(s.last_error) : ' (не установлена или ещё загружается)'}.</div>` : ''}
      <div class="flex flex-wrap gap-2 pt-0.5"><button type="button" id="fiAiRun" class="${btnGhost} !py-1 !px-3 text-xs" ${s.running || !s.llm_ready || !s.pending ? 'disabled' : ''}>Разобрать ИИ сейчас${s.pending ? ' (' + s.pending + ')' : ''}</button>
        ${s.rejected || s.error ? `<button type="button" id="fiAiAgain" class="${btnGhost} !py-1 !px-3 text-xs" ${s.running || !s.llm_ready ? 'disabled' : ''} title="Снова прочитать отчёты, где ответ был отброшен проверкой или модель дала сбой">Повторить отброшенные и сбойные</button>` : ''}</div>`;
    const run = (again) => async () => {
      try { await Api.post('/api/forms-import/ai-faults', { again }); } catch (e) { alert(e.message); }
      refresh();
    };
    if ($('#fiAiRun')) $('#fiAiRun').onclick = run(false);
    if ($('#fiAiAgain')) $('#fiAiAgain').onclick = run(true);
    return s.running;
  };
  const refresh = async () => {
    try {
      const running = paint(await Api.get('/api/forms-import/ai-faults'));
      clearInterval(_fiAiTimer);
      if (running) _fiAiTimer = setInterval(() => { if (!box()) clearInterval(_fiAiTimer); else refresh(); }, 3000);
    } catch (e) { if (box()) box().innerHTML = `<span class="text-slate-500">ИИ-разбор: не удалось получить состояние (${esc(e.message)})</span>`; }
  };
  await refresh();
}

// Фото по ссылкам из таблицы: выбрать комплексы и скачать через браузер робота карт.
async function formsPhotosPanel(batch) {
  clearInterval(_fiTimer);
  modal(`<h2 class="font-display text-lg font-bold mb-1">Фото из таблицы Яндекс Форм</h2>
    <p class="text-xs text-slate-400 mb-2">Отметьте комплексы и нажмите «Скачать». Обычно фото скачиваются сами сразу после загрузки таблицы; здесь можно докачать недокачанное (ошибки сети, робот был недоступен). Фото берёт браузер робота карт под Яндекс-аккаунтом создателя формы и кладёт их к отчёту
      (видны в «Фото по дням» и в карточке комплекса). Уже скачанное повторно не качается; если в папке комплекса за дату отчёта фото уже есть — строка пропускается.</p>
    <div id="fiRobot" class="text-xs mb-2 text-slate-400">Проверяю робот карт…</div>
    <div id="fiPhotoBody"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    <div id="fiProg" class="hidden mt-3"><div class="text-xs mb-1" id="fiProgText"></div><div style="height:8px;border-radius:9999px;overflow:hidden;background:rgba(100,116,139,.35)"><div id="fiProgBar" style="height:100%;width:0%;background:#10b981;transition:width .3s"></div></div></div>
    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button type="button" id="fiPickAll" class="${btnGhost}">Отметить все недокачанные</button>
      <button type="button" id="fiDownload" class="${btnPrimary}">⬇ Скачать фото выбранных</button>
    </div>`, { wide: true });
  const body = $('#fiPhotoBody');
  const robot = async () => {
    try {
      const st = await Api.get('/api/yandex-robot/status');
      $('#fiRobot').innerHTML = !st.available ? `<span class="text-rose-300">Робот карт недоступен: ${esc(st.message || '')}</span>`
        : !st.logged_in ? '<span class="text-amber-300">В браузере робота не выполнен вход в Яндекс — файлы формы не откроются. Войдите: Настройки → «Яндекс-аккаунт для карт» (под аккаунтом создателя формы).</span>'
        : `<span class="text-emerald-300">Робот карт готов${st.login ? ' · аккаунт ' + esc(st.login) : ''}.</span>`;
    } catch (e) { $('#fiRobot').innerHTML = `<span class="text-amber-300">Не удалось проверить робота: ${esc(e.message)}</span>`; }
  };
  robot();
  const stateBadge = (r) => {
    if (!r.task_id) return '<span class="text-slate-500">комплекс не найден — фото не привязать</span>';
    if (!r.photos_total) return '<span class="text-slate-500">ссылок нет</span>';
    const left = r.photos_total - r.photos_done - (r.photos_skipped || 0);
    if (!left && r.photos_skipped && !r.photos_done) return `<span class="text-slate-400" title="В папке комплекса за дату отчёта фото уже были">пропущено — уже есть в папке (${r.photos_skipped})</span>`;
    if (!left) return `<span class="text-emerald-300">скачано ${r.photos_done}/${r.photos_total}</span>${r.photos_skipped ? ` <span class="text-slate-400">· пропущено ${r.photos_skipped}</span>` : ''}`;
    return `${r.photos_done ? `<span class="text-emerald-300">${r.photos_done}</span>/` : ''}${r.photos_total}${r.photos_error ? ` <span class="text-rose-300" title="${esc(r.photos_error)}">· ошибка</span>` : ''}`;
  };
  const load = async (keepChecks) => {
    const checked = new Set(keepChecks ? [...body.querySelectorAll('[data-fi-photo]:checked')].map((c) => c.dataset.fiPhoto) : []);
    let data;
    try { data = await Api.get('/api/forms-import/rows' + (batch ? '?batch=' + encodeURIComponent(batch) : '')); }
    catch (e) { body.innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`; return null; }
    const rows = data.rows.filter((r) => r.photos_total > 0);
    body.innerHTML = rows.length ? `<div class="rounded-xl border border-slate-700/60 overflow-auto" style="max-height:50vh"><table class="w-full text-xs">
      <thead class="bg-slate-800/70 text-slate-400"><tr><th class="px-2 py-1.5" style="width:28px"></th><th class="px-2 py-1.5 text-left">Комплекс</th><th class="px-2 py-1.5 text-left">Время</th>
        <th class="px-2 py-1.5 text-left">Бригада (форма)</th><th class="px-2 py-1.5 text-left">Фото</th></tr></thead>
      <tbody>${rows.map((r) => `<tr class="border-t border-slate-700/40">
        <td class="px-2 py-1.5">${r.task_id && r.photos_done + (r.photos_skipped || 0) < r.photos_total ? `<input type="checkbox" data-fi-photo="${r.id}" class="rounded accent-indigo-500" ${checked.has(String(r.id)) ? 'checked' : ''}>` : ''}</td>
        <td class="px-2 py-1.5"><b>${esc(r.point_id || r.raw_point)}</b>${r.point_id && r.raw_point !== r.point_id ? `<span class="text-slate-500"> (${esc(r.raw_point)})</span>` : ''}</td>
        <td class="px-2 py-1.5 whitespace-nowrap">${esc(_fiClock(r.form_time))}</td><td class="px-2 py-1.5">${esc(r.crew_text)}</td><td class="px-2 py-1.5">${stateBadge(r)}</td></tr>`).join('')}</tbody></table></div>`
      : '<p class="text-sm text-slate-500">В загруженных таблицах нет строк со ссылками на фото.</p>';
    return data;
  };
  const progress = (job) => {
    const box = $('#fiProg');
    if (!box) return;
    box.classList.toggle('hidden', !job.total);
    $('#fiProgBar').style.width = job.total ? `${Math.round(((job.done + job.failed) / job.total) * 100)}%` : '0%';
    $('#fiProgText').textContent = job.running ? `Скачиваю: ${job.done + job.failed} из ${job.total}${job.current ? ' · ' + job.current : ''}${job.failed ? ` · ошибок: ${job.failed}` : ''}`
      : `Готово: скачано ${job.done} из ${job.total}${job.failed ? ` · ошибок: ${job.failed}${job.error ? ' — ' + job.error : ''} · причину покажет «Настройки → Яндекс Формы: вход и автозагрузка → Проверить скачивание»` : ''}`;
  };
  const poll = () => {
    clearInterval(_fiTimer);
    _fiTimer = setInterval(async () => {
      if (!$('#fiProg')) { clearInterval(_fiTimer); return; }
      try {
        const job = await Api.get('/api/forms-import/photos/status');
        progress(job);
        if (!job.running) { clearInterval(_fiTimer); await load(false); $('#fiDownload').disabled = false; }
      } catch { /* следующий опрос */ }
    }, 1500);
  };
  const first = await load(false);
  if (first && first.job && first.job.running) { progress(first.job); $('#fiDownload').disabled = true; poll(); }
  $('#fiPickAll').onclick = () => body.querySelectorAll('[data-fi-photo]').forEach((c) => { c.checked = true; });
  $('#fiDownload').onclick = async () => {
    const ids = [...body.querySelectorAll('[data-fi-photo]:checked')].map((c) => +c.dataset.fiPhoto);
    if (!ids.length) { alert('Отметьте комплексы, у которых нужно скачать фото.'); return; }
    $('#fiDownload').disabled = true;
    try {
      const job = await Api.post('/api/forms-import/photos', { ids });
      progress(job);
      poll();
    } catch (e) { alert(e.message); $('#fiDownload').disabled = false; }
  };
}
