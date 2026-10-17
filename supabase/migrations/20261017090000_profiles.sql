-- Phase 1: public researcher profiles linked to Supabase Auth.
-- This migration is additive and does not modify existing policies or user data.

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  username text not null check (username ~ '^[a-z0-9][a-z0-9_-]{2,31}$'),
  display_name text not null default '',
  affiliation text,
  country text,
  bio text,
  research_interests text[] not null default '{}',
  orcid text,
  website text,
  avatar_url text,
  is_public boolean not null default true,
  account_role text not null default 'member'
    check (account_role in ('member', 'reviewer', 'publishing_team', 'moderator', 'admin')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.profiles
  add column if not exists id uuid references auth.users(id) on delete cascade,
  add column if not exists username text,
  add column if not exists display_name text not null default '',
  add column if not exists affiliation text,
  add column if not exists country text,
  add column if not exists bio text,
  add column if not exists research_interests text[] not null default '{}',
  add column if not exists orcid text,
  add column if not exists website text,
  add column if not exists avatar_url text,
  add column if not exists is_public boolean not null default true,
  add column if not exists account_role text not null default 'member',
  add column if not exists created_at timestamptz not null default now(),
  add column if not exists updated_at timestamptz not null default now();

create unique index if not exists profiles_username_lower_uidx
  on public.profiles (lower(username));

alter table public.profiles enable row level security;

-- Limit API column access so account_role is neither publicly exposed nor user-editable.
revoke all on table public.profiles from public, anon, authenticated;
grant select (
  id, username, display_name, affiliation, country, bio, research_interests,
  orcid, website, avatar_url, is_public, created_at, updated_at
) on table public.profiles to anon, authenticated;
grant insert (
  id, username, display_name, affiliation, country, bio, research_interests,
  orcid, website, avatar_url, is_public
) on table public.profiles to authenticated;
grant update (
  username, display_name, affiliation, country, bio, research_interests,
  orcid, website, avatar_url, is_public, updated_at
) on table public.profiles to authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'profiles_read_public_or_self'
  ) then
    execute $policy$
      create policy profiles_read_public_or_self on public.profiles
      for select to anon, authenticated
      using (is_public or id = auth.uid())
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'profiles_insert_self'
  ) then
    execute $policy$
      create policy profiles_insert_self on public.profiles
      for insert to authenticated
      with check (id = auth.uid())
    $policy$;
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profiles'
      and policyname = 'profiles_update_self'
  ) then
    execute $policy$
      create policy profiles_update_self on public.profiles
      for update to authenticated
      using (id = auth.uid())
      with check (id = auth.uid())
    $policy$;
  end if;
end
$migration$;

do $migration$
begin
  if to_regprocedure('public.privc_create_profile_after_signup()') is null then
    execute $function$
      create function public.privc_create_profile_after_signup()
      returns trigger
      language plpgsql
      security definer
      set search_path = ''
      as $body$
      declare
        profile_username text;
      begin
        profile_username := lower(regexp_replace(
          coalesce(new.raw_user_meta_data ->> 'username', ''),
          '[^a-z0-9_-]', '', 'g'
        ));

        if profile_username !~ '^[a-z0-9][a-z0-9_-]{2,31}$'
           or exists (
             select 1 from public.profiles
             where lower(username) = profile_username
           ) then
          profile_username := 'member-' || left(replace(new.id::text, '-', ''), 12);
        end if;

        insert into public.profiles (id, username, display_name)
        values (
          new.id,
          profile_username,
          coalesce(nullif(btrim(new.raw_user_meta_data ->> 'display_name'), ''), profile_username)
        )
        on conflict do nothing;

        return new;
      end
      $body$
    $function$;
    revoke all on function public.privc_create_profile_after_signup() from public, anon, authenticated;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'auth.users'::regclass
      and tgname = 'privc_create_profile_after_signup'
      and not tgisinternal
  ) then
    create trigger privc_create_profile_after_signup
      after insert on auth.users
      for each row execute function public.privc_create_profile_after_signup();
  end if;
end
$migration$;
