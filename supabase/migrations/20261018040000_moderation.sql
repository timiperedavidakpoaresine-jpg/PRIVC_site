-- Phase 5, part 2: suspensions, database rate limits, and audit log.
-- Additive only. Review before applying; this migration is not run automatically.

do $preflight$
declare
  required_column record;
begin
  for required_column in
    select * from (values
      ('public', 'profiles', 'id'),
      ('public', 'profiles', 'account_role'),
      ('public', 'papers', 'id'),
      ('public', 'papers', 'author_id'),
      ('public', 'papers', 'status'),
      ('public', 'papers', 'reviewed_by'),
      ('public', 'paper_likes', 'user_id'),
      ('public', 'paper_comments', 'user_id'),
      ('public', 'profile_follows', 'follower_id'),
      ('public', 'paper_bookmarks', 'user_id'),
      ('public', 'paper_reports', 'id'),
      ('public', 'paper_reports', 'status'),
      ('public', 'paper_reports', 'resolved_by'),
      ('public', 'paper_reports', 'resolution_note'),
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
      raise exception
        'Required column %.%.% does not exist; inspect the schema before applying this migration.',
        required_column.schema_name,
        required_column.table_name,
        required_column.column_name;
    end if;
  end loop;

  if to_regprocedure('auth.uid()') is null then
    raise exception 'Required function auth.uid() does not exist.';
  end if;

  if to_regprocedure('public.privc_is_paper_reviewer()') is null then
    raise exception
      'Required function public.privc_is_paper_reviewer() does not exist; inspect the paper review migration first.';
  end if;
end
$preflight$;

alter table public.profiles
  add column if not exists suspended_at timestamptz,
  add column if not exists suspended_reason text;

-- These columns are not granted to users. Admin access is provided by the RPCs below.
revoke select (suspended_at, suspended_reason),
  insert (suspended_at, suspended_reason),
  update (suspended_at, suspended_reason)
  on table public.profiles from public, anon, authenticated;

create function public.privc_is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles
    where id = (select auth.uid())
      and account_role = 'admin'
  )
$function$;
revoke all on function public.privc_is_admin() from public, anon;
grant execute on function public.privc_is_admin() to authenticated;

create function public.privc_is_user_active(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.profiles
    where id = p_user_id
      and suspended_at is null
  )
$function$;
revoke all on function public.privc_is_user_active(uuid) from public, anon, authenticated;

create table public.privc_rate_limit_buckets (
  user_id uuid not null references auth.users(id) on delete cascade,
  activity text not null check (activity in ('comment', 'like', 'report')),
  bucket_slot smallint not null check (bucket_slot between 0 and 60),
  bucket_start timestamptz not null,
  event_count integer not null check (event_count > 0),
  primary key (user_id, activity, bucket_slot)
);
alter table public.privc_rate_limit_buckets enable row level security;

revoke all on table public.privc_rate_limit_buckets
  from public, anon, authenticated, service_role;

create function public.privc_check_active_and_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  actor_id uuid;
  activity_name text;
  activity_limit integer;
  activity_count bigint;
  current_bucket timestamptz;
  current_slot smallint;
begin
  if tg_op = 'UPDATE' then
    actor_id := new.user_id;
    if not public.privc_is_user_active(actor_id) then
      raise exception 'This account is suspended and cannot modify comments.'
        using errcode = '42501';
    end if;
    return new;
  end if;

  case tg_table_name
    when 'paper_likes' then
      actor_id := new.user_id;
      activity_name := 'like';
      activity_limit := 60;
    when 'paper_comments' then
      actor_id := new.user_id;
      activity_name := 'comment';
      activity_limit := 10;
    when 'paper_reports' then
      actor_id := new.reporter_id;
      activity_name := 'report';
      activity_limit := 5;
    when 'paper_bookmarks' then
      actor_id := new.user_id;
    when 'profile_follows' then
      actor_id := new.follower_id;
    else
      raise exception 'Unsupported activity table: %.', tg_table_name;
  end case;

  if not public.privc_is_user_active(actor_id) then
    raise exception 'This account is suspended and cannot perform this action.'
      using errcode = '42501';
  end if;

  if activity_name is null then
    return new;
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtext(actor_id::text),
    pg_catalog.hashtext(activity_name)
  );

  current_bucket := pg_catalog.date_trunc('minute', pg_catalog.now());
  current_slot :=
    (floor(extract(epoch from current_bucket) / 60)::bigint % 61)::smallint;

  select coalesce(sum(event_count), 0)
    into activity_count
  from public.privc_rate_limit_buckets
  where user_id = actor_id
    and activity = activity_name
    and bucket_start >= pg_catalog.date_trunc(
      'minute', pg_catalog.now() - interval '1 hour'
    );

  if activity_count >= activity_limit then
    raise exception 'Hourly % limit reached (% per hour).',
      activity_name, activity_limit
      using errcode = 'P0001';
  end if;

  insert into public.privc_rate_limit_buckets as bucket
    (user_id, activity, bucket_slot, bucket_start, event_count)
  values
    (actor_id, activity_name, current_slot, current_bucket, 1)
  on conflict (user_id, activity, bucket_slot) do update
    set bucket_start = excluded.bucket_start,
        event_count = case
          when bucket.bucket_start = excluded.bucket_start
            then bucket.event_count + 1
          else 1
        end;

  return new;
