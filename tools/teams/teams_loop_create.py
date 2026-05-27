#!/usr/bin/env python3
"""
Create fresh Microsoft Teams *Loop components* in a chat through Teams Web.

This is a separate, self-contained approach: open the chat, click the Loop
component button in the compose toolbar, pick a component type (default:
paragraph), type the content, and send.  Run once per requested item to create
several distinct Loop components.

Only the generic browser / driver / open-chat plumbing is reused from
teams_chat_rw.py (the script this one is modelled on).  All Loop-specific
automation below is new and does not depend on teams_chat_rw_loop.py.

Usage:
    uv run --with selenium python tools/teams/teams_loop_create.py \
        --text "1번 테스트" --text "2번 테스트"
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path
from typing import Any

SCRIPT_DIR = Path(__file__).resolve().parent
if str(SCRIPT_DIR) not in sys.path:
    sys.path.insert(0, str(SCRIPT_DIR))

# Reuse only the generic helpers (driver setup, chat navigation, overlay/dialog
# handling, compose lookup, send button, confirmation).  Importing also loads
# the .env files via teams_chat_rw's module-level load_env_files() call.
import teams_chat_rw as trw  # noqa: E402


# --- Loop component type aliases -----------------------------------------
# Needles are matched case-insensitively against the picker item label
# (English + Korean Teams UI).
LOOP_TYPE_ALIASES: dict[str, list[str]] = {
    "paragraph": ["paragraph", "단락", "문단"],
    "bulleted": ["bulleted list", "bulleted", "글머리", "글머리 기호"],
    "numbered": ["numbered list", "numbered", "번호 매기기", "번호 목록"],
    "checklist": ["checklist", "체크리스트", "확인 목록"],
    "task": ["task list", "tasks", "작업 목록", "할 일"],
    "table": ["table", "표"],
}


# --- JS helpers (new) ----------------------------------------------------

# Click the first visible control whose label contains one of the needles.
# arguments[0] = needles (list[str]), arguments[1] = exclude needles (list[str]).
CLICK_BY_LABEL_JS = r"""
const needles = (arguments[0] || []).map(s => String(s).toLowerCase());
const exclude = (arguments[1] || []).map(s => String(s).toLowerCase());

function visible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function labelOf(el) {
  return [
    el.getAttribute('aria-label') || '',
    el.getAttribute('title') || '',
    el.getAttribute('data-tid') || '',
    el.getAttribute('name') || '',
    el.innerText || '',
    el.textContent || ''
  ].join(' ').replace(/\s+/g, ' ').trim().toLowerCase();
}

const selector = 'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"],a[role="button"],a';
const nodes = Array.from(document.querySelectorAll(selector)).filter(visible);
for (const node of nodes) {
  const label = labelOf(node);
  if (!label) continue;
  if (exclude.some(x => x && label.includes(x))) continue;
  if (needles.some(x => x && label.includes(x))) {
    try { node.scrollIntoView({block: 'center'}); } catch (e) {}
    try { node.click(); } catch (e) {
      try { node.dispatchEvent(new MouseEvent('click', {bubbles: true})); } catch (e2) {}
    }
    return {
      clicked: true,
      label: (node.getAttribute('aria-label') || node.innerText || node.getAttribute('data-tid') || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    };
  }
}
return {clicked: false};
"""


# List visible controls (for debugging which buttons/menu items exist).
LIST_CONTROLS_JS = r"""
function visible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const selector = 'button,[role="button"],[role="menuitem"],[role="menuitemradio"],[role="option"]';
const out = [];
for (const node of Array.from(document.querySelectorAll(selector))) {
  if (!visible(node)) continue;
  const rect = node.getBoundingClientRect();
  const label = (node.getAttribute('aria-label') || node.innerText || node.getAttribute('title') || node.getAttribute('data-tid') || '')
    .replace(/\s+/g, ' ').trim().slice(0, 80);
  if (!label) continue;
  out.push({label: label, tid: (node.getAttribute('data-tid') || ''), y: Math.round(rect.y)});
}
out.sort((a, b) => a.y - b.y);
return out;
"""


# Find the body editable inside a Loop component iframe (Loop renders in an
# iframe, so this JS must run *after* switching into that frame).  Prefer the
# body paragraph over the optional title field.
FIND_LOOP_BODY_JS = r"""
function visible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 10 && rect.height > 8;
}

