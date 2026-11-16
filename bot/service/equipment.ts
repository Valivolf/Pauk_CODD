import { ApiError, apiClient } from '../apiClient.ts';
import { cut, pagedKeyboard, simpleKeyboard, type Entry } from '../keyboards/equipmentMenu.ts';
import { getBackToMenuKeyboard } from '../keyboards/mechanicMenu.ts';
import type { VkRawMessage } from '../vk.ts';
import * as base from './mechanic.ts';
import type { BotSession } from './navigation.ts';
import { registerView, showView } from './views.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type EqItem = Record<string, any>;

function isSim(item: EqItem | null | undefined): boolean {
  return Boolean(item) && item!.category_kind === 'sim';
}

function label(item: EqItem): string {
  if (isSim(item)) return `SIM ${item.serial_number}`;
  return `№${item.serial_number} · ${item.model_name}`;
}

function reportText(item: EqItem): string {
  if (isSim(item)) return `SIM-карта ${item.serial_number}`;
  return `${item.category_name} №${item.serial_number} (${item.model_name})`;
}

function withReason(text: string, reason: string | null | undefined): string {
  return reason ? `${text} — причина: ${reason}` : text;
}

function appendReport(session: BotSession, key: string, text: string): void {
  session[key] = [session[key], text].filter(Boolean).join('; ');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function eqState(session: BotSession): Record<string, any> {
  if (!session.eq || typeof session.eq !== 'object') session.eq = {};
  return session.eq;
}

async function apiCall<T>(peerId: number, session: BotSession, promise: Promise<T>): Promise<T | null> {
  try {
    return await promise;
  } catch (err) {
    if (err instanceof ApiError) {
      await base.send(peerId, `❌ ${err.detail}`, base.menuKeyboard(session));
    } else {
      console.error('[bot] Оборудование: сервер недоступен:', err);
      await base.send(peerId, '⚠️ Сервер сейчас недоступен, попробуйте через минуту.', base.menuKeyboard(session));
    }
    return null;
  }
}

// ------------------------------------------------------------------ моё оборудование ----

export async function showMyEquipment(peerId: number, user: base.BotUser): Promise<void> {
  let held: EqItem[];
  try {
    held = await apiClient.getHeldEquipment(user.vk_id);
  } catch (err) {
    if (err instanceof ApiError) {
      await base.send(peerId, `❌ ${err.detail}`, getBackToMenuKeyboard());
    } else {
      await base.send(peerId, '⚠️ Сервер сейчас недоступен, попробуйте через минуту.', getBackToMenuKeyboard());
    }
    return;
  }
  const issued = held.filter((i) => i.held_reason === 'issued');
  const removed = held.filter((i) => i.held_reason === 'removed');
  const kept = held.filter((i) => i.held_reason === 'kept');
  if (!held.length) {
    await base.send(peerId, '🎒 На вас сейчас не числится оборудование.', getBackToMenuKeyboard());
    return;
  }
  const lines = ['🎒 На вас числится:'];
  if (issued.length) {
    lines.push('\n📦 Выдано (для установки):');
    for (const i of issued) {
      lines.push(`• ${i.category_name} №${i.serial_number} (${i.model_name})`);
    }
  }
  if (removed.length) {
    lines.push('\n🔧 Снято с комплексов — сдайте на склад:');
    for (const i of removed) {
      lines.push(
        `• ${i.category_name} №${i.serial_number} (${i.model_name})${i.removed_point_id ? `, с «${i.removed_point_id}»` : ''}`,
      );
    }
  }
  if (kept.length) {
    lines.push('\n💳 Снятые SIM — остались у вас (сдавать на склад не обязательно, можно ставить снова):');
    for (const i of kept) {
      lines.push(
        `• SIM ${i.serial_number}${i.removed_point_id ? `, с «${i.removed_point_id}»` : ''}${i.status ? ` — ${String(i.status).toLowerCase()}` : ''}`,
      );
    }
  }
  await base.send(peerId, lines.join('\n'), getBackToMenuKeyboard());
}

// ------------------------------------------------------------------ каталог комплекса ----

export async function showCatalog(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const pointId = session.point_id as string | undefined;
  if (!pointId) {
    await base.send(peerId, 'Сначала откройте задание.', simpleKeyboard([[['🏠 Меню', { action: 'main_menu' }]]]));
    return;
  }
  const data = await apiCall(peerId, session, apiClient.getPointEquipment(pointId));
  if (!data) return;
  const st = eqState(session);
  for (const k of Object.keys(st)) delete st[k];
  const groupsMap: Record<number, EqItem> = {};
  for (const g of data.groups || []) {
    groupsMap[g.category_id] = g;
  }
  st.groups = groupsMap;
  st.categories = data.categories || [];
  session.step = 'menu';
  await showView('eq_catalog', peerId, user, session);
}

registerView('eq_catalog', async (peerId, _user, session, page) => {
  const st = eqState(session);
  const groups = Object.values((st.groups || {}) as Record<number, EqItem>);
  let lines: string[];
  if (groups.length) {
    lines = [`🧩 Оборудование на комплексе «${session.point_id}»:`];
    for (const g of groups) {
      const itemsText = (g.items as EqItem[])
        .map((i) => (isSim(i) ? i.serial_number : `№${i.serial_number} (${i.model_name})`))
        .join(', ');
      lines.push(`• ${g.category_name}: ${itemsText}`);
    }
    lines.push('\nВыберите категорию, в которой нужно что-то заменить или снять:');
  } else {
    lines = [
      `На комплексе «${session.point_id}» пока не записано оборудование.`,
      'Если вы что-то ставите — нажмите «Установить из выданного».',
    ];
  }
  const entries = groups.map((g) => [`${g.category_name} (${g.items.length})`, { action: 'eq_cat', c: g.category_id }] as [string, Record<string, unknown>]);
  const hasSim = groups.some((g) => (g.items as EqItem[]).some((i) => isSim(i)));
  const addRow: Entry[] = [['➕ Установить из выданного', { action: 'eq_new' }]];
  if (!hasSim) addRow.push(['💳 Указать SIM', { action: 'repair_sim_fix' }]);
  const controls: Entry[][] = [addRow, [['⬅ Назад', { action: 'repair_equipment' }]]];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, lines.join('\n'), keyboard);
});

