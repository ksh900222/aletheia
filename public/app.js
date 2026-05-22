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
  hideDone: false,        // gantt: hide schedules whose status is 'done'
  dateFocus: null,        // YYYY-MM-DD when a header date cell is clicked (sticky)
  depDraft: null,         // {scheduleId, linkType} when first bar is selected (Shift/Alt+click)
  undoStack: [],          // [{kind, ...}] — see performUndo for record shapes
  redoStack: [],          // mirror; cleared whenever a new tracked action happens
  reportQuery: '',        // free-text filter for reports (per-category panel)
  allOwner: '',           // 전체 간트 owner filter: '' = all, '__self' = own only, '<peerName>' = that peer
  sprintReview: {         // 「선택」 모드 상태
    mode: false,
    selected: new Set(),  // composite keys "<owner>:<reportId>" — 현재 체크된 항목들
    // 스프린트 리뷰 scope 에서 편집 모드 진입 시 원래 멤버 set 을 기억해 둔다.
    // 「선택 확인」 클릭 시 originalMembers - selected = 제거할 멤버.
    originalMembers: null,
  },
  sprintGroups: [],       // /api/sprint-groups 응답: 본인 + replicated peer 그룹. 각 g 는
                          // {creator, id, name, member_count, members:[{report_id,report_owner,snapshot_date,snapshot_body,...}]}
  activeSprintGroupKey: null, // 활성 그룹의 composite key "<creator>:<id>"
  allReports: [],         // all reports across categories (loaded for all-reports view)
  allReportsQuery: '',    // search query in all-reports view
  allReportsDateFrom: '', // YYYY-MM-DD inclusive lower bound for all-reports view (empty = no bound)
  allReportsDateTo: '',   // YYYY-MM-DD inclusive upper bound for all-reports view (empty = no bound)
  allReportsBySchedule: false, // when true, group within each category by schedule first, then date
  pendingAttachments: [], // [{ kind:'upload', file, display_name } | { kind:'local_path', path, display_name }]
  reportLinkedSchedule: null, // {schedule, date} when modal was opened from a Gantt bar click
  reportModalSnapshot: null,  // form values captured at open time — dirty check on close to confirm discard
  canWrite: true,         // IP-based authorization; flipped to false at boot if /api/auth/me says so
  canComment: true,       // COMMENT_ALLOWLIST tier — readonly except comment post/edit/delete
  clientIp: null,         // remote IP as the server saw us — shown in the read-only banner
  commenterName: '',      // author string the server attaches to OUR comments — used for is-mine matching
};

