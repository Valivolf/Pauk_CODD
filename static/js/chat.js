// Окно «Чаты» — переписка монтёров из VK-бота с диспетчером, на любой странице панели. Кнопка 💬 слева внизу (рядом с 🔔)
// показывает число непрочитанных; по нажатию открывается окно почти на весь экран: слева список чатов, справа переписка
// и поле для ответа — ответ уходит монтёру в VK через бота. Новое сообщение сопровождается звуком/уведомлением, как
// запросы к диспетчеру. История переписки хранится и показывается только здесь (бот её не показывает) и только неделю.
// В сообщении можно прислать фото (до 10) — и от монтёра, и ответом: кнопка 📎 или вставка из буфера (Ctrl+V); крупные снимки
// перед отправкой уменьшаются. Миниатюры открываются на всё окно (просмотр из ui.js).
// Бэкенд: app/api/routes_chat.py, app/repositories/chat_repository.py. $, esc, Api, fmtDateTime, btn*, fieldCls из ui.js.
const ChatPanel = (function () {
  const POLL_MS = 5000;
  const st = { me: null, open: false, people: [], active: null, msgs: [], lastId: 0, filter: '', all: false, unread: 0, busy: false, narrowList: true, files: [], peopleLoading: true, msgsLoading: false };
  const MAX_PHOTOS = 10;
  const SHRINK_OVER = 1.5 * 1024 * 1024;   // снимки крупнее этого уменьшаем перед отправкой (телефонные фото по 5–10 МБ)
  const SHRINK_SIDE = 1920;
  let fab = null, badge = null, overlay = null, timer = null, announcedUpTo = 0;

  const hasPerm = (key) => !!(st.me && (st.me.permissions || []).some((p) => p === '*' || p === key));
  const readOnly = () => !hasPerm('chat.use');
  const person = () => st.people.find((p) => p.person_id === st.active) || null;
  const fmtTime = (iso) => { try { return fmtDateTime(iso, true); } catch { return iso || ''; } };
  const nearBottom = (el) => el.scrollHeight - el.scrollTop - el.clientHeight < 80;

  function statusOf(m) {
    if (m.direction !== 'out') return '';
    if (m.failed_at) return `<span class="text-rose-300" title="${esc(m.delivery_error || '')}">⚠ не доставлено${m.delivery_error ? ': ' + esc(m.delivery_error) : ''}</span>`;
    if (m.delivered_at) return '<span class="text-emerald-300">✓ доставлено</span>';
    const ageSec = (Date.now() - new Date(m.created_at).getTime()) / 1000;
    return `<span class="text-amber-300">⏳ ${ageSec > 45 ? 'ждёт доставки (бот не отвечает?)' : 'отправляется…'}</span>`;
  }

  function photosHtml(m) {
    const list = m.attachments || [];
    if (!list.length) return '';
    const side = list.length === 1 ? 240 : 112;
    return `<div data-pv-scope style="display:flex; flex-wrap:wrap; gap:6px; ${m.text ? 'margin-bottom:6px' : ''}">${list.map((a) =>
      `<a data-pv href="/api/chat/files/${a.id}" data-pv-title="${esc(a.name || 'фото')}" data-pv-sub="${esc(fmtTime(m.created_at))}" target="_blank" rel="noopener">`
      + `<img src="/api/chat/files/${a.id}" alt="фото" loading="lazy" style="width:${side}px; height:${side}px; object-fit:cover; border-radius:10px; display:block; background:rgba(15,23,42,.6)" onerror="this.replaceWith(Object.assign(document.createElement('span'),{className:'text-[11px] text-slate-400',textContent:'фото удалено (хранится неделю)'}))"></a>`).join('')}</div>`;
  }

  function bubbleHtml(m) {
    const mine = m.direction === 'out';
    return `<div style="display:flex; justify-content:${mine ? 'flex-end' : 'flex-start'}" data-chatmsg="${m.id}">
      <div class="rounded-2xl px-3 py-2 text-sm ${mine ? 'bg-indigo-500/25 border border-indigo-400/30' : 'bg-slate-700/60 border border-slate-600/50'}" style="max-width:min(560px, 85%)">
        ${photosHtml(m)}${m.text ? `<div style="white-space:pre-wrap; overflow-wrap:anywhere">${esc(m.text)}</div>` : ''}
        <div class="text-[10px] text-slate-400 mt-1 flex flex-wrap items-center gap-2">
          <span>${esc(fmtTime(m.created_at))}</span>${mine ? `<span>· ${esc(m.author || 'диспетчер')}</span>` : ''}
          ${m.broadcast_id ? '<span class="rounded-full bg-indigo-500/20 text-indigo-200 px-1.5" title="Это сообщение ушло всем выбранным в массовой рассылке">📢 рассылка</span>' : ''}
          ${m.point_id ? `<span class="rounded-full bg-slate-800/70 px-1.5">комплекс ${esc(m.point_id)}</span>` : ''}${statusOf(m) ? statusOf(m) : ''}
        </div></div></div>`;
  }

  function listHtml() {
    if (!st.people.length && st.peopleLoading) return loadingHtml('Данные загружаются…', 'text-xs text-slate-500 p-3');
    if (!st.people.length) return `<p class="text-xs text-slate-500 p-3">${st.filter ? 'Никого не найдено' : 'Переписок пока нет. Включите «все монтёры», чтобы написать первым.'}</p>`;
    return st.people.map((p) => `<button data-chatperson="${p.person_id}" class="w-full text-left rounded-xl px-3 py-2 mb-1 border ${p.person_id === st.active ? 'border-indigo-400/50 bg-indigo-500/15' : 'border-slate-700/50 bg-slate-800/30 hover:bg-slate-700/40'}">
      <div class="flex items-center justify-between gap-2"><b class="text-sm truncate">${esc(p.full_name)}</b>
        ${p.unread ? `<span class="rounded-full bg-rose-500 text-white text-[10px] font-bold px-1.5 py-0.5">${p.unread}</span>` : ''}</div>
      <div class="text-[11px] text-slate-400 truncate">${p.last_id ? `${p.last_direction === 'out' ? 'Вы: ' : ''}${esc(p.last_text)}` : '<span class="text-slate-500">нет сообщений</span>'}</div>
      <div class="text-[10px] text-slate-500">${p.last_at ? esc(fmtTime(p.last_at)) : ''}${p.last_failed ? ' · <span class="text-rose-300">не доставлено</span>' : ''}${p.last_point_id ? ' · ' + esc(p.last_point_id) : ''}</div>
    </button>`).join('');
  }

  function paintShell() {
    overlay.innerHTML = `<div style="position:absolute; inset:0; background:rgba(2,6,23,.72); backdrop-filter:blur(4px)" data-chatclose></div>
      <div class="glass rounded-3xl shadow-2xl" style="position:absolute; inset:2.5vh 2vw; display:flex; flex-direction:column; overflow:hidden">
        <div class="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-b border-slate-700/60">
          <h2 class="font-display text-lg font-bold">💬 Чаты с монтёрами</h2>
          <div class="flex items-center gap-2"><span class="text-[11px] text-slate-500">Ответ уходит монтёру в VK через бота. История переписки — только здесь и хранится 7 дней.</span>
            ${hasPerm('chat.broadcast') && typeof Broadcast !== 'undefined' ? `<button data-chatbroadcast class="${btnGhost} !px-3 !py-1.5 text-sm" title="Одно сообщение сразу многим монтёрам: всем, по условиям или по выбору">📢 Рассылка</button>` : ''}
            <button data-chatclose class="${btnGhost} !px-3 !py-1.5 text-sm" title="Закрыть (Esc)">✕</button></div>
        </div>
        <div id="chatBody" style="display:grid; grid-template-columns:minmax(240px,320px) 1fr; flex:1; min-height:0">
          <aside id="chatListBox" style="display:flex; flex-direction:column; min-height:0; border-right:1px solid rgba(100,116,139,.35)">
            <div class="p-3 space-y-2">
              <input id="chatSearch" placeholder="Поиск по фамилии…" value="${esc(st.filter)}" class="${fieldCls}">
              <label class="flex items-center gap-1.5 text-xs text-slate-300"><input id="chatAll" type="checkbox" class="rounded accent-indigo-500" ${st.all ? 'checked' : ''}> все монтёры (написать первым)</label>
            </div>
            <div id="chatList" style="flex:1; overflow:auto; padding:0 .75rem .75rem"></div>
          </aside>
          <section id="chatPane" style="display:flex; flex-direction:column; min-height:0; min-width:0"></section>
        </div></div>`;
    overlay.querySelectorAll('[data-chatclose]').forEach((b) => { b.onclick = close; });
    overlay.querySelector('[data-chatbroadcast]')?.addEventListener('click', () => Broadcast.open());
    $('#chatSearch').oninput = debounce(() => { st.filter = $('#chatSearch').value.trim(); loadPeople(); }, 250);
    $('#chatAll').onchange = (e) => { st.all = e.target.checked; loadPeople(); };
    paintList();
    paintPane(true);
  }

  const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };

  function paintList() {
    const box = $('#chatList');
    if (!box) return;
    box.innerHTML = listHtml();
    box.querySelectorAll('[data-chatperson]').forEach((b) => { b.onclick = () => select(+b.dataset.chatperson); });
  }

  function paneHead(p) {
    return `<div class="px-5 py-3 border-b border-slate-700/60 flex flex-wrap items-center justify-between gap-2">
      <div><b class="text-base">${esc(p.full_name)}</b>
        <div class="text-[11px] text-slate-400">${p.phone ? '☎ ' + esc(p.phone) + ' · ' : ''}VK ${esc(String(p.vk_id))}${p.active ? '' : ' · <span class="text-amber-300">деактивирован</span>'}</div></div>
      <button data-chatback class="${btnGhost} !px-3 !py-1 text-xs" id="chatBack">← К списку</button></div>`;
  }

  function paintPane(full) {
    const pane = $('#chatPane');
    if (!pane) return;
    const p = person();
    if (!p) {
      pane.innerHTML = '<div class="flex-1 grid place-items-center text-sm text-slate-500 p-6 text-center">Выберите чат слева — здесь будет переписка и поле для ответа.</div>';
      return;
    }
    if (full || !$('#chatMsgs')) {
      pane.innerHTML = `${paneHead(p)}
        <div id="chatMsgs" style="flex:1; overflow:auto; padding:1rem 1.25rem; display:flex; flex-direction:column; gap:.5rem"></div>
        <div class="px-4 py-3 border-t border-slate-700/60">
          ${readOnly() ? '<p class="text-xs text-slate-500">Роль «только просмотр» читает переписку, но не может отвечать.</p>' : `
          <div id="chatFiles" class="flex flex-wrap gap-2 mb-2" style="display:none"></div>
          <div class="flex items-end gap-2"><button id="chatAttach" type="button" class="${btnGhost} !px-3" title="Прикрепить фото (или вставьте из буфера — Ctrl+V)" ${p.active ? '' : 'disabled'}>📎</button>
            <input id="chatFilePick" type="file" accept="image/*" multiple style="display:none">
            <textarea id="chatInput" rows="2" placeholder="Ответ монтёру… (Enter — отправить, Shift+Enter — новая строка; 📎 или Ctrl+V — фото)" class="${fieldCls}" style="resize:none; flex:1" ${p.active ? '' : 'disabled'}></textarea>
            <button id="chatSend" class="${btnPrimary}" ${p.active ? '' : 'disabled'}>Отправить</button></div>
          <div id="chatErr" class="text-xs text-rose-300 mt-1"></div>`}
        </div>`;
      $('#chatBack').onclick = () => { st.narrowList = true; layout(); };
      const input = $('#chatInput');
      if (input) {
        input.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
        input.onpaste = (e) => {
          const pics = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
          if (pics.length) { e.preventDefault(); addFiles(pics); }
        };
        setTimeout(() => input.focus(), 50);
        $('#chatSend').onclick = send;
        $('#chatAttach').onclick = () => $('#chatFilePick').click();
        $('#chatFilePick').onchange = (e) => { addFiles([...e.target.files]); e.target.value = ''; };
        paintFiles();
      }
    }
    const box = $('#chatMsgs');
    const stick = full || nearBottom(box);
    box.innerHTML = st.msgs.length ? st.msgs.map(bubbleHtml).join('')
      : st.msgsLoading ? loadingHtml('Загружаю переписку…', 'text-sm text-slate-500 text-center py-8')
        : '<p class="text-sm text-slate-500 text-center py-8">Сообщений пока нет — напишите первым.</p>';
    if (stick) box.scrollTop = box.scrollHeight;
    if (full) layout();
  }

  function addFiles(list) {
    const err = $('#chatErr');
    if (err) err.textContent = '';
    for (const f of list) {
      if (!f.type.startsWith('image/')) { if (err) err.textContent = `«${f.name}» — не картинка, пропущено`; continue; }
      if (st.files.length >= MAX_PHOTOS) { if (err) err.textContent = `Не больше ${MAX_PHOTOS} фото в одном сообщении`; break; }
      st.files.push({ file: f, url: URL.createObjectURL(f) });
    }
    paintFiles();
  }

  function paintFiles() {
    const box = $('#chatFiles');
    if (!box) return;
    box.style.display = st.files.length ? 'flex' : 'none';
    box.innerHTML = st.files.map((x, i) => `<span style="position:relative; display:inline-block">
      <img src="${x.url}" alt="" style="width:64px; height:64px; object-fit:cover; border-radius:8px; display:block">
      <button type="button" data-chatrm="${i}" title="Убрать" style="position:absolute; top:-6px; right:-6px; width:20px; height:20px; border-radius:9999px; border:0; cursor:pointer; background:#f43f5e; color:#fff; font-size:12px; line-height:1">✕</button></span>`).join('');
    box.querySelectorAll('[data-chatrm]').forEach((b) => { b.onclick = () => { const [x] = st.files.splice(+b.dataset.chatrm, 1); URL.revokeObjectURL(x.url); paintFiles(); }; });
  }

  // Крупные снимки уменьшаем (длинная сторона до SHRINK_SIDE, JPEG): телефонные фото по 5–10 МБ ушли бы долго и упёрлись в лимит запроса.
  async function shrink(file) {
    if (file.size <= SHRINK_OVER || file.type === 'image/gif') return file;
    try {
      const bmp = await createImageBitmap(file);
      const k = Math.min(1, SHRINK_SIDE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(bmp.width * k);
      canvas.height = Math.round(bmp.height * k);
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
      return blob && blob.size < file.size ? new File([blob], (file.name || 'photo').replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' }) : file;
    } catch { return file; }
  }

  // На узком экране — одна колонка: список или переписка.
  function layout() {
    const body = $('#chatBody');
    if (!body) return;
    const narrow = window.innerWidth < 760;
    body.style.gridTemplateColumns = narrow ? '1fr' : 'minmax(240px,320px) 1fr';
    $('#chatListBox').style.display = narrow && !st.narrowList ? 'none' : 'flex';
    $('#chatPane').style.display = narrow && st.narrowList ? 'none' : 'flex';
    const back = $('#chatBack');
    if (back) back.style.display = narrow ? '' : 'none';
  }

  async function loadPeople() {
    try {
      const q = new URLSearchParams();
      if (st.filter) q.set('q', st.filter);
      if (st.all) q.set('all', 'true');
      st.people = await Api.get('/api/chat/conversations?' + q);
    } catch { if (st.peopleLoading) { st.peopleLoading = false; paintList(); } return; }
    st.peopleLoading = false;
    paintList();
    if (st.active && !person()) { paintPane(true); }
  }

  async function select(personId) {
    if (st.active !== personId) { st.files.forEach((x) => URL.revokeObjectURL(x.url)); st.files = []; }
    st.active = personId;
    st.msgs = [];
    st.lastId = 0;
    st.narrowList = false;
    st.msgsLoading = true;                                    // пока переписка не пришла, не пишем «сообщений нет»
    paintList();
    paintPane(true);
    layout();
    try { await loadMessages(true); }
    finally { st.msgsLoading = false; if (st.active === personId && !st.msgs.length) paintPane(false); }
    const p = person();
    if (p && p.unread && !readOnly()) {
      try { await Api.post(`/api/chat/${personId}/read`, {}); } catch { /* не критично */ }
      p.unread = 0;
      paintList();
      refreshBadge();
    }
  }

  async function loadMessages(initial) {
    if (!st.active) return;
    const id = st.active;
    let res;
    try { res = await Api.get(`/api/chat/${id}/messages?after_id=${initial ? 0 : st.lastId}&limit=300`); } catch { return; }
    if (id !== st.active) return;
    if (initial) { st.msgs = res; st.msgsLoading = false; }
    else if (res.length) st.msgs = [...st.msgs, ...res];
    else {
      // Статусы доставки у уже показанных исходящих меняются — перечитываем последние сообщения, пока что-то ждёт доставки.
      if (st.msgs.some((m) => m.direction === 'out' && !m.delivered_at && !m.failed_at)) {
        try { const fresh = await Api.get(`/api/chat/${id}/messages?limit=60`); const ids = new Set(fresh.map((m) => m.id)); st.msgs = [...st.msgs.filter((m) => !ids.has(m.id)), ...fresh]; paintPane(false); } catch { /* ignore */ }
      }
      return;
    }
    st.lastId = st.msgs.length ? st.msgs[st.msgs.length - 1].id : 0;
    paintPane(initial);
    if (!initial && res.some((m) => m.direction === 'in') && !readOnly() && !document.hidden) {
      try { await Api.post(`/api/chat/${id}/read`, {}); } catch { /* ignore */ }
    }
  }

  async function send() {
    const input = $('#chatInput');
    if (!input || st.busy) return;
    const text = input.value.trim();
    if (!text && !st.files.length) return;
    st.busy = true;
    $('#chatErr').textContent = '';
    const sendBtn = $('#chatSend');
    if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = st.files.length ? 'Отправляю…' : 'Отправить'; }
    try {
      let msg;
      if (st.files.length) {
        const fd = new FormData();
        fd.append('text', text);
        for (const x of st.files) { const f = await shrink(x.file); fd.append('files', f, f.name || 'photo.jpg'); }
        msg = await Api.upload(`/api/chat/${st.active}/send-photos`, fd);
        st.files.forEach((x) => URL.revokeObjectURL(x.url));
        st.files = [];
        paintFiles();
      } else {
        msg = await Api.post(`/api/chat/${st.active}/send`, { text });
      }
      input.value = '';
      st.msgs.push(msg);
      st.lastId = msg.id;
      paintPane(false);
      const box = $('#chatMsgs');
      if (box) box.scrollTop = box.scrollHeight;
      loadPeople();
    } catch (e) {
      $('#chatErr').textContent = 'Не отправлено: ' + e.message;
    } finally {
      st.busy = false;
      const btn = $('#chatSend');
      if (btn) { btn.disabled = false; btn.textContent = 'Отправить'; }
      input.focus();
    }
  }

  async function refreshBadge() {
    let sum;
    try { sum = await Api.get('/api/chat/unread'); } catch { return; }
    st.unread = sum.total;
    if (badge) {
      badge.textContent = sum.total > 99 ? '99+' : String(sum.total);
      badge.style.display = sum.total ? 'grid' : 'none';
    }
    if (fab) fab.title = sum.total ? `Чаты с монтёрами — непрочитанных: ${sum.total}` : 'Чаты с монтёрами';
    // Звук и уведомление — один раз на каждое новое входящее сообщение (и при первом заходе — только на свежие).
    if (sum.last_id && sum.last_id > announcedUpTo) {
      const fresh = sum.recent.filter((m) => m.id > announcedUpTo);
      if (announcedUpTo !== 0 || !st.open) {
        fresh.slice(0, 3).reverse().forEach((m) => {
          if (typeof DispatcherNotify !== 'undefined') DispatcherNotify.announce(`chat:${m.id}`, `Сообщение от монтёра: ${m.full_name}`, m.text, false);
        });
      }
      announcedUpTo = sum.last_id;
    }
  }

  async function tick() {
    await refreshBadge();
    if (!st.open) return;
    await loadPeople();
    await loadMessages(false);
  }

  function open(personId) {
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'chatOverlay';
      overlay.style.cssText = 'position:fixed; inset:0; z-index:50;';
      document.body.appendChild(overlay);
    }
    overlay.style.display = 'block';
    st.open = true;
    paintShell();
    layout();
    loadPeople().then(() => { if (personId) select(personId); });
  }

  function close() {
    st.open = false;
    if (overlay) overlay.style.display = 'none';
    refreshBadge();
  }

  async function mount() {
    if (fab) return;
    let me;
    try { me = await Api.get('/api/auth/me'); } catch { return; }
    if (!me || !(me.permissions || []).some((p) => p === '*' || p === 'chat.view')) return;
    st.me = me;
    fab = document.createElement('button');
    fab.id = 'chatFab';
    fab.type = 'button';
    fab.title = 'Чаты с монтёрами';
    fab.style.cssText = 'position:fixed; left:4.25rem; bottom:1rem; z-index:41; width:2.5rem; height:2.5rem; border-radius:9999px; display:grid; '
      + 'place-items:center; font-size:1.1rem; cursor:pointer; border:1px solid rgba(100,116,139,.5); background:rgba(15,23,42,.88); color:#e2e8f0; '
      + 'box-shadow:0 6px 20px rgba(0,0,0,.35);';
    fab.textContent = '💬';
    badge = document.createElement('span');
    badge.style.cssText = 'position:absolute; top:-.35rem; right:-.35rem; min-width:1.15rem; height:1.15rem; padding:0 .25rem; border-radius:9999px; '
      + 'background:#f43f5e; color:#fff; font-size:.65rem; font-weight:700; display:none; place-items:center;';
    fab.appendChild(badge);
    fab.onclick = () => (st.open ? close() : open());
    document.body.appendChild(fab);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && st.open && !document.querySelector('#modal > div')) close(); });
    window.addEventListener('resize', () => st.open && layout());
    await refreshBadge();
    timer = setInterval(() => tick().catch(() => {}), POLL_MS);
  }

  document.addEventListener('DOMContentLoaded', () => { mount(); });
  if (document.readyState !== 'loading') mount();
  return { open, close, shrink };
})();
