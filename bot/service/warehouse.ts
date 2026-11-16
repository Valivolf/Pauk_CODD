import { ApiError, apiClient } from '../apiClient.ts';
import { getBackToWarehouseKeyboard, pagedKeyboard, simpleKeyboard, type Entry } from '../keyboards/equipmentMenu.ts';
import { getMainMenuKeyboard } from '../keyboards/mechanicMenu.ts';
import type { VkRawMessage } from '../vk.ts';
import * as base from './mechanic.ts';
import type { BotSession } from './navigation.ts';
import { registerView, showView } from './views.ts';

export const WAREHOUSE_ROLE = 'warehouse';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WhItem = Record<string, any>;

export function isWarehouse(user: base.BotUser): boolean {
  return user.role_type === WAREHOUSE_ROLE;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function wh(session: BotSession): Record<string, any> {
  if (!session.wh || typeof session.wh !== 'object') session.wh = {};
  return session.wh;
}

async function guard(peerId: number, user: base.BotUser): Promise<boolean> {
  if (isWarehouse(user)) return true;
  await base.send(peerId, '⛔ Этот раздел доступен только ответственному за склад.', getMainMenuKeyboard());
  return false;
}

async function apiCall<T>(peerId: number, promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError) {
      await base.send(peerId, `❌ ${err.detail}`, getBackToWarehouseKeyboard());
    } else {
      console.error('[bot] Склад: сервер недоступен:', err);
      await base.send(peerId, '⚠️ Сервер сейчас недоступен, попробуйте через минуту.', getBackToWarehouseKeyboard());
    }
    return null;
  }
}

function itemLine(it: WhItem): string {
  const baseTxt = `№${it.serial_number} ${it.category_name} · ${it.model_name}`;
  if (it.held_reason === 'removed') {
    const src = it.removed_point_id ? `, снято с ${it.removed_point_id}` : '';
    const why = it.removal_reason ? ` (причина: ${it.removal_reason})` : '';
    return `🔧 ${baseTxt}${src} — ${it.status || 'дефектное'}${why}`;
  }
  if (it.held_reason === 'kept') {
    const src = it.removed_point_id ? `, снята с ${it.removed_point_id}` : '';
    return `💳 ${baseTxt}${src} — осталась у монтёра (${it.status || '—'}), сдача не обязательна`;
  }
  if (it.held_reason === 'issued') {
    return `📦 ${baseTxt} (выдано, не использовано)`;
  }
  return baseTxt;
}

function clearMap(obj: Record<string, unknown>): void {
  for (const k of Object.keys(obj)) delete obj[k];
}

// ------------------------------------------------------------------ приём от монтёра ----

export async function showAccept(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const people = await apiCall(peerId, apiClient.whAwaiting(user.vk_id));
  if (!people) return;
  const st = wh(session);
  clearMap(st);
  st.people = people;
  session.step = 'menu';
  if (!people.length) {
    await base.send(peerId, 'Принимать нечего: ни на ком не числится оборудование.', getBackToWarehouseKeyboard());
    return;
  }
  await showView('wh_people', peerId, user, session);
}

registerView('wh_people', async (peerId, _user, session, page) => {
  const people = (wh(session).people || []) as WhItem[];
  const entries = people.map((p) => {
    const parts: string[] = [];
    if (p.removed) parts.push(`снято ${p.removed}`);
    if (p.issued) parts.push(`выдано ${p.issued}`);
    if (p.kept) parts.push(`SIM у монтёра ${p.kept}`);
    return [`${p.full_name} — ${parts.join(', ')}`, { action: 'wh_accp', p: p.person_id }] as [string, Record<string, unknown>];
  });
  const [keyboard] = pagedKeyboard(entries, page, [[['🏠 Меню склада', { action: 'main_menu' }]]]);
  await base.send(
    peerId,
    '📥 У кого принять оборудование? (снято с комплексов, выдано, снятые SIM — их можно не сдавать)',
    keyboard,
  );
});

export async function showPersonItems(peerId: number, user: base.BotUser, session: BotSession, personId: number): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const items = await apiCall(peerId, apiClient.whPersonItems(user.vk_id, personId));
  if (!items) return;
  const st = wh(session);
  st.person_id = personId;
  st.items = items;
  const person = ((st.people || []) as WhItem[]).find((p) => p.person_id === personId);
  const name = person?.full_name || 'монтёр';
  st.person_name = name;
  if (!items.length) {
    await base.send(peerId, `На «${name}» ничего не числится.`, getBackToWarehouseKeyboard());
    return;
  }
  await showView('wh_person_items', peerId, user, session);
}

