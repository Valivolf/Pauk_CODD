// Ещё игры для перерывов: сортировка, головоломки, логика, память, скорость (страница /games). Те же правила, что в games_impl.js: игра — функция (k) → ничего,
// всё занятое через k.* снимается само при k.over() и выходе из игры. Ключи совпадают с app/services/games.py. Чистые помощники (их проверяют тесты) — в GAMES_IMPL.util.
const gxPal = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316', '#06b6d4', '#ec4899', '#84cc16', '#94a3b8'];
const gxEl = (tag, css, cls) => { const e = document.createElement(tag); if (css) e.style.cssText = css; if (cls) e.className = cls; return e; };
const gxShake = (el) => { if (!el) return; el.classList.remove('lc-g-shake'); void el.offsetWidth; el.classList.add('lc-g-shake'); };

// ---------------------------------------------------------------- общие чистые помощники
Object.assign(GAMES_IMPL.util, {
  // Пробирки: n цветов по `cap` капель + 2 пустые. Перемешивание — обратными ходами по одной капле из решённого состояния, поэтому уровень решаем
  // (в игре льётся сразу весь верхний цвет; если зашли в тупик — есть «Отменить ход» и «Заново»).
  // moves — ходы вперёд (из, в), которыми его можно решить: применять с конца списка.
  waterLevel(n, cap = 4, steps = 0) {
    const tubes = Array.from({ length: n + 2 }, (_, i) => (i < n ? Array(cap).fill(i) : []));
    const moves = [];
    const total = steps || 90 + n * 40;
    let guard = 0;
    while ((moves.length < total || tubes.slice(0, n + 2).every((t) => !t.length || (t.length === cap && t.every((c) => c === t[0])))) && guard < 20000) {
      guard += 1;
      const b = gRnd(tubes.length), a = gRnd(tubes.length);
      const tb = tubes[b];
      if (a === b || !tb.length || tubes[a].length >= cap) continue;
      if (!(tb.length === 1 || tb[tb.length - 2] === tb[tb.length - 1])) continue;
      tubes[a].push(tb.pop());
      moves.push([a, b]);                       // вперёд: из a в b
    }
    return { tubes, moves };
  },
  waterSolved(tubes, cap = 4) { return tubes.every((t) => !t.length || (t.length === cap && t.every((c) => c === t[0]))); },
  // Налить из пробирки a в b (сколько получится одного цвета). Возвращает число перелитых капель (0 — нельзя).
  waterPour(tubes, a, b, cap = 4) {
    if (a === b || !tubes[a].length || tubes[b].length >= cap) return 0;
    const c = tubes[a][tubes[a].length - 1];
    if (tubes[b].length && tubes[b][tubes[b].length - 1] !== c) return 0;
    let n = 0;
    while (tubes[a].length && tubes[a][tubes[a].length - 1] === c && tubes[b].length < cap) { tubes[b].push(tubes[a].pop()); n += 1; }
    return n;
  },
  // Заливка из угла: меняет цвет области, связанной с (0,0). Возвращает новую сетку.
  floodStep(grid, color) {
    const n = grid.length, g = grid.map((r) => r.slice()), from = g[0][0];
    if (from === color) return g;
    const stack = [[0, 0]];
    while (stack.length) {
      const [x, y] = stack.pop();
      if (x < 0 || y < 0 || x >= n || y >= n || g[y][x] !== from) continue;
      g[y][x] = color;
      stack.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
    }
    return g;
  },
  floodDone(grid) { return grid.every((r) => r.every((c) => c === grid[0][0])); },
  // «Лампочки»: нажатие переворачивает клетку и четырёх соседей.
  lightsPress(board, x, y, n = 5) {
    for (const [dx, dy] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const xx = x + dx, yy = y + dy;
      if (xx >= 0 && yy >= 0 && xx < n && yy < n) board[yy][xx] = !board[yy][xx];
    }
  },
  // Пятнашки: можно ли решить (чётность перестановок), и сдвиг плитки в пустую клетку.
  slideSolvable(tiles, n = 4) {
    const a = tiles.filter((v) => v);
    let inv = 0;
    for (let i = 0; i < a.length; i += 1) for (let j = i + 1; j < a.length; j += 1) if (a[i] > a[j]) inv += 1;
    const rowFromBottom = n - Math.floor(tiles.indexOf(0) / n);
    return n % 2 === 1 ? inv % 2 === 0 : (inv + rowFromBottom) % 2 === 1;
  },
  slideSolvedNow(tiles) { return tiles.every((v, i) => v === (i === tiles.length - 1 ? 0 : i + 1)); },
  // Три в ряд: клетки, входящие в ряды из трёх и больше.
  findMatches(board) {
    const h = board.length, w = board[0].length, hit = new Set();
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        const c = board[y][x];
        if (c === null || c === undefined) continue;
        if (x + 2 < w && board[y][x + 1] === c && board[y][x + 2] === c) [0, 1, 2].forEach((d) => hit.add(`${x + d},${y}`));
        if (y + 2 < h && board[y + 1][x] === c && board[y + 2][x] === c) [0, 1, 2].forEach((d) => hit.add(`${x},${y + d}`));
      }
    }
    return hit;
  },
  hasMove(board) {
    const h = board.length, w = board[0].length, U = GAMES_IMPL.util;
    for (let y = 0; y < h; y += 1) {
      for (let x = 0; x < w; x += 1) {
        for (const [dx, dy] of [[1, 0], [0, 1]]) {
          const xx = x + dx, yy = y + dy;
          if (xx >= w || yy >= h) continue;
          [board[y][x], board[yy][xx]] = [board[yy][xx], board[y][x]];
          const ok = U.findMatches(board).size > 0;
          [board[y][x], board[yy][xx]] = [board[yy][xx], board[y][x]];
          if (ok) return true;
        }
      }
    }
    return false;
  },
});

