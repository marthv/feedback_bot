// Read-only question answering over the Xano MCP server.
//
// The design rule: the bot answers from tool results or it does not answer.
// A model's self-reported confidence is not calibrated, so "answer if you're
// sure" produces confident wrong answers about pricing. Instead the check is
// structural — if no MCP tool returned usable data, we refuse and link out.

const API_URL = "https://api.anthropic.com/v1/messages";
const BETA_HEADER = "mcp-client-2025-11-20";
const TIMEOUT_MS = 60_000;

// Allowlisted read tools. default_config.enabled=false below means anything
// NOT in this list is disabled — including any write tool added to Xano later.
//
// Deliberately excluded:
//   create_user_package, update_package, update_todo_item,
//   Set_Up_Payment_Log            → writes
//   list_user_packages, list_user_todos, list_user_referrals,
//   Query_Users_Table             → individual couples' private data
//   search_wptp_vendors           → currently returns "missing parameter - dbo";
//                                   re-enable once that endpoint is fixed
const READ_TOOLS = [
  "get_vendor_pricing_details",
  "get_granular_venue_pricing",
  "query_venue_pricing",
  "query_all_venue_pricing",
  "query_extracted_pdf_data",
  "list_wptp_pdfs",
  "tool_wedding_search_venues",
  "tool_wedding_search_photographers",
  "tool_wedding_get_budget_categories",
];

const SYSTEM_PROMPT = `You answer questions about Tulle Together's vendor and pricing data for the internal team in Slack.

Rules:
- Answer ONLY from data returned by your tools. Never answer from general knowledge or memory about specific vendors, prices, or records.
- If the tools return nothing relevant, say so plainly. Do not speculate or fill gaps.
- Always name the vendor ID and which records you used, so a human can verify.
- If data looks stale, contradictory, or sparse, say that explicitly rather than smoothing it over.
- Be brief. This is a Slack thread, not a report. Two or three sentences is usually right.
- Never invent a vendor ID, price, date, or venue name.
- Prices in the data are historical vendor PDF extractions, not live quotes. Say so when it matters.`;

function toolConfigs() {
  return Object.fromEntries(READ_TOOLS.map((name) => [name, { enabled: true }]));
}

/**
 * Ask a grounded question against the Xano MCP server.
 * @param {string} question
 * @returns {Promise<{ grounded: boolean, text: string, toolsUsed: string[], error?: string }>}
 */
export async function askXano(question) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  const mcpUrl = process.env.XANO_MCP_URL;
  if (!apiKey) return { grounded: false, text: "", toolsUsed: [], error: "ANTHROPIC_API_KEY is not set" };
  if (!mcpUrl) return { grounded: false, text: "", toolsUsed: [], error: "XANO_MCP_URL is not set" };

  const server = {
    type: "url",
    url: mcpUrl,
    name: "tulle-xano",
  };
  if (process.env.XANO_MCP_TOKEN) {
    server.authorization_token = process.env.XANO_MCP_TOKEN;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": BETA_HEADER,
      },
      body: JSON.stringify({
        model: process.env.ANSWER_MODEL || "claude-sonnet-5",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content: question }],
        mcp_servers: [server],
        tools: [
          {
            type: "mcp_toolset",
            mcp_server_name: "tulle-xano",
            default_config: { enabled: false },
            configs: toolConfigs(),
          },
        ],
      }),
      signal: controller.signal,
    });

    const body = await res.json().catch(() => null);

    if (!res.ok) {
      return {
        grounded: false,
        text: "",
        toolsUsed: [],
        error: body?.error?.message || `Anthropic API HTTP ${res.status}`,
      };
    }

    const blocks = Array.isArray(body?.content) ? body.content : [];

    // Find blocks by type, never by position — the order varies run to run.
    const text = blocks
      .filter((b) => b.type === "text")
      .map((b) => b.text || "")
      .join("\n")
      .trim();

    const toolsUsed = blocks
      .filter((b) => b.type === "mcp_tool_use")
      .map((b) => b.name);

    // Grounding check: at least one tool result that isn't an error and
    // actually carries content.
    const grounded = blocks.some(
      (b) =>
        b.type === "mcp_tool_result" &&
        !b.is_error &&
        Array.isArray(b.content) &&
        b.content.some((c) => c.type === "text" && c.text?.trim())
    );

    return { grounded, text, toolsUsed };
  } catch (err) {
    if (err.name === "AbortError") {
      return { grounded: false, text: "", toolsUsed: [], error: "Timed out after 60s" };
    }
    return { grounded: false, text: "", toolsUsed: [], error: err.message };
  } finally {
    clearTimeout(timer);
  }
}

export { READ_TOOLS };
