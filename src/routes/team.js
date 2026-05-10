const express = require('express');
const db = require('../db');
const peerWatcher = require('../team/peerWatcher');
const settings = require('../team/settings');
const cache = require('../team/cache');
const sync = require('../team/sync');
const exporter = require('../team/exporter');
const broadcaster = require('../team/peerBroadcaster');
const events = require('../team/events');
const csvPeers = require('../team/csvPeers');

const router = express.Router();

// Strip the IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`) so v4 literals match
// the host strings stored in peerStore. Mirrors clientIp() in server.js.
function clientIp(req) {
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

// Local-UI 전용 엔드포인트 가드 (C-3). server.js 의 WRITE_ALLOWLIST 와 동일
// 의미. team router 가 IP write-guard 보다 앞에 마운트되어 있으므로 여기서
// 직접 차단해야 LAN 의 비-사용자가 peer 목록을 조작하지 못함.
const WRITE_ALLOWLIST = new Set([
  '10.115.41.127',
  '10.115.33.155',
  '10.115.147.185',
  '192.168.0.16',
  '127.0.0.1',
  '::1',
]);
function localOnly(req, res, next) {
  if (WRITE_ALLOWLIST.has(clientIp(req))) return next();
  return res.status(403).json({ error: 'forbidden_local_only', ip: clientIp(req) });
}

const insertCommentStmt = db.prepare(
  `INSERT INTO report_comments (report_id, author, body) VALUES (?, ?, ?)`
);
const updateCommentStmt = db.prepare(
  `UPDATE report_comments SET body = ? WHERE id = ? AND author = ?`
);
const deleteCommentStmt = db.prepare(
  `DELETE FROM report_comments WHERE id = ? AND author = ?`
);
const getCommentStmt = db.prepare(
  `SELECT id, report_id, author, body, created_at FROM report_comments WHERE id = ?`
);
const reportExistsStmt = db.prepare(`SELECT 1 AS x FROM reports WHERE id = ?`);

const insertTaskReqStmt = db.prepare(
  `INSERT INTO task_requests (direction, sender, recipient, body, deadline, group_id, status)
   VALUES ('inbound', ?, ?, ?, ?, ?, 'pending')`
);
const insertTaskAttStmt = db.prepare(
  `INSERT INTO task_request_attachments (task_request_id, kind, path, display_name, size_bytes)
   VALUES (?, ?, ?, ?, ?)`
);
const findOutboundByGroupAndRecipientStmt = db.prepare(
  `SELECT * FROM task_requests
    WHERE direction = 'outbound' AND group_id = ? AND recipient = ?`
);
const updateTaskStatusStmt = db.prepare(
  `UPDATE task_requests SET status = ? WHERE id = ?`
);
const insertTaskCommentStmt = db.prepare(
  `INSERT INTO task_request_comments (task_request_id, author, body, proposed_deadline)
   VALUES (?, ?, ?, ?)`
);

// Authorize a cross-peer write and identify the originating team member.
//
// Why not strict IP→peer.name mapping anymore: when source and destination
// are on the same machine, the source IP may resolve to 127.0.0.1, ::1, or
// the LAN address depending on OS routing, which made the mapping flaky and
// caused author mismatches between insert and edit. Token+IP still gate
// access ("must be a known team member's machine"), but identity comes from
// the body's `origin` field — already trusted in /peer-update — keyed on
// the shared token.
function authenticateAndIdentify(req) {
  const ip = clientIp(req);
  const isLoopback = ip === '127.0.0.1' || ip === '::1';
  const peerAtIp = peerWatcher.getPeers().find((p) => p.host === ip);
  if (!isLoopback && !peerAtIp) {
    return { ok: false, error: 'not_team_member', ip };
  }
  const origin = (req.body && typeof req.body.origin === 'string')
    ? req.body.origin.trim()
    : '';
  if (!origin) return { ok: false, error: 'missing_origin', ip };
  // C-4: 외부 IP 의 origin 위조 차단. loopback 은 OS 라우팅 변동(127.0.0.1/
  // ::1/LAN 어느 쪽으로 잡힐지 불확실)을 회피하기 위해 origin 신뢰 유지.
  if (!isLoopback && peerAtIp.name !== origin) {
    return { ok: false, error: 'origin_mismatch', ip, expected: peerAtIp.name };
  }
  return { ok: true, name: origin, ip };
}

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

// Server-Sent Events stream — pushes new events to the browser as they
// happen instead of relying on the slower /events poll. The poll endpoint
// stays as a fallback for clients that can't open an EventSource.
router.get('/events-stream', (req, res) => {
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  res.write(': connected\n\n');
  events.subscribe(res);
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
    const cmtsByReport = new Map();
    for (const c of d.report_comments || []) {
      if (!cmtsByReport.has(c.report_id)) cmtsByReport.set(c.report_id, []);
      cmtsByReport.get(c.report_id).push(c);
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
      const cmts = (cmtsByReport.get(r.id) || []).map((c) => ({ ...c, owner }));
      merged.reports.push({
        ...r, owner, peerHost, peerPort,
        categories: cats, schedules: scheds, attachments: atts, comments: cmts,
      });
    }
  }
  res.json({ mode: 'ON', lastSyncAt: cache.getLastSyncAt(), ...merged });
});

