import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
const resendApiKey = Deno.env.get("RESEND_API_KEY") || "";
const emailFrom = Deno.env.get("PAPER_STATUS_EMAIL_FROM") || "";
const workerSecret = Deno.env.get("PAPER_STATUS_EMAIL_SECRET") || "";
const siteUrl = Deno.env.get("SITE_URL") || "";

const batchSize = 25;
const retryDelayCapSeconds = 24 * 60 * 60;

type OutboxRow = {
  id: number;
  paper_id: string | null;
  author_id: string | null;
  recipient_email: string | null;
  paper_title: string;
  old_status: string;
  new_status: string;
  attempt_count: number;
};

const supportedStatuses = new Set([
  "Submitted",
  "In review",
  "Revisions requested",
  "Published",
  "Rejected",
]);

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

function sanitizeAuthorName(value: unknown) {
  return typeof value === "string"
    ? value
      .replace(/[\u0000-\u001f\u007f-\u009f\u2028-\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, 100)
    : "";
}

function sanitizeReviewerFeedback(value: string) {
  const feedback = value
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0009\u000b-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/ {2,}/g, " ")
    .slice(0, 2000);
  return feedback.trim() ? feedback : "";
}

function sanitizePaperTitle(value: string) {
  return value
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ")
    .trim();
}

async function buildEmailText(row: OutboxRow, supabase: ReturnType<typeof createClient>) {
  const title = sanitizePaperTitle(row.paper_title);
  let authorName = "";
  let reviewerFeedback = "";

  if (row.author_id) {
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("display_name,username")
        .eq("id", row.author_id)
        .maybeSingle();

      if (error) {
        console.error(`Could not fetch author profile: ${error.message}`);
      } else if (data) {
        authorName = sanitizeAuthorName(data.display_name) || sanitizeAuthorName(data.username);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Could not fetch author profile: ${message}`);
    }
  }
  authorName ||= "Author";

  if (row.new_status === "Rejected" || row.new_status === "Revisions requested") {
    if (!row.paper_id) {
      throw new Error("Paper ID is unavailable for reviewer feedback lookup.");
    }

    const { data, error } = await supabase
      .from("papers")
      .select("review_feedback")
      .eq("id", row.paper_id)
      .maybeSingle();

    if (error) {
      throw new Error(`Could not fetch reviewer feedback: ${error.message}`);
    }
    if (!data) {
      throw new Error("Paper was not found while fetching reviewer feedback.");
    }

    reviewerFeedback = typeof data.review_feedback === "string"
      ? sanitizeReviewerFeedback(data.review_feedback)
      : "";
  }

  switch (row.new_status) {
    case "Submitted":
      return `Dear ${authorName},

Thank you for submitting "${title}" to PRIVC Atlas. The status "Submitted" confirms that we have received your manuscript and recorded it for editorial processing. It has not yet entered review.

Next, our editorial team will check that the submission is complete and suitable for assessment. We will contact you if more information is needed or when the paper advances to review. No action is required from you at this stage.

With thanks,
The PRIVC Atlas Editorial Team`;
    case "In review":
      return `Dear ${authorName},

Thank you for your submission, "${title}". The status "In review" means the manuscript has passed initial processing and is now being assessed by reviewers and the editorial team. No publication decision has been made.

The review will continue, and we will contact you when an outcome is available or if the team needs information or action from you. You do not need to send another copy unless requested. We appreciate your patience.

With thanks,
The PRIVC Atlas Editorial Team`;
    case "Revisions requested":
      return `Dear ${authorName},

Thank you for submitting "${title}" to PRIVC Atlas. The status "Revisions requested" means changes are needed before assessment can continue; this is not a final publication decision.

Please use the reviewer feedback below to prepare a revised manuscript and a response explaining how you addressed each point. Submit both through the submission portal; the editorial team will resume assessment once they arrive. Contact us if you need clarification.

Reviewer feedback:
${reviewerFeedback || "No written reviewer feedback was provided. Please contact us if you would like clarification."}

With thanks,
The PRIVC Atlas Editorial Team`;
    case "Published": {
      const publicationUrl = siteUrl.trim() && row.paper_id
        ? `${siteUrl.trim().replace(/\/+$/, "")}/papers/${encodeURIComponent(row.paper_id)}`
        : "";
      return `Dear ${authorName},

We are pleased to inform you that "${title}" has been published in PRIVC Atlas. The status "Published" means the manuscript has completed editorial assessment and is now part of our scholarly collection.

You are welcome to share the publication with colleagues. No further action is required. Please check the publication record and contact us if you notice an error. Thank you for contributing your work.${publicationUrl ? `\n\nPaper link: ${publicationUrl}` : ""}

With thanks,
The PRIVC Atlas Editorial Team`;
    }
    case "Rejected":
      return `Dear ${authorName},

Thank you for submitting "${title}" to PRIVC Atlas. The status "Rejected" means the editorial team has completed its assessment and will not publish this version. We understand this may be disappointing and appreciate your effort.

Common reasons include concerns about scope, originality, data quality, or engagement with relevant literature; these may not apply to your paper. You may submit improved work for future consideration. Please review the feedback below and contact us if you have questions.

Reviewer feedback:
${reviewerFeedback || "No written reviewer feedback was provided. Please contact us if you would like clarification."}

With thanks,
The PRIVC Atlas Editorial Team`;
    default:
      throw new Error(`Unsupported paper status: ${row.new_status}`);
  }
}

async function sendEmail(row: OutboxRow, supabase: ReturnType<typeof createClient>) {
  const text = await buildEmailText(row, supabase);
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "Idempotency-Key": `paper-status-${row.id}`,
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
  const staleSendingCutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();

  const { error: recoverError } = await supabase
    .from("paper_status_email_outbox")
    .update({
      delivery_status: "failed",
      claimed_at: null,
      next_attempt_at: now,
      last_error: "Claim expired; retry available again.",
    })
    .eq("delivery_status", "sending")
    .lt("claimed_at", staleSendingCutoff);

  if (recoverError) {
    return respond({ error: "outbox_recovery_failed" }, 500);
  }

  const { data: rows, error: fetchError } = await supabase
    .from("paper_status_email_outbox")
    .select("id,paper_id,author_id,recipient_email,paper_title,old_status,new_status,attempt_count")
    .in("delivery_status", ["pending", "failed"])
    .lt("attempt_count", 5)
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

    if (!supportedStatuses.has(row.new_status)) {
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
      await sendEmail(row, supabase);
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