const $ = (sel) => document.querySelector(sel);
const els = {
  categoryList: $('#category-list'),
  emptyState: $('#empty-state'),
  categoryView: $('#category-view'),
  catTitle: $('#cat-title'),
  catHideToggle: $('#cat-hide-toggle'),
  catHideToggleWrap: $('#cat-hide-toggle-wrap'),
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
  allReportsTitle: $('#all-reports-title'),
  sprintReviewBtn: $('#sprint-review-btn'),
  sprintReviewToggleBtn: $('#sprint-review-toggle-btn'),
  sprintReviewGroups: $('#sprint-review-groups'),
  sprintGroupModal: $('#sprint-group-modal'),
  sprintGroupForm: $('#sprint-group-form'),
  sprintGroupModalHint: $('#sprint-group-modal-hint'),
  ganttConnBanner: $('#gantt-conn-banner'),
  ganttConnBannerText: $('#gantt-conn-banner-text'),
  ganttConnCancel: $('#gantt-conn-cancel'),
  expandConnectedBtn: $('#expand-connected-btn'),
  showArrowsBtn: $('#show-arrows-btn'),
  chainSortBtn: $('#chain-sort-btn'),
  hideDoneToggle: $('#hide-done-toggle'),
  scheduleDeleteBtn: $('#schedule-delete-btn'),
  scheduleSubmitBtn: $('#schedule-submit-btn'),
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
  allOwner: $('#all-owner'),
  allOwnerWrap: $('#all-owner-wrap'),
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
  reportExcludeFromTeam: $('#report-exclude-from-team'),
  reportDeleteBtn: $('#report-delete-btn'),
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
      applyReadOnlyMode(data.ip, { canComment: state.canComment });
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

function applyReadOnlyMode(ip, opts) {
  if (!state.canWrite && document.body.classList.contains('readonly')) return;
  state.canWrite = false;
  if (ip) state.clientIp = ip;
  document.body.classList.add('readonly');
  // COMMENT_ALLOWLIST IPs: keep readonly for write affordances, but mark body
  // so comment form / save button / edit textarea stay enabled (see CSS).
  const canComment = !!(opts && opts.canComment);
  state.canComment = canComment;
  if (canComment) document.body.classList.add('can-comment');
  let banner = document.getElementById('readonly-banner');
  if (!banner) {
    banner = document.createElement('div');
    banner.id = 'readonly-banner';
    banner.className = 'readonly-banner';
    document.body.prepend(banner);
  }
  const ipText = state.clientIp ? ` (현재 IP: ${state.clientIp})` : '';
  banner.textContent = canComment
    ? `코멘트 전용 모드 — 본인이 작성한 코멘트의 등록·수정·삭제만 가능합니다.${ipText}`
    : `읽기 전용 모드 — 이 IP에서는 추가/수정/삭제가 불가능합니다.${ipText}`;
}

// Boot-time IP check. The server is the source of truth; we just mirror its
// answer into the UI so write affordances can be hidden up front. Any error
// here is non-fatal — the server will still enforce 403 on actual writes.
(async () => {
  try {
    const me = await fetch('/api/auth/me').then((r) => r.json());
    state.clientIp = me.ip || null;
    state.commenterName = me.commenterName || '';
    if (!me.canWrite) applyReadOnlyMode(me.ip, { canComment: !!me.canComment });
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
  if (els.sprintReviewBtn) {
    els.sprintReviewBtn.classList.toggle('active', state.scope === 'sprint-review');
  }
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
  // Keep the 전체 간트 담당자 dropdown in sync regardless of which branch
  // below runs — the helper hides itself when scope !== 'all' or team mode
  // is OFF, so it's safe to always call.
  if (typeof syncAllOwnerOptions === 'function') syncAllOwnerOptions();

  // 전체 리포트 와 스프린트 리뷰 는 동일한 #all-reports-view DOM 을 공유하고
  // body 의 scope-* 클래스로 차이를 표현. renderAllReportsView 는 그 안에서 분기.
  if (state.scope === 'all-reports' || state.scope === 'sprint-review') {
    els.emptyState.classList.add('hidden');
    els.categoryView.classList.add('hidden');
    els.allReportsView.classList.remove('hidden');
    document.body.classList.remove('scope-all');
    document.body.classList.toggle('scope-all-reports', state.scope === 'all-reports');
    document.body.classList.toggle('scope-sprint-review', state.scope === 'sprint-review');
    renderAllReportsView();
    return;
  }
  els.allReportsView.classList.add('hidden');
  document.body.classList.remove('scope-all-reports');
  document.body.classList.remove('scope-sprint-review');

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
  if (els.catHideToggle) els.catHideToggle.checked = !!c.hide_from_all_gantt;
  // 「전체 간트/리포트에서 숨기기」 토글은 팀 모드 (혹은 보관된 팀원) 가 있을
  // 때만 의미가 있으므로 단독 사용 시엔 토글 자체를 숨긴다.
  if (els.catHideToggleWrap) {
    els.catHideToggleWrap.classList.toggle('hidden', !teamOn());
  }
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
    // Team mode: append peer schedules. They keep numeric ids but carry an
    // `owner` field so renderers and lookups can distinguish them.
    if (teamOn() && state.team.merged.schedules.length > 0) {
      base = base.concat(state.team.merged.schedules);
    }
    if (state.allOwner) {
      if (state.allOwner === '__self') {
        base = base.filter((s) => !s.owner);
      } else {
        base = base.filter((s) => s.owner === state.allOwner);
      }
    }
    // 「전체 간트/리포트에서 숨기기」: 검색·담당자 필터가 둘 다 없는 "모두 보기"
    // 상태에서만 hide_from_all_gantt = 1 인 카테고리의 스케줄을 가린다.
    // 본인 카테고리 + peer 카테고리 (snapshot 으로 받음) 모두 동일하게 적용.
    // 동일 플래그가 「전체 리포트」(renderAllReportsView) 의 필터에도 적용됨.
    // 단독 사용 (팀 모드 OFF + 보관 팀원 없음) 시엔 숨김 자체가 의미 없으므로
    // 필터를 적용하지 않는다.
    const noFilter = !state.scheduleQuery.trim() && !state.allOwner && teamOn();
    if (noFilter) {
      base = base.filter((s) => {
        const cat = findCategoryForSchedule(s);
        return !(cat && cat.hide_from_all_gantt);
      });
    }
    baseIdSet = new Set(base.map((s) => s.id));
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
    // 제목 / 카테고리명 / 담당자 이름 중 하나라도 매치하면 노출.
    // 본인 스케줄은 s.owner 가 비어 있어 owner 매치로는 안 잡히지만, 검색어가
    // 본인 self.name 의 일부면 본인 스케줄을 함께 보여준다 (팀원 이름으로
    // 검색하는 것과 대칭).
    const selfNameLower = ((state.team.self && state.team.self.name) || '').toLowerCase();
    base = base.filter((s) => {
      if ((s.title || '').toLowerCase().includes(q)) return true;
      const cat = findCategoryForSchedule(s);
      if (cat && (cat.name || '').toLowerCase().includes(q)) return true;
      if ((s.owner || '').toLowerCase().includes(q)) return true;
      // 본인 스케줄 (owner 빈 값) + 검색어가 self.name 안에 포함 → 매치
      if (!s.owner && selfNameLower && selfNameLower.includes(q)) return true;
      return false;
    });
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

// 「전체 간트/리포트에서 숨기기」 — 리포트가 noFilter 상태에서 숨겨져야 하는지
// 판정. rule B: 태깅된 모든 카테고리가 hide_from_all_gantt = 1 일 때만 true.
// 카테고리 미태깅 리포트는 false (= 노출). 본인 리포트는 state.categories,
// peer 리포트는 state.team.merged.categories 에서 canonical 플래그를 읽는다.
function reportFullyHidden(r) {
  const cats = r.categories || [];
  if (cats.length === 0) return false;
  for (const c of cats) {
    const canonical = r.owner
      ? state.team.merged.categories.find((x) => x.id === c.id && x.owner === r.owner)
      : state.categories.find((x) => x.id === c.id);
    const hide = canonical
      ? !!canonical.hide_from_all_gantt
      : !!c.hide_from_all_gantt;
    if (!hide) return false;
  }
  return true;
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
  // 전체 간트(=리스트) 에서도 본인 항목 뒤에 자신의 이름을 표시한다.
  // 팀원 항목은 이미 teamOwnerSuffix(owner) 가 적용됨.
  const selfNameForList = (state.team.self && state.team.self.name) || '';
  const showOwnerForOwnList =
    state.scope === 'all' && teamOn() && !!selfNameForList;
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
    const ownSuffixHtml = !isTeam && showOwnerForOwnList
      ? teamOwnerSuffix(selfNameForList)
      : '';
    const titleHtml = isTeam
      ? `${escapeHtml(s.title)}${teamOwnerSuffix(s.owner)}`
      : `${escapeHtml(s.title)}${ownSuffixHtml}${isExtra ? ' <span class="muted" title="연결된 항목">·연결</span>' : ''}`;
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
  // KST 기준 로컬 날짜. UTC 기반 toISOString() 은 자정~오전 9시에 어제로
  // 표시되는 H-9 버그를 일으키므로 사용 금지.
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${dd}`;
}

// H-8: 폼 더블클릭/엔터 연타 방지. submit 핸들러를 이걸로 감싸면
// 응답 도착 또는 에러까지 submit 버튼이 disable 되어 중복 POST 차단.
function withSubmitGuard(form, fn) {
  if (form._submitting) return Promise.resolve();
  form._submitting = true;
  const submitter = form.querySelector('button[type="submit"]');
  if (submitter) submitter.disabled = true;
  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      form._submitting = false;
      if (submitter) submitter.disabled = false;
    });
}

// H-19: 서버가 보내는 영문 enum 코드를 한국어 메시지로 매핑.
// alert 직접 호출부에서 `${err.message}` 대신 `${mapServerError(err)}` 사용.
const SERVER_ERROR_MESSAGES = {
  // dependencies
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
  invalid_entity_type: '선행/후행 종류가 올바르지 않습니다.',
  invalid_id: '선택된 항목의 ID가 올바르지 않습니다.',
  not_found: '편집 중이던 항목이 더 이상 존재하지 않습니다. 새로고침 후 다시 시도해주세요.',
  // schedules
  end_before_start: '종료일이 시작일보다 빠릅니다.',
  invalid_date: '날짜 형식이 올바르지 않습니다.',
  invalid_start: '시작일 형식이 올바르지 않습니다.',
  invalid_end: '종료일 형식이 올바르지 않습니다.',
  start_after_end: '시작일이 종료일보다 늦습니다.',
  empty_title: '제목을 입력해주세요.',
  category_not_found: '카테고리를 찾을 수 없습니다.',
  invalid_category_id: '카테고리가 올바르지 않습니다.',
  // reports
  empty_body: '내용을 입력해주세요.',
  body_too_long: '내용이 너무 깁니다.',
  date_out_of_range: '리포트 날짜가 연결된 업무 기간을 벗어났습니다.',
  // attachments
  report_not_found: '리포트를 찾을 수 없습니다. 새로고침 후 다시 시도해주세요.',
  no_file: '파일이 첨부되지 않았습니다.',
  path_required: '경로가 비어 있습니다.',
  path_invalid: '경로 형식이 잘못되었습니다.',
  path_too_long: '경로가 너무 깁니다.',
  path_not_absolute: '절대 경로만 등록할 수 있습니다.',
  // tasks
  invalid_recipients: '수신자 목록이 올바르지 않습니다.',
  no_recipients: '수신자를 한 명 이상 선택해주세요.',
  no_valid_recipients: '등록된 팀원 중 일치하는 수신자가 없습니다.',
  deadline_required: '마감일을 입력해주세요.',
  self_name_not_configured: '본인 이름이 설정되어 있지 않습니다. 팀 설정을 확인해주세요.',
  task_not_found: '업무 요청을 찾을 수 없습니다.',
  not_inbound: '받은 업무에 대해서만 동작합니다.',
  invalid_action: '동작이 올바르지 않습니다.',
  body_required_for_adjust: '조정 사유를 입력해주세요.',
  // team auth
  forbidden_write_from_ip: '이 IP에서는 변경 권한이 없습니다.',
  forbidden_local_only: '이 작업은 본인 PC에서만 가능합니다.',
  forbidden_read_from_ip: '이 IP에서는 읽기 권한이 없습니다.',
  not_team_member: '등록된 팀원이 아닌 IP입니다.',
  missing_origin: '발신자 정보가 누락되었습니다.',
  origin_mismatch: '발신자 이름이 IP와 일치하지 않습니다.',
  team_token_not_configured: '팀 공유 토큰이 설정되어 있지 않습니다.',
  invalid_team_token: '팀 공유 토큰이 일치하지 않습니다.',
  outbound_not_found: '대응되는 보낸 업무를 찾지 못했습니다.',
  // generic
  internal_error: '서버 내부 오류가 발생했습니다.',
  duplicate_name: '같은 이름이 이미 존재합니다.',
};
function mapServerError(err) {
  const code = (err && err.message) || '';
  if (SERVER_ERROR_MESSAGES[code]) return SERVER_ERROR_MESSAGES[code];
  return code || '알 수 없는 오류';
}

// H-13: 탭이 백그라운드일 때 폴링 멈췄다가 visible 되면 즉시 1회 + 재시작.
// 모든 setInterval 폴링 호출은 이 헬퍼를 통해 등록.
const _polls = [];
function registerPoll(fn, ms) {
  const entry = { fn, ms, timer: null };
  _polls.push(entry);
  const start = () => { if (!entry.timer) entry.timer = setInterval(fn, ms); };
  const stop  = () => { if (entry.timer) { clearInterval(entry.timer); entry.timer = null; } };
  if (document.visibilityState !== 'hidden') start();
  entry.start = start; entry.stop = stop;
  return entry;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    for (const e of _polls) e.stop();
  } else {
    // 탭이 visible 로 돌아오면 등록된 모든 폴링 (loadTeamState, pollTeamEvents,
    // checkAndReloadIfChanged 등) 을 즉시 1회 실행 + 인터벌 재시작.
    // checkAndReloadIfChanged 는 자동으로 본인 DB 변경 여부도 검사한다.
    for (const e of _polls) { e.fn(); e.start(); }
  }
});

// ───── DB 변경 감지 + 조건부 reload (옵션 B) ─────
// 서버의 computeVersion() 핑거프린트를 비교해 변경됐을 때만 본인 데이터를
// 다시 fetch. 평소엔 ~100 바이트 응답 한 번 (변경 없을 때 reload 없음).
let _lastSeenVersion = null;
async function checkAndReloadIfChanged() {
  let version;
  try {
    const res = await fetch('/api/version');
    if (!res.ok) return;
    const data = await res.json();
    version = data && data.version;
    if (!version) return;
  } catch { return; /* network blip — 다음 기회 재시도 */ }

  // 최초 호출: 기준값만 저장하고 reload 안 함 (boot 시점 데이터는 이미 신선).
  if (_lastSeenVersion === null) {
    _lastSeenVersion = version;
    return;
  }
  if (version === _lastSeenVersion) return; // 변경 없음 — 화면 그대로

  // 모달이 열려 있으면 사용자 입력 보호를 위해 reload skip.
  // (모달 닫힌 뒤 다음 visibility/poll 사이클에 다시 시도됨)
  if (document.querySelector('.modal:not(.hidden)')) {
    console.log('[version-sync] modal open — skipping reload, will retry');
    return;
  }

  try {
    await refreshAll();
    // 현재 scope 가 단순 카테고리 뷰가 아니면 그 view 의 추가 데이터도 갱신.
    if (state.scope === 'all-reports' || state.scope === 'sprint-review') {
      try { await loadAllReports(); } catch { /* non-fatal */ }
    }
    if (state.scope === 'sprint-review') {
      try { await loadSprintGroups(); } catch { /* non-fatal */ }
    }
    if (typeof renderCategoryView === 'function') renderCategoryView();
    _lastSeenVersion = version;
  } catch (e) {
    console.warn('[version-sync] reload 실패, 다음 기회 재시도:', e && e.message);
  }
}

// 폴링: 탭이 활성 상태로 있더라도 다른 곳에서 변경 시 catch 하기 위함.
// registerPoll 이라 탭 hidden 시 자동 정지 + visible 복귀 시 즉시 1회 실행.
// 3초 주기 — SSE 가 안 닿는 경우 (네트워크 불안정·서버 일시 재시작 등) 의
// 안전망. 평소엔 SSE push 가 먼저 도착하므로 폴링은 거의 no-op.
registerPoll(checkAndReloadIfChanged, 3000);

// Number of comments on this report authored by the current user. Used to
// surface "내 코멘트 N" badges so commenters can locate their own threads.
function countMyComments(r) {
  const selfName = (state.team.self && state.team.self.name) || '';
  if (!selfName || !r || !Array.isArray(r.comments)) return 0;
  return r.comments.filter((c) => c.author === selfName).length;
}

function myCommentBadgeHtml(count) {
  if (!count || count <= 0) return '';
  return ` <span class="my-comment-badge" title="내가 남긴 코멘트가 있습니다">내 코멘트 ${count}</span>`;
}

// Counts of comments RECEIVED on this report from other team members.
// Only meaningful for own reports; team-owned reports' ack state is the
// other peer's concern.
//
// Returns { total, acked } so the badge can show "받은 N / 확인 n" — the
// user wanted to see the whole picture, not just unread.
function countReceivedComments(r) {
  const empty = { total: 0, acked: 0 };
  if (!r || r.owner) return empty;
  if (!Array.isArray(r.comments)) return empty;
  const selfName = (state.team.self && state.team.self.name) || '';
  let total = 0, acked = 0;
  for (const c of r.comments) {
    if (c.author === selfName) continue;
    total += 1;
    if (c.acknowledged) acked += 1;
  }
  return { total, acked };
}

function receivedCommentBadgeHtml(total, acked) {
  if (!total || total <= 0) return '';
  const allAcked = acked >= total;
  // Different visual when everything's been read (drops the warning vibe).
  const cls = allAcked ? 'received-comment-badge all-acked' : 'received-comment-badge';
  return ` <span class="${cls}" title="받은 코멘트 ${total}개 · 확인 ${acked}개">받은 코멘트 ${total} / 확인 ${acked}</span>`;
}

// "2025-05-06" → "2025년 05월 06일 (수)". UTC base avoids local-tz drift
// since report dates are stored as plain YYYY-MM-DD calendar dates.
function formatDateKo(iso) {
  if (!iso || typeof iso !== 'string') return iso || '';
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  const y = Number(m[1]), mm = Number(m[2]), dd = Number(m[3]);
  const dow = ['일','월','화','수','목','금','토'][
    new Date(Date.UTC(y, mm - 1, dd)).getUTCDay()
  ];
  return `${y}년 ${m[2]}월 ${m[3]}일 (${dow})`;
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
  // 「완료 숨김」 토글이 켜져 있으면 done 상태의 스케줄을 간트에서 제거.
  // 리스트 뷰는 영향 없음 — done 도 기록용으로 계속 표시.
  const filteredForGantt = state.hideDone
    ? result.schedules.filter((s) => s.status !== 'done')
    : result.schedules;
  // Gantt rows are reordered topologically: predecessors above successors,
  // isolated items at the bottom. Table view keeps date-based sort.
  const visible = topoSortForGantt(filteredForGantt);
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
  // In 전체 간트, append the user's own name as a "| 이름" suffix on each of
  // their own bars too — peer bars already get this via teamOwnerSuffix, so
  // the suffix becomes a uniform owner label across the whole chart.
  const selfName = (state.team.self && state.team.self.name) || '';
  const showOwnerForOwn = state.scope === 'all' && teamOn() && !!selfName;
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
    const labelOwner = s.owner || (showOwnerForOwn ? selfName : '');
    if (labelOwner) {
      barLabelEl.innerHTML =
        escapeHtml(catLabel + s.title) + teamOwnerSuffix(labelOwner);
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
    alert(`의존성 생성 실패: ${mapServerError(err)}`);
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
  // H-16: 모달이 열려 있으면 글로벌 undo/redo 비활성화. 모달 안에서 빈 영역
  // 클릭 후 Cmd+Z 누르면 백그라운드 데이터가 사일런트 변경되는 문제 차단.
  if (document.querySelector('.modal:not(.hidden)')) return;
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
  // H-18: pointerdown 사용 (mouseup 이 윈도우 밖에서 안 오는 문제 해결).
  bar.addEventListener('pointerdown', (e) => {
    // 마우스 좌클릭만 처리 (touch / pen 도 button=0 으로 들어옴 — 기본 동작 유지).
    if (e.button !== undefined && e.button !== 0) return;
    // Team-owned schedule: read-only. 드래그/연결/리포트 동작은 모두 차단하되,
    // 「클릭」 (포인터 다운 → 거의 움직이지 않은 채 업) 은 읽기 전용 모달을
    // 열어 내용을 확인할 수 있게 한다. 가로 스크롤 드래그를 모달 오픈으로
    // 오인하지 않도록 이동거리 3px 임계값을 둔다.
    if (schedule.owner) {
      if (e.target.classList.contains('resize-handle')) return;
      if (state.dateFocus) return; // 리포트 모달 흐름과 충돌 방지
      const startX = e.clientX;
      const startY = e.clientY;
      let moved = false;
      const onMove = (ev) => {
        if (Math.abs(ev.clientX - startX) > 3 || Math.abs(ev.clientY - startY) > 3) {
          moved = true;
        }
      };
      const onUp = () => {
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        if (!moved) openScheduleModal(schedule, { readOnly: true });
      };
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
      return;
    }
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
      // H-18: pointer events + setPointerCapture 사용. pointercancel 도 정리 대상.
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
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
    // H-18: setPointerCapture 로 윈도우 밖 release 도 보장.
    try { bar.setPointerCapture(e.pointerId); } catch {}
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
  });
}

function attachBarResizeHandlers(handle, bar, schedule) {
  // H-18: pointer events.
  handle.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    // Team-owned schedule: read-only. Block resize entirely so the bar's
    // length can't be altered via drag handle (CSS also hides the handle).
    if (schedule.owner) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
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
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
      const finalWidth = parseFloat(bar.style.width);
      const dayDelta = Math.round((finalWidth - origWidth) / GANTT_DAY_WIDTH);
      if (dayDelta === 0) return;
      const newEnd = addDaysIso(schedule.planned_end, dayDelta);
      await saveScheduleFromGantt(schedule.id, schedule.planned_start, newEnd);
    }
    try { handle.setPointerCapture(e.pointerId); } catch {}
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
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
    alert(`저장 실패: ${mapServerError(err)}`);
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
    alert(`그룹 이동 실패: ${mapServerError(err)}`);
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
  queueSaveLastView();
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
  queueSaveLastView();
}

async function selectAllReportsView() {
  state.scope = 'all-reports';
  state.selectedCategoryId = null;
  state.expandConnected = false;
  // scope 진입 시 「선택」 모드 초기화 — 이전 scope 에서 들어온 상태가 섞이지 않도록.
  state.sprintReview.mode = false;
  state.sprintReview.selected.clear();
  state.sprintReview.originalMembers = null;
  renderCategories();
  await loadAllReports();
  renderCategoryView();
  queueSaveLastView();
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

// 「전체 간트/리포트에서 숨기기」 토글 — 현재 선택된 카테고리에 대해 PUT.
if (els.catHideToggle) {
  els.catHideToggle.addEventListener('change', async () => {
    const c = state.categories.find((x) => x.id === state.selectedCategoryId);
    if (!c) return;
    const wanted = els.catHideToggle.checked ? 1 : 0;
    els.catHideToggle.disabled = true;
    try {
      await api('PUT', `/api/categories/${c.id}`, { hide_from_all_gantt: wanted });
      c.hide_from_all_gantt = wanted;
    } catch (err) {
      els.catHideToggle.checked = !els.catHideToggle.checked; // 롤백
      showToast('숨김 설정 실패: ' + (err && err.message), 'error');
    } finally {
      els.catHideToggle.disabled = false;
    }
  });
}
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
  await withSubmitGuard(els.categoryForm, async () => {
    const fd = new FormData(els.categoryForm);
    const payload = {
      name: fd.get('name'),
      description: fd.get('description') || null,
      color: fd.get('color'),
    };
    const editId = els.categoryForm.dataset.editId;
    // When the modal was opened from the task-detail schedule pane we don't want
    // to navigate away to the new category — just refresh the dropdown there.
    const fromTaskSched = els.categoryForm.dataset.fromTaskSched === '1';
    try {
      let saved;
      if (editId) {
        saved = await api('PUT', `/api/categories/${editId}`, payload);
      } else {
        saved = await api('POST', '/api/categories', payload);
      }
      closeCategoryModal();
      if (fromTaskSched) {
        els.categoryForm.dataset.fromTaskSched = '';
        // Refresh main category list state silently and the schedule-pane select.
        await loadCategories();
        await loadCategoriesIntoSchedSelect();
        if (taskDetailEls.schedCategory && saved && saved.id) {
          taskDetailEls.schedCategory.value = String(saved.id);
        }
        return;
      }
      await refreshAll();
      selectCategory(saved.id);
    } catch (err) {
      alert(`저장 실패: ${mapServerError(err)}`);
    }
  });
});

// ---------- Schedule modal ----------
function openScheduleModal(schedule, options = {}) {
  const readOnly = !!options.readOnly;
  const ownerLabel = schedule && schedule.owner ? ` | ${schedule.owner}` : '';
  els.scheduleModalTitle.textContent = schedule
    ? (readOnly ? `스케줄 (읽기 전용)${ownerLabel}` : '스케줄 편집')
    : '스케줄 추가';
  els.scheduleForm.reset();
  els.scheduleForm.dataset.editId = schedule ? schedule.id : '';
  els.scheduleForm.dataset.readOnly = readOnly ? '1' : '';
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
    const today = todayIso();
    els.scheduleForm.planned_start.value = today;
    els.scheduleForm.planned_end.value = today;
  }
  // Always derive 계획일수 from current dates when opening the modal.
  els.scheduleForm.planned_days.value =
    daysBetweenInclusive(
      els.scheduleForm.planned_start.value,
      els.scheduleForm.planned_end.value
    ) || 1;

  // 읽기 전용 모드 — 모든 입력을 비활성, 저장/삭제 버튼 숨김.
  // 본인 스케줄 편집 모드에서만 삭제 버튼 노출 (신규 추가 시 숨김).
  const inputs = els.scheduleForm.querySelectorAll('input, textarea, select');
  inputs.forEach((el) => { el.disabled = readOnly; });
  if (els.scheduleSubmitBtn) {
    els.scheduleSubmitBtn.classList.toggle('hidden', readOnly);
  }
  if (els.scheduleDeleteBtn) {
    const canDelete = !readOnly && !!schedule && !schedule.owner;
    els.scheduleDeleteBtn.classList.toggle('hidden', !canDelete);
    els.scheduleDeleteBtn.dataset.id = canDelete ? String(schedule.id) : '';
    els.scheduleDeleteBtn.dataset.title = canDelete ? (schedule.title || '') : '';
  }

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

if (els.scheduleDeleteBtn) {
  els.scheduleDeleteBtn.addEventListener('click', async () => {
    const id = Number(els.scheduleDeleteBtn.dataset.id);
    if (!id) return;
    const title = els.scheduleDeleteBtn.dataset.title || '';
    if (!confirm(`"${title}" 스케줄을 삭제하시겠습니까?`)) return;
    try {
      await api('DELETE', `/api/schedules/${id}`);
      closeScheduleModal();
      await refreshAll();
    } catch (err) {
      alert(`삭제 실패: ${mapServerError(err)}`);
    }
  });
}

els.addScheduleBtn.addEventListener('click', () => {
  if (!state.selectedCategoryId) return;
  openScheduleModal(null);
});

els.scheduleForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (els.scheduleForm.dataset.readOnly === '1') return; // peer 스케줄: 저장 차단
  await withSubmitGuard(els.scheduleForm, async () => {
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
      alert(`저장 실패: ${mapServerError(err)}`);
    }
  });
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
      alert(`상태 변경 실패: ${mapServerError(err)}`);
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
      // H-12: 카테고리 의존성 disable. "현재" 는 schedule 만 가능. category
      // 기본값 + selectedCategoryId 프리셋은 비활성화.
      form.current_type.value = 'schedule';
      form.pred_type.value = '';
      form.succ_type.value = '';
      form.link_type.value = 'strong';
      form.on_delay.value = 'auto_shift';
      depCreateRefresh();
      // (H-12) 이전: 선택된 카테고리를 "현재"로 자동 프리셋 — 이제 schedule 만이라 의미 없음.
      // if (state.selectedCategoryId) {
      //   form.current_id.value = String(state.selectedCategoryId);
      //   depCreateRefresh();
      // }
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
  await withSubmitGuard(els.dependencyCreateForm, async () => {
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
      const sideMsg = err.body && err.body.side ? ` (${err.body.side === 'pred' ? '선행→현재' : '현재→후행'} 엣지)` : '';
      alert(`${mapServerError(err)}${sideMsg}`);
    }
  });
});

els.dependencyForm.pred_type.addEventListener('change', (e) => {
  populateEntitySelect(els.dependencyForm.pred_id, e.target.value);
});
els.dependencyForm.succ_type.addEventListener('change', (e) => {
  populateEntitySelect(els.dependencyForm.succ_id, e.target.value);
});

els.dependencyForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  await withSubmitGuard(els.dependencyForm, async () => {
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
    alert(`저장 실패: ${mapServerError(err)}`);
  }
  });
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
      alert(`유형 변경 실패: ${mapServerError(err)}`);
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
      alert(`충돌 시 동작 변경 실패: ${mapServerError(err)}`);
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
    if (els.reportExcludeFromTeam) {
      els.reportExcludeFromTeam.checked = !!report.exclude_from_team;
    }
    applyReportDateBounds(report.schedules);
    // If editing a report linked to schedules, show meta for the first one.
    // Multi-schedule UI is a future iteration.
    if (report.schedules && report.schedules.length) {
      renderReportMetaBox(report.schedules[0], report.report_date);
    } else {
      hideReportMetaBox();
    }
  } else {
    const today = todayIso();
    els.reportForm.report_date.value = today;
    const initial = state.selectedCategoryId ? [state.selectedCategoryId] : [];
    renderReportCategoryChecks(initial);
    renderAttachmentList([]); // pending list (initially empty)
    if (els.reportExcludeFromTeam) els.reportExcludeFromTeam.checked = false;
    applyReportDateBounds(
      state.reportLinkedSchedule ? [state.reportLinkedSchedule.schedule] : null
    );
    hideReportMetaBox();
  }
  // 편집 모드에서만 우상단 삭제 버튼 노출 (작성 모드는 아직 id 가 없으므로
  // 닫기 버튼만으로 충분). 권한 없는 사용자는 끝까지 숨김.
  if (els.reportDeleteBtn) {
    const canDelete = !!report && !!state.canWrite;
    els.reportDeleteBtn.classList.toggle('hidden', !canDelete);
  }
  // Comments panel (own reports — read-only). Re-rendered automatically
  // when a comment_received event arrives while modal is open.
  renderOwnReportComments(
    report ? (report.comments || []) : [],
    report ? report.id : null
  );
  // Attachments section is always visible — file uploads / local paths are
  // buffered client-side until the report is saved (POST flushes them).
  els.attachmentsSection.classList.remove('hidden');
  state.reportModalSnapshot = snapshotReportForm();
  els.reportModal.classList.remove('hidden');
}

// 리포트 날짜 input 의 min/max 를 연결된 스케줄(들) 의 계획 기간으로 제한.
// 다중 스케줄이면 min(planned_start) ~ max(planned_end) 의 합집합. 스케줄
// 없으면 제약 해제. type="date" 의 min/max 속성은 브라우저 단에서 picker 와
// validation 을 둘 다 강제함 — 서버에서도 동일 검증.
function applyReportDateBounds(schedules) {
  const inp = els.reportForm && els.reportForm.report_date;
  if (!inp) return;
  if (!schedules || !schedules.length) {
    inp.removeAttribute('min');
    inp.removeAttribute('max');
    return;
  }
  let minD = null;
  let maxD = null;
  for (const s of schedules) {
    if (s.planned_start && (!minD || s.planned_start < minD)) minD = s.planned_start;
    if (s.planned_end && (!maxD || s.planned_end > maxD)) maxD = s.planned_end;
  }
  if (minD) inp.setAttribute('min', minD); else inp.removeAttribute('min');
  if (maxD) inp.setAttribute('max', maxD); else inp.removeAttribute('max');
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
    applyReportDateBounds([schedule]);
    if (els.reportExcludeFromTeam) els.reportExcludeFromTeam.checked = false;
    if (els.reportDeleteBtn) els.reportDeleteBtn.classList.add('hidden');
    els.attachmentsSection.classList.remove('hidden');
    state.reportModalSnapshot = snapshotReportForm();
    els.reportModal.classList.remove('hidden');
  }
}

function renderReportMetaBox(schedule, date) {
  const cat = state.categories.find((c) => c.id === schedule.category_id);
  const days =
    daysBetweenInclusive(schedule.planned_start, schedule.planned_end) || 0;
  const status = schedule.status || '';
  const desc = (schedule.description || '').trim();
  // Category pill mirrors the status pill — clickable to cycle to the next
  // category in state.categories order (server returns id ASC). Cycle only
  // engages when there are 2+ categories AND the user has write permission.
  const cycleable = state.canWrite && state.categories.length > 1;
  const catAttrs = cycleable
    ? ` data-action="cycle-category" data-id="${schedule.id}" role="button" title="클릭하여 다음 카테고리로 변경"`
    : '';
  const catPill = cat
    ? `<span class="schedule-cat-pill"${catAttrs} style="background:${cat.color || '#e7eeff'}26;color:${cat.color || '#1f5fc9'}">${escapeHtml(cat.name)}</span>`
    : '';
  els.reportMetaBox.innerHTML = `
    <div class="meta-row"><div class="meta-label">카테고리</div><div class="meta-value">${catPill}</div></div>
    <div class="meta-row"><div class="meta-label">스케줄</div><div class="meta-value"><b>${escapeHtml(schedule.title)}</b></div></div>
    <div class="meta-row"><div class="meta-label">기간</div><div class="meta-value">${schedule.planned_start} ~ ${schedule.planned_end} (${days}일)</div></div>
    <div class="meta-row"><div class="meta-label">상태</div><div class="meta-value"><span class="status-pill ${escapeHtml(status)}" data-action="cycle-status" data-id="${schedule.id}" role="button" title="클릭하여 다음 상태로 변경">${escapeHtml(status)}</span></div></div>
    ${desc ? `<div class="meta-row"><div class="meta-label">설명</div><div class="meta-value">${escapeHtml(desc)}</div></div>` : ''}
    <div class="meta-row"><div class="meta-label">리포트 날짜</div><div class="meta-value"><b>${date}</b></div></div>
  `;
  els.reportMetaBox.dataset.scheduleId = String(schedule.id);
  els.reportMetaBox.dataset.reportDate = date || '';
  els.reportMetaBox.classList.remove('hidden');
}

function hideReportMetaBox() {
  els.reportMetaBox.classList.add('hidden');
  els.reportMetaBox.innerHTML = '';
  state.reportLinkedSchedule = null;
}

// Snapshot the form fields whose changes count as "unsaved edits". Attachment
// changes in edit mode persist immediately (POST on upload, DELETE on remove)
// so they're not tracked here; for create mode the pendingAttachments count
// captures buffered uploads.
function snapshotReportForm() {
  return {
    body: els.reportForm.body.value,
    report_date: els.reportForm.report_date.value,
    categoryIds: selectedCategoryIdsFromForm().slice().sort().join(','),
    pendingCount: state.pendingAttachments.length,
    excludeFromTeam: !!(els.reportExcludeFromTeam && els.reportExcludeFromTeam.checked),
  };
}

function isReportModalDirty() {
  const snap = state.reportModalSnapshot;
  if (!snap) return false;
  const now = snapshotReportForm();
  return (
    now.body !== snap.body ||
    now.report_date !== snap.report_date ||
    now.categoryIds !== snap.categoryIds ||
    now.pendingCount !== snap.pendingCount ||
    now.excludeFromTeam !== snap.excludeFromTeam
  );
}

function closeReportModal(opts) {
  // skipDirtyCheck: callers that already persisted the edits (save submit) bypass
  // the confirm dialog. Backdrop / 닫기 button paths leave it false → confirm fires.
  const skip = !!(opts && opts.skipDirtyCheck);
  if (!skip && isReportModalDirty()) {
    if (!confirm('작성 중인 내용이 저장되지 않습니다. 정말 닫을까요?')) return;
  }
  els.reportModal.classList.add('hidden');
  state.editingReportId = null;
  state.reportModalSnapshot = null;
  // hideReportMetaBox already nulls state.reportLinkedSchedule, but state it
  // explicitly here too — close paths (cancel button / backdrop / save) all
  // funnel through this function and the link should never survive a close.
  state.reportLinkedSchedule = null;
  hideReportMetaBox();
}

// 「리포트 삭제」 우상단 버튼 — 편집 모드에서만 노출됨. 확인 후 DELETE 를
// 발사하고 모달 닫은 뒤 리스트 갱신. reports.updated_at + sprint group
// updated_at 변경으로 fingerprint 가 움직여 peer 들의 다음 polling 에서
// 자동으로 사라짐.
if (els.reportDeleteBtn) {
  els.reportDeleteBtn.addEventListener('click', async () => {
    const id = state.editingReportId;
    if (!id) return;
    if (!confirm('이 리포트를 삭제하시겠습니까?\n(첨부 파일과 스프린트 그룹 내 멤버 정보도 함께 삭제되며, 모든 팀원에게 전파됩니다.)')) {
      return;
    }
    els.reportDeleteBtn.disabled = true;
    try {
      await api('DELETE', `/api/reports/${id}`);
      closeReportModal({ skipDirtyCheck: true });
      await refreshReportsForScope();
    } catch (err) {
      showToast('삭제 실패: ' + (err && err.message), 'error');
    } finally {
      els.reportDeleteBtn.disabled = false;
    }
  });
}

// Status pill inside the report meta box: same cycle-on-click behavior as
// the schedule list view — lets users flip status while writing a report
// without leaving the modal. Single listener attached to the stable parent.
els.reportMetaBox.addEventListener('click', async (e) => {
  const pill = e.target.closest('.status-pill[data-action="cycle-status"]');
  if (!pill) return;
  const id = Number(pill.dataset.id);
  const sched = state.allSchedules.find((s) => s.id === id);
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
    await loadAllSchedules();
    if (state.selectedCategoryId) await loadSchedules(state.selectedCategoryId);
    const updated = state.allSchedules.find((s) => s.id === id);
    if (updated) {
      const date = els.reportMetaBox.dataset.reportDate || '';
      renderReportMetaBox(updated, date);
      if (state.reportLinkedSchedule) state.reportLinkedSchedule.schedule = updated;
    }
    renderSchedules();
  } catch (err) {
    alert(`상태 변경 실패: ${mapServerError(err)}`);
  }
});

// Category pill inside the report meta box: cycle the schedule's category to
// the next one in state.categories (server returns id ASC). Wraps around at
// the end. Mirrors the status-pill cycle pattern — same undo entry shape,
// same reload flow.
els.reportMetaBox.addEventListener('click', async (e) => {
  const pill = e.target.closest('.schedule-cat-pill[data-action="cycle-category"]');
  if (!pill) return;
  const id = Number(pill.dataset.id);
  const sched = state.allSchedules.find((s) => s.id === id);
  if (!sched) return;
  const cats = state.categories;
  if (cats.length < 2) return; // nothing to cycle to
  const curIdx = cats.findIndex((c) => c.id === sched.category_id);
  const next = cats[(curIdx + 1) % cats.length];
  if (!next || next.id === sched.category_id) return;
  try {
    await api('PUT', `/api/schedules/${id}`, { category_id: next.id });
    state.undoStack.push({
      kind: 'schedule-update',
      id,
      before: { category_id: sched.category_id },
      after: { category_id: next.id },
    });
    state.redoStack = [];
    await loadAllSchedules();
    if (state.selectedCategoryId) await loadSchedules(state.selectedCategoryId);
    const updated = state.allSchedules.find((s) => s.id === id);
    if (updated) {
      const date = els.reportMetaBox.dataset.reportDate || '';
      renderReportMetaBox(updated, date);
      if (state.reportLinkedSchedule) state.reportLinkedSchedule.schedule = updated;
      // The report's category checkboxes auto-include the schedule's category
      // when opened from a Gantt bar. Keep them in sync so the saved report
      // doesn't end up tagged with the previous category. Existing user-checked
      // categories are preserved; we just swap the schedule-derived one.
      const checked = selectedCategoryIdsFromForm();
      const withoutOld = checked.filter((cid) => cid !== sched.category_id);
      if (!withoutOld.includes(next.id)) withoutOld.push(next.id);
      renderReportCategoryChecks(withoutOld);
    }
    renderSchedules();
  } catch (err) {
    alert(`카테고리 변경 실패: ${mapServerError(err)}`);
  }
});

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
  await withSubmitGuard(els.reportForm, async () => {
    const fd = new FormData(els.reportForm);
    const payload = {
      report_date: fd.get('report_date'),
      body: fd.get('body') || '',
      category_ids: selectedCategoryIdsFromForm(),
      exclude_from_team:
        els.reportExcludeFromTeam && els.reportExcludeFromTeam.checked ? 1 : 0,
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
      closeReportModal({ skipDirtyCheck: true });
      await refreshReportsForScope();
    } catch (err) {
      alert(`저장 실패: ${mapServerError(err)}`);
    }
  });
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
  // Multi-select: <input multiple> 으로 한 번에 여러 파일 선택 가능. 서버는
  // upload.single('file') 이라 파일마다 별개 POST 로 순차 전송 — 한 번에
  // 모두 보내는 multipart 보다 진행도 가시성이 좋고, 부분 실패 시 어느 파일이
  // 실패했는지 정확히 보고할 수 있다.
  const files = Array.from(e.target.files || []);
  if (files.length === 0) return;
  e.target.value = '';
  if (state.editingReportId) {
    const failures = [];
    for (const file of files) {
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
      } catch (err) {
        failures.push({ name: file.name, err });
      }
    }
    await reloadEditingReport();
    if (failures.length > 0) {
      const successCount = files.length - failures.length;
      const detail = failures
        .map((f) => `  • ${f.name}: ${mapServerError(f.err)}`)
        .join('\n');
      alert(`${successCount}/${files.length} 업로드 완료, ${failures.length}개 실패:\n${detail}`);
    }
  } else {
    // New report (no id yet): buffer until report is saved.
    for (const file of files) {
      state.pendingAttachments.push({
        kind: 'upload',
        file,
        display_name: file.name,
      });
    }
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

// 「완료 숨김」 — 간트에서 done 항목 가림. localStorage 영구화.
state.hideDone = localStorage.getItem('hideDone') === '1';
if (els.hideDoneToggle) {
  els.hideDoneToggle.checked = state.hideDone;
  els.hideDoneToggle.addEventListener('change', () => {
    state.hideDone = els.hideDoneToggle.checked;
    localStorage.setItem('hideDone', state.hideDone ? '1' : '0');
    renderSchedules();
  });
}

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
  // 첨부파일 이름 (display_name) 도 검색 대상. upload·local_path 모두 포함.
  if ((r.attachments || []).some((a) => (a.display_name || '').toLowerCase().includes(q))) return true;
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
  syncSprintReviewToolbar();
  renderSprintReviewGroupChips();

  const isSprintReviewScope = state.scope === 'sprint-review';
  // 활성 그룹의 멤버 집합을 미리 구해 두면 필터링이 O(1).
  let activeGroupMembers = null;
  let activeGroupSnapshotMap = null; // "owner:id" → {date,body} fallback when live data missing
  if (isSprintReviewScope && state.activeSprintGroupKey) {
    const grp = state.sprintGroups.find(
      (g) => `${g.creator}:${g.id}` === state.activeSprintGroupKey
    );
    if (grp) {
      activeGroupMembers = new Set();
      activeGroupSnapshotMap = new Map();
      for (const m of grp.members || []) {
        const key = `${m.report_owner || ''}:${m.report_id}`;
        activeGroupMembers.add(key);
        activeGroupSnapshotMap.set(key, {
          report_date: m.snapshot_date,
          body: m.snapshot_body,
        });
      }
    }
  }
  const matchesActiveGroup = (r) => {
    if (!isSprintReviewScope) return true;
    if (!activeGroupMembers) return false;
    return activeGroupMembers.has(`${r.owner || ''}:${r.id}`);
  };

  const q = state.allReportsQuery.trim().toLowerCase();
  const from = state.allReportsDateFrom;
  const to = state.allReportsDateTo;
  const ownerSel = state.allReportsOwner;
  // 「전체 간트/리포트에서 숨기기」: 검색·담당자 필터가 둘 다 비어 있고 스프린트
  // 리뷰 스코프가 아니며 팀 모드가 켜져 있을 때만, 태깅된 모든 카테고리가
  // hide_from_all_gantt = 1 인 리포트를 가린다. 하나라도 공개 카테고리가
  // 붙어 있으면 노출 (rule B). 카테고리 미태깅 리포트는 숨기지 않음.
  // 단독 사용 시엔 숨김 자체가 의미 없어 필터 미적용.
  const applyHide = !q && !ownerSel && !isSprintReviewScope && teamOn();
  const hidePass = (r) => !applyHide || !reportFullyHidden(r);
  const ownReports = (ownerSel && ownerSel !== '__self' && ownerSel !== '')
    ? []
    : state.allReports.filter(
        (r) => reportMatchesQuery(r, q) && reportInDateRange(r, from, to) &&
               matchesActiveGroup(r) && hidePass(r)
      );
  const teamReports = teamOn()
    ? state.team.merged.reports.filter(
        (r) => reportMatchesQuery(r, q) && reportInDateRange(r, from, to) &&
               (!ownerSel || ownerSel === r.owner) &&
               matchesActiveGroup(r) && hidePass(r)
      )
    : [];
  // 활성 그룹의 멤버 중 live 로 fetch 되지 않는 항목(작성자 오프라인 등)은
  // snapshot fallback 으로 합성해서 보여준다.
  let synthesized = [];
  if (isSprintReviewScope && activeGroupMembers) {
    const seenKeys = new Set();
    for (const r of ownReports) seenKeys.add(`${r.owner || ''}:${r.id}`);
    for (const r of teamReports) seenKeys.add(`${r.owner || ''}:${r.id}`);
    for (const key of activeGroupMembers) {
      if (seenKeys.has(key)) continue;
      const snap = activeGroupSnapshotMap.get(key);
      if (!snap) continue;
      // 검색·날짜 필터 적용
      const idx = key.indexOf(':');
      const owner = key.slice(0, idx);
      const id = Number(key.slice(idx + 1));
      const synth = {
        id, owner, snapshot_only: true,
        report_date: snap.report_date,
        body: snap.body,
        categories: [], schedules: [], attachments: [], comments: [],
      };
      if (!reportMatchesQuery(synth, q)) continue;
      if (!reportInDateRange(synth, from, to)) continue;
      if (ownerSel && ownerSel !== '' && ownerSel !== '__self' && ownerSel !== owner) continue;
      if (ownerSel === '__self' && owner) continue;
      synthesized.push(synth);
    }
  }
  const filtered = ownReports.concat(teamReports).concat(synthesized);

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
        // Team-owned uploads must point at the peer's server, not ours.
        const base = (a.peerHost && a.peerPort)
          ? `http://${encodeURIComponent(a.peerHost)}:${Number(a.peerPort)}`
          : '';
        return `<a class="att-chip" href="${base}/uploads/${encodeURIComponent(a.path)}" target="_blank" rel="noopener" title="${escapeHtml(a.display_name)}">📎 ${escapeHtml(a.display_name)}</a>`;
      }
      // local_path: only reachable when it's our own. Team peer's local
      // filesystem isn't accessible from here — render as non-clickable hint.
      if (a.owner) {
        return `<span class="att-chip" style="cursor:default;opacity:0.6;" title="원격 사용자 로컬 경로 — 접근 불가: ${escapeHtml(a.path)}">📁 ${escapeHtml(a.display_name)} (원격 로컬)</span>`;
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
        const statusAttr = s.status ? ` data-status="${escapeHtml(s.status)}"` : '';
        return `<span class="schedule-pill"${statusAttr} style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(s.title)}</span>`;
      }).join('');

    // OFF mode (default — date 그룹) — append indicators next to the
    // schedule pills on this specific report:
    //   "내 코멘트 N"          : 내가 남긴 코멘트 수 (팀 리포트인 경우)
    //   "받은 코멘트 N / 확인 n": 받은 코멘트 누적·확인 수 (본인 리포트)
    // ON mode 에서는 같은 정보가 날짜 헤더에 이미 있으므로 여기선 숨김.
    const offModeMyCount = state.allReportsBySchedule ? 0 : countMyComments(r);
    const offModeRecv = state.allReportsBySchedule
      ? { total: 0, acked: 0 }
      : countReceivedComments(r);
    const offModeMyBadge = myCommentBadgeHtml(offModeMyCount);
    const offModeRecvBadge = receivedCommentBadgeHtml(offModeRecv.total, offModeRecv.acked);
    const offModeBadges = offModeMyBadge + offModeRecvBadge;
    const schedulesHtml = (schedPills || offModeBadges)
      ? `<div class="report-item-schedules">${schedPills}${offModeBadges}</div>`
      : '';

    // Sprint-review 선택 모드 — 행 좌측에 체크박스. 전체 리포트 와
    // 스프린트 리뷰 양쪽에서 동작 (체크 의미는 scope 별로 다름).
    const sprintMode = state.sprintReview.mode &&
      (state.scope === 'all-reports' || state.scope === 'sprint-review');
    const reportKey = `${r.owner || ''}:${r.id}`;
    const checkboxHtml = sprintMode
      ? `<input type="checkbox" class="sprint-review-check" data-report-key="${escapeHtml(reportKey)}"${state.sprintReview.selected.has(reportKey) ? ' checked' : ''} />`
      : '';
    // 스냅샷 전용(원본 작성자 오프라인) 표시
    const snapshotBadge = r.snapshot_only
      ? `<span class="muted" title="원본 작성자가 오프라인 — 스프린트 리뷰 시점의 사본을 보여줍니다">· 스냅샷</span>`
      : '';

    const innerHtml = `
      ${schedulesHtml}
      <div class="report-item-body">${previewHtml}</div>
      <div class="report-item-meta">
        ${attChips || '<span class="muted">첨부 없음</span>'}
        ${otherTags ? `<span class="other-tags">${otherTags}</span>` : ''}
        ${teamOwnerSuffix(r.owner)}
        ${snapshotBadge}
      </div>
    `;
    if (sprintMode) {
      // flex row: 체크박스 ↔ 본문이 좌우 분리. .sprint-row 가 li 에 붙으면 CSS 에서 grid 처리.
      li.classList.add('sprint-row');
      li.innerHTML = `${checkboxHtml}<div class="sprint-row-content">${innerHtml}</div>`;
    } else {
      li.innerHTML = innerHtml;
    }
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
      dateHead.textContent = formatDateKo(date);
      // ON mode (스케줄별 그룹) — append indicators to date head:
      //   "내 코멘트 N"          : 내가 다른 팀원 리포트에 남긴 코멘트 수
      //   "받은 코멘트 N / 확인 n" : 본인 리포트에 받은 코멘트 누적·확인 수
      if (state.allReportsBySchedule) {
        const dayReports0 = byDate.get(date);
        const myCount = dayReports0.reduce((s, r) => s + countMyComments(r), 0);
        let recvTotal = 0, recvAcked = 0;
        for (const r of dayReports0) {
          const { total, acked } = countReceivedComments(r);
          recvTotal += total;
          recvAcked += acked;
        }
        if (myCount > 0) {
          dateHead.insertAdjacentHTML('beforeend', myCommentBadgeHtml(myCount));
        }
        if (recvTotal > 0) {
          dateHead.insertAdjacentHTML('beforeend', receivedCommentBadgeHtml(recvTotal, recvAcked));
        }
      }
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
        const schedStatusAttr = sched.status ? ` data-status="${escapeHtml(sched.status)}"` : '';
        schedHead.innerHTML = `
          <span class="schedule-pill"${schedStatusAttr} style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(sched.title)}</span>
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
  if (e.target.matches('input.sprint-review-check')) return;
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
  if (!r) return;
  // Comment-only viewer (외부 협력자): owns nothing on this server, so the
  // "본인 리포트 모달" (no input form) is the wrong UI — show the team viewer
  // which has the comment form. owner is left empty here; openTeamReportViewer
  // falls back to state.team.self.name so comment-out forwards to the local
  // self-peer and writes the comment via /api/team/comment-in.
  if (!state.canWrite && state.canComment) {
    openTeamReportViewer(r);
    return;
  }
  openReportModal(r);
});

// ---------- Sprint review ----------

async function loadSprintGroups() {
  try {
    state.sprintGroups = await api('GET', '/api/sprint-groups');
  } catch {
    state.sprintGroups = [];
  }
}

async function selectSprintReviewView() {
  state.scope = 'sprint-review';
  state.selectedCategoryId = null;
  state.expandConnected = false;
  // 진입 시 선택/모드 초기화
  state.sprintReview.mode = false;
  state.sprintReview.selected.clear();
  state.sprintReview.originalMembers = null;
  renderCategories();
  await Promise.all([loadAllReports(), loadSprintGroups()]);
  // 활성 그룹이 사라졌으면 첫 그룹으로 폴백, 처음 진입이면 첫 그룹 자동 선택
  const allKeys = state.sprintGroups.map((g) => `${g.creator}:${g.id}`);
  if (
    !state.activeSprintGroupKey ||
    !allKeys.includes(state.activeSprintGroupKey)
  ) {
    state.activeSprintGroupKey = allKeys[0] || null;
  }
  renderCategoryView();
  queueSaveLastView();
}

function syncSprintReviewToolbar() {
  const toggleBtn = els.sprintReviewToggleBtn;
  if (els.allReportsTitle) {
    els.allReportsTitle.textContent =
      state.scope === 'sprint-review' ? '스프린트 리뷰' : '전체 리포트';
  }
  if (!toggleBtn) return;
  toggleBtn.classList.toggle('active', state.sprintReview.mode);
  toggleBtn.textContent = state.sprintReview.mode ? '선택 확인' : '선택';
  // 스프린트 리뷰 scope 에서는 본인 소유 그룹이 활성일 때만 「선택」 노출.
  // peer 그룹은 본인이 편집할 수 없으므로 버튼을 숨긴다. 전체 리포트 에서는 항상 노출.
  if (state.scope === 'sprint-review') {
    const me = selfDisplayName();
    const grp = state.activeSprintGroupKey
      ? state.sprintGroups.find((g) => `${g.creator}:${g.id}` === state.activeSprintGroupKey)
      : null;
    const editable = !!grp && grp.creator === me;
    toggleBtn.classList.toggle('hidden', !editable);
  } else {
    toggleBtn.classList.remove('hidden');
  }
}

// 본인 self.name — 본인 그룹은 creator 가 이 이름과 같은 항목.
function selfDisplayName() {
  return (state.team && state.team.self && state.team.self.name) || '';
}

function renderSprintReviewGroupChips() {
  const root = els.sprintReviewGroups;
  if (!root) return;
  if (state.scope !== 'sprint-review') {
    root.classList.add('hidden');
    return;
  }
  root.classList.remove('hidden');
  root.innerHTML = '';
  if (state.sprintGroups.length === 0) {
    const empty = document.createElement('span');
    empty.className = 'muted-empty';
    empty.textContent = '아직 만들어진 스프린트 그룹이 없습니다. 전체 리포트에서 「스프린트 리뷰」 모드로 그룹을 만들어보세요.';
    root.appendChild(empty);
    return;
  }
  const me = selfDisplayName();
  for (const g of state.sprintGroups) {
    const chip = document.createElement('span');
    chip.className = 'sprint-group-chip';
    const key = `${g.creator}:${g.id}`;
    if (key === state.activeSprintGroupKey) chip.classList.add('active');
    chip.dataset.groupKey = key;
    const isOwn = g.creator === me;
    // 이름 뒤에 만든 사람을 접미사로 붙여 chip 하나에서 출처 식별 가능.
    // creator 가 비어 있으면 (self.name 미설정 등) suffix 생략.
    const creatorName = g.creator || '';
    const displayName = creatorName
      ? `${g.name}_${creatorName}`
      : g.name;
    const delBtn = isOwn
      ? `<span class="delete" data-action="delete-sprint-group" title="그룹 삭제">×</span>`
      : '';
    chip.innerHTML = `
      <span class="name">${escapeHtml(displayName)}</span>
      <span class="count">(${g.member_count}건)</span>
      ${delBtn}
    `;
    root.appendChild(chip);
  }
}

if (els.sprintReviewGroups) {
  els.sprintReviewGroups.addEventListener('click', async (e) => {
    const delBtn = e.target.closest('[data-action="delete-sprint-group"]');
    if (delBtn) {
      const chip = delBtn.closest('.sprint-group-chip');
      const key = chip && chip.dataset.groupKey;
      const g = state.sprintGroups.find((x) => `${x.creator}:${x.id}` === key);
      if (!g) return;
      // 본인 그룹만 삭제 가능 — UI 에서 본인 chip 에만 × 가 붙음.
      if (g.creator !== selfDisplayName()) return;
      if (!confirm(`「${g.name}」을 삭제할까요? 그룹에 속한 리포트 자체는 삭제되지 않습니다.`)) return;
      try {
        await api('DELETE', `/api/sprint-groups/${g.id}`);
      } catch (err) {
        alert('그룹 삭제 실패: ' + (err && err.message));
        return;
      }
      if (state.activeSprintGroupKey === key) state.activeSprintGroupKey = null;
      await loadSprintGroups();
      if (!state.activeSprintGroupKey && state.sprintGroups[0]) {
        state.activeSprintGroupKey = `${state.sprintGroups[0].creator}:${state.sprintGroups[0].id}`;
      }
      renderAllReportsView();
      return;
    }
    const chip = e.target.closest('.sprint-group-chip');
    if (!chip) return;
    state.activeSprintGroupKey = chip.dataset.groupKey;
    // 그룹 전환 시 진행 중인 「선택」 편집 모드는 취소.
    state.sprintReview.mode = false;
    state.sprintReview.selected.clear();
    state.sprintReview.originalMembers = null;
    renderAllReportsView();
    queueSaveLastView();
  });
}

if (els.sprintReviewBtn) {
  els.sprintReviewBtn.addEventListener('click', () => {
    selectSprintReviewView();
  });
}

if (els.sprintReviewToggleBtn) {
  els.sprintReviewToggleBtn.addEventListener('click', async () => {
    // 「선택」 동작은 scope 에 따라 달라진다.
    //   전체 리포트: 빈 set 으로 시작 → 확인 시 새 그룹 저장 모달
    //   스프린트 리뷰: 현재 그룹 멤버를 pre-check → 확인 시 체크 해제된 항목만 그룹에서 제거
    if (state.scope === 'sprint-review') {
      await handleSprintReviewToggleInGroupView();
      return;
    }
    // 전체 리포트 분기
    if (state.sprintReview.mode) {
      if (state.sprintReview.selected.size > 0) {
        openSprintGroupModal();
        return;
      }
      state.sprintReview.mode = false;
      state.sprintReview.selected.clear();
      renderAllReportsView();
      return;
    }
    state.sprintReview.mode = true;
    renderAllReportsView();
  });
}

async function handleSprintReviewToggleInGroupView() {
  const me = selfDisplayName();
  const grp = state.activeSprintGroupKey
    ? state.sprintGroups.find((g) => `${g.creator}:${g.id}` === state.activeSprintGroupKey)
    : null;
  if (!grp || grp.creator !== me) return; // 안전장치 — 버튼이 보이지 않아야 정상

  if (!state.sprintReview.mode) {
    // 진입: 현재 그룹 멤버를 모두 pre-check
    const memberKeys = (grp.members || []).map(
      (m) => `${m.report_owner || ''}:${m.report_id}`
    );
    state.sprintReview.mode = true;
    state.sprintReview.selected = new Set(memberKeys);
    state.sprintReview.originalMembers = new Set(memberKeys);
    renderAllReportsView();
    return;
  }

  // 확인: 원본 - 현재선택 = 제거할 멤버
  const original = state.sprintReview.originalMembers || new Set();
  const toRemove = [...original].filter((k) => !state.sprintReview.selected.has(k));
  if (toRemove.length === 0) {
    // 변경 없음 → 모드 종료
    state.sprintReview.mode = false;
    state.sprintReview.selected.clear();
    state.sprintReview.originalMembers = null;
    renderAllReportsView();
    return;
  }
  const members = toRemove.map((k) => {
    const idx = k.indexOf(':');
    return { owner: k.slice(0, idx), report_id: Number(k.slice(idx + 1)) };
  });
  try {
    await api('POST', `/api/sprint-groups/${grp.id}/remove-members`, { members });
  } catch (err) {
    alert('멤버 제거 실패: ' + (err && err.message));
    return;
  }
  state.sprintReview.mode = false;
  state.sprintReview.selected.clear();
  state.sprintReview.originalMembers = null;
  await loadSprintGroups();
  renderAllReportsView();
}

// 기존 별도 「확인」 버튼은 사용처가 없어 클릭 핸들러도 제거. DOM 은 hidden 으로 유지.

if (els.allReportsContent) {
  els.allReportsContent.addEventListener('change', (e) => {
    const cb = e.target.closest('input.sprint-review-check');
    if (!cb) return;
    const key = cb.dataset.reportKey;
    if (cb.checked) state.sprintReview.selected.add(key);
    else state.sprintReview.selected.delete(key);
    // 같은 리포트가 여러 카테고리 섹션에 등장하는 경우 모두 동기화
    els.allReportsContent
      .querySelectorAll(`input.sprint-review-check[data-report-key="${CSS.escape(key)}"]`)
      .forEach((c) => { c.checked = cb.checked; });
  });
}

function openSprintGroupModal() {
  if (!els.sprintGroupModal) return;
  els.sprintGroupForm.reset();
  if (els.sprintGroupModalHint) {
    els.sprintGroupModalHint.textContent =
      `선택한 ${state.sprintReview.selected.size}건의 리포트를 새 그룹으로 묶습니다.`;
  }
  els.sprintGroupModal.classList.remove('hidden');
  setTimeout(() => {
    const input = els.sprintGroupForm.querySelector('input[name="name"]');
    if (input) input.focus();
  }, 0);
}

function closeSprintGroupModal() {
  if (els.sprintGroupModal) els.sprintGroupModal.classList.add('hidden');
}

// 선택한 composite key → 그 리포트의 현재 body·date 를 찾아 snapshot 으로 첨부.
// 본인 리포트는 state.allReports, peer 리포트는 state.team.merged.reports 에서 lookup.
function snapshotForKey(key) {
  const idx = key.indexOf(':');
  const owner = key.slice(0, idx);
  const report_id = Number(key.slice(idx + 1));
  let r;
  if (owner === '') {
    r = state.allReports.find((x) => x.id === report_id);
  } else {
    r = state.team.merged.reports.find((x) => x.owner === owner && x.id === report_id);
  }
  return {
    report_id,
    owner,
    snapshot_date: (r && r.report_date) || '',
    snapshot_body: (r && r.body) || '',
  };
}

if (els.sprintGroupForm) {
  els.sprintGroupForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = (new FormData(els.sprintGroupForm).get('name') || '').toString().trim();
    if (!name) return;
    const members = [...state.sprintReview.selected].map(snapshotForKey);
    try {
      await api('POST', '/api/sprint-groups', { name, members });
    } catch (err) {
      if (err && err.status === 409) {
        alert(`이미 존재하는 그룹 이름입니다: "${name}". 다른 이름을 사용해주세요.`);
      } else {
        alert('그룹 생성 실패: ' + (err && err.message));
      }
      return;
    }
    closeSprintGroupModal();
    state.sprintReview.mode = false;
    state.sprintReview.selected.clear();
    await loadSprintGroups();
    renderAllReportsView();
  });
}

if (els.sprintGroupModal) {
  els.sprintGroupModal.addEventListener('click', (e) => {
    if (e.target === els.sprintGroupModal) closeSprintGroupModal();
    if (e.target.matches('[data-close]')) closeSprintGroupModal();
  });
}

function openTeamReportViewer(r) {
  const m = document.getElementById('team-report-viewer-modal');
  if (!m) return;
  // Comment-only viewers see local reports here; r.owner is empty. Resolve to
  // the host's self-name so the comment-out → self-peer → comment-in loop has
  // a target to look up.
  const effectiveOwner = r.owner || (state.team.self && state.team.self.name) || '';
  document.getElementById('team-report-viewer-owner').textContent = effectiveOwner;
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
        const statusAttr = s.status ? ` data-status="${escapeHtml(s.status)}"` : '';
        return `<span class="schedule-pill"${statusAttr} style="background:${escapeHtml(bg)};color:${inkOn(bg)};">${escapeHtml(s.title)}</span>`;
      }).join(' ')}`
    : '';

  const body = (r.body || '').trim();
  document.getElementById('team-report-viewer-body').innerHTML = body
    ? linkifyHtml(body)
    : '<span class="muted">(빈 본문)</span>';

  const attEl = document.getElementById('team-report-viewer-attachments');
  attEl.innerHTML = '';
  for (const a of (r.attachments || [])) {
    if (a.kind === 'upload') {
      // Peer-imported uploads carry peerHost/peerPort; local reports (e.g.,
      // comment-only viewer browsing this host's own reports) have neither,
      // so fall back to same-origin /uploads/.
      const href = (a.peerHost && a.peerPort)
        ? `http://${encodeURIComponent(a.peerHost)}:${Number(a.peerPort)}/uploads/${encodeURIComponent(a.path)}`
        : `/uploads/${encodeURIComponent(a.path)}`;
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

  // Comments panel — track which report we're commenting on so the submit
  // handler can route to the right peer and report. For local reports viewed
  // by comment-only users, fall back to self.name (the host's own peer entry)
  // so submitTeamComment → /api/team/comment-out resolves a target.
  m.dataset.owner = effectiveOwner;
  m.dataset.reportId = String(r.id);
  renderTeamCommentsList(r.comments || [], effectiveOwner);
  const inputEl = document.getElementById('team-comments-input');
  if (inputEl) inputEl.value = '';

  m.classList.remove('hidden');
}

function renderCommentsInto(listId, countId, comments, opts) {
  const list = document.getElementById(listId);
  const count = document.getElementById(countId);
  if (!list) return;
  const arr = comments || [];
  // editable=true → 본인이 작성한 코멘트에 「편집/삭제」 버튼
  // ackable=true  → 타인이 작성한 미확인 코멘트에 「확인」 버튼 (본인 리포트 모달 전용)
  // reportId=N    → ack 요청에 사용할 리포트 ID
  const editable = !!(opts && opts.editable);
  const ackable = !!(opts && opts.ackable);
  const owner = (opts && opts.owner) || '';
  const reportId = (opts && opts.reportId) || '';
  // selfName drives "본인 코멘트" matching for editable + ack visibility.
  // state.commenterName (from /api/auth/me) is the canonical author the server
  // uses for OUR posts — for canWrite users it's self.name, for COMMENT-only
  // IPs it's "외부(<ip>)". Falling back to state.team.self.name keeps older
  // call sites working before commenterName is loaded.
  const selfName = state.commenterName || (state.team.self && state.team.self.name) || '';
  list.innerHTML = '';
  if (count) count.textContent = arr.length > 0 ? `(${arr.length})` : '';
  if (arr.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '아직 코멘트가 없습니다';
    list.appendChild(li);
    return;
  }
  // Render in chronological order (oldest first).
  const ordered = arr.slice().sort((a, b) => {
    const ka = a.created_at || '';
    const kb = b.created_at || '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  for (const c of ordered) {
    const li = document.createElement('li');
    li.dataset.commentId = String(c.id);
    if (owner) li.dataset.owner = owner;
    if (reportId) li.dataset.reportId = String(reportId);
    if (c.acknowledged) li.classList.add('comment-acked');
    const head = document.createElement('div');
    head.className = 'team-comment-head';
    const author = document.createElement('span');
    author.className = 'team-comment-author';
    author.textContent = c.author || '?';
    const ts = document.createElement('span');
    ts.textContent = formatCommentTimestamp(c.created_at);
    head.appendChild(author);
    head.appendChild(ts);
    const body = document.createElement('div');
    body.className = 'team-comment-body';
    body.textContent = c.body || '';
    li.appendChild(head);
    li.appendChild(body);

    const actionParts = [];
    if (editable && selfName && c.author === selfName) {
      actionParts.push('<button type="button" class="btn-link" data-action="edit-comment">편집</button>');
      actionParts.push('<button type="button" class="btn-link btn-link-danger" data-action="remove-comment">삭제</button>');
    }
    if (ackable && c.author !== selfName && !c.acknowledged) {
      actionParts.push('<button type="button" class="btn-link" data-action="ack-comment">확인</button>');
    }
    if (ackable && c.acknowledged) {
      actionParts.push('<span class="muted" style="font-size:11px;">확인됨</span>');
    }
    if (actionParts.length > 0) {
      const actions = document.createElement('div');
      actions.className = 'team-comment-actions';
      actions.innerHTML = actionParts.join('');
      li.appendChild(actions);
    }
    list.appendChild(li);
  }
}

function renderTeamCommentsList(comments, owner) {
  renderCommentsInto('team-comments-list', 'team-comments-count', comments, {
    editable: true,
    owner: owner || (document.getElementById('team-report-viewer-modal')?.dataset.owner || ''),
  });
}

function renderOwnReportComments(comments, reportId) {
  renderCommentsInto('report-comments-list', 'report-comments-count', comments, {
    editable: false,
    ackable: true,
    reportId: reportId || state.editingReportId || '',
  });
}

// SQLite stores datetime('now') in UTC as "YYYY-MM-DD HH:MM:SS". Convert to
// local "YYYY-MM-DD HH:MM:SS" so users see when they actually saw it.
function formatCommentTimestamp(s) {
  if (!s) return '';
  // Treat SQLite UTC strings ("YYYY-MM-DD HH:MM:SS") as UTC explicitly.
  const iso = /\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}/.test(s)
    ? s.replace(' ', 'T') + 'Z'
    : s;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return s;
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

async function submitTeamComment() {
  const m = document.getElementById('team-report-viewer-modal');
  const input = document.getElementById('team-comments-input');
  const submitBtn = document.getElementById('team-comments-submit');
  if (!m || !input) return;
  const owner = m.dataset.owner || '';
  const reportId = Number(m.dataset.reportId);
  const body = input.value.trim();
  if (!owner || !reportId) {
    showToast('대상 리포트 정보 없음', 'error');
    return;
  }
  if (!body) {
    showToast('코멘트를 입력하세요', 'error');
    return;
  }
  if (submitBtn) submitBtn.disabled = true;
  try {
    const res = await fetch('/api/team/comment-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, report_id: reportId, body }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = err.detail && typeof err.detail === 'string' ? err.detail
                   : err.detail && err.detail.error ? err.detail.error
                   : err.error || res.status;
      showToast(`코멘트 전송 실패: ${detail}`, 'error');
      return;
    }
    const data = await res.json().catch(() => ({}));
    input.value = '';
    showToast('코멘트가 전송되었습니다');

    // Optimistic update — append the comment to local merged cache and
    // re-render immediately. A's server already accepted it; the next
    // background sync will reconcile against canonical data. The author
    // string came back from A (resolved via IP), and we approximate the
    // timestamp client-side. formatCommentTimestamp() handles both ISO
    // and SQLite formats.
    const optimistic = {
      id: data.id || `local-${Date.now()}`,
      report_id: reportId,
      author: data.author || state.commenterName || (state.team.self && state.team.self.name) || '?',
      body,
      created_at: new Date().toISOString(),
      owner,
    };
    // Peer-imported reports live in state.team.merged.reports; local reports
    // (comment-only viewers commenting on this host's own reports) live in
    // state.allReports. Update whichever holds this id.
    const teamReport = state.team.merged.reports.find(
      (x) => x.id === reportId && x.owner === owner
    );
    const localReport = teamReport
      ? null
      : state.allReports.find((x) => x.id === reportId);
    const target = teamReport || localReport;
    if (target) {
      target.comments = [...(target.comments || []), optimistic];
      renderTeamCommentsList(target.comments, owner);
      if (state.scope === 'all-reports' && typeof renderAllReportsView === 'function') {
        renderAllReportsView();
      }
    }

    // Background sync to canonicalize without blocking the UI. For peer reports
    // we re-pull the team merge; for local reports we refresh state.allReports.
    (async () => {
      if (teamReport) {
        try { await fetch('/api/team/sync', { method: 'POST' }); } catch {}
        try { await loadTeamMerged(); } catch {}
      } else if (localReport) {
        try { state.allReports = await api('GET', '/api/reports'); } catch {}
        if (state.scope === 'all-reports' && typeof renderAllReportsView === 'function') {
          renderAllReportsView();
        }
      }
    })();
  } catch (e) {
    showToast(`코멘트 오류: ${e.message}`, 'error');
  } finally {
    if (submitBtn) submitBtn.disabled = false;
  }
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

    // H-18: pointer events.
    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
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
        document.removeEventListener('pointermove', onMove);
        document.removeEventListener('pointerup', onUp);
        document.removeEventListener('pointercancel', onUp);
        handle.classList.remove('dragging');
        const widths = ths.map((t) => t.offsetWidth);
        saveColWidths(tableId, widths);
      }
      try { handle.setPointerCapture(e.pointerId); } catch {}
      document.addEventListener('pointermove', onMove);
      document.addEventListener('pointerup', onUp);
      document.addEventListener('pointercancel', onUp);
    });
  });
}