router.post('/toggle', localOnly, async (req, res) => {
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

router.post('/sync', localOnly, async (req, res) => {
  if (cache.getMode() !== 'ON') {
    return res.status(409).json({ error: 'team_mode_off' });
  }
  await sync.syncAll();
  res.json({ ok: true, lastSyncAt: cache.getLastSyncAt() });
});

// ───── Local UI: peer list management (CRUD + bulk import) ─────
// All of the below mutate peerStore. peerBroadcaster watches peerStore and
// fans out add/edit/remove to other peers automatically.

router.post('/peer-add', localOnly, (req, res) => {
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
  if (peerWatcher.isSelfEntry(e)) {
    return res.status(400).json({ error: 'invalid', detail: '본인 IP·포트와 동일 — peer로 등록할 수 없음' });
  }
  if (peerWatcher.getPeers().some((p) => p.name === e.name)) {
    return res.status(409).json({ error: 'duplicate_name' });
  }
  peerWatcher.upsertPeer(e);
  res.json({ ok: true, peer: e });
});

router.post('/peer-edit', localOnly, (req, res) => {
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
  const existing = peerWatcher.getPeers().find((p) => p.name === original);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  if (peerWatcher.isSelfEntry(existing)) {
    return res.status(403).json({ error: 'self_protected', detail: '본인 항목은 편집할 수 없음' });
  }
  if (peerWatcher.isSelfEntry(e)) {
    return res.status(400).json({ error: 'invalid', detail: '본인 IP·포트와 동일 — 편집 결과로 본인이 됨' });
  }
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

router.post('/peer-remove', localOnly, (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'missing_name' });
  const target = peerWatcher.getPeers().find((p) => p.name === name);
  if (target && peerWatcher.isSelfEntry(target)) {
    return res.status(403).json({ error: 'self_protected', detail: '본인 항목은 삭제할 수 없음' });
  }
  const ok = peerWatcher.removePeer(name);
  if (!ok) return res.status(404).json({ error: 'not_found' });
  res.json({ ok: true, name });
});

// ───── Cross-peer comments on reports ─────
//
// comment-in  : received from another peer's server. Authenticated by token
//               and by IP-mapping (requester IP must match a peer.host in
//               our peer list). The matched peer's name becomes the author.
// comment-out : called by our own UI. Looks up the target peer by name,
//               then forwards to their /comment-in with our shared token.

router.post('/comment-in', tokenAuth, express.json(), (req, res) => {
  const { report_id, body } = req.body || {};
  const reportId = Number(report_id);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    return res.status(400).json({ error: 'invalid_report_id' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'empty_body' });
  }
  if (body.length > 10000) {
    return res.status(400).json({ error: 'body_too_long' });
  }
  if (!reportExistsStmt.get(reportId)) {
    return res.status(404).json({ error: 'report_not_found' });
  }
  const who = authenticateAndIdentify(req);
  if (!who.ok) return res.status(403).json({ error: who.error, ip: who.ip });
  const author = who.name;
  const info = insertCommentStmt.run(reportId, author, body.trim());
  events.record('comment_received', {
    author,
    report_id: reportId,
    bodyPreview: body.trim().slice(0, 80),
    commentId: info.lastInsertRowid,
  });
  res.json({ ok: true, id: info.lastInsertRowid, author });
});

// Edit a previously left comment. Only the original author (resolved by IP)
// is allowed — same security model as /comment-in.
router.post('/comment-edit-in', tokenAuth, express.json(), (req, res) => {
  const { comment_id, body } = req.body || {};
  const cid = Number(comment_id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ error: 'invalid_comment_id' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'empty_body' });
  }
  if (body.length > 10000) {
    return res.status(400).json({ error: 'body_too_long' });
  }
  const who = authenticateAndIdentify(req);
  if (!who.ok) return res.status(403).json({ error: who.error, ip: who.ip });
  const c = getCommentStmt.get(cid);
  if (!c) return res.status(404).json({ error: 'comment_not_found' });
  if (c.author !== who.name) return res.status(403).json({ error: 'not_author' });

  const info = updateCommentStmt.run(body.trim(), cid, who.name);
  if (info.changes === 0) return res.status(500).json({ error: 'update_failed' });
  events.record('comment_edited', {
    author: who.name,
    report_id: c.report_id,
    commentId: cid,
    bodyPreview: body.trim().slice(0, 80),
  });
  res.json({ ok: true, id: cid });
});

