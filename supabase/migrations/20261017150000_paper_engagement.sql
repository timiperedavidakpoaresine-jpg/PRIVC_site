-- Phase 4: paper engagement, follows, bookmarks and notifications.
-- Additive only. Review before applying; this migration is not run automatically.

create extension if not exists pgcrypto;

create table if not exists public.paper_likes (
  paper_id uuid not null references public.papers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (paper_id, user_id)
);
alter table public.paper_likes enable row level security;

create table if not exists public.paper_comments (
  id uuid primary key default gen_random_uuid(),
  paper_id uuid not null references public.papers(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  parent_comment_id uuid references public.paper_comments(id) on delete cascade,
  body text not null check (char_length(btrim(body)) between 1 and 2000),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.paper_comments enable row level security;

create table if not exists public.profile_follows (
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followed_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (follower_id, followed_id),
  check (follower_id <> followed_id)
);
alter table public.profile_follows enable row level security;

create table if not exists public.paper_bookmarks (
  user_id uuid not null references auth.users(id) on delete cascade,
  paper_id uuid not null references public.papers(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, paper_id)
);
alter table public.paper_bookmarks enable row level security;

create table if not exists public.notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  kind text not null check (kind in ('like', 'comment', 'follow', 'bookmark', 'paper_published')),
  actor_id uuid references auth.users(id) on delete set null,
  paper_id uuid references public.papers(id) on delete cascade,
  profile_id uuid references public.profiles(id) on delete cascade,
  message text not null default '',
  is_read boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.notifications enable row level security;

create index if not exists paper_likes_paper_idx
  on public.paper_likes (paper_id, created_at desc);
create index if not exists paper_likes_user_idx
  on public.paper_likes (user_id, created_at desc);
create index if not exists paper_comments_paper_idx
  on public.paper_comments (paper_id, created_at desc);
create index if not exists paper_comments_parent_idx
  on public.paper_comments (parent_comment_id, created_at desc);
create index if not exists profile_follows_followed_idx
  on public.profile_follows (followed_id, created_at desc);
create index if not exists paper_bookmarks_user_idx
  on public.paper_bookmarks (user_id, created_at desc);
create index if not exists notifications_user_created_idx
  on public.notifications (user_id, created_at desc);

create or replace function public.privc_paper_is_public(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.papers
    where id = p_paper_id
      and status = 'Published'
  );
$function$;
revoke all on function public.privc_paper_is_public(uuid) from public;
grant execute on function public.privc_paper_is_public(uuid) to anon, authenticated;

create or replace function public.privc_is_author_or_reviewer(p_paper_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select exists (
    select 1
    from public.papers p
    where p.id = p_paper_id
      and (
        p.author_id = (select auth.uid())
        or (select public.privc_is_paper_reviewer())
      )
  );
$function$;
revoke all on function public.privc_is_author_or_reviewer(uuid) from public;
grant execute on function public.privc_is_author_or_reviewer(uuid) to anon, authenticated;

create or replace function public.privc_paper_like_count(p_paper_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $function$
  select count(*)
  from public.paper_likes
  where paper_id = p_paper_id;
$function$;
revoke all on function public.privc_paper_like_count(uuid) from public;
grant execute on function public.privc_paper_like_count(uuid) to anon, authenticated;

create or replace function public.privc_paper_comment_count(p_paper_id uuid)
returns bigint
language sql
stable
security definer
set search_path = ''
as $function$
  select count(*)
  from public.paper_comments
  where paper_id = p_paper_id;
$function$;
revoke all on function public.privc_paper_comment_count(uuid) from public;
grant execute on function public.privc_paper_comment_count(uuid) to anon, authenticated;

create or replace function public.privc_validate_comment_parent()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  parent_paper_id uuid;
begin
  if new.parent_comment_id is null then
    return new;
  end if;

  select paper_id into parent_paper_id
  from public.paper_comments
  where id = new.parent_comment_id;

  if parent_paper_id is null then
    raise exception 'Parent comment not found.' using errcode = 'P0002';
  end if;

  if parent_paper_id <> new.paper_id then
    raise exception 'Parent comment must belong to the same paper.' using errcode = 'P0003';
  end if;

  return new;
end
$function$;
revoke all on function public.privc_validate_comment_parent() from public, anon, authenticated;

create or replace function public.privc_set_comment_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $function$
begin
  new.updated_at := pg_catalog.now();
  return new;
end
$function$;
revoke all on function public.privc_set_comment_updated_at() from public, anon, authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_comments'::regclass
      and tgname = 'privc_validate_comment_parent'
      and not tgisinternal
  ) then
    create trigger privc_validate_comment_parent
      before insert or update on public.paper_comments
      for each row execute function public.privc_validate_comment_parent();
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgrelid = 'public.paper_comments'::regclass
      and tgname = 'privc_set_comment_updated_at'
      and not tgisinternal
  ) then
    create trigger privc_set_comment_updated_at
      before update on public.paper_comments
      for each row execute function public.privc_set_comment_updated_at();
  end if;
end
$migration$;

revoke all on table public.paper_likes from public, anon, authenticated;
revoke all on table public.paper_comments from public, anon, authenticated;
revoke all on table public.profile_follows from public, anon, authenticated;
revoke all on table public.paper_bookmarks from public, anon, authenticated;
revoke all on table public.notifications from public, anon, authenticated;

grant select on table public.paper_likes to anon, authenticated;
grant insert (paper_id, user_id) on table public.paper_likes to authenticated;
grant delete on table public.paper_likes to authenticated;

grant select on table public.paper_comments to anon, authenticated;
grant insert (paper_id, user_id, parent_comment_id, body) on table public.paper_comments to authenticated;
grant update (body) on table public.paper_comments to authenticated;
grant delete on table public.paper_comments to authenticated;

grant select on table public.profile_follows to authenticated;
grant insert (follower_id, followed_id) on table public.profile_follows to authenticated;
grant delete on table public.profile_follows to authenticated;

grant select on table public.paper_bookmarks to authenticated;
grant insert (user_id, paper_id) on table public.paper_bookmarks to authenticated;
grant delete on table public.paper_bookmarks to authenticated;

grant select on table public.notifications to authenticated;
grant update (is_read) on table public.notifications to authenticated;

do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_likes'
      and policyname = 'privc_paper_likes_select_visible'
  ) then
    create policy privc_paper_likes_select_visible
      on public.paper_likes for select to anon, authenticated
      using (
        exists (
          select 1 from public.papers p
          where p.id = paper_likes.paper_id
            and (
              p.status = 'Published'
              or p.author_id = (select auth.uid())
              or (select public.privc_is_paper_reviewer())
            )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_likes'
      and policyname = 'privc_paper_likes_insert_own'
  ) then
    create policy privc_paper_likes_insert_own
      on public.paper_likes for insert to authenticated
      with check (
        user_id = (select auth.uid())
        and (
          exists (
            select 1 from public.papers p
            where p.id = paper_likes.paper_id
              and (
                p.status = 'Published'
                or p.author_id = (select auth.uid())
                or (select public.privc_is_paper_reviewer())
              )
          )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_likes'
      and policyname = 'privc_paper_likes_delete_own'
  ) then
    create policy privc_paper_likes_delete_own
      on public.paper_likes for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_comments'
      and policyname = 'privc_paper_comments_select_visible'
  ) then
    create policy privc_paper_comments_select_visible
      on public.paper_comments for select to anon, authenticated
      using (
        exists (
          select 1 from public.papers p
          where p.id = paper_comments.paper_id
            and (
              p.status = 'Published'
              or p.author_id = (select auth.uid())
              or (select public.privc_is_paper_reviewer())
            )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_comments'
      and policyname = 'privc_paper_comments_insert_own'
  ) then
    create policy privc_paper_comments_insert_own
      on public.paper_comments for insert to authenticated
      with check (
        user_id = (select auth.uid())
        and exists (
          select 1 from public.papers p
          where p.id = paper_comments.paper_id
            and (
              p.status = 'Published'
              or p.author_id = (select auth.uid())
              or (select public.privc_is_paper_reviewer())
            )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_comments'
      and policyname = 'privc_paper_comments_update_own'
  ) then
    create policy privc_paper_comments_update_own
      on public.paper_comments for update to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_comments'
      and policyname = 'privc_paper_comments_delete_own'
  ) then
    create policy privc_paper_comments_delete_own
      on public.paper_comments for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profile_follows'
      and policyname = 'privc_profile_follows_select_own_and_public'
  ) then
    create policy privc_profile_follows_select_own_and_public
      on public.profile_follows for select to authenticated
      using (
        follower_id = (select auth.uid())
        or followed_id = (select auth.uid())
        or exists (
          select 1
          from public.profiles pf
          where pf.id = profile_follows.followed_id
            and pf.is_public = true
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profile_follows'
      and policyname = 'privc_profile_follows_insert_own'
  ) then
    create policy privc_profile_follows_insert_own
      on public.profile_follows for insert to authenticated
      with check (
        follower_id = (select auth.uid())
        and exists (
          select 1 from public.profiles pf
          where pf.id = followed_id
            and pf.is_public = true
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'profile_follows'
      and policyname = 'privc_profile_follows_delete_own'
  ) then
    create policy privc_profile_follows_delete_own
      on public.profile_follows for delete to authenticated
      using (follower_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_bookmarks'
      and policyname = 'privc_paper_bookmarks_select_own'
  ) then
    create policy privc_paper_bookmarks_select_own
      on public.paper_bookmarks for select to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_bookmarks'
      and policyname = 'privc_paper_bookmarks_insert_own'
  ) then
    create policy privc_paper_bookmarks_insert_own
      on public.paper_bookmarks for insert to authenticated
      with check (
        user_id = (select auth.uid())
        and exists (
          select 1 from public.papers p
          where p.id = paper_bookmarks.paper_id
            and (
              p.status = 'Published'
              or p.author_id = (select auth.uid())
              or (select public.privc_is_paper_reviewer())
            )
        )
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'paper_bookmarks'
      and policyname = 'privc_paper_bookmarks_delete_own'
  ) then
    create policy privc_paper_bookmarks_delete_own
      on public.paper_bookmarks for delete to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notifications'
      and policyname = 'privc_notifications_select_own'
  ) then
    create policy privc_notifications_select_own
      on public.notifications for select to authenticated
      using (user_id = (select auth.uid()));
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'public' and tablename = 'notifications'
      and policyname = 'privc_notifications_update_own'
  ) then
    create policy privc_notifications_update_own
      on public.notifications for update to authenticated
      using (user_id = (select auth.uid()))
      with check (user_id = (select auth.uid()));
  end if;
end
$migration$;

