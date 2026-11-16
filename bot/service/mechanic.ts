import { ApiError, apiClient } from '../apiClient.ts';
import { getWarehouseMenuKeyboard } from '../keyboards/equipmentMenu.ts';
import {
  REMOVAL_REASONS,
  RESULT_STATUSES,
  getAuxTaskKeyboard,
  getBackToMenuKeyboard,
  getChatKeyboard,
  getChatNoticeKeyboard,
  getDispatcherKeyboard,
  getDraftConfirmKeyboard,
  getDraftInputKeyboard,
  getDraftKeepKeyboard,
  getEquipmentMenuKeyboard,
  getMainMenuKeyboard,
  getNoAccessDecisionKeyboard,
  getOutcomeKeyboard,
  getPhotoPanelKeyboard,
  getPhotosKeyboard,
  getPowerSourceKeyboard,
  getReasonKeyboard,
  getRepairMenuKeyboard,
  getReportPanelKeyboard,
  getResultStatusKeyboard,
  getSearchCancelKeyboard,
  getSimConfirmKeyboard,
  getSimStateKeyboard,
  getSimpleMenuKeyboard,
  getTaskListKeyboard,
  getTaskOpenedKeyboard,
  getUnavailableReasonKeyboard,
  getWaitingKeyboard,
  taskPageSize,
} from '../keyboards/mechanicMenu.ts';
import { matchesQuery } from '../names.ts';
import { sleep, type VkAudioMessage, type VkClient, type VkKeyboard, type VkPhotoAttachment, type VkRawMessage } from '../vk.ts';
import { getSession, resetSession, type BotSession } from './navigation.ts';

export { getChatKeyboard };

export const FINAL_STATUS_BY_TYPE: Record<string, string> = {
  'Установка': 'Установлен',
  'Демонтаж': 'Демонтирован',
};
export const DEMONTAGE_TYPE = 'Демонтаж';
export const POWER_STATUSES: Record<string, string> = {
  no_power: 'Нет питания',
  not_connected: 'Не подведено питание',
};
export const STATUS_WORKING = 'Работает';
export const STATUS_PING_ONLY = 'Есть только пинг';

let vkClientRef: VkClient | null = null;

export function setBotVkClient(client: VkClient | null): void {
  vkClientRef = client;
}

export function getBotVkClient(): VkClient | null {
  return vkClientRef;
}

export async function send(
  peerId: number,
  text: string,
  keyboard?: VkKeyboard | string | null,
  attachment?: string | null,
): Promise<void> {
  if (!vkClientRef) {
    throw new Error('VK client is not initialized');
  }
  await vkClientRef.messagesSend({ peerId, message: text, keyboard, attachment });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BotUser = Record<string, any>;

// ------------------------------------------------------------------ состояние комплекса (общий прогресс) ----

export const STATE_DEFAULTS: Record<string, unknown> = {
  report_text: null,
  equipment_installed: null,
  equipment_removed: null,
  power_status: null,
  work_type: null,
  point_id: null,
  sim_change: null,
  pending: null,
  check_confirmed: false,
  demontage_completed: false,
  no_access: false,
  repair_mode: false,
  switched_to_repair: false,
  sim_asked: false,
  demontage_scope: null,
  demontage_note: null,
  fault_text: null,
  needs_text: null,
  shot_text: null,
};

export const TASK_SESSION_KEYS = [
  'task_id',
  'work_session_id',
  'photo_count',
  'comment',
  'pending_action',
  'draft',
  'photo_batch',
  'photo_batches',
  'report_chunks',
  '_photo_mut',
  '_photo_busy',
  '_saved',
  'watch_token',
  'type_outcomes',
  '_eq_installed_tmp',
  'reason_ctx',
  'dem',
  'after_fault',
  'chat_prev_step',
  'chat_acked',
  'finish_after_check',
  'type_tools',
  'finish_reason_pick',
  ...Object.keys(STATE_DEFAULTS),
];

export const INPUT_STEPS = new Set(['awaiting_text', 'awaiting_photos', 'awaiting_reason', 'awaiting_sim_state', 'chat']);

function todayIso(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function normStateValue(key: string, value: unknown): unknown {
  const def = STATE_DEFAULTS[key];
  if (typeof def === 'boolean') return Boolean(value);
  if (key === 'sim_change' || key === 'pending' || key === 'demontage_scope') {
    return value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : null;
  }
  return value === undefined || value === null || value === '' ? null : value;
}

function sameJsonValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return false;
  return JSON.stringify(a) === JSON.stringify(b);
}

function stateOf(session: BotSession): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(STATE_DEFAULTS)) {
    out[key] = normStateValue(key, session[key]);
  }
  return out;
}

function applyState(session: BotSession, state: Record<string, unknown> | null | undefined): void {
  for (const key of Object.keys(STATE_DEFAULTS)) {
    session[key] = normStateValue(key, state ? state[key] : undefined);
  }
  session._saved = stateOf(session);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function adoptServer(session: BotSession, prog: Record<string, any>): void {
  if (!session._saved || typeof session._saved !== 'object') session._saved = {};
  const saved = session._saved as Record<string, unknown>;
  const server = (prog.state || {}) as Record<string, unknown>;
  for (const key of Object.keys(STATE_DEFAULTS)) {
    const val = normStateValue(key, server[key]);
    if (!sameJsonValue(val, normStateValue(key, saved[key]))) {
      session[key] = val;
      saved[key] = val;
    }
  }
  if ('photo_count' in prog && prog.photo_count !== undefined) {
    session.photo_count = prog.photo_count;
  }
}

export async function persistProgress(session: BotSession, forcePull = false): Promise<Record<string, unknown> | null> {
  const taskId = session.task_id as string | undefined;
  const vkId = session.vk_id as number | undefined;
  if (!taskId || !vkId) return null;

  const current = stateOf(session);
  const saved = (session._saved || {}) as Record<string, unknown>;
  const changes: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(current)) {
    if (!sameJsonValue(normStateValue(k, saved[k]), v)) {
      changes[k] = v;
    }
  }

  let prog: Record<string, unknown>;
  try {
    if (Object.keys(changes).length > 0) {
      prog = await apiClient.patchTaskProgress(taskId, vkId, changes);
    } else if (forcePull) {
      prog = await apiClient.getTaskProgress(taskId, vkId);
    } else {
      return null;
    }
  } catch (err) {
    console.warn(`[bot] Не удалось сохранить/получить прогресс по заданию ${taskId}:`, err instanceof Error ? err.message : err);
    return null;
  }

  session._saved = { ...saved, ...current };
  adoptServer(session, prog);
  return prog;
}

export async function afterAction(user: BotUser): Promise<void> {
  const session = getSession(user.vk_id);
  if (session.task_id) {
    await persistProgress(session);
  }
}

function canUndoRepair(session: BotSession): boolean {
  const footprint = Boolean(
    session.equipment_removed ||
      session.equipment_installed ||
      session.sim_change ||
      session.power_status ||
      session.shot_text,
  );
  return Boolean(session.switched_to_repair) && !footprint;
}

export function menuKeyboard(session: BotSession): VkKeyboard {
  const photoCount = Number(session.photo_count || 0);
  const hasReport = Boolean(String(session.report_text || '').trim());
  if (!session.repair_mode) {
    return getSimpleMenuKeyboard(photoCount, hasReport, Boolean(session.type_tools));
  }
  const noAccess = Boolean(session.no_access);
  let demontage: 'todo' | 'done' | null = null;
  if (session.demontage_completed) {
    demontage = session.demontage_scope ? 'done' : 'todo';
  }
  return getRepairMenuKeyboard({
    showSimButton: noAccess,
    photoCount,
    hasReport,
    canUndoRepair: canUndoRepair(session) && !demontage,
    demontage,
  });
}

function liveStep(s: BotSession, step = 'menu'): void {
  if (s.step === 'chat') {
    s.chat_prev_step = step;
  } else {
    s.step = step;
  }
}

function liveKb(s: BotSession): VkKeyboard {
  return s.step === 'chat' ? getChatKeyboard() : menuKeyboard(s);
}

function liveSession(vkId: number, taskId: string): BotSession | null {
  const s = getSession(vkId);
  return s.task_id === taskId ? s : null;
}

async function detachedSession(user: BotUser, taskId: string): Promise<BotSession | null> {
  let prog: Record<string, unknown>;
  try {
    prog = await apiClient.getTaskProgress(taskId, user.vk_id);
  } catch {
    return null;
  }
  if (prog.finished) return null;
  const detached: BotSession = {
    task_id: taskId,
    vk_id: user.vk_id,
    detached: true,
    photo_count: Number(prog.photo_count || 0),
  };
  applyState(detached, (prog.state || {}) as Record<string, unknown>);
  return detached;
}

const runningPollers = new Set<string>();

function spawnPoller(key: string, fn: () => Promise<void>): void {
  if (runningPollers.has(key)) return;
  runningPollers.add(key);
  void fn()
    .catch((err) => {
      console.error(`[bot] Фоновый опрос запроса ${key} завершился с ошибкой:`, err);
    })
    .finally(() => {
      runningPollers.delete(key);
    });
}

function progressLine(photoCount: unknown, hasReport: unknown): string {
  return `📷 Фото: ${photoCount || 'нет'} · 📝 Отчёт: ${hasReport ? 'написан' : 'не написан'}`;
}

// ------------------------------------------------------------------ главное меню / профиль / задания ----

export async function showMainMenu(peerId: number, user: BotUser): Promise<void> {
  const session = getSession(user.vk_id);
  await leaveCurrentTask(session);
  resetSession(user.vk_id);
  if (user.role_type === 'warehouse') {
    const text = `👋 Привет, ${user.full_name}!\nВы — ответственный за склад. Выберите действие:`;
    await send(peerId, text, getWarehouseMenuKeyboard());
    return;
  }
  const text = `👋 Привет, ${user.full_name}!\nВыберите действие:`;
  await send(peerId, text, getMainMenuKeyboard());
}

export async function showProfile(peerId: number, user: BotUser): Promise<void> {
  const roleNames: Record<string, string> = {
    fitter: 'Монтёр',
    driver: 'Водитель',
    operator: 'Оператор',
    warehouse: 'Склад',
  };
  const text =
    `👤 ${user.full_name}\n` +
    `Роль: ${roleNames[user.role_type] || user.role_type}\n` +
    `Телефон: ${user.phone || '—'}\n` +
    `VK ID: ${user.vk_id}`;
  await send(peerId, text, getBackToMenuKeyboard());
}

export async function showMyTasks(peerId: number, user: BotUser): Promise<void> {
  const vkId = user.vk_id as number;
  const session = getSession(vkId);
  await leaveCurrentTask(session);
  const tasks = await apiClient.listTasks(vkId, todayIso());
  const taskMap: Record<string, Record<string, unknown>> = {};
  for (const t of tasks) {
    taskMap[t.id] = t;
  }
  session.tasks = taskMap;
  session.tasks_page = 0;
  session.tasks_filter = '';
  session.peer_id = peerId;
  session.vk_id = vkId;
  session.step = null;
  await renderTaskList(peerId, session);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function filteredTasks(session: BotSession): Array<Record<string, any>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const tasks = Object.values((session.tasks || {}) as Record<string, Record<string, any>>);
  const q = String(session.tasks_filter || '').trim();
  if (!q) return tasks;
  const byPoint = tasks.filter((t) => matchesQuery(q, t.point));
  return byPoint.length > 0 ? byPoint : tasks.filter((t) => matchesQuery(q, t.point, t.point_address || t.address));
}

function crewMapLinks(session: BotSession): string[] {
  const seen = new Map<string, string>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  for (const t of Object.values((session.tasks || {}) as Record<string, Record<string, any>>)) {
    const link = String(t.map_link || '').trim();
    if (link && !seen.has(link)) {
      seen.set(link, t.crew_name || 'бригада');
    }
  }
  return Array.from(seen.entries()).map(([link, crew]) => `🗺 ${crew}: ${link}`);
}

export async function renderTaskList(peerId: number, session: BotSession): Promise<void> {
  const tasksFilter = String(session.tasks_filter || '').trim();
  const tasks = filteredTasks(session);
  const links = crewMapLinks(session);
  const mapLines = links.length ? `\n${links.join('\n')}\n` : '';
  if (!tasks.length) {
    const text = tasksFilter ? `Ничего не найдено по номеру «${tasksFilter}».` : 'На сегодня заданий нет.';
    await send(peerId, mapLines + text, getTaskListKeyboard([], false, false, Boolean(tasksFilter)));
    return;
  }

  const pageSize = taskPageSize(tasks.length, Boolean(tasksFilter));
  const totalPages = Math.floor((tasks.length - 1) / pageSize) + 1;
  const page = Math.max(0, Math.min(Number(session.tasks_page || 0), totalPages - 1));
  session.tasks_page = page;
  const pageTasks = tasks.slice(page * pageSize, (page + 1) * pageSize);

  let header = `Задания на сегодня (${tasks.length})`;
  if (tasksFilter) header += ` · поиск «${tasksFilter}»`;
  if (totalPages > 1) header += `\nСтраница ${page + 1} из ${totalPages}`;
  await send(peerId, `${mapLines}${header}:`, getTaskListKeyboard(pageTasks, page > 0, page < totalPages - 1, Boolean(tasksFilter)));
}

export async function changeTasksPage(peerId: number, session: BotSession, direction: string): Promise<void> {
  session.tasks_page = Number(session.tasks_page || 0) + (direction === 'next' ? 1 : -1);
  await renderTaskList(peerId, session);
}

export async function requestTaskSearch(peerId: number, session: BotSession): Promise<void> {
  session.step = 'awaiting_task_search';
  await send(
    peerId,
    'Введите номер комплекса (можно часть номера, с дефисом или без, любыми буквами; можно и адрес).',
    getSearchCancelKeyboard(),
  );
}

