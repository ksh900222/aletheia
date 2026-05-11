const peerWatcher = require('./peerWatcher');
const settings = require('./settings');
const cache = require('./cache');
const db = require('../db');

// Replicate the peer's authoritative sprint_groups + sprint_group_members
// into this peer's local DB. Each peer's local DB caches everyone else's
// rows so the groups remain visible even when the original creator goes
// offline (the "복사" requirement). Local rows for `creator = peerName`
// are fully owned by the sync layer — replaced atomically every time we
// successfully fetch the peer's snapshot. Stale rows (groups the peer has
// since deleted) are removed by the DELETE-then-INSERT step.
//
// This function is called inside syncPeer after a successful snapshot fetch.
// It also refreshes any of OUR OWN sprint_group_members whose report_owner
// matches this peer — keeping snapshots fresh when the peer edits the
// underlying report.
function replicatePeerSprintData(peerName, data) {
  const groups = Array.isArray(data && data.sprint_groups) ? data.sprint_groups : [];
  const members = Array.isArray(data && data.sprint_group_members) ? data.sprint_group_members : [];
  const reports = Array.isArray(data && data.reports) ? data.reports : [];

  const tx = db.transaction(() => {
    // Clear stale cached rows for this peer; CASCADE removes members.
    db.prepare(`DELETE FROM sprint_groups WHERE creator = ?`).run(peerName);

    const insGroup = db.prepare(
      `INSERT INTO sprint_groups (creator, id, name, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const g of groups) {
      insGroup.run(peerName, g.id, g.name, g.created_at, g.updated_at);
    }

    const insMember = db.prepare(
      `INSERT INTO sprint_group_members
         (group_creator, group_id, report_id, report_owner,
          snapshot_date, snapshot_body, snapshot_updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const m of members) {
      insMember.run(
        peerName, m.group_id, m.report_id, m.report_owner || '',
        m.snapshot_date || '', m.snapshot_body || '', m.snapshot_updated_at
      );
    }

    // Cross-peer snapshot refresh: when the peer edits a report that's a
    // member of any of OUR OWN groups, refresh the snapshot from the
    // peer's current report content. This is what makes report edits
    // propagate into "frozen" sprint reviews automatically.
    const refreshMember = db.prepare(
      `UPDATE sprint_group_members
          SET snapshot_date = ?, snapshot_body = ?, snapshot_updated_at = datetime('now')
        WHERE group_creator = '' AND report_owner = ? AND report_id = ?
          AND (snapshot_body IS NULL OR snapshot_body != ? OR snapshot_date != ?)`
    );
    const bumpAffectedGroups = db.prepare(
      `UPDATE sprint_groups SET updated_at = datetime('now')
        WHERE creator = '' AND id IN (
          SELECT DISTINCT group_id FROM sprint_group_members
           WHERE group_creator = '' AND report_owner = ? AND report_id = ?
        )`
    );
    for (const r of reports) {
      const info = refreshMember.run(
        r.report_date || '', r.body || '',
        peerName, r.id,
        r.body || '', r.report_date || ''
      );
      if (info.changes > 0) {
        bumpAffectedGroups.run(peerName, r.id);
      }
    }
  });
  tx();
}

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

    // Persist peer's sprint groups into our local DB so they survive even
    // when the peer goes offline. Also refreshes any of our own group
    // member snapshots that reference this peer's reports.
    try {
      replicatePeerSprintData(peer.name, snapJson.data);
    } catch (e) {
      console.error('[team] sprint replication failed for', peer.name, e.message);
    }
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
    if (!validNames.has(old)) {
      cache.removePeer(old);
      // Drop replicated sprint groups for the dropped peer too. We keep
      // them across simple offline cycles (peer disappears from peerStates
      // only when it's been outright removed from the peer list), but a
      // truly removed peer's groups should not linger.
      try {
        db.prepare(`DELETE FROM sprint_groups WHERE creator = ?`).run(old);
      } catch (e) {
        console.error('[team] sprint cleanup for removed peer failed:', e.message);
      }
    }
  }

  await Promise.all(valid.map(syncPeer));

  // After every full pass, drop replicated sprint_groups rows whose creator
  // is no longer in the peer list. This handles the cold-start case where
  // cache.knownNames() is empty (server just restarted) but stale rows
  // from a previous run linger in the DB. creator='' (own) is preserved.
  try {
    const names = valid.map((p) => p.name);
    if (names.length === 0) {
      db.prepare(`DELETE FROM sprint_groups WHERE creator != ''`).run();
    } else {
      const placeholders = names.map(() => '?').join(',');
      db.prepare(
        `DELETE FROM sprint_groups WHERE creator != '' AND creator NOT IN (${placeholders})`
      ).run(...names);
    }
  } catch (e) {
    console.error('[team] sprint cold-start cleanup failed:', e.message);
  }

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
