const express = require('express');
const db = require('../db');
const scheduler = require('../engine/scheduler');
const { wouldCreateCycle, entityExists, entityLabel } = scheduler;

const router = express.Router();

// For a dependency endpoint, return one schedule id we can hand to
// recomputeFromScheduleChange — that function does a strong-component reset
// which covers everything reachable, so any one schedule in the component
// will do. For category endpoints, pick any member schedule.
function endpointScheduleId(type, id) {
  if (type === 'schedule') return id;
  if (type === 'category') {
    const r = db
      .prepare(`SELECT id FROM schedules WHERE category_id = ? ORDER BY id ASC LIMIT 1`)
      .get(id);
    return r ? r.id : null;
  }
  return null;
}

// Recompute components touching the given dependency endpoints. Pred and
// succ may resolve to the same component or to different ones; calling
// recomputeFromScheduleChange on each distinct schedule covers both.
function recomputeForEndpoints(endpoints) {
  const seenSchedules = new Set();
  for (const { type, id } of endpoints) {
    const sid = endpointScheduleId(type, id);
    if (sid !== null && !seenSchedules.has(sid)) {
      seenSchedules.add(sid);
      scheduler.recomputeFromScheduleChange(sid);
    }
  }
}

// H-12: 카테고리 의존성 disable (사용자 결정). 신규 생성/편집은 schedule
// 끼리만 허용. 기존 DB 의 category 타입 row 는 GET 으로는 조회 가능하지만
// 변경/추가 경로에서는 거부됨. 재활성화 시 'category' 추가만 하면 됨.
const ENTITY_TYPES = new Set(['schedule' /*, 'category'*/]);
const LINK_TYPES = new Set(['strong', 'weak']);
const ON_DELAY = new Set(['auto_shift', 'warn_only']);

