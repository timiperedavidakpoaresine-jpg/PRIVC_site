// Supabase Edge Function: wb-sync
// mode=catalog  (cron, needs x-cron-secret)  copies the World Bank indicator catalog into wb_catalog
// mode=refresh  (cron, needs x-cron-secret)  re-downloads values for indicators already used on the site
// mode=pull&code=XX.YY.ZZ (called by the website) downloads values for one indicator the first time it is chosen
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const WB = "https://api.worldbank.org/v2";
const H = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Content-Type": "application/json",
};
const json = (o: unknown, s = 200) => new Response(JSON.stringify(o), { status: s, headers: H });
const authed = (r: Request) => !!Deno.env.get("CRON_SECRET") && r.headers.get("x-cron-secret") === Deno.env.get("CRON_SECRET");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function wb(url: string) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json();
    } catch (_) { /* retry */ }
    await sleep(1500 * (i + 1));
  }
  throw new Error("World Bank API did not answer: " + url);
}
async function log(mode: string, detail: unknown) { await sb.from("wb_sync_log").insert({ mode, detail }); }

// ---- catalog: a few pages per call, then the function calls itself for the next pages ----
async function catalog(from: number, maxPages = 10) {
  let page = from, pages = from, n = 0;
  for (let i = 0; i < maxPages && page <= pages; i++, page++) {
    const j = await wb(`${WB}/indicator?format=json&per_page=1000&page=${page}`);
    pages = j[0].pages;
    const rows = (j[1] || []).map((x: any) => ({
      indicator_id: x.id,
      name: x.name,
      unit: x.unit || null,
      source_id: x.source?.id ? +x.source.id : null,
      source_name: x.source?.value || null,
      source_org: x.sourceOrganization || null,
      topics: (x.topics || []).map((t: any) => t.value).filter(Boolean),
      note: x.sourceNote || null,
      synced_at: new Date().toISOString(),
    }));
    for (let k = 0; k < rows.length; k += 500) {
      const { error } = await sb.from("wb_catalog").upsert(rows.slice(k, k + 500), { onConflict: "indicator_id" });
      if (error) throw error;
    }
    n += rows.length;
  }
  return { next: page <= pages ? page : null, pages, upserted: n };
}

// ---- values for one indicator ----
async function pull(code: string) {
  const { data: cat } = await sb.from("wb_catalog").select("*").eq("indicator_id", code).maybeSingle();
  if (!cat) return { ok: false, error: "unknown indicator" };
  const rows: any[] = [];
  let page = 1, pages = 1;
  const src = cat.source_id ? `&source=${cat.source_id}` : "";
  while (page <= pages) {
    const j = await wb(`${WB}/country/all/indicator/${encodeURIComponent(code)}?format=json&per_page=20000&date=1960:${new Date().getFullYear()}${src}&page=${page}`);
    if (!Array.isArray(j) || !j[1]) break;
    pages = j[0].pages;
    for (const r of j[1]) {
      if (r.value === null || !r.countryiso3code || r.countryiso3code.length !== 3) continue;
      rows.push({ geo: r.countryiso3code, indicator: code, year: +r.date, value: r.value, source: "WB" });
    }
    page++;
  }
  if (!rows.length) {
    await sb.from("wb_catalog").update({ pulled_at: new Date().toISOString() }).eq("indicator_id", code);
    return { ok: true, rows: 0 };
  }
  // replace this indicator's World Bank rows only after the download succeeded
  await sb.from("observations").delete().eq("source", "WB").eq("indicator", code);
  for (let k = 0; k < rows.length; k += 1000) {
    const { error } = await sb.from("observations").insert(rows.slice(k, k + 1000));
    if (error) throw error;
  }
  const vals = rows.map((r) => r.value);
  await sb.from("indicators").delete().eq("source", "WB").eq("code", code);
  await sb.from("indicators").insert({ source: "WB", code, name: cat.name, unit: cat.unit, theme: (cat.topics || [])[0] || null });
  await sb.from("indicator_ranges").delete().eq("indicator", code);
  await sb.from("indicator_ranges").insert({ indicator: code, lo: Math.min(...vals), hi: Math.max(...vals), n_values: rows.length });
  await sb.from("wb_catalog").update({ pulled_at: new Date().toISOString() }).eq("indicator_id", code);
  return { ok: true, rows: rows.length };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: H });
  const u = new URL(req.url), mode = u.searchParams.get("mode");
  try {
    if (mode === "pull") {
      const code = u.searchParams.get("code") || "";
      if (!/^[A-Za-z0-9._-]{2,80}$/.test(code)) return json({ ok: false, error: "bad code" }, 400);
      const { data: c } = await sb.from("wb_catalog").select("pulled_at").eq("indicator_id", code).maybeSingle();
      if (c?.pulled_at && Date.now() - new Date(c.pulled_at).getTime() < 25 * 864e5) return json({ ok: true, cached: true });
      const since = new Date(Date.now() - 3600e3).toISOString();
      const { count } = await sb.from("wb_sync_log").select("id", { count: "exact", head: true }).eq("mode", "pull").gte("ran_at", since);
      if ((count || 0) > 300) return json({ ok: false, error: "busy, try again later" }, 429);
      const out = await pull(code);
      await log("pull", { code, ...out });
      return json(out);
    }
    if (!authed(req)) return json({ ok: false, error: "not allowed" }, 401);
    if (mode === "catalog") {
      const from = +(u.searchParams.get("page") || 1);
      const out = await catalog(from);
      await log("catalog", out);
      if (out.next) {
        // continue with the next pages in the background
        // @ts-ignore EdgeRuntime exists in Supabase Edge Functions
        EdgeRuntime.waitUntil(fetch(`${u.origin}${u.pathname}?mode=catalog&page=${out.next}`, { headers: { "x-cron-secret": Deno.env.get("CRON_SECRET")! } }));
      }
      return json(out);
    }
    if (mode === "refresh") {
      const limit = Math.min(+(u.searchParams.get("limit") || 12), 25);
      const { data } = await sb.from("wb_catalog").select("indicator_id").not("pulled_at", "is", null)
        .lt("pulled_at", new Date(Date.now() - 25 * 864e5).toISOString()).order("pulled_at").limit(limit);
      const done: string[] = [];
      for (const r of data || []) { try { await pull(r.indicator_id); done.push(r.indicator_id); } catch (_) { /* next */ } }
      await log("refresh", { done });
      return json({ ok: true, refreshed: done.length });
    }
    return json({ ok: false, error: "unknown mode" }, 400);
  } catch (e) {
    await log("error", { mode, message: String((e as Error).message || e) });
    return json({ ok: false, error: String((e as Error).message || e) }, 500);
  }
});
