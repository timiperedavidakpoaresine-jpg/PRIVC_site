import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean));

function headers(req: Request) {
  const origin = req.headers.get("origin") || "";
  const allowed = origin && allowedOrigins.has(origin);
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function respond(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: headers(req) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: headers(req) });
  if (req.method !== "POST") return respond(req, { error: "method_not_allowed" }, 405);

  const origin = req.headers.get("origin") || "";
  if (origin && !allowedOrigins.has(origin)) return respond(req, { error: "origin_not_allowed" }, 403);
  if (!url || !anonKey || !serviceRoleKey) {
    return respond(req, { error: "function_not_configured" }, 503);
  }

  const authorization = req.headers.get("authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i);
  if (!token) return respond(req, { error: "authentication_required" }, 401);

  const authClient = createClient(url, anonKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const { data, error } = await authClient.auth.getUser(token[1]);
  if (error || !data.user) return respond(req, { error: "invalid_session" }, 401);

  const adminClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const deletion = await adminClient.auth.admin.deleteUser(data.user.id);
  if (deletion.error) return respond(req, { error: "account_deletion_failed" }, 500);
  return new Response(null, { status: 204, headers: headers(req) });
});
