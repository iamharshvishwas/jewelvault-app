-- 0014 photo storage (task DB07). Spec: P1, P2, P3, A2, A7, S7 (the one exception), F16.
-- Tests: supabase/tests/database/060_storage.test.sql (T-D21, the database half). The upload half of T-D21 (a real 5 MB file and a
-- non-image refused by the bucket, a photo read by its URL) is FE05, because it needs the Storage service and a login.
--
-- One bucket, design-photos, holds the photos of designs. The paths are designs/<design_id>/<uuid>.jpg and
-- designs/<design_id>/t_<uuid>.jpg (P2); the screen makes the design's id before it uploads. The bucket is what refuses a bad
-- file: the Storage service reads file_size_limit and allowed_mime_types on every upload and answers 413 or 415, so no policy
-- below looks at the size or the type of a file.
--
-- The file may be run again (the policies on storage.objects and the bucket settings are on the list of things a dump does
-- not bring back, B2, and the restore drill applies them again, B4): the bucket is an upsert and each policy is dropped before
-- it is made.

-- ---------------------------------------------------------------- P1: the bucket
-- public: a photo is read by its URL, with no login and no policy (the photos also appear in the later public catalogue,
-- O11: public, with paths nobody can guess). 2 MB is read as 2 MiB, 2,097,152 bytes, the unit of the Supabase dashboard.
-- Only the three image types the screen produces or accepts.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('design-photos', 'design-photos', true, 2097152, array['image/jpeg', 'image/webp', 'image/png'])
on conflict (id) do update
  set name = excluded.name,
      public = excluded.public,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

-- ---------------------------------------------------------------- P3: who may do what to the objects of the bucket
-- storage.objects already has row-level security on and belongs to the Storage service. anon and authenticated hold the
-- table rights, so the policies are the only gate. One policy per command (lint 0006), each for authenticated alone (anon
-- gets none, so anon can neither add nor list nor change anything), each limited to this bucket and each reading the role
-- from private.app_role() (A2): the role of a person with an active profile, never anything the token says.
--
--   insert  owner, staff   a new photo. A photo is never replaced in place: the screen uploads a new file under a new uuid and
--                          updates the design's path list, so staff need no more than this.
--   select  owner, staff   the Storage service's listing, and the row that an overwrite or a delete reads: Postgres applies the
--                          select policy to an update or a delete that has a where clause, and the service's upsert reads before
--                          it writes. Reading a photo by its URL does not use this policy (the bucket is public).
--   update  owner          overwrite an object (upload with upsert, a move or a rename). The check on the new row keeps an
--                          object from being moved out of this bucket.
--   delete  owner          the one place a file is deleted; it is not a business table, so S7 does not apply.
--
-- A biller, an inactive login, a login with no profile and anon have no role here, so they can do none of the four. Tried on
-- the Storage service as well as in SQL on 15 October 2026 (storage-api v1.79): staff upload a new object, an upload with
-- upsert over an existing object is refused for staff; billers and anon are refused everywhere; a delete by anyone but the
-- owner removes nothing.
--
-- Lint 0025 (a public bucket whose objects can be listed) is accepted for design-photos, as A7 says: the select policy lets
-- the owner and staff list the bucket and nobody else. The advisor of the local CLI does not report it; the hosted one may.
drop policy if exists design_photos_select on storage.objects;
create policy design_photos_select on storage.objects
  for select to authenticated
  using (bucket_id = 'design-photos' and (select private.app_role()) in ('owner', 'staff'));

drop policy if exists design_photos_insert on storage.objects;
create policy design_photos_insert on storage.objects
  for insert to authenticated
  with check (bucket_id = 'design-photos' and (select private.app_role()) in ('owner', 'staff'));

drop policy if exists design_photos_update on storage.objects;
create policy design_photos_update on storage.objects
  for update to authenticated
  using (bucket_id = 'design-photos' and (select private.app_role()) = 'owner')
  with check (bucket_id = 'design-photos' and (select private.app_role()) = 'owner');

drop policy if exists design_photos_delete on storage.objects;
create policy design_photos_delete on storage.objects
  for delete to authenticated
  using (bucket_id = 'design-photos' and (select private.app_role()) = 'owner');
