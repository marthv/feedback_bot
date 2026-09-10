import bolt from "@slack/bolt";
import { extractVendorIds, createEventDeduper, parseEditCommand, MIN_DIGITS_TYPED } from "./lib/parse.js";
import { setVendorVisibility } from "./lib/xano.js";
import { askXano } from "./lib/ask.js";
import { stageEdit, applyEdit, discardEdit, listEdits } from "./lib/edits.js";
import { startViewAs } from "./lib/impersonate.js";

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

// Admin "view as user" is gated separately from everything else in this file,
// and its empty case is INVERTED on purpose.
//
// ALLOWED_CHANNELS and ALLOWED_USERS above mean "empty = allow everyone". That is
// defensible for vendor edits: they are staged, reversible, and visible in channel.
// A view-as session is none of those things — it hands someone a live session as a
// real paying customer. So here empty means DENY, and the command simply does not
// exist until somebody is named.
//
// Do NOT "fix" this to match the two lists above. That would turn an off switch
// into an open door.
const IMPERSONATE_USERS = (process.env.IMPERSONATE_USER_IDS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const ENABLE_UNDO = process.env.ENABLE_UNDO !== "false";

// Q&A is opt-in. It needs ANTHROPIC_API_KEY and XANO_MCP_URL to do anything.
const ENABLE_ASK = process.env.ENABLE_ASK === "true";

// Two-person rule. Off by default: on a small team it would block routine work.
// When on, whoever proposed an edit cannot be the one who approves it.
const REQUIRE_SECOND_APPROVER = process.env.REQUIRE_SECOND_APPROVER === "true";

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

// ---------------------------------------------------------------------------
// Q&A on mention (read-only)
// ---------------------------------------------------------------------------

function stripMention(text) {
  return String(text || "")
    .replace(/<@[A-Z0-9]+>/g, "")
    .trim();
}

if (ENABLE_ASK) {
  app.event("app_mention", async ({ event, client, body }) => {
    if (isDuplicate(body?.event_id)) return;

    const channel = event.channel;
    // Answer inside the thread if mentioned in one, otherwise start a thread
    // on the mention. Never reply top-level — a wrong answer shouldn't broadcast.
    const thread_ts = event.thread_ts || event.ts;

    if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(channel)) return;

    const question = stripMention(event.text);

    if (!question) {
      await reply(
        client,
        channel,
        thread_ts,
        "Ask me something about vendor or pricing data — e.g. `@Tulle Ops what pricing do we have for V2574?`\nI read from Xano only, and I'll tell you when I can't find something."
      );
      return;
    }

    if (question.length > 1000) {
      await reply(client, channel, thread_ts, "That's a long one — trim it to a single question and I'll take another look.");
      return;
    }

    // Visible acknowledgement; the API round-trip can take 10-30s.
    await markDone(client, channel, event.ts, "eyes");

    const result = await askXano(question);

    if (result.error) {
      console.error("askXano failed:", result.error);
      await reply(
        client,
        channel,
        thread_ts,
        `I hit an error reaching the data (${result.error}). Check Xano directly: ${xanoTableLink()}`
      );
      return;
    }

    if (!result.grounded) {
      await reply(
        client,
        channel,
        thread_ts,
        `I couldn't find anything in Xano that answers that, so I'd rather not guess. Worth checking by hand: ${xanoTableLink()}`
      );
      return;
    }

    const footer = result.toolsUsed.length
      ? `\n\n_via ${[...new Set(result.toolsUsed)].join(", ")}_`
      : "";

    await reply(client, channel, thread_ts, `${result.text}${footer}`);
  });
}

// ---------------------------------------------------------------------------
// Staged edits: /tulle edit … -> diff with buttons -> apply or discard
//
// The slash command NEVER writes live data. It stages a proposal in Xano and
// posts the resulting diff for someone to approve. Only the Approve button
// reaches vendor/edit/apply, the single live write in the flow.
// ---------------------------------------------------------------------------

