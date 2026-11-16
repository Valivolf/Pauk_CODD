// Игры для перерывов (страница /games). Все написаны здесь, без внешних библиотек и без интернета. Каждая игра — функция (k) → ничего: k — «набор» от games.js
// (k.box — куда рисовать, k.canvas(w,h), k.on(...), k.every(...), k.after(...), k.raf(...), k.swipe(...), k.status(текст), k.over(результат | null, пояснение)).
// Всё, что игра зарегистрировала через k.*, снимается само при k.over() и при закрытии игры. Ключи совпадают с app/services/games.py.
const GAMES_IMPL = {};
const gRnd = (n) => Math.floor(Math.random() * n);
const gShuffle = (arr) => { for (let i = arr.length - 1; i > 0; i -= 1) { const j = gRnd(i + 1); [arr[i], arr[j]] = [arr[j], arr[i]]; } return arr; };
const gBtn = 'rounded-xl px-4 py-2.5 text-base font-semibold lc-g-btn select-none';
// Скруглённый прямоугольник (путь), блок с «объёмом» и градиент по вертикали — для игр на холсте
const gRR = (g, x, y, w, h, r) => { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); };
const gVGrad = (g, y0, y1, a, b) => { const gr = g.createLinearGradient(0, y0, 0, y1); gr.addColorStop(0, a); gr.addColorStop(1, b); return gr; };
const gBlock = (g, x, y, w, h, color) => { gRR(g, x, y, w, h, Math.min(6, w / 4)); g.fillStyle = color; g.fill(); g.fillStyle = 'rgba(255,255,255,.34)'; gRR(g, x + 2, y + 2, w - 4, Math.max(3, h / 4), 3); g.fill(); g.fillStyle = 'rgba(0,0,0,.2)'; g.fillRect(x + 2, y + h - 4, w - 4, 2); };

// ---------------------------------------------------------------- Змейка
GAMES_IMPL.snake = (k) => {
  const N = 20, C = 20;
  const { g } = k.canvas(N * C, N * C);
  let snake = [{ x: 10, y: 10 }, { x: 9, y: 10 }, { x: 8, y: 10 }];
  let dir = { x: 1, y: 0 }, queued = { x: 1, y: 0 }, score = 0;
  const free = () => { for (;;) { const p = { x: gRnd(N), y: gRnd(N) }; if (!snake.some((s) => s.x === p.x && s.y === p.y)) return p; } };
  let food = free();
  const draw = () => {
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) { g.fillStyle = (x + y) % 2 ? '#14532d' : '#166534'; g.fillRect(x * C, y * C, C, C); }
    const fx = food.x * C + C / 2, fy = food.y * C + C / 2 + 1;
    g.fillStyle = '#dc2626'; g.beginPath(); g.arc(fx, fy, C / 2 - 3, 0, 7); g.fill();
    g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(fx - 3, fy - 3, 2.5, 0, 7); g.fill();
    g.fillStyle = '#4ade80'; g.beginPath(); g.ellipse(fx + 3, fy - C / 2 + 3, 4, 2, -0.6, 0, 7); g.fill();
    for (let i = snake.length - 1; i >= 0; i -= 1) {
      const s = snake[i], t = i / Math.max(1, snake.length);
      gRR(g, s.x * C + 1, s.y * C + 1, C - 2, C - 2, i === 0 ? 8 : 6); g.fillStyle = i === 0 ? '#bbf7d0' : `hsl(${135 - t * 25} 65% ${52 - t * 14}%)`; g.fill();
    }
    const h = snake[0], ex = h.x * C + C / 2, ey = h.y * C + C / 2, px = -dir.y * 4, py = dir.x * 4;
    g.fillStyle = '#052e16'; [[1, 1], [-1, -1]].forEach(([a]) => { g.beginPath(); g.arc(ex + dir.x * 3 + px * a * 0.8, ey + dir.y * 3 + py * a * 0.8, 2, 0, 7); g.fill(); });
  };
  const turn = (x, y) => { if (x !== -dir.x || y !== -dir.y) queued = { x, y }; };
  k.on(document, 'keydown', (e) => {
    const m = { ArrowUp: [0, -1], ArrowDown: [0, 1], ArrowLeft: [-1, 0], ArrowRight: [1, 0], w: [0, -1], s: [0, 1], a: [-1, 0], d: [1, 0], ц: [0, -1], ы: [0, 1], ф: [-1, 0], в: [1, 0] }[e.key];
    if (m) { e.preventDefault(); turn(m[0], m[1]); }
  });
  k.swipe(k.box, (d) => turn(...{ up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[d]));
  k.status('Яблок: 0');
  k.every(() => {
    dir = queued;
    const h = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
    if (h.x < 0 || h.y < 0 || h.x >= N || h.y >= N || snake.some((s) => s.x === h.x && s.y === h.y)) { draw(); k.over(score, 'Врезались'); return; }
    snake.unshift(h);
    if (h.x === food.x && h.y === food.y) { score += 1; food = free(); k.status('Яблок: ' + score); } else snake.pop();
    draw();
  }, 110);
  draw();
};

