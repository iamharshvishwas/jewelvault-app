-- The common helpers of migration 0003 (DB02): the clock seam, the error helper, the stamping and person-column triggers,
-- and the early private tables. This file is not on the brief's list of files: it holds the tests of the 0003 parts that
-- no spec test of the task names (T-D22 and T-F07 are written by DB03 and DB14b on top of these helpers).
--
-- Spec lines: S5 (clock seam, Asia/Kolkata), S6 (updated_at, person columns), S8 (error codes), D18 (limits, import_batches),
-- D22 (forced person columns), A1 (row-level security on every table), A3 (nothing reachable through the API).
-- Everything runs in this transaction and is rolled back. The tests with the real clock come first: tests.set_clock
-- replaces private.now_ts() for the rest of the transaction.
begin;
select plan(71);

-- The SQLSTATE and the message of the error a statement raises, or null when it raises none.
create function pg_temp.err_msg(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return null;
exception when others then
  return sqlerrm;
end
$f$;

-- ---------------------------------------------------------------- 1. the clock seam, real clock (S5)
select has_function('private', 'now_ts', array[]::text[], 'S5: private.now_ts() exists');
select has_function('private', 'today', array[]::text[], 'S5: private.today() exists');
select is((select prorettype::regtype::text from pg_proc where oid = to_regprocedure('private.now_ts()')), 'timestamp with time zone', 'S5: now_ts() returns timestamptz');
select is((select prorettype::regtype::text from pg_proc where oid = to_regprocedure('private.today()')), 'date', 'S5: today() returns a date');
select is((select provolatile from pg_proc where oid = to_regprocedure('private.now_ts()')), 'v', 'S5: now_ts() is volatile, as clock_timestamp() is');
select is((select proconfig from pg_proc where oid = to_regprocedure('private.now_ts()')), array['search_path=""'], 'T-D10: now_ts() pins an empty search_path');
select is((select proconfig from pg_proc where oid = to_regprocedure('private.today()')), array['search_path=""'], 'T-D10: today() pins an empty search_path');
select is(
  case when to_regprocedure('private.now_ts()') is null then null
       else has_function_privilege('authenticated', 'private.now_ts()', 'EXECUTE') or has_function_privilege('anon', 'private.now_ts()', 'EXECUTE')
            or has_function_privilege('authenticated', 'private.today()', 'EXECUTE') or has_function_privilege('anon', 'private.today()', 'EXECUTE') end,
  false, 'S5: the clock seam is unreachable for the API roles');

select pg_sleep(0.05);
select is(abs(extract(epoch from (private.now_ts() - clock_timestamp()))) < 1, true, 'S5: now_ts() is the wall clock');
select ok(private.now_ts() > now(), 'S5: ... and it is not now(), which stays at the start of the transaction');
select ok((select a <= b from (select private.now_ts() as a, private.now_ts() as b) s), 'S5: two calls never go backwards');
select is(private.today(), (clock_timestamp() at time zone 'Asia/Kolkata')::date, 'S5: today() is the date in Asia/Kolkata');

-- ---------------------------------------------------------------- 2. private.jv_error (S8)
select has_function('private', 'jv_error', array['text', 'text'], 'S8: private.jv_error(code, text) exists');
select is((select proconfig from pg_proc where oid = to_regprocedure('private.jv_error(text,text)')), array['search_path=""'], 'T-D10: jv_error pins an empty search_path');
select throws_ok(
  $$select private.jv_error('JV_FORBIDDEN', 'Only the owner may do this')$$,
  'P0001', 'JV_FORBIDDEN: Only the owner may do this', 'S8: it raises the code at the start of the message, then the text');
select throws_ok(
  $$select private.jv_error('JV_BUSY')$$,
  'P0001', 'JV_BUSY', 'S8: with no text the message is the code alone');
select throws_ok(
  $$select private.jv_error('JV_NOT_FOUND', 'customer 100% sure')$$,
  'P0001', 'JV_NOT_FOUND: customer 100% sure', 'S8: the text is used as it is (a % in it is not a format character)');
select is(
  (select count(*)::int from unnest(array['JV_FORBIDDEN', 'JV_INVALID_INPUT', 'JV_NOT_FOUND', 'JV_PIECE_UNAVAILABLE', 'JV_CUSTOMER_ARCHIVED',
                                          'JV_OVERPAYMENT', 'JV_CASH_LIMIT', 'JV_FINE_EXCEEDS', 'JV_BILL_CANCELLED', 'JV_ALREADY_VOID',
                                          'JV_NOT_ALLOWED', 'JV_BUSY']) c
    where pg_temp.err_msg(format('select private.jv_error(%L, %L)', c, 'x')) = c || ': x'),
  12, 'S8: all twelve codes of the spec are accepted');
select throws_ok(
  $$select private.jv_error('JV_FORBIDEN', 'typo')$$,
  '22023', null, 'S8: a code that is not one of the twelve is refused, so a typo cannot reach a screen');
select throws_ok($$select private.jv_error(null, 'x')$$, '22023', null, 'S8: a missing code is refused');
select throws_ok($$select private.jv_error('jv_busy', 'x')$$, '22023', null, 'S8: a code in lower case is refused');

-- ---------------------------------------------------------------- 3. updated_at and created_at, real clock (S5, S6)
select has_function('private', 'set_updated_at', array[]::text[], 'S6: private.set_updated_at() exists');
select is((select prosecdef from pg_proc where oid = to_regprocedure('private.set_updated_at()')), true, 'S6: it is security definer (it must call private.now_ts(), which the API roles may not)');
select is((select proconfig from pg_proc where oid = to_regprocedure('private.set_updated_at()')), array['search_path=""'], 'T-D10: and pins an empty search_path');
select is(
  (select (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 4) = 4 and (t.tgtype & 16) = 16 and (t.tgtype & 8) = 0
     from pg_trigger t where t.tgrelid = to_regclass('public.profiles') and t.tgname = 'profiles_set_updated_at'),
  true, 'S6: profiles has a BEFORE INSERT OR UPDATE row trigger, profiles_set_updated_at');

do $mk$
begin
  perform set_config('jv.real', tests.make_user('owner')::text, true);
end
$mk$;
select pg_sleep(0.05);
select set_config('jv.t0', (select updated_at::text from public.profiles where id = current_setting('jv.real')::uuid), true);
select set_config('jv.c0', (select created_at::text from public.profiles where id = current_setting('jv.real')::uuid), true);
update public.profiles set full_name = 'Real clock' where id = current_setting('jv.real')::uuid;
select ok(
  (select updated_at from public.profiles where id = current_setting('jv.real')::uuid) > now(),
  'S6: updated_at uses clock_timestamp(), later than now() (the start of the transaction)');
select ok(
  (select updated_at from public.profiles where id = current_setting('jv.real')::uuid) > current_setting('jv.t0')::timestamptz,
  'S6: and each update moves it forward');
select is(
  (select created_at from public.profiles where id = current_setting('jv.real')::uuid), current_setting('jv.c0')::timestamptz,
  'S6: and leaves created_at alone');
select pg_sleep(0.02);
select set_config('jv.t1', (select updated_at::text from public.profiles where id = current_setting('jv.real')::uuid), true);
update public.profiles set full_name = full_name where id = current_setting('jv.real')::uuid;
select ok(
  (select updated_at from public.profiles where id = current_setting('jv.real')::uuid) > current_setting('jv.t1')::timestamptz,
  'S6, D23: even an update that changes nothing moves updated_at, so a touch is one plain update');
update public.profiles set created_at = '2000-01-01', updated_at = '2000-01-01' where id = current_setting('jv.real')::uuid;
select is(
  (select created_at from public.profiles where id = current_setting('jv.real')::uuid), current_setting('jv.c0')::timestamptz,
  'S6: a value sent for created_at is ignored, even from the database owner');
select ok(
  (select updated_at from public.profiles where id = current_setting('jv.real')::uuid) > current_setting('jv.t1')::timestamptz,
  'S6: and so is one sent for updated_at');

-- ---------------------------------------------------------------- 4. forced person columns (D22, S6)
select has_function('private', 'force_person_columns', array[]::text[], 'D22: private.force_person_columns() exists');
select is((select proconfig from pg_proc where oid = to_regprocedure('private.force_person_columns()')), array['search_path=""'], 'T-D10: it pins an empty search_path');

create table public.jv_t_person (
  id int primary key, note text, created_by uuid, updated_by uuid, set_by uuid, confirmed_by uuid);
create table public.jv_t_person2 (id int primary key, created_by uuid);
create table public.jv_t_person3 (id int primary key, note text);
create trigger jv_t_person_force before insert or update on public.jv_t_person for each row execute function private.force_person_columns();
create trigger jv_t_person2_force before insert or update on public.jv_t_person2 for each row execute function private.force_person_columns();
create trigger jv_t_person3_force before insert or update on public.jv_t_person3 for each row execute function private.force_person_columns();
grant select, insert, update on public.jv_t_person, public.jv_t_person2, public.jv_t_person3 to authenticated;
create policy jv_t_person_all on public.jv_t_person for all to authenticated using (true) with check (true);
create policy jv_t_person2_all on public.jv_t_person2 for all to authenticated using (true) with check (true);
create policy jv_t_person3_all on public.jv_t_person3 for all to authenticated using (true) with check (true);

do $mk$
begin
  perform set_config('jv.u1', tests.make_user('owner')::text, true);
  perform set_config('jv.u2', tests.make_user('biller')::text, true);
  perform set_config('jv.forged', gen_random_uuid()::text, true);
end
$mk$;

select tests.as_user(current_setting('jv.u1')::uuid);
insert into public.jv_t_person (id, note, created_by, updated_by, set_by, confirmed_by)
values (1, 'a', current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid);
select tests.reset_role();
select is(
  (select array[created_by, updated_by, set_by, confirmed_by] from public.jv_t_person where id = 1),
  array[current_setting('jv.u1')::uuid, current_setting('jv.u1')::uuid, current_setting('jv.u1')::uuid, current_setting('jv.u1')::uuid],
  'D22: on insert all four person columns are the signed-in user, whatever the client sent');

select tests.as_user(current_setting('jv.u2')::uuid);
update public.jv_t_person
   set note = 'b', created_by = current_setting('jv.forged')::uuid, updated_by = current_setting('jv.forged')::uuid,
       set_by = current_setting('jv.forged')::uuid, confirmed_by = current_setting('jv.forged')::uuid
 where id = 1;
select tests.reset_role();
select is(
  (select array[created_by, updated_by, set_by, confirmed_by] from public.jv_t_person where id = 1),
  array[current_setting('jv.u1')::uuid, current_setting('jv.u2')::uuid, current_setting('jv.u2')::uuid, current_setting('jv.u2')::uuid],
  'D22: on update created_by cannot change, and the other three become the user who made the update, whatever the client sent');

select tests.as_user(current_setting('jv.u1')::uuid);
update public.jv_t_person set created_by = current_setting('jv.forged')::uuid where id = 1;
select tests.reset_role();
select is(
  (select created_by from public.jv_t_person where id = 1), current_setting('jv.u1')::uuid,
  'D22: a client that sends only a forged created_by changes nothing');

insert into public.jv_t_person (id, note, created_by, updated_by, set_by, confirmed_by)
values (2, 'import', current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid, current_setting('jv.forged')::uuid);
select is(
  (select array[created_by, updated_by, set_by, confirmed_by] from public.jv_t_person where id = 2),
  array[null, null, null, null]::uuid[], 'D22: an insert by the database owner (an import) leaves them all null');
update public.jv_t_person set note = 'repair' where id = 1;
select is(
  (select array[created_by, updated_by, set_by, confirmed_by] from public.jv_t_person where id = 1),
  array[current_setting('jv.u1')::uuid, null, null, null]::uuid[],
  'D22: an update by the database owner leaves no person in updated_by, set_by and confirmed_by, and keeps created_by');

select tests.as_user(current_setting('jv.u1')::uuid);
insert into public.jv_t_person2 (id, created_by) values (1, current_setting('jv.forged')::uuid);
insert into public.jv_t_person3 (id, note) values (1, 'plain');
update public.jv_t_person3 set note = 'plain 2' where id = 1;
select tests.reset_role();
select is((select created_by from public.jv_t_person2 where id = 1), current_setting('jv.u1')::uuid, 'D22: a table with only some of the person columns works: created_by is forced');
select is((select note from public.jv_t_person3 where id = 1), 'plain 2', 'D22: and a table with none of them is not harmed');

-- ---------------------------------------------------------------- 5. limits and import_batches (D18, S4, A1)
select has_table('private', 'limits', 'D18: private.limits exists');
select has_table('private', 'import_batches', 'D18: private.import_batches exists');
select is(
  (select array_agg(relname::text order by relname) from pg_class
    where relnamespace = to_regnamespace('private') and relname in ('limits', 'import_batches') and relrowsecurity),
  array['import_batches', 'limits'], 'A1: row-level security is on for both');
select is(
  (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ', ' order by ordinal_position)
     from information_schema.columns where table_schema = 'private' and table_name = 'limits'),
  'name:text:NO, value:numeric:NO, note:text:YES', 'D18: private.limits holds a name, a numeric value and a note');