registerView('wh_person_items', async (peerId, _user, session, page) => {
  const st = wh(session);
  const items = (st.items || []) as WhItem[];
  const lines = [`📥 ${st.person_name} — числится ${items.length}:`, ...items.map(itemLine)];
  const entries = items.map(
    (i) => [`✅ №${i.serial_number} ${i.category_name}`, { action: 'wh_acc1', i: i.id }] as [string, Record<string, unknown>],
  );
  const controls: Entry[][] = [
    [[`✅ Принять всё (${items.length})`, { action: 'wh_accall' }]],
    [['🔁 Сдан другой номер', { action: 'wh_other' }]],
    [['⬅ Назад', { action: 'wh_accept' }]],
  ];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, lines.join('\n'), keyboard);
});

export async function acceptItems(peerId: number, user: base.BotUser, session: BotSession, ids: number[] | null): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const st = wh(session);
  const personId = st.person_id as number | undefined;
  const chosen = ids ?? ((st.items || []) as WhItem[]).map((i) => i.id);
  if (!chosen.length || !personId) {
    await showAccept(peerId, user, session);
    return;
  }
  const res = await apiCall(peerId, apiClient.whAccept(user.vk_id, chosen, personId));
  if (!res) return;
  const lines: string[] = [];
  if (res.accepted?.length) {
    lines.push(`✅ Принято на склад: ${(res.accepted as WhItem[]).map((a) => `№${a.serial_number}`).join(', ')}`);
    if ((res.accepted as WhItem[]).some((a) => a.removed)) {
      lines.push(
        `Снятое числится на складе как дефектное (снял: ${st.person_name || 'монтёр'}). Состояние можно изменить в «Состояние оборудования».`,
      );
    }
  }
  if (res.skipped?.length) {
    lines.push(
      `Не принято: ${(res.skipped as WhItem[]).map((s) => `№${s.serial_number || s.id} — ${s.reason}`).join('; ')}`,
    );
  }
  await base.send(
    peerId,
    lines.join('\n') || 'Ничего не принято.',
    simpleKeyboard([[['📥 Принять ещё', { action: 'wh_accept' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]),
  );
}

// ------------------------------------------------------------------ выдача монтёру ----

export async function startIssue(peerId: number, user: base.BotUser, session: BotSession, query = ''): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const fitters = await apiCall(peerId, apiClient.whFitters(user.vk_id, query));
  if (!fitters) return;
  const st = wh(session);
  clearMap(st);
  st.fitters = fitters;
  st.query = query;
  session.step = 'menu';
  if (!fitters.length) {
    await base.send(
      peerId,
      query ? 'Никого не нашёл. Введите часть фамилии ещё раз.' : 'В персонале нет монтёров.',
      simpleKeyboard([[['🔎 Найти по фамилии', { action: 'wh_findp' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]),
    );
    return;
  }
  await showView('wh_fitters', peerId, user, session);
}

registerView('wh_fitters', async (peerId, _user, session, page) => {
  const st = wh(session);
  const entries = ((st.fitters || []) as WhItem[]).map(
    (f) => [f.full_name, { action: 'wh_iss_p', p: f.id }] as [string, Record<string, unknown>],
  );
  const controls: Entry[][] = [[['🔎 Найти по фамилии', { action: 'wh_findp' }]], [['🏠 Меню склада', { action: 'main_menu' }]]];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, `📤 Кому выдаём оборудование?${st.query ? `\nПоиск: «${st.query}»` : ''}`, keyboard);
});

export async function requestPersonSearch(peerId: number, session: BotSession): Promise<void> {
  session.step = 'wh_awaiting_person';
  await base.send(peerId, 'Введите часть фамилии монтёра.', getBackToWarehouseKeyboard());
}

export async function handlePersonSearch(message: VkRawMessage, user: base.BotUser, session: BotSession): Promise<void> {
  session.step = 'menu';
  await startIssue(Number(session.peer_id ?? message.peer_id), user, session, String(message.text || '').trim());
}

export async function issueToPerson(peerId: number, user: base.BotUser, session: BotSession, personId: number): Promise<void> {
  const st = wh(session);
  const person = ((st.fitters || []) as WhItem[]).find((f) => f.id === personId);
  st.issue = { person_id: personId, name: person?.full_name || 'монтёр', ids: {} as Record<number, string>, serials: [] as string[] };
  await showIssueScreen(peerId, user, session);
}

function issueState(session: BotSession): WhItem {
  return wh(session).issue || {};
}

function chosenCount(iss: WhItem): number {
  return Object.keys(iss.ids || {}).length + (iss.serials || []).length;
}

export async function showIssueScreen(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const iss = issueState(session);
  if (!iss.person_id) {
    await startIssue(peerId, user, session);
    return;
  }
  const cats = await apiCall(peerId, apiClient.whCategories(user.vk_id));
  if (!cats) return;
  wh(session).cats = cats;
  await showView('wh_issue_cats', peerId, user, session);
}

registerView('wh_issue_cats', async (peerId, _user, session, page) => {
  session.step = 'wh_awaiting_serials';
  const st = wh(session);
  const iss = st.issue || {};
  const chosen = [
    ...Object.values((iss.ids || {}) as Record<string, string>).map((s) => `№${s}`),
    ...((iss.serials || []) as string[]).map((s) => `№${s}?`),
  ];
  const cnt = chosenCount(iss);
  const text = [
    `📤 Выдача: ${iss.name}`,
    `Выбрано: ${cnt}${chosen.length ? ` (${chosen.join(', ')})` : ''}`,
    '\n🔎 Введите номер оборудования (можно часть номера) — найду на складе. Несколько номеров — через пробел. Или выберите категорию.',
  ];
  const entries = ((st.cats || []) as WhItem[]).map(
    (c) => [`${c.name} (${c.count})`, { action: 'wh_iss_c', c: c.id }] as [string, Record<string, unknown>],
  );
  const controls: Array<Array<[string, Record<string, unknown>]>> = [];
  if (cnt) controls.push([[`✅ Выдать (${cnt})`, { action: 'wh_iss_do' }]]);
  controls.push([['🔎 Найти по номеру', { action: 'wh_iss_find' }]]);
  controls.push([['❌ Отмена', { action: 'main_menu' }]]);
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, text.join('\n'), keyboard);
});

export async function requestIssueSearch(peerId: number, session: BotSession): Promise<void> {
  session.step = 'wh_awaiting_serials';
  await base.send(
    peerId,
    '🔎 Введите номер оборудования (или его часть). Несколько номеров — через пробел или с новой строки: ' +
      'добавлю те, что точно совпали с номером на складе.',
  );
}

async function explainMissing(user: base.BotUser, token: string): Promise<string> {
  let found: WhItem[];
  try {
    found = await apiClient.whFind(user.vk_id, token);
  } catch {
    return `№${token} — не нашёл`;
  }
  if (!found.length) return `№${token} — такого номера нет в базе`;
  const parts: string[] = [];
  for (const it of found.slice(0, 3)) {
    const loc = whereText(it);
    const note = it.place === 'stock' && it.status_usable === false ? `, состояние «${it.status}» — не выдаётся` : '';
    parts.push(`№${it.serial_number} ${loc}${note}`);
  }
  return parts.join('; ');
}

export async function handleSerialsText(message: VkRawMessage, user: base.BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const iss = issueState(session);
  if (!iss.person_id) {
    await startIssue(peerId, user, session);
    return;
  }
  const tokens = String(message.text || '')
    .replace(/[,;]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  if (!tokens.length) {
    await base.send(peerId, 'Введите номер оборудования.');
    return;
  }
  const st = wh(session);
  if (tokens.length === 1) {
    const token = tokens[0];
    const res = await apiCall(peerId, apiClient.whStock(user.vk_id, null, token, 30));
    if (!res) return;
    const items = (res.items || []) as WhItem[];
    const exact = items.find((i) => String(i.serial_number).toLowerCase() === token.toLowerCase());
    if (exact) {
      iss.ids[exact.id] = exact.serial_number;
      await base.send(peerId, `✅ Добавлено №${exact.serial_number} (${exact.category_name} · ${exact.model_name}).`);
      await showView('wh_issue_cats', peerId, user, session, 0);
      return;
    }
    if (items.length) {
      st.stock = items;
      st.stock_cat_name = `Поиск «${token}»`;
      await showView('wh_issue_items', peerId, user, session);
      return;
    }
    await base.send(peerId, `Среди годного на складе нет: ${await explainMissing(user, token)}`);
    await showView('wh_issue_cats', peerId, user, session, 0);
    return;
  }

  const added: string[] = [];
  const problems: string[] = [];
  for (const token of tokens) {
    const res = await apiCall(peerId, apiClient.whStock(user.vk_id, null, token, 5));
    if (!res) return;
    const items = (res.items || []) as WhItem[];
    const exact = items.find((i) => String(i.serial_number).toLowerCase() === token.toLowerCase());
    if (exact) {
      if (!(exact.id in iss.ids)) iss.ids[exact.id] = exact.serial_number;
      added.push(`№${exact.serial_number}`);
    } else {
      problems.push(await explainMissing(user, token));
    }
  }
  const lines: string[] = [];
  if (added.length) lines.push(`✅ Добавлено: ${added.join(', ')}`);
  if (problems.length) lines.push(`Не добавлено:\n${problems.map((p) => `• ${p}`).join('\n')}`);
  await base.send(peerId, lines.join('\n'));
  await showView('wh_issue_cats', peerId, user, session, 0);
}

export async function showIssueCategory(peerId: number, user: base.BotUser, session: BotSession, categoryId: number): Promise<void> {
  const res = await apiCall(peerId, apiClient.whStock(user.vk_id, categoryId));
  if (!res) return;
  const st = wh(session);
  st.stock_cat = categoryId;
  st.stock = res.items;
  const cat = ((st.cats || []) as WhItem[]).find((c) => c.id === categoryId);
  st.stock_cat_name = cat ? cat.name : '';
  await showView('wh_issue_items', peerId, user, session);
}

registerView('wh_issue_items', async (peerId, _user, session, page) => {
  session.step = 'wh_awaiting_serials';
  const st = wh(session);
  const iss = st.issue || {};
  const entries = ((st.stock || []) as WhItem[]).map((it) => {
    const mark = it.id in (iss.ids || {}) ? '☑' : '☐';
    return [`${mark} №${it.serial_number} · ${it.model_name}`, { action: 'wh_iss_t', i: it.id }] as [string, Record<string, unknown>];
  });
  const cnt = chosenCount(iss);
  const controls: Array<Array<[string, Record<string, unknown>]>> = [];
  if (cnt) controls.push([[`✅ Выдать (${cnt})`, { action: 'wh_iss_do' }]]);
  controls.push([['🔎 Найти по номеру', { action: 'wh_iss_find' }]]);
  controls.push([['⬅ К категориям', { action: 'wh_iss_back' }]]);
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, `${st.stock_cat_name} — годное на складе. Отметьте, что выдаём (${cnt} выбрано):`, keyboard);
});

export async function toggleIssueItem(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = wh(session);
  const iss = st.issue;
  const item = ((st.stock || []) as WhItem[]).find((i) => i.id === itemId);
  if (!iss || !item) {
    await startIssue(peerId, user, session);
    return;
  }
  if (itemId in iss.ids) {
    delete iss.ids[itemId];
  } else {
    iss.ids[itemId] = item.serial_number;
  }
  await showView('wh_issue_items', peerId, user, session, Number(session.view_page || 0));
}

export async function doIssue(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const iss = issueState(session);
  if (!iss.person_id || !chosenCount(iss)) {
    await base.send(peerId, 'Ничего не выбрано.', getBackToWarehouseKeyboard());
    return;
  }
  const ids = Object.keys(iss.ids || {}).map((k) => Number(k));
  const res = await apiCall(peerId, apiClient.whIssue(user.vk_id, iss.person_id, ids, iss.serials || []));
  if (!res) return;
  const lines: string[] = [];
  if (res.issued?.length) {
    lines.push(`✅ Выдано ${iss.name}: ${(res.issued as string[]).map((s) => `№${s}`).join(', ')}`);
  }
  if (res.skipped?.length) {
    lines.push(
      `Не выдано: ${(res.skipped as WhItem[]).map((s) => `№${s.serial_number || s.id} — ${s.reason}`).join('; ')}`,
    );
  }
  if (res.not_found?.length) {
    lines.push(`Не найдено на складе: ${(res.not_found as string[]).join(', ')}`);
  }
  clearMap(wh(session));
  session.step = 'menu';
  await base.send(
    peerId,
    lines.join('\n') || 'Ничего не выдано.',
    simpleKeyboard([[['📤 Выдать ещё', { action: 'wh_issue' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]),
  );
}

// ------------------------------------------------------------------ состояние оборудования ----

export async function requestStatusSearch(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  clearMap(wh(session));
  session.step = 'wh_awaiting_status_serial';
  await base.send(peerId, '🏷 Введите серийный номер оборудования (или его часть).', getBackToWarehouseKeyboard());
}

export async function handleStatusSearch(message: VkRawMessage, user: base.BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const query = String(message.text || '').trim();
  if (!query) {
    await base.send(peerId, 'Введите номер.');
    return;
  }
  const found = await apiCall(peerId, apiClient.whFind(user.vk_id, query));
  if (!found) return;
  session.step = 'menu';
  if (!found.length) {
    session.step = 'wh_awaiting_status_serial';
    await base.send(peerId, `«${query}» не найдено. Введите другой номер.`, getBackToWarehouseKeyboard());
    return;
  }
  const st = wh(session);
  st.found = found;
  if (found.length === 1) {
    await showItem(peerId, user, session, found[0].id);
    return;
  }
  await showView('wh_found', peerId, user, session);
}

registerView('wh_found', async (peerId, _user, session, page) => {
  const entries = ((wh(session).found || []) as WhItem[]).map(
    (i) => [`№${i.serial_number} · ${i.model_name} · ${i.status || '—'}`, { action: 'wh_st_i', i: i.id }] as [string, Record<string, unknown>],
  );
  const [keyboard] = pagedKeyboard(entries, page, [[['🔎 Искать другой', { action: 'wh_status' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]);
  await base.send(peerId, 'Нашёл несколько. Какое?', keyboard);
});

function whereText(it: WhItem): string {
  if (it.place === 'unknown') {
    return `местонахождение неизвестно${it.removed_point_id ? ` (числилось на «${it.removed_point_id}»)` : ''}`;
  }
  if (it.place === 'person') {
    const reasons: Record<string, string> = {
      removed: ' (снято, ждёт приёмки)',
      kept: ' (снятая SIM осталась у монтёра)',
    };
    return `у ${it.person_name}${reasons[it.held_reason] || ' (выдано)'}`;
  }
  if (it.place === 'point') return `на комплексе «${it.point_id}»`;
  return 'на складе';
}

export async function showItem(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = wh(session);
  const item = ((st.found || []) as WhItem[]).find((i) => i.id === itemId);
  if (!item) {
    await requestStatusSearch(peerId, user, session);
    return;
  }
  st.item = item;
  const lines = [
    `№${item.serial_number} — ${item.category_name} · ${item.model_name}`,
    `Где: ${whereText(item)}`,
    `Состояние: ${item.status || '—'}`,
  ];
  if (item.removed_by || item.removed_point_id) {
    lines.push(
      `Снято: ${item.removed_by || '—'}${item.removed_point_id ? `, с «${item.removed_point_id}»` : ''}${item.removed_date ? `, ${item.removed_date}` : ''}`,
    );
  }
  if (item.removal_reason) lines.push(`Причина снятия: ${item.removal_reason}`);
  if (item.accepted_by) lines.push(`Принял на склад: ${item.accepted_by}`);
  st.card = lines;

  if (item.place === 'unknown') {
    lines.push('\nОно числилось в другом месте, но там оказалось другое оборудование. Если нашлось — верните его на склад.');
    await base.send(
      peerId,
      lines.join('\n'),
      simpleKeyboard([
        [['📥 Нашлось — принять на склад', { action: 'wh_found' }]],
        [['🔎 Искать другой', { action: 'wh_status' }]],
        [['🏠 Меню склада', { action: 'main_menu' }]],
      ]),
    );
    return;
  }
  if (item.place !== 'stock') {
    lines.push(
      '\nСостояние меняется у оборудования на складе.' +
        (item.place === 'person'
          ? ' Сначала примите его от монтёра («Принять от монтёра»).'
          : ' Сначала его нужно снять с комплекса.'),
    );
    await base.send(
      peerId,
      lines.join('\n'),
      simpleKeyboard([[['🔎 Искать другой', { action: 'wh_status' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]),
    );
    return;
  }
  const statuses = await apiCall(peerId, apiClient.whStatuses(user.vk_id));
  if (!statuses) return;
  st.statuses = statuses;
  await showView('wh_item_status', peerId, user, session);
}

registerView('wh_item_status', async (peerId, _user, session, page) => {
  const st = wh(session);
  const item = st.item || {};
  const lines = [...(st.card || []), '', 'Какое состояние поставить?'];
  const entries = ((st.statuses || []) as WhItem[])
    .filter((s) => s.id !== item.status_id)
    .map((s) => [`${s.usable ? '✅ ' : '⛔ '}${s.name}`, { action: 'wh_st_s', s: s.id }] as [string, Record<string, unknown>]);
  const [keyboard] = pagedKeyboard(entries, page, [[['🔎 Искать другой', { action: 'wh_status' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]);
  await base.send(peerId, `${lines.join('\n')}\n(✅ годно к выдаче, ⛔ не выдаётся)`, keyboard);
});

export async function setItemStatus(peerId: number, user: base.BotUser, session: BotSession, statusId: number): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const st = wh(session);
  const item = st.item;
  if (!item) {
    await requestStatusSearch(peerId, user, session);
    return;
  }
  const res = await apiCall(peerId, apiClient.whSetStatus(user.vk_id, item.id, statusId));
  if (!res) return;
  clearMap(st);
  await base.send(
    peerId,
    `✅ №${res.serial_number}: состояние «${res.status}».`,
    simpleKeyboard([[['🏷 Ещё одно', { action: 'wh_status' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]),
  );
}

// ------------------------------------------------------------------ остатки ----

export async function showStock(peerId: number, user: base.BotUser, _session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const data = await apiCall(peerId, apiClient.whSummary(user.vk_id));
  if (!data) return;
  const lines = ['📊 Остатки на складе:'];
  for (const row of (data.stock || []) as WhItem[]) {
    lines.push(`• ${row.category}: годных ${row.usable}${row.unusable ? `, негодных ${row.unusable}` : ''}`);
  }
  if (!data.stock?.length) lines.push('склад пуст');
  if (data.unknown) {
    lines.push(`\n❓ Неизвестное местонахождение: ${data.unknown} ед. (найдите по номеру в «Состояние оборудования»)`);
  }
  const waiting = ((data.awaiting || []) as WhItem[]).filter((p) => p.removed || p.issued);
  if (waiting.length) {
    lines.push('\nЧислится на монтёрах:');
    for (const p of waiting) {
      const parts: string[] = [];
      if (p.removed) parts.push(`снято ${p.removed}`);
      if (p.issued) parts.push(`выдано ${p.issued}`);
      lines.push(`• ${p.full_name}: ${parts.join(', ')}`);
    }
  }
  await base.send(peerId, lines.join('\n'), getBackToWarehouseKeyboard());
}

// ------------------------------------------------------------------ сдан другой номер ----

export async function startOther(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const st = wh(session);
  if (!st.items?.length) {
    await showAccept(peerId, user, session);
    return;
  }
  await showView('wh_other_pick', peerId, user, session);
}

registerView('wh_other_pick', async (peerId, _user, session, page) => {
  const st = wh(session);
  const entries = ((st.items || []) as WhItem[]).map(
    (i) => [`№${i.serial_number} ${i.category_name}`, { action: 'wh_oth_i', i: i.id }] as [string, Record<string, unknown>],
  );
  const [keyboard] = pagedKeyboard(entries, page, [[['⬅ Назад', { action: 'wh_accp', p: st.person_id || 0 }]]]);
  await base.send(
    peerId,
    `🔁 По системе на «${st.person_name}» числится это. Какой номер он на самом деле сдал не тот?`,
    keyboard,
  );
});

export async function chooseOtherItem(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = wh(session);
  const item = ((st.items || []) as WhItem[]).find((i) => i.id === itemId);
  if (!item) {
    await showAccept(peerId, user, session);
    return;
  }
  st.sub_expected = item;
  delete st.sub_actual;
  session.step = 'wh_awaiting_actual';
  await base.send(
    peerId,
    `По системе на «${st.person_name}»: №${item.serial_number} (${item.category_name} · ${item.model_name}).\n` +
      'Введите номер, который он сдал на самом деле (можно часть номера).',
    simpleKeyboard([[['⬅ Назад', { action: 'wh_accp', p: st.person_id || 0 }]]]),
  );
}

export async function handleActualSearch(message: VkRawMessage, user: base.BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const st = wh(session);
  const q = String(message.text || '').trim();
  const expected = st.sub_expected as WhItem | undefined;
  if (!q || !expected) {
    await base.send(peerId, 'Введите номер.');
    return;
  }
  const found = await apiCall(peerId, apiClient.whFind(user.vk_id, q));
  if (!found) return;
  session.step = 'menu';
  st.sub_try = q;
  st.sub_results = found.filter((i: WhItem) => i.id !== expected.id);
  await showView('wh_actual', peerId, user, session);
}

registerView('wh_actual', async (peerId, _user, session, page) => {
  const st = wh(session);
  const expected = st.sub_expected || {};
  const results = (st.sub_results || []) as WhItem[];
  const entries = results.map(
    (i) => [`№${i.serial_number} · ${i.model_name} · ${whereText(i)}`, { action: 'wh_actpick', i: i.id }] as [string, Record<string, unknown>],
  );
  const head = results.length ? `Нашёл по «${st.sub_try}». Какой номер сдан?` : `Номера «${st.sub_try}» в базе нет.`;
  const controls: Entry[][] = [
    [[`➕ Записать «${st.sub_try}» как новое`, { action: 'wh_actnew' }]],
    [
      ['🔍 Другой номер', { action: 'wh_oth_i', i: expected.id || 0 }],
      ['⬅ Назад', { action: 'wh_accp', p: st.person_id || 0 }],
    ],
  ];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, head, keyboard);
});

async function confirmSubstitute(peerId: number, session: BotSession): Promise<void> {
  const st = wh(session);
  const expected = st.sub_expected;
  const actual = st.sub_actual;
  const who = actual.item
    ? `№${actual.item.serial_number} (${actual.item.category_name} · ${actual.item.model_name})`
    : `№${actual.serial} (новый номер — будет записан в базу)`;
  await base.send(
    peerId,
    `Принять на склад ${who} вместо №${expected.serial_number}?\n` +
      `№${expected.serial_number} получит пометку «неизвестное местонахождение».`,
    simpleKeyboard([
      [
        ['✅ Подтвердить', { action: 'wh_subdo' }],
        ['❌ Отмена', { action: 'wh_accp', p: st.person_id || 0 }],
      ],
    ]),
  );
}

export async function pickActual(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = wh(session);
  const item = ((st.sub_results || []) as WhItem[]).find((i) => i.id === itemId);
  if (!item || !st.sub_expected) {
    await showAccept(peerId, user, session);
    return;
  }
  st.sub_actual = { item };
  await confirmSubstitute(peerId, session);
}

export async function newActual(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const st = wh(session);
  if (!st.sub_try || !st.sub_expected) {
    await showAccept(peerId, user, session);
    return;
  }
  st.sub_actual = { serial: st.sub_try };
  await confirmSubstitute(peerId, session);
}

export async function doSubstitute(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const st = wh(session);
  const expected = st.sub_expected;
  const actual = st.sub_actual;
  if (!expected || !actual) {
    await showAccept(peerId, user, session);
    return;
  }
  const payload = actual.item
    ? { actual_equipment_id: actual.item.id }
    : { actual_serial: actual.serial, create_missing: true };
  const res = await apiCall(peerId, apiClient.whAcceptSubstitute(user.vk_id, expected.id, st.person_id, payload));
  if (!res) return;
  const personId = st.person_id || 0;
  delete st.sub_expected;
  delete st.sub_actual;
  await base.send(
    peerId,
    `✅ Принято на склад №${res.accepted}${res.removed ? ' как дефектное (снято монтёром).' : '.'}` +
      `\n❓ №${res.unknown} помечен как «неизвестное местонахождение».`,
    simpleKeyboard([
      [['⬅ К списку монтёра', { action: 'wh_accp', p: personId }]],
      [['🏠 Меню склада', { action: 'main_menu' }]],
    ]),
  );
}

export async function markFound(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!(await guard(peerId, user))) return;
  const st = wh(session);
  const item = st.item;
  if (!item) {
    await requestStatusSearch(peerId, user, session);
    return;
  }
  const res = await apiCall(peerId, apiClient.whFound(user.vk_id, item.id));
  if (!res) return;
  clearMap(st);
  await base.send(
    peerId,
    `✅ №${res.serial_number} найдено и принято на склад.`,
    simpleKeyboard([[['🏷 Ещё одно', { action: 'wh_status' }]], [['🏠 Меню склада', { action: 'main_menu' }]]]),
  );
}
