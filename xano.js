// Thin client over one Xano endpoint.
//
// The bot deliberately knows nothing about the table, the column name, or the
// value encoding. Xano owns all of that. This file only knows: send a vendor
// ID and an action, get back a result object.

const TIMEOUT_MS = 10_000;

/**
 * @param {object} opts
 * @param {string} opts.vendorId  e.g. "V2574"
 * @param {"hide"|"unhide"} opts.action
 * @param {string} opts.actor     Slack user ID that triggered it (audit trail)
 * @returns {Promise<{
 *   ok: boolean,
 *   vendor_id?: string,
 *   vendor_name?: string,
 *   previous_visibility?: number,
 *   new_visibility?: number,
 *   changed?: boolean,
 *   error?: string
 * }>}
 */
export async function setVendorVisibility({ vendorId, action, actor }) {
  const url = process.env.XANO_VISIBILITY_URL;
  if (!url) throw new Error("XANO_VISIBILITY_URL is not set");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.XANO_API_KEY || "",
      },
      body: JSON.stringify({
        vendor_id: vendorId,
        action,
        actor_slack_id: actor,
        source: "slackbot",
      }),
      signal: controller.signal,
    });

    const text = await res.text();
    let body;
    try {
      body = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, error: `Xano returned non-JSON (HTTP ${res.status})` };
    }

    if (!res.ok) {
      return {
        ok: false,
        error: body?.message || body?.error || `Xano HTTP ${res.status}`,
      };
    }

    return { ok: true, ...body };
  } catch (err) {
    if (err.name === "AbortError") {
      return { ok: false, error: "Xano request timed out after 10s" };
    }
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}
