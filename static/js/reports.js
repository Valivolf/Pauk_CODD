// /reports — текстовая сводка + .xlsx-выгрузки за день/неделю/произвольный
// период. $, esc, modal, btn*, VISIT_EXPORT_FIELDS come from ui.js.
let CURRENT_USER = null;

const pad2 = (n) => String(n).padStart(2, '0');
const isoDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function startOfWeek(d) {
  const day = (d.getDay() + 6) % 7; // Monday = 0
  const s = new Date(d);
  s.setDate(d.getDate() - day);
  return s;
}

const PRESETS = [
  ['today', 'Сегодня', () => { const t = new Date(); return [isoDate(t), isoDate(t)]; }],
  ['yesterday', 'Вчера', () => { const t = new Date(Date.now() - 86400000); return [isoDate(t), isoDate(t)]; }],
  ['this-week', 'Эта неделя', () => { const s = startOfWeek(new Date()); return [isoDate(s), isoDate(new Date())]; }],
  ['last-week', 'Прошлая неделя', () => {
    const s = startOfWeek(new Date());
    s.setDate(s.getDate() - 7);
    const e = new Date(s); e.setDate(s.getDate() + 6);
    return [isoDate(s), isoDate(e)];
  }],
];

let reportsPeriod = (() => { const t = new Date(); return { from: isoDate(t), to: isoDate(t) }; })();

