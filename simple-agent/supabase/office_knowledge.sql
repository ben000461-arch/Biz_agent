-- Office knowledge: notes and files a business gives its Agent. Run once in Supabase → SQL Editor,
-- after office.sql. Safe to run again.
--
-- Employees' submissions wait for the owner's approval; only approved ones reach the AI.
-- Nobody signed in reads this table directly: the agent server (service key) does all reads and writes,
-- and checks who's asking. So: row security ON, and no policies that let a signed-in person in.

create table if not exists public.office_knowledge (
  id          uuid primary key,
  ts          timestamptz not null default now(),
  chat_id     text   not null references public.office_businesses (chat_id) on delete cascade,
  user_id     uuid,
  email       citext,
  kind        text   not null check (kind in ('note', 'file')),
  title       text   not null check (length(title) between 1 and 120),
  body        text   check (body is null or length(body) <= 100000),   -- the note, or the text read from the file
  file_name   text   check (file_name is null or length(file_name) <= 80),
  size        bigint check (size is null or (size >= 0 and size <= 10485760)), -- 10 MB at most
  mime        text,
  path        text   unique,                                              -- in the private "office-files" bucket
  status      text   not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_at timestamptz,
  reviewed_by citext,
  review_note text   check (review_note is null or length(review_note) <= 300)
);
create index if not exists office_knowledge_chat_status_ts on public.office_knowledge (chat_id, status, ts desc);
create index if not exists office_knowledge_user_ts on public.office_knowledge (chat_id, user_id, ts desc);

alter table public.office_knowledge enable row level security;
revoke all on public.office_knowledge from anon, authenticated;

-- check: should list the table with row security on
select relname, relrowsecurity from pg_class where relname = 'office_knowledge';
