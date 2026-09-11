// Admin customer snapshot — "what does this customer actually see?".
//
// REPLACED THE IN-BROWSER "view as" APPROACH (2026-09-11). That version minted a
// real session and handed the admin a link. It was abandoned after five attempts:
// the token, the session adoption and every authenticated call worked - auth/me,
// upgrade_offer and my_access_summary all returned 200 - while WeWeb's router
// still rendered the Sign In page. The router decides page access once at boot,
// before app-load workflows run and before the auth plugin's async restore
// resolves, and nothing re-asks it. No workflow can win that race.
//
// This answers the same question server-side instead: tier, access dates, whether
// Pricing Intelligence is unlocked, free PDF views left, and exactly what the
// upgrade banner would offer. No impersonation, no session, nothing that can log
// a customer out, and no WeWeb publish.
//
// Keeps its own secret (XANO_IMPERSONATE_KEY), separate from the XANO_API_KEY that
// guards the staged-edit endpoints: reading one customer's entitlement state is a
// higher-privilege act than proposing a vendor field edit, and the two should not
// fall together if one leaks.

import { call } from "./edits.js";

/**
 * Read one customer's entitlement state. Read-only; writes nothing.
 *
 * @param {object} args
 * @param {string} args.target        Customer email, or a numeric user id as a string.
 * @param {string} args.actorSlackId  Slack user id of the admin, for attribution.
 * @returns {Promise<{ok: boolean, user?: object, upgrade?: object, error?: string}>}
 */
export function customerSnapshot({ target, actorSlackId }) {
  const body = {
    actor_slack_id: actorSlackId,
  };

  // Xano resolves by id when user_id > 0, otherwise by email. Send exactly one,
  // so a typo'd email can never be silently reinterpreted as an id.
  if (/^\d+$/.test(String(target).trim())) {
    body.user_id = Number(String(target).trim());
  } else {
    body.email = String(target).trim();
  }

  return call("/admin/customer_snapshot", body, "POST", {
    secret: process.env.XANO_IMPERSONATE_KEY,
  });
}
