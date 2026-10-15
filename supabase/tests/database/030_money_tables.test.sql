-- T-B01, T-B06, T-C02, T-D07 and T-D08 (the database halves of the tables), the T-F02 part of the money tables, and the
-- table-level rules that T-F06 and T-B17 rest on. DB04, migrations 0007 and 0008.
--
-- Spec lines: D10 to D15, D21, K1, K4, K5, S3, S4, S6, S7, Y2, Y4, A4, A5. Everything runs in this transaction and is rolled back.
--
-- What is proved here:
--   * the shape of the five tables (customers, bills, bill_items, receipts, receipt_allocations): columns, types, row-level
--     security, restrict foreign keys, the checks of D10 to D14 and the caps of S4 (T-F02; 020_stock_access.test.sql compares
--     every cap literal with private.limits);
--   * T-B01: no receipt has the mode Credit, for any kind, by a direct insert (the bill's payment rows and record_payment are
--     DB09b and DB10b); the checks tie a receipt's kind to its mode, amount, grams and silver rate (D13);
--   * T-B06: a receipt of customer B cannot be allocated to customer A's bill, even by the table owner (D14, Y4);
--   * T-C02 and K4: nobody deletes a customer; archiving is refused while outstanding, fine outstanding, advance or fine advance
--     is not zero, and only the owner archives; K5: the walk-in is one row, never archived, never holds a PAN;
--   * T-D07 and T-D08: no API role has DELETE on any table, and none can insert or update a bill, a line, a receipt or an
--     allocation; the matrix of A4 for these five tables for owner, biller, staff and anon (the biller edits a customer's
--     name and cannot archive).
--
-- The helpers in pg_temp catch an error and report it, so a missing table makes the assertions fail one by one instead of
-- stopping the file; they are granted to public so that they can be called while a role is impersonated. try() leaves the
-- statement's effect in place when it succeeds; tryr() rolls it back, so a table of cases cannot disturb itself.
begin;
select plan(440);

-- ---------------------------------------------------------------- helpers
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

create function pg_temp.fx(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when others then
  raise notice 'fixture failed: % (%) in: %', sqlerrm, sqlstate, left(p_sql, 100);
end
$f$;

create function pg_temp.cols(p_table text) returns text language sql as $f$
  select string_agg(a.attname || ' ' || format_type(a.atttypid, a.atttypmod) || case when a.attnotnull then ' not null' else '' end,
                    ', ' order by a.attnum)
    from pg_attribute a
   where a.attrelid = to_regclass('public.' || p_table) and a.attnum > 0 and not a.attisdropped
$f$;

create function pg_temp.col_privs(p_role text, p_table text, p_priv text) returns text[] language sql as $f$
  select coalesce(array_agg(a.attname::text order by a.attname), '{}'::text[])
    from pg_attribute a
   where a.attrelid = to_regclass('public.' || p_table) and a.attnum > 0 and not a.attisdropped
     and has_column_privilege(p_role, a.attrelid, a.attnum, p_priv)
$f$;

-- The first column of the first row of a query as text; 'err <sqlstate>' when it fails (so that a missing table fails one
-- assertion and not the whole file).
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

-- Row counts of the five tables as the database owner sees them now, for the checks that compare what a role sees.
create function pg_temp.record_counts() returns void language plpgsql as $f$
begin
  perform set_config('jv.n_customers', (select count(*)::text from public.customers), true);
  perform set_config('jv.n_bills', (select count(*)::text from public.bills), true);
  perform set_config('jv.n_bill_items', (select count(*)::text from public.bill_items), true);
  perform set_config('jv.n_receipts', (select count(*)::text from public.receipts), true);
  perform set_config('jv.n_receipt_allocations', (select count(*)::text from public.receipt_allocations), true);
exception when others then
  raise notice 'record_counts failed: %', sqlerrm;
end
$f$;

-- Fixture makers (run as the database owner, which is what an import or a repair is).
create function pg_temp.mkcust(p_label text, p_extra jsonb default '{}'::jsonb) returns uuid language sql as $f$
  select tests.make_customer(jsonb_build_object('name', 'Fixture ' || p_label) || p_extra)
$f$;
create function pg_temp.mkbill(p_customer uuid, p_no text, p_total numeric default 0, p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql as $f$
begin
  return (tests.insert_row('public.bills', jsonb_build_object(
    'bill_no', p_no, 'customer_id', p_customer, 'bill_date', current_date::text, 'doc_type', 'estimate', 'sale_type', 'Retail',
    'subtotal', p_total, 'grand_total', p_total) || p_extra) ->> 'id')::uuid;
end
$f$;
create function pg_temp.mkreceipt(p_customer uuid, p_kind text, p_mode text, p_amount numeric, p_grams numeric default 0,
  p_rate numeric default null, p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql as $f$
begin
  return (tests.insert_row('public.receipts', jsonb_build_object(
    'customer_id', p_customer, 'kind', p_kind, 'mode', p_mode, 'amount', p_amount, 'fine_grams', p_grams, 'silver_rate', p_rate,
    'paid_on', current_date::text) || p_extra) ->> 'id')::uuid;
end
$f$;
create function pg_temp.mkalloc(p_receipt uuid, p_bill uuid, p_customer uuid, p_amount numeric, p_grams numeric default 0,
  p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql as $f$
begin
  return (tests.insert_row('public.receipt_allocations', jsonb_build_object(
    'receipt_id', p_receipt, 'bill_id', p_bill, 'customer_id', p_customer, 'amount', p_amount, 'fine_grams', p_grams) || p_extra) ->> 'id')::uuid;
end
$f$;
-- One bill line, every required column given.
create function pg_temp.mkline(p_bill uuid, p_sku uuid, p_line_no integer, p_extra jsonb default '{}'::jsonb)
returns uuid language plpgsql as $f$
begin
  return (tests.insert_row('public.bill_items', jsonb_build_object(
    'bill_id', p_bill, 'line_no', p_line_no, 'sku_id', p_sku, 'design_no', 'FXB-D', 'sku_no', 'FXB-S' || p_line_no, 'category', 'Fixture rings',
    'material', 'Gold', 'purity', '22K', 'selling_method', 'By Weight', 'gross_weight', 10, 'customer_net_weight', 9.5,
    'quantity', 1, 'metal_rate', 7000, 'labour_rate', 350, 'labour_amount', 3325, 'metal_amount', 66500, 'item_total', 69825) || p_extra) ->> 'id')::uuid;
end
$f$;
grant execute on function pg_temp.try(text), pg_temp.tryr(text), pg_temp.q(text), pg_temp.cnt(text, text), pg_temp.fx(text), pg_temp.cols(text),
  pg_temp.col_privs(text, text, text) to public;

-- Every setting a later statement reads starts as a value that matches nothing, so that a fixture that failed to build makes
-- one assertion fail and does not stop the file with 'unrecognized configuration parameter'.
do $init$
begin
  perform set_config('jv.' || k, '00000000-0000-0000-0000-000000000000', true)
    from unnest(array['owner', 'biller', 'staff', 'inactive', 'none', 'batch', 'walkin', 'c1', 'c2', 'c_arch', 'c_arch2', 'd1', 'p1', 'p2',
      'b1', 'b2', 'b_sold', 'b3', 'b_old', 'r1', 'r2', 'r3', 'a1', 'l1', 'cx', 'cy', 'cz', 'bz', 'rz']) k;
  perform set_config('jv.n_' || k, '-1', true)
    from unnest(array['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations']) k;
end
$init$;

-- ---------------------------------------------------------------- 1. the five tables (D10 to D14, S3, S6, A1)
select has_table('public', 'customers', 'D10: public.customers exists');
select has_table('public', 'bills', 'D11: public.bills exists');
select has_table('public', 'bill_items', 'D12: public.bill_items exists');
select has_table('public', 'receipts', 'D13: public.receipts exists');
select has_table('public', 'receipt_allocations', 'D14: public.receipt_allocations exists');

select is(pg_temp.cols('customers'),
  'id uuid not null, name text not null, mobile text, customer_type text not null, email text, address text, gst_number text, pan text, notes text, is_walkin boolean not null, archived_at timestamp with time zone, import_batch_id uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid, updated_by uuid',
  'D10: the columns of customers, and no balance column (balances are derived)');
select is(pg_temp.cols('bills'),
  'id uuid not null, bill_no text not null, customer_id uuid not null, bill_date date not null, doc_type text not null, sale_type text not null, status text not null, cancel_reason text, cancelled_at timestamp with time zone, cancelled_by uuid, reissue_of uuid, pricing_version smallint not null, subtotal numeric(14,2) not null, discount numeric(14,2) not null, additional_charges numeric(14,2) not null, gst_percent numeric(5,2) not null, gst_amount numeric(14,2) not null, grand_total numeric(14,2) not null, round_off numeric(14,2) not null, fine_weight_due numeric(12,3) not null, notes text, cash_override_reason text, import_batch_id uuid, request_id uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid',
  'D11, S3: the columns of bills (money numeric(14,2), fine numeric(12,3), pricing_version smallint)');
select is(pg_temp.cols('bill_items'),
  'id uuid not null, bill_id uuid not null, line_no integer not null, sku_id uuid not null, design_no text not null, sku_no text not null, category text not null, material text not null, purity text not null, selling_method text not null, gross_weight numeric(12,3) not null, customer_net_weight numeric(12,3) not null, quantity integer not null, metal_rate numeric(12,2) not null, labour_rate numeric(12,2) not null, labour_amount numeric(14,2) not null, piroi numeric(14,2) not null, other_charges numeric(14,2) not null, metal_amount numeric(14,2) not null, fine_weight_due numeric(12,3) not null, item_total numeric(14,2) not null, tax_rate numeric(5,2) not null, tax_amount numeric(14,2) not null, list_metal_rate numeric(12,2), list_labour_rate numeric(12,2), created_at timestamp with time zone not null, updated_at timestamp with time zone not null',
  'D12, S3: the columns of bill_items (a snapshot, the quantity, the list prices; no original weight)');
select is(pg_temp.cols('receipts'),
  'id uuid not null, customer_id uuid not null, kind text not null, mode text, amount numeric(14,2) not null, fine_grams numeric(12,3) not null, silver_rate numeric(12,2), paid_on date not null, reference text, notes text, is_opening boolean not null, cash_override_reason text, status text not null, void_reason text, voided_at timestamp with time zone, voided_by uuid, created_at timestamp with time zone not null, updated_at timestamp with time zone not null, created_by uuid',
  'D13: the columns of receipts, and no request_id (one request can make several receipts)');
select is(pg_temp.cols('receipt_allocations'),
  'id uuid not null, receipt_id uuid not null, bill_id uuid not null, customer_id uuid not null, amount numeric(14,2) not null, fine_grams numeric(12,3) not null, released_at timestamp with time zone, created_at timestamp with time zone not null, updated_at timestamp with time zone not null',
  'D14: the columns of receipt_allocations (the customer is denormalised for the composite keys)');

select is(
  (select array_agg(relname::text order by relname) from pg_class
    where relnamespace = 'public'::regnamespace and relname in ('customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations') and relrowsecurity),
  array['bill_items', 'bills', 'customers', 'receipt_allocations', 'receipts'],
  'A1, S9: row-level security is on for the five tables');
select is(
  (select array_agg(c.relname || '.' || a.attname order by c.relname, a.attname)
     from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = 'public'::regnamespace and c.relname in ('customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations')
      and a.attnum > 0 and not a.attisdropped and a.atttypid in ('float4'::regtype, 'float8'::regtype)),
  null, 'S3, T-F02: no real, double precision or float column in the five tables');
select is(
  (select array_agg(relname::text order by relname) from pg_class c
    where relnamespace = 'public'::regnamespace and relname in ('customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations')
      and (select count(*) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal and t.tgfoid = 'private.set_updated_at'::regproc) = 1),
  array['bill_items', 'bills', 'customers', 'receipt_allocations', 'receipts'],
  'S6: every one of the five tables has the set_updated_at trigger once');
select is(
  (select array_agg(relname::text order by relname) from pg_class c
    where relnamespace = 'public'::regnamespace and relname in ('customers', 'bills', 'receipts')
      and (select count(*) from pg_trigger t where t.tgrelid = c.oid and not t.tgisinternal and t.tgfoid = 'private.force_person_columns'::regproc) = 1),
  array['bills', 'customers', 'receipts'],
  'D22: the person columns of customers, bills and receipts are forced from auth.uid()');
select is(
  (select count(*)::int from pg_constraint where conrelid = to_regclass('public.receipts') and contype = 'c' and pg_get_constraintdef(oid) ilike '%credit%'),
  0, 'T-B01, Y2, I7: the word Credit is in no check of receipts: it is not a mode, only absent from the list');

-- ---------------------------------------------------------------- 2. the fixtures
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.none', tests.make_user('none')::text, true);
end
$mk$;
select pg_temp.fx($q$insert into private.import_batches (name) values ('fx-batch-1')$q$);
select pg_temp.fx($q$select set_config('jv.batch', (select id::text from private.import_batches where name = 'fx-batch-1'), true)$q$);
-- the walk-in: the seeds of DB05 make it; until they exist (and on a database without them) the test makes it
select pg_temp.fx($q$select set_config('jv.walkin', coalesce((select id from public.customers where is_walkin),
  tests.make_customer('{"name":"Fixture walk-in","mobile":null,"is_walkin":true}'))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.c1', pg_temp.mkcust('A')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.c2', pg_temp.mkcust('B')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.c_arch', pg_temp.mkcust('Archived', jsonb_build_object('archived_at', now()::text))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.c_arch2', pg_temp.mkcust('Archived two', jsonb_build_object('archived_at', now()::text))::text, true)$q$);
-- a design and two pieces
select pg_temp.fx($q$select set_config('jv.d1', tests.make_design('{"design_no":"FXB-D"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.p1', tests.make_piece(current_setting('jv.d1')::uuid, '{"sku_no":"FXB-P1","barcode":"BC-FXB-P1"}')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.p2', tests.make_piece(current_setting('jv.d1')::uuid, '{"sku_no":"FXB-P2","barcode":"BC-FXB-P2"}')::text, true)$q$);
-- c1: an unpaid bill b1 of 1000 with a line, and a cancelled bill b3; c2: a bill b2 of 500, one more (b_sold) that a Sold piece points to
select pg_temp.fx($q$select set_config('jv.b1', pg_temp.mkbill(current_setting('jv.c1')::uuid, 'FX-B1', 1000)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.b2', pg_temp.mkbill(current_setting('jv.c2')::uuid, 'FX-B2', 500)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.b_sold', pg_temp.mkbill(current_setting('jv.c2')::uuid, 'FX-BS', 60)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.b3', pg_temp.mkbill(current_setting('jv.c1')::uuid, 'FX-B3', 200, jsonb_build_object(
  'status', 'cancelled', 'cancel_reason', 'Fixture cancel', 'cancelled_at', now()::text, 'cancelled_by', current_setting('jv.owner')))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.r1', pg_temp.mkreceipt(current_setting('jv.c1')::uuid, 'money', 'Cash', 400)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.r2', pg_temp.mkreceipt(current_setting('jv.c2')::uuid, 'money', 'UPI', 300)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.r3', pg_temp.mkreceipt(current_setting('jv.c1')::uuid, 'money', 'Cash', 50, 0, null, jsonb_build_object(
  'status', 'voided', 'void_reason', 'Fixture void', 'voided_at', now()::text, 'voided_by', current_setting('jv.owner')))::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.a1', pg_temp.mkalloc(current_setting('jv.r1')::uuid, current_setting('jv.b1')::uuid, current_setting('jv.c1')::uuid, 400)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.l1', pg_temp.mkline(current_setting('jv.b1')::uuid, current_setting('jv.p1')::uuid, 1)::text, true)$q$);
select pg_temp.fx($q$update public.skus set status = 'Sold', sold_bill_id = current_setting('jv.b_sold')::uuid where id = current_setting('jv.p2')::uuid$q$);

select is(pg_temp.q(format($$select count(*) from public.customers where id in (%L, %L)$$, current_setting('jv.c1'), current_setting('jv.c2'))), '2',
  'DB01 builders: tests.make_customer fits the real customers table');
select is(pg_temp.q(format($$select count(*) from public.bills where id in (%L, %L, %L, %L)$$, current_setting('jv.b1'), current_setting('jv.b2'), current_setting('jv.b3'), current_setting('jv.b_sold'))), '4',
  'the fixture bills are there (two active, one cancelled, one that a Sold piece points to)');
select is(pg_temp.q($$select tests.bulk_bills(30)$$), '30', 'DB01 builders: tests.bulk_bills fits the real customers and bills tables');
select is(pg_temp.q(format($$select status || ' ' || (sold_bill_id = %L::uuid)::text from public.skus where id = %L$$, current_setting('jv.b_sold'), current_setting('jv.p2'))), 'Sold true',
  'D8: a piece is Sold with the id of a bill that exists');

-- ---------------------------------------------------------------- 3. customers (D10, K5): name, mobile, type, PAN, the walk-in
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values ('', '9876543210')$$), 'err 23514', 'D10: a blank name is refused');
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values ('    ', '9876543210')$$), 'err 23514', 'D10: and a name of spaces');
select is(pg_temp.tryr(format($$insert into public.customers (name, mobile) values (%L, '9876543210')$$, repeat('x', 121))), 'err 23514', 'D10: a name of 121 characters is refused');
select is(pg_temp.tryr(format($$insert into public.customers (name, mobile) values (%L, '9876543210')$$, repeat('y', 120))), 'ok 1', 'D10: a name of 120 characters is accepted');
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values (null, '9876543210')$$), 'err 23502', 'D10: a customer has a name');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, customer_type) values ('Type one', '9876543210', 'Gold')$$), 'err 23514',
  'D10: the customer type is Retail, Semi-Wholesale or Wholesale');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, customer_type) values ('Type two', '9876543210', 'Semi-Wholesale')$$), 'ok 1', 'D10: Semi-Wholesale is accepted');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, customer_type) values ('Type three', '9876543210', 'Wholesale')$$), 'ok 1', 'D10: Wholesale is accepted');