export async function chooseCategory(peerId: number, user: base.BotUser, session: BotSession, categoryId: number): Promise<void> {
  const st = eqState(session);
  const group = st.groups?.[categoryId];
  if (!group) {
    await showCatalog(peerId, user, session);
    return;
  }
  st.category = group;
  if (group.items.length === 1) {
    await chooseItem(peerId, user, session, group.items[0].id);
    return;
  }
  await showView('eq_items', peerId, user, session);
}

registerView('eq_items', async (peerId, _user, session, page) => {
  const group = eqState(session).category || {};
  const entries = ((group.items || []) as EqItem[]).map(
    (i) => [label(i), { action: 'eq_item', i: i.id }] as [string, Record<string, unknown>],
  );
  const [keyboard] = pagedKeyboard(entries, page, [[['⬅ Назад', { action: 'eq_catalog' }]]]);
  await base.send(peerId, `${group.category_name || ''}: что именно?`, keyboard);
});

export async function chooseItem(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = eqState(session);
  let item: EqItem | undefined;
  for (const g of Object.values((st.groups || {}) as Record<number, EqItem>)) {
    const found = (g.items as EqItem[]).find((i) => i.id === itemId);
    if (found) {
      item = found;
      break;
    }
  }
  if (!item) {
    await showCatalog(peerId, user, session);
    return;
  }
  if (!st.old || st.old.id !== itemId) {
    delete st.actual;
  }
  st.old = item;
  delete st.new;
  delete st.reason;
  st.mode = null;
  await showItemCard(peerId, session);
}

function actualText(st: EqItem): string {
  const actual = st.actual;
  if (!actual) return '';
  const old = st.old;
  const who = actual.item
    ? `№${actual.item.serial_number} (${actual.item.category_name} ${actual.item.model_name})`
    : `№${actual.serial} (новый номер — запишу в базу)`;
  return (
    `\n🔁 Реально стояло: ${who}.\n` +
    `По системе здесь должен быть №${old.serial_number} — он будет помечен как «неизвестное местонахождение».`
  );
}

async function showItemCard(peerId: number, session: BotSession): Promise<void> {
  const st = eqState(session);
  const item = st.old as EqItem;
  const since = item.installed_date ? `\nУстановлено: ${item.installed_date || '—'}` : '';
  if (isSim(item)) {
    await base.send(
      peerId,
      `💳 SIM-карта ${item.serial_number}${since}\nЧто делаем?`,
      simpleKeyboard([
        [['🔄 Заменить SIM', { action: 'repair_sim_change' }]],
        [['✏️ Исправить номер (ошибка в записи)', { action: 'repair_sim_fix' }]],
        [['➖ Снять без замены', { action: 'eq_rm' }]],
        [['⬅ Назад', { action: 'eq_catalog' }]],
      ]),
    );
    return;
  }
  await base.send(
    peerId,
    `${item.category_name} №${item.serial_number} (${item.model_name})${since}${actualText(st)}\nЧто делаем?`,
    simpleKeyboard([
      [['🔄 Заменить', { action: 'eq_repl' }]],
      [['➖ Снять без замены', { action: 'eq_rm' }]],
      [['🔁 Стоит другой номер', { action: 'eq_other' }]],
      [['⬅ Назад', { action: 'eq_catalog' }]],
    ]),
  );
}

