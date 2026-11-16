// /assistant — «🤖 Помощник»: вопросы по данным обычными словами и заполнение шаблонов Excel/Word. Бэкенд — app/api/routes_assistant.py.
// Модель работает на процессоре сервера, поэтому вопрос — это задача, а переписка хранится НА СЕРВЕРЕ: ответ дописывает сам сервер, и он дожидается
// человека, даже если связь оборвалась, страницу закрыли или перезагрузили (или перезапустился сервер). Страница лишь показывает переписку и,
// пока есть вопросы без ответа, раз в пару секунд её обновляет — при обрыве связи тихо повторяет, а не показывает ошибку.
// Данные отдаются по правам роли (сервер); здесь только показ. $, esc, Api, btn*, fieldCls, labelCls, ROLE_DISPLAY_LABEL, changePasswordForm — из ui.js.
let CURRENT_USER = null;
const AS = { info: null, tab: 'ask', messages: [], local: [], offline: false, syncing: false, skew: 0, last: null, template: null, fill: null, agent: false, evidence: {}, flash: {}, refreshing: new Set() };
const AGENT_KEY = 'assistantAgent';
const PAGE_TITLE = document.title;
const UNSENT_KEY = 'assistantUnsent';

const asSleep = (ms) => new Promise((r) => setTimeout(r, ms));
let asWake = null;                                                     // разбудить опрос (вернулась связь, страницу снова открыли)
const asWait = (ms) => new Promise((r) => { const t = setTimeout(r, ms); asWake = () => { clearTimeout(t); r(); }; });
const asUuid = () => (window.crypto && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);

function asSaveUnsent() {
  try { localStorage.setItem(`${UNSENT_KEY}:${CURRENT_USER.id}`, JSON.stringify(AS.local.filter((l) => l.state !== 'failed').map((l) => ({ cid: l.cid, text: l.text, mode: l.mode })))); } catch { /* память браузера недоступна */ }
}
function asLoadUnsent() {
  try {
    const list = JSON.parse(localStorage.getItem(`${UNSENT_KEY}:${CURRENT_USER.id}`) || '[]');
    AS.local = list.map((l) => ({ cid: l.cid, text: l.text, mode: l.mode || 'auto', state: 'sending', error: '' }));
  } catch { AS.local = []; }
}

function asCell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  return `<td class="px-2.5 py-1.5 align-top" style="white-space:pre-wrap; overflow-wrap:anywhere; max-width:360px">${esc(s)}</td>`;
}

function asSourceTag(a) {
  if (!a || !a.source) return '';
  const text = a.source === 'preset' ? '⚡ готовый разбор — без модели, мгновенно' : a.source === 'cache' ? '⚡ такой вопрос уже разбирали — без модели, мгновенно' : '';
  return text ? `<div class="text-[11px] text-emerald-400/80 mt-1">${text}</div>` : '';
}

const asClock = (iso) => { try { return new Date(iso).toLocaleTimeString('ru-RU'); } catch { return ''; } };

function asTableHtml(columns, rows) {
  return `<div class="rounded-xl border border-slate-700/60 overflow-auto" style="max-height:52vh"><table class="w-full text-xs">
        <thead class="bg-slate-800/70 text-slate-400"><tr>${columns.map((c) => `<th class="px-2.5 py-1.5 text-left whitespace-nowrap">${esc(c.label)}</th>`).join('')}</tr></thead>
        <tbody>${rows.map((r) => `<tr class="border-t border-slate-700/40">${r.map(asCell).join('')}</tr>`).join('')}</tbody></table></div>`;
}

// Ответ словами (его пишет модель по данным, числа сверены программой): главное в ответе; цифры и записи под ним — чтобы любую фразу можно было проверить.
const asSay = (a) => `<div class="text-sm text-slate-100 leading-relaxed" style="white-space:pre-wrap">${esc(a.narration)}</div>`;
const AS_STATUS_TONE = { 'Работает': 'bg-emerald-500/15 text-emerald-300', 'Не работает': 'bg-rose-500/15 text-rose-300' };

// Карточка комплекса для ответа «что с P-2»: сведения из системы (не пересказ модели) — статус, причина, что нужно, выезды, план.
function asCardHtml(c) {
  const row = (label, value) => (value ? `<div><span class="text-slate-500">${label}:</span> ${esc(value)}</div>` : '');
  const down = c.down_since ? `нет связи с ${fmtDate(c.down_since)}${c.down_days ? ` (${c.down_days} дн.)` : ''}` : '';
  const planned = Array.isArray(c.planned) ? c.planned.join('; ') : '';
  const groups = Array.isArray(c.groups) ? c.groups.map((g) => g.name + (g.need ? ` — нужно: ${g.need}` : '')).join('; ') : '';
  return `<div class="rounded-xl border border-slate-700/60 bg-slate-900/30 px-3 py-2 text-xs space-y-0.5">
    <div class="flex flex-wrap items-center gap-2"><b class="text-sm text-slate-100">${esc(c.point_id)}</b><span class="text-slate-400">${esc(c.address || '')}</span>
      ${c.status ? `<span class="rounded-md px-1.5 py-0.5 ${AS_STATUS_TONE[c.status] || 'bg-amber-500/15 text-amber-300'}">${esc(c.status)}</span>` : ''}
      <button type="button" data-point-photos="${esc(c.point_id)}" class="rounded-lg px-2 py-0.5 bg-slate-700/60 hover:bg-slate-600/60 text-slate-200">📷 Фото</button></div>
    ${row('Питание', c.power_source)}${row('Связь', down)}${row('Почему не работает', c.fault_reason)}${row('Что нужно для восстановления', c.fault_need)}
    ${row('Последний выезд', c.last_visit ? fmtDate(c.last_visit) : '')}${row('Выездов по отчётам', c.visits_count)}${row('Запланировано', planned)}${row('Подгруппы', groups)}</div>`;
}

