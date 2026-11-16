// «Выгрузка SIM и IP»: SIM-карты с IP-адресами в Excel по фильтрам — по категориям комплексов, по статусам, либо только свободные
// SIM (нигде не числятся). Серверная часть — app/services/sim_export.py (GET /api/excel/sim-ip-export).

async function openSimExport() {
  let categories = [];
  try { categories = await Api.get('/api/point-categories'); } catch { /* без категорий можно выгрузить всё */ }
  const statuses = typeof _pointStatusCache !== 'undefined' ? Object.keys(_pointStatusCache) : [];
  const chip = (name, value, label) => `<label class="inline-flex items-center gap-1.5 rounded-lg border border-slate-700/60 bg-slate-800/40 px-2.5 py-1 text-xs cursor-pointer">
      <input type="checkbox" name="${name}" value="${esc(value)}" class="rounded accent-indigo-500"> ${esc(label)}</label>`;
  modal(`<h2 class="font-display text-lg font-bold mb-1">Выгрузка SIM и IP</h2>
    <p class="text-xs text-slate-400 mb-3">Список SIM-карт с IP-адресами в Excel. Выберите, что выгрузить.</p>
    <form id="seForm" class="space-y-3">
      <label class="flex items-start gap-2 text-sm cursor-pointer"><input type="radio" name="scope" value="points" checked class="mt-1 accent-indigo-500">
        <span><b>SIM комплексов</b><span class="block text-xs text-slate-400">SIM и IP каждого комплекса, с категорией, статусом и адресом. Можно сузить категориями и статусами ниже (ничего не отмечено — все).</span></span></label>
      <div id="seFilters" class="rounded-xl border border-slate-700/50 bg-slate-800/20 p-3 space-y-2">
        <div class="text-xs text-slate-400">Категории комплексов</div>
        <div class="flex flex-wrap gap-1.5">${chip('uncat', '1', 'Без категории')}${categories.map((c) => chip('cat', c.id, c.name)).join('')}</div>
        ${statuses.length ? `<div class="text-xs text-slate-400 pt-1">Статусы комплексов</div>
        <div class="flex flex-wrap gap-1.5">${statuses.map((s) => chip('st', s, s)).join('')}</div>` : ''}
      </div>
      <label class="flex items-start gap-2 text-sm cursor-pointer"><input type="radio" name="scope" value="free" class="mt-1 accent-indigo-500">
        <span><b>Свободные SIM — нигде не числятся</b><span class="block text-xs text-slate-400">SIM и IP из реестра SIM↔IP, которые не стоят ни на одном комплексе и не записаны в учёте оборудования.</span></span></label>
      <label class="flex items-start gap-2 text-sm cursor-pointer"><input type="radio" name="scope" value="registry" class="mt-1 accent-indigo-500">
        <span><b>Весь реестр SIM↔IP</b><span class="block text-xs text-slate-400">Все номера из реестра с пометкой, где каждый числится: на каком комплексе, в оборудовании или нигде.</span></span></label>
      <div id="seResult" class="text-xs"></div>
      <div class="flex flex-wrap items-center gap-2 pt-1">
        <button type="button" class="cancel ${btnGhost}">Закрыть</button>
        <button type="submit" class="${btnPrimary}">⬇ Скачать .xlsx</button>
      </div>
    </form>`);
  const form = $('#seForm');
  const syncFilters = () => { $('#seFilters').style.opacity = form.scope.value === 'points' ? '1' : '.4'; $('#seFilters').style.pointerEvents = form.scope.value === 'points' ? '' : 'none'; };
  form.querySelectorAll('input[name=scope]').forEach((r) => { r.onchange = syncFilters; });
  syncFilters();
  form.onsubmit = async (e) => {
    e.preventDefault();
    const q = new URLSearchParams({ scope: form.scope.value });
    if (form.scope.value === 'points') {
      form.querySelectorAll('input[name=cat]:checked').forEach((c) => q.append('category_id', c.value));
      if (form.querySelector('input[name=uncat]:checked')) q.set('uncategorized', 'true');
      form.querySelectorAll('input[name=st]:checked').forEach((c) => q.append('status', c.value));
    }
    const btn = form.querySelector('button[type=submit]');
    btn.disabled = true;
    try {
      const res = await downloadFile('/api/excel/sim-ip-export?' + q.toString(), 'sim-ip.xlsx');
      $('#seResult').innerHTML = `<div class="rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-emerald-300">Файл скачан. Строк: <b>${esc(res.headers.get('X-Rows') || '?')}</b>.</div>`;
    } catch (err) {
      $('#seResult').innerHTML = `<div class="rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-rose-300">${esc(err.message)}</div>`;
    } finally { btn.disabled = false; }
  };
}
