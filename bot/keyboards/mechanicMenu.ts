import { VkKeyboard } from '../vk.ts';

export const RESULT_STATUSES = ['Работает', 'Не работает', 'Демонтирован', 'Установлен'];

export const REMOVAL_REASONS = [
  'Неисправно',
  'Не включается',
  'Нет связи',
  'Механическое повреждение',
  'Плановая замена',
  'Причина неизвестна',
];

export const VK_INLINE_MAX_ROWS = 6;
export const VK_INLINE_MAX_BUTTONS = 10;

export function getUnauthorizedKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('🔄 Проверить снова', { action: 'main_menu' })
    .row()
    .add('📝 Отправить заявку', { action: 'request_join' });
}

export function getDeactivatedKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true }).add('🔄 Проверить снова', { action: 'main_menu' });
}

export function getMainMenuKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('📋 Мои задания на сегодня', { action: 'my_tasks' })
    .row()
    .add('🎒 Моё оборудование', { action: 'my_equipment' })
    .row()
    .add('✉️ Написать диспетчеру', { action: 'chat_open' })
    .row()
    .add('👤 Профиль', { action: 'profile' });
}

export function getBackToMenuKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true }).add('🏠 Главное меню', { action: 'main_menu' });
}

function pagerInControlsRow(paged: boolean, hasFilter: boolean): boolean {
  return paged && !hasFilter;
}

export function taskPageSize(total: number, hasFilter: boolean): number {
  if (total <= VK_INLINE_MAX_ROWS - 1) {
    return Math.max(total, 1);
  }
  return VK_INLINE_MAX_ROWS - (pagerInControlsRow(true, hasFilter) ? 1 : 2);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function taskButtonLabel(t: Record<string, any>): string {
  if (t.is_aux) {
    return `ℹ️ ${t.point || '?'} · вспомогательная`.slice(0, 40);
  }
  const base = `${t.started ? '🔧' : '📍'} ${t.point || '?'} · ${t.type || '?'}`;
  let extras = '';
  if (t.photo_count) extras += ` 📷${t.photo_count}`;
  if (t.has_report) extras += ' 📝';
  if (Array.isArray(t.in_work_by) && t.in_work_by.length) extras += ' 👷';
  return (base + extras).length <= 40 ? base + extras : base.slice(0, 40);
}

export function getTaskListKeyboard(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tasks: Array<Record<string, any>>,
  hasPrev: boolean,
  hasNext: boolean,
  hasFilter = false,
): VkKeyboard {
  const paged = hasPrev || hasNext;
  const inlinePager = pagerInControlsRow(paged, hasFilter);
  const kb = new VkKeyboard({ inline: true });
  for (const t of tasks) {
    kb.add(taskButtonLabel(t), { action: 'open_task', task_id: t.id }).row();
  }
  if (paged) {
    if (hasPrev) {
      kb.add(inlinePager ? '◀' : '◀ Назад', { action: 'tasks_page', dir: 'prev' });
    }
    if (hasNext) {
      kb.add(inlinePager ? '▶' : 'Далее ▶', { action: 'tasks_page', dir: 'next' });
    }
    if (!inlinePager) kb.row();
  }
  kb.add('🔎 Поиск', { action: 'tasks_search' });
  if (hasFilter) kb.add('❌ Сбросить', { action: 'tasks_search_clear' });
  kb.add('🏠 Меню', { action: 'main_menu' });
  return kb;
}

export function getAuxTaskKeyboard(taskId: string): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✅ Принято', { action: 'aux_accept', task_id: taskId })
    .add('🚪 Выйти', { action: 'my_tasks' });
}

export function getTaskOpenedKeyboard(taskId: string, resume = false): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add(resume ? '▶️ Продолжить работу' : '▶️ Начать работу', { action: 'start_task', task_id: taskId })
    .row()
    .add('🔙 К списку заданий', { action: 'my_tasks' });
}

function photoLabel(photoCount: number): string {
  return photoCount ? `📷 Фото (${photoCount})` : '📷 Фото';
}

function reportLabel(hasReport: boolean): string {
  return hasReport ? '📝 Отчёт ✅' : '📝 Отчёт';
}