// ------------------------------------------------------------------ «стоит другой номер» ----

export async function requestActual(peerId: number, session: BotSession): Promise<void> {
  const st = eqState(session);
  if (!st.old) {
    await base.send(peerId, 'Сначала выберите оборудование на комплексе.', base.menuKeyboard(session));
    return;
  }
  session.step = 'awaiting_actual_serial';
  await base.send(
    peerId,
    `Введите номер оборудования, которое реально стояло вместо №${st.old.serial_number} (можно часть номера).`,
    simpleKeyboard([[['⬅ Назад', { action: 'eq_item', i: st.old.id }]]]),
  );
}

export async function handleActualText(message: VkRawMessage, user: base.BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const st = eqState(session);
  const text = String(message.text || '').trim();
  const old = st.old as EqItem | undefined;
  if (!text || !old) {
    await base.send(peerId, 'Введите номер.');
    return;
  }
  const found = await apiCall(peerId, session, apiClient.findEquipment(user.vk_id, text));
  if (!found) return;
  session.step = 'menu';
  st.actual_try = text;
  st.actual_results = found.filter((i: EqItem) => i.id !== old.id);
  await showView('eq_actual', peerId, user, session);
}

registerView('eq_actual', async (peerId, _user, session, page) => {
  const st = eqState(session);
  const old = st.old || {};
  const results = (st.actual_results || []) as EqItem[];
  const where: Record<string, string> = {
    stock: 'на складе',
    person: 'у монтёра',
    point: 'на комплексе',
    unknown: 'местонахождение неизвестно',
  };
  const entries = results.map(
    (i) => [`№${i.serial_number} · ${i.model_name} · ${where[i.place] || ''}`, { action: 'eq_actpick', i: i.id }] as [string, Record<string, unknown>],
  );
  const head = results.length ? `Нашёл по «${st.actual_try}». Какое реально стояло?` : `Номера «${st.actual_try}» в базе нет.`;
  const controls: Entry[][] = [
    [[cut(`➕ Записать «${st.actual_try}» как новое`), { action: 'eq_actnew' }]],
    [
      ['🔍 Другой номер', { action: 'eq_other' }],
      ['⬅ Назад', { action: 'eq_item', i: old.id || 0 }],
    ],
  ];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, head, keyboard);
});

export async function pickActual(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = eqState(session);
  const item = ((st.actual_results || []) as EqItem[]).find((i) => i.id === itemId);
  if (!item || !st.old) {
    await showCatalog(peerId, user, session);
    return;
  }
  st.actual = { item };
  await showItemCard(peerId, session);
}

export async function newActual(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const st = eqState(session);
  const serial = st.actual_try as string | undefined;
  if (!serial || !st.old) {
    await showCatalog(peerId, user, session);
    return;
  }
  st.actual = { serial };
  await showItemCard(peerId, session);
}

function actualPayload(st: EqItem): Record<string, unknown> {
  const actual = st.actual;
  if (!actual) return {};
  if (actual.item) return { actual_equipment_id: actual.item.id };
  return { actual_serial: actual.serial, create_missing: true };
}

function removedForReport(st: EqItem): EqItem {
  const old = st.old as EqItem;
  const actual = st.actual;
  if (actual?.item) return actual.item;
  if (actual) return { ...old, serial_number: actual.serial };
  return old;
}

// ------------------------------------------------------------------ замена / установка ----

const MIN_SUFFIX = 6;

function suffixKey(text: string): string {
  return String(text || '')
    .replace(/[^a-zа-я0-9]/gi, '')
    .toLowerCase();
}

async function loadHeld(peerId: number, user: base.BotUser, session: BotSession, categoryId?: number): Promise<EqItem[] | null> {
  const held = await apiCall(peerId, session, apiClient.getHeldEquipment(user.vk_id, categoryId));
  if (!held) return null;
  return held.filter((i: EqItem) => i.held_reason === 'issued');
}

export async function startReplace(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const st = eqState(session);
  const old = st.old as EqItem | undefined;
  if (!old) {
    await showCatalog(peerId, user, session);
    return;
  }
  if (isSim(old)) {
    await base.requestSimChange(peerId, session);
    return;
  }
  const held = await loadHeld(peerId, user, session, old.category_id);
  if (!held) return;
  st.mode = 'replace';
  st.held = held;
  delete st.via_suffix;
  delete st.pending_suffix;
  if (!held.length) {
    await base.send(
      peerId,
      `У вас нет выданного оборудования категории «${old.category_name}». Не страшно: введите последние ${MIN_SUFFIX} цифр серийного номера того, что поставили, — ` +
        'найду его в учёте (даже если вам его не выдавали), а если его там ещё нет, запишу установку по номеру, и оно привяжется к комплексу, когда его добавят в систему.\n' +
        'Если заменили что-то без номера, запишите это текстом — «Другое оборудование».',
      simpleKeyboard([
        [['🔍 Ввести номер', { action: 'eq_serial' }]],
        [['📝 Другое оборудование', { action: 'repair_equipment_other' }]],
        [['⬅ Назад', { action: 'eq_catalog' }]],
      ]),
    );
    return;
  }
  await showView('eq_held', peerId, user, session);
}

