const state = {
  categories: [],
  schedules: [],          // schedules of selected category
  allSchedules: [],       // every schedule (for dep selectors / labels)
  dependencies: [],       // every dependency (filtered for display)
  reports: [],            // reports tagged with selected category
  selectedCategoryId: null,
  editingReportId: null,  // when modal is in edit mode
  scheduleView: 'list',   // 'list' | 'gantt'
  scheduleQuery: '',      // free-text filter for schedule title
  scope: 'category',      // 'category' | 'all' | 'all-reports'
  expandConnected: false, // category mode: include schedules connected via dependencies
  showArrows: false,      // overlay dependency arrows on the Gantt
  chainSort: false,       // chain-first sort: keep strong-edge chains adjacent
  dateFocus: null,        // YYYY-MM-DD when a header date cell is clicked (sticky)
  depDraft: null,         // {scheduleId, linkType} when first bar is selected (Shift/Alt+click)
  undoStack: [],          // [{kind, ...}] — see performUndo for record shapes
  redoStack: [],          // mirror; cleared whenever a new tracked action happens
  reportQuery: '',        // free-text filter for reports (per-category panel)
  allReports: [],         // all reports across categories (loaded for all-reports view)
  allReportsQuery: '',    // search query in all-reports view
  allReportsDateFrom: '', // YYYY-MM-DD inclusive lower bound for all-reports view (empty = no bound)
  allReportsDateTo: '',   // YYYY-MM-DD inclusive upper bound for all-reports view (empty = no bound)
  allReportsBySchedule: false, // when true, group within each category by schedule first, then date
  pendingAttachments: [], // [{ kind:'upload', file, display_name } | { kind:'local_path', path, display_name }]
  reportLinkedSchedule: null, // {schedule, date} when modal was opened from a Gantt bar click
  canWrite: true,         // IP-based authorization; flipped to false at boot if /api/auth/me says so
  clientIp: null,         // remote IP as the server saw us — shown in the read-only banner
};

const $ = (sel) => document.querySelector(sel);
const els = {
  categoryList: $('#category-list'),
  emptyState: $('#empty-state'),
  categoryView: $('#category-view'),
  catTitle: $('#cat-title'),
  catDesc: $('#cat-desc'),
  scheduleRows: $('#schedule-rows'),
  scheduleTable: $('#schedule-table'),
  scheduleGantt: $('#schedule-gantt'),
  scheduleSearch: $('#schedule-search'),
  viewBtns: document.querySelectorAll('.view-btn'),
  dependencyRows: $('#dependency-rows'),
  addCategoryBtn: $('#add-category-btn'),
  editCategoryBtn: $('#edit-category-btn'),
  deleteCategoryBtn: $('#delete-category-btn'),
  addScheduleBtn: $('#add-schedule-btn'),
  addDependencyBtn: $('#add-dependency-btn'),
  categoryModal: $('#category-modal'),
  categoryModalTitle: $('#category-modal-title'),
  categoryForm: $('#category-form'),
  scheduleModal: $('#schedule-modal'),
  scheduleModalTitle: $('#schedule-modal-title'),
  scheduleForm: $('#schedule-form'),
  dependencyModal: $('#dependency-modal'),
  dependencyModalTitle: $('#dependency-modal-title'),
  dependencyForm: $('#dependency-form'),
  dependencyCreateModal: $('#dependency-create-modal'),
  dependencyCreateForm: $('#dependency-create-form'),
  allViewBtn: $('#all-view-btn'),
  allReportsBtn: $('#all-reports-btn'),
  ganttConnBanner: $('#gantt-conn-banner'),
  ganttConnBannerText: $('#gantt-conn-banner-text'),
  ganttConnCancel: $('#gantt-conn-cancel'),
  expandConnectedBtn: $('#expand-connected-btn'),
  showArrowsBtn: $('#show-arrows-btn'),
  chainSortBtn: $('#chain-sort-btn'),
  scheduleSectionTitle: $('#schedule-section-title'),
  reportSearch: $('#report-search'),
  allReportsView: $('#all-reports-view'),
  allReportsContent: $('#all-reports-content'),
  allReportsSearch: $('#all-reports-search'),
  allReportsByScheduleBtn: $('#all-reports-by-schedule-btn'),
  allReportsSummary: $('#all-reports-summary'),
  allReportsDateFrom: $('#all-reports-date-from'),
  allReportsDateTo: $('#all-reports-date-to'),
  allReportsDateClear: $('#all-reports-date-clear'),
  allReportsOwner: $('#all-reports-owner'),
  allReportsOwnerWrap: $('#all-reports-owner-wrap'),
  // Reports
  reportRows: $('#report-rows'),
  reportModal: $('#report-modal'),
  reportModalTitle: $('#report-modal-title'),
  reportForm: $('#report-form'),
  reportMetaBox: $('#report-meta-box'),
  reportCategoryChecks: $('#report-category-checks'),
  attachmentsSection: $('#attachments-section'),
  attachmentList: $('#attachment-list'),
  attachmentFileInput: $('#attachment-file-input'),
};

const READ_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

async function api(method, url, body) {
  // Short-circuit write attempts when the client is known to lack write
  // permission. The server enforces this regardless, but doing it here too
  // turns a confusing "HTTP 403" alert into a clear Korean message and
  // prevents needless network traffic.
  if (!state.canWrite && !READ_METHODS.has(method.toUpperCase())) {
    const err = new Error('쓰기 권한이 없습니다 (허용된 IP에서만 가능).');
    err.status = 403;
    throw err;
  }
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // If the server tells us we're not on the write allowlist, lock the UI
    // into read-only mode so subsequent clicks get a friendly message
    // instead of repeating round-trips.
    if (res.status === 403 && data && data.error === 'forbidden_write_from_ip') {
      applyReadOnlyMode(data.ip);
      const err = new Error('쓰기 권한이 없습니다 (허용된 IP에서만 가능).');
      err.status = 403;
      err.body = data;
      throw err;
    }
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function applyReadOnlyMode(ip) {
  if (!state.canWrite && document.body.classList.contains('readonly')) return;
  state.canWrite = false;
  if (ip) state.clientIp = ip;
  document.body.classList.add('readonly');
  let banner = document.getElementById('readonly-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'readonly-banner';
    banner.className = 'readonly-banner';
    document.body.prepend(banner);
  }
  const ipText = state.clientIp ? ` (현재 IP: ${state.clientIp})` : '';
  banner.textContent = `읽기 전용 모드 — 이 IP에서는 추가/수정/삭제가 불가능합니다.${ipText}`;
}

// Boot-time IP check. The server is the source of truth; we just mirror its
// answer into the UI so write affordances can be hidden up front. Any error
// here is non-fatal — the server will still enforce 403 on actual writes.
(async () => {
  try {
    const me = await fetch('/api/auth/me').then((r) => r.json());
    state.clientIp = me.ip || null;
    if (!me.canWrite) applyReadOnlyMode(me.ip);
  } catch {
    // Network hiccup at boot: leave canWrite=true; the server still enforces.
  }
})();

// Inclusive day count: 5/3 ~ 5/5 → 3 days.
function daysBetweenInclusive(startIso, endIso) {
  if (!startIso || !endIso) return null;
  const s = new Date(`${startIso}T00:00:00Z`).getTime();
  const e = new Date(`${endIso}T00:00:00Z`).getTime();
  if (Number.isNaN(s) || Number.isNaN(e) || e < s) return null;
  return Math.round((e - s) / 86400000) + 1;
}
function addDaysIso(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (m) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[m]);
}

// Pick black or white text for a colored background so the user-defined
// category color stays readable regardless of how light/dark they made it.
// WCAG-style perceived luminance: yellow/cyan need black, navy/maroon need
// white. Threshold chosen empirically; categories close to medium gray
// (~#808080) tip toward white because the surrounding theme is dark.
function inkOn(bgHex) {
  const m = String(bgHex || '').match(/^#?([0-9a-f]{6})$/i);
  if (!m) return '#fff';
  const n = m[1];
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  return lum >= 160 ? '#1a1a1a' : '#fff';
}

// Escape HTML and turn http(s)/file URLs into clickable <a> tags. Used for
// report body previews so a pasted URL becomes a hyperlink instead of inert
// text. Trailing punctuation that's commonly adjacent to but not part of a
// URL (.,;:!?)]}) is stripped from the link and re-emitted as plain text.
function linkifyHtml(s) {
  const text = String(s ?? '');
  const urlRe = /\b(?:https?|file):\/\/[^\s<>'"`]+/g;
  let out = '';
  let last = 0;
  let m;
  while ((m = urlRe.exec(text)) !== null) {
    out += escapeHtml(text.slice(last, m.index));
    let url = m[0];
    let trail = '';
    while (/[.,;:!?)\]}]$/.test(url)) {
      trail = url.slice(-1) + trail;
      url = url.slice(0, -1);
    }
    const safe = escapeHtml(url);
    out += `<a href="${safe}" target="_blank" rel="noopener">${safe}</a>`;
    out += escapeHtml(trail);
    last = m.index + m[0].length;
  }
  out += escapeHtml(text.slice(last));
  return out;
}

function renderCategories() {
  els.categoryList.innerHTML = '';
  els.allViewBtn.classList.toggle('active', state.scope === 'all');
  els.allReportsBtn.classList.toggle('active', state.scope === 'all-reports');
  if (state.categories.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '아직 카테고리가 없습니다';
    els.categoryList.appendChild(li);
    return;
  }
  for (const c of state.categories) {
    const li = document.createElement('li');
    if (state.scope === 'category' && c.id === state.selectedCategoryId) {
      li.classList.add('active');
    }
    const swatch = document.createElement('span');
    swatch.className = 'swatch';
    if (c.color) swatch.style.background = c.color;
    const name = document.createElement('span');
    name.textContent = c.name;
    li.append(swatch, name);
    li.addEventListener('click', () => selectCategory(c.id));
    els.categoryList.appendChild(li);
  }

  // Team-mode: list peer categories below own ones, grouped by owner. They are
  // labelled with "| <owner>" suffix and not clickable (read-only group; the
  // integrated views live in 전체 간트 / 전체 리포트).
  if (teamOn() && state.team.merged.categories.length > 0) {
    const divider = document.createElement('li');
    divider.className = 'muted team-cat-divider';
    divider.textContent = '── 팀원 카테고리 ──';
    divider.style.cursor = 'default';
    divider.style.pointerEvents = 'none';
    divider.style.fontSize = '11px';
    divider.style.paddingTop = '8px';
    els.categoryList.appendChild(divider);
    for (const c of state.team.merged.categories) {
      const li = document.createElement('li');
      li.classList.add('team-readonly');
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      if (c.color) swatch.style.background = c.color;
      const wrapper = document.createElement('span');
      wrapper.style.display = 'flex';
      wrapper.style.alignItems = 'center';
      wrapper.style.justifyContent = 'space-between';
      wrapper.style.flex = '1';
      const name = document.createElement('span');
      name.textContent = c.name;
      wrapper.appendChild(name);
      wrapper.insertAdjacentHTML('beforeend', teamOwnerSuffix(c.owner));
      li.append(swatch, wrapper);
      els.categoryList.appendChild(li);
    }
  }
}

function renderCategoryView() {
  // All-reports view: hide gantt/category UI, show grouped reports.
  if (state.scope === 'all-reports') {
    els.emptyState.classList.add('hidden');
    els.categoryView.classList.add('hidden');
    els.allReportsView.classList.remove('hidden');
    document.body.classList.remove('scope-all');
    document.body.classList.add('scope-all-reports');
    renderAllReportsView();
    return;
  }
  els.allReportsView.classList.add('hidden');
  document.body.classList.remove('scope-all-reports');

  // All-view: show every schedule, hide category-specific UI.
  if (state.scope === 'all') {
    els.emptyState.classList.add('hidden');
    els.categoryView.classList.remove('hidden');
    document.body.classList.add('scope-all');
    els.catTitle.textContent = '전체 간트';
    els.catDesc.textContent = `모든 카테고리의 스케줄 (${state.allSchedules.length}건)`;
    els.scheduleSectionTitle.textContent = '전체 스케줄';
    renderSchedules();
    return;
  }

  document.body.classList.remove('scope-all');
  const c = state.categories.find((x) => x.id === state.selectedCategoryId);
  if (!c) {
    els.emptyState.classList.remove('hidden');
    els.categoryView.classList.add('hidden');
    return;
  }
  els.emptyState.classList.add('hidden');
  els.categoryView.classList.remove('hidden');
  els.catTitle.textContent = c.name;
  els.catDesc.textContent = c.description || '';
  els.scheduleSectionTitle.textContent = '스케줄';
  renderSchedules();
  renderDependencies();
  renderReports();
}

// Build an undirected graph where two schedules are connected iff there is any
// dependency edge (strong or weak) that links them — directly schedule↔schedule,
// or via a category endpoint that contains either of them.
function buildConnectedGraph() {
  const graph = new Map();
  const addEdge = (a, b) => {
    if (a === b) return;
    if (!graph.has(a)) graph.set(a, new Set());
    if (!graph.has(b)) graph.set(b, new Set());
    graph.get(a).add(b);
    graph.get(b).add(a);
  };
  const byCat = new Map();
  for (const s of state.allSchedules) {
    if (!byCat.has(s.category_id)) byCat.set(s.category_id, []);
    byCat.get(s.category_id).push(s.id);
  }
  const idsForRef = (type, id) => {
    if (type === 'schedule') return [id];
    return byCat.get(id) || [];
  };
  for (const d of state.dependencies) {
    const A = idsForRef(d.pred_type, d.pred_id);
    const B = idsForRef(d.succ_type, d.succ_id);
    for (const a of A) for (const b of B) addEdge(a, b);
  }
  return graph;
}

function transitivelyConnected(rootIds) {
  const graph = buildConnectedGraph();
  const visited = new Set(rootIds);
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.shift();
    const ns = graph.get(id);
    if (!ns) continue;
    for (const n of ns) {
      if (!visited.has(n)) {
        visited.add(n);
        queue.push(n);
      }
    }
  }
  return visited;
}

// Resolve which schedules to show given current scope/expand/query.
// Returns { schedules, baseIdSet } where baseIdSet contains the originally
// selected schedules (the "primary" rows; the rest are connected extras).
function effectiveSchedules() {
  let base;
  let baseIdSet;
  if (state.scope === 'all') {
    base = state.allSchedules.slice();
    baseIdSet = new Set(base.map((s) => s.id));
    // Team mode: append peer schedules. They keep numeric ids but carry an
    // `owner` field so renderers and lookups can distinguish them.
    if (teamOn() && state.team.merged.schedules.length > 0) {
      base = base.concat(state.team.merged.schedules);
    }
  } else {
    base = state.schedules;
    baseIdSet = new Set(base.map((s) => s.id));
    if (state.expandConnected && base.length > 0) {
      const ids = transitivelyConnected(Array.from(baseIdSet));
      base = state.allSchedules.filter((s) => ids.has(s.id));
    }
  }
  const q = state.scheduleQuery.trim().toLowerCase();
  if (q) {
    base = base.filter((s) => (s.title || '').toLowerCase().includes(q));
  }
  return { schedules: base, baseIdSet };
}

// Look up a category for a schedule, choosing the right pool based on whether
// the schedule belongs to a team peer or to the current user.
function findCategoryForSchedule(s) {
  if (s.owner) {
    return state.team.merged.categories.find(
      (c) => c.id === s.category_id && c.owner === s.owner
    );
  }
  return state.categories.find((c) => c.id === s.category_id);
}

// Composite key uniquely identifies a schedule across own + team space. Own
// schedules use empty owner; team schedules carry the peer's display name.
function scheduleKey(s) { return `${s.owner || ''}:${s.id}`; }
function depEndpointKey(owner, id) { return `${owner || ''}:${id}`; }

function filteredSchedules() {
  return effectiveSchedules().schedules;
}

function renderSchedules() {
  // Update visibility based on viewMode.
  if (state.scheduleView === 'gantt') {
    els.scheduleTable.classList.add('hidden');
    els.scheduleGantt.classList.remove('hidden');
    renderGantt();
    return;
  }
  els.scheduleTable.classList.remove('hidden');
  els.scheduleGantt.classList.add('hidden');

  els.scheduleRows.innerHTML = '';
  const { schedules: visible, baseIdSet } = effectiveSchedules();
  if (visible.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = state.scope === 'all' ? 10 : 9;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.style.padding = '20px';
    td.textContent =
      state.scope === 'all'
        ? '아직 스케줄이 없습니다.'
        : (state.schedules.length === 0
          ? '스케줄이 없습니다. "+ 스케줄 추가"로 만들어보세요.'
          : '검색 결과가 없습니다.');
    tr.appendChild(td);
    els.scheduleRows.appendChild(tr);
    return;
  }
  for (const s of visible) {
    const isTeam = !!s.owner;
    const slack = s.slack_days || 0;
    const slackHtml = slack > 0
      ? `<span class="slack-pill">+${slack}일</span>`
      : `<span class="slack-pill zero">—</span>`;
    const planShifted = s.actual_start !== s.planned_start || s.actual_end !== s.planned_end;
    const days = daysBetweenInclusive(s.planned_start, s.planned_end);
    const cat = findCategoryForSchedule(s);
    const catBg = (cat && cat.color) || '#c9a55a';
    const catCell = `<td class="all-view-only"><span class="cat-tag" style="background:${catBg}; color:${inkOn(catBg)};">${escapeHtml((cat && cat.name) || '?')}</span></td>`;
    const isExtra = !isTeam && !baseIdSet.has(s.id);
    const tr = document.createElement('tr');
    if (isExtra) tr.style.opacity = '0.85';
    if (isTeam) tr.classList.add('team-readonly');
    const titleHtml = isTeam
      ? `${escapeHtml(s.title)}${teamOwnerSuffix(s.owner)}`
      : `${escapeHtml(s.title)}${isExtra ? ' <span class="muted" title="연결된 항목">·연결</span>' : ''}`;
    const statusCell = isTeam
      ? `<td><span class="status-pill ${s.status}">${s.status}</span></td>`
      : `<td><span class="status-pill ${s.status}" data-action="cycle-status" data-id="${s.id}" role="button" title="클릭하여 다음 상태로 변경">${s.status}</span></td>`;
    const actionsCell = isTeam
      ? `<td class="actions"></td>`
      : `<td class="actions">
        <button class="btn" data-action="edit-schedule" data-id="${s.id}">편집</button>
        <button class="btn btn-danger" data-action="delete-schedule" data-id="${s.id}">삭제</button>
      </td>`;
    tr.innerHTML = `
      <td>${titleHtml}</td>
      ${catCell}
      <td>${s.planned_start}</td>
      <td>${s.planned_end}</td>
      <td>${days != null ? `${days}일` : ''}</td>
      <td>${planShifted ? `<b>${s.actual_start}</b>` : s.actual_start || ''}</td>
      <td>${planShifted ? `<b>${s.actual_end}</b>` : s.actual_end || ''}</td>
      <td>${slackHtml}</td>
      ${statusCell}
      ${actionsCell}
    `;
    els.scheduleRows.appendChild(tr);
  }
}