export function getSimpleMenuKeyboard(photoCount = 0, hasReport = false, tools = false): VkKeyboard {
  const kb = new VkKeyboard({ inline: true })
    .add(photoLabel(photoCount), { action: 'repair_photo' })
    .add(reportLabel(hasReport), { action: 'repair_report' })
    .row();
  if (tools) {
    kb.add('🔍 Проверка доступности', { action: 'repair_check' })
      .add('💳 Замена SIM-карты', { action: 'repair_sim_change' })
      .row();
  }
  kb.add('🔧 Перейти в режим ремонта', { action: 'to_repair_mode' })
    .row()
    .add('📞 Диспетчер', { action: 'dispatcher_phone' })
    .add('🚪 Выйти', { action: 'leave_task' })
    .row()
    .add('✅ Завершить', { action: 'simple_finish' });
  return kb;
}

export function getPowerSourceKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('☀️ СЭС', { action: 'set_power_source', value: 'СЭС' })
    .add('🔌 Электросеть', { action: 'set_power_source', value: 'Электросеть' })
    .row()
    .add('🚪 Выйти', { action: 'leave_task' });
}

export function getOutcomeKeyboard(labels: string[]): VkKeyboard {
  const kb = new VkKeyboard({ inline: true });
  labels.forEach((label, i) => {
    kb.add(label.slice(0, 40), { action: 'set_outcome', i });
    if (i % 2 === 1 && i + 1 < labels.length) kb.row();
  });
  return kb;
}

export function getEquipmentMenuKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('🧩 Оборудование комплекса', { action: 'eq_catalog' })
    .row()
    .add('💳 Замена SIM-карты', { action: 'repair_sim_change' })
    .row()
    .add('✏️ Исправить номер SIM', { action: 'repair_sim_fix' })
    .row()
    .add('📝 Другое оборудование', { action: 'repair_equipment_other' })
    .row()
    .add('⬅ Назад в меню', { action: 'repair_menu_back' });
}

export function getSimConfirmKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✅ Да, верно', { action: 'sim_confirm_yes' })
    .add('✏️ Нет, другой номер', { action: 'sim_confirm_no' })
    .row()
    .add('💳 Заменили SIM-карту', { action: 'repair_sim_change' });
}

export function getNoAccessDecisionKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✅ Всё равно завершить', { action: 'finish_anyway' })
    .row()
    .add('🔓 Уехать без ремонта', { action: 'repair_release_request' })
    .row()
    .add('🔄 Проверить доступ ещё раз', { action: 'repair_check' })
    .row()
    .add('⬅ Вернуться', { action: 'repair_menu_back' });
}

export function getUnavailableReasonKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('🔌 Нет питания', { action: 'repair_no_power' })
    .row()
    .add('⚡ Не подведено питание', { action: 'repair_not_connected' })
    .row()
    .add('💥 Комплекс расстрелян', { action: 'repair_shot' })
    .row()
    .add('⬅ Вернуться', { action: 'repair_menu_back' });
}

export function getRepairMenuKeyboard(opts: {
  showPowerButtons?: boolean;
  showSimButton?: boolean;
  photoCount?: number;
  hasReport?: boolean;
  canUndoRepair?: boolean;
  demontage?: 'todo' | 'done' | null;
} = {}): VkKeyboard {
  const kb = new VkKeyboard({ inline: true })
    .add(photoLabel(opts.photoCount || 0), { action: 'repair_photo' })
    .add(reportLabel(Boolean(opts.hasReport)), { action: 'repair_report' })
    .row()
    .add('🔧 Замена оборудования', { action: 'repair_equipment' })
    .row();
  if (opts.demontage) {
    kb.add(opts.demontage === 'done' ? '🧰 Что демонтировано ✅' : '🧰 Что демонтировано', { action: 'dem_scope' })
      .row()
      .add('📞 Диспетчер', { action: 'dispatcher_phone' })
      .row();
  } else {
    if (opts.showPowerButtons) {
      kb.add('🔌 Нет питания', { action: 'repair_no_power' })
        .add('⚡ Не подведено питание', { action: 'repair_not_connected' })
        .row();
    } else if (opts.showSimButton) {
      kb.add('💳 Замена SIM-карты', { action: 'repair_sim_change' }).row();
    }
    kb.add('🔍 Проверка доступности', { action: 'repair_check' })
      .add('📞 Диспетчер', { action: 'dispatcher_phone' })
      .row();
  }
  if (opts.canUndoRepair) {
    kb.add('↩ Это не ремонт', { action: 'from_repair_mode' }).row();
  }
  kb.add('✅ Завершить', { action: 'repair_finish' }).add('🚪 Выйти', { action: 'leave_task' });
  return kb;
}

