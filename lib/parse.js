// Pulls a Tulle vendor ID out of arbitrary Slack message text.
//
// Handles the shapes that actually show up in the channel:
//   "V2574 is showing 2019 pricing"
//   "vendor id: v10363"
//   "https://tulletogether.app/vendor/V13831"
//   "<https://tulletogether.app/vendor?vendor_id=V1905|The Foundry>"
//
// Slack wraps URLs in angle brackets and may append "|display text", so the
// raw text is unescaped before matching.

const BARE_ID = /\bV\d{3,7}\b/gi;
const URL_ID = /(?:vendor[_-]?id=|\/vendor(?:s)?\/)(V\d{3,7})/gi;

function unescapeSlack(text) {
  return String(text || "")
    .replace(/<([^>|]+)\|[^>]*>/g, "$1") // <url|label> -> url
    .replace(/[<>]/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");
}

/**
 * @param {string} text raw Slack message text
 * @returns {{ ids: string[], primary: string|null, ambiguous: boolean }}
 */
export function extractVendorIds(text) {
  const clean = unescapeSlack(text);
  const found = new Set();

  for (const m of clean.matchAll(URL_ID)) {
    found.add(m[1].toUpperCase());
  }
  for (const m of clean.matchAll(BARE_ID)) {
    found.add(m[0].toUpperCase());
  }

  const ids = [...found];
  return {
    ids,
    primary: ids.length === 1 ? ids[0] : null,
    ambiguous: ids.length > 1,
  };
}

/**
 * Bounded in-memory dedupe. Slack retries events on timeout or non-200,
 * and a retried reaction_added would otherwise flip visibility twice.
 */
export function createEventDeduper(max = 500) {
  const seen = new Set();
  return function isDuplicate(eventId) {
    if (!eventId) return false;
    if (seen.has(eventId)) return true;
    seen.add(eventId);
    if (seen.size > max) {
      // Drop the oldest ~20%. Sets iterate in insertion order.
      const drop = Math.floor(max * 0.2);
      let i = 0;
      for (const key of seen) {
        seen.delete(key);
        if (++i >= drop) break;
      }
    }
    return false;
  };
}

/**
 * Parses the `/tulle` slash command.
 *
 * Shapes accepted:
 *   edit V4341 Description = New blurb here
 *   edit V4341 Max_Capacity_Seated=250
 *   edit https://tulletogether.app/vendor/V4341 Website = https://x.com
 *   pending
 *   applied
 *   help
 *
 * The field name is NOT validated here — Xano owns the whitelist. This only
 * splits the text; a wrong field name comes back as a Xano error listing the
 * legal ones, which is a better message than anything this file could produce.
 *
 * Everything after the first "=" is the value, so values may contain "=".
 *
 * @param {string} raw
 * @returns {{ action: string, vendorId?: string, field?: string, value?: string, error?: string }}
 */
export function parseEditCommand(raw) {
  const text = String(raw || "").trim();
  if (!text) return { action: "help" };

  const [verb, ...rest] = text.split(/\s+/);
  const lower = verb.toLowerCase();

  if (lower === "help") return { action: "help" };
  if (lower === "pending" || lower === "queue") return { action: "pending" };
  if (lower === "applied" || lower === "history") return { action: "applied" };

  if (lower !== "edit") {
    return { action: "unknown", error: `I don't know the command \`${verb}\`.` };
  }

  const remainder = rest.join(" ");
  const { ids, primary, ambiguous } = extractVendorIds(remainder);

  if (ambiguous) {
    return { action: "error", error: `That names ${ids.length} vendors (${ids.join(", ")}) and I won't guess.` };
  }
  if (!primary) {
    return { action: "error", error: "No vendor ID in that command — I look for something like `V2574`." };
  }

  // Drop the vendor token itself, then split the rest on the first "=".
  const afterVendor = remainder
    .replace(/\S*V\d{3,7}\S*/i, "")
    .trim();

  const eq = afterVendor.indexOf("=");
  if (eq === -1) {
    return { action: "error", error: "I need a `Field = value` after the vendor ID." };
  }

  const field = afterVendor.slice(0, eq).trim();
  const value = afterVendor.slice(eq + 1).trim();

  if (!field) return { action: "error", error: "Missing the field name before the `=`." };

  return { action: "edit", vendorId: primary, field, value };
}