// Delete a previously left comment. Only the original author can remove it.
router.post('/comment-remove-in', tokenAuth, express.json(), (req, res) => {
  const { comment_id } = req.body || {};
  const cid = Number(comment_id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ error: 'invalid_comment_id' });
  }
  const who = authenticateAndIdentify(req);
  if (!who.ok) return res.status(403).json({ error: who.error, ip: who.ip });
  const c = getCommentStmt.get(cid);
  if (!c) return res.status(404).json({ error: 'comment_not_found' });
  if (c.author !== who.name) return res.status(403).json({ error: 'not_author' });

  const info = deleteCommentStmt.run(cid, who.name);
  if (info.changes === 0) return res.status(500).json({ error: 'delete_failed' });
  events.record('comment_removed', {
    author: who.name,
    report_id: c.report_id,
    commentId: cid,
  });
  res.json({ ok: true, id: cid });
});

router.post('/comment-out', express.json(), async (req, res) => {
  const { owner, report_id, body } = req.body || {};
  if (typeof owner !== 'string' || !owner.trim()) {
    return res.status(400).json({ error: 'missing_owner' });
  }
  const reportId = Number(report_id);
  if (!Number.isInteger(reportId) || reportId <= 0) {
    return res.status(400).json({ error: 'invalid_report_id' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'empty_body' });
  }
  const target = peerWatcher.getPeers().find((p) => p.name === owner.trim());
  if (!target) {
    return res.status(404).json({ error: 'peer_not_found', detail: owner });
  }
  const cfg = settings.get();
  if (!cfg.sharedToken) {
    return res.status(503).json({ error: 'team_token_not_configured' });
  }
  const url = `http://${target.host}:${target.port}/api/team/comment-in`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Team-Token': cfg.sharedToken,
      },
      body: JSON.stringify({
        origin: cfg.self.name,
        report_id: reportId,
        body: body.trim(),
      }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      return res.status(r.status).json({ error: 'forward_failed', detail: data });
    }
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'forward_error', detail: e.message });
  }
});

router.post('/comment-edit-out', express.json(), async (req, res) => {
  const { owner, comment_id, body } = req.body || {};
  if (typeof owner !== 'string' || !owner.trim()) {
    return res.status(400).json({ error: 'missing_owner' });
  }
  const cid = Number(comment_id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ error: 'invalid_comment_id' });
  }
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'empty_body' });
  }
  const target = peerWatcher.getPeers().find((p) => p.name === owner.trim());
  if (!target) return res.status(404).json({ error: 'peer_not_found', detail: owner });
  const cfg = settings.get();
  if (!cfg.sharedToken) return res.status(503).json({ error: 'team_token_not_configured' });
  const url = `http://${target.host}:${target.port}/api/team/comment-edit-in`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Team-Token': cfg.sharedToken },
      body: JSON.stringify({
        origin: cfg.self.name,
        comment_id: cid,
        body: body.trim(),
      }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: 'forward_failed', detail: data });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'forward_error', detail: e.message });
  }
});