export function getResultStatusKeyboard(): VkKeyboard {
  const kb = new VkKeyboard({ inline: true });
  RESULT_STATUSES.forEach((st, i) => {
    kb.add(st, { action: 'set_result', status: st });
    if (i % 2 === 1) kb.row();
  });
  kb.add('⬅ Назад в меню', { action: 'repair_menu_back' });
  return kb;
}

export function getPhotoPanelKeyboard(lastN: number, mineN: number): VkKeyboard {
  const kb = new VkKeyboard({ inline: true });
  if (lastN) {
    kb.add(`🗑 Убрать последние (${lastN})`, { action: 'photo_rm', scope: 'last' }).row();
  }
  if (mineN && mineN !== lastN) {
    kb.add(`🗑 Убрать все мои (${mineN})`, { action: 'photo_rm', scope: 'all' }).row();
  }
  kb.add('⬅ Меню', { action: 'repair_menu_back' });
  return kb;
}

export function getReportPanelKeyboard(hasReport: boolean, canUndoLast: boolean): VkKeyboard {
  const kb = new VkKeyboard({ inline: true });
  if (hasReport) {
    if (canUndoLast) {
      kb.add('↩ Убрать последнее', { action: 'report_rm', scope: 'last' }).row();
    }
    kb.add('🗑 Убрать весь итог', { action: 'report_rm', scope: 'all' })
      .add('✏️ Изменить текст', { action: 'report_edit' })
      .row();
  }
  kb.add('⬅ Меню', { action: 'repair_menu_back' });
  return kb;
}

export function getPhotosKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✅ Готово', { action: 'photos_done' })
    .add('❌ Отмена', { action: 'photos_cancel' });
}

export function getDraftInputKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true }).add('❌ Отмена', { action: 'draft_cancel' });
}

export function getDraftConfirmKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✅ Сохранить', { action: 'draft_save' })
    .add('❌ Отмена', { action: 'draft_cancel' });
}

export function getDraftKeepKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✏️ Изменить', { action: 'draft_edit' })
    .add('✅ Оставить прежний', { action: 'draft_keep' });
}

export function getWaitingKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('📞 Диспетчер', { action: 'dispatcher_phone' })
    .add('🚪 Выйти', { action: 'leave_task' });
}

export function getSimStateKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✅ Рабочая', { action: 'sim_state_pick', w: 1 })
    .add('❌ Нерабочая', { action: 'sim_state_pick', w: 0 })
    .row()
    .add('↩ Отмена', { action: 'sim_state_back' });
}

export function getReasonKeyboard(): VkKeyboard {
  const kb = new VkKeyboard({ inline: true });
  REMOVAL_REASONS.forEach((label, i) => {
    kb.add(label.slice(0, 40), { action: 'rsn_pick', i });
    if (i % 2 === 1) kb.row();
  });
  kb.add('❌ Отмена', { action: 'rsn_back' });
  return kb;
}

export function getDispatcherKeyboard(inTask: boolean): VkKeyboard {
  return new VkKeyboard({ inline: true })
    .add('✉️ Написать диспетчеру', { action: 'chat_open' })
    .row()
    .add('⬅ Назад', { action: inTask ? 'repair_menu_back' : 'main_menu' });
}

export function getChatKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true }).add('🚪 Выйти из чата', { action: 'chat_exit' });
}

export function getChatNoticeKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true }).add('✉️ Ответить', { action: 'chat_open' });
}

export function getSearchCancelKeyboard(): VkKeyboard {
  return new VkKeyboard({ inline: true }).add('❌ Отмена', { action: 'tasks_search_cancel' });
}