// ---------------------------------------------------------------- Переливашки
GAMES_IMPL.workshop = (k) => {
  const owner = (CURRENT_USER && CURRENT_USER.username) || 'пользователь';
  const storeKey = `lc-workshop-${owner}`;
  let save = { level: 1, tokens: 0, tools: 0, jobs: 0 };
  try { save = { ...save, ...JSON.parse(localStorage.getItem(storeKey) || '{}') }; } catch { /* начинаем с чистого прогресса */ }
  const wrap = gxEl('div', 'display:grid; gap:12px; justify-items:center; max-width:480px; margin:0 auto');
  const info = gxEl('div', '', 'text-center lc-g-text');
  const work = gxEl('button', 'padding:14px 22px; font-size:18px', 'lc-g-go'); work.type = 'button';
  const upgrade = gxEl('button', 'padding:10px 16px', 'lc-g-mini'); upgrade.type = 'button';
  const finish = gxEl('button', 'padding:8px 14px', 'lc-g-mini'); finish.type = 'button'; finish.textContent = 'Сохранить результат и выйти';
  const goal = () => save.level * (k.difficulty === 'easy' ? 4 : k.difficulty === 'hard' ? 7 : 5);
  const rewardBase = () => k.difficulty === 'easy' ? 2 : 1;
  const cost = () => (k.difficulty === 'hard' ? 8 : 5) + save.tools * 4;
  const persist = () => { try { localStorage.setItem(storeKey, JSON.stringify(save)); } catch { /* хранилище может быть выключено */ } };
  const render = () => {
    info.innerHTML = `Уровень <b>${save.level}</b> · жетоны <b>${save.tokens}</b><br>Улучшения инструмента: ${save.tools} · выполнено заявок: ${save.jobs}`;
    work.textContent = `🔧 Выполнить заявку (+${rewardBase() + save.tools} жет.)`;
    upgrade.textContent = `⬆ Улучшить инструмент · ${cost()} жет.`;
    upgrade.disabled = save.tokens < cost();
    k.status(`Опыт: ${save.jobs} заявок · следующий уровень: ${goal()} заявок`);
  };
  k.on(work, 'click', () => {
    const reward = rewardBase() + save.tools;
    save.tokens += reward; save.jobs += 1;
    if (save.jobs >= goal()) save.level = Math.min(99, save.level + 1);
    persist(); render();
  });
  k.on(upgrade, 'click', () => { if (save.tokens < cost()) return; save.tokens -= cost(); save.tools += 1; persist(); render(); });
  k.on(finish, 'click', () => k.over(save.level, `Уровень ${save.level}, улучшений ${save.tools}. Прогресс сохранён.`));
  wrap.append(info, work, upgrade, finish); k.box.appendChild(wrap); render();
};

// ---------------------------------------------------------------- Переливашки
GAMES_IMPL.water = (k) => {
  const CAP = 4, U = GAMES_IMPL.util;
  let level = Math.max(0, Math.min(8, Number(k.startLevel) || 0)), tubes = [], start = [], hist = [], sel = -1, busy = false;
  const bar = gxEl('div', 'display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-bottom:14px');
  const mkBtn = (label, id) => { const b = gxEl('button', '', gBtn); b.type = 'button'; b.textContent = label; b.dataset.water = id; bar.appendChild(b); return b; };
  const undo = mkBtn('↶ Отменить ход', 'undo'), redo = mkBtn('↻ Заново', 'restart'), fin = mkBtn('🏁 Закончить', 'finish');
  const field = gxEl('div', 'display:flex; gap:14px 12px; justify-content:center; flex-wrap:wrap; max-width:640px; margin:0 auto; padding-top:18px');
  k.box.append(bar, field);
  const clone = (t) => t.map((x) => x.slice());
  const render = () => {
    field.innerHTML = tubes.map((t, i) => `<button type="button" data-tube="${i}" aria-label="Пробирка ${i + 1}" style="all:unset; cursor:pointer; width:46px; height:${CAP * 34 + 14}px; box-sizing:border-box; border-radius:8px 8px 24px 24px;
      border:3px solid rgba(255,255,255,${sel === i ? '.95' : '.45'}); background:rgba(255,255,255,.07); display:flex; flex-direction:column-reverse; padding:4px; gap:2px;
      transform:translateY(${sel === i ? -14 : 0}px); transition:transform .15s; box-shadow:${sel === i ? '0 0 18px rgba(255,255,255,.45)' : 'none'}">
      ${t.map((c) => `<span style="height:30px; border-radius:6px 6px 14px 14px; background:linear-gradient(180deg, ${gxPal[c]}, ${gxPal[c]}cc); box-shadow:inset 0 3px 0 rgba(255,255,255,.35)"></span>`).join('')}</button>`).join('');
    undo.disabled = !hist.length;
    k.status(`Уровень ${level + 1} · пройдено: ${level}`);
  };
  const nextLevel = () => {
    const base = k.difficulty === 'easy' ? 3 : k.difficulty === 'hard' ? 5 : 4;
    const lv = U.waterLevel(Math.min(base + level, 9), CAP);
    tubes = lv.tubes; start = clone(tubes); hist = []; sel = -1; busy = false; render();
  };
  k.on(field, 'click', (e) => {
    const b = e.target.closest('[data-tube]'); if (!b || busy) return;
    const i = +b.dataset.tube;
    if (sel === -1) { if (tubes[i].length) { sel = i; render(); } return; }
    if (sel === i) { sel = -1; render(); return; }
    const before = clone(tubes);
    if (U.waterPour(tubes, sel, i, CAP)) {
      hist.push(before); sel = -1; render();
      if (U.waterSolved(tubes, CAP)) { busy = true; level += 1; k.status(`✨ Уровень пройден! Пройдено: ${level}`); k.after(nextLevel, 900); }
    } else { gxShake(b); sel = tubes[i].length ? i : -1; render(); }
  });
  k.on(bar, 'click', (e) => {
    const b = e.target.closest('[data-water]'); if (!b || busy) return;
    if (b.dataset.water === 'undo' && hist.length) { tubes = hist.pop(); sel = -1; render(); }
    if (b.dataset.water === 'restart') { tubes = clone(start); hist = []; sel = -1; render(); }
    if (b.dataset.water === 'finish') k.over(level, level ? 'Пройдено уровней: ' + level : 'Ни одного уровня не пройдено');
  });
  nextLevel();
};

