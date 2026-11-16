import { Router } from 'express';
import { clientIp, recordSecurityEvent, requirePasswordOk, type AuthedRequest } from '../auth.ts';
import { decryptField, encryptField } from '../crypto.ts';
import { bumpStateRev, getDb, getStateRev, nowIso } from '../db.ts';

function mapPerson(row: Record<string, unknown>) {
  return {
    id: row.id,
    full_name: decryptField(String(row.full_name || '')),
    phone: row.phone ? decryptField(String(row.phone)) : null,
    role_type: row.role_type,
    vk_id: row.vk_id ?? null,
    active: Boolean(row.active),
    notes: row.notes ?? null,
    driver_kind: row.driver_kind || '',
    created_at: row.created_at,
  };
}

function getCrewWithMembers(crewId: number) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM crews WHERE id = ?').get(crewId) as Record<string, unknown> | undefined;
  if (!c) return null;
  const members = db
    .prepare(
      'SELECT p.id, p.full_name, p.phone, p.role_type, p.driver_kind FROM crew_members cm JOIN people p ON p.id = cm.person_id WHERE cm.crew_id = ? ORDER BY p.id',
    )
    .all(crewId) as Array<Record<string, unknown>>;

  let tripFrom: string | null = null;
  let tripTo: string | null = null;
  let tripCrewIds: number[] | null = null;
  if (c.trip_id) {
    const siblings = db
      .prepare('SELECT id, date FROM crews WHERE trip_id = ? ORDER BY date, id')
      .all(String(c.trip_id)) as Array<{ id: number; date: string }>;
    if (siblings.length > 0) {
      tripFrom = siblings[0].date;
      tripTo = siblings[siblings.length - 1].date;
      tripCrewIds = siblings.map((s) => s.id);
    }
  }

  return {
    id: c.id,
    date: c.date,
    name: c.name || '',
    equip: c.equip || 'Лестница',
    map_link: c.map_link || '',
    place: c.place || '',
    contractor: Boolean(c.contractor),
    contractor_note: c.contractor_note || '',
    members: members.map((m) => ({
      id: m.id,
      full_name: decryptField(String(m.full_name || '')),
      phone: m.phone ? decryptField(String(m.phone)) : null,
      role_type: m.role_type,
      driver_kind: m.driver_kind || '',
    })),
    trip_id: c.trip_id ?? null,
    trip_from: tripFrom,
    trip_to: tripTo,
    trip_crew_ids: tripCrewIds,
  };
}