// ---------- 마지막 본 영역 기억 (localStorage) ----------
// 새로고침해도 사용자가 보던 카테고리/scope 로 복귀. boot 시 categories
// 로드 후 한 번만 사용 — 이후 모든 scope 전환은 setLastView() 가 즉시 갱신.
const LAST_VIEW_KEY = 'aletheia.lastView';
function saveLastView() {
  try {
    localStorage.setItem(LAST_VIEW_KEY, JSON.stringify({
      scope: state.scope,
      categoryId: state.selectedCategoryId,
      sprintGroupKey: state.activeSprintGroupKey,
    }));
  } catch { /* localStorage 비활성 — 무시 */ }
}
function readLastView() {
  try {
    const raw = localStorage.getItem(LAST_VIEW_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// scope 전환 함수들이 boot 이후 호출될 때마다 자동 저장.
// selectCategory / selectAllView / selectAllReportsView / selectSprintReviewView
// 안에 saveLastView() 를 호출하지 않고 setInterval-free 방식: state 변화 후
// 다음 microtask 에 1회 저장 (debounce 효과).
let _saveLastViewQueued = false;
function queueSaveLastView() {
  if (_saveLastViewQueued) return;
  _saveLastViewQueued = true;
  queueMicrotask(() => {
    _saveLastViewQueued = false;
    saveLastView();
  });
}

// ---------- Init ----------
refreshAll().then(() => {
  const saved = readLastView();
  if (saved) {
    if (saved.scope === 'category' && saved.categoryId) {
      const exists = state.categories.find((c) => c.id === saved.categoryId);
      if (exists) { selectCategory(saved.categoryId); return; }
    }
    if (saved.scope === 'all') { selectAllView(); return; }
    if (saved.scope === 'all-reports') { selectAllReportsView(); return; }
    if (saved.scope === 'sprint-review') {
      // activeSprintGroupKey 는 selectSprintReviewView 가 그룹 로드 후 결정.
      // 저장된 키가 살아 있으면 그 그룹으로 자동 활성.
      if (saved.sprintGroupKey) state.activeSprintGroupKey = saved.sprintGroupKey;
      selectSprintReviewView();
      return;
    }
  }
  // 저장된 게 없거나 무효 → 기본 동작 (첫 카테고리)
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

// Helper: should merged data (live team peers OR imported archived peers) be
// shown in integrated views? Returns true if the live team mode is ON, OR if
// at least one imported peer exists — imported peers are visible regardless
// of team mode so the archive survives even when team mode is off.
function teamOn() {
  if (state.team.mode === 'ON') return true;
  if (state.archivedPeers && state.archivedPeers.length > 0) return true;
  return false;
}

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
    // H-13: registerPoll 사용 — 탭 백그라운드 시 자동 정지.
    state.team.pollTimer = registerPoll(loadTeamState, 5000);
  } else if (data.mode === 'OFF' && state.team.pollTimer) {
    state.team.pollTimer.stop();
    // _polls 배열에 그대로 두면 visibilitychange 시 다시 살아남 — 제거.
    const idx = _polls.indexOf(state.team.pollTimer);
    if (idx >= 0) _polls.splice(idx, 1);
    state.team.pollTimer = null;
  }

  // Refresh merged data whenever the server's lastSyncAt advances. Also fetch
  // once on the first ON state observation. When OFF, we still load merged
  // if at least one archived peer exists — the server returns its imported
  // data and we want it visible regardless of team mode.
  if (data.mode === 'ON') {
    if (data.lastSyncAt && data.lastSyncAt !== state.team.mergedLoadedFor) {
      loadTeamMerged();
    }
  } else {
    // OFF + 보관된 팀원 있음 → 한 번 받아 와서 표시 유지
    if (state.archivedPeers && state.archivedPeers.length > 0) {
      loadTeamMerged();
    } else if (state.team.mergedLoadedFor !== null) {
      // OFF + 보관된 사람도 없음 → merged 비움
      state.team.merged = { categories: [], schedules: [], dependencies: [], reports: [] };
      state.team.mergedLoadedFor = null;
      if (typeof renderCategories === 'function') renderCategories();
      if (typeof renderCategoryView === 'function') renderCategoryView();
      if (typeof renderAllReportsView === 'function' &&
          (state.scope === 'all-reports' || state.scope === 'sprint-review')) {
        renderAllReportsView();
      }
    }
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

// Mirrors syncAllReportsOwnerOptions, but for the 전체 간트 (scope === 'all')
// owner dropdown. Visible only when we're in 전체 간트 AND team mode is ON,
// since peers are the only thing to filter against. Resetting state.allOwner
// to '' when hidden keeps stale selections from leaking back when the user
// returns to 전체 간트.
function syncAllOwnerOptions() {
  const wrap = els.allOwnerWrap;
  const sel = els.allOwner;
  if (!wrap || !sel) return;
  const shouldShow = state.scope === 'all' && teamOn();
  if (!shouldShow) {
    wrap.classList.add('hidden');
    if (state.allOwner) state.allOwner = '';
    return;
  }
  wrap.classList.remove('hidden');

  const currentValue = state.allOwner;
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
  state.allOwner = sel.value;
}

if (els.allOwner) {
  els.allOwner.addEventListener('change', () => {
    state.allOwner = els.allOwner.value;
    renderSchedules();
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
  // db_changed 는 본인 서버에서 어떤 mutating 응답이 성공할 때마다 emit.
  // 즉시 version 비교 → 변경됐으면 refresh. 가장 빠른 반응 경로 (~50ms).
  // 3초 폴링은 SSE 가 끊겼을 때 안전망 역할.
  if (ev.kind === 'db_changed') {
    if (typeof checkAndReloadIfChanged === 'function') checkAndReloadIfChanged();
    return;
  }
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
  } else if (ev.kind === 'comment_received') {
    const author = ev.detail.author || '?';
    const preview = ev.detail.bodyPreview || '';
    const reportId = ev.detail.report_id;
    showToast(`${author}이(가) 리포트에 코멘트를 남겼습니다: ${preview}`, 'info', 5000);
    refreshAfterCommentEvent(reportId);
  } else if (ev.kind === 'comment_edited') {
    const author = ev.detail.author || '?';
    const preview = ev.detail.bodyPreview || '';
    const reportId = ev.detail.report_id;
    showToast(`${author} 코멘트 수정됨: ${preview}`, 'info', 4000);
    refreshAfterCommentEvent(reportId);
  } else if (ev.kind === 'comment_removed') {
    const author = ev.detail.author || '?';
    const reportId = ev.detail.report_id;
    showToast(`${author}이(가) 코멘트를 삭제했습니다`, 'info', 4000);
    refreshAfterCommentEvent(reportId);
  } else if (ev.kind === 'task_request_received') {
    const sender = ev.detail.sender || '?';
    const preview = ev.detail.bodyPreview || '';
    const dl = ev.detail.deadline ? ` (기한: ${ev.detail.deadline})` : '';
    showToast(`${sender}이(가) 업무를 요청했습니다${dl}: ${preview}`, 'info', 6000);
    // Pending count changed — refresh launcher / choice badges.
    refreshInboundPendingBadge();
    // If the inbound list modal is open, refresh it inline.
    if (taskInboundEls && taskInboundEls.modal &&
        !taskInboundEls.modal.classList.contains('hidden')) {
      loadAndRenderInbound().catch(() => {});
    }
  } else if (ev.kind === 'task_request_responded') {
    const responder = ev.detail.responder || '?';
    const status = ev.detail.status || '';
    const label = TASK_STATUS_LABEL ? (TASK_STATUS_LABEL[status] || status) : status;
    const preview = ev.detail.bodyPreview ? ` — ${ev.detail.bodyPreview}` : '';
    showToast(`${responder}: ${label}${preview}`, 'info', 5000);
    // If outbound list modal is open, refresh inline (status border updates).
    // The push has already updated local DB via /task-response-in so a plain
    // load-and-render is enough — no need to also pull.
    if (taskEls.outboundModal && !taskEls.outboundModal.classList.contains('hidden')) {
      loadAndRenderOutbound().catch(() => {});
    }
  }
}

// On any comment_* event, freshen our own data (own reports' comments[] now
// changed in our DB) and re-render whichever surface might display them.
async function refreshAfterCommentEvent(reportId) {
  try { await loadAllReports(); } catch {}
  if (state.scope === 'all-reports' && typeof renderAllReportsView === 'function') {
    renderAllReportsView();
  }
  if (state.editingReportId === Number(reportId) &&
      els.reportModal && !els.reportModal.classList.contains('hidden')) {
    await refreshOwnReportComments(reportId);
  }
}

async function refreshOwnReportComments(reportId) {
  try {
    const r = await api('GET', `/api/reports/${reportId}`);
    if (r && Array.isArray(r.comments)) {
      renderOwnReportComments(r.comments, reportId);
    }
  } catch { /* ignore — toast already informed user */ }
}

function refreshTeamManageListIfOpen() {
  if (teamManageEls && teamManageEls.modal &&
      !teamManageEls.modal.classList.contains('hidden') &&
      typeof refreshTeamManageList === 'function') {
    refreshTeamManageList();
  }
}

// Real-time team events via Server-Sent Events. Falls back to polling if
// EventSource init fails (very rare on modern browsers — kept as defense).
let teamEventSource = null;
function startTeamEventStream() {
  if (teamEventSource) return;
  try {
    teamEventSource = new EventSource('/api/team/events-stream');
    teamEventSource.addEventListener('message', (e) => {
      try { handleTeamEvent(JSON.parse(e.data)); }
      catch { /* malformed event payload — ignore */ }
    });
    // EventSource auto-reconnects on transient errors, so no error handler.
  } catch (e) {
    console.warn('[team] SSE 연결 실패 — 폴링 폴백:', e && e.message);
    registerPoll(pollTeamEvents, 5000); // H-13
    pollTeamEvents();
  }
}
startTeamEventStream();

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

const teamCommentsSubmitBtn = document.getElementById('team-comments-submit');
if (teamCommentsSubmitBtn) {
  teamCommentsSubmitBtn.addEventListener('click', submitTeamComment);
}

// Edit/delete on own comments inside the team report viewer modal. Single
// delegated listener — renderCommentsInto wipes the list on each render so
// per-row listeners would leak.
// "확인" button on received comments inside the OWN report modal. Local
// action — POST /api/reports/:rid/comments/:cid/ack to flip acknowledged
// flag, then optimistically update local state so the unread indicator
// drops without a full reload.
const reportCommentsListEl = document.getElementById('report-comments-list');
if (reportCommentsListEl) {
  reportCommentsListEl.addEventListener('click', async (e) => {
    if (!e.target.matches('button[data-action="ack-comment"]')) return;
    const li = e.target.closest('li[data-comment-id]');
    if (!li) return;
    const commentId = Number(li.dataset.commentId);
    const reportId = Number(li.dataset.reportId);
    if (!commentId || !reportId) return;
    try {
      const res = await fetch(`/api/reports/${reportId}/comments/${commentId}/ack`, {
        method: 'POST',
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`확인 실패: ${err.error || res.status}`, 'error');
        return;
      }
      // Optimistic local update — flip acknowledged in state.allReports[].comments[].
      const r = (state.allReports || []).find((x) => x.id === reportId);
      if (r && Array.isArray(r.comments)) {
        const idx = r.comments.findIndex((c) => Number(c.id) === commentId);
        if (idx >= 0) r.comments[idx] = { ...r.comments[idx], acknowledged: 1 };
        renderOwnReportComments(r.comments, reportId);
        if (state.scope === 'all-reports') renderAllReportsView();
      }
    } catch (e) {
      showToast(`확인 오류: ${e.message}`, 'error');
    }
  });
}

const teamCommentsListEl = document.getElementById('team-comments-list');
if (teamCommentsListEl) {
  teamCommentsListEl.addEventListener('click', async (e) => {
    const li = e.target.closest('li[data-comment-id]');
    if (!li) return;
    const commentId = Number(li.dataset.commentId);
    const owner = li.dataset.owner || '';

    if (e.target.matches('button[data-action="edit-comment"]')) {
      enterCommentEditMode(li);
      return;
    }
    if (e.target.matches('button[data-action="cancel-comment"]')) {
      // Revert to the canonical render via the cached merged report.
      const reportId = Number(document.getElementById('team-report-viewer-modal')?.dataset.reportId || 0);
      const r = state.team.merged.reports.find((x) => x.id === reportId && x.owner === owner);
      if (r) renderTeamCommentsList(r.comments || [], owner);
      return;
    }
    if (e.target.matches('button[data-action="save-comment"]')) {
      const ta = li.querySelector('.team-comment-edit-input');
      const newBody = ta ? ta.value.trim() : '';
      if (!newBody) { showToast('내용을 입력하세요', 'error'); return; }
      await saveCommentEdit(owner, commentId, newBody);
      return;
    }
    if (e.target.matches('button[data-action="remove-comment"]')) {
      if (!confirm('이 코멘트를 삭제할까요?')) return;
      await removeOwnComment(owner, commentId);
      return;
    }
  });
}

function enterCommentEditMode(li) {
  const body = li.querySelector('.team-comment-body');
  const actions = li.querySelector('.team-comment-actions');
  if (!body) return;
  const original = body.textContent || '';
  const wrapper = document.createElement('div');
  wrapper.className = 'team-comment-edit-wrapper';
  wrapper.innerHTML =
    '<textarea class="team-comment-edit-input" rows="3"></textarea>' +
    '<div class="team-comment-edit-actions">' +
      '<button type="button" class="btn" data-action="cancel-comment">취소</button>' +
      '<button type="button" class="btn btn-primary" data-action="save-comment">저장</button>' +
    '</div>';
  wrapper.querySelector('textarea').value = original;
  body.replaceWith(wrapper);
  if (actions) actions.style.display = 'none';
  wrapper.querySelector('textarea').focus();
}

async function saveCommentEdit(owner, commentId, newBody) {
  try {
    const res = await fetch('/api/team/comment-edit-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, comment_id: commentId, body: newBody }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = err.detail && err.detail.error || err.error || res.status;
      showToast(`코멘트 수정 실패: ${detail}`, 'error');
      return;
    }
    showToast('코멘트가 수정되었습니다');
    // Optimistic update — patch whichever store holds this report.
    const reportId = Number(document.getElementById('team-report-viewer-modal')?.dataset.reportId || 0);
    const teamReport = state.team.merged.reports.find((x) => x.id === reportId && x.owner === owner);
    const localReport = teamReport ? null : state.allReports.find((x) => x.id === reportId);
    const target = teamReport || localReport;
    if (target && Array.isArray(target.comments)) {
      target.comments = target.comments.map((c) =>
        Number(c.id) === Number(commentId) ? { ...c, body: newBody } : c
      );
      renderTeamCommentsList(target.comments, owner);
      if (state.scope === 'all-reports') renderAllReportsView();
    }
    (async () => {
      if (teamReport) {
        try { await fetch('/api/team/sync', { method: 'POST' }); } catch {}
        try { await loadTeamMerged(); } catch {}
      } else if (localReport) {
        try { state.allReports = await api('GET', '/api/reports'); } catch {}
        if (state.scope === 'all-reports') renderAllReportsView();
      }
    })();
  } catch (e) {
    showToast(`코멘트 수정 오류: ${e.message}`, 'error');
  }
}

async function removeOwnComment(owner, commentId) {
  try {
    const res = await fetch('/api/team/comment-remove-out', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ owner, comment_id: commentId }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      const detail = err.detail && err.detail.error || err.error || res.status;
      showToast(`코멘트 삭제 실패: ${detail}`, 'error');
      return;
    }
    showToast('코멘트가 삭제되었습니다');
    const reportId = Number(document.getElementById('team-report-viewer-modal')?.dataset.reportId || 0);
    const teamReport = state.team.merged.reports.find((x) => x.id === reportId && x.owner === owner);
    const localReport = teamReport ? null : state.allReports.find((x) => x.id === reportId);
    const target = teamReport || localReport;
    if (target && Array.isArray(target.comments)) {
      target.comments = target.comments.filter((c) => Number(c.id) !== Number(commentId));
      renderTeamCommentsList(target.comments, owner);
      if (state.scope === 'all-reports') renderAllReportsView();
    }
    (async () => {
      if (teamReport) {
        try { await fetch('/api/team/sync', { method: 'POST' }); } catch {}
        try { await loadTeamMerged(); } catch {}
      } else if (localReport) {
        try { state.allReports = await api('GET', '/api/reports'); } catch {}
        if (state.scope === 'all-reports') renderAllReportsView();
      }
    })();
  } catch (e) {
    showToast(`코멘트 삭제 오류: ${e.message}`, 'error');
  }
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
  tokenInput:  document.getElementById('team-manage-token-input'),
  tokenSave:   document.getElementById('team-manage-token-save'),
};

async function refreshTeamManageToken() {
  if (!teamManageEls.tokenInput) return;
  try {
    const res = await fetch('/api/team/token');
    if (!res.ok) return;
    const data = await res.json();
    teamManageEls.tokenInput.value = data.token || '';
  } catch { /* network blip */ }
}

async function openTeamManageModal() {
  await Promise.all([refreshTeamManageList(), refreshTeamManageToken()]);
  teamManageEls.modal.classList.remove('hidden');
}
function closeTeamManageModal() {
  teamManageEls.modal.classList.add('hidden');
}

async function refreshTeamManageList() {
  let peers = [];
  let selfName = '';
  try {
    const res = await fetch('/api/team/peers');
    if (res.ok) {
      const data = await res.json();
      peers = data.peers || [];
      selfName = data.selfName || '';
    }
  } catch { /* network blip */ }
  // Self-row dedup: 같은 host+port 를 가리키는 isSelf 행이 2개 이상이면,
  // self.name 과 일치하는 행만 노출하고 나머지는 숨김. 서버측 receiver 가드가
  // 이미 신규 유입을 막지만, 과거에 누적된 stale 행이 남아 있을 때 UI 에서
  // 본인이 두 명으로 보이는 혼란을 방지.
  const selfRows = peers.filter((p) => p.isSelf);
  if (selfRows.length > 1 && selfName) {
    const canonical = selfRows.find((p) => p.name === selfName) || selfRows[0];
    peers = peers.filter((p) => !p.isSelf || p === canonical);
  }
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
    if (p.isSelf) tr.classList.add('team-self-row');
    const nameCell = p.isSelf
      ? `<span class="display-name">${escapeHtml(p.name)}</span> <span class="team-self-badge">본인</span>`
      : `<span class="display-name">${escapeHtml(p.name)}</span>`;
    const actionsCell = p.isSelf
      ? `<button class="btn" data-action="self-rename">이름 변경</button>
         <span class="muted" style="font-size:11px;">IP·포트는 자동</span>`
      : `<button class="btn" data-action="edit">편집</button>
         <button class="btn btn-danger" data-action="remove">삭제</button>`;
    tr.innerHTML = `
      <td>${nameCell}</td>
      <td><span class="display-host">${escapeHtml(p.host)}</span></td>
      <td><span class="display-port">${p.port}</span></td>
      <td class="actions">${actionsCell}</td>
    `;
    teamManageEls.rows.appendChild(tr);
  }
}

if (teamManageEls.tokenSave) {
  teamManageEls.tokenSave.addEventListener('click', async () => {
    const token = String(teamManageEls.tokenInput.value || '');
    if (!token.trim()) {
      showToast('token 이 비어있습니다.', 'error');
      return;
    }
    try {
      const res = await fetch('/api/team/set-token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        showToast(`token 저장 실패: ${err.detail || err.error || res.status}`, 'error');
        return;
      }
      showToast('팀 token 저장됨 — 다음 cross-peer 요청부터 적용');
    } catch (e) {
      showToast(`오류: ${e.message}`, 'error');
    }
  });
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
    } else if (action === 'self-rename') {
      const original = tr.dataset.name;
      const newName = window.prompt(
        '새 이름을 입력하세요. (이 변경은 team_settings.json 에 저장되고 다른 팀원들에게도 자동 전파됩니다.)',
        original
      );
      if (newName === null) return;
      const trimmed = String(newName).trim();
      if (!trimmed) {
        showToast('이름이 비어 있습니다.', 'error');
        return;
      }
      if (trimmed === original) return;
      try {
        const res = await fetch('/api/team/self-rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: trimmed }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          showToast(`이름 변경 실패: ${err.detail || err.error || res.status}`, 'error');
          return;
        }
        showToast(`'${trimmed}' 으로 변경됨`);
        await refreshTeamManageList();
      } catch (e) {
        showToast(`오류: ${e.message}`, 'error');
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

// 「내 목록 전파」 버튼은 UI 에서 제거됨 — boot announce + onChange broadcast
// 가 자동으로 같은 일을 하므로 수동 트리거가 사실상 redundant 였음.
// /api/team/peer-announce 라우트와 broadcaster.announceCurrentList 함수는
// admin / debugging 용도로 유지.

loadTeamState();

// ───── Archive management (archived peer import + project freeze) ─────

const archiveEls = {
  modal:          document.getElementById('archive-modal'),
  openBtn:        document.getElementById('archive-manage-btn'),
  exportBtn:      document.getElementById('archive-export-btn'),
  peerSelect:     document.getElementById('archive-peer-select'),
  importPeerBtn:  document.getElementById('archive-import-peer-btn'),
  fileInput:      document.getElementById('archive-file-input'),
  importFileBtn:  document.getElementById('archive-import-file-btn'),
  peersList:      document.getElementById('archived-peers-list'),
  freezeBtn:      document.getElementById('freeze-btn'),
  frozenBanner:   document.getElementById('frozen-banner'),
};

state.archivedPeers = [];  // [{owner, imported_at, counts}]
state.frozen = false;

async function loadArchivedPeers() {
  try {
    state.archivedPeers = await api('GET', '/api/archive/peers');
  } catch { state.archivedPeers = []; }
  renderArchivedPeersList();
  populatePeerSelect();
}

function renderArchivedPeersList() {
  if (!archiveEls.peersList) return;
  archiveEls.peersList.innerHTML = '';
  if (state.archivedPeers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'muted';
    empty.style.fontSize = '12px';
    empty.textContent = '아직 보관 중인 팀원 데이터가 없습니다.';
    archiveEls.peersList.appendChild(empty);
    return;
  }
  for (const p of state.archivedPeers) {
    const row = document.createElement('div');
    row.className = 'archived-peer-row';
    const importedAt = (p.imported_at || '').replace(' ', ' ');
    row.innerHTML = `
      <span class="name">${escapeHtml(p.owner)}</span>
      <span class="badge">카테고리 ${p.counts.categories}</span>
      <span class="badge">스케줄 ${p.counts.schedules}</span>
      <span class="badge">리포트 ${p.counts.reports}</span>
      <span class="badge">${escapeHtml(importedAt)}</span>
      <span class="spacer"></span>
      <button type="button" class="btn btn-danger" data-action="delete-archived" data-owner="${escapeHtml(p.owner)}">삭제</button>
    `;
    archiveEls.peersList.appendChild(row);
  }
}

function populatePeerSelect() {
  if (!archiveEls.peerSelect) return;
  const peers = (state.team.peers || []).filter((p) => p.status === 'ok');
  archiveEls.peerSelect.innerHTML = '';
  if (peers.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '(연결된 팀원 없음 — 팀모드 ON + 온라인 필요)';
    archiveEls.peerSelect.appendChild(opt);
    archiveEls.peerSelect.disabled = true;
    return;
  }
  archiveEls.peerSelect.disabled = false;
  for (const p of peers) {
    const opt = document.createElement('option');
    opt.value = p.name;
    opt.textContent = p.name;
    archiveEls.peerSelect.appendChild(opt);
  }
}

function openArchiveModal() {
  if (!archiveEls.modal) return;
  loadArchivedPeers();
  archiveEls.modal.classList.remove('hidden');
}

function closeArchiveModal() {
  if (archiveEls.modal) archiveEls.modal.classList.add('hidden');
}

if (archiveEls.openBtn) {
  archiveEls.openBtn.addEventListener('click', openArchiveModal);
}

if (archiveEls.modal) {
  archiveEls.modal.addEventListener('click', (e) => {
    if (e.target === archiveEls.modal) closeArchiveModal();
    if (e.target.matches('[data-close]')) closeArchiveModal();
    const delBtn = e.target.closest('[data-action="delete-archived"]');
    if (delBtn) {
      const owner = delBtn.dataset.owner;
      if (!confirm(`「${owner}」의 보관 데이터를 완전히 삭제할까요? 첨부 파일도 함께 삭제됩니다.`)) return;
      api('DELETE', `/api/archive/peers/${encodeURIComponent(owner)}`)
        .then(() => loadArchivedPeers())
        .then(() => loadTeamMerged && loadTeamMerged())
        .catch((err) => showToast('삭제 실패: ' + err.message, 'error'));
    }
  });
}

if (archiveEls.exportBtn) {
  archiveEls.exportBtn.addEventListener('click', () => {
    // 직접 navigation 으로 ZIP 다운로드 (api() 는 JSON 만 처리)
    window.location.href = '/api/archive/export';
  });
}

if (archiveEls.importPeerBtn) {
  archiveEls.importPeerBtn.addEventListener('click', async () => {
    const name = archiveEls.peerSelect && archiveEls.peerSelect.value;
    if (!name) {
      alert('가져올 팀원을 선택해주세요.');
      return;
    }
    if (!confirm(`「${name}」의 전체 데이터를 가져와서 보관할까요?\n\n팀 목록에서 자동 제거되고 스프린트 그룹 복제본도 정리됩니다.`)) return;
    archiveEls.importPeerBtn.disabled = true;
    try {
      const result = await api('POST', '/api/archive/import-from-peer', { name });
      showToast(`${result.owner} 데이터 보관 완료 (스케줄 ${result.table_counts.schedules}개)`, 'success');
      await loadArchivedPeers();
      await loadTeamMerged();
      await loadTeamState();
    } catch (e) {
      showToast('가져오기 실패: ' + e.message, 'error');
    } finally {
      archiveEls.importPeerBtn.disabled = false;
    }
  });
}

if (archiveEls.importFileBtn) {
  archiveEls.importFileBtn.addEventListener('click', async () => {
    const f = archiveEls.fileInput && archiveEls.fileInput.files && archiveEls.fileInput.files[0];
    if (!f) {
      alert('ZIP 파일을 선택해주세요.');
      return;
    }
    archiveEls.importFileBtn.disabled = true;
    try {
      const form = new FormData();
      form.append('archive', f);
      const res = await fetch('/api/archive/import-from-file', { method: 'POST', body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || ('HTTP ' + res.status));
      showToast(`${data.owner} 데이터 보관 완료 (스케줄 ${data.table_counts.schedules}개)`, 'success');
      archiveEls.fileInput.value = '';
      await loadArchivedPeers();
      await loadTeamMerged();
      await loadTeamState();
    } catch (e) {
      showToast('파일 가져오기 실패: ' + e.message, 'error');
    } finally {
      archiveEls.importFileBtn.disabled = false;
    }
  });
}

// ───── Project freeze ─────

async function loadFreezeStatus() {
  try {
    const r = await fetch('/api/admin/freeze-status');
    const d = await r.json();
    state.frozen = !!d.frozen;
    state.frozenAt = d.frozenAt;
  } catch { state.frozen = false; }
  applyFrozenUI();
}

function applyFrozenUI() {
  document.body.classList.toggle('project-frozen', state.frozen);
  if (archiveEls.freezeBtn) archiveEls.freezeBtn.classList.toggle('hidden', state.frozen);
  if (archiveEls.frozenBanner) {
    archiveEls.frozenBanner.classList.toggle('hidden', !state.frozen);
    if (state.frozen && state.frozenAt) {
      const d = new Date(state.frozenAt);
      archiveEls.frozenBanner.title = `프로젝트 동결: ${d.toLocaleString('ko-KR')}`;
    }
  }
}

if (archiveEls.freezeBtn) {
  archiveEls.freezeBtn.addEventListener('click', async () => {
    if (!confirm('프로젝트를 동결하면 모든 편집 (추가/수정/삭제) 이 차단됩니다.\n\n해제하려면 data/team_settings.json 의 frozen 을 false 로 직접 수정해야 합니다.\n\n진행할까요?')) return;
    try {
      const r = await fetch('/api/admin/freeze', { method: 'POST', headers: { 'Content-Type': 'application/json' } });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || ('HTTP ' + r.status));
      state.frozen = true;
      state.frozenAt = d.frozenAt;
      applyFrozenUI();
      showToast('프로젝트가 동결되었습니다.', 'success', 5000);
    } catch (e) {
      showToast('동결 실패: ' + e.message, 'error');
    }
  });
}

loadFreezeStatus();
loadArchivedPeers();

// ───── Task request (업무 요청) ─────

const TASK_REQUEST_DEFAULT_BODY = '업무를 최대한 명확하게 작성 바랍니다';

const taskEls = {
  launcher:        document.getElementById('task-request-launcher'),
  choiceModal:     document.getElementById('task-choice-modal'),
  composeChoice:   document.getElementById('task-choice-compose'),
  outboundChoice:  document.getElementById('task-choice-outbound'),
  inboundChoice:   document.getElementById('task-choice-inbound'),
  requestModal:    document.getElementById('task-request-modal'),
  outboundModal:   document.getElementById('task-outbound-modal'),
  outboundList:    document.getElementById('task-outbound-list'),
  outboundCount:   document.getElementById('task-outbound-count'),
  outboundRefresh: document.getElementById('task-outbound-refresh'),
  outboundSelectAll:    document.getElementById('task-outbound-select-all'),
  outboundDelSelected:  document.getElementById('task-outbound-delete-selected'),
  recipientsBox:   document.getElementById('task-request-recipients'),
  recipientCount:  document.getElementById('task-request-recipient-count'),
  selectAll:       document.getElementById('task-request-select-all'),
  body:            document.getElementById('task-request-body'),
  deadlineDate:    document.getElementById('task-request-deadline-date'),
  deadlineHour:    document.getElementById('task-request-deadline-hour'),
  deadlineMinute:  document.getElementById('task-request-deadline-minute'),
  deadlineClear:   document.getElementById('task-request-deadline-clear'),
  files:           document.getElementById('task-request-files'),
  fileList:        document.getElementById('task-request-file-list'),
  submitBtn:       document.getElementById('task-request-submit'),
};

// Populate hour (00..23) and minute (5-min steps) selects once.
(function fillDeadlineSelects() {
  const pad = (n) => String(n).padStart(2, '0');
  if (taskEls.deadlineHour && taskEls.deadlineHour.options.length === 0) {
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement('option');
      opt.value = pad(h); opt.textContent = pad(h);
      taskEls.deadlineHour.appendChild(opt);
    }
  }
  if (taskEls.deadlineMinute && taskEls.deadlineMinute.options.length === 0) {
    for (let m = 0; m < 60; m += 5) {
      const opt = document.createElement('option');
      opt.value = pad(m); opt.textContent = pad(m);
      taskEls.deadlineMinute.appendChild(opt);
    }
  }
})();

let taskPendingFiles = [];
// When set, the next submit is a 다시 요청 — backend should copy the prior
// thread's comments into the newly-created outbound rows (and forward the
// same to the recipient so their inbound row mirrors it).
let taskReissueFromGroupId = null;

function openTaskChoiceModal() {
  if (!taskEls.choiceModal) return;
  // 「요청할 업무」 는 팀 전체계획 ON 일 때만 활성. cross-peer 전송이
  // 필요하기 때문. 「요청한/받은 업무」 는 로컬 DB 조회라 OFF 에서도
  // 그대로 열람 가능.
  const teamOn = state.team && state.team.mode === 'ON';
  if (taskEls.composeChoice) {
    taskEls.composeChoice.disabled = !teamOn;
    taskEls.composeChoice.title = teamOn
      ? '새 업무를 요청 작성'
      : '팀 전체계획을 ON 으로 켜야 사용할 수 있습니다';
  }
  taskEls.choiceModal.classList.remove('hidden');
}
function closeTaskChoiceModal() {
  if (taskEls.choiceModal) taskEls.choiceModal.classList.add('hidden');
}

function openTaskRequestModal() {
  if (!taskEls.requestModal) return;
  populateTaskRecipients();
  taskEls.body.value = TASK_REQUEST_DEFAULT_BODY;
  taskEls.deadlineDate.value = '';
  if (taskEls.deadlineHour) taskEls.deadlineHour.value = '09';
  if (taskEls.deadlineMinute) taskEls.deadlineMinute.value = '00';
  taskPendingFiles = [];
  renderTaskFileList();
  // Fresh open — hide the history pane and shrink the modal back.
  setTaskRequestHistoryMode(null);
  taskReissueFromGroupId = null;
  taskEls.requestModal.classList.remove('hidden');
}

// Toggle the optional "이전 응답 / 코멘트" right pane. groupOrNull = the
// group object when re-issuing (shows pane); null for fresh compose (hide).
function setTaskRequestHistoryMode(group) {
  const card = taskEls.requestModal && taskEls.requestModal.querySelector('.task-request-card');
  const grid = taskEls.requestModal && taskEls.requestModal.querySelector('.task-request-grid');
  const right = document.getElementById('task-request-history');
  const titleEl = document.getElementById('task-request-title');
  if (!card || !grid || !right) return;
  if (!group) {
    right.classList.add('hidden');
    grid.classList.remove('with-history');
    card.classList.remove('with-history');
    if (titleEl) titleEl.textContent = '업무 요청 작성';
    return;
  }
  // Re-issue mode — collect the comments from this group's outbound rows.
  // Each outbound row in this group has its own comments[]; combine all
  // (sorted by created_at). We'll fetch them via /api/tasks/:id since the
  // group cached object does not currently include per-row comments.
  right.classList.remove('hidden');
  grid.classList.add('with-history');
  card.classList.add('with-history');
  if (titleEl) titleEl.textContent = '업무 다시 요청';
  loadAndRenderReissueHistory(group);
}

async function loadAndRenderReissueHistory(group) {
  const list = document.getElementById('task-request-history-list');
  if (!list) return;
  list.innerHTML = '<li class="empty">불러오는 중...</li>';
  // Fetch comments for each row in the group. Rows may have come from
  // disparate recipients; we tag each comment with the recipient name so
  // the user can tell who wrote what.
  const all = [];
  await Promise.all((group.rowIds || []).map(async (rid) => {
    try {
      const r = await fetch(`/api/tasks/${rid}`);
      if (!r.ok) return;
      const data = await r.json();
      const recipient = data.recipient || '?';
      for (const c of (data.comments || [])) {
        all.push({ ...c, recipient });
      }
    } catch { /* ignore single-row errors */ }
  }));
  all.sort((a, b) => {
    const ka = a.created_at || ''; const kb = b.created_at || '';
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  // Reuse the comments list rendering (read-only), but tweak so the body
  // also shows which recipient this came from.
  list.innerHTML = '';
  if (all.length === 0) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = '코멘트 없음';
    list.appendChild(li);
    return;
  }
  for (const c of all) {
    const li = document.createElement('li');
    const head = document.createElement('div');
    head.className = 'team-comment-head';
    const author = document.createElement('span');
    author.className = 'team-comment-author';
    author.textContent = `${c.recipient} → ${c.author}`;
    const ts = document.createElement('span');
    ts.textContent = formatCommentTimestamp(c.created_at);
    head.appendChild(author);
    head.appendChild(ts);
    const body = document.createElement('div');
    body.className = 'team-comment-body';
    body.textContent = c.body || '';
    li.appendChild(head);
    li.appendChild(body);
    // Recipient-proposed deadline — render with a 「수락」 button that
    // pushes the value into the left compose form's deadline fields.
    if (c.proposed_deadline) {
      const row = document.createElement('div');
      row.className = 'task-history-proposed';
      row.innerHTML =
        '<span class="task-history-proposed-label">제안 기한</span>' +
        `<span class="task-history-proposed-value">${escapeHtml(c.proposed_deadline)}</span>` +
        '<button type="button" class="btn task-history-proposed-apply">수락</button>';
      row.querySelector('button').addEventListener('click', () => {
        applyProposedDeadlineToCompose(c.proposed_deadline);
      });
      li.appendChild(row);
    }
    list.appendChild(li);
  }
}

// Copy a "YYYY-MM-DD HH:MM" string into the compose form's deadline date /
// hour / minute selects. Minutes are snapped to the 5-min grid the picker
// uses.
function applyProposedDeadlineToCompose(s) {
  const m = String(s || '').match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
  if (!m) {
    showToast('기한 형식이 올바르지 않습니다', 'error');
    return;
  }
  taskEls.deadlineDate.value = m[1];
  if (taskEls.deadlineHour) taskEls.deadlineHour.value = String(m[2] || '09').padStart(2, '0');
  if (taskEls.deadlineMinute && m[3] != null) {
    const mm = Math.round(Number(m[3]) / 5) * 5;
    const clamped = Math.min(55, Math.max(0, mm));
    taskEls.deadlineMinute.value = String(clamped).padStart(2, '0');
  }
  showToast(`기한을 ${m[1]} ${(m[2]||'09').padStart(2,'0')}:${(m[3]||'00').padStart(2,'0')} 으로 적용했습니다`, 'info', 2500);
}
function closeTaskRequestModal() {
  if (taskEls.requestModal) taskEls.requestModal.classList.add('hidden');
  setTaskRequestHistoryMode(null);
}

async function populateTaskRecipients() {
  taskEls.recipientsBox.innerHTML = '<div class="empty">불러오는 중...</div>';
  let peers = [];
  try {
    const res = await fetch('/api/team/peers');
    if (res.ok) {
      const data = await res.json();
      peers = (data.peers || []).filter((p) => !p.isSelf);
    }
  } catch { /* network blip */ }
  taskEls.recipientsBox.innerHTML = '';
  if (peers.length === 0) {
    taskEls.recipientsBox.innerHTML = '<div class="empty">등록된 팀원이 없습니다 (팀원 관리에서 추가 필요)</div>';
    taskEls.recipientCount.textContent = '';
    if (taskEls.selectAll) taskEls.selectAll.checked = false;
    updateTaskSubmitDisabled();
    return;
  }
  for (const p of peers) {
    const id = `task-recip-${p.name}`;
    const wrap = document.createElement('label');
    wrap.htmlFor = id;
    wrap.innerHTML = `<input type="checkbox" id="${id}" data-recipient="${escapeHtml(p.name)}" /> <span>${escapeHtml(p.name)}</span>`;
    taskEls.recipientsBox.appendChild(wrap);
  }
  taskEls.recipientsBox.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    cb.addEventListener('change', () => {
      updateTaskRecipientCount();
      updateTaskSelectAllState();
      updateTaskSubmitDisabled();
    });
  });
  if (taskEls.selectAll) taskEls.selectAll.checked = false;
  updateTaskRecipientCount();
  updateTaskSubmitDisabled();
}

function selectedRecipientNames() {
  return Array.from(
    taskEls.recipientsBox.querySelectorAll('input[type=checkbox]:checked')
  ).map((cb) => cb.dataset.recipient);
}

function updateTaskRecipientCount() {
  const total = taskEls.recipientsBox.querySelectorAll('input[type=checkbox]').length;
  const sel = selectedRecipientNames().length;
  taskEls.recipientCount.textContent = total > 0 ? `(${sel} / ${total})` : '';
}

function updateTaskSelectAllState() {
  if (!taskEls.selectAll) return;
  const all = taskEls.recipientsBox.querySelectorAll('input[type=checkbox]');
  if (all.length === 0) { taskEls.selectAll.checked = false; return; }
  const sel = selectedRecipientNames().length;
  taskEls.selectAll.checked = sel === all.length;
  taskEls.selectAll.indeterminate = sel > 0 && sel < all.length;
}

function updateTaskSubmitDisabled() {
  if (!taskEls.submitBtn) return;
  const sel = selectedRecipientNames().length;
  const body = (taskEls.body.value || '').trim();
  taskEls.submitBtn.disabled = sel === 0 || !body;
}

function renderTaskFileList() {
  if (!taskEls.fileList) return;
  taskEls.fileList.innerHTML = '';
  taskPendingFiles.forEach((entry, idx) => {
    const li = document.createElement('li');
    const sizeKb = (entry.file.size / 1024).toFixed(0);
    li.innerHTML = `${escapeHtml(entry.displayName)} <span class="muted">(${sizeKb} KB)</span> <button type="button" class="remove-file" data-idx="${idx}" title="제거">×</button>`;
    taskEls.fileList.appendChild(li);
  });
}

if (taskEls.launcher) {
  taskEls.launcher.addEventListener('click', openTaskChoiceModal);
}
if (taskEls.choiceModal) {
  taskEls.choiceModal.addEventListener('click', (e) => {
    if (e.target === taskEls.choiceModal || e.target.matches('[data-close]')) {
      closeTaskChoiceModal();
    }
  });
}
if (taskEls.composeChoice) {
  taskEls.composeChoice.addEventListener('click', () => {
    closeTaskChoiceModal();
    openTaskRequestModal();
  });
}
if (taskEls.outboundChoice) {
  taskEls.outboundChoice.addEventListener('click', async () => {
    closeTaskChoiceModal();
    await openTaskOutboundModal();
  });
}
if (taskEls.inboundChoice) {
  taskEls.inboundChoice.addEventListener('click', async () => {
    closeTaskChoiceModal();
    await openTaskInboundModal();
  });
}
if (taskEls.outboundModal) {
  taskEls.outboundModal.addEventListener('click', (e) => {
    if (e.target === taskEls.outboundModal || e.target.matches('[data-close]')) {
      taskEls.outboundModal.classList.add('hidden');
    }
  });
}
if (taskEls.outboundRefresh) {
  taskEls.outboundRefresh.addEventListener('click', syncAndRenderOutbound);
}

async function openTaskOutboundModal() {
  if (!taskEls.outboundModal) return;
  taskEls.outboundModal.classList.remove('hidden');
  await syncAndRenderOutbound();
}

// Pull-style reconcile + render. Runs sync-outbound (best-effort across all
// peers; offline peers don't break it) so that responses pushed earlier
// while we were unreachable still show up. Sync errors are logged but
// don't block rendering — we still show whatever's in our local DB.
async function syncAndRenderOutbound() {
  try {
    await fetch('/api/tasks/sync-outbound', { method: 'POST' });
  } catch (e) {
    // network failure of the sync itself — fine, fall through
  }
  await loadAndRenderOutbound();
}

// Group raw outbound rows by group_id (1 logical request = N rows, one per
// recipient). Each group becomes a card that lists all recipients and the
// shared body / deadline / attachments.
// Cached groups from the last render — lookup table for re-issue clicks.
let lastOutboundGroups = [];

async function loadAndRenderOutbound() {
  if (!taskEls.outboundList) return;
  taskEls.outboundList.innerHTML = '<div class="empty">불러오는 중...</div>';
  let rows = [];
  try {
    const res = await fetch('/api/tasks/outbound');
    if (res.ok) rows = await res.json();
  } catch (e) {
    taskEls.outboundList.innerHTML = `<div class="empty">불러오기 실패: ${escapeHtml(e.message)}</div>`;
    lastOutboundGroups = [];
    resetTaskOutboundSelection();
    return;
  }
  // Group by group_id (fallback: row id) — one request to N recipients
  // creates N rows sharing a group_id. Each recipient may have their own
  // status + comments, so we track them per-recipient inside the group.
  const groups = new Map();
  for (const r of rows) {
    const key = r.group_id || `solo-${r.id}`;
    if (!groups.has(key)) {
      groups.set(key, {
        groupId: key,
        body: r.body,
        deadline: r.deadline,
        created_at: r.created_at,
        recipients: [],
        attachments: r.attachments || [],
        rowIds: [],
        recipientStatus: {},   // recipient → status
        recipientComments: {}, // recipient → array of comments
      });
    }
    const g = groups.get(key);
    g.recipients.push(r.recipient);
    g.rowIds.push(r.id);
    g.recipientStatus[r.recipient] = r.status || 'pending';
    g.recipientComments[r.recipient] = r.comments || [];
  }
  const ordered = Array.from(groups.values()).sort((a, b) =>
    a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0
  );
  if (taskEls.outboundCount) {
    taskEls.outboundCount.textContent = ordered.length > 0 ? `(${ordered.length}건)` : '';
  }
  lastOutboundGroups = ordered;
  if (ordered.length === 0) {
    taskEls.outboundList.innerHTML = '<div class="empty">아직 보낸 업무 요청이 없습니다</div>';
    resetTaskOutboundSelection();
    return;
  }
  taskEls.outboundList.innerHTML = '';
  for (const g of ordered) {
    const item = document.createElement('div');
    // Aggregate group status for the right-edge color: rejected > adjusted >
    // accepted > pending (worst case wins so requester sees red if any
    // recipient pushed back).
    const statuses = new Set(Object.values(g.recipientStatus));
    let aggregate = 'pending';
    if (statuses.has('rejected')) aggregate = 'rejected';
    else if (statuses.has('adjusted')) aggregate = 'adjusted';
    else if (statuses.has('accepted') && statuses.size === 1) aggregate = 'accepted';
    else if (statuses.has('accepted')) aggregate = 'pending'; // partial accept
    item.className = `task-outbound-item status-${aggregate}`;
    const recipientsHtml = g.recipients
      .map((r) => {
        const s = g.recipientStatus[r] || 'pending';
        const label = { pending: '', accepted: '✓', adjusted: '↺', rejected: '✕' }[s] || '';
        const cls = `task-outbound-recipient-pill task-recipient-${s}`;
        return `<span class="${cls}" title="상태: ${s}">${escapeHtml(r)}${label ? ' ' + label : ''}</span>`;
      })
      .join('');
    const attachmentsHtml = (g.attachments || [])
      .map((a) => {
        if (a.kind === 'upload') {
          return `<a class="att-chip" href="/uploads/${encodeURIComponent(a.path)}" target="_blank" rel="noopener" title="${escapeHtml(a.display_name)}">📎 ${escapeHtml(a.display_name)}</a>`;
        }
        return `<span class="att-chip" title="${escapeHtml(a.path)}">📁 ${escapeHtml(a.display_name)}</span>`;
      }).join('');
    const dlHtml = g.deadline
      ? `<span class="task-outbound-item-deadline">기한 ${escapeHtml(g.deadline)}</span>`
      : '';
    // 거부/조정이 하나라도 있으면 「다시 요청」 버튼 노출.
    const canReissue = aggregate === 'rejected' || aggregate === 'adjusted';
    const reissueHtml = canReissue
      ? `<button type="button" class="btn task-reissue-btn" data-group-id="${escapeHtml(g.groupId)}" title="거부/조정된 수신자에게 다시 요청">다시 요청</button>`
      : '';
    // 어느 수신자라도 코멘트(수락 코멘트 포함)를 남겼다면 「응답 보기」
    // 버튼 노출. 모달에서 수신자별로 묶여 보임.
    const totalComments = Object.values(g.recipientComments || {})
      .reduce((sum, arr) => sum + (arr ? arr.length : 0), 0);
    const detailHtml = totalComments > 0
      ? `<button type="button" class="btn task-detail-btn" data-group-id="${escapeHtml(g.groupId)}" title="수신자가 남긴 응답 코멘트 보기">응답 보기 ${totalComments}</button>`
      : '';
    item.innerHTML = `
      <div class="task-outbound-item-head">
        <label class="task-row-select" title="선택 (전체 그룹의 모든 row 삭제)">
          <input type="checkbox" class="task-outbound-row-check" data-row-ids="${g.rowIds.join(',')}" />
        </label>
        <span class="task-outbound-item-time">${escapeHtml(formatCommentTimestamp(g.created_at))} 작성</span>
        <div class="task-outbound-item-head-right">
          ${dlHtml}
          ${detailHtml}
          ${reissueHtml}
        </div>
      </div>
      <div class="task-outbound-item-recipients">${recipientsHtml}</div>
      <div class="task-outbound-item-body">${escapeHtml(g.body || '')}</div>
      ${attachmentsHtml ? `<div class="task-outbound-item-attachments">${attachmentsHtml}</div>` : ''}
    `;
    taskEls.outboundList.appendChild(item);
  }
  resetTaskOutboundSelection();
}

function resetTaskOutboundSelection() {
  if (taskEls.outboundSelectAll) {
    taskEls.outboundSelectAll.checked = false;
    taskEls.outboundSelectAll.indeterminate = false;
  }
  refreshTaskOutboundDeleteButtons();
}

// Event delegation — 「다시 요청」 / 「응답 보기」 buttons on cards.
if (taskEls.outboundList) {
  taskEls.outboundList.addEventListener('click', (e) => {
    const reissueBtn = e.target.closest('.task-reissue-btn');
    if (reissueBtn) {
      const g = lastOutboundGroups.find((x) => x.groupId === reissueBtn.dataset.groupId);
      if (!g) { showToast('그룹 정보를 찾을 수 없음', 'error'); return; }
      openTaskRequestForReissue(g);
      return;
    }
    const detailBtn = e.target.closest('.task-detail-btn');
    if (detailBtn) {
      const g = lastOutboundGroups.find((x) => x.groupId === detailBtn.dataset.groupId);
      if (!g) { showToast('그룹 정보를 찾을 수 없음', 'error'); return; }
      openTaskOutboundDetail(g);
      return;
    }
  });
  // Per-card checkbox change → sync 「전체 선택」 indeterminate / checked
  // and refresh button enabled state.
  taskEls.outboundList.addEventListener('change', (e) => {
    if (!e.target.classList.contains('task-outbound-row-check')) return;
    const all = document.querySelectorAll('#task-outbound-list .task-outbound-row-check');
    const checked = document.querySelectorAll('#task-outbound-list .task-outbound-row-check:checked');
    if (taskEls.outboundSelectAll) {
      taskEls.outboundSelectAll.checked = all.length > 0 && checked.length === all.length;
      taskEls.outboundSelectAll.indeterminate = checked.length > 0 && checked.length < all.length;
    }
    refreshTaskOutboundDeleteButtons();
  });
}
if (taskEls.outboundSelectAll) {
  taskEls.outboundSelectAll.addEventListener('change', () => {
    document.querySelectorAll('#task-outbound-list .task-outbound-row-check').forEach((cb) => {
      cb.checked = taskEls.outboundSelectAll.checked;
    });
    taskEls.outboundSelectAll.indeterminate = false;
    refreshTaskOutboundDeleteButtons();
  });
}
if (taskEls.outboundDelSelected) {
  taskEls.outboundDelSelected.addEventListener('click', async () => {
    const ids = getSelectedOutboundIds();
    if (ids.length === 0) return;
    if (!confirm(`선택한 그룹의 row ${ids.length}개를 삭제합니다.\n(내 PC 데이터만 삭제 — 수신자 PC 의 inbound row 는 그대로 남음)\n\n계속할까요?`)) return;
    const ok = await deleteTaskRowIds(ids);
    if (ok) await loadAndRenderOutbound();
  });
}

// Outbound detail modal — view-only display of a sent request grouped by
// recipient: each recipient shows status + their comments (수락 with comment,
// 조정 사유, 거부 사유 모두 포함).
const taskOutboundDetailEls = {
  modal:        document.getElementById('task-outbound-detail-modal'),
  created:      document.getElementById('task-outbound-detail-created'),
  deadline:     document.getElementById('task-outbound-detail-deadline'),
  body:         document.getElementById('task-outbound-detail-body'),
  attachments:  document.getElementById('task-outbound-detail-attachments'),
  recipients:   document.getElementById('task-outbound-detail-recipients'),
  reissueBtn:   document.getElementById('task-outbound-detail-reissue'),
};

function openTaskOutboundDetail(group) {
  const m = taskOutboundDetailEls.modal;
  if (!m) return;
  taskOutboundDetailEls.created.textContent = formatCommentTimestamp(group.created_at);
  taskOutboundDetailEls.deadline.textContent = group.deadline || '(없음)';
  taskOutboundDetailEls.body.textContent = group.body || '';

  // Attachments — same self-server links as the outbound list (sender side).
  taskOutboundDetailEls.attachments.innerHTML = '';
  for (const a of (group.attachments || [])) {
    if (a.kind === 'upload') {
      const link = document.createElement('a');
      link.className = 'att-chip';
      link.href = `/uploads/${encodeURIComponent(a.path)}`;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = a.display_name;
      link.textContent = `📎 ${a.display_name}`;
      taskOutboundDetailEls.attachments.appendChild(link);
    } else {
      const span = document.createElement('span');
      span.className = 'att-chip';
      span.textContent = `📁 ${a.display_name}`;
      span.title = a.path;
      taskOutboundDetailEls.attachments.appendChild(span);
    }
  }

  // Per-recipient block: status badge + comments.
  taskOutboundDetailEls.recipients.innerHTML = '';
  for (const name of group.recipients) {
    const status = (group.recipientStatus || {})[name] || 'pending';
    const comments = (group.recipientComments || {})[name] || [];
    const block = document.createElement('div');
    block.className = 'task-outbound-detail-recipient-block';
    const head = document.createElement('div');
    head.className = 'task-outbound-detail-recipient-head';
    head.innerHTML = `
      <span>${escapeHtml(name)}</span>
      <span class="task-status-badge" data-status="${status}">${TASK_STATUS_LABEL[status] || status}</span>
    `;
    block.appendChild(head);

    const list = document.createElement('ul');
    list.className = 'task-outbound-detail-recipient-comments';
    if (comments.length === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = '코멘트 없음';
      list.appendChild(li);
    } else {
      for (const c of comments) {
        const li = document.createElement('li');
        const head2 = document.createElement('div');
        head2.className = 'team-comment-head';
        const author = document.createElement('span');
        author.className = 'team-comment-author';
        author.textContent = c.author || '?';
        const ts = document.createElement('span');
        ts.textContent = formatCommentTimestamp(c.created_at);
        head2.appendChild(author);
        head2.appendChild(ts);
        const body = document.createElement('div');
        body.className = 'team-comment-body';
        body.textContent = c.body || '';
        li.appendChild(head2);
        li.appendChild(body);
        // Read-only proposed-deadline display (no 수락 button — only the
        // 다시 요청 modal exposes that, since only there can a deadline
        // be applied to the new request).
        if (c.proposed_deadline) {
          const dl = document.createElement('div');
          dl.className = 'task-history-proposed';
          dl.innerHTML =
            '<span class="task-history-proposed-label">제안 기한</span>' +
            `<span class="task-history-proposed-value">${escapeHtml(c.proposed_deadline)}</span>`;
          li.appendChild(dl);
        }
        list.appendChild(li);
      }
    }
    block.appendChild(list);
    taskOutboundDetailEls.recipients.appendChild(block);
  }

  // 「다시 요청」 inside the detail modal — show only when this group has
  // at least one rejected/adjusted recipient (same rule as the list card).
  const statuses = new Set(Object.values(group.recipientStatus || {}));
  const canReissue = statuses.has('rejected') || statuses.has('adjusted');
  if (taskOutboundDetailEls.reissueBtn) {
    taskOutboundDetailEls.reissueBtn.classList.toggle('hidden', !canReissue);
    taskOutboundDetailEls.reissueBtn.onclick = canReissue
      ? () => { m.classList.add('hidden'); openTaskRequestForReissue(group); }
      : null;
  }

  m.classList.remove('hidden');
}

if (taskOutboundDetailEls.modal) {
  taskOutboundDetailEls.modal.addEventListener('click', (e) => {
    if (e.target === taskOutboundDetailEls.modal || e.target.matches('[data-close]')) {
      taskOutboundDetailEls.modal.classList.add('hidden');
    }
  });
}

// Re-issue a previously-sent request whose recipients rejected or asked for
// adjustment. Closes the outbound list, opens the compose modal pre-filled
// with the original body / deadline, and pre-checks ONLY the recipients
// whose status was rejected/adjusted/pending (accepted ones are excluded —
// no need to bother them again). Files aren't auto-re-attached; user can
// re-add what's relevant.
async function openTaskRequestForReissue(group) {
  if (!taskEls.requestModal) return;
  // 팀 ON 가드는 기존 openTaskChoiceModal 패턴을 재사용 — OFF 면 차단.
  if (!(state.team && state.team.mode === 'ON')) {
    showToast('팀 전체계획을 ON 으로 켜야 사용할 수 있습니다', 'error');
    return;
  }
  // Hide the outbound modal so the compose modal isn't visually buried.
  if (taskEls.outboundModal) taskEls.outboundModal.classList.add('hidden');

  await populateTaskRecipients();

  const wanted = new Set(
    (group.recipients || []).filter((r) => {
      const s = (group.recipientStatus || {})[r];
      return s === 'rejected' || s === 'adjusted' || s === 'pending';
    })
  );
  taskEls.recipientsBox.querySelectorAll('input[type=checkbox]').forEach((cb) => {
    if (wanted.has(cb.dataset.recipient)) cb.checked = true;
  });
  updateTaskRecipientCount();
  updateTaskSelectAllState();

  taskEls.body.value = group.body || TASK_REQUEST_DEFAULT_BODY;

  taskEls.deadlineDate.value = '';
  if (taskEls.deadlineHour) taskEls.deadlineHour.value = '09';
  if (taskEls.deadlineMinute) taskEls.deadlineMinute.value = '00';
  if (group.deadline) {
    const m = String(group.deadline).match(/^(\d{4}-\d{2}-\d{2})(?:\s+(\d{1,2}):(\d{2}))?/);
    if (m) {
      taskEls.deadlineDate.value = m[1];
      if (m[2] && taskEls.deadlineHour) taskEls.deadlineHour.value = String(m[2]).padStart(2, '0');
      if (m[3] && taskEls.deadlineMinute) {
        const mm = Math.round(Number(m[3]) / 5) * 5;
        const clamped = Math.min(55, Math.max(0, mm));
        taskEls.deadlineMinute.value = String(clamped).padStart(2, '0');
      }
    }
  }

  taskPendingFiles = [];
  renderTaskFileList();
  // Show the history pane and load comments from each row in the group.
  setTaskRequestHistoryMode(group);
  taskReissueFromGroupId = group.groupId;
  taskEls.requestModal.classList.remove('hidden');
  updateTaskSubmitDisabled();
  showToast('이전 요청 내용을 불러왔습니다. 수정 후 「요청」을 누르세요.', 'info', 3500);
}
if (taskEls.requestModal) {
  taskEls.requestModal.addEventListener('click', (e) => {
    if (e.target === taskEls.requestModal || e.target.matches('[data-close]')) {
      closeTaskRequestModal();
    }
  });
}
if (taskEls.selectAll) {
  taskEls.selectAll.addEventListener('change', () => {
    const checked = taskEls.selectAll.checked;
    taskEls.recipientsBox.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.checked = checked;
    });
    updateTaskRecipientCount();
    updateTaskSubmitDisabled();
  });
}
if (taskEls.body) {
  taskEls.body.addEventListener('input', updateTaskSubmitDisabled);
}
if (taskEls.deadlineClear) {
  taskEls.deadlineClear.addEventListener('click', () => {
    taskEls.deadlineDate.value = '';
    if (taskEls.deadlineHour) taskEls.deadlineHour.value = '09';
    if (taskEls.deadlineMinute) taskEls.deadlineMinute.value = '00';
  });
}
if (taskEls.files) {
  taskEls.files.addEventListener('change', (e) => {
    for (const file of e.target.files) {
      taskPendingFiles.push({ file, displayName: file.name });
    }
    e.target.value = '';
    renderTaskFileList();
  });
}
if (taskEls.fileList) {
  taskEls.fileList.addEventListener('click', (e) => {
    const btn = e.target.closest('.remove-file');
    if (!btn) return;
    const idx = Number(btn.dataset.idx);
    if (Number.isInteger(idx) && idx >= 0) {
      taskPendingFiles.splice(idx, 1);
      renderTaskFileList();
    }
  });
}
if (taskEls.submitBtn) {
  taskEls.submitBtn.addEventListener('click', submitTaskRequest);
}

async function submitTaskRequest() {
  const recipients = selectedRecipientNames();
  if (recipients.length === 0) { showToast('수신자를 한 명 이상 선택하세요', 'error'); return; }
  const body = (taskEls.body.value || '').trim();
  if (!body) { showToast('본문을 입력하세요', 'error'); return; }
  const d = (taskEls.deadlineDate.value || '').trim();
  if (!d) { showToast('기한 지정 필요', 'error'); return; }
  const hh = (taskEls.deadlineHour && taskEls.deadlineHour.value) || '00';
  const mm = (taskEls.deadlineMinute && taskEls.deadlineMinute.value) || '00';
  const deadline = `${d} ${hh}:${mm}`;

  const fd = new FormData();
  fd.append('recipients', JSON.stringify(recipients));
  fd.append('body', body);
  if (deadline) fd.append('deadline', deadline);
  if (taskReissueFromGroupId) {
    console.log('[task] submit: 다시 요청 from_group_id =', taskReissueFromGroupId);
    fd.append('from_group_id', taskReissueFromGroupId);
  }
  for (const entry of taskPendingFiles) {
    fd.append('files', entry.file, entry.displayName);
  }

  taskEls.submitBtn.disabled = true;
  taskEls.submitBtn.textContent = '전송 중...';
  try {
    const res = await fetch('/api/tasks/request', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`요청 실패: ${data.detail || data.error || res.status}`, 'error');
      return;
    }
    const delivered = (data.delivered_to || []).length;
    showToast(`업무 요청을 ${delivered}명에게 전송했습니다`, 'info', 3500);
    closeTaskRequestModal();
  } catch (e) {
    showToast(`요청 오류: ${e.message}`, 'error');
  } finally {
    taskEls.submitBtn.disabled = false;
    taskEls.submitBtn.textContent = '요청';
  }
}

// ───── Inbound pending badge (launcher + choice button) ─────
async function refreshInboundPendingBadge() {
  let pending = 0;
  try {
    const res = await fetch('/api/tasks/inbound-stats');
    if (res.ok) {
      const d = await res.json();
      pending = Number(d.pending) || 0;
    }
  } catch { /* network blip — skip update */ return; }
  const apply = (id) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (pending > 0) {
      el.textContent = pending > 99 ? '99+' : String(pending);
      el.classList.remove('hidden');
    } else {
      el.classList.add('hidden');
    }
  };
  apply('task-launcher-badge');
  apply('task-inbound-pending-badge');
}

