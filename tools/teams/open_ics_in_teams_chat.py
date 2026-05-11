#!/usr/bin/env python3
"""
Open Microsoft Teams with an ICS script result pre-filled in a chat compose box.

This avoids Microsoft Graph and Teams Workflows by using the Teams deep-link
format documented by Microsoft. It fills the compose box; the user still sends
the message in Teams.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import time
import urllib.parse
from pathlib import Path


DEFAULT_MAX_CHARS = 4_000
DEFAULT_MAX_URL_CHARS = 12_000
BOOTSTRAP_XDOTOOL_DIR = Path("/tmp/aletheia-xdotool")
SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parents[1]


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


load_env_files(SCRIPT_DIR / ".env", REPO_ROOT / ".env")

from post_ics_to_teams import (  # noqa: E402
    DEFAULT_SCRIPT,
    build_result_message,
    run_script,
    truncate_text,
)


DEFAULT_TEAMS_CHAT_DEEP_LINK_BASE = os.environ.get(
    "TEAMS_CHAT_DEEP_LINK_BASE",
    "https://teams.microsoft.com/l/chat/0/0?",
)


def build_teams_chat_deep_link(
    *,
    user: str,
    message: str,
    tenant_id: str | None = None,
    base_url: str = DEFAULT_TEAMS_CHAT_DEEP_LINK_BASE,
) -> str:
    params = {
        "users": user,
        "message": message,
    }
    if tenant_id:
        params["tenantId"] = tenant_id

    separator = "" if base_url.endswith("?") or base_url.endswith("&") else "?"
    return base_url + separator + urllib.parse.urlencode(params)


def open_url(url: str) -> None:
    opener = shutil.which("xdg-open")
    if not opener:
        raise RuntimeError("xdg-open was not found. Use --no-open and open the printed URL manually.")

    subprocess.Popen(
        [opener, url],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        start_new_session=True,
    )


def ensure_xdotool() -> str:
    system_xdotool = shutil.which("xdotool")
    if system_xdotool:
        return system_xdotool

    bootstrapped_xdotool = BOOTSTRAP_XDOTOOL_DIR / "root/usr/bin/xdotool"
    if bootstrapped_xdotool.exists():
        return str(bootstrapped_xdotool)

    apt_get = shutil.which("apt-get")
    dpkg_deb = shutil.which("dpkg-deb")
    if not apt_get or not dpkg_deb:
        raise RuntimeError("xdotool was not found, and apt-get/dpkg-deb are unavailable.")

    BOOTSTRAP_XDOTOOL_DIR.mkdir(parents=True, exist_ok=True)
    subprocess.run(
        [apt_get, "download", "xdotool", "libxdo3"],
        cwd=str(BOOTSTRAP_XDOTOOL_DIR),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        check=True,
    )
    for deb in BOOTSTRAP_XDOTOOL_DIR.glob("*.deb"):
        subprocess.run(
            [dpkg_deb, "-x", str(deb), str(BOOTSTRAP_XDOTOOL_DIR / "root")],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=True,
        )

    if not bootstrapped_xdotool.exists():
        raise RuntimeError("Downloaded xdotool package, but the xdotool binary was not found.")
    return str(bootstrapped_xdotool)


def run_xdotool(xdotool: str, *args: str) -> subprocess.CompletedProcess[str]:
    env = os.environ.copy()
    lib_dir = str(BOOTSTRAP_XDOTOOL_DIR / "root/usr/lib/x86_64-linux-gnu")
    if Path(xdotool).is_relative_to(BOOTSTRAP_XDOTOOL_DIR) and Path(lib_dir).exists():
        env["LD_LIBRARY_PATH"] = lib_dir + (
            os.pathsep + env["LD_LIBRARY_PATH"] if env.get("LD_LIBRARY_PATH") else ""
        )

    return subprocess.run(
        [xdotool, *args],
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )


def find_teams_window(xdotool: str) -> str:
    result = run_xdotool(xdotool, "search", "--name", "Microsoft Teams")
    window_ids = [line.strip() for line in result.stdout.splitlines() if line.strip()]
    if not window_ids:
        raise RuntimeError("Could not find a visible Microsoft Teams browser window.")
    return window_ids[-1]


def activate_teams_and_send(*, xdotool: str, send_key: str) -> None:
    window_id = find_teams_window(xdotool)
    activate = run_xdotool(xdotool, "windowactivate", "--sync", window_id)
    if activate.returncode != 0:
        raise RuntimeError(activate.stderr.strip() or "Failed to activate Microsoft Teams window.")

    time.sleep(0.25)
    send = run_xdotool(xdotool, "key", "--clearmodifiers", send_key)
    if send.returncode != 0:
        raise RuntimeError(send.stderr.strip() or f"Failed to send key: {send_key}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Run ICS_print_PW_v1.py and open Teams with the result pre-filled "
            "in a one-to-one chat compose box."
        )
    )
    parser.add_argument("--script", default=DEFAULT_SCRIPT, help="Python script to run.")
    parser.add_argument(
        "--teams-user",
        default=os.environ.get("TEAMS_SELF_UPN"),
        help=(
            "Teams user principal name, usually your work email. "
            "Defaults to TEAMS_SELF_UPN. For self-chat, use your own Teams login email."
        ),
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
        "--message",
        help="Use this message instead of running the ICS script. Useful for smoke tests.",
    )
    parser.add_argument("--title", default="ICS_print_PW_v1.py result")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument("--max-url-chars", type=int, default=DEFAULT_MAX_URL_CHARS)
    parser.add_argument(
        "--allow-sensitive",
        action="store_true",
        help=(
            "Use raw script output. Without this, cookie/password-like values are redacted. "
            "Deep-link messages can remain in browser history."
        ),
    )
    parser.add_argument(
        "--no-open",
        action="store_true",
        help="Print the Teams deep link instead of opening it.",
    )
    parser.add_argument(
        "--send",
        action="store_true",
        help="After opening the deep link, activate the Teams window and press the send key.",
    )
    parser.add_argument(
        "--send-delay",
        type=float,
        default=8.0,
        help="Seconds to wait after opening Teams before sending the key.",
    )
    parser.add_argument(
        "--send-key",
        default="Return",
        help="xdotool key to send. Use Return first; ctrl+Return is another common Teams shortcut.",
    )
    parser.add_argument(
        "--xdotool-path",
        help="Optional xdotool path. If omitted, the script uses PATH or bootstraps xdotool in /tmp.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if not args.teams_user:
        print(
            "Missing --teams-user. Set TEAMS_SELF_UPN to your Teams login email "
            "or pass --teams-user you@company.com.",
            file=sys.stderr,
        )
        return 2

    if args.message is not None:
        message = truncate_text(args.message, args.max_chars)
    else:
        try:
            result = run_script(Path(args.script), args.timeout)
        except subprocess.TimeoutExpired as exc:
            message = build_result_message(
                title=args.title,
                return_code=124,
                stdout=exc.stdout or "",
                stderr=(exc.stderr or "") + f"\nTimed out after {args.timeout} seconds.",
                allow_sensitive=args.allow_sensitive,
                max_chars=args.max_chars,
            )
        except Exception as exc:
            message = build_result_message(
                title=args.title,
                return_code=1,
                stdout="",
                stderr=str(exc),
                allow_sensitive=args.allow_sensitive,
                max_chars=args.max_chars,
            )
        else:
            message = build_result_message(
                title=args.title,
                return_code=result.returncode,
                stdout=result.stdout,
                stderr=result.stderr,
                allow_sensitive=args.allow_sensitive,
                max_chars=args.max_chars,
            )

    url = build_teams_chat_deep_link(
        user=args.teams_user,
        message=message,
        tenant_id=args.tenant_id,
        base_url=args.teams_chat_base_url,
    )

    if len(url) > args.max_url_chars:
        print(
            f"Teams deep link is too long: {len(url)} chars. "
            f"Reduce --max-chars below {args.max_chars} and try again.",
            file=sys.stderr,
        )
        return 3

    if args.no_open:
        print(url)
        return 0

    open_url(url)
    if args.send:
        time.sleep(args.send_delay)
        xdotool = args.xdotool_path or ensure_xdotool()
        activate_teams_and_send(xdotool=xdotool, send_key=args.send_key)
        print("Opened Teams deep link and sent the pre-filled message.")
        return 0

    print("Opened Teams deep link. Review the pre-filled message, then press Send in Teams.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