select is(pg_temp.q($$select customer_type || ' ' || is_walkin::text from public.customers where name = 'Fixture A'$$), 'Retail false',
  'D10: the type defaults to Retail and a customer is not the walk-in unless said');
-- the mobile rule: ten digits, or + and 7 to 15 digits; blank only for an imported customer (and the walk-in, who is not named)
create function pg_temp.mobile_cases() returns setof text language plpgsql as $f$
declare
  r record;
begin
  for r in select * from (values
    ('9876543210', 'ok 1', 'ten digits'),
    ('0987654321', 'ok 1', 'ten digits starting with 0'),
    ('+919876543210', 'ok 1', '+ and 12 digits'),
    ('+1234567', 'ok 1', '+ and the 7 digits of the lower bound'),
    ('+123456789012345', 'ok 1', '+ and the 15 digits of the upper bound'),
    ('+123456', 'err 23514', '+ and 6 digits'),
    ('+1234567890123456', 'err 23514', '+ and 16 digits'),
    ('987654321', 'err 23514', 'nine digits'),
    ('98765432101', 'err 23514', 'eleven digits without a +'),
    ('98765 43210', 'err 23514', 'a space inside (the screen removes spaces on entry)'),
    ('987-654-3210', 'err 23514', 'dashes inside (the screen removes dashes on entry)'),
    ('+91 98765 43210', 'err 23514', 'a + number with spaces'),
    ('abcdefghij', 'err 23514', 'ten letters'),
    ('+', 'err 23514', 'a lone +'),
    ('91+9876543210', 'err 23514', 'a + that is not first'),
    ('', 'err 23514', 'blank'),
    ('   ', 'err 23514', 'spaces only')
  ) v(mobile, expected, what)
  loop
    return next is(pg_temp.tryr(format($q$insert into public.customers (name, mobile) values ('Mobile case', %L)$q$, r.mobile)), r.expected,
      'D10, T-F06: the mobile number ' || r.what || ' -> ' || r.expected);
  end loop;
end
$f$;
select * from pg_temp.mobile_cases();
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values ('No mobile', null)$$), 'err 23514', 'D10, T-F06: no mobile number at all is refused for a named customer');
select is(pg_temp.tryr(format($$insert into public.customers (name, mobile, import_batch_id) values ('Imported one', null, %L)$$, current_setting('jv.batch'))), 'ok 1',
  'D10, T-F06: a blank mobile number is accepted for an imported customer (the screen asks for it when selected)');
select is(pg_temp.tryr(format($$insert into public.customers (name, mobile, import_batch_id) values ('Imported two', '', %L)$$, current_setting('jv.batch'))), 'ok 1',
  'D10: an empty one too');
select is(pg_temp.tryr(format($$insert into public.customers (name, mobile, import_batch_id) values ('Imported three', '12345', %L)$$, current_setting('jv.batch'))), 'err 23514',
  'D10: but an import batch does not excuse a number that is wrong');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, is_walkin) values ('Second walk-in', null, true)$$), 'err 23505',
  'D10, K5, T-F06: a second walk-in customer is refused (a unique partial index)');
