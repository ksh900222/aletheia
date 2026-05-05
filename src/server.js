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
// HOST — defaults to 127.0.0.1 (localhost only, single-user safe).
// Override with HOST=0.0.0.0 to expose to LAN (other devices on the network).
const HOST = process.env.HOST || '127.0.0.1';

app.use(express.json({ limit: '1mb' }));

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
  const shownHost = HOST === '0.0.0.0' ? 'localhost' : HOST;
  console.log(`project_planner listening on http://${shownHost}:${PORT}`);
  if (HOST === '0.0.0.0') {
    console.log(`  (also reachable from other devices on this network)`);
  }
});
