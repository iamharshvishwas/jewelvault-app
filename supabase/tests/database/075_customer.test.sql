-- T-F06 (create_customer, the walk-in, the mobile and PAN rules, the seeds) and the part of T-D09 that X6 completes.
-- DB09a, migration 0016.
--
-- Spec lines: X0 (items 1, 2, 3, 7, 8), X6, A6, D5, D10, D20, K5, L5, S8. Everything runs in this transaction and is rolled back.
--
-- What is proved here:
--   * the three helpers every writing function calls (X0): private.begin_write (the idempotency insert first, then the role
--     check), private.lock_customer (the customer row FOR UPDATE, read back) and the empty private.test_pause(p_point), and
--     that they are reachable by the database owner only (A3, T-D16);
--   * T-D09, the part of the matrix that X6 completes: anon cannot run public.create_customer, staff and a login that is not
--     active or has no profile get JV_FORBIDDEN, a biller and the owner can;
--   * X6: the customer is returned as {"customer": <the row>}, the walk-in is never made, the inputs are refused with a
--     JV_INVALID_INPUT and never with a raw CHECK error (name, the mobile rule of D10 with every case of T-F06, the customer type,
--     the PAN format of Z3); L5: a repeated request id returns the stored answer, the same id with other arguments, by another
--     caller or after another function is refused, a failed request leaves nothing behind;
--   * T-F06: category and subcategory names are unique ignoring case; exactly one walk-in exists (fixed id, no mobile, no PAN,
--     never archived); a blank mobile is accepted only with an import_batch_id; a bad PAN is refused; the seeds hold no sample data.
--
-- The JV_BUSY branch of X0 item 7 needs two sessions (a lock wait cannot be made inside one), so it is not here: the writing
-- functions of DB09b onward are proved with tests/db and the hook (DB18a). The helpers in pg_temp catch an error and report it,
-- so a function that does not exist yet makes the assertions fail one by one instead of stopping the file.
begin;
select plan(184);

-- ---------------------------------------------------------------- helpers
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

