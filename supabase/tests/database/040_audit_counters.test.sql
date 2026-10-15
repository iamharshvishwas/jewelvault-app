-- T-D04 and T-D14 (written here), the DB05 parts of T-D03 and T-F02, and the rules they rest on. DB05, migrations 0009 to 0012.
--
-- Spec lines: S2, S8, L1 to L6, D16 to D20, D23, A4, A5. Everything runs in this transaction and is rolled back.
--
-- What is proved here:
--   * D18, L3, L4: private.counters and private.next_number: numbers start at 1, series are independent, a rolled-back call
--     leaves no gap and no repeat, a number that already exists (an imported code) is skipped at most 100 times and then
--     JV_INVALID_INPUT, and the formats of L4 (bill, opening bill, design, piece, barcode; the digits grow after the pad; the
--     year is the Asia/Kolkata year of the moment of saving, T-F07) come from the settings of D3;
--   * D18, L5: private.idempotency and private.idem_begin / idem_finish: the first call proceeds, the same request again gets
--     the stored result, another payload, function or caller is refused (the two-session half is tests/db/numbering.test.ts);
--   * D16, L1, L2, D23 (T-D14): audit_log has a row for each insert and update of the 13 tables, none for an update that
--     changes nothing but updated_at (or updated_by, which another user's update also changes, DB02), an import has no actor
--     and the role import, and no API role can write, change or delete it; the owner alone reads it;
--   * D23 (T-E07, database half): the touch triggers move updated_at of the customer and the bills when a receipt, an
--     allocation or a bill changes, and cancelling an unpaid bill moves the customer's updated_at;
--   * D19: every index the screens poll with, and none twice; D17: check_runs and backup_runs, read by the owner only;
--   * D20: private.seed_defaults(): the settings keys, the categories, the walk-in customer, no sample data, safe to call twice;
--   * T-D04 and the DB05 part of T-D03: the biller, the staff and the anonymous caller at audit_log, sku_private, the settings,
--     the roles and a design's material.
--
-- The helpers in pg_temp catch an error and report it, so a missing table or function makes the assertions fail one by one
-- instead of stopping the file; they are granted to public so that they can be called while a role is impersonated.
begin;
select plan(287);

-- ---------------------------------------------------------------- helpers
-- 'ok <rows>' when the statement ran and its effect stays, 'err <sqlstate>' when it did not.
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

-- The same, and the statement is undone either way (a plpgsql variable keeps its value when the sub-transaction rolls back).
create function pg_temp.tryr(p_sql text) returns text language plpgsql as $f$
declare
  n bigint;
  v_res text;
begin
  begin
    execute p_sql;
    get diagnostics n = row_count;
    v_res := 'ok ' || n;
    raise exception 'undo' using errcode = 'JVRB0';
  exception
    when sqlstate 'JVRB0' then null;
    when others then v_res := 'err ' || sqlstate;
  end;
  return v_res;
end
$f$;

-- The first column of the first row of a query as text; 'err <sqlstate>' when it fails.
create function pg_temp.q(p_sql text) returns text language plpgsql as $f$
declare
  v text;
begin
  execute p_sql into v;
  return v;
exception when others then
  return 'err ' || sqlstate;
end
$f$;

-- The same, and the effect is undone (a function that takes a number is asked, and the number is given back).
create function pg_temp.qr(p_sql text) returns text language plpgsql as $f$
declare
  v text;
  v_res text;
begin
  begin
    execute p_sql into v;
    v_res := v;
    raise exception 'undo' using errcode = 'JVRB0';
  exception
    when sqlstate 'JVRB0' then null;
    when others then v_res := 'err ' || sqlstate;
  end;
  return v_res;
end
$f$;

-- The message of the error a statement raises ('ok' when it raises none), undone either way.
create function pg_temp.msg(p_sql text) returns text language plpgsql as $f$
declare
  v_res text;
begin
  begin
    execute p_sql;
    v_res := 'ok';
    raise exception 'undo' using errcode = 'JVRB0';
  exception
    when sqlstate 'JVRB0' then null;
    when others then v_res := sqlerrm;
  end;
  return v_res;
end
$f$;

-- A fixture statement: a failure is reported as a notice and the file carries on.
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
   where a.attrelid = to_regclass(p_table) and a.attnum > 0 and not a.attisdropped
$f$;

-- Sets one settings row whether or not it exists yet.
create function pg_temp.set_setting(p_key text, p_value jsonb) returns void language sql as $f$
  insert into public.settings (key, value) values (p_key, p_value) on conflict (key) do update set value = excluded.value
$f$;

-- A number from private.next_number, given back: the counter is where it was.
create function pg_temp.peek(p_series text) returns text language sql as $f$
  select pg_temp.qr(format('select private.next_number(%L)', p_series))
$f$;

-- Which user the database believes is signed in, without changing the role (so private functions can still be called).
create function pg_temp.claims_of(p_user uuid) returns void language sql as $f$
  select set_config('request.jwt.claims', jsonb_build_object('sub', p_user, 'role', 'authenticated', 'aud', 'authenticated')::text, true)
$f$;

-- The number of audit rows of a row and an action; -1 when audit_log cannot be read (plpgsql, so the file loads without the table).
create function pg_temp.audit_n(p_table text, p_row_id text, p_action text) returns integer language plpgsql as $f$
declare
  n integer;
begin
  select count(*)::integer into n from public.audit_log where table_name = p_table and row_id = p_row_id and action = p_action;
  return n;
exception when others then
  return -1;
end
$f$;

-- True when the table has a (not partial, btree) index whose first columns are these, in this order.
create function pg_temp.indexed(p_table text, p_cols text[]) returns boolean language sql as $f$
  select exists (
    select 1
      from pg_index i
      join pg_class ic on ic.oid = i.indexrelid
      join pg_am am on am.oid = ic.relam
     where i.indrelid = to_regclass(p_table) and i.indisvalid and i.indpred is null and am.amname = 'btree'
       and (select array_agg(a.attname::text order by k.ord)
              from unnest(i.indkey::smallint[]) with ordinality k(attnum, ord)
              join pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
             where k.ord <= cardinality(p_cols)) = p_cols
  )
$f$;

grant execute on function pg_temp.try(text), pg_temp.tryr(text), pg_temp.q(text), pg_temp.qr(text), pg_temp.msg(text),
  pg_temp.fx(text), pg_temp.set_setting(text, jsonb), pg_temp.peek(text), pg_temp.claims_of(uuid),
  pg_temp.audit_n(text, text, text), pg_temp.indexed(text, text[]) to public;

-- Every setting a later statement reads starts as a value that matches nothing, so that a fixture that failed to build makes
-- one assertion fail and does not stop the file with 'unrecognized configuration parameter'.
do $init$
begin
  perform set_config('jv.' || k, '00000000-0000-0000-0000-000000000000', true)
    from unnest(array['owner', 'biller', 'staff', 'inactive', 'none', 'cat', 'sub', 'des', 'des2', 'sku', 'cus', 'cus2', 'rate',
      'bill', 'bill2', 'line', 'rcpt', 'alloc']) k;
end
$init$;

-- ---------------------------------------------------------------- 0. what the migrations left (D20), before this file changes anything
select is(pg_temp.q($$select count(*)::text from public.settings where key in
  ('business', 'estimate', 'taxes', 'tag_template', 'numbering', 'materials', 'locations', 'custom_fields', 'data_epoch')$$), '9',
  'D20: the migrations seeded the nine settings keys ...');
select is(pg_temp.q($$select count(*)::text from public.categories where name in ('Ring', 'Necklace Set', 'Other')$$), '3', 'D20: ... the categories ...');
select is(pg_temp.q($$select count(*)::text from public.customers where id = '00000000-0000-4000-8000-000000000001' and is_walkin$$), '1',
  'D20: ... and the walk-in customer, with its fixed id');

-- ---------------------------------------------------------------- 1. the two private tables (D18)
select has_table('private', 'counters', 'D18: private.counters exists');
select has_table('private', 'idempotency', 'D18: private.idempotency exists');
select is(pg_temp.cols('private.counters'),
  'series text not null, last_value bigint not null, seed_value bigint not null',
  'D18: the columns of counters (series, last_value, seed_value)');
select is(pg_temp.cols('private.idempotency'),
  'request_id uuid not null, fn text not null, actor uuid, args_hash text not null, result jsonb, created_at timestamp with time zone not null',
  'D18: the columns of idempotency (request id, function, actor, hash of the arguments, the stored result, when)');
select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace = 'private'::regnamespace and c.relname in ('counters', 'idempotency') and c.relrowsecurity),
  array['counters', 'idempotency'], 'A1, S9: row-level security is on for both private tables');
select is(
  (select array_agg(t.tbl || ' ' || p order by t.tbl, p)
     from (values ('private.counters'), ('private.idempotency')) t(tbl)
    cross join unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
    cross join unnest(array['anon', 'authenticated']) r
    where to_regclass(t.tbl) is not null and has_table_privilege(r, t.tbl, p)),
  null, 'A3, D18: neither private table is reachable by anon or authenticated');