router.post('/comment-remove-out', express.json(), async (req, res) => {
  const { owner, comment_id } = req.body || {};
  if (typeof owner !== 'string' || !owner.trim()) {
    return res.status(400).json({ error: 'missing_owner' });
  }
  const cid = Number(comment_id);
  if (!Number.isInteger(cid) || cid <= 0) {
    return res.status(400).json({ error: 'invalid_comment_id' });
  }
  const target = peerWatcher.getPeers().find((p) => p.name === owner.trim());
  if (!target) return res.status(404).json({ error: 'peer_not_found', detail: owner });
  const cfg = settings.get();
  if (!cfg.sharedToken) return res.status(503).json({ error: 'team_token_not_configured' });
  const url = `http://${target.host}:${target.port}/api/team/comment-remove-in`;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Team-Token': cfg.sharedToken },
      body: JSON.stringify({
        origin: cfg.self.name,
        comment_id: cid,
      }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) return res.status(r.status).json({ error: 'forward_failed', detail: data });
    res.json({ ok: true, ...data });
  } catch (e) {
    res.status(502).json({ error: 'forward_error', detail: e.message });
  }
});

// Cross-peer receive of a task request. Stored as 'inbound' on this side so
// the recipient can later list / view it. Attachment metadata is preserved
// but actual files stay on the sender's instance — clients fetch them via
// http://<sender-host>:<sender-port>/uploads/<path>. peer_port helps the
// frontend build that URL since the requester IP is the only identity the
// network gives us here.
router.post('/task-request-in', tokenAuth, express.json(), (req, res) => {
  const { body, deadline, group_id, attachments, prior_comments } = req.body || {};
  if (typeof body !== 'string' || !body.trim()) {
    return res.status(400).json({ error: 'empty_body' });
  }
  if (body.length > 10000) {
    return res.status(400).json({ error: 'body_too_long' });
  }
  const who = authenticateAndIdentify(req);
  if (!who.ok) return res.status(403).json({ error: who.error, ip: who.ip });

  const recipient = settings.get().self.name;
  const sender = who.name;
  let reqId = null;
  // Used only when seeding prior comments (need to preserve original ts).
  const insertCmtWithTs = db.prepare(
    `INSERT INTO task_request_comments (task_request_id, author, body, created_at, proposed_deadline)
     VALUES (?, ?, ?, ?, ?)`
  );
  db.transaction(() => {
    const info = insertTaskReqStmt.run(
      sender, recipient, body.trim(), deadline || null, group_id || null
    );
    reqId = info.lastInsertRowid;
    if (Array.isArray(attachments)) {
      for (const a of attachments) {
        if (!a || typeof a.path !== 'string' || !a.path) continue;
        if (!a.kind || (a.kind !== 'upload' && a.kind !== 'local_path')) continue;
        const dn = typeof a.display_name === 'string' ? a.display_name : a.path;
        const sz = Number.isInteger(a.size_bytes) ? a.size_bytes : null;
        insertTaskAttStmt.run(reqId, a.kind, a.path, dn, sz);
      }
    }
    // Seed prior negotiation thread (재요청 시 sender 가 동봉) so the
    // recipient's new inbound row carries the same comment history.
    if (Array.isArray(prior_comments) && prior_comments.length > 0) {
      console.log(`[task] task-request-in: prior_comments ${prior_comments.length}건 수신 → 새 inbound row=${reqId} 에 seed`);
      for (const c of prior_comments) {
        if (!c || typeof c !== 'object') continue;
        const author = typeof c.author === 'string' ? c.author : '?';
        const cBody = typeof c.body === 'string' ? c.body : '';
        const ts = typeof c.created_at === 'string' ? c.created_at : new Date().toISOString();
        const pd = typeof c.proposed_deadline === 'string' ? c.proposed_deadline : null;
        insertCmtWithTs.run(reqId, author, cBody, ts, pd);
      }
    }
  })();

  events.record('task_request_received', {
    sender,
    bodyPreview: body.trim().slice(0, 80),
    deadline: deadline || null,
    groupId: group_id || null,
    requestId: reqId,
  });

  res.json({ ok: true, id: reqId });
});

