-- T-D01, T-D02, T-D10, T-D11 (the grant and index half), T-D15, T-D16 and T-D17 (the database half). DB02, migration 0001.
--
-- Spec lines: S1, A1, A2, A3, A7, A11, D2, D19 and C4 (the role's statement timeout). Everything runs in this transaction
-- and is rolled back.
--
-- The catalogue checks are functions in pg_temp, so each one is run on the real catalogue and again on an object that is
-- deliberately wrong (a test of the test): a check that cannot fail would prove nothing. They look at the schemas public
-- and private only. The schema `tests` (the helpers of supabase/seeds) exists on a local stack alone, its role switches
-- are executable by anon and authenticated on purpose, and the API does not expose it: it is skipped here (tests/README.md
-- section 3).
--
-- A task that adds a callable function adds its name to the list in unnamed_callable_functions() below; a task that adds a
-- table or a function needs no change here: every check walks the catalogue.
begin;
select plan(45);

-- ---------------------------------------------------------------- the catalogue checks
-- Everything in a schema that a role can use, as 'relation s.t', 'sequence s.q' or 'function s.f(args)', sorted.
-- The pseudo-role PUBLIC is asked for with the name 'public'.
create function pg_temp.privs(p_role text, p_schema text) returns text[] language sql as $f$
  select coalesce(array_agg(x order by x), '{}'::text[])
    from (
      select case c.relkind when 'S' then 'sequence ' else 'relation ' end || p_schema || '.' || c.relname as x
        from pg_class c
       where c.relnamespace = to_regnamespace(p_schema)
         and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
         and case when c.relkind = 'S'
                  then has_sequence_privilege(p_role, c.oid, 'USAGE, SELECT, UPDATE')
                  else has_table_privilege(p_role, c.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
                       or has_any_column_privilege(p_role, c.oid, 'SELECT, INSERT, UPDATE, REFERENCES')
             end
      union all
      select 'function ' || p_schema || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
        from pg_proc p
       where p.pronamespace = to_regnamespace(p_schema)
         and has_function_privilege(p_role, p.oid, 'EXECUTE')
    ) s
$f$;

-- Tables of public and private whose row-level security is off.
create function pg_temp.rls_off() returns text[] language sql as $f$
  select coalesce(array_agg(n.nspname || '.' || c.relname order by n.nspname, c.relname), '{}'::text[])
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('public', 'private') and not c.relrowsecurity
$f$;

-- Functions of public and private that do not pin the search_path. A security definer function must pin it to the empty
-- string (A6, T-D10); any other function must pin it to something (advisor lint 0011).
create function pg_temp.fns_without_search_path(p_definer_only boolean) returns text[] language sql as $f$
  select coalesce(array_agg(x order by x), '{}'::text[])
    from (
      select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
         and case when p_definer_only
                  then p.prosecdef and not ('search_path=""' = any (coalesce(p.proconfig, '{}'::text[])))
                  else not exists (select 1 from unnest(coalesce(p.proconfig, '{}'::text[])) c where c like 'search_path=%')
             end
         and not exists (select 1 from pg_depend d where d.classid = 'pg_proc'::regclass and d.objid = p.oid and d.deptype = 'e')
    ) s
$f$;

-- Functions and policies that read the caller's token or a login's metadata. One function may read the metadata of a new
-- login to give it a name (migration 0002, tested in 011_profiles.test.sql); nothing else may, and nothing reads app metadata.
create function pg_temp.metadata_readers() returns text[] language sql as $f$
  select coalesce(array_agg(x order by x), '{}'::text[])
    from (
      select 'function ' || n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
         and (pg_get_functiondef(p.oid) ~* 'user_metadata|app_metadata|auth\.jwt|raw_app_meta_data|request\.jwt\.claim'
              or (pg_get_functiondef(p.oid) ~* 'raw_user_meta_data' and not (n.nspname = 'private' and p.proname = 'handle_new_user')))
      union all
      select 'policy ' || pol.polname || ' on ' || n.nspname || '.' || c.relname
        from pg_policy pol join pg_class c on c.oid = pol.polrelid join pg_namespace n on n.oid = c.relnamespace
       where n.nspname in ('public', 'private', 'storage')
         and coalesce(pg_get_expr(pol.polqual, pol.polrelid), '') || ' ' || coalesce(pg_get_expr(pol.polwithcheck, pol.polrelid), '')
             ~* 'user_metadata|app_metadata|jwt|meta_data'
    ) s
$f$;

-- Functions that authenticated can execute and that are not on the list. The twelve names are the callable functions of
-- section 10 of the spec; the one function of private that authenticated may run is private.app_role().
create function pg_temp.unnamed_callable_functions() returns text[] language sql as $f$
  select coalesce(array_agg(x order by x), '{}'::text[])
    from (
      select n.nspname || '.' || p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' as x
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
       where n.nspname in ('public', 'private') and p.prokind in ('f', 'p')
         and has_function_privilege('authenticated', p.oid, 'EXECUTE')
         and not (n.nspname = 'private' and p.proname = 'app_role')
         and not (n.nspname = 'public' and p.proname in (
               'create_bill', 'record_payment', 'settle_fine', 'void_receipt', 'cancel_bill', 'create_customer',
               'quote_bill', 'create_design', 'set_sku_status', 'reissue_bill', 'issue_refund', 'add_opening_balance'))
    ) s
$f$;

-- Foreign keys of public and private with no index that starts with the key's columns (lint 0001).
create function pg_temp.unindexed_fks() returns text[] language sql as $f$
  select coalesce(array_agg(x order by x), '{}'::text[])
    from (
      select n.nspname || '.' || cl.relname || ' (' || c.conname || ')' as x
        from pg_constraint c
        join pg_class cl on cl.oid = c.conrelid
        join pg_namespace n on n.oid = cl.relnamespace
       where c.contype = 'f' and n.nspname in ('public', 'private')
         and not exists (
           select 1 from pg_index i
            where i.indrelid = c.conrelid and i.indisvalid
              and (i.indkey::smallint[])[0:cardinality(c.conkey) - 1] @> c.conkey
         )
    ) s
$f$;

-- ---------------------------------------------------------------- 1. the schema private (S1, A3 step 3)
select has_schema('private', 'S1: the schema private exists');
select is(
  case when to_regnamespace('private') is null then null else has_schema_privilege('anon', 'private', 'USAGE') end,
  false, 'A3: anon has no USAGE on private');
select is(
  case when to_regnamespace('private') is null then null else has_schema_privilege('authenticated', 'private', 'USAGE') end,
  true, 'A3: authenticated has USAGE on private, so that a policy can call private.app_role()');
select is(
  case when to_regnamespace('private') is null then null else has_schema_privilege('public', 'private', 'USAGE') end,
  false, 'A3: PUBLIC has no USAGE on private');

-- ---------------------------------------------------------------- 2. what exists now (T-D16, T-D02)
select is(pg_temp.privs('anon', 'private'), '{}'::text[], 'T-D16: anon can use nothing in private');
select is(pg_temp.privs('public', 'private'), '{}'::text[], 'T-D16: PUBLIC can use nothing in private');
select is(
  pg_temp.privs('authenticated', 'private'), array['function private.app_role()'],
  'T-D16: authenticated can execute private.app_role() and nothing else in private');
select is(pg_temp.privs('anon', 'public'), '{}'::text[], 'T-D02: anon can read no table or view and run no function in public');
select is(pg_temp.privs('public', 'public'), '{}'::text[], 'T-D02: PUBLIC holds nothing in public either');

-- ---------------------------------------------------------------- 3. what is created later (T-D02, T-D16)
-- From here on the schema is made if migration 0001 is missing, so that the checks below run and fail on their own.
create schema if not exists private;
create table public.jv_t_tbl (id int primary key);
create sequence public.jv_t_seq;
create function public.jv_t_fn() returns int language sql set search_path = '' as 'select 1';
create view public.jv_t_view as select 1 as x;
create materialized view public.jv_t_mv as select 1 as x;
create table private.jv_t_tbl (id int primary key);
create sequence private.jv_t_seq;
create function private.jv_t_fn() returns int language sql set search_path = '' as 'select 1';
create view private.jv_t_view as select 1 as x;

select is(
  pg_temp.privs('anon', 'public'), '{}'::text[],
  'T-D02: a table, sequence, function, view and materialized view created later in public are not granted to anon');
select is(
  array(select x from unnest(pg_temp.privs('authenticated', 'public')) x where x like '%jv_t_%'), '{}'::text[],
  'T-D02: nor to authenticated');
select is(
  pg_temp.privs('public', 'public'), '{}'::text[],
  'T-D02: nor to PUBLIC (the built-in execute right of a new function is gone: the global form of A3 step 1)');
select is(
  has_table_privilege('service_role', 'public.jv_t_tbl', 'SELECT, INSERT, UPDATE, DELETE')
  and has_function_privilege('service_role', 'public.jv_t_fn()', 'EXECUTE')
  and has_sequence_privilege('service_role', 'public.jv_t_seq', 'USAGE'),
  true, 'A3: service_role keeps its default access to what is created in public');
select is(pg_temp.privs('anon', 'private'), '{}'::text[], 'T-D16: a table, sequence, function and view created later in private are not granted to anon');
select is(
  pg_temp.privs('authenticated', 'private'), array['function private.app_role()'],
  'T-D16: nor to authenticated');
select is(pg_temp.privs('public', 'private'), '{}'::text[], 'T-D16: nor to PUBLIC');

grant execute on function public.jv_t_fn() to authenticated;
select is(
  has_function_privilege('authenticated', 'public.jv_t_fn()', 'EXECUTE')
  and not has_function_privilege('anon', 'public.jv_t_fn()', 'EXECUTE'),
  true, 'A6: a function created after 0001 is callable by authenticated once it is granted, and still not by anon');

-- the checks themselves: they must see a grant that should not be there
grant select on public.jv_t_tbl to anon;
select is(pg_temp.privs('anon', 'public'), array['relation public.jv_t_tbl'], 'the check sees a table granted to anon');
revoke select on public.jv_t_tbl from anon;
grant update (id) on public.jv_t_tbl to anon;
select is(pg_temp.privs('anon', 'public'), array['relation public.jv_t_tbl'], 'the check sees a single column granted to anon');
revoke update (id) on public.jv_t_tbl from anon;
grant execute on function private.jv_t_fn() to authenticated;
select is(
  pg_temp.privs('authenticated', 'private'), array['function private.app_role()', 'function private.jv_t_fn()'],
  'the check sees a second private function granted to authenticated');
revoke execute on function private.jv_t_fn() from authenticated;

-- ---------------------------------------------------------------- 4. row-level security (T-D01, A1)
create table public.jv_t_ctas as select 1 as id;
select 1 as id into private.jv_t_into;
create table public.jv_t_like (like public.jv_t_tbl including all);
create table public.jv_t_parent (id int, d date) partition by range (d);
create table public.jv_t_child partition of public.jv_t_parent for values from ('2026-01-01') to ('2027-01-01');
create schema jv_t_other;
create table jv_t_other.t (id int);
create temp table jv_t_tmp (id int);
create role jv_t_creator nologin;
grant jv_t_creator to postgres with inherit true, set true;
grant create, usage on schema public to jv_t_creator;
set local role jv_t_creator;
create table public.jv_t_by_role (id int);
reset role;

select is(pg_temp.rls_off(), '{}'::text[], 'T-D01: every table in public and private has row-level security on');
select is(
  array(select relname::text from pg_class
         where relnamespace = 'public'::regnamespace and relkind in ('r', 'p') and relname like 'jv_t_%' and not relrowsecurity
         order by 1),
  '{}'::text[], 'T-D01: a table created later in public gets row-level security from the event trigger (create table, as, like, partitioned table, partition)');
select is(
  array(select relname::text from pg_class
         where relnamespace = to_regnamespace('private') and relkind in ('r', 'p') and relname like 'jv_t_%' and not relrowsecurity
         order by 1),
  '{}'::text[], 'T-D01: ... and in private (create table, select into)');
select is(
  (select relrowsecurity from pg_class where oid = 'public.jv_t_by_role'::regclass),
  true, 'T-D01: also a table made by another role, which has no right to run the trigger function');
select is(
  (select relrowsecurity from pg_class where oid = 'jv_t_other.t'::regclass),
  false, 'T-D01: a table in another schema is left alone (the trigger covers public and private)');
select is(
  (select relrowsecurity from pg_class where oid = 'pg_temp.jv_t_tmp'::regclass),
  false, 'T-D01: a temporary table is left alone');
select ok(
  exists (
    select 1 from pg_event_trigger e join pg_proc p on p.oid = e.evtfoid join pg_namespace n on n.oid = p.pronamespace
     where e.evtevent = 'ddl_command_end' and e.evtenabled = 'O' and n.nspname = 'private'),
  'A1: an enabled event trigger on ddl_command_end runs a function in private');

alter table public.jv_t_tbl disable row level security;
select is(pg_temp.rls_off(), array['public.jv_t_tbl'], 'the check sees a table with row-level security off');
alter table public.jv_t_tbl enable row level security;

-- ---------------------------------------------------------------- 5. search_path of every function (T-D10, lint 0011)
select is(pg_temp.fns_without_search_path(true), '{}'::text[], 'T-D10: every security definer function in public and private has search_path = ''''');
select is(pg_temp.fns_without_search_path(false), '{}'::text[], 'lint 0011: every function in public and private pins its search_path');

create function private.jv_t_bad1() returns int language sql security definer as 'select 1';
create function private.jv_t_bad2() returns int language sql security definer set search_path = public as 'select 1';
create function private.jv_t_bad3() returns int language sql set search_path = '' as 'select 1';
create function private.jv_t_bad4() returns int language sql as 'select 1';
select is(
  pg_temp.fns_without_search_path(true), array['private.jv_t_bad1()', 'private.jv_t_bad2()'],
  'the check sees a definer function with no search_path and one whose search_path is not empty');
select is(
  pg_temp.fns_without_search_path(false), array['private.jv_t_bad1()', 'private.jv_t_bad4()'],
  'and, for lint 0011, a function with no search_path at all (a path that is set but not empty is a fault of definer functions only)');
drop function private.jv_t_bad1(), private.jv_t_bad2(), private.jv_t_bad3(), private.jv_t_bad4();

-- ---------------------------------------------------------------- 6. no metadata, no token (T-D15, A2)
select is(pg_temp.metadata_readers(), '{}'::text[], 'T-D15: no function body or policy reads user_metadata, app_metadata or auth.jwt()');

create function private.jv_t_meta1() returns text language sql set search_path = '' as $b$ select auth.jwt() -> 'app_metadata' ->> 'role' $b$;
create function private.jv_t_meta2() returns text language sql set search_path = '' as $b$ select current_setting('request.jwt.claims', true) $b$;
create function private.jv_t_meta3() returns text language sql set search_path = '' as $b$ select raw_user_meta_data ->> 'role' from auth.users limit 1 $b$;
create function private.jv_t_clean() returns text language sql set search_path = '' as $b$ select (select auth.uid())::text $b$;
create table public.jv_t_pol (id int);
create policy jv_t_pol_p on public.jv_t_pol for select to authenticated using ((auth.jwt() -> 'user_metadata' ->> 'role') = 'owner');
select is(
  pg_temp.metadata_readers(),
  array['function private.jv_t_meta1()', 'function private.jv_t_meta2()', 'function private.jv_t_meta3()', 'policy jv_t_pol_p on public.jv_t_pol'],
  'the check sees a function that reads app_metadata, one that reads the token claims, one that reads a login''s metadata, and a policy that reads user_metadata');
drop policy jv_t_pol_p on public.jv_t_pol;
drop function private.jv_t_meta1(), private.jv_t_meta2(), private.jv_t_meta3(), private.jv_t_clean();

-- ---------------------------------------------------------------- 7. the advisor's rules, as grants (T-D11, A7, X13)
-- The local advisor does not report lints 0028 and 0029, so these catalogue checks stand in for them; the advisor itself
-- runs in `npm run db:check`.
select is(
  array(select x from unnest(pg_temp.privs('anon', 'public') || pg_temp.privs('anon', 'private')) x where x like 'function %'),
  '{}'::text[], 'T-D11 (lint 0028): no function in public or private is executable by anon');
select is(
  pg_temp.unnamed_callable_functions(), array['public.jv_t_fn()'],
  'T-D11 (lint 0029): authenticated can execute only the named functions: the check sees one that is not on the list');
revoke execute on function public.jv_t_fn() from authenticated;
select is(
  pg_temp.unnamed_callable_functions(), '{}'::text[],
  'T-D11 (lint 0029): authenticated can execute only the named functions (private.app_role() and the twelve of section 10)');
select is(
  case when to_regprocedure('private.app_role()') is null then null
       else has_function_privilege('authenticated', 'private.app_role()', 'EXECUTE') end,
  true, 'D2: private.app_role() is executable by authenticated');

select is(pg_temp.unindexed_fks(), '{}'::text[], 'T-D11 (lint 0001, D19): no foreign key in public or private lacks an index');
create table public.jv_t_fk (id int primary key, parent int references public.jv_t_tbl (id));
select is(pg_temp.unindexed_fks(), array['public.jv_t_fk (jv_t_fk_parent_fkey)'], 'the check sees a foreign key with no index');
create index on public.jv_t_fk (parent);
select is(pg_temp.unindexed_fks(), '{}'::text[], 'and accepts it once an index starts with the key''s column');
create table public.jv_t_two (a int, b int, unique (a, b));
create table public.jv_t_fk2 (id int primary key, x int, y int, foreign key (x, y) references public.jv_t_two (a, b));
create index on public.jv_t_fk2 (y);
select is(pg_temp.unindexed_fks(), array['public.jv_t_fk2 (jv_t_fk2_x_y_fkey)'], 'an index that does not start with the key''s columns does not count');
create index on public.jv_t_fk2 (y, x, id);
select is(pg_temp.unindexed_fks(), '{}'::text[], 'a longer index counts when its first columns are the key''s, in either order');

-- ---------------------------------------------------------------- 8. GraphQL and the role's timeout (T-D17, A11, C4)
select hasnt_extension('pg_graphql', 'T-D17: the GraphQL extension is not installed (A11)');
select ok(
  'statement_timeout=15s' = any (coalesce((select rolconfig from pg_roles where rolname = 'authenticated'), '{}'::text[])),
  'C4: the role authenticated has statement_timeout = 15s (a set local inside a function would not shorten the call already running)');

select * from finish();
rollback;