function asAnswerHtml(a) {
  if (!a) return '';
  const how = (a.description ? `<div class="text-[11px] text-slate-500 mt-2">Как посчитано: ${esc(a.description)}</div>` : '') + asSourceTag(a);
  if (a.kind === 'dossier') {
    return `${asSay(a)}<div class="mt-2 space-y-1.5">${(a.cards || []).map(asCardHtml).join('')}</div>${how}`;
  }
  if (a.kind === 'number') {
    if (a.narrated) {
      return `${asSay(a)}<div class="mt-2 inline-flex items-baseline gap-2 rounded-xl border border-indigo-400/25 bg-indigo-500/10 px-3 py-1"><span class="text-xl font-extrabold text-indigo-300">${esc(a.value)}</span><span class="text-xs text-slate-400">${esc(a.label)}</span></div>${how}`;
    }
    return `<div class="text-2xl font-extrabold text-indigo-300 leading-tight">${esc(a.value)}</div><div class="text-sm text-slate-300">${esc(a.label)}</div>${how}`;
  }
  if (a.kind === 'agent') {
    const ag = a.agent || {};
    const rec = a.records || { columns: [], rows: [] };
    return `<div class="text-sm text-slate-100" style="white-space:pre-wrap">${esc(a.text)}</div>
      <div class="text-[11px] text-slate-500 mt-2">🧠 Ответ составлен по записям, прочитанным пачками по ${esc(ag.batch)}: просмотрено ${esc(ag.rows_read)}${ag.rows_total > ag.rows_read ? ' из ' + esc(ag.rows_total) : ''}${ag.extra_rows ? ` (и ещё ${esc(ag.extra_rows)} по дополнительным запросам помощника)` : ''}. Текст написала модель — числа и номера сверяйте с таблицей записей ниже.</div>
      ${ag.truncated ? '<div class="text-xs text-amber-300 mt-1">Записей больше, чем помощник прочитал, — уточните вопрос (период, комплекс).</div>' : ''}
      ${ag.extra && ag.extra.length ? `<div class="text-[11px] text-slate-500 mt-1">Дополнительно помощник запрашивал: ${ag.extra.map((e) => '«' + esc(e) + '»').join('; ')}</div>` : ''}
      <details class="mt-2"><summary class="text-xs text-indigo-300 cursor-pointer select-none">Записи, которые читал помощник (${rec.rows.length})</summary><div class="mt-2">${asTableHtml(rec.columns, rec.rows)}</div></details>${how}`;
  }
  if (a.kind === 'table') {
    const err = a.agent_error ? `<div class="text-xs text-amber-300 mt-2">${esc(a.agent_error)}</div>` : '';
    if (a.narrated) {
      const total = a.total || a.rows.length;
      const count = total > a.rows.length ? `${a.rows.length} из ${total}` : `${a.rows.length}`;
      return `${asSay(a)}<details class="mt-2" ${a.rows.length <= 8 ? 'open' : ''}><summary class="text-xs text-indigo-300 cursor-pointer select-none">Записи (${esc(count)})</summary><div class="mt-2">${asTableHtml(a.columns, a.rows)}</div></details>${err}${how}`;
    }
    return `${a.text ? `<div class="text-sm text-slate-300 mb-2">${esc(a.text)}</div>` : ''}${asTableHtml(a.columns, a.rows)}${err}${how}`;
  }
  const tone = a.kind === 'denied' ? 'text-amber-300' : a.kind === 'error' ? 'text-rose-300' : 'text-slate-300';
  const say = a.narrated && a.narration ? a.narration : a.text;
  return `<div class="text-sm ${tone}" style="white-space:pre-wrap">${esc(say || 'Ничего не нашлось.')}</div>${how}`;
}

// «было X → стало Y» для числа и для таблицы (строк; какие появились или исчезли)
function asChangeText(c, number) {
  const val = number ? `<b>${esc(c.was)}</b> → <b>${esc(c.now)}</b>` : `строк было <b>${esc(c.was)}</b>, стало <b>${esc(c.now)}</b>`;
  const add = c.added && c.added.length ? ` Появились: ${c.added.map(esc).join(', ')}.` : '';
  const rem = c.removed && c.removed.length ? ` Исчезли: ${c.removed.map(esc).join(', ')}.` : '';
  return `${val}.${add}${rem}`;
}

