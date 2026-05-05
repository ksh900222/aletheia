# Project Planner — 프로젝트 로그

> 이 문서 한 곳에 **요구사항 / 계획 / 진행사항 / 변경 이력**을 누적합니다.
> 상단 섹션(1~6)은 항상 **현재 시점의 최신 상태**를 반영하고, 하단 **§7 타임라인**에 일자·시간 순으로 변경/진행 내역을 누적해 방향성과 진행도를 추적합니다.

- **프로젝트 시작일**: 2026-05-03
- **마지막 업데이트**: 2026-05-05 16:00
- **현재 단계**: 안정화 — SS 시맨틱 / 자동 cascade / 신 리포트 모델 (날짜+스케줄 sticky) / 코드 검토 후속 정리 진행 중

---

## 1. 요구사항

### 1.1 스케줄러
- **카테고리 단위로 스케줄 관리**
  - 여러 카테고리를 생성할 수 있어야 함
  - 카테고리는 독립적으로 존재할 수도 있고, 다른 카테고리와 상호연결될 수도 있음
- **스케줄 단위 상호연결**
  - 동일 카테고리 내 스케줄 간 상호연결
  - 다른 카테고리 전체와의 상호연결
  - 다른 카테고리 내 특정 스케줄과의 상호연결

#### 의존 관계 유형
| 유형 | 의미 |
|---|---|
| **Strong (완전 의존)** | 선행이 끝나야 후행 시작 가능. 예: 카메라+디스플레이 → 조립 |
| **Weak (약한 연결)** | 같은 후행을 향하는 형제들. 한 형제가 밀려 critical이 되면 나머지는 그만큼 **여유(slack)** 가 생김 |

#### 충돌(일정 변경) 처리
- 두 가지 모드를 **엣지 단위로 저장**:
  - `auto_shift`: 후행 작업을 자동으로 밀기
  - `warn_only`: 충돌 메시지만 표시, 사용자가 수동 처리
- 변경 시점에 사용자에게 메시지 표시, 선택값을 데이터로 저장하여 이후 재현 가능

### 1.2 일일 리포트
- 카테고리별로 작성하거나, 한 번에 작성하더라도 **카테고리 태그**를 입력하면 카테고리별 뷰에서 해당 리포트 확인 가능
- 본문(텍스트) + **첨부**
  - 업로드 파일
  - 로컬 경로 지정 → 클릭 시 바로 열기
- 기업 내부 사용 가정 → 공유 드라이브 절대경로 직접 링크 가능해야 함

### 1.3 비기능 요구사항
- 단일 사용자용으로 시작
- 데이터 저장은 **로컬 파일 기반**
- 웹앱 (HTML / JavaScript / CSS 또는 유사 스택)

---

## 2. 기술 스택 (현재 결정안)

| 레이어 | 선택 | 비고 |
|---|---|---|
| 백엔드 | Node.js + Express | 단일 사용자 로컬 실행에 적합 |
| DB | SQLite (`better-sqlite3`) | 단일 파일, 설치 불필요, 기업 내 배포 간단 |
| 프론트 | Vanilla HTML/CSS/JS (시작) | 필요 시 가벼운 템플릿/번들러 도입 |
| 첨부 저장 | DB에는 경로만, 업로드본은 `./uploads/`, 로컬 경로는 절대경로 그대로 | |

---

## 3. 데이터 모델 (스케치)

```
categories
  id, name, description, color, created_at

schedules
  id, category_id, title, description,
  planned_start, planned_end,        -- 사용자가 처음 정한 일정
  actual_start, actual_end,          -- 자동 재계산 결과 또는 실제 진행
  status (not_started|in_progress|pending|blocked|done) -- 사이클 순서대로
  created_at, updated_at

dependencies                          -- 다형 (카테고리 OR 스케줄)
  id,
  pred_type ('category'|'schedule'), pred_id,
  succ_type ('category'|'schedule'), succ_id,
  link_type ('strong'|'weak'),
  on_delay  ('auto_shift'|'warn_only'),
  created_at

reports
  id, report_date, body, created_at, updated_at

report_categories                     -- 리포트 ↔ 카테고리 (N:N)
  report_id, category_id

attachments
  id, report_id,
  kind ('upload'|'local_path'),
  path,                               -- upload: 상대 / local_path: 절대
  display_name, size_bytes, created_at
```

---

## 4. 의존성 엔진 규칙

### 4.1 Strong 엣지
`B.actual_start >= A.actual_end + 1day`

엣지가 위반될 때의 자동 처리 (`auto_shift`):
- **선행이 변해 종료가 늦어진 경우**: 후행을 뒤로 자동 밀기 (forward push)
- **후행이 변해 시작이 선행 종료보다 이른 경우**: 선행을 앞으로 자동 당기기 (backward pull, 2026-05-04 추가)
- 두 경우 모두 `warn_only` 면 시프트하지 않고 충돌만 보고

### 4.2 Weak 엣지 (형제 slack)
- **현재 구현 (Phase 2)**: 사용자가 두 스케줄 사이에 weak 엣지를 명시적으로 추가. 양방향으로 동작.
- Slack 계산: `slack(X) = max(0, max(이웃 actual_end) − X.actual_end)`
- 예: 카메라가 5/8까지 밀리면, weak 형제인 디스플레이는 `slack = 5/8 − 5/4 = 4일`
- (장래 확장) 같은 후행을 향하는 strong 엣지 형제를 자동으로 weak으로 간주하는 옵션, 카테고리 단위 weak 연결

### 4.3 재계산 트리거 정책 (2026-05-04 변경)
- **자동**: 스케줄 생성/수정 시점에 그 스케줄로부터 BFS 캐스케이드 (`recomputeFromScheduleChange`).
- **수동**: 의존성 추가/삭제, 또는 데이터 일괄 정리 후에는 사용자가 직접 **"계획 갱신"** 버튼을 눌러 전체 재계산 (`POST /api/recompute` → `recomputeAll`).
- 의존성 추가 자체에서는 자동 재계산하지 **않음** (사용자 의사 결정에 따라 명시적으로 적용).

### 4.4 사이클 검출 정책
- **strong 엣지만** 사이클 검사 대상. weak 은 방향성 없는 관계라 사이클을 만들지 않음.
- 추가로 다음 케이스 거부: 자기 참조 (pred == succ), 컨테이너 사이클 (스케줄 ↔ 자기가 속한 카테고리).

### 4.4-1 의존성 입력 폼 정책 (2026-05-04 추가) — "현재 앵커 / 선행·후행"
- **추가 (Create)**: 카테고리 뷰의 "+ 의존성 추가" 가 여는 모달은 3-슬롯 폼.
  - **현재 (필수)**: 현재 보고 있는 카테고리(또는 그 안의 스케줄)로 자동 prefill. 다른 카테고리/스케줄로 옮길 수 없음 — 앵커의 의미를 유지하기 위함.
  - **선행 (선택) / 후행 (선택)**: 어느 한쪽만 골라도 되고 둘 다 골라도 됨. 둘 다면 한 번에 두 의존성 (선행→현재, 현재→후행) 을 한 트랜잭션으로 생성.
  - **link_type / on_delay 공유**: 한 폼이 만드는 양 엣지에 동일 적용 (v1).
- **편집 (Edit)**: `편집` 버튼이 여는 모달은 기존 2-슬롯 (선행 → 후행). 의존성 1행 = 1 엣지라 앵커 개념이 의미 없음.
- **드롭다운 필터링** (UI 단계 검증):
  - 선행의 대상 옵션은 **현재 + 후행에 선택된 항목 + 컨테이너 관계 항목**을 자동 제외.
  - 후행도 대칭적으로 제외.
  - 효과: 자기참조 / 선행==후행 / 컨테이너 사이클 등의 케이스를 입력 단계에서 차단 — 서버 검증 메시지를 거의 볼 일이 없음.
- **트랜잭션 안전성**: 두 엣지 중 하나라도 검증 실패(cycle / duplicate / container 등)면 둘 다 롤백. 두 번째 엣지의 사이클 검사는 첫 엣지가 트랜잭션에 이미 삽입된 상태에서 수행되므로 "두 엣지의 조합으로 새로 생기는 사이클" 도 잡힘.

#### 4.4-2 의존성 패널 표시 규칙 (2026-05-04 추가)
카테고리 뷰의 의존성 패널은 **선행 → 현재 → 후행** 3-위치 레이아웃으로 표시. 각 row(엣지) 의 양 endpoint 중 어느 쪽이 현재 카테고리에 속하는지 자동 판정:
- **succ 만 현재에 있음** → 선행=pred (외부) / 현재=succ / 후행=—
- **pred 만 현재에 있음** → 선행=— / 현재=pred / 후행=succ (외부)
- **둘 다 현재에 있음** (내부 의존) → 선행=— / 현재=pred / 후행=succ (둘 다 같은 카테고리)

엔티티 라벨은 카테고리 컨텍스트를 포함해 표기 (`📁 카테고리명` / `카테고리명 / 스케줄제목`).

**유형 / 충돌 시 인라인 토글**:
- `유형` 칩 클릭 → strong ↔ weak 즉시 전환 (PUT)
- `충돌 시` 칩 클릭 → auto_shift ↔ warn_only 전환 (link_type=strong 일 때만 활성)
- 양 칩 모두 hover 시 시각 피드백 + cursor:pointer.

### 4.5 일정 변경 시 처리 흐름
변경된 스케줄 X 에서 출발해 **양방향 BFS** 로 캐스케이드:

```
[BACKWARD pass — 선행을 앞으로 당기기]
1. queue := { X, X.category }
2. for each node in queue:
     required = max(end of strong preds of node) + 1
     if required > entityStart(node):
       for each binding pred P:
         if edge(P→node).on_delay == 'auto_shift':
           pull P back so P.end == entityStart(node) - 1 (duration 보존)
           enqueue P (그리고 카테고리)  → P가 또 자기 선행을 위반할 수 있음
         else (warn_only):
           record conflict on node

[FORWARD pass — 후행을 뒤로 밀기]
1. queue := { X, X.category }
2. for each node in queue:
     for each succ S of node:
       required = max(end of strong preds of S) + 1
       if required > entityStart(S):
         if edge(node→S).on_delay == 'auto_shift':
           push S forward so S.start == required (duration 보존)
           enqueue S
         else (warn_only):
           record conflict on S
```

캐스케이드 결과(`shifted`/`conflicts`)는 응답에 포함되어 사용자에게 alert 으로 표시됨. `delta_days` 는 부호 있음 — 양수 = 뒤로 밀림, 음수 = 앞으로 당겨짐.

### 4.6 검증 (핸드폰 예시)
- 카메라 5/4 → 5/8 변경
- 조립 strong 선행자: 카메라(5/8), 디스플레이(5/4) → max = 5/8 → 조립 actual_start = 5/9
- 디스플레이는 카메라의 weak 형제 → slack = 5/8 − 5/4 = **4일 여유**

### 4.7 간트 시각 표기 규약 (2026-05-04 추가)

간트 차트가 사용자에게 전달하는 의미:

| 요소 | 의미 |
|---|---|
| **막대 본체** | 사용자가 **계획한 위치**(`planned_start ~ planned_end`). 드래그하면 planned 가 바뀌므로 막대도 함께 이동. 사용자가 끌어놓은 곳에 안정적으로 머무름. |
| **막대 색 — 파란색 (primary)** | `planned == actual` — 의존성 충돌 없음, 계획대로 가능 |
| **막대 색 — 오렌지 (`shifted`)** | `planned ≠ actual` — 엔진이 의존성 캐스케이드로 actual 을 다른 위치로 조정. 계획과 충돌 |
| **막대 좌측 4px 색 띠** | 카테고리 색 (시각적 그룹핑) |
| **막대 점선 outline (`connected-extra`)** | 연결 포함 토글 ON 일 때, 선택 카테고리의 직접 멤버가 아닌 "의존성으로 연결된" 외부 항목 |
| **막대 아래 얇은 오렌지 띠 (`gantt-actual-overlay`)** | 엔진이 계산한 **actual 위치**. shifted 막대일 때만 표시. "엔진은 이 일정이 띠 위치에 가야 한다고 본다" 는 의미. 사용자가 이를 받아들이려면 막대를 띠 위치로 끌어옮겨 planned 를 갱신하면 됨. 받아들이지 않으려면 의존성을 `warn_only` 로 바꾸거나 의존성을 조정. |
| **빨간 세로선** | 오늘 |
| **헤더 컬럼 배경 — 옅은 파란** | 토요일 |
| **헤더 컬럼 배경 — 옅은 빨강** | 일요일 + 대한민국 법정·임시공휴일 (서버에서 일 1회 자동 갱신 + 클라이언트의 하드코딩 fallback) |
| **헤더 컬럼 배경 — 진한 파란** | 오늘 (위 색보다 우선 적용) |
| **헤더 텍스트 형식** | `M월\nD일` (예: `5월 / 13일` 두 줄) |

화살표 (의존성 토글 ON 시):

| 요소 | 의미 |
|---|---|
| **파란 솔리드 + 화살표머리** | strong 의존 (pred → succ, 선행이 끝나야 후행 시작) |
| **회색 점선 (Y +6px 오프셋, 두 번째 패스로 그려짐)** | weak 의존 (방향성 없는 형제 관계, slack 공유). strong 과 같은 pred/succ 쌍에 함께 있어도 strong 아래쪽에 가시화됨. |

**테이블 컬럼 너비 (2026-05-04 추가)**:
- 대상 테이블: `#schedule-table`, `#dependency-table`, `#report-table` (모두 `class="schedules resizable"`).
- **고정 초기값**: 각 `<th>` 의 인라인 `style="width: Xpx"` 로 카테고리·세션을 옮겨도 항상 같은 시작 너비. `table-layout: fixed` 로 콘텐츠 길이 변동에 무관.
- **드래그 조정**: 각 `<th>` 우측 6px `col-resize-handle` 을 드래그해 너비 변경. hover 시 강조.
- **지속**: 조정한 값은 `localStorage["colwidths:{tableId}"]` 에 JSON 배열로 저장 → 새로고침·카테고리 전환·다른 세션에서도 그대로 적용.
- **리셋**: 브라우저 콘솔에서 `localStorage.removeItem("colwidths:schedule-table")` 등 직접 제거 (UI 리셋 버튼은 없음 — 필요시 추가).

**스케줄 상태 (status) — 5종 + 클릭 사이클 (2026-05-04 추가)**:
- 값: `not_started` / `in_progress` / `pending` / `blocked` / `done`
- 사이클 순서 (리스트의 상태 칩 클릭 시):
  `in_progress → pending → blocked → done → not_started → in_progress`
- 알 수 없는 값 → 사이클 첫 항목(`in_progress`)으로 진입
- 색상: not_started = 점선 outline / in_progress = 노랑 / pending = 회색 / blocked = 빨강 / done = 초록
- 편집 모달의 select 에서도 같은 5종 선택 가능. 단, 상태 변경만 원할 땐 칩 클릭이 더 빠름. 계획 / 일수 변경은 편집 모달 사용.
- DB: 원래 4값 CHECK 제약이 걸려 있었으나 5종 추가를 위해 마이그레이션으로 CHECK 를 제거 (검증은 app 레이어 `STATUSES` Set 으로). 향후 새 상태 추가는 코드만 고치면 됨 (DDL 변경 불필요).

**드래그 동작 의미**:
- 막대 가운데를 끌면 → planned_start 와 planned_end 가 함께 시프트 (duration 보존). 일정을 통째로 이동.
- 막대 우측 6px 핸들을 끌면 → planned_end 만 변경 (duration 늘리기/줄이기).
- 손 놓으면 PUT → 엔진 캐스케이드 → 결과 alert. 막대는 사용자가 끌어놓은 planned 위치에 그대로 머무름.

**한국 공휴일 자동 갱신 (2026-05-04 추가, 다중 소스 / 15:16 보강)**:
- 서버 모듈 `src/holidays.js` 가 `data/holidays.json` 캐시 파일 관리.
  - `auto`: 두 소스 합집합. 서버 부팅 시 + `setInterval` 24h 마다 fetch.
    1. **`date.nager.at`** — 깔끔한 JSON, 빠름. 정규 공휴일과 대체공휴일은 정확하지만 임시공휴일 반영이 늦음.
    2. **Google Calendar 한국 휴일 ICS 피드** — 임시공휴일(예: 2025-06-03 대통령선거)을 빠르게 반영. ICS 의 `DESCRIPTION:공휴일` 항목만 채택 (어버이날·스승의날·크리스마스이브 같은 기념일은 `DESCRIPTION:기념일\n…` 으로 분류되어 자동 제외).
  - `manual`: 사용자가 `data/holidays.json` 의 `manual` 배열을 직접 편집해 추가하는 항목. 매일 fetch 가 `auto` 만 갱신하므로 `manual` 항목은 보존됨.
- 갱신 정책: 서버 부팅 시 1회 + `setInterval` 24h 간격 자동 + `POST /api/holidays/refresh` 수동.
- 모든 fetch 가 실패해도 기존 캐시를 유지 (네트워크 단절 안전). 한 소스만 실패해도 다른 소스로 계속 동작.
- 클라이언트는 부팅/`refreshAll` 시점에 `loadServerHolidays()` 로 `SERVER_HOLIDAYS` Set 채움. `isHoliday(date) = KOREAN_HOLIDAYS ∪ SERVER_HOLIDAYS`. 하드코딩 Set 은 오프라인 / 첫 fetch 실패 시 안전망.
- 임시공휴일 추가 절차 (Google ICS 가 늦게 반영하는 극단적 케이스):
  1. `data/holidays.json` 의 `manual` 배열에 `"YYYY-MM-DD"` 추가
  2. 서버 재시작 또는 `POST /api/holidays/refresh`
- 알려진 차이점: Google 은 제헌절을 `DESCRIPTION:공휴일` 로 마크하지만 법적으로는 2008년 이후 공휴일이 아님. 캘린더상 빨간색으로 표시되는 것은 무방하다고 판단해 그대로 둠.

**전체 리포트 뷰 — 그룹화 규칙 (2026-05-04 추가, 12:21 정렬 보정)**:
사이드바 **📋 전체 리포트** 버튼 → 모든 카테고리의 모든 리포트를 한 화면에 표시.
- **1단계 그룹**: 카테고리 (id 오름차순). 한 리포트가 N개 카테고리에 태그되어 있으면 N번 표시됨 (각 섹션마다).
- **2단계 그룹**: 날짜 (**ASC, 오래된 날짜가 위**). 예: 4/30 기록이 5/4 기록보다 위.
- **3단계 (같은 날짜 안)**: `id ASC` (= 작성 순서 ASC). 먼저 올린 리포트가 위, 나중에 올린 리포트가 아래. → 그 날 안의 시간 흐름이 위→아래로 자연스럽게 읽힘.
- **항목**: 본문(한 줄 미리보기) + 첨부 칩(`📎` 업로드 / `📁` 로컬 경로) + 다른 카테고리 태그(현재 섹션 외).
- **클릭** → 편집 모달 (per-category 뷰의 행 클릭과 동일한 흐름).
- **검색** (`#all-reports-search`): 본문 / 날짜 / 카테고리 태그 이름 부분 일치.
- 카테고리 태그가 없는 리포트는 "태그 없음" 가상 섹션에 따로 표시.

**행(스케줄) 순서 — 컴포넌트 단위 위상정렬 (2026-05-04, 21:00 보강)**:
1. **연결 컴포넌트 식별** (undirected, strong-edges only) — 강한 연결로 묶인 항목들이 한 컴포넌트.
2. **컴포넌트 안에서 Kahn 위상정렬** — 선행 위, 후행 아래.
3. **컴포넌트끼리는 `min(planned_start)` 로 정렬** — 시작이 빠른 컴포넌트(체인 또는 단일 항목) 가 위로.

따라서 동시에 만족:
- "강한 연결끼리 가깝게" — 한 컴포넌트는 절대 흩어지지 않음.
- "시작이 빠를수록 위" — 컴포넌트 단위 시작일 비교.
- weak 엣지는 컴포넌트 식별·정렬 모두에서 무시 (방향성 없는 형제 표식).

예: PCB(4/25), DISPLAY-Camera-Phone 체인(min 4/30), APPLE(5/4), 배송(6/18) → 순서 PCB → DISPLAY+Camera+Phone (체인) → APPLE → 배송. 체인 내부는 DISPLAY/Camera (in-degree 0) 가 위, Phone 이 아래.

리스트(테이블) 뷰는 기존 날짜순(`planned_start ASC`) 유지. 컴포넌트 정렬은 간트에만 적용.

