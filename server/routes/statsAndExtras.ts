import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Request, Response } from 'express';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import { Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import {
  clientIp,
  recordSecurityEvent,
  requirePasswordOk,
  requirePerm,
  type AuthedRequest,
} from '../auth.ts';
import { AI_FILES_DIR, DATA_DIR, settings } from '../config.ts';
import { getDb, nowIso } from '../db.ts';
import { hasAnyPerm, hasPerm, networkOk, secretsOk } from '../permissions.ts';
import { callRobot, RobotRejectedError, RobotUnavailableError } from '../services/yandexRobotClient.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

function getAiClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

function safeCell(val: unknown): string {
  const s = val == null ? '' : String(val);
  if (s && /^[=+\-@]/.test(s)) return `'${s}`;
  return s;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function formatDateRu(iso: string): string {
  const m = String(iso || '').slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
}

function parseJsonSafe<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------
// 1. STATS (/api/stats)
// ---------------------------------------------------------------------------

const RESULT_STATUSES = ['Работает', 'Демонтирован', 'Установлен', 'Не работает'] as const;
const POWER_SOURCES = ['220В', 'Солнечная батарея', 'АКБ', 'Другое'];

function dateBounds(dateFrom: string, dateTo: string): [string, string] {
  return [`${dateFrom}T00:00:00`, `${dateTo}T23:59:59.999999Z`];
}

function workTypeNames(): string[] {
  const db = getDb();
  const rows = db
    .prepare('SELECT name FROM work_types ORDER BY sort_order, name')
    .all() as Array<{ name: string }>;
  return rows.map((r) => r.name);
}

function currentlyDownSince(): Array<[string, string]> {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT p.id,
              (SELECT max(h.changed_at) FROM point_status_history h
               WHERE h.point_id = p.id AND h.new_status = p.status) AS since
       FROM points p
       WHERE p.status = 'Не работает'`,
    )
    .all() as Array<{ id: string; since: string | null }>;
  return rows.filter((r): r is { id: string; since: string } => Boolean(r.since)).map((r) => [r.id, r.since]);
}

function inRangeDown(down: Array<[string, string]>, dateFrom: string, dateTo: string): Array<[string, string]> {
  const [frm, to] = dateBounds(dateFrom, dateTo);
  return down.filter(([, since]) => since >= frm && since <= to);
}

function computeStatsSummary(dateFrom: string, dateTo: string) {
  const db = getDb();
  const [frm, to] = dateBounds(dateFrom, dateTo);
  const downAll = currentlyDownSince();

  // visit_types
  const vtRows = db
    .prepare(
      `SELECT visit_type, COUNT(*) AS cnt FROM task_visit_reports
       WHERE created_at >= ? AND created_at <= ? GROUP BY visit_type`,
    )
    .all(frm, to) as Array<{ visit_type: string; cnt: number }>;
  const vtCounts = new Map<string, number>();
  for (const r of vtRows) vtCounts.set(r.visit_type, r.cnt);
  const knownTypes = workTypeNames();
  const visit_types = [
    ...knownTypes.map((t) => ({ visit_type: t, count: vtCounts.get(t) ?? 0 })),
    ...Array.from(vtCounts.entries())
      .filter(([t]) => t && !knownTypes.includes(t))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([t, count]) => ({ visit_type: t, count })),
  ];

  // result_statuses
  const rsRows = db
    .prepare(
      `SELECT result_status, COUNT(*) AS cnt FROM task_visit_reports
       WHERE created_at >= ? AND created_at <= ? GROUP BY result_status`,
    )
    .all(frm, to) as Array<{ result_status: string; cnt: number }>;
  const rsCounts = new Map<string, number>();
  for (const r of rsRows) rsCounts.set(r.result_status, r.cnt);
  const result_statuses = RESULT_STATUSES.map((s) => ({
    result_status: s,
    count: rsCounts.get(s) ?? 0,
  }));

  // outcomes
  const outcomes = db
    .prepare(
      `SELECT visit_type, outcome, COUNT(*) AS count FROM task_visit_reports
       WHERE outcome != '' AND created_at >= ? AND created_at <= ?
       GROUP BY visit_type, outcome ORDER BY visit_type, count DESC, outcome`,
    )
    .all(frm, to) as Array<{ visit_type: string; outcome: string; count: number }>;

  // current_status
  const current_status = db
    .prepare(
      `SELECT CASE WHEN status = '' THEN 'Не известно' ELSE status END AS status, COUNT(*) AS count
       FROM points GROUP BY status ORDER BY count DESC`,
    )
    .all() as Array<{ status: string; count: number }>;

  // transitions
  const downToday = inRangeDown(downAll, dateTo, dateTo);
  const recRow = db
    .prepare(
      `WITH recovered_events AS (
         SELECT h.point_id, h.changed_at,
                (SELECT max(h2.changed_at) FROM point_status_history h2
                 WHERE h2.point_id = h.point_id AND h2.new_status = 'Не работает'
                   AND h2.changed_at <= h.changed_at) AS down_since
         FROM point_status_history h
         WHERE h.new_status = 'Работает' AND h.old_status = 'Не работает'
           AND h.changed_at >= ? AND h.changed_at <= ?
       )
       SELECT COUNT(*) AS cnt FROM recovered_events e
       WHERE e.down_since IS NOT NULL
         AND (
           julianday(e.changed_at) - julianday(e.down_since) >= 2
           OR EXISTS (
             SELECT 1 FROM tasks t
             WHERE t.point = e.point_id AND t.type = 'Ремонт'
               AND t.date >= substr(e.down_since, 1, 10)
               AND t.date <= substr(e.changed_at, 1, 10)
           )
         )`,
    )
    .get(frm, to) as { cnt: number } | undefined;

  const transitions = {
    went_down: downToday.length,
    recovered: recRow?.cnt ?? 0,
  };

  // daily_failures
  const downInRange = inRangeDown(downAll, dateFrom, dateTo);
  const dayCounts = new Map<string, number>();
  for (const [, since] of downInRange) {
    const d = since.slice(0, 10);
    dayCounts.set(d, (dayCounts.get(d) ?? 0) + 1);
  }
  const daily_failures = Array.from(dayCounts.entries())
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, count]) => ({ date, count }));

  // category_matrix
  const category_matrix = db
    .prepare(
      `SELECT COALESCE(pc.name, 'Без категории') AS category,
              CASE WHEN p.status = '' THEN 'Не известно' ELSE p.status END AS status,
              COUNT(*) AS count
       FROM points p
       LEFT JOIN point_categories pc ON pc.id = p.category_id
       GROUP BY category, status
       ORDER BY category, status`,
    )
    .all() as Array<{ category: string; status: string; count: number }>;

  return {
    visit_types,
    result_statuses,
    outcomes,
    current_status,
    transitions,
    daily_failures,
    category_matrix,
  };
}

async function buildStatusExportBuffer(): Promise<Buffer> {
  const db = getDb();
  const matrix = db
    .prepare(
      `SELECT COALESCE(pc.name, 'Без категории') AS category,
              CASE WHEN p.status = '' THEN 'Не известно' ELSE p.status END AS status,
              COUNT(*) AS count
       FROM points p
       LEFT JOIN point_categories pc ON pc.id = p.category_id
       GROUP BY category, status
       ORDER BY category, status`,
    )
    .all() as Array<{ category: string; status: string; count: number }>;

  const detail = db
    .prepare(
      `SELECT p.id AS point_id,
              CASE WHEN p.status = '' THEN 'Не известно' ELSE p.status END AS status,
              p.port_down_since, p.ip_address, p.address,
              COALESCE(pc.name, 'Без категории') AS category
       FROM points p
       LEFT JOIN point_categories pc ON pc.id = p.category_id
       ORDER BY p.id`,
    )
    .all() as Array<{
      point_id: string;
      status: string;
      port_down_since: string | null;
      ip_address: string | null;
      address: string | null;
      category: string;
    }>;

  const categories = Array.from(new Set(matrix.map((r) => r.category)));
  const statuses = Array.from(new Set(matrix.map((r) => r.status)));
  const countMap = new Map<string, number>();
  for (const r of matrix) countMap.set(`${r.category}\0${r.status}`, r.count);

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Сводка');
  const headers = ['Категория', ...statuses, 'Итого'];
  ws.addRow(headers);
  const headRow = ws.getRow(1);
  headRow.eachCell((cell, colNumber) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE6F7' } };
    cell.font = { bold: true };
    cell.alignment = {
      horizontal: colNumber === 1 ? 'left' : 'center',
      vertical: 'middle',
      wrapText: true,
    };
  });

  const colTotals = new Array<number>(statuses.length).fill(0);
  for (const cat of categories) {
    const rowCounts = statuses.map((s) => countMap.get(`${cat}\0${s}`) ?? 0);
    rowCounts.forEach((n, idx) => {
      colTotals[idx] += n;
    });
    const sum = rowCounts.reduce((a, b) => a + b, 0);
    const added = ws.addRow([cat, ...rowCounts.map((n) => (n > 0 ? n : null)), sum]);
    added.eachCell((cell, colNumber) => {
      if (colNumber >= 2) cell.alignment = { horizontal: 'center' };
    });
  }
  const totalSum = colTotals.reduce((a, b) => a + b, 0);
  const totalRow = ws.addRow(['Итого', ...colTotals, totalSum]);
  totalRow.eachCell((cell, colNumber) => {
    cell.font = { bold: true };
    if (colNumber >= 2) cell.alignment = { horizontal: 'center' };
  });
  ws.getColumn(1).width = 30;
  for (let i = 2; i <= headers.length; i += 1) ws.getColumn(i).width = 18;
  ws.views = [{ state: 'frozen', xSplit: 1, ySplit: 1 }];

  const ws2 = wb.addWorksheet('Детально');
  const headers2 = ['Номер комплекса', 'Статус', 'Сколько дней не работает', 'IP', 'Адрес', 'Категория'];
  ws2.addRow(headers2);
  ws2.getRow(1).eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE6F7' } };
    cell.font = { bold: true };
    cell.alignment = { vertical: 'middle', wrapText: true };
  });

  const nowMs = Date.now();
  const statusOrder: Record<string, number> = {
    'Не работает': 0,
    'Есть только пинг': 1,
    'Работает': 3,
  };
  const detailRows = detail.map((d) => {
    let downDays: number | '' = '';
    if (d.port_down_since && d.status !== 'Работает') {
      const t = Date.parse(d.port_down_since);
      if (!Number.isNaN(t)) downDays = Math.max(0, Math.floor((nowMs - t) / 86400000));
    }
    return {
      point_id: d.point_id,
      status: d.status,
      days: downDays,
      ip: d.ip_address || '',
      address: d.address || '',
      category: d.category,
    };
  });
  detailRows.sort((a, b) => {
    const oa = statusOrder[a.status] ?? 2;
    const ob = statusOrder[b.status] ?? 2;
    if (oa !== ob) return oa - ob;
    const hasA = a.days !== '' ? 0 : 1;
    const hasB = b.days !== '' ? 0 : 1;
    if (hasA !== hasB) return hasA - hasB;
    if (a.days !== '' && b.days !== '' && a.days !== b.days) return Number(b.days) - Number(a.days);
    return a.point_id.toLowerCase().localeCompare(b.point_id.toLowerCase());
  });
  for (const r of detailRows) {
    ws2.addRow([safeCell(r.point_id), safeCell(r.status), r.days, safeCell(r.ip), safeCell(r.address), safeCell(r.category)]);
  }
  [22, 20, 24, 18, 46, 22].forEach((w, idx) => {
    ws2.getColumn(idx + 1).width = w;
  });
  ws2.views = [{ state: 'frozen', ySplit: 1 }];

  const arr = await wb.xlsx.writeBuffer();
  return Buffer.from(arr);
}

// ---------------------------------------------------------------------------
// 2. STAT COUNTERS (/api/stat-counters)
// ---------------------------------------------------------------------------

const MAX_COUNTERS = 100;
const LIST_MAX = 60;
const ITEM_MAX = 80;
const TEXT_MAX = 120;
const LIST_LIMIT = 5000;
const UNKNOWN_STATUS = 'Не известно';
const NO_CATEGORY = 'Без категории';
const NO_POWER = 'Не указано';

const COUNT_WHAT = new Set(['points', 'visits', 'changes']);
const PERIOD_KINDS = new Set(['all', 'today', 'days', 'month', 'prev_month', 'year', 'range']);
const VERIFICATION_KINDS = new Set(['', 'valid', 'expired', 'none', 'soon']);
const TRI_KINDS = new Set(['', 'yes', 'no']);
const EVENT_MODE_KINDS = new Set(['', 'had', 'none']);
const GROUP_BY_KINDS = new Set(['', 'category', 'status', 'power', 'verification']);

interface CounterFilters {
  count: string;
  period: { kind: string; days: number; from: string; to: string };
  categories: string[];
  statuses: string[];
  power: string[];
  verification: string;
  verification_days: number;
  sim: string;
  ip: string;
  fault: string;
  groups: number[];
  text: string;
  days_in_status: number | null;
  visits: string;
  visit_types: string[];
  visit_results: string[];
  visits_min: number | null;
  changes: string;
  change_to: string[];
  change_from: string[];
  group_by: string;
}

class CounterError extends Error {}

function normalizeCounterFilters(rawInput: unknown): CounterFilters {
  const raw = (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput) ? rawInput : {}) as Record<string, unknown>;
  if (rawInput != null && (typeof rawInput !== 'object' || Array.isArray(rawInput))) {
    throw new CounterError('Набор условий должен быть объектом');
  }
  const enumVal = (key: string, allowed: Set<string>, def: string, label: string): string => {
    const v = raw[key] == null ? def : String(raw[key]);
    if (!allowed.has(v)) throw new CounterError(`Неизвестное значение условия «${label}»`);
    return v;
  };
  const intVal = (obj: Record<string, unknown>, key: string, label: string, lo: number, hi: number, def: number | null): number | null => {
    const val = obj[key];
    if (val === undefined || val === null || val === '') return def;
    const n = Number(val);
    if (!Number.isInteger(n)) throw new CounterError(`Условие «${label}»: нужно целое число`);
    if (n < lo || n > hi) throw new CounterError(`Условие «${label}»: число от ${lo} до ${hi}`);
    return n;
  };
  const strList = (key: string, label: string): string[] => {
    const v = raw[key] ?? [];
    if (!Array.isArray(v)) throw new CounterError(`Условие «${label}» должно быть списком`);
    const out: string[] = [];
    for (const item of v) {
      const t = String(item ?? '').trim().replace(/\s+/g, ' ').slice(0, ITEM_MAX);
      if (t && !out.includes(t)) out.push(t);
    }
    if (out.length > LIST_MAX) throw new CounterError(`В условии «${label}» слишком много значений (не больше ${LIST_MAX})`);
    return out;
  };
  const isoDateCheck = (val: unknown, label: string): string => {
    const s = String(val ?? '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(`${s}T00:00:00Z`))) {
      throw new CounterError(`${label}: укажите дату`);
    }
    return s;
  };

  const groupsRaw = raw.groups ?? [];
  if (!Array.isArray(groupsRaw)) throw new CounterError('Условие «Подгруппы» должно быть списком');
  const groups: number[] = [];
  for (const g of groupsRaw) {
    const id = Number(g);
    if (!Number.isInteger(id)) throw new CounterError('Подгруппа указана неверно');
    if (!groups.includes(id)) groups.push(id);
  }
  if (groups.length > LIST_MAX) throw new CounterError('Выбрано слишком много подгрупп');

  const pRaw = (raw.period ?? {}) as Record<string, unknown>;
  if (typeof pRaw !== 'object' || Array.isArray(pRaw)) throw new CounterError('Период указан неверно');
  const pKind = String(pRaw.kind || 'all');
  if (!PERIOD_KINDS.has(pKind)) throw new CounterError('Неизвестный период');
  const period = {
    kind: pKind,
    days: intVal(pRaw, 'days', 'Период: дней', 1, 3650, 30) ?? 30,
    from: '',
    to: '',
  };
  if (pKind === 'range') {
    period.from = isoDateCheck(pRaw.from, 'Период: начало');
    period.to = isoDateCheck(pRaw.to, 'Период: конец');
    if (period.from > period.to) throw new CounterError('Период: начальная дата позже конечной');
  }

  return {
    count: enumVal('count', COUNT_WHAT, 'points', 'Что считаем') || 'points',
    verification: enumVal('verification', VERIFICATION_KINDS, '', 'Поверка'),
    sim: enumVal('sim', TRI_KINDS, '', 'SIM'),
    ip: enumVal('ip', TRI_KINDS, '', 'IP-адрес'),
    fault: enumVal('fault', TRI_KINDS, '', 'Причина неисправности'),
    visits: enumVal('visits', EVENT_MODE_KINDS, '', 'Выезды'),
    changes: enumVal('changes', EVENT_MODE_KINDS, '', 'Смены статуса'),
    group_by: enumVal('group_by', GROUP_BY_KINDS, '', 'Разбивка'),
    verification_days: intVal(raw, 'verification_days', 'Поверка: дней', 1, 3650, 30) ?? 30,
    days_in_status: intVal(raw, 'days_in_status', 'Дней в текущем статусе', 1, 3650, null),
    visits_min: intVal(raw, 'visits_min', 'Выездов не менее', 1, 1000, null),
    text: String(raw.text ?? '').trim().replace(/\s+/g, ' ').slice(0, TEXT_MAX),
    categories: strList('categories', 'Категории'),
    statuses: strList('statuses', 'Статус сейчас'),
    power: strList('power', 'Питание'),
    visit_types: strList('visit_types', 'Типы выездов'),
    visit_results: strList('visit_results', 'Итог выезда'),
    change_to: strList('change_to', 'Перешёл в статус'),
    change_from: strList('change_from', 'Перешёл из статуса'),
    groups,
    period,
  };
}

function effectiveModes(f: CounterFilters): [string, string] {
  const visits = f.visits || (f.visit_types.length || f.visit_results.length || f.count === 'visits' ? 'had' : '');
  const changes = f.changes || (f.change_to.length || f.change_from.length || f.count === 'changes' ? 'had' : '');
  return [visits, changes];
}

function periodBounds(period: CounterFilters['period'], today: string): [string, string] | null {
  switch (period.kind) {
    case 'all':
      return null;
    case 'today':
      return [today, today];
    case 'days':
      return [addDaysIso(today, -(Math.max(1, period.days || 30) - 1)), today];
    case 'month':
      return [`${today.slice(0, 8)}01`, today];
    case 'prev_month': {
      const firstThis = new Date(`${today.slice(0, 8)}01T00:00:00Z`);
      firstThis.setUTCDate(firstThis.getUTCDate() - 1);
      const lastPrev = firstThis.toISOString().slice(0, 10);
      return [`${lastPrev.slice(0, 8)}01`, lastPrev];
    }
    case 'year':
      return [`${today.slice(0, 4)}-01-01`, today];
    case 'range':
      return [period.from, period.to];
    default:
      return null;
  }
}

function describeCounter(f: CounterFilters, groupNames: Map<number, string>): string[] {
  const lines: string[] = [];
  const countLabel: Record<string, string> = {
    points: 'Считаем: комплексы',
    visits: 'Считаем: выезды',
    changes: 'Считаем: смены статуса',
  };
  lines.push(countLabel[f.count] || 'Считаем: комплексы');

  const today = todayIso();
  const bounds = periodBounds(f.period, today);
  if (bounds) {
    lines.push(`Период: ${formatDateRu(bounds[0])} — ${formatDateRu(bounds[1])}`);
  } else if (f.period.kind === 'all') {
    lines.push('Период: за всё время');
  }
  if (f.categories.length) lines.push(`Категории: ${f.categories.join(', ')}`);
  if (f.statuses.length) lines.push(`Статус: ${f.statuses.join(', ')}`);
  if (f.power.length) lines.push(`Питание: ${f.power.join(', ')}`);
  if (f.verification) {
    const vMap: Record<string, string> = {
      valid: 'действует',
      expired: 'просрочена',
      none: 'нет данных',
      soon: `истекает в ближайшие ${f.verification_days} дн.`,
    };
    lines.push(`Поверка: ${vMap[f.verification] || f.verification}`);
  }
  if (f.sim) lines.push(`SIM-карта: ${f.sim === 'yes' ? 'есть' : 'нет'}`);
  if (f.ip) lines.push(`IP-адрес: ${f.ip === 'yes' ? 'есть' : 'нет'}`);
  if (f.fault) lines.push(`Причина неисправности: ${f.fault === 'yes' ? 'указана' : 'не указана'}`);
  if (f.groups.length) {
    lines.push(`Подгруппы: ${f.groups.map((id) => groupNames.get(id) || `#${id}`).join(', ')}`);
  }
  if (f.text) lines.push(`Поиск: «${f.text}»`);
  if (f.days_in_status) lines.push(`В текущем статусе не менее ${f.days_in_status} дн.`);
  const [vm, cm] = effectiveModes(f);
  if (vm === 'had') {
    const parts = ['были выезды'];
    if (f.visits_min) parts.push(`не менее ${f.visits_min}`);
    if (f.visit_types.length) parts.push(`типы: ${f.visit_types.join(', ')}`);
    if (f.visit_results.length) parts.push(`итог: ${f.visit_results.join(', ')}`);
    lines.push(`Выезды: ${parts.join('; ')}`);
  } else if (vm === 'none') {
    lines.push('Выезды: не было');
  }
  if (cm === 'had') {
    const parts = ['были смены статуса'];
    if (f.change_from.length) parts.push(`из: ${f.change_from.join(', ')}`);
    if (f.change_to.length) parts.push(`в: ${f.change_to.join(', ')}`);
    lines.push(`Смены статуса: ${parts.join('; ')}`);
  } else if (cm === 'none') {
    lines.push('Смены статуса: не было');
  }
  if (f.group_by) {
    const gMap: Record<string, string> = {
      category: 'по категориям',
      status: 'по статусам',
      power: 'по питанию',
      verification: 'по поверке',
    };
    lines.push(`Разбивка: ${gMap[f.group_by] || f.group_by}`);
  }
  return lines;
}

function strictKey(s: string): string {
  return s.toLowerCase().replace(/[^a-zа-яё0-9]/gi, '');
}

interface CounterPoint {
  id: string;
  address: string;
  description: string;
  status: string;
  verify: string;
  verify_state: 'valid' | 'expired' | 'none';
  verify_left: number | null;
  power: string;
  sim: boolean;
  ip: boolean;
  fault: boolean;
  category: string;
}

class CounterDataset {
  today: string;
  points: CounterPoint[] = [];
  private cache = new Map<string, unknown>();

  constructor(today: string) {
    this.today = today;
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.id, p.address, p.description, p.status, p.verification_valid_until,
                p.power_source, p.sim_number, p.ip_address, p.fault_reason,
                COALESCE(pc.name, '') AS category
         FROM points p
         LEFT JOIN point_categories pc ON pc.id = p.category_id
         ORDER BY p.id`,
      )
      .all() as Array<{
        id: string;
        address: string | null;
        description: string | null;
        status: string | null;
        verification_valid_until: string | null;
        power_source: string | null;
        sim_number: string | null;
        ip_address: string | null;
        fault_reason: string | null;
        category: string;
      }>;

    const todayMs = Date.parse(`${today}T00:00:00Z`);
    for (const r of rows) {
      const verify = (r.verification_valid_until || '').trim();
      let verify_state: 'valid' | 'expired' | 'none' = 'none';
      let verify_left: number | null = null;
      if (verify && /^\d{4}-\d{2}-\d{2}/.test(verify)) {
        const ms = Date.parse(`${verify.slice(0, 10)}T00:00:00Z`);
        if (!Number.isNaN(ms)) {
          verify_left = Math.round((ms - todayMs) / 86400000);
          verify_state = verify_left >= 0 ? 'valid' : 'expired';
        }
      }
      this.points.push({
        id: r.id,
        address: r.address || '',
        description: r.description || '',
        status: (r.status || '').trim() || UNKNOWN_STATUS,
        verify,
        verify_state,
        verify_left,
        power: (r.power_source || '').trim() || NO_POWER,
        sim: Boolean((r.sim_number || '').trim()),
        ip: Boolean((r.ip_address || '').trim()),
        fault: Boolean((r.fault_reason || '').trim()),
        category: r.category || NO_CATEGORY,
      });
    }
  }

  visits(bounds: [string, string] | null, types: string[], results: string[]): Map<string, number> {
    const key = `v:${JSON.stringify([bounds, types, results])}`;
    if (this.cache.has(key)) return this.cache.get(key) as Map<string, number>;
    const db = getDb();
    let sql = 'SELECT point_id, visit_type, COUNT(*) AS cnt FROM task_visit_reports WHERE 1 = 1';
    const params: Array<string> = [];
    if (bounds) {
      sql += ' AND created_at >= ? AND created_at <= ?';
      params.push(`${bounds[0]}T00:00:00`, `${bounds[1]}T23:59:59.999999Z`);
    }
    if (results.length) {
      sql += ` AND result_status IN (${results.map(() => '?').join(',')})`;
      params.push(...results);
    }
    sql += ' GROUP BY point_id, visit_type';
    const rows = db.prepare(sql).all(...params) as Array<{ point_id: string; visit_type: string; cnt: number }>;
    const typeSet = new Set(types);
    const out = new Map<string, number>();
    for (const r of rows) {
      if (typeSet.size > 0) {
        const parts = (r.visit_type || '').split(' + ').map((s) => s.trim());
        if (!parts.some((p) => typeSet.has(p))) continue;
      }
      out.set(r.point_id, (out.get(r.point_id) ?? 0) + r.cnt);
    }
    this.cache.set(key, out);
    return out;
  }

  changes(bounds: [string, string] | null, to: string[], frm: string[]): Map<string, number> {
    const key = `c:${JSON.stringify([bounds, to, frm])}`;
    if (this.cache.has(key)) return this.cache.get(key) as Map<string, number>;
    const db = getDb();
    let sql = 'SELECT point_id, COUNT(*) AS cnt FROM point_status_history WHERE old_status != new_status';
    const params: Array<string> = [];
    if (bounds) {
      sql += ' AND changed_at >= ? AND changed_at <= ?';
      params.push(`${bounds[0]}T00:00:00`, `${bounds[1]}T23:59:59.999999Z`);
    }
    if (to.length) {
      sql += ` AND new_status IN (${to.map(() => '?').join(',')})`;
      params.push(...to.map((v) => (v === UNKNOWN_STATUS ? '' : v)));
    }
    if (frm.length) {
      sql += ` AND old_status IN (${frm.map(() => '?').join(',')})`;
      params.push(...frm.map((v) => (v === UNKNOWN_STATUS ? '' : v)));
    }
    sql += ' GROUP BY point_id';
    const rows = db.prepare(sql).all(...params) as Array<{ point_id: string; cnt: number }>;
    const out = new Map<string, number>();
    for (const r of rows) out.set(r.point_id, r.cnt);
    this.cache.set(key, out);
    return out;
  }

  statusSince(): Map<string, string> {
    if (this.cache.has('since')) return this.cache.get('since') as Map<string, string>;
    const db = getDb();
    const rows = db
      .prepare('SELECT point_id, new_status, MAX(changed_at) AS at FROM point_status_history GROUP BY point_id, new_status')
      .all() as Array<{ point_id: string; new_status: string | null; at: string }>;
    const latest = new Map<string, string>();
    for (const r of rows) {
      const st = (r.new_status || '').trim() || UNKNOWN_STATUS;
      latest.set(`${r.point_id}\0${st}`, r.at);
    }
    const out = new Map<string, string>();
    for (const p of this.points) {
      const at = latest.get(`${p.id}\0${p.status}`);
      if (at) out.set(p.id, at);
    }
    this.cache.set('since', out);
    return out;
  }

  members(groupIds: number[]): Set<string> {
    const key = `m:${groupIds.join(',')}`;
    if (this.cache.has(key)) return this.cache.get(key) as Set<string>;
    const db = getDb();
    const rows = db
      .prepare(`SELECT DISTINCT point_id FROM apk_group_points WHERE group_id IN (${groupIds.map(() => '?').join(',')})`)
      .all(...groupIds) as Array<{ point_id: string }>;
    const out = new Set(rows.map((r) => r.point_id));
    this.cache.set(key, out);
    return out;
  }
}

