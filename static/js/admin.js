// Администрирование: пользователи и роли. Роль — набор прав, выбираемых галочками; человек видит только те разделы и кнопки, на которые у его роли есть право (static/js/ui.js: data-perm),
// а сервер проверяет право на каждый запрос (app/core/perm_guard.py). Права раздаются «не выше своих»: чего нет у вас самих, того галочкой не выбрать.
let ADM = { tab: 'users', roles: [], catalog: [], users: [] };

const admRoleBadge = (u) => {
  const color = u.role === 'admin' ? 'bg-indigo-500/20 text-indigo-300' : u.role === 'warehouse' ? 'bg-amber-500/20 text-amber-300' : u.role === 'viewer' ? 'bg-sky-500/20 text-sky-300'
    : u.role === 'absences' ? 'bg-rose-500/20 text-rose-300' : u.role === 'user' ? 'bg-slate-700/60 text-slate-300' : 'bg-emerald-500/15 text-emerald-300';
  return `<span class="rounded-full ${color} text-[11px] font-medium px-2 py-0.5">${esc(u.role_name || u.role)}</span>`;
};

const admMine = () => (typeof CURRENT_USER !== 'undefined' && CURRENT_USER && CURRENT_USER.permissions) || [];
const admGrantAll = () => admMine().includes('*');
const admHas = (key) => admGrantAll() || admMine().includes(key);
const admCovers = (role) => admGrantAll() || (!role.permissions.includes('*') && role.permissions.every((p) => admMine().includes(p)));
const admAllKeys = () => ADM.catalog.flatMap((g) => g.items.map((it) => it.key));
const admItem = (key) => ADM.catalog.flatMap((g) => g.items).find((it) => it.key === key);

async function admLoad() {
  const [users, roles] = await Promise.all([Api.get('/api/admin/users'), Api.get('/api/admin/roles')]);
  ADM.users = users; ADM.roles = roles.roles; ADM.catalog = roles.catalog;
  try { ADM.games = await Api.get('/api/admin/games'); } catch { ADM.games = null; }
}

// Права могли измениться у самого администратора (роль поправили) — обновляем кнопки сразу, без перезагрузки страницы
async function admRefreshMe() {
  try { CURRENT_USER = await Api.get('/api/auth/me'); applyPerms(document); } catch { /* не критично: при следующем открытии страницы подтянется */ }
}

async function openAdminPanel(tab) {
  if (tab) ADM.tab = tab;
  try { await admLoad(); } catch (e) { alert('Не удалось загрузить: ' + e.message); return; }
  admRender();
}

function admRender() {
  const tabBtn = (k, label) => `<button type="button" data-admtab="${k}" class="rounded-xl px-4 py-1.5 text-sm font-semibold transition-colors ${ADM.tab === k ? 'bg-indigo-500 text-white' : 'bg-slate-800/70 hover:bg-slate-700/70 text-slate-300'}">${label}</button>`;
  modal(`<h2 class="font-display text-lg font-bold mb-3">Администрирование</h2>
    <div class="flex flex-wrap gap-2 mb-4">${tabBtn('users', 'Пользователи')}${tabBtn('roles', 'Роли и права')}${tabBtn('games', '🎮 Игры')}</div>
    <div id="admBody">${ADM.tab === 'roles' ? admRolesHtml() : ADM.tab === 'games' ? admGamesHtml() : admUsersHtml()}</div>
    <div class="flex items-center gap-2 pt-4"><button type="button" class="cancel ${btnGhost}">Закрыть</button></div>`, { wide: ADM.tab === 'roles' || ADM.tab === 'games' });
  document.querySelectorAll('[data-admtab]').forEach((b) => { b.onclick = () => { ADM.tab = b.dataset.admtab; admRender(); }; });
  if (ADM.tab === 'roles') admWireRoles(); else if (ADM.tab === 'games') admWireGames(); else admWireUsers();
}

