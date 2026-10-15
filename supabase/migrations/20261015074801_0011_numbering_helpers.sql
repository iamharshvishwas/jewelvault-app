-- 0011 numbering and repeat-safety helpers (task DB05). Spec: S2, S8, L3, L4, L5.
-- Tests: supabase/tests/database/040_audit_counters.test.sql (numbers, formats, T-F07 at the helper level, idem_begin) and
--        tests/db/numbering.test.ts (two sessions: T-C01 at the counter, T-C14 at idem_begin).
--
-- What the writing functions of Part B (and create_design, set_sku_status) call, so that each of them is a few lines:
--
--   private.next_number(series)        the next number of a series, in the caller's transaction (L3)
--   private.next_code(series)          the same, as the code a person sees (L4)
--   private.bill_series()              the series of a bill saved now: bill:<prefix>:<Asia/Kolkata year>
--   private.format_*                   the formats of L4, one function each
--   private.idem_hash(jsonb)           the hash of a function's arguments
--   private.idem_begin(id, fn, hash)   the first statement of every function that creates something (L5)
--   private.idem_finish(id, result)    stores the result in the same transaction and hands it back
--
-- All of them are executable by the database owner only (migration 0001: new functions in private are not granted); the
-- writing functions are security definer and owned by the database owner, so they can call them. None of them is reachable
-- through the API.

-- ---------------------------------------------------------------- L4: the formats
-- Digits are padded with zeros and never cut: after 9,999 a bill number simply has five digits (lpad would cut it).
create or replace function private.pad_number(p_n bigint, p_width integer)
returns text
language sql
immutable
set search_path = ''
as $$
  select repeat('0', greatest(coalesce(p_width, 0) - length(p_n::text), 0)) || p_n::text
$$;
comment on function private.pad_number(bigint, integer) is 'L4: the number padded with zeros to the width; a longer number is not cut.';

-- One field of a settings row, as text: null when the row is missing, is not an object, lacks the field or holds a blank.
create or replace function private.setting_text(p_key text, p_field text)
returns text
language sql
stable
set search_path = ''
as $$
  select nullif(btrim(case when jsonb_typeof(s.value) = 'object' then s.value ->> p_field end), '')
    from public.settings s
   where s.key = p_key
$$;
comment on function private.setting_text(text, text) is 'D3: a field of a settings row as text, or null. Used by the number formats, so a damaged setting falls back to the default instead of breaking a sale.';

-- A padding from the settings: a whole number from 1 to 20, else the default. (A CASE keeps the cast from running on text.)
create or replace function private.setting_width(p_key text, p_field text, p_default integer)
returns integer
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when x.v ~ '^[0-9]{1,2}$' then (case when x.v::integer between 1 and 20 then x.v::integer end) end
       from (select private.setting_text(p_key, p_field) as v) x),
    p_default)
$$;
comment on function private.setting_width(text, text, integer) is 'D3: a padding from the settings (1 to 20), else the default.';

-- L4: the prefix of a bill number, settings.estimate.prefix, JV when there is none.
create or replace function private.bill_prefix()
returns text
language sql
stable
set search_path = ''
as $$ select coalesce(private.setting_text('estimate', 'prefix'), 'JV') $$;
comment on function private.bill_prefix() is 'L4: settings.estimate.prefix, JV when it is missing or blank.';

-- L4: <prefix>-<YYYY>-<4 digits>, e.g. JV-2026-0001.
create or replace function private.format_bill_no(p_prefix text, p_year integer, p_n bigint)
returns text
language sql
immutable
set search_path = ''
as $$ select p_prefix || '-' || p_year::text || '-' || private.pad_number(p_n, 4) $$;
comment on function private.format_bill_no(text, integer, bigint) is 'L4: a bill number, <prefix>-<YYYY>-<4 digits>; after 9,999 the digits grow.';

-- L4: OB-<4 digits>.
create or replace function private.format_opening_no(p_n bigint)
returns text
language sql
immutable
set search_path = ''
as $$ select 'OB-' || private.pad_number(p_n, 4) $$;
comment on function private.format_opening_no(bigint) is 'L4, D15: the number of an opening-balance bill, OB-<4 digits>.';

-- L4: <category prefix>-<designPadding digits> (5 by default).
create or replace function private.format_design_no(p_category_prefix text, p_n bigint)
returns text
language sql
stable
set search_path = ''
as $$ select p_category_prefix || '-' || private.pad_number(p_n, private.setting_width('numbering', 'designPadding', 5)) $$;
comment on function private.format_design_no(text, bigint) is 'L4: a design number, <category prefix>-<designPadding digits> (5 by default).';

-- L4: <design_no>-<skuPadding digits> (3 by default).
create or replace function private.format_sku_no(p_design_no text, p_n bigint)
returns text
language sql
stable
set search_path = ''
as $$ select p_design_no || '-' || private.pad_number(p_n, private.setting_width('numbering', 'skuPadding', 3)) $$;
comment on function private.format_sku_no(text, bigint) is 'L4: a piece number, <design_no>-<skuPadding digits> (3 by default).';

