import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import multer from 'multer';
import { requirePasswordOk, requirePerm, type AuthedRequest } from '../auth.ts';
import { REPORT_TEMPLATES_DIR, settings } from '../config.ts';
import { decryptField } from '../crypto.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { networkOk, secretsOk } from '../permissions.ts';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

const DAILY_REPORT_FIELDS = [
  { key: 'responsible_name', label: 'Ответственный сотрудник (ФИО)', group: 'Ответственный', computed: false, type: 'text' },
  { key: 'responsible_phone', label: 'Телефон ответственного сотрудника', group: 'Ответственный', computed: false, type: 'text' },
  { key: 'staff_total', label: '1.1 Сотрудников по штату, всего', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'staff_listed', label: 'Сотрудников по списку, всего', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'staff_vacation', label: 'В отпуске, всего', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'staff_sick', label: 'На больничном, всего', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'staff_involved_total', label: '1.2 Задействовано работников, чел.', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'staff_involved_mgmt', label: 'из них управление, чел.', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'staff_involved_electricians', label: 'из них электромонтёры, чел. (по назначенным на сегодня бригадам)', group: '1. Списочный состав', computed: true, type: 'number' },
  { key: 'staff_involved_drivers', label: 'из них водители, чел. (по назначенным на сегодня бригадам)', group: '1. Списочный состав', computed: true, type: 'number' },
  { key: 'vehicles_total', label: '1.3 Задействовано транспортных средств, ед.', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'vehicles_lifts', label: 'из них автогидроподъёмники', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'vehicles_cover', label: 'из них машины прикрытия', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'vehicles_photo', label: 'из них машины фотовидеофиксации', group: '1. Списочный состав', computed: false, type: 'number' },
  { key: 'restored_onsite', label: '2.1 Восстановлено АПК ФВФ на месте, шт', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'serviced_onsite', label: '2.2 Обслужено АПК ФВФ на месте, шт', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'removed_for_repair', label: '2.3 Снято на ремонт (АПК, комплектующие), шт', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'restored_after_removal', label: '2.4 Восстановлено после снятия на ремонт, шт', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'tasks_total', label: '2.5 Заданий выездных бригад за сутки, шт — всего', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'tasks_done', label: 'из них выполнено', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'tasks_not_done', label: 'из них не выполнено', group: '2. Обслуживание АПК ФВФ', computed: true, type: 'number' },
  { key: 'solar_total', label: '3. АПК с солнечными панелями, шт — всего', group: '3. Солнечные панели', computed: false, type: 'number' },
  { key: 'solar_working', label: 'из них работают', group: '3. Солнечные панели', computed: false, type: 'number' },
  { key: 'solar_planned_repair', label: 'планируются ремонтные работы', group: '3. Солнечные панели', computed: false, type: 'number' },
  { key: 'modems_new', label: '4. Модемы, шт — новые, на складе', group: '4. Модемы', computed: false, type: 'number' },
  { key: 'modems_working', label: 'работающие, на складе', group: '4. Модемы', computed: false, type: 'number' },
  { key: 'modems_broken', label: 'не работающие, на складе', group: '4. Модемы', computed: false, type: 'number' },
  { key: 'crews_count', label: '5. Кол-во бригад', group: '5. Бригады', computed: true, type: 'number' },
];

const PLAN_TEMPLATE_FIELDS = [
  { key: 'plan_title', label: 'Заголовок бланка. Можно {число} {месяц} {год} {дата} — подставятся из даты плана', group: '', computed: false, type: 'text' },
  { key: 'org_title', label: 'Заголовок организации (кем утверждён план-наряд)', group: '', computed: false, type: 'textarea' },
  { key: 'approver_name', label: 'Утверждающий (ФИО)', group: '', computed: false, type: 'text' },
  { key: 'route_label', label: 'Маршрут по умолчанию', group: '', computed: false, type: 'text' },
  { key: 'safety_officer', label: 'Проводивший инструктаж по ТБ', group: '', computed: false, type: 'text' },
  { key: 'second_approver_title', label: 'Согласующий — должность', group: '', computed: false, type: 'textarea' },
  { key: 'second_approver_name', label: 'Согласующий — ФИО', group: '', computed: false, type: 'text' },
  { key: 'plan_title_size_pt', label: 'Размер заголовка, пунктов (12–24)', group: 'Оформление', computed: false, type: 'number' },
  { key: 'plan_header_shift_mm', label: 'Сдвиг шапки вверх/вниз, мм (от −15 до 15)', group: 'Оформление', computed: false, type: 'number' },
  { key: 'plan_title_align', label: 'Выравнивание заголовка: left, center или right', group: 'Оформление', computed: false, type: 'text' },
];

