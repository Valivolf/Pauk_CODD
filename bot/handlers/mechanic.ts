import type { VkMessageEventObject, VkRawMessage } from '../vk.ts';
import { getWaitingKeyboard } from '../keyboards/mechanicMenu.ts';
import * as eqSvc from '../service/equipment.ts';
import { EventAck, ackEvent } from '../service/events.ts';
import * as svc from '../service/mechanic.ts';
import { getSession, type BotSession } from '../service/navigation.ts';
import { turnPage } from '../service/views.ts';
import * as whSvc from '../service/warehouse.ts';

const FREE_INPUT_STEPS = new Set(['menu', 'awaiting_power_source']);

const WAIT_ALLOWED: Record<string, Set<string>> = {
  awaiting_photos: new Set(['photos_done', 'photos_cancel']),
  awaiting_text: new Set(['draft_save', 'draft_cancel', 'draft_edit', 'draft_keep']),
  awaiting_verification: new Set(['leave_task', 'dispatcher_phone', 'chat_open']),
  awaiting_demontage_approval: new Set(['leave_task', 'dispatcher_phone', 'chat_open']),
  awaiting_power_source: new Set(['set_power_source', 'leave_task']),
  awaiting_result: new Set(['set_result', 'set_outcome', 'repair_menu_back']),
  awaiting_sim_confirm: new Set(['sim_confirm_yes', 'sim_confirm_no', 'repair_sim_change', 'repair_menu_back']),
  awaiting_reason: new Set(['rsn_pick', 'rsn_back', 'leave_task']),
  awaiting_sim_state: new Set(['sim_state_pick', 'sim_state_back', 'leave_task']),
  chat: new Set(['chat_exit']),
};

const WAIT_HINTS: Record<string, string> = {
  awaiting_photos: 'Сначала нажмите «Готово» или «Отмена».',
  awaiting_text: 'Сначала сохраните или отмените ввод.',
  awaiting_verification: 'Ждём ответ диспетчера — он придёт в этот чат.',
  awaiting_demontage_approval: 'Ждём ответ диспетчера — он придёт в этот чат.',
  awaiting_reason: 'Сначала выберите причину снятия или напишите её.',
  awaiting_sim_state: 'Сначала ответьте кнопкой: снятая SIM рабочая или нет.',
  chat: 'Вы в чате с диспетчером — нажмите «Выйти из чата», чтобы продолжить работу.',
};

const TASK_ACTIONS = new Set([
  'photo_rm',
  'report_rm',
  'report_edit',
  'repair_photo',
  'repair_report',
  'repair_equipment',
  'repair_equipment_other',
  'repair_shot',
  'repair_sim_change',
  'to_repair_mode',
  'from_repair_mode',
  'set_power_source',
  'set_outcome',
  'simple_finish',
  'repair_no_power',
  'repair_not_connected',
  'repair_check',
  'sim_confirm_yes',
  'sim_confirm_no',
  'repair_finish',
  'finish_anyway',
  'repair_release_request',
  'repair_menu_back',
  'set_result',
  'photos_done',
  'photos_cancel',
  'draft_save',
  'draft_cancel',
  'draft_edit',
  'draft_keep',
  'eq_catalog',
  'eq_cat',
  'eq_item',
  'eq_repl',
  'eq_rm',
  'eq_new',
  'eq_newc',
  'eq_pick',
  'eq_other',
  'eq_actpick',
  'eq_actnew',
  'eq_serial',
  'eq_suffix_ok',
  'eq_do',
  'eq_reason',
  'repair_sim_fix',
  'rsn_pick',
  'rsn_back',
  'sim_state_pick',
  'sim_state_back',
  'dem_scope',
  'dem_whole',
  'dem_whole_ok',
  'dem_parts',
  'dem_tog',
  'dem_other',
  'dem_parts_ok',
]);

async function checkActionGuard(action: string, user: svc.BotUser, peerId: number): Promise<string | null> {
  const session = getSession(user.vk_id);
  const step = session.step as string | undefined;
  if (session.task_id && step && step in WAIT_ALLOWED && !WAIT_ALLOWED[step].has(action)) {
    await svc.reshowWait(peerId, session);
    return WAIT_HINTS[step] || 'Сначала ответьте на вопрос выше.';
  }
  if (TASK_ACTIONS.has(action) && !session.task_id) {
    if (await svc.restoreActiveTask(peerId, user, session)) {
      return 'Вернул вас на комплекс — нажмите нужную кнопку ещё раз.';
    }
    await svc.showMyTasks(peerId, user);
    return 'Комплекс не открыт — выберите его в списке заданий.';
  }
  return null;
}

