// «Настройки → Погода и фон…» (только администратор): откуда брать погоду для анимированного фона, как часто её запрашивать, город и ключ
// Яндекс.Погоды. Серверная часть — app/services/weather.py (GET/PUT /api/weather/settings, POST /api/weather/test). Настройка общая для
// всех сотрудников; личные (эффекты, погода «вручную», тема) — в меню темы (кнопка 🌙/☀ в шапке).

async function openWeatherSettings() {
  let cfg;
  try { cfg = await Api.get('/api/weather/settings'); } catch (e) { alert('Не удалось открыть настройки погоды: ' + e.message); return; }
  const radio = (s) => `<label class="flex items-start gap-2 text-sm cursor-pointer">
      <input type="radio" name="source" value="${esc(s.id)}" ${cfg.source === s.id ? 'checked' : ''} class="mt-1 accent-indigo-500">
      <span><b>${esc(s.label)}</b><span class="block text-xs text-slate-400">${esc(s.hint)}</span></span></label>`;
  modal(`<h2 class="font-display text-lg font-bold mb-1">Погода и фон</h2>
    <p class="text-xs text-slate-400 mb-4">Фон страниц меняется по погоде и по времени суток (солнце, закат, звёзды и луна считаются по положению Солнца и от погодного
      сервиса не зависят). Здесь — откуда брать погоду. Настройка общая для всех; запросы делает сервер раз в выбранный период и отдаёт всем.</p>
    <form id="wxForm" class="space-y-4">
      <div class="space-y-2.5">${cfg.sources.map(radio).join('')}</div>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <label class="${labelCls}">Как часто запрашивать погоду, минут (${cfg.min_refresh}–${cfg.max_refresh})
          <input name="refresh_minutes" type="number" min="${cfg.min_refresh}" max="${cfg.max_refresh}" step="5" value="${esc(cfg.refresh_minutes)}" class="${fieldCls}"></label>
        <div id="wxPerDay" class="text-xs text-slate-400 self-end pb-2"></div>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <label class="${labelCls} col-span-3 sm:col-span-1">Город<input name="city" value="${esc(cfg.city)}" maxlength="60" class="${fieldCls}"></label>
        <label class="${labelCls}">Широта<input name="lat" value="${esc(cfg.lat)}" inputmode="decimal" class="${fieldCls}"></label>
        <label class="${labelCls}">Долгота<input name="lon" value="${esc(cfg.lon)}" inputmode="decimal" class="${fieldCls}"></label>
      </div>
      <div class="${labelCls}">
        <label class="${labelCls}">Ключ Яндекс.Погоды (для источников «Яндекс.Погода» и «Авто»)
          <input name="yandex_key" type="password" autocomplete="new-password" class="${fieldCls}"
            placeholder="${cfg.yandex_key_set ? 'сохранён (' + esc(cfg.yandex_key_hint) + ') — оставьте пустым, чтобы не менять' : (cfg.env_key_set ? 'используется ключ из .env (YANDEX_WEATHER_API_KEY)' : 'вставьте ключ')}"></label>
        ${cfg.yandex_key_set ? '<label class="inline-flex items-center gap-1.5 text-xs text-slate-400 mt-1"><input type="checkbox" name="drop_key" class="rounded accent-indigo-500"> удалить сохранённый ключ</label>' : ''}
      </div>
      <div id="wxTest" class="hidden rounded-xl border border-slate-700/60 bg-slate-800/40 px-3 py-2 text-xs space-y-1"></div>
      <div id="wxError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex flex-wrap items-center gap-2 pt-2">
        <button type="button" class="cancel ${btnGhost}">Закрыть</button>
        <button type="button" id="wxTestBtn" class="${btnGhost}">Проверить</button>
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`);
  const form = $('#wxForm');

  const values = () => {
    const typed = form.yandex_key.value.trim();
    const drop = form.drop_key && form.drop_key.checked;
    return {
      source: form.source.value, refresh_minutes: parseInt(form.refresh_minutes.value, 10) || 0,
      city: form.city.value.trim(), lat: parseFloat(String(form.lat.value).replace(',', '.')), lon: parseFloat(String(form.lon.value).replace(',', '.')),
      yandex_key: drop ? '' : (typed || null),                    // null — оставить прежний
    };
  };
  const perDay = () => {
    const m = parseInt(form.refresh_minutes.value, 10);
    const box = $('#wxPerDay');
    if (!(m > 0)) { box.textContent = ''; return; }
    const n = Math.ceil(24 * 60 / m);
    const yandex = form.source.value === 'yandex' || (form.source.value === 'auto' && (cfg.yandex_key_set || cfg.env_key_set || form.yandex_key.value.trim()));
    box.innerHTML = `≈ ${n} запросов в сутки` + (yandex && n > 50 ? '<br><span class="text-amber-300">больше лимита Яндекса (50 в сутки на тарифе «Тестовый»)</span>' : '');
  };
  perDay();
  form.refresh_minutes.oninput = perDay;
  form.querySelectorAll('input[name=source]').forEach((r) => { r.onchange = perDay; });
  form.yandex_key.oninput = perDay;

  const showError = (text) => { const e = $('#wxError'); e.textContent = text; e.classList.toggle('hidden', !text); };
  $('#wxTestBtn').onclick = async () => {
    showError('');
    const box = $('#wxTest');
    box.classList.remove('hidden');
    box.textContent = 'Проверяю… (до 10 секунд на каждый источник)';
    try {
      const res = await Api.post('/api/weather/test', values());
      box.innerHTML = res.results.map((r) => r.ok
        ? `<div class="text-emerald-300">✓ ${esc(r.source)} — ${esc(r.desc || r.code)}${r.temp != null ? ', ' + (r.temp > 0 ? '+' : '') + Math.round(r.temp) + '°' : ''}${r.cloud != null ? `, облачность ${Math.round(r.cloud * 100)}%` : ''}${r.precip ? `, осадки ${String(r.precip).replace('.', ',')} мм/ч` : ''}${r.ms ? ` <span class="text-slate-500">(${r.ms} мс)</span>` : ''}</div>`
        : `<div class="text-rose-300">✗ ${esc(r.source)} — ${esc(r.error || 'не ответил')}</div>`).join('')
        + (res.ok ? '' : '<div class="text-slate-400 pt-1">Ни один источник не ответил: у сервера, вероятно, нет доступа в интернет. Выберите «Без погоды — только время суток» или откройте серверу нужные адреса.</div>');
    } catch (e) {
      box.classList.add('hidden');
      showError(e.message);
    }
  };

  form.onsubmit = async (e) => {
    e.preventDefault();
    showError('');
    try {
      await Api.put('/api/weather/settings', values());
      try { localStorage.setItem('lcWeather', 'null'); } catch { /* не страшно */ }
      if (window.LCFx) window.LCFx.refresh();
      close();
    } catch (err) {
      showError(err.message);
    }
  };
}
