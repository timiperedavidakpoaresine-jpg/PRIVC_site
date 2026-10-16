-- PRIVC Atlas: World Bank catalog + automatic updates (run once in Supabase > SQL Editor)
-- Before running: Dashboard > Database > Extensions > enable  pg_cron  and  pg_net.

create extension if not exists pg_trgm;

-- 1. Catalog of every World Bank indicator (name, database, ORIGINAL data provider, topics)
create table if not exists public.wb_catalog (
  indicator_id text primary key,
  name         text not null,
  unit         text,
  source_id    int,
  source_name  text,          -- World Bank database, e.g. World Development Indicators
  source_org   text,          -- original provider, e.g. UNESCO Institute for Statistics
  topics       text[] default '{}',
  note         text,
  pulled_at    timestamptz,   -- when values were last downloaded for this indicator
  synced_at    timestamptz default now()
);
create index if not exists wb_catalog_name_trgm on public.wb_catalog using gin (name gin_trgm_ops);
create index if not exists wb_catalog_id_trgm   on public.wb_catalog using gin (indicator_id gin_trgm_ops);
create index if not exists wb_catalog_pulled    on public.wb_catalog (pulled_at);

alter table public.wb_catalog enable row level security;
drop policy if exists "public read wb_catalog" on public.wb_catalog;
create policy "public read wb_catalog" on public.wb_catalog for select using (true);

-- 2. Private log (no public access: only the function with the service key can use it)
create table if not exists public.wb_sync_log (
  id bigserial primary key,
  ran_at timestamptz default now(),
  mode text,
  detail jsonb
);
alter table public.wb_sync_log enable row level security;

-- 3. Automatic schedule.  REPLACE  YOUR_CRON_SECRET  with the same secret you set for the function.
select cron.unschedule(jobname) from cron.job where jobname in ('wb-catalog-monthly','wb-refresh-daily');

-- Whole catalog: 1st of every month at 02:00 UTC
select cron.schedule('wb-catalog-monthly', '0 2 1 * *', $$
  select net.http_post(
    url := 'https://dcwxfgmlnyqvkdnmxxcg.supabase.co/functions/v1/wb-sync?mode=catalog',
    headers := '{"x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    timeout_milliseconds := 5000);
$$);

-- Values already used on the site: refresh a batch every day, so each one is renewed about monthly
select cron.schedule('wb-refresh-daily', '30 3 * * *', $$
  select net.http_post(
    url := 'https://dcwxfgmlnyqvkdnmxxcg.supabase.co/functions/v1/wb-sync?mode=refresh&limit=12',
    headers := '{"x-cron-secret":"YOUR_CRON_SECRET"}'::jsonb,
    timeout_milliseconds := 5000);
$$);
