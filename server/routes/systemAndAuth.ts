import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import {
  authenticateUser,
  buildUser,
  checkAndReserveUserAttempt,
  checkPasswordPolicy,
  clearSessionCookie,
  clearUserAttempts,
  clientIp,
  getSessionUser,
  hashPassword,
  isIpLocked,
  recordSecurityEvent,
  registerIpFailure,
  requireAuth,
  requirePerm,
  setSessionCookie,
  verifyPassword,
  type AuthedRequest,
} from '../auth.ts';
import { BACKUP_DIR, DB_PATH, settings } from '../config.ts';
import { getFieldKeyBase64, setFieldKey, tryDecryptWithKey } from '../crypto.ts';
import { closeDb, getDb, initDb, nowIso, reopenDb } from '../db.ts';
import { ALL, BUILTIN_ROLES, CATALOG, expandPerms, IMPLIES, isSubsetPerms, landingPage } from '../permissions.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024 } });

const SECURITY_KINDS: Record<string, string> = {
  login_ok: 'Успешный вход',
  login_fail: 'Неверный логин или пароль',
  login_locked: 'Блокировка входа',
  logout: 'Выход',
  password_change: 'Смена пароля',
  password_change_fail: 'Ошибка смены пароля',
  user_create: 'Создание пользователя',
  user_role: 'Смена роли пользователя',
  user_password_reset: 'Сброс пароля пользователя',
  user_delete: 'Удаление пользователя',
  role_create: 'Создание роли',
  role_update: 'Изменение роли',
  role_delete: 'Удаление роли',
  role_reset: 'Сброс роли',
  key_view: 'Просмотр ключа шифрования',
  key_change: 'Смена ключа шифрования',
  backup_download: 'Скачивание копии базы',
  backup_restore: 'Восстановление из копии',
  person_erase: 'Удаление сотрудника',
  access_denied: 'Отказ в доступе',
  admin_action: 'Действие администратора',
};

