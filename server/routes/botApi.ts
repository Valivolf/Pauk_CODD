import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { promisify } from 'node:util';
import { GoogleGenAI, Type } from '@google/genai';
import express, { Router, type Request, type Response } from 'express';
import multer from 'multer';
import { requireBotKey } from '../auth.ts';
import { CHAT_FILES_DIR, PHOTOS_DIR, settings } from '../config.ts';
import { decryptField } from '../crypto.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { deleteVisitPhotoFiles, storeVisitPhoto } from '../services/photoStorage.ts';

const execFileAsync = promisify(execFile);

const AUX_TYPE_NAME = 'Вспомогательная точка';
const WORKING = 'Работает';
const PING_ONLY = 'Есть только пинг';
const NOT_WORKING = 'Не работает';
const POWER_OFF = 'Нет питания';
const MIN_SUFFIX = 6;
const SIM_MIN_DIGITS = 7;

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });
const chatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 } });
const voiceUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const IMAGE_MIME: Record<string, string> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  jpe: 'image/jpeg',
  jfif: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
};

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function todayIso(): string {
  const now = new Date();
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.TZ || 'Europe/Moscow',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

function safeFolderSegment(name: string): string {
  return String(name || 'unknown').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'unknown';
}

function foldPointRef(raw: string): string {
  const map: Record<string, string> = {
    A: 'А', B: 'В', C: 'С', E: 'Е', H: 'Н', K: 'К', M: 'М', O: 'О', P: 'Р', T: 'Т', X: 'Х', Y: 'У',
    a: 'а', b: 'в', c: 'с', e: 'е', h: 'н', k: 'к', m: 'м', o: 'о', p: 'р', t: 'т', x: 'х', y: 'у',
  };
  return String(raw || '')
    .trim()
    .replace(/[ABCEHKMOPTXYabcehkmoptxy]/g, (ch) => map[ch] || ch)
    .replace(/\s+/g, '')
    .toLowerCase();
}

function canonicalPointId(db: DatabaseSync, raw: string | null | undefined): string | null {
  const text = String(raw || '');
  if (!text.trim()) return null;
  const exact = db.prepare('SELECT id FROM points WHERE id = ?').get(text) as { id: string } | undefined;
  if (exact) return exact.id;
  const key = foldPointRef(text);
  if (!key) return null;
  const all = db.prepare('SELECT id FROM points').all() as Array<{ id: string }>;
  const matches = all.filter((r) => foldPointRef(r.id) === key);
  return matches.length === 1 ? matches[0].id : null;
}

function requirePointOr404(db: DatabaseSync, rawPointId: string): Record<string, unknown> {
  let row = db.prepare('SELECT * FROM points WHERE id = ?').get(rawPointId) as Record<string, unknown> | undefined;
  if (!row) {
    const canon = canonicalPointId(db, rawPointId);
    if (canon) {
      row = db.prepare('SELECT * FROM points WHERE id = ?').get(canon) as Record<string, unknown> | undefined;
    }
  }
  if (!row) throw new HttpError(404, 'Точка не найдена');
  return row;
}

interface PersonRow {
  id: number;
  full_name: string;
  phone: string;
  role_type: string;
  vk_id: number;
  active: boolean;
}

function requirePersonByVk(db: DatabaseSync, vkId: number, opts?: { warehouse?: boolean }): PersonRow {
  const row = db.prepare('SELECT id, full_name, phone, role_type, vk_id, active FROM people WHERE vk_id = ?').get(vkId) as
    | Record<string, unknown>
    | undefined;
  if (!row || !row.active) {
    throw new HttpError(404, 'Монтёр не найден или неактивен');
  }
  if (opts?.warehouse && row.role_type !== 'warehouse') {
    throw new HttpError(403, 'Раздел доступен только ответственному за склад');
  }
  return {
    id: Number(row.id),
    full_name: decryptField(String(row.full_name || '')),
    phone: decryptField(String(row.phone || '')),
    role_type: String(row.role_type || ''),
    vk_id: Number(row.vk_id),
    active: Boolean(row.active),
  };
}

function getTaskOr404(db: DatabaseSync, taskId: string): { id: string; point: string; type: string; date: string } {
  const row = db.prepare('SELECT id, point, type, date FROM tasks WHERE id = ?').get(taskId) as
    | { id: string; point: string; type: string; date: string }
    | undefined;
  if (!row) throw new HttpError(404, 'Задание не найдено');
  let point = row.point || '';
  if (point && row.type !== AUX_TYPE_NAME) {
    point = canonicalPointId(db, point) || point;
  }
  return { id: row.id, point, type: row.type || '', date: row.date || '' };
}

function workTypeMeta(db: DatabaseSync, workTypeName: string): { is_repair: boolean; bot_tools: boolean; outcomes: string[] } {
  const wt = db.prepare('SELECT is_repair, bot_tools FROM work_types WHERE name = ?').get(workTypeName) as
    | { is_repair: number; bot_tools: number }
    | undefined;
  const isRepair = wt ? Boolean(wt.is_repair) : workTypeName === 'Ремонт' || workTypeName.includes('Ремонт');
  const botTools = wt ? Boolean(wt.bot_tools) : false;
  const outcomes = isRepair
    ? []
    : (
        db.prepare('SELECT label FROM work_type_outcomes WHERE type_name = ? ORDER BY sort_order, id').all(workTypeName) as Array<{
          label: string;
        }>
      ).map((r) => r.label);
  return { is_repair: isRepair, bot_tools: botTools, outcomes };
}

function activeWorkersForTasks(db: DatabaseSync, taskIds: string[]): Map<string, Array<{ person_id: number; name: string; started_at: string }>> {
  const out = new Map<string, Array<{ person_id: number; name: string; started_at: string }>>();
  if (!taskIds.length) return out;
  const placeholders = taskIds.map(() => '?').join(',');
  const rows = db
    .prepare(
      `SELECT s.task_id, s.person_id, s.started_at, p.full_name
       FROM bot_work_sessions s
       JOIN people p ON p.id = s.person_id
       WHERE s.ended_at IS NULL AND s.task_id IN (${placeholders})
       ORDER BY s.started_at, s.id`,
    )
    .all(...(taskIds as SQLInputValue[])) as Array<{ task_id: string; person_id: number; started_at: string; full_name: string }>;
  for (const r of rows) {
    const list = out.get(r.task_id) || [];
    list.push({ person_id: r.person_id, name: decryptField(r.full_name || ''), started_at: r.started_at });
    out.set(r.task_id, list);
  }
  return out;
}

function progressPayload(db: DatabaseSync, taskId: string, person: PersonRow) {
  const savedRow = db.prepare('SELECT state, updated_at, updated_by FROM bot_task_progress WHERE task_id = ?').get(taskId) as
    | { state: string; updated_at: string; updated_by: string | null }
    | undefined;
  let state: Record<string, unknown> = {};
  if (savedRow?.state) {
    try {
      const parsed = JSON.parse(savedRow.state);
      if (parsed && typeof parsed === 'object') state = parsed as Record<string, unknown>;
    } catch {
      state = {};
    }
  }
  const photoRow = db.prepare('SELECT count(*) as c FROM visit_photos WHERE task_id = ?').get(taskId) as { c: number };
  const workers = activeWorkersForTasks(db, [taskId]).get(taskId) || [];
  const finished = Boolean(db.prepare('SELECT 1 FROM task_visit_reports WHERE task_id = ?').get(taskId));
  return {
    task_id: taskId,
    state,
    photo_count: photoRow.c || 0,
    has_report: Boolean(String(state.report_text || '').trim()),
    workers: workers.map((w) => ({ ...w, me: w.person_id === person.id })),
    updated_at: savedRow?.updated_at ?? null,
    updated_by: savedRow?.updated_by ?? null,
    finished,
  };
}

function normalizePowerSource(raw: string): string | null {
  const s = String(raw || '').trim().toLowerCase();
  if (!s) return null;
  if (s === 'сэс' || s === 'ses') return 'СЭС';
  if (s === 'электросеть' || s === 'сеть') return 'Электросеть';
  return null;
}

function simKey(raw: string): string {
  const trimmed = String(raw || '').trim();
  const digits = trimmed.replace(/\D+/g, '');
  if (digits.length >= SIM_MIN_DIGITS) return digits.slice(-SIM_MIN_DIGITS);
  return digits || trimmed;
}

function simKeyValid(raw: string): boolean {
  return raw.replace(/\D+/g, '').length >= SIM_MIN_DIGITS;
}

function suffixKey(raw: string | null | undefined): string {
  return String(raw || '').trim().replace(/\s+/g, '');
}

// ---------- Point network probe ----------
async function probeIcmpPing(host: string): Promise<boolean> {
  if (!host.trim()) return false;
  try {
    await execFileAsync('ping', ['-c', '2', '-W', '2', host.trim()], { timeout: 5500 });
    return true;
  } catch {
    return false;
  }
}

function probeTcpPort(host: string, portNum: number, timeoutMs = 2500): Promise<boolean> {
  return new Promise((resolve) => {
    const cleanHost = host.trim();
    if (!cleanHost) {
      resolve(false);
      return;
    }
    const sock = net.createConnection({ host: cleanHost, port: portNum });
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false));
    sock.on('error', () => finish(false));
  });
}

async function recheckPointAndApply(db: DatabaseSync, pointId: string): Promise<string> {
  let point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
  if (!point) return '';
  const sim = String(point.sim_number || '').trim();
  if (sim) {
    const reg = db.prepare('SELECT ip_address FROM sim_ip_registry WHERE sim_number = ?').get(sim) as
      | { ip_address: string }
      | undefined;
    if (reg?.ip_address && reg.ip_address !== String(point.ip_address || '')) {
      db.prepare('UPDATE points SET ip_address = ? WHERE id = ?').run(reg.ip_address, pointId);
      point = { ...point, ip_address: reg.ip_address };
    }
  }
  const ip = String(point.ip_address || '').trim();
  const currentStatus = String(point.status || '').trim();
  const autoRows = db.prepare('SELECT name FROM point_statuses WHERE is_auto = 1').all() as Array<{ name: string }>;
  const autoNames = new Set(autoRows.map((r) => r.name));
  const eligible = (!currentStatus || autoNames.has(currentStatus) || currentStatus === POWER_OFF);
  if (!eligible || !ip) return currentStatus;

  const portStr = String(point.port || '').trim();
  const portNum = portStr && /^\d+$/.test(portStr) ? Number(portStr) : 0;

  const [pingOk, portOk] = await Promise.all([
    probeIcmpPing(ip),
    portNum > 0 ? probeTcpPort(ip, portNum) : Promise.resolve(false),
  ]);

  let newStatus = NOT_WORKING;
  let isDown = true;
  if (portNum > 0) {
    if (portOk) {
      newStatus = WORKING;
      isDown = false;
    } else if (pingOk) {
      newStatus = PING_ONLY;
      isDown = true;
    }
  } else if (pingOk) {
    newStatus = WORKING;
    isDown = false;
  }

  const now = nowIso();
  const latest = db.prepare('SELECT status, port_down_since FROM points WHERE id = ?').get(pointId) as
    | { status: string; port_down_since: string | null }
    | undefined;
  if (!latest) return '';
  const latestStatus = String(latest.status || '').trim();
  if (!(!latestStatus || autoNames.has(latestStatus) || latestStatus === POWER_OFF)) {
    return latestStatus;
  }

  if (latestStatus === POWER_OFF && isDown) {
    db.prepare('UPDATE points SET health_checked_at = ? WHERE id = ?').run(now, pointId);
    return POWER_OFF;
  }

  const downSince = isDown ? latest.port_down_since || now : null;
  db.prepare('UPDATE points SET health_checked_at = ?, port_down_since = ? WHERE id = ?').run(now, downSince, pointId);
  if (newStatus !== latestStatus) {
    db.prepare('UPDATE points SET status = ? WHERE id = ?').run(newStatus, pointId);
    db.prepare(
      'INSERT INTO point_status_history (point_id, old_status, new_status, source, task_id, changed_at) VALUES (?, ?, ?, ?, NULL, ?)',
    ).run(pointId, latestStatus, newStatus, 'auto', now);
    bumpStateRev();
  }
  return newStatus;
}

