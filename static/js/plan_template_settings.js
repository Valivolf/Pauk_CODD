// Настройка постоянного оформления план-наряда из главного меню «Настройки».
function openPlanTemplateSettings() {
  modal('<p class="text-sm text-slate-400">Загружаю настройки…</p>', { wide: true });
  Api.get('/api/reports/plan-template').then((data) => {
    const vals = data.values || {};
    const fields = data.fields || [];
    const fieldHtml = fields.filter((f) => f.group !== 'Оформление').map((f) => {
      const value = esc(vals[f.key] ?? '');
      const input = f.type === 'textarea'
        ? `<textarea data-plan-field="${f.key}" rows="2" class="${fieldCls} mt-1">${value}</textarea>`
        : `<input data-plan-field="${f.key}" value="${value}" class="${fieldCls} mt-1">`;
      return `<label class="${labelCls} block rounded-xl border border-slate-700/50 bg-slate-800/30 p-2.5">${esc(f.label)}${input}</label>`;
    }).join('');
    modal(`<h2 class="font-display text-lg font-bold mb-1">Шаблон план-наряда</h2>
      <p class="text-xs text-slate-400 mb-4">Измените текст и оформление бланка. Настройки применятся при следующей печати или скачивании план-наряда.</p>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-4 overflow-auto pr-1" style="max-height:70vh">
        <div class="space-y-2">${fieldHtml}
          <label class="${labelCls} block">Сдвиг шапки по вертикали, мм <input id="planShift" type="range" min="-15" max="15" step="1" value="${esc(vals.plan_header_shift_mm ?? '0')}" class="w-full mt-1"><span id="planShiftValue" class="text-xs">${esc(vals.plan_header_shift_mm ?? '0')} мм</span></label>
          <div class="grid grid-cols-2 gap-2">
            <label class="${labelCls}">Размер заголовка <select id="planTitleSize" class="${fieldCls}">${[12, 14, 15, 16, 18, 20, 22, 24].map((n) => `<option value="${n}" ${Number(vals.plan_title_size_pt || 15) === n ? 'selected' : ''}>${n} пт</option>`).join('')}</select></label>
            <label class="${labelCls}">Заголовок по <select id="planTitleAlign" class="${fieldCls}">${[['left','левому краю'],['center','центру'],['right','правому краю']].map(([v,l]) => `<option value="${v}" ${(vals.plan_title_align || 'center') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></label>
          </div>
        </div>
        <div>
          <div class="text-xs font-semibold text-slate-400 mb-2">Приблизительный вид шапки</div>
          <div id="planSettingsPreview" class="rounded-xl bg-white text-slate-900 p-5" style="font-family:'Times New Roman',serif; min-height:16rem"></div>
          <p class="text-[11px] text-slate-500 mt-2">Это эскиз шапки. Полный бланк зависит от состава бригад и заданий.</p>
        </div>
      </div>
      <div id="planSettingsError" class="hidden mt-3 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button><button type="button" id="planSettingsSave" class="${btnPrimary}">Сохранить</button></div>`, { wide: true });
    const preview = () => {
      const values = {};
      document.querySelectorAll('[data-plan-field]').forEach((el) => { values[el.dataset.planField] = el.value; });
      const shift = Number($('#planShift').value) || 0;
      $('#planShiftValue').textContent = `${shift} мм`;
      let title = values.plan_title || 'ПЛАН ЗАДАНИЕ № _____ от «____» _______________ {год} г.';
      const now = new Date();
      const dateParts = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: 'long', year: 'numeric' }).formatToParts(now);
      const part = (key) => dateParts.find((p) => p.type === key)?.value || '';
      title = title.replaceAll('{год}', part('year')).replaceAll('{число}', part('day')).replaceAll('{месяц}', part('month')).replaceAll('{дата}', `${part('day')} ${part('month')} ${part('year')}`);
      $('#planSettingsPreview').innerHTML = `<div style="transform:translateY(${shift}mm)"><div style="text-align:right;white-space:pre-line">УТВЕРЖДАЮ<br>${esc(values.org_title || '')}<br><u>${esc(values.approver_name || '')}</u></div>
        <div style="text-align:${$('#planTitleAlign').value};font-size:${$('#planTitleSize').value}pt;font-weight:bold;margin:20px 0">${esc(title)}</div>
        <div style="border-top:1px solid #999;margin-top:14px;padding-top:8px;font-size:12px">Состав бригады · маршрут · задания и подписи</div></div>`;
    };
    document.querySelectorAll('[data-plan-field],#planShift,#planTitleSize,#planTitleAlign').forEach((el) => el.addEventListener('input', preview));
    preview();
    $('#planSettingsSave').onclick = async () => {
      const values = {};
      document.querySelectorAll('[data-plan-field]').forEach((el) => { values[el.dataset.planField] = el.value; });
      values.plan_header_shift_mm = $('#planShift').value;
      values.plan_title_size_pt = $('#planTitleSize').value;
      values.plan_title_align = $('#planTitleAlign').value;
      try { await Api.put('/api/reports/plan-template', { values }); close(); }
      catch (e) { $('#planSettingsError').textContent = e.message; $('#planSettingsError').classList.remove('hidden'); }
    };
  }).catch((e) => {
    modal(`<p class="text-sm text-rose-300">Не удалось загрузить настройки: ${esc(e.message)}</p><div class="flex justify-end mt-3"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`, { wide: true });
  });
}