end
$function$;
revoke all on function public.privc_check_active_and_rate_limit()
  from public, anon, authenticated, service_role;

create function public.privc_require_active_paper_submission()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if new.status = 'Submitted'
     and not public.privc_is_user_active(new.author_id) then
    raise exception 'This account is suspended and cannot submit papers.'
      using errcode = '42501';
  end if;
  return new;
end
$function$;
revoke all on function public.privc_require_active_paper_submission()
  from public, anon, authenticated, service_role;

do $migration$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_likes'::regclass
      and tgname = 'privc_check_active_and_rate_limit'
      and not tgisinternal
  ) then
    create trigger privc_check_active_and_rate_limit
      before insert on public.paper_likes
      for each row execute function public.privc_check_active_and_rate_limit();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_comments'::regclass
      and tgname = 'privc_check_active_and_rate_limit'
      and not tgisinternal
  ) then
    create trigger privc_check_active_and_rate_limit
      before insert or update on public.paper_comments
      for each row execute function public.privc_check_active_and_rate_limit();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_bookmarks'::regclass
      and tgname = 'privc_check_active_and_rate_limit'
      and not tgisinternal
  ) then
    create trigger privc_check_active_and_rate_limit
      before insert on public.paper_bookmarks
      for each row execute function public.privc_check_active_and_rate_limit();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.profile_follows'::regclass
      and tgname = 'privc_check_active_and_rate_limit'
      and not tgisinternal
  ) then
    create trigger privc_check_active_and_rate_limit
      before insert on public.profile_follows
      for each row execute function public.privc_check_active_and_rate_limit();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_reports'::regclass
      and tgname = 'privc_check_active_and_rate_limit'
      and not tgisinternal
  ) then
    create trigger privc_check_active_and_rate_limit
      before insert on public.paper_reports
      for each row execute function public.privc_check_active_and_rate_limit();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.papers'::regclass
      and tgname = 'privc_require_active_paper_submission'
      and not tgisinternal
  ) then
    create trigger privc_require_active_paper_submission
      before insert or update of status on public.papers
      for each row execute function public.privc_require_active_paper_submission();
  end if;
end
$migration$;

create table public.privc_audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  action text not null check (
    action in (
      'suspend_user', 'unsuspend_user',
      'resolve_report', 'dismiss_report',
      'publish_paper', 'reject_paper'
    )
  ),
  target_type text not null check (
    target_type in ('profile', 'paper_report', 'paper')
  ),
  target_id uuid not null,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default pg_catalog.now()
);
alter table public.privc_audit_log enable row level security;

revoke all on table public.privc_audit_log
  from public, anon, authenticated, service_role;
grant select on table public.privc_audit_log to authenticated;

create policy privc_audit_log_select_admin
  on public.privc_audit_log for select to authenticated
  using ((select public.privc_is_admin()));

create index privc_audit_log_created_idx
  on public.privc_audit_log (created_at desc);
create index privc_audit_log_target_idx
  on public.privc_audit_log (target_type, target_id, created_at desc);

