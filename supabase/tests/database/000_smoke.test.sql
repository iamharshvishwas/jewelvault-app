-- PT-H1 (harness smoke, the pgTAP half). DB01.
--
-- Proves that the helpers of supabase/seeds/10_test_helpers.sql work, so every later pgTAP file can lean on them:
-- tests.make_user, as_user, as_anon, reset_role, set_clock, insert_row, the fixture builders, the bulk generators and
-- reset_business_data. Everything runs inside this transaction and is rolled back.
--
-- Tables and functions that later tasks create (profiles, categories, designs, skus, customers, daily_rates, bills,
-- private.now_ts, private.seed_defaults, private.limits) do not exist yet in DB01. Where one is missing, this file builds a
-- small stand-in with the columns the spec gives (D1, D4 to D7, D10, D11), so the helpers are exercised now. Once the real
-- table exists, the same assertions run against it and show at once if a builder no longer fits the schema.

begin;
select plan(102);

-- ---------------------------------------------------------------- 1. the environment
select ok(true, 'pgTAP runs through supabase test db');
select has_schema('tests', 'the tests schema exists (seeds/10_test_helpers.sql ran after seeds/00_guard.sql)');
select is(current_setting('server_version_num')::int / 10000, 17, 'the database is PostgreSQL 17');
select is(current_user::text, 'postgres', 'this file runs as postgres');
select is(auth.uid(), null, 'nobody is signed in until tests.as_user is called');

-- ---------------------------------------------------------------- 2. the helpers exist and are safe
select has_function('tests', 'make_user', array['text', 'text', 'text'], 'tests.make_user(role, email, full_name)');
select has_function('tests', 'as_user', array['uuid'], 'tests.as_user(uuid)');
select has_function('tests', 'as_anon', array[]::text[], 'tests.as_anon()');
select has_function('tests', 'reset_role', array[]::text[], 'tests.reset_role()');
select has_function('tests', 'set_clock', array['timestamp with time zone', 'text'], 'tests.set_clock(ts, function)');
select has_function('tests', 'insert_row', array['regclass', 'jsonb'], 'tests.insert_row(table, values)');
select has_function('tests', 'make_category', array['jsonb'], 'tests.make_category(values)');
select has_function('tests', 'make_design', array['jsonb'], 'tests.make_design(values)');
select has_function('tests', 'make_piece', array['uuid', 'jsonb'], 'tests.make_piece(design, values)');
select has_function('tests', 'make_customer', array['jsonb'], 'tests.make_customer(values)');
select has_function('tests', 'make_rate', array['jsonb'], 'tests.make_rate(values)');
select has_function('tests', 'bulk_rows', array['regclass', 'integer', 'jsonb', 'jsonb'], 'tests.bulk_rows(table, count, template, refs)');
select has_function('tests', 'bulk_pieces', array['integer'], 'tests.bulk_pieces(count)');
select has_function('tests', 'bulk_bills', array['integer'], 'tests.bulk_bills(count)');
select has_function('tests', 'reset_business_data', array['boolean', 'text'], 'tests.reset_business_data(keep_users, lock_timeout)');