function evaluateCounter(f: CounterFilters, data: CounterDataset) {
  const bounds = periodBounds(f.period, data.today);
  const useVisits = Boolean(f.visits || f.visits_min || f.visit_types.length || f.visit_results.length || f.count === 'visits');
  const useChanges = Boolean(f.changes || f.change_to.length || f.change_from.length || f.count === 'changes');
  const visitsMap = useVisits ? data.visits(bounds, f.visit_types, f.visit_results) : new Map<string, number>();
  const changesMap = useChanges ? data.changes(bounds, f.change_to, f.change_from) : new Map<string, number>();
  const [vMode, cMode] = effectiveModes(f);
  const members = f.groups.length ? data.members(f.groups) : null;
  const since = f.days_in_status ? data.statusSince() : new Map<string, string>();

  const cats = new Set(f.categories);
  const stats = new Set(f.statuses);
  const powers = new Set(f.power);
  const needle = f.text;
  const needleLow = needle.toLowerCase();
  const needleStrict = strictKey(needle);
  const todayMs = Date.parse(`${data.today}T00:00:00Z`);

  const rows: Array<{ point: CounterPoint; visits: number; changes: number; since_days: number | null }> = [];
  for (const p of data.points) {
    if (cats.size && !cats.has(p.category)) continue;
    if (stats.size && !stats.has(p.status)) continue;
    if (powers.size && !powers.has(p.power)) continue;
    if (f.verification) {
      if (f.verification === 'soon') {
        if (!(p.verify_state === 'valid' && p.verify_left !== null && p.verify_left <= f.verification_days)) continue;
      } else if (p.verify_state !== f.verification) {
        continue;
      }
    }
    if (f.sim && p.sim !== (f.sim === 'yes')) continue;
    if (f.ip && p.ip !== (f.ip === 'yes')) continue;
    if (f.fault && p.fault !== (f.fault === 'yes')) continue;
    if (members && !members.has(p.id)) continue;
    if (needle) {
      const hay = `${p.id} ${p.address} ${p.description}`;
      const match = hay.toLowerCase().includes(needleLow) || (Boolean(needleStrict) && strictKey(hay).includes(needleStrict));
      if (!match) continue;
    }
    let days: number | null = null;
    if (f.days_in_status) {
      const at = since.get(p.id);
      if (!at) continue;
      const atMs = Date.parse(`${at.slice(0, 10)}T00:00:00Z`);
      if (Number.isNaN(atMs)) continue;
      days = Math.round((todayMs - atMs) / 86400000);
      if (days < f.days_in_status) continue;
    }
    const v = visitsMap.get(p.id) ?? 0;
    const c = changesMap.get(p.id) ?? 0;
    if (vMode === 'had' && v < (f.visits_min || 1)) continue;
    if (vMode === 'none' && v > 0) continue;
    if (vMode === '' && f.visits_min && v < f.visits_min) continue;
    if (cMode === 'had' && c === 0) continue;
    if (cMode === 'none' && c > 0) continue;
    rows.push({ point: p, visits: v, changes: c, since_days: days });
  }

  const count =
    f.count === 'points'
      ? rows.length
      : rows.reduce((acc, r) => acc + (f.count === 'visits' ? r.visits : r.changes), 0);

  return { rows, count, points: rows.length, bounds };
}

function formatCounterResult(f: CounterFilters, ev: ReturnType<typeof evaluateCounter>, total: number) {
  const out: {
    count: number;
    points: number;
    total: number;
    what: string;
    breakdown: Array<{ label: string; count: number }>;
    period: { from: string; to: string } | null;
  } = {
    count: ev.count,
    points: ev.points,
    total,
    what: f.count,
    breakdown: [],
    period: ev.bounds ? { from: ev.bounds[0], to: ev.bounds[1] } : null,
  };
  if (f.group_by) {
    const labelOf = (p: CounterPoint): string => {
      if (f.group_by === 'category') return p.category;
      if (f.group_by === 'status') return p.status;
      if (f.group_by === 'power') return p.power;
      return { valid: 'Действует', expired: 'Просрочена', none: 'Нет данных' }[p.verify_state];
    };
    const sums = new Map<string, number>();
    for (const r of ev.rows) {
      const label = labelOf(r.point);
      const val = f.count === 'points' ? 1 : f.count === 'visits' ? r.visits : r.changes;
      sums.set(label, (sums.get(label) ?? 0) + val);
    }
    out.breakdown = Array.from(sums.entries())
      .filter(([, cnt]) => cnt > 0)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([label, count]) => ({ label, count }));
  }
  return out;
}

function getGroupNamesMap(): Map<number, string> {
  const db = getDb();
  const rows = db.prepare('SELECT id, name FROM apk_groups ORDER BY id').all() as Array<{ id: number; name: string }>;
  return new Map(rows.map((r) => [r.id, r.name]));
}

function computeCounterPoints(rawFilters: unknown) {
  const f = normalizeCounterFilters(rawFilters);
  const data = new CounterDataset(todayIso());
  const bounds = periodBounds(f.period, data.today);
  const visitsMap = data.visits(bounds, f.visit_types, f.visit_results);
  const changesMap = data.changes(bounds, f.change_to, f.change_from);
  const ev = evaluateCounter(f, data);
  const rows = ev.rows.map((r) => ({
    id: r.point.id,
    address: r.point.address,
    category: r.point.category,
    status: r.point.status,
    verification: r.point.verify,
    verification_state: r.point.verify_state,
    power: r.point.power,
    visits: visitsMap.get(r.point.id) ?? 0,
    changes: changesMap.get(r.point.id) ?? 0,
    days_in_status: r.since_days,
  }));
  return {
    filters: f,
    summary: describeCounter(f, getGroupNamesMap()),
    result: formatCounterResult(f, ev, data.points.length),
    rows: rows.slice(0, LIST_LIMIT),
    truncated: rows.length > LIST_LIMIT,
    limit: LIST_LIMIT,
    period: ev.bounds ? { from: ev.bounds[0], to: ev.bounds[1] } : null,
  };
}

// ---------------------------------------------------------------------------
// 3. GAMES (/api/games, /api/admin/games)
// ---------------------------------------------------------------------------

const GAME_CATEGORIES = [
  { key: 'puzzle', title: 'Головоломки' },
  { key: 'sort', title: 'Сортировка' },
  { key: 'logic', title: 'Логика' },
  { key: 'memory', title: 'Память' },
  { key: 'arcade', title: 'Аркады' },
  { key: 'speed', title: 'Скорость' },
];

interface GameDef {
  key: string;
  title: string;
  icon: string;
  cat: string;
  hue: number;
  hint: string;
  better: 'high' | 'low';
  unit: string;
  min: number;
  max: number;
  difficulty: boolean;
}

const DIFFICULTY_KEYS = new Set(['workshop', 'water', 'mines', 'math', 'clicker']);
const g = (
  key: string,
  title: string,
  icon: string,
  cat: string,
  hue: number,
  hint: string,
  better: 'high' | 'low',
  unit: string,
  min: number,
  max: number,
  difficulty?: boolean,
): GameDef => ({
  key,
  title,
  icon,
  cat,
  hue,
  hint,
  better,
  unit,
  min,
  max,
  difficulty: difficulty !== undefined ? difficulty : DIFFICULTY_KEYS.has(key),
});

const GAME_CATALOG: GameDef[] = [
  g('bubble', 'Пузырьковый стрелок', '🫧', 'arcade', 195, 'Стреляйте пузырями, собирайте группы одного цвета и набирайте очки. Результат попадёт в общую таблицу рекордов.', 'high', 'очков', 0, 2_000_000),
  g('arrows', 'Стрелки: путь наружу', '↗️', 'puzzle', 190, 'Распутайте поле: выпускайте стрелки по одной, не сталкиваясь с соседями. Сотни уровней, подсказки и сохранение прогресса.', 'high', 'уровень', 0, 9999, false),
  g('workshop', 'Мастерская', '🛠️', 'arcade', 28, 'Выполняйте заявки, получайте жетоны, улучшайте инструменты и открывайте новые уровни. Прогресс сохраняется на этом устройстве.', 'high', 'уровней', 0, 99),
  g('water', 'Переливашки', '🧪', 'sort', 190, 'Переливайте цвета, пока в каждой пробирке не останется один. Уровни всё сложнее.', 'high', 'уровней', 0, 500),
  g('order', 'Расставь по порядку', '🔢', 'sort', 215, 'Меняйте плитки местами и расставьте числа по возрастанию. 5 раундов на время.', 'low', 'с', 3, 3600),
  g('sorter', 'Сортировщик', '📦', 'sort', 30, 'Шарики падают — отправляйте каждый в корзину своего цвета. Три ошибки — конец.', 'high', 'шт', 0, 2000),
  g('g2048', '2048', '🧮', 'puzzle', 45, 'Сдвигайте плитки и собирайте 2048. Стрелки или свайп.', 'high', 'очков', 0, 2_000_000),
  g('match3', 'Три в ряд', '💎', 'puzzle', 300, 'Меняйте соседние камни и собирайте ряды из трёх. Минута на всё.', 'high', 'очков', 0, 200_000),
  g('flood', 'Заливка', '🎨', 'puzzle', 160, 'Закрасьте всё поле одним цветом не больше чем за 25 ходов.', 'low', 'ходов', 5, 25),
  g('slide15', 'Пятнашки', '🧩', 'puzzle', 20, 'Сдвигайте плитки и расставьте числа по порядку. Меньше ходов — лучше.', 'low', 'ходов', 5, 5000),
  g('mines', 'Сапёр', '💣', 'logic', 0, 'Поле 9×9, 10 мин. Правая кнопка (или долгое нажатие) — флажок. Важно время.', 'low', 'с', 4, 3600),
  g('tictactoe', 'Крестики-нолики', '❌', 'logic', 340, 'Против компьютера. Победа — 3 очка, ничья — 1, поражение завершает серию.', 'high', 'очков', 0, 3000),
  g('lights', 'Лампочки', '💡', 'logic', 55, 'Нажатие переключает лампочку и четырёх соседей. Погасите все.', 'low', 'ходов', 1, 1000),
  g('hanoi', 'Ханойская башня', '🗼', 'logic', 260, 'Перенесите 5 дисков на другой стержень: больший на меньший класть нельзя.', 'low', 'ходов', 31, 2000),
  g('rps', 'Камень-ножницы-бумага', '✂️', 'logic', 120, 'Серия побед подряд против компьютера. Проигрыш завершает партию.', 'high', 'побед', 0, 500),
  g('hangman', 'Виселица', '🔤', 'logic', 280, 'Угадывайте слова по буквам. Шесть жизней на слово, слов — сколько сможете.', 'high', 'слов', 0, 500),
  g('guess', 'Угадай число', '🎯', 'logic', 10, 'Я загадал число от 1 до 100. Подсказки «больше» и «меньше». Меньше попыток — лучше.', 'low', 'попыток', 1, 100),
  g('memory', 'Память', '🃏', 'memory', 330, 'Найдите все пары за минимум ходов.', 'low', 'ходов', 8, 500),
  g('simon', 'Повтори за мной', '🎹', 'memory', 175, 'Запомните цепочку огней и повторите её. С каждым разом длиннее.', 'high', 'раундов', 0, 200),
  g('snake', 'Змейка', '🐍', 'arcade', 140, 'Ешьте яблоки и не врезайтесь. Стрелки или свайп.', 'high', 'яблок', 0, 3000),
  g('tetris', 'Тетрис', '🧱', 'arcade', 25, 'Стройте линии. ← → — сдвиг, ↑ — поворот, ↓ — ускорить, пробел — сбросить.', 'high', 'очков', 0, 2_000_000),
  g('breakout', 'Арканоид', '🏓', 'arcade', 200, 'Отбивайте мяч и ломайте кирпичи. Мышь, палец или стрелки.', 'high', 'очков', 0, 200_000),
  g('flappy', 'Летающая камера', '📷', 'arcade', 205, 'Нажимайте пробел или касайтесь, чтобы лететь между столбами.', 'high', 'столбов', 0, 5000),
  g('stack', 'Башня', '🏗️', 'arcade', 35, 'Нажмите, чтобы уронить блок. Что не попало на башню — обрезается.', 'high', 'блоков', 0, 1000),
  g('runner', 'Бегун', '🏃', 'arcade', 100, 'Прыгайте через препятствия: пробел, стрелка вверх или касание.', 'high', 'м', 0, 100_000),
  g('reaction', 'Реакция', '⚡', 'speed', 50, 'Нажмите, как только экран станет зелёным. 5 попыток — среднее время.', 'low', 'мс', 90, 5000),
  g('math', 'Быстрый счёт', '➗', 'speed', 250, '30 секунд на примеры. Сколько решите верно?', 'high', 'верно', 0, 150),
  g('whack', 'Сбой на комплексе', '🔴', 'speed', 355, '30 секунд: нажимайте на камеру, как только она «упала» (красная).', 'high', 'попаданий', 0, 200),
  g('schulte', 'Таблица Шульте', '👁️', 'speed', 230, 'Нажимайте числа от 1 до 25 по порядку как можно быстрее.', 'low', 'с', 4, 3600),
  g('clicker', 'Тапалка', '👆', 'speed', 15, '10 секунд: сколько раз успеете нажать на кнопку?', 'high', 'нажатий', 0, 150),
];
const GAMES_BY_KEY = new Map(GAME_CATALOG.map((item) => [item.key, item]));
const LAST_GAME_SUBMIT = new Map<string, number>();