// ---------- Equipment service helpers (transactional) ----------
function runInTx<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const res = fn();
    db.exec('COMMIT');
    bumpStateRev();
    return res;
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore rollback error
    }
    throw err;
  }
}

interface EqItemRow {
  id: number;
  model_id: number;
  model_name: string;
  category_id: number;
  category_name: string;
  category_kind: string;
  serial_number: string;
  place: string;
  status_id: number | null;
  status: string;
  status_usable: boolean;
  point_id: string | null;
  person_id: number | null;
  person_name: string | null;
  held_reason: string | null;
  removed_point_id: string | null;
  removal_reason: string | null;
  removed_date: string | null;
  issued_date: string | null;
}

const EQ_SELECT = `
  SELECT e.*, m.name as model_name, m.category_id, c.name as category_name, c.kind as category_kind,
         s.name as status_name, s.usable as status_usable, p.full_name as person_full_name
  FROM equipment e
  JOIN equipment_models m ON m.id = e.model_id
  JOIN equipment_categories c ON c.id = m.category_id
  LEFT JOIN equipment_statuses s ON s.id = e.status_id
  LEFT JOIN people p ON p.id = e.person_id
`;

function mapEqRow(r: Record<string, unknown>): EqItemRow {
  return {
    id: Number(r.id),
    model_id: Number(r.model_id),
    model_name: String(r.model_name || ''),
    category_id: Number(r.category_id),
    category_name: String(r.category_name || ''),
    category_kind: String(r.category_kind || ''),
    serial_number: String(r.serial_number || ''),
    place: String(r.place || 'stock'),
    status_id: r.status_id != null ? Number(r.status_id) : null,
    status: String(r.status_name || ''),
    status_usable: Boolean(r.status_usable),
    point_id: r.point_id != null ? String(r.point_id) : null,
    person_id: r.person_id != null ? Number(r.person_id) : null,
    person_name: r.person_full_name ? decryptField(String(r.person_full_name)) : null,
    held_reason: r.held_reason != null ? String(r.held_reason) : null,
    removed_point_id: r.removed_point_id != null ? String(r.removed_point_id) : null,
    removal_reason: r.removal_reason != null ? String(r.removal_reason) : null,
    removed_date: r.removed_date != null ? String(r.removed_date) : null,
    issued_date: r.issued_date != null ? String(r.issued_date) : null,
  };
}

function shortEq(i: EqItemRow) {
  return {
    id: i.id,
    serial_number: i.serial_number,
    model_id: i.model_id,
    model_name: i.model_name,
    category_id: i.category_id,
    category_name: i.category_name,
    category_kind: i.category_kind,
    place: i.place,
    status: i.status,
    status_usable: i.status_usable,
    point_id: i.point_id,
    person_id: i.person_id,
    person_name: i.person_name,
    held_reason: i.held_reason,
    removed_point_id: i.removed_point_id,
    removal_reason: i.removal_reason,
    removed_date: i.removed_date,
    issued_date: i.issued_date,
  };
}

function getEqItem(db: DatabaseSync, id: number): EqItemRow | null {
  const r = db.prepare(`${EQ_SELECT} WHERE e.id = ?`).get(id) as Record<string, unknown> | undefined;
  return r ? mapEqRow(r) : null;
}

function requireEqItem(db: DatabaseSync, id: number): EqItemRow {
  const item = getEqItem(db, id);
  if (!item) throw new HttpError(404, 'Оборудование не найдено');
  return item;
}

function findEqBySerial(db: DatabaseSync, serial: string): EqItemRow | null {
  const s = serial.trim();
  if (!s) return null;
  const r = db.prepare(`${EQ_SELECT} WHERE lower(e.serial_number) = lower(?) LIMIT 1`).get(s) as
    | Record<string, unknown>
    | undefined;
  return r ? mapEqRow(r) : null;
}

