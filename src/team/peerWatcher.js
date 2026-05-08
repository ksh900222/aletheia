const fs = require('fs');
const path = require('path');
const csv = require('./csvPeers');
const events = require('./events');

const CSV_PATH = process.env.TEAM_PEERS_CSV
  ? path.resolve(process.env.TEAM_PEERS_CSV)
  : path.resolve(__dirname, '..', '..', 'data', 'team_peers.csv');

let currentPeers = [];
let lastErrors = [];
let lastReloadedAt = null;
const changeListeners = [];
const errorListeners = [];

let debounceTimer = null;
// When true, the next reload was caused by our own inbound peer-update write,
// not a user edit. Listeners use this to skip rebroadcasting.
let inboundWriteFlag = false;
let watcher = null;
// Skip emitting a "csv_reload" event on the very first (boot-time) reload.
let firstReload = true;

function getPeers() { return currentPeers.slice(); }
function getErrors() { return lastErrors.slice(); }
function getStatus() {
  return { peers: getPeers(), errors: getErrors(), lastReloadedAt, csvPath: CSV_PATH };
}

function onChange(cb) { changeListeners.push(cb); }
function onError(cb) { errorListeners.push(cb); }

function markInboundWrite() { inboundWriteFlag = true; }

function reload() {
  let text;
  try {
    text = fs.readFileSync(CSV_PATH, 'utf-8');
  } catch (e) {
    if (e.code === 'ENOENT') {
      const previous = currentPeers;
      currentPeers = [];
      lastErrors = [];
      lastReloadedAt = new Date().toISOString();
      console.warn(`[team] ${CSV_PATH} 없음 — 빈 peer 목록으로 시작`);
      emitChange(previous, { inbound: false });
      return;
    }
    console.error('[team] CSV 읽기 실패:', e.message);
    return;
  }

  const { entries, errors } = csv.parse(text);
  if (errors.length > 0) {
    lastErrors = errors;
    console.warn('[team] CSV 검증 실패 — 이전 peer 목록 유지:', errors);
    events.record('csv_validation_error', { errors });
    for (const cb of errorListeners) {
      try { cb(errors); } catch (e) { console.error(e); }
    }
    return;
  }

  const previous = currentPeers;
  const wasInbound = inboundWriteFlag;
  inboundWriteFlag = false;
  currentPeers = entries;
  lastErrors = [];
  lastReloadedAt = new Date().toISOString();
  if (!firstReload) {
    events.record('csv_reload', {
      peerCount: entries.length,
      inbound: wasInbound,
    });
  }
  firstReload = false;
  emitChange(previous, { inbound: wasInbound });
}

function emitChange(previous, meta) {
  for (const cb of changeListeners) {
    try { cb(currentPeers, previous, meta); } catch (e) { console.error(e); }
  }
}

function start() {
  reload();
  try {
    watcher = fs.watch(CSV_PATH, () => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(reload, 500);
    });
    watcher.on('error', (e) => {
      console.warn('[team] fs.watch 에러:', e.message);
    });
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn('[team] CSV가 아직 없어 fs.watch 등록 보류 — 5초 폴링으로 대기');
      const poll = setInterval(() => {
        if (fs.existsSync(CSV_PATH)) {
          clearInterval(poll);
          start();
        }
      }, 5000);
    } else {
      console.warn('[team] fs.watch 실패:', e.message);
    }
  }
}

function stop() {
  if (watcher) { watcher.close(); watcher = null; }
  clearTimeout(debounceTimer);
}

function writePeers(entries) {
  const text = csv.serialize(entries);
  const tmp = CSV_PATH + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, CSV_PATH);
}

module.exports = {
  start,
  stop,
  reload,
  getPeers,
  getErrors,
  getStatus,
  onChange,
  onError,
  markInboundWrite,
  writePeers,
  CSV_PATH,
};
