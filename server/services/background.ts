import fs from 'node:fs';
import path from 'node:path';
import { BACKUP_DIR, DB_PATH, settings } from '../config.ts';
import { bumpStateRev, getDb, nowIso } from '../db.ts';
import { checkTcpPort, pingHost } from './networkCheck.ts';

export interface BackgroundTaskInfo {
  name: string;
  running: boolean;
  oneshot: boolean;
  lastRunAt: number | null;
  lastOk: boolean | null;
  lastError: string;
}

const taskRegistry = new Map<string, BackgroundTaskInfo>();
const runtimeFacts = new Map<string, unknown>();

export function setRuntimeFact(key: string, value: unknown): void {
  runtimeFacts.set(key, value);
}

export function getRuntimeFact<T = unknown>(key: string): T | null {
  return (runtimeFacts.get(key) as T) ?? null;
}

export function getTasksStatus(): BackgroundTaskInfo[] {
  return Array.from(taskRegistry.values());
}

function registerTask(name: string, oneshot = false): void {
  if (!taskRegistry.has(name)) {
    taskRegistry.set(name, {
      name,
      running: true,
      oneshot,
      lastRunAt: null,
      lastOk: null,
      lastError: '',
    });
  }
}

async function runTrackedTask(name: string, fn: () => Promise<void> | void, oneshot = false): Promise<void> {
  registerTask(name, oneshot);
  const entry = taskRegistry.get(name)!;
  try {
    await fn();
    entry.lastRunAt = Date.now();
    entry.lastOk = true;
    entry.lastError = '';
    if (oneshot) entry.running = false;
  } catch (err) {
    entry.lastRunAt = Date.now();
    entry.lastOk = false;
    entry.lastError = err instanceof Error ? err.message : String(err);
    if (oneshot) entry.running = false;
  }
}

// ============================================================
// 1. Automatic SQLite Backup + Recent Snapshots + Integrity
// ============================================================
const RECENT_SLOTS = 4;
const RECENT_INTERVAL_MS = 6 * 3600 * 1000;

function verifySqliteFile(filePath: string): { ok: boolean; detail: string } {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size < 4096) return { ok: false, detail: 'Размер копии подозрительно мал' };
    const fd = fs.openSync(filePath, 'r');
    const header = Buffer.alloc(16);
    fs.readSync(fd, header, 0, 16, 0);
    fs.closeSync(fd);
    if (!header.toString('utf-8').startsWith('SQLite format 3')) {
      return { ok: false, detail: 'Неверный заголовок SQLite' };
    }
    return { ok: true, detail: 'OK' };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

function writeBackupFile(targetPath: string): void {
  const tmpPath = `${targetPath}.part`;
  try {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    const db = getDb();
    try {
      db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
    } catch {
      fs.copyFileSync(DB_PATH, tmpPath);
    }
    const check = verifySqliteFile(tmpPath);
    setRuntimeFact('backup_verified', {
      ok: check.ok,
      detail: check.detail,
      at: Date.now() / 1000,
      file: path.basename(targetPath),
    });
    if (!check.ok) {
      throw new Error(`Копия не прошла проверку: ${check.detail}`);
    }
    fs.renameSync(tmpPath, targetPath);
  } catch (err) {
    try {
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      // ignore
    }
    throw err;
  }
}

export function runDailyBackupAndSnapshots(): void {
  const today = new Date().toISOString().slice(0, 10);
  const dailyPath = path.join(BACKUP_DIR, `calendar-${today}.db`);
  if (!fs.existsSync(dailyPath)) {
    writeBackupFile(dailyPath);
    const allDaily = fs
      .readdirSync(BACKUP_DIR)
      .filter((f) => /^calendar-\d{4}-\d{2}-\d{2}\.db$/.test(f))
      .sort();
    const excess = Math.max(0, allDaily.length - settings.backupRetention);
    for (let i = 0; i < excess; i++) {
      try {
        fs.unlinkSync(path.join(BACKUP_DIR, allDaily[i]));
      } catch {
        // ignore
      }
    }
  }

  const slots = Array.from({ length: RECENT_SLOTS }, (_, i) => path.join(BACKUP_DIR, `recent-${i}.db`));
  let newestMtime = 0;
  let oldestIdx = 0;
  let oldestMtime = Infinity;
  slots.forEach((slotPath, idx) => {
    let mtime = 0;
    try {
      if (fs.existsSync(slotPath)) mtime = fs.statSync(slotPath).mtimeMs;
    } catch {
      mtime = 0;
    }
    if (mtime > newestMtime) newestMtime = mtime;
    if (mtime < oldestMtime) {
      oldestMtime = mtime;
      oldestIdx = idx;
    }
  });
  if (Date.now() - newestMtime >= RECENT_INTERVAL_MS - 60_000) {
    writeBackupFile(slots[oldestIdx]);
  }
}

