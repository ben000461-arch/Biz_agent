-- Biz_agent plans and credits. Paste this whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once. Use the SAME Supabase project as schema.sql (biz-agent).
--
-- tenant_plans  : which plan each Telegram chat (business) is on, and when it ends.
-- credit_ledger : every credit granted, spent or topped up. Balance = sum of the current cycle.
--
-- Customers (logged in on the website) can READ their own rows and nothing else. Only the bot, using
-- the service key, can write. No message text is ever stored here.

-- 1. Plans -----------------------------------------------------------------------------------------
create table if not exists public.tenant_plans (
  chat_id       text primary key,
  plan          text not null default 'trial'
                  check (plan in ('trial','starter','pro','business','pilot','frozen')),
  ends_at       timestamptz,                  -- trial end, pilot end, or end of the paid period (null = no end, set by hand)
  cycle_anchor  date not null default current_date,  -- billing day-of-month: credits reset on this day each month
  last_reminder integer,                       -- last trial reminder sent (day 25 / 28 / 30) so it is only sent once
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- 2. Credit ledger ---------------------------------------------------------------------------------
create table if not exists public.credit_ledger (
  id        bigint generated always as identity primary key,
  ts        timestamptz not null default now(),
  chat_id   text    not null,
  cycle     date    not null,                  -- the billing cycle this entry belongs to (top-ups expire with it)
  delta     integer not null,                  -- + grant / top-up / refund, - spend
  reason    text    not null check (reason in ('grant','topup','spend','refund','adjust')),
  action    text,                              -- e.g. draft_email, chat (code-written, never user text)
  model     text,                              -- which model answered, e.g. the 70B
  ref       text                               -- short code-written note (e.g. 'monthly grant')
);
create index if not exists credit_ledger_chat_cycle on public.credit_ledger (chat_id, cycle, ts desc);
-- One monthly grant per chat per cycle, even if two messages race to create it.
create unique index if not exists credit_ledger_one_grant
  on public.credit_ledger (chat_id, cycle) where reason = 'grant';

-- 3. Row-level security: read your own rows only; nobody on the website can write ----------------
alter table public.tenant_plans  enable row level security;
alter table public.credit_ledger enable row level security;

drop policy if exists "read own plan" on public.tenant_plans;
create policy "read own plan" on public.tenant_plans
  for select to authenticated
  using (chat_id in (select chat_id from public.tenant_users where user_id = auth.uid()));

drop policy if exists "read own credits" on public.credit_ledger;
create policy "read own credits" on public.credit_ledger
  for select to authenticated
  using (chat_id in (select chat_id from public.tenant_users where user_id = auth.uid()));

-- No insert/update/delete policies exist, so the website can never change a plan or a balance.
revoke all on public.tenant_plans  from anon;
revoke all on public.credit_ledger from anon;
revoke insert, update, delete on public.tenant_plans  from authenticated;
revoke insert, update, delete on public.credit_ledger from authenticated;

-- 4. Put your first pilot customer on the pilot plan (edit the chat id, then run just this line).
--    Your own admin chat needs no row: the bot treats the admin as unlimited.
-- insert into public.tenant_plans (chat_id, plan) values ('PUT-HIS-CHAT-ID-HERE', 'pilot')
--   on conflict (chat_id) do update set plan = 'pilot', ends_at = null, updated_at = now();
