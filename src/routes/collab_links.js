const express = require('express');
const db = require('../db');

const router = express.Router();

// 공동작업 링크 — Teams 채팅 등에서 공유된 링크를 설명과 함께 보관.
// 응답의 hidden 은 0/1 정수, category_name 은 categories JOIN 결과 (없으면 null).

const URL_MAX = 4096;
const TITLE_MAX = 200;
const DESC_MAX = 5000;
const TAG_MAX = 100;

const SELECT_COLS = `
  SELECT l.id, l.url, l.title, l.description, l.category_id, l.tag, l.hidden,
         l.created_at, l.updated_at, c.name AS category_name, c.color AS category_color
    FROM collab_links l
    LEFT JOIN categories c ON c.id = l.category_id`;

const listStmt = db.prepare(`${SELECT_COLS} ORDER BY l.created_at DESC, l.id DESC`);
const getStmt = db.prepare(`${SELECT_COLS} WHERE l.id = ?`);
const categoryExists = db.prepare(`SELECT 1 FROM categories WHERE id = ?`);
const insertStmt = db.prepare(
  `INSERT INTO collab_links (url, title, description, category_id, tag, hidden, updated_at)
   VALUES (?, ?, ?, ?, ?, 0, datetime('now'))`
);
const updateStmt = db.prepare(
  `UPDATE collab_links
      SET url = ?, title = ?, description = ?, category_id = ?, tag = ?, hidden = ?,
          updated_at = datetime('now')
    WHERE id = ?`
);
const deleteStmt = db.prepare(`DELETE FROM collab_links WHERE id = ?`);
const versionStmt = db.prepare(
  `SELECT COUNT(*) || '|' || COALESCE(MAX(updated_at), '') AS v FROM collab_links`
);

// http(s) 만 허용 — javascript:/data: 같은 스킴이 href 로 렌더되는 것을 막는다.
function normalizeUrl(raw) {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (!s || s.length > URL_MAX) return null;
  let u;
  try { u = new URL(s); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (!u.hostname) return null;
  return s;
}

function textField(value, fallback, max) {
  if (value === undefined) return { ok: true, value: fallback };
  if (value === null) return { ok: true, value: '' };
  if (typeof value !== 'string') return { ok: false };
  const v = value.trim();
  if (v.length > max) return { ok: false };
  return { ok: true, value: v };
}

function categoryField(value, fallback) {
  if (value === undefined) return { ok: true, value: fallback };
  if (value === null || value === '') return { ok: true, value: null };
  const id = Number(value);
  if (!Number.isInteger(id) || !categoryExists.get(id)) return { ok: false };
  return { ok: true, value: id };
}

function parseBody(body, existing) {
  const b = body || {};
  const base = existing || { url: undefined, title: '', description: '', category_id: null, tag: '', hidden: 0 };

  let url = base.url;
  if (b.url !== undefined || !existing) {
    url = normalizeUrl(b.url);
    if (!url) return { error: 'invalid_url' };
  }
  const title = textField(b.title, base.title, TITLE_MAX);
  if (!title.ok) return { error: 'invalid_title' };
  const description = textField(b.description, base.description, DESC_MAX);
  if (!description.ok) return { error: 'invalid_description' };
  const tag = textField(b.tag, base.tag, TAG_MAX);
  if (!tag.ok) return { error: 'invalid_tag' };
  const category = categoryField(b.category_id, base.category_id);
  if (!category.ok) return { error: 'invalid_category' };
  const hidden = b.hidden === undefined ? base.hidden : (b.hidden ? 1 : 0);

  return {
    value: {
      url,
      title: title.value,
      description: description.value,
      tag: tag.value,
      category_id: category.value,
      hidden,
    },
  };
}

// GET /api/collab-links — 숨김 포함 전체. ?hidden=0 이면 숨기지 않은 것만, ?hidden=1 이면 숨긴 것만.
router.get('/', (req, res) => {
  const rows = listStmt.all();
  const h = req.query.hidden;
  if (h === '0' || h === '1') {
    const want = Number(h);
    return res.json(rows.filter((r) => r.hidden === want));
  }
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const row = getStmt.get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'not_found' });
  res.json(row);
});

// POST /api/collab-links  body: { url, title?, description?, category_id?, tag? }
router.post('/', (req, res) => {
  const parsed = parseBody(req.body, null);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  const info = insertStmt.run(v.url, v.title, v.description, v.category_id, v.tag);
  res.status(201).json(getStmt.get(info.lastInsertRowid));
});

// PUT /api/collab-links/:id — 부분 수정. 숨김/해제는 { hidden: true|false }.
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const existing = getStmt.get(id);
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const parsed = parseBody(req.body, existing);
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const v = parsed.value;
  updateStmt.run(v.url, v.title, v.description, v.category_id, v.tag, v.hidden, id);
  res.json(getStmt.get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'invalid_id' });
  const info = deleteStmt.run(id);
  if (info.changes === 0) return res.status(404).json({ error: 'not_found' });
  res.status(204).end();
});

function computeVersion() {
  return versionStmt.get().v;
}

module.exports = router;
module.exports.computeVersion = computeVersion;
