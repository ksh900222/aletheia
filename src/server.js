const path = require('path');
const express = require('express');

const db = require('./db');

const categoriesRouter = require('./routes/categories');
const schedulesRouter = require('./routes/schedules');
const dependenciesRouter = require('./routes/dependencies');
const reportsRouter = require('./routes/reports');
const attachmentsRouter = require('./routes/attachments');
const tasksRouter = require('./routes/tasks');
const sprintGroupsRouter = require('./routes/sprint_groups');
const archiveRouter = require('./routes/archive');
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
// are open to everyone on the network. The operator's own machine (all local
// network interfaces) is auto-included via peerWatcher.getLocalIPs() so the
// person who launched the server is never read-only on their own PC, even
// when accessing it from their LAN IP rather than localhost.
const WRITE_ALLOWLIST = new Set([
  // 추가 IP 가 필요하면 여기에 적고 재시작. (자기 PC 의 IP 는 자동 등록되므로
  // 보통은 비워두면 됨.)
]);

function clientIp(req) {
  // No proxy is configured, so trust the direct peer address. Strip the
  // IPv4-mapped IPv6 prefix (`::ffff:1.2.3.4`) so v4 literals match.
  let ip = (req.socket && req.socket.remoteAddress) || '';
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  return ip;
}

function canWrite(req) {
  const ip = clientIp(req);
  if (WRITE_ALLOWLIST.has(ip)) return true;
  return peerWatcher.getLocalIPs().has(ip);
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

// Project-freeze guard — when team_settings.frozen=true, refuse all mutating
// requests with 423 Locked. Read paths stay fully open so the frozen folder
// can be browsed as a read-only project archive. Exception: the freeze
// endpoint itself remains reachable (one-way toggle, so a frozen project
// would still allow setting frozen=true a second time — harmless).
app.use((req, res, next) => {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  if (req.path === '/api/admin/freeze') return next();
  if (teamSettings.isFrozen()) {
    return res.status(423).json({
      error: 'project_frozen',
      frozenAt: teamSettings.get().frozenAt,
    });
  }
  next();
});

// Admin freeze endpoint — one-way toggle. Once frozen, the UI button is
// hidden; reset requires manual edit of team_settings.json.
app.post('/api/admin/freeze', express.json(), (req, res) => {
  const result = teamSettings.freeze();
  res.json(result);
});
app.get('/api/admin/freeze-status', (req, res) => {
  res.json({ frozen: teamSettings.isFrozen(), frozenAt: teamSettings.get().frozenAt });
});

app.use('/api/categories', categoriesRouter);
app.use('/api/schedules', schedulesRouter);
app.use('/api/dependencies', dependenciesRouter);
app.use('/api/reports', reportsRouter);
app.use('/api', attachmentsRouter); // exposes /api/reports/:id/attachments/* and /api/attachments/:id
app.use('/api/tasks', tasksRouter);
app.use('/api/sprint-groups', sprintGroupsRouter);
app.use('/api/archive', archiveRouter);

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
// Auto-add the operator's own machine to the peer list (host = primary LAN
// IP, port = self.port, name = self.name) and mark stale self-shaped rows
// for cleanup. Runs AFTER broadcaster.init so any changes also propagate
// outward (a rename here cascades to remote peer lists, fixing the recurring
// origin_mismatch caused by stale names elsewhere).
peerWatcher.ensureSelfPeer();
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
  const autoIps = Array.from(peerWatcher.getLocalIPs()).filter((s) => s !== 'localhost');
  console.log(`[server] write 자동 허용 (자기 PC IP): ${autoIps.join(', ')}`);
  if (WRITE_ALLOWLIST.size > 0) {
    console.log(`[server] write 추가 허용 (수동): ${Array.from(WRITE_ALLOWLIST).join(', ')}`);
  }
});
