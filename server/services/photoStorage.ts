import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, PHOTOS_DIR, ROOT_DIR, settings } from '../config.ts';
import { decryptField, encryptField, isEncryptedValue } from '../crypto.ts';
import { getDb, nowIso } from '../db.ts';

const CONFIG_KEY = 'photo_storage';
const LEGACY_CONFIG_KEY = 'photo_storage_config';
const PASSWORD_FIELD = 'photo_storage.password';
const MARKER_FILE = '.lan-calendar-photos';
const OLD_MARKER_FILE = '.lan_calendar_photo_store';

export const LEGACY_PHOTOS_DIR = path.join(DATA_DIR, 'visit_photos');
export const SPOOL_PHOTOS_DIR = path.join(DATA_DIR, 'visit_photos_spool');
const OLD_SPOOL_DIR = path.join(DATA_DIR, 'photo_spool');

const SMB_WORKER_PATH = path.join(ROOT_DIR, 'server', 'services', 'smb_worker.py');

const IMAGE_EXTS = new Set([
  'jpg',
  'jpeg',
  'jpe',
  'jfif',
  'png',
  'gif',
  'webp',
  'bmp',
  'heic',
  'heif',
  'tif',
  'tiff',
]);

const SKIP_DIRS = new Set([
  '@eadir',
  '#recycle',
  '$recycle.bin',
  '__macosx',
  'thumbs',
  '.thumbnails',
  'system volume information',
]);

export class PhotoStorageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PhotoStorageError';
  }
}

export interface SmbConfig {
  mode: 'smb' | 'none' | '';
  server?: string;
  share?: string;
  folder?: string;
  port?: number;
  domain?: string;
  username?: string;
  password?: string;
  organize?: boolean;
}

const QUOTES_SET = new Set(['"', "'", '`', '«', '»', '“', '”', '„', '‘', '’', '‹', '›']);

function cleanPathText(raw: string): string {
  let text = String(raw || '')
    .replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g, '')
    .replace(/[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000\r\n\t]/g, ' ')
    .trim();
  while (text.length >= 2 && QUOTES_SET.has(text[0]) && QUOTES_SET.has(text[text.length - 1])) {
    text = text.slice(1, -1).trim();
  }
  while (text.length > 0 && (QUOTES_SET.has(text[0]) || text[0] === ' ')) text = text.slice(1);
  while (text.length > 0 && (QUOTES_SET.has(text[text.length - 1]) || text[text.length - 1] === ' ')) text = text.slice(0, -1);
  return text;
}

export function parseSharePath(rawPath: string): { server: string; share: string; folder: string } {
  let text = cleanPathText(rawPath);
  const low = text.toLowerCase().replace(/\\/g, '/');
  for (const prefix of ['smb://', 'cifs://', 'file://']) {
    if (low.startsWith(prefix)) {
      try {
        text = decodeURIComponent(text.slice(prefix.length));
      } catch {
        text = text.slice(prefix.length);
      }
      break;
    }
  }
  text = text.replace(/\\/g, '/');
  if (text.toLowerCase().startsWith('//?/unc/')) {
    text = text.slice(8);
  }
  if (/^[A-Za-z]:(\/|$)/.test(text)) {
    throw new PhotoStorageError(
      `«${text.slice(0, 2)}» — это буква сетевого диска на вашем компьютере, а приложение стоит на сервере и её не знает. ` +
        'Нужен полный сетевой путь вида \\\\сервер\\общая_папка\\папка: в проводнике нажмите правой кнопкой на диске → «Свойства» ' +
        '(там видно «\\\\сервер\\папка»), либо выполните в командной строке «net use».',
    );
  }
  const parts = text
    .split('/')
    .map((p) => p.trim())
    .filter(Boolean);
  if (parts.length < 2) {
    throw new PhotoStorageError(
      'Путь должен выглядеть так: \\\\сервер\\общая_папка\\папка_с_комплексами (например \\\\192.168.1.10\\photos\\Комплексы)',
    );
  }
  for (const p of parts) {
    if (p === '.' || p === '..' || [...p].some((c) => c.charCodeAt(0) < 32)) {
      throw new PhotoStorageError('В пути есть недопустимые символы');
    }
  }
  return {
    server: parts[0],
    share: parts[1],
    folder: parts.slice(2).join('/'),
  };
}

export function safePhotoFolderName(name: string): string {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '')
    .replace(/^[ .]+|[ .]+$/g, '');
  return cleaned || 'point';
}

const ISO_DIR_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DMY_DIR_RE = /^(\d{2})-(\d{2})-(\d{4})$/;

export function dateDir(iso: string): string {
  const m = ISO_DIR_RE.exec(String(iso || ''));
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso || '');
}

export function flipDateDirs(rel: string): string {
  return String(rel || '')
    .split('/')
    .map((part) => {
      const m = ISO_DIR_RE.exec(part) || DMY_DIR_RE.exec(part);
      return m ? `${m[3]}-${m[2]}-${m[1]}` : part;
    })
    .join('/');
}

export function photoRelPath(
  photo: { id: number; point_id: string; taken_date: string; file_ext: string; rel_path?: string | null },
  safe = true,
): string {
  if (photo.rel_path) {
    return String(photo.rel_path).replace(/\\/g, '/');
  }
  const folder = safe ? safePhotoFolderName(photo.point_id) : String(photo.point_id);
  return `${folder}/${dateDir(photo.taken_date)}/${photo.id}.${photo.file_ext}`;
}

export function photoRelVariants(
  photo: { id: number; point_id: string; taken_date: string; file_ext: string; rel_path?: string | null },
  safe = true,
): string[] {
  const main = photoRelPath(photo, safe);
  const flipped = flipDateDirs(main);
  return flipped === main ? [main] : [main, flipped];
}