export function runIntegrityCheckNow(): { ok: boolean; seconds: number; detail: string; at: number } {
  const started = Date.now();
  const row = getDb().prepare('PRAGMA integrity_check').get() as { integrity_check: string } | undefined;
  const resultStr = row?.integrity_check || 'unknown';
  const ok = resultStr === 'ok';
  const seconds = Math.round(((Date.now() - started) / 1000) * 100) / 100;
  const fact = {
    ok,
    seconds,
    detail: ok ? 'OK' : resultStr,
    at: Date.now() / 1000,
  };
  setRuntimeFact('integrity', fact);
  return fact;
}

// ============================================================
// 2. Security Log Retention Cleanup
// ============================================================
export function runSecurityLogRetention(): number {
  const cutoff = new Date(Date.now() - settings.securityLogRetentionDays * 86400 * 1000).toISOString();
  const info = getDb().prepare('DELETE FROM security_events WHERE at < ?').run(cutoff);
  return Number(info.changes || 0);
}

// ============================================================
// 3. Automatic APK Group "Требуют повторного выезда" (kind='unrepaired')
// ============================================================
const UNREPAIRED_KIND = 'unrepaired';
const UNREPAIRED_NAME = 'Требуют повторного выезда';
const UNREPAIRED_DESC =
  'Ведётся автоматически. Сюда попадают комплексы, которые не работают и по которым выезд не помог (в отчёте последнего выезда «Не работает») или выезд на комплекс не состоялся (задание прошло без отчёта). Причина и «что нужно» берутся из отчёта. Как только комплекс исправлен (статус «Работает»), он сам уходит из подгруппы.';
const BROKEN_STATUSES = new Set([
  'Не работает',
  'Есть только пинг',
  'Расстрелян\\ Мех. повреждения',
  'Нет питания',
  'Не подведено питание',
]);
let lastUnrepairedSyncAt = 0;