// Initial paint + periodic refresh as a safety net (events should already
// keep it accurate, but a 30s tick covers SSE drops / clock skew).
refreshInboundPendingBadge();
registerPoll(refreshInboundPendingBadge, 30000); // H-13

// ───── Inbound (요청받은 업무) list + detail ─────

const taskInboundEls = {
  modal:        document.getElementById('task-inbound-modal'),
  rows:         document.getElementById('task-inbound-rows'),
  count:        document.getElementById('task-inbound-count'),
  refreshBtn:   document.getElementById('task-inbound-refresh'),
  selectAll:    document.getElementById('task-inbound-select-all'),
  delSelected:  document.getElementById('task-inbound-delete-selected'),
};
const taskDetailEls = {
  modal:         document.getElementById('task-detail-modal'),
  card:          () => document.querySelector('#task-detail-modal .task-detail-card'),
  grid:          () => document.querySelector('#task-detail-modal .task-detail-grid'),
  status:        document.getElementById('task-detail-status'),
  sender:        document.getElementById('task-detail-sender'),
  deadline:      document.getElementById('task-detail-deadline'),
  created:       document.getElementById('task-detail-created'),
  body:          document.getElementById('task-detail-body'),
  attachments:   document.getElementById('task-detail-attachments'),
  commentsList:  document.getElementById('task-detail-comments-list'),
  commentInput:  document.getElementById('task-detail-comment-input'),
  proposedDate:  document.getElementById('task-detail-deadline-date'),
  proposedHour:  document.getElementById('task-detail-deadline-hour'),
  proposedMin:   document.getElementById('task-detail-deadline-minute'),
  proposedClear: document.getElementById('task-detail-deadline-clear'),
  // Schedule pane (shown when task is accepted)
  schedPane:     document.getElementById('task-detail-schedule-pane'),
  schedCategory: document.getElementById('task-sched-category'),
  schedCatCreate: document.getElementById('task-sched-cat-create'),
  schedTitle:    document.getElementById('task-sched-title'),
  schedDesc:     document.getElementById('task-sched-desc'),
  schedStart:    document.getElementById('task-sched-start'),
  schedEnd:      document.getElementById('task-sched-end'),
  schedStatus:   document.getElementById('task-sched-status'),
  schedSave:     document.getElementById('task-sched-save'),
};