async function renderReportsPage() {
  $('#content').innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-3 mb-6">
      <h2 class="font-display text-lg font-bold">Период</h2>
      <div class="flex flex-wrap items-center gap-2">
        ${PRESETS.map(([key, label]) => `<button data-preset="${key}" class="rounded-lg px-3 py-1.5 text-xs font-medium bg-slate-800/70 hover:bg-slate-700/70 text-slate-300 transition-colors">${label}</button>`).join('')}
        <input type="date" id="repFrom" value="${reportsPeriod.from}" class="rounded-lg px-2 py-1.5 text-xs">
        <span class="text-xs text-slate-500">—</span>
        <input type="date" id="repTo" value="${reportsPeriod.to}" class="rounded-lg px-2 py-1.5 text-xs">
        <button id="repApplyBtn" class="${btnPrimary} !px-4 !py-1.5 text-xs">Применить</button>
      </div>
    </div>
    <div id="reportsBody"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>

    <section class="mt-8 pt-6 border-t border-slate-700/50">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-2">
        <div><h3 class="text-sm font-semibold text-slate-300">История всех выездов</h3>
          <p class="text-xs text-slate-500 mt-1">Системные и загруженные отчёты за всё время, включая записи старше года.</p></div>
        <span id="visitArchiveCount" class="text-xs text-slate-400"></span>
      </div>
      <div class="lc-report-archive-filters mb-3">
        <input id="visitArchiveSearch" type="search" placeholder="Комплекс, адрес, исполнитель, текст…" class="lc-report-archive-search rounded-lg px-3 py-2 text-sm">
        <input id="visitArchiveFrom" type="date" aria-label="Дата с" class="rounded-lg px-2 py-2 text-sm">
        <input id="visitArchiveTo" type="date" aria-label="Дата по" class="rounded-lg px-2 py-2 text-sm">
        <select id="visitArchiveSource" class="rounded-lg px-2 py-2 text-sm"><option value="">Все источники</option><option value="system">Система</option><option value="forms">Яндекс Формы</option><option value="bot">Бот</option><option value="imported">Импорт из Excel</option></select>
        <input id="visitArchiveStatus" type="text" placeholder="Статус" class="rounded-lg px-3 py-2 text-sm">
      </div>
      <div class="flex flex-wrap gap-2 mb-3"><input id="visitArchiveType" type="text" placeholder="Тип выезда" class="rounded-lg px-3 py-2 text-sm"><button id="visitArchiveApply" class="${btnPrimary} !px-4 !py-2 text-xs">Найти</button><button id="visitArchiveReset" class="${btnGhost} !px-4 !py-2 text-xs">Сбросить</button></div>
      <div id="visitArchiveList" class="overflow-x-auto"><p class="text-sm text-slate-500">Загружаем историю…</p></div>
      <div class="flex justify-end items-center gap-2 mt-3"><button id="visitArchivePrev" class="${btnGhost} !px-3 !py-1.5 text-xs">← Назад</button><span id="visitArchivePage" class="text-xs text-slate-500"></span><button id="visitArchiveNext" class="${btnGhost} !px-3 !py-1.5 text-xs">Дальше →</button></div>
    </section>

    <section class="mt-8 pt-6 border-t border-slate-700/50">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
        <h3 class="text-sm font-semibold text-slate-300">Отчёты по шаблону</h3>
        <div class="flex flex-wrap items-center gap-2">
          <button id="tplVarsBtn" class="${btnGhost} !px-3 !py-1.5 text-xs" title="Переменные для загружаемых файлов">Переменные файлов</button>
          <button id="tplUploadBtn" class="${btnGhost} !px-3 !py-1.5 text-xs" title="Загрузить готовый .docx / .xlsx с переменными {{…}}">⬆ Загрузить свой файл</button>
          <button id="tplCreateBtn" class="${btnPrimary} !px-4 !py-1.5 text-xs">+ Создать отчёт</button>
        </div>
      </div>
      <p class="text-xs text-slate-500 mb-3"><b>«Создать отчёт»</b> — онлайн-конструктор Excel и Word с предпросмотром и редактированием. Можно также загрузить готовый файл и позже заменить его. Новые шаблоны доступны только создателю, пока вы не откроете доступ всем или выбранным учётным записям.</p>
      <div id="tplList"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>
    </section>

    `;

  $('#content').querySelectorAll('[data-preset]').forEach((btn) => {
    btn.onclick = () => {
      const [, , range] = PRESETS.find((p) => p[0] === btn.dataset.preset);
      [reportsPeriod.from, reportsPeriod.to] = range();
      $('#repFrom').value = reportsPeriod.from;
      $('#repTo').value = reportsPeriod.to;
      loadReportsBody();
    };
  });
  $('#repApplyBtn').onclick = () => {
    reportsPeriod.from = $('#repFrom').value || reportsPeriod.from;
    reportsPeriod.to = $('#repTo').value || reportsPeriod.to;
    if (reportsPeriod.from > reportsPeriod.to) [reportsPeriod.from, reportsPeriod.to] = [reportsPeriod.to, reportsPeriod.from];
    loadReportsBody();
  };
  $('#tplCreateBtn').onclick = () => { window.location.href = '/reports/builder'; };
  $('#tplUploadBtn').onclick = () => createTemplateForm();
  $('#tplVarsBtn').onclick = () => showVariablesModal();

  initVisitArchive();

  await Promise.all([loadReportsBody(), loadTemplates()]);
  // Кнопки изменения прячутся по правам (запрет на сервере — app/core/perm_guard.py): шаблоны и конструктор — «Конструктор отчётов», тексты отчётов и бланк — «Вносить и править отчёты»
  if (!can('reports.builder')) {
    $('#tplCreateBtn')?.classList.add('hidden');
    $('#tplUploadBtn')?.classList.add('hidden');
  }
}

let visitArchiveOffset = 0;
const VISIT_ARCHIVE_LIMIT = 50;
function initVisitArchive() {
  const load = () => loadVisitArchive(visitArchiveOffset);
  $('#visitArchiveApply').onclick = () => { visitArchiveOffset = 0; load(); };
  $('#visitArchiveReset').onclick = () => {
    ['visitArchiveSearch', 'visitArchiveFrom', 'visitArchiveTo', 'visitArchiveType'].forEach((id) => { $(`#${id}`).value = ''; });
    $('#visitArchiveSource').value = ''; $('#visitArchiveStatus').value = ''; visitArchiveOffset = 0; load();
  };
  $('#visitArchiveSearch').onkeydown = (e) => { if (e.key === 'Enter') { visitArchiveOffset = 0; load(); } };
  $('#visitArchivePrev').onclick = () => { visitArchiveOffset = Math.max(0, visitArchiveOffset - VISIT_ARCHIVE_LIMIT); load(); };
  $('#visitArchiveNext').onclick = () => { visitArchiveOffset += VISIT_ARCHIVE_LIMIT; load(); };
  load();
}

