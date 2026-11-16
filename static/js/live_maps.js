// «Живые карты» — окно на странице «Все АПК» (кнопка «🗺 Живые карты»): карты в Яндекс.Конструкторе, которые
// приложение само обновляет раз в несколько минут, перекрашивая точки по статусам комплексов. Условия:
// «есть доступ», «доступ и действующая поверка», свой список комплексов, «отвалились за период» или текущий
// фильтр страницы. Работа в Конструкторе — на роботе (см. app/services/live_maps.py); здесь — список карт с их
// состоянием и форма создания. Грузится после apk.js: пользуется его $, esc, modal, Api, btn*, fieldCls,
// labelCls, setHtmlIfChanged, apkFilters, apkSelected, APK_CATEGORIES, _pointStatusCache.
let _lmTimer = null;
let _lmData = { items: [], intervals: [5, 10, 15, 30, 60], kinds: {} };
let _lmRobot = null;

// Поверка — отдельное условие карты (сочетается с любым видом, категориями и составом).
const LM_CERT = { '': 'не важно', valid: 'действует', invalid: 'нет или истекла', expired: 'только истекла', missing: 'только отсутствует' };
const lmCertOptions = (selected) => Object.entries(LM_CERT).map(([v, label]) => `<option value="${v}" ${v === selected ? 'selected' : ''}>${esc(label)}</option>`).join('');
// У прежнего вида «доступ и действует поверка» условие по поверке зашито в вид — для окна это «действует».
const lmCertOf = (m) => (m.kind === 'access_cert' ? 'valid' : (m.params && m.params.certificate) || '');

function lmWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const time = d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  return d.toDateString() === new Date().toDateString() ? `сегодня в ${time}` : `${d.toLocaleDateString('ru-RU')} ${time}`;
}

function lmPoints(n) {
  const m10 = n % 10, m100 = n % 100;
  return `${n} ${m100 >= 11 && m100 <= 14 ? 'точек' : m10 === 1 ? 'точка' : m10 >= 2 && m10 <= 4 ? 'точки' : 'точек'}`;
}

function lmCardHtml(m) {
  const busy = m.job;
  let chip;
  if (busy) chip = `<span class="text-xs text-amber-300">⏳ ${esc(busy.message || 'Работаю…')}</span>`;
  else if (!m.enabled) chip = '<span class="text-xs text-slate-400">⏸ На паузе</span>';
  else if (m.last_error) chip = `<span class="text-xs text-rose-300">⚠️ ${esc(m.last_error)}</span>`;
  else if (m.url) chip = `<span class="text-xs text-emerald-300">✅ Обновлена ${esc(lmWhen(m.last_sync))}</span>`;
  else chip = '<span class="text-xs text-slate-400">Ждёт создания карты</span>';

  const membership = m.kind === 'list' ? '' : (m.membership === 'fixed'
    ? ` · состав зафиксирован (${m.members_count})`
    : ' · состав пересчитывается по условию');
  const cert = lmCertOf(m) && m.kind !== 'access_cert' ? ` · поверка: ${esc(LM_CERT[lmCertOf(m)])}` : '';
  const sub = `${esc(m.kind_label)}${cert}${membership} · ${lmPoints(m.points_count)}${m.skipped ? ` (ещё ${m.skipped} без координат)` : ''} · обновление раз в ${m.interval_minutes} мин`;
  const canRebuild = m.kind !== 'list' && m.membership === 'fixed';
  const readOnly = !can('maps.manage');
  const small = 'rounded-lg px-2.5 py-1 text-xs font-medium transition-colors';
  return `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 space-y-2" data-lm-card="${m.id}">
    <div class="min-w-0">
      <div class="text-sm font-semibold" style="overflow-wrap:anywhere">${esc(m.name)}</div>
      <div class="text-[11px] text-slate-400">${sub}</div>
    </div>
    <div>${chip}</div>
    ${readOnly ? (m.url ? `<div class="flex flex-wrap items-center gap-1.5"><a href="${esc(m.url)}" target="_blank" rel="noopener" class="${small} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25">🔗 Открыть карту</a></div>` : '') : `<div class="flex flex-wrap items-center gap-1.5">
      ${m.url ? `<a href="${esc(m.url)}" target="_blank" rel="noopener" class="${small} bg-emerald-500/15 text-emerald-300 hover:bg-emerald-500/25">🔗 Открыть карту</a>
      <button data-lm-copy class="${small} bg-slate-700/60 hover:bg-slate-600/60">⧉ Копировать ссылку</button>` : ''}
      <button data-lm-sync class="${small} bg-slate-700/60 hover:bg-slate-600/60" ${busy ? 'disabled' : ''}>↻ Обновить сейчас</button>
      ${canRebuild ? `<button data-lm-rebuild class="${small} bg-slate-700/60 hover:bg-slate-600/60" title="Заново применить условие и зафиксировать подходящие комплексы" ${busy ? 'disabled' : ''}>Пересобрать состав</button>` : ''}
      <button data-lm-pause class="${small} bg-slate-700/60 hover:bg-slate-600/60">${m.enabled ? '⏸ Пауза' : '▶ Продолжить'}</button>
      <button data-lm-edit class="${small} bg-slate-700/60 hover:bg-slate-600/60">✎ Изменить</button>
      <button data-lm-del class="${small} bg-rose-500/15 text-rose-300 hover:bg-rose-500/25">Удалить</button>
    </div>`}
  </div>`;
}