**Shift/Alt + 클릭 의존성 생성 + Cmd/Ctrl+Z 되돌리기 (2026-05-04 추가, 21:21 키 변경)**:
- 간트 막대를 **Shift + 클릭** → 첫 번째 막대 선택 (오렌지 outline) + 상단 배너 표시 ("강한 연결 (Shift): …→ ?").
- 다른 막대를 그대로 클릭 → 첫 → 두 번째 방향으로 **strong 의존 생성** (POST `/api/dependencies`).
- **Alt + 클릭** 은 동일하지만 **weak 의존**.
- **ESC** 또는 같은 막대 두 번째 클릭 → 취소.
- 드래프트 모드 동안 다른 막대들은 `cursor: crosshair`. 드래그·리사이즈는 이 모드에서 발동 안 됨 (modifier 가 우선).
- 사이클·중복 등 검증 실패시 alert. 기존 +의존성 추가 모달은 그대로 유지 — 두 입력 방식 공존.

**왜 Ctrl 이 아니라 Shift 인가**: macOS 의 Ctrl+클릭은 브라우저가 contextmenu(우클릭) 로 해석해 mousedown 이전에 컨텍스트 메뉴 이벤트로 가로챔. 이 때문에 우리 핸들러까지 도달하지 않음. Shift 는 안전하게 mousedown 까지 통과.

**Undo / Redo (2026-05-04, 21:30 확장)**:
대상으로 추적하는 액션 (모두 메모리 stack):
- `dep-create` — Shift/Alt-클릭으로 만든 의존성. Undo: DELETE / Redo: 같은 payload 로 POST (새 id 가 생기면 record 내부 갱신).
- `schedule-update` — 간트 막대 드래그·우측 핸들 리사이즈로 일정 변경(주황 cascade 발생 포함), 그리고 상태 칩 클릭 사이클. Undo: 이전 값으로 PUT / Redo: 이후 값으로 PUT.
- 새 액션이 push 되면 redoStack 비움 (표준 undo/redo 시맨틱).

키:
- **Undo**: `Cmd+Z` (mac) / `Ctrl+Z` (win/linux)
- **Redo**: `Cmd+Shift+Z` (mac) / `Ctrl+Shift+Z` 또는 `Ctrl+Y` (win/linux) — 두 가지 모두 지원

가드:
- input/textarea/select/contentEditable 에 포커스 있을 땐 텍스트 편집 undo 를 막지 않기 위해 통과.
- 새로고침 시 stack 초기화 (영구화 안 함).
- 적용 실패(이미 삭제된 id, cycle 충돌 등)는 record 를 그냥 drop. 사용자에겐 alert 안 띄움 — 재시도 안전.

추적 안 하는 액션 (의도): 편집 모달 저장(명시적 작업), 카테고리/스케줄 삭제(파괴적), 리포트 작성/삭제, 첨부 추가/삭제. 필요해지면 같은 record 패턴으로 확장 가능.

---

## 5. 프로젝트 구조 (예정)

```
project_planner/
├── md/
│   └── PROJECT_LOG.md       (이 문서)
├── package.json
├── data/
│   └── planner.db
├── uploads/
├── src/
│   ├── server.js
│   ├── db.js
│   ├── routes/
│   │   ├── categories.js
│   │   ├── schedules.js
│   │   ├── dependencies.js
│   │   └── reports.js
│   └── engine/
│       ├── scheduler.js
│       └── slack.js
└── public/
    ├── index.html
    ├── styles.css
    └── app.js
```

---

## 6. Phase 계획

### Phase 1 — 뼈대 + 카테고리/스케줄 CRUD (의존성 없이) ✅ 완료
- [x] `package.json`, 의존성 설치 (`express`, `better-sqlite3`)
- [x] Express 서버 + SQLite 초기화 (`src/server.js`, `src/db.js`)
- [x] 카테고리 CRUD API (`src/routes/categories.js`)
- [x] 스케줄 CRUD API (`src/routes/schedules.js`)
- [x] 최소 UI (`public/index.html`, `styles.css`, `app.js`) — 카테고리 사이드바 + 스케줄 리스트 + 추가/편집/삭제 모달
- [x] 스모크 테스트: health, CRUD, 검증(409 중복 이름, 400 날짜 역전), cascade 삭제 확인

#### Phase 1 산출 API
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스체크 |
| GET / POST | `/api/categories` | 목록 / 생성 |
| GET / PUT / DELETE | `/api/categories/:id` | 단건 / 수정 / 삭제 (cascade) |
| GET / POST | `/api/schedules` | 목록(`?category_id=`) / 생성 |
| GET / PUT / DELETE | `/api/schedules/:id` | 단건 / 수정 / 삭제 |

#### Phase 1 실행 방법
```bash
cd /Users/shkim/PycharmProjects/project_planner
npm start                # 또는 npm run dev (--watch)
# → http://localhost:3000
```

### Phase 2 — 의존성 ✅ 완료
- [x] `dependencies` 테이블 + 다형 키 (`pred_type` × `succ_type` ∈ {schedule, category})
- [x] Strong 의존 + 자동 밀기 (`auto_shift`) — 폭(duration) 보존하며 후행 actual_start/end 시프트, BFS 캐스케이드
- [x] 충돌 경고 모드 (`warn_only`) — 시프트하지 않고 `cascade.conflicts[]` 로 응답에 첨부
- [x] Weak 의존 + slack 계산/표시 (현재는 schedule↔schedule 명시적 weak 엣지 기반)
- [x] **추가**: 사이클 검출 (직접 사이클 + 컨테이너/포함 사이클 + 자기참조)
- [x] **추가**: 엔티티 삭제 시 의존성 자동 정리 (다형 키라 FK 제약 사용 불가 → 라우트에서 DELETE)
- [x] **추가**: GET `/api/schedules` 응답에 `slack_days` 필드 포함
- [x] UI: 의존성 추가/삭제 모달 + 의존성 패널 + slack 컬럼 + 캐스케이드/충돌 알림(alert)
- [x] 스모크 테스트: 핸드폰 시나리오 (auto_shift 4일 캐스케이드 / weak 4일 slack / warn_only 충돌 메시지 / 카테고리 레벨 의존 7일 캐스케이드 / 사이클 검출 / 자기참조 / 컨테이너 사이클 / 삭제 시 dep 정리)

#### Phase 2 산출 API
| Method | Path | 설명 |
|---|---|---|
| GET / POST | `/api/dependencies` | 목록 / 생성 (단일 엣지 — 편집 모달이 사용) |
| **POST** | **`/api/dependencies/triple`** | **현재 앵커 폼이 사용. `current` + 선택적 `pred`/`succ` 를 받아 1~2개 엣지를 한 트랜잭션으로 생성. 한 엣지라도 검증 실패면 둘 다 롤백.** |
| GET / PUT / DELETE | `/api/dependencies/:id` | 단건 / 수정 / 삭제 |
| POST | `/api/recompute` | **계획 갱신** — 전체 일정 재계산 (수동 트리거) |
| GET | `/api/holidays` | 한국 공휴일 합집합 (auto + manual). 클라이언트가 간트 색칠에 사용 |
| POST | `/api/holidays/refresh` | 즉시 외부 fetch + 캐시 갱신 (응답으로 갱신된 set 반환) |

스케줄 생성/수정 응답 형태 변경:
```json
// 이전: { ... schedule fields ... }
// 이후:
{
  "schedule": { ..., "slack_days": 4 },
  "cascade": {
    "shifted":  [{ "type":"schedule|category", "id":N, "label":"…",
                    "delta_days":4, "new_start":"…", "new_end":"…" }],
    "conflicts":[{ "type":"…", "id":N, "label":"…",
                    "current_start":"…", "required_min_start":"…",
                    "predecessor_label":"…" }]
  }
}
```

### Phase 3 — 리포트 ✅ 완료
- [x] `reports` / `report_categories` / `attachments` 테이블 추가 (FK ON DELETE CASCADE)
- [x] 리포트 CRUD + 카테고리 다중 태그 (N:N)
- [x] 카테고리 필터링 (`GET /api/reports?category_id=N`)
- [x] 첨부 — 업로드 (`multer` + `./uploads/`) / 로컬 경로 (DB에 절대경로만 저장)
- [x] 리포트 삭제 시 업로드된 디스크 파일 정리 (best-effort `fs.unlink`)
- [x] UI: 카테고리 화면 하단에 리포트 패널, 리포트 모달, 첨부 관리 (파일 업로드 / 로컬 경로 / 삭제 / 클립보드 복사)
- [x] 스모크 테스트: 다중 태그, 업로드 200 OK 서빙, 로컬 경로, 검증 400, 삭제 cascade + 디스크 정리