// ---------------------------------------------------------------- 2048
GAMES_IMPL.g2048 = (k) => {
  let grid = Array.from({ length: 4 }, () => [0, 0, 0, 0]), score = 0;
  const slideLine = GAMES_IMPL.util.slideLine;
  const at = (i, j, d) => (d === 0 ? [i, j] : d === 2 ? [i, 3 - j] : d === 1 ? [j, i] : [3 - j, i]);   // 0 влево, 1 вверх, 2 вправо, 3 вниз
  const spawn = () => { const e = []; grid.forEach((r, y) => r.forEach((v, x) => { if (!v) e.push([y, x]); })); if (e.length) { const [y, x] = e[gRnd(e.length)]; grid[y][x] = Math.random() < 0.9 ? 2 : 4; } };
  const canMove = () => grid.some((r, y) => r.some((v, x) => !v || (x < 3 && v === r[x + 1]) || (y < 3 && v === grid[y + 1][x])));
  const colors = { 0: '#1e293b', 2: '#475569', 4: '#64748b', 8: '#d97706', 16: '#ea580c', 32: '#dc2626', 64: '#be123c', 128: '#ca8a04', 256: '#a16207', 512: '#15803d', 1024: '#0e7490', 2048: '#7c3aed' };
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; width:min(100%, 360px); aspect-ratio:1; margin:0 auto; padding:8px; border-radius:16px; background:rgba(0,0,0,.3); touch-action:none';
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = grid.flat().map((v) => `<div style="display:grid; place-items:center; border-radius:10px; background:${colors[v] || '#6d28d9'}; color:#f8fafc; font-weight:800; font-size:${v > 999 ? 20 : v > 99 ? 24 : 30}px">${v || ''}</div>`).join('');
    k.status('Очки: ' + score);
  };
  const move = (d) => {
    let moved = false;
    for (let i = 0; i < 4; i += 1) {
      const line = [0, 1, 2, 3].map((j) => { const [y, x] = at(i, j, d); return grid[y][x]; });
      const [res, gained] = slideLine(line);
      score += gained;
      res.forEach((v, j) => { const [y, x] = at(i, j, d); if (grid[y][x] !== v) moved = true; grid[y][x] = v; });
    }
    if (!moved) return;
    spawn(); render();
    if (!canMove()) k.over(score, 'Ходов больше нет');
  };
  k.on(document, 'keydown', (e) => {
    const d = { ArrowLeft: 0, ArrowUp: 1, ArrowRight: 2, ArrowDown: 3, a: 0, w: 1, d: 2, s: 3, ф: 0, ц: 1, в: 2, ы: 3 }[e.key];
    if (d !== undefined) { e.preventDefault(); move(d); }
  });
  k.swipe(k.box, (dd) => move({ left: 0, up: 1, right: 2, down: 3 }[dd]));
  spawn(); spawn(); render();
};

