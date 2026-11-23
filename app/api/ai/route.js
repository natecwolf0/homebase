// Server-side proxy for every AI call in HOMEBASE. The browser sends
// { system, messages, max_tokens }; this route adds the secret key and calls
// the Anthropic API. The key never reaches the browser.
//
// Prompts are written in the app code (unchanged). The model is set here, in
// one place, via the ANTHROPIC_MODEL env var (default below).

export const runtime = "nodejs";
export const maxDuration = 60;

const MODEL = process.env.ANTHROPIC_MODEL || "claude-sonnet-5-5";
const API_URL = process.env.ANTHROPIC_API_URL || "https://api.anthropic.com/v1/messages";
const MAX_BODY_CHARS = 1_500_000;  // the whole-pool outlier scan is the biggest request
const MAX_TOKENS_CAP = 4000;

export async function POST(req) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    return Response.json({ error: { type: "config_error", message: "ANTHROPIC_API_KEY is not set on the server." } }, { status: 500 });
  }

  let raw;
  try { raw = await req.text(); } catch { return Response.json({ error: { message: "Bad request." } }, { status: 400 }); }
  if (raw.length > MAX_BODY_CHARS) return Response.json({ error: { message: "Request too large." } }, { status: 413 });

  let body;
  try { body = JSON.parse(raw); } catch { return Response.json({ error: { message: "Invalid JSON." } }, { status: 400 }); }

  const { system, messages } = body || {};
  if (typeof system !== "string" || !Array.isArray(messages) || messages.length === 0 ||
      !messages.every((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")) {
    return Response.json({ error: { message: "Expected { system: string, messages: [{role, content: string}] }." } }, { status: 400 });
  }
  const max_tokens = Math.max(1, Math.min(Number(body.max_tokens) || 1000, MAX_TOKENS_CAP));

  try {
    const upstream = await fetch(API_URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: MODEL, max_tokens, system, messages }),
    });
    const text = await upstream.text();
    return new Response(text, { status: upstream.status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
  } catch (e) {
    return Response.json({ error: { type: "upstream_error", message: "Couldn't reach the AI service." } }, { status: 502 });
  }
}
