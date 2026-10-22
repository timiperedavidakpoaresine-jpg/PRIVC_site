-- Phase 2: private paper submissions and an authenticated review workflow.
-- Additive migration. It does not remove or replace existing tables or policies.

do $preflight$
declare
  required_column text;
begin
  if to_regclass('public.papers') is not null then
    foreach required_column in array array[
      'id', 'author_id', 'title', 'abstract', 'keywords', 'status', 'pdf_path',
      'review_feedback', 'submitted_at', 'reviewed_at', 'reviewed_by',
      'published_at', 'created_at', 'updated_at'
    ] loop
      if not exists (
        select 1 from information_schema.columns
        where table_schema = 'public'
          and table_name = 'papers'
          and column_name = required_column
      ) then
        raise exception 'Existing public.papers table is missing column "%"; inspect it and adapt this migration before applying.',
          required_column;
      end if;
    end loop;
    if not exists (
      select 1
      from pg_constraint
      where conrelid = 'public.papers'::regclass
        and conname = 'papers_pdf_path_owner'
        and contype = 'c'
    ) then
      raise exception 'Existing public.papers table is not the Phase 2 table; inspect it and adapt this migration before applying.';
    end if;
  end if;
end
$preflight$;

create table if not exists public.papers (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  title text not null check (char_length(btrim(title)) between 1 and 240),
  abstract text not null default '' check (char_length(abstract) <= 12000),
  keywords text[] not null default '{}',
  status text not null default 'Draft'
    check (status in ('Draft', 'Submitted', 'In review', 'Revisions requested', 'Published', 'Rejected')),
  pdf_path text,
  review_feedback text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references auth.users(id) on delete set null,
  published_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint papers_pdf_path_owner check (
    pdf_path is null or pdf_path = author_id::text || '/' || id::text || '.pdf'
  )
);

create index if not exists papers_status_created_idx
  on public.papers (status, created_at desc);
create index if not exists papers_author_created_idx
  on public.papers (author_id, created_at desc);

alter table public.papers enable row level security;

create or replace function public.privc_is_paper_reviewer()
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
      and account_role in ('reviewer', 'publishing_team', 'admin')
  )
$function$;
revoke all on function public.privc_is_paper_reviewer() from public;
grant execute on function public.privc_is_paper_reviewer() to anon, authenticated;

create or replace function public.privc_set_paper_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end
$function$;
revoke all on function public.privc_set_paper_updated_at() from public, anon, authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.papers'::regclass
      and tgname = 'privc_set_paper_updated_at'
      and not tgisinternal
  ) then
    create trigger privc_set_paper_updated_at
      before update on public.papers
      for each row execute function public.privc_set_paper_updated_at();
  end if;
end
$migration$;

revoke all on table public.papers from public, anon, authenticated;
grant select (
  id, author_id, title, abstract, keywords, status, pdf_path, review_feedback,
  submitted_at, reviewed_at, reviewed_by, published_at, created_at, updated_at
) on table public.papers to authenticated;
grant select (
  id, title, abstract, keywords, status, created_at, published_at
) on table public.papers to anon;
grant insert (author_id, title, abstract, keywords)
  on table public.papers to authenticated;
