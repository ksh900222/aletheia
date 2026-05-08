# Cowork Server 구성 — 작업 계획서

> 팀(6명, 향후 확장) 간 계획·리포트를 읽기 전용으로 공유하기 위한 peer-to-peer 구성
> 마지막 업데이트: 2026-05-08

---

## 1. 목표 및 사용 시나리오

### 1.1 목표
- 각 팀원의 Project Planner 인스턴스가 **서로의 데이터를 읽기 전용으로 조회**할 수 있도록 함
- 별도 중앙 서버 없이, 각 인스턴스가 동시에 **클라이언트이자 서버** 역할
- 팀 규모 변동(현재 6명 → 확장)을 설정 파일 수정만으로 반영 가능

### 1.2 핵심 사용 시나리오
1. 사용자가 상단의 **「팀 전체계획 OFF」** 버튼을 누름
2. 버튼이 **「팀 전체계획 ON」** 으로 바뀌며, 등록된 팀원들의 인스턴스에 동시 접속
3. 연결 가능 peer는 데이터를 받아오고, 실패한 peer는 별도 표기
4. 받아온 데이터는 본인 데이터와 함께 **전체 간트 / 카테고리 / 스케줄 / 전체 보고서** 화면에 통합 표시 (단, 읽기 전용·소유자 표시)
5. ON 상태에서는 **60초 간격으로 자동 갱신** + 수동 「지금 갱신」 버튼 제공
6. **「팀 전체계획 ON」** 을 다시 누르면 OFF로 돌아가며, 팀원 데이터는 화면에서 사라짐 (삭제가 아닌 비표시)

### 1.3 제약
- 팀원 데이터는 **절대 수정·삭제 불가** (UI에서 편집 진입점 차단 + 서버에서도 read-only enforcement)
- 팀원 데이터는 **본인 SQLite DB에 영구 저장하지 않음** (메모리 캐시만 사용)
- 사내망 환경 가정 (인터넷 노출 X)

---

## 2. 아키텍처 개요

```
[A의 인스턴스]                    [B의 인스턴스]
 ├─ Express 서버                   ├─ Express 서버
 │   ├─ 기존 라우트 (read/write)   │   ├─ 기존 라우트 (read/write)
 │   └─ /api/team/* (read-only)  ←─→  └─ /api/team/* (read-only)
 ├─ SQLite (본인 DB)               ├─ SQLite (본인 DB)
 └─ 메모리 캐시 (팀원 스냅샷)       └─ 메모리 캐시 (팀원 스냅샷)

         ↑
         │ Peer-to-peer HTTP (공유 토큰 인증)
```

### 2.1 데이터 흐름 (ON 토글 시)
```
1. UI: ON 버튼 클릭
2. Frontend → Backend: POST /api/team/sync (수동 또는 60s 타이머)
3. Backend: peers.json 읽음 → 각 peer에 병렬 GET /api/team/version
4. Backend: version 변경된 peer에만 GET /api/team/snapshot
5. Backend: 메모리 캐시에 ownerId namespace로 저장
6. Frontend: GET /api/team/state → 통합 데이터 + peer 상태 패널 갱신
```

---

## 3. 설정 / 인증

설정은 두 파일로 분리한다 — 자주 편집하는 peer 목록은 CSV, 거의 안 바뀌는 앱 설정은 JSON.

### 3.1 `data/team_peers.csv` (신규, 사용자 편집 대상)
- **포맷**: UTF-8 with BOM (Excel에서 한글 정상 표시)
- **열 순서 고정**: `name, host, port` (사용자 직관성 우선)
- **첫 행은 헤더** (파서가 헤더 검증)
- **빈 줄·`#` 시작 행은 무시** (사용자 메모 허용)

예시 (`data/team_peers.example.csv`로 커밋):
```csv
name,host,port
홍길동,192.168.1.11,3000
이영희,192.168.1.12,3000
박철수,192.168.1.13,3000
최민수,192.168.1.14,3000
정수연,192.168.1.15,3000
```

