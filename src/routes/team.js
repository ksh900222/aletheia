const express = require('express');
const peerWatcher = require('../team/peerWatcher');
const settings = require('../team/settings');
const cache = require('../team/cache');
const sync = require('../team/sync');
const exporter = require('../team/exporter');
const broadcaster = require('../team/peerBroadcaster');
const events = require('../team/events');
const csvPeers = require('../team/csvPeers');

const router = express.Router();

function validatePeerEntry(e) {
  if (!e || typeof e.name !== 'string' || !e.name.trim()) return 'name이 비어 있음';
  if (typeof e.host !== 'string' || !e.host.trim()) return 'host가 비어 있음';
  const port = Number(e.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return 'port가 유효하지 않음';
  return null;
}

function tokenAuth(req, res, next) {
  const cfg = settings.get();
  if (!cfg.sharedToken) {
    return res.status(503).json({ error: 'team_token_not_configured' });
  }
  if (req.get('X-Team-Token') !== cfg.sharedToken) {
    return res.status(401).json({ error: 'invalid_team_token' });
  }
  next();
}

// Cross-peer endpoints (token required)
router.get('/version', tokenAuth, (req, res) => {
  res.json({ version: exporter.computeVersion(), owner: settings.get().self.name });
});

router.get('/snapshot', tokenAuth, (req, res) => {
  res.json({
    version: exporter.computeVersion(),
    owner: settings.get().self.name,
    data: exporter.collectSnapshot(),
  });
});

router.post('/peer-update', tokenAuth, express.json(), (req, res) => {
  const { origin, entries } = req.body || {};
  if (!Array.isArray(entries)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const self = settings.get().self.name;
  const valid = entries.filter((e) =>
    e && typeof e.name === 'string' && e.name && e.name !== self &&
    typeof e.host === 'string' && e.host &&
    Number.isInteger(e.port) && e.port >= 1 && e.port <= 65535
  );
  if (valid.length === 0) {
    return res.json({ accepted: 0, origin: origin || null });
  }

  // Echo prevention: remember these as recently-broadcast so the upcoming
  // store-write event does not re-send them outward.
  for (const e of valid) {
    broadcaster.rememberBroadcast(`${e.name}|${e.host}|${e.port}`);
  }

  peerWatcher.markInboundWrite();
  peerWatcher.bulkUpsertPeers(valid.map((e) => ({
    name: e.name, host: e.host, port: e.port,
  })));

  events.record('peer_update_received', { origin: origin || null, entries: valid });

  res.json({ accepted: valid.length, origin: origin || null });
});

router.post('/peer-remove-received', tokenAuth, express.json(), (req, res) => {
  const { origin, names } = req.body || {};
  if (!Array.isArray(names)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const self = settings.get().self.name;
  const valid = names.filter((n) => typeof n === 'string' && n && n !== self);
  if (valid.length === 0) {
    return res.json({ removed: 0, origin: origin || null });
  }

  for (const n of valid) broadcaster.rememberRemoval(n);

  let removed = 0;
  for (const n of valid) {
    peerWatcher.markInboundWrite();
    if (peerWatcher.removePeer(n)) removed += 1;
  }

  events.record('peer_remove_received', { origin: origin || null, names: valid });

  res.json({ removed, origin: origin || null });
});

router.get('/events', (req, res) => {
  res.json({ events: events.since(req.query.since), latestSeq: events.latestSeq() });
});

// Local UI endpoints (no token; intended for own frontend)
router.get('/peers', (req, res) => {
  res.json(peerWatcher.getStatus());
});

router.get('/state', (req, res) => {
  const peers = cache.getAllPeerStates().map((p) => ({
    name: p.name,
    host: p.host,
    port: p.port,
    status: p.status,
    lastSuccessAt: p.lastSuccessAt,
    lastError: p.lastError,
  }));
  res.json({
    mode: cache.getMode(),
    lastSyncAt: cache.getLastSyncAt(),
    self: settings.get().self,
    peers,
  });
});

// Merged data from all currently-cached peers. Each record is tagged with
// `owner` (peer's display name). Reports come pre-joined with categories /
// schedules / attachments so the frontend can render them just like own
// reports. Only peers in 'ok' state contribute data.
router.get('/merged', (req, res) => {
  if (cache.getMode() !== 'ON') {
    return res.json({ mode: 'OFF', categories: [], schedules: [], dependencies: [], reports: [] });
  }
  const merged = { categories: [], schedules: [], dependencies: [], reports: [] };
  for (const peer of cache.getAllPeerStates()) {
    if (peer.status !== 'ok' || !peer.data) continue;
    const owner = peer.name;
    const peerHost = peer.host;
    const peerPort = peer.port;
    const d = peer.data;
    const catById = new Map((d.categories || []).map((c) => [c.id, c]));
    const schedById = new Map((d.schedules || []).map((s) => [s.id, s]));
    const rcByReport = new Map();
    for (const rc of d.report_categories || []) {
      if (!rcByReport.has(rc.report_id)) rcByReport.set(rc.report_id, []);
      rcByReport.get(rc.report_id).push(rc.category_id);
    }
    const rsByReport = new Map();
    for (const rs of d.report_schedules || []) {
      if (!rsByReport.has(rs.report_id)) rsByReport.set(rs.report_id, []);
      rsByReport.get(rs.report_id).push(rs.schedule_id);
    }
    const attsByReport = new Map();
    for (const a of d.attachments || []) {
      if (!attsByReport.has(a.report_id)) attsByReport.set(a.report_id, []);
      attsByReport.get(a.report_id).push(a);
    }

    for (const c of d.categories || []) merged.categories.push({ ...c, owner });
    for (const s of d.schedules || [])  merged.schedules.push({ ...s, owner });
    for (const dep of d.dependencies || []) merged.dependencies.push({ ...dep, owner });

    for (const r of d.reports || []) {
      const catIds = rcByReport.get(r.id) || [];
      const cats = catIds.map((id) => catById.get(id)).filter(Boolean)
        .map((c) => ({ ...c, owner }));
      const sIds = rsByReport.get(r.id) || [];
      const scheds = sIds.map((id) => schedById.get(id)).filter(Boolean)
        .map((s) => ({ ...s, owner }));
      // peerHost/peerPort on each attachment lets the frontend build the
      // direct download URL (http://<peerHost>:<peerPort>/uploads/<path>) for
      // upload-kind attachments. local_path attachments are displayed as
      // text-only since the path only exists on the peer's filesystem.
      const atts = (attsByReport.get(r.id) || []).map((a) => ({
        ...a, owner, peerHost, peerPort,
      }));
      merged.reports.push({
        ...r, owner, peerHost, peerPort,
        categories: cats, schedules: scheds, attachments: atts,
      });
    }
  }
  res.json({ mode: 'ON', lastSyncAt: cache.getLastSyncAt(), ...merged });
});

router.post('/toggle', async (req, res) => {
  const target = cache.getMode() === 'ON' ? 'OFF' : 'ON';
  cache.setMode(target);
  if (target === 'ON') {
    sync.startTimer();
    sync.syncAll().catch((e) => console.error('[team] initial sync 오류:', e));
  } else {
    sync.stopTimer();
  }
  res.json({ mode: target });
});

router.post('/sync', async (req, res) => {
  if (cache.getMode() !== 'ON') {
    return res.status(409).json({ error: 'team_mode_off' });
  }
  await sync.syncAll();
  res.json({ ok: true, lastSyncAt: cache.getLastSyncAt() });
});

// ───── Local UI: peer list management (CRUD + bulk import) ─────
// All of the below mutate peerStore. peerBroadcaster watches peerStore and
// fans out add/edit/remove to other peers automatically.

router.post('/peer-add', (req, res) => {
  const e = {
    name: (req.body && req.body.name || '').trim(),
    host: (req.body && req.body.host || '').trim(),
    port: Number(req.body && req.body.port),
  };
  const err = validatePeerEntry(e);
  if (err) return res.status(400).json({ error: 'invalid', detail: err });
  if (e.name === settings.get().self.name) {
    return res.status(400).json({ error: 'invalid', detail: 'self.name은 peer 목록에 추가할 수 없음' });
  }
  if (peerWatcher.getPeers().some((p) => p.name === e.name)) {
    return res.status(409).json({ error: 'duplicate_name' });
  }
  peerWatcher.upsertPeer(e);
  res.json({ ok: true, peer: e });
});

router.post('/peer-edit', (req, res) => {
  const original = (req.body && req.body.originalName || '').trim();
  const e = {
    name: (req.body && req.body.name || '').trim(),
    host: (req.body && req.body.host || '').trim(),
    port: Number(req.body && req.body.port),
  };
  const err = validatePeerEntry(e);
  if (err) return res.status(400).json({ error: 'invalid', detail: err });
  if (!original) return res.status(400).json({ error: 'missing_original_name' });
  if (e.name === settings.get().self.name) {
    return res.status(400).json({ error: 'invalid', detail: 'self.name은 peer 이름으로 사용할 수 없음' });
  }
  const existed = peerWatcher.getPeers().some((p) => p.name === original);
  if (!existed) return res.status(404).json({ error: 'not_found' });
  // Rename: remove the old key first to avoid leaving an orphan row.
  if (original !== e.name) {
    if (peerWatcher.getPeers().some((p) => p.name === e.name)) {
      return res.status(409).json({ error: 'duplicate_name' });
    }
    peerWatcher.removePeer(original);
  }
  peerWatcher.upsertPeer(e);
  res.json({ ok: true, peer: e });
});

router.post('/peer-remove', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const ok = peerWatcher.removePeer(name);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, name });
});

