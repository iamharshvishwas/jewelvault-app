-- T-C07, T-D05, T-D19, T-D22, T-F02 and T-F05 (the database halves), with the rules they rest on. DB03, migrations 0004 to 0006.
--
-- Spec lines: S3, S4, S6, D3 to D9, D22, A4, A5, P4. Everything runs in this transaction and is rolled back.
--
-- What is proved here:
--   * the shape of the seven tables (settings, daily_rates, categories, subcategories, designs, skus, sku_private): columns,
--     types, row-level security, restrict foreign keys, unique codes ignoring case, the checks of D4 to D9 and P4 (T-F02);
--   * the caps of S4: every cap literal in a CHECK equals its row in private.limits (T-F02), with a test of the test;
--   * the weight rules of D7 and O37, the selling_method and archive rules of D6 and A5 (T-F05), the identity of a piece;
--   * every cell of the A4/A5 matrix for these tables for owner, biller, staff and anon (T-D19, T-D05, T-C07), and the
--     owner-only weight table (D9; the staff and biller halves of T-D03 and T-D04 for sku_private);
--   * the forced person columns and the stamps (T-D22).
--
-- DB04 and DB05 extend T-F02 by adding their tables to pg_temp.f02_tables() and their capped columns to
-- pg_temp.expected_caps() below. The checks are written against the catalogue, so a table or a cap that is added without
-- its row fails here.
--
-- The helpers in pg_temp catch an error and report it, so a missing table makes the assertions fail one by one instead of
-- stopping the file; they are granted to public so that they can be called while a role is impersonated.
begin;
select plan(368);

-- ---------------------------------------------------------------- helpers
-- 'ok <rows>' when the statement ran, 'err <sqlstate>' when it did not. Row-level security that hides a row from an update
-- is 'ok 0'; a missing privilege or a with-check violation is 'err 42501'.
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
declare
  n bigint;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return 'ok ' || n;
exception when others then
  return 'err ' || sqlstate;
end
$f$;

-- The number of rows of public.<table> the current role can see, or 'err <sqlstate>'.
create function pg_temp.cnt(p_table text, p_where text default 'true') returns text language plpgsql as $f$
declare
  n bigint;
begin
  execute format('select count(*) from public.%I where %s', p_table, p_where) into n;
  return n::text;
exception when others then
  return 'err ' || sqlstate;
end
$f$;

-- A fixture statement: a failure is reported as a notice and the file carries on, so one missing table is not fatal.
create function pg_temp.fx(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when others then
  raise notice 'fixture failed: % (%) in: %', sqlerrm, sqlstate, left(p_sql, 100);
end
$f$;

-- The columns of a table as 'name type[ not null]', in order.
create function pg_temp.cols(p_table text) returns text language sql as $f$
  select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end,
                    ', ' order by a.attnum)
    from pg_attribute a
   where a.attrelid = to_regclass('public.' || p_table) and a.attnum > 0 and not a.attisdropped
$f$;

-- The columns of a table the role may update or insert, sorted.
create function pg_temp.col_privs(p_role text, p_table text, p_priv text) returns text[] language sql as $f$
  select coalesce(array_agg(a.attname::text order by a.attname), '{}'::text[])
    from pg_attribute a
   where a.attrelid = to_regclass('public.' || p_table) and a.attnum > 0 and not a.attisdropped
     and has_column_privilege(p_role, a.attrelid, a.attnum, p_priv)
$f$;

grant execute on function pg_temp.try(text), pg_temp.cnt(text, text), pg_temp.fx(text) to public;

-- ---- T-F02: the tables of this task, and the caps. DB04 and DB05 add their tables and columns to these two lists.
create function pg_temp.f02_tables() returns text[] language sql as $f$
  select array['settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus', 'sku_private']
$f$;

-- Which column carries which cap of S4 (the name is the row of private.limits). Money amounts, rates and weights only.
create function pg_temp.expected_caps() returns table (tbl text, col text, limit_name text) language sql as $f$
  values
    ('daily_rates', 'rate_per_gram', 'max_rate'),
    ('skus', 'gross_weight', 'max_weight'),
    ('skus', 'customer_net_weight', 'max_weight'),
    ('skus', 'stone_weight', 'max_weight'),
    ('skus', 'kundan_weight', 'max_weight'),
    ('skus', 'piroi', 'max_amount'),
    ('skus', 'labour_retail', 'max_rate'),
    ('skus', 'labour_semi', 'max_rate'),
    ('skus', 'labour_wholesale', 'max_rate'),
    ('sku_private', 'original_net_weight', 'max_weight')
$f$;

-- Every "<column> <= <number>" in a CHECK of the tables, read from the catalogue: the cap literals as they are stored.
create function pg_temp.cap_literals() returns table (tbl text, col text, lit numeric) language sql as $f$
  select c.relname::text, m[1], m[2]::numeric
    from pg_constraint k
    join pg_class c on c.oid = k.conrelid
   cross join lateral regexp_matches(pg_get_constraintdef(k.oid), '([a-z_0-9]+) <= \(?([0-9]+(?:\.[0-9]+)?)\)?(?:::numeric)?', 'g') m
   where k.contype = 'c' and c.relnamespace = 'public'::regnamespace and c.relname = any (pg_temp.f02_tables())
$f$;

-- What does not agree: an expected cap with no literal, a literal that is not the row of private.limits (also when a column
-- has a second literal), and a cap literal nobody listed. Empty means the two cannot have drifted.
create function pg_temp.cap_drift() returns text[] language sql as $f$
  select coalesce(array_agg(x order by x), '{}'::text[])
    from (
      select e.tbl || '.' || e.col || ': CHECK says ' || coalesce(l.lit::text, 'nothing') || ', private.limits.' || e.limit_name
             || ' says ' || coalesce(v.value::text, 'nothing') as x
        from pg_temp.expected_caps() e
        left join pg_temp.cap_literals() l on l.tbl = e.tbl and l.col = e.col
        left join private.limits v on v.name = e.limit_name
       where l.lit is distinct from v.value
      union all
      select l.tbl || '.' || l.col || ': a cap of ' || l.lit || ' is in a CHECK and on nobody''s list'
        from pg_temp.cap_literals() l
       where not exists (select 1 from pg_temp.expected_caps() e where e.tbl = l.tbl and e.col = l.col)
    ) s
$f$;
grant execute on function pg_temp.cap_drift(), pg_temp.expected_caps(), pg_temp.cap_literals(), pg_temp.f02_tables() to public;

-- ---------------------------------------------------------------- 1. the seven tables (D3 to D9, S3, S6, A1)
select has_table('public', 'settings', 'D3: public.settings exists');
select has_table('public', 'daily_rates', 'D4: public.daily_rates exists');
select has_table('public', 'categories', 'D5: public.categories exists');
select has_table('public', 'subcategories', 'D5: public.subcategories exists');
select has_table('public', 'designs', 'D6: public.designs exists');
select has_table('public', 'skus', 'D7: public.skus exists');
select has_table('public', 'sku_private', 'D9: public.sku_private exists');

select is(pg_temp.cols('settings'),
  'key text not null, value jsonb not null, updated_by uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null',
  'D3, S6: the columns of settings');
select is(pg_temp.cols('daily_rates'),
  'id uuid not null, material text not null, purity text not null, rate_per_gram numeric(12,2) not null, rate_date date not null, confirmed_by uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null',
  'D4, S3: the columns of daily_rates (the rate is numeric(12,2))');
select is(pg_temp.cols('categories'),
  'id uuid not null, name text not null, prefix text not null, active boolean not null, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid, updated_by uuid',
  'D5, S6: the columns of categories');
select is(pg_temp.cols('subcategories'),
  'id uuid not null, category_id uuid not null, name text not null, active boolean not null, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid, updated_by uuid',
  'D5, S6: the columns of subcategories');
select is(pg_temp.cols('designs'),
  'id uuid not null, design_no text not null, name text, category_id uuid not null, subcategory_id uuid, material text not null, purity text not null, selling_method text not null, description text, notes text, tags text[] not null, primary_image_path text, image_paths text[] not null, archived_at timestamp with time zone, import_batch_id uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid, updated_by uuid',
  'D6: the columns of designs: material, purity and selling method live here, and no labour or piroi');
select is(pg_temp.cols('skus'),
  'id uuid not null, design_id uuid not null, sku_no text not null, barcode text not null, gross_weight numeric(12,3) not null, customer_net_weight numeric(12,3) not null, stones integer not null, stone_weight numeric(12,3) not null, kundan integer not null, kundan_weight numeric(12,3) not null, piroi numeric(12,2) not null, labour_retail numeric(12,2) not null, labour_semi numeric(12,2) not null, labour_wholesale numeric(12,2) not null, status text not null, location text, notes text, sold_bill_id uuid, archived_at timestamp with time zone, import_batch_id uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid, updated_by uuid',
  'D7, S3: the columns of skus: weights numeric(12,3), rates numeric(12,2), counts integer, and no material, purity, category or selling method');
select is(pg_temp.cols('sku_private'),
  'sku_id uuid not null, original_net_weight numeric(12,3) not null, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid, updated_by uuid',
  'D9: the columns of sku_private');

select is(
  (select array_agg(relname::text order by relname) from pg_class
    where relnamespace = 'public'::regnamespace and relname = any (pg_temp.f02_tables()) and relrowsecurity),
  (select array_agg(t order by t) from unnest(pg_temp.f02_tables()) t),
  'A1, S9: row-level security is on for all seven tables');
select is(
  (select array_agg(c.relname || '.' || a.attname order by c.relname, a.attname)
     from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = 'public'::regnamespace and c.relkind in ('r', 'p') and a.attnum > 0 and not a.attisdropped
      and a.atttypid in ('float4'::regtype, 'float8'::regtype)),
  null, 'S3, T-F02: no real, double precision or float column exists in any table of public');
select is(
  (select array_agg(c.relname::text order by c.relname)
     from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relname = any (pg_temp.f02_tables())
      and (select count(*) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal
              and t.tgfoid = 'private.set_updated_at'::regproc) = 1),
  (select array_agg(t order by t) from unnest(pg_temp.f02_tables()) t),
  'S6: every one of the seven tables has the set_updated_at trigger once');

