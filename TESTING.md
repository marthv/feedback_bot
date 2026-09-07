# Testing the Tulle Ops bot

A full pass takes about 15 minutes. The tests are ordered so each one isolates a
single seam — if something fails, the test number tells you where to look.

Vendors used throughout:

| id | what it is | state | why it's used |
|---|---|---|---|
| `V4341` | Laraudio | **hidden** (`Validated_Data = "0"`) | safe for hide/show — already hidden, so a `hide` is a no-op |
| `V1` | 1 Hotel Brooklyn Bridge | **visible**, 516 clicks | a real, popular venue. Safe for `show`, **not** for `hide` |

⚠️ **Never `hide` a vendor you don't mean to hide.** It drops out of production
search once ep119's cache turns over. `show` on an already-visible vendor is the
harmless direction and proves just as much.

---

## 0. Prerequisites

Railway → project *tulle slackbot* → service *tulle-slackbot* → **Variables**.
Copy `XANO_API_KEY`, then in a shell:

```bash
export S="<XANO_API_KEY>"
export U="https://xqtb-2ma7-ijfy.n7e.xano.io/api:aow91bcd"
export APP="https://tulle-slackbot-production.up.railway.app"
```

These live only in that shell, so nothing lands in a file.

---

## 1. Service is up

```bash
curl -s "$APP/health"
```

Expect `{"ok":true}`.

⚠️ **This check can lie.** The process binds its port and serves `/health` for
~0.3s before Bolt's `auth.test` can kill it, so a crashlooping service still
answers `ok`. Trust it only alongside a SUCCESS deployment status. If in doubt,
read the deployment status or the startup banner instead — the banner echoes the
resolved config and is the honest signal.

---

## 2. Xano auth and validation — no writes

```bash
# 2a — bad secret → expect 403
curl -s -X POST "$U/vendor/visibility" -H "Content-Type: application/json" \
  -d '{"vendor_id":"V4341","action":"hide","secret":"wrong"}'

# 2b — unknown vendor → expect 400 "Vendor not found"
curl -s -X POST "$U/vendor/visibility" -H "Content-Type: application/json" \
  -d "{\"vendor_id\":\"V999999\",\"action\":\"hide\",\"secret\":\"$S\"}"

# 2c — bad action → expect 400 "action must be 'hide' or 'unhide'"
curl -s -X POST "$U/vendor/visibility" -H "Content-Type: application/json" \
  -d "{\"vendor_id\":\"V4341\",\"action\":\"delete\",\"secret\":\"$S\"}"

# 2d — the review queue, read-only → expect JSON (possibly an empty list)
curl -s -G "$U/vendor/edit/pending" --data-urlencode "secret=$S"
```

**If 2a returns anything but 403, stop.** The endpoint isn't gated and anyone who
learns the URL can flip vendor visibility.

---

## 3. A real write, and putting it back

`V4341` is hidden, so this flips it out and back. Net effect on data: zero.

```bash
# → expect "changed": true, previous 0, new 1
curl -s -X POST "$U/vendor/visibility" -H "Content-Type: application/json" \
  -d "{\"vendor_id\":\"V4341\",\"action\":\"unhide\",\"secret\":\"$S\",\"source\":\"test\"}"

# → expect "changed": true, back to 0
curl -s -X POST "$U/vendor/visibility" -H "Content-Type: application/json" \
  -d "{\"vendor_id\":\"V4341\",\"action\":\"hide\",\"secret\":\"$S\",\"source\":\"test\"}"

# → run hide again: expect "changed": false
curl -s -X POST "$U/vendor/visibility" -H "Content-Type: application/json" \
  -d "{\"vendor_id\":\"V4341\",\"action\":\"hide\",\"secret\":\"$S\",\"source\":\"test\"}"
```

The third call matters most: `changed: false` is what makes Slack's retries
harmless, since the in-memory event deduper resets on every redeploy.

---

## 4. Tulle Bot's incoming webhooks