**왜 CSV인가**: 의존성 추가 없음(`xlsx` 라이브러리 불필요), 텍스트 diff 용이, 파일 변경 감지가 신뢰성 있음, Excel·메모장 모두 편집 가능. XLSX는 바이너리라 파일 감지·머지·브로드캐스트가 모두 까다로워짐.

**식별자(primary key)**: `name`. IP/port는 환경에 따라 변할 수 있으므로 이름이 안정적인 키. 동명이인 회피는 운영 규칙으로 처리(예: "홍길동(개발)").

### 3.2 `data/team_settings.json` (신규)
```json
{
  "self": { "name": "김상훈", "port": 3000 },
  "sharedToken": "TEAM-PRESHARED-KEY-CHANGE-ME",
  "syncIntervalSec": 60,
  "requestTimeoutMs": 5000,
  "peerBroadcast": { "enabled": true, "debounceMs": 500 }
}
```
- 두 파일 모두 `.gitignore` (토큰 노출 방지)
- `team_peers.example.csv`, `team_settings.example.json` 만 커밋

### 3.3 인증 방식
- 모든 `/api/team/*` 요청은 헤더 `X-Team-Token: <sharedToken>` 필수
- 토큰 불일치 시 `401`
- 평문 HTTP — 사내망 한정 사용 (외부 노출 금지를 README에 명시)

### 3.4 CSV 파일 변경 감지 (live reload)
- `src/engine/peerWatcher.js` (신규): `fs.watch('data/team_peers.csv')` + 500ms debounce
- 변경 감지 시:
  1. CSV 재파싱 → 검증(헤더, 포트 숫자, host 형식)
  2. 검증 실패 시 콘솔·UI 토스트로 에러 표시 + 이전 값 유지
  3. 검증 성공 시 in-memory peer list 교체 + `lastReloadedAt` 갱신
  4. ON 상태였다면 sync 사이클 즉시 1회 실행
  5. **broadcast 트리거**: §3.5 참고 (사용자 직접 편집인 경우만)
- 프로그램 재시작 불필요. 사용자는 CSV 저장만 하면 즉시 반영.

### 3.5 Peer 정보 자동 전파 (broadcast)
사용자 1명이 본인 CSV에 새 peer를 추가/수정하면, ON/OFF와 무관하게 모든 peer에게 자동으로 전파되어 각자의 CSV에 반영된다.

**흐름**:
```
A의 CSV 편집 → peerWatcher 감지 → A의 이전 peer list와 diff 계산
            → 변경된 행(추가/수정)에 대해 모든 peer로 POST /api/team/peer-update
            → 각 peer는 토큰 검증 후 자기 CSV에 upsert (이름 키 기준)
            → 각 peer의 peerWatcher가 재발화 — 이때 "수신 origin"이면 재브로드캐스트 차단
```

**브로드캐스트 페이로드** (`POST /api/team/peer-update`):
```json
{
  "origin": "김상훈",
  "entries": [
    { "name": "신입직원", "host": "192.168.1.20", "port": 3000 }
  ],
  "ts": "2026-05-08T10:30:00+09:00"
}
```

**무한 루프 방지**:
- 수신 측에서 CSV에 쓰기 직전 `inboundWriteFlag = true` 설정 → peerWatcher가 다음 변경 이벤트 1회만 broadcast 스킵
- 또는: 마지막 broadcast의 `(name, host, port)` set을 기억해, 같은 내용의 변경 이벤트는 스킵
- 두 방식 병행 권장 (debounce + dedupe)

**충돌 처리**:
- 같은 이름에 다른 host/port가 들어온 경우 → **last-write-wins** (수신 시각 기준)
- 사용자에게는 토스트로 "OOO이(가) 'XX'의 정보를 갱신했습니다" 알림 표시

**삭제 전파 정책**: 이번 단계에서는 **추가/수정만 전파**. CSV에서 한 행을 지워도 다른 인스턴스에서 자동으로 지워지지 않음 (실수 보호). 명시적인 「peer 제거 전파」 버튼은 향후 검토.

