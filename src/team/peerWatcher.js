// Peer service — public API kept stable for callers (sync, broadcaster,
// routes), but the underlying storage moved from a fs.watch'd CSV to a
// dedicated SQLite DB (peerStore). The CSV is now only an optional bulk
// import source (legacy file on first boot, or UI-triggered import).
const path = require('path');
const fs = require('fs');
const os = require('os');
const csv = require('./csvPeers');
const peerStore = require('./peerStore');
const events = require('./events');
const settings = require('./settings');

// Local network interfaces — used to detect when a peer entry is actually
// "self" (same machine reachable via its own IP). Cached at first call;
// if interfaces change while running (rare on a static workstation) the
// cached set may go stale, so we expose recomputeLocalIPs() for tests.
let localIPsCache = null;
function getLocalIPs() {
  if (localIPsCache) return localIPsCache;
  const ips = new Set(['127.0.0.1', '::1', 'localhost']);
  try {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (addr && addr.address) ips.add(addr.address);
      }
    }
  } catch (e) {
    console.warn('[team] os.networkInterfaces() 실패:', e.message);
  }
  localIPsCache = ips;
  return ips;
}
function recomputeLocalIPs() { localIPsCache = null; return getLocalIPs(); }

function isSelfEntry(p) {
  const cfg = settings.get();
  const selfPort = Number(cfg.self.port);
  if (!selfPort || Number(p.port) !== selfPort) return false;
  return getLocalIPs().has(String(p.host));
}

// Pick the LAN IPv4 most likely to be how other peers reach this PC. Prefers
// 10.x / 192.168.x (typical office/home), falls back to any non-internal v4.
// Skips link-local (169.254.x) and Docker-style 172.16-31.x on first pass.
function pickPrimaryLanIp() {
  const ifaces = os.networkInterfaces();
  const collect = (filter) => {
    for (const name of Object.keys(ifaces)) {
      for (const addr of ifaces[name] || []) {
        if (!addr || addr.family !== 'IPv4' || addr.internal) continue;
        if (addr.address.startsWith('169.254.')) continue;
        if (filter(addr.address)) return addr.address;
      }
    }
    return null;
  };
  return (
    collect((ip) => ip.startsWith('10.') || ip.startsWith('192.168.')) ||
    collect(() => true) ||
    null
  );
}

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
  // Tag each peer with isSelf = (host matches a local interface AND port
  // matches self.port). Lets the UI render a "본인" badge and disable
  // edit/delete on rows that point back at this very machine.
  const peers = peerStore.list().map((p) => ({ ...p, isSelf: isSelfEntry(p) }));
  return {
    peers,
    errors: getErrors(),
    lastReloadedAt,
    dbPath: peerStore.DB_PATH,
    selfHosts: Array.from(getLocalIPs()),
    selfName: settings.get().self.name,
    selfPort: settings.get().self.port,
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

// Ensure the operator's own machine appears in the peer list, marked as self
// (isSelf=true via isSelfEntry). Called once at boot from server.js. The peer
// list — not team_settings.json — is the canonical place users look at to see
// "who is who", so without this the operator never sees themselves there.
//
// Behavior:
//  1. Detect primary LAN IPv4 + use settings.self.port + settings.self.name.
//  2. Remove any stale "self-shaped" rows whose host is a local IP and port
//     matches selfPort but whose name differs (leftover from prior renames).
//  3. Upsert the canonical self row { name, host: lanIp, port: selfPort }.
//
// Each upsert/remove fires the peerBroadcaster onChange hook (if init() ran
// first), so a rename here also propagates outward to other peers — fixing
// the recurring origin_mismatch caused by stale names on remote lists.
function ensureSelfPeer() {
  const cfg = settings.get();
  const selfName = String(cfg.self.name || '').trim();
  const selfPort = Number(cfg.self.port);
  if (!selfName) {
    console.warn('[team] ensureSelfPeer: settings.self.name 비어있음 — skip');
    return;
  }
  if (!Number.isInteger(selfPort) || selfPort < 1 || selfPort > 65535) {
    console.warn(`[team] ensureSelfPeer: self.port 무효(${cfg.self.port}) — skip`);
    return;
  }
  const lanIp = pickPrimaryLanIp();
  if (!lanIp) {
    console.warn('[team] ensureSelfPeer: 외부망 IPv4 감지 실패 — skip');
    return;
  }
  // Strip stale self-shaped rows whose name diverged from current self.name.
  // (Prevents two rows pointing at our address from coexisting; also tells
  //  remote peers to drop the old name via the broadcaster hook.)
  const localIPs = getLocalIPs();
  for (const p of peerStore.list()) {
    if (Number(p.port) !== selfPort) continue;
    if (!localIPs.has(String(p.host))) continue;
    if (p.name === selfName) continue;
    console.log(`[team] ensureSelfPeer: stale self 항목 제거 '${p.name}' @ ${p.host}:${p.port}`);
    peerStore.remove(p.name);
  }
  // Now ensure the canonical row exists with the right host/port.
  const existing = peerStore.get(selfName);
  if (existing && existing.host === lanIp && Number(existing.port) === selfPort) {
    return; // already correct, no-op
  }
  if (existing) {
    console.log(`[team] ensureSelfPeer: '${selfName}' 주소 갱신 ${existing.host}:${existing.port} -> ${lanIp}:${selfPort}`);
  } else {
    console.log(`[team] ensureSelfPeer: self 항목 추가 '${selfName}' @ ${lanIp}:${selfPort}`);
  }
  peerStore.upsert({ name: selfName, host: lanIp, port: selfPort });
}

function stop() { /* no-op — DB connection lives for process lifetime */ }
function reload() { /* no-op — peerStore is the source of truth */ }

module.exports = {
  start, stop, reload, ensureSelfPeer,
  getPeers, getErrors, getStatus,
  onChange, onError,
  reportErrors,
  markInboundWrite,
  upsertPeer, removePeer, bulkUpsertPeers, replaceAllPeers,
  writePeers,
  isSelfEntry, getLocalIPs, recomputeLocalIPs,
  LEGACY_CSV_PATH,
};
