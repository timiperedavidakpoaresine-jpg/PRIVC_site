-- Profile avatar bucket and Storage access policies.
-- Idempotent mirror of the avatar Storage setup.

do $preflight$
begin
  if to_regprocedure('public.privc_is_user_active(uuid)') is null then
    raise exception
      'Required function public.privc_is_user_active(uuid) is missing; apply the moderation migration first.';
  end if;
end
$preflight$;

create or replace function public.privc_is_current_user_active()
returns boolean
language sql
stable
security definer
set search_path = ''
as $function$
  select public.privc_is_user_active((select auth.uid()))
$function$;

revoke all on function public.privc_is_current_user_active()
  from public, anon, authenticated;
grant execute on function public.privc_is_current_user_active()
  to authenticated;

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'profile-avatars',
  'profile-avatars',
  true,
  2097152,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do update
set
  name = excluded.name,
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

do $migration$
begin
  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'profile_avatars_select_own'
  ) then
    create policy profile_avatars_select_own
      on storage.objects for select to authenticated
      using (
        bucket_id = 'profile-avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'profile_avatars_insert_own'
  ) then
    create policy profile_avatars_insert_own
      on storage.objects for insert to authenticated
      with check (
        bucket_id = 'profile-avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'profile_avatars_update_own'
  ) then
    create policy profile_avatars_update_own
      on storage.objects for update to authenticated
      using (
        bucket_id = 'profile-avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      )
      with check (
        bucket_id = 'profile-avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'profile_avatars_delete_own'
  ) then
    create policy profile_avatars_delete_own
      on storage.objects for delete to authenticated
      using (
        bucket_id = 'profile-avatars'
        and (storage.foldername(name))[1] = (select auth.uid())::text
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'profile_avatars_active_insert_only'
  ) then
    create policy profile_avatars_active_insert_only
      on storage.objects as restrictive
      for insert to authenticated
      with check (
        bucket_id <> 'profile-avatars'
        or public.privc_is_current_user_active()
      );
  end if;

  if not exists (
    select 1 from pg_policies
    where schemaname = 'storage'
      and tablename = 'objects'
      and policyname = 'profile_avatars_active_update_only'
  ) then
    create policy profile_avatars_active_update_only
      on storage.objects as restrictive
      for update to authenticated
      using (
        bucket_id <> 'profile-avatars'
        or public.privc_is_current_user_active()
      )
      with check (
        bucket_id <> 'profile-avatars'
        or public.privc_is_current_user_active()
      );
  end if;
end
$migration$;