**제외 대상**:
- 자기 자신(`self.name`)이 들어 있는 행은 broadcast 시 제외
- 수신한 entry에 본인 이름이 있으면 무시 (자기 자신은 self 정보로 관리)

---

## 4. 서버 측 구현

### 4.1 신규 라우트 — `src/routes/team.js`

| Method | Path                       | 용도                                                     |
|--------|----------------------------|----------------------------------------------------------|
| GET    | `/api/team/version`        | 본인 DB의 최종 수정 timestamp 또는 hash 반환            |
| GET    | `/api/team/snapshot`       | 본인 데이터 전체(JSON: categories, schedules, reports, deps, attachments meta) 반환 |
| POST   | `/api/team/peer-update`    | (외부 peer가 호출) peer 정보 upsert 수신 — §3.5 참고     |
| POST   | `/api/team/sync`           | (자기 자신용) ON 모드에서 모든 peer fetch 트리거         |
| GET    | `/api/team/state`          | (자기 자신용) 통합 데이터 + peer별 연결 상태 반환         |
| POST   | `/api/team/toggle`         | ON/OFF 상태 전환 + 첫 sync 트리거                        |
| GET    | `/api/team/peers`          | (자기 자신용) 현재 메모리 상의 peer list 반환 (UI 표시용)|

- `/version`, `/snapshot`, `/peer-update` 는 외부 peer가 호출 → 토큰 검증 필수
- `/sync`, `/state`, `/toggle`, `/peers` 는 본인 UI만 호출 → 토큰 불필요(localhost 한정)

### 4.2 메모리 캐시 — `src/engine/teamCache.js` (신규)
```js
{
  mode: "OFF" | "ON",
  lastSyncAt: ISO8601,
  peers: {
    "B": {
      status: "ok" | "fail" | "loading" | "timeout",
      lastSuccessAt: ISO8601 | null,
      lastError: string | null,
      version: string | null,
      data: { categories: [...], schedules: [...], reports: [...], dependencies: [...] }
    },
    ...
  }
}
```
- 서버 재시작 시 OFF로 초기화
- ID 충돌 방지: 캐시 데이터의 모든 ID는 응답 시 `"<ownerId>:<localId>"` 로 변환

### 4.3 Sync 로직 (`src/engine/teamSync.js` 신규)
1. peerWatcher에서 유지하는 in-memory peer list 사용 (CSV 직접 읽지 않음)
2. 각 peer에 병렬 `GET /version` (timeout 5s)
3. 응답 version이 캐시된 version과 다르면 `GET /snapshot`
4. 결과를 cache에 반영, 실패한 peer는 status `fail`/`timeout` + `lastError` 기록
5. 모든 peer 처리 완료 후 `lastSyncAt` 갱신 → 프론트가 polling으로 인지

### 4.4 자동 갱신 타이머
- ON 진입 시 `setInterval(syncAllPeers, 60_000)` 시작
- OFF 전환 시 `clearInterval`
- 사용자 설정값(`syncIntervalSec`)으로 조절 가능

---

## 5. 프론트엔드 구현

### 5.1 UI 변경 사항
1. **상단 헤더**: 「팀 전체계획 OFF / ON」 토글 버튼 추가
2. **상태 아이콘**: ON일 때 헤더에 작은 점등 아이콘 (peer N/M 연결됨) — 클릭 시 상태 패널 토글
3. **상태 패널**: peer별 카드 (이름, 상태, 마지막 성공 갱신 시각, 에러 메시지)
   - 「지금 갱신」 버튼
   - X 버튼으로 닫을 수 있고, 헤더 아이콘으로 다시 열 수 있음
4. **다운로드 완료 팝업**: 모든 peer 처리 완료 시 (실패 제외하고 성공한 peer만 카운트) 1회 표시 → "n명 데이터 동기화 완료"

### 5.2 화면별 통합 표시 규칙

