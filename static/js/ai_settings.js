// «Настройки → 🤖 ИИ: голос и помощник…» (только администратор): включить и выключить режимы, проверить, запущены ли распознавание речи
// и языковая модель, проверить модель на примере. Бэкенд — app/api/routes_ai.py. modal, $, esc, Api, btn*, fieldCls — из ui.js.
function cpuHtml(cpu) {
  if (!cpu || !cpu.cores) return '';
  const line = `Процессор сервера: ${cpu.cores} ядер${cpu.model ? ' · ' + esc(cpu.model) : ''}${cpu.avx2 === true ? ' · AVX2 есть' : ''}`;
  if (cpu.avx2 === false) {
    return `<div class="text-xs text-slate-400">${line}</div><div class="rounded-lg border border-rose-500/30 bg-rose-500/10 px-2.5 py-1.5 text-xs text-rose-200">⚠ Виртуальная машина не отдаёт программе расширение процессора AVX2 — модель будет работать в 3–5 раз медленнее. В настройках виртуальной машины выберите тип процессора «host» (Proxmox / KVM), отключите «режим совместимости процессора» (Hyper-V) или маскирование функций процессора (EVC в VMware) и перезапустите машину.</div>`;
  }
  return `<div class="text-xs text-slate-400">${line}</div>`;
}

