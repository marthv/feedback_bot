// Admin "view as user" — the Slack half.
//
// Two-step by design. This file only ever asks Xano to MINT a session, and gets
// back a URL carrying a single-use nonce. The auth token is never returned here,
// so no working credential passes through Slack message history, link unfurls or
// referer headers. The browser trades the nonce for a token at
// admin/impersonate/exchange, which lives in the WeWeb API group.
//
// The mint endpoint has its OWN secret (XANO_IMPERSONATE_KEY), separate from the
// XANO_API_KEY that guards the staged-edit endpoints. Starting a session as a
// real paying customer is a strictly higher-privilege act than proposing a
// vendor field edit, and the two should not fall together if one leaks.

import { call } from "./edits.js";

/**
 * Start a view-as session.
 *
 * @param {object} args
 * @param {string} args.target        Customer email, or a numeric user id as a string.
 * @param {string} args.actorSlackId  Slack user id of the admin. Written to admin_audit.
 * @param {string} [args.note]        Optional reason, stored in admin_audit.
 * @returns {Promise<{ok: boolean, url?: string, target_email?: string, target_name?: string, error?: string}>}
 */
export function startViewAs({ target, actorSlackId, note }) {
  const body = {
    actor_slack_id: actorSlackId,
    note,
    source: "slack_bot",
  };

  // Xano resolves by id when user_id > 0, otherwise by email. Send exactly one,
  // so a typo'd email can never be silently reinterpreted as an id.
  if (/^\d+$/.test(String(target).trim())) {
    body.user_id = Number(String(target).trim());
  } else {
    body.email = String(target).trim();
  }

  return call("/admin/impersonate/mint", body, "POST", {
    secret: process.env.XANO_IMPERSONATE_KEY,
  });
}
