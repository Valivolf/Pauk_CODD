import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, settings } from './config.ts';

const PREFIX = 'enc:v1:';
let currentKeyBase64 = settings.fieldEncryptionKey;

function parseKey(raw: string): Buffer {
  const cleaned = raw.trim();
  const buf = Buffer.from(cleaned.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length === 32) return buf;
  return crypto.createHash('sha256').update(cleaned, 'utf-8').digest();
}

export function getFieldKeyBase64(): string {
  return currentKeyBase64;
}

export function setFieldKey(newKey: string): void {
  const trimmed = newKey.trim();
  if (!trimmed) throw new Error('Ключ не может быть пустым');
  currentKeyBase64 = trimmed;
  try {
    fs.writeFileSync(path.join(DATA_DIR, '.field_key'), trimmed, { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // ignore
  }
}

export function isEncryptedValue(val: string | null | undefined): boolean {
  return typeof val === 'string' && val.startsWith(PREFIX);
}

export function encryptField(plain: string | null | undefined): string {
  const s = plain ?? '';
  if (!s) return '';
  if (s.startsWith(PREFIX)) return s;
  const key = parseKey(currentKeyBase64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(s, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, enc]).toString('base64url');
}

export function decryptField(stored: string | null | undefined): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  try {
    const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
    const iv = raw.subarray(0, 12);
    const tag = raw.subarray(12, 28);
    const data = raw.subarray(28);
    const key = parseKey(currentKeyBase64);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return '[зашифровано другим ключом]';
  }
}

export function tryDecryptWithKey(stored: string, keyStr: string): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  const raw = Buffer.from(stored.slice(PREFIX.length), 'base64url');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const key = parseKey(keyStr);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
}
