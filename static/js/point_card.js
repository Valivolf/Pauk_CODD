// «Карточка комплекса» на весь экран (календарь и «Все АПК»): открывается ПРОСМОТРОМ — только то, что роль вправе видеть; конфиденциальное (логин, пароль, IP, порт) показывается тем,
// у кого есть право, остальным — замочек и пояснение, какое право нужно. «✎ Редактировать» есть только у тех, кто может менять комплексы (points.edit); правка — в этой же карточке.
// Внутри: сведения о комплексе, неисправность, подгруппы и план, фото (с загрузкой на выбранную дату — окно «Фото комплекса»), файлы при комплексе (документы, схемы, фото —
// загрузка перетаскиванием или кнопкой) и просмотр файлов прямо на сайте: изображение, PDF, Word, Excel, текст — с переключением стрелками ← →.
// Сервер: app/api/routes_point_files.py (файлы), app/api/routes_points.py (сам комплекс). Зависит от ui.js (esc, can, Api, модальные окна, просмотр фото, поля формы).
(function () {
  'use strict';

  const RIGHT = { secrets: 'Видеть и копировать логины и пароли комплексов', network: 'Видеть IP-адрес и порт', edit: 'Менять комплексы' };
  const KIND_ICON = { image: '🖼', pdf: '📕', docx: '📘', xlsx: '📗', text: '📄', pptx: '📙', office_old: '📎', other: '📎' };
  const EMPTY_POINT = { id: '', address: '', description: '', lat: '', lon: '', inventory_number: '', sim_number: '', ip_address: '', port: '', notes: '', status: '', category_name: '', category_color: '', login: '', password: '',
    verification_valid_until: '', power_source: '', fault_reason: '', fault_need: '', fault_at: '', fault_by: '' };
  let S = null;                      // состояние открытой карточки
  let styled = false;
  let modalWatch = null;

  const fmtSize = (n) => (n < 1024 ? `${n} Б` : n < 1048576 ? `${Math.round(n / 1024)} КБ` : `${(n / 1048576).toFixed(1)} МБ`);
  const $c = (sel) => (S ? S.el.querySelector(sel) : null);

  function injectStyle() {
    if (styled) return;
    styled = true;
    const css = document.createElement('style');
    css.textContent = `
      /* выше шапки страницы (z-30), ниже плавающих окон чата и заявок (z-40+); окна «Фото», «Журнал» поверх карточки — см. правило ниже */
      body.pc-open #modal>div{z-index:38 !important}
      .pc-overlay{position:fixed;inset:0;z-index:35;overflow:auto;background:rgb(var(--bg-base));color:rgb(var(--text));display:flex;flex-direction:column}
      .pc-top{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;align-items:center;gap:8px 14px;padding:12px 22px;background:rgb(var(--glass-1)/1);border-bottom:1px solid rgb(var(--glass-border)/.28)}
      .pc-title{font-family:'Manrope',system-ui,sans-serif;font-weight:700;font-size:22px;letter-spacing:-.02em}
      .pc-main{display:grid;grid-template-columns:minmax(0,1.15fr) minmax(0,1fr);gap:16px;padding:16px 22px 48px;width:100%;max-width:1560px;margin:0 auto}
      @media (max-width:960px){.pc-main{grid-template-columns:minmax(0,1fr);padding:12px 10px 36px}.pc-top{padding:10px 12px}}
      .pc-col{display:flex;flex-direction:column;gap:16px;min-width:0}
      .pc-panel{border:1px solid rgb(var(--glass-border)/.25);background:rgb(var(--glass-1)/.92);border-radius:18px;padding:14px 18px}
      .pc-panel>h3{font-family:'Manrope',system-ui,sans-serif;font-weight:700;font-size:15px;margin:0 0 8px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
      .pc-row{display:grid;grid-template-columns:minmax(120px,190px) minmax(0,1fr);gap:4px 14px;padding:7px 0;border-bottom:1px dashed rgb(var(--glass-border)/.18);align-items:start}
      .pc-row:last-child{border-bottom:0}
      .pc-lbl{color:rgb(var(--slate-400));font-size:12px;padding-top:2px}
      .pc-val{font-size:14px;overflow-wrap:anywhere;white-space:pre-wrap;display:flex;flex-wrap:wrap;align-items:center;gap:6px}
      .pc-val.pc-empty,.pc-lock{color:rgb(var(--slate-400));font-style:italic}
      .pc-chip{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:3px 10px;font-size:12px;border:1px solid rgb(var(--glass-border)/.35);white-space:nowrap}
      .pc-chip-ok{background:rgb(16 185 129/.14);border-color:rgb(16 185 129/.45)}
      .pc-chip-no{background:rgb(245 158 11/.14);border-color:rgb(245 158 11/.5)}
      .pc-mini{border:1px solid rgb(var(--glass-border)/.4);background:transparent;color:inherit;border-radius:8px;padding:1px 8px;font-size:12px;cursor:pointer}
      .pc-mini:hover{background:rgb(var(--glass-border)/.18)}
      .pc-edit-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px 14px}
      .pc-edit-grid .pc-wide{grid-column:1/-1}
      .pc-photos{display:grid;grid-template-columns:repeat(auto-fill,minmax(88px,1fr));gap:6px}
      .pc-photos img{width:100%;aspect-ratio:1/1;object-fit:cover;border-radius:10px;display:block;background:rgb(var(--slate-900))}
      .pc-file{display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:4px 10px;align-items:center;padding:8px 6px;border-bottom:1px dashed rgb(var(--glass-border)/.18);border-radius:10px}
      .pc-file:hover{background:rgb(var(--glass-border)/.1)}
      .pc-file .pc-fname{font-size:14px;font-weight:500;cursor:pointer;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;text-align:left;background:none;border:0;color:inherit;padding:0}
      .pc-file .pc-fname:hover{text-decoration:underline}
      .pc-file small{display:block;color:rgb(var(--slate-400));font-size:11.5px;overflow-wrap:anywhere}
      .pc-drop{border:2px dashed rgb(var(--glass-border)/.35);border-radius:14px;padding:10px 12px;margin-bottom:8px}
      .pc-drop.pc-over{border-color:rgb(var(--accent));background:rgb(var(--accent)/.08)}
      /* просмотр файлов */
      .pc-view{position:fixed;inset:0;z-index:1000;background:#020617;display:flex;flex-direction:column;color:#e2e8f0}
      .pc-view-top{display:flex;align-items:center;gap:10px;padding:10px 16px;font-size:14px;flex-wrap:wrap}
      .pc-view-btn{border:0;cursor:pointer;color:#e2e8f0;background:rgba(51,65,85,.75);border-radius:12px;padding:6px 12px;text-decoration:none;font-size:13px;white-space:nowrap}
      .pc-view-btn:hover{background:rgba(71,85,105,.9)}
      .pc-stage{position:relative;flex:1;min-height:0;display:flex;align-items:center;justify-content:center;padding:0 64px 14px}
      .pc-stage>.pc-arrow{position:absolute;top:50%;transform:translateY(-50%);width:48px;height:72px;font-size:34px;line-height:1;border:0;cursor:pointer;color:#e2e8f0;background:rgba(51,65,85,.75);border-radius:12px;z-index:2}
      .pc-stage>.pc-arrow:hover{background:rgba(71,85,105,.95)}
      .pc-body{width:100%;height:100%;min-height:0;display:flex;align-items:center;justify-content:center}
      .pc-body img{max-width:100%;max-height:100%;object-fit:contain;border-radius:6px;user-select:none}
      .pc-body iframe{width:100%;height:100%;border:0;border-radius:6px;background:#fff}
      .pc-doc{width:100%;height:100%;overflow:auto;background:#fff;color:#0f172a;border-radius:8px;padding:26px 34px;font-size:14px;line-height:1.5;text-align:left}
      .pc-doc-inner{max-width:920px;margin:0 auto}
      .pc-doc h1,.pc-doc h2,.pc-doc h3,.pc-doc h4,.pc-doc h5{margin:.9em 0 .4em;line-height:1.25;font-weight:700}
      .pc-doc h1{font-size:1.7em}.pc-doc h2{font-size:1.4em}.pc-doc h3{font-size:1.18em}.pc-doc h4,.pc-doc h5{font-size:1.02em}
      .pc-doc b{font-weight:700}.pc-doc i{font-style:italic}.pc-doc u{text-decoration:underline}
      .pc-doc p{margin:0 0 .55em}
      .pc-doc table{border-collapse:collapse;margin:.6em 0;font-size:13px}
      .pc-doc td{border:1px solid #cbd5e1;padding:3px 7px;vertical-align:top}
      .pc-doc.pc-sheet{padding:14px 18px}
      .pc-doc.pc-sheet .pc-doc-inner{max-width:none}
      .pc-text{width:100%;height:100%;overflow:auto;margin:0;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:16px 20px;font:13px/1.5 ui-monospace,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;text-align:left}
      .pc-note{max-width:460px;text-align:center;color:#cbd5e1;font-size:14px;line-height:1.5}
      @media (max-width:700px){.pc-stage{padding:0 8px 10px}.pc-stage>.pc-arrow{width:36px;height:56px;font-size:26px;opacity:.85}.pc-doc{padding:14px}}
      [data-brick]{cursor:pointer}
      [data-brick] :is(input,textarea,select,[data-no-brick]){cursor:auto}
      [data-brick-name]:hover{text-decoration:underline dotted;text-underline-offset:3px}
    `;
    document.head.appendChild(css);
  }

  // ---------- права ----------
  const perms = () => ({
    edit: can('points.edit'), secrets: can('points.secrets'), network: can('points.network'),
    photoView: can('photos.view'), photoUp: can('photos.upload'), reports: canAny('reports.view', 'monitoring.view', 'calendar.view'),
  });

  const lockRow = (label, right) => `<div class="pc-row"><div class="pc-lbl">${label}</div><div class="pc-val pc-lock" title="Нужно право «${esc(right)}»">🔒 Скрыто для вашей роли (нужно право «${esc(right)}»)</div></div>`;
  const row = (label, valueHtml, empty = '—') => `<div class="pc-row"><div class="pc-lbl">${label}</div>${valueHtml ? `<div class="pc-val">${valueHtml}</div>` : `<div class="pc-val pc-empty">${empty}</div>`}</div>`;
  const copyBtn = (text, what) => (text ? `<button type="button" class="pc-mini" data-pc-copy="${esc(text)}" title="Скопировать ${esc(what)}">📋</button>` : '');

  function certHtml(date) {
    if (!date) return '';
    const days = Math.round((new Date(date + 'T12:00:00') - new Date()) / 86400000);
    const badge = days < 0 ? `<span class="pc-chip pc-chip-no">истёк ${-days} дн. назад</span>` : days <= 30 ? `<span class="pc-chip pc-chip-no">истекает через ${days} дн.</span>` : '';
    return `${esc(fmtDate(date))} ${badge}`;
  }

  // ---------- шапка ----------
  function chipsHtml(p) {
    const chip = (ok, yes, no, hint) => `<span class="pc-chip ${ok ? 'pc-chip-ok' : 'pc-chip-no'}" title="${esc(hint)}" data-pc-chip>${ok ? '🔓' : '🔒'} ${ok ? yes : no}</span>`;
    return `${chip(p.secrets, 'Логин и пароль: видны', 'Логин и пароль: скрыты', 'Право «' + RIGHT.secrets + '»')}
      ${chip(p.network, 'IP и порт: видны', 'IP и порт: скрыты', 'Право «' + RIGHT.network + '»')}
      <span class="pc-chip" title="Ваша роль${p.edit ? '' : ': менять комплексы нельзя'}">${p.edit ? '✎ можно править' : '👁 только просмотр'} · ${esc(userRoleLabel(CURRENT_USER) || 'роль')}</span>`;
  }

  function topHtml() {
    const { p, mode, isNew } = S;
    const r = perms();
    const title = isNew ? 'Новый комплекс' : `АПК ${esc(p.id)}`;
    const badges = isNew ? '' : `${pointStatusBadge(p.status, p.stock_partial)} ${p.category_name ? colorBadge(p.category_name, p.category_color) : ''}`;
    return `<div class="pc-title">${title}</div> ${badges}
      <span style="display:flex;flex-wrap:wrap;gap:6px;margin-left:6px">${chipsHtml(r)}</span>
      <span style="margin-left:auto;display:flex;flex-wrap:wrap;gap:8px">
        ${mode === 'view' && r.edit ? `<button type="button" id="pcEdit" class="${btnPrimary} !py-1.5 !px-4 text-sm" title="Изменить сведения о комплексе">✎ Редактировать</button>` : ''}
        ${mode === 'edit' ? `<button type="button" id="pcSave" class="${btnPrimary} !py-1.5 !px-4 text-sm">💾 Сохранить</button><button type="button" id="pcCancelEdit" class="${btnGhost} !py-1.5 !px-4 text-sm">${isNew ? 'Отмена' : 'Отменить правку'}</button>` : ''}
        <button type="button" id="pcClose" class="${btnGhost} !py-1.5 !px-4 text-sm" title="Закрыть карточку (Esc)">✕ Закрыть</button>
      </span>`;
  }

  // ---------- просмотр (только чтение) ----------
  function viewColumnsHtml() {
    const { p, card, simLinks } = S;
    const r = perms();
    const main = `<div class="pc-panel"><h3>📋 Основное</h3>
      ${row('Номер', `<b>${esc(p.id)}</b>`)}
      ${row('Адрес', esc(p.address))}
      ${row('Статус', pointStatusBadge(p.status, p.stock_partial) || '', 'не указан')}
      ${row('Категория', p.category_name ? colorBadge(p.category_name, p.category_color) : '', 'не указана')}
      ${row('Координаты', p.lat || p.lon ? `${esc(p.lat)}, ${esc(p.lon)} ${copyBtn(`${p.lat}, ${p.lon}`, 'координаты')}` : '')}
      ${row('Инвентарный номер', esc(p.inventory_number) + copyBtn(p.inventory_number, 'номер'))}
      ${row('Номер SIM', esc(p.sim_number) + copyBtn(p.sim_number, 'номер SIM') + (simLinks.length ? `<span class="pc-chip" title="Общая SIM у нескольких комплексов">🔗 общая SIM: ${simLinks.map((x) => esc(x.id)).join(', ')}</span>` : ''))}
      ${row('Сертификат поверки до', certHtml(p.verification_valid_until), 'не указан')}
      ${row('Питание', esc(p.power_source), 'не указано')}
      ${p.stock_partial ? `<div class="pc-row"><div class="pc-lbl">Склад</div><div class="pc-val" style="display:block">${stockPartialNoteHtml(p)}</div></div>` : ''}
    </div>`;
    const fault = `<div class="pc-panel"><h3>⚠ Неисправность и описание</h3>
      ${row('Описание / неисправность', esc(p.description))}
      ${row('Почему не работает', esc(p.fault_reason), 'не указано')}
      ${row('Что нужно для восстановления', esc(p.fault_need), 'не указано')}
      ${p.fault_at ? `<div class="pc-row"><div class="pc-lbl"></div><div class="pc-val" style="font-size:11.5px;color:rgb(var(--slate-400))">из отчёта от ${esc(fmtDateTime(p.fault_at, true))}${p.fault_by ? ', ' + esc(p.fault_by) : ''}</div></div>` : ''}
      ${row('Примечание', esc(p.notes))}
    </div>`;
    const secretBox = (label, value, kind) => {
      if (!value) return row(label, '', 'не заполнено');
      if (kind === 'password') return `<div class="pc-row"><div class="pc-lbl">${label}</div><div class="pc-val"><span data-pc-secret="${esc(value)}" data-pc-hidden="1">••••••••</span>
        <button type="button" class="pc-mini" data-pc-reveal title="Показать / скрыть пароль">👁</button>${copyBtn(value, 'пароль')}</div></div>`;
      return row(label, esc(value) + copyBtn(value, label.toLowerCase()));
    };
    const access = `<div class="pc-panel"><h3>🔐 Доступ к устройству <span class="pc-chip ${r.secrets && r.network ? 'pc-chip-ok' : 'pc-chip-no'}" style="font-size:11px;font-weight:400">${r.secrets && r.network ? '🔓 конфиденциальные данные видны' : '🔒 часть данных скрыта правами роли'}</span></h3>
      ${r.network ? row('IP-адрес', esc(p.ip_address) + copyBtn(p.ip_address, 'IP'), 'не указан') : lockRow('IP-адрес', RIGHT.network)}
      ${r.network ? row('Порт', esc(p.port), 'не указан') : lockRow('Порт', RIGHT.network)}
      ${r.secrets ? secretBox('Логин', p.login, 'login') : lockRow('Логин', RIGHT.secrets)}
      ${r.secrets ? secretBox('Пароль', p.password, 'password') : lockRow('Пароль', RIGHT.secrets)}
    </div>`;
    const groups = card.groups || [];
    const links = `<div class="pc-panel"><h3>🧩 Подгруппы и план</h3>
      ${groups.length ? groups.map((g) => `<div class="pc-row"><div class="pc-lbl">${g.name === 'Требуют повторного выезда' ? '⚠' : '📁'} ${esc(g.name)}</div><div class="pc-val" style="display:block">${g.work_type ? `<b>${esc(g.work_type)}</b><br>` : ''}${g.note ? esc(g.note) : '<span class="pc-lock">без описания</span>'}${g.need ? `<br><b>Нужно:</b> ${esc(g.need)}` : ''}</div></div>`).join('') : row('Подгруппы', '', 'не состоит ни в одной')}
      ${card.plan ? row('В плане выездов', `<span class="pc-chip">📌 ${card.plan.group_name ? 'группа «' + esc(card.plan.group_name) + '»' : 'без группы'}${card.plan.work_type ? ' · ' + esc(card.plan.work_type) : ''}${card.plan.priority ? ' · срочно' : ''}</span>${card.plan.description ? ' ' + esc(card.plan.description) : ''}`) : row('В плане выездов', '', 'нет')}
      <div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">
        ${r.reports ? `<button type="button" class="${btnGhost} !py-1.5 !px-3 text-xs" id="pcHistory">🕘 История выездов</button>` : ''}
      </div>
    </div>`;
    return { left: main + fault + access, right: '' , links };
  }

  // ---------- правка ----------
  function editColumnsHtml() {
    const { p, isNew } = S;
    const r = perms();
    const statusOptions = Object.keys(_pointStatusCache);
    const f = (name, label, value, extra = '') => `<label class="${labelCls}">${label}<input name="${name}" value="${esc(value)}" class="${fieldCls}" ${extra}></label>`;
    return `<form id="pcForm" class="pc-col" autocomplete="off">
      <div class="pc-panel"><h3>✎ ${isNew ? 'Новый комплекс' : 'Правка: основное'}</h3>
        <div class="pc-edit-grid">
          <div class="pc-wide">${f('id', 'Номер', p.id, 'required')}${isNew ? '' : '<p class="text-[11px] text-slate-500" style="margin:4px 0 0">Если изменить номер, задания, фото, отчёты и файлы комплекса переедут на новый номер.</p>'}</div>
          <div class="pc-wide">${f('address', 'Адрес', p.address)}</div>
          <label class="${labelCls}">Статус<input name="status" list="pcStatusOpts" value="${esc(p.status)}" class="${fieldCls}" placeholder="Работает"><datalist id="pcStatusOpts">${statusOptions.map((s) => `<option value="${esc(s)}">`).join('')}</datalist></label>
          <div style="position:relative">
            <label class="${labelCls}">Категория (АПК)<input name="category_name" id="pcCategoryName" value="${esc(p.category_name)}" autocomplete="off" class="${fieldCls}" placeholder="Начните вводить..."></label>
            <div id="pcCategoryResults" class="hidden absolute z-10 mt-1 w-full rounded-xl border border-slate-700 bg-slate-800 shadow-xl max-h-48 overflow-auto"></div>
            <div id="pcCategoryColorRow" class="hidden items-center gap-2 mt-1.5 text-xs text-slate-400"><span>Цвет новой категории:</span>
              <input type="color" id="pcCategoryColor" name="category_color" value="${esc(p.category_color) || '#6366f1'}" class="h-7 w-10 rounded cursor-pointer bg-transparent border border-slate-700"></div>
          </div>
          ${f('lat', 'Широта', p.lat)}${f('lon', 'Долгота', p.lon)}
          ${f('inventory_number', 'Инвентарный номер (серийник)', p.inventory_number)}${f('sim_number', 'Номер SIM', p.sim_number)}
          <div class="pc-wide"><div id="simLinkNote" class="hidden rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200"></div></div>
          <label class="${labelCls}">Сертификат поверки до<input name="verification_valid_until" type="date" value="${esc(p.verification_valid_until)}" class="${fieldCls}"></label>
          <div class="pc-wide">${powerSourceFieldHtml(p.power_source)}</div>
        </div>
      </div>
      <div class="pc-panel"><h3>⚠ Правка: неисправность и описание</h3>
        <div class="pc-edit-grid">
          <label class="${labelCls} pc-wide">Описание / неисправность<textarea name="description" rows="2" class="${fieldCls}">${esc(p.description)}</textarea></label>
          <label class="${labelCls} pc-wide">Почему не работает<textarea name="fault_reason" rows="2" class="${fieldCls}" placeholder="например: нет питания, обрыв линии">${esc(p.fault_reason)}</textarea></label>
          <label class="${labelCls} pc-wide">Что нужно для восстановления<textarea name="fault_need" rows="2" class="${fieldCls}" placeholder="например: блок питания, кабель 50 м, автовышка">${esc(p.fault_need)}</textarea></label>
          <p class="text-[11px] text-slate-500 pc-wide" style="margin:0">Два последних поля заполняются из отчётов о выездах сами; можно поправить вручную — следующий более свежий отчёт заменит их, а итог «Работает» очистит.</p>
          <label class="${labelCls} pc-wide">Примечание<textarea name="notes" rows="2" class="${fieldCls}">${esc(p.notes)}</textarea></label>
        </div>
      </div>
      <div class="pc-panel"><h3>🔐 Правка: доступ к устройству</h3>
        <div class="pc-edit-grid">
          ${r.network ? `${f('ip_address', 'IP-адрес', p.ip_address)}${f('port', 'Порт', p.port)}` : `<div class="pc-wide pc-lock">🔒 IP-адрес и порт скрыты для вашей роли (нужно право «${esc(RIGHT.network)}») — при сохранении остаются прежними.</div>`}
          ${r.secrets ? `${f('login', 'Логин от веб-интерфейса', p.login, 'autocomplete="off"')}${f('password', 'Пароль от веб-интерфейса', p.password, 'autocomplete="off"')}` : `<div class="pc-wide pc-lock">🔒 Логин и пароль скрыты для вашей роли (нужно право «${esc(RIGHT.secrets)}») — при сохранении остаются прежними.</div>`}
        </div>
      </div>
      <div id="pcFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      ${isNew ? '' : `<div><button type="button" id="pcDelete" class="${btnDanger} !py-1.5 !px-3 text-xs">🗑 Удалить комплекс…</button>
        <span class="text-[11px] text-slate-500" style="margin-left:8px">Задания и история сохранятся, но комплекс исчезнет из справочника.</span></div>`}
    </form>`;
  }

  // ---------- фото и файлы ----------
  function photosHtml() {
    const r = perms();
    if (!r.photoView && !r.photoUp) return '';
    const ph = S.photos;
    const total = ph ? ph.total : 0;
    const shots = ph ? ph.days.flatMap((d) => d.photos.map((x) => ({ ...x, date: d.date }))).slice(0, 12) : [];
    return `<div class="pc-panel"><h3>📷 Фото ${ph ? `<span class="pc-chip">${total}</span>` : ''}
        <span style="margin-left:auto;display:flex;gap:6px;flex-wrap:wrap">
          ${r.photoUp ? `<button type="button" class="${btnPrimary} !py-1 !px-3 text-xs" id="pcPhotoAdd" title="Загрузить фото и выбрать, к какой дате они относятся">➕ Загрузить фото</button>` : ''}
          ${r.photoView && total ? `<button type="button" class="${btnGhost} !py-1 !px-3 text-xs" id="pcPhotoAll">Все фото по дням</button>` : ''}
        </span></h3>
      ${shots.length ? `<div class="pc-photos" data-pv-scope>${shots.map((x) => {
        const url = `/api/monitoring/photos/${x.id}/file`;
        const who = [x.name, x.uploaded_by, x.uploaded_at ? fmtDateTime(x.uploaded_at, true) : ''].filter(Boolean).join(' · ');
        return `<a href="${url}" target="_blank" rel="noopener" data-pv data-pv-title="${esc(who)}" data-pv-sub="${esc(fmtDate(x.date))}" title="${esc(fmtDate(x.date))}"><img src="${url}" loading="lazy" alt=""></a>`;
      }).join('')}</div>${total > shots.length ? `<p class="text-[11px] text-slate-500" style="margin:6px 0 0">Показаны последние ${shots.length} из ${total}.</p>` : ''}`
        : `<p class="pc-lock" style="margin:0">${ph ? 'Фото по этому комплексу пока нет.' : 'Загружаю…'}</p>`}
    </div>`;
  }

  function filesHtml() {
    const r = perms();
    const files = S.card.files || [];
    return `<div class="pc-panel" id="pcFilesPanel"><h3>📎 Файлы <span class="pc-chip" id="pcFilesCount">${files.length}</span></h3>
      ${r.edit ? `<div class="pc-drop" id="pcDrop">
        <div style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">
          <label class="${btnPrimary} !py-1 !px-3 text-xs" style="cursor:pointer" title="Любые документы, фото, схемы — до 25 МБ каждый">➕ Добавить файлы…
            <input type="file" id="pcFileInput" multiple style="display:none"></label>
          <input id="pcFileComment" maxlength="500" placeholder="Комментарий к файлам (необязательно)" class="${fieldCls}" style="flex:1;min-width:160px;padding-top:6px;padding-bottom:6px">
        </div>
        <p class="text-[11px] text-slate-500" style="margin:6px 0 0">Можно перетащить файлы сюда. Фото, PDF, Word, Excel и текст открываются прямо на сайте. Страницы, сценарии и программы (html, js, exe…) не принимаются.</p>
        <div id="pcUpStatus" class="text-xs" style="margin-top:6px;white-space:pre-wrap"></div>
      </div>` : ''}
      <div id="pcFileList">${files.length ? files.map(fileRowHtml).join('') : '<p class="pc-lock" style="margin:4px 0 0">Файлов пока нет.</p>'}</div>
    </div>`;
  }

  function fileRowHtml(f) {
    const r = perms();
    return `<div class="pc-file" data-pc-file="${f.id}">
      <span style="font-size:22px" title="${esc(f.kind_label)}">${KIND_ICON[f.kind] || '📎'}</span>
      <div style="min-width:0"><button type="button" class="pc-fname" data-pc-open="${f.id}" title="Открыть">${esc(f.name)}</button>
        <small>${esc(f.kind_label)} · ${fmtSize(f.size)} · ${esc(fmtDateTime(f.uploaded_at, true))}${f.uploaded_by ? ' · ' + esc(f.uploaded_by) : ''}${f.comment ? '<br>' + esc(f.comment) : ''}</small></div>
      <span style="display:flex;gap:6px">
        <a class="pc-mini" href="/api/point-files/${f.id}/file?download=1" title="Скачать" style="text-decoration:none">⬇</a>
        ${r.edit ? `<button type="button" class="pc-mini" data-pc-del="${f.id}" title="Удалить файл">🗑</button>` : ''}
      </span></div>`;
  }

  // ---------- сборка и привязка событий ----------
  function render() {
    if (!S) return;
    const { mode } = S;
    const r = perms();
    S.el.innerHTML = `<div class="pc-top" id="pcTop">${topHtml()}</div>
      <div class="pc-main"><div class="pc-col" id="pcLeft"></div><div class="pc-col" id="pcRight"></div></div>`;
    const left = $c('#pcLeft'), right = $c('#pcRight');
    if (mode === 'view') {
      const v = viewColumnsHtml();
      left.innerHTML = v.left;
      right.innerHTML = v.links + '<div id="pcPhotosBox">' + photosHtml() + '</div>' + (S.isNew ? '' : filesHtml());
    } else {
      left.outerHTML = editColumnsHtml();
      right.innerHTML = S.isNew ? '<div class="pc-panel"><p class="pc-lock" style="margin:0">Фото и файлы можно добавить после того, как комплекс будет сохранён.</p></div>' : '<div id="pcPhotosBox">' + photosHtml() + '</div>' + filesHtml();
      // поля формы, которым нужны обработчики
      showSimLinkNote(S.isNew ? '' : S.p.id);
      wirePowerSourceField($c('#pcForm'));
      S.combo = setupCategoryCombobox($c('#pcCategoryName'), $c('#pcCategoryResults'), $c('#pcCategoryColorRow'), $c('#pcCategoryColor'));
      S.combo.reset(S.p.category_name, S.p.category_color);
      S.snapshot = formSnapshot();
    }
    wire();
    if (r.edit && mode === 'edit' && $c('#pcForm')) $c('#pcForm').elements.id.focus();
  }

  const formSnapshot = () => { const f = $c('#pcForm'); return f ? JSON.stringify([...new FormData(f).entries()]) + readPowerSource(f) : ''; };
  const dirty = () => S && S.mode === 'edit' && S.snapshot !== undefined && formSnapshot() !== S.snapshot;

  function wire() {
    $c('#pcClose').onclick = () => closeCard();
    if ($c('#pcEdit')) $c('#pcEdit').onclick = () => { S.mode = 'edit'; render(); };
    if ($c('#pcCancelEdit')) $c('#pcCancelEdit').onclick = () => {
      if (dirty() && !confirm('Отменить правку? Изменения не сохранятся.')) return;
      if (S.isNew) { closeCard(true); return; }
      S.mode = 'view';
      render();
    };
    if ($c('#pcSave')) $c('#pcSave').onclick = () => saveCard();
    if ($c('#pcForm')) $c('#pcForm').onsubmit = (e) => { e.preventDefault(); saveCard(); };
    if ($c('#pcDelete')) $c('#pcDelete').onclick = deleteCard;
    if ($c('#pcHistory')) $c('#pcHistory').onclick = () => openVisitJournal(S.p.id);
    S.el.querySelectorAll('[data-pc-copy]').forEach((b) => { b.onclick = () => copyText2(b.dataset.pcCopy, b); });
    S.el.querySelectorAll('[data-pc-reveal]').forEach((b) => {
      b.onclick = () => {
        const span = b.parentElement.querySelector('[data-pc-secret]');
        const hidden = span.dataset.pcHidden === '1';
        span.textContent = hidden ? span.dataset.pcSecret : '••••••••';
        span.dataset.pcHidden = hidden ? '0' : '1';
      };
    });
    wirePhotos();
    wireFiles();
  }

  function copyText2(text, btn) {
    const done = () => { const old = btn.textContent; btn.textContent = '✓'; setTimeout(() => { btn.textContent = old; }, 1200); };
    if (navigator.clipboard && window.isSecureContext) { navigator.clipboard.writeText(text).then(done, () => legacyCopy(text, done)); return; }
    legacyCopy(text, done);
  }
  function legacyCopy(text, done) {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.cssText = 'position:fixed;left:-1000px;top:0';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); done(); } catch { /* не вышло — значение можно выделить мышью */ }
    ta.remove();
  }

  function wirePhotos() {
    if ($c('#pcPhotoAdd')) $c('#pcPhotoAdd').onclick = () => { S.changed = true; openPointPhotos(S.p.id, null, null, { openUpload: true, onChange: () => loadPhotos() }); };
    if ($c('#pcPhotoAll')) $c('#pcPhotoAll').onclick = () => openPointPhotos(S.p.id, null, null, { onChange: () => loadPhotos() });
  }

  async function loadPhotos() {
    if (!S || S.isNew) return;
    if (perms().photoView) {
      try { S.photos = await Api.get('/api/monitoring/photos/point-items?point_id=' + encodeURIComponent(S.p.id)); }
      catch { S.photos = { total: 0, days: [] }; }
    } else S.photos = { total: 0, days: [] };
    const box = $c('#pcPhotosBox');
    if (box) { box.innerHTML = photosHtml(); wirePhotos(); }
  }

  // ---------- файлы ----------
  function wireFiles() {
    const files = S.card.files || [];
    S.el.querySelectorAll('[data-pc-open]').forEach((b) => { b.onclick = () => openViewer(files, files.findIndex((f) => f.id === +b.dataset.pcOpen)); });
    S.el.querySelectorAll('[data-pc-del]').forEach((b) => {
      b.onclick = async () => {
        const f = files.find((x) => x.id === +b.dataset.pcDel);
        if (!f || !confirm(`Удалить файл «${f.name}»?`)) return;
        try { await Api.del('/api/point-files/' + f.id); S.changed = true; await refreshFiles(); toast('Файл удалён', 'ok'); }
        catch (e) { alert('Не удалось удалить: ' + e.message); }
      };
    });
    const input = $c('#pcFileInput'), drop = $c('#pcDrop');
    if (input) input.onchange = () => { const list = [...input.files]; input.value = ''; uploadFiles(list); };
    if (drop) {
      drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('pc-over'); };
      drop.ondragleave = () => drop.classList.remove('pc-over');
      drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('pc-over'); uploadFiles([...e.dataTransfer.files]); };
    }
  }

  async function refreshFiles() {
    if (!S || S.isNew) return;
    S.card.files = await Api.get('/api/point-files?point_id=' + encodeURIComponent(S.p.id));
    const list = $c('#pcFileList');
    if (list) {
      list.innerHTML = S.card.files.length ? S.card.files.map(fileRowHtml).join('') : '<p class="pc-lock" style="margin:4px 0 0">Файлов пока нет.</p>';
      if ($c('#pcFilesCount')) $c('#pcFilesCount').textContent = S.card.files.length;
      wireFiles();
    }
  }

  async function uploadFiles(list) {
    if (!list.length || S.uploading) return;
    const comment = ($c('#pcFileComment') && $c('#pcFileComment').value.trim()) || '';
    const status = (t) => { if ($c('#pcUpStatus')) $c('#pcUpStatus').textContent = t; };
    S.uploading = true;
    const failed = [];
    let ok = 0;
    for (let i = 0; i < list.length; i += 1) {
      const f = list[i];
      status(`Загружаю ${i + 1} из ${list.length}: ${f.name}…`);
      try {
        if (f.size > 25 * 1024 * 1024) throw new Error(`слишком большой (${Math.round(f.size / 1e6)} МБ, можно до 25 МБ)`);
        const fd = new FormData();
        fd.append('point_id', S.p.id);
        fd.append('comment', comment);
        fd.append('file', f, f.name);
        await Api.uploadWithProgress('/api/point-files', fd, { timeoutMs: 300000, onProgress: (a, b) => status(`Загружаю ${i + 1} из ${list.length}: ${f.name} — ${Math.round((a * 100) / b)}%`) });
        ok += 1;
      } catch (err) { failed.push(`${f.name}: ${err.message}`); }
    }
    S.uploading = false;
    if (ok) S.changed = true;
    try { await refreshFiles(); } catch { /* список обновится при следующем открытии */ }
    status(failed.length ? `Не загружено:\n${failed.join('\n')}` : ok ? '✓ Готово' : '');
    if ($c('#pcUpStatus')) $c('#pcUpStatus').style.color = failed.length ? '#fda4af' : '';
    if (ok) toast(`Загружено файлов: ${ok}${failed.length ? `, не загружено: ${failed.length}` : ''}`, failed.length ? 'warn' : 'ok');
    if (ok && $c('#pcFileComment')) $c('#pcFileComment').value = '';
  }

  // ---------- просмотр файлов на сайте ----------
  function closeViewer() {
    const box = document.getElementById('pcView');
    if (box && box._cleanup) box._cleanup();
    if (box) box.remove();
  }

  function openViewer(files, start) {
    if (!files.length) return;
    closeViewer();
    let i = Math.min(Math.max(start, 0), files.length - 1);
    const cache = {};
    let token = 0;
    const box = document.createElement('div');
    box.id = 'pcView';
    box.className = 'pc-view';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    box.innerHTML = `<div class="pc-view-top">
        <b id="pcvCount" style="white-space:nowrap"></b>
        <span id="pcvTitle" style="flex:1;min-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"></span>
        <span id="pcvKind" style="color:#94a3b8;white-space:nowrap"></span>
        <a id="pcvNew" class="pc-view-btn" target="_blank" rel="noopener" title="Открыть в новой вкладке">↗ В новой вкладке</a>
        <a id="pcvDl" class="pc-view-btn" title="Скачать файл">⬇ Скачать</a>
        <button type="button" id="pcvClose" class="pc-view-btn" title="Закрыть (Esc)" aria-label="Закрыть" style="width:40px;height:40px;font-size:20px;padding:0">✕</button>
      </div>
      <div class="pc-stage"><button type="button" class="pc-arrow" id="pcvPrev" title="Назад (←)" aria-label="Предыдущий файл" style="left:8px">‹</button>
        <div class="pc-body" id="pcvBody"></div>
        <button type="button" class="pc-arrow" id="pcvNext" title="Вперёд (→)" aria-label="Следующий файл" style="right:8px">›</button></div>`;
    document.body.appendChild(box);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const q = (id) => box.querySelector('#' + id);

    const note = (html) => `<div class="pc-note">${html}</div>`;
    async function fillPreview(f, body, my) {
      body.innerHTML = note('Загружаю предпросмотр…');
      try {
        const data = cache[f.id] || (cache[f.id] = await Api.get(`/api/point-files/${f.id}/preview`));
        if (my !== token) return;
        if (data.kind === 'html') {
          body.innerHTML = `<div class="pc-doc${f.kind === 'xlsx' ? ' pc-sheet' : ''}"><div class="pc-doc-inner">${data.html || '<p><i>документ пустой</i></p>'}${data.truncated ? '<p><i>…показана только первая часть файла — полностью его можно скачать.</i></p>' : ''}</div></div>`;
        } else if (data.kind === 'text') {
          const pre = document.createElement('pre');
          pre.className = 'pc-text';
          pre.textContent = data.text + (data.truncated ? '\n\n…показана только первая часть файла — полностью его можно скачать.' : '');
          body.innerHTML = '';
          body.appendChild(pre);
        } else body.innerHTML = note(esc(data.note || 'Предпросмотра нет.') + '<br><br>Нажмите «Скачать».');
      } catch (e) { if (my === token) body.innerHTML = note('Не удалось показать файл: ' + esc(e.message) + '<br><br>Его можно скачать.'); }
    }

    function show(n) {
      i = Math.min(Math.max(n, 0), files.length - 1);
      token += 1;
      const my = token;
      const f = files[i];
      const url = `/api/point-files/${f.id}/file`;
      q('pcvCount').textContent = `${i + 1} / ${files.length}`;
      q('pcvTitle').textContent = f.name + (f.comment ? ' — ' + f.comment : '');
      q('pcvKind').textContent = `${f.kind_label} · ${fmtSize(f.size)}`;
      const dl = q('pcvDl');
      dl.href = url + '?download=1';
      dl.setAttribute('download', f.name);
      const inl = ['image', 'pdf', 'text'].includes(f.kind);
      q('pcvNew').style.display = inl ? '' : 'none';
      q('pcvNew').href = url;
      q('pcvPrev').style.visibility = i > 0 ? 'visible' : 'hidden';
      q('pcvNext').style.visibility = i < files.length - 1 ? 'visible' : 'hidden';
      const body = q('pcvBody');
      if (f.kind === 'image') {
        body.innerHTML = '';
        const img = document.createElement('img');
        img.alt = f.name;
        img.onerror = () => { body.innerHTML = note('Это изображение не получается показать в браузере.<br><br>Его можно скачать.'); };
        img.src = url;
        body.appendChild(img);
      } else if (f.kind === 'pdf') {
        body.innerHTML = '';
        const fr = document.createElement('iframe');
        fr.title = f.name;
        fr.src = url;
        body.appendChild(fr);
      } else if (f.kind === 'docx' || f.kind === 'xlsx' || f.kind === 'text') {
        fillPreview(f, body, my);
      } else {
        body.innerHTML = note(`Для файлов «${esc(f.kind_label)}» просмотра на сайте нет.<br><br>Нажмите «Скачать» — файл откроется в вашей программе.`);
      }
      files.slice(Math.max(0, i - 1), i + 2).forEach((g) => { if (g !== f && (g.kind === 'docx' || g.kind === 'xlsx' || g.kind === 'text') && !cache[g.id]) Api.get(`/api/point-files/${g.id}/preview`).then((d) => { cache[g.id] = d; }).catch(() => {}); });
    }

    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); closeViewer(); }
      else if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopImmediatePropagation(); show(i - 1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); e.stopImmediatePropagation(); show(i + 1); }
      else if (e.key === 'Home') { e.preventDefault(); show(0); }
      else if (e.key === 'End') { e.preventDefault(); show(files.length - 1); }
    };
    document.addEventListener('keydown', onKey, true);
    let x0 = null;
    box.addEventListener('touchstart', (e) => { x0 = e.touches[0].clientX; }, { passive: true });
    box.addEventListener('touchend', (e) => {
      if (x0 === null) return;
      const dx = e.changedTouches[0].clientX - x0;
      x0 = null;
      if (Math.abs(dx) > 70) show(i + (dx < 0 ? 1 : -1));
    });
    box._cleanup = () => { document.removeEventListener('keydown', onKey, true); document.body.style.overflow = prevOverflow; };
    q('pcvClose').onclick = closeViewer;
    q('pcvPrev').onclick = () => show(i - 1);
    q('pcvNext').onclick = () => show(i + 1);
    show(i);
    q('pcvClose').focus();
  }

  // ---------- сохранение, удаление, закрытие ----------
  async function saveCard() {
    const form = $c('#pcForm');
    if (!form || S.saving) return;
    const err = (m) => { const box = $c('#pcFormError'); box.textContent = m; box.classList.remove('hidden'); box.scrollIntoView({ block: 'nearest' }); };
    $c('#pcFormError').classList.add('hidden');
    const f = form.elements;
    const r = perms();
    const v = {
      id: f.id.value.trim(), address: f.address.value.trim(), description: f.description.value.trim(),
      lat: f.lat.value.trim(), lon: f.lon.value.trim(), status: f.status.value.trim(),
      inventory_number: f.inventory_number.value.trim(), sim_number: f.sim_number.value.trim(), notes: f.notes.value.trim(),
      category_name: f.category_name.value.trim(), category_color: f.category_color.value,
      verification_valid_until: f.verification_valid_until.value.trim(), power_source: readPowerSource(form),
      fault_reason: f.fault_reason.value.trim(), fault_need: f.fault_need.value.trim(),
      ip_address: r.network ? f.ip_address.value.trim() : '', port: r.network ? f.port.value.trim() : '',
      login: r.secrets ? f.login.value.trim() : '', password: r.secrets ? f.password.value.trim() : '',
    };
    if (!v.id) { err('Укажите номер комплекса.'); return; }
    S.saving = true;
    $c('#pcSave').disabled = true;
    try {
      const saved = S.isNew ? await Api.post('/api/points', v) : await Api.put(`/api/points/${encodeURIComponent(S.p.id)}`, v);
      S.changed = true;
      const wasNew = S.isNew;
      S.isNew = false;
      S.p = { ...EMPTY_POINT, ...saved };
      S.mode = 'view';
      await loadCardData();
      render();
      loadPhotos();
      toast(wasNew ? `Комплекс ${S.p.id} создан` : 'Сохранено', 'ok');
    } catch (e) {
      err(e.message);
    } finally {
      S.saving = false;
      if ($c('#pcSave')) $c('#pcSave').disabled = false;
    }
  }

  async function deleteCard() {
    if (!confirm(`Удалить комплекс ${S.p.id}? Задания и история сохранятся, но комплекс исчезнет из справочника.`)) return;
    try { await Api.del(`/api/points/${encodeURIComponent(S.p.id)}`); }
    catch (e) { alert(e.message); return; }
    S.changed = true;
    closeCard(true);
  }

  function closeCard(force) {
    if (!S) return;
    if (!force && dirty() && !confirm('Закрыть карточку без сохранения? Изменения будут потеряны.')) return;
    closeViewer();
    const changed = S.changed;
    if (modalWatch) { modalWatch.disconnect(); modalWatch = null; }
    document.removeEventListener('keydown', onCardKey, true);
    S.el.remove();
    document.body.style.overflow = S.prevOverflow;
    document.body.classList.remove('pc-open');
    S = null;
    if (changed && typeof close === 'function') close();            // страница обновит свои списки (у каждой страницы своя close())
    else editing = false;
  }

  function onCardKey(e) {
    if (e.key !== 'Escape' || !S) return;
    if (document.getElementById('pcView') || document.getElementById('pvBox')) return;                // просмотр файла/фото закрывается своим обработчиком
    if (($('#modal') || {}).innerHTML) return;                                                        // открыто окно поверх карточки (фото, журнал) — Esc закрывает его
    e.preventDefault();
    e.stopImmediatePropagation();
    closeCard();
  }

  async function loadCardData() {
    const [card, links] = await Promise.all([
      Api.get('/api/point-card?point_id=' + encodeURIComponent(S.p.id)).catch(() => ({ groups: [], plan: null, files: [] })),
      Api.get(`/api/points/${encodeURIComponent(S.p.id)}/sim-links`).catch(() => ({ linked: [] })),
    ]);
    S.card = card;
    S.simLinks = links.linked || [];
  }

  // Точка входа. id = null — новый комплекс (сразу в режиме правки). opts.edit — открыть сразу на правку.
  async function openPointCard(id, opts = {}) {
    injectStyle();
    if (S) closeCard(true);
    let p;
    if (id) {
      try { p = await Api.get('/api/points/' + encodeURIComponent(id)); }
      catch (e) { alert('Комплекс не найден или недоступен: ' + e.message); return; }
    } else if (!can('points.edit')) { alert('У вашей роли нет права создавать комплексы.'); return; }
    const el = document.createElement('div');
    el.className = 'pc-overlay';
    el.id = 'pcOverlay';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Карточка комплекса');
    S = { id, p: { ...EMPTY_POINT, ...(p || {}) }, isNew: !id, mode: (!id || (opts.edit && can('points.edit'))) ? 'edit' : 'view', card: { groups: [], plan: null, files: [] }, simLinks: [], photos: null, el, changed: false, prevOverflow: document.body.style.overflow };
    document.body.appendChild(el);
    document.body.style.overflow = 'hidden';
    document.body.classList.add('pc-open');
    editing = true;                                                  // пока карточка открыта, страница не перерисовывает списки по таймеру
    document.addEventListener('keydown', onCardKey, true);
    modalWatch = new MutationObserver(() => { if (S && !($('#modal') || {}).innerHTML) editing = true; });   // окно поверх карточки закрылось — опрос страницы по-прежнему на паузе
    modalWatch.observe($('#modal'), { childList: true });
    if (!S.isNew) await loadCardData();
    render();
    if (!S.isNew) loadPhotos();
  }

  window.openPointCard = openPointCard;

  // Плитка комплекса (список «Все АПК», «Точки на день», окно комплекса на карте) открывает карточку не только кнопкой 🗂 справа, но и щелчком по названию (data-brick-name)
  // или по свободному месту плитки (data-brick="номер"). Свободное место — не ближе BRICK_GAP пикселей к любой кнопке, ссылке или полю: промахи по соседним кнопкам не открывают карточку.
  // Не открывает: выделение текста, правый/средний клик, щелчок внутри кнопки/поля/метки и внутри блоков с data-no-brick (описание в подгруппе, проверка связи).
  const BRICK_GAP = 16;
  const BRICK_CONTROLS = 'button, a, input, select, textarea, label, summary, [role="button"], [data-no-brick]';
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const brick = e.target.closest && e.target.closest('[data-brick]');
    if (!brick || !brick.dataset.brick) return;
    if (e.target.closest(BRICK_CONTROLS)) return;
    const sel = window.getSelection && window.getSelection();
    if (sel && String(sel).trim()) return;
    if (typeof canAny === 'function' && !canAny('points.view', 'points.edit', 'calendar.view')) return;
    if (!e.target.closest('[data-brick-name]')) {
      for (const el of brick.querySelectorAll(BRICK_CONTROLS)) {
        const r = el.getBoundingClientRect();
        if (!r.width || !r.height) continue;                                     // скрытые кнопки (нет права) не в счёт
        const dx = Math.max(r.left - e.clientX, 0, e.clientX - r.right), dy = Math.max(r.top - e.clientY, 0, e.clientY - r.bottom);
        if (Math.hypot(dx, dy) < BRICK_GAP) return;
      }
    }
    openPointCard(brick.dataset.brick);
  });
})();
