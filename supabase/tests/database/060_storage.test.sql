-- T-D21 (the database half), with the rules it rests on. DB07, migration 0014.
--
-- Spec lines: P1, P2, P3, A2, A7, S7 (the one exception). Everything runs in this transaction and is rolled back.
--
-- What is proved here:
--   * P1: the bucket design-photos exists, is public, holds files of at most 2 MiB (2,097,152 bytes) and only image/jpeg,
--     image/webp and image/png. The bucket is what refuses a 5 MB file and a non-image (HTTP 413 and 415); the Storage
--     service does the refusing, not a database rule, so the upload itself (a real 5 MB file) is the E2E half of T-D21 in
--     FE05. What the database owns, and what is checked here, is the bucket's settings.
--   * P3: one policy per command on storage.objects (lint 0006), each for authenticated only and each reading the role
--     from private.app_role() (A2). Owner and staff insert new objects; only the owner overwrites (update) or deletes; the
--     owner and staff list; a biller, anon, an inactive login and a login with no profile can neither add nor list nor
--     overwrite nor delete. A policy covers the one bucket: the same user can do nothing in another bucket.
--   * P1, "a public photo can be read": reading by URL is the Storage service's public route, which does not consult
--     storage.objects at all; the database's part is the public flag, checked here. The route itself is part of FE05.
--
-- The platform guards deletes from storage.objects with a statement trigger (storage.protect_delete) that refuses a delete
-- unless the setting storage.allow_delete_query is 'true'; the Storage service sets it for its own calls. The delete tests
-- set it too, so that they test our policy and not the platform's guard.
--
-- The helpers in pg_temp catch an error and report it, so a missing bucket or policy makes the assertions fail one by one
-- instead of stopping the file; they are granted to public so that they can be called while a role is impersonated.
begin;
select plan(67);

-- ---------------------------------------------------------------- helpers
-- 'ok <rows>' when the statement ran, 'err <sqlstate>' when it did not. Row-level security that hides a row from an update
-- or a delete is 'ok 0'; a missing privilege or a with-check violation is 'err 42501'.
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

-- How many rows of storage.objects the current role can see that match a condition, or 'err <sqlstate>'.
create function pg_temp.seen(p_where text) returns text language plpgsql as $f$
declare
  n bigint;
begin
  execute format('select count(*) from storage.objects where %s', p_where) into n;
  return n::text;
exception when others then
  return 'err ' || sqlstate;
end
$f$;

-- A fixture statement: a failure is reported as a notice and the file carries on, so one missing bucket is not fatal.
create function pg_temp.fx(p_sql text) returns void language plpgsql as $f$
begin
  execute p_sql;
exception when others then
  raise notice 'fixture failed: % (%) in: %', sqlerrm, sqlstate, left(p_sql, 100);
end
$f$;

-- The metadata of one fixture object, read as the database owner (so it can be called after a role was used), or null.
create function pg_temp.meta_of(p_name text) returns text language plpgsql security definer as $f$
begin
  return (select metadata::text from storage.objects where bucket_id = 'design-photos' and name = p_name);
end
$f$;

-- The text of the row condition ('using') or of the check ('check') of the policies of one command on storage.objects, joined;
-- '' when there is none. It never fails, so a policy that is missing or doubled makes an assertion fail and the file goes on.
create function pg_temp.pol(p_cmd text, p_part text) returns text language sql as $f$
  select coalesce(string_agg(case p_part when 'using' then coalesce(qual, '') else coalesce(with_check, '') end, ' | '), '')
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects' and cmd = p_cmd
$f$;

grant execute on function pg_temp.try(text), pg_temp.seen(text), pg_temp.fx(text), pg_temp.meta_of(text) to public;
grant execute on function pg_temp.pol(text, text) to public;

-- ---------------------------------------------------------------- 1. the bucket (P1)
select is((select count(*) from storage.buckets), 1::bigint, 'P1: one bucket exists');
select is((select count(*) from storage.buckets where id = 'design-photos' and name = 'design-photos'), 1::bigint, 'P1: it is design-photos');
select is((select public from storage.buckets where id = 'design-photos'), true, 'P1: the bucket is public (read by URL)');
select is((select file_size_limit from storage.buckets where id = 'design-photos'), 2097152::bigint, 'P1: a file may hold at most 2 MiB (2097152 bytes)');
select is(
  (select array_agg(m order by m) from storage.buckets b, unnest(b.allowed_mime_types) m where b.id = 'design-photos'),
  array['image/jpeg', 'image/png', 'image/webp'],
  'P1: only image/jpeg, image/webp and image/png');