select is(pg_temp.q($$select count(*) from public.customers where is_walkin$$), '1', 'D10, K5, T-F06: exactly one row has is_walkin = true');
select is((select count(*)::int from pg_indexes where schemaname = 'public' and tablename = 'customers' and indexdef ilike '%unique%' and indexdef ilike '%where%is_walkin%'), 1,
  'D10: the one walk-in is held by a unique partial index');
select is(pg_temp.tryr(format($$update public.customers set pan = 'ABCDE1234F' where id = %L$$, current_setting('jv.walkin'))), 'err 23514',
  'D10, K5, T-B17: the walk-in never holds a PAN');
select is(pg_temp.tryr(format($$update public.customers set mobile = null where id = %L$$, current_setting('jv.walkin'))), 'ok 1',
  'D10: the walk-in has no mobile number (it is not a named customer)');
-- PAN
select is(pg_temp.tryr($$insert into public.customers (name, mobile, pan) values ('Pan good', '9876543210', 'ABCDE1234F')$$), 'ok 1', 'D10, Z3: five capitals, four digits, one capital is accepted');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, pan) values ('Pan none', '9876543210', null)$$), 'ok 1', 'D10: no PAN is accepted');
create function pg_temp.pan_cases() returns setof text language plpgsql as $f$
declare
  r record;
begin
  for r in select * from (values
    ('abcde1234f', 'lower case'), ('ABCDE12345', 'a digit at the end'), ('ABCD1234F', 'four letters'), ('ABCDEF1234F', 'six letters'),
    ('ABCDE123F', 'three digits'), ('ABCDE12345F', 'five digits'), (' ABCDE1234F', 'a leading space'), ('ABCDE1234F ', 'a trailing space'),
    ('ABCDE-1234F', 'a dash'), ('', 'empty'), ('1BCDE1234F', 'a digit first')
  ) v(pan, what)
  loop
    return next is(pg_temp.tryr(format($q$insert into public.customers (name, mobile, pan) values ('Pan case', '9876543210', %L)$q$, r.pan)), 'err 23514',
      'D10, T-F06: a PAN with ' || r.what || ' is refused');
  end loop;
end
$f$;
select * from pg_temp.pan_cases();
select is(pg_temp.tryr($$insert into public.customers (name, mobile, import_batch_id) values ('Bad batch', '9876543210', gen_random_uuid())$$), 'err 23503',
  'D21: the import batch of a customer must exist');
select is(pg_temp.tryr(format($$delete from private.import_batches where id = %L$$, current_setting('jv.batch'))), 'ok 1',
  'D21: an import batch nothing points to can be deleted by the database owner');
select pg_temp.fx(format($q$update public.customers set import_batch_id = %L where id = %L$q$, current_setting('jv.batch'), current_setting('jv.c_arch2')));
select is(pg_temp.tryr(format($$delete from private.import_batches where id = %L$$, current_setting('jv.batch'))), 'err 23503',
  'D21: an import batch that a customer points to cannot be deleted');
select pg_temp.fx(format($q$update public.customers set import_batch_id = null where id = %L$q$, current_setting('jv.c_arch2')));
-- nothing is deleted: a customer with a bill is held by the restrict key, even for the database owner
select is(pg_temp.tryr(format($$delete from public.customers where id = %L$$, current_setting('jv.c1'))), 'err 23503',
  'T-C02, S7, T-F02: a customer with bills cannot be deleted, not even by the database owner');
select is(pg_temp.tryr(format($$delete from public.customers where id = %L$$, current_setting('jv.c_arch'))), 'ok 1',
  'S7: only the database owner can delete, and only a customer nothing points to (the emergency path)');

-- ---------------------------------------------------------------- 4. bills (D11, K1)
-- A bill for customer B with only the columns given besides the required ones; p_keep leaves the row in place.
create function pg_temp.bill_insert(p_cols text, p_vals text, p_keep boolean default false) returns text language plpgsql as $f$
declare
  v_sql text := format('insert into public.bills (bill_no, customer_id, bill_date, doc_type, sale_type%s) values (%L, %L, current_date, %L, %L%s)',
    case when p_cols = '' then '' else ', ' || p_cols end,
    'FX-N' || tests.next_n(), current_setting('jv.c2'), 'estimate', 'Retail', case when p_vals = '' then '' else ', ' || p_vals end);
begin
  return case when p_keep then pg_temp.try(v_sql) else pg_temp.tryr(v_sql) end;
end
$f$;
select is(pg_temp.bill_insert('', '', true), 'ok 1', 'D11: a bill with only the required columns is accepted');
select is(pg_temp.q($$select status || ' ' || pricing_version || ' ' || subtotal || ' ' || discount || ' ' || additional_charges || ' ' || gst_percent || ' ' || gst_amount || ' ' || grand_total || ' ' || round_off || ' ' || fine_weight_due
             from public.bills where bill_no like 'FX-N%' order by created_at limit 1$$),
  'active 1 0.00 0.00 0.00 0.00 0.00 0.00 0.00 0.000', 'D11, K1, R13: a bill is created active, pricing version 1, and every amount defaults to 0');
select is(pg_temp.tryr(format($$insert into public.bills (bill_no, customer_id, bill_date, doc_type, sale_type) values ('FX-B1', %L, current_date, 'estimate', 'Retail')$$, current_setting('jv.c2'))),
  'err 23505', 'D11, T-F02: a bill number is unique');
select is(pg_temp.tryr(format($$insert into public.bills (bill_no, customer_id, bill_date, doc_type, sale_type) values (null, %L, current_date, 'estimate', 'Retail')$$, current_setting('jv.c2'))),
  'err 23502', 'D11: a bill has a number');
select is(pg_temp.tryr($$insert into public.bills (bill_no, customer_id, bill_date, doc_type, sale_type) values ('FX-X1', gen_random_uuid(), current_date, 'estimate', 'Retail')$$),
  'err 23503', 'D11: the customer must exist');
select is(pg_temp.tryr(format($$insert into public.bills (bill_no, customer_id, doc_type, sale_type) values ('FX-X2', %L, 'estimate', 'Retail')$$, current_setting('jv.c2'))),
  'err 23502', 'D11: a bill has a date');
select is(pg_temp.tryr(format($$insert into public.bills (bill_no, customer_id, bill_date, sale_type) values ('FX-X3', %L, current_date, 'Retail')$$, current_setting('jv.c2'))),
  'err 23502', 'D11: a bill has a document type');
-- a value outside its check is refused, a value on the edge is accepted
create function pg_temp.bill_cases() returns setof text language plpgsql as $f$
declare
  r record;
  v_cols text;
  v_vals text;
begin
  for r in select * from (values
    ('doc_type', $$'tax_invoice'$$, 'ok 1', 'doc_type tax_invoice (reserved for decision 4)'),
    ('doc_type', $$'bill_of_supply'$$, 'ok 1', 'doc_type bill_of_supply (reserved)'),
    ('doc_type', $$'opening_balance'$$, 'ok 1', 'doc_type opening_balance (dues brought forward, D15)'),
    ('doc_type', $$'invoice'$$, 'err 23514', 'a doc_type that is not one of the four'),
    ('sale_type', $$'Semi-Wholesale'$$, 'ok 1', 'sale type Semi-Wholesale'),
    ('sale_type', $$'Credit'$$, 'err 23514', 'a sale type that is not Retail, Semi-Wholesale or Wholesale'),
    ('status', $$'paid'$$, 'err 23514', 'a status that is not active or cancelled'),
    ('subtotal', '-0.01', 'err 23514', 'a negative subtotal'),
    ('subtotal', '1000000000', 'ok 1', 'a subtotal of exactly 1,000,000,000 (S4)'),
    ('subtotal', '1000000000.01', 'err 23514', 'a subtotal one paisa above the cap'),
    ('discount', '-1', 'err 23514', 'a negative discount'),
    ('discount', '1000000000.01', 'err 23514', 'a discount above the cap'),
    ('additional_charges', '-1', 'err 23514', 'a negative additional charge'),
    ('additional_charges', '1000000000.01', 'err 23514', 'an additional charge above the cap'),
    ('gst_percent', '-1', 'err 23514', 'a negative GST percent'),
    ('gst_amount', '-1', 'err 23514', 'a negative GST amount'),
    ('grand_total', '-1', 'err 23514', 'a negative grand total'),
    ('grand_total', '1000000000', 'ok 1', 'a grand total of exactly 1,000,000,000'),
    ('grand_total', '1000000000.01', 'err 23514', 'a grand total above the cap'),
    ('round_off', '-0.40', 'ok 1', 'a negative round-off of -0.40 (R8, D11)'),
    ('round_off', '0.49', 'ok 1', 'a positive round-off'),
    ('fine_weight_due', '-0.001', 'err 23514', 'a negative fine weight due'),
    ('fine_weight_due', '13.900', 'ok 1', 'a fine weight due of 13.900 g'),
    ('pricing_version', '0', 'err 23514', 'a pricing version below 1'),
    ('pricing_version', '2', 'ok 1', 'pricing version 2 (a later rule set, R13)'),
    ('cash_override_reason', $$'   '$$, 'err 23514', 'a blank cash override reason'),
    ('cash_override_reason', $$'Customer paid by cash on request'$$, 'ok 1', 'a cash override reason (Z1)'),
    ('reissue_of', 'gen_random_uuid()', 'err 23503', 'a re-issue of a bill that does not exist')
  ) v(col, val, expected, what)
  loop
    -- the base columns, with the one under test replacing its default
    select string_agg(quote_ident(k), ', '), string_agg(x, ', ') into v_cols, v_vals
      from (
        select b.k, b.x from (values ('bill_no', quote_literal('FX-C' || tests.next_n())), ('customer_id', quote_literal(current_setting('jv.c2'))),
                                     ('bill_date', 'current_date'), ('doc_type', '''estimate'''), ('sale_type', '''Retail''')) b(k, x)
         where b.k <> r.col
        union all select r.col, r.val
      ) s;
    return next is(pg_temp.tryr(format('insert into public.bills (%s) values (%s)', v_cols, v_vals)), r.expected, 'D11: ' || r.what);
  end loop;