const TEMPLATE_VARIABLES = [
  { key: 'date', label: 'Дата — только если период состоит из одного дня', group: 'Период' },
  { key: 'date_from', label: 'Начало периода', group: 'Период' },
  { key: 'date_to', label: 'Конец периода', group: 'Период' },
  { key: 'period_label', label: 'Период одной строкой', group: 'Период' },
  { key: 'text_report', label: 'Готовый текстовый отчёт целиком', group: 'Период' },
  { key: 'total_assigned', label: 'Заданий назначено за период, всего', group: 'Период' },
  { key: 'total_reported', label: 'Заданий выполнено за период, всего', group: 'Период' },
  { key: 'total_not_done', label: 'Заданий не выполнено за период', group: 'Период' },
  { key: 'total_restored', label: 'Восстановлено за период', group: 'Период' },
  { key: 'total_dismantled', label: 'Демонтировано за период', group: 'Период' },
  { key: 'total_installed', label: 'Установлено за период', group: 'Период' },
  { key: 'total_not_working', label: 'Осталось неисправно за период', group: 'Период' },
  { key: 'crews_active', label: 'Бригад работало за период', group: 'Период' },
  { key: 'row.index', label: '№ по порядку', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.date', label: 'Дата', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.crew', label: 'Бригада', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.members', label: 'Состав бригады', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.assigned', label: 'Назначено заданий', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.reported', label: 'Сдано отчётов', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.not_done', label: 'Не выполнено', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.restored', label: 'Восстановлено', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.dismantled', label: 'Демонтировано', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.installed', label: 'Установлено', group: 'Повторяющаяся строка таблицы' },
  { key: 'row.not_working', label: 'Осталось неисправно', group: 'Повторяющаяся строка таблицы' },
];

function formatDateRu(iso: string): string {
  const p = iso.split('-');
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : iso;
}

function crewBreakdown(dateFrom: string, dateTo: string) {
  const db = getDb();
  const crews = db
    .prepare('SELECT id, date, name FROM crews WHERE date >= ? AND date <= ? ORDER BY date, id')
    .all(dateFrom, dateTo) as Array<{ id: number; date: string; name: string }>;

  return crews.map((c) => {
    const members = db
      .prepare('SELECT p.full_name FROM crew_members cm JOIN people p ON p.id = cm.person_id WHERE cm.crew_id = ?')
      .all(c.id) as Array<{ full_name: string }>;
    const tasks = db
      .prepare("SELECT id, type FROM tasks WHERE date = ? AND team = ? AND type != 'Вспомогательная точка'")
      .all(c.date, c.id) as Array<{ id: string; type: string }>;
    let reported = 0;
    let restored = 0;
    let dismantled = 0;
    let installed = 0;
    let notWorking = 0;
    for (const t of tasks) {
      const rep = db.prepare('SELECT result_status FROM task_visit_reports WHERE task_id = ?').get(t.id) as
        | { result_status: string }
        | undefined;
      if (rep) {
        reported += 1;
        if (rep.result_status === 'Работает') restored += 1;
        else if (rep.result_status === 'Демонтирован') dismantled += 1;
        else if (rep.result_status === 'Установлен') installed += 1;
        else if (rep.result_status === 'Не работает' || rep.result_status === 'Нет питания') notWorking += 1;
      }
    }
    return {
      date: c.date,
      crew_id: c.id,
      crew: c.name || `Бригада ${c.id}`,
      members: members.map((m) => decryptField(m.full_name)).join(', '),
      assigned: tasks.length,
      reported,
      not_done: Math.max(0, tasks.length - reported),
      restored,
      dismantled,
      installed,
      not_working: notWorking,
    };
  });
}

function escapeXml(s: string): string {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function createReportsRouter(): Router {
  const router = Router();
  router.use('/api/task-visit-reports', requirePasswordOk);
  router.use('/api/visit-history', requirePasswordOk);
  router.use('/api/reports', requirePasswordOk);
  router.use('/api/report-templates', requirePasswordOk);
  router.use('/api/report-designs', requirePasswordOk);
  router.use('/api/excel', requirePasswordOk);
  router.use('/api/kml', requirePasswordOk);
  router.use('/api/pautina', requirePasswordOk);
  router.use('/api/forms-import', requirePasswordOk);
  router.use('/api/forms-auto', requirePasswordOk);

  // ---- TASK VISIT REPORTS ----
  router.get('/api/task-visit-reports/export', async (req, res) => {
    const db = getDb();
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const where: string[] = [];
    const params: string[] = [];
    if (dateFrom) {
      where.push('substr(r.created_at, 1, 10) >= ?');
      params.push(dateFrom);
    }
    if (dateTo) {
      where.push('substr(r.created_at, 1, 10) <= ?');
      params.push(dateTo);
    }
    const rows = db
      .prepare(
        `SELECT r.*, p.address FROM task_visit_reports r LEFT JOIN points p ON p.id = r.point_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY r.created_at DESC`,
      )
      .all(...params) as Array<Record<string, unknown>>;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Отчёты');
    ws.addRow(['Дата', 'Комплекс', 'Адрес', 'Тип выезда', 'Статус', 'Итог', 'Неисправность', 'Что нужно', 'Комментарий', 'Автор']);
    for (const r of rows) {
      ws.addRow([
        String(r.created_at || '').slice(0, 10),
        r.point_id,
        r.address || '',
        r.visit_type,
        r.result_status,
        r.outcome,
        r.fault || '',
        r.needs || '',
        r.comment || '',
        r.created_by || '',
      ]);
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="visit-reports.xlsx"');
    res.send(Buffer.from(buf));
  });

  router.get('/api/task-visit-reports/archive', (req, res) => {
    const limit = Math.min(500, Number(req.query.limit || 200));
    const offset = Math.max(0, Number(req.query.offset || 0));
    const search = String(req.query.search || '').trim().toLowerCase();
    const db = getDb();
    let rows = db
      .prepare(
        `SELECT r.*, p.address FROM task_visit_reports r LEFT JOIN points p ON p.id = r.point_id ORDER BY r.created_at DESC LIMIT 2000`,
      )
      .all() as Array<Record<string, unknown>>;
    if (search) {
      rows = rows.filter((r) =>
        [r.point_id, r.address, r.visit_type, r.result_status, r.outcome, r.comment, r.fault]
          .some((v) => String(v || '').toLowerCase().includes(search)),
      );
    }
    res.json({ items: rows.slice(offset, offset + limit).map((r) => ({ ...r, imported: Boolean(r.imported) })), total: rows.length });
  });

  router.get('/api/task-visit-reports/point-equipment/:pointId', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const items = getDb()
      .prepare(
        `SELECT e.id, e.serial_number, m.name as model_name, c.name as category_name, c.kind as category_kind
         FROM equipment e
         LEFT JOIN equipment_models m ON m.id = e.model_id
         LEFT JOIN equipment_categories c ON c.id = m.category_id
         WHERE e.place = 'point' AND e.point_id = ?`,
      )
      .all(pointId) as Array<Record<string, unknown>>;
    res.json(items.map((i) => ({ ...i, label: `${i.category_name || ''} ${i.model_name || ''} (${i.serial_number})`.trim() })));
  });

  router.get('/api/task-visit-reports/point-state/:pointId', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const p = getDb().prepare('SELECT id, status, power_source, fault_reason, fault_need FROM points WHERE id = ?').get(pointId);
    res.json(p || null);
  });

  router.get('/api/task-visit-reports/by-point/:pointId', (req, res) => {
    const pointId = decodeURIComponent(req.params.pointId);
    const rows = getDb()
      .prepare('SELECT * FROM task_visit_reports WHERE point_id = ? ORDER BY created_at DESC')
      .all(pointId)
      .map((r: Record<string, unknown>) => ({ ...r, imported: Boolean(r.imported) }));
    res.json(rows);
  });

  router.get('/api/task-visit-reports/:taskId/context', (req, res) => {
    const taskId = req.params.taskId;
    const db = getDb();
    const task = db.prepare('SELECT id, date, team, point, work, address, type FROM tasks WHERE id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    if (!task) {
      res.status(404).json({ detail: 'Задание не найдено' });
      return;
    }
    const point = task.point ? (db.prepare('SELECT * FROM points WHERE id = ?').get(String(task.point)) as Record<string, unknown> | undefined) : undefined;
    const crew = task.team ? (db.prepare('SELECT id, name FROM crews WHERE id = ?').get(Number(task.team)) as { id: number; name: string } | undefined) : undefined;
    const crewMembers = task.team
      ? (db.prepare('SELECT person_id FROM crew_members WHERE crew_id = ?').all(Number(task.team)) as Array<{ person_id: number }>)
      : [];
    const people = (
      db.prepare('SELECT id, full_name, role_type FROM people WHERE active = 1 ORDER BY id').all() as Array<Record<string, unknown>>
    ).map((p) => ({ id: p.id, full_name: decryptField(String(p.full_name || '')), role_type: p.role_type }));
    const report = db.prepare('SELECT * FROM task_visit_reports WHERE task_id = ?').get(taskId) as Record<string, unknown> | undefined;

    res.json({
      task: { ...task, is_aux: task.type === 'Вспомогательная точка', crew_name: crew?.name || '' },
      point: {
        id: point?.id || task.point,
        address: point?.address || task.address || '',
        power_source: point?.power_source || '',
        status: point?.status || '',
        sim_number: point?.sim_number || '',
      },
      crew_member_ids: crewMembers.map((m) => m.person_id),
      people,
      report: report ? { ...report, imported: Boolean(report.imported) } : null,
    });
  });

  router.get('/api/task-visit-reports/:taskId', (req, res) => {
    const row = getDb().prepare('SELECT * FROM task_visit_reports WHERE task_id = ?').get(req.params.taskId) as
      | Record<string, unknown>
      | undefined;
    res.json(row ? { ...row, imported: Boolean(row.imported) } : null);
  });

  router.put('/api/task-visit-reports/:taskId', (req: AuthedRequest, res) => {
    const taskId = req.params.taskId;
    const db = getDb();
    const task = db.prepare('SELECT id, point, type FROM tasks WHERE id = ?').get(taskId) as
      | { id: string; point: string; type: string }
      | undefined;
    if (!task) {
      res.status(404).json({ detail: 'Задание не найдено' });
      return;
    }
    const b = req.body || {};
    const existing = db.prepare('SELECT * FROM task_visit_reports WHERE task_id = ?').get(taskId) as
      | Record<string, unknown>
      | undefined;
    const now = b.created_at ? String(b.created_at) : nowIso();
    const visitType = String(b.visit_type || existing?.visit_type || task.type || 'Ремонт');
    const resultStatus = String(b.result_status || '');
    const outcome = String(b.outcome || '');
    const authorId = b.author_person_id ? Number(b.author_person_id) : existing?.author_person_id != null ? Number(existing.author_person_id) : null;
    let authorName = existing?.created_by ? String(existing.created_by) : req.sessionUser?.username || '';
    if (authorId) {
      const pRow = db.prepare('SELECT full_name FROM people WHERE id = ?').get(Number(authorId)) as { full_name: string } | undefined;
      if (pRow) authorName = decryptField(pRow.full_name);
    }

    const optStr = (val: unknown, fallback: unknown = null): string | null =>
      val !== undefined ? (val != null ? String(val) : null) : fallback != null ? String(fallback) : null;

    if (existing) {
      db.prepare(
        `UPDATE task_visit_reports SET visit_type=?, result_status=?, comment=?, equipment_removed=?, equipment_installed=?,
         outcome=?, fault=?, needs=?, author_person_id=?, updated_by=?, sim_removed=?, sim_installed=?, sim_removed_state=?, updated_at=?
         WHERE task_id=?`,
      ).run(
        visitType,
        resultStatus,
        String(b.comment || ''),
        optStr(b.equipment_removed, existing.equipment_removed),
        optStr(b.equipment_installed, existing.equipment_installed),
        outcome,
        optStr(b.fault, existing.fault),
        optStr(b.needs, existing.needs),
        authorId,
        req.sessionUser?.username || '',
        optStr(b.sim_removed, existing.sim_removed),
        optStr(b.sim_installed, existing.sim_installed),
        String(b.sim_removed_state ?? existing.sim_removed_state ?? ''),
        nowIso(),
        taskId,
      );
    } else {
      db.prepare(
        `INSERT INTO task_visit_reports (task_id, point_id, visit_type, result_status, comment, equipment_removed, equipment_installed,
         outcome, fault, needs, author_person_id, updated_by, sim_removed, sim_installed, sim_removed_state, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taskId,
        String(task.point ?? ''),
        visitType,
        resultStatus,
        String(b.comment || ''),
        b.equipment_removed != null ? String(b.equipment_removed) : null,
        b.equipment_installed != null ? String(b.equipment_installed) : null,
        outcome,
        b.fault != null ? String(b.fault) : null,
        b.needs != null ? String(b.needs) : null,
        authorId,
        req.sessionUser?.username || '',
        b.sim_removed != null ? String(b.sim_removed) : null,
        b.sim_installed != null ? String(b.sim_installed) : null,
        String(b.sim_removed_state || ''),
        now,
        nowIso(),
        authorName,
      );
    }

    if (resultStatus && task.point) {
      const pRow = db.prepare('SELECT status FROM points WHERE id = ?').get(task.point) as { status: string } | undefined;
      if (pRow && pRow.status !== resultStatus) {
        db.prepare('UPDATE points SET status = ? WHERE id = ?').run(resultStatus, task.point);
        db.prepare('INSERT INTO point_status_history (point_id, old_status, new_status, source, task_id, changed_at) VALUES (?, ?, ?, ?, ?, ?)').run(
          task.point,
          pRow.status,
          resultStatus,
          'visit_report',
          taskId,
          nowIso(),
        );
      }
      if (resultStatus === 'Не работает') {
        db.prepare('UPDATE points SET fault_reason=?, fault_need=?, fault_at=?, fault_by=? WHERE id=?').run(
          String(b.fault || ''),
          String(b.needs || ''),
          nowIso(),
          authorName,
          task.point,
        );
      } else if (resultStatus === 'Работает') {
        db.prepare("UPDATE points SET fault_reason='', fault_need='', fault_at='', fault_by='' WHERE id=?").run(task.point);
      }
    }

    if (b.power_source !== undefined && task.point) {
      db.prepare('UPDATE points SET power_source = ? WHERE id = ?').run(String(b.power_source || ''), task.point);
    }

    bumpStateRev();
    const saved = db.prepare('SELECT * FROM task_visit_reports WHERE task_id = ?').get(taskId) as Record<string, unknown>;
    res.json({ ...saved, imported: Boolean(saved.imported) });
  });

  router.put('/api/task-visit-reports/:taskId/visit-type', (req, res) => {
    const taskId = req.params.taskId;
    const vt = String(req.body?.visit_type || '').trim();
    if (!vt) {
      res.status(400).json({ detail: 'Укажите тип выезда' });
      return;
    }
    getDb().prepare('UPDATE task_visit_reports SET visit_type = ?, updated_at = ? WHERE task_id = ?').run(vt, nowIso(), taskId);
    const saved = getDb().prepare('SELECT * FROM task_visit_reports WHERE task_id = ?').get(taskId);
    res.json(saved || { ok: true });
  });

  // ---- VISIT HISTORY ----
  router.get('/api/visit-history/template', async (_req, res) => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('История выездов');
    ws.addRow(['Дата', 'Комплекс', 'Тип выезда', 'Результат', 'Комментарий', 'Исполнитель']);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="visit-history-template.xlsx"');
    res.send(Buffer.from(buf));
  });

  router.post('/api/visit-history/import', upload.single('file'), async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    const batch = `imp_${Date.now()}`;
    const ins = getDb().prepare(
      `INSERT INTO task_visit_reports (task_id, point_id, visit_type, result_status, comment, imported, import_batch, created_at, updated_at, created_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
    );
    let added = 0;
    const now = nowIso();
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const dateStr = String(row.getCell(1).value || now.slice(0, 10)).slice(0, 10);
      const pointId = String(row.getCell(2).value || '').trim();
      if (!pointId) return;
      ins.run(
        `imp-${batch}-${idx}`,
        pointId,
        String(row.getCell(3).value || 'ТО').trim(),
        String(row.getCell(4).value || '').trim(),
        String(row.getCell(5).value || '').trim(),
        batch,
        `${dateStr}T12:00:00Z`,
        now,
        String(row.getCell(6).value || req.sessionUser?.username || ''),
      );
      added += 1;
    });
    res.json({ ok: true, batch, added });
  });

  router.get('/api/visit-history/batches', (_req, res) => {
    const rows = getDb()
      .prepare(
        "SELECT import_batch as batch, COUNT(*) as count, MIN(created_at) as first_at FROM task_visit_reports WHERE imported = 1 AND import_batch != '' GROUP BY import_batch ORDER BY first_at DESC",
      )
      .all();
    res.json(rows);
  });

  router.delete('/api/visit-history/batches/:batch', (req, res) => {
    getDb().prepare('DELETE FROM task_visit_reports WHERE imported = 1 AND import_batch = ?').run(req.params.batch);
    res.json({ ok: true });
  });

  router.delete('/api/visit-history/:taskId', (req, res) => {
    getDb().prepare('DELETE FROM task_visit_reports WHERE task_id = ?').run(req.params.taskId);
    res.json({ ok: true });
  });

  // ---- REPORTS (/api/reports/*) ----
  router.get('/api/reports/text', (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const rows = crewBreakdown(dateFrom, dateTo);
    const lines: string[] = [`Сводка выездов за ${formatDateRu(dateFrom)} — ${formatDateRu(dateTo)}`, ''];
    for (const r of rows) {
      lines.push(
        `${formatDateRu(r.date)} | ${r.crew} (${r.members || 'без состава'}): назначено ${r.assigned}, сдано ${r.reported}, восстановлено ${r.restored}, неисправно ${r.not_working}`,
      );
    }
    res.json({ text: lines.join('\n') });
  });

  router.get('/api/reports/crew-summary/export', async (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const rows = crewBreakdown(dateFrom, dateTo);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Свод по бригадам');
    ws.addRow(['Дата', 'Бригада', 'Состав', 'Назначено', 'Сдано отчётов', 'Не выполнено', 'Восстановлено', 'Демонтировано', 'Установлено', 'Неисправно']);
    for (const r of rows) {
      ws.addRow([r.date, r.crew, r.members, r.assigned, r.reported, r.not_done, r.restored, r.dismantled, r.installed, r.not_working]);
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="crew-summary-${dateFrom}_${dateTo}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  router.get('/api/reports/daily/:day', (req, res) => {
    const day = req.params.day;
    const db = getDb();
    const rows = crewBreakdown(day, day);
    const crewsCount = rows.length;
    const tasksTotal = rows.reduce((s, r) => s + r.assigned, 0);
    const tasksDone = rows.reduce((s, r) => s + r.reported, 0);
    const restored = rows.reduce((s, r) => s + r.restored, 0);
    const dismantled = rows.reduce((s, r) => s + r.dismantled, 0);

    const crewIds = (db.prepare('SELECT id FROM crews WHERE date = ?').all(day) as Array<{ id: number }>).map((c) => c.id);
    let elec = 0;
    let drv = 0;
    if (crewIds.length) {
      const mems = db
        .prepare(
          `SELECT DISTINCT p.id, p.role_type FROM crew_members cm JOIN people p ON p.id = cm.person_id WHERE cm.crew_id IN (${crewIds.map(() => '?').join(',')})`,
        )
        .all(...crewIds) as Array<{ id: number; role_type: string }>;
      elec = mems.filter((m) => m.role_type === 'fitter').length;
      drv = mems.filter((m) => m.role_type === 'driver').length;
    }

    const computed: Record<string, number> = {
      staff_involved_electricians: elec,
      staff_involved_drivers: drv,
      restored_onsite: restored,
      serviced_onsite: tasksDone,
      removed_for_repair: dismantled,
      restored_after_removal: 0,
      tasks_total: tasksTotal,
      tasks_done: tasksDone,
      tasks_not_done: Math.max(0, tasksTotal - tasksDone),
      crews_count: crewsCount,
    };

    const manualRows = db
      .prepare("SELECT field_key, value FROM report_field_values WHERE report_type = 'daily_report' AND period = ?")
      .all(day) as Array<{ field_key: string; value: string }>;
    const manual: Record<string, string> = {};
    for (const r of manualRows) manual[r.field_key] = r.value;

    res.json({ fields: DAILY_REPORT_FIELDS, computed, manual });
  });

  router.put('/api/reports/daily/:day', (req: AuthedRequest, res) => {
    const day = req.params.day;
    const values: Record<string, string> = req.body?.values || {};
    const db = getDb();
    const upsert = db.prepare(
      `INSERT INTO report_field_values (report_type, period, field_key, value, updated_at, updated_by) VALUES ('daily_report', ?, ?, ?, ?, ?)
       ON CONFLICT(report_type, period, field_key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    );
    const now = nowIso();
    for (const [k, v] of Object.entries(values)) {
      upsert.run(day, k, String(v || ''), now, req.sessionUser?.username || '');
    }
    res.json({ ok: true });
  });

  router.get('/api/reports/daily/:day/export', async (req, res) => {
    const day = req.params.day;
    const db = getDb();
    const manualRows = db
      .prepare("SELECT field_key, value FROM report_field_values WHERE report_type = 'daily_report' AND period = ?")
      .all(day) as Array<{ field_key: string; value: string }>;
    const manual = new Map(manualRows.map((r) => [r.field_key, r.value]));
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Ежедневный отчёт');
    ws.addRow(['Показатель', 'Значение']);
    for (const f of DAILY_REPORT_FIELDS) {
      ws.addRow([f.label, manual.get(f.key) || '0']);
    }
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="daily-report-${day}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  router.get('/api/reports/plan-template', (_req, res) => {
    const rows = getDb()
      .prepare("SELECT field_key, value FROM report_field_values WHERE report_type = 'plan_template' AND period = 'global'")
      .all() as Array<{ field_key: string; value: string }>;
    const values: Record<string, string> = {
      plan_title: 'ПЛАН ЗАДАНИЕ № _____ от «____» _______________ {год} г.',
      org_title: settings.planOrgTitle,
      approver_name: settings.planApproverName,
      route_label: settings.planRouteLabel,
      safety_officer: settings.planSafetyOfficer,
      second_approver_title: settings.planSecondApproverTitle,
      second_approver_name: settings.planSecondApproverName,
      plan_title_size_pt: '15',
      plan_header_shift_mm: '0',
      plan_title_align: 'center',
    };
    for (const r of rows) values[r.field_key] = r.value;
    res.json({ fields: PLAN_TEMPLATE_FIELDS, values });
  });

  router.put('/api/reports/plan-template', (req: AuthedRequest, res) => {
    const values: Record<string, string> = req.body?.values || {};
    const upsert = getDb().prepare(
      `INSERT INTO report_field_values (report_type, period, field_key, value, updated_at, updated_by) VALUES ('plan_template', 'global', ?, ?, ?, ?)
       ON CONFLICT(report_type, period, field_key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by`,
    );
    const now = nowIso();
    for (const [k, v] of Object.entries(values)) {
      upsert.run(k, String(v ?? ''), now, req.sessionUser?.username || '');
    }
    res.json({ ok: true });
  });

  // ---- REPORT TEMPLATES & DESIGNS ----
  router.get('/api/report-templates/variables', (_req, res) => {
    res.json(TEMPLATE_VARIABLES);
  });

  router.get('/api/report-templates/users', (_req, res) => {
    res.json(getDb().prepare('SELECT id, username, role FROM users ORDER BY username').all());
  });

  router.get('/api/report-templates', (_req, res) => {
    const rows = getDb().prepare('SELECT * FROM report_templates ORDER BY id DESC').all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => ({
        ...r,
        variables: JSON.parse(String(r.variables || '[]')),
        shared_users: JSON.parse(String(r.shared_users || '[]')),
      })),
    );
  });

  router.post('/api/report-templates', upload.single('file'), (req: AuthedRequest, res) => {
    const name = String(req.body?.name || req.file?.originalname || 'Шаблон').trim();
    const fileType = path.extname(req.file?.originalname || '.xlsx').replace('.', '') || 'xlsx';
    const info = getDb()
      .prepare('INSERT INTO report_templates (name, file_type, mode, variables, visibility, shared_users, created_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name, fileType, String(req.body?.mode || 'period'), '[]', 'public', '[]', nowIso(), req.sessionUser?.username || '');
    const id = Number(info.lastInsertRowid);
    if (req.file) {
      fs.writeFileSync(path.join(REPORT_TEMPLATES_DIR, `${id}.${fileType}`), req.file.buffer);
    }
    res.status(201).json(getDb().prepare('SELECT * FROM report_templates WHERE id = ?').get(id));
  });

  router.put('/api/report-templates/:id/access', (req, res) => {
    getDb()
      .prepare('UPDATE report_templates SET visibility = ?, shared_users = ? WHERE id = ?')
      .run(String(req.body?.visibility || 'public'), JSON.stringify(req.body?.shared_users || []), Number(req.params.id));
    res.json({ ok: true });
  });

  router.put('/api/report-templates/:id', (req, res) => {
    getDb()
      .prepare('UPDATE report_templates SET name = ? WHERE id = ?')
      .run(String(req.body?.name || 'Шаблон'), Number(req.params.id));
    res.json({ ok: true });
  });

  router.delete('/api/report-templates/:id', (req, res) => {
    getDb().prepare('DELETE FROM report_templates WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.get('/api/report-templates/:id/generate', async (req, res) => {
    const dateFrom = String(req.query.date_from || new Date().toISOString().slice(0, 10));
    const dateTo = String(req.query.date_to || dateFrom);
    const rows = crewBreakdown(dateFrom, dateTo);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Отчёт');
    ws.addRow(['Дата', 'Бригада', 'Состав', 'Назначено', 'Сдано', 'Восстановлено']);
    for (const r of rows) ws.addRow([r.date, r.crew, r.members, r.assigned, r.reported, r.restored]);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="report-${dateFrom}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  router.get('/api/report-designs/users', (_req, res) => {
    res.json(getDb().prepare('SELECT id, username, role FROM users ORDER BY username').all());
  });

  router.get('/api/report-designs/variables', (_req, res) => {
    res.json(TEMPLATE_VARIABLES);
  });

  router.get('/api/report-designs', (_req, res) => {
    const rows = getDb().prepare('SELECT * FROM report_designs ORDER BY id DESC').all() as Array<Record<string, unknown>>;
    res.json(
      rows.map((r) => ({
        ...r,
        design: JSON.parse(String(r.design || '{}')),
        shared_users: JSON.parse(String(r.shared_users || '[]')),
      })),
    );
  });

  router.post('/api/report-designs', (req: AuthedRequest, res) => {
    const now = nowIso();
    const info = getDb()
      .prepare('INSERT INTO report_designs (name, format, design, visibility, shared_users, created_at, updated_at, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(
        String(req.body?.name || 'Новый макет'),
        String(req.body?.format || 'xlsx'),
        JSON.stringify(req.body?.design || {}),
        String(req.body?.visibility || 'public'),
        JSON.stringify(req.body?.shared_users || []),
        now,
        now,
        req.sessionUser?.username || '',
      );
    const row = getDb().prepare('SELECT * FROM report_designs WHERE id = ?').get(Number(info.lastInsertRowid)) as Record<string, unknown>;
    res.status(201).json({ ...row, design: JSON.parse(String(row.design || '{}')), shared_users: JSON.parse(String(row.shared_users || '[]')) });
  });

  router.post('/api/report-designs/preview', (req, res) => {
    const dateFrom = String(req.body?.date_from || new Date().toISOString().slice(0, 10));
    const dateTo = String(req.body?.date_to || dateFrom);
    res.json({ rows: crewBreakdown(dateFrom, dateTo) });
  });

  router.put('/api/report-designs/:id/access', (req, res) => {
    getDb()
      .prepare('UPDATE report_designs SET visibility = ?, shared_users = ? WHERE id = ?')
      .run(String(req.body?.visibility || 'public'), JSON.stringify(req.body?.shared_users || []), Number(req.params.id));
    res.json({ ok: true });
  });

  router.get('/api/report-designs/:id', (req, res) => {
    const row = getDb().prepare('SELECT * FROM report_designs WHERE id = ?').get(Number(req.params.id)) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ detail: 'Макет не найден' });
      return;
    }
    res.json({ ...row, design: JSON.parse(String(row.design || '{}')), shared_users: JSON.parse(String(row.shared_users || '[]')) });
  });

  router.put('/api/report-designs/:id', (req, res) => {
    getDb()
      .prepare('UPDATE report_designs SET name=?, format=?, design=?, updated_at=? WHERE id=?')
      .run(
        String(req.body?.name || 'Макет'),
        String(req.body?.format || 'xlsx'),
        JSON.stringify(req.body?.design || {}),
        nowIso(),
        Number(req.params.id),
      );
    res.json({ ok: true });
  });

  router.delete('/api/report-designs/:id', (req, res) => {
    getDb().prepare('DELETE FROM report_designs WHERE id = ?').run(Number(req.params.id));
    res.json({ ok: true });
  });

  router.get('/api/report-designs/:id/generate', async (req, res) => {
    const dateFrom = String(req.query.date_from || new Date().toISOString().slice(0, 10));
    const dateTo = String(req.query.date_to || dateFrom);
    const rows = crewBreakdown(dateFrom, dateTo);
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Отчёт');
    ws.addRow(['Дата', 'Бригада', 'Состав', 'Назначено', 'Сдано', 'Восстановлено']);
    for (const r of rows) ws.addRow([r.date, r.crew, r.members, r.assigned, r.reported, r.restored]);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="design-${req.params.id}.xlsx"`);
    res.send(Buffer.from(buf));
  });

  // ---- EXCEL (/api/excel/*) ----
  async function sendSimpleWorkbook(res: import('express').Response, sheetName: string, headers: string[], rows: unknown[][], filename: string) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet(sheetName);
    ws.addRow(headers);
    for (const r of rows) ws.addRow(r);
    const buf = await wb.xlsx.writeBuffer();
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(Buffer.from(buf));
  }

  router.get('/api/excel/template', async (_req, res) => {
    await sendSimpleWorkbook(res, 'Комплексы', ['Номер', 'Адрес', 'Описание', 'Широта', 'Долгота', 'Статус', 'SIM', 'IP', 'Порт'], [], 'points-template.xlsx');
  });

  router.get('/api/excel/export', async (req: AuthedRequest, res) => {
    const perms = req.sessionUser!.permissions;
    const pts = getDb().prepare('SELECT * FROM points ORDER BY id').all() as Array<Record<string, unknown>>;
    const rows = pts.map((p) => [
      p.id,
      p.address,
      p.description,
      p.lat,
      p.lon,
      p.status,
      p.sim_number,
      networkOk(perms) ? p.ip_address : '',
      p.port,
      secretsOk(perms) ? decryptField(String(p.login || '')) : '',
      secretsOk(perms) ? decryptField(String(p.password || '')) : '',
    ]);
    await sendSimpleWorkbook(res, 'Все АПК', ['Номер', 'Адрес', 'Описание', 'Широта', 'Долгота', 'Статус', 'SIM', 'IP', 'Порт', 'Логин', 'Пароль'], rows, 'points-export.xlsx');
  });

  router.get('/api/excel/plan/:day', async (req, res) => {
    const day = req.params.day;
    const tasks = getDb()
      .prepare('SELECT t.point, t.work, t.address, t.type, c.name as crew FROM tasks t LEFT JOIN crews c ON c.id = t.team WHERE t.date = ? ORDER BY c.id, t.id')
      .all(day) as Array<Record<string, unknown>>;
    await sendSimpleWorkbook(
      res,
      'План дня',
      ['Бригада', 'Комплекс', 'Тип работы', 'Адрес', 'Задание'],
      tasks.map((t) => [t.crew || '', t.point, t.type, t.address, t.work]),
      `plan-${day}.xlsx`,
    );
  });

  router.get('/api/excel/yandex/:day', async (req, res) => {
    const day = req.params.day;
    const tasks = getDb()
      .prepare('SELECT t.point, t.address, p.lat, p.lon, t.type FROM tasks t LEFT JOIN points p ON p.id = t.point WHERE t.date = ?')
      .all(day) as Array<Record<string, unknown>>;
    await sendSimpleWorkbook(
      res,
      'Яндекс Карты',
      ['Широта', 'Долгота', 'Подпись', 'Описание'],
      tasks.map((t) => [t.lat || '', t.lon || '', t.point || '', `${t.type || ''} ${t.address || ''}`.trim()]),
      `yandex-${day}.xlsx`,
    );
  });

  router.get('/api/excel/yandex-points', async (_req, res) => {
    const pts = getDb().prepare("SELECT id, lat, lon, address, status FROM points WHERE lat != '' AND lon != ''").all() as Array<Record<string, unknown>>;
    await sendSimpleWorkbook(
      res,
      'Точки',
      ['Широта', 'Долгота', 'Номер', 'Описание'],
      pts.map((p) => [p.lat, p.lon, p.id, `${p.status || ''} ${p.address || ''}`.trim()]),
      'yandex-points.xlsx',
    );
  });

  router.get('/api/excel/period-report', async (req, res) => {
    const dateFrom = String(req.query.date_from || '');
    const dateTo = String(req.query.date_to || '');
    const rows = crewBreakdown(dateFrom, dateTo);
    await sendSimpleWorkbook(
      res,
      'Отчёт за период',
      ['Дата', 'Бригада', 'Состав', 'Назначено', 'Сдано', 'Восстановлено', 'Неисправно'],
      rows.map((r) => [r.date, r.crew, r.members, r.assigned, r.reported, r.restored, r.not_working]),
      `period-report-${dateFrom}.xlsx`,
    );
  });

  router.get('/api/excel/sim-ip-export', async (_req, res) => {
    const pts = getDb().prepare("SELECT id, sim_number, ip_address FROM points WHERE sim_number != '' OR ip_address != ''").all() as Array<Record<string, unknown>>;
    await sendSimpleWorkbook(res, 'SIM-IP', ['Комплекс', 'SIM', 'IP'], pts.map((p) => [p.id, p.sim_number, p.ip_address]), 'sim-ip.xlsx');
  });

  router.get('/api/excel/sim-template', async (_req, res) => {
    await sendSimpleWorkbook(res, 'SIM', ['Комплекс', 'SIM'], [], 'sim-template.xlsx');
  });

  router.get('/api/excel/sim-ip-template', async (_req, res) => {
    await sendSimpleWorkbook(res, 'SIM-IP', ['Комплекс', 'SIM', 'IP'], [], 'sim-ip-template.xlsx');
  });

  router.get('/api/excel/sim-ip-registry-template', async (_req, res) => {
    await sendSimpleWorkbook(res, 'Реестр SIM-IP', ['SIM', 'IP'], [], 'sim-ip-registry-template.xlsx');
  });

  router.post('/api/excel/sim-import', upload.single('file'), async (req, res) => {
    if (!req.file) { res.status(400).json({ detail: 'Файл не передан' }); return; }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    let updated = 0;
    const upd = getDb().prepare('UPDATE points SET sim_number = ? WHERE id = ?');
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const pid = String(row.getCell(1).value || '').trim();
      const sim = String(row.getCell(2).value || '').trim();
      if (pid && sim) { upd.run(sim, pid); updated += 1; }
    });
    res.json({ ok: true, updated });
  });

  router.post('/api/excel/sim-ip-import', upload.single('file'), async (req, res) => {
    if (!req.file) { res.status(400).json({ detail: 'Файл не передан' }); return; }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    let updated = 0;
    const upd = getDb().prepare('UPDATE points SET sim_number = ?, ip_address = ? WHERE id = ?');
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const pid = String(row.getCell(1).value || '').trim();
      if (pid) {
        upd.run(String(row.getCell(2).value || '').trim(), String(row.getCell(3).value || '').trim(), pid);
        updated += 1;
      }
    });
    res.json({ ok: true, updated });
  });

  router.post('/api/excel/sim-ip-registry-import', upload.single('file'), async (req, res) => {
    if (!req.file) { res.status(400).json({ detail: 'Файл не передан' }); return; }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    let updated = 0;
    const ins = getDb().prepare('INSERT INTO sim_ip_registry (sim_number, ip_address, updated_at) VALUES (?, ?, ?) ON CONFLICT(sim_number) DO UPDATE SET ip_address=excluded.ip_address, updated_at=excluded.updated_at');
    const now = nowIso();
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const sim = String(row.getCell(1).value || '').trim();
      const ip = String(row.getCell(2).value || '').trim();
      if (sim && ip) { ins.run(sim, ip, now); updated += 1; }
    });
    res.json({ ok: true, updated });
  });

  router.post('/api/excel/import', upload.single('file'), async (req, res) => {
    if (!req.file) { res.status(400).json({ detail: 'Файл не передан' }); return; }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    let added = 0;
    const ins = getDb().prepare(
      `INSERT INTO points (id, address, description, lat, lon, status, sim_number, ip_address, port)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET address=excluded.address, description=excluded.description, lat=excluded.lat, lon=excluded.lon`,
    );
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const pid = String(row.getCell(1).value || '').trim();
      if (!pid) return;
      ins.run(
        pid,
        String(row.getCell(2).value || '').trim(),
        String(row.getCell(3).value || '').trim(),
        String(row.getCell(4).value || '').trim(),
        String(row.getCell(5).value || '').trim(),
        String(row.getCell(6).value || '').trim(),
        String(row.getCell(7).value || '').trim(),
        String(row.getCell(8).value || '').trim(),
        String(row.getCell(9).value || '').trim(),
      );
      added += 1;
    });
    res.json({ ok: true, imported: added });
  });

  // ---- KML ----
  router.get('/api/kml/points', (_req, res) => {
    const pts = getDb().prepare("SELECT id, address, description, lat, lon FROM points WHERE lat != '' AND lon != ''").all() as Array<Record<string, unknown>>;
    const placemarks = pts
      .map(
        (p) =>
          `<Placemark><name>${escapeXml(String(p.id))}</name><description>${escapeXml(String(p.address || p.description || ''))}</description><Point><coordinates>${escapeXml(String(p.lon))},${escapeXml(String(p.lat))},0</coordinates></Point></Placemark>`,
      )
      .join('');
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="points.kml"');
    res.send(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>АПК</name>${placemarks}</Document></kml>`);
  });

  router.get('/api/kml/day/:day', (req, res) => {
    const day = req.params.day;
    const rows = getDb()
      .prepare('SELECT t.point, t.address, p.lat, p.lon, t.type FROM tasks t LEFT JOIN points p ON p.id = t.point WHERE t.date = ?')
      .all(day) as Array<Record<string, unknown>>;
    const placemarks = rows
      .filter((r) => r.lat && r.lon)
      .map(
        (r) =>
          `<Placemark><name>${escapeXml(String(r.point))}</name><description>${escapeXml(`${r.type || ''} ${r.address || ''}`)}</description><Point><coordinates>${escapeXml(String(r.lon))},${escapeXml(String(r.lat))},0</coordinates></Point></Placemark>`,
      )
      .join('');
    res.setHeader('Content-Type', 'application/vnd.google-earth.kml+xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="plan-${day}.kml"`);
    res.send(`<?xml version="1.0" encoding="UTF-8"?><kml xmlns="http://www.opengis.net/kml/2.2"><Document><name>План ${day}</name>${placemarks}</Document></kml>`);
  });

  // ---- PAUTINA & FORMS IMPORT ----
  const pautinaReports = new Map<string, unknown>();

  router.post('/api/pautina/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const reportId = crypto.randomBytes(6).toString('hex');
    const text = req.file.buffer.toString('utf-8');
    let parsed = 0;
    if (req.file.originalname.toLowerCase().endsWith('.kml')) {
      const parser = new XMLParser();
      const xml = parser.parse(text);
      const placemarks = xml?.kml?.Document?.Placemark;
      parsed = Array.isArray(placemarks) ? placemarks.length : placemarks ? 1 : 0;
    }
    const summary = { id: reportId, created: 0, updated: 0, skipped: 0, parsed };
    pautinaReports.set(reportId, summary);
    res.json(summary);
  });

  router.get('/api/pautina/report/:reportId', (req, res) => {
    res.json(pautinaReports.get(req.params.reportId) || { id: req.params.reportId, created: 0, updated: 0, skipped: 0 });
  });

  router.get('/api/forms-import/rows', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM forms_import_rows ORDER BY id DESC LIMIT 500').all());
  });

  router.post('/api/forms-import/import', upload.single('file'), async (req, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    let added = 0;
    const now = nowIso();
    const ins = getDb().prepare(
      `INSERT OR IGNORE INTO forms_import_rows (row_hash, batch, form_time, raw_point, crew_text, status_text, result_text, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const batch = `f_${Date.now()}`;
    ws?.eachRow((row, idx) => {
      if (idx === 1) return;
      const vals = [row.getCell(1).value, row.getCell(2).value, row.getCell(3).value, row.getCell(4).value].map((v) => String(v || ''));
      const hash = crypto.createHash('sha1').update(vals.join('|')).digest('hex');
      const info = ins.run(hash, batch, vals[0], vals[1], vals[2], vals[3], '', now, now);
      if (info.changes) added += 1;
    });
    res.json({ ok: true, added, batch });
  });

  router.post('/api/forms-import/photos', (_req, res) => res.json({ ok: true, queued: 0 }));
  router.get('/api/forms-import/photos/status', (_req, res) => res.json({ running: false, total: 0, done: 0 }));
  router.get('/api/forms-import/ai-faults', (_req, res) => {
    res.json(getDb().prepare('SELECT * FROM report_ai_fault ORDER BY analyzed_at DESC LIMIT 200').all());
  });
  router.post('/api/forms-import/ai-faults', (_req, res) => res.json({ ok: true, queued: 0 }));

  router.get('/api/forms-auto', (_req, res) => res.json({ enabled: false, url: '', interval_minutes: 15 }));
  router.put('/api/forms-auto', (req, res) => res.json({ ok: true, ...(req.body || {}) }));
  router.post('/api/forms-auto/run', (_req, res) => res.json({ ok: true, imported: 0 }));
  router.post('/api/forms-auto/page-from-robot', (_req, res) => res.json({ ok: true }));
  router.post('/api/forms-auto/diag', (_req, res) => res.json({ ok: false, message: 'Робот Яндекс Форм не подключён в этой среде' }));
  router.get('/api/forms-auto/diag/shot', (_req, res) => res.status(404).json({ detail: 'Скриншот отсутствует' }));
  router.get('/api/forms-auto/export-shot', (_req, res) => res.status(404).json({ detail: 'Скриншот отсутствует' }));

  return router;
}
