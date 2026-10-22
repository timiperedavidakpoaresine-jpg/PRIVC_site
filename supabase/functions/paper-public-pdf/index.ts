import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function errorResponse(status: number, error: string) {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method !== "GET" && req.method !== "HEAD") {
    return errorResponse(405, "method_not_allowed");
  }
  if (!supabaseUrl || !serviceRoleKey) {
    console.error("paper-public-pdf is missing required Supabase configuration");
    return errorResponse(503, "function_not_configured");
  }

  const requestUrl = new URL(req.url);
  const pathId = requestUrl.pathname.split("/").filter(Boolean).pop() || "";
  const paperId = requestUrl.searchParams.get("id") || pathId;
  if (!uuidPattern.test(paperId)) return errorResponse(404, "paper_not_found");

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: paper, error: paperError } = await supabase
    .from("papers")
    .select("pdf_path")
    .eq("id", paperId)
    .eq("status", "Published")
    .not("pdf_path", "is", null)
    .maybeSingle();

  if (paperError) {
    console.error("Published paper lookup failed", paperError);
    return errorResponse(502, "paper_lookup_failed");
  }
  if (!paper || !paper.pdf_path) return errorResponse(404, "paper_not_found");

  const { data: signed, error: signingError } = await supabase.storage
    .from("privc-papers")
    .createSignedUrl(paper.pdf_path, 60);
  if (signingError || !signed) {
    console.error("Published paper PDF signing failed", signingError);
    return errorResponse(502, "pdf_unavailable");
  }

  const upstreamHeaders = new Headers();
  const range = req.headers.get("range");
  if (range) upstreamHeaders.set("Range", range);

  let pdfResponse: Response;
  try {
    pdfResponse = await fetch(signed.signedUrl, {
      method: req.method,
      headers: upstreamHeaders,
    });
  } catch (error) {
    console.error("Published paper PDF fetch failed", error);
    return errorResponse(502, "pdf_unavailable");
  }
  if (!pdfResponse.ok && pdfResponse.status !== 206) {
    console.error("Published paper PDF storage returned", pdfResponse.status);
    return errorResponse(502, "pdf_unavailable");
  }

  const headers = new Headers({
    "Content-Type": "application/pdf",
    "Content-Disposition": `inline; filename="${paperId}.pdf"`,
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
  });
  for (const name of ["content-length", "content-range", "accept-ranges"]) {
    const value = pdfResponse.headers.get(name);
    if (value) headers.set(name, value);
  }

  return new Response(req.method === "HEAD" ? null : pdfResponse.body, {
    status: pdfResponse.status,
    headers,
  });
});