end
$f$;
select * from pg_temp.bill_cases();
-- the cancel columns are present exactly when the bill is cancelled
select is(pg_temp.bill_insert('status', $$'cancelled'$$), 'err 23514', 'D11, K1: a cancelled bill without a reason, a time and a person is refused');
select is(pg_temp.bill_insert('status, cancel_reason, cancelled_at', $$'cancelled', 'x', now()$$), 'err 23514', 'D11: and one without the person');
select is(pg_temp.bill_insert('status, cancel_reason, cancelled_by', format($$'cancelled', 'x', %L$$, current_setting('jv.owner'))), 'err 23514', 'D11: and one without the time');
select is(pg_temp.bill_insert('status, cancelled_at, cancelled_by', format($$'cancelled', now(), %L$$, current_setting('jv.owner'))), 'err 23514', 'D11: and one without the reason');
select is(pg_temp.bill_insert('status, cancel_reason, cancelled_at, cancelled_by', format($$'cancelled', '   ', now(), %L$$, current_setting('jv.owner'))), 'err 23514', 'D11: a blank reason does not count');
select is(pg_temp.bill_insert('status, cancel_reason, cancelled_at, cancelled_by', format($$'cancelled', 'Customer returned the goods', now(), %L$$, current_setting('jv.owner'))), 'ok 1',
  'D11: a cancelled bill with its reason, time and person is accepted');
select is(pg_temp.bill_insert('cancel_reason', $$'x'$$), 'err 23514', 'D11: an active bill with a cancel reason is refused');
select is(pg_temp.bill_insert('cancelled_at', 'now()'), 'err 23514', 'D11: and with a cancel time');
select is(pg_temp.bill_insert('cancelled_by', format('%L', current_setting('jv.owner'))), 'err 23514', 'D11: and with a person who cancelled it');
-- reissue_of: unique, a foreign key to bills, not itself
select pg_temp.fx($q$select set_config('jv.b_old', pg_temp.mkbill(current_setting('jv.c2')::uuid, 'FX-OLD', 100, jsonb_build_object(
  'status', 'cancelled', 'cancel_reason', 'Wrong rate', 'cancelled_at', now()::text, 'cancelled_by', current_setting('jv.owner')))::text, true)$q$);
select is(pg_temp.bill_insert('reissue_of', format('%L', current_setting('jv.b_old')), true), 'ok 1', 'D11, K6: a bill that replaces a cancelled bill points back to it (reissue_of)');
select is(pg_temp.bill_insert('reissue_of', format('%L', current_setting('jv.b_old'))), 'err 23505', 'D11, K6, T-F02: and a second bill cannot replace the same bill (reissue_of is unique)');
select is(pg_temp.tryr(format($$update public.bills set reissue_of = id where id = %L$$, current_setting('jv.b2'))), 'err 23514', 'D11: a bill cannot replace itself');
select is(pg_temp.tryr(format($$delete from public.bills where id = %L$$, current_setting('jv.b_old'))), 'err 23503', 'S7: a bill that another bill replaces cannot be deleted');
-- request_id: unique when given, many bills may have none
select is(pg_temp.bill_insert('request_id', $$'11111111-1111-1111-1111-111111111111'$$, true), 'ok 1', 'D11: a bill made by a request carries its request id');
select is(pg_temp.bill_insert('request_id', $$'11111111-1111-1111-1111-111111111111'$$), 'err 23505', 'D11, L5: the same request id cannot make a second bill (request_id is unique)');
select is(pg_temp.q($$select (count(*) >= 4)::text from public.bills where request_id is null$$), 'true', 'D11: and many bills have no request id (imported bills, fixtures)');
select is(pg_temp.tryr(format($$delete from public.bills where id = %L$$, current_setting('jv.b1'))), 'err 23503', 'S7: a bill with lines and allocations cannot be deleted, not even by the database owner');
select is(pg_temp.tryr(format($$delete from public.bills where id = %L$$, current_setting('jv.b_sold'))), 'err 23503', 'S7, D8: nor a bill that a Sold piece points to');

-- ---------------------------------------------------------------- 5. bill_items (D12)
-- each case adds one line to bill b2 for piece p2 (line 1 unless the case says), and is undone afterwards
create function pg_temp.line_cases() returns setof text language plpgsql as $f$
declare
  r record;
begin
  for r in select * from (values
    ('{}'::jsonb, 'ok 1', 'a line with the required columns is accepted'),
    ('{"quantity": 0}', 'err 23514', 'a quantity of 0 is refused'),
    ('{"quantity": 1001}', 'err 23514', 'a quantity of 1,001 is refused'),
    ('{"quantity": 1000}', 'ok 1', 'a quantity of 1,000 is accepted'),
    ('{"quantity": 3, "selling_method": "Per Piece", "metal_rate": 1200, "metal_amount": 3600, "labour_rate": 0, "labour_amount": 0, "item_total": 3600}', 'ok 1', 'a Per Piece line keeps its quantity (BIL-05)'),
    ('{"line_no": 0}', 'err 23514', 'line number 0 is refused'),
    ('{"line_no": 201}', 'err 23514', 'line number 201 is refused (a bill has 1 to 200 lines)'),
    ('{"line_no": 200}', 'ok 1', 'line number 200 is accepted'),
    ('{"material": "Platinum"}', 'err 23514', 'a material other than Gold or Silver'),
    ('{"material": "Silver", "purity": "925"}', 'ok 1', 'Silver is accepted'),
    ('{"selling_method": "By Piece"}', 'err 23514', 'a selling method other than By Weight or Per Piece'),
    ('{"design_no": ""}', 'err 23514', 'a blank design number in the snapshot'),
    ('{"sku_no": "  "}', 'err 23514', 'a blank piece number in the snapshot'),
    ('{"gross_weight": -1}', 'err 23514', 'a negative gross weight'),
    ('{"gross_weight": 100000.001}', 'err 23514', 'a gross weight above 100,000 g'),
    ('{"gross_weight": 100000, "customer_net_weight": 100000}', 'ok 1', 'weights of exactly 100,000 g'),
    ('{"customer_net_weight": -0.001}', 'err 23514', 'a negative customer net weight'),
    ('{"customer_net_weight": 100000.001}', 'err 23514', 'a customer net weight above 100,000 g'),
    ('{"metal_rate": -1}', 'err 23514', 'a negative metal rate'),
    ('{"metal_rate": 100000001}', 'err 23514', 'a metal rate above 100,000,000'),
    ('{"labour_rate": -1}', 'err 23514', 'a negative labour rate'),
    ('{"labour_rate": 100000001}', 'err 23514', 'a labour rate above 100,000,000'),
    ('{"list_metal_rate": 100000001}', 'err 23514', 'a list metal rate above the cap'),
    ('{"list_labour_rate": -1}', 'err 23514', 'a negative list labour rate'),
    ('{"list_metal_rate": 6900, "list_labour_rate": 350}', 'ok 1', 'the list prices the screen offered (I11)'),
    ('{"labour_amount": -1}', 'err 23514', 'a negative labour amount'),
    ('{"labour_amount": 1000000000.01}', 'err 23514', 'a labour amount above 1,000,000,000'),
    ('{"metal_amount": -1}', 'err 23514', 'a negative metal amount'),
    ('{"metal_amount": 1000000000.01}', 'err 23514', 'a metal amount above 1,000,000,000'),
    ('{"piroi": -1}', 'err 23514', 'a negative piroi'),
    ('{"piroi": 1000000000.01}', 'err 23514', 'a piroi above 1,000,000,000'),
    ('{"other_charges": -1}', 'err 23514', 'negative other charges'),
    ('{"other_charges": 1000000000.01}', 'err 23514', 'other charges above 1,000,000,000'),
    ('{"item_total": -1}', 'err 23514', 'a negative line total'),
    ('{"item_total": 1000000000.01}', 'err 23514', 'a line total above 1,000,000,000'),
    ('{"item_total": 1000000000}', 'ok 1', 'a line total of exactly 1,000,000,000'),
    ('{"fine_weight_due": -1}', 'err 23514', 'a negative fine weight due'),
    ('{"fine_weight_due": 13.9}', 'ok 1', 'a fine weight due on a line'),
    ('{"tax_rate": -1}', 'err 23514', 'a negative tax rate'),
    ('{"tax_amount": -1}', 'err 23514', 'a negative tax amount')
  ) v(extra, expected, what)
  loop
    return next is(
      pg_temp.tryr(format($q$select pg_temp.mkline(%L, %L, %s, %L::jsonb)$q$, current_setting('jv.b2'), current_setting('jv.p2'),
        coalesce(r.extra ->> 'line_no', '1'), (r.extra - 'line_no')::text)),
      r.expected, 'D12: ' || r.what);
  end loop;
end
$f$;
select * from pg_temp.line_cases();
select is(pg_temp.tryr(format($$select pg_temp.mkline(%L, %L, 1)$$, current_setting('jv.b1'), current_setting('jv.p2'))), 'err 23505',
  'D12, T-F02: a line number is unique within a bill');
select is(pg_temp.tryr(format($$select pg_temp.mkline(%L, %L, 2)$$, current_setting('jv.b1'), current_setting('jv.p1'))), 'err 23505',
  'D12, T-F02: and a piece is on a bill once');
select is(pg_temp.tryr(format($$select pg_temp.mkline(%L, %L, 1)$$, current_setting('jv.b2'), current_setting('jv.p1'))), 'ok 1',
  'D12: the same piece may be on a line of another bill (returned to stock, then sold again), with the same line number');
select is(pg_temp.tryr(format($$select pg_temp.mkline(%L, gen_random_uuid(), 5)$$, current_setting('jv.b2'))), 'err 23503', 'D12: the piece must exist');
select is(pg_temp.tryr(format($$select pg_temp.mkline(gen_random_uuid(), %L, 5)$$, current_setting('jv.p2'))), 'err 23503', 'D12: the bill must exist');
select is(pg_temp.tryr(format($$delete from public.skus where id = %L$$, current_setting('jv.p1'))), 'err 23503', 'S7: a piece that is on a bill line cannot be deleted');
select is((select count(*)::int from pg_attribute a where a.attrelid = to_regclass('public.bill_items') and a.attnum > 0 and not a.attisdropped
            and a.attname ~* 'original'), 0, 'D12, T-D03: the snapshot never contains the original weight: no column of bill_items is about it');

-- ---------------------------------------------------------------- 6. receipts (D13, Y2): T-B01 and the ties of kind
create function pg_temp.receipt_cases() returns setof text language plpgsql as $f$
declare
  r record;