// ------------------------------------------------------------------ текстовые / фото / голосовые сообщения ----

export async function handleIncomingMessage(message: VkRawMessage, user: svc.BotUser): Promise<void> {
  const vkId = user.vk_id as number;
  const session = getSession(vkId);
  let step = session.step as string | undefined;
  let inTask = Boolean(session.task_id);

  const voices = svc.voiceAttachments(message);
  if (voices.length) {
    if (!inTask && (await svc.restoreActiveTask(message.peer_id, user, session))) {
      inTask = true;
      step = session.step as string | undefined;
    }
    if (step === 'chat') {
      await svc.send(message.peer_id, '🎙 В чат с диспетчером голосовые не принимаются — напишите текстом.', svc.getChatKeyboard());
    } else if (inTask && !FREE_INPUT_STEPS.has(step || '')) {
      await svc.send(message.peer_id, '🎙 Сейчас голосовое не принимается — сначала завершите текущий шаг.');
      await svc.reshowWait(message.peer_id, session);
    } else {
      await svc.receiveVoice(message, user, session, voices);
      await svc.afterAction(user);
    }
    return;
  }

  const photos = await svc.collectPhotoAttachments(message);
  if (photos.length && step === 'chat') {
    await svc.chatPhotos(message, user, session, photos);
    return;
  }
  if (photos.length) {
    if (!inTask && (await svc.restoreActiveTask(message.peer_id, user, session))) {
      inTask = true;
      step = session.step as string | undefined;
    }
    if (inTask && FREE_INPUT_STEPS.has(step || '')) {
      await svc.receivePhotos(message, user, session, photos);
      if (String(message.text || '').trim()) {
        await svc.receiveReportText(message, user, session);
      }
      await svc.afterAction(user);
    } else if (inTask && step === 'awaiting_photos') {
      await svc.handlePhotoMessage(message, user, session, photos);
      await svc.afterAction(user);
    } else if (inTask && step && step in WAIT_ALLOWED) {
      await svc.send(
        message.peer_id,
        `Сейчас фото не принимаются — ${(WAIT_HINTS[step] || 'сначала завершите текущий шаг.').toLowerCase()}`,
      );
      await svc.reshowWait(message.peer_id, session);
    } else {
      await svc.send(message.peer_id, 'Сейчас фото не ожидается. Наберите «начать», чтобы открыть меню.');
    }
    return;
  }

  const text = String(message.text || '').trim().toLowerCase();
  if (text === 'начать' || text === 'start' || text === 'меню' || text === 'го' || text === 'go') {
    await svc.showMainMenu(message.peer_id, user);
    return;
  }

  if (step === 'chat') {
    await svc.chatMessage(message, user, session);
  } else if (step === 'awaiting_text') {
    await svc.handleDraftText(message, user, session);
  } else if (step === 'awaiting_photos') {
    await svc.send(message.peer_id, 'Жду фото — пришлите их или нажмите «Готово» / «Отмена».');
    await svc.reshowWait(message.peer_id, session);
  } else if (step === 'awaiting_equipment_serial') {
    await eqSvc.handleSerialText(message, user, session);
  } else if (step === 'awaiting_actual_serial') {
    await eqSvc.handleActualText(message, user, session);
  } else if (step === 'awaiting_reason') {
    await svc.handleReasonText(message, user, session);
  } else if (step === 'wh_awaiting_actual') {
    await whSvc.handleActualSearch(message, user, session);
  } else if (step === 'wh_awaiting_person') {
    await whSvc.handlePersonSearch(message, user, session);
  } else if (step === 'wh_awaiting_serials') {
    await whSvc.handleSerialsText(message, user, session);
  } else if (step === 'wh_awaiting_status_serial') {
    await whSvc.handleStatusSearch(message, user, session);
  } else if (step === 'awaiting_sim_state') {
    await svc.send(message.peer_id, 'Ответьте кнопкой: снятая SIM рабочая или нет.');
    await svc.reshowWait(message.peer_id, session);
  } else if (step === 'awaiting_result') {
    await svc.send(message.peer_id, 'Выберите итоговый статус кнопками выше.');
  } else if (step === 'awaiting_sim_confirm') {
    await svc.send(message.peer_id, 'Пожалуйста, используйте кнопки выше — SIM указана верно или нет?');
  } else if (step === 'awaiting_task_search') {
    await svc.handleTaskSearchText(message, session);
  } else if (step === 'awaiting_verification') {
    await svc.send(message.peer_id, '⏳ Ожидаем решение оператора — оно придёт в этот чат. Можно выйти с комплекса.', getWaitingKeyboard());
  } else if (step === 'awaiting_demontage_approval') {
    await svc.send(message.peer_id, '⏳ Ожидаем решение диспетчера — оно придёт в этот чат. Можно выйти с комплекса.', getWaitingKeyboard());
  } else if (inTask && (step === 'menu' || step === 'awaiting_power_source')) {
    await svc.receiveReportText(message, user, session);
  } else {
    await svc.send(message.peer_id, 'Наберите «начать», чтобы открыть меню.');
  }
  await svc.afterAction(user);
}