#### Phase 3 산출 API
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/reports` | 리포트 목록 (옵션 `?category_id=`, `?date=`) |
| POST | `/api/reports` | 리포트 생성 (`{report_date, body, category_ids: [...]}`) |
| GET / PUT / DELETE | `/api/reports/:id` | 단건 / 수정(부분) / 삭제 |
| POST | `/api/reports/:id/attachments/upload` | multipart/form-data, field=`file` |
| POST | `/api/reports/:id/attachments/local` | JSON `{path, display_name?}` |
| DELETE | `/api/attachments/:id` | 첨부 삭제 (업로드면 디스크에서도 제거) |
| GET | `/uploads/<filename>` | 업로드된 파일 서빙 |

### Phase 4 — UX 개선 (v1 + v2 + v3 + v4 완료)
- [x] 간트 차트 (카테고리 화면에 리스트/간트 토글) — v1
- [x] 드래그로 일정 변경 + 우측 핸들 리사이즈 — v1
- [x] 간트 막대 클릭 → 편집 모달 — v1+
- [x] 검색 (제목 부분 일치, 리스트/간트 동시 적용) — v1
- [x] 오늘 표시 — v1
- [x] **전체 간트** (모든 카테고리 통합 보기, 카테고리 색 표식) — v2
- [x] **연결 포함 토글** (선택 카테고리와 의존성으로 연결된 다른 항목까지, 추이적 BFS, weak/strong 모두) — v2
- [x] **의존성 화살표** — strong 솔리드+화살표머리 / weak 점선. 카테고리 endpoint 는 가장 늦게 끝나는 pred 와 가장 빨리 시작하는 succ 를 자동 선택. 토글로 ON/OFF — v3
- [x] **리포트 검색** — 본문 / 날짜 / 카테고리 태그 이름 부분 일치 — v3
- [x] **간트 시각 안정화** — 막대 위치를 planned 기준으로 그려서 사용자가 끌어놓은 곳에 머무름. 엔진이 actual 을 다르게 조정하면 막대 아래에 얇은 오렌지 띠로 표시 — v4
- [x] **간트 행 위상정렬** — strong 의존이 있는 항목은 선행 위 / 후행 아래, 고립 항목은 맨 아래 — v4
- [x] **전체 리포트 뷰** — 사이드바 "📋 전체 리포트" 버튼 → 카테고리별 → 날짜별로 묶어 한 눈에. 한 리포트가 여러 태그를 가지면 각 카테고리에 표시. 본문/날짜/태그 검색, 첨부 칩, 클릭 시 편집 모달 — v4

---

## 7. 타임라인 (변경/진행 누적 로그)

> 새 항목은 **위쪽**에 추가합니다. 각 항목은 `[YYYY-MM-DD HH:MM] 태그 — 내용` 형식.
> 태그: `REQ`(요구사항) / `PLAN`(계획) / `DECIDE`(결정) / `PROGRESS`(진행) / `CHANGE`(변경)

### 2026-05-05 16:00 · CHANGE — 다른 PC 이식 준비 (PORT/HOST + engines + README)
사용자 요청: Windows / Ubuntu 24 LTS 다른 PC 로 옮길 준비.

#### 구현
- **PORT/HOST 환경변수** (`src/server.js`):
  - PORT 는 기존에 이미 `process.env.PORT || 3000` 처리되어 있었음 (확인).
  - HOST 추가 — 기본 `127.0.0.1` (단일 사용자 안전), `0.0.0.0` 으로 두면 LAN 노출.
  - listen 메시지가 호스트 별로 분기, 0.0.0.0 일 때는 LAN 접근 가능 안내 한 줄 추가.
- **package.json**:
  - `engines.node: ">=20"` 추가 — 너무 옛 Node 사용 시 npm 이 경고.
- **README.md** 신규 작성:
  - 처음 실행, 환경변수 표, 데이터 위치, 다른 PC 로 옮기기 (Git/압축), Ubuntu/Windows 사전 준비, 가져가지 말 것, 백업 절차, 단축키 요약.
  - 한국어로 작성.

#### 검증
- 기본 (PORT 미설정): `127.0.0.1:3000` 바인딩, 메시지 정상.
- `PORT=4001 HOST=0.0.0.0`: 새 포트로 LAN 노출 메시지와 함께 정상.
- 기본으로 복원도 정상.

### 2026-05-05 15:30 · CHANGE — 🟡 안전망 강화 4건 + 🔵 사소 정리
이전 검토(14:30)에서 보고된 안전망 4건 + 사소 정리 일부 진행.

#### 안전망 강화 (🟡 4건)
1. **트랜잭션 통합 — 의존성 라우트 + 스케줄/카테고리 DELETE** (`src/routes/dependencies.js`, `schedules.js`, `categories.js`):
   - 기존: insert/update/delete 와 cascade(`recomputeFromScheduleChange`) 가 트랜잭션 밖 → 중간 실패 시 부분 커밋 위험.
   - 수정: POST / POST `/triple` / PUT / DELETE 모두 하나의 `db.transaction(() => {...})` 안에서 mutation + cascade 실행. cascade 가 내부에서 또 트랜잭션을 시작해도 better-sqlite3 가 자동으로 SAVEPOINT 사용하므로 안전. 카테고리 DELETE 의 외부 이웃 조회도 트랜잭션 안으로 통합 (read-then-delete 일관성).
2. **local_path 첨부 검증** (`src/routes/attachments.js`):
   - 기존: 사용자가 보낸 경로 문자열을 trim 만 하고 그대로 저장 — 상대경로/`..`/NUL 바이트 통과.
   - 수정: `validateLocalPath()` 헬퍼 — 1) 비어있지 않음, 2) 1024자 이내, 3) NUL 없음, 4) `path.isAbsolute()`. 사용자 의도 ("공유 드라이브 절대 경로") 와 일치.
   - 에러 코드: `path_not_absolute`, `path_too_long`, `path_invalid`, `path_required`.
3. **holidays.js 깨진 JSON 처리** (`src/holidays.js`):
   - 기존: `await res.json()` 가 SyntaxError 던지면 일반 catch 가 `e.message` 만 로깅 — "JSON 파싱 실패" 인지 구분 어려움.
   - 수정: `res.json()` 만 별도 try 로 감싸 `malformed JSON: <reason>` 으로 명시적 메시지. 동작 변화 없음, 진단성 개선.
4. **reports.js ID 배열 명시 coerce** (`src/routes/reports.js`):
   - 기존: `Number.isInteger(cid)` 만 검사 — JSON 의 number 면 OK 지만 클라이언트가 문자열 `"3"` 보내면 실패.
   - 수정: `normalizeIdArray(arr, existsStmt, arrayErr, itemErr)` 헬퍼 — `Number()` 로 coerce 후 `Number.isInteger` 검증, FK 존재 확인. POST/PUT 둘 다 적용.

#### 사소한 정리 (🔵)
- **topbar phase-badge 제거** (`public/index.html`, `public/styles.css`): "Phase 4 v4 · 전체 리포트 / 위상정렬" 라벨이 정보 가치 없어짐. HTML 요소 + 관련 CSS 룰 모두 제거.
- **PROJECT_LOG 헤더 "현재 단계" 갱신**: "안정화 — SS 시맨틱 / 자동 cascade / 신 리포트 모델 / 코드 검토 후속 정리 진행 중".

#### 사소한 정리 (추가)
- **임시 md 파일 삭제**: `md/260504_150030_작업내용.md` 가 프로젝트 무관 텍스트로 확인되어 사용자 승인 후 삭제. md/ 디렉토리는 이제 PROJECT_LOG.md 만 남음.

#### 검증 (HTTP 종단 + 영향받는 라우트)
- **dep POST + cascade**: A(4/15) ← B(4/13) strong/auto_shift → A.actual = 4/13 (pull). ✓
- **dep DELETE + cascade rollback**: 같은 dep 삭제 → A.actual = 4/15 (planned 로 reset). ✓
- **string ID coerce**: `category_ids: ["5"]` POST → 정상 처리, categories 5 정상 저장. ✓
- **local_path traversal**: `../etc/passwd` → 400 `path_not_absolute`. ✓
- **local_path absolute**: `/Users/shkim/Documents/foo.pdf` → 201. ✓
- 클라이언트 escape JSON 검증 통과, 모든 테스트 정상.

### 2026-05-05 14:50 · CHANGE — 🟠 코드 정합성 4건 fix
이전 검토(14:30)에서 보고된 코드 정합성 항목 4건 모두 수정.

#### 변경 내역
1. **escapeHtml 중복 제거** (`public/app.js`):
   - L113 (정통 — `s ?? ''` 으로 null/undefined 안전), L2563 (중복 — `String(s)` 만 사용해 null 처리 약함) 두 곳에 정의되어 있던 것 중 후자 제거. 두 함수가 호출되는 컨텍스트는 모두 동일 모듈 내라 첫 번째 정의가 모든 호출에 충분.
2. **죽은 CSS 룰 제거** (`public/styles.css`):
   - `.gantt-bar.shifted-pred { background: #22c55e; }` 제거. JS 어디서도 `shifted-pred` 클래스를 부여하지 않음.
   - 동시에 인접 코멘트의 modifier 표기 "Ctrl/Alt" → "Cmd/Ctrl" (현재 정책과 일치).
3. **report-meta-box 코멘트 갱신** (`public/index.html`):
   - "Hidden when entering the modal via the '+ 리포트 작성' button (legacy entry point)" 라는 옛 진입점 언급 제거. 현재는 그 버튼이 없고 진입점은 간트 막대 클릭 1개. 코멘트를 새 모델에 맞게 재작성 (legacy schedule 없는 리포트 = 5/5 마이그레이션 후 없음).
4. **strong/weak 라벨 명확화** (`public/index.html`):
   - 두 개의 의존성 모달 (dependency-modal, dependency-create-modal) 의 `link_type` select 옵션:
     - `strong (자동 밀기/경고)` → `strong (필수: 후행은 선행 이후 시작)` — SS 시맨틱 직접 표현.
     - `weak (여유 표시만)` → `weak (참고: 여유 표시만)` — 명확화.
   - on_delay 옵션 `auto_shift (자동 밀기)` → `auto_shift (자동 정렬)` — SS 모델에서 "밀기" 보다 "정렬" 이 정확.

#### 검증
- `node --check public/app.js` 통과.
- 클라이언트 변경만이라 서버 재시작 불요.

### 2026-05-05 14:30 · REVIEW — 대대적 코드 검토 + 🔴 우선순위 4건 fix
3개 영역 (백엔드 무결성/검증, 프론트엔드 코드/UX, 도메인 일관성) 에 대해 병렬 Explore 에이전트 검토 진행. 단일 사용자/로컬 환경에서 critical 데이터 손실/보안 결함은 없음. 발견 항목은 코드 청결성/UX 일관성/안전망 강화 수준. 결과는 사용자에게 요약 보고됨.

#### 즉시 진행 항목 (사용자 영향 직접) — 모두 수정 완료
1. **ESC 핸들러 통합** (`public/app.js`):
   - 기존: dep-draft 와 dateFocus 가 동시에 활성이면 ESC 한 번에 dep-draft 만 풀림 → 사용자가 sticky 모드 빠져나왔다고 착각.
   - 수정: ESC 가 두 모드 모두 같이 해제. 모달 열려있으면 dateFocus 는 모달 ESC 우선이라 보존.
2. **reportLinkedSchedule 명시적 클리어** (`public/app.js` `closeReportModal`):
   - 기존: `hideReportMetaBox` 가 부수효과로 클리어해서 동작은 OK 였지만 의도가 함수명에 안 보임.
   - 수정: `closeReportModal` 첫 부분에 `state.reportLinkedSchedule = null` 명시.
3. **빈 리포트 안내 문구 갱신** (`public/app.js`):
   - 기존: '리포트가 없습니다. "+ 리포트 작성"으로 시작하세요.' — 그 버튼은 5/5 13:30 에 제거됨 → 안내가 막다른 길.
   - 수정: '간트의 날짜를 클릭한 뒤 막대를 클릭해 작성하세요.' — 현재 워크플로우와 일치.
4. **gantt-conn-banner z-index 조정** (`public/styles.css`):
   - 기존: banner z-index=1000, modal z-index=100 → dep-draft 활성 상태에서 모달 열면 banner 가 모달 위로 침범.
   - 수정: banner z-index=50 — 일반 콘텐츠 위(z≤5), 모달 아래. 모달 닫히면 다시 보임.

#### 검토에서 보고된 보류 항목 (🟠/🟡)
- 코드 정합성: `escapeHtml` 함수 중복 정의, `.gantt-bar.shifted-pred` 죽은 CSS 룰, index.html 의 옛 버튼 언급 코멘트, 의존성 모달의 strong 라벨 오해 소지.
- 안전망: dependency PUT/DELETE 가 트랜잭션 밖, attachments local_path 검증, holidays.js JSON 파싱 에러, reports 라우트 ID 검증 명시화.
- 사소: topbar phase-badge 텍스트, 임시 md 파일 정리.

이들은 단일 사용자/로컬 환경에서 우선순위 낮음. 추후 시간 날 때.

### 2026-05-05 13:30 · CHANGE — 카테고리 패널의 "+ 리포트 작성" 버튼 제거
사용자 보고: 4월 7일 리포트에 스케줄 제목이 안 보임 → DB 확인 결과 카테고리 패널의 "+ 리포트 작성" 버튼으로 작성된 schedule 연결 없는 orphan. 사용자가 해당 리포트 삭제 후 동일 문제 재발 방지를 위해 버튼 자체 제거.

#### 구현
- `public/index.html` — `#add-report-btn` 제거.
- `public/app.js` — `els.addReportBtn` 바인딩 + 클릭 핸들러 제거.
- 결과: 리포트 작성 진입점은 간트 헤더 날짜 클릭 → 막대 클릭 으로 일원화. schedule 연결 없는 리포트가 더 이상 생기지 않음.

### 2026-05-05 13:00 · CHANGE — 모든 변경 라우트가 자동 cascade + "계획 갱신" 버튼 제거
사용자 의문: "계획 갱신" 버튼이 의미가 있나?

#### 진단
- 해법 Z (component reset+cascade) 도입 후 `recomputeFromScheduleChange` 가 schedule 변경 시 잔재를 자동 정리.
- 그러나 다른 변경 라우트들은 cascade 미발동 → 잔재 발생 케이스:
  1. 스케줄 삭제: 옛 의존을 통해 끌려있던 다른 schedule 의 actual 잔존.
  2. 카테고리 삭제: 카테고리 endpoint 의존이 끊겨도 외부 schedule 의 actual 잔존.
  3. 의존성 추가/수정/삭제: 즉시 시각화 안 됨 + 옛 의존이 끌고 있던 actual 잔존.
- 이 셋이 "계획 갱신" 의 진짜 활용처. 라우트가 자동 cascade 하면 버튼 불필요.

#### 구현
- `src/routes/schedules.js` DELETE:
  - `strongNeighborScheduleIds(schedule)` 헬퍼 — 삭제 대상의 strong-edge 이웃 schedule id 들 (직접/카테고리 endpoint 양쪽) 수집.
  - 삭제 전 이웃 캐시 → 삭제 후 각 이웃에 `recomputeFromScheduleChange` 호출.
- `src/routes/categories.js` DELETE:
  - 외부(다른 카테고리) schedule 중 이 카테고리/멤버에 strong 으로 묶인 것을 SQL 로 수집 → 카테고리 cascade 삭제 후 각자 recompute.
- `src/routes/dependencies.js`:
  - `endpointScheduleId(type, id)` + `recomputeForEndpoints([...])` 헬퍼.
  - POST: 새 엣지의 양 끝 recompute.
  - POST `/triple`: 생성된 모든 엣지의 양 끝 recompute.
  - PUT: 옛+새 엔드포인트 4개 recompute (엣지 재배치 시 양쪽 정리).
  - DELETE: 삭제 전 엣지 조회 → 양 끝 recompute (이미 갈라진 component 도 양쪽 정리).
- `public/index.html`: `#recompute-btn` 제거.
- `public/app.js`:
  - `els.recomputeBtn` 바인딩 제거.
  - 클릭 핸들러 + 핸들러 안의 `POST /api/recompute` 호출 제거.
  - `refreshAfterHistoryAction` 의 `POST /api/recompute` 호출 삭제 (이제 PUT/DELETE 가 자동 cascade 하므로 불요). 주석을 새 모델에 맞게 갱신.
- `POST /api/recompute` 서버 라우트는 보존 (디버그/안전망 용; 클라이언트 호출 없음).

#### 검증 (HTTP 종단)
- 검사를 3/31 로 끌어 공수 actual 을 3/31 로 당긴 상태에서 검사 삭제 → 공수 actual = planned (4/2~4/4) 로 reset. ✓
- 테스트 schedule A(4/10~4/12), B(4/8~4/10) 생성 후 A→B strong/auto_shift 의존 추가 → A actual = 4/8~4/10 으로 즉시 pull. ✓
- 같은 의존 삭제 → A actual = planned (4/10~4/12) 로 reset. ✓
- 테스트 schedule 정리 (DELETE) 도 정상.

### 2026-05-05 11:30 · CHANGE — 전체 리포트에 스케줄 막대 표시
사용자 요청: 전체 리포트의 각 항목 위에 연결된 스케줄 제목을 간트 막대 스타일 (카테고리 색 배경 + 흰 글자) 로 표시. 카테고리 그룹 구조는 그대로 유지.

#### 구현
- `public/app.js` `renderAllReportsView` — 각 리포트 li 내 본문 위에 `.report-item-schedules` div 추가, `r.schedules` 배열을 순회해 카테고리 색 배경의 `.schedule-pill` 들로 렌더.
- `public/styles.css` — `.schedule-pill` 정의 (radius 4px, padding 2px/10px, font-weight 600), `.report-item-schedules` 는 flex-wrap.
- 레거시 (schedules 연결 없는 옛 리포트) 는 pill 영역 자체를 출력하지 않음.

### 2026-05-05 11:00 · PROGRESS — 일일 리포트 신모델 (날짜 클릭 → 막대 클릭 → 리포트)
사용자 요청:
1. 매번 카테고리 패널에서 리포트 작성하는 것이 번거로움.
2. 간트 헤더 날짜 클릭 → 그 날짜에 걸리는 막대만 강조 (sticky).
3. 강조된 막대 클릭 → 리포트 입력 (카테고리 + 스케줄 + 날짜 자동 연결).
4. 모달 저장 후에도 sticky 유지 → 같은 날짜의 다른 스케줄 연속 입력.
5. 리포트는 schedule.id 로 직접 연결 (텍스트 매칭 fragile).
6. 같은 (스케줄, 날짜) 리포트가 이미 있으면 그 리포트 열기.
7. 기존 리포트는 모두 삭제 (모델 변경).

#### 결정
- **report_schedules 다대다 신설**. report ↔ schedule 직접 FK 관계.
- 기존 reports 행은 1회성 마이그레이션으로 모두 삭제 (`schema_migrations` 센티넬). 첨부 DB 행은 CASCADE 로 같이 삭제, uploads/ 의 파일 자체는 보존 (디스크 청소는 별도 작업).
- sticky 모드 동안 hover 강조는 비활성화 (`if (state.dateFocus) return` in mouseenter). 해제 시 자동 복귀.

#### 구현
- **DB** (`src/db.js`):
  - `report_schedules (report_id, schedule_id)` PK + FK CASCADE.
  - `schema_migrations (name, applied_at)` 센티넬 테이블.
  - 마이그레이션 `reports_schedule_link_v1` — 한 번만 실행, `DELETE FROM reports` (CASCADE).
- **서버** (`src/routes/reports.js`):
  - `report_schedules` insert/delete/get prepared statements 추가.
  - GET 에 `?schedule_id=N` 필터 추가.
  - decorate 가 `schedules` 배열 포함.
  - POST/PUT 이 `schedule_ids` 받음 + `scheduleExists` 검증.
- **프론트** (`public/app.js`, `public/index.html`, `public/styles.css`):
  - `state.dateFocus` (YYYY-MM-DD | null) + `state.reportLinkedSchedule` ({schedule, date} | null).
  - 헤더 셀에 `dataset.date`, click → `onDateCellClick(date)` (토글/스위치/해제).
  - `.gantt-grid.date-focus-active` 클래스로 막대 디밍 (`opacity 0.18`), 범위 매칭 막대에 `.date-focus-hit` 클래스로 정상 opacity.
  - 헤더 셀에 `.date-selected` 클래스 (배경 노란빛 강조).
  - `attachBarHoverHighlight` 가 sticky 활성 시 즉시 return → hover 강조 무력화.
  - `attachBarDragHandlers` mousedown 진입 시 sticky 면 drag/connection 모두 차단, 매칭 막대만 `openReportModalForDateAndSchedule` 호출.
  - 새 함수 `openReportModalForDateAndSchedule(date, schedule)`: GET `?schedule_id=&date=` 로 기존 리포트 조회, 있으면 편집 모드, 없으면 새 모달 (date + category + schedule 자동 prefill).
  - 새 함수 `renderReportMetaBox(schedule, date)`: 카테고리/제목/기간/일수/상태/설명/날짜를 read-only 박스로 모달 상단에 표시.
  - 폼 submit 시 `state.reportLinkedSchedule` 있으면 `schedule_ids: [schedule.id]` 페이로드에 추가.
  - ESC 핸들러 — 모달이 열려있지 않을 때만 sticky 해제.
  - `closeReportModal` 이 `hideReportMetaBox` 호출 + `state.reportLinkedSchedule` 클리어 (sticky 는 유지).
  - 모달 백드롭 클릭 시 reportModal 만 `closeReportModal()` 통해 닫도록 정리.
- **CSS** (`public/styles.css`):
  - `.report-meta-box` 스타일 (회색-청 박스, `meta-row/label/value`, `schedule-cat-pill`).
  - `.gantt-grid.date-focus-active` 디밍/포커스 규칙 + 호버 무력화.
  - `.gantt-day` cursor pointer, `.date-selected` 강조.

#### 검증
- 마이그레이션 실행 — 서버 재시작 시 로그 `[db] migrating reports: wiping legacy reports`. reports/report_schedules/attachments 모두 0 행.
- POST `/api/reports` with `schedule_ids: [32]` → 정상 생성, `schedules` 배열에 검사 메타 동봉.
- GET `?schedule_id=32&date=2026-04-05` → 그 리포트 1건 정확 반환.
- DELETE → CASCADE 로 report_schedules 행도 같이 삭제.

### 2026-05-05 00:30 · CHANGE — 화살표 원복 + cascade 잔재 자동 복구 (해법 Z)
사용자 보고:
1. 새 SS 화살표 그리기 (left→left, lift→drop) 가 보기 싫음 → 이전 right→left manhattan 으로 원복.
2. 검사를 선행보다 빠른 날짜로 옮겨 선행이 주황색이 됐다가, 검사를 다시 정상 위치로 옮겨도 선행이 주황 그대로 → 파랑으로 복귀해야 함.

#### 진단
- (1) 단순 원복.
- (2) 근본 원인: `recomputeFromScheduleChange` 가 증분 패스라 한 번 당겨진 actual 을 원위치로 되돌리는 로직이 없음. binding 이 풀려도 옛 actual 잔존.

#### 결정
- 사용자 직관: "내가 만진 schedule 과 그 선행만 다시 계산". → **해법 Z** (strong-connected component 부분 reset + cascade) 채택. 옵션 X/Y (recomputeAll 호출) 는 무관한 다른 컴포넌트까지 reset 해 부담.

#### 구현
- `public/app.js`:
  - `pickPredScheduleId` 카테고리 endpoint 분기를 `bestRight` 기준으로 원복.
  - `drawOne` 화살표 path 를 `pred.right → succ.left` manhattan + off=6 로 원복.
- `src/engine/scheduler.js`:
  - `collectStrongComponentSchedules(startScheduleId)` 헬퍼 추가 — strong 엣지 (양방향, schedule + category endpoint 모두) 를 따라 BFS, 도달 가능한 모든 schedule id 수집. 카테고리 endpoint 는 `expandToScheduleIds` 로 그 카테고리의 스케줄들로 펼침.
  - `recomputeFromScheduleChange(id)`:
    1. component BFS → 트랜잭션으로 component 멤버들의 `actual = planned` reset.
    2. 기존 backward + forward pass 진행.
  - 다른 컴포넌트의 actual 은 안 건드림.

#### 검증
- 종단 테스트 (HTTP PUT 통해):
  - 공수 4/2~4/4, 검사 4/4~4/7 (a=p) 초기.
  - 검사 → 3/31 PUT → cascade 공수 -2일 → 공수 actual=3/31~4/2 (≠ planned 4/2~4/4) → 공수 주황. ✓
  - 검사 → 4/2 PUT → component {32, 29} reset → backward not binding → 공수 actual=planned=4/2~4/4 → **공수 파랑 복귀**. ✓
  - 검사 → 4/8 PUT (선행 뒤로 멀리) → 동일하게 공수 파랑 복귀. ✓
- in-process 시뮬과 종단 결과 일치.

#### 운영 노트
- 직전 보고된 "검사 → 4/3 으로 옮겨도 공수 주황" 문제의 진짜 원인은 dev 서버가 SS 변경 전 (FS) 코드를 메모리에 들고 있던 것. 이번 수정에 맞춰 서버 재시작 필요. 코드 수정 후 항상 `kill <pid>` + `node src/server.js` 재시작.

### 2026-05-04 23:30 · CHANGE — strong = SS (Start-to-Start) 시맨틱 + 그룹 드래그 + modifier 재배치
사용자 요청 누적:
1. 강한 연결을 "끝나야 시작 (FS)" 이 아니라 "선행 시작일 ≤ 후행 시작일 (SS)" 로 통일.
2. 후행 드래그 시 선행을 자동으로 끌어당기되 (auto_shift), planned 는 안 건드리고 actual + 주황 표시.
3. Shift+드래그 = 1단계 strong 선행도 함께 이동 (그룹 이동).
4. 강한 연결 modifier 를 Cmd(mac)/Ctrl(win)+클릭, 약한 연결을 Opt/Alt+클릭 으로 변경.

#### 결정
- 옵션 C (FS/SS 둘 다) 대신 **분기 1: SS 단일 모델** 채택. dep_type 컬럼 추가 불요. 모든 strong 엣지가 SS 시맨틱.
- "추월" 정의: succ.start < pred.start 일 때만. 추월 발생 시 backward pull (auto_shift) 로 선행 actual 만 당겨 주황 표시.

#### 구현
- `src/engine/scheduler.js`:
  - 헤더 주석 SS 정의로 갱신.
  - `requiredMinStart`: `MAX(pred.actual_end) + 1` → `MAX(pred.actual_start)`.
  - `backwardPass`: 종료일 기준 binding/pull 로직을 시작일 기준으로 재작성. binding 조건 `pStart > current`, pull 시 delta = `current - pStart` (선행을 후행 시작일로 끌어옴).
  - `forwardPass`: 식 변경 없음 (`requiredMinStart` 가 새 식이라 자동으로 SS).
- `public/app.js`:
  - `attachBarDragHandlers`:
    - modifier 분기를 `e.shiftKey` → `e.metaKey || e.ctrlKey` (강), `e.altKey` (약) 으로 교체.
    - `e.shiftKey` 는 그룹 드래그 트리거 — `directStrongSchedulePredecessors` 헬퍼로 1단계 직속 strong-schedule 선행을 찾아 같은 delta 로 함께 시프트.
    - 그룹 멤버 막대에 `.dragging .group-extra` 클래스 부여 (대시 outline 으로 시각 표시).
    - mouseup 시 그룹은 `saveScheduleGroupFromGantt(moves)` 로 일괄 PUT.
  - `saveScheduleGroupFromGantt`: 각 멤버 PUT 후 단일 `schedule-update-batch` undo record push. 마지막 cascade 만 reportCascade.
  - `applyUndoRecord` / `applyRedoRecord`: `schedule-update-batch` kind 처리 추가.
  - `showDepConnBanner`: 라벨을 OS 별로 (mac=Cmd/Opt, win=Ctrl/Alt).
  - `pickPredScheduleId`: 카테고리 endpoint 일 때 "right 가 가장 큰" → "**left 가 가장 큰**" 으로 변경 (SS 에서 binding 은 가장 늦게 시작하는 pred).
  - 화살표 geometry: pred.right → succ.left 의 manhattan path → **pred.left → succ.left** 로 변경. 동일 시작일이면 수직 drop, 그렇지 않으면 lift → run → drop 형태로 후행 위에서 진입. 막대 본체와 안 겹치도록 head 가 `enterY = succ.midY - barH/2 - 2` 에서 멈춤.
- `public/styles.css`: `.gantt-bar.group-extra { outline: 2px dashed #1f5fc9 }` 추가.

#### 검증 (트레이스)
- 공수 4/2~4/4, 검사 4/5~4/8 (strong, auto_shift). 검사를 4/3 으로 드래그 → backward: 공수.start(4/2) ≤ 검사.start(4/3) → not binding → no-op. 공수 그대로. ✓
- 같은 상태에서 검사를 4/1 으로 드래그 → backward: 공수.start(4/2) > 4/1 → binding, delta = -1 → 공수 actual = 4/1~4/3, planned 그대로 → 공수 막대 주황 + overlay. ✓
- 검사를 Shift+드래그로 -2일 → 공수 막대도 같이 -2일, mouseup 시 두 schedule 모두 planned PUT, batch undo. ✓
- `node --check public/app.js`, `node --check src/engine/scheduler.js` 통과.

### 2026-05-04 22:45 · CHANGE — undo/redo 후 cascade 완전 복원
사용자 보고:
> 검사를 4/8 로 당기면 (backward pull 로) 입고가 주황색 + overlay 가 됨. undo 하면 검사는 4/10 으로 돌아오는데 입고는 주황 상태 그대로 → undo 가 cascade 결과까지 되돌리지 못함.

#### 진단
- `recomputeFromScheduleChange` 는 "필요할 때만 밀고/당기는" 증분 패스 (`if (required <= current) continue`). 한 번 당겨진 actual 을 원위치로 되돌리는 로직이 없음.
- 사용자 시나리오: 검사 4/8 → 입고 actual 이 4/7 까지 당겨짐. undo PUT(검사=4/10) 후 recompute 가 돌지만 입고 ← 검사 의 binding 조건이 이미 충족되어 (4/9 +1 ≤ 4/10) "건드릴 필요 없음" 으로 통과. 입고는 4/7 인 채로 남음.

#### 결정
- undo/redo 는 본질적으로 "이전 시점의 일관된 상태로 되돌리기" 이므로, 단일 schedule 증분 recompute 가 아니라 **`recomputeAll`** (모든 actual 을 planned 로 snap → 의존성 다시 적용) 을 호출해야 정합성이 보장됨.

#### 구현
- `public/app.js` `refreshAfterHistoryAction()`:
  - 진입 즉시 `POST /api/recompute` 호출. 실패는 non-fatal (catch & continue).
  - 이후 schedules / dependencies 리로드 + 렌더 — 기존 그대로.
- 결과: undo 후 모든 막대가 깨끗한 상태(주황/overlay 모두 사라짐)로 복원.

#### 비용
- 매 undo/redo 마다 전체 recompute. 단일 사용자 / 로컬 SQLite 환경 + 일반적 스케줄 규모(수십~수백)에서 무시 가능.

### 2026-05-04 22:30 · CHANGE — 호버 시 무관한 막대도 흐려지게
사용자 요청: "바 호버일 때 화살표만 진해지는데, 막대도 동일하게 처리해줘."

#### 구현
- `public/app.js` `attachBarHoverHighlight`:
  - `resolveEndpointScheduleIds(type, id)` 헬퍼로 dep 엔드포인트(스케줄/카테고리)를 schedule id 집합으로 환산.
  - mouseenter: hovered 막대 + 관련 dep 의 양 끝 schedule id 들로 `focusIds` Set 구성 → 해당 막대들에 `.bar-focus` 부여, grid 에 `.hover-active` 부여.
  - mouseleave: 두 클래스 모두 제거.
  - `bar.closest('.gantt-grid')` 로 grid 핸들 안전하게 획득 (단일/전체 간트 모두 동일 동작).
- `public/styles.css`:
  - `.gantt-bar` 에 `transition: opacity 0.15s` 추가.
  - `.gantt-grid.hover-active .gantt-bar { opacity: 0.2; }`, `.bar-focus { opacity: 1; }`.

### 2026-05-04 22:20 · CHANGE — 전체 간트 진입시 자동 활성화
사용자 요청: "전체 간트 진입 시 항상 화살표 ON / 체인정렬 ON / 간트 뷰 활성화. 정리 안 된 상태로 들어가면 별로니까."

#### 구현
- `public/app.js` `selectAllView()`:
  - `state.scheduleView = 'gantt'`, `state.showArrows = true`, `state.chainSort = true` 강제.
  - `viewBtns` 의 active 클래스를 `data-view === 'gantt'` 인 것으로 동기화.
  - `showArrowsBtn` / `chainSortBtn` 의 active + 라벨 갱신.
- localStorage 에는 쓰지 않음 — 카테고리별 선호도가 새로고침 후에도 유지되도록.

### 2026-05-04 22:10 · PROGRESS — 체인정렬 토글 (chain-first topo)
사용자 보고:
> 강한 연결끼리 (예: 센서공수 → 센서검사) 인접 행에 두고 싶다. 다대일 병합점(여러 검사 → 카메라조립)이 있는 경우도 보기 쉽게.

#### 진단
- 기존 `topoSortForGantt` 는 컴포넌트 단위 묶기까지는 됐지만, 컴포넌트 내부 Kahn 정렬이 FIFO 라 형제 체인이 평탄화됨. 결과: `센서공수 / 렌즈공수 / 하우징공수 / 센서검사 / 렌즈검사 / 하우징검사 / 조립` 처럼 같은 사슬의 pred-succ 가 떨어져 화살표만 길어짐.

#### 결정
- **DFS-우선 선택 알고리즘** 으로 컴포넌트 내부 정렬을 분기. 토글 OFF 면 기존 FIFO Kahn, ON 이면 chain-first.
- chain-first 규칙: 방금 빼낸 노드의 직속 후행 중 in-deg 0 이 된 것을 다음에 빼냄. 후보 다수면 `planned_start` 빠른 것. 체인 연장이 불가능할 때만 ready 풀에서 가장 빠른 시작일을 픽.
- 결과 시뮬: `센서공수→센서검사→렌즈공수→렌즈검사→하우징공수→하우징검사→조립`. 각 pred-succ 쌍이 인접 두 줄에 떨어짐.

#### 구현
- `public/index.html`: `#chain-sort-btn` 추가 (화살표 토글 옆).
- `public/app.js`:
  - `state.chainSort` 추가, localStorage `'chainSort'` 로 영속화.
  - 버튼 클릭 → 상태/라벨/저장/렌더 갱신.
  - `topoSortForGantt`: 컴포넌트 내부 정렬을 if-else 로 분기 — chain-first 분기에서 ready Set + lastEmitted 추적, 직속 후행 우선 / 시작일 fallback.
  - `startOf(id)` 헬퍼로 미정 일정은 `'9999-12-31'` 처리해 안전.

#### 검증
- `node --check public/app.js` 통과.
- 위 시뮬레이션 트레이스로 알고리즘 결과 확인.

### 2026-05-04 21:55 · CHANGE — 화살표를 막대 아래로
사용자 요청: "화살표가 바 위로 보이는 것이 싫어."

#### 구현
- `public/styles.css`:
  - `.gantt-arrows` 에 `z-index: 0`.
  - `.gantt-bar` 에 `z-index: 1`.
- 결과: 막대 위에 그려지던 화살표 머리/선이 막대 뒤로 깔림. 막대 사이의 빈 공간에서만 화살표가 보임.

### 2026-05-04 21:50 · CHANGE — 간트 화살표 가시성 (카테고리 색 + 호버 포커스)
사용자 보고:
> 간트차트의 화살표가 전부 같은 색이라 겹치면 어떻게 연결되는지 알기 어려움.

#### 분석
- 기존: 모든 화살표가 단일 파란색(#1f5fc9). pred-succ 쌍이 다수 겹칠 때 어느 선이 어느 의존성인지 추적 불가.
- 막대(bar)는 이미 카테고리 색 띠를 가짐 → 화살표를 **선행(pred)의 카테고리 색**과 일치시키면 시각적 연속성 확보.
- 색만으로 부족할 수 있음 → 막대 호버 시 **무관 화살표는 흐려지고(opacity 0.12), 관련 화살표만 강조** 하는 인터랙션 추가.

#### 구현
- `public/app.js`:
  - `categoryColorFor(type, id)` 헬퍼 추가 — 의존성 엔드포인트(스케줄/카테고리)를 카테고리 색으로 환산. 누락 시 기본 파랑.
  - `drawDependencyArrows`:
    - 단일 marker → **색별 marker 동적 생성** (`markerByColor` Map, `ensureMarker(color)`). 화살표 머리 색이 선과 일치.
    - 각 path 에 `dataset.depId` + `arrow-strong` / `arrow-weak` 클래스 부여 (호버 룩업 + CSS 훅).
    - stroke 색은 `categoryColorFor(d.pred_type, d.pred_id)` — 선행의 카테고리 색.
  - `isDepRelatedTo(dep, schedule)` — pred/succ 가 직접 schedule 매치 또는 schedule.category_id 매치인지 판정.
  - `attachBarHoverHighlight(bar, schedule)`:
    - mouseenter → `.gantt-arrows` 에 `hover-active` 추가 + 관련 path 에 `arrow-focus` 추가.
    - mouseleave → 두 클래스 모두 제거.
  - 렌더 루프(`renderGantt`)에서 `attachBarDragHandlers` / `attachBarResizeHandlers` 와 함께 호출.
- `public/styles.css`:
  - `.gantt-arrows path` 기본 opacity 0.85, transition.
  - `.gantt-arrows.hover-active path` opacity 0.12, `.arrow-focus` opacity 1 + stroke-width 2.5.

#### 검증
- `node --check public/app.js` 통과.
- 동작: 카테고리 색이 다른 의존성 다발이 겹쳐도 색으로 분리 식별 가능. 호버 시 한 번에 한 막대의 의존 그래프만 강조됨.

### 2026-05-04 21:30 · PROGRESS — undo/redo 확장 (드래그·상태·의존성 + redo 키)
사용자 요청:
1. undo 대상에 **간트 막대 드래그로 발생한 일정 변경**(주황 shifted 포함) 도 포함.
2. redo 의 표준 키와 그 키 지원.

#### 결정
- **다중 record 모델**로 확장. 기존 raw id stack 을 폐기하고 `{kind, ...}` 객체 record 로:
  - `kind: 'dep-create'` — `{id, payload}`. Undo: DELETE / Redo: payload 로 POST (new id 로 record 갱신).
  - `kind: 'schedule-update'` — `{id, before, after}`. before/after 는 `{planned_start, planned_end}` 또는 `{status}` 의 부분 집합. Undo: PUT before / Redo: PUT after.
- 추적 시점: 간트 드래그/리사이즈(`saveScheduleFromGantt`), 상태 칩 사이클, Shift/Alt-클릭 dep 생성.
- redo 표준 키 — Mac: `Cmd+Shift+Z`, Win/Linux: `Ctrl+Y` 가 가장 흔하고 `Ctrl+Shift+Z` 도 통용. **세 가지 다 지원**.

#### 구현
- `public/app.js`:
  - `state.undoStack`/`state.redoStack` 둘 다 record 배열.
  - `saveScheduleFromGantt(id, plannedStart, plannedEnd)`: PUT 호출 전 `findScheduleById` 로 before snapshot 확보, 변경 있으면 record push + redoStack 비움.
  - status 칩 핸들러: 동일 패턴 (status 만 담는 record).
  - dep-create POST 후: `{kind:'dep-create', id, payload}` 로 push.
  - `applyUndoRecord(record)` / `applyRedoRecord(record)` — kind 별 분기, 실패시 false 반환.
  - `performUndo` / `performRedo` — pop → apply → 상대 stack 에 push (성공 시) → `refreshAfterHistoryAction()`.
  - `refreshAfterHistoryAction()` — allSchedules + dependencies + 현재 카테고리 schedules 모두 reload + render.
  - keydown:
    - `Cmd/Ctrl + Shift + Z` 또는 `Cmd/Ctrl + Y` → redo
    - `Cmd/Ctrl + Z` (Shift 미동반) → undo
    - input/textarea 등에 포커스 있을 땐 통과 (텍스트 편집 보호)

#### 검증
- 코드 grep 으로 `performUndo`, `performRedo`, `applyUndoRecord`, `applyRedoRecord`, `state.redoStack`, kind 두 종류 모두 와이어링 확인.
- HTTP 시뮬: PCB 일정을 PUT 으로 변경 → 다시 PUT 으로 복원 → 둘 다 정상 (drag → undo 시뮬과 동일 흐름).

#### §4.7 갱신
- "Cmd/Ctrl + Z 로 되돌리기" 섹션을 "Undo / Redo (확장)" 으로 재작성. record kind / 키 / 가드 / 추적 안 하는 액션 명시.

### 2026-05-04 21:21 · CHANGE — modifier 키 Ctrl→Shift + Cmd/Ctrl+Z undo
사용자 보고:
1. Ctrl+클릭이 작동 안 함. Shift 로 변경 요청.
2. 단축키로 만든 연결을 Cmd/Ctrl+Z 로 되돌리고 싶음.

#### 분석
- Ctrl+클릭 미작동 원인: macOS 의 Ctrl+클릭은 브라우저 정책상 contextmenu(우클릭) 이벤트로 변환됨 — mousedown 보다 먼저 발동되어 우리 핸들러로 들어오지 않음. 윈도우/리눅스에서도 일부 환경에서 비슷한 충돌 가능. Shift 가 cross-platform 으로 안전.

#### 구현
- `attachBarDragHandlers`: `e.ctrlKey || e.metaKey` → **`e.shiftKey`** 만 체크. Alt 는 유지.
- `state.undoStack = []` 추가. `handleBarConnectionClick` 에서 POST 성공 직후 `state.undoStack.push(created.id)`.
- 글로벌 `keydown`:
  - `Cmd/Ctrl + Z` (Shift 미동반) → `undoStack.pop()` → DELETE → 재로드.
  - `isTypingTarget(target)` 으로 input/textarea/select/contentEditable 안에서 칠 때는 통과 (텍스트 편집 undo 보호).
- 배너 텍스트도 `(Shift)` / `(Alt)` 로 키 명시.
- 새로고침 시 undoStack 초기화. 영구화 X — "방금 단축키로 만든 거" 만 즉석에서 되돌리는 용도.

#### 검증
- POST + DELETE 흐름 정상 (id=41 생성, DELETE 204, 재시도 404).
- 코드 grep 으로 `e.shiftKey` / `state.undoStack` / `metaKey || ctrlKey` 모두 와이어링 확인.

#### §4.7 갱신
- "Ctrl/Alt + 클릭" → "Shift/Alt + 클릭" 으로 키 변경 + "왜 Ctrl 이 아닌가" 메모 추가.
- "Cmd/Ctrl + Z 로 되돌리기" 동작 명시 (스택 휘발성 / typing 가드 / Shift+Z redo 미구현).

### 2026-05-04 21:00 · PROGRESS — 간트 조작성·가시성 강화
사용자 두 요청:
1. 의존성 추가 모달이 일일이 누르기 번거로움. **Ctrl + 첫 막대 → 두 번째 막대 클릭** 으로 strong 연결, **Alt + …** 로 weak 연결.
2. 간트 정렬이 카테고리/전체에서 다르게 느껴짐. 더 일관되게 + **강한 연결끼리 가깝게**.

#### 1) Ctrl/Alt-클릭 의존성 생성
- `state.depDraft = {scheduleId, linkType}` 가 첫 막대를 누른 순간 셋팅.
- `attachBarDragHandlers` 가 mousedown 시점에 `e.ctrlKey || e.metaKey` (strong) / `e.altKey` (weak) 를 먼저 검사 — modifier 누른 채면 드래그 셋업 건너뛰고 `handleBarConnectionClick(schedule, linkType)`.
- 첫 클릭: state.depDraft 채우고 body 에 `dep-drafting` 클래스 + 상단 배너 표시 + renderSchedules 로 첫 막대에 `dep-draft-first` outline.
- 두 번째 클릭: `POST /api/dependencies` (`pred=첫, succ=두 번째, link_type=첫의 modifier 결과`) → loadDependencies → 재렌더. 실패시 사용자 친화 메시지.
- ESC / 같은 막대 두 번 / 배너 "취소" 버튼 → `cancelDepDraft`.
- HTML: `<div id="gantt-conn-banner">` (fixed top center, 오렌지). CSS: `.dep-draft-first { outline: 3px solid #f59e0b }`, `body.dep-drafting .gantt-bar { cursor: crosshair }`.
- 기존 "+ 의존성 추가" 3-슬롯 모달은 그대로 유지 — 사용자 선호에 따라 두 방식 공존.

#### 2) 간트 정렬 알고리즘 재작성
- **Before**: Kahn's 위상정렬 + 고립 항목 맨 뒤 (chain 들이 입력 순서대로 끼어들기 가능).
- **After**: **연결 컴포넌트 → 내부 위상정렬 → 컴포넌트끼리 minStart 정렬**:
  1. strong-edges 의 *undirected* 그래프에서 BFS 로 연결 컴포넌트 식별. weak edges 무시.
  2. 각 컴포넌트 안에서 directed Kahn 위상정렬 (선행 위, 후행 아래).
  3. 각 컴포넌트의 `min(planned_start)` 계산 후 그 키로 컴포넌트들을 ASC 정렬.
- 만족하는 두 규칙:
  - "강한 연결끼리 가깝게" — 한 컴포넌트는 절대 흩어지지 않음.
  - "시작이 빠를수록 위" — 컴포넌트 단위 시작일 비교.

#### 검증 (Node 단위)
사용자 데이터 (PCB 4/25, 디스플레이/카메라/핸드폰 체인 minStart 4/30, APPLE 5/4, 배송 6/18) 로:
```
순서:  PCB → DISPLAY → Camera → Phone → APPLE → 배송
       ^^^   ^^^^^^^^^^^^^^^^^^^^^^^^^   ^^^^^   ^^^^
       단일   체인(컴포넌트 그룹화 + 내부 위상정렬)   단일   단일
```
체인 내부는 in-degree 0 인 DISPLAY·Camera 가 위, Phone 이 아래. ✓

#### §4.7 갱신
- "행 순서 — 컴포넌트 단위 위상정렬" 으로 표기 갱신.
- "Ctrl/Alt + 클릭 의존성 생성" 영구 섹션 신설.

### 2026-05-04 20:24 · CHANGE — 테이블 컬럼 너비 고정 + 드래그 조정 + 영구화
사용자 요청: 카테고리를 옮길 때마다 테이블 컬럼 너비가 들쭉날쭉해 산만함. 고정 너비로 시작하되, 사용자가 직접 끌어 조정도 가능해야 함. 전체 간트 리스트와 카테고리 리스트 둘 다 동일.

#### 결정
- 대상 3개 테이블: 스케줄(`#schedule-table`) / 의존성(`#dependency-table` 신규 id) / 리포트(`#report-table` 신규 id). 모두 `class="schedules resizable"`.
- **고정 너비 초기값**: 각 `<th>` 에 `style="width: Xpx"` 인라인. `table-layout: fixed` 로 콘텐츠 길이 영향 X.
- **드래그 조정**: 각 `<th>` 의 우측 6px 영역에 `col-resize-handle` 부착. mousedown→mousemove 로 px 단위 조정, mouseup 에 commit.
- **지속**: 조정 후 모든 컬럼 너비 배열을 `localStorage["colwidths:{tableId}"]` 에 저장. 페이지 로드 시 저장값이 인라인 default 를 덮어쓴다. 카테고리 전환·새 세션에도 동일 너비 유지.

#### 구현
- `public/index.html`: 3개 테이블에 `class="resizable"` + 모든 `<th>` 에 `style="width: Xpx"` 인라인 추가. `dependency-table` / `report-table` 에 id 부여.
- `public/styles.css`:
  - `.schedules.resizable { table-layout: fixed; }` + `th { position: relative; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }`.
  - `.col-resize-handle` (절대위치 우측 6px, hover 시 파란 하이라이트).
- `public/app.js`:
  - `loadColWidths(tableId)` / `saveColWidths(tableId, widths)` localStorage 헬퍼.
  - `makeTableResizable(tableEl)`: 저장값 적용 → 각 th(마지막 제외) 에 핸들 부착 → 드래그 핸들러로 px 조정 + 마지막에 widths 배열 저장. idempotent (같은 th 에 핸들 중복 부착 안 함).
  - 페이지 부팅 시 `document.querySelectorAll('table.schedules.resizable').forEach(makeTableResizable)`. 각 테이블 단 한 번 초기화.

#### §4.7 갱신
- "테이블 컬럼 너비" 영구 섹션 신설 (대상 테이블 / 고정 초기값 / 드래그 조정 / localStorage 지속 / 리셋 방법).

#### 동작 검증 가능 항목 (브라우저)
- 새로고침 후 두 카테고리를 번갈아 봐도 같은 너비
- 드래그 후 새로고침해도 그 너비 유지
- 다른 카테고리에서도 같은 너비 (테이블당 하나의 widths 배열을 공유)

### 2026-05-04 15:59 · BUGFIX — 전체 간트의 status 사이클이 한 번만 동작하던 회귀
사용자 보고: 전체 간트 list 모드에서 APPLE LOT #000 의 상태 칩을 클릭해도 한 번만 바뀌고 그 다음부터 동일 상태에서 멈춤. 카테고리 뷰에선 5종 모두 정상 사이클.

#### 원인
클릭 핸들러가 schedule 을 lookup 할 때 `state.schedules` (per-category 캐시) 를 먼저 보고 있었음. 흐름:
1. 사용자가 디스플레이 카테고리에 들어감 → `loadSchedules(4)` 가 `state.schedules` 에 APPLE 의 status='in_progress' 캐시.
2. 사용자가 전체 간트로 전환. `selectAllView` 는 selectedCategoryId 만 null 로 설정하고 state.schedules 는 그대로.
3. 클릭 1: lookup 이 state.schedules 에서 APPLE(stale)을 찾음 → status='in_progress' → next='pending' → PUT.
4. PUT 후 `loadAllSchedules()` 만 reload (selectedCategoryId 가 null 이라 loadSchedules 는 skip). state.schedules 는 여전히 'in_progress'.
5. 클릭 2: lookup 이 또 state.schedules 의 stale 'in_progress' 를 봄 → next='pending' (변화 없음) → PUT 'pending' (이미 'pending') → DB 변화 없음 → 사용자 입장에선 멈춘 것처럼 보임.

서버 동작은 정상 (5종 모두 PUT 통과). 순수 클라이언트 lookup 우선순위 결함.

#### 수정 (`public/app.js`)
1. **lookup 우선순위 반전**: `findScheduleById(id)` 헬퍼 신설. `state.allSchedules` (PUT 후 항상 reload 되는 canonical 소스) 를 먼저 보고, 그 다음에야 state.schedules. 핸들러 두 곳에서 사용 (status 칩 클릭, 편집/삭제 버튼).
2. **방어**: `selectAllView()` 에서 `state.schedules = []` / `state.reports = []` 로 비움 — per-category 캐시가 all-view 에서 의미 없으니 stale 상태로 남겨두지 않음.

#### 검증
- 서버: APPLE(id=27) 에 5종 status 모두 PUT 통과 ✓
- 클라이언트 lookup 헬퍼 + selectAllView 캐시 비우기 적용 grep 확인 ✓

### 2026-05-04 15:54 · CHANGE — 의존성 패널에 "현재" 컬럼 + 유형·충돌 인라인 토글
사용자 요청:
1. 의존성 패널의 컬럼이 `선행 → 후행` 두 칸인데, 카테고리 뷰의 입장에서 보면 한 쪽은 "현재(이 카테고리)" 다. **현재** 컬럼을 가운데 두고 양쪽에 선행/후행을 배치해 사용자의 시각을 그대로 반영.
2. `유형` (link_type) 과 `충돌 시` (on_delay) 셀이 그냥 라벨만 있는데, 칩처럼 클릭으로 토글되면 편집 모달을 열 필요가 없어 효율적.

#### 결정 / 구현
- **3-위치 컬럼**: `선행 | → | 현재 | → | 후행 | 유형 | 충돌 시 | (편집/삭제)` 8 컬럼.
- **현재 자동 판정**: 각 dep 의 pred/succ 중 어느 쪽이 현재 카테고리에 속하는지 `entityIsInCurrentCategory(type, id)` 헬퍼로 판정. succ 만 in-current → pred=선행/succ=현재, pred 만 in-current → pred=현재/succ=후행, 둘 다 in-current → pred=현재/succ=후행 (내부 dep).
- **카테고리 컨텍스트 포함 라벨**: `entityFriendlyLabel(type, id)` — 카테고리는 `📁 이름`, 스케줄은 `카테고리명 / 스케줄제목` 으로 표기. 어느 카테고리 소속인지 한눈에 보이도록.
- **유형 칩 클릭** → `cycle-link` data-action. `strong ↔ weak` PUT 으로 즉시 토글.
- **충돌 시 칩 클릭** → `cycle-delay` data-action. `auto_shift ↔ warn_only` PUT 으로 토글. link_type=weak 일 땐 `—` 만 표시되어 클릭 대상 아님.
- 두 칩 모두 `cursor:pointer` + hover 시 살짝 어두워짐 (이미 status-pill 에 도입한 패턴과 동일).

#### 변경 파일
- `public/index.html`: 의존성 테이블 헤더 `<th>선행</th><th></th><th>현재 (이 카테고리)</th><th></th><th>후행</th><th>유형</th><th>충돌 시</th><th></th>`.
- `public/styles.css`: `.link-pill, .delay-pill` 에 `cursor:pointer; user-select:none; transition; :hover` 추가.
- `public/app.js`:
  - `entityIsInCurrentCategory`, `entityFriendlyLabel` 신규 헬퍼.
  - `renderDependencies` 가 prevCell/curCell/nextCell 을 위 분기 규칙대로 채움. 화살표 `→` 도 빈 칸엔 안 그림.
  - `dependencyRows` 클릭 핸들러에 `cycle-link` / `cycle-delay` 분기 추가. PUT 후 `loadDependencies()` + `renderDependencies()`.

#### 검증
- HTML 헤더 8개 그대로 적용 ✓
- JS 심볼 모두 존재 (`entityFriendlyLabel`, `entityIsInCurrentCategory`, `cycle-link`, `cycle-delay`) ✓
- PUT `link_type=strong→weak` → 200, weak 으로 변경 + 응답에 반영 ✓
- weak 상태에선 `delay-pill` 영역이 `—` 로 클릭 불가 ✓ (data-action 미부여)

#### §4 갱신
- §4.4-2 "의존성 패널 표시 규칙" 영구 섹션 신설 (3-위치 컬럼 / 현재 판정 분기 / 라벨 포맷 / 인라인 토글).

### 2026-05-04 15:46 · CHANGE — 스케줄 상태 5종 + 클릭 사이클
사용자 요청: 스케줄 행의 "상태" 칩을 클릭하면 다음 상태로 즉시 변경되도록. 새 상태 `not_started` 추가. 사이클 순서: `in_progress → pending → blocked → done → not_started → ...`. (계획·일수는 신중해야 하니 편집 모달, 상태는 가벼운 작업이라 칩 클릭으로 통일.)

#### 결정 / 구현
- **DB 마이그레이션**: 원래 `schedules.status` 에 `CHECK (status IN ('pending','in_progress','done','blocked'))` 가 있어 신규 값을 못 넣음. SQLite 는 CHECK 를 in-place 로 못 바꾸므로 startup 에서 sqlite_master 검사 후 schedules 테이블을 재생성(같은 컬럼·인덱스, CHECK 제거). 검증은 `src/routes/schedules.js` 의 `STATUSES = {not_started, in_progress, pending, blocked, done}` Set 이 담당.
- **UI**:
  - `renderSchedules` 의 status td 안 `<span class="status-pill ${s.status}" data-action="cycle-status" ...>` 로 칩이 클릭 가능한 컨트롤이 됨.
  - `STATUS_CYCLE = ['in_progress', 'pending', 'blocked', 'done', 'not_started']`. 알 수 없는 값이면 첫 항목으로 fallback.
  - 클릭 핸들러: PUT `/api/schedules/:id` `{status: next}` → `loadAllSchedules` + (해당 카테고리면) `loadSchedules` → `renderSchedules`. cascade 발생할 일은 없음 (status 변경은 일정에 영향 없음).
- **CSS**:
  - `.status-pill` 에 `cursor: pointer; user-select: none;` + `:hover` 옅은 톤 변화.
  - `.status-pill.not_started` — 점선 outline 으로 시작 전 상태를 시각 구분.
- 편집 모달 `<select name="status">` 에도 not_started 옵션 추가 (사이클 순서대로 정렬).

#### 검증
| 검증 | 결과 |
|---|---|
| DB 스키마: schedules 테이블의 CHECK 제거됨 | ✓ (sqlite_master 의 sql 에 CHECK 부재) |
| PUT /api/schedules/:id 에 5개 status 모두 통과 | ✓ |
| 잘못된 status (예: "foo") | 400 invalid_status ✓ |
| 기존 데이터 보존 (in_progress 등) | ✓ (마이그레이션 시 INSERT INTO ... SELECT 로 그대로 복사) |

#### §3·§4.7 갱신
- §3 데이터 모델의 status enum 표기를 5종 + 사이클 순서로 갱신.
- §4.7 에 "스케줄 상태 — 5종 + 클릭 사이클" 영구 섹션 추가 (값/순서/색상/마이그레이션 메모).

### 2026-05-04 15:37 · PROGRESS — 의존성 입력 UX 개편 ("현재 앵커 / 선행·후행" 3-슬롯 폼)
사용자 제안: 카테고리 뷰의 "+ 의존성 추가" 에서 **현재(앵커) 를 기준으로 선행과 후행을 한꺼번에 또는 한쪽만** 선택해 등록. 검증을 입력 단계에서 차단(드롭다운에서 자동 제외)해 서버 에러를 보지 않게.

#### 결정 (사용자와 합의)
1. **현재 자동 prefill**: 현재 카테고리 = 현재 카테고리 (또는 그 안의 스케줄로 좁힐 수 있음). 다른 카테고리로 옮길 수 없음.
2. **link_type / on_delay 공유** (v1, 두 엣지에 같은 값 적용. 분리 제어가 필요해지면 v2).
3. **편집 모드는 기존 2-슬롯 그대로**. 의존성 1행 = 1 엣지라 앵커 개념 의미 없음.
4. **검증 (드롭다운에서 자동 제외)**:
   - 선행 옵션에서 "현재" 항목 제외.
   - 후행 옵션에서 "현재" 항목 제외.
   - 선행에서 한 항목을 고르면 후행 드롭다운에서 그 항목이 사라짐 (반대도 동일).
   - 컨테이너 관계도 자동 제외 (스케줄 ↔ 그 스케줄이 속한 카테고리).
5. **트랜잭션**: 두 엣지 중 하나라도 검증 실패(cycle/duplicate/container)면 둘 다 롤백.

#### 구현
- `src/routes/dependencies.js`: `POST /api/dependencies/triple` 신규.
  - `current`(필수) + `pred`/`succ`(둘 다 nullable, 단 둘 중 하나는 있어야) + `link_type`/`on_delay`.
  - `db.transaction()` 안에서 각 엣지를 생성 직전에 `validateDependencyPayload` 호출. 두 번째 엣지의 사이클 검사는 첫 엣지가 이미 트랜잭션에 INSERT 된 상태에서 수행되므로 **두 엣지의 조합으로 새로 생기는 사이클도 잡힘**. 실패 시 throw → SQLite 가 자동 롤백.
- `public/index.html`: 새 모달 `<div id="dependency-create-modal">` (3-슬롯 fieldset 구조). 기존 `<div id="dependency-modal">` 은 편집 전용으로 유지.
- `public/styles.css`: `.dep-side` (fieldset 박스), `.dep-side.current` (앵커 강조 — primary 색 보더 + 옅은 배경).
- `public/app.js`:
  - "+ 의존성 추가" 버튼 핸들러를 `openDependencyCreate()` 로 변경. (편집은 그대로 `openDependencyModal(dep)`.)
  - 헬퍼 `entitiesInRelation(typeA, idA, typeB, idB)` — 동일/컨테이너 관계 판정.
  - `entityOptionsExcluding(type, exclusions)` — 옵션 리스트 생성하면서 제외.
  - `depCreateRefresh()` — current/pred/succ 셀렉트가 바뀔 때마다 다른 두 셀렉트의 옵션을 재계산.
  - `submit` → `POST /api/dependencies/triple`. 성공시 모달 닫고 `refreshAll`. 실패시 사용자 친화적 에러 + 어느 쪽 엣지에서 발생했는지(`pred → current` / `current → 후행`) 표시.

#### 검증
| 시나리오 | 기대 | 결과 |
|---|---|---|
| 카메라(5) → 핸드폰(6) → 배송(23) (둘 다 선택) | 2개 엣지 생성 | ✓ |
| 핸드폰(6) → 배송(23) 만 (succ 만) | 1개 엣지 생성 | ✓ |
| 카메라(5) → 핸드폰(6) 만 (pred 만) | 1개 엣지 생성 | ✓ |
| 둘 다 비움 | 400 `no_edge` | ✓ |
| 사이클 (A→B 존재 상태에서 current=A, pred=B 시도) | 400 `cycle_detected` (첫 엣지 INSERT 안 됨) | ✓ |

#### §4 갱신
- §4.4-1 "의존성 입력 폼 정책 — 현재 앵커 / 선행·후행" 영구 섹션 신설 (입력 vs 편집 모달 구분, 드롭다운 필터링 규칙, 트랜잭션 안전성).
- §6 API 표에 `/api/dependencies/triple` 추가.

### 2026-05-04 15:16 · CHANGE — 공휴일 두 번째 소스 추가 (Google ICS) — 임시공휴일 자동 감지
사용자 보고: 2025-06-03 (대통령선거 임시공휴일) 이 빨간색으로 안 보임. 이런 임시공휴일을 자동으로 잡을 방법 필요.

#### 분석
- `date.nager.at` 은 정기 공휴일과 대체공휴일은 정확히 갖고 있으나 임시공휴일 (예: 선거임시공휴일, 대통령 발표 임시휴무) 반영이 늦거나 누락.
- Google Calendar 의 공식 한국 공휴일 캘린더 (`ko.south_korea#holiday@group.v.calendar.google.com`) ICS 피드를 직접 받아보니 **2025-06-03** 포함 + 임시공휴일을 빠르게 반영하는 편. 다만 같은 피드에 **어버이날(5/8), 스승의날(5/15), 크리스마스이브(12/24), 기타 기념일** 도 섞여 있어 그대로 쓰면 안 됨.
- 다행히 ICS 의 `DESCRIPTION` 필드가 명확히 구분: 진짜 공휴일은 `DESCRIPTION:공휴일`, 비공식 기념일은 `DESCRIPTION:기념일\n기념일을 숨기려면 ...` 으로 표기. → 파싱 시 `DESCRIPTION:공휴일` 만 채택하면 됨.

#### 구현
- `src/holidays.js`:
  - 상수 `GOOGLE_ICS_URL` 추가, 기존 `SOURCE_URL` 을 `NAGER_URL` 로 이름 정리.
  - `fetchYearKR_nager(year)` (기존 동작) + `fetchAllKR_googleICS(yearWindow)` 신규.
  - `fetchAllKR_googleICS`: 응답을 `BEGIN:VEVENT` 단위로 split, 각 블록에서 `DTSTART(;VALUE=DATE)?:` 와 `DESCRIPTION:` 추출. `^공휴일` 으로 시작하는 항목만 채택 (한글 문자에 `\b` 가 안 먹혀 prefix-only). `yearWindow` 로 [현재년-1, 현재년+1] 범위 제한.
  - `refresh()` 가 두 소스 결과를 union. 콘솔에 `[holidays] refreshed: N unique dates (nager=X, google=Y)` 로 기여도 출력. 한 소스가 실패해도 다른 쪽으로 진행.

#### 검증
| 검증 항목 | 결과 |
|---|---|
| 서버 로그 | `refreshed: 60 unique dates (nager=45, google=59)` |
| **2025-06-03 (대통령선거 임시공휴일)** | **포함됨 ✓** |
| 어버이날 5/8, 스승의날 5/15, 크리스마스이브 12/24 — 비공식 기념일은 제외 | 모두 제외 ✓ |
| 정기 공휴일 (1/1, 5/5, 5/25, 6/6, 8/15, 9/25, 10/9, 12/25 등) | 모두 포함 ✓ |
| 제헌절 7/17 (Google이 `공휴일`로 분류) | 포함됨 — 법적으론 2008년부터 공휴일 아니지만 캘린더상 빨간색 표기는 통상적 처리라 그대로 둠 |

#### 회귀 디버깅 메모
중간 시도 1 차에서 `^공휴일\b` 정규식을 썼더니 google 결과가 0건이 됨. 원인: JS 의 `\b` 는 `\w`(ASCII) 기준이라 한글 문자 뒤에서 매치 안 됨. `\b` 제거 후 정상.

#### §4.7 갱신
"한국 공휴일 자동 갱신" 섹션을 "다중 소스 / 임시공휴일 보강" 으로 확장. nager / Google ICS / manual 의 각 역할과 실패 시 fallback 정리.

### 2026-05-04 15:05 · PROGRESS — 공휴일 자동 갱신 (date.nager.at 일 1회)
사용자 요청: 임시공휴일(예: 총선)을 포함한 한국 공휴일을 매일 자동 확인해 간트에 반영.

#### 결정 / 설계
- **소스**: `date.nager.at` (무료, 키 불필요, REST). 부족하면 `data/holidays.json` 의 `manual` 배열로 직접 추가 가능.
- **저장**: `data/holidays.json` (`auto`: fetch 결과 / `manual`: 사용자 추가 / 합집합으로 서빙).
- **갱신 정책**: 서버 부팅 직후 1회 + `setInterval` 24h. fetch 실패 시 기존 캐시 유지(네트워크 단절 안전).
- **클라이언트**: `loadServerHolidays()` → `SERVER_HOLIDAYS` Set. `isHoliday()` 가 `KOREAN_HOLIDAYS`(하드코딩 fallback) 와 합집합. 서버 fetch 가 깨져도 하드코딩으로 동작 보장.

#### 구현
- `src/holidays.js` 신규: load/save/fetch/refresh/scheduleDaily/getMerged. Node 18+ 내장 `fetch` 사용. `setInterval` 핸들에 `unref()` 호출해 timer 가 이벤트 루프를 잡지 않도록.
- `src/server.js`: 모듈 import + 부팅 시 `holidays.load(); holidays.scheduleDaily();` + `GET /api/holidays`, `POST /api/holidays/refresh` 라우트 등록.
- `public/app.js`:
  - `let SERVER_HOLIDAYS = new Set()` + `async loadServerHolidays()`.
  - `isHoliday(date)` 헬퍼 (하드코딩 ∪ 서버).
  - `renderGantt` 의 holiday 분기를 `isHoliday(date)` 로 교체.
  - `refreshAll` 의 `Promise.all` 에 `loadServerHolidays()` 추가 → 페이지 부팅·갱신 시 매번 최신 데이터.

#### 검증
| 단계 | 결과 |
|---|---|
| 서버 부팅 시 콘솔에 `[holidays] refreshed: 44 dates from date.nager.at` 출력 | ✓ |
| `data/holidays.json` 자동 생성 + `auto.lastFetched`/`source` 채워짐 | ✓ |
| `GET /api/holidays` 가 합집합(예: 44건) 반환 | ✓ |
| `POST /api/holidays/refresh` 호출 시 즉시 재 fetch + 응답 반환 | ✓ |

#### 임시공휴일 / 사용자 override
nager.at 가 임시공휴일을 늦게 반영하거나 누락한 경우, `data/holidays.json` 을 열어 `manual` 배열에 `"YYYY-MM-DD"` 추가 → 서버 재시작 (또는 POST refresh) → 즉시 반영. 매일 fetch 도 `manual` 은 건드리지 않음(`auto` 만 갱신).

#### §4.7 / §6 갱신
- §4.7 시각 표기 표의 공휴일 항목을 "서버에서 일 1회 자동 갱신 + 하드코딩 fallback" 으로 수정.
- §4.7 끝에 "한국 공휴일 자동 갱신" 영구 섹션 신설.
- §6 API 표에 `/api/holidays`, `/api/holidays/refresh` 추가.

### 2026-05-04 15:00 · CHANGE — 토요일 배경 채도 보정
사용자 보고: 토요일 배경 (`#eef4ff`) 이 거의 안 보임. 조금 더 진하게.
- `.gantt-day.saturday` 의 background 를 `#eef4ff` → **`#d6e4f7`** 로 한 단계 진하게.
- 일요일/공휴일의 옅은 빨강(`#fdecec`) 과 시각 무게가 비슷해지도록 매칭. 오늘 색 (`#e7f0ff` + bold + primary text) 은 여전히 가장 도드라짐.

### 2026-05-04 14:57 · CHANGE — 간트 헤더 디자인 (한국어 표기 + 토·일·공휴일 색)
사용자 요청:
1. 간트 헤더가 `5/ \n 13` 으로 보이는 걸 `5월 \n 13일` 로 바꿔줘.
2. 대한민국 법정공휴일은 빨간색 배경으로. 현재 주말이 약간 더 진한 회색인데 이를 눈에 거슬리지 않은 옅은 빨강으로. 토요일은 옅은 파랑.

#### 결정
- 토/일을 한 클래스(`weekend`)로 묶던 것을 분리: `saturday` (옅은 파랑) / `holiday` (옅은 빨강, 일요일+법정공휴일).
- 법정공휴일은 음력 명절 등 매년 변동되는 일자를 미리 계산해 양력 ISO 문자열 Set 으로 하드코딩 (2025–2027). 새 연도 편집은 한 곳(`KOREAN_HOLIDAYS`)만 손보면 됨. 대체공휴일도 포함.
- `today` 는 위 두 클래스보다 항상 우선 적용 (CSS 선언 순서를 마지막으로).

#### 구현
- `public/app.js`:
  - 상수 `KOREAN_HOLIDAYS`(`Set<YYYY-MM-DD>`) 신규. 2025·2026·2027 신정/설날/삼일절/어린이날/부처님오신날/현충일/광복절/추석/개천절/한글날/크리스마스 + 알려진 대체공휴일 포함.
  - `renderGantt` 의 헤더 셀 렌더에서 `dow === 0 || dow === 6` 단일 분기를 제거하고 `dow === 6 → saturday`, `dow === 0 || KOREAN_HOLIDAYS.has(date) → holiday` 로 분리.
  - 헤더 셀 텍스트를 `<span class="month">${m}월</span>${d}일` 로 변경.
- `public/styles.css`:
  - `.gantt-day.weekend` 제거.
  - `.gantt-day.saturday { background: #eef4ff; }` 추가 (옅은 파랑).
  - `.gantt-day.holiday { background: #fdecec; color: #b94334; }` + `.month { color: #c98080; }` 추가 (옅은 빨강).
  - `.gantt-day.today` 를 위 두 규칙 *뒤에* 선언해 우선 적용 (오늘이 토요일/공휴일에 겹쳐도 today 표시 유지).
  - 미사용된 `.gridline.weekend` 잔여 CSS 정리.
- `md/PROJECT_LOG.md §4.7`:
  - "회색 컬럼 배경 = 주말" 표기 제거. 토/일·공휴일/오늘/헤더 텍스트 형식을 표로 갱신.

#### 검증 (Node 분류 시뮬)
| 날짜 | 종류 | 적용 클래스 |
|---|---|---|
| 2026-05-04 (월) | 평일 | (없음) |
| 2026-05-05 (화) | 어린이날 | `holiday` |
| 2026-05-09 (토) | 토요일 | `saturday` |
| 2026-05-10 (일) | 일요일 | `holiday` |
| 2026-08-15 (토, 광복절) | 토 + 공휴일 | `saturday`+`holiday` (CSS 마지막 선언인 `holiday` 가 색 적용) |
| 2026-09-25 (금, 추석) | 평일 + 공휴일 | `holiday` |

### 2026-05-04 14:47 · BUGFIX — "+ 의존성 추가" 가 편집 분기로 빠지던 회귀
사용자 보고: "+ 의존성 추가" 를 누르면 "편집 중이던 의존성이 더 이상 존재하지 않습니다" alert 가 떠서 추가가 막힘.

#### 원인
직전 14:43 수정에서 `openDependencyModal` 을 async 로 전환하면서 편집 모드 검증을 추가:
```js
async function openDependencyModal(dep = null) {
  ...
  if (dep && !state.dependencies.find((d) => d.id === dep.id)) { alert(...); return; }
}
```
그런데 추가 버튼 핸들러가 함수를 그대로 콜백으로 넘기고 있었음:
```js
els.addDependencyBtn.addEventListener('click', openDependencyModal);
//                                              ↑ 이러면 click 이벤트(MouseEvent)가 첫 인자(dep) 로 들어감
```
MouseEvent 객체는 truthy 라 `if (dep && ...)` 조건이 통과되고, MouseEvent 에는 `id` 가 없어 `state.dependencies.find(...)` 가 undefined → 검증 실패 → alert.

(이전 동기 버전에서는 `dep ? dep.id : ''` 분기에서 `dep.id` 가 undefined 가 되어 dataset.editId 가 'undefined' 문자열로 들어가는 가벼운 버그였음 — 추가는 됐지만 편집 데이터에 영향. 비기능 결함이라 안 보였음.)

#### 수정
`public/app.js`:
```js
els.addDependencyBtn.addEventListener('click', () => openDependencyModal());
```
이벤트 객체가 인자로 새지 않도록 명시적 화살표 함수로 감쌈.

#### 검증
- grep 으로 다른 `addEventListener('click', open*Modal)` 패턴 추가 점검 → 없음 (다른 모달 트리거는 모두 `() => open*Modal(...)` 로 감싸져 있음).
- POST cat-level dep (PCB→핸드폰) → 201 정상.

### 2026-05-04 14:43 · CHANGE — 로컬경로 첨부 UI 제거 + 의존성 모달 견고화
사용자 보고:
1. 첨부에 "파일 업로드" 옆의 "+ 로컬 경로 추가" 가 불필요. 제거 요청.
2. 새 카테고리를 만들고 의존성을 추가하려는데 `not_found` 가 뜸.

#### #1 결정 / 구현 (로컬 경로 첨부 UI 제거)
- 원래 §1.2 요구사항에 명시되어 있던 두 종류 첨부(업로드 / 로컬 경로). 사용자 실제 운영에서는 업로드만으로 충분하다고 판단됨. UI 노출만 제거.
- 보존: 서버의 `/api/reports/:id/attachments/local` 엔드포인트와 DB 의 `kind='local_path'` 데이터는 그대로 둠 (기존 데이터 호환). 렌더링 코드도 유지 — 이미 만들어진 로컬 경로 첨부는 그대로 보이고 삭제도 가능, 다만 새로 만들 수는 없음.
- 변경 파일:
  - `public/index.html`: `<button id="attachment-local-btn">` 및 `<div id="local-path-modal">…</div>` 전체 삭제.
  - `public/app.js`: `attachmentLocalBtn` / `localPathModal` / `localPathForm` 참조와 핸들러 전부 삭제. 모달 close 리스트에서 제외. `state.pendingAttachments` 의 `kind:'local_path'` 분기와 flush 로직 삭제 (업로드만 남음).

#### #2 결정 / 구현 (의존성 모달 견고화)
- 진단:
  - `not_found` 는 서버에서 오직 `/api/dependencies/:id` 의 PUT/DELETE/GET 만 반환. POST 경로는 `pred_not_found` / `succ_not_found` (다른 코드).
  - 따라서 사용자는 의도치 않게 PUT 요청을 보냈을 가능성. 원인 후보:
    - 직전에 "편집" 한 dep 의 `dataset.editId` 가 닫힘 후에도 dataset 에 남아 있다가, 다음 "+ 의존성 추가" 흐름에 영향 (이론상 `openDependencyModal(null)` 이 리셋하지만 안전망 부족).
    - 다른 탭에서 dep 를 삭제했거나, 카테고리 cascade 삭제로 dep 가 사라진 사이 사용자가 stale UI 의 "편집" 버튼을 눌렀을 가능성.
- 방어적 수정 (`public/app.js`):
  - `closeDependencyModal()` 가 `els.dependencyForm.dataset.editId = ''` 명시적 리셋.
  - `openDependencyModal(dep)` 를 `async` 로 전환. 진입 시 항상 `loadCategories / loadAllSchedules / loadDependencies` 를 다시 가져와 dropdown 신선도 보장.
  - 편집 모드(`dep` 인자 존재) 진입 시 새로고침 후 해당 dep 가 여전히 존재하는지 검증. 없으면 alert + 모달 미오픈.
  - 에러 메시지 매핑 보강: `not_found`/`pred_not_found`/`succ_not_found` 등 모든 케이스에 사용자 친화적 한국어 메시지 + "새로고침해주세요" 안내 추가. 미매핑 코드는 `저장 실패 (XXX)` 형태로 노출.

#### 검증
| 케이스 | 결과 |
|---|---|
| HTML/JS 에 `attachment-local-btn` / `localPathModal` 등 잔여 참조 | grep count=0, 정리 완료 ✓ |
| 신규 카테고리 PCB(24) 와 다른 카테고리 핸드폰(6) 사이 cat-level strong dep POST | 201 + dep id=20 정상 생성 (서버 OK) ✓ |
| 존재하지 않는 dep id 로 PUT (e.g. 99999) | 404 `not_found` 응답 (UI 는 이제 친화적 메시지로 안내) ✓ |
| 의존성 모달 진입 시 state 새로고침 + editId 리셋 | grep 으로 호출 위치 확인 ✓ |

### 2026-05-04 12:31 · CHANGE — 리포트 작성 시 첨부 가능 + 본문 줄바꿈 보존
사용자 보고:
1. 신규 리포트 작성 시 첨부 섹션이 안 보여서 첨부할 수 없음. 작성 단계에서 같이 첨부 가능해야 함.
2. 본문에 줄바꿈을 넣어도 "가나다라마 바사아자차카" 같이 한 줄로 합쳐져 보임. 줄간격이 그대로 반영되어야 함.

#### 결정
**1. 첨부**: 첨부는 `report_id` 가 필요한 리소스라 신규 리포트가 저장 전에는 서버에 등록할 수 없음. 클라이언트에서 **pending 버퍼** 를 두어 `state.pendingAttachments` 에 저장하고, 리포트 저장 (POST) 직후 서버에서 ID 를 받으면 그 ID 로 각 pending 항목을 업로드/등록(POST)으로 flush. 사용자에겐 항상 첨부 UI 가 보이도록.

**2. 줄바꿈**: 클라이언트에서 본문 미리보기를 만들 때 `\s+` (모든 공백 = 개행 포함) 를 단일 공백으로 치환하던 로직 + CSS `white-space: nowrap` 두 군데 모두에서 줄바꿈을 죽이고 있었음. `\s+` 대신 `[ \t]+` (수평 공백만) 정리하고, CSS 를 `white-space: pre-wrap` 으로 변경. 동시에 `-webkit-line-clamp` 5줄 제한으로 표(table) 행이 무한정 길어지는 것은 방지.

#### 구현
- `public/app.js`:
  - `state.pendingAttachments = []` 추가. `openReportModal` 진입 시 항상 초기화 + 첨부 섹션 항상 표시.
  - `renderAttachmentList(savedAttachments)` 가 saved + pending 을 통합 렌더. pending 항목은 `att-kind.pending` 표식 + "(저장 시 업로드/등록됨)" 안내 + delete id 가 `pending-{idx}`.
  - 파일 업로드 핸들러: `state.editingReportId` 분기. 있으면 즉시 POST, 없으면 `state.pendingAttachments` 에 `{kind:'upload', file, display_name}` push.
  - 로컬 경로 핸들러: 동일 분기. 신규 모드에서도 모달 사용 가능 (이전에 `editingReportId` 없으면 return 하던 가드 제거).
  - 저장 submit: 신규 POST 후 응답의 `created.id` 로 pending 첨부를 순차 flush (upload 는 `multipart/form-data`, local 은 JSON).
  - 첨부 삭제 핸들러: `pending-{idx}` 면 in-memory 버퍼에서 splice, 아니면 기존 DELETE.
  - 본문 미리보기 — per-category 표: `replace(/\s+/g, ' ').slice(0, 80)` 제거 → 본문 그대로 사용 (CSS 가 줄바꿈/클램프 처리).
  - 본문 미리보기 — all-reports: `replace(/\s+/g, ' ')` → `replace(/[ \t]+/g, ' ')` (수평 공백만 정리, 개행 보존).
- `public/styles.css`:
  - `.preview-cell` (per-category 표): `white-space: nowrap; text-overflow: ellipsis` → `white-space: pre-wrap; word-break: break-word; -webkit-line-clamp: 5` (5줄 클램프).
  - `.all-reports-list .report-item-body` (전체 리포트): 동일하게 `white-space: pre-wrap; word-break: break-word`. 클램프는 안 함 (전체 리포트는 펼쳐 보는 용도).
  - `.att-kind.pending` 식별 가능 (대기 중 시각 신호 차후 보강 가능).

#### 검증
- HTML/JS/CSS 와이어링 grep 일치.
- 서버 동작: 본문에 `\n` 포함해 POST → GET 시 그대로 반환됨 (`'가나다라마\n바사아자차카'`). DB는 `TEXT` 라 개행 보존 ✓.
- 클라이언트 동작 (코드 리뷰): pending 버퍼에 push → submit 후 `created.id` 로 flush → 모달 닫힘 + `refreshReportsForScope` 으로 리스트 갱신.
- 줄바꿈 시각: `white-space: pre-wrap` 하에서 `\n` 이 가시적 줄바꿈으로 렌더됨.

#### 사용 흐름 (신규 리포트 작성)
1. "+ 리포트 작성" → 모달 열림. 첨부 섹션이 처음부터 보임.
2. 본문에 줄바꿈 입력 가능 (Enter).
3. 파일 업로드 / 로컬 경로 추가 → "대기" 표식과 함께 목록에 등장.
4. 저장 → POST 리포트 → ID 받자마자 pending 첨부들이 순차 등록 → 모달 닫힘.
5. 리포트 행 다시 열어보면 본문 줄바꿈 그대로, 첨부 모두 정상 표시.

### 2026-05-04 12:21 · CHANGE — 전체 리포트 정렬 (날짜 ASC + 같은 날 작성순 ASC)
사용자 요구: 전체 리포트 뷰에서 **4월 30일이 5월 4일보다 위**여야 하고, 같은 날 안에서는 **나중에 올린 것이 아래** 여야 함. (= 시간 순서를 위→아래로 읽기)

#### 결정
- 직전 구현은 날짜 DESC + API 응답 순서(id DESC). 사용자 의도와 정반대.
- 두 단계 모두 ASC 로 변경. 이유: "그 날 리포트의 시간 흐름" 을 위→아래로 자연스럽게 읽기 위함.

#### 구현
- `public/app.js renderAllReportsView`:
  - `[...byDate.keys()].sort().reverse()` → `.sort()` (날짜 ASC).
  - 날짜 그룹 안에서 `byDate.get(date)` 를 그대로 쓰던 것을 `slice().sort((a,b) => a.id - b.id)` 로 교체. id 오름차순 = auto-increment 기반 작성 순서 ASC.

#### 검증 (실제 데이터)
4개 리포트를 작성순 [5/4 first, 4/30 first, 5/4 second, 4/30 second] (id 17,18,19,20) 로 생성한 뒤 `?category_id=6` 응답을 클라이언트 정렬과 동일한 로직으로 시뮬:
```
2026-04-30
  1) id=18 - first 4/30
  2) id=20 - second 4/30
2026-05-04
  ... id 오름차순으로 작성순 유지 ...
```
4/30 이 5/4 보다 위, 같은 날 안에서 작성 순서 유지 ✓.

#### §4.7 갱신
- "1단계 그룹: 카테고리(id ASC) / 2단계: 날짜 ASC / 3단계: 같은 날짜 안 id ASC (= 작성순)" 명시.

### 2026-05-04 12:10 · PROGRESS — 전체 리포트 뷰 신설 (Phase 4 v4)
사용자 요청: "전체 간트" 처럼 "전체 리포트" 버튼을 만들어서 모든 카테고리의 리포트를 한 화면에 묶어 보고 싶음. 카테고리별 → 날짜별 → 리포트 목록 형태. 한 리포트가 여러 태그면 각 카테고리에 모두 표시.

#### 결정 / 설계
- 새 scope 값 `'all-reports'` 추가 (기존: `'category' | 'all'`).
- 사이드바 **📋 전체 리포트** 버튼을 **📊 전체 간트** 아래에 배치.
- 별도 `<div id="all-reports-view">` 컨테이너에 렌더 (간트 뷰와 분리).
- 그룹화: **카테고리(id ASC)** → **날짜(DESC)** → 본문 미리보기 + 첨부 칩.
- 한 리포트가 N개 카테고리 태그면 N번 표시(각 섹션). "한 눈에 보기" 의도에 맞음.
- 검색 input 은 뷰 상단에 영구 배치, 본문/날짜/태그 이름 부분 일치.
- 카테고리 태그가 없는 리포트는 "태그 없음" 가상 섹션 (id=-1) 으로 분리.
- 클릭 시 기존 `openReportModal(report)` 재사용 → 편집 흐름 일관성.
- 첨부 칩: `📎` 업로드(클릭 → `/uploads/<file>`), `📁` 로컬(클릭 → `file://...`, 보안 차단 시 칩 hover 로 경로 확인).

#### 구현
- `public/index.html`:
  - 사이드바 `<button id="all-reports-btn">📋 전체 리포트</button>`.
  - 새 컨테이너 `<div id="all-reports-view">` (검색창 + 콘텐츠 영역).
- `public/styles.css`:
  - `.reports-cat-section` 카드형, `.reports-cat-head` 헤더 + 카테고리 칩, `.reports-date-group h4` 날짜 헤더, `.all-reports-list` ol 들여쓰기.
  - `.att-chip` 알약 모양 첨부 링크, `.cat-tag.mini` 다른 태그 보조 표시.
- `public/app.js`:
  - 상태 추가: `scope='all-reports'`, `allReports[]`, `allReportsQuery`.
  - DOM 참조 추가: `allReportsBtn`, `allReportsView`, `allReportsContent`, `allReportsSearch`, `allReportsSummary`.
  - `selectAllReportsView()` / `loadAllReports()` 신규.
  - `renderCategoryView()` 가 `state.scope === 'all-reports'` 분기 추가.
  - `renderAllReportsView()` 신규: 필터링 → 카테고리/날짜 그룹화 → 섹션 렌더 → 클릭 핸들러 위임.
  - `refreshReportsForScope()` 신규: 리포트 저장/삭제/첨부 변경 후 현재 scope 에 맞게 자동 새로고침. 기존 `loadReports/renderReports` 직접 호출 지점들을 이 헬퍼로 통합.

#### 검증 (실제 데이터)
사용자 데이터 (디스플레이/카메라/핸드폰 카테고리) 에 4개 리포트 추가 후 GET /api/reports → 클라이언트 그룹화 시뮬레이션 결과:
```
* 디스플레이 (3건)
  2026-05-04
    1) 아주 카메라는 똥이었음
    2) 아주뭣같은 일이었음
* 카메라 (4건)
  2026-05-04
    1) 아주 카메라는 똥이었음
    2) 아주뭣같은 일이었음
* 핸드폰 (6건)
  2026-05-04
    1) 정말 엿먹어야할일이었음
    2) 아주뭣같은 일이었음
    3) 핸드폰은 준비는되는겨
```
사용자가 예시로 든 형태와 일치. 한 리포트 (예: "아주뭣같은 일이었음", 태그 4·5·6) 가 세 카테고리에 모두 노출됨 ✓.

#### §4.7 갱신
- "전체 리포트 뷰 — 그룹화 규칙" 섹션 추가. 1단계 카테고리 / 2단계 날짜 / 항목 구성 / 검색 / 클릭 동작 명시.

### 2026-05-04 11:54 · CHANGE — 간트 행 순서를 위상정렬로
사용자 요청:
1. 후행이 있는 항목은 그 선행이 **위**에 보이도록.
2. 후행이 없는(=고립) 항목은 혼선 방지를 위해 **맨 아래**에.

#### 결정 / 설계
- strong 엣지로 만들어진 DAG 에 **Kahn's 알고리즘** 위상정렬을 적용 (in-degree 0 부터 BFS, 차수 감소).
- 같은 단계 안에서는 입력 배열 순서(API 응답: `planned_start ASC, id ASC`)를 보존 → 결과 안정성.
- strong 엣지에 한 번도 등장하지 않는 항목들은 "involved" 집합에 들지 않으며, 정렬 결과 끝에 입력 순서대로 붙임.
- weak 엣지는 방향성이 없으므로 정렬에 영향 없음.
- 카테고리 endpoint 의존성은 그 카테고리의 모든 스케줄로 펼쳐 처리(스케줄-쌍별 엣지). 이미 의존성 화살표 / 연결 BFS 와 동일한 방식.

#### 구현
- `public/app.js`:
  - `topoSortForGantt(visible)` 신규. 위 알고리즘 구현. 입력 배열의 안정 순서 유지.
  - `renderGantt`: `effectiveSchedules()` 결과를 곧바로 사용하지 않고 `topoSortForGantt()` 통과시킨 후 막대/화살표 좌표 계산.
- 테이블/리스트 뷰는 변경 없음 (기존 날짜순 유지). 사용자가 명시적으로 "Gantt 보기 편하게" 요청.

#### 검증 (Node 단위)
| 시나리오 | 기대 | 결과 |
|---|---|---|
| 핸드폰: cam,disp→phone strong / disp~cam weak / 배송 고립 | DISPLAY, Camera, Phone, 배송 | ✓ |
| 핸드폰 → 배송 strong 추가 | DISPLAY, Camera, Phone, 배송 | ✓ |
| 체인 + 두 고립 (Solo1, Solo2) | 체인 후 Solo1, Solo2 | ✓ |
| pred id(30) 이 succ id(5) 보다 큼 | A_pred (위), Z_succ (아래) — id 무관 | ✓ |
| weak 만 있음 (strong 없음) | 모두 고립 (입력 순서) | ✓ |

#### §4.7 갱신
- "행(스케줄) 순서 — 위상정렬" 항목 추가. strong 우선/weak 무관/고립 분리/리스트는 미적용 명시.

### 2026-05-04 11:46 · DOC — 간트 시각 표기 규약 §4.7 신설
사용자 질문 ("막대 밑 띠가 '여기로 옮겨야만 한다' 는 의미인가?") 에서, 막대 본체/색/오렌지 띠/화살표 의 의미가 §7 타임라인에는 흩어져 있고 §4 영구 섹션에는 없었음을 확인. 향후 사용자가 차트를 보다가 헷갈리지 않도록 **§4.7 간트 시각 표기 규약** 영구 섹션을 추가:
- 막대 본체 = planned. 색은 actual 일치(파란)/불일치(오렌지) 의미.
- 좌측 색띠 = 카테고리, 점선 outline = 연결-extra.
- 막대 아래 얇은 오렌지 띠 = 엔진이 본 actual 위치 (= "여기로 가야 한다" 는 신호).
- 화살표 strong/weak 의미와 weak 의 +6px Y 오프셋.
- 드래그/리사이즈 의미.

### 2026-05-04 11:37 · CHANGE — 간트 시각 안정화 + weak 화살표 가시화
사용자 보고 3건:
1. 드래그 후 갱신 시 차트 막대의 색/위치가 멋대로 변함.
2. 후행이 선행을 침범하지 않았는데도 갱신 시 선행이 끌려 들어가는 듯한 인상.
3. 약한 연결(점선)이 강한 연결(실선)에 가려짐.

#### 분석
- #1 의 근본 원인: 막대 위치를 `actual_*` 기준으로 그렸기 때문. 캐스케이드가 actual 을 변경하면 사용자가 끌어놓은 위치가 시각적으로 이동되어 보임. 동시에 범위(`startDate`, `endDate`)도 actual 까지 포함해 계산해서, 한 막대의 actual 이 크게 이동하면 전체 범위가 시프트되어 다른 막대들의 픽셀 위치까지 변함.
- #2 의 근본 원인: 엔진은 invasion 검사(`requiredMinStart > current`)에서 정확히 동작 중이나, #1 때문에 사용자가 "이미 당겨진 actual 위치"의 막대를 보면서 끌어내, 침범하지 않았다고 느끼는데 실제로는 actual 기준 침범이 발생. 막대를 planned 기준으로 그리도록 바꾸면 사용자의 직관과 시스템의 invasion 판정이 일치.
- #3 의 근본 원인: 모든 의존성을 한 패스로 그리면서 실선이 점선을 덮음. 또 같은 두 entity 사이에 strong+weak 가 함께 있을 때 두 라인이 정확히 같은 좌표로 그려짐.

#### 수정
**1. 간트 막대를 PLANNED 기준으로 렌더** (`public/app.js renderGantt`)
- `startIdx` / `endIdx` 가 `s.planned_start` / `s.planned_end` 사용.
- `planShifted` (actual≠planned) 면 `.shifted` 클래스 + 툴팁 분리 표시 + 추가 **얇은 오렌지 오버레이**(`.gantt-actual-overlay`) 를 actual 범위 위치에 그려서 "엔진 조정 결과" 를 함께 표시.

**2. 범위(`startDate`/`endDate`) 안정화** (`public/app.js`)
- 일차 계산은 planned+today 만으로. actual 은 그 다음 단계에서 "범위 밖일 때만 확장" 으로 사용. 결과적으로 actual 의 변동이 범위를 좁히지 못하고, 사용자 의도대로 그린 막대들이 픽셀 위치를 유지.

**3. 화살표 두 패스 + weak Y 오프셋** (`public/app.js drawDependencyArrows`)
- pass 1: `link_type='strong'` 만 그림 (오프셋 없음).
- pass 2: `link_type='weak'` 만 그림 (Y +6px 오프셋, 마지막에 그려져 위에 올라옴).
- 같은 pred/succ 에 strong+weak 가 같이 있어도 weak 가 strong 아래쪽으로 살짝 떨어진 위치에 점선으로 보임.

**4. 화살표 좌표를 planned 기준으로 통일** (`public/app.js`)
- 화살표가 막대의 끝/시작에 정확히 붙도록 `positions` 맵을 `planned_*` 좌표로 채움.

**5. CSS 추가** (`public/styles.css`)
- `.gantt-actual-overlay` (top:30, height:4, 옅은 오렌지) — 막대 바로 아래에 actual 범위를 가는 띠로 표시.

#### 검증
- 자산 200 OK / JS 핵심 심볼 grep 확인.
- PUT 후 응답: planned 변경, cascade 응답 형식 정상 (`shifted`, `conflicts` 카운트 0/0 케이스).
- 막대 좌표 계산: `daysBetweenInclusive(startDate, planned_start)−1` 로 0-based index. 폭은 (endIdx−startIdx+1)*32. 범위 안정화로 인해 startDate 가 actual 이동에 영향 안 받음.
- 화살표 두 패스: 같은 두 entity 사이에 strong+weak 동시 존재 시 weak 점선이 +6px 아래에 가시.

### 2026-05-04 11:14 · PROGRESS — Phase 4 v3 (의존성 화살표 / 리포트 검색)
사용자 요청: Phase 4 이후를 진행. (이연된 v3 항목 처리)

#### 결정 / 설계
- **간트 의존성 화살표**: 간트 그리드 위에 SVG 오버레이로 그림.
  - strong 엣지 → **솔리드 파란선 + 화살표머리**. UI 의존성 패널 색상 톤과 일치.
  - weak 엣지 → **회색 점선** (방향성 없는 관계 의미상 화살표머리 없음).
  - 카테고리 endpoint 는 화살표 양쪽이 단일 스케줄로 매핑되어야 하므로:
    - pred 카테고리 → 그 카테고리의 보이는 스케줄 중 **right(actual_end) 가 가장 큰** 것 선택 (실제 binding 제약).
    - succ 카테고리 → 그 카테고리의 보이는 스케줄 중 **left(actual_start) 가 가장 작은** 것 선택.
  - 화살표는 `.cat-only` 가 아니라 항상 토글 가능 (전체 간트 / 카테고리 뷰 둘 다).
- **리포트 검색**: 본문 텍스트 + 리포트 날짜 문자열 + 카테고리 태그 이름 부분 일치.

#### 구현
- `public/index.html`:
  - 스케줄 toolbar 에 `<button id="show-arrows-btn">화살표 OFF</button>` 추가 (`cat-only` 없음 — 전체 간트에서도 사용).
  - 리포트 섹션 헤더에 toolbar 도입 + `<input id="report-search">`.
- `public/styles.css`:
  - `#show-arrows-btn.active` (활성 강조), `.gantt-arrows { pointer-events: none }` (위에 막대 드래그 가능하도록).
- `public/app.js`:
  - 상수 `GANTT_ROW_H=36 / GANTT_BAR_TOP=7 / GANTT_BAR_H=22` 분리.
  - 상태 추가: `showArrows`, `reportQuery`.
  - `renderGantt` 가 막대 위치를 `Map<scheduleId, {left,right,midY}>` 으로 수집. 화살표가 ON 이면 `drawDependencyArrows` 호출.
  - `drawDependencyArrows(grid, positions, ...)`:
    - SVG `<defs>` 안에 `<marker id="gantt-arrow">` 정의 (markerUnits=userSpaceOnUse 로 사이즈 안정화).
    - 각 의존성에 대해 pred/succ 스케줄 ID 결정 (카테고리 endpoint 매핑 포함).
    - 정상 forward(`x2 > x1`): L 자 경로 `M x1,y1 → x1+6,y1 → x1+6,y2 → x2-2,y2`.
    - 비정상(`x2 ≤ x1`, 충돌 상태): 가운데 우회 6점 경로.
    - strong 솔리드 + 화살표 / weak 점선.
  - `filteredReports()` 추가, `renderReports()` 가 사용. 빈 결과 메시지 분기.
  - 토글 버튼 + 리포트 검색 input 핸들러.

#### 검증
- HTML/JS/CSS 와이어링 grep 일치 + 200 OK.
- 좌표 계산:
  - 좌측 = `(daysBetweenInclusive(start, actual_start) - 1) * 32`.
  - 우측 = `daysBetweenInclusive(start, actual_end) * 32` (= (endIdx+1)*W).
  - midY = `headerHeight + rowIndex * 36 + 7 + 22/2`.
  - 핸드폰(actual 5/26~6/5) row index 2 가정 시 left=832, right=1184; 디스플레이(5/3~5/9) row 0 left=96, right=320 → 화살표 (320, midY0) → (832, midY2) 정상 ✓
- 카테고리 endpoint 매핑 로직: pred-cat 의 "가장 우측 끝" / succ-cat 의 "가장 좌측 시작" 픽 — strong 의 binding 제약을 시각적으로 표현.

#### 사용 흐름
- 간트로 전환 → 우측 toolbar 의 **화살표 OFF/ON** 토글.
- ON 일 때 strong 의존은 파란 화살표, weak 는 회색 점선으로 연결.
- 리포트 패널의 검색창에 키워드 (예: "5/4", "디스플레이", "이슈") 입력 → 본문/날짜/태그 어디라도 매치되는 리포트만 표시.

### 2026-05-04 11:04 · CHANGE — UX 보정 3건
사용자 보고:
1. 리포트 작성/저장 후 첨부 창이 갑자기 떠서 어색하고, 저장 후 모달이 안 닫힘.
2. 간트 차트의 막대를 선택해도 편집 모달이 안 열림 (드래그만 됨).

#### 수정
**1. 리포트 모달 close-on-save** (`public/app.js`)
- 이전: 신규 작성 → 저장 → 모달이 자동으로 편집 모드로 전환되며 첨부 섹션이 갑자기 등장. 사용자에게 "저장이 끝난 건지" 헷갈리는 흐름.
- 변경: 저장 시 (생성/편집 모두) 즉시 모달을 닫음. 첨부를 추가하려면 저장된 리포트 행을 다시 클릭해서 편집 모드로 들어가면 자동으로 첨부 섹션이 보임.
- 부수 효과: 첨부는 리포트 저장 후에만 추가 가능하다는 기존 제약은 그대로지만, 흐름이 명확해짐.

**2. 간트 클릭 → 편집 모달** (`public/app.js` `attachBarDragHandlers`)
- mousedown 시 `moved=false` 플래그 도입.
- mousemove 에서 `Math.abs(dx) > 3` 면 `moved=true`.
- mouseup 시점에 `!moved` 면 클릭으로 간주, `openScheduleModal(schedule)` 호출.
- moved 라도 dayDelta=0 이면 막대 위치 원복 (기존 코드의 미세 잔상 방지).

**3. (보너스 결함 수정) 스케줄 카테고리 보존** (`public/app.js`)
- 이전: 스케줄 편집 모달의 submit 가 무조건 `state.selectedCategoryId` 를 `category_id` 로 전송. 전체 간트 / 연결 포함 모드에서 다른 카테고리 스케줄을 편집하면 의도치 않게 현재 카테고리로 이동되거나(혹은 selectedCategoryId 가 null 이면 검증 실패).
- 변경: `openScheduleModal(schedule)` 가 `els.scheduleForm.dataset.categoryId` 에 그 스케줄의 `category_id` 를 저장. submit 가 dataset 값을 사용하므로 편집 시 카테고리 보존됨. 신규 작성은 selectedCategoryId 사용 (변경 없음).
- 검증: PUT `/api/schedules/:id` 에 명시적 category_id 보내 변경 안 됨을 확인 (cat=4 → cat=4 유지).

#### 검증
- 리포트 모달 close-on-save: 코드 grep 으로 `closeReportModal()` 가 submit 핸들러 안에서 호출됨 확인.
- 간트 클릭/드래그: `let moved = false`, `Math.abs(dx) > 3`, `if (!moved) openScheduleModal(schedule)` 코드 존재 확인.
- 카테고리 보존: HTTP PUT 으로 cat 4 → 4 유지 확인 (200).

### 2026-05-04 10:50 · PROGRESS — Phase 4 v2 (전체 간트 / 연결 포함 토글)
사용자 요청:
1. 전체 간트 — 모든 카테고리 통합 표시
2. 상위(선택) 항목과 함께 하위 카테고리/스케줄도 함께 표시하는 토글

#### 결정 / 설계
- **scope** 상태 추가: `'category' | 'all'`. 사이드바 상단의 "📊 전체 간트" 버튼으로 전환.
- "상위/하위" 의 자연스러운 해석은 우리 데이터 모델에서는 **의존성 그래프** (카테고리 계층은 모델에 없음). 따라서 토글은 "선택한 카테고리와 의존성으로 연결된(예: 디스플레이/카메라 ↔ 핸드폰) 모든 항목을 함께 표시" 로 정의.
- 연결은 **양방향 추이적**: 선택 항목으로부터 strong/weak 양방향으로 BFS 하여 도달 가능한 모든 스케줄. 카테고리 레벨 의존성은 그 안의 모든 스케줄로 확장.

#### 구현
- `public/index.html`:
  - 사이드바 상단에 `<button id="all-view-btn">📊 전체 간트</button>`.
  - 스케줄 toolbar 에 `<button id="expand-connected-btn" class="cat-only">연결 포함 OFF</button>`.
  - 카테고리 한정 UI 들에 `cat-only` 클래스 (편집/삭제 cat 버튼, +스케줄/+의존성/+리포트 버튼, 의존성+리포트 섹션 전체).
  - 스케줄 테이블에 카테고리 컬럼(`<th class="all-view-only">`).
- `public/styles.css`:
  - `.all-view-btn` (사이드바 큰 버튼, active 상태).
  - `body.scope-all .cat-only { display:none !important }`, `body.scope-all .all-view-only { display:table-cell }`.
  - `.gantt-bar` 좌측 4px `border-left` 를 `var(--cat-color)` 로 (카테고리 색 띠).
  - `.gantt-bar.connected-extra` (점선 outline + 살짝 투명).
  - `#expand-connected-btn.active` (활성 색).
- `public/app.js`:
  - 상태 추가: `scope`, `expandConnected`.
  - `buildConnectedGraph()`: 모든 의존성 엣지를 스케줄↔스케줄 그래프로 펼침. 카테고리 endpoint 는 그 카테고리의 모든 스케줄로 expand.
  - `transitivelyConnected(rootIds)`: 위 그래프에서 BFS.
  - `effectiveSchedules()`: scope/expand/검색에 따라 표시 대상 결정. `{schedules, baseIdSet}` 반환 (baseIdSet 으로 "primary vs connected-extra" 구분).
  - `renderCategoryView` 에 `state.scope === 'all'` 분기. all-view 시 `<body>` 에 `scope-all` 클래스 추가, `els.scheduleSectionTitle` 도 "전체 스케줄" 로 변경.
  - 테이블 행: `connected-extra` 면 흐리게 + "·연결" 표식, 카테고리 색 칩 표시 (all-view).
  - 간트 막대: 카테고리 색 띠(`--cat-color` CSS var), connected-extra 면 점선 outline. 막대 텍스트 앞에 `[카테고리] ` 라벨.
  - `selectAllView()` / `selectCategory(id)` 에서 scope 명시적 설정.
  - 토글 버튼 클릭 → state.expandConnected 플립 + 라벨 변경.
  - `loadSchedules`/`loadReports` 가 `categoryId == null` 일 때 안전하게 빈 배열 반환 (all-view 에서 호출되어도 400 오류 안 남).

#### 검증 (Node 단위 + HTTP)
| 케이스 | 기대 | 결과 |
|---|---|---|
| 핸드폰(20) 단독 → BFS expand | {18,19,20} | ✓ |
| 카메라(19) 단독 → BFS expand | {18,19,20} (weak/strong 양방향) | ✓ |
| 카테고리-카테고리 strong dep → 양 카테고리의 모든 스케줄 연결 | {18,19,20,21,22} | ✓ |
| 의존성 없는 고립 스케줄 | 자기 자신만 | ✓ |
| HTML/JS/CSS 마크업·심볼 모두 와이어링 | 200 OK + grep 일치 | ✓ |

#### UX 사용법
- 사이드바 상단 **📊 전체 간트** → 전체 스케줄 한 번에 보기. 카테고리 색 띠 + 막대 텍스트 앞 `[카테고리]` 표시.
- 카테고리 선택 후 스케줄 toolbar 의 **연결 포함 OFF/ON** 버튼 → 의존성으로 연결된 다른 카테고리/스케줄도 함께 (점선 outline + ".연결" 표식). 검색/리스트/간트 모두 적용됨.

### 2026-05-04 10:37 · PROGRESS — Phase 4 v1 (간트 / 드래그 / 검색)
사용자 요청: Phase 4 진행. (Phase 3 검토는 이후에)

#### 결정 / 설계
- **간트 v1 스코프**: 카테고리 단위 간트, actual_* 기반 막대, 드래그로 시프트 + 우측 핸들 리사이즈, 검색, 오늘선.
- **이연 항목 (v2)**: 의존성 화살표, 카테고리 통합(전체) 간트, 검색을 리포트/카테고리까지 확장.
- 막대는 actual_*(엔진 결과) 로 그리고, planned 와 다르면 **주황(`shifted`)** 으로 강조. 드래그/리사이즈는 `planned_*` 를 변경하는 PUT 으로 전송 → 서버가 actual 을 새 planned 로 스냅 + 캐스케이드 실행.
- 1일 = 32px (`GANTT_DAY_WIDTH`). 드래그/리사이즈는 1일 단위로 스냅.
- 날짜 범위는 표시 대상 스케줄들의 모든 일자 + 오늘 의 [최소, 최대] 에 앞 3일 / 뒤 7일 패딩.

#### 구현
- `public/index.html`:
  - 스케줄 섹션 헤더에 검색 input + 리스트/간트 토글 + 추가 버튼을 묶은 toolbar.
  - 간트 컨테이너 `<div id="schedule-gantt">` 추가.
- `public/styles.css`:
  - `.schedule-toolbar`, `.view-toggle`, segmented control 스타일.
  - `.gantt`, `.gantt-grid`, `.gantt-header`, `.gantt-day` (weekend/today 변형), `.gantt-row`, `.gantt-row-track`, `.gantt-bar` (+ shifted, dragging, resize-handle), `.gantt-today-line`.
- `public/app.js`:
  - 상태에 `scheduleView` (`'list'|'gantt'`), `scheduleQuery` 추가.
  - `filteredSchedules()` — 제목 부분 일치 필터링.
  - `renderSchedules()` 가 viewMode 따라 테이블 또는 간트로 분기.
  - `renderGantt()` — 날짜 범위 계산, 헤더(요일 색), 행별 막대 위치 계산, today 세로선.
  - `attachBarDragHandlers / attachBarResizeHandlers` — mousedown/move/up 으로 1일 단위 스냅.
  - `saveScheduleFromGantt(id, planned_start, planned_end)` — PUT `/api/schedules/:id` + cascade alert.
  - 검색 input, 뷰 토글 핸들러.

#### 좌표/일자 변환 검증
- `daysBetweenInclusive('2026-05-01','2026-05-04')` = 4 → 5/4 의 인덱스 = 3 (0-based) ✓
- 막대 폭: 5/3~5/5 (3일) → `(endIdx-startIdx+1)*32` = `(4-2+1)*32` = 96px ✓
- 드래그 dayDelta = `Math.round((finalLeft - origLeft) / 32)` — 실제 mousemove 가 32px 단위로 스냅하므로 정밀 ✓

#### 스모크 테스트
| 항목 | 결과 |
|---|---|
| HTML / CSS / JS 200 OK | ✓ |
| view-toggle / 검색 / 간트 컨테이너 마크업 존재 | ✓ |
| 간트 JS 심볼 (`renderGantt`, `attachBarDrag*`, `saveScheduleFromGantt`) 존재 | ✓ |
| 드래그 결과 PUT (=수동 PUT 시뮬) → cascade 응답 형식 정상 | ✓ |

#### UX 사용법
1. 카테고리 선택 → 스케줄 섹션 헤더의 **간트** 버튼 클릭.
2. 막대를 끌어 일정 시프트 (1일 단위 스냅) — 손 놓는 순간 PUT + 캐스케이드 alert.
3. 막대 우측 6px 핸들을 끌어 종료일 늘리기/줄이기.
4. 검색창에 단어 입력 — 리스트와 간트 모두 즉시 필터링.
5. 빨간 세로선 = 오늘. 회색 배경 컬럼 = 주말.

### 2026-05-04 10:29 · PROGRESS — Phase 3 완료 (일일 리포트 + 첨부)
사용자 요청: Phase 3 진행. 1.2 일일 리포트 요구사항(카테고리별 또는 통합 작성, 카테고리 태그, 본문, 첨부 업로드 / 로컬 경로) 구현.

#### 결정 / 설계
- 리포트는 단일 entity, 카테고리와 N:N (`report_categories`). 한 리포트가 여러 카테고리 태그를 가질 수 있고, 카테고리 화면에서는 자기 태그된 리포트만 필터링해 표시.
- 첨부는 폴리모픽 두 종류(`upload`, `local_path`):
  - **upload**: `multer` 가 `./uploads/` 에 무작위 파일명으로 저장. DB는 저장 파일명(상대), 원래 파일명(`display_name`), 크기 보존.
  - **local_path**: 사용자가 입력한 절대경로를 DB에만 저장. 서버는 파일을 만지지 않음.
- 로컬 경로 클릭 시 동작은 브라우저 정책에 좌우됨 (`file://` 가 차단되는 경우 多). 보조 수단으로 **클립보드 복사** 버튼을 추가.
- 모달 UX: 신규 작성 시 첨부 섹션은 숨김 → 저장 후 자동으로 편집 모드 전환 + 첨부 섹션 노출 (첨부는 `report_id` 필요).

#### 구현
- `src/db.js`: 3개 테이블 + 인덱스 추가, 모두 ON DELETE CASCADE.
- `src/routes/reports.js` 신규: CRUD + 다중 태그 처리(트랜잭션 안에서 `report_categories` 재작성), 검증(날짜 형식, body 길이, 카테고리 존재).
- `src/routes/attachments.js` 신규:
  - `multer.diskStorage` 로 `./uploads/` 에 저장. 파일 크기 50MB 제한.
  - 두 엔드포인트 (`/upload` multipart, `/local` JSON).
  - 첨부 삭제 시 `upload` 종류면 `fs.unlink` (best-effort).
  - 외부에서 호출할 수 있는 `cleanupUploadedFiles` 헬퍼 export.
- `src/routes/reports.js` DELETE: 삭제 직전 업로드 첨부 경로 수집 후 row 삭제(FK cascade로 attachments 행 자동 삭제), 그 후 `cleanupUploadedFiles` 호출하여 디스크 정리.
- `src/server.js`: `reportsRouter` 등록, `attachmentsRouter` 를 `/api` 에 mount, `/uploads` 정적 서빙.
- `package.json`: `multer ^1.4.5-lts.1` 추가.
- `public/index.html`: 카테고리 뷰 하단에 리포트 테이블 + "+ 리포트 작성" 버튼 + 리포트 모달 + 로컬 경로 모달.
- `public/styles.css`: 카테고리 태그 칩, 첨부 리스트 스타일, 모달 카드 너비 보강.
- `public/app.js`:
  - 상태 / 셀렉터에 reports 관련 추가.
  - `renderReports`, `renderReportCategoryChecks`, `renderAttachmentList` 추가.
  - 모달 열기/저장 흐름: 신규 → 저장 후 편집 모드 자동 전환 + 첨부 섹션 노출.
  - `toFileHref(path)`: POSIX / Windows 드라이브 / Windows UNC 경로를 `file://` URL 로 변환.
  - 첨부 추가/삭제/복사 핸들러.
  - 모달 close + click-outside 핸들러에 신규 모달 두 개 포함.

#### 스모크 테스트 결과
| 시나리오 | 결과 |
|---|---|
| 한 리포트에 카테고리 2개 태그 + 생성 | ✓ |
| 파일 업로드 (multipart) | ✓ 201 + 저장 |
| 로컬 경로 등록 | ✓ 201 |
| `/uploads/<filename>` 서빙 | ✓ 200 |
| `?category_id=` 필터 | ✓ |
| PUT 으로 카테고리 태그 교체 + 날짜 변경 | ✓ |
| 잘못된 날짜 / 존재 안 하는 카테고리 / 빈 path | ✓ 400 + 에러 코드 |
| 리포트 삭제 → 첨부 cascade + 디스크 파일 정리 | ✓ uploads 폴더에서 사라짐 |

#### 알려진 제약
- 로컬 경로 클릭 시 `file://` 링크는 브라우저 보안 정책 때문에 차단될 수 있음. 클립보드 복사 버튼으로 우회.
- 첨부는 리포트 저장 후에만 추가 가능 (모달이 자동으로 편집 모드 전환됨).

### 2026-05-04 10:10 · CHANGE / PROGRESS — 계획 갱신 순서 버그 수정 (backward 전체 → forward 전체)
사용자 보고: 핸드폰 계획을 5/13 으로 옮겼는데, "계획 갱신" 후에도 카메라(5/18~5/25)가 안 당겨지고 핸드폰만 5/26~6/5 로 뒤로 밀려있음.

#### 원인 진단
이전 `recomputeAll` 은 스케줄별로 `recomputeFromScheduleChange(id)` 를 planned_start 오름차순으로 호출. 각 호출은 backward 패스 → forward 패스 순으로 실행됨. 사용자 데이터에서 처리 순서:
1. 디스플레이 (5/3) 처리 — backward 무관, forward 가 핸드폰을 5/26 으로 밀어버림
2. 핸드폰 (5/13) 처리 — 이미 5/26 에 있으므로 backward 가 카메라를 안 당김
3. 카메라 (5/18) 처리 — forward 만 의미 있는데 핸드폰 이미 5/26, 안 밀림

즉, **다른 스케줄의 forward 가 한 스케줄의 backward 트리거 조건을 미리 해소**해버려 backward pull 이 무력화됨.

#### 결정
- `backwardPass` / `forwardPass` 를 독립 함수로 분리.
- 단일 변경 (`recomputeFromScheduleChange`): 두 패스를 같은 entity 에서 순차 실행 (기존 동작 동일).
- 전체 갱신 (`recomputeAll`): **모든 스케줄에 backward 먼저 → 그 다음 모든 스케줄에 forward**. 이렇게 하면 어느 스케줄에서든 backward 가 forward 에 의해 선점되지 않음.

#### 구현
- `src/engine/scheduler.js`:
  - `recomputeFromScheduleChange` 의 두 BFS 를 `backwardPass(initial, result)` / `forwardPass(initial, result)` 모듈 함수로 추출.
  - `recomputeFromScheduleChange` 는 두 함수를 순차 호출하는 얇은 래퍼.
  - `recomputeAll` 은 트랜잭션 내에서: 스냅 → 모든 id 에 대해 backward → 모든 id 에 대해 forward → dedupe.

#### 검증 (사용자 실 데이터)
| 스케줄 | 갱신 전 actual | 갱신 후 actual |
|---|---|---|
| 디스플레이 | 5/3 ~ 5/9 | 5/3 ~ 5/9 (변화 없음, slack 3일) |
| **핸드폰** | 5/26 ~ 6/5 (이전 forward 결과) | **5/13 ~ 5/23 (사용자 계획 그대로)** ✓ |
| **카메라** | 5/18 ~ 5/25 (planned 그대로) | **5/5 ~ 5/12 (-13일 당겨짐)** ✓ |

응답: `shifted: [{id 19 카메라, delta -13, ns 5/5, ne 5/12}]` / `conflicts: []`.

#### 부수 메모
- 사용자가 "디스플레이 침범" 이라 언급했지만, 핸드폰 계획(5/13~5/23) 과 디스플레이(5/3~5/9) 는 겹침이 없음. 실제 침범된 건 카메라(5/18~5/25).
- 디스플레이는 이번 갱신에서 변하지 않는 게 정상. 카메라가 5/12 로 당겨지면서 디스플레이는 weak 형제로서 slack 3일(=5/12−5/9) 표시됨.

### 2026-05-04 09:55 · CHANGE / PROGRESS — 양방향 캐스케이드 (즉시저장 자기 검증 + 선행 당김)
사용자 두 가지 요청:
1. 즉시 저장 시점에도 변경된 스케줄이 자기 선행을 위반하는지 검사하도록.
2. 후행이 선행 종료일자 이전으로 당겨지면 선행도 함께 자동 당겨지도록.

#### 결정
- 두 요청 모두 같은 엔진 변경으로 충족 — `recomputeFromScheduleChange` 가 이전엔 후행 방향(forward)만 BFS 했지만, 이제 **선행 방향(backward) BFS** 도 함께 실행.
- 동작 의미:
  - **forward (기존)**: 변경 entity 의 종료가 후행 시작보다 늦으면, 후행을 뒤로 밀기.
  - **backward (신규)**: 변경 entity 의 시작이 선행 종료보다 이르면, 선행을 앞으로 당기기.
- `auto_shift` / `warn_only` 정책은 양 방향에서 동일 적용.
- `recomputeAll` (계획 갱신) 도 자동으로 양방향 처리됨 (각 스케줄에 대해 `recomputeFromScheduleChange` 를 호출하므로).

#### 구현
- `src/engine/scheduler.js`:
  - `recomputeFromScheduleChange` 를 두 BFS 패스로 재작성. 각각 별도 visited set / queue.
  - 시프트 결과의 `delta_days` 가 부호 있게 됨 (음수 = 앞당김, 양수 = 뒤로밀기).
- `public/app.js`:
  - `describeShift(sh)` 헬퍼 추가 — delta 부호에 따라 "↓ 자동 밀기" / "↑ 자동 당김" 표시.
  - 캐스케이드 alert 과 계획 갱신 결과 메시지 모두 부호 인식.

#### 검증
| 시나리오 | 기대 | 결과 |
|---|---|---|
| 디스플레이(5/3-5/9) → 핸드폰(5/19-5/29) strong, 핸드폰을 5/8 로 PUT | 디스플레이가 -2일 당겨져 5/1-5/7 | ✓ |
| 추가로 핸드폰을 5/3 로 PUT | 디스플레이가 -5일 더 당겨져 4/26-5/2 | ✓ |
| 핸드폰을 5/19 로 되돌림 | cascade=[] (제약 없음) | ✓ |
| warn_only 모드에서 핸드폰을 5/5 로 당김 | 디스플레이 안 당겨지고 충돌 메시지만 보고 | ✓ |
| 기존 forward 동작 (선행 변경 → 후행 자동 밀기) | 그대로 유지 | ✓ (recompute에서 카메라 5/25 → 핸드폰 +7일 자동 밀기 확인) |

#### 부수 효과
- 사용자 데이터에 의존성 방향이 직접 정정된 상태가 확인됨 (id 15: 카메라→핸드폰, id 16: 디스플레이→핸드폰 strong auto_shift). 정정 후 recompute 결과 카메라 종료(5/25) 때문에 핸드폰이 5/19 → 5/26 으로 +7일 자동 밀림. 정상 동작.

### 2026-05-04 08:13 · PROGRESS — 의존성 편집 기능 추가
사용자 요청: 의존성도 편집할 수 있게 해달라. (현재까지는 추가/삭제만 가능)

#### 결정
- POST 와 동일한 검증을 거치는 PUT 라우트 추가.
- **사이클 검증의 일반화**: 편집 시 자기 자신을 그래프에서 제외하지 않으면 자기 자신이 자기 자신을 가리키는 듯한 오판이 가능 → `wouldCreateCycle` 에 `excludeEdgeId` 옵션 추가.
- 편집은 자동 재계산 트리거 안 함 (계획 갱신 버튼 정책 유지).

#### 구현
- `src/engine/scheduler.js`: `wouldCreateCycle(...args, excludeEdgeId = null)` 으로 시그니처 확장. SQL 에 `AND id != ?` 조건 추가.
- `src/routes/dependencies.js`:
  - 검증 로직을 `validateDependencyPayload(payload, edgeIdForCycleExclude)` 헬퍼로 통합 (POST/PUT 공유).
  - `PUT /api/dependencies/:id` 신규: 부분 업데이트(미입력 필드는 기존값 유지). `validateDependencyPayload` 에 `id` 전달해 자기 자신 제외하고 cycle 검사.
  - UNIQUE 위반 시 409 duplicate.
- `public/index.html`: 의존성 모달 제목에 `id="dependency-modal-title"` 부여.
- `public/app.js`:
  - `openDependencyModal(dep = null)` — dep 가 있으면 편집 모드. 모달 제목/폼 데이터셋/필드 prefill (entity 셀렉터는 type 설정 후 populateEntitySelect 다시 부르고 value 설정).
  - 의존성 행에 `편집` 버튼 추가, 클릭 시 `openDependencyModal(dep)`.
  - submit 핸들러: `dataset.editId` 있으면 PUT, 없으면 POST.

#### 검증
| 케이스 | 결과 |
|---|---|
| link_type strong → weak 편집 | ✓ |
| on_delay auto_shift → warn_only 편집 | ✓ |
| pred/succ 스왑 (a→b → b→a) | ✓ |
| 자기 자신 값으로 편집 (no-op) | ✓ — excludeEdgeId 덕분에 cycle 오판 없음 |
| 편집으로 사이클 만들기 | (테스트 셋업 자체가 cycle protection 에 먼저 막혀 직접 검증은 불가, 검증 로직은 POST 와 동일하므로 동작 보장) |

### 2026-05-04 08:07 · CHANGE — UI 안내 강화 (선행/후행 라벨)
사용자가 "핸드폰이 선행 아닌가요?" 라며 선행/후행 정의를 헷갈림. 실제로 의존성을 거꾸로 등록해 갱신 시 카메라/디스플레이가 핸드폰 종료(5/29) 이후로 시프트되는 결과가 나옴.

#### 결정
- 데이터는 그대로 두고 사용자가 직접 정정하도록 안내. 동시에 **UI 라벨에서 선행/후행의 정의가 한눈에 보이도록** 변경.

#### 구현
- `public/index.html`:
  - 의존성 패널 헤더: `선행 (pred)` / `후행 (succ)` → **`선행 (먼저 끝남)`** / **`후행 (나중에 시작)`**
  - 의존성 모달 안내문 / 라벨 동일하게 보강 ("선행 종류 (먼저 끝남)" / "후행 종류 (나중에 시작)")

### 2026-05-04 08:01 · CHANGE / PROGRESS — 사용자 피드백 2차 반영 (계획일수 입력 UX)
사용자 요청: 스케줄 입력 시 시작일과 종료일에서 **계획일수**를 자동 계산하고, 일수를 변경하면 종료일이 자동 갱신되도록.
예시: 5/3 ~ 5/5 → 일수 3, 일수를 8로 바꾸면 종료일이 5/10 (5/3 포함, inclusive count).

#### 결정
- **계획일수는 DB에 저장하지 않음**. 시작/종료에서 항상 파생되는 값. 저장하면 비정합 발생 위험만 큼.
- **양방향 동기화 규칙**:
  - 시작일 변경 → 일수 보존, 종료일 = 시작일 + (일수 − 1)
  - 종료일 변경 → 시작일 보존, 일수 재계산
  - 일수 변경    → 시작일 보존, 종료일 = 시작일 + (일수 − 1)

#### 구현
- `public/index.html`: 스케줄 모달의 시작/종료 옆에 `<input name="planned_days" type="number">` 추가. 스케줄 테이블에 **일수** 컬럼 신설(계획 종료 우측).
- `public/app.js`:
  - 헬퍼 `daysBetweenInclusive(s,e)` (포함 카운트), `addDaysIso(iso, days)` 추가.
  - 모달 열림 시 일수 = 시작/종료에서 자동 계산하여 prefill.
  - 시작일/종료일/일수 각각의 change/input 이벤트로 양방향 동기화.
  - 테이블 렌더에 `일수` 컬럼 표시. 빈 상태 행 colspan 8 → 9 갱신.
- 서버 API는 변경 없음 (일수는 클라이언트에서만 다룸).

#### 검증 (Node 단위 계산)
| 입력 | 기대 | 결과 |
|---|---|---|
| 5/3 ~ 5/5 | 3일 | ✓ |
| 5/3, 일수 8 → 종료 | 5/10 | ✓ |
| 5/3 ~ 5/3 | 1일 | ✓ |
| 5/30, 일수 5 → 종료 | 6/3 (월 경계) | ✓ |
| 12/30, 일수 5 → 종료 | 다음해 1/3 (연 경계) | ✓ |
| 윤년 2/28 + 1 | 2/29 | ✓ |

### 2026-05-04 07:49 · CHANGE / PROGRESS — 사용자 피드백 1차 반영
사용자 실사용 결과 두 가지 이슈 보고됨:
1. 의존성을 추가했는데 일정이 안 바뀐다 → 원인은 두 가지: (a) 캐스케이드는 스케줄 변경에서만 트리거됨, 의존성 생성에서는 안 됨 / (b) 변하는 컬럼은 "실제 시작/종료" 인데 사용자가 "계획" 컬럼을 보고 있었던 것
2. 두 strong 의존성 중 하나가 추가되지 않더라 → 사이클 검출이 weak 엣지를 따라가서 오판하는 버그

#### 결정 (계획 변경)
- **의존성 추가 시 자동 재계산하지 않는다.** 대신 상단 바에 **"계획 갱신"** 버튼을 추가해 사용자가 명시적으로 트리거. 이유: 사용자가 의존성을 한꺼번에 정리한 뒤 의도된 시점에 일괄 적용하길 원함.
- 사이클 검출에서 **weak 엣지 제외**. 이유: weak 은 방향성 없는 관계(slack 공유)이므로 strong 사이클 판정에 관여해서는 안 됨. (실제 케이스: `핸드폰 →strong→ 디스플레이 →weak→ 카메라` 가 있을 때 `카메라 →strong→ 핸드폰` 추가가 잘못 거부되던 문제.)

#### 구현
- `src/engine/scheduler.js`:
  - `wouldCreateCycle` SQL 에 `AND link_type = 'strong'` 추가.
  - `recomputeAll` 신규: 트랜잭션 안에서 모든 스케줄의 actual_*를 planned_*로 스냅한 뒤, planned_start 오름차순으로 `recomputeFromScheduleChange`를 호출, 결과(shifted/conflicts)를 dedupe 해 반환.
- `src/server.js`: `POST /api/recompute` 라우트 등록.
- `public/index.html`: 상단 바에 **"계획 갱신"** 버튼 추가, 의존성 모달에 **"선행 → 후행 = 선행 작업이 끝나야 후행 작업이 시작"** 안내문 추가.
- `public/styles.css`: `.topbar-spacer` 추가로 버튼을 우측 정렬.
- `public/app.js`: 갱신 버튼 핸들러(요청 → 결과 alert로 변경 항목/충돌 나열).

#### 스모크 테스트 통과
- 기존 weak 엣지 위에서 새 strong 추가 → 201 (이전: 잘못된 cycle_detected)
- 진짜 strong 사이클 (A→C 위에 C→A 추가) → 400 (정상)
- POST /api/recompute → 사용자 데이터에서 의존성 8 (핸드폰→디스플레이) 때문에 디스플레이/조립이 5/9~5/12 로 +1일 자동 시프트됨을 확인

#### 이 변경의 사용 시점
- 사용자는 의존성을 추가/수정한 뒤 **상단 "계획 갱신"** 을 눌러 전체 일정을 다시 계산. 결과는 alert에 나열되며, 화면의 스케줄 테이블의 "실제 시작/종료" 컬럼이 굵은 글씨로 갱신됨.
- 사용자 데이터에서 발견된 방향 이슈(의존성 8: `핸드폰→디스플레이`)는 사용자 의도가 거꾸로일 수 있으므로 **사용자 확인 필요**. 의도가 `디스플레이→핸드폰` 이라면 의존성 8을 삭제하고 새로 등록해야 함.

### 2026-05-04 07:32 · PROGRESS
- **Phase 2 완료**.
- `src/db.js` 에 `dependencies` 테이블 추가 (다형 키 + UNIQUE(pred,succ,link_type) + 인덱스 2개).
- `src/engine/scheduler.js` 신규: `recomputeFromScheduleChange` (BFS 캐스케이드, auto_shift / warn_only 분기), `slackDaysFor` (weak 엣지 기반), `wouldCreateCycle` (직접 사이클 + 컨테이너 사이클 검사 — 컨테이너는 라우트에서 별도로 가드).
- `src/routes/dependencies.js` 신규: 검증(타입/엔티티 존재/자기참조/컨테이너 사이클/일반 사이클/UNIQUE 중복).
- `src/routes/schedules.js` 갱신: 응답 스키마를 `{ schedule, cascade }` 로 변경, GET 응답에 `slack_days` 첨부, PUT 시 plannedChanged 면 actual을 planned로 스냅 후 캐스케이드.
- `src/routes/categories.js` / `schedules.js` DELETE: 다형 키 때문에 FK 사용 불가 → 트랜잭션에서 의존성 행을 명시적으로 삭제하도록 보강.
- `public/index.html` / `styles.css` / `app.js` 갱신: 의존성 패널/모달, `slack_days` 컬럼, 실제일정이 계획과 다르면 굵게 표시, 캐스케이드/충돌 발생 시 alert.

#### 검증 결과 (실제 측정값)
| 시나리오 | 기대 | 결과 |
|---|---|---|
| 카메라 5/4 → 5/8, 조립 strong succ (auto_shift) | 조립 5/9~5/11 | ✓ +4일 시프트 |
| 디스플레이 (카메라의 weak sibling) | slack 4일 | ✓ slack_days=4 |
| 카메라 5/12, 동일 strong 엣지 (warn_only) | 조립 변경 없음 + conflict | ✓ shifted=[] / conflicts=[required 5/13] |
| 카테고리 레벨 cam→asm + 카메라에 새 스케줄 5/15 | 조립 카테고리 +7일 | ✓ delta_days=7 |
| 사이클 (asm→cam 추가 시도) | 400 cycle_detected | ✓ |
| 자기 참조 / 컨테이너 사이클 | 400 self_loop / container_cycle | ✓ |
| 스케줄/카테고리 삭제 | 관련 의존성 정리 | ✓ (Phase 2 작업 중 발견된 결함, 즉시 수정) |

#### Phase 2 진행 중 변경된 계획
- **응답 스키마 변경 (BREAKING)**: `POST/PUT /api/schedules` 가 이전엔 스케줄 객체를 평탄하게 반환했으나, 캐스케이드 결과를 함께 알려야 해서 `{ schedule, cascade }` 로 변경. UI 클라이언트도 함께 갱신.
- **고아 의존성 처리 추가**: 다형 키라 SQLite FK 사용 불가. 카테고리/스케줄 라우트의 DELETE에 의존성 정리 로직을 트랜잭션으로 추가.
- **weak 엣지 의미 단순화**: 초기 계획은 "공유된 후행을 통해 자동으로 형제로 묶기" 였으나, 사용자가 명시적으로 weak 엣지를 추가하는 모델로 단순화 (UI에서 link_type=weak 선택). 형제 자동 추론은 Phase 4(또는 별도) 로 이연.

### 2026-05-04 07:12 · PROGRESS
- **Phase 1 완료**.
- 프로젝트 구조 생성 (`src/`, `src/routes/`, `src/engine/`, `public/`, `data/`, `uploads/`).
- `package.json` + `npm install` 으로 `express@4`, `better-sqlite3@11` 설치.
- `src/db.js`: SQLite 초기화, WAL 모드, FK ON, `categories` / `schedules` 테이블 생성. 스케줄에는 `actual_start/actual_end` 컬럼도 미리 포함(Phase 2 재마이그레이션 회피).
- `src/routes/categories.js`, `src/routes/schedules.js`: 전체 CRUD + 검증(이름 필수/중복, 날짜 형식·역전, 상태 enum, FK).
- `src/server.js`: Express + 정적 서빙 + JSON 파싱 + 에러 핸들러.
- `public/index.html` + `styles.css` + `app.js`: 사이드바(카테고리) + 메인(스케줄 테이블) + 모달 기반 추가/편집/삭제.
- 스모크 테스트 통과 (health, 3개 카테고리 + 1개 스케줄 생성, 중복 이름 409, 날짜 역전 400, 카테고리 삭제 시 자식 스케줄 cascade 정리).

### 2026-05-03 22:12 · PROGRESS
- `md/PROJECT_LOG.md` 생성. 요구사항·계획·진행 누적용 단일 로그 파일 도입.

### 2026-05-03 22:00 · DECIDE
- **스택 확정**: 백엔드 Node.js + Express, DB SQLite, 프론트 Vanilla HTML/CSS/JS.
- "java"는 JavaScript 의미로 확인됨.

### 2026-05-03 21:55 · REQ
- **약한 연결의 정의 명확화**: 같은 후행 작업을 향하는 형제들 사이에서, 한쪽이 critical로 밀리면 나머지는 그만큼 여유(slack)가 생기는 것으로 표시.
- **충돌 처리 정책**: `auto_shift` / `warn_only` 두 모드를 엣지 단위로 저장. 발생 시점에 메시지로 알림.
- 단일 사용자 / 로컬 파일 / 웹앱(HTML·JS·CSS) 확정.

### 2026-05-03 21:51 · REQ
- 프로젝트 초기 아이디어 수립.
- 카테고리 기반 스케줄러 + 카테고리/스케줄 단위의 다층 의존성.
- 일일 리포트(카테고리 태그 + 첨부파일/로컬 경로) 요구.
- 핸드폰 조립 예시로 strong/weak 의존 개념 합의.