// Под ответом: на какое время данные, «Обновить», «Из чего посчитано», и что изменилось в данных (в том числе с прошлого такого же вопроса)
function asFooterHtml(m) {
  const a = m.answer;
  if (!a || !a.computed_at) return '';
  const num = a.kind === 'number';
  const parts = [];
  const busy = AS.refreshing.has(m.id);
  if (a.file) parts.push(`<a href="/api/assistant/files/${esc(a.file.id)}" download class="rounded-lg px-2.5 py-1 bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-200 font-semibold" title="Файл собран из тех же данных, что и ответ">⬇ ${a.file.ext === 'xlsx' ? 'Excel' : 'Word'}: ${esc(a.file.name)}</a>`);
  if (a.file_error) parts.push(`<span class="text-amber-300">${esc(a.file_error)}</span>`);
  parts.push(`<span title="Данные читаются из системы заново при каждом ответе и при «Обновить»">данные на ${esc(asClock(a.checked_at || a.computed_at))}</span>`);
  if (a.refreshable) parts.push(`<button type="button" data-asrefresh="${m.id}" ${busy ? 'disabled' : ''} class="rounded-lg px-2 py-0.5 bg-slate-700/60 hover:bg-slate-600/60 text-slate-200">${busy ? '⏳ Обновляю…' : '🔄 Обновить'}</button>`);
  if (a.refreshable && (a.kind === 'number' || a.kind === 'table')) parts.push(`<button type="button" data-asevidence="${m.id}" class="rounded-lg px-2 py-0.5 bg-slate-700/60 hover:bg-slate-600/60 text-slate-200">🔍 Из чего посчитано</button>`);
  if (AS.flash[m.id]) parts.push(`<span class="text-emerald-400">${esc(AS.flash[m.id])}</span>`);
  let html = `<div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-slate-500">${parts.join('')}</div>`;
  const pv = a.previous;
  if (pv && pv.changed) html += `<div class="text-xs text-amber-300 mt-1">Вы уже задавали этот вопрос в ${esc(asClock(pv.at))}: тогда было ${asChangeText(pv, num)} Данные в системе изменились.</div>`;
  else if (pv) html += `<div class="text-[11px] text-slate-500 mt-1">Вы уже спрашивали это в ${esc(asClock(pv.at))} — данные с тех пор не изменились.</div>`;
  (a.updates || []).slice(-2).forEach((u) => { html += `<div class="text-xs text-amber-300 mt-1">Обновлено: в ${esc(asClock(u.at))} было ${asChangeText(u, num)}</div>`; });
  if (a.stale) html += `<div class="text-xs text-amber-300 mt-1">⚠ После этого ответа данные изменились${a.stale_info ? `: записей было ${esc(a.stale_info.was)}, стало ${esc(a.stale_info.now)}` : ''}. Задайте вопрос ещё раз, чтобы обновить рассказ.</div>`;
  const ev = AS.evidence[m.id];
  if (ev) {
    html += ev.loading ? '<div class="text-xs text-slate-400 mt-2">⏳ Достаю записи…</div>'
      : ev.error ? `<div class="text-xs text-rose-300 mt-2">${esc(ev.error)}</div>`
        : `<div class="mt-2"><div class="text-xs text-slate-400 mb-1">Записи, из которых получен ответ — ${esc(ev.data.total || ev.data.rows.length)}${ev.data.truncated ? ' (показаны первые ' + ev.data.rows.length + ')' : ''}:</div>${asTableHtml(ev.data.columns, ev.data.rows)}</div>`;
  }
  return html;
}

const asBubble = (inner, extra = '') => `<div style="display:flex"><div class="rounded-2xl px-3.5 py-2.5 text-sm bg-slate-800/60 border border-slate-700/60 ${extra}" style="max-width:min(900px,96%)">${inner}</div></div>`;
const asUserBubble = (text) => `<div style="display:flex; justify-content:flex-end"><div class="rounded-2xl px-3.5 py-2 text-sm bg-indigo-500/25 border border-indigo-400/30" style="max-width:min(640px,88%); white-space:pre-wrap">${esc(text)}</div></div>`;

function asPendingHtml(m) {
  const j = m.job || {};
  const typical = AS.last ? ` Обычно ответ занимает около ${Math.round(AS.last)} с.` : '';
  let line;
  const pr = j.progress;
  if (j.status === 'running' && pr && pr.stage) {
    const draft = pr.draft ? `<div class="mt-2 rounded-lg border border-slate-700/60 bg-slate-900/40 p-2.5 text-xs text-slate-200" style="white-space:pre-wrap"><div class="text-[11px] text-slate-500 mb-1">Черновик ответа — помощник читает записи по частям и дописывает:</div>${esc(pr.draft)}</div>` : '';
    const note = pr.steps ? 'Подробный разбор идёт пачками записей и занимает несколько минут. Можно закрыть страницу — ответ сохранится на сервере.'
      : `Модель работает на процессоре сервера — ответ обычно занимает около ${Math.round(AS.last || 40)} с. Можно закрыть страницу: ответ сохранится на сервере.`;
    return asBubble(`<span>🧠 ${esc(pr.stage)}${pr.steps ? ` · шаг ${esc(pr.step)} из ${esc(pr.steps)}` : ''} <span class="as-elapsed" data-since="${esc(j.started_at || '')}"></span></span>${draft}<div class="text-[11px] text-slate-500 mt-1">${note}</div>`);
  }
  if (j.status === 'running') line = `⏳ Модель разбирает вопрос… <span class="as-elapsed" data-since="${esc(j.started_at || '')}"></span>`;
  else if (j.status === 'lost') return asBubble('<span class="text-rose-300">⚠ Запрос потерялся при перезапуске сервера — задайте вопрос ещё раз.</span>');
  else line = `⏳ В очереди${j.ahead ? ` — впереди запросов: ${j.ahead}` : ''}…`;
  return asBubble(`<span>${line}</span><div class="text-[11px] text-slate-500 mt-1">Можно закрыть страницу или остаться без связи — ответ сохранится на сервере и будет здесь, когда вы вернётесь.${typical}</div>`);
}