-- ---------------------------------------------------------------- 2. the fixtures
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.none', tests.make_user('none')::text, true);
  perform set_config('jv.forged', gen_random_uuid()::text, true);
  perform set_config('jv.today', ((clock_timestamp() at time zone 'Asia/Kolkata')::date)::text, true);
end
$mk$;

select pg_temp.fx($q$select set_config('jv.c1', tests.make_category('{"name":"Fixture rings","prefix":"FXR"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.c2', tests.make_category('{"name":"Fixture chains","prefix":"FXC"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.sc1', (tests.insert_row('public.subcategories',
  jsonb_build_object('category_id', current_setting('jv.c1'), 'name', 'Fixture band')) ->> 'id'), true)$q$);
-- d1: By Weight, one piece in stock and one archived. d2: Per Piece with one piece. d3: no piece. d4: archived, archived piece.
select pg_temp.fx($q$select set_config('jv.d1', tests.make_design(jsonb_build_object('design_no', 'FX-D1',
  'category_id', current_setting('jv.c1'), 'subcategory_id', current_setting('jv.sc1')))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.p1', tests.make_piece(current_setting('jv.d1')::uuid,
  '{"sku_no":"FX-D1-001","barcode":"BC-FX-D1-001"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.p3', tests.make_piece(current_setting('jv.d1')::uuid,
  '{"sku_no":"FX-D1-003","barcode":"BC-FX-D1-003","status":"Archived","archived_at":"2026-10-01T00:00:00+00"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.d2', tests.make_design(jsonb_build_object('design_no', 'FX-D2',
  'category_id', current_setting('jv.c1'), 'selling_method', 'Per Piece', 'material', 'Silver', 'purity', '925'))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.p2', tests.make_piece(current_setting('jv.d2')::uuid,
  '{"sku_no":"FX-D2-001","barcode":"BC-FX-D2-001","gross_weight":0,"customer_net_weight":0,"labour_retail":1500,"labour_semi":1400,"labour_wholesale":1300}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.d3', tests.make_design(jsonb_build_object('design_no', 'FX-D3',
  'category_id', current_setting('jv.c2')))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.d4', tests.make_design(jsonb_build_object('design_no', 'FX-D4',
  'category_id', current_setting('jv.c2'), 'archived_at', '2026-10-02T00:00:00+00'))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.p4', tests.make_piece(current_setting('jv.d4')::uuid,
  '{"sku_no":"FX-D4-001","barcode":"BC-FX-D4-001","status":"Archived","archived_at":"2026-10-02T00:00:00+00"}')::text, true)$q$);
select pg_temp.fx($q$insert into public.sku_private (sku_id, original_net_weight) values (current_setting('jv.p1')::uuid, 9.800)$q$);
select pg_temp.fx($q$select set_config('jv.r_today', tests.make_rate(jsonb_build_object('purity', 'FX-T',
  'rate_date', current_setting('jv.today')))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.r_yday', tests.make_rate(jsonb_build_object('purity', 'FX-Y',
  'rate_date', (current_setting('jv.today')::date - 1)::text))::text, true)$q$);
select pg_temp.fx($q$select tests.insert_row('public.settings', '{"key":"fx_business","value":{"name":"Fixture jewellers"}}')$q$);

select is(
  (select count(*)::int from public.designs where id in (current_setting('jv.d1')::uuid, current_setting('jv.d2')::uuid,
     current_setting('jv.d3')::uuid, current_setting('jv.d4')::uuid)),
  4, 'DB01 builders: tests.make_category, make_design, make_piece and make_rate fit the real tables');
select is(
  (select count(*)::int from public.skus where id in (current_setting('jv.p1')::uuid, current_setting('jv.p2')::uuid,
     current_setting('jv.p3')::uuid, current_setting('jv.p4')::uuid)),
  4, 'DB01 builders: and so do the pieces');

-- ---------------------------------------------------------------- 3. T-F02: unique codes, checks, restrict keys (as the database owner)
-- settings
select is(pg_temp.try($$insert into public.settings (key, value) values ('fx_business', '{}')$$), 'err 23505',
  'T-F02, D3: settings holds one row per key: the same key twice is refused');
select is(pg_temp.try($$insert into public.settings (key, value) values ('fx_nulls', null)$$), 'err 23502',
  'D3: a setting has a value');
-- daily_rates
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Platinum', 'FX-1', 100, current_date)$$),
  'err 23514', 'D4: the material is Gold or Silver');
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-1', 0, current_date)$$),
  'err 23514', 'D4: a rate of 0 is refused: it must be greater than 0');
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-1', -5, current_date)$$),
  'err 23514', 'D4, S4: a negative rate is refused');
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-1', 100000001, current_date)$$),
  'err 23514', 'S4: a rate above 100,000,000 is refused by the CHECK');
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-CAP', 100000000, current_date)$$),
  'ok 1', 'S4: a rate of exactly 100,000,000 is accepted');
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', '   ', 100, current_date)$$),
  'err 23514', 'D4: a blank purity is refused');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-T', 100, %L)$$, current_setting('jv.today'))),
  'err 23505', 'D4: one rate per (date, material, purity): the same three again are refused');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Silver', 'FX-T', 100, %L)$$, current_setting('jv.today'))),
  'ok 1', 'D4: the same date and purity for the other material is a different row');
-- categories and subcategories
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('FIXTURE RINGS', 'ZZ1')$$), 'err 23505',
  'T-F02, D5: a category name is unique ignoring case');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Fixture earrings', 'fxe')$$), 'err 23514',
  'D5: a prefix is capitals or digits: lower case is refused');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Fixture earrings', 'F')$$), 'err 23514',
  'D5: a prefix of 1 character is refused');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Fixture earrings', 'FXEARRI')$$), 'err 23514',
  'D5: a prefix of 7 characters is refused');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Fixture earrings', 'FX-E')$$), 'err 23514',
  'D5: a prefix with a dash is refused');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Fixture two', 'F2')$$), 'ok 1',
  'D5: a prefix of 2 characters is accepted');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Fixture six', 'ABC123')$$), 'ok 1',
  'D5: a prefix of 6 capitals and digits is accepted');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('   ', 'FXB')$$), 'err 23514',
  'D5: a blank name is refused');
select is((select active from public.categories where id = current_setting('jv.c1')::uuid), true, 'D5: a category is active unless said otherwise');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, 'FIXTURE BAND')$$, current_setting('jv.c1'))),
  'err 23505', 'T-F02, D5: a subcategory name is unique in its category ignoring case');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, 'Fixture band')$$, current_setting('jv.c2'))),
  'ok 1', 'D5: and the same name in another category is a different subcategory');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, '  ')$$, current_setting('jv.c2'))),
  'err 23514', 'D5: a blank subcategory name is refused');
-- designs
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('fx-d1', %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'))),
  'err 23505', 'T-F02, D6: a design number is unique ignoring case');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-X1', %L, 'Gold', '22K', 'By Piece')$$, current_setting('jv.c1'))),
  'err 23514', 'D6: the selling method is By Weight or Per Piece');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('  ', %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'))),
  'err 23514', 'D6: a blank design number is refused');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-X2', %L, 'Gold', ' ', 'By Weight')$$, current_setting('jv.c1'))),
  'err 23514', 'D6: a blank purity is refused');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-X3', %L, '', '22K', 'By Weight')$$, current_setting('jv.c1'))),
  'err 23514', 'D6: a blank material is refused');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-M1', %L, 'Platinum', '950', 'By Weight')$$, current_setting('jv.c1'))),
  'err 23514', 'D6: a material other than Gold or Silver (Platinum) is refused: the pricing rules know only those two');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-M2', %L, 'gold', '22K', 'By Weight')$$, current_setting('jv.c1'))),
  'err 23514', 'D6: the spelling is exact: gold in lower case is refused');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-M3', %L, 'Gold', '22K', 'By Weight'), ('FX-M4', %L, 'Silver', '925', 'Per Piece')$$, current_setting('jv.c1'), current_setting('jv.c1'))),
  'ok 2', 'D6: Gold and Silver are accepted');
select is(
  (select array_agg(c.conname::text order by c.conname) from pg_constraint c
    where c.conrelid = 'public.designs'::regclass and c.contype = 'c' and c.conname like 'designs\_material%'),
  array['designs_material_check', 'designs_material_not_blank'], 'D6: material has a named check for Gold or Silver beside the not-blank check');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method, primary_image_path) values ('FX-X4', %L, 'Gold', '22K', 'By Weight', 'data:image/jpeg;base64,/9j/4AAQ')$$, current_setting('jv.c1'))),
  'err 23514', 'T-F02, P4: a primary image value that starts with data: is refused');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method, primary_image_path) values ('FX-X5', %L, 'Gold', '22K', 'By Weight', ' DATA:image/png;base64,iVBOR')$$, current_setting('jv.c1'))),
  'err 23514', 'P4: whatever the case or leading space');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method, image_paths) values ('FX-X6', %L, 'Gold', '22K', 'By Weight', array['designs/a/1.jpg', 'Data:image/png;base64,iVBOR'])$$, current_setting('jv.c1'))),
  'err 23514', 'P4: a data: value among the image paths is refused');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method, primary_image_path, image_paths) values ('FX-X7', %L, 'Gold', '22K', 'By Weight', 'designs/a/1.jpg', array['designs/a/1.jpg', 'designs/a/t_1.jpg', 'x/data:y'])$$, current_setting('jv.c1'))),
  'ok 1', 'P4: paths, also one with the word data: inside it, are accepted');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-X8', %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'))),
  'ok 1', 'D6: a design with only the required fields is accepted');
select is((select tags::text || ' ' || image_paths::text from public.designs where design_no = 'FX-X8'), '{} {}',
  'D6: tags and image paths default to empty arrays, never null');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-X9', %L, 'Gold', '22K', 'By Weight')$$, gen_random_uuid())),
  'err 23503', 'D6: the category must exist');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, subcategory_id, material, purity, selling_method) values ('FX-X10', %L, %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'), gen_random_uuid())),
  'err 23503', 'D6: the subcategory, when given, must exist');
