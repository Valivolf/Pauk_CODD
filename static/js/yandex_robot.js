// Робот Яндекс.Конструктора карт: окно «Яндекс-аккаунт для карт» (вход в Яндекс, настройки
// автоматики), создание и обновление карты бригады. Серверная часть — app/api/routes_yandex_robot.py
// и app/services/yandex_map_sync.py (само ведёт карты), сам робот — папка robot/ (отдельный контейнер).
// modal()/close()/btn*/fieldCls — из ui.js и app.js, CURRENT_USER — из app.js.
const ROBOT_API = '/api/yandex-robot';
const YANDEX_MAP_LINK_RE = /^https:\/\/yandex\.[a-z]+\/maps\//;
const robotSleep = (ms) => new Promise((r) => setTimeout(r, ms));

function hasYandexMapLink(crew) { return YANDEX_MAP_LINK_RE.test((crew?.map_link || '').trim()); }

// opts.profile: 'maps' — вход для карт (он же по умолчанию для Форм), 'forms' — отдельный вход для Форм; opts.check = 'forms' — проверить доступ к Яндекс Формам.
async function robotStatus(verify = false, opts = {}) {
  const q = [];
  if (verify) q.push('verify=1');
  if (opts.profile && opts.profile !== 'maps') q.push(`profile=${opts.profile}`);
  if (opts.check) q.push(`check=${opts.check}`);
  // проверка входа (verify) ждёт, пока робот дождётся загрузки страницы Яндекса, — это бывает долго, поэтому предел ожидания большой
  return Api.get(`${ROBOT_API}/status${q.length ? '?' + q.join('&') : ''}`, verify ? { timeoutMs: 240000 } : undefined);
}

// ---------------------------------------------------------------- аккаунт робота

function robotAccountBoxHtml(st) {
  if (!st.available) {
    return `<div class="text-amber-300">⚠️ ${esc(st.message || 'Робот карт недоступен')}</div>`;
  }
  if (st.logged_in) {
    return `<div class="text-emerald-300">✅ Вход выполнен${st.login ? `: <b>${esc(st.login)}</b>` : ''}</div>
      <div class="text-xs text-slate-400 mt-1">Карты бригад ведутся под этим аккаунтом Яндекса.${st.busy ? ' Сейчас робот занят — работает с картой.' : ''}</div>`;
  }
  return `<div class="text-amber-300">Вход в Яндекс не выполнен</div>
    <div class="text-xs text-slate-400 mt-1">${esc(st.message || 'Нажмите «Войти в Яндекс» — откроется окно с браузером робота.')}</div>`;
}

