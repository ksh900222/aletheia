const express = require('express');
const db = require('../db');
const scheduler = require('../engine/scheduler');

const router = express.Router();

const listStmt = db.prepare(`SELECT * FROM categories ORDER BY id ASC`);
const getStmt = db.prepare(`SELECT * FROM categories WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO categories (name, description, color, hide_from_all_gantt) VALUES (?, ?, ?, ?)`
);
const updateStmt = db.prepare(
  `UPDATE categories SET name = ?, description = ?, color = ?, hide_from_all_gantt = ? WHERE id = ?`
);
const deleteStmt = db.prepare(`DELETE FROM categories WHERE id = ?`);
const deleteDepsByCategory = db.prepare(
  `DELETE FROM dependencies
     WHERE (pred_type = 'category' AND pred_id = ?)
        OR (succ_type = 'category' AND succ_id = ?)
        OR (pred_type = 'schedule' AND pred_id IN (SELECT id FROM schedules WHERE category_id = ?))
        OR (succ_type = 'schedule' AND succ_id IN (SELECT id FROM schedules WHERE category_id = ?))`
);

router.get('/', (req, res) => {
  res.json(listStmt.all());
});

router.get('/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

router.post('/', (req, res) => {
  const {
    name,
    description = null,
    color = null,
    hide_from_all_gantt = 0,
  } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name_required' });
  }
  try {
    const info = insertStmt.run(
      name.trim(), description, color,
      hide_from_all_gantt ? 1 : 0,
    );
    res.status(201).json(getStmt.get(info.lastInsertRowid));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'name_exists' });
    }
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const {
    name = existing.name,
    description = existing.description,
    color = existing.color,
    hide_from_all_gantt = existing.hide_from_all_gantt,
  } = req.body || {};
  if (!name || typeof name !== 'string' || !name.trim()) {
    return res.status(400).json({ error: 'name_required' });
  }
  try {
    updateStmt.run(
      name.trim(), description, color,
      hide_from_all_gantt ? 1 : 0,
      id,
    );
    res.json(getStmt.get(id));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'name_exists' });
    }
    throw e;
  }
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  // Atomic: collect external neighbors, drop the polymorphic deps that touch
  // this category, delete the row, then recompute every external neighbor —
  // all inside one transaction so a partial result can't escape.
  const found = db.transaction(() => {
    // Schedules in OTHER categories tied via strong edges to this category,
    // either via category endpoint or via direct schedule endpoint to one of
    // its members. Without this re-cascade those external neighbors keep any
    // actual_* this category had pulled them to as orphaned drift.
    const externalNeighbors = db
      .prepare(
        `SELECT DISTINCT s.id AS id
           FROM schedules s
          WHERE s.category_id != ?
            AND s.id IN (
              SELECT pred_id FROM dependencies
                WHERE pred_type='schedule' AND link_type='strong'
                  AND ((succ_type='category' AND succ_id=?)
                    OR (succ_type='schedule' AND succ_id IN (SELECT id FROM schedules WHERE category_id=?)))
              UNION
              SELECT succ_id FROM dependencies
                WHERE succ_type='schedule' AND link_type='strong'
                  AND ((pred_type='category' AND pred_id=?)
                    OR (pred_type='schedule' AND pred_id IN (SELECT id FROM schedules WHERE category_id=?)))
            )`
      )
      .all(id, id, id, id, id)
      .map((r) => r.id);

    deleteDepsByCategory.run(id, id, id, id);
    const info = deleteStmt.run(id);
    if (info.changes === 0) return false;
    for (const nid of externalNeighbors) {
      if (db.prepare('SELECT 1 FROM schedules WHERE id = ?').get(nid)) {
        scheduler.recomputeFromScheduleChange(nid);
      }
    }
    return true;
  })();
  if (!found) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
