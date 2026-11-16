import { VkKeyboard } from '../vk.ts';

export const MAX_ROWS = 6;
export const MAX_BUTTONS = 10;

export type Entry = [string, Record<string, unknown>];

export function cut(text: string, limit = 40): string {
  const clean = String(text || '').replace(/\s+/g, ' ').trim();
  if (!clean) return '•';
  return clean.length <= limit ? clean : `${clean.slice(0, limit - 1)}…`;
}

export function pageGeometry(total: number, controls: Entry[][]): [number, number] {
  const rowsBudget = MAX_ROWS - controls.length;
  const buttonsBudget = MAX_BUTTONS - controls.reduce((acc, r) => acc + r.length, 0);
  if (total <= Math.max(Math.min(rowsBudget, buttonsBudget), 1)) {
    return [Math.max(total, 1), 1];
  }
  const size = Math.max(Math.min(rowsBudget - 1, buttonsBudget - 2), 1);
  return [size, Math.floor((total - 1) / size) + 1];
}

export function pagedKeyboard(
  entries: Entry[],
  page: number,
  controls: Entry[][] = [],
): [VkKeyboard, number, number] {
  const [size, pages] = pageGeometry(entries.length, controls);
  const clamped = Math.max(0, Math.min(page, pages - 1));
  const kb = new VkKeyboard({ inline: true });
  let first = true;
  const newRow = () => {
    if (!first) kb.row();
    first = false;
  };
  for (const [label, payload] of entries.slice(clamped * size, (clamped + 1) * size)) {
    newRow();
    kb.add(cut(label), payload);
  }
  if (pages > 1) {
    newRow();
    if (clamped > 0) {
      kb.add('◀', { action: 'pg', n: clamped - 1 });
    }
    if (clamped < pages - 1) {
      kb.add(clamped === 0 ? `▶ ${clamped + 2}/${pages}` : '▶', { action: 'pg', n: clamped + 1 });
    }
  }
  for (const row of controls) {
    newRow();
    for (const [label, payload] of row) {
      kb.add(cut(label), payload);
    }
  }
  return [kb, clamped, pages];
}

export function simpleKeyboard(rows: Entry[][]): VkKeyboard {
  const kb = new VkKeyboard({ inline: true });
  let first = true;
  for (const row of rows) {
    if (!first) kb.row();
    first = false;
    for (const [label, payload] of row) {
      kb.add(cut(label), payload);
    }
  }
  return kb;
}

export function getWarehouseMenuKeyboard(): VkKeyboard {
  return simpleKeyboard([
    [['📥 Принять от монтёра', { action: 'wh_accept' }]],
    [['📤 Выдать монтёру', { action: 'wh_issue' }]],
    [['🏷 Состояние оборудования', { action: 'wh_status' }]],
    [['📊 Остатки на складе', { action: 'wh_stock' }]],
    [['👤 Профиль', { action: 'profile' }]],
  ]);
}

export function getBackToWarehouseKeyboard(): VkKeyboard {
  return simpleKeyboard([[['🏠 Меню склада', { action: 'main_menu' }]]]);
}