async function loadVisitArchive(offset) {
  const list = $('#visitArchiveList');
  if (!list) return;
  list.innerHTML = '<p class="text-sm text-slate-500 lc-pulse">Загружаем историю…</p>';
  const params = new URLSearchParams({ limit: String(VISIT_ARCHIVE_LIMIT), offset: String(offset) });
  const values = { q: $('#visitArchiveSearch').value, date_from: $('#visitArchiveFrom').value, date_to: $('#visitArchiveTo').value,
    source: $('#visitArchiveSource').value, status: $('#visitArchiveStatus').value, visit_type: $('#visitArchiveType').value };
  Object.entries(values).forEach(([key, value]) => { if (value) params.set(key, value); });
  try {
    const data = await Api.get(`/api/task-visit-reports/archive?${params}`);
    $('#visitArchiveCount').textContent = `Найдено: ${Number(data.total).toLocaleString('ru-RU')}`;
    const page = data.total ? Math.floor(offset / VISIT_ARCHIVE_LIMIT) + 1 : 0;
    $('#visitArchivePage').textContent = data.total ? `Страница ${page} из ${Math.ceil(data.total / VISIT_ARCHIVE_LIMIT)}` : '';
    $('#visitArchivePrev').disabled = offset <= 0;
    $('#visitArchiveNext').disabled = offset + VISIT_ARCHIVE_LIMIT >= data.total;
    if (!data.items.length) { list.innerHTML = '<p class="text-sm text-slate-500 py-4">По заданным условиям выезды не найдены.</p>'; return; }
    list.innerHTML = `<table class="lc-report-archive-table text-left text-xs"><thead><tr class="lc-report-archive-head"><th class="px-2 py-2">Дата</th><th class="px-2 py-2">Комплекс</th><th class="px-2 py-2">Тип / итог</th><th class="px-2 py-2">Исполнитель</th><th class="px-2 py-2">Источник</th><th class="px-2 py-2">Комментарий</th></tr></thead><tbody>${data.items.map((r) => `<tr class="lc-report-archive-row"><td class="px-2 py-2 whitespace-nowrap">${esc(fmtDate(r.visit_date))}</td><td class="px-2 py-2"><b>${esc(r.point_id)}</b>${r.address ? `<div class="text-slate-500 mt-0.5">${esc(r.address)}</div>` : ''}${r.inventory_number ? `<div class="text-slate-500">№ ${esc(r.inventory_number)}</div>` : ''}</td><td class="px-2 py-2"><div>${esc(r.visit_type || '—')}</div><div class="text-slate-400 mt-0.5">${esc(r.status_label)}</div></td><td class="px-2 py-2">${esc(r.author || '—')}</td><td class="px-2 py-2 whitespace-nowrap">${esc(r.source_label)}</td><td class="px-2 py-2 lc-report-archive-comment">${esc([r.comment, r.fault ? `Неисправность: ${r.fault}` : '', r.needs ? `Нужно: ${r.needs}` : ''].filter(Boolean).join('\n') || '—')}</td></tr>`).join('')}</tbody></table>`;
  } catch (e) {
    list.innerHTML = `<p class="text-sm text-rose-400 py-3">Не удалось загрузить историю: ${esc(e.message)}</p>`;
  }
}

// ---------- Отчёты по шаблону: operator-uploaded .docx/.xlsx ----------