function asMessageHtml(m) {
  if (m.role === 'user') return asUserBubble(m.text);
  if (m.status === 'pending') return asPendingHtml(m);
  return asBubble(`${asAnswerHtml(m.answer)}${asFooterHtml(m)}${m.error ? `<div class="text-sm text-rose-300">${esc(m.error)}</div>` : ''}`);
}

function asLocalHtml(l) {
  const bubble = l.state === 'failed'
    ? asBubble(`<div class="text-sm text-rose-300">${esc(l.error || 'Не удалось отправить вопрос.')}</div><button type="button" data-asretry="${esc(l.cid)}" class="${btnGhost} !py-1 !px-3 text-xs mt-2">Отправить ещё раз</button>`)
    : asBubble(`<span>📨 Отправляю вопрос…${AS.offline ? ' нет связи с сервером — повторю, как только появится.' : ''}</span>`);
  return asUserBubble(l.text) + bubble;
}

function asNetHtml() {
  return AS.offline
    ? '<div class="rounded-xl border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">⚠ Нет связи с сервером. Вопросы, которые уже отправлены, выполняются на сервере — ответы появятся здесь сами, как только связь вернётся. Страница продолжит пробовать.</div>'
    : '';
}

function asRenderAsk() {
  const box = $('#asBody');
  const ex = (AS.info.examples || []).map((e) => `<button type="button" data-asex="${esc(e)}" class="rounded-full px-3 py-1 text-xs bg-slate-800/70 hover:bg-slate-700/70 border border-slate-700 text-slate-200">${esc(e)}</button>`).join('');
  box.innerHTML = `<div id="asNet" class="mb-3"></div>
    <div id="asMsgs" class="space-y-3 mb-4" style="min-height:120px"></div>
    <div id="asExamples" class="flex flex-wrap gap-2 mb-4">${ex}</div>
    <label class="flex items-start gap-2 text-xs text-slate-300 mb-2" title="Помощник сам прочитает записи пачками, допишет ответ по ходу и при необходимости запросит недостающие данные. Дольше, но с объяснением (почему, что нужно).">
      <input type="checkbox" id="asAgent" class="rounded accent-indigo-500 mt-0.5" ${AS.agent ? 'checked' : ''}>
      <span>🧠 Подробный разбор: помощник сам читает записи небольшими пачками и дописывает ответ (почему не работает, что нужно). Вопросы «почему…», «что нужно…» разбираются так и без галочки. Дольше — несколько минут.</span>
    </label>
    <form id="asForm" class="flex items-end gap-2">
      <textarea id="asQuestion" rows="2" placeholder="Ваш вопрос… (Enter — отправить, Shift+Enter — новая строка)" class="${fieldCls}" style="resize:none; flex:1"></textarea>
      <button class="${btnPrimary}" id="asSend">Спросить</button>
      <button type="button" id="asClear" class="${btnGhost} hidden" title="Очистить переписку">Очистить</button>
    </form>
    <p class="text-[11px] text-slate-500 mt-2">Помощник только читает данные и показывает их по правам вашей роли — ничего не меняет. Пароли комплексов получают только администратор и диспетчер.
      Вопросы из примеров выше отвечаются сразу; новый вопрос модель разбирает дольше (от десятков секунд), повторный — снова мгновенно. Переписка хранится на сервере 30 дней.</p>`;
  $('#asAgent').onchange = (e) => { AS.agent = e.target.checked; try { localStorage.setItem(AGENT_KEY, AS.agent ? '1' : '0'); } catch { /* не страшно */ } };
  $('#asForm').onsubmit = (e) => { e.preventDefault(); asAsk($('#asQuestion').value); };
  $('#asQuestion').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); asAsk($('#asQuestion').value); } };
  box.querySelectorAll('[data-asex]').forEach((b) => { b.onclick = () => asAsk(b.dataset.asex); });
  $('#asClear').onclick = async () => {
    if (!confirm('Очистить всю переписку с помощником? Это нельзя отменить.')) return;
    try { await Api.del('/api/assistant/chat'); } catch (e) { alert(e.message); return; }
    AS.messages = []; AS.local = []; asSaveUnsent(); asPaint();
  };
  asPaint(true);
}