// ---------------------------------------------------------------- Расставь по порядку
GAMES_IMPL.order = (k) => {
  const SIZES = [6, 7, 8, 9, 10], t0 = performance.now();
  let round = 0, arr = [], sel = -1;
  const wrap = gxEl('div', 'display:flex; gap:10px; justify-content:center; flex-wrap:wrap; max-width:560px; margin:10px auto');
  k.box.appendChild(wrap);
  const fresh = () => {
    const n = SIZES[round];
    do { arr = gShuffle(Array.from({ length: n }, (_, i) => i + 1)); } while (arr.every((v, i) => v === i + 1));
    sel = -1; render();
  };
  const render = () => {
    wrap.innerHTML = arr.map((v, i) => `<button type="button" data-ord="${i}" class="lc-g-tile" style="width:58px; height:58px; font-size:24px; background:linear-gradient(160deg, hsl(${v * 34} 75% 55%), hsl(${v * 34 + 20} 70% 42%));
      ${sel === i ? 'outline:3px solid #fff; transform:translateY(-6px);' : ''}">${v}</button>`).join('');
    k.status(`Раунд ${round + 1} из ${SIZES.length} · ${Math.round((performance.now() - t0) / 100) / 10} с`);
  };
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-ord]'); if (!b) return;
    const i = +b.dataset.ord;
    if (sel === -1) { sel = i; render(); return; }
    if (sel !== i) [arr[sel], arr[i]] = [arr[i], arr[sel]];
    sel = -1; render();
    if (arr.every((v, j) => v === j + 1)) {
      round += 1;
      if (round >= SIZES.length) { const sec = Math.round(((performance.now() - t0) / 1000) * 10) / 10; k.over(sec, 'Все раунды пройдены'); return; }
      k.status('✨ Раунд пройден!'); k.after(fresh, 500);
    }
  });
  k.every(() => { if (round < SIZES.length) k.status(`Раунд ${round + 1} из ${SIZES.length} · ${Math.round((performance.now() - t0) / 100) / 10} с`); }, 200);
  fresh();
};

// ---------------------------------------------------------------- Сортировщик
GAMES_IMPL.sorter = (k) => {
  const BINS = [{ name: 'Красная', c: '#ef4444', key: '1' }, { name: 'Синяя', c: '#3b82f6', key: '2' }, { name: 'Зелёная', c: '#22c55e', key: '3' }];
  let score = 0, lives = 3, cur = 0, left = 0, limit = 2.4;
  const ball = gxEl('div', 'width:84px; height:84px; border-radius:50%; margin:6px auto 12px; box-shadow:inset -8px -10px 0 rgba(0,0,0,.18), inset 8px 8px 0 rgba(255,255,255,.3), 0 8px 18px rgba(0,0,0,.35)');
  const meter = gxEl('div', 'height:10px; border-radius:6px; background:rgba(255,255,255,.12); max-width:320px; margin:0 auto 18px; overflow:hidden');
  const fill = gxEl('div', 'height:100%; width:100%; background:linear-gradient(90deg,#22c55e,#eab308,#ef4444); transform-origin:left');
  meter.appendChild(fill);
  const bins = gxEl('div', 'display:flex; gap:12px; justify-content:center; flex-wrap:wrap');
  BINS.forEach((b, i) => {
    const e = gxEl('button', `width:104px; height:80px; font-size:14px; background:linear-gradient(160deg, ${b.c}, ${b.c}aa)`, 'lc-g-tile');
    e.type = 'button'; e.dataset.bin = i; e.innerHTML = `🗑️<br>${b.name}<br><small style="opacity:.8">клавиша ${b.key}</small>`; bins.appendChild(e);
  });
  k.box.append(ball, meter, bins);
  const next = () => { cur = gRnd(3); ball.style.background = `radial-gradient(circle at 32% 28%, #fff8, ${BINS[cur].c} 55%)`; limit = Math.max(0.9, 2.4 - score * 0.05); left = limit; };
  const status = () => k.status(`Отсортировано: ${score} · жизней: ${'❤️'.repeat(lives)}${'🖤'.repeat(3 - lives)}`);
  const pick = (i) => {
    if (i === cur) { score += 1; next(); } else { lives -= 1; gxShake(ball); if (lives <= 0) { status(); k.over(score, 'Три ошибки'); return; } next(); }
    status();
  };
  k.on(bins, 'click', (e) => { const b = e.target.closest('[data-bin]'); if (b) pick(+b.dataset.bin); });
  k.on(document, 'keydown', (e) => { const i = { 1: 0, 2: 1, 3: 2, ArrowLeft: 0, ArrowDown: 1, ArrowRight: 2 }[e.key]; if (i !== undefined) { e.preventDefault(); pick(i); } });
  k.every(() => {
    left -= 0.05; fill.style.transform = `scaleX(${Math.max(0, left / limit)})`;
    if (left <= 0) { lives -= 1; gxShake(ball); status(); if (lives <= 0) { k.over(score, 'Не успели'); return; } next(); }
  }, 50);
  next(); status();
};

