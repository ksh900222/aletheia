const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../db');
const settings = require('../team/settings');
const peerWatcher = require('../team/peerWatcher');
const events = require('../team/events');

const router = express.Router();

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    const safe = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    cb(null, safe + ext);
  },
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

const insertReqStmt = db.prepare(
  `INSERT INTO task_requests (direction, sender, recipient, body, deadline, group_id, status)
   VALUES (?, ?, ?, ?, ?, ?, 'pending')`
);
const insertAttStmt = db.prepare(
  `INSERT INTO task_request_attachments (task_request_id, kind, path, display_name, size_bytes)
   VALUES (?, ?, ?, ?, ?)`
);
const listOutboundStmt = db.prepare(
  `SELECT * FROM task_requests WHERE direction = 'outbound' ORDER BY id DESC`
);
const listInboundStmt = db.prepare(
  `SELECT * FROM task_requests WHERE direction = 'inbound' ORDER BY id DESC`
);
const getAttsForReqStmt = db.prepare(
  `SELECT id, kind, path, display_name, size_bytes, created_at
     FROM task_request_attachments WHERE task_request_id = ? ORDER BY id ASC`
);

function decorate(req) {
  if (!req) return req;
  return { ...req, attachments: getAttsForReqStmt.all(req.id) };
}

// POST /api/tasks/request
// multipart/form-data: recipients (JSON array), body (text), deadline (text), files[]
// On success, inserts an outbound row per recipient (sharing a group_id) and
// forwards each to the matching peer's /api/team/task-request-in.
router.post('/request', upload.array('files', 20), async (req, res) => {
  let recipientList = [];
  try {
    recipientList = JSON.parse(req.body.recipients || '[]');
  } catch (e) {
    return res.status(400).json({ error: 'invalid_recipients' });
  }
  if (!Array.isArray(recipientList) || recipientList.length === 0) {
    return res.status(400).json({ error: 'no_recipients' });
  }
  const body = String(req.body.body || '').trim();
  if (!body) return res.status(400).json({ error: 'empty_body' });
  if (body.length > 10000) return res.status(400).json({ error: 'body_too_long' });
  // Deadline format: client sends "YYYY-MM-DD HH:MM" or empty. Accept any
  // non-empty string and trust the client format for v1.
  const deadline = req.body.deadline ? String(req.body.deadline).trim() : null;

  const cfg = settings.get();
  const sender = cfg.self.name;
  if (!sender) return res.status(503).json({ error: 'self_name_not_configured' });

  // Resolve recipients against the local peer list. Reject names that aren't
  // registered — keeps drift between the picker and the active list explicit.
  const peers = peerWatcher.getPeers();
  const validRecipients = [];
  const unknown = [];
  for (const rname of recipientList) {
    const p = peers.find((q) => q.name === rname);
    if (!p) unknown.push(rname);
    else validRecipients.push(p);
  }
  if (validRecipients.length === 0) {
    return res.status(400).json({ error: 'no_valid_recipients', detail: { unknown } });
  }

  const groupId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const fileMeta = (req.files || []).map((f) => ({
    kind: 'upload',
    path: f.filename,
    display_name: f.originalname,
    size_bytes: f.size,
  }));

  // Insert outbound rows + attachment metadata for each recipient.
  const insertedIds = [];
  const tx = db.transaction(() => {
    for (const peer of validRecipients) {
      const info = insertReqStmt.run('outbound', sender, peer.name, body, deadline, groupId);
      const reqId = info.lastInsertRowid;
      insertedIds.push(reqId);
      for (const m of fileMeta) {
        insertAttStmt.run(reqId, m.kind, m.path, m.display_name, m.size_bytes);
      }
    }
  });
  tx();

  // Fire-and-forget cross-peer forwards. Sender's response returns immediately;
  // recipient delivery is best-effort (peer may be offline).
  forwardTaskRequests(validRecipients, {
    sender, body, deadline, groupId, attachments: fileMeta,
    selfHost: undefined, selfPort: cfg.self.port,
  }).catch((e) => console.warn('[task] forward error:', e.message));

  res.json({
    ok: true,
    groupId,
    inserted: insertedIds.length,
    delivered_to: validRecipients.map((p) => p.name),
    unknown,
  });
});

// GET /api/tasks/outbound — sender's view of what they sent (grouped optionally
// later; v1 returns raw rows decorated with attachments).
router.get('/outbound', (req, res) => {
  const rows = listOutboundStmt.all().map(decorate);
  res.json(rows);
});

// GET /api/tasks/inbound — receiver's view (used by future "요청받은 업무").
router.get('/inbound', (req, res) => {
  const rows = listInboundStmt.all().map(decorate);
  res.json(rows);
});

async function forwardTaskRequests(targets, payload) {
  const cfg = settings.get();
  if (!cfg.sharedToken) return;
  await Promise.all(targets.map(async (peer) => {
    const url = `http://${peer.host}:${peer.port}/api/team/task-request-in`;
    try {
      await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Team-Token': cfg.sharedToken,
        },
        body: JSON.stringify({
          origin: payload.sender,
          body: payload.body,
          deadline: payload.deadline,
          group_id: payload.groupId,
          attachments: payload.attachments,
          // Tell recipient where to fetch upload-kind files from.
          peer_port: payload.selfPort,
        }),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
      });
    } catch (e) {
      console.warn(`[task] forward → ${peer.name} 실패: ${e.message}`);
    }
  }));
}

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