select is((select type::text from storage.buckets where id = 'design-photos'), 'STANDARD', 'P1: a standard file bucket');

-- ---------------------------------------------------------------- 2. the policies (P3, A7, lint 0006)
select is((select relrowsecurity from pg_class where oid = 'storage.objects'::regclass), true, 'A1: row-level security is on for storage.objects');
select is(
  (select array_agg(p.polname || ':' || p.polcmd::text order by p.polname) from pg_policy p where p.polrelid = 'storage.objects'::regclass),
  array['design_photos_delete:d', 'design_photos_insert:a', 'design_photos_select:r', 'design_photos_update:w'],
  'P3, lint 0006: exactly one policy per command on storage.objects, and no policy for all commands');
select is(
  (select count(*) from (select polcmd from pg_policy where polrelid = 'storage.objects'::regclass group by polcmd having count(*) > 1) s),
  0::bigint, 'lint 0006: no two policies share a command');
select is(
  (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects' and roles = '{authenticated}' and permissive = 'PERMISSIVE'),
  4::bigint, 'P3: every policy is permissive and for authenticated alone (anon and public have none)');
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and coalesce(qual, '') || ' ' || coalesce(with_check, '') like '%app_role%'),
  4::bigint, 'A2, P3: every policy reads the role from private.app_role()');
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and coalesce(qual, '') || ' ' || coalesce(with_check, '') like '%design-photos%'),
  4::bigint, 'P3: every policy is limited to the bucket design-photos');
select is(
  (select count(*) from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and coalesce(qual, '') || ' ' || coalesce(with_check, '') ~* 'user_metadata|app_metadata|jwt|meta_data'),
  0::bigint, 'A2: no policy reads the token or the login''s metadata');
select is(
  pg_temp.pol('DELETE', 'using') ~ 'owner' and pg_temp.pol('DELETE', 'using') !~ 'staff|biller' and pg_temp.pol('DELETE', 'check') = '',
  true, 'P3: delete is the owner''s alone (a row condition, and no check, as for every delete policy)');
select is(
  pg_temp.pol('UPDATE', 'using') ~ 'owner' and pg_temp.pol('UPDATE', 'using') !~ 'staff|biller'
  and pg_temp.pol('UPDATE', 'check') ~ 'owner' and pg_temp.pol('UPDATE', 'check') !~ 'staff|biller',
  true, 'P3: overwrite (update) is the owner''s alone, with a check on the new row (an object cannot be moved out of its bucket)');
select is(
  pg_temp.pol('INSERT', 'check') ~ 'owner' and pg_temp.pol('INSERT', 'check') ~ 'staff' and pg_temp.pol('INSERT', 'check') !~ 'biller'
  and pg_temp.pol('INSERT', 'using') = '',
  true, 'P3: insert is for the owner and staff (a check on the new row)');
select is(
  pg_temp.pol('SELECT', 'using') ~ 'owner' and pg_temp.pol('SELECT', 'using') ~ 'staff' and pg_temp.pol('SELECT', 'using') !~ 'biller'
  and pg_temp.pol('SELECT', 'check') = '',
  true, 'P3: listing is for the owner and staff (a row condition)');

-- ---------------------------------------------------------------- 3. the fixtures
do $mk$
begin
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);
  perform set_config('jv.none', tests.make_user('none')::text, true);
  perform set_config('jv.dir', 'designs/' || gen_random_uuid()::text, true);
end
$mk$;

-- A second bucket, to prove that the policies reach design-photos and nothing else.
select pg_temp.fx($q$insert into storage.buckets (id, name, public) values ('fx-other', 'fx-other', false)$q$);
-- Four photos in design-photos and one in the other bucket, put there by the database owner (the Storage service writes the
-- same columns when a file is uploaded).
select pg_temp.fx(format($q$insert into storage.objects (bucket_id, name, metadata) values
  ('design-photos', %1$L, '{"v": 1}'), ('design-photos', %2$L, '{"v": 1}'), ('design-photos', %3$L, '{"v": 1}'),
  ('design-photos', %4$L, '{"v": 1}'), ('fx-other', %5$L, '{"v": 1}')$q$,
  current_setting('jv.dir') || '/list1.jpg', current_setting('jv.dir') || '/list2.jpg', current_setting('jv.dir') || '/upd.jpg',
  current_setting('jv.dir') || '/del.jpg', current_setting('jv.dir') || '/other.jpg'));