// ---------- Name folding & matching (matches CODD_SPIDER app/core/names.py & photo_index.py) ----------
const LOOKALIKE_MAP: Record<string, string> = {
  a: 'а',
  b: 'в',
  c: 'с',
  e: 'е',
  h: 'н',
  k: 'к',
  m: 'м',
  o: 'о',
  p: 'р',
  t: 'т',
  x: 'х',
  y: 'у',
};

export function foldName(text: unknown): string {
  let s = String(text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[abcehkmoptxy]/g, (ch) => LOOKALIKE_MAP[ch] || ch)
    .replace(/аrеnа/g, 'арена');
  s = s.replace(/(арена)[\W_]*[сs]м(?=[\W_\d]|$)/gu, '$1');
  return s;
}

export function nameTokens(text: unknown): string[] {
  return foldName(text).match(/[\p{L}]+|\d+/gu) || [];
}

function isTokenBlocked(t: string[], i: number, j: number): boolean {
  const key = t.slice(i, j);
  const isDigit = (s: string) => /^\d+$/.test(s);
  const isSingleAlpha = (s: string) => /^\p{L}$/u.test(s);
  if (isDigit(key[key.length - 1]) && j < t.length && isSingleAlpha(t[j])) return true;
  if (isDigit(key[0]) && i > 0 && isSingleAlpha(t[i - 1])) return true;
  return false;
}

export function matchFoldersToPoints(
  folders: string[],
  pointIds: string[],
): { matches: Map<string, string>; ambiguous: string[] } {
  const byCompact = new Map<string, string[]>();
  const byTokens = new Map<string, string[]>();

  for (const pid of pointIds) {
    const t = nameTokens(pid);
    if (!t.length) continue;
    const compact = t.join('');
    const listC = byCompact.get(compact) || [];
    listC.push(pid);
    byCompact.set(compact, listC);

    const tKey = t.join('\u0001');
    const listT = byTokens.get(tKey) || [];
    listT.push(pid);
    byTokens.set(tKey, listT);
  }

  const matches = new Map<string, string>();
  const ambiguous: string[] = [];

  for (const folder of folders) {
    const t = nameTokens(folder);
    if (!t.length) continue;
    const exact = byCompact.get(t.join(''));
    if (exact && exact.length > 0) {
      const uniq = [...new Set(exact)];
      if (uniq.length === 1) matches.set(folder, uniq[0]);
      else ambiguous.push(folder);
      continue;
    }

    let bestLen = 0;
    let bestChars = 0;
    let bestIds: string[] = [];

    for (let i = 0; i < t.length; i++) {
      for (let j = i + 1; j <= t.length; j++) {
        const sub = t.slice(i, j);
        const hit = byTokens.get(sub.join('\u0001'));
        if (!hit || isTokenBlocked(t, i, j)) continue;
        const lenScore = j - i;
        const charScore = sub.reduce((acc, s) => acc + s.length, 0);
        if (lenScore > bestLen || (lenScore === bestLen && charScore > bestChars)) {
          bestLen = lenScore;
          bestChars = charScore;
          bestIds = [...hit];
        } else if (lenScore === bestLen && charScore === bestChars) {
          bestIds.push(...hit);
        }
      }
    }

    if (bestIds.length > 0) {
      const uniq = [...new Set(bestIds)];
      if (uniq.length === 1) matches.set(folder, uniq[0]);
      else ambiguous.push(folder);
    }
  }

  return { matches, ambiguous };
}

// ---------- Date extraction for imported photos ----------
const YMD_RE = /(?<!\d)((?:19|20)\d{2})[-._ /](0?[1-9]|1[0-2])[-._ /](0?[1-9]|[12]\d|3[01])(?!\d)/;
const DMY_RE = /(?<!\d)(0?[1-9]|[12]\d|3[01])[-._ /](0?[1-9]|1[0-2])[-._ /]((?:19|20)\d{2})(?!\d)/;
const YMD8_RE = /(?<!\d)((?:19|20)\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?!\d)/;
const DMY8_RE = /(?<!\d)(0[1-9]|[12]\d|3[01])(0[1-9]|1[0-2])((?:19|20)\d{2})(?!\d)/;

function validIsoDate(y: number, m: number, d: number): string | null {
  const todayYear = new Date().getFullYear() + 1;
  if (y < 2000 || y > todayYear || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function dateFromMtime(mtimeSec: number): string {
  const dt = new Date((mtimeSec || Date.now() / 1000) * 1000);
  const y = dt.getFullYear();
  const m = String(dt.getMonth() + 1).padStart(2, '0');
  const d = String(dt.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractPhotoDate(rel: string, mtimeSec: number): string {
  const parts = rel.split('/').slice(1); // skip top complex folder name (which may contain numbers)
  for (let idx = parts.length - 1; idx >= 0; idx--) {
    const part = parts[idx];
    let m = YMD_RE.exec(part);
    if (m) {
      const iso = validIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) return iso;
    }
    m = DMY_RE.exec(part);
    if (m) {
      const iso = validIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));
      if (iso) return iso;
    }
    m = YMD8_RE.exec(part);
    if (m) {
      const iso = validIsoDate(Number(m[1]), Number(m[2]), Number(m[3]));
      if (iso) return iso;
    }
    m = DMY8_RE.exec(part);
    if (m) {
      const iso = validIsoDate(Number(m[3]), Number(m[2]), Number(m[1]));
      if (iso) return iso;
    }
  }
  return dateFromMtime(mtimeSec);
}

// ---------- Python SMB Worker RPC ----------
function callSmbWorker<T = any>(payload: Record<string, unknown>, timeoutMs = 30000): Promise<T> {
  return new Promise((resolve, reject) => {
    const proc = spawn('python3', [SMB_WORKER_PATH], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        proc.kill('SIGKILL');
      } catch {
        // ignore
      }
      reject(new Error('диск не отвечает (таймаут)'));
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString('utf-8');
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString('utf-8');
    });
    proc.on('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new Error(`Не удалось запустить SMB-клиент: ${err.message}`));
    });
    proc.on('close', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const trimmed = stdout.trim();
      if (!trimmed) {
        reject(new Error(stderr.trim() || 'Пустой ответ SMB-клиента'));
        return;
      }
      try {
        const parsed = JSON.parse(trimmed);
        if (!parsed.ok) {
          const err = new Error(parsed.error || 'Ошибка SMB') as Error & { missing?: boolean };
          err.missing = Boolean(parsed.missing);
          reject(err);
          return;
        }
        resolve(parsed.result as T);
      } catch {
        reject(new Error(stderr.trim() || trimmed.slice(0, 200)));
      }
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();
  });
}