// Populate hour/minute selects on the inbound detail modal once.
(function fillTaskDetailDeadline() {
  const pad = (n) => String(n).padStart(2, '0');
  if (taskDetailEls.proposedHour && taskDetailEls.proposedHour.options.length === 0) {
    for (let h = 0; h < 24; h++) {
      const o = document.createElement('option');
      o.value = pad(h); o.textContent = pad(h);
      taskDetailEls.proposedHour.appendChild(o);
    }
  }
  if (taskDetailEls.proposedMin && taskDetailEls.proposedMin.options.length === 0) {
    for (let m = 0; m < 60; m += 5) {
      const o = document.createElement('option');
      o.value = pad(m); o.textContent = pad(m);
      taskDetailEls.proposedMin.appendChild(o);
    }
  }
})();

let taskDetailCurrent = null; // currently open inbound row id

const TASK_STATUS_LABEL = {
  pending: '대기', accepted: '수락', adjusted: '조정', rejected: '거부',
};

async function openTaskInboundModal() {
  if (!taskInboundEls.modal) return;
  taskInboundEls.modal.classList.remove('hidden');
  await loadAndRenderInbound();
}

async function loadAndRenderInbound() {
  if (!taskInboundEls.rows) return;
  taskInboundEls.rows.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center; padding:14px;">불러오는 중...</td></tr>';
  let rows = [];
  try {
    const res = await fetch('/api/tasks/inbound');
    if (res.ok) rows = await res.json();
  } catch (e) {
    taskInboundEls.rows.innerHTML = `<tr><td colspan="5" class="muted" style="text-align:center; padding:14px;">불러오기 실패: ${escapeHtml(e.message)}</td></tr>`;
    return;
  }
  if (taskInboundEls.count) {
    taskInboundEls.count.textContent = rows.length > 0 ? `(${rows.length}건)` : '';
  }
  // Cache the visible row ids so 「전체 삭제」 can target them without
  // re-querying the DOM.
  lastInboundRowIds = rows.map((r) => Number(r.id)).filter((n) => Number.isInteger(n));
  taskInboundEls.rows.innerHTML = '';
  if (rows.length === 0) {
    taskInboundEls.rows.innerHTML = '<tr><td colspan="5" class="muted" style="text-align:center; padding:14px;">받은 요청이 없습니다</td></tr>';
    refreshTaskInboundDeleteButtons();
    return;
  }
  for (const r of rows) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(r.id);
    const preview = (r.body || '').replace(/\s+/g, ' ').trim();
    const status = r.status || 'pending';
    tr.innerHTML = `
      <td class="task-row-select-cell"><input type="checkbox" class="task-inbound-row-check" data-id="${r.id}" /></td>
      <td>${escapeHtml(r.sender)}</td>
      <td><div class="task-inbound-body-preview">${escapeHtml(preview)}</div></td>
      <td>${escapeHtml(r.deadline || '')}</td>
      <td><span class="task-status-badge" data-status="${status}">${TASK_STATUS_LABEL[status] || status}</span></td>
    `;
    // Open detail only if click did not originate from the checkbox cell.
    tr.addEventListener('click', (e) => {
      if (e.target.closest('.task-row-select-cell')) return;
      openTaskDetail(r.id);
    });
    taskInboundEls.rows.appendChild(tr);
  }
  refreshTaskInboundDeleteButtons();
}