function listEqItems(
  db: DatabaseSync,
  opts: { place?: string; usable?: boolean; category_id?: number | null; search?: string; limit?: number; offset?: number } = {},
): { items: EqItemRow[]; total: number } {
  const where: string[] = [];
  const params: SQLInputValue[] = [];
  if (opts.place) {
    where.push('e.place = ?');
    params.push(opts.place);
  }
  if (opts.usable) {
    where.push('coalesce(s.usable, 0) = 1');
  }
  if (opts.category_id) {
    where.push('m.category_id = ?');
    params.push(opts.category_id);
  }
  if (opts.search && opts.search.trim()) {
    const q = `%${opts.search.trim()}%`;
    where.push('(e.serial_number LIKE ? OR m.name LIKE ? OR c.name LIKE ?)');
    params.push(q, q, q);
  }
  const wSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const totalRow = db
    .prepare(
      `SELECT count(*) as c FROM equipment e
       JOIN equipment_models m ON m.id = e.model_id
       JOIN equipment_categories c ON c.id = m.category_id
       LEFT JOIN equipment_statuses s ON s.id = e.status_id
       ${wSql}`,
    )
    .get(...params) as { c: number };
  const limit = opts.limit ?? 500;
  const offset = opts.offset ?? 0;
  const rows = db
    .prepare(`${EQ_SELECT} ${wSql} ORDER BY c.name, m.name, e.serial_number LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as Array<Record<string, unknown>>;
  return { items: rows.map(mapEqRow), total: totalRow.c || 0 };
}

function isSim(item: EqItemRow | null | undefined): boolean {
  return Boolean(item) && item!.category_kind === 'sim';
}

function roleStatusId(db: DatabaseSync, role: 'ok' | 'defect'): number | null {
  const r = db.prepare('SELECT id FROM equipment_statuses WHERE role = ? ORDER BY id LIMIT 1').get(role) as
    | { id: number }
    | undefined;
  return r?.id ?? null;
}

function whereIs(item: EqItemRow): string {
  if (item.place === 'person') return `у монтёра «${item.person_name || '—'}»`;
  if (item.place === 'point') return `на комплексе «${item.point_id}»`;
  if (item.place === 'unknown') {
    return `в неизвестном местонахождении${item.removed_point_id ? ` (числилось на «${item.removed_point_id}»)` : ''}`;
  }
  return 'на складе';
}

function addEqHistory(
  db: DatabaseSync,
  actionType: string,
  opts: {
    item?: EqItemRow | null;
    equipment_id?: number | null;
    serial_number?: string | null;
    model_name?: string | null;
    point_id?: string | null;
    person_id?: number | null;
    person_name?: string | null;
    performed_by?: string | null;
    comment?: string | null;
    event_date?: string | null;
  },
): void {
  const ts = nowIso();
  db.prepare(
    `INSERT INTO equipment_history (ts, equipment_id, serial_number, model_name, action_type, person_name, point_id, performed_by, comment, event_date, person_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    ts,
    opts.item?.id ?? opts.equipment_id ?? null,
    opts.item?.serial_number ?? opts.serial_number ?? null,
    opts.item?.model_name ?? opts.model_name ?? null,
    actionType,
    opts.person_name ?? null,
    opts.point_id ?? null,
    opts.performed_by ?? '',
    opts.comment ?? '',
    opts.event_date || todayIso(),
    opts.person_id ?? null,
  );
}

function groupIdsConn(db: DatabaseSync, pointId: string): string[] {
  const row = db.prepare('SELECT group_id FROM point_sim_links WHERE point_id = ?').get(pointId) as
    | { group_id: number }
    | undefined;
  if (!row) return [pointId];
  const rows = db.prepare('SELECT point_id FROM point_sim_links WHERE group_id = ? ORDER BY point_id').all(row.group_id) as Array<{
    point_id: string;
  }>;
  return rows.length ? rows.map((r) => r.point_id) : [pointId];
}

function setPointSimConn(db: DatabaseSync, pointId: string, sim: string): string {
  const clean = simKey(sim);
  const reg = db.prepare('SELECT ip_address FROM sim_ip_registry WHERE sim_number = ?').get(clean) as
    | { ip_address: string }
    | undefined;
  const ip = reg?.ip_address || '';
  for (const pid of groupIdsConn(db, pointId)) {
    if (ip) {
      db.prepare('UPDATE points SET sim_number = ?, ip_address = ? WHERE id = ?').run(clean, ip, pid);
    } else {
      db.prepare('UPDATE points SET sim_number = ? WHERE id = ?').run(clean, pid);
    }
  }
  return ip;
}

function clearPointSimConn(db: DatabaseSync, pointId: string, removedSim: string): void {
  db.prepare("UPDATE points SET sim_number = '' WHERE id = ? AND sim_number = ?").run(pointId, removedSim);
  db.prepare('DELETE FROM point_sim_links WHERE point_id = ?').run(pointId);
}

function reuseKeptConn(db: DatabaseSync, item: EqItemRow): string {
  if (!(item.place === 'person' && item.held_reason === 'kept')) return '';
  const okId = roleStatusId(db, 'ok');
  if (okId && !item.status_usable) {
    db.prepare('UPDATE equipment SET status_id = ? WHERE id = ?').run(okId, item.id);
  }
  return `Снятая ранее (оставалась у монтёра${item.removed_point_id ? ` с «${item.removed_point_id}»` : ''}) поставлена снова`;
}

function markUnknownConn(
  db: DatabaseSync,
  item: EqItemRow,
  opts: { point_id?: string | null; date: string; performed_by?: string | null; comment: string },
): void {
  db.prepare(
    `UPDATE equipment SET place = 'unknown', person_id = NULL, held_reason = NULL, point_id = NULL,
       installed_date = NULL, installed_by = NULL, removed_date = ?, removed_by = ?, removed_point_id = ?,
       updated_at = ? WHERE id = ?`,
  ).run(opts.date, opts.performed_by || null, opts.point_id || null, nowIso(), item.id);
  addEqHistory(db, 'unknown', {
    item,
    point_id: opts.point_id || null,
    performed_by: opts.performed_by,
    comment: opts.comment,
    event_date: opts.date,
  });
}

function resolveActualConn(
  db: DatabaseSync,
  expected: EqItemRow,
  actualEquipmentId: number | null | undefined,
  actualSerial: string | null | undefined,
  createMissing: boolean,
  performedBy: string,
): EqItemRow | null {
  if (actualEquipmentId) {
    const item = requireEqItem(db, actualEquipmentId);
    if (item.id === expected.id) return null;
    return item;
  }
  const clean = String(actualSerial || '').trim();
  if (!clean || clean.toLowerCase() === expected.serial_number.toLowerCase()) return null;
  const existing = findEqBySerial(db, clean);
  if (existing) return existing.id === expected.id ? null : existing;
  if (!createMissing) {
    throw new HttpError(404, `Оборудование с номером №${clean} не найдено в учёте`);
  }
  const okId = roleStatusId(db, 'ok');
  const now = nowIso();
  const today = todayIso();
  const info = db
    .prepare(
      `INSERT INTO equipment (model_id, serial_number, place, status_id, received_date, notes, created_at, updated_at)
       VALUES (?, ?, 'stock', ?, ?, ?, ?, ?)`,
    )
    .run(expected.model_id, clean, okId, today, 'Заведено при сверке снятия', now, now);
  const created = requireEqItem(db, Number(info.lastInsertRowid));
  addEqHistory(db, 'receive', {
    item: created,
    performed_by: performedBy,
    comment: 'Заведено при сверке: фактически стояло вместо №' + expected.serial_number,
    event_date: today,
  });
  return created;
}

function applyActualConn(
  db: DatabaseSync,
  expected: EqItemRow,
  actual: EqItemRow | null,
  pointId: string,
  date: string,
  performedBy: string,
): { removed: EqItemRow; note: string; marked: boolean } {
  if (!actual) return { removed: expected, note: '', marked: false };
  if (actual.place === 'point' && actual.point_id === pointId) {
    return { removed: actual, note: '', marked: false };
  }
  const note = `Фактически стояло №${actual.serial_number} (по системе — №${expected.serial_number}); раньше числилось: ${whereIs(actual)}`;
  markUnknownConn(db, expected, {
    point_id: pointId,
    date,
    performed_by: performedBy,
    comment: `На комплексе «${pointId}» стояло другое оборудование (№${actual.serial_number}) — где оно сейчас, неизвестно`,
  });
  return { removed: actual, note, marked: true };
}

function detachConn(
  db: DatabaseSync,
  item: EqItemRow,
  opts: {
    point_id: string;
    to_person: PersonRow | null;
    date: string;
    performed_by: string;
    comment?: string | null;
    status_id?: number | null;
    action: string;
    extra?: string;
    reason?: string | null;
    sync_point?: boolean;
  },
): void {
  const syncPoint = opts.sync_point ?? true;
  const newStatus = opts.status_id ?? roleStatusId(db, 'defect');
  const removedBy = opts.to_person ? opts.to_person.full_name : opts.performed_by;
  const reason = (opts.reason || '').trim() || null;
  const keep = Boolean(opts.to_person) && isSim(item);
  const now = nowIso();
  if (opts.to_person) {
    db.prepare(
      `UPDATE equipment SET place = 'person', person_id = ?, held_reason = ?, point_id = NULL,
         installed_date = NULL, installed_by = NULL, status_id = ?, removed_date = ?, removed_by = ?,
         removed_point_id = ?, accepted_date = NULL, accepted_by = NULL, removal_reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      opts.to_person.id,
      keep ? 'kept' : 'removed',
      newStatus,
      opts.date,
      removedBy,
      opts.point_id,
      reason,
      now,
      item.id,
    );
  } else {
    db.prepare(
      `UPDATE equipment SET place = 'stock', person_id = NULL, held_reason = NULL, point_id = NULL,
         installed_date = NULL, installed_by = NULL, status_id = ?, removed_date = ?, removed_by = ?,
         removed_point_id = ?, accepted_date = ?, accepted_by = ?, removal_reason = ?, updated_at = ?
       WHERE id = ?`,
    ).run(newStatus, opts.date, removedBy, opts.point_id, opts.date, opts.performed_by, reason, now, item.id);
  }
  if (syncPoint && isSim(item)) {
    clearPointSimConn(db, opts.point_id, item.serial_number);
  }
  const pieces: string[] = [];
  if (opts.extra) pieces.push(opts.extra);
  if (reason) pieces.push(`Причина снятия: ${reason}`);
  if (keep && opts.to_person) {
    pieces.push(`Осталась у монтёра ${opts.to_person.full_name} — сдавать на склад не обязательно, он может поставить её снова`);
  } else if (opts.to_person) {
    pieces.push(`Числится на монтёре ${opts.to_person.full_name} — сдать на склад`);
  }
  if (opts.comment) pieces.push(opts.comment);
  addEqHistory(db, opts.action, {
    item,
    point_id: opts.point_id,
    person_id: opts.to_person?.id ?? null,
    person_name: opts.to_person?.full_name ?? null,
    performed_by: opts.performed_by,
    comment: pieces.filter(Boolean).join('. ') || null,
    event_date: opts.date,
  });
}

function attachConn(
  db: DatabaseSync,
  item: EqItemRow,
  opts: {
    point_id: string;
    person: PersonRow | null;
    installed_by?: string | null;
    date: string;
    performed_by: string;
    comment?: string | null;
    action: string;
    extra?: string;
    sync_point?: boolean;
  },
): void {
  const syncPoint = opts.sync_point ?? true;
  let person = opts.person;
  if (item.place === 'stock') {
    if (!item.status_usable) {
      throw new HttpError(
        409,
        `№${item.serial_number} имеет состояние «${item.status || '—'}» — выдавать и ставить такое нельзя.`,
      );
    }
  } else if (item.place === 'person' && (item.held_reason === 'issued' || item.held_reason === 'kept')) {
    if (person && item.person_id !== person.id) {
      throw new HttpError(
        409,
        `№${item.serial_number} ${item.held_reason === 'kept' ? 'числится на другом монтёре' : 'выдано другому монтёру'} — ${item.person_name}`,
      );
    }
    if (!person && item.person_id) {
      person = { id: item.person_id, full_name: item.person_name || '', phone: '', role_type: 'fitter', vk_id: 0, active: true };
    }
  } else {
    throw new HttpError(409, `№${item.serial_number} сейчас ${whereIs(item)} — поставить на комплекс нельзя`);
  }
  const by = (opts.installed_by || '').trim() || person?.full_name || null;
  const again = reuseKeptConn(db, item);
  const extra = [opts.extra, again].filter(Boolean).join('. ');
  db.prepare(
    `UPDATE equipment SET place = 'point', point_id = ?, person_id = NULL, held_reason = NULL, issued_date = NULL,
       installed_date = ?, installed_by = ?, removed_date = NULL, removed_by = NULL, removed_point_id = NULL,
       accepted_date = NULL, accepted_by = NULL, removal_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(opts.point_id, opts.date, by, nowIso(), item.id);
  if (syncPoint && isSim(item)) {
    setPointSimConn(db, opts.point_id, item.serial_number);
  }
  const cmt = [by ? `Монтёр: ${by}` : '', extra, opts.comment || ''].filter(Boolean).join('. ') || null;
  addEqHistory(db, opts.action, {
    item,
    point_id: opts.point_id,
    person_id: person?.id ?? null,
    person_name: by,
    performed_by: opts.performed_by,
    comment: cmt,
    event_date: opts.date,
  });
}

function newSimItemConn(
  db: DatabaseSync,
  key: string,
  opts: { point_id: string | null; performed_by: string; comment?: string },
): EqItemRow {
  const simCat = db.prepare("SELECT id FROM equipment_categories WHERE kind = 'sim' ORDER BY id LIMIT 1").get() as
    | { id: number }
    | undefined;
  if (!simCat) throw new HttpError(500, 'В справочнике отсутствует категория SIM-карт');
  let simModel = db.prepare('SELECT id FROM equipment_models WHERE category_id = ? ORDER BY id LIMIT 1').get(simCat.id) as
    | { id: number }
    | undefined;
  if (!simModel) {
    const info = db.prepare("INSERT INTO equipment_models (category_id, name) VALUES (?, 'SIM-карта (оператор не указан)')").run(simCat.id);
    simModel = { id: Number(info.lastInsertRowid) };
  }
  const okId = roleStatusId(db, 'ok');
  const now = nowIso();
  const today = todayIso();
  const info = db
    .prepare(
      `INSERT INTO equipment (model_id, serial_number, place, status_id, point_id, received_date, installed_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      simModel.id,
      key,
      opts.point_id ? 'point' : 'stock',
      okId,
      opts.point_id,
      today,
      opts.point_id ? today : null,
      now,
      now,
    );
  const created = requireEqItem(db, Number(info.lastInsertRowid));
  addEqHistory(db, opts.point_id ? 'attach' : 'receive', {
    item: created,
    point_id: opts.point_id,
    performed_by: opts.performed_by,
    comment: opts.comment || null,
    event_date: today,
  });
  return created;
}

function putOnPointConn(
  db: DatabaseSync,
  item: EqItemRow,
  opts: { point_id: string; date: string; installed_by?: string | null; performed_by: string; action: string; comment?: string | null },
): void {
  const again = reuseKeptConn(db, item);
  const cmt = [opts.comment || '', again].filter(Boolean).join('. ') || null;
  db.prepare(
    `UPDATE equipment SET place = 'point', point_id = ?, person_id = NULL, held_reason = NULL, issued_date = NULL,
       installed_date = ?, installed_by = ?, removed_date = NULL, removed_by = NULL, removed_point_id = NULL,
       accepted_date = NULL, accepted_by = NULL, removal_reason = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(opts.point_id, opts.date, opts.installed_by || null, nowIso(), item.id);
  addEqHistory(db, opts.action, {
    item,
    point_id: opts.point_id,
    person_name: opts.installed_by || null,
    performed_by: opts.performed_by,
    comment: cmt,
    event_date: opts.date,
  });
}

function renameEqConn(
  db: DatabaseSync,
  item: EqItemRow,
  newSerial: string,
  opts: { performed_by: string; note?: string; comment?: string; sync_point?: boolean },
): string {
  const clean = isSim(item) ? simKey(newSerial) : newSerial.trim();
  if (!clean) throw new HttpError(400, 'Укажите номер');
  if (clean === item.serial_number) throw new HttpError(400, 'Номер не изменился');
  const other = findEqBySerial(db, clean);
  if (other && other.id !== item.id) {
    throw new HttpError(409, `№${clean} уже есть в базе: ${other.category_name}, ${whereIs(other)}`);
  }
  db.prepare('UPDATE equipment SET serial_number = ?, updated_at = ? WHERE id = ?').run(clean, nowIso(), item.id);
  addEqHistory(db, 'rename', {
    item: { ...item, serial_number: clean },
    point_id: item.point_id,
    performed_by: opts.performed_by,
    comment: [`Было №${item.serial_number}, стало №${clean}`, opts.note, opts.comment].filter(Boolean).join('. '),
  });
  if ((opts.sync_point ?? true) && isSim(item) && item.place === 'point' && item.point_id) {
    setPointSimConn(db, item.point_id, clean);
  }
  return clean;
}

function simFixConn(db: DatabaseSync, pointId: string, serial: string, performedBy: string, comment?: string) {
  const key = simKey(serial);
  if (!key) throw new HttpError(400, 'Укажите номер SIM-карты');
  const point = requirePointOr404(db, pointId);
  const pid = String(point.id);
  const installed = groupIdsConn(db, pid).flatMap((gPid) => {
    const rows = db
      .prepare(`${EQ_SELECT} WHERE e.place = 'point' AND e.point_id = ? AND c.kind = 'sim'`)
      .all(gPid) as Array<Record<string, unknown>>;
    return rows.map(mapEqRow);
  });
  let oldSerial = '';
  if (installed.length > 0) {
    const current = installed[0];
    oldSerial = current.serial_number;
    if (oldSerial === key) throw new HttpError(400, 'Этот номер уже записан на комплексе');
    renameEqConn(db, current, key, {
      performed_by: performedBy,
      comment,
      note: `Исправлен номер SIM комплекса «${pid}» (раньше был указан неверно)`,
    });
  } else {
    const existing = findEqBySerial(db, key);
    if (existing) {
      if (!isSim(existing)) {
        throw new HttpError(409, `№${key} уже занят другим оборудованием (${existing.category_name}) — это не SIM-карта`);
      }
      if (existing.place === 'point') {
        throw new HttpError(409, `SIM №${key} числится на комплексе «${existing.point_id}»`);
      }
      putOnPointConn(db, existing, {
        point_id: pid,
        date: todayIso(),
        performed_by: performedBy,
        action: 'attach',
        comment: comment || null,
      });
    } else {
      newSimItemConn(db, key, {
        point_id: pid,
        performed_by: performedBy,
        comment: comment || 'Номер SIM указан при работе на комплексе',
      });
    }
    setPointSimConn(db, pid, key);
  }
  const ipRow = db.prepare('SELECT ip_address FROM sim_ip_registry WHERE sim_number = ?').get(key) as
    | { ip_address: string }
    | undefined;
  const ip = ipRow?.ip_address || '';
  if (ip) db.prepare('UPDATE points SET ip_address = ? WHERE id = ?').run(ip, pid);
  return { old: oldSerial, installed: key, ip_known: Boolean(ip), ip_address: ip };
}

function suffixState(item: EqItemRow): { usable: boolean; why: string } {
  if (item.place === 'stock') {
    if (item.status_usable) return { usable: true, why: 'на складе' };
    return { usable: false, why: `на складе, но состояние «${item.status || '—'}» — ставить такое нельзя` };
  }
  if (item.place === 'person' && (item.held_reason === 'issued' || item.held_reason === 'kept')) {
    return { usable: true, why: whereIs(item) };
  }
  return { usable: false, why: whereIs(item) };
}

function sendErr(res: Response, err: unknown): void {
  if (err instanceof HttpError) {
    res.status(err.status).json({ detail: err.message });
    return;
  }
  const msg = err instanceof Error ? err.message : 'Ошибка сервера';
  res.status(500).json({ detail: msg });
}

// ---------- Gemini voice parsing ----------
let geminiClient: GoogleGenAI | null = null;
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim();
  if (!apiKey) return null;
  if (!geminiClient) {
    geminiClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: { 'User-Agent': 'aistudio-build' },
      },
    });
  }
  return geminiClient;
}

