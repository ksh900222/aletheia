// SQLite-backed store for the team peer list. Lives in its own DB file so the
// main planner.db schema and migrations are unaffected.
//
// Source of truth for peers. The UI does CRUD against this; broadcasts in/out
// upsert and remove rows. The legacy team_peers.csv is now only used as an
// import source (one-time migration on first boot, plus user-initiated bulk
// import via the UI).
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.TEAM_PEERS_DB
  ? path.resolve(process.env.TEAM_PEERS_DB)
  : path.resolve(__dirname, '..', '..', 'data', 'team_peers.db');

const DATA_DIR = path.dirname(DB_PATH);
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS peers (
    name       TEXT PRIMARY KEY,
    host       TEXT NOT NULL,
    port       INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const listStmt   = db.prepare(`SELECT name, host, port FROM peers ORDER BY rowid ASC`);
const getStmt    = db.prepare(`SELECT name, host, port FROM peers WHERE name = ?`);
const upsertStmt = db.prepare(
  `INSERT INTO peers (name, host, port) VALUES (?, ?, ?)
   ON CONFLICT(name) DO UPDATE SET
     host = excluded.host,
     port = excluded.port,
     updated_at = datetime('now')`
);
const removeStmt = db.prepare(`DELETE FROM peers WHERE name = ?`);
const clearStmt  = db.prepare(`DELETE FROM peers`);

const replaceAllTx = db.transaction((entries) => {
  clearStmt.run();
  for (const e of entries) upsertStmt.run(e.name, e.host, e.port);
});

const bulkUpsertTx = db.transaction((entries) => {
  for (const e of entries) upsertStmt.run(e.name, e.host, e.port);
});

const changeListeners = [];

function onChange(cb) { changeListeners.push(cb); }

function emit(prev, next, meta) {
  for (const cb of changeListeners) {
    try { cb(next, prev, meta || {}); } catch (e) { console.error(e); }
  }
}

function list() { return listStmt.all(); }
function get(name) { return getStmt.get(name); }

function upsert(entry, meta) {
  const prev = list();
  upsertStmt.run(entry.name, entry.host, entry.port);
  emit(prev, list(), { kind: 'upsert', entry, ...(meta || {}) });
}

function remove(name, meta) {
  const prev = list();
  const info = removeStmt.run(name);
  if (info.changes === 0) return false;
  emit(prev, list(), { kind: 'remove', name, ...(meta || {}) });
  return true;
}

function bulkUpsert(entries, meta) {
  const prev = list();
  bulkUpsertTx(entries);
  emit(prev, list(), { kind: 'bulkUpsert', entries, ...(meta || {}) });
}

function replaceAll(entries, meta) {
  const prev = list();
  replaceAllTx(entries);
  emit(prev, list(), { kind: 'replaceAll', entries, ...(meta || {}) });
}

function count() {
  return db.prepare(`SELECT COUNT(*) AS n FROM peers`).get().n;
}

module.exports = {
  list, get, upsert, remove, bulkUpsert, replaceAll, count, onChange,
  DB_PATH,
};