-- L4: <barcodePrefix>-<sku_no> (BC by default).
create or replace function private.format_barcode(p_sku_no text)
returns text
language sql
stable
set search_path = ''
as $$ select coalesce(private.setting_text('numbering', 'barcodePrefix'), 'BC') || '-' || p_sku_no $$;
comment on function private.format_barcode(text) is 'L4: a barcode, <barcodePrefix>-<sku_no> (BC by default).';

-- L4: the year of a bill number is the Asia/Kolkata year when the bill is saved, so a backdated bill takes the current year's
-- number and a bill saved at 00:00:01 on 1 January starts the new year. The time comes from the clock seam (S5).
create or replace function private.bill_series()
returns text
language sql
volatile
set search_path = ''
as $$ select 'bill:' || private.bill_prefix() || ':' || to_char(private.now_ts() at time zone 'Asia/Kolkata', 'YYYY') $$;
comment on function private.bill_series() is 'L3, L4: the series of a bill saved now, bill:<prefix>:<Asia/Kolkata year>.';

-- ---------------------------------------------------------------- L3: the series
-- The code a number has in a series, or null when the series is none of the four of L3:
--   bill:<PREFIX>:<YYYY>  -> <PREFIX>-<YYYY>-nnnn          opening       -> OB-nnnn
--   design:<PREFIX>       -> <PREFIX>-nnnnn                sku:<design>  -> <design>-nnn
create or replace function private.series_code(p_series text, p_n bigint)
returns text
language plpgsql
stable
set search_path = ''
as $$
declare
  v_bill text[];
begin
  if p_series is null or p_n is null then
    return null;
  end if;
  v_bill := regexp_match(p_series, '^bill:(.+):([0-9]{4})$');
  if v_bill is not null then
    return private.format_bill_no(v_bill[1], v_bill[2]::integer, p_n);
  elsif p_series = 'opening' then
    return private.format_opening_no(p_n);
  elsif p_series ~ '^design:.+$' then
    return private.format_design_no(substr(p_series, 8), p_n);
  elsif p_series ~ '^sku:.+$' then
    return private.format_sku_no(substr(p_series, 5), p_n);
  end if;
  return null;
end
$$;
comment on function private.series_code(text, bigint) is 'L3, L4: the code a number has in a series (null for a series that is none of bill:<prefix>:<year>, opening, design:<prefix>, sku:<design_no>).';

-- Does a code of the series already exist? An imported number does (IM3), and a number is never reused (L4). A bill number is
-- unique as written; a design number, a piece number and a barcode are unique ignoring case (D6, D7). A piece's barcode is
-- <barcodePrefix>-<sku_no>, so a taken barcode skips the number too.
create or replace function private.series_taken(p_series text, p_code text)
returns boolean
language plpgsql
stable
set search_path = ''
as $$
begin
  if p_series = 'opening' or p_series like 'bill:%' then
    return exists (select 1 from public.bills b where b.bill_no = p_code);
  elsif p_series like 'design:%' then
    return exists (select 1 from public.designs d where lower(d.design_no) = lower(p_code));
  elsif p_series like 'sku:%' then
    return exists (
      select 1 from public.skus s
       where lower(s.sku_no) = lower(p_code) or lower(s.barcode) = lower(private.format_barcode(p_code)));
  end if;
  return false;
end
$$;
comment on function private.series_taken(text, text) is 'L3: whether a code of the series already exists (an imported number), which next_number then skips.';

-- ---------------------------------------------------------------- L3: next_number
-- INSERT ... ON CONFLICT (series) DO UPDATE SET last_value = last_value + 1 RETURNING last_value, in the transaction of the row
-- it numbers. The conflict update takes a row lock, so two callers are serialised, and a rolled-back transaction rolls the
-- counter back: no gap and no repeat. A number whose code already exists (an imported one) is skipped by taking the next
-- one, at most 100 times, then JV_INVALID_INPUT (the whole call then rolls back, the skipped numbers with it). A series that is
-- none of the four of L3 is refused: a typo must not start a second counter at 1.
-- Lock order (X0 item 6): call this last, after every check, so the counter row is held for the shortest time.
create or replace function private.next_number(p_series text)
returns bigint
language plpgsql
set search_path = ''
as $$
declare
  v_n bigint;
  v_try integer;
begin
  if p_series is null or private.series_code(p_series, 1) is null then
    perform private.jv_error('JV_INVALID_INPUT', 'Unknown number series ' || coalesce(p_series, '(none)'));
  end if;
  for v_try in 1..100 loop
    insert into private.counters as c (series, last_value)
    values (p_series, 1)
    on conflict (series) do update set last_value = c.last_value + 1
    returning c.last_value into v_n;
    if not private.series_taken(p_series, private.series_code(p_series, v_n)) then
      return v_n;
    end if;
  end loop;
  perform private.jv_error('JV_INVALID_INPUT', 'No free number was found in the series ' || p_series || ' after 100 tries');
  return null;
