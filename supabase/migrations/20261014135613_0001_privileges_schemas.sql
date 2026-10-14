-- 0001 privileges and schemas (task DB02). Spec: S1, A1, A3, A11, C4.
-- Tests: supabase/tests/database/010_privileges.test.sql (T-D01, T-D02, T-D10, T-D11, T-D15, T-D16, T-D17).
--
-- On Supabase, until something is revoked, everything the role postgres creates in public is reachable through the API by
-- anon, authenticated and service_role, and every new function is executable by everybody (PUBLIC). The four statements on
-- the securing-your-api page are all written "in schema public" and, for functions, they are not enough: the built-in
-- right of PUBLIC survives them, so a later function in public or private would stay callable by anon and authenticated.
-- This file removes the defaults in the order of A3 (tested on the Supabase image on 14 October 2026), and later
-- migrations grant what they need, explicitly, one object at a time (A3 step 4, A4, A6).

-- ---------------------------------------------------------------- the schema private (S1)
-- Helpers, counters, the idempotency log, audit functions and the nightly check live here. The API never exposes it
-- (api.schemas = ["public"] in supabase/config.toml and in the hosted project's settings, checked in DB21).
create schema if not exists private;
comment on schema private is 'Helpers and private tables of JewelVault. Not exposed through the API. The only function the signed-in role may run here is private.app_role() (A3, D2).';

-- ---------------------------------------------------------------- A3 step 1: default privileges
-- The global form, with no "in schema": it takes away the built-in execute right of PUBLIC from every function that
-- postgres creates later, in any schema (public, private and the rest).
alter default privileges for role postgres revoke execute on functions from public;
-- The schema form: the Supabase defaults that give anon and authenticated a right on every new object in public.
alter default privileges for role postgres in schema public revoke all on tables from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on sequences from anon, authenticated;
alter default privileges for role postgres in schema public revoke all on functions from anon, authenticated;
-- service_role keeps its default access: the platform's own services use it and no service key reaches the browser.

-- ---------------------------------------------------------------- A3 step 2: objects that already exist
revoke all on all tables in schema public from anon, authenticated;
revoke all on all sequences in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

-- ---------------------------------------------------------------- A3 step 3: the schema private
-- anon gets no USAGE at all. authenticated gets USAGE so that a policy can call private.app_role(); it can use nothing
-- else here. The one grant that follows, "grant execute on function private.app_role() to authenticated", is in migration
-- 0002 because the function is made there.
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
revoke all on all sequences in schema private from public, anon, authenticated;
revoke all on all functions in schema private from public, anon, authenticated;

-- ---------------------------------------------------------------- A1: row-level security on every table, twice
-- The first time is the statement "alter table ... enable row level security" that every migration runs for the tables it
-- makes (S9). The second is this event trigger: it enables row-level security on any table created later in public or in
-- private, whoever creates it and however (CREATE TABLE, CREATE TABLE AS, SELECT INTO, LIKE, a partitioned table and its
-- partitions). The example on the event-triggers page of the Supabase docs covers public only. Tables in other schemas and
-- temporary tables are left alone.
--
-- The function runs with the rights of whoever creates the table, who owns it and so may alter it, and it needs no
-- EXECUTE right (an event trigger function is not checked for one when it fires). Nothing is filtered in the CREATE EVENT
-- TRIGGER statement: the tags are tested inside the function, because the file check of S9 (scripts/check-migrations.sh)
-- reads the words that start a table definition followed by a name in any string of a migration, not only in the
-- statements, and would take the tag list for a table that needs a statement of its own.
create or replace function private.enable_rls_on_new_tables()
returns event_trigger
language plpgsql
set search_path = ''
as $$
declare
  cmd record;
begin
  for cmd in
    select c.schema_name, c.object_identity
      from pg_catalog.pg_event_trigger_ddl_commands() c
     where c.object_type in ('table', 'partitioned table')
       and (c.command_tag like 'CREATE %' or c.command_tag = 'SELECT INTO')
       and c.schema_name in ('public', 'private')
  loop
    begin
      execute pg_catalog.format('alter table if exists %s enable row level security', cmd.object_identity);
    exception when others then
      -- Never stop the statement that made the table; the check of T-D01 fails the build if the table is left unprotected.
      raise warning 'enable_rls_on_new_tables: could not enable row level security on %: %', cmd.object_identity, sqlerrm;
    end;
  end loop;
end
$$;
revoke all on function private.enable_rls_on_new_tables() from public, anon, authenticated;
comment on function private.enable_rls_on_new_tables() is 'A1: event trigger function. Enables row-level security on every table created in public or private.';

create event trigger jv_enable_rls on ddl_command_end execute function private.enable_rls_on_new_tables();

-- ---------------------------------------------------------------- C4 (RF-2): the role's statement timeout
-- The platform gives authenticated 8 seconds. A function that writes money may need longer under load, and a "set local
-- statement_timeout" inside a function does not shorten the call that is already running, so the bound on a whole call is
-- the role's own setting. PostgREST reads role settings when it loads its configuration; the notify makes a running API
-- load them again (tested in tests/db/auth.test.ts: the next request sees the new value).
alter role authenticated set statement_timeout = '15s';
notify pgrst, 'reload config';

-- ---------------------------------------------------------------- A11: GraphQL is not used
-- Hosted projects ship with the pg_graphql extension; the local stack does not install it. The API does not expose
-- graphql_public either (api.schemas), so this removes the extension itself.
drop extension if exists pg_graphql;