// ---------------------------------------------------------------- Тетрис
GAMES_IMPL.tetris = (k) => {
  const W = 10, H = 20, S = 24;
  const { g } = k.canvas(W * S + 90, H * S);
  const SHAPES = { I: [[1, 1, 1, 1]], O: [[1, 1], [1, 1]], T: [[0, 1, 0], [1, 1, 1]], S: [[0, 1, 1], [1, 1, 0]], Z: [[1, 1, 0], [0, 1, 1]], J: [[1, 0, 0], [1, 1, 1]], L: [[0, 0, 1], [1, 1, 1]] };
  const COLORS = { I: '#22d3ee', O: '#facc15', T: '#a855f7', S: '#22c55e', Z: '#ef4444', J: '#3b82f6', L: '#f97316' };
  const board = Array.from({ length: H }, () => Array(W).fill(null));
  const bag = [];
  const draw7 = () => { if (!bag.length) bag.push(...gShuffle(Object.keys(SHAPES))); return bag.pop(); };
  const make = (t) => ({ t, m: SHAPES[t].map((r) => r.slice()), x: Math.floor((W - SHAPES[t][0].length) / 2), y: 0 });
  let cur = make(draw7()), next = draw7(), score = 0, lines = 0, over = false, acc = 0, last = 0;
  const ok = (m, x, y) => m.every((row, j) => row.every((v, i) => !v || (x + i >= 0 && x + i < W && y + j < H && !(y + j >= 0 && board[y + j][x + i]))));
  const rot = (m) => m[0].map((_, i) => m.map((r) => r[i]).reverse());
  const lock = () => {
    cur.m.forEach((row, j) => row.forEach((v, i) => { if (v && cur.y + j >= 0) board[cur.y + j][cur.x + i] = cur.t; }));
    let cleared = 0;
    for (let y = H - 1; y >= 0; y -= 1) { if (board[y].every(Boolean)) { board.splice(y, 1); board.unshift(Array(W).fill(null)); cleared += 1; y += 1; } }
    if (cleared) { lines += cleared; score += [0, 100, 300, 500, 800][cleared] * (1 + Math.floor(lines / 10)); }
    cur = make(next); next = draw7();
    if (!ok(cur.m, cur.x, cur.y)) { over = true; draw(); k.over(score, 'Стакан заполнен'); }
  };
  const drop = () => { if (ok(cur.m, cur.x, cur.y + 1)) cur.y += 1; else lock(); };
  const act = {
    left: () => { if (ok(cur.m, cur.x - 1, cur.y)) cur.x -= 1; },
    right: () => { if (ok(cur.m, cur.x + 1, cur.y)) cur.x += 1; },
    rotate: () => { const m = rot(cur.m); for (const dx of [0, -1, 1, -2, 2]) { if (ok(m, cur.x + dx, cur.y)) { cur.m = m; cur.x += dx; return; } } },
    soft: () => { drop(); score += 1; },
    hard: () => { let n = 0; while (ok(cur.m, cur.x, cur.y + 1)) { cur.y += 1; n += 1; } score += n * 2; lock(); },
  };
  function draw() {
    g.fillStyle = gVGrad(g, 0, H * S, '#1e1b4b', '#0f172a'); g.fillRect(0, 0, W * S + 90, H * S);
    g.fillStyle = 'rgba(255,255,255,.04)'; g.fillRect(0, 0, W * S, H * S);
    g.strokeStyle = 'rgba(255,255,255,.06)'; for (let i = 0; i <= W; i += 1) { g.beginPath(); g.moveTo(i * S, 0); g.lineTo(i * S, H * S); g.stroke(); }
    for (let i = 0; i <= H; i += 1) { g.beginPath(); g.moveTo(0, i * S); g.lineTo(W * S, i * S); g.stroke(); }
    board.forEach((row, y) => row.forEach((t, x) => { if (t) gBlock(g, x * S + 1, y * S + 1, S - 2, S - 2, COLORS[t]); }));
    let gy = cur.y; while (ok(cur.m, cur.x, gy + 1)) gy += 1;                        // тень: куда упадёт фигура
    cur.m.forEach((row, j) => row.forEach((v, i) => { if (v) { g.strokeStyle = COLORS[cur.t]; g.globalAlpha = 0.35; g.strokeRect((cur.x + i) * S + 2, (gy + j) * S + 2, S - 4, S - 4); g.globalAlpha = 1; } }));
    cur.m.forEach((row, j) => row.forEach((v, i) => { if (v) gBlock(g, (cur.x + i) * S + 1, (cur.y + j) * S + 1, S - 2, S - 2, COLORS[cur.t]); }));
    g.fillStyle = '#c7d2fe'; g.font = 'bold 12px sans-serif'; g.fillText('Дальше', W * S + 14, 22);
    SHAPES[next].forEach((row, j) => row.forEach((v, i) => { if (v) gBlock(g, W * S + 14 + i * 16, 34 + j * 16, 15, 15, COLORS[next]); }));
    g.fillStyle = '#c7d2fe'; g.fillText('Линий: ' + lines, W * S + 14, 120);
  }
  k.on(document, 'keydown', (e) => {
    if (over) return;
    const f = { ArrowLeft: act.left, ArrowRight: act.right, ArrowUp: act.rotate, ArrowDown: act.soft, ' ': act.hard, x: act.rotate, ч: act.rotate, a: act.left, ф: act.left, d: act.right, в: act.right, s: act.soft, ы: act.soft }[e.key];
    if (f) { e.preventDefault(); f(); draw(); k.status('Очки: ' + score); }
  });
  const pad = document.createElement('div');
  pad.style.cssText = 'display:flex; gap:8px; justify-content:center; flex-wrap:wrap; margin-top:10px';
  [['◀', 'left'], ['⟳', 'rotate'], ['▶', 'right'], ['▼', 'soft'], ['⤓', 'hard']].forEach(([label, name]) => {
    const b = document.createElement('button'); b.type = 'button'; b.className = gBtn; b.textContent = label; b.dataset.tetris = name;
    k.on(b, 'click', () => { if (!over) { act[name](); draw(); k.status('Очки: ' + score); } });
    pad.appendChild(b);
  });
  k.box.appendChild(pad);
  k.raf((t) => {
    if (over) return;
    acc += t - (last || t); last = t;
    const interval = Math.max(90, 700 - Math.floor(lines / 10) * 60);
    if (acc >= interval) { acc = 0; drop(); k.status('Очки: ' + score); }
    draw();
  });
  k.status('Очки: 0');
  draw();
};