let lastInboundRowIds = [];

function getSelectedOutboundIds() {
  const ids = new Set();
  document.querySelectorAll('#task-outbound-list .task-outbound-row-check:checked').forEach((cb) => {
    String(cb.dataset.rowIds || '').split(',').forEach((s) => {
      const n = Number(s);
      if (Number.isInteger(n) && n > 0) ids.add(n);
    });
  });
  return Array.from(ids);
}
function getSelectedInboundIds() {
  const ids = [];
  document.querySelectorAll('#task-inbound-rows .task-inbound-row-check:checked').forEach((cb) => {
    const n = Number(cb.dataset.id);
    if (Number.isInteger(n) && n > 0) ids.push(n);
  });
  return ids;
}
function refreshTaskOutboundDeleteButtons() {
  if (!taskEls.outboundDelSelected) return;
  taskEls.outboundDelSelected.disabled = getSelectedOutboundIds().length === 0;
}
function refreshTaskInboundDeleteButtons() {
  if (!taskInboundEls.delSelected) return;
  taskInboundEls.delSelected.disabled = getSelectedInboundIds().length === 0;
}
async function deleteTaskRowIds(ids) {
  if (!Array.isArray(ids) || ids.length === 0) return false;
  try {
    const res = await fetch('/api/tasks/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      showToast(`삭제 실패: ${err.error || res.status}`, 'error');
      return false;
    }
    const data = await res.json().catch(() => ({}));
    showToast(`${data.deleted || ids.length}건 삭제됨`);
    return true;
  } catch (e) {
    showToast(`삭제 오류: ${e.message}`, 'error');
    return false;
  }
}

