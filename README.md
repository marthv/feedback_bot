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

## Step 3 — Railway (DEPLOYED ✅)

Project **tulle slackbot**, service **tulle-slackbot**, deploying `marthv/feedback_bot` @ `main`.

```
https://tulle-slackbot-production.up.railway.app
```

| id | value |
|---|---|
| project | `3144ae44-8da7-4667-8f54-421aed1592d5` |
| service | `bab9bb11-2bd1-4ac8-9797-6c6992173756` |
| environment (production) | `53156b69-045b-4478-9553-a1f4932e0e81` |

Variables are set, **except the two Slack secrets**, which are placeholders
(`SLACK_BOT_TOKEN=xoxb-REPLACE_ME`, `SLACK_SIGNING_SECRET=REPLACE_ME`).

⚠️ **Until you replace them the service crashloops, and that is expected.** Bolt calls
`auth.test` during `app.start()`, so a placeholder token is fatal:
`Error: An API error occurred: invalid_auth`. The process does bind its port and serve
`/health` for ~0.3s before dying, so a one-shot health check can return `{"ok":true}`
and still be a dead service — check `list-deployments` status or the logs, not `/health`.
`restartPolicyMaxRetries` is 10, so it stops retrying and sits CRASHED.

Replace both variables after Step 2; saving them triggers a redeploy and it comes up
clean. The startup banner is the thing to read — it echoes the resolved config.

Then set the Slack app's **Event Subscriptions** Request URL to:

```
https://tulle-slackbot-production.up.railway.app/slack/events
```

and wait for *Verified*. Verification signs the request with the signing secret, so it
fails until the real `SLACK_SIGNING_SECRET` is in place.

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

---

## Phase 2 — Staged vendor edits (Xano side BUILT ✅, Slack side NOT started)

Arbitrary field edits do **not** go through reactions. A reaction carries no parameters and
writes immediately, which is fine for a reversible boolean and wrong for data. Instead:
propose → review a diff → explicitly approve. Same shape as the feedback-triage tab and the
vendor portal, both of which stage rather than apply.

Nothing in this flow writes live data except `vendor/edit/apply`.

| endpoint | id | what it does |
|---|---|---|
| `POST /vendor/edit/stage` | 280 | Validates the field, reads the live value, records a **proposal**. No live write. |
| `POST /vendor/edit/apply` | 281 | The only live write. Re-validates, drift-checks, applies. |
| `POST /vendor/edit/discard` | 282 | Rejects a proposal; the row is kept, not deleted. |
| `GET /vendor/edit/pending` | 283 | The review queue. Read-only. |

All four sit in API group 3 (`api:aow91bcd`) behind the same `secret` body field as ep279.
Staged rows live in table **74 `pending_edit`**; the whitelist lives in **fn62
`vendor_edit_field_spec`**.

### Editable fields

`Name`, `Website`, `Description`, `Contact_Information`, `Max_Capacity_Seated`,
`Venue_Type`, `Type_of_Photography`, `Type_of_Entertainment`, `Type_of_Beauty`.

Matching is case-insensitive and resolves to the canonical column, so `website` → `Website`.
Widen the list by editing fn62 — **and add a matching branch in ep281**, which spells out
every writable column because XanoScript's `db.edit` will not take a variable `data` block.
Forgetting the branch throws a loud `configerror` rather than silently doing nothing.

Deliberately **not** editable, with reasons in fn62's description: `Validated_Data` (owned by
ep279), `Category` (gates the PI panel and filters), `State`/`Country` (denormalised into
`flt_states`), `Address`/`lat`/`lng` (geocoding drift), all `flt_*`/`mk_*` (derived), anything
in tables 36/62/63 (pricing — percentiles derive from it), and the entitlement fields.

### Guarantees, all verified by smoke test

- Forbidden field → 400 listing what *is* editable
- Unknown vendor → 400
- Staging a value equal to the current one → 400, keeps the queue clean
- Re-staging the same vendor+field marks the earlier proposal `superseded`
- Applying a superseded, discarded or already-applied row → 400
- **Drift guard:** if the live value changed between propose and approve, apply refuses.
  The approver never applies a diff different from the one they saw.
- `previous_value` is retained after apply — that is the rollback source

### Slack side (BUILT ✅)

```
/tulle edit V4341 Description = New blurb here
/tulle edit V4341 Max_Capacity_Seated = 250
/tulle pending          proposals awaiting approval
/tulle applied          what has been applied
/tulle help
```

The command **stages only**. It posts the diff into the channel with **Approve** and
**Discard** buttons; only Approve reaches `vendor/edit/apply`. Everything after the first
`=` is the value, so values may contain `=` (URLs work). The field name is not validated
locally — Xano rejects unknown fields with a message naming the legal ones, which is a
better error than this repo could produce.

No second request URL is needed. Bolt's `ExpressReceiver` serves events, slash commands
and interactivity on the **same** `/slack/events` path, which is why `manifest.yml` lists
that one URL three times.

`REQUIRE_SECOND_APPROVER=true` stops the proposer approving their own edit. Off by default.
Discarding your own proposal is always allowed — withdrawing a suggestion is not what the
rule exists to prevent. Either way Xano records `proposed_by` and `applied_by` separately,
so a self-approval is visible in the audit trail even with the check off.

### Re-installing after this change

The app gained the `commands` scope and a slash command, so Slack needs the manifest
re-applied and the app reinstalled:

1. api.slack.com/apps → Tulle Ops → **App Manifest** → paste the updated `manifest.yml` → Save
2. **Install App** → Reinstall to Workspace (the new scope forces this)
3. Confirm **Interactivity & Shortcuts** is On with the same `/slack/events` URL

`SLACK_BOT_TOKEN` changes on reinstall — copy the new `xoxb-…` into Railway.