select is(pg_temp.q($$select count(*)::text from pg_index where indrelid = 'private.idempotency'::regclass
    and indexrelid = 'private.idempotency_created_at_idx'::regclass$$), '1',
  'L6: idempotency has an index on created_at, for the nightly delete of rows older than 90 days');

-- ---------------------------------------------------------------- 2. the numbers (L3): private.next_number
select is(pg_temp.qr($$select pg_typeof(private.next_number('design:TYP'))::text$$), 'bigint', 'L3: next_number returns a bigint');
select is(pg_temp.q($$select private.next_number('opening')$$), '1', 'L3: the first number of a series is 1');
select is(pg_temp.q($$select private.next_number('opening')$$), '2', 'L3: the second is 2');
select is(pg_temp.q($$select private.next_number('design:AAA')$$), '1', 'L3: another series starts at 1 on its own');
select is(pg_temp.q($$select private.next_number('opening')$$), '3', 'L3: and the first series carries on');
select is(pg_temp.q($$select last_value || '/' || seed_value from private.counters where series = 'opening'$$), '3/0',
  'D18: the counter holds the last number, and seed_value is 0 for a series nobody seeded');
-- rolled back: no gap and no repeat
select is(pg_temp.qr($$select private.next_number('design:BBB')$$), '1', 'L3: a number asked for inside a sub-transaction is 1 ...');
select is(pg_temp.q($$select count(*)::text from private.counters where series = 'design:BBB'$$), '0',
  'L3: ... and when that is rolled back the counter row is gone, so nothing is used');
select is(pg_temp.q($$select private.next_number('design:BBB')$$), '1', 'L3, T-C01: the next caller gets 1 again, with no gap and no repeat');
select is(pg_temp.qr($$select private.next_number('design:BBB')$$), '2', 'L3: an existing series: the number asked for is 2 ...');
select is(pg_temp.q($$select private.next_number('design:BBB')$$), '2', 'L3, T-C01: ... and after the rollback the next caller gets 2');
select is(pg_temp.q($$select last_value::text from private.counters where series = 'design:BBB'$$), '2',
  'L3, T-C06: and the counter holds 2, the number of the call that was kept');
select throws_like($$select private.next_number(null)$$, 'JV_INVALID_INPUT:%', 'L3: no series is refused ...');
select throws_like($$select private.next_number('widgets')$$, 'JV_INVALID_INPUT:%', 'L3: ... and so is a series that is none of the four of L3');
select throws_like($$select private.next_number('bill:JV:26')$$, 'JV_INVALID_INPUT:%', 'L3: a bill series needs a prefix and a four digit year');
select throws_like($$select private.next_number('design:')$$, 'JV_INVALID_INPUT:%', 'L3: a design series needs a category prefix');
select throws_like($$select private.next_number('sku:')$$, 'JV_INVALID_INPUT:%', 'L3: a piece series needs a design number');

-- skipping a number that exists (an imported code, IM3)
do $mk$
begin
  perform set_config('jv.cat', tests.make_category('{"name":"DB05 fixture category","prefix":"DBF"}')::text, true);
  perform set_config('jv.cus', tests.make_customer('{"name":"DB05 customer one"}')::text, true);
  perform set_config('jv.cus2', tests.make_customer('{"name":"DB05 customer two"}')::text, true);
end
$mk$;
select pg_temp.fx($q$select tests.make_design(jsonb_build_object('design_no', 'SKP-00002', 'category_id', current_setting('jv.cat')))$q$);
select pg_temp.fx($q$select tests.make_design(jsonb_build_object('design_no', 'skp-00004', 'category_id', current_setting('jv.cat')))$q$);
select is(pg_temp.q($$select private.next_number('design:SKP')$$), '1', 'L3, IM3: the first design number of the series is free');
select is(pg_temp.q($$select private.next_number('design:SKP')$$), '3', 'L3, IM3: the second skips SKP-00002, which exists');
select is(pg_temp.q($$select private.next_number('design:SKP')$$), '5', 'L3, IM3: and the next skips skp-00004, which exists in another case');
select is(pg_temp.q($$select last_value::text from private.counters where series = 'design:SKP'$$), '5', 'L3: the counter holds the number used');

select pg_temp.fx($q$select tests.make_design(jsonb_build_object('design_no', 'DSG-X', 'category_id', current_setting('jv.cat')))$q$);
select pg_temp.fx($q$select set_config('jv.des', (select id::text from public.designs where design_no = 'DSG-X'), true)$q$);
select pg_temp.fx($q$select tests.make_piece(current_setting('jv.des')::uuid, '{"sku_no":"DSG-X-002","barcode":"BC-OTHER-1"}')$q$);
select pg_temp.fx($q$select tests.make_piece(current_setting('jv.des')::uuid, '{"sku_no":"OTHER-SKU-1","barcode":"bc-dsg-x-004"}')$q$);
select is(pg_temp.q($$select private.next_number('sku:DSG-X')$$), '1', 'L3: the first piece number of a design');
select is(pg_temp.q($$select private.next_number('sku:DSG-X')$$), '3', 'L3: the second skips DSG-X-002, an existing piece number');
select is(pg_temp.q($$select private.next_number('sku:DSG-X')$$), '5',
  'L3: and the next skips 4, whose barcode BC-DSG-X-004 is taken by another piece (barcodes are unique too)');

select pg_temp.fx($q$select tests.insert_row('public.bills', jsonb_build_object('bill_no', 'JV-2026-0002', 'customer_id', current_setting('jv.cus'),
  'bill_date', '2026-01-05', 'doc_type', 'estimate', 'sale_type', 'Retail'))$q$);
select pg_temp.fx($q$select tests.insert_row('public.bills', jsonb_build_object('bill_no', 'OB-0002', 'customer_id', current_setting('jv.cus'),
  'bill_date', '2026-01-05', 'doc_type', 'opening_balance', 'sale_type', 'Retail'))$q$);
select is(pg_temp.q($$select private.next_number('bill:JV:2026')$$), '1', 'L3: the first bill number of JV 2026');
select is(pg_temp.q($$select private.next_number('bill:JV:2026')$$), '3', 'L3: the second skips JV-2026-0002, which exists');
select is(pg_temp.q($$select private.next_number('bill:JV:2027')$$), '1', 'L3: the next year has its own series');
select is(pg_temp.q($$select private.next_number('opening')$$), '4', 'L3: the opening series carries on after 3 (OB-0004 is free) ...');
select is(pg_temp.q($$select private.next_number('opening')$$), '5', 'L3: ... and OB-0005 follows');
select pg_temp.fx($q$delete from private.counters where series = 'opening'$q$);
select is(pg_temp.q($$select private.next_number('opening')$$), '1', 'L3: with a fresh opening series: OB-0001 is free');
select is(pg_temp.q($$select private.next_number('opening')$$), '3', 'L3: and OB-0002, which exists, is skipped');

-- at most 100 tries
select pg_temp.fx($q$insert into public.designs (design_no, category_id, material, purity, selling_method)
  select 'LIM-' || lpad(g::text, 5, '0'), current_setting('jv.cat')::uuid, 'Gold', '22K', 'By Weight' from generate_series(1, 99) g$q$);
select is(pg_temp.q($$select private.next_number('design:LIM')$$), '100', 'L3: 99 numbers taken: the 100th try finds a free one');
select pg_temp.fx($q$delete from private.counters where series = 'design:LIM'$q$);
select pg_temp.fx($q$insert into public.designs (design_no, category_id, material, purity, selling_method)
  values ('LIM-00100', current_setting('jv.cat')::uuid, 'Gold', '22K', 'By Weight')$q$);
select throws_like($$select private.next_number('design:LIM')$$, 'JV_INVALID_INPUT:%', 'L3, T-C16: 100 numbers taken: JV_INVALID_INPUT after the 100th try');
select is(pg_temp.q($$select count(*)::text from private.counters where series = 'design:LIM'$$), '0',
  'L3: and the failed call used no number (the counter row is not there)');

-- next_code: the number and its format in one call
select is(pg_temp.qr($$select private.next_code('design:NXC')$$), 'NXC-00001', 'L4: next_code gives the formatted design number');
select is(pg_temp.qr($$select private.next_code('bill:JV:2026')$$), 'JV-2026-0004', 'L4: ... the formatted bill number (JV-2026-0001 to 3 are used or taken)');
select is(pg_temp.qr($$select private.next_code('sku:RING-00001')$$), 'RING-00001-001', 'L4: ... the formatted piece number');