// Status cycle: 사용자 지정 순서. 한 번 클릭하면 다음으로 진행.
const STATUS_CYCLE = ['in_progress', 'pending', 'blocked', 'done', 'not_started'];
function nextStatusOf(s) {
  const idx = STATUS_CYCLE.indexOf(s);
  if (idx === -1) return STATUS_CYCLE[0];
  return STATUS_CYCLE[(idx + 1) % STATUS_CYCLE.length];
}

// ---------- Gantt view ----------
const GANTT_DAY_WIDTH = 32;

// 대한민국 법정공휴일 (오프라인 fallback). 서버의 /api/holidays 가
// 네트워크 fetch 로 최신 정보를 매일 갱신해 SERVER_HOLIDAYS 에 들어옴.
// 둘의 합집합을 isHoliday() 가 사용하므로, 서버 fetch 가 실패해도
// 아래 하드코딩 값은 안전망 역할.
const KOREAN_HOLIDAYS = new Set([
  // 2025
  '2025-01-01', // 신정
  '2025-01-28', '2025-01-29', '2025-01-30', // 설날 연휴
  '2025-03-01', // 삼일절 (토)
  '2025-03-03', // 삼일절 대체공휴일
  '2025-05-05', // 어린이날 + 부처님오신날(음력 4/8)
  '2025-05-06', // 어린이날 대체공휴일 (부처님오신날과 겹침)
  '2025-06-06', // 현충일
  '2025-08-15', // 광복절
  '2025-10-03', // 개천절
  '2025-10-05', '2025-10-06', '2025-10-07', // 추석 연휴 (10/6 = 추석)
  '2025-10-08', // 추석 대체공휴일
  '2025-10-09', // 한글날
  '2025-12-25',
  // 2026
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18', // 설날 연휴 (2/17 = 설날)
  '2026-03-01', // 삼일절 (일)
  '2026-03-02', // 삼일절 대체공휴일
  '2026-05-05', // 어린이날
  '2026-05-24', // 부처님오신날 (음력 4/8)
  '2026-06-06', // 현충일 (토)
  '2026-08-15', // 광복절 (토)
  '2026-08-17', // 광복절 대체공휴일
  '2026-09-24', '2026-09-25', '2026-09-26', // 추석 연휴 (9/25 = 추석)
  '2026-10-03', // 개천절 (토)
  '2026-10-05', // 개천절 대체공휴일
  '2026-10-09', // 한글날 (금)
  '2026-12-25',
  // 2027
  '2027-01-01',
  '2027-02-06', '2027-02-07', '2027-02-08', // 설날 연휴 (2/7 = 설날, 일)
  '2027-02-09', // 설날 대체공휴일
  '2027-03-01', // 삼일절 (월)
  '2027-05-05', // 어린이날
  '2027-05-13', // 부처님오신날
  '2027-06-06', // 현충일 (일)
  '2027-06-07', // 현충일 대체공휴일
  '2027-08-15', // 광복절 (일)
  '2027-08-16', // 광복절 대체공휴일
  '2027-09-14', '2027-09-15', '2027-09-16', // 추석 연휴
  '2027-10-03', // 개천절 (일)
  '2027-10-04', // 개천절 대체공휴일
  '2027-10-09', // 한글날 (토)
  '2027-12-25',
]);

// Holidays fetched from the server (refreshed daily). Includes 임시공휴일
// (예: 총선) when the upstream API has them, plus any user-added overrides
// in data/holidays.json (manual list).
let SERVER_HOLIDAYS = new Set();

async function loadServerHolidays() {
  try {
    const data = await api('GET', '/api/holidays');
    SERVER_HOLIDAYS = new Set(data.dates || []);
  } catch (e) {
    SERVER_HOLIDAYS = new Set();
  }
}

function isHoliday(date) {
  return KOREAN_HOLIDAYS.has(date) || SERVER_HOLIDAYS.has(date);
}

// Reorder schedules for the Gantt chart:
//   1) Find connected components in the strong-edge UNDIRECTED graph.
//      → 강한 연결로 묶인 항목들이 시각적으로 인접하게 됨 (chain grouping).
//   2) Within each component, run Kahn's topo sort over the DIRECTED strong
//      edges → 선행이 위, 후행이 아래.
//   3) Sort components by min(planned_start) so 시작이 빠른 묶음이 위로.
//      싱글톤(고립 항목)도 같은 키로 묶음 사이에 자연스럽게 끼움.
// Weak edges 는 방향성·연결성 모두에서 무시 (non-directional sibling marker).
function topoSortForGantt(visible) {
  // Use composite (owner, id) keys so own and team schedules sharing the same
  // numeric id don't collide and both participate in chain sort.
  const ids = visible.map((s) => scheduleKey(s));
  const idSet = new Set(ids);
  const byId = new Map(visible.map((s) => [scheduleKey(s), s]));
  const idsForRef = (type, id, owner) => {
    if (type === 'schedule') return [depEndpointKey(owner, id)];
    if (owner) {
      return state.team.merged.schedules
        .filter((s) => s.category_id === id && s.owner === owner)
        .map(scheduleKey);
    }
    return state.allSchedules
      .filter((s) => s.category_id === id)
      .map(scheduleKey);
  };

  // Adjacency maps (directed for topo, undirected for components).
  const directed = new Map();
  const undirected = new Map();
  for (const id of ids) {
    directed.set(id, new Set());
    undirected.set(id, new Set());
  }
  const allDeps = teamOn()
    ? state.dependencies.concat(state.team.merged.dependencies)
    : state.dependencies;
  for (const d of allDeps) {
    if (d.link_type !== 'strong') continue;
    const owner = d.owner || '';
    const ps = idsForRef(d.pred_type, d.pred_id, owner);
    const qs = idsForRef(d.succ_type, d.succ_id, owner);
    for (const p of ps) {
      if (!idSet.has(p)) continue;
      for (const q of qs) {
        if (!idSet.has(q) || p === q) continue;
        directed.get(p).add(q);
        undirected.get(p).add(q);
        undirected.get(q).add(p);
      }
    }
  }

  // BFS to find connected components in the undirected strong-edge graph.
  const compOf = new Map();
  let numComps = 0;
  for (const id of ids) {
    if (compOf.has(id)) continue;
    const queue = [id];
    compOf.set(id, numComps);
    while (queue.length) {
      const cur = queue.shift();
      for (const n of undirected.get(cur)) {
        if (!compOf.has(n)) {
          compOf.set(n, numComps);
          queue.push(n);
        }
      }
    }
    numComps++;
  }
  const componentMembers = Array.from({ length: numComps }, () => []);
  for (const id of ids) componentMembers[compOf.get(id)].push(id);

  // Topo-sort within each component.
  // Two modes:
  //   - chainSort OFF: FIFO Kahn (선행 위 / 후행 아래 보장만; 형제 분기는 입력 순).
  //   - chainSort ON : DFS-우선 선택 — 방금 빼낸 노드의 직속 후행 중 in-deg 0이
  //     된 것을 즉시 다음에 빼냄. 그 결과 strong-체인이 인접한 두 줄(또는
  //     연속된 줄)로 떨어진다. 분기/병합 지점에서는 planned_start 가 빠른
  //     것을 우선해 시간 흐름과 정렬을 맞춤.
  const startOf = (id) => {
    const s = byId.get(id);
    return (s && s.planned_start) || '9999-12-31';
  };
  const sortedComps = componentMembers.map((compIds) => {
    const subset = new Set(compIds);
    const indeg = new Map();
    for (const id of compIds) {
      let d = 0;
      // count predecessors that are inside this component
      for (const p of ids) {
        if (subset.has(p) && directed.get(p).has(id)) d++;
      }
      indeg.set(id, d);
    }
    const sorted = [];
    const enqueued = new Set();

    if (state.chainSort) {
      // Chain-first: maintain a "ready" pool of in-deg-0 nodes. Pick the one
      // that continues the most recently emitted node's chain whenever
      // possible; otherwise pick by earliest planned_start. This keeps a
      // pred → succ pair on adjacent rows even when many siblings feed a
      // shared successor.
      const ready = new Set(compIds.filter((id) => indeg.get(id) === 0));
      for (const id of ready) enqueued.add(id);
      let lastEmitted = null;
      while (ready.size) {
        let pick = null;
        if (lastEmitted != null) {
          // Prefer a direct successor of lastEmitted that's now ready.
          let bestStart = null;
          for (const nid of directed.get(lastEmitted)) {
            if (ready.has(nid)) {
              const sv = startOf(nid);
              if (bestStart == null || sv < bestStart) {
                bestStart = sv;
                pick = nid;
              }
            }
          }
        }
        if (pick == null) {
          // No chain continuation available — fall back to earliest start.
          let bestStart = null;
          for (const id of ready) {
            const sv = startOf(id);
            if (bestStart == null || sv < bestStart) {
              bestStart = sv;
              pick = id;
            }
          }
        }
        ready.delete(pick);
        sorted.push(pick);
        lastEmitted = pick;
        // Relax successors.
        for (const nid of directed.get(pick)) {
          const dnew = indeg.get(nid) - 1;
          indeg.set(nid, dnew);
          if (dnew === 0 && !enqueued.has(nid)) {
            enqueued.add(nid);
            ready.add(nid);
          }
        }
      }
    } else {
      // Default: FIFO Kahn, initial queue in original input order.
      const queue = compIds.filter((id) => indeg.get(id) === 0);
      for (const id of queue) enqueued.add(id);
      while (queue.length) {
        const id = queue.shift();
        sorted.push(id);
        // Decrement indeg of successors inside the component, preserving input order.
        const succsInOrder = compIds.filter((nid) => directed.get(id).has(nid));
        for (const nid of succsInOrder) {
          const dnew = indeg.get(nid) - 1;
          indeg.set(nid, dnew);
          if (dnew === 0 && !enqueued.has(nid)) {
            enqueued.add(nid);
            queue.push(nid);
          }
        }
      }
    }
    // Append any leftover (cycle safety; shouldn't happen).
    for (const id of compIds) {
      if (!enqueued.has(id)) sorted.push(id);
    }
    return sorted;
  });

  // Sort components by min planned_start so earlier-start chains/items rise to top.
  function compMinStart(compIds) {
    let min = null;
    for (const id of compIds) {
      const s = byId.get(id);
      if (s && s.planned_start) {
        if (min == null || s.planned_start < min) min = s.planned_start;
      }
    }
    return min || '9999-12-31';
  }
  const componentInfo = sortedComps.map((comp) => ({
    ids: comp,
    minStart: compMinStart(comp),
  }));
  componentInfo.sort((a, b) => a.minStart.localeCompare(b.minStart));

  return componentInfo.flatMap((c) => c.ids).map((id) => byId.get(id)).filter(Boolean);
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

const GANTT_ROW_H = 36;
const GANTT_BAR_TOP = 7;
const GANTT_BAR_H = 22;

// Header date click — sticky focus mode for daily-report entry.
//   - clicking a new date sets the focus
//   - clicking the same date clears it
//   - ESC also clears (handled in the global keydown listener)
// While focus is active, only bars whose [planned_start, planned_end] covers
// the focused date are highlighted; clicking such a bar opens the report
// modal instead of the schedule edit modal.
function onDateCellClick(date) {
  if (state.dateFocus === date) {
    state.dateFocus = null;
  } else {
    state.dateFocus = date;
  }
  renderSchedules();
}

function clearDateFocus() {
  if (state.dateFocus !== null) {
    state.dateFocus = null;
    renderSchedules();
  }
}

function renderGantt() {
  const container = els.scheduleGantt;
  container.innerHTML = '';
  container.style.setProperty('--day-w', GANTT_DAY_WIDTH + 'px');

  const result = effectiveSchedules();
  const baseIdSet = result.baseIdSet;
  // Gantt rows are reordered topologically: predecessors above successors,
  // isolated items at the bottom. Table view keeps date-based sort.
  const visible = topoSortForGantt(result.schedules);
  if (visible.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'gantt-empty';
    empty.textContent =
      state.schedules.length === 0
        ? '스케줄이 없습니다.'
        : '검색 결과가 없습니다.';
    container.appendChild(empty);
    return;
  }

  // Date range: prefer PLANNED dates so the chart axis stays stable when the
  // engine cascades actual dates around. Actuals are still considered (with a
  // narrow widening) so heavily-shifted bars don't fall off-screen.
  const plannedDates = [];
  for (const s of visible) {
    if (s.planned_start) plannedDates.push(s.planned_start);
    if (s.planned_end) plannedDates.push(s.planned_end);
  }
  plannedDates.push(todayIso());
  let minD = plannedDates.reduce((a, b) => (a < b ? a : b));
  let maxD = plannedDates.reduce((a, b) => (a > b ? a : b));
  for (const s of visible) {
    if (s.actual_start && s.actual_start < minD) minD = s.actual_start;
    if (s.actual_end && s.actual_end > maxD) maxD = s.actual_end;
  }
  const startDate = addDaysIso(minD, -3);
  const endDate = addDaysIso(maxD, 7);
  const dayCount = daysBetweenInclusive(startDate, endDate);
  const totalWidth = dayCount * GANTT_DAY_WIDTH;

  const grid = document.createElement('div');
  grid.className = 'gantt-grid';
  if (state.dateFocus) grid.classList.add('date-focus-active');
  grid.style.width = totalWidth + 'px';

  // Header row.
  const header = document.createElement('div');
  header.className = 'gantt-header';
  for (let i = 0; i < dayCount; i++) {
    const date = addDaysIso(startDate, i);
    const d = new Date(`${date}T00:00:00Z`);
    const dow = d.getUTCDay();
    const cell = document.createElement('div');
    cell.className = 'gantt-day';
    // 토요일 → light blue, 일요일/법정공휴일 → light red.
    if (dow === 6) cell.classList.add('saturday');
    if (dow === 0 || isHoliday(date)) cell.classList.add('holiday');
    if (date === todayIso()) cell.classList.add('today');
    cell.innerHTML = `<span class="month">${d.getUTCMonth() + 1}월</span>${d.getUTCDate()}일`;
    cell.dataset.date = date;
    if (state.dateFocus === date) cell.classList.add('date-selected');
    cell.addEventListener('click', () => onDateCellClick(date));
    header.appendChild(cell);
  }
  grid.appendChild(header);

  // Schedule rows.
  const positions = new Map(); // schedule.id → {left, right, midY}
  for (let i = 0; i < visible.length; i++) {
    const s = visible[i];
    const row = document.createElement('div');
    row.className = 'gantt-row';
    const track = document.createElement('div');
    track.className = 'gantt-row-track';
    track.style.width = totalWidth + 'px';

    // Bar position uses PLANNED dates — drag updates planned, so the bar stays
    // exactly where the user dropped it regardless of cascade. If the engine
    // shifted actual_* differently, we mark the bar as "shifted" and add a
    // secondary thin overlay at the actual range below.
    const startIdx = daysBetweenInclusive(startDate, s.planned_start) - 1;
    const endIdx = daysBetweenInclusive(startDate, s.planned_end) - 1;
    const barLeft = startIdx * GANTT_DAY_WIDTH;
    const barWidth = (endIdx - startIdx + 1) * GANTT_DAY_WIDTH;
    const planShifted =
      s.actual_start !== s.planned_start ||
      s.actual_end !== s.planned_end;

    const bar = document.createElement('div');
    bar.className = 'gantt-bar';
    if (planShifted) bar.classList.add('shifted');
    if (!baseIdSet.has(s.id)) bar.classList.add('connected-extra');
    // status-{value} drives the right-edge color (see .gantt-bar .resize-handle
    // rules in CSS) so each bar visibly shows done/in_progress/blocked/etc.
    if (s.status) bar.classList.add('status-' + s.status);
    // Sticky date focus: highlight bars whose planned range covers the date.
    if (
      state.dateFocus &&
      state.dateFocus >= s.planned_start &&
      state.dateFocus <= s.planned_end
    ) {
      bar.classList.add('date-focus-hit');
    }
    if (state.depDraft && state.depDraft.scheduleId === s.id) {
      bar.classList.add('dep-draft-first');
    }
    const cat = findCategoryForSchedule(s);
    if (cat && cat.color) bar.style.setProperty('--cat-color', cat.color);
    bar.style.left = barLeft + 'px';
    bar.style.width = barWidth + 'px';
    bar.dataset.scheduleId = String(s.id);
    if (s.owner) {
      bar.classList.add('team-readonly');
      bar.dataset.owner = s.owner;
      // team items aren't "extras" in the dependency sense — clear that styling
      bar.classList.remove('connected-extra');
    }
    const catLabel = cat ? `[${cat.name}] ` : '';
    const ownerForTitle = s.owner ? ` · 소유자: ${s.owner}` : '';
    bar.title = planShifted
      ? `${catLabel}${s.title}${ownerForTitle}\n계획: ${s.planned_start} ~ ${s.planned_end}\n실제(엔진 조정): ${s.actual_start} ~ ${s.actual_end}`
      : `${catLabel}${s.title}${ownerForTitle}\n${s.planned_start} ~ ${s.planned_end}`;
    const barLabelEl = document.createElement('span');
    barLabelEl.className = 'gantt-bar-label';
    if (s.owner) {
      barLabelEl.innerHTML =
        escapeHtml(catLabel + s.title) + teamOwnerSuffix(s.owner);
    } else {
      barLabelEl.textContent = catLabel + s.title;
    }
    bar.appendChild(barLabelEl);
    // After the bar is sized, check if the text actually overflows. If it
    // does, push the label outside so the full title stays readable instead
    // of being ellipsized to "[기타]...". `scrollWidth > clientWidth` is the
    // canonical overflow check — works for any bar width / label length, so
    // it replaces the older "barWidth < 36px" empirical threshold which
    // missed cases like a 2-day bar (~64px) holding an 8-character title.
    requestAnimationFrame(() => {
      if (barLabelEl.scrollWidth > barLabelEl.clientWidth) {
        bar.classList.add('bar-label-outside');
      }
    });

    // Optional thin overlay at actual range when shifted, so the user can see
    // where the engine would place this schedule.
    if (planShifted && s.actual_start && s.actual_end) {
      const aStart = daysBetweenInclusive(startDate, s.actual_start) - 1;
      const aEnd = daysBetweenInclusive(startDate, s.actual_end) - 1;
      const aLeft = aStart * GANTT_DAY_WIDTH;
      const aWidth = (aEnd - aStart + 1) * GANTT_DAY_WIDTH;
      const overlay = document.createElement('div');
      overlay.className = 'gantt-actual-overlay';
      overlay.style.left = aLeft + 'px';
      overlay.style.width = aWidth + 'px';
      overlay.title = `엔진 조정 실제: ${s.actual_start} ~ ${s.actual_end}`;
      track.appendChild(overlay);
    }

    const handle = document.createElement('div');
    handle.className = 'resize-handle';
    bar.appendChild(handle);

    track.appendChild(bar);
    row.appendChild(track);
    grid.appendChild(row);

    attachBarDragHandlers(bar, s);
    attachBarResizeHandlers(handle, bar, s);
    attachBarHoverHighlight(bar, s);
  }

  container.appendChild(grid);

  // Render dependency arrows after the grid is in DOM (need header height).
  if (state.showArrows) {
    const headerHeight = header.getBoundingClientRect().height || 24;
    // Bar positions match what we drew above (planned-based).
    for (let i = 0; i < visible.length; i++) {
      const s = visible[i];
      const startIdx = daysBetweenInclusive(startDate, s.planned_start) - 1;
      const endIdx = daysBetweenInclusive(startDate, s.planned_end) - 1;
      const left = startIdx * GANTT_DAY_WIDTH;
      const right = (endIdx + 1) * GANTT_DAY_WIDTH;
      const midY = headerHeight + i * GANTT_ROW_H + GANTT_BAR_TOP + GANTT_BAR_H / 2;
      positions.set(scheduleKey(s), { left, right, midY });
    }
    drawDependencyArrows(grid, positions, totalWidth, headerHeight + visible.length * GANTT_ROW_H);
  }

  // Today vertical line — position after the grid is in the DOM so we can
  // measure header height reliably.
  const today = todayIso();
  const todayIdx1 = daysBetweenInclusive(startDate, today);
  if (todayIdx1 && todayIdx1 >= 1 && todayIdx1 <= dayCount) {
    const line = document.createElement('div');
    line.className = 'gantt-today-line';
    line.style.left =
      ((todayIdx1 - 1) * GANTT_DAY_WIDTH + GANTT_DAY_WIDTH / 2) + 'px';
    const headerHeight = header.getBoundingClientRect().height || 24;
    line.style.top = headerHeight + 'px';
    line.style.height = visible.length * 36 + 'px';
    grid.appendChild(line);
  }
}

// Get the category color associated with the given (type, id) endpoint —
// used to color arrows so that overlapping lines from different sources
// remain visually distinguishable. Falls back to the primary blue when no
// color is set on the category.
function categoryColorFor(type, id, owner) {
  let cat = null;
  if (type === 'category') {
    if (owner) {
      cat = state.team.merged.categories.find((c) => c.id === id && c.owner === owner);
    } else {
      cat = state.categories.find((c) => c.id === id);
    }
  } else if (type === 'schedule') {
    if (owner) {
      const s = state.team.merged.schedules.find((x) => x.id === id && x.owner === owner);
      if (s) cat = state.team.merged.categories.find(
        (c) => c.id === s.category_id && c.owner === owner
      );
    } else {
      const s = state.allSchedules.find((x) => x.id === id);
      if (s) cat = state.categories.find((c) => c.id === s.category_id);
    }
  }
  return (cat && cat.color) || '#1f5fc9';
}

// Draw dependency arrows on top of the Gantt grid using an SVG overlay.
// Each arrow takes the predecessor's category color so overlapping lines
// from different sources remain distinguishable. Strong = solid + arrowhead,
// Weak = dashed (no head). Markers (arrowheads) are generated per unique
// color and reused.
function drawDependencyArrows(grid, positions, totalWidth, totalHeight) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'gantt-arrows');
  svg.setAttribute('width', String(totalWidth));
  svg.setAttribute('height', String(totalHeight));
  svg.style.position = 'absolute';
  svg.style.top = '0';
  svg.style.left = '0';
  svg.style.pointerEvents = 'none';

  const defs = document.createElementNS(NS, 'defs');
  svg.appendChild(defs);

  const markerByColor = new Map();
  function ensureMarker(color) {
    if (markerByColor.has(color)) return markerByColor.get(color);
    const id = `gantt-arrow-${markerByColor.size}`;
    const m = document.createElementNS(NS, 'marker');
    m.setAttribute('id', id);
    m.setAttribute('markerWidth', '8');
    m.setAttribute('markerHeight', '8');
    m.setAttribute('refX', '7');
    m.setAttribute('refY', '4');
    m.setAttribute('orient', 'auto');
    m.setAttribute('markerUnits', 'userSpaceOnUse');
    const tri = document.createElementNS(NS, 'path');
    tri.setAttribute('d', 'M0,0 L8,4 L0,8 z');
    tri.setAttribute('fill', color);
    m.appendChild(tri);
    defs.appendChild(m);
    markerByColor.set(color, id);
    return id;
  }

  // Index schedules by composite (owner, category_id) so a dep referencing a
  // category resolves to the right peer's schedules in that category.
  const schedulesByCat = new Map();
  function pushSchedToCat(s) {
    const key = depEndpointKey(s.owner, s.category_id);
    if (!schedulesByCat.has(key)) schedulesByCat.set(key, []);
    schedulesByCat.get(key).push(scheduleKey(s));
  }
  for (const s of state.allSchedules) pushSchedToCat(s);
  if (teamOn()) {
    for (const s of state.team.merged.schedules) pushSchedToCat(s);
  }

  function pickPredScheduleKey(d) {
    const owner = d.owner || '';
    if (d.pred_type === 'schedule') {
      const k = depEndpointKey(owner, d.pred_id);
      return positions.has(k) ? k : null;
    }
    let bestKey = null;
    let bestRight = -Infinity;
    for (const k of (schedulesByCat.get(depEndpointKey(owner, d.pred_id)) || [])) {
      const p = positions.get(k);
      if (p && p.right > bestRight) {
        bestRight = p.right;
        bestKey = k;
      }
    }
    return bestKey;
  }
  function pickSuccScheduleKey(d) {
    const owner = d.owner || '';
    if (d.succ_type === 'schedule') {
      const k = depEndpointKey(owner, d.succ_id);
      return positions.has(k) ? k : null;
    }
    let bestKey = null;
    let bestLeft = Infinity;
    for (const k of (schedulesByCat.get(depEndpointKey(owner, d.succ_id)) || [])) {
      const p = positions.get(k);
      if (p && p.left < bestLeft) {
        bestLeft = p.left;
        bestKey = k;
      }
    }
    return bestKey;
  }

  // Two passes so weak (dashed) edges are drawn AFTER strong (solid) ones,
  // and so they don't get hidden by overlapping solid lines. Weak edges also
  // get a small vertical offset so they remain visually distinguishable when
  // they share the same pred/succ pair as a strong edge.
  function drawOne(d, weakYOffset) {
    const predKey = pickPredScheduleKey(d);
    const succKey = pickSuccScheduleKey(d);
    if (!predKey || !succKey) return;
    const p = positions.get(predKey);
    const s = positions.get(succKey);
    if (!p || !s) return;

    const yOff = d.link_type === 'weak' ? weakYOffset : 0;
    const x1 = p.right;
    const y1 = p.midY + yOff;
    const x2 = s.left;
    const y2 = s.midY + yOff;
    const off = 6;
    let path;
    if (x2 > x1 + 4) {
      path = `M ${x1} ${y1} L ${x1 + off} ${y1} L ${x1 + off} ${y2} L ${x2 - 2} ${y2}`;
    } else {
      const midY = (y1 + y2) / 2;
      path = `M ${x1} ${y1} L ${x1 + off} ${y1} L ${x1 + off} ${midY} L ${x2 - off} ${midY} L ${x2 - off} ${y2} L ${x2 - 2} ${y2}`;
    }

    const color = categoryColorFor(d.pred_type, d.pred_id, d.owner);
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', color);
    el.dataset.depId = String(d.id);
    if (d.owner) el.dataset.owner = d.owner;
    if (d.link_type === 'strong') {
      el.setAttribute('stroke-width', '1.8');
      el.setAttribute('marker-end', `url(#${ensureMarker(color)})`);
      el.classList.add('arrow-strong');
    } else {
      el.setAttribute('stroke-width', '1.4');
      el.setAttribute('stroke-dasharray', '5 3');
      el.classList.add('arrow-weak');
    }
    svg.appendChild(el);
  }

  // Combine own + team dependencies. Team deps are tagged with `owner` so
  // the key-based positions lookup resolves to the right peer's bars.
  const allDeps = teamOn()
    ? state.dependencies.concat(state.team.merged.dependencies)
    : state.dependencies;

  // Pass 1: strong edges (no offset).
  for (const d of allDeps) {
    if (d.link_type === 'strong') drawOne(d, 0);
  }
  // Pass 2: weak edges, drawn on top with a +6px vertical offset so an
  // overlapping strong line doesn't obscure them.
  for (const d of allDeps) {
    if (d.link_type === 'weak') drawOne(d, 6);
  }

  grid.appendChild(svg);
}