// ---------------------------------------------------------------- Заливка
GAMES_IMPL.flood = (k) => {
  const N = 10, MAXM = 25, U = GAMES_IMPL.util, COL = ['#ef4444', '#3b82f6', '#22c55e', '#eab308', '#a855f7', '#f97316'];
  let grid, moves = 0;
  do { grid = Array.from({ length: N }, () => Array.from({ length: N }, () => gRnd(6))); } while (U.floodDone(grid));
  const board = gxEl('div', `display:grid; grid-template-columns:repeat(${N}, 1fr); gap:2px; width:min(100%, 360px); margin:0 auto 14px; padding:6px; border-radius:14px; background:rgba(0,0,0,.25)`);
  const pal = gxEl('div', 'display:flex; gap:10px; justify-content:center; flex-wrap:wrap');
  COL.forEach((c, i) => { const b = gxEl('button', `width:48px; height:48px; background:linear-gradient(160deg, ${c}, ${c}aa)`, 'lc-g-tile'); b.type = 'button'; b.dataset.col = i; b.setAttribute('aria-label', 'Цвет ' + (i + 1)); pal.appendChild(b); });
  k.box.append(board, pal);
  const render = () => {
    board.innerHTML = grid.flat().map((c) => `<span style="aspect-ratio:1; border-radius:4px; background:${COL[c]}; transition:background .18s"></span>`).join('');
    k.status(`Ход ${moves} из ${MAXM}`);
  };
  k.on(pal, 'click', (e) => {
    const b = e.target.closest('[data-col]'); if (!b) return;
    const c = +b.dataset.col; if (c === grid[0][0]) return;
    grid = U.floodStep(grid, c); moves += 1; render();
    if (U.floodDone(grid)) k.over(moves, 'Поле закрашено');
    else if (moves >= MAXM) k.over(null, `Не уложились в ${MAXM} ходов`);
  });
  render();
};

// ---------------------------------------------------------------- Лампочки
GAMES_IMPL.lights = (k) => {
  const N = 5, U = GAMES_IMPL.util;
  let board, moves = 0;
  do {
    board = Array.from({ length: N }, () => Array(N).fill(false));
    const presses = 6 + gRnd(6);
    for (let i = 0; i < presses; i += 1) U.lightsPress(board, gRnd(N), gRnd(N), N);
  } while (board.every((r) => r.every((v) => !v)));
  const wrap = gxEl('div', `display:grid; grid-template-columns:repeat(${N}, 1fr); gap:8px; width:min(100%, 320px); margin:0 auto; padding:10px; border-radius:16px; background:rgba(0,0,0,.28)`);
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = board.map((row, y) => row.map((on, x) => `<button type="button" data-lx="${x}" data-ly="${y}" class="lc-g-tile" aria-label="Лампочка" style="aspect-ratio:1; font-size:26px;
      background:${on ? 'radial-gradient(circle at 35% 30%, #fff7b0, #facc15 60%, #f59e0b)' : 'linear-gradient(160deg, #334155, #1e293b)'}; box-shadow:${on ? '0 0 20px rgba(250,204,21,.7)' : 'inset 0 -3px 0 rgba(0,0,0,.3)'}">${on ? '💡' : ''}</button>`).join('')).join('');
    k.status(`Ходов: ${moves} · горит: ${board.flat().filter(Boolean).length}`);
  };
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-lx]'); if (!b) return;
    U.lightsPress(board, +b.dataset.lx, +b.dataset.ly, N); moves += 1; render();
    if (board.every((r) => r.every((v) => !v))) k.over(moves, 'Все лампочки погашены');
  });
  render();
};

// ---------------------------------------------------------------- Пятнашки
GAMES_IMPL.slide15 = (k) => {
  const N = 4, U = GAMES_IMPL.util;
  let tiles = Array.from({ length: N * N }, (_, i) => (i === N * N - 1 ? 0 : i + 1)), moves = 0, last = -1;
  const neighbors = (e) => { const x = e % N, y = Math.floor(e / N), r = []; if (x > 0) r.push(e - 1); if (x < N - 1) r.push(e + 1); if (y > 0) r.push(e - N); if (y < N - 1) r.push(e + N); return r; };
  for (let i = 0; i < 160; i += 1) {                    // перемешиваем ходами из решённого состояния — всегда решаемо
    const e = tiles.indexOf(0), opts = neighbors(e).filter((p) => p !== last), p = opts[gRnd(opts.length)];
    tiles[e] = tiles[p]; tiles[p] = 0; last = e;
  }
  if (U.slideSolvedNow(tiles)) { const e = tiles.indexOf(0), p = neighbors(e)[0]; tiles[e] = tiles[p]; tiles[p] = 0; }
  const wrap = gxEl('div', `display:grid; grid-template-columns:repeat(${N}, 1fr); gap:6px; width:min(100%, 340px); margin:0 auto; padding:8px; border-radius:16px; background:rgba(0,0,0,.28); touch-action:none`);
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = tiles.map((v, i) => (v ? `<button type="button" data-sl="${i}" class="lc-g-tile" style="aspect-ratio:1; font-size:26px; background:linear-gradient(160deg, hsl(${v * 22} 70% 55%), hsl(${v * 22 + 25} 65% 40%))">${v}</button>` : '<span></span>')).join('');
    k.status('Ходов: ' + moves);
  };
  const slide = (p) => {
    const e = tiles.indexOf(0);
    if (!neighbors(e).includes(p)) return false;
    tiles[e] = tiles[p]; tiles[p] = 0; moves += 1; return true;
  };
  const after = () => { render(); if (U.slideSolvedNow(tiles)) k.over(moves, 'Всё на местах'); };
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-sl]'); if (!b) return;
    const p = +b.dataset.sl, em = tiles.indexOf(0);
    const sameCol = p % N === em % N, sameRow = Math.floor(p / N) === Math.floor(em / N);
    if (!sameCol && !sameRow) return;                                          // в одной линии с пустой клеткой — сдвигаем всю цепочку, каждый сдвиг — ход
    const step = sameCol ? (p > em ? N : -N) : (p > em ? 1 : -1);
    for (let cur = em + step; ; cur += step) {
      const hole = tiles.indexOf(0);
      tiles[hole] = tiles[cur]; tiles[cur] = 0; moves += 1;
      if (cur === p) break;
    }
    after();
  });
  k.on(document, 'keydown', (e) => {
    const em = tiles.indexOf(0), x = em % N, y = Math.floor(em / N);
    const p = { ArrowLeft: x < N - 1 ? em + 1 : -1, ArrowRight: x > 0 ? em - 1 : -1, ArrowUp: y < N - 1 ? em + N : -1, ArrowDown: y > 0 ? em - N : -1 }[e.key];
    if (p === undefined) return;
    e.preventDefault(); if (p >= 0 && slide(p)) after();
  });
  render();
};

