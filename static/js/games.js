// Страница «Игры»: список игр по разделам, мои рекорды, таблица рекордов сотрудников и окно самой игры. Сами игры — static/js/games_impl.js и games_more.js (GAMES_IMPL[ключ](k)),
// каталог, доступ и рекорды — на сервере (app/services/games.py). Игра получает «набор» k: всё, что она заняла (таймеры, слушатели), снимается при k.over() и при выходе из игры.
let CURRENT_USER = null;
const GM = { me: null, tab: 'games', cat: 'all', board: null, boardGame: null, run: null, difficulty: 'normal', expandedBoard: '' };

function close() { editing = false; const m = $('#modal'); if (m) m.innerHTML = ''; }

function gmNum(v, meta) {
  const n = Number(v);
  if (meta && meta.better === 'low' && meta.unit === 'с') return `${Math.round(n * 10) / 10} с`;
  const text = Number.isInteger(n) ? n.toLocaleString('ru-RU') : String(Math.round(n * 100) / 100);
  return `${text} ${meta ? meta.unit : ''}`.trim();
}

const gmCatTitle = (key) => ((GM.me.categories || []).find((c) => c.key === key) || {}).title || '';

// Конфетти на панели результата при новом рекорде
function gmConfetti(host) {
  const box = document.createElement('div');
  box.className = 'lc-g-conf';
  box.innerHTML = Array.from({ length: 28 }, (_, i) => `<i style="left:${Math.round(Math.random() * 96)}%; animation-delay:${(Math.random() * 0.7).toFixed(2)}s; font-size:${14 + Math.round(Math.random() * 14)}px">${['🎉', '⭐', '✨', '🏆', '🎊'][i % 5]}</i>`).join('');
  host.appendChild(box);
  setTimeout(() => box.remove(), 3200);
}