// Cmd/Ctrl+click → strong dep, Opt/Alt+click → weak dep. First click selects
// a "source" bar; second click on another bar creates the dependency from
// the first to the second. ESC or clicking the same bar twice cancels.
// (Cmd on mac, Ctrl on win/linux — neither triggers contextmenu; macOS's
// Ctrl+click DOES become contextmenu so we never use Ctrl on mac.)
async function handleBarConnectionClick(schedule, linkType) {
  if (!state.depDraft) {
    state.depDraft = { scheduleId: schedule.id, linkType };
    document.body.classList.add('dep-drafting');
    showDepConnBanner(schedule, linkType);
    renderSchedules(); // redraw to highlight the selected bar
    return;
  }
  const firstId = state.depDraft.scheduleId;
  const firstLink = state.depDraft.linkType;
  if (firstId === schedule.id) {
    cancelDepDraft();
    return;
  }
  const payload = {
    pred_type: 'schedule',
    pred_id: firstId,
    succ_type: 'schedule',
    succ_id: schedule.id,
    link_type: firstLink,
    on_delay: 'auto_shift',
  };
  cancelDepDraft();
  try {
    const created = await api('POST', '/api/dependencies', payload);
    if (created && created.id) {
      state.undoStack.push({ kind: 'dep-create', id: created.id, payload });
      state.redoStack = [];
    }
    await loadDependencies();
    renderSchedules();
    if (state.scope !== 'all') renderDependencies();
  } catch (err) {
    const map = {
      cycle_detected: '순환 의존이 발생합니다.',
      self_loop: '자기 자신을 가리킬 수 없습니다.',
      container_cycle: '컨테이너 사이클입니다.',
      duplicate: '동일한 의존이 이미 존재합니다.',
      pred_not_found: '선행 항목을 찾을 수 없습니다.',
      succ_not_found: '후행 항목을 찾을 수 없습니다.',
    };
    alert(map[err.message] || `의존성 생성 실패: ${err.message}`);
  }
}
function cancelDepDraft() {
  state.depDraft = null;
  document.body.classList.remove('dep-drafting');
  hideDepConnBanner();
  renderSchedules();
}
function showDepConnBanner(schedule, linkType) {
  const isMac = navigator.platform.toLowerCase().includes('mac');
  const strongKey = isMac ? 'Cmd' : 'Ctrl';
  const weakKey = isMac ? 'Opt' : 'Alt';
  const linkLabel =
    linkType === 'strong' ? `강한 연결 (${strongKey})` : `약한 연결 (${weakKey})`;
  const cat = state.categories.find((c) => c.id === schedule.category_id);
  const label = cat ? `${cat.name} / ${schedule.title}` : schedule.title;
  els.ganttConnBannerText.textContent =
    `${linkLabel}: "${label}" → ? — 두 번째 바를 클릭하세요.`;
  els.ganttConnBanner.classList.remove('hidden');
}
function hideDepConnBanner() {
  els.ganttConnBanner.classList.add('hidden');
}
els.ganttConnCancel.addEventListener('click', cancelDepDraft);

// Skip our keybindings while user is typing into a form control.
function isTypingTarget(t) {
  if (!t) return false;
  const tag = t.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable;
}

// Undo / Redo refresh: schedules and dependencies may have changed; pull
// fresh state and rerender everything that depends on them.
async function refreshAfterHistoryAction() {
  // Undo/redo applies its record via the same routes (PUT /api/schedules/:id,
  // POST/DELETE /api/dependencies/:id) that now cascade automatically. The
  // engine's solution-Z reset (strong-component snap before cascade) inside
  // recomputeFromScheduleChange means stale actual_* gets cleared on every
  // mutation — so an extra recomputeAll here is no longer needed.
  await loadAllSchedules();
  await loadDependencies();
  if (state.selectedCategoryId) {
    await loadSchedules(state.selectedCategoryId);
  }
  renderSchedules();
  if (state.scope !== 'all' && state.scope !== 'all-reports') {
    renderDependencies();
  }
}

