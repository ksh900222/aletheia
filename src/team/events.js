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

function record(kind, detail) {
  const ev = {
    seq: nextSeq++,
    ts: new Date().toISOString(),
    kind,
    detail: detail || {},
  };
  buffer.push(ev);
  while (buffer.length > MAX) buffer.shift();
}

function since(seq) {
  const cutoff = Number(seq) || 0;
  return buffer.filter((e) => e.seq > cutoff);
}

function latestSeq() {
  return nextSeq - 1;
}

module.exports = { record, since, latestSeq };
