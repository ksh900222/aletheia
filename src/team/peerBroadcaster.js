const peerWatcher = require('./peerWatcher');
const settings = require('./settings');

const recentBroadcasts = new Map();
const BROADCAST_TTL_MS = 30_000;

function entryKey(e) { return `${e.name}|${e.host}|${e.port}`; }

function rememberBroadcast(key) {
  recentBroadcasts.set(key, Date.now());
}

function wasRecentlyBroadcast(key) {
  const ts = recentBroadcasts.get(key);
  if (!ts) return false;
  if (Date.now() - ts > BROADCAST_TTL_MS) {
    recentBroadcasts.delete(key);
    return false;
  }
  return true;
}

function diffPeers(prev, curr) {
  const prevByName = new Map((prev || []).map((p) => [p.name, p]));
  const changed = [];
  for (const c of curr) {
    const p = prevByName.get(c.name);
    if (!p || p.host !== c.host || p.port !== c.port) {
      changed.push(c);
    }
  }
  return changed;
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

  const timeout = cfg.requestTimeoutMs || 5000;
  await Promise.all(targets.map(async (p) => {
    const url = `http://${p.host}:${p.port}/api/team/peer-update`;
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Team-Token': cfg.sharedToken,
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeout),
      });
      if (!res.ok) {
        console.warn(`[team] broadcast → ${p.name} HTTP ${res.status}`);
      }
    } catch (e) {
      console.warn(`[team] broadcast → ${p.name} 실패: ${e.message}`);
    }
  }));
}

function init() {
  peerWatcher.onChange((curr, prev, meta) => {
    if (meta && meta.inbound) return;
    const changed = diffPeers(prev, curr);
    const fresh = changed.filter((e) => !wasRecentlyBroadcast(entryKey(e)));
    if (fresh.length > 0) {
      broadcastEntries(fresh).catch((err) => console.error('[team] broadcast 오류:', err));
    }
  });
}

module.exports = { init, broadcastEntries, diffPeers, wasRecentlyBroadcast, rememberBroadcast };