function truncate(value, max = 300) {
  const text = String(value ?? "");
  if (!text.length) return "_(empty)_";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

// The button carries the proposer's ID alongside the edit ID so the two-person
// rule can be checked without a second round trip to Xano just to learn who
// proposed it.
function packAction(editId, proposerId) {
  return `${editId}:${proposerId || ""}`;
}
function unpackAction(value) {
  const [id, proposer = ""] = String(value || "").split(":");
  return { editId: Number(id), proposerId: proposer };
}

function diffBlocks(staged, proposerId) {
  const value = packAction(staged.edit_id, proposerId);
  return [
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${staged.vendor_name || staged.vendor_id}* (\`${staged.vendor_id}\`)\n*${staged.field_label || staged.field}*`,
      },
    },
    {
      type: "section",
      fields: [
        { type: "mrkdwn", text: `*Now*\n${truncate(staged.previous)}` },
        { type: "mrkdwn", text: `*Proposed*\n${truncate(staged.proposed)}` },
      ],
    },
    {
      type: "actions",
      elements: [
        { type: "button", text: { type: "plain_text", text: "Approve" }, style: "primary", action_id: "edit_approve", value },
        { type: "button", text: { type: "plain_text", text: "Discard" }, style: "danger", action_id: "edit_discard", value },
      ],
    },
    {
      type: "context",
      elements: [
        {
          type: "mrkdwn",
          text: `Staged #${staged.edit_id} by <@${proposerId}>. Nothing has changed yet.${
            staged.superseded ? ` Superseded ${staged.superseded} earlier proposal(s).` : ""
          }`,
        },
      ],
    },
  ];
}

// The description is GENERATED from the live config rather than written out as
// a fixed string. A help text that describes an idealised bot instead of the
// running one is worse than none — it tells you undo works when it is switched
// off. Everything conditional below reads the same flag the handler reads.
function aboutText() {
  const emoji = TRIGGER_EMOJI.map((e) => `:${e}:`).join(" / ");
  const lines = [
    "*Tulle Ops* — vendor data from Slack, without opening Xano.",
    "",
    "*Commands* — each has its own entry when you type `/`",
    "`/tulle-edit` · `/tulle-hide` · `/tulle-show` · `/tulle-pending` · `/tulle-applied` · `/tulle-status`",
    "",
    "*1. Hide a vendor — react, or by ID*",
    `React ${emoji} on any message containing a vendor ID (\`V4341\`, or a tulletogether.app vendor link),`,
    "or run `/tulle-hide V4341` when there's no message to react to. `/tulle-show V4341` puts it back.",
    "The vendor stops appearing in search. I reply in thread and mark the message ✅.",
    ENABLE_UNDO
      ? "*Remove* the reaction to put it back — that works even for vendors hidden long ago by other means."
      : "_Undo is switched off, so removing the reaction does nothing._",
    "Two vendor IDs in one message and I refuse rather than guess which you meant.",
    "⏱ Search is cached ~2h, so a hidden vendor can linger there briefly. The database changes instantly.",
    "",
    "*2. Edit vendor details — propose, then approve*",
    "`/tulle-edit V13831 State = South Carolina`",
    "`/tulle-edit V4341 Max_Capacity_Seated = 250`",
    "Editable: Name, State (or `location`), Address, Website, Description, Contact_Information,",
    "Max_Capacity_Seated (or `capacity`), Venue_Type, Type_of_Photography / Entertainment / Beauty.",
    "Nothing changes when you run that. I post the before/after with *Approve* and *Discard* buttons;",
    "only Approve writes. Everything after the first `=` is the value, so URLs are fine.",
    REQUIRE_SECOND_APPROVER
      ? "Someone other than the proposer must approve."
      : "_Anyone allowed can approve, including the proposer._ Set `REQUIRE_SECOND_APPROVER=true` to change that.",
    "If the value changed in Xano since you proposed it, Approve refuses — you'd be applying a stale diff.",
    "",
    "*3. See what is queued*",
    "`/tulle pending` — proposals waiting on someone",
    "`/tulle applied` — what has already gone through, and who approved it",
    "",
    "*4. See what a customer sees*",
    IMPERSONATE_USERS.length
      ? "`/tulle view-as sara@example.com` — a private, single-use link that loads the app as them. Read-only: their data cannot change, and checkout, password changes and account deletion are refused."
      : "_Off — nobody is on the view-as list._ Set `IMPERSONATE_USER_IDS` to switch it on.",
    "",
    "*5. Ask questions about the data*",
    ENABLE_ASK
      ? "`@Tulle Ops what pricing do we have for V2574?` — I answer from Xano only, in a thread, and say so when I can't find it."
      : "_Off._ When on, mentioning me asks questions about vendor and pricing data. Deliberately disabled for now.",
    "",
    "`/tulle status` — current settings and whether Xano is reachable",
  ];
  return lines.join("\n");
}

