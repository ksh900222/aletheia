// Archive routes — local UI endpoints for the archived-peer-import feature.
//
//   GET  /api/archive/export             — Download own data as a ZIP (handoff)
//   POST /api/archive/import-from-peer   — Pull a peer's full archive over the
//                                          team-token network and persist it
//   POST /api/archive/import-from-file   — Accept an uploaded ZIP and persist it
//   GET  /api/archive/peers              — List currently imported (archived) peers
//   DELETE /api/archive/peers/:owner     — Remove an imported peer's data

const express = require('express');
const path = require('path');
const fs = require('fs');
const os = require('os');
const multer = require('multer');
const yauzl = require('yauzl');
const db = require('../db');
const settings = require('../team/settings');
const peerWatcher = require('../team/peerWatcher');
const archiveExporter = require('../team/archiveExporter');
const exporter = require('../team/exporter');

const router = express.Router();

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
const IMPORTED_DIR = path.join(UPLOAD_DIR, 'imported');
if (!fs.existsSync(IMPORTED_DIR)) fs.mkdirSync(IMPORTED_DIR, { recursive: true });

// Upload destination for incoming ZIPs — kept under data/ so server restart
// doesn't lose them mid-import. Cleaned up after the import pipeline runs.
const ZIP_TMP_DIR = path.resolve(__dirname, '..', '..', 'data', 'archive_uploads');
if (!fs.existsSync(ZIP_TMP_DIR)) fs.mkdirSync(ZIP_TMP_DIR, { recursive: true });

const upload = multer({
  dest: ZIP_TMP_DIR,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB cap; project archives shouldn't exceed
});