function templateCardHtml(t) {
  return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <div class="text-sm font-semibold truncate">${esc(t.name)}</div>
      <div class="text-[11px] text-slate-500">${t.file_type.toUpperCase()} · ${t.mode === 'day' ? 'на один день' : 'на период'} · переменных: ${t.variables.length} · ${accessLabel(t)}</div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      <button data-generate="${t.id}" class="${btnPrimary} !px-3 !py-1.5 text-xs">Сформировать</button>
      ${t.can_edit ? `<button data-template-edit="${t.id}" class="${btnGhost} !px-3 !py-1.5 text-xs">Изменить</button>${t.can_manage_access ? `<button data-template-access="${t.id}" class="${btnGhost} !px-3 !py-1.5 text-xs">Доступ</button>` : ''}<button data-delete="${t.id}" class="${btnDanger} !px-3 !py-1.5 text-xs">Удалить</button>` : ''}
    </div>
  </div>`;
}

// Отчёты из конструктора (/reports/builder): сформировать за период, изменить,
// сделать копию, удалить. Загруженные файлы (templateCardHtml) — отдельной группой.
function designCardHtml(d) {
  return `<div class="rounded-xl border border-indigo-400/30 bg-indigo-500/5 px-4 py-3 flex flex-wrap items-center justify-between gap-3">
    <div class="min-w-0">
      <div class="text-sm font-semibold truncate">${esc(d.name)}</div>
      <div class="text-[11px] text-slate-500">Конструктор · ${d.format.toUpperCase()} · ${accessLabel(d)} · изменён ${esc(fmtDateTime(d.updated_at))}${d.created_by ? ` · ${esc(d.created_by)}` : ''}</div>
    </div>
    <div class="flex flex-wrap items-center gap-2 shrink-0">
      <button data-design-generate="${d.id}" class="${btnPrimary} !px-3 !py-1.5 text-xs">Сформировать</button>
      ${d.can_edit ? `<a href="/reports/builder?id=${d.id}" class="${btnGhost} !px-3 !py-1.5 text-xs">✎ Изменить</a>
      <button data-design-copy="${d.id}" class="${btnGhost} !px-3 !py-1.5 text-xs">Копия</button>
      ${d.can_manage_access ? `<button data-design-access="${d.id}" class="${btnGhost} !px-3 !py-1.5 text-xs">Доступ</button>` : ''}
      <button data-design-delete="${d.id}" class="${btnDanger} !px-3 !py-1.5 text-xs">Удалить</button>` : ''}
    </div>
  </div>`;
}

async function loadTemplates() {
  $('#tplList').innerHTML = '<p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p>';
  let items, designs;
  try {
    [items, designs] = await Promise.all([Api.get('/api/report-templates'), Api.get('/api/report-designs')]);
  } catch (e) {
    $('#tplList').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  if (!items.length && !designs.length) {
    $('#tplList').innerHTML = '<p class="text-sm text-slate-500">Отчётов пока нет — нажмите «Создать отчёт».</p>';
    return;
  }
  $('#tplList').innerHTML = `<div class="space-y-2">${designs.map(designCardHtml).join('')}${items.map(templateCardHtml).join('')}</div>`;
  items.forEach((t) => {
    $(`[data-generate="${t.id}"]`).onclick = () => generateTemplateForm(t);
    const deleteBtn = $(`[data-delete="${t.id}"]`);
    if (deleteBtn) deleteBtn.onclick = () => deleteTemplate(t);
    $(`[data-template-edit="${t.id}"]`)?.addEventListener('click', () => editTemplateForm(t));
    $(`[data-template-access="${t.id}"]`)?.addEventListener('click', () => editReportAccess('template', t));
  });
  designs.forEach((d) => {
    $(`[data-design-generate="${d.id}"]`).onclick = () => generateDesignForm(d);
    const copy = $(`[data-design-copy="${d.id}"]`);
    if (copy) copy.onclick = () => copyDesign(d);
    const del = $(`[data-design-delete="${d.id}"]`);
    if (del) del.onclick = () => deleteDesign(d);
    $(`[data-design-access="${d.id}"]`)?.addEventListener('click', () => editReportAccess('design', d));
  });
}

function editTemplateForm(t) {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Изменить «${esc(t.name)}»</h2>
    <p class="text-xs text-slate-400 mb-3">Можно переименовать шаблон или заменить исходный файл. Новый файл должен быть того же типа (.${esc(t.file_type)}); его переменные определятся заново.</p>
    <form id="tplEditForm" class="space-y-3">
      <label class="${labelCls}">Название<input name="name" required maxlength="100" value="${esc(t.name)}" class="${fieldCls}"></label>
      <label class="${labelCls}">Заменить файл (необязательно)<input name="file" type="file" accept=".${esc(t.file_type)}" class="${fieldCls}"></label>
      <div id="tplEditError" class="hidden text-xs text-rose-300"></div>
      <div class="flex items-center gap-2"><button type="button" class="cancel ${btnGhost}">Отмена</button><button class="${btnPrimary}">Сохранить</button></div>
    </form>`);
  $('#tplEditForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements, body = new FormData();
    body.append('name', f.name.value.trim());
    if (f.file.files[0]) body.append('file', f.file.files[0]);
    try { await Api.upload(`/api/report-templates/${t.id}`, body, 'PUT'); close(); await loadTemplates(); }
    catch (err) { $('#tplEditError').textContent = err.message; $('#tplEditError').classList.remove('hidden'); }
  };
}

const accessLabel = (item) => item.visibility === 'private' ? 'только владельцу' : item.visibility === 'users' ? 'выбранным учётным записям' : 'всем';