begin
  for r in select * from (values
    -- kind, mode, amount, fine_grams, silver_rate, expected, what
    ('money', 'Cash', '500', '0', null, 'ok 1', 'a money receipt in Cash'),
    ('money', 'UPI', '500', '0', null, 'ok 1', 'a money receipt by UPI'),
    ('money', 'Card', '500', '0', null, 'ok 1', 'a money receipt by Card'),
    ('money', 'Bank Transfer', '500', '0', null, 'ok 1', 'a money receipt by Bank Transfer'),
    ('money', 'Other', '500', '0', null, 'ok 1', 'a money receipt in mode Other'),
    ('refund', 'Cash', '100', '0', null, 'ok 1', 'a refund in Cash'),
    ('refund', 'Bank Transfer', '100', '0', null, 'ok 1', 'a refund by Bank Transfer'),
    ('fine_cash', 'Cash', '1000', '5.000', '200', 'ok 1', 'silver settled in cash: grams, a rate and the amount'),
    ('fine_silver', null, '0', '5.000', null, 'ok 1', 'silver received: grams only, no mode, no amount, no rate'),
    -- T-B01: there is no Credit mode, whatever the kind
    ('money', 'Credit', '500', '0', null, 'err 23514', 'T-B01, Y2: a money receipt with the mode Credit'),
    ('refund', 'Credit', '100', '0', null, 'err 23514', 'T-B01: a refund with the mode Credit'),
    ('fine_cash', 'Credit', '1000', '5.000', '200', 'err 23514', 'T-B01: a cash fine settlement with the mode Credit'),
    ('money', 'credit', '500', '0', null, 'err 23514', 'T-B01: credit in lower case'),
    ('money', 'cash', '500', '0', null, 'err 23514', 'D13: the modes are spelled exactly: cash in lower case'),
    ('money', 'Cheque', '500', '0', null, 'err 23514', 'D13: a mode that is not one of the five'),
    ('money', null, '500', '0', null, 'err 23514', 'D13: a money receipt has a mode'),
    ('refund', null, '100', '0', null, 'err 23514', 'D13: a refund has a mode'),
    ('payment', 'Cash', '500', '0', null, 'err 23514', 'D13: a kind that is not money, fine_silver, fine_cash or refund'),
    ('Credit', 'Cash', '500', '0', null, 'err 23514', 'T-B01: Credit is not a kind either'),
    -- amounts
    ('money', 'Cash', '0', '0', null, 'err 23514', 'D13: a money receipt of 0'),
    ('money', 'Cash', '-5', '0', null, 'err 23514', 'D13: a negative money receipt'),
    ('money', 'Cash', '1000000000', '0', null, 'ok 1', 'S4: a money receipt of exactly 1,000,000,000'),
    ('money', 'Cash', '1000000000.01', '0', null, 'err 23514', 'S4: a money receipt above the cap'),
    ('refund', 'Cash', '0', '0', null, 'err 23514', 'D13: a refund of 0'),
    ('refund', 'Cash', '1000000000.01', '0', null, 'err 23514', 'S4: a refund above the cap'),
    -- grams
    ('money', 'Cash', '500', '5', null, 'err 23514', 'D13: a money receipt carries no fine grams'),
    ('refund', 'Cash', '100', '5', null, 'err 23514', 'D13: nor does a refund'),
    ('fine_silver', null, '0', '0', null, 'err 23514', 'D13: silver received has grams above 0'),
    ('fine_silver', null, '0', '-1', null, 'err 23514', 'D13: not negative grams'),
    ('fine_silver', null, '0', '100000', null, 'ok 1', 'S4: exactly 100,000 g of silver'),
    ('fine_silver', null, '0', '100000.001', null, 'err 23514', 'S4: more than 100,000 g'),
    ('fine_cash', 'Cash', '1000', '0', '200', 'err 23514', 'D13: a cash fine settlement has grams above 0'),
    -- silver rate
    ('money', 'Cash', '500', '0', '200', 'err 23514', 'D13: a money receipt carries no silver rate'),
    ('refund', 'Cash', '100', '0', '200', 'err 23514', 'D13: nor does a refund'),
    ('fine_silver', null, '0', '5', '200', 'err 23514', 'D13: nor does silver received'),
    ('fine_cash', 'Cash', '1000', '5', null, 'err 23514', 'D13: a cash fine settlement has a silver rate'),
    ('fine_cash', 'Cash', '1000', '5', '0', 'err 23514', 'D13: greater than 0'),
    ('fine_cash', 'Cash', '1000', '5', '100000000', 'ok 1', 'S4: a silver rate of exactly 100,000,000'),
    ('fine_cash', 'Cash', '1000', '5', '100000001', 'err 23514', 'S4: a silver rate above the cap'),
    -- the mode and the amount of the fine kinds
    ('fine_cash', 'UPI', '1000', '5', '200', 'err 23514', 'D13: a cash fine settlement is in Cash'),
    ('fine_cash', null, '1000', '5', '200', 'err 23514', 'D13: and has a mode'),
    ('fine_cash', 'Cash', '0', '5', '200', 'err 23514', 'D13: and an amount above 0 (the amount is money received)'),
    ('fine_silver', 'Cash', '0', '5', null, 'err 23514', 'D13: silver received has no mode'),
    ('fine_silver', 'Other', '0', '5', null, 'err 23514', 'D13: not even Other'),
    ('fine_silver', null, '10', '5', null, 'err 23514', 'D13: and no amount: it is silver, not rupees')
  ) v(kind, mode, amount, grams, rate, expected, what)
  loop
    return next is(
      pg_temp.tryr(format($q$insert into public.receipts (customer_id, kind, mode, amount, fine_grams, silver_rate, paid_on) values (%L, %L, %L, %s, %s, %s, current_date)$q$,
        current_setting('jv.c2'), r.kind, r.mode, r.amount, r.grams, coalesce(r.rate, 'null'))),
      r.expected, case when r.what ~ '^[A-Z][A-Za-z0-9, -]*: ' then r.what else 'D13: ' || r.what end);
  end loop;
end
$f$;
select * from pg_temp.receipt_cases();
select is(pg_temp.q(format($$select status || ' ' || is_opening || ' ' || fine_grams from public.receipts where id = %L$$, current_setting('jv.r2'))), 'active false 0.000',
  'D13: a receipt is active, not an opening advance, and has 0 fine grams unless it is a fine receipt');
select is(pg_temp.tryr(format($$insert into public.receipts (customer_id, kind, mode, amount) values (%L, 'money', 'Cash', 5)$$, current_setting('jv.c2'))), 'err 23502', 'D13: a receipt has a date (paid_on)');
select is(pg_temp.tryr($$insert into public.receipts (customer_id, kind, mode, amount, paid_on) values (gen_random_uuid(), 'money', 'Cash', 5, current_date)$$), 'err 23503', 'D13: the customer must exist');
select is(pg_temp.tryr(format($$insert into public.receipts (customer_id, kind, mode, amount, paid_on, status) values (%L, 'money', 'Cash', 5, current_date, 'deleted')$$, current_setting('jv.c2'))),
  'err 23514', 'D13: the status is active or voided');
-- voided: reason, time and person together; the cash reason; opening advances (D15)
create function pg_temp.receipt_extra(p_cols text, p_vals text) returns text language sql as $f$
  select pg_temp.tryr(format('insert into public.receipts (customer_id, kind, mode, amount, paid_on, %s) values (%L, ''money'', ''Cash'', 5, current_date, %s)',
    p_cols, current_setting('jv.c2'), p_vals))
$f$;
select is(pg_temp.receipt_extra('status', $$'voided'$$), 'err 23514', 'D13: a voided receipt without a reason, a time and a person is refused');
select is(pg_temp.receipt_extra('status, void_reason, voided_at', $$'voided', 'Wrong amount', now()$$), 'err 23514', 'D13: and one without the person');
select is(pg_temp.receipt_extra('status, void_reason, voided_by', format($$'voided', 'Wrong amount', %L$$, current_setting('jv.owner'))), 'err 23514', 'D13: and one without the time');
select is(pg_temp.receipt_extra('status, voided_at, voided_by', format($$'voided', now(), %L$$, current_setting('jv.owner'))), 'err 23514', 'D13: and one without the reason');
select is(pg_temp.receipt_extra('status, void_reason, voided_at, voided_by', format($$'voided', '  ', now(), %L$$, current_setting('jv.owner'))), 'err 23514', 'D13: a blank reason does not count');
select is(pg_temp.receipt_extra('status, void_reason, voided_at, voided_by', format($$'voided', 'Wrong amount', now(), %L$$, current_setting('jv.owner'))), 'ok 1',
  'D13: a voided receipt with its reason, time and person is accepted');
select is(pg_temp.receipt_extra('void_reason', $$'x'$$), 'err 23514', 'D13: an active receipt with a void reason is refused');
select is(pg_temp.receipt_extra('voided_at', 'now()'), 'err 23514', 'D13: and with a void time');
select is(pg_temp.receipt_extra('cash_override_reason', $$'  '$$), 'err 23514', 'Z1: a blank cash override reason is refused');
select is(pg_temp.receipt_extra('cash_override_reason', $$'Customer insisted on paying cash'$$), 'ok 1', 'Z1: a cash override reason is stored on the receipt');
select is(pg_temp.receipt_extra('is_opening, reference', $$true, 'Opening advance'$$), 'err 23514', 'D15: an opening advance in Cash is refused: money is mode Other');
select is(pg_temp.tryr(format($$insert into public.receipts (customer_id, kind, mode, amount, paid_on, is_opening, reference) values (%L, 'money', 'Other', 5, current_date, true, 'Opening advance')$$, current_setting('jv.c2'))),
  'ok 1', 'D15: an opening money advance is kind money with mode Other');
select is(pg_temp.tryr(format($$insert into public.receipts (customer_id, kind, mode, amount, fine_grams, paid_on, is_opening, reference) values (%L, 'fine_silver', null, 0, 5, current_date, true, 'Opening advance')$$, current_setting('jv.c2'))),
  'ok 1', 'D15: an opening silver advance is kind fine_silver with no mode');
select is(pg_temp.tryr(format($$insert into public.receipts (customer_id, kind, mode, amount, paid_on, is_opening) values (%L, 'refund', 'Other', 5, current_date, true)$$, current_setting('jv.c2'))),
  'err 23514', 'D15: a refund is never an opening advance');
select is(pg_temp.tryr(format($$insert into public.receipts (customer_id, kind, mode, amount, fine_grams, silver_rate, paid_on, is_opening) values (%L, 'fine_cash', 'Cash', 100, 1, 100, current_date, true)$$, current_setting('jv.c2'))),
  'err 23514', 'D15: nor is a cash fine settlement');
select is(pg_temp.tryr(format($$delete from public.receipts where id = %L$$, current_setting('jv.r1'))), 'err 23503', 'S7: a receipt that has an allocation cannot be deleted, not even by the database owner');

