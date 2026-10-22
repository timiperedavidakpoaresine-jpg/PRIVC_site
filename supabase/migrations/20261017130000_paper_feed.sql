-- Phase 3: public paper feed metadata and published-paper view counts.
-- Additive only. Review before applying; this migration is not run automatically.

alter table public.papers
  add column if not exists publication_year smallint,
  add column if not exists view_count bigint not null default 0;

update public.papers
set publication_year = coalesce(
  extract(year from published_at),
  extract(year from created_at)
)::smallint
where publication_year is null;

do $migration$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.papers'::regclass
      and conname = 'papers_publication_year_range'
  ) then
    alter table public.papers
      add constraint papers_publication_year_range
      check (publication_year between 1000 and 9999);
  end if;
end
$migration$;

grant select (author_id, publication_year, view_count)
  on public.papers to anon, authenticated;
grant insert (publication_year)
  on public.papers to authenticated;
grant update (publication_year)
  on public.papers to authenticated;

create or replace function public.privc_record_paper_view(p_paper_id uuid)
returns bigint
language plpgsql
security definer
set search_path = ''
as $function$
declare
  current_view_count bigint;
begin
  update public.papers
  set view_count = view_count + 1
  where id = p_paper_id and status = 'Published'
  returning view_count into current_view_count;

  if not found then
    raise exception 'Published paper not found.' using errcode = 'P0002';
  end if;

  return current_view_count;
end
$function$;

revoke all on function public.privc_record_paper_view(uuid) from public;
grant execute on function public.privc_record_paper_view(uuid) to anon, authenticated;
