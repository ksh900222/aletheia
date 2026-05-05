// Dependency engine.
//
// Concepts:
//   - Entities are polymorphic: type ∈ { 'schedule', 'category' } + id.
//   - Strong edge pred → succ (SS / Start-to-Start semantics):
//       succ.actual_start must be ≥ pred.actual_start.
//     Same start day is allowed; partial overlap is allowed; what is NOT
//     allowed is succ starting BEFORE pred. When violated, cascade pulls
//     pred earlier (auto_shift) or raises a conflict (warn_only).
//   - Weak edge A ↔ B (modeled as a single row): does NOT cascade. Used for slack display:
//       slack_days(X) = max(0, max(actual_end of weak siblings) − X.actual_end)
//   - Category as endpoint:
//       end(category)   = MAX(actual_end)   of its schedules
//       start(category) = MIN(actual_start) of its schedules
//       shifting a category = shifting every schedule in it by the same delta.

const db = require('../db');

const DAY_MS = 86400000;

function parseDate(s) {
  return s ? new Date(`${s}T00:00:00Z`) : null;
}
function toISO(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(iso, days) {
  const d = parseDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toISO(d);
}
function diffDays(fromIso, toIso) {
  return Math.round(
    (parseDate(toIso).getTime() - parseDate(fromIso).getTime()) / DAY_MS
  );
}

// ----- entity lookups -----
function getSchedule(id) {
  return db.prepare(`SELECT * FROM schedules WHERE id = ?`).get(id);
}
function getCategory(id) {
  return db.prepare(`SELECT * FROM categories WHERE id = ?`).get(id);
}
function entityExists(type, id) {
  if (type === 'schedule') return !!getSchedule(id);
  if (type === 'category') return !!getCategory(id);
  return false;
}
function entityLabel(type, id) {
  if (type === 'schedule') {
    const s = getSchedule(id);
    return s ? `[S] ${s.title}` : `[S#${id} (deleted)]`;
  }
  const c = getCategory(id);
  return c ? `[C] ${c.name}` : `[C#${id} (deleted)]`;
}

function entityEnd(type, id) {
  if (type === 'schedule') {
    const r = getSchedule(id);
    return r ? r.actual_end : null;
  }
  const r = db
    .prepare(`SELECT MAX(actual_end) AS v FROM schedules WHERE category_id = ?`)
    .get(id);
  return r?.v ?? null;
}
function entityStart(type, id) {
  if (type === 'schedule') {
    const r = getSchedule(id);
    return r ? r.actual_start : null;
  }
  const r = db
    .prepare(
      `SELECT MIN(actual_start) AS v FROM schedules WHERE category_id = ?`
    )
    .get(id);
  return r?.v ?? null;
}

// Resolve an entity reference to the set of schedule ids it covers.
function expandToScheduleIds(type, id) {
  if (type === 'schedule') return [id];
  return db
    .prepare(`SELECT id FROM schedules WHERE category_id = ?`)
    .all(id)
    .map((r) => r.id);
}

// ----- cycle detection (only over strong edges; weak edges are non-directional) -----
// excludeEdgeId: when editing an existing dependency, treat the row being edited as
//                already removed so we don't false-positive on its old endpoints.
function wouldCreateCycle(predType, predId, succType, succId, excludeEdgeId = null) {
  if (predType === succType && predId === succId) return true;
  // Walk forward from succ via outbound STRONG edges; if we reach pred, it's a cycle.
  const visited = new Set();
  const stack = [{ type: succType, id: succId }];
  while (stack.length) {
    const n = stack.pop();
    const key = `${n.type}:${n.id}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (n.type === predType && n.id === predId) return true;
    let sql =
      `SELECT succ_type, succ_id FROM dependencies
       WHERE pred_type = ? AND pred_id = ? AND link_type = 'strong'`;
    const params = [n.type, n.id];
    if (excludeEdgeId !== null) {
      sql += ' AND id != ?';
      params.push(excludeEdgeId);
    }
    const out = db.prepare(sql).all(...params);
    for (const e of out) stack.push({ type: e.succ_type, id: e.succ_id });
  }
  return false;
}

// ----- predecessors / successors lookup -----
function strongPredecessorsOf(type, id) {
  return db
    .prepare(
      `SELECT pred_type, pred_id, on_delay
         FROM dependencies
        WHERE link_type = 'strong' AND succ_type = ? AND succ_id = ?`
    )
    .all(type, id);
}
function strongSuccessorsOf(type, id) {
  return db
    .prepare(
      `SELECT succ_type, succ_id, on_delay
         FROM dependencies
        WHERE link_type = 'strong' AND pred_type = ? AND pred_id = ?`
    )
    .all(type, id);
}

// Required minimum start for an entity given its strong predecessors.
// SS semantics: succ.start ≥ MAX(pred.start) over all strong preds.
function requiredMinStart(type, id) {
  const preds = strongPredecessorsOf(type, id);
  let bestStart = null;
  for (const p of preds) {
    const ps = entityStart(p.pred_type, p.pred_id);
    if (ps && (!bestStart || ps > bestStart)) bestStart = ps;
  }
  return bestStart;
}

// Shift a single schedule by N days (preserve duration).
function shiftScheduleBy(scheduleId, deltaDays) {
  const s = getSchedule(scheduleId);
  if (!s || !s.actual_start || !s.actual_end) return;
  const newStart = addDays(s.actual_start, deltaDays);
  const newEnd = addDays(s.actual_end, deltaDays);
  db.prepare(
    `UPDATE schedules
        SET actual_start = ?, actual_end = ?, updated_at = datetime('now')
      WHERE id = ?`
  ).run(newStart, newEnd, scheduleId);
}

// Backward BFS pass: starting from initial nodes, walk INTO each node and
// pull binding preds earlier so pred.start == node.start (SS). Each pulled
// pred is enqueued so its own preds are checked transitively.
//
// SS rule: succ.start ≥ pred.start. A pred is "binding" when pred.start
// is currently > succ.start (i.e. succ has already moved earlier than pred).
// Pulling sets pred.start = succ.start.
function backwardPass(initial, result) {
  const visited = new Set();
  const queue = [...initial];
  while (queue.length) {
    const node = queue.shift();
    const key = `${node.type}:${node.id}`;
    if (visited.has(key)) continue;
    visited.add(key);

    // The "required" here is what *this* node demands of its preds:
    // every pred must start ≤ node.start. We don't use requiredMinStart
    // (that's for forward); we look at each pred's own start vs current.
    const current = entityStart(node.type, node.id);
    if (!current) continue;

    const preds = strongPredecessorsOf(node.type, node.id);
    for (const p of preds) {
      const pStart = entityStart(p.pred_type, p.pred_id);
      if (!pStart) continue;
      if (pStart <= current) continue; // not binding — pred already starts ≤ succ

      if (p.on_delay === 'auto_shift') {
        const delta = diffDays(pStart, current); // negative
        const ids = expandToScheduleIds(p.pred_type, p.pred_id);
        for (const sid of ids) shiftScheduleBy(sid, delta);
        const newStart = entityStart(p.pred_type, p.pred_id);
        const newEnd = entityEnd(p.pred_type, p.pred_id);
        result.shifted.push({
          type: p.pred_type,
          id: p.pred_id,
          label: entityLabel(p.pred_type, p.pred_id),
          delta_days: delta,
          new_start: newStart,
          new_end: newEnd,
        });
        queue.push({ type: p.pred_type, id: p.pred_id });
        if (p.pred_type === 'schedule') {
          const ps = getSchedule(p.pred_id);
          if (ps) queue.push({ type: 'category', id: ps.category_id });
        }
      } else {
        result.conflicts.push({
          type: node.type,
          id: node.id,
          label: entityLabel(node.type, node.id),
          current_start: current,
          required_min_start: current,
          predecessor_label: entityLabel(p.pred_type, p.pred_id),
        });
      }
    }
  }
}

// Forward BFS pass: from initial nodes, walk OUT and push binding succs later
// so succ.start == MAX(pred.start) (SS). Each pushed succ is enqueued.
function forwardPass(initial, result) {
  const visited = new Set();
  const queue = [...initial];
  while (queue.length) {
    const node = queue.shift();
    const key = `${node.type}:${node.id}`;
    if (visited.has(key)) continue;
    visited.add(key);

    const successors = strongSuccessorsOf(node.type, node.id);
    for (const s of successors) {
      const succType = s.succ_type;
      const succId = s.succ_id;
      const required = requiredMinStart(succType, succId);
      if (!required) continue;
      const current = entityStart(succType, succId);
      if (!current) continue;
      if (required <= current) continue;

      const delta = diffDays(current, required);
      if (s.on_delay === 'auto_shift') {
        const ids = expandToScheduleIds(succType, succId);
        for (const sid of ids) shiftScheduleBy(sid, delta);
        const newStart = entityStart(succType, succId);
        const newEnd = entityEnd(succType, succId);
        result.shifted.push({
          type: succType,
          id: succId,
          label: entityLabel(succType, succId),
          delta_days: delta,
          new_start: newStart,
          new_end: newEnd,
        });
        queue.push({ type: succType, id: succId });
        if (succType === 'schedule') {
          const sc = getSchedule(succId);
          if (sc) queue.push({ type: 'category', id: sc.category_id });
        }
      } else {
        result.conflicts.push({
          type: succType,
          id: succId,
          label: entityLabel(succType, succId),
          current_start: current,
          required_min_start: required,
          predecessor_label: entityLabel(node.type, node.id),
        });
      }
    }
  }
}

// Walk the strong-edge graph (both directions) from a starting schedule and
// collect every schedule id reachable. This is the "connected strong
// component" of the schedule. Category-endpoint edges are expanded into
// their member schedules so the component is purely schedule-centric.
function collectStrongComponentSchedules(startScheduleId) {
  const visited = new Set([startScheduleId]);
  const queue = [startScheduleId];
  while (queue.length) {
    const sid = queue.shift();
    const s = getSchedule(sid);
    if (!s) continue;
    // Out-edges where this schedule is pred (directly or via its category).
    const outEdges = db
      .prepare(
        `SELECT succ_type, succ_id FROM dependencies
          WHERE link_type = 'strong'
            AND ((pred_type = 'schedule' AND pred_id = ?)
              OR (pred_type = 'category' AND pred_id = ?))`
      )
      .all(sid, s.category_id);
    // In-edges where this schedule is succ.
    const inEdges = db
      .prepare(
        `SELECT pred_type, pred_id FROM dependencies
          WHERE link_type = 'strong'
            AND ((succ_type = 'schedule' AND succ_id = ?)
              OR (succ_type = 'category' AND succ_id = ?))`
      )
      .all(sid, s.category_id);
    const neighbors = [];
    for (const e of outEdges) {
      for (const n of expandToScheduleIds(e.succ_type, e.succ_id)) {
        neighbors.push(n);
      }
    }
    for (const e of inEdges) {
      for (const n of expandToScheduleIds(e.pred_type, e.pred_id)) {
        neighbors.push(n);
      }
    }
    for (const n of neighbors) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return [...visited];
}

// Recompute cascade triggered by a single schedule change.
//
// Strategy (solution Z):
//   1) Snap actual = planned for every schedule in the strong-connected
//      component of the changed schedule. This wipes any stale cascade state
//      from prior moves so legitimate "moved-back" cases stop showing orange.
//   2) Run backward + forward passes rooted at the changed entity to
//      re-derive cascade for the current planned positions.
//
// Schedules outside this component are untouched.
function recomputeFromScheduleChange(changedScheduleId) {
  const result = { shifted: [], conflicts: [] };
  const sched = getSchedule(changedScheduleId);
  if (!sched) return result;

  db.transaction(() => {
    const componentIds = collectStrongComponentSchedules(changedScheduleId);
    if (componentIds.length) {
      const placeholders = componentIds.map(() => '?').join(',');
      db.prepare(
        `UPDATE schedules
            SET actual_start = planned_start,
                actual_end   = planned_end,
                updated_at   = datetime('now')
          WHERE id IN (${placeholders})`
      ).run(...componentIds);
    }
  })();

  const initial = [
    { type: 'schedule', id: changedScheduleId },
    { type: 'category', id: sched.category_id },
  ];
  backwardPass(initial, result);
  forwardPass(initial, result);
  return result;
}

// Slack for a given schedule via weak edges (schedule ↔ schedule only for now).
function slackDaysFor(scheduleId) {
  const me = getSchedule(scheduleId);
  if (!me || !me.actual_end) return 0;
  const row = db
    .prepare(
      `SELECT MAX(s2.actual_end) AS v
         FROM schedules s2
        WHERE s2.id IN (
          SELECT CASE WHEN d.pred_id = ? THEN d.succ_id ELSE d.pred_id END
            FROM dependencies d
           WHERE d.link_type = 'weak'
             AND d.pred_type = 'schedule' AND d.succ_type = 'schedule'
             AND (d.pred_id = ? OR d.succ_id = ?)
        )`
    )
    .get(scheduleId, scheduleId, scheduleId);
  if (!row?.v) return 0;
  if (row.v <= me.actual_end) return 0;
  return diffDays(me.actual_end, row.v);
}

// Full recompute (계획 갱신): snap all schedules' actual_* to planned_*, then
// re-apply every dependency. To honor user-planned dates as much as possible,
// we run BACKWARD across every schedule first (pull preds back so their
// successors can stay at planned), then FORWARD (push succs forward to fix any
// remaining unresolved conflicts, e.g. warn_only edges or chains we couldn't
// fully pull). This avoids the order-dependency where a forward push would
// pre-empt a later backward pull.
function recomputeAll() {
  const shiftedMap = new Map();    // key = `${type}:${id}` → last shift entry
  const conflictMap = new Map();   // key = `${type}:${id}|${predLabel}` → conflict entry
  const result = { shifted: [], conflicts: [] };

  db.transaction(() => {
    db.prepare(
      `UPDATE schedules
          SET actual_start = planned_start,
              actual_end   = planned_end,
              updated_at   = datetime('now')`
    ).run();

    const ids = db
      .prepare(`SELECT id FROM schedules ORDER BY planned_start ASC, id ASC`)
      .all()
      .map((r) => r.id);

    // Pass 1: all backward (pull binding preds for each schedule's planned position).
    for (const id of ids) {
      const sched = getSchedule(id);
      if (!sched) continue;
      backwardPass(
        [
          { type: 'schedule', id },
          { type: 'category', id: sched.category_id },
        ],
        result
      );
    }

    // Pass 2: all forward (resolve any remaining violations by pushing succs).
    for (const id of ids) {
      const sched = getSchedule(id);
      if (!sched) continue;
      forwardPass(
        [
          { type: 'schedule', id },
          { type: 'category', id: sched.category_id },
        ],
        result
      );
    }
  })();

  // Dedupe: keep the most recent shift entry per entity, dedupe conflicts by node+pred.
  for (const sh of result.shifted) shiftedMap.set(`${sh.type}:${sh.id}`, sh);
  for (const cf of result.conflicts)
    conflictMap.set(`${cf.type}:${cf.id}|${cf.predecessor_label}`, cf);

  return {
    shifted: Array.from(shiftedMap.values()),
    conflicts: Array.from(conflictMap.values()),
  };
}

module.exports = {
  recomputeFromScheduleChange,
  recomputeAll,
  slackDaysFor,
  wouldCreateCycle,
  entityExists,
  entityLabel,
};