-- skus
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'fx-d1-001', 'BC-NEW-1', 1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23505', 'T-F02, D7: a piece number is unique ignoring case');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-NEW-2', 'bc-fx-d1-001', 1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23505', 'T-F02, D7: a barcode is unique ignoring case');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-NEW-3', 'BC-NEW-3', 1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'ok 1', 'D7: a piece with a gross weight left blank (0), the status In Stock and the rates given is accepted');
select is((select gross_weight::text || ' ' || status || ' ' || stones || ' ' || kundan || ' ' || piroi from public.skus where sku_no = 'FX-NEW-3'),
  '0.000 In Stock 0 0 0.00', 'D7, D8: a blank gross weight is stored as 0, the status is In Stock, counts and piroi are 0');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-NEW-4', 'BC-NEW-4', 1, 1, 1, 1)$$, gen_random_uuid())),
  'err 23503', 'D7: the design must exist');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, status) values (%L, 'FX-NEW-5', 'BC-NEW-5', 1, 1, 1, 1, 'Lost')$$, current_setting('jv.d1'))),
  'err 23514', 'D8: a status outside the ten is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, status) select %L, 'FX-ST-' || s.n, 'BC-ST-' || s.n, 1, 1, 1, 1, s.st from (values (1, 'In Stock'), (2, 'Reserved'), (3, 'On Approval'), (4, 'Returned'), (5, 'Repair'), (6, 'Transferred'), (7, 'Missing'), (8, 'Damaged')) s(n, st)$$, current_setting('jv.d1'))),
  'ok 8', 'D8: In Stock, Reserved, On Approval, Returned, Repair, Transferred, Missing and Damaged are accepted (Sold and Archived have their own rule)');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, status) values (%L, 'FX-S1', 'BC-S1', 1, 1, 1, 1, 'Sold')$$, current_setting('jv.d1'))),
  'err 23514', 'T-F02, D8: Sold without a sold_bill_id is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, sold_bill_id) values (%L, 'FX-S2', 'BC-S2', 1, 1, 1, 1, gen_random_uuid())$$, current_setting('jv.d1'))),
  'err 23514', 'T-F02, D8: a sold_bill_id on a piece that is not Sold is refused');
select ok(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, status, sold_bill_id) values (%L, 'FX-S3', 'BC-S3', 1, 1, 1, 1, 'Sold', gen_random_uuid())$$, current_setting('jv.d1')))
    in ('ok 1', 'err 23503'),
  'T-F02, D8: Sold with a sold_bill_id passes the check (the foreign key to bills is DB04''s: before it exists the row is accepted, after it the answer is 23503)');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, status) values (%L, 'FX-A1', 'BC-A1', 1, 1, 1, 1, 'Archived')$$, current_setting('jv.d1'))),
  'err 23514', 'T-F02, D8: Archived without archived_at is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, archived_at) values (%L, 'FX-A2', 'BC-A2', 1, 1, 1, 1, now())$$, current_setting('jv.d1'))),
  'err 23514', 'T-F02, D8: archived_at on a piece that is not Archived is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, status, archived_at) values (%L, 'FX-A3', 'BC-A3', 1, 1, 1, 1, 'Archived', now())$$, current_setting('jv.d1'))),
  'ok 1', 'D8: Archived with archived_at is accepted');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W1', 'BC-W1', -1, 1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'D7, S4: a negative gross weight is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W2', 'BC-W2', -0.001, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'D7, S4: a negative customer net weight is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W3', 'BC-W3', 100000.001, 1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a gross weight above 100,000 g is refused by the CHECK');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W4', 'BC-W4', 100000, 100000, 1, 1, 1)$$, current_setting('jv.d1'))),
  'ok 1', 'S4: a weight of exactly 100,000 g is accepted');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, stone_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W5', 'BC-W5', 0, 1, 100001, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a stone weight above 100,000 g is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, kundan_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W6', 'BC-W6', 0, 1, 100001, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a kundan weight above 100,000 g is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, stone_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-W7', 'BC-W7', 0, 1, -1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a negative stone weight is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, stones, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-C1', 'BC-C1', 0, 1, -1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S3: a negative count of stones is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, kundan, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-C2', 'BC-C2', 0, 1, -1, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S3: a negative count of kundan is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-R1', 'BC-R1', 1, 100000001, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a retail labour rate (or piece price) above 100,000,000 is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-R2', 'BC-R2', 1, 1, 100000001, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: and so is a semi-wholesale one');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-R3', 'BC-R3', 1, 1, 1, 100000001)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: and a wholesale one');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-R4', 'BC-R4', 1, -1, 1, 1)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a negative labour rate is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, piroi) values (%L, 'FX-R5', 'BC-R5', 1, 1, 1, 1, 1000000001)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a piroi above 1,000,000,000 (a line amount) is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, piroi) values (%L, 'FX-R6', 'BC-R6', 1, 1, 1, 1, -2)$$, current_setting('jv.d1'))),
  'err 23514', 'S4: a negative piroi is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, piroi) values (%L, 'FX-R7', 'BC-R7', 1, 100000000, 100000000, 100000000, 1000000000)$$, current_setting('jv.d1'))),
  'ok 1', 'S4: the caps themselves are accepted');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight) values (%L, 'FX-R8', 'BC-R8', 1)$$, current_setting('jv.d1'))),
  'err 23502', 'R1: the three labour rates are never blank: a piece without them is refused');
-- sku_private
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 5)$$, current_setting('jv.p1'))),
  'err 23505', 'D9: one hidden weight per piece (sku_id is the primary key)');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 5)$$, gen_random_uuid())),
  'err 23503', 'D9: the piece must exist');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, -0.001)$$, current_setting('jv.p2'))),
  'err 23514', 'D9, S4: a negative original weight is refused');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 100000.001)$$, current_setting('jv.p2'))),
  'err 23514', 'S4: an original weight above 100,000 g is refused');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 0)$$, current_setting('jv.p2'))),
  'ok 1', 'D9: an original weight of 0 is accepted');
-- restrict foreign keys (T-F02)
select is(
  (select array_agg(distinct c.confdeltype::text) from pg_constraint c
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace),
  array['r'], 'T-F02, S7: every foreign key in public is ON DELETE RESTRICT');
select ok(
  (select array_agg(cl.relname || '.' || a.attname order by 1) from pg_constraint c
     join pg_class cl on cl.oid = c.conrelid join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.contype = 'f' and cl.relnamespace = 'public'::regnamespace and cardinality(c.conkey) = 1)
  @> array['designs.category_id', 'designs.subcategory_id', 'sku_private.sku_id', 'skus.design_id', 'subcategories.category_id'],
  'D5 to D9: subcategories.category_id, designs.category_id, designs.subcategory_id, skus.design_id and sku_private.sku_id are foreign keys');
select is(pg_temp.try(format($$delete from public.categories where id = %L$$, current_setting('jv.c1'))), 'err 23503',
  'T-F02: a category that designs use cannot be deleted, not even by the database owner');
select is(pg_temp.try(format($$delete from public.subcategories where id = %L$$, current_setting('jv.sc1'))), 'err 23503',
  'T-F02: nor a subcategory that a design uses');
select is(pg_temp.try(format($$delete from public.designs where id = %L$$, current_setting('jv.d1'))), 'err 23503',
  'T-F02: nor a design that has pieces');
select is(pg_temp.try(format($$delete from public.skus where id = %L$$, current_setting('jv.p1'))), 'err 23503',
  'T-F02: nor a piece that has a hidden weight');
-- no foreign key lacks an index (lint 0001, T-D11)
select is(
  (select coalesce(array_agg(cl.relname || '.' || c.conname order by cl.relname, c.conname), '{}'::text[])
     from pg_constraint c join pg_class cl on cl.oid = c.conrelid
    where c.contype = 'f' and cl.relnamespace = 'public'::regnamespace and cl.relname = any (pg_temp.f02_tables())
      and not exists (select 1 from pg_index i where i.indrelid = c.conrelid and i.indisvalid
                        and (i.indkey::smallint[])[0:cardinality(c.conkey) - 1] @> c.conkey)),
  '{}'::text[], 'T-D11, D19: every foreign key of the seven tables has an index that starts with its columns');

-- ---------------------------------------------------------------- 4. T-F02: the caps of S4 equal private.limits
select is(pg_temp.cap_drift(), '{}'::text[], 'T-F02, S4: every cap literal in a CHECK equals its row in private.limits, and none is unlisted');
select is((select count(*)::int from pg_temp.expected_caps() e join pg_temp.cap_literals() l on l.tbl = e.tbl and l.col = e.col), 10,
  'T-F02: the ten capped columns are all found in the catalogue');
select pg_temp.fx($q$update private.limits set value = 99999 where name = 'max_weight'$q$);
select is(array_length(pg_temp.cap_drift(), 1), 5,
  'T-F02, test of the test: a different max_weight in private.limits is seen on all five weight columns');
select pg_temp.fx($q$update private.limits set value = 100000 where name = 'max_weight'$q$);
select pg_temp.fx($q$alter table public.daily_rates add constraint daily_rates_fx_second_cap check (rate_per_gram <= 12345) not valid$q$);
select is(pg_temp.cap_drift(), array['daily_rates.rate_per_gram: CHECK says 12345, private.limits.max_rate says 100000000'],
  'T-F02, test of the test: a second, different literal on a capped column is seen');
select pg_temp.fx($q$alter table public.daily_rates drop constraint daily_rates_fx_second_cap$q$);
select pg_temp.fx($q$alter table public.designs add column fx_amount numeric(12, 2) check (fx_amount <= 777)$q$);
select is(pg_temp.cap_drift(), array['designs.fx_amount: a cap of 777 is in a CHECK and on nobody''s list'],
  'T-F02, test of the test: a cap literal on a column nobody listed is seen');
select pg_temp.fx($q$alter table public.designs drop column fx_amount$q$);
select is(pg_temp.cap_drift(), '{}'::text[], 'T-F02: and with the fixture changes undone the lists agree again');