-- ---------------------------------------------------------------- 7. receipt_allocations (D14, Y4): T-B06
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 100)$$,
  current_setting('jv.r2'), current_setting('jv.b2'), current_setting('jv.c2'))), 'ok 1', 'D14: a receipt is allocated to a bill of the same customer');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 100)$$,
  current_setting('jv.r2'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23503',
  'T-B06, Y4: the receipt of customer B, the bill of customer A, the customer given as A: the receipt key refuses it, even for the table owner');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 100)$$,
  current_setting('jv.r2'), current_setting('jv.b1'), current_setting('jv.c2'))), 'err 23503',
  'T-B06, Y4: the same with the customer given as B: the bill key refuses it');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 100)$$,
  current_setting('jv.r1'), current_setting('jv.b2'), current_setting('jv.c1'))), 'err 23503', 'T-B06: and the other way round, with the customer given as A');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 100)$$,
  current_setting('jv.r1'), current_setting('jv.b2'), current_setting('jv.c2'))), 'err 23503', 'T-B06: and with the customer given as B');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 100)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.walkin'))), 'err 23503', 'T-B06: a third customer (the walk-in) in the denormalised column is refused too');
select is(pg_temp.q(format($$select count(*) from public.receipt_allocations where bill_id = %L and receipt_id = %L$$, current_setting('jv.b1'), current_setting('jv.r2'))), '0',
  'T-B06: no cross-customer allocation exists');
select is(
  (select array_agg(c.conname::text || ' ' || c.confdeltype::text order by c.conname) from pg_constraint c
    where c.conrelid = to_regclass('public.receipt_allocations') and c.contype = 'f'),
  array['receipt_allocations_bill_customer_fkey r', 'receipt_allocations_receipt_customer_fkey r'],
  'D14, Y4, S7: two composite keys, (bill_id, customer_id) and (receipt_id, customer_id), both ON DELETE RESTRICT');
select is(
  (select array_agg(pg_get_constraintdef(c.oid) order by c.conname) from pg_constraint c
    where c.conrelid = to_regclass('public.receipt_allocations') and c.contype = 'f'),
  array['FOREIGN KEY (bill_id, customer_id) REFERENCES bills(id, customer_id) ON DELETE RESTRICT',
        'FOREIGN KEY (receipt_id, customer_id) REFERENCES receipts(id, customer_id) ON DELETE RESTRICT'],
  'D14: and they point at the (id, customer_id) of bills and of receipts');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, -1)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23514', 'D14: a negative amount is refused');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, fine_grams) values (%L, %L, %L, -0.001)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23514', 'D14: negative grams are refused');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount, fine_grams) values (%L, %L, %L, 0, 0)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23514', 'D14: an allocation of nothing (both zero) is refused');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id) values (%L, %L, %L)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23514', 'D14: and so is one that leaves both at their defaults');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, fine_grams) values (%L, %L, %L, 2.5)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'ok 1', 'D14: grams alone are accepted (a fine allocation: its amount is 0)');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount, released_at) values (%L, %L, %L, 1, now())$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'ok 1', 'D14: a released allocation (released_at set when the bill is cancelled) is accepted');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, amount) values (%L, %L, %L, 1000000000.01)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23514', 'S4: an allocated amount above 1,000,000,000 is refused');
select is(pg_temp.tryr(format($$insert into public.receipt_allocations (receipt_id, bill_id, customer_id, fine_grams) values (%L, %L, %L, 100000.001)$$,
  current_setting('jv.r1'), current_setting('jv.b1'), current_setting('jv.c1'))), 'err 23514', 'S4: allocated grams above 100,000 are refused');
select is(pg_temp.tryr(format($$delete from public.receipt_allocations where id = %L$$, current_setting('jv.a1'))), 'ok 1',
  'S7: only the database owner can delete an allocation (the emergency path)');

-- ---------------------------------------------------------------- 8. the keys back to skus and the import batches (D8, D21)
select is(
  (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.skus'::regclass and c.contype = 'f'
      and c.conkey = array[(select attnum from pg_attribute where attrelid = 'public.skus'::regclass and attname = 'sold_bill_id')]),
  'FOREIGN KEY (sold_bill_id) REFERENCES bills(id) ON DELETE RESTRICT', 'D7, D8: skus.sold_bill_id is a foreign key to bills');
select is(pg_temp.tryr(format($$update public.skus set status = 'Sold', sold_bill_id = gen_random_uuid() where id = %L$$, current_setting('jv.p1'))), 'err 23503',
  'T-F02, D8: a Sold piece with the id of a bill that does not exist is refused');
select is(
  (select array_agg(cl.relname::text order by cl.relname) from pg_constraint c join pg_class cl on cl.oid = c.conrelid
    where c.contype = 'f' and cl.relnamespace = 'public'::regnamespace and c.confrelid = 'private.import_batches'::regclass and c.confdeltype = 'r'),
  array['bills', 'customers', 'designs', 'skus'], 'D21, T-C16: designs, skus, customers and bills each have an import_batch_id key to private.import_batches, ON DELETE RESTRICT');
select is(pg_temp.tryr(format($$insert into public.bills (bill_no, customer_id, bill_date, doc_type, sale_type, import_batch_id) values ('FX-IMP', %L, current_date, 'estimate', 'Retail', gen_random_uuid())$$, current_setting('jv.c2'))),
  'err 23503', 'D21: the import batch of a bill must exist');
select is(pg_temp.tryr(format($$insert into public.bills (bill_no, customer_id, bill_date, doc_type, sale_type, import_batch_id) values ('FX-IMP', %L, current_date, 'estimate', 'Retail', %L)$$, current_setting('jv.c2'), current_setting('jv.batch'))),
  'ok 1', 'D21: and an imported bill carries its batch');
select is(pg_temp.tryr(format($$update public.designs set import_batch_id = gen_random_uuid() where id = %L$$, current_setting('jv.d1'))), 'err 23503', 'D21: the import batch of a design must exist');
select is(pg_temp.tryr(format($$update public.designs set import_batch_id = %L where id = %L$$, current_setting('jv.batch'), current_setting('jv.d1'))), 'ok 1', 'D21: and an imported design carries its batch');
select is(pg_temp.tryr(format($$update public.skus set import_batch_id = gen_random_uuid() where id = %L$$, current_setting('jv.p1'))), 'err 23503', 'D21: the import batch of a piece must exist');
select is(pg_temp.tryr(format($$update public.skus set import_batch_id = %L where id = %L$$, current_setting('jv.batch'), current_setting('jv.p1'))), 'ok 1', 'D21: and an imported piece carries its batch');
select is(
  (select coalesce(array_agg(cl.relname || '.' || c.conname order by cl.relname, c.conname), '{}'::text[])
     from pg_constraint c join pg_class cl on cl.oid = c.conrelid
    where c.contype = 'f' and cl.relnamespace = 'public'::regnamespace
      and cl.relname in ('customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations', 'skus', 'designs')
      and not exists (
        select 1 from pg_index i
         where i.indrelid = c.conrelid and i.indisvalid
           and (select array_agg(u.k order by u.o) from unnest(i.indkey::smallint[]) with ordinality as u(k, o) where u.o <= cardinality(c.conkey)) = c.conkey)),
  '{}'::text[], 'T-D11, D19: every foreign key of the money tables, and the new ones on skus and designs, has an index that starts with its columns in the key''s order (lint 0001)');
select is(
  (select array_agg(distinct c.confdeltype::text) from pg_constraint c
    where c.contype = 'f' and c.connamespace = 'public'::regnamespace),
  array['r'], 'T-F02, S7: every foreign key in public is still ON DELETE RESTRICT');

-- ---------------------------------------------------------------- 9. K4: archiving a customer (the trigger), as the database owner
-- Each case builds one customer in one state and tries to archive them. outstanding = active bills - live allocations;
-- advance = active money receipts - live allocations - refunds; and the same in grams (V2).
create function pg_temp.k4_cases() returns setof text language plpgsql as $f$
declare
  c uuid;
  b uuid;
  r record;
  v_no text;
begin
  for r in select * from (values
    ('zero', 'ok 1', 'no bill and no receipt: archived'),
    ('outstanding', 'err P0001', 'an unpaid bill (outstanding) refuses'),
    ('partly paid', 'err P0001', 'a bill paid in part (outstanding 600) refuses'),
    ('advance', 'err P0001', 'money received and not applied (advance) refuses'),
    ('fine outstanding', 'err P0001', 'fine owed on a bill (fine outstanding) refuses'),
    ('fine partly settled', 'err P0001', 'fine settled in part refuses'),
    ('fine advance', 'err P0001', 'silver received and not applied (fine advance) refuses'),
    ('cash fine advance', 'err P0001', 'silver settled in cash and not applied (fine advance) refuses'),
    ('opening dues', 'err P0001', 'an opening-balance bill that is unpaid refuses (Y9)'),
    ('opening advance', 'err P0001', 'an opening advance that is not applied refuses (Y9)'),
    ('released allocation', 'err P0001', 'an allocation that was released no longer counts: the bill is outstanding again'),
    ('paid', 'ok 1', 'a bill paid in full by an allocation: all four are zero, archived'),
    ('fine settled', 'ok 1', 'fine settled in full by an allocation: archived'),
    ('refunded', 'ok 1', 'an advance that was handed back (a refund) is gone: archived'),
    ('cancelled and voided', 'ok 1', 'a cancelled bill and a voided receipt do not count: archived')
  ) v(label, expected, what)
  loop
    begin
      v_no := 'FX-K' || tests.next_n();
      c := pg_temp.mkcust('K4 ' || r.label);
      if r.label = 'outstanding' then
        perform pg_temp.mkbill(c, v_no, 1000);
      elsif r.label = 'partly paid' then
        b := pg_temp.mkbill(c, v_no, 1000);
        perform pg_temp.mkalloc(pg_temp.mkreceipt(c, 'money', 'Cash', 400), b, c, 400);
      elsif r.label = 'advance' then
        perform pg_temp.mkreceipt(c, 'money', 'Cash', 500);
      elsif r.label = 'fine outstanding' then
        perform pg_temp.mkbill(c, v_no, 0, '{"fine_weight_due": 5}');
      elsif r.label = 'fine partly settled' then
        b := pg_temp.mkbill(c, v_no, 0, '{"fine_weight_due": 5}');
        perform pg_temp.mkalloc(pg_temp.mkreceipt(c, 'fine_silver', null, 0, 3), b, c, 0, 3);
      elsif r.label = 'fine advance' then
        perform pg_temp.mkreceipt(c, 'fine_silver', null, 0, 5);
      elsif r.label = 'cash fine advance' then
        perform pg_temp.mkreceipt(c, 'fine_cash', 'Cash', 1000, 5, 200);
      elsif r.label = 'opening dues' then
        perform pg_temp.mkbill(c, 'OB-' || v_no, 700, '{"doc_type": "opening_balance"}');
      elsif r.label = 'opening advance' then
        perform pg_temp.mkreceipt(c, 'money', 'Other', 300, 0, null, '{"is_opening": true, "reference": "Opening advance"}');
      elsif r.label = 'released allocation' then
        b := pg_temp.mkbill(c, v_no, 1000);
        perform pg_temp.mkalloc(pg_temp.mkreceipt(c, 'money', 'Cash', 1000), b, c, 1000, 0, '{"released_at": "2026-10-01T00:00:00+00"}');
      elsif r.label = 'paid' then
        b := pg_temp.mkbill(c, v_no, 1000);
        perform pg_temp.mkalloc(pg_temp.mkreceipt(c, 'money', 'Cash', 1000), b, c, 1000);
      elsif r.label = 'fine settled' then
        b := pg_temp.mkbill(c, v_no, 0, '{"fine_weight_due": 5}');
        perform pg_temp.mkalloc(pg_temp.mkreceipt(c, 'fine_silver', null, 0, 5), b, c, 0, 5);
      elsif r.label = 'refunded' then
        perform pg_temp.mkreceipt(c, 'money', 'Cash', 1000);
        perform pg_temp.mkreceipt(c, 'refund', 'Cash', 1000);
      elsif r.label = 'cancelled and voided' then
        perform pg_temp.mkbill(c, v_no, 1000, jsonb_build_object('status', 'cancelled', 'cancel_reason', 'Returned', 'cancelled_at', now()::text, 'cancelled_by', current_setting('jv.owner')));
        perform pg_temp.mkreceipt(c, 'money', 'Cash', 1000, 0, null, jsonb_build_object('status', 'voided', 'void_reason', 'Wrong', 'voided_at', now()::text, 'voided_by', current_setting('jv.owner')));
      end if;
      return next is(pg_temp.try(format($q$update public.customers set archived_at = now() where id = %L$q$, c)), r.expected, 'T-C02, K4: ' || r.what);
    exception when others then
      return next fail('T-C02, K4: ' || r.what || ' (fixture failed: ' || sqlerrm || ')');
    end;
  end loop;
