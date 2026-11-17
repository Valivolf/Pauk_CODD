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

const { initDb, getDb, migrateCoddSpiderGeneratedColumns } = await import('../db.ts');
const { decryptField, encryptField } = await import('../crypto.ts');
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

  it('migrates CODD_SPIDER virtual generated columns (lc_dec_pph / lc_dec_pfn) and decrypts AESGCM with AAD', () => {
    initDb();
    const db = getDb();

    // Simulate CODD_SPIDER schema with *_enc and VIRTUAL GENERATED ALWAYS AS (lc_dec_*(...))
    db.exec('DROP TABLE IF EXISTS people_codd_test');
    db.exec('ALTER TABLE people RENAME COLUMN full_name TO full_name_enc');
    db.exec('ALTER TABLE people RENAME COLUMN phone TO phone_enc');
    db.exec('ALTER TABLE people ADD COLUMN full_name TEXT GENERATED ALWAYS AS (lc_dec_pfn(full_name_enc)) VIRTUAL');
    db.exec('ALTER TABLE people ADD COLUMN phone TEXT GENERATED ALWAYS AS (lc_dec_pph(phone_enc)) VIRTUAL');

    const encName = encryptField('Иванов Иван Иванович', 'people.full_name');
    const encPhone = encryptField('+7 999 123-45-67', 'people.phone');
    db.prepare(
      "INSERT INTO people (full_name_enc, phone_enc, role_type, active, created_at) VALUES (?, ?, 'fitter', 1, ?)",
    ).run(encName, encPhone, new Date().toISOString());

    // Verify PRAGMA integrity_check works even while virtual generated columns exist
    const rowBefore = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
    assert.equal(rowBefore.integrity_check, 'ok');

    // Run migration to drop virtual columns and rename *_enc -> standard columns
    migrateCoddSpiderGeneratedColumns(db);

    const person = db
      .prepare('SELECT full_name, phone FROM people WHERE full_name = ?')
      .get(encName) as { full_name: string; phone: string } | undefined;
    assert.ok(person);
    assert.equal(decryptField(person.full_name), 'Иванов Иван Иванович');
    assert.equal(decryptField(person.phone), '+7 999 123-45-67');
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

  it('returns CODD_SPIDER-compatible response shapes for APK and warehouse APIs', async () => {
    initDb();
    const db = getDb();
    const express = (await import('express')).default;
    const cookieParser = (await import('cookie-parser')).default;
    const { createPointsRouter } = await import('../routes/points.ts');
    const { createEquipmentRouter } = await import('../routes/equipment.ts');
    const { createAccessToken, permissionGuard } = await import('../auth.ts');
    const { settings } = await import('../config.ts');

    // Ensure an admin user exists for auth cookie
    const now = new Date().toISOString();
    db.prepare(
      "INSERT OR IGNORE INTO users (username, password_hash, role, created_at) VALUES ('test_admin', 'x', 'admin', ?)",
    ).run(now);
    const admin = db
      .prepare("SELECT id, username, role, token_version FROM users WHERE username = 'test_admin'")
      .get() as { id: number; username: string; role: string; token_version: number };
    const token = createAccessToken(admin);

    const app = express();
    app.use(express.json());
    app.use(cookieParser());
    app.use(permissionGuard);
    app.use(createPointsRouter());
    app.use(createEquipmentRouter());

    const srv = await new Promise<import('node:http').Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const port = (srv.address() as net.AddressInfo).port;
    const base = `http://127.0.0.1:${port}`;
    const headers = { Cookie: `${settings.cookieName}=${token}` };

    try {
      // 1. /api/point-categories -> must include numeric point_count
      const catRes = await fetch(`${base}/api/point-categories`, { headers });
      assert.equal(catRes.status, 200);
      const cats = (await catRes.json()) as Array<{ id: number; name: string; point_count?: number }>;
      assert.ok(Array.isArray(cats));
      assert.ok(cats.length > 0);
      for (const c of cats) {
        assert.equal(typeof c.point_count, 'number');
      }

      // 2. /api/apk-groups -> must include numeric count and types map
      const grpRes = await fetch(`${base}/api/apk-groups`, { headers });
      assert.equal(grpRes.status, 200);
      const grps = (await grpRes.json()) as Array<{ id: number; name: string; count?: number; types?: Record<string, number> }>;
      assert.ok(Array.isArray(grps));
      assert.ok(grps.length > 0);
      for (const g of grps) {
        assert.equal(typeof g.count, 'number');
        assert.equal(typeof g.types, 'object');
      }

      // 3. /api/equipment/items -> must return Array (for list.filter) + X-Total-Count header
      const eqRes = await fetch(`${base}/api/equipment/items?limit=10&offset=0`, { headers });
      assert.equal(eqRes.status, 200);
      assert.ok(eqRes.headers.get('x-total-count') !== null);
      const eqList = await eqRes.json();
      assert.ok(Array.isArray(eqList));

      // 4. /api/equipment/history -> must include items (Array) and action_types (Array)
      const histRes = await fetch(`${base}/api/equipment/history?limit=10`, { headers });
      assert.equal(histRes.status, 200);
      const hist = (await histRes.json()) as { items: unknown[]; action_types: unknown[]; total: number };
      assert.ok(Array.isArray(hist.items));
      assert.ok(Array.isArray(hist.action_types));

      // 5. /api/equipment/reports/summary -> must include columns, rows (Array), totals
      const sumRes = await fetch(`${base}/api/equipment/reports/summary`, { headers });
      assert.equal(sumRes.status, 200);
      const summary = (await sumRes.json()) as { columns: unknown[]; rows: unknown[]; totals: Record<string, number> };
      assert.ok(Array.isArray(summary.columns));
      assert.ok(Array.isArray(summary.rows));
      assert.equal(typeof summary.totals, 'object');
    } finally {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
    }
  });

  it('parses SMB UNC share paths, matches complex folders, and reads CODD_SPIDER photo_storage config', async () => {
    initDb();
    const db = getDb();
    const {
      parseSharePath,
      matchFoldersToPoints,
      loadSavedSmbConfig,
      getPhotoStorageConfigView,
    } = await import('./photoStorage.ts');

    // 1. UNC / smb:// path parsing
    assert.deepEqual(parseSharePath('\\\\10.13.192.10\\photos\\АПК\\2026'), {
      server: '10.13.192.10',
      share: 'photos',
      folder: 'АПК/2026',
    });
    assert.deepEqual(parseSharePath('smb://nas.local/archive'), {
      server: 'nas.local',
      share: 'archive',
      folder: '',
    });

    // 2. Complex folder matching (exact, Cyrillic/Latin lookalike, and prefix/token)
    const matchRes = matchFoldersToPoints(
      ['TEST-101', 'АПК C0123 Краснодар', 'UnknownFolder'],
      ['TEST-101', 'С0123'],
    );
    assert.equal(matchRes.matches.get('TEST-101'), 'TEST-101');
    assert.equal(matchRes.matches.get('АПК C0123 Краснодар'), 'С0123');
    assert.equal(matchRes.matches.has('UnknownFolder'), false);

    // 3. Compatibility with CODD_SPIDER app_flags key = 'photo_storage' and AAD = 'photo_storage.password'
    const rawCfg = {
      mode: 'smb',
      server: '10.13.192.10',
      share: 'photo_share',
      folder: 'АПК',
      port: 445,
      domain: 'WORKGROUP',
      username: 'smbuser',
      password: encryptField('SecretPass123', 'photo_storage.password'),
      organize: true,
    };
    db.prepare(
      "INSERT OR REPLACE INTO app_flags (key, value) VALUES ('photo_storage', ?)",
    ).run(JSON.stringify(rawCfg));

    const loaded = loadSavedSmbConfig();
    assert.equal(loaded.mode, 'smb');
    assert.equal(loaded.server, '10.13.192.10');
    assert.equal(loaded.share, 'photo_share');
    assert.equal(loaded.folder, 'АПК');
    assert.equal(loaded.username, 'smbuser');
    assert.equal(loaded.password, 'SecretPass123');

    const view = getPhotoStorageConfigView(loaded);
    assert.equal(view.mode, 'smb');
    assert.equal(view.path, '\\\\10.13.192.10\\photo_share\\АПК');
    assert.equal(view.password_set, true);
  });
});


