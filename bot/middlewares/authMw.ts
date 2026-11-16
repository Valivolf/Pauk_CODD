import { apiClient } from '../apiClient.ts';
import { handleIncomingEvent, handleIncomingMessage } from '../handlers/mechanic.ts';
import { getDeactivatedKeyboard, getUnauthorizedKeyboard } from '../keyboards/mechanicMenu.ts';
import { ackEvent } from '../service/events.ts';
import { getBotVkClient } from '../service/mechanic.ts';
import type { VkMessageEventObject, VkRawMessage, VkUpdate } from '../vk.ts';

const IGNORED_EVENT_TYPES = new Set(['message_read', 'message_reply', 'message_typing_state']);
const ENABLED_TTL_MS = 10_000;

let enabledCache = false;
let enabledKnown = false;
let enabledCacheAt = 0;

async function isBotEnabled(): Promise<boolean> {
  const now = Date.now();
  if (now - enabledCacheAt < ENABLED_TTL_MS && enabledKnown) {
    return enabledCache;
  }
  try {
    enabledCache = await apiClient.getBotEnabled();
    enabledKnown = true;
  } catch (err) {
    if (enabledKnown) {
      console.warn(
        `[bot] AuthMiddleware: не удалось проверить /api/bot/enabled, остаюсь в прежнем состоянии (${enabledCache ? 'включён' : 'выключен'}):`,
        err instanceof Error ? err.message : err,
      );
    } else {
      console.warn(
        '[bot] AuthMiddleware: состояние бота ещё не известно (приложение недоступно) — пока молчу:',
        err instanceof Error ? err.message : err,
      );
      enabledCache = false;
    }
  }
  enabledCacheAt = now;
  return enabledCache;
}

function parsePayload(raw: unknown): Record<string, unknown> {
  if (!raw) return {};
  if (typeof raw === 'string') {
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    } catch {
      return {};
    }
  }
  if (typeof raw === 'object' && !Array.isArray(raw)) {
    return raw as Record<string, unknown>;
  }
  return {};
}

async function fetchVkName(vkId: number): Promise<string | null> {
  const vk = getBotVkClient();
  if (!vk) return null;
  try {
    const users = await vk.usersGet([vkId]);
    if (!users.length) return null;
    const full = `${users[0].first_name || ''} ${users[0].last_name || ''}`.trim();
    return full || null;
  } catch {
    return null;
  }
}

async function replyText(peerId: number, text: string, keyboard?: unknown): Promise<void> {
  const vk = getBotVkClient();
  if (!vk) return;
  try {
    await vk.messagesSend({
      peerId,
      message: text,
      keyboard: keyboard as Parameters<typeof vk.messagesSend>[0]['keyboard'],
    });
  } catch (err) {
    console.warn('[bot] Не удалось отправить ответ VK:', err instanceof Error ? err.message : err);
  }
}

async function handleJoinRequest(vkId: number, peerId: number): Promise<void> {
  const vkName = await fetchVkName(vkId);
  let result: { status: string; cooldown_active?: boolean };
  try {
    result = await apiClient.submitJoinRequest(vkId, vkName);
  } catch (err) {
    console.error('[bot] AuthMiddleware: не удалось отправить заявку на доступ:', err);
    await replyText(peerId, '⚠️ Сервер сейчас недоступен, попробуйте через минуту.');
    return;
  }
  if (result.status === 'blocked') {
    await replyText(peerId, '⛔ Доступ ограничен. Обратитесь к диспетчеру напрямую.');
  } else if (result.cooldown_active) {
    await replyText(peerId, '⏳ Заявка уже отправлена, ожидайте решения диспетчера.');
  } else {
    await replyText(peerId, '✅ Заявка отправлена диспетчеру. Как только вас привяжут в системе — бот заработает.');
  }
}

export async function handleVkUpdate(update: VkUpdate): Promise<void> {
  if (!update || !update.type) return;
  if (IGNORED_EVENT_TYPES.has(update.type)) return;
  if (!(await isBotEnabled())) return;

  const isEvent = update.type === 'message_event';
  const isNewMessage = update.type === 'message_new';
  if (!isEvent && !isNewMessage) return;

  const obj = (update.object || {}) as Record<string, unknown>;
  let userId: number | null = null;
  let peerId: number | null = null;
  let payload: Record<string, unknown> = {};
  let rawMessage: VkRawMessage | null = null;
  let eventObj: VkMessageEventObject | null = null;

  if (isNewMessage) {
    const msg = ((obj.message as Record<string, unknown>) || obj) as unknown as VkRawMessage;
    rawMessage = msg;
    userId = typeof msg.from_id === 'number' ? msg.from_id : null;
    peerId = typeof msg.peer_id === 'number' ? msg.peer_id : userId;
    payload = parsePayload(msg.payload);
  } else {
    eventObj = obj as unknown as VkMessageEventObject;
    userId = typeof eventObj.user_id === 'number' ? eventObj.user_id : null;
    peerId = typeof eventObj.peer_id === 'number' ? eventObj.peer_id : userId;
    payload = parsePayload(eventObj.payload);
  }

  // Игнорируем системные события без пользователя или исходящие сообщения группы (from_id < 0)
  if (!userId || userId < 0) return;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let user: Record<string, any> | null;
  try {
    user = await apiClient.getMe(userId);
  } catch (err) {
    console.error('[bot] AuthMiddleware: API недоступен:', err instanceof Error ? err.message : err);
    if (isEvent && eventObj) {
      await ackEvent(eventObj, '⚠️ Сервер сейчас недоступен, попробуйте через минуту.');
    } else if (peerId) {
      await replyText(peerId, '⚠️ Сервер сейчас недоступен, попробуйте через минуту.');
    }
    return;
  }

  if (!user) {
    if (payload.action === 'request_join') {
      try {
        await handleJoinRequest(userId, peerId || userId);
      } finally {
        if (isEvent && eventObj) await ackEvent(eventObj);
      }
      return;
    }
    const rejectMsg =
      '⛔ Ваш VK не привязан ни к одному монтёру в системе.\n' +
      'Обратитесь к диспетчеру или нажмите «Отправить заявку».';
    if (isEvent && eventObj) {
      await ackEvent(eventObj, '⛔ Ваш VK не привязан к монтёру. Обратитесь к диспетчеру.');
    } else if (peerId) {
      await replyText(peerId, rejectMsg, getUnauthorizedKeyboard());
    }
    return;
  }

  if (!user.active) {
    const deactMsg = '⛔ Ваш аккаунт деактивирован.\nОбратитесь к диспетчеру.';
    if (isEvent && eventObj) {
      await ackEvent(eventObj, '⛔ Аккаунт деактивирован. Обратитесь к диспетчеру.');
    } else if (peerId) {
      await replyText(peerId, deactMsg, getDeactivatedKeyboard());
    }
    return;
  }

  if (isEvent && eventObj) {
    await handleIncomingEvent(eventObj, user, payload);
  } else if (isNewMessage && rawMessage) {
    // На случай message_new с вложенным JSON payload от legacy-кнопки (обычные inline-кнопки используют message_event)
    if (typeof payload.action === 'string' && payload.action && !rawMessage.text && !(rawMessage.attachments || []).length) {
      const syntheticEvent: VkMessageEventObject = {
        event_id: '',
        user_id: userId,
        peer_id: peerId || userId,
        payload,
      };
      await handleIncomingEvent(syntheticEvent, user, payload);
      return;
    }
    await handleIncomingMessage(rawMessage, user);
  }
}
