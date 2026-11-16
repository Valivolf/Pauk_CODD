// Праздничное и сезонное оформление: Новый год, Хэллоуин, 14 февраля, 23 Февраля, 8 Марта, 9 Мая (салют), Листопад, Конфетти.
// По умолчанию ВЫКЛЮЧЕНО. Включается в меню темы (🌙/☀ → «Фон и анимации» → «Праздники») — отдельно у каждого сотрудника, в его браузере:
//   «Выключено» · «По датам» (само показывает праздник заранее и в его дни: Новый год 01.12–10.01, Хэллоуин 15.10–01.11, 14 февраля 10–14.02,
//   23 Февраля 18–23.02, 8 Марта 05–08.03, 9 Мая 05–09.05, Листопад 15.09–24.10 и 02.11–25.11) · конкретный праздник на любые даты.
// Это только украшения: один <canvas> поверх страницы, но под окнами и меню (z-index 15), pointer-events: none — кликам не мешает.
// Лёгкая нагрузка: статичные украшения (гирлянда, ёлка, паутина…) рисуются один раз, в кадре — только движущееся, 20–30 кадров в секунду,
// на скрытой вкладке ничего не считается; «Эффекты: Выкл» и системное «уменьшить движение» (меню темы / настройки системы) отключают всё.
(function () {
  'use strict';
  const root = document.documentElement;
  const KEY = 'lcSeason';
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* не страшно */ } },
  };
  const TAU = Math.PI * 2;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];
  const isLight = () => root.getAttribute('data-theme') === 'light';
  let testDate = null;
  const nowDate = () => (testDate ? new Date(testDate) : new Date());

  // Окна дат для режима «По датам»: [месяц начала, день начала, месяц конца, день конца], включительно; окно может переходить через год.
  const EVENTS = [
    // Новый год и Хэллоуин включаются заранее — за месяц и за две недели: украшения, которые появляются в один день, никто не успевает заметить.
    { id: 'newyear', label: '🎄 Новый год', when: [[12, 1, 1, 10]] },
    { id: 'halloween', label: '🎃 Хэллоуин', when: [[10, 15, 11, 1]] },
    { id: 'valentine', label: '❤️ 14 февраля', when: [[2, 10, 2, 14]] },
    { id: 'feb23', label: '🎖 23 Февраля', when: [[2, 18, 2, 23]] },
    { id: 'march8', label: '🌸 8 Марта', when: [[3, 5, 3, 8]] },
    { id: 'victory', label: '🎆 9 Мая — салют', when: [[5, 5, 5, 9]] },
    { id: 'autumn', label: '🍂 Листопад', when: [[9, 15, 10, 24], [11, 2, 11, 25]] },
    { id: 'confetti', label: '🎉 Конфетти', when: [] },
  ];
  const inWindow = (md, w) => { const a = w[0] * 100 + w[1], b = w[2] * 100 + w[3]; return a <= b ? (md >= a && md <= b) : (md >= a || md <= b); };
  function eventForDate(d) {
    const md = (d.getMonth() + 1) * 100 + d.getDate();
    const e = EVENTS.find((x) => x.when.some((w) => inWindow(md, w)));
    return e ? e.id : null;
  }
  function activeId() {
    const pref = store.get(KEY, 'off');
    if (pref === 'off') return null;
    if (pref === 'auto') return eventForDate(nowDate());
    return EVENTS.some((e) => e.id === pref) ? pref : null;
  }
  const levelNow = () => root.getAttribute('data-fx') || 'full';
  // Звуки праздника (static/js/sounds.js) — по желанию; здесь только вызовы «если звук подключён и включён».
  const sfx = (kind) => { try { if (window.LCSound) window.LCSound.fx(kind); } catch (e) { /* звук не обязателен */ } };

  // ---------- холст ----------
  let cv = null, ctx = null, stat = null, W = 0, H = 0, dpr = 1, raf = 0, lastT = 0, cur = null, lite = false, light = false, st = null;

  function sprite(w, h, draw) {
    const c = document.createElement('canvas');
    c.width = Math.ceil(w * dpr); c.height = Math.ceil(h * dpr);
    c.cw = w; c.ch = h;
    const g = c.getContext('2d');
    g.scale(dpr, dpr);
    draw(g, w, h);
    return c;
  }
  // Один спрайт в кадре: центр (x, y), масштаб, поворот, «переворот» (кувырок вокруг горизонтальной оси), прозрачность.
  function put(img, x, y, scale, rot, flip, alpha, mirror) {
    ctx.save();
    ctx.globalAlpha = alpha == null ? 1 : alpha;
    ctx.translate(x, y); if (rot) ctx.rotate(rot); ctx.scale(scale * (mirror || 1), scale * (flip == null ? 1 : flip));
    ctx.drawImage(img, -img.cw / 2, -img.ch / 2, img.cw, img.ch);
    ctx.restore();
  }
  function poly(g, pts) { g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath(); }
  function glow(x, y, r, rgb, a, comp) {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(${rgb},${a})`); g.addColorStop(1, `rgba(${rgb},0)`);
    ctx.globalCompositeOperation = comp || 'source-over';
    ctx.fillStyle = g; ctx.fillRect(x - r, y - r, r * 2, r * 2);
    ctx.globalCompositeOperation = 'source-over';
  }

  // Падающие/летящие частицы одного рода: спрайты, раскачивание, вращение, кувырок.
  function fallers(n, imgs, o) {
    const out = [];
    for (let i = 0; i < n; i++) {
      out.push({ img: imgs[i % imgs.length], x: rnd(0, W), y: rnd(-40, H), size: rnd(o.size[0], o.size[1]), v: rnd(o.v[0], o.v[1]) * (o.dir || 1),
        sway: rnd(o.sway[0], o.sway[1]), ph: rnd(0, TAU), sp: rnd(0.5, 1.4), rot: rnd(0, TAU), vr: rnd(-o.spin, o.spin), tilt: rnd(0, TAU), tv: rnd(0.8, 2.4), a: rnd(o.alpha[0], o.alpha[1]), pulse: rnd(0, TAU) });
    }
    return out;
  }
  function stepFallers(list, dt, t, o) {
    const dir = o.dir || 1;
    for (const f of list) {
      f.y += f.v * dt; f.ph += dt * f.sp; f.x += Math.sin(f.ph) * f.sway * dt; f.rot += f.vr * dt; f.tilt += f.tv * dt;
      if (dir > 0 ? f.y > H + 40 : f.y < -40) { f.y = dir > 0 ? -40 : H + 40; f.x = rnd(0, W); }
      const flip = o.flat ? 1 : 0.35 + 0.65 * Math.abs(Math.cos(f.tilt));
      const pul = o.pulse ? 1 + 0.07 * Math.sin(t / 380 + f.pulse) : 1;
      put(f.img, f.x, f.y, (f.size / f.img.cw) * pul, f.rot, flip, f.a);
    }
  }

  // ---------- Хэллоуин ----------
  function drawBat(g, flap) {
    const body = light ? '#3a2a5e' : '#8d6fd1', edge = light ? 'rgba(20,10,50,.7)' : 'rgba(214,196,255,.75)';
    g.fillStyle = body; g.strokeStyle = edge; g.lineWidth = 1.2; g.lineJoin = 'round';
    for (const side of [1, -1]) {                                // правое и левое крыло
      g.save(); g.translate(28, 0); g.scale(side, 1); g.translate(-28, 0);
      const tip = 15 - flap * 11;
      g.beginPath(); g.moveTo(31, 17); g.quadraticCurveTo(42, tip - 6, 55, tip); g.quadraticCurveTo(51, tip + 5, 50, tip + 10);
      g.quadraticCurveTo(46, tip + 7, 43, tip + 11); g.quadraticCurveTo(40, tip + 8, 35, tip + 14); g.quadraticCurveTo(33, 24, 31, 24); g.closePath(); g.fill(); g.stroke();
      g.restore();
    }
    g.beginPath(); g.ellipse(28, 21, 5.2, 8.2, 0, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.arc(28, 12.5, 4.6, 0, TAU); g.fill(); g.stroke();
    g.beginPath(); g.moveTo(24, 10); g.lineTo(25, 3); g.lineTo(27.6, 8.5); g.moveTo(32, 10); g.lineTo(31, 3); g.lineTo(28.4, 8.5); g.fill();
    g.fillStyle = '#ffb340'; g.beginPath(); g.arc(26.4, 12.4, 1, 0, TAU); g.arc(29.6, 12.4, 1, 0, TAU); g.fill();
  }
  function drawGhost(g) {
    g.fillStyle = light ? 'rgba(140,150,215,.62)' : 'rgba(238,242,255,.82)'; g.strokeStyle = light ? 'rgba(70,80,160,.6)' : 'rgba(255,255,255,.55)'; g.lineWidth = 1.2;
    g.beginPath(); g.moveTo(5, 24); g.arc(20, 20, 15, Math.PI, 0); g.lineTo(35, 50); g.quadraticCurveTo(31, 44, 28, 50); g.quadraticCurveTo(24, 44, 20, 50);
    g.quadraticCurveTo(16, 44, 12, 50); g.quadraticCurveTo(9, 44, 5, 50); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#2b2350'; g.beginPath(); g.ellipse(14.5, 21, 2.4, 3.4, 0, 0, TAU); g.ellipse(25.5, 21, 2.4, 3.4, 0, 0, TAU); g.fill();
    g.beginPath(); g.ellipse(20, 31, 3.2, 4.2, 0, 0, TAU); g.fill();
  }
  function drawPumpkin(g) {
    const grad = g.createRadialGradient(27, 22, 4, 27, 28, 26);
    grad.addColorStop(0, '#ffa733'); grad.addColorStop(1, '#d9560b');
    g.fillStyle = grad; g.strokeStyle = '#9a3a05'; g.lineWidth = 1.4;
    for (const [cx, rx] of [[14, 11], [40, 11], [20, 14], [34, 14], [27, 15]]) { g.beginPath(); g.ellipse(cx, 29, rx, 16.5, 0, 0, TAU); g.fill(); g.stroke(); }
    g.fillStyle = '#4f7a2a'; g.strokeStyle = '#2f4d17'; g.beginPath(); g.moveTo(24, 14); g.quadraticCurveTo(25, 6, 30, 5); g.lineTo(32, 8); g.quadraticCurveTo(29, 10, 30, 14); g.closePath(); g.fill(); g.stroke();
    g.fillStyle = '#ffe27a'; poly(g, [[17, 26], [23, 26], [20, 20]]); g.fill(); poly(g, [[31, 26], [37, 26], [34, 20]]); g.fill();
    g.beginPath(); g.moveTo(17, 34); g.lineTo(21, 38); g.lineTo(24, 34); g.lineTo(27, 38); g.lineTo(30, 34); g.lineTo(33, 38); g.lineTo(37, 34); g.lineTo(34, 42); g.lineTo(20, 42); g.closePath(); g.fill();
  }
  function drawWeb(g, mirror) {
    g.save(); if (mirror) { g.translate(W, 0); g.scale(-1, 1); }
    g.strokeStyle = light ? 'rgba(60,60,90,.55)' : 'rgba(255,255,255,.4)'; g.lineWidth = 1;
    const L = Math.min(150, W * 0.2), n = 6;
    for (let i = 0; i <= n; i++) { const a = (Math.PI / 2) * (i / n); g.beginPath(); g.moveTo(0, 0); g.lineTo(Math.cos(a) * L, Math.sin(a) * L); g.stroke(); }
    for (let r = 1; r <= 5; r++) {
      const R = (L * r) / 5; g.beginPath();
      for (let i = 0; i <= n; i++) {
        const a = (Math.PI / 2) * (i / n), x = Math.cos(a) * R, y = Math.sin(a) * R;
        if (!i) { g.moveTo(x, y); continue; }
        const pa = (Math.PI / 2) * ((i - 0.5) / n); g.quadraticCurveTo(Math.cos(pa) * R * 0.86, Math.sin(pa) * R * 0.86, x, y);
      }
      g.stroke();
    }
    g.restore();
  }
  const EFFECTS = {};
  EFFECTS.halloween = {
    statics(g) {
      drawWeb(g, false); drawWeb(g, true);
      const gl = g.createLinearGradient(0, H * 0.65, 0, H);
      gl.addColorStop(0, 'rgba(255,120,20,0)'); gl.addColorStop(1, light ? 'rgba(255,120,20,.16)' : 'rgba(255,120,20,.2)');
      g.fillStyle = gl; g.fillRect(0, H * 0.65, W, H * 0.35);
    },
    setup(k) {
      const flaps = [1, 0.35, -0.5, 0.35];
      st.bats = flaps.map((f) => sprite(56, 34, (g) => drawBat(g, f)));
      st.ghost = sprite(40, 52, drawGhost);
      st.pumpkin = sprite(54, 48, drawPumpkin);
      st.fl = Array.from({ length: Math.round(6 * k) }, () => ({ x: rnd(0, W), base: rnd(H * 0.08, H * 0.6), amp: rnd(14, 50), ph: rnd(0, TAU), v: rnd(46, 100) * (Math.random() < 0.5 ? -1 : 1), s: rnd(0.8, 1.3), o: rnd(0, 4) }));
      st.gh = fallers(Math.round(3 * k) + 1, [st.ghost], { size: [34, 56], v: [12, 26], sway: [14, 34], spin: 0.15, alpha: [0.3, 0.55], dir: -1, flat: true });
      st.sp = { x: Math.min(86, W * 0.1), ph: rnd(0, 6) };
    },
    frame(t, dt) {
      stepFallers(st.gh, dt, t, { dir: -1, flat: true });
      for (const b of st.fl) {
        b.x += b.v * dt; b.ph += dt * 2.2;
        if (b.v > 0 && b.x > W + 40) b.x = -40; else if (b.v < 0 && b.x < -40) b.x = W + 40;
        const y = b.base + Math.sin(b.ph) * b.amp, fi = Math.floor(t / 110 + b.o) % 4;
        put(st.bats[fi], b.x, y, b.s, Math.sin(b.ph) * 0.12, 1, 0.95);
      }
      // паук на нити у левой паутины
      const len = 40 + (0.5 + 0.5 * Math.sin(t / 1900 + st.sp.ph)) * 60, sx = st.sp.x;
      ctx.strokeStyle = light ? 'rgba(40,40,70,.7)' : 'rgba(255,255,255,.55)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(sx, 0); ctx.lineTo(sx, len); ctx.stroke();
      ctx.fillStyle = light ? '#2a2540' : '#c9bbf0'; ctx.beginPath(); ctx.arc(sx, len + 5, 4.5, 0, TAU); ctx.arc(sx, len, 2.6, 0, TAU); ctx.fill();
      ctx.strokeStyle = ctx.fillStyle; ctx.beginPath();
      for (const s of [-1, 1]) for (let i = 0; i < 4; i++) { const y = len + 1 + i * 2.6; ctx.moveTo(sx, y + 2); ctx.lineTo(sx + s * (7 + i), y + (i < 2 ? -3 : 3)); }
      ctx.stroke();
      // тыквы в правом нижнем углу, огонёк внутри мерцает
      const fl = 0.75 + 0.25 * Math.sin(t / 140) * Math.sin(t / 310);
      for (const [px, py, sc] of [[W - 42, H - 30, 1], [W - 96, H - 22, 0.78]]) {
        glow(px, py, 46 * sc, '255,170,40', 0.22 * fl);
        put(st.pumpkin, px, py, sc, 0, 1, 1);
      }
    },
  };

  // ---------- Новый год ----------
  const BULBS = ['255,70,70', '255,200,60', '70,170,255', '90,220,120', '255,120,200', '190,120,255'];
  function swag(W0) {              // точки гирлянды: провисающие дуги вдоль верха страницы
    const pts = [], n = Math.max(3, Math.round(W0 / 240)), step = W0 / n, sag = 20;
    const arcs = [];
    for (let i = 0; i < n; i++) {
      const x0 = i * step, x1 = x0 + step, cx = (x0 + x1) / 2;
      arcs.push([x0, -2, cx, sag * 2 - 2, x1, -2]);
      const m = Math.max(4, Math.round(step / 36));
      for (let j = 1; j <= m; j++) {
        const u = j / (m + 1), a = (1 - u) * (1 - u), b = 2 * (1 - u) * u, c = u * u;
        pts.push({ x: a * x0 + b * cx + c * x1, y: a * -2 + b * (sag * 2 - 2) + c * -2, col: BULBS[(pts.length) % BULBS.length], ph: rnd(0, TAU), sp: rnd(1.2, 3) });
      }
    }
    return { arcs, pts };
  }
  function drawTree(g, x, y) {          // ёлка с подарками в правом нижнем углу; (x, y) — левый верхний угол области 96×128
    const dark = light ? '#1f7a3a' : '#1d8f45', mid = light ? '#2a9a4c' : '#27ad57';
    g.fillStyle = '#7a4a22'; g.fillRect(x + 42, y + 100, 12, 14);
    for (const [ty, w, h, c] of [[56, 70, 46, dark], [30, 56, 38, mid], [6, 40, 34, dark]]) {
      g.fillStyle = c; poly(g, [[x + 48, y + ty], [x + 48 + w / 2, y + ty + h], [x + 48 - w / 2, y + ty + h]]); g.fill();
    }
    g.fillStyle = '#ffd34d'; g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 4 : 9, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(x + 48 + Math.cos(a) * r, y + 4 + Math.sin(a) * r); }
    g.closePath(); g.fill();
    [[[x + 40, y + 50], '#ff5a5a'], [[x + 58, y + 42], '#5ab0ff'], [[x + 32, y + 84], '#ffd34d'], [[x + 64, y + 78], '#ff7ac8'], [[x + 46, y + 70], '#7dffb0'], [[x + 50, y + 28], '#ff5a5a']]
      .forEach(([[bx, by], c]) => { g.fillStyle = c; g.beginPath(); g.arc(bx, by, 3.6, 0, TAU); g.fill(); });
    for (const [gx, gw, c] of [[x + 4, 22, '#e24d4d'], [x + 70, 20, '#4d8fe2']]) {
      g.fillStyle = c; g.fillRect(gx, y + 106, gw, 16); g.fillStyle = '#ffe9a8'; g.fillRect(gx + gw / 2 - 2, y + 106, 4, 16); g.fillRect(gx, y + 112, gw, 3);
    }
  }
  EFFECTS.newyear = {
    statics(g) {
      const sw = swag(W); st.swag = sw;
      g.strokeStyle = light ? '#2f6b3d' : '#2f8a4a'; g.lineWidth = 2; g.lineCap = 'round';
      sw.arcs.forEach(([x0, y0, cx, cy, x1, y1]) => { g.beginPath(); g.moveTo(x0, y0); g.quadraticCurveTo(cx, cy, x1, y1); g.stroke(); });
      sw.pts.forEach((b) => {
        g.strokeStyle = 'rgba(40,40,40,.55)'; g.lineWidth = 1; g.beginPath(); g.moveTo(b.x, b.y); g.lineTo(b.x, b.y + 3); g.stroke();
        g.fillStyle = `rgb(${b.col})`; g.beginPath(); g.ellipse(b.x, b.y + 8, 3.6, 5.2, 0, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(b.x - 1.2, b.y + 6.2, 1.1, 0, TAU); g.fill();
      });
      for (let i = 0; i < Math.min(6, sw.pts.length); i++) {          // шары на ниточках
        const b = sw.pts[Math.floor((i + 0.5) * sw.pts.length / 6)], len = rnd(18, 34), c = pick(BULBS);
        g.strokeStyle = 'rgba(200,200,200,.5)'; g.lineWidth = 1; g.beginPath(); g.moveTo(b.x, b.y + 12); g.lineTo(b.x, b.y + 12 + len); g.stroke();
        g.fillStyle = `rgb(${c})`; g.beginPath(); g.arc(b.x, b.y + 12 + len + 7, 7, 0, TAU); g.fill();
        g.fillStyle = 'rgba(255,255,255,.55)'; g.beginPath(); g.arc(b.x - 2.4, b.y + 12 + len + 4.6, 2, 0, TAU); g.fill();
      }
      st.tree = { x: W - 104, y: H - 134 };
      drawTree(g, st.tree.x, st.tree.y);
    },
    setup(k) {
      const flake = (col) => sprite(40, 40, (g) => {
        g.translate(20, 20); g.strokeStyle = col; g.lineWidth = 2; g.lineCap = 'round';
        for (let i = 0; i < 6; i++) { g.save(); g.rotate((TAU * i) / 6); g.beginPath(); g.moveTo(0, 0); g.lineTo(0, -17); g.moveTo(0, -9); g.lineTo(5, -14); g.moveTo(0, -9); g.lineTo(-5, -14); g.stroke(); g.restore(); }
      });
      const spark = (col) => sprite(30, 30, (g) => {
        g.translate(15, 15); g.fillStyle = col;
        g.beginPath(); g.moveTo(0, -14); g.quadraticCurveTo(1.5, -1.5, 14, 0); g.quadraticCurveTo(1.5, 1.5, 0, 14); g.quadraticCurveTo(-1.5, 1.5, -14, 0); g.quadraticCurveTo(-1.5, -1.5, 0, -14); g.fill();
      });
      const white = light ? '#7a96d6' : '#ffffff';
      st.imgs = [flake(white), flake(light ? '#6f8ccf' : '#cfe3ff'), spark('#ffd34d'), spark(light ? '#8aa4e0' : '#ffffff')];
      st.snow = fallers(Math.round(46 * k), st.imgs, { size: [12, 30], v: [24, 66], sway: [10, 36], spin: 1, alpha: [0.55, 1] });
      st.shoot = null; st.nextShoot = performance.now() + rnd(4000, 9000);
      st.lights = [[48, 50], [66, 66], [30, 66], [48, 82], [58, 92], [38, 94]].map(([dx, dy], i) => ({ dx, dy, ph: i * 1.3 }));
    },
    frame(t, dt) {
      const comp = light ? 'source-over' : 'lighter';
      // мигание гирлянды
      if (st.swag) {
        for (const b of st.swag.pts) {
          const a = 0.3 + 0.3 * Math.sin(t / 1000 * b.sp + b.ph) ** 2 * 2;
          glow(b.x, b.y + 8, 15, b.col, Math.min(0.75, a), comp);
        }
      }
      if (st.tree) for (const l of st.lights) glow(st.tree.x + l.dx, st.tree.y + l.dy, 12, '255,230,140', 0.25 + 0.3 * Math.abs(Math.sin(t / 700 + l.ph)), comp);
      stepFallers(st.snow, dt, t, {});
      // падающая звезда
      if (!st.shoot && t > st.nextShoot) { st.shoot = { x: rnd(W * 0.3, W * 0.9), y: rnd(20, H * 0.25), life: 0 }; st.nextShoot = t + rnd(9000, 18000); sfx('chime'); }
      if (st.shoot) {
        const s = st.shoot; s.life += dt; s.x -= 520 * dt; s.y += 230 * dt;
        const a = Math.max(0, 1 - s.life / 0.9), g = ctx.createLinearGradient(s.x, s.y, s.x + 130, s.y - 58);
        g.addColorStop(0, `rgba(${light ? '220,160,40' : '255,255,255'},${a})`); g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.strokeStyle = g; ctx.lineWidth = 2; ctx.lineCap = 'round'; ctx.beginPath(); ctx.moveTo(s.x, s.y); ctx.lineTo(s.x + 130, s.y - 58); ctx.stroke();
        if (s.life > 0.9) st.shoot = null;
      }
    },
  };

  // ---------- 14 февраля ----------
  function drawHeart(g, c1, c2) {
    const grad = g.createLinearGradient(0, 0, 0, 36); grad.addColorStop(0, c1); grad.addColorStop(1, c2);
    g.fillStyle = grad; g.beginPath(); g.moveTo(20, 34); g.bezierCurveTo(-4, 18, 4, 0, 20, 10); g.bezierCurveTo(36, 0, 44, 18, 20, 34); g.closePath(); g.fill();
    g.fillStyle = 'rgba(255,255,255,.4)'; g.beginPath(); g.ellipse(11, 12, 4, 2.4, -0.6, 0, TAU); g.fill();
  }
  EFFECTS.valentine = {
    setup(k) {
      st.imgs = [['#ff7a9a', '#e11d48'], ['#ff9ec0', '#d6336c'], ['#ffb3c7', '#f43f5e'], ['#ff5c8a', '#be123c']].map(([a, b]) => sprite(40, 36, (g) => drawHeart(g, a, b)));
      st.list = fallers(Math.round(26 * k), st.imgs, { size: [16, 42], v: [30, 72], sway: [10, 30], spin: 0.5, alpha: [0.5, 0.9], dir: -1, flat: true });
    },
    frame(t, dt) { stepFallers(st.list, dt, t, { dir: -1, flat: true, pulse: true }); },
  };

  // ---------- 8 Марта ----------
  EFFECTS.march8 = {
    setup(k) {
      const petal = (c) => sprite(24, 16, (g) => { g.fillStyle = c; g.beginPath(); g.ellipse(12, 8, 10, 5.5, 0, 0, TAU); g.fill(); g.fillStyle = 'rgba(255,255,255,.35)'; g.beginPath(); g.ellipse(9, 6.5, 4, 1.8, -0.3, 0, TAU); g.fill(); });
      const flower = (c, mid) => sprite(34, 34, (g) => {
        g.translate(17, 17); g.fillStyle = c;
        for (let i = 0; i < 5; i++) { g.save(); g.rotate((TAU * i) / 5); g.beginPath(); g.ellipse(0, -8.5, 5.6, 8, 0, 0, TAU); g.fill(); g.restore(); }
        g.fillStyle = mid; g.beginPath(); g.arc(0, 0, 4.4, 0, TAU); g.fill();
      });
      const petals = ['#ffb3cf', '#ff8fb8', '#ffd0e0', '#f9a8d4'].map(petal);
      const flowers = [flower('#ff9ec4', '#ffd34d'), flower('#ffe27a', '#e08a1e'), flower('#d8b4fe', '#ffd34d'), flower('#ffffff', '#ffb02e')];
      st.petals = fallers(Math.round(26 * k), petals, { size: [12, 26], v: [28, 64], sway: [14, 40], spin: 1.6, alpha: [0.6, 0.95] });
      st.flowers = fallers(Math.round(10 * k), flowers, { size: [20, 36], v: [24, 50], sway: [10, 30], spin: 0.8, alpha: [0.75, 1] });
    },
    frame(t, dt) { stepFallers(st.petals, dt, t, {}); stepFallers(st.flowers, dt, t, {}); },
  };

  // ---------- Листопад ----------
  function drawLeaf(g, c, v) {
    g.fillStyle = c; g.strokeStyle = 'rgba(80,30,0,.45)'; g.lineWidth = 1; g.lineJoin = 'round';
    g.beginPath(); g.moveTo(15, 28);
    g.bezierCurveTo(2, 22, 0, 12, 6, 7); g.lineTo(9, 10); g.lineTo(10, 3); g.lineTo(14, 8); g.lineTo(15, 1);
    g.lineTo(16, 8); g.lineTo(20, 3); g.lineTo(21, 10); g.lineTo(24, 7); g.bezierCurveTo(30, 12, 28, 22, 15, 28);
    g.closePath(); g.fill(); g.stroke();
    g.strokeStyle = 'rgba(80,30,0,.55)'; g.beginPath(); g.moveTo(15, 28); g.lineTo(15, 10); g.moveTo(15, 18); g.lineTo(9, 12); g.moveTo(15, 18); g.lineTo(21, 12); g.stroke();
    if (v) { g.fillStyle = 'rgba(255,255,255,.12)'; g.beginPath(); g.ellipse(11, 14, 3, 5, -0.4, 0, TAU); g.fill(); }
  }
  EFFECTS.autumn = {
    setup(k) {
      st.imgs = ['#e8742c', '#cf3b2a', '#f2b134', '#a8702e', '#e0561f', '#f7c948'].map((c, i) => sprite(30, 30, (g) => drawLeaf(g, c, i % 2)));
      st.list = fallers(Math.round(30 * k), st.imgs, { size: [18, 40], v: [34, 82], sway: [20, 56], spin: 1.3, alpha: [0.7, 1] });
    },
    frame(t, dt) { stepFallers(st.list, dt, t, {}); },
  };

  // ---------- Конфетти ----------
  const CONFETTI = ['#ff4d6d', '#ffd23f', '#3bceac', '#4ea8ff', '#b388ff', '#ff9f1c', '#6ee7b7'];
  EFFECTS.confetti = {
    setup(k) {
      st.list = Array.from({ length: Math.round(72 * k) }, () => ({ x: rnd(0, W), y: rnd(-H * 0.2, H), v: rnd(50, 130), sway: rnd(14, 50), ph: rnd(0, TAU), sp: rnd(0.6, 1.8), rot: rnd(0, TAU), vr: rnd(-4, 4),
        tilt: rnd(0, TAU), tv: rnd(2, 6), w: rnd(6, 11), h: rnd(3, 6), c: pick(CONFETTI), a: rnd(0.7, 1) }));
    },
    frame(t, dt) {
      for (const f of st.list) {
        f.y += f.v * dt; f.ph += dt * f.sp; f.x += Math.sin(f.ph) * f.sway * dt; f.rot += f.vr * dt; f.tilt += f.tv * dt;
        if (f.y > H + 12) { f.y = -12; f.x = rnd(0, W); }
        ctx.save(); ctx.globalAlpha = f.a; ctx.translate(f.x, f.y); ctx.rotate(f.rot); ctx.scale(1, Math.cos(f.tilt)); ctx.fillStyle = f.c; ctx.fillRect(-f.w / 2, -f.h / 2, f.w, f.h); ctx.restore();
      }
    },
  };

  // ---------- 9 Мая — салют ----------
  const FIRE = [[255, 90, 90], [255, 210, 90], [120, 190, 255], [150, 255, 160], [255, 255, 255], [255, 150, 70], [220, 140, 255]];
  const FIRE_LIGHT = [[210, 40, 40], [214, 140, 0], [40, 110, 210], [30, 150, 70], [150, 60, 200], [220, 90, 20]];
  EFFECTS.victory = {
    setup() { st.rockets = []; st.sparks = []; st.flashes = []; st.next = performance.now() + 600; },
    frame(t, dt) {
      const pal = light ? FIRE_LIGHT : FIRE, comp = light ? 'source-over' : 'lighter';
      if (t > st.next && st.rockets.length < 3) {
        st.rockets.push({ x: rnd(W * 0.12, W * 0.88), y: H + 10, vy: -rnd(380, 520), top: rnd(H * 0.12, H * 0.5), col: pick(pal) });
        st.next = t + rnd(700, 1900);
      }
      ctx.globalCompositeOperation = comp; ctx.lineCap = 'round';
      for (let i = st.rockets.length - 1; i >= 0; i--) {
        const r = st.rockets[i]; r.y += r.vy * dt; r.vy += 90 * dt;
        ctx.strokeStyle = `rgba(${r.col},0.8)`; ctx.lineWidth = 2; ctx.beginPath(); ctx.moveTo(r.x, r.y); ctx.lineTo(r.x, r.y + 16); ctx.stroke();
        if (r.y <= r.top || r.vy > -60) {
          const n = lite ? 46 : 80, ring = Math.random() < 0.4;
          for (let j = 0; j < n; j++) {
            const a = (TAU * j) / n + rnd(-0.05, 0.05), sp = ring ? 210 : rnd(80, 290);
            st.sparks.push({ x: r.x, y: r.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, life: rnd(1.1, 2.0), age: 0, col: Math.random() < 0.2 ? (light ? r.col : [255, 255, 255]) : r.col });
          }
          st.flashes.push({ x: r.x, y: r.y, age: 0, col: r.col });
          sfx('bang');
          st.rockets.splice(i, 1);
        }
      }
      for (let i = st.sparks.length - 1; i >= 0; i--) {
        const s = st.sparks[i]; s.age += dt; s.vy += 95 * dt; s.vx *= 0.982; s.vy *= 0.982; s.x += s.vx * dt; s.y += s.vy * dt;
        if (s.age >= s.life) { st.sparks.splice(i, 1); continue; }
        const a = 1 - s.age / s.life;
        ctx.strokeStyle = `rgba(${s.col},${Math.min(1, a * 1.3)})`; ctx.lineWidth = 2.6; ctx.beginPath(); ctx.moveTo(s.x - s.vx * 0.09, s.y - s.vy * 0.09); ctx.lineTo(s.x, s.y); ctx.stroke();
      }
      for (let i = st.flashes.length - 1; i >= 0; i--) {                   // вспышка в центре взрыва
        const f = st.flashes[i]; f.age += dt;
        if (f.age > 0.3) { st.flashes.splice(i, 1); continue; }
        glow(f.x, f.y, 110, f.col.join(','), (light ? 0.35 : 0.55) * (1 - f.age / 0.3), comp);
        ctx.globalCompositeOperation = comp;
      }
      ctx.globalCompositeOperation = 'source-over';
      if (st.sparks.length > 900) st.sparks.splice(0, st.sparks.length - 900);
    },
  };

  // ---------- 23 Февраля ----------
  function drawStar5(g, c, edge) {
    g.fillStyle = c; g.strokeStyle = edge; g.lineWidth = 1.4; g.lineJoin = 'round'; g.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? 6.2 : 14, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(16 + Math.cos(a) * r, 16 + Math.sin(a) * r); }
    g.closePath(); g.fill(); g.stroke();
  }
  function drawJet(g) {                       // самолёт сверху, летит вправо
    g.fillStyle = light ? '#44546f' : '#aebcd6'; g.strokeStyle = light ? '#1f2a3d' : '#e8eefc'; g.lineWidth = 1; g.lineJoin = 'round';
    poly(g, [[46, 11], [34, 9], [22, 1], [17, 1], [23, 9], [10, 9], [5, 4], [2, 4], [5, 11], [2, 18], [5, 18], [10, 13], [23, 13], [17, 21], [22, 21], [34, 13]]); g.fill(); g.stroke();
    g.fillStyle = light ? '#8fb0e8' : '#52c1ff'; g.beginPath(); g.ellipse(34, 11, 4.5, 1.8, 0, 0, TAU); g.fill();
  }
  EFFECTS.feb23 = {
    statics(g) {                              // орден в правом нижнем углу: золотая звезда на красной ленте
      const x = W - 56, y = H - 70;
      g.fillStyle = '#c62828'; poly(g, [[x - 14, y - 38], [x, y - 8], [x + 2, y - 8], [x - 8, y - 38]]); g.fill();
      g.fillStyle = '#e53935'; poly(g, [[x + 14, y - 38], [x, y - 8], [x - 2, y - 8], [x + 8, y - 38]]); g.fill();
      g.fillStyle = '#ffd54a'; g.strokeStyle = '#a57400'; g.lineWidth = 1.5; g.beginPath();
      for (let i = 0; i < 10; i++) { const r = i % 2 ? 11 : 26, a = -Math.PI / 2 + (i * Math.PI) / 5; g.lineTo(x + Math.cos(a) * r, y + 12 + Math.sin(a) * r); }
      g.closePath(); g.fill(); g.stroke();
      g.fillStyle = '#d32f2f'; g.beginPath(); g.arc(x, y + 12, 6, 0, TAU); g.fill();
    },
    setup(k) {
      const imgs = [['#e53935', '#8e0000'], ['#ffca28', '#a57400'], ['#fb8c00', '#8a4300'], ['#ffe082', '#a57400']].map(([c, e]) => sprite(32, 32, (g) => drawStar5(g, c, e)));
      st.list = fallers(Math.round(24 * k), imgs, { size: [14, 32], v: [26, 62], sway: [10, 32], spin: 1.2, alpha: [0.7, 1] });
      st.jet = sprite(48, 22, drawJet);
      st.jets = []; st.nextJet = performance.now() + 1500;
    },
    frame(t, dt) {
      stepFallers(st.list, dt, t, {});
      if (t > st.nextJet && st.jets.length < 2) {                     // самолёт пролетает через экран, оставляя след
        const dir = Math.random() < 0.5 ? 1 : -1;
        st.jets.push({ x: dir > 0 ? -50 : W + 50, y: rnd(H * 0.1, H * 0.42), v: dir * rnd(300, 420), dir, trail: [], acc: 0 });
        st.nextJet = t + rnd(7000, 14000);
      }
      for (let i = st.jets.length - 1; i >= 0; i--) {
        const j = st.jets[i]; j.x += j.v * dt; j.acc += dt;
        if (j.acc > 0.03) { j.acc = 0; j.trail.push({ x: j.x - j.dir * 20, y: j.y, age: 0 }); }
        ctx.lineCap = 'round';
        for (let q = j.trail.length - 1; q > 0; q--) {
          const a = j.trail[q], b = j.trail[q - 1]; a.age += dt;
          if (a.age > 1.6) { j.trail.splice(0, q); break; }
          ctx.strokeStyle = `rgba(${light ? '90,110,150' : '255,255,255'},${0.55 * (1 - a.age / 1.6)})`; ctx.lineWidth = 3 + a.age * 3;
          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        }
        put(st.jet, j.x, j.y, 1, 0, 1, 1, j.dir);
        if ((j.dir > 0 && j.x > W + 80) || (j.dir < 0 && j.x < -80)) { if (!j.trail.length || j.trail[j.trail.length - 1].age > 1.6) st.jets.splice(i, 1); }
      }
    },
  };

  // ---------- запуск / остановка ----------
  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    if (cv) { cv.remove(); cv = null; ctx = null; }
    stat = null; cur = null; st = null;
  }
  function setup() {
    const id = activeId();
    try { document.dispatchEvent(new CustomEvent('lc-season', { detail: { id } })); } catch (e) { /* не страшно */ }
    const lv = levelNow();
    if (!id || lv === 'off' || !EFFECTS[id]) { stop(); return; }
    lite = lv === 'lite'; light = isLight();
    dpr = Math.min(window.devicePixelRatio || 1, lite ? 1 : 1.5);
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'seasonCanvas'; cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:15;pointer-events:none';
      document.body.appendChild(cv);
      ctx = cv.getContext('2d', { alpha: true });
    }
    W = window.innerWidth; H = window.innerHeight;
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    st = {}; cur = { id, ...EFFECTS[id] };
    const area = Math.max(0.5, Math.min(1.4, (W * H) / (1920 * 1080)));
    const k = (lite ? 0.5 : 1) * area;
    if (cur.setup) cur.setup(k);
    stat = null;
    if (cur.statics) {                          // неподвижные украшения — один раз в отдельный слой
      stat = document.createElement('canvas'); stat.width = cv.width; stat.height = cv.height;
      const g = stat.getContext('2d'); g.scale(dpr, dpr);
      cur.statics(g);
    }
    cancelAnimationFrame(raf); lastT = 0; raf = requestAnimationFrame(frame);
  }
  const perf = { frames: 0, ms: 0, since: 0 };
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !ctx || !cur) return;
    const interval = lite ? 50 : 33;
    if (lastT && t - lastT < interval - 2) return;
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0.033;
    lastT = t;
    const began = performance.now();
    if (!perf.since) perf.since = began;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (stat) ctx.drawImage(stat, 0, 0, W, H);
    cur.frame(t, dt);
    perf.frames += 1; perf.ms += performance.now() - began;
  }

  let rz = 0;
  window.addEventListener('resize', () => {
    if (!cv) return;
    clearTimeout(rz);
    rz = setTimeout(() => { if (Math.abs(window.innerWidth - W) >= 12 || Math.abs(window.innerHeight - H) >= 80) setup(); }, 300);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) lastT = 0; });
  // Уровень эффектов и светлая/тёмная основа меняются атрибутами <html> (fx.js, theme.js) — подхватываем без связи между файлами.
  if (window.MutationObserver) {
    let mt = 0;
    new MutationObserver(() => {
      clearTimeout(mt);
      mt = setTimeout(() => { if (activeId() && (!cv || light !== isLight() || (levelNow() === 'lite') !== lite || levelNow() === 'off')) setup(); else if (!activeId()) stop(); }, 150);
    }).observe(root, { attributes: true, attributeFilter: ['data-fx', 'data-theme'] });
  }
  // «По датам»: в полночь праздник сам включается/выключается без перезагрузки страницы.
  setInterval(() => { const id = activeId(); if ((id || null) !== (cur ? cur.id : null)) setup(); }, 5 * 60000);

  function describe() {
    const pref = store.get(KEY, 'off');
    const label = (id) => (EVENTS.find((e) => e.id === id) || {}).label || id;
    if (pref === 'off') return 'выключено';
    if (levelNow() === 'off') return 'эффекты выключены — оформление скрыто';
    if (pref === 'auto') { const id = activeId(); return id ? `сейчас показывается: ${label(id)}` : 'по датам: сегодня праздника нет, ничего не показывается'; }
    return `показывается: ${label(pref)}`;
  }
  window.LCSeason = {
    EVENTS: EVENTS.map((e) => ({ id: e.id, label: e.label })),
    refresh: setup,
    current() { return cur ? cur.id : null; },
    selected: activeId,                        // какой праздник выбран/наступил (звук следует за ним, даже когда рисование выключено)
    describe,
    eventForDate(iso) { return eventForDate(new Date(iso)); },
    // Для проверки: подменить текущую дату (ISO); без аргумента — настоящая.
    setTestDate(iso) { testDate = iso ? new Date(iso).getTime() : null; setup(); },
    stats() { const sec = perf.since ? (performance.now() - perf.since) / 1000 : 0; return { fps: sec ? +(perf.frames / sec).toFixed(1) : 0, avgMs: perf.frames ? +(perf.ms / perf.frames).toFixed(2) : 0, frames: perf.frames }; },
  };

  function boot() { setup(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