async function openYandexAccount() {
  closeDropdowns();
  modal(`<h2 class="font-display text-lg font-bold mb-2">Яндекс-аккаунт для карт</h2>
    <p class="text-sm text-slate-400 mb-4">Робот ведёт карты бригад в Конструкторе карт Яндекса под этим аккаунтом. Вход делается один раз прямо здесь: откроется окно с браузером робота, в нём вы вводите логин и пароль как на сайте Яндекса. Пароль нигде не сохраняется — в профиле робота остаётся только сессия.</p>
    <div id="yaAccBox" class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-4 text-sm">Проверяю робота…</div>
    <div class="flex flex-wrap items-center gap-2 mb-4">
      <button type="button" id="yaLoginBtn" class="${btnPrimary}">Войти в Яндекс</button>
      <button type="button" id="yaVerifyBtn" class="${btnGhost}">Проверить вход</button>
      <button type="button" id="yaNetBtn" class="${btnGhost}" title="Какие адреса Яндекса открываются с сервера — если сервер за фильтром по доменам">Проверить связь с Яндексом</button>
      <button type="button" id="yaLogoutBtn" class="${btnGhost}">Выйти из аккаунта</button>
    </div>
    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-4 text-sm space-y-2.5">
      <b class="block">Карты бригад</b>
      <label class="flex items-start gap-2"><input type="checkbox" id="yaAutoSync" class="mt-1 rounded accent-indigo-500">
        <span>Создавать и обновлять карты автоматически, когда меняются точки бригады (добавили, убрали; точка с отчётом о выезде становится зелёной)</span></label>
      <label class="flex items-center gap-2 pl-6 text-xs text-slate-400">вести карты на
        <input type="number" id="yaAhead" min="0" max="14" style="width:64px" class="${fieldCls} !py-1"> дн. вперёд (0 — только на сегодня)</label>
      <label class="flex items-start gap-2"><input type="checkbox" id="yaAutoDel" class="mt-1 rounded accent-indigo-500">
        <span>Удалять карты через <input type="number" id="yaDelDays" min="1" max="365" style="width:64px" class="${fieldCls} !py-1 inline-block"> дн. после даты выезда</span></label>
      <p class="pl-6 text-[11px] text-slate-500 -mt-1">Карты только правятся — точки добавляются, убираются и перекрашиваются, а ссылка остаётся прежней. Удаляются карты лишь по этому сроку (если галочка стоит); без неё не удаляются никогда.</p>
      <div id="yaSetStatus" class="text-[11px] text-slate-500">Загружаю настройки…</div>
      <div class="flex items-center gap-2">
        <button type="button" id="yaSaveSettings" class="${btnPrimary} !py-1.5 !px-3 text-xs">Сохранить настройки</button>
        <span id="yaSaved" class="text-xs text-emerald-300"></span>
      </div>
    </div>
    <button type="button" class="cancel ${btnGhost}">Закрыть</button>`);
  const box = () => $('#yaAccBox');
  const apply = (st) => {
    if (!box()) return;
    box().innerHTML = robotAccountBoxHtml(st);
    ['#yaLoginBtn', '#yaVerifyBtn', '#yaNetBtn', '#yaLogoutBtn'].forEach((sel) => { if ($(sel)) $(sel).disabled = !st.available; });
  };
  const refresh = async (verify) => {
    if (box()) box().innerHTML = verify ? 'Проверяю вход — робот открывает Конструктор карт и дожидается загрузки страницы…' : 'Проверяю робота…';
    try { apply(await robotStatus(verify)); }
    catch (e) { apply({ available: false, message: e.message }); }
  };
  const loadSettings = async () => {
    try {
      const s = await Api.get(`${ROBOT_API}/settings`);
      if (!$('#yaAutoSync')) return;
      $('#yaAutoSync').checked = s.auto_sync;
      $('#yaAhead').value = s.sync_days_ahead;
      $('#yaAutoDel').checked = s.auto_delete;
      $('#yaDelDays').value = s.auto_delete_days;
      const when = s.last_tick ? new Date(s.last_tick * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : 'ещё не было';
      $('#yaSetStatus').innerHTML = `Карт под присмотром: <b>${s.maps_total}</b>${s.trash_total ? ` · в очереди на удаление: ${s.trash_total}` : ''} · последняя проверка: ${when}`
        + (s.last_message ? `<br>${esc(s.last_message)}` : '') + (s.last_error ? `<br><span class="text-amber-300">${esc(s.last_error)}</span>` : '');
    } catch (e) { if ($('#yaSetStatus')) $('#yaSetStatus').textContent = 'Не удалось загрузить настройки: ' + e.message; }
  };
  $('#yaSaveSettings').onclick = async () => {
    const ahead = +$('#yaAhead').value, days = +$('#yaDelDays').value;
    if (!(ahead >= 0 && ahead <= 14) || !(days >= 1 && days <= 365)) { alert('«Дней вперёд» — от 0 до 14, «удалять через» — от 1 до 365 дней.'); return; }
    try {
      await Api.put(`${ROBOT_API}/settings`, { auto_sync: $('#yaAutoSync').checked, sync_days_ahead: ahead, auto_delete: $('#yaAutoDel').checked, auto_delete_days: days });
      $('#yaSaved').textContent = '✓ сохранено';
      setTimeout(() => { if ($('#yaSaved')) $('#yaSaved').textContent = ''; }, 2500);
      loadSettings();
    } catch (e) { alert(e.message); }
  };
  $('#yaVerifyBtn').onclick = () => refresh(true);
  $('#yaNetBtn').onclick = async () => {
    box().innerHTML = 'Проверяю адреса Яндекса с сервера (до 10 секунд)…';
    try {
      const r = await Api.get(`${ROBOT_API}/netcheck`);
      const rows = r.items.map((i) => `<tr>
        <td class="pr-3 py-0.5 whitespace-nowrap">${i.ok ? '✅' : (i.required ? '❌' : '⚠️')}</td>
        <td class="pr-3 py-0.5 font-mono text-xs">${esc(i.host)}</td>
        <td class="py-0.5 text-xs ${i.ok ? 'text-slate-400' : 'text-amber-300'}">${i.ok ? esc(i.purpose) + ' · ' + i.ms + ' мс' : esc(i.error)}${i.ok ? '' : ' — ' + esc(i.purpose)}</td></tr>`).join('');
      const head = r.required_ok
        ? '<div class="text-emerald-300 mb-2">✅ Все нужные адреса открываются.</div>'
        : '<div class="text-rose-300 mb-2">❌ Часть нужных адресов с сервера не открывается — робот работать не будет. Эти адреса надо открыть в фильтре сети (отмечены ❌).</div>';
      box().innerHTML = head + `<table>${rows}</table><div class="text-[11px] text-slate-500 mt-2">❌ — обязателен; ⚠️ — желателен (карта, плитки), без него страницы могут грузиться хуже.</div>`;
    } catch (e) { box().innerHTML = `<span class="text-amber-300">${esc(e.message)}</span>`; }
  };
  $('#yaLoginBtn').onclick = () => openRobotBrowser(() => refresh(true));
  $('#yaLogoutBtn').onclick = async () => {
    if (!confirm('Выйти из аккаунта Яндекса в браузере робота? Вести карты он сможет только после нового входа.')) return;
    try { await Api.post(`${ROBOT_API}/logout`, {}); } catch (e) { alert(e.message); }
    refresh(false);
  };
  loadSettings();
  await refresh(false);
}

// ----------------------------------------------- окно с браузером робота (только для входа)

// Экран робота приходит потоком: браузер сам присылает кадр, как только страница меняется, а запрос
// «дай кадр новее N» ждёт его на сервере (долгий опрос). Поток работает, только пока окно открыто.
// opts: { profile: 'maps'|'forms', forms: true — окно для Яндекс Форм (кнопки «Яндекс Формы» и «Запомнить эту страницу…»), startUrl }.
// Окно занимает почти весь экран, а браузер робота подгоняется под его размер (POST /view/resize при открытии и при изменении окна), поэтому страницы
// Яндекса помещаются целиком. Кнопка «🔊 Звук» включает звук страницы робота (голосовая проверка «Вы не робот»): куски WebM/Opus приходят долгим
// опросом и играются через MediaSource.
function openRobotBrowser(onClose, opts = {}) {
  const prof = opts.profile || 'maps';
  const forForms = !!opts.forms;
  const pq = prof === 'maps' ? '' : `profile=${prof}`;
  const withQ = (url) => (pq ? url + (url.includes('?') ? '&' : '?') + pq : url);
  document.getElementById('robotBrowser')?.remove();
  const ov = document.createElement('div');
  ov.id = 'robotBrowser';
  ov.style.cssText = 'position:fixed;inset:0;z-index:40;padding:8px;background:rgba(2,6,23,.86)';
  ov.innerHTML = `<div class="glass rounded-2xl p-3 shadow-2xl" style="width:100%;height:100%;display:flex;flex-direction:column;gap:8px">
    <div class="flex items-center justify-between gap-2">
      <b class="font-display">${forForms ? 'Браузер робота — вход в Яндекс и Формы' : 'Браузер робота — вход в Яндекс'}</b>
      <span id="rbState" class="text-xs text-slate-400"></span>
    </div>
    <p class="text-xs text-slate-400">Кликайте по картинке и печатайте с клавиатуры, как на обычном сайте. Если Яндекс покажет проверку «Вы не робот» — пройдите её здесь же (звук — кнопкой «🔊 Звук»). Пароль уходит только в браузер робота, на страницу Яндекса.</p>
    <div id="rbStage" style="flex:1;min-height:0;position:relative;border-radius:12px;overflow:hidden;background:#0b1220;line-height:0">
      <img id="rbImg" alt="Браузер робота" draggable="false" style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;cursor:pointer">
      <input id="rbKbd" autocomplete="off" autocapitalize="off" autocorrect="off" spellcheck="false" aria-label="Ввод в браузер робота" style="position:absolute;left:0;top:0;width:1px;height:1px;opacity:0">
    </div>
    <div class="flex flex-wrap items-center gap-2">
      <button type="button" id="rbLogin" class="${btnGhost} !py-1 !px-3 text-xs">Страница входа Яндекса</button>
      ${forForms
        ? `<button type="button" id="rbForms" class="${btnGhost} !py-1 !px-3 text-xs" title="Открыть список ваших форм: если вход в Формы не выполнен, Яндекс предложит войти">Яндекс Формы</button>
           <button type="button" id="rbRemember" class="${btnGhost} !py-1 !px-3 text-xs" title="Откройте свою форму → вкладку «Ответы» и нажмите — робот будет выгружать ответы с этой страницы">📌 Запомнить эту страницу как «Ответы» формы</button>`
        : `<button type="button" id="rbConstructor" class="${btnGhost} !py-1 !px-3 text-xs" title="Открыть Конструктор карт в браузере робота — проверить вход или пройти проверку «Вы не робот»">Конструктор карт</button>`}
      <button type="button" id="rbSound" class="${btnGhost} !py-1 !px-3 text-xs" title="Слышать звук страницы робота (например, голосовую проверку «Вы не робот»)">🔊 Звук: выкл</button>
      <button type="button" id="rbDone" class="${btnPrimary} ml-auto">Готово</button>
    </div>
  </div>`;
  document.body.appendChild(ov);
  const img = ov.querySelector('#rbImg');
  const kbd = ov.querySelector('#rbKbd');
  const stage = ov.querySelector('#rbStage');
  const stateEl = ov.querySelector('#rbState');
  let alive = true;
  let wasLoggedIn = false;
  let viewW = 1280, viewH = 760;   // размер экрана робота (приходит в заголовках кадра)

  const streamLoop = async () => {
    let seq = -1;
    while (alive) {
      if (document.hidden) { await robotSleep(500); continue; }
      try {
        const res = await fetch(withQ(`${ROBOT_API}/view?after=${seq}&wait=3`), { credentials: 'same-origin', cache: 'no-store' });
        if (!alive) return;
        if (res.status === 401) { window.location.href = '/login'; return; }
        if (res.status === 204) { seq = +res.headers.get('X-Frame-Seq') || seq; continue; }   // сервер уже подождал — просто снова
        if (!res.ok) {
          let detail = 'Нет картинки от робота';
          try { detail = (await res.json()).detail || detail; } catch { /* не JSON */ }
          stateEl.textContent = detail;
          await robotSleep(1500);
          continue;
        }
        viewW = +res.headers.get('X-View-Width') || viewW;
        viewH = +res.headers.get('X-View-Height') || viewH;
        seq = +res.headers.get('X-Frame-Seq') || seq;
        const url = URL.createObjectURL(await res.blob());
        const old = img.dataset.url;
        img.src = url;
        img.dataset.url = url;
        if (old) URL.revokeObjectURL(old);
      } catch (e) {
        if (!alive) return;
        stateEl.textContent = 'Нет связи: ' + e.message;
        await robotSleep(1500);
      }
    }
  };

  // Команды (клик, текст, клавиши, размер экрана) уходят строго по очереди — иначе буквы пароля перемешаются.
  let chain = Promise.resolve();
  const send = (path, body) => {
    chain = chain
      .then(() => Api.post(withQ(`${ROBOT_API}/view/${path}`), body))
      .catch((e) => { stateEl.textContent = e.message; });
    return chain;
  };

  // Экран робота — по размеру окна: тот же размер в пикселях страницы, поэтому клики и текст ложатся один к одному.
  let sizeSent = '';
  const syncSize = () => {
    const w = Math.floor(stage.clientWidth), h = Math.floor(stage.clientHeight);
    if (!w || !h) return;
    const size = { width: Math.max(320, Math.min(2560, w)), height: Math.max(240, Math.min(1600, h)) };
    const key = `${size.width}x${size.height}`;
    if (key === sizeSent) return;
    sizeSent = key;
    send('resize', size);
  };
  let resizeTimer = 0;
  const resizeObserver = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(syncSize, 350); });
  resizeObserver.observe(stage);
  syncSize();

  // Где на самом деле нарисован экран робота внутри картинки (поля, если пропорции чуть разошлись).
  const screenRect = () => {
    const r = img.getBoundingClientRect();
    const k = Math.min(r.width / viewW, r.height / viewH);
    const w = viewW * k, h = viewH * k;
    return { left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
  };
  img.addEventListener('click', (e) => {
    if (!img.naturalWidth) return;
    const s = screenRect();
    const x = ((e.clientX - s.left) / s.w) * viewW, y = ((e.clientY - s.top) / s.h) * viewH;
    if (x < 0 || y < 0 || x > viewW || y > viewH) return;
    send('click', { x, y });
    kbd.focus();
  });
  img.addEventListener('wheel', (e) => { e.preventDefault(); send('scroll', { dy: e.deltaY }); }, { passive: false });
  const flushText = () => { const t = kbd.value; kbd.value = ''; if (t) send('type', { text: t }); };
  kbd.addEventListener('input', (e) => { if (!e.isComposing) flushText(); });
  kbd.addEventListener('compositionend', flushText);
  kbd.addEventListener('paste', (e) => {
    const t = e.clipboardData?.getData('text');
    if (t) { e.preventDefault(); send('type', { text: t }); }
  });
  const KEYS = new Set(['Enter', 'Backspace', 'Tab', 'Escape', 'Delete', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown']);
  kbd.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    if (e.ctrlKey && !e.shiftKey && !e.altKey && (e.key === 'a' || e.key === 'ф' || e.code === 'KeyA')) {
      e.preventDefault(); send('key', { key: 'Control+a' }); return;
    }
    if (KEYS.has(e.key)) { e.preventDefault(); e.stopPropagation(); send('key', { key: e.key }); }
  });

  // ---- звук страницы робота
  const soundBtn = ov.querySelector('#rbSound');
  const MIME = 'audio/webm; codecs="opus"';
  const sound = { on: false, seq: -1, stream: '', el: null, ms: null, sb: null, queue: [], gen: 0, loop: 0 };
  const dropPlayer = () => {
    sound.gen++;
    if (sound.el) {
      try { sound.el.pause(); } catch { /* уже остановлен */ }
      if (sound.el.src) URL.revokeObjectURL(sound.el.src);
      sound.el.remove();
    }
    sound.el = sound.ms = sound.sb = null;
    sound.queue = [];
  };
  const pump = () => {
    const sb = sound.sb, el = sound.el;
    if (!sb || !el || sb.updating || sound.ms.readyState !== 'open') return;
    if (sound.queue.length) {
      try { sb.appendBuffer(sound.queue.shift()); }
      catch (e) { if (e.name === 'QuotaExceededError' && sb.buffered.length) { try { sb.remove(sb.buffered.start(0), Math.max(sb.buffered.start(0), el.currentTime - 2)); } catch { /* ничего */ } } }
      return;
    }
    if (!sb.buffered.length) return;
    const end = sb.buffered.end(sb.buffered.length - 1);
    if (end - el.currentTime > 1.2) el.currentTime = end - 0.25;                      // отстали — к живому краю
    if (el.currentTime - sb.buffered.start(0) > 20) { try { sb.remove(sb.buffered.start(0), el.currentTime - 10); } catch { /* ничего */ } }
  };
  const newPlayer = () => {
    dropPlayer();
    const gen = sound.gen;
    const el = document.createElement('audio');
    el.autoplay = true;
    el.style.display = 'none';
    const ms = new MediaSource();
    el.src = URL.createObjectURL(ms);
    ov.appendChild(el);
    sound.el = el;
    sound.ms = ms;
    ms.addEventListener('sourceopen', () => {
      if (gen !== sound.gen || sound.sb) return;
      sound.sb = ms.addSourceBuffer(MIME);
      sound.sb.addEventListener('updateend', pump);
      pump();
    });
    el.play().catch(() => { /* нажатие на кнопку уже было — браузер разрешит */ });
  };
  const soundLoop = async () => {
    const mine = ++sound.loop;
    while (alive && sound.on && mine === sound.loop) {
      try {
        const res = await fetch(withQ(`${ROBOT_API}/audio?after=${sound.seq}&wait=3`), { credentials: 'same-origin', cache: 'no-store' });
        if (!alive || !sound.on || mine !== sound.loop) return;
        if (!res.ok) { await robotSleep(1500); continue; }
        const stream = res.headers.get('X-Audio-Stream') || '';
        const seq = parseInt(res.headers.get('X-Audio-Seq') || '', 10);
        if (res.status === 200) {
          if (stream !== sound.stream || !sound.el) { sound.stream = stream; newPlayer(); }       // новая запись — заново с заголовка потока
          sound.queue.push(new Uint8Array(await res.arrayBuffer()));
          pump();
        }
        if (!Number.isNaN(seq)) sound.seq = seq;
      } catch {
        if (!alive) return;
        await robotSleep(1000);
      }
    }
  };
  const setSound = async (on) => {
    sound.on = on;
    soundBtn.textContent = on ? '🔊 Звук: вкл' : '🔊 Звук: выкл';
    soundBtn.classList.toggle('!border-emerald-400', on);
    if (!on) { sound.loop++; dropPlayer(); sound.stream = ''; return; }
    sound.seq = -1;
    sound.stream = '';
    try { await Api.post(withQ(`${ROBOT_API}/audio/start`), {}); }
    catch (e) { stateEl.textContent = e.message; }
    soundLoop();
  };
  soundBtn.onclick = () => {
    if (!sound.on && !(window.MediaSource && MediaSource.isTypeSupported(MIME))) { stateEl.textContent = 'Этот браузер не умеет воспроизводить звук потоком — откройте календарь в Chrome или Edge'; return; }
    setSound(!sound.on);
  };

  const finish = () => {
    alive = false;
    sound.on = false;
    sound.loop++;
    dropPlayer();
    resizeObserver.disconnect();
    clearTimeout(resizeTimer);
    clearInterval(statusTimer);
    if (img.dataset.url) URL.revokeObjectURL(img.dataset.url);
    ov.remove();
    if (onClose) onClose();
  };
  ov.querySelector('#rbDone').onclick = finish;
  ov.querySelector('#rbLogin').onclick = () => send('open', { url: '' });
  if (!forForms) ov.querySelector('#rbConstructor').onclick = () => send('open', { url: 'https://yandex.ru/map-constructor/' });
  if (forForms) {
    ov.querySelector('#rbForms').onclick = () => send('open', { url: 'https://forms.yandex.ru/cloud/admin/' });
    ov.querySelector('#rbRemember').onclick = async () => {
      try {
        const r = await Api.post('/api/forms-auto/page-from-robot', {});
        stateEl.innerHTML = `<span class="text-emerald-300">📌 запомнено: ${esc(r.url.slice(0, 80))}</span>`;
        wasLoggedIn = true;
      } catch (e) { stateEl.innerHTML = `<span class="text-amber-300">${esc(e.message)}</span>`; }
    };
    send('open', { url: opts.startUrl || 'https://forms.yandex.ru/cloud/admin/' });          // сразу в Формы организации (или на нужную ссылку): покажут список форм, предложат войти или проверку «Вы не робот»
  }

  const checkLogin = async () => {
    try {
      const st = await robotStatus(false, { profile: prof });
      if (!alive) return;
      if (st.logged_in) {
        stateEl.innerHTML = `<span class="text-emerald-300">✅ вход выполнен${st.login ? ': ' + esc(st.login) : ''} — можно нажать «Готово»</span>`;
        wasLoggedIn = true;
      } else if (!wasLoggedIn && st.available) {
        stateEl.textContent = 'вход ещё не выполнен';
      }
    } catch { /* следующий опрос */ }
  };
  const statusTimer = setInterval(checkLogin, 3000);
  streamLoop();
  checkLogin();
}

