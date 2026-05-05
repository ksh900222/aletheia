const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = path.resolve(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'planner.db');

if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL UNIQUE,
    description  TEXT,
    color        TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS schedules (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id    INTEGER NOT NULL,
    title          TEXT NOT NULL,
    description    TEXT,
    planned_start  TEXT NOT NULL,
    planned_end    TEXT NOT NULL,
    actual_start   TEXT,
    actual_end     TEXT,
    status         TEXT NOT NULL DEFAULT 'pending'
                   CHECK (status IN ('pending','in_progress','done','blocked')),
    created_at     TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_schedules_category ON schedules(category_id);

  CREATE TABLE IF NOT EXISTS dependencies (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    pred_type    TEXT NOT NULL CHECK (pred_type IN ('schedule','category')),
    pred_id      INTEGER NOT NULL,
    succ_type    TEXT NOT NULL CHECK (succ_type IN ('schedule','category')),
    succ_id      INTEGER NOT NULL,
    link_type    TEXT NOT NULL CHECK (link_type IN ('strong','weak')),
    on_delay     TEXT NOT NULL DEFAULT 'auto_shift'
                 CHECK (on_delay IN ('auto_shift','warn_only')),
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (pred_type, pred_id, succ_type, succ_id, link_type)
  );

  CREATE INDEX IF NOT EXISTS idx_deps_pred ON dependencies(pred_type, pred_id);
  CREATE INDEX IF NOT EXISTS idx_deps_succ ON dependencies(succ_type, succ_id);

  CREATE TABLE IF NOT EXISTS reports (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    report_date  TEXT NOT NULL,
    body         TEXT NOT NULL DEFAULT '',
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_reports_date ON reports(report_date);

  CREATE TABLE IF NOT EXISTS report_categories (
    report_id    INTEGER NOT NULL,
    category_id  INTEGER NOT NULL,
    PRIMARY KEY (report_id, category_id),
    FOREIGN KEY (report_id)   REFERENCES reports(id)    ON DELETE CASCADE,
    FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_report_categories_category ON report_categories(category_id);

  CREATE TABLE IF NOT EXISTS attachments (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    report_id     INTEGER NOT NULL,
    kind          TEXT NOT NULL CHECK (kind IN ('upload','local_path')),
    path          TEXT NOT NULL,
    display_name  TEXT NOT NULL,
    size_bytes    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (report_id) REFERENCES reports(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_attachments_report ON attachments(report_id);

  CREATE TABLE IF NOT EXISTS report_schedules (
    report_id    INTEGER NOT NULL,
    schedule_id  INTEGER NOT NULL,
    PRIMARY KEY (report_id, schedule_id),
    FOREIGN KEY (report_id)   REFERENCES reports(id)   ON DELETE CASCADE,
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_report_schedules_schedule ON report_schedules(schedule_id);

  CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

// Migration: report model overhaul (date+schedule sticky workflow).
// Old reports lacked a direct schedule link; new flow requires every report to
// be tied to (date, schedule). Per user decision: wipe existing reports rather
// than try to back-fill links. Attachment file blobs in uploads/ are kept on
// disk (no orphan cleanup) — only DB rows are removed via CASCADE.
try {
  const already = db
    .prepare(`SELECT 1 FROM schema_migrations WHERE name = ?`)
    .get('reports_schedule_link_v1');
  if (!already) {
    console.log('[db] migrating reports: wiping legacy reports for new (date+schedule) model');
    db.transaction(() => {
      db.prepare(`DELETE FROM reports`).run();
      db.prepare(`INSERT INTO schema_migrations (name) VALUES (?)`)
        .run('reports_schedule_link_v1');
    })();
  }
} catch (e) {
  console.error('[db] reports wipe migration failed:', e.message);
}

// Migration: drop the CHECK constraint on schedules.status (the original DDL
// hardcoded 4 values: pending/in_progress/done/blocked). Validation now lives
// in src/routes/schedules.js so we can add new statuses (예: not_started)
// without DDL churn. SQLite can't ALTER a CHECK in place — recreate the table.
try {
  const row = db
    .prepare(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='schedules'`
    )
    .get();
  if (
    row &&
    row.sql &&
    row.sql.includes("CHECK (status IN ('pending','in_progress','done','blocked'))")
  ) {
    console.log('[db] migrating schedules: dropping status CHECK constraint');
    db.transaction(() => {
      db.exec(`
        CREATE TABLE schedules_new (
          id             INTEGER PRIMARY KEY AUTOINCREMENT,
          category_id    INTEGER NOT NULL,
          title          TEXT NOT NULL,
          description    TEXT,
          planned_start  TEXT NOT NULL,
          planned_end    TEXT NOT NULL,
          actual_start   TEXT,
          actual_end     TEXT,
          status         TEXT NOT NULL DEFAULT 'pending',
          created_at     TEXT NOT NULL DEFAULT (datetime('now')),
          updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (category_id) REFERENCES categories(id) ON DELETE CASCADE
        );
        INSERT INTO schedules_new SELECT * FROM schedules;
        DROP TABLE schedules;
        ALTER TABLE schedules_new RENAME TO schedules;
        CREATE INDEX IF NOT EXISTS idx_schedules_category ON schedules(category_id);
      `);
    })();
  }
} catch (e) {
  console.error('[db] schedules status migration failed:', e.message);
}

module.exports = db;
module.exports.DB_PATH = DB_PATH;