function lmRobotHtml() {
  if (!_lmRobot) return '';
  if (!_lmRobot.available) return `<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Робот карт не запущен — карты не обновляются. ${esc(_lmRobot.message || '')}</div>`;
  if (!_lmRobot.logged_in) return '<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-300">Робот не вошёл в Яндекс — карты не обновляются. Администратору: календарь → «Яндекс-аккаунт для карт» → «Войти в Яндекс».</div>';
  return `<div class="text-[11px] text-slate-500">Робот карт работает${_lmRobot.login ? ` (аккаунт ${esc(_lmRobot.login)})` : ''}. Обновление идёт в фоне, окно можно закрыть.</div>`;
}

async function lmRefresh(first) {
  const list = $('#lmList');
  if (!list) return;
  try {
    _lmData = await Api.get('/api/live-maps');
    if (first || !_lmRobot) _lmRobot = await Api.get('/api/yandex-robot/status').catch(() => null);
  } catch (e) {
    list.innerHTML = `<p class="text-sm text-rose-400">Не удалось загрузить: ${esc(e.message)}</p>`;
    return;
  }
  setHtmlIfChanged($('#lmRobot'), lmRobotHtml());
  setHtmlIfChanged(list, _lmData.items.length
    ? _lmData.items.map(lmCardHtml).join('')
    : '<p class="text-sm text-slate-500 text-center py-6">Живых карт пока нет. Нажмите «＋ Создать карту» — например, карту комплексов с доступом и поверкой.</p>');
}

async function openLiveMaps() {
  modal(`<div class="flex flex-wrap items-center justify-between gap-2 mb-3">
      <h2 class="font-display text-lg font-bold">Живые карты</h2>
      <div class="flex items-center gap-2">
        ${!can('maps.manage') ? '' : `<button id="lmCreate" class="${btnPrimary} !px-4 !py-1.5 text-xs">＋ Создать карту</button>`}
        <button type="button" class="cancel ${btnGhost} !px-4 !py-1.5 text-xs">Закрыть</button>
      </div>
    </div>
    <p class="text-xs text-slate-400 mb-3">Карты в Яндекс.Картах (Конструктор), которые сами обновляются по таймеру: цвет точки меняется вместе со статусом комплекса — так же, как на карте «Все АПК». Ссылку на карту можно отправить кому угодно.</p>
    <div id="lmRobot" class="mb-3"></div>
    <div id="lmList" class="space-y-3"><p class="text-sm text-slate-500 lc-pulse">Данные загружаются…</p></div>`, { wide: true });
  if ($('#lmCreate')) $('#lmCreate').onclick = () => openLiveMapForm();
  const list = $('#lmList');
  list.addEventListener('click', onLiveMapsClick);
  await lmRefresh(true);
  clearInterval(_lmTimer);
  _lmTimer = setInterval(() => {
    if (!$('#lmList')) { clearInterval(_lmTimer); return; }
    if (document.hidden) return;
    lmRefresh(false);
  }, 4000);
}