end
$f$;
select * from pg_temp.k4_cases();
select throws_like(
  format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.c1')),
  'JV_NOT_ALLOWED:%', 'T-C02, K4: the refusal carries the stable code JV_NOT_ALLOWED');
select is(pg_temp.q(format($$select (archived_at is null)::text from public.customers where id = %L$$, current_setting('jv.c1'))), 'true', 'K4: and the customer is not archived');
select throws_like(
  format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.walkin')),
  'JV_NOT_ALLOWED:%', 'K5, T-B17: the walk-in can never be archived, the trigger says so in words');
select pg_temp.fx($q$alter table public.customers disable trigger user$q$);
select is(pg_temp.tryr(format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.walkin'))), 'err 23514',
  'K5: and the check on the row refuses it too, were the trigger gone');
select pg_temp.fx($q$alter table public.customers enable trigger user$q$);
select is(pg_temp.try(format($$update public.customers set archived_at = null where id = %L$$, current_setting('jv.c_arch2'))), 'ok 1', 'K4: a customer can be brought back (archived_at set to null)');
select pg_temp.fx(format($q$update public.customers set archived_at = now() where id = %L$q$, current_setting('jv.c_arch2')));

-- ---------------------------------------------------------------- 10. what the API roles may touch (A3 step 4, A4, A5, S7, K1)
-- the catalogue
select is(
  (select array_agg(t order by t) from unnest(array['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations']) t
    where has_table_privilege('anon', to_regclass('public.' || t), 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
       or has_any_column_privilege('anon', to_regclass('public.' || t), 'SELECT, INSERT, UPDATE, REFERENCES')),
  null, 'T-D02, A4: anon has no right of any kind on the five tables');
select is(
  (select array_agg(c.relname::text order by c.relname) from pg_class c
    where c.relnamespace in ('public'::regnamespace, 'private'::regnamespace) and c.relkind in ('r', 'p', 'v', 'm', 'f')
      and (has_table_privilege('anon', c.oid, 'DELETE') or has_table_privilege('authenticated', c.oid, 'DELETE'))),
  null, 'T-D07, S7: no API role has DELETE on any table, view or foreign table of public or private');
select is(
  (select array_agg(t order by t) from unnest(array['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations']) t
    where has_table_privilege('authenticated', to_regclass('public.' || t), 'DELETE, TRUNCATE, REFERENCES, TRIGGER')),
  null, 'T-D07: authenticated has no delete, truncate, references or trigger right on the five tables');
select is(
  (select array_agg(t order by t) from unnest(array['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations']) t
    where not has_table_privilege('authenticated', to_regclass('public.' || t), 'SELECT')),
  null, 'A4: authenticated can select from all five (the row rules decide who sees what)');
select is(
  (select array_agg(t order by t) from unnest(array['bills', 'bill_items', 'receipts', 'receipt_allocations']) t
    where has_table_privilege('authenticated', to_regclass('public.' || t), 'INSERT, UPDATE')
       or has_any_column_privilege('authenticated', to_regclass('public.' || t), 'INSERT, UPDATE')),
  null, 'T-D08, A4, K1: authenticated has no insert or update right, table or column, on bills, bill_items, receipts and receipt_allocations');
select is(pg_temp.col_privs('authenticated', 'customers', 'INSERT'), '{}'::text[], 'A4: nobody can insert into customers through the API: create_customer (X6) and the import do');
select is(pg_temp.col_privs('authenticated', 'customers', 'UPDATE'),
  array['address', 'archived_at', 'customer_type', 'email', 'gst_number', 'mobile', 'name', 'notes', 'pan'],
  'T-D19, A5: the columns of a customer that can be updated: the eight content columns and archived_at, nothing else');
select is(pg_temp.q($$select has_table_privilege('authenticated', 'public.customers', 'UPDATE')::text$$), 'false', 'A5: no table-wide update right on customers: every write right is a column right');
select is(
  (select array_agg(c.relname || '.' || p.polname || ':' || p.polcmd::text order by c.relname, p.polname)
     from pg_policy p join pg_class c on c.oid = p.polrelid
    where c.relnamespace = 'public'::regnamespace and c.relname in ('customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations')),
  array['bill_items.bill_items_select:r', 'bills.bills_select:r', 'customers.customers_select:r', 'customers.customers_update:w',
        'receipt_allocations.receipt_allocations_select:r', 'receipts.receipts_select:r'],
  'A7, lint 0006: one policy per command; the four money tables are read-only, customers can be read and updated, and nobody has an insert or delete policy');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'private' and p.proname = 'guard_customer_update' and has_function_privilege('authenticated', p.oid, 'EXECUTE')),
  0, 'A3, T-D16: the guard trigger function is not callable by the API roles');
select is(
  (select count(*)::int from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'private' and p.proname = 'guard_customer_update'),
  1, 'K4: the guard trigger function exists');

-- the live attempts: the same statements for every role on every table
create function pg_temp.write_attempts(p_label text) returns setof text language plpgsql as $f$
declare
  t text;
begin
  foreach t in array array['bills', 'bill_items', 'receipts', 'receipt_allocations'] loop
    return next is(pg_temp.try(format('insert into public.%I default values', t)), 'err 42501', 'T-D08, K1: ' || p_label || ' cannot insert into ' || t);
    return next is(pg_temp.try(format('update public.%I set created_at = created_at', t)), 'err 42501', 'T-D08, K1: ' || p_label || ' cannot update ' || t);
    return next is(pg_temp.try(format('delete from public.%I', t)), 'err 42501', 'T-D07, S7: ' || p_label || ' cannot delete from ' || t);
  end loop;
  return next is(pg_temp.try('insert into public.customers default values'), 'err 42501', 'A4: ' || p_label || ' cannot insert into customers');
  return next is(pg_temp.try('delete from public.customers'), 'err 42501', 'T-C02, T-D07, S7: ' || p_label || ' cannot delete a customer');
  return next is(pg_temp.try('update public.customers set is_walkin = true'), 'err 42501', 'A5: ' || p_label || ' cannot change is_walkin');
  return next is(pg_temp.try('update public.customers set import_batch_id = null'), 'err 42501', 'T-D19: ' || p_label || ' cannot change import_batch_id');
  return next is(pg_temp.try('update public.customers set created_at = now()'), 'err 42501', 'T-D19: ' || p_label || ' cannot change created_at');
  return next is(pg_temp.try('update public.customers set updated_by = gen_random_uuid()'), 'err 42501', 'T-D22: ' || p_label || ' cannot set updated_by');
  return next is(pg_temp.try('update public.customers set id = gen_random_uuid()'), 'err 42501', 'S2: ' || p_label || ' cannot change a customer''s id');
end
$f$;
grant execute on function pg_temp.write_attempts(text) to public;
select pg_temp.record_counts();
select tests.as_anon();
select * from pg_temp.write_attempts('anon');
select tests.as_user(current_setting('jv.owner')::uuid);
select * from pg_temp.write_attempts('the owner');
select tests.as_user(current_setting('jv.biller')::uuid);
select * from pg_temp.write_attempts('a biller');
select tests.as_user(current_setting('jv.staff')::uuid);
select * from pg_temp.write_attempts('staff');
select tests.reset_role();
-- nothing changed
select is(pg_temp.q(format($$select grand_total::text from public.bills where id = %L$$, current_setting('jv.b1'))), '1000.00', 'T-D08: and the bill is as it was');
select is(pg_temp.q($$select count(*) from public.bills$$), current_setting('jv.n_bills'), 'T-D08: and no bill was added or removed');
select is(pg_temp.q($$select count(*) from public.customers$$), current_setting('jv.n_customers'), 'T-C02: and no customer was added or removed');

-- ---------------------------------------------------------------- 11. anon: nothing (A4)
select tests.as_anon();
select is(pg_temp.cnt('customers'), 'err 42501', 'A4: anon cannot read customers');
select is(pg_temp.cnt('bills'), 'err 42501', 'A4: anon cannot read bills');
select is(pg_temp.cnt('bill_items'), 'err 42501', 'A4: anon cannot read bill_items');
select is(pg_temp.cnt('receipts'), 'err 42501', 'A4: anon cannot read receipts');
select is(pg_temp.cnt('receipt_allocations'), 'err 42501', 'A4: anon cannot read receipt_allocations');
select tests.reset_role();