async function statusText() {
  const started = Date.now();
  const probe = await listEdits({ status: "pending", perPage: 1 });
  const ms = Date.now() - started;

  return [
    "*Tulle Ops — current settings*",
    "",
    `• Hide trigger: ${TRIGGER_EMOJI.map((e) => `:${e}:`).join(" / ")}`,
    `• Undo on reaction removal: ${ENABLE_UNDO ? "on" : "off"}`,
    `• Second approver required: ${REQUIRE_SECOND_APPROVER ? "yes" : "no"}`,
    `• Q&A on mention: ${ENABLE_ASK ? "on" : "off"}`,
    `• Channels: ${ALLOWED_CHANNELS.length ? ALLOWED_CHANNELS.map((c) => `<#${c}>`).join(", ") : "*any channel I'm in*"}`,
    `• Who can act: ${ALLOWED_USERS.length ? ALLOWED_USERS.map((u) => `<@${u}>`).join(", ") : "*anyone in the channel*"}`,
    "",
    probe.ok
      ? `• Xano: reachable (${ms}ms), ${probe.itemsTotal ?? 0} proposal(s) pending`
      : `• Xano: *unreachable* — ${probe.error}`,
  ].join("\n");
}

// One implementation, several front doors. Each /tulle-* command is a thin
// wrapper that hands the same text to this. Slack has no subcommand
// autocomplete, so separate commands are the only way features show up when
// someone types "/tulle" — but they should not be separate code paths.
async function handleTulle({ text, user_id, channel_id, respond }) {
  if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(channel_id)) {
    await respond({ response_type: "ephemeral", text: "Not enabled in this channel." });
    return;
  }
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(user_id)) {
    await respond({ response_type: "ephemeral", text: "You're not on the approved list for vendor edits." });
    return;
  }

  const parsed = parseEditCommand(text);

  if (parsed.action === "about") {
    await respond({ response_type: "ephemeral", text: aboutText() });
    return;
  }

  if (parsed.action === "status") {
    await respond({ response_type: "ephemeral", text: await statusText() });
    return;
  }

  if (parsed.action === "error" || parsed.action === "unknown") {
    await respond({ response_type: "ephemeral", text: `${parsed.error}\n\n${aboutText()}` });
    return;
  }

  if (parsed.action === "pending" || parsed.action === "applied") {
    const status = parsed.action;
    const result = await listEdits({ status });
    if (!result.ok) {
      await respond({ response_type: "ephemeral", text: `Couldn't read the queue — ${result.error}` });
      return;
    }
    const items = result.items || [];
    if (!items.length) {
      await respond({ response_type: "ephemeral", text: `Nothing ${status}.` });
      return;
    }
    const lines = items.map(
      (i) =>
        `#${i.id} · *${i.vendor_name || i.vendor_id}* · ${i.field}: ${truncate(i.previous_value, 40)} → ${truncate(i.new_value, 40)}`
    );
    await respond({ response_type: "ephemeral", text: `*${items.length} ${status}*\n${lines.join("\n")}` });
    return;
  }

  if (parsed.action === "view-as") {
    // Deliberately its own check, not folded into ALLOWED_USERS. Someone trusted to
    // fix a vendor's capacity is not automatically trusted to browse as a customer.
    if (!IMPERSONATE_USERS.includes(user_id)) {
      await respond({
        response_type: "ephemeral",
        text: "You're not on the view-as list. That list is separate from vendor edits, on purpose.",
      });
      return;
    }

    const started = await startViewAs({
      target: parsed.target,
      actorSlackId: user_id,
      note: parsed.note,
    });

    if (!started.ok) {
      // Xano's messages here are written for a human ("No account matches that
      // email or id.", "Admin view-as is currently disabled."), so pass them through.
      await respond({ response_type: "ephemeral", text: `Couldn't start that session — ${started.error}` });
      return;
    }

    const who = started.target_name
      ? `${started.target_name} (${started.target_email})`
      : started.target_email;

    await respond({
      response_type: "ephemeral",
      unfurl_links: false,
      text: [
        `*Viewing as ${who}*`,
        `<${started.url}|Open the app as them>`,
        "",
        "Single use · link dies in 10 min · session lasts 15 min.",
        "Open it in a *private/incognito window* — it replaces whatever session that browser has, and Exit signs you out.",
        "Read-only: their row cannot change, and checkout, password changes and account deletion are refused.",
      ].join("\n"),
    });
    return;
  }

  const staged = await stageEdit({
    vendorId: parsed.vendorId,
    field: parsed.field,
    newValue: parsed.value,
    proposedBy: user_id,
  });

  if (!staged.ok) {
    // Xano's rejection names the legal fields, so surface it verbatim.
    await respond({ response_type: "ephemeral", text: `Couldn't stage that — ${staged.error}` });
    return;
  }

  await respond({
    response_type: "in_channel",
    blocks: diffBlocks(staged, user_id),
    text: `${staged.vendor_name}: ${staged.field} change proposed by <@${user_id}>`,
  });
}

