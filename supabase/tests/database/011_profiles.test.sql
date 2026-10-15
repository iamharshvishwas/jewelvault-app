-- T-D06, T-D20 and T-E09 (the database halves), with the rules they rest on. DB02, migration 0002.
--
-- Spec lines: D1, D2, S10, A2, A4 (the profiles row), A8, A10, U3. Everything runs in this transaction and is rolled back.
-- The browser halves are FE02 (T-D06, T-E01); a call over HTTP with a real login is tests/db/auth.test.ts.
--
-- The helpers in pg_temp are written so that a missing table or function makes an assertion fail instead of stopping the
-- file, which lets this file show every failure before migration 0002 exists. They can be called while a role is
-- impersonated (they are granted to public here).
begin;
select plan(106);

-- A login the way the dashboard makes it: a row in auth.users and nothing else. (tests.make_user builds the logins that
-- need a profile of a given role; it makes the same row and then activates it with private.activate_user.)
create function pg_temp.raw_login(p_email text, p_meta jsonb default '{}', p_app jsonb default '{"provider":"email","providers":["email"]}')
returns uuid language sql as $f$
  insert into auth.users (instance_id, id, aud, role, email, raw_user_meta_data, raw_app_meta_data, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', p_email, p_meta, p_app, now(), now())
  returning id
$f$;

create function pg_temp.raw_phone_login(p_phone text) returns uuid language sql as $f$
  insert into auth.users (instance_id, id, aud, role, phone, created_at, updated_at)
  values ('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated', p_phone, now(), now())
  returning id
$f$;

-- The profile of a login as 'role/active/full_name', or null. Runs as the database owner, so row-level security is out of the way.
create function pg_temp.profile_of(p_id uuid) returns text language plpgsql security definer as $f$
begin
  return (select role || '/' || active::text || '/' || full_name from public.profiles where id = p_id);
exception when undefined_table then
  return null;
end
$f$;

-- What private.app_role() answers to the current role; '<missing>' when the function does not exist yet.
create function pg_temp.who() returns text language plpgsql as $f$
declare
  r text;
begin
  execute 'select private.app_role()' into r;
  return r;
exception when undefined_function or invalid_schema_name or insufficient_privilege then
  return '<missing>';
end
$f$;

-- How many rows a profiles statement changed for the current role; -1 when it could not run at all.
create function pg_temp.affected(p_sql text) returns integer language plpgsql as $f$
declare
  n integer;
begin
  execute p_sql;
  get diagnostics n = row_count;
  return n;
exception when others then
  raise notice 'pg_temp.affected: % (%)', sqlerrm, sqlstate;
  return -1;
end
$f$;

-- The number of profiles (that match a condition) the current role can see; -1 when the table is missing or not readable.
create function pg_temp.n_profiles(p_where text default 'true') returns integer language plpgsql as $f$
declare
  n integer;
begin
  execute 'select count(*) from public.profiles where ' || p_where into n;
  return n;
exception when others then
  return -1;
end
$f$;

-- private.activate_user as the snippet of the runbook calls it; null when it does not exist yet.
create function pg_temp.activate(p_email text, p_role text, p_name text) returns jsonb language plpgsql as $f$
declare
  r jsonb;
begin
  execute 'select private.activate_user($1, $2, $3)' into r using p_email, p_role, p_name;
  return r;
exception when undefined_function or invalid_schema_name then
  return null;
end
$f$;
-- A statement of the fixtures that touches profiles: skipped, not fatal, while the table does not exist yet.
create function pg_temp.run(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when undefined_table then
  null;
end
$f$;
grant execute on function pg_temp.profile_of(uuid), pg_temp.who(), pg_temp.affected(text), pg_temp.n_profiles(text) to public;

-- ---------------------------------------------------------------- 1. the table (D1)
select has_table('public', 'profiles', 'D1: the table public.profiles exists');
select is(
  (select string_agg(column_name || ':' || data_type || ':' || is_nullable, ', ' order by ordinal_position)
     from information_schema.columns where table_schema = 'public' and table_name = 'profiles'),
  'id:uuid:NO, full_name:text:NO, role:text:NO, active:boolean:NO, created_at:timestamp with time zone:NO, updated_at:timestamp with time zone:NO',
  'D1, S6: the columns of profiles');
select is(
  (select column_default from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name = 'active'),
  'false', 'D1: active defaults to false');
select col_is_pk('public', 'profiles', 'id', 'D1: id is the primary key');
select is(
  (select c.confrelid::regclass::text || '.' || (select attname from pg_attribute where attrelid = c.confrelid and attnum = c.confkey[1]) || ' ' || c.confdeltype::text
     from pg_constraint c where c.conrelid = to_regclass('public.profiles') and c.contype = 'f'),
  'auth.users.id r',
  'D1, S7: id is a foreign key to auth.users with ON DELETE RESTRICT: a login that has a profile cannot be deleted (deactivate it instead)');
select is(
  (select relrowsecurity from pg_class where oid = to_regclass('public.profiles')),
  true, 'A1: row-level security is on for profiles');

-- ---------------------------------------------------------------- 2. the rules of the columns (D1)
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.none', tests.make_user('none')::text, true);
  perform set_config('jv.other', tests.make_user('biller')::text, true);
end
$mk$;

select throws_ok(
  $$insert into public.profiles (id, full_name, role) values (current_setting('jv.none')::uuid, 'Somebody', 'admin')$$,
  '23514', null, 'D1: a role other than owner, biller or staff is refused');
select throws_ok(
  $$insert into public.profiles (id, full_name, role) values (current_setting('jv.none')::uuid, '   ', 'staff')$$,
  '23514', null, 'D1: a blank name is refused');
select throws_ok(
  $$insert into public.profiles (id, full_name, role) values (gen_random_uuid(), 'Nobody', 'staff')$$,
  '23503', null, 'D1: a profile needs a login');
select lives_ok(
  $$insert into public.profiles (id, full_name, role) values (current_setting('jv.none')::uuid, 'Somebody', 'staff')$$,
  'D1: a staff profile for an existing login is accepted');
select is(pg_temp.profile_of(current_setting('jv.none')::uuid), 'staff/false/Somebody', 'D1: and it is not active until somebody activates it');
select pg_temp.run($$delete from public.profiles where id = current_setting('jv.none')::uuid$$);

-- ---------------------------------------------------------------- 3. the new-user trigger (D1, A2, T-E09)
do $nu$
begin
  perform set_config('jv.n_plain', pg_temp.raw_login('aarti.shah@jv-test.local')::text, true);
  perform set_config('jv.n_name', pg_temp.raw_login('aarti2@jv-test.local', '{"full_name":"Aarti Shah"}')::text, true);
  perform set_config('jv.n_blank', pg_temp.raw_login('blank.name@jv-test.local', '{"full_name":"   "}')::text, true);
  perform set_config('jv.n_phone', pg_temp.raw_phone_login('+910000000001')::text, true);
  perform set_config('jv.n_evil', pg_temp.raw_login(
    'mallory@jv-test.local',
    '{"full_name":"Mallory","role":"owner","active":true,"is_admin":true}',
    '{"provider":"email","providers":["email"],"role":"owner","active":true}')::text, true);
end
$nu$;

select is(
  pg_temp.profile_of(current_setting('jv.n_plain')::uuid), 'staff/false/aarti.shah',
  'T-E09: a login made with no metadata gets a profile: inactive staff, named by the part of the email before the @');
select is(
  pg_temp.profile_of(current_setting('jv.n_name')::uuid), 'staff/false/Aarti Shah',
  'D1: the name comes from the login''s metadata when it has one');
select is(
  pg_temp.profile_of(current_setting('jv.n_blank')::uuid), 'staff/false/blank.name',
  'D1: a blank name in the metadata counts as none');
select is(
  pg_temp.profile_of(current_setting('jv.n_phone')::uuid), 'staff/false/New user',
  'a login with no email and no name still gets a profile (the trigger must never stop a login being made)');
select is(
  pg_temp.profile_of(current_setting('jv.n_evil')::uuid), 'staff/false/Mallory',
  'T-D06, A2: metadata that asks for the owner role or for active changes nothing: the profile is inactive staff');
select ok(
  exists (select 1 from pg_trigger t where t.tgrelid = 'auth.users'::regclass and not t.tgisinternal and t.tgenabled = 'O'
                and (t.tgtype & 1) = 1 and (t.tgtype & 2) = 0 and (t.tgtype & 4) = 4
                and (select n.nspname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where p.oid = t.tgfoid) = 'private'),
  'D1: an enabled row trigger AFTER INSERT on auth.users runs a function in private');
select is(
  (select prosecdef from pg_proc where oid = to_regprocedure('private.handle_new_user()')),
  true, 'the new-user function is security definer (it writes a table the new login cannot write)');
select is(
  (select proconfig from pg_proc where oid = to_regprocedure('private.handle_new_user()')),
  array['search_path=""'], 'and pins an empty search_path (T-D10)');
select is(
  (select count(*)::int from unnest(array[current_setting('jv.owner')::uuid, current_setting('jv.biller')::uuid,
     current_setting('jv.staff')::uuid, current_setting('jv.inactive')::uuid]) u where pg_temp.profile_of(u) is not null),
  4, 'tests.make_user gives a profile to each role it builds');
select throws_ok(
  $$delete from auth.users where id = current_setting('jv.n_phone')::uuid$$,
  '23503', null, 'D1, S7: deleting a login that has a profile is refused with a foreign key violation');
select is(pg_temp.profile_of(current_setting('jv.n_phone')::uuid), 'staff/false/New user', 'D1: and the profile is still there');
select is((select count(*)::int from auth.users where id = current_setting('jv.n_phone')::uuid), 1, 'D1: and so is the login');
select lives_ok(
  $$delete from public.profiles where id = current_setting('jv.n_phone')::uuid$$,
  'D1: the database owner can delete the profile row of a login made by mistake (the SQL editor)');
select lives_ok(
  $$delete from auth.users where id = current_setting('jv.n_phone')::uuid$$,
  'D1: and then the login can be deleted');
select is((select count(*)::int from auth.users where id = current_setting('jv.n_phone')::uuid), 0, 'D1: and it is gone');

-- ---------------------------------------------------------------- 4. private.app_role() (D2, S10, A2, A10)
select has_function('private', 'app_role', array[]::text[], 'S10: the helper is private.app_role()');
select is((select prosecdef from pg_proc where oid = to_regprocedure('private.app_role()')), true, 'D2: app_role is security definer');
select is((select provolatile from pg_proc where oid = to_regprocedure('private.app_role()')), 's', 'D2: and stable');
select is((select proconfig from pg_proc where oid = to_regprocedure('private.app_role()')), array['search_path=""'], 'D2: and has search_path = empty');
select is((select prorettype::regtype::text from pg_proc where oid = to_regprocedure('private.app_role()')), 'text', 'D2: and returns text');

select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.who(), 'owner', 'D2: the owner''s role is owner');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.who(), 'biller', 'D2: the biller''s role is biller');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.who(), 'staff', 'D2: the staff member''s role is staff');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.who(), null, 'A10: an inactive profile has no role');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.who(), null, 'A10: a login with no profile has no role');
select tests.as_user(current_setting('jv.biller')::uuid);
select set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('jv.biller'), 'role', 'authenticated', 'aud', 'authenticated',
                     'user_metadata', jsonb_build_object('role', 'owner', 'active', true),
                     'app_metadata', jsonb_build_object('role', 'owner'))::text,
  true);