async function editReportAccess(kind, item) {
  let users;
  try { users = await Api.get('/api/report-designs/users'); }
  catch (e) { alert('Не удалось загрузить список учётных записей: ' + e.message); return; }
  const endpoint = kind === 'design' ? `/api/report-designs/${item.id}/access` : `/api/report-templates/${item.id}/access`;
  const current = new Set(item.shared_users || []);
  modal(`<h2 class="font-display text-lg font-bold mb-1">Доступ к «${esc(item.name)}»</h2>
    <p class="text-xs text-slate-400 mb-3">Выберите, кому можно видеть этот шаблон и формировать по нему файл.</p>
    <label class="${labelCls}">Кому доступен
      <select id="repAccessMode" class="${fieldCls}">
        <option value="private" ${item.visibility === 'private' ? 'selected' : ''}>Только мне</option>
        <option value="public" ${item.visibility === 'public' ? 'selected' : ''}>Всем сотрудникам</option>
        <option value="users" ${item.visibility === 'users' ? 'selected' : ''}>Выбранным учётным записям</option>
      </select>
    </label>
    <div id="repAccessUsers" class="${item.visibility === 'users' ? '' : 'hidden'} mt-3 max-h-52 overflow-auto rounded-xl border border-slate-700/50 p-2 space-y-1">
      ${users.map((u) => `<label class="flex items-center gap-2 rounded-lg px-2 py-1.5 text-sm hover:bg-slate-700/40"><input type="checkbox" data-access-user="${u.id}" ${current.has(u.id) ? 'checked' : ''} class="accent-indigo-500">${esc(u.username)}</label>`).join('')}
    </div>
    <div id="repAccessError" class="hidden mt-3 text-xs text-rose-300"></div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Отмена</button><button type="button" id="repAccessSave" class="${btnPrimary}">Сохранить доступ</button></div>`);
  $('#repAccessMode').onchange = (e) => $('#repAccessUsers').classList.toggle('hidden', e.target.value !== 'users');
  $('#repAccessSave').onclick = async () => {
    const visibility = $('#repAccessMode').value;
    const user_ids = [...document.querySelectorAll('[data-access-user]:checked')].map((el) => Number(el.dataset.accessUser));
    try {
      await Api.put(endpoint, { visibility, user_ids });
      close(); await loadTemplates();
    } catch (e) { $('#repAccessError').textContent = e.message; $('#repAccessError').classList.remove('hidden'); }
  };
}

async function deleteDesign(d) {
  if (!confirm(`Удалить отчёт «${d.name}»?`)) return;
  try { await Api.del(`/api/report-designs/${d.id}`); await loadTemplates(); }
  catch (e) { alert('Не удалось удалить: ' + e.message); }
}

async function copyDesign(d) {
  try {
    const full = await Api.get(`/api/report-designs/${d.id}`);
    await Api.post('/api/report-designs', { name: `Копия — ${d.name}`.slice(0, 100), format: d.format, design: full.design });
    await loadTemplates();
  } catch (e) { alert('Не удалось скопировать: ' + e.message); }
}