registerView('eq_held', async (peerId, _user, session, page) => {
  const st = eqState(session);
  const old = st.old;
  const held = (st.held || []) as EqItem[];
  const head = old ? `На вас выдано (${old.category_name}):` : 'Выдано вам:';
  const entries = held.map((i) => [label(i), { action: 'eq_pick', i: i.id }] as [string, Record<string, unknown>]);
  const controls: Entry[][] = [[['🔍 Ввести номер', { action: 'eq_serial' }]], [['⬅ Назад', { action: 'eq_catalog' }]]];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, `${head}\nВыберите, что ставите (или введите номер):`, keyboard);
});

export async function startInstall(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const held = await loadHeld(peerId, user, session);
  if (!held) return;
  const st = eqState(session);
  st.mode = 'install';
  st.old = null;
  delete st.reason;
  delete st.via_suffix;
  delete st.pending_suffix;
  st.held_all = held;
  if (!held.length) {
    await base.send(
      peerId,
      `У вас нет выданного оборудования. Не страшно: введите последние ${MIN_SUFFIX} цифр серийного номера того, что ставите, — найду его в учёте или запишу установку по номеру ` +
        '(привяжется к комплексу, когда оборудование добавят в систему).',
      simpleKeyboard([
        [['🔍 Ввести номер', { action: 'eq_serial' }]],
        [['📝 Другое оборудование', { action: 'repair_equipment_other' }]],
        [['⬅ Назад', { action: 'eq_catalog' }]],
      ]),
    );
    return;
  }
  await showView('eq_newcat', peerId, user, session);
}

registerView('eq_newcat', async (peerId, _user, session, page) => {
  const held = (eqState(session).held_all || []) as EqItem[];
  const counts = new Map<number, EqItem[]>();
  for (const i of held) {
    const arr = counts.get(i.category_id) || [];
    arr.push(i);
    counts.set(i.category_id, arr);
  }
  const entries = Array.from(counts.entries()).map(
    ([cid, items]) => [`${items[0].category_name} (${items.length})`, { action: 'eq_newc', c: cid }] as [string, Record<string, unknown>],
  );
  const [keyboard] = pagedKeyboard(entries, page, [[['🔍 Ввести номер', { action: 'eq_serial' }]], [['⬅ Назад', { action: 'eq_catalog' }]]]);
  await base.send(peerId, 'Какое оборудование из выданного вам устанавливаете?', keyboard);
});

export async function chooseInstallCategory(peerId: number, user: base.BotUser, session: BotSession, categoryId: number): Promise<void> {
  const st = eqState(session);
  st.held = ((st.held_all || []) as EqItem[]).filter((i) => i.category_id === categoryId);
  await showView('eq_held', peer_id_safe(peerId), user, session);
}

function peer_id_safe(peerId: number): number {
  return peerId;
}

export async function pickNew(peerId: number, _user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const st = eqState(session);
  const pool = (st.held || st.held_all || []) as EqItem[];
  const next = pool.find((i) => i.id === itemId);
  if (!next) {
    await base.send(peerId, 'Этого оборудования нет среди выданного вам — откройте список заново.', base.menuKeyboard(session));
    return;
  }
  st.new = next;
  delete st.reason;
  const old = st.old as EqItem | undefined;
  if (old) {
    const gone = removedForReport(st);
    await base.askRemovalReason(
      peerId,
      session,
      { op: 'eq_replace' },
      `Заменяем ${old.category_name} №${gone.serial_number} → №${next.serial_number}.`,
    );
    return;
  }
  await showConfirm(peerId, session);
}

export async function reasonGiven(peerId: number, _user: base.BotUser, session: BotSession, reason: string): Promise<void> {
  eqState(session).reason = reason;
  delete session.reason_ctx;
  await showConfirm(peerId, session);
}

export async function changeReason(peerId: number, session: BotSession): Promise<void> {
  const st = eqState(session);
  if (st.mode !== 'replace' && st.mode !== 'remove') return;
  await base.askRemovalReason(peerId, session, { op: st.mode === 'replace' ? 'eq_replace' : 'eq_remove' });
}