// ---------------------------------------------------------------- Ханойская башня
GAMES_IMPL.hanoi = (k) => {
  const D = 5;
  let pegs = [Array.from({ length: D }, (_, i) => D - i), [], []], sel = -1, moves = 0;
  const wrap = gxEl('div', 'display:flex; gap:10px; justify-content:center; max-width:560px; margin:6px auto');
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = pegs.map((p, i) => `<button type="button" data-peg="${i}" aria-label="Стержень ${i + 1}" style="all:unset; cursor:pointer; flex:1; max-width:180px; height:${D * 30 + 40}px; position:relative; display:flex; flex-direction:column-reverse; align-items:center;
      padding-bottom:6px; box-sizing:border-box; border-radius:14px; background:${sel === i ? 'rgba(250,204,21,.16)' : 'rgba(255,255,255,.06)'}; border:2px solid ${sel === i ? '#facc15' : 'rgba(255,255,255,.18)'}">
      <span style="position:absolute; bottom:6px; width:8px; top:14px; border-radius:4px; background:rgba(255,255,255,.28)"></span>
      ${p.map((d) => `<span style="position:relative; z-index:1; height:26px; width:${34 + d * 20}px; max-width:96%; margin-top:4px; border-radius:13px; background:linear-gradient(160deg, hsl(${d * 55} 75% 58%), hsl(${d * 55 + 25} 70% 42%)); box-shadow:inset 0 3px 0 rgba(255,255,255,.35)"></span>`).join('')}</button>`).join('');
    k.status('Ходов: ' + moves);
  };
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-peg]'); if (!b) return;
    const i = +b.dataset.peg;
    if (sel === -1) { if (pegs[i].length) { sel = i; render(); } return; }
    if (sel === i) { sel = -1; render(); return; }
    const d = pegs[sel][pegs[sel].length - 1], top = pegs[i][pegs[i].length - 1];
    if (top !== undefined && top < d) { sel = -1; render(); gxShake(wrap.children[i]); return; }
    pegs[i].push(pegs[sel].pop()); sel = -1; moves += 1; render();
    if (pegs[1].length === D || pegs[2].length === D) k.over(moves, moves === 2 ** D - 1 ? 'Идеально: меньше ходов не бывает' : 'Башня перенесена');
  });
  render();
};

// ---------------------------------------------------------------- Три в ряд
GAMES_IMPL.match3 = (k) => {
  const N = 8, U = GAMES_IMPL.util, GEM = ['🔴', '🔵', '🟢', '🟡', '🟣', '🟠'];
  let board = [], score = 0, left = 60, sel = null, busy = false, clearing = new Set();
  const wait = (ms) => new Promise((r) => k.after(r, ms));
  const rndGem = () => gRnd(GEM.length);
  const fresh = () => {
    do {
      board = Array.from({ length: N }, () => Array(N).fill(0));
      for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) { do { board[y][x] = rndGem(); } while ((x > 1 && board[y][x - 1] === board[y][x] && board[y][x - 2] === board[y][x]) || (y > 1 && board[y - 1][x] === board[y][x] && board[y - 2][x] === board[y][x])); }
    } while (!U.hasMove(board));
  };
  const wrap = gxEl('div', `display:grid; grid-template-columns:repeat(${N}, 1fr); gap:3px; width:min(100%, 400px); margin:0 auto; padding:8px; border-radius:16px; background:rgba(0,0,0,.28)`);
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = board.map((row, y) => row.map((c, x) => `<button type="button" data-mx="${x}" data-my="${y}" class="lc-g-tile" aria-label="Камень" style="aspect-ratio:1; font-size:min(5.6vw, 26px); padding:0;
      background:${sel && sel.x === x && sel.y === y ? 'rgba(250,204,21,.45)' : 'rgba(255,255,255,.1)'}; box-shadow:none; ${clearing.has(`${x},${y}`) ? 'transform:scale(.1); opacity:0; transition:all .2s;' : ''}">${GEM[c]}</button>`).join('')).join('');
    k.status(`Очки: ${score} · осталось ${left} с`);
  };
  const settle = async () => {
    let combo = 1, m = U.findMatches(board);
    while (m.size) {
      score += m.size * 10 * combo; clearing = m; render(); await wait(230);
      m.forEach((key) => { const [x, y] = key.split(',').map(Number); board[y][x] = null; });
      for (let x = 0; x < N; x += 1) {                                  // падение камней вниз и новые сверху
        const col = []; for (let y = N - 1; y >= 0; y -= 1) if (board[y][x] !== null) col.push(board[y][x]);
        while (col.length < N) col.push(rndGem());
        for (let y = N - 1, i = 0; y >= 0; y -= 1, i += 1) board[y][x] = col[i];
      }
      clearing = new Set(); render(); await wait(200);
      combo += 1; m = U.findMatches(board);
    }
    if (!U.hasMove(board)) { fresh(); render(); }
  };
  const swap = async (a, b) => {
    busy = true;
    [board[a.y][a.x], board[b.y][b.x]] = [board[b.y][b.x], board[a.y][a.x]]; sel = null; render(); await wait(160);
    if (U.findMatches(board).size) await settle();
    else { [board[a.y][a.x], board[b.y][b.x]] = [board[b.y][b.x], board[a.y][a.x]]; render(); }
    busy = false; render();
  };
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-mx]'); if (!b || busy) return;
    const c = { x: +b.dataset.mx, y: +b.dataset.my };
    if (!sel) { sel = c; render(); return; }
    if (Math.abs(sel.x - c.x) + Math.abs(sel.y - c.y) === 1) swap(sel, c);
    else { sel = c; render(); }
  });
  k.every(() => { left -= 1; if (left <= 0) { left = 0; render(); k.over(score, 'Время вышло'); return; } k.status(`Очки: ${score} · осталось ${left} с`); }, 1000);
  fresh(); render();
};