select is((select count(*) from storage.objects where name like current_setting('jv.dir') || '/%'), 5::bigint, 'fixture: five objects exist');

-- ---------------------------------------------------------------- 4. listing (P3: a biller and anon cannot list)
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')), '4', 'P3: the owner lists the photos of the bucket');
select is(pg_temp.seen(format($$bucket_id = 'fx-other' and name like %L$$, current_setting('jv.dir') || '/%')), '0', 'P3: the owner sees nothing of another bucket');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')), '4', 'P3: staff lists the photos of the bucket');
select is(pg_temp.seen(format($$bucket_id = 'fx-other' and name like %L$$, current_setting('jv.dir') || '/%')), '0', 'P3: staff sees nothing of another bucket');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')), '0', 'P3: a biller cannot list');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')), '0', 'A10: an inactive login cannot list');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')), '0', 'A10: a login with no profile cannot list');
select tests.as_anon();
select ok(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')) in ('0', 'err 42501'), 'P3: anon cannot list');
select tests.reset_role();

-- ---------------------------------------------------------------- 5. adding a photo (P3: only the owner and staff insert new objects)
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_owner.jpg')), 'ok 1', 'P3: the owner can add a photo');
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('fx-other', %L)$$, current_setting('jv.dir') || '/t_owner.jpg')), 'err 42501', 'P3: the owner cannot add to another bucket (the policy is for design-photos)');
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_staff.jpg')), 'ok 1', 'P3: staff can add a photo');
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('fx-other', %L)$$, current_setting('jv.dir') || '/t_staff.jpg')), 'err 42501', 'P3: staff cannot add to another bucket');
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/list1.jpg')), 'err 23505', 'P3: adding a name that exists is a conflict, not an overwrite (an overwrite is an update, the owner''s)');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_biller.jpg')), 'err 42501', 'P3: a biller cannot add a photo');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_inactive.jpg')), 'err 42501', 'A10: an inactive login cannot add a photo');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_none.jpg')), 'err 42501', 'A10: a login with no profile cannot add a photo');
select tests.as_anon();
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_anon.jpg')), 'err 42501', 'P3: anon cannot add a photo');
select tests.reset_role();
select is((select count(*) from storage.objects where bucket_id = 'design-photos' and name like current_setting('jv.dir') || '/t\_%'), 2::bigint, 'P3: only the two photos of the owner and staff were added');

-- ---------------------------------------------------------------- 6. overwriting (P3: only the owner)
-- An overwrite through the Storage service is an update of the existing row (upsert); the row stays where it is.
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'ok 0', 'P3: staff cannot overwrite a photo (they see it, the update policy hides it)');
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/t_staff.jpg')), 'ok 0', 'P3: staff cannot overwrite even a photo they added');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'ok 0', 'P3: a biller cannot overwrite a photo');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'ok 0', 'A10: an inactive login cannot overwrite a photo');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'ok 0', 'A10: a login with no profile cannot overwrite a photo');
select tests.as_anon();
select ok(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')) in ('ok 0', 'err 42501'), 'P3: anon cannot overwrite a photo');
select tests.reset_role();
select is(pg_temp.meta_of(current_setting('jv.dir') || '/upd.jpg'), '{"v": 1}', 'P3: after every refused attempt the photo is as it was');

select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'fx-other' and name = %L$$, current_setting('jv.dir') || '/other.jpg')), 'ok 0', 'P3: the owner cannot change an object of another bucket');
select is(pg_temp.try(format($$update storage.objects set bucket_id = 'fx-other' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'err 42501', 'P3: the owner cannot move a photo out of the bucket (the check on the new row)');
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 2}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'ok 1', 'P3: the owner can overwrite a photo');
select tests.reset_role();
select is(pg_temp.meta_of(current_setting('jv.dir') || '/upd.jpg'), '{"v": 2}', 'P3: and the photo is what the owner wrote');

