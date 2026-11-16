// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type BotSession = Record<string, any>;

const sessions = new Map<number, BotSession>();

export function getSession(vkId: number): BotSession {
  let s = sessions.get(vkId);
  if (!s) {
    s = {};
    sessions.set(vkId, s);
  }
  return s;
}

export function resetSession(vkId: number): void {
  sessions.set(vkId, {});
}