select is(
  (select string_agg(name || '=' || value::text, ', ' order by name) from private.limits),
  'cash_limit=200000, discount_flag_percent=10, max_amount=1000000000, max_bill_lines=200, max_quantity=1000, max_rate=100000000, max_weight=100000, pan_threshold=200000, rate_flag_percent=5',
  'S4, section 13, I11: the caps and thresholds');
select is(
  (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ', ' order by ordinal_position)
     from information_schema.columns where table_schema = 'private' and table_name = 'import_batches'),
  'id:uuid:NO, name:text:NO, source_file:text:YES, row_counts:jsonb:YES, created_at:timestamp with time zone:NO',
  'D18: private.import_batches holds id, name, source_file, row_counts and created_at');
select col_is_pk('private', 'import_batches', 'id', 'D18: id is its primary key');
select col_is_unique('private', 'import_batches', 'name', 'D18, IM2: the name is unique, so a batch cannot be run twice');
select lives_ok(
  $$insert into private.import_batches (name, source_file, row_counts) values ('jv-t-batch', 'stock.xlsx', '{"designs": 3}')$$,
  'IM2: a batch is recorded');
select throws_ok(
  $$insert into private.import_batches (name) values ('jv-t-batch')$$,
  '23505', null, 'IM2: the same batch name again is refused');