const listStmt = db.prepare(`SELECT * FROM dependencies ORDER BY id ASC`);
const getStmt = db.prepare(`SELECT * FROM dependencies WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO dependencies
     (pred_type, pred_id, succ_type, succ_id, link_type, on_delay)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const updateStmt = db.prepare(
  `UPDATE dependencies
     SET pred_type = ?, pred_id = ?, succ_type = ?, succ_id = ?,
         link_type = ?, on_delay = ?
   WHERE id = ?`
);
const deleteStmt = db.prepare(`DELETE FROM dependencies WHERE id = ?`);

function validateDependencyPayload(payload, edgeIdForCycleExclude = null) {
  const {
    pred_type,
    pred_id,
    succ_type,
    succ_id,
    link_type,
    on_delay,
  } = payload;

  if (!ENTITY_TYPES.has(pred_type) || !ENTITY_TYPES.has(succ_type)) {
    return { error: 'invalid_entity_type' };
  }
  if (!LINK_TYPES.has(link_type)) {
    return { error: 'invalid_link_type' };
  }
  if (!ON_DELAY.has(on_delay)) {
    return { error: 'invalid_on_delay' };
  }
  const pid = Number(pred_id);
  const sid = Number(succ_id);
  if (!Number.isInteger(pid) || !Number.isInteger(sid)) {
    return { error: 'invalid_id' };
  }
  if (!entityExists(pred_type, pid)) {
    return { error: 'pred_not_found' };
  }
  if (!entityExists(succ_type, sid)) {
    return { error: 'succ_not_found' };
  }
  if (pred_type === succ_type && pid === sid) {
    return { error: 'self_loop' };
  }
  if (pred_type === 'schedule' && succ_type === 'category') {
    const s = db
      .prepare(`SELECT category_id FROM schedules WHERE id = ?`)
      .get(pid);
    if (s && s.category_id === sid) {
      return { error: 'container_cycle' };
    }
  }
  if (pred_type === 'category' && succ_type === 'schedule') {
    const s = db
      .prepare(`SELECT category_id FROM schedules WHERE id = ?`)
      .get(sid);
    if (s && s.category_id === pid) {
      return { error: 'container_cycle' };
    }
  }
  if (wouldCreateCycle(pred_type, pid, succ_type, sid, edgeIdForCycleExclude)) {
    return { error: 'cycle_detected' };
  }
  return { ok: true, pid, sid };
}

// Decorate a dependency row with human-readable labels.
function decorate(row) {
  return {
    ...row,
    pred_label: entityLabel(row.pred_type, row.pred_id),
    succ_label: entityLabel(row.succ_type, row.succ_id),
  };
}

router.get('/', (req, res) => {
  const rows = listStmt.all().map(decorate);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(decorate(row));
});

router.post('/', (req, res) => {
  const body = req.body || {};
  const payload = {
    pred_type: body.pred_type,
    pred_id: body.pred_id,
    succ_type: body.succ_type,
    succ_id: body.succ_id,
    link_type: body.link_type,
    on_delay: body.on_delay ?? 'auto_shift',
  };
  const v = validateDependencyPayload(payload);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    // Wrap insert + cascade in one transaction so a mid-flight failure
    // never leaves the edge persisted with stale actual_* downstream.
    // Nested transactions inside recompute use SAVEPOINTs automatically.
    const newId = db.transaction(() => {
      const info = insertStmt.run(
        payload.pred_type,
        v.pid,
        payload.succ_type,
        v.sid,
        payload.link_type,
        payload.on_delay
      );
      recomputeForEndpoints([
        { type: payload.pred_type, id: v.pid },
        { type: payload.succ_type, id: v.sid },
      ]);
      return info.lastInsertRowid;
    })();
    res.status(201).json(decorate(getStmt.get(newId)));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'duplicate' });
    }
    throw e;
  }
});

// "현재"를 앵커로 한 폼이 보내는 1~2개 엣지를 한 트랜잭션으로 처리.
//   POST /api/dependencies/triple
//   {
//     current: { type, id },
//     pred:    { type, id } | null,    // 있으면 pred → current 생성
//     succ:    { type, id } | null,    // 있으면 current → succ 생성
//     link_type, on_delay              // 두 엣지에 공통 적용 (v1)
//   }
// 둘 중 하나라도 검증 실패 / DB 제약 위반이면 둘 다 롤백.
router.post('/triple', (req, res) => {
  const body = req.body || {};
  const cur = body.current || {};
  const pred = body.pred || null;
  const succ = body.succ || null;
  const link_type = body.link_type;
  const on_delay = body.on_delay ?? 'auto_shift';

  if (!ENTITY_TYPES.has(cur.type) || !Number.isInteger(Number(cur.id))) {
    return res.status(400).json({ error: 'invalid_current' });
  }
  if (!entityExists(cur.type, Number(cur.id))) {
    return res.status(400).json({ error: 'current_not_found' });
  }
  const hasPred =
    pred && ENTITY_TYPES.has(pred.type) && Number.isInteger(Number(pred.id));
  const hasSucc =
    succ && ENTITY_TYPES.has(succ.type) && Number.isInteger(Number(succ.id));
  if (!hasPred && !hasSucc) {
    return res.status(400).json({ error: 'no_edge' });
  }
  if (!LINK_TYPES.has(link_type)) {
    return res.status(400).json({ error: 'invalid_link_type' });
  }
  if (!ON_DELAY.has(on_delay)) {
    return res.status(400).json({ error: 'invalid_on_delay' });
  }

  const payloads = [];
  if (hasPred) {
    payloads.push({
      side: 'pred',
      pred_type: pred.type,
      pred_id: Number(pred.id),
      succ_type: cur.type,
      succ_id: Number(cur.id),
      link_type,
      on_delay,
    });
  }
  if (hasSucc) {
    payloads.push({
      side: 'succ',
      pred_type: cur.type,
      pred_id: Number(cur.id),
      succ_type: succ.type,
      succ_id: Number(succ.id),
      link_type,
      on_delay,
    });
  }

  try {
    const created = db.transaction(() => {
      const out = [];
      for (const p of payloads) {
        // Validate against current DB state (which already includes any rows
        // inserted earlier in THIS transaction — so the second edge's cycle
        // check sees the first edge's effect).
        const v = validateDependencyPayload(p);
        if (v.error) {
          const err = new Error('validation');
          err.errorCode = v.error;
          err.side = p.side;
          throw err;
        }
        const info = insertStmt.run(
          p.pred_type,
          v.pid,
          p.succ_type,
          v.sid,
          p.link_type,
          p.on_delay
        );
        out.push(decorate(getStmt.get(info.lastInsertRowid)));
      }
      // Cascade inside the same transaction so a partial recompute leaves
      // nothing committed.
      const endpoints = [];
      for (const c of out) {
        endpoints.push({ type: c.pred_type, id: c.pred_id });
        endpoints.push({ type: c.succ_type, id: c.succ_id });
      }
      recomputeForEndpoints(endpoints);
      return out;
    })();
    res.status(201).json({ created });
  } catch (e) {
    if (e.errorCode) {
      return res.status(400).json({ error: e.errorCode, side: e.side });
    }
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'duplicate' });
    }
    throw e;
  }
});

router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });

  const body = req.body || {};
  const payload = {
    pred_type: body.pred_type ?? existing.pred_type,
    pred_id: body.pred_id ?? existing.pred_id,
    succ_type: body.succ_type ?? existing.succ_type,
    succ_id: body.succ_id ?? existing.succ_id,
    link_type: body.link_type ?? existing.link_type,
    on_delay: body.on_delay ?? existing.on_delay,
  };
  const v = validateDependencyPayload(payload, id);
  if (v.error) return res.status(400).json({ error: v.error });

  try {
    db.transaction(() => {
      updateStmt.run(
        payload.pred_type,
        v.pid,
        payload.succ_type,
        v.sid,
        payload.link_type,
        payload.on_delay,
        id
      );
      // Recompute components on both sides of BOTH the old and new edges so
      // any state we cleared by re-pointing/re-typing the edge gets settled.
      recomputeForEndpoints([
        { type: existing.pred_type, id: existing.pred_id },
        { type: existing.succ_type, id: existing.succ_id },
        { type: payload.pred_type, id: v.pid },
        { type: payload.succ_type, id: v.sid },
      ]);
    })();
    res.json(decorate(getStmt.get(id)));
  } catch (e) {
    if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'duplicate' });
    }
    throw e;
  }
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = getStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  // Atomically: delete the edge, then recompute both endpoints. After deletion
  // the two endpoints may now be in separate components — recompute each.
  const changes = db.transaction(() => {
    const info = deleteStmt.run(id);
    if (info.changes === 0) return 0;
    recomputeForEndpoints([
      { type: existing.pred_type, id: existing.pred_id },
      { type: existing.succ_type, id: existing.succ_id },
    ]);
    return info.changes;
  })();
  if (changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