// ---------------------------------------------------------------- Сапёр
GAMES_IMPL.mines = (k) => {
  const N = 9, MINES = k.difficulty === 'easy' ? 6 : k.difficulty === 'hard' ? 16 : 10;
  let cells = [], started = false, finished = false, flagMode = false, t0 = 0, opened = 0;
  const wrap = document.createElement('div');
  wrap.style.cssText = `display:grid; grid-template-columns:repeat(${N}, 1fr); gap:3px; width:min(100%, 380px); margin:0 auto; touch-action:manipulation`;
  const tool = document.createElement('div');
  tool.style.cssText = 'display:flex; gap:10px; align-items:center; justify-content:center; margin-bottom:10px';
  const flagBtn = document.createElement('button'); flagBtn.type = 'button'; flagBtn.className = gBtn; flagBtn.textContent = '🚩 Флажок: выкл'; flagBtn.dataset.minesFlag = '1';
  tool.appendChild(flagBtn);
  k.box.append(tool, wrap);
  k.on(flagBtn, 'click', () => { flagMode = !flagMode; flagBtn.textContent = '🚩 Флажок: ' + (flagMode ? 'вкл' : 'выкл'); });
  const idx = (x, y) => y * N + x;
  const nb = (x, y) => { const r = []; for (let dy = -1; dy <= 1; dy += 1) for (let dx = -1; dx <= 1; dx += 1) { if ((dx || dy) && x + dx >= 0 && y + dy >= 0 && x + dx < N && y + dy < N) r.push([x + dx, y + dy]); } return r; };
  for (let i = 0; i < N * N; i += 1) cells.push({ mine: false, open: false, flag: false, n: 0 });
  const place = (sx, sy) => {
    const ban = new Set([idx(sx, sy), ...nb(sx, sy).map(([x, y]) => idx(x, y))]);
    const pool = gShuffle([...Array(N * N).keys()].filter((i) => !ban.has(i))).slice(0, MINES);
    pool.forEach((i) => { cells[i].mine = true; });
    for (let y = 0; y < N; y += 1) for (let x = 0; x < N; x += 1) cells[idx(x, y)].n = nb(x, y).filter(([a, b]) => cells[idx(a, b)].mine).length;
  };
  const NUM = ['', '#38bdf8', '#4ade80', '#f87171', '#818cf8', '#fb923c', '#2dd4bf', '#e2e8f0', '#94a3b8'];
  const paint = () => {
    wrap.innerHTML = cells.map((c, i) => {
      const st = c.open ? (c.mine ? 'background:#7f1d1d; box-shadow:none' : 'background:#1e293b; box-shadow:none') : 'background:linear-gradient(160deg,#64748b,#475569)';
      const txt = c.open ? (c.mine ? '💣' : c.n ? `<b style="color:${NUM[c.n]}">${c.n}</b>` : '') : (c.flag ? '🚩' : '');
      return `<button type="button" data-cell="${i}" class="lc-g-tile" style="aspect-ratio:1; border-radius:6px; font-size:18px; ${st}">${txt}</button>`;
    }).join('');
    const flags = cells.filter((c) => c.flag).length;
    k.status(`Мины: ${MINES - flags}${started ? ' · время: ' + Math.floor((Date.now() - t0) / 1000) + ' с' : ''}`);
  };
  const reveal = (x, y) => {
    const stack = [[x, y]];
    while (stack.length) {
      const [cx, cy] = stack.pop(); const c = cells[idx(cx, cy)];
      if (c.open || c.flag) continue;
      c.open = true; opened += 1;
      if (!c.mine && c.n === 0) nb(cx, cy).forEach((p) => stack.push(p));
    }
  };
  const press = (i, flag) => {
    if (finished) return;
    const x = i % N, y = Math.floor(i / N), c = cells[i];
    if (flag) { if (!c.open) c.flag = !c.flag; paint(); return; }
    if (c.open || c.flag) return;
    if (!started) { place(x, y); started = true; t0 = Date.now(); }
    if (c.mine) { finished = true; cells.forEach((q) => { if (q.mine) q.open = true; }); paint(); k.over(null, 'Подорвались на мине'); return; }
    reveal(x, y); paint();
    if (opened === N * N - MINES) { finished = true; const sec = Math.max(1, (Date.now() - t0) / 1000); k.over(Math.round(sec * 10) / 10, 'Поле разминировано'); }
  };
  let held = null;
  k.on(wrap, 'click', (e) => { const b = e.target.closest('[data-cell]'); if (b && !held) press(+b.dataset.cell, flagMode); held = null; });
  k.on(wrap, 'contextmenu', (e) => { const b = e.target.closest('[data-cell]'); if (b) { e.preventDefault(); press(+b.dataset.cell, true); } });
  k.on(wrap, 'touchstart', (e) => { const b = e.target.closest('[data-cell]'); if (b) held = setTimeout(() => { press(+b.dataset.cell, true); held = 'done'; }, 450); }, { passive: true });
  k.on(wrap, 'touchend', () => {
    if (held === 'done') k.after(() => { held = null; }, 350);          // после долгого нажатия браузер может не прислать click — сбрасываем сами
    else if (held) { clearTimeout(held); held = null; }
  });
  k.every(() => { if (started && !finished) paint(); }, 1000);
  paint();
};