| 화면         | 본인 데이터 | 팀원 데이터 표시 방식                                      |
|--------------|-------------|------------------------------------------------------------|
| 전체 간트    | 정상        | 행에 소유자 뱃지(이름 색상) + 클릭/드래그 비활성화         |
| 카테고리     | 정상        | 본인 항목 아래 "팀원 카테고리" 섹션, 그룹 by 소유자        |
| 스케줄       | 정상        | 본인 항목과 함께 표시, 소유자 뱃지, 우클릭 메뉴에 편집 항목 제거 |
| 전체 보고서  | 정상        | 날짜별로 본인+팀원 모두 표시, 소유자 뱃지, 본문 클릭 시 읽기 전용 모달 |

### 5.3 읽기 전용 enforcement
- 모든 항목에 `data-owner` 속성 부여 → `data-owner !== self` 인 경우:
  - 클래스 `team-readonly` 추가 (CSS로 hover 효과 변경)
  - 클릭 핸들러에서 early return
  - 컨텍스트 메뉴에서 편집/삭제 항목 제외

### 5.4 상태 polling
- ON 동안 프론트가 5초마다 `GET /api/team/state` 호출하여 상태 패널·뱃지 갱신
- (서버 측 60초 sync와는 별개. 프론트는 캐시 상태만 빠르게 반영)

---

## 6. 데이터 모델 (메모리 캐시 응답 형식)

`/api/team/state` 응답 예시:
```json
{
  "mode": "ON",
  "lastSyncAt": "2026-05-08T10:23:00+09:00",
  "self": { "id": "A", "displayName": "김상훈" },
  "peers": [
    {
      "id": "B", "displayName": "홍길동",
      "status": "ok", "lastSuccessAt": "2026-05-08T10:23:00+09:00"
    },
    {
      "id": "E", "displayName": "최민수",
      "status": "fail", "lastError": "ECONNREFUSED"
    }
  ],
  "merged": {
    "categories": [ { "id": "B:12", "owner": "B", "name": "...", ... } ],
    "schedules":  [ { "id": "B:34", "owner": "B", ... } ],
    "reports":    [ { "id": "C:5",  "owner": "C", ... } ],
    "dependencies": [ ... ]
  }
}
```

---

## 7. 작업 단계 (Phase)

### Phase A — 설정 파일 + 변경 감지
- [ ] `data/team_peers.example.csv`, `data/team_settings.example.json` 추가
- [ ] `.gitignore`에 `team_peers.csv`, `team_settings.json` 등록
- [ ] CSV 파서 (`src/engine/csvPeers.js`) — 헤더 검증, 빈줄/주석 무시, 포트 숫자 검증
- [ ] `src/engine/peerWatcher.js` — `fs.watch` + 500ms debounce + 검증 실패 시 이전값 유지
- [ ] in-memory peer list 게터 + 변경 콜백 등록 메커니즘
- [ ] 서버 부팅 시 CSV 1회 로드, 실패 시 빈 list로 시작 + 콘솔 경고

### Phase B — 기반 구성 (서버)
- [ ] `src/engine/teamCache.js` (메모리 캐시 + 상태)
- [ ] `src/engine/teamSync.js` (peer fetch + version 비교)
- [ ] `src/routes/team.js` (7개 엔드포인트)
- [ ] `server.js` 라우트 등록
- [ ] 토큰 검증 미들웨어
- [ ] 자동 갱신 타이머 (60s)

### Phase C — Peer 정보 자동 전파 (broadcast)
- [ ] peerWatcher에 diff 계산 (이전 list vs 새 list, 추가·수정만 추출)
- [ ] `src/engine/peerBroadcaster.js` — 변경 행을 모든 peer로 `POST /peer-update` 병렬 송신
- [ ] `/api/team/peer-update` 수신 핸들러 — 토큰 검증 → CSV upsert → `inboundWriteFlag` set
- [ ] CSV 안전 쓰기 (atomic write: temp파일 + rename, BOM 보존)
- [ ] dedupe set으로 echo 차단 (마지막 N개 변경 캐시)
- [ ] 자기 자신 entry 제외 로직 (송신·수신 양쪽)
- [ ] 충돌 시 last-write-wins + 토스트 알림 이벤트 emit

