# Teams Loop 컴포넌트 새로 만들기 (`teams_loop_create.py`)

채팅에 **새 Microsoft Teams Loop 컴포넌트**를 만들어 게시하는 도구와, 그게 **어떻게 동작하는지 / 왜 잘 됐는지** 정리한 문서입니다.

`teams_chat_rw.py` 의 Selenium·프로필·`open_chat` 플러밍만 재사용하고, Loop 생성 로직은 새로 작성했습니다.
기존 일일 근태 파이프라인(`teams_chat_rw_loop.py`)은 "채팅당 1개 문서 재연결 → 제자리 편집" 방식이라 **새 Loop 생성 자체가 설계 범위 밖**이었습니다. 이 도구는 그 부분을 별도 방법으로 해결합니다.

---

## 핵심 한 줄

> **매 호출마다 작성창의 "Loop 구성 요소" 도구모음 버튼을 눌러 "새 Loop 단락"을 삽입 → 그 Loop의 iframe 안 본문에 직접 입력 → 전송.**

기존 문서를 재연결해 "제자리 편집"하는 게 아니라, **빈 컴포넌트를 새로 만들어 채우는** 흐름입니다.

---

## 사용법

```bash
# Loop 2개를 각각 "1번 테스트", "2번 테스트" 내용으로 생성·전송
uv run --with selenium python tools/teams/teams_loop_create.py \
    --text "1번 테스트" --text "2번 테스트"
```

주요 옵션:

| 옵션 | 설명 |
|------|------|
| `--text TEXT` | Loop 본문 내용. **반복 지정 시 여러 개** 생성 |
| `--loop-type` | `paragraph`(기본)·`bulleted`·`numbered`·`checklist`·`task`·`table` |
| `--no-send` | 삽입·입력만 하고 **전송하지 않음** (검증용) |
| `--clear-draft` | 작성창에 남은 Loop draft만 비우고 종료 |
| `--debug-dir DIR` | 각 단계 스크린샷·메타 저장 |
| `--chat-url URL` | 기본값은 `.env` 의 `TEAMS_CHAT_URL` |
| `--keep-open` | 끝나도 브라우저 유지 |

> 전용 브라우저 프로필(`~/.cache/teams-chat-rw/chrome-profile`)에 **로그인돼 있어야** 동작합니다. 로그인은 `teams_chat_rw.py login` 으로 합니다(MFA 없음).

---

## 실제로 성공한 동작 순서

1. **채팅 열기** — `teams_chat_rw.py` 의 `open_chat` / 오버레이·대화상자 처리 재사용.
2. **작성창 비우기** — 남은 draft가 있으면 새 컴포넌트가 위에 쌓여 한 메시지에 2개가 섞임 → 먼저 정리.
3. **"Loop 구성 요소 (Ctrl+Alt+L)" 버튼 클릭** — `data-tid="newMessageCommands-popup-semo"`.
4. **"Loop 단락" 선택** (영/한 모두: `paragraph` / `단락`).
5. → Loop가 **iframe** 으로 렌더됨 (편집기 + 본문 contenteditable).
6. **그 iframe 안으로 switch → 본문 contenteditable 찾아 텍스트 입력.**
7. **iframe 밖으로 나와 Send 클릭** — `data-tid="newMessageCommands-send"`.
8. `--text` 개수만큼 3~7 반복.

---

## 잘 된 이유 = 결정적 포인트 4가지

이 4개가 안 맞으면 "버튼은 눌리는데 **내용이 빈 Loop**"가 됩니다. 디버깅하며 하나씩 잡은 부분입니다.

### A. Loop 버튼 식별 (`open_loop_picker`)
needle에 그냥 `loop`를 넣으면 **이미 삽입된 컴포넌트(예: "Loop 단락 9")** 를 도구모음 버튼으로 오인해 클릭 → 새 Loop가 안 만들어짐.
→ needle을 `loop components` / `ctrl+alt+l` / `loop 구성 요소` 로 한정하고, `loop paragraph` · `loop 단락` 등 **삽입된 컴포넌트 라벨은 제외**.