// ------------------------------------------------------------------ callback-кнопки (message_event) ----

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ActionHandler = (user: svc.BotUser, payload: Record<string, any>, peerId: number, session: BotSession) => Promise<void>;

const ACTION_HANDLERS: Record<string, ActionHandler> = {
  main_menu: async (user, _p, peerId) => svc.showMainMenu(peerId, user),
  profile: async (user, _p, peerId) => svc.showProfile(peerId, user),
  my_tasks: async (user, _p, peerId) => svc.showMyTasks(peerId, user),
  tasks_page: async (_u, p, peerId, s) => svc.changeTasksPage(peerId, s, String(p.dir || 'next')),
  tasks_search: async (_u, _p, peerId, s) => svc.requestTaskSearch(peerId, s),
  tasks_search_cancel: async (_u, _p, peerId, s) => svc.cancelTaskSearch(peerId, s),
  tasks_search_clear: async (_u, _p, peerId, s) => svc.clearTaskSearch(peerId, s),
  leave_task: async (u, _p, peerId, s) => svc.leaveTaskAction(peerId, u, s),
  photos_done: async (_u, _p, peerId, s) => svc.photosDone(peerId, s),
  photos_cancel: async (_u, _p, peerId, s) => svc.photosCancel(peerId, s),
  draft_save: async (u, _p, peerId, s) => svc.draftSave(peerId, u, s),
  draft_cancel: async (_u, _p, peerId, s) => svc.draftCancel(peerId, s),
  draft_edit: async (_u, _p, peerId, s) => svc.draftEdit(peerId, s),
  draft_keep: async (u, _p, peerId, s) => svc.draftKeep(peerId, s, u),
  open_task: async (u, p, peerId) => {
    if (p.task_id) await svc.showTask(peerId, u, String(p.task_id));
  },
  aux_accept: async (u, p, peerId) => {
    if (p.task_id) await svc.acceptAuxTask(peerId, u, String(p.task_id));
  },
  start_task: async (u, p, peerId) => {
    if (p.task_id) await svc.startTask(peerId, u, String(p.task_id));
  },
  set_result: async (u, p, peerId, s) => {
    if (p.status) await svc.setResult(peerId, u, s, String(p.status));
  },
  dispatcher_phone: async (_u, _p, peerId, s) => svc.showDispatcherPhone(peerId, s),
  chat_open: async (u, _p, peerId, s) => {
    if (s.peer_id === undefined) s.peer_id = peerId;
    await svc.chatOpen(peerId, u, s);
  },
  chat_exit: async (u, _p, peerId, s) => svc.chatExit(peerId, u, s),
  repair_photo: async (_u, _p, peerId, s) => svc.repairRequestPhoto(peerId, s),
  photo_rm: async (_u, p, peerId, s) => svc.photoRemove(peerId, s, p.scope === 'last' ? 'last' : 'all'),
  report_rm: async (_u, p, peerId, s) => svc.reportRemove(peerId, s, p.scope === 'last' ? 'last' : 'all'),
  report_edit: async (_u, _p, peerId, s) => svc.reportEdit(peerId, s),
  repair_report: async (_u, _p, peerId, s) => svc.repairRequestReport(peerId, s),
  repair_equipment: async (_u, _p, peerId, s) => svc.repairRequestEquipment(peerId, s),
  repair_equipment_other: async (_u, _p, peerId, s) => svc.repairRequestEquipmentOther(peerId, s),
  repair_shot: async (_u, _p, peerId, s) => svc.repairRequestShot(peerId, s),
  repair_sim_change: async (_u, _p, peerId, s) => svc.requestSimChange(peerId, s),
  to_repair_mode: async (_u, _p, peerId, s) => svc.toRepairMode(peerId, s),
  from_repair_mode: async (_u, _p, peerId, s) => svc.fromRepairMode(peerId, s),
  set_power_source: async (_u, p, peerId, s) => svc.setPowerSource(peerId, s, String(p.value || '')),
  set_outcome: async (u, p, peerId, s) => {
    const idx = Number(p.i);
    if (!Number.isFinite(idx)) return;
    await svc.setOutcome(peerId, u, s, Math.trunc(idx));
  },
  simple_finish: async (u, _p, peerId, s) => svc.simpleFinish(peerId, u, s),
  repair_no_power: async (u, _p, peerId, s) => svc.repairSetPowerStatus(peerId, s, 'no_power', u),
  repair_not_connected: async (u, _p, peerId, s) => svc.repairSetPowerStatus(peerId, s, 'not_connected', u),
  finish_anyway: async (_u, _p, peerId, s) => svc.repairFinishAnyway(peerId, s),
  repair_check: async (u, _p, peerId, s) => svc.repairCheckAvailability(peerId, u, s),
  sim_confirm_yes: async (_u, _p, peerId, s) => svc.handleSimConfirm(peerId, s, true),
  sim_confirm_no: async (_u, _p, peerId, s) => svc.handleSimConfirm(peerId, s, false),
  repair_finish: async (u, _p, peerId, s) => svc.repairFinish(peerId, u, s),
  repair_release_request: async (u, _p, peerId, s) => svc.repairReleaseRequest(peerId, u, s),
  repair_menu_back: async (_u, _p, peerId, s) => svc.repairMenuBack(peerId, s),

  // Оборудование
  my_equipment: async (u, _p, peerId) => eqSvc.showMyEquipment(peerId, u),
  eq_catalog: async (u, _p, peerId, s) => eqSvc.showCatalog(peerId, u, s),
  eq_cat: async (u, p, peerId, s) => eqSvc.chooseCategory(peerId, u, s, Number(p.c || 0)),
  eq_item: async (u, p, peerId, s) => eqSvc.chooseItem(peerId, u, s, Number(p.i || 0)),
  eq_repl: async (u, _p, peerId, s) => eqSvc.startReplace(peerId, u, s),
  eq_rm: async (u, _p, peerId, s) => eqSvc.startRemove(peerId, u, s),
  eq_new: async (u, _p, peerId, s) => eqSvc.startInstall(peerId, u, s),
  eq_newc: async (u, p, peerId, s) => eqSvc.chooseInstallCategory(peerId, u, s, Number(p.c || 0)),
  eq_pick: async (u, p, peerId, s) => eqSvc.pickNew(peerId, u, s, Number(p.i || 0)),
  eq_other: async (_u, _p, peerId, s) => eqSvc.requestActual(peerId, s),
  eq_actpick: async (u, p, peerId, s) => eqSvc.pickActual(peerId, u, s, Number(p.i || 0)),
  eq_actnew: async (u, _p, peerId, s) => eqSvc.newActual(peerId, u, s),
  eq_serial: async (_u, _p, peerId, s) => eqSvc.requestSerial(peerId, s),
  eq_suffix_ok: async (u, _p, peerId, s) => eqSvc.suffixOk(peerId, u, s),
  eq_do: async (u, _p, peerId, s) => eqSvc.doConfirm(peerId, u, s),
  eq_reason: async (_u, _p, peerId, s) => eqSvc.changeReason(peerId, s),
  rsn_pick: async (u, p, peerId, s) => {
    const idx = Number(p.i);
    if (!Number.isFinite(idx)) return;
    await svc.pickReason(peerId, u, s, Math.trunc(idx));
  },
  rsn_back: async (u, _p, peerId, s) => svc.reasonCancel(peerId, u, s),
  sim_state_pick: async (u, p, peerId, s) => svc.pickSimState(peerId, u, s, Boolean(Number(p.w || 0))),
  sim_state_back: async (_u, _p, peerId, s) => svc.simStateCancel(peerId, s),
  repair_sim_fix: async (_u, _p, peerId, s) => svc.requestSimFix(peerId, s),
  dem_scope: async (u, _p, peerId, s) => eqSvc.startDemontageScope(peerId, u, s),
  dem_whole: async (u, _p, peerId, s) => eqSvc.demWhole(peerId, u, s),
  dem_whole_ok: async (u, _p, peerId, s) => eqSvc.demWholeOk(peerId, u, s),
  dem_parts: async (u, _p, peerId, s) => eqSvc.demParts(peerId, u, s),
  dem_tog: async (u, p, peerId, s) => eqSvc.demToggle(peerId, u, s, Number(p.i || 0)),
  dem_other: async (_u, _p, peerId, s) => eqSvc.demOther(peerId, s),
  dem_parts_ok: async (u, _p, peerId, s) => eqSvc.demPartsOk(peerId, u, s),
  pg: async (u, p, peerId, s) => turnPage(peerId, u, s, Number(p.n || 0)),

  // Склад
  wh_accept: async (u, _p, peerId, s) => whSvc.showAccept(peerId, u, s),
  wh_accp: async (u, p, peerId, s) => whSvc.showPersonItems(peerId, u, s, Number(p.p || 0)),
  wh_acc1: async (u, p, peerId, s) => whSvc.acceptItems(peerId, u, s, [Number(p.i || 0)]),
  wh_accall: async (u, _p, peerId, s) => whSvc.acceptItems(peerId, u, s, null),
  wh_issue: async (u, _p, peerId, s) => whSvc.startIssue(peerId, u, s),
  wh_findp: async (_u, _p, peerId, s) => whSvc.requestPersonSearch(peerId, s),
  wh_iss_p: async (u, p, peerId, s) => whSvc.issueToPerson(peerId, u, s, Number(p.p || 0)),
  wh_iss_c: async (u, p, peerId, s) => whSvc.showIssueCategory(peerId, u, s, Number(p.c || 0)),
  wh_iss_t: async (u, p, peerId, s) => whSvc.toggleIssueItem(peerId, u, s, Number(p.i || 0)),
  wh_iss_back: async (u, _p, peerId, s) => whSvc.showIssueScreen(peerId, u, s),
  wh_iss_do: async (u, _p, peerId, s) => whSvc.doIssue(peerId, u, s),
  wh_status: async (u, _p, peerId, s) => whSvc.requestStatusSearch(peerId, u, s),
  wh_st_i: async (u, p, peerId, s) => whSvc.showItem(peerId, u, s, Number(p.i || 0)),
  wh_st_s: async (u, p, peerId, s) => whSvc.setItemStatus(peerId, u, s, Number(p.s || 0)),
  wh_iss_find: async (_u, _p, peerId, s) => whSvc.requestIssueSearch(peerId, s),
  wh_other: async (u, _p, peerId, s) => whSvc.startOther(peerId, u, s),
  wh_oth_i: async (u, p, peerId, s) => whSvc.chooseOtherItem(peerId, u, s, Number(p.i || 0)),
  wh_actpick: async (u, p, peerId, s) => whSvc.pickActual(peerId, u, s, Number(p.i || 0)),
  wh_actnew: async (u, _p, peerId, s) => whSvc.newActual(peerId, u, s),
  wh_subdo: async (u, _p, peerId, s) => whSvc.doSubstitute(peerId, u, s),
  wh_found: async (u, _p, peerId, s) => whSvc.markFound(peerId, u, s),
  wh_stock: async (u, _p, peerId, s) => whSvc.showStock(peerId, u, s),
};

export async function handleIncomingEvent(
  eventObj: VkMessageEventObject,
  user: svc.BotUser,
  payload: Record<string, unknown>,
): Promise<void> {
  const action = typeof payload.action === 'string' ? payload.action : '';
  const handler = action ? ACTION_HANDLERS[action] : undefined;
  if (!handler) {
    await ackEvent(eventObj, 'Эта кнопка устарела. Наберите «начать» — откроется актуальное меню.');
    return;
  }

  const ack = new EventAck(eventObj).start();
  let note: string | null = null;
  try {
    const peerId = eventObj.peer_id;
    note = await checkActionGuard(action, user, peerId);
    if (note === null) {
      const session = getSession(user.vk_id);
      await handler(user, payload, peerId, session);
      await svc.afterAction(user);
    }
  } finally {
    await ack.finish(note);
  }
}