let asPaintSig = '';
function asPaint(forceScroll = false) {
  const msgs = $('#asMsgs');
  if (!msgs) return;
  const all = [...AS.messages.map(asMessageHtml), ...AS.local.map(asLocalHtml)];
  const sig = AS.messages.map((m) => `${m.id}:${m.status}:${(m.job || {}).status || ''}:${(m.job || {}).ahead ?? ''}:${((m.job || {}).progress || {}).step ?? ''}:${((m.job || {}).progress || {}).stage ?? ''}:${(((m.job || {}).progress || {}).draft || '').length}:${m.answer ? (m.answer.computed_at || '') + (m.answer.checked_at || '') + (m.answer.stale ? 's' : '') : ''}:${AS.evidence[m.id] ? (AS.evidence[m.id].loading ? 'l' : 'e') : ''}:${AS.flash[m.id] || ''}:${AS.refreshing.has(m.id) ? 'r' : ''}`).join('|') + `#${AS.local.map((l) => l.cid + l.state).join(',')}#${AS.offline}#${AS.last}`;
  $('#asNet').innerHTML = asNetHtml();
  $('#asExamples').classList.toggle('hidden', all.length > 0);
  $('#asClear').classList.toggle('hidden', !AS.messages.length);
  if (sig === asPaintSig && !forceScroll) { asTick(); return; }                          // ничего не изменилось — не перерисовываем
  const grew = AS.messages.length + AS.local.length > (msgs.dataset.count | 0);
  asPaintSig = sig;
  msgs.dataset.count = String(AS.messages.length + AS.local.length);
  msgs.innerHTML = all.length ? all.join('') : '<p class="text-sm text-slate-500">Спросите про выезды, задания, комплексы, оборудование, отсутствия — обычными словами. Например:</p>';
  msgs.querySelectorAll('[data-asretry]').forEach((b) => { b.onclick = () => asRetry(b.dataset.asretry); });
  msgs.querySelectorAll('[data-asrefresh]').forEach((b) => { b.onclick = () => asRefresh(+b.dataset.asrefresh); });
  msgs.querySelectorAll('[data-asevidence]').forEach((b) => { b.onclick = () => asEvidence(+b.dataset.asevidence); });
  if (forceScroll || grew) msgs.lastElementChild?.scrollIntoView({ block: 'end' });
  asTick();
}

function asTick() {                                                       // «думает 42 с» идёт каждую секунду без обращения к серверу
  document.querySelectorAll('.as-elapsed').forEach((el) => {
    const since = Date.parse(el.dataset.since || '');
    if (Number.isNaN(since)) { el.textContent = ''; return; }
    const sec = Math.max(0, Math.round((Date.now() + AS.skew - since) / 1000));
    el.textContent = sec >= 60 ? `${Math.floor(sec / 60)} мин ${sec % 60} с` : `${sec} с`;
  });
}
setInterval(asTick, 1000);

// ---- сообщение о готовом ответе, пока страница в фоне
function asNotifyDone(count) {
  if (!document.hidden) return;
  document.title = `✅ Ответ готов — ${PAGE_TITLE}`;
  try {
    if ('Notification' in window && Notification.permission === 'granted') new Notification('Помощник', { body: count > 1 ? `Готово ответов: ${count}` : 'Ответ на ваш вопрос готов' });
  } catch { /* уведомления недоступны */ }
}
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) { document.title = PAGE_TITLE; if (asWake) asWake(); asStartSync(); }
});
window.addEventListener('online', () => { if (asWake) asWake(); asStartSync(); });

// ---- обмен с сервером
async function asFetchChat() {
  const res = await fetch('/api/assistant/chat', { credentials: 'same-origin', cache: 'no-store' });
  if (res.status === 401) { window.location.href = '/login'; throw new Error('Требуется вход в систему'); }
  if (!res.ok) throw Object.assign(new Error(`Сервер ответил ${res.status}`), { http: res.status });
  const d = await res.json();
  if (d.server_time) AS.skew = Date.parse(d.server_time) - Date.now();
  const was = new Set(AS.messages.filter((m) => m.role === 'assistant' && m.status === 'pending').map((m) => m.id));
  AS.messages = d.messages;
  AS.last = d.last_seconds;
  const finished = AS.messages.filter((m) => m.role === 'assistant' && m.status !== 'pending' && was.has(m.id));
  if (finished.length) asNotifyDone(finished.length);
  return d;
}

async function asSyncLoop() {
  AS.syncing = true;
  let fails = 0;
  try {
    for (;;) {
      let pending = false;
      try {
        const d = await asFetchChat();
        fails = 0;
        AS.offline = false;
        pending = d.pending || AS.local.some((l) => l.state === 'sending');
      } catch (e) {
        fails += 1;
        AS.offline = true;
        pending = true;                                                   // не знаем, есть ли ответ — пробуем снова
      }
      asPaint();
      if (!pending) { asAutoRefresh().catch(() => {}); return; }
      await asWait(fails ? Math.min(15000, 1500 * (fails + 1)) : 2200);
    }
  } finally { AS.syncing = false; }
}
function asStartSync() { if (!AS.syncing && AS.tab === 'ask' && AS.info && AS.info.enabled) asSyncLoop(); }