async function openAiSettings() {
  let data;
  try { data = await Api.get('/api/ai/settings'); }
  catch (e) { alert('Не удалось загрузить настройки ИИ: ' + e.message); return; }

  const paint = (d) => {
    const st = d.status, cfg = d.config;
    const dot = (s) => (s.ok ? `<span class="text-emerald-300">● работает${s.via_agents ? ' через компьютеры сотрудников' : ''}</span>` : s.disabled ? '<span class="text-slate-400">● выключено на сервере</span>' : s.loading ? '<span class="text-amber-300">● загружается</span>'
      : `<span class="text-rose-300">● ${esc(s.message || 'не отвечает')}</span>`);
    $('#aiBody').innerHTML = `
      <div class="rounded-xl border border-slate-700/60 bg-slate-800/30 p-3 space-y-1 text-sm">
        <div>Языковая модель: ${dot(st.llm)}${st.llm.model ? ` <span class="text-slate-400">· ${esc(st.llm.model)}</span>` : ''}</div>
        <div>Распознавание речи: ${dot(st.asr)}${st.asr.model ? ` <span class="text-slate-400">· ${esc(st.asr.model)}</span>` : ''}</div>
        ${cpuHtml(st.cpu)}
        <div class="text-xs text-slate-400">Очередь запросов: ${st.queue.llm_waiting} · ${st.queue.llm_busy ? 'модель занята' : 'модель свободна'}${st.last.llm_seconds ? ` · последний запрос к модели — ${st.last.llm_seconds} с` : ''}${st.last.asr_seconds ? `, расшифровка — ${st.last.asr_seconds} с` : ''}</div>
      </div>
      <label class="flex items-start gap-2 text-sm"><input type="checkbox" id="aiVoice" class="rounded accent-indigo-500 mt-0.5" ${cfg.bot_voice ? 'checked' : ''}>
        <span><b>ИИ в боте ВК</b> — голосовые итоги работ. Монтёр присылает голосовое сообщение на комплексе: оно расшифровывается и раскладывается на «что сделано», «причина» и «что нужно для восстановления». Выключено — бот отвечает, что голосовые не принимаются.</span></label>
      <label class="flex items-start gap-2 text-sm"><input type="checkbox" id="aiAssistant" class="rounded accent-indigo-500 mt-0.5" ${cfg.assistant ? 'checked' : ''}>
        <span><b>Помощник в веб-панели</b> — вопросы по данным и заполнение шаблонов Excel/Word (страница «🤖 Помощник»). Данные отдаются по правам роли; пароли комплексов — только администратору и диспетчеру.</span></label>
      <label class="flex items-start gap-2 text-sm"><input type="checkbox" id="aiFormsFault" class="rounded accent-indigo-500 mt-0.5" ${cfg.forms_fault ? 'checked' : ''}>
        <span><b>Разбор неисправных отчётов из Яндекс Форм</b> — где не удалось починить: ИИ читает «итог работ» из формы, понимает, в чём проблема и что нужно для восстановления, и записывает это в отчёт и в карточку комплекса («Неисправность / описание»). Разбирает сам после каждой загрузки таблицы; вручную — кнопка «Разобрать ИИ сейчас» в окне «Отчёты из таблицы Яндекс Форм». Если слова ИИ не опираются на текст монтёра, ответ отбрасывается, и остаётся прежний текст.</span></label>
      <div class="rounded-xl border border-slate-700/60 bg-slate-800/30 p-3 space-y-2">
        <div class="text-sm font-semibold">Где считать ИИ</div>
        <label class="flex items-start gap-2 text-sm"><input type="checkbox" id="aiServerLlm" class="rounded accent-indigo-500 mt-0.5" ${cfg.server_llm ? 'checked' : ''}>
          <span><b>Языковая модель на сервере.</b> Выключите, если вопросы должны считать только компьютеры сотрудников (блок ниже): сервер перестанет к модели обращаться; если свободного компьютера нет — человек увидит понятное сообщение.</span></label>
        <label class="flex items-start gap-2 text-sm"><input type="checkbox" id="aiServerAsr" class="rounded accent-indigo-500 mt-0.5" ${cfg.server_asr ? 'checked' : ''}>
          <span><b>Распознавание речи на сервере.</b> Голос расшифровывается только на сервере — выключено: голосовые итоги в боте не принимаются.</span></label>
        <div class="text-xs text-slate-400">Выключатель ничего не удаляет. Чтобы ещё и освободить память сервера, можно остановить контейнеры: <code>docker compose stop llm asr</code> (запустить — <code>docker compose --profile ai up -d llm asr</code>).</div>
      </div>
      <div class="text-xs text-slate-400">Память вопросов помощника: запомнено разборов — ${(d.plans || {}).plans ?? 0}, использовано повторно — ${(d.plans || {}).hits ?? 0} раз (такие вопросы отвечаются мгновенно, без модели).</div>
      <div class="flex flex-wrap gap-2"><button type="button" id="aiRefresh" class="${btnGhost}">Обновить состояние</button>
        <button type="button" id="aiTest" class="${btnGhost}" title="Отправляет короткий пример в языковую модель и показывает, сколько времени заняло">Проверить модель на примере</button></div>
      <div id="aiTestOut" class="text-xs text-slate-300" style="white-space:pre-wrap"></div>`;
    $('#aiVoice').onchange = () => save({ bot_voice: $('#aiVoice').checked });
    $('#aiAssistant').onchange = () => save({ assistant: $('#aiAssistant').checked });
    $('#aiFormsFault').onchange = () => save({ forms_fault: $('#aiFormsFault').checked });
    $('#aiServerLlm').onchange = () => save({ server_llm: $('#aiServerLlm').checked });
    $('#aiServerAsr').onchange = () => save({ server_asr: $('#aiServerAsr').checked });
    $('#aiRefresh').onclick = async () => { try { paint(await Api.get('/api/ai/settings')); } catch (e) { $('#aiTestOut').textContent = e.message; } };
    $('#aiTest').onclick = async () => {
      const out = $('#aiTestOut');
      out.textContent = '⏳ Проверяю — модель отвечает до пары минут…';
      $('#aiTest').disabled = true;
      try {
        const r = await Api.post('/api/ai/selftest', {});
        out.textContent = `Готово за ${r.seconds} с. Разбор примера «заменили блок питания, перезагрузили роутер…»:\nЧто сделано: ${r.result.done}\nПричина: ${r.result.cause || '—'}\nЧто нужно: ${r.result.needs || '—'}\nУстранено: ${r.result.fixed}`;
      } catch (e) { out.textContent = '⚠ ' + e.message; }
      $('#aiTest').disabled = false;
    };
  };
  const save = async (changes) => {
    try { paint(await Api.put('/api/ai/settings', changes)); } catch (e) { alert(e.message); }
  };

  modal(`<h2 class="font-display text-lg font-bold mb-1">🤖 ИИ: голос и помощник</h2>
    <p class="text-xs text-slate-400 mb-3">Всё работает на сервере организации, наружу ничего не уходит. Модели ставятся отдельным архивом «lan-calendar-ai»; пока их нет — режимы можно не включать. Запросы идут по одному в порядке важности (голосовой итог монтёра — вперёд).</p>
    <div id="aiBody" class="space-y-3"></div>
    <div id="aiAgentsBox" class="mt-4"></div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`, { wide: true });
  paint(data);
  loadAgents();
}

