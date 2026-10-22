-- Phase 6a: ordered paper authors and admin-managed publication metadata.
-- Additive only. Review before applying; this migration is not run automatically.

do $preflight$
begin
  if to_regclass('public.papers') is null then
    raise exception 'Phase 6a requires public.papers; apply the earlier paper migrations first.';
  end if;
  if to_regclass('public.profiles') is null then
    raise exception 'Phase 6a requires public.profiles; apply the profiles migration first.';
  end if;
  if to_regprocedure('public.privc_is_admin()') is null then
    raise exception 'Phase 6a requires public.privc_is_admin(); apply the moderation migration first.';
  end if;
end
$preflight$;

alter table public.papers
  add column if not exists doi text,
  add column if not exists also_available_on text;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.papers'::regclass
      and conname = 'papers_doi_format'
  ) then
    alter table public.papers
      add constraint papers_doi_format
      check (doi is null or doi ~ '^10[.][0-9]{4,9}/[^[:space:]]+$');
  end if;

  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.papers'::regclass
      and conname = 'papers_also_available_on_url'
  ) then
    alter table public.papers
      add constraint papers_also_available_on_url
      check (
        also_available_on is null
        or also_available_on ~* '^https?://[^[:space:]]+$'
      );
  end if;
end
$migration$;

create table if not exists public.paper_authors (
  paper_id uuid not null references public.papers(id) on delete cascade,
  author_id uuid not null,
  author_order smallint not null check (author_order > 0),
  created_at timestamptz not null default now(),
  constraint paper_authors_paper_order_unique unique (paper_id, author_order),
  constraint paper_authors_paper_author_unique unique (paper_id, author_id)
);

create index if not exists paper_authors_author_paper_idx
  on public.paper_authors (author_id, paper_id);

create or replace function public.privc_add_primary_paper_author()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  insert into public.paper_authors (paper_id, author_id, author_order)
  values (new.id, new.author_id, 1)
  on conflict do nothing;

  return new;
end
$function$;

revoke all on function public.privc_add_primary_paper_author()
  from public, anon, authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.papers'::regclass
      and tgname = 'privc_add_primary_paper_author'
      and not tgisinternal
  ) then
    create trigger privc_add_primary_paper_author
      after insert on public.papers
      for each row execute function public.privc_add_primary_paper_author();
  end if;
end
$migration$;

-- Preserve the current single author as the first listed author.
insert into public.paper_authors (paper_id, author_id, author_order)
select id, author_id, 1
from public.papers
on conflict (paper_id, author_order) do nothing;

alter table public.paper_authors enable row level security;
revoke all on table public.paper_authors from public, anon, authenticated;
grant select on table public.paper_authors to anon, authenticated;
grant insert, update, delete on table public.paper_authors to authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_authors'
      and policyname = 'paper_authors_read_published_or_admin'
  ) then
    create policy paper_authors_read_published_or_admin
      on public.paper_authors for select to anon, authenticated
      using (
        exists (
          select 1
          from public.papers p
          where p.id = paper_authors.paper_id
            and p.status = 'Published'
        )
        or (select public.privc_is_admin())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_authors'
      and policyname = 'paper_authors_admin_manage'
  ) then
    create policy paper_authors_admin_manage
      on public.paper_authors for all to authenticated
      using ((select public.privc_is_admin()))
      with check ((select public.privc_is_admin()));
  end if;
end
$migration$;

grant select (doi, also_available_on)
  on table public.papers to anon, authenticated;

-- Retain the existing author's editable columns, but ensure the new publication
-- metadata can only be changed through the admin-checked function below.
revoke update on table public.papers from public, anon, authenticated;
revoke update (doi, also_available_on)
  on table public.papers from public, anon, authenticated;
grant update (title, abstract, keywords, pdf_path, publication_year)
  on table public.papers to authenticated;

create or replace function public.privc_admin_set_paper_publication_metadata(
  p_paper_id uuid,
  p_doi text,
  p_also_available_on text
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if not public.privc_is_admin() then
    raise exception 'Administrator access is required.'
      using errcode = '42501';
  end if;

  update public.papers
  set doi = nullif(btrim(p_doi), ''),
      also_available_on = nullif(btrim(p_also_available_on), '')
  where id = p_paper_id;

  if not found then
    raise exception 'Paper not found.' using errcode = 'P0002';
  end if;
end
$function$;

revoke all on function public.privc_admin_set_paper_publication_metadata(uuid, text, text)
  from public, anon;
grant execute on function public.privc_admin_set_paper_publication_metadata(uuid, text, text)
  to authenticated;
