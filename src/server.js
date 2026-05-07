const path = require('path');
const express = require('express');

require('./db');

const categoriesRouter = require('./routes/categories');
const schedulesRouter = require('./routes/schedules');
const dependenciesRouter = require('./routes/dependencies');
const reportsRouter = require('./routes/reports');
const attachmentsRouter = require('./routes/attachments');
const scheduler = require('./engine/scheduler');
const holidays = require('./holidays');

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

// Identity endpoint — the frontend calls this on boot to decide whether to
// surface write affordances. Defined before the write guard so it's always
// reachable (it's a GET, so the guard would let it through anyway, but being
// explicit avoids future mistakes).
app.get('/api/auth/me', (req, res) => {
  res.json({ ip: clientIp(req), canWrite: canWrite(req) });
});

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

// Serve uploaded attachments at /uploads/<filename>.
app.use('/uploads', express.static(attachmentsRouter.UPLOAD_DIR));

app.use(express.static(path.resolve(__dirname, '..', 'public')));

app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

// Korean holiday cache: load from disk, then schedule daily refresh.
holidays.load();
holidays.scheduleDaily();

app.listen(PORT, HOST, () => {
  console.log(`project_planner listening on http://${HOST}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`  (also reachable from other devices on this network)`);
  }
});
