// «Настройки → 🛡 Журнал безопасности…» (только администратор): входы и отказы во входе, смена паролей, действия администратора над учётными записями, скачивание копий базы, замена ключа,
// изменение настроек, отказы в доступе. Фильтры, листание, выгрузка в CSV. Бэкенд — app/services/security_log.py, app/api/routes_security.py.
// $, esc, Api, modal, btn*, fieldCls, labelCls, fmtDateTime, toast — из ui.js.
const SEC_PAGE = 100;

async function openSecurityLog() {
  const state = { offset: 0, total: 0 };
  modal(`<div class="flex items-start justify-between gap-3 mb-1 flex-wrap">
      <h2 class="font-display text-lg font-bold">🛡 Журнал безопасности</h2>
      <button type="button" class="cancel ${btnGhost} !px-4 !py-1.5 text-xs">Закрыть</button>
    </div>
    <p id="secInfo" class="text-xs text-slate-400 mb-3">Загружаю…</p>
    <form id="secFilter" class="flex flex-wrap items-end gap-x-3 gap-y-2 mb-3">
      <label class="${labelCls}">Событие<select name="kind" class="${fieldCls}" style="width:auto"><option value="">Все</option></select></label>
      <label class="${labelCls}">Логин<input name="username" class="${fieldCls}" style="width:9rem" placeholder="часть логина"></label>
      <label class="${labelCls}">С даты<input type="date" name="date_from" class="${fieldCls}" style="width:auto"></label>
      <label class="${labelCls}">По дату<input type="date" name="date_to" class="${fieldCls}" style="width:auto"></label>
      <label class="flex items-center gap-1.5 text-xs text-slate-300 pb-2 cursor-pointer"><input type="checkbox" name="only_failed"> только отказы и ошибки</label>
      <button type="submit" class="${btnPrimary} !py-1.5 text-xs">Показать</button>
      <button type="button" id="secExport" class="${btnGhost} !py-1.5 text-xs" title="Выгрузить в CSV всё, что подходит под фильтры (Excel откроет)">⬇ CSV</button>
    </form>
    <div id="secBody" class="rounded-xl border border-slate-700/60 overflow-auto" style="max-height:52vh"></div>
    <div class="flex items-center gap-3 mt-2 text-xs text-slate-400">
      <button type="button" id="secPrev" class="${btnGhost} !px-3 !py-1 text-xs">← Новее</button>
      <button type="button" id="secNext" class="${btnGhost} !px-3 !py-1 text-xs">Старше →</button>
      <span id="secPage"></span>
    </div>`, { wide: true });

  const form = $('#secFilter');
  const query = () => {
    const p = new URLSearchParams();
    for (const [k, v] of new FormData(form).entries()) if (String(v).trim()) p.set(k, String(v).trim());
    p.delete('only_failed');
    if (form.elements.only_failed.checked) p.set('only_failed', 'true');
    return p;
  };
  const draw = async () => {
    const p = query();
    p.set('limit', SEC_PAGE);
    p.set('offset', state.offset);
    let d;
    try { d = await Api.get('/api/security/events?' + p.toString()); }
    catch (e) { $('#secBody').innerHTML = `<p class="p-3 text-sm text-rose-300">Не удалось загрузить журнал: ${esc(e.message)}</p>`; return; }
    state.total = d.total;
    if (form.elements.kind.options.length === 1) {
      Object.entries(d.kinds).forEach(([k, label]) => form.elements.kind.add(new Option(label, k)));
    }
    $('#secInfo').textContent = `События хранятся ${d.retention_days} дн.; пароли и содержимое запросов в журнал не попадают. Всего подходит под фильтры: ${d.total}.`;
    $('#secBody').innerHTML = d.items.length ? `<table class="w-full text-xs">
        <thead class="bg-slate-800/70 text-slate-400"><tr>${['Время', 'Событие', 'Логин', 'Роль', 'Адрес', 'Результат', 'Подробности'].map((h) => `<th class="px-2.5 py-1.5 text-left whitespace-nowrap">${h}</th>`).join('')}</tr></thead>
        <tbody>${d.items.map((e) => `<tr class="border-t border-slate-700/40 ${e.ok ? '' : 'bg-rose-500/5'}">
          <td class="px-2.5 py-1.5 whitespace-nowrap">${esc(fmtDateTime(e.at, true))}</td><td class="px-2.5 py-1.5">${esc(e.kind_label)}</td><td class="px-2.5 py-1.5">${esc(e.username)}</td>
          <td class="px-2.5 py-1.5">${esc(e.role_name || e.role)}</td><td class="px-2.5 py-1.5 whitespace-nowrap">${esc(e.ip)}</td>
          <td class="px-2.5 py-1.5 ${e.ok ? 'text-emerald-300' : 'text-rose-300'}">${e.ok ? 'успешно' : 'отказ / ошибка'}</td>
          <td class="px-2.5 py-1.5" style="overflow-wrap:anywhere; max-width:340px">${esc(e.details)}</td></tr>`).join('')}</tbody></table>` : '<p class="p-4 text-sm text-slate-500 text-center">Событий по этим условиям нет.</p>';
    $('#secPage').textContent = d.total ? `${state.offset + 1}–${Math.min(state.offset + SEC_PAGE, d.total)} из ${d.total}` : '';
    $('#secPrev').disabled = state.offset <= 0;
    $('#secNext').disabled = state.offset + SEC_PAGE >= d.total;
  };
  form.onsubmit = (e) => { e.preventDefault(); state.offset = 0; draw(); };
  $('#secPrev').onclick = () => { state.offset = Math.max(0, state.offset - SEC_PAGE); draw(); };
  $('#secNext').onclick = () => { state.offset += SEC_PAGE; draw(); };
  $('#secExport').onclick = () => { window.location.href = '/api/security/events/export?' + query().toString(); };
  await draw();
}
