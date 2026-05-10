const db = require('../db');

function computeVersion() {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM categories) || '|' || COALESCE((SELECT MAX(created_at) FROM categories), '') AS c,
      (SELECT COUNT(*) FROM schedules)  || '|' || COALESCE((SELECT MAX(updated_at) FROM schedules), '')  AS s,
      (SELECT COUNT(*) FROM dependencies) || '|' || COALESCE((SELECT MAX(created_at) FROM dependencies), '') AS d,
      (SELECT COUNT(*) FROM reports)    || '|' || COALESCE((SELECT MAX(updated_at) FROM reports), '')    AS r
  `).get();
  return [row.c, row.s, row.d, row.r].join('::');
}

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
      `SELECT id, report_id, author, body, created_at FROM report_comments`
    ).all(),
  };
}

module.exports = { computeVersion, collectSnapshot };
