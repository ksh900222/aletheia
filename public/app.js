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
  pendingAttachments: [], // [{ kind:'upload', file, display_name } | { kind:'local_path', path, display_name }]
  reportLinkedSchedule: null, // {schedule, date} when modal was opened from a Gantt bar click
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
  allReportsSummary: $('#all-reports-summary'),
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

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(url, opts);
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

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
    base = state.allSchedules;
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
    base = base.filter((s) => (s.title || '').toLowerCase().includes(q));
  }
  return { schedules: base, baseIdSet };
}

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
    const slack = s.slack_days || 0;
    const slackHtml = slack > 0
      ? `<span class="slack-pill">+${slack}일</span>`
      : `<span class="slack-pill zero">—</span>`;
    const planShifted = s.actual_start !== s.planned_start || s.actual_end !== s.planned_end;
    const days = daysBetweenInclusive(s.planned_start, s.planned_end);
    const cat = state.categories.find((c) => c.id === s.category_id);
    const catCell = `<td class="all-view-only"><span class="cat-tag" style="background:${(cat && cat.color) || '#eef3ff'}; color:#fff;">${escapeHtml((cat && cat.name) || '?')}</span></td>`;
    const isExtra = !baseIdSet.has(s.id);
    const tr = document.createElement('tr');
    if (isExtra) tr.style.opacity = '0.85';
    tr.innerHTML = `
      <td>${escapeHtml(s.title)}${isExtra ? ' <span class="muted" title="연결된 항목">·연결</span>' : ''}</td>
      ${catCell}
      <td>${s.planned_start}</td>
      <td>${s.planned_end}</td>
      <td>${days != null ? `${days}일` : ''}</td>
      <td>${planShifted ? `<b>${s.actual_start}</b>` : s.actual_start || ''}</td>
      <td>${planShifted ? `<b>${s.actual_end}</b>` : s.actual_end || ''}</td>
      <td>${slackHtml}</td>
      <td><span class="status-pill ${s.status}" data-action="cycle-status" data-id="${s.id}" role="button" title="클릭하여 다음 상태로 변경">${s.status}</span></td>
      <td class="actions">
        <button class="btn" data-action="edit-schedule" data-id="${s.id}">편집</button>
        <button class="btn btn-danger" data-action="delete-schedule" data-id="${s.id}">삭제</button>
      </td>
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
  const ids = visible.map((s) => s.id);
  const idSet = new Set(ids);
  const byId = new Map(visible.map((s) => [s.id, s]));
  const idsForRef = (type, id) => {
    if (type === 'schedule') return [id];
    return state.allSchedules
      .filter((s) => s.category_id === id)
      .map((s) => s.id);
  };

  // Adjacency maps (directed for topo, undirected for components).
  const directed = new Map();
  const undirected = new Map();
  for (const id of ids) {
    directed.set(id, new Set());
    undirected.set(id, new Set());
  }
  for (const d of state.dependencies) {
    if (d.link_type !== 'strong') continue;
    const ps = idsForRef(d.pred_type, d.pred_id);
    const qs = idsForRef(d.succ_type, d.succ_id);
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
    const cat = state.categories.find((c) => c.id === s.category_id);
    if (cat && cat.color) bar.style.setProperty('--cat-color', cat.color);
    bar.style.left = barLeft + 'px';
    bar.style.width = barWidth + 'px';
    bar.dataset.scheduleId = String(s.id);
    const catLabel = cat ? `[${cat.name}] ` : '';
    bar.title = planShifted
      ? `${catLabel}${s.title}\n계획: ${s.planned_start} ~ ${s.planned_end}\n실제(엔진 조정): ${s.actual_start} ~ ${s.actual_end}`
      : `${catLabel}${s.title}\n${s.planned_start} ~ ${s.planned_end}`;
    bar.textContent = catLabel + s.title;

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
      positions.set(s.id, { left, right, midY });
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
function categoryColorFor(type, id) {
  let cat = null;
  if (type === 'category') {
    cat = state.categories.find((c) => c.id === id);
  } else if (type === 'schedule') {
    const s = state.allSchedules.find((x) => x.id === id);
    if (s) cat = state.categories.find((c) => c.id === s.category_id);
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

  const schedulesByCat = new Map();
  for (const s of state.allSchedules) {
    if (!schedulesByCat.has(s.category_id)) schedulesByCat.set(s.category_id, []);
    schedulesByCat.get(s.category_id).push(s.id);
  }

  function pickPredScheduleId(d) {
    if (d.pred_type === 'schedule') {
      return positions.has(d.pred_id) ? d.pred_id : null;
    }
    let bestId = null;
    let bestRight = -Infinity;
    for (const id of (schedulesByCat.get(d.pred_id) || [])) {
      const p = positions.get(id);
      if (p && p.right > bestRight) {
        bestRight = p.right;
        bestId = id;
      }
    }
    return bestId;
  }
  function pickSuccScheduleId(d) {
    if (d.succ_type === 'schedule') {
      return positions.has(d.succ_id) ? d.succ_id : null;
    }
    let bestId = null;
    let bestLeft = Infinity;
    for (const id of (schedulesByCat.get(d.succ_id) || [])) {
      const p = positions.get(id);
      if (p && p.left < bestLeft) {
        bestLeft = p.left;
        bestId = id;
      }
    }
    return bestId;
  }

  // Two passes so weak (dashed) edges are drawn AFTER strong (solid) ones,
  // and so they don't get hidden by overlapping solid lines. Weak edges also
  // get a small vertical offset so they remain visually distinguishable when
  // they share the same pred/succ pair as a strong edge.
  function drawOne(d, weakYOffset) {
    const predId = pickPredScheduleId(d);
    const succId = pickSuccScheduleId(d);
    if (!predId || !succId) return;
    const p = positions.get(predId);
    const s = positions.get(succId);
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

    const color = categoryColorFor(d.pred_type, d.pred_id);
    const el = document.createElementNS(NS, 'path');
    el.setAttribute('d', path);
    el.setAttribute('fill', 'none');
    el.setAttribute('stroke', color);
    el.dataset.depId = String(d.id);
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

  // Pass 1: strong edges (no offset).
  for (const d of state.dependencies) {
    if (d.link_type === 'strong') drawOne(d, 0);
  }
  // Pass 2: weak edges, drawn on top with a +6px vertical offset so an
  // overlapping strong line doesn't obscure them.
  for (const d of state.dependencies) {
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
  const matches = (type, id) => {
    if (type === 'schedule') return id === schedule.id;
    if (type === 'category') return id === schedule.category_id;
    return false;
  };
  return matches(dep.pred_type, dep.pred_id) || matches(dep.succ_type, dep.succ_id);
}

// Resolve a dep endpoint (schedule|category) to the set of schedule IDs that
// it stands for. Used during bar hover to mark every bar that participates
// in a dep with the hovered schedule.
function resolveEndpointScheduleIds(type, id) {
  if (type === 'schedule') return [id];
  if (type === 'category') {
    return state.allSchedules
      .filter((s) => s.category_id === id)
      .map((s) => s.id);
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

    // Bars: dim all bars in the grid except hovered + those tied by a dep.
    if (grid) {
      grid.classList.add('hover-active');
      const focusIds = new Set([schedule.id]);
      for (const dep of state.dependencies) {
        if (!isDepRelatedTo(dep, schedule)) continue;
        for (const sid of resolveEndpointScheduleIds(dep.pred_type, dep.pred_id)) {
          focusIds.add(sid);
        }
        for (const sid of resolveEndpointScheduleIds(dep.succ_type, dep.succ_id)) {
          focusIds.add(sid);
        }
      }
      grid.querySelectorAll('.gantt-bar[data-schedule-id]').forEach((b) => {
        if (focusIds.has(Number(b.dataset.scheduleId))) {
          b.classList.add('bar-focus');
        }
      });
    }

    // Arrows: same focus rule as before.
    if (svg) {
      svg.classList.add('hover-active');
      svg.querySelectorAll('path[data-dep-id]').forEach((p) => {
        const depId = Number(p.dataset.depId);
        const dep = state.dependencies.find((d) => d.id === depId);
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

function renderAllReportsView() {
  const root = els.allReportsContent;
  root.innerHTML = '';

  const q = state.allReportsQuery.trim().toLowerCase();
  const filtered = state.allReports.filter((r) => reportMatchesQuery(r, q));

  els.allReportsSummary.textContent = q
    ? `검색 결과 ${filtered.length}건 / 전체 ${state.allReports.length}건`
    : `전체 ${state.allReports.length}건`;
  els.allReportsSearch.value = state.allReportsQuery;

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
      if (!byCat.has(cat.id)) byCat.set(cat.id, { cat, reports: [] });
      byCat.get(cat.id).reports.push(r);
    }
  }

  // Render each category section in stable id order.
  const sections = [...byCat.values()].sort((a, b) => a.cat.id - b.cat.id);
  if (noCat.length > 0) {
    sections.push({ cat: { id: -1, name: '태그 없음', color: '#9aa1ad' }, reports: noCat });
  }

  for (const { cat, reports: catReports } of sections) {
    const section = document.createElement('section');
    section.className = 'reports-cat-section';

    const head = document.createElement('div');
    head.className = 'reports-cat-head';
    head.innerHTML = `
      <span class="cat-tag" style="background:${escapeHtml(cat.color || '#9aa1ad')}; color:#fff;">${escapeHtml(cat.name)}</span>
      <span class="muted">${catReports.length}건</span>
    `;
    section.appendChild(head);

    // Group by date. ASC ordering throughout so that the on-screen sequence
    // matches real-world chronology:
    //   - Older dates appear above newer ones (e.g. 4/30 before 5/4).
    //   - Within the same date, the report posted earlier appears above the
    //     later one (sort by id since auto-increment ≈ creation order).
    const byDate = new Map();
    for (const r of catReports) {
      if (!byDate.has(r.report_date)) byDate.set(r.report_date, []);
      byDate.get(r.report_date).push(r);
    }
    const dates = [...byDate.keys()].sort(); // ASC: oldest first

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
        const li = document.createElement('li');
        li.dataset.reportId = String(r.id);

        // Preserve newlines so multi-line bodies stay multi-line on screen.
        // CSS `.report-item-body` uses `white-space: pre-wrap` to honor the \n.
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

        // Show OTHER tags (besides the current section's category) so you can
        // see which categories this report is shared with.
        const otherTags = (r.categories || [])
          .filter((c) => c.id !== cat.id)
          .map((c) => `<span class="cat-tag mini" style="background:${escapeHtml(c.color || '#9aa1ad')}; color:#fff;">${escapeHtml(c.name)}</span>`)
          .join('');

        // Schedule pills — one per linked schedule, styled like a Gantt bar
        // (category color background + white text) so the writer can see at
        // a glance which schedule this report is about. New (sticky-flow)
        // reports always have at least one schedule; legacy reports without
        // links omit the pills entirely.
        const schedPills = (r.schedules || []).map((s) => {
          const sCat = state.categories.find((c) => c.id === s.category_id);
          const bg = (sCat && sCat.color) || '#1f5fc9';
          return `<span class="schedule-pill" style="background:${escapeHtml(bg)};color:#fff;">${escapeHtml(s.title)}</span>`;
        }).join('');

        li.innerHTML = `
          ${schedPills ? `<div class="report-item-schedules">${schedPills}</div>` : ''}
          <div class="report-item-body">${previewHtml}</div>
          <div class="report-item-meta">
            ${attChips || '<span class="muted">첨부 없음</span>'}
            ${otherTags ? `<span class="other-tags">${otherTags}</span>` : ''}
          </div>
        `;
        list.appendChild(li);
      }

      dateGroup.appendChild(list);
      section.appendChild(dateGroup);
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

// Click on a report list item → open edit modal (skip if user clicked an
// attachment link inside).
els.allReportsContent.addEventListener('click', (e) => {
  if (e.target.closest('a')) return;
  const li = e.target.closest('li[data-report-id]');
  if (!li) return;
  const id = Number(li.dataset.reportId);
  const r = state.allReports.find((x) => x.id === id);
  if (r) openReportModal(r);
});

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