async function showConfirm(peerId: number, session: BotSession): Promise<void> {
  const st = eqState(session);
  const mode = st.mode as string | undefined;
  const old = st.old as EqItem | undefined;
  const next = st.new as EqItem | undefined;
  const reason = st.reason as string | undefined;
  const why = reason ? `\nПричина снятия: ${reason}` : '';
  const rows: Array<Array<[string, Record<string, unknown>]>> = [
    [
      ['✅ Подтвердить', { action: 'eq_do' }],
      ['❌ Отмена', { action: 'eq_catalog' }],
    ],
  ];
  const pend = st.pending_suffix as string | undefined;
  if (pend && !next && (mode === 'replace' || mode === 'install')) {
    let text: string;
    if (mode === 'replace' && old) {
      const gone = removedForReport(st);
      text =
        `Заменить ${old.category_name} №${gone.serial_number} → оборудование с номером …${pend} (в учёте его пока нет)?${why}\n` +
        `Снятое (№${gone.serial_number}) будет числиться на вас как дефектное — сдайте его на склад.\n` +
        `Новое оборудование привяжется к комплексу само, когда его добавят в систему.${actualText(st)}`;
      rows.push([['✏️ Причина', { action: 'eq_reason' }]]);
    } else {
      text =
        `Записать установку на комплекс «${session.point_id}» оборудования с номером …${pend} (в учёте его пока нет)?\n` +
        'Оно привяжется к комплексу само, когда его добавят в систему.';
    }
    await base.send(peerId, text, simpleKeyboard(rows));
    return;
  }

  let text: string;
  if (mode === 'replace' && old && next) {
    const gone = removedForReport(st);
    text =
      `Заменить ${old.category_name} №${gone.serial_number} → №${next.serial_number} (${next.model_name})?${why}\n` +
      `Снятое (№${gone.serial_number}) будет числиться на вас как дефектное — сдайте его на склад.${actualText(st)}`;
    rows.push([['✏️ Причина', { action: 'eq_reason' }]]);
  } else if (mode === 'remove' && old) {
    const gone = removedForReport(st);
    text =
      `Снять ${old.category_name} №${gone.serial_number} с комплекса без замены?${why}\n` +
      `Оно будет числиться на вас как дефектное — сдайте его на склад.${actualText(st)}`;
    rows.push([['✏️ Причина', { action: 'eq_reason' }]]);
  } else if (next) {
    text = `Установить ${next.category_name} №${next.serial_number} (${next.model_name}) на комплекс «${session.point_id}»?`;
  } else {
    await base.send(peerId, 'Действие устарело — откройте оборудование комплекса заново.', base.menuKeyboard(session));
    return;
  }
  await base.send(peerId, text, simpleKeyboard(rows));
}

export async function requestSerial(peerId: number, session: BotSession): Promise<void> {
  session.step = 'awaiting_equipment_serial';
  await base.send(
    peerId,
    `Введите последние ${MIN_SUFFIX} цифр серийного номера оборудования, которое ставите (можно и весь номер). Найду его в учёте — ` +
      'даже если вам его не выдавали. А если в учёте такого номера ещё нет, запишу установку по этим цифрам: оборудование само ' +
      'встанет на этот комплекс, когда его добавят в систему.',
    simpleKeyboard([[['❌ Отмена', { action: 'eq_catalog' }]]]),
  );
}

export async function handleSerialText(message: VkRawMessage, user: base.BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const raw = String(message.text || '').trim();
  const text = raw.toLowerCase();
  const st = eqState(session);
  delete st.via_suffix;
  delete st.pending_suffix;
  const pool = (st.held || st.held_all || []) as EqItem[];
  if (!text) {
    await base.send(peerId, 'Введите номер.');
    return;
  }
  const exact = pool.filter((i) => String(i.serial_number).toLowerCase() === text);
  const found = exact.length ? exact : pool.filter((i) => String(i.serial_number).toLowerCase().includes(text));
  session.step = 'menu';
  if (found.length === 1) {
    await pickNew(peerId, user, session, found[0].id);
    return;
  }
  if (found.length) {
    st.held = found;
    await showView('eq_held', peerId, user, session);
    return;
  }

  const suffix = suffixKey(raw);
  const again = simpleKeyboard([[['🔍 Ввести другой', { action: 'eq_serial' }]], [['⬅ Назад', { action: 'eq_catalog' }]]]);
  if (suffix.length < MIN_SUFFIX) {
    await base.send(
      peerId,
      `Среди выданного вам «${raw}» не нашлось. Чтобы найти по всему учёту или поставить по номеру, введите не меньше ${MIN_SUFFIX} последних цифр серийного номера.`,
      again,
    );
    return;
  }
  const cat = st.old?.category_id;
  const items = await apiCall(peerId, session, apiClient.findEquipmentBySuffix(user.vk_id, suffix, cat));
  if (!items) return;
  const usable = items.filter((i: EqItem) => i.usable);
  if (usable.length) {
    st.held = usable;
    st.via_suffix = suffix;
    if (usable.length === 1) {
      await pickNew(peerId, user, session, usable[0].id);
    } else {
      await showView('eq_held', peerId, user, session);
    }
    return;
  }
  if (items.length) {
    await base.send(peerId, `Найдено №${items[0].serial_number}, но поставить его нельзя: ${items[0].why || 'недоступно'}.`, again);
    return;
  }
  st.pending_suffix = suffix;
  await base.send(
    peerId,
    `Оборудования с номером, заканчивающимся на «${suffix}», в учёте нет. Можно записать установку по этим цифрам: комплекс запомнит оборудование, ` +
      'а когда его добавят в систему, оно само привяжется к этому комплексу. Поставить по номеру?',
    simpleKeyboard([
      [['✅ Да, поставить по номеру', { action: 'eq_suffix_ok' }]],
      [['🔍 Ввести другой', { action: 'eq_serial' }]],
      [['⬅ Назад', { action: 'eq_catalog' }]],
    ]),
  );
}

