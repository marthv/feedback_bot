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
rename `visibility` later, nothing here changes.

---

## Step 1 — Build the Xano endpoint

New API endpoint, method `POST`, path `/vendor/visibility`.

**Inputs**

| name | type | notes |
|---|---|---|
| `vendor_id` | text | e.g. `V2574` |
| `action` | text | `hide` or `unhide` |
| `actor_slack_id` | text | audit only |
| `source` | text | audit only |

**Function stack**

1. **Precondition** — `$http_header.x-api-key == $env.slackbot_key`, else `401 Unauthorized`.
   Add `slackbot_key` to your Xano environment variables with a long random string.
2. **Get Record** from `WPTP Updated Mappings` (table 11) where `Vendor_ID = input.vendor_id` → var `vendor`.
3. **Precondition** — `vendor != null`, else error `Vendor not found`.
4. **Create Variable** `previous` = `vendor.visibility`.
5. **Create Variable** `target` = `input.action == "hide" ? 0 : 1`.
6. **Conditional** — if `previous == target`, return early:
   ```json
   { "vendor_id": "...", "vendor_name": "...", "previous_visibility": 0,
     "new_visibility": 0, "changed": false }
   ```
7. **Edit Record** on `WPTP Updated Mappings`, id `vendor.id`, set `visibility = target`.
8. **Response**
   ```json
   { "vendor_id": "...", "vendor_name": "...", "previous_visibility": 1,
     "new_visibility": 0, "changed": true }
   ```

⚠️ Confirm your exact column names before wiring this up — the spec above assumes
`Vendor_ID` and `visibility`. Also map `vendor_name` to whatever your name column
actually is (`Name`); it's optional but makes the confirmation message far more
readable than a bare ID.

Test it with curl before touching Slack:

```bash
curl -X POST "$XANO_VISIBILITY_URL" \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: $XANO_API_KEY" \
  -d '{"vendor_id":"V2574","action":"hide","actor_slack_id":"U000","source":"curl"}'
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

## Environment variables

See `.env.example`. Required: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`,
`XANO_VISIBILITY_URL`. Everything else has a working default.
