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