// Hide / show by vendor ID, for when you don't have a message to react to.
async function handleVisibilityCommand({ text, user_id, channel_id, respond, action }) {
  if (ALLOWED_CHANNELS.length && !ALLOWED_CHANNELS.includes(channel_id)) {
    await respond({ response_type: "ephemeral", text: "Not enabled in this channel." });
    return;
  }
  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(user_id)) {
    await respond({ response_type: "ephemeral", text: "You're not on the approved list for visibility changes." });
    return;
  }

  // Typed deliberately by a human, so accept V1-V99 too. The reaction handler
  // above keeps the strict floor, where a loose match could hide a real vendor.
  const { ids, primary, ambiguous } = extractVendorIds(text, { minDigits: MIN_DIGITS_TYPED });
  if (ambiguous) {
    await respond({ response_type: "ephemeral", text: `That names ${ids.length} vendors (${ids.join(", ")}) and I won't guess.` });
    return;
  }
  if (!primary) {
    await respond({ response_type: "ephemeral", text: "Give me a vendor ID, e.g. `/tulle-hide V4341`." });
    return;
  }

  const result = await setVendorVisibility({ vendorId: primary, action, actor: user_id });
  if (!result.ok) {
    await respond({ response_type: "ephemeral", text: `Couldn't update *${primary}* — ${result.error}` });
    return;
  }

  const label = result.vendor_name ? `*${result.vendor_name}* (\`${primary}\`)` : `*${primary}*`;
  if (result.changed === false) {
    await respond({
      response_type: "ephemeral",
      text: `${label} was already ${action === "hide" ? "hidden" : "visible"} — nothing to change.`,
    });
    return;
  }

  await respond({
    response_type: "in_channel",
    text: `${action === "hide" ? "Hidden" : "Restored"} ${label} — visibility ${result.previous_visibility} → ${result.new_visibility}. By <@${user_id}>.${
      action === "hide" ? " Search is cached ~2h, so it may linger there briefly." : ""
    }`,
  });
}

// Registrations. Every one of these appears as its own row when you type "/"
// in Slack, which is the whole point — /tulle alone hid four features behind
// arguments Slack cannot advertise.
const asCtx = (command) => ({
  text: command.text,
  user_id: command.user_id,
  channel_id: command.channel_id,
});

