import fs from 'node:fs';
import path from 'node:path';
import type { Express, Request, Response } from 'express';
import nunjucks from 'nunjucks';
import { AlignmentType, Document, Packer, Paragraph, Table, TableCell, TableRow, TextRun, WidthType } from 'docx';
import { getSessionUser } from './auth.ts';
import { ROOT_DIR, settings } from './config.ts';
import { getDb } from './db.ts';
import { hasAnyPerm, landingPage } from './permissions.ts';
import { decryptField } from './crypto.ts';

const TEMPLATES_DIR = path.join(ROOT_DIR, 'templates');
const STATIC_DIR = path.join(ROOT_DIR, 'static');

const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(TEMPLATES_DIR, { noCache: true }), {
  autoescape: true,
});

function assetUrl(relPath: string): string {
  const clean = relPath.replace(/^\/+/, '');
  const full = path.join(ROOT_DIR, clean);
  let ver = '1';
  try {
    ver = String(Math.floor(fs.statSync(full).mtimeMs));
  } catch {
    ver = '1';
  }
  return `/${clean}?v=${ver}`;
}

env.addGlobal('asset_url', assetUrl);
env.addGlobal('range', (n: number) => Array.from({ length: n }, (_, i) => i));

function renderTemplate(res: Response, name: string, ctx: Record<string, unknown> = {}): void {
  const fullPath = path.join(TEMPLATES_DIR, name);
  let raw = fs.readFileSync(fullPath, 'utf-8');
  // Convert Jinja2 Pythonisms used in plan_print.html / no_access.html
  raw = raw
    .replace(/team\.drivers\s+or\s+\[None\]/g, '(team.drivers if team.drivers and team.drivers.length else [null])')
    .replace(/team\.fitters\s+or\s+\[None\]/g, '(team.fitters if team.fitters and team.fitters.length else [null])');
  const html = env.renderString(raw, { app_name: settings.appName, ...ctx });
  res.type('text/html; charset=utf-8').send(html);
}

function pageGuard(req: Request, res: Response, ...needPerms: string[]): ReturnType<typeof getSessionUser> {
  const user = getSessionUser(req);
  if (!user) {
    res.redirect('/login');
    return null;
  }
  if (user.must_change_password) {
    res.redirect('/login');
    return null;
  }
  if (needPerms.length > 0 && !hasAnyPerm(user.permissions, needPerms)) {
    const dest = landingPage(user.permissions);
    if (dest !== req.path) {
      res.redirect(dest);
      return null;
    }
  }
  return user;
}

const MONTHS_GEN = [
  'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
];

function formatDateRu(isoDay: string): string {
  const parts = isoDay.split('-');
  if (parts.length !== 3) return isoDay;
  return `${parts[2]}.${parts[1]}.${parts[0]}`;
}

function renderPlanTitle(tpl: string, day: string): string {
  const [y, m, d] = day.split('-');
  const mIdx = Number(m) - 1;
  const monthName = MONTHS_GEN[mIdx] || m;
  return tpl
    .replace(/\{число\}/g, String(Number(d)))
    .replace(/\{месяц\}/g, monthName)
    .replace(/\{год\}/g, y)
    .replace(/\{дата\}/g, formatDateRu(day));
}

