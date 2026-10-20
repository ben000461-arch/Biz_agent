-- Biz_agent self-serve sign-ups with approval, step 3a. Run AFTER link-codes.sql.
-- Paste this whole file into Supabase -> SQL Editor -> Run. Safe to run more than once.
--
-- How it works: the sign-up form's answers travel with the new account. A database trigger copies them
-- into a "signups" row marked PENDING. When the person confirms their email, the row is marked confirmed
-- (so fake emails never bother you). The bot tells you about confirmed sign-ups and you approve or deny
-- in Telegram. Only APPROVED people can get a link code. Nobody on the website can change a status.

-- 1. The sign-ups.
create table if not exists public.signups (
  user_id       uuid primary key references auth.users (id) on delete cascade,
  email         text,
  use_case      text not null default 'other' check (use_case in ('tasks', 'dev', 'both', 'other')),
  business_type text,
  business_name text,
  notes         text,
  status        text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  confirmed     boolean not null default false,   -- email confirmed
  notified      boolean not null default false,   -- the bot has told you about it
  created_at    timestamptz not null default now(),
  decided_at    timestamptz
);
create index if not exists signups_to_announce on public.signups (confirmed, notified, status);
alter table public.signups enable row level security;
drop policy if exists "read own signup" on public.signups;
create policy "read own signup" on public.signups for select to authenticated using (user_id = auth.uid());
revoke all on public.signups from anon, authenticated;
grant select on public.signups to authenticated;      -- read only, and only their own row (policy above)

-- 2. Everyone who already has a login (you) is approved, so nothing changes for existing accounts.
insert into public.signups (user_id, email, business_name, status, confirmed, notified, decided_at)
select id, email, '(existing login)', 'approved', true, true, now() from auth.users
on conflict (user_id) do nothing;

-- 3. New account -> pending signup. The answers are cleaned and cut to length here, whatever the browser sent.
--    If this ever fails, the account is still created but gets no row, and with no row it can't be approved.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  m  jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  uc text  := lower(coalesce(m->>'use_case', 'other'));
begin
  if uc not in ('tasks', 'dev', 'both', 'other') then uc := 'other'; end if;
  insert into public.signups (user_id, email, use_case, business_type, business_name, notes, confirmed)
  values (
    new.id, new.email, uc,
    left(btrim(regexp_replace(coalesce(m->>'business_type', ''), '[\r\n\t]+', ' ', 'g')), 80),
    left(btrim(regexp_replace(coalesce(m->>'business_name', ''), '[\r\n\t]+', ' ', 'g')), 60),
    left(btrim(coalesce(m->>'notes', '')), 500),
    new.email_confirmed_at is not null
  ) on conflict (user_id) do nothing;
  return new;
exception when others then
  raise warning 'handle_new_user: %', sqlerrm;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute function public.handle_new_user();

-- 4. Email confirmed -> signup confirmed.
create or replace function public.handle_user_confirmed()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.signups set confirmed = true where user_id = new.id;
  return new;
exception when others then
  raise warning 'handle_user_confirmed: %', sqlerrm;
  return new;
end $$;
drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed after update of email_confirmed_at on auth.users
  for each row when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function public.handle_user_confirmed();

-- 5. Link codes are now only for APPROVED people (replaces the version from link-codes.sql).
--    Returns null if not approved yet, or if the login is already linked.
create or replace function public.create_link_code()
returns text language plpgsql security definer set search_path = public, auth as $$
declare
  uid      uuid := auth.uid();
  new_code text;
begin
  if uid is null then raise exception 'not signed in'; end if;
  if not exists (select 1 from public.signups where user_id = uid and status = 'approved') then return null; end if;
  if exists (select 1 from public.tenant_users where user_id = uid) then return null; end if;
  delete from public.link_codes where user_id = uid or expires_at < now();
  insert into public.link_codes (user_id, email)
    values (uid, (select email from auth.users where id = uid))
    returning code into new_code;
  return new_code;
end $$;
revoke all on function public.create_link_code() from public, anon;
grant execute on function public.create_link_code() to authenticated;
