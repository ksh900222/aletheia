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
const getCommentsForReqStmt = db.prepare(
  `SELECT id, task_request_id, author, body, created_at, proposed_deadline
     FROM task_request_comments WHERE task_request_id = ? ORDER BY id ASC`
);
const getReqByIdStmt = db.prepare(`SELECT * FROM task_requests WHERE id = ?`);
const updateReqStatusStmt = db.prepare(
  `UPDATE task_requests SET status = ? WHERE id = ?`
);
const insertCommentStmt = db.prepare(
  `INSERT INTO task_request_comments (task_request_id, author, body, proposed_deadline)
   VALUES (?, ?, ?, ?)`
);

const getLinkedScheduleStmt = db.prepare(
  `SELECT s.id, s.category_id, c.name AS category_name, c.color AS category_color,
          s.title, s.description, s.planned_start, s.planned_end, s.status
     FROM schedules s
     LEFT JOIN categories c ON c.id = s.category_id
    WHERE s.id = ?`
);

function decorate(req) {
  if (!req) return req;
  let schedule = null;
  if (req.schedule_id) {
    schedule = getLinkedScheduleStmt.get(req.schedule_id) || null;
  }
  return {
    ...req,
    attachments: getAttsForReqStmt.all(req.id),
    comments: getCommentsForReqStmt.all(req.id),
    schedule,
  };
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
  // Deadline format: client sends "YYYY-MM-DD HH:MM". Required — frontend
  // also blocks empty deadlines but we double-check here.
  const deadline = req.body.deadline ? String(req.body.deadline).trim() : '';
  if (!deadline) return res.status(400).json({ error: 'deadline_required' });

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

  // Reissue support — when set, copy the prior negotiation thread per
  // recipient so the new request continues the conversation instead of
  // resetting it.
  const fromGroupId = (req.body.from_group_id || '').trim() || null;
  const findOldOutboundStmt = db.prepare(
    `SELECT id FROM task_requests
      WHERE direction = 'outbound' AND group_id = ? AND recipient = ?`
  );
  const getOldCommentsStmt = db.prepare(
    `SELECT author, body, created_at, proposed_deadline
       FROM task_request_comments WHERE task_request_id = ? ORDER BY id ASC`
  );
  const insertCommentWithTsStmt = db.prepare(
    `INSERT INTO task_request_comments (task_request_id, author, body, created_at, proposed_deadline)
     VALUES (?, ?, ?, ?, ?)`
  );
  // Per-recipient prior comments → forwarded so the recipient's new inbound
  // row mirrors the same thread.
  const priorByRecipient = {};

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
      if (fromGroupId) {
        const old = findOldOutboundStmt.get(fromGroupId, peer.name);
        if (old) {
          const oldComments = getOldCommentsStmt.all(old.id);
          console.log(`[task] reissue: 이전 group=${fromGroupId} recipient=${peer.name} → outbound id=${old.id} 의 코멘트 ${oldComments.length}개 복사`);
          for (const c of oldComments) {
            insertCommentWithTsStmt.run(
              reqId, c.author, c.body, c.created_at, c.proposed_deadline || null
            );
          }
          priorByRecipient[peer.name] = oldComments;
        } else {
          console.warn(`[task] reissue: 이전 group=${fromGroupId} recipient=${peer.name} 에 매칭되는 outbound row 없음`);
        }
      }
    }
  });
  tx();

  // Fire-and-forget cross-peer forwards. Sender's response returns immediately;
  // recipient delivery is best-effort (peer may be offline).
  forwardTaskRequests(validRecipients, {
    sender, body, deadline, groupId, attachments: fileMeta,
    selfHost: undefined, selfPort: cfg.self.port,
    priorByRecipient,
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

// GET /api/tasks/inbound — receiver's view of incoming requests.
router.get('/inbound', (req, res) => {
  const rows = listInboundStmt.all().map(decorate);
  res.json(rows);
});

// GET /api/tasks/inbound-stats — small payload used to keep the launcher /
// choice-modal badge fresh without pulling the full list.
router.get('/inbound-stats', (req, res) => {
  const row = db.prepare(
    `SELECT COUNT(*) AS n FROM task_requests
      WHERE direction = 'inbound' AND status = 'pending'`
  ).get();
  res.json({ pending: row ? row.n : 0 });
});

// GET /api/tasks/:id — single decorated row (any direction).
router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = getReqByIdStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(decorate(row));
});