export async function suffixOk(peerId: number, _user: base.BotUser, session: BotSession): Promise<void> {
  const st = eqState(session);
  const suffix = st.pending_suffix as string | undefined;
  if (!suffix || (st.mode !== 'replace' && st.mode !== 'install')) {
    await base.send(peerId, 'Действие устарело — откройте оборудование комплекса заново.', base.menuKeyboard(session));
    return;
  }
  st.new = null;
  const old = st.old as EqItem | undefined;
  if (old && st.mode === 'replace') {
    const gone = removedForReport(st);
    await base.askRemovalReason(
      peerId,
      session,
      { op: 'eq_replace' },
      `Заменяем ${old.category_name} №${gone.serial_number} → оборудование с номером …${suffix} (в учёте пока нет).`,
    );
    return;
  }
  await showConfirm(peerId, session);
}

export async function startRemove(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const st = eqState(session);
  const old = st.old as EqItem | undefined;
  if (!old) {
    await showCatalog(peerId, user, session);
    return;
  }
  st.mode = 'remove';
  st.new = null;
  delete st.reason;
  delete st.via_suffix;
  delete st.pending_suffix;
  const gone = removedForReport(st);
  await base.askRemovalReason(
    peerId,
    session,
    { op: 'eq_remove' },
    `Снимаем ${old.category_name} №${gone.serial_number} без замены.`,
  );
}

export async function doConfirm(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const st = eqState(session);
  const mode = st.mode as string | undefined;
  const old = st.old as EqItem | undefined;
  const next = st.new as EqItem | undefined;
  const pointId = session.point_id as string | undefined;
  const vkId = user.vk_id as number;
  if (!pointId || !mode) {
    await base.send(peerId, 'Действие устарело — откройте оборудование комплекса заново.', base.menuKeyboard(session));
    return;
  }
  const reason = (st.reason as string | undefined) ?? null;
  const suffix = (st.pending_suffix || st.via_suffix) as string | undefined;
  let text: string;

  if (suffix && (mode === 'replace' || mode === 'install') && (next || st.pending_suffix)) {
    const gone = mode === 'replace' && old ? removedForReport(st) : null;
    const catId = (old || next)?.category_id ?? null;
    const res = await apiCall(
      peerId,
      session,
      apiClient.installEquipmentBySuffix({
        vkId,
        pointId,
        suffix,
        oldId: gone ? old!.id : null,
        newId: next ? next.id : null,
        categoryId: catId,
        reason,
      }),
    );
    if (!res) return;
    if (gone) appendReport(session, 'equipment_removed', withReason(reportText(gone), reason));
    if (res.mode === 'linked' && next) {
      appendReport(session, 'equipment_installed', reportText(next));
      text = `✅ Установлено №${res.installed || next.serial_number} (${next.model_name}).`;
      if (res.held_by_other) {
        text += '\n⚠️ По учёту оно числилось на другом монтёре — в журнале склада это отмечено.';
      }
    } else {
      const cat = old?.category_name || 'Оборудование';
      appendReport(session, 'equipment_installed', `${cat} с номером …${suffix} (указано по последним цифрам; в учёте пока нет)`);
      text =
        `✅ Записано: на комплексе теперь оборудование с номером …${suffix}. В учёте его пока нет — оно привяжется к комплексу само, ` +
        'когда его добавят в систему.';
    }
    if (res.removed) {
      text += `\n№${res.removed} снято и числится на вас как дефектное — сдайте на склад.${reason ? `\nПричина снятия: ${reason}.` : ''}`;
    }
  } else if (mode === 'replace' && old && next) {
    const gone = removedForReport(st);
    const res = await apiCall(
      peerId,
      session,
      apiClient.replaceEquipment(vkId, pointId, old.id, next.id, actualPayload(st), reason),
    );
    if (!res) return;
    appendReport(session, 'equipment_removed', withReason(reportText(gone), reason));
    appendReport(session, 'equipment_installed', reportText(next));
    text =
      `✅ Установлено №${next.serial_number} (${next.model_name}).\n` +
      `№${res.removed} снято и числится на вас как дефектное — сдайте на склад.` +
      (reason ? `\nПричина снятия: ${reason}.` : '');
    if (res.unknown) {
      text += `\n⚠️ №${res.unknown} (по системе стояло здесь) помечено как «неизвестное местонахождение» — сообщите складу.`;
    }
  } else if (mode === 'install' && next) {
    const res = await apiCall(peerId, session, apiClient.installEquipment(vkId, pointId, next.id));
    if (!res) return;
    appendReport(session, 'equipment_installed', reportText(next));
    text = `✅ Установлено №${next.serial_number} (${next.model_name}).`;
  } else if (mode === 'remove' && old) {
    const gone = removedForReport(st);
    const res = await apiCall(peerId, session, apiClient.removeEquipment(vkId, pointId, old.id, actualPayload(st), reason));
    if (!res) return;
    appendReport(session, 'equipment_removed', withReason(reportText(gone), reason));
    text =
      `✅ №${res.removed} снято с комплекса и числится на вас как дефектное — сдайте на склад.` +
      (reason ? `\nПричина снятия: ${reason}.` : '');
    if (res.unknown) {
      text += `\n⚠️ №${res.unknown} (по системе стояло здесь) помечено как «неизвестное местонахождение» — сообщите складу.`;
    }
  } else {
    await base.send(peerId, 'Действие устарело — откройте оборудование комплекса заново.', base.menuKeyboard(session));
    return;
  }

  for (const k of Object.keys(st)) delete st[k];
  session.step = 'menu';
  await base.send(
    peerId,
    `${text}\nЗамена попадёт в отчёт о выезде.`,
    simpleKeyboard([[['🧩 Ещё оборудование', { action: 'eq_catalog' }]], [['⬅ Назад в меню', { action: 'repair_menu_back' }]]]),
  );
}

