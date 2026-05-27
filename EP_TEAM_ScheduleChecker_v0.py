#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
EP_TEAM_ScheduleChecker_v0.py

무인(無人) 일일 파이프라인 — 장기 부재 중 팀원 근태를 매일 Teams Loop으로 자동 게시.

[설계] 매 실행마다 **새 독립 Loop 카드**를 하나 만들어 4열 표를 넣고 전송한다.
  (teams_loop_create.py 에서 검증된 "버튼→타입 선택→iframe 본문 입력" 흐름을 이식.
   핵심: Loop 버튼 클릭 후 picker에서 'Loop 단락' 타입을 골라야 새 컴포넌트가 생긴다.
   타입 선택을 건너뛰면 기존 문서에 재연결되어 같은 카드만 갱신된다.)

[매일 동작]
  1) EP_scheduleChecker_v5.py 실행 → 당일 근무시간_MM월_DD일_확장_v5.xlsx 생성
  2) Teams 접속 (세션 없으면 자동 로그인: 이메일+비번, 'Work or school', MFA 없음 전제)
  3) 작성창 draft 비우기 → Loop 버튼 → 'Loop 단락' 선택 → iframe 본문에 KST헤딩+4열 표 붙여넣기 → 전송

[옵션]
  --skip-generate  xlsx 생성 건너뛰고 최신 xlsx 사용 (테스트)
  --no-send        삽입·입력까지만 (검증)
  --clear-draft    작성창 leftover Loop draft만 비우고 종료
  --fresh-login    캐시 삭제 후 강제 재로그인 (Loop이 "Continue"로 깨졌을 때 복구)
  --loop-type      paragraph(기본)/bulleted/numbered/checklist/task/table
  --headless / --python <path>

자격증명은 EP_scheduleChecker_v5.py 의 id_login / pw_login 을 읽는다. 채팅방은 .env 의 TEAMS_CHAT_URL.
주의: Loop이 "we'll need more information / Continue"로만 뜨고 iframe이 안 생기면 세션이 깨진 것 →
      --fresh-login 으로 재로그인해야 복구됨(캐시 삭제만으론 안 됨).