// ------------------------------------------------------------ карта бригады роботом

// Создаёт или обновляет карту бригады; возвращает { url, points, skipped, message, uptodate }; onStep(текст) — ход работы.
// Ошибка несёт code (not_logged_in | captcha | …), jobId и hasShot (есть снимок страницы).
async function runCrewMap(crew, onStep) {
  const st = await robotStatus();
  if (!st.available) throw Object.assign(new Error(st.message || 'Робот карт недоступен'), { code: 'unavailable' });
  if (!st.logged_in) {
    const who = can('admin.settings') ? 'Настройки → «Яндекс-аккаунт для карт» → «Войти в Яндекс»' : 'попросите администратора войти (Настройки → «Яндекс-аккаунт для карт»)';
    throw Object.assign(new Error(`Робот не вошёл в Яндекс — ${who}.`), { code: 'not_logged_in' });
  }
  const started = await Api.post(`${ROBOT_API}/crews/${crew.id}/map`, {});
  if (started.uptodate) {   // ничего не менялось — карта уже такая, как нужно
    return { url: started.url, points: started.points, skipped: started.skipped, message: 'Карта уже актуальна', uptodate: true };
  }
  if (onStep) onStep(started.summary || 'В очереди…');
  const t0 = Date.now();
  let failures = 0;
  while (true) {
    await robotSleep(1500);
    let job;
    try { job = await Api.get(`${ROBOT_API}/jobs/${started.job_id}`); failures = 0; }
    catch (e) {
      if (++failures >= 4) throw e;
      continue;
    }
    if (job.state === 'done') {
      if (job.url) crew.map_link = job.url;
      return { url: job.url, points: started.points, skipped: started.skipped, message: job.message, uptodate: false };
    }
    if (job.state === 'error') {
      throw Object.assign(new Error(job.message || 'Робот не смог обновить карту'), { code: job.error_code, jobId: job.id, hasShot: !!job.has_shot });
    }
    if (onStep) onStep(job.message || '…');
    if (Date.now() - t0 > 900000) throw new Error('Робот не ответил за 15 минут — посмотрите «Яндекс-аккаунт для карт».');
  }
}

