# Project Status

## Migration files in order

1. [supabase/migrations/20261017090000_profiles.sql](supabase/migrations/20261017090000_profiles.sql) — Phase 1: profiles
2. [supabase/migrations/20261017110000_papers_review.sql](supabase/migrations/20261017110000_papers_review.sql) — Phase 2: paper review
3. [supabase/migrations/20261017130000_paper_feed.sql](supabase/migrations/20261017130000_paper_feed.sql) — Phase 3: public paper feed
4. [supabase/migrations/20261017150000_paper_engagement.sql](supabase/migrations/20261017150000_paper_engagement.sql) — Phase 4: engagement
5. [supabase/migrations/20261017170000_paper_reports.sql](supabase/migrations/20261017170000_paper_reports.sql) — Phase 5, part 1: reports
6. [supabase/migrations/20261018040000_moderation.sql](supabase/migrations/20261018040000_moderation.sql) — Phase 5, part 2: moderation / screening
7. [supabase/migrations/20261018050000_paper_status_email_outbox.sql](supabase/migrations/20261018050000_paper_status_email_outbox.sql) — Email Stage A

## Status by phase

### Phase 1 — profiles and accounts
- Built: Yes, the migration exists in [supabase/migrations/20261017090000_profiles.sql](supabase/migrations/20261017090000_profiles.sql). Supporting front-end/auth files are present in [auth.js](auth.js), [profiles.js](profiles.js), and the profile flows in [index.html](index.html).
- Supabase applied: Yes, confirmed by the project owner.
- Not tested: real sign-up, email confirmation, profile creation, role assignment, public profile URL behavior, and auth callback flow.

### Phase 2 — paper submission and review
- Built: Yes, the migration exists in [supabase/migrations/20261017110000_papers_review.sql](supabase/migrations/20261017110000_papers_review.sql), and the PDF function exists at [supabase/functions/paper-pdf/index.ts](supabase/functions/paper-pdf/index.ts). The UI is in [papers.js](papers.js) and [index.html](index.html).
- Supabase applied: Yes, confirmed by the project owner.
- Not tested: Draft save, PDF upload limits, submission flow, reviewer assignment, review statuses, revision requests, publish/reject transitions, and signed PDF expiry.

### Phase 3 — paper feed, search, and public pages
- Built: Yes, the migration exists in [supabase/migrations/20261017130000_paper_feed.sql](supabase/migrations/20261017130000_paper_feed.sql). The public feed and paper page logic is reflected in [papers.js](papers.js) and [index.html](index.html).
- Supabase applied: Yes, confirmed by the project owner.
- Not tested: public feed rendering, search, pagination, direct paper links, view counting, author profile linking, and published-only visibility.

### Phase 4 — engagement and notifications
- Built: Yes, the migration exists in [supabase/migrations/20261017150000_paper_engagement.sql](supabase/migrations/20261017150000_paper_engagement.sql).
- Supabase applied: Yes, confirmed by the project owner.
- Not tested: follows, bookmarks, notifications, feed engagement actions, and permission checks.

### Phase 5 — reports and moderation
- Built: Yes, the migration set exists in [supabase/migrations/20261017170000_paper_reports.sql](supabase/migrations/20261017170000_paper_reports.sql) and [supabase/migrations/20261018040000_moderation.sql](supabase/migrations/20261018040000_moderation.sql).
- Supabase applied: Yes, confirmed by the project owner; the moderation migration's safety check passed.
- Not tested: abuse report submission, moderator review flow, suspensions, rate limiting, audit logging, and screening actions.

### Email Stage A — paper status email outbox
- Built: Yes, the migration exists in [supabase/migrations/20261018050000_paper_status_email_outbox.sql](supabase/migrations/20261018050000_paper_status_email_outbox.sql), and the worker exists in [supabase/functions/paper-status-email/index.ts](supabase/functions/paper-status-email/index.ts).
- Supabase applied: Unknown; not confirmed from the repo alone.
- Not tested: trigger firing on status changes, outbox row creation, retry scheduling, Resend delivery, failed-send handling, invalid-email skips, and end-to-end email receipt.

### Screening Stage B — moderation / screening flow
- Built: Yes, the screening logic is represented by [supabase/migrations/20261018040000_moderation.sql](supabase/migrations/20261018040000_moderation.sql). In practice this is the Stage B screening layer associated with Phase 5.
- Supabase applied: Yes, confirmed by the project owner; the migration's safety check passed.
- Not tested: screening actions, suspension enforcement, audit trail integrity, and rate-limit behavior.

### Phase 6
- Step 6a migration prepared: [supabase/migrations/20261019040000_phase6a_publication_metadata.sql](supabase/migrations/20261019040000_phase6a_publication_metadata.sql). It adds ordered paper authors, DOI and "Also available on" metadata, and admin-only editing controls.
- Supabase applied: No; the migration has not been run.
- Hosting decision: Vercel is the assumed website host. Server-rendered public paper HTML pages will be served by a Vercel function; feeds, sitemap, the read-only API and OAI-PMH may be served by Supabase Edge Functions.
- Required visibility behavior: every public page and catalogue endpoint must check current publication status and exclude a paper as soon as it is no longer Published.
- Not tested: Step 6a has not been applied or validated against the live database; no Phase 6 runtime implementation has been built.

## What is still missing

- Phases 1–5 migrations are confirmed applied by the project owner. Email Stage A application remains unconfirmed.
- No proof of successful deployment of the edge functions in Supabase for paper PDF, email, moderation, or other backend work.
- No real end-to-end validation for profiles, papers, feed, moderation, or email delivery.
- Phase 6a migration is prepared but unapplied; the remaining Phase 6 runtime implementation is not present.
- No environment/secrets configuration checklist has been completed for production deployment.
- No final rollout verification, QA checklist, or smoke tests are recorded in the project workspace.