async function openTaskDetail(reqId) {
  if (!taskDetailEls.modal) return;
  let r = null;
  try {
    const res = await fetch(`/api/tasks/${reqId}`);
    if (res.ok) r = await res.json();
  } catch (e) {
    showToast(`불러오기 실패: ${e.message}`, 'error');
    return;
  }
  if (!r) return;
  taskDetailCurrent = r.id;
  taskDetailEls.sender.textContent = r.sender || '';
  taskDetailEls.deadline.textContent = r.deadline || '(없음)';
  taskDetailEls.created.textContent = formatCommentTimestamp(r.created_at);
  taskDetailEls.body.textContent = r.body || '';
  taskDetailEls.status.textContent = TASK_STATUS_LABEL[r.status] || r.status;
  taskDetailEls.status.dataset.status = r.status || 'pending';

  // Attachments — sender-side files reachable via cross-peer URL only if we
  // know sender's host:port. Resolve from current peer list.
  taskDetailEls.attachments.innerHTML = '';
  const senderPeer = (state.team && state.team.peers || []).find((p) => p.name === r.sender);
  for (const a of (r.attachments || [])) {
    if (a.kind === 'upload' && senderPeer) {
      const href = `http://${encodeURIComponent(senderPeer.host)}:${Number(senderPeer.port)}/uploads/${encodeURIComponent(a.path)}`;
      const link = document.createElement('a');
      link.className = 'att-chip';
      link.href = href;
      link.target = '_blank';
      link.rel = 'noopener';
      link.title = a.display_name;
      link.textContent = `📎 ${a.display_name}`;
      taskDetailEls.attachments.appendChild(link);
    } else {
      const span = document.createElement('span');
      span.className = 'att-chip-readonly';
      span.title = a.path;
      span.textContent = `📁 ${a.display_name} ${senderPeer ? '' : '(원격 위치 미상)'}`;
      taskDetailEls.attachments.appendChild(span);
    }
  }

  renderCommentsInto('task-detail-comments-list', null, r.comments || [], { editable: false });
  if (taskDetailEls.commentInput) taskDetailEls.commentInput.value = '';
  // Reset proposed-deadline inputs each time the modal opens.
  if (taskDetailEls.proposedDate)  taskDetailEls.proposedDate.value = '';
  if (taskDetailEls.proposedHour)  taskDetailEls.proposedHour.value = '09';
  if (taskDetailEls.proposedMin)   taskDetailEls.proposedMin.value = '00';

  // Response actions need to forward to the sender's peer, which only makes
  // sense when team mode is ON. Disable the input + 수락/조정/거부 buttons
  // when OFF so the user gets a clear "you need ON to respond" signal.
  const teamOn = state.team && state.team.mode === 'ON';
  if (taskDetailEls.commentInput) {
    taskDetailEls.commentInput.disabled = !teamOn;
    taskDetailEls.commentInput.placeholder = teamOn
      ? '조정·거부 시 사유를 작성하세요'
      : '팀 전체계획을 ON 으로 켜야 응답할 수 있습니다';
  }
  taskDetailEls.modal.querySelectorAll('button[data-action]').forEach((btn) => {
    btn.disabled = !teamOn;
  });

  // Schedule pane — visible only when this task is already 'accepted' so the
  // recipient can register/edit a personal schedule for it. Modal widens.
  await applyScheduleScope(r);

  taskDetailEls.modal.classList.remove('hidden');
}

