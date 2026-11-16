import { Router } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { requirePasswordOk, requirePerm, type AuthedRequest } from '../auth.ts';
import { decryptField } from '../crypto.ts';
import { getDb, nowIso } from '../db.ts';
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

  return {
    id: r.id,
    model_id: r.model_id,
    model_name: r.model_name || '',
    category_id: r.category_id ?? null,
    category_name: r.category_name || '',
    category_kind: r.category_kind || '',
    serial_number: r.serial_number,
    place: r.place,
    status_id: r.status_id ?? null,
    status_name: r.status_name || '',
    status_color: r.status_color || '#64748b',
    status_usable: Boolean(r.status_usable),
    point_id: r.point_id ?? null,
    person_id: r.person_id ?? null,
    person_name: r.person_full_name ? decryptField(String(r.person_full_name)) : null,
    held_reason: r.held_reason ?? null,
    received_date: r.received_date ?? null,
    issued_date: r.issued_date ?? null,
    installed_date: r.installed_date ?? null,
    installed_by: r.installed_by ?? null,
    removed_date: r.removed_date ?? null,
    removed_by: r.removed_by ?? null,
    removed_point_id: r.removed_point_id ?? null,
    accepted_date: r.accepted_date ?? null,
    accepted_by: r.accepted_by ?? null,
    notes: r.notes ?? '',
    removal_reason: r.removal_reason ?? null,
    created_at: r.created_at,
    updated_at: r.updated_at,
    fields,
  };
}