grant update (title, abstract, keywords, pdf_path)
  on table public.papers to authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'papers'
      and policyname = 'privc_papers_restrict_publication_visibility'
  ) then
    create policy privc_papers_restrict_publication_visibility
      on public.papers as restrictive for select to anon, authenticated
      using (
        status = 'Published'
        or author_id = (select auth.uid())
        or (select public.privc_is_paper_reviewer())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'papers'
      and policyname = 'privc_papers_restrict_insert'
  ) then
    create policy privc_papers_restrict_insert
      on public.papers as restrictive for insert to authenticated
      with check (author_id = (select auth.uid()) and status = 'Draft');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'papers'
      and policyname = 'privc_papers_restrict_update'
  ) then
    create policy privc_papers_restrict_update
      on public.papers as restrictive for update to authenticated
      using (
        author_id = (select auth.uid())
        and status in ('Draft', 'Revisions requested')
      )
      with check (
        author_id = (select auth.uid())
        and status in ('Draft', 'Revisions requested')
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'papers'
      and policyname = 'privc_papers_read_published_owner_reviewer'
  ) then
    create policy privc_papers_read_published_owner_reviewer
      on public.papers for select to anon, authenticated
      using (
        status = 'Published'
        or author_id = (select auth.uid())
        or (select public.privc_is_paper_reviewer())
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'papers'
      and policyname = 'privc_papers_insert_own_draft'
  ) then
    create policy privc_papers_insert_own_draft
      on public.papers for insert to authenticated
      with check (author_id = (select auth.uid()) and status = 'Draft');
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'papers'
      and policyname = 'privc_papers_update_own_editable'
  ) then
    create policy privc_papers_update_own_editable
      on public.papers for update to authenticated
      using (
        author_id = (select auth.uid())
        and status in ('Draft', 'Revisions requested')
      )
      with check (
        author_id = (select auth.uid())
        and status in ('Draft', 'Revisions requested')
      );
  end if;
end
$migration$;

-- Create the private bucket only when absent; refuse to reuse a public bucket with this name.
do $migration$
declare
  existing_bucket storage.buckets%rowtype;
  bucket_exists boolean;
begin
  select * into existing_bucket
  from storage.buckets
  where id = 'privc-papers';
  bucket_exists := found;

  if bucket_exists and existing_bucket.public then
    raise exception 'The privc-papers bucket already exists as public; inspect it before continuing.';
  end if;

  if bucket_exists and (
    existing_bucket.file_size_limit is distinct from 26214400
    or existing_bucket.allowed_mime_types is distinct from array['application/pdf']::text[]
  ) then
    raise exception 'The private privc-papers bucket has unexpected upload limits; inspect it before continuing.';
  end if;

  if bucket_exists and not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_restrict_select'
  ) then
    raise exception 'The privc-papers bucket already exists without the Phase 2 access policy; inspect it before continuing.';
  end if;

  if not bucket_exists then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('privc-papers', 'privc-papers', false, 26214400, array['application/pdf']);
  end if;
end
$migration$;

