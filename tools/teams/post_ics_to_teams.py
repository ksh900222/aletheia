#!/usr/bin/env python3
"""
Run an ICS helper script and post its output to Microsoft Teams.

This is designed for Teams Workflows webhooks, which can post to a chat or
channel without calling Microsoft Graph directly.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any


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


DEFAULT_SCRIPT = os.environ.get("ICS_POST_SCRIPT", "")
DEFAULT_MAX_CHARS = 20_000


def redact_sensitive_text(text: str) -> str:
    """Redact obvious credential-like values from captured process output."""
    redacted_lines: list[str] = []
    redact_next_non_empty_line = False

    key_value_pattern = re.compile(
        r"(?i)\b(password|passwd|pwd|pw|token|secret|cookie|authorization|bearer)\b"
        r"(\s*[:=]\s*)"
        r"(.+)$"
    )

    for line in text.splitlines():
        if redact_next_non_empty_line and line.strip():
            redacted_lines.append("<redacted>")
            redact_next_non_empty_line = False
            continue

        if "icspwd cookie value" in line.lower():
            redacted_lines.append(line)
            redact_next_non_empty_line = True
            continue

        redacted_lines.append(key_value_pattern.sub(r"\1\2<redacted>", line))

    return "\n".join(redacted_lines)


def truncate_text(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text

    suffix = f"\n\n[truncated: original length {len(text)} chars]"
    return text[: max(0, max_chars - len(suffix))] + suffix


def run_script(script: Path, timeout: int) -> subprocess.CompletedProcess[str]:
    script = script.resolve()
    if not script.exists():
        raise FileNotFoundError(f"Script not found: {script}")

    return subprocess.run(
        [sys.executable, str(script)],
        cwd=str(script.parent),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )


def build_result_message(
    *,
    title: str,
    return_code: int,
    stdout: str,
    stderr: str,
    allow_sensitive: bool,
    max_chars: int,
) -> str:
    if not allow_sensitive:
        stdout = redact_sensitive_text(stdout)
        stderr = redact_sensitive_text(stderr)

    status = "OK" if return_code == 0 else f"FAILED ({return_code})"
    timestamp = dt.datetime.now().astimezone().isoformat(timespec="seconds")
    sections = [
        f"{title}",
        f"status: {status}",
        f"time: {timestamp}",
        "",
        "STDOUT:",
        stdout.strip() or "(empty)",
    ]

    if stderr.strip():
        sections.extend(["", "STDERR:", stderr.strip()])

    return truncate_text("\n".join(sections), max_chars)


def build_payload(message: str, mode: str) -> dict[str, Any]:
    if mode == "workflow":
        return {"text": message}

    if mode == "adaptive":
        return {
            "type": "message",
            "attachments": [
                {
                    "contentType": "application/vnd.microsoft.card.adaptive",
                    "content": {
                        "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
                        "type": "AdaptiveCard",
                        "version": "1.2",
                        "body": [
                            {
                                "type": "TextBlock",
                                "text": "ICS script result",
                                "weight": "Bolder",
                                "wrap": True,
                            },
                            {
                                "type": "TextBlock",
                                "text": message,
                                "wrap": True,
                            },
                        ],
                    },
                }
            ],
        }

    raise ValueError(f"Unsupported payload mode: {mode}")


def post_json(webhook_url: str, payload: dict[str, Any]) -> tuple[int, str]:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        webhook_url,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )

    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            response_body = response.read().decode("utf-8", errors="replace")
            return response.status, response_body
    except urllib.error.HTTPError as exc:
        response_body = exc.read().decode("utf-8", errors="replace")
        raise RuntimeError(f"Webhook POST failed: HTTP {exc.code}: {response_body}") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run an ICS helper script and post the captured output to Teams."
    )
    parser.add_argument(
        "--script",
        default=DEFAULT_SCRIPT,
        help="Python script to run. Defaults to ICS_POST_SCRIPT.",
    )
    parser.add_argument(
        "--webhook-url",
        default=os.environ.get("TEAMS_WEBHOOK_URL"),
        help="Teams Workflow or Incoming Webhook URL. Defaults to TEAMS_WEBHOOK_URL.",
    )
    parser.add_argument(
        "--mode",
        choices=["workflow", "adaptive"],
        default=os.environ.get("TEAMS_PAYLOAD_MODE", "workflow"),
        help="Payload format. Use workflow for Teams Workflows webhook URLs.",
    )
    parser.add_argument(
        "--message",
        help="Send this message instead of running the ICS script. Useful for smoke tests.",
    )
    parser.add_argument("--title", default="ICS_print_PW_v1.py result")
    parser.add_argument("--timeout", type=int, default=120)
    parser.add_argument("--max-chars", type=int, default=DEFAULT_MAX_CHARS)
    parser.add_argument(
        "--allow-sensitive",
        action="store_true",
        help="Send raw output. Without this, cookie/password-like values are redacted.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Print the JSON payload without posting it to Teams.",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()

    if args.message is not None:
        message = truncate_text(args.message, args.max_chars)
    else:
        if not args.script:
            print("Missing --script or ICS_POST_SCRIPT when --message is not provided.", file=sys.stderr)
            return 2
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

    payload = build_payload(message, args.mode)

    if args.dry_run:
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return 0

    if not args.webhook_url:
        print("TEAMS_WEBHOOK_URL is not set and --webhook-url was not provided.", file=sys.stderr)
        return 2

    status, response_body = post_json(args.webhook_url, payload)
    print(f"Teams webhook POST completed: HTTP {status}")
    if response_body.strip():
        print(response_body.strip())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