router.post('/peer-bulk-import', (req, res) => {
  // Accepts either { csv: "<text>" } or { entries: [...] }, plus
  // mode: 'merge' (default) | 'replace'.
  const body = req.body || {};
  let entries = [];
  let parseErrors = [];
  if (typeof body.csv === 'string' && body.csv.trim()) {
    const r = csvPeers.parse(body.csv);
    entries = r.entries;
    parseErrors = r.errors;
  } else if (Array.isArray(body.entries)) {
    for (const e of body.entries) {
      const err = validatePeerEntry(e);
      if (err) parseErrors.push({ message: err, entry: e });
      else entries.push({ name: e.name.trim(), host: e.host.trim(), port: Number(e.port) });
    }
  } else {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  if (parseErrors.length > 0) {
    return res.status(400).json({ error: 'parse_errors', errors: parseErrors });
  }
  // Drop self.name from the import — never adds itself as a peer.
  const selfName = settings.get().self.name;
  entries = entries.filter((e) => e.name !== selfName);
  if (entries.length === 0) {
    return res.status(400).json({ error: 'empty_import' });
  }
  const mode = body.mode === 'replace' ? 'replace' : 'merge';
  if (mode === 'replace') {
    peerWatcher.replaceAllPeers(entries);
  } else {
    peerWatcher.bulkUpsertPeers(entries);
  }
  res.json({ ok: true, mode, accepted: entries.length });
});

module.exports = router;