-- ---------------------------------------------------------------- 12. a login that is not active, or has no profile, reads nothing (A10)
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.cnt('customers') || ' ' || pg_temp.cnt('bills') || ' ' || pg_temp.cnt('bill_items') || ' ' || pg_temp.cnt('receipts') || ' ' || pg_temp.cnt('receipt_allocations'),
  '0 0 0 0 0', 'A10: an inactive profile reads no customer, bill, line, receipt or allocation');
select is(pg_temp.try(format($$update public.customers set name = 'x' where id = %L$$, current_setting('jv.c1'))), 'ok 0', 'A10: nor edits a customer');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.cnt('customers') || ' ' || pg_temp.cnt('bills') || ' ' || pg_temp.cnt('bill_items') || ' ' || pg_temp.cnt('receipts') || ' ' || pg_temp.cnt('receipt_allocations'),
  '0 0 0 0 0', 'A10: a login with no profile reads none of them');
select is(pg_temp.try(format($$update public.customers set name = 'x' where id = %L$$, current_setting('jv.c1'))), 'ok 0', 'A10: nor edits a customer');
select tests.reset_role();

-- ---------------------------------------------------------------- 13. the reads: owner and biller see every row, archived ones too; staff see nothing (A4, T-D03)
create function pg_temp.read_checks(p_label text, p_sees boolean) returns setof text language plpgsql as $f$
declare
  t text;
begin
  foreach t in array array['customers', 'bills', 'bill_items', 'receipts', 'receipt_allocations'] loop
    return next is(pg_temp.cnt(t), case when p_sees then current_setting('jv.n_' || t) else '0' end,
      case when p_sees then 'A4, A9: ' || p_label || ' reads every row of ' || t else 'T-D03, A4: ' || p_label || ' reads no row of ' || t || ', though rows exist' end);
  end loop;
  return next is(pg_temp.cnt('customers', format('id = %L', current_setting('jv.c_arch2'))), case when p_sees then '1' else '0' end,
    'T-D19, A4: ' || p_label || case when p_sees then ' can read an archived customer' else ' cannot read an archived customer' end);
  return next is(pg_temp.cnt('bills', format('id = %L', current_setting('jv.b3'))), case when p_sees then '1' else '0' end,
    'A4: ' || p_label || case when p_sees then ' can read a cancelled bill' else ' cannot read a cancelled bill' end);
  return next is(pg_temp.cnt('receipts', format('id = %L', current_setting('jv.r3'))), case when p_sees then '1' else '0' end,
    'A4: ' || p_label || case when p_sees then ' can read a voided receipt' else ' cannot read a voided receipt' end);
end
$f$;
grant execute on function pg_temp.read_checks(text, boolean) to public;
select pg_temp.record_counts();
select tests.as_user(current_setting('jv.owner')::uuid);
select * from pg_temp.read_checks('the owner', true);
select tests.as_user(current_setting('jv.biller')::uuid);
select * from pg_temp.read_checks('a biller', true);
select tests.as_user(current_setting('jv.staff')::uuid);
select * from pg_temp.read_checks('staff', false);
select tests.reset_role();

-- ---------------------------------------------------------------- 14. customers: who edits what (A4, A5, K4)
-- two fresh customers with no balance, for the biller and the owner to work on
select pg_temp.fx($q$select set_config('jv.cx', pg_temp.mkcust('Editable')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.cy', pg_temp.mkcust('Editable two')::text, true)$q$);
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$update public.customers set name = 'Renamed by biller' where id = %L$$, current_setting('jv.cx'))), 'ok 1',
  'A4, A5, done-when: a biller can edit a customer''s name');
select is(pg_temp.try(format($$update public.customers set name = 'B2', mobile = '9123456780', customer_type = 'Wholesale', email = 'a@b.in', address = 'Addr', gst_number = '24ABCDE1234F1Z5', pan = 'ABCDE1234F', notes = 'n' where id = %L$$, current_setting('jv.cx'))), 'ok 1',
  'A5: and all eight content columns');
select is(pg_temp.try(format($$update public.customers set mobile = '12345' where id = %L$$, current_setting('jv.cx'))), 'err 23514', 'D10: but not to a mobile number that is wrong');
select is(pg_temp.try(format($$update public.customers set pan = 'abcde1234f' where id = %L$$, current_setting('jv.cx'))), 'err 23514', 'D10, Z3: nor to a PAN that is wrong');
select is(pg_temp.try(format($$update public.customers set name = '' where id = %L$$, current_setting('jv.cx'))), 'err 23514', 'D10: nor to a blank name');
select throws_like(
  format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.cx')),
  'JV_FORBIDDEN:%', 'A5, done-when, T-C02: a biller cannot archive a customer, even one with no balance');
select is(pg_temp.try(format($$update public.customers set name = 'B2', archived_at = archived_at where id = %L$$, current_setting('jv.cx'))), 'ok 1',
  'A5: sending the archived_at it already has is not a change');
select throws_like(
  format($$update public.customers set archived_at = null where id = %L$$, current_setting('jv.c_arch2')),
  'JV_FORBIDDEN:%', 'A5: nor bring an archived customer back');
select is(pg_temp.try(format($$update public.customers set pan = 'ABCDE1234F' where id = %L$$, current_setting('jv.walkin'))), 'err 23514', 'K5: a biller cannot give the walk-in a PAN');
select is(pg_temp.try(format($$update public.customers set name = 'Renamed archived' where id = %L$$, current_setting('jv.c_arch2'))), 'ok 1',
  'A4: a biller can still edit an archived customer''s details (the update reads the row, so the select policy shows archived rows)');
select tests.reset_role();
select is(pg_temp.q(format($$select (archived_at is null)::text from public.customers where id = %L$$, current_setting('jv.cx'))), 'true', 'A5: and the customer is not archived');
select is(pg_temp.q(format($$select updated_by from public.customers where id = %L$$, current_setting('jv.cx'))), current_setting('jv.biller'),
  'T-D22: updated_by is the biller who edited');
select is(pg_temp.q(format($$select created_by from public.customers where id = %L$$, current_setting('jv.cx'))), null, 'T-D22: created_by is null for a row made by the database owner (an import)');
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$update public.customers set name = 'Renamed by owner', pan = 'ABCDE1234F' where id = %L$$, current_setting('jv.cy'))), 'ok 1', 'A4: the owner edits the content columns');
select is(pg_temp.try(format($$update public.customers set updated_by = %L where id = %L$$, current_setting('jv.biller'), current_setting('jv.cy'))), 'err 42501', 'T-D22: and cannot name somebody else in updated_by');
select is(pg_temp.try(format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.cy'))), 'ok 1', 'A4, K4: the owner archives a customer whose balance is zero');
select is(pg_temp.q(format($$select (archived_at is not null)::text from public.customers where id = %L$$, current_setting('jv.cy'))), 'true', 'K4: and the customer is archived');
select is(pg_temp.try(format($$update public.customers set archived_at = null where id = %L$$, current_setting('jv.cy'))), 'ok 1', 'A5: and brings them back');
select throws_like(
  format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.c1')),
  'JV_NOT_ALLOWED:%', 'T-C02, K4: the owner cannot archive a customer who owes money (c1 has an unpaid bill)');
select throws_like(
  format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.walkin')),
  'JV_NOT_ALLOWED:%', 'K5, T-B17: nor the walk-in');
select is(pg_temp.try(format($$update public.customers set pan = 'ABCDE1234F' where id = %L$$, current_setting('jv.walkin'))), 'err 23514', 'K5, T-B17: the owner cannot give the walk-in a PAN either');
select is(pg_temp.try(format($$update public.customers set mobile = '98 76' where id = %L$$, current_setting('jv.walkin'))), 'err 23514', 'D10: a walk-in that has a mobile number must have a valid one');
select is(pg_temp.try(format($$delete from public.customers where id = %L$$, current_setting('jv.cy'))), 'err 42501', 'T-C02, S7: and nobody deletes a customer, the owner included');
select tests.reset_role();
-- staff can reach no customer
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$update public.customers set name = 'Staff' where id = %L$$, current_setting('jv.cx'))), 'ok 0', 'A4: staff cannot edit a customer: the update touches no row');
select is(pg_temp.try(format($$update public.customers set archived_at = now() where id = %L$$, current_setting('jv.cx'))), 'ok 0', 'A4: nor archive one');
select tests.reset_role();
select is(pg_temp.q(format($$select name from public.customers where id = %L$$, current_setting('jv.cx'))), 'B2', 'A4: and the customer is as the biller left it');

-- ---------------------------------------------------------------- 15. S6: the stamps, with the clock fixed
select tests.set_clock('2031-01-02 03:04:05+00');
select pg_temp.fx($q$select set_config('jv.cz', pg_temp.mkcust('Clock')::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.bz', pg_temp.mkbill(current_setting('jv.cz')::uuid, 'FX-CLK', 10)::text, true)$q$);
select pg_temp.fx($q$select set_config('jv.rz', pg_temp.mkreceipt(current_setting('jv.cz')::uuid, 'money', 'Cash', 10)::text, true)$q$);
select pg_temp.fx($q$select pg_temp.mkalloc(current_setting('jv.rz')::uuid, current_setting('jv.bz')::uuid, current_setting('jv.cz')::uuid, 10)$q$);
select pg_temp.fx($q$select pg_temp.mkline(current_setting('jv.bz')::uuid, current_setting('jv.p2')::uuid, 1)$q$);
select is(pg_temp.q(format($$select (created_at = '2031-01-02 03:04:05+00'::timestamptz and updated_at = '2031-01-02 03:04:05+00'::timestamptz)::text from public.customers where id = %L$$, current_setting('jv.cz'))), 'true',
  'S5, S6: with the clock fixed a new customer is stamped by it');
select is(pg_temp.q(format($$select (created_at = '2031-01-02 03:04:05+00'::timestamptz and updated_at = '2031-01-02 03:04:05+00'::timestamptz)::text from public.bills where id = %L$$, current_setting('jv.bz'))), 'true',
  'S5, S6: so is a bill');
select is(pg_temp.q(format($$select (created_at = '2031-01-02 03:04:05+00'::timestamptz)::text from public.receipts where id = %L$$, current_setting('jv.rz'))), 'true', 'S5, S6: a receipt');
select is(pg_temp.q(format($$select (created_at = '2031-01-02 03:04:05+00'::timestamptz)::text from public.receipt_allocations where receipt_id = %L$$, current_setting('jv.rz'))), 'true', 'S5, S6: an allocation');
select is(pg_temp.q(format($$select (created_at = '2031-01-02 03:04:05+00'::timestamptz)::text from public.bill_items where bill_id = %L$$, current_setting('jv.bz'))), 'true', 'S5, S6: and a bill line');

select * from finish();
rollback;