// Apply a record's "reverse" (undo). Returns true if successfully applied;
// failures (e.g. record points at something that no longer exists) cause the
// record to be silently dropped from the stack.
async function applyUndoRecord(record) {
  try {
    if (record.kind === 'dep-create') {
      await api('DELETE', `/api/dependencies/${record.id}`);
    } else if (record.kind === 'schedule-update') {
      await api('PUT', `/api/schedules/${record.id}`, record.before);
    } else if (record.kind === 'schedule-update-batch') {
      for (const it of record.items) {
        await api('PUT', `/api/schedules/${it.id}`, it.before);
      }
    } else {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

// Apply a record's "forward" (redo). For dep-create we re-POST the original
// payload (and update the record's id since auto-increment yields a new one).
async function applyRedoRecord(record) {
  try {
    if (record.kind === 'dep-create') {
      const created = await api('POST', '/api/dependencies', record.payload);
      if (created && created.id) record.id = created.id;
    } else if (record.kind === 'schedule-update') {
      await api('PUT', `/api/schedules/${record.id}`, record.after);
    } else if (record.kind === 'schedule-update-batch') {
      for (const it of record.items) {
        await api('PUT', `/api/schedules/${it.id}`, it.after);
      }
    } else {
      return false;
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function performUndo() {
  if (state.undoStack.length === 0) return;
  const record = state.undoStack.pop();
  const ok = await applyUndoRecord(record);
  if (ok) state.redoStack.push(record);
  await refreshAfterHistoryAction();
}
async function performRedo() {
  if (state.redoStack.length === 0) return;
  const record = state.redoStack.pop();
  const ok = await applyRedoRecord(record);
  if (ok) state.undoStack.push(record);
  await refreshAfterHistoryAction();
}

document.addEventListener('keydown', (e) => {
  // ESC clears any active "modes" (dep-draft and/or sticky date focus) in
  // one keystroke. Both can be live at the same time (e.g. user starts a
  // dep draft, then clicks a date header) and a single ESC should reset
  // the whole UI to neutral. Modals own ESC for their own close behavior,
  // so when a modal is open we don't drop sticky focus from under it.
  if (e.key === 'Escape') {
    let consumed = false;
    if (state.depDraft) {
      cancelDepDraft();
      consumed = true;
    }
    if (state.dateFocus) {
      const anyModalOpen = document.querySelector('.modal:not(.hidden)');
      if (!anyModalOpen) {
        clearDateFocus();
        consumed = true;
      }
    }
    if (consumed) return;
  }
  if (isTypingTarget(e.target)) return;

  const cmd = e.metaKey || e.ctrlKey;
  if (!cmd) return;
  const k = e.key.toLowerCase();

  // Redo: Cmd/Ctrl+Shift+Z OR Cmd/Ctrl+Y. Check before bare-Z so Shift doesn't
  // accidentally fall through.
  if ((e.shiftKey && k === 'z') || k === 'y') {
    if (state.redoStack.length === 0) return;
    e.preventDefault();
    performRedo();
    return;
  }
  // Undo: Cmd/Ctrl+Z (no Shift).
  if (!e.shiftKey && k === 'z') {
    if (state.undoStack.length === 0) return;
    e.preventDefault();
    performUndo();
    return;
  }
});

// Find direct strong-edge schedule predecessors of a given schedule. Used by
// Shift+drag (group move). We only follow edges where the predecessor is a
// schedule (not a category) — category endpoints don't have a single bar to
// drag visually. Walks 1 hop only by design (user spec).
function directStrongSchedulePredecessors(schedule) {
  const out = [];
  const seen = new Set();
  for (const d of state.dependencies) {
    if (d.link_type !== 'strong') continue;
    // Predecessor side must resolve to this schedule's id (succ).
    const succHits =
      (d.succ_type === 'schedule' && d.succ_id === schedule.id) ||
      (d.succ_type === 'category' && d.succ_id === schedule.category_id);
    if (!succHits) continue;
    if (d.pred_type !== 'schedule') continue; // skip category preds
    if (seen.has(d.pred_id)) continue;
    seen.add(d.pred_id);
    const pred = state.allSchedules.find((s) => s.id === d.pred_id);
    if (pred) out.push(pred);
  }
  return out;
}

function attachBarDragHandlers(bar, schedule) {
  bar.addEventListener('mousedown', (e) => {
    // Team-owned schedule: read-only. Block all drag/connect/report actions.
    if (schedule.owner) return;
    if (e.target.classList.contains('resize-handle')) return;

    // Sticky date-focus mode: a bar click opens the daily-report modal for
    // this (date, schedule). Disable drag, modifier connection, and resize
    // entirely while focus is active — user is in "report entry" mode.
    if (state.dateFocus) {
      // Only act when the focused date actually falls within this bar.
      // Dimmed (non-hit) bars shouldn't open a report.
      if (
        state.dateFocus < schedule.planned_start ||
        state.dateFocus > schedule.planned_end
      ) {
        return;
      }
      e.preventDefault();
      e.stopPropagation();
      openReportModalForDateAndSchedule(state.dateFocus, schedule);
      return;
    }

    // Modifier-click → connection draft mode (don't drag).
    //   Cmd (mac) / Ctrl (win) = strong connection
    //   Opt (mac) / Alt (win)  = weak connection
    // Shift is reserved for group drag below.
    const isStrong = e.metaKey || e.ctrlKey;
    const isWeak = e.altKey;
    if (isStrong || isWeak) {
      e.preventDefault();
      e.stopPropagation();
      handleBarConnectionClick(schedule, isStrong ? 'strong' : 'weak');
      return;
    }

    // Shift held at mousedown → group drag: every direct strong-schedule
    // predecessor moves together with the dragged bar (same delta).
    const isGroupDrag = e.shiftKey;

    e.preventDefault();
    const startX = e.clientX;
    const origLeft = parseFloat(bar.style.left);
    bar.classList.add('dragging');
    let moved = false;

    // Build the group: dragged bar + bars of direct strong-schedule preds.
    // For each, capture original left + DOM ref. Bars are looked up via the
    // grid's `[data-schedule-id]` so this works in all-view too.
    const grid = bar.closest('.gantt-grid');
    const groupExtras = [];
    if (isGroupDrag && grid) {
      for (const pred of directStrongSchedulePredecessors(schedule)) {
        const predBar = grid.querySelector(
          `.gantt-bar[data-schedule-id="${pred.id}"]`
        );
        if (!predBar) continue;
        groupExtras.push({
          schedule: pred,
          bar: predBar,
          origLeft: parseFloat(predBar.style.left),
        });
        predBar.classList.add('dragging', 'group-extra');
      }
    }

    function onMove(ev) {
      const dx = ev.clientX - startX;
      if (Math.abs(dx) > 3) moved = true;
      const snapped = Math.round(dx / GANTT_DAY_WIDTH) * GANTT_DAY_WIDTH;
      bar.style.left = origLeft + snapped + 'px';
      for (const g of groupExtras) {
        g.bar.style.left = g.origLeft + snapped + 'px';
      }
    }
    async function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      bar.classList.remove('dragging');
      for (const g of groupExtras) {
        g.bar.classList.remove('dragging', 'group-extra');
      }

      // Pure click (no real drag) → open edit modal. Group-drag with no
      // movement still falls through here so it's harmless.
      if (!moved) {
        bar.style.left = origLeft + 'px';
        for (const g of groupExtras) g.bar.style.left = g.origLeft + 'px';
        openScheduleModal(schedule);
        return;
      }

      const finalLeft = parseFloat(bar.style.left);
      const dayDelta = Math.round((finalLeft - origLeft) / GANTT_DAY_WIDTH);
      if (dayDelta === 0) {
        bar.style.left = origLeft + 'px';
        for (const g of groupExtras) g.bar.style.left = g.origLeft + 'px';
        return;
      }
      const newStart = addDaysIso(schedule.planned_start, dayDelta);
      const newEnd = addDaysIso(schedule.planned_end, dayDelta);
      if (groupExtras.length === 0) {
        await saveScheduleFromGantt(schedule.id, newStart, newEnd);
      } else {
        // Move dragged bar + each extra by the same delta. Single batch so
        // recompute runs once at the end.
        const moves = [
          { id: schedule.id, planned_start: newStart, planned_end: newEnd },
        ];
        for (const g of groupExtras) {
          moves.push({
            id: g.schedule.id,
            planned_start: addDaysIso(g.schedule.planned_start, dayDelta),
            planned_end: addDaysIso(g.schedule.planned_end, dayDelta),
          });
        }
        await saveScheduleGroupFromGantt(moves);
      }
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

function attachBarResizeHandlers(handle, bar, schedule) {
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const origWidth = parseFloat(bar.style.width);

    function onMove(ev) {
      const dx = ev.clientX - startX;
      const snapped = Math.round(dx / GANTT_DAY_WIDTH) * GANTT_DAY_WIDTH;
      const newWidth = Math.max(GANTT_DAY_WIDTH, origWidth + snapped);
      bar.style.width = newWidth + 'px';
    }
    async function onUp() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      const finalWidth = parseFloat(bar.style.width);
      const dayDelta = Math.round((finalWidth - origWidth) / GANTT_DAY_WIDTH);
      if (dayDelta === 0) return;
      const newEnd = addDaysIso(schedule.planned_end, dayDelta);
      await saveScheduleFromGantt(schedule.id, schedule.planned_start, newEnd);
    }
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Hovering a bar dims unrelated arrows and keeps related ones at full opacity,
// so overlapping lines from different sources can be visually traced.
// "Related" = the dep's pred or succ endpoint resolves to this schedule
// (directly via schedule id, or indirectly via the schedule's category).
function isDepRelatedTo(dep, schedule) {
  // Cross-owner deps don't relate — own and team belong to disjoint id spaces.
  if ((dep.owner || '') !== (schedule.owner || '')) return false;
  const matches = (type, id) => {
    if (type === 'schedule') return id === schedule.id;
    if (type === 'category') return id === schedule.category_id;
    return false;
  };
  return matches(dep.pred_type, dep.pred_id) || matches(dep.succ_type, dep.succ_id);
}

// Resolve a dep endpoint (schedule|category) to the set of composite schedule
// keys (owner+id) that it stands for. Used during bar hover to mark every bar
// that participates in a dep with the hovered schedule.
function resolveEndpointScheduleKeys(type, id, owner) {
  const o = owner || '';
  if (type === 'schedule') return [depEndpointKey(o, id)];
  if (type === 'category') {
    if (o) {
      return state.team.merged.schedules
        .filter((s) => s.category_id === id && s.owner === o)
        .map(scheduleKey);
    }
    return state.allSchedules
      .filter((s) => s.category_id === id)
      .map(scheduleKey);
  }
  return [];
}

function attachBarHoverHighlight(bar, schedule) {
  bar.addEventListener('mouseenter', () => {
    // Sticky date-focus mode owns the highlight; skip hover entirely so the
    // user's click-selected date isn't visually overridden by mouse motion.
    if (state.dateFocus) return;
    const grid = bar.closest('.gantt-grid');
    const svg = grid && grid.querySelector('.gantt-arrows');

    // Combined dep pool — own deps + team-merged deps (each tagged with owner).
    const allDeps = teamOn()
      ? state.dependencies.concat(state.team.merged.dependencies)
      : state.dependencies;

    // Bars: dim all bars in the grid except hovered + those tied by a dep.
    if (grid) {
      grid.classList.add('hover-active');
      const focusKeys = new Set([scheduleKey(schedule)]);
      for (const dep of allDeps) {
        if (!isDepRelatedTo(dep, schedule)) continue;
        const o = dep.owner || '';
        for (const k of resolveEndpointScheduleKeys(dep.pred_type, dep.pred_id, o)) {
          focusKeys.add(k);
        }
        for (const k of resolveEndpointScheduleKeys(dep.succ_type, dep.succ_id, o)) {
          focusKeys.add(k);
        }
      }
      grid.querySelectorAll('.gantt-bar[data-schedule-id]').forEach((b) => {
        const key = `${b.dataset.owner || ''}:${b.dataset.scheduleId}`;
        if (focusKeys.has(key)) {
          b.classList.add('bar-focus');
        }
      });
    }

    // Arrows: same focus rule, looked up by composite (owner, dep id) key.
    if (svg) {
      svg.classList.add('hover-active');
      const depByKey = new Map(
        allDeps.map((d) => [`${d.owner || ''}:${d.id}`, d])
      );
      svg.querySelectorAll('path[data-dep-id]').forEach((p) => {
        const arrowKey = `${p.dataset.owner || ''}:${Number(p.dataset.depId)}`;
        const dep = depByKey.get(arrowKey);
        if (dep && isDepRelatedTo(dep, schedule)) {
          p.classList.add('arrow-focus');
        }
      });
    }
  });
  bar.addEventListener('mouseleave', () => {
    const grid = bar.closest('.gantt-grid');
    if (grid) {
      grid.classList.remove('hover-active');
      grid.querySelectorAll('.gantt-bar.bar-focus').forEach((b) => {
        b.classList.remove('bar-focus');
      });
    }
    const svg = grid && grid.querySelector('.gantt-arrows');
    if (svg) {
      svg.classList.remove('hover-active');
      svg.querySelectorAll('path.arrow-focus').forEach((p) => {
        p.classList.remove('arrow-focus');
      });
    }
  });
}

async function saveScheduleFromGantt(id, plannedStart, plannedEnd) {
  // Capture the pre-PUT planned dates so Cmd/Ctrl+Z can restore them.
  const before = findScheduleById(id);
  const beforeData = before
    ? {
        planned_start: before.planned_start,
        planned_end: before.planned_end,
      }
    : null;
  try {
    const res = await api('PUT', `/api/schedules/${id}`, {
      planned_start: plannedStart,
      planned_end: plannedEnd,
    });
    if (
      beforeData &&
      (beforeData.planned_start !== plannedStart ||
        beforeData.planned_end !== plannedEnd)
    ) {
      state.undoStack.push({
        kind: 'schedule-update',
        id,
        before: beforeData,
        after: { planned_start: plannedStart, planned_end: plannedEnd },
      });
      state.redoStack = [];
    }
    await Promise.all([
      loadSchedules(state.selectedCategoryId),
      loadAllSchedules(),
    ]);
    renderSchedules();
    if (res && res.cascade) reportCascade(res.cascade);
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
    renderSchedules();
  }
}

// Move a group of schedules by the same delta in one user action (Shift+drag).
// Each entry: { id, planned_start, planned_end }. We PUT them sequentially —
// the server runs recompute after each, but we ignore the per-step cascade
// reports and only fire one final reload+render. A single undo record covers
// the whole batch so Cmd/Ctrl+Z reverses the group move atomically.
async function saveScheduleGroupFromGantt(moves) {
  const items = [];
  for (const m of moves) {
    const before = findScheduleById(m.id);
    if (!before) continue;
    if (
      before.planned_start === m.planned_start &&
      before.planned_end === m.planned_end
    ) {
      continue; // no-op for this schedule
    }
    items.push({
      id: m.id,
      before: {
        planned_start: before.planned_start,
        planned_end: before.planned_end,
      },
      after: {
        planned_start: m.planned_start,
        planned_end: m.planned_end,
      },
    });
  }
  if (items.length === 0) {
    renderSchedules();
    return;
  }
  try {
    let lastCascade = null;
    for (const it of items) {
      const res = await api('PUT', `/api/schedules/${it.id}`, it.after);
      if (res && res.cascade) lastCascade = res.cascade;
    }
    state.undoStack.push({ kind: 'schedule-update-batch', items });
    state.redoStack = [];
    await Promise.all([
      loadSchedules(state.selectedCategoryId),
      loadAllSchedules(),
    ]);
    renderSchedules();
    if (lastCascade) reportCascade(lastCascade);
  } catch (err) {
    alert(`그룹 이동 실패: ${err.message}`);
    renderSchedules();
  }
}

function isDependencyRelatedToCurrent(dep) {
  if (!state.selectedCategoryId) return false;
  const cid = state.selectedCategoryId;
  const involves = (type, id) => {
    if (type === 'category') return id === cid;
    if (type === 'schedule') {
      const s = state.allSchedules.find((x) => x.id === id);
      return !!s && s.category_id === cid;
    }
    return false;
  };
  return involves(dep.pred_type, dep.pred_id) || involves(dep.succ_type, dep.succ_id);
}

// Returns true when the given (type, id) is part of the currently-selected
// category — either the category itself or a schedule that lives in it.
function entityIsInCurrentCategory(type, id) {
  if (!state.selectedCategoryId) return false;
  const cid = state.selectedCategoryId;
  if (type === 'category') return id === cid;
  if (type === 'schedule') {
    const s = state.allSchedules.find((x) => x.id === id);
    return !!s && s.category_id === cid;
  }
  return false;
}

// Render a label with category context for clarity (e.g., "카메라 / Lot #001_Camera").
function entityFriendlyLabel(type, id) {
  if (type === 'category') {
    const c = state.categories.find((x) => x.id === id);
    return c ? `📁 ${c.name}` : `[C#${id}]`;
  }
  if (type === 'schedule') {
    const s = state.allSchedules.find((x) => x.id === id);
    if (!s) return `[S#${id}]`;
    const c = state.categories.find((x) => x.id === s.category_id);
    return c ? `${c.name} / ${s.title}` : s.title;
  }
  return '';
}

function renderDependencies() {
  els.dependencyRows.innerHTML = '';
  const related = state.dependencies.filter(isDependencyRelatedToCurrent);
  if (related.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 8;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.style.padding = '16px';
    td.textContent = '이 카테고리에 연결된 의존성이 없습니다.';
    tr.appendChild(td);
    els.dependencyRows.appendChild(tr);
    return;
  }
  for (const d of related) {
    const predLabel = entityFriendlyLabel(d.pred_type, d.pred_id);
    const succLabel = entityFriendlyLabel(d.succ_type, d.succ_id);
    const predIn = entityIsInCurrentCategory(d.pred_type, d.pred_id);
    const succIn = entityIsInCurrentCategory(d.succ_type, d.succ_id);

    // Decide which cell holds 현재. Edge always involves at least one side in
    // current category (the panel's filter ensures that). Interpretation:
    //   - succ in current   → 선행=pred (외부) | 현재=succ | 후행=—
    //   - pred in current   → 선행=— | 현재=pred | 후행=succ (외부)
    //   - both in current   → 선행=— | 현재=pred | 후행=succ  (둘 다 안에 있음)
    let prevCell = '<span class="muted">—</span>';
    let curCell = '';
    let nextCell = '<span class="muted">—</span>';
    if (succIn && !predIn) {
      prevCell = escapeHtml(predLabel);
      curCell = escapeHtml(succLabel);
    } else if (predIn && !succIn) {
      curCell = escapeHtml(predLabel);
      nextCell = escapeHtml(succLabel);
    } else {
      // both in current — still belongs to this panel; treat pred as 현재.
      curCell = escapeHtml(predLabel);
      nextCell = escapeHtml(succLabel);
    }

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${prevCell}</td>
      <td class="muted">${prevCell.includes('—') ? '' : '→'}</td>
      <td><b>${curCell}</b></td>
      <td class="muted">${nextCell.includes('—') ? '' : '→'}</td>
      <td>${nextCell}</td>
      <td><span class="link-pill ${d.link_type}" data-action="cycle-link" data-id="${d.id}" role="button" title="클릭하여 strong/weak 전환">${d.link_type}</span></td>
      <td>${d.link_type === 'strong'
        ? `<span class="delay-pill ${d.on_delay}" data-action="cycle-delay" data-id="${d.id}" role="button" title="클릭하여 auto_shift/warn_only 전환">${d.on_delay}</span>`
        : '<span class="muted">—</span>'}</td>
      <td class="actions">
        <button class="btn" data-action="edit-dep" data-id="${d.id}">편집</button>
        <button class="btn btn-danger" data-action="delete-dep" data-id="${d.id}">삭제</button>
      </td>
    `;
    els.dependencyRows.appendChild(tr);
  }
}

async function loadCategories() {
  state.categories = await api('GET', '/api/categories');
  renderCategories();
}
async function loadAllSchedules() {
  state.allSchedules = await api('GET', '/api/schedules');
}
async function loadDependencies() {
  state.dependencies = await api('GET', '/api/dependencies');
}
async function loadSchedules(categoryId) {
  if (!categoryId) {
    state.schedules = [];
    return;
  }
  state.schedules = await api(
    'GET',
    `/api/schedules?category_id=${categoryId}`
  );
}
async function loadReports(categoryId) {
  if (!categoryId) {
    state.reports = [];
    return;
  }
  state.reports = await api(
    'GET',
    `/api/reports?category_id=${categoryId}`
  );
}

async function refreshAll() {
  await Promise.all([
    loadCategories(),
    loadAllSchedules(),
    loadDependencies(),
    loadServerHolidays(),
  ]);
  if (state.selectedCategoryId) {
    await Promise.all([
      loadSchedules(state.selectedCategoryId),
      loadReports(state.selectedCategoryId),
    ]);
  }
  renderCategoryView();
}

async function selectCategory(id) {
  state.scope = 'category';
  state.selectedCategoryId = id;
  renderCategories();
  await Promise.all([loadSchedules(id), loadReports(id)]);
  renderCategoryView();
}

function selectAllView() {
  state.scope = 'all';
  state.selectedCategoryId = null;
  state.expandConnected = false; // not meaningful in all-view
  // Clear per-category caches so they don't shadow the canonical state.allSchedules
  // when looking up by id (status-pill cycle, etc.).
  state.schedules = [];
  state.reports = [];
  // Entering all-view: default to a "ready-to-read" Gantt — bar view, arrows on,
  // chain sort on. Sync the toggle UI so they reflect the new state. Not
  // persisted to localStorage so per-category preferences survive reloads.
  state.scheduleView = 'gantt';
  state.showArrows = true;
  state.chainSort = true;
  els.viewBtns.forEach((b) => {
    b.classList.toggle('active', b.dataset.view === 'gantt');
  });
  els.showArrowsBtn.classList.add('active');
  els.showArrowsBtn.textContent = '화살표 ON';
  els.chainSortBtn.classList.add('active');
  els.chainSortBtn.textContent = '체인정렬 ON';
  renderCategories();
  renderCategoryView();
}

async function selectAllReportsView() {
  state.scope = 'all-reports';
  state.selectedCategoryId = null;
  state.expandConnected = false;
  renderCategories();
  await loadAllReports();
  renderCategoryView();
}

async function loadAllReports() {
  state.allReports = await api('GET', '/api/reports');
}

// ---------- Cascade / conflict reporting ----------
function describeShift(sh) {
  if (sh.delta_days >= 0) {
    return `↓ 자동 밀기: ${sh.label} → ${sh.new_start} ~ ${sh.new_end} (+${sh.delta_days}일)`;
  }
  return `↑ 자동 당김: ${sh.label} → ${sh.new_start} ~ ${sh.new_end} (${sh.delta_days}일)`;
}
function describeConflict(cf) {
  return `⚠ ${cf.label} 은(는) ${cf.required_min_start} 부터여야 하지만 현재 ${cf.current_start} (선행: ${cf.predecessor_label})`;
}

function reportCascade(cascade) {
  if (!cascade) return;
  const lines = [];
  for (const sh of cascade.shifted) lines.push(describeShift(sh));
  for (const cf of cascade.conflicts) lines.push(describeConflict(cf));
  if (lines.length === 0) return;
  alert(lines.join('\n'));
}

// ---------- Category modal ----------
function openCategoryModal(category) {
  els.categoryModalTitle.textContent = category ? '카테고리 편집' : '카테고리 추가';
  els.categoryForm.reset();
  els.categoryForm.dataset.editId = category ? category.id : '';
  if (category) {
    els.categoryForm.name.value = category.name || '';
    els.categoryForm.description.value = category.description || '';
    els.categoryForm.color.value = category.color || '#4f8cff';
  } else {
    els.categoryForm.color.value = '#4f8cff';
  }
  els.categoryModal.classList.remove('hidden');
}
function closeCategoryModal() { els.categoryModal.classList.add('hidden'); }

els.addCategoryBtn.addEventListener('click', () => openCategoryModal(null));
els.editCategoryBtn.addEventListener('click', () => {
  const c = state.categories.find((x) => x.id === state.selectedCategoryId);
  if (c) openCategoryModal(c);
});
els.deleteCategoryBtn.addEventListener('click', async () => {
  const c = state.categories.find((x) => x.id === state.selectedCategoryId);
  if (!c) return;
  if (!confirm(`"${c.name}" 카테고리를 삭제하시겠습니까? (포함된 스케줄도 함께 삭제됩니다)`)) return;
  await api('DELETE', `/api/categories/${c.id}`);
  state.selectedCategoryId = null;
  state.schedules = [];
  await refreshAll();
});

els.categoryForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(els.categoryForm);
  const payload = {
    name: fd.get('name'),
    description: fd.get('description') || null,
    color: fd.get('color'),
  };
  const editId = els.categoryForm.dataset.editId;
  try {
    let saved;
    if (editId) {
      saved = await api('PUT', `/api/categories/${editId}`, payload);
    } else {
      saved = await api('POST', '/api/categories', payload);
    }
    closeCategoryModal();
    await refreshAll();
    selectCategory(saved.id);
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
  }
});

// ---------- Schedule modal ----------
function openScheduleModal(schedule) {
  els.scheduleModalTitle.textContent = schedule ? '스케줄 편집' : '스케줄 추가';
  els.scheduleForm.reset();
  els.scheduleForm.dataset.editId = schedule ? schedule.id : '';
  // Preserve the schedule's own category_id during edit (matters in 전체 간트 /
  // 연결 포함 mode where the schedule may belong to a different category than
  // the currently selected one). For new schedules, fall back to the selected
  // category.
  els.scheduleForm.dataset.categoryId = String(
    schedule ? schedule.category_id : state.selectedCategoryId || ''
  );
  if (schedule) {
    els.scheduleForm.title.value = schedule.title;
    els.scheduleForm.description.value = schedule.description || '';
    els.scheduleForm.planned_start.value = schedule.planned_start;
    els.scheduleForm.planned_end.value = schedule.planned_end;
    els.scheduleForm.status.value = schedule.status;
  } else {
    const today = new Date().toISOString().slice(0, 10);
    els.scheduleForm.planned_start.value = today;
    els.scheduleForm.planned_end.value = today;
  }
  // Always derive 계획일수 from current dates when opening the modal.
  els.scheduleForm.planned_days.value =
    daysBetweenInclusive(
      els.scheduleForm.planned_start.value,
      els.scheduleForm.planned_end.value
    ) || 1;
  els.scheduleModal.classList.remove('hidden');
}

// Bidirectional sync between 시작일 / 종료일 / 계획일수.
// Rules:
//   - 시작일 변경 → 일수 보존, 종료일 = 시작일 + (일수 - 1)
//   - 종료일 변경 → 시작일 보존, 일수 재계산
//   - 일수 변경    → 시작일 보존, 종료일 = 시작일 + (일수 - 1)
els.scheduleForm.planned_start.addEventListener('change', () => {
  const start = els.scheduleForm.planned_start.value;
  const days = Number(els.scheduleForm.planned_days.value);
  if (start && days > 0) {
    els.scheduleForm.planned_end.value = addDaysIso(start, days - 1);
  }
});
els.scheduleForm.planned_end.addEventListener('change', () => {
  const d = daysBetweenInclusive(
    els.scheduleForm.planned_start.value,
    els.scheduleForm.planned_end.value
  );
  if (d != null) els.scheduleForm.planned_days.value = d;
});
els.scheduleForm.planned_days.addEventListener('input', () => {
  const start = els.scheduleForm.planned_start.value;
  const days = Number(els.scheduleForm.planned_days.value);
  if (start && days > 0) {
    els.scheduleForm.planned_end.value = addDaysIso(start, days - 1);
  }
});
function closeScheduleModal() { els.scheduleModal.classList.add('hidden'); }

els.addScheduleBtn.addEventListener('click', () => {
  if (!state.selectedCategoryId) return;
  openScheduleModal(null);
});

els.scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(els.scheduleForm);
  const categoryId = Number(els.scheduleForm.dataset.categoryId) || null;
  if (!categoryId) {
    alert('카테고리를 알 수 없습니다. 사이드바에서 카테고리를 선택한 뒤 다시 시도해주세요.');
    return;
  }
  const payload = {
    category_id: categoryId,
    title: fd.get('title'),
    description: fd.get('description') || null,
    planned_start: fd.get('planned_start'),
    planned_end: fd.get('planned_end'),
    status: fd.get('status') || 'pending',
  };
  const editId = els.scheduleForm.dataset.editId;
  try {
    let res;
    if (editId) {
      res = await api('PUT', `/api/schedules/${editId}`, payload);
    } else {
      res = await api('POST', '/api/schedules', payload);
    }
    closeScheduleModal();
    await refreshAll();
    if (res && res.cascade) reportCascade(res.cascade);
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
  }
});

// Schedule edit/delete via row actions + status pill click cycles status.
//
// IMPORTANT: when looking up a schedule by id from a click event, we MUST
// prefer state.allSchedules over state.schedules. state.schedules is the
// per-category cache and may be stale if the user switched into 전체 간트
// view (loadAllSchedules reloads on every PUT, but loadSchedules only fires
// when selectedCategoryId is set). Reading stale status would compute the
// wrong "next" in the cycle and effectively freeze it on one value.
function findScheduleById(id) {
  return (
    state.allSchedules.find((x) => x.id === id) ||
    state.schedules.find((x) => x.id === id) ||
    null
  );
}

els.scheduleRows.addEventListener('click', async (e) => {
  // Status pill click → cycle to next status (no edit modal needed for this).
  const pill = e.target.closest('.status-pill[data-action="cycle-status"]');
  if (pill) {
    const id = Number(pill.dataset.id);
    const sched = findScheduleById(id);
    if (!sched) return;
    const oldStatus = sched.status;
    const next = nextStatusOf(oldStatus);
    try {
      await api('PUT', `/api/schedules/${id}`, { status: next });
      state.undoStack.push({
        kind: 'schedule-update',
        id,
        before: { status: oldStatus },
        after: { status: next },
      });
      state.redoStack = [];
      await Promise.all([
        loadAllSchedules(),
        state.selectedCategoryId
          ? loadSchedules(state.selectedCategoryId)
          : Promise.resolve(),
      ]);
      renderSchedules();
    } catch (err) {
      alert(`상태 변경 실패: ${err.message}`);
    }
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const sched = findScheduleById(id);
  if (!sched) return;

  if (btn.dataset.action === 'edit-schedule') {
    openScheduleModal(sched);
  } else if (btn.dataset.action === 'delete-schedule') {
    if (!confirm(`"${sched.title}" 스케줄을 삭제하시겠습니까?`)) return;
    await api('DELETE', `/api/schedules/${id}`);
    await refreshAll();
  }
});

// ---------- Dependency modal ----------
function populateEntitySelect(selectEl, type) {
  selectEl.innerHTML = '';
  const items =
    type === 'category'
      ? state.categories.map((c) => ({ id: c.id, label: c.name }))
      : state.allSchedules.map((s) => {
          const cat = state.categories.find((c) => c.id === s.category_id);
          return {
            id: s.id,
            label: `${cat ? cat.name + ' / ' : ''}${s.title}`,
          };
        });
  for (const it of items) {
    const opt = document.createElement('option');
    opt.value = it.id;
    opt.textContent = it.label;
    selectEl.appendChild(opt);
  }
}

async function openDependencyModal(dep = null) {
  // Always refresh entity lists from the server so that just-created
  // categories / schedules show up in the dropdowns (and we don't silently
  // PUT to a dependency that was deleted in the meantime).
  try {
    await Promise.all([loadCategories(), loadAllSchedules(), loadDependencies()]);
  } catch (e) {
    /* non-fatal — fall through with whatever we have */
  }
  if (state.categories.length === 0 || state.allSchedules.length === 0) {
    alert('카테고리와 스케줄을 먼저 만들어주세요.');
    return;
  }
  // If editing, verify the dep still exists after the refresh.
  if (dep && !state.dependencies.find((d) => d.id === dep.id)) {
    alert('편집 중인 의존성이 더 이상 존재하지 않습니다. 새로고침되었습니다.');
    renderDependencies();
    return;
  }

  els.dependencyModalTitle.textContent = dep ? '의존성 편집' : '의존성 추가';
  els.dependencyForm.reset();
  els.dependencyForm.dataset.editId = dep ? String(dep.id) : '';

  const predType = dep?.pred_type || 'schedule';
  const succType = dep?.succ_type || 'schedule';
  els.dependencyForm.pred_type.value = predType;
  populateEntitySelect(els.dependencyForm.pred_id, predType);
  if (dep) els.dependencyForm.pred_id.value = String(dep.pred_id);

  els.dependencyForm.succ_type.value = succType;
  populateEntitySelect(els.dependencyForm.succ_id, succType);
  if (dep) els.dependencyForm.succ_id.value = String(dep.succ_id);

  els.dependencyForm.link_type.value = dep?.link_type || 'strong';
  els.dependencyForm.on_delay.value = dep?.on_delay || 'auto_shift';
  els.dependencyModal.classList.remove('hidden');
}
function closeDependencyModal() {
  els.dependencyModal.classList.add('hidden');
  // Clear edit-mode marker so the next "+ 의존성 추가" can't accidentally PUT.
  els.dependencyForm.dataset.editId = '';
}

// "+ 의존성 추가" → new 3-slot anchor form. Edit (편집) still uses the
// 2-slot openDependencyModal(dep) for now.
els.addDependencyBtn.addEventListener('click', () => openDependencyCreate());

// =================== Dependency Create (3-slot anchor form) ===================

// Two entities (typeA,idA) and (typeB,idB) are "in relation" if they refer to
// the same thing OR one contains the other (schedule ↔ its category). These
// pairs cannot legitimately be both endpoints of an edge, so the dropdown
// filters them out at input time.
function entitiesInRelation(typeA, idA, typeB, idB) {
  if (!typeA || !typeB || idA == null || idB == null) return false;
  if (typeA === typeB && Number(idA) === Number(idB)) return true;
  if (typeA === 'schedule' && typeB === 'category') {
    const s = state.allSchedules.find((x) => x.id === Number(idA));
    return !!s && s.category_id === Number(idB);
  }
  if (typeA === 'category' && typeB === 'schedule') {
    const s = state.allSchedules.find((x) => x.id === Number(idB));
    return !!s && s.category_id === Number(idA);
  }
  return false;
}

// Build the option list for a "side" (pred or succ) target select, excluding
// any items in relation with the given anchors (current + opposite side).
function entityOptionsExcluding(type, exclusions) {
  const items =
    type === 'category'
      ? state.categories.map((c) => ({ id: c.id, label: c.name }))
      : state.allSchedules.map((s) => {
          const cat = state.categories.find((c) => c.id === s.category_id);
          return {
            id: s.id,
            label: `${cat ? cat.name + ' / ' : ''}${s.title}`,
          };
        });
  return items.filter(
    (it) =>
      !exclusions.some((ex) =>
        entitiesInRelation(type, it.id, ex.type, ex.id)
      )
  );
}

function fillSelect(selectEl, options, placeholder) {
  const prevValue = selectEl.value;
  selectEl.innerHTML = '';
  if (placeholder) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = placeholder;
    selectEl.appendChild(opt);
  }
  for (const it of options) {
    const opt = document.createElement('option');
    opt.value = String(it.id);
    opt.textContent = it.label;
    selectEl.appendChild(opt);
  }
  // Try to preserve previous selection if it still exists.
  if (
    prevValue &&
    Array.from(selectEl.options).some((o) => o.value === prevValue)
  ) {
    selectEl.value = prevValue;
  }
}

function readSide(form, prefix) {
  const type = form[`${prefix}_type`].value || '';
  const idStr = form[`${prefix}_id`].value || '';
  if (!type || !idStr) return null;
  return { type, id: Number(idStr) };
}

function depCreateRefresh() {
  const form = els.dependencyCreateForm;
  const cur = readSide(form, 'current');
  const pred = readSide(form, 'pred');
  const succ = readSide(form, 'succ');

  // Current target options: limited by current_type.
  //   - category: only the currently-viewed category (anchor; user may switch
  //     to schedule mode to drill in).
  //   - schedule: schedules of the currently-viewed category.
  const currentType = form.current_type.value;
  let currentOpts;
  if (currentType === 'category') {
    currentOpts = state.selectedCategoryId
      ? state.categories
          .filter((c) => c.id === state.selectedCategoryId)
          .map((c) => ({ id: c.id, label: c.name }))
      : state.categories.map((c) => ({ id: c.id, label: c.name }));
  } else {
    currentOpts = state.allSchedules
      .filter(
        (s) =>
          !state.selectedCategoryId || s.category_id === state.selectedCategoryId
      )
      .map((s) => {
        const cat = state.categories.find((c) => c.id === s.category_id);
        return {
          id: s.id,
          label: `${cat ? cat.name + ' / ' : ''}${s.title}`,
        };
      });
  }
  fillSelect(form.current_id, currentOpts);

  // re-read current after fill (id may have snapped to first option)
  const curNow = readSide(form, 'current');

  // Pred dropdown: exclude curNow and succ (and anything in container relation).
  const predType = form.pred_type.value;
  if (!predType) {
    fillSelect(form.pred_id, [], '—');
  } else {
    const exclusions = [];
    if (curNow) exclusions.push(curNow);
    if (succ) exclusions.push(succ);
    fillSelect(form.pred_id, entityOptionsExcluding(predType, exclusions), '— 선택 —');
  }

  // Succ dropdown: exclude curNow and pred.
  const succType = form.succ_type.value;
  if (!succType) {
    fillSelect(form.succ_id, [], '—');
  } else {
    const exclusions = [];
    if (curNow) exclusions.push(curNow);
    if (pred) exclusions.push(pred);
    fillSelect(form.succ_id, entityOptionsExcluding(succType, exclusions), '— 선택 —');
  }
}

function openDependencyCreate() {
  // Refresh entity lists so newly-created items show up.
  Promise.all([loadCategories(), loadAllSchedules(), loadDependencies()])
    .then(() => {
      const form = els.dependencyCreateForm;
      form.reset();
      // Default 현재 = current category (if available).
      form.current_type.value = 'category';
      form.pred_type.value = '';
      form.succ_type.value = '';
      form.link_type.value = 'strong';
      form.on_delay.value = 'auto_shift';
      depCreateRefresh();
      // Pre-select current category.
      if (state.selectedCategoryId) {
        form.current_id.value = String(state.selectedCategoryId);
        depCreateRefresh();
      }
      els.dependencyCreateModal.classList.remove('hidden');
    })
    .catch(() => {
      els.dependencyCreateModal.classList.remove('hidden');
    });
}

// Wire change events to keep dropdowns consistent.
['current_type', 'current_id', 'pred_type', 'pred_id', 'succ_type', 'succ_id'].forEach(
  (name) => {
    els.dependencyCreateForm[name].addEventListener('change', depCreateRefresh);
  }
);

els.dependencyCreateForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = els.dependencyCreateForm;
  const cur = readSide(form, 'current');
  const pred = readSide(form, 'pred');
  const succ = readSide(form, 'succ');
  if (!cur) {
    alert('"현재" 를 선택해주세요.');
    return;
  }
  if (!pred && !succ) {
    alert('선행 또는 후행 중 최소 한 쪽은 선택해주세요.');
    return;
  }
  const payload = {
    current: cur,
    pred,
    succ,
    link_type: form.link_type.value,
    on_delay: form.on_delay.value,
  };
  try {
    await api('POST', '/api/dependencies/triple', payload);
    els.dependencyCreateModal.classList.add('hidden');
    await refreshAll();
  } catch (err) {
    const map = {
      cycle_detected: '순환 의존이 발생합니다.',
      self_loop: '자기 자신을 가리킬 수 없습니다.',
      container_cycle: '카테고리와 그 안의 스케줄 사이에는 의존을 걸 수 없습니다.',
      pred_not_found: '선행 대상을 찾을 수 없습니다.',
      succ_not_found: '후행 대상을 찾을 수 없습니다.',
      current_not_found: '"현재" 대상을 찾을 수 없습니다.',
      duplicate: '동일한 의존이 이미 존재합니다.',
      no_edge: '선행 또는 후행 중 하나는 선택해야 합니다.',
      invalid_current: '"현재" 입력이 올바르지 않습니다.',
      invalid_link_type: '연결 유형이 올바르지 않습니다.',
      invalid_on_delay: '충돌 시 동작값이 올바르지 않습니다.',
    };
    const sideMsg = err.body && err.body.side ? ` (${err.body.side === 'pred' ? '선행→현재' : '현재→후행'} 엣지)` : '';
    alert((map[err.message] || `저장 실패 (${err.message})`) + sideMsg);
  }
});

els.dependencyForm.pred_type.addEventListener('change', (e) => {
  populateEntitySelect(els.dependencyForm.pred_id, e.target.value);
});
els.dependencyForm.succ_type.addEventListener('change', (e) => {
  populateEntitySelect(els.dependencyForm.succ_id, e.target.value);
});

els.dependencyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(els.dependencyForm);
  const payload = {
    pred_type: fd.get('pred_type'),
    pred_id: Number(fd.get('pred_id')),
    succ_type: fd.get('succ_type'),
    succ_id: Number(fd.get('succ_id')),
    link_type: fd.get('link_type'),
    on_delay: fd.get('on_delay'),
  };
  const editId = els.dependencyForm.dataset.editId;
  try {
    if (editId) {
      await api('PUT', `/api/dependencies/${editId}`, payload);
    } else {
      await api('POST', '/api/dependencies', payload);
    }
    closeDependencyModal();
    await refreshAll();
  } catch (err) {
    const map = {
      cycle_detected: '순환 의존이 발생합니다.',
      self_loop: '자기 자신을 가리킬 수 없습니다.',
      container_cycle: '카테고리와 그 안의 스케줄 사이에는 의존을 걸 수 없습니다.',
      pred_not_found: '선행 대상을 찾을 수 없습니다. 방금 만든 카테고리/스케줄이라면 새로고침 후 다시 시도해주세요.',
      succ_not_found: '후행 대상을 찾을 수 없습니다. 방금 만든 카테고리/스케줄이라면 새로고침 후 다시 시도해주세요.',
      not_found: '편집 중이던 의존성이 이미 삭제된 것 같습니다. 페이지를 새로고침해주세요.',
      duplicate: '동일한 의존이 이미 존재합니다.',
      invalid_id: '선택된 항목의 ID 가 올바르지 않습니다.',
      invalid_entity_type: '선행/후행 종류가 올바르지 않습니다.',
      invalid_link_type: '연결 유형이 올바르지 않습니다.',
      invalid_on_delay: '충돌 시 동작값이 올바르지 않습니다.',
    };
    alert(map[err.message] || `저장 실패 (${err.message})`);
  }
});

els.dependencyRows.addEventListener('click', async (e) => {
  // Pill clicks: cycle link_type or on_delay in place.
  const linkPill = e.target.closest('.link-pill[data-action="cycle-link"]');
  if (linkPill) {
    const id = Number(linkPill.dataset.id);
    const dep = state.dependencies.find((d) => d.id === id);
    if (!dep) return;
    const next = dep.link_type === 'strong' ? 'weak' : 'strong';
    try {
      await api('PUT', `/api/dependencies/${id}`, { link_type: next });
      await loadDependencies();
      renderDependencies();
    } catch (err) {
      alert(`유형 변경 실패: ${err.message}`);
    }
    return;
  }
  const delayPill = e.target.closest('.delay-pill[data-action="cycle-delay"]');
  if (delayPill) {
    const id = Number(delayPill.dataset.id);
    const dep = state.dependencies.find((d) => d.id === id);
    if (!dep || dep.link_type !== 'strong') return;
    const next = dep.on_delay === 'auto_shift' ? 'warn_only' : 'auto_shift';
    try {
      await api('PUT', `/api/dependencies/${id}`, { on_delay: next });
      await loadDependencies();
      renderDependencies();
    } catch (err) {
      alert(`충돌 시 동작 변경 실패: ${err.message}`);
    }
    return;
  }

  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  const id = Number(btn.dataset.id);
  const dep = state.dependencies.find((d) => d.id === id);
  if (!dep) return;

  if (btn.dataset.action === 'edit-dep') {
    openDependencyModal(dep);
  } else if (btn.dataset.action === 'delete-dep') {
    if (!confirm('이 의존성을 삭제하시겠습니까?')) return;
    await api('DELETE', `/api/dependencies/${id}`);
    await refreshAll();
  }
});

// Modal close + click-outside
document.querySelectorAll('[data-close]').forEach((btn) => {
  btn.addEventListener('click', () => {
    closeCategoryModal();
    closeScheduleModal();
    closeDependencyModal();
    els.dependencyCreateModal.classList.add('hidden');
    closeReportModal();
  });
});
[
  els.categoryModal,
  els.scheduleModal,
  els.dependencyModal,
  els.dependencyCreateModal,
  els.reportModal,
].forEach((m) => {
  m.addEventListener('click', (e) => {
    if (e.target !== m) return;
    // Use the canonical close path for the report modal so meta box and
    // editing state get cleared properly.
    if (m === els.reportModal) {
      closeReportModal();
    } else {
      m.classList.add('hidden');
    }
  });
});

// ---------- Reports ----------
function filteredReports() {
  const q = state.reportQuery.trim().toLowerCase();
  if (!q) return state.reports;
  return state.reports.filter((r) => {
    if ((r.body || '').toLowerCase().includes(q)) return true;
    if ((r.report_date || '').includes(q)) return true;
    if ((r.categories || []).some((c) => (c.name || '').toLowerCase().includes(q))) return true;
    return false;
  });
}

function renderReports() {
  els.reportRows.innerHTML = '';
  const visible = filteredReports();
  if (visible.length === 0) {
    const tr = document.createElement('tr');
    const td = document.createElement('td');
    td.colSpan = 5;
    td.className = 'muted';
    td.style.textAlign = 'center';
    td.style.padding = '16px';
    td.textContent = state.reports.length === 0
      ? '리포트가 없습니다. 간트의 날짜를 클릭한 뒤 막대를 클릭해 작성하세요.'
      : '검색 결과가 없습니다.';
    tr.appendChild(td);
    els.reportRows.appendChild(tr);
    return;
  }
  for (const r of visible) {
    const tags = r.categories
      .map((c) => `<span class="cat-tag">${escapeHtml(c.name)}</span>`)
      .join('');
    // Preserve newlines (CSS .preview-cell handles white-space + clamp).
    const preview = (r.body || '');
    const tr = document.createElement('tr');
    tr.className = 'report-row';
    tr.dataset.id = r.id;
    tr.innerHTML = `
      <td>${r.report_date}</td>
      <td class="preview-cell">${linkifyHtml(preview) || '<span class="muted">(빈 본문)</span>'}</td>
      <td>${tags || '<span class="muted">—</span>'}</td>
      <td>${r.attachments.length > 0 ? `${r.attachments.length}개` : '<span class="muted">—</span>'}</td>
      <td class="actions">
        <button class="btn btn-danger" data-action="delete-report" data-id="${r.id}">삭제</button>
      </td>
    `;
    els.reportRows.appendChild(tr);
  }
}

function renderReportCategoryChecks(checked) {
  els.reportCategoryChecks.innerHTML = '';
  if (state.categories.length === 0) {
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = '카테고리를 먼저 만들어주세요.';
    els.reportCategoryChecks.appendChild(span);
    return;
  }
  for (const c of state.categories) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = 'category_id';
    cb.value = String(c.id);
    cb.checked = checked.includes(c.id);
    // Read-only viewers can open the report modal to read but must not be
    // able to flip category tags. `disabled` blocks label/keyboard/click
    // paths uniformly — `pointer-events: none` on the input alone misses
    // the label-click path since the input is nested inside its <label>.
    if (!state.canWrite) cb.disabled = true;
    lbl.append(cb, document.createTextNode(' ' + c.name));
    els.reportCategoryChecks.appendChild(lbl);
  }
}

function selectedCategoryIdsFromForm() {
  return Array.from(
    els.reportCategoryChecks.querySelectorAll('input[type="checkbox"]:checked')
  ).map((el) => Number(el.value));
}

function renderAttachmentList(savedAttachments) {
  els.attachmentList.innerHTML = '';
  // Show saved attachments (from server) followed by pending ones (in-memory,
  // only present in create mode before first save).
  const items = [
    ...savedAttachments.map((a) => ({ saved: true, ...a })),
    ...state.pendingAttachments.map((p, idx) => ({ pending: true, pendingIdx: idx, ...p })),
  ];
  if (items.length === 0) {
    const li = document.createElement('li');
    li.className = 'muted';
    li.textContent = '첨부 없음';
    els.attachmentList.appendChild(li);
    return;
  }
  for (const a of items) {
    const li = document.createElement('li');
    const kindLabel = a.kind === 'upload' ? '업로드' : '로컬';
    let body;
    if (a.pending) {
      // Not yet on server — no clickable link. Show name + (for local) the path.
      if (a.kind === 'upload') {
        body = `<span class="att-name">${escapeHtml(a.display_name)}</span><span class="att-path">(저장 시 업로드됨)</span>`;
      } else {
        body = `
          <span class="att-name">${escapeHtml(a.display_name)}</span>
          <span class="att-path">${escapeHtml(a.path)} (저장 시 등록됨)</span>
          <button type="button" class="btn" data-action="copy-path" data-path="${escapeHtml(a.path)}">복사</button>
        `;
      }
    } else if (a.kind === 'upload') {
      body = `<a class="att-name" href="/uploads/${encodeURIComponent(a.path)}" target="_blank" rel="noopener">${escapeHtml(a.display_name)}</a>`;
    } else {
      const fileHref = toFileHref(a.path);
      body = `
        <a class="att-name" href="${escapeHtml(fileHref)}" target="_blank" rel="noopener" title="브라우저에서 열리지 않으면 '복사' 버튼을 사용하세요">${escapeHtml(a.display_name)}</a>
        <span class="att-path">${escapeHtml(a.path)}</span>
        <button type="button" class="btn" data-action="copy-path" data-path="${escapeHtml(a.path)}">복사</button>
      `;
    }
    const deleteId = a.pending ? `pending-${a.pendingIdx}` : String(a.id);
    li.innerHTML = `
      <span class="att-kind ${a.kind}${a.pending ? ' pending' : ''}">${kindLabel}${a.pending ? ' · 대기' : ''}</span>
      ${body}
      <button type="button" class="btn btn-danger" data-action="delete-attachment" data-id="${deleteId}">삭제</button>
    `;
    els.attachmentList.appendChild(li);
  }
}

function toFileHref(p) {
  // Convert filesystem path to file:// href.
  // Windows UNC: \\server\share\file → file:////server/share/file
  if (p.startsWith('\\\\')) {
    return 'file:////' + p.slice(2).replace(/\\/g, '/');
  }
  // Windows drive: C:\foo → file:///C:/foo
  if (/^[A-Za-z]:\\/.test(p)) {
    return 'file:///' + p.replace(/\\/g, '/');
  }
  // POSIX absolute: /foo → file:///foo
  if (p.startsWith('/')) {
    return 'file://' + p;
  }
  // Otherwise return as-is.
  return p;
}

function openReportModal(report) {
  state.editingReportId = report ? report.id : null;
  state.pendingAttachments = []; // always reset; only used in create mode
  els.reportModalTitle.textContent = report ? '리포트 편집' : '리포트 작성';
  els.reportForm.reset();

  if (report) {
    els.reportForm.report_date.value = report.report_date;
    els.reportForm.body.value = report.body || '';
    renderReportCategoryChecks(report.categories.map((c) => c.id));
    renderAttachmentList(report.attachments);
    // If editing a report linked to schedules, show meta for the first one.
    // Multi-schedule UI is a future iteration.
    if (report.schedules && report.schedules.length) {
      renderReportMetaBox(report.schedules[0], report.report_date);
    } else {
      hideReportMetaBox();
    }
  } else {
    const today = new Date().toISOString().slice(0, 10);
    els.reportForm.report_date.value = today;
    const initial = state.selectedCategoryId ? [state.selectedCategoryId] : [];
    renderReportCategoryChecks(initial);
    renderAttachmentList([]); // pending list (initially empty)
    hideReportMetaBox();
  }
  // Attachments section is always visible — file uploads / local paths are
  // buffered client-side until the report is saved (POST flushes them).
  els.attachmentsSection.classList.remove('hidden');
  els.reportModal.classList.remove('hidden');
}

// Open the report modal for a specific (date, schedule) pair from a Gantt
// bar click in date-sticky mode. Looks up an existing report tied to that
// (date, schedule) pair; opens it in edit mode if found, otherwise creates
// a new one with date + category + schedule auto-prefilled.
async function openReportModalForDateAndSchedule(date, schedule) {
  state.reportLinkedSchedule = { schedule, date };
  let existing = null;
  try {
    const rows = await api(
      'GET',
      `/api/reports?schedule_id=${schedule.id}&date=${date}`
    );
    if (Array.isArray(rows) && rows.length > 0) existing = rows[0];
  } catch (e) {
    // ignore — fall through to create flow
  }
  if (existing) {
    openReportModal(existing);
    // Override meta box with the click-context schedule (in case editing
    // surfaces a different schedule first in the array).
    renderReportMetaBox(schedule, date);
  } else {
    // Open in create mode but with date + category + schedule prefilled.
    state.editingReportId = null;
    state.pendingAttachments = [];
    els.reportModalTitle.textContent = '리포트 작성';
    els.reportForm.reset();
    els.reportForm.report_date.value = date;
    els.reportForm.body.value = '';
    renderReportCategoryChecks([schedule.category_id]);
    renderAttachmentList([]);
    renderReportMetaBox(schedule, date);
    els.attachmentsSection.classList.remove('hidden');
    els.reportModal.classList.remove('hidden');
  }
}

function renderReportMetaBox(schedule, date) {
  const cat = state.categories.find((c) => c.id === schedule.category_id);
  const days =
    daysBetweenInclusive(schedule.planned_start, schedule.planned_end) || 0;
  const status = schedule.status || '';
  const desc = (schedule.description || '').trim();
  const catPill = cat
    ? `<span class="schedule-cat-pill" style="background:${cat.color || '#e7eeff'}26;color:${cat.color || '#1f5fc9'}">${escapeHtml(cat.name)}</span>`
    : '';
  els.reportMetaBox.innerHTML = `
    <div class="meta-row"><div class="meta-label">카테고리</div><div class="meta-value">${catPill}</div></div>
    <div class="meta-row"><div class="meta-label">스케줄</div><div class="meta-value"><b>${escapeHtml(schedule.title)}</b></div></div>
    <div class="meta-row"><div class="meta-label">기간</div><div class="meta-value">${schedule.planned_start} ~ ${schedule.planned_end} (${days}일)</div></div>
    <div class="meta-row"><div class="meta-label">상태</div><div class="meta-value">${escapeHtml(status)}</div></div>
    ${desc ? `<div class="meta-row"><div class="meta-label">설명</div><div class="meta-value">${escapeHtml(desc)}</div></div>` : ''}
    <div class="meta-row"><div class="meta-label">리포트 날짜</div><div class="meta-value"><b>${date}</b></div></div>
  `;
  els.reportMetaBox.classList.remove('hidden');
}

function hideReportMetaBox() {
  els.reportMetaBox.classList.add('hidden');
  els.reportMetaBox.innerHTML = '';
  state.reportLinkedSchedule = null;
}

function closeReportModal() {
  els.reportModal.classList.add('hidden');
  state.editingReportId = null;
  // hideReportMetaBox already nulls state.reportLinkedSchedule, but state it
  // explicitly here too — close paths (cancel button / backdrop / save) all
  // funnel through this function and the link should never survive a close.
  state.reportLinkedSchedule = null;
  hideReportMetaBox();
}

els.reportRows.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (btn) {
    if (btn.dataset.action === 'delete-report') {
      const id = Number(btn.dataset.id);
      if (!confirm('이 리포트를 삭제하시겠습니까? (첨부 파일도 함께 삭제됨)')) return;
      await api('DELETE', `/api/reports/${id}`);
      await refreshReportsForScope();
    }
    e.stopPropagation();
    return;
  }
  // Don't hijack link clicks inside the preview cell — let the browser
  // navigate to the URL instead of opening the edit modal.
  if (e.target.closest('a')) return;
  // Click on the row itself → open in edit mode.
  const tr = e.target.closest('tr.report-row');
  if (!tr) return;
  const id = Number(tr.dataset.id);
  const r = state.reports.find((x) => x.id === id);
  if (r) openReportModal(r);
});

els.reportForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(els.reportForm);
  const payload = {
    report_date: fd.get('report_date'),
    body: fd.get('body') || '',
    category_ids: selectedCategoryIdsFromForm(),
  };
  // When the modal was opened from a Gantt bar click, persist the
  // (report ↔ schedule) link so the same (date, schedule) opens this
  // report next time.
  if (state.reportLinkedSchedule) {
    payload.schedule_ids = [state.reportLinkedSchedule.schedule.id];
  }
  try {
    if (state.editingReportId) {
      await api('PUT', `/api/reports/${state.editingReportId}`, payload);
    } else {
      const created = await api('POST', '/api/reports', payload);
      // Flush pending uploads now that we have a report id.
      for (const pa of state.pendingAttachments) {
        try {
          const f = new FormData();
          f.append('file', pa.file);
          const res = await fetch(
            `/api/reports/${created.id}/attachments/upload`,
            { method: 'POST', body: f }
          );
          if (!res.ok) console.error('Pending upload failed:', pa.display_name);
        } catch (err) {
          console.error('Pending attachment error:', err);
        }
      }
    }
    closeReportModal();
    await refreshReportsForScope();
  } catch (err) {
    alert(`저장 실패: ${err.message}`);
  }
});

// Refresh reports for the current scope (per-category panel OR all-reports view).
async function refreshReportsForScope() {
  if (state.scope === 'all-reports') {
    await loadAllReports();
    renderAllReportsView();
  } else if (state.selectedCategoryId) {
    await loadReports(state.selectedCategoryId);
    renderReports();
  }
}

// ---------- Attachments ----------
async function reloadEditingReport() {
  if (!state.editingReportId) return;
  const r = await api('GET', `/api/reports/${state.editingReportId}`);
  renderAttachmentList(r.attachments);
  await refreshReportsForScope();
}

els.attachmentFileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  if (state.editingReportId) {
    // Existing report: upload to server immediately.
    const fd = new FormData();
    fd.append('file', file);
    try {
      const res = await fetch(
        `/api/reports/${state.editingReportId}/attachments/upload`,
        { method: 'POST', body: fd }
      );
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.error || `HTTP ${res.status}`);
      }
      e.target.value = '';
      await reloadEditingReport();
    } catch (err) {
      alert(`업로드 실패: ${err.message}`);
    }
  } else {
    // New report (no id yet): buffer until report is saved.
    state.pendingAttachments.push({
      kind: 'upload',
      file,
      display_name: file.name,
    });
    e.target.value = '';
    renderAttachmentList([]);
  }
});


els.attachmentList.addEventListener('click', async (e) => {
  const btn = e.target.closest('button[data-action]');
  if (!btn) return;
  if (btn.dataset.action === 'delete-attachment') {
    const rawId = btn.dataset.id || '';
    if (rawId.startsWith('pending-')) {
      // Pending attachment — just drop from in-memory buffer.
      const idx = Number(rawId.slice('pending-'.length));
      state.pendingAttachments.splice(idx, 1);
      renderAttachmentList([]);
      return;
    }
    if (!confirm('이 첨부를 삭제하시겠습니까?')) return;
    await api('DELETE', `/api/attachments/${Number(rawId)}`);
    await reloadEditingReport();
  } else if (btn.dataset.action === 'copy-path') {
    const path = btn.dataset.path;
    try {
      await navigator.clipboard.writeText(path);
      btn.textContent = '복사됨';
      setTimeout(() => { btn.textContent = '복사'; }, 1500);
    } catch (err) {
      alert(`복사 실패: ${err.message}\n수동으로 복사하세요:\n${path}`);
    }
  }
});

// ---------- Schedule view toggle + search ----------
els.viewBtns.forEach((btn) => {
  btn.addEventListener('click', () => {
    state.scheduleView = btn.dataset.view;
    els.viewBtns.forEach((b) => b.classList.toggle('active', b === btn));
    renderSchedules();
  });
});

els.scheduleSearch.addEventListener('input', (e) => {
  state.scheduleQuery = e.target.value || '';
  renderSchedules();
});

// ---------- All view + expand-connected toggle ----------
els.allViewBtn.addEventListener('click', () => {
  selectAllView();
});

els.expandConnectedBtn.addEventListener('click', () => {
  state.expandConnected = !state.expandConnected;
  els.expandConnectedBtn.classList.toggle('active', state.expandConnected);
  els.expandConnectedBtn.textContent = state.expandConnected
    ? '연결 포함 ON'
    : '연결 포함 OFF';
  renderSchedules();
});

els.showArrowsBtn.addEventListener('click', () => {
  state.showArrows = !state.showArrows;
  els.showArrowsBtn.classList.toggle('active', state.showArrows);
  els.showArrowsBtn.textContent = state.showArrows ? '화살표 ON' : '화살표 OFF';
  renderSchedules();
});

// Chain-sort toggle: keep schedules tied by strong edges as a single chain
// (predecessor immediately above its direct successor) rather than a flat
// minStart-first topological order. Persisted to localStorage so the user's
// preference survives reloads.
state.chainSort = localStorage.getItem('chainSort') === '1';
els.chainSortBtn.classList.toggle('active', state.chainSort);
els.chainSortBtn.textContent = state.chainSort ? '체인정렬 ON' : '체인정렬 OFF';
els.chainSortBtn.addEventListener('click', () => {
  state.chainSort = !state.chainSort;
  localStorage.setItem('chainSort', state.chainSort ? '1' : '0');
  els.chainSortBtn.classList.toggle('active', state.chainSort);
  els.chainSortBtn.textContent = state.chainSort ? '체인정렬 ON' : '체인정렬 OFF';
  renderSchedules();
});

els.reportSearch.addEventListener('input', (e) => {
  state.reportQuery = e.target.value || '';
  renderReports();
});

// ---------- All-reports view ----------
function reportMatchesQuery(r, q) {
  if (!q) return true;
  if ((r.body || '').toLowerCase().includes(q)) return true;
  if ((r.report_date || '').includes(q)) return true;
  if ((r.categories || []).some((c) => (c.name || '').toLowerCase().includes(q))) return true;
  if ((r.schedules || []).some((s) => (s.title || '').toLowerCase().includes(q))) return true;
  return false;
}

// Inclusive date-range filter. Empty bound = unbounded on that side.
// `report_date` is stored as YYYY-MM-DD so lexicographic comparison with the
// date input value (also YYYY-MM-DD) is correct without parsing.
function reportInDateRange(r, from, to) {
  const d = r.report_date || '';
  if (from && d < from) return false;
  if (to && d > to) return false;
  return true;
}

function renderAllReportsView() {
  const root = els.allReportsContent;
  root.innerHTML = '';

  // Sync the 담당자 dropdown — visible only when team mode is ON.
  syncAllReportsOwnerOptions();

  const q = state.allReportsQuery.trim().toLowerCase();
  const from = state.allReportsDateFrom;
  const to = state.allReportsDateTo;
  const ownerSel = state.allReportsOwner;
  const ownReports = (ownerSel && ownerSel !== '__self' && ownerSel !== '')
    ? []
    : state.allReports.filter(
        (r) => reportMatchesQuery(r, q) && reportInDateRange(r, from, to)
      );
  const teamReports = teamOn()
    ? state.team.merged.reports.filter(
        (r) => reportMatchesQuery(r, q) && reportInDateRange(r, from, to) &&
               (!ownerSel || ownerSel === r.owner)
      )
    : [];
  const filtered = ownReports.concat(teamReports);

  const filterActive = Boolean(q || from || to);
  els.allReportsSummary.textContent = filterActive
    ? `검색 결과 ${filtered.length}건 / 전체 ${state.allReports.length}건${
        from || to ? ` · 기간: ${from || '처음'} ~ ${to || '끝'}` : ''
      }`
    : `전체 ${state.allReports.length}건`;
  els.allReportsSearch.value = state.allReportsQuery;
  els.allReportsDateFrom.value = state.allReportsDateFrom;
  els.allReportsDateTo.value = state.allReportsDateTo;

  if (filtered.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty muted';
    empty.textContent = state.allReports.length === 0
      ? '아직 작성된 리포트가 없습니다.'
      : '검색 결과가 없습니다.';
    root.appendChild(empty);
    return;
  }

  // Group reports by category. A report with multiple tags appears under each.
  const byCat = new Map(); // categoryId → { cat, reports[] }
  const noCat = [];
  for (const r of filtered) {
    if (!r.categories || r.categories.length === 0) {
      noCat.push(r);
      continue;
    }
    for (const cat of r.categories) {
      // (owner, id) composite key so own and team categories with the same
      // numeric id don't collide into the same section.
      const key = `${cat.owner || ''}:${cat.id}`;
      if (!byCat.has(key)) byCat.set(key, { cat, reports: [] });
      byCat.get(key).reports.push(r);
    }
  }

  // Render sections: own categories first (sorted by id), then team categories
  // grouped by owner (alphabetical), each group sorted by id.
  const sections = [...byCat.values()].sort((a, b) => {
    const ao = a.cat.owner ? 1 : 0;
    const bo = b.cat.owner ? 1 : 0;
    if (ao !== bo) return ao - bo;
    if (ao && a.cat.owner !== b.cat.owner) {
      return a.cat.owner < b.cat.owner ? -1 : 1;
    }
    return a.cat.id - b.cat.id;
  });
  if (noCat.length > 0) {
    sections.push({ cat: { id: -1, name: '태그 없음', color: '#9aa1ad' }, reports: noCat });
  }

  // Build one <li> for a report inside the current category section.
  // sectionCatId lets us hide that category from "other tags" so the user
  // doesn't see the section's own pill repeated.
  // hidePillForScheduleId optionally hides one schedule pill (used in
  // schedule-group mode where the group header already names that schedule).
  function buildReportLi(r, sectionCatId, hidePillForScheduleId) {
    const li = document.createElement('li');
    li.dataset.reportId = String(r.id);
    if (r.owner) {
      li.classList.add('team-readonly');
      li.dataset.owner = r.owner;
    }

    const preview = (r.body || '').replace(/[ \t]+/g, ' ').trim();
    const previewHtml = preview
      ? linkifyHtml(preview)
      : '<span class="muted">(빈 본문)</span>';

    const attChips = (r.attachments || []).map((a) => {
      if (a.kind === 'upload') {
        return `<a class="att-chip" href="/uploads/${encodeURIComponent(a.path)}" target="_blank" rel="noopener" title="${escapeHtml(a.display_name)}">📎 ${escapeHtml(a.display_name)}</a>`;
      }
      const href = toFileHref(a.path);
      return `<a class="att-chip" href="${escapeHtml(href)}" target="_blank" rel="noopener" title="${escapeHtml(a.path)}">📁 ${escapeHtml(a.display_name)}</a>`;
    }).join('');

    const otherTags = (r.categories || [])
      .filter((c) => c.id !== sectionCatId)
      .map((c) => {
        const bg = c.color || '#9aa1ad';
        return `<span class="cat-tag mini" style="background:${escapeHtml(bg)}; color:${inkOn(bg)};">${escapeHtml(c.name)}</span>`;
      })
      .join('');

    const schedPills = (r.schedules || [])
      .filter((s) => s.id !== hidePillForScheduleId)
      .map((s) => {
        const sCat = findCategoryForSchedule(s);
        const bg = (sCat && sCat.color) || '#1f5fc9';
        return `<span class="schedule-pill" style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(s.title)}</span>`;
      }).join('');

    li.innerHTML = `
      ${schedPills ? `<div class="report-item-schedules">${schedPills}</div>` : ''}
      <div class="report-item-body">${previewHtml}</div>
      <div class="report-item-meta">
        ${attChips || '<span class="muted">첨부 없음</span>'}
        ${otherTags ? `<span class="other-tags">${otherTags}</span>` : ''}
        ${teamOwnerSuffix(r.owner)}
      </div>
    `;
    return li;
  }

  // Render a date-grouped block (used by both modes): h4 header per date +
  // an <ol> of report items. ASC date order; within a date, ASC by id.
  function appendDateGroups(parent, reports, sectionCatId, hidePillForScheduleId) {
    const byDate = new Map();
    for (const r of reports) {
      if (!byDate.has(r.report_date)) byDate.set(r.report_date, []);
      byDate.get(r.report_date).push(r);
    }
    const dates = [...byDate.keys()].sort();
    for (const date of dates) {
      const dateGroup = document.createElement('div');
      dateGroup.className = 'reports-date-group';
      const dateHead = document.createElement('h4');
      dateHead.textContent = date;
      dateGroup.appendChild(dateHead);

      const list = document.createElement('ol');
      list.className = 'all-reports-list';
      const dayReports = byDate.get(date).slice().sort((a, b) => a.id - b.id);
      for (const r of dayReports) {
        list.appendChild(buildReportLi(r, sectionCatId, hidePillForScheduleId));
      }
      dateGroup.appendChild(list);
      parent.appendChild(dateGroup);
    }
  }

  for (const { cat, reports: catReports } of sections) {
    const section = document.createElement('section');
    section.className = 'reports-cat-section';

    const head = document.createElement('div');
    head.className = 'reports-cat-head';
    const catBg = cat.color || '#9aa1ad';
    head.innerHTML = `
      <span class="cat-tag" style="background:${escapeHtml(catBg)}; color:${inkOn(catBg)};">${escapeHtml(cat.name)}</span>${teamOwnerSuffix(cat.owner)}
      <span class="muted">${catReports.length}건</span>
    `;
    if (cat.owner) section.classList.add('team-readonly');
    section.appendChild(head);

    if (state.allReportsBySchedule) {
      // [schedule → date → reports] tree. A report appears once per linked
      // schedule that belongs to THIS category (other categories' schedules
      // for the same report show up under their own category section).
      // Reports with no linked schedule (legacy data) collect under a single
      // "스케줄 없음" group.
      const bySched = new Map(); // schedule.id → { sched, reports[] }
      const noSched = [];
      for (const r of catReports) {
        const inThisCat = (r.schedules || []).filter(
          (s) => s.category_id === cat.id
        );
        if (inThisCat.length === 0) {
          noSched.push(r);
          continue;
        }
        for (const s of inThisCat) {
          if (!bySched.has(s.id)) bySched.set(s.id, { sched: s, reports: [] });
          bySched.get(s.id).reports.push(r);
        }
      }
      const schedGroups = [...bySched.values()].sort((a, b) => {
        // Order by schedule planned_start ASC, then id — so the on-screen
        // sequence within a category mirrors the Gantt's chronological flow.
        const ka = a.sched.planned_start || '9999-12-31';
        const kb = b.sched.planned_start || '9999-12-31';
        if (ka !== kb) return ka < kb ? -1 : 1;
        return a.sched.id - b.sched.id;
      });
      for (const { sched, reports: schedReports } of schedGroups) {
        const schedGroup = document.createElement('div');
        schedGroup.className = 'reports-sched-group';
        const schedHead = document.createElement('h3');
        schedHead.className = 'reports-sched-head';
        const bg = cat.color || '#c9a55a';
        schedHead.innerHTML = `
          <span class="schedule-pill" style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(sched.title)}</span>
          <span class="muted">${schedReports.length}건</span>
        `;
        schedGroup.appendChild(schedHead);
        appendDateGroups(schedGroup, schedReports, cat.id, sched.id);
        section.appendChild(schedGroup);
      }
      if (noSched.length > 0) {
        const orphan = document.createElement('div');
        orphan.className = 'reports-sched-group';
        const orphanHead = document.createElement('h3');
        orphanHead.className = 'reports-sched-head';
        orphanHead.innerHTML = `<span class="muted">스케줄 없음 (${noSched.length}건)</span>`;
        orphan.appendChild(orphanHead);
        appendDateGroups(orphan, noSched, cat.id, null);
        section.appendChild(orphan);
      }
    } else {
      // Default mode: [date → reports]. ASC ordering throughout — older
      // dates above newer; within a date, earlier id (creation) above.
      appendDateGroups(section, catReports, cat.id, null);
    }

    root.appendChild(section);
  }
}

els.allReportsBtn.addEventListener('click', () => {
  selectAllReportsView();
});

els.allReportsSearch.addEventListener('input', (e) => {
  state.allReportsQuery = e.target.value || '';
  renderAllReportsView();
});

// 스케줄별 그룹 토글 — 카테고리 안에서 [schedule → date → reports] 트리로 표시.
// localStorage 에 영속화해 화면 새로고침 후에도 유지.
state.allReportsBySchedule = localStorage.getItem('allReportsBySchedule') === '1';
function syncBySchedBtn() {
  els.allReportsByScheduleBtn.classList.toggle('active', state.allReportsBySchedule);
  els.allReportsByScheduleBtn.textContent = state.allReportsBySchedule
    ? '스케줄별 ON'
    : '스케줄별 OFF';
}
syncBySchedBtn();
els.allReportsByScheduleBtn.addEventListener('click', () => {
  state.allReportsBySchedule = !state.allReportsBySchedule;
  localStorage.setItem('allReportsBySchedule', state.allReportsBySchedule ? '1' : '0');
  syncBySchedBtn();
  renderAllReportsView();
});

els.allReportsDateFrom.addEventListener('input', (e) => {
  state.allReportsDateFrom = e.target.value || '';
  renderAllReportsView();
});
els.allReportsDateTo.addEventListener('input', (e) => {
  state.allReportsDateTo = e.target.value || '';
  renderAllReportsView();
});
els.allReportsDateClear.addEventListener('click', () => {
  state.allReportsDateFrom = '';
  state.allReportsDateTo = '';
  renderAllReportsView();
});

// Click on a report list item → open edit modal (skip if user clicked an
// attachment link inside).
els.allReportsContent.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const li = e.target.closest('li[data-report-id]');
  if (!li) return;
  const id = Number(li.dataset.reportId);
  // Team-owned report: open the read-only viewer (lookup by owner+id).
  if (li.classList.contains('team-readonly')) {
    const owner = li.dataset.owner || '';
    const r = state.team.merged.reports.find(
      (x) => x.id === id && x.owner === owner
    );
    if (r) openTeamReportViewer(r);
    return;
  }
  const r = state.allReports.find((x) => x.id === id);
  if (r) openReportModal(r);
});

function openTeamReportViewer(r) {
  const m = document.getElementById('team-report-viewer-modal');
  if (!m) return;
  document.getElementById('team-report-viewer-owner').textContent = r.owner || '';
  document.getElementById('team-report-viewer-date').textContent = r.report_date || '';

  const catsEl = document.getElementById('team-report-viewer-cats');
  const scheds = r.schedules || [];
  const cats = r.categories || [];
  catsEl.innerHTML = cats.length
    ? `<span class="muted">카테고리</span> ${cats.map((c) => {
        const bg = c.color || '#9aa1ad';
        return `<span class="cat-tag mini" style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(c.name)}</span>`;
      }).join(' ')}`
    : '';

  const schedsEl = document.getElementById('team-report-viewer-scheds');
  schedsEl.innerHTML = scheds.length
    ? `<span class="muted">스케줄</span> ${scheds.map((s) => {
        const sCat = findCategoryForSchedule(s);
        const bg = (sCat && sCat.color) || '#1f5fc9';
        return `<span class="schedule-pill" style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(s.title)}</span>`;
      }).join(' ')}`
    : '';

  const body = (r.body || '').trim();
  document.getElementById('team-report-viewer-body').innerHTML = body
    ? linkifyHtml(body)
    : '<span class="muted">(빈 본문)</span>';

  const attEl = document.getElementById('team-report-viewer-attachments');
  attEl.innerHTML = '';
  for (const a of (r.attachments || [])) {
    if (a.kind === 'upload' && a.peerHost && a.peerPort) {
      // Direct download from the peer's static /uploads/ path. Opens in a
      // new tab; the browser handles either inline rendering or download.
      const href = `http://${encodeURIComponent(a.peerHost)}:${Number(a.peerPort)}/uploads/${encodeURIComponent(a.path)}`;
      const link = document.createElement('a');
      link.className = 'att-chip';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = a.display_name;
      link.textContent = `📎 ${a.display_name}`;
      attEl.appendChild(link);
    } else {
      // local_path attachments live on the peer's filesystem and aren't
      // reachable from here. Show as text-only with a hint.
      const span = document.createElement('span');
      span.className = 'att-chip-readonly';
      span.title = `원격 사용자 로컬 경로: ${a.path}`;
      span.textContent = `📁 ${a.display_name} (원격 로컬)`;
      attEl.appendChild(span);
    }
  }
  if (!r.attachments || r.attachments.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted';
    empty.style.fontSize = '12px';
    empty.textContent = '첨부 없음';
    attEl.appendChild(empty);
  }

  m.classList.remove('hidden');
}

// ---------- Resizable table columns ----------
// Each .schedules.resizable table starts with widths declared via inline
// style on its <th>. Saved widths in localStorage take precedence so the
// user's manual adjustments persist across category switches and reloads.
function loadColWidths(tableId) {
  try {
    return JSON.parse(localStorage.getItem(`colwidths:${tableId}`) || 'null');
  } catch {
    return null;
  }
}
function saveColWidths(tableId, widths) {
  try {
    localStorage.setItem(`colwidths:${tableId}`, JSON.stringify(widths));
  } catch {
    /* quota / disabled — non-fatal */
  }
}
function makeTableResizable(tableEl) {
  if (!tableEl || !tableEl.id) return;
  const tableId = tableEl.id;
  const ths = Array.from(tableEl.querySelectorAll('thead th'));
  if (ths.length === 0) return;

  // Apply saved widths over the inline defaults.
  const saved = loadColWidths(tableId);
  if (Array.isArray(saved) && saved.length === ths.length) {
    ths.forEach((th, i) => {
      if (typeof saved[i] === 'number' && saved[i] > 0) {
        th.style.width = saved[i] + 'px';
      }
    });
  }

  ths.forEach((th, idx) => {
    if (idx === ths.length - 1) return; // last column has no handle
    if (th.querySelector('.col-resize-handle')) return; // idempotent
    const handle = document.createElement('div');
    handle.className = 'col-resize-handle';
    th.appendChild(handle);

    handle.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startWidth = th.offsetWidth;
      handle.classList.add('dragging');

      function onMove(ev) {
        const dx = ev.clientX - startX;
        const newWidth = Math.max(40, startWidth + dx);
        th.style.width = newWidth + 'px';
      }
      function onUp() {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        handle.classList.remove('dragging');
        const widths = ths.map((t) => t.offsetWidth);
        saveColWidths(tableId, widths);
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  });
}

// ---------- Init ----------
refreshAll().then(() => {
  if (!state.selectedCategoryId && state.categories.length > 0) {
    selectCategory(state.categories[0].id);
  }
});

// Make all resizable tables actually resizable (idempotent — runs once).
document.querySelectorAll('table.schedules.resizable').forEach(makeTableResizable);

// ---------- Team coworking UI ----------

state.team = {
  mode: 'OFF',
  self: { name: '', port: 0 },
  peers: [],
  lastSyncAt: null,
  pollTimer: null,
  merged: { categories: [], schedules: [], dependencies: [], reports: [] },
  mergedLoadedFor: null, // lastSyncAt that current merged data corresponds to
};

state.allReportsOwner = ''; // '' = all, '__self' = own only, '<peerName>' = that peer

// Helper: is the team mode ON and rendering integrated views?
function teamOn() { return state.team.mode === 'ON'; }

// Helper: produce the owner suffix span for a team-owned item. Returns
// empty string for own items so renderers can blindly append the result.
function teamOwnerSuffix(owner) {
  if (!owner) return '';
  return `<span class="team-owner-suffix">${escapeHtml(owner)}</span>`;
}

async function loadTeamMerged() {
  try {
    const res = await fetch('/api/team/merged');
    if (!res.ok) return;
    const d = await res.json();
    state.team.merged = {
      categories: d.categories || [],
      schedules: d.schedules || [],
      dependencies: d.dependencies || [],
      reports: d.reports || [],
    };
    state.team.mergedLoadedFor = d.lastSyncAt || null;
    // Re-render anything currently visible so team data appears.
    if (typeof renderCategories === 'function') renderCategories();
    if (typeof renderCategoryView === 'function') renderCategoryView();
    if (typeof renderAllReportsView === 'function' && state.scope === 'all-reports') renderAllReportsView();
  } catch { /* network blip */ }
}

const teamEls = {
  toggleBtn:     document.getElementById('team-toggle-btn'),
  statusBtn:     document.getElementById('team-status-btn'),
  refreshTopbarBtn: document.getElementById('team-refresh-topbar-btn'),
  statusModal:   document.getElementById('team-status-modal'),
  statusSummary: document.getElementById('team-status-summary'),
  peerList:      document.getElementById('team-peer-status-list'),
  refreshNowBtn: document.getElementById('team-refresh-now-btn'),
  toastContainer: document.getElementById('toast-container'),
};

const TEAM_STATUS_LABELS = {
  ok: '연결됨', loading: '연결 중', fail: '연결 실패', timeout: '타임아웃',
};

function teamFormatTime(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleTimeString('ko-KR', { hour12: false }); }
  catch { return iso; }
}

function showToast(message, type = 'info', durationMs = 3000) {
  if (!teamEls.toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  teamEls.toastContainer.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 0.3s';
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 320);
  }, durationMs);
}

let teamPrevSyncAt = null;
async function loadTeamState() {
  try {
    const res = await fetch('/api/team/state');
    if (!res.ok) return;
    applyTeamState(await res.json());
  } catch { /* network blip */ }
}

function applyTeamState(data) {
  state.team.mode = data.mode;
  if (data.self) state.team.self = data.self;
  state.team.peers = data.peers || [];
  state.team.lastSyncAt = data.lastSyncAt;

  teamEls.toggleBtn.textContent = `팀 전체계획 ${data.mode}`;
  teamEls.toggleBtn.classList.toggle('is-on', data.mode === 'ON');

  if (data.mode === 'ON') {
    teamEls.statusBtn.classList.remove('hidden');
    if (teamEls.refreshTopbarBtn) teamEls.refreshTopbarBtn.classList.remove('hidden');
    const total = state.team.peers.length;
    const okCount = state.team.peers.filter((p) => p.status === 'ok').length;
    const failed  = state.team.peers.filter((p) => p.status === 'fail' || p.status === 'timeout');
    teamEls.statusBtn.classList.toggle('has-failures', failed.length > 0);
    teamEls.statusBtn.textContent = total > 0 ? `상태 ${okCount}/${total}` : '상태';

    const allDone = total > 0 && state.team.peers.every((p) => p.status !== 'loading');
    if (allDone && data.lastSyncAt && data.lastSyncAt !== teamPrevSyncAt) {
      const failedNames = failed.map((p) => p.name).join(', ');
      if (failed.length === 0) {
        showToast(`팀원 ${total}명 동기화 완료`);
      } else if (okCount > 0) {
        showToast(`${okCount}명 동기화 완료 · 실패: ${failedNames}`);
      } else {
        showToast(`전원 연결 실패: ${failedNames}`, 'error');
      }
      teamPrevSyncAt = data.lastSyncAt;
    }
  } else {
    teamEls.statusBtn.classList.add('hidden');
    if (teamEls.refreshTopbarBtn) teamEls.refreshTopbarBtn.classList.add('hidden');
    teamPrevSyncAt = null;
  }

  renderTeamStatusModal();

  if (data.mode === 'ON' && !state.team.pollTimer) {
    state.team.pollTimer = setInterval(loadTeamState, 5000);
  } else if (data.mode === 'OFF' && state.team.pollTimer) {
    clearInterval(state.team.pollTimer);
    state.team.pollTimer = null;
  }

  // Refresh merged data whenever the server's lastSyncAt advances. Also fetch
  // once on the first ON state observation. When OFF, clear merged so views
  // stop showing team items immediately.
  if (data.mode === 'ON') {
    if (data.lastSyncAt && data.lastSyncAt !== state.team.mergedLoadedFor) {
      loadTeamMerged();
    }
  } else if (state.team.mergedLoadedFor !== null) {
    state.team.merged = { categories: [], schedules: [], dependencies: [], reports: [] };
    state.team.mergedLoadedFor = null;
    if (typeof renderCategories === 'function') renderCategories();
    if (typeof renderCategoryView === 'function') renderCategoryView();
    if (typeof renderAllReportsView === 'function' && state.scope === 'all-reports') renderAllReportsView();
  }
}

function renderTeamStatusModal() {
  if (!teamEls.peerList) return;
  const { peers, lastSyncAt } = state.team;
  teamEls.statusSummary.textContent = lastSyncAt
    ? `마지막 갱신: ${teamFormatTime(lastSyncAt)}`
    : '아직 갱신 전';
  teamEls.peerList.innerHTML = '';
  if (peers.length === 0) {
    const li = document.createElement('li');
    li.style.gridTemplateColumns = '1fr';
    li.className = 'muted';
    li.textContent = '등록된 팀원이 없습니다 (data/team_peers.csv 확인)';
    teamEls.peerList.appendChild(li);
    return;
  }
  for (const p of peers) {
    const li = document.createElement('li');
    const left = document.createElement('div');
    const nameDiv = document.createElement('div');
    nameDiv.className = 'team-peer-name';
    nameDiv.textContent = p.name;
    const hostDiv = document.createElement('div');
    hostDiv.className = 'team-peer-host';
    hostDiv.textContent = `${p.host || ''}:${p.port || ''}`;
    left.appendChild(nameDiv);
    left.appendChild(hostDiv);

    const stateLabel = document.createElement('span');
    stateLabel.className = `team-peer-state ${p.status}`;
    stateLabel.textContent = TEAM_STATUS_LABELS[p.status] || p.status;

    const time = document.createElement('span');
    time.className = 'team-peer-time';
    time.textContent = p.lastSuccessAt
      ? teamFormatTime(p.lastSuccessAt)
      : (p.lastError || '-');

    li.appendChild(left);
    li.appendChild(stateLabel);
    li.appendChild(time);
    teamEls.peerList.appendChild(li);
  }
}

async function toggleTeamMode() {
  try {
    const res = await fetch('/api/team/toggle', { method: 'POST' });
    if (!res.ok) { showToast('팀 모드 전환 실패', 'error'); return; }
    const data = await res.json();
    if (data.mode === 'ON') openTeamStatusModal();
    await loadTeamState();
  } catch (e) {
    showToast('팀 모드 전환 오류: ' + e.message, 'error');
  }
}

async function teamRefreshNow() {
  try {
    const res = await fetch('/api/team/sync', { method: 'POST' });
    if (!res.ok) { showToast('동기화 실패', 'error'); return; }
    await loadTeamState();
  } catch (e) {
    showToast('동기화 오류: ' + e.message, 'error');
  }
}

function openTeamStatusModal() {
  teamEls.statusModal.classList.remove('hidden');
  renderTeamStatusModal();
}
function closeTeamStatusModal() {
  teamEls.statusModal.classList.add('hidden');
}

// Sync the all-reports 담당자 dropdown options against the current peer list
// + own self.name. Hide the entire control when team mode is OFF (no peers
// to choose between). Preserve the current selection if the option still
// exists; otherwise fall back to "전체".
function syncAllReportsOwnerOptions() {
  const wrap = els.allReportsOwnerWrap;
  const sel = els.allReportsOwner;
  if (!wrap || !sel) return;
  if (!teamOn()) {
    wrap.classList.add('hidden');
    if (state.allReportsOwner) state.allReportsOwner = '';
    return;
  }
  wrap.classList.remove('hidden');

  const currentValue = state.allReportsOwner;
  const selfName = (state.team.self && state.team.self.name) || '';
  const peerNames = state.team.peers.map((p) => p.name);

  sel.innerHTML = '';
  const opts = [
    { value: '', label: '전체' },
    { value: '__self', label: selfName ? `${selfName} (본인)` : '본인' },
    ...peerNames.map((n) => ({ value: n, label: n })),
  ];
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  sel.value = opts.some((o) => o.value === currentValue) ? currentValue : '';
  state.allReportsOwner = sel.value;
}

if (els.allReportsOwner) {
  els.allReportsOwner.addEventListener('change', () => {
    state.allReportsOwner = els.allReportsOwner.value;
    if (typeof renderAllReportsView === 'function') renderAllReportsView();
  });
}

// Team server-side events: peer CSV reloads, peer-update broadcasts received,
// CSV validation errors. Polled every 8s regardless of toggle state. The first
// poll only catches up `seq` so already-buffered events from before this page
// loaded don't all dump as toasts.
let teamEventSeq = 0;
let teamEventInitial = true;
async function pollTeamEvents() {
  try {
    const res = await fetch(`/api/team/events?since=${teamEventSeq}`);
    if (!res.ok) return;
    const { events: list, latestSeq } = await res.json();
    if (typeof latestSeq === 'number') teamEventSeq = Math.max(teamEventSeq, latestSeq);
    if (teamEventInitial) {
      teamEventInitial = false;
      return;
    }
    for (const ev of list) handleTeamEvent(ev);
  } catch { /* network blip */ }
}

function handleTeamEvent(ev) {
  if (ev.kind === 'csv_reload') {
    showToast('peer 목록 갱신됨', 'info', 2500);
    refreshTeamManageListIfOpen();
  } else if (ev.kind === 'peer_update_received') {
    const origin = ev.detail.origin || '?';
    const names = (ev.detail.entries || []).map((e) => e.name).join(', ');
    showToast(`${origin}이(가) '${names}'의 정보를 갱신했습니다`, 'info', 4000);
    refreshTeamManageListIfOpen();
  } else if (ev.kind === 'peer_remove_received') {
    const origin = ev.detail.origin || '?';
    const names = (ev.detail.names || []).join(', ');
    showToast(`${origin}이(가) '${names}'을(를) 삭제했습니다`, 'info', 4000);
    refreshTeamManageListIfOpen();
  } else if (ev.kind === 'csv_validation_error') {
    const errs = (ev.detail.errors || [])
      .map((e) => `${e.line}행: ${e.message}`)
      .slice(0, 3)
      .join(' · ');
    showToast(`CSV 검증 실패 — ${errs}`, 'error', 6000);
  }
}

function refreshTeamManageListIfOpen() {
  if (teamManageEls && teamManageEls.modal &&
      !teamManageEls.modal.classList.contains('hidden') &&
      typeof refreshTeamManageList === 'function') {
    refreshTeamManageList();
  }
}

setInterval(pollTeamEvents, 8000);
pollTeamEvents();

teamEls.toggleBtn.addEventListener('click', toggleTeamMode);
teamEls.statusBtn.addEventListener('click', openTeamStatusModal);
teamEls.refreshNowBtn.addEventListener('click', teamRefreshNow);
if (teamEls.refreshTopbarBtn) {
  teamEls.refreshTopbarBtn.addEventListener('click', teamRefreshNow);
}
teamEls.statusModal.addEventListener('click', (e) => {
  if (e.target === teamEls.statusModal || e.target.matches('[data-close]')) {
    closeTeamStatusModal();
  }
});

const teamReportViewerModal = document.getElementById('team-report-viewer-modal');
if (teamReportViewerModal) {
  teamReportViewerModal.addEventListener('click', (e) => {
    if (e.target === teamReportViewerModal || e.target.matches('[data-close]')) {
      teamReportViewerModal.classList.add('hidden');
    }
  });
}

// ───── Team peer management modal (CRUD + CSV bulk import) ─────
const teamManageEls = {
  modal:       document.getElementById('team-manage-modal'),
  openBtn:     document.getElementById('team-manage-btn'),
  rows:        document.getElementById('team-manage-rows'),
  count:       document.getElementById('team-manage-count'),
  addForm:     document.getElementById('team-manage-add-form'),
  csvText:     document.getElementById('team-manage-csv'),
  csvFile:     document.getElementById('team-manage-csv-file'),
  csvApply:    document.getElementById('team-manage-csv-apply'),
  announceBtn: document.getElementById('team-manage-announce-btn'),
};

async function openTeamManageModal() {
  await refreshTeamManageList();
  teamManageEls.modal.classList.remove('hidden');
}
function closeTeamManageModal() {
  teamManageEls.modal.classList.add('hidden');
}

async function refreshTeamManageList() {
  let peers = [];
  try {
    const res = await fetch('/api/team/peers');
    if (res.ok) peers = (await res.json()).peers || [];
  } catch { /* network blip */ }
  teamManageEls.count.textContent = `(${peers.length}명)`;
  teamManageEls.rows.innerHTML = '';
  if (peers.length === 0) {
    const tr = document.createElement('tr');
    tr.innerHTML = '<td colspan="4" class="muted" style="text-align:center; padding:14px;">등록된 팀원 없음</td>';
    teamManageEls.rows.appendChild(tr);
    return;
  }
  for (const p of peers) {
    const tr = document.createElement('tr');
    tr.dataset.name = p.name;
    tr.innerHTML = `
      <td><span class="display-name">${escapeHtml(p.name)}</span></td>
      <td><span class="display-host">${escapeHtml(p.host)}</span></td>
      <td><span class="display-port">${p.port}</span></td>
      <td class="actions">
        <button class="btn" data-action="edit">편집</button>
        <button class="btn btn-danger" data-action="remove">삭제</button>
      </td>
    `;
    teamManageEls.rows.appendChild(tr);
  }
}

if (teamManageEls.addForm) {
  teamManageEls.addForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(teamManageEls.addForm);
    const name = String(fd.get('name') || '').trim();
    const host = String(fd.get('host') || '').trim();
    const port = Number(fd.get('port'));
    try {
      const res = await fetch('/api/team/peer-add', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, host, port }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`추가 실패: ${err.detail || err.error || res.status}`, 'error');
        return;
      }
      showToast(`'${name}' 추가됨`);
      teamManageEls.addForm.reset();
      await refreshTeamManageList();
    } catch (e) {
      showToast(`추가 오류: ${e.message}`, 'error');
    }
  });
}