async function runVoiceAiJob(
  jobId: string,
  audioBuffer: Buffer,
  mimeType: string,
  visitType: string,
  pointId: string,
): Promise<void> {
  const db = getDb();
  const startedAt = nowIso();
  db.prepare("UPDATE ai_jobs SET status = 'running', started_at = ?, attempts = attempts + 1 WHERE id = ?").run(startedAt, jobId);

  try {
    const ai = getGeminiClient();
    if (!ai) throw new Error('Gemini API не настроен на сервере');

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType,
              data: audioBuffer.toString('base64'),
            },
          },
          {
            text:
              `Расшифруй голосовое сообщение монтёра дорожных комплексов (АПК/камеры/светофоры) на русском языке` +
              (pointId ? ` по комплексу «${pointId}»` : '') +
              (visitType ? ` (тип выезда: ${visitType})` : '') +
              `. Затем разложи смысл на поля JSON: ` +
              `transcript (точная дословная расшифровка речи), ` +
              `done (краткий итог: что именно сделано, 1-2 предложения), ` +
              `cause (причина неисправности, если озвучена, иначе пустая строка), ` +
              `needs (что нужно для устранения: запчасти/доступ/оборудование, если озвучено, иначе пустая строка).`,
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            transcript: { type: Type.STRING },
            done: { type: Type.STRING },
            cause: { type: Type.STRING },
            needs: { type: Type.STRING },
          },
          required: ['transcript', 'done', 'cause', 'needs'],
        },
      },
    });

    const parsed = JSON.parse((response.text || '{}').trim()) as {
      transcript?: string;
      done?: string;
      cause?: string;
      needs?: string;
    };
    const transcript = String(parsed.transcript || '').trim();
    if (!transcript) {
      throw new Error('Речь не распознана — запись пустая или слишком тихая. Запишите ещё раз ближе к микрофону.');
    }
    const result = {
      transcript,
      duration: 0,
      done: String(parsed.done || '').trim() || transcript,
      cause: String(parsed.cause || '').trim(),
      needs: String(parsed.needs || '').trim(),
      fixed: false,
      used_ai: true,
    };
    db.prepare("UPDATE ai_jobs SET status = 'done', finished_at = ?, result = ?, error = NULL WHERE id = ?").run(
      nowIso(),
      JSON.stringify(result),
      jobId,
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    db.prepare("UPDATE ai_jobs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(nowIso(), msg, jobId);
  }
}