// Cross-peer receive of recipient's response (수락/조정/거부 + optional
// comment). Updates the matching outbound row's status and replicates the
// comment so sender's outbound view shows the negotiation.
router.post('/task-response-in', tokenAuth, express.json(), (req, res) => {
  const { group_id, status, comment, proposed_deadline } = req.body || {};
  if (typeof group_id !== 'string' || !group_id) {
    return res.status(400).json({ error: 'invalid_group_id' });
  }
  const VALID = new Set(['pending', 'accepted', 'adjusted', 'rejected']);
  if (!VALID.has(String(status))) {
    return res.status(400).json({ error: 'invalid_status' });
  }
  const who = authenticateAndIdentify(req);
  if (!who.ok) {
    console.warn(`[task] task-response-in 거부 — ${who.error} (ip=${who.ip})`);
    return res.status(403).json({ error: who.error, ip: who.ip });
  }
  console.log(`[task] task-response-in 수신: from=${who.name} group=${group_id} status=${status}`);

  // Find sender's outbound row that matches (group_id, recipient = origin).
  const row = findOutboundByGroupAndRecipientStmt.get(group_id, who.name);
  if (!row) {
    console.warn(`[task] task-response-in: outbound 매칭 실패 — group_id='${group_id}' recipient='${who.name}' (현재 outbound rows 의 group_id 와 recipient 가 일치해야 함)`);
    return res.status(404).json({ error: 'outbound_not_found' });
  }

  const cBody = typeof comment === 'string' ? comment.trim() : '';
  const dl = typeof proposed_deadline === 'string' ? proposed_deadline.trim() || null : null;
  db.transaction(() => {
    updateTaskStatusStmt.run(status, row.id);
    if (cBody || dl) {
      insertTaskCommentStmt.run(row.id, who.name, cBody, dl);
    }
  })();

  events.record('task_request_responded', {
    responder: who.name,
    groupId: group_id,
    status,
    bodyPreview: typeof comment === 'string' ? comment.trim().slice(0, 80) : '',
    requestId: row.id,
  });

  res.json({ ok: true, id: row.id });
});

// Cross-peer pull endpoint — caller (the original sender) asks "what are
// the inbound rows you have where I'm the sender, plus their comments?".
// Used by the requester to reconcile statuses if the push (task-response-in)
// failed earlier (recipient was offline when sender pushed, network blip,
// etc.). Returns the responder's authoritative state per thread.
router.post('/task-statuses-for-sender', tokenAuth, express.json(), (req, res) => {
  const who = authenticateAndIdentify(req);
  if (!who.ok) return res.status(403).json({ error: who.error, ip: who.ip });
  const rows = db.prepare(
    `SELECT id, group_id, status, body, deadline, created_at, sender, recipient
       FROM task_requests
      WHERE direction = 'inbound' AND sender = ?
      ORDER BY id ASC`
  ).all(who.name);
  const getCmts = db.prepare(
    `SELECT id, author, body, created_at, proposed_deadline
       FROM task_request_comments
      WHERE task_request_id = ? ORDER BY id ASC`
  );
  const out = rows.map((r) => ({ ...r, comments: getCmts.all(r.id) }));
  res.json({ statuses: out });
});

router.post('/peer-announce', localOnly, async (req, res) => {
  try {
    const result = await broadcaster.announceCurrentList();
    res.json({ ok: true, ...result });
  } catch (e) {
    res.status(500).json({ error: 'announce_failed', detail: e.message });
  }
});

router.post('/peer-bulk-import', localOnly, (req, res) => {
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
