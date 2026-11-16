import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const DEFAULT_API_PORT = process.env.PORT || '3000';

function resolveBotApiKey(): string {
  const fromEnv = (process.env.BOT_API_KEY || '').trim();
  if (fromEnv) return fromEnv;
  const dataDir = path.resolve(process.cwd(), process.env.DATA_DIR || 'data');
  const keyFile = path.join(dataDir, '.bot_api_key');
  try {
    if (fs.existsSync(keyFile)) {
      return fs.readFileSync(keyFile, 'utf-8').trim();
    }
  } catch {
    // ignore read failure
  }
  return '';
}

export interface BotConfig {
  vkToken: string;
  lanCalendarApiUrl: string;
  botApiKey: string;
}

export function loadBotConfig(overrides?: Partial<BotConfig>): BotConfig {
  return {
    vkToken: (overrides?.vkToken ?? process.env.VK_TOKEN ?? '').trim(),
    lanCalendarApiUrl: (
      overrides?.lanCalendarApiUrl ??
      process.env.LAN_CALENDAR_API_URL ??
      `http://127.0.0.1:${DEFAULT_API_PORT}`
    )
      .trim()
      .replace(/\/+$/, ''),
    botApiKey: (overrides?.botApiKey ?? resolveBotApiKey()).trim(),
  };
}