// ------------------------------------------------------------------ демонтаж: что именно снято ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function dem(session: BotSession): Record<string, any> {
  if (!session.dem || typeof session.dem !== 'object') session.dem = {};
  return session.dem;
}

function demSummary(mode: 'whole' | 'parts', taken: EqItem[], left: EqItem[], other: string): [string, string] {
  const labels = taken.map(reportText).join('; ');
  if (mode === 'whole') {
    let text = 'Демонтирован весь комплекс' + (labels ? `: ${labels}` : ' (оборудование в учёте не числилось)');
    if (other) text += `; ещё снято: ${other}`;
    return [labels, text];
  }
  const parts: string[] = [];
  if (labels) parts.push(labels);
  if (other) parts.push(`ещё: ${other}`);
  let text = `Демонтированы отдельные элементы: ${parts.join('; ') || '—'}`;
  text += `. Остались на комплексе: ${left.length ? left.map(reportText).join('; ') : 'ничего (по учёту)'}.`;
  return [labels, text];
}

export async function startDemontageScope(peerId: number, _user: base.BotUser, session: BotSession): Promise<void> {
  const pointId = session.point_id as string | undefined;
  if (!pointId) {
    await base.send(peerId, 'Сначала откройте задание.', simpleKeyboard([[['🏠 Меню', { action: 'main_menu' }]]]));
    return;
  }
  const data = await apiCall(peerId, session, apiClient.getPointEquipment(pointId));
  if (!data) return;
  const items: EqItem[] = [];
  for (const g of data.groups || []) {
    items.push(...(g.items || []));
  }
  const scope = (session.demontage_scope || {}) as { mode?: string; ids?: number[]; other?: string; summary?: string };
  const d = dem(session);
  for (const k of Object.keys(d)) delete d[k];
  d.items = items;
  d.selected = scope.mode === 'parts' && Array.isArray(scope.ids) ? [...scope.ids] : [];
  d.other = scope.other || '';
  session.step = 'menu';

  const lines = [`🧰 Что демонтировано на комплексе «${pointId}»?`];
  if (items.length) {
    lines.push(`По учёту на комплексе: ${items.map(reportText).join('; ')}.`);
  } else {
    lines.push('По учёту на комплексе оборудования нет — можно отметить «весь комплекс» или описать снятое текстом.');
  }
  if (scope.summary) lines.push(`\nСейчас указано: ${scope.summary}`);
  await base.send(
    peerId,
    lines.join('\n'),
    simpleKeyboard([
      [['🏗 Весь комплекс', { action: 'dem_whole' }]],
      [['🧩 Отдельные элементы', { action: 'dem_parts' }]],
      [['⬅ Назад в меню', { action: 'repair_menu_back' }]],
    ]),
  );
}