// ---------------------------------------------------------------- Повтори за мной
GAMES_IMPL.simon = (k) => {
  const COL = [['#22c55e', '#86efac'], ['#ef4444', '#fca5a5'], ['#eab308', '#fde68a'], ['#3b82f6', '#93c5fd']];
  let seq = [], pos = 0, locked = true;
  const wrap = gxEl('div', 'display:grid; grid-template-columns:1fr 1fr; gap:12px; width:min(100%, 320px); margin:0 auto');
  const pads = COL.map(([d], i) => { const b = gxEl('button', `aspect-ratio:1; font-size:0; background:${d}; opacity:.55; border-radius:${['28px 8px 8px 8px', '8px 28px 8px 8px', '8px 8px 8px 28px', '8px 8px 28px 8px'][i]}`, 'lc-g-tile'); b.type = 'button'; b.dataset.pad = i; b.setAttribute('aria-label', 'Огонь ' + (i + 1)); wrap.appendChild(b); return b; });
  k.box.appendChild(wrap);
  const light = (i, ms = 380) => { pads[i].style.opacity = '1'; pads[i].style.background = COL[i][1]; pads[i].style.boxShadow = `0 0 26px ${COL[i][0]}`; k.after(() => { pads[i].style.opacity = '.55'; pads[i].style.background = COL[i][0]; pads[i].style.boxShadow = ''; }, ms); };
  const play = () => {
    locked = true; pos = 0; seq.push(gRnd(4)); k.status(`Раунд ${seq.length} · смотрите`);
    seq.forEach((p, i) => k.after(() => light(p), 600 + i * 650));
    k.after(() => { locked = false; k.status(`Раунд ${seq.length} · ваш ход`); }, 600 + seq.length * 650);
  };
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-pad]'); if (!b || locked) return;
    const i = +b.dataset.pad; light(i, 200);
    if (i !== seq[pos]) { locked = true; k.over(seq.length - 1, `Цепочка была длиной ${seq.length}`); return; }
    pos += 1;
    if (pos >= seq.length) { locked = true; k.status('✨ Верно!'); k.after(play, 800); }
  });
  k.after(play, 500);
};

// ---------------------------------------------------------------- Башня
GAMES_IMPL.stack = (k) => {
  const W = 320, H = 480, BH = 24;
  const { g } = k.canvas(W, H);
  let blocks = [{ x: 80, w: 160 }], cur = { x: 0, w: 160, dir: 1 }, score = 0, cam = 0, last = 0, acc = 0;
  const hue = (i) => (i * 17 + 200) % 360;
  const yOf = (i) => H - 40 - (i + 1) * BH + cam;
  const draw = () => {
    const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#312e81'); sky.addColorStop(1, '#0f172a');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    blocks.forEach((b, i) => { g.fillStyle = `hsl(${hue(i)} 70% 55%)`; g.fillRect(b.x, yOf(i), b.w, BH - 2); g.fillStyle = 'rgba(255,255,255,.22)'; g.fillRect(b.x, yOf(i), b.w, 5); });
    g.fillStyle = `hsl(${hue(blocks.length)} 75% 60%)`; g.fillRect(cur.x, yOf(blocks.length), cur.w, BH - 2);
    g.fillStyle = '#fff'; g.font = 'bold 34px sans-serif'; g.textAlign = 'center'; g.fillText(String(score), W / 2, 56);
  };
  const drop = () => {
    const top = blocks[blocks.length - 1];
    const left = Math.max(cur.x, top.x), right = Math.min(cur.x + cur.w, top.x + top.w), ov = right - left;
    if (ov <= 0) { draw(); k.over(score, 'Блок промахнулся'); return; }
    const perfect = Math.abs(cur.x - top.x) < 5;
    blocks.push(perfect ? { x: top.x, w: top.w } : { x: left, w: ov });
    score += 1; k.status(perfect ? `Блоков: ${score} · ✨ идеально!` : `Блоков: ${score}`);
    cur = { x: cur.dir > 0 ? 0 : W - blocks[blocks.length - 1].w, w: blocks[blocks.length - 1].w, dir: -cur.dir };
  };
  k.on(document, 'keydown', (e) => { if (e.key === ' ') { e.preventDefault(); drop(); } });
  k.on(k.box, 'pointerdown', (e) => { if (e.target.closest('canvas')) { e.preventDefault(); drop(); } });
  k.raf((t) => {
    acc += Math.min(50, t - (last || t)); last = t;
    while (acc >= 16.7) {
      acc -= 16.7;
      cur.x += cur.dir * (2.2 + score * 0.1);
      if (cur.x < 0) { cur.x = 0; cur.dir = 1; }
      if (cur.x + cur.w > W) { cur.x = W - cur.w; cur.dir = -1; }
      const target = Math.max(0, (blocks.length - 11) * BH); cam += (target - cam) * 0.1;
    }
    draw();
  });
  k.status('Блоков: 0'); draw();
};

// ---------------------------------------------------------------- Камень-ножницы-бумага
GAMES_IMPL.rps = (k) => {
  const ICON = ['✊', '✌️', '✋'], NAME = ['камень', 'ножницы', 'бумага'];
  let streak = 0;
  const arena = gxEl('div', 'display:flex; gap:26px; justify-content:center; align-items:center; font-size:76px; line-height:1; margin:8px 0 18px; min-height:96px');
  const me = gxEl('span'), vs = gxEl('span', 'font-size:20px; opacity:.6'), pc = gxEl('span');
  vs.textContent = 'против'; me.textContent = '❔'; pc.textContent = '❔';
  arena.append(me, vs, pc);
  const row = gxEl('div', 'display:flex; gap:14px; justify-content:center; flex-wrap:wrap');
  ICON.forEach((ic, i) => { const b = gxEl('button', 'width:88px; height:88px; font-size:44px; background:linear-gradient(160deg,#6366f1,#4338ca)', 'lc-g-tile'); b.type = 'button'; b.dataset.rps = i; b.textContent = ic; b.setAttribute('aria-label', NAME[i]); row.appendChild(b); });
  const msg = gxEl('p', 'text-align:center; margin-top:14px; min-height:1.6em', 'lc-g-text text-sm');
  k.box.append(arena, row, msg);
  k.on(row, 'click', (e) => {
    const b = e.target.closest('[data-rps]'); if (!b) return;
    const a = +b.dataset.rps, c = gRnd(3);
    me.textContent = ICON[a]; pc.textContent = ICON[c];
    if (a === c) { msg.textContent = 'Ничья — ещё раз'; } else if ((a + 1) % 3 === c) { streak += 1; msg.textContent = `Победа! ${NAME[a]} бьёт ${NAME[c]}`; } else { msg.textContent = `Проигрыш: ${NAME[c]} бьёт ${NAME[a]}`; k.status(`Побед подряд: ${streak}`); k.over(streak, 'Серия прервана'); return; }
    k.status(`Побед подряд: ${streak}`);
  });
  k.status('Побед подряд: 0');
};

