#!/usr/bin/env python3
"""
Read, write, and access files in a Microsoft Teams chat without Graph API.

This script uses Teams Web through Selenium. It requires that the browser
profile used by Selenium is already signed in to Teams, or that you run
`login` once and sign in interactively.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import sys
import time
import urllib.parse
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


DEFAULT_CHAT_URL = os.environ.get("TEAMS_CHAT_URL", "")
DEFAULT_PROFILE_DIR = Path.home() / ".cache" / "teams-chat-rw" / "chrome-profile"
DEFAULT_DOWNLOAD_DIR = Path.cwd() / "teams_downloads"
DEFAULT_TIMEOUT = 120.0
DEFAULT_WINDOW_SIZE = "1400,1000"


SCROLL_CHAT_TO_BOTTOM_JS = r"""
function visible(element) {
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

try {
  if (document.scrollingElement) {
    document.scrollingElement.scrollTop = document.scrollingElement.scrollHeight;
  }
  const elements = Array.from(document.querySelectorAll('div, main, section'));
  for (const element of elements) {
    if (!visible(element)) {
      continue;
    }
    if (element.scrollHeight > element.clientHeight + 80 && element.clientHeight > 120) {
      element.scrollTop = element.scrollHeight;
    }
  }
} catch (error) {
}
"""


EXTRACT_CHAT_ITEMS_JS = r"""
const bodySelectors = [
  '[data-tid="messageBodyContent"]',
  '[data-tid="message-body"]',
  '[data-tid*="messageBody"]',
  '[data-tid*="message-body"]',
  'div[id^="content-"]',
  '[data-tid="chat-pane-message"] [dir="auto"]',
  '[role="listitem"] [dir="auto"]'
];

const authorSelectors = [
  '[data-tid="message-author-name"]',
  '[data-tid*="message-author"]',
  '[data-tid*="author"]',
  '[data-tid*="sender"]',
  '[class*="author"]'
];

const timeSelectors = [
  'time',
  '[datetime]',
  '[data-tid*="timestamp"]',
  '[data-tid*="time"]',
  '[title*="AM"]',
  '[title*="PM"]',
  '[aria-label*="AM"]',
  '[aria-label*="PM"]'
];

const rejectExact = new Set([
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
  'reply',
  'forward',
  'copy',
  'pin',
  'delete'
]);

function visible(element) {
  if (!element) return false;
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

function rejectedText(text) {
  if (!text || text.length > 10000) return true;
  const lower = text.toLowerCase();
  if (rejectExact.has(lower)) return true;
  return false;
}

function textFromFirst(root, selectors) {
  for (const selector of selectors) {
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch (error) {
      nodes = [];
    }
    for (const node of nodes) {
      if (!visible(node)) continue;
      const value = normalize(
        node.innerText ||
        node.textContent ||
        node.getAttribute('aria-label') ||
        node.getAttribute('title') ||
        ''
      );
      if (value && !rejectedText(value)) return value;
    }
  }
  return '';
}

function attrFromFirst(root, selectors, attrs) {
  for (const selector of selectors) {
    let nodes = [];
    try {
      nodes = Array.from(root.querySelectorAll(selector));
    } catch (error) {
      nodes = [];
    }
    for (const node of nodes) {
      if (!visible(node)) continue;
      for (const attr of attrs) {
        const value = normalize(node.getAttribute(attr) || '');
        if (value) return value;
      }
    }
  }
  return '';
}

function bestMessageRoot(body) {
  const selectors = [
    '[data-tid="chat-pane-item"]',
    '[data-tid*="chat-pane-item"]',
    '[data-tid="message-pane-item"]',
    '[data-tid="chat-pane-message"]',
    '[data-tid*="chat-pane-message"]',
    '[role="listitem"]',
    'li',
    'article',
    '[data-tid*="message"]'
  ];
  for (const selector of selectors) {
    const node = body.closest(selector);
    if (node && visible(node)) return node;
  }
  return body;
}

function cleanAuthorCandidate(value) {
  let author = normalize(value)
    .replace(/\bTranslate\b.*$/i, '')
    .replace(/\bEdited\b.*$/i, '')
    .trim();
  if (!author || author.length > 160) return '';

  const words = author.split(/\s+/).filter(Boolean);
  if (words.length % 2 === 0) {
    const half = words.length / 2;
    const first = words.slice(0, half).join(' ');
    const second = words.slice(half).join(' ');
    if (first === second) {
      author = first;
    }
  }

  const lower = author.toLowerCase();
  if (rejectExact.has(lower) || lower.includes('message') || lower.includes('reaction')) {
    return '';
  }
  return author;
}

function parseAuthorFromRest(rest) {
  const normalized = normalize(rest);
  if (!normalized) return '';

  const patterns = [
    /^(.{1,160}?)\s+\d{1,2}:\d{2}\s*(?:AM|PM)?\b/i,
    /^(.{1,160}?)\s+\d{1,2}\/\d{1,2}\/\d{4}\b/i,
    /^(.{1,160}?)\s+Translate\b/i
  ];

  for (const pattern of patterns) {
    const match = normalized.match(pattern);
    if (match) return cleanAuthorCandidate(match[1]);
  }

  return cleanAuthorCandidate(normalized.split('\n')[0]);
}

function parseAuthorFromRootText(bodyText, rootText) {
  const body = normalize(bodyText);
  const root = normalize(rootText);
  if (!body || !root) return '';

  if (root.startsWith(`${body} by `)) {
    return parseAuthorFromRest(root.slice(body.length + 4));
  }

  const marker = ' by ';
  const index = root.indexOf(marker);
  if (index >= 0) {
    return parseAuthorFromRest(root.slice(index + marker.length));
  }

  return '';
}

function parseTimeFromRootText(rootText) {
  const root = normalize(rootText);
  const match = root.match(/\b(?:\d{1,2}\/\d{1,2}\/\d{4},?\s*)?\d{1,2}:\d{2}\s*(?:AM|PM)?\b/i);
  return match ? match[0] : '';
}

function parseAuthorFromLabel(label) {
  const value = normalize(label);
  if (!value) return '';
  const commaParts = value.split(',').map((part) => part.trim()).filter(Boolean);
  if (commaParts.length >= 2 && commaParts[0].length <= 80) {
    const first = commaParts[0].toLowerCase();
    if (!rejectExact.has(first) && !first.includes('message')) {
      return commaParts[0];
    }
  }

  const sentMatch = value.match(/^(.{1,80}?)\s+(sent|wrote|said)\b/i);
  if (sentMatch) return sentMatch[1].trim();

  const koreanMatch = value.match(/^(.{1,80}?)(님이|이|가)\s*(보낸|작성|말)/);
  if (koreanMatch) return koreanMatch[1].trim();

  return '';
}

function isFileLike(anchor) {
  const href = anchor.href || '';
  const text = normalize(anchor.innerText || anchor.textContent || '');
  const aria = normalize(anchor.getAttribute('aria-label') || '');
  const title = normalize(anchor.getAttribute('title') || '');
  const tid = normalize(anchor.getAttribute('data-tid') || '');
  const combined = `${href}\n${text}\n${aria}\n${title}\n${tid}`.toLowerCase();
  if (!href || href.startsWith('javascript:')) return false;

  if (/\.(docx?|xlsx?|xlsm|pptx?|pdf|zip|7z|csv|txt|png|jpe?g|gif|bmp|svg|msg|eml|mp4|mov|avi|py|ipynb)([?#]|$)/i.test(combined)) {
    return true;
  }
  if (combined.includes('sharepoint.com') || combined.includes('onedrive') || combined.includes('/l/file/')) {
    return true;
  }
  if (combined.includes('download') || combined.includes('attachment') || combined.includes('file') || combined.includes('첨부') || combined.includes('파일')) {
    return true;
  }
  return false;
}

function extractFiles(root) {
  const files = [];
  const seen = new Set();
  const anchors = Array.from(root.querySelectorAll('a[href]'));
  for (const anchor of anchors) {
    if (!isFileLike(anchor)) continue;
    const href = anchor.href || '';
    const text = normalize(
      anchor.innerText ||
      anchor.textContent ||
      anchor.getAttribute('aria-label') ||
      anchor.getAttribute('title') ||
      href
    );
    const key = `${href}\n${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    files.push({
      name: text || href,
      href,
      ariaLabel: normalize(anchor.getAttribute('aria-label') || ''),
      title: normalize(anchor.getAttribute('title') || ''),
      dataTid: normalize(anchor.getAttribute('data-tid') || '')
    });
  }
  return files;
}

const bodies = [];
for (const selector of bodySelectors) {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch (error) {
    nodes = [];
  }
  for (const node of nodes) {
    if (visible(node)) bodies.push(node);
  }
}

const messages = [];
const seenRoots = new Set();
let order = 0;
for (const body of bodies) {
  const root = bestMessageRoot(body);
  if (seenRoots.has(root)) continue;
  seenRoots.add(root);

  const bodyText = normalize(body.innerText || body.textContent || '');
  const rootText = normalize(root.innerText || root.textContent || '');
  const text = bodyText && bodyText.length <= rootText.length ? bodyText : rootText;
  if (rejectedText(text)) continue;

  const rect = root.getBoundingClientRect();
  const label = normalize(root.getAttribute('aria-label') || body.getAttribute('aria-label') || '');
  const author = (
    parseAuthorFromRootText(text, rootText) ||
    textFromFirst(root, authorSelectors) ||
    parseAuthorFromLabel(label) ||
    'unknown'
  );
  const timeText = (
    parseTimeFromRootText(rootText) ||
    attrFromFirst(root, timeSelectors, ['datetime', 'title', 'aria-label']) ||
    textFromFirst(root, timeSelectors)
  );

  messages.push({
    id: root.id || '',
    order,
    author,
    time: timeText,
    text,
    ariaLabel: label,
    files: extractFiles(root),
    y: rect.y,
    bottom: rect.bottom
  });
  order += 1;
}

messages.sort((a, b) => {
  if (a.bottom !== b.bottom) return a.bottom - b.bottom;
  return a.order - b.order;
});

return messages;
"""


EXTRACT_VISIBLE_FILES_JS = r"""
function visible(element) {
  if (!element) return false;
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

function isFileLike(anchor) {
  const href = anchor.href || '';
  const text = normalize(anchor.innerText || anchor.textContent || '');
  const aria = normalize(anchor.getAttribute('aria-label') || '');
  const title = normalize(anchor.getAttribute('title') || '');
  const tid = normalize(anchor.getAttribute('data-tid') || '');
  const combined = `${href}\n${text}\n${aria}\n${title}\n${tid}`.toLowerCase();
  if (!href || href.startsWith('javascript:')) return false;

  if (/\.(docx?|xlsx?|xlsm|pptx?|pdf|zip|7z|csv|txt|png|jpe?g|gif|bmp|svg|msg|eml|mp4|mov|avi|py|ipynb)([?#]|$)/i.test(combined)) {
    return true;
  }
  if (combined.includes('sharepoint.com') || combined.includes('onedrive') || combined.includes('/l/file/')) {
    return true;
  }
  if (combined.includes('download') || combined.includes('attachment') || combined.includes('file') || combined.includes('첨부') || combined.includes('파일')) {
    return true;
  }
  return false;
}

const files = [];
const seen = new Set();
const anchors = Array.from(document.querySelectorAll('a[href]'));
for (const anchor of anchors) {
  if (!visible(anchor) || !isFileLike(anchor)) continue;
  const href = anchor.href || '';
  const name = normalize(
    anchor.innerText ||
    anchor.textContent ||
    anchor.getAttribute('aria-label') ||
    anchor.getAttribute('title') ||
    href
  );
  const key = `${href}\n${name}`;
  if (seen.has(key)) continue;
  seen.add(key);
  files.push({
    name: name || href,
    href,
    ariaLabel: normalize(anchor.getAttribute('aria-label') || ''),
    title: normalize(anchor.getAttribute('title') || ''),
    dataTid: normalize(anchor.getAttribute('data-tid') || '')
  });
}
return files;
"""


GET_BLOCKING_OVERLAYS_JS = r"""
function visible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const blockers = [];
const nodes = Array.from(document.querySelectorAll('#loading-screen,[role="progressbar"],[aria-busy="true"]'));
for (const node of nodes) {
  if (!visible(node)) continue;
  const rect = node.getBoundingClientRect();
  const text = [
    node.id || '',
    node.getAttribute('aria-label') || '',
    node.getAttribute('aria-valuetext') || '',
    node.textContent || ''
  ].join(' ').toLowerCase();
  const coversPage = rect.width > window.innerWidth * 0.25 && rect.height > window.innerHeight * 0.15;
  const loadingLike =
    node.id === 'loading-screen' ||
    text.includes('loading') ||
    text.includes('로드') ||
    text.includes('불러');
  if (loadingLike && (coversPage || node.id === 'loading-screen')) {
    blockers.push({
      id: node.id || '',
      role: node.getAttribute('role') || '',
      text,
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height
    });
  }
}
return blockers;
"""


FIND_COMPOSE_JS = r"""
function visible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 20 && rect.height > 10;
}

const selectors = [
  '[data-tid="ckeditor"]',
  '[data-tid="compose-message-area"]',
  '[data-tid*="compose"] [contenteditable="true"]',
  'div[role="textbox"][contenteditable="true"]',
  '[contenteditable="true"][aria-label*="message" i]',
  '[contenteditable="true"][aria-label*="메시지"]',
  '[contenteditable="true"]',
  'textarea'
];

const candidates = [];
for (const selector of selectors) {
  let nodes = [];
  try {
    nodes = Array.from(document.querySelectorAll(selector));
  } catch (error) {
    nodes = [];
  }
  for (const node of nodes) {
    if (!visible(node)) continue;
    const rect = node.getBoundingClientRect();
    const label = `${node.getAttribute('aria-label') || ''} ${node.getAttribute('placeholder') || ''} ${node.getAttribute('data-tid') || ''}`.toLowerCase();
    const score =
      (rect.y > window.innerHeight * 0.45 ? 10 : 0) +
      (label.includes('message') || label.includes('메시지') || label.includes('compose') ? 10 : 0) +
      Math.min(10, rect.width / 100);
    candidates.push({ node, score, y: rect.y });
  }
}

candidates.sort((a, b) => {
  if (a.score !== b.score) return b.score - a.score;
  return b.y - a.y;
});

return candidates.length ? candidates[0].node : null;
"""


FIND_SEND_BUTTON_JS = r"""
function visible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

const buttons = Array.from(document.querySelectorAll('button,[role="button"]'));
const candidates = [];
for (const button of buttons) {
  if (!visible(button)) continue;
  if (button.disabled || button.getAttribute('aria-disabled') === 'true') continue;

  const rect = button.getBoundingClientRect();
  if (rect.y < window.innerHeight * 0.45) continue;

  const label = [
    button.innerText || '',
    button.textContent || '',
    button.getAttribute('aria-label') || '',
    button.getAttribute('title') || '',
    button.getAttribute('data-tid') || ''
  ].join(' ').toLowerCase();

  if (label.includes('attach') || label.includes('file') || label.includes('emoji') || label.includes('gif') || label.includes('파일') || label.includes('첨부')) {
    continue;
  }

  const looksLikeSend =
    label.includes('send') ||
    label.includes('보내기') ||
    label.includes('send message') ||
    label.includes('메시지 보내기');

  if (looksLikeSend) {
    candidates.push({ button, x: rect.x, y: rect.y });
  }
}

candidates.sort((a, b) => {
  if (a.y !== b.y) return b.y - a.y;
  return b.x - a.x;
});

return candidates.length ? candidates[0].button : null;
"""


GET_CURRENT_USER_PROFILE_JS = r"""
function normalize(text) {
  return (text || '').toString().trim();
}

function compactProfile(candidate) {
  if (!candidate || typeof candidate !== 'object') return null;
  const source = candidate.profile && typeof candidate.profile === 'object'
    ? candidate.profile
    : candidate;
  const name = normalize(source.name || source.displayName || source.display_name || '');
  const preferredUsername = normalize(
    source.preferred_username ||
    source.preferredUsername ||
    source.userPrincipalName ||
    source.upn ||
    source.login_hint ||
    ''
  );
  const upn = normalize(source.upn || source.userPrincipalName || '');
  const loginHint = normalize(source.login_hint || source.loginHint || '');

  if (name || preferredUsername || upn || loginHint) {
    return { name, preferredUsername, upn, loginHint };
  }
  return null;
}

function walk(value, depth) {
  if (!value || depth > 5) return null;
  if (typeof value !== 'object') return null;

  const direct = compactProfile(value);
  if (direct && direct.name && (direct.preferredUsername || direct.upn || direct.loginHint)) {
    return direct;
  }

  if (Array.isArray(value)) {
    for (const item of value.slice(0, 40)) {
      const found = walk(item, depth + 1);
      if (found) return found;
    }
    return null;
  }

  for (const key of Object.keys(value).slice(0, 80)) {
    const found = walk(value[key], depth + 1);
    if (found) return found;
  }
  return direct;
}

function scanStorage(storage) {
  for (let i = 0; i < storage.length; i += 1) {
    const key = storage.key(i);
    const raw = storage.getItem(key) || '';
    if (!/auth|user|profile|account|token/i.test(key + raw.slice(0, 200))) {
      continue;
    }
    try {
      const parsed = JSON.parse(raw);
      const found = walk(parsed, 0);
      if (found) return found;
    } catch (error) {
    }
  }
  return null;
}

try {
  return scanStorage(localStorage) || scanStorage(sessionStorage) || {};
} catch (error) {
  return {};
}
"""


def normalize_message_text(text: str) -> str:
    lines = [line.strip() for line in text.replace("\r", "\n").split("\n")]
    return "\n".join(line for line in lines if line).strip()


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
    download_dir: Path | None,
    loop_mode: bool = False,
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
    options.add_argument("--disable-features=LocalNetworkAccessChecks")
    options.add_argument(f"--window-size={window_size}")
    # In loop_mode: skip --disable-background-networking so OneDrive/Fluid sync works.
    if not loop_mode:
        # Bypass Teams service-worker cache so the latest messages are always fetched.
        options.add_argument("--disable-background-networking")
    options.add_argument("--no-service-autorun")

    if loop_mode:
        # Hide Selenium's automation markers so Teams/Loop treats this as a normal session.
        # Chromedriver injects many of these by default; we have to opt them OUT explicitly.
        try:
            # Only exclude switches that materially block Loop sync or expose automation.
            # Keep popup-blocking and first-run suppression so Loop's compose iframe still works.
            options.add_experimental_option(
                "excludeSwitches",
                [
                    "enable-automation",
                    "disable-background-networking",
                    "disable-background-timer-throttling",
                    "disable-backgrounding-occluded-windows",
                    "disable-sync",
                ],
            )
            options.add_experimental_option("useAutomationExtension", False)
        except Exception:
            pass

    if headless:
        options.add_argument("--headless=new")

    binary_env = os.environ.get("TEAMS_BROWSER_BINARY")
    if binary_env:
        options.binary_location = binary_env

    prefs: dict[str, Any] = {
        # Windows: 'msteams:' 류 프로토콜을 차단해서 채팅 딥링크(/l/chat/...)가
        # Teams 데스크톱 앱을 띄우지 않고 브라우저(웹)에 머물게 한다. (Linux 에선 무해)
        "protocol_handler.excluded_schemes": {
            "msteams": True,
            "ms-teams": True,
            "msteams-enterprise": True,
            "msteams-app": True,
            "ms-teams-enterprise": True,
        },
    }
    if download_dir:
        prefs.update(
            {
                "download.default_directory": str(download_dir),
                "download.prompt_for_download": False,
                "download.directory_upgrade": True,
                "safebrowsing.enabled": True,
                "plugins.always_open_pdf_externally": True,
            }
        )
    options.add_experimental_option("prefs", prefs)

    return options


def make_webdriver(
    *,
    browser: str,
    profile_dir: Path,
    headless: bool,
    window_size: str,
    download_dir: Path | None,
    loop_mode: bool = False,
) -> Any:
    try:
        from selenium import webdriver
    except ImportError as exc:
        raise ImportError(
            "selenium is required. Run this with an environment that has selenium, "
            "for example: uv add selenium && uv run python tools/teams/teams_chat_rw.py ..."
        ) from exc

    options = make_browser_options(
        browser=browser,
        profile_dir=profile_dir,
        headless=headless,
        window_size=window_size,
        download_dir=download_dir,
        loop_mode=loop_mode,
    )

    if browser == "edge":
        driver = webdriver.Edge(options=options)
    elif browser == "chrome":
        driver = webdriver.Chrome(options=options)
    else:
        raise ValueError(f"Unsupported browser: {browser}")

    if loop_mode:
        # Override navigator.webdriver before any page script runs.
        # Page.addScriptToEvaluateOnNewDocument fires on every navigation, so this
        # survives the open_chat() driver.get() that follows.
        try:
            driver.execute_cdp_cmd(
                "Page.addScriptToEvaluateOnNewDocument",
                {
                    "source": (
                        "Object.defineProperty(navigator, 'webdriver', "
                        "{get: () => false, configurable: true});"
                    )
                },
            )
        except Exception:
            pass

    if download_dir:
        try:
            driver.execute_cdp_cmd(
                "Page.setDownloadBehavior",
                {"behavior": "allow", "downloadPath": str(download_dir)},
            )
        except Exception:
            pass

    return driver


def save_debug_snapshot(driver: Any, debug_dir: str | None, label: str) -> None:
    if not debug_dir:
        return

    debug_path = Path(debug_dir).expanduser().resolve()
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


def get_blocking_overlays(driver: Any) -> list[dict[str, Any]]:
    try:
        result = driver.execute_script(GET_BLOCKING_OVERLAYS_JS)
    except Exception:
        return []
    if not isinstance(result, list):
        return []
    return [entry for entry in result if isinstance(entry, dict)]


def wait_for_no_blocking_overlays(driver: Any, timeout: float) -> bool:
    end_time = time.time() + timeout
    while time.time() < end_time:
        if not get_blocking_overlays(driver):
            return True
        time.sleep(0.4)
    return not get_blocking_overlays(driver)


def clear_teams_cache(driver: Any) -> None:
    """Clear Teams cache storage and service workers via CDP (cookies preserved)."""
    try:
        driver.execute_cdp_cmd(
            "Storage.clearDataForOrigin",
            {
                "origin": "https://teams.microsoft.com",
                "storageTypes": "cache_storage,service_workers",
            },
        )
    except Exception:
        pass
    # Also unregister service workers via JS so the next navigation is truly fresh.
    try:
        driver.execute_script(
            "navigator.serviceWorker.getRegistrations()"
            ".then(regs => regs.forEach(r => r.unregister()));"
        )
        time.sleep(0.3)
    except Exception:
        pass


def dismiss_dialog(driver: Any, timeout: float = 5.0) -> bool:
    """Click '확인' / 'OK' / 'Dismiss' dialog buttons that block the chat view."""
    end_time = time.time() + timeout
    while time.time() < end_time:
        try:
            btn = driver.execute_script(
                """
                return Array.from(document.querySelectorAll('button,[role="button"]'))
                    .find(el => {
                        const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').trim().toLowerCase();
                        return t === '확인' || t === 'ok' || t === 'dismiss' || t === 'close' || t === '닫기';
                    }) || null;
                """
            )
            if btn:
                driver.execute_script("arguments[0].click();", btn)
                time.sleep(0.5)
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def click_apply_and_restart_banner(driver: Any, timeout: float = 10.0) -> bool:
    """Click the 'Apply and restart' notification banner if present.

    Teams sometimes shows a language/update banner that defers loading the latest
    messages until the app restarts.  Clicking it forces a fresh reload.
    """
    end_time = time.time() + timeout
    while time.time() < end_time:
        try:
            btn = driver.execute_script(
                """
                return Array.from(document.querySelectorAll('button,[role="button"]'))
                    .find(el => {
                        const t = (el.innerText || el.textContent || el.getAttribute('aria-label') || '').toLowerCase();
                        return t.includes('apply') && t.includes('restart');
                    }) || null;
                """
            )
            if btn:
                driver.execute_script("arguments[0].click();", btn)
                return True
        except Exception:
            pass
        time.sleep(0.5)
    return False


def use_web_app_instead(driver: Any, timeout: float = 8.0) -> str:
    """Windows: Teams 가 'Teams 앱에서 열기 / 이 브라우저에서 계속' 런처 페이지를 띄우면
    웹(브라우저)에서 계속을 선택한다. 해당 프롬프트가 없으면 아무 것도 안 한다."""
    pattern = (
        # 실제 Teams 한글 문구: "웹 응용 프로그램을 대신 사용합니다"
        "웹 응용 프로그램을 대신 사용|응용 프로그램을 대신 사용|웹 응용 프로그램 사용|"
        "이 브라우저에서 계속|웹 앱을 대신 사용|웹 앱 사용|웹에서 계속|웹 버전 사용|브라우저에서 계속|웹에서 열기|"
        "continue on this browser|use the web app instead|use the web app|continue on the web|"
        "use web app|use the web|on the web|web app instead|stay on (the )?web"
    )
    end_time = time.time() + timeout
    while time.time() < end_time:
        try:
            clicked = driver.execute_script(
                r"""const re=new RegExp(arguments[0],'i');
                    let cands=[...document.querySelectorAll('a,button,[role=button],span,div')]
                      .filter(e=>{const t=(e.innerText||'').trim(); const r=e.getBoundingClientRect();
                                  return re.test(t)&&t.length<60&&r.width>0&&r.height>0;});
                    if(!cands.length) return '';
                    cands.sort((a,b)=>(a.innerText||'').length-(b.innerText||'').length);
                    const e=cands[0]; const label=(e.innerText||'').trim().slice(0,30);
                    try{e.click();}catch(_){}
                    let c=e;
                    for(let i=0;i<5;i++){ c=c.parentElement; if(!c) break;
                      if(c.tagName==='A'||c.tagName==='BUTTON'||(c.getAttribute&&c.getAttribute('role')==='button')){ try{c.click();}catch(_){} } }
                    return label;""",
                pattern,
            )
            if clicked:
                time.sleep(2.0)
                return clicked
        except Exception:
            pass
        time.sleep(0.5)
    return ""


def open_chat(driver: Any, chat_url: str, ready_timeout: float = 20.0) -> None:
    if not chat_url:
        raise ValueError("Missing Teams chat URL. Set TEAMS_CHAT_URL in .env or pass --chat-url.")
    # Navigate to the chat URL directly (no cache clearing — it breaks Teams).
    driver.get(chat_url)
    # Windows: 데스크톱 앱 런처 페이지가 뜨면 웹에서 계속을 선택.
    use_web_app_instead(driver, timeout=15.0)
    wait_for_no_blocking_overlays(driver, ready_timeout)
    time.sleep(2.0)
    # Dismiss any error/info dialogs that block the chat (e.g. "확인" popups).
    dismiss_dialog(driver, timeout=3.0)
    # If Teams shows an "Apply and restart" banner (language/update change),
    # click it, wait for the app to restart, then navigate back to the chat URL.
    if click_apply_and_restart_banner(driver, timeout=5.0):
        wait_for_no_blocking_overlays(driver, ready_timeout)
        time.sleep(3.0)
        driver.get(chat_url)
        use_web_app_instead(driver, timeout=15.0)
        wait_for_no_blocking_overlays(driver, ready_timeout)
        time.sleep(2.0)
        dismiss_dialog(driver, timeout=3.0)



def get_current_user_profile(driver: Any) -> dict[str, str]:
    try:
        result = driver.execute_script(GET_CURRENT_USER_PROFILE_JS)
    except Exception:
        return {}
    if not isinstance(result, dict):
        return {}
    return {str(key): str(value) for key, value in result.items() if value}


SCROLL_TEAMS_PANE_JS = """
(function() {
  // Target the Teams message list viewport directly before falling back to generic scroll.
  const pane = document.querySelector('[data-tid="message-pane-list-viewport"]');
  if (pane) {
    pane.scrollTop = pane.scrollHeight;
  }
})();
"""


def extract_messages(driver: Any) -> list[dict[str, Any]]:
    driver.execute_script(SCROLL_TEAMS_PANE_JS)
    time.sleep(0.3)
    driver.execute_script(SCROLL_CHAT_TO_BOTTOM_JS)
    time.sleep(0.5)
    driver.execute_script(SCROLL_TEAMS_PANE_JS)
    result = driver.execute_script(EXTRACT_CHAT_ITEMS_JS)
    if not isinstance(result, list):
        return []
    return [entry for entry in result if isinstance(entry, dict) and entry.get("text")]


def extract_visible_files(driver: Any) -> list[dict[str, Any]]:
    result = driver.execute_script(EXTRACT_VISIBLE_FILES_JS)
    if not isinstance(result, list):
        return []
    return [entry for entry in result if isinstance(entry, dict) and entry.get("href")]


def wait_for_messages(
    *,
    driver: Any,
    timeout: float,
    poll_interval: float,
    stable_polls: int,
    debug_dir: str | None,
) -> list[dict[str, Any]]:
    end_time = time.time() + timeout
    last_signature: str | None = None
    stable_count = 0
    last_messages: list[dict[str, Any]] = []

    while time.time() < end_time:
        messages = extract_messages(driver)
        if messages:
            signature = json.dumps(
                [(m.get("author"), m.get("time"), m.get("text")) for m in messages[-10:]],
                ensure_ascii=False,
            )
            if signature == last_signature:
                stable_count += 1
            else:
                stable_count = 1
                last_signature = signature
            last_messages = messages
            if stable_count >= stable_polls:
                return messages
        time.sleep(poll_interval)

    save_debug_snapshot(driver, debug_dir, "messages_timeout")
    if last_messages:
        return last_messages
    raise TimeoutError(f"Could not find Teams chat messages within {timeout} seconds.")


def parse_author_aliases(raw_aliases: list[str] | None) -> dict[str, list[str]]:
    aliases: dict[str, list[str]] = {}
    values: list[str] = []

    env_value = os.environ.get("TEAMS_AUTHOR_ALIASES", "")
    if env_value:
        values.extend(part.strip() for part in re.split(r"[;,]", env_value) if part.strip())
    if raw_aliases:
        values.extend(raw_aliases)

    for value in values:
        if "=" not in value:
            continue
        key, alias_text = value.split("=", 1)
        key = key.strip().lower()
        names = [part.strip() for part in re.split(r"[|]", alias_text) if part.strip()]
        if key and names:
            aliases.setdefault(key, []).extend(names)
    return aliases


def build_author_needles(
    *,
    author: str | None,
    author_aliases: list[str] | None,
    current_user_profile: dict[str, str] | None = None,
) -> list[str]:
    if not author:
        return []

    needles = [author]
    normalized_author = author.lower()
    aliases = parse_author_aliases(author_aliases)
    needles.extend(aliases.get(normalized_author, []))

    profile = current_user_profile or {}
    profile_ids = [
        profile.get("preferredUsername", ""),
        profile.get("upn", ""),
        profile.get("loginHint", ""),
    ]
    if any(normalized_author in value.lower() for value in profile_ids if value):
        display_name = profile.get("name", "")
        if display_name:
            needles.append(display_name)

    deduped: list[str] = []
    seen = set()
    for needle in needles:
        key = needle.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        deduped.append(needle.strip())
    return deduped


def filter_messages(
    messages: list[dict[str, Any]],
    *,
    author_needles: list[str] | None,
    text_regex: str | None,
    limit: int,
) -> list[dict[str, Any]]:
    filtered = messages
    if author_needles:
        lowered_needles = [needle.lower() for needle in author_needles]
        filtered = [
            message for message in filtered
            if any(needle in str(message.get("author", "")).lower() for needle in lowered_needles)
        ]
    if text_regex:
        pattern = re.compile(text_regex, re.MULTILINE)
        filtered = [
            message for message in filtered
            if pattern.search(str(message.get("text", "")))
        ]
    if limit > 0:
        filtered = filtered[-limit:]
    return filtered


def print_messages(messages: list[dict[str, Any]], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(messages, ensure_ascii=False, indent=2))
        return

    for index, message in enumerate(messages, start=1):
        author = message.get("author") or "unknown"
        time_text = message.get("time") or "unknown-time"
        print(f"[{index}] {time_text} | {author}")
        print(str(message.get("text") or "").strip())
        files = message.get("files") or []
        if files:
            print("Files:")
            for file_entry in files:
                print(f"- {file_entry.get('name') or file_entry.get('href')}")
                print(f"  {file_entry.get('href')}")
        if index != len(messages):
            print()


def flatten_files(messages: list[dict[str, Any]], visible_files: list[dict[str, Any]]) -> list[dict[str, Any]]:
    files: list[dict[str, Any]] = []
    seen = set()

    for message in messages:
        for file_entry in message.get("files") or []:
            href = str(file_entry.get("href") or "")
            name = str(file_entry.get("name") or href)
            key = (href, name)
            if not href or key in seen:
                continue
            seen.add(key)
            enriched = dict(file_entry)
            enriched["messageAuthor"] = message.get("author")
            enriched["messageTime"] = message.get("time")
            enriched["messageText"] = message.get("text")
            files.append(enriched)

    for file_entry in visible_files:
        href = str(file_entry.get("href") or "")
        name = str(file_entry.get("name") or href)
        key = (href, name)
        if not href or key in seen:
            continue
        seen.add(key)
        files.append(file_entry)

    return files


def print_files(files: list[dict[str, Any]], *, as_json: bool) -> None:
    if as_json:
        print(json.dumps(files, ensure_ascii=False, indent=2))
        return

    for index, file_entry in enumerate(files, start=1):
        owner = file_entry.get("messageAuthor")
        when = file_entry.get("messageTime")
        suffix = f" ({when} | {owner})" if owner or when else ""
        print(f"[{index}] {file_entry.get('name') or file_entry.get('href')}{suffix}")
        print(file_entry.get("href"))


def find_compose(driver: Any, timeout: float) -> Any:
    end_time = time.time() + timeout
    while time.time() < end_time:
        if get_blocking_overlays(driver):
            time.sleep(0.5)
            continue
        element = driver.execute_script(FIND_COMPOSE_JS)
        if element:
            return element
        time.sleep(0.5)
    raise TimeoutError(f"Could not find Teams compose box within {timeout} seconds.")


def type_message(driver: Any, message: str, timeout: float) -> Any:
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys

    end_time = time.time() + timeout
    compose = find_compose(driver, timeout)
    last_error: Exception | None = None

    while time.time() < end_time:
        wait_for_no_blocking_overlays(driver, min(3.0, max(0.1, end_time - time.time())))
        try:
            driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", compose)
            compose.click()
            time.sleep(0.2)
            break
        except Exception as exc:
            last_error = exc
            try:
                compose = driver.execute_script(FIND_COMPOSE_JS) or compose
            except Exception:
                pass
            time.sleep(0.5)
    else:
        blockers = get_blocking_overlays(driver)
        if blockers:
            raise TimeoutError(f"Teams is still covered by a loading overlay: {blockers[:2]}") from last_error
        raise RuntimeError("Could not focus the Teams compose box.") from last_error

    lines = message.splitlines() or [message]
    for line_index, line in enumerate(lines):
        if line:
            compose.send_keys(line)
        if line_index != len(lines) - 1:
            ActionChains(driver).key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT).perform()
            time.sleep(0.05)
    return compose


def click_send_button(driver: Any, timeout: float) -> bool:
    end_time = time.time() + timeout
    while time.time() < end_time:
        button = driver.execute_script(FIND_SEND_BUTTON_JS)
        if button:
            try:
                driver.execute_script("arguments[0].click();", button)
                return True
            except Exception:
                try:
                    button.click()
                    return True
                except Exception:
                    pass
        time.sleep(0.4)
    return False


def send_with_key(driver: Any, compose: Any, send_key: str) -> None:
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys

    compose.click()
    normalized = send_key.strip().lower().replace(" ", "")
    if normalized in {"auto", "enter", "return"}:
        compose.send_keys(Keys.ENTER)
        return
    if normalized in {"ctrl+enter", "ctrl+return"}:
        ActionChains(driver).key_down(Keys.CONTROL).send_keys(Keys.ENTER).key_up(Keys.CONTROL).perform()
        return
    raise ValueError(f"Unsupported send key: {send_key}")


def wait_for_text(driver: Any, text: str, timeout: float) -> bool:
    expected = normalize_message_text(text)
    if not expected:
        return False

    end_time = time.time() + timeout
    while time.time() < end_time:
        for message in extract_messages(driver):
            current = normalize_message_text(str(message.get("text") or ""))
            if current == expected or expected in current:
                return True
        time.sleep(0.8)
    return False


LOOP_BUTTON_TIDS = (
    "sendMessageCommands-popup-semo",
    "newMessageCommands-popup-semo",
)
LOOP_IFRAME_TITLES = ("Loop 구성 요소", "Loop component")


def _click_confirm_button_once(driver: Any) -> bool:
    # Preferred: explicit data-tid for the draft discard confirm.
    try:
        btn = driver.find_element("css selector", "[data-tid='messagedraft-discard-confirm']")
        driver.execute_script("arguments[0].click();", btn)
        return True
    except Exception:
        pass
    # Fallback: any dialog (ignore aria-hidden — Teams flips it true while still rendering)
    # with a Discard/Confirm button.
    try:
        return bool(driver.execute_script(r"""
            const dlgs = document.querySelectorAll('[role="dialog"], [role="alertdialog"], [data-testid*="dialog"], [class*="DialogSurface"]');
            for (const d of dlgs) {
                const r = d.getBoundingClientRect();
                if (r.width === 0 || r.height === 0) continue;
                const btns = Array.from(d.querySelectorAll('button')).filter(b => {
                    const br = b.getBoundingClientRect();
                    return br.width > 0 && br.height > 0;
                });
                const re = /^(discard|delete|삭제|버리기|폐기|예|yes|확인|ok)$/i;
                const target = btns.find(b => re.test(((b.innerText||'') + ' ' + (b.getAttribute('aria-label')||'')).trim()));
                if (target) { target.click(); return true; }
            }
            return false;
        """))
    except Exception:
        return False


def _modal_overlay_present(driver: Any) -> bool:
    """Detect any modal currently intercepting pointer events over the compose area."""
    try:
        return bool(driver.execute_script(r"""
            // Look at the point where compose lives. If a modal sits on top, it intercepts.
            const sel = '[role="dialog"], [role="alertdialog"], [data-testid*="dialog"], [class*="DialogSurface"]';
            const candidates = document.querySelectorAll(sel);
            for (const d of candidates) {
                const r = d.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) return true;
            }
            return false;
        """))
    except Exception:
        return False


def confirm_discard_draft_dialog(driver: Any, timeout: float = 5.0) -> bool:
    """Confirm cascaded discard modals. Returns True if any were handled."""
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys

    end = time.time() + timeout
    handled_any = False
    while time.time() < end:
        if _click_confirm_button_once(driver):
            handled_any = True
            time.sleep(0.6)
            continue
        if _modal_overlay_present(driver):
            # Try ESC to close a stuck overlay.
            ActionChains(driver).send_keys(Keys.ESCAPE).perform()
            time.sleep(0.5)
            if not _modal_overlay_present(driver):
                handled_any = True
                continue
        else:
            break
        time.sleep(0.2)
    return handled_any


def dismiss_fluid_discard_dialog(driver: Any) -> bool:
    return confirm_discard_draft_dialog(driver, timeout=1.0)


def discard_existing_draft(driver: Any) -> None:
    """Click the compose-toolbar discard button and confirm the modal if needed."""
    try:
        btn = driver.find_element("css selector", "[data-tid='newMessageCommands-discard-draft']")
        if btn.is_displayed():
            driver.execute_script("arguments[0].click();", btn)
            time.sleep(0.4)
            confirm_discard_draft_dialog(driver, timeout=3.0)
    except Exception:
        pass


def click_loop_component_button(driver: Any, timeout: float) -> None:
    """Click the Loop component button in the compose toolbar (inserts a Loop Paragraph)."""
    end_time = time.time() + timeout
    last_error: Exception | None = None
    while time.time() < end_time:
        for tid in LOOP_BUTTON_TIDS:
            try:
                btn = driver.find_element("css selector", f"[data-tid='{tid}']")
                driver.execute_script("arguments[0].click();", btn)
                return
            except Exception as exc:
                last_error = exc
        try:
            btn = driver.find_element("css selector", "button[aria-label*='Loop']")
            driver.execute_script("arguments[0].click();", btn)
            return
        except Exception as exc:
            last_error = exc
        time.sleep(0.4)
    raise RuntimeError("Could not find the Loop component button in the compose toolbar.") from last_error


def wait_for_loop_iframe(driver: Any, timeout: float) -> Any:
    end_time = time.time() + timeout
    last_error: Exception | None = None
    selectors = [f"iframe[title='{t}']" for t in LOOP_IFRAME_TITLES] + ["iframe[title*='Loop']"]
    while time.time() < end_time:
        for sel in selectors:
            try:
                iframe = driver.find_element("css selector", sel)
                if iframe and iframe.size.get("height", 0) > 0:
                    return iframe
            except Exception as exc:
                last_error = exc
        time.sleep(0.3)
    raise TimeoutError("Loop component iframe did not appear in time.") from last_error


def type_into_loop_component(driver: Any, iframe: Any, body: str, title: str | None) -> None:
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys

    driver.switch_to.frame(iframe)
    try:
        end_time = time.time() + 15.0
        canvas = None
        while time.time() < end_time:
            try:
                canvas = driver.find_element(
                    "css selector",
                    "[role='textbox'], .scriptor-pageContainer, [contenteditable='true']",
                )
                if canvas:
                    break
            except Exception:
                pass
            time.sleep(0.3)
        if canvas is None:
            raise RuntimeError("Loop component canvas not found inside the iframe.")

        driver.execute_script("arguments[0].focus(); arguments[0].click();", canvas)
        time.sleep(0.5)

        # Title support is intentionally minimal: a fresh Loop paragraph cursor
        # lands in the body. To keep keystrokes from leaking to the parent (where
        # Ctrl-shortcuts could trigger Teams' draft-discard dialog), we skip cursor
        # navigation and just type the body. Title is unsupported for now.
        lines = body.splitlines() or [body]
        for idx, line in enumerate(lines):
            if line:
                ActionChains(driver).send_keys(line).perform()
            if idx != len(lines) - 1:
                ActionChains(driver).key_down(Keys.SHIFT).send_keys(Keys.ENTER).key_up(Keys.SHIFT).perform()
                time.sleep(0.05)
        time.sleep(0.3)
    finally:
        driver.switch_to.default_content()


def read_message_from_args(args: argparse.Namespace) -> str:
    if args.message_file:
        return Path(args.message_file).expanduser().read_text(encoding="utf-8")
    if args.message is not None:
        return args.message
    if not sys.stdin.isatty():
        return sys.stdin.read()
    raise ValueError("Missing message. Use --message, --message-file, or pipe text on stdin.")


def direct_download_url(url: str) -> str:
    parsed = urllib.parse.urlparse(url)
    if not parsed.scheme.startswith("http"):
        return url
    if "download=1" in parsed.query.lower():
        return url
    if "sharepoint.com" not in parsed.netloc.lower() and "onedrive" not in parsed.netloc.lower():
        return url

    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.append(("download", "1"))
    return urllib.parse.urlunparse(
        parsed._replace(query=urllib.parse.urlencode(query))
    )


def snapshot_download_dir(download_dir: Path) -> set[Path]:
    if not download_dir.exists():
        return set()
    return {path for path in download_dir.iterdir() if path.is_file()}


def wait_for_download(download_dir: Path, before: set[Path], timeout: float) -> list[Path]:
    end_time = time.time() + timeout
    newest: list[Path] = []

    while time.time() < end_time:
        current = snapshot_download_dir(download_dir)
        partials = [
            path for path in current
            if path.suffix in {".crdownload", ".tmp", ".part"}
        ]
        completed = sorted(current - before)
        completed = [
            path for path in completed
            if path.suffix not in {".crdownload", ".tmp", ".part"}
        ]
        if completed:
            newest = completed
        if newest and not partials:
            return newest
        time.sleep(0.5)
    return newest


def open_or_download_files(
    driver: Any,
    files: list[dict[str, Any]],
    *,
    download: bool,
    download_dir: Path,
    timeout: float,
) -> list[str]:
    results: list[str] = []
    download_dir.mkdir(parents=True, exist_ok=True)
    before_all = snapshot_download_dir(download_dir)
    chat_handle = driver.current_window_handle

    for file_entry in files:
        href = str(file_entry.get("href") or "")
        if not href:
            continue
        target_url = direct_download_url(href) if download else href
        before = snapshot_download_dir(download_dir)
        try:
            driver.switch_to.window(chat_handle)
        except Exception:
            pass
        driver.execute_script("window.open(arguments[0], '_blank');", target_url)
        driver.switch_to.window(driver.window_handles[-1])
        time.sleep(1.0)

        if download:
            downloaded = wait_for_download(download_dir, before, timeout)
            if downloaded:
                results.extend(str(path) for path in downloaded if path not in before_all)
            else:
                results.append(f"opened-without-detected-download: {href}")
        else:
            results.append(f"opened: {href}")

    return results


def add_common_args(parser: argparse.ArgumentParser) -> None:
    parser.add_argument(
        "--chat-url",
        default=DEFAULT_CHAT_URL,
        help="Teams chat URL. Defaults to TEAMS_CHAT_URL from .env.",
    )
    parser.add_argument(
        "--browser",
        choices=["auto", "chrome", "edge"],
        default=os.environ.get("TEAMS_BROWSER", "auto"),
    )
    parser.add_argument(
        "--profile-dir",
        default=os.environ.get("TEAMS_PROFILE_DIR", str(DEFAULT_PROFILE_DIR)),
        help="Persistent browser profile directory for Teams login state.",
    )
    parser.add_argument("--headless", action="store_true", help="Run browser headless.")
    parser.add_argument("--window-size", default=DEFAULT_WINDOW_SIZE)
    parser.add_argument("--timeout", type=float, default=DEFAULT_TIMEOUT)
    parser.add_argument("--poll-interval", type=float, default=1.0)
    parser.add_argument("--debug-dir", help="Optional screenshot/meta directory for failures.")
    parser.add_argument(
        "--keep-open",
        action="store_true",
        help="Leave the browser open after the command finishes.",
    )
    parser.add_argument(
        "--reauth-wait",
        type=float,
        default=300.0,
        help="When an expired Teams session is detected, seconds to wait for the user "
             "to finish re-login in the opened browser window before giving up.",
    )
    parser.add_argument(
        "--no-auto-login",
        action="store_true",
        help="If the session is expired, fail loudly instead of opening a login window.",
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read, write, and access files in a Teams group chat through Teams Web."
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    login_parser = subparsers.add_parser("login", help="Open the chat and wait for interactive login.")
    add_common_args(login_parser)
    login_parser.add_argument("--login-wait", type=float, default=300.0)

    read_parser = subparsers.add_parser("read", help="Read visible messages from the chat.")
    add_common_args(read_parser)
    read_parser.add_argument("--limit", type=int, default=10)
    read_parser.add_argument("--author", help="Only include messages whose author contains this text.")
    read_parser.add_argument(
        "--author-alias",
        action="append",
        help=(
            "Map an author ID to one or more Teams display names, e.g. "
            "--author-alias 'user@example.com=Display Name|Korean Name'. "
            "Can also be set with TEAMS_AUTHOR_ALIASES."
        ),
    )
    read_parser.add_argument("--text-regex", help="Only include messages whose text matches this regex.")
    read_parser.add_argument("--stable-polls", type=int, default=2)
    read_parser.add_argument("--json", action="store_true", help="Print structured JSON.")
    read_parser.add_argument("--output-file", help="Optional file to write the result.")

    write_parser = subparsers.add_parser("write", help="Write and send a message to the chat.")
    add_common_args(write_parser)
    write_parser.add_argument("--message", help="Message text to send.")
    write_parser.add_argument("--message-file", help="UTF-8 file containing the message to send.")
    write_parser.add_argument("--no-send", action="store_true", help="Type the message but leave it unsent.")
    write_parser.add_argument(
        "--send-method",
        choices=["button", "key", "auto"],
        default="auto",
        help="Send strategy. auto tries button first, then Enter.",
    )
    write_parser.add_argument(
        "--send-key",
        default="enter",
        help="Send key for --send-method key. Supported: enter, ctrl+enter.",
    )
    write_parser.add_argument(
        "--confirm-timeout",
        type=float,
        default=15.0,
        help="Seconds to wait until the sent text appears in the visible chat.",
    )

    loop_parser = subparsers.add_parser("loop", help="Insert a Loop Paragraph into the chat and send.")
    add_common_args(loop_parser)
    loop_parser.add_argument("--message", help="Loop paragraph body text.")
    loop_parser.add_argument("--message-file", help="UTF-8 file containing the Loop paragraph body.")
    loop_parser.add_argument("--title", help="Optional Loop component title.")
    loop_parser.add_argument("--no-send", action="store_true", help="Insert and type, but leave it unsent.")
    loop_parser.add_argument(
        "--send-method",
        choices=["button", "key", "auto"],
        default="auto",
    )
    loop_parser.add_argument(
        "--send-key",
        default="ctrl+enter",
        help="Send key for --send-method key. Loop components usually need ctrl+enter (Enter inserts a line).",
    )
    loop_parser.add_argument("--confirm-timeout", type=float, default=15.0)
    loop_parser.add_argument(
        "--pre-send-wait",
        type=float,
        default=8.0,
        help="Seconds to wait after typing into the Loop component, before pressing Send. "
             "Loop's .fluid OneDrive upload + link-share permission setup take time; "
             "sending too early results in a broken 'additional information required' link.",
    )

    files_parser = subparsers.add_parser("files", help="List, open, or download visible chat file links.")
    add_common_args(files_parser)
    files_parser.add_argument("--limit", type=int, default=20)
    files_parser.add_argument("--stable-polls", type=int, default=2)
    files_parser.add_argument("--json", action="store_true", help="Print structured JSON.")
    files_parser.add_argument("--open", action="store_true", help="Open each file link in a browser tab.")
    files_parser.add_argument("--download", action="store_true", help="Try to download each file link.")
    files_parser.add_argument(
        "--download-dir",
        default=os.environ.get("TEAMS_DOWNLOAD_DIR", str(DEFAULT_DOWNLOAD_DIR)),
        help="Directory for browser downloads.",
    )
    files_parser.add_argument("--download-timeout", type=float, default=30.0)

    return parser.parse_args()


def build_driver_from_args(
    args: argparse.Namespace,
    *,
    download_dir: Path | None = None,
    loop_mode: bool = False,
) -> Any:
    profile_dir = Path(args.profile_dir).expanduser().resolve()
    profile_dir.mkdir(parents=True, exist_ok=True)
    browser = choose_browser(args.browser)
    return make_webdriver(
        browser=browser,
        profile_dir=profile_dir,
        headless=args.headless,
        window_size=args.window_size,
        download_dir=download_dir,
        loop_mode=loop_mode,
    )


# Hosts the Microsoft sign-in flow redirects to when the Teams session is expired.
AUTH_URL_HOSTS = (
    "login.microsoftonline.com",
    "login.live.com",
    "login.microsoft.com",
    "login.windows.net",
    "msauth",
    "/oauth2/",
    "/common/login",
    "/common/oauth2",
    "account.microsoft.com",
)

# Detects a login / re-auth screen without false-positiving on a slow cold load.
# Only definitive signals count: an account/password input field, or Microsoft's
# in-app re-auth / account-picker prompts.
LOGIN_SCREEN_JS = r"""
(function() {
  if (document.querySelector(
      'input[type="password"], input[name="loginfmt"], #i0116, #i0118, input[name="passwd"]')) {
    return 'input';
  }
  const body = (document.body && document.body.innerText) ? document.body.innerText : '';
  const re = /(다시 로그인|로그인이 필요|세션이 만료|다시 로그인하세요|로그인 상태 유지|계정 선택|sign back in|sign in again|session (has )?expired|log back in|pick an account|stay signed in|keep me signed in)/i;
  if (re.test(body)) return 'text';
  return '';
})();
"""


def is_login_screen(driver: Any) -> bool:
    """True if the page currently shows a Microsoft login / re-auth screen."""
    try:
        url = (driver.current_url or "").lower()
    except Exception:
        url = ""
    if any(host in url for host in AUTH_URL_HOSTS):
        return True
    try:
        return bool(driver.execute_script(LOGIN_SCREEN_JS))
    except Exception:
        return False


def ensure_authenticated(driver: Any, args: argparse.Namespace, *, loop_mode: bool = False) -> Any:
    """Detect an expired Teams session right after open_chat.

    If a login screen is detected, surface it clearly and (per --no-auto-login)
    either fail loudly or open a visible window so the user can re-login in place,
    then continue once authenticated. Returns the driver to keep using (may be a
    freshly launched visible one when the original was headless).
    """
    # Let any sign-in redirect settle before deciding.
    time.sleep(2.0)
    if not is_login_screen(driver):
        return driver

    if args.no_auto_login:
        raise RuntimeError(
            "Teams 세션이 만료되었습니다 (로그인 화면 감지). "
            "`login` 명령으로 재로그인한 뒤 다시 시도해 주세요."
        )

    print(
        "\n⚠ Teams 세션이 만료되었습니다 (로그인 화면 감지).\n"
        "  → 로그인 창을 열어 재로그인을 진행합니다.",
        file=sys.stderr,
        flush=True,
    )

    if args.headless:
        # A headless window can't show a login UI — relaunch a visible browser on the
        # same profile so the user can sign in.
        print("  (headless 모드 → 보이는 창으로 다시 엽니다)", file=sys.stderr, flush=True)
        try:
            driver.quit()
        except Exception:
            pass
        original_headless = args.headless
        args.headless = False
        try:
            driver = build_driver_from_args(args, loop_mode=loop_mode)
        finally:
            args.headless = original_headless
        open_chat(driver, args.chat_url)
        time.sleep(2.0)

    wait = getattr(args, "reauth_wait", 300.0)
    print(
        f"  브라우저 창에서 로그인을 완료해 주세요. 최대 {wait:g}초 대기합니다...",
        file=sys.stderr,
        flush=True,
    )
    end_time = time.time() + wait
    while time.time() < end_time:
        if not is_login_screen(driver):
            # Confirm the Teams app shell actually loaded (compose box present).
            try:
                find_compose(driver, timeout=5.0)
                print("  ✓ 로그인 확인됨 — 작업을 계속합니다.\n", file=sys.stderr, flush=True)
                return driver
            except Exception:
                pass
        time.sleep(2.0)
    raise RuntimeError(
        "로그인이 시간 내에 완료되지 않았습니다. `login` 명령으로 먼저 로그인한 뒤 다시 시도해 주세요."
    )


def command_login(args: argparse.Namespace) -> int:
    driver = build_driver_from_args(args)
    try:
        open_chat(driver, args.chat_url)
        print(f"Opened Teams chat. Waiting {args.login_wait:g} seconds for interactive login...")
        time.sleep(args.login_wait)
        return 0
    finally:
        if args.keep_open:
            keep_browser_open()
        else:
            driver.quit()


def command_read(args: argparse.Namespace) -> int:
    driver = build_driver_from_args(args)
    try:
        open_chat(driver, args.chat_url)
        driver = ensure_authenticated(driver, args)
        messages = wait_for_messages(
            driver=driver,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
            stable_polls=args.stable_polls,
            debug_dir=args.debug_dir,
        )
        author_needles = build_author_needles(
            author=args.author,
            author_aliases=args.author_alias,
            current_user_profile=get_current_user_profile(driver) if args.author else None,
        )
        messages = filter_messages(
            messages,
            author_needles=author_needles,
            text_regex=args.text_regex,
            limit=args.limit,
        )

        output = json.dumps(messages, ensure_ascii=False, indent=2) if args.json else None
        if args.output_file:
            output_path = Path(args.output_file).expanduser()
            output_path.parent.mkdir(parents=True, exist_ok=True)
            if output is None:
                lines: list[str] = []
                for message in messages:
                    lines.append(f"{message.get('time') or 'unknown-time'} | {message.get('author') or 'unknown'}")
                    lines.append(str(message.get("text") or "").strip())
                    lines.append("")
                output = "\n".join(lines).rstrip() + "\n"
            output_path.write_text(output + ("" if output.endswith("\n") else "\n"), encoding="utf-8")

        print_messages(messages, as_json=args.json)
        return 0
    finally:
        if args.keep_open:
            keep_browser_open()
        else:
            driver.quit()


def command_write(args: argparse.Namespace) -> int:
    message = read_message_from_args(args).strip("\n")
    if not message.strip():
        raise ValueError("Refusing to send an empty message.")

    driver = build_driver_from_args(args)
    try:
        open_chat(driver, args.chat_url)
        driver = ensure_authenticated(driver, args)
        compose = type_message(driver, message, timeout=args.timeout)

        if args.no_send:
            print("Typed message into Teams compose box; --no-send left it unsent.")
            return 0

        sent = False
        if args.send_method in {"auto", "button"}:
            sent = click_send_button(driver, timeout=min(args.timeout, 30.0))

        if not sent and args.send_method in {"auto", "key"}:
            send_with_key(driver, compose, args.send_key)
            sent = True

        if not sent:
            raise RuntimeError("Could not click the Teams Send button or send with key fallback.")

        if args.confirm_timeout > 0:
            confirmed = wait_for_text(driver, message, timeout=args.confirm_timeout)
            if confirmed:
                print("Sent Teams message and confirmed it in the visible chat.")
            else:
                print("Sent Teams message action, but the message was not confirmed before timeout.")
        else:
            print("Sent Teams message action.")
        return 0
    finally:
        if args.keep_open:
            keep_browser_open()
        else:
            driver.quit()


def command_loop(args: argparse.Namespace) -> int:
    from selenium.webdriver.common.action_chains import ActionChains
    from selenium.webdriver.common.keys import Keys

    body = read_message_from_args(args).strip("\n")
    if not body.strip() and not (args.title or "").strip():
        raise ValueError("Refusing to send an empty Loop component.")

    driver = build_driver_from_args(args, loop_mode=True)
    try:
        open_chat(driver, args.chat_url)
        driver = ensure_authenticated(driver, args, loop_mode=True)

        # On page load, Teams may auto-restore a stale Loop draft and show
        # the fluid-discard-dialog. Clear any modal up front.
        confirm_discard_draft_dialog(driver, timeout=4.0)

        compose = find_compose(driver, timeout=args.timeout)
        driver.execute_script("arguments[0].scrollIntoView({block: 'center'});", compose)
        driver.execute_script("arguments[0].focus(); arguments[0].click();", compose)
        time.sleep(0.6)

        # Clean any leftover draft (incl. an orphan Loop component) before inserting a new one.
        discard_existing_draft(driver)
        # Catch any cascaded confirmation modals (Loop draft triggers a 2nd fluid-discard-dialog).
        confirm_discard_draft_dialog(driver, timeout=5.0)
        # Re-acquire compose handle if the DOM was rebuilt by the discard.
        compose = find_compose(driver, timeout=args.timeout)
        driver.execute_script("arguments[0].focus(); arguments[0].click();", compose)
        time.sleep(0.4)

        click_loop_component_button(driver, timeout=args.timeout)
        iframe = wait_for_loop_iframe(driver, timeout=args.timeout)
        type_into_loop_component(driver, iframe, body=body, title=args.title)

        if args.no_send:
            print("Inserted Loop component with content; --no-send left it unsent.")
            return 0

        # CRITICAL: Wait for Loop's .fluid OneDrive upload AND link-share permission
        # plumbing to complete before sending. If we send too early, recipients see
        # "이 루프 구성요소를 보려면 추가 정보가 필요합니다" (broken share link).
        # The send button enables before the share link is ready, so aria-disabled is
        # not a sufficient readiness signal — we add a fixed minimum and also wait
        # for the in-compose Loop title to populate (a late-loading indicator).
        time.sleep(args.pre_send_wait)
        confirm_discard_draft_dialog(driver, timeout=1.0)

        # Wait until the Loop card in the compose shows a non-placeholder title region.
        end_ready = time.time() + 20.0
        while time.time() < end_ready:
            ready = driver.execute_script(r"""
                // Look for share-permission widget populated and Loop title element rendered.
                const composeLoop = document.querySelector('form iframe[title*="Loop"], div[role="region"] iframe[title*="Loop"]') ||
                                    document.querySelector('iframe[title*="Loop"]');
                if (!composeLoop) return false;
                // Search the iframe's parent compose card for a share-link button populated text.
                let card = composeLoop.parentElement;
                for (let i = 0; i < 6 && card; i++) card = card.parentElement || card;
                const labelTexts = (card ? card.innerText : '').toLowerCase();
                // Once the share permission UI text is present, the link is established.
                return /can edit|can view|편집|볼 수|with the link|링크/i.test(labelTexts);
            """)
            if ready:
                break
            time.sleep(0.5)

        sent = False
        if args.send_method in {"auto", "button"}:
            # JS-click the explicit send button (bypasses any overlay pointer-events).
            try:
                end_t = time.time() + min(args.timeout, 30.0)
                while time.time() < end_t:
                    try:
                        btn = driver.find_element("css selector", "[data-tid='sendMessageCommands-send']")
                        if btn.get_attribute("aria-disabled") != "true":
                            driver.execute_script("arguments[0].click();", btn)
                            sent = True
                            break
                    except Exception:
                        pass
                    time.sleep(0.4)
            except Exception:
                pass
            if not sent:
                sent = click_send_button(driver, timeout=min(args.timeout, 10.0))
        if not sent and args.send_method in {"auto", "key"}:
            ActionChains(driver).key_down(Keys.CONTROL).send_keys(Keys.ENTER).key_up(Keys.CONTROL).perform()
            sent = True
        if not sent:
            raise RuntimeError("Could not send the Loop component.")

        # CRITICAL: Loop components upload a .fluid file to OneDrive before the message is
        # finalized. Closing the browser too early cancels the upload and the message
        # silently vanishes. Wait until we can see a Loop card in the thread, OR until
        # confirm_timeout elapses — whichever first.
        confirmed = False
        if args.confirm_timeout > 0:
            end_time = time.time() + args.confirm_timeout
            while time.time() < end_time:
                try:
                    cards = driver.execute_script(r"""
                        // Count visible Loop cards in the chat region (excluding the compose iframe).
                        let n = 0;
                        document.querySelectorAll('iframe[title*="Loop"], iframe[title*="구성 요소"]').forEach(f => {
                            const r = f.getBoundingClientRect();
                            // Heuristic: thread iframes sit above the compose region (lower y).
                            if (r.height > 0 && r.top < window.innerHeight * 0.7) n++;
                        });
                        return n;
                    """) or 0
                    if cards >= 1:
                        confirmed = True
                        break
                except Exception:
                    pass
                time.sleep(0.6)
        # Always give Loop's .fluid OneDrive upload a moment to finish even after we see
        # the card render, otherwise an immediate driver.quit() can cancel mid-upload.
        time.sleep(4.0)
        if confirmed:
            print("Sent Loop component and observed a Loop card in the chat.")
        else:
            print("Sent Loop component action, but no Loop card appeared in the thread within "
                  f"{args.confirm_timeout:g}s. The message may have failed to finalize — verify with `read`.")
        return 0
    finally:
        if args.keep_open:
            keep_browser_open()
        else:
            driver.quit()


def command_files(args: argparse.Namespace) -> int:
    download_dir = Path(args.download_dir).expanduser().resolve() if args.download else None
    driver = build_driver_from_args(args, download_dir=download_dir)
    try:
        open_chat(driver, args.chat_url)
        driver = ensure_authenticated(driver, args)
        messages = wait_for_messages(
            driver=driver,
            timeout=args.timeout,
            poll_interval=args.poll_interval,
            stable_polls=args.stable_polls,
            debug_dir=args.debug_dir,
        )
        visible_files = extract_visible_files(driver)
        files = flatten_files(messages, visible_files)
        if args.limit > 0:
            files = files[-args.limit:]

        print_files(files, as_json=args.json)

        if args.open or args.download:
            assert download_dir is not None or not args.download
            target_dir = download_dir or Path(args.download_dir).expanduser().resolve()
            results = open_or_download_files(
                driver,
                files,
                download=args.download,
                download_dir=target_dir,
                timeout=args.download_timeout,
            )
            if results:
                print("\nAccess results:")
                for result in results:
                    print(f"- {result}")
        return 0
    finally:
        if args.keep_open:
            keep_browser_open()
        else:
            driver.quit()


def keep_browser_open() -> None:
    print("Leaving browser open. Press Ctrl+C to end the script.", file=sys.stderr)
    try:
        while True:
            time.sleep(3600)
    except KeyboardInterrupt:
        pass


def main() -> int:
    args = parse_args()
    if args.command == "login":
        return command_login(args)
    if args.command == "read":
        return command_read(args)
    if args.command == "write":
        return command_write(args)
    if args.command == "loop":
        return command_loop(args)
    if args.command == "files":
        return command_files(args)
    raise ValueError(f"Unknown command: {args.command}")


if __name__ == "__main__":
    raise SystemExit(main())
