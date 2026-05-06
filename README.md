# Project Planner

카테고리 기반 스케줄러 + 의존성 (Strong/Weak) + 일일 리포트.
단일 사용자 / 로컬 웹앱. Node.js + Express + SQLite + Vanilla JS.

## 요구사항

- **Node.js 20 이상** (LTS 22 권장).
- 그 외 별도 빌드 도구 없음. `better-sqlite3` 가 prebuilt 바이너리 제공.

## 처음 실행

```bash
npm install
npm start
```

브라우저에서 http://localhost:3000

## 환경변수

| 변수 | 기본 | 설명 |
|---|---|---|
| `PORT` | `3000` | 서버 포트 |
| `HOST` | `0.0.0.0` | 바인딩 주소. 기본값으로 같은 네트워크의 다른 기기에서도 접속 가능 |

예:

```bash
# 다른 포트로
PORT=4000 npm start

# LAN 의 다른 기기에서도 접속 (방화벽 허용 필요)
HOST=0.0.0.0 npm start

# Windows PowerShell
$env:PORT="4000"; npm start
```

## 데이터 위치

| 경로 | 내용 |
|---|---|
| `data/planner.db` | SQLite 메인 DB (categories, schedules, dependencies, reports, attachments) |
| `data/holidays.json` | 한국 공휴일 캐시 — 서버 시작 시/24h 마다 외부 API 에서 자동 갱신 |
| `uploads/` | 첨부 파일 (사용자 업로드) |

위 셋만 백업하면 모든 사용자 데이터 보존됨.

## 다른 PC 로 옮기기

### Git 사용 (권장)
```bash
# 현재 PC: 코드만 push (data/, uploads/ 는 .gitignore 로 제외됨)
git push <remote>

# 새 PC
git clone <remote>
npm install
# data/, uploads/ 는 USB/네트워크로 별도 복사
npm start
```

### 압축 복사
```bash
# 현재 PC — node_modules 와 SQLite WAL 임시 파일 제외하고 압축
tar --exclude='node_modules' --exclude='*.db-shm' --exclude='*.db-wal' \
    --exclude='.DS_Store' \
    -czf project_planner.tar.gz project_planner/

# 새 PC
tar -xzf project_planner.tar.gz
cd project_planner
npm install
npm start
```

### 새 PC 사전 준비

**Ubuntu 24 LTS**:
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
```

**Windows**: [nodejs.org](https://nodejs.org/) 에서 LTS 설치 프로그램 다운로드 → 실행. "Tools for Native Modules" 체크박스는 보통 안 켜도 됨 (better-sqlite3 prebuilt 가 있음). `npm install` 시 빌드 에러가 나면 그때 켜고 재설치.

## 옮길 때 가져가지 말 것

- `node_modules/` — OS/CPU 별 native 바이너리. 새 PC 에서 `npm install` 로 재생성.
- `data/planner.db-shm`, `data/planner.db-wal` — SQLite WAL 임시. 서버 정상 종료 후 사라지거나, 옮겨도 SQLite 가 알아서 복구.
- `.DS_Store` — macOS 시스템 파일.

## 백업

서버 종료 후 `data/planner.db` 와 `uploads/` 를 통째로 복사하면 됩니다. WAL 모드라 실행 중에도 복사 가능하지만, `.db-shm` / `.db-wal` 까지 같이 복사하지 않으면 일부 최근 변경이 누락될 수 있습니다.

```bash
# 안전한 백업 (서버 정지 후)
tar -czf backup-$(date +%Y%m%d).tar.gz data/planner.db uploads/
```

## 개발 모드

파일 변경 시 자동 재시작:
```bash
npm run dev
```

(Node 의 `--watch` 사용. 별도 nodemon 패키지 불필요.)

## 주요 단축키 / 조작

- 간트 막대 **드래그** — 일정 이동.
- 간트 막대 **Cmd/Ctrl + 클릭** — 강한 의존 생성 (두 막대 차례로).
- 간트 막대 **Opt/Alt + 클릭** — 약한 의존 생성.
- 간트 막대 **Shift + 드래그** — 그룹 이동 (직속 strong 선행도 함께).
- 간트 헤더의 **날짜 셀 클릭** — 그 날짜에 걸리는 막대만 강조 (sticky 모드). 막대 클릭 시 일일 리포트 모달.
- **ESC** — sticky 모드 / 의존 생성 모드 해제.
- **Cmd/Ctrl + Z** — 실행 취소 (드래그 / 상태 변경 / 의존 생성 등).
- **Cmd/Ctrl + Shift + Z** 또는 **Cmd/Ctrl + Y** — 다시 실행.

## 변경 이력

상세 변경 내역은 [`md/PROJECT_LOG.md`](md/PROJECT_LOG.md) 참고.
