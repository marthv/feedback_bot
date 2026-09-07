# Tulle Ops Slackbot

React 🫣 to a message containing a vendor ID → that vendor's `visibility` flips to `0` in Xano → the bot confirms in thread.

Remove the reaction → visibility goes back to `1`.

---

## Architecture

```
Slack reaction_added
        │
        ▼
Railway (this service)
  1. verify Slack signature
  2. dedupe by event_id
  3. read the reacted message text
  4. regex out the vendor ID
        │  POST { vendor_id, action, actor_slack_id }
        ▼
Xano  POST /vendor/visibility
  1. auth via X-Api-Key
  2. find row by Vendor_ID
  3. flip visibility, return before/after
        │
        ▼
Bot replies in thread + adds ✅
```

The Node service holds **no table config**. Column names live in Xano only. If you
rename `Validated_Data` later, nothing here changes.

---

## Step 1 — The Xano endpoint (BUILT ✅)

Live as **ep279**, `POST /vendor/visibility` in API group **3 (`slack`, `api:aow91bcd`)**.

```
https://xqtb-2ma7-ijfy.n7e.xano.io/api:aow91bcd/vendor/visibility
```

Built and smoke-tested 2026-09-06. Nothing to do here unless you want to change behaviour.

**Inputs** (JSON body)

| name | type | notes |
|---|---|---|
| `vendor_id` | text | required, e.g. `V2574` |
| `action` | text | required, `hide` or `unhide` |
| `secret` | text | required in practice — must equal the literal in ep279's precondition |
| `actor_slack_id` | text | audit only; lands in Xano request history |
| `source` | text | audit only |

**Response**

```json
{ "vendor_id": "V4341", "vendor_name": "Laraudio",
  "previous_visibility": 1, "new_visibility": 0, "changed": true }
```

`changed: false` means the reaction was redundant and no write happened.

### Verified schema (checked against the live workspace, 2026-09-06)

| thing | value |
|---|---|
| table | `WPTP Updated Mappings` — table **11**, workspace 1. Display name has spaces; the XanoScript alias is `$db.WPTP_Updated_Mappings` |
| vendor ID column | `Vendor_ID`, type **text** (e.g. `V2574`). Same spelling in table 10 (`WPTP PDFs`). Note table 36 uses `VENDOR_ID` — different table, don't mix them up |
| visibility column | `Validated_Data`, type **text**, values `"1"` (visible) / `"0"` (hidden) |
| name column | `Name`, type text |

There is **no column called `visibility`** on table 11. `Validated_Data` is the real
gate: production search (`ep119`) filters `Validated_Data == 1`, as do the
`tool_wedding_search_*` MCP tools. There is a composite index on
`(Category, Validated_Data, id)`, so the flip is cheap.

⚠️ **It is a text column.** ep279 writes the strings `"1"` / `"0"` and casts to int only
in the JSON response, so the Slack message reads `1 → 0` rather than `"1" → "0"`.

⚠️ **ep119 caches for 7100s (~2 hours).** A hidden vendor keeps appearing in search
until that entry expires. The Slack confirmation is telling the truth about the
database and lying about what a couple sees. Either say so in the message copy, or
have ep279 bump ep119's `cache_v` default after a successful write. **Not done yet.**

**Auth.** ep279 is gated by a `secret` body field compared against a literal, matching
`analytics_users_export` (ep205). The bot sends the same value as both the `X-Api-Key`
header and the `secret` body field; only the body field is checked. XanoScript has no
documented way to read request headers, which is why the header is not the gate.

### Smoke test

All seven of these passed on 2026-09-06 against `V4341` (a vendor already hidden, left
exactly as found):

```bash
U="https://xqtb-2ma7-ijfy.n7e.xano.io/api:aow91bcd/vendor/visibility"
S="$XANO_API_KEY"

# 403 — bad secret
curl -s -X POST "$U" -H "Content-Type: application/json"   -d '{"vendor_id":"V4341","action":"hide","secret":"wrong"}'

# 400 — Vendor not found
curl -s -X POST "$U" -H "Content-Type: application/json"   -d "{\"vendor_id\":\"V999999\",\"action\":\"hide\",\"secret\":\"$S\"}"

# 400 — action must be 'hide' or 'unhide'
curl -s -X POST "$U" -H "Content-Type: application/json"   -d "{\"vendor_id\":\"V4341\",\"action\":\"delete\",\"secret\":\"$S\"}"

# 200 — real flip. Run twice; the 2nd returns "changed": false
curl -s -X POST "$U" -H "Content-Type: application/json"   -d "{\"vendor_id\":\"V4341\",\"action\":\"hide\",\"secret\":\"$S\",\"actor_slack_id\":\"U000\",\"source\":\"curl\"}"
```

## Step 2 — Create the Slack app

1. api.slack.com/apps → **Create New App** → **From an app manifest**
2. Paste `manifest.yml`
3. **Install to Workspace**, copy the Bot User OAuth Token (`xoxb-…`)
4. Basic Information → copy the **Signing Secret**
5. Invite the bot to the channel: `/invite @Tulle Ops`

## Step 3 — Deploy to Railway

1. Push this repo to GitHub
2. Railway → **New Project** → **Deploy from GitHub repo**
3. Variables → paste everything from `.env.example` with real values
4. Settings → Networking → **Generate Domain**
5. Back in the Slack app → **Event Subscriptions** → set Request URL to
   `https://your-domain.up.railway.app/slack/events` → wait for *Verified*

Health check: `GET /health` returns `{"ok":true}`.

---

## Behaviour notes

- **Ambiguity is refused, not guessed.** Two vendor IDs in one message → the bot
  declines and asks for a single-ID message. Silently picking one would corrupt data.
- **Thread replies work**, but cost extra API calls — the reaction event gives no
  parent `ts`, so the bot scans up to 8 recent threads. Reacting to top-level
  messages is faster.
- **Duplicate protection** via in-memory `event_id` set. This resets on redeploy;
  a Slack retry spanning a restart could double-fire. Harmless in practice because
  the Xano endpoint is idempotent (`changed: false` on a no-op).
- **`ALLOWED_USER_IDS` is empty by default**, meaning anyone in the channel can
  hide a vendor. Set it once you know who should have that power.

## Q&A on mention (optional)

Set `ENABLE_ASK=true` and the bot answers `@Tulle Ops <question>` from Xano
data. Off by default.

It calls the Claude API with the Xano MCP server attached, using an
**allowlist**: `default_config.enabled: false` plus the read tools named in
`lib/ask.js`. Any tool not on that list is disabled, including write tools added
to Xano later. Change the list in `READ_TOOLS`.

**Grounding, not confidence.** The bot answers from tool results or not at all.
`lib/ask.js` checks the response for a non-error `mcp_tool_result` carrying
actual content; without one it refuses and links to Xano. There is no confidence
threshold, because model self-reported confidence is not calibrated — asking for
"90% sure" produces confident wrong answers.

Answers always land in a thread, never top-level, and are footed with the tools
that produced them so anyone can verify.

**Extra Slack scopes:** `app_mentions:read`. Extra bot event: `app_mention`.
Both are in `manifest.yml`.

**Before enabling, turn on authentication for the Xano MCP server.** Every tool
currently shows Authentication: Disabled, which means anyone holding the
connection URL can read the whole pricing dataset. Set `XANO_MCP_TOKEN` once
auth is on.

**Not free.** Each mention is an API call with tool round-trips. Use
`ALLOWED_CHANNEL_IDS` to keep it to one channel.

## Environment variables

See `.env.example`. Required: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
`XANO_VISIBILITY_URL`. Everything else has a working default.