export async function demWhole(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const d = dem(session);
  const items = d.items as EqItem[] | undefined;
  if (!items) {
    await startDemontageScope(peerId, user, session);
    return;
  }
  const [, text] = demSummary('whole', items, [], '');
  await base.send(
    peerId,
    `${text}.\nВсё это оборудование спишется с комплекса и будет числиться на вас как снятое — сдайте его на склад. Верно?`,
    simpleKeyboard([
      [
        ['✅ Да, весь комплекс', { action: 'dem_whole_ok' }],
        ['❌ Нет', { action: 'dem_scope' }],
      ],
    ]),
  );
}

export async function demWholeOk(peerId: number, _user: base.BotUser, session: BotSession): Promise<void> {
  const items = (dem(session).items || []) as EqItem[];
  const [labels, text] = demSummary('whole', items, [], '');
  session.demontage_scope = {
    mode: 'whole',
    ids: items.map((i) => i.id),
    labels,
    other: '',
    summary: text,
  };
  session.step = 'menu';
  await base.send(
    peerId,
    `✅ Записал: ${text}.\nЭто попадёт в отчёт; оборудование спишется при «Завершить».`,
    base.menuKeyboard(session),
  );
}

export async function demParts(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  if (!dem(session).items) {
    await startDemontageScope(peerId, user, session);
    return;
  }
  await showView('dem_parts', peerId, user, session);
}

registerView('dem_parts', async (peerId, _user, session, page) => {
  const d = dem(session);
  const items = (d.items || []) as EqItem[];
  const selected = new Set<number>((d.selected || []) as number[]);
  const other = String(d.other || '');
  const head = items.length
    ? ['🧩 Отметьте, что демонтировано (нажатие — отметить / снять отметку):']
    : ['По учёту на комплексе оборудования нет — опишите снятое текстом («✍️ Другое»).'];
  if (other) head.push(`✍️ Ещё снято: ${other}`);
  const entries = items.map(
    (i) => [`${selected.has(i.id) ? '☑' : '☐'} ${label(i)}`, { action: 'dem_tog', i: i.id }] as [string, Record<string, unknown>],
  );
  const controls: Entry[][] = [
    [[`✅ Готово (${selected.size})`, { action: 'dem_parts_ok' }]],
    [
      ['✍️ Другое', { action: 'dem_other' }],
      ['⬅ Назад', { action: 'dem_scope' }],
    ],
  ];
  const [keyboard] = pagedKeyboard(entries, page, controls);
  await base.send(peerId, head.join('\n'), keyboard);
});

export async function demToggle(peerId: number, user: base.BotUser, session: BotSession, itemId: number): Promise<void> {
  const d = dem(session);
  const items = (d.items || []) as EqItem[];
  if (!items.some((i) => i.id === itemId)) {
    await startDemontageScope(peerId, user, session);
    return;
  }
  const selected = [...((d.selected || []) as number[])];
  const idx = selected.indexOf(itemId);
  if (idx >= 0) {
    selected.splice(idx, 1);
  } else {
    selected.push(itemId);
  }
  d.selected = selected;
  await showView('dem_parts', peerId, user, session, Number(session.view_page || 0));
}

export async function demOther(peerId: number, session: BotSession): Promise<void> {
  const d = dem(session);
  await base.beginDraft(
    peerId,
    session,
    'dem_other',
    '✍️ Напишите, что ещё снято, чего нет в списке оборудования (например: «кронштейн, кабель питания»). Если нечего — «-».',
    d.other || null,
    '✍️ Уже записано:',
  );
}

export async function setDemOther(peerId: number, user: base.BotUser, session: BotSession, value: string): Promise<void> {
  const clean = value.trim();
  dem(session).other = clean === '-' || clean === '—' ? '' : clean;
  session.step = 'menu';
  await showView('dem_parts', peerId, user, session);
}

export async function demPartsOk(peerId: number, user: base.BotUser, session: BotSession): Promise<void> {
  const d = dem(session);
  const items = (d.items || []) as EqItem[];
  const itemIds = new Set(items.map((x) => x.id));
  const selected = ((d.selected || []) as number[]).filter((id) => itemIds.has(id));
  const other = String(d.other || '');
  if (!selected.length && !other) {
    await base.send(peerId, 'Отметьте хотя бы один элемент или опишите снятое текстом («✍️ Другое»).');
    await showView('dem_parts', peerId, user, session, Number(session.view_page || 0));
    return;
  }
  const selSet = new Set(selected);
  const taken = items.filter((i) => selSet.has(i.id));
  const left = items.filter((i) => !selSet.has(i.id));
  const [labels, text] = demSummary('parts', taken, left, other);
  session.demontage_scope = { mode: 'parts', ids: selected, labels, other, summary: text };
  session.step = 'menu';
  await base.send(
    peerId,
    `✅ Записал: ${text}\nЭто попадёт в отчёт; отмеченное оборудование спишется при «Завершить». ` +
      'Комплекс при этом целиком не демонтирован — на «Завершить» выберете его итоговый статус.',
    base.menuKeyboard(session),
  );
}
