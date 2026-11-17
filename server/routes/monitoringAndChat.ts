import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { SQLInputValue } from 'node:sqlite';
import type { NextFunction, Request, Response } from 'express';
import { Router } from 'express';
import type { Archiver, ArchiverOptions } from 'archiver';
import ExcelJS from 'exceljs';
import multer from 'multer';

const require = createRequire(import.meta.url);
const archiver = require('archiver') as (format: 'zip' | 'tar' | 'json', options?: ArchiverOptions) => Archiver;
import { requirePasswordOk, requirePerm, type AuthedRequest } from '../auth.ts';
import {
  ACCOUNT_CHAT_FILES_DIR,
  CHAT_FILES_DIR,
  DATA_DIR,
  PHOTOS_DIR,
  settings,
} from '../config.ts';
import { decryptField } from '../crypto.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { hasPerm, networkOk, secretsOk } from '../permissions.ts';
import {
  PhotoStorageError,
  deleteVisitPhotoFiles,
  flushPhotoSpool,
  getPhotoStorageStatus,
  initPhotoStorageMarker,
  readVisitPhotoBuffer,
  savePhotoStorageConfig,
  scanPhotoStorage,
  startPhotoIndex,
  startPhotoMigration,
  storeVisitPhoto,
  testPhotoStorageConnection,
} from '../services/photoStorage.ts';

const photoUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 16 * 1024 * 1024 } });
const chatUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 10 } });

function isIsoDate(v: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().startsWith(v);
}

function fmtRuDate(iso: string): string {
  if (!/^\d{4}-\d{2}-\d{2}/.test(iso)) return iso;
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}-${m}-${y}`;
}

function localDayBoundsUtc(dateFrom: string, dateTo: string, tzOffsetMinutes: number): [string, string] {
  const start = new Date(`${dateFrom}T00:00:00.000Z`);
  start.setUTCMinutes(start.getUTCMinutes() + tzOffsetMinutes);
  const end = new Date(`${dateTo}T00:00:00.000Z`);
  end.setUTCDate(end.getUTCDate() + 1);
  end.setUTCMinutes(end.getUTCMinutes() + tzOffsetMinutes);
  return [start.toISOString().slice(0, 19), end.toISOString().slice(0, 19)];
}

function sniffImage(buf: Buffer): string | null {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return 'png';
  }
  if (buf.length >= 6) {
    const hdr = buf.subarray(0, 6).toString('ascii');
    if (hdr === 'GIF87a' || hdr === 'GIF89a') return 'gif';
  }
  if (
    buf.length >= 12 &&
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp';
  }
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'bmp';
  return null;
}

function isHeic(buf: Buffer): boolean {
  if (buf.length < 12) return false;
  const box = buf.subarray(4, 8).toString('ascii');
  const brand = buf.subarray(8, 12).toString('ascii');
  return box === 'ftyp' && ['heic', 'heix', 'hevc', 'mif1', 'msf1', 'heim', 'heis'].includes(brand);
}

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

function safeFolderSegment(name: string): string {
  return String(name || 'unknown').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'unknown';
}

function stripPointSecrets<T extends Record<string, unknown>>(rows: T[], perms: string[]): T[] {
  const canSec = secretsOk(perms);
  const canNet = networkOk(perms);
  return rows.map((row) => {
    const out = { ...row } as Record<string, unknown>;
    if ('login' in out) {
      out.login = canSec ? decryptField(String(out.login || '')) : '';
    }
    if ('password' in out) {
      out.password = canSec ? decryptField(String(out.password || '')) : '';
    }
    if ('ip_address' in out && !canNet) {
      out.ip_address = '';
    }
    if ('category_is_legacy' in out) {
      out.category_is_legacy = Boolean(out.category_is_legacy);
    }
    return out as T;
  });
}

function simDigits(val: string | null | undefined): string {
  return String(val || '').replace(/\D+/g, '');
}

function simKey(val: string | null | undefined): string {
  const d = simDigits(val);
  if (d.length >= 7) return d.slice(-7);
  return d;
}

function simKeyValid(key: string): boolean {
  return /^\d{7}$/.test(key);
}

function cleanWho(val: string | null | undefined): string {
  const s = String(val || '').trim();
  if (!s) return '';
  const dec = decryptField(s);
  return dec.toLowerCase().startsWith('vk:') ? dec.slice(3).trim() : dec;
}

function safeExcelCell(v: unknown): string | number | null {
  if (v == null) return '';
  if (typeof v === 'number') return v;
  const s = String(v);
  return /^[=+\-@]/.test(s) ? `'${s}` : s;
}

const MONITORING_EXPORT_FIELDS: Array<[string, string]> = [
  ['date', 'Дата'],
  ['crew_label', 'Бригада'],
  ['point_id', 'Комплекс'],
  ['point_address', 'Адрес'],
  ['power_source', 'Тип питания'],
  ['work', 'Что нужно сделать (план)'],
  ['visit_type', 'Тип выезда'],
  ['comment', 'Что сделано (комментарий)'],
  ['result_status', 'Статус (работает/не работает)'],
  ['outcome', 'Статус выезда'],
  ['equipment_removed', 'Снято оборудование'],
  ['equipment_installed', 'Установлено оборудование'],
  ['sim_removed', 'SIM снята'],
  ['sim_removed_state', 'Состояние снятой SIM'],
  ['sim_installed', 'SIM установлена'],
  ['fault', 'Что неисправно'],
  ['needs', 'Что нужно для исправления'],
  ['created_by', 'Исполнитель'],
];

const SIM_STATE_LABELS: Record<string, string> = {
  working: 'Рабочая',
  defective: 'Нерабочая',
};

function getPointSummaries(dateFrom: string, dateTo: string, byReportDate: boolean, tzOffsetMinutes: number) {
  const db = getDb();
  let sql = `
    SELECT t.team as crew_id, c.name as crew_name, t.date, t.point as point_id, p.address as point_address, t.work,
           r.visit_type, r.result_status, r.outcome, r.comment,
           coalesce(pe.full_name, r.created_by) as raw_by, r.task_id, r.created_at as reported_at,
           r.fault, r.needs, p.power_source, r.equipment_removed, r.equipment_installed,
           r.sim_removed, r.sim_installed, r.sim_removed_state, r.source, t.type as task_type, r.author_person_id
    FROM task_visit_reports r
    LEFT JOIN people pe ON pe.id = r.author_person_id
    JOIN tasks t ON t.id = r.task_id
    LEFT JOIN crews c ON c.id = t.team
    LEFT JOIN points p ON p.id = t.point
  `;
  let rows: Array<Record<string, unknown>>;
  if (byReportDate) {
    const [low, high] = localDayBoundsUtc(dateFrom, dateTo, tzOffsetMinutes);
    sql += ' WHERE r.created_at >= ? AND r.created_at < ? ORDER BY r.created_at, r.id';
    rows = db.prepare(sql).all(low, high) as Array<Record<string, unknown>>;
  } else {
    sql += ' WHERE t.date >= ? AND t.date <= ? ORDER BY t.team, t.date, p.address';
    rows = db.prepare(sql).all(dateFrom, dateTo) as Array<Record<string, unknown>>;
  }
  return rows.map((r) => {
    const crewId = r.crew_id != null ? Number(r.crew_id) : null;
    const crewName = String(r.crew_name || '');
    const crewLabel = crewName || (crewId ? `Бригада без названия (№${crewId})` : 'Без бригады');
    return {
      crew_id: crewId,
      date: r.date || '',
      point_id: r.point_id || '',
      point_address: r.point_address || '',
      work: r.work || '',
      visit_type: r.visit_type || '',
      result_status: r.result_status || '',
      outcome: r.outcome || '',
      comment: r.comment || '',
      created_by: cleanWho(String(r.raw_by || '')),
      task_id: r.task_id,
      reported_at: r.reported_at || '',
      fault: r.fault || '',
      needs: r.needs || '',
      power_source: r.power_source || '',
      equipment_removed: r.equipment_removed || '',
      equipment_installed: r.equipment_installed || '',
      sim_removed: r.sim_removed || '',
      sim_installed: r.sim_installed || '',
      sim_removed_state: r.sim_removed_state || '',
      source: r.source || '',
      task_type: r.task_type || '',
      author_person_id: r.author_person_id ?? null,
      crew_label: crewLabel,
    };
  });
}

// ---------- Data issues helpers ----------
const GONE_STATUSES = new Set(['на складе', 'демонтирован']);

function getSimLinkGroupsConn() {
  const db = getDb();
  const rows = db
    .prepare('SELECT group_id, point_id FROM point_sim_links ORDER BY group_id, point_id')
    .all() as Array<{ group_id: number; point_id: string }>;
  const groups = new Map<number, string[]>();
  const linkOf = new Map<string, number>();
  for (const r of rows) {
    if (!groups.has(r.group_id)) groups.set(r.group_id, []);
    groups.get(r.group_id)!.push(r.point_id);
    linkOf.set(r.point_id, r.group_id);
  }
  return { groups, linkOf };
}

function buildSimHints(points: Array<Record<string, unknown>>) {
  const hints: Array<{ tone: string; text: string }> = [];
  const flags = { mixed_types: false, diff_ip: false, same_ip: false, diff_full: false, gone: false };
  const cats = new Set(points.map((p) => String(p.category_name || '')).filter(Boolean));
  if (cats.size > 1) {
    flags.mixed_types = true;
    hints.push({ tone: 'warn', text: `Разные типы комплексов (${[...cats].sort().join(', ')}) — возможно, ошибка записи SIM.` });
  }
  const withIp = points.filter((p) => String(p.ip_address || '').trim());
  const ips = new Set(withIp.map((p) => String(p.ip_address)));
  if (ips.size > 1) {
    flags.diff_ip = true;
    hints.push({ tone: 'warn', text: 'Разные IP-адреса — возможно, одна из карточек содержит старый номер SIM.' });
  } else if (ips.size === 1 && withIp.length > 1) {
    const ports = new Set(withIp.map((p) => String(p.port || '')));
    if (ports.size > 1) {
      flags.same_ip = true;
      hints.push({ tone: 'info', text: 'Один IP, но разные порты — комплексы могут работать в одной сети на одной SIM.' });
    }
  }
  const fulls = new Set(
    points.map((p) => simDigits(String(p.sim_raw || '')).slice(-10)).filter((d) => d.length >= 10),
  );
  if (fulls.size > 1) {
    flags.diff_full = true;
    hints.push({ tone: 'warn', text: 'Полные номера записаны по-разному — совпали только последние 7 цифр.' });
  }
  const gone = points.filter((p) => GONE_STATUSES.has(String(p.status || '').trim().toLowerCase()));
  if (gone.length) {
    flags.gone = true;
    hints.push({
      tone: 'info',
      text: `Не на месте (демонтирован / на складе): ${gone.slice(0, 5).map((p) => p.id).join(', ')}.`,
    });
  }
  return { hints, flags };
}

function getDayGroups(dateFrom: string, dateTo: string) {
  const db = getDb();
  let where = "t.type != 'Вспомогательная точка' AND trim(t.point) != ''";
  const params: string[] = [];
  if (dateFrom) {
    where += ' AND t.date >= ?';
    params.push(dateFrom);
  }
  if (dateTo) {
    where += ' AND t.date <= ?';
    params.push(dateTo);
  }
  const rows = db
    .prepare(
      `SELECT t.id, t.date, t.team, t.point, t.type, t.work, t.hours, coalesce(c.name, '') as crew_name,
              CASE WHEN r.task_id IS NOT NULL THEN 1 ELSE 0 END as done
       FROM tasks t
       LEFT JOIN crews c ON c.id = t.team
       LEFT JOIN task_visit_reports r ON r.task_id = t.id
       WHERE ${where}
       ORDER BY t.date, t.rowid`,
    )
    .all(...params) as Array<Record<string, unknown>>;

  const buckets = new Map<string, { day: string; npoint: string; tasks: Array<Record<string, unknown>> }>();
  for (const r of rows) {
    const day = String(r.date || '');
    const point = String(r.point || '');
    const npoint = point.trim().toLowerCase();
    const k = `${day}|${npoint}`;
    if (!buckets.has(k)) buckets.set(k, { day, npoint, tasks: [] });
    buckets.get(k)!.tasks.push({
      task_id: String(r.id),
      crew_id: Number(r.team),
      crew_name: String(r.crew_name || ''),
      type: String(r.type || ''),
      work: String(r.work || ''),
      hours: Number(r.hours || 0),
      done: Boolean(r.done),
      point,
    });
  }

  const dups = [...buckets.values()].filter((b) => b.tasks.length > 1);
  if (!dups.length) return [];

  const crewIds = [...new Set(dups.flatMap((d) => d.tasks.map((t) => Number(t.crew_id))))];
  const membersMap = new Map<number, string[]>();
  if (crewIds.length) {
    const marks = crewIds.map(() => '?').join(',');
    const mRows = db
      .prepare(
        `SELECT cm.crew_id, p.full_name FROM crew_members cm JOIN people p ON p.id = cm.person_id WHERE cm.crew_id IN (${marks})`,
      )
      .all(...crewIds) as Array<{ crew_id: number; full_name: string }>;
    for (const mr of mRows) {
      if (!membersMap.has(mr.crew_id)) membersMap.set(mr.crew_id, []);
      membersMap.get(mr.crew_id)!.push(decryptField(mr.full_name));
    }
    for (const [cid, list] of membersMap) list.sort((a, b) => a.localeCompare(b, 'ru'));
  }

  const ptsMap = new Map<string, { id: string; address: string; status: string }>();
  for (const pr of db.prepare('SELECT id, address, status FROM points').all() as Array<{
    id: string;
    address: string;
    status: string;
  }>) {
    ptsMap.set(pr.id.trim().toLowerCase(), { id: pr.id, address: pr.address || '', status: pr.status || '' });
  }

  return dups.map(({ day, npoint, tasks }) => {
    const info = ptsMap.get(npoint) || { id: String(tasks[0].point), address: '', status: '' };
    const perCrew = new Map<number, number>();
    for (const t of tasks) {
      const cid = Number(t.crew_id);
      perCrew.set(cid, (perCrew.get(cid) || 0) + 1);
      t.members = membersMap.get(cid) || [];
    }
    return {
      kind: 'day',
      key: `${day}|${npoint}`,
      date: day,
      point_id: info.id,
      address: info.address,
      status: info.status,
      in_directory: ptsMap.has(npoint),
      same_crew: [...perCrew.values()].some((n) => n > 1),
      cross_crew: perCrew.size > 1,
      tasks,
      signature: tasks.map((t) => String(t.task_id)).sort().join(','),
      ack: null as Record<string, unknown> | null,
    };
  });
}

