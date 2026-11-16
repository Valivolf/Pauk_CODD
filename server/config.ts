import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

export const ROOT_DIR = process.cwd();
export const DATA_DIR = path.resolve(ROOT_DIR, process.env.DATA_DIR || 'data');
export const BACKUP_DIR = path.resolve(ROOT_DIR, process.env.BACKUP_DIR || 'backups');
export const PHOTOS_DIR = process.env.PHOTOS_DIR
  ? path.resolve(ROOT_DIR, process.env.PHOTOS_DIR)
  : path.join(DATA_DIR, 'visit_photos');
export const POINT_FILES_DIR = path.join(DATA_DIR, 'point_files');
export const CHAT_FILES_DIR = path.join(DATA_DIR, 'chat_files');
export const ACCOUNT_CHAT_FILES_DIR = path.join(DATA_DIR, 'account_chat_files');
export const REPORT_TEMPLATES_DIR = path.join(DATA_DIR, 'report_templates');
export const AI_FILES_DIR = path.join(DATA_DIR, 'ai_files');
export const DB_PATH = path.join(DATA_DIR, 'calendar.db');

for (const dir of [
  DATA_DIR,
  BACKUP_DIR,
  PHOTOS_DIR,
  POINT_FILES_DIR,
  CHAT_FILES_DIR,
  ACCOUNT_CHAT_FILES_DIR,
  REPORT_TEMPLATES_DIR,
  AI_FILES_DIR,
]) {
  fs.mkdirSync(dir, { recursive: true });
}

function readOrCreateSecret(fileName: string, envValue: string | undefined, generator: () => string): string {
  const trimmed = (envValue || '').trim();
  if (trimmed) return trimmed;
  const filePath = path.join(DATA_DIR, fileName);
  try {
    if (fs.existsSync(filePath)) {
      const existing = fs.readFileSync(filePath, 'utf-8').trim();
      if (existing) return existing;
    }
  } catch {
    // ignore read error and regenerate
  }
  const generated = generator();
  try {
    fs.writeFileSync(filePath, generated, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // ignore write error on readonly fs
  }
  return generated;
}

const rawAppName = (process.env.APP_NAME || '').trim();

export const settings = {
  appName: !rawAppName || rawAppName === 'Календарь работ' ? 'Паук' : rawAppName,
  adminUsername: process.env.ADMIN_USERNAME || 'admin',
  adminPassword: process.env.ADMIN_PASSWORD || 'admin123',
  secretKey: readOrCreateSecret('.secret_key', process.env.SECRET_KEY, () =>
    crypto.randomBytes(32).toString('base64url'),
  ),
  fieldEncryptionKey: readOrCreateSecret('.field_key', process.env.FIELD_ENCRYPTION_KEY, () =>
    crypto.randomBytes(32).toString('base64url'),
  ),
  botApiKey: readOrCreateSecret('.bot_api_key', process.env.BOT_API_KEY, () =>
    crypto.randomBytes(24).toString('base64url'),
  ),
  accessTokenExpireMinutes: Number(process.env.ACCESS_TOKEN_EXPIRE_MINUTES || 720),
  cookieName: process.env.COOKIE_NAME || 'access_token',
  cookieSecure: String(process.env.COOKIE_SECURE || 'false').toLowerCase() === 'true',
  passwordMinLength: Math.max(6, Number(process.env.PASSWORD_MIN_LENGTH || 8)),
  sessionIdleMinutes: Math.max(0, Number(process.env.SESSION_IDLE_MINUTES || 0)),
  securityLogRetentionDays: Math.max(30, Number(process.env.SECURITY_LOG_RETENTION_DAYS || 365)),
  backupRetention: Math.max(1, Number(process.env.BACKUP_RETENTION || 30)),
  yandexMapsApiKey: process.env.YANDEX_MAPS_API_KEY || '',
  planOrgTitle: process.env.PLAN_ORG_TITLE || '',
  planApproverName: process.env.PLAN_APPROVER_NAME || '',
  planRouteLabel: process.env.PLAN_ROUTE_LABEL || '',
  planSafetyOfficer: process.env.PLAN_SAFETY_OFFICER || '',
  planSecondApproverTitle: process.env.PLAN_SECOND_APPROVER_TITLE || '',
  planSecondApproverName: process.env.PLAN_SECOND_APPROVER_NAME || '',
  photosShareLabel: process.env.PHOTOS_SHARE_LABEL || '',
  geminiApiKey: process.env.GEMINI_API_KEY || '',
};