function publicGameCatalog(keys: string[] | null = null) {
  const keySet = keys ? new Set(keys) : null;
  return GAME_CATALOG.filter((item) => !keySet || keySet.has(item.key)).map((item) => ({
    key: item.key,
    title: item.title,
    icon: item.icon,
    cat: item.cat,
    hue: item.hue,
    hint: item.hint,
    better: item.better,
    unit: item.unit,
    difficulty: item.difficulty,
  }));
}

function allowedGameKeys(userId: number): string[] | null {
  const db = getDb();
  const row = db.prepare('SELECT enabled, games FROM user_games WHERE user_id = ?').get(userId) as
    | { enabled: number; games: string | null }
    | undefined;
  if (!row || !row.enabled) return null;
  if (!row.games) return GAME_CATALOG.map((item) => item.key);
  const parsed = parseJsonSafe<string[] | null>(row.games, null);
  if (!Array.isArray(parsed)) return GAME_CATALOG.map((item) => item.key);
  const valid = new Set(parsed.filter((k) => GAMES_BY_KEY.has(k)));
  return GAME_CATALOG.filter((item) => valid.has(item.key)).map((item) => item.key);
}

function getGameLeaderboard(game: string, userId: number | null, limit = 20) {
  const meta = GAMES_BY_KEY.get(game);
  if (!meta) return null;
  const db = getDb();
  const dir = meta.better === 'low' ? 'ASC' : 'DESC';
  const rows = db
    .prepare(
      `SELECT s.user_id, u.username, s.best, s.plays, s.best_at
       FROM game_scores s
       JOIN users u ON u.id = s.user_id
       WHERE s.game = ?
       ORDER BY s.best ${dir}, s.best_at ASC`,
    )
    .all(game) as Array<{ user_id: number; username: string; best: number; plays: number; best_at: string }>;
  const ranked = rows.map((r, i) => ({ ...r, rank: i + 1, at: r.best_at }));
  const me = userId != null ? ranked.find((r) => r.user_id === userId) : undefined;
  const top = ranked.slice(0, limit).map((r) => ({
    rank: r.rank,
    username: r.username,
    best: r.best,
    plays: r.plays,
    at: r.at,
    me: r.user_id === userId,
  }));
  return {
    game,
    title: meta.title,
    better: meta.better,
    unit: meta.unit,
    total: ranked.length,
    top,
    me: me ? { rank: me.rank, best: me.best, plays: me.plays } : null,
  };
}

// ---------------------------------------------------------------------------
// 4. WEATHER (/api/weather)
// ---------------------------------------------------------------------------

const WEATHER_KEY = 'weather_config';
const WEATHER_MIN_REFRESH = 5;
const WEATHER_MAX_REFRESH = 180;
const WEATHER_DEFAULT_REFRESH = 30;
const WEATHER_SOURCES = [
  { id: 'auto', label: 'Авто — по очереди', hint: 'Яндекс.Погода (если введён ключ) → «Проект Эол» (projecteol.ru) → Open-Meteo: берётся первый, кто ответил.' },
  { id: 'eol', label: 'Проект Эол (projecteol.ru)', hint: 'Российский сервис, без регистрации и ключа; почасовой прогноз модели NOAA GFS. Серверу нужен доступ к weatherapi.projecteol.ru:443.' },
  { id: 'yandex', label: 'Яндекс.Погода (yandex.ru)', hint: 'Нужен ключ (developer.tech.yandex.ru → «Погода»). Тариф «Тестовый» — 50 запросов в сутки: при периоде короче 30 минут лимит будет превышен.' },
  { id: 'open_meteo', label: 'Open-Meteo (open-meteo.com)', hint: 'Международный, без ключа. Единственный, который может запросить и браузер сотрудника, если у сервера нет интернета.' },
  { id: 'sky', label: 'Без погоды — только время суток', hint: 'Ничего не запрашивается: небо по времени суток (день — солнце, вечер — закат, ночь — звёзды и луна). Для серверов без интернета.' },
];
const WEATHER_SOURCE_IDS = new Set(WEATHER_SOURCES.map((s) => s.id));
const WEATHER_DEFAULTS = {
  source: 'auto',
  refresh_minutes: WEATHER_DEFAULT_REFRESH,
  yandex_key: '',
  city: 'Москва',
  lat: 55.7558,
  lon: 37.6173,
};
const LEVEL_DEFAULTS: Record<string, [number, number, number]> = {
  clear: [0.05, 0.0, 2.0],
  partly: [0.4, 0.0, 3.0],
  clouds: [0.92, 0.0, 4.0],
  rain: [0.92, 2.5, 5.0],
  snow: [0.9, 1.0, 3.0],
  storm: [0.97, 9.0, 11.0],
  fog: [0.6, 0.0, 1.0],
};
const WEATHER_DESCS: Record<string, string> = {
  clear: 'ясно',
  partly: 'малооблачно',
  clouds: 'облачно',
  rain: 'дождь',
  snow: 'снег',
  storm: 'гроза',
  fog: 'туман',
};
const YANDEX_COND: Record<string, string> = {
  clear: 'clear',
  'partly-cloudy': 'partly',
  cloudy: 'clouds',
  overcast: 'clouds',
  drizzle: 'rain',
  'light-rain': 'rain',
  rain: 'rain',
  'moderate-rain': 'rain',
  'heavy-rain': 'rain',
  'continuous-heavy-rain': 'rain',
  showers: 'rain',
  hail: 'rain',
  'wet-snow': 'snow',
  'light-snow': 'snow',
  snow: 'snow',
  'snow-showers': 'snow',
  thunderstorm: 'storm',
  'thunderstorm-with-rain': 'storm',
  'thunderstorm-with-hail': 'storm',
};

type WeatherConfig = typeof WEATHER_DEFAULTS;
let weatherCache: { at: number; failedAt: number; sig: string; data: Record<string, unknown> | null } = {
  at: 0,
  failedAt: 0,
  sig: '',
  data: null,
};

function cleanWeatherConfig(raw: Record<string, unknown>): WeatherConfig {
  const cfg = { ...WEATHER_DEFAULTS };
  if (typeof raw.source === 'string' && WEATHER_SOURCE_IDS.has(raw.source)) cfg.source = raw.source;
  const ref = Number(raw.refresh_minutes);
  if (Number.isFinite(ref)) {
    cfg.refresh_minutes = Math.max(WEATHER_MIN_REFRESH, Math.min(WEATHER_MAX_REFRESH, Math.round(ref)));
  }
  cfg.yandex_key = String(raw.yandex_key ?? '').trim().slice(0, 200);
  cfg.city = String(raw.city ?? '').trim().slice(0, 60) || WEATHER_DEFAULTS.city;
  const lat = Number(String(raw.lat ?? WEATHER_DEFAULTS.lat).replace(',', '.'));
  if (Number.isFinite(lat) && lat >= -90 && lat <= 90) cfg.lat = Math.round(lat * 10000) / 10000;
  const lon = Number(String(raw.lon ?? WEATHER_DEFAULTS.lon).replace(',', '.'));
  if (Number.isFinite(lon) && lon >= -180 && lon <= 180) cfg.lon = Math.round(lon * 10000) / 10000;
  return cfg;
}

function loadWeatherConfig(): WeatherConfig {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_flags WHERE key = ?').get(WEATHER_KEY) as { value: string } | undefined;
  return cleanWeatherConfig(parseJsonSafe<Record<string, unknown>>(row?.value, {}));
}

