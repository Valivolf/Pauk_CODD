import crypto from 'node:crypto';

export const VK_API_VERSION = '5.199';
export const VK_API_BASE = 'https://api.vk.com/method';

export interface VkPhotoSize {
  type?: string;
  url: string;
  width?: number;
  height?: number;
}

export interface VkPhotoAttachment {
  id: number;
  owner_id: number;
  sizes?: VkPhotoSize[];
  file_name?: string;
}

export interface VkAudioMessage {
  id: number;
  owner_id: number;
  duration?: number;
  link_ogg?: string;
  link_mp3?: string;
}

export interface VkDocAttachment {
  id: number;
  owner_id: number;
  title?: string;
  ext?: string;
  url?: string;
  size?: number;
}

export interface VkAttachment {
  type: string;
  photo?: VkPhotoAttachment;
  audio_message?: VkAudioMessage;
  doc?: VkDocAttachment;
}

export interface VkRawMessage {
  id?: number;
  conversation_message_id?: number;
  from_id: number;
  peer_id: number;
  text?: string;
  attachments?: VkAttachment[];
  payload?: string | Record<string, unknown>;
  fwd_messages?: VkRawMessage[];
  reply_message?: VkRawMessage;
}

export interface VkMessageEventObject {
  event_id: string;
  user_id: number;
  peer_id: number;
  conversation_message_id?: number;
  payload?: string | Record<string, unknown>;
}

export interface VkUpdate {
  type: string;
  object?: Record<string, unknown>;
  group_id?: number;
}

export interface KeyboardButtonSpec {
  label: string;
  payload: Record<string, unknown>;
  color?: 'primary' | 'secondary' | 'positive' | 'negative';
}

export class VkKeyboard {
  private inline: boolean;
  private oneTime: boolean;
  private buttons: Array<
    Array<{
      action: { type: 'callback'; label: string; payload: string };
      color?: string;
    }>
  > = [[]];

  constructor(opts: { inline?: boolean; oneTime?: boolean } = {}) {
    this.inline = opts.inline ?? true;
    this.oneTime = opts.oneTime ?? false;
  }

  add(label: string, payload: Record<string, unknown>, color?: 'primary' | 'secondary' | 'positive' | 'negative'): this {
    const cleanLabel = String(label || '').slice(0, 40) || '•';
    const currentRow = this.buttons[this.buttons.length - 1];
    const btn: { action: { type: 'callback'; label: string; payload: string }; color?: string } = {
      action: {
        type: 'callback',
        label: cleanLabel,
        payload: JSON.stringify(payload),
      },
    };
    if (color) btn.color = color;
    currentRow.push(btn);
    return this;
  }

  row(): this {
    if (this.buttons[this.buttons.length - 1].length > 0) {
      this.buttons.push([]);
    }
    return this;
  }

  getJson(): string {
    const cleanRows = this.buttons.filter((r) => r.length > 0);
    return JSON.stringify({
      inline: this.inline,
      ...(this.inline ? {} : { one_time: this.oneTime }),
      buttons: cleanRows,
    });
  }
}

export class VkClient {
  private token: string;

  constructor(token: string) {
    this.token = token;
  }