-- These permissive policies grant only the intended access for the new bucket.
do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_select_owner_reviewer'
  ) then
    create policy privc_papers_select_owner_reviewer
      on storage.objects for select to authenticated
      using (
        bucket_id = 'privc-papers'
        and (
          (storage.foldername(name))[1] = (select auth.uid())::text
          or (select public.privc_is_paper_reviewer())
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_insert_owner'
  ) then
    create policy privc_papers_insert_owner
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'privc-papers'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_update_owner'
  ) then
    create policy privc_papers_update_owner
      on storage.objects for update to authenticated
      using (
        bucket_id = 'privc-papers'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
      with check (
        bucket_id = 'privc-papers'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;
end
$migration$;

-- Restrictive policies keep any pre-existing broad storage policies from exposing this bucket.
do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_restrict_select'
  ) then
    create policy privc_papers_restrict_select
      on storage.objects as restrictive for select to public
      using (
        bucket_id <> 'privc-papers'
        or (
          auth.uid() is not null
          and (
            (storage.foldername(name))[1] = auth.uid()::text
            or public.privc_is_paper_reviewer()
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_restrict_insert'
  ) then
    create policy privc_papers_restrict_insert
      on storage.objects as restrictive for insert to public
      with check (
        bucket_id <> 'privc-papers'
        or (
          auth.uid() is not null
          and (storage.foldername(name))[1] = auth.uid()::text
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_restrict_update'
  ) then
    create policy privc_papers_restrict_update
      on storage.objects as restrictive for update to public
      using (
        bucket_id <> 'privc-papers'
        or (
          auth.uid() is not null
          and (storage.foldername(name))[1] = auth.uid()::text
        )
      )
      with check (
        bucket_id <> 'privc-papers'
        or (
          auth.uid() is not null
          and (storage.foldername(name))[1] = auth.uid()::text
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname = 'privc_papers_restrict_delete'
  ) then
    create policy privc_papers_restrict_delete
      on storage.objects as restrictive for delete to public
      using (bucket_id <> 'privc-papers');
  end if;
end
$migration$;

create or replace function public.privc_submit_paper(p_paper_id uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  paper public.papers%rowtype;
begin
  if auth.uid() is null then
    raise exception 'Sign in is required to submit a paper.' using errcode = '42501';
  end if;

  select * into paper
  from public.papers
  where id = p_paper_id and author_id = auth.uid()
  for update;

  if not found or paper.status not in ('Draft', 'Revisions requested') then
    raise exception 'This paper cannot be submitted in its current state.' using errcode = '22023';
  end if;
  if paper.pdf_path is null or not exists (
    select 1 from storage.objects
    where bucket_id = 'privc-papers' and name = paper.pdf_path
  ) then
    raise exception 'Upload a PDF before submitting.' using errcode = '22023';
  end if;

  update public.papers
  set status = 'Submitted',
      submitted_at = pg_catalog.now(),
      review_feedback = null,
      reviewed_at = null,
      reviewed_by = null
  where id = paper.id;
end
$function$;
revoke all on function public.privc_submit_paper(uuid) from public, anon;
grant execute on function public.privc_submit_paper(uuid) to authenticated;

create or replace function public.privc_get_review_queue()
returns table (
  id uuid,
  author_id uuid,
  title text,
  abstract text,
  keywords text[],
  status text,
  pdf_path text,
  review_feedback text,
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid,
  published_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $function$
begin
  if not public.privc_is_paper_reviewer() then
    raise exception 'Reviewer access is required.' using errcode = '42501';
  end if;

  return query
  select p.id, p.author_id, p.title, p.abstract, p.keywords, p.status,
         p.pdf_path, p.review_feedback, p.submitted_at, p.reviewed_at,
         p.reviewed_by, p.published_at, p.created_at, p.updated_at
  from public.papers as p
  where p.status in ('Submitted', 'In review')
  order by p.submitted_at asc;
end
$function$;
revoke all on function public.privc_get_review_queue() from public, anon;
grant execute on function public.privc_get_review_queue() to authenticated;

create or replace function public.privc_review_paper(
  p_paper_id uuid,
  p_status text,
  p_feedback text default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $function$
declare
  paper public.papers%rowtype;
  allowed_transition boolean;
  feedback text := nullif(pg_catalog.btrim(p_feedback), '');
begin
  if not public.privc_is_paper_reviewer() then
    raise exception 'Reviewer access is required.' using errcode = '42501';
  end if;
  if p_status is null
     or p_status not in ('In review', 'Revisions requested', 'Published', 'Rejected') then
    raise exception 'Invalid review status.' using errcode = '22023';
  end if;

  select * into paper
  from public.papers
  where id = p_paper_id
  for update;

  if not found then
    raise exception 'Paper not found.' using errcode = '22023';
  end if;

  allowed_transition :=
    (paper.status = 'Submitted' and p_status = 'In review')
    or (paper.status = 'In review' and p_status in ('Revisions requested', 'Published', 'Rejected'));
  if not allowed_transition then
    raise exception 'That status change is not allowed.' using errcode = '22023';
  end if;
  if p_status in ('Revisions requested', 'Rejected') and feedback is null then
    raise exception 'Add feedback before requesting revisions or rejecting a paper.' using errcode = '22023';
  end if;

  update public.papers
  set status = p_status,
      review_feedback = feedback,
      reviewed_at = pg_catalog.now(),
      reviewed_by = auth.uid(),
      published_at = case when p_status = 'Published' then pg_catalog.now() else null end
  where id = paper.id;
end
$function$;
revoke all on function public.privc_review_paper(uuid, text, text) from public, anon;
grant execute on function public.privc_review_paper(uuid, text, text) to authenticated;