// ---------------------------------------------------------------- Виселица
GAMES_IMPL.hangman = (k) => {
  const WORDS = ['камера', 'радар', 'роутер', 'монтер', 'кабель', 'антенна', 'питание', 'шкаф', 'бригада', 'выезд', 'диспетчер', 'комплекс', 'датчик', 'сервер', 'проводка', 'розетка',
    'лестница', 'автовышка', 'мачта', 'столб', 'оборудование', 'склад', 'замена', 'ремонт', 'проверка', 'карта', 'маршрут', 'отчет', 'журнал', 'статус', 'монитор', 'объектив',
    'вспышка', 'скорость', 'нарушение', 'дорога', 'светофор', 'перекресток', 'сигнал', 'связь', 'модем', 'адрес', 'пароль', 'доступ', 'фотография', 'архив', 'календарь', 'задание',
    'инструмент', 'отвертка', 'плоскогубцы', 'изоляция', 'аккумулятор', 'генератор', 'солнце', 'дождь', 'ветер', 'гроза'];
  const ABC = 'абвгдежзийклмнопрстуфхцчшщъыьэюя';
  let word = '', used = new Set(), lives = 6, score = 0, deck = gShuffle(WORDS.slice());
  const view = gxEl('div', 'font-size:34px; font-weight:800; letter-spacing:.14em; text-align:center; margin:6px 0 10px; min-height:1.3em; overflow-wrap:anywhere');
  const hearts = gxEl('div', 'text-align:center; font-size:22px; margin-bottom:12px');
  const kb = gxEl('div', 'display:flex; flex-wrap:wrap; gap:6px; justify-content:center; max-width:520px; margin:0 auto');
  k.box.append(view, hearts, kb);
  const render = () => {
    view.textContent = [...word].map((c) => (used.has(c) ? c.toUpperCase() : '_')).join(' ');
    hearts.textContent = '❤️'.repeat(lives) + '🖤'.repeat(6 - lives);
    kb.innerHTML = [...ABC].map((c) => `<button type="button" data-letter="${c}" class="lc-g-tile" ${used.has(c) ? 'disabled' : ''} style="width:38px; height:42px; font-size:17px; text-transform:uppercase; background:${used.has(c) ? (word.includes(c) ? '#15803d' : '#475569') : 'linear-gradient(160deg,#6366f1,#4338ca)'}; opacity:${used.has(c) ? '.5' : '1'}">${c}</button>`).join('');
    k.status(`Угадано слов: ${score}`);
  };
  const nextWord = () => { if (!deck.length) deck = gShuffle(WORDS.slice()); word = deck.pop(); used = new Set(); lives = 6; render(); };
  const guess = (c) => {
    if (!ABC.includes(c) || used.has(c)) return;
    used.add(c);
    if (!word.includes(c)) { lives -= 1; gxShake(view); }
    render();
    if (lives <= 0) { view.textContent = [...word].join(' ').toUpperCase(); k.over(score, `Слово было: ${word}`); return; }
    if ([...word].every((x) => used.has(x))) { score += 1; k.status(`✨ Верно! Угадано слов: ${score}`); k.after(nextWord, 900); }
  };
  k.on(kb, 'click', (e) => { const b = e.target.closest('[data-letter]'); if (b) guess(b.dataset.letter); });
  k.on(document, 'keydown', (e) => { if (e.ctrlKey || e.metaKey || e.altKey) return; const c = (e.key || '').toLowerCase().replace('ё', 'е'); if (c.length === 1) guess(c); });
  nextWord();
};

// ---------------------------------------------------------------- Угадай число
GAMES_IMPL.guess = (k) => {
  const secret = 1 + gRnd(100);
  let tries = 0, lo = 1, hi = 100;
  const info = gxEl('p', 'text-align:center; font-size:18px; margin:6px 0 12px', 'lc-g-text');
  const row = gxEl('div', 'display:flex; gap:10px; justify-content:center; flex-wrap:wrap');
  const inp = gxEl('input', 'width:130px; text-align:center; font-size:26px; padding:8px 10px; border-radius:12px', 'accent-ring'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'off'; inp.dataset.guess = '1';
  const ok = gxEl('button', '', gBtn); ok.type = 'button'; ok.textContent = 'Проверить';
  const hist = gxEl('p', 'text-align:center; margin-top:14px; opacity:.8; overflow-wrap:anywhere', 'lc-g-text text-xs');
  row.append(inp, ok); k.box.append(info, row, hist);
  const show = () => { info.textContent = `Число от ${lo} до ${hi}`; k.status('Попыток: ' + tries); };
  const submit = () => {
    const v = parseInt(inp.value.replace(/\s+/g, ''), 10);
    if (Number.isNaN(v) || v < 1 || v > 100) { gxShake(inp); return; }
    tries += 1; inp.value = '';
    if (v === secret) { k.over(tries, `Загадано было ${secret}`); return; }
    if (v < secret) { lo = Math.max(lo, v + 1); hist.textContent += `${v}↑  `; info.textContent = `${v} — это МЕНЬШЕ. Число от ${lo} до ${hi}`; } else { hi = Math.min(hi, v - 1); hist.textContent += `${v}↓  `; info.textContent = `${v} — это БОЛЬШЕ. Число от ${lo} до ${hi}`; }
    k.status('Попыток: ' + tries); inp.focus();
  };
  k.on(inp, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  k.on(ok, 'click', submit);
  show(); inp.focus();
};

// ---------------------------------------------------------------- Таблица Шульте
GAMES_IMPL.schulte = (k) => {
  const N = 5, t0 = performance.now();
  let next = 1;
  const nums = gShuffle(Array.from({ length: N * N }, (_, i) => i + 1));
  const wrap = gxEl('div', `display:grid; grid-template-columns:repeat(${N}, 1fr); gap:6px; width:min(100%, 340px); margin:0 auto; padding:8px; border-radius:16px; background:rgba(0,0,0,.28)`);
  k.box.appendChild(wrap);
  wrap.innerHTML = nums.map((v) => `<button type="button" data-sh="${v}" class="lc-g-tile" style="aspect-ratio:1; font-size:22px; background:linear-gradient(160deg, hsl(${(v * 47) % 360} 65% 52%), hsl(${(v * 47 + 25) % 360} 60% 38%))">${v}</button>`).join('');
  const tick = () => k.status(`Ищите: ${Math.min(next, N * N)} · ${Math.round((performance.now() - t0) / 100) / 10} с`);
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-sh]'); if (!b) return;
    if (+b.dataset.sh !== next) { gxShake(b); return; }
    b.style.opacity = '.25'; b.disabled = true; next += 1;
    if (next > N * N) k.over(Math.round(((performance.now() - t0) / 1000) * 10) / 10, 'Все числа найдены');
  });
  k.every(tick, 100); tick();
};

