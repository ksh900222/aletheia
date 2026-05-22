# Teams helpers

Three scripts live here. Use them in this order of preference:

1. `teams_chat_rw.py` — read and write any Teams chat by URL through a Selenium-driven Chrome/Edge profile. Works without Graph API, Workflows, or webhooks.
2. `post_ics_to_teams.py` — post the ICS script output to a Teams Workflows webhook (one-way).
3. `open_ics_in_teams_chat.py` — open Teams with a deep-link-prefilled compose box (you press Send).

For Korean-language deep-dive on `teams_chat_rw.py` internals see `Teams_chat_read_write_manual_cyh.md` in this folder.

## Quickstart — read/write any chat by URL (`teams_chat_rw.py`)

### 1. Prerequisites
- Chrome or Edge installed (Selenium picks one automatically).
- Python venv with `selenium>=4.x`. The repo root `.venv` already has it:
  ```bash
  ls .venv/bin/python  # use this interpreter
  ```
- The target chat's URL. Open the chat in Teams Web, click `...` → `Copy link to chat`. It looks like `https://teams.microsoft.com/l/chat/19:<thread-id>@thread.v2/...`.

### 2. Put the chat URL in `.env` (or pass `--chat-url` per call)
```bash
# .env (gitignored)
TEAMS_CHAT_URL='https://teams.microsoft.com/l/chat/19:<thread-id>@thread.v2/conversations?context=...'
```

### 3. Fresh login (do this before every session — see "Stale profile" below)
```bash
rm -rf ~/.cache/teams-chat-rw/chrome-profile
.venv/bin/python tools/teams/teams_chat_rw.py login --login-wait 180 --timeout 30
# Chrome opens. Sign in with SSO + MFA. Wait window auto-closes after 180s.
```

### 4. Read the latest messages
```bash
# Use the URL from .env
.venv/bin/python tools/teams/teams_chat_rw.py read --limit 5 --json

# Or target a different chat without touching .env
.venv/bin/python tools/teams/teams_chat_rw.py read \
  --chat-url 'https://teams.microsoft.com/l/chat/19:<other-thread>@thread.v2/...' \
  --limit 5 --json
```

### 5. Write a message
```bash
.venv/bin/python tools/teams/teams_chat_rw.py write \
  --message 'Hello from teams_chat_rw'

# From a file, and against an explicit chat
.venv/bin/python tools/teams/teams_chat_rw.py write \
  --chat-url 'https://teams.microsoft.com/l/chat/19:<thread>@thread.v2/...' \
  --message-file ./payload.txt
```

`--no-send` types the message and stops so you can review and press Send by hand.

### Stale profile (read returns yesterday's "latest")
Symptom: `read` succeeds but the newest message you get is from hours or days ago, with no `Apply and restart` / `Accept and login` banner visible. The cached profile's auth token has gone stale; `driver.refresh()` does not fix it.

Cure: redo step 3 (delete the profile dir, run `login`, redo MFA). Treat fresh login as the default — running `read`/`write` against an old profile silently lies.

## Existing Workflows/deep-link helpers

### Recommended Teams setup

Use Teams Workflows instead of Microsoft Graph when you do not have Graph app
permissions.

1. In Teams, open the chat where you want the message to arrive.
2. Select `...` next to the chat, then `Workflows`.
3. Choose a webhook template such as `Send webhook alerts to a chat`.
4. Authenticate with your account.
5. Select the target chat, add the workflow, and copy the webhook URL.
6. Keep the webhook URL out of git. Put it in your shell environment:

```bash
export TEAMS_WEBHOOK_URL='<teams-workflow-webhook-url>'
```

## Smoke test

```bash
python3 tools/teams/post_ics_to_teams.py \
  --message 'Teams webhook smoke test from aletheia'
```

## Send the ICS script output

By default, credential-like values are redacted. This is safer for testing:

```bash
python3 tools/teams/post_ics_to_teams.py
```

To send the actual `icsPwd` cookie value, make the sensitive behavior explicit:

```bash
python3 tools/teams/post_ics_to_teams.py --allow-sensitive
```

## Dry run

Print the JSON payload without posting it:

```bash
python3 tools/teams/post_ics_to_teams.py \
  --message 'Teams webhook smoke test from aletheia' \
  --dry-run
```

## No Workflows fallback

Set your Teams login email. For self-chat, use your own account.

```bash
export TEAMS_SELF_UPN='you@company.com'
export TEAMS_CHAT_DEEP_LINK_BASE='https://teams.microsoft.com/l/chat/0/0?'
```

Open Teams with a smoke-test message pre-filled:

```bash
python3 tools/teams/open_ics_in_teams_chat.py \
  --message 'Teams deep-link smoke test from aletheia'
```

Open Teams with the ICS script result pre-filled. By default, cookie/password-like
values are redacted:

```bash
python3 tools/teams/open_ics_in_teams_chat.py
```

Open Teams with the raw `icsPwd` output pre-filled:

```bash
python3 tools/teams/open_ics_in_teams_chat.py --allow-sensitive
```

Be careful with `--allow-sensitive`: Teams deep links put the message in the URL,
which can leave the sensitive value in browser history.

## Auto-send through the Teams UI

After confirming that the deep link opens the right chat and pre-fills the
message, add `--send`. This uses `xdotool` to activate the Teams browser window
and press the send key. If `xdotool` is not installed, the script bootstraps it
under `/tmp/aletheia-xdotool`.

```bash
python3 tools/teams/open_ics_in_teams_chat.py \
  --message 'Teams auto-send smoke test from aletheia' \
  --send
```

Then send the raw ICS result:

```bash
python3 tools/teams/open_ics_in_teams_chat.py --allow-sensitive --send
```