  async call<T = unknown>(method: string, params: Record<string, string | number | undefined | null> = {}): Promise<T> {
    const form = new URLSearchParams();
    form.set('access_token', this.token);
    form.set('v', VK_API_VERSION);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) {
        form.set(k, String(v));
      }
    }
    const resp = await fetch(`${VK_API_BASE}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: AbortSignal.timeout(30_000),
    });
    if (!resp.ok) {
      throw new Error(`VK HTTP ${resp.status} on ${method}`);
    }
    const data = (await resp.json()) as { response?: T; error?: { error_code?: number; error_msg?: string } };
    if (data.error) {
      const err = new Error(`VK API error ${data.error.error_code}: ${data.error.error_msg}`);
      (err as { code?: number }).code = data.error.error_code;
      throw err;
    }
    return data.response as T;
  }

  async messagesSend(opts: {
    peerId: number;
    message: string;
    keyboard?: VkKeyboard | string | null;
    attachment?: string | null;
  }): Promise<number> {
    const kb = opts.keyboard instanceof VkKeyboard ? opts.keyboard.getJson() : opts.keyboard || undefined;
    const randomId = crypto.randomInt(1, 2_147_483_647);
    return this.call<number>('messages.send', {
      peer_id: opts.peerId,
      message: opts.message,
      random_id: randomId,
      keyboard: kb,
      attachment: opts.attachment || undefined,
    });
  }

  async sendMessageEventAnswer(opts: {
    eventId: string;
    userId: number;
    peerId: number;
    eventData?: string | null;
  }): Promise<void> {
    await this.call('messages.sendMessageEventAnswer', {
      event_id: opts.eventId,
      user_id: opts.userId,
      peer_id: opts.peerId,
      event_data: opts.eventData || undefined,
    });
  }

  async usersGet(userIds: number[]): Promise<Array<{ id: number; first_name?: string; last_name?: string }>> {
    if (!userIds.length) return [];
    return this.call('users.get', { user_ids: userIds.join(',') });
  }

  async getGroupId(): Promise<number> {
    const res = await this.call<Array<{ id: number }> | { groups?: Array<{ id: number }> }>('groups.getById', {});
    if (Array.isArray(res) && res[0]?.id) return res[0].id;
    if (!Array.isArray(res) && res?.groups?.[0]?.id) return res.groups[0].id;
    throw new Error('Could not resolve VK group_id from token (ensure token is a VK Community token)');
  }

  async getByConversationMessageId(peerId: number, cmids: number[]): Promise<VkRawMessage[]> {
    if (!cmids.length) return [];
    const res = await this.call<{ items?: VkRawMessage[] }>('messages.getByConversationMessageId', {
      peer_id: peerId,
      conversation_message_ids: cmids.join(','),
    });
    return res?.items || [];
  }

  async uploadMessagePhoto(peerId: number, filename: string, content: Buffer): Promise<string> {
    const server = await this.call<{ upload_url: string }>('photos.getMessagesUploadServer', { peer_id: peerId });
    const form = new FormData();
    const blob = new Blob([new Uint8Array(content)], { type: 'image/jpeg' });
    form.append('photo', blob, filename || 'photo.jpg');
    const uploadResp = await fetch(server.upload_url, {
      method: 'POST',
      body: form,
      signal: AbortSignal.timeout(45_000),
    });
    if (!uploadResp.ok) {
      throw new Error(`VK upload HTTP ${uploadResp.status}`);
    }
    const uploaded = (await uploadResp.json()) as { server?: number; photo?: string; hash?: string };
    const saved = await this.call<Array<{ id: number; owner_id: number }>>('photos.saveMessagesPhoto', {
      photo: uploaded.photo || '',
      server: uploaded.server ?? '',
      hash: uploaded.hash || '',
    });
    const item = saved?.[0];
    if (!item) throw new Error('VK photos.saveMessagesPhoto returned empty result');
    return `photo${item.owner_id}_${item.id}`;
  }

  async runLongPoll(signal: AbortSignal, onUpdate: (update: VkUpdate) => Promise<void> | void): Promise<void> {
    let groupId: number | null = null;
    while (!signal.aborted && groupId === null) {
      try {
        groupId = await this.getGroupId();
      } catch (err) {
        console.error('[bot] Failed to get VK group_id, retrying in 5s:', err instanceof Error ? err.message : err);
        await sleep(5000, signal);
      }
    }
    if (signal.aborted || groupId === null) return;

    let lp = await this.call<{ key: string; server: string; ts: string }>('groups.getLongPollServer', {
      group_id: groupId,
    });
    console.log(`[bot] VK Long Poll connected (group_id=${groupId})`);

    while (!signal.aborted) {
      try {
        const url = `${lp.server}?act=a_check&key=${encodeURIComponent(lp.key)}&ts=${encodeURIComponent(lp.ts)}&wait=25`;
        const resp = await fetch(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(35_000)]) });
        if (!resp.ok) {
          throw new Error(`LongPoll HTTP ${resp.status}`);
        }
        const data = (await resp.json()) as {
          ts?: string;
          updates?: VkUpdate[];
          failed?: number;
        };
        if (data.failed) {
          if (data.failed === 1 && data.ts) {
            lp.ts = data.ts;
            continue;
          }
          lp = await this.call<{ key: string; server: string; ts: string }>('groups.getLongPollServer', {
            group_id: groupId,
          });
          continue;
        }
        if (data.ts) lp.ts = data.ts;
        if (Array.isArray(data.updates)) {
          for (const upd of data.updates) {
            void Promise.resolve(onUpdate(upd)).catch((e) => {
              console.error('[bot] Unhandled error processing VK update:', e);
            });
          }
        }
      } catch (err) {
        if (signal.aborted) break;
        console.warn('[bot] Long Poll error, retrying in 3s:', err instanceof Error ? err.message : err);
        await sleep(3000, signal);
        try {
          lp = await this.call<{ key: string; server: string; ts: string }>('groups.getLongPollServer', {
            group_id: groupId,
          });
        } catch {
          // retry outer loop
        }
      }
    }
  }
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