export function createCalendarRouter(): Router {
  const router = Router();
  router.use('/api/state', requirePasswordOk);
  router.use('/api/crews', requirePasswordOk);
  router.use('/api/people', requirePasswordOk);
  router.use('/api/absences', requirePasswordOk);
  router.use('/api/work-types', requirePasswordOk);

  // ---- STATE ----
  router.get('/api/state', (req, res) => {
    const rev = getStateRev();
    const sinceRev = req.query.since_rev !== undefined ? Number(req.query.since_rev) : null;
    if (sinceRev !== null && Number.isFinite(sinceRev) && sinceRev === rev) {
      res.json({ rev, unchanged: true });
      return;
    }
    const db = getDb();
    const reportedIds = new Set(
      (db.prepare('SELECT task_id FROM task_visit_reports WHERE imported = 0').all() as Array<{ task_id: string }>).map(
        (r) => r.task_id,
      ),
    );
    const auxDoneIds = new Set(
      (db.prepare('SELECT task_id FROM aux_task_done').all() as Array<{ task_id: string }>).map((r) => r.task_id),
    );
    const rows = db
      .prepare(
        'SELECT id, date, team, point, work, address, hours, travel, type, note, trip_id, date_to, priority, aux_lat, aux_lon FROM tasks',
      )
      .all() as Array<Record<string, unknown>>;

    const tasks = rows.map((r) => ({
      id: r.id,
      date: r.date,
      team: r.team,
      point: r.point || '',
      work: r.work || '',
      address: r.address || '',
      hours: Number(r.hours || 0),
      travel: Number(r.travel || 0),
      type: r.type || '',
      note: r.note || '',
      trip_id: r.trip_id ?? null,
      date_to: r.date_to ?? null,
      priority: Boolean(r.priority),
      aux_lat: r.aux_lat || '',
      aux_lon: r.aux_lon || '',
      reported:
        reportedIds.has(String(r.id)) ||
        (r.type === 'Вспомогательная точка' && auxDoneIds.has(String(r.id))),
    }));

    res.json({ rev, data: { tasks } });
  });

  router.put('/api/state', (req, res) => {
    const expectedRev = Number(req.body?.rev);
    const data = req.body?.data;
    if (!data || !Array.isArray(data.tasks)) {
      res.status(400).json({ detail: "Поле 'tasks' должно быть типа list" });
      return;
    }
    const db = getDb();
    const currentRev = getStateRev();
    if (currentRev !== expectedRev) {
      res.status(409).json({ detail: 'Конфликт изменений' });
      return;
    }

    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM tasks').run();
      const ins = db.prepare(
        'INSERT INTO tasks (id, date, team, point, work, address, hours, travel, type, note, trip_id, date_to, priority, aux_lat, aux_lon) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      );
      for (const t of data.tasks) {
        const isAux = String(t.type || '').trim() === 'Вспомогательная точка';
        ins.run(
          String(t.id),
          String(t.date),
          Number(t.team),
          String(t.point || ''),
          String(t.work || ''),
          String(t.address || ''),
          Number(t.hours || 0),
          Number(t.travel || 0),
          String(t.type || ''),
          String(t.note || ''),
          t.trip_id ? String(t.trip_id) : null,
          t.date_to ? String(t.date_to) : null,
          t.priority ? 1 : 0,
          isAux ? String(t.aux_lat || '').trim().replace(',', '.') : '',
          isAux ? String(t.aux_lon || '').trim().replace(',', '.') : '',
        );
      }
      db.prepare('DELETE FROM aux_task_done WHERE task_id NOT IN (SELECT id FROM tasks)').run();
      db.prepare('DELETE FROM bot_task_progress WHERE task_id NOT IN (SELECT id FROM tasks)').run();
      const newRev = bumpStateRev();
      db.exec('COMMIT');
      res.json({ rev: newRev });
    } catch (err) {
      db.exec('ROLLBACK');
      res.status(500).json({ detail: (err as Error).message });
    }
  });

  // ---- CREWS ----
  router.get('/api/crews', (req, res) => {
    const day = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const rows = getDb().prepare('SELECT id FROM crews WHERE date = ? ORDER BY id').all(day) as Array<{ id: number }>;
    res.json(rows.map((r) => getCrewWithMembers(r.id)));
  });

  router.post('/api/crews', (req, res) => {
    const b = req.body || {};
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date || ''))) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const db = getDb();
    const info = db
      .prepare(
        'INSERT INTO crews (date, name, equip, map_link, place, contractor, contractor_note) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        String(b.date),
        String(b.name || ''),
        String(b.equip || 'Лестница'),
        String(b.map_link || ''),
        String(b.place || ''),
        b.contractor ? 1 : 0,
        String(b.contractor_note || ''),
      );
    const crewId = Number(info.lastInsertRowid);
    if (Array.isArray(b.person_ids)) {
      const insMem = db.prepare('INSERT OR IGNORE INTO crew_members (crew_id, person_id) VALUES (?, ?)');
      for (const pid of b.person_ids) insMem.run(crewId, Number(pid));
    }
    res.status(201).json(getCrewWithMembers(crewId));
  });

  router.put('/api/crews/:crewId', (req, res) => {
    const crewId = Number(req.params.crewId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM crews WHERE id = ?').get(crewId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Бригада не найдена' });
      return;
    }
    const b = req.body || {};
    db.prepare(
      'UPDATE crews SET name = ?, equip = ?, map_link = ?, place = ?, contractor = ?, contractor_note = ? WHERE id = ?',
    ).run(
      b.name !== undefined ? String(b.name) : String(existing.name ?? ''),
      b.equip !== undefined ? String(b.equip) : String(existing.equip ?? ''),
      b.map_link !== undefined ? String(b.map_link) : String(existing.map_link ?? ''),
      b.place !== undefined ? String(b.place) : String(existing.place ?? ''),
      b.contractor !== undefined ? (b.contractor ? 1 : 0) : Number(existing.contractor ?? 0),
      b.contractor_note !== undefined ? String(b.contractor_note) : String(existing.contractor_note ?? ''),
      crewId,
    );
    if (Array.isArray(b.person_ids)) {
      db.prepare('DELETE FROM crew_members WHERE crew_id = ?').run(crewId);
      const insMem = db.prepare('INSERT OR IGNORE INTO crew_members (crew_id, person_id) VALUES (?, ?)');
      for (const pid of b.person_ids) insMem.run(crewId, Number(pid));
    }
    res.json(getCrewWithMembers(crewId));
  });

  router.delete('/api/crews/:crewId', (req, res) => {
    const crewId = Number(req.params.crewId);
    const db = getDb();
    if (!db.prepare('SELECT id FROM crews WHERE id = ?').get(crewId)) {
      res.status(404).json({ detail: 'Бригада не найдена' });
      return;
    }
    const taskCnt = (db.prepare('SELECT COUNT(*) as c FROM tasks WHERE team = ?').get(crewId) as { c: number }).c;
    if (taskCnt > 0) {
      res.status(400).json({ detail: 'У бригады есть задания — сначала переназначьте или удалите их' });
      return;
    }
    db.prepare('DELETE FROM crews WHERE id = ?').run(crewId);
    res.json({ ok: true });
  });

  router.post('/api/crews/move-tasks', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const taskIds: string[] = Array.isArray(b.task_ids) ? b.task_ids.map(String) : [];
    if (!taskIds.length) {
      res.status(400).json({ detail: 'Не выбраны задания' });
      return;
    }
    const db = getDb();
    const placeholders = taskIds.map(() => '?').join(',');
    const tasks = db.prepare(`SELECT * FROM tasks WHERE id IN (${placeholders})`).all(...taskIds) as Array<
      Record<string, unknown>
    >;

    if (b.to_plan) {
      const insPlan = db.prepare(
        'INSERT INTO point_plans (point_id, description, priority, group_name, work_type, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)',
      );
      const now = nowIso();
      for (const t of tasks) {
        if (t.point) {
          insPlan.run(
            String(t.point),
            String(t.work || t.note || ''),
            t.priority ? 1 : 0,
            String(b.plan_group || ''),
            String(t.type || ''),
            now,
            req.sessionUser?.username || '',
          );
        }
      }
      db.prepare(`DELETE FROM tasks WHERE id IN (${placeholders})`).run(...taskIds);
      const rev = bumpStateRev();
      res.json({ ok: true, moved: tasks.length, rev });
      return;
    }

    let targetCrewId = b.crew_id ? Number(b.crew_id) : null;
    let targetDate = b.date ? String(b.date) : null;
    if (targetCrewId) {
      const crew = db.prepare('SELECT id, date FROM crews WHERE id = ?').get(targetCrewId) as
        | { id: number; date: string }
        | undefined;
      if (!crew) {
        res.status(404).json({ detail: 'Целевая бригада не найдена' });
        return;
      }
      targetDate = crew.date;
    } else if (targetDate) {
      const srcCrew = tasks[0]
        ? (db.prepare('SELECT * FROM crews WHERE id = ?').get(Number(tasks[0].team)) as Record<string, unknown> | undefined)
        : undefined;
      const info = db
        .prepare('INSERT INTO crews (date, name, equip) VALUES (?, ?, ?)')
        .run(targetDate, String(b.new_crew_name || srcCrew?.name || 'Бригада'), String(srcCrew?.equip || 'Лестница'));
      targetCrewId = Number(info.lastInsertRowid);
      if (b.copy_members && srcCrew) {
        const mems = db
          .prepare('SELECT person_id FROM crew_members WHERE crew_id = ?')
          .all(Number(srcCrew.id)) as Array<{ person_id: number }>;
        const insM = db.prepare('INSERT OR IGNORE INTO crew_members (crew_id, person_id) VALUES (?, ?)');
        for (const m of mems) insM.run(targetCrewId, m.person_id);
      }
    } else {
      res.status(400).json({ detail: 'Укажите бригаду или дату' });
      return;
    }

    db.prepare(`UPDATE tasks SET team = ?, date = ? WHERE id IN (${placeholders})`).run(
      targetCrewId,
      targetDate,
      ...taskIds,
    );
    const rev = bumpStateRev();
    res.json({ ok: true, moved: tasks.length, crew_id: targetCrewId, rev });
  });

  router.get('/api/crews/:crewId/move-check', (req, res) => {
    const crewId = Number(req.params.crewId);
    const targetDate = String(req.query.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const db = getDb();
    const crewTasks = db
      .prepare('SELECT id, point FROM tasks WHERE team = ?')
      .all(crewId) as Array<{ id: string; point: string }>;
    const existingOnDay = new Set(
      (db.prepare('SELECT point FROM tasks WHERE date = ?').all(targetDate) as Array<{ point: string }>).map((r) =>
        r.point.trim().toLowerCase(),
      ),
    );
    const duplicates = crewTasks
      .map((t) => t.point)
      .filter((p) => p && existingOnDay.has(p.trim().toLowerCase()));
    res.json({ duplicates, count: crewTasks.length });
  });

  router.post('/api/crews/:crewId/move', (req, res) => {
    const crewId = Number(req.params.crewId);
    const targetDate = String(req.body?.date || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(targetDate)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const db = getDb();
    const crew = db.prepare('SELECT * FROM crews WHERE id = ?').get(crewId);
    if (!crew) {
      res.status(404).json({ detail: 'Бригада не найдена' });
      return;
    }
    db.prepare('UPDATE crews SET date = ? WHERE id = ?').run(targetDate, crewId);
    db.prepare('UPDATE tasks SET date = ? WHERE team = ?').run(targetDate, crewId);
    const rev = bumpStateRev();
    res.json({ ok: true, rev, crew: getCrewWithMembers(crewId) });
  });

  router.post('/api/crews/:crewId/trip', (req, res) => {
    const crewId = Number(req.params.crewId);
    const dateTo = String(req.body?.date_to || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dateTo)) {
      res.status(400).json({ detail: 'Неверная дата' });
      return;
    }
    const db = getDb();
    const crew = db.prepare('SELECT * FROM crews WHERE id = ?').get(crewId) as Record<string, unknown> | undefined;
    if (!crew || crew.trip_id || String(crew.date) > dateTo) {
      res.status(400).json({
        detail:
          'Не удалось оформить командировку — бригада не найдена, уже в командировке, или дата окончания раньше даты начала',
      });
      return;
    }
    const tripId = `trip_${Date.now()}`;
    db.prepare('UPDATE crews SET trip_id = ? WHERE id = ?').run(tripId, crewId);
    const members = db.prepare('SELECT person_id FROM crew_members WHERE crew_id = ?').all(crewId) as Array<{
      person_id: number;
    }>;

    const cur = new Date(`${crew.date}T00:00:00Z`);
    const end = new Date(`${dateTo}T00:00:00Z`);
    cur.setUTCDate(cur.getUTCDate() + 1);
    while (cur <= end) {
      const dStr = cur.toISOString().slice(0, 10);
      const info = db
        .prepare('INSERT INTO crews (date, name, equip, map_link, trip_id, place) VALUES (?, ?, ?, ?, ?, ?)')
        .run(dStr, String(crew.name), String(crew.equip), String(crew.map_link || ''), tripId, String(crew.place || ''));
      const newCid = Number(info.lastInsertRowid);
      const insM = db.prepare('INSERT OR IGNORE INTO crew_members (crew_id, person_id) VALUES (?, ?)');
      for (const m of members) insM.run(newCid, m.person_id);
      cur.setUTCDate(cur.getUTCDate() + 1);
    }
    db.prepare('UPDATE tasks SET trip_id = ?, date_to = ? WHERE team = ?').run(tripId, dateTo, crewId);
    bumpStateRev();
    res.json(getCrewWithMembers(crewId));
  });

  router.delete('/api/crews/:crewId/trip', (req, res) => {
    const crewId = Number(req.params.crewId);
    const db = getDb();
    const crew = db.prepare('SELECT id, trip_id FROM crews WHERE id = ?').get(crewId) as
      | { id: number; trip_id: string | null }
      | undefined;
    if (!crew) {
      res.status(404).json({ detail: 'Бригада не найдена' });
      return;
    }
    if (!crew.trip_id) {
      res.status(400).json({ detail: 'Бригада не в командировке' });
      return;
    }
    db.prepare('UPDATE crews SET trip_id = NULL WHERE trip_id = ?').run(crew.trip_id);
    db.prepare('UPDATE tasks SET trip_id = NULL, date_to = NULL WHERE trip_id = ?').run(crew.trip_id);
    bumpStateRev();
    res.json({ ok: true });
  });

  // ---- PEOPLE ----
  router.get('/api/people', (req, res) => {
    const roleType = typeof req.query.role_type === 'string' ? req.query.role_type : '';
    const activeOnly = req.query.active_only === 'true';
    const where: string[] = [];
    const params: Array<string | number> = [];
    if (roleType) {
      where.push('role_type = ?');
      params.push(roleType);
    }
    if (activeOnly) {
      where.push('active = 1');
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = getDb()
      .prepare(`SELECT * FROM people ${sqlWhere} ORDER BY id`)
      .all(...params) as Array<Record<string, unknown>>;
    res.json(rows.map(mapPerson));
  });

  router.get('/api/people/absent-on/:day', (req, res) => {
    const day = req.params.day;
    const rows = getDb()
      .prepare('SELECT person_id, reason FROM people_absences WHERE start_date <= ? AND end_date >= ?')
      .all(day, day) as Array<{ person_id: number; reason: string | null }>;
    const out: Record<string, string> = {};
    for (const r of rows) out[String(r.person_id)] = r.reason || 'Отсутствует';
    res.json(out);
  });

  router.get('/api/people/:personId/tasks', (req, res) => {
    const personId = Number(req.params.personId);
    const db = getDb();
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId) as Record<string, unknown> | undefined;
    if (!person) {
      res.status(404).json({ detail: 'Сотрудник не найден' });
      return;
    }
    const rows = db
      .prepare(
        `SELECT t.id, t.date, t.date_to, t.point, t.work, t.type, t.address, c.name as crew,
                r.result_status as result, r.outcome, r.comment, r.fault, r.needs, r.created_at as reported_at
         FROM tasks t
         JOIN crew_members cm ON cm.crew_id = t.team AND cm.person_id = ?
         LEFT JOIN crews c ON c.id = t.team
         LEFT JOIN task_visit_reports r ON r.task_id = t.id
         ORDER BY t.date DESC, t.id DESC LIMIT 500`,
      )
      .all(personId);
    res.json({ person: decryptField(String(person.full_name || '')), items: rows });
  });

  router.post('/api/people', (req, res) => {
    const b = req.body || {};
    const fullName = String(b.full_name || '').trim();
    if (!fullName) {
      res.status(400).json({ detail: 'Укажите ФИО' });
      return;
    }
    const db = getDb();
    try {
      const info = db
        .prepare(
          'INSERT INTO people (full_name, phone, role_type, vk_id, active, notes, driver_kind, created_at) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
        )
        .run(
          encryptField(fullName),
          b.phone ? encryptField(String(b.phone).trim()) : null,
          String(b.role_type || 'fitter'),
          b.vk_id ? Number(b.vk_id) : null,
          b.notes ? String(b.notes) : null,
          String(b.driver_kind || ''),
          nowIso(),
        );
      const id = Number(info.lastInsertRowid);
      if (b.vk_id) {
        db.prepare("UPDATE bot_join_requests SET status = 'approved', resolved_at = ? WHERE vk_id = ?").run(
          nowIso(),
          Number(b.vk_id),
        );
      }
      const created = db.prepare('SELECT * FROM people WHERE id = ?').get(id) as Record<string, unknown>;
      res.status(201).json(mapPerson(created));
    } catch {
      res.status(400).json({ detail: 'Этот VK ID уже привязан к другому человеку' });
    }
  });

  router.put('/api/people/:personId', (req, res) => {
    const personId = Number(req.params.personId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM people WHERE id = ?').get(personId) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Не найдено' });
      return;
    }
    const b = req.body || {};
    const fullName = String(b.full_name || '').trim();
    if (!fullName) {
      res.status(400).json({ detail: 'Укажите ФИО' });
      return;
    }
    try {
      db.prepare(
        'UPDATE people SET full_name = ?, phone = ?, role_type = ?, vk_id = ?, active = ?, notes = ?, driver_kind = ? WHERE id = ?',
      ).run(
        encryptField(fullName),
        b.phone ? encryptField(String(b.phone).trim()) : null,
        String(b.role_type || existing.role_type || ''),
        b.vk_id !== undefined ? (b.vk_id ? Number(b.vk_id) : null) : existing.vk_id != null ? Number(existing.vk_id) : null,
        b.active !== undefined ? (b.active ? 1 : 0) : Number(existing.active ?? 1),
        b.notes !== undefined ? (b.notes != null ? String(b.notes) : null) : existing.notes != null ? String(existing.notes) : null,
        b.driver_kind !== undefined ? String(b.driver_kind || '') : String(existing.driver_kind ?? ''),
        personId,
      );
      const updated = db.prepare('SELECT * FROM people WHERE id = ?').get(personId) as Record<string, unknown>;
      res.json(mapPerson(updated));
    } catch {
      res.status(400).json({ detail: 'Этот VK ID уже привязан к другому человеку' });
    }
  });

  router.get('/api/people/:personId/erase-preview', (req, res) => {
    const personId = Number(req.params.personId);
    const db = getDb();
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId) as Record<string, unknown> | undefined;
    if (!person) {
      res.status(404).json({ detail: 'Сотрудник не найден' });
      return;
    }
    const heldEq = (
      db.prepare("SELECT COUNT(*) as c FROM equipment WHERE place = 'person' AND person_id = ?").get(personId) as {
        c: number;
      }
    ).c;
    const crewsCount = (db.prepare('SELECT COUNT(*) as c FROM crew_members WHERE person_id = ?').get(personId) as { c: number }).c;
    const absencesCount = (db.prepare('SELECT COUNT(*) as c FROM people_absences WHERE person_id = ?').get(personId) as { c: number }).c;
    const reportsCount = (
      db.prepare('SELECT COUNT(*) as c FROM task_visit_reports WHERE author_person_id = ?').get(personId) as { c: number }
    ).c;
    res.json({
      person: mapPerson(person),
      blocked: heldEq > 0,
      block_reason: heldEq > 0 ? `У сотрудника числится ${heldEq} ед. оборудования` : '',
      deleted: { crew_members: crewsCount, absences: absencesCount },
      anonymized: { reports: reportsCount },
    });
  });

  router.delete('/api/people/:personId', (req: AuthedRequest, res) => {
    const personId = Number(req.params.personId);
    const db = getDb();
    const person = db.prepare('SELECT * FROM people WHERE id = ?').get(personId);
    if (!person) {
      res.status(404).json({ detail: 'Сотрудник не найден' });
      return;
    }
    const heldEq = (
      db.prepare("SELECT COUNT(*) as c FROM equipment WHERE place = 'person' AND person_id = ?").get(personId) as {
        c: number;
      }
    ).c;
    if (heldEq > 0) {
      res.status(409).json({
        detail: `Невозможно удалить: за сотрудником числится ${heldEq} ед. оборудования. Если человек просто уволился, деактивируйте его вместо удаления.`,
      });
      return;
    }
    const rep = db.prepare("UPDATE task_visit_reports SET author_person_id = NULL, created_by = 'Удалённый сотрудник' WHERE author_person_id = ?").run(personId);
    const del = db.prepare('DELETE FROM people WHERE id = ?').run(personId);
    recordSecurityEvent('person_erase', {
      username: req.sessionUser!.username,
      role: req.sessionUser!.role,
      ip: clientIp(req),
      details: { person_id: personId },
    });
    res.json({ ok: true, deleted: Number(del.changes), anonymized: Number(rep.changes) });
  });

  router.get('/api/people/:personId/absences', (req, res) => {
    const personId = Number(req.params.personId);
    const rows = getDb()
      .prepare('SELECT id, person_id, start_date, end_date, reason, created_at FROM people_absences WHERE person_id = ? ORDER BY start_date DESC')
      .all(personId);
    res.json(rows);
  });

  router.post('/api/people/:personId/absences', (req: AuthedRequest, res) => {
    const personId = Number(req.params.personId);
    const b = req.body || {};
    const db = getDb();
    if (!db.prepare('SELECT id FROM people WHERE id = ?').get(personId)) {
      res.status(404).json({ detail: 'Не найдено' });
      return;
    }
    if (!b.start_date || !b.end_date || b.end_date < b.start_date) {
      res.status(400).json({ detail: 'Некорректный период дат' });
      return;
    }
    const info = db
      .prepare(
        'INSERT INTO people_absences (person_id, start_date, end_date, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(personId, String(b.start_date), String(b.end_date), b.reason || null, req.sessionUser?.username || '', nowIso());
    const created = db.prepare('SELECT * FROM people_absences WHERE id = ?').get(Number(info.lastInsertRowid));
    res.status(201).json(created);
  });

  router.delete('/api/people/:personId/absences/:absenceId', (req, res) => {
    getDb().prepare('DELETE FROM people_absences WHERE id = ? AND person_id = ?').run(Number(req.params.absenceId), Number(req.params.personId));
    res.json({ ok: true });
  });

  // ---- ABSENCES PAGE ----
  router.get('/api/absences/people', (req, res) => {
    const includeInactive = req.query.include_inactive === 'true';
    const rows = getDb()
      .prepare(`SELECT id, full_name, role_type, active FROM people ${includeInactive ? '' : 'WHERE active = 1'} ORDER BY id`)
      .all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => ({
        id: r.id,
        full_name: decryptField(String(r.full_name || '')),
        role_type: r.role_type,
        active: Boolean(r.active),
      })),
    );
  });

  router.get('/api/absences', (req, res) => {
    const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : null;
    const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : null;
    const where: string[] = [];
    const params: string[] = [];
    if (dateFrom) {
      where.push('a.end_date >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push('a.start_date <= ?');
      params.push(dateTo);
    }
    const sqlWhere = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = getDb()
      .prepare(
        `SELECT a.*, p.full_name, p.role_type FROM people_absences a JOIN people p ON p.id = a.person_id ${sqlWhere} ORDER BY a.start_date DESC, a.id DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    res.json(rows.map((r) => ({ ...r, full_name: decryptField(String(r.full_name || '')) })));
  });

  router.get('/api/absences/person/:personId', (req, res) => {
    const rows = getDb()
      .prepare('SELECT * FROM people_absences WHERE person_id = ? ORDER BY start_date DESC, id DESC')
      .all(Number(req.params.personId));
    res.json(rows);
  });

  router.post('/api/absences', (req: AuthedRequest, res) => {
    const b = req.body || {};
    const db = getDb();
    const personId = Number(b.person_id);
    if (!db.prepare('SELECT id FROM people WHERE id = ?').get(personId)) {
      res.status(404).json({ detail: 'Человек не найден' });
      return;
    }
    if (!b.start_date || !b.end_date || b.end_date < b.start_date) {
      res.status(400).json({ detail: 'Дата окончания раньше даты начала' });
      return;
    }
    const reason = String(b.reason || '').trim();
    const same = db
      .prepare('SELECT * FROM people_absences WHERE person_id = ? AND start_date = ? AND end_date = ? AND coalesce(reason, \'\') = ?')
      .get(personId, b.start_date, b.end_date, reason) as Record<string, unknown> | undefined;
    const item =
      same ||
      (() => {
        const info = db
          .prepare(
            'INSERT INTO people_absences (person_id, start_date, end_date, reason, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(personId, b.start_date, b.end_date, reason, req.sessionUser?.username || '', nowIso());
        return db.prepare('SELECT * FROM people_absences WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<
          string,
          unknown
        >;
      })();
    const conflicts = db
      .prepare(
        'SELECT c.id, c.date, c.name FROM crews c JOIN crew_members cm ON cm.crew_id = c.id WHERE cm.person_id = ? AND c.date >= ? AND c.date <= ?',
      )
      .all(personId, b.start_date, b.end_date);
    res.status(201).json({ ...item, duplicate: Boolean(same), conflicts });
  });

  router.put('/api/absences/:absenceId', (req, res) => {
    const id = Number(req.params.absenceId);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM people_absences WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Отсутствие не найдено' });
      return;
    }
    const b = req.body || {};
    if (!b.start_date || !b.end_date || b.end_date < b.start_date) {
      res.status(400).json({ detail: 'Дата окончания раньше даты начала' });
      return;
    }
    db.prepare('UPDATE people_absences SET start_date = ?, end_date = ?, reason = ? WHERE id = ?').run(
      b.start_date,
      b.end_date,
      String(b.reason || '').trim(),
      id,
    );
    const updated = db.prepare('SELECT * FROM people_absences WHERE id = ?').get(id) as Record<string, unknown>;
    const conflicts = db
      .prepare(
        'SELECT c.id, c.date, c.name FROM crews c JOIN crew_members cm ON cm.crew_id = c.id WHERE cm.person_id = ? AND c.date >= ? AND c.date <= ?',
      )
      .all(Number(existing.person_id), b.start_date, b.end_date);
    res.json({ ...updated, conflicts });
  });

  router.delete('/api/absences/:absenceId', (req, res) => {
    const info = getDb().prepare('DELETE FROM people_absences WHERE id = ?').run(Number(req.params.absenceId));
    if (!info.changes) {
      res.status(404).json({ detail: 'Отсутствие не найдено' });
      return;
    }
    res.json({ ok: true });
  });

  // ---- WORK TYPES ----
  router.get('/api/work-types', (_req, res) => {
    const db = getDb();
    const rows = db.prepare('SELECT name, is_repair, bot_tools, sort_order FROM work_types ORDER BY sort_order, name').all() as Array<{
      name: string;
      is_repair: number;
      bot_tools: number;
      sort_order: number;
    }>;
    const outcomesRows = db.prepare('SELECT type_name, label FROM work_type_outcomes ORDER BY sort_order, id').all() as Array<{
      type_name: string;
      label: string;
    }>;
    const outMap: Record<string, string[]> = {};
    for (const o of outcomesRows) {
      (outMap[o.type_name] ||= []).push(o.label);
    }
    res.json(
      rows.map((r) => ({
        name: r.name,
        is_repair: Boolean(r.is_repair),
        bot_tools: Boolean(r.bot_tools),
        outcomes: outMap[r.name] || [],
      })),
    );
  });

  router.post('/api/work-types', (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ detail: 'Укажите название типа' });
      return;
    }
    const db = getDb();
    if (db.prepare('SELECT name FROM work_types WHERE name = ?').get(name)) {
      res.status(400).json({ detail: 'Такой тип уже существует' });
      return;
    }
    const maxSort = (db.prepare('SELECT coalesce(max(sort_order), 0) as m FROM work_types').get() as { m: number }).m;
    db.prepare('INSERT INTO work_types (name, is_repair, bot_tools, sort_order) VALUES (?, ?, ?, ?)').run(
      name,
      req.body?.is_repair ? 1 : 0,
      req.body?.bot_tools ? 1 : 0,
      maxSort + 1,
    );
    res.status(201).json({
      name,
      is_repair: Boolean(req.body?.is_repair),
      bot_tools: Boolean(req.body?.bot_tools),
      outcomes: [],
    });
  });

  router.put('/api/work-types/:name', (req, res) => {
    const oldName = decodeURIComponent(req.params.name);
    const db = getDb();
    const existing = db.prepare('SELECT * FROM work_types WHERE name = ?').get(oldName) as
      | { name: string; is_repair: number; bot_tools: number }
      | undefined;
    if (!existing) {
      res.status(404).json({ detail: 'Тип выезда не найден' });
      return;
    }
    const newName = String(req.body?.name || oldName).trim();
    const isRepair = req.body?.is_repair !== undefined ? (req.body.is_repair ? 1 : 0) : existing.is_repair;
    const botTools = req.body?.bot_tools !== undefined ? (req.body.bot_tools ? 1 : 0) : existing.bot_tools;
    db.prepare('UPDATE work_types SET name = ?, is_repair = ?, bot_tools = ? WHERE name = ?').run(
      newName,
      isRepair,
      botTools,
      oldName,
    );
    if (newName !== oldName) {
      db.prepare('UPDATE work_type_outcomes SET type_name = ? WHERE type_name = ?').run(newName, oldName);
      db.prepare('UPDATE tasks SET type = ? WHERE type = ?').run(newName, oldName);
    }
    res.json({ name: newName, is_repair: Boolean(isRepair), bot_tools: Boolean(botTools) });
  });

  router.put('/api/work-types/:name/outcomes', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const labels: string[] = Array.isArray(req.body?.outcomes) ? req.body.outcomes.map((x: unknown) => String(x).trim()).filter(Boolean) : [];
    const db = getDb();
    db.prepare('DELETE FROM work_type_outcomes WHERE type_name = ?').run(name);
    const ins = db.prepare('INSERT INTO work_type_outcomes (type_name, label, sort_order) VALUES (?, ?, ?)');
    labels.forEach((lbl, idx) => ins.run(name, lbl, idx + 1));
    res.json({ name, outcomes: labels });
  });

  router.delete('/api/work-types/:name', (req, res) => {
    const name = decodeURIComponent(req.params.name);
    const db = getDb();
    db.prepare('DELETE FROM work_type_outcomes WHERE type_name = ?').run(name);
    db.prepare('DELETE FROM work_types WHERE name = ?').run(name);
    res.json({ ok: true });
  });

  return router;
}