if (teamManageEls.rows) {
  teamManageEls.rows.addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-action]');
    if (!btn) return;
    const tr = btn.closest('tr');
    if (!tr || !tr.dataset.name) return;
    const action = btn.dataset.action;

    if (action === 'remove') {
      const name = tr.dataset.name;
      if (!confirm(`'${name}'을(를) 정말 삭제하시겠습니까?\n\n이 작업은 모든 팀원의 목록에서도 제거됩니다 (자동 전파).`)) return;
      try {
        const res = await fetch('/api/team/peer-remove', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(`삭제 실패: ${err.error || res.status}`, 'error');
          return;
        }
        showToast(`'${name}' 삭제됨`);
        await refreshTeamManageList();
      } catch (e) {
        showToast(`삭제 오류: ${e.message}`, 'error');
      }
    } else if (action === 'edit') {
      const original = tr.dataset.name;
      const curName = tr.querySelector('.display-name').textContent;
      const curHost = tr.querySelector('.display-host').textContent;
      const curPort = tr.querySelector('.display-port').textContent;
      tr.dataset.original = original;
      tr.innerHTML = `
        <td><input class="edit-name" value="${escapeHtml(curName)}" /></td>
        <td><input class="edit-host" value="${escapeHtml(curHost)}" /></td>
        <td><input class="edit-port" type="number" min="1" max="65535" value="${escapeHtml(curPort)}" /></td>
        <td class="actions">
          <button class="btn btn-primary" data-action="save">저장</button>
          <button class="btn" data-action="cancel">취소</button>
        </td>
      `;
    } else if (action === 'save') {
      const original = tr.dataset.original;
      const name = tr.querySelector('.edit-name').value.trim();
      const host = tr.querySelector('.edit-host').value.trim();
      const port = Number(tr.querySelector('.edit-port').value);
      try {
        const res = await fetch('/api/team/peer-edit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ originalName: original, name, host, port }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(`수정 실패: ${err.detail || err.error || res.status}`, 'error');
          return;
        }
        showToast(`'${name}' 수정됨`);
        await refreshTeamManageList();
      } catch (e) {
        showToast(`수정 오류: ${e.message}`, 'error');
      }
    } else if (action === 'cancel') {
      await refreshTeamManageList();
    }
  });
}

