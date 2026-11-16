// Звуки: погода, праздничные нажатия кнопок и своя мелодия у каждого праздника. ВСЁ ВЫКЛЮЧЕНО по умолчанию.
// Включается в меню темы (🌙/☀ → «Звуки»); настройки хранятся в этом браузере, у каждого сотрудника свои.
//  • «Погода» — фоновый шум по погоде на фоне (static/js/fx.js сообщает вид погоды и время суток): дождь, гроза с громом (в такт вспышкам),
//    ветер, снег, туман, днём — птицы, ночью — сверчки.
//  • «Мелодия праздника» — у каждого праздника своя мелодия и свой «инструмент»; играет сама и повторяется с паузой (тихо).
//  • «Звуки праздника» — свой звук на нажатие кнопок (колокольчики, привидение, сердечко, хлопушка, фанфары…) и звуки в такт украшениям (залпы салюта).
// Всё синтезируется в самом браузере (Web Audio) — ни одного файла, интернет не нужен. Браузер разрешает звук только после первого нажатия
// на странице, поэтому после открытия страницы звук начнётся с первого клика. На скрытой вкладке звук приостанавливается.
(function () {
  'use strict';
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* не страшно */ } },
  };
  const KEYS = { wx: 'lcSndWx', music: 'lcSndMusic', fx: 'lcSndFx' };
  const VOL = 'lcSndVol';
  const flag = (k) => store.get(KEYS[k], '0') === '1';
  const volume = () => Math.max(0, Math.min(100, +store.get(VOL, '50') || 0)) / 100;
  const MASTER_K = 1.5;                      // запас громкости: ползунок 100 % — это уже громко, компрессор не даёт «трещать»
  const rnd = (a, b) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

  // ---------- нотная запись: «C4:1 E4:0.5 R:1» (нота:доли, R — пауза), # и b — диезы и бемоли ----------
  const SEMI = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  function midi(name) {
    const m = /^([A-G])([#b]?)(-?\d)$/.exec(name);
    if (!m) return null;
    return 12 * (+m[3] + 1) + SEMI[m[1]] + (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  }
  const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
  function parse(text) { return text.trim().split(/\s+/).map((x) => { const [n, b] = x.split(':'); return { m: n === 'R' ? null : midi(n), b: +b }; }); }

  // «Инструменты»: форма волны, огибающая, обертоны, вибрато, фильтр.
  const TIMBRE = {
    bell: { type: 'sine', pluck: true, a: 0.004, gain: 0.2, partials: [[1, 1], [2, 0.35], [3.01, 0.16]], ring: 1.2 },
    musicbox: { type: 'sine', pluck: true, a: 0.003, gain: 0.2, partials: [[1, 1], [3, 0.22], [5, 0.08]], ring: 0.7 },
    spooky: { type: 'sine', a: 0.09, r: 0.25, gain: 0.17, vib: [5.2, 40], partials: [[1, 1], [2, 0.18]] },
    brass: { type: 'sawtooth', a: 0.03, r: 0.1, gain: 0.1, lp: 1700, partials: [[1, 1], [1.006, 0.6]] },
    pluck: { type: 'triangle', pluck: true, a: 0.004, gain: 0.26, partials: [[1, 1], [2, 0.28]], ring: 0.9 },
    party: { type: 'square', a: 0.006, r: 0.05, gain: 0.06, lp: 2600 },
  };
  // Мелодии (свои, короткие; «Новый год» — «Jingle Bells», общественное достояние).
  const MUSIC = {
    newyear: { bpm: 150, gap: 25, timbre: 'bell',
      notes: 'E4:1 E4:1 E4:2 E4:1 E4:1 E4:2 E4:1 G4:1 C4:1.5 D4:0.5 E4:4 F4:1 F4:1 F4:1.5 F4:0.5 F4:1 E4:1 E4:1 E4:0.5 E4:0.5 G4:1 G4:1 F4:1 D4:1 C4:4' },
    halloween: { bpm: 92, gap: 24, timbre: 'spooky',
      notes: 'A3:0.5 C4:0.5 E4:0.5 A4:1.5 G#4:0.5 E4:0.5 C4:1 B3:0.5 D4:0.5 F4:0.5 B4:1.5 A4:0.5 F4:0.5 D4:1 E4:0.5 D#4:0.5 D4:0.5 C#4:0.5 C4:1 B3:1 A3:3' },
    valentine: { bpm: 96, gap: 26, timbre: 'musicbox',
      notes: 'E5:1 G5:1 C6:2 B5:1 G5:1 E5:2 F5:1 A5:1 D6:2 C6:1 A5:1 F5:2 E5:1 G5:1 C6:1.5 D6:0.5 E6:2 C6:3' },
    feb23: { bpm: 112, gap: 22, timbre: 'brass',
      notes: 'G3:0.5 C4:0.5 E4:0.5 G4:1.5 E4:0.5 G4:0.5 C5:2 R:0.5 G4:0.5 A4:0.5 G4:0.5 E4:0.5 C4:1 D4:1 E4:2 G4:0.5 E4:0.5 C4:0.5 G3:0.5 C4:3' },
    march8: { bpm: 126, gap: 26, timbre: 'musicbox',
      notes: 'G4:1 B4:1 D5:1 G5:2 F#5:1 E5:1 D5:1 C5:1 B4:1 A4:3 B4:1 D5:1 G5:1 B5:2 A5:1 G5:1 F#5:1 E5:1 D5:1 G4:3' },
    victory: { bpm: 100, gap: 24, timbre: 'brass',
      notes: 'A3:1 D4:1.5 F4:0.5 A4:2 G4:1 F4:1 E4:1 D4:2 C4:1 F4:1.5 A4:0.5 C5:2 Bb4:1 A4:1 G4:1 F4:3' },
    autumn: { bpm: 84, gap: 26, timbre: 'pluck',
      notes: 'A3:1 C4:1 E4:1 D4:1 C4:1 E4:1 A4:2 G4:1 E4:1 D4:1 C4:1 B3:1 D4:1 E4:3' },
    confetti: { bpm: 156, gap: 20, timbre: 'party',
      notes: 'C5:0.5 E5:0.5 G5:0.5 C6:0.5 G5:0.5 E5:0.5 C5:1 D5:0.5 F5:0.5 A5:0.5 D6:0.5 A5:0.5 F5:0.5 D5:1 E5:0.5 G5:0.5 C6:1 C6:0.5 C6:0.5 E6:2' },
  };
  Object.keys(MUSIC).forEach((k) => { MUSIC[k].seq = parse(MUSIC[k].notes); });
  const melodyLength = (id) => MUSIC[id].seq.reduce((a, n) => a + n.b, 0) * (60 / MUSIC[id].bpm);

  // ---------- примитивы синтеза (работают и в живом AudioContext, и в OfflineAudioContext для проверок) ----------
  function noiseBuf(ctx) {
    if (!ctx._lcNoise) {
      const n = Math.round(ctx.sampleRate * 2), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
      ctx._lcNoise = b;
    }
    return ctx._lcNoise;
  }
  function noiseSrc(ctx, loop) { const s = ctx.createBufferSource(); s.buffer = noiseBuf(ctx); s.loop = !!loop; return s; }
  function filt(ctx, type, f, q) { const b = ctx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (q) b.Q.value = q; return b; }

  // Один тон: o.type, o.gain, o.a (атака), o.r (затухание после ноты), o.pluck (щипок: затухает сам), o.partials [[кратность, громкость]], o.vib [Гц, центы],
  // o.lp (срез), o.glide [частота, секунды] (плавный сдвиг высоты).
  function tone(ctx, out, t, f, dur, o) {
    const g = ctx.createGain();
    let tail = g;
    if (o.lp) { const lp = filt(ctx, 'lowpass', o.lp, 0.8); g.connect(lp); tail = lp; }
    tail.connect(out);
    const peak = o.gain == null ? 0.2 : o.gain, a = o.a == null ? 0.01 : o.a, r = o.r == null ? 0.15 : o.r;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(peak, t + a);
    let end;
    if (o.pluck) { end = t + Math.min(o.ring || 1, dur * 1.6 + 0.25); g.gain.exponentialRampToValueAtTime(0.0001, end); }
    else { g.gain.setValueAtTime(peak, t + Math.max(a, dur)); g.gain.exponentialRampToValueAtTime(0.0001, t + dur + r); end = t + dur + r; }
    (o.partials || [[1, 1]]).forEach(([mult, amp]) => {
      const osc = ctx.createOscillator(), pg = ctx.createGain();
      osc.type = o.type || 'sine'; osc.frequency.setValueAtTime(f * mult, t);
      if (o.glide) osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.glide[0] * mult), t + o.glide[1]);
      pg.gain.value = amp;
      if (o.vib) {
        const lfo = ctx.createOscillator(), lg = ctx.createGain();
        lfo.frequency.value = o.vib[0]; lg.gain.value = f * mult * (Math.pow(2, o.vib[1] / 1200) - 1);
        lfo.connect(lg); lg.connect(osc.frequency); lfo.start(t); lfo.stop(end + 0.05);
      }
      osc.connect(pg); pg.connect(g); osc.start(t); osc.stop(end + 0.05);
    });
  }
  // Шумовой всплеск: o.type/freq/q (фильтр), o.sweep [от, до] (частота фильтра), o.gain, o.dur, o.a.
  function burst(ctx, out, t, o) {
    const s = noiseSrc(ctx, false), f = filt(ctx, o.type || 'bandpass', o.freq || 1000, o.q || 0.8), g = ctx.createGain();
    if (o.sweep) { f.frequency.setValueAtTime(o.sweep[0], t); f.frequency.exponentialRampToValueAtTime(Math.max(20, o.sweep[1]), t + o.dur); }
    g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(o.gain == null ? 0.3 : o.gain, t + (o.a || 0.004));
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    s.connect(f); f.connect(g); g.connect(out); s.start(t); s.stop(t + o.dur + 0.05);
  }
  function scheduleMelody(ctx, out, id, t0) {
    const m = MUSIC[id], tm = TIMBRE[m.timbre], beat = 60 / m.bpm;
    let t = t0;
    m.seq.forEach((n) => {
      const d = n.b * beat;
      if (n.m != null) tone(ctx, out, t, hz(n.m), d * 0.92, tm);
      t += d;
    });
    return t - t0;
  }

  // Звуки нажатия кнопок — у каждого праздника свой.
  const CLICK = {
    newyear(c, o, t) { [2093, 3136, 4186].forEach((f, i) => tone(c, o, t + i * 0.014, f, 0.2, { pluck: true, ring: 0.45, a: 0.002, gain: 0.13 / Math.sqrt(i + 1), partials: [[1, 1], [2.7, 0.35]] })); tone(c, o, t + 0.09, 2637, 0.2, { pluck: true, ring: 0.5, gain: 0.1 }); },
    halloween(c, o, t) { tone(c, o, t, 420, 0.32, { a: 0.05, r: 0.15, gain: 0.2, vib: [7, 60], glide: [250, 0.42], partials: [[1, 1], [2, 0.25]] }); burst(c, o, t, { type: 'bandpass', freq: 1200, q: 3, dur: 0.12, gain: 0.05 }); },
    valentine(c, o, t) { tone(c, o, t, 659, 0.2, { pluck: true, ring: 0.5, a: 0.003, gain: 0.16, partials: [[1, 1], [2, 0.3]] }); tone(c, o, t + 0.1, 988, 0.25, { pluck: true, ring: 0.6, a: 0.003, gain: 0.15, partials: [[1, 1], [2, 0.3]] }); },
    feb23(c, o, t) { [261.6, 392].forEach((f) => tone(c, o, t, f, 0.18, { type: 'sawtooth', a: 0.01, r: 0.1, gain: 0.08, lp: 1500, partials: [[1, 1], [1.006, 0.6]] })); tone(c, o, t + 0.12, 523.3, 0.22, { type: 'sawtooth', a: 0.01, r: 0.12, gain: 0.08, lp: 1700 }); },
    march8(c, o, t) { [784, 988, 1175].forEach((f, i) => tone(c, o, t + i * 0.07, f, 0.12, { pluck: true, ring: 0.45, a: 0.003, gain: 0.14, partials: [[1, 1], [3, 0.2]] })); },
    victory(c, o, t) { burst(c, o, t, { type: 'bandpass', freq: 900, q: 0.7, dur: 0.14, gain: 0.5 }); tone(c, o, t, 130, 0.14, { pluck: true, ring: 0.2, a: 0.002, gain: 0.35, glide: [48, 0.16] }); },
    autumn(c, o, t) { burst(c, o, t, { type: 'bandpass', freq: 3600, q: 0.6, dur: 0.2, gain: 0.22, a: 0.02 }); burst(c, o, t + 0.05, { type: 'highpass', freq: 5000, dur: 0.12, gain: 0.08 }); },
    confetti(c, o, t) { burst(c, o, t, { type: 'highpass', freq: 2200, dur: 0.12, gain: 0.3 }); tone(c, o, t, 820, 0.1, { a: 0.002, r: 0.05, gain: 0.12, glide: [220, 0.1] }); burst(c, o, t + 0.07, { type: 'bandpass', freq: 6000, q: 0.8, dur: 0.2, gain: 0.07 }); },
  };
  // Звуки «в такт» украшениям.
  const FX = {
    bang(c, o, t) {          // залп салюта: хлопок, раскат и треск
      tone(c, o, t, 150, 0.3, { pluck: true, ring: 0.5, a: 0.004, gain: 0.5, glide: [38, 0.4] });
      burst(c, o, t, { type: 'lowpass', freq: 500, dur: 0.6, gain: 0.5, sweep: [900, 120] });
      for (let i = 0; i < 6; i++) burst(c, o, t + 0.12 + i * rnd(0.04, 0.09), { type: 'highpass', freq: 3500, dur: 0.07, gain: 0.07 });
    },
    chime(c, o, t) { [1568, 1319, 1047].forEach((f, i) => tone(c, o, t + i * 0.13, f, 0.3, { pluck: true, ring: 0.9, a: 0.003, gain: 0.1, partials: [[1, 1], [2.76, 0.3]] })); },
  };
  function thunderSound(c, o, t, big) {
    burst(c, o, t, { type: 'bandpass', freq: 1800, q: 0.6, dur: 0.14, gain: big ? 0.3 : 0.18 });
    burst(c, o, t + 0.05, { type: 'lowpass', freq: 400, dur: 3.6, gain: big ? 0.8 : 0.5, a: 0.12, sweep: [520, 60] });
    burst(c, o, t + 0.7, { type: 'lowpass', freq: 300, dur: 2.6, gain: big ? 0.5 : 0.3, a: 0.2, sweep: [380, 55] });
  }

  // ---------- фон погоды ----------
  function loopNoise(ctx) { const s = noiseSrc(ctx, true); return s; }
  function windLayer(ctx, out, level, cutoff, rate) {
    const s = loopNoise(ctx), lp = filt(ctx, 'lowpass', cutoff, 0.7), g = ctx.createGain();
    g.gain.value = level; s.connect(lp); lp.connect(g); g.connect(out);
    const lfo = ctx.createOscillator(), lg = ctx.createGain();
    lfo.frequency.value = rate; lg.gain.value = level * 0.55; lfo.connect(lg); lg.connect(g.gain);
    s.start(0); lfo.start(0);
    return [s, lfo];
  }
  function rainLayer(ctx, out, level) {
    const a = loopNoise(ctx), hp = filt(ctx, 'highpass', 600), lp = filt(ctx, 'lowpass', 7000), g = ctx.createGain();
    g.gain.value = level; a.connect(hp); hp.connect(lp); lp.connect(g); g.connect(out); a.start(0);
    const b = loopNoise(ctx), bp = filt(ctx, 'bandpass', 3200, 0.6), gb = ctx.createGain();
    gb.gain.value = level * 0.45; b.connect(bp); bp.connect(gb); gb.connect(out);
    const lfo = ctx.createOscillator(), lg = ctx.createGain(); lfo.frequency.value = 0.35; lg.gain.value = level * 0.3; lfo.connect(lg); lg.connect(gb.gain);
    b.start(1.0); lfo.start(0);
    return [a, b, lfo];
  }
  function droneLayer(ctx, out, f, level) {
    const o = ctx.createOscillator(), g = ctx.createGain(); o.type = 'sine'; o.frequency.value = f; g.gain.value = level; o.connect(g); g.connect(out); o.start(0); return [o];
  }
  const LAYERS = {
    clear: (c, o, day) => windLayer(c, o, day > 0.4 ? 0.045 : 0.03, 520, 0.11),
    partly: (c, o, day) => windLayer(c, o, 0.07, 560, 0.13),
    clouds: (c, o) => windLayer(c, o, 0.1, 620, 0.12),
    rain: (c, o) => [...rainLayer(c, o, 0.18), ...windLayer(c, o, 0.03, 500, 0.1)],
    storm: (c, o) => [...rainLayer(c, o, 0.3), ...windLayer(c, o, 0.09, 720, 0.2)],
    snow: (c, o) => windLayer(c, o, 0.07, 430, 0.09),
    fog: (c, o) => [...windLayer(c, o, 0.08, 270, 0.07), ...droneLayer(c, o, 62, 0.022)],
  };
  function chirp(ctx, out, t) {          // короткая птичья трель
    const n = 2 + Math.floor(Math.random() * 4), base = rnd(2600, 4300);
    for (let i = 0; i < n; i++) {
      const s = t + i * rnd(0.07, 0.12), f0 = base * rnd(0.9, 1.15), d = rnd(0.045, 0.09);
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(f0, s); o.frequency.exponentialRampToValueAtTime(f0 * rnd(0.75, 1.35), s + d);
      g.gain.setValueAtTime(0.0001, s); g.gain.linearRampToValueAtTime(0.075, s + 0.012); g.gain.exponentialRampToValueAtTime(0.0001, s + d);
      o.connect(g); g.connect(out); o.start(s); o.stop(s + d + 0.02);
    }
  }
  function cricket(ctx, out, t) {          // сверчок: быстрые «трели» на одной высоте
    const d = rnd(0.8, 1.6), o = ctx.createOscillator(), g = ctx.createGain(), am = ctx.createOscillator(), ag = ctx.createGain();
    o.type = 'sine'; o.frequency.value = rnd(4200, 4600);
    g.gain.value = 0.5; am.type = 'square'; am.frequency.value = rnd(20, 26); ag.gain.value = 0.5; am.connect(ag); ag.connect(g.gain);
    const env = ctx.createGain();
    env.gain.setValueAtTime(0.0001, t); env.gain.linearRampToValueAtTime(0.042, t + 0.08); env.gain.setValueAtTime(0.042, t + d - 0.1); env.gain.linearRampToValueAtTime(0.0001, t + d);
    o.connect(g); g.connect(env); env.connect(out); o.start(t); am.start(t); o.stop(t + d + 0.02); am.stop(t + d + 0.02);
  }
  // Редкие события фона на отрезке [from, to) по звуковым часам; st хранит, когда запланировано следующее.
  function scheduleEvents(ctx, out, code, day, from, to, st, withThunder) {
    const birds = day > 0.35 && (code === 'clear' || code === 'partly');
    const crickets = day <= 0.35 && (code === 'clear' || code === 'partly');
    if (birds) { if (st.bird == null || st.bird < from) st.bird = from + rnd(0.2, 2); while (st.bird < to) { chirp(ctx, out, st.bird); st.bird += rnd(1.4, 5); } }
    if (crickets) { if (st.cricket == null || st.cricket < from) st.cricket = from + rnd(0.2, 1.5); while (st.cricket < to) { cricket(ctx, out, st.cricket); st.cricket += rnd(1.6, 3.2); } }
    if (code === 'storm' && withThunder) {
      if (st.thunder == null || st.thunder < from) st.thunder = from + rnd(3, 9);
      while (st.thunder < to) { thunderSound(ctx, out, st.thunder, Math.random() < 0.4); st.thunder += rnd(8, 18); }
    }
  }

  // ---------- живой звук ----------
  let ac = null, master = null, buses = null;
  let weather = { code: null, day: 1 }, season = null;
  let ambient = null, music = null, lastClick = 0, lastExtThunder = 0, unlocked = false;

  function ensure() {
    if (!ac) {
      const C = window.AudioContext || window.webkitAudioContext;
      if (!C) return null;
      try { ac = new C(); } catch (e) { ac = null; return null; }
      master = ac.createGain(); master.gain.value = volume() * MASTER_K;
      const comp = ac.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 6; comp.attack.value = 0.003; comp.release.value = 0.2;     // чтобы громкие хлопки не «трещали»
      master.connect(comp); comp.connect(ac.destination);
      const bus = (v) => { const g = ac.createGain(); g.gain.value = v; g.connect(master); return g; };
      buses = { wx: bus(0.8), music: bus(0.55), fx: bus(1) };
    }
    return ac;
  }
  const running = () => !!ac && ac.state === 'running';

  function stopAmbient() {
    if (!ambient) return;
    const a = ambient; ambient = null;
    clearInterval(a.timer);
    try { a.out.gain.setTargetAtTime(0, ac.currentTime, 0.4); } catch (e) { /* уже закрыто */ }
    setTimeout(() => { a.srcs.forEach((s) => { try { s.stop(); } catch (e) { /* уже остановлен */ } }); try { a.out.disconnect(); } catch (e) { /* ок */ } }, 1800);
  }
  function startAmbient() {
    if (!running() || !flag('wx') || !weather.code || !LAYERS[weather.code]) { stopAmbient(); return; }
    const key = `${weather.code}|${weather.day > 0.35 ? 'd' : 'n'}`;
    if (ambient && ambient.key === key) return;
    stopAmbient();
    const out = ac.createGain(); out.gain.value = 0; out.connect(buses.wx);
    out.gain.setTargetAtTime(1, ac.currentTime, 0.8);
    const srcs = LAYERS[weather.code](ac, out, weather.day);
    const st = {};
    const tick = () => {
      if (!ambient || ambient.key !== key) return;
      const now = ac.currentTime, own = performance.now() - lastExtThunder > 40000;       // свой гром — только если вспышек на экране нет (рисование выключено)
      scheduleEvents(ac, out, weather.code, weather.day, now, now + 9, st, own);
    };
    ambient = { key, out, srcs, st, timer: setInterval(tick, 4000) };
    tick();
  }
  function stopMusic() {
    if (!music) return;
    const m = music; music = null; m.on = false; clearTimeout(m.timer);
    try { m.out.gain.setTargetAtTime(0, ac.currentTime, 0.06); } catch (e) { /* ок */ }
    setTimeout(() => { try { m.out.disconnect(); } catch (e) { /* ок */ } }, 500);
  }
  function startMusic() {
    if (!running() || !flag('music') || !season || !MUSIC[season]) { stopMusic(); return; }
    if (music && music.id === season) return;
    stopMusic();
    const out = ac.createGain(); out.gain.value = 1; out.connect(buses.music);
    const m = { id: season, out, on: true, timer: 0 };
    const play = () => {
      if (!m.on) return;
      const len = scheduleMelody(ac, out, m.id, ac.currentTime + 0.15);
      m.timer = setTimeout(play, (len + MUSIC[m.id].gap) * 1000);
    };
    music = m; play();
  }
  function refresh() {
    if (!ac && !(flag('wx') || flag('music') || flag('fx'))) return;       // ничего не включено — AudioContext даже не создаём
    if (!ensure()) return;
    master.gain.setTargetAtTime(volume() * MASTER_K, ac.currentTime, 0.05);
    if (!running()) { try { ac.resume().then(() => { if (running()) refresh(); }); } catch (e) { /* ждём нажатия */ } return; }
    startAmbient(); startMusic();
  }
  // Браузер разрешает звук только после действия человека: первое нажатие/клавиша «размораживает» звук.
  function onGesture() {
    if (!(flag('wx') || flag('music') || flag('fx'))) return;
    if (!ensure()) return;
    if (ac.state !== 'running') { try { ac.resume().then(() => { unlocked = true; refresh(); }); } catch (e) { /* не страшно */ } } else refresh();
  }
  ['pointerdown', 'keydown', 'touchstart'].forEach((ev) => document.addEventListener(ev, onGesture, { capture: true, passive: true }));
  document.addEventListener('visibilitychange', () => {
    if (!ac) return;
    if (document.hidden) { try { ac.suspend(); } catch (e) { /* ок */ } } else if (flag('wx') || flag('music') || flag('fx')) { try { ac.resume(); } catch (e) { /* ок */ } }
  });
  document.addEventListener('lc-weather', (e) => { weather = { code: e.detail.code, day: e.detail.day == null ? 1 : e.detail.day }; if (ac) startAmbient(); });
  document.addEventListener('lc-season', (e) => { season = e.detail.id; if (ac) startMusic(); });

  // Нажатия: звук текущего праздника на кнопках, ссылках и переключателях (не на пустом месте и не на каждом движении мыши).
  document.addEventListener('pointerdown', (e) => {
    if (!flag('fx') || !season || !CLICK[season]) return;
    const el = e.target.closest && e.target.closest('button, a[href], [role="button"], summary, select, label, input[type="checkbox"], input[type="radio"], [data-lc-theme]');
    if (!el || el.disabled) return;
    const now = performance.now();
    if (now - lastClick < 70) return;
    lastClick = now;
    if (!ensure() || !running()) return;
    try { CLICK[season](ac, buses.fx, ac.currentTime + 0.005); } catch (err) { /* звук не обязателен */ }
  }, { capture: true, passive: true });

  function play(builder, ...args) { if (flag('fx') && ensure() && running()) { try { builder(ac, buses.fx, ac.currentTime + 0.01, ...args); } catch (e) { /* ок */ } } }

  // ---------- проверки без колонок: рендер в буфер и анализ ----------
  function offline(seconds, rate) {
    const C = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new C(1, Math.round((rate || 22050) * seconds), rate || 22050);
  }
  function stats(buf) {
    const d = buf.getChannelData(0);
    let peak = 0, sum = 0;
    for (let i = 0; i < d.length; i++) { const v = Math.abs(d[i]); if (v > peak) peak = v; sum += d[i] * d[i]; }
    return { peak: +peak.toFixed(3), rms: +Math.sqrt(sum / d.length).toFixed(4), len: d.length };
  }
  // spec: {kind:'music', id} | {kind:'click', id} | {kind:'fx', id} | {kind:'ambient', code, day} | {kind:'thunder'}
  async function render(spec, seconds) {
    const c = offline(seconds), out = c.createGain(); out.gain.value = 0.9; out.connect(c.destination);
    if (spec.kind === 'music') scheduleMelody(c, out, spec.id, 0.05);
    else if (spec.kind === 'click') CLICK[spec.id](c, out, 0.05);
    else if (spec.kind === 'fx') FX[spec.id](c, out, 0.05);
    else if (spec.kind === 'thunder') thunderSound(c, out, 0.05, true);
    else if (spec.kind === 'ambient') { LAYERS[spec.code](c, out, spec.day == null ? 1 : spec.day); scheduleEvents(c, out, spec.code, spec.day == null ? 1 : spec.day, 0, seconds, {}, true); }
    return stats(await c.startRendering());
  }
  // Проверка высоты: первая нота мелодии должна звучать именно на своей высоте (энергия на нужной частоте больше, чем на соседних полутонах).
  async function detect(id) {
    const m = MUSIC[id], first = m.seq.find((n) => n.m != null), idx = m.seq.indexOf(first);
    const rate = 22050, beat = 60 / m.bpm, lead = m.seq.slice(0, idx).reduce((a, n) => a + n.b, 0) * beat;
    const c = offline(lead + 1.2, rate), out = c.createGain(); out.connect(c.destination);
    scheduleMelody(c, out, id, 0);
    const d = (await c.startRendering()).getChannelData(0);
    const from = Math.round((lead + 0.03) * rate), len = Math.round(Math.min(first.b * beat * 0.8, 0.4) * rate);
    const goertzel = (f) => {
      const w = 2 * Math.PI * f / rate, co = 2 * Math.cos(w); let s1 = 0, s2 = 0;
      for (let i = 0; i < len; i++) { const s = d[from + i] + co * s1 - s2; s2 = s1; s1 = s; }
      return s1 * s1 + s2 * s2 - co * s1 * s2;
    };
    let best = 0, bestE = -1;
    for (let k = -3; k <= 3; k++) { const e = goertzel(hz(first.m + k)); if (e > bestE) { bestE = e; best = k; } }
    return best;                                     // 0 — высота верная
  }

  window.LCSound = {
    MUSIC_IDS: Object.keys(MUSIC), CLICK_IDS: Object.keys(CLICK), WEATHER_CODES: Object.keys(LAYERS),
    get(k) { return k === 'vol' ? Math.round(volume() * 100) : (flag(k) ? '1' : '0'); },
    set(k, v) {
      store.set(KEYS[k], v === '1' || v === 1 || v === true ? '1' : '0');
      if (flag(k)) { if (!season && window.LCSeason) season = window.LCSeason.selected(); }
      if (k === 'wx' && !flag('wx')) stopAmbient();
      if (k === 'music' && !flag('music')) stopMusic();
      refresh();
    },
    setVolume(n) { store.set(VOL, String(Math.max(0, Math.min(100, Math.round(n))))); if (master) master.gain.setTargetAtTime(volume() * MASTER_K, ac.currentTime, 0.05); },
    // «Проверить звук»: звук нажатия текущего праздника и кусочек мелодии (или аккорд, если праздника нет). Работает, даже если звуки выключены.
    test() {
      if (!ensure()) return false;
      const go = () => {
        const t = ac.currentTime + 0.05, id = season || (window.LCSeason && window.LCSeason.selected());
        if (id && CLICK[id]) { CLICK[id](ac, buses.fx, t); const o = ac.createGain(); o.connect(buses.music); o.gain.value = 1; const seq = MUSIC[id].seq; const beat = 60 / MUSIC[id].bpm; let tt = t + 0.6; for (const n of seq.slice(0, 8)) { if (n.m != null) tone(ac, o, tt, hz(n.m), n.b * beat * 0.92, TIMBRE[MUSIC[id].timbre]); tt += n.b * beat; } }
        else { [523.25, 659.25, 783.99].forEach((f, i) => tone(ac, buses.fx, t + i * 0.12, f, 0.4, { pluck: true, ring: 0.8, gain: 0.15 })); }
      };
      if (ac.state !== 'running') ac.resume().then(go); else go();
      return true;
    },
    fx(kind) { if (flag('fx')) play(FX[kind]); },
    thunder() {
      if (!flag('wx') || !(weather.code === 'storm' || weather.code === 'rain')) return;
      lastExtThunder = performance.now();
      if (!ensure() || !running()) return;
      const d = rnd(0.3, 1.6);                       // молния видна сразу, гром — с задержкой
      try { thunderSound(ac, buses.wx, ac.currentTime + d, Math.random() < 0.5); } catch (e) { /* ок */ }
    },
    state() { return { created: !!ac, running: running(), ambient: ambient ? ambient.key : null, music: music ? music.id : null, weather: { ...weather }, season, unlocked }; },
    render, detect, melodyLength,
  };
  // На случай, если события погоды и праздника пришли раньше загрузки этого файла.
  setTimeout(() => { if (!season && window.LCSeason) season = window.LCSeason.selected(); if (window.LCFx && window.LCFx.weatherNow) { const w = window.LCFx.weatherNow(); if (w && !weather.code) weather = w; } }, 0);
})();
