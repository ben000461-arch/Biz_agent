-- Office rules: what an office's owner lets Agent do (rules.js). Run once in Supabase → SQL Editor,
-- after office.sql. Safe to run again.
--
-- Stored on the business row. Empty means "the defaults" (any site; small safe steps may run on their own;
-- Agent never pays or buys). Only the agent server writes it, after checking the person is the owner;
-- the agent server also enforces it on every plan, for everyone in the office.

alter table public.office_businesses add column if not exists rules jsonb not null default '{}'::jsonb;
alter table public.office_businesses drop constraint if exists office_businesses_rules_size;
alter table public.office_businesses add constraint office_businesses_rules_size check (pg_column_size(rules) <= 16384);

-- check: should show the new column
select column_name, data_type from information_schema.columns where table_name = 'office_businesses' and column_name = 'rules';
