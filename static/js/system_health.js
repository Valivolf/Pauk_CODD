// «Состояние системы» (только администратор): диск, база данных и её копии, фоновые задачи, проверка связи с комплексами, бот, робот карт, ИИ, сетевой диск с фото — одним окном
// с подсказками, что делать. Если что-то не в порядке, в шапке появляется значок ⚠ (раз в минуту сервер спрашивается о сводке). Бэкенд — app/services/system_health.py.
// $, esc, Api, modal, btn*, fmtDateTime — из ui.js.
const SYS_ICON = { ok: '🟢', warn: '🟡', bad: '🔴' };
const SYS_TITLE = { ok: 'Всё в порядке', warn: 'Есть замечания', bad: 'Есть проблемы' };

function sysAgo(sec) {
  if (sec < 90) return `${sec} с`;
  if (sec < 5400) return `${Math.round(sec / 60)} мин`;
  if (sec < 172800) return `${Math.round(sec / 3600)} ч`;
  return `${Math.round(sec / 86400)} дн.`;
}

async function openSystemHealth(refresh = false) {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Состояние системы</h2>
    <p class="text-xs text-slate-400 mb-3">Что может незаметно сломаться — под присмотром. Проверки лёгкие и ничего не меняют.</p>
    <div id="sysBody"><p class="text-sm text-slate-400">Проверяю…</p></div>
    <div class="flex flex-wrap items-center gap-2 pt-4">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button type="button" id="sysRefresh" class="${btnGhost}">🔄 Проверить заново</button>
      <button type="button" id="sysIntegrity" class="${btnGhost}" title="Полная проверка файла базы данных: на большой базе занимает десятки секунд">Проверить целостность базы</button>
    </div>`, { wide: true });
  const draw = async (force) => {
    const body = $('#sysBody');
    if (!body) return;
    try {
      const h = await Api.get('/api/system/health' + (force ? '?refresh=true' : ''));
      if (!$('#sysBody')) return;
      body.innerHTML = `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 px-3 py-2 mb-3 flex flex-wrap items-center gap-x-4 gap-y-1">
          <b class="text-sm">${SYS_ICON[h.level]} ${SYS_TITLE[h.level]}</b>
          <span class="text-xs text-slate-400">приложение работает ${esc(sysAgo(h.uptime_seconds))} · проверено ${esc(fmtDateTime(h.checked_at, true))}</span></div>
        <div class="space-y-1.5">${h.items.map((i) => `<div class="rounded-xl border ${i.level === 'bad' ? 'border-rose-500/40' : i.level === 'warn' ? 'border-amber-500/35' : 'border-slate-700/40'} bg-slate-800/20 px-3 py-2">
            <div class="flex flex-wrap items-baseline gap-x-2"><span>${SYS_ICON[i.level]}</span><b class="text-sm">${esc(i.title)}</b><span class="text-xs text-slate-300">${esc(i.value)}</span></div>
            ${i.hint ? `<div class="text-xs ${i.level === 'bad' ? 'text-rose-300' : 'text-amber-300'} mt-1">${esc(i.hint)}</div>` : ''}
            ${(i.orphans || []).length ? `<div class="mt-2 space-y-1.5">${i.orphans.map((o, k) => `<div class="flex flex-wrap items-center gap-2 text-xs">
                <b>${esc(o.id)}</b><span class="text-slate-400">фото: ${o.photos}, заданий: ${o.tasks}</span><span>→</span>
                <input data-orphan-new="${k}" value="${esc(o.suggest)}" placeholder="номер комплекса" class="${fieldCls} !py-1 text-xs" style="width:15rem;max-width:100%">
                <button type="button" data-orphan-go="${k}" class="${btnGhost} !px-3 !py-1 text-xs">Привязать</button></div>`).join('')}</div>` : ''}</div>`).join('')}</div>`;
      const orphans = ((h.items.find((i) => i.key === 'point_refs') || {}).orphans) || [];
      body.querySelectorAll('[data-orphan-go]').forEach((btn) => {
        btn.onclick = async () => {
          const o = orphans[Number(btn.dataset.orphanGo)];
          const target = (body.querySelector(`[data-orphan-new="${btn.dataset.orphanGo}"]`).value || '').trim();
          if (!o || !target) { toast('Впишите номер комплекса, к которому привязать', 'error'); return; }
          if (!confirm(`Привязать «${o.id}» к комплексу «${target}»?\nФото (${o.photos}), задания (${o.tasks}), отчёты и история с этого номера станут относиться к «${target}».`)) return;
          btn.disabled = true;
          try {
            const r = await Api.post('/api/system/relink-point', { old: o.id, new: target });
            toast(`Привязано записей: ${r.total}`, 'ok');
            await draw(true);
          } catch (err) { btn.disabled = false; toast(err.message, 'error'); }
        };
      });
      sysChipUpdate({ level: h.level, problems: h.items.filter((i) => i.level !== 'ok') });
    } catch (e) { if ($('#sysBody')) $('#sysBody').innerHTML = `<p class="text-sm text-rose-300">Не удалось получить состояние: ${esc(e.message)}</p>`; }
  };
  $('#sysRefresh').onclick = () => draw(true);
  $('#sysIntegrity').onclick = async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Проверяю базу…';
    try {
      const r = await Api.post('/api/system/integrity', {}, { timeoutMs: 300000 });
      toast(r.ok ? `Целостность базы в порядке (проверка заняла ${r.seconds} с).` : `База данных НЕ прошла проверку: ${r.detail}`, r.ok ? 'ok' : 'error');
      await draw(true);
    } catch (err) { toast('Не удалось проверить: ' + err.message, 'error'); }
    finally { if ($('#sysIntegrity')) { e.target.disabled = false; e.target.textContent = 'Проверить целостность базы'; } }
  };
  await draw(refresh);
}

// Значок в шапке: виден администратору только когда есть замечания; нажатие открывает окно.
function sysChipUpdate(sum) {
  const chip = $('#sysHealthChip');
  if (!chip) return;
  const bad = sum.level === 'bad';
  const n = (sum.problems || []).length;
  chip.classList.toggle('hidden', sum.level === 'ok');
  chip.textContent = `${bad ? '🔴' : '🟡'} Система: ${n}`;
  chip.title = (sum.problems || []).map((p) => `${p.title}: ${p.value}`).join('\n') || 'Всё в порядке';
}

async function sysChipPoll() {
  try { sysChipUpdate(await Api.get('/api/system/summary')); } catch { /* связи нет — значок остаётся прежним */ }
}

function mountSystemHealth() {
  const chip = $('#sysHealthChip');
  if (chip) chip.onclick = () => openSystemHealth(true);
  sysChipPoll();
  setInterval(() => { if (!document.hidden) sysChipPoll(); }, 60000);
}