### Phase D — 데이터 export 형식 확정
- [ ] `/api/team/snapshot` JSON 스키마 정의
- [ ] DB → snapshot 변환 함수 (`src/engine/exporter.js` 신규)
- [ ] `/api/team/version` 산출 (전체 테이블 max(updated_at) 또는 hash)
- [ ] 첨부파일은 메타데이터만 포함 (실제 파일 download는 Phase F 이후 별도 검토)

### Phase E — 프론트엔드 UI
- [ ] 헤더 토글 버튼 + 상태 아이콘
- [ ] 상태 패널 컴포넌트 (peer 목록은 `/api/team/peers`로 동적 로드)
- [ ] 다운로드 완료 팝업
- [ ] CSV 파일 변경 시 토스트 알림 ("peer 목록 갱신됨")
- [ ] peer-update 수신 시 토스트 알림 ("OOO이(가) 'XX'의 정보를 갱신했습니다")
- [ ] CSV 검증 실패 시 에러 토스트 (행 번호·이유)
- [ ] `team-readonly` 클래스 + 모든 화면 적용
- [ ] 소유자 뱃지 디자인
- [ ] 5초 간격 `state` polling

### Phase F — 화면별 통합 표시
- [ ] 전체 간트 — 팀원 행 추가 + 읽기 전용
- [ ] 카테고리 화면 — 그룹 by 소유자
- [ ] 스케줄 화면 — 통합 표시
- [ ] 전체 보고서 화면 — 통합 + 읽기 전용 모달

### Phase G — 검증
- [ ] 2~3개 인스턴스를 다른 포트로 띄워 로컬 테스트
- [ ] peer 1개 다운된 상태에서 ON 동작 확인
- [ ] 60초 후 자동 갱신 확인
- [ ] OFF → ON → OFF 사이클에서 메모리 누수 없음 확인
- [ ] CSV 편집 → 다른 인스턴스 CSV에 자동 반영 확인 (broadcast)
- [ ] CSV에 잘못된 포트 입력 시 이전값 유지 + 토스트 표시 확인
- [ ] 동시에 두 인스턴스가 같은 이름의 peer를 추가 시 last-write-wins 확인
- [ ] broadcast 무한 루프가 발생하지 않는지 확인 (echo 차단)

---

## 8. 미결 / 추가 검토 항목

> 사용자가 추가 요구사항을 이 섹션에 채워나갈 예정

- [ ] 첨부파일 실제 다운로드 정책 (메타만? 클릭 시 lazy fetch?)
- [ ] 팀원이 ON 중일 때 본인의 데이터 변경 → 팀원이 보는 stale 데이터 처리 (60s 후 자동 반영으로 충분?)
- [ ] peer 인증 강화 (토큰 → mTLS 등) 필요 여부
- [ ] 상태 패널의 위치/크기 디자인 (모달? 사이드패널? 토스트 누적?)
- [ ] peer 삭제 전파 정책 — 명시적 「제거 전파」 버튼이 필요한가?
- [ ] 동명이인 처리 — 운영 규칙으로 두는지, 시스템에서 강제할지

---

## 9. 추가 요구사항 메모 (변경 이력)

### 2026-05-08 추가 (사용자 요청)
1. **peer 정보 파일을 CSV로** — name/host/port 열을 가진 사용자 친화적 파일 (§3.1)
2. **파일 변경 자동 감지** — 프로그램 실행 중 CSV 저장만으로 즉시 반영, 재시작 불필요 (§3.4)
3. **peer 정보 자동 전파** — 한 명이 새 peer를 추가/수정하면 ON/OFF 무관하게 모든 인스턴스에 자동 반영 (§3.5)

### 결정사항
- CSV 채택 (XLSX 대비 의존성·diff·brodcast 모두 단순). UTF-8 with BOM, 헤더 `name,host,port` 고정
- primary key는 `name` (IP·port는 변동 가능)
- broadcast는 추가/수정만, 삭제는 전파하지 않음 (실수 보호)
- 충돌 시 last-write-wins + 사용자에게 토스트 알림