select is((select count(*)::int from private.import_batches where created_at is not null and id is not null), 1, 'D18: id and created_at fill themselves');

select tests.as_user(current_setting('jv.u1')::uuid);
select throws_ok('select * from private.limits', '42501', null, 'A3: not even the owner can read private.limits through the API');
select throws_ok('select * from private.import_batches', '42501', null, 'A3: nor private.import_batches');
select throws_ok($$insert into private.limits (name, value) values ('x', 1)$$, '42501', null, 'A3: nor write private.limits');
select tests.as_anon();
select throws_ok('select * from private.limits', '42501', null, 'A3: anon has no use of private at all');
select tests.reset_role();
select is(
  (select value from private.limits where name = 'cash_limit') = (select value from private.limits where name = 'pan_threshold'),
  true, 'section 13: the cash limit and the PAN threshold start at the same figure');

-- ---------------------------------------------------------------- 6. a fixed clock fakes every stamp (S5, S6)
select is(tests.set_clock('2026-12-31 18:29:59+00'), '2026-12-31 18:29:59+00'::timestamptz, 'tests.set_clock fixes the clock inside the transaction');
select is(private.now_ts(), '2026-12-31 18:29:59+00'::timestamptz, 'S5: now_ts() now answers the fixed time');
select is(private.today(), '2026-12-31'::date, 'S5, T-F07: 23:59:59 on 31 December in Asia/Kolkata is still 31 December');
select tests.set_clock('2026-12-31 18:30:01+00');
select is(private.today(), '2027-01-01'::date, 'S5, T-F07: 00:00:01 on 1 January in Asia/Kolkata is 1 January');
select tests.set_clock('2026-06-15 18:29:59.999999+00');
select is(private.today(), '2026-06-15'::date, 'S5: one microsecond before the Indian midnight is still the day before');
select tests.set_clock('2026-06-15 18:30:00+00');
select is(private.today(), '2026-06-16'::date, 'S5: and at the Indian midnight it is the next day');