select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'tests' and p.prosecdef),
  0,
  'no tests helper is security definer: they run with the caller''s rights, so as_user can switch role'
);
select is(
  (select count(*)::int
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tests'
      and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%')),
  0,
  'every tests helper pins its search_path (advisor lint 0011)'
);
select is(
  (select array_agg(p.proname::text order by p.proname)
     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'tests' and has_function_privilege('authenticated', p.oid, 'execute')),
  array['as_anon', 'as_user', 'reset_role'],
  'a signed-in caller can run only the three role-switching helpers, never the destructive ones'
);

-- ---------------------------------------------------------------- 3. stand-ins for what later tasks create
do $standin$
begin
  if to_regclass('public.profiles') is null then
    create table public.profiles (
      id uuid primary key references auth.users (id) on delete cascade,
      full_name text not null,
      role text not null check (role in ('owner', 'biller', 'staff')),
      active boolean not null default false
    );
    create function public.jv_standin_new_user() returns trigger language plpgsql security definer set search_path = '' as $f$
    begin
      insert into public.profiles (id, full_name, role, active)
      values (new.id, coalesce(new.raw_user_meta_data ->> 'full_name', split_part(new.email, '@', 1)), 'staff', false);
      return new;
    end $f$;
    create trigger jv_standin_new_user after insert on auth.users for each row execute function public.jv_standin_new_user();
  end if;
  if to_regclass('public.categories') is null then
    create table public.categories (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      prefix text not null,
      active boolean not null default true,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
  end if;
  if to_regclass('public.designs') is null then
    create table public.designs (
      id uuid primary key default gen_random_uuid(),
      design_no text not null unique,
      name text,
      category_id uuid not null references public.categories (id),
      material text not null,
      purity text not null,
      selling_method text not null,
      tags text[],
      archived_at timestamptz,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
  end if;
  if to_regclass('public.skus') is null then
    create table public.skus (
      id uuid primary key default gen_random_uuid(),
      design_id uuid not null references public.designs (id),
      sku_no text not null unique,
      barcode text not null unique,
      gross_weight numeric(12, 3) not null,
      customer_net_weight numeric(12, 3) not null,
      labour_retail numeric(12, 2),
      labour_semi numeric(12, 2),
      labour_wholesale numeric(12, 2),
      status text not null default 'In Stock',
      location text,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
  end if;
  if to_regclass('public.customers') is null then
    create table public.customers (
      id uuid primary key default gen_random_uuid(),
      name text not null,
      mobile text,
      customer_type text not null default 'Retail',
      is_walkin boolean not null default false,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
  end if;
  if to_regclass('public.daily_rates') is null then
    create table public.daily_rates (
      id uuid primary key default gen_random_uuid(),
      material text not null,
      purity text not null,
      rate_per_gram numeric(12, 2) not null check (rate_per_gram > 0),
      rate_date date not null,
      unique (rate_date, material, purity)
    );
  end if;
  if to_regclass('public.bills') is null then
    create table public.bills (
      id uuid primary key default gen_random_uuid(),
      bill_no text not null unique,
      customer_id uuid not null references public.customers (id),
      bill_date date not null,
      doc_type text not null default 'estimate',
      sale_type text not null default 'Retail',
      status text not null default 'active',
      subtotal numeric(14, 2) not null default 0,
      grand_total numeric(14, 2) not null default 0,
      created_at timestamptz not null default clock_timestamp(),
      updated_at timestamptz not null default clock_timestamp()
    );
  end if;
  create schema if not exists private;
  if to_regprocedure('private.now_ts()') is null then
    create function private.now_ts() returns timestamptz language sql as 'select clock_timestamp()';
  end if;
  -- Replaced inside this transaction by a stub that counts its calls, whether or not the real one exists yet
  -- (DB05 tests the real one): all this file asks is that reset_business_data() calls it.
  drop function if exists private.seed_defaults();
  create function private.seed_defaults() returns void language plpgsql as $f$
  begin
    perform set_config('jv.seed_defaults_calls', (coalesce(nullif(current_setting('jv.seed_defaults_calls', true), ''), '0')::int + 1)::text, true);
  end $f$;
  if to_regclass('private.limits') is null then
    create table private.limits (name text primary key, value numeric not null);
    insert into private.limits values ('probe', 1);
  end if;
  perform set_config('jv.limits_before', (select count(*) from private.limits)::text, true);
  create table public.jv_standin_owners (id uuid primary key default gen_random_uuid(), label text not null);
  create table public.jv_standin_widgets (
    id uuid primary key default gen_random_uuid(),
    code text not null unique,
    qty integer not null default 1,
    tags text[],
    owner_id uuid references public.jv_standin_owners (id),
    note text
  );
end
$standin$;

-- ---------------------------------------------------------------- 4. tests.make_user
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.noprofile', tests.make_user('none')::text, true);
  perform set_config('jv.custom', tests.make_user('owner', 'custom-owner@jv-test.local', 'Custom Name')::text, true);
end
$mk$;

select is(
  (select count(*)::int from auth.users where id in (
    current_setting('jv.owner')::uuid, current_setting('jv.biller')::uuid, current_setting('jv.staff')::uuid,
    current_setting('jv.inactive')::uuid, current_setting('jv.noprofile')::uuid, current_setting('jv.custom')::uuid)),
  6,
  'make_user creates one auth.users row per call'
);
select is(
  (select count(*)::int from auth.users
    where id = current_setting('jv.owner')::uuid and aud = 'authenticated' and role = 'authenticated'
      and email_confirmed_at is not null and encrypted_password is not null and instance_id is not null),
  1,
  'the row is a confirmed login with an audience, a role and a password hash'
);
select is(
  (select count(*)::int from auth.users
    where id = current_setting('jv.owner')::uuid
      and confirmation_token is not null and recovery_token is not null and email_change_token_new is not null
      and email_change is not null and email_change_token_current is not null and phone_change is not null
      and phone_change_token is not null and reauthentication_token is not null),
  1,
  'every token column is set (the Auth service answers 500 on a row where one is null)'
);
select is(
  (select count(*)::int from auth.identities where user_id = current_setting('jv.owner')::uuid and provider = 'email'),
  1,
  'make_user also writes the email identity'
);
select isnt(current_setting('jv.owner')::uuid, current_setting('jv.biller')::uuid, 'two calls give two different users');
select is(
  (select email from auth.users where id = current_setting('jv.custom')::uuid),
  'custom-owner@jv-test.local',
  'an explicit email is used'
);
select matches(
  (select email from auth.users where id = current_setting('jv.owner')::uuid),
  '^[a-z0-9-]+@jv-test\.local$',
  'a generated email uses the reserved jv-test.local domain'
);
select throws_like(
  $$select tests.make_user('admin')$$,
  '%role%',
  'an unknown role is refused'
);
select is(
  (select role || '/' || active::text from public.profiles where id = current_setting('jv.owner')::uuid),
  'owner/true',
  'an owner gets an active owner profile'
);
select is(
  (select role || '/' || active::text from public.profiles where id = current_setting('jv.biller')::uuid),
  'biller/true',
  'a biller gets an active biller profile'
);
select is(
  (select role || '/' || active::text from public.profiles where id = current_setting('jv.staff')::uuid),
  'staff/true',
  'a staff user gets an active staff profile'
);
select is(
  (select active from public.profiles where id = current_setting('jv.inactive')::uuid),
  false,
  'an inactive user keeps the inactive profile the new-user trigger made'
);
select is(
  (select count(*)::int from public.profiles where id = current_setting('jv.noprofile')::uuid),
  0,
  'make_user(none) leaves a login with no profile at all'
);
select is(
  (select full_name from public.profiles where id = current_setting('jv.custom')::uuid),
  'Custom Name',
  'an explicit full name reaches the profile'
);

-- ---------------------------------------------------------------- 5. tests.as_user, as_anon, reset_role
select tests.as_user(current_setting('jv.owner')::uuid);
select is(auth.uid(), current_setting('jv.owner')::uuid, 'as_user: auth.uid() is the user');
select is(current_user::text, 'authenticated', 'as_user: the database role is authenticated');
select is(auth.role(), 'authenticated', 'as_user: the JWT role claim is authenticated');
select is((auth.jwt() ->> 'sub')::uuid, current_setting('jv.owner')::uuid, 'as_user: the sub claim is set');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(auth.uid(), current_setting('jv.biller')::uuid, 'as_user can switch to another user while already signed in');
select tests.as_anon();
select is(current_user::text, 'anon', 'as_anon: the database role is anon');
select is(auth.uid(), null, 'as_anon: auth.uid() is null');
select tests.reset_role();
select is(current_user::text, 'postgres', 'reset_role: back to postgres');
select is(auth.uid(), null, 'reset_role: nobody is signed in');
select throws_like(
  $$select tests.as_user('00000000-0000-0000-0000-000000000bad')$$,
  '%not found%',
  'as_user refuses a user that does not exist'
);

-- ---------------------------------------------------------------- 6. tests.set_clock (the clock seam of S5)
select is(tests.set_clock('2026-12-31 18:29:59+00'), '2026-12-31 18:29:59+00'::timestamptz, 'set_clock returns the time it set');
select is(private.now_ts(), '2026-12-31 18:29:59+00'::timestamptz, 'private.now_ts() now returns the fixed time');
select is((private.now_ts() at time zone 'Asia/Kolkata')::date, '2026-12-31'::date, '23:59:59 on 31 December in Asia/Kolkata is still 2026 (T-F07)');
select tests.set_clock('2026-12-31 18:30:01+00');
select is((private.now_ts() at time zone 'Asia/Kolkata')::date, '2027-01-01'::date, '00:00:01 on 1 January in Asia/Kolkata is 2027 (T-F07)');
select throws_like($$select tests.set_clock('2026-01-01+00', 'private.no_such_clock')$$, '%does not exist%', 'set_clock refuses a function that does not exist');
select throws_like($$select tests.set_clock('2026-01-01+00', 'private.now_ts; drop table x')$$, '%schema.name%', 'set_clock refuses a malformed function name');

-- ---------------------------------------------------------------- 7. tests.insert_row and tests.bulk_rows
select is((tests.insert_row('public.jv_standin_widgets', '{"code":"W-ONE"}') ->> 'qty')::int, 1, 'insert_row: a column left out takes its default');
select is((tests.insert_row('public.jv_standin_widgets', '{"code":"W-TWO","qty":5,"tags":["a","b"]}') ->> 'qty')::int, 5, 'insert_row: a value given is used');
select is(
  (select tags from public.jv_standin_widgets where code = 'W-TWO'),
  array['a', 'b'],
  'insert_row: a JSON array fills an array column'
);
select isnt((tests.insert_row('public.jv_standin_widgets', '{"code":"W-THREE"}') ->> 'id'), null, 'insert_row returns the row, id included');
select throws_like(
  $$select tests.insert_row('public.jv_standin_widgets', '{"code":"W-X","no_such_column":1}')$$,
  '%no_such_column%',
  'insert_row names an unknown column instead of ignoring it'
);
select lives_ok($$select tests.insert_row('public.jv_standin_owners', '{"label":"owner-1"}')$$, 'insert_row inserts a row');
select lives_ok($$select tests.insert_row('public.jv_standin_owners', '{"label":"owner-2"}')$$, 'insert_row inserts a second row');
select lives_ok($$select tests.insert_row('public.jv_standin_owners', '{"label":"owner-3"}')$$, 'insert_row inserts a third row');

select is(tests.bulk_rows('public.jv_standin_widgets', 1500, '{"code":"B-{n}"}'), 1500, 'bulk_rows returns the number of rows it inserted (1,500, the size T-E07 needs)');
select is((select count(*)::int from public.jv_standin_widgets where code like 'B-%'), 1500, 'bulk_rows: 1,500 rows are there');
select is((select count(distinct code)::int from public.jv_standin_widgets where code like 'B-%'), 1500, 'bulk_rows: {n} makes every value different');
select ok(
  exists (select 1 from public.jv_standin_widgets where code = 'B-1') and exists (select 1 from public.jv_standin_widgets where code = 'B-1500'),
  'bulk_rows: {n} runs from 1 to the count'
);
select is((select count(*)::int from public.jv_standin_widgets where code like 'B-%' and qty = 1), 1500, 'bulk_rows: a column outside the template keeps its default');
select is(tests.bulk_rows('public.jv_standin_widgets', 6, '{"code":"N-{n}","qty":7}'), 6, 'bulk_rows: a template with a number');
select is((select count(*)::int from public.jv_standin_widgets where code like 'N-%' and qty = 7), 6, 'bulk_rows: a non-string value is passed through as it is');
select is(tests.bulk_rows('public.jv_standin_widgets', 9, '{"code":"R-{n}","owner_id":"{ref:public.jv_standin_owners}"}'), 9, 'bulk_rows: {ref:table} placeholder');
select is(
  (select array_agg(c order by c) from (select count(*) c from public.jv_standin_widgets where code like 'R-%' group by owner_id) s),
  array[3::bigint, 3, 3],
  'bulk_rows: {ref:table} cycles through the existing rows of that table'
);
select is(tests.bulk_rows('public.jv_standin_widgets', 0, '{"code":"Z-{n}"}'), 0, 'bulk_rows with a count of 0 inserts nothing');
select throws_like(
  $$select tests.bulk_rows('public.jv_standin_widgets', 3, '{"code":"E-{n}","nope":"x"}')$$,
  '%nope%',
  'bulk_rows names an unknown column in the template'
);
select throws_like(
  $$select tests.bulk_rows('public.jv_standin_widgets', 3, '{"code":"E-{n}","owner_id":"{ref:public.jv_standin_empty}"}')$$,
  '%jv_standin_empty%',
  'bulk_rows names a {ref:} table that does not exist'
);

-- ---------------------------------------------------------------- 8. the fixture builders
-- Each builder is called once, in a block of its own: a builder inside a query that also scans the table it fills would
-- not see its own row.
do $b$
begin
  perform set_config('jv.category', tests.make_category()::text, true);
  perform set_config('jv.design', tests.make_design()::text, true);
  perform set_config('jv.design2', tests.make_design()::text, true);
  perform set_config('jv.design_named', tests.make_design('{"name":"Temple chain"}')::text, true);
  perform set_config('jv.piece', tests.make_piece()::text, true);
  perform set_config('jv.piece_given', tests.make_piece(current_setting('jv.design')::uuid, '{"gross_weight":12.5,"customer_net_weight":12.0}')::text, true);
  perform set_config('jv.customer', tests.make_customer()::text, true);
  perform set_config('jv.rate', tests.make_rate()::text, true);
end
$b$;

select is((select count(*)::int from public.categories where id = current_setting('jv.category')::uuid), 1, 'make_category returns the id of a category row');
select is((select count(*)::int from public.designs where id = current_setting('jv.design')::uuid), 1, 'make_design returns the id of a design row');
select isnt(current_setting('jv.design')::uuid, current_setting('jv.design2')::uuid, 'make_design twice gives two designs');
select is(
  (select count(distinct design_no)::int from public.designs where id in (current_setting('jv.design')::uuid, current_setting('jv.design2')::uuid)),
  2,
  'make_design twice does not collide on the unique design number'
);
select is((select name from public.designs where id = current_setting('jv.design_named')::uuid), 'Temple chain', 'make_design: a value given overrides the default');
select is((select count(*)::int from public.skus where id = current_setting('jv.piece')::uuid), 1, 'make_piece with no design makes one and returns the piece id');
select is(
  (select s.status || '/' || (s.customer_net_weight <= s.gross_weight)::text from public.skus s where s.id = current_setting('jv.piece')::uuid),
  'In Stock/true',
  'make_piece: In Stock, net weight not above gross weight (D7, D8)'
);
select is(
  (select s.gross_weight from public.skus s where s.id = current_setting('jv.piece_given')::uuid),
  12.5::numeric,
  'make_piece: a value given overrides the default'
);
select is(
  (select s.design_id from public.skus s where s.id = current_setting('jv.piece_given')::uuid),
  current_setting('jv.design')::uuid,
  'make_piece puts the piece in the design it is given'
);
select is(
  (select count(*)::int from public.skus s where s.design_id = (select design_id from public.skus where id = current_setting('jv.piece')::uuid)),
  1,
  'make_piece with no design creates a design of its own'
);
select matches((select mobile from public.customers where id = current_setting('jv.customer')::uuid), '^[0-9]{10}$', 'make_customer: a ten-digit mobile number (D10)');
select is((select is_walkin from public.customers where id = current_setting('jv.customer')::uuid), false, 'make_customer never makes the walk-in customer');
select is((select count(*)::int from public.daily_rates where id = current_setting('jv.rate')::uuid), 1, 'make_rate returns the id of a rate row');
select lives_ok($$select tests.make_rate(), tests.make_rate(), tests.make_rate()$$, 'make_rate three times does not collide on (date, material, purity) (D4)');
select is(tests.bulk_pieces(30), 30, 'bulk_pieces(30) returns 30');
select is((select count(*)::int from public.skus where sku_no like 'BULK-%'), 30, 'bulk_pieces: 30 bulk pieces are there');
select is(
  (select count(distinct design_id)::int from public.skus where sku_no like 'BULK-%'),
  2,
  'bulk_pieces: at most 25 pieces per design, so 30 pieces sit in 2 designs'
);
select is(tests.bulk_bills(40), 40, 'bulk_bills(40) returns 40');
select is((select count(*)::int from public.bills where bill_no like 'BULK-%'), 40, 'bulk_bills: 40 bulk bills are there');

-- ---------------------------------------------------------------- 9. tests.reset_business_data
select tests.as_user(current_setting('jv.owner')::uuid);
select throws_like($$select tests.reset_business_data()$$, '%permission denied%', 'a signed-in caller cannot run reset_business_data');
select tests.reset_role();

select is(
  (tests.reset_business_data(true) ->> 'users_deleted')::int,
  0,
  'reset_business_data(keep_users => true) leaves the logins alone'
);
select is((select count(*)::int from auth.users where id = current_setting('jv.owner')::uuid), 1, 'the logins are still there');
select is((select count(*)::int from public.jv_standin_widgets), 0, 'reset_business_data empties the business tables');
select is((select count(*)::int from public.skus), 0, 'reset_business_data empties the stock tables, whatever the schema holds');
select is((select count(*)::int from private.limits), current_setting('jv.limits_before')::int, 'private.limits is a constants table and is kept');
select is(
  (tests.reset_business_data() ->> 'users_deleted')::int >= 6,
  true,
  'reset_business_data() deletes the logins too (this file made six)'
);
select is((select count(*)::int from auth.users), 0, 'no login is left');
select is(
  nullif(current_setting('jv.seed_defaults_calls', true), '')::int >= 1,
  true,
  'reset_business_data calls private.seed_defaults() to restore the seeds of D20'
);
select is(
  (tests.reset_business_data(false, '1s') ->> 'terminated_backends')::int,
  0,
  'reset_business_data reports the leaked backends it ended (none here)'
);

select * from finish();
rollback;
