import { DatabaseSync } from 'node:sqlite';
import bcrypt from 'bcryptjs';
import { DB_PATH, settings } from './config.ts';
import { BUILTIN_ROLES, expandPerms } from './permissions.ts';

let dbInstance: DatabaseSync | null = null;

export function getDb(): DatabaseSync {
  if (!dbInstance) {
    dbInstance = new DatabaseSync(DB_PATH);
    dbInstance.exec('PRAGMA journal_mode = WAL;');
    dbInstance.exec('PRAGMA foreign_keys = ON;');
    dbInstance.exec('PRAGMA busy_timeout = 10000;');
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}

export function reopenDb(): DatabaseSync {
  closeDb();
  return getDb();
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function bumpStateRev(): number {
  const db = getDb();
  const row = db.prepare('SELECT rev FROM state_rev WHERE id = 1').get() as { rev: number } | undefined;
  const next = (row?.rev ?? 0) + 1;
  db.prepare('INSERT INTO state_rev (id, rev) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET rev = excluded.rev').run(next);
  return next;
}

export function getStateRev(): number {
  const db = getDb();
  const row = db.prepare('SELECT rev FROM state_rev WHERE id = 1').get() as { rev: number } | undefined;
  return row?.rev ?? 0;
}

export function initDb(): void {
  const db = getDb();

  db.exec(`
    CREATE TABLE IF NOT EXISTS app_flags (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS state_rev (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      rev INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS roles (
      key TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      permissions TEXT NOT NULL DEFAULT '[]',
      is_system INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user',
      must_change_password INTEGER NOT NULL DEFAULT 0,
      token_version INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS account_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sender_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      recipient_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      text TEXT NOT NULL DEFAULT '',
      reply_to INTEGER REFERENCES account_messages(id) ON DELETE SET NULL,
      created_at TEXT NOT NULL,
      edited_at TEXT,
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_account_msg_pair ON account_messages(sender_id, recipient_id, id);

    CREATE TABLE IF NOT EXISTS account_message_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES account_messages(id) ON DELETE CASCADE,
      file_name TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      size INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      deleted_at TEXT
    );

    CREATE TABLE IF NOT EXISTS user_games (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      enabled INTEGER NOT NULL DEFAULT 0,
      games TEXT
    );

    CREATE TABLE IF NOT EXISTS game_scores (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      game TEXT NOT NULL,
      best REAL NOT NULL,
      plays INTEGER NOT NULL DEFAULT 0,
      best_at TEXT NOT NULL,
      last_at TEXT NOT NULL,
      PRIMARY KEY (user_id, game)
    );

    CREATE TABLE IF NOT EXISTS security_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      kind TEXT NOT NULL,
      username TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      ip TEXT NOT NULL DEFAULT '',
      ok INTEGER NOT NULL DEFAULT 1,
      details TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_sec_events_at ON security_events(at);

    CREATE TABLE IF NOT EXISTS people (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      full_name TEXT NOT NULL,
      phone TEXT,
      role_type TEXT NOT NULL CHECK (role_type IN ('fitter','driver','operator','warehouse')),
      vk_id INTEGER UNIQUE,
      active INTEGER NOT NULL DEFAULT 1,
      notes TEXT,
      driver_kind TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS people_absences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL,
      reason TEXT,
      created_by TEXT,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS point_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#6366f1',
      match_pattern TEXT,
      is_legacy INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS points (
      id TEXT PRIMARY KEY,
      address TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '',
      lat TEXT NOT NULL DEFAULT '',
      lon TEXT NOT NULL DEFAULT '',
      inventory_number TEXT NOT NULL DEFAULT '',
      sim_number TEXT NOT NULL DEFAULT '',
      ip_address TEXT NOT NULL DEFAULT '',
      port TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      category_id INTEGER REFERENCES point_categories(id),
      login TEXT NOT NULL DEFAULT '',
      password TEXT NOT NULL DEFAULT '',
      verification_valid_until TEXT NOT NULL DEFAULT '',
      power_source TEXT NOT NULL DEFAULT '',
      port_down_since TEXT,
      health_checked_at TEXT,
      fault_reason TEXT NOT NULL DEFAULT '',
      fault_need TEXT NOT NULL DEFAULT '',
      fault_at TEXT NOT NULL DEFAULT '',
      fault_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS point_sim_links (
      point_id TEXT PRIMARY KEY,
      group_id INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_point_sim_links_group ON point_sim_links(group_id);

    CREATE TABLE IF NOT EXISTS work_types (
      name TEXT PRIMARY KEY,
      is_repair INTEGER NOT NULL DEFAULT 0,
      bot_tools INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS work_type_outcomes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type_name TEXT NOT NULL,
      label TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_wto_type ON work_type_outcomes(type_name);

    CREATE TABLE IF NOT EXISTS point_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#64748b',
      is_auto INTEGER NOT NULL DEFAULT 0,
      protected INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS warehouse_items (
      point_id TEXT PRIMARY KEY REFERENCES points(id) ON DELETE CASCADE ON UPDATE CASCADE,
      box_state TEXT,
      camera_state TEXT,
      board_state TEXT,
      web_status TEXT,
      received_at TEXT,
      info TEXT,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS point_components (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL REFERENCES points(id) ON DELETE CASCADE ON UPDATE CASCADE,
      name TEXT NOT NULL,
      in_stock INTEGER NOT NULL DEFAULT 0,
      description TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS point_status_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      old_status TEXT NOT NULL DEFAULT '',
      new_status TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL,
      task_id TEXT,
      changed_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_psh_task ON point_status_history(task_id);
    CREATE INDEX IF NOT EXISTS idx_psh_point_status_at ON point_status_history(point_id, new_status, changed_at);

    CREATE TABLE IF NOT EXISTS crews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      equip TEXT NOT NULL DEFAULT 'Лестница',
      map_link TEXT NOT NULL DEFAULT '',
      trip_id TEXT,
      place TEXT NOT NULL DEFAULT '',
      contractor INTEGER NOT NULL DEFAULT 0,
      contractor_note TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_crews_date ON crews(date);
    CREATE INDEX IF NOT EXISTS idx_crews_trip ON crews(trip_id);

    CREATE TABLE IF NOT EXISTS crew_members (
      crew_id INTEGER NOT NULL REFERENCES crews(id) ON DELETE CASCADE,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      PRIMARY KEY (crew_id, person_id)
    );

    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      date TEXT NOT NULL,
      team INTEGER NOT NULL,
      point TEXT NOT NULL DEFAULT '',
      work TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      hours REAL NOT NULL DEFAULT 0,
      travel REAL NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      trip_id TEXT,
      date_to TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      aux_lat TEXT NOT NULL DEFAULT '',
      aux_lon TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tasks_date ON tasks(date);
    CREATE INDEX IF NOT EXISTS idx_tasks_point_type_date ON tasks(point, type, date);

    CREATE TABLE IF NOT EXISTS aux_task_done (
      task_id TEXT PRIMARY KEY,
      done_at TEXT NOT NULL,
      done_by TEXT
    );

    CREATE TABLE IF NOT EXISTS task_visit_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL UNIQUE,
      point_id TEXT NOT NULL,
      visit_type TEXT NOT NULL,
      result_status TEXT NOT NULL DEFAULT '',
      comment TEXT NOT NULL DEFAULT '',
      equipment_removed TEXT,
      equipment_installed TEXT,
      outcome TEXT NOT NULL DEFAULT '',
      fault TEXT,
      needs TEXT,
      author_person_id INTEGER,
      updated_by TEXT,
      imported INTEGER NOT NULL DEFAULT 0,
      import_batch TEXT NOT NULL DEFAULT '',
      sim_removed TEXT,
      sim_installed TEXT,
      sim_removed_state TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_tvr_point ON task_visit_reports(point_id);

    CREATE TABLE IF NOT EXISTS forms_import_rows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      row_hash TEXT NOT NULL UNIQUE,
      batch TEXT NOT NULL DEFAULT '',
      form_time TEXT NOT NULL DEFAULT '',
      raw_point TEXT NOT NULL DEFAULT '',
      point_id TEXT,
      task_id TEXT,
      task_date TEXT,
      crew_text TEXT NOT NULL DEFAULT '',
      status_text TEXT NOT NULL DEFAULT '',
      result_text TEXT NOT NULL DEFAULT '',
      power_text TEXT NOT NULL DEFAULT '',
      sim_text TEXT NOT NULL DEFAULT '',
      location_text TEXT NOT NULL DEFAULT '',
      inventory_text TEXT NOT NULL DEFAULT '',
      equipment_text TEXT NOT NULL DEFAULT '',
      photo_urls TEXT NOT NULL DEFAULT '[]',
      photos_total INTEGER NOT NULL DEFAULT 0,
      photos_done INTEGER NOT NULL DEFAULT 0,
      photos_state TEXT NOT NULL DEFAULT '',
      photos_error TEXT NOT NULL DEFAULT '',
      outcome TEXT NOT NULL DEFAULT '',
      outcome_note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS report_field_values (
      report_type TEXT NOT NULL,
      period TEXT NOT NULL,
      field_key TEXT NOT NULL,
      value TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      updated_by TEXT,
      PRIMARY KEY (report_type, period, field_key)
    );

    CREATE TABLE IF NOT EXISTS report_templates (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      file_type TEXT NOT NULL,
      mode TEXT NOT NULL,
      variables TEXT NOT NULL DEFAULT '[]',
      visibility TEXT NOT NULL DEFAULT 'public',
      shared_users TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS report_designs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      format TEXT NOT NULL,
      design TEXT NOT NULL,
      visibility TEXT NOT NULL DEFAULT 'public',
      shared_users TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_by TEXT
    );

    CREATE TABLE IF NOT EXISTS bot_work_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      person_id INTEGER NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT
    );

    CREATE TABLE IF NOT EXISTS bot_task_progress (
      task_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      updated_by TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      person_id INTEGER NOT NULL REFERENCES people(id) ON DELETE CASCADE,
      direction TEXT NOT NULL,
      text TEXT NOT NULL,
      author TEXT,
      point_id TEXT,
      task_id TEXT,
      broadcast_id INTEGER,
      created_at TEXT NOT NULL,
      read_at TEXT,
      claimed_at TEXT,
      delivered_at TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      delivery_error TEXT,
      failed_at TEXT
    );

    CREATE TABLE IF NOT EXISTS chat_attachments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      message_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
      file_ext TEXT NOT NULL,
      file_name TEXT,
      size INTEGER NOT NULL DEFAULT 0,
      src_id INTEGER,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chat_broadcasts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at TEXT NOT NULL,
      author TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'pick',
      filter_desc TEXT NOT NULL DEFAULT '',
      total INTEGER NOT NULL DEFAULT 0,
      token TEXT UNIQUE
    );

    CREATE TABLE IF NOT EXISTS visit_photos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      taken_date TEXT NOT NULL,
      file_ext TEXT NOT NULL,
      uploaded_at TEXT NOT NULL,
      uploaded_by TEXT,
      storage TEXT NOT NULL DEFAULT 'local',
      storage_path TEXT NOT NULL DEFAULT '',
      rel_path TEXT,
      source TEXT,
      file_name TEXT,
      file_size INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_vp_point ON visit_photos(point_id);
    CREATE INDEX IF NOT EXISTS idx_vp_date ON visit_photos(taken_date);

    CREATE TABLE IF NOT EXISTS verification_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      resolved_by TEXT,
      issue_comment TEXT
    );

    CREATE TABLE IF NOT EXISTS bot_join_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vk_id INTEGER NOT NULL UNIQUE,
      vk_name TEXT,
      status TEXT NOT NULL DEFAULT 'pending',
      requested_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_by TEXT
    );

    CREATE TABLE IF NOT EXISTS bot_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      enabled INTEGER NOT NULL DEFAULT 1,
      extra_json TEXT NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS access_issue_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      resolved_by TEXT,
      demontage_note TEXT
    );

    CREATE TABLE IF NOT EXISTS demontage_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      reason TEXT NOT NULL DEFAULT '',
      initiated_by TEXT NOT NULL DEFAULT 'fitter',
      kind TEXT NOT NULL DEFAULT 'demontage',
      created_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      resolved_at TEXT,
      resolved_by TEXT,
      decline_comment TEXT
    );

    CREATE TABLE IF NOT EXISTS sim_ip_registry (
      sim_number TEXT PRIMARY KEY,
      ip_address TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS yandex_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_key TEXT NOT NULL UNIQUE,
      crew_id INTEGER NOT NULL,
      map_id TEXT NOT NULL,
      url TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      rows_json TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      work_date TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS yandex_trash (
      map_id TEXT PRIMARY KEY,
      reason TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS live_maps (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      params_json TEXT NOT NULL DEFAULT '',
      membership TEXT NOT NULL DEFAULT 'fixed',
      members_json TEXT NOT NULL DEFAULT '',
      interval_minutes INTEGER NOT NULL DEFAULT 5,
      enabled INTEGER NOT NULL DEFAULT 1,
      map_id TEXT NOT NULL DEFAULT '',
      url TEXT NOT NULL DEFAULT '',
      rows_json TEXT NOT NULL DEFAULT '',
      signature TEXT NOT NULL DEFAULT '',
      synced_name TEXT NOT NULL DEFAULT '',
      points_count INTEGER NOT NULL DEFAULT 0,
      skipped INTEGER NOT NULL DEFAULT 0,
      last_check_ts REAL NOT NULL DEFAULT 0,
      last_sync TEXT NOT NULL DEFAULT '',
      last_error TEXT NOT NULL DEFAULT '',
      created_by TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS yandex_robot_settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS point_plans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      priority INTEGER NOT NULL DEFAULT 0,
      group_name TEXT NOT NULL DEFAULT '',
      work_type TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS apk_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT '',
      auto_remove INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS apk_group_points (
      group_id INTEGER NOT NULL REFERENCES apk_groups(id) ON DELETE CASCADE,
      point_id TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      need TEXT NOT NULL DEFAULT '',
      work_type TEXT NOT NULL DEFAULT '',
      added_at TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (group_id, point_id)
    );

    CREATE TABLE IF NOT EXISTS point_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'other',
      mime TEXT NOT NULL DEFAULT 'application/octet-stream',
      size INTEGER NOT NULL DEFAULT 0,
      comment TEXT NOT NULL DEFAULT '',
      uploaded_at TEXT NOT NULL,
      uploaded_by TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_pf_point ON point_files(point_id);

    CREATE TABLE IF NOT EXISTS stat_counters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      filters TEXT NOT NULL DEFAULT '{}',
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS data_issue_ack (
      kind TEXT NOT NULL,
      issue_key TEXT NOT NULL,
      signature TEXT NOT NULL DEFAULT '',
      acked_by TEXT NOT NULL DEFAULT '',
      acked_at TEXT NOT NULL,
      PRIMARY KEY (kind, issue_key)
    );

    CREATE TABLE IF NOT EXISTS report_ai_fault (
      task_id TEXT PRIMARY KEY,
      point_id TEXT NOT NULL DEFAULT '',
      analyzed_at TEXT NOT NULL,
      status TEXT NOT NULL,
      cause TEXT NOT NULL DEFAULT '',
      needs TEXT NOT NULL DEFAULT '',
      source_text TEXT NOT NULL DEFAULT '',
      error TEXT NOT NULL DEFAULT '',
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_jobs (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      owner TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      started_at TEXT,
      finished_at TEXT,
      request TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      attempts INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_files (
      id TEXT PRIMARY KEY,
      owner TEXT NOT NULL,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      ext TEXT NOT NULL,
      size INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS ai_chat (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner TEXT NOT NULL,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      job_id TEXT,
      status TEXT NOT NULL DEFAULT 'done',
      answer TEXT,
      error TEXT,
      client_id TEXT,
      created_at TEXT NOT NULL,
      finished_at TEXT
    );

    CREATE TABLE IF NOT EXISTS ai_plan_cache (
      key TEXT PRIMARY KEY,
      spec TEXT NOT NULL,
      created_at TEXT NOT NULL,
      last_used TEXT NOT NULL,
      hits INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS ai_agents (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      hardware TEXT NOT NULL DEFAULT '{}',
      model TEXT NOT NULL DEFAULT '',
      params_b REAL NOT NULL DEFAULT 0,
      version TEXT NOT NULL DEFAULT '',
      enabled INTEGER NOT NULL DEFAULT 1,
      tps REAL NOT NULL DEFAULT 0,
      prompt_tps REAL NOT NULL DEFAULT 0,
      slots INTEGER NOT NULL DEFAULT 1,
      gpu_used INTEGER NOT NULL DEFAULT 0,
      hw_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      last_seen TEXT NOT NULL DEFAULT '',
      last_ip TEXT NOT NULL DEFAULT '',
      jobs_done INTEGER NOT NULL DEFAULT 0,
      jobs_failed INTEGER NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS ai_agent_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      key_hash TEXT NOT NULL UNIQUE,
      label TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL DEFAULT '',
      expires_at TEXT NOT NULL DEFAULT '',
      used INTEGER NOT NULL DEFAULT 0,
      agent_id TEXT NOT NULL DEFAULT '',
      used_at TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS equipment_statuses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      color TEXT NOT NULL DEFAULT '#64748b',
      usable INTEGER NOT NULL DEFAULT 0,
      role TEXT NOT NULL DEFAULT '',
      protected INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL DEFAULT ''
    );

    CREATE TABLE IF NOT EXISTS equipment_models (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES equipment_categories(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      UNIQUE(category_id, name)
    );

    CREATE TABLE IF NOT EXISTS equipment (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model_id INTEGER NOT NULL REFERENCES equipment_models(id),
      serial_number TEXT NOT NULL UNIQUE,
      place TEXT NOT NULL DEFAULT 'stock',
      status_id INTEGER REFERENCES equipment_statuses(id) ON DELETE SET NULL,
      point_id TEXT,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      held_reason TEXT,
      received_date TEXT,
      issued_date TEXT,
      installed_date TEXT,
      installed_by TEXT,
      removed_date TEXT,
      removed_by TEXT,
      removed_point_id TEXT,
      accepted_date TEXT,
      accepted_by TEXT,
      notes TEXT,
      removal_reason TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_equipment_place ON equipment(place);
    CREATE INDEX IF NOT EXISTS idx_equipment_point ON equipment(point_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_person ON equipment(person_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_model ON equipment(model_id);
    CREATE INDEX IF NOT EXISTS idx_equipment_status ON equipment(status_id);

    CREATE TABLE IF NOT EXISTS equipment_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL,
      serial_number TEXT,
      model_name TEXT,
      action_type TEXT NOT NULL,
      person_name TEXT,
      point_id TEXT,
      performed_by TEXT,
      comment TEXT,
      event_date TEXT,
      person_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_eqh_equipment ON equipment_history(equipment_id);
    CREATE INDEX IF NOT EXISTS idx_eqh_point ON equipment_history(point_id);
    CREATE INDEX IF NOT EXISTS idx_eqh_event ON equipment_history(event_date);

    CREATE TABLE IF NOT EXISTS equipment_fields (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      category_id INTEGER REFERENCES equipment_categories(id) ON DELETE SET NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS equipment_field_values (
      equipment_id INTEGER NOT NULL REFERENCES equipment(id) ON DELETE CASCADE,
      field_id INTEGER NOT NULL REFERENCES equipment_fields(id) ON DELETE CASCADE,
      value TEXT NOT NULL,
      PRIMARY KEY (equipment_id, field_id)
    );
    CREATE INDEX IF NOT EXISTS idx_efv_field ON equipment_field_values(field_id);

    CREATE TABLE IF NOT EXISTS equipment_pending (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      point_id TEXT NOT NULL,
      category_id INTEGER REFERENCES equipment_categories(id) ON DELETE SET NULL,
      suffix TEXT NOT NULL,
      person_id INTEGER REFERENCES people(id) ON DELETE SET NULL,
      person_name TEXT,
      install_date text,
      note TEXT,
      created_at TEXT NOT NULL,
      resolved_at TEXT,
      resolved_equipment_id INTEGER REFERENCES equipment(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_eqpend_open ON equipment_pending(resolved_at, suffix);

    CREATE TABLE IF NOT EXISTS solar_panels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      panel_number TEXT NOT NULL UNIQUE,
      point_id TEXT,
      location TEXT,
      notes TEXT,
      at_warehouse INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  seedDefaults(db);
}

function seedDefaults(db: DatabaseSync): void {
  const now = nowIso();

  // state_rev
  db.prepare('INSERT OR IGNORE INTO state_rev (id, rev) VALUES (1, 0)').run();

  // bot_settings
  db.prepare('INSERT OR IGNORE INTO bot_settings (id, enabled) VALUES (1, 1)').run();

  // roles
  const insertRole = db.prepare(
    'INSERT OR IGNORE INTO roles (key, name, description, permissions, is_system, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
  );
  for (const [key, def] of Object.entries(BUILTIN_ROLES)) {
    insertRole.run(key, def.name, def.description, JSON.stringify(expandPerms(def.perms)), now, now);
  }

  // default admin user
  const userCount = (db.prepare('SELECT COUNT(*) as cnt FROM users').get() as { cnt: number }).cnt;
  if (userCount === 0) {
    const hash = bcrypt.hashSync(settings.adminPassword, 10);
    db.prepare(
      'INSERT INTO users (username, password_hash, role, must_change_password, token_version, created_at) VALUES (?, ?, ?, 1, 0, ?)',
    ).run(settings.adminUsername, hash, 'admin', now);
  }

  // point_categories
  const catCount = (db.prepare('SELECT COUNT(*) as cnt FROM point_categories').get() as { cnt: number }).cnt;
  if (catCount === 0) {
    const insCat = db.prepare('INSERT INTO point_categories (name, color) VALUES (?, ?)');
    for (const [name, color] of [
      ['Камера', '#6366f1'],
      ['Табло', '#0ea5e9'],
      ['Светофор', '#f59e0b'],
      ['Регистратор', '#14b8a6'],
    ]) {
      insCat.run(name, color);
    }
  }

  // work_types
  const wtCount = (db.prepare('SELECT COUNT(*) as cnt FROM work_types').get() as { cnt: number }).cnt;
  if (wtCount === 0) {
    const insWt = db.prepare('INSERT INTO work_types (name, is_repair, bot_tools, sort_order) VALUES (?, ?, ?, ?)');
    const defaults: Array<[string, number, number]> = [
      ['Ремонт', 1, 0],
      ['ТО', 0, 0],
      ['Инвентаризация', 0, 1],
      ['Опиловка', 0, 0],
      ['Демонтаж', 0, 0],
      ['Монтаж', 0, 0],
      ['Поверка', 0, 0],
      ['Вспомогательная точка', 0, 0],
    ];
    defaults.forEach(([name, isRepair, botTools], idx) => insWt.run(name, isRepair, botTools, idx + 1));
  }

  // point_statuses
  const psCount = (db.prepare('SELECT COUNT(*) as cnt FROM point_statuses').get() as { cnt: number }).cnt;
  if (psCount === 0) {
    const insPs = db.prepare(
      'INSERT INTO point_statuses (name, color, is_auto, protected, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    const statuses: Array<[string, string, number, number]> = [
      ['Работает', '#22c55e', 1, 1],
      ['Есть только пинг', '#f59e0b', 1, 1],
      ['Не работает', '#f43f5e', 1, 1],
      ['На складе', '#64748b', 0, 1],
      ['Установлен', '#38bdf8', 0, 0],
      ['Нет питания', '#fb923c', 0, 1],
      ['Не подведено питание', '#a855f7', 0, 1],
    ];
    for (const [name, color, isAuto, prot] of statuses) {
      insPs.run(name, color, isAuto, prot, now);
    }
  }

  // equipment_statuses
  const eqStCount = (db.prepare('SELECT COUNT(*) as cnt FROM equipment_statuses').get() as { cnt: number }).cnt;
  if (eqStCount === 0) {
    const insEqSt = db.prepare(
      'INSERT INTO equipment_statuses (name, color, usable, role, protected, sort_order, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    );
    const eqStatuses: Array<[string, string, number, string, number]> = [
      ['Исправно', '#22c55e', 1, 'ok', 1],
      ['Дефектное', '#f43f5e', 0, 'defect', 1],
      ['В ремонте', '#f59e0b', 0, '', 0],
      ['Отремонтировано', '#38bdf8', 1, '', 0],
      ['Не подлежит восстановлению', '#a855f7', 0, '', 0],
      ['Списано', '#64748b', 0, '', 0],
    ];
    eqStatuses.forEach(([name, color, usable, role, prot], idx) =>
      insEqSt.run(name, color, usable, role, prot, idx + 1, now),
    );
  }

  // equipment_categories + SIM category
  const eqCatCount = (db.prepare('SELECT COUNT(*) as cnt FROM equipment_categories').get() as { cnt: number }).cnt;
  if (eqCatCount === 0) {
    const insEqCat = db.prepare('INSERT INTO equipment_categories (name, kind) VALUES (?, ?)');
    for (const name of ['Камера', 'Регистратор', 'Роутер', 'Блок питания', 'Кронштейн', 'Аккумулятор']) {
      insEqCat.run(name, '');
    }
  }
  const simCat = db.prepare("SELECT id FROM equipment_categories WHERE kind = 'sim'").get() as { id: number } | undefined;
  let simCatId = simCat?.id;
  if (!simCatId) {
    const res = db.prepare("INSERT OR IGNORE INTO equipment_categories (name, kind) VALUES ('SIM-карта', 'sim')").run();
    if (res.lastInsertRowid) {
      simCatId = Number(res.lastInsertRowid);
    } else {
      const existing = db.prepare("SELECT id FROM equipment_categories WHERE name = 'SIM-карта'").get() as { id: number } | undefined;
      if (existing) {
        db.prepare("UPDATE equipment_categories SET kind = 'sim' WHERE id = ?").run(existing.id);
        simCatId = existing.id;
      }
    }
  }
  if (simCatId) {
    const mCount = (
      db.prepare('SELECT COUNT(*) as cnt FROM equipment_models WHERE category_id = ?').get(simCatId) as { cnt: number }
    ).cnt;
    if (mCount === 0) {
      db.prepare('INSERT INTO equipment_models (category_id, name) VALUES (?, ?)').run(
        simCatId,
        'SIM-карта (оператор не указан)',
      );
    }
  }
}