select tests.set_clock('2026-03-01 10:00:00+00');
do $mk$
begin
  perform set_config('jv.fixed', tests.make_user('staff')::text, true);
end
$mk$;
select is(
  (select created_at from public.profiles where id = current_setting('jv.fixed')::uuid), '2026-03-01 10:00:00+00'::timestamptz,
  'S6: with the clock fixed, a new row''s created_at is the fixed time (the trigger takes the stamp from private.now_ts())');
select is(
  (select updated_at from public.profiles where id = current_setting('jv.fixed')::uuid), '2026-03-01 10:00:00+00'::timestamptz,
  'S6: ... and so is its updated_at');
select tests.set_clock('2026-03-01 10:05:00+00');
update public.profiles set full_name = 'Moved' where id = current_setting('jv.fixed')::uuid;
select is(
  (select created_at || ' / ' || updated_at from public.profiles where id = current_setting('jv.fixed')::uuid),
  '2026-03-01 10:00:00+00 / 2026-03-01 10:05:00+00', 'S6: an update moves updated_at to the fixed time and leaves created_at alone');

-- ---------------------------------------------------------------- 7. tests.reset_business_data with the new tables (DB01)
select lives_ok($$select tests.reset_business_data(true)$$, 'DB01: tests.reset_business_data(keep users) runs with the new tables');
select is((select count(*)::int from private.limits), 9, 'DB01: ... and keeps private.limits');
select is((select count(*)::int from private.import_batches), 0, 'DB01: ... but empties private.import_batches');
select lives_ok($$select tests.reset_business_data()$$, 'DB01: tests.reset_business_data() deletes the logins and their profiles');
select is((select count(*)::int from public.profiles), 0, 'DB01: no profile is left');
select is((select count(*)::int from auth.users), 0, 'DB01: no login is left');

select * from finish();
rollback;
