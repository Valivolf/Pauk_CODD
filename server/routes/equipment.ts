import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import zlib from 'node:zlib';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { requirePasswordOk, requirePerm, type AuthedRequest } from '../auth.ts';
import { decryptField, encryptField } from '../crypto.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { networkOk, secretsOk } from '../permissions.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const REMOVAL_REASONS = [
  'Неисправно',
  'Не включается',
  'Нет связи',
  'Механическое повреждение',
  'Плановая замена',
  'Причина неизвестна',
];

const PLACES = [
  { key: 'stock', label: 'На складе' },
  { key: 'person', label: 'У монтёра' },
  { key: 'point', label: 'На комплексе' },
  { key: 'unknown', label: 'Неизвестное местонахождение' },
];

const SUGGESTED_COMPONENTS = ['Ящик', 'Камера', 'Плата', 'Роутер', 'Блок питания', 'Аккумулятор'];

function logEquipmentHistory(opts: {
  equipment_id?: number | null;
  serial_number?: string;
  model_name?: string;
  action_type: string;
  person_id?: number | null;
  person_name?: string | null;
  point_id?: string | null;
  performed_by?: string;
  comment?: string;
  event_date?: string;
}) {
  const ts = nowIso();
  getDb()
    .prepare(
      `INSERT INTO equipment_history (ts, equipment_id, serial_number, model_name, action_type, person_name, point_id, performed_by, comment, event_date, person_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      ts,
      opts.equipment_id ?? null,
      opts.serial_number || null,
      opts.model_name || null,
      opts.action_type,
      opts.person_name || null,
      opts.point_id || null,
      opts.performed_by || '',
      opts.comment || '',
      opts.event_date || ts.slice(0, 10),
      opts.person_id ?? null,
    );
}

function hydrateEquipmentRow(r: Record<string, unknown>) {
  const db = getDb();
  const fieldVals = db
    .prepare(
      'SELECT fv.field_id, f.name, fv.value FROM equipment_field_values fv JOIN equipment_fields f ON f.id = fv.field_id WHERE fv.equipment_id = ?',
    )
    .all(Number(r.id)) as Array<{ field_id: number; name: string; value: string }>;
  const fields: Record<string, string> = {};
  for (const fv of fieldVals) fields[String(fv.field_id)] = fv.value;

  const place = String(r.place || 'stock');
  const heldReason = r.held_reason ? String(r.held_reason) : null;
  const statusName = String(r.status_name || '');

  return {
    id: Number(r.id),
    model_id: Number(r.model_id),
    model_name: String(r.model_name || ''),
    category_id: r.category_id != null ? Number(r.category_id) : null,
    category_name: String(r.category_name || ''),
    category_kind: String(r.category_kind || ''),
    serial_number: String(r.serial_number || ''),
    place,
    status_id: r.status_id != null ? Number(r.status_id) : null,
    status: statusName,
    status_name: statusName,
    status_color: String(r.status_color || '#64748b'),
    status_usable: Boolean(r.status_usable),
    point_id: r.point_id ? String(r.point_id) : null,
    point_address: String(r.point_address || ''),
    person_id: r.person_id != null ? Number(r.person_id) : null,
    person_name: r.person_full_name ? decryptField(String(r.person_full_name)) : null,
    held_reason: heldReason,
    awaiting_accept: place === 'person' && heldReason === 'removed',
    kept: place === 'person' && heldReason === 'kept',
    received_date: r.received_date ?? null,
    issued_date: r.issued_date ?? null,
    installed_date: r.installed_date ?? null,
    installed_by: r.installed_by ?? null,
    removed_date: r.removed_date ?? null,
    removed_by: r.removed_by ?? null,
    removed_point_id: r.removed_point_id ?? null,
    accepted_date: r.accepted_date ?? null,
    accepted_by: r.accepted_by ?? null,
    notes: String(r.notes ?? ''),
    removal_reason: r.removal_reason ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    extra: fieldVals,
    fields,
  };
}

function queryEquipmentBase(whereClause = '', params: Array<string | number> = []) {
  return getDb()
    .prepare(
      `SELECT e.*, m.name as model_name, m.category_id, c.name as category_name, c.kind as category_kind,
              s.name as status_name, s.color as status_color, s.usable as status_usable,
              p.full_name as person_full_name, pt.address as point_address
       FROM equipment e
       LEFT JOIN equipment_models m ON m.id = e.model_id
       LEFT JOIN equipment_categories c ON c.id = m.category_id
       LEFT JOIN equipment_statuses s ON s.id = e.status_id
       LEFT JOIN people p ON p.id = e.person_id
       LEFT JOIN points pt ON pt.id = e.point_id
       ${whereClause}
       ORDER BY e.id DESC`,
    )
    .all(...params) as Array<Record<string, unknown>>;
}

function getStatusByRole(role: 'ok' | 'defect'): number | null {
  const row = getDb().prepare('SELECT id FROM equipment_statuses WHERE role = ? LIMIT 1').get(role) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

export function createEquipmentRouter(): Router {
  const router = Router();
  router.use('/api/equipment', requirePasswordOk, requirePerm('warehouse.view'));
  router.use('/api/warehouse', requirePasswordOk, requirePerm('warehouse.view'));
  router.use('/api/solar-panels', requirePasswordOk, requirePerm('warehouse.view'));

  // ---- META & DICTIONARIES ----
  router.get('/api/equipment/meta', (_req, res) => {
    const db = getDb();
    const categories = (
      db
        .prepare(
          `SELECT c.*,
                  (SELECT COUNT(*) FROM equipment_models m WHERE m.category_id = c.id) as model_count,
                  (SELECT COUNT(*) FROM equipment e JOIN equipment_models m ON m.id = e.model_id WHERE m.category_id = c.id) as equipment_count
           FROM equipment_categories c ORDER BY c.id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((c) => ({ ...c, system: Boolean(c.kind) }));
    const models = db
      .prepare(
        `SELECT m.*, c.name as category_name,
                (SELECT COUNT(*) FROM equipment e WHERE e.model_id = m.id) as equipment_count
         FROM equipment_models m JOIN equipment_categories c ON c.id = m.category_id ORDER BY c.name, m.name`,
      )
      .all();
    const statuses = (
      db
        .prepare(
          `SELECT s.*,
                  (SELECT COUNT(*) FROM equipment e WHERE e.status_id = s.id) as equipment_count
           FROM equipment_statuses s ORDER BY s.sort_order, s.id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((s) => ({
      ...s,
      usable: Boolean(s.usable),
      protected: Boolean(s.protected),
      equipment_count: Number(s.equipment_count || 0),
    }));
    const fields = db
      .prepare(
        `SELECT f.*, c.name as category_name,
                (SELECT COUNT(*) FROM equipment_field_values fv WHERE fv.field_id = f.id AND coalesce(fv.value, '') != '') as value_count
         FROM equipment_fields f
         LEFT JOIN equipment_categories c ON c.id = f.category_id
         ORDER BY f.sort_order, f.id`,
      )
      .all();
    const people = (
      db
        .prepare("SELECT id, full_name, role_type, phone FROM people WHERE active = 1 AND role_type != 'warehouse' ORDER BY id")
        .all() as Array<Record<string, unknown>>
    ).map((p) => ({
      id: p.id,
      full_name: decryptField(String(p.full_name || '')),
      role_type: p.role_type,
      phone: p.phone ? decryptField(String(p.phone)) : null,
    }));

    res.json({
      categories,
      models,
      statuses,
      fields,
      removal_reasons: REMOVAL_REASONS,
      places: PLACES,
      people,
    });
  });

  router.get('/api/equipment/categories', (_req, res) => {
    const rows = (
      getDb()
        .prepare(
          `SELECT c.*,
                  (SELECT COUNT(*) FROM equipment_models m WHERE m.category_id = c.id) as model_count,
                  (SELECT COUNT(*) FROM equipment e JOIN equipment_models m ON m.id = e.model_id WHERE m.category_id = c.id) as equipment_count
           FROM equipment_categories c ORDER BY c.id`,
        )
        .all() as Array<Record<string, unknown>>
    ).map((c) => ({ ...c, system: Boolean(c.kind) }));
    res.json(rows);
  });

  router.post('/api/equipment/categories', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ detail: 'Укажите название категории' });
      return;
    }
    const db = getDb();
    try {
      const info = db.prepare("INSERT INTO equipment_categories (name, kind) VALUES (?, '')").run(name);
      res.status(201).json({ id: Number(info.lastInsertRowid), name, kind: '', model_count: 0, equipment_count: 0 });
    } catch {
      res.status(409).json({ detail: 'Категория с таким названием уже существует' });
    }
  });

  router.put('/api/equipment/categories/:categoryId', (req, res) => {
    const id = Number(req.params.categoryId);
    const name = String(req.body?.name || '').trim();
    const db = getDb();
    const row = db.prepare('SELECT kind FROM equipment_categories WHERE id = ?').get(id) as { kind: string } | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Категория не найдена' });
      return;
    }
    if (row.kind) {
      res.status(409).json({ detail: 'Это служебная категория — её нельзя переименовать' });
      return;
    }
    db.prepare('UPDATE equipment_categories SET name = ? WHERE id = ?').run(name, id);
    res.json({ id, name });
  });

  router.delete('/api/equipment/categories/:categoryId', (req, res) => {
    const id = Number(req.params.categoryId);
    const db = getDb();
    const row = db.prepare('SELECT kind FROM equipment_categories WHERE id = ?').get(id) as { kind: string } | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Категория не найдена' });
      return;
    }
    if (row.kind) {
      res.status(409).json({ detail: 'Это служебная категория — её нельзя удалить' });
      return;
    }
    const cnt = (db.prepare('SELECT COUNT(*) as c FROM equipment_models WHERE category_id = ?').get(id) as { c: number }).c;
    if (cnt > 0) {
      res.status(409).json({ detail: 'Нельзя удалить категорию: с ней связаны модели оборудования' });
      return;
    }
    db.prepare('DELETE FROM equipment_categories WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  router.get('/api/equipment/models', (req, res) => {
    const catId = req.query.category_id ? Number(req.query.category_id) : null;
    const sql = catId
      ? 'SELECT m.*, c.name as category_name FROM equipment_models m JOIN equipment_categories c ON c.id = m.category_id WHERE m.category_id = ? ORDER BY m.name'
      : 'SELECT m.*, c.name as category_name FROM equipment_models m JOIN equipment_categories c ON c.id = m.category_id ORDER BY c.name, m.name';
    res.json(catId ? getDb().prepare(sql).all(catId) : getDb().prepare(sql).all());
  });

  router.post('/api/equipment/models', (req, res) => {
    const categoryId = Number(req.body?.category_id);
    const name = String(req.body?.name || '').trim();
    const db = getDb();
    if (!db.prepare('SELECT id FROM equipment_categories WHERE id = ?').get(categoryId)) {
      res.status(404).json({ detail: 'Категория не найдена' });
      return;
    }
    try {
      const info = db.prepare('INSERT INTO equipment_models (category_id, name) VALUES (?, ?)').run(categoryId, name);
      res.status(201).json({ id: Number(info.lastInsertRowid), category_id: categoryId, name });
    } catch {
      res.status(409).json({ detail: 'Такая модель уже есть в этой категории' });
    }
  });

  router.put('/api/equipment/models/:modelId', (req, res) => {
    const id = Number(req.params.modelId);
    const name = String(req.body?.name || '').trim();
    const db = getDb();
    const info = db.prepare('UPDATE equipment_models SET name = ? WHERE id = ?').run(name, id);
    if (!info.changes) {
      res.status(404).json({ detail: 'Модель не найдена' });
      return;
    }
    res.json({ id, name });
  });

  router.delete('/api/equipment/models/:modelId', (req, res) => {
    const id = Number(req.params.modelId);
    const db = getDb();
    const cnt = (db.prepare('SELECT COUNT(*) as c FROM equipment WHERE model_id = ?').get(id) as { c: number }).c;
    if (cnt > 0) {
      res.status(409).json({ detail: 'С моделью связано оборудование' });
      return;
    }
    db.prepare('DELETE FROM equipment_models WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  router.get('/api/equipment/statuses', (_req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM equipment_statuses ORDER BY sort_order, id')
      .all()
      .map((s: Record<string, unknown>) => ({ ...s, usable: Boolean(s.usable), protected: Boolean(s.protected) }));
    res.json(rows);
  });

  router.post('/api/equipment/statuses', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      res.status(400).json({ detail: 'Укажите название статуса' });
      return;
    }
    const db = getDb();
    try {
      const info = db
        .prepare('INSERT INTO equipment_statuses (name, color, usable, role, protected, sort_order, created_at) VALUES (?, ?, ?, \'\', 0, 99, ?)')
        .run(name, String(b.color || '#64748b'), b.usable ? 1 : 0, nowIso());
      const created = db.prepare('SELECT * FROM equipment_statuses WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      res.status(201).json({ ...created, usable: Boolean(created.usable), protected: Boolean(created.protected) });
    } catch {
      res.status(409).json({ detail: 'Статус уже существует' });
    }
  });

  router.put('/api/equipment/statuses/:statusId', (req, res) => {
    const id = Number(req.params.statusId);
    const b = req.body || {};
    const db = getDb();
    db.prepare('UPDATE equipment_statuses SET name=?, color=?, usable=? WHERE id=?').run(
      String(b.name || '').trim(),
      String(b.color || '#64748b'),
      b.usable ? 1 : 0,
      id,
    );
    const updated = db.prepare('SELECT * FROM equipment_statuses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!updated) {
      res.status(404).json({ detail: 'Статус не найден' });
      return;
    }
    res.json({ ...updated, usable: Boolean(updated.usable), protected: Boolean(updated.protected) });
  });

  router.delete('/api/equipment/statuses/:statusId', (req, res) => {
    const id = Number(req.params.statusId);
    const db = getDb();
    const st = db.prepare('SELECT protected FROM equipment_statuses WHERE id = ?').get(id) as { protected: number } | undefined;
    if (!st) {
      res.status(404).json({ detail: 'Статус не найден' });
      return;
    }
    if (st.protected) {
      res.status(409).json({ detail: 'Системный статус нельзя удалить' });
      return;
    }
    db.prepare('DELETE FROM equipment_statuses WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  router.get('/api/equipment/sim-duplicates', (_req, res) => {
    const db = getDb();
    const pts = db
      .prepare("SELECT id, address, trim(sim_number) as sim FROM points WHERE coalesce(trim(sim_number), '') != '' ORDER BY id")
      .all() as Array<{ id: string; address: string; sim: string }>;
    const bySim = new Map<string, Array<{ id: string; address: string }>>();
    for (const p of pts) {
      const k = p.sim.slice(-7);
      if (!k) continue;
      const list = bySim.get(k) || [];
      list.push({ id: p.id, address: p.address || '' });
      bySim.set(k, list);
    }
    const simEq = db
      .prepare(
        `SELECT e.serial_number, e.point_id
         FROM equipment e
         JOIN equipment_models m ON m.id = e.model_id
         JOIN equipment_categories c ON c.id = m.category_id
         WHERE c.kind = 'sim' AND e.place = 'point'`,
      )
      .all() as Array<{ serial_number: string; point_id: string }>;
    const installedMap = new Map(simEq.map((e) => [String(e.serial_number).slice(-7), e.point_id]));

    const groups: Array<{ sim: string; installed_point: string | null; points: Array<{ id: string; address: string }> }> = [];
    let totalPoints = 0;
    for (const [sim, list] of bySim.entries()) {
      if (list.length > 1) {
        totalPoints += list.length;
        groups.push({ sim, installed_point: installedMap.get(sim) || null, points: list });
      }
    }
    res.json({
      total_groups: groups.length,
      total_points: totalPoints,
      groups: groups.slice(0, 100),
      duplicates: groups,
    });
  });

  router.get('/api/equipment/fields', (_req, res) => {
    res.json(
      getDb()
        .prepare(
          `SELECT f.*, c.name as category_name,
                  (SELECT COUNT(*) FROM equipment_field_values fv WHERE fv.field_id = f.id AND coalesce(fv.value, '') != '') as value_count
           FROM equipment_fields f
           LEFT JOIN equipment_categories c ON c.id = f.category_id
           ORDER BY f.sort_order, f.id`,
        )
        .all(),
    );
  });

  router.post('/api/equipment/fields', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      res.status(400).json({ detail: 'Укажите название поля' });
      return;
    }
    try {
      const info = getDb()
        .prepare('INSERT INTO equipment_fields (name, category_id, sort_order, created_at) VALUES (?, ?, 0, ?)')
        .run(name, b.category_id ? Number(b.category_id) : null, nowIso());
      const created = getDb().prepare('SELECT * FROM equipment_fields WHERE id = ?').get(Number(info.lastInsertRowid));
      res.status(201).json(created);
    } catch {
      res.status(409).json({ detail: 'Поле уже существует' });
    }
  });

  router.put('/api/equipment/fields/:fieldId', (req, res) => {
    const id = Number(req.params.fieldId);
    const b = req.body || {};
    getDb()
      .prepare('UPDATE equipment_fields SET name=?, category_id=? WHERE id=?')
      .run(String(b.name || '').trim(), b.category_id ? Number(b.category_id) : null, id);
    res.json(getDb().prepare('SELECT * FROM equipment_fields WHERE id = ?').get(id));
  });

  router.delete('/api/equipment/fields/:fieldId', (req, res) => {
    const id = Number(req.params.fieldId);
    getDb().prepare('DELETE FROM equipment_field_values WHERE field_id = ?').run(id);
    getDb().prepare('DELETE FROM equipment_fields WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  router.get('/api/equipment/pending-installs', (_req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM equipment_pending WHERE resolved_at IS NULL ORDER BY id DESC')
      .all();
    res.json(rows);
  });

  // ---- ITEMS ----
  router.get('/api/equipment/items', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const place = String(req.query.place || '').trim();
    const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
    const modelId = req.query.model_id ? Number(req.query.model_id) : null;
    const statusId = req.query.status_id ? Number(req.query.status_id) : null;
    const personId = req.query.person_id ? Number(req.query.person_id) : null;
    const pointId = String(req.query.point_id || '').trim();
    const usableOnly = req.query.usable === 'true';
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();
    const limit = req.query.limit !== undefined ? Math.max(1, Number(req.query.limit) || 300) : null;
    const offset = Math.max(0, Number(req.query.offset || 0));

    let rows = queryEquipmentBase().map(hydrateEquipmentRow);
    if (place) rows = rows.filter((r) => r.place === place);
    if (categoryId) rows = rows.filter((r) => Number(r.category_id) === categoryId);
    if (modelId) rows = rows.filter((r) => Number(r.model_id) === modelId);
    if (statusId) rows = rows.filter((r) => Number(r.status_id) === statusId);
    if (personId) rows = rows.filter((r) => Number(r.person_id) === personId);
    if (pointId) rows = rows.filter((r) => r.point_id === pointId);
    if (usableOnly) rows = rows.filter((r) => Boolean(r.status_usable));
    if (dateFrom || dateTo) {
      rows = rows.filter((r) => {
        const dt = String(
          r.place === 'point'
            ? r.installed_date || ''
            : r.place === 'person' || r.place === 'unknown'
              ? r.removed_date || r.issued_date || ''
              : r.accepted_date || r.received_date || '',
        ).slice(0, 10);
        if (!dt) return false;
        if (dateFrom && dt < dateFrom) return false;
        if (dateTo && dt > dateTo) return false;
        return true;
      });
    }
    if (search) {
      rows = rows.filter((r) => {
        const extraVals = (r.extra || []).map((e) => e.value);
        return [r.serial_number, r.model_name, r.category_name, r.point_id, r.person_name, r.notes, ...extraVals].some((v) =>
          String(v || '').toLowerCase().includes(search),
        );
      });
    }
    const total = rows.length;
    const sliced = limit !== null ? rows.slice(offset, offset + limit) : rows;
    res.setHeader('X-Total-Count', String(total));
    res.json(sliced);
  });

  router.get('/api/equipment/items/:itemId', (req, res) => {
    const rows = queryEquipmentBase('WHERE e.id = ?', [Number(req.params.itemId)]);
    if (!rows.length) {
      res.status(404).json({ detail: 'Оборудование не найдено' });
      return;
    }
    const item = hydrateEquipmentRow(rows[0]);
    const history = getDb()
      .prepare('SELECT * FROM equipment_history WHERE equipment_id = ? ORDER BY id DESC LIMIT 100')
      .all(Number(req.params.itemId));
    res.json({ ...item, history });
  });

  router.post('/api/equipment/receive', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const serials: string[] = Array.isArray(b.serial_numbers)
      ? b.serial_numbers.map((s: unknown) => String(s).trim()).filter(Boolean)
      : b.serial_number
        ? [String(b.serial_number).trim()]
        : [];
    if (!serials.length || !b.model_id) {
      res.status(400).json({ detail: 'Укажите модель и серийные номера' });
      return;
    }
    const db = getDb();
    const okId = b.status_id ? Number(b.status_id) : getStatusByRole('ok');
    const now = nowIso();
    const recDate = String(b.received_date || now.slice(0, 10));
    const createdIds: number[] = [];
    const duplicates: string[] = [];

    for (const sn of serials) {
      if (db.prepare('SELECT id FROM equipment WHERE serial_number = ?').get(sn)) {
        duplicates.push(sn);
        continue;
      }
      const info = db
        .prepare(
          `INSERT INTO equipment (model_id, serial_number, place, status_id, received_date, notes, created_at, updated_at)
           VALUES (?, ?, 'stock', ?, ?, ?, ?, ?)`,
        )
        .run(Number(b.model_id), sn, okId, recDate, String(b.notes || ''), now, now);
      const eid = Number(info.lastInsertRowid);
      createdIds.push(eid);
      logEquipmentHistory({
        equipment_id: eid,
        serial_number: sn,
        action_type: 'Приёмка',
        performed_by: req.sessionUser?.username || '',
        comment: String(b.notes || ''),
        event_date: recDate,
      });
    }
    res.status(201).json({ created: createdIds, duplicates, skipped: duplicates, ids: createdIds });
  });

  router.put('/api/equipment/items/:itemId', (req, res) => {
    const id = Number(req.params.itemId);
    const b = req.body || {};
    const db = getDb();
    const existing = db.prepare('SELECT * FROM equipment WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Оборудование не найдено' });
      return;
    }
    db.prepare('UPDATE equipment SET model_id=?, notes=?, updated_at=? WHERE id=?').run(
      b.model_id ? Number(b.model_id) : Number(existing.model_id),
      b.notes !== undefined ? String(b.notes ?? '') : existing.notes != null ? String(existing.notes) : null,
      nowIso(),
      id,
    );
    const fieldPayload = b.extra && typeof b.extra === 'object' ? b.extra : b.fields && typeof b.fields === 'object' ? b.fields : null;
    if (fieldPayload) {
      const upsert = db.prepare(
        'INSERT INTO equipment_field_values (equipment_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT(equipment_id, field_id) DO UPDATE SET value = excluded.value',
      );
      for (const [fid, val] of Object.entries(fieldPayload)) {
        upsert.run(id, Number(fid), String(val || ''));
      }
    }
    res.json(hydrateEquipmentRow(queryEquipmentBase('WHERE e.id = ?', [id])[0]));
  });

  router.post('/api/equipment/items/:itemId/rename', (req: AuthedRequest, res) => {
    const id = Number(req.params.itemId);
    const serial = String(req.body?.serial_number || '').trim();
    if (!serial) {
      res.status(400).json({ detail: 'Укажите новый серийный номер' });
      return;
    }
    const db = getDb();
    try {
      db.prepare('UPDATE equipment SET serial_number=?, updated_at=? WHERE id=?').run(serial, nowIso(), id);
      logEquipmentHistory({
        equipment_id: id,
        serial_number: serial,
        action_type: 'Исправление номера',
        performed_by: req.sessionUser?.username || '',
      });
      res.json(hydrateEquipmentRow(queryEquipmentBase('WHERE e.id = ?', [id])[0]));
    } catch {
      res.status(409).json({ detail: 'Такой серийный номер уже существует' });
    }
  });

  router.post('/api/equipment/items/:itemId/set-status', (req: AuthedRequest, res) => {
    const id = Number(req.params.itemId);
    const statusId = Number(req.body?.status_id);
    const db = getDb();
    db.prepare('UPDATE equipment SET status_id=?, updated_at=? WHERE id=?').run(statusId, nowIso(), id);
    logEquipmentHistory({
      equipment_id: id,
      action_type: 'Изменение статуса',
      performed_by: req.sessionUser?.username || '',
      comment: String(req.body?.comment || ''),
    });
    res.json(hydrateEquipmentRow(queryEquipmentBase('WHERE e.id = ?', [id])[0]));
  });

  router.post('/api/equipment/items/bulk-status', (req: AuthedRequest, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const statusId = Number(req.body?.status_id);
    const db = getDb();
    const upd = db.prepare('UPDATE equipment SET status_id=?, updated_at=? WHERE id=?');
    const changed: number[] = [];
    const skipped: Array<{ id: number; serial_number?: string; reason: string }> = [];
    const now = nowIso();
    for (const id of ids) {
      const row = db.prepare('SELECT id, serial_number, place FROM equipment WHERE id = ?').get(id) as
        | { id: number; serial_number: string; place: string }
        | undefined;
      if (!row) continue;
      if (row.place !== 'stock') {
        skipped.push({ id, serial_number: row.serial_number, reason: 'не на складе' });
        continue;
      }
      upd.run(statusId, now, id);
      changed.push(id);
    }
    res.json({ ok: true, updated: changed.length, changed, skipped });
  });

  router.post('/api/equipment/items/bulk-delete', (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const db = getDb();
    const del = db.prepare('DELETE FROM equipment WHERE id = ?');
    const deleted: number[] = [];
    const skipped: Array<{ id: number; serial_number?: string; reason: string }> = [];
    for (const id of ids) {
      const row = db.prepare('SELECT id, serial_number, place FROM equipment WHERE id = ?').get(id) as
        | { id: number; serial_number: string; place: string }
        | undefined;
      if (!row) continue;
      if (row.place !== 'stock' && row.place !== 'unknown') {
        skipped.push({ id, serial_number: row.serial_number, reason: 'не на складе' });
        continue;
      }
      del.run(id);
      deleted.push(id);
    }
    res.json({ ok: true, deleted, skipped });
  });

  router.delete('/api/equipment/items/:itemId', (req, res) => {
    getDb().prepare('DELETE FROM equipment WHERE id = ?').run(Number(req.params.itemId));
    res.json({ ok: true });
  });

  router.post('/api/equipment/items/:itemId/note', (req: AuthedRequest, res) => {
    const id = Number(req.params.itemId);
    const comment = String(req.body?.comment ?? req.body?.note ?? '').trim();
    const evDate = String(req.body?.date || nowIso().slice(0, 10));
    const row = getDb().prepare('SELECT serial_number FROM equipment WHERE id = ?').get(id) as { serial_number: string } | undefined;
    logEquipmentHistory({
      equipment_id: id,
      serial_number: row?.serial_number,
      action_type: 'Запись',
      performed_by: req.sessionUser?.username || '',
      comment,
      event_date: evDate,
    });
    res.json({ ok: true });
  });

  router.post('/api/equipment/issue', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const rawIds = Array.isArray(b.equipment_ids) ? b.equipment_ids : Array.isArray(b.ids) ? b.ids : b.equipment_id ? [b.equipment_id] : [];
    const ids: number[] = rawIds.map(Number).filter(Number.isFinite);
    const personId = Number(b.person_id);
    const db = getDb();
    const person = db.prepare('SELECT full_name FROM people WHERE id = ?').get(personId) as { full_name: string } | undefined;
    if (!person) {
      res.status(404).json({ detail: 'Сотрудник не найден' });
      return;
    }
    const personName = decryptField(person.full_name);
    const now = nowIso();
    const issueDate = String(b.date || now.slice(0, 10));
    const comment = String(b.comment || '');
    const upd = db.prepare(
      "UPDATE equipment SET place='person', person_id=?, point_id=NULL, held_reason='issued', issued_date=?, updated_at=? WHERE id=?",
    );
    const issued: number[] = [];
    const skipped: Array<{ id: number; serial_number?: string; reason: string }> = [];
    for (const id of ids) {
      const row = db.prepare('SELECT id, serial_number, place FROM equipment WHERE id = ?').get(id) as
        | { id: number; serial_number: string; place: string }
        | undefined;
      if (!row) continue;
      if (row.place !== 'stock') {
        skipped.push({ id, serial_number: row.serial_number, reason: 'не на складе' });
        continue;
      }
      upd.run(personId, issueDate, now, id);
      issued.push(id);
      logEquipmentHistory({
        equipment_id: id,
        serial_number: row.serial_number,
        action_type: 'Выдача монтёру',
        person_id: personId,
        person_name: personName,
        performed_by: req.sessionUser?.username || '',
        comment,
        event_date: issueDate,
      });
    }
    res.json({ ok: true, issued, skipped });
  });

  router.post('/api/equipment/accept', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const rawIds = Array.isArray(b.equipment_ids) ? b.equipment_ids : Array.isArray(b.ids) ? b.ids : b.equipment_id ? [b.equipment_id] : [];
    const ids: number[] = rawIds.map(Number).filter(Number.isFinite);
    const db = getDb();
    const explicitStatusId = b.status_id ? Number(b.status_id) : null;
    const defaultOkId = getStatusByRole('ok');
    const now = nowIso();
    const comment = String(b.comment || '');
    const upd = db.prepare(
      "UPDATE equipment SET place='stock', person_id=NULL, point_id=NULL, held_reason=NULL, status_id=?, accepted_date=?, accepted_by=?, updated_at=? WHERE id=?",
    );
    const accepted: number[] = [];
    const skipped: Array<{ id: number; serial_number?: string; reason: string }> = [];
    for (const id of ids) {
      const row = db.prepare('SELECT id, serial_number, status_id, person_id FROM equipment WHERE id = ?').get(id) as
        | { id: number; serial_number: string; status_id: number | null; person_id: number | null }
        | undefined;
      if (!row) continue;
      const targetStatusId = explicitStatusId ?? row.status_id ?? defaultOkId;
      upd.run(targetStatusId, now.slice(0, 10), req.sessionUser?.username || '', now, id);
      accepted.push(id);
      logEquipmentHistory({
        equipment_id: id,
        serial_number: row.serial_number,
        action_type: 'Приём от монтёра',
        person_id: row.person_id,
        performed_by: req.sessionUser?.username || '',
        comment,
      });
    }
    res.json({ ok: true, accepted, skipped });
  });

  router.post('/api/equipment/accept-substitute', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const expectedId = Number(b.expected_id || b.equipment_id);
    const db = getDb();
    const expected = db.prepare('SELECT * FROM equipment WHERE id = ?').get(expectedId) as Record<string, unknown> | undefined;
    if (!expected) {
      res.status(404).json({ detail: 'Оборудование не найдено' });
      return;
    }
    const now = nowIso();
    let actualId = b.actual_equipment_id ? Number(b.actual_equipment_id) : null;
    if (!actualId && b.actual_serial) {
      const serial = String(b.actual_serial).trim();
      const found = db.prepare('SELECT id FROM equipment WHERE serial_number = ?').get(serial) as { id: number } | undefined;
      if (found) {
        actualId = found.id;
      } else if (b.create_missing) {
        const stVal = b.status_id ? Number(b.status_id) : (expected.status_id != null ? Number(expected.status_id) : getStatusByRole('defect'));
        const info = db
          .prepare(
            "INSERT INTO equipment (model_id, serial_number, place, status_id, received_date, created_at, updated_at) VALUES (?, ?, 'stock', ?, ?, ?, ?)",
          )
          .run(Number(expected.model_id), serial, stVal, now.slice(0, 10), now, now);
        actualId = Number(info.lastInsertRowid);
      } else {
        res.status(404).json({ detail: 'Такого номера нет в базе. Отметьте «записать как новое», если нужно создать.' });
        return;
      }
    }
    if (!actualId) {
      res.status(400).json({ detail: 'Укажите фактический номер оборудования' });
      return;
    }
    const actual = db.prepare('SELECT * FROM equipment WHERE id = ?').get(actualId) as Record<string, unknown>;
    const statusId = b.status_id ? Number(b.status_id) : Number(expected.status_id || getStatusByRole('defect'));
    db.prepare("UPDATE equipment SET place='unknown', person_id=NULL, point_id=NULL, held_reason=NULL, updated_at=? WHERE id=?").run(now, expectedId);
    db.prepare(
      "UPDATE equipment SET place='stock', person_id=NULL, point_id=NULL, held_reason=NULL, status_id=?, accepted_date=?, accepted_by=?, updated_at=? WHERE id=?",
    ).run(statusId, now.slice(0, 10), req.sessionUser?.username || '', now, actualId);
    logEquipmentHistory({
      equipment_id: actualId,
      serial_number: String(actual.serial_number || ''),
      action_type: 'Приём от монтёра (замена номера)',
      performed_by: req.sessionUser?.username || '',
      comment: String(b.comment || `Вместо №${expected.serial_number}`),
    });
    res.json({ ok: true, accepted: String(actual.serial_number || ''), unknown: String(expected.serial_number || '') });
  });

  router.post('/api/equipment/items/:itemId/found', (req: AuthedRequest, res) => {
    const id = Number(req.params.itemId);
    const now = nowIso();
    getDb()
      .prepare("UPDATE equipment SET place='stock', person_id=NULL, point_id=NULL, held_reason=NULL, updated_at=? WHERE id=?")
      .run(now, id);
    logEquipmentHistory({
      equipment_id: id,
      action_type: 'Найдено — возвращено на склад',
      performed_by: req.sessionUser?.username || '',
    });
    res.json({ ok: true });
  });

  router.get('/api/equipment/people-summary', (req, res) => {
    const db = getDb();
    const filterPersonId = req.query.person_id ? Number(req.query.person_id) : null;
    const people = db.prepare("SELECT id, full_name, role_type FROM people WHERE role_type != 'warehouse' ORDER BY id").all() as Array<{
      id: number;
      full_name: string;
      role_type: string;
    }>;
    const eqRows = queryEquipmentBase("WHERE e.place = 'person'").map(hydrateEquipmentRow);
    const byPerson = new Map<number, typeof eqRows>();
    for (const e of eqRows) {
      if (e.person_id) {
        const list = byPerson.get(Number(e.person_id)) || [];
        list.push(e);
        byPerson.set(Number(e.person_id), list);
      }
    }
    const groups = people
      .filter((p) => (filterPersonId ? p.id === filterPersonId : (byPerson.get(p.id) || []).length > 0))
      .map((p) => {
        const items = byPerson.get(p.id) || [];
        return {
          person_id: p.id,
          id: p.id,
          full_name: decryptField(p.full_name),
          role_type: p.role_type,
          items,
          count: items.length,
          awaiting: items.filter((i) => i.awaiting_accept).length,
          kept: items.filter((i) => i.kept).length,
        };
      })
      .filter((g) => g.count > 0);
    res.json(groups);
  });

  router.get('/api/equipment/awaiting', (_req, res) => {
    const rows = queryEquipmentBase("WHERE e.place = 'person' AND e.held_reason IN ('removed', 'kept')").map(
      hydrateEquipmentRow,
    );
    res.json(rows);
  });

  router.get('/api/equipment/points', (req: AuthedRequest, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
    const hasEq = req.query.has_equipment === 'true';
    const hasPanel = req.query.has_panel === 'true';
    const limit = req.query.limit !== undefined ? Math.max(1, Number(req.query.limit) || 200) : 200;
    const offset = Math.max(0, Number(req.query.offset || 0));

    const db = getDb();
    const perms = req.sessionUser!.permissions;
    let pts = db
      .prepare(
        `SELECT p.id, p.address, p.description, p.status, p.inventory_number, p.sim_number, p.ip_address,
                p.category_id, pc.name as category_name, pc.color as category_color,
                (SELECT sp.panel_number FROM solar_panels sp WHERE sp.point_id = p.id LIMIT 1) as panel_number
         FROM points p
         LEFT JOIN point_categories pc ON pc.id = p.category_id
         ORDER BY p.id`,
      )
      .all() as Array<Record<string, unknown>>;

    const counts = db
      .prepare("SELECT point_id, COUNT(*) as cnt FROM equipment WHERE place = 'point' GROUP BY point_id")
      .all() as Array<{ point_id: string; cnt: number }>;
    const cntMap = new Map(counts.map((c) => [c.point_id, Number(c.cnt)]));

    let eqSerialsByPoint: Map<string, string[]> | null = null;
    if (search) {
      eqSerialsByPoint = new Map<string, string[]>();
      const eqOnPts = db
        .prepare("SELECT point_id, serial_number FROM equipment WHERE place = 'point' AND point_id IS NOT NULL")
        .all() as Array<{ point_id: string; serial_number: string }>;
      for (const e of eqOnPts) {
        const list = eqSerialsByPoint.get(e.point_id) || [];
        list.push(e.serial_number);
        eqSerialsByPoint.set(e.point_id, list);
      }
    }

    if (categoryId) {
      pts = pts.filter((p) => Number(p.category_id) === categoryId);
    }
    if (hasEq) {
      pts = pts.filter((p) => (cntMap.get(String(p.id)) || 0) > 0);
    }
    if (hasPanel) {
      pts = pts.filter((p) => Boolean(p.panel_number));
    }
    if (search) {
      pts = pts.filter((p) => {
        const pid = String(p.id);
        const eqSerials = eqSerialsByPoint?.get(pid) || [];
        return [p.id, p.address, p.description, p.inventory_number, p.sim_number, p.panel_number, ...eqSerials].some((v) =>
          String(v || '').toLowerCase().includes(search),
        );
      });
    }

    const total = pts.length;
    const sliced = pts.slice(offset, offset + limit).map((p) => ({
      ...p,
      inventory_number: p.inventory_number || '',
      category_name: p.category_name || '',
      category_color: p.category_color || '',
      panel_number: p.panel_number || '',
      ip_address: networkOk(perms) ? p.ip_address : '',
      equipment_count: cntMap.get(String(p.id)) || 0,
    }));
    res.setHeader('X-Total-Count', String(total));
    res.json(sliced);
  });

  router.get('/api/equipment/points/:pointId', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const point = db
      .prepare(
        `SELECT p.*, pc.name as category_name, pc.color as category_color
         FROM points p
         LEFT JOIN point_categories pc ON pc.id = p.category_id
         WHERE p.id = ?`,
      )
      .get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Комплекс не найден' });
      return;
    }
    const perms = req.sessionUser!.permissions;
    const items = queryEquipmentBase("WHERE e.place = 'point' AND e.point_id = ?", [pointId]).map(hydrateEquipmentRow);
    const panels = db.prepare('SELECT * FROM solar_panels WHERE point_id = ?').all(pointId) as Array<Record<string, unknown>>;
    const history = db
      .prepare('SELECT * FROM equipment_history WHERE point_id = ? ORDER BY id DESC LIMIT 100')
      .all(pointId);
    const hydratedPoint = {
      ...point,
      category_name: point.category_name || '',
      category_color: point.category_color || '',
      login: secretsOk(perms) ? decryptField(String(point.login || '')) : '',
      password: secretsOk(perms) ? decryptField(String(point.password || '')) : '',
      ip_address: networkOk(perms) ? point.ip_address : '',
    };
    res.json({
      ...hydratedPoint,
      point: hydratedPoint,
      panel: panels[0] || null,
      equipment: items,
      items,
      solar_panels: panels,
      history,
    });
  });

  router.post('/api/equipment/points/:pointId/attach', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const b = req.body || {};
    const eqId = Number(b.equipment_id);
    const now = nowIso();
    const instDate = String(b.date || now.slice(0, 10));
    const instBy = String(b.installed_by || req.sessionUser?.username || '');
    getDb()
      .prepare("UPDATE equipment SET place='point', point_id=?, person_id=NULL, held_reason=NULL, installed_date=?, installed_by=?, updated_at=? WHERE id=?")
      .run(pointId, instDate, instBy, now, eqId);
    logEquipmentHistory({
      equipment_id: eqId,
      point_id: pointId,
      action_type: 'Установка на комплекс',
      performed_by: req.sessionUser?.username || '',
      comment: String(b.comment || ''),
      event_date: instDate,
    });
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/replace', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const b = req.body || {};
    const oldId = Number(b.old_equipment_id);
    const newId = Number(b.new_equipment_id);
    const personId = b.person_id ? Number(b.person_id) : null;
    const removedStatusId = b.removed_status_id ? Number(b.removed_status_id) : getStatusByRole('defect');
    const now = nowIso();
    const evDate = String(b.date || now.slice(0, 10));
    const reason = String(b.reason || '').trim() || null;
    const comment = String(b.comment || '').trim();
    const db = getDb();
    let personName = '';
    if (personId) {
      const p = db.prepare('SELECT full_name FROM people WHERE id = ?').get(personId) as { full_name: string } | undefined;
      if (p) personName = decryptField(p.full_name);
    }
    if (oldId) {
      const oldEq = db
        .prepare('SELECT e.*, c.kind as category_kind FROM equipment e LEFT JOIN equipment_models m ON m.id = e.model_id LEFT JOIN equipment_categories c ON c.id = m.category_id WHERE e.id = ?')
        .get(oldId) as Record<string, unknown> | undefined;
      const isSim = oldEq?.category_kind === 'sim';
      const nextPlace = personId ? 'person' : 'stock';
      const heldReason = personId ? (isSim ? 'kept' : 'removed') : null;
      db.prepare(
        'UPDATE equipment SET place=?, person_id=?, held_reason=?, point_id=NULL, status_id=?, removed_date=?, removed_by=?, removed_point_id=?, removal_reason=?, updated_at=? WHERE id=?',
      ).run(nextPlace, personId, heldReason, removedStatusId, evDate, personName || req.sessionUser?.username || '', pointId, reason, now, oldId);
      logEquipmentHistory({
        equipment_id: oldId,
        serial_number: String(oldEq?.serial_number || ''),
        point_id: pointId,
        person_id: personId,
        person_name: personName || null,
        action_type: 'Замена — снятие',
        performed_by: req.sessionUser?.username || '',
        comment: [reason, comment].filter(Boolean).join(' · '),
        event_date: evDate,
      });
    }
    if (newId) {
      const newEq = db.prepare('SELECT serial_number FROM equipment WHERE id = ?').get(newId) as { serial_number: string } | undefined;
      db.prepare(
        "UPDATE equipment SET place='point', point_id=?, person_id=NULL, held_reason=NULL, installed_date=?, installed_by=?, updated_at=? WHERE id=?",
      ).run(pointId, evDate, personName || req.sessionUser?.username || '', now, newId);
      logEquipmentHistory({
        equipment_id: newId,
        serial_number: newEq?.serial_number,
        point_id: pointId,
        person_id: personId,
        person_name: personName || null,
        action_type: 'Замена — установка',
        performed_by: req.sessionUser?.username || '',
        comment,
        event_date: evDate,
      });
    }
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/detach/:equipmentId', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const eqId = Number(req.params.equipmentId);
    const b = req.body || {};
    const personId = b.to_person_id ? Number(b.to_person_id) : null;
    const statusId = b.status_id ? Number(b.status_id) : getStatusByRole('defect');
    const now = nowIso();
    const evDate = String(b.date || now.slice(0, 10));
    const reason = String(b.reason || '').trim() || null;
    const comment = String(b.comment || '').trim();
    const db = getDb();
    let personName = '';
    if (personId) {
      const p = db.prepare('SELECT full_name FROM people WHERE id = ?').get(personId) as { full_name: string } | undefined;
      if (p) personName = decryptField(p.full_name);
    }
    const eqRow = db
      .prepare('SELECT e.*, c.kind as category_kind FROM equipment e LEFT JOIN equipment_models m ON m.id = e.model_id LEFT JOIN equipment_categories c ON c.id = m.category_id WHERE e.id = ?')
      .get(eqId) as Record<string, unknown> | undefined;
    const isSim = eqRow?.category_kind === 'sim';
    const nextPlace = personId ? 'person' : 'stock';
    const heldReason = personId ? (isSim ? 'kept' : 'removed') : null;
    db.prepare(
      'UPDATE equipment SET place=?, person_id=?, held_reason=?, point_id=NULL, status_id=?, removed_date=?, removed_by=?, removed_point_id=?, removal_reason=?, updated_at=? WHERE id=?',
    ).run(nextPlace, personId, heldReason, statusId, evDate, personName || req.sessionUser?.username || '', pointId, reason, now, eqId);
    logEquipmentHistory({
      equipment_id: eqId,
      serial_number: String(eqRow?.serial_number || ''),
      point_id: pointId,
      person_id: personId,
      person_name: personName || null,
      action_type: 'Снятие с комплекса',
      performed_by: req.sessionUser?.username || '',
      comment: [reason, comment].filter(Boolean).join(' · '),
      event_date: evDate,
    });
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/sim/replace', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const rawSerial = String(req.body?.serial_number || req.body?.sim_number || '').trim();
    const sim = rawSerial.replace(/\D+/g, '').slice(-7) || rawSerial;
    const db = getDb();
    db.prepare('UPDATE points SET sim_number = ? WHERE id = ?').run(sim, pointId);
    logEquipmentHistory({
      point_id: pointId,
      serial_number: sim,
      action_type: 'Замена SIM',
      performed_by: req.sessionUser?.username || '',
      comment: String(req.body?.reason || ''),
    });
    res.json({ ok: true, ip_known: true });
  });

  router.post('/api/equipment/points/:pointId/sim/fix', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const rawSerial = String(req.body?.serial_number || req.body?.sim_number || '').trim();
    const sim = rawSerial.replace(/\D+/g, '').slice(-7) || rawSerial;
    const db = getDb();
    db.prepare('UPDATE points SET sim_number = ? WHERE id = ?').run(sim, pointId);
    const simCat = db.prepare("SELECT id FROM equipment_categories WHERE kind = 'sim' LIMIT 1").get() as { id: number } | undefined;
    if (simCat && sim) {
      let simMod = db.prepare('SELECT id FROM equipment_models WHERE category_id = ? LIMIT 1').get(simCat.id) as { id: number } | undefined;
      if (!simMod) {
        const inf = db.prepare('INSERT INTO equipment_models (category_id, name) VALUES (?, ?)').run(simCat.id, 'SIM-карта');
        simMod = { id: Number(inf.lastInsertRowid) };
      }
      const existingSim = db
        .prepare("SELECT e.id FROM equipment e JOIN equipment_models m ON m.id = e.model_id WHERE m.category_id = ? AND e.place = 'point' AND e.point_id = ? LIMIT 1")
        .get(simCat.id, pointId) as { id: number } | undefined;
      const now = nowIso();
      if (existingSim) {
        db.prepare('UPDATE equipment SET serial_number = ?, updated_at = ? WHERE id = ?').run(sim, now, existingSim.id);
      } else {
        const bySn = db.prepare('SELECT id FROM equipment WHERE serial_number = ?').get(sim) as { id: number } | undefined;
        if (bySn) {
          db.prepare("UPDATE equipment SET place='point', point_id=?, updated_at=? WHERE id=?").run(pointId, now, bySn.id);
        } else {
          db.prepare(
            "INSERT INTO equipment (model_id, serial_number, place, status_id, point_id, installed_date, created_at, updated_at) VALUES (?, ?, 'point', ?, ?, ?, ?, ?)",
          ).run(simMod.id, sim, getStatusByRole('ok'), pointId, now.slice(0, 10), now, now);
        }
      }
    }
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/note', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const comment = String(req.body?.comment ?? req.body?.notes ?? '').trim();
    const evDate = String(req.body?.date || nowIso().slice(0, 10));
    logEquipmentHistory({
      point_id: pointId,
      action_type: 'Запись',
      performed_by: req.sessionUser?.username || '',
      comment,
      event_date: evDate,
    });
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/link-panel', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const panelId = req.body?.panel_id != null && req.body?.panel_id !== '' ? Number(req.body.panel_id) : null;
    const db = getDb();
    const now = nowIso();
    if (!panelId) {
      db.prepare('UPDATE solar_panels SET point_id = NULL, updated_at = ? WHERE point_id = ?').run(now, pointId);
    } else {
      db.prepare('UPDATE solar_panels SET point_id = NULL, updated_at = ? WHERE point_id = ?').run(now, pointId);
      db.prepare('UPDATE solar_panels SET point_id = ?, at_warehouse = 0, updated_at = ? WHERE id = ?').run(pointId, now, panelId);
    }
    res.json({ ok: true });
  });

  // ---- HISTORY & REPORTS ----
  function filterHistoryRows(query: Record<string, unknown>) {
    const search = String(query.search || '').trim().toLowerCase();
    const actionType = String(query.action_type || '').trim();
    const dateFrom = String(query.date_from || '').trim();
    const dateTo = String(query.date_to || '').trim();
    let rows = getDb().prepare('SELECT * FROM equipment_history ORDER BY id DESC').all() as Array<Record<string, unknown>>;
    if (actionType) rows = rows.filter((r) => String(r.action_type || '') === actionType);
    if (dateFrom) rows = rows.filter((r) => String(r.event_date || r.ts || '').slice(0, 10) >= dateFrom);
    if (dateTo) rows = rows.filter((r) => String(r.event_date || r.ts || '').slice(0, 10) <= dateTo);
    if (search) {
      rows = rows.filter((r) =>
        [r.serial_number, r.model_name, r.point_id, r.person_name, r.performed_by, r.comment, r.action_type].some((v) =>
          String(v || '').toLowerCase().includes(search),
        ),
      );
    }
    return rows;
  }

  router.get('/api/equipment/history', (req, res) => {
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit || 200)));
    const db = getDb();
    const actionTypes = (
      db.prepare("SELECT DISTINCT action_type FROM equipment_history WHERE coalesce(action_type, '') != '' ORDER BY action_type").all() as Array<{
        action_type: string;
      }>
    ).map((r) => r.action_type);
    const rows = filterHistoryRows(req.query as Record<string, unknown>);
    res.json({ items: rows.slice(0, limit), total: rows.length, action_types: actionTypes });
  });

  router.put('/api/equipment/history/:entryId', (req, res) => {
    const id = Number(req.params.entryId);
    const b = req.body || {};
    const db = getDb();
    const existing = db.prepare('SELECT * FROM equipment_history WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Запись не найдена' });
      return;
    }
    db.prepare('UPDATE equipment_history SET event_date = ?, comment = ?, performed_by = ? WHERE id = ?').run(
      b.event_date !== undefined ? String(b.event_date || '') : String(existing.event_date || ''),
      b.comment !== undefined ? String(b.comment || '') : String(existing.comment || ''),
      b.performed_by !== undefined ? String(b.performed_by || '') : String(existing.performed_by || ''),
      id,
    );
    res.json({ ok: true });
  });

  router.delete('/api/equipment/history/:entryId', (req, res) => {
    getDb().prepare('DELETE FROM equipment_history WHERE id = ?').run(Number(req.params.entryId));
    res.json({ ok: true });
  });

  router.delete('/api/equipment/history', (req, res) => {
    const rows = filterHistoryRows(req.query as Record<string, unknown>);
    const db = getDb();
    const del = db.prepare('DELETE FROM equipment_history WHERE id = ?');
    for (const r of rows) del.run(Number(r.id));
    res.json({ ok: true, deleted: rows.length });
  });

  router.get('/api/equipment/reports/summary', (req, res) => {
    const db = getDb();
    const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
    const statusId = req.query.status_id ? Number(req.query.status_id) : null;
    const dateFrom = String(req.query.date_from || '').trim();
    const dateTo = String(req.query.date_to || '').trim();

    let items = queryEquipmentBase().map(hydrateEquipmentRow);
    if (categoryId) items = items.filter((r) => Number(r.category_id) === categoryId);
    if (statusId) items = items.filter((r) => Number(r.status_id) === statusId);
    if (dateFrom || dateTo) {
      items = items.filter((r) => {
        const dt = String(r.installed_date || r.removed_date || r.issued_date || r.accepted_date || r.received_date || '').slice(0, 10);
        if (!dt) return false;
        if (dateFrom && dt < dateFrom) return false;
        if (dateTo && dt > dateTo) return false;
        return true;
      });
    }

    const columns = [
      { key: 'stock_ok', label: 'На складе (годное)', color: '#10b981' },
      { key: 'stock_defect', label: 'На складе (не выдаётся)', color: '#ef4444' },
      { key: 'person', label: 'У монтёров', color: '#f59e0b' },
      { key: 'point', label: 'На комплексах', color: '#6366f1' },
      { key: 'unknown', label: 'Неизвестно', color: '#f97316' },
    ];

    const byCatMap = new Map<string, { category: string; counts: Record<string, number>; total: number }>();
    const totals: Record<string, number> = { stock_ok: 0, stock_defect: 0, person: 0, point: 0, unknown: 0 };

    for (const it of items) {
      const catName = it.category_name || 'Без категории';
      let row = byCatMap.get(catName);
      if (!row) {
        row = { category: catName, counts: { stock_ok: 0, stock_defect: 0, person: 0, point: 0, unknown: 0 }, total: 0 };
        byCatMap.set(catName, row);
      }
      const colKey =
        it.place === 'stock'
          ? it.status_usable
            ? 'stock_ok'
            : 'stock_defect'
          : it.place === 'person'
            ? 'person'
            : it.place === 'point'
              ? 'point'
              : 'unknown';
      row.counts[colKey] = (row.counts[colKey] || 0) + 1;
      row.total += 1;
      totals[colKey] = (totals[colKey] || 0) + 1;
    }

    const rows = Array.from(byCatMap.values()).sort((a, b) => a.category.localeCompare(b.category, 'ru'));
    const byPlace = db.prepare('SELECT place, COUNT(*) as count FROM equipment GROUP BY place').all();
    const byStatus = db
      .prepare("SELECT coalesce(s.name, 'Без статуса') as name, coalesce(s.color, '#64748b') as color, COUNT(*) as count FROM equipment e LEFT JOIN equipment_statuses s ON s.id = e.status_id GROUP BY e.status_id")
      .all();
    const byCategory = db
      .prepare('SELECT c.name, COUNT(*) as count FROM equipment e JOIN equipment_models m ON m.id = e.model_id JOIN equipment_categories c ON c.id = m.category_id GROUP BY c.id')
      .all();

    res.json({
      columns,
      rows,
      totals,
      total: items.length,
      by_place: byPlace,
      by_status: byStatus,
      by_category: byCategory,
    });
  });

  async function sendEquipmentExcel(res: import('express').Response, title: string, headers: string[], rows: unknown[][], filename: string) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(title);
    ws.addRow(headers);
    for (const r of rows) ws.addRow(r);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  }

  router.get('/api/equipment/export/summary.xlsx', async (_req, res) => {
    const rows = queryEquipmentBase().map((r) => {
      const e = hydrateEquipmentRow(r);
      return [e.id, e.category_name, e.model_name, e.serial_number, e.place, e.status_name, e.point_id || '', e.person_name || ''];
    });
    await sendEquipmentExcel(res, 'Сводка', ['ID', 'Категория', 'Модель', 'Серийный номер', 'Место', 'Статус', 'Комплекс', 'Сотрудник'], rows, 'equipment-summary.xlsx');
  });

  router.get('/api/equipment/export/items.xlsx', async (_req, res) => {
    const rows = queryEquipmentBase().map((r) => {
      const e = hydrateEquipmentRow(r);
      return [e.id, e.category_name, e.model_name, e.serial_number, e.place, e.status_name, e.point_id || '', e.person_name || '', e.notes || ''];
    });
    await sendEquipmentExcel(res, 'Оборудование', ['ID', 'Категория', 'Модель', 'Серийный номер', 'Место', 'Статус', 'Комплекс', 'Сотрудник', 'Примечание'], rows, 'equipment-items.xlsx');
  });

  router.post('/api/equipment/export/items.xlsx', async (_req, res) => {
    const rows = queryEquipmentBase().map((r) => {
      const e = hydrateEquipmentRow(r);
      return [e.id, e.category_name, e.model_name, e.serial_number, e.place, e.status_name, e.point_id || '', e.person_name || '', e.notes || ''];
    });
    await sendEquipmentExcel(res, 'Оборудование', ['ID', 'Категория', 'Модель', 'Серийный номер', 'Место', 'Статус', 'Комплекс', 'Сотрудник', 'Примечание'], rows, 'equipment-items.xlsx');
  });

  router.get('/api/equipment/export/people.xlsx', async (_req, res) => {
    const rows = queryEquipmentBase("WHERE e.place = 'person'").map((r) => {
      const e = hydrateEquipmentRow(r);
      return [e.person_name || '', e.category_name, e.model_name, e.serial_number, e.issued_date || ''];
    });
    await sendEquipmentExcel(res, 'У монтёров', ['Сотрудник', 'Категория', 'Модель', 'Серийный номер', 'Дата выдачи'], rows, 'equipment-people.xlsx');
  });

  router.get('/api/equipment/export/history.xlsx', async (_req, res) => {
    const rows = (getDb().prepare('SELECT * FROM equipment_history ORDER BY id DESC LIMIT 2000').all() as Array<Record<string, unknown>>).map((r) => [
      r.ts, r.action_type, r.serial_number || '', r.model_name || '', r.person_name || '', r.point_id || '', r.performed_by || '', r.comment || '',
    ]);
    await sendEquipmentExcel(res, 'История', ['Время', 'Операция', 'Серийный номер', 'Модель', 'Сотрудник', 'Комплекс', 'Кто выполнил', 'Комментарий'], rows, 'equipment-history.xlsx');
  });

  router.get('/api/equipment/export/points.xlsx', async (_req, res) => {
    const rows = queryEquipmentBase("WHERE e.place = 'point'").map((r) => {
      const e = hydrateEquipmentRow(r);
      return [e.point_id || '', e.category_name, e.model_name, e.serial_number, e.installed_date || ''];
    });
    await sendEquipmentExcel(res, 'На комплексах', ['Комплекс', 'Категория', 'Модель', 'Серийный номер', 'Дата установки'], rows, 'equipment-points.xlsx');
  });

  const IMP_ROLES: Record<string, string> = {
    ignore: '— пропустить —',
    serial: 'Серийный номер',
    model: 'Модель',
    category: 'Категория',
    point: 'Комплекс (номер)',
    point_inv: 'Инвентарный № комплекса',
    status: 'Статус / место',
    person: 'Монтёр',
    issued_date: 'Дата выдачи',
    installed_date: 'Дата монтажа',
    installed_by: 'Кто установил',
    received_date: 'Дата приёмки',
    notes: 'Примечание',
    extra: 'Дополнительное поле',
    serial_of: 'Серийный № категории…',
  };

  function guessColumnRole(header: string): { role: string; field?: string } {
    const h = header.trim().toLowerCase();
    if (!h || h === '№' || h === 'п/п' || h === '№ п/п') return { role: 'ignore' };
    if (h.includes('серий') || h.includes('s/n') || h === 'sn' || h.includes('заводск') || h.includes('номер карты') || h.includes('сим')) return { role: 'serial' };
    if (h.includes('модел') || h.includes('тип оборуд')) return { role: 'model' };
    if (h.includes('категор')) return { role: 'category' };
    if (h.includes('инв') && h.includes('компл')) return { role: 'point_inv' };
    if (h.includes('комплекс') || h.includes('апк') || h.includes('рубеж') || h.includes('точка')) return { role: 'point' };
    if (h.includes('статус') || h.includes('состоян')) return { role: 'status' };
    if (h.includes('монтёр') || h.includes('монтер') || h.includes('сотрудник') || h.includes('фио')) return { role: 'person' };
    if (h.includes('дата выдач')) return { role: 'issued_date' };
    if (h.includes('дата уст') || h.includes('дата монт')) return { role: 'installed_date' };
    if (h.includes('кто уст')) return { role: 'installed_by' };
    if (h.includes('дата приём') || h.includes('дата прием') || h.includes('дата поступ')) return { role: 'received_date' };
    if (h.includes('примеч') || h.includes('коммент')) return { role: 'notes' };
    return { role: 'extra', field: header.trim() };
  }

  function extractUploadedFiles(req: AuthedRequest): Express.Multer.File[] {
    const anyFiles = (req as unknown as { files?: Express.Multer.File[] }).files;
    if (Array.isArray(anyFiles) && anyFiles.length) return anyFiles;
    if (req.file) return [req.file];
    return [];
  }

  router.post('/api/equipment/import/xlsx/analyze', upload.any(), async (req: AuthedRequest, res) => {
    const files = extractUploadedFiles(req);
    if (!files.length) {
      res.status(400).json({ detail: 'Файлы не переданы' });
      return;
    }
    let headerOverrides: Record<string, number> = {};
    try {
      if (req.body?.header_rows) headerOverrides = JSON.parse(String(req.body.header_rows));
    } catch {
      // ignore
    }

    const sheets: Array<Record<string, unknown>> = [];
    const errors: string[] = [];

    for (const file of files) {
      const wb = new ExcelJS.Workbook();
      try {
        await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
      } catch (e) {
        errors.push(`${file.originalname}: не удалось прочитать (${(e as Error).message})`);
        continue;
      }
      for (const ws of wb.worksheets) {
        const key = `${file.originalname}::${ws.name}`;
        const headerRowIdx = Math.max(1, Number(headerOverrides[key] || 1));
        const maxCol = Math.min(40, ws.columnCount || 15);
        const headerRow = ws.getRow(headerRowIdx);
        const columns: Array<Record<string, unknown>> = [];
        let dataRows = 0;

        for (let r = headerRowIdx + 1; r <= ws.rowCount; r += 1) {
          const row = ws.getRow(r);
          let hasVal = false;
          for (let c = 1; c <= maxCol; c += 1) {
            if (String(row.getCell(c).text || row.getCell(c).value || '').trim()) {
              hasVal = true;
              break;
            }
          }
          if (hasVal) dataRows += 1;
        }

        const usedSingleRoles = new Set<string>();
        for (let c = 1; c <= maxCol; c += 1) {
          const headerText = String(headerRow.getCell(c).text || headerRow.getCell(c).value || '').trim();
          let filled = 0;
          const sample: string[] = [];
          const distinctMap = new Map<string, number>();

          for (let r = headerRowIdx + 1; r <= ws.rowCount; r += 1) {
            const val = String(ws.getRow(r).getCell(c).text || ws.getRow(r).getCell(c).value || '').trim();
            if (!val) continue;
            filled += 1;
            if (sample.length < 3 && !sample.includes(val)) sample.push(val);
            if (distinctMap.size < 30) distinctMap.set(val, (distinctMap.get(val) || 0) + 1);
          }
          if (!headerText && filled === 0) continue;

          const guessed = guessColumnRole(headerText);
          let role = guessed.role;
          if (!['ignore', 'extra', 'serial_of'].includes(role)) {
            if (usedSingleRoles.has(role)) role = 'extra';
            else usedSingleRoles.add(role);
          }

          columns.push({
            index: c - 1,
            header: headerText,
            filled,
            sample,
            role,
            field: guessed.field || headerText,
            distinct: role === 'status' ? Object.fromEntries(distinctMap.entries()) : undefined,
          });
        }

        const baseCategory = file.originalname.replace(/\.(xlsx|xlsm)$/i, '').trim();
        sheets.push({
          key,
          file: file.originalname,
          sheet: ws.name,
          enabled: dataRows > 0,
          header_row: headerRowIdx,
          data_rows: dataRows,
          category: baseCategory,
          target: baseCategory.toLowerCase().includes('панел') ? 'panels' : 'equipment',
          auto_serial: false,
          serial_prefix: '',
          rownum_col: null,
          columns,
          status_suggest: {},
          notes: [],
        });
      }
    }

    res.json({ sheets, errors, roles: IMP_ROLES });
  });

  router.post('/api/equipment/import/xlsx/run', upload.any(), async (req: AuthedRequest, res) => {
    const files = extractUploadedFiles(req);
    if (!files.length) {
      res.status(400).json({ detail: 'Файлы не переданы' });
      return;
    }
    const dryRun = String(req.body?.dry_run ?? 'true').toLowerCase() !== 'false';
    let cfg: Record<string, unknown> = {};
    try {
      if (req.body?.config) cfg = JSON.parse(String(req.body.config));
    } catch {
      // ignore
    }
    const mode = String(cfg.mode || 'merge');
    const sheetConfigs = Array.isArray(cfg.sheets) ? (cfg.sheets as Array<Record<string, unknown>>) : [];

    const db = getDb();
    const okId = getStatusByRole('ok');
    const now = nowIso();

    const totals = {
      created: 0,
      updated: 0,
      existing: 0,
      panels_created: 0,
      panels_updated: 0,
      placed_point: 0,
      placed_person: 0,
      placed_stock: 0,
      conflicts: 0,
      skipped_no_point: 0,
      models_created: 0,
      categories_created: 0,
      fields_created: 0,
    };
    const sheetReports: Array<Record<string, unknown>> = [];
    const createdNames = { categories: [] as string[], fields: [] as string[], states: [] as string[] };

    db.exec('BEGIN IMMEDIATE');
    try {
      for (const file of files) {
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(file.buffer as unknown as ArrayBuffer);
        for (const ws of wb.worksheets) {
          const shCfg = sheetConfigs.find((s) => s.file === file.originalname && s.sheet === ws.name);
          if (shCfg && !shCfg.enabled) continue;
          const headerRow = Number(shCfg?.header_row || 1);
          const colMap = (shCfg?.columns || {}) as Record<string, { role: string; field?: string; category?: string }>;
          const defCat = String(shCfg?.category || file.originalname.replace(/\.(xlsx|xlsm)$/i, '') || 'Прочее').trim();
          const defMod = String(shCfg?.model || 'Без модели').trim() || 'Без модели';

          let records = 0;
          let created = 0;
          let updated = 0;
          let existing = 0;
          let skipped = 0;

          for (let r = headerRow + 1; r <= ws.rowCount; r += 1) {
            const row = ws.getRow(r);
            let serial = '';
            let catName = defCat;
            let modName = defMod;
            let pointId = '';
            let notes = '';

            if (Object.keys(colMap).length > 0) {
              for (const [colIdxStr, cDef] of Object.entries(colMap)) {
                const cellVal = String(row.getCell(Number(colIdxStr) + 1).text || row.getCell(Number(colIdxStr) + 1).value || '').trim();
                if (!cellVal) continue;
                if (cDef.role === 'serial') serial = cellVal;
                else if (cDef.role === 'category') catName = cellVal;
                else if (cDef.role === 'model') modName = cellVal;
                else if (cDef.role === 'point') pointId = cellVal;
                else if (cDef.role === 'notes') notes = cellVal;
              }
            } else {
              serial = String(row.getCell(1).text || row.getCell(1).value || '').trim();
              catName = String(row.getCell(2).text || row.getCell(2).value || defCat).trim();
              modName = String(row.getCell(3).text || row.getCell(3).value || defMod).trim();
            }

            if (!serial) continue;
            records += 1;

            const existingCat = db.prepare('SELECT id FROM equipment_categories WHERE lower(name) = lower(?)').get(catName) as { id: number } | undefined;
            let catId: number;
            if (existingCat) {
              catId = existingCat.id;
            } else {
              const inf = db.prepare("INSERT INTO equipment_categories (name, kind) VALUES (?, '')").run(catName);
              catId = Number(inf.lastInsertRowid);
              totals.categories_created += 1;
              createdNames.categories.push(catName);
            }

            const existingMod = db.prepare('SELECT id FROM equipment_models WHERE category_id = ? AND lower(name) = lower(?)').get(catId, modName) as { id: number } | undefined;
            let modId: number;
            if (existingMod) {
              modId = existingMod.id;
            } else {
              const inf = db.prepare('INSERT INTO equipment_models (category_id, name) VALUES (?, ?)').run(catId, modName);
              modId = Number(inf.lastInsertRowid);
              totals.models_created += 1;
            }

            const foundEq = db.prepare('SELECT id FROM equipment WHERE serial_number = ?').get(serial) as { id: number } | undefined;
            const validPoint = pointId && db.prepare('SELECT id FROM points WHERE id = ?').get(pointId) ? pointId : null;
            const place = validPoint ? 'point' : 'stock';

            if (foundEq) {
              existing += 1;
              totals.existing += 1;
              if (mode === 'overwrite') {
                db.prepare('UPDATE equipment SET model_id=?, place=?, point_id=?, notes=?, updated_at=? WHERE id=?').run(
                  modId,
                  place,
                  validPoint,
                  notes || null,
                  now,
                  foundEq.id,
                );
                updated += 1;
                totals.updated += 1;
              }
            } else {
              db.prepare(
                'INSERT INTO equipment (model_id, serial_number, place, status_id, point_id, received_date, notes, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              ).run(modId, serial, place, okId, validPoint, now.slice(0, 10), notes || null, now, now);
              created += 1;
              totals.created += 1;
              if (place === 'point') totals.placed_point += 1;
              else totals.placed_stock += 1;
            }
          }

          sheetReports.push({
            file: file.originalname,
            sheet: ws.name,
            records,
            created,
            updated,
            existing,
            skipped,
          });
        }
      }

      if (dryRun) {
        db.exec('ROLLBACK');
      } else {
        db.exec('COMMIT');
        bumpStateRev();
      }
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // ignore
      }
      res.status(400).json({ detail: (err as Error).message });
      return;
    }

    res.json({
      ok: true,
      added: totals.created,
      dry_run: dryRun,
      mode,
      totals,
      sheets: sheetReports,
      created_names: createdNames,
      conflict_samples: [],
      unmatched_points: {},
      unmatched_people: {},
      warnings: [],
    });
  });

  router.post('/api/equipment/import/sklad', upload.single('file'), (req: AuthedRequest, res) => {
    if (!req.file || !req.file.buffer?.length) {
      res.status(400).json({ detail: 'Выберите файл warehouse.db' });
      return;
    }
    const mode = String(req.body?.mode || 'merge').trim();
    if (mode !== 'merge' && mode !== 'overwrite') {
      res.status(400).json({ detail: 'Неизвестный режим импорта' });
      return;
    }
    const dryRun = String(req.body?.dry_run ?? 'true').toLowerCase() !== 'false';
    const importHistory = String(req.body?.import_history ?? 'true').toLowerCase() !== 'false';

    let raw = req.file.buffer;
    if (raw.length >= 2 && raw[0] === 0x1f && raw[1] === 0x8b) {
      try {
        raw = zlib.gunzipSync(raw);
      } catch {
        res.status(400).json({ detail: 'Не удалось распаковать файл (.gz)' });
        return;
      }
    }
    if (!raw.subarray(0, 16).toString('utf-8').startsWith('SQLite format 3')) {
      res.status(400).json({ detail: 'Это не файл базы SQLite. Нужен warehouse.db из приложения «Склад».' });
      return;
    }

    const tmpFile = path.join(os.tmpdir(), `sklad-${Date.now()}-${Math.random().toString(16).slice(2)}.db`);
    let srcDb: DatabaseSync | null = null;
    const db = getDb();
    try {
      fs.writeFileSync(tmpFile, raw);
      srcDb = new DatabaseSync(tmpFile, { readOnly: true });
      const tableNames = new Set(
        (srcDb.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
          (r) => r.name,
        ),
      );
      if (!tableNames.has('equipment') && !tableNames.has('complexes')) {
        res.status(400).json({ detail: 'В файле нет таблиц «Склада» (equipment / complexes) — это не его база.' });
        return;
      }

      const readTable = (tbl: string): Array<Record<string, unknown>> => {
        if (!tableNames.has(tbl)) return [];
        try {
          return srcDb!.prepare(`SELECT * FROM "${tbl}"`).all() as Array<Record<string, unknown>>;
        } catch {
          return [];
        }
      };

      const src = {
        categories: readTable('categories'),
        models: readTable('models'),
        installers: readTable('installers'),
        complex_categories: readTable('complex_categories'),
        complex_statuses: readTable('complex_statuses'),
        complexes: readTable('complexes'),
        solar_panels: readTable('solar_panels'),
        equipment: readTable('equipment'),
        history: readTable('history'),
      };

      const s = (v: unknown): string => (v == null ? '' : String(v).trim());
      const report = {
        dry_run: dryRun,
        mode,
        source: Object.fromEntries(Object.entries(src).map(([k, v]) => [k, v.length])),
        equipment_categories: { created: 0, existing: 0 },
        models: { created: 0, existing: 0 },
        people: { created: 0, matched: 0, created_names: [] as string[] },
        point_categories: { created: 0, existing: 0 },
        points: { created: 0, matched: 0, filled: 0, created_names: [] as string[] },
        panels: { created: 0, existing: 0, linked: 0 },
        equipment: {
          created: 0,
          existing: 0,
          updated: 0,
          filled: 0,
          conflicts: [] as Array<Record<string, unknown>>,
          conflict_count: 0,
        },
        history: { added: 0, duplicates: 0 },
        warnings: [] as string[],
      };

      const now = nowIso();
      const overwrite = mode === 'overwrite';

      db.exec('BEGIN IMMEDIATE');
      try {
        const okId = (
          db.prepare("SELECT id FROM equipment_statuses WHERE role = 'ok' LIMIT 1").get() as { id: number } | undefined
        )?.id ?? null;

        // 1. Equipment categories
        const catMap = new Map<unknown, number>();
        for (const c of src.categories) {
          const name = s(c.name);
          if (!name) continue;
          const existing = db.prepare('SELECT id FROM equipment_categories WHERE lower(name) = lower(?)').get(name) as
            | { id: number }
            | undefined;
          if (existing) {
            catMap.set(c.id, existing.id);
            report.equipment_categories.existing += 1;
          } else {
            const info = db.prepare("INSERT INTO equipment_categories (name, kind) VALUES (?, '')").run(name);
            catMap.set(c.id, Number(info.lastInsertRowid));
            report.equipment_categories.created += 1;
          }
        }

        // 2. Models
        const modelMap = new Map<unknown, number>();
        for (const m of src.models) {
          const name = s(m.name);
          const cid = catMap.get(m.category_id);
          if (!name || !cid) continue;
          const existing = db
            .prepare('SELECT id FROM equipment_models WHERE category_id = ? AND lower(name) = lower(?)')
            .get(cid, name) as { id: number } | undefined;
          if (existing) {
            modelMap.set(m.id, existing.id);
            report.models.existing += 1;
          } else {
            const info = db.prepare('INSERT INTO equipment_models (category_id, name) VALUES (?, ?)').run(cid, name);
            modelMap.set(m.id, Number(info.lastInsertRowid));
            report.models.created += 1;
          }
        }

        // 3. People (installers -> fitters)
        const personMap = new Map<unknown, number>();
        const existingPeople = db.prepare('SELECT id, full_name FROM people').all() as Array<{
          id: number;
          full_name: string;
        }>;
        const peopleByName = new Map(existingPeople.map((p) => [decryptField(p.full_name).trim().toLowerCase(), p.id]));
        for (const i of src.installers) {
          const name = s(i.full_name);
          if (!name) continue;
          const matchedId = peopleByName.get(name.toLowerCase());
          if (matchedId) {
            personMap.set(i.id, matchedId);
            report.people.matched += 1;
          } else {
            const info = db
              .prepare(
                "INSERT INTO people (full_name, phone, role_type, active, notes, created_at) VALUES (?, ?, 'fitter', ?, ?, ?)",
              )
              .run(
                encryptField(name),
                s(i.phone) ? encryptField(s(i.phone)) : '',
                i.active === 0 ? 0 : 1,
                'Добавлен при импорте из «Склада»',
                now,
              );
            const newPid = Number(info.lastInsertRowid);
            personMap.set(i.id, newPid);
            peopleByName.set(name.toLowerCase(), newPid);
            report.people.created += 1;
            if (report.people.created_names.length < 30) report.people.created_names.push(name);
          }
        }

        // 4. Point categories & complexes -> points
        const ccById = new Map(src.complex_categories.map((c) => [c.id, c]));
        const csById = new Map(src.complex_statuses.map((st) => [st.id, st]));
        const pcCache = new Map<unknown, number | null>();
        const pointMap = new Map<unknown, string>();

        for (const cx of src.complexes) {
          const name = s(cx.name);
          const inv = s(cx.inventory_number);
          if (!name && !inv) continue;

          let pointId: string | null = null;
          if (inv) {
            const byInv = db
              .prepare('SELECT id FROM points WHERE lower(trim(inventory_number)) = lower(?) LIMIT 1')
              .get(inv) as { id: string } | undefined;
            if (byInv) pointId = byInv.id;
          }
          if (!pointId && name) {
            const byId = db.prepare('SELECT id, inventory_number FROM points WHERE lower(id) = lower(?)').get(name) as
              | { id: string; inventory_number: string }
              | undefined;
            if (byId && (!s(byId.inventory_number) || !inv || s(byId.inventory_number).toLowerCase() === inv.toLowerCase())) {
              pointId = byId.id;
            }
          }

          let categoryId: number | null = null;
          const cat = ccById.get(cx.category_id);
          if (cat && s(cat.name)) {
            if (pcCache.has(cat.id)) {
              categoryId = pcCache.get(cat.id) ?? null;
            } else {
              const existingPc = db
                .prepare('SELECT id FROM point_categories WHERE lower(name) = lower(?)')
                .get(s(cat.name)) as { id: number } | undefined;
              if (existingPc) {
                categoryId = existingPc.id;
                report.point_categories.existing += 1;
              } else {
                const info = db
                  .prepare('INSERT INTO point_categories (name, color) VALUES (?, ?)')
                  .run(s(cat.name), s(cat.color) || '#6366f1');
                categoryId = Number(info.lastInsertRowid);
                report.point_categories.created += 1;
              }
              pcCache.set(cat.id, categoryId);
            }
          }

          if (pointId) {
            report.points.matched += 1;
            let filled = 0;
            for (const [col, val] of [
              ['address', s(cx.location)],
              ['notes', s(cx.notes)],
              ['inventory_number', inv],
            ] as const) {
              if (val) {
                const inf = db
                  .prepare(`UPDATE points SET ${col} = ? WHERE id = ? AND coalesce(${col}, '') = ''`)
                  .run(val, pointId);
                filled += Number(inf.changes || 0);
              }
            }
            if (categoryId) {
              const inf = db
                .prepare('UPDATE points SET category_id = ? WHERE id = ? AND category_id IS NULL')
                .run(categoryId, pointId);
              filled += Number(inf.changes || 0);
            }
            if (filled > 0) report.points.filled += 1;
            pointMap.set(cx.id, pointId);
          } else {
            const newId = name || inv;
            const stRow = csById.get(cx.status_id);
            const stName = s(stRow?.name) || 'На складе';
            db.prepare(
              `INSERT OR IGNORE INTO points (id, address, notes, inventory_number, status, category_id)
               VALUES (?, ?, ?, ?, ?, ?)`,
            ).run(newId, s(cx.location), s(cx.notes), inv, stName, categoryId);
            pointMap.set(cx.id, newId);
            report.points.created += 1;
            if (report.points.created_names.length < 30) report.points.created_names.push(newId);
          }
        }

        // 5. Solar panels
        for (const sp of src.solar_panels) {
          const panelNumber = s(sp.panel_number || sp.number || sp.name);
          if (!panelNumber) continue;
          const mappedPoint = sp.complex_id != null ? pointMap.get(sp.complex_id) ?? null : null;
          const existing = db.prepare('SELECT id FROM solar_panels WHERE lower(panel_number) = lower(?)').get(panelNumber) as
            | { id: number }
            | undefined;
          if (existing) {
            report.panels.existing += 1;
            if (mappedPoint && overwrite) {
              db.prepare('UPDATE solar_panels SET point_id = ?, updated_at = ? WHERE id = ?').run(mappedPoint, now, existing.id);
              report.panels.linked += 1;
            }
          } else {
            db.prepare(
              'INSERT INTO solar_panels (panel_number, point_id, location, notes, at_warehouse, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
            ).run(panelNumber, mappedPoint, s(sp.location), s(sp.notes), sp.at_warehouse ? 1 : 0, now, now);
            report.panels.created += 1;
            if (mappedPoint) report.panels.linked += 1;
          }
        }

        // 6. Equipment items
        for (const eqRow of src.equipment) {
          const serial = s(eqRow.serial_number);
          const modelId = modelMap.get(eqRow.model_id);
          if (!serial || !modelId) continue;
          const mappedPoint = eqRow.complex_id != null ? pointMap.get(eqRow.complex_id) ?? null : null;
          const mappedPerson = eqRow.installer_id != null ? personMap.get(eqRow.installer_id) ?? null : null;
          const place = mappedPoint ? 'point' : mappedPerson ? 'person' : s(eqRow.place) || 'stock';
          const existing = db.prepare('SELECT id, place, point_id, person_id, notes FROM equipment WHERE lower(serial_number) = lower(?)').get(serial) as
            | { id: number; place: string; point_id: string | null; person_id: number | null; notes: string | null }
            | undefined;
          if (existing) {
            report.equipment.existing += 1;
            if (overwrite) {
              db.prepare(
                'UPDATE equipment SET model_id = ?, place = ?, point_id = ?, person_id = ?, notes = ?, updated_at = ? WHERE id = ?',
              ).run(modelId, place, mappedPoint, mappedPerson, s(eqRow.notes) || existing.notes, now, existing.id);
              report.equipment.updated += 1;
            }
          } else {
            db.prepare(
              `INSERT INTO equipment (model_id, serial_number, place, status_id, point_id, person_id, received_date, installed_date, notes, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            ).run(
              modelId,
              serial,
              place,
              okId,
              mappedPoint,
              mappedPerson,
              s(eqRow.received_date) || now.slice(0, 10),
              s(eqRow.installed_date) || null,
              s(eqRow.notes) || null,
              now,
              now,
            );
            report.equipment.created += 1;
          }
        }

        // 7. History
        if (importHistory) {
          for (const h of src.history) {
            const serial = s(h.serial_number);
            const action = s(h.action_type || h.action || 'import');
            const ts = s(h.ts || h.created_at) || now;
            const dup = serial
              ? db.prepare('SELECT id FROM equipment_history WHERE serial_number = ? AND ts = ? AND action_type = ? LIMIT 1').get(serial, ts, action)
              : null;
            if (dup) {
              report.history.duplicates += 1;
            } else {
              db.prepare(
                'INSERT INTO equipment_history (ts, serial_number, model_name, action_type, person_name, point_id, performed_by, comment, event_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
              ).run(
                ts,
                serial || null,
                s(h.model_name) || null,
                action,
                s(h.person_name) || null,
                s(h.point_id) || null,
                req.sessionUser?.username || 'sklad_import',
                s(h.comment) || null,
                s(h.event_date) || ts.slice(0, 10),
              );
              report.history.added += 1;
            }
          }
        }

        if (dryRun) {
          db.exec('ROLLBACK');
        } else {
          db.exec('COMMIT');
          bumpStateRev();
        }
      } catch (innerErr) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // ignore
        }
        throw innerErr;
      }

      res.json(report);
    } catch (err) {
      res.status(400).json({ detail: `Не удалось прочитать файл «Склада»: ${(err as Error).message}` });
    } finally {
      try {
        srcDb?.close();
      } catch {
        // ignore
      }
      try {
        if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
      } catch {
        // ignore
      }
    }
  });

  // ---- WAREHOUSE (/api/warehouse/*) ----
  router.get('/api/warehouse/points', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const catIds = ([] as string[]).concat((req.query.category_id as string | string[]) || []).map(Number).filter(Number.isFinite);
    const uncategorized = req.query.uncategorized === 'true';
    const db = getDb();
    let rows = db
      .prepare(
        `SELECT p.id, p.address, p.description, p.inventory_number, p.status, p.category_id, pc.name as category_name, pc.color as category_color,
                w.box_state, w.camera_state, w.board_state, w.web_status, w.received_at, w.info, w.updated_at
         FROM points p
         LEFT JOIN point_categories pc ON pc.id = p.category_id
         LEFT JOIN warehouse_items w ON w.point_id = p.id
         WHERE p.status = 'На складе' OR w.point_id IS NOT NULL
         ORDER BY p.id`,
      )
      .all() as Array<Record<string, unknown>>;
    if (search) {
      rows = rows.filter((r) => [r.id, r.address, r.description, r.inventory_number, r.info].some((v) => String(v || '').toLowerCase().includes(search)));
    }
    if (uncategorized) rows = rows.filter((r) => !r.category_id);
    else if (catIds.length) {
      const s = new Set(catIds);
      rows = rows.filter((r) => r.category_id && s.has(Number(r.category_id)));
    }
    res.json(
      rows.map((r) => {
        const comps = (
          db
            .prepare('SELECT id, name, in_stock, description FROM point_components WHERE point_id = ? ORDER BY sort_order, id')
            .all(String(r.id)) as Array<Record<string, unknown>>
        ).map((c) => ({ ...c, in_stock: Boolean(c.in_stock) }));
        const inStock = comps.filter((c) => c.in_stock).length;
        return {
          ...r,
          inventory_number: r.inventory_number || '',
          category_name: r.category_name || '',
          category_color: r.category_color || '',
          components: comps,
          components_in_stock: inStock,
          components_total: comps.length,
        };
      }),
    );
  });

  router.get('/api/warehouse/component-names', (_req, res) => {
    const used = (getDb().prepare('SELECT DISTINCT name FROM point_components ORDER BY name').all() as Array<{ name: string }>).map((r) => r.name);
    res.json(Array.from(new Set([...SUGGESTED_COMPONENTS, ...used])));
  });

  router.get('/api/warehouse/points/:pointId', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const point = db
      .prepare(
        `SELECT p.*, pc.name as category_name, pc.color as category_color
         FROM points p
         LEFT JOIN point_categories pc ON pc.id = p.category_id
         WHERE p.id = ?`,
      )
      .get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const wi = db.prepare('SELECT * FROM warehouse_items WHERE point_id = ?').get(pointId) as Record<string, unknown> | undefined;
    const components = (
      db
        .prepare('SELECT id, name, in_stock, description FROM point_components WHERE point_id = ? ORDER BY sort_order, id')
        .all(pointId) as Array<Record<string, unknown>>
    ).map((c) => ({ ...c, in_stock: Boolean(c.in_stock) }));
    res.json({
      id: pointId,
      point_id: pointId,
      address: point.address || '',
      description: point.description || '',
      inventory_number: point.inventory_number || '',
      status: point.status || '',
      category_id: point.category_id ?? null,
      category_name: point.category_name || '',
      category_color: point.category_color || '',
      box_state: wi?.box_state ?? null,
      camera_state: wi?.camera_state ?? null,
      board_state: wi?.board_state ?? null,
      web_status: wi?.web_status ?? null,
      received_at: wi?.received_at ?? null,
      info: wi?.info ?? null,
      components,
      components_in_stock: components.filter((c) => c.in_stock).length,
      components_total: components.length,
    });
  });

  router.put('/api/warehouse/points/:pointId', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    if (!db.prepare('SELECT id FROM points WHERE id = ?').get(pointId)) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const b = req.body || {};
    if (Array.isArray(b.components)) {
      db.prepare('DELETE FROM point_components WHERE point_id = ?').run(pointId);
      const ins = db.prepare('INSERT INTO point_components (point_id, name, in_stock, description, sort_order) VALUES (?, ?, ?, ?, ?)');
      let stocked = 0;
      let total = 0;
      b.components.forEach((c: Record<string, unknown>, idx: number) => {
        if (String(c.name || '').trim()) {
          const inStock = Boolean(c.in_stock);
          ins.run(pointId, String(c.name).trim(), inStock ? 1 : 0, String(c.description || ''), idx + 1);
          total += 1;
          if (inStock) stocked += 1;
        }
      });
      if (total > 0 && stocked > 0) {
        db.prepare("UPDATE points SET status = 'На складе' WHERE id = ?").run(pointId);
      }
    }
    db.prepare(
      `INSERT INTO warehouse_items (point_id, box_state, camera_state, board_state, web_status, received_at, info, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(point_id) DO UPDATE SET
         box_state=coalesce(excluded.box_state, warehouse_items.box_state),
         camera_state=coalesce(excluded.camera_state, warehouse_items.camera_state),
         board_state=coalesce(excluded.board_state, warehouse_items.board_state),
         web_status=coalesce(excluded.web_status, warehouse_items.web_status),
         received_at=coalesce(excluded.received_at, warehouse_items.received_at),
         info=coalesce(excluded.info, warehouse_items.info),
         updated_at=excluded.updated_at`,
    ).run(pointId, b.box_state ?? null, b.camera_state ?? null, b.board_state ?? null, b.web_status ?? null, b.received_at ?? null, b.info ?? null, nowIso());
    res.json({ ok: true, point_id: pointId });
  });

  router.get('/api/warehouse/template', async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Склад');
    ws.addRow(['Номер комплекса', 'Ящик', 'Камера', 'Плата', 'Примечание']);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="warehouse-template.xlsx"');
    res.send(Buffer.from(buf));
  });

  router.post('/api/warehouse/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    let updated = 0;
    const db = getDb();
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const pid = String(row.getCell(1).value || '').trim();
      if (!pid || !db.prepare('SELECT id FROM points WHERE id = ?').get(pid)) return;
      db.prepare(
        `INSERT INTO warehouse_items (point_id, box_state, camera_state, board_state, info, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(point_id) DO UPDATE SET box_state=excluded.box_state, camera_state=excluded.camera_state, board_state=excluded.board_state, info=excluded.info, updated_at=excluded.updated_at`,
      ).run(
        pid,
        String(row.getCell(2).value || ''),
        String(row.getCell(3).value || ''),
        String(row.getCell(4).value || ''),
        String(row.getCell(5).value || ''),
        nowIso(),
      );
      updated += 1;
    });
    res.json({ ok: true, updated });
  });

  // ---- SOLAR PANELS ----
  router.get('/api/solar-panels', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const linked = String(req.query.linked || '').trim();
    const atWh = req.query.at_warehouse === 'true';
    let rows: Array<Record<string, unknown>> = (getDb().prepare('SELECT * FROM solar_panels ORDER BY id DESC').all() as Array<Record<string, unknown>>).map((r) => ({
      ...r,
      at_warehouse: Boolean(r.at_warehouse),
    }));
    if (linked === 'yes') rows = rows.filter((r) => Boolean(r.point_id));
    else if (linked === 'no') rows = rows.filter((r) => !r.point_id);
    if (atWh) rows = rows.filter((r) => r.at_warehouse);
    if (search) {
      rows = rows.filter((r) =>
        [r.panel_number, r.point_id, r.location, r.notes].some((v) => String(v || '').toLowerCase().includes(search)),
      );
    }
    res.json(rows);
  });

  router.get('/api/solar-panels/export.xlsx', async (_req, res) => {
    const rows = (getDb().prepare('SELECT * FROM solar_panels ORDER BY id').all() as Array<Record<string, unknown>>).map((r) => [
      r.panel_number,
      r.point_id || '',
      r.location || '',
      r.at_warehouse ? 'На складе' : 'На объекте',
      r.notes || '',
    ]);
    await sendEquipmentExcel(res, 'СЭС панели', ['Номер панели', 'Комплекс', 'Расположение', 'Где', 'Примечание'], rows, 'solar-panels.xlsx');
  });

  router.get('/api/solar-panels/:panelId', (req, res) => {
    const row = getDb().prepare('SELECT * FROM solar_panels WHERE id = ?').get(Number(req.params.panelId)) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Панель не найдена' });
      return;
    }
    res.json({ ...row, at_warehouse: Boolean(row.at_warehouse) });
  });

  router.post('/api/solar-panels', (req, res) => {
    const b = req.body || {};
    const num = String(b.panel_number || '').trim();
    if (!num) {
      res.status(400).json({ detail: 'Укажите номер панели' });
      return;
    }
    const now = nowIso();
    try {
      const info = getDb()
        .prepare('INSERT INTO solar_panels (panel_number, point_id, location, notes, at_warehouse, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(num, b.point_id || null, b.location || null, b.notes || null, b.at_warehouse ? 1 : 0, now, now);
      const created = getDb().prepare('SELECT * FROM solar_panels WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      res.status(201).json({ ...created, at_warehouse: Boolean(created.at_warehouse) });
    } catch {
      res.status(409).json({ detail: 'Панель с таким номером уже существует' });
    }
  });

  router.put('/api/solar-panels/:panelId', (req, res) => {
    const id = Number(req.params.panelId);
    const b = req.body || {};
    const db = getDb();
    const existing = db.prepare('SELECT * FROM solar_panels WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Панель не найдена' });
      return;
    }
    db.prepare('UPDATE solar_panels SET panel_number=?, point_id=?, location=?, notes=?, at_warehouse=?, updated_at=? WHERE id=?').run(
      String(b.panel_number ?? existing.panel_number ?? '').trim(),
      b.point_id !== undefined ? (b.point_id != null ? String(b.point_id) : null) : existing.point_id != null ? String(existing.point_id) : null,
      b.location !== undefined ? (b.location != null ? String(b.location) : null) : existing.location != null ? String(existing.location) : null,
      b.notes !== undefined ? (b.notes != null ? String(b.notes) : null) : existing.notes != null ? String(existing.notes) : null,
      b.at_warehouse !== undefined ? (b.at_warehouse ? 1 : 0) : Number(existing.at_warehouse ?? 0),
      nowIso(),
      id,
    );
    const updated = db.prepare('SELECT * FROM solar_panels WHERE id = ?').get(id) as Record<string, unknown>;
    res.json({ ...updated, at_warehouse: Boolean(updated.at_warehouse) });
  });

  router.delete('/api/solar-panels/:panelId', (req, res) => {
    getDb().prepare('DELETE FROM solar_panels WHERE id = ?').run(Number(req.params.panelId));
    res.json({ ok: true });
  });

  return router;
}
