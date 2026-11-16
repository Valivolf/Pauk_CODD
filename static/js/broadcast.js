// Массовая рассылка монтёрам в VK-бота — окно открывается кнопкой «📢 Рассылка» в окне «Чаты» (chat.js). Кому: «Всем», «По условиям»
// (роль, бригада на дату, только работающим, без отсутствующих, поиск) или «Вручную» (отметки); потом отметки можно поправить.
// Что: текст и фото (до 10). Сообщение уходит каждому как обычный ответ диспетчера — через бота и очередь чата — с пометкой «📢 Объявление».
// После отправки окно показывает итог по каждому человеку (доставлено / не доставлено с причиной / ждёт) и умеет повторить неудачным.
// Вкладка «История» — последние рассылки (хранятся неделю, как вся переписка).
// Бэкенд: app/api/routes_chat_broadcast.py, app/repositories/chat_repository.py (add_broadcast). Право: chat.broadcast.
// $, esc, Api, fmtDateTime, toast, btn*, fieldCls — из ui.js; ChatPanel.shrink — из chat.js.
const Broadcast = (function () {
  const ROLES = { fitter: 'Монтёр', driver: 'Водитель', operator: 'Оператор', warehouse: 'Склад' };
  const POLL_MS = 3000;
  const MAX_PHOTOS = 10;
  const st = {
    open: false, tab: 'new', data: null, loading: false, mode: 'all', chosen: new Set(), search: '', roles: new Set(), crewIds: new Set(),
    onlyCrews: false, skipAbsent: false, date: '', text: '', files: [], busy: false, confirm: false, token: '', manual: false,
    history: null, detail: null, detailFilter: 'all',
  };
  let overlay = null, pollTimer = null;

  const plural = (n, [one, few, many]) => { const m10 = n % 10, m100 = n % 100; return m10 === 1 && m100 !== 11 ? one : (m10 >= 2 && m10 <= 4 && (m100 < 10 || m100 >= 20) ? few : many); };
  const people = () => (st.data ? st.data.people : []);
  const newToken = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const fmtTime = (iso) => { try { return fmtDateTime(iso, true); } catch { return iso || ''; } };
  const crewName = (c) => c.name || `Бригада ${c.id}`;

  // Как VK объяснил отказ → понятно диспетчеру.
  function humanError(err) {
    const e = String(err || '');
    const code = (e.match(/\[(\d+)\]/) || [])[1];
    if (code === '901' || /without permission|не разреш/i.test(e)) return 'не разрешил сообщения от бота (нужно открыть диалог с ботом и нажать «Разрешить»)';
    if (code === '900' || /blacklist|чёрн/i.test(e)) return 'добавил сообщество в чёрный список — написать ему нельзя';
    if (code === '6' || code === '9' || /flood|too many/i.test(e)) return 'ВК временно ограничил частоту сообщений';
    return e || 'ВК не принял сообщение';
  }

  // ------------------------------------------------------------ данные
  async function loadPeople(date) {
    st.loading = true;
    try {
      const q = date ? `?date=${encodeURIComponent(date)}` : '';
      st.data = await Api.get('/api/chat/broadcast/people' + q);
      st.date = st.data.date;
      const known = new Set(people().map((p) => p.person_id));
      st.chosen = new Set([...st.chosen].filter((id) => known.has(id)));
      const crews = new Set(st.data.crews.map((c) => c.id));
      st.crewIds = new Set([...st.crewIds].filter((id) => crews.has(id)));
    } catch (e) {
      st.data = null;
      toast('Не удалось загрузить список получателей: ' + e.message, 'error');
    } finally { st.loading = false; }
  }

  function matches(p) {
    const q = st.search.trim().toLocaleLowerCase('ru');
    if (q && !p.full_name.toLocaleLowerCase('ru').includes(q)) return false;
    if (st.roles.size && !st.roles.has(p.role_type)) return false;
    if (st.crewIds.size && !p.crew_ids.some((id) => st.crewIds.has(id))) return false;
    if (st.onlyCrews && !p.crew_ids.length) return false;
    if (st.skipAbsent && p.absent) return false;
    return true;
  }

  function visible() {
    if (st.mode === 'filter') return people().filter(matches);
    const q = st.search.trim().toLocaleLowerCase('ru');
    return q ? people().filter((p) => p.full_name.toLocaleLowerCase('ru').includes(q)) : people();
  }

  // Режим «Всем» и «По условиям» сразу отмечают подходящих; «Вручную» оставляет отметки как есть.
  function applyPreset() {
    st.manual = false;
    if (st.mode === 'all') st.chosen = new Set(people().map((p) => p.person_id));
    else if (st.mode === 'filter') st.chosen = new Set(people().filter(matches).map((p) => p.person_id));
    st.confirm = false;
  }

  function describe() {
    const n = st.chosen.size;
    let d;
    if (st.mode === 'all') d = `Все (${n})`;
    else if (st.mode === 'pick') d = `Выбор вручную (${n})`;
    else {
      const parts = [];
      if (st.roles.size) parts.push('роль — ' + [...st.roles].map((r) => ROLES[r] || r).join(', '));
      if (st.crewIds.size) parts.push('бригады — ' + st.data.crews.filter((c) => st.crewIds.has(c.id)).map(crewName).join(', ') + ` на ${st.date}`);
      if (st.onlyCrews) parts.push(`только работающие в бригадах на ${st.date}`);
      if (st.skipAbsent) parts.push('без отсутствующих');
      if (st.search.trim()) parts.push(`поиск «${st.search.trim()}»`);
      d = `По условиям: ${parts.join('; ') || 'без условий'} (${n})`;
    }
    return st.manual && st.mode !== 'pick' ? d + ' · с правкой вручную' : d;
  }

  // ------------------------------------------------------------ оболочка
  function paintShell() {
    overlay.innerHTML = `<div style="position:absolute; inset:0; background:rgba(2,6,23,.78); backdrop-filter:blur(4px)" data-bcclose></div>
      <div class="glass rounded-3xl shadow-2xl" style="position:absolute; inset:2vh 2vw; display:flex; flex-direction:column; overflow:hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-b border-slate-700/60">
          <h2 class="font-display text-lg font-bold">📢 Массовая рассылка в бота</h2>
          <div class="flex items-center gap-2">
            <button data-bctab="new" class="${btnGhost} !px-3 !py-1.5 text-sm"></button>
            <button data-bctab="history" class="${btnGhost} !px-3 !py-1.5 text-sm"></button>
            <button data-bcclose class="${btnGhost} !px-3 !py-1.5 text-sm" title="Закрыть (Esc)">✕</button>
          </div>
        </div>
        <div id="bcBody" style="flex:1; min-height:0; overflow:auto"></div></div>`;
    overlay.querySelectorAll('[data-bcclose]').forEach((b) => { b.onclick = close; });
    overlay.querySelectorAll('[data-bctab]').forEach((b) => { b.onclick = () => setTab(b.dataset.bctab); });
    paintTabs();
  }

  function paintTabs() {
    overlay.querySelector('[data-bctab="new"]').textContent = '✏️ Новая рассылка';
    overlay.querySelector('[data-bctab="history"]').textContent = '🕘 История';
    overlay.querySelectorAll('[data-bctab]').forEach((b) => {
      const on = b.dataset.bctab === st.tab || (st.tab === 'detail' && b.dataset.bctab === 'history');
      b.style.outline = on ? '2px solid rgba(129,140,248,.8)' : 'none';
    });
  }

  async function setTab(tab) {
    stopPoll();
    st.tab = tab;
    paintTabs();
    if (tab === 'new') { await paintNew(); }
    else if (tab === 'history') { await loadHistory(); }
  }

  // ------------------------------------------------------------ новая рассылка
  async function paintNew() {
    const body = $('#bcBody');
    if (!st.data) { body.innerHTML = '<p class="p-6 text-sm text-slate-400">Загружаю список получателей…</p>'; await loadPeople(st.date); }
    if (!st.data) { body.innerHTML = '<p class="p-6 text-sm text-rose-300">Не удалось загрузить список получателей. Закройте окно и откройте снова.</p>'; return; }
    if (st.tab !== 'new') return;
    const d = st.data;
    body.innerHTML = `<div style="display:flex; flex-wrap:wrap; gap:1rem; padding:1rem 1.25rem; align-items:flex-start">
      <section style="flex:1 1 400px; min-width:0">
        <h3 class="font-semibold text-sm mb-2">1. Кому</h3>
        <div class="flex flex-wrap gap-2 mb-3" id="bcModes"></div>
        <div id="bcFilters"></div>
        <input id="bcSearch" placeholder="Поиск по фамилии…" value="${esc(st.search)}" class="${fieldCls} mb-2">
        <div class="flex flex-wrap items-center justify-between gap-2 mb-1">
          <span id="bcCount" class="text-xs text-slate-300"></span>
          <span class="flex gap-2"><button type="button" id="bcAddVisible" class="${btnGhost} !px-2.5 !py-1 text-xs">Отметить показанных</button>
            <button type="button" id="bcClearVisible" class="${btnGhost} !px-2.5 !py-1 text-xs">Снять отметки</button></span>
        </div>
        <div id="bcList" style="max-height:48vh; overflow:auto; border:1px solid rgba(100,116,139,.35); border-radius:.75rem; padding:.25rem"></div>
        ${d.no_vk ? `<p class="text-[11px] text-slate-500 mt-2">Ещё ${d.no_vk} ${plural(d.no_vk, ['человек', 'человека', 'человек'])} не ${d.no_vk % 10 === 1 && d.no_vk % 100 !== 11 ? 'привязан' : 'привязаны'} к боту (VK) — написать нельзя.</p>` : ''}
      </section>
      <section style="flex:1 1 400px; min-width:0">
        <h3 class="font-semibold text-sm mb-2">2. Что отправить</h3>
        <textarea id="bcText" rows="7" maxlength="${d.max_text}" placeholder="Текст объявления…" class="${fieldCls}" style="resize:vertical">${esc(st.text)}</textarea>
        <div class="flex items-center justify-between text-[11px] text-slate-500 mt-1"><span id="bcTextCount" style="white-space:nowrap; margin-right:.75rem"></span>
          <span>Монтёр увидит: «📢 Объявление от диспетчера» и ваш текст; ответить можно кнопкой «Ответить» — ответ придёт в «Чаты».</span></div>
        <div id="bcFiles" class="flex flex-wrap gap-2 mt-2" style="display:none"></div>
        <div class="flex items-center gap-2 mt-2"><button type="button" id="bcAttach" class="${btnGhost} !px-3" title="Прикрепить фото (или вставьте из буфера — Ctrl+V)">📎 Фото</button>
          <input id="bcFilePick" type="file" accept="image/*" multiple style="display:none"><span class="text-[11px] text-slate-500">до ${d.max_photos} фото; одно и то же фото уходит всем</span></div>
        ${d.bot_enabled ? '' : '<p class="text-xs text-amber-300 mt-3">⚠ Бот VK сейчас выключен — сообщения встанут в очередь и уйдут, когда его включат.</p>'}
        <div id="bcSendBox" class="mt-4"></div>
        <div id="bcErr" class="text-xs text-rose-300 mt-2"></div>
      </section></div>`;
    paintModes();
    paintFilters();
    paintList();
    paintFiles();
    paintSend();
    paintTextCount();
    $('#bcSearch').oninput = () => { st.search = $('#bcSearch').value; if (st.mode === 'filter') applyPreset(); paintList(); paintSend(); };
    $('#bcAddVisible').onclick = () => { visible().forEach((p) => st.chosen.add(p.person_id)); markManual(); paintList(); paintSend(); };
    $('#bcClearVisible').onclick = () => { visible().forEach((p) => st.chosen.delete(p.person_id)); markManual(); paintList(); paintSend(); };
    const text = $('#bcText');
    text.oninput = () => { st.text = text.value; st.confirm = false; paintTextCount(); paintSend(); };
    text.onpaste = (e) => {
      const pics = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
      if (pics.length) { e.preventDefault(); addFiles(pics); }
    };
    $('#bcAttach').onclick = () => $('#bcFilePick').click();
    $('#bcFilePick').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
  }

  function markManual() { st.manual = true; st.confirm = false; }

  function paintModes() {
    const box = $('#bcModes');
    if (!box) return;
    const items = [['all', 'Всем'], ['filter', 'По условиям'], ['pick', 'Вручную']];
    box.innerHTML = items.map(([k, label]) => `<button type="button" data-bcmode="${k}" class="${btnGhost} !px-3 !py-1.5 text-sm" style="${st.mode === k ? 'outline:2px solid rgba(129,140,248,.8); background:rgba(99,102,241,.2)' : ''}">${label}</button>`).join('');
    box.querySelectorAll('[data-bcmode]').forEach((b) => {
      b.onclick = () => { st.mode = b.dataset.bcmode; applyPreset(); paintModes(); paintFilters(); paintList(); paintSend(); };
    });
  }

  function paintFilters() {
    const box = $('#bcFilters');
    if (!box) return;
    if (st.mode !== 'filter') {
      box.innerHTML = `<p class="text-[11px] text-slate-500 mb-2">${st.mode === 'all' ? 'Все, кому можно написать. Лишних можно снять отметкой ниже.' : 'Отметьте нужных в списке ниже.'}</p>`;
      return;
    }
    const d = st.data;
    const roles = [...new Set(people().map((p) => p.role_type))];
    const chip = (attr, val, label, on) => `<button type="button" ${attr}="${esc(val)}" class="rounded-full border px-2.5 py-1 text-xs ${on ? 'border-indigo-400/70 bg-indigo-500/25 text-white' : 'border-slate-600 bg-slate-800/50 text-slate-300'}">${esc(label)}</button>`;
    box.innerHTML = `<div class="rounded-xl border border-slate-700/60 bg-slate-800/30 p-3 mb-2 space-y-2">
      <div><div class="text-[11px] text-slate-400 mb-1">Роль</div><div class="flex flex-wrap gap-1.5">${roles.map((r) => chip('data-bcrole', r, ROLES[r] || r, st.roles.has(r))).join('') || '<span class="text-xs text-slate-500">нет</span>'}</div></div>
      <div><div class="flex items-center gap-2 text-[11px] text-slate-400 mb-1">Бригады на дату <input id="bcDate" type="date" value="${esc(st.date)}" class="rounded-lg px-2 py-0.5 text-xs bg-slate-900/60 border border-slate-600"></div>
        <div class="flex flex-wrap gap-1.5">${d.crews.length ? d.crews.map((c) => chip('data-bccrew', c.id, `${crewName(c)} (${c.size})`, st.crewIds.has(c.id))).join('') : '<span class="text-xs text-slate-500">на эту дату бригад нет</span>'}</div></div>
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input id="bcOnlyCrews" type="checkbox" class="rounded accent-indigo-500" ${st.onlyCrews ? 'checked' : ''}> только те, кто на эту дату стоит в какой-нибудь бригаде</label>
      <label class="flex items-center gap-1.5 text-xs text-slate-300"><input id="bcSkipAbsent" type="checkbox" class="rounded accent-indigo-500" ${st.skipAbsent ? 'checked' : ''}> не писать тем, у кого на эту дату отсутствие</label>
    </div>`;
    const redo = () => { applyPreset(); paintFilters(); paintList(); paintSend(); };
    box.querySelectorAll('[data-bcrole]').forEach((b) => { b.onclick = () => { const r = b.dataset.bcrole; st.roles.has(r) ? st.roles.delete(r) : st.roles.add(r); redo(); }; });
    box.querySelectorAll('[data-bccrew]').forEach((b) => { b.onclick = () => { const id = +b.dataset.bccrew; st.crewIds.has(id) ? st.crewIds.delete(id) : st.crewIds.add(id); redo(); }; });
    $('#bcOnlyCrews').onchange = (e) => { st.onlyCrews = e.target.checked; redo(); };
    $('#bcSkipAbsent').onchange = (e) => { st.skipAbsent = e.target.checked; redo(); };
    $('#bcDate').onchange = async (e) => {
      if (!e.target.value) return;
      await loadPeople(e.target.value);
      redo();
    };
  }

  function paintList() {
    const list = $('#bcList');
    if (!list) return;
    const rows = visible();
    list.innerHTML = rows.length ? rows.map((p) => {
      const crews = p.crew_ids.map((id) => { const c = st.data.crews.find((x) => x.id === id); return c ? crewName(c) : ''; }).filter(Boolean).join(', ');
      return `<label class="flex items-center gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-700/30 cursor-pointer text-sm">
        <input type="checkbox" data-bcperson="${p.person_id}" class="rounded accent-indigo-500" ${st.chosen.has(p.person_id) ? 'checked' : ''}>
        <span class="truncate" style="flex:1">${esc(p.full_name)}</span>
        <span class="text-[10px] text-slate-400">${esc(ROLES[p.role_type] || p.role_type)}${crews ? ' · ' + esc(crews) : ''}</span>
        ${p.absent ? `<span class="text-[10px] text-amber-300" title="${esc(p.absent_reason)}">отсутствует${p.absent_reason ? ': ' + esc(p.absent_reason) : ''}</span>` : ''}</label>`;
    }).join('') : `<p class="text-xs text-slate-500 p-3">${people().length ? 'Под эти условия никто не подходит.' : 'Некому писать: нет людей, привязанных к боту.'}</p>`;
    list.querySelectorAll('[data-bcperson]').forEach((c) => {
      c.onchange = () => { const id = +c.dataset.bcperson; c.checked ? st.chosen.add(id) : st.chosen.delete(id); markManual(); paintCount(); paintSend(); };
    });
    paintCount();
  }

  function paintCount() {
    const el = $('#bcCount');
    if (!el) return;
    const shown = visible();
    const inShown = shown.filter((p) => st.chosen.has(p.person_id)).length;
    el.innerHTML = `<b>Выбрано: ${st.chosen.size}</b> из ${people().length}${shown.length !== people().length ? ` · показано ${shown.length}, из них отмечено ${inShown}` : ''}`;
  }

  function paintTextCount() {
    const el = $('#bcTextCount');
    if (el) el.textContent = `${st.text.length} / ${st.data.max_text}`;
  }

  function addFiles(list) {
    const err = $('#bcErr');
    if (err) err.textContent = '';
    for (const f of list) {
      if (!f.type.startsWith('image/')) { if (err) err.textContent = `«${f.name}» — не картинка, пропущено`; continue; }
      if (st.files.length >= MAX_PHOTOS) { if (err) err.textContent = `Не больше ${MAX_PHOTOS} фото в одной рассылке`; break; }
      st.files.push({ file: f, url: URL.createObjectURL(f) });
    }
    st.confirm = false;
    paintFiles();
    paintSend();
  }

  function paintFiles() {
    const box = $('#bcFiles');
    if (!box) return;
    box.style.display = st.files.length ? 'flex' : 'none';
    box.innerHTML = st.files.map((x, i) => `<span style="position:relative; display:inline-block">
      <img src="${x.url}" alt="" style="width:72px; height:72px; object-fit:cover; border-radius:8px; display:block">
      <button type="button" data-bcrm="${i}" title="Убрать" style="position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:9999px; border:0; cursor:pointer; background:#f43f5e; color:#fff; font-size:12px; line-height:1">✕</button></span>`).join('');
    box.querySelectorAll('[data-bcrm]').forEach((b) => { b.onclick = () => { const [x] = st.files.splice(+b.dataset.bcrm, 1); URL.revokeObjectURL(x.url); st.confirm = false; paintFiles(); paintSend(); }; });
  }

  function problem() {
    if (!st.chosen.size) return 'Отметьте получателей слева.';
    if (!st.text.trim() && !st.files.length) return 'Напишите текст или приложите фото.';
    return '';
  }

  function paintSend() {
    const box = $('#bcSendBox');
    if (!box) return;
    const n = st.chosen.size;
    const why = problem();
    const noun = plural(n, ['получателю', 'получателям', 'получателям']);
    if (st.confirm && !why) {
      box.innerHTML = `<div class="rounded-xl border border-rose-400/40 bg-rose-500/10 p-3">
        <p class="text-sm mb-2">Отправить это сообщение <b>${n}</b> ${plural(n, ['человеку', 'людям', 'людям'])}${st.files.length ? ` (с фото: ${st.files.length})` : ''}? После отправки отозвать его нельзя.</p>
        <div class="flex gap-2"><button type="button" id="bcYes" class="${btnPrimary}" ${st.busy ? 'disabled' : ''}>${st.busy ? 'Отправляю…' : 'Да, отправить'}</button>
          <button type="button" id="bcNo" class="${btnGhost}" ${st.busy ? 'disabled' : ''}>Назад</button></div></div>`;
      $('#bcYes').onclick = send;
      $('#bcNo').onclick = () => { st.confirm = false; paintSend(); };
      return;
    }
    box.innerHTML = `<button type="button" id="bcGo" class="${btnPrimary}" ${why ? 'disabled' : ''}>📢 Отправить ${n} ${noun}</button>
      ${why ? `<span class="text-xs text-slate-500 ml-2">${esc(why)}</span>` : `<div class="text-[11px] text-slate-500 mt-1">${esc(describe())}</div>`}`;
    $('#bcGo').onclick = () => { st.confirm = true; paintSend(); };
  }

  async function send() {
    if (st.busy || problem()) return;
    st.busy = true;
    paintSend();
    const err = $('#bcErr');
    if (err) err.textContent = '';
    try {
      const fd = new FormData();
      fd.append('text', st.text.trim());
      fd.append('person_ids', JSON.stringify([...st.chosen]));
      fd.append('mode', st.mode);
      fd.append('filter_desc', describe());
      fd.append('token', st.token);
      for (const x of st.files) { const f = await ChatPanel.shrink(x.file); fd.append('files', f, f.name || 'photo.jpg'); }
      const res = await Api.upload('/api/chat/broadcast', fd);
      st.files.forEach((x) => URL.revokeObjectURL(x.url));
      st.files = [];
      st.text = '';
      st.confirm = false;
      st.token = newToken();
      st.detail = res;
      st.detailFilter = 'all';
      st.tab = 'detail';
      toast(res.duplicate ? 'Эта рассылка уже была отправлена — показываю её итог' : `Рассылка поставлена в очередь: ${res.total} ${plural(res.total, ['сообщение', 'сообщения', 'сообщений'])}${res.skipped ? `, пропущено ${res.skipped} (нет VK или деактивированы)` : ''}`, 'ok');
      paintTabs();
      await openDetail(res.id);
    } catch (e) {
      st.confirm = false;
      const el = $('#bcErr');
      if (el) el.textContent = 'Не отправлено: ' + e.message;
    } finally {
      st.busy = false;
      paintSend();
    }
  }

  // ------------------------------------------------------------ итог рассылки
  const STATUS = {
    delivered: ['✓ доставлено', 'text-emerald-300'],
    failed: ['⚠ не доставлено', 'text-rose-300'],
    pending: ['⏳ ждёт отправки', 'text-amber-300'],
  };

  async function openDetail(id) {
    stopPoll();
    st.tab = 'detail';
    paintTabs();
    try { st.detail = await Api.get(`/api/chat/broadcast/${id}`); } catch (e) { toast('Не удалось открыть рассылку: ' + e.message, 'error'); return; }
    paintDetail();
    schedulePoll();
  }

  function schedulePoll() {
    stopPoll();
    if (!st.open || st.tab !== 'detail' || !st.detail || !st.detail.pending) return;
    pollTimer = setTimeout(async () => {
      if (!st.open || st.tab !== 'detail' || !st.detail) return;
      try { st.detail = await Api.get(`/api/chat/broadcast/${st.detail.id}`); paintDetail(); } catch { /* повторим */ }
      schedulePoll();
    }, POLL_MS);
  }

  function stopPoll() { if (pollTimer) { clearTimeout(pollTimer); pollTimer = null; } }

  function paintDetail() {
    const body = $('#bcBody');
    const d = st.detail;
    if (!body || !d || st.tab !== 'detail') return;
    const done = d.delivered + d.failed;
    const pct = d.present ? Math.round((done / d.present) * 100) : 100;
    const rows = d.recipients.filter((r) => st.detailFilter === 'all' || r.status === st.detailFilter);
    const chip = (k, label, n) => `<button type="button" data-bcfilter="${k}" class="rounded-full border px-2.5 py-1 text-xs ${st.detailFilter === k ? 'border-indigo-400/70 bg-indigo-500/25 text-white' : 'border-slate-600 bg-slate-800/50 text-slate-300'}">${label} · ${n}</button>`;
    body.innerHTML = `<div style="padding:1rem 1.25rem; max-width:980px; margin:0 auto">
      <div class="flex flex-wrap items-center justify-between gap-2 mb-3">
        <div><b class="text-base">Рассылка от ${esc(fmtTime(d.created_at))}</b><div class="text-[11px] text-slate-400">${esc(d.author || '')} · ${esc(d.filter_desc || '')}${d.photos ? ` · фото: ${d.photos}` : ''}</div></div>
        <div class="flex gap-2"><button type="button" id="bcBackHist" class="${btnGhost} !px-3 !py-1.5 text-sm">← К истории</button>
          ${d.failed ? `<button type="button" id="bcRetry" class="${btnPrimary} !px-3 !py-1.5">Повторить неудачным (${d.failed})</button>` : ''}</div></div>
      <div class="rounded-xl border border-slate-700/60 bg-slate-800/30 p-3 mb-3" style="white-space:pre-wrap; overflow-wrap:anywhere; font-size:.875rem">${d.text ? esc(d.text) : '<span class="text-slate-500">(только фото)</span>'}</div>
      <div class="mb-1 text-sm"><b>${done}</b> из ${d.present} обработано · <span class="text-emerald-300">доставлено ${d.delivered}</span>${d.failed ? ` · <span class="text-rose-300">не доставлено ${d.failed}</span>` : ''}${d.pending ? ` · <span class="text-amber-300">ждёт ${d.pending}</span>` : ''}</div>
      <div style="height:8px; border-radius:9999px; background:rgba(100,116,139,.3); overflow:hidden; margin-bottom:.75rem"><div style="height:100%; width:${pct}%; background:#34d399; transition:width .4s"></div></div>
      ${d.pending ? '<p class="text-[11px] text-slate-500 mb-2">Бот отправляет по несколько сообщений каждые 3 секунды; окно обновляется само. Если «ждёт» долго — бот выключен или не отвечает.</p>' : ''}
      <div class="flex flex-wrap gap-1.5 mb-2">${chip('all', 'Все', d.recipients.length)}${chip('delivered', 'Доставлено', d.delivered)}${chip('failed', 'Не доставлено', d.failed)}${chip('pending', 'Ждёт', d.pending)}</div>
      <div style="border:1px solid rgba(100,116,139,.35); border-radius:.75rem; overflow:hidden">${rows.length ? rows.map((r) => {
        const [label, cls] = STATUS[r.status];
        return `<div class="flex flex-wrap items-center gap-x-3 gap-y-0.5 px-3 py-1.5 border-b border-slate-700/40 text-sm"><span style="flex:1 1 200px">${esc(r.full_name)} <span class="text-[10px] text-slate-500">${esc(ROLES[r.role_type] || '')}</span></span>
          <span class="${cls} text-xs">${label}${r.status === 'failed' ? ': ' + esc(humanError(r.error)) : ''}${r.status === 'pending' && r.attempts ? ` (попыток: ${r.attempts})` : ''}</span></div>`;
      }).join('') : '<p class="text-xs text-slate-500 p-3">Нет записей в этой группе.</p>'}</div></div>`;
    $('#bcBackHist').onclick = () => setTab('history');
    const retry = $('#bcRetry');
    if (retry) retry.onclick = async () => {
      retry.disabled = true;
      try { const r = await Api.post(`/api/chat/broadcast/${d.id}/retry`, {}); toast(`Поставлено в очередь повторно: ${r.requeued}`, 'ok'); await openDetail(d.id); }
      catch (e) { toast('Не удалось повторить: ' + e.message, 'error'); retry.disabled = false; }
    };
    body.querySelectorAll('[data-bcfilter]').forEach((b) => { b.onclick = () => { st.detailFilter = b.dataset.bcfilter; paintDetail(); }; });
  }

  // ------------------------------------------------------------ история
  async function loadHistory() {
    const body = $('#bcBody');
    body.innerHTML = '<p class="p-6 text-sm text-slate-400">Загружаю историю…</p>';
    try { st.history = await Api.get('/api/chat/broadcast'); } catch (e) { body.innerHTML = `<p class="p-6 text-sm text-rose-300">Не удалось загрузить историю: ${esc(e.message)}</p>`; return; }
    if (st.tab !== 'history') return;
    body.innerHTML = `<div style="padding:1rem 1.25rem; max-width:980px; margin:0 auto">
      <p class="text-[11px] text-slate-500 mb-2">Рассылки хранятся неделю — как вся переписка.</p>
      ${st.history.length ? st.history.map((h) => `<button type="button" data-bchist="${h.id}" class="w-full text-left rounded-xl px-3 py-2 mb-2 border border-slate-700/50 bg-slate-800/30 hover:bg-slate-700/40">
        <div class="flex flex-wrap items-center justify-between gap-2"><b class="text-sm">${esc(fmtTime(h.created_at))}</b>
          <span class="text-xs"><span class="text-emerald-300">✓ ${h.delivered}</span>${h.failed ? ` · <span class="text-rose-300">⚠ ${h.failed}</span>` : ''}${h.pending ? ` · <span class="text-amber-300">⏳ ${h.pending}</span>` : ''} <span class="text-slate-500">из ${h.present}</span></span></div>
        <div class="text-sm truncate">${h.text ? esc(h.text) : '<span class="text-slate-500">(только фото)</span>'}</div>
        <div class="text-[11px] text-slate-500 truncate">${esc(h.author)} · ${esc(h.filter_desc || '')}${h.photos ? ` · фото: ${h.photos}` : ''}</div></button>`).join('')
        : '<p class="text-sm text-slate-500 py-8 text-center">Рассылок пока не было.</p>'}</div>`;
    body.querySelectorAll('[data-bchist]').forEach((b) => { b.onclick = () => openDetail(+b.dataset.bchist); });
  }

  // ------------------------------------------------------------ открыть / закрыть
  async function open() {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'bcOverlay';
      overlay.style.cssText = 'position:fixed; inset:0; z-index:60;';
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    st.open = true;
    st.tab = 'new';
    st.data = null;
    st.token = newToken();
    st.confirm = false;
    st.mode = 'all';
    st.chosen = new Set();
    st.search = '';
    st.roles = new Set();
    st.crewIds = new Set();
    st.onlyCrews = false;
    st.skipAbsent = false;
    st.manual = false;
    st.date = '';
    paintShell();
    await paintNew();
    applyPreset();
    paintList();
    paintSend();
  }

  function close() {
    stopPoll();
    st.open = false;
    st.files.forEach((x) => URL.revokeObjectURL(x.url));
    st.files = [];
    if (overlay) { overlay.remove(); overlay = null; }
  }

  // Esc закрывает только это окно (перехват раньше, чем сработает закрытие окна «Чаты» под ним).
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.open) { e.stopPropagation(); close(); } }, true);

  return { open, close };
})();
