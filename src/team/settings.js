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

// First-boot helper: if team_settings.json is missing (typical after pulling
// a checkout where the file is gitignored — every developer/PC has to bring
// their own), copy the example template so the operator has something to
// edit. Otherwise the server boots with empty self.name / sharedToken and
// every cross-peer call fails silently.
function maybeBootstrapFromExample() {
  if (fs.existsSync(SETTINGS_PATH)) return false;
  const examplePath = path.join(path.dirname(SETTINGS_PATH), 'team_settings.example.json');
  if (!fs.existsSync(examplePath)) return false;
  try {
    fs.copyFileSync(examplePath, SETTINGS_PATH);
    console.warn(`[team] team_settings.json 없어 example 로부터 자동 생성: ${SETTINGS_PATH}`);
    console.warn('[team] sharedToken / self.name 을 자기 환경에 맞게 수정하세요 (또는 UI에서 본인 이름 변경).');
    return true;
  } catch (e) {
    console.warn('[team] example 복사 실패 — 기본값으로 시작:', e.message);
    return false;
  }
}

function load() {
  maybeBootstrapFromExample();
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

// Persist the in-memory cached settings back to team_settings.json. Called
// after UI-driven mutations (e.g. self.name rename via /api/team/self-rename)
// so the change survives restart without the user having to edit JSON.
function save() {
  if (!cached) return;
  const tmp = SETTINGS_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(cached, null, 2) + '\n', 'utf-8');
  fs.renameSync(tmp, SETTINGS_PATH);
}

// Update self.name in memory and persist to disk. Returns the new name.
function setSelfName(name) {
  if (!cached) load();
  cached.self.name = String(name).trim();
  save();
  return cached.self.name;
}

// Update the team-wide pre-shared token (memory + disk). Lets the operator
// rotate it from the UI without ever opening team_settings.json. Token is
// not trimmed via .trim() because leading/trailing whitespace in a secret
// could be intentional, but we do require a non-empty string at the route.
function setSharedToken(token) {
  if (!cached) load();
  cached.sharedToken = String(token);
  save();
  return cached.sharedToken;
}

module.exports = { load, get, save, setSelfName, setSharedToken, SETTINGS_PATH };