// ---------- Config loading & saving ----------
function dumpCfgForDb(cfg: SmbConfig): string {
  const out: Record<string, unknown> = { ...cfg };
  if (out.password && typeof out.password === 'string') {
    out.password = encryptField(out.password, PASSWORD_FIELD);
  }
  return JSON.stringify(out);
}

export function loadSavedSmbConfig(): SmbConfig {
  const db = getDb();
  let row = db.prepare('SELECT value FROM app_flags WHERE key = ?').get(CONFIG_KEY) as { value: string } | undefined;
  let fromLegacyKey = false;
  if (!row) {
    row = db.prepare('SELECT value FROM app_flags WHERE key = ?').get(LEGACY_CONFIG_KEY) as { value: string } | undefined;
    fromLegacyKey = Boolean(row);
  }
  if (!row || !row.value) {
    return { mode: 'none', organize: true };
  }
  let parsed: Record<string, unknown> = {};
  try {
    parsed = JSON.parse(row.value);
  } catch {
    return { mode: 'none', organize: true };
  }

  // Handle legacy path-only format if saved by earlier stub
  if (parsed.mode === 'smb' && !parsed.server && typeof parsed.path === 'string' && parsed.path.trim()) {
    try {
      const sp = parseSharePath(parsed.path);
      parsed.server = sp.server;
      parsed.share = sp.share;
      parsed.folder = sp.folder;
    } catch {
      // ignore
    }
  }

  let password = '';
  if (typeof parsed.password === 'string' && parsed.password && parsed.password !== '***') {
    password = decryptField(parsed.password, PASSWORD_FIELD);
    if (!isEncryptedValue(parsed.password) || fromLegacyKey) {
      const migrated: SmbConfig = {
        mode: parsed.mode === 'smb' ? 'smb' : 'none',
        server: String(parsed.server || ''),
        share: String(parsed.share || ''),
        folder: String(parsed.folder || ''),
        port: Number(parsed.port || 445),
        domain: String(parsed.domain || ''),
        username: String(parsed.username || ''),
        password,
        organize: parsed.organize !== false,
      };
      try {
        db.prepare(
          'INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
        ).run(CONFIG_KEY, dumpCfgForDb(migrated));
      } catch {
        // ignore
      }
    }
  }

  return {
    mode: parsed.mode === 'smb' ? 'smb' : 'none',
    server: String(parsed.server || '').trim(),
    share: String(parsed.share || '').trim(),
    folder: String(parsed.folder || '')
      .replace(/\\/g, '/')
      .split('/')
      .filter(Boolean)
      .join('/'),
    port: Number(parsed.port || 445),
    domain: String(parsed.domain || '').trim(),
    username: String(parsed.username || '').trim(),
    password,
    organize: parsed.organize !== false,
  };
}

function formatUncTarget(cfg: SmbConfig): string {
  if (!cfg.server || !cfg.share) return '';
  return `\\\\${cfg.server}\\${cfg.share}${cfg.folder ? `\\${cfg.folder.replace(/\//g, '\\')}` : ''}`;
}

function getEnvFolderBackendDir(): string | null {
  const envRaw = (process.env.PHOTOS_DIR || '').trim();
  if (!envRaw) return null;
  const resolved = path.resolve(ROOT_DIR, envRaw);
  if (path.resolve(resolved) === path.resolve(LEGACY_PHOTOS_DIR)) return null;
  return resolved;
}

export function getPhotoStorageConfigView(cfg?: SmbConfig) {
  const c = cfg || loadSavedSmbConfig();
  const envFolder = getEnvFolderBackendDir();
  return {
    mode: c.mode === 'smb' && c.server && c.share ? 'smb' : 'none',
    path: c.server && c.share ? formatUncTarget(c) : '',
    port: Number(c.port || 445),
    domain: c.domain || '',
    username: c.username || '',
    password_set: Boolean(c.password),
    env_folder: envFolder || '',
    organize: c.organize !== false,
  };
}

// ---------- Runtime state & probe cache ----------
const probeCache = {
  at: 0,
  ok: true,
  reason: '',
  running: false,
};

const runtimeState = {
  scan: null as null | {
    at: string;
    share: { files: number; bytes: number } | null;
    spool: { files: number; bytes: number } | null;
    local: { files: number; bytes: number };
  },
  migration: {
    state: 'idle',
    total: 0,
    done: 0,
    failed: 0,
    bytes: 0,
    started_at: '',
    finished_at: '',
    message: '',
  },
  index: {
    state: 'idle',
    auto: false,
    started_at: '',
    finished_at: '',
    folders: 0,
    matched: 0,
    done: 0,
    found: 0,
    added: 0,
    moved: 0,
    renamed: 0,
    removed: 0,
    errors: 0,
    message: '',
    unmatched: [] as string[],
    unmatched_count: 0,
    ambiguous: [] as string[],
  },
};

function getDiskUsage(dirPath: string): { total: number; free: number } | null {
  try {
    const target = fs.existsSync(dirPath) ? dirPath : DATA_DIR;
    const st = fs.statfsSync(target);
    return {
      total: Number(st.blocks) * Number(st.bsize),
      free: Number(st.bavail) * Number(st.bsize),
    };
  } catch {
    return null;
  }
}

function scanLocalDir(root: string): { files: number; bytes: number } {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name.endsWith('.part')) continue;
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        files += 1;
        try {
          bytes += fs.statSync(full).size;
        } catch {
          // ignore
        }
      }
    }
  };
  walk(root);
  return { files, bytes };
}

