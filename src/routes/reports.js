const express = require('express');
const db = require('../db');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const insertReport = db.prepare(
  `INSERT INTO reports (report_date, body) VALUES (?, ?)`
);
const updateReport = db.prepare(
  `UPDATE reports SET report_date = ?, body = ?, updated_at = datetime('now')
   WHERE id = ?`
);
const deleteReport = db.prepare(`DELETE FROM reports WHERE id = ?`);
const getReport = db.prepare(`SELECT * FROM reports WHERE id = ?`);
const insertReportCategory = db.prepare(
  `INSERT OR IGNORE INTO report_categories (report_id, category_id) VALUES (?, ?)`
);
const deleteReportCategories = db.prepare(
  `DELETE FROM report_categories WHERE report_id = ?`
);
const getReportCategories = db.prepare(
  `SELECT c.id, c.name, c.color
     FROM report_categories rc
     JOIN categories c ON c.id = rc.category_id
    WHERE rc.report_id = ?
    ORDER BY c.id ASC`
);
const getReportAttachments = db.prepare(
  `SELECT * FROM attachments WHERE report_id = ? ORDER BY id ASC`
);
const getReportComments = db.prepare(
  `SELECT id, report_id, author, body, created_at, acknowledged
     FROM report_comments WHERE report_id = ? ORDER BY id ASC`
);
const ackCommentStmt = db.prepare(
  `UPDATE report_comments SET acknowledged = 1 WHERE id = ? AND report_id = ?`
);
const categoryExists = db.prepare(`SELECT 1 FROM categories WHERE id = ?`);

const insertReportSchedule = db.prepare(
  `INSERT OR IGNORE INTO report_schedules (report_id, schedule_id) VALUES (?, ?)`
);
const deleteReportSchedules = db.prepare(
  `DELETE FROM report_schedules WHERE report_id = ?`
);
const getReportSchedules = db.prepare(
  `SELECT s.id, s.title, s.category_id, s.planned_start, s.planned_end,
          s.actual_start, s.actual_end, s.status, s.description
     FROM report_schedules rs
     JOIN schedules s ON s.id = rs.schedule_id
    WHERE rs.report_id = ?
    ORDER BY s.id ASC`
);
const scheduleExists = db.prepare(`SELECT 1 FROM schedules WHERE id = ?`);

function decorate(report) {
  if (!report) return report;
  return {
    ...report,
    categories: getReportCategories.all(report.id),
    schedules: getReportSchedules.all(report.id),
    attachments: getReportAttachments.all(report.id),
    comments: getReportComments.all(report.id),
  };
}

function validateBody(body) {
  if (typeof body !== 'string') return 'body_invalid';
  if (body.length > 100000) return 'body_too_long';
  return null;
}

// Coerce + validate an array of foreign-key IDs. Returns { error, detail }
// on failure or { ok: number[] } on success — every element guaranteed to be
// an integer that exists in the referenced table. JSON deserialization
// usually yields numbers already, but a client posting "3" instead of 3
// would otherwise slip past Number.isInteger silently. Caller passes the
// error tags to keep messages stable across endpoints.
function normalizeIdArray(arr, existsStmt, arrayErr, itemErr) {
  if (!Array.isArray(arr)) return { error: arrayErr };
  const out = [];
  for (const raw of arr) {
    const n = Number(raw);
    if (!Number.isInteger(n) || !existsStmt.get(n)) {
      return { error: itemErr, detail: raw };
    }
    out.push(n);
  }
  return { ok: out };
}

// GET /api/reports?category_id=N&schedule_id=N&date=YYYY-MM-DD
router.get('/', (req, res) => {
  const { category_id, schedule_id, date } = req.query;
  const where = [];
  const params = [];

  let sql = `SELECT DISTINCT r.* FROM reports r`;
  if (category_id !== undefined) {
    const cid = Number(category_id);
    if (!Number.isInteger(cid)) {
      return res.status(400).json({ error: 'invalid_category_id' });
    }
    sql += ` JOIN report_categories rc ON rc.report_id = r.id`;
    where.push(`rc.category_id = ?`);
    params.push(cid);
  }
  if (schedule_id !== undefined) {
    const sid = Number(schedule_id);
    if (!Number.isInteger(sid)) {
      return res.status(400).json({ error: 'invalid_schedule_id' });
    }
    sql += ` JOIN report_schedules rs ON rs.report_id = r.id`;
    where.push(`rs.schedule_id = ?`);
    params.push(sid);
  }
  if (date !== undefined) {
    if (!ISO_DATE.test(date)) {
      return res.status(400).json({ error: 'invalid_date' });
    }
    where.push(`r.report_date = ?`);
    params.push(date);
  }
  if (where.length) sql += ` WHERE ${where.join(' AND ')}`;
  sql += ` ORDER BY r.report_date DESC, r.id DESC`;

  const rows = db.prepare(sql).all(...params);
  res.json(rows.map(decorate));
});

