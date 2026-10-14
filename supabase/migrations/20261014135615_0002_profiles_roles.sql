-- 0002 profiles and roles (task DB02). Spec: D1, D2, S10, A2, A4 (the profiles row), A8, A10, U3.
-- Tests: supabase/tests/database/011_profiles.test.sql (T-D06, T-D20, T-E09) and tests/db/auth.test.ts.
--
-- The role of a signed-in user comes from this table and nowhere else (A2): never from the token, never from the user's
-- metadata, which the user can edit. A login that is not active, or has no profile, can read and write nothing (A10).

-- ---------------------------------------------------------------- D1: the table
-- A profile goes with its login: deleting a login through the Auth service (the dashboard, or the admin API that the test
-- harness uses) deletes its profile. This is the one foreign key that is not restrict, because a profile has no life of
-- its own; a later table that names a person can point at profiles with restrict (S7), and then a login that has done
-- anything cannot be deleted either. created_at and updated_at are stamped by the trigger of migration 0003 (S6).
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null constraint profiles_full_name_not_blank check (btrim(full_name) <> ''),
  role text not null constraint profiles_role_check check (role in ('owner', 'biller', 'staff')),
  active boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.profiles enable row level security;
comment on table public.profiles is 'D1: one row per login. role is owner, biller or staff; active is false until somebody activates the login (private.activate_user).';

-- ---------------------------------------------------------------- D2: the helper every policy calls
-- Security definer, so that it reads profiles without going through the policies that call it; stable, with an empty
-- search_path (A6). It answers the role of an active profile and null otherwise. Policies call it as
-- (select private.app_role()), so Postgres runs it once per statement.
create or replace function private.app_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select p.role
    from public.profiles p
   where p.id = auth.uid() and p.active
$$;
revoke all on function private.app_role() from public, anon;
grant execute on function private.app_role() to authenticated;
comment on function private.app_role() is 'D2, S10: the caller''s role when their profile is active, else null. The only function of private that authenticated may run (A3).';

-- ---------------------------------------------------------------- A4: who may read and update profiles
-- Every active user reads every profile (the screens show who created or changed something). Only the owner updates, and
-- only the three columns below. Nobody inserts or deletes through the API: the trigger on auth.users makes the rows (S7).
-- One policy per command (lint 0006).
grant select on public.profiles to authenticated;
grant update (full_name, role, active) on public.profiles to authenticated;

create policy profiles_select on public.profiles
  for select to authenticated
  using ((select private.app_role()) is not null);

create policy profiles_update on public.profiles
  for update to authenticated
  using ((select private.app_role()) = 'owner')
  with check ((select private.app_role()) = 'owner');

-- ---------------------------------------------------------------- D1: every new login gets a profile that can do nothing
-- A login made in the Supabase dashboard has no metadata. The profile is inactive staff, named by the metadata's full_name
-- when the login has one, else by the part of the email before the @, else "New user" (a login with no email must still
-- be made). The role and active never come from the metadata. The function is security definer because the Auth service,
-- which inserts the login, may not write public.profiles.
create or replace function private.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, full_name, role, active)
  values (
    new.id,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(split_part(coalesce(new.email, ''), '@', 1)), ''),
      'New user'
    ),
    'staff',
    false
  )
  on conflict (id) do nothing;
  return new;
end
$$;
comment on function private.handle_new_user() is 'D1: trigger function. Gives every new login an inactive staff profile.';

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- ---------------------------------------------------------------- A8: nobody changes their own role or active
-- The owner can change another profile, but not her own role or whether she is active, so she cannot lock herself out
-- or promote herself; a biller and staff have no update policy at all. Somebody who is not signed in (the SQL editor, a
-- repair script, the service role) is not a user and may change any profile; that is how the first owner is made (U3).
-- The error starts with the stable code of S8 (migration 0003 adds private.jv_error for the functions that come later).
create or replace function private.protect_own_profile()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if auth.uid() is not null
     and old.id = auth.uid()
     and (new.role is distinct from old.role or new.active is distinct from old.active) then
    raise exception 'JV_FORBIDDEN: you cannot change your own role or whether you are active' using errcode = 'P0001';
  end if;
  return new;
end
$$;
comment on function private.protect_own_profile() is 'A8: trigger function. Refuses a change of the signed-in user''s own role or active.';

create trigger profiles_protect_own_role
  before update on public.profiles
  for each row execute function private.protect_own_profile();

-- ---------------------------------------------------------------- U3: the runbook snippet
-- Logins are made by Harsh in the Supabase dashboard (Authentication, Users, Add user, auto-confirmed). Then, in the SQL
-- editor, with three values changed:
--
--   select private.activate_user('person@example.com', 'biller', 'Full Name');
--
-- It sets the real name, the role (owner, biller or staff) and active = true, and returns what it set so the result can
-- be checked. It also makes the profile of a login that has none (a login made before this migration). Only the database
-- owner can run it: it is not granted to anyone.
create or replace function private.activate_user(p_email text, p_role text, p_full_name text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_email text := lower(btrim(p_email));
  v_name text := btrim(p_full_name);
  v_ids uuid[];
  v_login_email text;
  v_row public.profiles;
begin
  if v_email is null or v_email = '' then
    raise exception 'JV_INVALID_INPUT: the email must not be blank';
  end if;
  if p_role is null or p_role not in ('owner', 'biller', 'staff') then
    raise exception 'JV_INVALID_INPUT: the role must be owner, biller or staff';
  end if;
  if v_name is null or v_name = '' then
    raise exception 'JV_INVALID_INPUT: the full name must not be blank';
  end if;

  select array_agg(u.id), min(u.email) into v_ids, v_login_email
    from auth.users u
   where lower(u.email) = v_email;
  if v_ids is null then
    raise exception 'JV_NOT_FOUND: no login has the email %. Make the login in the Supabase dashboard first (Authentication, Users, Add user).', v_email;
  end if;
  if cardinality(v_ids) > 1 then
    raise exception 'JV_INVALID_INPUT: more than one login has the email %', v_email;
  end if;

  insert into public.profiles (id, full_name, role, active)
  values (v_ids[1], v_name, p_role, true)
  on conflict (id) do update
    set full_name = excluded.full_name, role = excluded.role, active = true
  returning * into v_row;

  return jsonb_build_object(
    'id', v_row.id, 'email', v_login_email, 'full_name', v_row.full_name, 'role', v_row.role, 'active', v_row.active
  );
end
$$;
revoke all on function private.activate_user(text, text, text) from public, anon, authenticated;
comment on function private.activate_user(text, text, text) is 'U3: the runbook snippet. Sets the real name, the role and active = true on the profile of the login with that email. Run by the database owner in the SQL editor.';