-- ---------------------------------------------------------------- 3. the formats (L4, T-F07)
-- from the defaults: remove the settings rows, so the helpers show what they fall back to
select pg_temp.fx($q$delete from public.settings where key in ('numbering', 'estimate')$q$);
select is(pg_temp.q($$select private.pad_number(7, 4)$$), '0007', 'L4: pad_number pads with zeros');
select is(pg_temp.q($$select private.pad_number(12345, 4)$$), '12345', 'L4: and never cuts a longer number (the digits grow)');
select is(pg_temp.q($$select private.format_bill_no('JV', 2026, 1)$$), 'JV-2026-0001', 'L4, T-F07: a bill is prefix-year-4 digits');
select is(pg_temp.q($$select private.format_bill_no('JV', 2026, 9999)$$), 'JV-2026-9999', 'L4: 9,999 still has 4 digits');
select is(pg_temp.q($$select private.format_bill_no('JV', 2026, 10000)$$), 'JV-2026-10000', 'L4: after 9,999 the digits simply grow');
select is(pg_temp.q($$select private.format_opening_no(1)$$), 'OB-0001', 'L4: an opening-balance bill is OB-4 digits');
select is(pg_temp.q($$select private.format_opening_no(10000)$$), 'OB-10000', 'L4: ... and grows too');
select is(pg_temp.q($$select private.format_design_no('RING', 1)$$), 'RING-00001', 'L4: a design is category prefix-5 digits (the default designPadding)');
select is(pg_temp.q($$select private.format_design_no('RING', 123456)$$), 'RING-123456', 'L4: ... and grows');
select is(pg_temp.q($$select private.format_sku_no('RING-00001', 7)$$), 'RING-00001-007', 'L4: a piece is design number-3 digits (the default skuPadding)');
select is(pg_temp.q($$select private.format_barcode('RING-00001-007')$$), 'BC-RING-00001-007', 'L4: a barcode is BC-piece number (the default barcodePrefix)');
select is(pg_temp.q($$select private.bill_prefix()$$), 'JV', 'L4: the bill prefix is JV without a settings row');
-- from the settings of D3
select pg_temp.fx($q$select pg_temp.set_setting('numbering', '{"designPadding":7,"skuPadding":4,"barcodePrefix":"XY"}')$q$);
select pg_temp.fx($q$select pg_temp.set_setting('estimate', '{"prefix":"ZZ","roundOff":true}')$q$);
select is(pg_temp.q($$select private.format_design_no('RING', 1)$$), 'RING-0000001', 'L4, D3: settings.numbering.designPadding sets the digits of a design');
select is(pg_temp.q($$select private.format_sku_no('RING-0000001', 7)$$), 'RING-0000001-0007', 'L4, D3: skuPadding sets the digits of a piece');
select is(pg_temp.q($$select private.format_barcode('A-1')$$), 'XY-A-1', 'L4, D3: barcodePrefix sets the barcode prefix');
select is(pg_temp.q($$select private.bill_prefix()$$), 'ZZ', 'L4, D3: settings.estimate.prefix sets the bill prefix');
select pg_temp.fx($q$select pg_temp.set_setting('numbering', '{"designPadding":"many","skuPadding":0,"barcodePrefix":""}')$q$);
select pg_temp.fx($q$select pg_temp.set_setting('estimate', '{"prefix":"  "}')$q$);
select is(pg_temp.q($$select private.format_design_no('RING', 1)$$), 'RING-00001', 'L4: a padding that is not a number falls back to 5');
select is(pg_temp.q($$select private.format_sku_no('RING-00001', 7)$$), 'RING-00001-007', 'L4: a padding of 0 falls back to 3');
select is(pg_temp.q($$select private.format_barcode('A-1')$$), 'BC-A-1', 'L4: a blank barcode prefix falls back to BC');
select is(pg_temp.q($$select private.bill_prefix()$$), 'JV', 'L4: a blank bill prefix falls back to JV');
select pg_temp.fx($q$delete from public.settings where key in ('numbering', 'estimate')$q$);
-- the series names and the Asia/Kolkata year (T-F07): 23:59:59 on 31 December is 18:29:59 UTC
select pg_temp.fx($q$delete from private.counters where series like 'bill:%'$q$);
select pg_temp.fx($q$select tests.set_clock('2026-12-31 18:29:59+00')$q$);
select is(pg_temp.q($$select private.bill_series()$$), 'bill:JV:2026', 'L4, T-F07: a bill saved at 23:59:59 on 31 December (Asia/Kolkata) is in the old year');
select is(pg_temp.q($$select private.next_code(private.bill_series())$$), 'JV-2026-0001', 'L4, T-F07: and takes JV-2026-0001');
select pg_temp.fx($q$select tests.set_clock('2026-12-31 18:30:01+00')$q$);
select is(pg_temp.q($$select private.bill_series()$$), 'bill:JV:2027', 'L4, T-F07: a bill saved at 00:00:01 on 1 January (Asia/Kolkata) is in the new year');
select is(pg_temp.q($$select private.next_code(private.bill_series())$$), 'JV-2027-0001', 'L4, T-F07: and the new year starts again at 0001');
-- the real clock again (migration 0003), for every stamp from here on
select pg_temp.fx($q$create or replace function private.now_ts() returns timestamptz language sql volatile set search_path = '' as 'select clock_timestamp()'$q$);
select is(pg_temp.q($$select (private.now_ts() between clock_timestamp() - interval '1 minute' and clock_timestamp() + interval '1 minute')::text$$), 'true', 'the clock is the real one again');

-- ---------------------------------------------------------------- 4. repeat-safety (L5): private.idem_begin
select is(pg_temp.q($$select (private.idem_hash('{"b":2,"a":[1,2]}'::jsonb) = private.idem_hash('{"a":[1,2],"b":2}'::jsonb))::text$$), 'true',
  'L5: the hash of the arguments does not depend on the order of the keys');
select is(pg_temp.q($$select (private.idem_hash('{"a":[1,2]}'::jsonb) <> private.idem_hash('{"a":[2,1]}'::jsonb))::text$$), 'true',
  'L5: and changes with the arguments (another cart, another hash)');
select matches(pg_temp.q($$select private.idem_hash('{}'::jsonb)$$), '^[0-9a-f]{64}$', 'L5: the hash is 64 hex digits (SHA-256)');
select is(pg_temp.q($$select private.idem_begin('11111111-1111-4111-8111-111111111111', 'create_bill', 'h1') is null$$), 'true',
  'L5: the first call with a request id proceeds (it returns null)');
select is(pg_temp.q($$select fn || '/' || args_hash || '/' || coalesce(actor::text, 'nobody') || '/' || (result is null)::text
  from private.idempotency where request_id = '11111111-1111-4111-8111-111111111111'$$), 'create_bill/h1/nobody/true',
  'L5: and left its row: the function, the hash, the caller (nobody here: the database owner) and no result yet');
select is(pg_temp.q($$select private.idem_finish('11111111-1111-4111-8111-111111111111', '{"bill":"JV-2026-0001"}'::jsonb)::text$$), '{"bill": "JV-2026-0001"}',
  'L5: idem_finish stores the result and hands it back');
select is(pg_temp.q($$select result::text from private.idempotency where request_id = '11111111-1111-4111-8111-111111111111'$$), '{"bill": "JV-2026-0001"}',
  'L5: the result is in the row, in the same transaction');
select is(pg_temp.q($$select private.idem_begin('11111111-1111-4111-8111-111111111111', 'create_bill', 'h1')::text$$), '{"bill": "JV-2026-0001"}',
  'L5, T-C05: the same request again gets the stored result');
select throws_like($$select private.idem_begin('11111111-1111-4111-8111-111111111111', 'create_bill', 'other')$$, 'JV_INVALID_INPUT:%',
  'L5, T-C05: the same id with another payload (another cart) is refused');
select throws_like($$select private.idem_begin('11111111-1111-4111-8111-111111111111', 'record_payment', 'h1')$$, 'JV_INVALID_INPUT:%',
  'L5, T-C05: the same id for another function is refused');
select is(pg_temp.q($$select count(*)::text from private.idempotency where request_id = '11111111-1111-4111-8111-111111111111'$$), '1',
  'L5: and no second row was made');
select is(pg_temp.q($$select private.idem_begin('22222222-2222-4222-8222-222222222222', 'create_bill', 'h1') is null$$), 'true',
  'L5: a request that has no result yet (the same transaction asks twice) ...');
select throws_like($$select private.idem_begin('22222222-2222-4222-8222-222222222222', 'create_bill', 'h1')$$, 'JV_INVALID_INPUT:%',
  'L5: ... is refused, not answered with nothing');
select throws_like($$select private.idem_begin(null, 'create_bill', 'h1')$$, 'JV_INVALID_INPUT:%', 'L5: a call with no request id is refused');
select throws_like($$select private.idem_begin('33333333-3333-4333-8333-333333333333', null, 'h1')$$, 'JV_INVALID_INPUT:%', 'L5: ... and with no function name');
select throws_like($$select private.idem_begin('33333333-3333-4333-8333-333333333333', 'create_bill', null)$$, 'JV_INVALID_INPUT:%', 'L5: ... and with no hash');
select throws_ok($$select private.idem_finish('44444444-4444-4444-8444-444444444444', '{}'::jsonb)$$, 'P0001', null,
  'L5: finishing a request that was never begun is an error, not a silent no-op');
-- another caller
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.none', tests.make_user('none')::text, true);
end
$mk$;
select pg_temp.claims_of(current_setting('jv.owner')::uuid);
select is(pg_temp.q($$select private.idem_begin('55555555-5555-4555-8555-555555555555', 'create_bill', 'h1') is null$$), 'true', 'L5: the owner begins a request');
select is(pg_temp.q($$select actor::text from private.idempotency where request_id = '55555555-5555-4555-8555-555555555555'$$), current_setting('jv.owner'),
  'L5: and the row names the owner as the caller (auth.uid())');