function robotErrorHtml(err) {
  const shot = err.hasShot && err.jobId && can('admin.settings')
    ? ` <a class="text-indigo-300 hover:underline" target="_blank" rel="noopener" href="${ROBOT_API}/jobs/${esc(err.jobId)}/shot">снимок страницы робота ↗</a>` : '';
  return `<span class="text-rose-300">${esc(err.message)}</span>${shot}`;
}

// Окно с ходом создания / обновления карт для одной или нескольких бригад (по очереди).
async function robotMapsModal(crews) {
  if (!crews.length) { alert('Нет бригад с заданиями — карты вести не для чего.'); return; }
  modal(`<h2 class="font-display text-lg font-bold mb-2">Карты бригад в Яндексе</h2>
    <p class="text-sm text-slate-400 mb-3">Нет карты — создаётся, есть — обновляется (если изменений немного, точки правятся прямо на карте и ссылка остаётся прежней). Окно можно закрыть — ссылка в бригаде обновится сама. Вообще карты обновляются и без кнопки: в «Настройки → Яндекс-аккаунт для карт» это включается.</p>
    <div id="rmList" class="space-y-2 mb-4">${crews.map((c) => `<div class="rounded-xl border border-slate-700/60 bg-slate-800/30 px-3 py-2 text-sm">
      <b>${esc(c.name)}</b> <span id="rm-${c.id}" class="text-slate-400 block text-xs mt-0.5">ждёт очереди</span></div>`).join('')}</div>
    <button type="button" class="cancel ${btnGhost}">Закрыть</button>`);
  const setRow = (id, html) => { const el = document.getElementById('rm-' + id); if (el) el.innerHTML = html; };
  let stop = false;
  for (const c of crews) {
    if (stop) { setRow(c.id, '<span class="text-slate-500">пропущена</span>'); continue; }
    setRow(c.id, 'Запускаю…');
    try {
      const r = await runCrewMap(c, (text) => setRow(c.id, esc(text)));
      setRow(c.id, `<span class="text-emerald-300">✅ ${esc(r.message)} (точек: ${r.points}${r.skipped ? `, без координат пропущено: ${r.skipped}` : ''})</span>${r.url ? ` · <a class="text-indigo-300 hover:underline" target="_blank" rel="noopener" href="${esc(r.url)}">открыть карту ↗</a>` : ''}`);
    } catch (err) {
      setRow(c.id, robotErrorHtml(err));
      if (['not_logged_in', 'captcha', 'unavailable'].includes(err.code)) stop = true; // дальше будет то же самое
    }
  }
}

// То же прямо в окне «Изменить» бригады: результат — в поле ссылки.
async function createCrewMapInline(crew, ui) {
  const { input, note, btn, open } = ui;
  const current = input.value.trim();
  if (current && !hasYandexMapLink({ map_link: current }) && !confirm('В поле ссылки сейчас заметка. Заменить её ссылкой на карту?')) return;
  btn.disabled = true;
  note.className = 'text-[11px] text-slate-400';
  note.textContent = 'Проверяю робота…';
  try {
    const r = await runCrewMap(crew, (text) => { note.textContent = text; });
    if (r.url) {
      input.value = r.url;
      open.href = r.url;
      open.classList.remove('hidden');
    }
    note.className = 'text-[11px] text-emerald-300';
    note.textContent = `${r.message} (точек: ${r.points}${r.skipped ? `, без координат пропущено: ${r.skipped}` : ''}), ссылка сохранена в бригаде.`;
  } catch (err) {
    note.className = 'text-[11px]';
    note.innerHTML = robotErrorHtml(err);
  } finally { btn.disabled = false; }
}