router.get('/:id', (req, res) => {
  const r = getReport.get(Number(req.params.id));
  if (!r) return res.status(404).json({ error: 'not_found' });
  res.json(decorate(r));
});

router.post('/', (req, res) => {
  const {
    report_date,
    body = '',
    category_ids = [],
    schedule_ids = [],
  } = req.body || {};
  if (!ISO_DATE.test(report_date)) {
    return res.status(400).json({ error: 'invalid_date' });
  }
  const bodyErr = validateBody(body);
  if (bodyErr) return res.status(400).json({ error: bodyErr });

  const cv = normalizeIdArray(category_ids, categoryExists, 'category_ids_invalid', 'invalid_category_id');
  if (cv.error) return res.status(400).json({ error: cv.error, detail: cv.detail });
  const sv = normalizeIdArray(schedule_ids, scheduleExists, 'schedule_ids_invalid', 'invalid_schedule_id');
  if (sv.error) return res.status(400).json({ error: sv.error, detail: sv.detail });

  const id = db.transaction(() => {
    const info = insertReport.run(report_date, body);
    const newId = info.lastInsertRowid;
    for (const cid of cv.ok) insertReportCategory.run(newId, cid);
    for (const sid of sv.ok) insertReportSchedule.run(newId, sid);
    return newId;
  })();

  res.status(201).json(decorate(getReport.get(id)));
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getReport.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const body = req.body || {};
  const newDate = body.report_date ?? existing.report_date;
  const newBody = body.body ?? existing.body;

  if (!ISO_DATE.test(newDate)) {
    return res.status(400).json({ error: 'invalid_date' });
  }
  const bodyErr = validateBody(newBody);
  if (bodyErr) return res.status(400).json({ error: bodyErr });

  let categoryIds = null;
  if (body.category_ids !== undefined) {
    const cv = normalizeIdArray(body.category_ids, categoryExists, 'category_ids_invalid', 'invalid_category_id');
    if (cv.error) return res.status(400).json({ error: cv.error, detail: cv.detail });
    categoryIds = cv.ok;
  }

  let scheduleIds = null;
  if (body.schedule_ids !== undefined) {
    const sv = normalizeIdArray(body.schedule_ids, scheduleExists, 'schedule_ids_invalid', 'invalid_schedule_id');
    if (sv.error) return res.status(400).json({ error: sv.error, detail: sv.detail });
    scheduleIds = sv.ok;
  }

  db.transaction(() => {
    updateReport.run(newDate, newBody, id);
    if (categoryIds !== null) {
      deleteReportCategories.run(id);
      for (const cid of categoryIds) insertReportCategory.run(id, cid);
    }
    if (scheduleIds !== null) {
      deleteReportSchedules.run(id);
      for (const sid of scheduleIds) insertReportSchedule.run(id, sid);
    }
  })();

  res.json(decorate(getReport.get(id)));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  // Collect uploaded attachment files so we can clean them off disk after the row delete cascades.
  const uploads = db
    .prepare(`SELECT path FROM attachments WHERE report_id = ? AND kind = 'upload'`)
    .all(id);
  const info = deleteReport.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  // Delegate file cleanup to attachments module to keep paths in one place.
  const { cleanupUploadedFiles } = require('./attachments');
  cleanupUploadedFiles(uploads.map((u) => u.path));
  res.status(204).end();
});

// Acknowledge a comment received on this report. Local-only action — marks
// the comment as read so the "받은 코멘트 N" indicator can drop the count.
router.post('/:reportId/comments/:commentId/ack', (req, res) => {
  const reportId = Number(req.params.reportId);
  const commentId = Number(req.params.commentId);
  if (!Number.isInteger(reportId) || !Number.isInteger(commentId)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const info = ackCommentStmt.run(commentId, reportId);
  if (info.changes === 0) {
    return res.status(404).json({ error: 'comment_not_found' });
  }
  res.json({ ok: true, id: commentId });
});

module.exports = router;
