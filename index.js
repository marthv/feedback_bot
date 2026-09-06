import bolt from "@slack/bolt";
import { extractVendorIds, createEventDeduper } from "./lib/parse.js";
import { setVendorVisibility } from "./lib/xano.js";

const { App, ExpressReceiver } = bolt;

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TRIGGER_EMOJI = (process.env.TRIGGER_EMOJI || "face_with_peeking_eye")
  .split(",")
  .map((s) => s.trim().replace(/:/g, ""))
  .filter(Boolean);

const ALLOWED_CHANNELS = (process.env.ALLOWED_CHANNEL_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ALLOWED_USERS = (process.env.ALLOWED_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ENABLE_UNDO = process.env.ENABLE_UNDO !== "false";

for (const key of ["SLACK_BOT_TOKEN", "SLACK_SIGNING_SECRET", "XANO_VISIBILITY_URL"]) {
  if (!process.env[key]) {
    console.error(`Missing required env var: ${key}`);
    process.exit(1);
  }
}

const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
  endpoints: "/slack/events",
  processBeforeResponse: false,
});

// Railway health check target.
receiver.router.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, uptime: process.uptime() });
});

const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver,
});

const isDuplicate = createEventDeduper();

// ---------------------------------------------------------------------------
// Message lookup
// ---------------------------------------------------------------------------

// A reaction event gives us a channel + ts, not the message text. Top-level
// messages come back from conversations.history. Thread replies do not — they
// need conversations.replies with the *parent* ts, which the event does not
// carry. So on a miss we scan recent thread parents for the reply.
async function fetchMessageText(client, channel, ts) {
  try {
    const direct = await client.conversations.history({
      channel,
      latest: ts,
      oldest: ts,
      inclusive: true,
      limit: 1,
    });
    const hit = direct.messages?.find((m) => m.ts === ts);
    if (hit) return hit.text || "";
  } catch (err) {
    console.error("conversations.history failed:", err.data?.error || err.message);
  }

  try {
    const recent = await client.conversations.history({ channel, limit: 50 });
    const parents = (recent.messages || [])
      .filter((m) => m.reply_count > 0)
      .slice(0, 8);

    for (const parent of parents) {
      const thread = await client.conversations.replies({
        channel,
        ts: parent.ts,
        limit: 200,
      });
      const hit = thread.messages?.find((m) => m.ts === ts);
      if (hit) return hit.text || "";
    }
  } catch (err) {
    console.error("thread scan failed:", err.data?.error || err.message);
  }

  return null;
}

async function reply(client, channel, thread_ts, text) {
  try {
    await client.chat.postMessage({ channel, thread_ts, text, unfurl_links: false });
  } catch (err) {
    console.error("postMessage failed:", err.data?.error || err.message);
  }
}

async function markDone(client, channel, ts, emoji) {
  try {
    await client.reactions.add({ channel, timestamp: ts, name: emoji });
  } catch (err) {
    // already_reacted is expected and harmless
    if (err.data?.error !== "already_reacted") {
      console.error("reactions.add failed:", err.data?.error || err.message);
    }
  }
}

// ---------------------------------------------------------------------------
// Core handler
// ---------------------------------------------------------------------------

async function handleReaction({ event, client, action, body }) {
  if (!TRIGGER_EMOJI.includes(event.reaction)) return;
  if (event.item?.type !== "message") return;
  if (isDuplicate(body?.event_id)) return;

  const { channel, ts } = event.item;
  const actor = event.user;

  if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(channel)) return;

  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(actor)) {
    await reply(
      client,
      channel,
      ts,
      `<@${actor}> — you're not on the approved list for visibility changes, so I left this one alone.`
    );
    return;
  }

  const text = await fetchMessageText(client, channel, ts);
  if (text === null) {
    await reply(
      client,
      channel,
      ts,
      "I couldn't read that message. If it's a thread reply, try reacting to the top-level message instead."
    );
    return;
  }

  const { ids, primary, ambiguous } = extractVendorIds(text);

  if (ambiguous) {
    await reply(
      client,
      channel,
      ts,
      `Found ${ids.length} vendor IDs in that message (${ids.join(", ")}) and I won't guess which one you meant. Post the single ID and react to that.`
    );
    return;
  }

  if (!primary) {
    await reply(
      client,
      channel,
      ts,
      "No vendor ID in that message — I look for something like `V2574` or a `tulletogether.app` vendor link."
    );
    return;
  }

  const result = await setVendorVisibility({ vendorId: primary, action, actor });

  if (!result.ok) {
    await reply(
      client,
      channel,
      ts,
      `Couldn't update *${primary}* — ${result.error}\nCheck it directly: ${xanoTableLink()}`
    );
    return;
  }

  const label = result.vendor_name ? `*${result.vendor_name}* (${primary})` : `*${primary}*`;

  if (result.changed === false) {
    const state = action === "hide" ? "already hidden" : "already visible";
    await reply(client, channel, ts, `${label} was ${state} — nothing to change.`);
    await markDone(client, channel, ts, action === "hide" ? "white_check_mark" : "arrows_counterclockwise");
    return;
  }

  const verb = action === "hide" ? "Hidden" : "Restored";
  const arrow = `${result.previous_visibility} → ${result.new_visibility}`;
  await reply(
    client,
    channel,
    ts,
    `${verb} ${label} — visibility ${arrow}. Changed by <@${actor}>.`
  );
  await markDone(client, channel, ts, action === "hide" ? "white_check_mark" : "arrows_counterclockwise");
}

function xanoTableLink() {
  return (
    process.env.XANO_TABLE_URL ||
    "https://xqtb-2ma7-ijfy.n7e.xano.io/workspace/database"
  );
}

app.event("reaction_added", async ({ event, client, body }) => {
  await handleReaction({ event, client, body, action: "hide" });
});

if (ENABLE_UNDO) {
  app.event("reaction_removed", async ({ event, client, body }) => {
    await handleReaction({ event, client, body, action: "unhide" });
  });
}

app.error(async (error) => {
  console.error("Unhandled Bolt error:", error);
});

// ---------------------------------------------------------------------------

const port = process.env.PORT || 3000;
await app.start(port);
console.log(`tulle-slackbot listening on :${port}`);
console.log(`  trigger emoji : ${TRIGGER_EMOJI.map((e) => `:${e}:`).join(", ")}`);
console.log(`  undo enabled  : ${ENABLE_UNDO}`);
console.log(`  channel lock  : ${ALLOWED_CHANNELS.length ? ALLOWED_CHANNELS.join(", ") : "none (all channels)"}`);
console.log(`  user lock     : ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "none (anyone in channel)"}`);
