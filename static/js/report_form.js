// Форма «Отчёт о выезде» — общая для календаря и «Мониторинга»: диспетчер может поправить в отчёте каждый пункт
// (исполнитель, тип выезда, статус, итог работ, что неисправно и что нужно, оборудование, SIM-карта, питание комплекса,
// время отчёта). Данные задания, комплекса и бригады форма берёт сама (GET /api/task-visit-reports/{id}/context), поэтому
// открывается где угодно. Подключается после ui.js; на странице должны быть close() и #modal.
//
// Отчёт по заданию (см. app/repositories/task_visit_reports_repository.py): тип выезда — это tasks.type, зафиксированный
// диспетчером при создании задания (см. jobForm). Сохранение сразу переводит комплекс в соответствующий статус на сервере
// (Демонтирован → «На складе» + запись в warehouse_items, Установлен → новый статус, иначе — буквально Работает/Не работает).
// RESULT_STATUSES/EQUIPMENT_VISIT_TYPES/WORK_TYPE_OUTCOMES приходят из ui.js.
//
// visitReportForm(taskId, { onDone }) — onDone вызывается после успешного сохранения (вместо простого закрытия окна).
const SIM_STATE_OPTIONS = [['', 'не указано'], ['working', 'рабочая — можно выдать снова'], ['defective', 'нерабочая — на списание']];