// GET /api/archive/export — download own data as ZIP
router.get('/export', (req, res) => {
  const cfg = settings.get();
  const owner = cfg.self.name || 'unknown';
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="archive_${encodeURIComponent(owner)}_${ts}.zip"`);
  archiveExporter.streamArchive(res, {
    owner,
    sourceVersion: exporter.computeVersion(),
  }).catch((err) => {
    console.error('[archive] /export stream failed:', err.message);
    if (!res.headersSent) res.status(500).json({ error: 'archive_failed' });
  });
});

// Import pipeline shared by from-peer and from-file. Accepts a ZIP file
// path on disk, parses it, persists into imported_* tables + copies upload
// blobs into uploads/imported/<owner>/. Returns { owner, table_counts }.
async function importFromZipPath(zipPath) {
  const { manifest, data, fileMap } = await readZip(zipPath);
  const owner = (manifest && manifest.owner) || '';
  if (!owner) throw new Error('manifest_missing_owner');

  // 1. Copy upload blobs into uploads/imported/<owner>/, rewrite paths in data
  const ownerDir = path.join(IMPORTED_DIR, owner);
  if (fs.existsSync(ownerDir)) {
    fs.rmSync(ownerDir, { recursive: true, force: true });
  }
  fs.mkdirSync(ownerDir, { recursive: true });

  const pathRewrites = new Map();
  for (const att of data.attachments || []) {
    if (att.kind !== 'upload') continue;
    const zipEntry = `uploads/${att.path}`;
    const buf = fileMap.get(zipEntry);
    if (!buf) continue; // missing in ZIP — leave path as-is, will 404 at download time
    const newPath = `imported/${owner}/${att.path}`;
    const outFile = path.join(UPLOAD_DIR, newPath);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, buf);
    pathRewrites.set(att.id, newPath);
  }

  // 2. Wipe + insert imported_* rows in a single transaction
  const tx = db.transaction(() => {
    // Wipe prior rows for this owner (re-import overwrites)
    for (const t of [
      'imported_categories', 'imported_schedules', 'imported_dependencies',
      'imported_reports', 'imported_report_categories', 'imported_report_schedules',
      'imported_attachments', 'imported_report_comments', 'imported_peers',
    ]) {
      db.prepare(`DELETE FROM ${t} WHERE owner = ?`).run(owner);
    }

    const insCat = db.prepare(
      `INSERT INTO imported_categories (owner, id, name, description, color, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.categories || []) {
      insCat.run(owner, r.id, r.name, r.description, r.color, r.created_at);
    }

    const insSched = db.prepare(
      `INSERT INTO imported_schedules
        (owner, id, category_id, title, description, planned_start, planned_end,
         actual_start, actual_end, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.schedules || []) {
      insSched.run(owner, r.id, r.category_id, r.title, r.description,
        r.planned_start, r.planned_end, r.actual_start, r.actual_end,
        r.status, r.created_at, r.updated_at);
    }

    const insDep = db.prepare(
      `INSERT INTO imported_dependencies
        (owner, id, pred_type, pred_id, succ_type, succ_id, link_type, on_delay, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.dependencies || []) {
      insDep.run(owner, r.id, r.pred_type, r.pred_id, r.succ_type, r.succ_id,
        r.link_type, r.on_delay, r.created_at);
    }

    const insRep = db.prepare(
      `INSERT INTO imported_reports (owner, id, report_date, body, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.reports || []) {
      insRep.run(owner, r.id, r.report_date, r.body, r.created_at, r.updated_at);
    }

    const insRC = db.prepare(
      `INSERT INTO imported_report_categories (owner, report_id, category_id) VALUES (?, ?, ?)`
    );
    for (const r of data.report_categories || []) {
      insRC.run(owner, r.report_id, r.category_id);
    }

    const insRS = db.prepare(
      `INSERT INTO imported_report_schedules (owner, report_id, schedule_id) VALUES (?, ?, ?)`
    );
    for (const r of data.report_schedules || []) {
      insRS.run(owner, r.report_id, r.schedule_id);
    }

    const insAtt = db.prepare(
      `INSERT INTO imported_attachments (owner, id, report_id, kind, path, display_name, size_bytes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.attachments || []) {
      const rewritten = pathRewrites.get(r.id);
      insAtt.run(owner, r.id, r.report_id, r.kind,
        rewritten || r.path, r.display_name, r.size_bytes, r.created_at);
    }

    const insCm = db.prepare(
      `INSERT INTO imported_report_comments (owner, id, report_id, author, body, created_at, acknowledged)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const r of data.report_comments || []) {
      insCm.run(owner, r.id, r.report_id, r.author, r.body, r.created_at, r.acknowledged || 0);
    }

    db.prepare(
      `INSERT INTO imported_peers (owner, imported_at, source_version, source_host)
       VALUES (?, datetime('now'), ?, ?)`
    ).run(owner, manifest.source_version || null, manifest.source_host || null);
  });
  tx();

  // 3. Auto-remove from live peer list + clean up sprint group replicas
  try {
    peerWatcher.removePeer(owner);
  } catch { /* peer may not exist in list — that's fine */ }
  try {
    db.prepare(`DELETE FROM sprint_groups WHERE creator = ?`).run(owner);
  } catch { /* ignore */ }

  return {
    owner,
    imported_at: new Date().toISOString(),
    table_counts: {
      categories: (data.categories || []).length,
      schedules: (data.schedules || []).length,
      dependencies: (data.dependencies || []).length,
      reports: (data.reports || []).length,
      attachments: (data.attachments || []).length,
    },
  };
}

// Read a ZIP file into memory. Returns { manifest, data, fileMap } where
// fileMap holds the buffers for `uploads/*` entries keyed by their full
// in-zip path (e.g., "uploads/abc.pdf").
function readZip(zipPath) {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      let manifest = null;
      let data = null;
      const fileMap = new Map();
      zipfile.readEntry();
      zipfile.on('entry', (entry) => {
        const name = entry.fileName;
        const isText = name === 'manifest.json' || name === 'data.json';
        zipfile.openReadStream(entry, (rerr, readStream) => {
          if (rerr) return reject(rerr);
          const chunks = [];
          readStream.on('data', (c) => chunks.push(c));
          readStream.on('end', () => {
            const buf = Buffer.concat(chunks);
            if (name === 'manifest.json') {
              try { manifest = JSON.parse(buf.toString('utf8')); }
              catch (e) { return reject(new Error('manifest_invalid_json')); }
            } else if (name === 'data.json') {
              try { data = JSON.parse(buf.toString('utf8')); }
              catch (e) { return reject(new Error('data_invalid_json')); }
            } else if (name.startsWith('uploads/')) {
              fileMap.set(name, buf);
            }
            zipfile.readEntry();
          });
          readStream.on('error', reject);
        });
      });
      zipfile.on('end', () => {
        if (!manifest) return reject(new Error('manifest_missing'));
        if (!data) return reject(new Error('data_missing'));
        resolve({ manifest, data, fileMap });
      });
      zipfile.on('error', reject);
    });
  });
}

// POST /api/archive/import-from-file  (multipart/form-data, field: 'archive')
router.post('/import-from-file', upload.single('archive'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'file_required' });
  try {
    const result = await importFromZipPath(req.file.path);
    res.json(result);
  } catch (e) {
    console.error('[archive] import-from-file failed:', e.message);
    res.status(500).json({ error: 'import_failed', detail: e.message });
  } finally {
    fs.unlink(req.file.path, () => {});
  }
});

// POST /api/archive/import-from-peer  body: {name}
//   Pull the peer's /api/team/full-archive (token-gated) and import it.
router.post('/import-from-peer', express.json(), async (req, res) => {
  const { name } = req.body || {};
  if (!name || typeof name !== 'string') {
    return res.status(400).json({ error: 'name_required' });
  }
  const peer = peerWatcher.getPeers().find((p) => p.name === name);
  if (!peer) return res.status(404).json({ error: 'peer_not_found' });
  const cfg = settings.get();
  if (!cfg.sharedToken) {
    return res.status(503).json({ error: 'team_token_not_configured' });
  }
  const tmpFile = path.join(ZIP_TMP_DIR, `peer_${Date.now()}.zip`);
  try {
    const url = `http://${peer.host}:${peer.port}/api/team/full-archive`;
    const r = await fetch(url, {
      headers: { 'X-Team-Token': cfg.sharedToken },
    });
    if (!r.ok) throw new Error(`peer_returned_${r.status}`);
    const ab = await r.arrayBuffer();
    fs.writeFileSync(tmpFile, Buffer.from(ab));
    const result = await importFromZipPath(tmpFile);
    res.json(result);
  } catch (e) {
    console.error('[archive] import-from-peer failed:', e.message);
    res.status(500).json({ error: 'import_failed', detail: e.message });
  } finally {
    fs.unlink(tmpFile, () => {});
  }
});

// GET /api/archive/peers — list imported peers (read-only)
router.get('/peers', (req, res) => {
  const rows = db.prepare(
    `SELECT owner, imported_at, source_version, source_host FROM imported_peers
      ORDER BY imported_at DESC`
  ).all();
  // Decorate with table counts for at-a-glance overview
  for (const r of rows) {
    r.counts = {
      categories: db.prepare(`SELECT COUNT(*) c FROM imported_categories WHERE owner=?`).get(r.owner).c,
      schedules: db.prepare(`SELECT COUNT(*) c FROM imported_schedules WHERE owner=?`).get(r.owner).c,
      reports: db.prepare(`SELECT COUNT(*) c FROM imported_reports WHERE owner=?`).get(r.owner).c,
    };
  }
  res.json(rows);
});

// DELETE /api/archive/peers/:owner — fully remove an imported peer's data
router.delete('/peers/:owner', (req, res) => {
  const owner = req.params.owner;
  if (!owner) return res.status(400).json({ error: 'owner_required' });

  const tx = db.transaction(() => {
    for (const t of [
      'imported_categories', 'imported_schedules', 'imported_dependencies',
      'imported_reports', 'imported_report_categories', 'imported_report_schedules',
      'imported_attachments', 'imported_report_comments', 'imported_peers',
    ]) {
      db.prepare(`DELETE FROM ${t} WHERE owner = ?`).run(owner);
    }
  });
  tx();

  // Also clean up the on-disk uploads/imported/<owner>/ blobs
  const ownerDir = path.join(IMPORTED_DIR, owner);
  if (fs.existsSync(ownerDir)) {
    try { fs.rmSync(ownerDir, { recursive: true, force: true }); }
    catch (e) { console.warn('[archive] cleanup uploads/imported/' + owner + ' failed:', e.message); }
  }

  res.status(204).end();
});

module.exports = router;