// ---------------------------------------------------------------- набор для игры
function gmMakeKit(stage, statusEl, onOver) {
  const cleanups = [];
  let done = false;
  const stop = () => { done = true; while (cleanups.length) { try { cleanups.pop()(); } catch { /* уже снято */ } } };
  const kit = {
    box: stage,
    canvas(w, h) {
      const cv = document.createElement('canvas');
      cv.width = w; cv.height = h;
      cv.style.cssText = 'display:block; margin:0 auto; max-width:100%; height:auto; border-radius:16px; touch-action:none; background:#0f172a; box-shadow:0 10px 24px -12px rgba(0,0,0,.8)';
      stage.appendChild(cv);
      return { cv, g: cv.getContext('2d') };
    },
    on(target, ev, fn, opts) { target.addEventListener(ev, fn, opts); cleanups.push(() => target.removeEventListener(ev, fn, opts)); },
    every(fn, ms) { const id = setInterval(() => { if (!done) fn(); }, ms); cleanups.push(() => clearInterval(id)); return id; },
    after(fn, ms) { const id = setTimeout(() => { if (!done) fn(); }, ms); cleanups.push(() => clearTimeout(id)); return id; },
    raf(fn) {
      let id = 0;
      const loop = (t) => { if (done) return; fn(t); if (!done) id = requestAnimationFrame(loop); };
      id = requestAnimationFrame(loop);
      cleanups.push(() => cancelAnimationFrame(id));
    },
    swipe(el, cb) {
      let x0 = 0, y0 = 0;
      el.style.touchAction = 'none';
      kit.on(el, 'touchstart', (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
      kit.on(el, 'touchend', (e) => {
        const t = e.changedTouches[0], dx = t.clientX - x0, dy = t.clientY - y0;
        if (Math.max(Math.abs(dx), Math.abs(dy)) < 24) return;
        cb(Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up'));
      }, { passive: true });
    },
    status(text) { if (statusEl) statusEl.textContent = text; },
    over(score, note) { if (done) return; stop(); onOver(score, note); },
    destroy() { stop(); stage.innerHTML = ''; },
  };
  return kit;
}

// ---------------------------------------------------------------- список игр и рекорды
function gmRenderShell() {
  $('#content').innerHTML = `<div id="gmBody"></div>`;
  gmRenderList();
}

function gmRenderList() {
  const games = GM.me.games;
  if (!games.length) { $('#gmBody').innerHTML = '<p class="text-sm text-slate-400">Вам не включено ни одной игры. Их включает администратор.</p>'; return; }
  const cats = [{ key: 'all', title: 'Все' }, ...(GM.me.categories || []).filter((c) => games.some((g) => g.cat === c.key))];
  if (!cats.some((c) => c.key === GM.cat)) GM.cat = 'all';
  const shown = GM.cat === 'all' ? games : games.filter((g) => g.cat === GM.cat);
  const records = games.filter((g) => GM.me.bests[g.key]).length;
  const plays = games.reduce((s, g) => s + ((GM.me.bests[g.key] || {}).plays || 0), 0);
  $('#gmBody').innerHTML = `<div class="lc-g-hero"><div><b>🎮 Игровая зона</b><br><span>Игр: ${games.length} · ваших рекордов: ${records} · партий сыграно: ${plays}</span></div><span>Соревнуйтесь с коллегами в таблице рекордов 🏆</span></div>
    <div class="lc-g-chips">${cats.map((c) => `<button type="button" data-gmcat="${esc(c.key)}" class="lc-g-chip ${GM.cat === c.key ? 'lc-on' : ''}">${esc(c.title)}</button>`).join('')}</div>
    <div class="lc-g-grid">${shown.map((g) => {
    const b = GM.me.bests[g.key];
    return `<div class="lc-g-card" style="--gh:${g.hue}" data-game-card="${esc(g.key)}">
      <div class="lc-g-ico">${g.icon}</div>
      <div><span class="lc-g-cat">${esc(gmCatTitle(g.cat))}</span><h3>${esc(g.title)}</h3></div>
      <p>${esc(g.hint)}</p>
      <span class="lc-g-best">${b ? `🏅 ${esc(gmNum(b.best, g))} · партий: ${b.plays}` : 'Пока нет результатов'}</span>
      <div class="lc-g-row"><button type="button" data-play="${esc(g.key)}" class="lc-g-play">▶ Играть</button>
        <button type="button" data-top="${esc(g.key)}" class="lc-g-mini" title="Рекорды этой игры">🏆 Рекорды</button></div>
      <div data-game-board="${esc(g.key)}" class="${GM.expandedBoard === g.key ? '' : 'hidden'} mt-3 border-t border-slate-700/50 pt-3"><p class="text-xs text-slate-500">Загружаю рекорды…</p></div>
    </div>`;
  }).join('')}</div>`;
  document.querySelectorAll('[data-gmcat]').forEach((b) => { b.onclick = () => { GM.cat = b.dataset.gmcat; gmRenderList(); }; });
  document.querySelectorAll('[data-play]').forEach((b) => { b.onclick = () => gmOpenGame(b.dataset.play); });
  document.querySelectorAll('[data-top]').forEach((b) => { b.onclick = () => { const key = b.dataset.top; GM.expandedBoard = GM.expandedBoard === key ? '' : key; gmRenderList(); if (GM.expandedBoard) gmLoadInlineBoard(key); }; });
}

async function gmLoadInlineBoard(key) {
  const box = [...document.querySelectorAll('[data-game-board]')].find((el) => el.dataset.gameBoard === key);
  if (!box) return;
  try {
    const data = await Api.get('/api/games/leaderboard?game=' + encodeURIComponent(key));
    if (!box.isConnected) return;
    box.innerHTML = `<div class="text-xs text-slate-400 mb-2">Лучшие результаты коллег${data.me ? ` · ваше место: ${data.me.rank}` : ''}</div>
      ${data.top.length ? `<ol class="space-y-1 text-xs">${data.top.map((r) => `<li class="flex justify-between gap-2 ${r.me ? 'text-emerald-300 font-semibold' : 'text-slate-300'}"><span>${r.rank}. ${esc(r.username)}${r.me ? ' (вы)' : ''}</span><span>${esc(gmNum(r.best, GM.me.games.find((g) => g.key === key)))} · ${r.plays} партий</span></li>`).join('')}</ol>` : '<span class="text-xs text-slate-500">Рекордов пока нет.</span>'}`;
  } catch (e) { if (box.isConnected) box.innerHTML = `<span class="text-xs text-rose-300">${esc(e.message)}</span>`; }
}

async function gmRenderBoard() {
  const games = GM.me.games;
  if (!games.length) { $('#gmBody').innerHTML = '<p class="text-sm text-slate-400">Нет доступных игр.</p>'; return; }
  if (!GM.boardGame || !games.some((g) => g.key === GM.boardGame)) GM.boardGame = games[0].key;
  const groups = (GM.me.categories || []).map((c) => ({ c, list: games.filter((g) => g.cat === c.key) })).filter((x) => x.list.length);
  const pick = `<select data-board-select class="${fieldCls}" style="max-width:340px">${groups.map(({ c, list }) => `<optgroup label="${esc(c.title)}">${list.map((g) => `<option value="${esc(g.key)}" ${GM.boardGame === g.key ? 'selected' : ''}>${g.icon} ${esc(g.title)}</option>`).join('')}</optgroup>`).join('')}</select>`;
  $('#gmBody').innerHTML = `<div class="mb-4">${pick}</div><div id="gmBoard"><p class="text-sm text-slate-500">Данные загружаются…</p></div>`;
  $('[data-board-select]').onchange = (e) => { GM.boardGame = e.target.value; gmRenderBoard(); };
  const meta = games.find((g) => g.key === GM.boardGame);
  let data;
  try { data = await Api.get('/api/games/leaderboard?game=' + encodeURIComponent(GM.boardGame)); }
  catch (e) { $('#gmBoard').innerHTML = `<p class="text-sm text-rose-300">${esc(e.message)}</p>`; return; }
  if (GM.boardGame !== meta.key || !$('#gmBoard')) return;
  const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : r);
  const note = data.better === 'low' ? 'Чем меньше, тем лучше.' : 'Чем больше, тем лучше.';
  $('#gmBoard').innerHTML = `<div class="flex items-center gap-3 mb-3"><span class="lc-g-ico" style="--gh:${meta.hue}; background:linear-gradient(155deg, hsl(${meta.hue} 60% 40%), hsl(${meta.hue + 35} 65% 22%)); width:46px; height:46px; font-size:26px">${meta.icon}</span>
      <p class="text-xs text-slate-400"><b class="text-sm">${esc(meta.title)}</b><br>${note} Участников: ${data.total}.${data.me ? ` Ваше место — ${data.me.rank}.` : ' У вас пока нет результата.'}</p></div>
    ${data.top.length ? `<div style="overflow-x:auto"><table class="w-full text-sm" style="min-width:420px"><thead><tr class="text-left text-xs text-slate-400">
      <th class="py-1.5 pr-3">Место</th><th class="pr-3">Сотрудник</th><th class="pr-3">Результат</th><th class="pr-3">Партий</th><th>Когда</th></tr></thead><tbody>
      ${data.top.map((r) => `<tr class="border-t border-slate-700/50 ${r.me ? 'text-emerald-300 font-semibold' : ''}" data-board-row="${r.rank}"><td class="py-1.5 pr-3 text-base">${medal(r.rank)}</td>
        <td class="pr-3">${esc(r.username)}${r.me ? ' (вы)' : ''}</td><td class="pr-3">${esc(gmNum(r.best, meta))}</td><td class="pr-3">${r.plays}</td><td class="text-xs text-slate-400">${esc(fmtDate(r.at))}</td></tr>`).join('')}
      </tbody></table></div>` : '<p class="text-sm text-slate-400">Пока никто не играл — станьте первым.</p>'}`;
}

// ---------------------------------------------------------------- окно игры
function gmStop() { if (GM.run) { GM.run.destroy(); GM.run = null; } }

function gmBackToList() { gmStop(); GM.tab = 'games'; gmRenderShell(); }

function gmOpenGame(key) {
  gmStop();
  const meta = GM.me.games.find((g) => g.key === key);
  if (!meta || (!GAMES_IMPL[key] && !['arrows', 'bubble'].includes(key))) return;
  $('#content').innerHTML = `<div class="lc-g-bar">
      <div class="lc-g-title"><span style="font-size:30px; line-height:1">${meta.icon}</span>${esc(meta.title)}</div>
      <div class="flex flex-wrap gap-2 items-center">${meta.difficulty ? `<label class="text-xs text-slate-400">Сложность <select id="gmDifficulty" class="${fieldCls} !py-1"><option value="easy">Лёгкая</option><option value="normal" selected>Обычная</option><option value="hard">Сложная</option></select></label>` : ''}<button type="button" id="gmRestart" class="${btnGhost}">↻ Заново</button><button type="button" id="gmBack" class="${btnGhost}">← К играм</button></div></div>
    <p id="gmStatus" class="lc-g-status"></p>
    <div id="gmStage" class="lc-g-stage" style="--gh:${meta.hue}"></div>
    <div id="gmResult"></div>`;
  $('#gmBack').onclick = gmBackToList;
  if (meta.difficulty) {
    $('#gmDifficulty').value = GM.difficulty;
    $('#gmDifficulty').onchange = (e) => { GM.difficulty = e.target.value; gmIntro(meta, start); };
  }
  const start = () => gmStart(meta);
  $('#gmRestart').onclick = start;
  gmIntro(meta, start);
}

function gmIntro(meta, start) {
  gmStop();
  $('#gmResult').innerHTML = '';
  $('#gmStatus').textContent = '';
  const b = GM.me.bests[meta.key];
  $('#gmStage').innerHTML = `<div class="lc-g-intro"><span class="lc-g-big">${meta.icon}</span><p class="lc-g-text text-sm" style="max-width:34rem">${esc(meta.hint)}</p>
      ${b ? `<span class="lc-g-best">🏅 Ваш рекорд: ${esc(gmNum(b.best, meta))}</span>` : ''}
      <button type="button" id="gmGo" class="lc-g-go">▶ Начать</button></div>`;
  $('#gmGo').onclick = start;
  $('#gmGo').focus();
}

function gmStart(meta) {
  gmStop();
  const stage = $('#gmStage');
  stage.innerHTML = '';
  $('#gmResult').innerHTML = '';
  $('#gmStatus').textContent = '';
  const kit = gmMakeKit(stage, $('#gmStatus'), (score, note) => gmFinish(meta, score, note));
  if (meta.difficulty) kit.difficulty = GM.difficulty;
  kit.startLevel = meta.key === 'water' ? Math.min(8, Math.max(0, Math.floor(Number(GM.me.bests.water?.best) || 0))) : 0;
  if (meta.key === 'arrows' || meta.key === 'bubble') {
    const frame = document.createElement('iframe');
    const gamePage = meta.key === 'arrows' ? '/static/games/arrows/index.html' : '/static/games/bubble/index.html';
    frame.src = `${gamePage}?v=${Date.now()}`;
    frame.title = meta.title;
    frame.className = 'lc-g-external';
    frame.allow = 'fullscreen';
    stage.appendChild(frame);
    let saved = Number(GM.me.bests[meta.key]?.best) || 0;
    kit.on(window, 'message', async (event) => {
      if (event.source !== frame.contentWindow || event.origin !== window.location.origin) return;
      const expectedType = meta.key === 'arrows' ? 'lc-arrows-level' : 'lc-bubble-score';
      const score = Number(event.data?.score ?? event.data?.level);
      const upper = meta.key === 'arrows' ? 9999 : 2_000_000;
      if (event.data?.type !== expectedType || !Number.isFinite(score) || score <= saved || score > upper) return;
      saved = score;
      try {
        const result = await Api.post('/api/games/score', { game: meta.key, score });
        GM.me.bests[meta.key] = { best: result.best, plays: result.plays };
        kit.status(`${meta.key === 'arrows' ? `Уровень ${score} пройден` : `Набрано ${score} очков`} · рекорд: ${result.best}`);
      } catch (e) { kit.status(`Результат не сохранён: ${e.message}`); }
    });
    GM.run = kit;
    return;
  }
  GM.run = kit;
  try { GAMES_IMPL[meta.key](kit); }
  catch (e) { kit.destroy(); GM.run = null; stage.innerHTML = `<p class="lc-g-text text-sm">Игра не запустилась: ${esc(e.message)}</p>`; }
}

async function gmFinish(meta, score, note) {
  const box = $('#gmResult');
  if (!box) return;
  const actions = `<div class="lc-g-actions"><button type="button" id="gmAgain" class="lc-g-go">↻ Ещё раз</button>
    <button type="button" id="gmTop" class="lc-g-mini">🏆 Таблица рекордов</button><button type="button" id="gmList" class="lc-g-mini">← К играм</button></div>`;
  const empty = score !== null && score <= 0 && meta.better === 'high';      // ноль очков в таблицу не идёт
  if (empty) score = null;
  const head = score === null ? `<b>${empty ? 'Результат: 0' : 'Партия окончена'}</b>` : `<b>Результат: ${esc(gmNum(score, meta))}</b>`;
  box.innerHTML = `<div class="lc-g-result" data-game-over="1">${head}
    ${note ? `<p class="text-sm" style="opacity:.8; margin-top:4px">${esc(note)}</p>` : ''}<p id="gmSaved" class="text-sm" style="margin-top:6px; opacity:.85">${score === null ? (empty ? 'Нулевой результат в таблицу не записывается.' : 'Результат не засчитан.') : 'Записываю результат…'}</p>${actions}</div>`;
  $('#gmAgain').onclick = () => gmStart(meta);
  $('#gmTop').onclick = () => { gmStop(); GM.expandedBoard = meta.key; gmRenderShell(); gmLoadInlineBoard(meta.key); };
  $('#gmList').onclick = gmBackToList;
  if (score === null) return;
  try {
    const r = await Api.post('/api/games/score', { game: meta.key, score });
    GM.me.bests[meta.key] = { best: r.best, plays: r.plays };
    const el = $('#gmSaved');
    if (el) {
      el.style.fontWeight = r.is_record ? '700' : '400';
      el.style.color = r.is_record ? '#fde047' : '';
      el.textContent = (r.is_record ? '🎉 Новый личный рекорд! ' : `Ваш рекорд: ${gmNum(r.best, meta)}. `) + (r.rank ? `Место в таблице: ${r.rank}.` : '');
      if (r.is_record) { el.closest('.lc-g-result').classList.add('lc-g-record'); gmConfetti(el.closest('.lc-g-result')); }
    }
  } catch (e) {
    const el = $('#gmSaved');
    if (el) { el.style.color = '#fcd34d'; el.textContent = 'Результат не записан: ' + e.message; }
  }
}

// ---------------------------------------------------------------- старт страницы
$('#userMenuBtn').onclick = () => $('#userMenu').classList.toggle('hidden');
document.addEventListener('click', (e) => {
  if (!e.target.closest('#userMenuBtn') && !e.target.closest('#userMenu')) $('#userMenu').classList.add('hidden');
});
$('#changePwBtn').onclick = () => { $('#userMenu').classList.add('hidden'); changePasswordForm({ forced: false }); };
$('#logoutBtn').onclick = async () => { await Api.post('/api/auth/logout', {}); window.location.href = '/login'; };

async function boot() {
  try { CURRENT_USER = await Api.get('/api/auth/me'); } catch { return; }
  initUserUi();
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  try { GM.me = await Api.get('/api/games/me'); }
  catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-300">${esc(e.message)}</p>`; return; }
  if (!GM.me.enabled) { $('#content').innerHTML = '<p class="text-sm text-slate-300">Игры вам не включены. Их включает администратор: «Администрирование → Игры».</p>'; return; }
  gmRenderShell();
}
boot();