export function createBotApiRouter(): Router {
  const router = Router();

  // ---- TASKS & SESSIONS ----
  router.get('/api/bot/tasks', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const vkId = Number(req.query.vk_id);
      const day = String(req.query.day || todayIso());
      const person = requirePersonByVk(db, vkId);

      const myCrews = db
        .prepare(
          'SELECT c.id, c.trip_id FROM crews c JOIN crew_members cm ON cm.crew_id = c.id WHERE cm.person_id = ? AND c.date = ?',
        )
        .all(person.id, day) as Array<{ id: number; trip_id: string | null }>;
      if (!myCrews.length) {
        res.json([]);
        return;
      }

      const teamIds = new Set<number>();
      for (const c of myCrews) {
        if (c.trip_id) {
          const tripCrews = db.prepare('SELECT id FROM crews WHERE trip_id = ?').all(c.trip_id) as Array<{ id: number }>;
          for (const tc of tripCrews) teamIds.add(tc.id);
        } else {
          teamIds.add(c.id);
        }
      }
      const idsArr = Array.from(teamIds);
      const ph = idsArr.map(() => '?').join(',');
      const rows = db
        .prepare(
          `SELECT t.id, t.point, t.work, t.address, t.type, p.address as point_address,
                  c.name as crew_name, c.map_link, p.sim_number as point_sim, p.power_source as point_power_source,
                  t.aux_lat, t.aux_lon
           FROM tasks t
           JOIN crews c ON c.id = t.team
           LEFT JOIN points p ON p.id = t.point
           LEFT JOIN task_visit_reports r ON r.task_id = t.id
           WHERE t.team IN (${ph}) AND r.task_id IS NULL
             AND (t.type != ? OR t.id NOT IN (SELECT task_id FROM aux_task_done))
           ORDER BY t.date, t.id`,
        )
        .all(...(idsArr as SQLInputValue[]), AUX_TYPE_NAME) as Array<Record<string, unknown>>;

      const tasks = rows.map((r) => ({ ...r })) as Array<Record<string, unknown>>;
      for (const t of tasks) {
        if (t.point && t.type !== AUX_TYPE_NAME && t.point_address == null) {
          const canon = canonicalPointId(db, String(t.point));
          if (canon && canon !== t.point) {
            const pFound = db.prepare('SELECT address, sim_number, power_source FROM points WHERE id = ?').get(canon) as
              | { address: string; sim_number: string; power_source: string }
              | undefined;
            if (pFound) {
              t.point = canon;
              t.point_address = pFound.address;
              t.point_sim = pFound.sim_number;
              t.point_power_source = pFound.power_source;
            }
          }
        }
      }

      const taskIds = tasks.map((t) => String(t.id));
      const photoMap = new Map<string, number>();
      const progMap = new Map<string, Record<string, unknown>>();
      const workerMap = activeWorkersForTasks(db, taskIds);
      if (taskIds.length) {
        const tPh = taskIds.map(() => '?').join(',');
        for (const pr of db
          .prepare(`SELECT task_id, count(*) as c FROM visit_photos WHERE task_id IN (${tPh}) GROUP BY task_id`)
          .all(...(taskIds as SQLInputValue[])) as Array<{ task_id: string; c: number }>) {
          photoMap.set(pr.task_id, pr.c);
        }
        for (const pgr of db
          .prepare(`SELECT task_id, state FROM bot_task_progress WHERE task_id IN (${tPh})`)
          .all(...(taskIds as SQLInputValue[])) as Array<{ task_id: string; state: string }>) {
          try {
            const parsed = JSON.parse(pgr.state || '{}');
            if (parsed && typeof parsed === 'object') progMap.set(pgr.task_id, parsed as Record<string, unknown>);
          } catch {
            // ignore
          }
        }
      }

      const typeMetaCache = new Map<string, ReturnType<typeof workTypeMeta>>();
      for (const t of tasks) {
        const tid = String(t.id);
        const tType = String(t.type || '');
        if (!typeMetaCache.has(tType)) typeMetaCache.set(tType, workTypeMeta(db, tType));
        const meta = typeMetaCache.get(tType)!;
        const st = progMap.get(tid) || {};
        const onPoint = workerMap.get(tid) || [];
        const photoCount = photoMap.get(tid) || 0;
        t.photo_count = photoCount;
        t.has_report = Boolean(String(st.report_text || '').trim());
        t.in_work_by = onPoint.filter((w) => w.person_id !== person.id).map((w) => w.name);
        t.i_am_working = onPoint.some((w) => w.person_id === person.id);
        t.started = Boolean(progMap.has(tid) || onPoint.length || photoCount);
        t.is_aux = tType === AUX_TYPE_NAME;
        t.point_sim = String(t.point_sim || '');
        t.point_power_source = String(t.point_power_source || '');
        t.type_is_repair = meta.is_repair;
        t.type_outcomes = meta.is_repair ? [] : meta.outcomes;
        t.type_tools = meta.bot_tools;
      }

      res.json(tasks);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/aux-accept', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.body?.vk_id));
      const task = getTaskOr404(db, String(req.body?.task_id || ''));
      if (task.type !== AUX_TYPE_NAME) throw new HttpError(400, 'Это не вспомогательная точка');
      db.prepare('INSERT OR REPLACE INTO aux_task_done (task_id, done_at, done_by) VALUES (?, ?, ?)').run(
        task.id,
        nowIso(),
        person.full_name,
      );
      bumpStateRev();
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/active-session', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.query.vk_id));
      const session = db
        .prepare('SELECT * FROM bot_work_sessions WHERE person_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
        .get(person.id) as Record<string, unknown> | undefined;
      if (!session) {
        res.json({ session: null });
        return;
      }
      const taskId = String(session.task_id);
      const reported = db.prepare('SELECT 1 FROM task_visit_reports WHERE task_id = ?').get(taskId);
      const exists = db.prepare('SELECT 1 FROM tasks WHERE id = ?').get(taskId);
      if (reported || !exists) {
        db.prepare('UPDATE bot_work_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(nowIso(), Number(session.id));
        res.json({ session: null });
        return;
      }
      res.json({ session });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/tasks/:taskId/progress', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.query.vk_id));
      const taskId = String(req.params.taskId);
      getTaskOr404(db, taskId);
      res.json(progressPayload(db, taskId, person));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.put('/api/bot/tasks/:taskId/progress', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.body?.vk_id));
      const taskId = String(req.params.taskId);
      getTaskOr404(db, taskId);
      const patch = req.body?.patch && typeof req.body.patch === 'object' ? (req.body.patch as Record<string, unknown>) : {};
      const existingRow = db.prepare('SELECT state FROM bot_task_progress WHERE task_id = ?').get(taskId) as
        | { state: string }
        | undefined;
      let merged: Record<string, unknown> = {};
      if (existingRow?.state) {
        try {
          const parsed = JSON.parse(existingRow.state);
          if (parsed && typeof parsed === 'object') merged = { ...(parsed as Record<string, unknown>) };
        } catch {
          merged = {};
        }
      }
      for (const [k, v] of Object.entries(patch)) {
        merged[k] = v;
      }
      db.prepare(
        `INSERT INTO bot_task_progress (task_id, state, updated_at, updated_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(task_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
      ).run(taskId, JSON.stringify(merged), nowIso(), person.full_name);
      res.json(progressPayload(db, taskId, person));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/tasks/:taskId/watch', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const taskId = String(req.params.taskId);
      const sessionId = Number(req.query.work_session_id);
      const vkId = req.query.vk_id ? Number(req.query.vk_id) : null;
      const session = db.prepare('SELECT ended_at FROM bot_work_sessions WHERE id = ?').get(sessionId) as
        | { ended_at: string | null }
        | undefined;
      const closedExternally = Boolean(session?.ended_at);
      const demontage = db
        .prepare(
          "SELECT * FROM demontage_requests WHERE task_id = ? AND initiated_by = 'dispatcher' ORDER BY id DESC LIMIT 1",
        )
        .get(taskId) as Record<string, unknown> | undefined;
      const result: Record<string, unknown> = {
        closed_externally: closedExternally,
        demontage: demontage && demontage.status === 'approved' ? demontage : null,
      };
      if (vkId) {
        const pRow = db.prepare('SELECT id, full_name, phone, role_type, vk_id, active FROM people WHERE vk_id = ?').get(vkId) as
          | Record<string, unknown>
          | undefined;
        if (pRow) {
          const person: PersonRow = {
            id: Number(pRow.id),
            full_name: decryptField(String(pRow.full_name || '')),
            phone: decryptField(String(pRow.phone || '')),
            role_type: String(pRow.role_type || ''),
            vk_id: Number(pRow.vk_id),
            active: Boolean(pRow.active),
          };
          const prog = progressPayload(db, taskId, person);
          result.progress = prog;
          result.finished = prog.finished;
        }
      }
      res.json(result);
    } catch (err) {
      sendErr(res, err);
    }
  });

  // ---- POINTS (regex routes support point IDs containing "/") ----
  router.post(/^\/api\/bot\/points\/(.+)\/power-source$/, requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const pointId = decodeURIComponent(req.params[0]);
      const value = normalizePowerSource(String(req.body?.power_source || ''));
      if (!value) throw new HttpError(400, 'Питание: СЭС или Электросеть');
      const point = requirePointOr404(db, pointId);
      db.prepare('UPDATE points SET power_source = ? WHERE id = ?').run(value, String(point.id));
      bumpStateRev();
      res.json({ ok: true, power_source: value });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post(/^\/api\/bot\/points\/(.+)\/sim$/, requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const rawPointId = decodeURIComponent(req.params[0]);
      const point = requirePointOr404(db, rawPointId);
      const pid = String(point.id);
      const rawSim = String(req.body?.sim_number || '').trim();
      const digits = rawSim.replace(/\D+/g, '');
      const simNormalized = (digits.length >= SIM_MIN_DIGITS ? digits.slice(-SIM_MIN_DIGITS) : digits) || rawSim;
      try {
        runInTx(db, () => simFixConn(db, pid, simNormalized, 'бот: номер SIM'));
      } catch (err) {
        if (!(err instanceof HttpError)) throw err;
      }
      const reg = db.prepare('SELECT ip_address FROM sim_ip_registry WHERE sim_number = ?').get(simNormalized) as
        | { ip_address: string }
        | undefined;
      const knownIp = reg?.ip_address || '';
      const finalIp = knownIp || String(point.ip_address || '');
      if (knownIp) {
        db.prepare('UPDATE points SET sim_number = ?, ip_address = ? WHERE id = ?').run(simNormalized, knownIp, pid);
      } else {
        db.prepare('UPDATE points SET sim_number = ? WHERE id = ?').run(simNormalized, pid);
      }
      bumpStateRev();
      res.json({ ok: true, sim_number: simNormalized, ip_address: finalIp, ip_known: Boolean(knownIp) });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post(/^\/api\/bot\/points\/(.+)\/power-status$/, requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const rawPointId = decodeURIComponent(req.params[0]);
      const statusVal = String(req.body?.status || '').trim();
      if (statusVal !== 'Нет питания' && statusVal !== 'Не подведено питание') {
        throw new HttpError(400, 'Неизвестный статус питания');
      }
      const point = requirePointOr404(db, rawPointId);
      const pid = String(point.id);
      const oldStatus = String(point.status || '');
      if (oldStatus !== statusVal) {
        db.prepare('UPDATE points SET status = ? WHERE id = ?').run(statusVal, pid);
        db.prepare(
          'INSERT INTO point_status_history (point_id, old_status, new_status, source, task_id, changed_at) VALUES (?, ?, ?, ?, NULL, ?)',
        ).run(pid, oldStatus, statusVal, 'visit_report', nowIso());
        bumpStateRev();
      }
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post(/^\/api\/bot\/points\/(.+)\/recheck$/, requireBotKey, async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const rawPointId = decodeURIComponent(req.params[0]);
      const point = requirePointOr404(db, rawPointId);
      const pid = String(point.id);
      const statusVal = await recheckPointAndApply(db, pid);
      res.json({ status: statusVal || '' });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get(/^\/api\/bot\/points\/(.+)$/, requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const point = requirePointOr404(db, decodeURIComponent(req.params[0]));
      res.json({
        id: point.id,
        sim_number: point.sim_number || '',
        ip_address: point.ip_address || '',
        status: point.status || '',
        power_source: point.power_source || '',
      });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // ---- VISIT REPORTS & PHOTOS ----
  router.post('/api/bot/visit-reports', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const task = getTaskOr404(db, String(b.task_id || ''));
      if (!task.point) throw new HttpError(400, 'У задания не указана точка');
      if (!task.type.trim()) throw new HttpError(400, 'У задания не указан тип работы');

      const repairMode = Boolean(b.repair_mode);
      const visitType = repairMode
        ? task.type.includes('Ремонт')
          ? task.type
          : `${task.type} + Ремонт`
        : task.type;
      const outcome = String(b.outcome || '').trim();
      if (outcome) {
        const meta = workTypeMeta(db, task.type);
        if (!meta.outcomes.includes(outcome)) {
          throw new HttpError(400, 'Такого статуса выезда нет у этого типа работ');
        }
      }
      const resultStatus = outcome ? '' : String(b.result_status || '');
      const visitIsRepair = workTypeMeta(db, visitType).is_repair || visitType.includes('Ремонт');
      const eqRemoved = visitIsRepair && b.equipment_removed != null ? String(b.equipment_removed) : null;
      const eqInstalled = visitIsRepair && b.equipment_installed != null ? String(b.equipment_installed) : null;
      const fault = b.fault != null ? String(b.fault) : null;
      const needs = b.needs != null ? String(b.needs) : null;
      const simRemoved = b.sim_removed != null ? String(b.sim_removed) : null;
      const simInstalled = b.sim_installed != null ? String(b.sim_installed) : null;
      const simRemovedState =
        b.sim_removed_state === 'working' || b.sim_removed_state === 'defective' ? b.sim_removed_state : '';
      const comment = String(b.comment || '');
      const now = nowIso();

      const existing = db.prepare('SELECT id FROM task_visit_reports WHERE task_id = ?').get(task.id) as
        | { id: number }
        | undefined;
      if (existing) {
        db.prepare(
          `UPDATE task_visit_reports
           SET point_id = ?, visit_type = ?, result_status = ?, comment = ?, equipment_removed = ?, equipment_installed = ?,
               outcome = ?, fault = ?, needs = ?, author_person_id = ?, updated_by = ?,
               sim_removed = ?, sim_installed = ?, sim_removed_state = ?, updated_at = ?
           WHERE task_id = ?`,
        ).run(
          task.point,
          visitType,
          resultStatus,
          comment,
          eqRemoved,
          eqInstalled,
          outcome,
          fault,
          needs,
          person.id,
          person.full_name,
          simRemoved,
          simInstalled,
          simRemovedState,
          now,
          task.id,
        );
      } else {
        db.prepare(
          `INSERT INTO task_visit_reports
           (task_id, point_id, visit_type, result_status, comment, equipment_removed, equipment_installed,
            outcome, fault, needs, author_person_id, updated_by, sim_removed, sim_installed, sim_removed_state,
            source, created_at, updated_at, created_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'bot', ?, ?, ?)`,
        ).run(
          task.id,
          task.point,
          visitType,
          resultStatus,
          comment,
          eqRemoved,
          eqInstalled,
          outcome,
          fault,
          needs,
          person.id,
          person.full_name,
          simRemoved,
          simInstalled,
          simRemovedState,
          now,
          now,
          person.full_name,
        );
      }

      if (resultStatus && task.point) {
        const pRow = db.prepare('SELECT status FROM points WHERE id = ?').get(task.point) as { status: string } | undefined;
        if (pRow && pRow.status !== resultStatus) {
          db.prepare('UPDATE points SET status = ? WHERE id = ?').run(resultStatus, task.point);
          db.prepare(
            'INSERT INTO point_status_history (point_id, old_status, new_status, source, task_id, changed_at) VALUES (?, ?, ?, ?, ?, ?)',
          ).run(task.point, pRow.status, resultStatus, 'visit_report', task.id, now);
        }
        if (resultStatus === NOT_WORKING) {
          db.prepare('UPDATE points SET fault_reason = ?, fault_need = ?, fault_at = ?, fault_by = ? WHERE id = ?').run(
            fault || '',
            needs || '',
            now,
            person.full_name,
            task.point,
          );
        } else if (resultStatus === WORKING) {
          db.prepare("UPDATE points SET fault_reason = '', fault_need = '', fault_at = '', fault_by = '' WHERE id = ?").run(
            task.point,
          );
        }
      }

      db.prepare('DELETE FROM bot_task_progress WHERE task_id = ?').run(task.id);
      db.prepare('UPDATE bot_work_sessions SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL').run(now, task.id);
      bumpStateRev();
      const saved = db.prepare('SELECT * FROM task_visit_reports WHERE task_id = ?').get(task.id) as Record<string, unknown>;
      res.json({ ...saved, imported: Boolean(saved.imported) });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/photos', requireBotKey, photoUpload.single('file'), async (req: Request, res: Response) => {
    try {
      const db = getDb();
      const vkId = Number(req.body?.vk_id);
      const taskId = String(req.body?.task_id || '');
      const person = requirePersonByVk(db, vkId);
      const task = getTaskOr404(db, taskId);
      if (!task.point) throw new HttpError(400, 'У задания не указана точка');
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) throw new HttpError(400, 'Пустой файл');

      const origName = (file.originalname || '').replace(/[^\x20-\x7e\u0400-\u04ff._-]/gi, '').trim().slice(-80);
      const ext = origName.includes('.') ? origName.split('.').pop()!.toLowerCase() : 'jpg';
      if (origName) {
        const dup = db
          .prepare('SELECT id FROM visit_photos WHERE task_id = ? AND file_name = ? LIMIT 1')
          .get(task.id, origName) as { id: number } | undefined;
        if (dup) {
          res.json({ id: dup.id, duplicate: true });
          return;
        }
      }
      const takenDate = todayIso();
      const now = nowIso();
      const info = db
        .prepare(
          `INSERT INTO visit_photos (task_id, point_id, taken_date, file_ext, uploaded_at, uploaded_by, storage, source, file_name, file_size)
           VALUES (?, ?, ?, ?, ?, ?, 'local', 'bot', ?, ?)`,
        )
        .run(task.id, task.point, takenDate, ext, now, person.full_name, origName || null, file.buffer.length);
      const photoId = Number(info.lastInsertRowid);
      const stored = await storeVisitPhoto(
        { id: photoId, point_id: task.point, taken_date: takenDate, file_ext: ext },
        file.buffer,
      );
      db.prepare('UPDATE visit_photos SET storage = ?, storage_path = ?, rel_path = ? WHERE id = ?').run(
        stored.storage,
        stored.storagePath,
        stored.relPath,
        photoId,
      );
      bumpStateRev();
      res.json({ id: photoId });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/photos', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.query.vk_id));
      const taskId = String(req.query.task_id || '');
      const rows = db
        .prepare(
          "SELECT id, uploaded_at FROM visit_photos WHERE task_id = ? AND uploaded_by = ? AND coalesce(source, '') != 'import' ORDER BY id ASC",
        )
        .all(taskId, person.full_name) as Array<{ id: number; uploaded_at: string }>;
      res.json(rows);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.delete('/api/bot/photos/:photoId', requireBotKey, async (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id));
      const photoId = Number(req.params.photoId);
      const taskId = String(req.query.task_id || '');
      const row = db
        .prepare('SELECT id, task_id, point_id, taken_date, file_ext, storage_path, rel_path, source FROM visit_photos WHERE id = ?')
        .get(photoId) as
        | {
            id: number;
            task_id: string;
            point_id: string;
            taken_date: string;
            file_ext: string;
            storage_path?: string | null;
            rel_path?: string | null;
            source?: string | null;
          }
        | undefined;
      if (!row || row.task_id !== taskId) throw new HttpError(404, 'Фото не найдено');
      await deleteVisitPhotoFiles(row);
      db.prepare('DELETE FROM visit_photos WHERE id = ?').run(photoId);
      bumpStateRev();
      res.json({ ok: true });
    } catch (err) {
      sendErr(res, err);
    }
  });

  // ---- VERIFICATION / ACCESS / DEMONTAGE REQUESTS ----
  router.post('/api/bot/verification-requests', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const task = getTaskOr404(db, String(req.body?.task_id || ''));
      if (!task.point) throw new HttpError(400, 'У задания не указана точка');
      const existing = db
        .prepare("SELECT * FROM verification_requests WHERE task_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
        .get(task.id) as Record<string, unknown> | undefined;
      if (existing) {
        res.json(existing);
        return;
      }
      const info = db
        .prepare("INSERT INTO verification_requests (task_id, point_id, created_at, status) VALUES (?, ?, ?, 'pending')")
        .run(task.id, task.point, nowIso());
      bumpStateRev();
      res.json(db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(Number(info.lastInsertRowid)));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/verification-requests/:requestId', requireBotKey, (req: Request, res: Response) => {
    const row = getDb().prepare('SELECT * FROM verification_requests WHERE id = ?').get(Number(req.params.requestId));
    if (!row) {
      res.status(404).json({ detail: 'Запрос не найден' });
      return;
    }
    res.json(row);
  });

  router.post('/api/bot/access-issues', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const task = getTaskOr404(db, String(req.body?.task_id || ''));
      if (!task.point) throw new HttpError(400, 'У задания не указана точка');
      const existing = db
        .prepare("SELECT * FROM access_issue_requests WHERE task_id = ? AND status = 'pending' ORDER BY id DESC LIMIT 1")
        .get(task.id) as Record<string, unknown> | undefined;
      if (existing) {
        res.json(existing);
        return;
      }
      const info = db
        .prepare("INSERT INTO access_issue_requests (task_id, point_id, created_at, status) VALUES (?, ?, ?, 'pending')")
        .run(task.id, task.point, nowIso());
      bumpStateRev();
      res.json(db.prepare('SELECT * FROM access_issue_requests WHERE id = ?').get(Number(info.lastInsertRowid)));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/access-issues/:requestId', requireBotKey, (req: Request, res: Response) => {
    const row = getDb().prepare('SELECT * FROM access_issue_requests WHERE id = ?').get(Number(req.params.requestId));
    if (!row) {
      res.status(404).json({ detail: 'Запрос не найден' });
      return;
    }
    res.json(row);
  });

  router.post('/api/bot/demontage-requests', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const task = getTaskOr404(db, String(req.body?.task_id || ''));
      if (!task.point) throw new HttpError(400, 'У задания не указана точка');
      const reason = String(req.body?.reason || '').trim();
      const kind = String(req.body?.kind || 'demontage');
      if (!reason) throw new HttpError(400, 'Укажите причину демонтажа');
      if (kind !== 'demontage' && kind !== 'release') throw new HttpError(400, 'Неизвестный тип запроса');
      const info = db
        .prepare(
          "INSERT INTO demontage_requests (task_id, point_id, reason, initiated_by, kind, created_at, status) VALUES (?, ?, ?, 'fitter', ?, ?, 'pending')",
        )
        .run(task.id, task.point, reason, kind, nowIso());
      bumpStateRev();
      res.json(db.prepare('SELECT * FROM demontage_requests WHERE id = ?').get(Number(info.lastInsertRowid)));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/demontage-requests/:requestId', requireBotKey, (req: Request, res: Response) => {
    const row = getDb().prepare('SELECT * FROM demontage_requests WHERE id = ?').get(Number(req.params.requestId));
    if (!row) {
      res.status(404).json({ detail: 'Запрос не найден' });
      return;
    }
    res.json(row);
  });

  // ---- BOT CHAT FILES / SEND PHOTOS ----
  router.post('/api/bot/chat/send-photos', requireBotKey, chatUpload.array('files', 10), (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.body?.vk_id));
      const text = String(req.body?.text || '').trim();
      const files = (req.files as Express.Multer.File[]) || [];
      if (!text && !files.length) throw new HttpError(400, 'Пустое сообщение');

      const now = nowIso();
      const info = db
        .prepare(
          "INSERT INTO chat_messages (person_id, direction, text, point_id, task_id, created_at) VALUES (?, 'in', ?, ?, ?, ?)",
        )
        .run(person.id, text, req.body?.point_id ? String(req.body.point_id) : null, req.body?.task_id ? String(req.body.task_id) : null, now);
      const messageId = Number(info.lastInsertRowid);
      if (files.length) {
        fs.mkdirSync(CHAT_FILES_DIR, { recursive: true });
        for (const f of files) {
          const origName = (f.originalname || 'photo.jpg').slice(-120);
          const ext = origName.includes('.') ? origName.split('.').pop()!.toLowerCase() : 'jpg';
          const attInfo = db
            .prepare(
              'INSERT INTO chat_attachments (message_id, file_ext, file_name, size, created_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(messageId, ext, origName, f.buffer.length, now);
          const aid = Number(attInfo.lastInsertRowid);
          fs.writeFileSync(path.join(CHAT_FILES_DIR, `${aid}.${ext}`), f.buffer);
        }
      }
      bumpStateRev();
      res.json({ id: messageId, photos: files.length });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/chat/files/:attId', requireBotKey, (req: Request, res: Response) => {
    const attId = Number(req.params.attId);
    const att = getDb()
      .prepare('SELECT id, file_ext, src_id FROM chat_attachments WHERE id = ?')
      .get(attId) as { id: number; file_ext: string; src_id: number | null } | undefined;
    if (!att) {
      res.status(404).json({ detail: 'Фото не найдено' });
      return;
    }
    const filePath = path.join(CHAT_FILES_DIR, `${att.src_id || att.id}.${att.file_ext}`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ detail: 'Файл фото уже удалён' });
      return;
    }
    res.setHeader('Content-Type', IMAGE_MIME[att.file_ext.toLowerCase()] || 'application/octet-stream');
    res.sendFile(filePath);
  });

  // ---- BOT VOICE AI (Gemini) ----
  router.post('/api/bot/ai/voice', requireBotKey, voiceUpload.single('file'), (req: Request, res: Response) => {
    try {
      const db = getDb();
      const flagRow = db.prepare("SELECT value FROM app_flags WHERE key = 'ai_config'").get() as
        | { value: string }
        | undefined;
      let botVoiceEnabled = false;
      if (flagRow) {
        try {
          botVoiceEnabled = Boolean(JSON.parse(flagRow.value).bot_voice);
        } catch {
          botVoiceEnabled = false;
        }
      }
      if (!botVoiceEnabled) throw new HttpError(403, 'ИИ в боте выключен администратором');

      const vkId = Number(req.body?.vk_id);
      requirePersonByVk(db, vkId);
      const file = req.file;
      if (!file || !file.buffer || file.buffer.length === 0) throw new HttpError(400, 'Пустая запись');

      const taskId = String(req.body?.task_id || '');
      const pointId = String(req.body?.point_id || '');
      const visitType = String(req.body?.visit_type || '');
      const jobId = crypto.randomBytes(12).toString('hex');
      const reqMeta = { task_id: taskId, point_id: pointId, visit_type: visitType, size: file.buffer.length };
      db.prepare(
        "INSERT INTO ai_jobs (id, kind, owner, status, created_at, request) VALUES (?, 'voice', ?, 'pending', ?, ?)",
      ).run(jobId, `bot:${vkId}`, nowIso(), JSON.stringify(reqMeta));

      const mimeType = file.mimetype || (file.originalname?.endsWith('.mp3') ? 'audio/mpeg' : 'audio/ogg');
      void runVoiceAiJob(jobId, file.buffer, mimeType, visitType, pointId);
      res.json({ job_id: jobId });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/ai/jobs/:jobId', requireBotKey, (req: Request, res: Response) => {
    const jobId = String(req.params.jobId);
    const vkId = Number(req.query.vk_id);
    const row = getDb().prepare('SELECT * FROM ai_jobs WHERE id = ? AND owner = ?').get(jobId, `bot:${vkId}`) as
      | Record<string, unknown>
      | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Задача не найдена' });
      return;
    }
    let result: unknown = null;
    if (typeof row.result === 'string' && row.result) {
      try {
        result = JSON.parse(row.result);
      } catch {
        result = row.result;
      }
    }
    res.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      result,
      error: row.error,
    });
  });

  // ---- BOT EQUIPMENT ROUTES ----
  router.get(/^\/api\/bot\/equipment\/point\/(.+)$/, requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const rawPointId = decodeURIComponent(req.params[0]);
      const point = requirePointOr404(db, rawPointId);
      const pid = String(point.id);
      const items = (
        db.prepare(`${EQ_SELECT} WHERE e.place = 'point' AND e.point_id = ? ORDER BY c.name, m.name, e.serial_number`).all(pid) as Array<
          Record<string, unknown>
        >
      ).map(mapEqRow);
      if (!items.some((i) => isSim(i))) {
        for (const gPid of groupIdsConn(db, pid)) {
          if (gPid === pid) continue;
          const sims = (
            db.prepare(`${EQ_SELECT} WHERE e.place = 'point' AND e.point_id = ? AND c.kind = 'sim'`).all(gPid) as Array<
              Record<string, unknown>
            >
          ).map(mapEqRow);
          items.push(...sims);
        }
      }
      const groupMap = new Map<number, { category_id: number; category_name: string; items: ReturnType<typeof shortEq>[] }>();
      for (const it of items) {
        let g = groupMap.get(it.category_id);
        if (!g) {
          g = { category_id: it.category_id, category_name: it.category_name, items: [] };
          groupMap.set(it.category_id, g);
        }
        g.items.push(shortEq(it));
      }
      const groups = Array.from(groupMap.values()).sort((a, b) => a.category_name.localeCompare(b.category_name, 'ru'));
      const categories = db.prepare('SELECT id, name FROM equipment_categories ORDER BY name').all();
      res.json({ groups, categories });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/equipment/held', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const person = requirePersonByVk(db, Number(req.query.vk_id));
      const catId = req.query.category_id ? Number(req.query.category_id) : null;
      const rows = (
        catId
          ? db
              .prepare(
                `${EQ_SELECT} WHERE e.place = 'person' AND e.person_id = ? AND m.category_id = ? ORDER BY c.name, m.name, e.serial_number`,
              )
              .all(person.id, catId)
          : db
              .prepare(`${EQ_SELECT} WHERE e.place = 'person' AND e.person_id = ? ORDER BY c.name, m.name, e.serial_number`)
              .all(person.id)
      ) as Array<Record<string, unknown>>;
      res.json(rows.map((r) => shortEq(mapEqRow(r))));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/equipment/find', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id));
      const q = String(req.query.q || '').trim();
      if (!q) {
        res.json([]);
        return;
      }
      const exact = findEqBySerial(db, q);
      if (exact) {
        res.json([shortEq(exact)]);
        return;
      }
      const { items } = listEqItems(db, { search: q, limit: 10 });
      res.json(items.map(shortEq));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/equipment/by-suffix', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id));
      const key = suffixKey(String(req.query.suffix || ''));
      if (key.length < MIN_SUFFIX) {
        throw new HttpError(400, `Введите не меньше ${MIN_SUFFIX} последних цифр серийного номера`);
      }
      const catId = req.query.category_id ? Number(req.query.category_id) : null;
      const { items } = listEqItems(db, { category_id: catId, limit: 2000 });
      const lowerKey = key.toLowerCase();
      const matched = items
        .filter((i) => !isSim(i) && i.serial_number.toLowerCase().endsWith(lowerKey))
        .slice(0, 30)
        .map((i) => {
          const st = suffixState(i);
          return { ...shortEq(i), usable: st.usable, why: st.why };
        });
      res.json(matched);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/replace', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const out = runInTx(db, () => {
        const point = requirePointOr404(db, String(b.point_id || ''));
        const pid = String(point.id);
        const old = requireEqItem(db, Number(b.old_equipment_id));
        const newItem = requireEqItem(db, Number(b.new_equipment_id));
        if (old.place !== 'point' || old.point_id !== pid) {
          throw new HttpError(409, 'Снимаемое оборудование не установлено на данном комплексе');
        }
        if (old.id === newItem.id) throw new HttpError(400, 'Нельзя заменить оборудование на него же');
        const actual = resolveActualConn(
          db,
          old,
          b.actual_equipment_id ? Number(b.actual_equipment_id) : null,
          b.actual_serial,
          Boolean(b.create_missing),
          person.full_name,
        );
        if (actual && actual.id === newItem.id) throw new HttpError(400, 'Нельзя заменить оборудование на него же');
        const today = todayIso();
        attachConn(db, newItem, {
          point_id: pid,
          person,
          date: today,
          performed_by: person.full_name,
          comment: 'через бота',
          action: 'replace_in',
          extra: `Заменено взамен №${(actual || old).serial_number}`,
        });
        const { removed, note, marked } = applyActualConn(db, old, actual, pid, today, person.full_name);
        detachConn(db, removed, {
          point_id: pid,
          to_person: person,
          date: today,
          performed_by: person.full_name,
          comment: 'через бота',
          action: 'replace_out',
          extra: [`Заменено на №${newItem.serial_number}`, note].filter(Boolean).join('. '),
          reason: b.reason,
          sync_point: !isSim(removed),
        });
        return {
          removed: removed.serial_number,
          installed: newItem.serial_number,
          unknown: marked ? old.serial_number : '',
        };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/install', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const installed = runInTx(db, () => {
        const point = requirePointOr404(db, String(b.point_id || ''));
        const item = requireEqItem(db, Number(b.equipment_id));
        if (item.place === 'point') {
          if (item.point_id === String(point.id)) throw new HttpError(409, 'Это оборудование уже стоит на данном комплексе');
          throw new HttpError(409, `№${item.serial_number} уже стоит на комплексе «${item.point_id}» — используйте «Заменить»`);
        }
        attachConn(db, item, {
          point_id: String(point.id),
          person,
          date: todayIso(),
          performed_by: person.full_name,
          comment: 'через бота',
          action: 'attach',
        });
        return item.serial_number;
      });
      res.json({ installed });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/remove', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const out = runInTx(db, () => {
        const point = requirePointOr404(db, String(b.point_id || ''));
        const pid = String(point.id);
        const item = requireEqItem(db, Number(b.equipment_id));
        if (item.place !== 'point' || item.point_id !== pid) {
          throw new HttpError(409, 'Это оборудование не установлено на данном комплексе');
        }
        const today = todayIso();
        const actual = resolveActualConn(
          db,
          item,
          b.actual_equipment_id ? Number(b.actual_equipment_id) : null,
          b.actual_serial,
          Boolean(b.create_missing),
          person.full_name,
        );
        const { removed, note, marked } = applyActualConn(db, item, actual, pid, today, person.full_name);
        detachConn(db, removed, {
          point_id: pid,
          to_person: person,
          date: today,
          performed_by: person.full_name,
          comment: 'через бота',
          action: 'detach',
          extra: note,
          reason: b.reason,
        });
        return { removed: removed.serial_number, unknown: marked ? item.serial_number : '' };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/install-by-suffix', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const key = suffixKey(b.suffix);
      if (key.length < MIN_SUFFIX) {
        throw new HttpError(400, `Введите не меньше ${MIN_SUFFIX} последних цифр серийного номера`);
      }
      const out = runInTx(db, () => {
        const point = requirePointOr404(db, String(b.point_id || ''));
        const pid = String(point.id);
        const today = todayIso();
        const old = b.old_equipment_id ? requireEqItem(db, Number(b.old_equipment_id)) : null;
        if (old && (old.place !== 'point' || old.point_id !== pid)) {
          throw new HttpError(409, 'Снимаемое оборудование не установлено на данном комплексе');
        }

        let target: EqItemRow | null = null;
        if (b.new_equipment_id) {
          target = requireEqItem(db, Number(b.new_equipment_id));
        } else {
          const catId = b.category_id ? Number(b.category_id) : old?.category_id ?? null;
          const { items } = listEqItems(db, { category_id: catId, limit: 2000 });
          const lowerKey = key.toLowerCase();
          const usable = items.filter((i) => !isSim(i) && i.serial_number.toLowerCase().endsWith(lowerKey) && suffixState(i).usable);
          if (usable.length > 1) {
            throw new HttpError(409, `По символам …${key} найдено несколько единиц оборудования — уточните номер`);
          }
          if (usable.length === 1) target = usable[0];
        }

        if (target) {
          const st = suffixState(target);
          if (!st.usable) throw new HttpError(409, `№${target.serial_number} (${st.why}) — поставить на комплекс нельзя`);
          const heldByOther = target.place === 'person' && target.person_id !== person.id;
          const otherNote = heldByOther
            ? `По учёту числилось на другом монтёре (${target.person_name}) — фактически поставил ${person.full_name} (указав …${key})`
            : '';
          // Temporarily allow attach by resetting holder if taken from other fitter
          if (heldByOther) {
            db.prepare('UPDATE equipment SET person_id = ?, held_reason = ? WHERE id = ?').run(person.id, 'issued', target.id);
            target = requireEqItem(db, target.id);
          }
          attachConn(db, target, {
            point_id: pid,
            person,
            date: today,
            performed_by: person.full_name,
            comment: 'через бота',
            action: old ? 'replace_in' : 'attach',
            extra: [old ? `Заменено взамен №${old.serial_number}` : `Поставлено по последним символам …${key}`, otherNote]
              .filter(Boolean)
              .join('. '),
          });
          if (old) {
            detachConn(db, old, {
              point_id: pid,
              to_person: person,
              date: today,
              performed_by: person.full_name,
              comment: 'через бота',
              action: 'replace_out',
              extra: `Заменено на №${target.serial_number}`,
              reason: b.reason,
              sync_point: !isSim(old),
            });
          }
          return {
            mode: 'linked',
            installed: target.serial_number,
            removed: old?.serial_number || '',
            held_by_other: heldByOther,
          };
        }

        if (old) {
          detachConn(db, old, {
            point_id: pid,
            to_person: person,
            date: today,
            performed_by: person.full_name,
            comment: 'через бота',
            action: 'replace_out',
            extra: `Заменено на оборудование с номером …${key} (в учёте его пока нет)`,
            reason: b.reason,
          });
        }
        const catId = b.category_id ? Number(b.category_id) : old?.category_id ?? null;
        const catRow = catId
          ? (db.prepare('SELECT name FROM equipment_categories WHERE id = ?').get(catId) as { name: string } | undefined)
          : undefined;
        const pendInfo = db
          .prepare(
            'INSERT INTO equipment_pending (point_id, category_id, suffix, person_id, person_name, install_date, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
          )
          .run(pid, catId, key, person.id, person.full_name, today, 'через бота', nowIso());
        addEqHistory(db, 'note', {
          serial_number: `…${key}`,
          model_name: catRow?.name || null,
          person_id: person.id,
          person_name: person.full_name,
          point_id: pid,
          performed_by: person.full_name,
          comment: `Монтёр поставил на комплекс оборудование, указав последние символы номера …${key}; в учёте такого номера нет — оно привяжется к комплексу само, когда его добавят в систему`,
          event_date: today,
        });
        return {
          mode: 'pending',
          suffix: key,
          removed: old?.serial_number || '',
          pending_id: Number(pendInfo.lastInsertRowid),
        };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/sim/replace', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const key = simKey(String(b.serial_number || ''));
      if (!simKeyValid(key)) throw new HttpError(400, 'Укажите номер новой SIM-карты (минимум 7 цифр)');
      const removedWorking = b.removed_working === true ? true : b.removed_working === false ? false : null;

      const out = runInTx(db, () => {
        const point = requirePointOr404(db, String(b.point_id || ''));
        const pid = String(point.id);
        const day = todayIso();
        const installed = groupIdsConn(db, pid).flatMap((gPid) => {
          const rows = db
            .prepare(`${EQ_SELECT} WHERE e.place = 'point' AND e.point_id = ? AND c.kind = 'sim'`)
            .all(gPid) as Array<Record<string, unknown>>;
          return rows.map(mapEqRow);
        });
        let item = findEqBySerial(db, key);
        let created = false;
        if (item) {
          if (!isSim(item)) throw new HttpError(409, `№${key} уже есть в базе (${item.category_name}) — это не SIM-карта`);
          if (item.place === 'point') {
            throw new HttpError(409, `SIM №${key} числится на комплексе «${item.point_id}» — сначала снимите её там`);
          }
          if (item.place === 'person' && item.person_id !== person.id) {
            throw new HttpError(409, `SIM №${key} числится на другом монтёре — ${item.person_name}`);
          }
          if (item.place === 'stock' && !item.status_usable) {
            throw new HttpError(409, `№${item.serial_number} имеет состояние «${item.status || '—'}» — выдавать и ставить такое нельзя.`);
          }
        } else {
          item = newSimItemConn(db, key, {
            point_id: null,
            performed_by: person.full_name,
            comment: `Добавлена при замене SIM на комплексе «${pid}»: номера не было в базе`,
          });
          created = true;
        }
        const okStatus = removedWorking ? roleStatusId(db, 'ok') : null;
        const stateNote =
          removedWorking === true ? '; снятая SIM рабочая' : removedWorking === false ? '; снятая SIM нерабочая' : '';
        for (const old of installed) {
          detachConn(db, old, {
            point_id: old.point_id || pid,
            to_person: person,
            date: day,
            performed_by: person.full_name,
            comment: 'через бота',
            status_id: okStatus,
            action: 'replace_out',
            extra: `Заменена на SIM №${key}${stateNote}`,
            reason: b.reason,
            sync_point: false,
          });
        }
        putOnPointConn(db, item, {
          point_id: pid,
          date: day,
          installed_by: person.full_name,
          performed_by: person.full_name,
          action: installed.length ? 'replace_in' : 'attach',
          comment: [installed.length ? `Заменена взамен №${installed[0].serial_number}` : '', 'через бота']
            .filter(Boolean)
            .join('. '),
        });
        const ip = setPointSimConn(db, pid, key);
        return {
          removed: installed.map((o) => o.serial_number),
          installed: key,
          created,
          ip_known: Boolean(ip),
          ip_address: ip,
          removed_working: removedWorking,
        };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/sim/fix', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const out = runInTx(db, () =>
        simFixConn(db, String(b.point_id || ''), String(b.serial_number || ''), person.full_name, 'исправлено через бота'),
      );
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/equipment/demontage', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const person = requirePersonByVk(db, Number(b.vk_id));
      const whole = Boolean(b.whole);
      const wanted = Array.isArray(b.equipment_ids) ? b.equipment_ids.map(Number) : [];
      const out = runInTx(db, () => {
        const point = requirePointOr404(db, String(b.point_id || ''));
        const pid = String(point.id);
        const items = (
          db.prepare(`${EQ_SELECT} WHERE e.place = 'point' AND e.point_id = ?`).all(pid) as Array<Record<string, unknown>>
        ).map(mapEqRow);
        const wantedSet = new Set(wanted);
        const chosen = whole ? items : items.filter((it) => wantedSet.has(it.id));
        const day = todayIso();
        for (const it of chosen) {
          detachConn(db, it, {
            point_id: pid,
            to_person: person,
            date: day,
            performed_by: person.full_name,
            action: 'detach',
            extra: whole ? 'Демонтаж комплекса' : 'Демонтаж: снят отдельный элемент',
            reason: b.reason,
          });
        }
        return {
          removed: chosen.map((it) => ({
            id: it.id,
            serial_number: it.serial_number,
            category_name: it.category_name,
            model_name: it.model_name,
          })),
          left: items.length - chosen.length,
        };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  // ---- BOT WAREHOUSE ROUTES ----
  function warehouseAwaiting(db: DatabaseSync) {
    const rows = db
      .prepare(
        `SELECT e.person_id, p.full_name, e.held_reason
         FROM equipment e
         JOIN people p ON p.id = e.person_id
         WHERE e.place = 'person' AND e.person_id IS NOT NULL`,
      )
      .all() as Array<{ person_id: number; full_name: string; held_reason: string | null }>;
    const map = new Map<number, { person_id: number; full_name: string; removed: number; issued: number; kept: number }>();
    for (const r of rows) {
      let entry = map.get(r.person_id);
      if (!entry) {
        entry = { person_id: r.person_id, full_name: decryptField(r.full_name || ''), removed: 0, issued: 0, kept: 0 };
        map.set(r.person_id, entry);
      }
      if (r.held_reason === 'removed') entry.removed += 1;
      else if (r.held_reason === 'kept') entry.kept += 1;
      else entry.issued += 1;
    }
    return Array.from(map.values()).sort((a, b) => b.removed - a.removed || a.full_name.localeCompare(b.full_name, 'ru'));
  }

  router.get('/api/bot/warehouse/summary', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const stockRows = db
        .prepare(
          `SELECT c.name as category,
                  sum(case when coalesce(s.usable, 0) = 1 then 1 else 0 end) as usable,
                  sum(case when coalesce(s.usable, 0) = 0 then 1 else 0 end) as unusable
           FROM equipment e
           JOIN equipment_models m ON m.id = e.model_id
           JOIN equipment_categories c ON c.id = m.category_id
           LEFT JOIN equipment_statuses s ON s.id = e.status_id
           WHERE e.place = 'stock'
           GROUP BY c.id, c.name
           ORDER BY c.name`,
        )
        .all() as Array<{ category: string; usable: number; unusable: number }>;
      const unk = db.prepare("SELECT count(*) as c FROM equipment WHERE place = 'unknown'").get() as { c: number };
      res.json({ stock: stockRows, awaiting: warehouseAwaiting(db), unknown: unk.c || 0 });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/awaiting', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      res.json(warehouseAwaiting(db));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/person/:personId/items', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const rows = db
        .prepare(`${EQ_SELECT} WHERE e.place = 'person' AND e.person_id = ? ORDER BY c.name, m.name, e.serial_number`)
        .all(Number(req.params.personId)) as Array<Record<string, unknown>>;
      res.json(rows.map((r) => shortEq(mapEqRow(r))));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/fitters', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const q = String(req.query.q || '').trim().toLowerCase();
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const rows = db
        .prepare("SELECT id, full_name FROM people WHERE active = 1 AND role_type = 'fitter' ORDER BY id")
        .all() as Array<{ id: number; full_name: string }>;
      const terms = q.split(/\s+/).filter(Boolean);
      const out = rows
        .map((r) => ({ id: r.id, full_name: decryptField(r.full_name || '') }))
        .filter((p) => !terms.length || terms.every((t) => p.full_name.toLowerCase().includes(t)))
        .sort((a, b) => a.full_name.localeCompare(b.full_name, 'ru'))
        .slice(0, limit);
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/categories', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const rows = db
        .prepare(
          `SELECT c.id, c.name, count(*) as count
           FROM equipment e
           JOIN equipment_models m ON m.id = e.model_id
           JOIN equipment_categories c ON c.id = m.category_id
           LEFT JOIN equipment_statuses s ON s.id = e.status_id
           WHERE e.place = 'stock' AND coalesce(s.usable, 0) = 1
           GROUP BY c.id, c.name
           ORDER BY c.name`,
        )
        .all();
      res.json(rows);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/stock', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
      const q = String(req.query.q || '');
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 30));
      const offset = Math.max(0, Number(req.query.offset) || 0);
      const { items, total } = listEqItems(db, { place: 'stock', usable: true, category_id: categoryId, search: q, limit, offset });
      res.json({ items: items.map(shortEq), total });
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/find', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const q = String(req.query.q || '').trim();
      if (!q) {
        res.json([]);
        return;
      }
      const exact = findEqBySerial(db, q);
      if (exact) {
        res.json([shortEq(exact)]);
        return;
      }
      const { items } = listEqItems(db, { search: q, limit: 10 });
      res.json(items.map(shortEq));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.get('/api/bot/warehouse/statuses', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      requirePersonByVk(db, Number(req.query.vk_id), { warehouse: true });
      const rows = db.prepare('SELECT id, name, usable, role FROM equipment_statuses ORDER BY sort_order, id').all() as Array<
        Record<string, unknown>
      >;
      res.json(rows.map((s) => ({ ...s, usable: Boolean(s.usable) })));
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/warehouse/accept', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const actor = requirePersonByVk(db, Number(b.vk_id), { warehouse: true });
      const ids: number[] = Array.isArray(b.equipment_ids) ? Array.from(new Set(b.equipment_ids.map(Number))) : [];
      if (!ids.length) throw new HttpError(400, 'Не выбрано ни одной единицы оборудования');
      const personFilter = b.person_id ? Number(b.person_id) : null;
      const statusId = b.status_id ? Number(b.status_id) : null;

      const out = runInTx(db, () => {
        const day = todayIso();
        const accepted: Array<{ id: number; serial_number: string; removed: boolean }> = [];
        const skipped: Array<{ id: number; serial_number?: string; reason: string }> = [];
        for (const eid of ids) {
          const item = getEqItem(db, eid);
          if (!item) {
            skipped.push({ id: eid, reason: 'не найдено' });
            continue;
          }
          if (item.place !== 'person' || (personFilter && item.person_id !== personFilter)) {
            skipped.push({ id: eid, serial_number: item.serial_number, reason: `не числится на этом монтёре — ${whereIs(item)}` });
            continue;
          }
          const removed = item.held_reason === 'removed' || item.held_reason === 'kept';
          db.prepare(
            `UPDATE equipment SET place = 'stock', person_id = NULL, held_reason = NULL, issued_date = NULL,
               accepted_date = ?, accepted_by = ?, status_id = coalesce(?, status_id), updated_at = ? WHERE id = ?`,
          ).run(day, actor.full_name, statusId, nowIso(), eid);
          addEqHistory(db, removed ? 'accept' : 'return', {
            item,
            person_id: item.person_id,
            person_name: item.person_name,
            point_id: removed ? item.removed_point_id : null,
            performed_by: actor.full_name,
            comment: b.comment ? String(b.comment) : null,
            event_date: day,
          });
          accepted.push({ id: eid, serial_number: item.serial_number, removed });
        }
        return { accepted, skipped };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/warehouse/accept-substitute', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const actor = requirePersonByVk(db, Number(b.vk_id), { warehouse: true });
      const expectedId = Number(b.expected_id);
      const personFilter = b.person_id ? Number(b.person_id) : null;

      const out = runInTx(db, () => {
        const expected = requireEqItem(db, expectedId);
        if (expected.place !== 'person' || (personFilter && expected.person_id !== personFilter)) {
          throw new HttpError(409, `№${expected.serial_number} не числится на этом монтёре — ${whereIs(expected)}`);
        }
        const day = todayIso();
        let actual: EqItemRow | null = null;
        if (b.actual_equipment_id) {
          actual = requireEqItem(db, Number(b.actual_equipment_id));
        } else {
          const clean = String(b.actual_serial || '').trim();
          if (!clean) throw new HttpError(400, 'Укажите номер сданного оборудования');
          actual = findEqBySerial(db, clean);
          if (!actual) {
            if (!b.create_missing) throw new HttpError(404, `№${clean} не найдено в базе`);
            const okId = roleStatusId(db, 'ok');
            const now = nowIso();
            const info = db
              .prepare(
                "INSERT INTO equipment (model_id, serial_number, place, status_id, received_date, notes, created_at, updated_at) VALUES (?, ?, 'stock', ?, ?, 'Заведено при приёмке другого номера', ?, ?)",
              )
              .run(expected.model_id, clean, okId, day, now, now);
            actual = requireEqItem(db, Number(info.lastInsertRowid));
          }
        }
        if (actual.id === expected.id) throw new HttpError(400, 'Указан тот же самый номер');
        const removed = expected.held_reason === 'removed' || expected.held_reason === 'kept';
        const prev = whereIs(actual);
        if (removed) {
          const defectId = roleStatusId(db, 'defect');
          db.prepare(
            `UPDATE equipment SET place = 'stock', person_id = NULL, held_reason = NULL, point_id = NULL,
               issued_date = NULL, installed_date = NULL, installed_by = NULL,
               status_id = coalesce(?, status_id), removed_date = ?, removed_by = ?, removed_point_id = ?,
               accepted_date = ?, accepted_by = ?, updated_at = ? WHERE id = ?`,
          ).run(
            defectId,
            expected.removed_date || day,
            expected.person_name,
            expected.removed_point_id,
            day,
            actor.full_name,
            nowIso(),
            actual.id,
          );
        } else {
          db.prepare(
            `UPDATE equipment SET place = 'stock', person_id = NULL, held_reason = NULL, point_id = NULL,
               issued_date = NULL, installed_date = NULL, installed_by = NULL,
               accepted_date = ?, accepted_by = ?, updated_at = ? WHERE id = ?`,
          ).run(day, actor.full_name, nowIso(), actual.id);
        }
        const src = removed ? `Снято с комплекса «${expected.removed_point_id || '—'}»` : 'Возврат';
        addEqHistory(db, removed ? 'accept' : 'return', {
          item: actual,
          person_id: expected.person_id,
          person_name: expected.person_name,
          point_id: removed ? expected.removed_point_id : null,
          performed_by: actor.full_name,
          event_date: day,
          comment: [
            `${src}. Принято вместо №${expected.serial_number} (по системе числилось на монтёре); раньше числилось: ${prev}`,
            b.comment ? String(b.comment) : '',
          ]
            .filter(Boolean)
            .join('. '),
        });
        markUnknownConn(db, expected, {
          point_id: removed ? expected.removed_point_id : null,
          date: day,
          performed_by: actor.full_name,
          comment: `Монтёр ${expected.person_name || '—'} сдал другой номер (№${actual.serial_number}) — где это оборудование сейчас, неизвестно`,
        });
        return { accepted: actual.serial_number, unknown: expected.serial_number, removed };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/warehouse/found', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const actor = requirePersonByVk(db, Number(b.vk_id), { warehouse: true });
      const out = runInTx(db, () => {
        const item = requireEqItem(db, Number(b.equipment_id));
        if (item.place !== 'unknown') {
          throw new HttpError(409, `№${item.serial_number} не числится как потерянное — оно ${whereIs(item)}`);
        }
        const day = todayIso();
        db.prepare(
          "UPDATE equipment SET place = 'stock', person_id = NULL, held_reason = NULL, point_id = NULL, accepted_date = ?, accepted_by = ?, updated_at = ? WHERE id = ?",
        ).run(day, actor.full_name, nowIso(), item.id);
        addEqHistory(db, 'found', {
          item,
          performed_by: actor.full_name,
          comment: b.comment ? String(b.comment) : null,
          event_date: day,
        });
        return { id: item.id, serial_number: item.serial_number };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/warehouse/issue', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const actor = requirePersonByVk(db, Number(b.vk_id), { warehouse: true });
      const personId = Number(b.person_id);
      const ids: number[] = Array.isArray(b.equipment_ids) ? b.equipment_ids.map(Number) : [];
      const serials: string[] = Array.isArray(b.serials) ? b.serials.map(String) : [];
      const notFound: string[] = [];
      for (const s of serials) {
        const found = findEqBySerial(db, s);
        if (found) ids.push(found.id);
        else if (s.trim()) notFound.push(s.trim());
      }
      if (!ids.length) {
        throw new HttpError(400, 'Не найдено ни одного оборудования' + (notFound.length ? `: ${notFound.join(', ')}` : ''));
      }
      const out = runInTx(db, () => {
        const pRow = db.prepare('SELECT id, full_name FROM people WHERE id = ?').get(personId) as
          | { id: number; full_name: string }
          | undefined;
        if (!pRow) throw new HttpError(404, 'Человек не найден');
        const pName = decryptField(pRow.full_name || '');
        const day = todayIso();
        const issuedSerials: string[] = [];
        const skipped: Array<{ id: number; serial_number?: string; reason: string }> = [];
        for (const eid of Array.from(new Set(ids))) {
          const item = getEqItem(db, eid);
          if (!item) {
            skipped.push({ id: eid, reason: 'не найдено' });
            continue;
          }
          if (item.place !== 'stock') {
            skipped.push({ id: eid, serial_number: item.serial_number, reason: `сейчас ${whereIs(item)}` });
            continue;
          }
          if (!item.status_usable) {
            skipped.push({
              id: eid,
              serial_number: item.serial_number,
              reason: `состояние «${item.status || '—'}» — выдавать нельзя`,
            });
            continue;
          }
          db.prepare(
            "UPDATE equipment SET place = 'person', person_id = ?, held_reason = 'issued', issued_date = ?, updated_at = ? WHERE id = ?",
          ).run(personId, day, nowIso(), eid);
          addEqHistory(db, 'issue', {
            item,
            person_id: personId,
            person_name: pName,
            performed_by: actor.full_name,
            comment: 'через бота',
            event_date: day,
          });
          issuedSerials.push(item.serial_number);
        }
        return { issued: issuedSerials, skipped, not_found: notFound };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  router.post('/api/bot/warehouse/set-status', requireBotKey, (req: Request, res: Response) => {
    try {
      const db = getDb();
      const b = req.body || {};
      const actor = requirePersonByVk(db, Number(b.vk_id), { warehouse: true });
      const eid = Number(b.equipment_id);
      const statusId = Number(b.status_id);
      const out = runInTx(db, () => {
        const item = requireEqItem(db, eid);
        const stRow = db.prepare('SELECT id, name FROM equipment_statuses WHERE id = ?').get(statusId) as
          | { id: number; name: string }
          | undefined;
        if (!stRow) throw new HttpError(404, 'Состояние не найдено');
        if (item.place !== 'stock') {
          const hint =
            item.place === 'unknown'
              ? 'Сначала отметьте, что оно нашлось.'
              : 'Сначала снимите его с комплекса / примите от монтёра.';
          throw new HttpError(409, `Состояние меняется только у оборудования на складе — №${item.serial_number} сейчас ${whereIs(item)}. ${hint}`);
        }
        if (item.status_id === statusId) {
          throw new HttpError(400, `№${item.serial_number} уже имеет состояние «${stRow.name}»`);
        }
        db.prepare('UPDATE equipment SET status_id = ?, updated_at = ? WHERE id = ?').run(statusId, nowIso(), eid);
        addEqHistory(db, 'status', {
          item,
          performed_by: actor.full_name,
          comment: `${item.status || '—'} → ${stRow.name}` + (b.comment ? `. ${String(b.comment).trim()}` : ''),
        });
        return { id: eid, serial_number: item.serial_number, status: stRow.name };
      });
      res.json(out);
    } catch (err) {
      sendErr(res, err);
    }
  });

  // Explicit error fallback for /api/bot/* routes
  router.use('/api/bot', (_req: Request, _res: Response, next) => next());
  router.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.path.startsWith('/api/bot/')) {
      sendErr(res, err);
      return;
    }
    next(err);
  });

  return router;
}