export async function cancelTaskSearch(peerId: number, session: BotSession): Promise<void> {
  session.step = null;
  await renderTaskList(peerId, session);
}

export async function clearTaskSearch(peerId: number, session: BotSession): Promise<void> {
  session.tasks_filter = '';
  session.tasks_page = 0;
  await renderTaskList(peerId, session);
}

export async function handleTaskSearchText(message: VkRawMessage, session: BotSession): Promise<void> {
  const text = String(message.text || '').trim();
  const peerId = Number(session.peer_id ?? message.peer_id);
  session.tasks_filter = text;
  session.tasks_page = 0;
  session.step = null;
  await renderTaskList(peerId, session);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function auxTaskText(t: Record<string, any>): string {
  const lines = [`ℹ️ Вспомогательная точка: ${t.point || '—'}`];
  if (t.work) lines.push(`📝 ${t.work}`);
  if (t.aux_lat && t.aux_lon) lines.push(`🧭 Координаты: ${t.aux_lat}, ${t.aux_lon}`);
  lines.push('Это метка с информацией для бригады — работы здесь нет. Нажмите «Принято», когда ознакомились.');
  return lines.join('\n');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function taskText(t: Record<string, any>): string {
  const lines = [`📍 ${t.point || '—'}`, `🏷 Тип: ${t.type || '—'}`];
  const address = t.point_address || t.address;
  if (address) lines.push(`🏠 ${address}`);
  lines.push(`💳 SIM: ${t.point_sim || 'не указана'}`);
  lines.push(`⚡ Питание: ${t.point_power_source || 'не указано'}`);
  if (t.work) lines.push(`📝 ${t.work}`);
  return lines.join('\n');
}

export async function showTask(peerId: number, user: BotUser, taskId: string): Promise<void> {
  const session = getSession(user.vk_id);
  const task = session.tasks?.[taskId];
  if (!task) {
    await send(peerId, 'Задание не найдено — откройте список заданий заново.', getBackToMenuKeyboard());
    return;
  }
  if (task.is_aux) {
    await send(peerId, auxTaskText(task), getAuxTaskKeyboard(taskId));
    return;
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prog: Record<string, any> | null = null;
  try {
    prog = await apiClient.getTaskProgress(taskId, user.vk_id);
  } catch {
    prog = null;
  }
  if (prog?.finished) {
    delete session.tasks[taskId];
    await send(peerId, `✅ По комплексу «${task.point || '—'}» отчёт уже сдан — задание закрыто.`);
    await renderTaskList(peerId, session);
    return;
  }
  let text = taskText(task);
  let resume = false;
  if (prog) {
    const others = (prog.workers || []).filter((w: { me?: boolean; name: string }) => !w.me).map((w: { name: string }) => w.name);
    resume = Boolean(
      (prog.state && Object.keys(prog.state).length > 0) || prog.photo_count || (prog.workers && prog.workers.length > 0),
    );
    if (resume) {
      text += `\n\n${progressLine(prog.photo_count, prog.has_report)}`;
      if (others.length) {
        text += `\n👷 Сейчас на комплексе: ${others.join(', ')} — вы будете работать вместе, фото и отчёт общие.`;
      } else {
        text += '\n⏸ Работа уже начата — можно продолжить с того же места.';
      }
    }
  }
  await send(peerId, text, getTaskOpenedKeyboard(taskId, resume));
}

export async function acceptAuxTask(peerId: number, user: BotUser, taskId: string): Promise<void> {
  const session = getSession(user.vk_id);
  const task = session.tasks?.[taskId];
  if (!task || !task.is_aux) {
    await send(peerId, 'Точка не найдена — откройте список заданий заново.', getBackToMenuKeyboard());
    return;
  }
  try {
    await apiClient.acceptAuxTask(taskId, user.vk_id);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `❌ Не удалось отметить точку: ${detail}`, getAuxTaskKeyboard(taskId));
    return;
  }
  delete session.tasks[taskId];
  await send(peerId, `✅ Принято: «${task.point || 'точка'}». На карте бригады она станет зелёной.`);
  await renderTaskList(peerId, session);
}

export async function startTask(peerId: number, user: BotUser, taskId: string): Promise<void> {
  const vkId = user.vk_id as number;
  const session = getSession(vkId);
  const task = session.tasks?.[taskId];
  if (!task) {
    await send(peerId, 'Задание не найдено — откройте список заданий заново.', getBackToMenuKeyboard());
    return;
  }
  if (session.task_id && session.task_id !== taskId) {
    await leaveCurrentTask(session);
  }
  await enterTask(peerId, user, session, task, false);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enterTask(peerId: number, user: BotUser, session: BotSession, task: Record<string, any>, restored: boolean): Promise<void> {
  const vkId = user.vk_id as number;
  const taskId = String(task.id);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let workSession: Record<string, any>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let prog: Record<string, any>;
  try {
    workSession = await apiClient.startWorkSession(taskId, vkId);
    prog = await apiClient.getTaskProgress(taskId, vkId);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `❌ Не удалось начать работу: ${detail}`, getBackToMenuKeyboard());
    return;
  }

  if (prog.finished) {
    if (session.tasks) delete session.tasks[taskId];
    try {
      await apiClient.endWorkSession(workSession.id);
    } catch {
      // ignore
    }
    await send(peerId, `✅ По комплексу «${task.point || '—'}» отчёт уже сдан — задание закрыто.`);
    await renderTaskList(peerId, session);
    return;
  }

  const workType = String(task.type || '');
  const serverState = { ...(prog.state || {}) };
  const resumed = Boolean(Object.keys(serverState).length > 0 || prog.photo_count || workSession.resumed);
  const watchToken = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;

  Object.assign(session, {
    task_id: taskId,
    vk_id: vkId,
    work_session_id: workSession.id,
    peer_id: peerId,
    photo_count: Number(prog.photo_count || 0),
    comment: null,
    pending_action: null,
    draft: null,
    photo_batch: [],
    type_outcomes: Array.isArray(task.type_outcomes) ? [...task.type_outcomes] : [],
    type_tools: Boolean(task.type_tools),
    watch_token: watchToken,
    step: 'menu',
  });
  applyState(session, serverState);
  session.point_id = session.point_id || task.point;
  session.work_type = session.work_type || workType;
  if (!('repair_mode' in serverState)) {
    session.repair_mode = Boolean(task.type_is_repair);
  }
  if (!('demontage_completed' in serverState)) {
    session.demontage_completed = workType === DEMONTAGE_TYPE;
  }
  await persistProgress(session);

  const others = (prog.workers || []).filter((w: { me?: boolean; name: string }) => !w.me).map((w: { name: string }) => w.name);
  const head = `${restored || resumed ? '🔄 Продолжаем работу' : '▶️ Начали работу'} по «${task.point}».`;
  const lines = [head];
  if (resumed) {
    lines.push(progressLine(session.photo_count, Boolean(String(session.report_text || '').trim())));
  }
  if (others.length) {
    lines.push(`👷 Также на комплексе: ${others.join(', ')} — фото и отчёт общие.`);
  }
  const intro = lines.join('\n');

  void taskWatcher(peerId, user, taskId, Number(workSession.id), watchToken);

  if (session.pending) {
    await send(peerId, intro);
    await resumePending(peerId, user, session);
    return;
  }
  if (!task.point_power_source) {
    session.step = 'awaiting_power_source';
    await send(peerId, `${intro}\n⚡ Питание этого комплекса не указано. Чем он запитан?`, getPowerSourceKeyboard());
    return;
  }
  await showTaskMenu(peerId, session, task, intro);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function showTaskMenu(peerId: number, session: BotSession, task: Record<string, any>, intro?: string): Promise<void> {
  session.step = 'menu';
  const head = intro || `▶️ Работа по «${task.point}».`;
  await send(
    peerId,
    `${head}\n💡 Фото и итог работ можно просто присылать сюда — приму без кнопок ` +
      `(поправить: «📷 Фото» и «📝 Отчёт» в меню).\nВыберите действие:`,
    menuKeyboard(session),
  );
}

export async function leaveCurrentTask(session: BotSession): Promise<{ point: string | null; photo_count: number; has_report: boolean } | null> {
  const taskId = session.task_id as string | undefined;
  if (!taskId) return null;
  const info = {
    point: (session.point_id as string | null) ?? null,
    photo_count: Number(session.photo_count || 0),
    has_report: Boolean(String(session.report_text || '').trim()),
  };
  await persistProgress(session);
  const workSessionId = session.work_session_id as number | undefined;
  if (workSessionId) {
    try {
      await apiClient.endWorkSession(workSessionId);
    } catch {
      console.warn(`[bot] Не удалось закрыть рабочую сессию ${workSessionId} при выходе с комплекса`);
    }
  }
  for (const k of TASK_SESSION_KEYS) {
    delete session[k];
  }
  session.step = null;
  return info;
}

export async function leaveTaskAction(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  const info = await leaveCurrentTask(session);
  if (info) {
    await send(
      peerId,
      `🚪 Вышли с комплекса «${info.point || '—'}» без завершения. Сохранено: ` +
        `${progressLine(info.photo_count, info.has_report)}.\n` +
        'Зайдите в него снова из списка — работа продолжится с того же места.',
    );
  }
  await showMyTasks(peerId, user);
}

export async function restoreActiveTask(peerId: number, user: BotUser, session: BotSession): Promise<boolean> {
  const vkId = user.vk_id as number;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let active: Record<string, any> | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let tasks: Array<Record<string, any>> = [];
  try {
    active = (await apiClient.getActiveSession(vkId)).session;
    if (!active) return false;
    tasks = await apiClient.listTasks(vkId, todayIso());
  } catch {
    return false;
  }
  const taskMap: Record<string, Record<string, unknown>> = {};
  for (const t of tasks) taskMap[t.id] = t;
  session.tasks = taskMap;
  const task = taskMap[active.task_id];
  if (!task || task.is_aux) return false;
  await enterTask(peerId, user, session, task, true);
  return Boolean(session.task_id);
}

export async function setPowerSource(peerId: number, session: BotSession, value: string): Promise<void> {
  if (session.step !== 'awaiting_power_source' || !session.task_id) return;
  try {
    await apiClient.setPointPowerSource(String(session.point_id), value);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `❌ Не удалось сохранить питание: ${detail}`, getPowerSourceKeyboard());
    return;
  }
  const task = session.tasks?.[session.task_id];
  if (task) task.point_power_source = value;
  await send(peerId, `⚡ Питание комплекса: ${value}. Записал.`);
  await showTaskMenu(peerId, session, task || { point: session.point_id });
}

// ------------------------------------------------------------------ фото и голосовые ----

const DOC_IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp']);

function imageDocs(obj: VkRawMessage): VkPhotoAttachment[] {
  const docs: VkPhotoAttachment[] = [];
  for (const a of obj.attachments || []) {
    const doc = a.doc;
    const ext = String(doc?.ext || '').toLowerCase();
    if (doc && DOC_IMAGE_EXT.has(ext) && doc.url) {
      docs.push({
        id: doc.id,
        owner_id: doc.owner_id,
        sizes: [{ url: doc.url, width: 0, height: 0 }],
        file_name: `photo_doc_${doc.owner_id}_${doc.id}.${ext || 'jpg'}`,
      });
    }
  }
  return docs;
}

function photosIn(obj: VkRawMessage): VkPhotoAttachment[] {
  const photos: VkPhotoAttachment[] = [];
  for (const a of obj.attachments || []) {
    if (a.photo) photos.push(a.photo);
  }
  photos.push(...imageDocs(obj));
  for (const fwd of obj.fwd_messages || []) {
    photos.push(...photosIn(fwd));
  }
  if (obj.reply_message) {
    photos.push(...photosIn(obj.reply_message));
  }
  return photos;
}

export async function collectPhotoAttachments(message: VkRawMessage): Promise<VkPhotoAttachment[]> {
  let photos = photosIn(message);
  if ((photos.length > 0 || (message as { is_cropped?: boolean }).is_cropped) && vkClientRef && message.conversation_message_id) {
    try {
      const items = await vkClientRef.getByConversationMessageId(message.peer_id, [message.conversation_message_id]);
      if (items.length > 0) {
        photos = [...photosIn(items[0]), ...photos];
      }
    } catch (err) {
      console.warn('[bot] Не удалось запросить полное сообщение с фото — беру из события:', err instanceof Error ? err.message : err);
    }
  }
  const unique: VkPhotoAttachment[] = [];
  const seen = new Set<string>();
  for (const p of photos) {
    const key = `${p.owner_id}_${p.file_name || p.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique;
}

export function voiceAttachments(message: VkRawMessage): VkAudioMessage[] {
  const voices: VkAudioMessage[] = [];
  for (const a of message.attachments || []) {
    if (a.audio_message) voices.push(a.audio_message);
  }
  for (const fwd of message.fwd_messages || []) {
    voices.push(...voiceAttachments(fwd));
  }
  return voices;
}

function mergeText(current: unknown, addition: string): string {
  const cur = String(current || '').trim();
  const next = String(addition || '').trim();
  if (!next) return cur;
  if (!cur) return next;
  if (cur.toLowerCase().includes(next.toLowerCase())) return cur;
  return `${cur}; ${next}`;
}

const VOICE_POLL_MS = 3000;
const VOICE_POLL_LIMIT_MS = 20 * 60 * 1000;
const VOICE_TEXT_OFF = '🎙 Голосовые сообщения пока не принимаются — напишите итог работ обычным сообщением, оно записывается без кнопок.';

export async function receiveVoice(message: VkRawMessage, user: BotUser, session: BotSession, voices: VkAudioMessage[]): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  let cfg: { bot_voice?: boolean; asr_ready?: boolean; llm_ready?: boolean };
  try {
    cfg = await apiClient.aiConfig();
  } catch {
    await send(peerId, '⚠️ Сервер сейчас недоступен — голосовое не принято. Напишите итог текстом.', menuKeyboard(session));
    return;
  }
  if (!cfg.bot_voice) {
    await send(peerId, VOICE_TEXT_OFF, session.task_id ? menuKeyboard(session) : undefined);
    return;
  }
  if (!session.task_id) {
    await send(peerId, '🎙 Голосовой итог принимается на комплексе: откройте задание (📋 Мои задания) и пришлите голосовое там.');
    return;
  }
  if (!cfg.asr_ready) {
    await send(peerId, '🎙 Распознавание речи сейчас не работает — напишите итог текстом, он записывается без кнопок.', menuKeyboard(session));
    return;
  }
  const voice = voices[0];
  const url = voice.link_mp3 || voice.link_ogg;
  if (!url) {
    await send(peerId, '⚠️ Не удалось получить запись — пришлите голосовое ещё раз или напишите итог текстом.', menuKeyboard(session));
    return;
  }
  let audio: Buffer;
  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(60_000) });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    audio = Buffer.from(await resp.arrayBuffer());
  } catch {
    await send(peerId, '⚠️ Не удалось скачать запись — пришлите голосовое ещё раз.', menuKeyboard(session));
    return;
  }
  const taskId = String(session.task_id);
  const visitType = String(session.work_type || '');
  let job: { job_id: string };
  try {
    job = await apiClient.aiVoice(
      user.vk_id,
      taskId,
      String(session.point_id || ''),
      visitType,
      voice.link_mp3 ? 'voice.mp3' : 'voice.ogg',
      audio,
    );
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `⚠️ Голосовое не принято: ${detail}. Напишите итог текстом.`, menuKeyboard(session));
    return;
  }
  const seconds = Number(voice.duration || 0);
  await send(
    peerId,
    `🎙 Принял голосовое${seconds ? ` (${seconds} с)` : ''}. Расшифровываю и раскладываю по полям отчёта — пришлю результат отдельным сообщением ` +
      '(это занимает от минуты). Пока можно продолжать работу: фото, текст, меню.',
    menuKeyboard(session),
  );
  spawnPoller(`voice:${job.job_id}`, () => voiceWatch(peerId, user, taskId, job.job_id));
}

async function voiceWatch(peerId: number, user: BotUser, taskId: string, jobId: string): Promise<void> {
  let waited = 0;
  let errors = 0;
  while (waited < VOICE_POLL_LIMIT_MS) {
    await sleep(VOICE_POLL_MS);
    waited += VOICE_POLL_MS;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let job: Record<string, any>;
    try {
      job = await apiClient.aiVoiceJob(jobId, user.vk_id);
      errors = 0;
    } catch (err) {
      if (err instanceof ApiError) {
        errors += 1;
        if (errors > 5) break;
      }
      continue;
    }
    if (job.status === 'done') {
      await applyVoiceResult(peerId, user, taskId, job.result || {});
      return;
    }
    if (job.status === 'error') {
      await send(peerId, `⚠️ Не удалось обработать голосовое: ${job.error || 'ошибка'}\nНапишите итог текстом — он записывается без кнопок.`);
      return;
    }
  }
  await send(peerId, '⏳ Голосовое обрабатывается слишком долго — напишите итог текстом.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyVoiceResult(peerId: number, user: BotUser, taskId: string, result: Record<string, any>): Promise<void> {
  const s = liveSession(user.vk_id, taskId) || (await detachedSession(user, taskId));
  const transcript = String(result.transcript || '').trim();
  if (!s) {
    await send(peerId, `🎙 Расшифровка (задание уже закрыто, в отчёт не записана): «${transcript}»`);
    return;
  }
  const done = String(result.done || transcript).trim();
  const cause = String(result.cause || '').trim();
  const needs = String(result.needs || '').trim();
  const live = !s.detached;
  const current = String(s.report_text || '').trim();
  if (done) {
    s.report_text = current ? `${current}\n${done}` : done;
    if (!Array.isArray(s.report_chunks)) s.report_chunks = [];
    if (!current) s.report_chunks.length = 0;
    s.report_chunks.push(done);
  }
  if (cause) s.fault_text = mergeText(s.fault_text, cause);
  if (needs) s.needs_text = mergeText(s.needs_text, needs);

  const lines = [`🎙 Расшифровка: «${transcript}»`];
  if (result.used_ai) {
    lines.push(`📝 Что сделано: ${done}`);
    lines.push(cause ? `⚠️ Причина: ${cause}` : '⚠️ Причина: не названа');
    if (needs) lines.push(`📦 Что нужно для восстановления: ${needs}`);
    if (result.fixed === 'да' || result.fixed === 'нет') {
      lines.push('По вашим словам неисправность ' + (result.fixed === 'да' ? 'устранена.' : 'не устранена.'));
    }
    lines.push(
      '\n✅ Записано в итог работ' +
        (cause || needs ? ', причина и «что нужно» подставятся в отчёт — при завершении их можно изменить.' : '.'),
    );
  } else {
    lines.push('\n✅ Записал расшифровку как итог работ (разобрать по полям не получилось — модель сейчас недоступна).');
  }
  lines.push('Поправить — кнопка «📝 Отчёт».');
  const point = String(s.point_id || 'комплексу');
  const prefix = live ? '' : `По комплексу «${point}»:\n`;
  await persistProgress(s);
  if (live) {
    await send(peerId, prefix + lines.join('\n'), liveKb(s));
  } else {
    await send(peerId, prefix + lines.join('\n'));
  }
}

function photoTouch(session: BotSession): void {
  session._photo_mut = Number(session._photo_mut || 0) + 1;
}

function photoFileName(photo: VkPhotoAttachment): string {
  if (photo.file_name) return String(photo.file_name);
  return photo.owner_id !== undefined ? `photo_${photo.owner_id}_${photo.id}.jpg` : `photo_${photo.id}.jpg`;
}

async function sendPhotoToServer(
  vkId: number,
  taskId: string,
  filename: string,
  content: Buffer,
): Promise<['saved' | 'duplicate' | 'failed', number | null]> {
  const ATTEMPTS = 3;
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    try {
      const saved = await apiClient.uploadPhoto(vkId, taskId, filename, content);
      if (saved.duplicate && attempt === 1) {
        return ['duplicate', saved.id ?? null];
      }
      return ['saved', saved.id ?? null];
    } catch (err) {
      if (err instanceof ApiError && err.statusCode < 500 && err.statusCode !== 408) {
        console.warn('[bot] Фото не принято сервером:', err.message);
        return ['failed', null];
      }
      console.warn(`[bot] Фото ошибка отправки (попытка ${attempt}/${ATTEMPTS}):`, err instanceof Error ? err.message : err);
    }
    if (attempt < ATTEMPTS) {
      await sleep(2000 * attempt);
    }
  }
  return ['failed', null];
}

async function uploadPhotos(session: BotSession, vkId: number, photos: VkPhotoAttachment[]): Promise<[number[], number, number]> {
  const savedIds: number[] = [];
  let failed = 0;
  let duplicates = 0;
  for (const photo of photos) {
    const sizes = photo.sizes || [];
    if (!sizes.length) {
      failed += 1;
      continue;
    }
    const best = sizes.reduce((a, b) => ((b.width || 0) * (b.height || 0) >= (a.width || 0) * (a.height || 0) ? b : a));
    let content: Buffer | null = null;
    for (const attempt of [1, 2]) {
      try {
        const resp = await fetch(best.url, { signal: AbortSignal.timeout(30_000) });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        content = Buffer.from(await resp.arrayBuffer());
        break;
      } catch (err) {
        console.warn(`[bot] Не удалось скачать фото из VK (попытка ${attempt}/2):`, err instanceof Error ? err.message : err);
        await sleep(1500);
      }
    }
    if (!content) {
      failed += 1;
      continue;
    }
    const [outcome, photoId] = await sendPhotoToServer(vkId, String(session.task_id), photoFileName(photo), content);
    if (outcome === 'saved' && photoId !== null) {
      savedIds.push(photoId);
    } else if (outcome === 'duplicate') {
      duplicates += 1;
    } else {
      failed += 1;
    }
  }
  return [savedIds, failed, duplicates];
}

export async function handlePhotoMessage(
  message: VkRawMessage,
  user: BotUser,
  session: BotSession,
  photosArg?: VkPhotoAttachment[],
): Promise<void> {
  const photos = photosArg ?? (await collectPhotoAttachments(message));
  if (!photos.length) return;
  const vkId = user.vk_id as number;
  const peerId = Number(session.peer_id ?? message.peer_id);
  if (session.step !== 'awaiting_photos') session.photo_batch = [];
  session.step = 'awaiting_photos';
  const [savedIds, failed, duplicates] = await uploadPhotos(session, vkId, photos);
  if (!Array.isArray(session.photo_batch)) session.photo_batch = [];
  session.photo_batch.push(...savedIds);
  const uploaded = savedIds.length;
  if (uploaded) {
    session.photo_count = Number(session.photo_count || 0) + uploaded;
  }
  let text = `📷 Принято фото: ${uploaded}${photos.length > 1 ? ` из ${photos.length}` : ''}.`;
  text += ` В этот раз: ${session.photo_batch.length} · всего по комплексу: ${session.photo_count || 0}.`;
  if (duplicates) text += `\nℹ️ Уже было принято раньше: ${duplicates}.`;
  if (failed) text += `\n⚠️ Не удалось сохранить: ${failed} — отправьте их ещё раз.`;
  text += '\nПришлите ещё или нажмите «Готово».';
  await send(peerId, text, getPhotosKeyboard());
}

const photoAckState = new Map<
  number,
  { newCount: number; failed: number; dup: number; ids: number[]; timer: ReturnType<typeof setTimeout> | null }
>();

function waitKeyboardFor(session: BotSession): VkKeyboard | undefined {
  if (session.step === 'awaiting_power_source') return getPowerSourceKeyboard();
  return session.task_id ? menuKeyboard(session) : undefined;
}

export async function receivePhotos(
  message: VkRawMessage,
  user: BotUser,
  session: BotSession,
  photos: VkPhotoAttachment[],
): Promise<void> {
  const vkId = user.vk_id as number;
  const peerId = Number(session.peer_id ?? message.peer_id);
  photoTouch(session);
  const before = Number(session.photo_count || 0);
  session._photo_busy = true;
  let savedIds: number[] = [];
  let failed = 0;
  let duplicates = 0;
  try {
    [savedIds, failed, duplicates] = await uploadPhotos(session, vkId, photos);
  } finally {
    session._photo_busy = false;
  }
  if (savedIds.length) {
    session.photo_count = before + savedIds.length;
  }
  photoTouch(session);

  let ack = photoAckState.get(vkId);
  if (!ack) {
    ack = { newCount: 0, failed: 0, dup: 0, ids: [], timer: null };
    photoAckState.set(vkId, ack);
  }
  ack.newCount += savedIds.length;
  ack.failed += failed;
  ack.dup += duplicates;
  for (const i of savedIds) {
    if (i) ack.ids.push(i);
  }
  if (ack.timer) clearTimeout(ack.timer);
  ack.timer = setTimeout(() => {
    void flushPhotoAck(vkId, peerId, session, ack!);
  }, 2500);
}

async function flushPhotoAck(
  vkId: number,
  peerId: number,
  session: BotSession,
  ack: { newCount: number; failed: number; dup: number; ids: number[]; timer: ReturnType<typeof setTimeout> | null },
): Promise<void> {
  const newCount = ack.newCount;
  const failed = ack.failed;
  const dup = ack.dup;
  const ids = [...ack.ids];
  ack.newCount = 0;
  ack.failed = 0;
  ack.dup = 0;
  ack.ids = [];
  ack.timer = null;

  if (!newCount && !failed && !dup) return;
  if (ids.length) {
    if (!Array.isArray(session.photo_batches)) session.photo_batches = [];
    session.photo_batches.push(ids);
  }
  const lines: string[] = [];
  if (newCount) {
    lines.push(`📷 Принято фото: ${newCount}. Всего по комплексу: ${session.photo_count || 0}.`);
    lines.push('Можно присылать ещё. Убрать присланное по ошибке — кнопка «📷 Фото».');
  }
  if (dup) lines.push(`ℹ️ Это фото уже было принято раньше: ${dup}.`);
  if (failed) lines.push(`⚠️ Не удалось сохранить: ${failed} — отправьте их ещё раз.`);
  if (session.step === 'awaiting_power_source') {
    lines.push('⚡ А пока — чем запитан комплекс?');
  }
  try {
    await send(peerId, lines.join('\n'), waitKeyboardFor(session));
  } catch (err) {
    console.warn('[bot] Не удалось отправить подтверждение о принятых фото:', err instanceof Error ? err.message : err);
  }
}

export async function receiveReportText(message: VkRawMessage, _user: BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const text = String(message.text || '').trim();
  if (text.length < 3) {
    await send(
      peerId,
      'Слишком коротко для итога работ — напишите подробнее. Если нужна кнопка — выберите её в меню.',
      waitKeyboardFor(session),
    );
    return;
  }
  const current = String(session.report_text || '').trim();
  session.report_text = current ? `${current}\n${text}` : text;
  if (!Array.isArray(session.report_chunks)) session.report_chunks = [];
  if (!current) session.report_chunks.length = 0;
  session.report_chunks.push(text);

  const full = String(session.report_text);
  const shown = full.length <= 700 ? full : `${full.slice(0, 700)}…`;
  const head = current ? '📝 Добавил к итогу работ.' : '📝 Итог работ записан.';
  const tail = session.step === 'awaiting_power_source' ? '\n⚡ А пока — чем запитан комплекс?' : '';
  await send(peerId, `${head}\n«${shown}»\n\nМожно дописать ещё сообщением. Поправить — кнопка «📝 Отчёт».${tail}`, waitKeyboardFor(session));
}

function lastBatch(mine: Array<{ id: number; uploaded_at?: string }>, session: BotSession): Array<{ id: number; uploaded_at?: string }> {
  const byId = new Map(mine.map((p) => [p.id, p]));
  const batches = (session.photo_batches || []) as number[][];
  for (let idx = batches.length - 1; idx >= 0; idx--) {
    const alive = batches[idx].map((id) => byId.get(id)).filter((x): x is { id: number; uploaded_at?: string } => Boolean(x));
    if (alive.length) return alive;
  }
  const batch: Array<{ id: number; uploaded_at?: string }> = [];
  let prev: number | null = null;
  for (let i = mine.length - 1; i >= 0; i--) {
    const ph = mine[i];
    const t = ph.uploaded_at ? Date.parse(ph.uploaded_at) : NaN;
    if (prev !== null && !Number.isNaN(t) && (prev - t) / 1000 > 90) break;
    batch.push(ph);
    if (!Number.isNaN(t)) prev = t;
  }
  return batch.reverse();
}

async function myPhotos(session: BotSession): Promise<Array<{ id: number; uploaded_at?: string }>> {
  try {
    return await apiClient.listMyPhotos(session.vk_id, session.task_id);
  } catch {
    return [];
  }
}

function photosPrompt(session: BotSession): string {
  return (
    `📷 Отправляйте фото (можно сразу несколько). По комплексу уже загружено: ${session.photo_count || 0}.\n` +
    'Закончите — «Готово». «Отмена» уберёт фото, присланные в этот раз.'
  );
}

export async function repairRequestPhoto(peerId: number, session: BotSession): Promise<void> {
  session.step = 'menu';
  await persistProgress(session, true);
  const mine = await myPhotos(session);
  const last = lastBatch(mine, session);
  const total = Number(session.photo_count || 0);
  const lines = [`📷 Фото по комплексу: ${total || 'нет'}.`];
  if (mine.length) {
    lines.push(`Ваших фото: ${mine.length}, последняя пачка — ${last.length}.`);
  }
  lines.push('Просто присылайте фото сюда — приму без кнопок. Убрать присланное по ошибке — кнопки ниже.');
  await send(peerId, lines.join('\n'), getPhotoPanelKeyboard(last.length, mine.length));
}

export async function photoRemove(peerId: number, session: BotSession, scope: 'last' | 'all'): Promise<void> {
  session.step = 'menu';
  photoTouch(session);
  const mine = await myPhotos(session);
  const targets = scope === 'last' ? lastBatch(mine, session) : mine;
  let removed = 0;
  for (const ph of targets) {
    try {
      await apiClient.deletePhoto(ph.id, session.vk_id, session.task_id);
      removed += 1;
    } catch {
      console.warn(`[bot] Не удалось убрать фото ${ph.id}`);
    }
  }
  const gone = new Set(targets.map((p) => p.id));
  session.photo_batches = ((session.photo_batches || []) as number[][])
    .map((b) => b.filter((id) => !gone.has(id)))
    .filter((b) => b.length > 0);
  await persistProgress(session, true);
  photoTouch(session);
  const head = removed ? `🗑 Убрано фото: ${removed}.` : 'Убирать было нечего.';
  await send(peerId, `${head} Всего по комплексу: ${session.photo_count || 0}.`, menuKeyboard(session));
}

export async function photosDone(peerId: number, session: BotSession): Promise<void> {
  const got = (session.photo_batch || []).length;
  session.step = 'menu';
  session.photo_batch = [];
  const head = got ? `✅ Фото сохранены (в этот раз: ${got}).` : 'Новых фото не было.';
  await send(peerId, `${head} Всего по комплексу: ${session.photo_count || 0}.`, menuKeyboard(session));
}

export async function photosCancel(peerId: number, session: BotSession): Promise<void> {
  const batch = ((session.photo_batch || []) as number[]).filter(Boolean);
  let removed = 0;
  for (const photoId of batch) {
    try {
      await apiClient.deletePhoto(photoId, session.vk_id, session.task_id);
      removed += 1;
    } catch {
      console.warn(`[bot] Не удалось убрать фото ${photoId} при отмене`);
    }
  }
  session.step = 'menu';
  session.photo_batch = [];
  await persistProgress(session, true);
  const head = batch.length
    ? `❌ Отменено: убрано фото — ${removed}.`
    : '❌ Отменено — присланных в этот раз фото не было.';
  await send(peerId, `${head} Всего по комплексу: ${session.photo_count || 0}.`, menuKeyboard(session));
}

// ------------------------------------------------------------------ завершение простого режима ----

export async function setResult(peerId: number, user: BotUser, session: BotSession, status: string): Promise<void> {
  if (!RESULT_STATUSES.includes(status)) return;
  if (
    status === 'Не работает' &&
    !(await ensureFaultInfo(peerId, session, { op: 'finish', status, comment: session.report_text || '' }))
  ) {
    return;
  }
  await submitAndFinish(peerId, user, session, status, String(session.report_text || ''));
}

export async function simpleFinish(peerId: number, _user: BotUser, session: BotSession): Promise<void> {
  await persistProgress(session, true);
  if (!session.photo_count) {
    await send(peerId, 'Пришлите хотя бы одно фото (просто отправьте его сюда), прежде чем завершить.', menuKeyboard(session));
    return;
  }
  if (!String(session.report_text || '').trim()) {
    await send(peerId, 'Сначала напишите итог работ (просто сообщением сюда).', menuKeyboard(session));
    return;
  }
  session.step = 'awaiting_result';
  const outcomes = (session.type_outcomes || []) as string[];
  if (outcomes.length) {
    await send(peerId, 'Выберите статус выезда:', getOutcomeKeyboard(outcomes));
    return;
  }
  await send(peerId, 'Выберите итоговый статус комплекса:', getResultStatusKeyboard());
}

export async function setOutcome(peerId: number, user: BotUser, session: BotSession, index: number): Promise<void> {
  const outcomes = (session.type_outcomes || []) as string[];
  if (session.step !== 'awaiting_result' || index < 0 || index >= outcomes.length) return;
  await submitAndFinish(peerId, user, session, '', String(session.report_text || ''), undefined, outcomes[index]);
}

export async function toRepairMode(peerId: number, session: BotSession): Promise<void> {
  session.repair_mode = true;
  session.switched_to_repair = true;
  session.step = 'menu';
  await send(
    peerId,
    '🔧 Переключились в режим ремонта. Можно отметить замену оборудования и проверить доступность комплекса.',
    menuKeyboard(session),
  );
}

export async function fromRepairMode(peerId: number, session: BotSession): Promise<void> {
  if (!canUndoRepair(session)) {
    await send(
      peerId,
      'Вернуть обычный режим уже нельзя — отмечена замена оборудования/SIM или статус питания — это ремонт. ' +
        'Если визит всё-таки был без ремонта, попросите диспетчера поменять тип выезда в отчёте.',
      menuKeyboard(session),
    );
    return;
  }
  session.repair_mode = false;
  session.switched_to_repair = false;
  session.no_access = false;
  session.step = 'menu';
  const base = session.work_type || 'выезд';
  await send(peerId, `↩ Вернул обычный режим. В отчётах визит будет записан как «${base}».`, menuKeyboard(session));
}

function equipmentForReport(session: BotSession): [string | null, string | null] {
  const removedParts: string[] = [];
  if (session.equipment_removed) removedParts.push(String(session.equipment_removed));
  const installedParts: string[] = [];
  if (session.equipment_installed) installedParts.push(String(session.equipment_installed));
  const scope = session.demontage_scope as { labels?: string; other?: string } | undefined;
  if (scope?.labels || scope?.other) {
    const extra = [scope.labels, scope.other].filter(Boolean).join('; ');
    if (extra) removedParts.push(extra);
  }
  return [removedParts.filter(Boolean).join('; ') || null, installedParts.filter(Boolean).join('; ') || null];
}

function simForReport(session: BotSession): [string | null, string | null, string | null] {
  const change = (session.sim_change || {}) as { old?: string; new?: string; old_state?: string };
  if (!change.new) return [null, null, null];
  const old = change.old || null;
  const state = old && (change.old_state === 'working' || change.old_state === 'defective') ? change.old_state : null;
  return [old, change.new, state];
}

async function submitAndFinish(
  peerId: number,
  user: BotUser,
  session: BotSession,
  status: string,
  commentArg: string,
  finalText = '✅ Отчёт сохранён. Хорошего дня!',
  outcome?: string | null,
): Promise<void> {
  const vkId = user.vk_id as number;
  const taskId = session.task_id as string | undefined;
  if (!taskId) {
    await send(peerId, 'Сессия потеряна — начните задание заново.', getBackToMenuKeyboard());
    return;
  }
  let comment = commentArg;
  const scope = session.demontage_completed
    ? (session.demontage_scope as { mode?: string; ids?: number[]; summary?: string } | undefined)
    : undefined;
  if (scope) {
    const note = String(session.demontage_note || '').trim();
    try {
      await apiClient.demontageEquipment(
        vkId,
        String(session.point_id || ''),
        scope.mode === 'whole',
        scope.ids || [],
        `Демонтаж${note ? `: ${note}` : ''}`,
      );
    } catch (err) {
      const detail = err instanceof ApiError ? err.detail : String(err);
      await send(peerId, `❌ Не удалось списать оборудование с комплекса: ${detail}\nНажмите «Завершить» ещё раз.`, menuKeyboard(session));
      return;
    }
    const line = scope.summary || '';
    if (line && !comment.includes(line)) {
      comment = (comment ? `${comment}\n` : '') + line;
    }
  }
  try {
    const [removed, installed] = equipmentForReport(session);
    const [simRemoved, simInstalled, simState] = simForReport(session);
    await apiClient.submitVisitReport({
      taskId,
      vkId,
      resultStatus: status,
      comment,
      equipmentRemoved: removed,
      equipmentInstalled: installed,
      simRemoved,
      simInstalled,
      simRemovedState: simState,
      repairMode: Boolean(session.switched_to_repair),
      outcome: outcome ?? null,
      fault: faultForReport(session),
      needs: status === 'Не работает' ? String(session.needs_text || '').trim() || null : null,
    });
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `❌ Не удалось сохранить отчёт: ${detail}`, getBackToMenuKeyboard());
    return;
  }
  const workSessionId = session.work_session_id as number | undefined;
  if (workSessionId) {
    try {
      await apiClient.endWorkSession(workSessionId);
    } catch {
      console.warn(`[bot] Не удалось завершить рабочую сессию ${workSessionId}`);
    }
  }
  if (!session.detached) {
    resetSession(vkId);
  }
  await send(peerId, finalText, getMainMenuKeyboard());
}

// ------------------------------------------------------------------ чат с диспетчером ----

const CHAT_TEXT_MAX = 1500;
const CHAT_WAIT_STEPS = new Set(['awaiting_verification', 'awaiting_demontage_approval']);
const CHAT_HELLO =
  '✉️ Чат с диспетчером. Пишите сообщения и присылайте фото — они уйдут диспетчеру, его ответы придут сюда.\n' +
  'Закончить — «Выйти из чата». Если диспетчер ответит позже, бот пришлёт уведомление. Переписка хранится 7 дней.';

export async function showDispatcherPhone(peerId: number, session?: BotSession | null): Promise<void> {
  let phones: Array<{ full_name: string; phone: string }> = [];
  try {
    phones = await apiClient.getDispatcherPhones();
  } catch {
    phones = [];
  }
  const kb = getDispatcherKeyboard(Boolean(session?.task_id));
  if (!phones.length) {
    await send(peerId, 'Не удалось получить номер диспетчера. Можно написать ему сообщением — кнопка ниже.', kb);
    return;
  }
  const lines = phones.map((p) => `${p.full_name}: ${p.phone}`);
  await send(peerId, `📞 Диспетчер:\n${lines.join('\n')}\n\nИли напишите ему здесь — ответ придёт в этот чат.`, kb);
}

export async function chatOpen(peerId: number, _user: BotUser, session: BotSession): Promise<void> {
  if (session.step === 'chat') {
    await send(peerId, 'Вы уже в чате с диспетчером — просто пишите сообщение.', getChatKeyboard());
    return;
  }
  session.chat_prev_step = session.step;
  session.chat_acked = false;
  session.step = 'chat';
  await send(peerId, CHAT_HELLO, getChatKeyboard());
}

export async function chatPhotos(
  message: VkRawMessage,
  user: BotUser,
  session: BotSession,
  photos: VkPhotoAttachment[],
): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const caption = String(message.text || '').trim().slice(0, CHAT_TEXT_MAX);
  const files: Array<{ name: string; content: Buffer }> = [];
  let failed = 0;
  for (const photo of photos.slice(0, 10)) {
    const sizes = photo.sizes || [];
    if (!sizes.length) {
      failed += 1;
      continue;
    }
    const best = sizes.reduce((a, b) => ((b.width || 0) * (b.height || 0) >= (a.width || 0) * (a.height || 0) ? b : a));
    try {
      const resp = await fetch(best.url, { signal: AbortSignal.timeout(30_000) });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      files.push({ name: `photo_${photo.id}.jpg`, content: Buffer.from(await resp.arrayBuffer()) });
    } catch {
      failed += 1;
    }
  }
  failed += Math.max(0, photos.length - 10);
  if (!files.length) {
    await send(peerId, '⚠️ Не удалось получить фото — отправьте ещё раз.', getChatKeyboard());
    return;
  }
  try {
    await apiClient.chatSendPhotos(user.vk_id, caption, files, session.task_id ?? null, session.point_id ?? null);
  } catch (err) {
    if (err instanceof ApiError) {
      await send(peerId, `⚠️ Фото не отправлено: ${err.detail}. Попробуйте ещё раз.`, getChatKeyboard());
    } else {
      await send(peerId, '⚠️ Сервер сейчас недоступен — фото не отправлено. Попробуйте через минуту.', getChatKeyboard());
    }
    return;
  }
  let note = `✓ Отправил диспетчеру: фото ${files.length}.${failed ? ` Не удалось получить: ${failed}.` : ''}`;
  if (!session.chat_acked) {
    session.chat_acked = true;
    note += ' Ответ придёт сюда.';
  }
  await send(peerId, note, getChatKeyboard());
}

const broadcastPhotoCache = new Map<string, { ts: number; part: string }>();
const BROADCAST_PHOTO_TTL_MS = 3600 * 1000;

async function chatAttachment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  m: Record<string, any>,
  photos: Array<{ id: number; file_id?: number }>,
  fresh = false,
): Promise<[string | null, boolean]> {
  if (!photos.length || !vkClientRef) return [null, false];
  const cacheable = Boolean(m.broadcast);
  let usedCache = false;
  const parts: string[] = [];
  const now = Date.now();
  for (const a of photos.slice(0, 10)) {
    const key = String(a.file_id || a.id);
    const hit = cacheable && !fresh ? broadcastPhotoCache.get(key) : undefined;
    if (hit && now - hit.ts < BROADCAST_PHOTO_TTL_MS) {
      parts.push(hit.part);
      usedCache = true;
      continue;
    }
    const content = await apiClient.chatFile(a.id);
    const part = await vkClientRef.uploadMessagePhoto(Number(m.vk_id), `chat_${a.id}.jpg`, content);
    if (cacheable) {
      if (broadcastPhotoCache.size >= 40) {
        const firstKey = broadcastPhotoCache.keys().next().value;
        if (firstKey !== undefined) broadcastPhotoCache.delete(firstKey);
      }
      broadcastPhotoCache.set(key, { ts: now, part });
    }
    parts.push(part);
  }
  return [parts.join(','), usedCache];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function sendChatMessage(m: Record<string, any>, text: string, keyboard: VkKeyboard, photos: Array<{ id: number; file_id?: number }>): Promise<void> {
  const [attachment, usedCache] = await chatAttachment(m, photos, false);
  try {
    await send(Number(m.vk_id), text, keyboard, attachment);
  } catch (err) {
    if (!usedCache) throw err;
    for (const a of photos.slice(0, 10)) {
      broadcastPhotoCache.delete(String(a.file_id || a.id));
    }
    const [freshAttachment] = await chatAttachment(m, photos, true);
    await send(Number(m.vk_id), text, keyboard, freshAttachment);
  }
}

export async function chatMessage(message: VkRawMessage, user: BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const text = String(message.text || '').trim();
  if (!text) {
    await send(peerId, 'В чат можно писать текст и присылать фото.', getChatKeyboard());
    return;
  }
  try {
    await apiClient.chatSend(user.vk_id, text.slice(0, CHAT_TEXT_MAX), session.task_id ?? null, session.point_id ?? null);
  } catch (err) {
    if (err instanceof ApiError) {
      await send(peerId, `⚠️ Сообщение не отправлено: ${err.detail}. Напишите ещё раз.`, getChatKeyboard());
    } else {
      await send(peerId, '⚠️ Сервер сейчас недоступен — сообщение не отправлено. Попробуйте через минуту.', getChatKeyboard());
    }
    return;
  }
  if (!session.chat_acked) {
    session.chat_acked = true;
    await send(peerId, '✓ Отправил диспетчеру. Ответ придёт сюда.', getChatKeyboard());
  }
}

export async function chatExit(peerId: number, _user: BotUser, session: BotSession): Promise<void> {
  const prev = session.chat_prev_step as string | undefined;
  delete session.chat_prev_step;
  delete session.chat_acked;
  if (session.step === 'chat') session.step = null;
  if (!session.task_id) {
    session.step = null;
    await send(peerId, 'Вышли из чата. Если диспетчер ответит, бот пришлёт уведомление.', getMainMenuKeyboard());
    return;
  }
  if (prev && CHAT_WAIT_STEPS.has(prev) && session.pending) {
    session.step = prev;
    await send(peerId, 'Вышли из чата. Если диспетчер ответит, бот пришлёт уведомление.');
    await reshowWait(peerId, session);
    return;
  }
  session.step = 'menu';
  await send(peerId, 'Вышли из чата. Если диспетчер ответит, бот пришлёт уведомление.', menuKeyboard(session));
}

export async function deliverChatMessages(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let items: Array<Record<string, any>>;
  try {
    items = await apiClient.chatClaim();
  } catch {
    return 0;
  }
  if (!items.length) return 0;
  const delivered: number[] = [];
  for (const m of items) {
    const inChat = getSession(Number(m.vk_id)).step === 'chat';
    let head = inChat ? '💬 Диспетчер:' : '💬 Сообщение от диспетчера:';
    if (m.broadcast) head = '📢 Объявление от диспетчера:';
    const photos = (m.attachments || []) as Array<{ id: number; file_id?: number }>;
    const text = m.text ? `${head}\n${m.text}` : photos.length ? `${head}\n📷 Фото: ${photos.length}` : head;
    try {
      await sendChatMessage(m, text, inChat ? getChatKeyboard() : getChatNoticeKeyboard(), photos);
      delivered.push(Number(m.id));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[bot] Чат: не удалось отправить сообщение ${m.id} монтёру ${m.vk_id}: ${msg}`);
      try {
        await apiClient.chatFailed(Number(m.id), msg.slice(0, 200));
      } catch {
        // ignore
      }
    }
  }
  try {
    await apiClient.chatDelivered(delivered);
  } catch (err) {
    console.warn('[bot] Чат: не удалось отметить доставленные:', err instanceof Error ? err.message : err);
  }
  return delivered.length;
}

