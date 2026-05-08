const express = require('express');
const peerWatcher = require('../team/peerWatcher');
const settings = require('../team/settings');
const cache = require('../team/cache');
const sync = require('../team/sync');
const exporter = require('../team/exporter');
const broadcaster = require('../team/peerBroadcaster');
const events = require('../team/events');

const router = express.Router();

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
  // CSV reload (triggered by our own write) does not re-send them outward.
  for (const e of valid) {
    broadcaster.rememberBroadcast(`${e.name}|${e.host}|${e.port}`);
  }

  const current = peerWatcher.getPeers();
  const byName = new Map(current.map((p) => [p.name, p]));
  for (const e of valid) {
    byName.set(e.name, { name: e.name, host: e.host, port: e.port });
  }
  const merged = Array.from(byName.values());

  peerWatcher.markInboundWrite();
  peerWatcher.writePeers(merged);

  events.record('peer_update_received', { origin: origin || null, entries: valid });

  res.json({ accepted: valid.length, origin: origin || null });
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
      const atts = (attsByReport.get(r.id) || []).map((a) => ({ ...a, owner }));
      merged.reports.push({ ...r, owner, categories: cats, schedules: scheds, attachments: atts });
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

module.exports = router;