async function onLiveMapsClick(e) {
  const btn = e.target.closest('button');
  const card = e.target.closest('[data-lm-card]');
  if (!btn || !card) return;
  const id = +card.dataset.lmCard;
  const m = _lmData.items.find((x) => x.id === id);
  if (!m) return;
  const failed = (err) => alert('Не удалось: ' + err.message);
  if (btn.hasAttribute('data-lm-copy')) {
    try { await navigator.clipboard.writeText(m.url); btn.textContent = '✅ Скопировано'; setTimeout(() => lmRefresh(false), 1500); }
    catch { prompt('Скопируйте ссылку:', m.url); }
  } else if (btn.hasAttribute('data-lm-sync')) {
    btn.disabled = true;
    try {
      const r = await Api.post(`/api/live-maps/${id}/sync`, {});
      if (r.uptodate) alert('Карта и так актуальна — менять нечего.');
    } catch (err) { failed(err); }
    lmRefresh(false);
  } else if (btn.hasAttribute('data-lm-rebuild')) {
    if (!confirm('Заново применить условие и зафиксировать подходящие сейчас комплексы? Карта обновится.')) return;
    btn.disabled = true;
    try { await Api.post(`/api/live-maps/${id}/rebuild`, {}); } catch (err) { failed(err); }
    lmRefresh(false);
  } else if (btn.hasAttribute('data-lm-pause')) {
    try { await Api.put(`/api/live-maps/${id}`, { enabled: !m.enabled }); } catch (err) { failed(err); }
    lmRefresh(false);
  } else if (btn.hasAttribute('data-lm-edit')) {
    openLiveMapEdit(m);
  } else if (btn.hasAttribute('data-lm-del')) {
    if (!confirm(`Убрать карту «${m.name}» из списка живых карт? Обновляться она перестанет, но в Яндекс.Конструкторе останется (ссылка продолжит работать) и удалится только по сроку хранения из настроек карт.`)) return;
    try { await Api.del(`/api/live-maps/${id}`); } catch (err) { failed(err); }
    lmRefresh(false);
  }
}

function openLiveMapEdit(m) {
  modal(`<h2 class="font-display text-lg font-bold mb-4">Живая карта</h2>
    <form id="lmEditForm" class="space-y-4">
      <label class="${labelCls}">Название<input name="name" required maxlength="80" value="${esc(m.name)}" class="${fieldCls}"></label>
      <label class="${labelCls}">Как часто обновлять
        <select name="interval" class="${fieldCls}">${_lmData.intervals.map((v) => `<option value="${v}" ${v === m.interval_minutes ? 'selected' : ''}>раз в ${v} мин</option>`).join('')}</select>
      </label>
      <label class="${labelCls}">Поверка
        <select name="certificate" class="${fieldCls}">${lmCertOptions(lmCertOf(m))}</select>
        <span class="text-[11px] text-slate-500 font-normal">Не зависит от остальных условий карты. После смены состав карты пересчитывается.</span>
      </label>
      ${m.kind === 'list' || m.kind === 'dropped' ? '' : `<div class="space-y-1.5">
        <div class="${labelCls}">Состав карты</div>
        <label class="flex items-start gap-2 text-xs text-slate-300"><input type="radio" name="membership" value="dynamic" class="mt-0.5 accent-indigo-500" ${m.membership === 'dynamic' ? 'checked' : ''}>
          <span><b>Пересчитывать по условию</b> — на карте только подходящие сейчас комплексы; потерявшие доступ пропадают</span></label>
        <label class="flex items-start gap-2 text-xs text-slate-300"><input type="radio" name="membership" value="fixed" class="mt-0.5 accent-indigo-500" ${m.membership === 'fixed' ? 'checked' : ''}>
          <span><b>Зафиксировать сейчас</b> — комплексы остаются, меняется только цвет (потерявшие доступ станут красными)</span></label>
      </div>`}
      <div id="lmEditError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" id="lmEditBack" class="${btnGhost}">Назад</button>
        <button class="${btnPrimary}">Сохранить</button>
      </div>
    </form>`, { wide: false });
  $('#lmEditBack').onclick = () => openLiveMaps();
  $('#lmEditForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      const body = { name: f.name.value.trim(), interval_minutes: +f.interval.value };
      if (f.certificate.value !== lmCertOf(m)) body.certificate = f.certificate.value;
      const membership = e.target.querySelector('input[name="membership"]:checked')?.value;
      if (membership && membership !== m.membership) body.membership = membership;
      await Api.put(`/api/live-maps/${m.id}`, body);
      openLiveMaps();
    } catch (err) {
      $('#lmEditError').textContent = err.message;
      $('#lmEditError').classList.remove('hidden');
    }
  };
}

// ---------- создание ----------

