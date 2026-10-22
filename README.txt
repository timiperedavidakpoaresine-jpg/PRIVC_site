PRIVC ATLAS: WHAT YOU HAVE AND HOW TO KEEP IT UPDATED

THE WHOLE PROJECT IS 2 DOWNLOADS
1) PRIVC_site.zip     -> index.html, reports.js, reports.css, and the reports/ folder. These files together make
   the static website (all pages, maps, catalogs, citations and the public reports catalogue).
2) PRIVC_backend.zip  -> this folder. Set up once; it rarely changes. It holds:
     supabase/sql/        two SQL files (run once in Supabase)
     supabase/functions/  two small functions (wb-sync and provider-proxy)
     .github/workflows/   the scheduled jobs (monthly UNDP/ITU, weekly satellite)
     monthly-file-import/ and satellite-datasets/   the scripts those jobs run
Keep both in ONE GitHub repository: index.html, reports.js, reports.css, reports/, and the backend folders at top level.
data/wb.json is an optional World Bank override; replace its placeholder only with a complete export newer than the
built-in data.

REPORTS AND ARTICLES
- Public items are read from reports/reports.json. Put PDF files in reports/pdf/ and reference them by a relative path,
  for example reports/pdf/annual-report.pdf.
- Use Write or publish to create a browser-only draft. Export reports.json to merge those items; remove any draft
  records you do not want public before committing/deploying the JSON and PDFs with the site. JSON contents are public.
- Use a local static server (for example VS Code Live Server) to test: browsers do not fetch JSON files reliably from
  a file:// URL.

COMMUNITY ACCOUNTS AND PROFILES (PHASE 1)
- The additive migration is supabase/migrations/20261017090000_profiles.sql. Review it and its RLS policies before
  running it in the existing Supabase project; it creates public.profiles linked to auth.users and does not replace
  existing policies or rows.
- config.js contains only the browser-safe Supabase URL and publishable key. Never put SUPABASE_SERVICE_ROLE_KEY in
  config.js or any other browser file. Keep server-side values in your private environment and deploy
  supabase/functions/delete-account/ with SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and
  ALLOWED_ORIGINS set as Edge Function secrets.
- In Supabase Auth, enable email confirmation and add /auth/callback to allowed redirect URLs. Google and ORCID
  sign-in buttons require their providers to be configured in Supabase first.
- Public profile URLs use /u/username; _redirects and vercel.json provide the static-host rewrite. Photo URLs can be
  set on a profile for now. Avatar upload policies are intentionally deferred until the existing Storage setup has
  been inspected.
- Direct profile URLs require host rewrites: Netlify/Cloudflare Pages use _redirects and Vercel uses vercel.json.
  GitHub Pages does not support these rewrites, so use Netlify, Cloudflare Pages or Vercel for working /u/username links.
- The old simulated sign-in/payment gate has been replaced by public guest browsing and real Supabase account flows.
  The local guest workspace and the existing Atlas sections remain; cloud workspace, papers and engagement are later
  phases.

PAPER SUBMISSION AND REVIEW (PHASE 2; NOT YET ENABLED IN SUPABASE)
- The additive migration is supabase/migrations/20261017110000_papers_review.sql. It creates a papers table, a private
  PDF bucket, row/storage policies and guarded submit/review functions. It contains no drop, truncate or delete
  statements. Review it and compare it with the live database before choosing to run it; it has NOT been applied.
- The public Papers button lists Published papers only. Signed-in authors can save Drafts, upload PDFs up to 25 MB,
  submit papers, and resubmit after requested revisions. Reviewers can start review, request revisions, publish or
  reject, with feedback required for revision requests and rejections.
- Only profiles whose account_role is reviewer, publishing_team or admin can see the admin review queue. Assign these
  roles only through a trusted Supabase administrator workflow; do not expose account_role editing to users.
- Deploy supabase/functions/paper-pdf/ as an Edge Function with Verify JWT disabled (supabase/config.toml sets this
  for CLI deployments). Configure SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY and ALLOWED_ORIGINS.
  The function returns a five-minute signed PDF link only to the author, an authorized reviewer, or anyone requesting
  a Published paper. Never expose the service-role key in browser configuration.