// ------------------------------------------------------------------ отчёт и черновики ----

export async function repairRequestReport(peerId: number, session: BotSession): Promise<void> {
  session.step = 'menu';
  const current = String(session.report_text || '').trim();
  const chunks = (session.report_chunks || []) as string[];
  const canUndoLast = Boolean(current && chunks.length && chunks[chunks.length - 1] !== current && current.endsWith(chunks[chunks.length - 1]));
  if (!current) {
    await send(
      peerId,
      '📝 Итога работ пока нет. Просто напишите его обычным сообщением — приму без кнопок ' +
        '(можно в несколько сообщений: они дописываются друг за другом).',
      getReportPanelKeyboard(false, false),
    );
    return;
  }
  const shown = current.length <= 900 ? current : `${current.slice(0, 900)}…`;
  await send(
    peerId,
    `📝 Итог работ:\n«${shown}»\n\nДописать — просто пришлите ещё текст. Поправить — кнопки ниже.`,
    getReportPanelKeyboard(true, canUndoLast),
  );
}

export async function reportRemove(peerId: number, session: BotSession, scope: 'last' | 'all'): Promise<void> {
  const current = String(session.report_text || '').trim();
  const chunks = (session.report_chunks || []) as string[];
  session.step = 'menu';
  let text: string;
  if (scope === 'last' && chunks.length && current.endsWith(chunks[chunks.length - 1]) && chunks[chunks.length - 1] !== current) {
    const last = chunks.pop()!;
    session.report_text = current.slice(0, current.length - last.length).replace(/\n+$/, '').trim() || null;
    text = `↩ Убрал последнее добавленное. Итог работ теперь:\n«${session.report_text || ''}»`;
  } else {
    session.report_text = null;
    session.report_chunks = [];
    text = '🗑 Итог работ убран. Напишите новый — просто сообщением.';
  }
  await send(peerId, text, menuKeyboard(session));
}