### B. iframe 안에 입력 (`type_into_loop`, `FIND_LOOP_BODY_JS`)
Loop는 **iframe 안**에 렌더되는데, 메인 문서에 `send_keys` 하면 텍스트가 **엉뚱하게 일반 작성창**으로 새어 Loop는 빈 채로 전송됨.
→ iframe을 골라(`pick_loop_frame`) `switch_to.frame` 한 뒤, 본문 contenteditable(제목 칸이 아닌 본문)에 입력. 끝나면 `switch_to.default_content()`.

### C. draft 비우기 (`confirm_discard_dialog`)
휴지통을 눌러도 안 지워짐. 알고 보니 **"Discard draft message" 확인 대화상자**가 뜨고, 거기서 `Close`(취소)를 누르면 draft가 유지됨.
→ 대화상자의 **`Discard`(확인) 버튼**을 눌러야 함. 휴지통(aria-label만 "Discard", 보이는 텍스트 없음)과 대화상자 버튼(보이는 **innerText** "Discard")을 **innerText 기준**으로 구분.

### D. 세션 건강 (전제 조건)
Loop/Fluid 세션이 깨지면 컴포넌트가 본문 대신 **"To view this loop component, we'll need more information / Continue"** 로만 뜨고 **iframe 자체가 안 생김** → A·B가 아무리 맞아도 입력 불가.
→ **재로그인으로만 복구됨**(캐시·서비스워커 삭제로는 **안 됨**). → [문제 해결] 참고.

---

## 검증 방법 (중요)

전송 후 자동 확인이 `[warn] Sent, but content not confirmed` 로 뜰 수 있습니다.
이건 실패가 아니라 **Loop 본문이 일반 메시지 텍스트 추출로 안 읽히기 때문**입니다.

신뢰할 수 있는 검증:

1. `--no-send` + `--debug-dir` 로 **본문에 글자가 들어갔는지 스크린샷으로 먼저 확인**.
2. 확인되면 실제 전송.
3. 채팅을 다시 열어 스크롤/스크린샷으로 게시 확인.

---

## 문제 해결: Loop가 "Continue" 에서 멈출 때

증상: 컴포넌트가 본문 대신 **"we'll need more information / Continue"** 만 표시, Continue를 눌러도 반응 없음, iframe이 안 생김.
원인: Loop/Fluid **세션(인증)이 깨짐**. 메인 Teams 로그인/채팅은 정상이어도 Loop만 안 될 수 있음.

복구 순서:

1. **캐시·서비스워커만 삭제** (가벼운 시도, 보통 **이걸로는 안 고쳐짐**):
   브라우저 종료 후 프로필의 `Default/Service Worker`, `Default/Cache`, `Default/Code Cache` 삭제.
2. **재로그인** (확실한 복구):
   ```bash
   # 깨진 프로필 백업
   mv ~/.cache/teams-chat-rw/chrome-profile \
      ~/.cache/teams-chat-rw/chrome-profile.broken-$(date +%Y%m%d_%H%M%S)
   # 안 닫히는 창으로 로그인 (창에서 직접 로그인)
   uv run --with selenium python tools/teams/teams_chat_rw.py login --keep-open
   ```
   로그인 후 창을 닫으면 새 프로필에 세션 저장됨 → 이후 `teams_loop_create.py` 가 정상 동작.

> 깨진 화면에서 보이던 "Loop / Continue"는 **새로 만든 빈 메시지가 아니라, 기존 Loop가 렌더 실패한 모습**일 수 있습니다. 재로그인 후 같은 메시지가 정상 렌더됩니다.

---

## 발견한 셀렉터 / data-tid 메모

| 요소 | 식별자 |
|------|--------|
| Loop 구성 요소 버튼 | `aria-label="Loop 구성 요소 (Ctrl+Alt+L)"`, `data-tid="newMessageCommands-popup-semo"` |
| 보내기 버튼 | `aria-label="Send (Ctrl+Enter)"`, `data-tid="newMessageCommands-send"` |
| 작성창 컴포넌트 삭제(휴지통) | `aria-label="Discard"` (보이는 텍스트 없음) |
| draft 삭제 확인 대화상자 | 제목 "Discard draft message", 버튼 **`Discard`**(확인) / `Close`(취소) — innerText로 구분 |
| Loop 본문 | Loop **iframe 내부**의 `[contenteditable="true"]` (제목 "제목 추가" 칸과 별개) |