-- ---------------------------------------------------------------- 5. D7 and O37: the weight rules
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O1', 'BC-O1', 10, 10.001, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err P0001', 'T-F02, D7: a customer net weight above the gross weight is refused when a gross weight is recorded');
select throws_like(
  format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O1', 'BC-O1', 10, 10.001, 1, 1, 1)$$, current_setting('jv.d1')),
  'JV_INVALID_INPUT:%', 'D7: with the code JV_INVALID_INPUT');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O2', 'BC-O2', 10, 10, 1, 1, 1)$$, current_setting('jv.d1'))),
  'ok 1', 'D7: a net weight equal to the gross weight is accepted');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O3', 'BC-O3', 0, 12.5, 1, 1, 1)$$, current_setting('jv.d1'))),
  'ok 1', 'D7, O37: with a blank (0) gross weight any net weight is accepted');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O4', 'BC-O4', 5, 0, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err P0001', 'T-F02, O37: a By Weight piece with a customer net weight of 0 is refused');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O5', 'BC-O5', 0, 0, 1, 1, 1)$$, current_setting('jv.d1'))),
  'err P0001', 'O37: also when the gross weight is blank too');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O6', 'BC-O6', 0, 0, 1500, 1400, 1300)$$, current_setting('jv.d2'))),
  'ok 1', 'O37: a Per Piece piece may have weights of 0');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-O7', 'BC-O7', 3, 3.5, 1500, 1400, 1300)$$, current_setting('jv.d2'))),
  'err P0001', 'D7: a Per Piece piece still may not have a net weight above its gross weight');
-- an update of a weight
select is(pg_temp.try(format($$update public.skus set customer_net_weight = 10.001 where id = %L$$, current_setting('jv.p1'))), 'err P0001',
  'D7: an update that makes the net weight exceed the gross weight (10.000) is refused');
select is(pg_temp.try(format($$update public.skus set gross_weight = 9.499 where id = %L$$, current_setting('jv.p1'))), 'err P0001',
  'D7: and so is an update that lowers the gross weight below the net weight (9.500)');
select is(pg_temp.try(format($$update public.skus set customer_net_weight = 0 where id = %L$$, current_setting('jv.p1'))), 'err P0001',
  'O37: an update to a net weight of 0 on a By Weight piece is refused');
select is(pg_temp.try(format($$update public.skus set customer_net_weight = 0, gross_weight = 0 where id = %L$$, current_setting('jv.p2'))), 'ok 1',
  'O37: an update to 0 on a Per Piece piece is accepted');
select is(pg_temp.try(format($$update public.skus set gross_weight = 11, customer_net_weight = 10.5 where id = %L$$, current_setting('jv.p1'))), 'ok 1',
  'D7: a valid update of both weights is accepted');
-- "not on a status-only update": make a row that breaks the rule, with the trigger off, then touch it
select pg_temp.fx($q$alter table public.skus disable trigger user$q$);
select pg_temp.fx($q$update public.skus set gross_weight = 5, customer_net_weight = 7 where id = current_setting('jv.p1')::uuid$q$);
select pg_temp.fx($q$alter table public.skus enable trigger user$q$);
select is(pg_temp.try(format($$update public.skus set status = 'Reserved' where id = %L$$, current_setting('jv.p1'))), 'ok 1',
  'T-F02, D7: the weight rule does not run on a status-only update (a row that already breaks it can still be reserved)');
select is(pg_temp.try(format($$update public.skus set notes = 'a note', location = 'Workshop' where id = %L$$, current_setting('jv.p1'))), 'ok 1',
  'D7: nor on an edit of other columns');
select is(pg_temp.try(format($$update public.skus set customer_net_weight = 8 where id = %L$$, current_setting('jv.p1'))), 'err P0001',
  'D7: but it runs the moment a weight is changed');
select is(pg_temp.try(format($$update public.skus set gross_weight = 5, customer_net_weight = 7 where id = %L$$, current_setting('jv.p1'))), 'ok 1',
  'D7: an update that sets the weights to the values they already have is not a change of a weight');
select pg_temp.fx($q$update public.skus set gross_weight = 10, customer_net_weight = 9.5, status = 'In Stock' where id = current_setting('jv.p1')::uuid$q$);
-- identity
select is(pg_temp.try(format($$update public.skus set sku_no = 'FX-CHANGED' where id = %L$$, current_setting('jv.p1'))), 'err P0001',
  'D7: a piece number never changes after creation, not even by the database owner');
select is(pg_temp.try(format($$update public.skus set barcode = 'BC-CHANGED' where id = %L$$, current_setting('jv.p1'))), 'err P0001',
  'D7: nor a barcode');
select is(pg_temp.try(format($$update public.skus set design_id = %L where id = %L$$, current_setting('jv.d3'), current_setting('jv.p1'))), 'err P0001',
  'D7: nor the design a piece belongs to');
select is(pg_temp.try(format($$update public.skus set sku_no = sku_no, notes = 'same number' where id = %L$$, current_setting('jv.p1'))), 'ok 1',
  'D7: but an update that leaves them as they are is fine');

-- ---------------------------------------------------------------- 6. T-F05: selling method and archive rules (as the database owner)
-- d5: a By Weight design with two pieces, to walk through archiving
select pg_temp.fx($q$select set_config('jv.d5', tests.make_design(jsonb_build_object('design_no', 'FX-D5', 'category_id', current_setting('jv.c2')))::text, true)$q$);
select pg_temp.fx($q$select tests.make_piece(current_setting('jv.d5')::uuid, '{"sku_no":"FX-D5-001","barcode":"BC-FX-D5-001"}')$q$);
select pg_temp.fx($q$select tests.make_piece(current_setting('jv.d5')::uuid, '{"sku_no":"FX-D5-002","barcode":"BC-FX-D5-002"}')$q$);
select throws_like(
  format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.d1')),
  'JV_NOT_ALLOWED:%', 'T-F05, D6: the selling method cannot change while the design has a piece that is not archived');
select is((select selling_method from public.designs where id = current_setting('jv.d1')::uuid), 'By Weight', 'T-F05: and it is unchanged');
select is(pg_temp.try(format($$update public.designs set selling_method = 'By Weight', name = 'Same method' where id = %L$$, current_setting('jv.d1'))), 'ok 1',
  'T-F05: an update that leaves the selling method as it is is fine');