function activeBackendKind(cfg: SmbConfig): 'smb' | 'folder' | '' {
  if (cfg.mode === 'smb' && cfg.server && cfg.share) return 'smb';
  if (getEnvFolderBackendDir()) return 'folder';
  return '';
}

export async function checkShareState(force = false): Promise<{ ok: boolean; reason: string }> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  if (!kind) {
    return { ok: true, reason: '' };
  }
  const now = Date.now();
  if (!force && now - probeCache.at < 10000) {
    return { ok: probeCache.ok, reason: probeCache.reason };
  }
  if (probeCache.running) {
    return { ok: probeCache.ok, reason: probeCache.reason || 'диск проверяется' };
  }
  probeCache.running = true;
  try {
    if (kind === 'smb') {
      const res = await callSmbWorker<{ ok: boolean; message: string }>(
        { op: 'probe', cfg, isolated: false },
        25000,
      );
      probeCache.ok = Boolean(res.ok);
      probeCache.reason = res.message || '';
    } else {
      const folder = getEnvFolderBackendDir()!;
      if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
        probeCache.ok = false;
        probeCache.reason = 'папка хранилища недоступна — сетевой диск не подключён к серверу';
      } else if (
        !fs.existsSync(path.join(folder, MARKER_FILE)) &&
        !fs.existsSync(path.join(folder, OLD_MARKER_FILE))
      ) {
        probeCache.ok = false;
        probeCache.reason =
          'в папке нет метки хранилища: диск не подключён или ещё не подготовлен (кнопка «Подготовить диск»)';
      } else {
        const testFile = path.join(folder, `.write-test-${process.pid}`);
        try {
          fs.writeFileSync(testFile, '1');
          fs.unlinkSync(testFile);
          probeCache.ok = true;
          probeCache.reason = '';
        } catch (err) {
          probeCache.ok = false;
          probeCache.reason = `на сетевой диск нельзя записать: ${(err as Error).message}`;
        }
      }
    }
  } catch (err) {
    probeCache.ok = false;
    probeCache.reason = (err as Error).message || 'диск не отвечает';
  } finally {
    probeCache.at = Date.now();
    probeCache.running = false;
  }
  return { ok: probeCache.ok, reason: probeCache.reason };
}

export async function getPhotoStorageStatus(includeConfig = false): Promise<Record<string, unknown>> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  const { ok, reason } = await checkShareState(true);

  let shareDisk: { total: number; free: number } | null = null;
  if (kind === 'smb' && ok) {
    try {
      shareDisk = await callSmbWorker<{ total: number; free: number } | null>({ op: 'usage', cfg }, 10000);
    } catch {
      shareDisk = null;
    }
  } else if (kind === 'folder' && ok) {
    shareDisk = getDiskUsage(getEnvFolderBackendDir()!);
  }

  const localServer = scanLocalDir(LEGACY_PHOTOS_DIR);
  const spoolA = scanLocalDir(SPOOL_PHOTOS_DIR);
  const spoolB = scanLocalDir(OLD_SPOOL_DIR);
  const bufferStats = { files: spoolA.files + spoolB.files, bytes: spoolA.bytes + spoolB.bytes };

  const out: Record<string, unknown> = {
    configured: Boolean(kind),
    mode: kind,
    path: kind === 'smb' ? formatUncTarget(cfg) : kind === 'folder' ? getEnvFolderBackendDir() || '' : LEGACY_PHOTOS_DIR,
    label: settings.photosShareLabel || '',
    available: ok,
    reason,
    local_disk: getDiskUsage(DATA_DIR),
    share_disk: shareDisk,
    migration: { ...runtimeState.migration },
    needs_marker: kind === 'folder',
    scan: runtimeState.scan,
    server_files: {
      server: localServer,
      buffer: bufferStats,
    },
    index: {
      ...runtimeState.index,
      unmatched: [...runtimeState.index.unmatched],
      ambiguous: [...runtimeState.index.ambiguous],
    },
    organize: cfg.organize !== false,
  };

  if (includeConfig) {
    out.config = getPhotoStorageConfigView(cfg);
  }
  return out;
}

export async function testPhotoStorageConnection(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const port = Number(data.port || 445);
  if (!Number.isFinite(port) || port < 1 || port > 65535) {
    throw new PhotoStorageError('Порт — число от 1 до 65535');
  }
  const { server, share, folder } = parseSharePath(String(data.path || ''));
  const saved = loadSavedSmbConfig();
  const password = String(data.password || '') || saved.password || '';
  const cfg: SmbConfig = {
    mode: 'smb',
    server,
    share,
    folder,
    port,
    domain: String(data.domain || '').trim(),
    username: String(data.username || '').trim(),
    password,
  };
  return await callSmbWorker<Record<string, unknown>>(
    { op: 'probe', cfg, isolated: true, with_sample: true },
    28000,
  );
}

