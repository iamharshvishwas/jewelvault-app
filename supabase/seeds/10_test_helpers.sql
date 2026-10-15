-- LOCAL ONLY. Test helpers for pgTAP and for the Vitest two-connection tests (the `tests` schema).
--
-- Runs after 00_guard.sql and after every migration (supabase db reset). It is never part of a migration, so dev and
-- prod never get it (spec S9, H5, D20). The guard is repeated here in case this file is ever run on its own.
--
-- THIS FILE IS SHARED. DB01 wrote the block below. A later task adds its own helpers in a block of its own after the
-- last one, between a BEGIN <task> and an END <task> comment line, and touches nothing above it. Rules for every block:
--   * a helper is `security invoker` and pins its search_path (advisor lint 0011 reads this schema too);
--   * a helper that a signed-in role must be able to call (only the three role switches) is granted explicitly; every
--     other helper stays postgres-only (migration 0001 removes the default PUBLIC execute right from new functions);
--   * the helper reads tables and functions that later tasks create only through dynamic SQL or plpgsql, and says which
--     task creates what it needs when it is missing, so this file keeps loading on an empty schema.

do $guard$
declare
  v_secret text := current_setting('app.settings.jwt_secret', true);
begin
  if v_secret is null
     or encode(sha256(convert_to(v_secret, 'utf8')), 'hex')
        is distinct from 'a064b502e61d27e94b8717290e5e1b32e36720e9fbdf952ec81a84c07128cb37' then
    raise exception 'seed guard: refusing to run the seeds on a database whose JWT secret is not the local default'
      using hint = 'These seeds are for the local Supabase stack only (npm run db:reset). Never run them on a hosted project. On a local stack after a CLI upgrade, the digest here no longer matches the CLI default.';
  end if;
end
$guard$;

-- ===== BEGIN DB01 (test harness) =====

create schema if not exists tests;
grant usage on schema tests to anon, authenticated, service_role;

-- A counter for the builders, so two fixtures never collide on a unique code.
create sequence if not exists tests.seq;

create or replace function tests.next_n() returns bigint
language sql volatile set search_path = ''
as $f$ select nextval('tests.seq') $f$;

-- ----------------------------------------------------------------------------------------------- identities

-- A login for a pgTAP test: an auth.users row (every token column set, because the Auth service answers 500 on a row
-- where one is null) with its email identity, and its profile once profiles exist. The password is random and thrown
-- away: a real login is made through the Auth admin API (tests/db/rpc.ts).
--   p_role: owner | biller | staff   an active profile with that role
--           inactive                 the inactive staff profile the new-user trigger makes
--           none                     a login with no profile at all
create or replace function tests.make_user(
  p_role text default 'owner',
  p_email text default null,
  p_full_name text default null
) returns uuid
language plpgsql set search_path = ''
as $f$
declare
  v_id uuid := gen_random_uuid();
  v_email text := coalesce(p_email, 'user-' || replace(v_id::text, '-', '') || '@jv-test.local');
  v_name text := coalesce(p_full_name, 'Test ' || coalesce(p_role, '?') || ' ' || substr(v_id::text, 1, 4));
