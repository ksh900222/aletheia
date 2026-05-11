const db = require('../db');

function computeVersion() {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM categories) || '|' || COALESCE((SELECT MAX(created_at) FROM categories), '') AS c,
      (SELECT COUNT(*) FROM schedules)  || '|' || COALESCE((SELECT MAX(updated_at) FROM schedules), '')  AS s,
      (SELECT COUNT(*) FROM dependencies) || '|' || COALESCE((SELECT MAX(created_at) FROM dependencies), '') AS d,
      (SELECT COUNT(*) FROM reports)    || '|' || COALESCE((SELECT MAX(updated_at) FROM reports), '')    AS r,
      (SELECT COUNT(*) FROM report_comments) || '|' || COALESCE((SELECT MAX(created_at) FROM report_comments), '') AS rc,
      (SELECT COUNT(*) FROM sprint_groups WHERE creator = '') || '|' ||
        COALESCE((SELECT MAX(updated_at) FROM sprint_groups WHERE creator = ''), '') AS sg
  `).get();
  return [row.c, row.s, row.d, row.r, row.rc, row.sg].join('::');
}

// Serve only this peer's OWN sprint groups (creator=''), not cached peer rows.
// Each peer is the sole authority for their own groups; relaying cached
// rows would create conflicting sources of truth.
function collectSnapshot() {
  return {
    categories: db.prepare(`SELECT * FROM categories`).all(),
    schedules: db.prepare(`SELECT * FROM schedules`).all(),
    dependencies: db.prepare(`SELECT * FROM dependencies`).all(),
    reports: db.prepare(`SELECT * FROM reports`).all(),
    report_categories: db.prepare(`SELECT * FROM report_categories`).all(),
    report_schedules: db.prepare(`SELECT * FROM report_schedules`).all(),
    attachments: db.prepare(
      `SELECT id, report_id, kind, path, display_name, size_bytes, created_at FROM attachments`
    ).all(),
    report_comments: db.prepare(
      `SELECT id, report_id, author, body, created_at, acknowledged FROM report_comments`
    ).all(),
    sprint_groups: db.prepare(
      `SELECT id, name, created_at, updated_at FROM sprint_groups WHERE creator = ''`
    ).all(),
    sprint_group_members: db.prepare(
      `SELECT group_id, report_id, report_owner,
              snapshot_date, snapshot_body, snapshot_updated_at
         FROM sprint_group_members WHERE group_creator = ''`
    ).all(),
  };
}

module.exports = { computeVersion, collectSnapshot };