export async function reportEdit(peerId: number, session: BotSession): Promise<void> {
  const current = String(session.report_text || '').trim();
  await beginDraft(
    peerId,
    session,
    'report',
    '📝 Напишите текст итога работ целиком — он заменит прежний.',
    current || null,
    '📝 Итог работ сейчас такой:',
  );
}

interface DraftState {
  kind: string;
  prompt: string;
  value: string | null;
  existing: string | null;
  title: string;
  payload: Record<string, unknown>;
  stage: 'choose' | 'input' | 'confirm';
}

export async function beginDraft(
  peerId: number,
  session: BotSession,
  kind: string,
  prompt: string,
  existing: string | null = null,
  existingTitle = '',
  payload: Record<string, unknown> = {},
): Promise<void> {
  const draft: DraftState = {
    kind,
    prompt,
    value: null,
    existing,
    title: existingTitle,
    payload,
    stage: existing ? 'choose' : 'input',
  };
  session.draft = draft;
  session.step = 'awaiting_text';
  if (existing) {
    await send(peerId, `${existingTitle}\n«${existing}»\n\nОставить прежний или изменить?`, getDraftKeepKeyboard());
    return;
  }
  await send(peerId, prompt, getDraftInputKeyboard());
}

function normalizeDraft(kind: string, raw: string): string {
  const trimmed = String(raw || '').trim();
  if (kind === 'sim' || kind === 'new_sim' || kind === 'sim_fix') {
    return trimmed.replace(/\s+/g, '');
  }
  return trimmed;
}

