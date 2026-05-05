const express = require('express');
const db = require('../db');
const scheduler = require('../engine/scheduler');

const router = express.Router();

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set([
  'not_started',
  'in_progress',
  'pending',
  'blocked',
  'done',
]);

const listAllStmt = db.prepare(
  `SELECT * FROM schedules ORDER BY planned_start ASC, id ASC`
);
const listByCategoryStmt = db.prepare(
  `SELECT * FROM schedules WHERE category_id = ? ORDER BY planned_start ASC, id ASC`
);
const getStmt = db.prepare(`SELECT * FROM schedules WHERE id = ?`);
const categoryExistsStmt = db.prepare(
  `SELECT 1 FROM categories WHERE id = ?`
);
const insertStmt = db.prepare(
  `INSERT INTO schedules
     (category_id, title, description, planned_start, planned_end,
      actual_start, actual_end, status)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
);
const updateStmt = db.prepare(
  `UPDATE schedules
     SET category_id = ?, title = ?, description = ?,
         planned_start = ?, planned_end = ?,
         actual_start = ?, actual_end = ?,
         status = ?, updated_at = datetime('now')
   WHERE id = ?`
);
const deleteStmt = db.prepare(`DELETE FROM schedules WHERE id = ?`);
const deleteDepsBySchedule = db.prepare(
  `DELETE FROM dependencies
     WHERE (pred_type = 'schedule' AND pred_id = ?)
        OR (succ_type = 'schedule' AND succ_id = ?)`
);

function validateDates(start, end) {
  if (!ISO_DATE.test(start)) return 'planned_start_invalid';
  if (!ISO_DATE.test(end)) return 'planned_end_invalid';
  if (start > end) return 'end_before_start';
  return null;
}

function withSlack(row) {
  if (!row) return row;
  return { ...row, slack_days: scheduler.slackDaysFor(row.id) };
}

router.get('/', (req, res) => {
  const { category_id } = req.query;
  let rows;
  if (category_id !== undefined) {
    const cid = Number(category_id);
    if (!Number.isInteger(cid)) {
      return res.status(400).json({ error: 'invalid_category_id' });
    }
    rows = listByCategoryStmt.all(cid);
  } else {
    rows = listAllStmt.all();
  }
  res.json(rows.map(withSlack));
});

router.get('/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(withSlack(row));
});

router.post('/', (req, res) => {
  const {
    category_id,
    title,
    description = null,
    planned_start,
    planned_end,
    status = 'pending',
  } = req.body || {};

  const cid = Number(category_id);
  if (!Number.isInteger(cid) || !categoryExistsStmt.get(cid)) {
    return res.status(400).json({ error: 'invalid_category_id' });
  }
  if (!title || typeof title !== 'string' || !title.trim()) {
    return res.status(400).json({ error: 'title_required' });
  }
  const dateErr = validateDates(planned_start, planned_end);
  if (dateErr) return res.status(400).json({ error: dateErr });
  if (!STATUSES.has(status)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  const newId = db.transaction(() => {
    const info = insertStmt.run(
      cid,
      title.trim(),
      description,
      planned_start,
      planned_end,
      planned_start,
      planned_end,
      status
    );
    return info.lastInsertRowid;
  })();

  const cascade = scheduler.recomputeFromScheduleChange(newId);
  res.status(201).json({
    schedule: withSlack(getStmt.get(newId)),
    cascade,
  });
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const body = req.body || {};
  const newPlannedStart = body.planned_start ?? existing.planned_start;
  const newPlannedEnd = body.planned_end ?? existing.planned_end;
  const plannedChanged =
    newPlannedStart !== existing.planned_start ||
    newPlannedEnd !== existing.planned_end;

  // If planned dates changed and caller didn't override actuals, snap actuals to the new plan.
  // The recompute pass below will then re-apply any cascades downstream.
  const newActualStart =
    body.actual_start ?? (plannedChanged ? newPlannedStart : existing.actual_start);
  const newActualEnd =
    body.actual_end ?? (plannedChanged ? newPlannedEnd : existing.actual_end);

  const newCategoryId = body.category_id ?? existing.category_id;
  const newTitle = body.title ?? existing.title;
  const newDescription = body.description ?? existing.description;
  const newStatus = body.status ?? existing.status;

  const cid = Number(newCategoryId);
  if (!Number.isInteger(cid) || !categoryExistsStmt.get(cid)) {
    return res.status(400).json({ error: 'invalid_category_id' });
  }
  if (!newTitle || typeof newTitle !== 'string' || !newTitle.trim()) {
    return res.status(400).json({ error: 'title_required' });
  }
  const dateErr = validateDates(newPlannedStart, newPlannedEnd);
  if (dateErr) return res.status(400).json({ error: dateErr });
  if (!STATUSES.has(newStatus)) {
    return res.status(400).json({ error: 'invalid_status' });
  }

  db.transaction(() => {
    updateStmt.run(
      cid,
      newTitle.trim(),
      newDescription,
      newPlannedStart,
      newPlannedEnd,
      newActualStart,
      newActualEnd,
      newStatus,
      id
    );
  })();

  const cascade = scheduler.recomputeFromScheduleChange(id);
  res.json({
    schedule: withSlack(getStmt.get(id)),
    cascade,
  });
});

// Collect strong-edge neighbors (other schedules) of a given schedule, both
// via direct schedule endpoints and via category endpoints that resolve to
// the schedule's category. Used pre-DELETE so we can re-cascade the
// surviving neighbors after the row + edges are gone — otherwise the freed
// neighbors keep any stale actual_* the deleted schedule had pulled them to.
function strongNeighborScheduleIds(schedule) {
  if (!schedule) return [];
  const rows = db
    .prepare(
      `SELECT pred_type, pred_id, succ_type, succ_id FROM dependencies
        WHERE link_type = 'strong'
          AND (
               (pred_type = 'schedule' AND pred_id = ?)
            OR (succ_type = 'schedule' AND succ_id = ?)
            OR (pred_type = 'category' AND pred_id = ?)
            OR (succ_type = 'category' AND succ_id = ?)
          )`
    )
    .all(schedule.id, schedule.id, schedule.category_id, schedule.category_id);
  const out = new Set();
  for (const r of rows) {
    if (r.pred_type === 'schedule' && r.pred_id !== schedule.id) {
      out.add(r.pred_id);
    } else if (r.pred_type === 'category') {
      const ids = db
        .prepare(`SELECT id FROM schedules WHERE category_id = ? AND id != ?`)
        .all(r.pred_id, schedule.id)
        .map((x) => x.id);
      for (const id of ids) out.add(id);
    }
    if (r.succ_type === 'schedule' && r.succ_id !== schedule.id) {
      out.add(r.succ_id);
    } else if (r.succ_type === 'category') {
      const ids = db
        .prepare(`SELECT id FROM schedules WHERE category_id = ? AND id != ?`)
        .all(r.succ_id, schedule.id)
        .map((x) => x.id);
      for (const id of ids) out.add(id);
    }
  }
  return [...out];
}

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const neighborIds = strongNeighborScheduleIds(existing);

  // Atomic: edge cleanup, row delete, and neighbor recompute live in one
  // transaction. Otherwise a process kill between delete and recompute would
  // leave neighbors with stale actual_* tied to the deleted schedule.
  db.transaction(() => {
    deleteDepsBySchedule.run(id, id);
    deleteStmt.run(id);
    for (const nid of neighborIds) {
      if (getStmt.get(nid)) scheduler.recomputeFromScheduleChange(nid);
    }
  })();

  res.status(204).end();
});


module.exports = router;
