// Живой фон и мелкие анимации. Подключается на всех страницах после theme.js.
//
//  • Фон по погоде в Краснодаре: облака, дождь, снег, гроза, туман, солнце, луна и звёзды. Освещение считается по настоящему
//    положению Солнца (высота над горизонтом в этот час): днём светло, у горизонта свет тёплый (рассвет/закат), в сумерках и
//    ночью небо темнеет, а облака, дождь и снег меняют цвет; солнце и луна двигаются по небу. Это относится ко ВСЕМ видам погоды.
//    Погоду отдаёт сервер (GET /api/weather; источник и периодичность — «Настройки → Погода и фон…»); если у сервера нет интернета,
//    в режимах «Авто» и «Open-Meteo» браузер спрашивает Open-Meteo сам. Нет погоды — чистое небо по времени суток.
//    В меню темы погоду можно выбрать вручную или выключить; снег — точками или пархающими снежинками разных форм (fxSnow).
//  • Лёгкая нагрузка: один <canvas> позади страницы, 20–30 кадров в секунду, небо (свет, закат, звёздное небо, солнце, луна)
//    рисуется в отдельный слой раз в минуту, спрайты облаков — только когда заметно меняется цвет, при скрытой вкладке и при
//    «Эффекты: выкл» ничего не считается. «Авто» на слабом компьютере (≤4 ядер или ≤4 ГБ памяти) включает «Лёгкие».
//  • Анимации интерфейса: плавное появление блоков, «пружинящие» окна, волна на кнопках — только transform/opacity.
//    Уровень эффектов (Авто/Полные/Лёгкие/Выкл) — атрибут data-fx на <html>; «Выкл» и системная настройка «уменьшить движение»
//    отключают всё.
(function () {
  'use strict';
  const root = document.documentElement;
  const store = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* не страшно */ } },
  };
  const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---------- уровень эффектов ----------
  function level() {
    if (reduceMotion()) return 'off';
    const pref = store.get('fxLevel', 'auto');
    if (pref !== 'auto') return pref;
    const weak = (navigator.hardwareConcurrency && navigator.hardwareConcurrency <= 4) || (navigator.deviceMemory && navigator.deviceMemory <= 4);
    return weak ? 'lite' : 'full';
  }
  function applyLevel() { root.setAttribute('data-fx', level()); }
  applyLevel();

  // ---------- погода ----------
  const WX_LABEL = { clear: 'ясно', partly: 'малооблачно', clouds: 'облачно', rain: 'дождь', snow: 'снег', storm: 'гроза', fog: 'туман' };
  const WMO = (c) => (c === 0 ? 'clear' : c <= 2 ? 'partly' : c === 3 ? 'clouds' : (c === 45 || c === 48) ? 'fog'
    : ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(c)) ? 'rain' : ([71, 73, 75, 77, 85, 86].includes(c)) ? 'snow'
    : c >= 95 ? 'storm' : 'clouds');
  const DEFAULT_LOC = { lat: 45.0355, lon: 38.9753, city: 'Краснодар' };
  const DEFAULT_REFRESH_MIN = 60;
  let weather = null;           // ответ сервера: { code, temp, source, lat, lon, city, refresh_minutes }
  let lastLoad = 0;
  let testDate = null;          // для проверки: LCFx.setTestTime('2026-10-13T16:30:00Z') — «подменить» текущее время
  const nowDate = () => (testDate ? new Date(testDate) : new Date());
  const refreshMs = () => Math.max(10, (weather && weather.refresh_minutes) || DEFAULT_REFRESH_MIN) * 60000;

  async function fetchWeather() {
    try {
      const cached = JSON.parse(store.get('lcWeather', 'null'));
      if (cached && cached.d && Date.now() - cached.t < ((cached.d.refresh_minutes || DEFAULT_REFRESH_MIN) * 60000 - 30000)) return cached.d;
    } catch (e) { /* битый кэш */ }
    const remember = (d) => { store.set('lcWeather', JSON.stringify({ t: Date.now(), d })); return d; };
    let loc = DEFAULT_LOC;
    let allowBrowser = true;
    try {
      const r = await fetch('/api/weather', { credentials: 'same-origin' });
      const d = await r.json();
      if (d && d.lat != null) loc = { lat: d.lat, lon: d.lon, city: d.city || DEFAULT_LOC.city };
      if (d && d.ok) return remember(d);
      if (d && d.browser_fallback === false) allowBrowser = false;       // выбран источник, который браузер спросить не может
    } catch (e) { /* сервер без интернета или без погоды — спросим сами */ }
    if (!allowBrowser) return null;
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 6000);
      const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${loc.lat}&longitude=${loc.lon}&current=temperature_2m,weather_code,is_day,cloud_cover,precipitation,wind_speed_10m&timezone=auto`, { signal: ctl.signal });
      clearTimeout(timer);
      const j = await r.json();
      const cur = j.current;
      return remember({ ok: true, code: WMO(cur.weather_code), temp: cur.temperature_2m, cloud: cur.cloud_cover != null ? cur.cloud_cover / 100 : undefined, precip: cur.precipitation, wind: cur.wind_speed_10m != null ? cur.wind_speed_10m / 3.6 : undefined, source: 'Open-Meteo (из браузера)', lat: loc.lat, lon: loc.lon, city: loc.city, refresh_minutes: DEFAULT_REFRESH_MIN });
    } catch (e) { return null; }
  }

  // Сила погоды: облачность 0…1, осадки мм/ч, ветер м/с. Сервер отдаёт их вместе с видом погоды (app/services/weather.py); нет чисел (погода выбрана вручную, старый кэш) — берутся
  // типичные для вида погоды. Облачность определяет, сколько облаков и насколько они плотные (до полного закрытия Солнца), осадки — густоту дождя и снега, ветер — наклон и скорость.
  const LEVELS = { clear: [0.05, 0, 2], partly: [0.4, 0, 3], clouds: [0.92, 0, 4], rain: [0.92, 2.5, 5], snow: [0.9, 1, 3], storm: [0.97, 9, 11], fog: [0.6, 0, 1] };
  function withLevels(code, src) {
    const d = LEVELS[code] || LEVELS.clouds;
    const num = (v, lo, hi, dflt) => (typeof v === 'number' && isFinite(v) ? Math.max(lo, Math.min(hi, v)) : dflt);
    let cloud = num(src && src.cloud, 0, 1, d[0]), precip = num(src && src.precip, 0, 60, d[1]);
    const wind = num(src && src.wind, 0, 40, d[2]);
    if (code === 'rain' || code === 'snow' || code === 'storm') { precip = Math.max(precip, code === 'storm' ? 4 : 0.3); cloud = Math.max(cloud, 0.8); }
    else if (code === 'clouds') cloud = Math.max(cloud, 0.6);
    else if (code === 'clear') { cloud = Math.min(cloud, 0.3); precip = 0; }
    else if (code === 'partly') { cloud = Math.max(0.15, Math.min(0.8, cloud)); precip = 0; }
    return { code, cloud, precip, wind };
  }

  // Что рисовать на фоне. По умолчанию — НИЧЕГО (меню темы → «Погода на фоне»: «Без погоды»); включается выбором вручную или «По погоде (авто)».
  const WX_DEFAULT = 'none';
  const soundWeatherOn = () => store.get('lcSndWx', '0') === '1';       // звуки погоды (static/js/sounds.js) включены?
  // Какой вид погоды рисовать: выбранный вручную, полученный от сервиса, а если ничего нет — чистое небо по времени суток.
  function effective() {
    const forced = store.get('fxWeather', WX_DEFAULT);
    if (forced === 'none') return null;
    if (forced !== 'auto') return withLevels(forced, null);
    return withLevels(weather ? weather.code : 'clear', weather);
  }

  // ---------- Солнце, Луна, освещение ----------
  const RAD = Math.PI / 180;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const clampR = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
  const rgba = (c, a) => `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${a})`;

  // Высота Солнца (градусы) и часовой угол (радианы, 0 в полдень, до полудня < 0) — упрощённая формула NOAA.
  function sunPos(lat, lon, date) {
    const y0 = Date.UTC(date.getUTCFullYear(), 0, 0);
    const day = Math.floor((date.getTime() - y0) / 86400000);
    const frac = (2 * Math.PI / 365) * (day - 1 + (date.getUTCHours() - 12) / 24);
    const eq = 229.18 * (0.000075 + 0.001868 * Math.cos(frac) - 0.032077 * Math.sin(frac) - 0.014615 * Math.cos(2 * frac) - 0.040849 * Math.sin(2 * frac));
    const decl = 0.006918 - 0.399912 * Math.cos(frac) + 0.070257 * Math.sin(frac) - 0.006758 * Math.cos(2 * frac) + 0.000907 * Math.sin(2 * frac)
      - 0.002697 * Math.cos(3 * frac) + 0.00148 * Math.sin(3 * frac);
    const mins = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    const ha = ((mins + eq + 4 * lon - 720) / 4) * RAD;
    const la = lat * RAD;
    const elev = Math.asin(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(ha)) / RAD;
    const ang = ((((ha + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)) - Math.PI;
    return { elev, ang };
  }
  function computeSky() {
    const L = weather && weather.lat != null ? weather : DEFAULT_LOC;
    const { elev, ang } = sunPos(L.lat, L.lon, nowDate());
    return {
      elev, ang,
      day: smooth(-8, 10, elev),                       // освещённость: 0 — ночь … 1 — день
      warm: Math.exp(-Math.pow((elev - 1.5) / 6, 2)),  // тёплый свет у горизонта (рассвет, закат)
      star: smooth(-3, -10, elev),                     // видимость звёзд
    };
  }
  function phaseLabel(s) {
    if (s.elev > 8) return 'день';
    if (s.elev > 0) return s.ang < 0 ? 'утро' : 'вечер';
    if (s.elev > -8) return s.ang < 0 ? 'рассвет' : 'сумерки';
    return 'ночь';
  }
  // Сколько света Солнца/Луны доходит до земли при разной погоде и как сильно виден закатный отсвет.
  // Солнце и Луна закрываются самими облаками (см. occlusionAt: плывущее облако перекрывает их, а при сплошной облачности они скрыты совсем), поэтому здесь —
  // только то, что гасит свет помимо облаков: туман, снег, дождь, гроза.
  const SUN_DIM = { fog: 0.3, snow: 0.3, rain: 0.12, storm: 0.05 };
  const MOON_DIM = { fog: 0.25, snow: 0.25, rain: 0.08, storm: 0.04 };
  const deckOf = (cloud) => 1 - 0.97 * smooth(0.6, 0.95, cloud);        // сплошной слой: при облачности ≥ 95 % Солнце не видно
  const GLOW_COVER = { clear: 1, partly: 0.9, clouds: 0.55, fog: 0.5, snow: 0.45, rain: 0.3, storm: 0.2 };

  // ---------- холст ----------
  let cv = null, ctx = null, W = 0, H = 0, raf = 0, lastT = 0, state = null, parts = [], sprites = {}, flash = 0, nextFlash = 0, skyCv = null, sunCv = null, moonCv = null, moonImg = null;
  const rnd = (a, b) => a + Math.random() * (b - a);
  const isLight = () => root.getAttribute('data-theme') === 'light';
  const seeded = (seed) => () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

  function makeCloud(w, h, alpha, rgb, seed) {
    const r = seeded(seed), R = (a, b) => a + r() * (b - a);       // форма облака при перекраске остаётся прежней
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    const col = `${rgb[0]},${rgb[1]},${rgb[2]}`, shade = rgb.map((v) => Math.round(v * 0.74)).join(',');
    const puffs = [];
    for (let i = 0; i < 9; i++) puffs.push({ rx: R(w * 0.1, w * 0.2), ry: R(h * 0.16, h * 0.3), x: R(w * 0.26, w * 0.74), y: R(h * 0.38, h * 0.58) });
    const puff = (p, color, a, dy) => {
      const m = Math.max(p.rx, p.ry), y = p.y + dy;
      const rg = g.createRadialGradient(p.x, y, 0, p.x, y, m);
      rg.addColorStop(0, `rgba(${color},${a})`); rg.addColorStop(1, `rgba(${color},0)`);
      g.fillStyle = rg;
      g.save(); g.translate(p.x, y); g.scale(p.rx / m, p.ry / m); g.translate(-p.x, -y);
      g.beginPath(); g.arc(p.x, y, m, 0, Math.PI * 2); g.fill(); g.restore();
    };
    for (const p of puffs) puff(p, shade, alpha * 0.9, p.ry * 0.5);       // тёмное «брюхо» снизу — облако выглядит объёмным
    for (const p of puffs) puff(p, col, alpha, 0);
    // край спрайта плавно сводится к нулю — иначе у облака видна прямоугольная рамка
    g.globalCompositeOperation = 'destination-in';
    g.save(); g.translate(w / 2, h / 2); g.scale(1, h / w);
    const m = g.createRadialGradient(0, 0, 0, 0, 0, w / 2);
    m.addColorStop(0, 'rgba(0,0,0,1)'); m.addColorStop(0.7, 'rgba(0,0,0,.85)'); m.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = m; g.fillRect(-w / 2, -w / 2, w, w);
    g.restore();
    return c;
  }

  // Цвет облаков зависит от освещения: днём светлые, на закате тёплые, ночью тёмные; грозовые и дождевые темнее. Плотность (прозрачность) — от облачности:
  // редкие облака лёгкие, при сплошной облачности — плотные и хорошо видны на любом фоне.
  function cloudStyle() {
    const s = state.sky, light = state.light, code = state.code, cloud = state.cloud;
    const dayC = light ? [100, 116, 139] : [203, 213, 225], nightC = light ? [48, 62, 112] : [86, 102, 146];
    let c = mix(nightC, dayC, s.day);
    c = mix(c, light ? [196, 102, 62] : [255, 170, 118], s.warm * 0.5 * (GLOW_COVER[code] || 1));
    if (code === 'storm') c = c.map((v) => v * 0.72);
    else if (code === 'rain' || code === 'snow') c = c.map((v) => v * (1 - 0.22 * (code === 'rain' ? state.rainLvl : 0.5)));
    if (code === 'fog') {                      // туман — плотная серо-белая дымка, заметная и на тёмном, и на светлом фоне
      const fogDay = light ? [118, 130, 150] : [214, 222, 233], fogNight = light ? [58, 72, 118] : [112, 128, 170];
      c = mix(mix(fogNight, fogDay, s.day), light ? [196, 112, 72] : [255, 190, 140], s.warm * 0.3);
      return { rgb: c.map((v) => Math.round(v / 6) * 6), alpha: +(0.3 * (0.8 + 0.2 * s.day)).toFixed(2) };
    }
    const base = code === 'storm' ? 0.34 : 0.19 + 0.27 * cloud;
    return { rgb: c.map((v) => Math.round(v / 6) * 6), alpha: +(base * (light ? 1.1 : 1) * (0.75 + 0.25 * s.day)).toFixed(2) };
  }
  function buildClouds(keepPositions) {
    const st = cloudStyle();
    const key = `${st.rgb.join(',')}|${st.alpha}`;
    if (sprites.key === key) return;                      // цвет почти не изменился — спрайты не перерисовываем
    sprites.key = key;
    sprites.cloud = [11, 22, 33].map((seed) => makeCloud(520, 220, st.alpha, st.rgb, seed));
    if (keepPositions && sprites.list) sprites.list.forEach((c, i) => { c.img = sprites.cloud[i % 3]; });
  }
  // Насколько облака закрывают точку неба (0 — чистое небо, 1 — закрыта полностью): у каждого облака — эллипс с мягким краем, густота зависит от облачности.
  function occlusionAt(x, y) {
    if (!sprites.list) return 0;
    let open = 1;
    for (const c of sprites.list) {
      if (c.fog) continue;
      const w = c.w, h = w * 0.42;
      const dx = (x - (c.x + w / 2)) / (w * 0.36), dy = (y - (c.y + h / 2)) / (h * 0.34);
      open *= 1 - c.dens * (1 - smooth(0.55, 1, Math.sqrt(dx * dx + dy * dy)));
    }
    return 1 - open;
  }
  // Где на экране Солнце и Луна (путь по небу): Солнце — слева направо (чуть правее центра, чтобы в полдень не прятаться за блоком страницы), Луна — напротив.
  function bodyPos(s) {
    return {
      sx: W * (0.6 + 0.37 * Math.sin(s.ang)), sy: H * clampR(0.88 - 1.05 * Math.sin(Math.max(s.elev, 0) * RAD), 0.1, 0.9),
      mx: W * (0.4 - 0.37 * Math.sin(s.ang)), my: H * clampR(0.88 - 1.05 * Math.sin(Math.max(-s.elev, 0) * RAD), 0.1, 0.9),
    };
  }

  // Луна с настоящей фазой (возраст в долях синодического месяца).
  function makeMoon(light) {
    const age = ((((nowDate().getTime() / 86400000 + 2440587.5 - 2451550.1) / 29.530588853) % 1) + 1) % 1;
    const S = 96, r = 22, cx = S / 2, cy = S / 2, k = Math.cos(2 * Math.PI * age);       // 1 — новолуние … −1 — полнолуние
    const c = document.createElement('canvas');
    c.width = c.height = S;
    const g = c.getContext('2d');
    const lit = light ? 'rgba(79,82,221,.75)' : 'rgba(244,247,255,.95)';
    g.fillStyle = lit;
    g.beginPath(); g.arc(cx, cy, r, -Math.PI / 2, Math.PI / 2, age >= 0.5); g.closePath(); g.fill();      // освещённая половина (растёт — справа)
    g.beginPath(); g.ellipse(cx, cy, Math.max(r * Math.abs(k), 0.01), r, 0, 0, Math.PI * 2);
    if (k > 0) { g.globalCompositeOperation = 'destination-out'; g.fillStyle = '#000'; } else { g.fillStyle = lit; }
    g.fill();
    g.globalCompositeOperation = 'source-over';
    g.strokeStyle = light ? 'rgba(79,82,221,.25)' : 'rgba(199,210,254,.22)'; g.lineWidth = 1;
    g.beginPath(); g.arc(cx, cy, r, 0, Math.PI * 2); g.stroke();
    return c;
  }

  // Небо: затемнение ночью, туман, сплошная облачность, закатный отсвет — одним слоем (skyCv); Солнце и Луна — каждое своим слоем (sunCv, moonCv), чтобы в каждом кадре
  // менять их яркость в зависимости от того, какое облако сейчас над ними проплывает. Рисуется раз в минуту.
  function bodyCanvas() {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  }
  function renderSky() {
    const s = state.sky, code = state.code, light = state.light, cloud = state.cloud;
    if (!skyCv) skyCv = document.createElement('canvas');
    skyCv.width = W; skyCv.height = H;
    const g = skyCv.getContext('2d');
    const dimSun = SUN_DIM[code] != null ? SUN_DIM[code] : 1, dimMoon = MOON_DIM[code] != null ? MOON_DIM[code] : 1;
    const glowCover = (code === 'clear' || code === 'partly') ? 1 - 0.5 * cloud : (GLOW_COVER[code] != null ? GLOW_COVER[code] : 0.5);
    const { sx, sy, mx, my } = bodyPos(s);
    state.sunX = sx; state.sunY = sy; state.moonX = mx; state.moonY = my;
    // ночное затемнение: сверху сильнее, к горизонту слабее
    if (s.day < 0.98) {
      const a = (1 - s.day) * (light ? 0.17 : 0.3);
      const v = g.createLinearGradient(0, 0, 0, H);
      const col = light ? [30, 41, 100] : [4, 8, 30];
      v.addColorStop(0, rgba(col, a)); v.addColorStop(1, rgba(col, a * 0.3));
      g.fillStyle = v; g.fillRect(0, 0, W, H);
    }
    // туман: сплошная дымка на весь экран, к земле плотнее
    if (code === 'fog') {
      const fogDay = light ? [128, 140, 160] : [196, 206, 220], fogNight = light ? [64, 78, 124] : [96, 112, 156];
      const fc = mix(fogNight, fogDay, s.day);
      const vg = g.createLinearGradient(0, 0, 0, H);
      vg.addColorStop(0, rgba(fc, light ? 0.1 : 0.1)); vg.addColorStop(0.5, rgba(fc, light ? 0.2 : 0.2)); vg.addColorStop(1, rgba(fc, light ? 0.36 : 0.4));
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    // сплошная облачность: пасмурное небо — серая пелена на весь экран, тем плотнее, чем больше облачность (сверху плотнее)
    if (code !== 'fog' && cloud > 0.35) {
      const st = cloudStyle();
      const a = (light ? 0.3 : 0.2) * smooth(0.35, 1, cloud) * (0.7 + 0.3 * s.day);
      const vg = g.createLinearGradient(0, 0, 0, H);
      vg.addColorStop(0, rgba(st.rgb, a)); vg.addColorStop(1, rgba(st.rgb, a * 0.55));
      g.fillStyle = vg; g.fillRect(0, 0, W, H);
    }
    // закатный/рассветный отсвет у горизонта, в стороне Солнца
    if (s.warm > 0.03) {
      const a = (light ? 0.4 : 0.34) * s.warm * glowCover;
      const rg = g.createRadialGradient(sx, H * 1.04, 0, sx, H * 1.04, W * 0.85);
      rg.addColorStop(0, `rgba(255,140,60,${a})`); rg.addColorStop(0.5, `rgba(255,120,80,${a * 0.42})`); rg.addColorStop(1, 'rgba(255,120,80,0)');
      g.fillStyle = rg; g.fillRect(0, 0, W, H);
      const hz = g.createLinearGradient(0, H * 0.55, 0, H);                  // широкая тёплая полоса у нижнего края
      hz.addColorStop(0, 'rgba(255,130,90,0)'); hz.addColorStop(1, `rgba(255,130,90,${a * 0.35})`);
      g.fillStyle = hz; g.fillRect(0, H * 0.55, W, H * 0.45);
    }
    const open = code === 'clear' || code === 'partly' || (code === 'clouds' && cloud < 0.85);      // видны ли диски Солнца и Луны (сквозь просветы)
    // Солнце: сияние (теплее у горизонта) и диск; яркость в кадре умножается на «просвет» между облаками
    const sunVis = smooth(-3, 3, s.elev) * dimSun * deckOf(cloud);
    state.sunVis = sunVis;
    sunCv = null;
    if (sunVis > 0.01) {
      sunCv = bodyCanvas();
      const b = sunCv.getContext('2d');
      const col = mix([253, 224, 71], [255, 150, 70], s.warm), r = Math.min(W, H) * (0.4 + 0.28 * s.warm);
      const rg = b.createRadialGradient(sx, sy, 0, sx, sy, r);
      rg.addColorStop(0, rgba(col, (light ? 0.34 : 0.2) * sunVis)); rg.addColorStop(0.35, rgba(col, (light ? 0.12 : 0.07) * sunVis)); rg.addColorStop(1, rgba(col, 0));
      b.fillStyle = rg; b.fillRect(0, 0, W, H);
      if (open) {
        const dg = b.createRadialGradient(sx, sy, 0, sx, sy, 34);
        const core = mix([255, 252, 235], [255, 200, 130], s.warm);
        dg.addColorStop(0, rgba(core, 0.95 * sunVis)); dg.addColorStop(0.5, rgba(core, 0.6 * sunVis)); dg.addColorStop(1, rgba(core, 0));
        b.fillStyle = dg; b.fillRect(sx - 40, sy - 40, 80, 80);
      }
    }
    // Луна: ореол и (в просветах) диск с фазой
    const moonVis = smooth(3, -5, s.elev) * dimMoon * deckOf(cloud);
    state.moonVis = moonVis;
    moonCv = null;
    if (moonVis > 0.01) {
      moonCv = bodyCanvas();
      const b = moonCv.getContext('2d');
      const mr = Math.min(W, H) * 0.3, rg = b.createRadialGradient(mx, my, 0, mx, my, mr);
      rg.addColorStop(0, light ? `rgba(99,102,241,${0.14 * moonVis})` : `rgba(199,210,254,${0.16 * moonVis})`); rg.addColorStop(1, 'rgba(199,210,254,0)');
      b.fillStyle = rg; b.fillRect(0, 0, W, H);
      if (open) {
        if (!moonImg) moonImg = makeMoon(light);
        b.globalAlpha = Math.min(1, moonVis);
        b.drawImage(moonImg, mx - 48, my - 48);
        b.globalAlpha = 1;
      }
    }
  }

  // Снежинки: несколько форм, нарисованных один раз в маленькие спрайты (цвет — по освещению и теме); в кадре их только
  // поворачивают, «переворачивают» (будто кувыркаются) и сносят ветром — это дёшево.
  const FLAKE_DRAW = [
    (g) => { arms(g, 6, () => { line(g, 0, 0, 0, -26); line(g, 0, -12, 7, -19); line(g, 0, -12, -7, -19); line(g, 0, -19, 5, -25); line(g, 0, -19, -5, -25); }); },                       // классическая
    (g) => { arms(g, 6, () => { line(g, 0, 0, 0, -23); g.beginPath(); g.arc(0, -26, 3.4, 0, 6.2832); g.fill(); line(g, 0, -10, 6, -16); line(g, 0, -10, -6, -16); }); },                   // с «бусинами»
    (g) => { g.beginPath(); for (let i = 0; i < 6; i++) { const a = (Math.PI / 3) * i; g.lineTo(Math.cos(a) * 22, Math.sin(a) * 22); } g.closePath(); g.stroke(); arms(g, 6, () => line(g, 0, 0, 0, -22)); g.beginPath(); g.arc(0, 0, 3.2, 0, 6.2832); g.fill(); },   // шестиугольник
    (g) => { arms(g, 6, () => { line(g, 0, 0, 0, -27); line(g, 0, -8, 5, -13); line(g, 0, -8, -5, -13); line(g, 0, -15, 7, -21); line(g, 0, -15, -7, -21); line(g, 0, -22, 4, -27); line(g, 0, -22, -4, -27); }); },   // «папоротник»
    (g) => { const rg = g.createRadialGradient(0, 0, 0, 0, 0, 20); rg.addColorStop(0, g.fillStyle); rg.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = rg; g.beginPath(); g.arc(0, 0, 20, 0, 6.2832); g.fill(); },   // пушистая
    (g) => { arms(g, 4, () => { line(g, 0, 0, 0, -25); line(g, 0, -13, 6, -19); line(g, 0, -13, -6, -19); }); arms(g, 4, () => line(g, 0, 0, 0, -13), Math.PI / 4); },                          // крестик-звёздочка
  ];
  function arms(g, n, fn, offset = 0) { for (let i = 0; i < n; i++) { g.save(); g.rotate(offset + (Math.PI * 2 * i) / n); fn(); g.restore(); } }
  function line(g, x1, y1, x2, y2) { g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); }
  function buildSnowSprites() {
    if (!state || state.code !== 'snow' || !state.snowFlakes) return;
    const key = state.pal.snowRgb.join(',');
    if (sprites.snowKey === key) return;
    sprites.snowKey = key;
    sprites.flakes = FLAKE_DRAW.map((draw) => {
      const c = document.createElement('canvas');
      c.width = c.height = 64;
      const g = c.getContext('2d');
      g.translate(32, 32);
      g.strokeStyle = g.fillStyle = `rgb(${key})`;
      g.lineWidth = 2.6; g.lineCap = 'round'; g.lineJoin = 'round';
      draw(g);
      return c;
    });
  }

  // Цвета дождя и снега по освещению (днём светлые, ночью приглушённые, у горизонта чуть тёплые).
  function buildPalette() {
    const s = state.sky, light = state.light;
    const rainDay = light ? [59, 98, 170] : [186, 208, 240], rainNight = light ? [40, 56, 122] : [120, 142, 196];
    const rc = mix(mix(rainNight, rainDay, s.day), [255, 190, 150], s.warm * 0.3);
    const k = (0.7 + 0.3 * s.day) * (0.65 + 0.5 * (state.rainLvl || 0));          // сильный дождь — штрихи ярче, морось — бледнее
    state.pal = {
      rain0: rgba(rc, +Math.min(0.9, (light ? 0.24 : 0.32) * k).toFixed(3)), rain1: rgba(rc, +Math.min(0.95, (light ? 0.42 : 0.6) * k).toFixed(3)),
      snow: rgba(mix(light ? [90, 112, 192] : [200, 214, 255], light ? [125, 160, 215] : [255, 255, 255], s.day), +((light ? 0.75 : 0.85) * (0.8 + 0.2 * s.day)).toFixed(3)),
      snowRgb: mix(light ? [90, 112, 192] : [200, 214, 255], light ? [112, 148, 214] : [255, 255, 255], s.day).map((v) => Math.round(v / 8) * 8),
      snowA: +((light ? 0.9 : 0.95) * (0.8 + 0.2 * s.day)).toFixed(3),
    };
    buildSnowSprites();
  }

  // Раз в минуту (и при подмене времени): новое положение Солнца и Луны, цвета, небо.
  function updateSky() {
    if (!state) return;
    state.sky = computeSky();
    moonImg = null;
    buildPalette();
    if (sprites.list) buildClouds(true);
    renderSky();
  }

  // Звуки погоды (static/js/sounds.js) узнают вид погоды и время суток из этого события; рисование при этом может быть выключено.
  function weatherForSound() {
    const forced = store.get('fxWeather', WX_DEFAULT);
    if (forced !== 'auto' && forced !== 'none') return { code: forced };
    if (forced === 'none' && !soundWeatherOn()) return null;           // фон без погоды и звуков погоды нет — сообщать нечего
    return { code: weather ? weather.code : 'clear' };
  }
  function announce() {
    const wx = weatherForSound();
    let day = 1;
    try { day = computeSky().day; } catch (e) { /* без неба — считаем днём */ }
    try { document.dispatchEvent(new CustomEvent('lc-weather', { detail: { code: wx ? wx.code : null, day } })); } catch (e) { /* не страшно */ }
  }

  function setup() {
    const lv = level();
    const wx = effective();
    announce();
    if (lv === 'off' || !wx) { stop(); return; }
    if (!cv) {
      cv = document.createElement('canvas');
      cv.id = 'fxCanvas';
      cv.setAttribute('aria-hidden', 'true');
      cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;z-index:-1;pointer-events:none';
      document.body.insertBefore(cv, document.body.firstChild);
      ctx = cv.getContext('2d', { alpha: true });
    }
    W = cv.width = window.innerWidth;
    H = cv.height = window.innerHeight;
    state = { ...wx, lite: lv === 'lite', light: isLight(), sky: null, snowFlakes: store.get('fxSnow', 'flakes') !== 'dots' };
    state.rainLvl = Math.max(0.12, Math.min(1, Math.sqrt((wx.precip || 0) / 8)));       // 0,5 мм/ч — морось … 8 мм/ч и больше — ливень
    state.snowLvl = Math.max(0.12, Math.min(1, Math.sqrt((wx.precip || 0) / 2.5)));     // снег: 0,3 мм/ч — лёгкий … 2,5 мм/ч — сильный снегопад
    state.sky = computeSky();
    const area = (W * H) / (1920 * 1080);
    const k = (state.lite ? 0.5 : 1) * Math.max(0.5, Math.min(1.4, area));
    parts = [];
    sprites = {};
    moonImg = null;
    const code = wx.code;
    if (code === 'rain' || code === 'storm') {
      const lvl = state.rainLvl, n = Math.round((code === 'storm' ? 190 : 130) * k * (0.3 + lvl));          // капель тем больше, чем сильнее осадки
      for (let i = 0; i < n; i++) parts.push({ x: rnd(0, W), y: rnd(0, H), l: rnd(10, 26) * (0.8 + 0.5 * lvl), v: rnd(520, 880) * (0.85 + 0.3 * lvl), a: rnd(0.15, 0.5) });
    } else if (code === 'snow' && state.snowFlakes) {          // пархающие снежинки: разные формы и размеры, качаются, вращаются, «кувыркаются»
      const lvl = state.snowLvl, wk = 0.7 + state.wind / 8, n = Math.round(64 * k * (0.3 + 1.1 * lvl));
      for (let i = 0; i < n; i++) {
        parts.push({ x: rnd(0, W), y: rnd(-40, H), size: rnd(13, 34), v: rnd(26, 74) * (0.85 + 0.3 * lvl), sway: rnd(14, 44) * wk, ph: rnd(0, 6.28), sp: rnd(0.5, 1.4),
          rot: rnd(0, 6.28), vr: rnd(-1.1, 1.1), tilt: rnd(0, 6.28), tv: rnd(0.8, 2.6), shape: i % FLAKE_DRAW.length, a: rnd(0.55, 1) });
      }
    } else if (code === 'snow') {
      const n = Math.round(120 * k * (0.3 + 1.1 * state.snowLvl));
      for (let i = 0; i < n; i++) parts.push({ x: rnd(0, W), y: rnd(0, H), r: rnd(1, 3.4), v: rnd(28, 85) * (0.85 + 0.3 * state.snowLvl), s: rnd(0.4, 1.4), ph: rnd(0, 6.28), a: rnd(0.35, 0.9) });
    } else if (code === 'clear' || code === 'partly') {                 // звёзды есть всегда, видны — когда стемнеет
      const n = Math.round((code === 'clear' ? 110 : 60) * k);
      for (let i = 0; i < n; i++) parts.push({ x: rnd(0, W), y: rnd(0, H * 0.8), r: rnd(0.4, 1.5), ph: rnd(0, 6.28), sp: rnd(0.6, 2.2) });
    }
    // Облака: сколько их и какие плотные — по облачности (на «ясно» с облачностью 5 % — ни одного, при 40 % — четыре, при сплошной — больше десятка огромных). Часть облаков идёт полосой
    // Солнца (ночью — Луны): так они иногда его закрывают, а при сплошной облачности закрыто всегда.
    if (code === 'fog' || state.cloud >= 0.08) {
      const bp = bodyPos(state.sky);                        // облака выбирают высоту по положению Солнца/Луны — оно нужно уже сейчас (renderSky вызывается ниже)
      state.sunX = bp.sx; state.sunY = bp.sy; state.moonX = bp.mx; state.moonY = bp.my;
      const lite = state.lite ? 0.7 : 1, cloud = state.cloud;
      const cnt = code === 'fog' ? Math.round(9 * lite) : Math.max(1, Math.round((cloud * 11 + (cloud > 0.85 ? 1 : 0)) * lite));
      sprites.list = [];
      buildClouds(false);
      for (let i = 0; i < cnt; i++) {
        sprites.list.push(code === 'fog'
          ? { img: sprites.cloud[i % 3], x: rnd(-600, W), y: rnd(H * 0.1, H * 0.95), w: rnd(900, 1500), v: rnd(3, 11), fog: true }
          : newCloud(i, rnd(-300, W)));
      }
    }
    buildPalette();
    renderSky();
    nextFlash = performance.now() + rnd(4000, 9000) * (1.5 - 0.7 * state.rainLvl);
    start();
  }

  // Облако: ширина растёт с облачностью, скорость — с ветром; высота — либо полоса светила (Солнце днём, Луна ночью), либо любая в верхней половине неба.
  function cloudY(w) {
    const cloud = state.cloud, s = state.sky;
    if (cloud > 0.85) return rnd(-60, H * 0.62);
    if (Math.random() < (cloud < 0.75 ? 0.5 : 0.3)) {
      const by = s.elev > -2 ? state.sunY : state.moonY;
      return by - w * 0.21 + rnd(-0.08 * H, 0.08 * H);
    }
    return rnd(-20, H * 0.5);
  }
  function newCloud(i, x) {
    const cloud = state.cloud, w = rnd(520, 980) * (0.85 + 0.55 * cloud);
    const windK = Math.max(0.5, Math.min(2.2, 0.55 + state.wind / 7));
    return { img: sprites.cloud[i % 3], x, y: cloudY(w), w, v: rnd(6, 20) * windK * (state.code === 'storm' ? 1.4 : 1), dens: 0.55 + 0.45 * cloud };
  }

  function stop() {
    cancelAnimationFrame(raf); raf = 0;
    if (cv) { cv.remove(); cv = null; ctx = null; }
    state = null; skyCv = null; sunCv = null; moonCv = null;
  }
  function start() {
    cancelAnimationFrame(raf);
    lastT = 0;
    raf = requestAnimationFrame(frame);
  }

  const perf = { frames: 0, ms: 0, since: 0 };
  function frame(t) {
    raf = requestAnimationFrame(frame);
    if (document.hidden || !ctx || !state) return;
    const interval = state.lite ? 50 : 33;          // 20 или 30 кадров в секунду
    if (lastT && t - lastT < interval - 2) return;
    const dt = lastT ? Math.min(0.1, (t - lastT) / 1000) : 0.033;
    lastT = t;
    const began = performance.now();
    if (!perf.since) perf.since = began;
    ctx.clearRect(0, 0, W, H);
    const code = state.code, light = state.light, sky = state.sky, pal = state.pal;

    if (skyCv) ctx.drawImage(skyCv, 0, 0);                         // свет, закат, пелена облачности
    // Солнце и Луна: яркость — по тому, сколько их сейчас закрывают проплывающие облака (сплошная облачность скрывает их совсем)
    state.sunOcc = sunCv ? occlusionAt(state.sunX, state.sunY) : 0;
    state.moonOcc = moonCv ? occlusionAt(state.moonX, state.moonY) : 0;
    if (sunCv) { ctx.globalAlpha = 1 - state.sunOcc; ctx.drawImage(sunCv, 0, 0); ctx.globalAlpha = 1; }
    if (moonCv) { ctx.globalAlpha = 1 - state.moonOcc; ctx.drawImage(moonCv, 0, 0); ctx.globalAlpha = 1; }
    const sunShine = state.sunVis * (1 - state.sunOcc);
    if ((code === 'clear' || code === 'partly') && !state.lite && sunShine > 0.5 && sky.day > 0.55) {    // медленно вращающиеся лучи
      const r = Math.min(W, H) * 0.42 * (1 + Math.sin(t / 2600) * 0.05);
      ctx.save(); ctx.translate(state.sunX, state.sunY); ctx.rotate(t / 28000);
      ctx.fillStyle = light ? `rgba(251,191,36,${0.07 * sunShine})` : `rgba(253,224,71,${0.045 * sunShine})`;
      for (let i = 0; i < 12; i++) { ctx.rotate(Math.PI / 6); ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(r * 1.5, -r * 0.07); ctx.lineTo(r * 1.5, r * 0.07); ctx.closePath(); ctx.fill(); }
      ctx.restore();
    }
    if (sky.star > 0.02 && (code === 'clear' || code === 'partly')) {      // звёзды
      ctx.fillStyle = light ? 'rgba(99,102,241,.6)' : 'rgba(255,255,255,.9)';
      for (const s of parts) {
        ctx.globalAlpha = (0.25 + 0.65 * (0.5 + 0.5 * Math.sin(t / 700 * s.sp + s.ph))) * sky.star * (1 - 0.85 * state.cloud);
        ctx.fillRect(s.x, s.y, s.r * 1.6, s.r * 1.6);
      }
      ctx.globalAlpha = 1;
    }

    // облака / туман
    if (sprites.list) {
      for (const c of sprites.list) {
        c.x += c.v * dt;
        if (c.x > W + 40) { c.x = -c.w; c.y = c.fog ? rnd(H * 0.1, H * 0.95) : cloudY(c.w); }
        ctx.drawImage(c.img, c.x, c.y, c.w, c.w * 0.42);
      }
    }

    // дождь
    if (code === 'rain' || code === 'storm') {
      ctx.lineWidth = 1.1; ctx.lineCap = 'round';
      const sx = 0.06 + 0.32 * clamp01(state.wind / 14);        // наклон от ветра
      for (let pass = 0; pass < 2; pass++) {
        ctx.strokeStyle = pass ? pal.rain1 : pal.rain0;
        ctx.beginPath();
        for (let i = pass; i < parts.length; i += 2) {
          const d = parts[i];
          d.y += d.v * dt; d.x -= d.v * dt * sx;
          if (d.y > H) { d.y = -d.l; d.x = rnd(0, W + 120); }
          if (d.x < -30) d.x = W + 20;
          ctx.moveTo(d.x, d.y); ctx.lineTo(d.x + d.l * sx, d.y - d.l);
        }
        ctx.stroke();
      }
    }
    // снег — снежинки
    if (code === 'snow' && state.snowFlakes && sprites.flakes) {
      for (const f of parts) {
        f.y += f.v * dt; f.ph += dt * f.sp; f.x += Math.sin(f.ph) * f.sway * dt; f.rot += f.vr * dt; f.tilt += f.tv * dt;
        if (f.y > H + 36) { f.y = -36; f.x = rnd(0, W); }
        const k = f.size / 64, flip = 0.4 + 0.6 * Math.abs(Math.cos(f.tilt)), cs = Math.cos(f.rot) * k, sn = Math.sin(f.rot) * k;
        ctx.globalAlpha = f.a * pal.snowA;
        ctx.setTransform(cs, sn, -sn * flip, cs * flip, f.x, f.y);
        ctx.drawImage(sprites.flakes[f.shape], -32, -32);
      }
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.globalAlpha = 1;
    }
    // снег — точки
    if (code === 'snow' && !state.snowFlakes) {
      ctx.fillStyle = pal.snow;
      ctx.beginPath();
      for (const f of parts) {
        f.y += f.v * dt; f.ph += dt * f.s;
        f.x += Math.sin(f.ph) * 22 * dt;
        if (f.y > H + 6) { f.y = -6; f.x = rnd(0, W); }
        ctx.moveTo(f.x + f.r, f.y); ctx.arc(f.x, f.y, f.r, 0, 6.2832);
      }
      ctx.fill();
    }
    // гроза: вспышки
    if (code === 'storm') {
      if (t > nextFlash) { flash = 1; nextFlash = t + rnd(5000, 13000) * (1.5 - 0.7 * state.rainLvl); try { if (window.LCSound) window.LCSound.thunder(); } catch (e) { /* звук не обязателен */ } }
      if (flash > 0) {
        ctx.fillStyle = `rgba(220,230,255,${(light ? 0.28 : 0.2) * flash})`;
        ctx.fillRect(0, 0, W, H);
        flash -= dt * 3.2;
      }
    }
    perf.frames += 1;
    perf.ms += performance.now() - began;
  }

  // ---------- мелкие анимации интерфейса ----------
  function ripple(e) {
    if (root.getAttribute('data-fx') !== 'full') return;
    const b = e.target.closest && e.target.closest('button:not(:disabled), a[class*="rounded"]');
    if (!b || b.closest('.lc-menu, .lc-noripple') || getComputedStyle(b).position === 'fixed') return;
    const r = b.getBoundingClientRect();
    if (r.width > 420 || r.height > 120) return;
    const s = document.createElement('span');
    const size = Math.max(r.width, r.height) * 1.6;
    s.className = 'lc-ripple';
    s.style.cssText = `width:${size}px;height:${size}px;left:${e.clientX - r.left - size / 2}px;top:${e.clientY - r.top - size / 2}px`;
    if (getComputedStyle(b).position === 'static') b.style.position = 'relative';
    if (getComputedStyle(b).overflow === 'visible') b.style.overflow = 'hidden';
    b.appendChild(s);
    s.addEventListener('animationend', () => s.remove());
  }
  document.addEventListener('pointerdown', ripple, { passive: true });

  // Блоки страницы появляются по очереди; делается один раз после загрузки.
  function stagger() {
    if (root.getAttribute('data-fx') === 'off') return;
    const items = document.querySelectorAll('body > div > header, body > div > main > *, body > div > section, body > div > div > .glass, #content > *');
    let i = 0;
    items.forEach((el) => {
      if (i > 9 || el.closest('#modal')) return;
      el.style.setProperty('--i', i++);
      el.classList.add('lc-rise');
      el.addEventListener('animationend', () => el.classList.remove('lc-rise'), { once: true });
    });
  }

  // ---------- запуск ----------
  async function loadAndSetup() {
    const pref = store.get('fxWeather', WX_DEFAULT);
    if (pref === 'none' && soundWeatherOn()) announce();            // звук погоды начинается сразу (пока по времени суток), а уточняется, когда придёт погода
    if ((pref === 'auto' && level() !== 'off') || (pref === 'none' && soundWeatherOn())) { weather = await fetchWeather(); lastLoad = Date.now(); }
    setup();
  }
  function refresh() { applyLevel(); loadAndSetup(); }
  // Раз в минуту: двигаем Солнце и Луну, меняем освещение; по истечении периода (настройка «Погода и фон») — новый запрос погоды.
  function tick() {
    if (document.hidden) return;
    const pref = store.get('fxWeather', WX_DEFAULT);
    if (((pref === 'auto' && level() !== 'off') || (pref === 'none' && soundWeatherOn())) && Date.now() - lastLoad >= refreshMs()) { store.set('lcWeather', 'null'); loadAndSetup(); return; }
    if (cv) updateSky();
    announce();
  }

  // Размер окна: пока холст остаётся примерно того же размера (панель закрылась, появилась полоса прокрутки, на телефоне
  // спряталась адресная строка) — ничего не перезапускаем; сильно изменился — подгоняем холст и небо, а частицы и облака
  // остаются на местах (они сами переходят на новые границы). Раньше любое такое событие заново «бросало» весь снег и дождь.
  let rz = 0;
  function onResize() {
    if (!cv || !state) return;
    const w = window.innerWidth, h = window.innerHeight;
    if (Math.abs(w - W) < 12 && Math.abs(h - H) < 80) return;
    const big = Math.abs(w - W) > W * 0.35 || Math.abs(h - H) > H * 0.35;
    if (big) { setup(); return; }
    W = cv.width = w; H = cv.height = h;
    renderSky();
  }
  window.addEventListener('resize', () => { clearTimeout(rz); rz = setTimeout(onResize, 300); });
  // Смена темы: цвета фона и акцента холст не касаются — они в CSS. Перекрашивать нужно, только когда сменилась «светлая/тёмная»,
  // и то без перезапуска: частицы остаются на местах, меняются лишь цвета (поэтому при подборе цветов в конструкторе тем
  // анимация больше не «скачет»).
  let themeT = 0;
  document.addEventListener('lc-theme', () => {
    if (!cv || !state) return;
    if (isLight() === state.light) return;
    clearTimeout(themeT);
    themeT = setTimeout(() => { if (cv && state && isLight() !== state.light) { state.light = isLight(); updateSky(); } }, 120);
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { lastT = 0; tick(); } });
  if (window.matchMedia) {
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    if (mq.addEventListener) mq.addEventListener('change', refresh);
  }

  window.LCFx = {
    refresh,
    // Для проверки нагрузки: сколько кадров нарисовано и сколько миллисекунд в среднем занимает один.
    stats() { const sec = perf.since ? (performance.now() - perf.since) / 1000 : 0; return { fps: sec ? +(perf.frames / sec).toFixed(1) : 0, avgMs: perf.frames ? +(perf.ms / perf.frames).toFixed(2) : 0, frames: perf.frames }; },
    // Для проверки: подменить текущее время (ISO), например '2026-10-13T16:30:00Z'; без аргумента — вернуть настоящее.
    setTestTime(iso) { testDate = iso ? new Date(iso).getTime() : null; moonImg = null; if (cv) updateSky(); },
    sky() { return computeSky(); },
    // Для звуков погоды: какая погода сейчас на фоне и какое время суток (day: 0 — ночь … 1 — день).
    weatherNow() { const wx = effective(); return { code: wx ? wx.code : null, day: computeSky().day }; },
    // Для проверки: где сейчас первые частицы и облака (смена темы и закрытие окон не должны «перебрасывать» их).
    snapshot() { return { code: state && state.code, n: parts.length, first: parts.slice(0, 4).map((p) => [Math.round(p.x), Math.round(p.y)]), clouds: ((sprites && sprites.list) || []).slice(0, 3).map((c) => Math.round(c.x)), W, H }; },
    // Для проверки силы погоды: облачность/осадки/ветер, число облаков и капель, видимость Солнца (sunShine: 0 — закрыто, 1 — открыто) и Луны.
    levels() {
      if (!state) return null;
      const list = (sprites && sprites.list) || [];
      return { code: state.code, cloud: state.cloud, precip: state.precip, wind: state.wind, clouds: list.length, particles: parts.length, cloudAlpha: sprites && sprites.key ? +sprites.key.split('|')[1] : null,
        sunStatic: +(state.sunVis || 0).toFixed(3), sunOcc: +(state.sunOcc || 0).toFixed(3), sunShine: +((state.sunVis || 0) * (1 - (state.sunOcc || 0))).toFixed(3), moonShine: +((state.moonVis || 0) * (1 - (state.moonOcc || 0))).toFixed(3) };
    },
    // Для проверки: подставить погоду ({code, cloud, precip, wind}) вместо полученной от сервиса (нужен режим «По погоде (авто)») и перерисовать фон; без аргумента — забыть подмену.
    setTestWeather(w) { weather = w ? { ok: true, lat: DEFAULT_LOC.lat, lon: DEFAULT_LOC.lon, city: DEFAULT_LOC.city, source: 'тест', refresh_minutes: 600, ...w } : null; lastLoad = Date.now(); setup(); },
    // Для проверки: подвинуть все облака (сдвиг по x в пикселях), чтобы не ждать, пока они проплывут над Солнцем; при следующем кадре яркость Солнца пересчитается.
    shiftClouds(dx) { ((sprites && sprites.list) || []).forEach((c) => { c.x += dx; }); },
    // Для проверки: поставить облако i центром в точку экрана; сколько облака закрывают Солнце/Луну прямо сейчас; где они на экране.
    placeCloud(i, cx, cy) { const c = ((sprites && sprites.list) || [])[i]; if (c) { c.x = cx - c.w / 2; c.y = cy - c.w * 0.21; } },
    sunOcclusion() { return state ? +occlusionAt(state.sunX, state.sunY).toFixed(3) : null; },
    bodies() { return state ? { sunX: Math.round(state.sunX), sunY: Math.round(state.sunY), moonX: Math.round(state.moonX), moonY: Math.round(state.moonY), W, H } : null; },
    cloudList() { return ((sprites && sprites.list) || []).map((c) => ({ x: Math.round(c.x), y: Math.round(c.y), w: Math.round(c.w), dens: +(c.dens || 0).toFixed(2) })); },
    describe() {
      const forced = store.get('fxWeather', WX_DEFAULT);
      const s = (state && state.sky) || computeSky();
      const phase = phaseLabel(s);
      if (forced === 'none') return 'погода на фоне выключена';
      if (forced !== 'auto') return `выбрано вручную — ${WX_LABEL[forced] || forced}, ${phase}`;
      if (!weather) return level() === 'off' ? 'эффекты выключены' : `погоду получить не удалось — фон по времени суток (${phase})`;
      const t = weather.temp != null ? `, ${weather.temp > 0 ? '+' : ''}${Math.round(weather.temp)}°` : '';
      const label = weather.source === 'время суток' ? 'по времени суток' : (WX_LABEL[weather.code] || weather.code) + t;
      return `${weather.city || DEFAULT_LOC.city}: ${label}, ${phase} (${weather.source || 'сервер'})`;
    },
  };

  function boot() {
    stagger();
    loadAndSetup();
    setInterval(tick, 60000);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