async function asSend(item) {
  item.state = 'sending';
  item.error = '';
  let delay = 1500;
  for (;;) {
    if (!AS.local.includes(item)) return;
    try {
      const res = await fetch('/api/assistant/ask', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: item.text, client_id: item.cid, mode: item.mode || 'auto' }),
      });
      if (res.status === 401) { window.location.href = '/login'; return; }
      if (res.ok) {
        AS.local = AS.local.filter((l) => l !== item);
        asSaveUnsent();
        AS.offline = false;
        asStartSync();
        if (!AS.syncing) await asFetchChat().catch(() => {});
        asPaint(true);
        return;
      }
      if (res.status < 500) {                                             // сервер понял и отказал (выключен, слишком много запросов…) — повтор не поможет
        let detail = 'Не удалось отправить вопрос.';
        try { detail = (await res.json()).detail || detail; } catch { /* не JSON */ }
        item.state = 'failed'; item.error = detail;
        asSaveUnsent(); asPaint();
        return;
      }
    } catch { /* нет связи — повторим */ }
    AS.offline = true;
    asPaint();
    await Promise.race([asSleep(delay), new Promise((r) => window.addEventListener('online', r, { once: true }))]);
    delay = Math.min(delay * 1.7, 15000);
  }
}

function asRetry(cid) {
  const item = AS.local.find((l) => l.cid === cid);
  if (!item) return;
  item.cid = asUuid();                                                    // отказ сервера — это уже другой запрос
  asSaveUnsent(); asPaint();
  asSend(item);
}

async function asAsk(text) {
  const question = (text || '').trim();
  if (question.length < 3) return;
  const item = { cid: asUuid(), text: question, mode: AS.agent ? 'agent' : 'auto', state: 'sending', error: '' };
  AS.local.push(item);
  $('#asQuestion').value = '';
  asSaveUnsent();
  asPaint(true);
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch { /* не поддерживается */ }
  asSend(item);
}

// «Обновить»: тот же запрос по свежим данным (на сервере, без модели). silent — фоновая проверка при открытии страницы.
async function asRefresh(id, { silent = false } = {}) {
  if (AS.refreshing.has(id)) return;
  AS.refreshing.add(id);
  if (!silent) asPaint();
  try {
    const res = await Api.post('/api/assistant/refresh', { message_id: id });
    const m = AS.messages.find((x) => x.id === id);
    if (m) m.answer = res.answer;
    if (!silent) {
      AS.flash[id] = res.change && res.change.changed ? 'Данные изменились — ответ обновлён' : 'Данные те же — ничего не изменилось';
      setTimeout(() => { delete AS.flash[id]; asPaint(); }, 6000);
    }
  } catch (e) {
    if (!silent) { AS.flash[id] = 'Не удалось обновить: ' + e.message; setTimeout(() => { delete AS.flash[id]; asPaint(); }, 6000); }
  } finally {
    AS.refreshing.delete(id);
    asPaint();
  }
}

// Открыли страницу или вернулись к ней — несколько последних ответов (числа, таблицы) молча сверяются со свежими данными: так ответ не «застывает» на прошлой цифре.
async function asAutoRefresh() {
  const list = AS.messages.filter((m) => m.role === 'assistant' && m.status === 'done' && m.answer && m.answer.refreshable && ['number', 'table', 'agent'].includes(m.answer.kind)).slice(-3);
  for (const m of list) {
    const last = Date.parse(m.answer.checked_at || m.answer.computed_at || '');
    if (!Number.isNaN(last) && Date.now() + AS.skew - last < 90000) continue;
    await asRefresh(m.id, { silent: true });
  }
}

async function asEvidence(id) {
  if (AS.evidence[id] && !AS.evidence[id].error) { delete AS.evidence[id]; asPaint(); return; }       // повторное нажатие сворачивает
  AS.evidence[id] = { loading: true };
  asPaint();
  try { AS.evidence[id] = { data: await Api.post('/api/assistant/evidence', { message_id: id }) }; }
  catch (e) { AS.evidence[id] = { error: 'Не удалось получить записи: ' + e.message }; }
  asPaint();
}

// Ждёт окончания задачи (шаблоны Excel/Word). Обрыв связи не обрывает ожидание: опрос повторяется, пока связь не вернётся.
async function asPoll(jobId, onTick) {
  const started = Date.now();
  let fails = 0;
  for (;;) {
    await asSleep(fails ? Math.min(15000, 1500 * (fails + 1)) : 2200);
    let job;
    try { job = await Api.get(`/api/assistant/jobs/${jobId}`); fails = 0; }
    catch (e) {
      if (/не найдена/.test(e.message || '')) throw e;
      fails += 1;
      if (onTick) onTick({ status: 'running', queue: {}, offline: true }, Math.round((Date.now() - started) / 1000));
      if (fails > 40) throw new Error('Нет связи с сервером — проверьте соединение и повторите.');
      continue;
    }
    if (onTick) onTick(job, Math.round((Date.now() - started) / 1000));
    if (job.status === 'done' || job.status === 'error') return job;
    if (Date.now() - started > 25 * 60 * 1000) throw new Error('Слишком долго — попробуйте ещё раз позже.');
  }
}