begin
  if p_role is null or p_role not in ('owner', 'biller', 'staff', 'inactive', 'none') then
    raise exception 'tests.make_user: role must be owner, biller, staff, inactive or none, not %', coalesce(p_role, 'null');
  end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, recovery_token, email_change_token_new, email_change,
    email_change_token_current, phone_change, phone_change_token, reauthentication_token
  ) values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    extensions.crypt(gen_random_uuid()::text, extensions.gen_salt('bf')), now(),
    jsonb_build_object('provider', 'email', 'providers', jsonb_build_array('email')),
    jsonb_build_object('full_name', v_name), now(), now(),
    '', '', '', '', '', '', '', ''
  );
  insert into auth.identities (provider_id, user_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (
    v_id::text, v_id,
    jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
    'email', now(), now(), now()
  );

  -- From migration 0002 on (task DB02) a profile exists for every login, made by the new-user trigger.
  if to_regclass('public.profiles') is not null then
    if p_role = 'none' then
      delete from public.profiles where id = v_id;
    elsif p_role = 'inactive' then
      update public.profiles set full_name = v_name, role = 'staff', active = false where id = v_id;
      if not found then
        insert into public.profiles (id, full_name, role, active) values (v_id, v_name, 'staff', false);
      end if;
    elsif to_regprocedure('private.activate_user(text,text,text)') is not null then
      perform private.activate_user(v_email, p_role, v_name);
    else
      update public.profiles set full_name = v_name, role = p_role, active = true where id = v_id;
      if not found then
        insert into public.profiles (id, full_name, role, active) values (v_id, v_name, p_role, true);
      end if;
    end if;
  end if;
  return v_id;
end
$f$;

-- The way a request arrives: the database role authenticated, and the claims PostgREST puts in request.jwt.claims,
-- so auth.uid() answers. Local to the transaction. It may be called again, also while signed in, to become another user.
create or replace function tests.as_user(p_user uuid) returns void
language plpgsql set search_path = ''
as $f$
declare
  v_email text;
begin
  reset role;
  select email into v_email from auth.users where id = p_user;
  if not found then
    raise exception 'tests.as_user: user % not found in auth.users (make one with tests.make_user)', p_user;
  end if;
  set local role authenticated;
  perform set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated', 'email', v_email)::text,
    true
  );
end
$f$;

create or replace function tests.as_anon() returns void
language plpgsql set search_path = ''
as $f$
begin
  reset role;
  set local role anon;
  perform set_config('request.jwt.claims', jsonb_build_object('role', 'anon')::text, true);
end
$f$;

create or replace function tests.reset_role() returns void
language plpgsql set search_path = ''
as $f$
begin
  reset role;
  perform set_config('request.jwt.claims', '', true);
end
$f$;

-- ----------------------------------------------------------------------------------------------- the clock seam (S5)

-- Replaces private.now_ts() (or another zero-argument function that returns timestamptz) by one that returns p_ts. The
-- replacement is DDL inside the caller's transaction, so it is rolled back with it and no other session sees it. Call it
-- before tests.as_user: only the owner of the function may replace it.
create or replace function tests.set_clock(p_ts timestamptz, p_fn text default 'private.now_ts') returns timestamptz
language plpgsql set search_path = ''
as $f$
begin
  if p_fn is null or p_fn !~ '^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$' then
    raise exception 'tests.set_clock: the function name must look like schema.name, not %', coalesce(p_fn, 'null');
  end if;
  if to_regprocedure(p_fn || '()') is null then
    raise exception 'tests.set_clock: %() does not exist yet (private.now_ts() is made by migration 0003, task DB02)', p_fn;
  end if;
  execute format(
    'create or replace function %s() returns timestamptz language sql stable as %L',
    p_fn, format('select %L::timestamptz', p_ts)
  );
  return p_ts;
end
$f$;

-- ----------------------------------------------------------------------------------------------- rows

-- Insert one row from a JSON object of column values; a column left out takes its default. An unknown column is an
-- error, never ignored. Returns the whole row as JSON.
create or replace function tests.insert_row(p_table regclass, p_values jsonb default '{}'::jsonb) returns jsonb
language plpgsql set search_path = ''
as $f$
declare
  v_values jsonb := coalesce(p_values, '{}'::jsonb);
  v_unknown text;
  v_cols text;
  v_row jsonb;
begin
  select string_agg(k, ', ') into v_unknown
    from jsonb_object_keys(v_values) k
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attname = k
   );
  if v_unknown is not null then
    raise exception 'tests.insert_row: % has no column %', p_table, v_unknown;
  end if;
  select string_agg(quote_ident(k), ', ') into v_cols from jsonb_object_keys(v_values) k;
  if v_cols is null then
    execute format('insert into %s as t default values returning to_jsonb(t.*)', p_table) into v_row;
  else
    execute format(
      'insert into %1$s as t (%2$s) select %2$s from jsonb_populate_record(null::%1$s, $1) returning to_jsonb(t.*)',
      p_table, v_cols
    ) using v_values into v_row;
  end if;
  return v_row;
end
$f$;

-- Placeholders in a bulk template: {n} is the row number (1, 2, ...), {n:5} the same padded with zeros to 5 digits,
-- {ref:schema.table} the id of an existing row of that table, taken in turn so every row of it is used in rotation.
create or replace function tests.subst(p_text text, p_n bigint, p_refs jsonb) returns text
language plpgsql stable set search_path = ''
as $f$
declare
  v_out text := p_text;
  v_m text[];
