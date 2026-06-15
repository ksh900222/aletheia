# Aletheia 서버 관리 가이드

`aletheia` (project-planner) Node 서버를 **부팅 시 자동 실행**하기 위한
systemd user 서비스 관리 문서.

---

## 개요

| 항목 | 값 |
|------|-----|
| 서비스 이름 | `aletheia.service` (systemd **user** 서비스) |
| 서비스 파일 | `~/.config/systemd/user/aletheia.service` |
| 작업 디렉토리 | `~/Documents/aletheia` |
| 실행 명령 | `/usr/bin/node src/server.js` (= `npm start`) |
| 접속 주소 | `http://localhost:3000` / 같은 네트워크 `http://10.115.41.127:3000` |
| 자동 시작 | 부팅 시 자동 (`enabled` + linger) |
| 자동 재시작 | 크래시/종료 시 자동 (`Restart=always`) |

> **로그인해도 안 꺼집니다.** linger가 켜져 있어 로그인/로그아웃과 무관하게
> 부팅 시점부터 계속 실행됩니다.

---

## 관리 명령어

> 참고: user 서비스라 `--user` 플래그를 사용하며 sudo가 필요 없습니다.

```bash
# [상태 확인] 실행 중인지, 마지막 상태/PID 확인
systemctl --user status aletheia.service

# [로그 실시간] 서버 출력·오류를 실시간으로 본다
journalctl --user -u aletheia.service -f

# [최근 로그] 최근 100줄만 확인
journalctl --user -u aletheia.service -n 100 --no-pager

# [재시작] 코드/설정(.env) 변경 후 반영할 때
systemctl --user restart aletheia.service

# [중지] 서버를 멈춘다
systemctl --user stop aletheia.service

# [시작] 멈춘 서버를 다시 켠다
systemctl --user start aletheia.service

# [자동시작 켜기] 부팅 시 자동 실행 등록
systemctl --user enable aletheia.service

# [자동시작 끄기] 부팅 시 자동 실행 해제 (서비스 파일은 유지)
systemctl --user disable aletheia.service

# [서비스 파일 수정 후 반영] aletheia.service 내용을 바꿨을 때
systemctl --user daemon-reload
```

---

## 상태 점검

```bash
# 자동시작 등록 여부 (enabled 여야 부팅 시 실행)
systemctl --user is-enabled aletheia.service

# 현재 실행 여부 (active 여야 동작 중)
systemctl --user is-active aletheia.service

# 포트 3000 리슨 확인
ss -tlnp | grep ':3000'
```

---

## 문제 해결

```bash
# [증상] 서버가 안 뜸 / 계속 재시작 → 로그에서 원인 확인
journalctl --user -u aletheia.service -n 50 --no-pager

# [증상] 포트 3000 충돌 (Error: listen EADDRINUSE)
#  → 수동으로 띄운 중복 프로세스가 있는지 확인 후 종료
pgrep -af "src/server.js"
# (서비스 외의 수동 프로세스 PID를 찾아 kill)

# [증상] .env 변경이 반영 안 됨
#  → 서비스 재시작 필요
systemctl --user restart aletheia.service
```

> **주의:** 서버를 켤 때는 터미널에서 `npm start`로 직접 띄우지 말 것.
> systemd 서비스와 포트 3000이 충돌합니다. 항상 위의
> `systemctl --user ...` 명령으로 제어하세요.

---

## 참고

- 포트 변경: `.env`에 `PORT=4000` 추가 후 `systemctl --user restart aletheia.service`
  (기본값은 3000)
- 같은 방식의 다른 자동 실행 서비스: `claude-remote.service`
  (Claude Code Remote Control — 관리 문서는 `~/Documents/cc_rmt.txt`)

작성일: 2026-06-15
