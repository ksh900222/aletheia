const express = require('express');
const db = require('../db');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const insertReport = db.prepare(
  `INSERT INTO reports (report_date, body, exclude_from_team) VALUES (?, ?, ?)`
);
const updateReport = db.prepare(
  `UPDATE reports
      SET report_date = ?, body = ?, exclude_from_team = ?,
          updated_at = datetime('now')
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
    exclude_from_team = 0,
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

  const excludeFlag = exclude_from_team ? 1 : 0;

  const id = db.transaction(() => {
    const info = insertReport.run(report_date, body, excludeFlag);
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
  const newExclude = body.exclude_from_team === undefined
    ? (existing.exclude_from_team ? 1 : 0)
    : (body.exclude_from_team ? 1 : 0);
  const excludeBecameOn =
    newExclude === 1 && (existing.exclude_from_team ? 1 : 0) === 0;

  if (!ISO_DATE.test(newDate)) {
    return res.status(400).json({ error: 'invalid_date' });
  }
  const bodyErr = validateBody(newBody);
  if (bodyErr) return res.status(400).json({ error: bodyErr });

  // 날짜는 연결된 스케줄(들) 의 계획 기간 합집합 안에 있어야 함. 미연결
  // 리포트(legacy) 는 제약 없음. 다중 스케줄이면 min(planned_start) ~
  // max(planned_end). 프론트엔드 input min/max 와 동일한 규칙.
  const linkedSchedules = getReportSchedules.all(id);
  if (linkedSchedules.length > 0) {
    let minStart = null;
    let maxEnd = null;
    for (const s of linkedSchedules) {
      if (s.planned_start && (!minStart || s.planned_start < minStart)) minStart = s.planned_start;
      if (s.planned_end && (!maxEnd || s.planned_end > maxEnd)) maxEnd = s.planned_end;
    }
    if ((minStart && newDate < minStart) || (maxEnd && newDate > maxEnd)) {
      return res.status(400).json({
        error: 'date_out_of_range',
        detail: { min: minStart, max: maxEnd, given: newDate },
      });
    }
  }

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
    updateReport.run(newDate, newBody, newExclude, id);
    if (categoryIds !== null) {
      deleteReportCategories.run(id);
      for (const cid of categoryIds) insertReportCategory.run(id, cid);
    }
    if (scheduleIds !== null) {
      deleteReportSchedules.run(id);
      for (const sid of scheduleIds) insertReportSchedule.run(id, sid);
    }
    if (newExclude === 1) {
      // 공유 제외된 리포트는 본인의 스프린트 그룹 멤버에서도 즉시 제거.
      // peer 가 만든 그룹은 본인이 건드릴 수 없지만, exporter 가 해당 리포트
      // 를 더 이상 내보내지 않으므로 peer 측 live 데이터에서 사라지고
      // snapshot fallback 으로 처리된다.
      removeReportFromOwnGroups(id);
    } else {
      // 본인 리포트가 수정되면, 본인이 만든 스프린트 그룹 중 이 리포트를
      // 멤버로 가진 그룹들의 snapshot 을 새 본문으로 갱신한다. group 의
      // updated_at 도 함께 bump 해서 다음 sync 때 peer 들에게 전파.
      refreshOwnGroupSnapshotsForReport(id, newDate, newBody);
    }
  })();

  // 토글이 바뀌면 reports.updated_at 이 갱신되어 exporter.computeVersion()
  // 의 fingerprint 가 바뀌므로, peer 들의 다음 polling 에서 자동으로 반영됨.
  // 즉시 전파를 위한 별도 트리거는 불필요.
  void excludeBecameOn;

  res.json(decorate(getReport.get(id)));
});

const refreshSnapshotByReportStmt = db.prepare(
  `UPDATE sprint_group_members
      SET snapshot_date = ?, snapshot_body = ?, snapshot_updated_at = datetime('now')
    WHERE group_creator = '' AND report_owner = '' AND report_id = ?`
);
const bumpOwnGroupsForReportStmt = db.prepare(
  `UPDATE sprint_groups SET updated_at = datetime('now')
    WHERE creator = '' AND id IN (
      SELECT DISTINCT group_id FROM sprint_group_members
       WHERE group_creator = '' AND report_owner = '' AND report_id = ?
    )`
);
function refreshOwnGroupSnapshotsForReport(reportId, newDate, newBody) {
  const info = refreshSnapshotByReportStmt.run(newDate || '', newBody || '', reportId);
  if (info.changes > 0) bumpOwnGroupsForReportStmt.run(reportId);
}

// 「팀원 공유 제외」 토글이 1 로 켜졌을 때, 본인이 만든 스프린트 그룹 (creator
// = '') 의 멤버에서 이 리포트를 즉시 제거. 영향받은 그룹의 updated_at 도 함께
// bump 해서 peer 들이 다음 polling 에서 그룹 멤버 변경을 인지하게 한다.
const deleteFromOwnGroupsStmt = db.prepare(
  `DELETE FROM sprint_group_members
    WHERE group_creator = '' AND report_owner = '' AND report_id = ?`
);
const bumpOwnGroupsAffectedStmt = db.prepare(
  `UPDATE sprint_groups SET updated_at = datetime('now')
    WHERE creator = '' AND id IN (
      SELECT DISTINCT group_id FROM sprint_group_members
       WHERE group_creator = '' AND report_owner = '' AND report_id = ?
    )`
);
function removeReportFromOwnGroups(reportId) {
  // bump 먼저 (DELETE 후엔 멤버 행이 사라져 SELECT 가 0 건이 됨).
  bumpOwnGroupsAffectedStmt.run(reportId);
  deleteFromOwnGroupsStmt.run(reportId);
}

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  // Collect uploaded attachment files so we can clean them off disk after the row delete cascades.
  const uploads = db
    .prepare(`SELECT path FROM attachments WHERE report_id = ? AND kind = 'upload'`)
    .all(id);
  // 본인 own 스프린트 그룹의 멤버 행에서 이 리포트를 먼저 제거 (그룹의
  // updated_at 도 bump). 이후 reports 행을 지우면 FK CASCADE 가
  // report_categories / report_schedules / attachments / report_comments 를
  // 정리. peer 가 만든 그룹은 본인이 건드릴 수 없지만 다음 polling 에서
  // 우리 exporter 가 더 이상 이 리포트를 내보내지 않으므로 peer 측은 live
  // 데이터에서 사라지고 snapshot fallback 으로 처리됨.
  removeReportFromOwnGroups(id);
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
