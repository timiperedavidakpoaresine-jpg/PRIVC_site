import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const url = Deno.env.get("SUPABASE_URL") || "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const allowedOrigins = new Set((Deno.env.get("ALLOWED_ORIGINS") || "")
  .split(",").map((origin) => origin.trim()).filter(Boolean));

function corsHeaders(req: Request) {
  const origin = req.headers.get("origin") || "";
  return {
    "Access-Control-Allow-Origin": origin && allowedOrigins.has(origin) ? origin : "null",
    "Access-Control-Allow-Headers": "authorization, apikey, x-client-info, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Content-Type": "application/json",
    "Vary": "Origin",
  };
}

function respond(req: Request, body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: corsHeaders(req) });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders(req) });
  if (req.method !== "POST") return respond(req, { error: "method_not_allowed" }, 405);

  const origin = req.headers.get("origin") || "";
  if (origin && !allowedOrigins.has(origin)) return respond(req, { error: "origin_not_allowed" }, 403);
  if (!url || !anonKey || !serviceRoleKey) {
    return respond(req, { error: "function_not_configured" }, 503);
  }

  let body: { paper_id?: string };
  try {
    body = await req.json();
  } catch {
    return respond(req, { error: "invalid_request" }, 400);
  }
  if (!body.paper_id || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.paper_id)) {
    return respond(req, { error: "invalid_paper_id" }, 400);
  }

  const service = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  let userId: string | null = null;
  let isReviewer = false;
  const authorization = req.headers.get("authorization") || "";
  const tokenMatch = authorization.match(/^Bearer\s+(.+)$/i);
  const apiKey = req.headers.get("apikey") || "";
  if (tokenMatch && tokenMatch[1] !== apiKey) {
    const authClient = createClient(url, anonKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const { data, error } = await authClient.auth.getUser(tokenMatch[1]);
    if (error || !data.user) return respond(req, { error: "invalid_session" }, 401);
    userId = data.user.id;

    const { data: profile, error: profileError } = await service
      .from("profiles").select("account_role").eq("id", userId).maybeSingle();
    if (profileError) return respond(req, { error: "authorization_check_failed" }, 500);
    isReviewer = Boolean(profile && ["reviewer", "publishing_team", "admin"].includes(profile.account_role));
  }

  const { data: paper, error: paperError } = await service
    .from("papers").select("author_id,status,pdf_path").eq("id", body.paper_id).maybeSingle();
  if (paperError) return respond(req, { error: "paper_lookup_failed" }, 500);
  if (!paper || !paper.pdf_path) return respond(req, { error: "paper_not_found" }, 404);

  const isOwner = userId === paper.author_id;
  if (paper.status !== "Published" && !isOwner && !isReviewer) {
    return respond(req, { error: "paper_not_found" }, 404);
  }

  const { data: signed, error: signingError } = await service.storage
    .from("privc-papers").createSignedUrl(paper.pdf_path, 300);
  if (signingError || !signed) return respond(req, { error: "pdf_unavailable" }, 500);
  return respond(req, { url: signed.signedUrl });
});