function draftEmptyHint(kind: string): string {
  const hints: Record<string, string> = {
    report: 'Текст отчёта не может быть пустым.',
    sim: 'Введите номер SIM-карты (без пробелов).',
    new_sim: 'Введите номер новой SIM-карты (без пробелов).',
    sim_fix: 'Введите правильный номер SIM-карты (без пробелов).',
    dem_other: 'Напишите, что ещё снято, или отправьте «-», если больше ничего.',
    fault: 'Напишите, что именно неисправно.',
    needs: 'Напишите, что нужно для исправления.',
    shot: 'Опишите, что расстреляно (например: камера, радар, шкаф, антенна). Если отметили по ошибке — отправьте «-».',
  };
  return hints[kind] || 'Отправьте «-», если ничего.';
}

function draftPreview(draft: DraftState): string {
  const { kind, value } = draft;
  if (kind === 'report') return `📝 Текст отчёта:\n«${value}»\n\nСохранить? Или просто напишите текст заново.`;
  if (kind === 'new_sim') {
    const current = String(draft.payload?.current || 'не указана');
    return `💳 Новая SIM: ${value}\n(сейчас на комплексе: ${current})\n\nСохранить? Или введите другой номер.`;
  }
  if (kind === 'sim') return `💳 Номер SIM комплекса: ${value}\n\nСохранить? Или введите другой номер.`;
  if (kind === 'sim_fix') {
    const current = String(draft.payload?.current || 'не указана');
    return (
      `✏️ Исправление номера SIM: было ${current} → станет ${value}\n` +
      'Это исправление ошибки в записи (SIM не меняли), в отчёт как замена оборудования не попадёт.\n\n' +
      'Сохранить? Или введите другой номер.'
    );
  }
  if (kind === 'dem_other') return `🧰 Ещё снято (нет в списке оборудования): «${value}»\n\nСохранить? Или напишите заново.`;
  if (kind === 'fault') return `⚠️ Что неисправно:\n«${value}»\n\nСохранить? Или просто напишите заново.`;
  if (kind === 'needs') return `📦 Что нужно для исправления:\n«${value}»\n\nСохранить? Или просто напишите заново.`;
  if (kind === 'shot') {
    return value === '-'
      ? '💥 Снять отметку «комплекс расстрелян»?\n\nСохранить? Или напишите, что расстреляно.'
      : `💥 Комплекс расстрелян. Что расстреляно:\n«${value}»\n\nСохранить? Или просто напишите заново.`;
  }
  const label = kind === 'eq_installed' ? 'Установили' : 'Сняли';
  const shown = value === '-' ? 'ничего' : `«${value}»`;
  return `🔧 ${label}: ${shown}\n\nСохранить? Или напишите заново.`;
}

export async function handleDraftText(message: VkRawMessage, _user: BotUser, session: BotSession): Promise<void> {
  const draft = session.draft as DraftState | undefined;
  const peerId = Number(session.peer_id ?? message.peer_id);
  if (!draft) {
    session.step = session.task_id ? 'menu' : null;
    await send(peerId, 'Сейчас ничего вводить не нужно.', session.task_id ? menuKeyboard(session) : undefined);
    return;
  }
  const value = normalizeDraft(draft.kind, String(message.text || ''));
  if (!value) {
    await send(
      peerId,
      draftEmptyHint(draft.kind),
      draft.stage !== 'confirm' ? getDraftInputKeyboard() : getDraftConfirmKeyboard(),
    );
    return;
  }
  draft.value = value;
  draft.stage = 'confirm';
  await send(peerId, draftPreview(draft), getDraftConfirmKeyboard());
}

export async function draftEdit(peerId: number, session: BotSession): Promise<void> {
  const draft = session.draft as DraftState | undefined;
  if (!draft) return;
  draft.stage = 'input';
  await send(peerId, draft.prompt, getDraftInputKeyboard());
}

export async function draftKeep(peerId: number, session: BotSession, user?: BotUser | null): Promise<void> {
  const kind = (session.draft as DraftState | undefined)?.kind;
  session.draft = null;
  session.step = 'menu';
  if (kind === 'fault' && user) {
    await askNeeds(peerId, session);
    return;
  }
  if (kind === 'needs' && user) {
    await afterFault(peerId, user, session);
    return;
  }
  const pendingAction = session.pending_action;
  delete session.pending_action;
  if (pendingAction === 'release_request' && user) {
    await releaseAfterReport(peerId, user, session);
    return;
  }
  await send(peerId, '👌 Оставил прежний текст.', menuKeyboard(session));
}