// ---------- пользователи ----------
function admRoleOptions(selected) {
  return ADM.roles.filter((r) => admCovers(r) || r.key === selected)
    .map((r) => `<option value="${esc(r.key)}" ${r.key === selected ? 'selected' : ''} ${admCovers(r) ? '' : 'disabled'}>${esc(r.name)}</option>`).join('');
}

function admUsersHtml() {
  return `<div class="space-y-2 mb-5 max-h-72 overflow-auto pr-1">
      ${ADM.users.map((u) => {
        const me = u.id === CURRENT_USER.id;
        const role = ADM.roles.find((r) => r.key === u.role);
        const stronger = role && !admCovers(role);           // роль шире ваших прав — её обладателя трогать нельзя
        return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3" style="display:grid; gap:.5rem">
        <span class="text-sm flex items-center gap-2 flex-wrap" style="min-width:0">
          <b class="font-semibold" style="overflow-wrap:anywhere" title="Логин">${esc(u.username)}</b>${admRoleBadge(u)}${me ? '<span class="text-[11px] text-slate-500">это вы</span>' : ''}
          ${u.must_change_password ? '<span class="text-[11px] text-amber-300">ожидает смены пароля</span>' : ''}
        </span>
        <span class="flex items-center gap-1.5 flex-wrap">
          <select data-role-select="${u.id}" class="rounded-lg px-2 py-1 text-xs" style="width:auto; max-width:16rem" ${me || stronger ? 'disabled' : ''}>${admRoleOptions(u.role)}</select>
          <button data-reset="${u.id}" class="${btnGhost} !py-1 !px-2 text-xs" ${stronger ? 'disabled' : ''}>Сбросить пароль</button>
          <button data-remove="${u.id}" class="${btnDanger} !py-1 !px-2 text-xs" ${me || stronger ? 'disabled' : ''}>Удалить</button>
        </span>
      </div>`;
      }).join('') || '<p class="text-sm text-slate-500">Пользователей нет</p>'}
    </div>

    <div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4">
      <b class="text-sm block mb-3">Добавить пользователя</b>
      <form id="newUserForm" class="space-y-3">
        <div class="grid grid-cols-2 gap-3">
          <label class="${labelCls}">Логин<input name="username" required minlength="3" class="${fieldCls}"></label>
          <label class="${labelCls}">Роль<select name="role" class="${fieldCls}">${admRoleOptions('user')}</select></label>
          <label class="${labelCls} col-span-2">Пароль<input name="password" type="password" required minlength="8" placeholder="не короче 8 знаков: буквы и цифры" autocomplete="new-password" class="${fieldCls}"></label>
        </div>
        <p class="text-[11px] text-slate-500">Что доступно роли, выбирается на вкладке «Роли и права»: там же можно создать свою роль.</p>
        <div id="newUserError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
        <button class="${btnPrimary}">Создать</button>
      </form>
    </div>`;
}

function admWireUsers() {
  $('#newUserForm').onsubmit = async (e) => {
    e.preventDefault();
    const f = e.target.elements;
    try {
      await Api.post('/api/admin/users', { username: f.username.value.trim(), password: f.password.value, role: f.role.value });
      await openAdminPanel();
    } catch (err) {
      $('#newUserError').textContent = err.message;
      $('#newUserError').classList.remove('hidden');
    }
  };
  $('#modal').querySelectorAll('[data-role-select]').forEach((sel) => {
    sel.onchange = async () => {
      try { await Api.patch(`/api/admin/users/${sel.dataset.roleSelect}/role`, { role: sel.value }); await openAdminPanel(); }
      catch (err) { alert(err.message); await openAdminPanel(); }
    };
  });
  $('#modal').querySelectorAll('[data-reset]').forEach((btn) => {
    btn.onclick = async () => {
      const pw = prompt('Новый пароль для пользователя (не менее 8 знаков, буквы и цифры):');
      if (!pw) return;
      try { await Api.post(`/api/admin/users/${btn.dataset.reset}/reset-password`, { new_password: pw }); alert('Пароль сброшен.'); await openAdminPanel(); }
      catch (err) { alert(err.message); }
    };
  });
  $('#modal').querySelectorAll('[data-remove]').forEach((btn) => {
    btn.onclick = async () => {
      if (!confirm('Удалить пользователя?')) return;
      try { await Api.del(`/api/admin/users/${btn.dataset.remove}`); await openAdminPanel(); }
      catch (err) { alert(err.message); }
    };
  });
}

// ---------- игры ----------
// Игры (страница /games) включаются каждому пользователю отдельно: галочка «Включено» и, если нужно, выбор конкретных игр (по умолчанию — все). Рекорды можно сбросить.
function admGamesHtml() {
  const g = ADM.games;
  if (!g) return '<p class="text-sm text-rose-300">Не удалось загрузить настройки игр.</p>';
  const on = g.users.filter((u) => u.enabled).length;
  return `<div class="flex items-center justify-between mb-3 gap-2 flex-wrap">
      <p class="text-xs text-slate-400" style="max-width:40rem">Игры для перерывов: ${g.catalog.length} штук, работают без интернета. Включены у ${on} из ${g.users.length}. Человек с включёнными играми видит пункт «🎮 Игры» в меню своего имени.</p>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" data-gm-bulk="1" class="${btnGhost} !py-1 !px-2.5 text-xs">Включить всем</button>
        <button type="button" data-gm-bulk="0" class="${btnGhost} !py-1 !px-2.5 text-xs">Выключить всем</button>
        <button type="button" data-gm-reset-all="1" class="${btnDanger} !py-1 !px-2.5 text-xs">Сбросить все рекорды</button>
      </div></div>
    <div id="admGamesList" class="space-y-2 max-h-[60vh] overflow-auto pr-1">${admGamesRows()}</div>`;
}

function admGamesRows() {
  const g = ADM.games;
  return g.users.map((u) => {
    const all = u.games === null;
    const n = all ? g.catalog.length : u.games.length;
    const open = ADM.gmOpen === u.id;
    return `<div class="rounded-xl border border-slate-700/50 bg-slate-800/30 p-3" data-gm-user="${u.id}" style="display:grid; gap:.5rem">
      <div class="flex items-center gap-3 flex-wrap">
        <label class="flex items-center gap-2 text-sm cursor-pointer"><input type="checkbox" data-gm-en="${u.id}" ${u.enabled ? 'checked' : ''}>
          <b class="font-semibold" style="overflow-wrap:anywhere">${esc(u.username)}</b></label>
        <span class="text-[11px] ${u.enabled ? 'text-emerald-300' : 'text-slate-500'}">${u.enabled ? (all ? 'все игры' : `игр: ${n} из ${g.catalog.length}`) : 'выключено'}</span>
        <span class="text-[11px] text-slate-500">партий: ${u.plays}</span>
        <span class="flex gap-1.5 ml-auto">
          <button type="button" data-gm-pick="${u.id}" class="${btnGhost} !py-1 !px-2 text-xs">${open ? 'Свернуть' : 'Выбрать игры'}</button>
          <button type="button" data-gm-reset="${u.id}" class="${btnGhost} !py-1 !px-2 text-xs" ${u.games_played ? '' : 'disabled'} title="Удалить рекорды этого человека">Сбросить рекорды</button>
        </span>
      </div>
      ${open ? `<div class="flex flex-wrap gap-x-4 pt-1" style="row-gap:.4rem" data-gm-picks="${u.id}">
        <label class="flex items-center gap-1.5 text-xs font-semibold cursor-pointer"><input type="checkbox" data-gm-all="${u.id}" ${all ? 'checked' : ''}> Все игры</label>
        ${g.catalog.map((c) => `<label class="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" data-gm-one="${u.id}" value="${esc(c.key)}" ${all || u.games.includes(c.key) ? 'checked' : ''} ${all ? 'disabled' : ''}> ${c.icon} ${esc(c.title)}</label>`).join('')}
      </div>` : ''}
    </div>`;
  }).join('') || '<p class="text-sm text-slate-500">Пользователей нет</p>';
}

async function admGamesRefresh() {
  await keepScroll('#admBody', async () => {
    ADM.games = await Api.get('/api/admin/games');
    admRender();
  });
}

function admWireGames() {
  const root = $('#modal');
  const save = async (id, enabled, games) => {
    try { await Api.put(`/api/admin/games/users/${id}`, { enabled, games }); await admGamesRefresh(); }
    catch (err) { alert(err.message); await admGamesRefresh(); }
  };
  const user = (id) => ADM.games.users.find((u) => u.id === +id);
  root.querySelectorAll('[data-gm-bulk]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(b.dataset.gmBulk === '1' ? 'Включить игры всем пользователям?' : 'Выключить игры всем пользователям?')) return;
      try { await Api.post('/api/admin/games/bulk', { enabled: b.dataset.gmBulk === '1' }); await admGamesRefresh(); } catch (err) { alert(err.message); }
    };
  });
  root.querySelectorAll('[data-gm-reset-all]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm('Удалить рекорды всех сотрудников по всем играм? Это нельзя отменить.')) return;
      try { const r = await Api.post('/api/admin/games/reset-scores', {}); alert(`Удалено записей: ${r.removed}`); await admGamesRefresh(); } catch (err) { alert(err.message); }
    };
  });
  root.querySelectorAll('[data-gm-reset]').forEach((b) => {
    b.onclick = async () => {
      if (!confirm(`Удалить рекорды пользователя «${user(b.dataset.gmReset).username}»?`)) return;
      try { await Api.post('/api/admin/games/reset-scores', { user_id: +b.dataset.gmReset }); await admGamesRefresh(); } catch (err) { alert(err.message); }
    };
  });
  root.querySelectorAll('[data-gm-en]').forEach((c) => { c.onchange = () => save(c.dataset.gmEn, c.checked, user(c.dataset.gmEn).games); });
  root.querySelectorAll('[data-gm-pick]').forEach((b) => {
    b.onclick = () => { ADM.gmOpen = ADM.gmOpen === +b.dataset.gmPick ? null : +b.dataset.gmPick; keepScroll('#admBody', async () => admRender()); };
  });
  root.querySelectorAll('[data-gm-all]').forEach((c) => { c.onchange = () => save(c.dataset.gmAll, user(c.dataset.gmAll).enabled, c.checked ? null : ADM.games.catalog.map((x) => x.key)); });
  root.querySelectorAll('[data-gm-one]').forEach((c) => {
    c.onchange = () => {
      const id = c.dataset.gmOne;
      const picked = [...root.querySelectorAll(`[data-gm-one="${id}"]`)].filter((x) => x.checked).map((x) => x.value);
      save(id, user(id).enabled, picked);
    };
  });
}

// ---------- роли ----------
function admRolesHtml() {
  const total = admAllKeys().length;
  const card = (r) => {
    const n = r.locked ? 'все права' : `прав: ${r.permissions.length} из ${total}`;
    const canEdit = !r.locked && admCovers(r);
    const canDelete = !r.is_system && !r.users && admCovers(r);
    return `<div class="rounded-2xl border border-slate-700/60 bg-slate-800/30 p-4 space-y-2" data-role-card="${esc(r.key)}">
      <div class="flex items-start justify-between gap-2 flex-wrap">
        <div class="min-w-0"><b class="text-sm">${esc(r.name)}</b>
          <span class="ml-1 rounded-full ${r.is_system ? 'bg-slate-700/60 text-slate-300' : 'bg-emerald-500/15 text-emerald-300'} text-[10px] font-medium px-2 py-0.5">${r.is_system ? 'встроенная' : 'своя'}</span></div>
        <span class="text-[11px] text-slate-400 whitespace-nowrap">${esc(n)} · пользователей: ${r.users}</span>
      </div>
      <p class="text-xs text-slate-400" style="min-height:2.2em">${esc(r.description || 'Без описания')}</p>
      <div class="flex flex-wrap gap-1.5">
        <button type="button" data-role-edit="${esc(r.key)}" class="${btnGhost} !py-1 !px-2.5 text-xs">${canEdit ? '✎ Права' : '👁 Права'}</button>
        <button type="button" data-role-copy="${esc(r.key)}" class="${btnGhost} !py-1 !px-2.5 text-xs" title="Новая роль с теми же правами — удобно взять за основу">⧉ Копия</button>
        ${canDelete ? `<button type="button" data-role-del="${esc(r.key)}" class="${btnDanger} !py-1 !px-2.5 text-xs">Удалить</button>` : ''}
      </div>
    </div>`;
  };
  return `<div class="flex items-center justify-between mb-3 gap-2 flex-wrap">
      <p class="text-xs text-slate-400" style="max-width:46rem">Роль — набор прав. Человек видит только те разделы и кнопки, на которые у его роли есть право; запрет действует и на сервере. Можно изменить права встроенных ролей
        (кроме администратора) или создать свою — с любым сочетанием прав.</p>
      <button type="button" id="admRoleNew" class="${btnPrimary} !px-4 !py-1.5 text-xs">＋ Новая роль</button>
    </div>
    <div class="grid md:grid-cols-2 gap-3 max-h-[60vh] overflow-auto pr-1">${ADM.roles.map(card).join('')}</div>`;
}

function admWireRoles() {
  $('#admRoleNew').onclick = () => admRoleEditor(null);
  $('#modal').querySelectorAll('[data-role-edit]').forEach((b) => { b.onclick = () => admRoleEditor(ADM.roles.find((r) => r.key === b.dataset.roleEdit)); });
  $('#modal').querySelectorAll('[data-role-copy]').forEach((b) => {
    b.onclick = () => {
      const src = ADM.roles.find((r) => r.key === b.dataset.roleCopy);
      admRoleEditor(null, { name: `Копия — ${src.name}`, description: src.description, permissions: src.locked ? admAllKeys() : src.permissions });
    };
  });
  $('#modal').querySelectorAll('[data-role-del]').forEach((b) => {
    b.onclick = async () => {
      const r = ADM.roles.find((x) => x.key === b.dataset.roleDel);
      if (!confirm(`Удалить роль «${r.name}»?`)) return;
      try { await Api.del(`/api/admin/roles/${encodeURIComponent(r.key)}`); await openAdminPanel('roles'); }
      catch (err) { alert(err.message); }
    };
  });
}

// Редактор роли: название, описание и галочки по группам. Право, подразумеваемое другим выбранным («изменять» → «видеть»), включено само и не снимается, пока выбрано то, что его требует.
function admRoleEditor(role, draft) {
  const isNew = !role;
  const locked = !!(role && role.locked);
  const tooStrong = !!(role && !locked && !admCovers(role));       // роль шире ваших прав — только смотреть
  const readOnly = locked || tooStrong;
  const chosen = new Set((role ? role.permissions : (draft ? draft.permissions : [])).filter((p) => p !== '*'));
  const keys = admAllKeys();
  if (locked) keys.forEach((k) => chosen.add(k));
  const impliedBy = (k) => [...chosen].filter((c) => c !== k && (admItem(c)?.implies || []).includes(k));
  const effective = () => { const e = new Set(chosen); chosen.forEach((c) => (admItem(c)?.implies || []).forEach((x) => e.add(x))); return e; };
  const pagesText = (eff) => {
    const has = (k) => eff.has(k);
    const open = PAGE_ORDER.filter(([, key]) => [].concat(key).some(has)).map((p) => p[2]);
    return open.length ? open.join(' · ') : 'ни одна — человек увидит только страницу «Нет доступа»';
  };
  const groupHtml = (g) => `<section class="rounded-2xl border border-slate-700/50 bg-slate-800/20 p-3" data-grp="${esc(g.group)}">
      <div class="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <b class="text-sm">${esc(g.group)}</b>
        ${readOnly ? '' : `<span class="flex gap-1.5"><button type="button" data-grp-all="${esc(g.group)}" class="${btnGhost} !py-0.5 !px-2 text-[11px]">выбрать все</button>
          <button type="button" data-grp-none="${esc(g.group)}" class="${btnGhost} !py-0.5 !px-2 text-[11px]">снять</button></span>`}
      </div>
      <div class="grid md:grid-cols-2 gap-1.5">${g.items.map((it) => `<label class="flex items-start gap-2 rounded-lg border border-slate-700/40 bg-slate-800/30 px-2.5 py-2 cursor-pointer" data-row="${esc(it.key)}">
          <input type="checkbox" data-pk="${esc(it.key)}" class="rounded accent-indigo-500 mt-0.5 shrink-0">
          <span class="min-w-0"><span class="block text-xs font-medium">${esc(it.label)}</span>
            ${it.hint ? `<span class="block text-[11px] text-slate-400">${esc(it.hint)}</span>` : ''}
            <span data-why="${esc(it.key)}" class="block text-[10px] text-amber-300/90"></span></span></label>`).join('')}</div>
    </section>`;
  $('#admBody').innerHTML = `<div class="space-y-3">
      <div class="grid md:grid-cols-2 gap-3">
        <label class="${labelCls}">Название роли<input id="admRoleName" maxlength="60" value="${esc(role ? role.name : (draft ? draft.name : ''))}" class="${fieldCls}" ${readOnly ? 'disabled' : ''} placeholder="например: Диспетчер без паролей"></label>
        <label class="${labelCls}">Описание (необязательно)<input id="admRoleDesc" maxlength="300" value="${esc(role ? role.description : (draft ? draft.description : ''))}" class="${fieldCls}" ${readOnly ? 'disabled' : ''}></label>
      </div>
      ${locked ? '<p class="rounded-xl border border-indigo-400/30 bg-indigo-500/10 px-3 py-2 text-xs text-indigo-200">У администратора есть все права, и изменить их нельзя — иначе можно потерять доступ к системе.</p>' : ''}
      ${tooStrong ? '<p class="rounded-xl border border-amber-400/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-200">Права этой роли шире ваших, поэтому изменить её нельзя — можно только посмотреть.</p>' : ''}
      <div class="flex flex-wrap items-center gap-2">
        <span id="admCount" class="text-xs text-slate-300"></span>
        ${readOnly ? '' : `<select id="admPreset" class="rounded-lg px-2 py-1 text-xs" style="width:auto; max-width:15rem"><option value="">Заполнить по образцу…</option>
            <option value="__none__">Снять все права</option>${ADM.roles.map((r) => `<option value="${esc(r.key)}">${esc(r.name)}</option>`).join('')}</select>`}
      </div>
      <p class="text-xs text-slate-400">Откроются страницы: <b id="admPages" class="text-slate-200"></b></p>
      <div id="admPermList" class="space-y-3 max-h-[52vh] overflow-auto pr-1">${ADM.catalog.map(groupHtml).join('')}</div>
      <div id="admRoleError" class="hidden rounded-xl border border-rose-500/30 bg-rose-500/10 px-3 py-2 text-xs text-rose-300"></div>
      <div class="flex flex-wrap items-center gap-2">
        <button type="button" id="admRoleBack" class="${btnGhost}">← К списку ролей</button>
        ${readOnly ? '' : `<button type="button" id="admRoleSave" class="${btnPrimary}">${isNew ? 'Создать роль' : 'Сохранить'}</button>`}
        ${role && role.is_system && !locked && !tooStrong ? `<button type="button" id="admRoleReset" class="${btnGhost} ml-auto" title="Вернуть права, с которыми роль поставляется">Сбросить к исходным</button>` : ''}
      </div>
    </div>`;

  const sync = () => {
    const eff = effective();
    document.querySelectorAll('[data-pk]').forEach((box) => {
      const k = box.dataset.pk;
      const by = impliedBy(k);
      const mine = admHas(k);
      box.checked = chosen.has(k) || by.length > 0;
      box.disabled = readOnly || by.length > 0 || !mine;      // нельзя менять: роль только для просмотра, право включено другим правом или его нет у вас самих
      const why = document.querySelector(`[data-why="${CSS.escape(k)}"]`);
      const names = by.map((c) => admItem(c).label);
      if (why) why.textContent = by.length ? `включено автоматически: нужно для «${names.slice(0, 2).join('», «')}»${names.length > 2 ? ` и ещё ${names.length - 2}` : ''}` : (!mine && !readOnly ? 'у вас самих этого права нет — выдать его нельзя' : '');
      const row = document.querySelector(`[data-row="${CSS.escape(k)}"]`);
      if (row) row.style.opacity = box.disabled && !box.checked ? '.55' : '';
    });
    $('#admCount').textContent = `Выбрано прав: ${eff.size} из ${keys.length}`;
    $('#admPages').textContent = pagesText(eff);
  };
  document.querySelectorAll('[data-pk]').forEach((box) => {
    box.onchange = () => { if (box.checked) chosen.add(box.dataset.pk); else chosen.delete(box.dataset.pk); sync(); };
  });
  const groupKeys = (name) => (ADM.catalog.find((g) => g.group === name)?.items || []).map((it) => it.key);
  document.querySelectorAll('[data-grp-all]').forEach((b) => { b.onclick = () => { groupKeys(b.dataset.grpAll).filter(admHas).forEach((k) => chosen.add(k)); sync(); }; });
  document.querySelectorAll('[data-grp-none]').forEach((b) => { b.onclick = () => { groupKeys(b.dataset.grpNone).forEach((k) => chosen.delete(k)); sync(); }; });
  const preset = $('#admPreset');
  if (preset) preset.onchange = () => {
    if (!preset.value) return;
    chosen.clear();
    if (preset.value !== '__none__') {
      const src = ADM.roles.find((r) => r.key === preset.value);
      (src.locked ? keys : src.permissions).filter((k) => k !== '*' && admHas(k)).forEach((k) => chosen.add(k));
    }
    preset.value = '';
    sync();
  };
  $('#admRoleBack').onclick = () => admRender();
  const save = $('#admRoleSave');
  if (save) save.onclick = async () => {
    const body = { name: $('#admRoleName').value.trim(), description: $('#admRoleDesc').value.trim(), permissions: [...chosen] };
    const err = $('#admRoleError');
    err.classList.add('hidden');
    if (body.name.length < 2) { err.textContent = 'Назовите роль — хотя бы два знака.'; err.classList.remove('hidden'); return; }
    save.disabled = true;
    try {
      if (isNew) await Api.post('/api/admin/roles', body); else await Api.put(`/api/admin/roles/${encodeURIComponent(role.key)}`, body);
      await openAdminPanel('roles');
      await admRefreshMe();
    } catch (e) { err.textContent = e.message; err.classList.remove('hidden'); save.disabled = false; }
  };
  const reset = $('#admRoleReset');
  if (reset) reset.onclick = async () => {
    if (!confirm(`Вернуть роли «${role.name}» исходные права?`)) return;
    try { await Api.post(`/api/admin/roles/${encodeURIComponent(role.key)}/reset`, {}); await openAdminPanel('roles'); await admRefreshMe(); }
    catch (e) { alert(e.message); }
  };
  sync();
}

$('#adminBtn').onclick = () => { closeDropdowns(); openAdminPanel('users'); };