// ---------------------------------------------------------------- шаблоны Excel/Word

function asRenderFill() {
  const box = $('#asBody');
  const t = AS.template;
  box.innerHTML = `<p class="text-sm text-slate-300 mb-3">Загрузите шаблон — файл Excel (.xlsx) или Word (.docx) с таблицей и/или метками вроде <code>{{период}}</code> — и опишите, как его заполнить и за какой период. Помощник составит план, вы его проверите, и только потом файл заполнится данными из системы (сами данные модель не придумывает).</p>
    <div class="space-y-3">
      <input type="file" id="asFile" accept=".xlsx,.xlsm,.docx" class="${fieldCls}">
      <label class="${labelCls}">Как заполнить
        <textarea id="asInstr" rows="3" class="${fieldCls}" placeholder="Например: заполни таблицу выездами по ремонту за сентябрь: дата, комплекс, адрес, что сделано, исполнитель; в заголовке проставь период">${esc(t ? t.instruction : '')}</textarea></label>
      <div class="grid grid-cols-2 gap-3" style="max-width:420px">
        <label class="${labelCls}">Период с (необязательно)<input type="date" id="asFrom" class="${fieldCls}" value="${esc(t ? t.from : '')}"></label>
        <label class="${labelCls}">по<input type="date" id="asTo" class="${fieldCls}" value="${esc(t ? t.to : '')}"></label>
      </div>
      <div class="flex flex-wrap items-center gap-2"><button id="asAnalyze" class="${btnPrimary}">Разобрать шаблон</button>
        <span class="text-[11px] text-slate-500">Период можно не выбирать, если он назван в описании («за сентябрь»).</span></div>
      <div id="asFillMsg" class="text-sm"></div>
      <div id="asPlan"></div>
    </div>`;
  $('#asAnalyze').onclick = asAnalyze;
  if (AS.fill && AS.fill.plan) asRenderPlan();
}

function asRenderPlan() {
  const p = AS.fill;
  const lines = p.preview.map((l) => `<div class="${l.startsWith('   ') ? 'ml-4 text-slate-400' : 'font-medium'} text-sm">${esc(l.trim())}</div>`).join('');
  const warn = (p.warnings || []).map((w) => `<div class="text-xs text-amber-300">⚠ ${esc(w)}</div>`).join('');
  $('#asPlan').innerHTML = `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 space-y-2">
      <div class="text-sm font-semibold">План заполнения «${esc(p.name)}»</div>${lines}${warn}
      <div class="flex flex-wrap items-end gap-3 pt-2">
        <label class="${labelCls}">Период с<input type="date" id="asFillFrom" class="${fieldCls}" value="${esc(p.period.from || '')}"></label>
        <label class="${labelCls}">по<input type="date" id="asFillTo" class="${fieldCls}" value="${esc(p.period.to || '')}"></label>
        <button id="asDoFill" class="${btnPrimary}">Заполнить файл</button>
      </div>
      <div class="text-[11px] text-slate-500">Если план неверный — поправьте описание выше и разберите шаблон заново. Период можно поменять здесь без повторного разбора.</div>
      <div id="asResult"></div></div>`;
  $('#asDoFill').onclick = asDoFill;
}

async function asAnalyze() {
  const file = $('#asFile').files[0];
  const instruction = $('#asInstr').value.trim();
  const msg = $('#asFillMsg');
  msg.className = 'text-sm text-rose-300';
  if (!file) { msg.textContent = 'Выберите файл шаблона.'; return; }
  if (!instruction) { msg.textContent = 'Опишите, как заполнить шаблон.'; return; }
  AS.template = { instruction, from: $('#asFrom').value, to: $('#asTo').value };
  const fd = new FormData();
  fd.append('file', file);
  fd.append('instruction', instruction);
  fd.append('period_from', $('#asFrom').value);
  fd.append('period_to', $('#asTo').value);
  $('#asAnalyze').disabled = true;
  msg.className = 'text-sm text-slate-300';
  msg.textContent = '⏳ Разбираю шаблон…';
  $('#asPlan').innerHTML = '';
  AS.fill = null;
  try {
    const { job_id } = await Api.upload('/api/assistant/files/analyze', fd);
    const job = await asPoll(job_id, (j, sec) => { msg.textContent = `⏳ Разбираю шаблон… ${sec} с` + ((j.queue || {}).waiting ? ` · впереди в очереди: ${j.queue.waiting}` : ''); });
    if (job.status !== 'done') throw new Error(job.error || 'Не удалось разобрать шаблон.');
    AS.fill = { ...job.result, jobId: job_id };
    msg.textContent = '';
    asRenderPlan();
  } catch (e) {
    msg.className = 'text-sm text-rose-300';
    msg.textContent = e.message;
  } finally {
    $('#asAnalyze').disabled = false;
  }
}