**This is a different Slack app.** See [the two-app note](#two-slack-apps) below.

Tulle Bot → Incoming Webhooks → copy a URL:

```bash
curl -s -X POST -H 'Content-type: application/json' \
  --data '{"text":"webhook smoke test — ignore"}' \
  "https://hooks.slack.com/services/T…/B…/…"
```

Expect the literal body `ok` and the message in its channel. `invalid_token` or
`no_service` means the grant is gone — **stop and do not reinstall anything.**

---

## 5. Slack end-to-end

Invite first: `/invite @Tulle Ops`

| # | Do this | Expect | Proves |
|---|---|---|---|
| 1 | `/tulle` | Help listing all 7 commands | Commands reach Railway; signing secret correct |
| 2 | `/tulle-status` | Settings + "Xano reachable" | Outbound Xano path from the bot |
| 3 | `/tulle-show V1` | "already visible — nothing to change" | Short vendor IDs parse (the `V1` regression) |
| 4 | `/tulle-hide V4341` | `changed: false` + the ~2h cache note | Command → Xano write path |
| 5 | Post `V4341`, react 🫣 | Thread reply + ✅ added | **Events** path — separate from commands |
| 6 | Remove the 🫣 | Reply saying it's visible again | Undo path (`ENABLE_UNDO=true`) |
| 7 | Post `V4341 and V52`, react 🫣 | Refusal asking for one ID | Ambiguity refused, never guessed |
| 8 | `/tulle-edit V4341 Website = https://x.com/a?b=1&c=2` | Diff with Approve/Discard | Parser keeps `=` inside values |
| 9 | Click **Discard** | Confirms discarded | **Interactivity** path — the third request type |
| 10 | `/tulle-pending` | Empty, after the discard | Queue read |
| 11 | `/tulle-applied` | Applied edits + who approved | Audit trail |

**Tests 1, 5 and 9 are the ones that matter most.** They are three different
Slack request types — slash command, event, interactivity — all hitting the same
`/slack/events` URL, and each can fail independently of the others.

To exercise a live approval, redo 8 and click **Approve**, then stage the
original value back. `previous_value` is retained in table 74, so the rollback
source is recorded either way.

---

## Expected behaviour that looks like a bug

- **A hidden vendor keeps appearing in search for ~2 hours.** ep119 caches for
  7100s. The bot says so in its reply (`index.js:546`). The database is correct
  immediately; only search is stale.
- **Reacting to a threaded message is slow.** The `reaction_added` event carries
  no parent `ts`, so the bot scans up to 8 recent threads. Top-level messages are
  faster.
- **A vendor ID inside prose needs 3+ digits.** `/tulle-hide V1` works, but "check
  V1 tomorrow" is deliberately ignored by the reaction path — a looser match would
  let "v2 of the deck" resolve to a real vendor and a stray 🫣 would hide it. See
  `MIN_DIGITS_PROSE` / `MIN_DIGITS_TYPED` in `lib/parse.js`.

---

## Two Slack apps

There are two, and they are easy to confuse because every version of this repo's
`manifest.yml` names itself **Tulle Ops**.

| app | job | manifest |
|---|---|---|
| **Tulle Ops** | this bot — 7 slash commands, reactions, Approve/Discard | `manifest.yml` in this repo |
| **Tulle Bot** | **incoming webhooks only** — Xano posts event notifications | hand-configured, not in any repo |

⚠️ **Never paste this repo's `manifest.yml` into Tulle Bot.** It declares no
`incoming-webhook` scope, so applying it and then reinstalling would revoke the
webhook grant and silently kill every Xano → Slack notification.

A manifest save changes only *declared* scopes; the installed grant survives
until a **reinstall**. So Slack's yellow "you've changed the permission scopes,
please reinstall" banner means the damage is staged, not done — fix the scope
list before reinstalling and nothing breaks.

To tell which app a service is bound to, compare its `SLACK_SIGNING_SECRET`
against each app's Basic Information → Signing Secret. They're unique per app.

To read an app's real *granted* scopes without guessing:

```bash
curl -sD - -o /dev/null \
  -H "Authorization: Bearer <xoxb- token>" \
  https://slack.com/api/auth.test | grep -i '^x-oauth-scopes'
```

---

## Parser unit tests

No test runner is wired up. The parser is pure and importable, so:

```bash
node --input-type=module -e '
import { extractVendorIds, parseEditCommand, MIN_DIGITS_TYPED } from "./lib/parse.js";
const typed = (t) => extractVendorIds(t, { minDigits: MIN_DIGITS_TYPED }).primary;
const prose = (t) => extractVendorIds(t).primary;
console.log(typed("V1"), typed("V52"), typed("V4341"));   // V1 V52 V4341
console.log(prose("v2 of the deck"), prose("V4341 x"));   // null V4341
console.log(parseEditCommand("edit V1 Website = https://x.com/a?b=1"));
'
```