app.command("/tulle", async ({ command, ack, respond }) => {
  await ack();
  await handleTulle({ ...asCtx(command), respond });
});

app.command("/tulle-edit", async ({ command, ack, respond }) => {
  await ack();
  await handleTulle({ ...asCtx(command), text: `edit ${command.text}`, respond });
});

app.command("/tulle-pending", async ({ command, ack, respond }) => {
  await ack();
  await handleTulle({ ...asCtx(command), text: "pending", respond });
});

app.command("/tulle-applied", async ({ command, ack, respond }) => {
  await ack();
  await handleTulle({ ...asCtx(command), text: "applied", respond });
});

app.command("/tulle-status", async ({ command, ack, respond }) => {
  await ack();
  await handleTulle({ ...asCtx(command), text: "status", respond });
});

app.command("/tulle-hide", async ({ command, ack, respond }) => {
  await ack();
  await handleVisibilityCommand({ ...asCtx(command), respond, action: "hide" });
});

app.command("/tulle-show", async ({ command, ack, respond }) => {
  await ack();
  await handleVisibilityCommand({ ...asCtx(command), respond, action: "unhide" });
});

async function resolveEdit({ body, action, respond, approve }) {
  const { editId, proposerId } = unpackAction(action.value);
  const actor = body.user?.id;

  if (ALLOWED_USERS.length && !ALLOWED_USERS.includes(actor)) {
    await respond({ replace_original: false, response_type: "ephemeral", text: "You're not on the approved list for vendor edits." });
    return;
  }

  // Two-person rule. Discarding your own proposal is always fine — withdrawing
  // a suggestion is not what the rule exists to prevent.
  if (approve && REQUIRE_SECOND_APPROVER && proposerId && proposerId === actor) {
    await respond({
      replace_original: false,
      response_type: "ephemeral",
      text: `You proposed #${editId}, so someone else needs to approve it.`,
    });
    return;
  }

  const result = approve
    ? await applyEdit({ editId, appliedBy: actor })
    : await discardEdit({ editId, discardedBy: actor });

  if (!result.ok) {
    await respond({
      replace_original: false,
      response_type: "ephemeral",
      text: `Couldn't ${approve ? "apply" : "discard"} #${editId} — ${result.error}`,
    });
    return;
  }

  const detail = approve
    ? `${result.field_label || result.field}: ${truncate(result.previous, 80)} → ${truncate(result.new_value, 80)}`
    : `${result.field} left unchanged`;

  await respond({
    replace_original: true,
    text: `${approve ? "Applied" : "Discarded"} #${editId} — *${result.vendor_name || result.vendor_id}* (\`${result.vendor_id}\`). ${detail}. By <@${actor}>.`,
  });
}

app.action("edit_approve", async ({ ack, body, action, respond }) => {
  await ack();
  await resolveEdit({ body, action, respond, approve: true });
});

app.action("edit_discard", async ({ ack, body, action, respond }) => {
  await ack();
  await resolveEdit({ body, action, respond, approve: false });
});

app.error(async (error) => {
  console.error("Unhandled Bolt error:", error);
});

// ---------------------------------------------------------------------------

const port = process.env.PORT || 3000;
await app.start(port);
console.log(`tulle-slackbot listening on :${port}`);
console.log(`  trigger emoji : ${TRIGGER_EMOJI.map((e) => `:${e}:`).join(", ")}`);
console.log(`  undo enabled  : ${ENABLE_UNDO}`);
console.log(`  Q&A on mention: ${ENABLE_ASK ? "on" : "off"}`);
console.log(`  2nd approver  : ${REQUIRE_SECOND_APPROVER ? "required" : "not required"}`);
console.log(`  channel lock  : ${ALLOWED_CHANNELS.length ? ALLOWED_CHANNELS.join(", ") : "none (all channels)"}`);
console.log(`  user lock     : ${ALLOWED_USERS.length ? ALLOWED_USERS.join(", ") : "none (anyone in channel)"}`);