// ---------------------------------------------------------------- Память
GAMES_IMPL.memory = (k) => {
  const faces = gShuffle(['📷', '📡', '🔌', '🔋', '🛰️', '🧰', '🔧', '💡']);
  const deck = gShuffle([...faces, ...faces]);
  let open = [], moves = 0, matched = 0, lock = false;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid; grid-template-columns:repeat(4, 1fr); gap:8px; width:min(100%, 360px); margin:0 auto';
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = deck.map((f, i) => {
      const shown = open.includes(i) || deck[i] === null;
      return `<button type="button" data-card="${i}" class="lc-g-tile" style="aspect-ratio:1; font-size:30px; background:${deck[i] === null ? 'linear-gradient(160deg,#16a34a,#14532d)' : shown ? 'linear-gradient(160deg,#475569,#1e293b)' : 'linear-gradient(160deg,#818cf8,#4338ca)'}; opacity:${deck[i] === null ? '.55' : '1'}">${shown ? (deck[i] === null ? '✓' : f) : '?'}</button>`;
    }).join('');
    k.status('Ходов: ' + moves);
  };
  const faceOf = deck.slice();
  k.on(wrap, 'click', (e) => {
    const b = e.target.closest('[data-card]'); if (!b || lock) return;
    const i = +b.dataset.card;
    if (open.includes(i) || deck[i] === null) return;
    open.push(i);
    if (open.length === 2) {
      moves += 1; lock = true;
      const [a, c] = open;
      render();
      k.after(() => {
        if (faceOf[a] === faceOf[c]) { deck[a] = null; deck[c] = null; matched += 1; }
        open = []; lock = false; render();
        if (matched === 8) k.over(moves, 'Все пары найдены');
      }, 650);
      return;
    }
    render();
  });
  render();
};

// ---------------------------------------------------------------- Крестики-нолики
GAMES_IMPL.tictactoe = (k) => {
  const U = GAMES_IMPL.util;
  let b = Array(9).fill(''), score = 0, busy = false, round = 1;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid; grid-template-columns:repeat(3, 1fr); gap:8px; width:min(100%, 300px); margin:0 auto';
  const msg = document.createElement('p'); msg.style.cssText = 'text-align:center; margin-top:10px; min-height:1.5em'; msg.className = 'lc-g-text text-sm';
  k.box.append(wrap, msg);
  const render = () => {
    wrap.innerHTML = b.map((v, i) => `<button type="button" data-ttt="${i}" class="lc-g-tile" style="aspect-ratio:1; font-size:44px; background:linear-gradient(160deg,#475569,#1e293b); color:${v === 'X' ? '#38bdf8' : '#f472b6'}">${v}</button>`).join('');
    k.status(`Раунд ${round} · очков: ${score}`);
  };
  const finish = (res) => {
    busy = true;
    if (res === 'X') { score += 3; msg.textContent = 'Вы выиграли! +3'; } else if (res === 'draw') { score += 1; msg.textContent = 'Ничья, +1'; }
    else { msg.textContent = 'Компьютер выиграл'; render(); k.over(score, 'Серия закончена'); return; }
    render();
    k.after(() => { b = Array(9).fill(''); round += 1; msg.textContent = ''; busy = false; if (round % 2 === 0) aiMove(); render(); }, 900);
  };
  const aiMove = () => {
    const free = b.map((v, i) => (v ? -1 : i)).filter((i) => i >= 0);
    const i = Math.random() < 0.3 ? free[gRnd(free.length)] : U.bestMove(b, 'O');
    b[i] = 'O';
  };
  k.on(wrap, 'click', (e) => {
    const t = e.target.closest('[data-ttt]'); if (!t || busy) return;
    const i = +t.dataset.ttt; if (b[i]) return;
    b[i] = 'X'; render();
    let r = U.winner(b); if (r) { finish(r); return; }
    aiMove(); render();
    r = U.winner(b); if (r) finish(r);
  });
  render();
};