export function syncUnrepairedGroup(force = false): { added: number; updated: number; removed: number; total: number } {
  const nowMs = Date.now();
  if (!force && nowMs - lastUnrepairedSyncAt < 10_000) {
    return { added: 0, updated: 0, removed: 0, total: 0 };
  }
  lastUnrepairedSyncAt = nowMs;

  const db = getDb();
  let group = db.prepare('SELECT id FROM apk_groups WHERE kind = ?').get(UNREPAIRED_KIND) as { id: number } | undefined;
  if (!group) {
    const existingByName = db
      .prepare("SELECT id FROM apk_groups WHERE lower(name) = lower(?) AND kind = ''")
      .get(UNREPAIRED_NAME) as { id: number } | undefined;
    if (existingByName) {
      db.prepare('UPDATE apk_groups SET kind = ?, description = ? WHERE id = ?').run(
        UNREPAIRED_KIND,
        UNREPAIRED_DESC,
        existingByName.id,
      );
      group = existingByName;
    } else {
      const info = db
        .prepare("INSERT INTO apk_groups (name, description, created_at, created_by, kind) VALUES (?, ?, ?, 'система', ?)")
        .run(UNREPAIRED_NAME, UNREPAIRED_DESC, nowIso(), UNREPAIRED_KIND);
      group = { id: Number(info.lastInsertRowid) };
    }
  }

  const todayStr = new Date().toISOString().slice(0, 10);
  const cutoffStr = new Date(Date.now() - 60 * 86400 * 1000).toISOString().slice(0, 10);

  const points = db
    .prepare('SELECT id, status, fault_reason, fault_need FROM points')
    .all() as Array<{ id: string; status: string; fault_reason: string; fault_need: string }>;
  const brokenPoints = new Map(points.filter((p) => BROKEN_STATUSES.has(p.status)).map((p) => [p.id, p]));

  const desired = new Map<string, { note: string; need: string; work_type: string }>();

  // 1) Latest visit report has "Не работает"
  const latestReports = db
    .prepare(
      `SELECT tvr.point_id, tvr.result_status, tvr.outcome, tvr.comment, tvr.fault, tvr.needs, tvr.visit_type, t.date
       FROM task_visit_reports tvr
       LEFT JOIN tasks t ON t.id = tvr.task_id
       ORDER BY COALESCE(t.date, substr(tvr.created_at, 1, 10)) DESC, tvr.id DESC`,
    )
    .all() as Array<{
      point_id: string;
      result_status: string;
      outcome: string;
      comment: string;
      fault: string | null;
      needs: string | null;
      visit_type: string;
      date: string | null;
    }>;

  const seenReportPoint = new Set<string>();
  for (const r of latestReports) {
    if (seenReportPoint.has(r.point_id)) continue;
    seenReportPoint.add(r.point_id);
    const pt = brokenPoints.get(r.point_id);
    if (!pt) continue;
    if (r.result_status === 'Не работает' || /не работает|не удалось/i.test(r.outcome || '')) {
      const note = (r.fault || pt.fault_reason || r.comment || 'По отчёту последнего выезда комплекс не работает').slice(0, 2000);
      const need = (r.needs || pt.fault_need || '').slice(0, 2000);
      desired.set(r.point_id, {
        note,
        need,
        work_type: 'Ремонт',
      });
    }
  }

  // 2) Tasks in the past 60 days without any visit report
  const missedTasks = db
    .prepare(
      `SELECT t.point, t.type, t.date, t.work
       FROM tasks t
       LEFT JOIN task_visit_reports tvr ON tvr.task_id = t.id
       WHERE tvr.id IS NULL
         AND t.point != ''
         AND t.type != 'Вспомогательная точка'
         AND COALESCE(NULLIF(t.date_to, ''), t.date) < ?
         AND t.date >= ?
       ORDER BY t.date DESC`,
    )
    .all(todayStr, cutoffStr) as Array<{ point: string; type: string; date: string; work: string }>;

  for (const t of missedTasks) {
    if (desired.has(t.point) || !brokenPoints.has(t.point)) continue;
    const pt = brokenPoints.get(t.point)!;
    const dParts = t.date.split('-');
    const dateRu = dParts.length === 3 ? `${dParts[2]}.${dParts[1]}.${dParts[0]}` : t.date;
    desired.set(t.point, {
      note: pt.fault_reason || `Выезд ${dateRu} (${t.type || 'работы'}) прошёл без отчёта`,
      need: pt.fault_need || t.work || '',
      work_type: t.type || 'Ремонт',
    });
  }

  const currentRows = db
    .prepare('SELECT point_id, note, need, work_type FROM apk_group_points WHERE group_id = ?')
    .all(group.id) as Array<{ point_id: string; note: string; need: string; work_type: string }>;
  const currentMap = new Map(currentRows.map((r) => [r.point_id, r]));

  let added = 0;
  let updated = 0;
  let removed = 0;
  const now = nowIso();

  for (const pid of currentMap.keys()) {
    if (!desired.has(pid)) {
      db.prepare('DELETE FROM apk_group_points WHERE group_id = ? AND point_id = ?').run(group.id, pid);
      removed += 1;
    }
  }

  for (const [pid, info] of desired.entries()) {
    const cur = currentMap.get(pid);
    if (!cur) {
      db.prepare(
        'INSERT OR IGNORE INTO apk_group_points (group_id, point_id, note, need, work_type, added_at) VALUES (?, ?, ?, ?, ?, ?)',
      ).run(group.id, pid, info.note, info.need, info.work_type, now);
      added += 1;
    } else if (cur.note !== info.note || cur.need !== info.need || cur.work_type !== info.work_type) {
      db.prepare('UPDATE apk_group_points SET note = ?, need = ?, work_type = ? WHERE group_id = ? AND point_id = ?').run(
        info.note,
        info.need,
        info.work_type,
        group.id,
        pid,
      );
      updated += 1;
    }
  }

  if (added || updated || removed) {
    bumpStateRev();
  }

  return { added, updated, removed, total: desired.size };
}

// ============================================================
// 4. Periodic Point Health Check Loop
// ============================================================
const AUTO_HEALTH_STATUSES = new Set(['Работает', 'Есть только пинг', 'Не работает', '']);
let healthCursor = 0;