export async function draftCancel(peerId: number, session: BotSession): Promise<void> {
  const draft = (session.draft || {}) as Partial<DraftState>;
  const kind = draft.kind;
  session.draft = null;
  session.step = 'menu';
  delete session._eq_installed_tmp;
  const pendingRelease = session.pending_action === 'release_request';
  delete session.pending_action;

  let text: string;
  if (kind === 'report') {
    text = String(session.report_text || '').trim()
      ? '❌ Отменено — отчёт остался как был.'
      : '❌ Отменено — отчёт не сохранён.';
    if (pendingRelease) text += ' Запрос диспетчеру не отправлен.';
  } else if (kind === 'sim' || kind === 'new_sim' || kind === 'sim_fix') {
    delete session.finish_after_check;
    text = '❌ Отменено — номер SIM не менялся.';
  } else if (kind === 'dem_other') {
    text = '❌ Отменено.';
  } else if (kind === 'shot') {
    text = '❌ Отменено — отметка «расстрелян» осталась как была.';
  } else if (kind === 'fault' || kind === 'needs') {
    const afterFaultCtx = session.after_fault as { op?: string } | undefined;
    delete session.after_fault;
    text =
      afterFaultCtx?.op === 'release'
        ? '❌ Отменено — запрос диспетчеру не отправлен.'
        : '❌ Отменено — отчёт пока не отправлен. Когда будете готовы, нажмите «Завершить» ещё раз.';
  } else {
    text = '❌ Отменено — замена оборудования не сохранена.';
  }
  await send(peerId, text, menuKeyboard(session));
}

export async function draftSave(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  const draft = session.draft as DraftState | undefined;
  if (!draft || draft.value === null) {
    await send(peerId, 'Сначала введите значение — или нажмите «Отмена».', getDraftInputKeyboard());
    return;
  }
  session.draft = null;
  const val = draft.value;
  switch (draft.kind) {
    case 'report':
      await commitReport(peerId, user, session, val);
      return;
    case 'sim':
      await commitSim(peerId, user, session, val, draft);
      return;
    case 'new_sim':
      await commitNewSim(peerId, user, session, val, draft);
      return;
    case 'sim_fix':
      await commitSimFix(peerId, user, session, val);
      return;
    case 'eq_installed':
      await commitEqInstalled(peerId, session, val);
      return;
    case 'eq_removed':
      await commitEqRemoved(peerId, session, val);
      return;
    case 'dem_other': {
      const { setDemOther } = await import('./equipment.ts');
      await setDemOther(peerId, user, session, val);
      return;
    }
    case 'fault':
      await commitFault(peerId, session, val);
      return;
    case 'needs':
      await commitNeeds(peerId, user, session, val);
      return;
    case 'shot':
      await commitShot(peerId, user, session, val);
      return;
    default:
      session.step = 'menu';
      await send(peerId, 'Готово.', menuKeyboard(session));
  }
}

async function retryDraft(peerId: number, session: BotSession, draft: DraftState, error: string): Promise<void> {
  session.draft = draft;
  session.step = 'awaiting_text';
  await send(peerId, `❌ ${error}\nНажмите «Сохранить», чтобы повторить, или «Отмена».`, getDraftConfirmKeyboard());
}

async function commitReport(peerId: number, user: BotUser, session: BotSession, value: string): Promise<void> {
  session.report_text = value;
  session.report_chunks = [];
  session.step = 'menu';
  const pendingAction = session.pending_action;
  delete session.pending_action;
  if (pendingAction === 'release_request') {
    await releaseAfterReport(peerId, user, session);
    return;
  }
  await send(peerId, '✅ Отчёт сохранён.', menuKeyboard(session));
}

// ------------------------------------------------------------------ «Не работает»: неисправность и что нужно ----

const FAULT_PROMPT =
  '⚠️ Что именно неисправно на комплексе? Опишите отдельно от отчёта — конкретно ' +
  '(например: «не работает камера, сгорел блок питания, нет связи по SIM»).';
const NEEDS_PROMPT = '📦 Что нужно для исправления? Запчасти, оборудование, инструмент, доступ — одним сообщением.';

async function askFault(peerId: number, session: BotSession): Promise<void> {
  const current = String(session.fault_text || '').trim();
  await beginDraft(peerId, session, 'fault', FAULT_PROMPT, current || null, '⚠️ Уже записано, что неисправно:');
}

async function askNeeds(peerId: number, session: BotSession): Promise<void> {
  const current = String(session.needs_text || '').trim();
  await beginDraft(peerId, session, 'needs', NEEDS_PROMPT, current || null, '📦 Уже записано, что нужно для исправления:');
}

async function ensureFaultInfo(peerId: number, session: BotSession, cont: Record<string, unknown>): Promise<boolean> {
  session.after_fault = cont;
  if (shotCoversFault(session)) {
    await askNeeds(peerId, session);
  } else {
    await askFault(peerId, session);
  }
  return false;
}

async function commitFault(peerId: number, session: BotSession, value: string): Promise<void> {
  session.fault_text = value;
  await askNeeds(peerId, session);
}

async function commitNeeds(peerId: number, user: BotUser, session: BotSession, value: string): Promise<void> {
  session.needs_text = value;
  await afterFault(peerId, user, session);
}

async function afterFault(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  const cont = (session.after_fault || {}) as {
    op?: string;
    status?: string;
    comment?: string;
    final_text?: string;
    outcome?: string;
  };
  if (cont.op === 'finish' || cont.op === 'release') {
    if (!String(session.fault_text || '').trim() && !shotCoversFault(session)) {
      await askFault(peerId, session);
      return;
    }
    if (!String(session.needs_text || '').trim()) {
      await askNeeds(peerId, session);
      return;
    }
  }
  delete session.after_fault;
  session.step = 'menu';
  if (cont.op === 'finish') {
    await submitAndFinish(
      peerId,
      user,
      session,
      cont.status || 'Не работает',
      cont.comment || String(session.report_text || ''),
      cont.final_text || '✅ Отчёт сохранён. Хорошего дня!',
      cont.outcome,
    );
  } else if (cont.op === 'release') {
    await requestNoAccessDecision(peerId, user, session, 'release');
  } else {
    await send(peerId, '✅ Записано.', menuKeyboard(session));
  }
}

async function releaseAfterReport(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  if (await ensureFaultInfo(peerId, session, { op: 'release' })) {
    await requestNoAccessDecision(peerId, user, session, 'release');
  }
}

async function commitEqInstalled(peerId: number, session: BotSession, value: string): Promise<void> {
  session._eq_installed_tmp = value === '-' ? null : value;
  await beginDraft(peerId, session, 'eq_removed', 'Что сняли? Если ничего — отправьте «-».');
}

async function commitEqRemoved(peerId: number, session: BotSession, value: string): Promise<void> {
  session.equipment_installed = session._eq_installed_tmp ?? null;
  delete session._eq_installed_tmp;
  session.equipment_removed = value === '-' ? null : value;
  session.step = 'menu';
  await send(peerId, '✅ Замена оборудования сохранена.', menuKeyboard(session));
}

async function commitSim(peerId: number, user: BotUser, session: BotSession, value: string, draft: DraftState): Promise<void> {
  try {
    await apiClient.setPointSim(String(session.point_id), value);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await retryDraft(peerId, session, draft, `Не удалось сохранить номер SIM: ${detail}`);
    return;
  }
  session.sim_asked = true;
  session.step = 'menu';
  await send(peerId, 'Номер SIM сохранён, проверяю доступность…');
  await runAvailabilityCheck(peerId, user, session);
}

async function commitNewSim(peerId: number, user: BotUser, session: BotSession, value: string, draft: DraftState): Promise<void> {
  const task = session.tasks?.[session.task_id];
  const old = String(draft.payload?.current || task?.point_sim || '');
  if (old) {
    session.reason_ctx = { op: 'sim_replace', new: value, old };
    session.step = 'awaiting_sim_state';
    await send(peerId, `💳 Заменяем SIM ${old} → ${value}.\nСнятая SIM (№${old}) рабочая?`, getSimStateKeyboard());
    return;
  }
  await doSimReplace(peerId, user, session, value, old, null, null);
}

export async function pickSimState(peerId: number, user: BotUser, session: BotSession, working: boolean): Promise<void> {
  const ctx = (session.reason_ctx || {}) as { op?: string; new?: string; old?: string };
  if (session.step !== 'awaiting_sim_state' || ctx.op !== 'sim_replace') return;
  const nextCtx = { ...ctx, working: Boolean(working) };
  if (working) {
    delete session.reason_ctx;
    session.step = 'menu';
    await doSimReplace(peerId, user, session, nextCtx.new || '', nextCtx.old || '', null, true);
    return;
  }
  await askRemovalReason(peerId, session, nextCtx, `💳 Снятая SIM №${nextCtx.old} нерабочая.`);
}

export async function simStateCancel(peerId: number, session: BotSession): Promise<void> {
  delete session.reason_ctx;
  session.step = 'menu';
  await send(peerId, '❌ Отменено — SIM не менялась.', menuKeyboard(session));
}

async function doSimReplace(
  peerId: number,
  user: BotUser,
  session: BotSession,
  value: string,
  old: string,
  reason: string | null,
  working: boolean | null = null,
): Promise<void> {
  const task = session.tasks?.[session.task_id];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: Record<string, any>;
  try {
    res = await apiClient.simReplace(user.vk_id, String(session.point_id), value, reason, working);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    session.step = 'menu';
    await send(peerId, `❌ Не удалось заменить SIM: ${detail}`, menuKeyboard(session));
    return;
  }
  const installed = String(res.installed || value);
  const removed = String((res.removed && res.removed[0]) || old || '');
  const previous = (session.sim_change || {}) as { old?: string; reason?: string; old_state?: string };
  const oldState = !previous.old
    ? working === true
      ? 'working'
      : working === false
        ? 'defective'
        : ''
    : previous.old_state || '';
  session.sim_change = {
    old: previous.old || removed || '',
    new: installed,
    reason: reason || previous.reason || '',
    old_state: oldState,
  };
  if (task) task.point_sim = installed;
  session.sim_asked = true;
  session.step = 'menu';

  const lines = [`💳 SIM заменена: ${removed || 'не была указана'} → ${installed}.`];
  if (removed && working) {
    lines.push('Снятая SIM рабочая — осталась у вас: сдавать на склад не обязательно, можно поставить её снова.');
  } else if (removed) {
    lines.push(
      `${reason ? `Причина снятия: ${reason}. ` : ''}Снятая SIM осталась у вас (в списке «Моё оборудование») — сдавать на склад не обязательно.`,
    );
  }
  if (res.created) lines.push('Новой SIM не было в базе — записал её.');
  if (res.ip_known) {
    lines.push(`IP комплекса обновлён из реестра SIM↔IP: ${res.ip_address}.`);
  } else {
    lines.push('Новой SIM пока нет в реестре SIM↔IP — IP комплекса остался прежним; его обновит загрузка реестра (сообщите диспетчеру).');
  }
  lines.push('Проверяю доступность…');
  await send(peerId, lines.join('\n'));
  await runAvailabilityCheck(peerId, user, session);
}

async function commitSimFix(peerId: number, user: BotUser, session: BotSession, value: string): Promise<void> {
  const task = session.tasks?.[session.task_id];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let res: Record<string, any>;
  try {
    res = await apiClient.simFix(user.vk_id, String(session.point_id), value);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    session.step = 'menu';
    await send(peerId, `❌ Не удалось исправить номер SIM: ${detail}`, menuKeyboard(session));
    return;
  }
  const installed = String(res.installed || value);
  const change = session.sim_change as { old?: string; new?: string; reason?: string; old_state?: string } | undefined;
  if (change && change.new === res.old) {
    session.sim_change = { ...change, new: installed };
  }
  if (task) task.point_sim = installed;
  session.sim_asked = true;
  session.step = 'menu';
  const lines = [
    `✏️ Номер SIM исправлен: ${res.old || 'не был указан'} → ${installed}.`,
    res.ip_known
      ? `IP комплекса обновлён из реестра SIM↔IP: ${res.ip_address}.`
      : 'Этой SIM пока нет в реестре SIM↔IP — IP комплекса остался прежним.',
    'Проверяю доступность…',
  ];
  await send(peerId, lines.join('\n'));
  await runAvailabilityCheck(peerId, user, session);
}

export async function requestSimFix(peerId: number, session: BotSession): Promise<void> {
  const task = session.tasks?.[session.task_id];
  let current = String(task?.point_sim || '');
  if (!current) {
    try {
      const pt = await apiClient.getPoint(String(session.point_id));
      current = String(pt.sim_number || '');
    } catch {
      current = '';
    }
  }
  await beginDraft(
    peerId,
    session,
    'sim_fix',
    `✏️ Сейчас на комплексе указана SIM: ${current || 'не указана'}.\n` +
      'Введите правильный номер (без пробелов) — это исправление ошибки, а не замена.',
    null,
    '',
    { current },
  );
}

// ------------------------------------------------------------------ причина снятия оборудования ----

export async function askRemovalReason(peerId: number, session: BotSession, ctx: Record<string, unknown>, title = ''): Promise<void> {
  session.reason_ctx = { ...ctx };
  session.step = 'awaiting_reason';
  const head = title ? `${title}\n` : '';
  await send(peerId, `${head}Почему снимаете? Выберите причину кнопкой или напишите, какая проблема:`, getReasonKeyboard());
}

