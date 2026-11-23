-- Office AI: each business, its people, what Agent did for them, and their files.
-- Paste this whole file into Supabase -> SQL Editor -> Run (the same project as schema.sql). Safe to run again.
--
-- Walls between businesses: every row carries the business's chat_id, and the rules at the bottom only ever
-- show a signed-in person rows from THEIR OWN business (owners see their whole business, employees see their
-- own work). Nobody signed out sees anything. The website can never write here: only the agent server can,
-- with the service key, after its own checks.

create extension if not exists citext;

-- 1. The business. chat_id is the same id the agent already uses for it (tenant_users.chat_id).
create table if not exists public.office_businesses (
  chat_id    text primary key,
  name       text not null check (length(name) between 1 and 80),
  accent     text check (accent ~ '^#[0-9a-fA-F]{6}$'),     -- the company's color on the dashboard and the bar
  created_at timestamptz not null default now()
);

-- 2. The people. One email belongs to ONE business, ever (unique). The owner adds people by email; the person
--    sets their own password when they accept (the owner never sees it). "removed" cuts off access at once.
create table if not exists public.office_members (
  id         bigint generated always as identity primary key,
  chat_id    text   not null references public.office_businesses (chat_id) on delete cascade,
  email      citext not null unique,
  user_id    uuid   unique references auth.users (id) on delete set null,   -- filled in when they first sign in
  name       text   check (name is null or length(name) <= 80),
  role       text   not null default 'employee' check (role in ('owner', 'employee')),
  status     text   not null default 'invited' check (status in ('invited', 'active', 'removed')),
  invited_at timestamptz not null default now(),
  joined_at  timestamptz
);
create index if not exists office_members_chat on public.office_members (chat_id);

-- 3. What Agent did: one row per task. The employee's request in their own words (SSNs and card numbers
--    hidden), the site it was on, and each step's name and whether it worked. Never the page's contents and
--    never the values typed into anything.
create table if not exists public.office_activity (
  id       bigint generated always as identity primary key,
  ts       timestamptz not null default now(),
  chat_id  text   not null references public.office_businesses (chat_id) on delete cascade,
  user_id  uuid,
  email    citext,
  request  text   check (request is null or length(request) <= 500),
  site     text   check (site is null or length(site) <= 120),
  outcome  text   not null check (outcome in ('done', 'partial', 'failed', 'cancelled')),
  approval text   not null check (approval in ('approved', 'auto', 'denied')),
  steps    jsonb  not null default '[]'::jsonb,   -- [{ "what": "Fill “Subject”", "ok": true }]
  done     smallint not null default 0,
  total    smallint not null default 0
);
create index if not exists office_activity_chat_ts on public.office_activity (chat_id, ts desc);
create index if not exists office_activity_user_ts on public.office_activity (chat_id, user_id, ts desc);

-- 4. Files: what employees upload ("put these numbers in the sheet") and what Agent hands back. The file itself
--    lives in the private "office-files" storage bucket at <chat_id>/<file id>/<name>; this is the list.
create table if not exists public.office_files (
  id       uuid primary key default gen_random_uuid(),
  ts       timestamptz not null default now(),
  chat_id  text   not null references public.office_businesses (chat_id) on delete cascade,
  user_id  uuid,
  email    citext,
  name     text   not null check (length(name) between 1 and 200),
  size     bigint not null check (size >= 0 and size <= 26214400),   -- 25 MB at most
  mime     text,
  path     text   not null unique,
  purpose  text   not null default 'upload' check (purpose in ('upload', 'result')),
  task_id  bigint references public.office_activity (id) on delete set null
);
create index if not exists office_files_chat_ts on public.office_files (chat_id, ts desc);

insert into storage.buckets (id, name, public, file_size_limit)
values ('office-files', 'office-files', false, 26214400)
on conflict (id) do nothing;

-- ---------------------------------------------------------------- who can see what
-- Your role in a business (owner / employee), or nothing if you're not an active member of it.
create or replace function public.office_role(cid text) returns text
language sql stable security definer set search_path = public as $$
  select role from public.office_members
  where chat_id = cid and user_id = auth.uid() and status = 'active'
  limit 1
$$;
revoke all on function public.office_role(text) from public, anon;
grant execute on function public.office_role(text) to authenticated;

alter table public.office_businesses enable row level security;
alter table public.office_members    enable row level security;
alter table public.office_activity   enable row level security;
alter table public.office_files      enable row level security;

drop policy if exists "members see their business" on public.office_businesses;
create policy "members see their business" on public.office_businesses
  for select to authenticated using (public.office_role(chat_id) is not null);

drop policy if exists "owners see the team, people see themselves" on public.office_members;
create policy "owners see the team, people see themselves" on public.office_members
  for select to authenticated using (public.office_role(chat_id) = 'owner' or user_id = auth.uid());

drop policy if exists "owners see all work, people see their own" on public.office_activity;
create policy "owners see all work, people see their own" on public.office_activity
  for select to authenticated using (public.office_role(chat_id) = 'owner' or (user_id = auth.uid() and public.office_role(chat_id) is not null));

drop policy if exists "owners see all files, people see their own" on public.office_files;
create policy "owners see all files, people see their own" on public.office_files
  for select to authenticated using (public.office_role(chat_id) = 'owner' or (user_id = auth.uid() and public.office_role(chat_id) is not null));

-- the files themselves follow the same rule as their row in office_files
drop policy if exists "office files: same as their list row" on storage.objects;
create policy "office files: same as their list row" on storage.objects
  for select to authenticated using (
    bucket_id = 'office-files' and exists (
      select 1 from public.office_files f
      where f.path = storage.objects.name
        and (public.office_role(f.chat_id) = 'owner' or (f.user_id = auth.uid() and public.office_role(f.chat_id) is not null))
    )
  );

-- No insert / update / delete rules on purpose: only the agent server writes (service key), after its checks.
revoke all on public.office_businesses, public.office_members, public.office_activity, public.office_files from anon;

-- ---------------------------------------------------------------- set up Demo Office (edit, then run once)
-- 1) Your business id: the chat_id your own login already uses. Find it with:
--      select chat_id from public.tenant_users where user_id = (select id from auth.users where email = 'YOU@EXAMPLE.COM');
-- 2) Put it and your email below, remove the leading "--" on the three lines, and run them.
--
-- insert into public.office_businesses (chat_id, name, accent) values ('YOUR_CHAT_ID', 'Demo Office', '#3b5bdb') on conflict (chat_id) do update set name = excluded.name, accent = excluded.accent;
-- insert into public.office_members (chat_id, email, role, status) values ('YOUR_CHAT_ID', 'YOU@EXAMPLE.COM', 'owner', 'active') on conflict (email) do nothing;
-- update public.office_members m set user_id = u.id, joined_at = coalesce(m.joined_at, now()) from auth.users u where u.email = m.email and m.user_id is null;
