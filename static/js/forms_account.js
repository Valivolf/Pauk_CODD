// Яндекс Формы: вход робота в Яндекс, автозагрузка отчётов из формы и проверка скачивания фото.
// Серверная часть — app/api/routes_forms_auto.py и app/services/forms_auto.py, сам браузер — robot/ (окно входа — openRobotBrowser из yandex_robot.js).
// modal()/btn*/fieldCls/esc/$ — из ui.js и app.js.
const FORMS_AUTO_API = '/api/forms-auto';

async function openFormsAccount() {
  closeDropdowns();
  modal(`<h2 class="font-display text-lg font-bold mb-2">Яндекс Формы: вход и автозагрузка</h2>
    <p class="text-sm text-slate-400 mb-3">Фото из ответов формы и таблицу ответов Яндекс отдаёт только создателю формы. Робот открывает Формы в своём браузере под вашим аккаунтом Яндекса: вход делается один раз прямо здесь. Пароль нигде не сохраняется.</p>
    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-3 text-sm space-y-2.5">
      <b class="block">Вход в Яндекс</b>
      <label class="flex items-start gap-2"><input type="radio" name="fmProf" value="maps" class="mt-1 accent-indigo-500">
        <span>Тот же аккаунт, что для карт <span class="text-xs text-slate-400">(«Яндекс-аккаунт для карт») — если форма создана под ним</span></span></label>
      <label class="flex items-start gap-2"><input type="radio" name="fmProf" value="forms" class="mt-1 accent-indigo-500">
        <span>Отдельный аккаунт для Форм <span class="text-xs text-slate-400">— если форма принадлежит другому аккаунту; свой вход, свой браузер</span></span></label>
      <div id="fmAccBox" class="text-sm pt-1">Проверяю робота…</div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="fmLoginBtn" class="${btnPrimary}">Войти в Яндекс / открыть Формы</button>
        <button type="button" id="fmVerifyBtn" class="${btnGhost}" title="Робот открывает список ваших форм — так видно, есть ли доступ именно к Формам">Проверить доступ к Формам</button>
        <button type="button" id="fmLogoutBtn" class="${btnGhost}">Выйти из аккаунта</button>
      </div>
    </div>
    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-3 text-sm space-y-2.5">
      <b class="block">Отчёты из Яндекс Форм — автоматически</b>
      <label class="flex items-start gap-2"><input type="checkbox" id="fmEnabled" class="mt-1 rounded accent-indigo-500">
        <span>Забирать новые ответы формы сами, раз в <input type="number" id="fmInterval" min="5" max="1440" style="width:70px" class="${fieldCls} !py-1 inline-block"> мин. Отчёты создаются так же, как при загрузке таблицы вручную (уже имеющиеся пропускаются), фото скачиваются сами.</span></label>
      <div>
        <div class="text-xs text-slate-400 mb-1">Страница «Ответы» вашей формы</div>
        <div class="flex gap-2"><input type="text" id="fmUrl" class="${fieldCls} flex-1" placeholder="https://forms.yandex.ru/…" autocomplete="off">
          <button type="button" id="fmPickBtn" class="${btnGhost} !px-3 whitespace-nowrap" title="Открывает браузер робота: найдите свою форму, вкладку «Ответы» и нажмите «Запомнить эту страницу»">Выбрать в браузере</button></div>
      </div>
      <label class="flex items-start gap-2"><input type="checkbox" id="fmApply" class="mt-1 rounded accent-indigo-500">
        <span>Менять статус комплекса по отчётам из формы <span class="text-xs text-slate-400">(обычно не нужно: отчёты запоздалые и не должны перебивать более свежую проверку)</span></span></label>
      <div id="fmState" class="text-xs text-slate-400">Загружаю настройки…</div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="fmSave" class="${btnPrimary} !py-1.5 !px-3 text-xs">Сохранить</button>
        <button type="button" id="fmRun" class="${btnGhost} !py-1.5 !px-3 text-xs" title="Выгрузить таблицу и загрузить отчёты и фото прямо сейчас">Загрузить сейчас</button>
        <span id="fmSaved" class="text-xs text-emerald-300"></span>
      </div>
    </div>
    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 mb-4 text-sm space-y-2">
      <b class="block">Фото не скачиваются?</b>
      <div class="text-xs text-slate-400">Робот попробует скачать фото (по первой ссылке, которая не скачалась, или по вашей) и покажет, что именно ответил Яндекс и что он видит на странице — по этому видно, где сбой: нет входа, нет доступа к форме, страница другая.</div>
      <div class="flex gap-2"><input type="text" id="fmDiagUrl" class="${fieldCls} flex-1 !py-1" placeholder="ссылка на фото (необязательно)" autocomplete="off">
        <button type="button" id="fmDiagBtn" class="${btnGhost} !px-3 whitespace-nowrap">Проверить скачивание</button></div>
      <div id="fmDiag" class="text-xs"></div>
    </div>
    <button type="button" class="cancel ${btnGhost}">Закрыть</button>`);

  let cfg = null;
  const profile = () => (document.querySelector('input[name="fmProf"]:checked') || {}).value || 'maps';
  const box = () => $('#fmAccBox');

  const accHtml = (st, verified) => {
    if (!st.available) return `<span class="text-amber-300">⚠️ ${esc(st.message || 'Робот недоступен')}</span>`;
    const who = st.login ? ` <b>${esc(st.login)}</b>` : '';
    if (verified) {
      return st.logged_in
        ? `<span class="text-emerald-300">✅ Доступ к Яндекс Формам есть${who ? ':' + who : ''}</span>`
        : `<span class="text-amber-300">⚠️ ${esc(st.message || 'Вход в Яндекс Формы не выполнен')}</span><div class="text-xs text-slate-400 mt-1">Нажмите «Войти в Яндекс / открыть Формы»: войдите и убедитесь, что видите свои формы.</div>`;
    }
    return st.logged_in
      ? `<span class="text-emerald-300">✅ Вход в Яндекс выполнен${who ? ':' + who : ''}</span> <span class="text-xs text-slate-400">— «Проверить доступ к Формам» покажет, пускает ли Яндекс в Формы</span>`
      : '<span class="text-amber-300">Вход в Яндекс не выполнен</span>';
  };
  const refresh = async (verify) => {
    if (!box()) return;
    box().textContent = verify ? 'Робот открывает Яндекс Формы и дожидается загрузки страницы…' : 'Проверяю робота…';
    try { box().innerHTML = accHtml(await robotStatus(verify, { profile: profile(), check: verify ? 'forms' : '' }), verify); }
    catch (e) { box().innerHTML = `<span class="text-amber-300">${esc(e.message)}</span>`; }
  };
  const when = (ts) => (ts ? new Date(ts * 1000).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : 'ещё не было');
  const stateHtml = (s) => {
    let html = `Последняя загрузка: <b>${when(s.last_run)}</b>`;
    if (s.running) return html + `<br><span class="text-indigo-300">⏳ ${esc(s.step || 'идёт…')}</span>`;
    if (s.ok === true) html += `<br><span class="text-emerald-300">✅ ${esc(s.message)}</span>`;
    if (s.ok === false) {
      html += `<br><span class="text-amber-300">⚠️ ${esc(s.error)}</span>${s.error && /кноп|вёрстк|страниц/i.test(s.error) ? ` <a class="text-indigo-300 hover:underline" target="_blank" rel="noopener" href="${FORMS_AUTO_API}/export-shot">снимок страницы ↗</a>` : ''}`;
      if (/не робот/i.test(s.error || '')) html += `<br><button type="button" id="fmCaptchaState" class="${btnPrimary} !py-1 !px-3 text-xs mt-1">Пройти проверку в браузере робота</button>`;
    }
    return html;
  };
  let pollTimer = 0;
  const load = async (keepForm) => {
    try {
      const r = await Api.get(FORMS_AUTO_API);
      if (!$('#fmState')) return;
      cfg = r.config;
      if (!keepForm) {
        document.querySelectorAll('input[name="fmProf"]').forEach((x) => { x.checked = x.value === cfg.profile; });
        $('#fmEnabled').checked = cfg.enabled;
        $('#fmInterval').value = cfg.interval_minutes;
        $('#fmUrl').value = cfg.url;
        $('#fmApply').checked = cfg.apply_status;
      }
      $('#fmState').innerHTML = stateHtml(r.state);
      if ($('#fmCaptchaState')) $('#fmCaptchaState').onclick = () => passCaptcha(cfg.url || '');
      clearTimeout(pollTimer);
      if (r.state.running) pollTimer = setTimeout(() => load(true), 2000);
    } catch (e) { if ($('#fmState')) $('#fmState').textContent = 'Не удалось загрузить настройки: ' + e.message; }
  };
  const save = async () => {
    const body = { enabled: $('#fmEnabled').checked, url: $('#fmUrl').value.trim(), interval_minutes: +$('#fmInterval').value, apply_status: $('#fmApply').checked, profile: profile() };
    if (!(body.interval_minutes >= 5 && body.interval_minutes <= 1440)) { alert('Периодичность — от 5 минут до 1440 (сутки).'); return false; }
    try {
      await Api.put(FORMS_AUTO_API, body);
      $('#fmSaved').textContent = '✓ сохранено';
      setTimeout(() => { if ($('#fmSaved')) $('#fmSaved').textContent = ''; }, 2500);
      return true;
    } catch (e) { alert(e.message); return false; }
  };

  // «Вы не робот»: Яндекс считает запросы с сервера автоматическими; человек проходит проверку один раз в браузере робота — дальше файлы отдаются.
  const passCaptcha = (startUrl) => openRobotBrowser(() => { refresh(true); load(true); if ($('#fmDiagBtn') && startUrl && $('#fmDiag').dataset.captcha) $('#fmDiagBtn').click(); }, { profile: profile(), forms: true, startUrl: startUrl || undefined });
  document.querySelectorAll('input[name="fmProf"]').forEach((x) => {
    x.onchange = async () => { if (await save()) refresh(false); };
  });
  $('#fmLoginBtn').onclick = () => openRobotBrowser(() => { refresh(true); load(true); }, { profile: profile(), forms: true });
  $('#fmPickBtn').onclick = () => openRobotBrowser(() => load(false), { profile: profile(), forms: true });
  $('#fmVerifyBtn').onclick = () => refresh(true);
  $('#fmLogoutBtn').onclick = async () => {
    if (!confirm('Выйти из аккаунта Яндекса в браузере робота? ' + (profile() === 'maps' ? 'Это тот же вход, что для карт — карты тоже будут вестись только после нового входа.' : ''))) return;
    try { await Api.post(`${ROBOT_API}/logout?profile=${profile()}`, {}); } catch (e) { alert(e.message); }
    refresh(false);
  };
  $('#fmSave').onclick = async () => { if (await save()) load(false); };
  $('#fmRun').onclick = async () => {
    if (!(await save())) return;
    try { await Api.post(`${FORMS_AUTO_API}/run`, {}); } catch (e) { alert(e.message); return; }
    load(true);
  };
  $('#fmDiagBtn').onclick = async () => {
    const out = $('#fmDiag');
    out.innerHTML = '<span class="text-slate-400">Робот пробует скачать (дожидается загрузки страниц)…</span>';
    try {
      const r = await Api.post(`${FORMS_AUTO_API}/diag`, { url: $('#fmDiagUrl').value.trim() }, { timeoutMs: 240000 });
      const steps = r.steps.map((s) => `<div class="mt-1.5"><b>${esc(s.how)}</b>: ${s.error ? `<span class="text-amber-300">${esc(s.error)}</span>`
        : `ответ <b>${esc(s.status)}</b>, тип ${esc(s.type || '—')}, ${esc(s.bytes)} байт<br><span class="text-slate-400">адрес после переходов: ${esc(s.url)}</span>${s.title ? `<br>заголовок страницы: «${esc(s.title)}»` : ''}${s.text ? `<br><span class="text-slate-400">текст страницы: ${esc(s.text)}</span>` : ''}`}</div>`).join('');
      const verdict = r.steps.some((s) => !s.error && s.status === 200 && /^image\//.test(s.type || ''))
        ? '<div class="text-emerald-300 mb-1">✅ Файл отдаётся — скачивание должно работать (повторите загрузку фото).</div>'
        : `<div class="text-amber-300 mb-1">⚠️ Файл не получен. Вход: ${r.has_session ? 'в браузере робота есть (' + esc(r.login || 'аккаунт') + ')' : 'не выполнен'}.</div>`;
      out.dataset.captcha = r.captcha ? '1' : '';
      const captcha = r.captcha
        ? `<div class="rounded-xl border border-amber-500/40 bg-amber-500/10 p-2.5 mb-2"><b class="text-amber-300">Яндекс просит проверку «Вы не робот».</b> Так он реагирует на запросы с сервера, поэтому файл не отдаётся. Пройдите проверку один раз прямо в браузере робота (нажмите на картинке «Я не робот» и выполните задание) — после этого фото должны скачиваться; если проверка вернётся — пройти её можно так же.
             <div class="mt-2"><button type="button" id="fmCaptchaBtn" class="${btnPrimary} !py-1 !px-3 text-xs">Пройти проверку в браузере робота</button></div></div>` : '';
      out.innerHTML = `${captcha}${r.captcha ? '' : verdict}<div class="text-slate-400 break-all">Ссылка: ${esc(r.checked_url)}</div>${steps}`
        + (r.has_shot ? `<div class="mt-2"><img src="${FORMS_AUTO_API}/diag/shot?t=${Date.now()}" alt="Что видит браузер робота" style="max-width:100%;border-radius:10px;border:1px solid rgba(100,116,139,.4)"><div class="text-slate-500 mt-1">Так выглядит страница по этой ссылке в браузере робота.</div></div>` : '');
      if ($('#fmCaptchaBtn')) $('#fmCaptchaBtn').onclick = () => passCaptcha(r.checked_url);
    } catch (e) { out.innerHTML = `<span class="text-amber-300">${esc(e.message)}</span>`; }
  };

  await load(false);
  await refresh(false);
}
