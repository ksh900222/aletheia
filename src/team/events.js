// Lightweight event ring buffer for team events that the frontend polls.
// Each event has a monotonic seq + ISO timestamp + kind + detail. The client
// records the last seen seq and fetches /api/team/events?since=<seq>.
//
// Recorded kinds:
//   csv_reload              — peer CSV was successfully reloaded (post-boot)
//   csv_validation_error    — peer CSV could not be parsed; previous list kept
//   peer_update_received    — another peer broadcast peer-list changes to us
const buffer = [];
let nextSeq = 1;
const MAX = 100;
// Live SSE subscribers — Express Response objects that we write events to as
// they happen, instead of waiting for them to poll. Set is faster to iterate
// than Map and we don't need keys.
const subscribers = new Set();

function record(kind, detail) {
  const ev = {
    seq: nextSeq++,
    ts: new Date().toISOString(),
    kind,
    detail: detail || {},
  };
  buffer.push(ev);
  while (buffer.length > MAX) buffer.shift();
  // Best-effort push to live SSE subscribers. A failed write usually means
  // the socket is gone — drop that subscriber.
  const payload = `data: ${JSON.stringify(ev)}\n\n`;
  for (const res of subscribers) {
    try { res.write(payload); }
    catch { subscribers.delete(res); }
  }
}

function subscribe(res) {
  subscribers.add(res);
  // Keepalive comment every 25s so reverse proxies / OS keep the TCP socket
  // open during long idle periods. Comments (lines starting with `:`) are
  // ignored by the EventSource parser.
  const keepalive = setInterval(() => {
    try { res.write(': keepalive\n\n'); }
    catch { /* socket dead — close handler will clean up */ }
  }, 25000);
  res.on('close', () => {
    clearInterval(keepalive);
    subscribers.delete(res);
  });
}

function since(seq) {
  const cutoff = Number(seq) || 0;
  return buffer.filter((e) => e.seq > cutoff);
}

function latestSeq() {
  return nextSeq - 1;
}

module.exports = { record, since, latestSeq, subscribe };
