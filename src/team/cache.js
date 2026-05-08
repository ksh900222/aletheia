let mode = 'OFF';
let lastSyncAt = null;
const peerStates = new Map();

function setMode(m) {
  mode = m;
  if (m === 'OFF') {
    peerStates.clear();
    lastSyncAt = null;
  }
}

function getMode() { return mode; }
function setSyncAt(ts) { lastSyncAt = ts; }
function getLastSyncAt() { return lastSyncAt; }

function setPeerState(name, patch) {
  const cur = peerStates.get(name) || {};
  peerStates.set(name, { ...cur, ...patch });
}

function getPeerState(name) { return peerStates.get(name); }

function getAllPeerStates() {
  return Array.from(peerStates.entries()).map(([name, s]) => ({ name, ...s }));
}

function removePeer(name) { peerStates.delete(name); }

function knownNames() { return new Set(peerStates.keys()); }

module.exports = {
  setMode, getMode,
  setSyncAt, getLastSyncAt,
  setPeerState, getPeerState, getAllPeerStates, removePeer, knownNames,
};
