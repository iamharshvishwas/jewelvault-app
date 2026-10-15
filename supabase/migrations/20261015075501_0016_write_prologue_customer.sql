-- 0016 the write prologue and create_customer (task DB09a). Spec: X0, X6, A6, A7, L5, S8, D10, K5.
-- Tests: supabase/tests/database/075_customer.test.sql (T-F06, and the part of T-D09 that X6 completes).
--
-- What every function that writes follows (X0), made once here so that each of them is a few lines and none can forget a step:
--
--   private.begin_write(request, fn, args, roles)   X0 items 1 and 2: the idempotency insert, then the caller's role
--   private.lock_customer(customer)                 X0 item 3: the customer row FOR UPDATE, handed back as the row that was read
--   private.test_pause(p_point)                     X0 item 8: the empty hook a test replaces by a wait
--
-- THE SHAPE OF A WRITING FUNCTION, which DB09b onward copy (create_customer below is the shortest one):
--
--   create or replace function public.<fn>(p_request_id uuid, ...) returns jsonb
--   language plpgsql security definer set search_path = '' set lock_timeout = '5s'      -- item 7: a clause of CREATE FUNCTION,
--   as $$                                                                                -- so it also covers the idempotency insert
--   declare v_stored jsonb; v_customer public.customers; ...
--   begin
--     v_stored := private.begin_write(p_request_id, '<fn>', jsonb_build_object('p_customer_id', p_customer_id, ... every argument),
--                                     array['owner', 'biller']);                           -- items 1 and 2
--     if v_stored is not null then return v_stored; end if;                                -- a repeat: the stored answer
--     v_customer := private.lock_customer(p_customer_id);                                  -- item 3 (X4, X5, X10 read the receipt or
--                                                                                          -- the bill first, lock, read it again)
--     ... checks that read the customer's state (archived, advance, ...) ...
--     perform private.test_pause('<fn>.after_read');                                       -- item 8, once, after the read
--     ... allocate from what was read above; the pieces by id (item 5); the number counter LAST (item 6) ...
--     return private.idem_finish(p_request_id, jsonb_build_object(...));                   -- the answer is stored in the same transaction
--   exception when lock_not_available then                                                 -- item 7: 55P03
--     perform private.jv_error('JV_BUSY', 'The system is busy; try again');                -- the screen retries once with the same id
--   end $$;
--   revoke all on function public.<fn>(...) from public, anon;
--   grant execute on function public.<fn>(...) to authenticated;                           -- A6, and lint 0029 is intentional (A7)
--
-- The lock is in private.lock_customer (the one place the words FOR UPDATE are for the customer), so the negative control of
-- T-C09 to T-C14 cuts it out of that function (tests/db/hook.ts, dropClause(/for update/gi)) and every money function loses it
-- at once. The hook is called from the writing function, not from a helper, because its point is the function's own name.
--
-- The stock functions (X8, X9) do not use these helpers: they take no customer lock and have no hook (X0 items 5 and 6 only).

-- ---------------------------------------------------------------- X0 item 8: the hook
-- Empty in production. A test replaces it, committed, by a function that waits at a gate (tests/db/hook.ts) and puts this one
-- back afterwards. create or replace cannot rename a parameter, so the name below is the one the replacement copies: p_point.
create or replace function private.test_pause(p_point text)
returns void
language plpgsql
set search_path = ''
as $$
begin
  null;
end
$$;
revoke all on function private.test_pause(text) from public, anon, authenticated;
comment on function private.test_pause(text) is 'X0 item 8: the test hook. Every money function calls it once, with ''<function>.after_read'', after it has read the customer''s state and before it allocates. Empty in production; a test replaces it with a wait and restores it.';

