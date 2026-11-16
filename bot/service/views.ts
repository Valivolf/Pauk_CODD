import type { BotSession } from './navigation.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ViewUser = Record<string, any>;
export type ViewRenderer = (peerId: number, user: ViewUser, session: BotSession, page: number) => Promise<void>;

const VIEWS = new Map<string, ViewRenderer>();

export function registerView(name: string, fn: ViewRenderer): ViewRenderer {
  VIEWS.set(name, fn);
  return fn;
}

export async function showView(name: string, peerId: number, user: ViewUser, session: BotSession, page = 0): Promise<void> {
  const fn = VIEWS.get(name);
  if (!fn) return;
  session.view = name;
  session.view_page = page;
  await fn(peerId, user, session, page);
}

export async function turnPage(peerId: number, user: ViewUser, session: BotSession, page: number): Promise<void> {
  const name = typeof session.view === 'string' ? session.view : '';
  if (name && VIEWS.has(name)) {
    await showView(name, peerId, user, session, page);
  }
}
