-- Biz_agent self-serve linking, step 1. Paste this whole file into Supabase -> SQL Editor -> Run.
-- Safe to run more than once.
--
-- How it works: a logged-in person asks for a one-time code. The code is tied to THEIR login only.
-- When they tap their personal Telegram link, the bot looks the code up, ties that Telegram chat to
-- their login (in tenant_users), and deletes the code. Codes expire after 30 minutes.

-- 1. The codes. Nobody on the website can read or write this table directly; only the bot (service key)
--    and the function below can.
create table if not exists public.link_codes (
  code       text primary key default replace(gen_random_uuid()::text, '-', ''),
  user_id    uuid not null unique references auth.users (id) on delete cascade,
  email      text,                                   -- shown back in Telegram so a wrong link is obvious
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes'
);
alter table public.link_codes enable row level security;   -- on, with no policies = closed to the website
revoke all on public.link_codes from anon, authenticated;

-- 2. "Give me a code for my own login." Runs with the caller's identity (auth.uid()), so nobody can ask
--    for a code on someone else's behalf. One live code per person: asking again replaces the old one.
--    Returns null if this login is already linked to an agent.
create or replace function public.create_link_code()
returns text
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  uid      uuid := auth.uid();
  new_code text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if exists (select 1 from public.tenant_users where user_id = uid) then return null; end if;
  delete from public.link_codes where user_id = uid or expires_at < now();
  insert into public.link_codes (user_id, email)
    values (uid, (select email from auth.users where id = uid))
    returning code into new_code;
  return new_code;
end;
$$;
revoke all on function public.create_link_code() from public, anon;
grant execute on function public.create_link_code() to authenticated;
