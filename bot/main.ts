import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { apiClient } from './apiClient.ts';
import { loadBotConfig, type BotConfig } from './config.ts';
import { handleVkUpdate } from './middlewares/authMw.ts';
import { setEventsVkClient } from './service/events.ts';
import { deliverChatMessages, setBotVkClient } from './service/mechanic.ts';
import { VkClient } from './vk.ts';

const CHAT_POLL_MS = 3000;

export interface BotHandle {
  stop: () => void;
}

export function startBot(overrides?: Partial<BotConfig>): BotHandle | null {
  const cfg = loadBotConfig(overrides);
  apiClient.configure(cfg.lanCalendarApiUrl, cfg.botApiKey);

  if (!cfg.vkToken) {
    console.warn('[bot] VK_TOKEN не задан — VK-бот в режиме ожидания (задайте VK_TOKEN для запуска Long Poll)');
    return null;
  }

  const vk = new VkClient(cfg.vkToken);
  setBotVkClient(vk);
  setEventsVkClient(vk);

  const controller = new AbortController();
  let stopped = false;

  const deliverTimer = setInterval(() => {
    if (stopped) return;
    void deliverChatMessages().catch((err) => {
      console.error('[bot] Чат: ошибка фоновой доставки:', err instanceof Error ? err.message : err);
    });
  }, CHAT_POLL_MS);
  deliverTimer.unref?.();

  console.log(`[bot] Запуск VK-бота (API: ${cfg.lanCalendarApiUrl})…`);
  void vk.runLongPoll(controller.signal, handleVkUpdate).catch((err) => {
    if (!controller.signal.aborted) {
      console.error('[bot] Long Poll остановлен из-за ошибки:', err);
    }
  });

  return {
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearInterval(deliverTimer);
      controller.abort();
      setBotVkClient(null);
      setEventsVkClient(null);
    },
  };
}

function isMainModule(): boolean {
  try {
    const thisFile = path.resolve(fileURLToPath(import.meta.url));
    const entryFile = process.argv[1] ? path.resolve(process.argv[1]) : '';
    return thisFile === entryFile;
  } catch {
    return false;
  }
}

if (isMainModule()) {
  const cfg = loadBotConfig();
  const handle = startBot(cfg);
  const idleTimer = !handle ? setInterval(() => {}, 60_000) : null;
  const shutdown = () => {
    if (idleTimer) clearInterval(idleTimer);
    handle?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