function getSimAndLinkGroups(perms: string[]) {
  const db = getDb();
  const { groups, linkOf } = getSimLinkGroupsConn();
  const rows = db
    .prepare(
      `SELECT p.id, p.address, p.status, p.sim_number, p.ip_address, p.port, p.login, p.password,
              coalesce(pc.name, '') as category_name, coalesce(pc.color, '') as category_color,
              coalesce(pc.is_legacy, 0) as category_is_legacy, p.lat, p.lon
       FROM points p LEFT JOIN point_categories pc ON pc.id = p.category_id
       ORDER BY p.id`,
    )
    .all() as Array<Record<string, unknown>>;

  const canSec = secretsOk(perms);
  const canNet = networkOk(perms);

  const mapPoint = (r: Record<string, unknown>) => ({
    id: String(r.id),
    address: String(r.address || ''),
    status: String(r.status || ''),
    sim_raw: String(r.sim_number || ''),
    lat: String(r.lat || ''),
    lon: String(r.lon || ''),
    ip_address: canNet ? String(r.ip_address || '').trim() : '',
    port: String(r.port || '').trim(),
    category_name: String(r.category_name || ''),
    category_color: String(r.category_color || ''),
    category_is_legacy: Boolean(r.category_is_legacy),
    login: canSec ? decryptField(String(r.login || '')) : '',
    password: canSec ? decryptField(String(r.password || '')) : '',
    link_group: linkOf.get(String(r.id)) ?? null,
  });

  const infoById = new Map<string, ReturnType<typeof mapPoint>>();
  const simBuckets = new Map<string, ReturnType<typeof mapPoint>[]>();
  for (const r of rows) {
    const pt = mapPoint(r);
    infoById.set(pt.id, pt);
    if (pt.sim_raw.trim()) {
      const k = simKey(pt.sim_raw);
      if (simKeyValid(k)) {
        if (!simBuckets.has(k)) simBuckets.set(k, []);
        simBuckets.get(k)!.push(pt);
      }
    }
  }

  const installedSim = new Map<string, string>();
  const simEqRows = db
    .prepare(
      `SELECT e.serial_number, e.point_id
       FROM equipment e
       JOIN equipment_models m ON m.id = e.model_id
       JOIN equipment_categories c ON c.id = m.category_id
       WHERE c.kind = 'sim' AND e.place = 'point'`,
    )
    .all() as Array<{ serial_number: string; point_id: string }>;
  for (const er of simEqRows) {
    if (er.serial_number && er.point_id) installedSim.set(er.serial_number, er.point_id);
  }

  const simGroups: Array<Record<string, unknown>> = [];
  for (const [k, pts] of [...simBuckets.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (pts.length < 2) continue;
    const linkIds = new Set(pts.map((p) => p.link_group));
    const fullyLinked = linkIds.size === 1 && !linkIds.has(null);
    const { hints, flags } = buildSimHints(pts);
    simGroups.push({
      kind: 'sim',
      key: k,
      sim: k,
      points: pts,
      installed_point: installedSim.get(k) || '',
      hints,
      flags,
      fully_linked: fullyLinked,
      signature: pts.map((p) => p.id).sort().join(','),
      ack: null as Record<string, unknown> | null,
    });
  }

  const linkGroups: Array<Record<string, unknown>> = [];
  for (const [gid, ids] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const pts = ids.map((id) => infoById.get(id)).filter((x): x is ReturnType<typeof mapPoint> => Boolean(x));
    if (pts.length < 2) continue;
    const keys = [...new Set(pts.map((p) => simKey(p.sim_raw)))].sort();
    const { hints, flags } = buildSimHints(pts);
    linkGroups.push({
      kind: 'link',
      key: String(gid),
      group_id: gid,
      sim: keys.length === 1 ? keys[0] : '',
      drift: keys.length > 1,
      points: pts,
      installed_point: '',
      hints,
      flags,
      ack: null,
      signature: pts.map((p) => p.id).sort().join(','),
    });
  }

  return { simGroups, linkGroups };
}

function applyAcks(groups: Array<Record<string, unknown>>) {
  const db = getDb();
  const rows = db.prepare('SELECT kind, issue_key, signature, acked_by, acked_at FROM data_issue_ack').all() as Array<{
    kind: string;
    issue_key: string;
    signature: string;
    acked_by: string;
    acked_at: string;
  }>;
  const ackMap = new Map<string, { signature: string; acked_by: string; acked_at: string }>();
  for (const r of rows) ackMap.set(`${r.kind}|${r.issue_key}`, r);
  for (const g of groups) {
    const a = ackMap.get(`${g.kind}|${g.key}`);
    g.ack = a && a.signature === g.signature ? a : null;
  }
}

function getPendingRequestsFor(perms: string[]) {
  const db = getDb();
  const verification = db
    .prepare(
      `SELECT v.id, v.task_id, v.point_id, v.created_at, v.status, v.resolved_at, v.resolved_by, v.issue_comment,
              p.address as point_address, p.ip_address, p.port, p.login, p.password, coalesce(pc.is_legacy, 0) as category_is_legacy
       FROM verification_requests v
       LEFT JOIN points p ON p.id = v.point_id
       LEFT JOIN point_categories pc ON pc.id = p.category_id
       WHERE v.status = 'pending'
       ORDER BY v.created_at`,
    )
    .all() as Array<Record<string, unknown>>;

  const access = db
    .prepare(
      `SELECT a.id, a.task_id, a.point_id, a.created_at, a.status, a.resolved_at, a.resolved_by, a.demontage_note,
              p.address as point_address, p.ip_address, p.port, p.login, p.password, coalesce(pc.is_legacy, 0) as category_is_legacy
       FROM access_issue_requests a
       LEFT JOIN points p ON p.id = a.point_id
       LEFT JOIN point_categories pc ON pc.id = p.category_id
       WHERE a.status = 'pending'
       ORDER BY a.created_at`,
    )
    .all() as Array<Record<string, unknown>>;

  const demontage = db
    .prepare(
      `SELECT d.id, d.task_id, d.point_id, d.reason, d.initiated_by, d.created_at, d.status,
              d.resolved_at, d.resolved_by, d.decline_comment, d.kind,
              p.address as point_address, p.ip_address, p.port, p.login, p.password, coalesce(pc.is_legacy, 0) as category_is_legacy
       FROM demontage_requests d
       LEFT JOIN points p ON p.id = d.point_id
       LEFT JOIN point_categories pc ON pc.id = p.category_id
       WHERE d.status = 'pending'
       ORDER BY d.created_at`,
    )
    .all() as Array<Record<string, unknown>>;

  return {
    verification: stripPointSecrets(verification, perms),
    access: stripPointSecrets(access, perms),
    demontage: stripPointSecrets(demontage, perms),
  };
}

// ---------- Bot Key Auth ----------
function requireBotKey(req: Request, res: Response, next: NextFunction): void {
  const key = String(req.headers['x-bot-key'] || req.headers['authorization']?.replace(/^Bearer\s+/i, '') || '').trim();
  if (!key || key !== settings.botApiKey) {
    res.status(401).json({ detail: 'Неверный ключ бота' });
    return;
  }
  next();
}

export function createMonitoringAndChatRouter(): Router {
  const router = Router();

  // ======================== MONITORING ========================
  router.get('/api/monitoring/active-sessions', requirePasswordOk, (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT s.id, s.task_id, s.point_id, s.started_at, p.address as point_address, pe.full_name as person_name
         FROM bot_work_sessions s
         LEFT JOIN points p ON p.id = s.point_id
         LEFT JOIN people pe ON pe.id = s.person_id
         WHERE s.ended_at IS NULL
         ORDER BY s.started_at`,
      )
      .all() as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, person_name: decryptField(String(r.person_name || '')) })));
  });

  router.post('/api/monitoring/active-sessions/:sessionId/release', requirePasswordOk, (req: AuthedRequest, res) => {
    const sessionId = Number(req.params.sessionId);
    const db = getDb();
    const session = db
      .prepare('SELECT id, task_id, point_id, person_id, started_at, ended_at FROM bot_work_sessions WHERE id = ?')
      .get(sessionId) as
      | { id: number; task_id: string; point_id: string; person_id: number; started_at: string; ended_at: string | null }
      | undefined;
    if (!session || session.ended_at) {
      res.status(404).json({ detail: 'Активная сессия не найдена' });
      return;
    }
    const task = db.prepare('SELECT type, point FROM tasks WHERE id = ?').get(session.task_id) as
      | { type: string; point: string }
      | undefined;
    if (!task) {
      res.status(404).json({ detail: 'Задание не найдено' });
      return;
    }
    const prog = db.prepare('SELECT state, updated_by FROM bot_task_progress WHERE task_id = ?').get(session.task_id) as
      | { state: string; updated_by: string | null }
      | undefined;
    let state: Record<string, unknown> = {};
    if (prog?.state) {
      try {
        state = JSON.parse(prog.state);
      } catch {
        state = {};
      }
    }
    let visitType = task.type || '';
    if (state.switched_to_repair && !visitType.includes('Ремонт')) {
      visitType = visitType ? `${visitType} + Ремонт` : 'Ремонт';
    }
    const pointId = task.point || session.point_id;
    const comment = String(state.comment || '').trim();
    const now = nowIso();
    const actor = req.sessionUser!.username;
    db.prepare(
      `INSERT INTO task_visit_reports (task_id, point_id, visit_type, result_status, comment, equipment_removed, equipment_installed,
        fault, needs, sim_removed, sim_installed, sim_removed_state, created_at, updated_at, created_by, updated_by)
       VALUES (?, ?, ?, 'Не работает', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(task_id) DO UPDATE SET
         result_status = excluded.result_status, comment = excluded.comment, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    ).run(
      session.task_id,
      pointId,
      visitType,
      comment || 'Диспетчер отпустил бригаду без ремонта (отчёт монтёра не был написан).',
      String(state.equipment_removed || '') || null,
      String(state.equipment_installed || '') || null,
      String(state.fault || '') || null,
      String(state.needs || '') || null,
      String(state.sim_removed || '') || null,
      String(state.sim_installed || '') || null,
      String(state.sim_removed_state || ''),
      now,
      now,
      actor,
      actor,
    );
    db.prepare('DELETE FROM bot_task_progress WHERE task_id = ?').run(session.task_id);
    db.prepare('UPDATE bot_work_sessions SET ended_at = ? WHERE task_id = ? AND ended_at IS NULL').run(
      now,
      session.task_id,
    );
    bumpStateRev();
    res.json({ ok: true });
  });

  router.post('/api/monitoring/active-sessions/:sessionId/demontage', requirePasswordOk, (req: AuthedRequest, res) => {
    const sessionId = Number(req.params.sessionId);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      res.status(400).json({ detail: 'Укажите причину демонтажа' });
      return;
    }
    const db = getDb();
    const session = db
      .prepare('SELECT id, task_id, point_id, ended_at FROM bot_work_sessions WHERE id = ?')
      .get(sessionId) as { id: number; task_id: string; point_id: string; ended_at: string | null } | undefined;
    if (!session || session.ended_at) {
      res.status(404).json({ detail: 'Активная сессия не найдена' });
      return;
    }
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO demontage_requests (task_id, point_id, reason, initiated_by, created_at, status, resolved_at, resolved_by, kind)
         VALUES (?, ?, ?, 'dispatcher', ?, 'approved', ?, ?, 'demontage')`,
      )
      .run(session.task_id, session.point_id, reason, now, now, req.sessionUser!.username);
    const row = db.prepare('SELECT * FROM demontage_requests WHERE id = ?').get(Number(info.lastInsertRowid));
    res.json(row);
  });

  router.delete('/api/monitoring/active-sessions/:sessionId', requirePasswordOk, (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const db = getDb();
    const row = db.prepare('SELECT id FROM bot_work_sessions WHERE id = ?').get(sessionId);
    if (!row) {
      res.status(404).json({ detail: 'Сессия не найдена' });
      return;
    }
    db.prepare('UPDATE bot_work_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(nowIso(), sessionId);
    res.json({ ok: true });
  });

  router.get('/api/monitoring/needs-check', requirePasswordOk, (_req, res) => {
    const db = getDb();
    const cutoff = new Date(Date.now() - 14 * 86400 * 1000).toISOString();
    const rows = db
      .prepare(
        `SELECT r.point_id, p.address as point_address, p.status as current_status, max(r.created_at) as reported_at
         FROM task_visit_reports r
         JOIN points p ON p.id = r.point_id
         WHERE r.result_status IN ('Работает', 'Установлен')
           AND r.created_at >= ?
           AND p.status != 'Работает'
         GROUP BY r.point_id
         ORDER BY reported_at DESC`,
      )
      .all(cutoff);
    res.json(rows);
  });

  router.delete('/api/monitoring/point-summaries/:taskId', requirePasswordOk, (req, res) => {
    const taskId = decodeURIComponent(req.params.taskId);
    getDb().prepare('DELETE FROM task_visit_reports WHERE task_id = ?').run(taskId);
    bumpStateRev();
    res.json({ ok: true });
  });

  router.get('/api/monitoring/point-summaries', requirePasswordOk, (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const tzOffset = Number(req.query.tz_offset || 0);
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    res.json(getPointSummaries(dateFrom, dateTo, true, Number.isFinite(tzOffset) ? tzOffset : 0));
  });

  router.get('/api/monitoring/point-summaries/export', requirePasswordOk, async (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    if (!isIsoDate(dateFrom) || !isIsoDate(dateTo)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const rawFields = req.query.fields;
    const reqFields = Array.isArray(rawFields)
      ? rawFields.map(String)
      : rawFields
        ? [String(rawFields)]
        : [];
    const chosen = reqFields.length
      ? MONITORING_EXPORT_FIELDS.filter(([k]) => reqFields.includes(k))
      : MONITORING_EXPORT_FIELDS;
    if (!chosen.length) {
      res.status(400).json({ detail: 'Выберите хотя бы одно поле' });
      return;
    }
    const rows = getPointSummaries(dateFrom, dateTo, false, 0);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Итоги по комплексам');
    ws.addRow(chosen.map(([, label]) => label));
    ws.getRow(1).font = { bold: true };
    for (const r of rows) {
      const rec: Record<string, unknown> = {
        ...r,
        sim_removed_state: SIM_STATE_LABELS[String(r.sim_removed_state || '')] || '',
      };
      ws.addRow(chosen.map(([k]) => safeExcelCell(rec[k])));
    }
    ws.columns.forEach((col) => {
      col.width = 24;
    });
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="point-summaries-${fmtRuDate(dateFrom)}_${fmtRuDate(dateTo)}.xlsx"`,
    );
    res.send(Buffer.from(buf));
  });

  // ---- Monitoring Photos (static routes MUST precede :photoId) ----
  router.get('/api/monitoring/photos', requirePasswordOk, (req, res) => {
    const date = String(req.query.date || '');
    if (!isIsoDate(date)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const rows = getDb()
      .prepare(
        `SELECT v.point_id, p.address as point_address, count(*) as count
         FROM visit_photos v LEFT JOIN points p ON p.id = v.point_id
         WHERE v.taken_date = ?
         GROUP BY v.point_id
         ORDER BY p.address`,
      )
      .all(date);
    res.json(rows);
  });

  router.get('/api/monitoring/photos/days', requirePasswordOk, (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT taken_date as date, count(*) as photos, count(distinct point_id) as points
         FROM visit_photos GROUP BY taken_date ORDER BY taken_date DESC`,
      )
      .all();
    res.json(rows);
  });

  router.get('/api/monitoring/photos/day-items', requirePasswordOk, (req, res) => {
    const date = String(req.query.date || '');
    if (!isIsoDate(date)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const rows = getDb()
      .prepare(
        `SELECT v.id, v.point_id, v.taken_date, v.file_ext, v.uploaded_at, v.uploaded_by, v.source, v.file_name, p.address
         FROM visit_photos v LEFT JOIN points p ON p.id = v.point_id
         WHERE v.taken_date = ?
         ORDER BY p.address, v.point_id, v.uploaded_at, v.id`,
      )
      .all(date) as Array<Record<string, unknown>>;
    const groups = new Map<string, { point_id: string; point_address: string; photos: unknown[] }>();
    for (const r of rows) {
      const pid = String(r.point_id);
      if (!groups.has(pid)) groups.set(pid, { point_id: pid, point_address: String(r.address || ''), photos: [] });
      groups.get(pid)!.photos.push({
        id: r.id,
        ext: r.file_ext,
        uploaded_at: r.uploaded_at,
        uploaded_by: r.uploaded_by || '',
        date: r.taken_date,
        imported: r.source === 'import',
        name: r.file_name || '',
        where: 'local',
      });
    }
    res.json([...groups.values()]);
  });

  router.get('/api/monitoring/photos/by-point', requirePasswordOk, (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT v.point_id, p.address as point_address, count(*) as count,
                min(v.taken_date) as first, max(v.taken_date) as last,
                sum(case when v.source = 'import' then 1 else 0 end) as archive
         FROM visit_photos v LEFT JOIN points p ON p.id = v.point_id
         GROUP BY v.point_id
         ORDER BY max(v.taken_date) DESC, v.point_id`,
      )
      .all();
    res.json(rows);
  });

  router.get('/api/monitoring/photos/point-items', requirePasswordOk, (req, res) => {
    const pointId = String(req.query.point_id || '');
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT id, point_id, taken_date, file_ext, uploaded_at, uploaded_by, source, file_name
         FROM visit_photos WHERE point_id = ?
         ORDER BY taken_date DESC, uploaded_at, id`,
      )
      .all(pointId) as Array<Record<string, unknown>>;
    const pt = db.prepare('SELECT address FROM points WHERE id = ?').get(pointId) as { address?: string } | undefined;
    const days = new Map<string, unknown[]>();
    for (const r of rows) {
      const d = String(r.taken_date);
      if (!days.has(d)) days.set(d, []);
      days.get(d)!.push({
        id: r.id,
        ext: r.file_ext,
        uploaded_at: r.uploaded_at,
        uploaded_by: r.uploaded_by || '',
        date: r.taken_date,
        imported: r.source === 'import',
        name: r.file_name || '',
        where: 'local',
      });
    }
    res.json({
      point_id: pointId,
      point_address: pt?.address || '',
      total: rows.length,
      days: [...days.entries()].map(([date, photos]) => ({ date, photos })),
    });
  });

  router.post('/api/monitoring/photos/upload', requirePasswordOk, photoUpload.single('file'), async (req: AuthedRequest, res) => {
    const pointId = String(req.body?.point_id || '').trim();
    const date = String(req.body?.date || '').trim();
    if (!isIsoDate(date)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const maxAllowed = new Date(Date.now() + 86400 * 1000).toISOString().slice(0, 10);
    if (date > maxAllowed) {
      res.status(400).json({ detail: 'Дата в будущем — выберите день, когда фото снято' });
      return;
    }
    if (date < '2000-01-01') {
      res.status(400).json({ detail: 'Слишком старая дата — проверьте год' });
      return;
    }
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM points WHERE id = ?').get(pointId)) {
      res.status(404).json({ detail: 'Комплекс не найден' });
      return;
    }
    if (!req.file || !req.file.buffer.length) {
      res.status(400).json({ detail: 'Пустой файл' });
      return;
    }
    const buf = req.file.buffer;
    if (buf.length > 15 * 1024 * 1024) {
      res.status(413).json({ detail: 'Файл слишком большой (максимум 15 МБ)' });
      return;
    }
    const ext = sniffImage(buf);
    if (!ext) {
      if (isHeic(buf)) {
        res.status(415).json({ detail: 'Формат HEIC браузер показывать не умеет — пришлите снимок в JPEG' });
        return;
      }
      res.status(415).json({ detail: 'Это не фото в поддерживаемом формате (JPEG, PNG, WebP, GIF, BMP)' });
      return;
    }
    const cleanName = path.basename(req.file.originalname || '').slice(-80) || null;
    const now = nowIso();
    const info = db
      .prepare(
        `INSERT INTO visit_photos (task_id, point_id, taken_date, file_ext, uploaded_at, uploaded_by, source, file_name, file_size)
         VALUES ('', ?, ?, ?, ?, ?, 'web', ?, ?)`,
      )
      .run(pointId, date, ext, now, req.sessionUser!.username, cleanName, buf.length);
    const id = Number(info.lastInsertRowid);
    const stored = await storeVisitPhoto({ id, point_id: pointId, taken_date: date, file_ext: ext }, buf);
    db.prepare('UPDATE visit_photos SET storage = ?, storage_path = ?, rel_path = ? WHERE id = ?').run(
      stored.storage,
      stored.storagePath,
      stored.relPath,
      id,
    );
    res.json({ id, date, ext });
  });

  router.get('/api/monitoring/photos/export-all', requirePasswordOk, async (_req, res) => {
    const photos = getDb()
      .prepare('SELECT id, point_id, taken_date, file_ext, storage_path, rel_path, file_name FROM visit_photos ORDER BY point_id, taken_date, id')
      .all() as Array<{
      id: number;
      point_id: string;
      taken_date: string;
      file_ext: string;
      storage_path: string;
      rel_path: string | null;
      file_name: string | null;
    }>;
    if (!photos.length) {
      res.status(404).json({ detail: 'Фото пока нет' });
      return;
    }
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="photos-all-days.zip"');
    const archive = archiver('zip', { store: true });
    archive.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);
    for (const ph of photos) {
      const buf = await readVisitPhotoBuffer(ph);
      if (buf) {
        const entryName = `${safeFolderSegment(ph.point_id)}/${fmtRuDate(ph.taken_date)}/${ph.id}.${ph.file_ext}`;
        archive.append(buf, { name: entryName });
      }
    }
    await archive.finalize();
  });

  router.get('/api/monitoring/photos/export', requirePasswordOk, async (req, res) => {
    const date = String(req.query.date || '');
    if (!isIsoDate(date)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const photos = getDb()
      .prepare('SELECT id, point_id, taken_date, file_ext, storage_path, rel_path FROM visit_photos WHERE taken_date = ? ORDER BY point_id, id')
      .all(date) as Array<{
      id: number;
      point_id: string;
      taken_date: string;
      file_ext: string;
      storage_path: string;
      rel_path: string | null;
    }>;
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="photos-${fmtRuDate(date)}.zip"`);
    const archive = archiver('zip', { store: true });
    archive.on('error', () => {
      if (!res.headersSent) res.status(500).end();
    });
    archive.pipe(res);
    for (const ph of photos) {
      const buf = await readVisitPhotoBuffer(ph);
      if (buf) {
        archive.append(buf, { name: `${safeFolderSegment(ph.point_id)}/${ph.id}.${ph.file_ext}` });
      }
    }
    await archive.finalize();
  });

  router.get('/api/monitoring/photos/:photoId/file', requirePasswordOk, async (req, res) => {
    const photoId = Number(req.params.photoId);
    const ph = getDb()
      .prepare('SELECT id, point_id, taken_date, file_ext, storage_path, rel_path, file_name FROM visit_photos WHERE id = ?')
      .get(photoId) as
      | {
          id: number;
          point_id: string;
          taken_date: string;
          file_ext: string;
          storage_path: string;
          rel_path: string | null;
          file_name: string | null;
        }
      | undefined;
    if (!ph) {
      res.status(404).json({ detail: 'Фото не найдено' });
      return;
    }
    const buf = await readVisitPhotoBuffer(ph);
    if (!buf) {
      res.status(404).json({ detail: 'Файл фото не найден на диске' });
      return;
    }
    const ext = (ph.file_ext || '').toLowerCase();
    const mime = IMAGE_MIME[ext] || 'application/octet-stream';
    const download = req.query.download === '1' || req.query.download === 'true';
    res.setHeader('X-Content-Type-Options', 'nosniff');
    if (download || !IMAGE_MIME[ext]) {
      const name = ph.file_name || `${safeFolderSegment(ph.point_id)}_${fmtRuDate(ph.taken_date)}_${ph.id}.${ext}`;
      res.setHeader(
        'Content-Disposition',
        `attachment; filename="photo-${ph.id}.${ext}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      );
      res.setHeader('Cache-Control', 'private, no-store');
    } else {
      res.setHeader('Cache-Control', 'private, max-age=3600');
    }
    res.setHeader('Content-Type', mime);
    res.send(buf);
  });

  router.delete('/api/monitoring/photos/:photoId', requirePasswordOk, async (req, res) => {
    const photoId = Number(req.params.photoId);
    const db = getDb();
    const ph = db
      .prepare('SELECT id, point_id, taken_date, file_ext, storage_path, rel_path, source FROM visit_photos WHERE id = ?')
      .get(photoId) as
      | {
          id: number;
          point_id: string;
          taken_date: string;
          file_ext: string;
          storage_path: string;
          rel_path: string | null;
          source: string | null;
        }
      | undefined;
    if (!ph) {
      res.status(404).json({ detail: 'Фото не найдено' });
      return;
    }
    if (ph.source === 'import') {
      res.status(409).json({ detail: 'Это фото из прежнего архива на сетевом диске — программа его не удаляет.' });
      return;
    }
    await deleteVisitPhotoFiles(ph);
    db.prepare('DELETE FROM visit_photos WHERE id = ?').run(photoId);
    res.json({ removed: 1 });
  });

  router.delete('/api/monitoring/photos', requirePasswordOk, async (req, res) => {
    const pointId = String(req.query.point_id || '');
    const date = String(req.query.date || '');
    if (!isIsoDate(date)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const db = getDb();
    const list = db
      .prepare("SELECT id, point_id, taken_date, file_ext, storage_path, rel_path FROM visit_photos WHERE point_id = ? AND taken_date = ? AND coalesce(source, '') != 'import'")
      .all(pointId, date) as Array<{
      id: number;
      point_id: string;
      taken_date: string;
      file_ext: string;
      storage_path: string;
      rel_path: string | null;
    }>;
    for (const ph of list) {
      await deleteVisitPhotoFiles(ph);
    }
    const info = db
      .prepare("DELETE FROM visit_photos WHERE point_id = ? AND taken_date = ? AND coalesce(source, '') != 'import'")
      .run(pointId, date);
    res.json({ removed: info.changes });
  });

  // ======================== PHOTO STORAGE (Встроенный SMB2/SMB3-клиент + локальный буфер) ========================
  router.get('/api/photo-storage', requirePasswordOk, async (req: AuthedRequest, res) => {
    const admin = hasPerm(req.sessionUser!.permissions, 'admin.settings');
    res.json(await getPhotoStorageStatus(admin));
  });

  router.put('/api/photo-storage/config', requirePerm('admin.settings'), async (req, res) => {
    try {
      const status = await savePhotoStorageConfig(req.body || {});
      res.json(status);
    } catch (err) {
      if (err instanceof PhotoStorageError) {
        res.status(409).json({ detail: err.message });
        return;
      }
      res.status(400).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/photo-storage/test', requirePerm('admin.settings'), async (req, res) => {
    try {
      const result = await testPhotoStorageConnection(req.body || {});
      res.json(result);
    } catch (err) {
      if (err instanceof PhotoStorageError) {
        res.status(409).json({ detail: err.message });
        return;
      }
      res.status(400).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/photo-storage/scan', requirePerm('admin.settings'), async (_req, res) => {
    res.json(await scanPhotoStorage());
  });

  router.post('/api/photo-storage/marker', requirePerm('admin.settings'), async (_req, res) => {
    try {
      res.json(await initPhotoStorageMarker());
    } catch (err) {
      res.status(409).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/photo-storage/flush', requirePerm('admin.settings'), async (_req, res) => {
    res.json(await flushPhotoSpool());
  });

  router.post('/api/photo-storage/migrate', requirePerm('admin.settings'), async (_req, res) => {
    try {
      res.json(await startPhotoMigration());
    } catch (err) {
      res.status(409).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/photo-storage/index', requirePerm('admin.settings'), async (_req, res) => {
    try {
      res.json(await startPhotoIndex(false));
    } catch (err) {
      res.status(409).json({ detail: (err as Error).message });
    }
  });

  // ======================== NOTIFICATIONS ========================
  router.get('/api/notifications/pending-requests', requirePasswordOk, (req: AuthedRequest, res) => {
    res.json(getPendingRequestsFor(req.sessionUser!.permissions));
  });

  router.get('/api/notifications/data-issues/summary', requirePasswordOk, (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    if (dateFrom && !isIsoDate(dateFrom)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const day = getDayGroups(dateFrom, '');
    const { simGroups, linkGroups } = getSimAndLinkGroups([]);
    const sim = simGroups.filter((g) => !g.fully_linked);
    applyAcks(day);
    applyAcks(sim);
    const d = day.filter((g) => !g.ack).length;
    const s = sim.filter((g) => !g.ack).length;
    res.json({ day: d, sim: s, link: linkGroups.length, total: d + s });
  });

  router.get('/api/notifications/data-issues', requirePasswordOk, (req: AuthedRequest, res) => {
    const kind = String(req.query.kind || 'sim');
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const q = String(req.query.q || '').trim().toLowerCase();
    const hint = String(req.query.hint || '');
    let acked = req.query.acked === 'true' || req.query.acked === '1';
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 50)));
    const offset = Math.max(0, Number(req.query.offset || 0));

    if (!['day', 'sim', 'link'].includes(kind)) {
      res.status(400).json({ detail: 'Неизвестный вид ошибок данных' });
      return;
    }
    if ((dateFrom && !isIsoDate(dateFrom)) || (dateTo && !isIsoDate(dateTo))) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }

    let groups: Array<Record<string, unknown>>;
    if (kind === 'day') {
      groups = getDayGroups(dateFrom, dateTo);
      const today = new Date().toISOString().slice(0, 10);
      const rev = !(dateFrom && dateFrom >= today);
      groups.sort((a, b) => {
        const cmp = String(a.date).localeCompare(String(b.date)) || String(a.point_id).localeCompare(String(b.point_id));
        return rev ? -cmp : cmp;
      });
    } else if (kind === 'link') {
      groups = getSimAndLinkGroups(req.sessionUser!.permissions).linkGroups;
      acked = false;
    } else {
      groups = getSimAndLinkGroups(req.sessionUser!.permissions).simGroups.filter((g) => !g.fully_linked);
    }

    if (kind !== 'link') applyAcks(groups);
    const openTotal = groups.filter((g) => !g.ack).length;
    const ackedTotal = groups.length - openTotal;
    let rows = groups.filter((g) => Boolean(g.ack) === acked);
    if (q) {
      rows = rows.filter((g) => {
        if (g.kind === 'day') {
          const tasks = g.tasks as Array<Record<string, unknown>>;
          const hay = [
            g.point_id,
            g.address,
            g.date,
            ...tasks.map((t) => t.crew_name),
            ...tasks.flatMap((t) => (t.members as string[]) || []),
          ];
          return hay.some((h) => String(h || '').toLowerCase().includes(q));
        }
        const pts = g.points as Array<Record<string, unknown>>;
        const hay = [
          g.sim,
          ...pts.flatMap((p) => [p.sim_raw, p.id, p.address, p.ip_address, p.port, p.category_name]),
        ];
        return hay.some((h) => String(h || '').toLowerCase().includes(q));
      });
    }
    if ((kind === 'sim' || kind === 'link') && hint) {
      rows = rows.filter((g) => Boolean((g.flags as Record<string, boolean>)?.[hint]));
    }
    res.json({
      kind,
      total: rows.length,
      open_total: openTotal,
      acked_total: ackedTotal,
      items: rows.slice(offset, offset + limit),
    });
  });

  router.post('/api/notifications/data-issues/ack', requirePasswordOk, (req: AuthedRequest, res) => {
    const kind = String(req.body?.kind || '');
    const key = String(req.body?.key || '');
    const value = req.body?.value !== false;
    if (kind !== 'day' && kind !== 'sim') {
      res.status(400).json({ detail: 'Неизвестный вид ошибок данных' });
      return;
    }
    const db = getDb();
    if (value) {
      const day = key.split('|')[0];
      const groups = kind === 'day' ? getDayGroups(day, day) : getSimAndLinkGroups([]).simGroups;
      const found = groups.find((g) => g.key === key);
      if (!found) {
        res.status(404).json({ detail: 'Такой записи уже нет — возможно, данные исправили' });
        return;
      }
      db.prepare(
        `INSERT INTO data_issue_ack (kind, issue_key, signature, acked_by, acked_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(kind, issue_key) DO UPDATE SET
           signature = excluded.signature, acked_by = excluded.acked_by, acked_at = excluded.acked_at`,
      ).run(kind, key, String(found.signature), req.sessionUser!.username, nowIso());
    } else {
      db.prepare('DELETE FROM data_issue_ack WHERE kind = ? AND issue_key = ?').run(kind, key);
    }
    res.json({ ok: true });
  });

  router.post('/api/notifications/data-issues/link', requirePasswordOk, (req, res) => {
    const rawIds: unknown[] = Array.isArray(req.body?.point_ids) ? req.body.point_ids : [];
    const ids = [...new Set(rawIds.map((x) => String(x || '').trim()).filter(Boolean))];
    if (ids.length < 2) {
      res.status(400).json({ detail: 'Выберите хотя бы два комплекса' });
      return;
    }
    const db = getDb();
    const marks = ids.map(() => '?').join(',');
    const pts = db.prepare(`SELECT id, sim_number FROM points WHERE id IN (${marks})`).all(...ids) as Array<{
      id: string;
      sim_number: string;
    }>;
    const simById = new Map(pts.map((p) => [p.id, p.sim_number]));
    const missing = ids.filter((i) => !simById.has(i));
    if (missing.length) {
      res.status(404).json({ detail: `Комплекс не найден: ${missing.join(', ')}` });
      return;
    }
    const keys = new Set(pts.map((p) => simKey(p.sim_number)));
    const onlyKey = [...keys][0] || '';
    if (keys.size !== 1 || !simKeyValid(onlyKey)) {
      res.status(400).json({ detail: 'Связать можно только комплексы с одним и тем же номером SIM' });
      return;
    }
    const existingGids = (
      db
        .prepare(`SELECT DISTINCT group_id FROM point_sim_links WHERE point_id IN (${marks}) ORDER BY group_id`)
        .all(...ids) as Array<{ group_id: number }>
    ).map((r) => r.group_id);

    const gid =
      existingGids.length > 0
        ? existingGids[0]
        : Number(
            (db.prepare('SELECT coalesce(max(group_id), 0) + 1 as next_id FROM point_sim_links').get() as {
              next_id: number;
            }).next_id,
          );
    for (const other of existingGids.slice(1)) {
      db.prepare('UPDATE point_sim_links SET group_id = ? WHERE group_id = ?').run(gid, other);
    }
    for (const pid of ids) {
      db.prepare('INSERT OR REPLACE INTO point_sim_links (point_id, group_id) VALUES (?, ?)').run(pid, gid);
    }
    const members = db
      .prepare(
        'SELECT p.id, p.sim_number FROM point_sim_links l JOIN points p ON p.id = l.point_id WHERE l.group_id = ? ORDER BY p.id',
      )
      .all(gid) as Array<{ id: string; sim_number: string }>;
    res.json({ group_id: gid, members: members.map((m) => m.id), sim: onlyKey });
  });

  router.post('/api/notifications/data-issues/unlink', requirePasswordOk, (req, res) => {
    const db = getDb();
    const groupId = req.body?.group_id;
    const pointId = String(req.body?.point_id || '').trim();
    if (groupId != null && groupId !== '') {
      const info = db.prepare('DELETE FROM point_sim_links WHERE group_id = ?').run(Number(groupId));
      if (!info.changes) {
        res.status(404).json({ detail: 'Такой связки уже нет' });
        return;
      }
      res.json({ ok: true });
      return;
    }
    if (!pointId) {
      res.status(400).json({ detail: 'Укажите комплекс или связку' });
      return;
    }
    const row = db.prepare('SELECT group_id FROM point_sim_links WHERE point_id = ?').get(pointId) as
      | { group_id: number }
      | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Такой связки уже нет' });
      return;
    }
    db.prepare('DELETE FROM point_sim_links WHERE point_id = ?').run(pointId);
    const left = (
      db.prepare('SELECT count(*) as c FROM point_sim_links WHERE group_id = ?').get(row.group_id) as { c: number }
    ).c;
    if (left < 2) {
      db.prepare('DELETE FROM point_sim_links WHERE group_id = ?').run(row.group_id);
    }
    res.json({ ok: true });
  });

  router.post('/api/notifications/data-issues/keep-sim', requirePasswordOk, (req: AuthedRequest, res) => {
    const pointId = String(req.body?.point_id || '').trim();
    const db = getDb();
    const mine = db.prepare('SELECT id, sim_number, ip_address FROM points WHERE id = ?').get(pointId) as
      | { id: string; sim_number: string; ip_address: string }
      | undefined;
    if (!mine) {
      res.status(404).json({ detail: 'Комплекс не найден' });
      return;
    }
    const key = simKey(mine.sim_number);
    if (!simKeyValid(key)) {
      res.status(400).json({ detail: 'У этого комплекса не указан номер SIM' });
      return;
    }
    const allWithSim = db
      .prepare("SELECT id, sim_number, ip_address FROM points WHERE trim(coalesce(sim_number, '')) != '' ORDER BY id")
      .all() as Array<{ id: string; sim_number: string; ip_address: string }>;
    const others = allWithSim.filter((r) => r.id !== pointId && simKey(r.sim_number) === key);
    if (!others.length) {
      res.status(409).json({ detail: 'Этот номер SIM записан только у этого комплекса — убирать нечего' });
      return;
    }
    for (const o of others) {
      db.prepare("UPDATE points SET sim_number = '', ip_address = '' WHERE id = ?").run(o.id);
      const linkRow = db.prepare('SELECT group_id FROM point_sim_links WHERE point_id = ?').get(o.id) as
        | { group_id: number }
        | undefined;
      if (linkRow) {
        db.prepare('DELETE FROM point_sim_links WHERE point_id = ?').run(o.id);
        const left = (
          db.prepare('SELECT count(*) as c FROM point_sim_links WHERE group_id = ?').get(linkRow.group_id) as {
            c: number;
          }
        ).c;
        if (left < 2) db.prepare('DELETE FROM point_sim_links WHERE group_id = ?').run(linkRow.group_id);
      }
    }
    db.prepare(
      `UPDATE equipment SET point_id = ?, updated_at = ?
       WHERE place = 'point' AND serial_number = ? AND point_id != ?`,
    ).run(pointId, nowIso(), key, pointId);
    bumpStateRev();
    res.json({
      ok: true,
      kept: pointId,
      cleared: others.map((o) => o.id),
      performed_by: req.sessionUser!.username,
    });
  });

  router.get('/api/notifications', requirePasswordOk, (req, res) => {
    const kind = String(req.query.kind || '');
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const q = String(req.query.q || '').trim().toLowerCase();
    const limit = Math.min(500, Math.max(1, Number(req.query.limit || 100)));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const tzOffset = Number(req.query.tz_offset || 0);

    if (!['', 'check', 'decision', 'report', 'repeat'].includes(kind)) {
      res.status(400).json({ detail: 'Неизвестный вид уведомлений' });
      return;
    }
    if ((dateFrom && !isIsoDate(dateFrom)) || (dateTo && !isIsoDate(dateTo))) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }

    let low = '';
    let high = '';
    if (dateFrom) {
      const s = new Date(`${dateFrom}T00:00:00.000Z`);
      s.setUTCMinutes(s.getUTCMinutes() + (Number.isFinite(tzOffset) ? tzOffset : 0));
      low = s.toISOString();
    }
    if (dateTo) {
      const e = new Date(`${dateTo}T00:00:00.000Z`);
      e.setUTCDate(e.getUTCDate() + 1);
      e.setUTCMinutes(e.getUTCMinutes() + (Number.isFinite(tzOffset) ? tzOffset : 0));
      high = e.toISOString();
    }

    const db = getDb();
    const items: Array<Record<string, unknown>> = [];
    let total = 0;
    const want = limit + offset;

    const matchQ = (fields: Array<unknown>) => !q || fields.some((f) => String(f || '').toLowerCase().includes(q));

    if (kind === '' || kind === 'report' || kind === 'repeat') {
      let where = 'r.imported = 0';
      const params: SQLInputValue[] = [];
      if (kind === 'repeat') where += " AND r.result_status = 'Не работает'";
      if (low) {
        where += ' AND r.created_at >= ?';
        params.push(low);
      }
      if (high) {
        where += ' AND r.created_at < ?';
        params.push(high);
      }
      const rows = db
        .prepare(
          `SELECT r.created_at, r.task_id, r.point_id, p.address, r.visit_type, r.result_status, r.outcome, r.comment,
                  coalesce(pe.full_name, r.created_by) as by_name, r.fault, r.needs, c.name as crew
           FROM task_visit_reports r
           LEFT JOIN points p ON p.id = r.point_id
           LEFT JOIN tasks t ON t.id = r.task_id
           LEFT JOIN crews c ON c.id = t.team
           LEFT JOIN people pe ON pe.id = r.author_person_id
           WHERE ${where}
           ORDER BY r.created_at DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;

      const filtered = rows.filter((r) =>
        matchQ([r.point_id, r.address, r.comment, r.fault, r.needs, cleanWho(String(r.by_name || ''))]),
      );
      total += filtered.length;
      for (const r of filtered.slice(0, want)) {
        const st = String(r.result_status || '');
        const repeat = st === 'Не работает';
        items.push({
          id: `report:${r.task_id}`,
          kind: 'report',
          ts: r.created_at,
          task_id: r.task_id,
          point_id: r.point_id,
          point_address: r.address || '',
          title: `Отчёт · ${r.visit_type || ''}`,
          status: String(r.outcome || '') || st || '—',
          tone: repeat ? 'bad' : st === 'Работает' || st === 'Установлен' ? 'ok' : 'info',
          text: r.comment || '',
          person: cleanWho(String(r.by_name || '')),
          crew: r.crew || '',
          repeat_visit: repeat,
          fault: r.fault || '',
          needs: r.needs || '',
          resolved_by: '',
          resolved_at: null,
        });
      }
    }

    if (kind === '' || kind === 'check') {
      let where = '1 = 1';
      const params: SQLInputValue[] = [];
      if (low) {
        where += ' AND v.created_at >= ?';
        params.push(low);
      }
      if (high) {
        where += ' AND v.created_at < ?';
        params.push(high);
      }
      const rows = db
        .prepare(
          `SELECT v.id, v.created_at, v.task_id, v.point_id, p.address, v.status, v.resolved_at, v.resolved_by, v.issue_comment, c.name as crew
           FROM verification_requests v
           LEFT JOIN points p ON p.id = v.point_id
           LEFT JOIN tasks t ON t.id = v.task_id
           LEFT JOIN crews c ON c.id = t.team
           WHERE ${where}
           ORDER BY v.created_at DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;

      const checkLabel: Record<string, [string, string]> = {
        pending: ['ожидает проверки', 'warn'],
        confirmed: ['подтверждено: работает', 'ok'],
        remark: ['работает с замечанием', 'warn'],
        issue: ['продолжить работу', 'bad'],
      };
      const filtered = rows.filter((r) => matchQ([r.point_id, r.address, r.issue_comment, r.resolved_by]));
      total += filtered.length;
      for (const r of filtered.slice(0, want)) {
        const [label, tone] = checkLabel[String(r.status)] || [String(r.status || ''), 'info'];
        items.push({
          id: `check:${r.id}`,
          kind: 'check',
          ts: r.created_at,
          task_id: r.task_id,
          point_id: r.point_id,
          point_address: r.address || '',
          title: 'Проверка комплекса оператором',
          status: label,
          tone,
          text: r.issue_comment || '',
          person: '',
          crew: r.crew || '',
          repeat_visit: false,
          fault: '',
          needs: '',
          resolved_by: r.resolved_by || '',
          resolved_at: r.resolved_at,
        });
      }
    }

    if (kind === '' || kind === 'decision') {
      const dmStatus: Record<string, [string, string]> = {
        pending: ['ждёт решения диспетчера', 'warn'],
        approved: ['одобрено', 'ok'],
        declined: ['отказано', 'bad'],
      };
      let where = '1 = 1';
      const params: SQLInputValue[] = [];
      if (low) {
        where += ' AND d.created_at >= ?';
        params.push(low);
      }
      if (high) {
        where += ' AND d.created_at < ?';
        params.push(high);
      }
      const dRows = db
        .prepare(
          `SELECT d.id, d.created_at, d.task_id, d.point_id, p.address, d.kind, d.reason, d.initiated_by, d.status,
                  d.resolved_at, d.resolved_by, d.decline_comment, c.name as crew
           FROM demontage_requests d
           LEFT JOIN points p ON p.id = d.point_id
           LEFT JOIN tasks t ON t.id = d.task_id
           LEFT JOIN crews c ON c.id = t.team
           WHERE ${where}
           ORDER BY d.created_at DESC`,
        )
        .all(...params) as Array<Record<string, unknown>>;

      const dFiltered = dRows.filter((r) =>
        matchQ([r.point_id, r.address, r.reason, r.decline_comment, r.resolved_by]),
      );
      total += dFiltered.length;
      for (const r of dFiltered.slice(0, want)) {
        const [label, tone] = dmStatus[String(r.status)] || [String(r.status || ''), 'info'];
        const what = r.kind === 'release' ? 'Отпустить бригаду без ремонта' : 'Демонтаж комплекса';
        const who = r.initiated_by === 'dispatcher' ? 'по решению диспетчера' : 'по запросу монтёра';
        items.push({
          id: `decision:d${r.id}`,
          kind: 'decision',
          ts: r.created_at,
          task_id: r.task_id,
          point_id: r.point_id,
          point_address: r.address || '',
          title: `${what} — ${who}`,
          status: label,
          tone,
          text: r.status === 'declined' && r.decline_comment ? r.decline_comment : r.reason || '',
          person: '',
          crew: r.crew || '',
          repeat_visit: false,
          fault: '',
          needs: '',
          resolved_by: r.resolved_by || '',
          resolved_at: r.resolved_at,
        });
      }

      let aWhere = '1 = 1';
      const aParams: SQLInputValue[] = [];
      if (low) {
        aWhere += ' AND a.created_at >= ?';
        aParams.push(low);
      }
      if (high) {
        aWhere += ' AND a.created_at < ?';
        aParams.push(high);
      }
      const aRows = db
        .prepare(
          `SELECT a.id, a.created_at, a.task_id, a.point_id, p.address, a.status, a.resolved_at, a.resolved_by, a.demontage_note, c.name as crew
           FROM access_issue_requests a
           LEFT JOIN points p ON p.id = a.point_id
           LEFT JOIN tasks t ON t.id = a.task_id
           LEFT JOIN crews c ON c.id = t.team
           WHERE ${aWhere}
           ORDER BY a.created_at DESC`,
        )
        .all(...aParams) as Array<Record<string, unknown>>;

      const aFiltered = aRows.filter((r) => matchQ([r.point_id, r.address, r.demontage_note, r.resolved_by]));
      total += aFiltered.length;
      const aLabels: Record<string, [string, string]> = {
        pending: ['ждёт решения диспетчера', 'warn'],
        released: ['бригаду отпустили без ремонта', 'info'],
        demontage: ['оформлен демонтаж', 'info'],
      };
      for (const r of aFiltered.slice(0, want)) {
        const [label, tone] = aLabels[String(r.status)] || [String(r.status || ''), 'info'];
        items.push({
          id: `decision:a${r.id}`,
          kind: 'decision',
          ts: r.created_at,
          task_id: r.task_id,
          point_id: r.point_id,
          point_address: r.address || '',
          title: 'Нет доступа к комплексу — решение по бригаде',
          status: label,
          tone,
          text: r.demontage_note || '',
          person: '',
          crew: r.crew || '',
          repeat_visit: false,
          fault: '',
          needs: '',
          resolved_by: r.resolved_by || '',
          resolved_at: r.resolved_at,
        });
      }
    }

    items.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    const repeatTotal = (
      db
        .prepare("SELECT count(*) as c FROM task_visit_reports WHERE imported = 0 AND result_status = 'Не работает'")
        .get() as { c: number }
    ).c;

    res.json({
      items: items.slice(offset, offset + limit),
      total,
      repeat_total: repeatTotal,
      kinds: ['check', 'decision', 'report', 'repeat'],
    });
  });

  // ======================== REQUEST QUEUES ========================
  router.get('/api/verification-requests', requirePasswordOk, (req: AuthedRequest, res) => {
    const db = getDb();
    if (req.query.status === 'pending') {
      res.json(getPendingRequestsFor(req.sessionUser!.permissions).verification);
      return;
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const rows = db
      .prepare(
        `SELECT v.id, v.task_id, v.point_id, v.created_at, v.status, v.resolved_at, v.resolved_by, v.issue_comment, p.address as point_address
         FROM verification_requests v LEFT JOIN points p ON p.id = v.point_id
         ORDER BY v.created_at DESC LIMIT ?`,
      )
      .all(limit);
    res.json(rows);
  });

  router.post('/api/verification-requests/:requestId/resolve', requirePasswordOk, (req: AuthedRequest, res) => {
    const id = Number(req.params.requestId);
    const ok = Boolean(req.body?.ok);
    const remark = Boolean(req.body?.remark);
    const comment = String(req.body?.issue_comment || '').trim() || null;
    if (remark && !ok) {
      res.status(400).json({ detail: 'Замечание бывает только у работающего комплекса' });
      return;
    }
    if (remark && !comment) {
      res.status(400).json({ detail: 'Напишите замечание' });
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT status FROM verification_requests WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Запрос не найден' });
      return;
    }
    if (existing.status !== 'pending') {
      res.status(400).json({ detail: 'Запрос уже обработан' });
      return;
    }
    const newStatus = ok ? (remark ? 'remark' : 'confirmed') : 'issue';
    db.prepare(
      "UPDATE verification_requests SET status = ?, resolved_at = ?, resolved_by = ?, issue_comment = ? WHERE id = ? AND status = 'pending'",
    ).run(newStatus, nowIso(), req.sessionUser!.username, !ok || remark ? comment : null, id);
    res.json(db.prepare('SELECT * FROM verification_requests WHERE id = ?').get(id));
  });

  router.delete('/api/verification-requests/:requestId', requirePasswordOk, (req, res) => {
    getDb().prepare('DELETE FROM verification_requests WHERE id = ?').run(Number(req.params.requestId));
    res.json({ ok: true });
  });

  router.get('/api/access-issues', requirePasswordOk, (req: AuthedRequest, res) => {
    if (req.query.status === 'pending') {
      res.json(getPendingRequestsFor(req.sessionUser!.permissions).access);
      return;
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const rows = getDb()
      .prepare(
        `SELECT a.id, a.task_id, a.point_id, a.created_at, a.status, a.resolved_at, a.resolved_by, a.demontage_note, p.address as point_address
         FROM access_issue_requests a LEFT JOIN points p ON p.id = a.point_id
         ORDER BY a.created_at DESC LIMIT ?`,
      )
      .all(limit);
    res.json(rows);
  });

  router.post('/api/access-issues/:requestId/resolve', requirePasswordOk, (req: AuthedRequest, res) => {
    const id = Number(req.params.requestId);
    const decision = String(req.body?.decision || '');
    const note = String(req.body?.demontage_note || '').trim() || null;
    if (decision !== 'released' && decision !== 'demontage') {
      res.status(400).json({ detail: 'Неизвестное решение' });
      return;
    }
    if (decision === 'demontage' && !note) {
      res.status(400).json({ detail: 'Укажите, что демонтировать' });
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT status FROM access_issue_requests WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Запрос не найден' });
      return;
    }
    if (existing.status !== 'pending') {
      res.status(400).json({ detail: 'Запрос уже обработан' });
      return;
    }
    db.prepare(
      "UPDATE access_issue_requests SET status = ?, resolved_at = ?, resolved_by = ?, demontage_note = ? WHERE id = ? AND status = 'pending'",
    ).run(decision, nowIso(), req.sessionUser!.username, decision === 'demontage' ? note : null, id);
    res.json(db.prepare('SELECT * FROM access_issue_requests WHERE id = ?').get(id));
  });

  router.get('/api/demontage-requests', requirePasswordOk, (req: AuthedRequest, res) => {
    if (req.query.status === 'pending') {
      res.json(getPendingRequestsFor(req.sessionUser!.permissions).demontage);
      return;
    }
    const limit = Math.min(200, Math.max(1, Number(req.query.limit || 20)));
    const rows = getDb()
      .prepare(
        `SELECT d.id, d.task_id, d.point_id, d.reason, d.initiated_by, d.created_at, d.status,
                d.resolved_at, d.resolved_by, d.decline_comment, d.kind, p.address as point_address
         FROM demontage_requests d LEFT JOIN points p ON p.id = d.point_id
         ORDER BY d.created_at DESC LIMIT ?`,
      )
      .all(limit);
    res.json(rows);
  });

  router.post('/api/demontage-requests/:requestId/resolve', requirePasswordOk, (req: AuthedRequest, res) => {
    const id = Number(req.params.requestId);
    const approve = Boolean(req.body?.approve);
    const declineComment = String(req.body?.decline_comment || '').trim() || null;
    if (!approve && !declineComment) {
      res.status(400).json({ detail: 'Укажите причину отказа' });
      return;
    }
    const db = getDb();
    const existing = db.prepare('SELECT status FROM demontage_requests WHERE id = ?').get(id) as
      | { status: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Запрос не найден' });
      return;
    }
    if (existing.status !== 'pending') {
      res.status(400).json({ detail: 'Запрос уже обработан' });
      return;
    }
    db.prepare(
      "UPDATE demontage_requests SET status = ?, resolved_at = ?, resolved_by = ?, decline_comment = ? WHERE id = ? AND status = 'pending'",
    ).run(approve ? 'approved' : 'declined', nowIso(), req.sessionUser!.username, approve ? null : declineComment, id);
    res.json(db.prepare('SELECT * FROM demontage_requests WHERE id = ?').get(id));
  });

  router.get('/api/join-requests', requirePasswordOk, (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM bot_join_requests ORDER BY requested_at DESC').all());
  });

  router.post('/api/join-requests/:vkId/block', requirePasswordOk, (req: AuthedRequest, res) => {
    const vkId = Number(req.params.vkId);
    const now = nowIso();
    getDb()
      .prepare(
        `INSERT INTO bot_join_requests (vk_id, status, requested_at, resolved_at, resolved_by)
         VALUES (?, 'blocked', ?, ?, ?)
         ON CONFLICT(vk_id) DO UPDATE SET status = 'blocked', resolved_at = excluded.resolved_at, resolved_by = excluded.resolved_by`,
      )
      .run(vkId, now, now, req.sessionUser!.username);
    res.json({ ok: true });
  });

  router.post('/api/join-requests/:vkId/unblock', requirePasswordOk, (req, res) => {
    getDb().prepare('DELETE FROM bot_join_requests WHERE vk_id = ?').run(Number(req.params.vkId));
    res.json({ ok: true });
  });

  // ======================== CHAT WITH FITTERS & BROADCAST ========================
  const requireChatView = (req: AuthedRequest, res: Response): boolean => {
    if (!hasPerm(req.sessionUser!.permissions, 'chat.view')) {
      res.status(403).json({ detail: 'Нет права: читать чат с монтёрами' });
      return false;
    }
    return true;
  };
  const requireChatBroadcast = (req: AuthedRequest, res: Response): boolean => {
    if (!hasPerm(req.sessionUser!.permissions, 'chat.broadcast')) {
      res.status(403).json({ detail: 'Нет права: массовая рассылка монтёрам' });
      return false;
    }
    return true;
  };

  function hydrateChatMessages(rows: Array<Record<string, unknown>>) {
    if (!rows.length) return [];
    const db = getDb();
    const ids = rows.map((r) => Number(r.id));
    const marks = ids.map(() => '?').join(',');
    const atts = db
      .prepare(`SELECT id, message_id, file_ext, file_name, size, src_id FROM chat_attachments WHERE message_id IN (${marks}) ORDER BY id`)
      .all(...ids) as Array<{ id: number; message_id: number; file_ext: string; file_name: string | null; size: number; src_id: number | null }>;
    const byMsg = new Map<number, unknown[]>();
    for (const a of atts) {
      if (!byMsg.has(a.message_id)) byMsg.set(a.message_id, []);
      byMsg.get(a.message_id)!.push({
        id: a.id,
        file_id: a.src_id || a.id,
        ext: a.file_ext,
        name: a.file_name || `фото.${a.file_ext}`,
        size: a.size,
      });
    }
    return rows.map((r) => ({
      ...r,
      delivered: Boolean(r.delivered_at),
      failed: Boolean(r.failed_at),
      attachments: byMsg.get(Number(r.id)) || [],
    }));
  }

  function photoLabel(text: string, photos: number): string {
    const t = text.trim();
    if (!photos) return t;
    const tag = photos > 1 ? `[📷 ${photos} фото]` : '[📷 фото]';
    return t ? `${tag} ${t}` : tag;
  }

  router.get('/api/chat/conversations', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
    const q = String(req.query.q || '').trim().toLowerCase();
    const includeAll = req.query.all === 'true' || req.query.all === '1';
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.id, p.full_name, p.vk_id, p.role_type, p.phone, p.active,
                m.id as last_id, m.direction as last_direction, m.text as last_text, m.created_at as last_at,
                m.point_id as last_point_id, m.delivered_at, m.failed_at,
                (SELECT count(*) FROM chat_messages u WHERE u.person_id = p.id AND u.direction = 'in' AND u.read_at IS NULL) as unread,
                (SELECT count(*) FROM chat_attachments a WHERE a.message_id = m.id) as photos
         FROM people p
         LEFT JOIN chat_messages m ON m.id = (SELECT max(id) FROM chat_messages WHERE person_id = p.id AND broadcast_id IS NULL)
         WHERE p.vk_id IS NOT NULL AND (m.id IS NOT NULL OR ?)`,
      )
      .all(includeAll ? 1 : 0) as Array<Record<string, unknown>>;

    const items = rows
      .map((r) => {
        const fullName = decryptField(String(r.full_name || ''));
        const phone = decryptField(String(r.phone || ''));
        const dir = String(r.last_direction || '');
        return {
          person_id: Number(r.id),
          full_name: fullName,
          vk_id: Number(r.vk_id),
          role_type: String(r.role_type || ''),
          phone,
          active: Boolean(r.active),
          last_id: r.last_id != null ? Number(r.last_id) : null,
          last_direction: dir || null,
          last_text: photoLabel(String(r.last_text || ''), Number(r.photos || 0)),
          last_at: r.last_at || null,
          last_point_id: String(r.last_point_id || ''),
          last_delivered: dir === 'out' ? Boolean(r.delivered_at) : null,
          last_failed: Boolean(r.failed_at),
          unread: Number(r.unread || 0),
        };
      })
      .filter((it) => !q || it.full_name.toLowerCase().includes(q))
      .sort((a, b) => (a.unread ? 0 : 1) - (b.unread ? 0 : 1) || (b.last_id || 0) - (a.last_id || 0));
    res.json(items);
  });

  router.get('/api/chat/unread', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
    const db = getDb();
    const total = (db.prepare("SELECT count(*) as c FROM chat_messages WHERE direction = 'in' AND read_at IS NULL").get() as { c: number }).c;
    const people = (db.prepare("SELECT count(distinct person_id) as c FROM chat_messages WHERE direction = 'in' AND read_at IS NULL").get() as { c: number }).c;
    const recentRows = db
      .prepare(
        `SELECT m.id, m.person_id, p.full_name, m.text, m.created_at,
                (SELECT count(*) FROM chat_attachments a WHERE a.message_id = m.id) as photos
         FROM chat_messages m JOIN people p ON p.id = m.person_id
         WHERE m.direction = 'in' AND m.read_at IS NULL
         ORDER BY m.id DESC LIMIT 5`,
      )
      .all() as Array<Record<string, unknown>>;
    const recent = recentRows.map((r) => ({
      id: Number(r.id),
      person_id: Number(r.person_id),
      full_name: decryptField(String(r.full_name || '')),
      text: photoLabel(String(r.text || ''), Number(r.photos || 0)),
      created_at: r.created_at,
    }));
    res.json({ total, people, recent, last_id: recent[0]?.id || 0 });
  });

  router.get('/api/chat/files/:attId', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
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
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Content-Type', IMAGE_MIME[att.file_ext] || 'application/octet-stream');
    res.sendFile(path.resolve(filePath));
  });

  // Broadcast routes BEFORE :personId routes!
  router.get('/api/chat/broadcast/people', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatBroadcast(req, res)) return;
    const rawDate = String(req.query.date || '');
    const day = isIsoDate(rawDate) ? rawDate : new Date().toISOString().slice(0, 10);
    const db = getDb();
    const everyone = db
      .prepare('SELECT id, full_name, role_type, phone, vk_id FROM people WHERE active = 1')
      .all() as Array<{ id: number; full_name: string; role_type: string; phone: string | null; vk_id: number | null }>;
    const crews = db.prepare('SELECT id, name FROM crews WHERE date = ? ORDER BY id').all(day) as Array<{
      id: number;
      name: string;
    }>;
    const crewMembers = db
      .prepare(
        `SELECT cm.crew_id, cm.person_id FROM crew_members cm JOIN crews c ON c.id = cm.crew_id WHERE c.date = ?`,
      )
      .all(day) as Array<{ crew_id: number; person_id: number }>;
    const crewOf = new Map<number, number[]>();
    const sizeOf = new Map<number, number>();
    for (const cm of crewMembers) {
      if (!crewOf.has(cm.person_id)) crewOf.set(cm.person_id, []);
      crewOf.get(cm.person_id)!.push(cm.crew_id);
      sizeOf.set(cm.crew_id, (sizeOf.get(cm.crew_id) || 0) + 1);
    }
    const absRows = db
      .prepare('SELECT person_id, reason FROM people_absences WHERE start_date <= ? AND end_date >= ?')
      .all(day, day) as Array<{ person_id: number; reason: string | null }>;
    const absMap = new Map(absRows.map((a) => [a.person_id, a.reason || '']));
    const botRow = db.prepare('SELECT enabled FROM bot_settings WHERE id = 1').get() as { enabled: number } | undefined;

    const people = everyone
      .filter((p) => Boolean(p.vk_id))
      .map((p) => ({
        person_id: p.id,
        full_name: decryptField(p.full_name),
        role_type: p.role_type,
        phone: decryptField(p.phone || ''),
        crew_ids: crewOf.get(p.id) || [],
        absent: absMap.has(p.id),
        absent_reason: absMap.get(p.id) || '',
      }));

    res.json({
      date: day,
      bot_enabled: botRow ? Boolean(botRow.enabled) : true,
      max_recipients: 200,
      max_text: 2000,
      max_photos: 10,
      crews: crews.map((c) => ({ id: c.id, name: c.name || '', size: sizeOf.get(c.id) || 0 })),
      people,
      no_vk: everyone.filter((p) => !p.vk_id).length,
    });
  });

  function getBroadcastSummaryRows(whereClause = '', params: SQLInputValue[] = []) {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT b.id, b.created_at, b.author, b.text, b.mode, b.filter_desc, b.total,
                count(m.id) as present,
                sum(case when m.delivered_at is not null then 1 else 0 end) as delivered,
                sum(case when m.failed_at is not null then 1 else 0 end) as failed,
                (SELECT count(*) FROM chat_attachments a WHERE a.message_id = min(m.id)) as photos
         FROM chat_broadcasts b
         LEFT JOIN chat_messages m ON m.broadcast_id = b.id
         ${whereClause}
         GROUP BY b.id
         ORDER BY b.id DESC LIMIT 30`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    return rows.map((r) => {
      const present = Number(r.present || 0);
      const delivered = Number(r.delivered || 0);
      const failed = Number(r.failed || 0);
      return {
        id: Number(r.id),
        created_at: r.created_at,
        author: r.author || '',
        text: r.text || '',
        mode: r.mode || 'pick',
        filter_desc: r.filter_desc || '',
        total: Number(r.total || 0),
        present,
        delivered,
        failed,
        pending: Math.max(0, present - delivered - failed),
        photos: Number(r.photos || 0),
      };
    });
  }

  router.get('/api/chat/broadcast', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatBroadcast(req, res)) return;
    res.json(getBroadcastSummaryRows());
  });

  router.post('/api/chat/broadcast', requirePasswordOk, chatUpload.array('files', 10), (req: AuthedRequest, res) => {
    if (!requireChatBroadcast(req, res)) return;
    let ids: number[] = [];
    try {
      const parsed = JSON.parse(String(req.body?.person_ids || '[]'));
      if (!Array.isArray(parsed)) throw new Error();
      ids = [...new Set(parsed.map(Number).filter(Number.isFinite))];
    } catch {
      res.status(400).json({ detail: 'Список получателей передан неверно' });
      return;
    }
    if (!ids.length) {
      res.status(400).json({ detail: 'Не выбрано ни одного получателя' });
      return;
    }
    const text = String(req.body?.text || '').replace(/\r\n/g, '\n').trim();
    const files = (req.files as Express.Multer.File[]) || [];
    const checked: Array<{ name: string; ext: string; buf: Buffer }> = [];
    for (const f of files) {
      const ext = sniffImage(f.buffer);
      if (!ext) {
        res.status(400).json({ detail: `Файл «${f.originalname}» не является поддерживаемым изображением` });
        return;
      }
      checked.push({ name: path.basename(f.originalname || 'фото'), ext, buf: f.buffer });
    }
    if (!text && !checked.length) {
      res.status(400).json({ detail: 'Напишите сообщение или приложите фото' });
      return;
    }
    const db = getDb();
    const marks = ids.map(() => '?').join(',');
    const reach = db
      .prepare(`SELECT id FROM people WHERE active = 1 AND vk_id IS NOT NULL AND id IN (${marks})`)
      .all(...ids) as Array<{ id: number }>;
    if (!reach.length) {
      res.status(409).json({ detail: 'Никому из выбранных написать нельзя: они не привязаны к VK или деактивированы' });
      return;
    }
    const token = String(req.body?.token || '').trim().slice(0, 64) || null;
    if (token) {
      const existing = db.prepare('SELECT id FROM chat_broadcasts WHERE token = ?').get(token) as
        | { id: number }
        | undefined;
      if (existing) {
        const botRow = db.prepare('SELECT enabled FROM bot_settings WHERE id = 1').get() as { enabled: number } | undefined;
        res.json({ ...getBroadcastSummaryRows('WHERE b.id = ?', [existing.id])[0], bot_enabled: botRow ? Boolean(botRow.enabled) : true });
        return;
      }
    }
    const now = nowIso();
    const mode = ['all', 'filter', 'pick'].includes(String(req.body?.mode || '')) ? String(req.body.mode) : 'pick';
    const filterDesc = String(req.body?.filter_desc || '').trim();
    const bInfo = db
      .prepare(
        'INSERT INTO chat_broadcasts (created_at, author, text, mode, filter_desc, total, token) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(now, req.sessionUser!.username, text, mode, filterDesc, reach.length, token);
    const bid = Number(bInfo.lastInsertRowid);

    let firstSrcId: number | null = null;
    for (const r of reach) {
      const mInfo = db
        .prepare(
          "INSERT INTO chat_messages (person_id, direction, text, author, broadcast_id, created_at) VALUES (?, 'out', ?, ?, ?, ?)",
        )
        .run(r.id, text, req.sessionUser!.username, bid, now);
      const mid = Number(mInfo.lastInsertRowid);
      for (const f of checked) {
        const srcRef: number | null = firstSrcId;
        const aInfo = db
          .prepare(
            'INSERT INTO chat_attachments (message_id, file_ext, file_name, size, src_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(mid, f.ext, f.name, f.buf.length, srcRef, now);
        const aid: number = Number(aInfo.lastInsertRowid);
        if (firstSrcId === null) {
          fs.mkdirSync(CHAT_FILES_DIR, { recursive: true });
          fs.writeFileSync(path.join(CHAT_FILES_DIR, `${aid}.${f.ext}`), f.buf);
          db.prepare('UPDATE chat_attachments SET src_id = ? WHERE id = ?').run(aid, aid);
          firstSrcId = aid;
        }
      }
    }
    const botRow = db.prepare('SELECT enabled FROM bot_settings WHERE id = 1').get() as { enabled: number } | undefined;
    res.json({
      ...getBroadcastSummaryRows('WHERE b.id = ?', [bid])[0],
      bot_enabled: botRow ? Boolean(botRow.enabled) : true,
    });
  });

  router.get('/api/chat/broadcast/:broadcastId', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatBroadcast(req, res)) return;
    const bid = Number(req.params.broadcastId);
    const rows = getBroadcastSummaryRows('WHERE b.id = ?', [bid]);
    if (!rows.length) {
      res.status(404).json({ detail: 'Рассылка не найдена' });
      return;
    }
    const recipients = getDb()
      .prepare(
        `SELECT p.id as person_id, p.full_name, p.role_type, m.delivered_at, m.failed_at, m.delivery_error, m.attempts
         FROM chat_messages m JOIN people p ON p.id = m.person_id
         WHERE m.broadcast_id = ?`,
      )
      .all(bid) as Array<Record<string, unknown>>;
    res.json({
      ...rows[0],
      recipients: recipients.map((r) => ({
        person_id: Number(r.person_id),
        full_name: decryptField(String(r.full_name || '')),
        role_type: String(r.role_type || ''),
        status: r.delivered_at ? 'delivered' : r.failed_at ? 'failed' : 'pending',
        error: String(r.delivery_error || ''),
        delivered_at: r.delivered_at || null,
        attempts: Number(r.attempts || 0),
      })),
    });
  });

  router.post('/api/chat/broadcast/:broadcastId/retry', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatBroadcast(req, res)) return;
    const bid = Number(req.params.broadcastId);
    const db = getDb();
    if (!db.prepare('SELECT 1 FROM chat_broadcasts WHERE id = ?').get(bid)) {
      res.status(404).json({ detail: 'Рассылка не найдена' });
      return;
    }
    const info = db
      .prepare(
        "UPDATE chat_messages SET failed_at = NULL, attempts = 0, claimed_at = NULL, delivery_error = NULL WHERE broadcast_id = ? AND direction = 'out' AND delivered_at IS NULL AND failed_at IS NOT NULL",
      )
      .run(bid);
    res.json({ requeued: info.changes });
  });

  router.get('/api/chat/:personId/messages', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
    const personId = Number(req.params.personId);
    const afterId = Number(req.query.after_id || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 300)));
    const db = getDb();
    const p = db.prepare('SELECT id, vk_id FROM people WHERE id = ?').get(personId) as
      | { id: number; vk_id: number | null }
      | undefined;
    if (!p || !p.vk_id) {
      res.status(404).json({ detail: 'Человек не найден или не привязан к VK' });
      return;
    }
    const rows = afterId
      ? (db
          .prepare('SELECT * FROM chat_messages WHERE person_id = ? AND id > ? ORDER BY id LIMIT ?')
          .all(personId, afterId, limit) as Array<Record<string, unknown>>)
      : (db
          .prepare('SELECT * FROM (SELECT * FROM chat_messages WHERE person_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id')
          .all(personId, limit) as Array<Record<string, unknown>>);
    res.json(hydrateChatMessages(rows));
  });

  router.post('/api/chat/:personId/read', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
    const personId = Number(req.params.personId);
    const info = getDb()
      .prepare("UPDATE chat_messages SET read_at = ? WHERE person_id = ? AND direction = 'in' AND read_at IS NULL")
      .run(nowIso(), personId);
    res.json({ read: info.changes });
  });

  router.post('/api/chat/:personId/send', requirePasswordOk, (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
    const personId = Number(req.params.personId);
    const db = getDb();
    const p = db.prepare('SELECT id, vk_id, active FROM people WHERE id = ?').get(personId) as
      | { id: number; vk_id: number | null; active: number }
      | undefined;
    if (!p || !p.vk_id) {
      res.status(404).json({ detail: 'Человек не найден или не привязан к VK' });
      return;
    }
    if (!p.active) {
      res.status(409).json({ detail: 'Человек деактивирован — написать ему нельзя' });
      return;
    }
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ detail: 'Напишите сообщение' });
      return;
    }
    const now = nowIso();
    const info = db
      .prepare("INSERT INTO chat_messages (person_id, direction, text, author, created_at) VALUES (?, 'out', ?, ?, ?)")
      .run(personId, text, req.sessionUser!.username, now);
    db.prepare("UPDATE chat_messages SET read_at = ? WHERE person_id = ? AND direction = 'in' AND read_at IS NULL").run(
      now,
      personId,
    );
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<
      string,
      unknown
    >;
    res.json(hydrateChatMessages([msg])[0]);
  });

  router.post('/api/chat/:personId/send-photos', requirePasswordOk, chatUpload.array('files', 10), (req: AuthedRequest, res) => {
    if (!requireChatView(req, res)) return;
    const personId = Number(req.params.personId);
    const db = getDb();
    const p = db.prepare('SELECT id, vk_id, active FROM people WHERE id = ?').get(personId) as
      | { id: number; vk_id: number | null; active: number }
      | undefined;
    if (!p || !p.vk_id) {
      res.status(404).json({ detail: 'Человек не найден или не привязан к VK' });
      return;
    }
    if (!p.active) {
      res.status(409).json({ detail: 'Человек деактивирован — написать ему нельзя' });
      return;
    }
    const files = (req.files as Express.Multer.File[]) || [];
    const text = String(req.body?.text || '').trim();
    const checked: Array<{ name: string; ext: string; buf: Buffer }> = [];
    for (const f of files) {
      const ext = sniffImage(f.buffer);
      if (!ext) {
        res.status(400).json({ detail: `Файл «${f.originalname}» не является поддерживаемым изображением` });
        return;
      }
      checked.push({ name: path.basename(f.originalname || 'фото'), ext, buf: f.buffer });
    }
    if (!text && !checked.length) {
      res.status(400).json({ detail: 'Напишите сообщение или приложите фото' });
      return;
    }
    const now = nowIso();
    const info = db
      .prepare("INSERT INTO chat_messages (person_id, direction, text, author, created_at) VALUES (?, 'out', ?, ?, ?)")
      .run(personId, text, req.sessionUser!.username, now);
    const mid = Number(info.lastInsertRowid);
    fs.mkdirSync(CHAT_FILES_DIR, { recursive: true });
    for (const f of checked) {
      const aInfo = db
        .prepare('INSERT INTO chat_attachments (message_id, file_ext, file_name, size, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(mid, f.ext, f.name, f.buf.length, now);
      const aid = Number(aInfo.lastInsertRowid);
      fs.writeFileSync(path.join(CHAT_FILES_DIR, `${aid}.${f.ext}`), f.buf);
      db.prepare('UPDATE chat_attachments SET src_id = ? WHERE id = ?').run(aid, aid);
    }
    db.prepare("UPDATE chat_messages SET read_at = ? WHERE person_id = ? AND direction = 'in' AND read_at IS NULL").run(
      now,
      personId,
    );
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(mid) as Record<string, unknown>;
    res.json(hydrateChatMessages([msg])[0]);
  });

  // ======================== ACCOUNT CHAT (INTERNAL USERS) ========================
  const ALLOWED_ACCOUNT_EXTS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'pdf', 'txt', 'csv', 'doc', 'docx', 'xls', 'xlsx', 'zip', '7z',
  ]);
  const accountUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 10 } });

  function getAccountMessages(peerId: number, meId: number, afterId = 0, limit = 500) {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT m.id, m.sender_id, m.recipient_id, m.text, m.reply_to, m.created_at, m.edited_at, m.deleted_at,
                s.username as sender, r.username as recipient
         FROM account_messages m
         JOIN users s ON s.id = m.sender_id
         JOIN users r ON r.id = m.recipient_id
         WHERE ((m.sender_id = ? AND m.recipient_id = ?) OR (m.sender_id = ? AND m.recipient_id = ?)) AND m.id > ?
         ORDER BY m.id DESC LIMIT ?`,
      )
      .all(meId, peerId, peerId, meId, afterId, limit)
      .reverse() as Array<Record<string, unknown>>;

    if (!rows.length) return [];
    const ids = rows.map((r) => Number(r.id));
    const marks = ids.map(() => '?').join(',');
    const files = db
      .prepare(
        `SELECT id, message_id, file_name, file_ext, size, deleted_at FROM account_message_files WHERE message_id IN (${marks}) ORDER BY id`,
      )
      .all(...ids) as Array<{ id: number; message_id: number; file_name: string; file_ext: string; size: number; deleted_at: string | null }>;
    const byMsg = new Map<number, unknown[]>();
    for (const f of files) {
      if (!byMsg.has(f.message_id)) byMsg.set(f.message_id, []);
      byMsg.get(f.message_id)!.push({
        id: f.id,
        name: f.file_name,
        ext: f.file_ext,
        size: f.size,
        expired: Boolean(f.deleted_at),
      });
    }
    return rows.map((r) => ({ ...r, files: byMsg.get(Number(r.id)) || [] }));
  }

  router.get('/api/account-chat/users', requirePasswordOk, (req: AuthedRequest, res) => {
    const me = req.sessionUser!;
    const db = getDb();
    const allUsers = db.prepare('SELECT id, username FROM users ORDER BY lower(username)').all() as Array<{
      id: number;
      username: string;
    }>;
    const lastRows = db
      .prepare(
        `SELECT CASE WHEN sender_id = ? THEN recipient_id ELSE sender_id END as peer, max(id) as last_id
         FROM account_messages WHERE sender_id = ? OR recipient_id = ? GROUP BY peer`,
      )
      .all(me.id, me.id, me.id) as Array<{ peer: number; last_id: number }>;
    const lastMap = new Map(lastRows.map((r) => [r.peer, r.last_id]));
    res.json(
      allUsers
        .filter((u) => u.id !== me.id)
        .map((u) => ({ id: u.id, username: u.username, last_id: lastMap.get(u.id) || 0 })),
    );
  });

  router.get('/api/account-chat/files/:fileId', requirePasswordOk, (req: AuthedRequest, res) => {
    const fileId = Number(req.params.fileId);
    const me = req.sessionUser!;
    const row = getDb()
      .prepare(
        `SELECT f.id, f.file_name, f.file_ext, f.deleted_at, m.sender_id, m.recipient_id
         FROM account_message_files f JOIN account_messages m ON m.id = f.message_id WHERE f.id = ?`,
      )
      .get(fileId) as
      | { id: number; file_name: string; file_ext: string; deleted_at: string | null; sender_id: number; recipient_id: number }
      | undefined;
    if (!row || (me.id !== row.sender_id && me.id !== row.recipient_id)) {
      res.status(404).json({ detail: 'Вложение не найдено' });
      return;
    }
    if (row.deleted_at) {
      res.status(410).json({ detail: 'Срок хранения файла истёк (14 дней)' });
      return;
    }
    const fp = path.join(ACCOUNT_CHAT_FILES_DIR, `${fileId}.${row.file_ext}`);
    if (!fs.existsSync(fp)) {
      res.status(404).json({ detail: 'Файл уже удалён' });
      return;
    }
    res.setHeader(
      'Content-Disposition',
      `attachment; filename*=UTF-8''${encodeURIComponent(row.file_name)}`,
    );
    res.setHeader('Cache-Control', 'private, no-store');
    res.sendFile(path.resolve(fp));
  });

  router.put('/api/account-chat/messages/:messageId', requirePasswordOk, (req: AuthedRequest, res) => {
    const id = Number(req.params.messageId);
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ detail: 'Текст не может быть пустым' });
      return;
    }
    const db = getDb();
    const me = req.sessionUser!;
    const info = db
      .prepare('UPDATE account_messages SET text = ?, edited_at = ? WHERE id = ? AND sender_id = ? AND deleted_at IS NULL')
      .run(text.slice(0, 4000), nowIso(), id, me.id);
    if (!info.changes) {
      res.status(404).json({ detail: 'Сообщение нельзя изменить' });
      return;
    }
    const row = db.prepare('SELECT recipient_id FROM account_messages WHERE id = ?').get(id) as { recipient_id: number };
    const found = getAccountMessages(row.recipient_id, me.id, id - 1, 1);
    res.json(found[0] || { id });
  });

  router.delete('/api/account-chat/messages/:messageId', requirePasswordOk, (req: AuthedRequest, res) => {
    const id = Number(req.params.messageId);
    const info = getDb()
      .prepare("UPDATE account_messages SET text = '', deleted_at = ? WHERE id = ? AND sender_id = ? AND deleted_at IS NULL")
      .run(nowIso(), id, req.sessionUser!.id);
    if (!info.changes) {
      res.status(404).json({ detail: 'Сообщение нельзя удалить' });
      return;
    }
    res.json({ deleted: true });
  });

  router.get('/api/account-chat/:peerId/messages', requirePasswordOk, (req: AuthedRequest, res) => {
    const peerId = Number(req.params.peerId);
    const me = req.sessionUser!;
    if (peerId === me.id || !getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(peerId)) {
      res.status(404).json({ detail: 'Учётная запись не найдена' });
      return;
    }
    const afterId = Number(req.query.after_id || 0);
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit || 500)));
    res.json(getAccountMessages(peerId, me.id, afterId, limit));
  });

  const insertAccountMessage = (
    peerId: number,
    text: string,
    replyTo: number | null,
    meId: number,
    files: Express.Multer.File[],
  ) => {
    const db = getDb();
    const cleanText = text.trim().slice(0, 4000);
    const blobs: Array<{ name: string; ext: string; buf: Buffer }> = [];
    for (const f of files) {
      const name = path.basename(f.originalname || 'файл').slice(0, 160);
      const ext = path.extname(name).toLowerCase().replace(/^\./, '');
      if (!ext || !ALLOWED_ACCOUNT_EXTS.has(ext)) {
        return { error: `Формат файла «${name}» не поддерживается`, status: 400 };
      }
      if (!f.buffer.length || f.buffer.length > 8 * 1024 * 1024) {
        return { error: `Файл «${name}» пустой или больше 8 МБ`, status: 400 };
      }
      blobs.push({ name, ext, buf: f.buffer });
    }
    if (!cleanText && !blobs.length) {
      return { error: 'Напишите сообщение или приложите файл', status: 400 };
    }
    if (replyTo) {
      const pair = db
        .prepare('SELECT sender_id, recipient_id FROM account_messages WHERE id = ? AND deleted_at IS NULL')
        .get(replyTo) as { sender_id: number; recipient_id: number } | undefined;
      if (!pair || !((pair.sender_id === meId && pair.recipient_id === peerId) || (pair.sender_id === peerId && pair.recipient_id === meId))) {
        return { error: 'Сообщение для ответа не найдено', status: 400 };
      }
    }
    const now = nowIso();
    const mInfo = db
      .prepare('INSERT INTO account_messages (sender_id, recipient_id, text, reply_to, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(meId, peerId, cleanText, replyTo, now);
    const mid = Number(mInfo.lastInsertRowid);
    if (blobs.length) fs.mkdirSync(ACCOUNT_CHAT_FILES_DIR, { recursive: true });
    for (const b of blobs) {
      const fInfo = db
        .prepare('INSERT INTO account_message_files (message_id, file_name, file_ext, size, created_at) VALUES (?, ?, ?, ?, ?)')
        .run(mid, b.name, b.ext, b.buf.length, now);
      const fid = Number(fInfo.lastInsertRowid);
      fs.writeFileSync(path.join(ACCOUNT_CHAT_FILES_DIR, `${fid}.${b.ext}`), b.buf);
    }
    return { message: getAccountMessages(peerId, meId, mid - 1, 1)[0] };
  };

  router.post('/api/account-chat/:peerId/send', requirePasswordOk, (req: AuthedRequest, res) => {
    const peerId = Number(req.params.peerId);
    const me = req.sessionUser!;
    if (peerId === me.id || !getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(peerId)) {
      res.status(404).json({ detail: 'Учётная запись не найдена' });
      return;
    }
    const r = insertAccountMessage(
      peerId,
      String(req.body?.text || ''),
      req.body?.reply_to ? Number(req.body.reply_to) : null,
      me.id,
      [],
    );
    if (r.error) {
      res.status(r.status || 400).json({ detail: r.error });
      return;
    }
    res.json(r.message);
  });

  router.post('/api/account-chat/:peerId/files', requirePasswordOk, accountUpload.array('files', 10), (req: AuthedRequest, res) => {
    const peerId = Number(req.params.peerId);
    const me = req.sessionUser!;
    if (peerId === me.id || !getDb().prepare('SELECT 1 FROM users WHERE id = ?').get(peerId)) {
      res.status(404).json({ detail: 'Учётная запись не найдена' });
      return;
    }
    const replyTo = req.body?.reply_to ? Number(req.body.reply_to) : null;
    const r = insertAccountMessage(
      peerId,
      String(req.body?.text || ''),
      Number.isFinite(replyTo) ? replyTo : null,
      me.id,
      (req.files as Express.Multer.File[]) || [],
    );
    if (r.error) {
      res.status(r.status || 400).json({ detail: r.error });
      return;
    }
    res.json(r.message);
  });

  // ======================== BOT SETTINGS ========================
  router.get('/api/bot-settings', requirePasswordOk, (_req, res) => {
    const row = getDb().prepare('SELECT enabled FROM bot_settings WHERE id = 1').get() as { enabled: number } | undefined;
    res.json({ enabled: row ? Boolean(row.enabled) : true });
  });

  router.put('/api/bot-settings', requirePasswordOk, (req, res) => {
    const enabled = Boolean(req.body?.enabled);
    getDb()
      .prepare('INSERT INTO bot_settings (id, enabled) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled')
      .run(enabled ? 1 : 0);
    res.json({ enabled });
  });

  // ======================== BOT KEY API (/api/bot/*) ========================
  router.get('/api/bot/enabled', requireBotKey, (_req, res) => {
    const row = getDb().prepare('SELECT enabled FROM bot_settings WHERE id = 1').get() as { enabled: number } | undefined;
    res.json({ enabled: row ? Boolean(row.enabled) : true });
  });

  router.get('/api/bot/me', requireBotKey, (req, res) => {
    const vkId = Number(req.query.vk_id);
    const p = getDb().prepare('SELECT * FROM people WHERE vk_id = ?').get(vkId) as Record<string, unknown> | undefined;
    if (!p) {
      res.status(404).json({ detail: 'Монтёр не найден' });
      return;
    }
    res.json({
      id: p.id,
      full_name: decryptField(String(p.full_name || '')),
      phone: decryptField(String(p.phone || '')),
      role_type: p.role_type,
      vk_id: p.vk_id,
      active: Boolean(p.active),
    });
  });

  router.get('/api/bot/dispatcher-phones', requireBotKey, (_req, res) => {
    const rows = getDb()
      .prepare("SELECT full_name, phone FROM people WHERE role_type = 'operator' AND active = 1")
      .all() as Array<{ full_name: string; phone: string | null }>;
    res.json(
      rows
        .map((r) => ({ full_name: decryptField(r.full_name), phone: decryptField(r.phone || '') }))
        .filter((r) => r.phone),
    );
  });

  router.post('/api/bot/join-requests', requireBotKey, (req, res) => {
    const vkId = Number(req.body?.vk_id);
    const vkName = req.body?.vk_name ? String(req.body.vk_name) : null;
    const db = getDb();
    const existing = db.prepare('SELECT status, requested_at FROM bot_join_requests WHERE vk_id = ?').get(vkId) as
      | { status: string; requested_at: string }
      | undefined;
    if (existing?.status === 'blocked') {
      res.json({ status: 'blocked', cooldown_active: false });
      return;
    }
    const now = nowIso();
    db.prepare(
      `INSERT INTO bot_join_requests (vk_id, vk_name, status, requested_at)
       VALUES (?, ?, 'pending', ?)
       ON CONFLICT(vk_id) DO UPDATE SET vk_name = excluded.vk_name, status = 'pending', requested_at = excluded.requested_at, resolved_at = NULL, resolved_by = NULL`,
    ).run(vkId, vkName, now);
    res.json({ status: 'pending', cooldown_active: false });
  });

  router.post('/api/bot/work-sessions', requireBotKey, (req, res) => {
    const { task_id, point_id, vk_id } = req.body || {};
    const db = getDb();
    const person = db.prepare('SELECT id FROM people WHERE vk_id = ?').get(Number(vk_id)) as { id: number } | undefined;
    if (!person) {
      res.status(404).json({ detail: 'Человек не найден' });
      return;
    }
    const now = nowIso();
    db.prepare('UPDATE bot_work_sessions SET ended_at = ? WHERE person_id = ? AND ended_at IS NULL AND task_id != ?').run(
      now,
      person.id,
      String(task_id),
    );
    const open = db
      .prepare('SELECT * FROM bot_work_sessions WHERE task_id = ? AND person_id = ? AND ended_at IS NULL ORDER BY id DESC LIMIT 1')
      .get(String(task_id), person.id) as Record<string, unknown> | undefined;
    if (open) {
      res.json({ ...open, resumed: true });
      return;
    }
    const info = db
      .prepare('INSERT INTO bot_work_sessions (task_id, point_id, person_id, started_at) VALUES (?, ?, ?, ?)')
      .run(String(task_id), String(point_id), person.id, now);
    const created = db.prepare('SELECT * FROM bot_work_sessions WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<
      string,
      unknown
    >;
    res.json({ ...created, resumed: false });
  });

  router.put('/api/bot/work-sessions/:sessionId/end', requireBotKey, (req, res) => {
    const sessionId = Number(req.params.sessionId);
    const db = getDb();
    db.prepare('UPDATE bot_work_sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL').run(nowIso(), sessionId);
    res.json(db.prepare('SELECT * FROM bot_work_sessions WHERE id = ?').get(sessionId) || { ok: true });
  });

  router.post('/api/bot/chat/send', requireBotKey, (req, res) => {
    const vkId = Number(req.body?.vk_id);
    const text = String(req.body?.text || '').trim();
    if (!text) {
      res.status(400).json({ detail: 'Пустое сообщение' });
      return;
    }
    const db = getDb();
    const person = db.prepare('SELECT id, active FROM people WHERE vk_id = ?').get(vkId) as
      | { id: number; active: number }
      | undefined;
    if (!person || !person.active) {
      res.status(404).json({ detail: 'Не найден или неактивен' });
      return;
    }
    const info = db
      .prepare("INSERT INTO chat_messages (person_id, direction, text, point_id, task_id, created_at) VALUES (?, 'in', ?, ?, ?, ?)")
      .run(person.id, text, req.body?.point_id || null, req.body?.task_id || null, nowIso());
    res.json({ id: Number(info.lastInsertRowid) });
  });

  router.post('/api/bot/chat/claim', requireBotKey, (_req, res) => {
    const db = getDb();
    const now = nowIso();
    const rows = db
      .prepare(
        `SELECT m.id, m.person_id, p.vk_id, p.full_name, m.text, m.author, m.created_at, m.broadcast_id
         FROM chat_messages m JOIN people p ON p.id = m.person_id
         WHERE m.direction = 'out' AND m.delivered_at IS NULL AND m.failed_at IS NULL
           AND (m.claimed_at IS NULL)
         ORDER BY m.id LIMIT 20`,
      )
      .all() as Array<Record<string, unknown>>;
    const attStmt = db.prepare('SELECT id, file_ext, file_name, size FROM chat_attachments WHERE message_id = ? ORDER BY id');
    for (const r of rows) {
      db.prepare('UPDATE chat_messages SET claimed_at = ? WHERE id = ?').run(now, Number(r.id));
    }
    res.json(
      rows.map((r) => {
        const attachments = attStmt.all(Number(r.id)) as Array<Record<string, unknown>>;
        return {
          ...r,
          full_name: decryptField(String(r.full_name || '')),
          broadcast: Boolean(r.broadcast_id),
          attachments,
        };
      }),
    );
  });

  router.post('/api/bot/chat/delivered', requireBotKey, (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const db = getDb();
    const now = nowIso();
    for (const id of ids) {
      db.prepare('UPDATE chat_messages SET delivered_at = ?, claimed_at = NULL WHERE id = ?').run(now, id);
    }
    res.json({ ok: true });
  });

  router.post('/api/bot/chat/failed', requireBotKey, (req, res) => {
    const id = Number(req.body?.id);
    const error = String(req.body?.error || '');
    getDb()
      .prepare(
        'UPDATE chat_messages SET failed_at = ?, delivery_error = ?, attempts = attempts + 1, claimed_at = NULL WHERE id = ?',
      )
      .run(nowIso(), error, id);
    res.json({ ok: true });
  });

  router.post('/api/bot/chat/release', requireBotKey, (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const db = getDb();
    for (const id of ids) {
      db.prepare('UPDATE chat_messages SET claimed_at = NULL WHERE id = ?').run(id);
    }
    res.json({ ok: true });
  });

  router.get('/api/bot/ai/config', requireBotKey, (_req, res) => {
    const row = getDb().prepare("SELECT value FROM app_flags WHERE key = 'ai_config'").get() as
      | { value: string }
      | undefined;
    let cfg: Record<string, unknown> = { bot_voice: false, assistant: true, forms_fault: false };
    if (row) {
      try {
        cfg = { ...cfg, ...JSON.parse(row.value) };
      } catch {
        // ignore
      }
    }
    const aiReady = Boolean((process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim());
    res.json({ bot_voice: Boolean(cfg.bot_voice), asr_ready: aiReady, llm_ready: aiReady });
  });

  return router;
}