export async function savePhotoStorageConfig(data: Record<string, unknown>): Promise<Record<string, unknown>> {
  const mode = String(data.mode || 'smb') === 'smb' ? 'smb' : 'none';
  const prev = loadSavedSmbConfig();
  const next: SmbConfig = {
    ...prev,
    mode,
  };

  if (mode === 'smb') {
    const port = Number(data.port || 445);
    if (!Number.isFinite(port) || port < 1 || port > 65535) {
      throw new PhotoStorageError('Порт — число от 1 до 65535');
    }
    const { server, share, folder } = parseSharePath(String(data.path || ''));
    next.server = server;
    next.share = share;
    next.folder = folder;
    next.port = port;
    next.domain = String(data.domain || '').trim();
    next.username = String(data.username || '').trim();
    if (String(data.password || '')) {
      next.password = String(data.password);
    }
    if (data.organize !== undefined && data.organize !== null) {
      next.organize = Boolean(data.organize);
    }

    // Автоматическое уточнение регистра/написания общей папки по списку сервера
    try {
      const probeRes = await callSmbWorker<{ ok: boolean; share?: string; share_fixed?: boolean }>(
        { op: 'probe', cfg: next, isolated: true },
        25000,
      );
      if (probeRes.share_fixed && probeRes.share && probeRes.share !== next.share) {
        next.share = probeRes.share;
      }
    } catch {
      // сохраняем как есть, даже если диск сейчас выключен
    }
  }

  const db = getDb();
  const dumped = dumpCfgForDb(next);
  db.prepare(
    'INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(CONFIG_KEY, dumped);
  db.prepare('DELETE FROM app_flags WHERE key = ?').run(LEGACY_CONFIG_KEY);

  probeCache.at = 0;
  if (mode === 'smb') {
    void startPhotoIndex(true).catch(() => {});
  }
  return await getPhotoStorageStatus(true);
}

export async function scanPhotoStorage(): Promise<Record<string, unknown>> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  const { ok } = await checkShareState(false);

  let shareScan: { files: number; bytes: number } | null = null;
  if (kind === 'smb' && ok) {
    try {
      shareScan = await callSmbWorker<{ files: number; bytes: number }>({ op: 'scan', cfg }, 600000);
    } catch {
      shareScan = null;
    }
  } else if (kind === 'folder' && ok) {
    shareScan = scanLocalDir(getEnvFolderBackendDir()!);
  }

  const spoolA = scanLocalDir(SPOOL_PHOTOS_DIR);
  const spoolB = scanLocalDir(OLD_SPOOL_DIR);
  runtimeState.scan = {
    at: nowIso(),
    share: shareScan,
    spool: kind ? { files: spoolA.files + spoolB.files, bytes: spoolA.bytes + spoolB.bytes } : null,
    local: scanLocalDir(LEGACY_PHOTOS_DIR),
  };
  return await getPhotoStorageStatus(true);
}

export async function initPhotoStorageMarker(): Promise<Record<string, unknown>> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  if (kind !== 'folder') {
    throw new PhotoStorageError('Метка нужна только для папки, подключённой на сервере (PHOTOS_DIR)');
  }
  const folder = getEnvFolderBackendDir()!;
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new PhotoStorageError('Папка хранилища недоступна — сначала подключите сетевой диск к серверу');
  }
  try {
    fs.writeFileSync(path.join(folder, MARKER_FILE), `lan-calendar photo storage ${nowIso()}\n`, 'utf-8');
  } catch (err) {
    throw new PhotoStorageError(`Не удалось записать метку на диск: ${(err as Error).message}`);
  }
  probeCache.at = 0;
  return await getPhotoStorageStatus(true);
}

// ---------- File storage operations (store, read, delete, flush, migrate) ----------
function writeLocalAtomic(dstPath: string, content: Buffer): void {
  fs.mkdirSync(path.dirname(dstPath), { recursive: true });
  const tmp = `${dstPath}.part`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dstPath);
}

export async function storeVisitPhoto(
  photo: { id: number; point_id: string; taken_date: string; file_ext: string; rel_path?: string | null },
  content: Buffer,
): Promise<{ storage: 'share' | 'spool' | 'local'; storagePath: string; relPath: string }> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  const rel = photoRelPath(photo, true);

  if (!kind) {
    const dst = path.join(LEGACY_PHOTOS_DIR, ...rel.split('/'));
    writeLocalAtomic(dst, content);
    return { storage: 'local', storagePath: dst, relPath: rel };
  }

  const { ok } = await checkShareState(false);
  if (ok) {
    try {
      if (kind === 'smb') {
        await callSmbWorker(
          { op: 'write', cfg, rel, content_b64: content.toString('base64') },
          40000,
        );
        return { storage: 'share', storagePath: '', relPath: rel };
      } else {
        const folder = getEnvFolderBackendDir()!;
        const dst = path.join(folder, ...rel.split('/'));
        writeLocalAtomic(dst, content);
        return { storage: 'share', storagePath: dst, relPath: rel };
      }
    } catch {
      probeCache.ok = false;
      probeCache.reason = 'запись на сетевой диск не удалась';
      probeCache.at = Date.now();
    }
  }

  const spoolDst = path.join(SPOOL_PHOTOS_DIR, ...rel.split('/'));
  writeLocalAtomic(spoolDst, content);
  return { storage: 'spool', storagePath: spoolDst, relPath: rel };
}