// ---------------------------------------------------------------- Арканоид
GAMES_IMPL.breakout = (k) => {
  const W = 480, H = 360;
  const { cv, g } = k.canvas(W, H);
  let paddle = { x: W / 2 - 38, w: 76 }, ball = { x: W / 2, y: H - 40, vx: 3, vy: -3.4, r: 6 }, bricks = [], score = 0, lives = 3, level = 1, left = false, right = false, last = 0;
  const build = () => { bricks = []; for (let r = 0; r < 5; r += 1) for (let c = 0; c < 10; c += 1) bricks.push({ x: 12 + c * 46, y: 36 + r * 20, w: 42, h: 16, hue: 200 + r * 30, alive: true }); };
  const reset = () => { ball = { x: paddle.x + paddle.w / 2, y: H - 40, vx: (Math.random() < 0.5 ? -1 : 1) * (2.6 + level * 0.3), vy: -(3.2 + level * 0.35), r: 6 }; };
  build();
  const pointer = (clientX) => { const rect = cv.getBoundingClientRect(); paddle.x = Math.max(0, Math.min(W - paddle.w, ((clientX - rect.left) / rect.width) * W - paddle.w / 2)); };
  k.on(cv, 'mousemove', (e) => pointer(e.clientX));
  k.on(cv, 'touchmove', (e) => { e.preventDefault(); pointer(e.touches[0].clientX); }, { passive: false });
  k.on(cv, 'touchstart', (e) => pointer(e.touches[0].clientX), { passive: true });
  k.on(document, 'keydown', (e) => { if (e.key === 'ArrowLeft') { left = true; e.preventDefault(); } if (e.key === 'ArrowRight') { right = true; e.preventDefault(); } });
  k.on(document, 'keyup', (e) => { if (e.key === 'ArrowLeft') left = false; if (e.key === 'ArrowRight') right = false; });
  const draw = () => {
    g.fillStyle = gVGrad(g, 0, H, '#172554', '#0f172a'); g.fillRect(0, 0, W, H);
    bricks.forEach((b) => { if (b.alive) gBlock(g, b.x, b.y, b.w, b.h, `hsl(${b.hue} 72% 54%)`); });
    gRR(g, paddle.x, H - 20, paddle.w, 10, 5); g.fillStyle = gVGrad(g, H - 20, H - 10, '#f8fafc', '#94a3b8'); g.fill();
    g.save(); g.shadowColor = '#facc15'; g.shadowBlur = 14; g.beginPath(); g.arc(ball.x, ball.y, ball.r, 0, 7); g.fillStyle = '#fde047'; g.fill(); g.restore();
  };
  k.raf((t) => {
    const dt = Math.min(2.2, (t - (last || t)) / 16.7); last = t;
    if (left) paddle.x = Math.max(0, paddle.x - 7 * dt);
    if (right) paddle.x = Math.min(W - paddle.w, paddle.x + 7 * dt);
    ball.x += ball.vx * dt; ball.y += ball.vy * dt;
    if (ball.x < ball.r || ball.x > W - ball.r) { ball.vx *= -1; ball.x = Math.max(ball.r, Math.min(W - ball.r, ball.x)); }
    if (ball.y < ball.r) { ball.vy = Math.abs(ball.vy); }
    if (ball.y > H - 20 - ball.r && ball.y < H - 10 && ball.x > paddle.x - 4 && ball.x < paddle.x + paddle.w + 4 && ball.vy > 0) {
      const rel = (ball.x - (paddle.x + paddle.w / 2)) / (paddle.w / 2);
      const sp = Math.hypot(ball.vx, ball.vy);
      ball.vx = rel * sp * 0.8; ball.vy = -Math.sqrt(Math.max(1, sp * sp - ball.vx * ball.vx));
    }
    for (const b of bricks) {
      if (b.alive && ball.x > b.x - ball.r && ball.x < b.x + b.w + ball.r && ball.y > b.y - ball.r && ball.y < b.y + b.h + ball.r) { b.alive = false; ball.vy *= -1; score += 10; break; }
    }
    if (!bricks.some((b) => b.alive)) { level += 1; score += 50; build(); reset(); }
    if (ball.y > H + 10) { lives -= 1; if (lives <= 0) { draw(); k.over(score, 'Мячи закончились'); return; } reset(); }
    draw();
    k.status(`Очки: ${score} · жизней: ${lives} · уровень ${level}`);
  });
  draw();
};

// ---------------------------------------------------------------- Летающая камера
GAMES_IMPL.flappy = (k) => {
  const W = 320, H = 480;
  const { cv, g } = k.canvas(W, H);
  let y = H / 2, vy = 0, pipes = [], frame = 0, score = 0, started = false, last = 0, acc = 0;
  const flap = () => { started = true; vy = -7.2; };
  k.on(document, 'keydown', (e) => { if (e.key === ' ' || e.key === 'ArrowUp') { e.preventDefault(); flap(); } });
  k.on(cv, 'pointerdown', (e) => { e.preventDefault(); flap(); });
  const draw = () => {
    g.fillStyle = gVGrad(g, 0, H, '#38bdf8', '#e0f2fe'); g.fillRect(0, 0, W, H);
    g.fillStyle = 'rgba(255,255,255,.85)'; [[60, 80], [200, 150], [280, 60]].forEach(([cx, cy]) => { const x = ((cx - frame * 0.4) % (W + 90) + W + 90) % (W + 90) - 45; g.beginPath(); g.ellipse(x, cy, 34, 13, 0, 0, 7); g.ellipse(x + 20, cy - 8, 20, 12, 0, 0, 7); g.fill(); });
    pipes.forEach((p) => {
      const body = (x, y0, h) => { const gr = g.createLinearGradient(x, 0, x + 46, 0); gr.addColorStop(0, '#4ade80'); gr.addColorStop(0.5, '#22c55e'); gr.addColorStop(1, '#15803d'); g.fillStyle = gr; g.fillRect(x, y0, 46, h); };
      body(p.x, 0, p.top); body(p.x, p.top + 140, H - p.top - 140);
      [[p.top - 22, 22], [p.top + 140, 22]].forEach(([cy, ch]) => { const gr = g.createLinearGradient(p.x - 4, 0, p.x + 50, 0); gr.addColorStop(0, '#86efac'); gr.addColorStop(0.5, '#22c55e'); gr.addColorStop(1, '#166534'); g.fillStyle = gr; gRR(g, p.x - 4, cy, 54, ch, 5); g.fill(); });
    });
    g.fillStyle = '#65a30d'; g.fillRect(0, H - 14, W, 6); g.fillStyle = '#854d0e'; g.fillRect(0, H - 8, W, 8);
    g.save(); g.translate(80, y); g.rotate(Math.max(-0.5, Math.min(0.9, vy * 0.07))); g.font = '32px sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'center'; g.fillText('📷', 0, 0); g.restore();
    g.textBaseline = 'middle'; g.textAlign = 'center';
    if (!started) { g.fillStyle = '#f8fafc'; g.font = '16px sans-serif'; g.fillText('Пробел или касание — лететь', W / 2, H / 2 + 60); }
  };
  k.raf((t) => {
    acc += Math.min(50, t - (last || t)); last = t;
    while (acc >= 16.7) {
      acc -= 16.7;
      if (!started) continue;
      vy += 0.42; y += vy; frame += 1;
      if (frame % 95 === 0) pipes.push({ x: W, top: 60 + gRnd(H - 260), passed: false });
      pipes.forEach((p) => { p.x -= 2.6; if (!p.passed && p.x + 46 < 80 - 14) { p.passed = true; score += 1; } });
      pipes = pipes.filter((p) => p.x > -60);
      const hit = y < 12 || y > H - 28 || pipes.some((p) => 80 + 13 > p.x && 80 - 13 < p.x + 46 && (y - 13 < p.top || y + 13 > p.top + 140));
      if (hit) { draw(); k.over(score, 'Столкнулись'); return; }
    }
    draw();
    k.status('Столбов: ' + score);
  });
  draw();
  k.status('Столбов: 0');
};

