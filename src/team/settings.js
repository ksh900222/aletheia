const fs = require('fs');
const path = require('path');

const SETTINGS_PATH = process.env.TEAM_SETTINGS_JSON
  ? path.resolve(process.env.TEAM_SETTINGS_JSON)
  : path.resolve(__dirname, '..', '..', 'data', 'team_settings.json');

const DEFAULTS = {
  self: { name: '', port: 3000 },
  sharedToken: '',
  syncIntervalSec: 60,
  requestTimeoutMs: 5000,
  peerBroadcast: { enabled: true, debounceMs: 500 },
};

let cached = null;

function load() {
  try {
    const text = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    const json = JSON.parse(text);
    cached = {
      ...DEFAULTS,
      ...json,
      self: { ...DEFAULTS.self, ...(json.self || {}) },
      peerBroadcast: { ...DEFAULTS.peerBroadcast, ...(json.peerBroadcast || {}) },
    };
  } catch (e) {
    if (e.code === 'ENOENT') {
      console.warn('[team] data/team_settings.json 없음 — 기본값 사용');
    } else {
      console.warn('[team] team_settings.json 로드 실패 — 기본값 사용:', e.message);
    }
    cached = JSON.parse(JSON.stringify(DEFAULTS));
  }
  if (process.env.TEAM_SELF_NAME) cached.self.name = process.env.TEAM_SELF_NAME;
  if (process.env.TEAM_SELF_PORT) cached.self.port = Number(process.env.TEAM_SELF_PORT);
  return cached;
}

function get() {
  if (!cached) load();
  return cached;
}

module.exports = { load, get, SETTINGS_PATH };