- To test after reviewing and applying the migration: configure the function and allowed origin; create a test account;
  upload a small PDF and save it as Draft; confirm the author can see it but a second account and a signed-out browser
  cannot. Submit it, assign a test reviewer role through a trusted administrator path, then exercise In review,
  Revisions requested, resubmission, Published and Rejected. Confirm only Published papers appear signed out and their
  PDF links expire after five minutes.

PAPER FEED, SEARCH AND PUBLIC PAPER PAGES (PHASE 3; SQL NOT RUN)
- The additive migration is supabase/migrations/20261017130000_paper_feed.sql. Review it before applying; it adds
  publication year and view counts and creates a guarded function to record views of Published papers. It is not
  applied automatically and must be run only after reviewing the SQL.
- The Papers button opens the public feed. Search covers loaded paper titles, abstracts, topics, authors and years;
  use Load more papers to include older entries. Each card links to a public paper page and, when the author's
  profile is public, shows their name and photo linked to that profile.
- A paper page shows its abstract, topics, publication year, view count, a signed PDF link, and more published
  papers from the same author. Direct /papers and /papers/<paper-id> links use the Netlify and Vercel rewrites.
  Locally, open the feed with the Papers button; direct-link refreshes require a host with rewrites.
- Paper drafts and submissions now include a publication year. Existing papers receive a year from published_at,
  or created_at when they have not yet been published.

HOW TO UPDATE THE SITE WITHOUT DRAGGING FILES TO NETLIFY EVERY TIME
- Host on GitHub Pages (free, no deploy limits): GitHub repo > Settings > Pages > Deploy from branch > main / root.
- To update: GitHub > your repo > Add file > Upload files > choose the new index.html (same name) > Commit.
  The live site refreshes in about a minute. This works from a phone browser.
- WHO and other providers need the relay. Netlify's _redirects file only works on Netlify, so instead deploy the
  Supabase function "provider-proxy" once (steps below). It works on ANY host, including your own domain.

MOVING TO YOUR OWN DOMAIN AND HOSTING LATER
- Because the site is one file plus the Supabase and GitHub parts, it moves anywhere: keep the same GitHub repo,
  buy a domain (Cloudflare, Namecheap or Google/Squarespace Domains), and in GitHub Pages settings enter the domain
  (or connect the repo to Cloudflare Pages). In VS Code: install Git, "Clone repository", edit index.html, commit.
- Nothing inside index.html depends on Netlify once provider-proxy is deployed.


AI ASSISTANT (new): REPORTS, PAPERS, CHARTS, DATA EXTRACTION, REFERENCES
What it does: answers questions about the data on the site, builds reports and papers, draws charts in the chat, gives
CSV downloads with sources, and searches the web for literature so references include authors, not only this site.
It uses the same tools as the site (search stored data, compute PDI, set your selection) and is told never to invent
values or references.
Why it needs a server: an AI key must never sit in a web page. The key lives in a Supabase function; Netlify or GitHub
only host index.html. Each question costs a small amount on YOUR AI account, so limits are built in.
Setup (works from a phone browser):
 1. Get a key: console.anthropic.com > create an account > Billing: add credit > Limits: set a monthly spend limit
    (start small) > API keys: create a key and copy it. Web search for references must be allowed in the console's
    privacy/settings for your organisation; if it is not, set AI_WEB_SEARCH=off below and the AI still works.
 2. Supabase > SQL Editor: run supabase/sql/4_ai.sql (creates the usage limits).
 3. Supabase > Edge Functions > Deploy a new function > name it exactly:  ai-assistant
    Paste the code from supabase/functions/ai-assistant/index.ts and deploy. In the function's settings turn OFF
    "Verify JWT" (the site sends your public key, not a login token).
 4. Supabase > Project Settings > Edge Functions > Secrets. Add:
      ANTHROPIC_API_KEY   your key (required)
      ALLOWED_ORIGINS     your site address(es), comma separated, e.g. https://your-site.netlify.app  (recommended)
      AI_ACCESS_CODE      optional password visitors must enter (use it while testing)
      AI_DAILY_PER_IP     optional, questions-steps per visitor per day (default 60)
      AI_DAILY_GLOBAL     optional, total per day for the whole site (default 3000)
      AI_MODEL            optional, default claude-sonnet-5-5
      AI_WEB_SEARCH       optional, set to off to disable web search
 5. Upload the new index.html. Tap the round AI button (or open the Economic lens > AI assistant) and ask, for example:
      "Compare life expectancy in Nigeria and Ghana since 2010, draw a chart and write a one-page brief with references."