select is(pg_temp.try(format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.d3'))), 'ok 1',
  'T-F05: a design with no piece can change its selling method');
select is(pg_temp.try(format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.d4'))), 'ok 1',
  'T-F05: a design whose pieces are all archived can change it too');
select throws_like(
  format($$update public.designs set selling_method = 'By Weight' where id = %L$$, current_setting('jv.d2')),
  'JV_NOT_ALLOWED:%', 'T-F05: a Per Piece design with a piece cannot become By Weight either');
select is(pg_temp.try(format($$update public.designs set material = 'Silver', purity = '925', category_id = %L where id = %L$$, current_setting('jv.c2'), current_setting('jv.d1'))), 'ok 1',
  'T-F01, D6: material, purity and category can change while pieces exist (they show on every piece through the design)');
select throws_like(
  format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d1')),
  'JV_NOT_ALLOWED:%', 'T-F05, A5: a design with a piece that is not archived cannot be archived');
select is((select archived_at from public.designs where id = current_setting('jv.d1')::uuid), null, 'T-F05: and it is not archived');
select throws_like(
  format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d2')),
  'JV_NOT_ALLOWED:%', 'T-F05: also a design with a single piece');
select is(pg_temp.try(format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d3'))), 'ok 1',
  'T-F05: a design with no piece can be archived');
select is(pg_temp.try(format($$update public.designs set archived_at = null where id = %L$$, current_setting('jv.d3'))), 'ok 1',
  'A5: and brought back');
select is(pg_temp.try(format($$update public.designs set archived_at = now(), name = 'Gone' where id = %L$$, current_setting('jv.d4'))), 'ok 1',
  'T-F05: a design whose every piece is archived can be archived (d4 already is: the piece rule is the same)');
-- d5: two live pieces. The design cannot be archived and keeps its method until both pieces are archived.
select throws_like(
  format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d5')),
  'JV_NOT_ALLOWED:%', 'T-F05: d5 with two live pieces cannot be archived');
select is(pg_temp.try(format($$update public.skus set status = 'Archived', archived_at = now() where design_id = %L and sku_no = 'FX-D5-001'$$, current_setting('jv.d5'))), 'ok 1',
  'D8: the database owner archives one piece (status and archived_at together)');
select throws_like(
  format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d5')),
  'JV_NOT_ALLOWED:%', 'T-F05: with one piece still live the design cannot be archived');
select throws_like(
  format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.d5')),
  'JV_NOT_ALLOWED:%', 'T-F05: nor change its method');
select is(pg_temp.try(format($$update public.skus set status = 'Archived', archived_at = now() where design_id = %L and sku_no = 'FX-D5-002'$$, current_setting('jv.d5'))), 'ok 1',
  'D8: the owner archives the other piece');
select is(pg_temp.try(format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d5'))), 'ok 1',
  'T-F05: now that every piece is archived the design can be archived');
select is(pg_temp.try(format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.d5'))), 'ok 1',
  'T-F05: and its selling method can change');

-- ---------------------------------------------------------------- 7. what the API roles may touch (A3 step 4, A4, A5, S7)
select is(
  (select array_agg(t order by t) from unnest(pg_temp.f02_tables()) t
    where has_table_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_any_column_privilege('anon', 'public.' || t, 'SELECT, INSERT, UPDATE, REFERENCES')),
  null, 'T-D02, A4: anon has no right of any kind on the seven tables');
select is(
  (select array_agg(t order by t) from unnest(pg_temp.f02_tables()) t
    where has_table_privilege('authenticated', 'public.' || t, 'DELETE, TRUNCATE, REFERENCES, TRIGGER')),
  null, 'T-D07, S7: authenticated has no delete, truncate, references or trigger right on the seven tables');
select is(
  (select array_agg(t order by t) from unnest(pg_temp.f02_tables()) t
    where not has_table_privilege('authenticated', 'public.' || t, 'SELECT')),
  null, 'A4: authenticated can select from all seven (the row rules decide who sees what)');
select is(
  (select array_agg(t order by t) from unnest(pg_temp.f02_tables()) t
    where has_table_privilege('authenticated', 'public.' || t, 'INSERT') or has_table_privilege('authenticated', 'public.' || t, 'UPDATE')),
  null, 'A5: no table-wide insert or update right exists: every write right is a column right');
select is(pg_temp.col_privs('authenticated', 'designs', 'INSERT'), '{}'::text[], 'A4: nobody can insert into designs through the API');
select is(pg_temp.col_privs('authenticated', 'skus', 'INSERT'), '{}'::text[], 'A4: nor into skus');
select is(pg_temp.col_privs('authenticated', 'designs', 'UPDATE'),
  array['archived_at', 'category_id', 'description', 'image_paths', 'material', 'name', 'notes', 'primary_image_path', 'purity', 'selling_method', 'subcategory_id', 'tags'],
  'T-D19, A5: the columns of a design that can be updated: the content columns, archived_at, and material, purity and selling_method');
select is(pg_temp.col_privs('authenticated', 'skus', 'UPDATE'),
  array['customer_net_weight', 'gross_weight', 'kundan', 'kundan_weight', 'labour_retail', 'labour_semi', 'labour_wholesale', 'location', 'notes', 'piroi', 'stone_weight', 'stones'],
  'T-D19, A5: the columns of a piece that can be updated: the twelve content columns, never status or archived_at');
select is(pg_temp.col_privs('authenticated', 'settings', 'INSERT'), array['key', 'updated_by', 'value'], 'A4: what can be inserted into settings');
select is(pg_temp.col_privs('authenticated', 'settings', 'UPDATE'), array['updated_by', 'value'], 'A4: what can be updated in settings (never the key)');
select is(pg_temp.col_privs('authenticated', 'daily_rates', 'INSERT'),
  array['confirmed_by', 'material', 'purity', 'rate_date', 'rate_per_gram'], 'A4: what can be inserted into daily_rates');
select is(pg_temp.col_privs('authenticated', 'daily_rates', 'UPDATE'), array['confirmed_by', 'rate_per_gram'],
  'A4, D4: and what can be corrected in a rate: the rate itself (never its date, material or purity)');
select is(pg_temp.col_privs('authenticated', 'categories', 'INSERT'), array['active', 'created_by', 'name', 'prefix', 'updated_by'], 'A4: what can be inserted into categories');
select is(pg_temp.col_privs('authenticated', 'categories', 'UPDATE'), array['active', 'name', 'prefix', 'updated_by'], 'A4: what can be updated in categories');
select is(pg_temp.col_privs('authenticated', 'subcategories', 'INSERT'), array['active', 'category_id', 'created_by', 'name', 'updated_by'], 'A4: what can be inserted into subcategories');
select is(pg_temp.col_privs('authenticated', 'subcategories', 'UPDATE'), array['active', 'name', 'updated_by'], 'A4: what can be updated in subcategories');
select is(pg_temp.col_privs('authenticated', 'sku_private', 'INSERT'), array['created_by', 'original_net_weight', 'sku_id', 'updated_by'], 'D9: what can be inserted into sku_private');
select is(pg_temp.col_privs('authenticated', 'sku_private', 'UPDATE'), array['original_net_weight', 'updated_by'], 'D9: what can be updated in sku_private');
select is(
  (select array_agg(c.relname || '.' || p.polname || ':' || p.polcmd::text order by c.relname, p.polname)
     from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace and c.relname = any (pg_temp.f02_tables())),
  array['categories.categories_insert:a', 'categories.categories_select:r', 'categories.categories_update:w',
        'daily_rates.daily_rates_insert:a', 'daily_rates.daily_rates_select:r', 'daily_rates.daily_rates_update:w',
        'designs.designs_select:r', 'designs.designs_update:w',
        'settings.settings_insert:a', 'settings.settings_select:r', 'settings.settings_update:w',
        'sku_private.sku_private_insert:a', 'sku_private.sku_private_select:r', 'sku_private.sku_private_update:w',
        'skus.skus_select:r', 'skus.skus_update:w',
        'subcategories.subcategories_insert:a', 'subcategories.subcategories_select:r', 'subcategories.subcategories_update:w'],
  'A7, lint 0006: one policy per command on each table, and none at all for insert on designs and skus, or for delete anywhere');

-- ---------------------------------------------------------------- 8. anon: nothing (A4)
select tests.as_anon();
select is(pg_temp.cnt('settings'), 'err 42501', 'A4: anon cannot read settings');
select is(pg_temp.cnt('daily_rates'), 'err 42501', 'A4: anon cannot read daily_rates');
select is(pg_temp.cnt('categories'), 'err 42501', 'A4: anon cannot read categories');
select is(pg_temp.cnt('subcategories'), 'err 42501', 'A4: anon cannot read subcategories');
select is(pg_temp.cnt('designs'), 'err 42501', 'A4: anon cannot read designs');
select is(pg_temp.cnt('skus'), 'err 42501', 'A4: anon cannot read skus');
select is(pg_temp.cnt('sku_private'), 'err 42501', 'A4: anon cannot read sku_private');
select is(pg_temp.try($$insert into public.settings (key, value) values ('fx_anon', '{}')$$), 'err 42501', 'A4: anon cannot insert into settings');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-A', 7000, %L)$$, current_setting('jv.today'))), 'err 42501', 'A4: anon cannot insert into daily_rates');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Anon cat', 'ANC')$$), 'err 42501', 'A4: anon cannot insert into categories');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, 'Anon sub')$$, current_setting('jv.c1'))), 'err 42501', 'A4: anon cannot insert into subcategories');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 1)$$, current_setting('jv.p3'))), 'err 42501', 'A4: anon cannot insert into sku_private');
select is(pg_temp.try($$update public.settings set value = '{}' where key = 'fx_business'$$), 'err 42501', 'A4: anon cannot update settings');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 1 where id = %L$$, current_setting('jv.r_today'))), 'err 42501', 'A4: anon cannot update daily_rates');
select is(pg_temp.try(format($$update public.categories set name = 'Anon' where id = %L$$, current_setting('jv.c1'))), 'err 42501', 'A4: anon cannot update categories');
select is(pg_temp.try(format($$update public.subcategories set name = 'Anon' where id = %L$$, current_setting('jv.sc1'))), 'err 42501', 'A4: anon cannot update subcategories');
select is(pg_temp.try(format($$update public.designs set name = 'Anon' where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'A4: anon cannot update designs');
select is(pg_temp.try(format($$update public.skus set notes = 'Anon' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'A4: anon cannot update skus');
select is(pg_temp.try(format($$update public.sku_private set original_net_weight = 1 where sku_id = %L$$, current_setting('jv.p1'))), 'err 42501', 'A4: anon cannot update sku_private');
select is(pg_temp.try($$delete from public.designs$$), 'err 42501', 'S7: anon cannot delete');
select tests.reset_role();

-- ---------------------------------------------------------------- 9. a login that is not active, or has no profile, reads nothing (A10)
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.cnt('settings') || ' ' || pg_temp.cnt('daily_rates') || ' ' || pg_temp.cnt('categories') || ' ' || pg_temp.cnt('subcategories'),
  '0 0 0 0', 'A10: an inactive profile reads no setting, rate, category or subcategory');
select is(pg_temp.cnt('designs') || ' ' || pg_temp.cnt('skus') || ' ' || pg_temp.cnt('sku_private'),
  '0 0 0', 'A10: nor any design, piece or hidden weight');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Inactive cat', 'INC')$$), 'err 42501', 'A10: and cannot add a category');
select is(pg_temp.try(format($$update public.skus set notes = 'x' where id = %L$$, current_setting('jv.p1'))), 'ok 0', 'A10: nor edit a piece');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.cnt('settings') || ' ' || pg_temp.cnt('daily_rates') || ' ' || pg_temp.cnt('categories') || ' ' || pg_temp.cnt('subcategories'),
  '0 0 0 0', 'A10: a login with no profile reads no setting, rate, category or subcategory');
select is(pg_temp.cnt('designs') || ' ' || pg_temp.cnt('skus') || ' ' || pg_temp.cnt('sku_private'),
  '0 0 0', 'A10: nor any design, piece or hidden weight');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-N', 7000, %L)$$, current_setting('jv.today'))), 'err 42501', 'A10: and cannot add a rate');
select tests.reset_role();

-- ---------------------------------------------------------------- 10. the reads: every read role sees every row, archived ones too (A4, T-D19)
do $cnt$
begin
  perform set_config('jv.n_settings', (select count(*)::text from public.settings), true);
  perform set_config('jv.n_daily_rates', (select count(*)::text from public.daily_rates), true);
  perform set_config('jv.n_categories', (select count(*)::text from public.categories), true);
  perform set_config('jv.n_subcategories', (select count(*)::text from public.subcategories), true);
  perform set_config('jv.n_designs', (select count(*)::text from public.designs), true);
  perform set_config('jv.n_skus', (select count(*)::text from public.skus), true);
  perform set_config('jv.n_sku_private', (select count(*)::text from public.sku_private), true);
end
$cnt$;
create function pg_temp.read_checks(p_label text) returns setof text language plpgsql as $f$
declare
  t text;
begin
  foreach t in array array['settings', 'daily_rates', 'categories', 'subcategories', 'designs', 'skus'] loop
    return next is(pg_temp.cnt(t), current_setting('jv.n_' || t), 'A4, A9: ' || p_label || ' reads every row of ' || t);
  end loop;
  return next is(pg_temp.cnt('designs', format('id = %L and archived_at is not null', current_setting('jv.d4'))), '1',
    'T-D19, A4: ' || p_label || ' can read an archived design');
  return next is(pg_temp.cnt('skus', format('id = %L and status = ''Archived'' and archived_at is not null', current_setting('jv.p4'))), '1',
    'T-D19, A4: ' || p_label || ' can read an archived piece');
  return next is(pg_temp.cnt('sku_private'), case when p_label = 'the owner' then current_setting('jv.n_sku_private') else '0' end,
    case when p_label = 'the owner' then 'D9: the owner reads the hidden weights'
         else 'T-D03, T-D04, D9: ' || p_label || ' sees no hidden weight, though rows exist' end);
end
$f$;
grant execute on function pg_temp.read_checks(text) to public;
select tests.as_user(current_setting('jv.owner')::uuid);
select * from pg_temp.read_checks('the owner');
select tests.as_user(current_setting('jv.biller')::uuid);
select * from pg_temp.read_checks('a biller');
select tests.as_user(current_setting('jv.staff')::uuid);
select * from pg_temp.read_checks('staff');
select tests.reset_role();

-- ---------------------------------------------------------------- 11. the owner (A4, A5)
select tests.as_user(current_setting('jv.owner')::uuid);
-- settings: S, I, U
select is(pg_temp.try($$insert into public.settings (key, value) values ('fx_owner_key', '{"a": 1}')$$), 'ok 1', 'A4: the owner can insert a setting');
select is(pg_temp.try($$update public.settings set value = '{"a": 2}' where key = 'fx_owner_key'$$), 'ok 1', 'A4: and update it');
select is(pg_temp.try($$update public.settings set key = 'fx_renamed' where key = 'fx_owner_key'$$), 'err 42501', 'D3: but not change its key');
select is(pg_temp.try($$delete from public.settings where key = 'fx_owner_key'$$), 'err 42501', 'S7: and nobody deletes one, the owner included');
-- daily_rates: S, I (up to today), U (a row dated today)
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-O1', 7000, %L)$$, current_setting('jv.today'))), 'ok 1', 'T-D05, D4: the owner can add a rate dated today');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-O1', 6900, %L)$$, (current_setting('jv.today')::date - 1)::text)), 'ok 1', 'T-D05, D4: and one dated yesterday');
select is(pg_temp.try($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-O1', 6000, '2020-01-01')$$), 'ok 1', 'T-D05, D4: and one dated years ago (any date up to today)');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-O1', 7100, %L)$$, (current_setting('jv.today')::date + 1)::text)), 'err 42501', 'T-D05, D4: but not one dated tomorrow');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 7123.45 where id = %L$$, current_setting('jv.r_today'))), 'ok 1', 'T-D05, D4: the owner can correct a row dated today');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 6543.21 where id = %L$$, current_setting('jv.r_yday'))), 'ok 0', 'T-D05, D4: but not a row dated yesterday: nothing changes');
select is(pg_temp.try(format($$update public.daily_rates set rate_date = %L where id = %L$$, (current_setting('jv.today')::date - 3)::text, current_setting('jv.r_today'))), 'err 42501', 'D4: the date of a rate cannot be changed');
select is(pg_temp.try(format($$update public.daily_rates set purity = 'FX-ZZ' where id = %L$$, current_setting('jv.r_today'))), 'err 42501', 'D4: nor its purity');
select is(pg_temp.try(format($$update public.daily_rates set material = 'Silver' where id = %L$$, current_setting('jv.r_today'))), 'err 42501', 'D4: nor its material');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 0 where id = %L$$, current_setting('jv.r_today'))), 'err 23514', 'D4: a corrected rate must still be greater than 0');
select is(pg_temp.try(format($$delete from public.daily_rates where id = %L$$, current_setting('jv.r_today'))), 'err 42501', 'S7: and no rate is deleted');
-- categories and subcategories: S, I, U
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Owner cat', 'OWN')$$), 'ok 1', 'A4: the owner can add a category');
select is(pg_temp.try(format($$update public.categories set name = 'Fixture rings (renamed)', prefix = 'FXZ', active = false where id = %L$$, current_setting('jv.c1'))), 'ok 1', 'A4: and rename it, change its prefix and deactivate it');
select is(pg_temp.try(format($$update public.categories set id = gen_random_uuid() where id = %L$$, current_setting('jv.c2'))), 'err 42501', 'S2: but not change its id');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, 'Owner sub')$$, current_setting('jv.c1'))), 'ok 1', 'A4: the owner can add a subcategory');
select is(pg_temp.try(format($$update public.subcategories set name = 'Fixture band 2', active = false where id = %L$$, current_setting('jv.sc1'))), 'ok 1', 'A4: and rename or deactivate one');
select is(pg_temp.try(format($$update public.subcategories set category_id = %L where id = %L$$, current_setting('jv.c2'), current_setting('jv.sc1'))), 'err 42501', 'D5: but not move it to another category');
select is(pg_temp.try($$delete from public.categories$$), 'err 42501', 'S7: and nobody deletes a category');
-- designs: S, U content columns, archived_at, material, purity, selling_method; no insert
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-OWN1', %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'))), 'err 42501', 'A4: not even the owner inserts a design directly: create_design does');
select is(pg_temp.try(format($$update public.designs set name = 'N', description = 'D', notes = 'Nt', tags = array['a', 'b'], primary_image_path = 'designs/x/1.jpg', image_paths = array['designs/x/1.jpg'], category_id = %L, subcategory_id = null where id = %L$$, current_setting('jv.c2'), current_setting('jv.d1'))), 'ok 1', 'A5: the owner can edit every content column of a design');
select is(pg_temp.try(format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d3'))), 'ok 1', 'A5: and archive a design that has no live piece');
select is(pg_temp.try(format($$update public.designs set material = 'Silver', purity = '999' where id = %L$$, current_setting('jv.d1'))), 'ok 1', 'A4: the owner can change material and purity');
select is(pg_temp.try(format($$update public.designs set material = 'Platinum' where id = %L$$, current_setting('jv.d1'))), 'err 23514', 'D6: but not to a material other than Gold or Silver: the check refuses it');
select is((select material from public.designs where id = current_setting('jv.d1')::uuid), 'Silver', 'D6: and the design keeps its material');
select is(pg_temp.try(format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.d4'))), 'ok 1', 'A4: and the selling method (here of a design with no live piece)');
select is(pg_temp.try(format($$update public.designs set design_no = 'FX-NEW' where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19: a column outside the content columns cannot be updated: design_no');
select is(pg_temp.try(format($$update public.designs set import_batch_id = gen_random_uuid() where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19: nor import_batch_id');
select is(pg_temp.try(format($$update public.designs set created_by = gen_random_uuid() where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19, D22: nor created_by');
select is(pg_temp.try(format($$update public.designs set updated_at = now() where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19, S6: nor updated_at');
select is(pg_temp.try(format($$delete from public.designs where id = %L$$, current_setting('jv.d3'))), 'err 42501', 'S7: nobody deletes a design');
-- skus: S, U content columns; no insert
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-OWN-1', 'BC-OWN-1', 1, 1, 1, 1)$$, current_setting('jv.d1'))), 'err 42501', 'A4: nobody inserts a piece directly');
select is(pg_temp.try(format($$update public.skus set gross_weight = 20, customer_net_weight = 19, stones = 3, stone_weight = 0.5, kundan = 2, kundan_weight = 0.25, piroi = 12.5, labour_retail = 400, labour_semi = 350, labour_wholesale = 300, location = 'Workshop', notes = 'Edited' where id = %L$$, current_setting('jv.p1'))), 'ok 1', 'A5: the owner can edit all twelve content columns of a piece');
select is(pg_temp.try(format($$update public.skus set status = 'Damaged' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-C07, A5: a stock edit cannot change status (X9 does)');
select is(pg_temp.try(format($$update public.skus set archived_at = now() where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-C07, A5: nor archived_at');
select is(pg_temp.try(format($$update public.skus set status = 'Archived', archived_at = now() where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-C07, D8: nor archive a piece by sending both');
select is(pg_temp.try(format($$update public.skus set sold_bill_id = gen_random_uuid() where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-D19: nor sold_bill_id');
select is(pg_temp.try(format($$update public.skus set sku_no = 'FX-CH' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-D19, D7: nor sku_no');
select is(pg_temp.try(format($$update public.skus set barcode = 'BC-CH' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-D19, D7: nor barcode');
select is(pg_temp.try(format($$update public.skus set design_id = %L where id = %L$$, current_setting('jv.d3'), current_setting('jv.p1'))), 'err 42501', 'T-D19, D7: nor design_id');
select is(pg_temp.try(format($$update public.skus set import_batch_id = gen_random_uuid() where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-D19: nor import_batch_id');
select is(pg_temp.try(format($$update public.skus set customer_net_weight = 25 where id = %L$$, current_setting('jv.p1'))), 'err P0001', 'D7: a content edit that breaks the weight rule is refused (net 25 above gross 20)');
select is(pg_temp.try(format($$delete from public.skus where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'S7: nobody deletes a piece');
-- sku_private: S, I, U
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 3.210)$$, current_setting('jv.p3'))), 'ok 1', 'D9, T-D03: the owner can insert a hidden weight');
select is(pg_temp.try(format($$update public.sku_private set original_net_weight = 3.250 where sku_id = %L$$, current_setting('jv.p3'))), 'ok 1', 'D9: and update it');
select is((select original_net_weight::text from public.sku_private where sku_id = current_setting('jv.p3')::uuid), '3.250', 'D9: and read it back');
select is(pg_temp.try(format($$update public.sku_private set sku_id = %L where sku_id = %L$$, current_setting('jv.p4'), current_setting('jv.p3'))), 'err 42501', 'D9: but not move it to another piece');
select is(pg_temp.try(format($$delete from public.sku_private where sku_id = %L$$, current_setting('jv.p3'))), 'err 42501', 'S7: and nobody deletes it');
select tests.reset_role();

-- ---------------------------------------------------------------- 12. a biller (A4, A5, T-D04)
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try($$insert into public.settings (key, value) values ('fx_biller_key', '{}')$$), 'err 42501', 'T-D05, A4: a biller cannot insert a setting');
select is(pg_temp.try($$update public.settings set value = '{"x": 1}' where key = 'fx_business'$$), 'ok 0', 'T-D04, T-D05: nor change one: the update touches no row');
select is((select value ->> 'name' from public.settings where key = 'fx_business'), 'Fixture jewellers', 'T-D05: and the setting is as it was');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-B1', 7000, %L)$$, current_setting('jv.today'))), 'ok 1', 'T-D05, D4: a biller can add a rate dated today');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-B1', 7001, %L)$$, current_setting('jv.today'))), 'err 23505', 'D4: but only once per material and purity and day');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-B2', 6900, %L)$$, (current_setting('jv.today')::date - 1)::text)), 'err 42501', 'T-D05, D4: a biller cannot add a rate dated yesterday');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-B3', 7100, %L)$$, (current_setting('jv.today')::date + 1)::text)), 'err 42501', 'T-D05, D4: nor tomorrow');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 1 where id = %L$$, current_setting('jv.r_today'))), 'ok 0', 'T-D05: a biller cannot correct a rate, not even today''s');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 1 where purity = 'FX-B1' and rate_date = %L$$, current_setting('jv.today'))), 'ok 0', 'T-D05: not even the one the biller just added');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Biller cat', 'BLR')$$), 'err 42501', 'A4: a biller cannot add a category');
select is(pg_temp.try(format($$update public.categories set name = 'Biller' where id = %L$$, current_setting('jv.c2'))), 'ok 0', 'A4: nor rename one');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, 'Biller sub')$$, current_setting('jv.c2'))), 'err 42501', 'A4: nor add a subcategory');
select is(pg_temp.try(format($$update public.subcategories set name = 'Biller' where id = %L$$, current_setting('jv.sc1'))), 'ok 0', 'A4: nor rename one');
select is(pg_temp.try(format($$update public.designs set name = 'Biller' where id = %L$$, current_setting('jv.d1'))), 'ok 0', 'T-D04, A4: a biller cannot change a design');
select is(pg_temp.try(format($$update public.designs set material = 'Silver' where id = %L$$, current_setting('jv.d1'))), 'ok 0', 'T-D04: nor its material');
select is(pg_temp.try(format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d3'))), 'ok 0', 'T-D04: nor archive it');
select is(pg_temp.try(format($$update public.designs set design_no = 'X' where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19: nor a column outside the content columns');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-BLR1', %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'))), 'err 42501', 'A4: nor insert a design');
select is(pg_temp.try(format($$update public.skus set notes = 'Biller', gross_weight = 99 where id = %L$$, current_setting('jv.p1'))), 'ok 0', 'T-D04, A4: a biller cannot change stock');
select is(pg_temp.try(format($$update public.skus set status = 'Sold' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-D04, T-C07: nor a status');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-BLR-1', 'BC-BLR-1', 1, 1, 1, 1)$$, current_setting('jv.d1'))), 'err 42501', 'A4: nor insert a piece');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 1)$$, current_setting('jv.p2'))), 'err 42501', 'T-D03, T-D04, D9: a biller cannot insert a hidden weight');
select is(pg_temp.try(format($$update public.sku_private set original_net_weight = 1 where sku_id = %L$$, current_setting('jv.p1'))), 'ok 0', 'T-D04, D9: nor change one');
select is(pg_temp.try('delete from public.settings'), 'err 42501', 'S7: nor delete anything');
select tests.reset_role();
select is((select original_net_weight::text from public.sku_private where sku_id = current_setting('jv.p1')::uuid), '9.800', 'D9: and the hidden weight is as it was');

-- ---------------------------------------------------------------- 13. staff (A4, A5, T-D03, T-D04, T-D19)
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try($$insert into public.settings (key, value) values ('fx_staff_key', '{}')$$), 'err 42501', 'T-D05, A4: staff cannot insert a setting');
select is(pg_temp.try($$update public.settings set value = '{"x": 1}' where key = 'fx_business'$$), 'ok 0', 'T-D05: nor change one');
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-S1', 7000, %L)$$, current_setting('jv.today'))), 'err 42501', 'T-D05, A4: staff cannot add a rate, not even for today');
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 1 where id = %L$$, current_setting('jv.r_today'))), 'ok 0', 'T-D05: nor correct one');
select is(pg_temp.try($$insert into public.categories (name, prefix) values ('Staff cat', 'STF')$$), 'ok 1', 'A4: staff can add a category');
select is(pg_temp.try(format($$insert into public.subcategories (category_id, name) values (%L, 'Staff sub')$$, current_setting('jv.c2'))), 'ok 1', 'A4: and a subcategory');
select is(pg_temp.try(format($$update public.categories set name = 'Staff' where id = %L$$, current_setting('jv.c2'))), 'ok 0', 'A4: but cannot rename a category');
select is(pg_temp.try(format($$update public.subcategories set name = 'Staff' where id = %L$$, current_setting('jv.sc1'))), 'ok 0', 'A4: nor a subcategory');
select is(pg_temp.try(format($$insert into public.designs (design_no, category_id, material, purity, selling_method) values ('FX-STF1', %L, 'Gold', '22K', 'By Weight')$$, current_setting('jv.c1'))), 'err 42501', 'A4: staff cannot insert a design directly (create_design does)');
select is(pg_temp.try(format($$update public.designs set name = 'N', description = 'D', notes = 'Nt', tags = array['a'], primary_image_path = 'designs/x/1.jpg', image_paths = array['designs/x/1.jpg'], category_id = %L, subcategory_id = null where id = %L$$, current_setting('jv.c2'), current_setting('jv.d1'))), 'ok 1', 'A5: staff can edit the content columns of a design');
select is(pg_temp.try(format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d3'))), 'ok 1', 'T-D19, A4: an update by staff of archived_at on a design succeeds');
select is((select archived_at is not null from public.designs where id = current_setting('jv.d3')::uuid), true, 'T-D19: and the design is archived');
select is(pg_temp.try(format($$update public.designs set archived_at = null where id = %L$$, current_setting('jv.d3'))), 'ok 1', 'A5: staff can bring it back');
select throws_like(
  format($$update public.designs set archived_at = now() where id = %L$$, current_setting('jv.d1')),
  'JV_NOT_ALLOWED:%', 'T-F05, A5: but not archive a design that has a piece which is not archived');
select throws_like(
  format($$update public.designs set material = 'Silver' where id = %L$$, current_setting('jv.d3')),
  'JV_FORBIDDEN:%', 'T-D04, A5: staff cannot change a design''s material');
select throws_like(
  format($$update public.designs set purity = '999' where id = %L$$, current_setting('jv.d3')),
  'JV_FORBIDDEN:%', 'T-D04, A5: nor its purity');
select throws_like(
  format($$update public.designs set selling_method = 'By Weight' where id = %L$$, current_setting('jv.d3')),
  'JV_FORBIDDEN:%', 'T-D04, A5: nor its selling method, even when it has no piece (d3 is Per Piece since step 6)');
select is(pg_temp.try(format($$update public.designs set material = material, purity = purity, selling_method = selling_method, name = 'Same values' where id = %L$$, current_setting('jv.d3'))), 'ok 1',
  'A5: sending the values they already have is not a change');
select is((select material || '/' || purity || '/' || selling_method from public.designs where id = current_setting('jv.d3')::uuid), 'Gold/22K/Per Piece',
  'T-D04: the design is as it was');
select is(pg_temp.try(format($$update public.designs set design_no = 'X' where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19: a column outside the content columns cannot be updated: design_no');
select is(pg_temp.try(format($$update public.designs set import_batch_id = null where id = %L$$, current_setting('jv.d1'))), 'err 42501', 'T-D19: nor import_batch_id');
select is(pg_temp.try(format($$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale) values (%L, 'FX-STF-1', 'BC-STF-1', 1, 1, 1, 1)$$, current_setting('jv.d1'))), 'err 42501', 'A4: staff cannot insert a piece directly');
select is(pg_temp.try(format($$update public.skus set gross_weight = 21, customer_net_weight = 20, stones = 1, stone_weight = 0.1, kundan = 1, kundan_weight = 0.1, piroi = 5, labour_retail = 410, labour_semi = 360, labour_wholesale = 310, location = 'Exhibition', notes = 'Staff edit' where id = %L$$, current_setting('jv.p1'))), 'ok 1', 'A5: staff can edit all twelve content columns of a piece');
select is(pg_temp.try(format($$update public.skus set status = 'Damaged' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-C07, A5: staff cannot change the status through a stock edit');
select is(pg_temp.try(format($$update public.skus set archived_at = now() where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-C07, A5: nor archived_at');
select is(pg_temp.try(format($$update public.skus set sku_no = 'FX-CH', barcode = 'BC-CH' where id = %L$$, current_setting('jv.p1'))), 'err 42501', 'T-D19: nor the number or the barcode');
select is(pg_temp.try(format($$update public.skus set design_id = %L where id = %L$$, current_setting('jv.d3'), current_setting('jv.p1'))), 'err 42501', 'T-D19: nor the design');
select is(pg_temp.try(format($$update public.skus set customer_net_weight = 0 where id = %L$$, current_setting('jv.p1'))), 'err P0001', 'O37: a stock edit to a net weight of 0 on a By Weight piece is refused');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight) values (%L, 1)$$, current_setting('jv.p2'))), 'err 42501', 'T-D03, D9: staff cannot insert a hidden weight');
select is(pg_temp.try(format($$update public.sku_private set original_net_weight = 1 where sku_id = %L$$, current_setting('jv.p1'))), 'ok 0', 'T-D03, D9: nor change one');
select is(pg_temp.try('delete from public.skus'), 'err 42501', 'S7: nor delete anything');
select tests.reset_role();
select is((select original_net_weight::text from public.sku_private where sku_id = current_setting('jv.p1')::uuid), '9.800', 'D9: and the hidden weight is as it was');

-- ---------------------------------------------------------------- 14. T-C07: a stale edit changes nothing
select pg_temp.fx($q$select set_config('jv.t_p2', (select updated_at::text from public.skus where id = current_setting('jv.p2')::uuid), true)$q$);
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$update public.skus set notes = 'first edit' where id = %L and updated_at = %L$$, current_setting('jv.p2'), current_setting('jv.t_p2'))), 'ok 1',
  'T-C07, A5: an edit that carries the updated_at it was read with changes the row');
select is(pg_temp.try(format($$update public.skus set notes = 'stale edit' where id = %L and updated_at = %L$$, current_setting('jv.p2'), current_setting('jv.t_p2'))), 'ok 0',
  'T-C07, A5: the same edit again carries a stale updated_at and changes nothing');
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$update public.skus set notes = 'owner stale edit' where id = %L and updated_at = %L$$, current_setting('jv.p2'), current_setting('jv.t_p2'))), 'ok 0',
  'T-C07: the owner''s stale edit changes nothing either');
select tests.reset_role();
select is((select notes from public.skus where id = current_setting('jv.p2')::uuid), 'first edit', 'T-C07: and the row holds the first edit');
select isnt((select updated_at::text from public.skus where id = current_setting('jv.p2')::uuid), current_setting('jv.t_p2'), 'T-C07: because the first edit moved updated_at');

-- ---------------------------------------------------------------- 15. T-D22 and T-D05 (the forced columns): the signed-in user, whatever the client sends
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date, confirmed_by) values ('Gold', 'FX-F1', 7000, %L, %L)$$, current_setting('jv.today'), current_setting('jv.forged'))), 'ok 1', 'T-D05: a rate sent with somebody else as confirmed_by is accepted');
select tests.reset_role();
select is((select confirmed_by from public.daily_rates where purity = 'FX-F1'), current_setting('jv.owner')::uuid, 'T-D05, T-D22: and confirmed_by is the signed-in owner, not what was sent');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$insert into public.daily_rates (material, purity, rate_per_gram, rate_date, confirmed_by) values ('Gold', 'FX-F2', 7000, %L, %L)$$, current_setting('jv.today'), current_setting('jv.forged'))), 'ok 1', 'T-D05: the same for a biller');
select tests.reset_role();
select is((select confirmed_by from public.daily_rates where purity = 'FX-F2'), current_setting('jv.biller')::uuid, 'T-D05, T-D22: confirmed_by is the biller');
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$update public.daily_rates set rate_per_gram = 7001, confirmed_by = %L where purity = 'FX-F2' and rate_date = %L$$, current_setting('jv.forged'), current_setting('jv.today'))), 'ok 1', 'T-D05: the owner corrects the biller''s rate and sends a forged confirmed_by');
select tests.reset_role();
select is((select confirmed_by from public.daily_rates where purity = 'FX-F2'), current_setting('jv.owner')::uuid, 'T-D05, T-D22: the owner confirmed the corrected rate');
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$insert into public.settings (key, value, updated_by) values ('fx_forged', '{}', %L)$$, current_setting('jv.forged'))), 'ok 1', 'T-D22: a setting sent with a forged updated_by is accepted');
select is(pg_temp.try(format($$insert into public.categories (name, prefix, created_by, updated_by) values ('Forged cat', 'FRG', %L, %L)$$, current_setting('jv.forged'), current_setting('jv.forged'))), 'ok 1', 'T-D22: a category sent with a forged created_by and updated_by is accepted');
select is(pg_temp.try(format($$insert into public.sku_private (sku_id, original_net_weight, created_by, updated_by) values (%L, 4, %L, %L)$$, current_setting('jv.p4'), current_setting('jv.forged'), current_setting('jv.forged'))), 'ok 1', 'T-D22: a hidden weight sent with a forged created_by and updated_by is accepted');
select tests.reset_role();
select is((select updated_by from public.settings where key = 'fx_forged'), current_setting('jv.owner')::uuid, 'T-D22: settings.updated_by is the signed-in user');
select is((select array[created_by, updated_by] from public.categories where name = 'Forged cat'), array[current_setting('jv.owner')::uuid, current_setting('jv.owner')::uuid], 'T-D22: categories.created_by and updated_by are the signed-in user');
select is((select array[created_by, updated_by] from public.sku_private where sku_id = current_setting('jv.p4')::uuid), array[current_setting('jv.owner')::uuid, current_setting('jv.owner')::uuid], 'T-D22: sku_private.created_by and updated_by are the signed-in user');
-- an update as a different user: the claims stay, the role is the database owner's (the trigger only reads auth.uid())
select tests.as_user(current_setting('jv.staff')::uuid);
reset role;
select pg_temp.fx($q$update public.categories set name = 'Forged cat 2', created_by = current_setting('jv.forged')::uuid, updated_by = current_setting('jv.forged')::uuid where name = 'Forged cat'$q$);
select pg_temp.fx($q$update public.settings set value = '{"n": 2}', updated_by = current_setting('jv.forged')::uuid where key = 'fx_forged'$q$);
select pg_temp.fx($q$update public.daily_rates set rate_per_gram = 7002, confirmed_by = current_setting('jv.forged')::uuid where purity = 'FX-F2'$q$);
select pg_temp.fx($q$insert into public.designs (design_no, category_id, material, purity, selling_method, created_by, updated_by)
  values ('FX-F3', current_setting('jv.c1')::uuid, 'Gold', '22K', 'By Weight', current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid)$q$);
