// ZIP archive builder for full peer-data handoff. Produces the format that
// the importer side (src/routes/archive.js) consumes.
//
// Layout inside the ZIP:
//   manifest.json   — {owner, exported_at, source_version, source_host?}
//   data.json       — all rows from the OWN data tables (sprint review excluded)
//   uploads/        — every "upload"-kind attachment file referenced by data.json
//
// "local_path" attachments are kept as metadata only — those file paths live on
// the source machine's local filesystem and can't be transported.

const path = require('path');
const fs = require('fs');
const archiver = require('archiver');
const db = require('../db');

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');

function collectOwnSnapshot() {
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
  };
}

// Pipe a ZIP archive of own DB + uploads to the given writable stream (express
// res or a fs writeStream). Caller is responsible for setting headers if going
// to HTTP; this function just produces the stream content.
function streamArchive(writable, { owner, sourceVersion, sourceHost } = {}) {
  const data = collectOwnSnapshot();
  const manifest = {
    owner: owner || '',
    exported_at: new Date().toISOString(),
    source_version: sourceVersion || null,
    source_host: sourceHost || null,
    table_counts: Object.fromEntries(
      Object.entries(data).map(([k, v]) => [k, v.length])
    ),
  };

  const zip = archiver('zip', { zlib: { level: 9 } });
  zip.on('warning', (err) => {
    if (err.code !== 'ENOENT') console.error('[archive] warning:', err.message);
  });
  zip.on('error', (err) => {
    console.error('[archive] error:', err.message);
    writable.destroy(err);
  });

  zip.pipe(writable);

  zip.append(JSON.stringify(manifest, null, 2), { name: 'manifest.json' });
  zip.append(JSON.stringify(data, null, 2), { name: 'data.json' });

  // Bundle uploaded attachment files. local_path entries have no transportable
  // file content — they're metadata only and stay as-is in data.json.
  for (const att of data.attachments) {
    if (att.kind !== 'upload') continue;
    const fullPath = path.join(UPLOAD_DIR, att.path);
    if (fs.existsSync(fullPath)) {
      zip.file(fullPath, { name: `uploads/${att.path}` });
    } else {
      console.warn(`[archive] missing upload file: ${att.path}`);
    }
  }

  return zip.finalize();
}

module.exports = { streamArchive, collectOwnSnapshot };