// Show/hide the schedule pane based on row status. When showing, populate
// the form (with the linked schedule if it already exists) and pre-fill
// end-date with the task's deadline.
async function applyScheduleScope(r) {
  const card = taskDetailEls.card();
  const grid = taskDetailEls.grid();
  const pane = taskDetailEls.schedPane;
  if (!card || !grid || !pane) return;
  const isAccepted = r && r.status === 'accepted';
  if (!isAccepted) {
    pane.classList.add('hidden');
    grid.classList.remove('with-schedule');
    card.classList.remove('with-schedule');
    return;
  }
  pane.classList.remove('hidden');
  grid.classList.add('with-schedule');
  card.classList.add('with-schedule');
  await loadCategoriesIntoSchedSelect();

  const sched = r.schedule;
  const today = todayIso();
  // Deadline is stored as "YYYY-MM-DD HH:MM" — pull just the date part.
  const deadlineDate = (r.deadline || '').slice(0, 10);
  if (sched) {
    if (taskDetailEls.schedCategory) taskDetailEls.schedCategory.value = String(sched.category_id || '');
    if (taskDetailEls.schedTitle)    taskDetailEls.schedTitle.value = sched.title || '';
    if (taskDetailEls.schedDesc)     taskDetailEls.schedDesc.value = sched.description || '';
    if (taskDetailEls.schedStart)    taskDetailEls.schedStart.value = sched.planned_start || today;
    if (taskDetailEls.schedEnd)      taskDetailEls.schedEnd.value = sched.planned_end || deadlineDate || today;
    if (taskDetailEls.schedStatus)   taskDetailEls.schedStatus.value = sched.status || 'not_started';
  } else {
    if (taskDetailEls.schedTitle) taskDetailEls.schedTitle.value = '';
    if (taskDetailEls.schedDesc)  taskDetailEls.schedDesc.value = r.body || '';
    if (taskDetailEls.schedStart) taskDetailEls.schedStart.value = today;
    if (taskDetailEls.schedEnd)   taskDetailEls.schedEnd.value = deadlineDate || today;
    if (taskDetailEls.schedStatus) taskDetailEls.schedStatus.value = 'not_started';
  }
}

async function loadCategoriesIntoSchedSelect() {
  const sel = taskDetailEls.schedCategory;
  if (!sel) return;
  const previous = sel.value;
  sel.innerHTML = '';
  let cats = [];
  try {
    const res = await fetch('/api/categories');
    if (res.ok) cats = await res.json();
  } catch { /* network blip */ }
  if (cats.length === 0) {
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = '— 카테고리가 없습니다 —';
    sel.appendChild(opt);
    return;
  }
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = String(c.id);
    opt.textContent = c.name;
    sel.appendChild(opt);
  }
  if (previous && cats.some((c) => String(c.id) === previous)) {
    sel.value = previous;
  }
}

function closeTaskDetailModal() {
  if (taskDetailEls.modal) taskDetailEls.modal.classList.add('hidden');
  taskDetailCurrent = null;
}

async function submitTaskResponse(action) {
  if (!taskDetailCurrent) return;
  const body = (taskDetailEls.commentInput.value || '').trim();
  if (action === 'adjust' && !body) {
    showToast('조정 시 사유를 작성하세요', 'error');
    return;
  }
  // Combine proposed deadline date+hour+minute → "YYYY-MM-DD HH:MM" (or null).
  let proposedDeadline = null;
  const d = (taskDetailEls.proposedDate && taskDetailEls.proposedDate.value || '').trim();
  if (d) {
    const hh = (taskDetailEls.proposedHour && taskDetailEls.proposedHour.value) || '00';
    const mm = (taskDetailEls.proposedMin && taskDetailEls.proposedMin.value) || '00';
    proposedDeadline = `${d} ${hh}:${mm}`;
  }
  try {
    const res = await fetch(`/api/tasks/${taskDetailCurrent}/respond`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, body, proposed_deadline: proposedDeadline }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showToast(`응답 실패: ${data.error || res.status}`, 'error');
      return;
    }
    const label = { accept: '수락', adjust: '조정', reject: '거부' }[action] || action;
    if (action === 'accept') {
      // Keep the modal open so the recipient can fill in the schedule pane that
      // unfurls on the right. Refetch the row so applyScheduleScope picks up
      // the new 'accepted' status and reveals the third column.
      showToast(`${label}했습니다. 우측에서 스케줄을 입력하세요.`, 'info', 4000);
      const id = taskDetailCurrent;
      await loadAndRenderInbound();
      refreshInboundPendingBadge();
      await openTaskDetail(id);
      return;
    }
    showToast(`'${label}' 으로 응답했습니다`, 'info', 3000);
    closeTaskDetailModal();
    await loadAndRenderInbound();
    refreshInboundPendingBadge();
  } catch (e) {
    showToast(`응답 오류: ${e.message}`, 'error');
  }
}

if (taskInboundEls.modal) {
  taskInboundEls.modal.addEventListener('click', (e) => {
    if (e.target === taskInboundEls.modal || e.target.matches('[data-close]')) {
      taskInboundEls.modal.classList.add('hidden');
    }
  });
}
if (taskInboundEls.refreshBtn) {
  taskInboundEls.refreshBtn.addEventListener('click', loadAndRenderInbound);
}
if (taskInboundEls.rows) {
  taskInboundEls.rows.addEventListener('change', (e) => {
    if (!e.target.classList.contains('task-inbound-row-check')) return;
    const all = document.querySelectorAll('#task-inbound-rows .task-inbound-row-check');
    const checked = document.querySelectorAll('#task-inbound-rows .task-inbound-row-check:checked');
    if (taskInboundEls.selectAll) {
      taskInboundEls.selectAll.checked = all.length > 0 && checked.length === all.length;
      taskInboundEls.selectAll.indeterminate = checked.length > 0 && checked.length < all.length;
    }
    refreshTaskInboundDeleteButtons();
  });
}
if (taskInboundEls.selectAll) {
  taskInboundEls.selectAll.addEventListener('change', () => {
    document.querySelectorAll('#task-inbound-rows .task-inbound-row-check').forEach((cb) => {
      cb.checked = taskInboundEls.selectAll.checked;
    });
    taskInboundEls.selectAll.indeterminate = false;
    refreshTaskInboundDeleteButtons();
  });
}
if (taskInboundEls.delSelected) {
  taskInboundEls.delSelected.addEventListener('click', async () => {
    const ids = getSelectedInboundIds();
    if (ids.length === 0) return;
    if (!confirm(`선택한 ${ids.length}건을 삭제합니다.\n(내 PC 데이터만 삭제 — 발신자 PC 의 outbound row 는 그대로 남음)\n\n계속할까요?`)) return;
    const ok = await deleteTaskRowIds(ids);
    if (ok) {
      await loadAndRenderInbound();
      refreshInboundPendingBadge();
    }
  });
}
if (taskDetailEls.modal) {
  taskDetailEls.modal.addEventListener('click', (e) => {
    if (e.target === taskDetailEls.modal || e.target.matches('[data-close]')) {
      closeTaskDetailModal();
      return;
    }
    const actBtn = e.target.closest('button[data-action]');
    if (actBtn && ['accept', 'adjust', 'reject'].includes(actBtn.dataset.action)) {
      submitTaskResponse(actBtn.dataset.action);
    }
  });
}
if (taskDetailEls.proposedClear) {
  taskDetailEls.proposedClear.addEventListener('click', () => {
    taskDetailEls.proposedDate.value = '';
    if (taskDetailEls.proposedHour) taskDetailEls.proposedHour.value = '09';
    if (taskDetailEls.proposedMin) taskDetailEls.proposedMin.value = '00';
  });
}

// "+ 새 카테고리" — reuse the existing category modal with a marker so its
// submit handler refreshes the schedule-pane dropdown instead of navigating.
if (taskDetailEls.schedCatCreate) {
  taskDetailEls.schedCatCreate.addEventListener('click', () => {
    if (!els.categoryForm) return;
    els.categoryForm.dataset.fromTaskSched = '1';
    openCategoryModal(null);
  });
}

// "스케줄 저장" — POST values to /api/tasks/:id/save-schedule. Refreshes the
// modal so the linked schedule is reflected on subsequent reopens.
if (taskDetailEls.schedSave) {
  taskDetailEls.schedSave.addEventListener('click', async () => {
    if (!taskDetailCurrent) return;
    const categoryId = Number(taskDetailEls.schedCategory && taskDetailEls.schedCategory.value);
    if (!Number.isInteger(categoryId) || categoryId <= 0) {
      showToast('카테고리를 선택하세요', 'error');
      return;
    }
    const title = (taskDetailEls.schedTitle.value || '').trim();
    if (!title) {
      showToast('제목을 입력하세요', 'error');
      return;
    }
    const start = (taskDetailEls.schedStart.value || '').trim();
    const end   = (taskDetailEls.schedEnd.value || '').trim();
    if (!start || !end) {
      showToast('시작일과 종료일을 입력하세요', 'error');
      return;
    }
    if (start > end) {
      showToast('시작일이 종료일보다 늦을 수 없습니다', 'error');
      return;
    }
    const payload = {
      category_id: categoryId,
      title,
      description: (taskDetailEls.schedDesc.value || '').trim(),
      planned_start: start,
      planned_end: end,
      status: taskDetailEls.schedStatus.value || 'not_started',
    };
    taskDetailEls.schedSave.disabled = true;
    try {
      const res = await fetch(`/api/tasks/${taskDetailCurrent}/save-schedule`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showToast(`저장 실패: ${data.error || res.status}`, 'error');
        return;
      }
      showToast('스케줄을 저장했습니다', 'info', 3000);
      // Bring the saved schedule into the local state so 간트/카테고리 뷰가 즉시
      // 반영된다.
      try { await refreshAll(); } catch { /* non-fatal */ }
      // Keep the modal open and refresh so the form reflects the linked id.
      await openTaskDetail(taskDetailCurrent);
    } catch (e) {
      showToast(`저장 오류: ${e.message}`, 'error');
    } finally {
      taskDetailEls.schedSave.disabled = false;
    }
  });
}