end
$$;
comment on function private.next_number(text) is 'L3: the next number of a series (bill:<prefix>:<year>, opening, design:<prefix>, sku:<design_no>), in the caller''s transaction; skips numbers that exist, at most 100 times.';

-- The same, as the code a person sees: JV-2026-0001, OB-0001, RING-00001, RING-00001-001.
create or replace function private.next_code(p_series text)
returns text
language sql
volatile
set search_path = ''
as $$ select private.series_code(p_series, private.next_number(p_series)) $$;
comment on function private.next_code(text) is 'L3, L4: the next number of a series as its code.';

-- ---------------------------------------------------------------- L5: repeat-safety
-- The hash of a function's arguments, given as one jsonb object (jsonb_build_object('p_customer_id', ..., 'p_items', ...)).
-- jsonb has no key order and no spaces, so the same arguments give the same hash however they were written down.
create or replace function private.idem_hash(p_args jsonb)
returns text
language sql
immutable
set search_path = ''
as $$ select encode(sha256(convert_to(coalesce(p_args, 'null'::jsonb)::text, 'UTF8')), 'hex') $$;
comment on function private.idem_hash(jsonb) is 'L5: SHA-256 of the arguments as canonical jsonb text, in hex.';

-- The first statement of a function that creates something:
--
--     v_stored := private.idem_begin(p_request_id, 'create_bill', private.idem_hash(jsonb_build_object(...)));
--     if v_stored is not null then return v_stored; end if;
--     ... check the role, take the locks, do the work ...
--     return private.idem_finish(p_request_id, v_result);
--
-- It inserts the request (request id, function, caller, hash) with ON CONFLICT DO NOTHING. If the row was inserted, this is the
-- first time: it returns null and the function carries on. If it was not, the insert first waited for any twin still in
-- flight to commit (or to roll back, when the insert simply goes through); under READ COMMITTED the next statement sees what
-- the twin committed, and the stored result is returned when function, caller and hash all match. The same id with another
-- function, another caller or another payload (another cart) is refused, not answered with the first result. A request that
-- exists but has no result (the same transaction began it twice) is refused too. A request that failed rolled its row back, so
-- sending it again runs it again. The wait is cut by the function's own SET lock_timeout (X0 item 7), which the writing
-- function turns into JV_BUSY.
create or replace function private.idem_begin(p_request_id uuid, p_fn text, p_args_hash text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_actor uuid := auth.uid();
  v_row private.idempotency;
  v_try integer;
begin
  if p_request_id is null or p_fn is null or btrim(p_fn) = '' or p_args_hash is null then
    perform private.jv_error('JV_INVALID_INPUT', 'A request needs an id, a function name and a hash of its arguments');
  end if;
  for v_try in 1..3 loop
    insert into private.idempotency (request_id, fn, actor, args_hash, created_at)
    values (p_request_id, p_fn, v_actor, p_args_hash, private.now_ts())
    on conflict (request_id) do nothing;
    if found then
      return null;
    end if;
    select * into v_row from private.idempotency i where i.request_id = p_request_id;
    exit when found;
    -- the row went between the insert and the read (the nightly delete of rows older than 90 days): try the insert again
  end loop;
  if v_row.request_id is null then
    perform private.jv_error('JV_INVALID_INPUT', 'The request could not be recorded');
  end if;
  if v_row.fn is distinct from p_fn or v_row.actor is distinct from v_actor or v_row.args_hash is distinct from p_args_hash then
    perform private.jv_error('JV_INVALID_INPUT', 'This request id was already used for a different request');
  end if;
  if v_row.result is null then
    perform private.jv_error('JV_INVALID_INPUT', 'This request id was already begun and has no result yet');
  end if;
  return v_row.result;
end
$$;
comment on function private.idem_begin(uuid, text, text) is 'L5: the first statement of a writing function. Null the first time (carry on); the stored result for a repeat of the same request; JV_INVALID_INPUT for the same id with another function, caller or payload.';

-- Stores the result in the request's row, in the same transaction as the rows it describes, and hands it back.
create or replace function private.idem_finish(p_request_id uuid, p_result jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
begin
  if p_result is null then
    raise exception 'private.idem_finish: the result of request % must not be null', p_request_id;
  end if;
  update private.idempotency set result = p_result where request_id = p_request_id;
  if not found then
    raise exception 'private.idem_finish: request % was not begun with private.idem_begin', p_request_id;
  end if;
  return p_result;
end
$$;
comment on function private.idem_finish(uuid, jsonb) is 'L5: stores the result of a request in the same transaction and returns it.';

revoke all on function
  private.pad_number(bigint, integer), private.setting_text(text, text), private.setting_width(text, text, integer),
  private.bill_prefix(), private.format_bill_no(text, integer, bigint), private.format_opening_no(bigint),
  private.format_design_no(text, bigint), private.format_sku_no(text, bigint), private.format_barcode(text),
  private.bill_series(), private.series_code(text, bigint), private.series_taken(text, text), private.next_number(text),
  private.next_code(text), private.idem_hash(jsonb), private.idem_begin(uuid, text, text), private.idem_finish(uuid, jsonb)
  from public, anon, authenticated;