function placeholder(el) {
  return (el.getAttribute('aria-placeholder') || el.getAttribute('data-placeholder') ||
    el.getAttribute('placeholder') || el.getAttribute('aria-label') || '').toLowerCase();
}

const editables = Array.from(document.querySelectorAll('[contenteditable="true"],[role="textbox"]'))
  .filter(visible);
if (!editables.length) return null;

// 1) Body has a "start typing / share ideas" style placeholder.
let body = editables.find(el => /share ideas|start typing|press \/|타이핑|입력|내용/.test(placeholder(el)));
// 2) Otherwise the first editable that is NOT the title field.
if (!body) body = editables.find(el => !/title|제목/.test(placeholder(el)));
// 3) Otherwise just the first editable.
if (!body) body = editables[0];

try { body.focus(); } catch (e) {}
return body || null;
"""


COUNT_IFRAMES_JS = "return document.querySelectorAll('iframe').length;"


# Return the delete/discard button of a Loop component draft in the compose
# area (lower part of the window), or null.
FIND_COMPOSE_DELETE_JS = r"""
function visible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
for (const button of buttons) {
  if (button.closest('[role="dialog"]')) continue;  // not a confirmation-dialog button
  const rect = button.getBoundingClientRect();
  if (rect.y < window.innerHeight * 0.3) continue;  // compose area only
  const label = (button.getAttribute('aria-label') || button.getAttribute('title') || button.innerText || '')
    .replace(/\s+/g, ' ').trim().toLowerCase();
  if (!label) continue;
  if (/^(delete|remove|discard|삭제|제거|버리기)$/.test(label) ||
      /(delete|remove|discard|삭제|제거).*(loop|component|구성|컴포넌트)/.test(label) ||
      /(loop|component|구성|컴포넌트).*(delete|remove|discard|삭제|제거)/.test(label)) {
    try { button.scrollIntoView({block: 'center'}); } catch (e) {}
    return button;
  }
}
return null;
"""


# Click the confirm button ("Discard"/"Delete") inside a "Discard draft message"
# dialog -- NOT the "Close"/"Cancel" button.  Returns {clicked, label}.
CONFIRM_DISCARD_DIALOG_JS = r"""
function visible(el) {
  if (!el) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}
