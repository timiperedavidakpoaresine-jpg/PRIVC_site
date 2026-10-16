// Supabase Edge Function: provider-proxy
// A read-only relay for public data APIs that do not allow direct browser requests (CORS).
// Only the hosts listed below are allowed. Usage: /functions/v1/provider-proxy?url=<encoded API url>
const ALLOWED = ["ghoapi.azureedge.net", "api.uis.unesco.org", "api.worldbank.org"];
const H = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Content-Type": "application/json",
  "Cache-Control": "public, max-age=3600",
};
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  if (req.method !== "GET") return new Response("{}", { status: 405, headers: H });
  try {
    const target = new URL(new URL(req.url).searchParams.get("url") || "");
    if (target.protocol !== "https:" || !ALLOWED.includes(target.hostname)) {
      return new Response(JSON.stringify({ error: "host not allowed" }), { status: 403, headers: H });
    }
    const r = await fetch(target.toString(), { headers: { Accept: "application/json", "User-Agent": "PRIVC-Atlas/1.0" } });
    return new Response(await r.text(), { status: r.status, headers: H });
  } catch (e) {
    return new Response(JSON.stringify({ error: String((e as Error).message || e) }), { status: 400, headers: H });
  }
});
