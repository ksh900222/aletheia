// Korean holiday cache + daily refresh.
//
// The server keeps `data/holidays.json` with two lists:
//   auto    — fetched from a public API (date.nager.at by default)
//   manual  — user-added overrides (임시공휴일 / 행사 등)
//
// Combined set is served via GET /api/holidays. The client unions it with its
// own hardcoded fallback, so the chart still works even when the network is
// unavailable.
//
// Refresh policy: once at server startup, then every 24 hours. POST
// /api/holidays/refresh forces an immediate refresh.

const fs = require('fs');
const path = require('path');

const FILE = path.resolve(__dirname, '..', 'data', 'holidays.json');

// Two sources, unioned for robustness:
//   - date.nager.at: clean JSON, fast, but slow to pick up newly-declared
//     임시공휴일.
//   - Google Calendar's "대한민국의 휴일" ICS feed: ~275 events spanning
//     several years including past + future, refreshed by Google when
//     temporary holidays are announced (예: 2025-06-03 대통령선거 등).
const NAGER_URL = (year) =>
  `https://date.nager.at/api/v3/PublicHolidays/${year}/KR`;
const GOOGLE_ICS_URL =
  'https://calendar.google.com/calendar/ical/ko.south_korea%23holiday%40group.v.calendar.google.com/public/basic.ics';

const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;

const cache = {
  auto: { lastFetched: null, source: null, dates: [] },
  manual: [],
};

function load() {
  try {
    if (!fs.existsSync(FILE)) return;
    const raw = fs.readFileSync(FILE, 'utf8');
    const data = JSON.parse(raw);
    if (data.auto && Array.isArray(data.auto.dates)) cache.auto = data.auto;
    if (Array.isArray(data.manual)) cache.manual = data.manual;
  } catch (e) {
    console.error('[holidays] load failed:', e.message);
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify(cache, null, 2));
  } catch (e) {
    console.error('[holidays] save failed:', e.message);
  }
}

async function fetchYearKR_nager(year) {
  const res = await fetch(NAGER_URL(year), { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  // res.json() throws SyntaxError on malformed body. Surface that explicitly
  // so the refresh log distinguishes "bad JSON" from "network failed" — the
  // outer catch keeps refresh going for other years/sources either way.
  let arr;
  try {
    arr = await res.json();
  } catch (e) {
    throw new Error(`malformed JSON: ${e.message}`);
  }
  if (!Array.isArray(arr)) throw new Error('unexpected response');
  return arr.map((h) => h.date).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
}

// Pull the public Google Calendar ICS feed of South Korean holidays. The feed
// includes 임시공휴일 (예: 2025-06-03 대통령선거) but it ALSO mixes in
// commemorative days (어버이날, 스승의날, 크리스마스 이브) that are not
// public holidays. Each VEVENT carries DESCRIPTION:공휴일 (real holiday) vs
// DESCRIPTION:기념일\n... (commemorative). We only keep `공휴일` entries.
async function fetchAllKR_googleICS(yearWindow) {
  const res = await fetch(GOOGLE_ICS_URL, { redirect: 'follow' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  const dates = new Set();
  // Walk VEVENT blocks. Split by BEGIN:VEVENT — first chunk is the calendar
  // header which we ignore.
  const blocks = text.split(/BEGIN:VEVENT/i).slice(1);
  for (const block of blocks) {
    const dtMatch = /DTSTART(?:;VALUE=DATE)?:(\d{8})\b/.exec(block);
    if (!dtMatch) continue;
    const descMatch = /\nDESCRIPTION:([^\r\n]*)/.exec(block);
    const desc = descMatch ? descMatch[1].trim() : '';
    // Only keep real public holidays. The Google feed labels commemorative
    // days with "기념일" and includes a hint about hiding them in settings.
    // Note: `\b` (word boundary) doesn't work with Korean characters in JS
    // regex, so plain prefix match here.
    if (!/^공휴일/.test(desc)) continue;
    const s = dtMatch[1];
    const yyyy = Number(s.slice(0, 4));
    if (yearWindow && (yyyy < yearWindow[0] || yyyy > yearWindow[1])) continue;
    dates.add(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}`);
  }
  return dates;
}

async function refresh() {
  const yearNow = new Date().getUTCFullYear();
  const years = [yearNow - 1, yearNow, yearNow + 1];
  const fetched = new Set();
  const perSource = { nager: 0, google: 0 };

  // Source 1: date.nager.at (per-year endpoint).
  for (const y of years) {
    try {
      const dates = await fetchYearKR_nager(y);
      for (const d of dates) fetched.add(d);
      perSource.nager += dates.length;
    } catch (e) {
      console.error(`[holidays] nager fetch ${y} failed: ${e.message}`);
    }
  }

  // Source 2: Google Calendar ICS (single fetch, restricted to year window).
  try {
    const dates = await fetchAllKR_googleICS([yearNow - 1, yearNow + 1]);
    for (const d of dates) fetched.add(d);
    perSource.google = dates.size;
  } catch (e) {
    console.error(`[holidays] google ICS fetch failed: ${e.message}`);
  }

  if (fetched.size === 0) {
    console.warn('[holidays] all sources failed; keeping existing cache.');
    return cache;
  }
  cache.auto = {
    lastFetched: new Date().toISOString(),
    source: 'date.nager.at + google calendar ICS',
    dates: [...fetched].sort(),
  };
  save();
  console.log(
    `[holidays] refreshed: ${fetched.size} unique dates ` +
    `(nager=${perSource.nager}, google=${perSource.google}).`
  );
  return cache;
}

let intervalHandle = null;
function scheduleDaily() {
  // Initial refresh runs in background — server start should not block on it.
  refresh().catch((e) => console.error('[holidays] initial refresh:', e.message));
  if (intervalHandle) clearInterval(intervalHandle);
  intervalHandle = setInterval(() => {
    refresh().catch((e) => console.error('[holidays] scheduled refresh:', e.message));
  }, REFRESH_INTERVAL_MS);
  // Don't keep the event loop alive just for this timer.
  if (intervalHandle.unref) intervalHandle.unref();
}

function getMerged() {
  const set = new Set([...(cache.auto.dates || []), ...(cache.manual || [])]);
  return {
    dates: [...set].sort(),
    auto: cache.auto,
    manual: cache.manual,
  };
}

module.exports = { load, save, refresh, scheduleDaily, getMerged };