select is(pg_temp.who(), 'biller', 'A2, T-D06: a token that claims the owner role in its metadata does not make the biller an owner');
select tests.reset_role();
update auth.users set raw_user_meta_data = '{"role":"owner"}', raw_app_meta_data = '{"role":"owner"}' where id = current_setting('jv.biller')::uuid;
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.who(), 'biller', 'A2, T-D06: nor does a change of the login''s own metadata (what updateUser({data: {role: ''owner''}}) does)');
select tests.reset_role();
select is(pg_temp.who(), null, 'with nobody signed in the role is null');

-- ---------------------------------------------------------------- 5. who reads profiles (D1, A4, A10)
select set_config('jv.n_profiles', pg_temp.n_profiles()::text, true);
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.n_profiles(), current_setting('jv.n_profiles')::int, 'D1, A4: the owner reads every profile');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.n_profiles(), current_setting('jv.n_profiles')::int, 'D1, A4: a biller reads every profile');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.n_profiles(), current_setting('jv.n_profiles')::int, 'D1, A4: staff read every profile');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.n_profiles(), 0, 'T-D06, A10: an inactive profile reads nothing, not even its own row');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.n_profiles(), 0, 'A10: a login with no profile reads nothing');
select tests.as_anon();
select throws_ok('select * from public.profiles', '42501', null, 'A4: anon cannot read profiles at all');
select tests.reset_role();
select cmp_ok(current_setting('jv.n_profiles')::int, '>=', 8, 'the fixtures made the profiles the checks above count');

