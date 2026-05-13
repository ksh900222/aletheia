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
const exporter = require('./team/exporter');
const teamEvents = require('./team/events');
const backup = require('./backup');

const app = express();
// PORT — defaults to 3000. Override with PORT=4000 node src/server.js.
const PORT = Number(process.env.PORT) || 3000;
// HOST — defaults to 0.0.0.0 so other devices can connect when network/firewall allow it.
// Override with HOST=127.0.0.1 to keep localhost-only access.
const HOST = process.env.HOST || '0.0.0.0';

app.use(express.json({ limit: '1mb' }));

// DB 변경 이벤트 자동 emit — mutating 요청이 2xx 로 응답 마무리되는 시점에
// SSE 이벤트 'db_changed' 를 한 번 발사. 다른 탭/브라우저의 EventSource 가
// 즉시 받아 본인 데이터를 새로고침 (frontend 의 checkAndReloadIfChanged
// 트리거). 같은 요청을 보낸 탭도 함께 받지만 frontend 가 version 비교로
// no-op 처리하므로 무해.
app.use((req, res, next) => {
  const m = req.method;
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return next();
  res.on('finish', () => {
    if (res.statusCode >= 200 && res.statusCode < 300) {
      try {
        teamEvents.record('db_changed', {
          method: m,
          path: req.path,
        });
      } catch (e) {
        console.warn('[events] db_changed emit 실패:', e && e.message);
      }
    }
  });
  next();
});

// IP-based authorization. 권한 계층 (높은 → 낮은):
//
//   WRITE_ALLOWLIST    — 전체 쓰기 (팀원·관리자). 모든 mutating 라우트.
//     자기 PC 의 모든 LAN IP 는 peerWatcher.getLocalIPs() 로 자동 포함.
//
//   COMMENT_ALLOWLIST  — 읽기 + 다운로드 + 코멘트만. 그 외 mutation 전부 차단.
//     "외부 협력자가 자료 보고 코멘트만 남기게 해주고 싶을 때." 코멘트는
//     /api/team/comment-out (및 edit/remove) 만 가능.
//
//   READ_ALLOWLIST     — 다운로드 (/uploads) + read 만. 코멘트도 불가.
//
// 등록된 team peer 의 host 도 자동으로 read+download 권한 (canRead) 부여.
// API GET 은 별도 가드 없이 LAN 누구나. /uploads 만 canRead 로 가드.
const WRITE_ALLOWLIST = new Set([
  // 추가 IP 가 필요하면 여기에 적고 재시작.
]);
const COMMENT_ALLOWLIST = new Set([
    '10.115.33.155',
    '10.115.35.86',
  // 코멘트 + 다운로드만 허용할 IP. 예: 외부 협력자 PC.
]);
const READ_ALLOWLIST = new Set([
  // 읽기 + 다운로드만 허용할 IP (코멘트도 불가).
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

// 코멘트 가능 권한: canWrite 또는 COMMENT_ALLOWLIST 에 등록된 IP.
function canComment(req) {
  if (canWrite(req)) return true;
  return COMMENT_ALLOWLIST.has(clientIp(req));
}

// 코멘트 작성자 이름. canWrite (호스트 운영자) 는 self.name 으로, 외부
// COMMENT_ALLOWLIST IP 는 "외부(<ip>)" 로 식별. 이 값이 author 컬럼에 들어가고,
// 본인 코멘트 매칭 (수정/삭제 권한, 「내 코멘트 N」 배지) 의 기준이 된다.
function commentAuthor(req) {
  if (canWrite(req)) {
    const self = teamSettings.get().self;
    return (self && self.name) || '';
  }
  return `외부(${clientIp(req)})`;
}

// 모든 요청에 권한 / IP / 작성자 식별을 부착. 하위 라우터 (team.js 등) 가
// canWrite/canComment 를 자기들 모듈에서 다시 계산할 필요 없이 req 만 보면 됨.
app.use((req, res, next) => {
  req.clientIp = clientIp(req);
  req.canWrite = canWrite(req);
  req.canComment = canComment(req);
  req.commentAuthor = commentAuthor(req);
  next();
});

// 첨부 다운로드 권한: canWrite 또는 COMMENT_ALLOWLIST 또는 READ_ALLOWLIST
// 또는 등록된 team peer 만 허용. LAN 의 비-허가 PC 는 차단.
function canRead(req) {
  if (canComment(req)) return true;
  const ip = clientIp(req);
  if (READ_ALLOWLIST.has(ip)) return true;
  return peerWatcher.getPeers().some((p) => p.host === ip);
}

// Identity endpoint — the frontend calls this on boot to decide whether to
// surface write affordances. Defined before the write guard so it's always
// reachable (it's a GET, so the guard would let it through anyway, but being
// explicit avoids future mistakes).
app.get('/api/auth/me', (req, res) => {
  res.json({
    ip: clientIp(req),
    canWrite: canWrite(req),
    canComment: canComment(req),
    commenterName: commentAuthor(req),
  });
});

// 본인 DB 변경 감지용 fingerprint endpoint. 프론트엔드가 탭 복귀·폴링 시
// 이 값과 lastSeenVersion 을 비교해 다를 때만 본인 데이터를 다시 fetch.
// exporter.computeVersion() 은 categories/schedules/dependencies/reports/
// report_comments/sprint_groups 의 COUNT + MAX(updated_at) 조합이라
// row 추가·수정·삭제를 모두 잡는다 (~100 바이트 응답).
app.get('/api/version', (req, res) => {
  res.json({ version: exporter.computeVersion() });
});

// /api/team/comment-{out,edit-out,remove-out} 가드 — 본인 UI 가 코멘트를
// 작성·편집·삭제할 때 사용하는 라우트. 원래 team router 는 IP 가드 없이
// 마운트되지만, 이 세 엔드포인트는 외부에서 임의로 호출 못 하게 canComment
// 로 제한 (WRITE_ALLOWLIST + COMMENT_ALLOWLIST + 본인 LAN IP 만).
const COMMENT_OUT_PATHS = new Set([
  '/api/team/comment-out',
  '/api/team/comment-edit-out',
  '/api/team/comment-remove-out',
]);
app.use((req, res, next) => {
  if (req.method !== 'POST') return next();
  if (!COMMENT_OUT_PATHS.has(req.path)) return next();
  if (canComment(req)) return next();
  return res.status(403).json({ error: 'forbidden_comment_from_ip', ip: clientIp(req) });
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
// 업무요청 (보낸·받은 내역 포함) 은 민감 정보 → canWrite 만 접근 가능.
// COMMENT/READ 등급 IP 와 일반 LAN 사용자는 GET 목록도 차단. team router 의
// task-request-in / task-response-in 은 별도 (token 인증으로 cross-peer 만).
app.use('/api/tasks', (req, res, next) => {
  if (canWrite(req)) return next();
  return res.status(403).json({ error: 'forbidden_tasks_from_ip', ip: clientIp(req) });
}, tasksRouter);
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
  if (COMMENT_ALLOWLIST.size > 0) {
    console.log(`[server] comment+다운로드 허용: ${Array.from(COMMENT_ALLOWLIST).join(', ')}`);
  }
  if (READ_ALLOWLIST.size > 0) {
    console.log(`[server] read-only 허용 (다운로드만): ${Array.from(READ_ALLOWLIST).join(', ')}`);
  }
});
