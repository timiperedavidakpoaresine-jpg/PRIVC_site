import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const emailFrom = Deno.env.get("PAPER_STATUS_EMAIL_FROM") || "";
const workerSecret = Deno.env.get("PAPER_STATUS_EMAIL_SECRET") || "";

const batchSize = 25;
const retryDelayCapSeconds = 24 * 60 * 60;

type OutboxRow = {
  id: number;
  recipient_email: string | null;
  paper_title: string;
  old_status: string;
  new_status: string;
  attempt_count: number;
};

const statusMessages: Record<string, string> = {
  Submitted: "Thanks for submitting your paper. We have received it and it is now marked as submitted.",
  "In review": "Your paper is now in review. We will let you know when there is another update.",
  "Revisions requested": "We have reviewed your paper and would like you to make some revisions. Please sign in to see the feedback and next steps.",
  Published: "Your paper has been published. Congratulations, and thank you for sharing your work with us.",
  Rejected: "After careful consideration, we are unable to publish your paper. Thank you for submitting your work.",
};

function respond(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function retryAt(attemptCount: number) {
  const exponent = Math.min(Math.max(attemptCount - 1, 0), 20);
  const delaySeconds = Math.min(60 * 2 ** exponent, retryDelayCapSeconds);
  return new Date(Date.now() + delaySeconds * 1000).toISOString();
}

async function sendEmail(row: OutboxRow) {
  const message = statusMessages[row.new_status];
  const title = row.paper_title.replace(/\s+/g, " ").trim();
  const text = `Hello,\n\n${message}\n\nPaper: "${title}"\n\nBest,\nThe PRIVC team`;
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: emailFrom,
      to: [row.recipient_email],
      subject: `Update on your paper: ${row.new_status}`,
      text,
    }),
  });

  if (!response.ok) {
    const details = (await response.text()).slice(0, 2000);
    throw new Error(`Resend returned ${response.status}: ${details}`);
  }
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return respond({ error: "method_not_allowed" }, 405);

  if (!workerSecret) return respond({ error: "function_not_configured" }, 503);
  if (req.headers.get("x-paper-status-email-secret") !== workerSecret) {
    return respond({ error: "unauthorized" }, 401);
  }

  if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !emailFrom) {
    return respond({ error: "function_not_configured" }, 503);
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const now = new Date().toISOString();
  const { data: rows, error: fetchError } = await supabase
    .from("paper_status_email_outbox")
    .select("id,recipient_email,paper_title,old_status,new_status,attempt_count")
    .in("delivery_status", ["pending", "failed"])
    .lte("next_attempt_at", now)
    .order("created_at", { ascending: true })
    .limit(batchSize);

  if (fetchError) {
    return respond({ error: "outbox_fetch_failed" }, 500);
  }

  const result = { claimed: 0, sent: 0, failed: 0, skipped: 0 };

  for (const row of (rows || []) as OutboxRow[]) {
    const { data: claim, error: claimError } = await supabase
      .from("paper_status_email_outbox")
      .update({
        delivery_status: "sending",
        claimed_at: now,
        attempt_count: row.attempt_count + 1,
        last_error: null,
      })
      .eq("id", row.id)
      .in("delivery_status", ["pending", "failed"])
      .lte("next_attempt_at", now)
      .select("id")
      .maybeSingle();

    if (claimError) return respond({ error: "outbox_claim_failed" }, 500);
    if (!claim) continue;

    result.claimed++;

    if (!row.recipient_email?.trim()) {
      const { error } = await supabase
        .from("paper_status_email_outbox")
        .update({
          delivery_status: "skipped",
          claimed_at: null,
          last_error: "No recipient email address is available.",
        })
        .eq("id", row.id)
        .eq("delivery_status", "sending");
      if (error) return respond({ error: "outbox_update_failed" }, 500);
      result.skipped++;
      continue;
    }

    if (!statusMessages[row.new_status]) {
      const { error } = await supabase
        .from("paper_status_email_outbox")
        .update({
          delivery_status: "skipped",
          claimed_at: null,
          last_error: `Unsupported paper status: ${row.new_status}`,
        })
        .eq("id", row.id)
        .eq("delivery_status", "sending");
      if (error) return respond({ error: "outbox_update_failed" }, 500);
      result.skipped++;
      continue;
    }

    try {
      await sendEmail(row);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const { error: updateError } = await supabase
        .from("paper_status_email_outbox")
        .update({
          delivery_status: "failed",
          claimed_at: null,
          next_attempt_at: retryAt(row.attempt_count + 1),
          last_error: message.slice(0, 2000),
        })
        .eq("id", row.id)
        .eq("delivery_status", "sending");
      if (updateError) return respond({ error: "outbox_update_failed" }, 500);
      result.failed++;
      continue;
    }

    const { error: updateError } = await supabase
      .from("paper_status_email_outbox")
      .update({
        delivery_status: "sent",
        claimed_at: null,
        sent_at: new Date().toISOString(),
        last_error: null,
      })
      .eq("id", row.id)
      .eq("delivery_status", "sending");
    if (updateError) return respond({ error: "outbox_update_failed" }, 500);
    result.sent++;
  }

  return respond(result);
});