Notes: AI answers can contain mistakes, so keep the "verify" habit and check references. I could not call the live
AI service from here, so the first real test is yours: if it says "not connected", the function or the key is missing.

FIRST-TIME SETUP STEPS (Supabase, GitHub secrets, Earth Engine) FOLLOW BELOW
------------------------------------------------------------------------
PRIVC Atlas: World Bank indicators in Supabase (about 20 minutes, one time)

WHAT YOU GET (works in two layers)
LAYER 1, works the moment you upload index.html (no Supabase needed):
- Data Explorer > Indicators now shows the World Bank catalog: every indicator and every World Bank database,
  with filters by database, topic and search. The catalog is downloaded from the World Bank and kept in the
  browser for 30 days.
- When someone ticks an indicator, its values are downloaded straight from the World Bank for that session.
LAYER 2, the steps below (Supabase):
- Values are saved permanently in your database, so they load fast and are the same for every visitor.
- The catalog and the values people have used are refreshed automatically every month.
- The full World Bank indicator catalog (name, database, original data provider, topics) searchable on your site.
- Values are downloaded the first time someone picks an indicator, then kept in your database.
- Every month the catalog is refreshed; values you have used are renewed about every month.
- Every CSV cites the World Bank database AND the original provider.

WHY VALUES ARE NOT ALL STORED AT ONCE
There are about 16,000 indicators. Storing every value for every country and year would be hundreds of millions
of rows and would not fit a normal Supabase plan. So the catalog is stored in full, and values are stored for the
indicators people actually use.