export async function pickReason(peerId: number, user: BotUser, session: BotSession, index: number): Promise<void> {
  if (session.step !== 'awaiting_reason' || index < 0 || index >= REMOVAL_REASONS.length) return;
  await reasonGiven(peerId, user, session, REMOVAL_REASONS[index]);
}

export async function handleReasonText(message: VkRawMessage, user: BotUser, session: BotSession): Promise<void> {
  const peerId = Number(session.peer_id ?? message.peer_id);
  const reason = String(message.text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
  if (!reason) {
    await send(peerId, 'Напишите причину словами или выберите кнопкой.', getReasonKeyboard());
    return;
  }
  await reasonGiven(peerId, user, session, reason);
}

async function reasonGiven(peerId: number, user: BotUser, session: BotSession, reason: string): Promise<void> {
  const ctx = (session.reason_ctx || {}) as { op?: string; new?: string; old?: string; working?: boolean };
  session.reason_ctx = { ...ctx, reason };
  session.step = 'menu';
  if (ctx.op === 'sim_replace') {
    delete session.reason_ctx;
    await doSimReplace(peerId, user, session, ctx.new || '', ctx.old || '', reason, ctx.working ?? null);
  } else if (ctx.op === 'eq_replace' || ctx.op === 'eq_remove') {
    const eqSvc = await import('./equipment.ts');
    await eqSvc.reasonGiven(peerId, user, session, reason);
  } else {
    delete session.reason_ctx;
    await send(peerId, 'Причина записана.', menuKeyboard(session));
  }
}

export async function reasonCancel(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  const ctx = (session.reason_ctx || {}) as { op?: string };
  delete session.reason_ctx;
  session.step = 'menu';
  if (ctx.op === 'eq_replace' || ctx.op === 'eq_remove') {
    const eqSvc = await import('./equipment.ts');
    await eqSvc.showCatalog(peerId, user, session);
    return;
  }
  await send(peerId, '❌ Отменено — ничего не изменено.', menuKeyboard(session));
}

export async function reshowWait(peerId: number, session: BotSession): Promise<void> {
  const step = session.step as string | undefined;
  if (step === 'awaiting_photos') {
    await send(peerId, photosPrompt(session), getPhotosKeyboard());
  } else if (step === 'awaiting_text') {
    const draft = (session.draft || {}) as Partial<DraftState>;
    if (draft.stage === 'choose') {
      await send(peerId, `${draft.title}\n«${draft.existing}»\n\nОставить прежний или изменить?`, getDraftKeepKeyboard());
    } else if (draft.stage === 'confirm') {
      await send(peerId, draftPreview(draft as DraftState), getDraftConfirmKeyboard());
    } else {
      await send(peerId, draft.prompt || 'Введите значение.', getDraftInputKeyboard());
    }
  } else if (step === 'awaiting_verification' || step === 'awaiting_demontage_approval') {
    await send(peerId, '⏳ Ждём ответ диспетчера — он придёт сюда. Можно позвонить или выйти с комплекса.', getWaitingKeyboard());
  } else if (step === 'awaiting_power_source') {
    await send(peerId, '⚡ Чем запитан комплекс?', getPowerSourceKeyboard());
  } else if (step === 'awaiting_result') {
    const outcomes = (session.type_outcomes || []) as string[];
    if (outcomes.length) {
      await send(peerId, 'Выберите статус выезда:', getOutcomeKeyboard(outcomes));
    } else {
      await send(peerId, 'Выберите итоговый статус комплекса:', getResultStatusKeyboard());
    }
  } else if (step === 'awaiting_sim_confirm') {
    await send(peerId, 'Это правильный номер SIM? Ответьте кнопками.', getSimConfirmKeyboard());
  } else if (step === 'awaiting_reason') {
    await send(peerId, 'Почему снимаете? Выберите причину кнопкой или напишите, какая проблема:', getReasonKeyboard());
  } else if (step === 'awaiting_sim_state') {
    const ctx = (session.reason_ctx || {}) as { old?: string };
    await send(peerId, `Снятая SIM (№${ctx.old || '—'}) рабочая?`, getSimStateKeyboard());
  } else if (step === 'chat') {
    await send(peerId, 'Вы в чате с диспетчером — пишите сообщение или нажмите «Выйти из чата».', getChatKeyboard());
  }
}

// ------------------------------------------------------------------ ремонт / расстрелян / SIM / проверка ----

export async function repairRequestEquipment(peerId: number, session: BotSession): Promise<void> {
  session.step = 'menu';
  const shot = String(session.shot_text || '').trim();
  await send(
    peerId,
    `Что заменили?${shot ? `\n\n💥 Отмечено: комплекс расстрелян — ${shot}` : ''}`,
    getEquipmentMenuKeyboard(),
  );
}

export async function repairRequestShot(peerId: number, session: BotSession): Promise<void> {
  await beginDraft(
    peerId,
    session,
    'shot',
    '💥 Опишите, что расстреляно (например: камера, радар, шкаф, антенна). Если отметили по ошибке — отправьте «-».',
    String(session.shot_text || '').trim() || null,
    '💥 Уже отмечено: комплекс расстрелян. Что расстреляно:',
  );
}

async function commitShot(peerId: number, user: BotUser, session: BotSession, value: string): Promise<void> {
  session.step = 'menu';
  if (value.trim() === '-') {
    session.shot_text = null;
    await send(peerId, '✅ Отметка «расстрелян» снята.', menuKeyboard(session));
    return;
  }
  session.shot_text = value;
  const pick = session.finish_reason_pick;
  delete session.finish_reason_pick;
  if (pick) {
    await send(peerId, `✅ Записано: комплекс расстрелян — ${value}\nЗавершаю с итогом «Не работает».`);
    await repairFinish(peerId, user, session);
    return;
  }
  await send(
    peerId,
    `✅ Записано: комплекс расстрелян — ${value}\nЭто попадёт в отчёт («что неисправно») и в карточку комплекса — диспетчер увидит.`,
    menuKeyboard(session),
  );
}

function shotCoversFault(session: BotSession): boolean {
  return Boolean(String(session.shot_text || '').trim()) && !String(session.fault_text || '').trim();
}

function faultForReport(session: BotSession): string | null {
  const fault = String(session.fault_text || '').trim();
  const shot = String(session.shot_text || '')
    .trim()
    .replace(/[\s.;,]+$/, '');
  if (shot) {
    const line = `💥 Расстрелян: ${shot}`;
    return fault ? `${line}. ${fault}` : line;
  }
  return fault || null;
}

export async function repairRequestEquipmentOther(peerId: number, session: BotSession): Promise<void> {
  await beginDraft(peerId, session, 'eq_installed', 'Что установили? Если ничего — отправьте «-».');
}

export async function requestSimChange(peerId: number, session: BotSession): Promise<void> {
  const task = session.tasks?.[session.task_id];
  let current = String(task?.point_sim || '');
  if (!current) {
    try {
      const pt = await apiClient.getPoint(String(session.point_id));
      current = String(pt.sim_number || '');
    } catch {
      current = '';
    }
  }
  await beginDraft(
    peerId,
    session,
    'new_sim',
    `💳 Сейчас на комплексе указана SIM: ${current || 'не указана'}.\nВведите номер новой SIM-карты (без пробелов). ` +
      'Если ставите SIM, которая числится на вас, — введите её номер.',
    null,
    '',
    { current },
  );
}

export async function repairSetPowerStatus(
  peerId: number,
  session: BotSession,
  kind: string,
  user?: BotUser | null,
): Promise<void> {
  const statusName = POWER_STATUSES[kind];
  if (!statusName) return;
  try {
    await apiClient.setPointPowerStatus(String(session.point_id), statusName);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `❌ Не удалось сохранить статус: ${detail}`, menuKeyboard(session));
    return;
  }
  session.power_status = statusName;
  const pick = session.finish_reason_pick;
  delete session.finish_reason_pick;
  if (pick && user) {
    await send(peerId, `⚡ Причина отмечена: «${statusName}». Завершаю с итогом «Не работает».`);
    await repairFinish(peerId, user, session);
    return;
  }
  await send(
    peerId,
    kind === 'no_power'
      ? `⚡ Статус комплекса: «${statusName}». Система продолжит проверять связь — если появится, статус обновится сам.`
      : `⚡ Статус комплекса: «${statusName}».`,
    menuKeyboard(session),
  );
}

export async function repairCheckAvailability(
  peerId: number,
  user: BotUser,
  session: BotSession,
  fromFinish = false,
): Promise<void> {
  if (fromFinish) {
    session.finish_after_check = true;
  } else {
    delete session.finish_after_check;
  }
  const pointId = String(session.point_id);
  let point: Record<string, unknown> = {};
  try {
    point = await apiClient.getPoint(pointId);
  } catch {
    point = {};
  }
  if (!String(point.sim_number || '').trim()) {
    await beginDraft(peerId, session, 'sim', 'Укажите номер SIM-карты комплекса (без пробелов).');
    return;
  }
  await runAvailabilityCheck(peerId, user, session);
}

export async function runAvailabilityCheck(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  const pointId = String(session.point_id);
  let result: { status: string };
  try {
    result = await apiClient.recheckPoint(pointId);
  } catch (err) {
    delete session.finish_after_check;
    session.step = 'menu';
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `⚠️ Не удалось проверить доступность: ${detail}. Попробуйте ещё раз через минуту.`, menuKeyboard(session));
    return;
  }

  const status = result.status || '';
  const finishing = Boolean(session.finish_after_check);

  if (status === STATUS_WORKING) {
    delete session.finish_after_check;
    session.no_access = false;
    if (!session.repair_mode) {
      session.step = 'menu';
      await send(peerId, '✅ Комплекс доступен: пинг и порт отвечают. Проверка диспетчером не требуется.', menuKeyboard(session));
      return;
    }
    await requestOperatorCheck(peerId, user, session);
    return;
  }

  if (status === STATUS_PING_ONLY) {
    delete session.finish_after_check;
    session.sim_asked = true;
    session.no_access = false;
    session.step = 'menu';
    if (finishing) {
      await send(
        peerId,
        '📡 Есть пинг, но веб-интерфейс не отвечает — комплекс в сети, значит неисправность на месте. ' +
          'Можно проверить оборудование, кабели и питание и запустить проверку снова — либо всё равно завершить работу ' +
          '(отметите причину, напишете итоги и что неисправно; итог будет «Не работает»).',
        getNoAccessDecisionKeyboard(),
      );
      return;
    }
    await send(
      peerId,
      '📡 Есть только пинг — комплекс в сети, но веб-интерфейс не отвечает. ' +
        'Проверьте оборудование/кабель на месте. Если не разберётесь — позвоните диспетчеру.',
      menuKeyboard(session),
    );
    return;
  }

  if (!session.sim_asked) {
    let point: Record<string, unknown> = {};
    try {
      point = await apiClient.getPoint(pointId);
    } catch {
      point = {};
    }
    const currentSim = String(point.sim_number || '').trim();
    if (currentSim) {
      session.step = 'awaiting_sim_confirm';
      await send(
        peerId,
        `⛔ Доступа нет. Сейчас на комплексе указана SIM: ${currentSim}. Это правильный номер?`,
        getSimConfirmKeyboard(),
      );
    } else {
      await beginDraft(peerId, session, 'sim', '⛔ Доступа нет. Укажите номер SIM-карты комплекса (без пробелов).');
    }
    return;
  }

  await markNoAccess(peerId, session);
}

async function markNoAccess(peerId: number, session: BotSession): Promise<void> {
  session.step = 'menu';
  session.no_access = true;
  const fromFinish = session.finish_after_check;
  delete session.finish_after_check;
  if (fromFinish) {
    await send(peerId, '⛔ Доступа нет: комплекс не отвечает ни по пингу, ни по порту.');
    await repairOfferRelease(peerId, session);
    return;
  }
  await send(peerId, '⛔ Доступа нет.', menuKeyboard(session));
}

export async function handleSimConfirm(peerId: number, session: BotSession, correct: boolean): Promise<void> {
  if (session.step !== 'awaiting_sim_confirm') return;
  if (correct) {
    session.sim_asked = true;
    await markNoAccess(peerId, session);
  } else {
    await beginDraft(peerId, session, 'sim', 'Введите номер SIM без пробелов.');
  }
}

async function requestOperatorCheck(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  let req: { id: number };
  try {
    req = await apiClient.createVerificationRequest(String(session.task_id));
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `⚠️ Не удалось отправить на проверку оператору: ${detail}. Попробуйте ещё раз позже.`, menuKeyboard(session));
    session.step = 'menu';
    return;
  }
  session.step = 'awaiting_verification';
  session.pending = { kind: 'verification', id: req.id };
  await send(
    peerId,
    '📡 Пинг/порт отвечают. Отправил на финальную проверку оператору — подождите, ответ придёт сюда. ' +
      'Можно и выйти с комплекса: ответ всё равно придёт.',
    getWaitingKeyboard(),
  );
  spawnPoller(`v:${req.id}`, () => pollVerificationRequest(peerId, user, String(session.task_id), req.id));
}

