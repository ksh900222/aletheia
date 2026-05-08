const peerWatcher = require('./peerWatcher');
const settings = require('./settings');

const recentBroadcasts = new Map();
const recentRemovals = new Map();
const BROADCAST_TTL_MS = 30_000;

function entryKey(e) { return `${e.name}|${e.host}|${e.port}`; }

function rememberBroadcast(key, map = recentBroadcasts) {
  map.set(key, Date.now());
}

function wasRecentlyBroadcast(key, map = recentBroadcasts) {
  const ts = map.get(key);
  if (!ts) return false;
  if (Date.now() - ts > BROADCAST_TTL_MS) {
    map.delete(key);
    return false;
  }
  return true;
}

function rememberRemoval(name) { rememberBroadcast(name, recentRemovals); }
function wasRecentlyRemoved(name) { return wasRecentlyBroadcast(name, recentRemovals); }

function diffPeers(prev, curr) {
  const prevByName = new Map((prev || []).map((p) => [p.name, p]));
  const currByName = new Map((curr || []).map((p) => [p.name, p]));
  const added = [];
  const removed = [];
  for (const c of curr) {
    const p = prevByName.get(c.name);
    if (!p || p.host !== c.host || p.port !== c.port) added.push(c);
  }
  for (const p of (prev || [])) {
    if (!currByName.has(p.name)) removed.push(p);
  }
  return { added, removed };
}

async function postToPeer(peer, urlPath, payload) {
  const cfg = settings.get();
  const url = `http://${peer.host}:${peer.port}${urlPath}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Team-Token': cfg.sharedToken,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
    });
    if (!res.ok) {
      console.warn(`[team] ${urlPath} → ${peer.name} HTTP ${res.status}`);
    }
  } catch (e) {
    console.warn(`[team] ${urlPath} → ${peer.name} 실패: ${e.message}`);
  }
}

async function broadcastEntries(entries) {
  const cfg = settings.get();
  if (!cfg.peerBroadcast || cfg.peerBroadcast.enabled === false) return;
  if (!cfg.sharedToken) return;
  const self = cfg.self.name;
  const filtered = entries.filter((e) => e.name !== self);
  if (filtered.length === 0) return;
  const targets = peerWatcher.getPeers().filter((p) => p.name !== self);
  if (targets.length === 0) return;
  const payload = { origin: self, entries: filtered, ts: new Date().toISOString() };
  for (const e of filtered) rememberBroadcast(entryKey(e));
  await Promise.all(targets.map((p) => postToPeer(p, '/api/team/peer-update', payload)));
}

async function broadcastRemovals(names) {
  const cfg = settings.get();
  if (!cfg.peerBroadcast || cfg.peerBroadcast.enabled === false) return;
  if (!cfg.sharedToken) return;
  const self = cfg.self.name;
  const filtered = names.filter((n) => n !== self);
  if (filtered.length === 0) return;
  const targets = peerWatcher.getPeers().filter((p) => p.name !== self);
  if (targets.length === 0) return;
  const payload = { origin: self, names: filtered, ts: new Date().toISOString() };
  for (const n of filtered) rememberRemoval(n);
  await Promise.all(targets.map((p) => postToPeer(p, '/api/team/peer-remove-received', payload)));
}

function init() {
  peerWatcher.onChange((curr, prev, meta) => {
    if (meta && meta.inbound) return;
    if (meta && meta.migration) return; // never broadcast initial CSV migration
    const { added, removed } = diffPeers(prev, curr);

    const freshAdded = added.filter((e) => !wasRecentlyBroadcast(entryKey(e)));
    if (freshAdded.length > 0) {
      broadcastEntries(freshAdded).catch((err) =>
        console.error('[team] broadcast(upsert) 오류:', err)
      );
    }

    const freshRemoved = removed.filter((e) => !wasRecentlyRemoved(e.name));
    if (freshRemoved.length > 0) {
      broadcastRemovals(freshRemoved.map((e) => e.name)).catch((err) =>
        console.error('[team] broadcast(remove) 오류:', err)
      );
    }
  });
}

// Announce my current full peer list to all peers as upserts. Used at boot
// (so peers that were offline when changes happened can catch up) and via the
// "내 목록 전파" UI button. Idempotent — receivers upsert with no diff = no-op.
async function announceCurrentList() {
  const all = peerWatcher.getPeers();
  if (all.length === 0) return { sent: 0 };
  await broadcastEntries(all);
  return { sent: all.length };
}

module.exports = {
  init,
  broadcastEntries,
  broadcastRemovals,
  announceCurrentList,
  diffPeers,
  rememberBroadcast,
  rememberRemoval,
  wasRecentlyBroadcast,
  wasRecentlyRemoved,
};