// ---------------------------------------------------------------- Тапалка
GAMES_IMPL.clicker = (k) => {
  let count = 0, left = k.difficulty === 'easy' ? 15 : k.difficulty === 'hard' ? 7 : 10, started = false;
  const btn = gxEl('button', 'display:block; margin:10px auto; width:min(100%, 260px); height:200px; border-radius:50%; font-size:64px; background:radial-gradient(circle at 35% 30%, #fb7185, #e11d48 60%, #9f1239)', 'lc-g-tile');
  btn.type = 'button'; btn.dataset.tap = '1'; btn.textContent = '👆';
  const num = gxEl('p', 'text-align:center; font-size:40px; font-weight:800', ''); num.textContent = '0';
  k.box.append(btn, num);
  k.on(btn, 'pointerdown', (e) => {
    e.preventDefault(); started = true; count += 1; num.textContent = String(count);
    btn.style.transform = 'scale(.94)'; k.after(() => { btn.style.transform = ''; }, 60);
  });
  const duration = k.difficulty === 'easy' ? 15 : k.difficulty === 'hard' ? 7 : 10;
  k.every(() => { if (!started) return; left = Math.round((left - 0.1) * 10) / 10; k.status(`Осталось ${Math.max(0, left).toFixed(1)} с`); if (left <= 0) k.over(count, `${(count / duration).toFixed(1)} нажатий в секунду`); }, 100);
  k.status('Нажмите — время пойдёт');
};

// ---------------------------------------------------------------- Бегун
GAMES_IMPL.runner = (k) => {
  const W = 520, H = 220, GY = 176;
  const { g } = k.canvas(W, H);
  let y = 0, vy = 0, obs = [], dist = 0, speed = 6, frames = 0, nextGap = 60, last = 0, acc = 0, started = false;
  const jump = () => { started = true; if (y === 0) vy = 11.5; };
  k.on(document, 'keydown', (e) => { if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); jump(); } });
  k.on(k.box, 'pointerdown', (e) => { if (e.target.closest('canvas')) { e.preventDefault(); jump(); } });
  const draw = () => {
    const sky = g.createLinearGradient(0, 0, 0, H); sky.addColorStop(0, '#38bdf8'); sky.addColorStop(1, '#bae6fd');
    g.fillStyle = sky; g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.8)'; [[(120 - frames * 0.3) % (W + 80), 36], [(360 - frames * 0.3) % (W + 80), 64]].forEach(([cx, cy]) => { g.beginPath(); g.ellipse(cx < -40 ? cx + W + 80 : cx, cy, 30, 12, 0, 0, 7); g.fill(); });
    g.fillStyle = '#16a34a'; g.fillRect(0, GY + 4, W, H - GY); g.fillStyle = '#15803d'; g.fillRect(0, GY + 4, W, 6);
    obs.forEach((o) => { g.fillStyle = '#7c2d12'; g.fillRect(o.x, GY + 4 - o.h, o.w, o.h); g.fillStyle = '#9a3412'; g.fillRect(o.x + 3, GY + 4 - o.h + 3, 4, o.h - 6); });
    g.font = '38px sans-serif'; g.textAlign = 'left'; g.textBaseline = 'alphabetic'; g.fillText('🏃', 50, GY + 2 - y);
    g.fillStyle = '#0f172a'; g.font = 'bold 18px sans-serif'; g.textAlign = 'right'; g.fillText(`${Math.floor(dist)} м`, W - 12, 26);
    if (!started) { g.textAlign = 'center'; g.font = '16px sans-serif'; g.fillText('Пробел или касание — прыжок', W / 2, 110); }
  };
  k.raf((t) => {
    acc += Math.min(50, t - (last || t)); last = t;
    while (acc >= 16.7) {
      acc -= 16.7;
      if (!started) continue;
      frames += 1; speed = 6 + dist / 140; dist += speed / 12;
      vy -= 0.62; y = Math.max(0, y + vy); if (y === 0) vy = 0;
      nextGap -= 1;
      if (nextGap <= 0) { obs.push({ x: W + 10, w: 18 + gRnd(18), h: 26 + gRnd(26) }); nextGap = Math.max(34, 70 + gRnd(50) - dist / 8); }
      obs.forEach((o) => { o.x -= speed; });
      obs = obs.filter((o) => o.x > -50);
      if (obs.some((o) => 50 + 26 > o.x + 3 && 50 + 8 < o.x + o.w - 3 && y < o.h - 6)) { draw(); k.over(Math.floor(dist), 'Препятствие'); return; }
    }
    draw(); k.status(`Пробег: ${Math.floor(dist)} м`);
  });
  draw(); k.status('Пробег: 0 м');
};