// ---------------------------------------------------------------- Реакция
GAMES_IMPL.reaction = (k) => {
  const ROUNDS = 5;
  let round = 0, times = [], phase = 'idle', t0 = 0, timer = null;
  const pad = document.createElement('button');
  pad.type = 'button'; pad.dataset.reaction = '1';
  pad.style.cssText = 'display:grid; place-items:center; width:min(100%, 420px); height:240px; margin:0 auto; border:0; border-radius:22px; font-size:22px; font-weight:800; color:#f8fafc; cursor:pointer; user-select:none; box-shadow:inset 0 -6px 0 rgba(0,0,0,.25), 0 10px 24px -10px rgba(0,0,0,.7)';
  k.box.appendChild(pad);
  const paint = (bg, text) => { pad.style.background = bg; pad.textContent = text; };
  const arm = () => {
    phase = 'wait'; paint('#b91c1c', `Раунд ${round + 1} из ${ROUNDS}: ждите зелёного…`);
    timer = k.after(() => { phase = 'go'; t0 = performance.now(); paint('#16a34a', 'ЖМИТЕ!'); }, 1000 + gRnd(3000));
  };
  const click = () => {
    if (phase === 'idle') { arm(); return; }
    if (phase === 'wait') { clearTimeout(timer); paint('#a16207', 'Слишком рано! Нажмите, чтобы повторить раунд'); phase = 'idle'; return; }
    if (phase === 'go') {
      const ms = Math.round(performance.now() - t0); times.push(ms); round += 1;
      if (round >= ROUNDS) { const avg = Math.round(times.reduce((a, b) => a + b, 0) / ROUNDS); phase = 'done'; paint('#334155', `Среднее: ${avg} мс`); k.over(avg, `Времена: ${times.join(', ')} мс`); return; }
      phase = 'idle'; paint('#1d4ed8', `${ms} мс. Нажмите для следующего раунда`);
    }
  };
  k.on(pad, 'pointerdown', (e) => { e.preventDefault(); click(); });
  k.on(document, 'keydown', (e) => { if (e.key === ' ') { e.preventDefault(); click(); } });
  paint('#1d4ed8', `Нажмите, чтобы начать (${ROUNDS} раундов)`);
  k.status('Чем меньше, тем лучше');
};