export async function runPointHealthBatch(batchSize = 15): Promise<{ checked: number }> {
  const db = getDb();
  const points = db
    .prepare(
      "SELECT id, ip_address, port, status, port_down_since FROM points WHERE trim(ip_address) != '' ORDER BY id",
    )
    .all() as Array<{
      id: string;
      ip_address: string;
      port: string;
      status: string;
      port_down_since: string | null;
    }>;

  if (points.length === 0) {
    setRuntimeFact('health_tick', { at: Date.now() / 1000, total: 0, checked: 0 });
    return { checked: 0 };
  }

  const start = healthCursor % points.length;
  const slice: typeof points = [];
  for (let i = 0; i < Math.min(batchSize, points.length); i++) {
    slice.push(points[(start + i) % points.length]);
  }
  healthCursor = (start + slice.length) % points.length;

  let changed = false;
  for (const pt of slice) {
    const portNum = Number(pt.port) || 80;
    const [pingRes, tcpRes] = await Promise.all([
      pingHost(pt.ip_address, 1, 2),
      checkTcpPort(pt.ip_address, portNum, 2000, 1),
    ]);

    const now = nowIso();
    let newStatus = pt.status;
    if (AUTO_HEALTH_STATUSES.has(pt.status)) {
      if (tcpRes.ok) {
        newStatus = 'Работает';
      } else if (pingRes.ok) {
        newStatus = 'Есть только пинг';
      } else if (!pingRes.binary_missing) {
        newStatus = 'Не работает';
      }
    }

    const downSince = tcpRes.ok ? null : pt.port_down_since || now;
    if (newStatus !== pt.status) {
      db.prepare('UPDATE points SET status = ?, health_checked_at = ?, port_down_since = ? WHERE id = ?').run(
        newStatus,
        now,
        downSince,
        pt.id,
      );
      db.prepare(
        'INSERT INTO point_status_history (point_id, old_status, new_status, source, changed_at) VALUES (?, ?, ?, ?, ?)',
      ).run(pt.id, pt.status || '', newStatus, 'health_check', now);
      changed = true;
    } else {
      db.prepare('UPDATE points SET health_checked_at = ?, port_down_since = ? WHERE id = ?').run(now, downSince, pt.id);
    }
  }

  if (changed) {
    bumpStateRev();
  }
  setRuntimeFact('health_tick', { at: Date.now() / 1000, total: points.length, checked: slice.length });
  return { checked: slice.length };
}

// ============================================================
// 5. Start All Background Loops
// ============================================================
export function startBackgroundServices(): { stop: () => void } {
  const timers: Array<ReturnType<typeof setInterval> | ReturnType<typeof setTimeout>> = [];

  // Immediate startup tasks
  void runTrackedTask('копии базы', () => runDailyBackupAndSnapshots());
  void runTrackedTask('журнал безопасности', () => {
    runSecurityLogRetention();
  });
  void runTrackedTask('подгруппа «Требуют повторного выезда»', () => {
    syncUnrepairedGroup(true);
  });

  // First integrity check 60s after boot, then every 12h
  const integBootTimer = setTimeout(() => {
    void runTrackedTask('проверка целостности', () => {
      runIntegrityCheckNow();
    });
  }, 60_000);
  integBootTimer.unref?.();
  timers.push(integBootTimer);

  const integLoop = setInterval(() => {
    void runTrackedTask('проверка целостности', () => {
      runIntegrityCheckNow();
    });
  }, 12 * 3600 * 1000);
  integLoop.unref?.();
  timers.push(integLoop);

  // Daily backups & recent snapshots every 30 min
  const backupLoop = setInterval(() => {
    void runTrackedTask('копии базы', () => runDailyBackupAndSnapshots());
  }, 30 * 60 * 1000);
  backupLoop.unref?.();
  timers.push(backupLoop);

  // Security log retention every 24h
  const secLoop = setInterval(() => {
    void runTrackedTask('журнал безопасности', () => {
      runSecurityLogRetention();
    });
  }, 24 * 3600 * 1000);
  secLoop.unref?.();
  timers.push(secLoop);

  // Automatic unrepaired APK group sync every 10 min
  const groupLoop = setInterval(() => {
    void runTrackedTask('подгруппа «Требуют повторного выезда»', () => {
      syncUnrepairedGroup(true);
    });
  }, 10 * 60 * 1000);
  groupLoop.unref?.();
  timers.push(groupLoop);

  // Point health check loop every 2 min (only active when points with IPs exist)
  const healthLoop = setInterval(() => {
    void runTrackedTask('проверка связи с комплексами', async () => {
      await runPointHealthBatch(15);
    });
  }, 120 * 1000);
  healthLoop.unref?.();
  timers.push(healthLoop);

  return {
    stop: () => {
      for (const t of timers) {
        clearTimeout(t as ReturnType<typeof setTimeout>);
        clearInterval(t as ReturnType<typeof setInterval>);
      }
    },
  };
}
