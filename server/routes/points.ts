import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import multer from 'multer';
import { requirePasswordOk, type AuthedRequest } from '../auth.ts';
import { POINT_FILES_DIR } from '../config.ts';
import { decryptField, encryptField } from '../crypto.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { networkOk, secretsOk } from '../permissions.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

function stripCredentials(point: Record<string, unknown>, perms: string[]): Record<string, unknown> {
  const out = { ...point };
  if (!secretsOk(perms)) {
    out.login = '';
    out.password = '';
  }
  if (!networkOk(perms)) {
    out.ip_address = '';
  }
  return out;
}

function hydratePoint(row: Record<string, unknown>, catMap: Map<number, { name: string; color: string; is_legacy: boolean }>) {
  const db = getDb();
  const catId = row.category_id ? Number(row.category_id) : null;
  const cat = catId ? catMap.get(catId) : undefined;
  const comps = db
    .prepare('SELECT name, in_stock FROM point_components WHERE point_id = ?')
    .all(String(row.id)) as Array<{ name: string; in_stock: number }>;
  const stockIn = comps.filter((c) => c.in_stock).map((c) => c.name);
  const stockOut = comps.filter((c) => !c.in_stock).map((c) => c.name);
  return {
    id: row.id,
    address: row.address || '',
    description: row.description || '',
    lat: row.lat || '',
    lon: row.lon || '',
    inventory_number: row.inventory_number || '',
    sim_number: row.sim_number || '',
    ip_address: row.ip_address || '',
    port: row.port || '',
    notes: row.notes || '',
    status: row.status || '',
    category_id: catId,
    category_name: cat?.name || '',
    category_color: cat?.color || '',
    category_is_legacy: cat?.is_legacy || false,
    login: decryptField(String(row.login || '')),
    password: decryptField(String(row.password || '')),
    verification_valid_until: row.verification_valid_until || '',
    power_source: row.power_source || '',
    fault_reason: row.fault_reason || '',
    fault_need: row.fault_need || '',
    fault_at: row.fault_at || '',
    fault_by: row.fault_by || '',
    stock_partial: String(row.status || '') === 'На складе' && stockIn.length > 0 && stockOut.length > 0,
    stock_in: stockIn,
    stock_out: stockOut,
    port_down_since: row.port_down_since ?? null,
    health_checked_at: row.health_checked_at ?? null,
  };
}

function loadCategoryMap(): Map<number, { name: string; color: string; is_legacy: boolean }> {
  const rows = getDb()
    .prepare('SELECT id, name, color, is_legacy FROM point_categories')
    .all() as Array<{ id: number; name: string; color: string; is_legacy: number }>;
  const map = new Map<number, { name: string; color: string; is_legacy: boolean }>();
  for (const r of rows) {
    map.set(r.id, { name: r.name, color: r.color, is_legacy: Boolean(r.is_legacy) });
  }
  return map;
}

function getOrCreateCategory(name: string, color: string): number | null {
  const clean = name.trim();
  if (!clean) return null;
  const db = getDb();
  const existing = db.prepare('SELECT id FROM point_categories WHERE lower(name) = lower(?)').get(clean) as
    | { id: number }
    | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare('INSERT INTO point_categories (name, color) VALUES (?, ?)')
    .run(clean, color.trim() || '#6366f1');
  return Number(info.lastInsertRowid);
}

function probeTcp(host: string, portNum: number, timeoutMs = 2500): Promise<{ ok: boolean; latency_ms: number; error?: string }> {
  return new Promise((resolve) => {
    const cleanHost = host.trim();
    if (!cleanHost) {
      resolve({ ok: false, latency_ms: 0, error: 'IP-адрес не указан' });
      return;
    }
    const start = Date.now();
    const sock = net.createConnection({ host: cleanHost, port: portNum });
    let settled = false;
    const finish = (ok: boolean, error?: string) => {
      if (settled) return;
      settled = true;
      sock.destroy();
      resolve({ ok, latency_ms: Date.now() - start, error });
    };
    sock.setTimeout(timeoutMs);
    sock.on('connect', () => finish(true));
    sock.on('timeout', () => finish(false, 'Тайм-аут соединения'));
    sock.on('error', (err) => finish(false, err.message));
  });
}

