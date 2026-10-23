-- Profile headline field used by the community profile editor.
-- Additive only; review before applying.

alter table public.profiles
  add column if not exists headline text;

do $migration$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.profiles'::regclass
      and conname = 'profiles_headline_length'
  ) then
    alter table public.profiles
      add constraint profiles_headline_length
      check (headline is null or char_length(headline) <= 160);
  end if;
end
$migration$;

grant select (headline)
  on public.profiles to anon, authenticated;
grant insert (headline)
  on public.profiles to authenticated;
grant update (headline)
  on public.profiles to authenticated;
