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
    // multer/busboy 가 Content-Disposition 헤더의 filename 을 기본 latin1 로
    // 디코드해 UTF-8 한글 등이 깨진다. 원본 UTF-8 바이트로 되돌린다.
    const displayName = Buffer.from(req.file.originalname, 'latin1').toString('utf8');
    const info = insertAttachment.run(
      reportId,
      'upload',
      req.file.filename,
      displayName,
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

const findAttachmentName = db.prepare(
  `SELECT display_name FROM attachments WHERE kind = 'upload' AND path = ?`
);
const findTaskAttachmentName = db.prepare(
  `SELECT display_name FROM task_request_attachments WHERE kind = 'upload' AND path = ?`
);
let findImportedAttachmentName = null;
try {
  findImportedAttachmentName = db.prepare(
    `SELECT display_name FROM imported_attachments WHERE kind = 'upload' AND path = ?`
  );
} catch {
  findImportedAttachmentName = null;
}

function lookupDisplayName(storedPath) {
  const row =
    findAttachmentName.get(storedPath) ||
    findTaskAttachmentName.get(storedPath) ||
    (findImportedAttachmentName && findImportedAttachmentName.get(storedPath));
  return row && row.display_name ? String(row.display_name) : '';
}

function fileBaseName(name) {
  return String(name || '')
    .split(/[?#]/)[0]
    .replace(/\\/g, '/')
    .split('/')
    .pop();
}

function isHtmlFileName(name) {
  return /\.html?$/i.test(fileBaseName(name));
}

function contentDispositionHeader(name, disposition) {
  const raw = String(name || 'download')
    .replace(/[\r\n\0]/g, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .slice(0, 200);
  const fallback =
    raw.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_') || 'download';
  const encoded = encodeURIComponent(raw).replace(/[!'()*]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
  const kind = disposition === 'inline' ? 'inline' : 'attachment';
  return `${kind}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

// ?inline=1 은 HTML(.html/.htm)만 브라우저에 표시한다. 그 외 형식은 쿼리를
// 무시하고 항상 다운로드로 내려 실수로 실행 파일이 열리지 않게 한다.
function wantsInlineHtml(displayName, storedRel, query) {
  const flag = query && (query.inline === '1' || query.inline === 'true');
  if (!flag) return false;
  return isHtmlFileName(displayName) || isHtmlFileName(storedRel);
}

function resolveUploadFile(urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(String(urlPath || ''));
  } catch {
    return null;
  }
  rel = rel.replace(/^\/+/, '');
  if (!rel || rel.includes('\0')) return null;
  const root = path.resolve(UPLOAD_DIR);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) return null;
  return {
    rel: path.relative(root, full).split(path.sep).join('/'),
    full,
  };
}

function serveUploads(req, res, next) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const resolved = resolveUploadFile(req.path);
  if (!resolved) return res.status(400).json({ error: 'bad_filename' });
  fs.stat(resolved.full, (err, st) => {
    if (err || !st.isFile()) return res.status(404).end();
    const display = lookupDisplayName(resolved.rel) || path.basename(resolved.rel);
    if (wantsInlineHtml(display, resolved.rel, req.query)) {
      res.setHeader('Content-Disposition', contentDispositionHeader(display, 'inline'));
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      // 업로드 HTML 은 이 앱과 같은 출처다. sandbox 로 고유 출처에 가두고
      // connect-src/form-action 을 막아, 페이지 안의 스크립트가 IP 권한으로
      // /api 를 호출하거나 폼을 제출하지 못하게 한다. 스크립트·스타일 렌더는
      // 허용해서 리포트 HTML 자체는 그대로 보이게 한다.
      res.setHeader(
        'Content-Security-Policy',
        [
          "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-modals allow-downloads",
          "default-src * data: blob: 'unsafe-inline' 'unsafe-eval'",
          "connect-src 'none'",
          "form-action 'none'",
          "base-uri 'none'",
        ].join('; ')
      );
    } else {
      res.setHeader('Content-Disposition', contentDispositionHeader(display));
    }
    res.sendFile(resolved.full, (sendErr) => {
      if (sendErr && !res.headersSent) next(sendErr);
    });
  });
}

module.exports = router;
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.cleanupUploadedFiles = cleanupUploadedFiles;
module.exports.serveUploads = serveUploads;
module.exports.isHtmlFileName = isHtmlFileName;
module.exports.wantsInlineHtml = wantsInlineHtml;
module.exports.contentDispositionHeader = contentDispositionHeader;
