-- Phase 5, part 1: paper and comment abuse reports.
-- Additive only. Review before applying; this migration is not run automatically.

do $preflight$
declare
  required_column record;
begin
  for required_column in
    select * from (values
      ('public', 'papers', 'id'),
      ('public', 'paper_comments', 'id'),
      ('public', 'profiles', 'id'),
      ('public', 'profiles', 'account_role'),
      ('auth', 'users', 'id')
    ) as required_columns(schema_name, table_name, column_name)
  loop
    if not exists (
      select 1
      from information_schema.columns
      where table_schema = required_column.schema_name
        and table_name = required_column.table_name
        and column_name = required_column.column_name
    ) then
      raise exception 'Required column %.%.% does not exist; inspect the schema before applying this migration.',
        required_column.schema_name,
        required_column.table_name,
        required_column.column_name;
    end if;
  end loop;

  if to_regprocedure('public.privc_is_paper_reviewer()') is null then
    raise exception 'Required function public.privc_is_paper_reviewer() does not exist; apply or inspect the paper review migration first.';
  end if;
end
$preflight$;

create table if not exists public.paper_reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null references auth.users(id),
  target_type text not null check (target_type in ('paper', 'comment')),
  paper_id uuid references public.papers(id),
  comment_id uuid references public.paper_comments(id),
  reason text not null check (reason in ('spam', 'abuse', 'plagiarism', 'other')),
  note text check (note is null or char_length(note) <= 2000),
  status text not null default 'open'
    check (status in ('open', 'resolved', 'dismissed')),
  resolution_note text check (resolution_note is null or char_length(resolution_note) <= 500),
  resolved_by uuid references auth.users(id) on delete set null,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  constraint paper_reports_target_matches check (
    (target_type = 'paper' and paper_id is not null and comment_id is null)
    or (target_type = 'comment' and comment_id is not null and paper_id is null)
  ),
  constraint paper_reports_resolution_matches_status check (
    (status = 'open' and resolved_by is null and resolved_at is null)
    or (status in ('resolved', 'dismissed') and resolved_by is not null and resolved_at is not null)
  )
);
alter table public.paper_reports enable row level security;

create unique index if not exists paper_reports_reporter_paper_uidx
  on public.paper_reports (reporter_id, paper_id)
  where paper_id is not null;
create unique index if not exists paper_reports_reporter_comment_uidx
  on public.paper_reports (reporter_id, comment_id)
  where comment_id is not null;
create index if not exists paper_reports_reporter_created_idx
  on public.paper_reports (reporter_id, created_at desc);
create index if not exists paper_reports_status_created_idx
  on public.paper_reports (status, created_at desc);

revoke all on table public.paper_reports from public, anon, authenticated;
grant select on table public.paper_reports to authenticated;
grant insert (reporter_id, target_type, paper_id, comment_id, reason, note)
  on table public.paper_reports to authenticated;
grant update (status, resolution_note, resolved_by, resolved_at)
  on table public.paper_reports to authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_reports'
      and policyname = 'privc_paper_reports_select_own_or_reviewer'
  ) then
    create policy privc_paper_reports_select_own_or_reviewer
      on public.paper_reports for select to authenticated
      using (
        reporter_id = (select auth.uid())
        or (select public.privc_is_paper_reviewer())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_reports'
      and policyname = 'privc_paper_reports_insert_own_open'
  ) then
    create policy privc_paper_reports_insert_own_open
      on public.paper_reports for insert to authenticated
      with check (
        reporter_id = (select auth.uid())
        and status = 'open'
        and resolved_by is null
        and resolved_at is null
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_reports'
      and policyname = 'privc_paper_reports_update_reviewer'
  ) then
    create policy privc_paper_reports_update_reviewer
      on public.paper_reports for update to authenticated
      using ((select public.privc_is_paper_reviewer()))
      with check (
        (select public.privc_is_paper_reviewer())
        and status in ('resolved', 'dismissed')
        and resolved_by = (select auth.uid())
        and resolved_at is not null
      );
  end if;
end
$migration$;
