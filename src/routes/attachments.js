const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('../db');

const UPLOAD_DIR = path.resolve(__dirname, '..', '..', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: UPLOAD_DIR,
  filename: (_req, file, cb) => {
    // Random unique name + original extension. Original filename is preserved
    // separately as `display_name` in the DB.
    const ext = path.extname(file.originalname);
    const safe = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
    cb(null, safe + ext);
  },
});
const upload = multer({
  storage,
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

const reportExists = db.prepare(`SELECT 1 FROM reports WHERE id = ?`);
const insertAttachment = db.prepare(
  `INSERT INTO attachments (report_id, kind, path, display_name, size_bytes)
   VALUES (?, ?, ?, ?, ?)`
);
const getAttachment = db.prepare(`SELECT * FROM attachments WHERE id = ?`);
const deleteAttachment = db.prepare(`DELETE FROM attachments WHERE id = ?`);

function unlinkSilent(filename) {
  if (!filename) return;
  const full = path.join(UPLOAD_DIR, filename);
  // Disk cleanup is best-effort; we don't fail the API on file errors.
  fs.unlink(full, () => {});
}

function cleanupUploadedFiles(filenames) {
  for (const f of filenames) unlinkSilent(f);
}

const router = express.Router();

// Upload a file as an attachment to a report.
//   POST /api/reports/:reportId/attachments  (multipart/form-data, field "file")
router.post(
  '/reports/:reportId/attachments/upload',
  upload.single('file'),
  (req, res) => {
    const reportId = Number(req.params.reportId);
    if (!reportExists.get(reportId)) {
      // Multer already saved the file; clean it up.
      if (req.file) unlinkSilent(req.file.filename);
      return res.status(404).json({ error: 'report_not_found' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'no_file' });
    }
    const info = insertAttachment.run(
      reportId,
      'upload',
      req.file.filename,
      req.file.originalname,
      req.file.size
    );
    res.status(201).json(getAttachment.get(info.lastInsertRowid));
  }
);

// Register a local-filesystem path as an attachment (no upload).
//   POST /api/reports/:reportId/attachments/local  (JSON: { path, display_name })
//
// Use case: enterprise shared-drive absolute paths (e.g. /Volumes/team/foo.pdf
// on mac, \\server\share\foo.pdf on Windows). We only accept absolute paths
// to make the model's intent explicit and to keep relative-path / traversal
// patterns (`..`, `./`) out of stored data. NUL bytes and oversized strings
// are also rejected. The server never opens or reads these files — they're
// purely link metadata for the client to render.
const PATH_MAX = 1024;
function validateLocalPath(p) {
  if (typeof p !== 'string') return 'path_required';
  const trimmed = p.trim();
  if (!trimmed) return 'path_required';
  if (trimmed.length > PATH_MAX) return 'path_too_long';
  if (trimmed.includes('\0')) return 'path_invalid';
  if (!path.isAbsolute(trimmed)) return 'path_not_absolute';
  return { ok: trimmed };
}

router.post('/reports/:reportId/attachments/local', (req, res) => {
  const reportId = Number(req.params.reportId);
  if (!reportExists.get(reportId)) {
    return res.status(404).json({ error: 'report_not_found' });
  }
  const { path: filePath, display_name } = req.body || {};
  const v = validateLocalPath(filePath);
  if (typeof v === 'string') return res.status(400).json({ error: v });
  const trimmed = v.ok;
  const name =
    display_name && typeof display_name === 'string' && display_name.trim()
      ? display_name.trim()
      : trimmed;
  const info = insertAttachment.run(reportId, 'local_path', trimmed, name, null);
  res.status(201).json(getAttachment.get(info.lastInsertRowid));
});

router.delete('/attachments/:id', (req, res) => {
  const id = Number(req.params.id);
  const att = getAttachment.get(id);
  if (!att) return res.status(404).json({ error: 'not_found' });
  if (att.kind === 'upload') unlinkSilent(att.path);
  deleteAttachment.run(id);
  res.status(204).end();
});

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.cleanupUploadedFiles = cleanupUploadedFiles;
