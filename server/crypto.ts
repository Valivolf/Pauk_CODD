import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { DATA_DIR, settings } from './config.ts';

const PREFIX = 'enc:v1:';
const CACHE_LIMIT = 20000;

export const SQLITE_FIELD_FUNCTIONS: Record<string, string> = {
  'people.full_name': 'lc_dec_pfn',
  'people.phone': 'lc_dec_pph',
  'points.login': 'lc_dec_plg',
  'points.password': 'lc_dec_ppw',
};

const KNOWN_FIELDS = [...Object.keys(SQLITE_FIELD_FUNCTIONS), 'photo_storage.password'];

let currentKeyBase64 = settings.fieldEncryptionKey;
const decryptCache = new Map<string, string>();
let failuresCount = 0;

function parseKey(raw: string): Buffer {
  const cleaned = raw.trim();
  const padded = cleaned + '='.repeat((4 - (cleaned.length % 4)) % 4);
  const buf = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (buf.length === 32) return buf;
  return crypto.createHash('sha256').update(cleaned, 'utf-8').digest();
}

export function getFieldKeyBase64(): string {
  const key = parseKey(currentKeyBase64);
  return key.toString('base64url');
}

export function getKeyFingerprint(keyStr = currentKeyBase64): string {
  const key = parseKey(keyStr);
  return crypto
    .createHash('sha256')
    .update(Buffer.concat([Buffer.from('lc-field-key:', 'utf-8'), key]))
    .digest('hex')
    .slice(0, 8);
}

export function getKeySource(): string {
  if ((process.env.FIELD_ENCRYPTION_KEY || '').trim()) {
    return 'переменная FIELD_ENCRYPTION_KEY';
  }
  return 'файл .field_key в папке данных';
}

export function getEncryptionFailures(): number {
  return failuresCount;
}

export function resetEncryptionStats(): void {
  failuresCount = 0;
  decryptCache.clear();
}

export function setFieldKey(newKey: string): void {
  const trimmed = newKey.trim();
  if (!trimmed) throw new Error('Ключ не может быть пустым');
  const keyBuf = parseKey(trimmed);
  const normalized = keyBuf.toString('base64url');
  const keyPath = path.join(DATA_DIR, '.field_key');
  try {
    if (fs.existsSync(keyPath)) {
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      fs.renameSync(keyPath, path.join(DATA_DIR, `.field_key.old-${stamp}`));
    }
    fs.writeFileSync(keyPath, normalized + '\n', { encoding: 'utf-8', mode: 0o600 });
  } catch {
    // ignore write error on readonly fs
  }
  currentKeyBase64 = normalized;
  failuresCount = 0;
  decryptCache.clear();
}

export function isEncryptedValue(val: string | null | undefined): boolean {
  return typeof val === 'string' && val.startsWith(PREFIX);
}

function tryAesGcmDecrypt(raw: Buffer, key: Buffer, tagAtEnd: boolean, aad?: string): string | null {
  if (raw.length < 28) return null;
  try {
    const iv = raw.subarray(0, 12);
    const tag = tagAtEnd ? raw.subarray(raw.length - 16) : raw.subarray(12, 28);
    const data = tagAtEnd ? raw.subarray(12, raw.length - 16) : raw.subarray(28);
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    if (aad) {
      decipher.setAAD(Buffer.from(aad, 'utf-8'));
    }
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf-8');
  } catch {
    return null;
  }
}

function decryptWithKeyInternal(stored: string, key: Buffer, fieldHint?: string): string | null {
  const payload = stored.slice(PREFIX.length).trim();
  const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
  const raw = Buffer.from(padded.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (raw.length < 28) return null;

  // 1. Try CODD_SPIDER Python AESGCM format (nonce[12] + ciphertext + tag[16] with field AAD)
  const fieldsToTry = fieldHint
    ? [fieldHint, ...KNOWN_FIELDS.filter((f) => f !== fieldHint)]
    : KNOWN_FIELDS;
  for (const field of fieldsToTry) {
    const res = tryAesGcmDecrypt(raw, key, true, field);
    if (res !== null) return res;
  }

  // 2. Try Pauk_CODD legacy format (nonce[12] + tag[16] + ciphertext, no AAD)
  const legacyRes = tryAesGcmDecrypt(raw, key, false);
  if (legacyRes !== null) return legacyRes;

  // 3. Try tag-at-end without AAD
  return tryAesGcmDecrypt(raw, key, true);
}

export function encryptField(plain: string | null | undefined, field = 'people.full_name'): string {
  const s = plain ?? '';
  if (!s) return '';
  if (s.startsWith(PREFIX)) return s;
  const key = parseKey(currentKeyBase64);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(field, 'utf-8'));
  const enc = Buffer.concat([cipher.update(s, 'utf-8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Store in CODD_SPIDER-compatible format: nonce (12B) + ciphertext + tag (16B)
  return PREFIX + Buffer.concat([iv, enc, tag]).toString('base64url');
}

export function decryptField(stored: string | null | undefined, fieldHint?: string): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  const cacheKey = fieldHint ? `${fieldHint}:${stored}` : stored;
  const cached = decryptCache.get(cacheKey);
  if (cached !== undefined) return cached;

  const key = parseKey(currentKeyBase64);
  const plain = decryptWithKeyInternal(stored, key, fieldHint);
  if (plain === null) {
    failuresCount += 1;
    return '';
  }
  if (decryptCache.size >= CACHE_LIMIT) {
    decryptCache.clear();
  }
  decryptCache.set(cacheKey, plain);
  return plain;
}

export function tryDecryptWithKey(stored: string, keyStr: string, fieldHint?: string): string {
  if (!stored) return '';
  if (!stored.startsWith(PREFIX)) return stored;
  const key = parseKey(keyStr);
  const plain = decryptWithKeyInternal(stored, key, fieldHint);
  if (plain === null) {
    throw new Error('Не удалось расшифровать данным ключом');
  }
  return plain;
}

export function registerSqliteCryptoFunctions(db: DatabaseSync): void {
  for (const [field, fnName] of Object.entries(SQLITE_FIELD_FUNCTIONS)) {
    db.function(fnName, { deterministic: true }, (val: unknown) => {
      if (val === null || val === undefined || val === '') return (val as string | null) ?? null;
      return decryptField(String(val), field);
    });
  }
}