function localCandidatePaths(photo: {
  id: number;
  point_id: string;
  taken_date: string;
  file_ext: string;
  storage_path?: string | null;
  rel_path?: string | null;
}): string[] {
  const out: string[] = [];
  const add = (p: string) => {
    if (p && !out.includes(p)) out.push(p);
  };
  if (photo.storage_path && !photo.storage_path.startsWith('\\\\')) {
    add(photo.storage_path);
  }
  const roots = [SPOOL_PHOTOS_DIR, OLD_SPOOL_DIR, LEGACY_PHOTOS_DIR];
  const envDir = getEnvFolderBackendDir();
  if (envDir) roots.push(envDir);
  if (PHOTOS_DIR && !roots.includes(PHOTOS_DIR)) roots.push(PHOTOS_DIR);

  for (const root of roots) {
    for (const safe of [true, false]) {
      for (const rel of photoRelVariants(photo, safe)) {
        add(path.join(root, ...rel.split('/')));
      }
    }
    // Also check raw ISO taken_date directory (YYYY-MM-DD) directly
    const seg = safePhotoFolderName(photo.point_id);
    add(path.join(root, seg, photo.taken_date, `${photo.id}.${photo.file_ext}`));
  }
  return out;
}

export async function readVisitPhotoBuffer(photo: {
  id: number;
  point_id: string;
  taken_date: string;
  file_ext: string;
  storage_path?: string | null;
  rel_path?: string | null;
}): Promise<Buffer | null> {
  for (const p of localCandidatePaths(photo)) {
    try {
      if (fs.existsSync(p) && fs.statSync(p).isFile()) {
        return fs.readFileSync(p);
      }
    } catch {
      // continue
    }
  }

  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  if (kind === 'smb') {
    const rels: string[] = [];
    for (const safe of [true, false]) {
      for (const r of photoRelVariants(photo, safe)) {
        if (!rels.includes(r)) rels.push(r);
      }
    }
    try {
      const b64 = await callSmbWorker<string | null>({ op: 'read_first', cfg, rels }, 40000);
      if (b64) {
        return Buffer.from(b64, 'base64');
      }
    } catch {
      return null;
    }
  }
  return null;
}

export async function deleteVisitPhotoFiles(photo: {
  id: number;
  point_id: string;
  taken_date: string;
  file_ext: string;
  storage_path?: string | null;
  rel_path?: string | null;
}): Promise<void> {
  for (const p of localCandidatePaths(photo)) {
    try {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    } catch {
      // ignore
    }
  }
  const cfg = loadSavedSmbConfig();
  if (activeBackendKind(cfg) === 'smb') {
    const rels = photoRelVariants(photo, true);
    try {
      await callSmbWorker({ op: 'delete', cfg, rels }, 25000);
    } catch {
      // ignore
    }
  }
}

function iterLocalFiles(root: string): Array<{ fullPath: string; relPath: string }> {
  const out: Array<{ fullPath: string; relPath: string }> = [];
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.name.startsWith('.') || ent.name.endsWith('.part')) continue;
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(full);
      else if (ent.isFile()) {
        const rel = path.relative(root, full).split(path.sep).join('/');
        out.push({ fullPath: full, relPath: rel });
      }
    }
  };
  walk(root);
  return out;
}

function pruneEmptyDirs(root: string): void {
  if (!fs.existsSync(root)) return;
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    if (ent.isDirectory()) {
      const full = path.join(root, ent.name);
      pruneEmptyDirs(full);
      try {
        if (fs.readdirSync(full).length === 0) fs.rmdirSync(full);
      } catch {
        // ignore
      }
    }
  }
}

async function moveFileToBackend(srcPath: string, relPath: string, cfg: SmbConfig, kind: 'smb' | 'folder'): Promise<void> {
  if (kind === 'smb') {
    await callSmbWorker({ op: 'put_file', cfg, src_path: srcPath, rel: relPath }, 180000);
  } else {
    const folder = getEnvFolderBackendDir()!;
    const dst = path.join(folder, ...relPath.split('/'));
    const sz = fs.statSync(srcPath).size;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst) || fs.statSync(dst).size !== sz) {
      const tmp = `${dst}.part`;
      fs.copyFileSync(srcPath, tmp);
      if (fs.statSync(tmp).size !== sz) {
        fs.unlinkSync(tmp);
        throw new Error(`размер после копирования не совпал: ${path.basename(srcPath)}`);
      }
      fs.renameSync(tmp, dst);
    }
  }
  fs.unlinkSync(srcPath);
}

export async function flushPhotoSpool(): Promise<{ moved: number; failed: number; left: number; status: Record<string, unknown> }> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  if (!kind) {
    return { moved: 0, failed: 0, left: 0, status: await getPhotoStorageStatus(true) };
  }
  const { ok } = await checkShareState(false);
  const files = [...iterLocalFiles(SPOOL_PHOTOS_DIR), ...iterLocalFiles(OLD_SPOOL_DIR)];
  if (!ok || !files.length) {
    return { moved: 0, failed: 0, left: files.length, status: await getPhotoStorageStatus(true) };
  }
  let moved = 0;
  let failed = 0;
  const db = getDb();
  for (const f of files.slice(0, 300)) {
    try {
      await moveFileToBackend(f.fullPath, f.relPath, cfg, kind);
      db.prepare("UPDATE visit_photos SET storage = 'share', rel_path = coalesce(rel_path, ?) WHERE storage_path = ?").run(
        f.relPath,
        f.fullPath,
      );
      moved += 1;
    } catch {
      failed += 1;
      break;
    }
  }
  pruneEmptyDirs(SPOOL_PHOTOS_DIR);
  pruneEmptyDirs(OLD_SPOOL_DIR);
  return {
    moved,
    failed,
    left: Math.max(0, files.length - moved),
    status: await getPhotoStorageStatus(true),
  };
}

let migrationRunning = false;