select pg_temp.fx($q$select private.idem_finish('55555555-5555-4555-8555-555555555555', '{"ok":true}'::jsonb)$q$);
select pg_temp.claims_of(current_setting('jv.biller')::uuid);
select throws_like($$select private.idem_begin('55555555-5555-4555-8555-555555555555', 'create_bill', 'h1')$$, 'JV_INVALID_INPUT:%',
  'L5, T-C05: another caller with the same request id, function and payload is refused');
select pg_temp.claims_of(current_setting('jv.owner')::uuid);
select is(pg_temp.q($$select private.idem_begin('55555555-5555-4555-8555-555555555555', 'create_bill', 'h1')::text$$), '{"ok": true}',
  'L5: and the owner herself still gets the stored result');
select tests.reset_role();
select is(pg_temp.q($$select created_at is not null and created_at <= clock_timestamp() from private.idempotency where request_id = '55555555-5555-4555-8555-555555555555'$$),
  'true', 'L6: a request row carries when it was made, for the nightly delete of rows older than 90 days');

-- ---------------------------------------------------------------- 5. audit_log, check_runs and backup_runs: the tables (D16, D17, L2)
select has_table('public', 'audit_log', 'D16: public.audit_log exists');
select has_table('public', 'check_runs', 'D17: public.check_runs exists');
select has_table('public', 'backup_runs', 'D17: public.backup_runs exists');
select is(pg_temp.cols('public.audit_log'),
  'id bigint not null, at timestamp with time zone not null, actor uuid, actor_role text, table_name text not null, row_id text not null, action text not null, old_row jsonb, new_row jsonb',
  'D16: the columns of audit_log');
select is(pg_temp.cols('public.check_runs'),
  'id bigint not null, ran_at timestamp with time zone not null, ok boolean not null, details jsonb',
  'D17: the columns of check_runs');
select is(pg_temp.cols('public.backup_runs'),
  'id bigint not null, ran_at timestamp with time zone not null, kind text not null, ok boolean not null, bytes bigint, detail jsonb',
  'D17: the columns of backup_runs');
select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace = 'public'::regnamespace and c.relname in ('audit_log', 'check_runs', 'backup_runs') and c.relrowsecurity),
  array['audit_log', 'backup_runs', 'check_runs'], 'A1, S9: row-level security is on for the three tables');
select is(pg_temp.q($$select string_agg(t || ' ' || p, ', ' order by t, p)
    from unnest(array['audit_log', 'check_runs', 'backup_runs']) t
    cross join unnest(array['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE']) p
    cross join unnest(array['anon', 'authenticated']) r
   where has_table_privilege(r, 'public.' || t, p)$$), null, 'L2, A4: no API role holds INSERT, UPDATE, DELETE or TRUNCATE on the three tables');
select is(pg_temp.q($$select string_agg(t || ' ' || r, ', ' order by t, r)
    from unnest(array['audit_log', 'check_runs', 'backup_runs']) t
    cross join unnest(array['anon']) r
   where has_table_privilege(r, 'public.' || t, 'SELECT')$$), null, 'A4: anon reads none of them');
select is(pg_temp.q($$select string_agg(a.attname, ',') from pg_attribute a
   where a.attrelid = 'public.audit_log'::regclass and a.attnum > 0 and not a.attisdropped
     and (has_column_privilege('authenticated', a.attrelid, a.attnum, 'INSERT') or has_column_privilege('authenticated', a.attrelid, a.attnum, 'UPDATE'))$$),
  null, 'L2: nor can they write a single column of audit_log');
select is(pg_temp.q($$select count(*)::text from pg_policy where polrelid = 'public.audit_log'::regclass and polcmd <> 'r'$$), '0',
  'L2: audit_log has no policy for insert, update or delete, so row-level security refuses even a granted write');
select is(pg_temp.q($$select count(*)::text from pg_policy where polrelid in ('public.audit_log'::regclass, 'public.check_runs'::regclass, 'public.backup_runs'::regclass)$$), '3',
  'A4, lint 0006: one policy each, for select');
select throws_ok($$insert into public.audit_log (table_name, row_id, action) values ('settings', 'x', 'delete')$$, '23514', null,
  'D16: an action is insert or update');
select throws_ok($$insert into public.backup_runs (kind, ok) values ('weekly', true)$$, '23514', null,
  'D17: a backup run is a db_dump, a photo_copy or a restore_drill');
select is(pg_temp.try($$insert into public.backup_runs (kind, ok, bytes, detail) values ('db_dump', true, 1048576, '{"bucket":"r2"}')$$), 'ok 1', 'D17: the backup job (the database owner''s connection) writes a db_dump row');
select is(pg_temp.try($$insert into public.backup_runs (kind, ok) values ('photo_copy', false)$$), 'ok 1', 'D17: ... a failed photo_copy row');
select is(pg_temp.try($$insert into public.backup_runs (kind, ok) values ('restore_drill', true)$$), 'ok 1', 'D17: ... a restore_drill row');
select is(pg_temp.try($$insert into public.check_runs (ok, details) values (true, '{"I1":0}')$$), 'ok 1', 'D17: the nightly check writes a check_runs row');
select is(pg_temp.q($$select (ran_at > clock_timestamp() - interval '1 minute')::text from public.check_runs order by id desc limit 1$$), 'true', 'D17: and ran_at defaults to now');

-- ---------------------------------------------------------------- 6. the audit trigger (L1, D16, T-D14): the 13 tables
-- one fixture row per table, made by the database owner, which is what an import is
select pg_temp.fx($q$select set_config('jv.sub', (tests.insert_row('public.subcategories',
  jsonb_build_object('category_id', current_setting('jv.cat'), 'name', 'DB05 sub')) ->> 'id'), true)$q$);
