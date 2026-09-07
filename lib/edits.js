// Thin client over the staged-edit endpoints.
//
// Same rule as lib/xano.js: this file knows nothing about table 11's columns.
// It forwards whatever field name the user typed and lets Xano accept or reject
// it against the whitelist in fn vendor_edit_field_spec. If you find yourself
// adding a column name to this file, the design has gone wrong.

const TIMEOUT_MS = 10_000;

/**
 * Base of the Xano API group, e.g. https://…/api:aow91bcd
 *
 * Derived from XANO_VISIBILITY_URL so adding this feature needs no new env var.
 * XANO_API_BASE overrides it if the edit endpoints ever move to another group.
 */
function apiBase() {
  if (process.env.XANO_API_BASE) {
    return process.env.XANO_API_BASE.replace(/\/+$/, "");
  }
  const visibility = process.env.XANO_VISIBILITY_URL || "";
  return visibility.replace(/\/vendor\/visibility\/?$/, "");
}

async function call(path, body, method = "POST") {
  const base = apiBase();
  if (!base) throw new Error("Cannot resolve the Xano API base URL");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  const payload = { ...body, secret: process.env.XANO_API_KEY || "" };

  let url = `${base}${path}`;
  const init = { method, headers: {}, signal: controller.signal };

  if (method === "GET") {
    url += `?${new URLSearchParams(payload).toString()}`;
  } else {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(payload);
  }

  try {
    const res = await fetch(url, init);
    const text = await res.text();

    let parsed;
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      return { ok: false, error: `Xano returned non-JSON (HTTP ${res.status})` };
    }

    if (!res.ok) {
      // Xano puts the precondition message in `message`. Those messages are
      // written to be read by a human in Slack, so pass them through verbatim
      // rather than replacing them with something vaguer.
      return { ok: false, error: parsed?.message || parsed?.error || `Xano HTTP ${res.status}` };
    }

    return { ok: true, ...parsed };
  } catch (err) {
    if (err.name === "AbortError") return { ok: false, error: "Xano request timed out after 10s" };
    return { ok: false, error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** Propose an edit. Writes nothing live; returns the diff to show for approval. */
export function stageEdit({ vendorId, field, newValue, proposedBy, note }) {
  return call("/vendor/edit/stage", {
    vendor_id: vendorId,
    field,
    new_value: newValue,
    proposed_by: proposedBy,
    note,
    source: "slackbot",
  });
}

/** Apply a staged edit. This is the only call in this file that changes live data. */
export function applyEdit({ editId, appliedBy }) {
  return call("/vendor/edit/apply", { edit_id: editId, applied_by: appliedBy });
}

/** Reject a staged edit. The row is kept as a record of what was refused. */
export function discardEdit({ editId, discardedBy }) {
  return call("/vendor/edit/discard", { edit_id: editId, discarded_by: discardedBy });
}

/** Read the review queue. */
export function listEdits({ status = "pending", perPage = 20 } = {}) {
  return call("/vendor/edit/pending", { status, per_page: perPage }, "GET");
}