begin
  if position('{' in v_out) = 0 then
    return v_out;
  end if;
  for v_m in select regexp_matches(v_out, '\{n:([0-9]+)\}', 'g') loop
    v_out := replace(v_out, '{n:' || v_m[1] || '}', lpad(p_n::text, v_m[1]::int, '0'));
  end loop;
  v_out := replace(v_out, '{n}', p_n::text);
  for v_m in select regexp_matches(v_out, '\{ref:([^}]+)\}', 'g') loop
    v_out := replace(
      v_out, '{ref:' || v_m[1] || '}',
      p_refs -> v_m[1] ->> (((p_n - 1) % jsonb_array_length(p_refs -> v_m[1]))::int)
    );
  end loop;
  return v_out;
end
$f$;

-- Insert p_count rows in one statement. p_template is a JSON object of column values; a string in it may use the
-- placeholders of tests.subst; a column it does not name takes its default. p_refs lets the caller say which ids
-- {ref:table} should rotate through instead of every row of that table.
-- Returns the number of rows inserted (a bulk of 1,500 rows is what T-E07 needs).
create or replace function tests.bulk_rows(
  p_table regclass,
  p_count integer default 1500,
  p_template jsonb default '{}'::jsonb,
  p_refs jsonb default '{}'::jsonb
) returns integer
language plpgsql set search_path = ''
as $f$
declare
  v_template jsonb := coalesce(p_template, '{}'::jsonb);
  v_refs jsonb := coalesce(p_refs, '{}'::jsonb);
  v_unknown text;
  v_cols text;
  v_sel text;
  v_ref text;
  v_ids jsonb;
  v_inserted integer;
