// Supabase Edge Function: ai-assistant
// The AI key stays here (server side). The website sends a conversation; this function adds the key, enforces limits,
// calls the Anthropic Messages API and returns the answer. The browser runs the site's own data tools and sends results back.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const KEY = Deno.env.get("ANTHROPIC_API_KEY") || "";
const MODEL = Deno.env.get("AI_MODEL") || "claude-sonnet-5-5";
const ALLOWED = (Deno.env.get("ALLOWED_ORIGINS") || "*").split(",").map((s) => s.trim());
const PER_IP = +(Deno.env.get("AI_DAILY_PER_IP") || "60");        // model calls per visitor per day
const GLOBAL = +(Deno.env.get("AI_DAILY_GLOBAL") || "3000");       // model calls for the whole site per day
const MAX_TOKENS = +(Deno.env.get("AI_MAX_TOKENS") || "4096");
const CODE = Deno.env.get("AI_ACCESS_CODE") || "";                 // optional: visitors must type this code
const WEB = (Deno.env.get("AI_WEB_SEARCH") || "on") !== "off";     // literature search for references

function cors(req: Request) {
  const o = req.headers.get("origin") || "";
  const ok = ALLOWED.includes("*") || ALLOWED.includes(o);
  return {
    "Access-Control-Allow-Origin": ok ? (ALLOWED.includes("*") ? "*" : o) : ALLOWED[0],
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-access-code",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}
const out = (req: Request, o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: cors(req) });
async function sha(s: string) {
  const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(b)).slice(0, 8).map((x) => x.toString(16).padStart(2, "0")).join("");
}
async function allow(k: string, limit: number) {
  const { data, error } = await sb.rpc("ai_hit", { p_key: k, p_limit: limit });
  return error ? true : data === true;   // if the counter table is missing, do not block
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors(req) });
  const o = req.headers.get("origin") || "";
  if (!ALLOWED.includes("*") && o && !ALLOWED.includes(o)) return out(req, { error: { type: "origin_not_allowed" } }, 403);
  if (req.method === "GET") {
    return KEY
      ? out(req, { ok: true, configured: true })
      : out(req, { ok: false, configured: false, error: { type: "not_configured" } }, 503);
  }
  if (req.method !== "POST") return out(req, { error: { type: "method" } }, 405);
  if (!KEY) return out(req, { error: { type: "not_configured", message: "ANTHROPIC_API_KEY is not set" } }, 503);
  if (CODE && req.headers.get("x-access-code") !== CODE) return out(req, { error: { type: "access_code" } }, 401);
  try {
    const raw = await req.text();
    if (raw.length > 600_000) return out(req, { error: { type: "too_large" } }, 413);
    const b = JSON.parse(raw);
    if (!Array.isArray(b.messages) || b.messages.length > 60) return out(req, { error: { type: "bad_request" } }, 400);
    const ip = (req.headers.get("x-forwarded-for") || "unknown").split(",")[0].trim();
    if (!(await allow("ip:" + await sha(ip), PER_IP)) || !(await allow("global", GLOBAL))) {
      return out(req, { error: { type: "rate_limited" } }, 429);
    }
    const tools: unknown[] = (Array.isArray(b.tools) ? b.tools : []).slice(0, 20).map((t: any) => ({
      name: String(t.name).slice(0, 64), description: String(t.description || "").slice(0, 1500), input_schema: t.input_schema || { type: "object", properties: {} },
    }));
    if (WEB && b.web) tools.push({ type: "web_search_20250305", name: "web_search", max_uses: 5 });
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": KEY, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, max_tokens: MAX_TOKENS, system: String(b.system || "").slice(0, 20000), messages: b.messages, tools }),
    });
    const text = await r.text();
    return new Response(text, { status: r.status, headers: cors(req) });
  } catch (e) {
    return out(req, { error: { type: "server", message: String((e as Error).message || e) } }, 500);
  }
});