-- ---------------------------------------------------------------- 6. what an API role may do to the table (A4, S7)
select is(
  case when to_regclass('public.profiles') is null then null else has_table_privilege('authenticated', 'public.profiles', 'SELECT') end,
  true, 'A4: authenticated may select from profiles');
select is(
  case when to_regclass('public.profiles') is null then null
       else has_table_privilege('authenticated', 'public.profiles', 'INSERT, DELETE, TRUNCATE, REFERENCES, TRIGGER, UPDATE') end,
  false, 'A4, S7: and has no insert, delete, truncate or whole-table update');
select is(
  case when to_regclass('public.profiles') is null then null else
    array(select a from unnest(array['id', 'full_name', 'role', 'active', 'created_at', 'updated_at']) a
           where has_column_privilege('authenticated', 'public.profiles', a, 'UPDATE') order by 1) end,
  array['active', 'full_name', 'role'], 'A4: the only columns it may update are full_name, role and active');
select is(
  case when to_regclass('public.profiles') is null then null else
    has_table_privilege('anon', 'public.profiles', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
    or has_any_column_privilege('anon', 'public.profiles', 'SELECT, INSERT, UPDATE, REFERENCES') end,
  false, 'A4: anon has no right on profiles');
select is(
  (select array_agg(p.cmd || ':' || array_to_string(p.roles, ',') order by p.cmd) from pg_policies p where p.schemaname = 'public' and p.tablename = 'profiles'),
  array['SELECT:authenticated', 'UPDATE:authenticated'],
  'A7, A8: one policy per command, a select policy and an update policy, both for authenticated: biller and staff have no update policy');
select is(
  (select p.qual like '%app_role%owner%' from pg_policies p where p.tablename = 'profiles' and p.cmd = 'UPDATE'),
  true, 'A8: the update policy asks private.app_role() for owner');
select is(
  (select p.qual like '%app_role%IS NOT NULL%' from pg_policies p where p.tablename = 'profiles' and p.cmd = 'SELECT'),
  true, 'D1: the select policy asks private.app_role() for any role (an active profile)');

select tests.as_user(current_setting('jv.owner')::uuid);
select throws_ok(
  $$insert into public.profiles (id, full_name, role) values (gen_random_uuid(), 'X', 'staff')$$,
  '42501', null, 'S7: even the owner cannot insert a profile through the API (the trigger on auth.users makes them)');
select throws_ok($$delete from public.profiles where true$$, '42501', null, 'S7: nobody can delete a profile through the API');
select throws_ok(
  $$update public.profiles set created_at = now() where id = current_setting('jv.biller')::uuid$$,
  '42501', null, 'A4: a column outside full_name, role and active cannot be updated (created_at)');
select throws_ok(
  $$update public.profiles set updated_at = now() where id = current_setting('jv.biller')::uuid$$,
  '42501', null, 'A4: ... nor updated_at, which a trigger sets (S6)');
select throws_ok(
  $$update public.profiles set id = gen_random_uuid() where id = current_setting('jv.biller')::uuid$$,
  '42501', null, 'A4: ... nor id');

-- ---------------------------------------------------------------- 7. A8, T-D20: nobody changes their own role or active
select lives_ok(
  $$update public.profiles set role = 'staff', full_name = 'Renamed biller' where id = current_setting('jv.other')::uuid$$,
  'T-D20: the owner can change another profile''s role and name');
select is(pg_temp.profile_of(current_setting('jv.other')::uuid), 'staff/true/Renamed biller', 'T-D20: and it changed');
select lives_ok(
  $$update public.profiles set active = false where id = current_setting('jv.other')::uuid$$,
  'T-D20: the owner can deactivate another profile');
select is(pg_temp.profile_of(current_setting('jv.other')::uuid), 'staff/false/Renamed biller', 'T-D20: and it is no longer active');
select lives_ok(
  $$update public.profiles set role = 'owner', active = true where id = current_setting('jv.other')::uuid$$,
  'T-D20: the owner can make another login an owner, and active again');
select is(pg_temp.profile_of(current_setting('jv.other')::uuid), 'owner/true/Renamed biller', 'T-D20: and it changed');
select lives_ok(
  $$update public.profiles set full_name = 'Siddhi' where id = current_setting('jv.owner')::uuid$$,
  'T-D20: the owner can change her own name');
select lives_ok(
  $$update public.profiles set role = 'owner', active = true where id = current_setting('jv.owner')::uuid$$,
  'T-D20: an update that leaves her own role and active as they are is not refused');
select throws_like(
  $$update public.profiles set role = 'biller' where id = current_setting('jv.owner')::uuid$$,
  'JV_FORBIDDEN%', 'T-D20, A8: the owner cannot change her own role (JV_FORBIDDEN)');
select throws_like(
  $$update public.profiles set active = false where id = current_setting('jv.owner')::uuid$$,
  'JV_FORBIDDEN%', 'T-D20, A8: ... nor deactivate herself');
select throws_like(
  $$update public.profiles set role = 'staff', active = false, full_name = 'x' where id = current_setting('jv.owner')::uuid$$,
  'JV_FORBIDDEN%', 'T-D20, A8: ... nor as part of a bigger change');
select is(pg_temp.profile_of(current_setting('jv.owner')::uuid), 'owner/true/Siddhi', 'A8: she is still an active owner, with the new name');

select tests.as_user(current_setting('jv.biller')::uuid);
select is(
  pg_temp.affected($$update public.profiles set role = 'owner' where id = current_setting('jv.biller')::uuid$$),
  0, 'T-D20, A8: a biller cannot make herself an owner (no update policy: no row is updated)');
select is(
  pg_temp.affected($$update public.profiles set full_name = 'Hacked'$$),
  0, 'T-D20: a biller updates no profile at all, her own name included');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(
  pg_temp.affected($$update public.profiles set role = 'owner', active = true where id = current_setting('jv.staff')::uuid$$),
  0, 'T-D20, A8: staff cannot make themselves an owner either');
select is(
  pg_temp.affected($$update public.profiles set full_name = 'Hacked'$$),
  0, 'T-D20: staff update no profile at all');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(
  pg_temp.affected($$update public.profiles set active = true where id = current_setting('jv.inactive')::uuid$$),
  0, 'A10: an inactive profile cannot activate itself');
select tests.reset_role();
select is(pg_temp.profile_of(current_setting('jv.biller')::uuid) like 'biller/true/%', true, 'the biller is still a biller');
select is(pg_temp.profile_of(current_setting('jv.staff')::uuid) like 'staff/true/%', true, 'the staff member is still staff');
select is(pg_temp.profile_of(current_setting('jv.inactive')::uuid) like 'staff/false/%', true, 'the inactive profile is still inactive');
select is(pg_temp.n_profiles($$full_name = 'Hacked'$$), 0, 'and nobody''s name was changed');

-- an owner profile that is not active writes nothing (A10)
select pg_temp.run($$update public.profiles set role = 'owner' where id = current_setting('jv.inactive')::uuid$$);
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(
  pg_temp.affected($$update public.profiles set full_name = 'Hacked'$$),
  0, 'A10: an owner profile that is not active updates nothing');
select tests.reset_role();

-- the database owner (the SQL editor, the runbook) is not a signed-in user: it can do what the owner cannot do to herself
select lives_ok(
  $$update public.profiles set role = 'staff' where id = current_setting('jv.owner')::uuid$$,
  'A8: with nobody signed in (the SQL editor) a role can be changed, which is how the first owner is made');
select pg_temp.run($$update public.profiles set role = 'owner' where id = current_setting('jv.owner')::uuid$$);

-- ---------------------------------------------------------------- 8. private.activate_user (U3, T-E09)
select has_function('private', 'activate_user', array['text', 'text', 'text'], 'U3: private.activate_user(email, role, full_name) exists');
select is(
  case when to_regprocedure('private.activate_user(text,text,text)') is null then null
       else has_function_privilege('authenticated', 'private.activate_user(text,text,text)', 'EXECUTE')
            or has_function_privilege('anon', 'private.activate_user(text,text,text)', 'EXECUTE') end,
  false, 'U3, A3: only the database owner can run it, not a signed-in user and not anon');
select is(
  (select proconfig from pg_proc where oid = to_regprocedure('private.activate_user(text,text,text)')),
  array['search_path=""'], 'U3: it pins an empty search_path');
select is(pg_temp.profile_of(current_setting('jv.n_plain')::uuid), 'staff/false/aarti.shah', 'T-E09: before the snippet runs, the new login is inactive');
select tests.as_user(current_setting('jv.n_plain')::uuid);
select is(pg_temp.n_profiles(), 0, 'T-E09: ... and it reads nothing');
select tests.reset_role();

select is(pg_temp.activate('aarti.shah@jv-test.local', 'biller', 'Aarti Shah') ->> 'role', 'biller', 'T-E09: the snippet with the three values changed returns what it set');
select is(pg_temp.profile_of(current_setting('jv.n_plain')::uuid), 'biller/true/Aarti Shah', 'T-E09: and the profile is active with the new role and name');
select tests.as_user(current_setting('jv.n_plain')::uuid);
select is(pg_temp.who(), 'biller', 'T-E09: the activated login has its role');
select cmp_ok(pg_temp.n_profiles(), '>', 0, 'T-E09: and reads profiles');
select tests.reset_role();

select is(pg_temp.activate('  Aarti2@JV-Test.Local ', 'staff', '  Aarti S.  ') ->> 'full_name', 'Aarti S.', 'U3: the email is matched ignoring case and spaces, and the name is trimmed');
select is(pg_temp.profile_of(current_setting('jv.n_name')::uuid), 'staff/true/Aarti S.', 'U3: and it activated the right login');
select is(pg_temp.activate('aarti2@jv-test.local', 'owner', 'Aarti S.') ->> 'id', current_setting('jv.n_name'), 'U3: the result names the login (its id)');
select is(
  (select array_agg(k order by k) from jsonb_object_keys(coalesce(pg_temp.activate('aarti2@jv-test.local', 'staff', 'Aarti S.'), '{}')) k),
  array['active', 'email', 'full_name', 'id', 'role'], 'U3: the result shows email, id, name, role and active, so the snippet prints something to check');

select throws_like($$select private.activate_user('aarti2@jv-test.local', 'admin', 'X')$$, 'JV_INVALID_INPUT%', 'U3: a role that is not owner, biller or staff is refused');
select throws_like($$select private.activate_user('aarti2@jv-test.local', null, 'X')$$, 'JV_INVALID_INPUT%', 'U3: a missing role is refused');
select throws_like($$select private.activate_user('aarti2@jv-test.local', 'staff', '   ')$$, 'JV_INVALID_INPUT%', 'U3: a blank name is refused');
select throws_like($$select private.activate_user(null, 'staff', 'X')$$, 'JV_INVALID_INPUT%', 'U3: a missing email is refused');
select throws_like($$select private.activate_user('nobody@jv-test.local', 'staff', 'X')$$, 'JV_NOT_FOUND%', 'U3: an email with no login says so (create the login in the dashboard first)');
select is(pg_temp.profile_of(current_setting('jv.n_name')::uuid), 'staff/true/Aarti S.', 'U3: a refused call changes nothing');

select pg_temp.run($$delete from public.profiles where id = current_setting('jv.n_blank')::uuid$$);
select is(pg_temp.activate('blank.name@jv-test.local', 'staff', 'Blank Name') ->> 'active', 'true', 'U3: a login that has no profile (made before migration 0002) gets one');
select is(pg_temp.profile_of(current_setting('jv.n_blank')::uuid), 'staff/true/Blank Name', 'U3: and it is active');

-- ---------------------------------------------------------------- 9. the trigger on profiles (A8)
select is(
  (select array_agg(t.tgname::text order by t.tgname) from pg_trigger t
    where t.tgrelid = to_regclass('public.profiles') and not t.tgisinternal and t.tgname::text !~ 'set_updated_at'),
  array['profiles_protect_own_role'], 'A8: a trigger on profiles guards the role and active (profiles_protect_own_role)');
select is(
  (select (t.tgtype & 1) = 1 and (t.tgtype & 2) = 2 and (t.tgtype & 16) = 16 and (t.tgtype & 4) = 0 and (t.tgtype & 8) = 0
     from pg_trigger t where t.tgrelid = to_regclass('public.profiles') and t.tgname = 'profiles_protect_own_role'),
  true, 'A8: it is a row trigger that runs BEFORE UPDATE and only then');
select is(
  (select p.prosecdef from pg_trigger t join pg_proc p on p.oid = t.tgfoid
    where t.tgrelid = to_regclass('public.profiles') and t.tgname = 'profiles_protect_own_role'),
  false, 'A8: and runs with the rights of the caller (it only reads the request)');
select is(
  (select proconfig from pg_proc where oid = to_regprocedure('private.protect_own_profile()')),
  array['search_path=""'], 'T-D10: and pins an empty search_path');

select * from finish();
rollback;
