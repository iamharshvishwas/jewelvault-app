-- 0003 common triggers and helpers (task DB02). Spec: S4, S5, S6, S8, D18, D22, A1; section 13 and I11 for the constants.
-- Tests: supabase/tests/database/012_common_triggers.test.sql.
--
-- Everything the tables and functions of the later migrations share, made early so that they have a target: the clock, the
-- error helper, the stamp and person-column triggers, and the two private tables that other tables point at.

-- ---------------------------------------------------------------- S5: the clock seam
-- The only place the code asks for the time. It is volatile, as clock_timestamp() is: it is the moment of the call, not
-- the start of the transaction. A test fixes the clock by replacing this one function inside its own rolled-back
-- transaction (tests.set_clock); nobody else can reach it (private is not exposed and nobody but the owner may run it).
create or replace function private.now_ts()
returns timestamptz
language sql
volatile
set search_path = ''
as $$ select clock_timestamp() $$;
comment on function private.now_ts() is 'S5: the clock seam. Returns clock_timestamp(). Every function and trigger takes the time from here.';

-- The business day: the date in India. A bill saved at 00:30 on the 1st is in the new month, whatever UTC says.
create or replace function private.today()
returns date
language sql
volatile
set search_path = ''
as $$ select (private.now_ts() at time zone 'Asia/Kolkata')::date $$;
comment on function private.today() is 'S5: the business date in Asia/Kolkata, from private.now_ts().';

-- ---------------------------------------------------------------- S8: the stable error codes
-- The twelve codes of S8, raised as RAISE EXCEPTION with the code at the start of the message, so the screens can map each
-- one to a plain message:   perform private.jv_error('JV_FORBIDDEN', 'Only the owner may void a receipt');
-- A code that is not on the list is itself an error (a typo must not reach a screen as an unknown message).
create or replace function private.jv_error(p_code text, p_text text default null)
returns void
language plpgsql
set search_path = ''
as $$
begin
  if p_code is null or p_code not in (
       'JV_FORBIDDEN', 'JV_INVALID_INPUT', 'JV_NOT_FOUND', 'JV_PIECE_UNAVAILABLE', 'JV_CUSTOMER_ARCHIVED', 'JV_OVERPAYMENT',
       'JV_CASH_LIMIT', 'JV_FINE_EXCEEDS', 'JV_BILL_CANCELLED', 'JV_ALREADY_VOID', 'JV_NOT_ALLOWED', 'JV_BUSY') then
    raise exception 'private.jv_error: % is not one of the error codes of S8', coalesce(p_code, 'null') using errcode = '22023';
  end if;
  raise exception '%', p_code || coalesce(': ' || nullif(p_text, ''), '') using errcode = 'P0001';
end
$$;
comment on function private.jv_error(text, text) is 'S8: raises the error with the stable code at the start of the message (JV_FORBIDDEN: text).';

-- ---------------------------------------------------------------- S6: created_at and updated_at
-- BEFORE INSERT OR UPDATE on every table that has the two columns. The stamp is private.now_ts(), so a test that fixes the
-- clock fixes every stamp of a row, not only its dates; a client cannot send one (created_at never changes after the
-- insert, and a value sent for either is replaced). The column defaults are the built-in clock_timestamp() (S4: a default
-- calls built-in functions only), which this trigger overrides. Security definer, because the signed-in role may not run
-- private.now_ts(). Every update moves updated_at, an update that changes nothing included: that is how a touch is made (D23).
create or replace function private.set_updated_at()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_now timestamptz := private.now_ts();
begin
  if tg_op = 'INSERT' then
    new.created_at := v_now;
  else
    new.created_at := old.created_at;
  end if;
  new.updated_at := v_now;
  return new;
end
$$;
comment on function private.set_updated_at() is 'S6: trigger function. Stamps created_at (insert) and updated_at (insert and update) from private.now_ts().';

-- ---------------------------------------------------------------- D22: person columns come from the session, not from the client
-- BEFORE INSERT OR UPDATE on a table with any of created_by, updated_by, set_by and confirmed_by (a table may have only some).
-- On insert all four become auth.uid(); on update created_by keeps its old value and the other three become auth.uid().
-- With nobody signed in (the database owner: an import, a repair) auth.uid() is null, so an insert leaves them null and
-- an update leaves no person in updated_by, set_by and confirmed_by. voided_by and cancelled_by are set by the functions
-- that void and cancel (S6), not here. Note for the audit trigger of L1: an update that changes only updated_at in a table
-- with updated_by may also change updated_by when another user makes it.
create or replace function private.force_person_columns()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_row jsonb := to_jsonb(new);
  v_patch jsonb := '{}'::jsonb;
  v_col text;
begin
  if v_row ? 'created_by' then
    if tg_op = 'INSERT' then
      v_patch := v_patch || jsonb_build_object('created_by', v_uid);
    else
      v_patch := v_patch || jsonb_build_object('created_by', to_jsonb(old) -> 'created_by');
    end if;
  end if;
  foreach v_col in array array['updated_by', 'set_by', 'confirmed_by'] loop
    if v_row ? v_col then
      v_patch := v_patch || jsonb_build_object(v_col, v_uid);
    end if;
  end loop;
  if v_patch <> '{}'::jsonb then
    new := jsonb_populate_record(new, v_patch);
  end if;
  return new;
end
$$;
comment on function private.force_person_columns() is 'D22: trigger function. Sets created_by, updated_by, set_by and confirmed_by from auth.uid(); a value sent by a client is ignored.';

create trigger profiles_set_updated_at
  before insert or update on public.profiles
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D18: the limits
-- The caps of S4, the cash and PAN thresholds of section 13 and the review thresholds of I11, in one table the functions
-- read. A CHECK constraint cannot read this table (S4: a CHECK, a default, a policy or a view calls built-in functions only),
-- so the caps are also written as literals in the CHECKs of the tables, and test T-F02 compares the two. A decision
-- about a threshold changes one number here, in one migration. The two legal thresholds are for Siddhi's CA to confirm.
create table private.limits (
  name text primary key,
  value numeric not null,
  note text
);
alter table private.limits enable row level security;
comment on table private.limits is 'D18: constants. Not reachable through the API.';

insert into private.limits (name, value, note) values
  ('max_weight', 100000, 'S4: a weight is at most this many grams'),
  ('max_rate', 100000000, 'S4: a rate per gram or a piece price is at most this'),
  ('max_quantity', 1000, 'S4: a quantity is 1 to this'),
  ('max_bill_lines', 200, 'S4: a bill has 1 to this many lines'),
  ('max_amount', 1000000000, 'S4: every line amount, line total, subtotal, grand total, payment, refund, discount, additional charge, opening balance and fine_cash amount is at most this'),
  ('cash_limit', 200000, 'Z1, Z2: cash from one named customer on one business day reaching this needs the owner and a reason [CA]'),
  ('pan_threshold', 200000, 'Z2, Z3: a bill of this or more needs a named customer and prompts for a PAN [CA]'),
  ('discount_flag_percent', 10, 'I11: a discount above this percent of the subtotal is counted in the review'),
  ('rate_flag_percent', 5, 'I11: a rate more than this percent away from the list or day rate is counted in the review');

-- ---------------------------------------------------------------- D18, IM2: import batches
-- One row per import batch; designs, skus, customers and bills get an import_batch_id that points here (D21). The name is
-- unique, so running the same batch twice is refused.
create table private.import_batches (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  source_file text,
  row_counts jsonb,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.import_batches enable row level security;
comment on table private.import_batches is 'D18, IM2: one row per import batch. Not reachable through the API.';
