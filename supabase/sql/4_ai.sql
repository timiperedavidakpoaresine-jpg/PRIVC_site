-- AI assistant usage limits (run once in Supabase > SQL Editor)
create table if not exists public.ai_usage (
  day date not null default current_date,
  k text not null,
  n int not null default 0,
  primary key (day, k)
);
alter table public.ai_usage enable row level security;   -- no policies: only the server function can use it

create or replace function public.ai_hit(p_key text, p_limit int) returns boolean
language plpgsql security definer set search_path = public as $$
declare c int;
begin
  insert into public.ai_usage(day, k, n) values (current_date, p_key, 1)
  on conflict (day, k) do update set n = public.ai_usage.n + 1
  returning n into c;
  return c <= p_limit;
end $$;
revoke all on function public.ai_hit(text, int) from public, anon, authenticated;