-- ---------------------------------------------------------------- X0 items 1 and 2: the first two steps
-- The first statement of a writing function (L5): the request is recorded through private.idem_begin, whose wait for a twin that
-- is still in flight is cut by the calling function's own SET lock_timeout. A repeat of the same request (same function, same
-- caller, same arguments) returns the stored answer, and the function returns it as it is. Otherwise the caller's role must be
-- one of p_roles, else JV_FORBIDDEN; the role is read from the profile (A2), so a login that is not active, has no profile, or is
-- not signed in at all has none. A list of roles that is empty or null refuses everybody. A refusal raises, the whole call rolls
-- back with it, and the request leaves no row behind, so it can be sent again.
-- p_args is every argument of the function as one jsonb object: the same request id with other arguments is refused (L5).
-- Returns null when the function is to carry on.
create or replace function private.begin_write(p_request_id uuid, p_fn text, p_args jsonb, p_roles text[])
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_stored jsonb;
  v_role text;
begin
  v_stored := private.idem_begin(p_request_id, p_fn, private.idem_hash(p_args));
  if v_stored is not null then
    return v_stored;
  end if;
  v_role := (select private.app_role());
  if v_role is null or p_roles is null or v_role <> all (p_roles) then
    perform private.jv_error('JV_FORBIDDEN', format('Your role (%s) may not do this (%s)', coalesce(v_role, 'none'), p_fn));
  end if;
  return null;
end
$$;
revoke all on function private.begin_write(uuid, text, jsonb, text[]) from public, anon, authenticated;
comment on function private.begin_write(uuid, text, jsonb, text[]) is 'X0 items 1 and 2, L5: the first two steps of a writing function. Records the request (the stored answer of a repeat is returned), then checks the caller''s role against p_roles (JV_FORBIDDEN). Null means carry on.';

-- ---------------------------------------------------------------- X0 item 3: the customer lock
-- The customer row is locked FOR UPDATE and returned as it is now: under READ COMMITTED the row that comes back is the latest
-- committed version, after any writer that held the lock has finished. The function then decides from that row and from what
-- it reads next, before it calls the hook. An archived customer is returned like any other; what that means is the caller's
-- (X1 refuses it with JV_CUSTOMER_ARCHIVED). No customer id is JV_INVALID_INPUT, an id that matches no row JV_NOT_FOUND.
create or replace function private.lock_customer(p_customer_id uuid)
returns public.customers
language plpgsql
set search_path = ''
as $$
declare
  v_customer public.customers;
begin
  if p_customer_id is null then
    perform private.jv_error('JV_INVALID_INPUT', 'A customer is needed');
  end if;
  select c.* into v_customer
    from public.customers c
   where c.id = p_customer_id
     for update;
  if not found then
    perform private.jv_error('JV_NOT_FOUND', 'No such customer');
  end if;
  return v_customer;
end
$$;
revoke all on function private.lock_customer(uuid) from public, anon, authenticated;
comment on function private.lock_customer(uuid) is 'X0 item 3: locks the customer row and returns it as it is now. The lock every money function takes before it reads a bill, receipt or allocation of that customer; held until the transaction ends.';