export async function startPhotoMigration(): Promise<Record<string, unknown>> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  if (!kind) {
    throw new PhotoStorageError('Сетевой диск не настроен: задайте его в настройках («Настроить сетевой диск»)');
  }
  if (kind === 'folder' && path.resolve(getEnvFolderBackendDir()!) === path.resolve(LEGACY_PHOTOS_DIR)) {
    throw new PhotoStorageError('Папка хранилища совпадает с папкой фото на сервере — переносить нечего');
  }
  const { ok, reason } = await checkShareState(true);
  if (!ok) {
    throw new PhotoStorageError(`Сетевой диск сейчас недоступен: ${reason}`);
  }
  if (migrationRunning) {
    return await getPhotoStorageStatus(true);
  }

  const files = iterLocalFiles(LEGACY_PHOTOS_DIR);
  runtimeState.migration = {
    state: 'running',
    total: files.length,
    done: 0,
    failed: 0,
    bytes: 0,
    started_at: nowIso(),
    finished_at: '',
    message: '',
  };
  migrationRunning = true;

  setImmediate(async () => {
    const db = getDb();
    try {
      for (const f of files) {
        try {
          const sz = fs.existsSync(f.fullPath) ? fs.statSync(f.fullPath).size : 0;
          await moveFileToBackend(f.fullPath, f.relPath, cfg, kind);
          const stemMatch = /^(\d+)\.[A-Za-z0-9]+$/.exec(path.basename(f.relPath));
          if (stemMatch) {
            db.prepare("UPDATE visit_photos SET storage = 'share', rel_path = ? WHERE id = ?").run(
              f.relPath,
              Number(stemMatch[1]),
            );
          }
          runtimeState.migration.done += 1;
          runtimeState.migration.bytes += sz;
        } catch (err) {
          runtimeState.migration.failed += 1;
          runtimeState.migration.message = `${path.basename(f.fullPath)}: ${(err as Error).message}`;
        }
      }
      pruneEmptyDirs(LEGACY_PHOTOS_DIR);
      runtimeState.migration.state = runtimeState.migration.failed > 0 ? 'finished_with_errors' : 'done';
    } catch (err) {
      runtimeState.migration.state = 'error';
      runtimeState.migration.message = (err as Error).message.slice(0, 200);
    } finally {
      runtimeState.migration.finished_at = nowIso();
      migrationRunning = false;
    }
  });

  return await getPhotoStorageStatus(true);
}

// ---------- Photo Index (search existing folders on SMB share / folder) ----------
let indexRunning = false;

