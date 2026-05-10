const peerWatcher = require('./peerWatcher');
const settings = require('./settings');
const cache = require('./cache');

async function fetchWithTimeout(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

async function syncPeer(peer) {
  const cfg = settings.get();
  const headers = { 'X-Team-Token': cfg.sharedToken };
  const baseUrl = `http://${peer.host}:${peer.port}`;
  const timeout = cfg.requestTimeoutMs || 5000;

  cache.setPeerState(peer.name, { status: 'loading', lastError: null, host: peer.host, port: peer.port });

  try {
    const verRes = await fetchWithTimeout(`${baseUrl}/api/team/version`, { headers }, timeout);
    if (!verRes.ok) throw new Error(`version HTTP ${verRes.status}`);
    const verJson = await verRes.json();
    const newVersion = verJson.version;

    const prev = cache.getPeerState(peer.name);
    if (prev && prev.version === newVersion && prev.data) {
      cache.setPeerState(peer.name, { status: 'ok', lastSuccessAt: new Date().toISOString() });
      return;
    }

    const snapRes = await fetchWithTimeout(`${baseUrl}/api/team/snapshot`, { headers }, timeout);
    if (!snapRes.ok) throw new Error(`snapshot HTTP ${snapRes.status}`);
    const snapJson = await snapRes.json();

    cache.setPeerState(peer.name, {
      status: 'ok',
      lastSuccessAt: new Date().toISOString(),
      version: newVersion,
      data: snapJson.data,
    });
  } catch (e) {
    const status = e.name === 'AbortError' ? 'timeout' : 'fail';
    cache.setPeerState(peer.name, { status, lastError: e.message });
  }
}

async function syncAll() {
  if (cache.getMode() !== 'ON') return;
  const peers = peerWatcher.getPeers();
  const self = settings.get().self.name;
  // Skip entries that point at ourselves: same name OR same host+port as
  // self (the user might have added their own machine under a different
  // name, in which case syncing would pull our own data back as "team data").
  const valid = peers.filter((p) =>
    p.name && p.name !== self && !peerWatcher.isSelfEntry(p)
  );

  const validNames = new Set(valid.map((p) => p.name));
  for (const old of cache.knownNames()) {
    if (!validNames.has(old)) cache.removePeer(old);
  }

  await Promise.all(valid.map(syncPeer));
  cache.setSyncAt(new Date().toISOString());
}

let timer = null;
function startTimer() {
  stopTimer();
  const sec = Math.max(5, Number(settings.get().syncIntervalSec) || 60);
  timer = setInterval(() => {
    syncAll().catch((e) => console.error('[team] sync 오류:', e));
  }, sec * 1000);
}

function stopTimer() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { syncAll, syncPeer, startTimer, stopTimer };
