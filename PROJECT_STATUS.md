# Project Status

## Migration files in order

1. [supabase/migrations/20261017090000_profiles.sql](supabase/migrations/20261017090000_profiles.sql) — Phase 1: profiles
2. [supabase/migrations/20261017110000_papers_review.sql](supabase/migrations/20261017110000_papers_review.sql) — Phase 2: paper review
3. [supabase/migrations/20261017130000_paper_feed.sql](supabase/migrations/20261017130000_paper_feed.sql) — Phase 3: public paper feed
4. [supabase/migrations/20261017150000_paper_engagement.sql](supabase/migrations/20261017150000_paper_engagement.sql) — Phase 4: engagement
5. [supabase/migrations/20261017170000_paper_reports.sql](supabase/migrations/20261017170000_paper_reports.sql) — Phase 5, part 1: reports
6. [supabase/migrations/20261018040000_moderation.sql](supabase/migrations/20261018040000_moderation.sql) — Phase 5, part 2: moderation / screening
7. [supabase/migrations/20261018050000_paper_status_email_outbox.sql](supabase/migrations/20261018050000_paper_status_email_outbox.sql) — Email Stage A
8. [supabase/migrations/20261023210000_profile_headline.sql](supabase/migrations/20261023210000_profile_headline.sql) — profile headline
9. [supabase/migrations/20261023220000_profile_avatar_storage.sql](supabase/migrations/20261023220000_profile_avatar_storage.sql) — profile avatar Storage

## Status by phase

### Phase 1 — profiles and accounts
- Built: Yes, the migration exists in [supabase/migrations/20261017090000_profiles.sql](supabase/migrations/20261017090000_profiles.sql). Supporting front-end/auth files are present in [auth.js](auth.js), [profiles.js](profiles.js), and the profile flows in [index.html](index.html).
- Profile headline migration prepared: [supabase/migrations/20261023210000_profile_headline.sql](supabase/migrations/20261023210000_profile_headline.sql); application status is unconfirmed. Avatar Storage setup is recorded in [supabase/migrations/20261023220000_profile_avatar_storage.sql](supabase/migrations/20261023220000_profile_avatar_storage.sql); the project owner reports that the bucket and policies are already applied in Supabase. The profile editor uploads JPEG/PNG/WebP photos to the user's folder in `profile-avatars`, resizes them to fit 512 × 512, and stores only validated bucket URLs. Replaced avatar objects are removed through the Storage API after the profile update.
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

### Phase 7 — post retention and Storage cleanup (planned only)
- Goal: automatically delete rows in `public.posts` and their post-image files 90 days after post creation. This job must operate only on `public.posts` and the post-images bucket; it must not query, delete, or otherwise modify `public.papers` or published articles. Posts with an open `public.post_reports` row are held until all reports are resolved or dismissed. Users can request deletion of their own posts subject to the same open-report hold.
- Current schema prerequisite: no posts, post-likes, post-comments, post-reports, or post-image bucket exists in current migrations. The Phase 7 migration must create these resources; the SQL proposal uses the exact names described here. Post images use one canonical Storage key per post (`<author-uuid>/<post-uuid>/image`) so there is one image slot per post.
- Post data model: `posts` stores `id`, `author_id`, `headline`, `body`, `image_path`, `created_at`, and an internal cleanup claim token/time. `post_likes` has one row per `(post_id,user_id)`. `post_comments` stores author, body, and timestamps. `post_reports` stores reporter, post, reason/note, status (`open`, `resolved`, `dismissed`), and resolution metadata.
- Limits: each post has at most one image path. The `post-images` bucket enforces 2 MiB maximum object size and JPEG, PNG, or WebP MIME types. The client must upload only the canonical `image` object key, with upsert disabled. Database checks cap headline/body/report text sizes.
- RLS: posts, likes, and comments are readable by authenticated users only (not `anon`). Signed-in active users can create posts, likes, comments, and open reports as themselves; owners can edit their post/comment content and remove their likes/comments. Direct post-row deletion is revoked. Reporters and moderators/admins can read reports; moderators/admins can resolve/dismiss them. `profiles.account_role` exists and is used for moderator/admin checks. Suspended users are blocked from writes via `public.privc_is_user_active`, which checks `profiles.suspended_at`.
- Rate limits: extend the existing Phase 5 rate-limit mechanism and `privc_rate_limit_buckets_activity_check`, preserving `comment`, `like`, and `report` values and adding `post`. Retain Phase 5 limits (10 comments/hour, 60 likes/hour, 5 reports/hour); use 5 posts/hour. Reuse `public.privc_check_active_and_rate_limit()` for the post tables.
- Retention worker: deploy `supabase/functions/post-retention/index.ts` using the service-role key only in function secrets. Run daily at 03:00 UTC (`0 3 * * *`) using Supabase Cron. Claim posts at or before `now() - interval '90 days'` only when no report is open. Claims older than one hour are reclaimable. Report creation locks the post and rejects a currently claimed post, preventing a report/cleanup race.
- For each claimed post, the function deletes its image through the Storage API and calls a guarded finalize RPC only after successful Storage removal. The RPC rechecks the claim and absence of open reports before deleting the row. Claims older than one hour are reclaimable. On Storage failure, release the claim for retry. Owner and moderator removal use the same claim → Storage delete → finalize sequence; owner removal is limited to their own post, while moderators/admins may remove any post. Both hold while a report remains open. Account deletion first claims all the user's posts, rejects deletion while an open report or active cleanup claim exists, removes each image through Storage, finalizes the post rows, and only then deletes the Auth user. An Auth deletion guard prevents deleting a user while their post rows remain.
- Audit: the actual Phase 5 checks are named `privc_audit_log_action_check` and `privc_audit_log_target_type_check`. Extend them while preserving every existing allowed value, adding `cleanup_posts` and `retention_run`. Write one run record with null actor, generated run UUID, and counts/details for candidates, successful deletions, failures, and skipped posts. Keep invocation secrets in Supabase Vault, not SQL source or browser code; configure failure alerting.
- Image limits do not cap total project Storage usage. Cost remains $0 on the Free plan while all stored files remain within the included 1 GB quota; estimate post-image peak as daily uploads × average image size × 90 days, plus profile photos and other buckets. Verify current plan limits before rollout.
- Status: design only; migration, Edge Function, and schedule are not implemented or applied.

## What is still missing

- Phases 1–5 migrations are confirmed applied by the project owner. Email Stage A application remains unconfirmed.
- No proof of successful deployment of the edge functions in Supabase for paper PDF, email, moderation, or other backend work.
- No real end-to-end validation for profiles, papers, feed, moderation, or email delivery.
- Phase 6a migration is prepared but unapplied; the remaining Phase 6 runtime implementation is not present.
- No environment/secrets configuration checklist has been completed for production deployment.
- No final rollout verification, QA checklist, or smoke tests are recorded in the project workspace.