export async function startPhotoIndex(auto = false): Promise<Record<string, unknown>> {
  const cfg = loadSavedSmbConfig();
  const kind = activeBackendKind(cfg);
  if (!kind) {
    if (auto) return await getPhotoStorageStatus(true);
    throw new PhotoStorageError('Сетевой диск не настроен');
  }
  const { ok, reason } = await checkShareState(true);
  if (!ok) {
    if (auto) return await getPhotoStorageStatus(true);
    throw new PhotoStorageError(`Сетевой диск сейчас недоступен: ${reason}`);
  }
  if (indexRunning) {
    return await getPhotoStorageStatus(true);
  }

  indexRunning = true;
  const ix = runtimeState.index;
  ix.state = 'running';
  ix.auto = auto;
  ix.started_at = nowIso();
  ix.finished_at = '';
  ix.folders = 0;
  ix.matched = 0;
  ix.done = 0;
  ix.found = 0;
  ix.added = 0;
  ix.moved = 0;
  ix.renamed = 0;
  ix.removed = 0;
  ix.errors = 0;
  ix.message = '';
  ix.unmatched = [];
  ix.unmatched_count = 0;
  ix.ambiguous = [];

  setImmediate(async () => {
    const db = getDb();
    try {
      let folders: string[] = [];
      if (kind === 'smb') {
        folders = await callSmbWorker<string[]>({ op: 'list_folders', cfg }, 60000);
      } else {
        const root = getEnvFolderBackendDir()!;
        folders = fs
          .readdirSync(root, { withFileTypes: true })
          .filter((d) => d.isDirectory() && !d.name.startsWith('.') && !SKIP_DIRS.has(d.name.toLowerCase()))
          .map((d) => d.name)
          .sort();
      }
      ix.folders = folders.length;

      const pointRows = db.prepare('SELECT id FROM points').all() as Array<{ id: string }>;
      const pointIds = pointRows.map((r) => r.id);
      const { matches, ambiguous } = matchFoldersToPoints(folders, pointIds);
      const unmatched = folders.filter((f) => !matches.has(f) && !ambiguous.includes(f));
      ix.matched = matches.size;
      ix.unmatched_count = unmatched.length;
      ix.unmatched = unmatched.slice(0, 30);
      ix.ambiguous = ambiguous.slice(0, 30);

      // Load existing visit_photos to avoid re-importing app-created photos
      const existingRows = db
        .prepare('SELECT id, point_id, taken_date, file_ext, rel_path, source FROM visit_photos')
        .all() as Array<{
        id: number;
        point_id: string;
        taken_date: string;
        file_ext: string;
        rel_path: string | null;
        source: string | null;
      }>;

      const appKeys = new Set<string>();
      const known = new Map<string, { id: number; point_id: string }>();
      for (const r of existingRows) {
        if (r.rel_path && r.source === 'import') {
          known.set(r.rel_path.toLowerCase(), { id: r.id, point_id: r.point_id });
        } else {
          for (const safe of [true, false]) {
            for (const v of photoRelVariants(r, safe)) {
              appKeys.add(v.toLowerCase());
            }
          }
        }
      }

      const seen = new Set<string>();
      let complete = true;
      const organize = cfg.organize !== false;

      for (const [folder, pointId] of matches.entries()) {
        let files: Array<[string, number, number]> = [];
        try {
          if (kind === 'smb') {
            const renamed = await callSmbWorker<Array<[string, string]>>(
              { op: 'normalize_date_dirs', cfg, top: folder },
              120000,
            );
            ix.renamed += renamed.length;
            files = await callSmbWorker<Array<[string, number, number]>>(
              { op: 'walk_images', cfg, top: folder },
              600000,
            );
          } else {
            const root = getEnvFolderBackendDir()!;
            const base = path.join(root, folder);
            const walkLocal = (cur: string, relPrefix: string, depth: number) => {
              if (!fs.existsSync(cur)) return;
              for (const ent of fs.readdirSync(cur, { withFileTypes: true })) {
                if (ent.name.startsWith('.')) continue;
                const full = path.join(cur, ent.name);
                const rel = `${relPrefix}/${ent.name}`;
                if (ent.isDirectory()) {
                  if (depth < 10 && !SKIP_DIRS.has(ent.name.toLowerCase())) {
                    walkLocal(full, rel, depth + 1);
                  }
                } else if (ent.isFile()) {
                  const ext = path.extname(ent.name).replace('.', '').toLowerCase();
                  if (!IMAGE_EXTS.has(ext)) continue;
                  const st = fs.statSync(full);
                  files.push([rel, st.size, st.mtimeMs / 1000]);
                }
              }
            };
            walkLocal(base, folder, 0);
          }
        } catch (err) {
          complete = false;
          ix.errors += 1;
          ix.message = `${folder}: ${(err as Error).message}`;
          continue;
        }

        if (organize && kind === 'smb') {
          const nowSec = Date.now() / 1000;
          const pairs: Array<[string, string]> = [];
          for (const [rel, _sz, mtime] of files) {
            const parts = rel.split('/');
            if (parts.length === 2 && nowSec - mtime >= 120) {
              pairs.push([rel, `${parts[0]}/${dateDir(dateFromMtime(mtime))}/${parts[1]}`]);
            }
          }
          if (pairs.length > 0) {
            try {
              const movedRes = await callSmbWorker<Array<[string, string | null]>>(
                { op: 'move_many', cfg, pairs },
                120000 + pairs.length * 2000,
              );
              const movedMap = new Map<string, string>();
              for (let i = 0; i < pairs.length; i++) {
                const [src] = pairs[i];
                const [finalRel, errMsg] = movedRes[i] || [src, 'ошибка'];
                if (!errMsg && finalRel) {
                  movedMap.set(src, finalRel);
                  ix.moved += 1;
                } else {
                  ix.errors += 1;
                  ix.message = `${src}: ${errMsg}`;
                }
              }
              files = files.map(([rel, sz, mt]) => [movedMap.get(rel) || rel, sz, mt]);
            } catch (err) {
              ix.errors += 1;
              ix.message = `не удалось разложить фото по датам: ${(err as Error).message}`;
            }
          }
        }

        ix.found += files.length;

        const insertStmt = db.prepare(
          `INSERT OR IGNORE INTO visit_photos
             (task_id, point_id, taken_date, file_ext, uploaded_at, uploaded_by, storage, storage_path, rel_path, source, file_name, file_size)
           VALUES ('', ?, ?, ?, ?, 'прежний архив', 'share', '', ?, 'import', ?, ?)`,
        );

        for (const [rel, sz, mtime] of files) {
          const key = rel.toLowerCase();
          const alt = flipDateDirs(rel).toLowerCase();
          seen.add(key);
          seen.add(alt);
          const hit = known.get(key) || known.get(alt);
          if (appKeys.has(key) || appKeys.has(alt)) continue;
          if (hit) {
            if (hit.point_id !== pointId) {
              db.prepare('UPDATE visit_photos SET point_id = ? WHERE id = ?').run(pointId, hit.id);
            }
            continue;
          }
          const name = rel.split('/').pop() || 'photo.jpg';
          const ext = (name.split('.').pop() || 'jpg').toLowerCase();
          const takenDate = extractPhotoDate(rel, mtime);
          const uploadedAt = new Date((mtime || Date.now() / 1000) * 1000).toISOString();
          const info = insertStmt.run(pointId, takenDate, ext, uploadedAt, rel, name, sz);
          if (info.changes > 0) {
            ix.added += 1;
            known.set(key, { id: Number(info.lastInsertRowid), point_id: pointId });
          }
        }

        ix.done += 1;
      }

      if (complete) {
        const goneIds: number[] = [];
        for (const [key, val] of known.entries()) {
          if (!seen.has(key)) goneIds.push(val.id);
        }
        for (const gid of goneIds) {
          db.prepare("DELETE FROM visit_photos WHERE id = ? AND source = 'import'").run(gid);
        }
        ix.removed += goneIds.length;
      }

      ix.state = ix.errors > 0 ? 'finished_with_errors' : 'done';
    } catch (err) {
      ix.state = 'error';
      ix.message = (err as Error).message.slice(0, 200);
    } finally {
      ix.finished_at = nowIso();
      indexRunning = false;
    }
  });

  return await getPhotoStorageStatus(true);
}

// ---------- Background loop hook ----------
let lastAutoIndexAt = 0;

export async function runPhotoStorageMaintenanceTick(): Promise<void> {
  try {
    const cfg = loadSavedSmbConfig();
    if (!activeBackendKind(cfg)) return;
    await flushPhotoSpool();
    const now = Date.now();
    if (now - lastAutoIndexAt >= 3600 * 1000) {
      lastAutoIndexAt = now;
      await startPhotoIndex(true);
    }
  } catch {
    // ignore background errors
  }
}