// POST /api/tasks/:id/respond — recipient's accept / adjust / reject action.
// 조정 must include a comment body; accept / reject can omit it. The status
// is mirrored back to the sender via /api/team/task-response-in, and the
// comment (if any) is replicated to the sender's matching outbound row.
router.post('/:id/respond', express.json(), async (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = getReqByIdStmt.get(id);
  if (!row) return res.status(404).json({ error: 'not_found' });
  if (row.direction !== 'inbound') {
    return res.status(400).json({ error: 'not_inbound' });
  }
  const action = String(req.body && req.body.action || '');
  const STATUS_MAP = { accept: 'accepted', adjust: 'adjusted', reject: 'rejected' };
  const newStatus = STATUS_MAP[action];
  if (!newStatus) return res.status(400).json({ error: 'invalid_action' });
  const body = (req.body && typeof req.body.body === 'string')
    ? req.body.body.trim()
    : '';
  if (action === 'adjust' && !body) {
    return res.status(400).json({ error: 'body_required_for_adjust' });
  }
  if (body.length > 10000) return res.status(400).json({ error: 'body_too_long' });
  // Optional: recipient may suggest a new deadline along with the comment.
  // Format mirrors task deadlines: "YYYY-MM-DD HH:MM" or null.
  const proposedDeadline = (req.body && typeof req.body.proposed_deadline === 'string')
    ? req.body.proposed_deadline.trim() || null
    : null;
  // If only the deadline was proposed without a comment, create a synthetic
  // comment row anyway so the proposal travels with the response payload.
  const shouldInsertComment = body || proposedDeadline;

  const cfg = settings.get();
  const me = cfg.self.name;

  db.transaction(() => {
    updateReqStatusStmt.run(newStatus, id);
    if (shouldInsertComment) {
      insertCommentStmt.run(id, me, body, proposedDeadline);
    }
  })();

  // Forward to sender so their outbound row updates too. row.sender is the
  // peer name; row.group_id ties the matching outbound row.
  const target = peerWatcher.getPeers().find((p) => p.name === row.sender);
  if (!target) {
    console.warn(`[task] response forward 스킵 — peer list 에 sender '${row.sender}' 없음`);
  } else if (!cfg.sharedToken) {
    console.warn(`[task] response forward 스킵 — sharedToken 미설정`);
  } else {
    const url = `http://${target.host}:${target.port}/api/team/task-response-in`;
    console.log(`[task] response forward → ${row.sender} (${url}) status=${newStatus} group=${row.group_id}`);
    fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Team-Token': cfg.sharedToken,
      },
      body: JSON.stringify({
        origin: me,
        group_id: row.group_id,
        status: newStatus,
        comment: body || null,
        proposed_deadline: proposedDeadline,
      }),
      signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
    }).then(async (r) => {
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        console.warn(`[task] response forward → ${row.sender} HTTP ${r.status} ${txt}`);
      } else {
        console.log(`[task] response forward → ${row.sender} OK`);
      }
    }).catch((e) => console.warn(`[task] response forward → ${row.sender} 실패: ${e.message}`));
  }

  res.json({ ok: true, id, status: newStatus });
});

// POST /api/tasks/sync-outbound — pull authoritative status + comments from
// every peer in our list. Updates our local outbound rows so the UI reflects
// reality even when an earlier push (task-response-in) was missed.
router.post('/sync-outbound', async (req, res) => {
  const cfg = settings.get();
  if (!cfg.sharedToken) {
    return res.status(503).json({ error: 'team_token_not_configured' });
  }
  const peers = peerWatcher.getPeers().filter((p) => !peerWatcher.isSelfEntry(p));
  const summary = { syncedPeers: 0, updatedRows: 0, errors: [] };

  const findOutboundStmt = db.prepare(
    `SELECT id, status FROM task_requests
      WHERE direction = 'outbound' AND group_id = ? AND recipient = ?`
  );
  const updateStatusStmt = db.prepare(
    `UPDATE task_requests SET status = ? WHERE id = ?`
  );
  const deleteCmtsStmt = db.prepare(
    `DELETE FROM task_request_comments WHERE task_request_id = ?`
  );
  const insertCmtStmt = db.prepare(
    `INSERT INTO task_request_comments (task_request_id, author, body, created_at, proposed_deadline)
     VALUES (?, ?, ?, ?, ?)`
  );

  await Promise.all(peers.map(async (peer) => {
    const url = `http://${peer.host}:${peer.port}/api/team/task-statuses-for-sender`;
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Team-Token': cfg.sharedToken,
        },
        body: JSON.stringify({ origin: cfg.self.name }),
        signal: AbortSignal.timeout(cfg.requestTimeoutMs || 5000),
      });
      if (!r.ok) {
        summary.errors.push({ peer: peer.name, status: r.status });
        return;
      }
      const data = await r.json().catch(() => ({}));
      const statuses = Array.isArray(data.statuses) ? data.statuses : [];
      // Apply each status to our matching outbound row.
      db.transaction(() => {
        for (const s of statuses) {
          const local = findOutboundStmt.get(s.group_id, peer.name);
          if (!local) continue;
          let changed = false;
          if (local.status !== s.status) {
            updateStatusStmt.run(s.status, local.id);
            changed = true;
          }
          // Replace local comments with authoritative copy from the
          // responder. Recipient is the only writer of these comments so
          // their row is the source of truth.
          const incoming = Array.isArray(s.comments) ? s.comments : [];
          if (incoming.length > 0) {
            deleteCmtsStmt.run(local.id);
            for (const c of incoming) {
              insertCmtStmt.run(local.id, c.author, c.body, c.created_at, c.proposed_deadline || null);
            }
            changed = true;
          }
          if (changed) summary.updatedRows += 1;
        }
      })();
      summary.syncedPeers += 1;
    } catch (e) {
      summary.errors.push({ peer: peer.name, message: e.message });
    }
  }));

  res.json({ ok: true, ...summary });
});