// ---------------------------------------------------------------- Быстрый счёт
GAMES_IMPL.math = (k) => {
  let correct = 0, wrong = 0, left = k.difficulty === 'easy' ? 45 : k.difficulty === 'hard' ? 20 : 30, q = null;
  const box = document.createElement('div');
  box.style.cssText = 'display:grid; gap:12px; justify-items:center';
  const qEl = document.createElement('div'); qEl.style.cssText = 'font-size:40px; font-weight:800'; qEl.dataset.mathQ = '1';
  const inp = document.createElement('input'); inp.type = 'text'; inp.inputMode = 'numeric'; inp.autocomplete = 'off'; inp.dataset.mathA = '1';
  inp.style.cssText = 'width:min(100%, 220px); text-align:center; font-size:30px; padding:8px 12px; border-radius:12px'; inp.className = 'accent-ring';
  const ok = document.createElement('button'); ok.type = 'button'; ok.className = gBtn; ok.textContent = 'Ответить';
  box.append(qEl, inp, ok); k.box.appendChild(box);
  const next = () => {
    const kind = gRnd(k.difficulty === 'easy' ? 2 : 3), cap = k.difficulty === 'hard' ? 80 : 40;
    const a = 2 + gRnd(kind === 2 ? (k.difficulty === 'hard' ? 20 : 11) : cap), b = 2 + gRnd(kind === 2 ? (k.difficulty === 'hard' ? 20 : 11) : cap);
    q = kind === 0 ? { t: `${a} + ${b}`, r: a + b } : kind === 1 ? { t: `${Math.max(a, b)} − ${Math.min(a, b)}`, r: Math.abs(a - b) } : { t: `${a} × ${b}`, r: a * b };
    qEl.textContent = q.t + ' = ?'; inp.value = ''; inp.focus();
  };
  const submit = () => {
    if (!q) return;
    const v = parseInt(inp.value.replace(/\s+/g, ''), 10);
    if (Number.isNaN(v)) return;
    if (v === q.r) correct += 1; else wrong += 1;
    next(); k.status(`Верно: ${correct} · ошибок: ${wrong} · осталось ${left} с`);
  };
  k.on(inp, 'keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
  k.on(ok, 'click', submit);
  k.every(() => {
    left -= 1; k.status(`Верно: ${correct} · ошибок: ${wrong} · осталось ${left} с`);
    if (left <= 0) { inp.disabled = true; k.over(correct, `Ошибок: ${wrong}`); }
  }, 1000);
  next();
  k.status(`Верно: 0 · ошибок: 0 · осталось ${left} с`);
};

// ---------------------------------------------------------------- Сбой на комплексе
GAMES_IMPL.whack = (k) => {
  let score = 0, misses = 0, left = 30, active = -1, hideTimer = null;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:grid; grid-template-columns:repeat(3, 1fr); gap:10px; width:min(100%, 330px); margin:0 auto';
  k.box.appendChild(wrap);
  const render = () => {
    wrap.innerHTML = Array.from({ length: 9 }, (_, i) => `<button type="button" data-whack="${i}" class="lc-g-tile" style="aspect-ratio:1; font-size:36px; background:${i === active ? 'linear-gradient(160deg,#ef4444,#991b1b)' : 'linear-gradient(160deg,#475569,#1e293b)'}; ${i === active ? 'box-shadow:0 0 22px rgba(239,68,68,.85); transform:scale(1.06)' : ''}">${i === active ? '🔴' : '📷'}</button>`).join('');
    k.status(`Попаданий: ${score} · промахов: ${misses} · осталось ${left} с`);
  };
  const pop = () => {
    active = gRnd(9); render();
    clearTimeout(hideTimer);
    hideTimer = k.after(() => { active = -1; render(); }, 650 + gRnd(300));
  };
  k.on(wrap, 'pointerdown', (e) => {
    const b = e.target.closest('[data-whack]'); if (!b) return;
    e.preventDefault();
    if (+b.dataset.whack === active) { score += 1; active = -1; } else misses += 1;
    render();
  });
  k.every(pop, 1000);
  k.every(() => { left -= 1; render(); if (left <= 0) k.over(score, `Промахов: ${misses}`); }, 1000);
  render();
};

// ---------------------------------------------------------------- общие чистые помощники (их же проверяют тесты)
GAMES_IMPL.util = {
  // Сдвиг одной строки 2048 влево со слиянием: возвращает [новая строка, набранные очки].
  slideLine(line) {
    const a = line.filter((v) => v);
    let gained = 0;
    for (let i = 0; i < a.length - 1; i += 1) { if (a[i] === a[i + 1]) { a[i] *= 2; gained += a[i]; a.splice(i + 1, 1); } }
    while (a.length < 4) a.push(0);
    return [a, gained];
  },
  // Победитель на поле 3×3: 'X' / 'O' / 'draw' / null (игра идёт).
  winner(b) {
    const L = [[0, 1, 2], [3, 4, 5], [6, 7, 8], [0, 3, 6], [1, 4, 7], [2, 5, 8], [0, 4, 8], [2, 4, 6]];
    for (const [x, y, z] of L) { if (b[x] && b[x] === b[y] && b[y] === b[z]) return b[x]; }
    return b.every(Boolean) ? 'draw' : null;
  },
  // Лучший ход для `me` (минимакс): индекс свободной клетки.
  bestMove(b, me) {
    const other = me === 'X' ? 'O' : 'X', U = GAMES_IMPL.util;
    const score = (board, turn) => {
      const w = U.winner(board);
      if (w === me) return 1; if (w === other) return -1; if (w === 'draw') return 0;
      let best = turn === me ? -2 : 2;
      board.forEach((v, i) => {
        if (v) return;
        board[i] = turn; const s = score(board, turn === me ? other : me); board[i] = '';
        best = turn === me ? Math.max(best, s) : Math.min(best, s);
      });
      return best;
    };
    let pick = -1, top = -2;
    b.forEach((v, i) => { if (v) return; b[i] = me; const s = score(b, other); b[i] = ''; if (s > top) { top = s; pick = i; } });
    return pick;
  },
};