async function asDoFill() {
  const out = $('#asResult');
  out.className = 'text-sm text-slate-300 pt-2';
  out.textContent = '⏳ Заполняю…';
  $('#asDoFill').disabled = true;
  try {
    const { job_id } = await Api.post('/api/assistant/files/fill', { job_id: AS.fill.jobId, period_from: $('#asFillFrom').value, period_to: $('#asFillTo').value });
    const job = await asPoll(job_id);
    if (job.status !== 'done') throw new Error(job.error || 'Не удалось заполнить файл.');
    const r = job.result;
    const rows = (r.tables || []).map((t) => `<div class="text-xs text-slate-400">${esc(t.where)}: строк записано — ${t.rows}</div>`).join('');
    const warn = (r.warnings || []).map((w) => `<div class="text-xs text-amber-300">⚠ ${esc(w)}</div>`).join('');
    out.className = 'pt-2';
    out.innerHTML = `<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 space-y-1">
        <div class="text-sm text-emerald-200">Готово: <a class="underline font-semibold" href="/api/assistant/files/${esc(r.file_id)}" download>⬇ ${esc(r.name)}</a></div>${rows}${r.placeholders ? `<div class="text-xs text-slate-400">Меток заменено: ${r.placeholders}</div>` : ''}${warn}</div>`;
  } catch (e) {
    out.className = 'text-sm text-rose-300 pt-2';
    out.textContent = e.message;
  } finally {
    $('#asDoFill').disabled = false;
  }
}

// ---------------------------------------------------------------- страница

function asRenderShell() {
  const info = AS.info;
  const state = !info.enabled ? '<span class="rounded-full px-2.5 py-0.5 text-xs bg-amber-500/15 text-amber-300">выключен</span>'
    : info.ready ? '<span class="rounded-full px-2.5 py-0.5 text-xs bg-emerald-500/15 text-emerald-300">готов</span>'
      : '<span class="rounded-full px-2.5 py-0.5 text-xs bg-rose-500/15 text-rose-300">модель не отвечает</span>';
  const tabBtn = (id, label) => `<button type="button" data-astab="${id}" class="${AS.tab === id ? btnPrimary : btnGhost}">${label}</button>`;
  $('#content').innerHTML = `<div class="flex flex-wrap items-center justify-between gap-3 mb-4">
      <div class="flex flex-wrap gap-2">${tabBtn('ask', '💬 Вопросы по данным')}${tabBtn('fill', '📄 Заполнить шаблон Excel / Word')}</div>
      <div class="flex items-center gap-2 text-xs text-slate-400">Помощник: ${state}${info.last_seconds ? `<span>последний запрос — ${info.last_seconds} с</span>` : ''}</div></div>
    <div id="asBody"></div>`;
  document.querySelectorAll('[data-astab]').forEach((b) => { b.onclick = () => { AS.tab = b.dataset.astab; asRenderShell(); }; });
  if (!info.enabled) {
    $('#asBody').innerHTML = `<p class="text-sm text-slate-300">Помощник выключен администратором.${can('admin.settings') ? ' Включить: на главной «Настройки → 🤖 ИИ: голос и помощник…».' : ''}</p>`;
    return;
  }
  if (AS.tab === 'ask') { asRenderAsk(); asStartSync(); } else asRenderFill();
}

$('#userMenuBtn').onclick = () => $('#userMenu').classList.toggle('hidden');
document.addEventListener('click', (e) => {
  if (!e.target.closest('#userMenuBtn') && !e.target.closest('#userMenu')) $('#userMenu').classList.add('hidden');
});
$('#changePwBtn').onclick = () => { $('#userMenu').classList.add('hidden'); changePasswordForm({ forced: false }); };
$('#logoutBtn').onclick = async () => { await Api.post('/api/auth/logout', {}); window.location.href = '/login'; };

async function boot() {
  try { CURRENT_USER = await Api.get('/api/auth/me'); } catch { return; }
  initUserUi();
  const back = $('#backLink');
  if (!can('calendar.view')) {        // календаря нет — «назад» ведёт на первую доступную страницу
    const first = firstPageFor('/assistant');
    if (first) { back.href = first.path; back.textContent = '← ' + first.label; } else back.classList.add('hidden');
  }
  if (CURRENT_USER.must_change_password) changePasswordForm({ forced: true });
  asLoadUnsent();
  try { AS.agent = localStorage.getItem(AGENT_KEY) === '1'; } catch { AS.agent = false; }
  try { AS.info = await Api.get('/api/assistant/info'); }
  catch (e) { $('#content').innerHTML = `<p class="text-sm text-rose-300">${esc(e.message)}</p>`; return; }
  asRenderShell();
  if (AS.info.enabled) {
    asStartSync();                                              // переписка с сервера (и ожидание ответов на прежние вопросы)
    AS.local.forEach((item) => asSend(item));                   // вопросы, которые не успели уйти до закрытия страницы (тот же номер — не задвоятся)
  }
  setInterval(async () => {                                     // готовность модели и очередь — раз в полминуты, пока страница открыта
    if (document.hidden) return;
    try { AS.info = { ...AS.info, ...(await Api.get('/api/assistant/info')) }; } catch { /* следующий раз */ }
  }, 30000);
}
boot();