// POST /api/tasks/:id/save-schedule — when an inbound request is accepted,
// the recipient turns it into a real schedule on their own planner. If a
// schedule was already linked, this updates it; otherwise it inserts a new
// schedule and stores its id on the task_requests row.
const insertScheduleStmt = db.prepare(
  `INSERT INTO schedules (category_id, title, description, planned_start, planned_end, status)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const updateScheduleStmt = db.prepare(
  `UPDATE schedules SET category_id = ?, title = ?, description = ?,
                        planned_start = ?, planned_end = ?, status = ?,
                        updated_at = datetime('now')
    WHERE id = ?`
);
const linkScheduleToTaskStmt = db.prepare(
  `UPDATE task_requests SET schedule_id = ? WHERE id = ?`
);
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

router.post('/:id/save-schedule', express.json(), (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const row = getReqByIdStmt.get(id);
  if (!row) return res.status(404).json({ error: 'task_not_found' });
  if (row.direction !== 'inbound') {
    return res.status(400).json({ error: 'not_inbound' });
  }
  const b = req.body || {};
  const categoryId  = Number(b.category_id);
  const title       = String(b.title || '').trim();
  const description = String(b.description || '').trim();
  const start       = String(b.planned_start || '').trim();
  const end         = String(b.planned_end || '').trim();
  const status      = String(b.status || 'not_started').trim() || 'not_started';
  if (!Number.isInteger(categoryId) || categoryId <= 0) {
    return res.status(400).json({ error: 'invalid_category_id' });
  }
  if (!title) return res.status(400).json({ error: 'empty_title' });
  if (!ISO_DATE_RE.test(start)) return res.status(400).json({ error: 'invalid_start' });
  if (!ISO_DATE_RE.test(end))   return res.status(400).json({ error: 'invalid_end' });
  if (start > end) return res.status(400).json({ error: 'start_after_end' });

  const catExists = db.prepare(`SELECT 1 FROM categories WHERE id = ?`).get(categoryId);
  if (!catExists) return res.status(400).json({ error: 'category_not_found' });

  let schedId = row.schedule_id;
  db.transaction(() => {
    if (schedId) {
      updateScheduleStmt.run(categoryId, title, description, start, end, status, schedId);
    } else {
      const info = insertScheduleStmt.run(categoryId, title, description, start, end, status);
      schedId = info.lastInsertRowid;
      linkScheduleToTaskStmt.run(schedId, id);
    }
  })();
  res.json({ ok: true, schedule_id: schedId });
});

async function forwardTaskRequests(targets, payload) {
  const cfg = settings.get();
  if (!cfg.sharedToken) return;
  const priorByRecipient = payload.priorByRecipient || {};
  await Promise.all(targets.map(async (peer) => {
    const url = `http://${peer.host}:${peer.port}/api/team/task-request-in`;
    const priorN = (priorByRecipient[peer.name] || []).length;
    if (priorN > 0) console.log(`[task] forward → ${peer.name} prior_comments=${priorN}건 동봉`);
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
          // Reissue carry-over: prior negotiation comments to seed the new
          // inbound row's thread (this peer only).
          prior_comments: priorByRecipient[peer.name] || [],
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