function saveWeatherConfig(patch: Partial<WeatherConfig> & { yandex_key?: string | null }): WeatherConfig {
  const cur = loadWeatherConfig();
  const merged: Record<string, unknown> = { ...cur };
  for (const [k, v] of Object.entries(patch)) {
    if (k !== 'yandex_key' && v !== undefined) merged[k] = v;
  }
  if (patch.yandex_key !== undefined && patch.yandex_key !== null) {
    merged.yandex_key = patch.yandex_key;
  }
  const next = cleanWeatherConfig(merged);
  const db = getDb();
  db.prepare(
    'INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(WEATHER_KEY, JSON.stringify(next));
  weatherCache = { at: 0, failedAt: 0, sig: '', data: null };
  return next;
}

function publicWeatherConfig(cfg: WeatherConfig) {
  const key = cfg.yandex_key || '';
  return {
    source: cfg.source,
    refresh_minutes: cfg.refresh_minutes,
    city: cfg.city,
    lat: cfg.lat,
    lon: cfg.lon,
    yandex_key_set: Boolean(key),
    yandex_key_hint: key.length >= 8 ? `…${key.slice(-4)}` : key ? 'задан' : '',
    env_key_set: Boolean((process.env.YANDEX_WEATHER_API_KEY || '').trim()),
    sources: WEATHER_SOURCES,
    min_refresh: WEATHER_MIN_REFRESH,
    max_refresh: WEATHER_MAX_REFRESH,
  };
}

function sunElevation(lat: number, lon: number, now: Date): number {
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const day = Math.floor((now.getTime() - startOfYear) / 86400000) + 1;
  const frac = ((2 * Math.PI) / 365) * (day - 1 + (now.getUTCHours() - 12) / 24);
  const eqtime =
    229.18 *
    (0.000075 +
      0.001868 * Math.cos(frac) -
      0.032077 * Math.sin(frac) -
      0.014615 * Math.cos(2 * frac) -
      0.040849 * Math.sin(2 * frac));
  const decl =
    0.006918 -
    0.399912 * Math.cos(frac) +
    0.070257 * Math.sin(frac) -
    0.006758 * Math.cos(2 * frac) +
    0.000907 * Math.sin(2 * frac) -
    0.002697 * Math.cos(3 * frac) +
    0.00148 * Math.sin(3 * frac);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes() + now.getUTCSeconds() / 60;
  const angle = (((minutes + eqtime + 4 * lon - 720) / 4) * Math.PI) / 180;
  const la = (lat * Math.PI) / 180;
  return (Math.asin(Math.sin(la) * Math.sin(decl) + Math.cos(la) * Math.cos(decl) * Math.cos(angle)) * 180) / Math.PI;
}

function wmoToCode(code: number): string {
  if (code === 0) return 'clear';
  if (code === 1 || code === 2) return 'partly';
  if (code === 3) return 'clouds';
  if (code === 45 || code === 48) return 'fog';
  if ([51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 80, 81, 82].includes(code)) return 'rain';
  if ([71, 73, 75, 77, 85, 86].includes(code)) return 'snow';
  if ([95, 96, 99].includes(code)) return 'storm';
  return 'clouds';
}

function withWeatherLevels(raw: {
  code?: string;
  temp?: number | null;
  source?: string;
  cloud?: number | null;
  precip?: number | null;
  wind?: number | null;
}) {
  const code = raw.code || 'clouds';
  const [dCloud, dPrecip, dWind] = LEVEL_DEFAULTS[code] || LEVEL_DEFAULTS.clouds;
  let cloud = typeof raw.cloud === 'number' && Number.isFinite(raw.cloud) ? Math.min(Math.max(raw.cloud, 0), 1) : dCloud;
  let precip = typeof raw.precip === 'number' && Number.isFinite(raw.precip) ? Math.min(Math.max(raw.precip, 0), 60) : dPrecip;
  const wind = typeof raw.wind === 'number' && Number.isFinite(raw.wind) ? Math.min(Math.max(raw.wind, 0), 40) : dWind;
  if (code === 'rain' || code === 'snow' || code === 'storm') {
    precip = Math.max(precip, code === 'storm' ? 4.0 : 0.3);
    cloud = Math.max(cloud, 0.8);
  } else if (code === 'clouds') {
    cloud = Math.max(cloud, 0.6);
  } else if (code === 'clear') {
    cloud = Math.min(cloud, 0.3);
    precip = 0;
  } else if (code === 'partly') {
    cloud = Math.min(Math.max(cloud, 0.15), 0.8);
    precip = 0;
  }
  return {
    ...raw,
    code,
    cloud: Math.round(cloud * 100) / 100,
    precip: Math.round(precip * 100) / 100,
    wind: Math.round(wind * 10) / 10,
  };
}

async function fetchJsonTimeout(url: string, init?: RequestInit, timeoutMs = 8000): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(url, { ...init, signal: ctrl.signal });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchFromYandex(cfg: WeatherConfig, key: string) {
  const d = (await fetchJsonTimeout(
    `https://api.weather.yandex.ru/v2/forecast?lat=${cfg.lat}&lon=${cfg.lon}&lang=ru_RU&limit=1&hours=false&extra=false`,
    { headers: { 'X-Yandex-Weather-Key': key, 'User-Agent': 'lan-calendar/weather' } },
  )) as { fact: Record<string, unknown> };
  const fact = d.fact;
  const code = fact.is_thunder ? 'storm' : YANDEX_COND[String(fact.condition)] || 'clouds';
  const strength = typeof fact.prec_strength === 'number' ? fact.prec_strength : null;
  const precipMap: Record<number, number> = { 0: 0, 0.25: 0.4, 0.5: 1.5, 0.75: 4.0, 1: 9.0 };
  const precip = strength === null ? null : precipMap[strength] ?? strength * 9.0;
  return {
    code,
    temp: typeof fact.temp === 'number' ? fact.temp : null,
    source: 'Яндекс.Погода',
    cloud: typeof fact.cloudness === 'number' ? fact.cloudness : null,
    precip,
    wind: typeof fact.wind_speed === 'number' ? fact.wind_speed : null,
  };
}

async function fetchFromOpenMeteo(cfg: WeatherConfig) {
  const d = (await fetchJsonTimeout(
    `https://api.open-meteo.com/v1/forecast?latitude=${cfg.lat}&longitude=${cfg.lon}&current=temperature_2m,weather_code,is_day,cloud_cover,precipitation,wind_speed_10m&timezone=auto`,
    { headers: { 'User-Agent': 'lan-calendar/weather' } },
  )) as { current: Record<string, unknown> };
  const cur = d.current;
  const cloud = typeof cur.cloud_cover === 'number' ? cur.cloud_cover / 100 : null;
  const wind = typeof cur.wind_speed_10m === 'number' ? cur.wind_speed_10m / 3.6 : null;
  return {
    code: wmoToCode(Number(cur.weather_code ?? 3)),
    temp: typeof cur.temperature_2m === 'number' ? cur.temperature_2m : null,
    source: 'Open-Meteo',
    cloud,
    precip: typeof cur.precipitation === 'number' ? cur.precipitation : null,
    wind,
  };
}

async function fetchWeatherBySource(cfg: WeatherConfig, sourceName?: string) {
  const src = sourceName || cfg.source;
  const key = (cfg.yandex_key || process.env.YANDEX_WEATHER_API_KEY || '').trim();
  const finish = (raw: ReturnType<typeof withWeatherLevels>) => {
    const now = new Date();
    return {
      ok: true,
      ...raw,
      city: cfg.city,
      lat: cfg.lat,
      lon: cfg.lon,
      refresh_minutes: cfg.refresh_minutes,
      is_day: sunElevation(cfg.lat, cfg.lon, now) > -0.8,
      desc: WEATHER_DESCS[raw.code] || '',
      updated_at: now.toISOString().slice(0, 19) + 'Z',
    };
  };

  if (src === 'sky') {
    return finish(withWeatherLevels({ code: 'clear', temp: null, source: 'время суток' }));
  }

  const steps: Array<{ name: string; fn: () => Promise<ReturnType<typeof withWeatherLevels>> }> = [];
  if (src === 'yandex' || (src === 'auto' && key)) {
    steps.push({
      name: 'Яндекс.Погода',
      fn: async () => {
        if (!key) throw new Error('не задан ключ Яндекс.Погоды');
        return withWeatherLevels(await fetchFromYandex(cfg, key));
      },
    });
  }
  if (src === 'open_meteo' || src === 'auto' || src === 'eol') {
    steps.push({
      name: 'Open-Meteo',
      fn: async () => withWeatherLevels(await fetchFromOpenMeteo(cfg)),
    });
  }

  for (const step of steps) {
    try {
      return finish(await step.fn());
    } catch {
      // try next fallback
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 5. LIVE MAPS (/api/live-maps & /api/yandex-robot)
// ---------------------------------------------------------------------------

const LM_KIND_LABELS: Record<string, string> = {
  access: 'Есть доступ',
  access_cert: 'Есть доступ и действует поверка',
  list: 'Свой список комплексов',
  dropped: 'Отвалились за период',
  filter: 'Фильтр из «Все АПК»',
};
const LM_CERT_FILTERS = new Set(['valid', 'expired', 'missing', 'invalid']);
const LM_INTERVALS = [5, 10, 15, 30, 60];

function cleanPointIds(raw: unknown): string[] {
  let list: unknown[] = [];
  if (typeof raw === 'string') {
    list = raw.split(/[,;\n\r\t]+/);
  } else if (Array.isArray(raw)) {
    list = raw;
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of list) {
    const pid = String(item ?? '').trim();
    const key = pid.toLowerCase();
    if (pid && !seen.has(key)) {
      seen.add(key);
      out.push(pid);
    }
  }
  return out;
}

function normalizeLiveMapParams(kind: string, rawParams: unknown): Record<string, unknown> {
  if (!(kind in LM_KIND_LABELS)) throw new Error('Неизвестный тип карты');
  const p = (rawParams && typeof rawParams === 'object' ? rawParams : {}) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  if (kind !== 'list') {
    const cats: number[] = [];
    for (const c of Array.isArray(p.category_ids) ? p.category_ids : []) {
      const n = Number(c);
      if (Number.isInteger(n) && n > 0 && !cats.includes(n)) cats.push(n);
    }
    out.category_ids = cats;
    out.uncategorized = Boolean(p.uncategorized);
  }
  if (kind === 'access') {
    out.statuses = ['Работает'];
  } else if (kind === 'access_cert') {
    out.statuses = ['Работает'];
    out.certificate = 'valid';
  } else if (kind === 'filter') {
    out.search = String(p.search ?? '').trim().slice(0, 100);
    out.statuses = (Array.isArray(p.statuses) ? p.statuses : []).map(String).filter(Boolean).slice(0, 30);
  } else if (kind === 'dropped') {
    const hours = Number(p.dropped_hours);
    if (!Number.isInteger(hours)) throw new Error('Укажите период, за который искать отвалившиеся комплексы');
    if (hours < 1 || hours > 24 * 365) throw new Error('Период — от 1 часа до года');
    out.dropped_hours = hours;
  } else {
    const ids = cleanPointIds(p.point_ids);
    if (!ids.length) throw new Error('Укажите хотя бы один комплекс');
    out.point_ids = ids;
  }
  if (kind !== 'access_cert') {
    const cert = String(p.certificate ?? '');
    out.certificate = LM_CERT_FILTERS.has(cert) ? cert : '';
  }
  return out;
}

function certMatches(validUntil: string, cert: string): boolean {
  if (!cert) return true;
  const v = (validUntil || '').trim();
  const today = todayIso();
  if (cert === 'valid') return Boolean(v) && v >= today;
  if (cert === 'expired') return Boolean(v) && v < today;
  if (cert === 'missing') return !v;
  return !v || v < today;
}

function selectLiveMapPoints(kind: string, params: Record<string, unknown>) {
  const db = getDb();
  const all = db
    .prepare('SELECT id, address, description, lat, lon, status, category_id, verification_valid_until, port_down_since FROM points ORDER BY id')
    .all() as Array<{
      id: string;
      address: string;
      description: string;
      lat: string;
      lon: string;
      status: string;
      category_id: number | null;
      verification_valid_until: string;
      port_down_since: string | null;
    }>;

  if (kind === 'list') {
    const byKey = new Map(all.map((p) => [p.id.trim().toLowerCase(), p]));
    const found: typeof all = [];
    const unknown: string[] = [];
    for (const pid of (params.point_ids as string[]) || []) {
      const p = byKey.get(pid.trim().toLowerCase());
      if (p) found.push(p);
      else unknown.push(pid);
    }
    const cert = String(params.certificate || '');
    return { points: found.filter((p) => certMatches(p.verification_valid_until, cert)), unknown };
  }

  const search = String(params.search || '').toLowerCase();
  const catSet = new Set((params.category_ids as number[]) || []);
  const uncat = Boolean(params.uncategorized);
  const statusSet = new Set((params.statuses as string[]) || []);
  const cert = String(params.certificate || '');
  const cutoff =
    kind === 'dropped'
      ? new Date(Date.now() - Number(params.dropped_hours || 24) * 3600000).toISOString()
      : '';

  const matched = all.filter((p) => {
    if (catSet.size || uncat) {
      const okCat = (p.category_id != null && catSet.has(p.category_id)) || (uncat && p.category_id == null);
      if (!okCat) return false;
    }
    if (statusSet.size && !statusSet.has(p.status)) return false;
    if (!certMatches(p.verification_valid_until, cert)) return false;
    if (search) {
      const hay = `${p.id} ${p.address} ${p.description}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    if (kind === 'dropped') {
      if (!p.port_down_since || p.port_down_since < cutoff) return false;
    }
    return true;
  });
  return { points: matched, unknown: [] as string[] };
}

function hasValidCoords(p: { lat: string; lon: string }): boolean {
  const lat = Number(String(p.lat || '').trim().replace(',', '.'));
  const lon = Number(String(p.lon || '').trim().replace(',', '.'));
  return Number.isFinite(lat) && Number.isFinite(lon) && !(lat === 0 && lon === 0);
}

function publicLiveMap(row: Record<string, unknown>) {
  const members = parseJsonSafe<string[]>(String(row.members_json || '[]'), []);
  const params = parseJsonSafe<Record<string, unknown>>(String(row.params_json || '{}'), {});
  const kind = String(row.kind || '');
  return {
    id: Number(row.id),
    name: String(row.name || ''),
    kind,
    kind_label: LM_KIND_LABELS[kind] || kind,
    params,
    membership: String(row.membership || 'fixed'),
    members_count: members.length,
    interval_minutes: Number(row.interval_minutes || 5),
    enabled: Boolean(row.enabled),
    map_id: String(row.map_id || ''),
    url: String(row.url || ''),
    points_count: Number(row.points_count || 0),
    skipped: Number(row.skipped || 0),
    last_sync: String(row.last_sync || ''),
    last_error: String(row.last_error || ''),
    created_by: String(row.created_by || ''),
    created_at: String(row.created_at || ''),
    job: null,
  };
}

// ---------------------------------------------------------------------------
// 6. AI, AI-AGENTS & ASSISTANT (/api/ai, /api/ai-agents, /api/agent, /api/assistant)
// ---------------------------------------------------------------------------

const AI_CONFIG_KEY = 'ai_config';
const AI_DEFAULTS = {
  bot_voice: false,
  assistant: false,
  forms_fault: false,
  server_llm: true,
  server_asr: true,
};

function loadAiConfig() {
  const db = getDb();
  const row = db.prepare('SELECT value FROM app_flags WHERE key = ?').get(AI_CONFIG_KEY) as { value: string } | undefined;
  const saved = parseJsonSafe<Record<string, unknown>>(row?.value, {});
  return {
    bot_voice: typeof saved.bot_voice === 'boolean' ? saved.bot_voice : AI_DEFAULTS.bot_voice,
    assistant: typeof saved.assistant === 'boolean' ? saved.assistant : AI_DEFAULTS.assistant,
    forms_fault: typeof saved.forms_fault === 'boolean' ? saved.forms_fault : AI_DEFAULTS.forms_fault,
    server_llm: typeof saved.server_llm === 'boolean' ? saved.server_llm : AI_DEFAULTS.server_llm,
    server_asr: typeof saved.server_asr === 'boolean' ? saved.server_asr : AI_DEFAULTS.server_asr,
  };
}

function saveAiConfig(changes: Record<string, unknown>) {
  const cur = loadAiConfig();
  const next = { ...cur };
  for (const k of Object.keys(AI_DEFAULTS) as Array<keyof typeof AI_DEFAULTS>) {
    if (typeof changes[k] === 'boolean') next[k] = changes[k] as boolean;
  }
  const db = getDb();
  db.prepare(
    'INSERT INTO app_flags (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(AI_CONFIG_KEY, JSON.stringify(next));
  return next;
}

const aiRuntimeStats = {
  llmBusy: false,
  llmWaiting: 0,
  llmLastSeconds: null as number | null,
  asrLastSeconds: null as number | null,
};

function getAiStatus() {
  const cfg = loadAiConfig();
  const hasGemini = Boolean((process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim());
  const cpus = os.cpus() || [];
  return {
    llm: cfg.server_llm
      ? {
          ok: hasGemini,
          disabled: false,
          loading: false,
          via_agents: false,
          model: hasGemini ? 'gemini-4-hydrogen' : '',
          message: hasGemini ? '' : 'GEMINI_API_KEY не настроен',
        }
      : { ok: false, disabled: true, loading: false, via_agents: false, model: '', message: 'выключено на сервере' },
    asr: {
      ok: false,
      disabled: !cfg.server_asr,
      loading: false,
      model: '',
      message: cfg.server_asr ? 'Локальный Whisper-сервер не подключён' : 'выключено на сервере',
    },
    cpu: {
      cores: cpus.length,
      model: cpus[0]?.model || '',
      avx2: null,
    },
    queue: {
      llm_waiting: aiRuntimeStats.llmWaiting,
      llm_busy: aiRuntimeStats.llmBusy,
    },
    last: {
      llm_seconds: aiRuntimeStats.llmLastSeconds,
      asr_seconds: aiRuntimeStats.asrLastSeconds,
    },
  };
}

function roleDatasets(perms: string[]) {
  const out: Array<{ name: string; label: string }> = [];
  if (hasAnyPerm(perms, ['calendar.view'])) {
    out.push({ name: 'tasks', label: 'Задания календаря' });
    out.push({ name: 'crews', label: 'Бригады' });
  }
  if (hasAnyPerm(perms, ['reports.view'])) {
    out.push({ name: 'visits', label: 'Отчёты о выездах' });
  }
  if (hasAnyPerm(perms, ['points.view', 'check.use'])) {
    out.push({ name: 'points', label: 'Комплексы АПК' });
  }
  if (hasAnyPerm(perms, ['warehouse.view'])) {
    out.push({ name: 'equipment', label: 'Оборудование склада' });
  }
  if (hasAnyPerm(perms, ['absences.view'])) {
    out.push({ name: 'absences', label: 'Отсутствия сотрудников' });
  }
  return out;
}

function assistantExamples(perms: string[]): string[] {
  const names = new Set(roleDatasets(perms).map((d) => d.name));
  if (names.has('tasks') || names.has('visits') || names.has('crews')) {
    return [
      'Сколько комплексов сейчас не работает?',
      'Какие комплексы не работают дольше всего?',
      'Сколько выездов было за последние 7 дней?',
      'Какие бригады выезжали сегодня?',
    ];
  }
  if (names.has('equipment') || names.has('points')) {
    return [
      'Сколько комплексов сейчас не работает?',
      'Сколько исправного оборудования на складе?',
      'У скольких комплексов истекает поверка?',
    ];
  }
  if (names.has('absences')) {
    return ['Кто из сотрудников отсутствует сегодня?', 'У кого запланирован отпуск в этом месяце?'];
  }
  return [];
}

function buildRoleDataSnapshot(perms: string[]) {
  const db = getDb();
  const canPoints = hasAnyPerm(perms, ['points.view', 'check.use', 'calendar.view', 'reports.view', 'stats.view']);
  const canNet = networkOk(perms);
  const canSecrets = secretsOk(perms);
  const canTasks = hasPerm(perms, 'calendar.view');
  const canReports = hasPerm(perms, 'reports.view');
  const canWarehouse = hasPerm(perms, 'warehouse.view');
  const canAbsences = hasPerm(perms, 'absences.view');

  const snapshot: Record<string, unknown> = { today: todayIso() };
  if (canPoints) {
    const statusSummary = db
      .prepare("SELECT CASE WHEN status = '' THEN 'Не известно' ELSE status END AS status, COUNT(*) AS count FROM points GROUP BY status ORDER BY count DESC")
      .all();
    const downPoints = db
      .prepare(
        `SELECT id, address, status, fault_reason, fault_need, port_down_since, verification_valid_until, power_source${canNet ? ', ip_address, port' : ''}${canSecrets ? ', login' : ''}
         FROM points WHERE status != 'Работает' ORDER BY id LIMIT 60`,
      )
      .all();
    snapshot.points_status_summary = statusSummary;
    snapshot.non_working_points_sample = downPoints;
  }
  if (canTasks) {
    const today = todayIso();
    snapshot.today_crews = db.prepare('SELECT id, name, equip, place FROM crews WHERE date = ? ORDER BY id').all(today);
    snapshot.today_tasks = db.prepare('SELECT id, team, point, type, work, address, note FROM tasks WHERE date = ? ORDER BY priority, id LIMIT 100').all(today);
  }
  if (canReports) {
    snapshot.recent_visit_reports = db
      .prepare(
        `SELECT task_id, point_id, visit_type, result_status, outcome, fault, needs, comment, created_at
         FROM task_visit_reports ORDER BY created_at DESC LIMIT 40`,
      )
      .all();
  }
  if (canWarehouse) {
    snapshot.equipment_summary = db
      .prepare(
        `SELECT e.place, COALESCE(es.name, '') AS status, COUNT(*) AS count
         FROM equipment e LEFT JOIN equipment_statuses es ON es.id = e.status_id
         GROUP BY e.place, status`,
      )
      .all();
  }
  if (canAbsences) {
    const today = todayIso();
    snapshot.current_and_upcoming_absences = db
      .prepare(
        `SELECT pa.person_id, pa.start_date, pa.end_date, pa.reason
         FROM people_absences pa WHERE pa.end_date >= ? ORDER BY pa.start_date LIMIT 40`,
      )
      .all(today);
  }
  return snapshot;
}

async function runAssistantQuestion(question: string, perms: string[], mode: string) {
  const started = Date.now();
  const db = getDb();
  const computedAt = nowIso();
  const qLow = question.toLowerCase();

  // Check if user asks about a specific point ID (e.g. P-2, Т-101, К-15, etc.)
  const pointMatch = question.match(/\b([A-Za-zА-Яа-яЁё0-9]{1,8}[-_]\d{1,6})\b/);
  if (pointMatch && hasAnyPerm(perms, ['points.view', 'check.use', 'calendar.view'])) {
    const pid = pointMatch[1];
    const point = db
      .prepare(
        `SELECT p.*, COALESCE(pc.name, '') AS category_name
         FROM points p LEFT JOIN point_categories pc ON pc.id = p.category_id
         WHERE lower(p.id) = lower(?)`,
      )
      .get(pid) as Record<string, unknown> | undefined;
    if (point) {
      const realId = String(point.id);
      const visitsCount = (
        db.prepare('SELECT COUNT(*) AS cnt FROM task_visit_reports WHERE point_id = ?').get(realId) as { cnt: number }
      ).cnt;
      const lastVisit = (
        db.prepare('SELECT MAX(created_at) AS at FROM task_visit_reports WHERE point_id = ?').get(realId) as { at: string | null }
      ).at;
      const planned = db
        .prepare('SELECT date, type FROM tasks WHERE point = ? AND date >= ? ORDER BY date LIMIT 5')
        .all(realId, todayIso()) as Array<{ date: string; type: string }>;
      const groups = db
        .prepare('SELECT g.name, gp.need FROM apk_group_points gp JOIN apk_groups g ON g.id = gp.group_id WHERE gp.point_id = ?')
        .all(realId) as Array<{ name: string; need: string }>;
      const downSince = String(point.port_down_since || '');
      const downDays = downSince ? Math.max(0, Math.floor((Date.now() - Date.parse(downSince)) / 86400000)) : null;

      aiRuntimeStats.llmLastSeconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
      return {
        kind: 'dossier',
        narrated: true,
        narration: `Сведения по комплексу ${realId} (${String(point.address || 'адрес не указан')}) — статус: ${String(point.status || 'Не известно')}.`,
        cards: [
          {
            point_id: realId,
            address: String(point.address || ''),
            status: String(point.status || ''),
            power_source: String(point.power_source || ''),
            down_since: downSince,
            down_days: downDays,
            fault_reason: String(point.fault_reason || point.description || ''),
            fault_need: String(point.fault_need || ''),
            last_visit: lastVisit || '',
            visits_count: visitsCount,
            planned: planned.map((t) => `${formatDateRu(t.date)} (${t.type || 'работы'})`),
            groups,
          },
        ],
        description: 'Собрано из справочника комплексов, истории выездов и календаря.',
        computed_at: computedAt,
        checked_at: computedAt,
        refreshable: true,
        source: 'preset',
      };
    }
  }

  // Fast rule-based answers for standard questions
  if (qLow.includes('сколько') && qLow.includes('не работает')) {
    const cnt = (db.prepare("SELECT COUNT(*) AS cnt FROM points WHERE status = 'Не работает'").get() as { cnt: number }).cnt;
    return {
      kind: 'number',
      value: cnt,
      label: 'комплексов со статусом «Не работает»',
      narrated: true,
      narration: `Сейчас в статусе «Не работает» находится ${cnt} комплекс(ов).`,
      description: "SELECT COUNT(*) FROM points WHERE status = 'Не работает'",
      computed_at: computedAt,
      checked_at: computedAt,
      refreshable: true,
      source: 'preset',
    };
  }

  const ai = getAiClient();
  const snapshot = buildRoleDataSnapshot(perms);
  if (ai) {
    aiRuntimeStats.llmBusy = true;
    try {
      const prompt = [
        'Ты — внутренний помощник системы учёта дорожных комплексов ЦОДД (СОТ/АПК).',
        'Отвечай на русском языке кратко, чётко и строго на основе переданных данных SQLite (не выдумывай комплексы и цифры).',
        `Режим: ${mode}. Права доступа уже учтены в срезе данных.`,
        `Данные системы (JSON): ${JSON.stringify(snapshot).slice(0, 28000)}`,
        `Вопрос пользователя: ${question}`,
      ].join('\n\n');

      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: prompt,
      });
      const text = (response.text || '').trim() || 'Не удалось сформировать ответ по имеющимся данным.';
      aiRuntimeStats.llmLastSeconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
      return {
        kind: 'text',
        narrated: true,
        narration: text,
        text,
        description: 'Ответ сформирован моделью по текущему срезу данных вашей роли.',
        computed_at: computedAt,
        checked_at: computedAt,
        refreshable: true,
      };
    } finally {
      aiRuntimeStats.llmBusy = false;
    }
  }

  // Fallback summary if no GEMINI_API_KEY
  const totalPoints = (db.prepare('SELECT COUNT(*) AS cnt FROM points').get() as { cnt: number }).cnt;
  const downPoints = (db.prepare("SELECT COUNT(*) AS cnt FROM points WHERE status = 'Не работает'").get() as { cnt: number }).cnt;
  const todayTasks = (db.prepare('SELECT COUNT(*) AS cnt FROM tasks WHERE date = ?').get(todayIso()) as { cnt: number }).cnt;
  aiRuntimeStats.llmLastSeconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
  return {
    kind: 'text',
    narrated: true,
    narration: `Ключ GEMINI_API_KEY не задан, поэтому отвечаю по прямой сводке базы: всего комплексов — ${totalPoints}, не работает — ${downPoints}, заданий на сегодня (${formatDateRu(todayIso())}) — ${todayTasks}. Укажите номер комплекса (например, P-2), чтобы получить карточку.`,
    text: `Всего комплексов: ${totalPoints}, не работает: ${downPoints}, заданий на сегодня: ${todayTasks}.`,
    description: 'Прямая сводка SQLite.',
    computed_at: computedAt,
    checked_at: computedAt,
    refreshable: true,
  };
}

// ---------------------------------------------------------------------------
// ROUTER EXPORT
// ---------------------------------------------------------------------------

export function createStatsAndExtrasRouter(): Router {
  const router = Router();

  // ================= STATS =================
  router.get('/api/stats/summary', requirePasswordOk, (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateFrom) || !/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      res.status(400).json({ detail: 'Неверный формат даты' });
      return;
    }
    if (dateFrom > dateTo) {
      res.status(400).json({ detail: 'Начальная дата позже конечной' });
      return;
    }
    res.json(computeStatsSummary(dateFrom, dateTo));
  });

  router.get('/api/stats/status-export', requirePasswordOk, async (_req, res) => {
    const buf = await buildStatusExportBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="status-apk-${formatDateRu(todayIso())}.xlsx"`);
    res.send(buf);
  });

  // ================= STAT COUNTERS =================
  router.get('/api/stat-counters', requirePasswordOk, (_req, res) => {
    const db = getDb();
    const counters = db
      .prepare('SELECT id, name, filters, sort_order, created_at, created_by FROM stat_counters ORDER BY sort_order, id')
      .all() as Array<{
        id: number;
        name: string;
        filters: string;
        sort_order: number;
        created_at: string;
        created_by: string;
      }>;
    const data = new CounterDataset(todayIso());
    const groupNames = getGroupNamesMap();
    const out = counters.map((c) => {
      const rawFilters = parseJsonSafe<unknown>(c.filters, {});
      try {
        const f = normalizeCounterFilters(rawFilters);
        const ev = evaluateCounter(f, data);
        return {
          id: c.id,
          name: c.name,
          filters: f,
          created_by: c.created_by,
          created_at: c.created_at,
          summary: describeCounter(f, groupNames),
          result: formatCounterResult(f, ev, data.points.length),
        };
      } catch (err) {
        return {
          id: c.id,
          name: c.name,
          filters: rawFilters,
          created_by: c.created_by,
          created_at: c.created_at,
          summary: [],
          result: null,
          error: (err as Error).message,
        };
      }
    });
    res.json({ counters: out });
  });

  router.get('/api/stat-counters/options', requirePasswordOk, (_req, res) => {
    const db = getDb();
    const cats = (db.prepare('SELECT name FROM point_categories ORDER BY lower(name)').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    const stRows = (db.prepare('SELECT name FROM point_statuses ORDER BY id').all() as Array<{ name: string }>).map(
      (r) => r.name,
    );
    const stSet = new Set(stRows);
    const ptSt = db
      .prepare("SELECT DISTINCT status FROM points WHERE trim(status) != ''")
      .all() as Array<{ status: string }>;
    const extras = ptSt.map((r) => r.status.trim()).filter((s) => s && !stSet.has(s)).sort();
    const groups = db
      .prepare("SELECT id, name FROM apk_groups ORDER BY (kind = ''), lower(name), id")
      .all() as Array<{ id: number; name: string }>;
    res.json({
      categories: [...cats, NO_CATEGORY],
      statuses: [...stRows, ...extras, UNKNOWN_STATUS],
      power: [...POWER_SOURCES, NO_POWER],
      work_types: workTypeNames(),
      visit_results: [...RESULT_STATUSES],
      groups,
    });
  });

  router.post('/api/stat-counters/preview', requirePasswordOk, (req, res) => {
    try {
      const f = normalizeCounterFilters((req.body || {}).filters);
      const data = new CounterDataset(todayIso());
      const ev = evaluateCounter(f, data);
      res.json({
        filters: f,
        summary: describeCounter(f, getGroupNamesMap()),
        result: formatCounterResult(f, ev, data.points.length),
      });
    } catch (err) {
      res.status(400).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/stat-counters/points', requirePasswordOk, (req, res) => {
    try {
      res.json(computeCounterPoints((req.body || {}).filters));
    } catch (err) {
      res.status(400).json({ detail: (err as Error).message });
    }
  });

  router.get('/api/stat-counters/:counterId/export', requirePasswordOk, async (req, res) => {
    const id = Number(req.params.counterId);
    const db = getDb();
    const counter = db.prepare('SELECT id, name, filters FROM stat_counters WHERE id = ?').get(id) as
      | { id: number; name: string; filters: string }
      | undefined;
    if (!counter) {
      res.status(404).json({ detail: 'Счётчик не найден' });
      return;
    }
    const data = computeCounterPoints(parseJsonSafe(counter.filters, {}));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Комплексы');
    const head = ['Номер', 'Адрес', 'Категория', 'Статус', 'Поверка до', 'Питание', 'Выездов за период', 'Смен статуса за период', 'Дней в текущем статусе'];
    ws.addRow(head);
    ws.getRow(1).eachCell((c) => {
      c.font = { bold: true };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDDE6F7' } };
      c.alignment = { vertical: 'middle', wrapText: true };
    });
    for (const r of data.rows) {
      ws.addRow([
        safeCell(r.id),
        safeCell(r.address),
        safeCell(r.category),
        safeCell(r.status),
        r.verification,
        safeCell(r.power),
        r.visits,
        r.changes,
        r.days_in_status,
      ]);
    }
    [22, 46, 20, 18, 14, 14, 12, 14, 14].forEach((w, idx) => {
      ws.getColumn(idx + 1).width = w;
    });
    ws.views = [{ state: 'frozen', ySplit: 1 }];

    const info = wb.addWorksheet('Условия');
    info.addRow(['Счётчик', safeCell(counter.name)]).getCell(1).font = { bold: true };
    info.addRow(['Число', data.result.count]).getCell(1).font = { bold: true };
    if (data.result.what !== 'points') {
      info.addRow(['Комплексов, на которых посчитано', data.result.points]);
    }
    info.addRow(['Всего комплексов в справочнике', data.result.total]);
    if (data.period) {
      info.addRow(['Даты периода', `${formatDateRu(data.period.from)} — ${formatDateRu(data.period.to)}`]);
    }
    info.addRow([]);
    info.addRow(['Условия']).getCell(1).font = { bold: true };
    for (const line of data.summary) info.addRow([safeCell(line)]);
    info.getColumn(1).width = 44;
    info.getColumn(2).width = 48;

    const buf = Buffer.from(await wb.xlsx.writeBuffer());
    const encoded = encodeURIComponent(`Счётчик ${counter.name}.xlsx`);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="schetchik-${todayIso()}.xlsx"; filename*=UTF-8''${encoded}`);
    res.send(buf);
  });

  router.post('/api/stat-counters', requirePasswordOk, (req: AuthedRequest, res) => {
    const db = getDb();
    const name = String((req.body || {}).name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
    if (!name) {
      res.status(400).json({ detail: 'Впишите название счётчика' });
      return;
    }
    let f: CounterFilters;
    try {
      f = normalizeCounterFilters((req.body || {}).filters);
    } catch (err) {
      res.status(400).json({ detail: (err as Error).message });
      return;
    }
    const cnt = (db.prepare('SELECT COUNT(*) AS cnt FROM stat_counters').get() as { cnt: number }).cnt;
    if (cnt >= MAX_COUNTERS) {
      res.status(400).json({ detail: `Слишком много счётчиков (не больше ${MAX_COUNTERS}) — удалите ненужные` });
      return;
    }
    const maxSort = (db.prepare('SELECT COALESCE(MAX(sort_order), 0) AS m FROM stat_counters').get() as { m: number }).m;
    const now = nowIso();
    const info = db
      .prepare('INSERT INTO stat_counters (name, filters, sort_order, created_at, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(name, JSON.stringify(f), maxSort + 1, now, req.sessionUser?.username || '');
    const id = Number(info.lastInsertRowid);
    const data = new CounterDataset(todayIso());
    const ev = evaluateCounter(f, data);
    res.status(201).json({
      id,
      name,
      filters: f,
      created_by: req.sessionUser?.username || '',
      created_at: now,
      summary: describeCounter(f, getGroupNamesMap()),
      result: formatCounterResult(f, ev, data.points.length),
    });
  });

  router.put('/api/stat-counters/:counterId', requirePasswordOk, (req, res) => {
    const id = Number(req.params.counterId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM stat_counters WHERE id = ?').get(id) as
      | { id: number; name: string; filters: string; created_at: string; created_by: string }
      | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Счётчик не найден' });
      return;
    }
    const body = req.body || {};
    const name =
      body.name !== undefined
        ? String(body.name || '').trim().replace(/\s+/g, ' ').slice(0, 80)
        : existing.name;
    if (!name) {
      res.status(400).json({ detail: 'Впишите название счётчика' });
      return;
    }
    let f: CounterFilters;
    try {
      f = normalizeCounterFilters(body.filters !== undefined ? body.filters : parseJsonSafe(existing.filters, {}));
    } catch (err) {
      res.status(400).json({ detail: (err as Error).message });
      return;
    }
    db.prepare('UPDATE stat_counters SET name = ?, filters = ? WHERE id = ?').run(name, JSON.stringify(f), id);
    const data = new CounterDataset(todayIso());
    const ev = evaluateCounter(f, data);
    res.json({
      id,
      name,
      filters: f,
      created_by: existing.created_by,
      created_at: existing.created_at,
      summary: describeCounter(f, getGroupNamesMap()),
      result: formatCounterResult(f, ev, data.points.length),
    });
  });

  router.post('/api/stat-counters/:counterId/move', requirePasswordOk, (req, res) => {
    const id = Number(req.params.counterId);
    const dir = Number((req.body || {}).direction);
    const db = getDb();
    const rows = db.prepare('SELECT id FROM stat_counters ORDER BY sort_order, id').all() as Array<{ id: number }>;
    const idx = rows.findIndex((r) => r.id === id);
    if (idx < 0) {
      res.status(404).json({ detail: 'Счётчик не найден' });
      return;
    }
    const target = dir < 0 ? idx - 1 : idx + 1;
    if (target >= 0 && target < rows.length) {
      const ids = rows.map((r) => r.id);
      const tmp = ids[idx];
      ids[idx] = ids[target];
      ids[target] = tmp;
      const upd = db.prepare('UPDATE stat_counters SET sort_order = ? WHERE id = ?');
      ids.forEach((cid, i) => upd.run(i + 1, cid));
    }
    res.json({ ok: true });
  });

  router.delete('/api/stat-counters/:counterId', requirePasswordOk, (req, res) => {
    const id = Number(req.params.counterId);
    const db = getDb();
    const info = db.prepare('DELETE FROM stat_counters WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ detail: 'Счётчик не найден' });
      return;
    }
    res.json({ ok: true });
  });

  // ================= GAMES =================
  router.get('/api/games/me', requirePasswordOk, (req: AuthedRequest, res) => {
    const uid = req.sessionUser!.id;
    const keys = allowedGameKeys(uid);
    if (!keys) {
      res.json({ enabled: false, games: [], bests: {}, categories: [] });
      return;
    }
    const db = getDb();
    const rows = db.prepare('SELECT game, best, plays FROM game_scores WHERE user_id = ?').all(uid) as Array<{
      game: string;
      best: number;
      plays: number;
    }>;
    const bests: Record<string, { best: number; plays: number }> = {};
    for (const r of rows) bests[r.game] = { best: r.best, plays: r.plays };
    res.json({
      enabled: true,
      games: publicGameCatalog(keys),
      bests,
      categories: GAME_CATEGORIES,
    });
  });

  router.get('/api/games/leaderboard', requirePasswordOk, (req: AuthedRequest, res) => {
    const uid = req.sessionUser!.id;
    const game = String(req.query.game || '');
    const keys = allowedGameKeys(uid);
    if (!keys) {
      res.status(403).json({ detail: 'Игры вам не включены — их включает администратор (Администрирование → Игры)' });
      return;
    }
    if (!keys.includes(game)) {
      res.status(403).json({ detail: 'Эта игра вам не включена' });
      return;
    }
    const board = getGameLeaderboard(game, uid);
    if (!board) {
      res.status(404).json({ detail: 'Такой игры нет' });
      return;
    }
    res.json(board);
  });

  router.post('/api/games/score', requirePasswordOk, (req: AuthedRequest, res) => {
    const uid = req.sessionUser!.id;
    const game = String((req.body || {}).game || '').slice(0, 32);
    const meta = GAMES_BY_KEY.get(game);
    if (!meta) {
      res.status(404).json({ detail: 'Такой игры нет' });
      return;
    }
    const keys = allowedGameKeys(uid);
    if (!keys || !keys.includes(game)) {
      res.status(403).json({ detail: 'Эта игра вам не включена' });
      return;
    }
    const rawVal = Number((req.body || {}).score);
    if (!Number.isFinite(rawVal) || rawVal < meta.min || rawVal > meta.max) {
      res.status(400).json({ detail: 'Недопустимый результат' });
      return;
    }
    const rateKey = `${uid}:${game}`;
    const nowMs = Date.now();
    const prevMs = LAST_GAME_SUBMIT.get(rateKey) || 0;
    if (nowMs - prevMs < 2000) {
      res.status(429).json({ detail: 'Слишком часто — подождите пару секунд' });
      return;
    }
    LAST_GAME_SUBMIT.set(rateKey, nowMs);

    const value = Math.round(rawVal * 100) / 100;
    const db = getDb();
    const row = db.prepare('SELECT best, plays FROM game_scores WHERE user_id = ? AND game = ?').get(uid, game) as
      | { best: number; plays: number }
      | undefined;
    const stamp = nowIso();
    let best = value;
    let isRecord = true;
    let plays = 1;
    if (!row) {
      db.prepare('INSERT INTO game_scores (user_id, game, best, plays, best_at, last_at) VALUES (?, ?, ?, 1, ?, ?)').run(
        uid,
        game,
        value,
        stamp,
        stamp,
      );
    } else {
      isRecord = meta.better === 'low' ? value < row.best : value > row.best;
      best = isRecord ? value : row.best;
      plays = row.plays + 1;
      db.prepare(
        `UPDATE game_scores
         SET best = ?, plays = plays + 1, best_at = CASE WHEN ? THEN ? ELSE best_at END, last_at = ?
         WHERE user_id = ? AND game = ?`,
      ).run(best, isRecord ? 1 : 0, stamp, stamp, uid, game);
    }
    const board = getGameLeaderboard(game, uid, 1);
    res.json({ best, is_record: isRecord, rank: board?.me?.rank ?? null, plays });
  });

  router.get('/api/admin/games', requirePerm('admin.users'), (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT u.id, u.username, u.role, COALESCE(g.enabled, 0) AS enabled, g.games,
                (SELECT COUNT(*) FROM game_scores s WHERE s.user_id = u.id) AS games_played,
                (SELECT COALESCE(SUM(plays), 0) FROM game_scores s WHERE s.user_id = u.id) AS plays
         FROM users u
         LEFT JOIN user_games g ON g.user_id = u.id
         ORDER BY lower(u.username)`,
      )
      .all() as Array<{
        id: number;
        username: string;
        role: string;
        enabled: number;
        games: string | null;
        games_played: number;
        plays: number;
      }>;
    const users = rows.map((r) => {
      const parsed = r.games ? parseJsonSafe<string[] | null>(r.games, null) : null;
      return {
        id: r.id,
        username: r.username,
        role: r.role,
        enabled: Boolean(r.enabled),
        games: Array.isArray(parsed) ? parsed.filter((k) => GAMES_BY_KEY.has(k)) : null,
        games_played: r.games_played,
        plays: r.plays,
      };
    });
    res.json({ catalog: publicGameCatalog(), users });
  });

  router.put('/api/admin/games/users/:userId', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const userId = Number(req.params.userId);
    const db = getDb();
    const target = db.prepare('SELECT id, username FROM users WHERE id = ?').get(userId) as
      | { id: number; username: string }
      | undefined;
    if (!target) {
      res.status(404).json({ detail: 'Пользователь не найден' });
      return;
    }
    const enabled = Boolean((req.body || {}).enabled);
    const games = (req.body || {}).games as string[] | null | undefined;
    if (Array.isArray(games)) {
      const unknown = games.filter((k) => !GAMES_BY_KEY.has(k));
      if (unknown.length) {
        res.status(400).json({ detail: `Неизвестные игры: ${unknown.join(', ')}` });
        return;
      }
    }
    const clean = games == null ? null : Array.from(new Set(games.filter((k) => GAMES_BY_KEY.has(k))));
    db.prepare(
      'INSERT INTO user_games (user_id, enabled, games) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled, games = excluded.games',
    ).run(userId, enabled ? 1 : 0, clean === null ? null : JSON.stringify(clean));
    recordSecurityEvent('games_access', {
      username: req.sessionUser?.username,
      role: req.sessionUser?.role,
      ip: clientIp(req),
      details: { user: target.username, enabled, games: clean === null ? 'все' : clean.length },
    });
    res.json({ ok: true });
  });

  router.post('/api/admin/games/bulk', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const enabled = Boolean((req.body || {}).enabled);
    const db = getDb();
    db.prepare('INSERT OR IGNORE INTO user_games (user_id, enabled, games) SELECT id, 0, NULL FROM users').run();
    const info = db.prepare('UPDATE user_games SET enabled = ?').run(enabled ? 1 : 0);
    recordSecurityEvent('games_access', {
      username: req.sessionUser?.username,
      role: req.sessionUser?.role,
      ip: clientIp(req),
      details: { user: 'все', enabled, count: info.changes },
    });
    res.json({ changed: info.changes });
  });

  router.post('/api/admin/games/reset-scores', requirePerm('admin.users'), (req: AuthedRequest, res) => {
    const body = req.body || {};
    const game = body.game ? String(body.game) : null;
    const userId = body.user_id != null ? Number(body.user_id) : null;
    if (game && !GAMES_BY_KEY.has(game)) {
      res.status(400).json({ detail: 'Такой игры нет' });
      return;
    }
    const db = getDb();
    let sql = 'DELETE FROM game_scores';
    const conds: string[] = [];
    const params: Array<string | number> = [];
    if (game) {
      conds.push('game = ?');
      params.push(game);
    }
    if (userId != null) {
      conds.push('user_id = ?');
      params.push(userId);
    }
    if (conds.length) sql += ` WHERE ${conds.join(' AND ')}`;
    const info = db.prepare(sql).run(...params);
    recordSecurityEvent('games_reset', {
      username: req.sessionUser?.username,
      role: req.sessionUser?.role,
      ip: clientIp(req),
      details: { game: game || 'все', user_id: userId ?? 'все', removed: info.changes },
    });
    res.json({ removed: info.changes });
  });

  // ================= WEATHER =================
  router.get('/api/weather', async (_req, res) => {
    const cfg = loadWeatherConfig();
    const ttlMs = cfg.refresh_minutes * 60 * 1000;
    const keyTail = (cfg.yandex_key || process.env.YANDEX_WEATHER_API_KEY || '').slice(-6);
    const sig = `${cfg.source}|${cfg.lat}|${cfg.lon}|${keyTail}`;
    if (weatherCache.sig !== sig) weatherCache = { at: 0, failedAt: 0, sig, data: null };

    const now = Date.now();
    if (weatherCache.data && now - weatherCache.at < ttlMs) {
      res.setHeader('Cache-Control', `public, max-age=${Math.min(600, cfg.refresh_minutes * 30)}`);
      res.json(weatherCache.data);
      return;
    }
    if (weatherCache.failedAt && now - weatherCache.failedAt < 180000) {
      res.json(
        weatherCache.data || {
          ok: false,
          browser_fallback: cfg.source === 'auto' || cfg.source === 'open_meteo',
          city: cfg.city,
          lat: cfg.lat,
          lon: cfg.lon,
          refresh_minutes: cfg.refresh_minutes,
        },
      );
      return;
    }

    const fresh = await fetchWeatherBySource(cfg);
    if (fresh) {
      weatherCache = { at: Date.now(), failedAt: 0, sig, data: fresh };
      res.setHeader('Cache-Control', `public, max-age=${Math.min(600, cfg.refresh_minutes * 30)}`);
      res.json(fresh);
      return;
    }
    weatherCache.failedAt = Date.now();
    res.json(
      weatherCache.data || {
        ok: false,
        browser_fallback: cfg.source === 'auto' || cfg.source === 'open_meteo',
        city: cfg.city,
        lat: cfg.lat,
        lon: cfg.lon,
        refresh_minutes: cfg.refresh_minutes,
      },
    );
  });

  router.get('/api/weather/settings', requirePerm('admin.settings'), (_req, res) => {
    res.json(publicWeatherConfig(loadWeatherConfig()));
  });

  router.put('/api/weather/settings', requirePerm('admin.settings'), (req, res) => {
    const b = req.body || {};
    if (b.source && !WEATHER_SOURCE_IDS.has(String(b.source))) {
      res.status(400).json({ detail: 'Неизвестный источник погоды' });
      return;
    }
    const ref = Number(b.refresh_minutes);
    if (b.refresh_minutes != null && (ref < WEATHER_MIN_REFRESH || ref > WEATHER_MAX_REFRESH)) {
      res.status(400).json({ detail: `Периодичность — от ${WEATHER_MIN_REFRESH} до ${WEATHER_MAX_REFRESH} минут` });
      return;
    }
    const lat = Number(b.lat);
    const lon = Number(b.lon);
    if ((b.lat != null && (lat < -90 || lat > 90)) || (b.lon != null && (lon < -180 || lon > 180))) {
      res.status(400).json({ detail: 'Широта — от −90 до 90, долгота — от −180 до 180' });
      return;
    }
    const cfg = saveWeatherConfig(b);
    res.json(publicWeatherConfig(cfg));
  });

  router.post('/api/weather/test', requirePerm('admin.settings'), async (req, res) => {
    const saved = loadWeatherConfig();
    const b = req.body || {};
    const cfg = cleanWeatherConfig({
      ...saved,
      ...b,
      yandex_key: b.yandex_key === null || b.yandex_key === undefined ? saved.yandex_key : String(b.yandex_key),
    });
    const results: Array<Record<string, unknown>> = [];
    const key = (cfg.yandex_key || process.env.YANDEX_WEATHER_API_KEY || '').trim();
    if (cfg.source === 'sky') {
      results.push({
        source: 'время суток',
        ok: true,
        code: 'clear',
        desc: 'ясно',
        temp: null,
        error: '',
        cloud: 0.05,
        precip: 0,
        wind: 2.0,
        ms: 0,
      });
    } else {
      if (cfg.source === 'auto' && !key) {
        results.push({ source: 'Яндекс.Погода', ok: false, code: '', desc: '', temp: null, error: 'пропущена: ключ не задан', ms: 0 });
      }
      if (cfg.source === 'yandex' || (cfg.source === 'auto' && key)) {
        const t0 = Date.now();
        try {
          const r = withWeatherLevels(await fetchFromYandex(cfg, key));
          results.push({
            source: 'Яндекс.Погода',
            ok: true,
            code: r.code,
            desc: WEATHER_DESCS[r.code] || '',
            temp: r.temp ?? null,
            error: '',
            cloud: r.cloud,
            precip: r.precip,
            wind: r.wind,
            ms: Date.now() - t0,
          });
        } catch (err) {
          results.push({ source: 'Яндекс.Погода', ok: false, code: '', desc: '', temp: null, error: (err as Error).message, ms: Date.now() - t0 });
        }
      }
      if (cfg.source === 'open_meteo' || cfg.source === 'auto' || cfg.source === 'eol') {
        const t0 = Date.now();
        try {
          const r = withWeatherLevels(await fetchFromOpenMeteo(cfg));
          results.push({
            source: 'Open-Meteo',
            ok: true,
            code: r.code,
            desc: WEATHER_DESCS[r.code] || '',
            temp: r.temp ?? null,
            error: '',
            cloud: r.cloud,
            precip: r.precip,
            wind: r.wind,
            ms: Date.now() - t0,
          });
        } catch (err) {
          results.push({ source: 'Open-Meteo', ok: false, code: '', desc: '', temp: null, error: (err as Error).message, ms: Date.now() - t0 });
        }
      }
    }
    res.json({ results, ok: results.some((r) => r.ok) });
  });

  // ================= LIVE MAPS & YANDEX ROBOT =================
  router.get('/api/live-maps', requirePasswordOk, (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT * FROM live_maps ORDER BY id').all() as Array<Record<string, unknown>>;
    res.json({
      items: rows.map(publicLiveMap),
      intervals: LM_INTERVALS,
      kinds: LM_KIND_LABELS,
    });
  });

  router.post('/api/live-maps/preview', requirePasswordOk, (req, res) => {
    try {
      const b = req.body || {};
      const params = normalizeLiveMapParams(String(b.kind || ''), b.params);
      const { points, unknown } = selectLiveMapPoints(String(b.kind || ''), params);
      const withCoords = points.filter(hasValidCoords).length;
      res.json({
        total: points.length,
        with_coords: withCoords,
        unknown: unknown.slice(0, 30),
        sample: points.slice(0, 8).map((p) => p.id),
      });
    } catch (err) {
      res.status(400).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/live-maps', requirePasswordOk, (req: AuthedRequest, res) => {
    try {
      const b = req.body || {};
      const name = String(b.name || '').trim().slice(0, 80);
      if (!name) throw new Error('Впишите название карты');
      const kind = String(b.kind || '');
      const interval = LM_INTERVALS.includes(Number(b.interval_minutes)) ? Number(b.interval_minutes) : 5;
      const params = normalizeLiveMapParams(kind, b.params);
      let membership = kind === 'list' ? 'fixed' : String(b.membership || 'dynamic');
      if (kind === 'dropped') membership = 'dynamic';
      const { points, unknown } = selectLiveMapPoints(kind, params);
      const withCoords = points.filter(hasValidCoords).length;
      if (!withCoords) {
        throw new Error(
          'Под условие не подошло ни одного комплекса с координатами' +
            (unknown.length ? ` (не найдены: ${unknown.slice(0, 5).join(', ')})` : ''),
        );
      }
      const db = getDb();
      const now = nowIso();
      const info = db
        .prepare(
          `INSERT INTO live_maps (name, kind, params_json, membership, members_json, interval_minutes, enabled,
                                  map_id, url, rows_json, signature, synced_name, points_count, skipped, last_check_ts,
                                  last_sync, last_error, created_by, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, 1, '', '', '', '', '', ?, ?, 0, '', 'Робот карт Яндекса не подключён в этой среде', ?, ?, ?)`,
        )
        .run(
          name,
          kind,
          JSON.stringify(params),
          membership,
          JSON.stringify(points.map((p) => p.id)),
          interval,
          withCoords,
          points.length - withCoords,
          req.sessionUser?.username || '',
          now,
          now,
        );
      const created = db.prepare('SELECT * FROM live_maps WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<
        string,
        unknown
      >;
      res.status(201).json({ ...publicLiveMap(created), job_id: null, unknown: unknown.slice(0, 30) });
    } catch (err) {
      res.status(400).json({ detail: (err as Error).message });
    }
  });

  router.put('/api/live-maps/:mapId', requirePasswordOk, (req, res) => {
    const id = Number(req.params.mapId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM live_maps WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Карта не найдена' });
      return;
    }
    const b = req.body || {};
    const name = b.name !== undefined ? String(b.name || '').trim().slice(0, 80) : String(existing.name);
    if (!name) {
      res.status(400).json({ detail: 'Впишите название карты' });
      return;
    }
    const interval =
      b.interval_minutes !== undefined && LM_INTERVALS.includes(Number(b.interval_minutes))
        ? Number(b.interval_minutes)
        : Number(existing.interval_minutes);
    const enabled = b.enabled !== undefined ? (b.enabled ? 1 : 0) : Number(existing.enabled);
    let kind = String(existing.kind);
    const params = parseJsonSafe<Record<string, unknown>>(String(existing.params_json || '{}'), {});
    let membership = String(existing.membership);
    if (b.certificate !== undefined) {
      if (kind === 'access_cert') {
        kind = 'access';
      }
      params.certificate = String(b.certificate || '');
    }
    if (b.membership !== undefined) membership = String(b.membership);
    const { points } = selectLiveMapPoints(kind, params);
    const withCoords = points.filter(hasValidCoords).length;
    db.prepare(
      `UPDATE live_maps SET name = ?, kind = ?, params_json = ?, membership = ?, members_json = ?,
                            interval_minutes = ?, enabled = ?, points_count = ?, skipped = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      kind,
      JSON.stringify(params),
      membership,
      JSON.stringify(points.map((p) => p.id)),
      interval,
      enabled,
      withCoords,
      points.length - withCoords,
      nowIso(),
      id,
    );
    const updated = db.prepare('SELECT * FROM live_maps WHERE id = ?').get(id) as Record<string, unknown>;
    res.json(publicLiveMap(updated));
  });

  router.post('/api/live-maps/:mapId/sync', requirePasswordOk, async (req, res) => {
    const id = Number(req.params.mapId);
    const db = getDb();
    const row = db.prepare('SELECT * FROM live_maps WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Карта не найдена' });
      return;
    }
    const { points } = selectLiveMapPoints(String(row.kind), parseJsonSafe(String(row.params_json || '{}'), {}));
    const withCoords = points.filter(hasValidCoords).length;
    const robotRows = points
      .filter(hasValidCoords)
      .map((p) => ({
        id: p.id,
        lat: Number(p.lat),
        lon: Number(p.lon),
        address: p.address || '',
        status: p.status || '',
      }));
    try {
      const r = await callRobot('POST', '/maps/sync', {
        json: {
          name: String(row.name),
          map_id: String(row.map_id || ''),
          points: robotRows,
        },
        timeoutMs: 30000,
      });
      const rData = (r.jsonData || {}) as Record<string, unknown>;
      db.prepare('UPDATE live_maps SET points_count = ?, skipped = ?, map_id = COALESCE(NULLIF(?, \'\'), map_id), url = COALESCE(NULLIF(?, \'\'), url), last_sync = ?, last_error = \'\', updated_at = ? WHERE id = ?').run(
        withCoords,
        points.length - withCoords,
        String(rData.map_id || ''),
        String(rData.url || ''),
        nowIso(),
        nowIso(),
        id,
      );
      res.json({
        job_id: rData.job_id || null,
        uptodate: Boolean(rData.uptodate),
        points: withCoords,
        kind: String(rData.kind || 'sync'),
        summary: String(rData.summary || 'Обновление запущено'),
      });
    } catch (err) {
      db.prepare('UPDATE live_maps SET points_count = ?, skipped = ?, last_error = ?, updated_at = ? WHERE id = ?').run(
        withCoords,
        points.length - withCoords,
        (err as Error).message,
        nowIso(),
        id,
      );
      if (err instanceof RobotUnavailableError) {
        res.json({ job_id: null, uptodate: true, points: withCoords, kind: 'none', summary: err.message });
      } else {
        res.status(502).json({ detail: (err as Error).message });
      }
    }
  });

  router.post('/api/live-maps/:mapId/rebuild', requirePasswordOk, async (req, res) => {
    const id = Number(req.params.mapId);
    const db = getDb();
    const row = db.prepare('SELECT * FROM live_maps WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Карта не найдена' });
      return;
    }
    const { points } = selectLiveMapPoints(String(row.kind), parseJsonSafe(String(row.params_json || '{}'), {}));
    const withCoords = points.filter(hasValidCoords).length;
    db.prepare('UPDATE live_maps SET members_json = ?, points_count = ?, skipped = ?, updated_at = ? WHERE id = ?').run(
      JSON.stringify(points.map((p) => p.id)),
      withCoords,
      points.length - withCoords,
      nowIso(),
      id,
    );
    try {
      const r = await callRobot('POST', '/maps/sync', {
        json: {
          name: String(row.name),
          map_id: String(row.map_id || ''),
          points: points.filter(hasValidCoords).map((p) => ({
            id: p.id,
            lat: Number(p.lat),
            lon: Number(p.lon),
            address: p.address || '',
            status: p.status || '',
          })),
        },
        timeoutMs: 30000,
      });
      const rData = (r.jsonData || {}) as Record<string, unknown>;
      res.json({
        members: points.length,
        job_id: rData.job_id || null,
        uptodate: Boolean(rData.uptodate),
        points: withCoords,
      });
    } catch {
      res.json({ members: points.length, job_id: null, uptodate: true, points: withCoords });
    }
  });

  router.delete('/api/live-maps/:mapId', requirePasswordOk, (req, res) => {
    const id = Number(req.params.mapId);
    const db = getDb();
    const info = db.prepare('DELETE FROM live_maps WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ detail: 'Карта не найдена' });
      return;
    }
    res.json({ ok: true });
  });

  // Yandex Robot proxy + fallback endpoints
  function robotProfileParam(req: Request): Record<string, string> {
    const profile = String(req.query.profile || 'maps') === 'forms' ? 'forms' : 'maps';
    return profile === 'maps' ? {} : { profile };
  }

  async function proxyRobotJson(
    req: Request,
    res: Response,
    method: string,
    robotPath: string,
    opts: { params?: Record<string, string | number | boolean | undefined>; json?: unknown; timeoutMs?: number } = {},
  ) {
    try {
      const resp = await callRobot(method, robotPath, opts);
      res.json(resp.jsonData ?? { ok: true });
    } catch (err) {
      if (err instanceof RobotUnavailableError) {
        res.status(503).json({ detail: err.message });
      } else if (err instanceof RobotRejectedError) {
        res.status(err.statusCode).json({ detail: err.message });
      } else {
        res.status(502).json({ detail: (err as Error).message });
      }
    }
  }

  router.get('/api/yandex-robot/status', requirePasswordOk, async (req, res) => {
    const verify = req.query.verify === '1' || req.query.verify === 'true' ? '1' : undefined;
    const check = typeof req.query.check === 'string' ? req.query.check : undefined;
    try {
      const resp = await callRobot('GET', '/status', {
        params: { verify, check, ...robotProfileParam(req) },
        timeoutMs: verify ? 220000 : 10000,
      });
      res.json(resp.jsonData);
    } catch (err) {
      if (err instanceof RobotUnavailableError) {
        res.json({
          available: false,
          logged_in: false,
          login: '',
          busy: false,
          message: err.message,
          viewport: null,
        });
      } else if (err instanceof RobotRejectedError) {
        res.status(err.statusCode).json({ detail: err.message });
      } else {
        res.status(502).json({ detail: (err as Error).message });
      }
    }
  });

  router.get('/api/yandex-robot/view', requirePerm('admin.settings'), async (req, res) => {
    const after = req.query.after !== undefined ? String(req.query.after) : '-1';
    const wait = Math.min(5, Math.max(0, Number(req.query.wait || 0)));
    try {
      const resp = await callRobot('GET', '/view', {
        params: { after, wait, ...robotProfileParam(req) },
        timeoutMs: wait * 1000 + 20000,
        raw: true,
      });
      for (const h of ['x-frame-seq', 'x-view-width', 'x-view-height']) {
        const val = resp.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Cache-Control', 'no-store');
      if (resp.status === 204) {
        res.status(204).end();
        return;
      }
      if (resp.status >= 400) {
        res.status(resp.status).json({ detail: 'Кадр недоступен' });
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.send(resp.body);
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 502).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/yandex-robot/view/open', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/view/open', { params: robotProfileParam(req), json: req.body || {}, timeoutMs: 60000 }),
  );
  router.post('/api/yandex-robot/view/click', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/view/click', { params: robotProfileParam(req), json: req.body || {} }),
  );
  router.post('/api/yandex-robot/view/type', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/view/type', { params: robotProfileParam(req), json: req.body || {} }),
  );
  router.post('/api/yandex-robot/view/key', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/view/key', { params: robotProfileParam(req), json: req.body || {} }),
  );
  router.post('/api/yandex-robot/view/scroll', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/view/scroll', { params: robotProfileParam(req), json: req.body || {} }),
  );
  router.post('/api/yandex-robot/view/resize', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/view/resize', { params: robotProfileParam(req), json: req.body || {} }),
  );
  router.post('/api/yandex-robot/audio/start', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/audio/start', { params: robotProfileParam(req) }),
  );
  router.get('/api/yandex-robot/audio', requirePerm('admin.settings'), async (req, res) => {
    const after = req.query.after !== undefined ? String(req.query.after) : '-1';
    const wait = Math.min(5, Math.max(0, Number(req.query.wait || 0)));
    try {
      const resp = await callRobot('GET', '/audio', {
        params: { after, wait, ...robotProfileParam(req) },
        timeoutMs: wait * 1000 + 20000,
        raw: true,
      });
      for (const h of ['x-audio-seq', 'x-audio-stream']) {
        const val = resp.headers.get(h);
        if (val) res.setHeader(h, val);
      }
      res.setHeader('Cache-Control', 'no-store');
      if (resp.status === 204) {
        res.status(204).end();
        return;
      }
      if (resp.status >= 400) {
        res.status(resp.status).json({ detail: 'Звук недоступен' });
        return;
      }
      res.setHeader('Content-Type', 'audio/webm');
      res.send(resp.body);
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 502).json({ detail: (err as Error).message });
    }
  });
  router.post('/api/yandex-robot/logout', requirePerm('admin.settings'), (req, res) =>
    proxyRobotJson(req, res, 'POST', '/account/logout', { params: robotProfileParam(req) }),
  );

  const getRobotSettings = () => {
    const db = getDb();
    const rows = db.prepare('SELECT key, value FROM yandex_robot_settings').all() as Array<{ key: string; value: string }>;
    const map = new Map(rows.map((r) => [r.key, r.value]));
    const mapsTotal = (db.prepare('SELECT COUNT(*) AS cnt FROM yandex_maps').get() as { cnt: number }).cnt;
    const trashTotal = (db.prepare('SELECT COUNT(*) AS cnt FROM yandex_trash').get() as { cnt: number }).cnt;
    return {
      auto_sync: map.get('auto_sync') === '1',
      sync_days_ahead: Number(map.get('sync_days_ahead') || 1),
      auto_delete: map.get('auto_delete') === '1',
      auto_delete_days: Number(map.get('auto_delete_days') || 30),
      maps_total: mapsTotal,
      trash_total: trashTotal,
      last_tick: null,
      last_message: '',
      last_error: '',
    };
  };

  router.get('/api/yandex-robot/settings', requirePerm('admin.settings'), (_req, res) => {
    res.json(getRobotSettings());
  });

  router.put('/api/yandex-robot/settings', requirePerm('admin.settings'), (req, res) => {
    const b = req.body || {};
    const db = getDb();
    const upsert = db.prepare(
      'INSERT INTO yandex_robot_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    if (typeof b.auto_sync === 'boolean') upsert.run('auto_sync', b.auto_sync ? '1' : '0');
    if (b.sync_days_ahead != null) upsert.run('sync_days_ahead', String(Math.max(0, Math.min(14, Number(b.sync_days_ahead)))));
    if (typeof b.auto_delete === 'boolean') upsert.run('auto_delete', b.auto_delete ? '1' : '0');
    if (b.auto_delete_days != null) upsert.run('auto_delete_days', String(Math.max(1, Math.min(365, Number(b.auto_delete_days)))));
    res.json(getRobotSettings());
  });

  router.get('/api/yandex-robot/netcheck', requirePerm('admin.settings'), async (_req, res) => {
    try {
      const resp = await callRobot('GET', '/netcheck', { timeoutMs: 40000 });
      res.json(resp.jsonData);
      return;
    } catch {
      // Fallback to direct check from server container
    }
    const hosts = [
      { host: 'yandex.ru', purpose: 'Основной домен Яндекса', required: true },
      { host: 'yandex.ru/map-constructor/', purpose: 'Конструктор карт', required: true },
      { host: 'forms.yandex.ru', purpose: 'Яндекс Формы', required: false },
    ];
    const items = await Promise.all(
      hosts.map(async (h) => {
        const t0 = Date.now();
        try {
          const r = await fetchJsonTimeout(`https://${h.host}`, { method: 'HEAD' }, 4000);
          return { ...h, ok: r !== undefined, ms: Date.now() - t0, error: '' };
        } catch (err) {
          return { ...h, ok: false, ms: Date.now() - t0, error: (err as Error).message };
        }
      }),
    );
    res.json({ required_ok: items.filter((i) => i.required).every((i) => i.ok), items });
  });

  router.post('/api/yandex-robot/crews/:crewId/map', requirePasswordOk, async (req, res) => {
    const crewId = Number(req.params.crewId);
    const db = getDb();
    const crew = db.prepare('SELECT id, name, map_link FROM crews WHERE id = ?').get(crewId) as
      | { id: number; name: string; map_link: string | null }
      | undefined;
    if (!crew) {
      res.status(404).json({ detail: 'Бригада не найдена' });
      return;
    }
    const today = todayIso();
    const tasks = db
      .prepare(
        `SELECT t.id, t.point, t.address, t.work, p.lat, p.lon, p.status
         FROM tasks t
         LEFT JOIN points p ON p.id = t.point
         WHERE t.team = ? AND t.date = ?`,
      )
      .all(crewId, today) as Array<{
      id: string;
      point: string;
      address: string | null;
      work: string | null;
      lat: string | null;
      lon: string | null;
      status: string | null;
    }>;
    const withCoords = tasks.filter((t) => {
      const la = Number(t.lat);
      const lo = Number(t.lon);
      return Number.isFinite(la) && Number.isFinite(lo) && la !== 0 && lo !== 0;
    });
    if (withCoords.length === 0) {
      res.status(400).json({ detail: 'У бригады нет заданий с координатами точек на сегодня' });
      return;
    }
    try {
      const resp = await callRobot('POST', '/maps/sync', {
        json: {
          name: `${crew.name} (${formatDateRu(today)})`,
          url: crew.map_link || '',
          points: withCoords.map((t) => ({
            id: t.point,
            lat: Number(t.lat),
            lon: Number(t.lon),
            address: t.address || '',
            description: t.work || '',
            status: t.status || '',
          })),
        },
        timeoutMs: 30000,
      });
      const rData = (resp.jsonData || {}) as Record<string, unknown>;
      if (typeof rData.url === 'string' && rData.url) {
        db.prepare('UPDATE crews SET map_link = ? WHERE id = ?').run(rData.url, crewId);
      }
      res.json({
        job_id: rData.job_id || null,
        uptodate: Boolean(rData.uptodate),
        url: rData.url || crew.map_link || '',
        points: withCoords.length,
        skipped: tasks.length - withCoords.length,
        state: String(rData.state || 'running'),
        kind: String(rData.kind || 'create'),
        summary: String(rData.summary || ''),
      });
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 502).json({ detail: (err as Error).message });
    }
  });

  router.get('/api/yandex-robot/jobs/:jobId', requirePasswordOk, (req, res) =>
    proxyRobotJson(req, res, 'GET', `/jobs/${encodeURIComponent(req.params.jobId)}`),
  );

  router.get('/api/yandex-robot/jobs/:jobId/shot', requirePerm('admin.settings'), async (req, res) => {
    try {
      const resp = await callRobot('GET', `/jobs/${encodeURIComponent(req.params.jobId)}/shot`, { raw: true });
      if (resp.status >= 400) {
        res.status(404).json({ detail: 'Снимка нет' });
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(resp.body);
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 404).json({ detail: (err as Error).message });
    }
  });

  // ================= AI SETTINGS & AGENTS =================
  router.get('/api/ai/settings', requirePerm('admin.settings'), (_req, res) => {
    const db = getDb();
    const plansRow = db.prepare('SELECT COUNT(*) AS plans, COALESCE(SUM(hits), 0) AS hits FROM ai_plan_cache').get() as {
      plans: number;
      hits: number;
    };
    res.json({ config: loadAiConfig(), status: getAiStatus(), plans: plansRow });
  });

  router.put('/api/ai/settings', requirePerm('admin.settings'), (req, res) => {
    const cfg = saveAiConfig((req.body || {}) as Record<string, unknown>);
    res.json({ config: cfg, status: getAiStatus() });
  });

  router.get('/api/ai/status', requirePerm('admin.settings'), (_req, res) => {
    res.json(getAiStatus());
  });

  router.post('/api/ai/selftest', requirePerm('admin.settings'), async (_req, res) => {
    const ai = getAiClient();
    if (!ai) {
      res.status(503).json({ detail: 'GEMINI_API_KEY не задан в секретах окружения — проверьте настройки.' });
      return;
    }
    const started = Date.now();
    try {
      const response = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents:
          'Разбери короткий отчёт монтёра после выезда по ремонту комплекса: "приехали нет питания сгорел блок питания заменили перезагрузили роутер пинг пошёл". Верни JSON.',
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              done: { type: Type.STRING, description: 'Что сделано' },
              cause: { type: Type.STRING, description: 'Причина неисправности' },
              needs: { type: Type.STRING, description: 'Что нужно для восстановления' },
              fixed: { type: Type.STRING, description: 'Устранено (Да/Нет)' },
            },
          },
        },
      });
      const seconds = Math.round(((Date.now() - started) / 1000) * 10) / 10;
      aiRuntimeStats.llmLastSeconds = seconds;
      const parsed = parseJsonSafe<Record<string, unknown>>(response.text, {
        done: response.text || '',
        cause: '',
        needs: '',
        fixed: 'Да',
      });
      res.json({ seconds, result: parsed });
    } catch (err) {
      res.status(503).json({ detail: `Ошибка вызова модели: ${(err as Error).message}` });
    }
  });

  // AI-Agents admin management
  const AGENT_MODELS_DIR = path.join(DATA_DIR, 'agent_models');
  const pendingAgentTests = new Map<string, (res: { ok: boolean; text: string; error?: string }) => void>();

  const getAgentsConfig = () => {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_flags WHERE key = 'ai_agents_config'").get() as { value: string } | undefined;
    const saved = parseJsonSafe<Record<string, unknown>>(row?.value, {});
    return {
      enabled: Boolean(saved.enabled),
      min_params_b: Number(saved.min_params_b || 4.0),
      offline_after: Number(saved.offline_after || 45),
    };
  };

  function listAgentModels() {
    try {
      fs.mkdirSync(AGENT_MODELS_DIR, { recursive: true });
      const files = fs.readdirSync(AGENT_MODELS_DIR);
      return files.map((file) => {
        const full = path.join(AGENT_MODELS_DIR, file);
        const st = fs.statSync(full);
        const valid = file.toLowerCase().endsWith('.gguf') && st.isFile() && st.size > 1024;
        return { file, size: st.size, valid, sha256: valid ? 'ready' : '' };
      });
    } catch {
      return [];
    }
  }

  router.get('/api/ai-agents', requirePerm('admin.settings'), (_req, res) => {
    const db = getDb();
    const cfg = getAgentsConfig();
    const agents = db.prepare('SELECT * FROM ai_agents ORDER BY created_at DESC').all() as Array<Record<string, unknown>>;
    const keys = db.prepare('SELECT id, label, created_at, expires_at, used, agent_id, used_at FROM ai_agent_keys ORDER BY id DESC').all() as Array<
      Record<string, unknown>
    >;
    const agentNames = new Map(agents.map((a) => [String(a.id), String(a.name)]));
    const nowMs = Date.now();
    const nowIsoStr = new Date(nowMs).toISOString();
    let onlineCount = 0;
    let freeCount = 0;
    let busyCount = 0;

    const mappedAgents = agents.map((a) => {
      const hw = parseJsonSafe<Record<string, unknown>>(String(a.hardware || '{}'), {});
      const lastSeenMs = a.last_seen ? Date.parse(String(a.last_seen)) : 0;
      const isOnline = Boolean(a.enabled) && Number.isFinite(lastSeenMs) && (nowMs - lastSeenMs) / 1000 <= cfg.offline_after;
      const agentState = String(hw.state || 'idle');
      let statusLabel = 'offline';
      if (!a.enabled) statusLabel = 'disabled';
      else if (isOnline) {
        onlineCount += 1;
        statusLabel = agentState === 'busy' || agentState === 'loading' || agentState === 'paused' ? agentState : 'idle';
        if (statusLabel === 'idle') freeCount += 1;
        else if (statusLabel === 'busy') busyCount += 1;
      }
      return {
        id: String(a.id),
        name: String(a.name),
        ip: String(a.last_ip || ''),
        version: String(a.version || ''),
        hw_code: String(a.hw_id || '').slice(0, 8),
        status: statusLabel,
        cooldown: false,
        last_seen: String(a.last_seen || ''),
        model: String(a.model || ''),
        tps: Number(a.tps || 0),
        params_b: Number(a.params_b || 0),
        limit_pct: Number(hw.limit_pct || 0),
        cpu: String(hw.cpu || ''),
        cores: Number(hw.cores || 0),
        ram_gb: Number(hw.ram_gb || 0),
        gpu: String(hw.gpu || ''),
        gpu_used: Boolean(a.gpu_used),
        jobs_done: Number(a.jobs_done || 0),
        jobs_failed: Number(a.jobs_failed || 0),
        enabled: Boolean(a.enabled),
      };
    });
    const mappedKeys = keys.map((k) => {
      const state = k.used ? 'used' : String(k.expires_at) < nowIsoStr ? 'expired' : 'waiting';
      return {
        id: Number(k.id),
        label: String(k.label || ''),
        created_at: String(k.created_at || ''),
        expires_at: String(k.expires_at || ''),
        used_at: String(k.used_at || ''),
        agent_name: k.agent_id ? agentNames.get(String(k.agent_id)) || '' : '',
        state,
      };
    });
    res.json({
      config: cfg,
      summary: { total: mappedAgents.length, online: onlineCount, free: freeCount, busy: busyCount },
      agents: mappedAgents,
      keys: mappedKeys,
      models: listAgentModels(),
      models_dir: 'data/agent_models',
      models_recommended: [
        { file: 'qwen2.5-3b-instruct-q4_k_m.gguf', size_gb: 2.1, source: 'Qwen 2.5 3B' },
        { file: 'qwen2.5-7b-instruct-q4_k_m.gguf', size_gb: 4.7, source: 'Qwen 2.5 7B' },
      ],
    });
  });

  router.put('/api/ai-agents/config', requirePerm('admin.settings'), (req, res) => {
    const db = getDb();
    const cur = getAgentsConfig();
    const b = req.body || {};
    const next = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
      min_params_b: b.min_params_b != null ? Math.max(0.5, Math.min(100, Number(b.min_params_b))) : cur.min_params_b,
      offline_after: b.offline_after != null ? Math.max(10, Math.min(600, Number(b.offline_after))) : cur.offline_after,
    };
    db.prepare(
      "INSERT INTO app_flags (key, value) VALUES ('ai_agents_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    ).run(JSON.stringify(next));
    res.json(next);
  });

  router.post('/api/ai-agents/keys', requirePerm('admin.settings'), (req: AuthedRequest, res) => {
    const b = req.body || {};
    const label = String(b.label || '').trim().slice(0, 60);
    const days = Math.max(1, Math.min(365, Number(b.days || 7)));
    const rawKey = crypto.randomBytes(20).toString('hex');
    const hash = crypto.createHash('sha256').update(rawKey).digest('hex');
    const expires = new Date(Date.now() + days * 86400000).toISOString();
    const db = getDb();
    db.prepare(
      'INSERT INTO ai_agent_keys (key_hash, label, created_at, created_by, expires_at) VALUES (?, ?, ?, ?, ?)',
    ).run(hash, label, nowIso(), req.sessionUser?.username || '', expires);
    const server = String(b.server_url || req.headers['x-forwarded-host'] || req.headers.host || '').trim();
    const connection = server ? `lcai://${server}/${rawKey}` : rawKey;
    res.status(201).json({ key: rawKey, connection, label, expires_at: expires });
  });

  router.delete('/api/ai-agents/keys/:keyId', requirePerm('admin.settings'), (req, res) => {
    const id = Number(req.params.keyId);
    const db = getDb();
    const info = db.prepare('DELETE FROM ai_agent_keys WHERE id = ?').run(id);
    if (info.changes === 0) {
      res.status(404).json({ detail: 'Ключ не найден' });
      return;
    }
    res.json({ ok: true });
  });

  router.delete('/api/ai-agents/models/:name', requirePerm('admin.settings'), (req, res) => {
    const safeName = path.basename(decodeURIComponent(req.params.name));
    const full = path.join(AGENT_MODELS_DIR, safeName);
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ detail: 'Файл модели не найден' });
      return;
    }
    fs.unlinkSync(full);
    res.json({ ok: true });
  });

  router.put('/api/ai-agents/:agentId', requirePerm('admin.settings'), (req, res) => {
    const agentId = req.params.agentId;
    const db = getDb();
    const existing = db.prepare('SELECT id FROM ai_agents WHERE id = ?').get(agentId);
    if (!existing) {
      res.status(404).json({ detail: 'Компьютер не найден' });
      return;
    }
    const b = req.body || {};
    if (typeof b.enabled === 'boolean') db.prepare('UPDATE ai_agents SET enabled = ? WHERE id = ?').run(b.enabled ? 1 : 0, agentId);
    if (typeof b.name === 'string') db.prepare('UPDATE ai_agents SET name = ? WHERE id = ?').run(b.name.slice(0, 60), agentId);
    if (typeof b.note === 'string') db.prepare('UPDATE ai_agents SET note = ? WHERE id = ?').run(b.note.slice(0, 200), agentId);
    res.json({ ok: true });
  });

  router.delete('/api/ai-agents/:agentId', requirePerm('admin.settings'), (req, res) => {
    const db = getDb();
    const info = db.prepare('DELETE FROM ai_agents WHERE id = ?').run(req.params.agentId);
    if (info.changes === 0) {
      res.status(404).json({ detail: 'Компьютер не найден' });
      return;
    }
    res.json({ ok: true });
  });

  router.post('/api/ai-agents/:agentId/test', requirePerm('admin.settings'), async (req, res) => {
    const agentId = req.params.agentId;
    const db = getDb();
    const cfg = getAgentsConfig();
    const agent = db.prepare('SELECT * FROM ai_agents WHERE id = ?').get(agentId) as Record<string, unknown> | undefined;
    if (!agent) {
      res.status(404).json({ detail: 'Компьютер не найден' });
      return;
    }
    const lastMs = agent.last_seen ? Date.parse(String(agent.last_seen)) : 0;
    if (!agent.enabled || !lastMs || (Date.now() - lastMs) / 1000 > cfg.offline_after) {
      res.status(503).json({ detail: 'Компьютер-агент сейчас не в сети' });
      return;
    }
    const jobId = `agtest_${crypto.randomBytes(6).toString('hex')}`;
    const started = Date.now();
    db.prepare("INSERT INTO ai_jobs (id, kind, owner, status, created_at, request) VALUES (?, 'agent_test', ?, 'queued', ?, ?)").run(
      jobId,
      agentId,
      nowIso(),
      JSON.stringify({ prompt: 'Ответь одним словом: Работаю' }),
    );
    const result = await new Promise<{ ok: boolean; text: string; error?: string }>((resolve) => {
      const timer = setTimeout(() => {
        pendingAgentTests.delete(jobId);
        resolve({ ok: false, text: '', error: 'Агент не ответил за 25 секунд' });
      }, 25000);
      pendingAgentTests.set(jobId, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
    });
    if (!result.ok) {
      res.status(503).json({ detail: result.error || 'Ошибка ответа агента' });
      return;
    }
    res.json({ seconds: Math.round(((Date.now() - started) / 1000) * 10) / 10, text: result.text });
  });

  // Worker agent endpoints (/api/agent/*)
  function requireAgentToken(req: Request): Record<string, unknown> | null {
    const auth = String(req.headers.authorization || '');
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    if (!token) return null;
    const hash = crypto.createHash('sha256').update(token).digest('hex');
    const row = getDb().prepare('SELECT * FROM ai_agents WHERE token_hash = ?').get(hash) as Record<string, unknown> | undefined;
    return row || null;
  }

  router.post('/api/agent/enroll', (req, res) => {
    const b = req.body || {};
    const enrollKey = String(b.enroll_key || '').trim();
    if (!enrollKey) {
      res.status(403).json({ detail: 'Ключ подключения не указан' });
      return;
    }
    const db = getDb();
    const keyHash = crypto.createHash('sha256').update(enrollKey).digest('hex');
    const keyRow = db.prepare('SELECT * FROM ai_agent_keys WHERE key_hash = ?').get(keyHash) as Record<string, unknown> | undefined;
    const ip = clientIp(req);
    if (!keyRow) {
      recordSecurityEvent('admin_action', { ip, ok: false, details: 'отклонён неизвестный ключ ИИ-агента' });
      res.status(403).json({ detail: 'Неверный ключ подключения' });
      return;
    }
    if (keyRow.used) {
      res.status(403).json({ detail: 'Этот ключ уже был использован' });
      return;
    }
    if (String(keyRow.expires_at) < nowIso()) {
      res.status(403).json({ detail: 'Срок действия ключа истёк' });
      return;
    }
    const agentId = `ag_${crypto.randomBytes(6).toString('hex')}`;
    const rawToken = crypto.randomBytes(24).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(rawToken).digest('hex');
    const name = String(b.name || 'Компьютер').trim().slice(0, 60) || 'Компьютер';
    const now = nowIso();
    db.prepare(
      `INSERT INTO ai_agents (id, name, token_hash, hardware, model, version, enabled, hw_id, created_at, last_seen, last_ip)
       VALUES (?, ?, ?, ?, '', ?, 1, ?, ?, ?, ?)`,
    ).run(agentId, name, tokenHash, JSON.stringify(b.hardware || {}), String(b.version || '').slice(0, 30), String(b.hw_id || '').slice(0, 64), now, now, ip);
    db.prepare('UPDATE ai_agent_keys SET used = 1, agent_id = ?, used_at = ? WHERE id = ?').run(agentId, now, Number(keyRow.id));
    recordSecurityEvent('admin_action', { username: name, ip, details: `подключён ИИ-агент ${agentId}` });
    res.json({ agent_id: agentId, token: rawToken, name });
  });

  router.post('/api/agent/heartbeat', (req, res) => {
    const agent = requireAgentToken(req);
    if (!agent) {
      res.status(401).json({ detail: 'Неверный токен агента' });
      return;
    }
    const state = (req.body?.state || {}) as Record<string, unknown>;
    const prevHw = parseJsonSafe<Record<string, unknown>>(String(agent.hardware || '{}'), {});
    const mergedHw = { ...prevHw, ...state };
    getDb()
      .prepare('UPDATE ai_agents SET hardware = ?, model = COALESCE(NULLIF(?, \'\'), model), params_b = COALESCE(NULLIF(?, 0), params_b), tps = COALESCE(NULLIF(?, 0), tps), last_seen = ?, last_ip = ? WHERE id = ?')
      .run(
        JSON.stringify(mergedHw),
        String(state.model || ''),
        Number(state.params_b || 0),
        Number(state.tps || 0),
        nowIso(),
        clientIp(req),
        String(agent.id),
      );
    const cfg = getAgentsConfig();
    res.json({ ok: true, enabled: Boolean(cfg.enabled && agent.enabled) });
  });

  router.get('/api/agent/next', (req, res) => {
    const agent = requireAgentToken(req);
    if (!agent) {
      res.status(401).json({ detail: 'Неверный токен агента' });
      return;
    }
    const cfg = getAgentsConfig();
    const db = getDb();
    db.prepare('UPDATE ai_agents SET last_seen = ?, last_ip = ? WHERE id = ?').run(nowIso(), clientIp(req), String(agent.id));
    if (!cfg.enabled || !agent.enabled) {
      res.json({ job: null, paused: true });
      return;
    }
    const job = db
      .prepare("SELECT id, kind, request FROM ai_jobs WHERE status = 'queued' AND (owner = ? OR kind = 'chat') ORDER BY created_at ASC LIMIT 1")
      .get(String(agent.id)) as { id: string; kind: string; request: string } | undefined;
    if (!job) {
      res.json({ job: null, paused: false });
      return;
    }
    db.prepare("UPDATE ai_jobs SET status = 'running', started_at = ? WHERE id = ?").run(nowIso(), job.id);
    res.json({ job: { id: job.id, kind: job.kind, request: parseJsonSafe(job.request, {}) }, paused: false });
  });

  router.get('/api/agent/models', (req, res) => {
    const agent = requireAgentToken(req);
    if (!agent) {
      res.status(401).json({ detail: 'Неверный токен агента' });
      return;
    }
    res.json({ models: listAgentModels().filter((m) => m.valid) });
  });

  router.get('/api/agent/models/:name', (req, res) => {
    const agent = requireAgentToken(req);
    if (!agent) {
      res.status(401).json({ detail: 'Неверный токен агента' });
      return;
    }
    const cfg = getAgentsConfig();
    if (!cfg.enabled || !agent.enabled) {
      res.status(403).json({ detail: 'Режим ИИ-агентов выключен' });
      return;
    }
    const full = path.join(AGENT_MODELS_DIR, path.basename(req.params.name));
    if (!fs.existsSync(full) || !fs.statSync(full).isFile()) {
      res.status(404).json({ detail: 'Модель не найдена' });
      return;
    }
    res.sendFile(full);
  });

  router.post('/api/agent/result/:jobId', (req, res) => {
    const agent = requireAgentToken(req);
    if (!agent) {
      res.status(401).json({ detail: 'Неверный токен агента' });
      return;
    }
    const jobId = req.params.jobId;
    const b = req.body || {};
    const errText = String(b.error || '');
    const text = String(b.text || '');
    const db = getDb();
    const job = db.prepare('SELECT id FROM ai_jobs WHERE id = ?').get(jobId);
    if (!job) {
      res.status(404).json({ detail: 'Задание не найдено' });
      return;
    }
    db.prepare('UPDATE ai_jobs SET status = ?, finished_at = ?, result = ?, error = ? WHERE id = ?').run(
      errText ? 'error' : 'done',
      nowIso(),
      text,
      errText,
      jobId,
    );
    if (errText) {
      db.prepare('UPDATE ai_agents SET jobs_failed = jobs_failed + 1 WHERE id = ?').run(String(agent.id));
    } else {
      db.prepare('UPDATE ai_agents SET jobs_done = jobs_done + 1 WHERE id = ?').run(String(agent.id));
    }
    const cb = pendingAgentTests.get(jobId);
    if (cb) {
      pendingAgentTests.delete(jobId);
      cb({ ok: !errText, text, error: errText || undefined });
    }
    res.json({ ok: true });
  });

  // ================= ASSISTANT (/api/assistant/*) =================
  router.get('/api/assistant/info', requirePasswordOk, (req: AuthedRequest, res) => {
    const cfg = loadAiConfig();
    const status = getAiStatus();
    const perms = req.sessionUser!.permissions;
    const db = getDb();
    const plans = db.prepare('SELECT COUNT(*) AS plans, COALESCE(SUM(hits), 0) AS hits FROM ai_plan_cache').get() as {
      plans: number;
      hits: number;
    };
    res.json({
      enabled: cfg.assistant,
      ready: cfg.assistant ? (status.llm.ok || true) : false,
      role: req.sessionUser!.role,
      examples: assistantExamples(perms),
      datasets: roleDatasets(perms),
      queue: { waiting: aiRuntimeStats.llmWaiting, busy: aiRuntimeStats.llmBusy },
      last_seconds: aiRuntimeStats.llmLastSeconds,
      plans,
    });
  });

  router.get('/api/assistant/chat', requirePasswordOk, (req: AuthedRequest, res) => {
    const owner = `user:${req.sessionUser!.id}`;
    const db = getDb();
    const rows = db
      .prepare('SELECT id, role, text, job_id, status, answer, error, created_at FROM ai_chat WHERE owner = ? ORDER BY id')
      .all(owner) as Array<{
        id: number;
        role: string;
        text: string;
        job_id: string | null;
        status: string;
        answer: string | null;
        error: string | null;
        created_at: string;
      }>;
    const jobsRows = db.prepare('SELECT id, status, started_at FROM ai_jobs WHERE owner = ?').all(owner) as Array<{
      id: string;
      status: string;
      started_at: string | null;
    }>;
    const jobsMap = new Map(jobsRows.map((j) => [j.id, j]));
    const messages = rows.map((r) => {
      const job = r.job_id ? jobsMap.get(r.job_id) : undefined;
      return {
        id: r.id,
        role: r.role,
        text: r.text,
        status: r.status,
        answer: parseJsonSafe<Record<string, unknown> | null>(r.answer, null),
        error: r.error || '',
        created_at: r.created_at,
        job: job ? { id: job.id, status: job.status, started_at: job.started_at, ahead: 0, progress: null } : null,
      };
    });
    res.json({
      messages,
      pending: messages.some((m) => m.role === 'assistant' && m.status === 'pending'),
      server_time: nowIso(),
      queue: { waiting: aiRuntimeStats.llmWaiting, busy: aiRuntimeStats.llmBusy },
      last_seconds: aiRuntimeStats.llmLastSeconds,
    });
  });

  router.delete('/api/assistant/chat', requirePasswordOk, (req: AuthedRequest, res) => {
    const owner = `user:${req.sessionUser!.id}`;
    const db = getDb();
    const info = db.prepare('DELETE FROM ai_chat WHERE owner = ?').run(owner);
    res.json({ removed: info.changes });
  });

  router.post('/api/assistant/ask', requirePasswordOk, (req: AuthedRequest, res) => {
    const cfg = loadAiConfig();
    if (!cfg.assistant) {
      res.status(403).json({ detail: 'Помощник выключен администратором (Настройки → ИИ).' });
      return;
    }
    const b = req.body || {};
    const question = String(b.question || '').trim().replace(/\s+/g, ' ').slice(0, 600);
    if (question.length < 3) {
      res.status(400).json({ detail: 'Напишите вопрос.' });
      return;
    }
    const owner = `user:${req.sessionUser!.id}`;
    const clientId = String(b.client_id || '').trim().slice(0, 64);
    const mode = ['auto', 'agent', 'plain'].includes(String(b.mode || 'auto')) ? String(b.mode || 'auto') : 'auto';
    const db = getDb();

    if (clientId) {
      const dup = db
        .prepare("SELECT id, job_id FROM ai_chat WHERE owner = ? AND client_id = ? AND role = 'user' LIMIT 1")
        .get(owner, clientId) as { id: number; job_id: string | null } | undefined;
      if (dup) {
        const ans = db
          .prepare("SELECT id FROM ai_chat WHERE owner = ? AND job_id = ? AND role = 'assistant' LIMIT 1")
          .get(owner, dup.job_id) as { id: number } | undefined;
        res.json({ job_id: dup.job_id, message_id: dup.id, answer_id: ans?.id ?? null, duplicate: true });
        return;
      }
    }

    const jobId = crypto.randomUUID();
    const now = nowIso();
    db.prepare(
      `INSERT INTO ai_jobs (id, kind, owner, status, created_at, started_at, request)
       VALUES (?, 'qa', ?, 'running', ?, ?, ?)`,
    ).run(jobId, owner, now, now, JSON.stringify({ question, mode }));

    const qInfo = db
      .prepare("INSERT INTO ai_chat (owner, role, text, job_id, status, client_id, created_at) VALUES (?, 'user', ?, ?, 'done', ?, ?)")
      .run(owner, question, jobId, clientId || null, now);
    const aInfo = db
      .prepare("INSERT INTO ai_chat (owner, role, text, job_id, status, created_at) VALUES (?, 'assistant', '', ?, 'pending', ?)")
      .run(owner, jobId, now);
    const answerId = Number(aInfo.lastInsertRowid);
    const perms = [...req.sessionUser!.permissions];

    void (async () => {
      try {
        const answer = await runAssistantQuestion(question, perms, mode);
        const doneAt = nowIso();
        db.prepare("UPDATE ai_chat SET status = 'done', answer = ?, finished_at = ? WHERE id = ?").run(
          JSON.stringify(answer),
          doneAt,
          answerId,
        );
        db.prepare("UPDATE ai_jobs SET status = 'done', finished_at = ?, result = ? WHERE id = ?").run(
          doneAt,
          JSON.stringify({ question, answer }),
          jobId,
        );
      } catch (err) {
        const failAt = nowIso();
        const msg = (err as Error).message || 'Ошибка обработки запроса';
        db.prepare("UPDATE ai_chat SET status = 'error', error = ?, finished_at = ? WHERE id = ?").run(msg, failAt, answerId);
        db.prepare("UPDATE ai_jobs SET status = 'error', finished_at = ?, error = ? WHERE id = ?").run(failAt, msg, jobId);
      }
    })();

    res.json({ job_id: jobId, message_id: Number(qInfo.lastInsertRowid), answer_id: answerId });
  });

  router.post('/api/assistant/refresh', requirePasswordOk, async (req: AuthedRequest, res) => {
    const messageId = Number((req.body || {}).message_id);
    const owner = `user:${req.sessionUser!.id}`;
    const db = getDb();
    const row = db
      .prepare("SELECT id, job_id FROM ai_chat WHERE id = ? AND owner = ? AND role = 'assistant'")
      .get(messageId, owner) as { id: number; job_id: string | null } | undefined;
    if (!row || !row.job_id) {
      res.status(404).json({ detail: 'Ответ не найден' });
      return;
    }
    const qRow = db
      .prepare("SELECT text FROM ai_chat WHERE job_id = ? AND owner = ? AND role = 'user'")
      .get(row.job_id, owner) as { text: string } | undefined;
    const answer = await runAssistantQuestion(qRow?.text || '', req.sessionUser!.permissions, 'auto');
    db.prepare('UPDATE ai_chat SET answer = ?, finished_at = ? WHERE id = ?').run(JSON.stringify(answer), nowIso(), row.id);
    res.json({ answer, change: { changed: false } });
  });

  router.post('/api/assistant/evidence', requirePasswordOk, (_req, res) => {
    const db = getDb();
    const rows = db
      .prepare("SELECT id, address, status, fault_reason FROM points ORDER BY id LIMIT 100")
      .all() as Array<{ id: string; address: string; status: string; fault_reason: string }>;
    res.json({
      columns: [
        { key: 'id', label: 'Комплекс' },
        { key: 'status', label: 'Статус' },
        { key: 'address', label: 'Адрес' },
        { key: 'fault', label: 'Описание' },
      ],
      rows: rows.map((r) => [r.id, r.status || 'Не известно', r.address, r.fault_reason]),
      total: rows.length,
      truncated: false,
    });
  });

  router.get('/api/assistant/jobs/:jobId', requirePasswordOk, (req: AuthedRequest, res) => {
    const owner = `user:${req.sessionUser!.id}`;
    const db = getDb();
    const row = db.prepare('SELECT * FROM ai_jobs WHERE id = ? AND owner = ?').get(req.params.jobId, owner) as
      | { id: string; kind: string; status: string; created_at: string; started_at: string | null; finished_at: string | null; result: string | null; error: string | null }
      | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Задача не найдена' });
      return;
    }
    res.json({
      id: row.id,
      kind: row.kind,
      status: row.status,
      created_at: row.created_at,
      started_at: row.started_at,
      finished_at: row.finished_at,
      result: parseJsonSafe(row.result, null),
      error: row.error || '',
      queue: { waiting: 0 },
    });
  });

  router.post('/api/assistant/files/analyze', requirePasswordOk, upload.single('file'), async (req: AuthedRequest, res) => {
    const cfg = loadAiConfig();
    if (!cfg.assistant) {
      res.status(403).json({ detail: 'Помощник выключен администратором (Настройки → ИИ).' });
      return;
    }
    if (!req.file) {
      res.status(400).json({ detail: 'Выберите файл шаблона.' });
      return;
    }
    const instruction = String(req.body?.instruction || '').trim().slice(0, 800);
    if (!instruction) {
      res.status(400).json({ detail: 'Опишите, как заполнить шаблон.' });
      return;
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase().replace('.', '');
    if (!['xlsx', 'xlsm', 'docx'].includes(ext)) {
      res.status(400).json({ detail: 'Поддерживаются только шаблоны .xlsx, .xlsm и .docx' });
      return;
    }
    const owner = `user:${req.sessionUser!.id}`;
    const fileId = crypto.randomUUID();
    const diskPath = path.join(AI_FILES_DIR, `${fileId}.${ext}`);
    fs.writeFileSync(diskPath, req.file.buffer);

    const db = getDb();
    const now = nowIso();
    db.prepare('INSERT INTO ai_files (id, owner, kind, name, ext, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      fileId,
      owner,
      'template',
      req.file.originalname || `template.${ext}`,
      ext,
      req.file.size,
      now,
    );

    const pf = String(req.body?.period_from || '').trim() || addDaysIso(todayIso(), -30);
    const pt = String(req.body?.period_to || '').trim() || todayIso();
    const jobId = crypto.randomUUID();
    const result = {
      file_id: fileId,
      name: req.file.originalname || `template.${ext}`,
      kind: ext === 'docx' ? 'docx' : 'xlsx',
      plan: { dataset: 'visits', instruction },
      period: { from: pf, to: pt },
      preview: [
        `Источник данных: отчёты о выездах и комплексы АПК`,
        `   Период: ${formatDateRu(pf)} — ${formatDateRu(pt)}`,
        `   Инструкция: ${instruction}`,
      ],
      warnings: [],
    };
    db.prepare(
      "INSERT INTO ai_jobs (id, kind, owner, status, created_at, started_at, finished_at, request, result) VALUES (?, 'doc_plan', ?, 'done', ?, ?, ?, ?, ?)",
    ).run(jobId, owner, now, now, now, JSON.stringify({ file_id: fileId, instruction }), JSON.stringify(result));
    res.json({ job_id: jobId });
  });

  router.post('/api/assistant/files/fill', requirePasswordOk, async (req: AuthedRequest, res) => {
    const owner = `user:${req.sessionUser!.id}`;
    const b = req.body || {};
    const db = getDb();
    const pf = String(b.period_from || '').trim() || addDaysIso(todayIso(), -30);
    const pt = String(b.period_to || '').trim() || todayIso();
    const [frm, to] = dateBounds(pf, pt);

    const rows = db
      .prepare(
        `SELECT tvr.created_at, tvr.point_id, COALESCE(p.address, '') AS address, tvr.visit_type, tvr.result_status, tvr.comment
         FROM task_visit_reports tvr
         LEFT JOIN points p ON p.id = tvr.point_id
         WHERE tvr.created_at >= ? AND tvr.created_at <= ?
         ORDER BY tvr.created_at DESC LIMIT 500`,
      )
      .all(frm, to) as Array<{
        created_at: string;
        point_id: string;
        address: string;
        visit_type: string;
        result_status: string;
        comment: string;
      }>;

    const planJob = db.prepare('SELECT result FROM ai_jobs WHERE id = ? AND owner = ?').get(String(b.job_id || ''), owner) as
      | { result: string | null }
      | undefined;
    const planRes = parseJsonSafe<{ name?: string; kind?: string }>(planJob?.result, {});
    const isDocx = planRes.kind === 'docx';
    const baseStem = (planRes.name || 'Отчёт').replace(/\.[A-Za-z0-9]+$/, '');

    let outBuf: Buffer;
    let outExt: string;
    if (isDocx) {
      outExt = 'docx';
      const doc = new Document({
        sections: [
          {
            children: [
              new Paragraph({
                children: [new TextRun({ text: `${baseStem} (${formatDateRu(pf)} — ${formatDateRu(pt)})`, bold: true, size: 28 })],
              }),
              new Table({
                width: { size: 100, type: WidthType.PERCENTAGE },
                rows: [
                  new TableRow({
                    children: ['Дата', 'Комплекс', 'Адрес', 'Тип работ', 'Итог', 'Комментарий'].map(
                      (h) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })] }),
                    ),
                  }),
                  ...rows.map(
                    (r) =>
                      new TableRow({
                        children: [
                          formatDateRu(r.created_at),
                          r.point_id,
                          r.address,
                          r.visit_type,
                          r.result_status,
                          r.comment,
                        ].map((val) => new TableCell({ children: [new Paragraph(String(val || ''))] })),
                      }),
                  ),
                ],
              }),
            ],
          },
        ],
      });
      outBuf = await Packer.toBuffer(doc);
    } else {
      outExt = 'xlsx';
      const wb = new ExcelJS.Workbook();
      const ws = wb.addWorksheet('Данные');
      ws.addRow(['Дата', 'Комплекс', 'Адрес', 'Тип работ', 'Итог', 'Комментарий']);
      ws.getRow(1).eachCell((c) => {
        c.font = { bold: true };
      });
      for (const r of rows) {
        ws.addRow([
          formatDateRu(r.created_at),
          safeCell(r.point_id),
          safeCell(r.address),
          safeCell(r.visit_type),
          safeCell(r.result_status),
          safeCell(r.comment),
        ]);
      }
      [14, 16, 40, 20, 18, 40].forEach((w, i) => {
        ws.getColumn(i + 1).width = w;
      });
      outBuf = Buffer.from(await wb.xlsx.writeBuffer());
    }

    const outId = crypto.randomUUID();
    const outName = `${baseStem} (заполнено).${outExt}`;
    fs.writeFileSync(path.join(AI_FILES_DIR, `${outId}.${outExt}`), outBuf);
    const now = nowIso();
    db.prepare('INSERT INTO ai_files (id, owner, kind, name, ext, size, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(
      outId,
      owner,
      'output',
      outName,
      outExt,
      outBuf.length,
      now,
    );

    const jobId = crypto.randomUUID();
    const fillResult = {
      file_id: outId,
      name: outName,
      tables: [{ where: 'Основная таблица', rows: rows.length }],
      placeholders: 0,
      warnings: [],
    };
    db.prepare(
      "INSERT INTO ai_jobs (id, kind, owner, status, created_at, started_at, finished_at, request, result) VALUES (?, 'doc_fill', ?, 'done', ?, ?, ?, ?, ?)",
    ).run(jobId, owner, now, now, now, JSON.stringify({ pf, pt }), JSON.stringify(fillResult));
    res.json({ job_id: jobId });
  });

  router.get('/api/assistant/files/:fileId', requirePasswordOk, (req: AuthedRequest, res) => {
    const owner = `user:${req.sessionUser!.id}`;
    const db = getDb();
    const row = db
      .prepare('SELECT id, name, ext FROM ai_files WHERE id = ? AND owner = ?')
      .get(req.params.fileId, owner) as { id: string; name: string; ext: string } | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Файл не найден' });
      return;
    }
    const filePath = path.join(AI_FILES_DIR, `${row.id}.${row.ext}`);
    if (!fs.existsSync(filePath)) {
      res.status(404).json({ detail: 'Файл удалён с диска' });
      return;
    }
    const mime =
      row.ext === 'docx'
        ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
        : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    res.setHeader('Content-Type', mime);
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.name)}`);
    res.sendFile(filePath);
  });

  return router;
}
