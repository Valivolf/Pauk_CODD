import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codd-unit-'));
process.env.DATA_DIR = path.join(tmpRoot, 'data');
process.env.BACKUP_DIR = path.join(tmpRoot, 'backups');
process.env.PHOTOS_DIR = path.join(tmpRoot, 'photos');
process.env.SECURITY_LOG_RETENTION_DAYS = '30';

const { initDb, getDb } = await import('../db.ts');
const {
  runDailyBackupAndSnapshots,
  runIntegrityCheckNow,
  runSecurityLogRetention,
  syncUnrepairedGroup,
} = await import('./background.ts');
const { checkTcpPort, pingHost } = await import('./networkCheck.ts');

after(() => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    // ignore cleanup error
  }
});

describe('networkCheck service', () => {
  it('rejects empty IP and out-of-range port', async () => {
    const p1 = await pingHost('');
    assert.equal(p1.ok, false);
    const p2 = await checkTcpPort('', 80);
    assert.equal(p2.ok, false);
    const p3 = await checkTcpPort('127.0.0.1', 70000);
    assert.equal(p3.ok, false);
  });

  it('connects to an active local TCP server', async () => {
    const server = net.createServer((sock) => sock.end());
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const addr = server.address() as net.AddressInfo;
    try {
      const res = await checkTcpPort('127.0.0.1', addr.port, 1000, 1);
      assert.equal(res.ok, true);
      assert.ok(res.latency_ms !== null && res.latency_ms >= 0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe('background maintenance services', () => {
  it('initializes DB, verifies integrity, and creates verified backup + snapshot', () => {
    initDb();
    const integrity = runIntegrityCheckNow();
    assert.equal(integrity.ok, true);
    assert.equal(integrity.detail, 'OK');

    runDailyBackupAndSnapshots();
    const files = fs.readdirSync(process.env.BACKUP_DIR!);
    assert.ok(files.some((f) => /^calendar-\d{4}-\d{2}-\d{2}\.db$/.test(f)));
    assert.ok(files.some((f) => f === 'recent-0.db'));
  });

  it('syncs unrepaired APK group automatically when report is failed vs fixed', () => {
    initDb();
    const db = getDb();
    const now = new Date().toISOString();
    db.prepare("INSERT OR REPLACE INTO points (id, address, status) VALUES ('TEST-101', 'ул. Тест', 'Не работает')").run();
    db.prepare(
      "INSERT OR REPLACE INTO task_visit_reports (task_id, point_id, visit_type, result_status, comment, outcome, created_at, updated_at) VALUES ('t_rep_1', 'TEST-101', 'Ремонт', 'Не работает', 'Нет 220В', 'failed', ?, ?)",
    ).run(now, now);

    syncUnrepairedGroup(true);
    const grp = db.prepare("SELECT id FROM apk_groups WHERE kind = 'unrepaired'").get() as { id: number } | undefined;
    assert.ok(grp);
    const inGrp = db
      .prepare("SELECT point_id FROM apk_group_points WHERE group_id = ? AND point_id = 'TEST-101'")
      .get(grp.id) as { point_id: string } | undefined;
    assert.ok(inGrp);

    // Fix the point -> should auto-remove from unrepaired group
    const later = new Date(Date.now() + 5000).toISOString();
    db.prepare(
      "INSERT OR REPLACE INTO task_visit_reports (task_id, point_id, visit_type, result_status, comment, outcome, created_at, updated_at) VALUES ('t_rep_2', 'TEST-101', 'Ремонт', 'Работает', 'Починили', 'fixed', ?, ?)",
    ).run(later, later);
    syncUnrepairedGroup(true);
    const stillInGrp = db
      .prepare("SELECT point_id FROM apk_group_points WHERE group_id = ? AND point_id = 'TEST-101'")
      .get(grp.id);
    assert.equal(stillInGrp, undefined);
  });

  it('prunes expired security_events older than retention threshold', () => {
    initDb();
    const db = getDb();
    const oldTs = new Date(Date.now() - 45 * 86400 * 1000).toISOString();
    const freshTs = new Date().toISOString();
    db.prepare("INSERT INTO security_events (at, kind, username, ok) VALUES (?, 'login', 'old_user', 1)").run(oldTs);
    db.prepare("INSERT INTO security_events (at, kind, username, ok) VALUES (?, 'login', 'fresh_user', 1)").run(freshTs);

    const deleted = runSecurityLogRetention();
    assert.ok(deleted >= 1);
    const oldRow = db.prepare("SELECT id FROM security_events WHERE username = 'old_user'").get();
    const freshRow = db.prepare("SELECT id FROM security_events WHERE username = 'fresh_user'").get();
    assert.equal(oldRow, undefined);
    assert.ok(freshRow);
  });
});
