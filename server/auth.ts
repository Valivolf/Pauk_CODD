import type { NextFunction, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { settings } from './config.ts';
import { getDb, nowIso } from './db.ts';
import { ALL, isAllowed, needText } from './permissions.ts';

export interface SessionUser {
  id: number;
  username: string;
  role: string;
  role_name: string;
  must_change_password: boolean;
  created_at: string;
  permissions: string[];
}

export interface AuthedRequest extends Request {
  sessionUser?: SessionUser | null;
}

const DUMMY_HASH = bcrypt.hashSync('not-a-real-account', 10);

export function clientIp(req: Request): string {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.trim()) return fwd.split(',')[0].trim();
  return req.socket?.remoteAddress || '127.0.0.1';
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function verifyPassword(password: string, hash: string): boolean {
  try {
    return bcrypt.compareSync(password, hash);
  } catch {
    return false;
  }
}

export function checkPasswordPolicy(password: string, username?: string): string | null {
  if (!password || password.length < settings.passwordMinLength) {
    return `Пароль должен содержать не менее ${settings.passwordMinLength} символов`;
  }
  if (!/[A-Za-zА-Яа-яЁё]/.test(password) || !/\d/.test(password)) {
    return 'Пароль должен содержать и буквы, и цифры';
  }
  if (username && username.trim().length >= 3 && password.toLowerCase().includes(username.trim().toLowerCase())) {
    return 'Ненадёжный пароль: пароль не должен содержать логин';
  }
  return null;
}

// Simple in-memory rate limiter for logins
const loginFailuresByUser = new Map<string, number[]>();
const loginFailuresByIp = new Map<string, number[]>();
const WINDOW_MS = 10 * 60 * 1000;

function pruneTimestamps(list: number[], now: number): number[] {
  return list.filter((t) => now - t < WINDOW_MS);
}

export function isIpLocked(ip: string): boolean {
  const now = Date.now();
  const list = pruneTimestamps(loginFailuresByIp.get(ip) || [], now);
  loginFailuresByIp.set(ip, list);
  return list.length >= 25;
}

export function registerIpFailure(ip: string): void {
  const now = Date.now();
  const list = pruneTimestamps(loginFailuresByIp.get(ip) || [], now);
  list.push(now);
  loginFailuresByIp.set(ip, list);
}

export function checkAndReserveUserAttempt(usernameKey: string): boolean {
  const now = Date.now();
  const list = pruneTimestamps(loginFailuresByUser.get(usernameKey) || [], now);
  if (list.length >= 10) {
    loginFailuresByUser.set(usernameKey, list);
    return false;
  }
  list.push(now);
  loginFailuresByUser.set(usernameKey, list);
  return true;
}

export function clearUserAttempts(usernameKey: string): void {
  loginFailuresByUser.delete(usernameKey);
}

export function recordSecurityEvent(
  kind: string,
  opts: { username?: string; role?: string; ip?: string; ok?: boolean; details?: unknown } = {},
): void {
  try {
    const db = getDb();
    const detailsStr =
      opts.details == null
        ? ''
        : typeof opts.details === 'string'
          ? opts.details
          : JSON.stringify(opts.details);
    db.prepare(
      'INSERT INTO security_events (at, kind, username, role, ip, ok, details) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      nowIso(),
      kind,
      opts.username || '',
      opts.role || '',
      opts.ip || '',
      opts.ok === false ? 0 : 1,
      detailsStr,
    );
  } catch {
    // ignore logging failure
  }
}

export function createAccessToken(user: {
  id: number;
  username: string;
  role: string;
  token_version: number;
}): string {
  return jwt.sign(
    {
      sub: String(user.id),
      username: user.username,
      role: user.role,
      tv: user.token_version,
    },
    settings.secretKey,
    { algorithm: 'HS256', expiresIn: settings.accessTokenExpireMinutes * 60 },
  );
}

export function setSessionCookie(req: Request, res: Response, token: string): void {
  const protoHeader = String(req.headers['x-forwarded-proto'] || req.protocol || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps = protoHeader === 'https' || req.secure;
  res.cookie(settings.cookieName, token, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    maxAge: settings.accessTokenExpireMinutes * 60 * 1000,
    path: '/',
  });
}

export function clearSessionCookie(req: Request, res: Response): void {
  const protoHeader = String(req.headers['x-forwarded-proto'] || req.protocol || '')
    .split(',')[0]
    .trim()
    .toLowerCase();
  const isHttps = protoHeader === 'https' || req.secure;
  res.clearCookie(settings.cookieName, {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? 'none' : 'lax',
    path: '/',
  });
}

export function buildUser(userRow: {
  id: number;
  username: string;
  role: string;
  must_change_password: number;
  created_at: string;
}): SessionUser {
  const db = getDb();
  const roleRow = db.prepare('SELECT name, permissions FROM roles WHERE key = ?').get(userRow.role) as
    | { name: string; permissions: string }
    | undefined;
  let perms: string[] = [];
  if (roleRow) {
    try {
      const parsed = JSON.parse(roleRow.permissions);
      if (Array.isArray(parsed)) perms = parsed;
    } catch {
      perms = [];
    }
  }
  return {
    id: userRow.id,
    username: userRow.username,
    role: userRow.role,
    role_name: roleRow?.name || userRow.role,
    must_change_password: Boolean(userRow.must_change_password),
    created_at: userRow.created_at,
    permissions: perms,
  };
}

export function getSessionUser(req: Request): SessionUser | null {
  const token = req.cookies?.[settings.cookieName];
  if (!token || typeof token !== 'string') return null;
  try {
    const payload = jwt.verify(token, settings.secretKey, { algorithms: ['HS256'] }) as {
      sub?: string;
      tv?: number;
    };
    const userId = Number(payload.sub);
    if (!Number.isFinite(userId)) return null;
    const db = getDb();
    const row = db
      .prepare('SELECT id, username, role, must_change_password, token_version, created_at FROM users WHERE id = ?')
      .get(userId) as
      | {
          id: number;
          username: string;
          role: string;
          must_change_password: number;
          token_version: number;
          created_at: string;
        }
      | undefined;
    if (!row || row.token_version !== payload.tv) return null;
    return buildUser(row);
  } catch {
    return null;
  }
}

export function authenticateUser(username: string, password: string): { user: SessionUser; token: string } {
  const db = getDb();
  const clean = username.trim();
  const row = db
    .prepare(
      'SELECT id, username, password_hash, role, must_change_password, token_version, created_at FROM users WHERE lower(username) = lower(?)',
    )
    .get(clean) as
    | {
        id: number;
        username: string;
        password_hash: string;
        role: string;
        must_change_password: number;
        token_version: number;
        created_at: string;
      }
    | undefined;

  if (!row) {
    verifyPassword(password, DUMMY_HASH);
    throw new Error('Неверный логин или пароль');
  }
  if (!verifyPassword(password, row.password_hash)) {
    throw new Error('Неверный логин или пароль');
  }
  const token = createAccessToken(row);
  return { user: buildUser(row), token };
}

export function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = getSessionUser(req);
  if (!user) {
    res.status(401).json({ detail: 'Сессия недействительна, войдите снова' });
    return;
  }
  req.sessionUser = user;
  next();
}