-- ---------------------------------------------------------------- 7. deleting (P3: only the owner)
-- The platform's guard (storage.protect_delete) is satisfied the way the Storage service satisfies it, for this transaction.
select set_config('storage.allow_delete_query', 'true', true);
select tests.as_user(current_setting('jv.staff')::uuid);
select is(pg_temp.try(format($$delete from storage.objects where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/del.jpg')), 'ok 0', 'P3: staff cannot delete a photo');
select tests.as_user(current_setting('jv.biller')::uuid);
select is(pg_temp.try(format($$delete from storage.objects where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/del.jpg')), 'ok 0', 'P3: a biller cannot delete a photo');
select tests.as_user(current_setting('jv.inactive')::uuid);
select is(pg_temp.try(format($$delete from storage.objects where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/del.jpg')), 'ok 0', 'A10: an inactive login cannot delete a photo');
select tests.as_user(current_setting('jv.none')::uuid);
select is(pg_temp.try(format($$delete from storage.objects where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/del.jpg')), 'ok 0', 'A10: a login with no profile cannot delete a photo');
select tests.as_anon();
select ok(pg_temp.try(format($$delete from storage.objects where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/del.jpg')) in ('ok 0', 'err 42501'), 'P3: anon cannot delete a photo');
select tests.reset_role();
select is((select count(*) from storage.objects where bucket_id = 'design-photos' and name = current_setting('jv.dir') || '/del.jpg'), 1::bigint, 'P3: after every refused attempt the photo is still there');

select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.try(format($$delete from storage.objects where bucket_id = 'fx-other' and name = %L$$, current_setting('jv.dir') || '/other.jpg')), 'ok 0', 'P3: the owner cannot delete an object of another bucket');
select is(pg_temp.try(format($$delete from storage.objects where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/del.jpg')), 'ok 1', 'P3: the owner can delete a photo');
select tests.reset_role();
select is((select count(*) from storage.objects where bucket_id = 'design-photos' and name = current_setting('jv.dir') || '/del.jpg'), 0::bigint, 'P3: and it is gone');
select is((select count(*) from storage.objects where bucket_id = 'fx-other' and name = current_setting('jv.dir') || '/other.jpg'), 1::bigint, 'P3: the object of the other bucket is still there');

-- ---------------------------------------------------------------- 8. the role comes from the profile, never from the token (A2)
-- A biller whose token claims to be the owner, in every place a token can say so, is still a biller.
select set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('jv.biller'), 'role', 'authenticated', 'aud', 'authenticated',
  'app_metadata', jsonb_build_object('role', 'owner', 'app_role', 'owner'),
  'user_metadata', jsonb_build_object('role', 'owner', 'app_role', 'owner'),
  'app_role', 'owner', 'user_role', 'owner')::text, true);
set local role authenticated;
select is(pg_temp.try(format($$insert into storage.objects (bucket_id, name) values ('design-photos', %L)$$, current_setting('jv.dir') || '/t_forged.jpg')), 'err 42501', 'A2: a biller whose token says owner cannot add a photo');
select is(pg_temp.seen(format($$bucket_id = 'design-photos' and name like %L$$, current_setting('jv.dir') || '/%')), '0', 'A2: or list');
select is(pg_temp.try(format($$update storage.objects set metadata = '{"v": 3}' where bucket_id = 'design-photos' and name = %L$$, current_setting('jv.dir') || '/upd.jpg')), 'ok 0', 'A2: or overwrite');
select tests.reset_role();

-- ---------------------------------------------------------------- 9. the test helper that clears photos (supabase/seeds/10_test_helpers.sql, block DB07)
-- tests.reset_business_data() does not touch storage; a test that had to commit a photo clears it with tests.reset_storage().
select has_function('tests', 'reset_storage', array[]::text[], 'helper: tests.reset_storage() exists');
select is(has_function_privilege('anon', 'tests.reset_storage()', 'EXECUTE'), false, 'helper: anon cannot run it');
select is(has_function_privilege('authenticated', 'tests.reset_storage()', 'EXECUTE'), false, 'helper: authenticated cannot run it');
select ok((select tests.reset_storage()) >= 5, 'helper: it deletes the objects (and says how many)');
select is((select count(*) from storage.objects), 0::bigint, 'helper: no object is left');
select is((select count(*) from storage.buckets where id = 'design-photos'), 1::bigint, 'helper: the bucket of migration 0014 is kept');
select is((select public from storage.buckets where id = 'design-photos'), true, 'helper: and it is still public');

select * from finish();
rollback;