function queryEquipmentBase(whereClause = '', params: Array<string | number> = []) {
  return getDb()
    .prepare(
      `SELECT e.*, m.name as model_name, m.category_id, c.name as category_name, c.kind as category_kind,
              s.name as status_name, s.color as status_color, s.usable as status_usable,
              p.full_name as person_full_name
       FROM equipment e
       LEFT JOIN equipment_models m ON m.id = e.model_id
       LEFT JOIN equipment_categories c ON c.id = m.category_id
       LEFT JOIN equipment_statuses s ON s.id = e.status_id
       LEFT JOIN people p ON p.id = e.person_id
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
    const categories = db
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM equipment_models m WHERE m.category_id = c.id) as model_count,
                (SELECT COUNT(*) FROM equipment e JOIN equipment_models m ON m.id = e.model_id WHERE m.category_id = c.id) as equipment_count
         FROM equipment_categories c ORDER BY c.id`,
      )
      .all();
    const models = db
      .prepare(
        `SELECT m.*, c.name as category_name,
                (SELECT COUNT(*) FROM equipment e WHERE e.model_id = m.id) as equipment_count
         FROM equipment_models m JOIN equipment_categories c ON c.id = m.category_id ORDER BY c.name, m.name`,
      )
      .all();
    const statuses = db
      .prepare('SELECT * FROM equipment_statuses ORDER BY sort_order, id')
      .all()
      .map((s: Record<string, unknown>) => ({ ...s, usable: Boolean(s.usable), protected: Boolean(s.protected) }));
    const fields = db.prepare('SELECT * FROM equipment_fields ORDER BY sort_order, id').all();
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
    const rows = getDb()
      .prepare(
        `SELECT c.*,
                (SELECT COUNT(*) FROM equipment_models m WHERE m.category_id = c.id) as model_count,
                (SELECT COUNT(*) FROM equipment e JOIN equipment_models m ON m.id = e.model_id WHERE m.category_id = c.id) as equipment_count
         FROM equipment_categories c ORDER BY c.id`,
      )
      .all();
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
    res.json({ duplicates: [] });
  });

  router.get('/api/equipment/fields', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM equipment_fields ORDER BY sort_order, id').all());
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
    getDb().prepare('DELETE FROM equipment_fields WHERE id = ?').run(Number(req.params.fieldId));
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
    const statusId = req.query.status_id ? Number(req.query.status_id) : null;
    const personId = req.query.person_id ? Number(req.query.person_id) : null;
    const pointId = String(req.query.point_id || '').trim();

    let rows = queryEquipmentBase().map(hydrateEquipmentRow);
    if (place) rows = rows.filter((r) => r.place === place);
    if (categoryId) rows = rows.filter((r) => Number(r.category_id) === categoryId);
    if (statusId) rows = rows.filter((r) => Number(r.status_id) === statusId);
    if (personId) rows = rows.filter((r) => Number(r.person_id) === personId);
    if (pointId) rows = rows.filter((r) => r.point_id === pointId);
    if (search) {
      rows = rows.filter((r) =>
        [r.serial_number, r.model_name, r.category_name, r.point_id, r.person_name, r.notes]
          .some((v) => String(v || '').toLowerCase().includes(search)),
      );
    }
    res.json({ items: rows, total: rows.length });
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
    const skipped: string[] = [];

    for (const sn of serials) {
      if (db.prepare('SELECT id FROM equipment WHERE serial_number = ?').get(sn)) {
        skipped.push(sn);
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
      });
    }
    res.status(201).json({ created: createdIds.length, skipped, ids: createdIds });
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
      b.notes !== undefined ? String(b.notes) : existing.notes != null ? String(existing.notes) : null,
      nowIso(),
      id,
    );
    if (b.fields && typeof b.fields === 'object') {
      const upsert = db.prepare(
        'INSERT INTO equipment_field_values (equipment_id, field_id, value) VALUES (?, ?, ?) ON CONFLICT(equipment_id, field_id) DO UPDATE SET value = excluded.value',
      );
      for (const [fid, val] of Object.entries(b.fields)) {
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
    for (const id of ids) upd.run(statusId, nowIso(), id);
    res.json({ ok: true, updated: ids.length });
  });

  router.post('/api/equipment/items/bulk-delete', (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number) : [];
    const db = getDb();
    const del = db.prepare('DELETE FROM equipment WHERE id = ?');
    for (const id of ids) del.run(id);
    res.json({ ok: true, deleted: ids.length });
  });

  router.delete('/api/equipment/items/:itemId', (req, res) => {
    getDb().prepare('DELETE FROM equipment WHERE id = ?').run(Number(req.params.itemId));
    res.json({ ok: true });
  });

  router.post('/api/equipment/items/:itemId/note', (req: AuthedRequest, res) => {
    const id = Number(req.params.itemId);
    const note = String(req.body?.note || '').trim();
    getDb().prepare('UPDATE equipment SET notes=?, updated_at=? WHERE id=?').run(note, nowIso(), id);
    logEquipmentHistory({
      equipment_id: id,
      action_type: 'Запись',
      performed_by: req.sessionUser?.username || '',
      comment: note,
    });
    res.json({ ok: true });
  });

  router.post('/api/equipment/issue', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number) : b.equipment_id ? [Number(b.equipment_id)] : [];
    const personId = Number(b.person_id);
    const db = getDb();
    const person = db.prepare('SELECT full_name FROM people WHERE id = ?').get(personId) as { full_name: string } | undefined;
    if (!person) {
      res.status(404).json({ detail: 'Сотрудник не найден' });
      return;
    }
    const personName = decryptField(person.full_name);
    const now = nowIso();
    const upd = db.prepare(
      "UPDATE equipment SET place='person', person_id=?, point_id=NULL, held_reason='issued', issued_date=?, updated_at=? WHERE id=?",
    );
    for (const id of ids) {
      upd.run(personId, now.slice(0, 10), now, id);
      logEquipmentHistory({
        equipment_id: id,
        action_type: 'Выдача монтёру',
        person_id: personId,
        person_name: personName,
        performed_by: req.sessionUser?.username || '',
      });
    }
    res.json({ ok: true, issued: ids.length });
  });

  router.post('/api/equipment/accept', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const ids: number[] = Array.isArray(b.ids) ? b.ids.map(Number) : b.equipment_id ? [Number(b.equipment_id)] : [];
    const db = getDb();
    const statusId = b.status_id ? Number(b.status_id) : getStatusByRole('ok');
    const now = nowIso();
    const upd = db.prepare(
      "UPDATE equipment SET place='stock', person_id=NULL, point_id=NULL, held_reason=NULL, status_id=?, accepted_date=?, accepted_by=?, updated_at=? WHERE id=?",
    );
    for (const id of ids) {
      upd.run(statusId, now.slice(0, 10), req.sessionUser?.username || '', now, id);
      logEquipmentHistory({
        equipment_id: id,
        action_type: 'Приём от монтёра',
        performed_by: req.sessionUser?.username || '',
      });
    }
    res.json({ ok: true, accepted: ids.length });
  });

  router.post('/api/equipment/accept-substitute', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const id = Number(b.equipment_id);
    const db = getDb();
    const now = nowIso();
    db.prepare(
      "UPDATE equipment SET place='stock', person_id=NULL, point_id=NULL, held_reason=NULL, accepted_date=?, accepted_by=?, updated_at=? WHERE id=?",
    ).run(now.slice(0, 10), req.sessionUser?.username || '', now, id);
    res.json({ ok: true });
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

  router.get('/api/equipment/people-summary', (_req, res) => {
    const db = getDb();
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
    res.json(
      people.map((p) => ({
        id: p.id,
        full_name: decryptField(p.full_name),
        role_type: p.role_type,
        items: byPerson.get(p.id) || [],
        count: (byPerson.get(p.id) || []).length,
      })),
    );
  });

  router.get('/api/equipment/awaiting', (_req, res) => {
    const rows = queryEquipmentBase("WHERE e.place = 'person' AND e.held_reason IN ('removed', 'kept')").map(
      hydrateEquipmentRow,
    );
    res.json(rows);
  });

  router.get('/api/equipment/points', (req: AuthedRequest, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const db = getDb();
    const perms = req.sessionUser!.permissions;
    let pts = db.prepare('SELECT id, address, description, status, sim_number, ip_address FROM points ORDER BY id').all() as Array<
      Record<string, unknown>
    >;
    if (search) {
      pts = pts.filter((p) =>
        [p.id, p.address, p.description, p.sim_number].some((v) => String(v || '').toLowerCase().includes(search)),
      );
    }
    const counts = db
      .prepare("SELECT point_id, COUNT(*) as cnt FROM equipment WHERE place = 'point' GROUP BY point_id")
      .all() as Array<{ point_id: string; cnt: number }>;
    const cntMap = new Map(counts.map((c) => [c.point_id, c.cnt]));
    res.json(
      pts.slice(0, 500).map((p) => ({
        ...p,
        ip_address: networkOk(perms) ? p.ip_address : '',
        equipment_count: cntMap.get(String(p.id)) || 0,
      })),
    );
  });

  router.get('/api/equipment/points/:pointId', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Комплекс не найден' });
      return;
    }
    const perms = req.sessionUser!.permissions;
    const items = queryEquipmentBase("WHERE e.place = 'point' AND e.point_id = ?", [pointId]).map(hydrateEquipmentRow);
    const panels = db.prepare('SELECT * FROM solar_panels WHERE point_id = ?').all(pointId);
    const history = db
      .prepare('SELECT * FROM equipment_history WHERE point_id = ? ORDER BY id DESC LIMIT 100')
      .all(pointId);
    res.json({
      point: {
        ...point,
        login: secretsOk(perms) ? decryptField(String(point.login || '')) : '',
        password: secretsOk(perms) ? decryptField(String(point.password || '')) : '',
        ip_address: networkOk(perms) ? point.ip_address : '',
      },
      items,
      solar_panels: panels,
      history,
    });
  });

  router.post('/api/equipment/points/:pointId/attach', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const eqId = Number(req.body?.equipment_id);
    const now = nowIso();
    getDb()
      .prepare("UPDATE equipment SET place='point', point_id=?, person_id=NULL, held_reason=NULL, installed_date=?, installed_by=?, updated_at=? WHERE id=?")
      .run(pointId, now.slice(0, 10), req.sessionUser?.username || '', now, eqId);
    logEquipmentHistory({
      equipment_id: eqId,
      point_id: pointId,
      action_type: 'Установка на комплекс',
      performed_by: req.sessionUser?.username || '',
    });
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/replace', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const oldId = Number(req.body?.old_equipment_id);
    const newId = Number(req.body?.new_equipment_id);
    const defectId = getStatusByRole('defect');
    const now = nowIso();
    const db = getDb();
    if (oldId) {
      db.prepare("UPDATE equipment SET place='stock', point_id=NULL, status_id=?, removed_date=?, removed_point_id=?, updated_at=? WHERE id=?").run(
        defectId,
        now.slice(0, 10),
        pointId,
        now,
        oldId,
      );
      logEquipmentHistory({ equipment_id: oldId, point_id: pointId, action_type: 'Замена — снятие', performed_by: req.sessionUser?.username || '' });
    }
    if (newId) {
      db.prepare("UPDATE equipment SET place='point', point_id=?, person_id=NULL, held_reason=NULL, installed_date=?, updated_at=? WHERE id=?").run(
        pointId,
        now.slice(0, 10),
        now,
        newId,
      );
      logEquipmentHistory({ equipment_id: newId, point_id: pointId, action_type: 'Замена — установка', performed_by: req.sessionUser?.username || '' });
    }
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/detach/:equipmentId', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const eqId = Number(req.params.equipmentId);
    const now = nowIso();
    getDb()
      .prepare("UPDATE equipment SET place='stock', point_id=NULL, removed_date=?, removed_point_id=?, updated_at=? WHERE id=?")
      .run(now.slice(0, 10), pointId, now, eqId);
    logEquipmentHistory({ equipment_id: eqId, point_id: pointId, action_type: 'Снятие с комплекса', performed_by: req.sessionUser?.username || '' });
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/sim/replace', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    getDb().prepare('UPDATE points SET sim_number = ? WHERE id = ?').run(String(req.body?.sim_number || '').trim(), pointId);
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/sim/fix', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    getDb().prepare('UPDATE points SET sim_number = ? WHERE id = ?').run(String(req.body?.sim_number || '').trim(), pointId);
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/note', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    getDb().prepare('UPDATE points SET notes = ? WHERE id = ?').run(String(req.body?.notes || ''), pointId);
    res.json({ ok: true });
  });

  router.post('/api/equipment/points/:pointId/link-panel', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const panelId = Number(req.body?.panel_id);
    getDb().prepare('UPDATE solar_panels SET point_id = ?, at_warehouse = 0, updated_at = ? WHERE id = ?').run(
      pointId,
      nowIso(),
      panelId,
    );
    res.json({ ok: true });
  });

  // ---- HISTORY & REPORTS ----
  router.get('/api/equipment/history', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit || 200));
    const rows = getDb().prepare('SELECT * FROM equipment_history ORDER BY id DESC LIMIT ?').all(limit);
    res.json({ items: rows, total: rows.length });
  });

  router.put('/api/equipment/history/:entryId', (req, res) => {
    getDb()
      .prepare('UPDATE equipment_history SET comment = ? WHERE id = ?')
      .run(String(req.body?.comment || ''), Number(req.params.entryId));
    res.json({ ok: true });
  });

  router.delete('/api/equipment/history/:entryId', (req, res) => {
    getDb().prepare('DELETE FROM equipment_history WHERE id = ?').run(Number(req.params.entryId));
    res.json({ ok: true });
  });

  router.delete('/api/equipment/history', (_req, res) => {
    getDb().prepare('DELETE FROM equipment_history').run();
    res.json({ ok: true });
  });

  router.get('/api/equipment/reports/summary', (_req, res) => {
    const db = getDb();
    const byPlace = db.prepare('SELECT place, COUNT(*) as count FROM equipment GROUP BY place').all();
    const byStatus = db
      .prepare('SELECT coalesce(s.name, \'Без статуса\') as name, coalesce(s.color, \'#64748b\') as color, COUNT(*) as count FROM equipment e LEFT JOIN equipment_statuses s ON s.id = e.status_id GROUP BY e.status_id')
      .all();
    const byCategory = db
      .prepare('SELECT c.name, COUNT(*) as count FROM equipment e JOIN equipment_models m ON m.id = e.model_id JOIN equipment_categories c ON c.id = m.category_id GROUP BY c.id')
      .all();
    const total = (db.prepare('SELECT COUNT(*) as c FROM equipment').get() as { c: number }).c;
    res.json({ total, by_place: byPlace, by_status: byStatus, by_category: byCategory });
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

  router.post('/api/equipment/import/xlsx/analyze', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const preview: Array<Record<string, string>> = [];
    ws?.eachRow((row, idx) => {
      if (idx === 1 || preview.length >= 100) return;
      preview.push({
        serial_number: String(row.getCell(1).value || '').trim(),
        category: String(row.getCell(2).value || '').trim(),
        model: String(row.getCell(3).value || '').trim(),
      });
    });
    res.json({ total: Math.max(0, (ws?.rowCount || 1) - 1), preview });
  });

  router.post('/api/equipment/import/xlsx/run', upload.single('file'), async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const db = getDb();
    const okId = getStatusByRole('ok');
    let added = 0;
    const now = nowIso();
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const serial = String(row.getCell(1).value || '').trim();
      const catName = String(row.getCell(2).value || 'Прочее').trim();
      const modName = String(row.getCell(3).value || 'Без модели').trim();
      if (!serial || db.prepare('SELECT id FROM equipment WHERE serial_number = ?').get(serial)) return;
      db.prepare("INSERT OR IGNORE INTO equipment_categories (name, kind) VALUES (?, '')").run(catName);
      const cat = db.prepare('SELECT id FROM equipment_categories WHERE name = ?').get(catName) as { id: number };
      db.prepare('INSERT OR IGNORE INTO equipment_models (category_id, name) VALUES (?, ?)').run(cat.id, modName);
      const mod = db.prepare('SELECT id FROM equipment_models WHERE category_id = ? AND name = ?').get(cat.id, modName) as { id: number };
      db.prepare("INSERT INTO equipment (model_id, serial_number, place, status_id, received_date, created_at, updated_at) VALUES (?, ?, 'stock', ?, ?, ?, ?)").run(
        mod.id,
        serial,
        okId,
        now.slice(0, 10),
        now,
        now,
      );
      added += 1;
    });
    res.json({ ok: true, added });
  });

  router.post('/api/equipment/import/sklad', upload.single('file'), (_req, res) => {
    res.json({ ok: true, imported: 0 });
  });

  // ---- WAREHOUSE (/api/warehouse/*) ----
  router.get('/api/warehouse/points', (req, res) => {
    const search = String(req.query.search || '').trim().toLowerCase();
    const catIds = ([] as string[]).concat((req.query.category_id as string | string[]) || []).map(Number).filter(Number.isFinite);
    const uncategorized = req.query.uncategorized === 'true';
    const db = getDb();
    let rows = db
      .prepare(
        `SELECT p.id, p.address, p.description, p.status, p.category_id, pc.name as category_name, pc.color as category_color,
                w.box_state, w.camera_state, w.board_state, w.web_status, w.received_at, w.info, w.updated_at
         FROM points p
         LEFT JOIN point_categories pc ON pc.id = p.category_id
         LEFT JOIN warehouse_items w ON w.point_id = p.id
         WHERE p.status = 'На складе' OR w.point_id IS NOT NULL
         ORDER BY p.id`,
      )
      .all() as Array<Record<string, unknown>>;
    if (search) {
      rows = rows.filter((r) => [r.id, r.address, r.description, r.info].some((v) => String(v || '').toLowerCase().includes(search)));
    }
    if (uncategorized) rows = rows.filter((r) => !r.category_id);
    else if (catIds.length) {
      const s = new Set(catIds);
      rows = rows.filter((r) => r.category_id && s.has(Number(r.category_id)));
    }
    res.json(
      rows.map((r) => {
        const comps = db.prepare('SELECT id, name, in_stock, description FROM point_components WHERE point_id = ? ORDER BY sort_order, id').all(String(r.id));
        return { ...r, components: comps };
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
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const wi = db.prepare('SELECT * FROM warehouse_items WHERE point_id = ?').get(pointId) as Record<string, unknown> | undefined;
    const components = db
      .prepare('SELECT id, name, in_stock, description FROM point_components WHERE point_id = ? ORDER BY sort_order, id')
      .all(pointId)
      .map((c: Record<string, unknown>) => ({ ...c, in_stock: Boolean(c.in_stock) }));
    res.json({
      point_id: pointId,
      address: point.address || '',
      description: point.description || '',
      status: point.status || '',
      box_state: wi?.box_state ?? null,
      camera_state: wi?.camera_state ?? null,
      board_state: wi?.board_state ?? null,
      web_status: wi?.web_status ?? null,
      received_at: wi?.received_at ?? null,
      info: wi?.info ?? null,
      components,
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
      b.components.forEach((c: Record<string, unknown>, idx: number) => {
        if (String(c.name || '').trim()) {
          ins.run(pointId, String(c.name).trim(), c.in_stock ? 1 : 0, String(c.description || ''), idx + 1);
        }
      });
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
  router.get('/api/solar-panels', (_req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM solar_panels ORDER BY id DESC')
      .all()
      .map((r: Record<string, unknown>) => ({ ...r, at_warehouse: Boolean(r.at_warehouse) }));
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