export function requirePasswordOk(req: AuthedRequest, res: Response, next: NextFunction): void {
  const user = req.sessionUser || getSessionUser(req);
  if (!user) {
    res.status(401).json({ detail: 'Сессия недействительна, войдите снова' });
    return;
  }
  if (user.must_change_password) {
    res.status(403).json({ detail: 'Сначала необходимо сменить пароль' });
    return;
  }
  req.sessionUser = user;
  next();
}

export function requirePerm(...keys: string[]) {
  return (req: AuthedRequest, res: Response, next: NextFunction): void => {
    const user = req.sessionUser || getSessionUser(req);
    if (!user) {
      res.status(401).json({ detail: 'Сессия недействительна, войдите снова' });
      return;
    }
    if (user.must_change_password) {
      res.status(403).json({ detail: 'Сначала необходимо сменить пароль' });
      return;
    }
    req.sessionUser = user;
    const perms = new Set(user.permissions);
    if (perms.has(ALL) || keys.some((k) => perms.has(k))) {
      next();
      return;
    }
    recordSecurityEvent('access_denied', {
      username: user.username,
      role: user.role,
      ip: clientIp(req),
      ok: false,
      details: `${req.method} ${req.path}: нет права ${needText(keys)}`,
    });
    res.status(403).json({ detail: `Нет права: ${needText(keys)}` });
  };
}

export function permissionGuard(req: AuthedRequest, res: Response, next: NextFunction): void {
  const reqPath = req.path;
  if (
    !(
      (reqPath.startsWith('/api/') && !reqPath.startsWith('/api/bot/') && !reqPath.startsWith('/api/agent/')) ||
      reqPath.startsWith('/plan-print')
    )
  ) {
    next();
    return;
  }
  const user = getSessionUser(req);
  if (user) {
    req.sessionUser = user;
    if (!user.must_change_password) {
      const check = isAllowed(req.method, reqPath, user.permissions);
      if (!check.ok) {
        res.status(403).json({ detail: `Нет права: ${needText(check.need)}` });
        return;
      }
    }
  }
  next();
}

export function requireBotKey(req: Request, res: Response, next: NextFunction): void {
  const authHeader = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
  const bearer = authHeader.replace(/^Bearer\s+/i, '');
  const key = String(req.headers['x-bot-key'] || bearer || '').trim();
  if (!key || key !== settings.botApiKey) {
    res.status(401).json({ detail: 'Неверный ключ бота' });
    return;
  }
  next();
}
