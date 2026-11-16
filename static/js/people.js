// Personnel (монтёры/водители/операторы) — the pool crewForm() in app.js
// picks from when assembling a team for a given day.
const roleTypeLabel = { fitter: 'Монтёр', driver: 'Водитель', operator: 'Оператор', warehouse: 'Склад' };
// Водитель бывает обычный, вышки или прикрытия (роль остаётся «водитель», вид — отдельное поле driver_kind).
const driverKindLabel = { tower: 'Водитель вышки', cover: 'Водитель прикрытия' };
const personRoleLabel = (p) => (p.role_type === 'driver' && driverKindLabel[p.driver_kind]) || roleTypeLabel[p.role_type] || p.role_type;

function fmtRequestedAt(iso) {
  try {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p2 = (n) => String(n).padStart(2, '0');
    return `${p2(d.getDate())}-${p2(d.getMonth() + 1)}-${d.getFullYear()} ${p2(d.getHours())}:${p2(d.getMinutes())}`;
  } catch { return iso; }
}

async function openPeoplePanel() {
  let people = [];
  let joinRequests = [];
  try { people = await Api.get('/api/people'); } catch (e) { alert('Не удалось загрузить персонал: ' + e.message); return; }
  try { joinRequests = await Api.get('/api/join-requests'); } catch { /* non-fatal — panel still works without it */ }

  // Выбранная заявка из бота: ждём, к чьей карточке диспетчер добавит её VK ID.
  let linkTarget = null; // { vk_id, name }

  modal(`<h2 class="font-display text-lg font-bold mb-4">Персонал</h2>

    ${joinRequests.length ? `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-5">
      <b class="text-sm block mb-1">Заявки из бота</b>
      <p class="text-xs text-slate-400 mb-3">Человек написал боту, но его VK ID ещё не привязан. Нажмите «Привязать к карточке» и выберите его в списке ниже.</p>
      <div class="space-y-2">
        ${joinRequests.map((r) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 flex items-center justify-between gap-2">
          <span class="text-sm flex items-center gap-2 min-w-0 flex-wrap">
            <span class="truncate">${esc(r.vk_name || 'Без имени')}</span>
            <span class="text-xs text-indigo-300 select-all">VK ${r.vk_id}</span>
            ${r.status === 'blocked'
              ? '<span class="text-[11px] text-rose-300">заблокирован</span>'
              : `<span class="text-[11px] text-slate-500">${fmtRequestedAt(r.requested_at)}</span>`}
          </span>
          <span class="flex items-center gap-1.5 shrink-0">
            ${r.status === 'pending'
              ? `<button data-link-request="${r.vk_id}" data-name="${esc(r.vk_name || '')}" class="${btnPrimary} !py-1 !px-2 text-xs">Привязать к карточке</button>
                 <button data-block-request="${r.vk_id}" class="${btnDanger} !py-1 !px-2 text-xs">Заблокировать</button>`
              : `<button data-unblock-request="${r.vk_id}" class="${btnGhost} !py-1 !px-2 text-xs">Разблокировать</button>`}
          </span>
        </div>`).join('')}
      </div>
    </div>` : ''}

    <input id="peopleSearch" type="search" autocomplete="off" placeholder="Поиск по ФИО, телефону, VK ID, примечанию…" class="${fieldCls} mb-3">
    <div id="linkBanner" class="hidden rounded-xl border border-indigo-400/40 bg-indigo-500/10 px-3 py-2 mb-3"></div>
    <div id="peopleList" class="space-y-2 mb-5 max-h-72 overflow-auto pr-1"></div>

    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4">
      <b class="text-sm block mb-3" id="peopleFormTitle">Добавить человека</b>
      <form id="personForm" class="space-y-3">
        <input type="hidden" name="id">
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls} col-span-2">ФИО<input name="full_name" required class="${fieldCls}"></label>
          <label class="${labelCls}">Роль<select name="role_type" class="${fieldCls}">
            <option value="fitter">Монтёр</option>
            <option value="driver">Водитель</option>
            <option value="driver:tower">Водитель вышки</option>
            <option value="driver:cover">Водитель прикрытия</option>
            <option value="operator">Оператор</option>
            <option value="warehouse">Склад (принимает и выдаёт оборудование в боте)</option>
          </select></label>
          <label class="${labelCls}">Телефон<input name="phone" class="${fieldCls}"></label>
          <label class="${labelCls}">VK ID<input name="vk_id" type="number" placeholder="для бота" class="${fieldCls}"></label>
          <label class="${labelCls} col-span-2">Примечание<input name="notes" class="${fieldCls}"></label>
          <label class="flex items-center gap-1.5 text-xs text-slate-300 col-span-2 hidden" id="activeRow">
            <input type="checkbox" name="active" checked class="rounded accent-indigo-500"> Активен
          </label>
        </div>
        <div id="personFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
        <div class="flex items-center gap-2">
          <button class="${btnPrimary}">Сохранить</button>
          <button type="button" id="personFormReset" class="hidden ${btnGhost}">Отмена</button>
        </div>
      </form>
    </div>

    <div class="flex items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
    </div>`);

  const form = $('#personForm');
  const resetForm = () => {
    form.reset();
    form.elements.id.value = '';
    $('#peopleFormTitle').textContent = 'Добавить человека';
    $('#activeRow').classList.add('hidden');
    $('#personFormReset').classList.add('hidden');
  };

  // ---- список с поиском (слова — в любом порядке: «иван петров» найдёт «Петров Иван»)
  const hay = (p) => [p.full_name, personRoleLabel(p), p.phone, p.vk_id ? `vk ${p.vk_id}` : '', p.notes, p.active ? '' : 'неактивен']
    .filter(Boolean).join(' ').toLowerCase();
  const rowHtml = (p) => `<div class="rounded-xl border ${linkTarget && !p.vk_id ? 'border-indigo-400/40' : 'border-slate-700/50'} bg-slate-800/30 p-3 flex items-center justify-between gap-2">
        <span class="text-sm flex items-center gap-2 min-w-0 flex-wrap">
          <span class="truncate">${esc(p.full_name)}</span>
          <span class="rounded-full bg-slate-700/60 text-slate-300 text-[11px] font-medium px-2 py-0.5">${personRoleLabel(p)}</span>
          ${p.phone ? `<span class="text-xs text-slate-400">${esc(p.phone)}</span>` : ''}
          ${p.vk_id ? `<span class="text-xs text-indigo-300">VK ${esc(p.vk_id)}</span>` : ''}
          ${!p.active ? '<span class="text-[11px] text-slate-500">неактивен</span>' : ''}
        </span>
        <span class="flex items-center gap-1.5 shrink-0">
          ${linkTarget ? `<button data-link-person="${p.id}" class="${btnPrimary} !py-1 !px-2 text-xs">${p.vk_id ? 'Заменить ID' : 'Добавить ID сюда'}</button>` : ''}
          <button data-person-tasks="${p.id}" class="${btnGhost} !py-1 !px-2 text-xs">Задания</button>
          <button data-absence="${p.id}" class="${btnGhost} !py-1 !px-2 text-xs">Отсутствия</button>
          <button data-edit="${p.id}" class="${btnGhost} !py-1 !px-2 text-xs">Изменить</button>
          <button data-remove="${p.id}" class="${btnDanger} !py-1 !px-2 text-xs">Удалить</button>
        </span>
      </div>`;

  const renderList = () => {
    const tokens = $('#peopleSearch').value.trim().toLowerCase().split(/\s+/).filter(Boolean);
    let list = people.filter((p) => tokens.every((t) => hay(p).includes(t)));
    // Ищем карточку для нового ID — сначала те, у кого VK ID ещё нет.
    if (linkTarget) list = [...list].sort((x, y) => (x.vk_id ? 1 : 0) - (y.vk_id ? 1 : 0));
    $('#peopleList').innerHTML = list.map(rowHtml).join('')
      || `<p class="text-sm text-slate-500">${people.length ? 'Никого не найдено' : 'Персонала нет'}</p>`;

    $('#peopleList').querySelectorAll('[data-edit]').forEach((btn) => {
      btn.onclick = () => {
        const p = people.find((x) => x.id === +btn.dataset.edit);
        if (!p) return;
        const f = form.elements;
        f.id.value = p.id;
        f.full_name.value = p.full_name;
        f.role_type.value = p.role_type === 'driver' && p.driver_kind ? `driver:${p.driver_kind}` : p.role_type;
        f.phone.value = p.phone || '';
        f.vk_id.value = p.vk_id || '';
        f.notes.value = p.notes || '';
        f.active.checked = p.active;
        $('#peopleFormTitle').textContent = `Изменить: ${p.full_name}`;
        $('#activeRow').classList.remove('hidden');
        $('#personFormReset').classList.remove('hidden');
        form.scrollIntoView({ behavior: 'smooth', block: 'center' });
      };
    });
    $('#peopleList').querySelectorAll('[data-remove]').forEach((btn) => {
      btn.onclick = () => confirmErasePerson(+btn.dataset.remove);
    });
    $('#peopleList').querySelectorAll('[data-absence]').forEach((btn) => {
      btn.onclick = () => absenceForm(+btn.dataset.absence, people.find((x) => x.id === +btn.dataset.absence));
    });
    $('#peopleList').querySelectorAll('[data-person-tasks]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          const data = await Api.get(`/api/people/${btn.dataset.personTasks}/tasks`);
          const rows = data.items || [];
          modal(`<h2 class="font-display text-lg font-bold mb-3">Задания: ${esc(data.person)}</h2>
            <div class="max-h-[65vh] overflow-auto space-y-2">${rows.map((r) => `<article class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 space-y-1">
              <b class="text-sm">${esc(r.date || '')}${r.date_to && r.date_to !== r.date ? ` — ${esc(r.date_to)}` : ''} · ${esc(r.point || 'без комплекса')}</b>
              <div class="text-xs text-slate-400">${esc(r.type || r.work || 'Задание')}${r.crew ? ` · ${esc(r.crew)}` : ''}${r.address ? ` · ${esc(r.address)}` : ''}</div>
              ${r.result || r.outcome ? `<div class="text-xs text-emerald-300">Итог: ${esc(r.result || r.outcome)}${r.outcome && r.result ? ` · ${esc(r.outcome)}` : ''}</div>` : '<div class="text-xs text-slate-500">Отчёт не заполнен</div>'}
              ${r.comment ? `<div class="text-xs">${esc(r.comment)}</div>` : ''}${r.fault ? `<div class="text-xs text-amber-300">Неисправность: ${esc(r.fault)}</div>` : ''}${r.needs ? `<div class="text-xs text-amber-300">Нужно: ${esc(r.needs)}</div>` : ''}
            </article>`).join('') || '<p class="text-sm text-slate-400">Заданий не найдено.</p>'}</div>
            <div class="flex justify-end mt-3"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`);
        } catch (err) { alert('Не удалось загрузить задания: ' + err.message); }
      };
    });
    $('#peopleList').querySelectorAll('[data-link-person]').forEach((btn) => {
      btn.onclick = async () => {
        const p = people.find((x) => x.id === +btn.dataset.linkPerson);
        if (!p || !linkTarget) return;
        if (p.vk_id && p.vk_id !== linkTarget.vk_id && !confirm(`У «${p.full_name}» уже указан VK ID ${p.vk_id}. Заменить на ${linkTarget.vk_id}?`)) return;
        try {
          await Api.put(`/api/people/${p.id}`, {
            full_name: p.full_name, phone: p.phone, role_type: p.role_type, driver_kind: p.driver_kind || '',
            vk_id: linkTarget.vk_id, active: p.active, notes: p.notes,
          });
          await openPeoplePanel(); // заявка с этим ID исчезнет сама
        } catch (err) { alert(err.message); }
      };
    });
  };

  const renderBanner = () => {
    const el = $('#linkBanner');
    if (!linkTarget) { el.classList.add('hidden'); el.innerHTML = ''; return; }
    el.classList.remove('hidden');
    el.innerHTML = `<div class="text-sm">Куда добавить VK ID <b class="text-indigo-300 select-all">${linkTarget.vk_id}</b>${linkTarget.name ? ` («${esc(linkTarget.name)}»)` : ''}?
        Найдите человека в списке и нажмите «Добавить ID сюда».</div>
      <div class="flex flex-wrap gap-2 mt-2">
        <button type="button" id="linkCancel" class="${btnGhost} !py-1 !px-2 text-xs">Отмена</button>
        <button type="button" id="linkNew" class="${btnGhost} !py-1 !px-2 text-xs" title="Если человека ещё нет в списке">Создать новую карточку</button>
      </div>`;
    $('#linkCancel').onclick = () => { linkTarget = null; renderBanner(); renderList(); };
    $('#linkNew').onclick = () => {
      resetForm();
      form.elements.vk_id.value = linkTarget.vk_id;
      form.elements.full_name.value = linkTarget.name || '';
      $('#peopleFormTitle').textContent = 'Добавить человека (по заявке)';
      form.elements.full_name.focus();
      form.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  };

  $('#peopleSearch').oninput = renderList;
  // Enter в строке поиска не должен ничего отправлять.
  $('#peopleSearch').onkeydown = (e) => { if (e.key === 'Enter') e.preventDefault(); };
  renderList();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const f = form.elements;
    const payload = {
      full_name: f.full_name.value.trim(),
      phone: f.phone.value.trim() || null,
      role_type: f.role_type.value.split(':')[0],
      driver_kind: f.role_type.value.includes(':') ? f.role_type.value.split(':')[1] : '',
      vk_id: f.vk_id.value.trim() ? +f.vk_id.value : null,
      notes: f.notes.value.trim() || null,
    };
    try {
      if (f.id.value) { payload.active = f.active.checked; await Api.put(`/api/people/${f.id.value}`, payload); }
      else await Api.post('/api/people', payload);
      await openPeoplePanel();
    } catch (err) {
      $('#personFormError').textContent = err.message;
      $('#personFormError').classList.remove('hidden');
    }
  };
  $('#personFormReset').onclick = resetForm;

  $('#modal').querySelectorAll('[data-link-request]').forEach((btn) => {
    btn.onclick = () => {
      linkTarget = { vk_id: +btn.dataset.linkRequest, name: btn.dataset.name || '' };
      $('#peopleSearch').value = '';
      renderBanner();
      renderList();
      $('#peopleSearch').focus();
      $('#linkBanner').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  });
  $('#modal').querySelectorAll('[data-block-request]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Заблокировать этот VK ID? Бот перестанет отвечать этому пользователю и принимать от него новые заявки.')) return;
      try { await Api.post(`/api/join-requests/${btn.dataset.blockRequest}/block`, {}); await openPeoplePanel(); }
      catch (err) { alert(err.message); }
    };
  });
  $('#modal').querySelectorAll('[data-unblock-request]').forEach((btn) => {
    btn.onclick = async () => {
      try { await Api.post(`/api/join-requests/${btn.dataset.unblockRequest}/unblock`, {}); await openPeoplePanel(); }
      catch (err) { alert(err.message); }
    };
  });
}

// Periods when a person is unavailable (vacation, sick leave, etc.), with a
// reason — crewForm() in app.js greys these people out on the affected dates.
async function absenceForm(personId, person) {
  let absences = [];
  try { absences = await Api.get(`/api/people/${personId}/absences`); }
  catch (e) { alert('Не удалось загрузить отсутствия: ' + e.message); return; }

  modal(`<h2 class="font-display text-lg font-bold mb-1">Отсутствия${person ? `: ${esc(person.full_name)}` : ''}</h2>
    <p class="text-sm text-slate-400 mb-4">Периоды, когда человек недоступен для назначения в бригаду.</p>
    <div class="space-y-2 mb-4 max-h-56 overflow-auto pr-1">
      ${absences.map((a) => `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3 flex items-center justify-between gap-2">
        <span class="text-sm">${esc(fmtDate(a.start_date))} — ${esc(fmtDate(a.end_date))}${a.reason ? `<br><span class="text-slate-400 text-xs">${esc(a.reason)}</span>` : ''}</span>
        <button data-del-absence="${a.id}" class="${btnDanger} !py-1 !px-2 text-xs">Удалить</button>
      </div>`).join('') || '<p class="text-sm text-slate-500">Отсутствий не отмечено</p>'}
    </div>
    <form id="newAbsenceForm" class="space-y-3">
      <div class="grid grid-cols-2 gap-3">
        <label class="${labelCls}">С<input type="date" name="start_date" required value="${D}" class="${fieldCls}"></label>
        <label class="${labelCls}">По<input type="date" name="end_date" required value="${D}" class="${fieldCls}"></label>
      </div>
      <label class="${labelCls}">Причина<input name="reason" placeholder="отпуск, больничный..." class="${fieldCls}"></label>
      <div id="absenceFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2">
        <button type="button" class="cancel ${btnGhost}">Закрыть</button>
        <button class="${btnPrimary}">Добавить период</button>
      </div>
    </form>`);

  $('#newAbsenceForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await Api.post(`/api/people/${personId}/absences`, {
        start_date: f.start_date.value,
        end_date: f.end_date.value,
        reason: f.reason.value.trim() || null,
      });
      await absenceForm(personId, person);
    } catch (err) {
      $('#absenceFormError').textContent = err.message;
      $('#absenceFormError').classList.remove('hidden');
    }
  };
  $('#modal').querySelectorAll('[data-del-absence]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Удалить период отсутствия?')) return;
      try { await Api.del(`/api/people/${personId}/absences/${btn.dataset.delAbsence}`); await absenceForm(personId, person); }
      catch (err) { alert(err.message); }
    };
  });
}

$('#peopleBtn').onclick = () => { closeDropdowns(); openPeoplePanel(); };


// Удаление сотрудника: окно подтверждения со списком того, что будет удалено и обезличено (GET /api/people/{id}/erase-preview), потом DELETE.
// Что именно происходит — app/services/person_erasure.py: личное (запись в персонале, переписка, заявки в бота, отсутствия, составы бригад) удаляется,
// отчёты, фото и движение оборудования остаются для истории, но вместо ФИО в них — «Удалённый сотрудник».
async function confirmErasePerson(personId) {
  let pv;
  try { pv = await Api.get(`/api/people/${personId}/erase-preview`); } catch (err) { alert(err.message); return; }
  const li = (n, text) => (n ? `<li><b>${n}</b> — ${text}</li>` : '');
  const d = pv.delete || {};
  const a = pv.anonymize || {};
  const personal = ['ФИО' + (pv.person.has_phone ? ', телефон' : ''), pv.person.has_vk ? 'VK ID (бот перестанет узнавать этого человека)' : '', pv.person.has_notes ? 'заметки' : ''].filter(Boolean).join(', ');
  const anonTotal = Object.values(a).reduce((x, y) => x + y, 0);
  modal(`<h2 class="font-display text-lg font-bold mb-1">Удалить сотрудника «${esc(pv.person.full_name)}»?</h2>
    ${pv.blocked
      ? `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-sm text-rose-300 my-3">${esc(pv.blocked)}</div>
         <p class="text-xs text-slate-400">Если человек просто уволился, можно оставить его в списке и снять отметку «работает» — он не будет предлагаться в бригады.</p>`
      : `<p class="text-xs text-slate-400 mb-3">После подтверждения всё, что связано с этим человеком, будет убрано или обезличено. <b class="text-rose-300">Отменить это нельзя.</b></p>
         <div class="rounded-xl border border-slate-700/60 bg-slate-800/30 px-3 py-2 mb-2">
           <b class="text-sm">Будет удалено</b>
           <ul class="text-xs space-y-0.5 pl-5 mt-1" style="list-style:disc">
             <li>запись в персонале: ${esc(personal)}</li>
             ${li(d.chat_messages, `сообщений в чате${d.chat_files ? ` (и фото в них: ${d.chat_files})` : ''}`)}
             ${li(d.join_requests, 'заявок на вступление в бота')}
             ${li(d.absences, 'периодов отсутствия')}
             ${li(d.crew_days, 'участий в составах бригад (все дни)')}
             ${li(d.sessions, 'открытых рабочих сессий в боте')}
           </ul>
         </div>
         <div class="rounded-xl border border-amber-500/30 bg-amber-500/5 px-3 py-2 mb-3">
           <b class="text-sm">Будет обезличено</b> <span class="text-[11px] text-slate-400">— записи останутся для истории, но вместо ФИО будет «${esc(pv.anon_name)}»</span>
           <ul class="text-xs space-y-0.5 pl-5 mt-1" style="list-style:disc">
             ${Object.entries(a).map(([group, n]) => li(n, esc(group))).join('') || '<li class="text-slate-500" style="list-style:none">записей с этим именем нет</li>'}
           </ul>
           ${pv.namesakes ? `<p class="text-[11px] text-amber-300 mt-1.5">В персонале есть ещё ${pv.namesakes} с таким же ФИО, поэтому записи, где имя записано только текстом, не тронуты (иначе обезличились бы и чужие). Записи со ссылкой на этого человека обезличены.</p>` : ''}
           <p class="text-[11px] text-slate-500 mt-1.5">Свободный текст в отчётах («что сделано», комментарии) не разбирается: если там кто-то назван по имени, это останется.</p>
         </div>
         <label class="flex items-start gap-2 text-sm cursor-pointer"><input type="checkbox" id="erConfirm" class="rounded accent-rose-500 mt-0.5"> <span>Понимаю: данные будут удалены и обезличены безвозвратно${anonTotal ? '' : ''}</span></label>`}
    <div id="erError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300 mt-3"></div>
    <div class="flex items-center gap-2 pt-4">
      ${pv.blocked ? '' : `<button type="button" id="erGo" class="${btnDanger}" disabled>Удалить и обезличить</button>`}
      <button type="button" id="erBack" class="${btnGhost}">${pv.blocked ? '← К списку' : 'Отмена'}</button>
    </div>`);
  $('#erBack').onclick = () => openPeoplePanel();
  const go = $('#erGo');
  if (!go) return;
  $('#erConfirm').onchange = (e) => { go.disabled = !e.target.checked; };
  go.onclick = async () => {
    go.disabled = true;
    try {
      const res = await Api.del(`/api/people/${personId}`);
      const del = Object.values(res.deleted || {}).reduce((x, y) => x + y, 0);
      const anon = Object.values(res.anonymized || {}).reduce((x, y) => x + y, 0);
      showToast(`Сотрудник удалён. Убрано записей: <b>${del}</b>, обезличено: <b>${anon}</b>.`, 6000);
      await openPeoplePanel();
    } catch (err) {
      const box = $('#erError');
      box.textContent = err.message;
      box.classList.remove('hidden');
      go.disabled = false;
    }
  };
}
