import type { VkClient, VkMessageEventObject } from '../vk.ts';

const SNACKBAR_MAX = 90;

let vkApiRef: VkClient | null = null;

export function setEventsVkClient(client: VkClient | null): void {
  vkApiRef = client;
}

export async function ackEvent(eventObj: VkMessageEventObject | null | undefined, text?: string | null): Promise<void> {
  if (!vkApiRef || !eventObj) return;
  const { event_id, user_id, peer_id } = eventObj;
  if (!event_id || !user_id || !peer_id) return;

  let eventData: string | null = null;
  if (text) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, SNACKBAR_MAX);
    if (clean) {
      eventData = JSON.stringify({ type: 'show_snackbar', text: clean });
    }
  }
  try {
    await vkApiRef.sendMessageEventAnswer({
      eventId: event_id,
      userId: user_id,
      peerId: peer_id,
      eventData,
    });
  } catch (err) {
    console.warn(`[bot] Failed to ack callback event (${event_id}):`, err instanceof Error ? err.message : err);
  }
}

export class EventAck {
  private eventObj: VkMessageEventObject;
  private limitMs: number;
  private done = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(eventObj: VkMessageEventObject, limitSeconds = 15) {
    this.eventObj = eventObj;
    this.limitMs = limitSeconds * 1000;
  }

  start(): this {
    this.timer = setTimeout(() => {
      void this.send(null);
    }, this.limitMs);
    return this;
  }

  private async send(text: string | null): Promise<void> {
    if (this.done) return;
    this.done = true;
    await ackEvent(this.eventObj, text);
  }

  async finish(text?: string | null): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    await this.send(text ?? null);
  }
}
