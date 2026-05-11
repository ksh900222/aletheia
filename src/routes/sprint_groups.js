const express = require('express');
const db = require('../db');
const settings = require('../team/settings');

const router = express.Router();

// Own groups (creator = '') and members access. Replicated peer rows
// (creator = '<peerName>') are written by team/sync.js and read via
// /api/sprint-groups/merged below.

const listOwnGroups = db.prepare(
  `SELECT id, name, created_at, updated_at FROM sprint_groups
    WHERE creator = '' ORDER BY id DESC`
);
const listAllGroups = db.prepare(
  `SELECT creator, id, name, created_at, updated_at FROM sprint_groups
    ORDER BY (creator = '') DESC, creator ASC, id DESC`
);
const listMembersFor = db.prepare(
  `SELECT report_id, report_owner, snapshot_date, snapshot_body, snapshot_updated_at
     FROM sprint_group_members
    WHERE group_creator = ? AND group_id = ?`
);
const nextOwnIdStmt = db.prepare(
  `SELECT COALESCE(MAX(id), 0) + 1 AS next_id FROM sprint_groups WHERE creator = ''`
);
const insertGroupStmt = db.prepare(
  `INSERT INTO sprint_groups (creator, id, name) VALUES ('', ?, ?)`
);
const insertMemberStmt = db.prepare(
  `INSERT OR REPLACE INTO sprint_group_members
     (group_creator, group_id, report_id, report_owner,
      snapshot_date, snapshot_body, snapshot_updated_at)
   VALUES ('', ?, ?, ?, ?, ?, datetime('now'))`
);
const deleteOwnGroupStmt = db.prepare(
  `DELETE FROM sprint_groups WHERE creator = '' AND id = ?`
);
const findOwnByName = db.prepare(
  `SELECT id FROM sprint_groups WHERE creator = '' AND name = ?`
);

// Substitute creator = '' with self.name at read time so the wire format is
// uniform with replicated peer rows. Frontend treats ownGroup === creator
// matching self.name.
function selfName() {
  return (settings.get().self && settings.get().self.name) || '';
}

// Query members using the row's actual stored creator (always '' for own
// rows, peer name for replicated rows); only the returned creator is
// optionally substituted so the frontend sees a uniform owner label.
function decorateGroup(g, creatorOverride) {
  const storedCreator = g.creator !== undefined ? g.creator : '';
  const members = listMembersFor.all(storedCreator, g.id);
  return {
    creator: creatorOverride !== undefined ? creatorOverride : storedCreator,
    id: g.id,
    name: g.name,
    created_at: g.created_at,
    updated_at: g.updated_at,
    member_count: members.length,
    members,
  };
}

// GET /api/sprint-groups → own + replicated peer groups (merged).
// Each row has `creator` set: '' substituted with self.name for own rows.
router.get('/', (req, res) => {
  const me = selfName();
  const rows = listAllGroups.all();
  res.json(rows.map((g) => decorateGroup(g, g.creator === '' ? me : g.creator)));
});

// GET /api/sprint-groups/own → only own groups
router.get('/own', (req, res) => {
  const rows = listOwnGroups.all();
  res.json(rows.map((g) => decorateGroup({ ...g, creator: '' }, selfName())));
});

// POST /api/sprint-groups
// body: { name, members: [{report_id, owner?, snapshot_date, snapshot_body}] }
// 409 on duplicate own name.
router.post('/', (req, res) => {
  const { name, members } = req.body || {};
  const trimmedName = typeof name === 'string' ? name.trim() : '';
  if (!trimmedName) return res.status(400).json({ error: 'name_required' });
  if (trimmedName.length > 200) return res.status(400).json({ error: 'name_too_long' });
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members_required' });
  }

  if (findOwnByName.get(trimmedName)) {
    return res.status(409).json({ error: 'name_exists' });
  }

  const norm = [];
  for (const m of members) {
    const rid = Number(m && m.report_id);
    if (!Number.isInteger(rid)) {
      return res.status(400).json({ error: 'member_invalid', detail: m });
    }
    norm.push({
      report_id: rid,
      report_owner: typeof m.owner === 'string' ? m.owner : '',
      snapshot_date: typeof m.snapshot_date === 'string' ? m.snapshot_date : '',
      snapshot_body: typeof m.snapshot_body === 'string' ? m.snapshot_body : '',
    });
  }

  try {
    const created = db.transaction(() => {
      const nextId = nextOwnIdStmt.get().next_id;
      insertGroupStmt.run(nextId, trimmedName);
      for (const m of norm) {
        insertMemberStmt.run(
          nextId, m.report_id, m.report_owner, m.snapshot_date, m.snapshot_body
        );
      }
      return nextId;
    })();
    const row = db.prepare(
      `SELECT id, name, created_at, updated_at FROM sprint_groups
        WHERE creator = '' AND id = ?`
    ).get(created);
    res.status(201).json(decorateGroup({ ...row, creator: '' }, selfName()));
  } catch (e) {
    if (e && /UNIQUE constraint failed/.test(e.message)) {
      return res.status(409).json({ error: 'name_exists' });
    }
    throw e;
  }
});

// POST /api/sprint-groups/:id/remove-members
// body: { members: [{report_id, owner?}] }
// 본인 그룹에서 일부 멤버만 제거. 그룹 자체는 유지. updated_at 을 bump 해
// 다음 sync 에 peer 들에게 변경 전파.
router.post('/:id/remove-members', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const { members } = req.body || {};
  if (!Array.isArray(members) || members.length === 0) {
    return res.status(400).json({ error: 'members_required' });
  }
  const exists = db.prepare(
    `SELECT 1 FROM sprint_groups WHERE creator = '' AND id = ?`
  ).get(id);
  if (!exists) return res.status(404).json({ error: 'not_found' });

  const delStmt = db.prepare(
    `DELETE FROM sprint_group_members
      WHERE group_creator = '' AND group_id = ? AND report_owner = ? AND report_id = ?`
  );
  const bumpStmt = db.prepare(
    `UPDATE sprint_groups SET updated_at = datetime('now') WHERE creator = '' AND id = ?`
  );
  const tx = db.transaction(() => {
    let removed = 0;
    for (const m of members) {
      const rid = Number(m && m.report_id);
      if (!Number.isInteger(rid)) continue;
      const owner = typeof m.owner === 'string' ? m.owner : '';
      removed += delStmt.run(id, owner, rid).changes;
    }
    if (removed > 0) bumpStmt.run(id);
    return removed;
  });
  res.json({ removed: tx() });
});

// DELETE /api/sprint-groups/:id — only own groups. Peer-created groups can
// be removed solely by the creator on their machine; the next sync round
// then propagates the removal to everyone else.
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const info = deleteOwnGroupStmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

module.exports = router;