function lmFilterSummary() {
  const parts = [];
  if (apkFilters.search) parts.push(`поиск «${apkFilters.search}»`);
  const cats = [...apkFilters.categories].map((v) => (v === '__none__' ? 'без категории' : (APK_CATEGORIES.find((c) => String(c.id) === v)?.name || v)));
  if (cats.length) parts.push(`категории: ${cats.join(', ')}`);
  if (apkFilters.statuses.size) parts.push(`статусы: ${[...apkFilters.statuses].map((v) => (v === '__none__' ? 'Не известно' : v)).join(', ')}`);
  if (apkFilters.certificate) parts.push(`поверка: ${LM_CERT[apkFilters.certificate] || apkFilters.certificate}`);
  return parts.length ? parts.join(' · ') : 'без фильтров (все комплексы)';
}

function lmFilterParams() {
  return {
    search: apkFilters.search || '',
    category_ids: [...apkFilters.categories].filter((v) => v !== '__none__').map(Number),
    uncategorized: apkFilters.categories.has('__none__'),
    statuses: [...apkFilters.statuses].filter((v) => v !== '__none__'),
    certificate: apkFilters.certificate || '',
  };
}

// preset: { kind, ids } — например из «Карта из выбранных» (kind 'list' с номерами отмеченных комплексов).
function openLiveMapForm(preset = {}) {
  const kind0 = preset.kind && preset.kind !== 'access_cert' ? preset.kind : 'access';
  const kinds = [
    ['access', 'Есть доступ', 'Комплексы со статусом «Работает» (есть доступ к веб-интерфейсу). Поверку выберите ниже — она не зависит от этого выбора'],
    ['list', 'Свой список комплексов', 'Номера, которые вы укажете: цвет и статус каждой точки меняются сами'],
    ['dropped', 'Отвалились за период', 'Комплексы, у которых доступ пропал за выбранное время (пока недоступны)'],
    ['filter', 'Как сейчас на странице «Все АПК»', `Текущие поиск и фильтры: ${lmFilterSummary()}`],
  ];
  const catBoxes = APK_CATEGORIES.map((c) => `<label class="flex items-center gap-2 text-xs text-slate-300"><input type="checkbox" data-lm-cat value="${c.id}" class="rounded accent-indigo-500"> ${esc(c.name)}</label>`).join('');
  modal(`<h2 class="font-display text-lg font-bold mb-4">Новая живая карта</h2>
    <form id="lmForm" class="space-y-4">
      <label class="${labelCls}">Название карты<input name="name" required maxlength="80" placeholder="например: АПК с доступом и поверкой" class="${fieldCls}"></label>
      <div class="space-y-1.5">
        <div class="${labelCls}">Какие комплексы показывать</div>
        ${kinds.map(([v, title, hint]) => `<label class="flex items-start gap-2 rounded-xl border border-slate-700/50 bg-slate-800/30 px-3 py-2 cursor-pointer">
          <input type="radio" name="kind" value="${v}" class="mt-0.5 accent-indigo-500" ${v === kind0 ? 'checked' : ''}>
          <span class="text-xs"><b class="text-sm">${esc(title)}</b><br><span class="text-slate-400">${esc(hint)}</span></span>
        </label>`).join('')}
      </div>
      <label class="${labelCls} hidden" data-lm-for="list">Номера комплексов — по одному в строке или через запятую
        <textarea name="ids" rows="5" class="${fieldCls}" placeholder="например:&#10;T-100&#10;T-101">${esc((preset.ids || []).join('\n'))}</textarea>
      </label>
      <div class="hidden" data-lm-for="dropped">
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls}">Период<input name="period" type="number" min="1" max="365" value="3" class="${fieldCls}"></label>
          <label class="${labelCls}">Единица<select name="unit" class="${fieldCls}"><option value="1">часов</option><option value="24" selected>дней</option></select></label>
        </div>
      </div>
      <label class="${labelCls}">Поверка
        <select name="certificate" class="${fieldCls}">${lmCertOptions('')}</select>
        <span class="text-[11px] text-slate-500 font-normal">Отдельное условие — сочетается с любым вариантом выше, категориями и составом карты. «Как сейчас на странице»: если не выбрано, берётся фильтр поверки со страницы «Все АПК».</span>
      </label>
      <details class="hidden rounded-xl border border-slate-700/50 bg-slate-800/20 px-3 py-2" data-lm-for="access access_cert dropped">
        <summary class="text-xs text-slate-300 cursor-pointer">Только некоторые категории (необязательно)</summary>
        <div class="grid grid-cols-2 gap-1.5 pt-2">${catBoxes || '<span class="text-xs text-slate-500">Категорий нет</span>'}</div>
      </details>
      <div class="space-y-1.5 hidden" data-lm-for="access access_cert filter">
        <div class="${labelCls}">Состав карты</div>
        <label class="flex items-start gap-2 text-xs text-slate-300"><input type="radio" name="membership" value="dynamic" class="mt-0.5 accent-indigo-500" checked>
          <span><b>Пересчитывать по условию</b> — на карте только подходящие сейчас комплексы: появляются и пропадают с неё сами (потерявшие доступ уходят с карты)</span></label>
        <label class="flex items-start gap-2 text-xs text-slate-300"><input type="radio" name="membership" value="fixed" class="mt-0.5 accent-indigo-500">
          <span><b>Зафиксировать сейчас</b> — комплексы остаются, меняются только цвет и статус (видно, кто потерял доступ — такие точки станут красными)</span></label>
      </div>
      <label class="${labelCls}">Как часто обновлять
        <select name="interval" class="${fieldCls}">${_lmData.intervals.map((v) => `<option value="${v}" ${v === 5 ? 'selected' : ''}>раз в ${v} мин</option>`).join('')}</select>
      </label>
      <div id="lmPreview" class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-3 py-2 text-xs text-slate-300">Считаю подходящие комплексы…</div>
      <div id="lmFormError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex items-center gap-2 pt-2">
        <button type="button" id="lmFormBack" class="${btnGhost}">Назад</button>
        <button id="lmFormSubmit" class="${btnPrimary}">Создать карту</button>
      </div>
    </form>`);

  const form = $('#lmForm');
  const f = form.elements;
  const kindNow = () => form.querySelector('input[name="kind"]:checked').value;
  const buildPayload = () => {
    const kind = kindNow();
    const params = {};
    if (kind === 'list') params.point_ids = f.ids.value;
    if (kind === 'dropped') params.dropped_hours = Math.round((+f.period.value || 0) * +f.unit.value);
    if (kind === 'filter') Object.assign(params, lmFilterParams());
    // Поверка — отдельное условие для любого вида; у «как на странице» пустое значение оставляет фильтр поверки со страницы.
    if (f.certificate.value || kind !== 'filter') params.certificate = f.certificate.value;
    if (kind === 'access' || kind === 'access_cert' || kind === 'dropped') {
      params.category_ids = [...form.querySelectorAll('[data-lm-cat]:checked')].map((c) => +c.value);
    }
    const membership = form.querySelector('input[name="membership"]:checked')?.value || 'fixed';
    return { name: f.name.value.trim(), kind, params, membership, interval_minutes: +f.interval.value };
  };
  const applyKind = () => {
    const kind = kindNow();
    form.querySelectorAll('[data-lm-for]').forEach((el) => el.classList.toggle('hidden', !el.dataset.lmFor.split(' ').includes(kind)));
  };
  let previewTimer = null;
  const refreshPreview = () => {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
      const box = $('#lmPreview');
      if (!box) return;
      const p = buildPayload();
      if (p.kind === 'list' && !String(p.params.point_ids).trim()) { box.textContent = 'Укажите номера комплексов.'; return; }
      try {
        const r = await Api.post('/api/live-maps/preview', { kind: p.kind, params: p.params });
        if (!$('#lmPreview')) return;
        const unknown = r.unknown.length ? ` Не найдены в справочнике: ${r.unknown.join(', ')}.` : '';
        const warn = r.with_coords > 500 ? ' Точек много — создание карты займёт несколько минут.' : '';
        box.innerHTML = `Подходит комплексов: <b>${r.total}</b>, из них с координатами (будут на карте): <b>${r.with_coords}</b>.${esc(unknown)}${esc(warn)}${r.sample.length ? `<br><span class="text-slate-400">Например: ${esc(r.sample.join(', '))}</span>` : ''}`;
      } catch (err) { box.textContent = err.message; }
    }, 350);
  };
  form.addEventListener('input', refreshPreview);
  form.addEventListener('change', () => { applyKind(); refreshPreview(); });
  applyKind();
  refreshPreview();
  $('#lmFormBack').onclick = () => openLiveMaps();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const btn = $('#lmFormSubmit');
    btn.disabled = true;
    try {
      await Api.post('/api/live-maps', buildPayload());
      await openLiveMaps();   // карта создаётся 1–3 минуты — статус виден в списке
    } catch (err) {
      $('#lmFormError').textContent = err.message;
      $('#lmFormError').classList.remove('hidden');
      btn.disabled = false;
    }
  };
}
