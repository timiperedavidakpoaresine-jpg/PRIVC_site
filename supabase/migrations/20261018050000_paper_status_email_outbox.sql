-- Phase 5, Stage A: paper status email outbox.
-- Additive only. Review before applying; this migration is not run automatically.

do $preflight$
declare
  required_column record;
begin
  for required_column in
    select * from (values
      ('public', 'papers', 'id'),
      ('public', 'papers', 'author_id'),
      ('public', 'papers', 'title'),
      ('public', 'papers', 'status'),
      ('auth', 'users', 'id'),
      ('auth', 'users', 'email')
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
end
$preflight$;

create table public.paper_status_email_outbox (
  id bigint generated always as identity primary key,
  paper_id uuid references public.papers(id) on delete cascade,
  author_id uuid references auth.users(id) on delete cascade,
  recipient_email text,
  paper_title text not null,
  old_status text not null,
  new_status text not null,
  delivery_status text not null default 'pending'
    check (delivery_status in ('pending', 'sending', 'sent', 'failed', 'skipped')),
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default pg_catalog.now(),
  claimed_at timestamptz,
  sent_at timestamptz,
  last_error text,
  created_at timestamptz not null default pg_catalog.now()
);
alter table public.paper_status_email_outbox enable row level security;

revoke all on table public.paper_status_email_outbox
  from public, anon, authenticated;
grant select, update on table public.paper_status_email_outbox
  to service_role;

create index paper_status_email_outbox_pending_idx
  on public.paper_status_email_outbox (next_attempt_at, created_at)
  where delivery_status in ('pending', 'failed');

create index paper_status_email_outbox_claimed_idx
  on public.paper_status_email_outbox (claimed_at)
  where delivery_status = 'sending';

create function public.privc_enqueue_paper_status_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  account_email text;
  previous_status text;
begin
  if tg_op = 'INSERT' then
    previous_status := 'Draft';
  else
    if old.status is not distinct from new.status then
      return new;
    end if;
    previous_status := old.status;
  end if;

  select nullif(pg_catalog.btrim(u.email), '')
    into account_email
  from auth.users as u
  where u.id = new.author_id;

  insert into public.paper_status_email_outbox (
    paper_id,
    author_id,
    recipient_email,
    paper_title,
    old_status,
    new_status,
    delivery_status,
    last_error
  )
  values (
    new.id,
    new.author_id,
    account_email,
    coalesce(new.title, '[Untitled paper]'),
    coalesce(previous_status, 'Unknown'),
    coalesce(new.status, 'Unknown'),
    case when account_email is null then 'skipped' else 'pending' end,
    case
      when account_email is null then 'No email address is present on the author account.'
      else null
    end
  );

  return new;
end
$function$;
revoke all on function public.privc_enqueue_paper_status_email()
  from public, anon, authenticated, service_role;

do $migration$
begin
  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.papers'::regclass
      and tgname = 'privc_enqueue_paper_status_email'
      and not tgisinternal
  ) then
    create trigger privc_enqueue_paper_status_email
      after update of status on public.papers
      for each row execute function public.privc_enqueue_paper_status_email();
  end if;

  if not exists (
    select 1
    from pg_trigger
    where tgrelid = 'public.papers'::regclass
      and tgname = 'privc_enqueue_initial_paper_status_email'
      and not tgisinternal
  ) then
    create trigger privc_enqueue_initial_paper_status_email
      after insert on public.papers
      for each row
      when (new.status is distinct from 'Draft')
      execute function public.privc_enqueue_paper_status_email();
  end if;
end
$migration$;