export function createPointsRouter(): Router {
  const router = Router();
  router.use('/api/points', requirePasswordOk);
  router.use('/api/point-categories', requirePasswordOk);
  router.use('/api/point-statuses', requirePasswordOk);
  router.use('/api/point-plans', requirePasswordOk);
  router.use('/api/point-files', requirePasswordOk);
  router.use('/api/point-card', requirePasswordOk);
  router.use('/api/apk-groups', requirePasswordOk);
  router.use('/api/check', requirePasswordOk);

  // ---- POINTS ----
  router.get('/api/points', (req: AuthedRequest, res) => {
    const db = getDb();
    const perms = req.sessionUser!.permissions;
    const catMap = loadCategoryMap();

    const search = String(req.query.search || '').trim().toLowerCase();
    const catIds = ([] as string[])
      .concat((req.query.category_id as string | string[]) || [])
      .map(Number)
      .filter((n) => Number.isFinite(n));
    const statuses = ([] as string[]).concat((req.query.status as string | string[]) || []).filter(Boolean);
    const uncategorized = req.query.uncategorized === 'true';
    const sort = String(req.query.sort || '');
    const certificate = String(req.query.certificate || '');
    const groupId = req.query.group_id ? Number(req.query.group_id) : null;
    const limit = req.query.limit !== undefined ? Number(req.query.limit) : null;
    const offset = Math.max(0, Number(req.query.offset || 0));

    const paged = Boolean(
      search || catIds.length || limit !== null || uncategorized || statuses.length || sort || certificate || groupId !== null,
    );

    let rows = db.prepare('SELECT * FROM points').all() as Array<Record<string, unknown>>;
    let groupMeta = new Map<string, { note: string; need: string; work_type: string; added_at: string }>();

    if (groupId !== null && Number.isFinite(groupId)) {
      const gRows = db
        .prepare('SELECT point_id, note, need, work_type, added_at FROM apk_group_points WHERE group_id = ?')
        .all(groupId) as Array<{ point_id: string; note: string; need: string; work_type: string; added_at: string }>;
      for (const g of gRows) groupMeta.set(g.point_id, g);
      rows = rows.filter((r) => groupMeta.has(String(r.id)));
    }

    if (search) {
      rows = rows.filter((r) =>
        [r.id, r.address, r.description, r.sim_number, r.inventory_number, r.ip_address]
          .some((v) => String(v || '').toLowerCase().includes(search)),
      );
    }
    if (uncategorized) {
      rows = rows.filter((r) => !r.category_id);
    } else if (catIds.length) {
      const set = new Set(catIds);
      rows = rows.filter((r) => r.category_id && set.has(Number(r.category_id)));
    }
    if (statuses.length) {
      const set = new Set(statuses);
      rows = rows.filter((r) => set.has(String(r.status || '')));
    }
    if (certificate === 'expired') {
      const today = new Date().toISOString().slice(0, 10);
      rows = rows.filter((r) => r.verification_valid_until && String(r.verification_valid_until) < today);
    } else if (certificate === 'valid') {
      const today = new Date().toISOString().slice(0, 10);
      rows = rows.filter((r) => r.verification_valid_until && String(r.verification_valid_until) >= today);
    }

    if (sort === 'down_oldest') {
      rows.sort((a, b) => String(a.port_down_since || '9999').localeCompare(String(b.port_down_since || '9999')));
    } else {
      rows.sort((a, b) => String(a.id).localeCompare(String(b.id), 'ru'));
    }

    const total = rows.length;
    const sliced = limit !== null ? rows.slice(offset, offset + limit) : rows;

    const result = sliced.map((r) => {
      const base = hydratePoint(r, catMap);
      const gm = groupMeta.get(String(r.id));
      const obj: Record<string, unknown> = stripCredentials(base, perms);
      if (groupId !== null && gm) {
        obj.group_note = gm.note;
        obj.group_need = gm.need;
        obj.group_work_type = gm.work_type;
        obj.group_added_at = gm.added_at;
      }
      if (paged) {
        const lastVisit = db
          .prepare(
            'SELECT substr(created_at, 1, 10) as day, visit_type, result_status, outcome, needs FROM task_visit_reports WHERE point_id = ? ORDER BY created_at DESC LIMIT 1',
          )
          .get(String(r.id));
        obj.last_visit = lastVisit || null;
      }
      return obj;
    });

    if (paged) {
      res.setHeader('X-Total-Count', String(total));
    }
    res.json(result);
  });

  router.post('/api/points', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const id = String(b.id || '').trim();
    if (!id) {
      res.status(400).json({ detail: 'Укажите номер комплекса' });
      return;
    }
    const db = getDb();
    const catId = b.category_name ? getOrCreateCategory(String(b.category_name), String(b.category_color || '')) : null;
    const existing = db.prepare('SELECT * FROM points WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    const loginEnc = b.login !== undefined ? encryptField(String(b.login || '')) : String(existing?.login || '');
    const passEnc = b.password !== undefined ? encryptField(String(b.password || '')) : String(existing?.password || '');

    if (existing) {
      db.prepare(
        `UPDATE points SET address=?, description=?, lat=?, lon=?, inventory_number=?, sim_number=?, ip_address=?, port=?,
         notes=?, status=?, category_id=?, login=?, password=?, verification_valid_until=?, power_source=?,
         fault_reason=?, fault_need=?, fault_at=?, fault_by=? WHERE id=?`,
      ).run(
        String(b.address ?? existing.address ?? ''),
        String(b.description ?? existing.description ?? ''),
        String(b.lat ?? existing.lat ?? ''),
        String(b.lon ?? existing.lon ?? ''),
        String(b.inventory_number ?? existing.inventory_number ?? ''),
        String(b.sim_number ?? existing.sim_number ?? ''),
        String(b.ip_address ?? existing.ip_address ?? ''),
        String(b.port ?? existing.port ?? ''),
        String(b.notes ?? existing.notes ?? ''),
        String(b.status ?? existing.status ?? ''),
        catId != null ? Number(catId) : existing.category_id != null ? Number(existing.category_id) : null,
        loginEnc,
        passEnc,
        String(b.verification_valid_until ?? existing.verification_valid_until ?? ''),
        b.power_source !== undefined ? String(b.power_source || '') : String(existing.power_source || ''),
        b.fault_reason !== undefined ? String(b.fault_reason || '') : String(existing.fault_reason || ''),
        b.fault_need !== undefined ? String(b.fault_need || '') : String(existing.fault_need || ''),
        b.fault_at !== undefined ? String(b.fault_at || '') : String(existing.fault_at || ''),
        b.fault_by !== undefined ? String(b.fault_by || '') : String(existing.fault_by || ''),
        id,
      );
    } else {
      db.prepare(
        `INSERT INTO points (id, address, description, lat, lon, inventory_number, sim_number, ip_address, port, notes, status, category_id, login, password, verification_valid_until, power_source, fault_reason, fault_need, fault_at, fault_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        String(b.address || ''),
        String(b.description || ''),
        String(b.lat || ''),
        String(b.lon || ''),
        String(b.inventory_number || ''),
        String(b.sim_number || ''),
        String(b.ip_address || ''),
        String(b.port || ''),
        String(b.notes || ''),
        String(b.status || ''),
        catId,
        loginEnc,
        passEnc,
        String(b.verification_valid_until || ''),
        String(b.power_source || ''),
        String(b.fault_reason || ''),
        String(b.fault_need || ''),
        String(b.fault_at || ''),
        String(b.fault_by || ''),
      );
    }
    const updated = db.prepare('SELECT * FROM points WHERE id = ?').get(id) as Record<string, unknown>;
    res.json(stripCredentials(hydratePoint(updated, loadCategoryMap()), req.sessionUser!.permissions));
  });

  router.post('/api/points/resolve', (req, res) => {
    const labels: string[] = Array.isArray(req.body?.labels) ? req.body.labels.map(String) : [];
    const rows = getDb().prepare('SELECT id, address, description, lat, lon FROM points').all() as Array<Record<string, unknown>>;
    const byNorm = new Map<string, Record<string, unknown>>();
    for (const r of rows) byNorm.set(String(r.id).trim().toLowerCase(), r);

    const matched: Array<{ label: string; point_id: string; address: string; description: string }> = [];
    const unmatched: string[] = [];
    for (const lbl of labels) {
      const clean = lbl.trim();
      const hit = byNorm.get(clean.toLowerCase());
      if (hit) {
        matched.push({ label: clean, point_id: String(hit.id), address: String(hit.address || ''), description: String(hit.description || '') });
      } else {
        unmatched.push(clean);
      }
    }
    res.json({ matched, unmatched });
  });

  router.get('/api/points/duplicates', (_req, res) => {
    const rows = getDb().prepare('SELECT id, address, description, status FROM points ORDER BY id').all() as Array<{
      id: string;
      address: string;
      description: string;
      status: string;
    }>;
    const byKey = new Map<string, typeof rows>();
    for (const r of rows) {
      const k = r.id.replace(/\s+/g, '').toLowerCase();
      (byKey.get(k) || (() => { const arr: typeof rows = []; byKey.set(k, arr); return arr; })()).push(r);
    }
    const groups = Array.from(byKey.values()).filter((g) => g.length > 1);
    res.json({ groups });
  });

  router.post('/api/points/merge-duplicates', (req, res) => {
    const primaryId = String(req.body?.primary_id || '').trim();
    const duplicateIds: string[] = Array.isArray(req.body?.duplicate_ids) ? req.body.duplicate_ids.map(String) : [];
    if (!primaryId || !duplicateIds.length) {
      res.status(400).json({ detail: 'Укажите основной комплекс и дубликаты' });
      return;
    }
    const db = getDb();
    for (const dup of duplicateIds) {
      if (dup === primaryId) continue;
      db.prepare('UPDATE tasks SET point = ? WHERE point = ?').run(primaryId, dup);
      db.prepare('UPDATE task_visit_reports SET point_id = ? WHERE point_id = ?').run(primaryId, dup);
      db.prepare('UPDATE visit_photos SET point_id = ? WHERE point_id = ?').run(primaryId, dup);
      db.prepare('DELETE FROM points WHERE id = ?').run(dup);
    }
    bumpStateRev();
    res.json({ ok: true });
  });

  router.post('/api/points/assign', (req, res) => {
    const b = req.body || {};
    const items: Array<{ point_id: string; type: string }> = Array.isArray(b.items) ? b.items : [];
    const dateStr = String(b.date || '');
    const team = Number(b.team);
    if (!items.length || !dateStr || !Number.isFinite(team)) {
      res.status(400).json({ detail: 'Укажите комплексы, дату и бригаду' });
      return;
    }
    const db = getDb();
    const ins = db.prepare(
      'INSERT INTO tasks (id, date, team, point, work, address, hours, travel, type, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let added = 0;
    for (const item of items) {
      const p = db.prepare('SELECT id, address, description FROM points WHERE id = ?').get(item.point_id) as
        | { id: string; address: string; description: string }
        | undefined;
      if (!p) continue;
      const tid = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      ins.run(tid, dateStr, team, p.id, p.description || '', p.address || '', Number(b.hours || 1), Number(b.travel || 0), String(item.type || ''), '');
      added += 1;
    }
    const rev = bumpStateRev();
    res.json({ ok: true, added, rev });
  });

  router.put('/api/points/:pointId/status', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const newStatus = String(req.body?.status || '').trim();
    const db = getDb();
    const existing = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const oldStatus = String(existing.status || '');
    db.prepare('UPDATE points SET status = ? WHERE id = ?').run(newStatus, pointId);
    if (oldStatus !== newStatus) {
      db.prepare('INSERT INTO point_status_history (point_id, old_status, new_status, source, changed_at) VALUES (?, ?, ?, ?, ?)').run(
        pointId,
        oldStatus,
        newStatus,
        'manual',
        nowIso(),
      );
    }
    const updated = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown>;
    res.json(stripCredentials(hydratePoint(updated, loadCategoryMap()), req.sessionUser!.permissions));
  });

  router.put('/api/points/:pointId', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const b = req.body || {};
    const catId = b.category_name !== undefined ? getOrCreateCategory(String(b.category_name || ''), String(b.category_color || '')) : existing.category_id;
    db.prepare(
      `UPDATE points SET address=?, description=?, lat=?, lon=?, inventory_number=?, sim_number=?, ip_address=?, port=?,
       notes=?, status=?, category_id=?, login=?, password=?, verification_valid_until=?, power_source=?,
       fault_reason=?, fault_need=?, fault_at=?, fault_by=? WHERE id=?`,
    ).run(
      String(b.address ?? existing.address ?? ''),
      String(b.description ?? existing.description ?? ''),
      String(b.lat ?? existing.lat ?? ''),
      String(b.lon ?? existing.lon ?? ''),
      String(b.inventory_number ?? existing.inventory_number ?? ''),
      String(b.sim_number ?? existing.sim_number ?? ''),
      String(b.ip_address ?? existing.ip_address ?? ''),
      String(b.port ?? existing.port ?? ''),
      String(b.notes ?? existing.notes ?? ''),
      String(b.status ?? existing.status ?? ''),
      catId != null ? Number(catId) : null,
      b.login !== undefined ? encryptField(String(b.login || '')) : String(existing.login ?? ''),
      b.password !== undefined ? encryptField(String(b.password || '')) : String(existing.password ?? ''),
      String(b.verification_valid_until ?? existing.verification_valid_until ?? ''),
      b.power_source !== undefined ? String(b.power_source || '') : String(existing.power_source ?? ''),
      b.fault_reason !== undefined ? String(b.fault_reason || '') : String(existing.fault_reason ?? ''),
      b.fault_need !== undefined ? String(b.fault_need || '') : String(existing.fault_need ?? ''),
      b.fault_at !== undefined ? String(b.fault_at || '') : String(existing.fault_at ?? ''),
      b.fault_by !== undefined ? String(b.fault_by || '') : String(existing.fault_by ?? ''),
      pointId,
    );
    const updated = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown>;
    res.json(stripCredentials(hydratePoint(updated, loadCategoryMap()), req.sessionUser!.permissions));
  });

  router.delete('/api/points/:pointId', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const info = db.prepare('DELETE FROM points WHERE id = ?').run(pointId);
    if (!info.changes) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    res.json({ ok: true });
  });

  router.get('/api/points/:pointId/sim-links', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const rows = db
      .prepare(
        `SELECT p.id, p.address
         FROM point_sim_links a
         JOIN point_sim_links b ON b.group_id = a.group_id AND b.point_id != a.point_id
         JOIN points p ON p.id = b.point_id
         WHERE a.point_id = ?
         ORDER BY p.id`,
      )
      .all(pointId) as Array<{ id: string; address: string }>;
    res.json({ linked: rows.map((r) => ({ id: r.id, address: r.address || '' })) });
  });

  router.get('/api/points/:pointId/ping', async (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const port = Number(point.port) || 80;
    const probe = await probeTcp(String(point.ip_address || ''), port);
    db.prepare('UPDATE points SET health_checked_at = ? WHERE id = ?').run(nowIso(), pointId);
    res.json({
      ok: probe.ok,
      reachable: probe.ok,
      latency_ms: probe.latency_ms,
      detail: probe.error || (probe.ok ? 'Доступен' : 'Не отвечает'),
    });
  });

  router.get('/api/points/:pointId/check-port', async (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const db = getDb();
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    const port = Number(point.port) || 80;
    const probe = await probeTcp(String(point.ip_address || ''), port);
    db.prepare('UPDATE points SET health_checked_at = ? WHERE id = ?').run(nowIso(), pointId);
    res.json({
      ok: probe.ok,
      open: probe.ok,
      port,
      latency_ms: probe.latency_ms,
      detail: probe.error || (probe.ok ? 'Порт открыт' : 'Порт недоступен'),
    });
  });

  router.get('/api/points/:pointId', (req: AuthedRequest, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const point = getDb().prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Точка не найдена' });
      return;
    }
    res.json(stripCredentials(hydratePoint(point, loadCategoryMap()), req.sessionUser!.permissions));
  });

  // ---- POINT CATEGORIES ----
  router.get('/api/point-categories', (_req, res) => {
    const rows = getDb()
      .prepare('SELECT id, name, color, match_pattern, is_legacy FROM point_categories ORDER BY name')
      .all() as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, is_legacy: Boolean(r.is_legacy) })));
  });

  router.get('/api/point-categories/search', (req, res) => {
    const q = String(req.query.q || '').trim().toLowerCase();
    const rows = getDb().prepare('SELECT id, name, color, match_pattern, is_legacy FROM point_categories ORDER BY name').all() as Array<Record<string, unknown>>;
    res.json(rows.filter((r) => !q || String(r.name).toLowerCase().includes(q)));
  });

  router.post('/api/point-categories', (req, res) => {
    const b = req.body || {};
    const name = String(b.name || '').trim();
    if (!name) {
      res.status(400).json({ detail: 'Укажите название категории' });
      return;
    }
    const db = getDb();
    try {
      const info = db
        .prepare('INSERT INTO point_categories (name, color, match_pattern, is_legacy) VALUES (?, ?, ?, ?)')
        .run(name, String(b.color || '#6366f1'), b.match_pattern || null, b.is_legacy ? 1 : 0);
      const created = db.prepare('SELECT * FROM point_categories WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      res.status(201).json({ ...created, is_legacy: Boolean(created.is_legacy) });
    } catch {
      res.status(400).json({ detail: 'Такая категория уже существует' });
    }
  });

  router.put('/api/point-categories/:categoryId', (req, res) => {
    const id = Number(req.params.categoryId);
    const b = req.body || {};
    const db = getDb();
    db.prepare('UPDATE point_categories SET name=?, color=?, match_pattern=?, is_legacy=? WHERE id=?').run(
      String(b.name || '').trim(),
      String(b.color || '#6366f1'),
      b.match_pattern ?? null,
      b.is_legacy ? 1 : 0,
      id,
    );
    const updated = db.prepare('SELECT * FROM point_categories WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!updated) {
      res.status(404).json({ detail: 'Категория не найдена' });
      return;
    }
    res.json({ ...updated, is_legacy: Boolean(updated.is_legacy) });
  });

  router.delete('/api/point-categories/:categoryId', (req, res) => {
    const id = Number(req.params.categoryId);
    const db = getDb();
    db.prepare('UPDATE points SET category_id = NULL WHERE category_id = ?').run(id);
    db.prepare('DELETE FROM point_categories WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  router.post('/api/point-categories/auto-assign', (_req, res) => {
    const db = getDb();
    const cats = db.prepare('SELECT id, match_pattern FROM point_categories WHERE coalesce(match_pattern, \'\') != \'\'').all() as Array<{
      id: number;
      match_pattern: string;
    }>;
    const uncat = db.prepare('SELECT id, description FROM points WHERE category_id IS NULL').all() as Array<{
      id: string;
      description: string;
    }>;
    let assigned = 0;
    const upd = db.prepare('UPDATE points SET category_id = ? WHERE id = ?');
    for (const p of uncat) {
      const hay = `${p.id} ${p.description}`.toLowerCase();
      for (const c of cats) {
        if (hay.includes(c.match_pattern.toLowerCase())) {
          upd.run(c.id, p.id);
          assigned += 1;
          break;
        }
      }
    }
    res.json({ assigned });
  });

  // ---- POINT STATUSES ----
  router.get('/api/point-statuses', (_req, res) => {
    const rows = getDb().prepare('SELECT * FROM point_statuses ORDER BY id').all() as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, is_auto: Boolean(r.is_auto), protected: Boolean(r.protected) })));
  });

  router.post('/api/point-statuses', (req, res) => {
    const name = String(req.body?.name || '').trim();
    const color = String(req.body?.color || '#64748b');
    if (!name) {
      res.status(400).json({ detail: 'Укажите название статуса' });
      return;
    }
    const db = getDb();
    try {
      const info = db
        .prepare('INSERT INTO point_statuses (name, color, is_auto, protected, created_at) VALUES (?, ?, 0, 0, ?)')
        .run(name, color, nowIso());
      const created = db.prepare('SELECT * FROM point_statuses WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
      res.status(201).json({ ...created, is_auto: Boolean(created.is_auto), protected: Boolean(created.protected) });
    } catch {
      res.status(400).json({ detail: 'Такой статус уже существует' });
    }
  });

  router.put('/api/point-statuses/:statusId', (req, res) => {
    const id = Number(req.params.statusId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM point_statuses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Статус не найден' });
      return;
    }
    const newName = String(req.body?.name || existing.name).trim();
    const color = String(req.body?.color || existing.color);
    if (existing.name === 'На складе' && newName !== 'На складе') {
      res.status(400).json({ detail: 'Статус «На складе» нельзя переименовать' });
      return;
    }
    db.prepare('UPDATE point_statuses SET name = ?, color = ? WHERE id = ?').run(newName, color, id);
    if (newName !== existing.name) {
      db.prepare('UPDATE points SET status = ? WHERE status = ?').run(newName, String(existing.name ?? ''));
    }
    const updated = db.prepare('SELECT * FROM point_statuses WHERE id = ?').get(id) as Record<string, unknown>;
    res.json({ ...updated, is_auto: Boolean(updated.is_auto), protected: Boolean(updated.protected) });
  });

  router.delete('/api/point-statuses/:statusId', (req, res) => {
    const id = Number(req.params.statusId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM point_statuses WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Статус не найден' });
      return;
    }
    if (existing.protected) {
      res.status(400).json({ detail: 'Системный статус нельзя удалить' });
      return;
    }
    db.prepare('DELETE FROM point_statuses WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---- POINT CARD & FILES ----
  router.get('/api/point-card', (req: AuthedRequest, res) => {
    const pointId = String(req.query.point_id || '').trim();
    const db = getDb();
    const point = db.prepare('SELECT * FROM points WHERE id = ?').get(pointId) as Record<string, unknown> | undefined;
    if (!point) {
      res.status(404).json({ detail: 'Комплекс не найден' });
      return;
    }
    const hydrated = stripCredentials(hydratePoint(point, loadCategoryMap()), req.sessionUser!.permissions);
    const visits = db
      .prepare('SELECT * FROM task_visit_reports WHERE point_id = ? ORDER BY created_at DESC LIMIT 50')
      .all(pointId);
    const photos = db
      .prepare('SELECT id, task_id, point_id, taken_date, file_ext, uploaded_at, uploaded_by FROM visit_photos WHERE point_id = ? ORDER BY id DESC LIMIT 100')
      .all(pointId);
    const files = db
      .prepare('SELECT * FROM point_files WHERE point_id = ? ORDER BY id DESC')
      .all(pointId);
    const statusHistory = db
      .prepare('SELECT * FROM point_status_history WHERE point_id = ? ORDER BY id DESC LIMIT 50')
      .all(pointId);
    const equipment = db
      .prepare(
        `SELECT e.id, e.serial_number, e.installed_date, m.name as model_name, c.name as category_name, s.name as status_name, s.color as status_color
         FROM equipment e
         LEFT JOIN equipment_models m ON m.id = e.model_id
         LEFT JOIN equipment_categories c ON c.id = m.category_id
         LEFT JOIN equipment_statuses s ON s.id = e.status_id
         WHERE e.place = 'point' AND e.point_id = ?`,
      )
      .all(pointId);

    res.json({
      point: hydrated,
      visits,
      photos,
      files,
      status_history: statusHistory,
      equipment,
    });
  });

  router.get('/api/point-files', (req, res) => {
    const pointId = String(req.query.point_id || '').trim();
    const rows = getDb()
      .prepare('SELECT * FROM point_files WHERE point_id = ? ORDER BY id DESC')
      .all(pointId);
    res.json(rows);
  });

  router.post('/api/point-files', upload.single('file'), (req: AuthedRequest, res) => {
    const pointId = String(req.body?.point_id || '').trim();
    const comment = String(req.body?.comment || '').trim();
    if (!pointId || !req.file) {
      res.status(400).json({ detail: 'Укажите комплекс и выберите файл' });
      return;
    }
    const ext = path.extname(req.file.originalname || '').toLowerCase();
    const kind = ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? 'image' : 'other';
    const info = getDb()
      .prepare(
        'INSERT INTO point_files (point_id, name, ext, kind, mime, size, comment, uploaded_at, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        pointId,
        req.file.originalname || `file${ext}`,
        ext,
        kind,
        req.file.mimetype || 'application/octet-stream',
        req.file.size,
        comment,
        nowIso(),
        req.sessionUser?.username || '',
      );
    const id = Number(info.lastInsertRowid);
    fs.writeFileSync(path.join(POINT_FILES_DIR, `${id}${ext}`), req.file.buffer);
    const created = getDb().prepare('SELECT * FROM point_files WHERE id = ?').get(id);
    res.status(201).json(created);
  });

  router.get('/api/point-files/:fileId/file', (req, res) => {
    const id = Number(req.params.fileId);
    const row = getDb().prepare('SELECT * FROM point_files WHERE id = ?').get(id) as
      | { id: number; name: string; ext: string; mime: string }
      | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Файл не найден' });
      return;
    }
    const fp = path.join(POINT_FILES_DIR, `${row.id}${row.ext}`);
    if (!fs.existsSync(fp)) {
      res.status(404).json({ detail: 'Файл отсутствует на диске' });
      return;
    }
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.sendFile(fp);
  });

  router.get('/api/point-files/:fileId/preview', (req, res) => {
    const id = Number(req.params.fileId);
    const row = getDb().prepare('SELECT * FROM point_files WHERE id = ?').get(id) as
      | { id: number; ext: string; mime: string }
      | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Файл не найден' });
      return;
    }
    const fp = path.join(POINT_FILES_DIR, `${row.id}${row.ext}`);
    if (!fs.existsSync(fp)) {
      res.status(404).json({ detail: 'Файл отсутствует' });
      return;
    }
    res.setHeader('Content-Type', row.mime || 'application/octet-stream');
    res.sendFile(fp);
  });

  router.delete('/api/point-files/:fileId', (req, res) => {
    const id = Number(req.params.fileId);
    const row = getDb().prepare('SELECT * FROM point_files WHERE id = ?').get(id) as { id: number; ext: string } | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Файл не найден' });
      return;
    }
    const fp = path.join(POINT_FILES_DIR, `${row.id}${row.ext}`);
    try {
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    } catch {
      // ignore
    }
    getDb().prepare('DELETE FROM point_files WHERE id = ?').run(id);
    res.json({ ok: true });
  });

  // ---- POINT PLANS ----
  router.get('/api/point-plans', (_req, res) => {
    const rows = getDb()
      .prepare(
        `SELECT pp.*, p.address, p.description as point_description, p.status, p.lat, p.lon
         FROM point_plans pp
         LEFT JOIN points p ON p.id = pp.point_id
         ORDER BY pp.priority DESC, pp.id DESC`,
      )
      .all() as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, priority: Boolean(r.priority) })));
  });

  router.get('/api/point-plans/groups', (_req, res) => {
    const rows = getDb()
      .prepare("SELECT DISTINCT group_name FROM point_plans WHERE group_name != '' ORDER BY group_name")
      .all() as Array<{ group_name: string }>;
    res.json(rows.map((r) => r.group_name));
  });

  router.get('/api/point-plans/import-template', async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('План');
    ws.addRow(['Номер комплекса', 'Описание', 'Тип работ', 'Группа', 'Приоритет (1/0)']);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="plan-template.xlsx"');
    res.send(Buffer.from(buf));
  });

  router.post('/api/point-plans', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const pointId = String(b.point_id || '').trim();
    if (!pointId) {
      res.status(400).json({ detail: 'Укажите номер комплекса' });
      return;
    }
    const info = getDb()
      .prepare(
        'INSERT INTO point_plans (point_id, description, priority, group_name, work_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        pointId,
        String(b.description || ''),
        b.priority ? 1 : 0,
        String(b.group_name || ''),
        String(b.work_type || ''),
        nowIso(),
        req.sessionUser?.username || '',
      );
    const created = getDb().prepare('SELECT * FROM point_plans WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    res.status(201).json({ ...created, priority: Boolean(created.priority) });
  });

  router.post('/api/point-plans/bulk', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const ids: string[] = Array.isArray(b.point_ids) ? b.point_ids.map(String) : [];
    const types: Record<string, string> = b.types && typeof b.types === 'object' ? b.types : {};
    const ins = getDb().prepare(
      'INSERT INTO point_plans (point_id, description, priority, group_name, work_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = nowIso();
    for (const pid of ids) {
      ins.run(
        pid,
        String(b.description || ''),
        b.priority ? 1 : 0,
        String(b.group_name || ''),
        String(b.work_type || types[pid] || ''),
        now,
        req.sessionUser?.username || '',
      );
    }
    res.json({ ok: true, added: ids.length });
  });

  router.post('/api/point-plans/priority', (req, res) => {
    const ids: number[] = Array.isArray(req.body?.plan_ids) ? req.body.plan_ids.map(Number) : [];
    const prio = req.body?.priority ? 1 : 0;
    if (ids.length) {
      getDb().prepare(`UPDATE point_plans SET priority = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(prio, ...ids);
    }
    res.json({ ok: true });
  });

  router.post('/api/point-plans/group', (req, res) => {
    const ids: number[] = Array.isArray(req.body?.plan_ids) ? req.body.plan_ids.map(Number) : [];
    const name = String(req.body?.name || '').trim();
    if (ids.length) {
      getDb().prepare(`UPDATE point_plans SET group_name = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(name, ...ids);
    }
    res.json({ ok: true });
  });

  router.post('/api/point-plans/work-type', (req, res) => {
    const ids: number[] = Array.isArray(req.body?.plan_ids) ? req.body.plan_ids.map(Number) : [];
    const type = String(req.body?.type || '').trim();
    if (ids.length) {
      getDb().prepare(`UPDATE point_plans SET work_type = ? WHERE id IN (${ids.map(() => '?').join(',')})`).run(type, ...ids);
    }
    res.json({ ok: true });
  });

  router.post('/api/point-plans/assign', (req, res) => {
    const b = req.body || {};
    const items: Array<{ plan_id: number; type?: string }> = Array.isArray(b.items) ? b.items : [];
    const dateStr = String(b.date || '');
    const team = Number(b.team);
    const db = getDb();
    const insTask = db.prepare(
      'INSERT INTO tasks (id, date, team, point, work, address, hours, travel, type, note, priority) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    let added = 0;
    for (const item of items) {
      const plan = db.prepare('SELECT * FROM point_plans WHERE id = ?').get(Number(item.plan_id)) as
        | { id: number; point_id: string; description: string; priority: number; work_type: string }
        | undefined;
      if (!plan) continue;
      const p = db.prepare('SELECT address FROM points WHERE id = ?').get(plan.point_id) as { address: string } | undefined;
      const tid = `t_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      insTask.run(
        tid,
        dateStr,
        team,
        plan.point_id,
        plan.description || '',
        p?.address || '',
        Number(b.hours || 1),
        Number(b.travel || 0),
        String(item.type || plan.work_type || 'Ремонт'),
        '',
        plan.priority ? 1 : 0,
      );
      db.prepare('DELETE FROM point_plans WHERE id = ?').run(plan.id);
      added += 1;
    }
    const rev = bumpStateRev();
    res.json({ ok: true, added, rev });
  });

  router.post('/api/point-plans/import', upload.single('file'), async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) {
      res.status(400).json({ detail: 'Пустой файл Excel' });
      return;
    }
    const ins = getDb().prepare(
      'INSERT INTO point_plans (point_id, description, priority, group_name, work_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const now = nowIso();
    let added = 0;
    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const pid = String(row.getCell(1).value || '').trim();
      if (!pid) return;
      ins.run(
        pid,
        String(row.getCell(2).value || '').trim(),
        String(row.getCell(5).value || '').trim() === '1' ? 1 : 0,
        String(row.getCell(4).value || '').trim(),
        String(row.getCell(3).value || '').trim(),
        now,
        req.sessionUser?.username || '',
      );
      added += 1;
    });
    res.json({ ok: true, added });
  });

  router.delete('/api/point-plans/:planId', (req, res) => {
    getDb().prepare('DELETE FROM point_plans WHERE id = ?').run(Number(req.params.planId));
    res.json({ ok: true });
  });

  // ---- APK GROUPS ----
  router.get('/api/apk-groups', (_req, res) => {
    const db = getDb();
    const groups = db.prepare('SELECT * FROM apk_groups ORDER BY id').all() as Array<Record<string, unknown>>;
    const counts = db
      .prepare('SELECT group_id, COUNT(*) as cnt FROM apk_group_points GROUP BY group_id')
      .all() as Array<{ group_id: number; cnt: number }>;
    const countMap = new Map(counts.map((c) => [c.group_id, c.cnt]));
    res.json(
      groups.map((g) => ({
        ...g,
        auto_remove: Boolean(g.auto_remove),
        points_count: countMap.get(Number(g.id)) || 0,
      })),
    );
  });

  router.post('/api/apk-groups', (req: AuthedRequest, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ detail: 'Укажите название подгруппы' });
      return;
    }
    const info = getDb()
      .prepare('INSERT INTO apk_groups (name, description, kind, auto_remove, created_at, created_by) VALUES (?, ?, \'\', ?, ?, ?)')
      .run(name, String(req.body?.description || ''), req.body?.auto_remove ? 1 : 0, nowIso(), req.sessionUser?.username || '');
    const created = getDb().prepare('SELECT * FROM apk_groups WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    res.status(201).json({ ...created, auto_remove: Boolean(created.auto_remove), points_count: 0 });
  });

  router.put('/api/apk-groups/:groupId', (req, res) => {
    const id = Number(req.params.groupId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM apk_groups WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Подгруппа не найдена' });
      return;
    }
    db.prepare('UPDATE apk_groups SET name=?, description=?, auto_remove=? WHERE id=?').run(
      String(req.body?.name ?? existing.name ?? '').trim(),
      String(req.body?.description ?? existing.description ?? ''),
      req.body?.auto_remove !== undefined ? (req.body.auto_remove ? 1 : 0) : Number(existing.auto_remove ?? 0),
      id,
    );
    const updated = db.prepare('SELECT * FROM apk_groups WHERE id = ?').get(id) as Record<string, unknown>;
    res.json({ ...updated, auto_remove: Boolean(updated.auto_remove) });
  });

  router.delete('/api/apk-groups/:groupId', (req, res) => {
    getDb().prepare('DELETE FROM apk_groups WHERE id = ?').run(Number(req.params.groupId));
    res.json({ ok: true });
  });

  router.post('/api/apk-groups/:groupId/points', (req, res) => {
    const groupId = Number(req.params.groupId);
    const ids: string[] = Array.isArray(req.body?.point_ids) ? req.body.point_ids.map(String) : [];
    const ins = getDb().prepare(
      'INSERT OR IGNORE INTO apk_group_points (group_id, point_id, note, need, work_type, added_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const now = nowIso();
    for (const pid of ids) {
      ins.run(groupId, pid, String(req.body?.note || ''), String(req.body?.need || ''), String(req.body?.work_type || ''), now);
    }
    res.json({ ok: true, added: ids.length });
  });

  router.post('/api/apk-groups/:groupId/paste', (req, res) => {
    const groupId = Number(req.params.groupId);
    const text = String(req.body?.text || '');
    const tokens = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const db = getDb();
    const allPts = db.prepare('SELECT id FROM points').all() as Array<{ id: string }>;
    const byLow = new Map(allPts.map((p) => [p.id.toLowerCase(), p.id]));
    const ins = db.prepare(
      'INSERT OR IGNORE INTO apk_group_points (group_id, point_id, note, need, work_type, added_at) VALUES (?, ?, \'\', \'\', \'\', ?)',
    );
    const now = nowIso();
    let added = 0;
    const unknown: string[] = [];
    for (const tok of tokens) {
      const real = byLow.get(tok.toLowerCase());
      if (real) {
        ins.run(groupId, real, now);
        added += 1;
      } else {
        unknown.push(tok);
      }
    }
    res.json({ ok: true, added, unknown });
  });

  router.post('/api/apk-groups/:groupId/import', upload.single('file'), async (req, res) => {
    const groupId = Number(req.params.groupId);
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const content = req.file.buffer.toString('utf-8');
    const tokens = content.split(/[\r\n,;]+/).map((s) => s.trim()).filter(Boolean);
    const db = getDb();
    const allPts = db.prepare('SELECT id FROM points').all() as Array<{ id: string }>;
    const byLow = new Map(allPts.map((p) => [p.id.toLowerCase(), p.id]));
    const ins = db.prepare(
      'INSERT OR IGNORE INTO apk_group_points (group_id, point_id, note, need, work_type, added_at) VALUES (?, ?, \'\', \'\', \'\', ?)',
    );
    let added = 0;
    const now = nowIso();
    for (const tok of tokens) {
      const real = byLow.get(tok.toLowerCase());
      if (real) {
        ins.run(groupId, real, now);
        added += 1;
      }
    }
    res.json({ ok: true, added });
  });

  router.post('/api/apk-groups/:groupId/points/update', (req, res) => {
    const groupId = Number(req.params.groupId);
    const ids: string[] = Array.isArray(req.body?.point_ids) ? req.body.point_ids.map(String) : [];
    const db = getDb();
    for (const pid of ids) {
      db.prepare('UPDATE apk_group_points SET note=?, need=?, work_type=? WHERE group_id=? AND point_id=?').run(
        String(req.body?.note || ''),
        String(req.body?.need || ''),
        String(req.body?.work_type || ''),
        groupId,
        pid,
      );
    }
    res.json({ ok: true });
  });

  router.put('/api/apk-groups/:groupId/points/:pointId', (req, res) => {
    const groupId = Number(req.params.groupId);
    const pointId = decodeURIComponent(req.params.pointId);
    getDb()
      .prepare('UPDATE apk_group_points SET note=?, need=?, work_type=? WHERE group_id=? AND point_id=?')
      .run(String(req.body?.note || ''), String(req.body?.need || ''), String(req.body?.work_type || ''), groupId, pointId);
    res.json({ ok: true });
  });

  router.post('/api/apk-groups/:groupId/points/remove', (req, res) => {
    const groupId = Number(req.params.groupId);
    const ids: string[] = Array.isArray(req.body?.point_ids) ? req.body.point_ids.map(String) : [];
    const del = getDb().prepare('DELETE FROM apk_group_points WHERE group_id = ? AND point_id = ?');
    for (const pid of ids) del.run(groupId, pid);
    res.json({ ok: true });
  });

  // ---- CHECK TAB ----
  const CHECK_COLUMNS = [
    { key: 'id', label: 'Номер' },
    { key: 'status', label: 'Статус' },
    { key: 'address', label: 'Адрес' },
    { key: 'description', label: 'Описание' },
    { key: 'category_name', label: 'Категория' },
    { key: 'sim_number', label: 'SIM' },
    { key: 'ip_address', label: 'IP' },
    { key: 'port', label: 'Порт' },
    { key: 'power_source', label: 'Питание' },
    { key: 'verification_valid_until', label: 'Поверка до' },
    { key: 'fault_reason', label: 'Причина неисправности' },
    { key: 'fault_need', label: 'Что нужно' },
  ];

  router.get('/api/check/columns', (req: AuthedRequest, res) => {
    const perms = req.sessionUser!.permissions;
    const cols = CHECK_COLUMNS.filter((c) => (c.key !== 'ip_address' && c.key !== 'port') || networkOk(perms));
    res.json({ columns: cols });
  });

  function runCheckLookup(text: string, perms: string[]) {
    const tokens = text.split(/[\s,;]+/).map((s) => s.trim()).filter(Boolean);
    const db = getDb();
    const catMap = loadCategoryMap();
    const allPts = db.prepare('SELECT * FROM points').all() as Array<Record<string, unknown>>;
    const byLow = new Map(allPts.map((p) => [String(p.id).trim().toLowerCase(), p]));
    const items: Array<Record<string, unknown>> = [];
    const missing: string[] = [];
    for (const tok of tokens) {
      const hit = byLow.get(tok.toLowerCase());
      if (hit) {
        items.push(stripCredentials(hydratePoint(hit, catMap), perms));
      } else {
        missing.push(tok);
      }
    }
    return { items, missing };
  }

  router.post('/api/check', (req: AuthedRequest, res) => {
    const text = String(req.body?.text || '');
    if (!text.trim()) {
      res.status(400).json({ detail: 'Впишите номера комплексов — через пробел или с новой строки' });
      return;
    }
    res.json(runCheckLookup(text, req.sessionUser!.permissions));
  });

  router.post('/api/check/export', async (req: AuthedRequest, res) => {
    const text = String(req.body?.text || '');
    const cols: string[] = Array.isArray(req.body?.columns) && req.body.columns.length ? req.body.columns : ['id', 'status', 'address', 'description'];
    const result = runCheckLookup(text, req.sessionUser!.permissions);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Проверка');
    const colMap = new Map(CHECK_COLUMNS.map((c) => [c.key, c.label]));
    ws.addRow(cols.map((k) => colMap.get(k) || k));
    for (const item of result.items) {
      ws.addRow(cols.map((k) => String(item[k] ?? '')));
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="proverka.xlsx"');
    res.send(Buffer.from(buf));
  });

  return router;
}