create function pg_temp.fx(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when others then
  raise notice 'fixture failed: % (%) in: %', sqlerrm, sqlstate, left(p_sql, 100);
end
$f$;

-- 'ok <rows>' or 'err <sqlstate>'; the statement is undone either way (a table of cases cannot disturb itself).
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

-- A call as one of the logins of this file (owner, biller, staff, inactive, none), as anon, or as the database owner ('db').
-- The result or the error is kept in the table r under a label. The role switch is made inside the block, so an error puts the
-- caller back to where it was (a failed statement and its role change are undone together).
create temp table r (label text primary key, ok boolean not null, result jsonb, state text, msg text);
create function pg_temp.run(p_label text, p_who text, p_sql text) returns void language plpgsql as $f$
declare
  v jsonb;
begin
  begin
    if p_who = 'anon' then
      perform tests.as_anon();
    elsif p_who <> 'db' then
      perform tests.as_user(current_setting('jv.' || p_who)::uuid);
    end if;
    execute p_sql into v;
    perform tests.reset_role();
    insert into r values (p_label, true, v, null, null);
  exception when others then
    perform tests.reset_role();
    insert into r values (p_label, false, null, sqlstate, sqlerrm);
  end;
end
$f$;

-- Readers of r. A call that failed has no answer and a call that worked has no error, so an assertion about the answer of a call
-- that did not work sees a null and fails (a missing function must not make an assertion pass by comparing nothing with nothing).
create function pg_temp.res(p_label text) returns jsonb language sql as $f$
  select result from r where label = p_label and ok
$f$;
create function pg_temp.okk(p_label text) returns boolean language sql as $f$
  select ok from r where label = p_label
$f$;
create function pg_temp.errstate(p_label text) returns text language sql as $f$
  select state from r where label = p_label and not ok
$f$;
create function pg_temp.err(p_label text) returns text language sql as $f$
  select state || ' ' || split_part(msg, ':', 1) from r where label = p_label and not ok
$f$;
create function pg_temp.errcode(p_label text) returns text language sql as $f$
  select split_part(msg, ':', 1) from r where label = p_label and not ok
$f$;

create function pg_temp.cust(p_label text) returns jsonb language sql as $f$
  select result -> 'customer' from r where label = p_label and ok
$f$;
create function pg_temp.cid(p_label text) returns uuid language sql as $f$
  select (result -> 'customer' ->> 'id')::uuid from r where label = p_label and ok
$f$;

create function pg_temp.rid(p_n integer) returns uuid language sql immutable as $f$
  select ('75000000-0000-4000-8000-' || lpad(p_n::text, 12, '0'))::uuid
$f$;

-- create_customer(request, name, mobile, type, email, address, gst number, pan, notes) as one of the logins, result kept under p_label.
create function pg_temp.cc(
  p_label text, p_who text, p_req uuid, p_name text, p_mobile text, p_type text default 'Retail',
  p_email text default null, p_address text default null, p_gst text default null, p_pan text default null, p_notes text default null
) returns void language sql as $f$
  select pg_temp.run(p_label, p_who, format(
    'select public.create_customer(%L::uuid, %L, %L, %L, %L, %L, %L, %L, %L)',
    p_req, p_name, p_mobile, p_type, p_email, p_address, p_gst, p_pan, p_notes))
$f$;

-- One attempt as the biller on its own request id, undone: 'ok', the JV_ code, or 'err <sqlstate>' for an error that is not a JV_ one.
create function pg_temp.cc_try(
  p_name text, p_mobile text, p_type text default 'Retail', p_pan text default null
) returns text language plpgsql as $f$
declare
  v_res text;
begin
  begin
    perform tests.as_user(current_setting('jv.biller')::uuid);
    perform public.create_customer(gen_random_uuid(), p_name, p_mobile, p_type, null, null, null, p_pan, null);
    v_res := 'ok';
    raise exception 'undo' using errcode = 'JVRB0';
  exception
    when sqlstate 'JVRB0' then null;
    when others then v_res := case when sqlerrm like 'JV\_%' then split_part(sqlerrm, ':', 1) else 'err ' || sqlstate end;
  end;
  perform tests.reset_role();
  return v_res;
end
$f$;

-- The helpers of the prologue are reachable by the database owner only, so the test reaches them through definer wrappers that
-- keep the signed-in user (auth.uid() reads the claims, not the role).
create function pg_temp.bw(p_req uuid, p_fn text, p_args jsonb, p_roles text[]) returns jsonb
language plpgsql security definer set search_path = '' as $f$
begin
  return private.begin_write(p_req, p_fn, p_args, p_roles);
end
$f$;
create function pg_temp.lc(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $f$
begin
  return to_jsonb(private.lock_customer(p_id));
end
$f$;
grant execute on function pg_temp.q(text), pg_temp.fx(text), pg_temp.tryr(text), pg_temp.rid(integer), pg_temp.bw(uuid, text, jsonb, text[]),
  pg_temp.lc(uuid) to public;

-- A setting a later statement reads starts as a value that matches nothing, so a fixture that failed to build makes one assertion
-- fail and does not stop the file with 'unrecognized configuration parameter'.
do $init$
begin
  perform set_config('jv.' || k, '00000000-0000-0000-0000-000000000000', true)
    from unnest(array['owner', 'biller', 'staff', 'inactive', 'none', 'batch', 'walkin_seen', 'cat_ring', 'cat_new']) k;
end
$init$;

-- ---------------------------------------------------------------- 1. the functions exist and are locked down (A6, A3, T-D09, T-D10, T-D16)
select has_function('public', 'create_customer', array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'],
  'X6: public.create_customer(request id, name, mobile, type, email, address, GST number, PAN, notes) exists');
select function_returns('public', 'create_customer', array['uuid', 'text', 'text', 'text', 'text', 'text', 'text', 'text', 'text'], 'jsonb',
  'C5(b): it returns jsonb');
select is((select pg_get_function_arguments(p.oid) from pg_proc p where p.oid = to_regprocedure('public.create_customer(uuid,text,text,text,text,text,text,text,text)')),
  'p_request_id uuid, p_name text, p_mobile text, p_customer_type text DEFAULT ''Retail''::text, p_email text DEFAULT NULL::text, p_address text DEFAULT NULL::text, p_gst_number text DEFAULT NULL::text, p_pan text DEFAULT NULL::text, p_notes text DEFAULT NULL::text',
  'X6: the final signature: only the request id, the name and the mobile are required');
select is((select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.create_customer(uuid,text,text,text,text,text,text,text,text)')),
  true, 'A6: create_customer is security definer');
select ok('search_path=""' = any (coalesce((select p.proconfig from pg_proc p where p.oid = to_regprocedure('public.create_customer(uuid,text,text,text,text,text,text,text,text)')), '{}'::text[])),
  'A6, T-D10: ... with search_path = ''''');
select ok('lock_timeout=5s' = any (coalesce((select p.proconfig from pg_proc p where p.oid = to_regprocedure('public.create_customer(uuid,text,text,text,text,text,text,text,text)')), '{}'::text[])),
  'X0 item 7: ... and SET lock_timeout = ''5s'' as a clause of the function, so the limit also covers the idempotency insert');
select is(pg_temp.q($$select has_function_privilege('anon', 'public.create_customer(uuid,text,text,text,text,text,text,text,text)', 'EXECUTE')::text$$), 'false',
  'A6, T-D09: anon cannot execute create_customer');
select is(pg_temp.q($$select has_function_privilege('public', 'public.create_customer(uuid,text,text,text,text,text,text,text,text)', 'EXECUTE')::text$$), 'false',
  'A6: PUBLIC cannot either');
select is(pg_temp.q($$select has_function_privilege('authenticated', 'public.create_customer(uuid,text,text,text,text,text,text,text,text)', 'EXECUTE')::text$$), 'true',
  'A6: a signed-in user can (the role check is inside)');
select ok(coalesce(obj_description(to_regprocedure('public.create_customer(uuid,text,text,text,text,text,text,text,text)'), 'pg_proc'), '') ~* '0029',
  'A7, X13: the comment records that advisor lint 0029 is intentional');

select has_function('private', 'begin_write', array['uuid', 'text', 'jsonb', 'text[]'], 'X0: private.begin_write(request id, function name, arguments, roles) exists');
select function_returns('private', 'begin_write', array['uuid', 'text', 'jsonb', 'text[]'], 'jsonb', 'X0: it returns the stored result of a repeat, else null');
select has_function('private', 'lock_customer', array['uuid'], 'X0 item 3: private.lock_customer(customer id) exists');
select function_returns('private', 'lock_customer', array['uuid'], 'customers', 'X0 item 3: it returns the locked customer row');
select has_function('private', 'test_pause', array['text'], 'X0 item 8: private.test_pause(text) exists');
select function_returns('private', 'test_pause', array['text'], 'void', 'X0 item 8: it returns void');
select is((select pg_get_function_arguments(p.oid) from pg_proc p where p.oid = to_regprocedure('private.test_pause(text)')), 'p_point text',
  'X0 item 8: the parameter is called p_point (the test hook copies the name: create or replace cannot rename a parameter)');
select is(
  (select count(*)::int from unnest(array['private.begin_write(uuid,text,jsonb,text[])', 'private.lock_customer(uuid)', 'private.test_pause(text)']) f
    where to_regprocedure(f) is null
       or has_function_privilege('anon', to_regprocedure(f), 'EXECUTE')
       or has_function_privilege('authenticated', to_regprocedure(f), 'EXECUTE')
       or has_function_privilege('public', to_regprocedure(f), 'EXECUTE')),
  0, 'A3, T-D16: the three helpers exist and nobody but the database owner (and the definer functions it owns) can run them');
select ok(
  (select p.prosrc !~* 'advisory' and p.prosrc !~ 'jv-test-hook' and p.prosrc !~* 'sleep' from pg_proc p where p.oid = to_regprocedure('private.test_pause(text)')),
  'X0 item 8: in production the hook is empty (no advisory lock, no wait, no test replacement left behind)');
select is(pg_temp.q($$select private.test_pause('create_customer.after_read')::text$$), '', 'X0 item 8: calling the hook does nothing');
select ok(
  (select count(*) = 3 and bool_and(p.proconfig @> array['search_path=""'])
     from pg_proc p where p.oid in (to_regprocedure('private.begin_write(uuid,text,jsonb,text[])'), to_regprocedure('private.lock_customer(uuid)'), to_regprocedure('private.test_pause(text)'))),
  'lint 0011: the three helpers pin their search_path');
select ok(
  (select p.prosrc ~* 'for update' from pg_proc p where p.oid = to_regprocedure('private.lock_customer(uuid)')),
  'X0 item 3: the customer lock is a FOR UPDATE that DB18a''s negative control can find and cut out');
select ok(
  (select p.prosrc ~* 'idem_begin' and p.prosrc ~* 'app_role' and position('idem_begin' in lower(p.prosrc)) < position('app_role' in lower(p.prosrc))
     from pg_proc p where p.oid = to_regprocedure('private.begin_write(uuid,text,jsonb,text[])')),
  'X0 items 1 and 2: begin_write inserts the idempotency row first and checks the role second');

-- ---------------------------------------------------------------- 2. T-F06 first half: the walk-in, the categories and the seeds (nothing else made yet)
select is((select count(*)::int from public.customers where is_walkin), 1, 'T-F06, D10: exactly one walk-in customer exists');
select is((select id::text from public.customers where is_walkin), '00000000-0000-4000-8000-000000000001', 'K5: its id is the fixed one');
select is((select name || '|' || coalesce(mobile, 'null') || '|' || customer_type || '|' || coalesce(pan, 'null') || '|' || (archived_at is null)::text
             from public.customers where is_walkin),
  'Walk-in Customer|null|Retail|null|true', 'K5, D10: named Walk-in Customer, no mobile, Retail, no PAN, not archived');
select is((select count(*)::int from public.customers), 1, 'T-F06, D20: the walk-in is the only customer: no sample customer is seeded');
select is(
  (select (select count(*) from public.designs) || ' ' || (select count(*) from public.skus) || ' ' || (select count(*) from public.sku_private)
       || ' ' || (select count(*) from public.bills) || ' ' || (select count(*) from public.bill_items) || ' ' || (select count(*) from public.receipts)
       || ' ' || (select count(*) from public.receipt_allocations) || ' ' || (select count(*) from public.daily_rates)),
  '0 0 0 0 0 0 0 0', 'T-F06, D20: the seeds hold no design, piece, bill, line, receipt, allocation or rate (no sample data)');
select is((select count(*)::int from public.categories), 15, 'D5, D20: the 15 categories are seeded');
select is((select count(*)::int from public.subcategories), 60, 'D5, D20: ... with four subcategories each');
select is((select count(*)::int from public.categories where prefix !~ '^[A-Z0-9]{2,6}$'), 0, 'D5: every seeded prefix is 2 to 6 capitals or digits');
select is((select count(*)::int from public.settings), 9, 'D3, D20: the nine settings keys are seeded and nothing else');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, is_walkin) values ('Second walk-in', null, true)$$), 'err 23505',
  'T-F06, K5: a second walk-in is refused (a unique partial index)');
-- category and subcategory names are unique ignoring case
select is(pg_temp.tryr($$insert into public.categories (name, prefix) values ('RING', 'ZR1')$$), 'err 23505', 'T-F06, D5: a category name is unique ignoring case (RING against Ring)');
select is(pg_temp.tryr($$insert into public.categories (name, prefix) values ('nose pin', 'ZR2')$$), 'err 23505', 'T-F06, D5: ... also with a space in it (nose pin against Nose Pin)');
select is(pg_temp.tryr($$insert into public.categories (name, prefix) values ('Rings', 'ZR3')$$), 'ok 1', 'T-F06, D5: a different name is accepted');
select pg_temp.fx($q$select set_config('jv.cat_ring', (select id::text from public.categories where name = 'Ring'), true)$q$);
select pg_temp.fx($q$select set_config('jv.cat_new', (select (tests.insert_row('public.categories', '{"name":"Fixture T-F06","prefix":"FTF"}') ->> 'id')), true)$q$);
select is(pg_temp.tryr(format($$insert into public.subcategories (category_id, name) values (%L, 'KUNDAN')$$, current_setting('jv.cat_ring'))), 'err 23505',
  'T-F06, D5: a subcategory name is unique within its category ignoring case (KUNDAN against Kundan)');
select is(pg_temp.tryr(format($$insert into public.subcategories (category_id, name) values (%L, 'Kundan')$$, current_setting('jv.cat_new'))), 'ok 1',
  'T-F06, D5: ... and the same name in another category is accepted');
select is(pg_temp.tryr(format($$insert into public.subcategories (category_id, name) values (%L, 'Antique')$$, current_setting('jv.cat_ring'))), 'ok 1',
  'T-F06, D5: a new name in the category is accepted');

-- the table-level half of the mobile and PAN rules (the function checks them first, below): the table refuses what the function would have let through
select pg_temp.fx($q$insert into private.import_batches (name) values ('fx-batch-075')$q$);
select pg_temp.fx($q$select set_config('jv.batch', (select id::text from private.import_batches where name = 'fx-batch-075'), true)$q$);
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values ('No mobile', null)$$), 'err 23514', 'T-F06, D10: a named customer with no mobile number is refused by the table');
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values ('Blank mobile', '')$$), 'err 23514', 'T-F06, D10: ... a blank one too');
select is(pg_temp.tryr(format($$insert into public.customers (name, mobile, import_batch_id) values ('Imported', null, %L)$$, current_setting('jv.batch'))), 'ok 1',
  'T-F06, D10: a blank mobile number is accepted with an import_batch_id (the screen asks for it when selected)');
select is(pg_temp.tryr($$insert into public.customers (name, mobile) values ('Bad mobile', '12345')$$), 'err 23514', 'T-F06, D10: a mobile number that is not ten digits or + and 7 to 15 digits is refused');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, pan) values ('Bad PAN', '9876543210', 'abcde1234f')$$), 'err 23514', 'T-F06, Z3: a PAN that is not five capitals, four digits and a capital is refused');
select is(pg_temp.tryr($$insert into public.customers (name, mobile, pan) values ('Good PAN', '9876543210', 'ABCDE1234F')$$), 'ok 1', 'T-F06, Z3: ... and a good one is accepted');

-- ---------------------------------------------------------------- 3. the logins
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.none', tests.make_user('none')::text, true);
end
$mk$;
select is(pg_temp.q($$select count(*) from public.profiles where active and role in ('owner', 'biller', 'staff')$$), '3', 'fixtures: an owner, a biller and a staff login with active profiles');

-- ---------------------------------------------------------------- 4. T-D09, the part X6 completes: who can call create_customer
select pg_temp.cc('anon', 'anon', pg_temp.rid(1), 'Anon Customer', '9876500001');
select pg_temp.cc('staff', 'staff', pg_temp.rid(2), 'Staff Customer', '9876500002');
select pg_temp.cc('inactive', 'inactive', pg_temp.rid(3), 'Inactive Customer', '9876500003');
select pg_temp.cc('none', 'none', pg_temp.rid(4), 'NoProfile Customer', '9876500004');
select pg_temp.cc('staff_bad', 'staff', pg_temp.rid(5), 'Staff Bad', 'not a number');
select pg_temp.cc('db', 'db', pg_temp.rid(6), 'Database Owner Customer', '9876500006');
select pg_temp.cc('biller', 'biller', pg_temp.rid(7), 'Biller Customer', '9876500007');
select pg_temp.cc('owner', 'owner', pg_temp.rid(8), 'Owner Customer', '9876500008');

select is(pg_temp.errstate('anon'), '42501', 'T-D09: anon is refused (permission denied for the function)');
select is(pg_temp.err('staff'), 'P0001 JV_FORBIDDEN', 'T-D09: staff get JV_FORBIDDEN');
select is(pg_temp.err('inactive'), 'P0001 JV_FORBIDDEN', 'A10: a login whose profile is not active gets JV_FORBIDDEN');
select is(pg_temp.err('none'), 'P0001 JV_FORBIDDEN', 'A10: a login with no profile gets JV_FORBIDDEN');
select is(pg_temp.err('staff_bad'), 'P0001 JV_FORBIDDEN',
  'X0 item 2: the role is checked before the input, so staff get JV_FORBIDDEN, not JV_INVALID_INPUT');
select is(pg_temp.err('db'), 'P0001 JV_FORBIDDEN',
  'A6: nobody signed in (the database owner) is not a user: JV_FORBIDDEN');
select ok(pg_temp.okk('biller'), 'T-D09: a biller can create a customer');
select ok(pg_temp.okk('owner'), 'T-D09: the owner can create a customer');
select is((select count(*)::int from public.customers where name in ('Anon Customer', 'Staff Customer', 'Inactive Customer', 'NoProfile Customer', 'Staff Bad', 'Database Owner Customer')), 0,
  'T-D09: and the refused calls made no customer');
select is((select count(*)::int from private.idempotency where request_id in (pg_temp.rid(1), pg_temp.rid(2), pg_temp.rid(3), pg_temp.rid(4), pg_temp.rid(5), pg_temp.rid(6))), 0,
  'L5: ... and left no idempotency row (a refused request can be sent again)');
select is((select count(*)::int from private.idempotency where request_id in (pg_temp.rid(7), pg_temp.rid(8)) and fn = 'create_customer'), 2,
  'L5: the two that worked are recorded under the function name create_customer');

-- ---------------------------------------------------------------- 5. what is returned and stored (X6, D10)
select is((select array_agg(k order by k) from jsonb_object_keys(pg_temp.res('biller')) k), array['customer'],
  'X6, C5(b): the answer is {"customer": ...}');
select is((pg_temp.res('biller') -> 'customer' ->> 'name'), 'Biller Customer', 'X6: the customer has the name given');
select is((pg_temp.res('biller') -> 'customer' ->> 'mobile'), '9876500007', 'X6: ... and the mobile number');
select is((pg_temp.res('biller') -> 'customer' ->> 'customer_type'), 'Retail', 'D10: the type is Retail unless said');
select is(pg_temp.cust('biller') ->> 'is_walkin' || ' ' || coalesce(pg_temp.cust('biller') ->> 'archived_at', 'null') || ' ' || coalesce(pg_temp.cust('biller') ->> 'import_batch_id', 'null'),
  'false null null', 'X6: never the walk-in, not archived, not imported');
select is((select count(*)::int from jsonb_each(pg_temp.cust('biller')) e
            where e.key in ('email', 'address', 'gst_number', 'pan', 'notes') and jsonb_typeof(e.value) = 'null'),
  5, 'X6: the fields not given (email, address, GST number, PAN, notes) are null');
select is(coalesce((select to_jsonb(c) from public.customers c where c.id = pg_temp.cid('biller')), '"no row"'::jsonb), coalesce(pg_temp.cust('biller'), '"no answer"'::jsonb),
  'X6: the customer returned is exactly the row stored (the cache applies it as it is)');
select is((select created_by::text from public.customers where id = pg_temp.cid('biller')), current_setting('jv.biller'),
  'D22: created_by is the biller (set from auth.uid(), not from the call)');
select is((select created_by::text from public.customers where id = pg_temp.cid('owner')), current_setting('jv.owner'),
  'D22: ... and the owner for the owner''s customer');
select is((select actor::text || ' ' || actor_role || ' ' || action from public.audit_log
            where table_name = 'customers' and row_id = pg_temp.cid('biller')::text),
  current_setting('jv.biller') || ' biller insert', 'L1: the insert is audited with the biller and the role');
select is(coalesce((select result from private.idempotency where request_id = pg_temp.rid(7)), '"no stored answer"'::jsonb), coalesce(pg_temp.res('biller'), '"no answer"'::jsonb),
  'L5: the answer is stored in the idempotency row, the same as what was returned');
select is((select (actor::text = current_setting('jv.biller')) and args_hash ~ '^[0-9a-f]{64}$' from private.idempotency where request_id = pg_temp.rid(7)),
  true, 'L5: ... with the caller and a SHA-256 hash of the arguments');

-- every field, a Wholesale customer
select pg_temp.cc('full', 'owner', pg_temp.rid(10), 'Full Customer', '+919876543210', 'Wholesale', 'full@example.in', '12 Market Road, Kolkata', '19ABCDE1234F1Z5', 'ABCDE1234F', 'pays on Fridays');
select is((pg_temp.cust('full') ->> 'customer_type') || '|' || (pg_temp.cust('full') ->> 'mobile') || '|' || (pg_temp.cust('full') ->> 'email') || '|' || (pg_temp.cust('full') ->> 'address')
                  || '|' || (pg_temp.cust('full') ->> 'gst_number') || '|' || (pg_temp.cust('full') ->> 'pan') || '|' || (pg_temp.cust('full') ->> 'notes'),
  'Wholesale|+919876543210|full@example.in|12 Market Road, Kolkata|19ABCDE1234F1Z5|ABCDE1234F|pays on Fridays', 'X6: every field is stored as given');
-- trimmed name; blank optional fields are none
select pg_temp.cc('blank', 'biller', pg_temp.rid(11), '   Ram Lal  ', '9876500011', null, '  ', '', '   ', '', ' ');
select is((pg_temp.res('blank') -> 'customer' ->> 'name'), 'Ram Lal', 'X6: the name is stored without the spaces round it');
select is((pg_temp.res('blank') -> 'customer' ->> 'customer_type'), 'Retail', 'D10: a null type means Retail');
select is((select count(*)::int from jsonb_each(pg_temp.cust('blank')) e
            where e.key in ('email', 'address', 'gst_number', 'pan', 'notes') and jsonb_typeof(e.value) = 'null'),
  5, 'X6: an empty or blank email, address, GST number, PAN and notes are stored as none');
-- the call with only the three required arguments
select pg_temp.run('short', 'biller', format($$select public.create_customer(%L, 'Short Call', '9876500012')$$, pg_temp.rid(12)));
select is((pg_temp.res('short') -> 'customer' ->> 'customer_type'), 'Retail', 'X6: three arguments are enough (the screen sends the rest only when it has them)');
select pg_temp.run('named', 'biller', format($$select public.create_customer(p_request_id => %L, p_name => 'Named Call', p_mobile => '9876500013', p_pan => 'ABCDE1234F')$$, pg_temp.rid(13)));
select is((pg_temp.res('named') -> 'customer' ->> 'pan'), 'ABCDE1234F', 'X6: and the arguments can be named (PostgREST sends them by name)');

-- ---------------------------------------------------------------- 6. the inputs (S4, S8, D10, Z3): always a JV_ code, never a raw CHECK error
create function pg_temp.name_cases() returns setof text language plpgsql as $f$
declare
  c record;
begin
  for c in select * from (values
    ('', 'JV_INVALID_INPUT', 'blank'),
    ('    ', 'JV_INVALID_INPUT', 'only spaces'),
    (null, 'JV_INVALID_INPUT', 'missing'),
    (repeat('x', 121), 'JV_INVALID_INPUT', '121 characters'),
    (repeat('x', 120), 'ok', '120 characters'),
    ('A', 'ok', 'one character'),
    (' ' || repeat('x', 120) || ' ', 'ok', '120 characters between spaces'),
    ('Ünï Çödé नाम', 'ok', 'letters that are not ASCII')
  ) v(nm, expected, what)
  loop
    return next is(pg_temp.cc_try(c.nm, '9876543210'), c.expected, 'D10, X6: the name ' || c.what || ' -> ' || c.expected);
  end loop;
end
$f$;
select * from pg_temp.name_cases();

create function pg_temp.mobile_cases() returns setof text language plpgsql as $f$
declare
  c record;
begin
  for c in select * from (values
    ('9876543210', 'ok', 'ten digits'),
    ('0987654321', 'ok', 'ten digits starting with 0'),
    ('+919876543210', 'ok', '+ and 12 digits'),
    ('+1234567', 'ok', '+ and the 7 digits of the lower bound'),
    ('+123456789012345', 'ok', '+ and the 15 digits of the upper bound'),
    ('+123456', 'JV_INVALID_INPUT', '+ and 6 digits'),
    ('+1234567890123456', 'JV_INVALID_INPUT', '+ and 16 digits'),
    ('987654321', 'JV_INVALID_INPUT', 'nine digits'),
    ('98765432101', 'JV_INVALID_INPUT', 'eleven digits without a +'),
    ('98765 43210', 'JV_INVALID_INPUT', 'a space inside (the screen removes spaces on entry)'),
    ('987-654-3210', 'JV_INVALID_INPUT', 'dashes inside (the screen removes dashes on entry)'),
    ('+91 98765 43210', 'JV_INVALID_INPUT', 'a + number with spaces'),
    (' 9876543210', 'JV_INVALID_INPUT', 'a space in front'),
    (E'9876543210\n', 'JV_INVALID_INPUT', 'a new line at the end'),
    ('abcdefghij', 'JV_INVALID_INPUT', 'ten letters'),
    ('+', 'JV_INVALID_INPUT', 'a lone +'),
    ('91+9876543210', 'JV_INVALID_INPUT', 'a + that is not first'),
    ('９８７６５４３２１０', 'JV_INVALID_INPUT', 'ten full-width digits'),
    ('', 'JV_INVALID_INPUT', 'blank'),
    ('   ', 'JV_INVALID_INPUT', 'only spaces'),
    (null, 'JV_INVALID_INPUT', 'missing')
  ) v(mobile, expected, what)
  loop
    return next is(pg_temp.cc_try('Mobile case', c.mobile), c.expected, 'D10, T-F06, X6: the mobile number ' || c.what || ' -> ' || c.expected);
  end loop;
end
$f$;
select * from pg_temp.mobile_cases();

create function pg_temp.type_cases() returns setof text language plpgsql as $f$
declare
  c record;
begin
  for c in select * from (values
    ('Retail', 'ok', 'Retail'),
    ('Semi-Wholesale', 'ok', 'Semi-Wholesale'),
    ('Wholesale', 'ok', 'Wholesale'),
    (null, 'ok', 'null (it means Retail)'),
    ('Gold', 'JV_INVALID_INPUT', 'Gold'),
    ('retail', 'JV_INVALID_INPUT', 'retail in lower case'),
    ('', 'JV_INVALID_INPUT', 'blank')
  ) v(ty, expected, what)
  loop
    return next is(pg_temp.cc_try('Type case', '9876543210', c.ty), c.expected, 'D10, X6: the customer type ' || c.what || ' -> ' || c.expected);
  end loop;
end
$f$;
select * from pg_temp.type_cases();

create function pg_temp.pan_cases() returns setof text language plpgsql as $f$
declare
  c record;
begin
  for c in select * from (values
    ('ABCDE1234F', 'ok', 'five capitals, four digits, a capital'),
    (null, 'ok', 'none'),
    ('', 'ok', 'blank (none)'),
    ('abcde1234f', 'JV_INVALID_INPUT', 'lower case'),
    ('ABCD1234F', 'JV_INVALID_INPUT', 'four letters at the start'),
    ('ABCDEF1234F', 'JV_INVALID_INPUT', 'six letters at the start'),
    ('ABCDE123F', 'JV_INVALID_INPUT', 'three digits'),
    ('ABCDE12345', 'JV_INVALID_INPUT', 'a digit at the end'),
    ('ABCDE1234', 'JV_INVALID_INPUT', 'no letter at the end'),
    ('ABCDE1234FG', 'JV_INVALID_INPUT', 'a letter too many'),
    ('ABCDE 1234F', 'JV_INVALID_INPUT', 'a space inside'),
    (' ABCDE1234F', 'JV_INVALID_INPUT', 'a space in front'),
    ('1BCDE1234F', 'JV_INVALID_INPUT', 'a digit at the start')
  ) v(pan, expected, what)
  loop
    return next is(pg_temp.cc_try('Pan case', '9876543210', 'Retail', c.pan), c.expected, 'D10, Z3, T-F06, X6: the PAN ' || c.what || ' -> ' || c.expected);
  end loop;
end
$f$;
select * from pg_temp.pan_cases();

-- ---------------------------------------------------------------- 7. never the walk-in (K5)
select pg_temp.cc('walkin_name', 'biller', pg_temp.rid(20), 'Walk-in Customer', '9876500020');
select is((pg_temp.res('walkin_name') -> 'customer' ->> 'is_walkin'), 'false', 'K5, X6: a customer named Walk-in Customer is an ordinary customer');
select is((select count(*)::int from public.customers where is_walkin), 1, 'T-F06, K5: after every creation of this file there is still exactly one walk-in ...');
select is((select id::text from public.customers where is_walkin), '00000000-0000-4000-8000-000000000001', 'K5: ... the one with the fixed id');
select is((select count(*)::int from public.customers where created_by is not null and is_walkin), 0, 'K5: no customer made by a person is the walk-in');
select ok((select pg_get_function_arguments(oid) !~* 'walk' from pg_proc where oid = to_regprocedure('public.create_customer(uuid,text,text,text,text,text,text,text,text)')),
  'K5, X6: the function has no way to ask for a walk-in');
select is((select count(*)::int from private.idempotency where request_id = pg_temp.rid(20)), 1, 'L5: ... and it was recorded like any other request');

-- ---------------------------------------------------------------- 8. repeat-safety (L5)
select pg_temp.cc('rep1', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select pg_temp.cc('rep2', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select ok(pg_temp.okk('rep1') and pg_temp.okk('rep2'), 'L5, T-F06: a repeated request id is answered, not refused');
select is(coalesce(pg_temp.res('rep2'), '"no answer 2"'::jsonb), coalesce(pg_temp.res('rep1'), '"no answer 1"'::jsonb), 'L5: the repeat returns the stored customer, the same answer');
select is((select count(*)::int from public.customers where name = 'Repeat Customer'), 1, 'L5: ... and no second customer was made');
select is((select count(*)::int from private.idempotency where request_id = pg_temp.rid(30)), 1, 'L5: ... one idempotency row');
-- the stored answer, not a fresh read: change the customer, repeat the request
update public.customers set name = 'Repeat Customer Edited' where id = pg_temp.cid('rep1');
select pg_temp.cc('rep3', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select is((pg_temp.res('rep3') -> 'customer' ->> 'name'), 'Repeat Customer', 'L5: the repeat returns what was stored at the first call, not the customer as it is now');

-- the same id with other arguments is refused: each argument in turn
select pg_temp.cc('chg_name', 'biller', pg_temp.rid(30), 'Other Name', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select pg_temp.cc('chg_mobile', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500031', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select pg_temp.cc('chg_type', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select pg_temp.cc('chg_email', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'other@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select pg_temp.cc('chg_address', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Elsewhere', 'GST1', 'ABCDE1234F', 'note');
select pg_temp.cc('chg_gst', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST2', 'ABCDE1234F', 'note');
select pg_temp.cc('chg_pan', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234G', 'note');
select pg_temp.cc('chg_notes', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'other note');
select pg_temp.cc('chg_none', 'biller', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', null, null, null, null, null);
select is((select array_agg(label || ' ' || split_part(msg, ':', 1) order by label) from r where label like 'chg\_%'),
  array['chg_address JV_INVALID_INPUT', 'chg_email JV_INVALID_INPUT', 'chg_gst JV_INVALID_INPUT', 'chg_mobile JV_INVALID_INPUT', 'chg_name JV_INVALID_INPUT',
        'chg_none JV_INVALID_INPUT', 'chg_notes JV_INVALID_INPUT', 'chg_pan JV_INVALID_INPUT', 'chg_type JV_INVALID_INPUT'],
  'L5, T-F06: the same request id with another name, mobile, type, email, address, GST number, PAN or notes, or with them left out, is refused');
select is((select count(*)::int from public.customers where name in ('Other Name')), 0, 'L5: ... and made no customer');
select is((select count(*)::int from public.customers where name = 'Repeat Customer Edited'), 1, 'L5: ... nor changed the one that exists');
select pg_temp.cc('rep_other_user', 'owner', pg_temp.rid(30), 'Repeat Customer', '9876500030', 'Semi-Wholesale', 'rep@example.in', 'Addr', 'GST1', 'ABCDE1234F', 'note');
select is(pg_temp.err('rep_other_user'), 'P0001 JV_INVALID_INPUT',
  'L5: the same id and the same arguments from another caller is refused (a request id belongs to one caller)');
-- an id begun by another function
select pg_temp.fx($q$select private.idem_begin(pg_temp.rid(31), 'create_bill', 'some-hash')$q$);
select pg_temp.cc('other_fn', 'biller', pg_temp.rid(31), 'Other Function', '9876500031');
select is(pg_temp.err('other_fn'), 'P0001 JV_INVALID_INPUT', 'L5: an id already used for another function is refused');
select is((select count(*)::int from public.customers where name = 'Other Function'), 0, 'L5: ... and made no customer');
-- no request id
select pg_temp.cc('no_id', 'biller', null, 'No Id', '9876500032');
select is(pg_temp.err('no_id'), 'P0001 JV_INVALID_INPUT', 'L5: a call with no request id is refused');
-- a failed request leaves nothing behind, so it can be sent again with the same id
select pg_temp.cc('fail1', 'biller', pg_temp.rid(32), 'Retry Customer', '12345');
select is(pg_temp.errcode('fail1'), 'JV_INVALID_INPUT', 'L5: a request refused for its input ...');
select is((select count(*)::int from private.idempotency where request_id = pg_temp.rid(32)), 0, 'L5: ... leaves no idempotency row');
select pg_temp.cc('fail2', 'biller', pg_temp.rid(32), 'Retry Customer', '9876500032');
select ok(pg_temp.okk('fail2'), 'L5: ... so the corrected request with the same id goes through');
-- a failure of the role check leaves nothing either (checked in section 4); the answer of a repeat is the stored one for the owner too
select pg_temp.cc('own1', 'owner', pg_temp.rid(33), 'Owner Repeat', '9876500033');
select pg_temp.cc('own2', 'owner', pg_temp.rid(33), 'Owner Repeat', '9876500033');
select is(coalesce(pg_temp.res('own2'), '"no answer 2"'::jsonb), coalesce(pg_temp.res('own1'), '"no answer 1"'::jsonb), 'L5: the owner''s repeat is answered with the stored customer too');

-- ---------------------------------------------------------------- 9. begin_write: the idempotency insert first, then the role check (X0 items 1 and 2)
select pg_temp.run('bw1', 'owner', format($$select pg_temp.bw(%L, 'template_fn', '{"a": 1}'::jsonb, array['owner', 'biller'])$$, pg_temp.rid(40)));
select ok((select ok and result is null from r where label = 'bw1' and ok), 'X0 item 1: the first call returns null (carry on)');
select is((select fn || ' ' || (actor::text = current_setting('jv.owner'))::text || ' ' || (args_hash = private.idem_hash('{"a": 1}'::jsonb))::text || ' ' || (result is null)::text
             from private.idempotency where request_id = pg_temp.rid(40)),
  'template_fn true true true', 'L5: it recorded the function, the caller and the hash of the arguments, with no result yet');
select pg_temp.run('bw2', 'owner', format($$select pg_temp.bw(%L, 'template_fn', '{"a": 1}'::jsonb, array['owner', 'biller'])$$, pg_temp.rid(40)));
select is(pg_temp.errcode('bw2'), 'JV_INVALID_INPUT', 'L5: a repeat of a request that has no result yet is refused (idem_begin)');
select pg_temp.fx($q$select private.idem_finish(pg_temp.rid(40), '{"done": true}'::jsonb)$q$);
select pg_temp.run('bw3', 'owner', format($$select pg_temp.bw(%L, 'template_fn', '{"a": 1}'::jsonb, array['owner', 'biller'])$$, pg_temp.rid(40)));
select is(pg_temp.res('bw3'), '{"done": true}'::jsonb, 'X0 item 1: once the result is stored, a repeat gets it');
select pg_temp.run('bw4', 'owner', format($$select pg_temp.bw(%L, 'template_fn', '{"a": 2}'::jsonb, array['owner', 'biller'])$$, pg_temp.rid(40)));
select is(pg_temp.errcode('bw4'), 'JV_INVALID_INPUT', 'L5: the same id with other arguments is refused');
-- the idempotency insert comes before the role check: the stored answer is returned even to a role list that would now refuse the caller
select pg_temp.run('bw5', 'owner', format($$select pg_temp.bw(%L, 'template_fn', '{"a": 1}'::jsonb, array['biller'])$$, pg_temp.rid(40)));
select is(pg_temp.res('bw5'), '{"done": true}'::jsonb, 'X0 items 1 and 2: the idempotency insert is first (a repeat is answered before the role is looked at)');
-- the role check
create function pg_temp.bw_cases() returns setof text language plpgsql as $f$
declare
  c record;
  v_n integer := 50;
  v_res text;
begin
  for c in select * from (values
    ('owner', array['owner'], 'ok', 'the owner, for the owner'),
    ('owner', array['owner', 'biller'], 'ok', 'the owner, for the owner and the biller'),
    ('biller', array['owner', 'biller'], 'ok', 'a biller, for the owner and the biller'),
    ('biller', array['owner'], 'JV_FORBIDDEN', 'a biller, for the owner alone'),
    ('staff', array['owner', 'biller'], 'JV_FORBIDDEN', 'staff, for the owner and the biller'),
    ('staff', array['owner', 'staff'], 'ok', 'staff, for the owner and staff'),
    ('inactive', array['owner', 'biller', 'staff'], 'JV_FORBIDDEN', 'a login that is not active, for every role'),
    ('none', array['owner', 'biller', 'staff'], 'JV_FORBIDDEN', 'a login with no profile, for every role'),
    ('db', array['owner', 'biller', 'staff'], 'JV_FORBIDDEN', 'nobody signed in, for every role'),
    ('owner', array[]::text[], 'JV_FORBIDDEN', 'the owner, for an empty list of roles (it refuses everybody)'),
    ('owner', null, 'JV_FORBIDDEN', 'the owner, for no list of roles at all')
  ) v(who, roles, expected, what)
  loop
    v_n := v_n + 1;
    perform pg_temp.run('bwc' || v_n, c.who, format($q$select pg_temp.bw(%L, 'template_fn', '{"a": 1}'::jsonb, %L::text[])$q$, pg_temp.rid(v_n), c.roles));
    select case when t.ok then 'ok' else split_part(t.msg, ':', 1) end into v_res from pg_temp.r t where t.label = 'bwc' || v_n;
    return next is(v_res, c.expected, 'X0 item 2: ' || c.what || ' -> ' || c.expected);
    -- a refusal leaves no idempotency row behind
    if c.expected = 'JV_FORBIDDEN' then
      return next is((select count(*)::int from private.idempotency where request_id = pg_temp.rid(v_n)), 0, 'L5: ... and no idempotency row');
    end if;
  end loop;
end
$f$;
select * from pg_temp.bw_cases();

-- ---------------------------------------------------------------- 10. lock_customer (X0 item 3)
select pg_temp.run('lc1', 'db', format($$select pg_temp.lc(%L)$$, pg_temp.cid('biller')));
select is((pg_temp.res('lc1') ->> 'name'), 'Biller Customer', 'X0 item 3: lock_customer returns the customer row it locked');
select pg_temp.run('lc2', 'db', $$select pg_temp.lc('00000000-0000-4000-8000-000000000001')$$);
select is((pg_temp.res('lc2') ->> 'is_walkin'), 'true', 'X0 item 3: ... the walk-in too');
select pg_temp.run('lc3', 'db', format($$select pg_temp.lc(%L)$$, gen_random_uuid()));
select is(pg_temp.errcode('lc3'), 'JV_NOT_FOUND', 'X0 item 3: a customer that does not exist is JV_NOT_FOUND');
select pg_temp.run('lc4', 'db', $$select pg_temp.lc(null)$$);
select is(pg_temp.errcode('lc4'), 'JV_INVALID_INPUT', 'X0 item 3: no customer id is JV_INVALID_INPUT');
select is(pg_temp.q(format($$select (private.lock_customer(%L)).archived_at is null$$, (pg_temp.res('biller') -> 'customer' ->> 'id'))), 'true',
  'X0 item 3: it returns the row as it is, archived or not (X1 decides what an archived customer means)');

-- ---------------------------------------------------------------- 11. the hook (X0 item 8): a money function built from the helpers, and the replacement the tests make
-- A function in the shape of X1 to X12: the clause, the helpers in the order of X0, the hook after the read. DB09b onward write the real ones this way.
create function pg_temp.money_template(p_request_id uuid, p_customer_id uuid) returns jsonb
language plpgsql security definer set search_path = '' set lock_timeout = '5s' as $f$
declare
  v_stored jsonb;
  v_customer public.customers;
begin
  v_stored := private.begin_write(p_request_id, 'money_template', jsonb_build_object('p_customer_id', p_customer_id), array['owner', 'biller']);
  if v_stored is not null then
    return v_stored;
  end if;
  v_customer := private.lock_customer(p_customer_id);
  perform private.test_pause('money_template.after_read');
  return private.idem_finish(p_request_id, jsonb_build_object('customer', v_customer.name));
exception when lock_not_available then
  perform private.jv_error('JV_BUSY', 'The system is busy; try again');
end
$f$;
grant execute on function pg_temp.money_template(uuid, uuid) to public;
select pg_temp.run('mt1', 'biller', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(70), (pg_temp.res('biller') -> 'customer' ->> 'id')));
select is((pg_temp.res('mt1') ->> 'customer'), 'Biller Customer', 'X0: a function built from the three helpers runs: prologue, lock, hook, finish');
select pg_temp.run('mt2', 'biller', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(70), (pg_temp.res('biller') -> 'customer' ->> 'id')));
select is(coalesce(pg_temp.res('mt2'), '"no answer 2"'::jsonb), coalesce(pg_temp.res('mt1'), '"no answer 1"'::jsonb), 'X0, L5: ... and its repeat is answered with the stored result');
select pg_temp.run('mt3', 'staff', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(71), (pg_temp.res('biller') -> 'customer' ->> 'id')));
select is(pg_temp.errcode('mt3'), 'JV_FORBIDDEN', 'X0: ... and refuses a role that is not on its list before it locks anything');
select pg_temp.run('mt4', 'biller', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(72), gen_random_uuid()));
select is(pg_temp.errcode('mt4'), 'JV_NOT_FOUND', 'X0: ... and a customer that does not exist is JV_NOT_FOUND');
select is((select count(*)::int from private.idempotency where request_id in (pg_temp.rid(71), pg_temp.rid(72))), 0, 'L5: ... neither leaves an idempotency row');
-- a test replaces the hook with create or replace (tests/db/hook.ts): the replacement is called with the point, once, after the read
select set_config('jv.pause_oid', to_regprocedure('private.test_pause(text)')::oid::text, true);
select pg_temp.fx($q$create or replace function private.test_pause(p_point text) returns void language plpgsql as $h$
  begin
    perform set_config('jv.hook_calls', coalesce(nullif(current_setting('jv.hook_calls', true), ''), '') || p_point || ';', true);
  end $h$$q$);
select is(pg_temp.q($$select (to_regprocedure('private.test_pause(text)')::oid::text = current_setting('jv.pause_oid'))::text$$), 'true',
  'X0 item 8: create or replace of the hook keeps the function (the same object), with the parameter name it has');
select pg_temp.run('hook1', 'biller', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(73), (pg_temp.res('biller') -> 'customer' ->> 'id')));
select is(current_setting('jv.hook_calls', true), 'money_template.after_read;', 'X0 item 8: a function built from the helpers calls the hook once, with its own point, after the read');
select pg_temp.run('hook2', 'biller', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(73), (pg_temp.res('biller') -> 'customer' ->> 'id')));
select is(current_setting('jv.hook_calls', true), 'money_template.after_read;', 'X0 item 8: a repeat answered from the stored result does not reach the hook');
select pg_temp.run('hook3', 'staff', format($$select pg_temp.money_template(%L, %L)$$, pg_temp.rid(74), (pg_temp.res('biller') -> 'customer' ->> 'id')));
select is(current_setting('jv.hook_calls', true), 'money_template.after_read;', 'X0 item 8: a call refused before the read does not reach it either');

select * from finish();
rollback;
