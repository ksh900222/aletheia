#!/usr/bin/env python3
"""
Read the latest Teams self-chat message on Linux.

This does not use Microsoft Graph or Teams Workflows. It opens Teams Web with a
persistent browser profile, reads the latest visible chat message from the DOM,
and prints it to stdout.

First run may require interactive Teams login in the opened browser. The login
session is stored in the browser profile directory.
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import sys
import time
import urllib.parse
from pathlib import Path
from typing import Any


SCRIPT_DIR = Path(__file__).resolve().parent


def load_env_files(*paths: Path) -> None:
    """Load simple KEY=VALUE .env files without overriding real environment vars."""
    for path in paths:
        if not path.exists():
            continue
        for raw_line in path.read_text(encoding="utf-8").splitlines():
            line = raw_line.strip()
            if not line or line.startswith("#"):
                continue
            if line.startswith("export "):
                line = line[len("export "):].strip()
            if "=" not in line:
                continue
            key, value = line.split("=", 1)
            key = key.strip()
            value = value.strip()
            if not key or key in os.environ:
                continue
            if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
                value = value[1:-1]
            os.environ[key] = value


load_env_files(
    SCRIPT_DIR / ".env",
    SCRIPT_DIR / "tools" / "ics" / ".env",
    SCRIPT_DIR / "tools" / "teams" / ".env",
)


DEFAULT_PROFILE_DIR = Path.home() / ".cache" / "ics-teams-reader" / "chrome-profile"
DEFAULT_TIMEOUT = 180.0
DEFAULT_STABLE_POLLS = 2
DEFAULT_PASSWORD_REGEX = r"^\S{4,200}$"
DEFAULT_TEAMS_CHAT_DEEP_LINK_BASE = os.environ.get(
    "TEAMS_CHAT_DEEP_LINK_BASE",
    "https://teams.microsoft.com/l/chat/0/0?",
)


EXTRACT_MESSAGES_JS = r"""
const selectors = [
  '[data-tid="messageBodyContent"]',
  '[data-tid="message-body"]',
  '[data-tid*="messageBody"]',
  '[data-tid*="message-body"]',
  'div[id^="content-"]',
  '[data-tid="chat-pane-message"] [dir="auto"]',
  '[role="listitem"] [dir="auto"]',
  '[data-tid*="message"]'
];

const rejectContains = [
  'type a message',
  'new chat',
  'search',
  'filter',
  'format',
  'attach',
  'emoji',
  'sticker',
  'gif',
  'apps',
  'send',
  'meet now',
  'activity',
  'calls',
  'calendar',
  'has context menu',
  'context menu',
  'more options',
  'reaction',
  'react',
  'reply',
  'forward',
  'copy',
  'pin',
  'delete'
];

function visible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

function normalize(text) {
  return (text || '')
    .replace(/\u200b/g, '')
    .replace(/\r/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function rejected(text) {
  if (!text || text.length > 4000) {
    return true;
  }
  const lower = text.toLowerCase();
  for (const needle of rejectContains) {
    if (lower === needle || lower.includes(needle + '\n') || lower.includes('\n' + needle)) {
      return true;
    }
  }
  return false;
}

function scrollLikelyChatPanesToBottom() {
  try {
    if (document.scrollingElement) {
      document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
    }
    const elements = Array.from(document.querySelectorAll('div, main, section'));
    for (const element of elements) {
      if (element.scrollHeight > element.clientHeight + 80 && element.clientHeight > 120) {
        element.scrollTop = element.scrollHeight;
      }
    }
  } catch (error) {
  }
}

scrollLikelyChatPanesToBottom();

let entries = [];
let order = 0;
for (let tier = 0; tier < selectors.length; tier += 1) {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(selectors[tier]));
  } catch (error) {
    nodes = [];
  }

  for (const node of nodes) {
    if (!visible(node)) {
      continue;
    }
    const text = normalize(node.innerText || node.textContent || '');
    if (rejected(text)) {
      continue;
    }
    const rect = node.getBoundingClientRect();
    entries.push({
      text,
      tier,
      order,
      y: rect.y,
      bottom: rect.bottom,
      height: rect.height,
      selector: selectors[tier],
    });
    order += 1;
  }
}

const byText = new Map();
for (const entry of entries) {
  const previous = byText.get(entry.text);
  if (!previous || entry.tier < previous.tier || entry.bottom > previous.bottom) {
    byText.set(entry.text, entry);
  }
}

entries = Array.from(byText.values());
entries.sort((a, b) => {
  if (a.bottom !== b.bottom) return a.bottom - b.bottom;
  if (a.order !== b.order) return a.order - b.order;
  return a.tier - b.tier;
});

