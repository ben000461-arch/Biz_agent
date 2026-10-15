-- Biz_agent action log. Paste this whole file into Supabase -> SQL Editor -> Run.
-- Use a NEW Supabase project for this (not the co|op / -syphir one).

-- 1. What the agent did. Metadata only: no message text, email bodies or file contents.
create table if not exists public.agent_logs (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  chat_id   text        not null,          -- which Telegram chat (business) it belongs to
  business  text,                          -- display name at the time
  kind      text        not null check (kind in ('action','chat','command','blocked','error')),
  action    text,                          -- e.g. draft_email, list_events, code_task
  status    text,                          -- done | asked | cancelled | blocked | failed
  detail    text,                          -- short, code-written (repo or file name), never user text
  proposed  text,                          -- what the router first picked (for blocked rows)
  reason    text,                          -- why it was blocked, in plain words
  ms        integer
);
create index if not exists agent_logs_chat_ts on public.agent_logs (chat_id, ts desc);

-- 2. Which website login owns which Telegram chat. You fill this in by hand for now.
create table if not exists public.tenant_users (
  user_id uuid primary key references auth.users (id) on delete cascade,
  chat_id text not null
);

-- 3. Row-level security: a logged-in person can read ONLY their own chat's rows.
--    There is no insert/update/delete policy, so the website can never write.
--    The bot writes with the service key, which bypasses these rules.
alter table public.agent_logs   enable row level security;
alter table public.tenant_users enable row level security;

drop policy if exists "read own mapping" on public.tenant_users;
create policy "read own mapping" on public.tenant_users
  for select to authenticated
  using (user_id = auth.uid());

drop policy if exists "read own logs" on public.agent_logs;
create policy "read own logs" on public.agent_logs
  for select to authenticated
  using (chat_id in (select chat_id from public.tenant_users where user_id = auth.uid()));

-- Nobody who is signed out (the "anon" role) gets anything.
revoke all on public.agent_logs   from anon;
revoke all on public.tenant_users from anon;