// Match by *visible text* (innerText): the dialog's confirm button shows the
// word "Discard", whereas the compose trash icon only has an aria-label.
const buttons = Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible);
for (const button of buttons) {
  const text = (button.innerText || button.textContent || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!text) continue;
  if (['close', 'cancel', '닫기', '취소'].includes(text)) continue;
  if (/^(discard|delete|remove|삭제|제거|확인|ok|예|yes)$/.test(text)) {
    button.click();
    return {clicked: true, label: text.slice(0, 40)};
  }
}
return {clicked: false};
"""


# --- Orchestration -------------------------------------------------------

def log(msg: str) -> None:
    print(msg, flush=True)


def click_by_label(driver: Any, needles: list[str], exclude: list[str] | None = None) -> dict[str, Any]:
    try:
        result = driver.execute_script(CLICK_BY_LABEL_JS, needles, exclude or [])
    except Exception as exc:  # noqa: BLE001
        return {"clicked": False, "error": str(exc)}
    return result if isinstance(result, dict) else {"clicked": False}


def list_controls(driver: Any) -> list[dict[str, Any]]:
    try:
        result = driver.execute_script(LIST_CONTROLS_JS)
    except Exception:  # noqa: BLE001
        return []
    return [c for c in result if isinstance(c, dict)] if isinstance(result, list) else []


def dump_controls(driver: Any, header: str) -> None:
    controls = list_controls(driver)
    log(f"  [debug] {header} ({len(controls)} controls):")
    for control in controls:
        log(f"    - {control.get('label')!r} tid={control.get('tid')!r}")


def find_compose_delete(driver: Any) -> Any:
    try:
        return driver.execute_script(FIND_COMPOSE_DELETE_JS)
    except Exception:  # noqa: BLE001
        return None


def compose_has_draft(driver: Any) -> bool:
    """A leftover Loop draft is present when its Discard (trash) button exists."""
    return find_compose_delete(driver) is not None


def confirm_discard_dialog(driver: Any) -> bool:
    """Click 'Discard' in the 'Discard draft message' confirmation dialog, if open."""
    try:
        result = driver.execute_script(CONFIRM_DISCARD_DIALOG_JS)
    except Exception:  # noqa: BLE001
        return False
    if isinstance(result, dict) and result.get("clicked"):
        log(f"  Confirmed discard dialog via {result.get('label')!r}.")
        return True
    return False


def clear_compose_drafts(driver: Any, debug_dir: str | None, max_rounds: int = 6) -> int:
    """Empty the compose box of leftover Loop component drafts.

    A saved Loop draft shows a trash (Discard) button but no iframe until edited,
    so that button is the reliable "compose is dirty" signal.  Clicking it opens
    a 'Discard draft message' dialog whose 'Discard' button must be confirmed
    (not 'Close', which keeps the draft).
    Returns how many components were removed.
    """
    from selenium.webdriver.common.action_chains import ActionChains

    removed = 0
    for _ in range(max_rounds):
        # A dialog may already be open from a prior click.
        if confirm_discard_dialog(driver):
            removed += 1
            time.sleep(0.7)
            continue

        button = find_compose_delete(driver)
        if button is None:
            break

        try:
            ActionChains(driver).move_to_element(button).pause(0.1).click().perform()
        except Exception:  # noqa: BLE001
            try:
                button.click()
            except Exception:  # noqa: BLE001
                pass
        time.sleep(0.8)

        if confirm_discard_dialog(driver):
            removed += 1
            time.sleep(0.7)
            continue

        # No dialog appeared and the trash button is gone -> deleted directly.
        if not compose_has_draft(driver):
            removed += 1
            log("  Cleared a draft component.")
            time.sleep(0.4)
            continue

        log("  [warn] Could not clear a draft component; stopping clear loop.")
        break

    if removed:
        trw.save_debug_snapshot(driver, debug_dir, "compose_cleared")
    return removed


def open_loop_picker(driver: Any, debug_dir: str | None) -> bool:
    """Click the Loop component button, opening the type picker.

    Tries the toolbar directly first, then behind an overflow / extensions menu.
    """
    # Target the compose toolbar button specifically (not an already-inserted
    # "Loop paragraph"/"Loop table" component sitting in a draft).
    loop_needles = [
        "loop components", "ctrl+alt+l",
        "loop 구성 요소", "loop 컴포넌트", "loop 구성요소",
        "insert loop", "loop 삽입",
    ]
    exclude = [
        "develop", "envelope",
        "loop paragraph", "loop table", "loop bulleted", "loop numbered",
        "loop checklist", "loop task",
    ]

    result = click_by_label(driver, loop_needles, exclude)
    if result.get("clicked"):
        log(f"  Clicked Loop button: {result.get('label')!r}")
        return True

    # The Loop button may be hidden behind a "more options" / extensions button.
    for opener in (
        ["more options", "더 많은 옵션", "추가 옵션", "더 보기"],
        ["messaging extensions", "apps", "앱", "메시징 확장"],
        ["format", "서식"],
    ):
        opened = click_by_label(driver, opener, exclude)
        if not opened.get("clicked"):
            continue
        log(f"  Opened overflow via {opened.get('label')!r}; re-searching for Loop...")
        time.sleep(1.0)
        result = click_by_label(driver, loop_needles, exclude)
        if result.get("clicked"):
            log(f"  Clicked Loop button: {result.get('label')!r}")
            return True

    trw.save_debug_snapshot(driver, debug_dir, "loop_button_not_found")
    dump_controls(driver, "compose toolbar")
    return False


def choose_loop_type(driver: Any, loop_type: str, debug_dir: str | None) -> bool:
    needles = LOOP_TYPE_ALIASES.get(loop_type, [loop_type])
    end = time.time() + 8.0
    while time.time() < end:
        result = click_by_label(driver, needles)
        if result.get("clicked"):
            log(f"  Picked Loop type: {result.get('label')!r}")
            return True
        time.sleep(0.5)
    trw.save_debug_snapshot(driver, debug_dir, "loop_type_not_found")
    dump_controls(driver, "loop type picker")
    return False


def pick_loop_frame(driver: Any) -> Any:
    """Return the iframe WebElement that hosts the freshly inserted Loop component."""
    from selenium.webdriver.common.by import By

    visible_frames: list[Any] = []
    scored: list[Any] = []
    for frame in driver.find_elements(By.TAG_NAME, "iframe"):
        try:
            if not frame.is_displayed():
                continue
        except Exception:  # noqa: BLE001
            continue
        attrs = " ".join(
            value
            for value in (
                frame.get_attribute("src"),
                frame.get_attribute("title"),
                frame.get_attribute("name"),
                frame.get_attribute("id"),
                frame.get_attribute("data-tid"),
            )
            if value
        ).lower()
        visible_frames.append(frame)
        if any(kw in attrs for kw in ("loop", "fluid", "office", "cid", "embed")):
            scored.append(frame)
    if scored:
        return scored[-1]
    return visible_frames[-1] if visible_frames else None


def _send_lines(target: Any, driver: Any, text: str) -> None:
    from selenium.webdriver.common.keys import Keys
    from selenium.webdriver.common.action_chains import ActionChains

    lines = text.splitlines() or [text]
    for i, line in enumerate(lines):
        if line:
            target.send_keys(line)
        if i != len(lines) - 1:
            ActionChains(driver).key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT).perform()
            time.sleep(0.05)


def type_into_loop(driver: Any, text: str) -> bool:
    """Type text into the body of the freshly inserted Loop component (in its iframe)."""
    from selenium.webdriver.common.action_chains import ActionChains

    time.sleep(1.2)  # let the component render
    frame = pick_loop_frame(driver)
    if frame is not None:
        try:
            driver.switch_to.frame(frame)
            time.sleep(0.5)
            body = driver.execute_script(FIND_LOOP_BODY_JS)
            if body is not None:
                try:
                    body.click()
                except Exception:  # noqa: BLE001
                    driver.execute_script("arguments[0].focus();", body)
                time.sleep(0.2)
                _send_lines(body, driver, text)
            else:
                # No editable resolved; type into whatever is focused in the frame.
                ActionChains(driver).send_keys(text).perform()
            return True
        except Exception as exc:  # noqa: BLE001
            log(f"  [warn] iframe typing failed ({exc}); falling back to main document.")
        finally:
            driver.switch_to.default_content()

    # Fallback: type into whatever currently has focus in the main document.
    try:
        ActionChains(driver).send_keys(text).perform()
        return True
    except Exception as exc:  # noqa: BLE001
        log(f"  [error] could not type into Loop component: {exc}")
        return False


def create_one_loop(
    driver: Any,
    *,
    text: str,
    loop_type: str,
    send: bool,
    confirm_timeout: float,
    timeout: float,
    debug_dir: str | None,
) -> bool:
    log(f"\n=== Creating Loop component: {text!r} ===")

    # Focus the compose box first so the toolbar is active.
    try:
        compose = trw.find_compose(driver, timeout=timeout)
        driver.execute_script("arguments[0].scrollIntoView({block:'center'});", compose)
        compose.click()
        time.sleep(0.4)
    except Exception as exc:  # noqa: BLE001
        log(f"  [warn] could not focus compose box: {exc}")

    iframes_before = driver.execute_script(COUNT_IFRAMES_JS)

    if not open_loop_picker(driver, debug_dir):
        log("  [error] Loop component button not found. See --debug-dir snapshot / control dump above.")
        return False

    time.sleep(1.0)
    if not choose_loop_type(driver, loop_type, debug_dir):
        log("  [error] Loop type item not found in picker.")
        return False

    iframes_after = driver.execute_script(COUNT_IFRAMES_JS)
    if iframes_after > iframes_before:
        log(f"  [note] iframe count went {iframes_before} -> {iframes_after} (Loop may render in an iframe).")

    if not type_into_loop(driver, text):
        return False
    log(f"  Typed content into Loop component.")
    trw.save_debug_snapshot(driver, debug_dir, "loop_typed")

    if not send:
        log("  --no-send: leaving the Loop component unsent.")
        return True

    sent = trw.click_send_button(driver, timeout=min(timeout, 30.0))
    if not sent:
        log("  [error] Could not click the Send button.")
        trw.save_debug_snapshot(driver, debug_dir, "loop_send_failed")
        return False

    log("  Send clicked.")
    if confirm_timeout > 0:
        confirmed = trw.wait_for_text(driver, text, timeout=confirm_timeout)
        log("  Confirmed in chat." if confirmed else "  [warn] Sent, but content not confirmed before timeout.")
    time.sleep(1.5)  # settle before composing the next one
    return True


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Create Teams Loop components via Teams Web.")
    parser.add_argument("--chat-url", default=trw.DEFAULT_CHAT_URL,
                        help="Teams chat URL. Defaults to TEAMS_CHAT_URL from .env.")
    parser.add_argument("--text", action="append",
                        help="Content for a Loop component. Repeat for multiple components.")
    parser.add_argument("--loop-type", choices=sorted(LOOP_TYPE_ALIASES), default="paragraph",
                        help="Loop component type to insert (default: paragraph).")
    parser.add_argument("--browser", choices=["auto", "chrome", "edge"],
                        default=trw.os.environ.get("TEAMS_BROWSER", "auto"))
    parser.add_argument("--profile-dir",
                        default=trw.os.environ.get("TEAMS_PROFILE_DIR", str(trw.DEFAULT_PROFILE_DIR)),
                        help="Persistent browser profile directory for Teams login state.")
    parser.add_argument("--headless", action="store_true", help="Run browser headless.")
    parser.add_argument("--window-size", default=trw.DEFAULT_WINDOW_SIZE)
    parser.add_argument("--timeout", type=float, default=trw.DEFAULT_TIMEOUT)
    parser.add_argument("--confirm-timeout", type=float, default=15.0)
    parser.add_argument("--no-send", action="store_true", help="Insert and type, but do not send.")
    parser.add_argument("--clear-draft", action="store_true",
                        help="Only clear leftover Loop drafts from the compose box, then exit.")
    parser.add_argument("--debug-dir", help="Optional screenshot/meta directory for each stage.")
    parser.add_argument("--keep-open", action="store_true", help="Leave the browser open at the end.")
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    profile_dir = Path(args.profile_dir).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    browser = trw.choose_browser(args.browser)
    driver = trw.make_webdriver(
        browser=browser,
        profile_dir=profile_dir,
        headless=args.headless,
        window_size=args.window_size,
        download_dir=None,
    )

    try:
        trw.open_chat(driver, args.chat_url)
        # Make sure the chat is interactive before touching the toolbar.
        trw.wait_for_no_blocking_overlays(driver, args.timeout)
        trw.dismiss_dialog(driver, timeout=3.0)
        time.sleep(1.5)

        # Start from a clean compose box (drops leftover Loop drafts).
        log("Clearing any leftover compose drafts...")
        cleared = clear_compose_drafts(driver, args.debug_dir)
        log(f"  Removed {cleared} draft component(s).")

        if args.clear_draft:
            trw.save_debug_snapshot(driver, args.debug_dir, "clear_only")
            log("--clear-draft: done.")
            return 0

        if not args.text:
            log("No --text provided; nothing to create.")
            return 2

        ok_count = 0
        for text in args.text:
            if create_one_loop(
                driver,
                text=text,
                loop_type=args.loop_type,
                send=not args.no_send,
                confirm_timeout=args.confirm_timeout,
                timeout=args.timeout,
                debug_dir=args.debug_dir,
            ):
                ok_count += 1

        total = len(args.text)
        log(f"\nDone: {ok_count}/{total} Loop component(s) created.")
        return 0 if ok_count == total else 1
    finally:
        if args.keep_open:
            trw.keep_browser_open()
        else:
            driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