create function public.privc_admin_list_user_suspensions()
returns table (
  user_id uuid,
  username text,
  display_name text,
  suspended_at timestamptz,
  suspended_reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.privc_is_admin() then
    raise exception 'Admin access is required.' using errcode = '42501';
  end if;

  return query
  select p.id, p.username, p.display_name, p.suspended_at, p.suspended_reason
  from public.profiles as p
  order by p.username;
end
$function$;
revoke all on function public.privc_admin_list_user_suspensions()
  from public, anon;
grant execute on function public.privc_admin_list_user_suspensions()
  to authenticated;

create function public.privc_admin_set_user_suspension(
  p_user_id uuid,
  p_suspended boolean,
  p_reason text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_suspended_at timestamptz;
  clean_reason text := nullif(pg_catalog.btrim(p_reason), '');
begin
  if not public.privc_is_admin() then
    raise exception 'Admin access is required.' using errcode = '42501';
  end if;
  if auth.uid() is null then
    raise exception 'Sign in is required.' using errcode = '42501';
  end if;
  if p_user_id is null or p_suspended is null then
    raise exception 'A user and suspension state are required.'
      using errcode = '22023';
  end if;
  if p_suspended and p_user_id = auth.uid() then
    raise exception 'You cannot suspend your own account.'
      using errcode = '42501';
  end if;
  if p_suspended and (
    clean_reason is null or pg_catalog.char_length(clean_reason) > 1000
  ) then
    raise exception 'Provide a suspension reason of at most 1000 characters.'
      using errcode = '22023';
  end if;

  select suspended_at into current_suspended_at
  from public.profiles
  where id = p_user_id
  for update;

  if not found then
    raise exception 'User profile not found.' using errcode = 'P0002';
  end if;

  if p_suspended and current_suspended_at is null then
    update public.profiles
    set suspended_at = pg_catalog.now(),
        suspended_reason = clean_reason
    where id = p_user_id;

    insert into public.privc_audit_log
      (actor_id, action, target_type, target_id, details)
    values
      (auth.uid(), 'suspend_user', 'profile', p_user_id,
       pg_catalog.jsonb_build_object('reason', clean_reason));
  elsif not p_suspended and current_suspended_at is not null then
    update public.profiles
    set suspended_at = null,
        suspended_reason = null
    where id = p_user_id;

    insert into public.privc_audit_log
      (actor_id, action, target_type, target_id)
    values
      (auth.uid(), 'unsuspend_user', 'profile', p_user_id);
  end if;
end
$function$;
revoke all on function public.privc_admin_set_user_suspension(uuid, boolean, text)
  from public, anon;
grant execute on function public.privc_admin_set_user_suspension(uuid, boolean, text)
  to authenticated;

create function public.privc_audit_report_resolution()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status = 'open'
     and new.status in ('resolved', 'dismissed')
     and new.resolved_by = (select auth.uid())
     and (select public.privc_is_paper_reviewer()) then
    insert into public.privc_audit_log
      (actor_id, action, target_type, target_id, details)
    values
      (
        new.resolved_by,
        case new.status
          when 'resolved' then 'resolve_report'
          else 'dismiss_report'
        end,
        'paper_report',
        new.id,
        pg_catalog.jsonb_build_object(
          'resolution_note', new.resolution_note
        )
      );
  end if;

  return new;
end
$function$;
revoke all on function public.privc_audit_report_resolution()
  from public, anon, authenticated, service_role;

create function public.privc_audit_paper_review()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if old.status is distinct from new.status
     and new.status in ('Published', 'Rejected')
     and new.reviewed_by = (select auth.uid())
     and (select public.privc_is_paper_reviewer()) then
    insert into public.privc_audit_log
      (actor_id, action, target_type, target_id, details)
    values
      (
        new.reviewed_by,
        case new.status
          when 'Published' then 'publish_paper'
          else 'reject_paper'
        end,
        'paper',
        new.id,
        pg_catalog.jsonb_build_object('status', new.status)
      );
  end if;

  return new;
end
$function$;
revoke all on function public.privc_audit_paper_review()
  from public, anon, authenticated, service_role;

do $migration$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_reports'::regclass
      and tgname = 'privc_audit_report_resolution'
      and not tgisinternal
  ) then
    create trigger privc_audit_report_resolution
      after update of status on public.paper_reports
    for each row execute function public.privc_audit_report_resolution();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.papers'::regclass
      and tgname = 'privc_audit_paper_review'
      and not tgisinternal
  ) then
    create trigger privc_audit_paper_review
      after update of status on public.papers
    for each row execute function public.privc_audit_paper_review();
  end if;
end
$migration$;
