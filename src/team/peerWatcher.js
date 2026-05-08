// Peer service — public API kept stable for callers (sync, broadcaster,
// routes), but the underlying storage moved from a fs.watch'd CSV to a
// dedicated SQLite DB (peerStore). The CSV is now only an optional bulk
// import source (legacy file on first boot, or UI-triggered import).
const path = require('path');
const fs = require('fs');
const csv = require('./csvPeers');
const peerStore = require('./peerStore');
const events = require('./events');

const LEGACY_CSV_PATH = process.env.TEAM_PEERS_CSV
  ? path.resolve(process.env.TEAM_PEERS_CSV)
  : path.resolve(__dirname, '..', '..', 'data', 'team_peers.csv');

let lastReloadedAt = null;
let lastErrors = [];
const errorListeners = [];
// Set to true immediately before a peerStore write that is a result of an
// inbound broadcast (peer-update / peer-remove). The next change emit will
// carry meta.inbound = true so the broadcaster does not re-send.
let inboundFlag = false;

function getPeers() { return peerStore.list(); }
function getErrors() { return lastErrors.slice(); }
function getStatus() {
  return {
    peers: getPeers(),
    errors: getErrors(),
    lastReloadedAt,
    dbPath: peerStore.DB_PATH,
  };
}

function onChange(cb) {
  // Wrap to inject inboundFlag into each emission, then clear the flag.
  peerStore.onChange((next, prev, meta) => {
    const wasInbound = inboundFlag;
    inboundFlag = false;
    try { cb(next, prev, { ...(meta || {}), inbound: wasInbound }); }
    catch (e) { console.error(e); }
    lastReloadedAt = new Date().toISOString();
  });
}

function onError(cb) { errorListeners.push(cb); }

function reportErrors(errs) {
  lastErrors = errs;
  events.record('csv_validation_error', { errors: errs });
  for (const cb of errorListeners) {
    try { cb(errs); } catch (e) { console.error(e); }
  }
}

function markInboundWrite() { inboundFlag = true; }

// Public mutators delegated to peerStore; UI / receiver paths use these.
function upsertPeer(entry) { peerStore.upsert(entry); }
function removePeer(name)  { return peerStore.remove(name); }
function bulkUpsertPeers(entries) { peerStore.bulkUpsert(entries); }
function replaceAllPeers(entries)  { peerStore.replaceAll(entries); }

// Legacy compatibility: the /peer-update receiver used writePeers(merged) to
// upsert via "replace whole list" semantics. With per-entry upsert in
// peerStore that wrapper isn't needed — keep it as a bulk upsert though so
// any older caller still works.
function writePeers(entries) { peerStore.bulkUpsert(entries); }

// One-time migration: if DB is empty AND the legacy CSV file exists with
// valid entries, import them. Idempotent — once DB has any rows we skip.
function maybeMigrateFromLegacyCsv() {
  if (peerStore.count() > 0) return;
  if (!fs.existsSync(LEGACY_CSV_PATH)) return;
  let text;
  try { text = fs.readFileSync(LEGACY_CSV_PATH, 'utf-8'); }
  catch (e) {
    console.warn('[team] legacy CSV 읽기 실패:', e.message);
    return;
  }
  const { entries, errors } = csv.parse(text);
  if (errors.length > 0) {
    console.warn('[team] legacy CSV 검증 실패 — 마이그레이션 스킵:', errors);
    return;
  }
  if (entries.length === 0) return;
  peerStore.bulkUpsert(entries, { migration: true });
  console.log(`[team] legacy CSV에서 ${entries.length}명 자동 import 완료`);
}

function start() {
  maybeMigrateFromLegacyCsv();
  lastReloadedAt = new Date().toISOString();
}

function stop() { /* no-op — DB connection lives for process lifetime */ }
function reload() { /* no-op — peerStore is the source of truth */ }

module.exports = {
  start, stop, reload,
  getPeers, getErrors, getStatus,
  onChange, onError,
  reportErrors,
  markInboundWrite,
  upsertPeer, removePeer, bulkUpsertPeers, replaceAllPeers,
  writePeers,
  LEGACY_CSV_PATH,
};
