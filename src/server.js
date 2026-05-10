const path = require('path');
const express = require('express');

const db = require('./db');

const categoriesRouter = require('./routes/categories');
const schedulesRouter = require('./routes/schedules');
const dependenciesRouter = require('./routes/dependencies');
const reportsRouter = require('./routes/reports');
const attachmentsRouter = require('./routes/attachments');
const tasksRouter = require('./routes/tasks');
const scheduler = require('./engine/scheduler');
const holidays = require('./holidays');
const teamSettings = require('./team/settings');
const peerWatcher = require('./team/peerWatcher');
const peerBroadcaster = require('./team/peerBroadcaster');
const teamRouter = require('./routes/team');
const backup = require('./backup');

const app = express();
// PORT — defaults to 3000. Override with PORT=4000 node src/server.js.
const PORT = Number(process.env.PORT) || 3000;
// HOST — defaults to 0.0.0.0 so other devices can connect when network/firewall allow it.
// Override with HOST=127.0.0.1 to keep localhost-only access.
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '1mb' }));

// IP-based write authorization. Only requests originating from these IPs are
// allowed to mutate state (POST/PUT/PATCH/DELETE). Reads (GET/HEAD/OPTIONS)
// are open to everyone on the network. To change the allowlist, edit this
// set and restart the server.
const WRITE_ALLOWLIST = new Set([
  '10.115.41.127',
  '10.115.33.155', // 임시 비활성화 — 다시 권한을 주려면 주석 해제
  '10.115.147.185',
  '192.168.0.16',  // 외부망 (집/공유기 등) 접속 IP
  // Loopback included so the operator can administer from the host machine
  // itself. Remove these two lines if local writes should also be blocked.
  '127.0.0.1',
  '::1',
]);

function clientIp(req) {
  // No proxy is configured, so trust the direct peer address. Strip the
  // IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`) so v4 literals match.
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function canWrite(req) {
  return WRITE_ALLOWLIST.has(clientIp(req));
}

// 첨부 다운로드 권한: 본인 PC(WRITE_ALLOWLIST) 또는 등록된 team peer 만 허용.
// LAN 의 비-사용자(curl, 일반 LAN PC)는 차단.
function canRead(req) {
  if (canWrite(req)) return true;
  const ip = clientIp(req);
  return peerWatcher.getPeers().some((p) => p.host === ip);
}

// Identity endpoint — the frontend calls this on boot to decide whether to
// surface write affordances. Defined before the write guard so it's always
// reachable (it's a GET, so the guard would let it through anyway, but being
// explicit avoids future mistakes).
app.get('/api/auth/me', (req, res) => {
  res.json({ ip: clientIp(req), canWrite: canWrite(req) });
});

// Team router is mounted BEFORE the IP write-guard so cross-peer endpoints
// (peer-update, etc.) can be reached from any team-member IP. The router
// enforces shared-token auth on those endpoints internally.
app.use('/api/team', teamRouter);

app.use((req, res, next) => {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (canWrite(req)) return next();
  res.status(403).json({ error: 'forbidden_write_from_ip', ip: clientIp(req) });
});

app.use('/api/categories', categoriesRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/dependencies', dependenciesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api', attachmentsRouter); // exposes /api/reports/:id/attachments/* and /api/attachments/:id
app.use('/api/tasks', tasksRouter);

app.post('/api/recompute', (req, res) => {
  res.json(scheduler.recomputeAll());
});

app.get('/api/holidays', (req, res) => {
  res.json(holidays.getMerged());
});
app.post('/api/holidays/refresh', async (req, res) => {
  await holidays.refresh();
  res.json(holidays.getMerged());
});

app.get('/api/health', (req, res) => {
  res.json({ ok: true, ts: new Date().toISOString() });
});

// Serve uploaded attachments at /uploads/<filename>. Restricted to local
// machine + registered team peers (canRead) — non-program LAN hosts denied.
app.use('/uploads', (req, res, next) => {
  if (!canRead(req)) {
    return res.status(403).json({ error: 'forbidden_read_from_ip', ip: clientIp(req) });
  }
  next();
}, express.static(attachmentsRouter.UPLOAD_DIR));

app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

// Korean holiday cache: load from disk, then schedule daily refresh.
holidays.load();
holidays.scheduleDaily();

// Team peer config — peerWatcher delegates to peerStore (SQLite). Migration
// from legacy CSV runs inside start() if the DB is empty. peerBroadcaster
// hooks onChange AFTER start() so the migration's bulk-upsert isn't sent out.
teamSettings.load();
peerWatcher.start();
peerBroadcaster.init();
// Boot-time announcement: push my current peer list to every peer once. This
// catches peers that were offline when I made local changes, and bootstraps
// new instances that don't yet know what I know. Fire-and-forget — failures
// just mean those peers will catch up next time someone changes something.
setImmediate(() => {
  peerBroadcaster.announceCurrentList()
    .catch((e) => console.warn('[team] boot announce 오류:', e.message));
});

// 4시간 주기 자동 백업 (보관 72시간) — C-7 정책.
backup.start();

// Graceful shutdown — WAL checkpoint 후 DB close. WAL 파일 비워두면 다음 부팅 빠름.
function shutdown(signal) {
  console.log(`[server] ${signal} 수신 — 정리 중...`);
  try { backup.stop(); } catch {}
  try {
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    console.log('[server] WAL checkpoint + DB close 완료');
  } catch (e) {
    console.error('[server] shutdown 중 오류:', e.message);
  }
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

app.listen(PORT, HOST, () => {
  console.log(`project_planner listening on http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`  (also reachable from other devices on this network)`);
  }
});