-- ---------------------------------------------------------------- X6: create_customer
-- The owner and the biller create a customer; staff and anon cannot (A4: nobody can insert into customers through the API, the
-- function and the import write them). The customer is saved before the bill that names them (hazard 1), with a request id of its
-- own (L5): a double click or a retry gives back the customer that was made, never a second one.
--
-- Inputs are checked here and refused with JV_INVALID_INPUT, so that a screen gets a code it has a message for and never the raw
-- error of a CHECK (S8). The rules are those of D10 and Z3:
--   * the name is 1 to 120 characters once the spaces round it are taken off (they are not stored);
--   * the mobile number is required: ten digits, or + and 7 to 15 digits for a foreign number. Spaces and dashes are taken out
--     by the screen on entry, so a number that still has one is refused here as it is by the table. A blank number is not allowed
--     here at all: only an imported customer may have none, and import_batch_id is not an argument;
--   * the type is Retail, Semi-Wholesale or Wholesale; none means Retail;
--   * the PAN, when there is one, is five capitals, four digits and a capital; it is checked as sent (no trimming, no case change);
--   * email, address, GST number, PAN and notes that are empty or only spaces are stored as none; the others as they were sent.
-- is_walkin is not an argument and is never set: the walk-in is the one row the seeds make (K5). The answer is {"customer": row},
-- the row as stored (ids, stamps and person columns included), which the cache applies as it is (C5(b)).
create or replace function public.create_customer(
  p_request_id uuid,
  p_name text,
  p_mobile text,
  p_customer_type text default 'Retail',
  p_email text default null,
  p_address text default null,
  p_gst_number text default null,
  p_pan text default null,
  p_notes text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
set lock_timeout = '5s'
as $$
declare
  v_stored jsonb;
  v_name text;
  v_type text;
  v_pan text;
  v_customer public.customers;
begin
  v_stored := private.begin_write(
    p_request_id, 'create_customer',
    jsonb_build_object(
      'p_name', p_name, 'p_mobile', p_mobile, 'p_customer_type', p_customer_type, 'p_email', p_email, 'p_address', p_address,
      'p_gst_number', p_gst_number, 'p_pan', p_pan, 'p_notes', p_notes),
    array['owner', 'biller']);
  if v_stored is not null then
    return v_stored;
  end if;

  v_name := btrim(p_name, E' \t\r\n');
  if v_name is null or v_name = '' then
    perform private.jv_error('JV_INVALID_INPUT', 'The customer needs a name');
  end if;
  if char_length(v_name) > 120 then
    perform private.jv_error('JV_INVALID_INPUT', 'The name is longer than 120 characters');
  end if;
  if p_mobile is null or p_mobile !~ '^([0-9]{10}|\+[0-9]{7,15})$' then
    perform private.jv_error('JV_INVALID_INPUT', 'The mobile number must be ten digits, or + and 7 to 15 digits (spaces and dashes taken out)');
  end if;
  v_type := coalesce(p_customer_type, 'Retail');
  if v_type not in ('Retail', 'Semi-Wholesale', 'Wholesale') then
    perform private.jv_error('JV_INVALID_INPUT', 'The customer type must be Retail, Semi-Wholesale or Wholesale');
  end if;
  v_pan := nullif(btrim(p_pan, E' \t\r\n'), '');
  if v_pan is not null then
    v_pan := p_pan;
    if v_pan !~ '^[A-Z]{5}[0-9]{4}[A-Z]$' then
      perform private.jv_error('JV_INVALID_INPUT', 'The PAN must be five capital letters, four digits and one capital letter');
    end if;
  end if;

  insert into public.customers (name, mobile, customer_type, email, address, gst_number, pan, notes)
  values (
    v_name, p_mobile, v_type,
    nullif(btrim(p_email, E' \t\r\n'), ''), nullif(btrim(p_address, E' \t\r\n'), ''), nullif(btrim(p_gst_number, E' \t\r\n'), ''),
    v_pan, nullif(btrim(p_notes, E' \t\r\n'), ''))
  returning * into v_customer;

  return private.idem_finish(p_request_id, jsonb_build_object('customer', to_jsonb(v_customer)));
exception
  when lock_not_available then
    perform private.jv_error('JV_BUSY', 'The system is busy; please try again');
end
$$;
revoke all on function public.create_customer(uuid, text, text, text, text, text, text, text, text) from public, anon;
grant execute on function public.create_customer(uuid, text, text, text, text, text, text, text, text) to authenticated;
comment on function public.create_customer(uuid, text, text, text, text, text, text, text, text) is 'X6: creates a customer (owner and biller), never the walk-in. Returns {"customer": the row}. A repeat of the same request returns the stored answer; the same id with other arguments is refused. Callable by signed-in users by design (advisor lint 0029 is intentional, A7).';