export function registerViewRoutes(app: Express): void {
  app.get('/favicon.ico', (_req, res) => {
    res.sendFile(path.join(STATIC_DIR, 'favicon.ico'));
  });

  app.get('/login', (req, res) => {
    const user = getSessionUser(req);
    if (user && !user.must_change_password) {
      res.redirect(landingPage(user.permissions));
      return;
    }
    renderTemplate(res, 'login.html');
  });

  app.get('/', (req, res) => {
    if (!pageGuard(req, res, 'calendar.view')) return;
    renderTemplate(res, 'index.html');
  });

  app.get('/no-access', (req, res) => {
    const user = pageGuard(req, res);
    if (!user) return;
    const dest = landingPage(user.permissions);
    if (dest !== '/no-access') {
      res.redirect(dest);
      return;
    }
    renderTemplate(res, 'no_access.html', { username: user.username, role_name: user.role_name });
  });

  app.get('/apk', (req, res) => {
    if (!pageGuard(req, res, 'points.view', 'check.use')) return;
    renderTemplate(res, 'apk.html', { yandex_maps_api_key: settings.yandexMapsApiKey });
  });

  app.get('/warehouse', (req, res) => {
    if (!pageGuard(req, res, 'warehouse.view')) return;
    renderTemplate(res, 'warehouse.html');
  });

  app.get('/absences', (req, res) => {
    if (!pageGuard(req, res, 'absences.view')) return;
    renderTemplate(res, 'absences.html');
  });

  app.get('/monitoring', (req, res) => {
    if (!pageGuard(req, res, 'monitoring.view')) return;
    renderTemplate(res, 'monitoring.html');
  });

  app.get('/notifications', (req, res) => {
    if (!pageGuard(req, res, 'notifications.view')) return;
    renderTemplate(res, 'notifications.html', { yandex_maps_api_key: settings.yandexMapsApiKey });
  });

  app.get('/reports', (req, res) => {
    if (!pageGuard(req, res, 'reports.view')) return;
    renderTemplate(res, 'reports.html');
  });

  app.get('/reports/builder', (req, res) => {
    if (!pageGuard(req, res, 'reports.builder')) return;
    renderTemplate(res, 'report_builder.html');
  });

  app.get('/stats', (req, res) => {
    if (!pageGuard(req, res, 'stats.view')) return;
    renderTemplate(res, 'stats.html');
  });

  app.get('/assistant', (req, res) => {
    if (!pageGuard(req, res, 'assistant.use')) return;
    renderTemplate(res, 'assistant.html');
  });

  app.get('/games', (req, res) => {
    const user = pageGuard(req, res);
    if (!user) return;
    const back = landingPage(user.permissions);
    renderTemplate(res, 'games.html', { back_url: back !== '/no-access' ? back : '/' });
  });

  app.get('/plan-print/:day', (req, res) => {
    const user = pageGuard(req, res, 'calendar.print');
    if (!user) return;
    const day = req.params.day;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
      res.status(400).send('Неверная дата');
      return;
    }

    const db = getDb();
    const tplRows = db
      .prepare("SELECT field_key, value FROM report_field_values WHERE report_type = 'plan_template' AND period = 'global'")
      .all() as Array<{ field_key: string; value: string }>;
    const tpl: Record<string, string> = {};
    for (const r of tplRows) tpl[r.field_key] = r.value;

    const crews = db
      .prepare('SELECT * FROM crews WHERE date = ? ORDER BY id')
      .all(day) as Array<{
        id: number;
        date: string;
        name: string;
        equip: string;
        place: string;
        trip_id: string | null;
      }>;

    const allTasks = db
      .prepare("SELECT * FROM tasks WHERE date = ? AND type != 'Вспомогательная точка'")
      .all(day) as Array<{ id: string; team: number; point: string; type: string }>;

    const ROLE_LABEL: Record<string, string> = { fitter: 'Электромонтер', driver: 'Водитель', operator: 'Оператор' };
    const DRIVER_LABEL: Record<string, string> = { tower: 'Водитель вышки', cover: 'Водитель прикрытия' };
    const PLAN_TYPE_LABELS: Record<string, string> = { Ремонт: 'Восстановление АПК', Опиловка: 'Опиловка АПК' };

    const teamBlocks = [];
    for (const c of crews) {
      const dayTasks = allTasks.filter((t) => Number(t.team) === Number(c.id));
      if (dayTasks.length === 0) continue;

      const members = db
        .prepare(
          'SELECT p.id, p.full_name, p.phone, p.role_type, p.driver_kind FROM crew_members cm JOIN people p ON p.id = cm.person_id WHERE cm.crew_id = ? ORDER BY p.id',
        )
        .all(c.id) as Array<{ id: number; full_name: string; phone: string | null; role_type: string; driver_kind: string }>;

      const fitters: string[] = [];
      const drivers: string[] = [];
      const composition: Array<{ role: string; name: string }> = [];

      for (const m of members) {
        const fullName = decryptField(m.full_name);
        const phone = decryptField(m.phone);
        if (m.role_type === 'fitter') fitters.push(fullName);
        if (m.role_type === 'driver') drivers.push(fullName);
        const roleLabel =
          m.role_type === 'driver' && m.driver_kind && DRIVER_LABEL[m.driver_kind]
            ? DRIVER_LABEL[m.driver_kind]
            : ROLE_LABEL[m.role_type] || m.role_type;
        const displayName = m.role_type === 'operator' && phone ? `${fullName} (тел. ${phone})` : fullName;
        composition.push({ role: roleLabel, name: displayName });
      }

      const rows: Array<{ n: number; title: string; sub: string; count?: number }> = [];
      let invRow: { n: number; title: string; sub: string; count: number } | null = null;
      for (const t of dayTasks) {
        const kind = (t.type || '').trim();
        if (kind === 'Инвентаризация') {
          if (!invRow) {
            invRow = { n: rows.length + 1, title: 'Инвентаризация', sub: '', count: 0 };
            rows.push(invRow);
          }
          invRow.count += 1;
        } else {
          rows.push({
            n: rows.length + 1,
            title: PLAN_TYPE_LABELS[kind] || kind || 'Работы',
            sub: t.point || '',
          });
        }
      }
      if (invRow) invRow.sub = `Кол-во АПК: ${invRow.count}шт`;

      const place = (c.place || '').trim();
      const placeText = !place
        ? ''
        : /^(по |в |на |вдоль |около )/i.test(place)
          ? place
          : `в ${place}`;

      teamBlocks.push({
        name: c.name,
        fitters,
        drivers,
        composition,
        place_text: placeText,
        rows,
      });
    }

    const routeLabelOverride = typeof req.query.route_label === 'string' ? req.query.route_label.trim() : '';
    const rawTitle = (tpl.plan_title || '').trim() || 'ПЛАН-ЗАДАНИЕ на {число} {месяц} {год} г.';

    renderTemplate(res, 'plan_print.html', {
      day,
      day_display: formatDateRu(day),
      teams: teamBlocks,
      plan_title: renderPlanTitle(rawTitle, day),
      org_title: tpl.org_title || settings.planOrgTitle,
      approver_name: tpl.approver_name || settings.planApproverName,
      route_label: routeLabelOverride || tpl.route_label || settings.planRouteLabel,
      safety_officer: tpl.safety_officer || settings.planSafetyOfficer,
      second_approver_title: tpl.second_approver_title || settings.planSecondApproverTitle,
      second_approver_name: tpl.second_approver_name || settings.planSecondApproverName,
      plan_title_size_pt: Math.min(24, Math.max(12, Number(tpl.plan_title_size_pt || 15))),
      plan_header_shift_mm: Math.min(15, Math.max(-15, Number(tpl.plan_header_shift_mm || 0))),
      plan_title_align: ['left', 'center', 'right'].includes(tpl.plan_title_align) ? tpl.plan_title_align : 'center',
    });
  });

  app.post('/plan-print/docx', async (req, res) => {
    const user = pageGuard(req, res, 'calendar.print');
    if (!user) return;
    try {
      const payload = req.body || {};
      const pages: Array<{
        title?: string;
        org_title?: string;
        composition?: Array<{ role: string; name: string }>;
        rows?: Array<{ n?: number; title?: string; sub?: string }>;
      }> = Array.isArray(payload.pages) ? payload.pages : Array.isArray(payload.teams) ? payload.teams : [];

      const sections = (pages.length ? pages : [{ title: `План-задание ${payload.day || ''}`, rows: [] }]).map(
        (page) => {
          const children: Array<Paragraph | Table> = [];
          if (page.org_title) {
            children.push(
              new Paragraph({
                alignment: AlignmentType.RIGHT,
                children: [new TextRun({ text: String(page.org_title), size: 20 })],
              }),
            );
          }
          children.push(
            new Paragraph({
              alignment: AlignmentType.CENTER,
              spacing: { before: 200, after: 200 },
              children: [new TextRun({ text: String(page.title || payload.title || 'ПЛАН-ЗАДАНИЕ'), bold: true, size: 28 })],
            }),
          );
          if (Array.isArray(page.composition)) {
            for (const c of page.composition) {
              children.push(
                new Paragraph({
                  children: [new TextRun({ text: `${c.role || ''}: ${c.name || ''}`, size: 22 })],
                }),
              );
            }
          }
          const tableRows = [
            new TableRow({
              children: [
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '№', bold: true })] })] }),
                new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: 'Вид работ / Комплекс', bold: true })] })] }),
              ],
            }),
            ...(page.rows || []).map(
              (r, idx) =>
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph(String(r.n ?? idx + 1))] }),
                    new TableCell({
                      children: [new Paragraph(`${r.title || ''}${r.sub ? ` — ${r.sub}` : ''}`)],
                    }),
                  ],
                }),
            ),
          ];
          children.push(
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: tableRows,
            }),
          );
          return { children };
        },
      );

      const doc = new Document({ sections });
      const buf = await Packer.toBuffer(doc);
      const dayStr = String(payload.day || '').replace(/[^0-9-]/g, '') || 'plan';
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
      res.setHeader('Content-Disposition', `attachment; filename="plan-zadanie-${dayStr}.docx"`);
      res.send(buf);
    } catch (err) {
      res.status(400).json({ detail: `Не удалось собрать Word-файл: ${(err as Error).message}` });
    }
  });
}