export function createSystemAndAuthRouter(): Router {
  const router = Router();

  router.get('/healthz', (_req, res) => {
    try {
      getDb().prepare('SELECT 1').get();
      res.json({ ok: true });
    } catch {
      res.status(503).json({ detail: 'база данных не отвечает' });
    }
  });

  // ---- AUTH ----
  router.post('/api/auth/login', (req, res) => {
    const username = String(req.body?.username || '');
    const password = String(req.body?.password || '');
    const throttleKey = username.trim().toLowerCase();
    const ip = clientIp(req);

    if (isIpLocked(ip)) {
      recordSecurityEvent('login_locked', { username: throttleKey, ip, ok: false, details: 'много неудачных входов с IP' });
      res.status(429).json({ detail: 'Слишком много неудачных попыток входа с этого компьютера. Повторите через несколько минут.' });
      return;
    }
    if (!checkAndReserveUserAttempt(throttleKey)) {
      recordSecurityEvent('login_locked', { username: throttleKey, ip, ok: false, details: 'много неудачных входов под логином' });
      res.status(429).json({ detail: 'Слишком много неудачных попыток входа. Повторите через несколько минут.' });
      return;
    }

    try {
      const { user, token } = authenticateUser(username, password);
      clearUserAttempts(throttleKey);
      setSessionCookie(req, res, token);
      recordSecurityEvent('login_ok', { username: user.username, role: user.role, ip });
      res.json({
        id: user.id,
        username: user.username,
        role: user.role,
        role_name: user.role_name,
        permissions: user.permissions,
        landing: landingPage(user.permissions),
        must_change_password: user.must_change_password,
      });
    } catch (err) {
      registerIpFailure(ip);
      recordSecurityEvent('login_fail', { username: throttleKey, ip, ok: false });
      res.status(401).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/auth/logout', (req, res) => {
    const who = getSessionUser(req);
    if (who) {
      recordSecurityEvent('logout', {
        username: who.username,
        role: who.role,
        ip: clientIp(req),
        details: req.query.idle === 'true' ? { reason: 'бездействие' } : undefined,
      });
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  });

  router.get('/api/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json(req.sessionUser);
  });

  router.post('/api/auth/password', requireAuth, (req: AuthedRequest, res) => {
    const user = req.sessionUser!;
    const currentPassword = String(req.body?.current_password || '');
    const newPassword = String(req.body?.new_password || '');
    const ip = clientIp(req);

    const policyErr = checkPasswordPolicy(newPassword, user.username);
    if (policyErr) {
      res.status(400).json({ detail: policyErr });
      return;
    }

    const db = getDb();
    const row = db
      .prepare('SELECT id, username, password_hash, role, must_change_password, token_version, created_at FROM users WHERE id = ?')
      .get(user.id) as
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

    if (!row || !verifyPassword(currentPassword, row.password_hash)) {
      recordSecurityEvent('password_change_fail', { username: user.username, role: user.role, ip, ok: false });
      res.status(400).json({ detail: 'Текущий пароль указан неверно' });
      return;
    }

    const newHash = hashPassword(newPassword);
    const nextTv = row.token_version + 1;
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = ? WHERE id = ?').run(
      newHash,
      nextTv,
      user.id,
    );
    recordSecurityEvent('password_change', { username: user.username, role: user.role, ip });
    const { token } = authenticateUser(user.username, newPassword);
    setSessionCookie(req, res, token);
    res.json({ ok: true });
  });

  // ---- SECURITY ----
  router.get('/api/security/policy', (_req, res) => {
    res.json({
      min_length: settings.passwordMinLength,
      require_letters_digits: true,
      disallow_username: true,
      idle_minutes: settings.sessionIdleMinutes,
      retention_days: settings.securityLogRetentionDays,
    });
  });

  router.get('/api/security/events', requirePerm('admin.security'), (req, res) => {
    const db = getDb();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const kind = String(req.query.kind || '').trim();
    const username = String(req.query.username || '').trim();
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const onlyFailed = req.query.only_failed === 'true' || req.query.only_failed === '1';

    const where: string[] = [];
    const params: Array<string | number> = [];
    if (kind) {
      where.push('kind = ?');
      params.push(kind);
    }
    if (username) {
      where.push('lower(username) LIKE lower(?)');
      params.push(`%${username}%`);
    }
    if (dateFrom) {
      where.push('substr(at, 1, 10) >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push('substr(at, 1, 10) <= ?');
      params.push(dateTo);
    }
    if (onlyFailed) {
      where.push('ok = 0');
    }

    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = (db.prepare(`SELECT COUNT(*) as cnt FROM security_events ${sqlWhere}`).get(...params) as { cnt: number }).cnt;
    const items = db
      .prepare(`SELECT id, at, kind, username, role, ip, ok, details FROM security_events ${sqlWhere} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map((r: Record<string, unknown>) => ({ ...r, ok: Boolean(r.ok) }));

    res.json({
      items,
      total,
      kinds: SECURITY_KINDS,
      retention_days: settings.securityLogRetentionDays,
    });
  });

  router.get('/api/security/events/export', requirePerm('admin.security'), (req: AuthedRequest, res) => {
    const db = getDb();
    const items = db
      .prepare('SELECT id, at, kind, username, role, ip, ok, details FROM security_events ORDER BY id DESC LIMIT 5000')
      .all() as Array<Record<string, unknown>>;
    const header = 'id;at;kind;username;role;ip;ok;details\n';
    const lines = items.map((r) =>
      [r.id, r.at, r.kind, r.username, r.role, r.ip, r.ok, String(r.details || '').replace(/[\r\n;]/g, ' ')].join(';'),
    );
    recordSecurityEvent('admin_action', {
      username: req.sessionUser!.username,
      role: req.sessionUser!.role,
      ip: clientIp(req),
      details: { method: 'GET', path: '/api/security/events/export' },
    });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="security-events-${new Date().toISOString().slice(0, 10)}.csv"`);
    res.send('\uFEFF' + header + lines.join('\n'));
  });

  // ---- USERS ----
  function getRolePerms(roleKey: string): string[] {
    const row = getDb().prepare('SELECT permissions FROM roles WHERE key = ?').get(roleKey) as
      | { permissions: string }
      | undefined;
    if (!row) return [];
    try {
      return JSON.parse(row.permissions);
    } catch {
      return [];
    }
  }

  router.get('/api/admin/users', requirePerm('admin.users'), (_req, res) => {
    const rows = getDb()
      .prepare('SELECT id, username, role, must_change_password, created_at FROM users ORDER BY id')
      .all() as Array<{ id: number; username: string; role: string; must_change_password: number; created_at: string }>;
    res.json(rows.map((u) => buildUser(u)));
  });

  router.post('/api/admin/users', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const username = String(req.body?.username || '').trim();
    const password = String(req.body?.password || '');
    const role = String(req.body?.role || 'user');
    const db = getDb();

    if (username.length < 3 || username.length > 40 || username.includes(' ')) {
      res.status(400).json({ detail: 'Логин от 3 до 40 символов без пробелов' });
      return;
    }
    const policyErr = checkPasswordPolicy(password, username);
    if (policyErr) {
      res.status(400).json({ detail: policyErr });
      return;
    }
    const roleRow = db.prepare('SELECT key, permissions FROM roles WHERE key = ?').get(role) as
      | { key: string; permissions: string }
      | undefined;
    if (!roleRow) {
      res.status(400).json({ detail: 'Такой роли нет' });
      return;
    }
    if (!isSubsetPerms(getRolePerms(role), admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя назначить роль, права которой шире ваших' });
      return;
    }
    const dup = db.prepare('SELECT id FROM users WHERE lower(username) = lower(?)').get(username);
    if (dup) {
      res.status(400).json({ detail: 'Пользователь с таким логином уже существует' });
      return;
    }
    const info = db
      .prepare(
        'INSERT INTO users (username, password_hash, role, must_change_password, token_version, created_at) VALUES (?, ?, ?, 1, 0, ?)',
      )
      .run(username, hashPassword(password), role, nowIso());
    const created = db
      .prepare('SELECT id, username, role, must_change_password, created_at FROM users WHERE id = ?')
      .get(Number(info.lastInsertRowid)) as {
      id: number;
      username: string;
      role: string;
      must_change_password: number;
      created_at: string;
    };
    recordSecurityEvent('user_create', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { user: created.username, role: created.role },
    });
    res.status(201).json(buildUser(created));
  });

  router.patch('/api/admin/users/:userId/role', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const userId = Number(req.params.userId);
    const newRole = String(req.body?.role || '');
    const db = getDb();
    const target = db
      .prepare('SELECT id, username, role, must_change_password, created_at FROM users WHERE id = ?')
      .get(userId) as
      | { id: number; username: string; role: string; must_change_password: number; created_at: string }
      | undefined;
    if (!target) {
      res.status(404).json({ detail: 'Пользователь не найден' });
      return;
    }
    const roleRow = db.prepare('SELECT key FROM roles WHERE key = ?').get(newRole);
    if (!roleRow) {
      res.status(400).json({ detail: 'Такой роли нет' });
      return;
    }
    if (!isSubsetPerms(getRolePerms(target.role), admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя менять пользователя, чьи права шире ваших' });
      return;
    }
    if (!isSubsetPerms(getRolePerms(newRole), admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя назначить роль, права которой шире ваших' });
      return;
    }
    if (target.role === 'admin' && newRole !== 'admin') {
      const admins = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get() as { cnt: number }).cnt;
      if (admins <= 1) {
        res.status(400).json({ detail: 'Нельзя разжаловать последнего администратора' });
        return;
      }
    }
    db.prepare('UPDATE users SET role = ?, token_version = token_version + 1 WHERE id = ?').run(newRole, userId);
    recordSecurityEvent('user_role', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { user: target.username, was: target.role, now: newRole },
    });
    const updated = db
      .prepare('SELECT id, username, role, must_change_password, created_at FROM users WHERE id = ?')
      .get(userId) as { id: number; username: string; role: string; must_change_password: number; created_at: string };
    res.json(buildUser(updated));
  });

  router.post('/api/admin/users/:userId/reset-password', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const userId = Number(req.params.userId);
    const newPassword = String(req.body?.new_password || '');
    const db = getDb();
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId) as
      | { id: number; username: string; role: string }
      | undefined;
    if (!target) {
      res.status(404).json({ detail: 'Пользователь не найден' });
      return;
    }
    if (!isSubsetPerms(getRolePerms(target.role), admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя менять пользователя, чьи права шире ваших' });
      return;
    }
    const policyErr = checkPasswordPolicy(newPassword, target.username);
    if (policyErr) {
      res.status(400).json({ detail: policyErr });
      return;
    }
    db.prepare('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?').run(
      hashPassword(newPassword),
      userId,
    );
    clearUserAttempts(target.username.toLowerCase());
    recordSecurityEvent('user_password_reset', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { user: target.username },
    });
    res.json({ ok: true });
  });

  router.delete('/api/admin/users/:userId', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const userId = Number(req.params.userId);
    if (userId === admin.id) {
      res.status(400).json({ detail: 'Нельзя удалить свою учётную запись' });
      return;
    }
    const db = getDb();
    const target = db.prepare('SELECT id, username, role FROM users WHERE id = ?').get(userId) as
      | { id: number; username: string; role: string }
      | undefined;
    if (!target) {
      res.status(404).json({ detail: 'Пользователь не найден' });
      return;
    }
    if (!isSubsetPerms(getRolePerms(target.role), admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя удалять пользователя, чьи права шире ваших' });
      return;
    }
    if (target.role === 'admin') {
      const admins = (db.prepare("SELECT COUNT(*) as cnt FROM users WHERE role = 'admin'").get() as { cnt: number }).cnt;
      if (admins <= 1) {
        res.status(400).json({ detail: 'Нельзя удалить последнего администратора' });
        return;
      }
    }
    db.prepare('DELETE FROM users WHERE id = ?').run(userId);
    recordSecurityEvent('user_delete', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { user: target.username },
    });
    res.json({ ok: true });
  });

  // ---- ROLES ----
  function formatRoleRow(r: {
    key: string;
    name: string;
    description: string;
    permissions: string;
    is_system: number;
    created_at: string;
    updated_at: string;
  }) {
    let perms: string[] = [];
    try {
      perms = JSON.parse(r.permissions);
    } catch {
      perms = [];
    }
    const userCount = (
      getDb().prepare('SELECT COUNT(*) as cnt FROM users WHERE role = ?').get(r.key) as { cnt: number }
    ).cnt;
    return {
      key: r.key,
      name: r.name,
      description: r.description,
      permissions: perms,
      is_system: Boolean(r.is_system),
      locked: r.key === 'admin',
      users_count: userCount,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  }

  router.get('/api/admin/roles', requirePerm('admin.users'), (_req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM roles ORDER BY is_system DESC, name')
      .all() as Array<{
      key: string;
      name: string;
      description: string;
      permissions: string;
      is_system: number;
      created_at: string;
      updated_at: string;
    }>;
    const catalog = CATALOG.map((g) => ({
      group: g.group,
      items: g.items.map((item) => ({
        key: item.key,
        label: item.label,
        hint: item.hint,
        implies: IMPLIES[item.key] || [],
      })),
    }));
    res.json({ roles: rows.map(formatRoleRow), catalog });
  });

  router.post('/api/admin/roles', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const name = String(req.body?.name || '').trim();
    const description = String(req.body?.description || '').trim();
    let perms: string[] | null = Array.isArray(req.body?.permissions) ? req.body.permissions : null;
    const copyFrom = typeof req.body?.copy_from === 'string' ? req.body.copy_from : '';
    const db = getDb();

    if (name.length < 2 || name.length > 60) {
      res.status(400).json({ detail: 'Название роли от 2 до 60 символов' });
      return;
    }
    if (!perms && copyFrom) {
      const src = db.prepare('SELECT permissions FROM roles WHERE key = ?').get(copyFrom) as
        | { permissions: string }
        | undefined;
      if (!src) {
        res.status(404).json({ detail: 'Роль для копирования не найдена' });
        return;
      }
      const srcPerms: string[] = JSON.parse(src.permissions);
      perms = srcPerms.includes(ALL) ? Object.keys(IMPLIES) : srcPerms;
    }
    const expanded = expandPerms(perms || []);
    if (!isSubsetPerms(expanded, admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя раздавать права, которых нет у вас самих' });
      return;
    }
    const key = `r_${crypto.randomBytes(3).toString('hex')}`;
    const now = nowIso();
    db.prepare(
      'INSERT INTO roles (key, name, description, permissions, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, 0, ?, ?)',
    ).run(key, name, description, JSON.stringify(expanded), now, now);
    const created = db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as Parameters<typeof formatRoleRow>[0];
    recordSecurityEvent('role_create', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { role: name, permissions: expanded.length },
    });
    res.status(201).json(formatRoleRow(created));
  });

  router.put('/api/admin/roles/:key', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const key = req.params.key;
    const db = getDb();
    const old = db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as Parameters<typeof formatRoleRow>[0] | undefined;
    if (!old) {
      res.status(404).json({ detail: 'Такой роли нет' });
      return;
    }
    const oldPerms: string[] = JSON.parse(old.permissions);
    if (!isSubsetPerms(oldPerms, admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя править роль, права которой шире ваших' });
      return;
    }
    const name = String(req.body?.name || old.name).trim();
    const description = String(req.body?.description ?? old.description).trim();
    let newPerms = oldPerms;
    if (key !== 'admin' && Array.isArray(req.body?.permissions)) {
      newPerms = expandPerms(req.body.permissions);
      if (!isSubsetPerms(newPerms, admin.permissions)) {
        res.status(403).json({ detail: 'Нельзя раздавать права, которых нет у вас самих' });
        return;
      }
    }
    db.prepare('UPDATE roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE key = ?').run(
      name,
      description,
      JSON.stringify(newPerms),
      nowIso(),
      key,
    );
    recordSecurityEvent('role_update', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { role: name },
    });
    const updated = db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as Parameters<typeof formatRoleRow>[0];
    res.json(formatRoleRow(updated));
  });

  router.post('/api/admin/roles/:key/reset', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const key = req.params.key;
    const def = BUILTIN_ROLES[key];
    if (!def) {
      res.status(404).json({ detail: 'Это не встроенная роль' });
      return;
    }
    const expanded = expandPerms(def.perms);
    if (!isSubsetPerms(expanded, admin.permissions)) {
      res.status(403).json({ detail: 'Нельзя раздавать права, которых нет у вас самих' });
      return;
    }
    getDb()
      .prepare('UPDATE roles SET name = ?, description = ?, permissions = ?, updated_at = ? WHERE key = ?')
      .run(def.name, def.description, JSON.stringify(expanded), nowIso(), key);
    recordSecurityEvent('role_reset', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { role: def.name },
    });
    const updated = getDb().prepare('SELECT * FROM roles WHERE key = ?').get(key) as Parameters<typeof formatRoleRow>[0];
    res.json(formatRoleRow(updated));
  });

  router.delete('/api/admin/roles/:key', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const key = req.params.key;
    const db = getDb();
    const role = db.prepare('SELECT * FROM roles WHERE key = ?').get(key) as Parameters<typeof formatRoleRow>[0] | undefined;
    if (!role) {
      res.status(404).json({ detail: 'Такой роли нет' });
      return;
    }
    if (role.is_system) {
      res.status(400).json({ detail: 'Встроенную роль нельзя удалить' });
      return;
    }
    const count = (db.prepare('SELECT COUNT(*) as cnt FROM users WHERE role = ?').get(key) as { cnt: number }).cnt;
    if (count > 0) {
      res.status(400).json({ detail: 'Сначала переведите пользователей с этой ролью на другую' });
      return;
    }
    db.prepare('DELETE FROM roles WHERE key = ?').run(key);
    recordSecurityEvent('role_delete', {
      username: admin.username,
      role: admin.role,
      ip: clientIp(req),
      details: { role: role.name },
    });
    res.json({ ok: true });
  });

  // ---- ENCRYPTION ----
  function encryptionState() {
    const db = getDb();
    const totalPeople = (db.prepare('SELECT COUNT(*) as c FROM people').get() as { c: number }).c;
    const encPeople = (db.prepare("SELECT COUNT(*) as c FROM people WHERE full_name LIKE 'enc:v1:%'").get() as { c: number }).c;
    const totalPoints = (db.prepare("SELECT COUNT(*) as c FROM points WHERE login != '' OR password != ''").get() as { c: number }).c;
    const encPoints = (
      db.prepare("SELECT COUNT(*) as c FROM points WHERE login LIKE 'enc:v1:%' OR password LIKE 'enc:v1:%'").get() as { c: number }
    ).c;
    const key = getFieldKeyBase64();
    const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase();
    return {
      encrypted: encPeople + encPoints,
      plain: Math.max(0, totalPeople - encPeople) + Math.max(0, totalPoints - encPoints),
      key_source: process.env.FIELD_ENCRYPTION_KEY ? 'env' : 'file',
      fingerprint: fp,
      key_in_env: Boolean(process.env.FIELD_ENCRYPTION_KEY),
    };
  }

  router.get('/api/encryption', requirePerm('admin.keys'), (_req, res) => {
    res.json(encryptionState());
  });

  router.post('/api/encryption/key/show', requirePerm('admin.keys'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const db = getDb();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id) as { password_hash: string } | undefined;
    if (!row || !verifyPassword(String(req.body?.password || ''), row.password_hash)) {
      res.status(403).json({ detail: 'Пароль администратора указан неверно' });
      return;
    }
    recordSecurityEvent('key_view', { username: admin.username, role: admin.role, ip: clientIp(req) });
    const key = getFieldKeyBase64();
    const fp = crypto.createHash('sha256').update(key).digest('hex').slice(0, 12).toUpperCase();
    res.json({ key, fingerprint: fp });
  });

  router.post('/api/encryption/key/apply', requirePerm('admin.keys'), (req: AuthedRequest, res) => {
    const admin = req.sessionUser!;
    const db = getDb();
    const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(admin.id) as { password_hash: string } | undefined;
    if (!row || !verifyPassword(String(req.body?.password || ''), row.password_hash)) {
      res.status(403).json({ detail: 'Пароль администратора указан неверно' });
      return;
    }
    if (process.env.FIELD_ENCRYPTION_KEY) {
      res.status(409).json({ detail: 'Ключ задан переменной FIELD_ENCRYPTION_KEY — меняйте его в .env' });
      return;
    }
    const newKey = String(req.body?.key || '').trim();
    if (!newKey || newKey.length < 16) {
      res.status(400).json({ detail: 'Некорректный формат ключа' });
      return;
    }
    const sample = db.prepare("SELECT full_name FROM people WHERE full_name LIKE 'enc:v1:%' LIMIT 1").get() as
      | { full_name: string }
      | undefined;
    if (sample) {
      try {
        tryDecryptWithKey(sample.full_name, newKey);
      } catch {
        res.status(400).json({ detail: 'Этот ключ не подходит к данным в базе — прежний ключ оставлен.' });
        return;
      }
    }
    setFieldKey(newKey);
    recordSecurityEvent('key_change', { username: admin.username, role: admin.role, ip: clientIp(req) });
    res.json(encryptionState());
  });

  // ---- BACKUP ----
  router.get('/api/backup', requirePerm('admin.backup'), (req: AuthedRequest, res) => {
    recordSecurityEvent('backup_download', {
      username: req.sessionUser!.username,
      role: req.sessionUser!.role,
      ip: clientIp(req),
    });
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
    const outPath = path.join(BACKUP_DIR, `calendar-backup-${stamp}.db`);
    try {
      getDb().exec(`VACUUM INTO '${outPath.replace(/'/g, "''")}'`);
    } catch {
      fs.copyFileSync(DB_PATH, outPath);
    }
    res.download(outPath, `calendar-backup-${stamp}.db`);
  });

  router.post('/api/backup/restore', requirePerm('admin.backup'), upload.single('file'), (req: AuthedRequest, res) => {
    if (!req.file || !req.file.buffer?.length) {
      res.status(400).json({ detail: 'Выберите файл резервной копии (.db)' });
      return;
    }
    const header = req.file.buffer.subarray(0, 16).toString('utf-8');
    if (!header.startsWith('SQLite format 3')) {
      res.status(400).json({ detail: 'Файл не является базой данных SQLite' });
      return;
    }
    try {
      closeDb();
      fs.writeFileSync(DB_PATH, req.file.buffer);
      reopenDb();
      initDb();
      recordSecurityEvent('backup_restore', {
        username: req.sessionUser!.username,
        role: req.sessionUser!.role,
        ip: clientIp(req),
      });
      res.json({ ok: true });
    } catch (err) {
      reopenDb();
      res.status(500).json({ detail: `Не удалось восстановить базу: ${(err as Error).message}` });
    }
  });

  // ---- SYSTEM ----
  router.get('/api/system/health', requirePerm('admin.system'), (_req, res) => {
    const db = getDb();
    let dbBytes = 0;
    try {
      dbBytes = fs.statSync(DB_PATH).size;
    } catch {
      dbBytes = 0;
    }
    const mem = process.memoryUsage();
    const counts = {
      points: (db.prepare('SELECT COUNT(*) as c FROM points').get() as { c: number }).c,
      tasks: (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c,
      crews: (db.prepare('SELECT COUNT(*) as c FROM crews').get() as { c: number }).c,
      people: (db.prepare('SELECT COUNT(*) as c FROM people').get() as { c: number }).c,
      reports: (db.prepare('SELECT COUNT(*) as c FROM task_visit_reports').get() as { c: number }).c,
      equipment: (db.prepare('SELECT COUNT(*) as c FROM equipment').get() as { c: number }).c,
    };
    res.json({
      ok: true,
      runtime: `Node.js ${process.version}`,
      uptime_seconds: Math.round(process.uptime()),
      db_size_bytes: dbBytes,
      memory_rss_mb: Math.round(mem.rss / (1024 * 1024)),
      counts,
      integrity: { ok: true, message: 'OK' },
    });
  });

  router.get('/api/system/summary', requirePerm('admin.system'), (_req, res) => {
    const db = getDb();
    res.json({
      users: (db.prepare('SELECT COUNT(*) as c FROM users').get() as { c: number }).c,
      points: (db.prepare('SELECT COUNT(*) as c FROM points').get() as { c: number }).c,
      tasks: (db.prepare('SELECT COUNT(*) as c FROM tasks').get() as { c: number }).c,
      equipment: (db.prepare('SELECT COUNT(*) as c FROM equipment').get() as { c: number }).c,
    });
  });

  router.get('/api/system/openapi', requirePerm('admin.system'), (_req, res) => {
    res.json({ openapi: '3.1.0', info: { title: settings.appName, version: '2.0.0-node' }, paths: {} });
  });

  router.post('/api/system/relink-point', requirePerm('admin.system'), (req, res) => {
    const oldId = String(req.body?.old || '').trim();
    const newId = String(req.body?.new || '').trim();
    if (!oldId || !newId || oldId === newId) {
      res.status(400).json({ detail: 'Укажите старый и новый номера комплекса' });
      return;
    }
    const db = getDb();
    const target = db.prepare('SELECT id FROM points WHERE id = ?').get(newId);
    if (!target) {
      res.status(400).json({ detail: `Комплекс «${newId}» не найден` });
      return;
    }
    let updated = 0;
    for (const [table, col] of [
      ['tasks', 'point'],
      ['task_visit_reports', 'point_id'],
      ['visit_photos', 'point_id'],
      ['point_status_history', 'point_id'],
      ['point_files', 'point_id'],
      ['point_plans', 'point_id'],
      ['equipment', 'point_id'],
    ]) {
      const info = db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(newId, oldId);
      updated += Number(info.changes || 0);
    }
    res.json({ ok: true, moved: updated });
  });

  router.post('/api/system/integrity', requirePerm('admin.system'), (_req, res) => {
    const row = getDb().prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    res.json({ ok: row?.integrity_check === 'ok', result: row?.integrity_check || 'unknown' });
  });

  return router;
}