function _toLocalInput(iso) {
  const d = new Date(iso);
  if (!iso || Number.isNaN(d.getTime())) return '';
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function visitReportForm(taskId, opts = {}) {
  let ctx;
  try { ctx = await Api.get('/api/task-visit-reports/' + encodeURIComponent(taskId) + '/context'); }
  catch (e) { alert('Не удалось открыть отчёт: ' + e.message); return; }
  const task = ctx.task, point = ctx.point, existing = ctx.report;
  if (!task.point) { alert('У задания не указана точка'); return; }
  if (task.is_aux) { alert('Вспомогательная точка — метка на карте, отчёт по ней не нужен.'); return; }
  if (!task.type) { alert('У задания не указан тип работы — откройте задание (✎) и выберите тип.'); return; }

  const r = existing || { result_status: '', outcome: '', comment: '', equipment_removed: '', equipment_installed: '', sim_removed: '', sim_installed: '', sim_removed_state: '' };
  // Итоговый тип выезда: тот, что записан в отчёте (монтёр мог включить режим ремонта — «<тип> + Ремонт»), иначе тип
  // задания. Его можно поменять: например, монтёр случайно нажал «режим ремонта», а делал только замеры.
  const storedType = r.visit_type || task.type;
  const storedRepair = / \+ Ремонт$/.test(storedType);
  const storedBase = storedType.replace(/ \+ Ремонт$/, '');
  const typeNames = VISIT_TYPES.filter((n) => n !== 'Вспомогательная точка');
  if (!typeNames.includes(storedBase)) typeNames.push(storedBase);
  // Кто проводил работы: сначала участники бригады задания, затем остальные монтёры. Диспетчер, пишущий отчёт с нуля,
  // обязан выбрать человека; у готового отчёта автор остаётся прежним (его можно сменить явно).
  const crewIds = new Set(ctx.crew_member_ids || []);
  const crewPeople = ctx.people.filter((p) => crewIds.has(p.id));
  const otherFitters = ctx.people.filter((p) => !crewIds.has(p.id) && p.role_type === 'fitter');
  const personOpt = (p) => `<option value="${p.id}" ${r.author_person_id === p.id ? 'selected' : ''}>${esc(p.full_name)}</option>`;
  const alreadyDemontaged = !!existing && existing.result_status === 'Демонтирован';
  const blankStatus = !!existing && !existing.result_status && !existing.outcome;       // отчёт из таблицы Яндекс Форм мог прийти без статуса
  const hasSim = !!(r.sim_removed || r.sim_installed);
  const reportedLocal = existing ? _toLocalInput(existing.created_at) : '';
  // Итоги зависят от типа работы: у связанного с ремонтом типа (и у визита, переведённого монтёром в режим ремонта —
  // «<тип> + Ремонт») — статус комплекса (Работает / Не работает / Демонтирован / Установлен); у остальных — «статусы выезда»
  // этого типа из «Настройки → Типы выездов», как кнопки итога в боте. Если у типа своих статусов не задано — стандартные.

  modal(`<h2 class="font-display text-lg font-bold mb-1">Отчёт о выезде</h2>
    <p class="text-xs text-slate-400 mb-1">${esc(task.point)} · ${esc(point.address || task.address || '')} · назначено: ${esc(task.type)}${task.crew_name ? ' · ' + esc(task.crew_name) : ''}</p>
    ${existing && existing.source === 'forms' ? '<p class="text-[11px] text-amber-300/90 mb-2">Отчёт загружен из таблицы Яндекс Форм — проверьте и при необходимости поправьте любой пункт.</p>' : ''}
    <form id="visitReportFormEl" class="space-y-4 mt-3">
      <label class="${labelCls}">Кто проводил работы на комплексе ${existing ? '' : '<span class="font-normal text-rose-300">(обязательно)</span>'}
        <select name="author" ${existing ? '' : 'required'} class="${fieldCls}">
          ${existing && !r.author_person_id ? `<option value="">— не менять (${esc(r.created_by || 'не указан')}) —</option>` : '<option value="">— выберите —</option>'}
          ${crewPeople.length ? `<optgroup label="Бригада">${crewPeople.map(personOpt).join('')}</optgroup>` : ''}
          ${otherFitters.length ? `<optgroup label="Остальные монтёры">${otherFitters.map(personOpt).join('')}</optgroup>` : ''}
        </select></label>
      <p class="text-[11px] text-slate-500 -mt-2">${existing
        ? `Автор отчёта при правке не меняется${r.updated_by ? ` (последняя правка: ${esc(r.updated_by)})` : ''} — выберите другого человека, только если нужно исправить исполнителя.`
        : 'В системе автором отчёта будет указан этот человек (его ФИО), а не логин диспетчера.'}</p>
      <div class="grid grid-cols-2 gap-3 items-end">
        <label class="${labelCls}">Тип выезда (итог)<select name="visit_type" class="${fieldCls}">
          ${typeNames.map((n) => `<option value="${esc(n)}" ${n === storedBase ? 'selected' : ''}>${esc(n)}</option>`).join('')}
        </select></label>
        <label id="vtRepairBox" class="flex items-center gap-1.5 text-xs text-slate-300" style="padding-bottom:.5rem"><input type="checkbox" name="with_repair" class="rounded accent-indigo-500" ${storedRepair ? 'checked' : ''}> был ремонт («… + Ремонт»)</label>
      </div>
      <p class="text-[11px] text-slate-500 -mt-2">Попадает в отчёты и выгрузки. Если монтёр по ошибке включил режим ремонта — уберите отметку «был ремонт» или выберите фактический тип.</p>
      <label class="${labelCls}"><span id="vtStatusLabel">Статус</span><select name="result_status" ${blankStatus ? '' : 'required'} class="${fieldCls}"></select></label>
      <p id="vtOutcomeNote" class="hidden text-[11px] text-slate-500 -mt-2">Только запись в отчёте и статистике — статус комплекса не меняется.</p>
      <label class="${labelCls}">Итог работ<textarea name="comment" rows="5" class="${fieldCls}">${esc(r.comment)}</textarea></label>
      <div id="reportFaultRow" class="hidden space-y-3">
        <label class="${labelCls}"><span id="reportFaultLabel">Причина неисправности</span><textarea name="fault" rows="2" class="${fieldCls}">${esc(r.fault || '')}</textarea></label>
        <label id="reportNeedsLabel" class="${labelCls}">Что нужно для исправления <span class="font-normal text-slate-500">(комплекс не заработал)</span><textarea name="needs" rows="2" class="${fieldCls}">${esc(r.needs || '')}</textarea></label>
      </div>
      <div id="reportEquipmentRow" class="hidden grid grid-cols-2 gap-3">
        <label class="${labelCls}">Снято оборудование<input name="equipment_removed" value="${esc(r.equipment_removed || '')}" class="${fieldCls}"></label>
        <label class="${labelCls}">Установлено оборудование<input name="equipment_installed" value="${esc(r.equipment_installed || '')}" class="${fieldCls}"></label>
      </div>
      <div id="reportSimRow" class="${hasSim ? '' : 'hidden '}space-y-2 rounded-xl border border-slate-700/60 bg-slate-800/20 p-3">
        <b class="text-xs">💳 SIM-карта <span class="font-normal text-slate-500">— отдельно от остального оборудования</span></b>
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls}">SIM снята (номер)<input name="sim_removed" value="${esc(r.sim_removed || '')}" placeholder="если SIM меняли" class="${fieldCls}"></label>
          <label class="${labelCls}">SIM установлена (номер)<input name="sim_installed" value="${esc(r.sim_installed || '')}" class="${fieldCls}"></label>
        </div>
        <label class="${labelCls}">Состояние снятой SIM<select name="sim_removed_state" class="${fieldCls}">
          ${SIM_STATE_OPTIONS.map(([v, l]) => `<option value="${v}" ${(r.sim_removed_state || '') === v ? 'selected' : ''}>${l}</option>`).join('')}
        </select></label>
        <p class="text-[11px] text-slate-500">В учёте оборудования эта запись сама не меняется — замену SIM оформляет монтёр в боте или склад на странице «Склад».</p>
      </div>
      <div class="grid grid-cols-2 gap-3">
        ${powerSourceFieldHtml(point.power_source || '')}
        <label class="${labelCls} col-span-2">Время отчёта <span class="font-normal text-slate-500">(по часам вашего компьютера${existing ? '' : '; пусто — сейчас'})</span>
          <input type="datetime-local" name="reported" value="${esc(reportedLocal)}" class="${fieldCls}"></label>
      </div>
      <div id="reportDemRow" class="hidden space-y-2 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3">
        <b class="text-xs">Что демонтировано</b>
        <label class="flex items-center gap-1.5 text-xs"><input type="radio" name="dem_mode" value="whole" checked class="accent-indigo-500"> Весь комплекс — уйдёт на склад целиком</label>
        <label class="flex items-center gap-1.5 text-xs"><input type="radio" name="dem_mode" value="parts" class="accent-indigo-500"> Только отдельные элементы</label>
        <div id="reportDemParts" class="hidden space-y-2">
          <div id="reportDemItems" class="space-y-1 max-h-40 overflow-auto"></div>
          <label class="${labelCls}">Ещё снято (чего нет в списке оборудования)<input name="dem_other" class="${fieldCls}" placeholder="например: кронштейн, кабель"></label>
          <label class="${labelCls}">Состояние комплекса после демонтажа<select name="dem_after" class="${fieldCls}"><option value="Работает">Работает</option><option value="Не работает">Не работает</option></select></label>
        </div>
        <p class="text-[11px] text-slate-500">Снятое оборудование запишется на исполнителя (числится у него как снятое — ждёт приёмки на склад), а перечень попадёт в текст отчёта.</p>
      </div>
      <p id="reportDismantleRow" class="hidden text-xs text-amber-300/90">Комплекс уже оформлен как демонтированный («На складе»): все его компоненты отмечены как находящиеся на складе. Состав и описание компонентов можно уточнить в карточке на странице «Склад».</p>
      <div id="visitReportError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">${can('reports.edit') ? 'Отмена' : 'Закрыть'}</button>
        <button data-perm="reports.edit" class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);

  const form = $('#visitReportFormEl');
  const f = form.elements;
  if (!can('reports.edit')) {            // права «Вносить и править отчёты» нет — отчёт только для чтения (запрет на сервере действует в любом случае)
    form.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = true; });
    form.insertAdjacentHTML('afterbegin', '<p class="text-[11px] text-amber-300/90 mb-2">Только просмотр: у вашей роли нет права вносить и править отчёты.</p>');
  }
  wirePowerSourceField(form);
  // Что показывать в «Статусе» и в строке оборудования, зависит от выбранного типа и отметки «был ремонт».
  let mode = { useOutcomes: false, repairVisit: false };
  const refresh = () => {
    const base = f.visit_type.value;
    const baseRepair = EQUIPMENT_VISIT_TYPES.has(base);
    $('#vtRepairBox').classList.toggle('hidden', baseRepair);
    const withRepair = !baseRepair && f.with_repair.checked;
    const repairVisit = baseRepair || withRepair;
    const outcomeList = repairVisit ? [] : [...(WORK_TYPE_OUTCOMES[base] || [])];
    const useOutcomes = outcomeList.length > 0;
    // Прежний итог мог быть записан с другим набором статусов (тип поменяли, отчёт из формы) — оставляем его в списке,
    // чтобы он не пропал при сохранении.
    if (r.outcome && !repairVisit && !outcomeList.includes(r.outcome)) outcomeList.push(r.outcome);
    const useOut = useOutcomes || (!repairVisit && !!r.outcome);
    const options = useOut ? outcomeList : RESULT_STATUSES;
    const keep = f.result_status.value || (useOut ? (r.outcome || '') : (r.result_status || ''));
    f.result_status.innerHTML = `<option value="">${blankStatus ? '— не указан —' : '— выберите —'}</option>${options.map((s) => `<option value="${esc(s)}" ${keep === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}`;
    $('#vtStatusLabel').textContent = useOut ? 'Статус выезда' : 'Статус';
    $('#vtOutcomeNote').classList.toggle('hidden', !useOut);
    $('#reportEquipmentRow').classList.toggle('hidden', !repairVisit);
    $('#reportSimRow').classList.toggle('hidden', !repairVisit && !hasSim && !f.sim_removed.value && !f.sim_installed.value);
    mode = { useOutcomes: useOut, repairVisit, base, withRepair };
    syncDem(useOut);
    syncFault();
  };
  // Причина неисправности — у любого ремонта (в чём она была, даже если комплекс заработал) и у «Не работает»; «что нужно для исправления» — только если не заработал.
  const syncFault = () => {
    const broken = f.result_status.value === 'Не работает';
    $('#reportFaultRow').classList.toggle('hidden', mode.useOutcomes || !(mode.repairVisit || broken || f.fault.value.trim()));
    $('#reportNeedsLabel').classList.toggle('hidden', !broken);
    $('#reportFaultLabel').textContent = broken ? 'Что неисправно' : 'Причина неисправности';
  };
  // «Демонтирован»: при новом демонтаже выбираем — весь комплекс или отдельные элементы; если отчёт уже оформлен как
  // демонтаж — только напоминание (повторно оборудование не списывается).
  let demLoaded = false;
  const syncDem = (useOutcomes) => {
    const isDem = !useOutcomes && f.result_status.value === 'Демонтирован';
    $('#reportDemRow').classList.toggle('hidden', !isDem || alreadyDemontaged);
    $('#reportDismantleRow').classList.toggle('hidden', !isDem || !alreadyDemontaged);
    if (isDem && !alreadyDemontaged && !demLoaded) {
      demLoaded = true;
      Api.get('/api/task-visit-reports/point-equipment/' + encodeURIComponent(task.point)).then((items) => {
        $('#reportDemItems').innerHTML = items.length
          ? items.map((i) => `<label class="flex items-center gap-1.5 text-xs"><input type="checkbox" data-demitem="${i.id}" class="rounded accent-indigo-500"> ${esc(i.label)}</label>`).join('')
          : '<p class="text-[11px] text-slate-500">По учёту на комплексе оборудования нет — опишите снятое в поле ниже.</p>';
      }).catch(() => { $('#reportDemItems').innerHTML = '<p class="text-[11px] text-slate-500">Список оборудования не загрузился.</p>'; });
    }
  };
  document.querySelectorAll('#visitReportFormEl [name="dem_mode"]').forEach((rb) => {
    rb.onchange = () => $('#reportDemParts').classList.toggle('hidden', f.dem_mode.value !== 'parts');
  });
  f.visit_type.onchange = () => { f.result_status.value = ''; refresh(); };
  f.with_repair.onchange = () => { f.result_status.value = ''; refresh(); };
  f.result_status.onchange = () => {
    syncDem(mode.useOutcomes);
    syncFault();
  };
  refresh();

  form.onsubmit = async (e) => {
    e.preventDefault();
    const showError = (text) => { $('#visitReportError').textContent = text; $('#visitReportError').classList.remove('hidden'); };
    let demontage = null;
    let status = f.result_status.value;
    if (!mode.useOutcomes && status === 'Демонтирован' && !alreadyDemontaged) {
      const parts = f.dem_mode.value === 'parts';
      demontage = { mode: parts ? 'parts' : 'whole', ids: [], other: '' };
      if (parts) {
        demontage.ids = [...document.querySelectorAll('#reportDemItems [data-demitem]:checked')].map((c) => +c.dataset.demitem);
        demontage.other = f.dem_other.value.trim();
        if (!demontage.ids.length && !demontage.other) { showError('Отметьте, что демонтировано, или выберите «Весь комплекс».'); return; }
        status = f.dem_after.value;   // комплекс целиком не демонтирован — итоговое состояние выбрано отдельно
      }
    }
    const v = {
      author_person_id: f.author.value ? +f.author.value : null, demontage,
      result_status: mode.useOutcomes ? '' : status,
      outcome: mode.useOutcomes ? f.result_status.value : '',
      comment: f.comment.value.trim(),
      equipment_removed: mode.repairVisit ? (f.equipment_removed?.value.trim() || null) : null,
      equipment_installed: mode.repairVisit ? (f.equipment_installed?.value.trim() || null) : null,
      sim_removed: f.sim_removed.value.trim(), sim_installed: f.sim_installed.value.trim(),
      sim_removed_state: f.sim_removed.value.trim() ? f.sim_removed_state.value : '',
      visit_type: mode.base, with_repair: mode.withRepair,
      fault: mode.useOutcomes ? '' : f.fault.value.trim(),
      needs: !mode.useOutcomes && status === 'Не работает' ? f.needs.value.trim() : '',
    };
    const power = readPowerSource(form);
    if (power !== (point.power_source || '')) v.power_source = power;
    if (f.reported.value && f.reported.value !== reportedLocal) {
      const when = new Date(f.reported.value);
      if (Number.isNaN(when.getTime())) { showError('Неверное время отчёта.'); return; }
      v.created_at = when.toISOString();
    }
    try {
      await Api.put('/api/task-visit-reports/' + encodeURIComponent(taskId), v);
      close();
      if (opts.onDone) await opts.onDone();
    } catch (err) {
      showError(err.message);
    }
  };
}