select pg_temp.fx($q$insert into public.skus (design_id, sku_no, barcode, customer_net_weight, labour_retail, labour_semi, labour_wholesale, created_by, updated_by)
  select id, 'FX-F3-001', 'BC-FX-F3-001', 1, 1, 1, 1, current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid from public.designs where design_no = 'FX-F3'$q$);
select tests.reset_role();
select is((select array[created_by, updated_by] from public.categories where name = 'Forged cat 2'), array[current_setting('jv.owner')::uuid, current_setting('jv.staff')::uuid],
  'T-D22: on update created_by keeps its value and updated_by is the user who made the update');
select is((select updated_by from public.settings where key = 'fx_forged'), current_setting('jv.staff')::uuid, 'T-D22: settings.updated_by follows the user of the update');
select is((select confirmed_by from public.daily_rates where purity = 'FX-F2'), current_setting('jv.staff')::uuid, 'T-D22: daily_rates.confirmed_by follows the user of the update');
select is((select array[created_by, updated_by] from public.designs where design_no = 'FX-F3'), array[current_setting('jv.staff')::uuid, current_setting('jv.staff')::uuid],
  'T-D22: a design inserted by a function on behalf of a user carries that user');
select is((select array[created_by, updated_by] from public.skus where sku_no = 'FX-F3-001'), array[current_setting('jv.staff')::uuid, current_setting('jv.staff')::uuid],
  'T-D22: so does a piece');