async function pollVerificationRequest(peerId: number, user: BotUser, taskId: string, requestId: number): Promise<void> {
  for (let i = 0; i < 120; i++) {
    await sleep(5000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let req: Record<string, any>;
    try {
      req = await apiClient.getVerificationRequest(requestId);
    } catch {
      continue;
    }
    if (req.status === 'pending') continue;
    await applyVerificationResult(peerId, user, taskId, req);
    return;
  }
  await pendingTimeout(
    peerId,
    user,
    taskId,
    requestId,
    '⏳ Проверка оператором затянулась. Статус можно будет увидеть позже — напишите диспетчеру, если срочно.',
  );
}

async function pendingTimeout(peerId: number, user: BotUser, taskId: string, requestId: number, text: string): Promise<void> {
  const s = liveSession(user.vk_id, taskId) || (await detachedSession(user, taskId));
  if (!s || (s.pending as { id?: number } | null)?.id !== requestId) return;
  s.pending = null;
  if (
    !s.detached &&
    (s.step === 'awaiting_verification' ||
      s.step === 'awaiting_demontage_approval' ||
      s.chat_prev_step === 'awaiting_verification' ||
      s.chat_prev_step === 'awaiting_demontage_approval')
  ) {
    liveStep(s);
    await send(peerId, text, liveKb(s));
  } else {
    await send(peerId, `ℹ️ По комплексу «${s.point_id || '—'}»: ${text}`);
  }
  await persistProgress(s);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyVerificationResult(peerId: number, user: BotUser, taskId: string, request: Record<string, any>): Promise<void> {
  const s = liveSession(user.vk_id, taskId) || (await detachedSession(user, taskId));
  if (!s || (s.pending as { id?: number } | null)?.id !== request.id) return;
  const live = !s.detached;
  const point = String(s.point_id || 'комплексу');
  s.pending = null;
  if (request.status === 'confirmed') {
    s.check_confirmed = true;
    if (live) {
      liveStep(s);
      await send(peerId, '✅ Оператор подтвердил — доступ есть. Напишите отчёт (если ещё не писали) и нажмите «Завершить».', liveKb(s));
    } else {
      await send(peerId, `✅ Оператор подтвердил комплекс «${point}» — доступ есть. Зайдите в него из списка заданий, напишите отчёт и нажмите «Завершить».`);
    }
  } else if (request.status === 'remark') {
    const remark = String(request.issue_comment || '').trim() || 'не указано';
    const reportText = String(s.report_text || '').trim();
    const fullReport = `${reportText ? `${reportText}\n` : ''}Замечание диспетчера: ${remark}`;
    await submitAndFinish(
      peerId,
      user,
      s,
      FINAL_STATUS_BY_TYPE[String(s.work_type || '')] || 'Работает',
      fullReport,
      `✅ Диспетчер принял комплекс «${point}»: работает, но есть замечание — ${remark}\nМожно уезжать. Спасибо!`,
    );
    return;
  } else {
    const comment = String(request.issue_comment || '').trim();
    s.check_confirmed = false;
    const note = `🔧 Диспетчер просит продолжить работу${comment ? `: ${comment}` : '.'}`;
    if (live) {
      liveStep(s);
      await send(peerId, `${note}\nДоделайте и запустите «Проверка доступности» ещё раз, когда будете готовы.`, liveKb(s));
    } else {
      await send(peerId, `${note}\nКомплекс «${point}» — зайдите в него из списка заданий и доделайте.`);
    }
  }
  await persistProgress(s);
}

export async function repairOfferRelease(peerId: number, _session: BotSession): Promise<void> {
  await send(
    peerId,
    '⛔ Комплекс недоступен. Можно всё равно завершить работу: отметите причину (нет питания, не подведено питание или ' +
      'комплекс расстрелян), напишете итоги и что неисправно — отчёт уйдёт с итогом «Не работает». ' +
      'Или уехать без ремонта — запрос уйдёт диспетчеру, ответ придёт сюда. ' +
      'Если на месте что-то поправили — проверьте доступ ещё раз.',
    getNoAccessDecisionKeyboard(),
  );
}

export async function repairFinishAnyway(peerId: number, session: BotSession): Promise<void> {
  session.step = 'menu';
  session.finish_reason_pick = true;
  await send(
    peerId,
    'Почему комплекс не работает? Выберите причину — после неё допишем итоги и завершим работу.',
    getUnavailableReasonKeyboard(),
  );
}

async function requestNoAccessDecision(peerId: number, user: BotUser, session: BotSession, kind: string): Promise<void> {
  delete session.pending_action;
  let req: { id: number };
  try {
    req = await apiClient.createDemontageRequest(String(session.task_id), 'Нет доступа к комплексу', kind);
  } catch (err) {
    const detail = err instanceof ApiError ? err.detail : String(err);
    await send(peerId, `❌ Не удалось отправить запрос: ${detail}`, menuKeyboard(session));
    return;
  }
  session.step = 'awaiting_demontage_approval';
  session.pending = { kind: 'decision', id: req.id, decision: kind };
  const label = kind === 'release' ? 'отпуск без ремонта' : 'демонтаж';
  await send(
    peerId,
    `📨 Запрос на ${label} отправлен диспетчеру — ожидайте решения, оно придёт сюда. Можно и выйти с комплекса.`,
    getWaitingKeyboard(),
  );
  spawnPoller(`d:${req.id}`, () => pollDemontageRequest(peerId, user, String(session.task_id), req.id));
}

export async function repairReleaseRequest(peerId: number, _user: BotUser, session: BotSession): Promise<void> {
  session.pending_action = 'release_request';
  const current = String(session.report_text || '').trim();
  await beginDraft(
    peerId,
    session,
    'report',
    'Перед запросом диспетчеру напишите отчёт по комплексу: что сделано (какие действия и попытки). ' +
      'Именно он попадёт в итог по комплексу; следом спрошу, что неисправно и что нужно для исправления.',
    current || null,
    '📝 Этот отчёт уйдёт в итог по комплексу. Он верный?',
  );
}

export async function repairMenuBack(peerId: number, session: BotSession): Promise<void> {
  delete session.finish_after_check;
  delete session.finish_reason_pick;
  if (session.step === 'awaiting_result' || session.step === 'awaiting_sim_confirm') {
    session.step = 'menu';
  }
  await send(peerId, 'Меню:', menuKeyboard(session));
}

async function pollDemontageRequest(peerId: number, user: BotUser, taskId: string, requestId: number): Promise<void> {
  for (let i = 0; i < 360; i++) {
    await sleep(5000);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let req: Record<string, any>;
    try {
      req = await apiClient.getDemontageRequest(requestId);
    } catch {
      continue;
    }
    if (req.status === 'pending') continue;
    await applyDecisionResult(peerId, user, taskId, req);
    return;
  }
  await pendingTimeout(peerId, user, taskId, requestId, '⏳ Решение диспетчера ещё не поступило. Уточните напрямую, если срочно.');
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function applyDecisionResult(peerId: number, user: BotUser, taskId: string, request: Record<string, any>): Promise<void> {
  const s = liveSession(user.vk_id, taskId) || (await detachedSession(user, taskId));
  if (!s || (s.pending as { id?: number } | null)?.id !== request.id) return;
  const live = !s.detached;
  const point = String(s.point_id || 'комплексу');
  const kind = String(request.kind || 'demontage');
  s.pending = null;
  if (request.status === 'approved') {
    if (kind === 'release') {
      await submitAndFinish(
        peerId,
        user,
        s,
        'Не работает',
        String(s.report_text || 'Диспетчер отпустил бригаду без ремонта — доступа к комплексу нет.'),
        `✅ Диспетчер согласился по комплексу «${point}» — можно уезжать. Спасибо!`,
      );
      return;
    }
    s.demontage_completed = true;
    if (live) {
      liveStep(s);
      await send(peerId, '✅ Демонтаж одобрен. Выполните его, пришлите фото, напишите отчёт и нажмите «Завершить».', liveKb(s));
    } else {
      await send(
        peerId,
        `✅ Демонтаж по комплексу «${point}» одобрен. Зайдите в него из списка заданий, пришлите фото, напишите отчёт и нажмите «Завершить».`,
      );
    }
  } else {
    const comment = request.decline_comment || 'не указано';
    const label = kind === 'release' ? 'отпуск без ремонта' : 'демонтаж';
    const text = `⛔ Диспетчер отклонил ${label}: ${comment}. Продолжайте работу.`;
    if (live) {
      liveStep(s);
      await send(peerId, text, liveKb(s));
    } else {
      await send(peerId, `${text} (комплекс «${point}»)`);
    }
  }
  await persistProgress(s);
}

async function resumePending(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  const pending = (session.pending || {}) as { kind?: string; id?: number; decision?: string };
  const taskId = String(session.task_id);
  if (pending.kind === 'verification' && pending.id) {
    session.step = 'awaiting_verification';
    await send(peerId, '📡 Запрос оператору по этому комплексу ещё в работе — ответ придёт сюда.', getWaitingKeyboard());
    spawnPoller(`v:${pending.id}`, () => pollVerificationRequest(peerId, user, taskId, pending.id!));
  } else if (pending.kind === 'decision' && pending.id) {
    session.step = 'awaiting_demontage_approval';
    const label = pending.decision === 'release' ? 'отпуск без ремонта' : 'демонтаж';
    await send(peerId, `📨 Запрос на ${label} по этому комплексу ещё не решён — ответ придёт сюда.`, getWaitingKeyboard());
    spawnPoller(`d:${pending.id}`, () => pollDemontageRequest(peerId, user, taskId, pending.id!));
  } else {
    session.pending = null;
    await showTaskMenu(peerId, session, { point: session.point_id });
  }
}

export async function repairFinish(peerId: number, user: BotUser, session: BotSession): Promise<void> {
  await persistProgress(session, true);
  const workType = String(session.work_type || '');
  let status: string;
  let defaultFinal: string;

  if (session.demontage_completed) {
    const scope = session.demontage_scope as { mode?: string } | null;
    if (!scope) {
      await send(
        peerId,
        'Сначала укажите, что именно демонтировано: кнопка «🧰 Что демонтировано» — весь комплекс или отдельные элементы.',
        menuKeyboard(session),
      );
      return;
    }
    if (!String(session.report_text || '').trim()) {
      await send(peerId, 'Сначала напишите итог работ (просто сообщением сюда).', menuKeyboard(session));
      return;
    }
    if (scope.mode === 'parts') {
      session.step = 'awaiting_result';
      await send(
        peerId,
        'Демонтированы только отдельные элементы. Выберите итоговый статус комплекса:',
        getResultStatusKeyboard(),
      );
      return;
    }
    status = 'Демонтирован';
    defaultFinal = '✅ Демонтаж оформлен, можно уезжать. Спасибо!';
  } else if (session.check_confirmed) {
    status = FINAL_STATUS_BY_TYPE[workType] || 'Работает';
    defaultFinal = '✅ Отчёт сохранён, можно уезжать. Спасибо!';
  } else if (session.power_status) {
    status = 'Не работает';
    defaultFinal = '✅ Отчёт сохранён. Как только питание появится — статус обновится сам.';
  } else if (String(session.shot_text || '').trim()) {
    status = 'Не работает';
    defaultFinal = '✅ Отчёт сохранён: комплекс расстрелян, диспетчер это увидит. Спасибо!';
  } else if (session.no_access) {
    if (session.step === 'awaiting_demontage_approval') {
      await send(peerId, '⏳ Уже ждём решения диспетчера по этому запросу.', menuKeyboard(session));
    } else {
      await repairOfferRelease(peerId, session);
    }
    return;
  } else {
    await send(peerId, '🔎 Доступ к комплексу ещё не подтверждён — проверяю сам, это займёт немного времени…');
    await repairCheckAvailability(peerId, user, session, true);
    return;
  }

  const reportText = String(session.report_text || '').trim();
  if (!reportText) {
    await send(peerId, 'Сначала напишите итог работ (просто сообщением сюда).', menuKeyboard(session));
    return;
  }
  if (
    status === 'Не работает' &&
    !(await ensureFaultInfo(peerId, session, { op: 'finish', status, comment: reportText, final_text: defaultFinal }))
  ) {
    return;
  }
  await submitAndFinish(peerId, user, session, status, reportText, defaultFinal);
}

async function taskWatcher(peerId: number, user: BotUser, taskId: string, workSessionId: number, token: string): Promise<void> {
  const vkId = user.vk_id as number;
  for (let i = 0; i < 720; i++) {
    await sleep(10_000);
    let current = getSession(vkId);
    if (current.task_id !== taskId || current.watch_token !== token) return;
    const mutBefore = Number(current._photo_mut || 0);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let status: Record<string, any>;
    try {
      status = await apiClient.watchTask(taskId, workSessionId, vkId);
    } catch {
      continue;
    }

    current = getSession(vkId);
    if (current.task_id !== taskId || current.watch_token !== token) return;
    const point = String(current.point_id || 'комплекс');

    if (status.finished) {
      resetSession(vkId);
      await send(
        peerId,
        `✅ По комплексу «${point}» отчёт уже сдан (вторым монтёром бригады или диспетчером) — работа закрыта.`,
        getMainMenuKeyboard(),
      );
      return;
    }
    if (status.closed_externally) {
      resetSession(vkId);
      await send(peerId, 'ℹ️ Диспетчер закрыл эту работу со своей стороны.', getMainMenuKeyboard());
      return;
    }
    let progress = status.progress as Record<string, unknown> | undefined;
    if (progress && !INPUT_STEPS.has(String(current.step || ''))) {
      if (Number(current._photo_mut || 0) !== mutBefore || current._photo_busy) {
        const { photo_count: _ignored, ...rest } = progress;
        progress = rest;
      }
      adoptServer(current, progress);
    }
    const demontage = status.demontage as { reason?: string } | undefined;
    if (demontage && current.step !== 'awaiting_demontage_approval') {
      current.demontage_completed = true;
      current.repair_mode = true;
      current.step = 'menu';
      const note = demontage.reason || 'не указано';
      current.demontage_note = note;
      await persistProgress(current);
      await send(
        peerId,
        `🔧 Диспетчер оформил демонтаж: ${note}\nВыполните демонтаж, пришлите фото, напишите отчёт и нажмите «Завершить».`,
        menuKeyboard(current),
      );
      return;
    }
  }
}
