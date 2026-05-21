const db = require('../db');

function computeVersion() {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM categories) || '|' || COALESCE((SELECT MAX(updated_at) FROM categories), '') AS c,
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
//
// reports.exclude_from_team = 1 인 리포트는 본인에게만 보이고 peer 에게는
// 노출하지 않는다. 해당 리포트와 함께 report_categories / report_schedules /
// attachments / report_comments / sprint_group_members 도 함께 제외하여
// 일관성을 유지한다. (sprint group 의 멤버 행은 PUT /api/reports/:id 에서
// exclude=1 로 토글될 때 이미 삭제되지만, 동기화 타이밍 차이를 막기 위해
// snapshot 시점에서도 한 번 더 필터링.)
function collectSnapshot() {
  const reports = db.prepare(`SELECT * FROM reports`).all();
  const sharedReports = reports.filter((r) => !r.exclude_from_team);
  const excludedIds = new Set(
    reports.filter((r) => r.exclude_from_team).map((r) => r.id)
  );
  const filterByReportId = (rows) =>
    rows.filter((r) => !excludedIds.has(r.report_id));

  return {
    categories: db.prepare(`SELECT * FROM categories`).all(),
    schedules: db.prepare(`SELECT * FROM schedules`).all(),
    dependencies: db.prepare(`SELECT * FROM dependencies`).all(),
    reports: sharedReports,
    report_categories: filterByReportId(
      db.prepare(`SELECT * FROM report_categories`).all()
    ),
    report_schedules: filterByReportId(
      db.prepare(`SELECT * FROM report_schedules`).all()
    ),
    attachments: filterByReportId(
      db.prepare(
        `SELECT id, report_id, kind, path, display_name, size_bytes, created_at FROM attachments`
      ).all()
    ),
    report_comments: filterByReportId(
      db.prepare(
        `SELECT id, report_id, author, body, created_at, acknowledged FROM report_comments`
      ).all()
    ),
    sprint_groups: db.prepare(
      `SELECT id, name, created_at, updated_at FROM sprint_groups WHERE creator = ''`
    ).all(),
    sprint_group_members: db.prepare(
      `SELECT group_id, report_id, report_owner,
              snapshot_date, snapshot_body, snapshot_updated_at
         FROM sprint_group_members WHERE group_creator = ''`
    ).all().filter((m) =>
      // own group 의 own report 멤버만 필터링. 다른 peer 의 리포트(report_owner
      // 비어있지 않음) 멤버는 그대로 두되, 본인 own 리포트가 excluded 면 제거.
      !(m.report_owner === '' && excludedIds.has(m.report_id))
    ),
  };
}

module.exports = { computeVersion, collectSnapshot };