// ---------- «ИИ на компьютерах сотрудников»: программа-агент на Windows-компьютерах берёт часть запросов к модели на себя (app/services/ai/agents.py, app/api/routes_ai_agents.py).
const AGENT_STATUS = {
  idle: ['свободен', 'text-emerald-300'], busy: ['занят', 'text-amber-300'], loading: ['грузит модель', 'text-amber-300'], no_poll: ['на связи, заданий не берёт', 'text-amber-300'],
  paused: ['на паузе (хозяин за компьютером)', 'text-amber-300'], offline: ['не отвечает', 'text-rose-300'], disabled: ['выключен', 'text-slate-400'],
};
function agoText(iso) {
  if (!iso) return '—';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  return s < 20 ? 'только что' : s < 90 ? `${Math.round(s)} с назад` : s < 5400 ? `${Math.round(s / 60)} мин назад` : s < 172800 ? `${Math.round(s / 3600)} ч назад` : `${Math.round(s / 86400)} дн. назад`;
}
async function loadAgents(newKey) {
  const box = document.getElementById('aiAgentsBox');
  if (!box) { clearInterval(window._aiAgentsTimer); return; }
  let d;
  try { d = await Api.get('/api/ai-agents'); } catch (e) { box.innerHTML = `<p class="text-xs text-rose-300">Компьютеры-помощники: не удалось загрузить (${esc(e.message)})</p>`; return; }
  const cfg = d.config, sum = d.summary;
  const rows = d.agents.map((a) => {
    const [label, cls] = AGENT_STATUS[a.status] || [a.status, ''];
    return `<tr class="border-t border-slate-700/40 align-top">
      <td class="px-2 py-1.5"><b>${esc(a.name)}</b><div class="text-[11px] text-slate-500">${esc(a.ip || '')}${a.version ? ' · v' + esc(a.version) : ''}</div><div class="text-[11px] text-slate-500" title="Компьютер привязан к своему оборудованию, а не к адресу в сети">код железа: <b>${esc(a.hw_code || '—')}</b></div></td>
      <td class="px-2 py-1.5 ${cls}">${esc(label)}${a.cooldown ? '<div class="text-[11px] text-slate-500">после сбоев — минута отдыха</div>' : ''}<div class="text-[11px] text-slate-500">сигнал: ${esc(agoText(a.last_seen))}</div></td>
      <td class="px-2 py-1.5">${esc(a.model || '—')}<div class="text-[11px] text-slate-500">${a.tps ? a.tps + ' ток/с' : 'скорость не замерена'}${a.params_b ? ' · ' + a.params_b + ' млрд парам.' : ''}${a.limit_pct ? ' · доля ресурсов ' + a.limit_pct + ' %' : ''}</div></td>
      <td class="px-2 py-1.5 text-[11px]">${esc(a.cpu || '')}${a.cores ? ' · ' + a.cores + ' потоков' : ''}${a.ram_gb ? ' · ' + a.ram_gb + ' ГБ' : ''}<div class="text-slate-500">видеокарта: ${esc(a.gpu || 'нет')}${a.gpu_used ? ' (используется)' : ''}</div></td>
      <td class="px-2 py-1.5 text-[11px]">выполнено ${a.jobs_done}${a.jobs_failed ? `, ошибок ${a.jobs_failed}` : ''}</td>
      <td class="px-2 py-1.5 whitespace-nowrap">
        <button type="button" data-ag-test="${esc(a.id)}" class="${btnGhost} !py-0.5 !px-2 text-[11px]" title="Отправить короткий вопрос этому компьютеру и замерить время">Проверить</button>
        <button type="button" data-ag-toggle="${esc(a.id)}" data-on="${a.enabled ? 1 : 0}" class="${btnGhost} !py-0.5 !px-2 text-[11px]">${a.enabled ? 'Выключить' : 'Включить'}</button>
        <button type="button" data-ag-del="${esc(a.id)}" data-name="${esc(a.name)}" class="${btnDanger} !py-0.5 !px-2 text-[11px]" title="Закончить «дружбу» с этим компьютером: запись и токен удаляются, программа на нём перестаёт подключаться. Сам сервер компьютер не убирает, даже если он давно недоступен">Отвязать</button></td></tr>`;
  }).join('');
  const keyState = (k) => k.state === 'used' ? `<span class="text-emerald-300">использован — подключён «${esc(k.agent_name || 'компьютер удалён')}»</span> · ${esc(fmtDate(k.used_at))}, больше не действует`
    : k.state === 'expired' ? '<span class="text-rose-300">срок истёк, не использован</span>' : `<span class="text-amber-300">ждёт подключения</span> · действует до ${esc(fmtDate(k.expires_at))}`;
  const keys = (d.keys || []).map((k) => `<div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-400"><span>«${esc(k.label || 'без названия')}» · ${keyState(k)}</span>
      <button type="button" data-ag-delkey="${k.id}" data-state="${k.state}" class="${btnGhost} !py-0 !px-2 text-[11px]">${k.state === 'waiting' ? 'Отозвать' : 'Убрать из списка'}</button></div>`).join('');
  const gb = (n) => (n / 1e9).toFixed(2).replace('.', ',');
  const have = new Set((d.models || []).map((m) => m.file));
  const modelRows = (d.models || []).map((m) => `<div class="flex flex-wrap items-center gap-2 text-[11px] text-slate-300"><span class="font-mono">${esc(m.file)}</span><span class="text-slate-500">${gb(m.size)} ГБ</span>
      ${!m.valid ? '<span class="text-rose-300">не модель GGUF — компьютерам не отдаётся</span>' : (m.sha256 ? '<span class="text-emerald-300" title="Контрольная сумма посчитана — компьютеры сверяют скачанное с ней">готова к скачиванию</span>' : '<span class="text-amber-300">считаю контрольную сумму…</span>')}
      <button type="button" data-ag-delmodel="${esc(m.file)}" class="${btnGhost} !py-0 !px-2 text-[11px]">Удалить с сервера</button></div>`).join('');
  const missing = (d.models_recommended || []).filter((m) => !have.has(m.file));
  box.innerHTML = `<div class="rounded-xl border border-slate-700/60 bg-slate-800/30 p-3 space-y-3">
    <label class="flex items-start gap-2 text-sm"><input type="checkbox" id="agEnabled" class="rounded accent-indigo-500 mt-0.5" ${cfg.enabled ? 'checked' : ''}>
      <span><b>ИИ на компьютерах сотрудников</b> — на Windows-компьютерах запускается программа-агент (ставится отдельно, файл «LanCalendarAIAgent.exe» из папки выдачи): она берёт заданную долю процессора и памяти (видеокарту — только достаточно сильную), сама подключается к серверу по ключу, а сервер отдаёт запросы к модели самому быстрому свободному компьютеру. Нет подходящего — считает сам, как раньше.</span></label>
    <div class="rounded-lg border border-amber-500/40 bg-amber-500/10 px-2.5 py-1.5 text-xs text-slate-200">⚠ Модель на сервере стоит в сети без выхода наружу. Запросы к агентам несут данные из базы (номера и адреса комплексов, описания неисправностей, тексты монтёров) на компьютеры сотрудников по HTTPS. Включайте, только если доверяете этим компьютерам.</div>
    <div class="text-xs text-slate-400">${cfg.enabled ? `Сейчас: компьютеров ${sum.total}, на связи ${sum.online}, свободных ${sum.free}, заняты ${sum.busy}.` : 'Режим выключен — компьютеры не подключаются и запросы им не отдаются.'}
      Связь с каждым проверяется постоянно. Не отвечающий компьютер остаётся в списке сколько угодно и сам не удаляется — вернувшись, он продолжает работать; закончить «дружбу» можно только вручную («Отвязать»). Компьютер привязан к своему оборудованию, а не к адресу в сети.</div>
    ${d.agents.length ? `<div class="rounded-xl border border-slate-700/60 overflow-auto"><table class="w-full text-xs"><thead class="bg-slate-800/70 text-slate-400"><tr>
      <th class="px-2 py-1.5 text-left">Компьютер</th><th class="px-2 py-1.5 text-left">Состояние</th><th class="px-2 py-1.5 text-left">Модель</th><th class="px-2 py-1.5 text-left">Железо</th><th class="px-2 py-1.5 text-left">Работа</th><th class="px-2 py-1.5"></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="text-xs text-slate-500">Подключённых компьютеров пока нет.</p>'}
    <div class="space-y-1.5"><div class="flex flex-wrap items-center gap-2"><b class="text-xs">Ключи подключения</b>
      <input id="agKeyLabel" maxlength="60" placeholder="для кого (необязательно)" class="${fieldCls} !w-52 !py-1 !text-xs">
      <label class="text-[11px] text-slate-400" title="Адрес, по которому компьютеры сотрудников открывают сервер: он попадёт внутрь строки подключения">адрес сервера <input id="agKeyUrl" value="${esc(location.host)}" class="${fieldCls} !w-44 !py-1 !text-xs inline-block"></label>
      <button type="button" id="agKeyNew" class="${btnGhost} !py-1 !px-3 text-xs">Создать ключ (один компьютер, 7 дней)</button></div>
      ${newKey ? `<div class="rounded-lg border border-emerald-500/40 bg-emerald-500/10 px-2.5 py-2 text-xs text-emerald-100">Строка подключения — адрес сервера и ключ вместе (показывается один раз — скопируйте сейчас):
        <div class="mt-1 flex flex-wrap items-center gap-2"><code id="agKeyText" class="select-all rounded bg-slate-900/60 px-2 py-1" style="overflow-wrap:anywhere">${esc(newKey)}</code><button type="button" id="agKeyCopy" class="${btnGhost} !py-0.5 !px-2 text-[11px]">Копировать</button></div>
        <div class="mt-1 text-emerald-200/80">В программе агента нажмите «Вставить из буфера» (или Ctrl+V) и «Подключиться». Ключ одноразовый: после подключения этого компьютера он больше не действует, а компьютер привязывается к своему оборудованию.</div></div>` : ''}
      ${keys || '<div class="text-[11px] text-slate-500">Ключей нет — создайте, чтобы подключить первый компьютер.</div>'}</div>
    <div class="space-y-1.5"><b class="text-xs">Модели на сервере</b> <span class="text-[11px] text-slate-500">— компьютеры скачивают их отсюда (быстро, без интернета); остальные модели программа берёт из интернета сама</span>
      ${modelRows || '<div class="text-[11px] text-slate-500">Пока ни одной: компьютеры будут скачивать модели из интернета.</div>'}
      ${missing.length ? `<div class="text-[11px] text-slate-400">Рекомендуем положить (средние модели 4–8 млрд параметров, разные семейства): ${missing.map((m) => `<span class="font-mono">${esc(m.file)}</span> (${m.size_gb.toFixed(1).replace('.', ',')} ГБ, ${esc(m.source)})`).join('; ')}.</div>` : '<div class="text-[11px] text-emerald-300/80">Рекомендуемый набор моделей на сервере есть.</div>'}
      <div class="text-[11px] text-slate-500">Как добавить: скопируйте файлы .gguf в папку <b>${esc(d.models_dir || 'data/agent_models')}</b> на сервере (на рабочем: /opt/lan_calendar/${esc(d.models_dir || 'data/agent_models')}); перезапуск не нужен.</div></div>
    <div class="flex flex-wrap items-center gap-3 text-xs text-slate-300">
      <label title="Для вопросов людей (голос монтёра, помощник) берутся компьютеры с моделью не меньше этого размера; более лёгкие — только для фоновых дел (разбор отчётов)">Для вопросов людей — модели от <input id="agMinB" type="number" min="0.5" max="100" step="0.5" value="${cfg.min_params_b}" class="${fieldCls} !w-20 !py-0.5 !text-xs inline-block"> млрд параметров</label>
      <button type="button" id="agSaveCfg" class="${btnGhost} !py-1 !px-3 text-xs">Сохранить</button></div>
    <div id="agMsg" class="text-xs text-slate-300"></div></div>`;
  const say = (t) => { const m = document.getElementById('agMsg'); if (m) m.textContent = t; };
  const act = async (fn, okText) => { try { await fn(); if (okText) say(okText); } catch (e) { say('⚠ ' + e.message); } loadAgents(); };
  document.getElementById('agEnabled').onchange = (e) => {
    if (e.target.checked && !confirm('Включить ИИ на компьютерах сотрудников? Запросы к модели, содержащие данные из базы, будут уходить на компьютеры с программой-агентом.')) { e.target.checked = false; return; }
    act(() => Api.put('/api/ai-agents/config', { enabled: e.target.checked }));
  };
  document.getElementById('agSaveCfg').onclick = () => act(() => Api.put('/api/ai-agents/config', { min_params_b: +document.getElementById('agMinB').value }), 'Сохранено');
  document.getElementById('agKeyNew').onclick = async () => {
    try { const k = await Api.post('/api/ai-agents/keys', { label: document.getElementById('agKeyLabel').value, server_url: document.getElementById('agKeyUrl').value.trim() }); loadAgents(k.connection || k.key); } catch (e) { say('⚠ ' + e.message); }
  };
  const copy = document.getElementById('agKeyCopy');
  if (copy) copy.onclick = () => { try { navigator.clipboard.writeText(document.getElementById('agKeyText').textContent); say('Строка скопирована — вставьте её в программе агента'); } catch (e) { say('Выделите строку и скопируйте вручную'); } };
  box.querySelectorAll('[data-ag-delkey]').forEach((b) => { b.onclick = () => { const waiting = b.dataset.state === 'waiting'; if (!waiting || confirm('Отозвать ключ? По нему больше нельзя будет подключить компьютер.')) act(() => Api.del('/api/ai-agents/keys/' + b.dataset.agDelkey)); }; });
  box.querySelectorAll('[data-ag-delmodel]').forEach((b) => { b.onclick = () => { if (confirm(`Удалить файл ${b.dataset.agDelmodel} с сервера? Компьютеры больше не смогут скачать эту модель отсюда (уже скачанное у них остаётся).`)) act(() => Api.del('/api/ai-agents/models/' + encodeURIComponent(b.dataset.agDelmodel))); }; });
  box.querySelectorAll('[data-ag-toggle]').forEach((b) => { b.onclick = () => act(() => Api.put('/api/ai-agents/' + b.dataset.agToggle, { enabled: b.dataset.on !== '1' })); });
  box.querySelectorAll('[data-ag-del]').forEach((b) => { b.onclick = () => { if (confirm(`Отвязать компьютер «${b.dataset.name}»? Запись и токен удалятся, программа на нём перестанет подключаться. Чтобы подключить его снова, создайте новый ключ.`)) act(() => Api.del('/api/ai-agents/' + b.dataset.agDel)); }; });
  box.querySelectorAll('[data-ag-test]').forEach((b) => {
    b.onclick = async () => {
      b.disabled = true; say('⏳ Проверяю компьютер…');
      try { const r = await Api.post('/api/ai-agents/' + b.dataset.agTest + '/test', {}); say(`✓ Ответил за ${r.seconds} с: «${r.text}»`); } catch (e) { say('⚠ ' + e.message); }
      b.disabled = false;
    };
  });
  clearInterval(window._aiAgentsTimer);
  if (!newKey) window._aiAgentsTimer = setInterval(() => { const m = document.getElementById('agMsg'); if (!m) { clearInterval(window._aiAgentsTimer); return; } if (!document.activeElement || document.activeElement.tagName !== 'INPUT') loadAgents(); }, 5000);
}