select pg_temp.fx($q$select set_config('jv.des2', tests.make_design(jsonb_build_object('design_no', 'AUD-D1', 'category_id', current_setting('jv.cat')))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.sku', tests.make_piece(current_setting('jv.des2')::uuid, '{"sku_no":"AUD-D1-001","barcode":"BC-AUD-D1-001"}')::text, true)$q$);
select pg_temp.fx($q$insert into public.sku_private (sku_id, original_net_weight) values (current_setting('jv.sku')::uuid, 9.800)$q$);
select pg_temp.fx($q$select set_config('jv.rate', tests.make_rate('{"purity":"AUD"}')::text, true)$q$);
select pg_temp.fx($q$select tests.insert_row('public.settings', '{"key":"aud_key","value":{"a":1}}')$q$);
select pg_temp.fx($q$select set_config('jv.bill', (tests.insert_row('public.bills', jsonb_build_object('bill_no', 'AUD-B1', 'customer_id', current_setting('jv.cus2'),
  'bill_date', '2026-01-06', 'doc_type', 'estimate', 'sale_type', 'Retail', 'subtotal', 1000, 'grand_total', 1000)) ->> 'id'), true)$q$);
select pg_temp.fx($q$select set_config('jv.bill2', (tests.insert_row('public.bills', jsonb_build_object('bill_no', 'AUD-B2', 'customer_id', current_setting('jv.cus2'),
  'bill_date', '2026-01-06', 'doc_type', 'estimate', 'sale_type', 'Retail', 'subtotal', 500, 'grand_total', 500)) ->> 'id'), true)$q$);
select pg_temp.fx($q$select set_config('jv.line', (tests.insert_row('public.bill_items', jsonb_build_object('bill_id', current_setting('jv.bill'), 'line_no', 1,
  'sku_id', current_setting('jv.sku'), 'design_no', 'AUD-D1', 'sku_no', 'AUD-D1-001', 'category', 'DB05 fixture category', 'material', 'Gold',
  'purity', '22K', 'selling_method', 'By Weight', 'gross_weight', 10, 'customer_net_weight', 9.5, 'quantity', 1, 'metal_rate', 7000,
  'labour_rate', 350, 'labour_amount', 3325, 'metal_amount', 66500, 'item_total', 69825)) ->> 'id'), true)$q$);
select pg_temp.fx($q$select set_config('jv.rcpt', (tests.insert_row('public.receipts', jsonb_build_object('customer_id', current_setting('jv.cus2'),
  'kind', 'money', 'mode', 'Cash', 'amount', 400, 'paid_on', '2026-01-06')) ->> 'id'), true)$q$);
select pg_temp.fx($q$select set_config('jv.alloc', (tests.insert_row('public.receipt_allocations', jsonb_build_object('receipt_id', current_setting('jv.rcpt'),
  'bill_id', current_setting('jv.bill'), 'customer_id', current_setting('jv.cus2'), 'amount', 400)) ->> 'id'), true)$q$);

create temp table jv_aud (t text primary key, row_id text, upd text);
insert into jv_aud (t, row_id, upd) values
  ('profiles', current_setting('jv.owner'), format('update public.profiles set full_name = %L where id = %L', 'Renamed owner', current_setting('jv.owner'))),
  ('settings', 'aud_key', $$update public.settings set value = '{"a":2}' where key = 'aud_key'$$),
  ('daily_rates', current_setting('jv.rate'), format('update public.daily_rates set rate_per_gram = 7100 where id = %L', current_setting('jv.rate'))),
  ('categories', current_setting('jv.cat'), format('update public.categories set name = %L where id = %L', 'DB05 renamed category', current_setting('jv.cat'))),
  ('subcategories', current_setting('jv.sub'), format('update public.subcategories set name = %L where id = %L', 'DB05 renamed sub', current_setting('jv.sub'))),
  ('designs', current_setting('jv.des2'), format('update public.designs set name = %L where id = %L', 'Renamed design', current_setting('jv.des2'))),
  ('skus', current_setting('jv.sku'), format('update public.skus set notes = %L where id = %L', 'a note', current_setting('jv.sku'))),
  ('sku_private', current_setting('jv.sku'), format('update public.sku_private set original_net_weight = 8.5 where sku_id = %L', current_setting('jv.sku'))),
  ('customers', current_setting('jv.cus'), format('update public.customers set notes = %L where id = %L', 'a note', current_setting('jv.cus'))),
  ('bills', current_setting('jv.bill'), format('update public.bills set notes = %L where id = %L', 'a note', current_setting('jv.bill'))),
  ('bill_items', current_setting('jv.line'), format('update public.bill_items set quantity = 2 where id = %L', current_setting('jv.line'))),
  ('receipts', current_setting('jv.rcpt'), format('update public.receipts set notes = %L where id = %L', 'a note', current_setting('jv.rcpt'))),
  ('receipt_allocations', current_setting('jv.alloc'), format('update public.receipt_allocations set released_at = now() where id = %L', current_setting('jv.alloc')));
grant all on jv_aud to public;

select is(
  (select array_agg(c.relname::text order by c.relname)
     from pg_trigger t join pg_class c on c.oid = t.tgrelid
    where not t.tgisinternal and t.tgfoid = to_regproc('private.write_audit') and c.relnamespace = 'public'::regnamespace),
  (select array_agg(t order by t) from jv_aud),
  'L1: the audit trigger is on exactly the 13 tables of L1');
select is(
  (select count(*)::int from pg_trigger t where not t.tgisinternal and t.tgfoid = to_regproc('private.write_audit')
      and t.tgtype & 1 = 1 and t.tgtype & 2 = 0 and t.tgtype & 4 = 4 and t.tgtype & 16 = 16),
  13, 'L1: each is a row trigger AFTER INSERT OR UPDATE');
select is((select count(*)::int from pg_proc p where p.oid = to_regproc('private.write_audit') and p.prosecdef
    and 'search_path=""' = any (p.proconfig)), 1, 'L1: the audit function is security definer with search_path = ''''');

select is(pg_temp.audit_n('profiles', current_setting('jv.owner'), 'insert'), 1, 'L1, T-D14: profiles: the profile the new-user trigger made has an audit row for the insert');
select is(pg_temp.audit_n(t, row_id, 'insert'), 1, 'L1, T-D14: ' || t || ': one audit row for the insert') from jv_aud where t <> 'profiles' order by t;
do $upd$
declare
  r record;
begin
  for r in select upd from jv_aud order by t loop
    begin
      execute r.upd;
    exception when others then
      raise notice 'update failed: % in %', sqlerrm, r.upd;
    end;
  end loop;
end
$upd$;
select is(pg_temp.audit_n(t, row_id, 'update'), 1, 'L1, T-D14: ' || t || ': one audit row for the update') from jv_aud where t <> 'profiles' order by t;
select is(pg_temp.q(format($$select count(*)::text from public.audit_log where table_name = 'profiles' and row_id = %L and action = 'update'
   and new_row ->> 'full_name' = 'Renamed owner' and old_row ->> 'full_name' is distinct from 'Renamed owner'$$, current_setting('jv.owner'))), '1',
  'L1, T-D14: profiles: and one for the update, with the old name and the new');

select is(pg_temp.q(format($$select (old_row ->> 'name') || ' > ' || (new_row ->> 'name') from public.audit_log
   where table_name = 'categories' and row_id = %L and action = 'update'$$, current_setting('jv.cat'))),
  'DB05 fixture category > DB05 renamed category', 'L1, D16: an update row holds the old and the new row as JSON');
select is(pg_temp.q(format($$select (old_row is null)::text || ' ' || (new_row ->> 'name') from public.audit_log
   where table_name = 'categories' and row_id = %L and action = 'insert'$$, current_setting('jv.cat'))),
  'true DB05 fixture category', 'L1, D16: an insert row has no old row and the new row');
select is(pg_temp.q(format($$select (old_row ->> 'original_net_weight') || ' > ' || (new_row ->> 'original_net_weight') from public.audit_log
   where table_name = 'sku_private' and row_id = %L and action = 'update'$$, current_setting('jv.sku'))),
  '9.800 > 8.500', 'L1: sku_private is audited by its key sku_id (and its weights are in the owner-only log)');
select is(pg_temp.q($$select count(*)::text from public.audit_log where table_name = 'settings' and row_id = 'aud_key'$$), '2', 'L1: settings is audited by its key');
select is(pg_temp.q(format($$select (at <= clock_timestamp())::text || ' ' || (at > clock_timestamp() - interval '1 minute')::text from public.audit_log
   where table_name = 'bills' and row_id = %L and action = 'insert'$$, current_setting('jv.bill'))), 'true true', 'D16: at is when the row was written');
-- an import: no actor, the role import
select is(pg_temp.q(format($$select coalesce(actor::text, 'nobody') || ' ' || actor_role from public.audit_log
   where table_name = 'customers' and row_id = %L and action = 'update' and new_row ->> 'notes' = 'a note'$$, current_setting('jv.cus'))),
  'nobody import', 'L1, T-D14, IM2: a change by the database owner (an import) has no actor and the role import');
select is(pg_temp.q(format($$select coalesce(actor::text, 'nobody') || ' ' || actor_role from public.audit_log
   where table_name = 'receipts' and row_id = %L and action = 'insert'$$, current_setting('jv.rcpt'))),
  'nobody import', 'IM2: an imported insert is recorded the same way');

-- who did it: a signed-in user is the actor, with the role from the profile
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$update public.customers set name = 'By the owner' where id = %L$$, current_setting('jv.cus'))), 'ok 1', 'the owner edits a customer');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$update public.customers set name = 'By the biller' where id = %L$$, current_setting('jv.cus'))), 'ok 1', 'the biller edits it too');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$update public.designs set name = 'By staff' where id = %L$$, current_setting('jv.des2'))), 'ok 1', 'staff edits a design');
select tests.reset_role();
select is(pg_temp.q(format($$select actor::text || ' ' || actor_role from public.audit_log where table_name = 'customers' and row_id = %L
   and new_row ->> 'name' = 'By the owner'$$, current_setting('jv.cus'))), current_setting('jv.owner') || ' owner',
  'L1, T-D14: the actor is auth.uid() and the role is the owner''s');
select is(pg_temp.q(format($$select actor::text || ' ' || actor_role from public.audit_log where table_name = 'customers' and row_id = %L
   and new_row ->> 'name' = 'By the biller'$$, current_setting('jv.cus'))), current_setting('jv.biller') || ' biller', 'L1: a biller''s change names the biller');
select is(pg_temp.q(format($$select actor::text || ' ' || actor_role from public.audit_log where table_name = 'designs' and row_id = %L
   and new_row ->> 'name' = 'By staff'$$, current_setting('jv.des2'))), current_setting('jv.staff') || ' staff', 'L1: and staff''s names staff');
select is(pg_temp.q(format($$select old_row ->> 'name' from public.audit_log where table_name = 'customers' and row_id = %L
   and new_row ->> 'name' = 'By the biller'$$, current_setting('jv.cus'))), 'By the owner', 'L1: and the old row is what the owner left');

-- an update that changes nothing but updated_at writes nothing (D23)
select is(pg_temp.try(format($$update public.customers set updated_at = clock_timestamp() where id = %L$$, current_setting('jv.cus2'))), 'ok 1', 'a touch: updated_at alone');
select is(pg_temp.audit_n('customers', current_setting('jv.cus2'), 'update'), 0, 'L1, D23, T-D14: an update of updated_at alone writes no audit row');
select is(pg_temp.try(format($$update public.customers set name = name where id = %L$$, current_setting('jv.cus2'))), 'ok 1', 'an update that sets a column to what it is');
select is(pg_temp.audit_n('customers', current_setting('jv.cus2'), 'update'), 0, 'L1, D23: nor does an update that changes nothing');
select pg_temp.claims_of(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$update public.customers set name = name where id = %L$$, current_setting('jv.cus2'))), 'ok 1', 'the same by another user (force_person_columns changes updated_by)');
select tests.reset_role();
select is(pg_temp.q(format($$select updated_by::text from public.customers where id = %L$$, current_setting('jv.cus2'))), current_setting('jv.biller'),
  'DB02: updated_by did change, so the comparison has to leave it out');
select is(pg_temp.audit_n('customers', current_setting('jv.cus2'), 'update'), 0, 'L1, D23: and still no audit row: updated_at and updated_by are not changes');
select is(pg_temp.try(format($$update public.customers set notes = 'real change' where id = %L$$, current_setting('jv.cus2'))), 'ok 1', 'a real change');
select is(pg_temp.audit_n('customers', current_setting('jv.cus2'), 'update'), 1, 'L1: is written');

-- nobody writes audit_log: not even the owner (L2)
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.q($$select (count(*) > 20)::text from public.audit_log$$), 'true', 'A4, T-D14: the owner reads the audit log');
select is(pg_temp.try($$insert into public.audit_log (table_name, row_id, action) values ('customers', 'x', 'insert')$$), 'err 42501', 'L2, T-D14: the owner cannot insert into audit_log');
select is(pg_temp.try($$update public.audit_log set actor_role = 'owner'$$), 'err 42501', 'L2, T-D14: ... nor update it');
select is(pg_temp.try($$delete from public.audit_log$$), 'err 42501', 'L2, T-D14: ... nor delete from it');
select is(pg_temp.try($$truncate public.audit_log$$), 'err 42501', 'L2, T-D14: ... nor truncate it');
select is(pg_temp.try($$insert into public.check_runs (ok) values (true)$$), 'err 42501', 'A4: nor write check_runs');
select is(pg_temp.try($$delete from public.backup_runs$$), 'err 42501', 'A4: nor delete backup_runs');
select tests.reset_role();

-- ---------------------------------------------------------------- 7. who reads audit_log, check_runs and backup_runs (T-D03, T-D04)
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.q($$select (count(*) >= 1)::text from public.check_runs$$), 'true', 'A4: the owner reads check_runs');
select is(pg_temp.q($$select (count(*) >= 3)::text from public.backup_runs$$), 'true', 'A4: ... and backup_runs');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.q($$select count(*)::text from public.audit_log$$), '0', 'T-D04, A4: a biller cannot read audit_log');
select is(pg_temp.q($$select count(*)::text from public.check_runs$$), '0', 'A4: ... nor check_runs');
select is(pg_temp.q($$select count(*)::text from public.backup_runs$$), '0', 'A4: ... nor backup_runs');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.q($$select count(*)::text from public.audit_log$$), '0', 'T-D03, A4: staff cannot read audit_log');
select is(pg_temp.q($$select count(*)::text from public.check_runs$$), '0', 'A4: ... nor check_runs');
select is(pg_temp.q($$select count(*)::text from public.backup_runs$$), '0', 'A4: ... nor backup_runs');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.q($$select count(*)::text from public.audit_log$$), '0', 'A10: a login that is not active reads no audit_log');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.q($$select count(*)::text from public.audit_log$$), '0', 'A10: nor does a login with no profile');
select tests.as_anon();
select is(pg_temp.q($$select count(*)::text from public.audit_log$$), 'err 42501', 'A3, T-D02: anon cannot touch audit_log at all');
select is(pg_temp.q($$select count(*)::text from public.check_runs$$), 'err 42501', 'A3: ... nor check_runs');
select is(pg_temp.q($$select count(*)::text from public.backup_runs$$), 'err 42501', 'A3: ... nor backup_runs');
select tests.reset_role();

-- T-D04: a biller cannot change stock, settings or roles; staff cannot change a design's material, purity or selling method
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.q($$select count(*)::text from public.sku_private$$), '0', 'T-D04, D9: a biller cannot read sku_private');
select is(pg_temp.try(format($$update public.skus set notes = 'by the biller' where id = %L$$, current_setting('jv.sku'))), 'ok 0', 'T-D04, A4: a biller changes no stock (no row is visible to the update)');
select is(pg_temp.try(format($$update public.skus set status = 'Missing' where id = %L$$, current_setting('jv.sku'))), 'err 42501', 'T-D04, A5: ... and cannot touch the status column at all');
select is(pg_temp.try(format($$update public.designs set name = 'by the biller' where id = %L$$, current_setting('jv.des2'))), 'ok 0', 'T-D04: ... nor a design');
select is(pg_temp.try($$update public.settings set value = '{"a":3}' where key = 'aud_key'$$), 'ok 0', 'T-D04, A4: a biller changes no setting');
select is(pg_temp.try($$insert into public.settings (key, value) values ('biller_key', '{}')$$), 'err 42501', 'T-D04: ... nor adds one');
select is(pg_temp.try(format($$update public.profiles set role = 'owner' where id = %L$$, current_setting('jv.biller'))), 'ok 0', 'T-D04, A8: a biller cannot make herself the owner');
select is(pg_temp.try(format($$update public.profiles set role = 'owner' where id = %L$$, current_setting('jv.staff'))), 'ok 0', 'T-D04: ... nor anybody else');
select is(pg_temp.try(format($$update public.customers set name = 'Edited by the biller' where id = %L$$, current_setting('jv.cus2'))), 'ok 1', 'T-D04, A5: a biller can edit a customer''s name ...');
select throws_like(format($$update public.customers set archived_at = clock_timestamp() where id = %L$$, current_setting('jv.cus2')), 'JV_FORBIDDEN:%',
  'T-D04, A5, K4: ... and cannot archive the customer');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$update public.designs set name = 'Edited by staff' where id = %L$$, current_setting('jv.des2'))), 'ok 1', 'T-D04, A5: staff edits a design''s content ...');
select throws_like(format($$update public.designs set material = 'Silver' where id = %L$$, current_setting('jv.des2')), 'JV_FORBIDDEN:%',
  'T-D04, A5: ... but not its material');
select throws_like(format($$update public.designs set purity = '925' where id = %L$$, current_setting('jv.des2')), 'JV_FORBIDDEN:%', 'T-D04, A5: ... nor its purity');
select throws_like(format($$update public.designs set selling_method = 'Per Piece' where id = %L$$, current_setting('jv.des2')), 'JV_FORBIDDEN:%',
  'T-D04, A5: ... nor its selling method');
select is(pg_temp.q($$select count(*)::text from public.sku_private$$), '0', 'T-D03, D9: staff cannot read sku_private');
select is(pg_temp.q($$select count(*)::text from public.bills$$), '0', 'T-D03, A4: ... nor bills');
select is(pg_temp.q($$select count(*)::text from public.bill_items$$), '0', 'T-D03, A4: ... nor bill lines');
select is(pg_temp.q($$select count(*)::text from public.customers$$), '0', 'T-D03, A4: ... nor customers');
select is(pg_temp.q($$select count(*)::text from public.receipts$$), '0', 'T-D03, A4: ... nor receipts');
select is(pg_temp.q($$select count(*)::text from public.receipt_allocations$$), '0', 'T-D03, A4: ... nor allocations');
select tests.reset_role();
select is((select role from public.profiles where id = current_setting('jv.biller')::uuid), 'biller', 'A8: and the biller''s role is still biller');
select is((select count(*)::int from pg_attribute a where a.attrelid = 'public.bill_items'::regclass and a.attnum > 0 and not a.attisdropped
   and a.attname ~* 'original'), 0, 'T-D03, D12: no column of bill_items can hold the original weight');
select is(pg_temp.q(format($$select (to_jsonb(l.*)::text ~* 'original')::text from public.bill_items l where id = %L$$, current_setting('jv.line'))), 'false',
  'T-D03, D12: and a bill line holds no original weight in its JSON either');
select is(pg_temp.q($$select count(*)::text from public.audit_log where table_name = 'bill_items' and (old_row::text ~* 'original' or new_row::text ~* 'original')$$), '0',
  'T-D03, D12: nor does the audit log of a bill line');

-- ---------------------------------------------------------------- 8. the touch triggers (D23)
-- a customer with a bill, as the database owner; every step moves the clock, so a touch is a greater updated_at
select pg_temp.fx($q$select set_config('jv.t_c', tests.make_customer('{"name":"DB05 touch customer"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.t_o', tests.make_customer('{"name":"DB05 other customer"}')::text, true)$q$);
create function pg_temp.cust_ts(p_id text) returns timestamptz language sql as $f$ select updated_at from public.customers where id = p_id::uuid $f$;
create function pg_temp.bill_ts(p_id text) returns timestamptz language sql as $f$ select updated_at from public.bills where id = p_id::uuid $f$;
grant execute on function pg_temp.cust_ts(text), pg_temp.bill_ts(text) to public;
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select set_config('jv.ts_o', pg_temp.cust_ts(current_setting('jv.t_o'))::text, true);
select set_config('jv.n_cust_audit', pg_temp.q(format($$select count(*)::text from public.audit_log where table_name = 'customers' and row_id in (%L, %L)$$,
  current_setting('jv.t_c'), current_setting('jv.t_o'))), true);

select pg_temp.fx($q$select set_config('jv.t_b1', (tests.insert_row('public.bills', jsonb_build_object('bill_no', 'TCH-B1', 'customer_id', current_setting('jv.t_c'),
  'bill_date', '2026-01-07', 'doc_type', 'estimate', 'sale_type', 'Retail', 'subtotal', 1000, 'grand_total', 1000)) ->> 'id'), true)$q$);
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23, T-E07: inserting a bill moves the customer''s updated_at');
select is(pg_temp.cust_ts(current_setting('jv.t_o'))::text, current_setting('jv.ts_o'), 'D23: and only that customer''s');
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select pg_temp.fx($q$select set_config('jv.t_b2', (tests.insert_row('public.bills', jsonb_build_object('bill_no', 'TCH-B2', 'customer_id', current_setting('jv.t_c'),
  'bill_date', '2026-01-07', 'doc_type', 'estimate', 'sale_type', 'Retail', 'subtotal', 700, 'grand_total', 700)) ->> 'id'), true)$q$);
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select set_config('jv.ts_b1', pg_temp.bill_ts(current_setting('jv.t_b1'))::text, true);
select set_config('jv.ts_b2', pg_temp.bill_ts(current_setting('jv.t_b2'))::text, true);

select pg_temp.fx($q$select set_config('jv.t_r', (tests.insert_row('public.receipts', jsonb_build_object('customer_id', current_setting('jv.t_c'),
  'kind', 'money', 'mode', 'UPI', 'amount', 400, 'paid_on', '2026-01-07')) ->> 'id'), true)$q$);
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23, T-E07: inserting a receipt moves the customer''s updated_at');
select is(pg_temp.bill_ts(current_setting('jv.t_b1'))::text, current_setting('jv.ts_b1'), 'D23: but no bill, as the receipt has no allocation yet');
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);

select pg_temp.fx($q$select set_config('jv.t_a', (tests.insert_row('public.receipt_allocations', jsonb_build_object('receipt_id', current_setting('jv.t_r'),
  'bill_id', current_setting('jv.t_b1'), 'customer_id', current_setting('jv.t_c'), 'amount', 400)) ->> 'id'), true)$q$);
select ok(pg_temp.bill_ts(current_setting('jv.t_b1')) > current_setting('jv.ts_b1')::timestamptz, 'D23, T-E07: inserting an allocation moves the updated_at of its bill ...');
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23: ... and of the customer');
select is(pg_temp.bill_ts(current_setting('jv.t_b2'))::text, current_setting('jv.ts_b2'), 'D23: and not of the customer''s other bill');
select is(pg_temp.cust_ts(current_setting('jv.t_o'))::text, current_setting('jv.ts_o'), 'D23: nor of another customer');
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select set_config('jv.ts_b1', pg_temp.bill_ts(current_setting('jv.t_b1'))::text, true);

select pg_temp.fx($q$update public.receipt_allocations set released_at = clock_timestamp() where id = current_setting('jv.t_a')::uuid$q$);
select ok(pg_temp.bill_ts(current_setting('jv.t_b1')) > current_setting('jv.ts_b1')::timestamptz, 'D23: releasing an allocation (an update) moves its bill ...');
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23: ... and the customer');
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select set_config('jv.ts_b1', pg_temp.bill_ts(current_setting('jv.t_b1'))::text, true);

select pg_temp.fx($q$update public.receipts set status = 'voided', void_reason = 'DB05 test', voided_at = clock_timestamp(), voided_by = current_setting('jv.owner')::uuid
  where id = current_setting('jv.t_r')::uuid$q$);
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23, T-E07: voiding a receipt (an update) moves the customer ...');
select ok(pg_temp.bill_ts(current_setting('jv.t_b1')) > current_setting('jv.ts_b1')::timestamptz, 'D23: ... and the bill its allocation paid');
select is(pg_temp.bill_ts(current_setting('jv.t_b2'))::text, current_setting('jv.ts_b2'), 'D23: and not a bill it never paid');
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select set_config('jv.ts_b1', pg_temp.bill_ts(current_setting('jv.t_b1'))::text, true);

select pg_temp.fx($q$update public.bills set notes = 'a note' where id = current_setting('jv.t_b2')::uuid$q$);
select is(pg_temp.cust_ts(current_setting('jv.t_c'))::text, current_setting('jv.ts_c'), 'D23: an update of a bill''s other columns does not touch the customer (only status does)');
-- cancelling an unpaid bill (nothing allocated)
select pg_temp.fx($q$update public.bills set status = 'cancelled', cancel_reason = 'DB05 cancel', cancelled_at = clock_timestamp(),
  cancelled_by = current_setting('jv.owner')::uuid where id = current_setting('jv.t_b2')::uuid$q$);
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23, T-E07: cancelling an unpaid bill (nothing allocated) moves the customer''s updated_at');
select is(pg_temp.cust_ts(current_setting('jv.t_o'))::text, current_setting('jv.ts_o'), 'D23: and only that customer''s');
select is(pg_temp.q($$select count(*)::text from public.audit_log where table_name = 'customers' and row_id in
  (current_setting('jv.t_c'), current_setting('jv.t_o'))$$), current_setting('jv.n_cust_audit'),
  'D23, T-D14: and all those touches of the customer wrote no audit row');
select is(pg_temp.audit_n('bills', current_setting('jv.t_b2'), 'update'), 2, 'D23: the cancel itself is audited (and the note before it): two update rows, no touch row');
select is(pg_temp.audit_n('bills', current_setting('jv.t_b1'), 'update'), 0, 'D23, T-D14: the touches of the first bill, by its allocation and by the void, wrote no audit row either');

-- one statement that writes two allocations (a rebalance does) touches both bills and the customer
select pg_temp.fx($q$select set_config('jv.t_r2', (tests.insert_row('public.receipts', jsonb_build_object('customer_id', current_setting('jv.t_c'),
  'kind', 'money', 'mode', 'Cash', 'amount', 200, 'paid_on', '2026-01-08')) ->> 'id'), true)$q$);
select set_config('jv.ts_c', pg_temp.cust_ts(current_setting('jv.t_c'))::text, true);
select set_config('jv.ts_b1', pg_temp.bill_ts(current_setting('jv.t_b1'))::text, true);
select set_config('jv.ts_b2', pg_temp.bill_ts(current_setting('jv.t_b2'))::text, true);
select pg_temp.fx($q$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values
  (current_setting('jv.t_r2')::uuid, current_setting('jv.t_b1')::uuid, current_setting('jv.t_c')::uuid, 100),
  (current_setting('jv.t_r2')::uuid, current_setting('jv.t_b2')::uuid, current_setting('jv.t_c')::uuid, 100)$q$);
select ok(pg_temp.bill_ts(current_setting('jv.t_b1')) > current_setting('jv.ts_b1')::timestamptz, 'D23: one statement with two allocations touches the first bill ...');
select ok(pg_temp.bill_ts(current_setting('jv.t_b2')) > current_setting('jv.ts_b2')::timestamptz, 'D23: ... the second bill ...');
select ok(pg_temp.cust_ts(current_setting('jv.t_c')) > current_setting('jv.ts_c')::timestamptz, 'D23: ... and the customer');

-- ---------------------------------------------------------------- 9. the indexes of D19
select is(pg_temp.indexed('public.bills', array['customer_id', 'bill_date']), true, 'D19: bills (customer_id, bill_date)');
select is(pg_temp.indexed('public.bills', array['updated_at', 'id']), true, 'D19: bills (updated_at, id)');
select is(pg_temp.indexed('public.bill_items', array['bill_id']), true, 'D19: bill_items (bill_id), as the first column of the unique (bill_id, line_no)');
select is(pg_temp.indexed('public.skus', array['design_id']), true, 'D19: skus (design_id)');
select is(pg_temp.indexed('public.skus', array['status']), true, 'D19: skus (status)');
select is(pg_temp.indexed('public.skus', array['updated_at', 'id']), true, 'D19: skus (updated_at, id)');
select is(pg_temp.indexed('public.designs', array['updated_at', 'id']), true, 'D19: designs (updated_at, id)');
select is(pg_temp.indexed('public.sku_private', array['updated_at', 'sku_id']), true, 'D19: sku_private (updated_at, sku_id)');
select is(pg_temp.indexed('public.bill_items', array['updated_at', 'id']), true, 'D19: bill_items (updated_at, id)');
select is(pg_temp.indexed('public.receipt_allocations', array['updated_at', 'id']), true, 'D19: receipt_allocations (updated_at, id)');
select is(pg_temp.indexed('public.daily_rates', array['updated_at', 'id']), true, 'D19: daily_rates (updated_at, id)');
select is(pg_temp.indexed('public.settings', array['updated_at', 'key']), true, 'D19: settings (updated_at, key)');
select is(pg_temp.indexed('public.categories', array['updated_at', 'id']), true, 'D19: categories (updated_at, id)');
select is(pg_temp.indexed('public.subcategories', array['updated_at', 'id']), true, 'D19: subcategories (updated_at, id)');
select is(pg_temp.indexed('public.profiles', array['updated_at', 'id']), true, 'D19: profiles (updated_at, id)');
select is(pg_temp.indexed('public.receipts', array['customer_id']), true, 'D19: receipts (customer_id)');
select is(pg_temp.indexed('public.receipts', array['updated_at', 'id']), true, 'D19: receipts (updated_at, id)');
select is(pg_temp.indexed('public.receipt_allocations', array['bill_id']), true, 'D19: receipt_allocations (bill_id), in its composite key index');
select is(pg_temp.indexed('public.receipt_allocations', array['receipt_id']), true, 'D19: receipt_allocations (receipt_id), in its composite key index');
select is(pg_temp.indexed('public.customers', array['updated_at', 'id']), true, 'D19: customers (updated_at, id)');
select is(pg_temp.indexed('public.audit_log', array['table_name', 'row_id']), true, 'D19: audit_log (table_name, row_id)');
select is(pg_temp.indexed('public.bills', array['status', 'id']), false, 'test of the test: an index that is not there is not found');
select is(pg_temp.indexed('public.bills', array['id', 'updated_at']), false, 'test of the test: and the order of the columns counts');
select is(
  (select count(*)::int from (
     select i.indrelid, i.indkey::text, coalesce(pg_get_expr(i.indpred, i.indrelid), ''), coalesce(pg_get_expr(i.indexprs, i.indrelid), '')
       from pg_index i join pg_class c on c.oid = i.indrelid
      where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace)
      group by 1, 2, 3, 4 having count(*) > 1) d),
  0, 'D19, advisor lint 0009: no table has the same index twice');

-- ---------------------------------------------------------------- 10. the seeds (D20): private.seed_defaults()
select has_function('private', 'seed_defaults', array[]::text[], 'D20: private.seed_defaults() exists');
-- start from nothing, as tests.reset_business_data does (the tables are truncated inside this transaction and come back on rollback)
select pg_temp.fx($q$truncate table public.settings, public.categories, public.subcategories, public.customers, public.designs, public.skus,
  public.sku_private, public.bills, public.bill_items, public.receipts, public.receipt_allocations, public.daily_rates, public.audit_log,
  private.counters, private.idempotency, private.import_batches restart identity cascade$q$);
select is(pg_temp.q($$select private.seed_defaults()::text$$), '', 'D20: seed_defaults() runs (it returns nothing)');
select is(pg_temp.q($$select string_agg(key, ',' order by key) from public.settings$$),
  'business,custom_fields,data_epoch,estimate,locations,materials,numbering,tag_template,taxes',
  'D3, D20: the settings keys: business, estimate, taxes, tag_template, numbering, materials, locations, custom_fields, data_epoch');
select is(pg_temp.q($$select value ->> 'prefix' || ' ' || (value -> 'roundOff')::text || ' ' || jsonb_typeof(value -> 'roundOff') from public.settings where key = 'estimate'$$),
  'JV true boolean', 'D3, DB08: estimate holds the number prefix JV and roundOff written out as true');
select is(pg_temp.q($$select (value ? 'defaultGoldRate')::text || ' ' || (value ? 'defaultSilverRate')::text from public.settings where key = 'estimate'$$), 'false false',
  'D3: the default rates are not settings any more (they are daily_rates)');
select is(pg_temp.q($$select private.round_off_setting()::text$$), 'true', 'DB08: round_off_setting() reads the seeded value');
select is(pg_temp.q($$select (value ->> 'designPadding') || ' ' || (value ->> 'skuPadding') || ' ' || (value ->> 'barcodePrefix') || ' ' || jsonb_typeof(value -> 'categoryPrefixes')
  from public.settings where key = 'numbering'$$), '5 3 BC object', 'D3: numbering holds the paddings, the barcode prefix and the category prefixes');
select is(pg_temp.q($$select (value -> 'categoryPrefixes' ->> 'Necklace Set') || ' ' || (select count(*) from jsonb_object_keys(value -> 'categoryPrefixes'))
  from public.settings where key = 'numbering'$$), 'SET 15', 'D3: the category prefixes are the 15 of the prototype');
select is(pg_temp.q($$select value::text from public.settings where key = 'locations'$$),
  '["Main Showroom", "Jaishri Vault", "Workshop", "Exhibition"]', 'D3, X8: the four stock locations, the first being the location of a new piece');
select is(pg_temp.q($$select string_agg(m ->> 'name' || ':' || (m -> 'purities')::text, ' ' order by m ->> 'name')
  from jsonb_array_elements((select value from public.settings where key = 'materials')) m$$),
  'Gold:["18K", "20K", "22K", "24K"] Silver:["800", "925", "999"]', 'D3: the materials and their purities');
select is(pg_temp.q($$select count(*)::text from jsonb_array_elements((select value from public.settings where key = 'custom_fields')) f$$), '2',
  'D3: the two custom fields of the prototype');
select is(pg_temp.q($$select (value ->> 'widthMm') || 'x' || (value ->> 'heightMm') from public.settings where key = 'tag_template'$$), '52x28', 'D3: the tag template');
select is(pg_temp.q($$select (value ->> 'displayName') || ' / ' || (value ->> 'location') from public.settings where key = 'business'$$),
  'Jaishri Gold Palace / Main Showroom', 'D3: the business details');
select is(pg_temp.q($$select (value ->> 'gstEnabled') || ' ' || (value ->> 'gstPercent') from public.settings where key = 'taxes'$$), 'false 0', 'D3: taxes');
select is(pg_temp.q($$select (jsonb_typeof(value) = 'string' and (value #>> '{}')::timestamptz <= clock_timestamp())::text from public.settings where key = 'data_epoch'$$), 'true',
  'D3, C4: data_epoch is a timestamp as text');
select is(pg_temp.q($$select count(*)::text from public.categories$$), '15', 'D5, D20: the 15 categories of DEFAULT_CATEGORIES');
select is(pg_temp.q($$select string_agg(name || '=' || prefix, ',' order by name) from public.categories$$),
  'Anklet=ANK,Bangles=BNG,Bracelet=BRC,Brooch=BRO,Chain=CHN,Earrings=ER,Kada=KADA,Mangalsutra=MNG,Necklace Set=SET,Nose Pin=NP,Other=OTH,Payal=PAY,Pendant=PEND,Pendant Set=PSET,Ring=RING',
  'D5, D20: with the prefixes of DEFAULT_CATEGORY_PREFIXES');
select is(pg_temp.q($$select count(*)::text || ' ' || count(distinct category_id)::text from public.subcategories$$), '60 15', 'D5, D20: 4 subcategories for each of the 15 categories');
select is(pg_temp.q($$select string_agg(name, ',' order by name) from public.subcategories where category_id = (select id from public.categories where name = 'Ring')$$),
  'Casting,Handmade,Jadau,Kundan', 'D5, D20: Kundan, Casting, Jadau and Handmade (DEFAULT_SUBCATEGORY_LIST)');
select is(pg_temp.q($$select count(*)::text from public.customers$$), '1', 'D10, D20: one customer ...');
select is(pg_temp.q($$select id || ' ' || name || ' ' || customer_type || ' ' || is_walkin || ' ' || coalesce(mobile, 'no mobile') || ' ' || coalesce(pan, 'no pan') || ' ' || (archived_at is null)
  from public.customers$$), '00000000-0000-4000-8000-000000000001 Walk-in Customer Retail true no mobile no pan true',
  'D10, K5, D20: ... the walk-in, with its fixed id, no mobile (it is not a named customer), no PAN and not archived');
select is(pg_temp.q($$select (select count(*) from public.designs) + (select count(*) from public.skus) + (select count(*) from public.sku_private)
  + (select count(*) from public.bills) + (select count(*) from public.bill_items) + (select count(*) from public.receipts)
  + (select count(*) from public.receipt_allocations) + (select count(*) from public.daily_rates)$$),
  '0', 'D20, T-F06: and nothing else: no design, piece, bill, receipt or rate (no sample data)');
select is(pg_temp.q($$select (select count(*) from private.counters) + (select count(*) from private.idempotency) + (select count(*) from private.import_batches)$$), '0',
  'D20: and no counter, no request and no import batch');
select is(pg_temp.q($$select count(*)::text from private.limits$$), '9', 'D18: private.limits is not touched by the seed');
-- twice
select pg_temp.fx($q$update public.settings set value = '{"prefix":"OWN","roundOff":false,"footerNote":"mine"}' where key = 'estimate'$q$);
select pg_temp.fx($q$update public.customers set name = 'Walk-in (edited)' where is_walkin$q$);
select pg_temp.fx($q$select private.seed_defaults()$q$);
select is(pg_temp.q($$select value ->> 'prefix' from public.settings where key = 'estimate'$$), 'OWN', 'D20: a second call does not overwrite what the owner changed in the settings');
select is(pg_temp.q($$select count(*)::text from public.settings$$), '9', 'D20: ... and makes no second row of any key');
select is(pg_temp.q($$select count(*)::text from public.customers where is_walkin$$), '1', 'D20: ... nor a second walk-in');
select is(pg_temp.q($$select name from public.customers where is_walkin$$), 'Walk-in (edited)', 'D20: ... nor what was changed on the walk-in');
select is(pg_temp.q($$select count(*)::text from public.categories$$), '15', 'D20: ... nor makes a second category of any default');
select is(pg_temp.q($$select count(*)::text from public.subcategories$$), '60', 'D20: ... nor a second subcategory');
select is(pg_temp.try($$select private.seed_defaults()$$), 'ok 1', 'D20: seed_defaults() can be called by the database owner at any time');
select is(pg_temp.q($$select has_function_privilege('authenticated', 'private.seed_defaults()', 'EXECUTE')::text$$), 'false', 'A3: and by nobody else');

select * from finish();
rollback;