-- an import (nobody signed in)
select pg_temp.fx($q$insert into public.categories (name, prefix, created_by, updated_by) values ('Import cat', 'IMP', current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid)$q$);
select pg_temp.fx($q$insert into public.settings (key, value, updated_by) values ('fx_import', '{}', current_setting('jv.forged')::uuid)$q$);
select pg_temp.fx($q$insert into public.daily_rates (material, purity, rate_per_gram, rate_date, confirmed_by) values ('Gold', 'FX-IMP', 7000, current_date - 400, current_setting('jv.forged')::uuid)$q$);
select is((select array[created_by, updated_by] from public.categories where name = 'Import cat'), array[null, null]::uuid[], 'T-D22: an insert by the database owner (an import) leaves created_by and updated_by null');
select is((select updated_by from public.settings where key = 'fx_import'), null, 'T-D22: and settings.updated_by');
select is((select confirmed_by from public.daily_rates where purity = 'FX-IMP'), null, 'T-D22: and confirmed_by');

-- ---------------------------------------------------------------- 16. T-D22: updated_at moves with the clock on every update, created_at never
select pg_temp.fx($q$select set_config('jv.u0', (select updated_at::text from public.categories where name = 'Import cat'), true)$q$);
select pg_temp.fx($q$select set_config('jv.k0', (select created_at::text from public.categories where name = 'Import cat'), true)$q$);
select pg_temp.fx($q$update public.categories set name = 'Import cat 2' where name = 'Import cat'$q$);
select ok((select updated_at from public.categories where name = 'Import cat 2') > current_setting('jv.u0')::timestamptz, 'T-D22, S6: an update moves updated_at forward within the same transaction (clock_timestamp, not now)');
select pg_temp.fx($q$select set_config('jv.u1', (select updated_at::text from public.categories where name = 'Import cat 2'), true)$q$);
select pg_temp.fx($q$update public.categories set name = name where name = 'Import cat 2'$q$);
select ok((select updated_at from public.categories where name = 'Import cat 2') > current_setting('jv.u1')::timestamptz, 'T-D22, S6: an update that changes nothing moves it too (that is how a touch is made)');
select is((select created_at::text from public.categories where name = 'Import cat 2'), current_setting('jv.k0'), 'S6: created_at never changes');
select pg_temp.fx($q$update public.categories set created_at = '2001-01-01', updated_at = '2001-01-01' where name = 'Import cat 2'$q$);
select ok((select created_at > '2020-01-01' and updated_at > '2020-01-01' from public.categories where name = 'Import cat 2'), 'S6: and a value sent for either is replaced');
select tests.set_clock('2031-01-02 03:04:05+00');
select pg_temp.fx($q$update public.skus set notes = 'clock test' where id = current_setting('jv.p2')::uuid$q$);
select pg_temp.fx($q$update public.designs set name = 'clock test' where id = current_setting('jv.d1')::uuid$q$);
select pg_temp.fx($q$update public.sku_private set original_net_weight = 9.9 where sku_id = current_setting('jv.p1')::uuid$q$);
select is((select updated_at from public.skus where id = current_setting('jv.p2')::uuid), '2031-01-02 03:04:05+00'::timestamptz, 'S5, S6: with the clock fixed, a piece''s updated_at is the fixed time');
select is((select updated_at from public.designs where id = current_setting('jv.d1')::uuid), '2031-01-02 03:04:05+00'::timestamptz, 'S5, S6: a design''s too');
select is((select updated_at from public.sku_private where sku_id = current_setting('jv.p1')::uuid), '2031-01-02 03:04:05+00'::timestamptz, 'S5, S6: and a hidden weight''s');
select pg_temp.fx($q$insert into public.settings (key, value) values ('fx_clock', '{}')$q$);
select pg_temp.fx($q$insert into public.daily_rates (material, purity, rate_per_gram, rate_date) values ('Gold', 'FX-CLK', 1, '2020-02-02')$q$);
select pg_temp.fx($q$insert into public.subcategories (category_id, name) values (current_setting('jv.c2')::uuid, 'Clock sub')$q$);
select ok((select created_at = '2031-01-02 03:04:05+00'::timestamptz and updated_at = '2031-01-02 03:04:05+00'::timestamptz from public.settings where key = 'fx_clock'), 'S5, S6: with the clock fixed a new setting is stamped by it');
select ok((select created_at = '2031-01-02 03:04:05+00'::timestamptz and updated_at = '2031-01-02 03:04:05+00'::timestamptz from public.daily_rates where purity = 'FX-CLK'), 'S5, S6: so is a new rate');
select ok((select created_at = '2031-01-02 03:04:05+00'::timestamptz and updated_at = '2031-01-02 03:04:05+00'::timestamptz from public.subcategories where name = 'Clock sub'), 'S5, S6: and a new subcategory');

-- ---------------------------------------------------------------- 17. T-D05: only the owner writes profiles (the rest of the profile rules are DB02's, 011_profiles.test.sql)
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$update public.profiles set full_name = 'Biller edit' where id = %L$$, current_setting('jv.staff'))), 'ok 0',
  'T-D05, A4: a biller cannot update a profile');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$update public.profiles set full_name = 'Staff edit' where id = %L$$, current_setting('jv.biller'))), 'ok 0',
  'T-D05, A4: nor can staff');
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$update public.profiles set full_name = 'Owner edit' where id = %L$$, current_setting('jv.staff'))), 'ok 1',
  'T-D05, A4: the owner can update another profile');
select is(pg_temp.try(format($$update public.profiles set role = 'biller' where id = %L$$, current_setting('jv.owner'))), 'err P0001',
  'T-D05, A8: but not her own role');
select is(pg_temp.try(format($$insert into public.profiles (id, full_name, role) values (%L, 'Nobody', 'staff')$$, current_setting('jv.none'))), 'err 42501',
  'T-D05, A4: and nobody inserts a profile through the API, the owner included (the new-login trigger does)');
select tests.reset_role();

select * from finish();
rollback;