"""
from __future__ import annotations

import argparse
import html as htmlmod
import re
import shutil
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any
from xml.etree import ElementTree as ET

SCRIPT_DIR = Path(__file__).resolve().parent
EP_CHECKER = SCRIPT_DIR / "EP_scheduleChecker_v5.py"
EMAIL_DOMAIN = "lginnotek.com"
HEADING_TAG = "근무시간 현황"

# teams_chat_rw_loop.py 는 같은 폴더(평면) 우선, 없으면 tools/teams/ 에서 찾는다.
for _cand in (SCRIPT_DIR, SCRIPT_DIR / "tools" / "teams"):
    if (_cand / "teams_chat_rw_loop.py").exists():
        sys.path.insert(0, str(_cand))
        break
else:
    raise SystemExit("teams_chat_rw_loop.py 를 찾을 수 없습니다. 같은 폴더에 두세요.")
import teams_chat_rw_loop as tc  # noqa: E402

WD = ["월", "화", "수", "목", "금", "토", "일"]
CANVAS_SEL = "[contenteditable='true'],[role='textbox']"

LOOP_TYPE_ALIASES = {
    "paragraph": ["paragraph", "단락", "문단"],
    "bulleted": ["bulleted list", "bulleted", "글머리", "글머리 기호"],
    "numbered": ["numbered list", "numbered", "번호 매기기", "번호 목록"],
    "checklist": ["checklist", "체크리스트", "확인 목록"],
    "task": ["task list", "tasks", "작업 목록", "할 일"],
    "table": ["table", "표"],
}


# ----------------------------------------------------------- creds / xlsx / table
def read_creds() -> tuple[str, str, str]:
    src = EP_CHECKER.read_text(encoding="utf-8")
    uid = re.search(r'id_login\s*=\s*"([^"]+)"', src).group(1)
    pw = re.search(r'pw_login\s*=\s*"([^"]+)"', src).group(1)
    return uid, pw, f"{uid}@{EMAIL_DOMAIN}"


def generate_xlsx(python_exe: str) -> None:
    print("[1] EP_scheduleChecker 실행 — 당일 xlsx 생성...", flush=True)
    if subprocess.run([python_exe, str(EP_CHECKER)], cwd=str(SCRIPT_DIR)).returncode != 0:
        raise RuntimeError("EP_scheduleChecker 실행 실패 (pandas/openpyxl/pytz/requests, Edge, SSOID.xlsx 확인).")


def latest_xlsx() -> Path:
    files = sorted(SCRIPT_DIR.glob("근무시간_*_확장_v5.xlsx"), key=lambda p: p.stat().st_mtime)
    if not files:
        raise FileNotFoundError("근무시간_*_확장_v5.xlsx 없음.")
    return files[-1]


def read_table(path: Path) -> list[list[str]]:
    ns = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
    z = zipfile.ZipFile(path)
    shared: list[str] = []
    if "xl/sharedStrings.xml" in z.namelist():
        root = ET.fromstring(z.read("xl/sharedStrings.xml"))
        for si in root.findall(f"{ns}si"):
            shared.append("".join(t.text or "" for t in si.iter(f"{ns}t")))

    def cval(c) -> str:
        v = c.find(f"{ns}v")
        if v is not None:
            return shared[int(v.text)] if c.get("t") == "s" else (v.text or "")
        isn = c.find(f"{ns}is")
        return "".join(x.text or "" for x in isn.iter(f"{ns}t")) if isn is not None else ""

    def col(ref: str) -> str:
        return re.match(r"[A-Z]+", ref).group()

    sheet = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    rows = []
    for r in sheet.find(f"{ns}sheetData").findall(f"{ns}row"):
        d = {col(c.get("r")): cval(c) for c in r.findall(f"{ns}c")}
        rows.append([d.get("A", ""), d.get("B", ""), d.get("C", ""), d.get("D", "")])
    return [r for r in rows if any(r)]


def build_paste(rows: list[list[str]], heading: str) -> tuple[str, str]:
    esc = lambda s: htmlmod.escape(str(s))  # noqa: E731
    body = "".join("<tr>" + "".join(f"<td>{esc(c)}</td>" for c in row) + "</tr>" for row in rows)
    html = f"<p><strong>{esc(heading)}</strong></p><table border='1'><tbody>{body}</tbody></table>"
    text = heading + "\n" + "\n".join("\t".join(str(c) for c in row) for row in rows)
    return html, text


# ----------------------------------------------------------- ported Loop-creation JS
CLICK_BY_LABEL_JS = r"""
const needles=(arguments[0]||[]).map(s=>String(s).toLowerCase());
const exclude=(arguments[1]||[]).map(s=>String(s).toLowerCase());
function vis(el){if(!el)return false;const s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;
  const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
function lab(el){return [el.getAttribute('aria-label')||'',el.getAttribute('title')||'',
  el.getAttribute('data-tid')||'',el.getAttribute('name')||'',el.innerText||'',el.textContent||'']
  .join(' ').replace(/\s+/g,' ').trim().toLowerCase();}
const sel='button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],a[role="button"],a';
for(const n of Array.from(document.querySelectorAll(sel)).filter(vis)){
  const l=lab(n); if(!l)continue;
  if(exclude.some(x=>x&&l.includes(x)))continue;
  if(needles.some(x=>x&&l.includes(x))){
    try{n.scrollIntoView({block:'center'});}catch(e){}
    try{n.click();}catch(e){try{n.dispatchEvent(new MouseEvent('click',{bubbles:true}));}catch(e2){}}
    return {clicked:true,label:(n.getAttribute('aria-label')||n.innerText||n.getAttribute('data-tid')||'').replace(/\s+/g,' ').trim().slice(0,120)};
  }}
return {clicked:false};
"""

FIND_LOOP_BODY_JS = r"""
function vis(el){if(!el)return false;const s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;
  const r=el.getBoundingClientRect();return r.width>10&&r.height>8;}
function ph(el){return (el.getAttribute('aria-placeholder')||el.getAttribute('data-placeholder')||
  el.getAttribute('placeholder')||el.getAttribute('aria-label')||'').toLowerCase();}
const eds=Array.from(document.querySelectorAll('[contenteditable="true"],[role="textbox"]')).filter(vis);
if(!eds.length)return null;
let b=eds.find(el=>/share ideas|start typing|press \/|타이핑|입력|내용/.test(ph(el)));
if(!b)b=eds.find(el=>!/title|제목/.test(ph(el)));
if(!b)b=eds[0];
try{b.focus();}catch(e){}
return b||null;
"""

CONFIRM_DISCARD_DIALOG_JS = r"""
function vis(el){if(!el)return false;const s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;
  const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
for(const b of Array.from(document.querySelectorAll('button,[role="button"]')).filter(vis)){
  const t=(b.innerText||b.textContent||'').replace(/\s+/g,' ').trim().toLowerCase();
  if(!t)continue;
  if(['close','cancel','닫기','취소'].includes(t))continue;
  if(/^(discard|delete|remove|삭제|제거|확인|ok|예|yes)$/.test(t)){b.click();return {clicked:true,label:t.slice(0,40)};}}
return {clicked:false};
"""

FIND_COMPOSE_DELETE_JS = r"""
function vis(el){if(!el)return false;const s=getComputedStyle(el);
  if(s.display==='none'||s.visibility==='hidden'||Number(s.opacity)===0)return false;
  const r=el.getBoundingClientRect();return r.width>0&&r.height>0;}
for(const b of Array.from(document.querySelectorAll('button,[role="button"]')).filter(vis)){
  if(b.closest('[role="dialog"]'))continue;
  const r=b.getBoundingClientRect(); if(r.y<innerHeight*0.3)continue;
  const l=(b.getAttribute('aria-label')||b.getAttribute('title')||b.innerText||'').replace(/\s+/g,' ').trim().toLowerCase();
  if(!l)continue;
  if(/^(delete|remove|discard|삭제|제거|버리기)$/.test(l)||
     /(delete|remove|discard|삭제|제거).*(loop|component|구성|컴포넌트)/.test(l)||
     /(loop|component|구성|컴포넌트).*(delete|remove|discard|삭제|제거)/.test(l)){
    try{b.scrollIntoView({block:'center'});}catch(e){} return b;}}
return null;
"""


def click_by_label(driver, needles, exclude=None) -> dict:
    try:
        r = driver.execute_script(CLICK_BY_LABEL_JS, needles, exclude or [])
    except Exception:
        return {"clicked": False}
    return r if isinstance(r, dict) else {"clicked": False}


def confirm_discard_dialog(driver) -> bool:
    try:
        r = driver.execute_script(CONFIRM_DISCARD_DIALOG_JS)
    except Exception:
        return False
    return bool(isinstance(r, dict) and r.get("clicked"))


def clear_compose_drafts(driver, max_rounds: int = 6) -> int:
    """작성창의 leftover Loop draft 제거. 휴지통 → 'Discard'(확인) 대화상자 확정."""
    from selenium.webdriver.common.action_chains import ActionChains
    removed = 0
    for _ in range(max_rounds):
        if confirm_discard_dialog(driver):
            removed += 1; time.sleep(0.7); continue
        try:
            btn = driver.execute_script(FIND_COMPOSE_DELETE_JS)
        except Exception:
            btn = None
        if btn is None:
            break
        try:
            ActionChains(driver).move_to_element(btn).pause(0.1).click().perform()
        except Exception:
            try: btn.click()
            except Exception: pass
        time.sleep(0.8)
        if confirm_discard_dialog(driver):
            removed += 1; time.sleep(0.7); continue
        if driver.execute_script(FIND_COMPOSE_DELETE_JS) is None:
            removed += 1; time.sleep(0.4); continue
        break
    return removed


def open_loop_picker(driver) -> bool:
    """작성창 'Loop 구성 요소' 버튼 클릭 → 타입 picker 열기. 이미 삽입된 컴포넌트 라벨은 제외."""
    needles = ["loop components", "ctrl+alt+l", "loop 구성 요소", "loop 컴포넌트", "loop 구성요소", "insert loop", "loop 삽입"]
    exclude = ["develop", "envelope", "loop paragraph", "loop table", "loop bulleted",
               "loop numbered", "loop checklist", "loop task", "loop 단락"]
    if click_by_label(driver, needles, exclude).get("clicked"):
        return True
    for opener in (["more options", "더 많은 옵션", "추가 옵션", "더 보기"],
                   ["messaging extensions", "apps", "앱", "메시징 확장"], ["format", "서식"]):
        if click_by_label(driver, opener, exclude).get("clicked"):
            time.sleep(1.0)
            if click_by_label(driver, needles, exclude).get("clicked"):
                return True
    return False


def choose_loop_type(driver, loop_type: str) -> bool:
    """picker에서 타입(기본 '단락') 선택 → 새 빈 컴포넌트 삽입."""
    needles = LOOP_TYPE_ALIASES.get(loop_type, [loop_type])
    end = time.time() + 8.0
    while time.time() < end:
        if click_by_label(driver, needles).get("clicked"):
            return True
        time.sleep(0.5)
    return False


def pick_loop_frame(driver):
    from selenium.webdriver.common.by import By
    visible, scored = [], []
    for fr in driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            if not fr.is_displayed():
                continue
        except Exception:
            continue
        attrs = " ".join(v for v in (fr.get_attribute("src"), fr.get_attribute("title"),
                                     fr.get_attribute("name"), fr.get_attribute("id"),
                                     fr.get_attribute("data-tid")) if v).lower()
        visible.append(fr)
        if any(k in attrs for k in ("loop", "fluid", "office", "cid", "embed")):
            scored.append(fr)
    if scored:
        return scored[-1]
    return visible[-1] if visible else None


# ----------------------------------------------------------- login (auto)
def _vis(driver, sel):
    from selenium.webdriver.common.by import By
    try:
        e = driver.find_element(By.CSS_SELECTOR, sel)
        return e if e.is_displayed() else None
    except Exception:
        return None


def teams_login(driver, email, uid, pw, timeout: float = 150.0) -> None:
    print("[2] Teams 자동 로그인...", flush=True)
    driver.get("https://teams.microsoft.com/")
    time.sleep(7)
    tc.use_web_app_instead(driver, timeout=8.0)
    end = time.time() + timeout
    while time.time() < end:
        url = driver.current_url
        try:
            body = driver.execute_script("return document.body.innerText||''")
        except Exception:
            body = ""
        if "teams.microsoft.com" in url and not ("login.microsoftonline" in url or _vis(driver, "input#i0116") or _vis(driver, "input[name=userid]")):
            try:
                if driver.execute_script(tc.FIND_COMPOSE_JS):
                    print("      ✓ Teams 진입", flush=True); return
            except Exception:
                pass
        if "more than one account" in body or "Work or school" in body or "회사 또는 학교" in body:
            click_by_label(driver, ["work or school", "회사 또는 학교", "업무 또는 학교"]); time.sleep(5); continue
        # "Pick an account"(캐시된 계정 선택) → '다른 계정 사용'으로 이메일 입력 흐름 진입(작업계정 확실히),
        #  없으면 우리 이메일 타일 클릭.
        if (("pick an account" in body.lower() or "select an account" in body.lower()
             or "계정 선택" in body or "계정을 선택" in body) and not _vis(driver, "input#i0118")):
            if click_by_label(driver, ["use another account", "다른 계정 사용", "다른 계정으로 로그인", "use a different account", "계정 추가"]).get("clicked"):
                time.sleep(5); continue
            if click_by_label(driver, [email, uid]).get("clicked"):
                time.sleep(5); continue
        u = _vis(driver, "input[name=userid]") or _vis(driver, "input#userid")
        if u:
            u.clear(); u.send_keys(uid)
            p = _vis(driver, "input#password") or _vis(driver, "input[name=password]") or _vis(driver, "input[type=password]")
            if p: p.clear(); p.send_keys(pw)
            b = (_vis(driver, "input[type=image]") or _vis(driver, "button[type=submit]") or _vis(driver, "input[type=submit]") or _vis(driver, "#loginBtn"))
            (b.click() if b else u.submit()); time.sleep(7); continue
        em = _vis(driver, "input#i0116") or _vis(driver, "input[name=loginfmt]")
        if em and not _vis(driver, "input#i0118"):
            em.clear(); em.send_keys(email)
            nb = _vis(driver, "#idSIButton9") or _vis(driver, "input[type=submit]")
            if nb: nb.click()
            time.sleep(6); continue
        mp = _vis(driver, "input#i0118") or _vis(driver, "input[name=passwd]")
        if mp:
            mp.clear(); mp.send_keys(pw)
            nb = _vis(driver, "#idSIButton9") or _vis(driver, "input[type=submit]")
            if nb: nb.click()
            time.sleep(6); continue
        if "stay signed in" in body.lower() or "로그인 상태를 유지" in body or "로그인 유지" in body:
            nb = _vis(driver, "#idSIButton9")
            if nb: nb.click()
            time.sleep(5); continue
        time.sleep(3)
    raise TimeoutError("Teams 자동 로그인 시간 초과.")


# ----------------------------------------------------------- create new Loop card
def create_loop_card(driver, paste_html: str, paste_text: str, loop_type: str,
                     no_send: bool, timeout: float = 90.0) -> bool:
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys
    print("[3] 새 Loop 카드 생성 (버튼→타입 선택→표 붙여넣기→전송)...", flush=True)
    # 작성창 포커스
    compose = tc.find_compose(driver, timeout=timeout)
    driver.execute_script("arguments[0].scrollIntoView({block:'center'});", compose)
    try:
        compose.click()
    except Exception:
        pass
    time.sleep(0.4)
    # leftover draft 비우기
    print(f"      leftover draft {clear_compose_drafts(driver)}개 정리", flush=True)
    # Loop 버튼 → 타입 선택
    if not open_loop_picker(driver):
        raise RuntimeError("Loop 구성 요소 버튼을 찾지 못함.")
    time.sleep(1.0)
    if not choose_loop_type(driver, loop_type):
        raise RuntimeError(f"Loop 타입 '{loop_type}' 선택 실패 (picker 항목 못 찾음).")
    time.sleep(1.5)  # 컴포넌트 렌더 대기
    # iframe 본문에 표 붙여넣기
    frame = pick_loop_frame(driver)
    if frame is None:
        raise RuntimeError("Loop iframe을 못 찾음 (세션 깨짐? --fresh-login 필요).")
    driver.switch_to.frame(frame)
    try:
        time.sleep(0.5)
        body = driver.execute_script(FIND_LOOP_BODY_JS)
        if body is None:
            raise RuntimeError("Loop 본문 contenteditable을 못 찾음 (세션 깨짐 가능).")
        try:
            body.click()
        except Exception:
            driver.execute_script("arguments[0].focus();", body)
        time.sleep(0.3)
        driver.execute_script(
            r"""const el=arguments[2]; el.focus();
                const dt=new DataTransfer(); dt.setData('text/html',arguments[0]); dt.setData('text/plain',arguments[1]);
                el.dispatchEvent(new ClipboardEvent('paste',{clipboardData:dt,bubbles:true,cancelable:true}));""",
            paste_html, paste_text, body)
        time.sleep(2.0)
    finally:
        driver.switch_to.default_content()

    if no_send:
        print("      --no-send: 입력만, 전송 보류", flush=True)
        return True

    # 공유 링크 설정 대기 (너무 빨리 보내면 '추가 정보 필요' 깨짐)
    end = time.time() + 35
    while time.time() < end:
        if driver.execute_script(
            r"""const f=document.querySelector('iframe[title*="Loop"],iframe[title*="구성 요소"],iframe[title*="component"]');
                if(!f) return false; let c=f.parentElement; for(let i=0;i<7&&c;i++) c=c.parentElement||c;
                return /can edit|편집할 수|with the link|링크가 있는|조직의 사용자/i.test(c?c.innerText:'');"""):
            break
        time.sleep(1.0)
    time.sleep(3)
    sent = tc.click_send_button(driver, timeout=min(timeout, 30.0))
    if not sent:
        ActionChains(driver).key_down(Keys.CONTROL).send_keys(Keys.ENTER).key_up(Keys.CONTROL).perform()  # 폴백
        sent = True
    print(f"      전송: {sent}", flush=True)
    time.sleep(6)
    return True


def clear_cache(profile_dir: Path) -> None:
    print("[*] 캐시 삭제 (--fresh-login)...", flush=True)
    if profile_dir.exists():
        shutil.rmtree(profile_dir, ignore_errors=True)
    profile_dir.mkdir(parents=True, exist_ok=True)


# ----------------------------------------------------------- main
def main() -> int:
    p = argparse.ArgumentParser(description="EP 근태 → Teams 새 Loop 카드 매일 생성")
    p.add_argument("--skip-generate", action="store_true")
    p.add_argument("--no-send", action="store_true")
    p.add_argument("--clear-draft", action="store_true", help="작성창 leftover Loop draft만 비우고 종료")
    p.add_argument("--fresh-login", action="store_true", help="캐시 삭제 후 강제 재로그인")
    p.add_argument("--loop-type", choices=sorted(LOOP_TYPE_ALIASES), default="paragraph")
    p.add_argument("--headless", action="store_true")
    p.add_argument("--python", default=sys.executable)
    args = p.parse_args()

    tc.load_env_files(SCRIPT_DIR / ".env", SCRIPT_DIR / "tools" / "teams" / ".env")
    chat_url = tc.DEFAULT_CHAT_URL
    if not chat_url:
        raise SystemExit("TEAMS_CHAT_URL 이 .env 에 없습니다.")
    uid, pw, email = read_creds()
    profile_dir = tc.DEFAULT_PROFILE_DIR

    paste_html = paste_text = None
    if not args.clear_draft:
        if not args.skip_generate:
            generate_xlsx(args.python)
        xlsx = latest_xlsx()
        rows = read_table(xlsx)
        kst = datetime.now(timezone.utc).astimezone(timezone(timedelta(hours=9)))
        heading = f"{HEADING_TAG} — {kst:%Y-%m-%d} ({WD[kst.weekday()]}) {kst:%H:%M} KST"
        print(f"      대상 xlsx: {xlsx.name} ({len(rows)}행)  헤딩: {heading}", flush=True)
        paste_html, paste_text = build_paste(rows, heading)

    if args.fresh_login:
        clear_cache(profile_dir)

    driver = tc.make_webdriver(browser=tc.choose_browser("auto"), profile_dir=profile_dir,
                               headless=args.headless, window_size="1500,1050", download_dir=None, loop_mode=True)
    try:
        tc.open_chat(driver, chat_url)
        if tc.is_login_screen(driver):
            teams_login(driver, email, uid, pw)
            tc.open_chat(driver, chat_url)
        tc.confirm_discard_draft_dialog(driver, timeout=4.0)
        tc.find_compose(driver, timeout=120)

        if args.clear_draft:
            print(f"--clear-draft: {clear_compose_drafts(driver)}개 정리 후 종료", flush=True)
            return 0

        create_loop_card(driver, paste_html, paste_text, args.loop_type, no_send=args.no_send)
        print("✅ 완료 — 새 Loop 카드를 게시했습니다.", flush=True)
        return 0
    finally:
        driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
