// «Дубли комплексов»: «НОМЕР +1», «НОМЕР +2» (и номера, отличающиеся только регистром/пробелами) → один комплекс.
// Серверная часть — app/services/point_merge.py: задания, отчёты, фото, история и остальное переходят на основной комплекс,
// дубли удаляются.

function pmCounts(p) {
  const parts = [];
  if (p.tasks) parts.push(`заданий ${p.tasks}`);
  if (p.reports) parts.push(`отчётов ${p.reports}`);
  if (p.photos) parts.push(`фото ${p.photos}`);
  return parts.length ? parts.join(', ') : 'ничего не привязано';
}

async function openPointDuplicates() {
  modal(`<h2 class="font-display text-lg font-bold mb-1">Дубли комплексов</h2>
    <p class="text-xs text-slate-400 mb-3">Один и тот же комплекс заведён несколько раз — например, «ARENA-1» и «ARENA-1 +1» (так бывает после импорта с карты) или «ТО-5» и «TO 5».
      При объединении <b>всё, что привязано к дублю</b> (задания, отчёты и история выездов, фото, история статусов, оборудование, чат…), переходит на основной комплекс,
      пустые поля основного заполняются данными из дубля, а сам дубль удаляется. Основным выбран комплекс без «+N» (или с большим числом записей) — выбор можно поменять.</p>
    <div id="pmBody"><p class="text-sm text-slate-500">Ищу дубли…</p></div>`, { wide: true });
  let groups;
  try { groups = (await Api.get('/api/points/duplicates')).groups; }
  catch (e) { $('#pmBody').innerHTML = `<p class="text-sm text-rose-400">${esc(e.message)}</p><button type="button" class="cancel ${btnGhost} mt-3">Закрыть</button>`; $('#pmBody .cancel').onclick = close; return; }
  if (!groups.length) {
    $('#pmBody').innerHTML = `<p class="text-sm text-emerald-300">Дублей не найдено.</p><button type="button" class="cancel ${btnGhost} mt-3">Закрыть</button>`;
    $('#pmBody .cancel').onclick = close;
    return;
  }
  const kindLabel = { suffix: 'НОМЕР +N', similar: 'похожие номера' };
  $('#pmBody').innerHTML = `<div class="flex flex-wrap items-center gap-3 mb-2">
      <label class="text-xs text-slate-300 flex items-center gap-1.5"><input type="checkbox" id="pmAll" checked class="rounded accent-indigo-500"> Все группы «НОМЕР +N»</label>
      <span class="text-xs text-slate-500">Групп: ${groups.length}. «Похожие номера» отмечайте вручную — проверьте, что это правда один комплекс.</span>
    </div>
    <div class="space-y-2" id="pmGroups" style="max-height:55vh; overflow:auto">${groups.map((g, gi) => {
      const members = [g.base, ...g.dups];
      return `<div class="rounded-xl border border-slate-700/60 bg-slate-800/30 p-3" data-pm-group="${gi}">
        <label class="flex items-center gap-2 text-sm font-semibold mb-1.5"><input type="checkbox" data-pm-check="${gi}" ${g.kind === 'suffix' ? 'checked' : ''} class="rounded accent-indigo-500">
          Объединить <span class="text-[11px] font-normal text-slate-400">· ${esc(kindLabel[g.kind])}</span></label>
        <div class="space-y-1">${members.map((m, mi) => `<label class="flex items-start gap-2 text-sm cursor-pointer">
            <input type="radio" name="pmBase${gi}" value="${esc(m.id)}" ${mi === 0 ? 'checked' : ''} class="mt-1 accent-indigo-500">
            <span><b>${esc(m.id)}</b> <span class="text-xs text-slate-400">${esc(m.address || 'без адреса')} · ${esc(pmCounts(m))}${m.status ? ' · ' + esc(m.status) : ''}</span>
              <span class="text-[11px] text-slate-500 block">${mi === 0 ? 'основной' : 'будет присоединён к основному'}</span></span></label>`).join('')}</div>
      </div>`;
    }).join('')}</div>
    <div id="pmResult" class="mt-3 text-xs"></div>
    <div class="flex flex-wrap items-center gap-2 pt-3">
      <button type="button" class="cancel ${btnGhost}">Закрыть</button>
      <button type="button" id="pmMerge" class="${btnPrimary}">Объединить отмеченные</button>
    </div>`;
  $('#pmBody .cancel').onclick = close;
  const boxes = () => [...document.querySelectorAll('#pmGroups [data-pm-check]')];
  const radios = (gi) => [...document.querySelectorAll(`#pmGroups input[name="pmBase${gi}"]`)];
  // подпись «основной / будет присоединён» следует за выбором
  groups.forEach((g, gi) => radios(gi).forEach((r) => { r.onchange = () => radios(gi).forEach((x) => { x.closest('label').querySelector('.text-slate-500').textContent = x.checked ? 'основной' : 'будет присоединён к основному'; }); }));
  $('#pmAll').onchange = (e) => boxes().forEach((b) => { if (groups[+b.dataset.pmCheck].kind === 'suffix') b.checked = e.target.checked; });
  const updateBtn = () => { const n = boxes().filter((b) => b.checked).length; $('#pmMerge').textContent = n ? `Объединить отмеченные (${n})` : 'Объединить отмеченные'; $('#pmMerge').disabled = !n; };
  boxes().forEach((b) => { b.onchange = updateBtn; });
  $('#pmAll').addEventListener('change', updateBtn);
  updateBtn();
  $('#pmMerge').onclick = async () => {
    const picked = boxes().filter((b) => b.checked).map((b) => {
      const gi = +b.dataset.pmCheck;
      const base = radios(gi).find((r) => r.checked).value;
      return { base, dups: [groups[gi].base, ...groups[gi].dups].map((m) => m.id).filter((id) => id !== base) };
    });
    if (!picked.length) return;
    if (!confirm(`Объединить групп: ${picked.length}? Дубли будут удалены, всё привязанное к ним перейдёт на основной комплекс. Отменить это нельзя.`)) return;
    $('#pmMerge').disabled = true; $('#pmMerge').textContent = 'Объединяю…';
    try {
      const r = await Api.post('/api/points/merge-duplicates', { groups: picked });
      const moved = {};
      r.results.forEach((x) => Object.entries(x.moved).forEach(([t, n]) => { moved[t] = (moved[t] || 0) + n; }));
      $('#pmResult').innerHTML = `<div class="rounded-xl border border-emerald-500/40 bg-emerald-500/10 px-3 py-2 text-emerald-200">Объединено дублей: <b>${r.merged}</b>. Перенесено записей: ${Object.values(moved).reduce((a, b) => a + b, 0)}.</div>`;
      if (typeof loadPoints === 'function') await loadPoints();
      setTimeout(() => openPointDuplicates(), 1200);
    } catch (e) {
      $('#pmResult').innerHTML = `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">${esc(e.message)}</div>`;
      updateBtn();
    }
  };
}