function generateDesignForm(d) {
  const today = isoDate(new Date());
  modal(`<h2 class="font-display text-lg font-bold mb-1">Сформировать «${esc(d.name)}»</h2>
    <p class="text-xs text-slate-400 mb-3">Бригады и задания возьмутся за выбранные дни (${d.format === 'xlsx' ? 'Excel' : 'Word'}).</p>
    <div class="grid grid-cols-2 gap-3">
      <label class="${labelCls}">С<input type="date" id="dsgFrom" value="${reportsPeriod.from || today}" class="${fieldCls}"></label>
      <label class="${labelCls}">По<input type="date" id="dsgTo" value="${reportsPeriod.to || today}" class="${fieldCls}"></label>
    </div>
    <div id="dsgStatus" class="hidden mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button id="dsgBtn" class="${btnPrimary}">Скачать</button>
    </div>`);
  $('#dsgBtn').onclick = async () => {
    const from = $('#dsgFrom').value, to = $('#dsgTo').value;
    const status = $('#dsgStatus');
    if (!from || !to) { status.textContent = 'Укажите обе даты'; status.classList.remove('hidden'); return; }
    $('#dsgBtn').disabled = true;
    $('#dsgBtn').textContent = 'Формирую…';
    try {
      const now = new Date();
      const localNow = `${isoDate(now)}T${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
      const res = await fetch(`/api/report-designs/${d.id}/generate?date_from=${from}&date_to=${to}&today=${isoDate(now)}&now=${encodeURIComponent(localNow)}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.detail) || res.statusText);
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const star = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      const plain = /filename="([^"]+)"/.exec(disposition);
      const filename = star ? decodeURIComponent(star[1]) : (plain ? plain[1] : `${d.name}.${d.format}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      const warnings = Number(res.headers.get('X-Report-Warnings')) || 0;
      if (warnings) {
        status.textContent = `Файл скачан. В шаблоне есть предупреждения (${warnings}) — откройте отчёт в конструкторе и посмотрите «Предпросмотр».`;
        status.classList.remove('hidden');
        $('#dsgBtn').disabled = false;
        $('#dsgBtn').textContent = 'Скачать ещё раз';
      } else {
        close();
      }
    } catch (err) {
      status.textContent = 'Не удалось сформировать отчёт: ' + err.message;
      status.classList.remove('hidden');
      $('#dsgBtn').disabled = false;
      $('#dsgBtn').textContent = 'Скачать';
    }
  };
}

function createTemplateForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Создать отчёт по шаблону</h2>
    <p class="text-xs text-slate-400 mb-4">Загрузите файл Excel или Word с переменными вида <code>{{ключ}}</code>. Переменные можно посмотреть после загрузки; кто сможет пользоваться шаблоном — выберите ниже или измените позднее кнопкой «Доступ».</p>
    <form id="tplCreateForm" class="space-y-4">
      <label class="${labelCls}">Название<input name="name" required class="${fieldCls}" placeholder="Например: Свод по выездам бригад"></label>
      <label class="${labelCls}">Файл (.docx или .xlsx)<input name="file" type="file" accept=".docx,.xlsx" required class="${fieldCls}"></label>
      <label class="${labelCls}">Кому будет доступен<select name="visibility" class="${fieldCls}"><option value="private">Только мне</option><option value="public">Всем сотрудникам</option></select></label>
      <div id="tplCreateError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Отмена</button>
        <button class="${btnPrimary}">Загрузить</button>
      </div>
    </form>`);

  $('#tplCreateForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    if (!f.file.files.length) return;
    const fd = new FormData();
    fd.append('name', f.name.value);
    fd.append('file', f.file.files[0]);
    fd.append('visibility', f.visibility.value);
    try {
      const res = await Api.upload('/api/report-templates', fd);
      close();
      await loadTemplates();
      if (res.warning) alert(res.warning);
      else if (!res.variables.length) alert('Шаблон загружен, но в нём не найдено ни одной переменной — файл будет скачиваться без подстановки данных.');
    } catch (err) {
      $('#tplCreateError').textContent = err.message;
      $('#tplCreateError').classList.remove('hidden');
    }
  };
}

async function deleteTemplate(t) {
  if (!confirm(`Удалить шаблон «${t.name}»?`)) return;
  try {
    await Api.del(`/api/report-templates/${t.id}`);
    await loadTemplates();
  } catch (e) {
    alert('Не удалось удалить: ' + e.message);
  }
}

function generateTemplateForm(t) {
  const today = isoDate(new Date());
  modal(`<h2 class="font-display text-lg font-bold mb-3">Сформировать «${esc(t.name)}»</h2>
    ${t.mode === 'day'
      ? `<label class="${labelCls}">Дата<input type="date" id="tplGenDate" value="${today}" class="${fieldCls}"></label>`
      : `<div class="grid grid-cols-2 gap-3">
          <label class="${labelCls}">С<input type="date" id="tplGenFrom" value="${today}" class="${fieldCls}"></label>
          <label class="${labelCls}">По<input type="date" id="tplGenTo" value="${today}" class="${fieldCls}"></label>
        </div>`}
    <div id="tplGenStatus" class="hidden mt-3 rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300"></div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button id="tplGenBtn" class="${btnPrimary}">Скачать</button>
    </div>`);

  $('#tplGenBtn').onclick = async () => {
    const from = t.mode === 'day' ? $('#tplGenDate').value : $('#tplGenFrom').value;
    const to = t.mode === 'day' ? $('#tplGenDate').value : $('#tplGenTo').value;
    if (!from || !to) return;
    $('#tplGenBtn').disabled = true;
    $('#tplGenBtn').textContent = 'Формирую…';
    try {
      const res = await fetch(`/api/report-templates/${t.id}/generate?date_from=${from}&date_to=${to}`, { credentials: 'same-origin' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error((body && body.detail) || res.statusText);
      }
      const missing = res.headers.get('X-Missing-Variables');
      const disposition = res.headers.get('Content-Disposition') || '';
      const starMatch = /filename\*=UTF-8''([^;]+)/.exec(disposition);
      const plainMatch = /filename="([^"]+)"/.exec(disposition);
      const filename = starMatch ? decodeURIComponent(starMatch[1]) : (plainMatch ? plainMatch[1] : `${t.name}.${t.file_type}`);
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename;
      a.click();
      URL.revokeObjectURL(a.href);
      if (missing) {
        $('#tplGenStatus').textContent = `Файл скачан, но для этих переменных не нашлось данных: ${missing}`;
        $('#tplGenStatus').classList.remove('hidden');
        $('#tplGenBtn').disabled = false;
        $('#tplGenBtn').textContent = 'Скачать';
      } else {
        close();
      }
    } catch (err) {
      $('#tplGenStatus').textContent = 'Не удалось сформировать отчёт: ' + err.message;
      $('#tplGenStatus').className = 'mt-3 rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300';
      $('#tplGenBtn').disabled = false;
      $('#tplGenBtn').textContent = 'Скачать';
    }
  };
}

