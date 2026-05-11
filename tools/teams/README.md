# Teams posting helpers

`post_ics_to_teams.py` runs the script configured by `ICS_POST_SCRIPT` or `--script`,
captures stdout/stderr, and posts
the result to a Microsoft Teams Workflows webhook.

`open_ics_in_teams_chat.py` is the no-Graph, no-Workflows fallback. It uses a
Teams chat deep link to pre-fill a chat compose box. You still review and press
Send in Teams.

## Recommended Teams setup

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