if (teamManageEls.csvFile) {
  teamManageEls.csvFile.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      const text = await file.text();
      teamManageEls.csvText.value = text;
    } catch (err) {
      showToast(`파일 읽기 실패: ${err.message}`, 'error');
    } finally {
      e.target.value = ''; // allow re-select of same file
    }
  });
}

if (teamManageEls.csvApply) {
  teamManageEls.csvApply.addEventListener('click', async () => {
    const csv = teamManageEls.csvText.value.trim();
    if (!csv) { showToast('CSV 내용이 비어있습니다', 'error'); return; }
    const modeEl = document.querySelector('input[name="bulk-mode"]:checked');
    const mode = modeEl ? modeEl.value : 'merge';
    if (mode === 'replace' &&
        !confirm('전체 팀원 목록을 이 CSV로 교체합니다. 기존 항목은 모두 삭제됩니다. 계속할까요?')) {
      return;
    }
    try {
      const res = await fetch('/api/team/peer-bulk-import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv, mode }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        if (err.errors && err.errors.length > 0) {
          const summary = err.errors
            .map((e) => `${e.line}행: ${e.message}`)
            .slice(0, 3)
            .join(' / ');
          showToast(`CSV 검증 실패 — ${summary}`, 'error', 6000);
        } else {
          showToast(`적용 실패: ${err.error || res.status}`, 'error');
        }
        return;
      }
      const data = await res.json();
      showToast(`CSV 적용 완료 (${data.mode} · ${data.accepted}명)`);
      teamManageEls.csvText.value = '';
      await refreshTeamManageList();
    } catch (e) {
      showToast(`적용 오류: ${e.message}`, 'error');
    }
  });
}

if (teamManageEls.modal) {
  teamManageEls.modal.addEventListener('click', (e) => {
    if (e.target === teamManageEls.modal || e.target.matches('[data-close]')) {
      closeTeamManageModal();
    }
  });
}

if (teamManageEls.openBtn) {
  teamManageEls.openBtn.addEventListener('click', openTeamManageModal);
}

if (teamManageEls.announceBtn) {
  teamManageEls.announceBtn.addEventListener('click', async () => {
    try {
      const res = await fetch('/api/team/peer-announce', { method: 'POST' });
      if (!res.ok) {
        showToast('전파 실패', 'error');
        return;
      }
      const data = await res.json();
      showToast(`내 목록 전파 완료 (${data.sent || 0}개 항목)`);
    } catch (e) {
      showToast(`전파 오류: ${e.message}`, 'error');
    }
  });
}

loadTeamState();
