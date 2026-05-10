const path = require('path');
const fs = require('fs');
const db = require('./db');

const DATA_DIR = path.dirname(db.DB_PATH);
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const INTERVAL_MS = 4 * 60 * 60 * 1000;       // 4시간
const RETENTION_MS = 72 * 60 * 60 * 1000;     // 72시간

let timer = null;

function ensureBackupDir() {
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function timestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

// better-sqlite3 의 backup() API 는 hot-copy 안전 (WAL 보장).
async function runBackup(reason = 'periodic') {
  ensureBackupDir();
  const dest = path.join(BACKUP_DIR, `planner-${timestamp()}-${reason}.db`);
  try {
    await db.backup(dest);
    console.log(`[backup] ${reason} 백업 완료 → ${path.basename(dest)}`);
    pruneOld();
    return dest;
  } catch (e) {
    console.error('[backup] 실패:', e.message);
    return null;
  }
}

function pruneOld() {
  ensureBackupDir();
  const cutoff = Date.now() - RETENTION_MS;
  let removed = 0;
  for (const name of fs.readdirSync(BACKUP_DIR)) {
    if (!name.startsWith('planner-') || !name.endsWith('.db')) continue;
    const full = path.join(BACKUP_DIR, name);
    try {
      const st = fs.statSync(full);
      if (st.mtimeMs < cutoff) {
        fs.unlinkSync(full);
        removed += 1;
      }
    } catch {}
  }
  if (removed > 0) console.log(`[backup] 72시간 경과 백업 ${removed}개 삭제`);
}

function start() {
  if (timer) return;
  ensureBackupDir();
  pruneOld();
  // 부팅 시 1회 보관 정책만 적용 (즉시 백업은 안 함 — 운영자 의도 부담 회피).
  timer = setInterval(() => { runBackup('periodic'); }, INTERVAL_MS);
  console.log(`[backup] 4시간 주기 자동 백업 활성화 (보관 72시간, 디렉터리=${BACKUP_DIR})`);
}

function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

module.exports = { start, stop, runBackup, pruneOld, BACKUP_DIR };
