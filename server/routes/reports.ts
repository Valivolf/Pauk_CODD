import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import ExcelJS from 'exceljs';
import { XMLParser } from 'fast-xml-parser';
import multer from 'multer';
import { GoogleGenAI, Type } from '@google/genai';
import { requirePasswordOk, requirePerm, type AuthedRequest } from '../auth.ts';
import { PHOTOS_DIR, REPORT_TEMPLATES_DIR, settings } from '../config.ts';
import { decryptField } from '../crypto.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { networkOk, secretsOk } from '../permissions.ts';
import { callRobot, RobotRejectedError, RobotUnavailableError } from '../services/yandexRobotClient.ts';

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

  // ---- FORMS IMPORT & FORMS AUTO ----
  const FORMS_ALIASES: Record<string, string[]> = {
    time: ['время создания', 'время отправки ответа', 'время отправки', 'дата создания', 'время', 'дата и время', 'дата'],
    sim: ['номер сим карты', 'номер sim', 'сим карта', 'sim карта', 'сим', 'sim'],
    point: ['номер апк', 'номер комплекса', 'апк', 'комплекс', 'номер'],
    location: ['местоположение', 'координаты', 'адрес'],
    inventory: ['инвентарный номер', 'инв номер', 'инвентарный'],
    files: ['файл', 'файлы', 'фото', 'вложения'],
    result: ['результат выезда', 'результат', 'итог работ', 'итог'],
    status: ['статус'],
    equipment: ['оборудование'],
    crew: ['бригада', 'исполнители', 'исполнитель', 'монтеры'],
    power: ['тип питания', 'питание'],
  };

  function normHeaderKey(val: unknown): string {
    return String(val || '')
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function cellText(val: unknown): string {
    if (val === null || val === undefined) return '';
    if (val instanceof Date) return val.toISOString().slice(0, 19).replace('T', ' ');
    if (typeof val === 'object' && val !== null) {
      const obj = val as Record<string, unknown>;
      if (typeof obj.text === 'string') return obj.text.trim();
      if (typeof obj.hyperlink === 'string') return obj.hyperlink.trim();
      if (Array.isArray(obj.richText)) {
        return obj.richText.map((r) => String((r as Record<string, unknown>).text || '')).join('').trim();
      }
      if ('result' in obj) return cellText(obj.result);
    }
    return String(val).trim();
  }

  function parseFormDateIso(raw: string): { date: string; iso: string } {
    const s = raw.trim();
    if (!s) {
      const d = new Date().toISOString().slice(0, 10);
      return { date: d, iso: nowIso() };
    }
    let m = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) {
      const date = `${m[1]}-${m[2]}-${m[3]}`;
      const time = m[4] ? `${m[4]}:${m[5]}:${m[6] || '00'}` : '12:00:00';
      return { date, iso: `${date}T${time}+03:00` };
    }
    m = /^(\d{2})\.(\d{2})\.(\d{4})(?:\s+(\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(s);
    if (m) {
      const date = `${m[3]}-${m[2]}-${m[1]}`;
      const time = m[4] ? `${m[4]}:${m[5]}:${m[6] || '00'}` : '12:00:00';
      return { date, iso: `${date}T${time}+03:00` };
    }
    const d = new Date().toISOString().slice(0, 10);
    return { date: d, iso: nowIso() };
  }

  function shiftIsoDay(isoDate: string, delta: number): string {
    const d = new Date(`${isoDate}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + delta);
    return d.toISOString().slice(0, 10);
  }

  function extractUrls(text: string): string[] {
    return (text.match(/https?:\/\/[^\s,;]+/gi) || []).map((u) => u.trim());
  }

  function resolvePointId(rawPoint: string, allPoints: Array<{ id: string }>): { pointId: string | null; ambiguous: boolean } {
    const clean = rawPoint.trim();
    if (!clean) return { pointId: null, ambiguous: false };
    const low = clean.toLowerCase();
    const exact = allPoints.find((p) => p.id.toLowerCase() === low);
    if (exact) return { pointId: exact.id, ambiguous: false };
    const digits = clean.replace(/\D+/g, '');
    if (!digits || digits.length < 2) return { pointId: null, ambiguous: false };
    const matches = allPoints.filter((p) => p.id.replace(/\D+/g, '') === digits);
    if (matches.length === 1) return { pointId: matches[0].id, ambiguous: false };
    if (matches.length > 1) return { pointId: null, ambiguous: true };
    return { pointId: null, ambiguous: false };
  }

  const photosJob = {
    running: false,
    total: 0,
    done: 0,
    failed: 0,
    skipped: 0,
    current: '',
    error: '',
  };

  function safePhotoSeg(val: string): string {
    return String(val || 'unknown').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim() || 'unknown';
  }

  async function runFormsPhotosJob(rowIds: number[]) {
    if (photosJob.running || rowIds.length === 0) return;
    photosJob.running = true;
    photosJob.total = 0;
    photosJob.done = 0;
    photosJob.failed = 0;
    photosJob.skipped = 0;
    photosJob.current = '';
    photosJob.error = '';
    const db = getDb();
    try {
      const rows = rowIds
        .map((id) => db.prepare('SELECT * FROM forms_import_rows WHERE id = ?').get(id) as Record<string, unknown> | undefined)
        .filter((r): r is Record<string, unknown> => Boolean(r && r.point_id && r.task_id));

      for (const r of rows) {
        let urls: string[] = [];
        try {
          urls = JSON.parse(String(r.photo_urls || '[]')) as string[];
        } catch {
          urls = [];
        }
        photosJob.total += urls.length;
      }

      const formsCfgRow = db.prepare("SELECT value FROM app_flags WHERE key = 'forms_auto_config'").get() as { value: string } | undefined;
      let profile = 'maps';
      if (formsCfgRow) {
        try {
          const parsedCfg = JSON.parse(formsCfgRow.value) as { profile?: string };
          if (parsedCfg.profile === 'forms') profile = 'forms';
        } catch {
          // ignore
        }
      }

      for (const r of rows) {
        const rowId = Number(r.id);
        const pointId = String(r.point_id || '');
        const taskId = String(r.task_id || '');
        const takenDate = String(r.task_date || r.form_time || '').slice(0, 10) || nowIso().slice(0, 10);
        photosJob.current = pointId;

        let urls: string[] = [];
        try {
          urls = JSON.parse(String(r.photo_urls || '[]')) as string[];
        } catch {
          urls = [];
        }
        if (urls.length === 0) continue;

        const existingCnt = (
          db.prepare('SELECT COUNT(*) AS cnt FROM visit_photos WHERE point_id = ? AND taken_date = ?').get(pointId, takenDate) as { cnt: number }
        ).cnt;
        if (existingCnt > 0 && Number(r.photos_done || 0) === 0) {
          photosJob.skipped += urls.length;
          db.prepare("UPDATE forms_import_rows SET photos_state = 'skipped', updated_at = ? WHERE id = ?").run(nowIso(), rowId);
          continue;
        }

        let rowDone = Number(r.photos_done || 0);
        let lastErr = '';
        for (let idx = 0; idx < urls.length; idx += 1) {
          const url = urls[idx];
          try {
            let buf: Buffer | null = null;
            let ext = 'jpg';
            // Try Yandex Robot first if available (forms photos require creator session cookies), else fallback to direct fetch
            try {
              const robotResp = await callRobot('POST', '/download', {
                params: { profile },
                json: { url },
                timeoutMs: 60000,
                raw: true,
              });
              if (robotResp.status === 200 && robotResp.body.length > 100) {
                buf = robotResp.body;
                const ct = robotResp.headers.get('content-type') || '';
                if (ct.includes('png')) ext = 'png';
                else if (ct.includes('webp')) ext = 'webp';
              } else {
                lastErr = `HTTP ${robotResp.status}`;
              }
            } catch (robotErr) {
              if (robotErr instanceof RobotUnavailableError) {
                const ctrl = new AbortController();
                const timer = setTimeout(() => ctrl.abort(), 15000);
                try {
                  const direct = await fetch(url, { signal: ctrl.signal });
                  const ct = direct.headers.get('content-type') || '';
                  if (direct.ok && /^image\//i.test(ct)) {
                    buf = Buffer.from(await direct.arrayBuffer());
                    if (ct.includes('png')) ext = 'png';
                    else if (ct.includes('webp')) ext = 'webp';
                  } else {
                    lastErr = robotErr.message;
                  }
                } catch {
                  lastErr = robotErr.message;
                } finally {
                  clearTimeout(timer);
                }
              } else {
                lastErr = (robotErr as Error).message;
              }
            }

            if (buf && buf.length > 0) {
              const info = db
                .prepare(
                  `INSERT INTO visit_photos (task_id, point_id, taken_date, file_ext, uploaded_at, uploaded_by, storage, storage_path, source, file_size)
                   VALUES (?, ?, ?, ?, ?, 'Яндекс Форма', 'local', '', 'forms', ?)`,
                )
                .run(taskId, pointId, takenDate, ext, nowIso(), buf.length);
              const photoId = Number(info.lastInsertRowid);
              const dir = path.join(PHOTOS_DIR, safePhotoSeg(pointId), takenDate);
              fs.mkdirSync(dir, { recursive: true });
              const filePath = path.join(dir, `${photoId}.${ext}`);
              fs.writeFileSync(filePath, buf);
              db.prepare('UPDATE visit_photos SET storage_path = ?, rel_path = ? WHERE id = ?').run(
                filePath,
                path.join(safePhotoSeg(pointId), takenDate, `${photoId}.${ext}`),
                photoId,
              );
              rowDone += 1;
              photosJob.done += 1;
            } else {
              photosJob.failed += 1;
              if (!photosJob.error && lastErr) photosJob.error = lastErr;
            }
          } catch (err) {
            photosJob.failed += 1;
            lastErr = (err as Error).message;
            if (!photosJob.error) photosJob.error = lastErr;
          }
        }
        db.prepare('UPDATE forms_import_rows SET photos_done = ?, photos_state = ?, photos_error = ?, updated_at = ? WHERE id = ?').run(
          rowDone,
          rowDone >= urls.length ? 'done' : lastErr ? 'error' : 'partial',
          lastErr.slice(0, 300),
          nowIso(),
          rowId,
        );
      }
    } finally {
      photosJob.running = false;
      photosJob.current = '';
    }
  }

  function getAiFormsFaultConfig(): { enabled: boolean; llmOk: boolean } {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_flags WHERE key = 'ai_config'").get() as { value: string } | undefined;
    let enabled = false;
    if (row) {
      try {
        enabled = Boolean((JSON.parse(row.value) as Record<string, unknown>).forms_fault);
      } catch {
        enabled = false;
      }
    }
    const apiKey = (process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim();
    return { enabled, llmOk: Boolean(apiKey) };
  }

  const aiFaultJob = { running: false, last_error: '' };

  function getAiFaultStatus() {
    const db = getDb();
    const { enabled, llmOk } = getAiFormsFaultConfig();
    const failedReports = db
      .prepare(
        `SELECT tvr.task_id, tvr.point_id, tvr.comment, tvr.fault, tvr.needs
         FROM task_visit_reports tvr
         WHERE tvr.outcome = 'failed'`,
      )
      .all() as Array<{ task_id: string; point_id: string; comment: string; fault: string | null; needs: string | null }>;
    const existing = db.prepare('SELECT task_id, status FROM report_ai_fault').all() as Array<{ task_id: string; status: string }>;
    const statusMap = new Map(existing.map((e) => [e.task_id, e.status]));

    let pending = 0;
    let ok = 0;
    let empty = 0;
    let rejected = 0;
    let skipped = 0;
    let error = 0;

    for (const r of failedReports) {
      const st = statusMap.get(r.task_id);
      if (!st) {
        if ((r.fault || '').trim() || (r.needs || '').trim()) {
          skipped += 1;
        } else if ((r.comment || '').trim()) {
          pending += 1;
        } else {
          empty += 1;
        }
      } else if (st === 'ok') ok += 1;
      else if (st === 'empty') empty += 1;
      else if (st === 'rejected') rejected += 1;
      else if (st === 'skipped') skipped += 1;
      else if (st === 'error') error += 1;
    }

    return {
      enabled,
      running: aiFaultJob.running,
      pending,
      ok,
      empty,
      rejected,
      skipped,
      error,
      llm_ready: llmOk || true, // rule-based fallback works even without external key; Gemini used when key configured
      last_error: aiFaultJob.last_error,
    };
  }

  function ruleParseFault(comment: string): { cause: string; needs: string } {
    const low = comment.toLowerCase();
    let cause = comment.trim().slice(0, 180);
    let needs = 'Повторный выезд и диагностика';
    if (/питан|акб|220|напряж|бп|блок питан|автомат/.test(low)) {
      cause = 'Проблема с питанием (нет 220В / неисправен БП или АКБ)';
      needs = 'Проверить электропитание / заменить БП или АКБ';
    } else if (/sim|сим|связ|модем|роутер|антенн|сигнал|интернет/.test(low)) {
      cause = 'Отсутствует связь / сбой модема или SIM-карты';
      needs = 'Проверить/заменить SIM-карту, модем или антенну';
    } else if (/камер|объектив|фокус|гряз|ик|подсвет/.test(low)) {
      cause = 'Неисправность или загрязнение камеры / ИК-подсветки';
      needs = 'Обслуживание или замена камеры';
    } else if (/кабел|разъ[её]м|обрыв|витая|rj45|оптик/.test(low)) {
      cause = 'Повреждение кабеля или разъёмов';
      needs = 'Восстановить кабель / переобжать разъём';
    }
    return { cause, needs };
  }

  async function runAiFaultBatch(again: boolean) {
    if (aiFaultJob.running) return;
    aiFaultJob.running = true;
    aiFaultJob.last_error = '';
    const db = getDb();
    try {
      const apiKey = (process.env.GEMINI_API_KEY || settings.geminiApiKey || '').trim();
      const ai = apiKey ? new GoogleGenAI({ apiKey }) : null;
      const rows = db
        .prepare("SELECT task_id, point_id, comment, fault, needs FROM task_visit_reports WHERE outcome = 'failed'")
        .all() as Array<{ task_id: string; point_id: string; comment: string; fault: string | null; needs: string | null }>;
      const prevMap = new Map(
        (db.prepare('SELECT task_id, status FROM report_ai_fault').all() as Array<{ task_id: string; status: string }>).map((r) => [
          r.task_id,
          r.status,
        ]),
      );

      for (const r of rows) {
        const st = prevMap.get(r.task_id);
        if (!again && st) continue;
        if (again && st && st !== 'rejected' && st !== 'error') continue;
        if (!st && ((r.fault || '').trim() || (r.needs || '').trim())) continue;
        const text = (r.comment || '').trim();
        if (!text) {
          db.prepare(
            `INSERT INTO report_ai_fault (task_id, point_id, analyzed_at, status, source_text)
             VALUES (?, ?, ?, 'empty', '') ON CONFLICT(task_id) DO UPDATE SET status='empty', analyzed_at=excluded.analyzed_at`,
          ).run(r.task_id, r.point_id, nowIso());
          continue;
        }
        try {
          let cause = '';
          let needs = '';
          if (ai) {
            const resp = await ai.models.generateContent({
              model: 'gemini-4-hydrogen',
              contents: `Из текста итога выезда монтёра выдели кратко: 1) cause (причина неисправности), 2) needs (что нужно для восстановления). Текст: "${text}". Верни JSON.`,
              config: {
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    cause: { type: Type.STRING },
                    needs: { type: Type.STRING },
                  },
                },
              },
            });
            const parsed = JSON.parse(resp.text || '{}') as { cause?: string; needs?: string };
            cause = String(parsed.cause || '').trim();
            needs = String(parsed.needs || '').trim();
          }
          if (!cause && !needs) {
            const fb = ruleParseFault(text);
            cause = fb.cause;
            needs = fb.needs;
          }
          db.prepare(
            `INSERT INTO report_ai_fault (task_id, point_id, analyzed_at, status, cause, needs, source_text, error, attempts)
             VALUES (?, ?, ?, 'ok', ?, ?, ?, '', 1)
             ON CONFLICT(task_id) DO UPDATE SET analyzed_at=excluded.analyzed_at, status='ok', cause=excluded.cause, needs=excluded.needs, error='', attempts=report_ai_fault.attempts+1`,
          ).run(r.task_id, r.point_id, nowIso(), cause, needs, text.slice(0, 500));
          db.prepare('UPDATE task_visit_reports SET fault = COALESCE(NULLIF(fault, \'\'), ?), needs = COALESCE(NULLIF(needs, \'\'), ?), updated_at = ? WHERE task_id = ?').run(
            cause,
            needs,
            nowIso(),
            r.task_id,
          );
          if (r.point_id) {
            db.prepare('UPDATE points SET fault_reason = COALESCE(NULLIF(fault_reason, \'\'), ?), fault_need = COALESCE(NULLIF(fault_need, \'\'), ?) WHERE id = ?').run(
              cause,
              needs,
              r.point_id,
            );
          }
        } catch (err) {
          const msg = (err as Error).message;
          aiFaultJob.last_error = msg;
          db.prepare(
            `INSERT INTO report_ai_fault (task_id, point_id, analyzed_at, status, source_text, error, attempts)
             VALUES (?, ?, ?, 'error', ?, ?, 1)
             ON CONFLICT(task_id) DO UPDATE SET analyzed_at=excluded.analyzed_at, status='error', error=excluded.error, attempts=report_ai_fault.attempts+1`,
          ).run(r.task_id, r.point_id, nowIso(), text.slice(0, 500), msg.slice(0, 300));
        }
      }
    } finally {
      aiFaultJob.running = false;
    }
  }

  router.get('/api/forms-import/rows', (req, res) => {
    const batch = String(req.query.batch || '').trim();
    const db = getDb();
    const rows = batch
      ? db.prepare('SELECT * FROM forms_import_rows WHERE batch = ? ORDER BY id DESC LIMIT 500').all(batch)
      : db.prepare('SELECT * FROM forms_import_rows ORDER BY id DESC LIMIT 500').all();
    res.json({ rows, job: { ...photosJob } });
  });

  router.post('/api/forms-import/import', upload.single('file'), async (req: AuthedRequest, res) => {
    if (!req.file) {
      res.status(400).json({ detail: 'Файл не передан' });
      return;
    }
    const dryRun = String(req.body?.dry_run ?? 'true') !== 'false';
    const applyStatus = String(req.body?.apply_status ?? 'false') === 'true';
    let onlyHashes: Set<string> | null = null;
    if (typeof req.body?.only_json === 'string' && req.body.only_json.trim()) {
      try {
        onlyHashes = new Set((JSON.parse(req.body.only_json) as unknown[]).map(String));
      } catch {
        res.status(400).json({ detail: 'Неверный список строк' });
        return;
      }
    }

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(req.file.buffer as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    if (!ws) {
      res.status(400).json({ detail: 'Таблица пуста' });
      return;
    }

    const db = getDb();
    const allPoints = db.prepare('SELECT id FROM points').all() as Array<{ id: string }>;
    const existingHashes = new Set(
      (db.prepare('SELECT row_hash FROM forms_import_rows').all() as Array<{ row_hash: string }>).map((r) => r.row_hash),
    );
    const existingReports = db
      .prepare('SELECT point_id, substr(created_at, 1, 10) AS day, created_by, result_status FROM task_visit_reports')
      .all() as Array<{ point_id: string; day: string; created_by: string | null; result_status: string | null }>;
    const reportByPointDay = new Map<string, { by: string; status: string }>();
    for (const rep of existingReports) {
      reportByPointDay.set(`${rep.point_id}|${rep.day}`, {
        by: String(rep.created_by || ''),
        status: String(rep.result_status || ''),
      });
    }

    const crews = db.prepare('SELECT id, name FROM crews').all() as Array<{ id: number; name: string }>;
    const crewNameMap = new Map(crews.map((c) => [c.id, c.name]));

    // Map column headers
    const headerRow = ws.getRow(1);
    const colIdx: Record<string, number> = {};
    headerRow.eachCell((cell, colNumber) => {
      const k = normHeaderKey(cellText(cell.value));
      if (!k) return;
      for (const [field, aliases] of Object.entries(FORMS_ALIASES)) {
        if (!colIdx[field] && aliases.some((a) => k === a || k.startsWith(`${a} `))) {
          colIdx[field] = colNumber;
        }
      }
    });
    if (!colIdx.time && !colIdx.point) {
      colIdx.time = 1;
      colIdx.point = 2;
      colIdx.crew = 3;
      colIdx.status = 4;
      colIdx.result = 5;
      colIdx.files = 6;
    }

    interface PlannedRow {
      hash: string;
      time: string;
      date: string;
      raw_point: string;
      point_id: string | null;
      part: string;
      crew_text: string;
      status_text: string;
      result_text: string;
      power_text: string;
      sim_text: string;
      location_text: string;
      inventory_text: string;
      equipment_text: string;
      urls: string[];
      photos: number;
      action: string;
      note: string;
      existing: { by: string; status: string } | null;
      task: { id: string; date: string; type: string; crew: string; crew_hit: boolean } | null;
    }

    const plan: PlannedRow[] = [];
    const errors: string[] = [];
    const seenPlanKeys = new Set<string>();

    ws.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return;
      const rawTime = colIdx.time ? cellText(row.getCell(colIdx.time).value) : '';
      const rawPoint = colIdx.point ? cellText(row.getCell(colIdx.point).value) : '';
      const crewText = colIdx.crew ? cellText(row.getCell(colIdx.crew).value) : '';
      const statusText = colIdx.status ? cellText(row.getCell(colIdx.status).value) : '';
      const resultText = colIdx.result ? cellText(row.getCell(colIdx.result).value) : '';
      const filesText = colIdx.files ? cellText(row.getCell(colIdx.files).value) : '';
      const powerText = colIdx.power ? cellText(row.getCell(colIdx.power).value) : '';
      const simText = colIdx.sim ? cellText(row.getCell(colIdx.sim).value) : '';
      const locationText = colIdx.location ? cellText(row.getCell(colIdx.location).value) : '';
      const inventoryText = colIdx.inventory ? cellText(row.getCell(colIdx.inventory).value) : '';
      const equipmentText = colIdx.equipment ? cellText(row.getCell(colIdx.equipment).value) : '';

      if (!rawTime && !rawPoint && !resultText) return;
      const { date, iso } = parseFormDateIso(rawTime);
      const urls = extractUrls(filesText);
      const hash = crypto
        .createHash('sha1')
        .update([rawTime, rawPoint, crewText, statusText, resultText].join('|'))
        .digest('hex');

      const { pointId, ambiguous } = resolvePointId(rawPoint, allPoints);
      let action = 'create_free';
      let note = '';
      let existing: { by: string; status: string } | null = null;
      let matchedTask: { id: string; date: string; type: string; crew: string; crew_hit: boolean } | null = null;

      if (existingHashes.has(hash)) {
        action = 'done_before';
      } else if (ambiguous) {
        action = 'ambiguous';
        note = 'Несколько комплексов с такими цифрами';
      } else if (!pointId) {
        action = 'no_point';
      } else {
        const dupKey = `${pointId}|${date}`;
        if (seenPlanKeys.has(dupKey)) {
          action = 'duplicate';
        } else if (reportByPointDay.has(dupKey)) {
          action = 'exists';
          existing = reportByPointDay.get(dupKey) || null;
        } else {
          seenPlanKeys.add(dupKey);
          const dates = [date, shiftIsoDay(date, -1), shiftIsoDay(date, 1)];
          const tasks = db
            .prepare(
              `SELECT t.id, t.date, t.type, t.team
               FROM tasks t
               LEFT JOIN task_visit_reports r ON r.task_id = t.id
               WHERE t.point = ? AND t.date IN (?, ?, ?) AND r.task_id IS NULL
               ORDER BY abs(julianday(t.date) - julianday(?)) ASC
               LIMIT 1`,
            )
            .all(pointId, dates[0], dates[1], dates[2], date) as Array<{ id: string; date: string; type: string; team: number | null }>;
          if (tasks.length > 0) {
            const t = tasks[0];
            const cName = t.team ? crewNameMap.get(Number(t.team)) || '' : '';
            const crewHit = Boolean(cName && crewText.toLowerCase().includes(cName.toLowerCase().split(/\s+/)[0]));
            matchedTask = { id: t.id, date: t.date, type: t.type, crew: cName, crew_hit: crewHit };
            action = 'create';
          } else {
            action = 'create_free';
          }
        }
      }

      plan.push({
        hash,
        time: iso,
        date,
        raw_point: rawPoint,
        point_id: pointId,
        part: '',
        crew_text: crewText,
        status_text: statusText,
        result_text: resultText,
        power_text: powerText,
        sim_text: simText,
        location_text: locationText,
        inventory_text: inventoryText,
        equipment_text: equipmentText,
        urls,
        photos: urls.length,
        action,
        note,
        existing,
        task: matchedTask,
      });
    });

    if (plan.length === 0) {
      res.status(400).json({ detail: 'В таблице не найдено строк с отчётами' });
      return;
    }

    const summary: Record<string, number> = {
      total: plan.length,
      create: 0,
      create_free: 0,
      exists: 0,
      done_before: 0,
      duplicate: 0,
      no_point: 0,
      ambiguous: 0,
      photos: 0,
      to_create: 0,
    };
    for (const item of plan) {
      summary[item.action] = (summary[item.action] || 0) + 1;
      summary.photos += item.photos;
      if (item.action === 'create' || item.action === 'create_free') summary.to_create += 1;
    }

    if (dryRun) {
      res.json({
        dry_run: true,
        summary,
        rows: plan.map(({ urls: _u, ...rest }) => rest),
        errors,
      });
      return;
    }

    const batch = `f_${Date.now()}`;
    const now = nowIso();
    const who = req.sessionUser?.username || 'Яндекс Форма';
    let created = 0;
    let createdFree = 0;
    const insertedRowIds: number[] = [];

    for (const item of plan) {
      if (item.action !== 'create' && item.action !== 'create_free') continue;
      if (onlyHashes && !onlyHashes.has(item.hash)) continue;
      const pointId = item.point_id!;
      const isTask = Boolean(item.task);
      const taskId = item.task ? item.task.id : `form_${batch}_${crypto.randomBytes(4).toString('hex')}`;
      const statusLow = `${item.status_text} ${item.result_text}`.toLowerCase();
      const outcome = /не\s+удалось|не\s+работает|снят|отказ/.test(statusLow) ? 'failed' : 'fixed';
      const resultStatus = outcome === 'failed' ? 'Не работает' : 'Работает';
      const comment = [item.status_text, item.result_text].filter(Boolean).join(' — ');

      db.prepare(
        `INSERT OR IGNORE INTO task_visit_reports
         (task_id, point_id, visit_type, result_status, comment, outcome, imported, import_batch, source, created_at, updated_at, created_by)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'forms', ?, ?, ?)`,
      ).run(
        taskId,
        pointId,
        item.task?.type || 'Ремонт',
        resultStatus,
        comment,
        outcome,
        batch,
        item.time,
        now,
        item.crew_text || who,
      );

      if (isTask) {
        db.prepare('INSERT OR IGNORE INTO task_done (task_id, done_at, done_by) VALUES (?, ?, ?)').run(taskId, now, who);
        created += 1;
        item.action = 'created';
      } else {
        createdFree += 1;
        item.action = 'created_free';
      }

      if (applyStatus) {
        db.prepare('UPDATE points SET status = ?, status_updated_at = ? WHERE id = ?').run(resultStatus, now, pointId);
      }

      const rowInfo = db
        .prepare(
          `INSERT OR IGNORE INTO forms_import_rows
           (row_hash, batch, form_time, raw_point, point_id, task_id, task_date, crew_text, status_text, result_text,
            power_text, sim_text, location_text, inventory_text, equipment_text, photo_urls, photos_total, outcome, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          item.hash,
          batch,
          item.time,
          item.raw_point,
          pointId,
          taskId,
          item.date,
          item.crew_text,
          item.status_text,
          item.result_text,
          item.power_text,
          item.sim_text,
          item.location_text,
          item.inventory_text,
          item.equipment_text,
          JSON.stringify(item.urls),
          item.urls.length,
          outcome,
          now,
          now,
        );
      if (rowInfo.changes && item.urls.length > 0) {
        insertedRowIds.push(Number(rowInfo.lastInsertRowid));
      }
    }

    bumpStateRev();
    if (insertedRowIds.length > 0) {
      void runFormsPhotosJob(insertedRowIds);
    }
    const { enabled } = getAiFormsFaultConfig();
    if (enabled) {
      void runAiFaultBatch(false);
    }

    const savedRows = db.prepare('SELECT * FROM forms_import_rows WHERE batch = ? ORDER BY id DESC').all(batch);
    res.json({
      dry_run: false,
      batch,
      created,
      created_free: createdFree,
      summary,
      rows: plan.map(({ urls: _u, ...rest }) => rest),
      saved: savedRows,
      errors,
      photos: insertedRowIds.length > 0 ? { ...photosJob } : { ...photosJob, started: false, reason: 'В таблице нет ссылок на фото' },
    });
  });

  router.post('/api/forms-import/photos', (req, res) => {
    const ids: number[] = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter((n: number) => Number.isFinite(n)) : [];
    if (ids.length === 0) {
      res.status(400).json({ detail: 'Выберите хотя бы одну строку' });
      return;
    }
    if (photosJob.running) {
      res.status(409).json({ detail: 'Скачивание фото уже идёт' });
      return;
    }
    void runFormsPhotosJob(ids);
    res.json({ ...photosJob, started: true });
  });

  router.get('/api/forms-import/photos/status', (_req, res) => {
    res.json({ ...photosJob });
  });

  router.get('/api/forms-import/ai-faults', (_req, res) => {
    res.json(getAiFaultStatus());
  });

  router.post('/api/forms-import/ai-faults', (req, res) => {
    const again = Boolean(req.body?.again);
    if (aiFaultJob.running) {
      res.status(409).json({ detail: 'Разбор уже идёт — дождитесь окончания' });
      return;
    }
    void runAiFaultBatch(again);
    res.json({ started: true });
  });

  function loadFormsAutoConfig() {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_flags WHERE key = 'forms_auto_config'").get() as { value: string } | undefined;
    let saved: Record<string, unknown> = {};
    if (row) {
      try {
        saved = JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        saved = {};
      }
    }
    return {
      enabled: Boolean(saved.enabled),
      url: String(saved.url || ''),
      interval_minutes: Math.max(5, Math.min(1440, Number(saved.interval_minutes || 15))),
      apply_status: Boolean(saved.apply_status),
      profile: saved.profile === 'forms' ? 'forms' : 'maps',
    };
  }

  function loadFormsAutoState() {
    const db = getDb();
    const row = db.prepare("SELECT value FROM app_flags WHERE key = 'forms_auto_state'").get() as { value: string } | undefined;
    let saved: Record<string, unknown> = {};
    if (row) {
      try {
        saved = JSON.parse(row.value) as Record<string, unknown>;
      } catch {
        saved = {};
      }
    }
    return {
      running: Boolean(saved.running),
      last_run: saved.last_run ? Number(saved.last_run) : null,
      ok: saved.ok === true ? true : saved.ok === false ? false : null,
      step: String(saved.step || ''),
      message: String(saved.message || ''),
      error: String(saved.error || ''),
    };
  }

  function saveFormsAutoState(patch: Record<string, unknown>) {
    const next = { ...loadFormsAutoState(), ...patch };
    getDb()
      .prepare("INSERT INTO app_flags (key, value) VALUES ('forms_auto_state', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    return next;
  }

  router.get('/api/forms-auto', requirePerm('admin.settings'), (_req, res) => {
    res.json({ config: loadFormsAutoConfig(), state: loadFormsAutoState() });
  });

  router.put('/api/forms-auto', requirePerm('admin.settings'), (req, res) => {
    const cur = loadFormsAutoConfig();
    const b = req.body || {};
    const interval = b.interval_minutes != null ? Number(b.interval_minutes) : cur.interval_minutes;
    if (!Number.isFinite(interval) || interval < 5 || interval > 1440) {
      res.status(400).json({ detail: 'Периодичность — от 5 до 1440 минут' });
      return;
    }
    const next = {
      enabled: typeof b.enabled === 'boolean' ? b.enabled : cur.enabled,
      url: typeof b.url === 'string' ? b.url.trim().slice(0, 500) : cur.url,
      interval_minutes: interval,
      apply_status: typeof b.apply_status === 'boolean' ? b.apply_status : cur.apply_status,
      profile: b.profile === 'forms' ? 'forms' : b.profile === 'maps' ? 'maps' : cur.profile,
    };
    getDb()
      .prepare("INSERT INTO app_flags (key, value) VALUES ('forms_auto_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(JSON.stringify(next));
    res.json({ config: next, state: loadFormsAutoState() });
  });

  router.post('/api/forms-auto/run', requirePerm('admin.settings'), async (_req, res) => {
    const cfg = loadFormsAutoConfig();
    if (!cfg.url) {
      res.status(400).json({ detail: 'Укажите страницу «Ответы» вашей формы перед запуском' });
      return;
    }
    saveFormsAutoState({ running: true, step: 'Запрашиваю таблицу ответов у робота…', error: '' });
    try {
      const robotRes = await callRobot('POST', '/forms/export', {
        params: { profile: cfg.profile },
        json: { url: cfg.url },
        timeoutMs: 120000,
      });
      const data = (robotRes.jsonData || {}) as Record<string, unknown>;
      saveFormsAutoState({
        running: false,
        last_run: Math.floor(Date.now() / 1000),
        ok: true,
        step: '',
        message: String(data.message || 'Выгрузка формы выполнена роботом'),
        error: '',
      });
      res.json({ started: true });
    } catch (err) {
      saveFormsAutoState({
        running: false,
        last_run: Math.floor(Date.now() / 1000),
        ok: false,
        step: '',
        error: (err as Error).message,
      });
      if (err instanceof RobotUnavailableError) {
        res.status(503).json({ detail: err.message });
      } else {
        res.status(502).json({ detail: (err as Error).message });
      }
    }
  });

  router.post('/api/forms-auto/page-from-robot', requirePerm('admin.settings'), async (_req, res) => {
    const cfg = loadFormsAutoConfig();
    try {
      const r = await callRobot('GET', '/view/url', { params: { profile: cfg.profile } });
      const data = (r.jsonData || {}) as { url?: string };
      const url = String(data.url || '').trim();
      if (!url) {
        res.status(400).json({ detail: 'В браузере робота сейчас не открыта страница' });
        return;
      }
      const next = { ...cfg, url };
      getDb()
        .prepare("INSERT INTO app_flags (key, value) VALUES ('forms_auto_config', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
        .run(JSON.stringify(next));
      res.json({ ok: true, url });
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 502).json({ detail: (err as Error).message });
    }
  });

  router.post('/api/forms-auto/diag', requirePerm('admin.settings'), async (req, res) => {
    const cfg = loadFormsAutoConfig();
    let checkedUrl = String(req.body?.url || '').trim();
    if (!checkedUrl) {
      const row = getDb()
        .prepare("SELECT photo_urls FROM forms_import_rows WHERE photos_total > 0 AND photos_done = 0 ORDER BY id DESC LIMIT 1")
        .get() as { photo_urls: string } | undefined;
      if (row) {
        try {
          const urls = JSON.parse(row.photo_urls) as string[];
          if (urls[0]) checkedUrl = urls[0];
        } catch {
          // ignore
        }
      }
    }
    if (!checkedUrl) {
      res.status(400).json({ detail: 'В базе нет недокачанных ссылок — вставьте ссылку на фото вручную' });
      return;
    }
    try {
      const r = await callRobot('POST', '/download/diag', {
        params: { profile: cfg.profile },
        json: { url: checkedUrl },
        timeoutMs: 180000,
      });
      res.json(r.jsonData);
    } catch (err) {
      if (err instanceof RobotUnavailableError) {
        res.json({
          checked_url: checkedUrl,
          has_session: false,
          login: '',
          captcha: false,
          has_shot: false,
          steps: [{ how: 'Робот браузера Яндекса', error: err.message }],
        });
        return;
      }
      res.status(err instanceof RobotRejectedError ? err.statusCode : 502).json({ detail: (err as Error).message });
    }
  });

  router.get('/api/forms-auto/diag/shot', requirePerm('admin.settings'), async (_req, res) => {
    try {
      const resp = await callRobot('GET', '/download/diag/shot', { raw: true });
      if (resp.status >= 400) {
        res.status(404).json({ detail: 'Скриншот отсутствует' });
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(resp.body);
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 404).json({ detail: (err as Error).message });
    }
  });

  router.get('/api/forms-auto/export-shot', requirePerm('admin.settings'), async (_req, res) => {
    try {
      const resp = await callRobot('GET', '/forms/export/shot', { raw: true });
      if (resp.status >= 400) {
        res.status(404).json({ detail: 'Скриншот отсутствует' });
        return;
      }
      res.setHeader('Content-Type', 'image/jpeg');
      res.setHeader('Cache-Control', 'no-store');
      res.send(resp.body);
    } catch (err) {
      res.status(err instanceof RobotUnavailableError ? 503 : 404).json({ detail: (err as Error).message });
    }
  });

  return router;
}