STEPS
1. Supabase dashboard > Database > Extensions: switch ON  pg_cron  and  pg_net.
2. SQL Editor: open supabase/sql/1_setup.sql, replace YOUR_CRON_SECRET (twice) with a long random password you invent, then Run.
3. Install the Supabase CLI (https://supabase.com/docs/guides/cli) and, in the folder that contains the folder
   "wb-sync", run:
       supabase login
       supabase link --project-ref dcwxfgmlnyqvkdnmxxcg
       supabase secrets set CRON_SECRET=THE_SAME_PASSWORD
       supabase functions deploy wb-sync --no-verify-jwt
   (Put wb-sync inside a folder named  supabase/functions/  so the path is supabase/functions/wb-sync/index.ts)
4. Load the catalog the first time (this takes a few minutes; it continues by itself):
       curl -H "x-cron-secret: THE_SAME_PASSWORD" "https://dcwxfgmlnyqvkdnmxxcg.supabase.co/functions/v1/wb-sync?mode=catalog"
5. Check: Table Editor > wb_catalog should fill with thousands of rows. wb_sync_log shows each run.
6. Upload the new index.html to your site. In Data Explorer > Indicators, the "Search all World Bank indicators" box now works.

NOTES
- The function writes to your existing tables: observations, indicators and indicator_ranges (source = 'WB'), so the
  explorer, maps and rankings use the new indicators with no other change.
- Only rows with source = 'WB' for the chosen indicator are replaced. Your other sources are not touched.
- If a step shows an error, send me the exact message.

WHO AND UNESCO UIS (new)
- The Indicators panel now has a provider switch: World Bank, WHO Global Health Observatory, UNESCO Institute for Statistics.
- The site first calls each provider directly from the browser. If a provider blocks direct browser access (CORS),
  the site automatically retries through the small relay function in provider-proxy/. To enable it:
      supabase functions deploy provider-proxy --no-verify-jwt
  (put it in supabase/functions/provider-proxy/index.ts next to wb-sync). It only relays three approved hosts.
- Check each provider's terms of use before reusing its data. The CSV header links to them.
- WHO series that are split by sex, age or other dimensions are reduced to the 'both sexes' or total series.

UNDP AND ITU: LIVE FOR EVERY VISITOR (updated automatically)
- Visitors upload nothing. The site reads UNDP and ITU indicators from YOUR Supabase database, exactly like the other
  providers. A scheduled job keeps the database up to date (monthly; you can also run it by hand any time).
- One-time setup:
  1. Copy the folders monthly-file-import/ and .github/ to the root of your GitHub repository.
  2. GitHub > Settings > Secrets and variables > Actions > add
       secrets:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
       variables: ITU_FILE_URL   (see below; UNDP needs no link, the job finds UNDP's newest file by itself)
  3. Actions tab > "Monthly UNDP and ITU import" > Run workflow. After a few minutes the UNDP catalog appears on the site.
- UNDP: the job reads UNDP's data download page, finds the newest composite-indices time-series CSV (the 2025 release is
  at https://hdr.undp.org/sites/default/files/2025_HDR/HDR25_Composite_indices_complete_time_series.csv) and loads it.
  UNDP also offers a keyed data API (https://hdrdata.org). The file route needs no key.
- ITU: ITU's DataHub does not publish a stable file link on its own site. The World Bank Data Catalog carries the ITU
  DataHub dataset (CSV, licence CC BY 4.0). Open https://datacatalog.worldbank.org/search/dataset/0067055/itu-data-hub,
  right-click the download button of the "ITU_DH dataset" CSV, copy the link, and save it ONCE as the GitHub variable
  ITU_FILE_URL. From then on the monthly job refreshes ITU with no further work. (If the link changes, update the variable.)
- If a run fails, the message in the Actions log says why (for example the columns it did not recognise). Send it to me.
- I could not see the real files from here, so the reader is built for the documented UNDP layout (iso3 plus columns like
  hdi_2022) and common long layouts. ITU's layout is the one most likely to need a small adjustment.

SATELLITE DATASETS (new)
- In the site: Indicators panel > "Satellite datasets (Earth Engine)". It lists 4 datasets already stored by your pipeline
  (NDVI, NDWI, NDBI, VIIRS, area based) plus 8 you can request: MODIS NDVI and EVI, CHIRPS rainfall, MODIS land surface
  temperature, VIIRS night lights (country level), JRC surface water, Sentinel-5P NO2 and ERA5-Land air temperature.
- Ticking a dataset together with chosen countries sends a request. Earth Engine computes yearly country values at its next
  weekly run and the Explorer shows them after that. Every CSV cites the dataset, agency and processing.
- One-time setup:
  1. Supabase SQL Editor: run supabase/sql/3_satellite_requests.sql.
  2. Copy the folders satellite-datasets/ and .github/ to the root of your GitHub repository (merge with the earlier .github).
  3. GitHub > Settings > Secrets and variables > Actions:
       secrets:   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, EE_SERVICE_ACCOUNT_JSON (the full JSON key text of an
                  Earth Engine service account that is registered for Earth Engine)
       variables: EE_PROJECT (your Google Cloud project id)
  4. Actions tab > "Satellite dataset requests (Earth Engine)" > Run workflow, to process requests straight away.
- Country boundaries come from FAO GAUL 2015 and are matched by country name. Names that do not match are listed in the
  request's message so you can see which ones were skipped.
- I could not run Earth Engine from here, so the worker is untested. If a run fails, the message is stored on the request
  row (column message) and in the Actions log. Send it to me.
- satellite_datasets.json is the single list of datasets. Add a dataset by adding a block there and to the site list; ask me.

ECONOMIC LENS NOW HAS THE FULL CATALOGS (new)
- In the Economic lens, step "2. Indicators" now has a button "Browse all indicators: World Bank, WHO, UNESCO, UNDP, ITU,
  satellite". It opens the same catalogs as the Data Explorer (World Bank alone is about 29,000 indicators in 62 databases).
- Tick any number. They are added to the lens selection together with your PRIVC 24 and stored indicators, and they stay
  selected next time. When you build a report or a PDI, the values are loaded automatically for every ticked indicator.
- The old list underneath still shows the indicators already in your database (about 88) plus everything you tick.

WHO "COULD NOT REACH THIS CATALOG" (fix)
- WHO does not allow the browser to call its API directly. The file _redirects (in the package root, next to index.html)
  tells Netlify to relay those calls. Deploy index.html AND _redirects together: in Netlify, drag the whole folder that
  contains both files onto the site's Deploys page. After that WHO (and UNESCO, if it ever blocks) work with no other step.
- Alternative: deploy the provider-proxy function in Supabase (steps above).

UNDP CODES
- Your database already holds UNDP indicators with codes HDR.* (for example HDR.ABR). The monthly job now writes to the
  same HDR.* codes, so it updates those rows and adds the missing ones, instead of creating duplicates.
