-- Satellite dataset requests (run once in Supabase > SQL Editor)
create table if not exists public.satellite_dataset_requests (
  id bigserial primary key,
  dataset text not null,
  countries jsonb not null,                 -- [{"iso":"NGA","name":"Nigeria"}, ...]
  first_year int not null default 2000,
  last_year int not null default 2025,
  status text not null default 'pending',   -- pending | done | failed
  message text,
  created_at timestamptz default now(),
  constraint sdr_size check (jsonb_array_length(countries) between 1 and 80),
  constraint sdr_years check (first_year >= 1975 and last_year <= 2100 and first_year <= last_year),
  constraint sdr_dataset check (dataset ~ '^[A-Z0-9_]{3,40}$')
);
alter table public.satellite_dataset_requests enable row level security;
drop policy if exists "anyone can request" on public.satellite_dataset_requests;
create policy "anyone can request" on public.satellite_dataset_requests for insert to anon, authenticated with check (status = 'pending');
drop policy if exists "anyone can read requests" on public.satellite_dataset_requests;
create policy "anyone can read requests" on public.satellite_dataset_requests for select to anon, authenticated using (true);