async function showVariablesModal() {
  let data;
  try {
    data = await Api.get('/api/report-templates/variables');
  } catch (e) {
    alert('Не удалось загрузить список переменных: ' + e.message);
    return;
  }
  const groups = [];
  for (const v of data.variables) {
    let g = groups.find((x) => x.name === v.group);
    if (!g) { g = { name: v.group, items: [] }; groups.push(g); }
    g.items.push(v);
  }
  modal(`<h2 class="font-display text-lg font-bold mb-1">Доступные переменные</h2>
    <p class="text-xs text-slate-400 mb-4">Вставьте в документ как есть, например <code>{{date}}</code>. Переменные <code>{{row.*}}</code> — для строки таблицы: она повторится по одной на каждую бригаду за каждый день выбранного периода.</p>
    <div class="max-h-[60vh] overflow-auto space-y-4">
      ${groups.map((g) => `<div>
        <div class="text-xs font-semibold text-slate-400 mb-1.5">${esc(g.name)}</div>
        <div class="space-y-1">
          ${g.items.map((v) => `<div class="text-xs flex items-start gap-2">
            <code class="shrink-0 rounded bg-slate-800 px-1.5 py-0.5 text-indigo-300">{{${esc(v.key)}}}</code>
            <span class="text-slate-400">${esc(v.label)}</span>
          </div>`).join('')}
        </div>
      </div>`).join('')}
    </div>
    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);
}

function periodFilenamePart() {
  return reportsPeriod.from === reportsPeriod.to ? fmtDate(reportsPeriod.from) : `${fmtDate(reportsPeriod.from)}_${fmtDate(reportsPeriod.to)}`;
}

async function loadReportsBody() {
  let data;
  try {
    data = await Api.get(`/api/reports/text?date_from=${reportsPeriod.from}&date_to=${reportsPeriod.to}&tz_offset=${new Date().getTimezoneOffset()}`);
  } catch (e) {
    $('#reportsBody').innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }

  // The shell below never actually varies with `data` or `reportsPeriod`
  // (the textarea's text is set separately, and the download/export
  // buttons read `reportsPeriod` live at click time) — setHtmlIfChanged
  // (ui.js) means the 5s poll rebuilds/rewires it only once, ever, and
  // every subsequent tick just refreshes the textarea's value below.
  const shellHtml = `
    <section class="mb-6">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h3 class="text-sm font-semibold text-slate-300">Текстовый отчёт</h3>
        <div class="flex items-center gap-2">
          <button id="repCopyBtn" class="${btnGhost} !px-3 !py-1.5 text-xs">Скопировать</button>
          <button id="repDownloadTxtBtn" class="${btnGhost} !px-3 !py-1.5 text-xs">Скачать .txt</button>
        </div>
      </div>
      <textarea id="repText" readonly class="w-full rounded-xl px-3 py-3 text-xs font-mono leading-relaxed" style="min-height:360px" spellcheck="false"></textarea>
    </section>
    <section>
      <h3 class="text-sm font-semibold text-slate-300 mb-3">Файлы</h3>
      <div class="flex flex-wrap items-center gap-2">
        <button id="repCrewXlsxBtn" class="${btnPrimary} !px-4 !py-2 text-xs">Свод по бригадам (.xlsx)</button>
        <button id="repHistoryXlsxBtn" class="${btnGhost} !px-4 !py-2 text-xs">Детальная история выездов (.xlsx)</button>
        <button id="repSummaryXlsxBtn" class="${btnGhost} !px-4 !py-2 text-xs">Итоги по комплексам (.xlsx)</button>
      </div>
    </section>`;

  if (!setHtmlIfChanged($('#reportsBody'), shellHtml)) {
    $('#repText').value = data.text;
    return;
  }
  $('#repText').value = data.text;
  $('#repCopyBtn').onclick = async () => {
    try {
      await navigator.clipboard.writeText(data.text);
      $('#repCopyBtn').textContent = 'Скопировано ✓';
      setTimeout(() => { $('#repCopyBtn').textContent = 'Скопировать'; }, 1500);
    } catch {
      $('#repText').select();
      document.execCommand('copy');
    }
  };
  $('#repDownloadTxtBtn').onclick = () => {
    const blob = new Blob([data.text], { type: 'text/plain;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `otchet-${periodFilenamePart()}.txt`;
    a.click();
    URL.revokeObjectURL(a.href);
  };
  $('#repCrewXlsxBtn').onclick = () => {
    window.location.href = `/api/reports/crew-summary/export?date_from=${reportsPeriod.from}&date_to=${reportsPeriod.to}&tz_offset=${new Date().getTimezoneOffset()}`;
  };
  $('#repHistoryXlsxBtn').onclick = () => exportVisitReportsForm();
  $('#repSummaryXlsxBtn').onclick = () => exportPointSummariesForm();
}

// «История выездов» — тот же field-picker, что на /stats (VISIT_EXPORT_FIELDS
// зеркалит task_visit_reports_repository.py::EXPORT_FIELDS).
function exportVisitReportsForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Экспорт истории выездов</h2>
    <p class="text-xs text-slate-400 mb-4">Период: ${esc(fmtDate(reportsPeriod.from))} — ${esc(fmtDate(reportsPeriod.to))} (меняется в фильтре периода на странице).</p>
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
    const params = new URLSearchParams({ date_from: reportsPeriod.from, date_to: reportsPeriod.to });
    fields.forEach((f) => params.append('fields', f));
    window.location.href = '/api/task-visit-reports/export?' + params.toString();
    close();
  };
}

// «Итоги по комплексам» — тот же field-picker, что и у истории выездов
// выше, но по данным задания+отчёта вместе (POINT_SUMMARY_EXPORT_FIELDS
// зеркалит app/repositories/monitoring_repository.py::EXPORT_FIELDS):
// дата, бригада, точка, что нужно было сделать (план) и что сделали по
// факту — в одной строке на отчёт, а не как «Свод по бригадам» (там
// только план/факт по количеству, без содержания).
function exportPointSummariesForm() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Экспорт итогов по комплексам</h2>
    <p class="text-xs text-slate-400 mb-4">Период: ${esc(fmtDate(reportsPeriod.from))} — ${esc(fmtDate(reportsPeriod.to))} (меняется в фильтре периода на странице).</p>
    <form id="exportFieldsForm" class="space-y-1.5">
      <div class="flex items-center gap-2 pb-1">
        <button type="button" id="exportFieldsAll" class="${btnGhost} !py-1 !px-2.5 text-xs">Все поля</button>
        <button type="button" id="exportFieldsNone" class="${btnGhost} !py-1 !px-2.5 text-xs">Снять все</button>
      </div>
      ${POINT_SUMMARY_EXPORT_FIELDS.map(([key, label]) => `<label class="flex items-center gap-2 text-sm py-1">
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
    const params = new URLSearchParams({ date_from: reportsPeriod.from, date_to: reportsPeriod.to });
    fields.forEach((f) => params.append('fields', f));
    window.location.href = '/api/monitoring/point-summaries/export?' + params.toString();
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
  if (!can('reports.view')) { window.location.href = '/'; return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  await renderReportsPage();
  // Live refresh, matching the calendar's 5s poll — skipped while a modal
  // (export field picker, password change) is open, and while the text
  // report's own textarea has focus (a dispatcher might be selecting text).
  setInterval(() => {
    if (editing || document.hidden || document.activeElement === $('#repText')) return;
    loadReportsBody().catch(() => {});
  }, 5000);
}
boot();