begin
  if p_count is null or p_count < 0 then
    raise exception 'tests.bulk_rows: the count must be 0 or more, not %', coalesce(p_count::text, 'null');
  end if;
  if p_count = 0 then
    return 0;
  end if;
  select string_agg(k, ', ') into v_unknown
    from jsonb_object_keys(v_template) k
   where not exists (
     select 1 from pg_attribute a
      where a.attrelid = p_table and a.attnum > 0 and not a.attisdropped and a.attname = k
   );
  if v_unknown is not null then
    raise exception 'tests.bulk_rows: % has no column %', p_table, v_unknown;
  end if;
  select string_agg(quote_ident(k), ', '), string_agg(format('(s.r).%I', k), ', ')
    into v_cols, v_sel
    from jsonb_object_keys(v_template) k;
  if v_cols is null then
    raise exception 'tests.bulk_rows: the template must name at least one column';
  end if;

  for v_ref in
    select distinct m[1]
      from jsonb_each_text(v_template) as t(k, v), regexp_matches(t.v, '\{ref:([^}]+)\}', 'g') as m
  loop
    if v_refs ? v_ref then
      continue;
    end if;
    if to_regclass(v_ref) is null then
      raise exception 'tests.bulk_rows: {ref:%} names a table that does not exist', v_ref;
    end if;
    execute format('select coalesce(jsonb_agg(id::text order by id), ''[]''::jsonb) from %s', v_ref::regclass) into v_ids;
    v_refs := v_refs || jsonb_build_object(v_ref, v_ids);
  end loop;
  for v_ref, v_ids in select k, v from jsonb_each(v_refs) as t(k, v) loop
    if jsonb_array_length(v_ids) = 0 then
      raise exception 'tests.bulk_rows: {ref:%} has no rows to point at', v_ref;
    end if;
  end loop;

  execute format(
    $q$
      insert into %1$s (%2$s)
      select %3$s
        from (
          select jsonb_populate_record(null::%1$s, (
                   select coalesce(jsonb_object_agg(
                            t.k,
                            case when jsonb_typeof(t.v) = 'string'
                                 then to_jsonb(tests.subst(t.v #>> '{}', g.n, $2))
                                 else t.v end), '{}'::jsonb)
                     from jsonb_each($1) as t(k, v)
                 )) as r
            from generate_series(1, $3::bigint) as g(n)
          offset 0
        ) s
    $q$,
    p_table, v_cols, v_sel
  ) using v_template, v_refs, p_count;
  get diagnostics v_inserted = row_count;
  return v_inserted;
end
$f$;

-- A helper's friendly message for a table that a later task creates.
create or replace function tests.need(p_table text, p_task text) returns void
language plpgsql set search_path = ''
as $f$
begin
  if to_regclass(p_table) is null then
    raise exception 'tests: % does not exist yet (task % creates it)', p_table, p_task;
  end if;
end
$f$;

-- ----------------------------------------------------------------------------------------------- fixture builders
-- Written from the columns the spec gives (D4 to D7, D10). Each takes a JSON object that overrides the defaults.
-- They run as the table owner, so row-level security and column grants do not apply to a fixture.
-- The bill builder is added with create_bill (task DB09b): a bill is made by calling the function, not by inserting.

create or replace function tests.make_category(p_values jsonb default '{}'::jsonb) returns uuid
language plpgsql set search_path = ''
as $f$
declare
  v_n bigint := tests.next_n();
begin
  perform tests.need('public.categories', 'DB03');
  return (tests.insert_row(
    'public.categories',
    jsonb_build_object('name', 'Test category ' || v_n, 'prefix', 'TC' || upper(lpad(to_hex(v_n), 3, '0')))
      || coalesce(p_values, '{}'::jsonb)
  ) ->> 'id')::uuid;
end
$f$;

create or replace function tests.make_design(p_values jsonb default '{}'::jsonb) returns uuid
language plpgsql set search_path = ''
as $f$
declare
  v_n bigint := tests.next_n();
  v_category uuid;
begin
  perform tests.need('public.designs', 'DB03');
  if not (coalesce(p_values, '{}'::jsonb) ? 'category_id') then
    select id into v_category from public.categories order by id limit 1;
    v_category := coalesce(v_category, tests.make_category());
  end if;
  return (tests.insert_row(
    'public.designs',
    jsonb_build_object(
      'design_no', 'TST-' || lpad(v_n::text, 5, '0'),
      'name', 'Test design ' || v_n,
      'material', 'Gold', 'purity', '22K', 'selling_method', 'By Weight'
    )
      || case when v_category is null then '{}'::jsonb else jsonb_build_object('category_id', v_category) end
      || coalesce(p_values, '{}'::jsonb)
  ) ->> 'id')::uuid;
end
$f$;

create or replace function tests.make_piece(p_design uuid default null, p_values jsonb default '{}'::jsonb) returns uuid
language plpgsql set search_path = ''
as $f$
declare
  v_n bigint := tests.next_n();
begin
  perform tests.need('public.skus', 'DB03');
  return (tests.insert_row(
    'public.skus',
    jsonb_build_object(
      'design_id', coalesce(p_design, tests.make_design()),
      'sku_no', 'TST-PC-' || lpad(v_n::text, 6, '0'),
      'barcode', 'BC-TST-PC-' || lpad(v_n::text, 6, '0'),
      'gross_weight', 10.000, 'customer_net_weight', 9.500,
      'labour_retail', 350, 'labour_semi', 300, 'labour_wholesale', 250,
      'status', 'In Stock', 'location', 'Main Showroom'
    )
      || coalesce(p_values, '{}'::jsonb)
  ) ->> 'id')::uuid;
end
$f$;

create or replace function tests.make_customer(p_values jsonb default '{}'::jsonb) returns uuid
language plpgsql set search_path = ''
as $f$
declare
  v_n bigint := tests.next_n();
begin
  perform tests.need('public.customers', 'DB04');
  return (tests.insert_row(
    'public.customers',
    jsonb_build_object('name', 'Test customer ' || v_n, 'mobile', '9' || lpad((v_n % 1000000000)::text, 9, '0'), 'customer_type', 'Retail')
      || coalesce(p_values, '{}'::jsonb)
  ) ->> 'id')::uuid;
end
$f$;

-- One rate row; each call defaults to its own date so (rate_date, material, purity) stays unique.
create or replace function tests.make_rate(p_values jsonb default '{}'::jsonb) returns uuid
language plpgsql set search_path = ''
as $f$
declare
  v_n bigint := tests.next_n();
begin
  perform tests.need('public.daily_rates', 'DB03');
  return (tests.insert_row(
    'public.daily_rates',
    jsonb_build_object(
      'material', 'Gold', 'purity', '22K', 'rate_per_gram', 7000.00,
      'rate_date', ((now() at time zone 'Asia/Kolkata')::date - (v_n % 3000)::int)
    )
      || coalesce(p_values, '{}'::jsonb)
  ) ->> 'id')::uuid;
end
$f$;

-- ----------------------------------------------------------------------------------------------- bulk generators

-- p_count pieces (2,500 is the size of T-F03) in designs of up to 25 pieces each. Returns the number of pieces.
create or replace function tests.bulk_pieces(p_count integer default 2500) returns integer
language plpgsql set search_path = ''
as $f$
declare
  v_run bigint := tests.next_n();
  v_category uuid;
  v_ids jsonb;
begin
  perform tests.need('public.designs', 'DB03');
  perform tests.need('public.skus', 'DB03');
  if p_count is null or p_count < 1 then
    return 0;
  end if;
  select id into v_category from public.categories order by id limit 1;
  v_category := coalesce(v_category, tests.make_category());
  perform tests.bulk_rows(
    'public.designs', ceil(p_count / 25.0)::int,
    jsonb_build_object(
      'design_no', 'BULK-' || v_run || '-D{n:5}', 'name', 'Bulk design {n}', 'category_id', v_category,
      'material', 'Gold', 'purity', '22K', 'selling_method', 'By Weight'
    )
  );
  select jsonb_agg(id::text order by design_no) into v_ids from public.designs where design_no like 'BULK-' || v_run || '-D%';
  return tests.bulk_rows(
    'public.skus', p_count,
    jsonb_build_object(
      'design_id', '{ref:public.designs}', 'sku_no', 'BULK-' || v_run || '-{n:6}', 'barcode', 'BC-BULK-' || v_run || '-{n:6}',
      'gross_weight', 10.000, 'customer_net_weight', 9.500,
      'labour_retail', 350, 'labour_semi', 300, 'labour_wholesale', 250,
      'status', 'In Stock', 'location', 'Main Showroom'
    ),
    jsonb_build_object('public.designs', v_ids)
  );
end
$f$;

-- p_count bills (3,000 is the M1 volume of C2) spread over p_count/15 customers, inserted directly as the table owner.
-- They carry no lines and no receipts; they are there to make the screens' first load as big as the real one.
create or replace function tests.bulk_bills(p_count integer default 3000) returns integer
language plpgsql set search_path = ''
as $f$
declare
  v_run bigint := tests.next_n();
  v_ids jsonb;
begin
  perform tests.need('public.customers', 'DB04');
  perform tests.need('public.bills', 'DB04');
  if p_count is null or p_count < 1 then
    return 0;
  end if;
  perform tests.bulk_rows(
    'public.customers', ceil(p_count / 15.0)::int,
    jsonb_build_object('name', 'Bulk customer {n}', 'mobile', '9{n:9}', 'customer_type', 'Retail')
  );
  select jsonb_agg(id::text order by name) into v_ids from public.customers where name like 'Bulk customer %';
  return tests.bulk_rows(
    'public.bills', p_count,
    jsonb_build_object(
      'bill_no', 'BULK-' || v_run || '-{n:5}', 'customer_id', '{ref:public.customers}',
      'bill_date', ((now() at time zone 'Asia/Kolkata')::date)::text,
      'doc_type', 'estimate', 'sale_type', 'Retail', 'status', 'active', 'subtotal', 1000, 'grand_total', 1000
    ),
    jsonb_build_object('public.customers', v_ids)
  );
end
$f$;

-- ----------------------------------------------------------------------------------------------- reset

-- Puts the database back to what an empty project has (spec D20), for two-session tests that had to commit:
--   1. ends the sessions of this user that sit idle inside a transaction (a test that crashed or forgot to roll back
--      leaves its locks behind), but not a session that is merely connected, and not a running one;
--   2. truncates every table of public and private that the catalogue lists, except private.limits (constants, not data)
--      and the tables of extensions, so a table added by a later task is cleared with no change here;
--   3. deletes the logins (unless p_keep_users, which also keeps public.profiles);
--   4. calls private.seed_defaults() once it exists (task DB05).
-- p_lock_timeout bounds step 2: a session that holds a lock makes it fail after that time, never wait for ever.
-- Returns what it did as JSON.
create or replace function tests.reset_business_data(p_keep_users boolean default false, p_lock_timeout text default '10s')
returns jsonb
language plpgsql set search_path = ''
as $f$
declare
  v_tables text;
  v_count integer := 0;
  v_killed integer := 0;
  v_left integer;
  v_users integer := 0;
  v_seeded boolean := false;
begin
  perform set_config('lock_timeout', p_lock_timeout, true);

  select count(*) into v_killed
    from (
      select pg_terminate_backend(pid)
        from pg_stat_activity
       where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
         and usename = session_user and state like 'idle in transaction%'
    ) s;
  for i in 1..100 loop
    exit when v_killed = 0;
    -- pg_stat_activity is a snapshot that lasts until the end of the transaction; ask for a fresh one each round
    perform pg_stat_clear_snapshot();
    select count(*) into v_left
      from pg_stat_activity
     where datname = current_database() and pid <> pg_backend_pid() and backend_type = 'client backend'
       and usename = session_user and state like 'idle in transaction%';
    exit when v_left = 0;
    perform pg_sleep(0.05);
  end loop;

  select string_agg(format('%I.%I', n.nspname, c.relname), ', ' order by n.nspname, c.relname), count(*)
    into v_tables, v_count
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where c.relkind in ('r', 'p') and n.nspname in ('public', 'private')
     and not (n.nspname = 'private' and c.relname = 'limits')
     and not (p_keep_users and n.nspname = 'public' and c.relname = 'profiles')
     and not exists (
       select 1 from pg_depend d
        where d.classid = 'pg_class'::regclass and d.objid = c.oid and d.deptype = 'e'
     );
  if v_tables is not null then
    execute 'truncate table ' || v_tables || ' restart identity cascade';
  end if;

  if not p_keep_users then
    -- DB02: a login that has a profile cannot be deleted (profiles.id is ON DELETE RESTRICT). The truncate above has emptied
    -- profiles already; this line keeps the order explicit if profiles is ever left out of that list.
    if to_regclass('public.profiles') is not null then
      delete from public.profiles;
    end if;
    delete from auth.users;
    get diagnostics v_users = row_count;
  end if;

  if to_regprocedure('private.seed_defaults()') is not null then
    perform private.seed_defaults();
    v_seeded := true;
  else
    raise notice 'tests.reset_business_data: private.seed_defaults() does not exist yet (task DB05), so nothing was re-seeded';
  end if;

  return jsonb_build_object(
    'truncated_tables', v_count, 'terminated_backends', v_killed, 'users_deleted', v_users, 'seeded', v_seeded
  );
end
$f$;

-- ----------------------------------------------------------------------------------------------- who may call what
-- Only the three role switches can be called while signed in. Everything else is for the database owner.
do $lock$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'tests'
  loop
    execute format('revoke all on function %s from public', r.sig);
  end loop;
end
$lock$;
grant execute on function tests.as_user(uuid), tests.as_anon(), tests.reset_role() to anon, authenticated, service_role;

-- ===== END DB01 (test harness) =====

-- ===== BEGIN DB07 (photo storage) =====

-- tests.reset_business_data() truncates the tables of public and private and leaves storage alone. A test that had to commit
-- a photo (an upload over HTTP, FE05) clears it with this: it deletes every row of storage.objects and answers how many.
-- It keeps the buckets: design-photos is made by migration 0014, belongs to the schema and is what the next upload needs.
--   * The platform refuses a delete from storage.objects unless storage.allow_delete_query is 'true' (the trigger
--     storage.protect_delete); the Storage service sets it for its own calls and so does this, for the transaction only.
--   * Only the rows go. The file behind a row stays in the lane's storage volume until `db:stop -- --no-backup`; the service
--     serves nothing without its row, and a new upload to the same path replaces the file.
--   * lock_timeout bounds the delete, like reset_business_data: it fails instead of waiting for ever behind an open upload.
create or replace function tests.reset_storage() returns integer
language plpgsql set search_path = ''
as $f$
declare
  v_deleted integer;
begin
  perform set_config('lock_timeout', '10s', true);
  perform set_config('storage.allow_delete_query', 'true', true);
  delete from storage.objects;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end
$f$;
revoke all on function tests.reset_storage() from public, anon, authenticated;

-- ===== END DB07 (photo storage) =====