return entries;
"""


def build_teams_chat_deep_link(
    *,
    user: str,
    tenant_id: str | None = None,
    base_url: str = DEFAULT_TEAMS_CHAT_DEEP_LINK_BASE,
) -> str:
    params = {"users": user}
    if tenant_id:
        params["tenantId"] = tenant_id
    separator = "" if base_url.endswith("?") or base_url.endswith("&") else "?"
    return base_url + separator + urllib.parse.urlencode(params)


def choose_browser(preferred: str) -> str:
    if preferred in {"chrome", "edge"}:
        return preferred
    if shutil.which("google-chrome") or shutil.which("chromium") or shutil.which("chromium-browser"):
        return "chrome"
    if shutil.which("microsoft-edge") or shutil.which("msedge"):
        return "edge"
    return "chrome"


def make_browser_options(
    *,
    browser: str,
    profile_dir: Path,
    headless: bool,
    window_size: str,
) -> Any:
    if browser == "edge":
        from selenium.webdriver.edge.options import Options
    elif browser == "chrome":
        from selenium.webdriver.chrome.options import Options
    else:
        raise ValueError(f"Unsupported browser: {browser}")

    options = Options()
    options.add_argument(f"--user-data-dir={profile_dir}")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--no-sandbox")
    options.add_argument(f"--window-size={window_size}")
    options.add_argument("--disable-features=LocalNetworkAccessChecks")

    if headless:
        options.add_argument("--headless=new")

    binary_env = os.environ.get("TEAMS_BROWSER_BINARY")
    if binary_env:
        options.binary_location = binary_env

    return options


def make_webdriver(
    *,
    browser: str,
    profile_dir: Path,
    headless: bool,
    window_size: str,
) -> Any:
    try:
        from selenium import webdriver
    except ImportError as exc:
        raise ImportError("selenium is required: python3 -m pip install selenium") from exc

    options = make_browser_options(
        browser=browser,
        profile_dir=profile_dir,
        headless=headless,
        window_size=window_size,
    )
    if browser == "edge":
        return webdriver.Edge(options=options)
    if browser == "chrome":
        return webdriver.Chrome(options=options)
    raise ValueError(f"Unsupported browser: {browser}")


def normalize_message_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("\r", "\n").split("\n")]
    lines = [line for line in lines if line]
    return "\n".join(lines).strip()


def extract_password_like_text(text: str, password_regex: str | None) -> str:
    normalized = normalize_message_text(text)
    if not password_regex:
        return normalized

    pattern = re.compile(password_regex)
    lines = normalized.split("\n")
    matches = [line for line in lines if pattern.fullmatch(line)]
    if matches:
        return matches[-1]

    full_match = pattern.fullmatch(normalized)
    if full_match:
        return normalized

    return normalized


def find_password_like_text(text: str, password_regex: str | None) -> str | None:
    normalized = normalize_message_text(text)
    if not normalized:
        return None

    if not password_regex:
        return normalized

    pattern = re.compile(password_regex)
    lines = normalized.split("\n")
    matches = [line for line in lines if pattern.fullmatch(line)]
    if matches:
        return matches[-1]

    if pattern.fullmatch(normalized):
        return normalized

    return None


def save_debug_snapshot(driver: Any, debug_dir: str | None, label: str) -> None:
    if not debug_dir:
        return

    debug_path = Path(debug_dir)
    debug_path.mkdir(parents=True, exist_ok=True)
    stamp = time.strftime("%Y%m%d_%H%M%S")
    safe_label = "".join(ch if ch.isalnum() or ch in "-_" else "_" for ch in label)

    try:
        current_url = driver.current_url
    except Exception as exc:
        current_url = f"<unavailable: {exc}>"

    try:
        title = driver.title
    except Exception as exc:
        title = f"<unavailable: {exc}>"

    (debug_path / f"{stamp}_{safe_label}.txt").write_text(
        f"url={current_url}\ntitle={title}\n",
        encoding="utf-8",
    )

    try:
        driver.save_screenshot(str(debug_path / f"{stamp}_{safe_label}.png"))
    except Exception:
        pass


def get_message_candidates(driver: Any) -> list[dict[str, Any]]:
    result = driver.execute_script(EXTRACT_MESSAGES_JS)
    if not isinstance(result, list):
        return []
    return [entry for entry in result if isinstance(entry, dict) and entry.get("text")]


def select_latest_message(candidates: list[dict[str, Any]], password_regex: str | None) -> str | None:
    if not candidates:
        return None

    preferred = [entry for entry in candidates if int(entry.get("tier", 99)) <= 4]
    pool = preferred or candidates

    if password_regex:
        for entry in reversed(pool):
            password_like_text = find_password_like_text(str(entry["text"]), password_regex)
            if password_like_text:
                return password_like_text
        return None

    latest = pool[-1]
    return extract_password_like_text(str(latest["text"]), password_regex)


def wait_for_latest_message(
    *,
    driver: Any,
    timeout: float,
    poll_interval: float,
    stable_polls: int,
    password_regex: str | None,
    debug_dir: str | None,
) -> str:
    end_time = time.time() + timeout
    last_text: str | None = None
    stable_count = 0

    while time.time() < end_time:
        candidates = get_message_candidates(driver)
        text = select_latest_message(candidates, password_regex)
        if text:
            if text == last_text:
                stable_count += 1
            else:
                last_text = text
                stable_count = 1

            if stable_count >= stable_polls:
                return text

        time.sleep(poll_interval)

    save_debug_snapshot(driver, debug_dir, "latest_message_timeout")
    raise TimeoutError(f"Could not find a Teams chat message within {timeout} seconds.")


def write_secret_file(path: str, value: str) -> None:
    output_path = Path(path)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(value + "\n", encoding="utf-8")
    try:
        output_path.chmod(0o600)
    except Exception:
        pass


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read the latest message from a Teams self-chat on Linux."
    )
    parser.add_argument(
        "--teams-user",
        default=os.environ.get("TEAMS_SELF_UPN"),
        help="Teams login email/UPN for the chat. Defaults to TEAMS_SELF_UPN.",
    )
    parser.add_argument(
        "--tenant-id",
        default=os.environ.get("TEAMS_TENANT_ID"),
        help="Optional Microsoft Entra tenant ID. Defaults to TEAMS_TENANT_ID.",
    )
    parser.add_argument(
        "--teams-chat-base-url",
        default=DEFAULT_TEAMS_CHAT_DEEP_LINK_BASE,
        help="Teams chat deep-link base URL. Defaults to TEAMS_CHAT_DEEP_LINK_BASE.",
    )
    parser.add_argument(
        "--browser",
        choices=["auto", "chrome", "edge"],
        default=os.environ.get("TEAMS_BROWSER", "auto"),
    )
    parser.add_argument(
        "--profile-dir",
        default=os.environ.get("TEAMS_PROFILE_DIR", str(DEFAULT_PROFILE_DIR)),
        help="Persistent browser profile for Teams login state.",
    )
    parser.add_argument("--headless", action="store_true", help="Run browser headless.")
    parser.add_argument("--window-size", default="1400,1000")
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--poll-interval", type=float, default=1.0)
    parser.add_argument("--stable-polls", type=int, default=DEFAULT_STABLE_POLLS)
    parser.add_argument(
        "--password-regex",
        default=DEFAULT_PASSWORD_REGEX,
        help="Line-level regex used to extract the password from a message candidate. Use empty string to disable.",
    )
    parser.add_argument("--output-file", help="Optional file to write the latest message text.")
    parser.add_argument("--debug-dir", help="Optional screenshot/meta directory for failures.")
    parser.add_argument(
        "--login-only",
        action="store_true",
        help="Open Teams and wait so you can sign in, then exit without reading messages.",
    )
    parser.add_argument("--login-wait", type=float, default=300.0)
    parser.add_argument(
        "--keep-open",
        action="store_true",
        help="Leave the browser open after reading the latest message.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.teams_user:
        print("Missing --teams-user or TEAMS_SELF_UPN.", file=sys.stderr)
        return 2

    profile_dir = Path(args.profile_dir).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    browser = choose_browser(args.browser)
    password_regex = args.password_regex or None

    url = build_teams_chat_deep_link(
        user=args.teams_user,
        tenant_id=args.tenant_id,
        base_url=args.teams_chat_base_url,
    )
    driver = make_webdriver(
        browser=browser,
        profile_dir=profile_dir,
        headless=args.headless,
        window_size=args.window_size,
    )

    try:
        driver.get(url)

        if args.login_only:
            print(
                f"Opened Teams login/chat window. Waiting {args.login_wait:g} seconds...",
                file=sys.stderr,
            )
            time.sleep(args.login_wait)
            return 0

        latest_message = wait_for_latest_message(
            driver=driver,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
            stable_polls=args.stable_polls,
            password_regex=password_regex,
            debug_dir=args.debug_dir,
        )

        if args.output_file:
            write_secret_file(args.output_file, latest_message)

        print(latest_message)
        return 0
    finally:
        if args.keep_open:
            print("Leaving Teams browser open. Press Ctrl+C to end the script.", file=sys.stderr)
            try:
                while True:
                    time.sleep(3600)
            except KeyboardInterrupt:
                pass
        else:
            driver.quit()


if __name__ == "__main__":
    raise SystemExit(main())
