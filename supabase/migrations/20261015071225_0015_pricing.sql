-- 0015 pricing (task DB08). Spec: S3, S4, R1 to R8, R12, R13, R14, X7, D4, A6.
-- Tests: supabase/tests/database/070_pricing.test.sql (T-A01, T-A04, T-A05, T-A07 to T-A11, T-A13, T-A16, T-A18, T-A19) and
-- tests/db/parity.test.ts (T-A14, against the integer copy in src/lib/pricing.ts).
--
-- The pricing rules of section 8 live here once (R12). create_bill (X1) and quote_bill (X7) call the same code, so a quote and
-- a saved bill cannot differ. Everything below `quote_bill` is in the schema private; the API cannot run it.
--
-- THE INTERFACE (the later tasks, DB09b for create_bill and the nightly check I6, call exactly these):
--
--   private.price_line(version, sale_type, line jsonb, at text default '')  -> jsonb
--     Prices one line by the rules of the version (R3 to R7). The line is the stored snapshot of D12: material,
--     selling_method, customer_net_weight (grams), quantity, metal_rate, labour_rate, piroi, other_charges. It returns the
--     priced values: quantity, metal_rate, labour_rate, piroi, other_charges, labour_amount, metal_amount, fine_weight_due,
--     item_total. Money has two decimals and weight three, as the columns have. `at` starts every error message ('line 3: ').
--   private.price_bill(version, sale_type, lines jsonb, discount, additional, round_off boolean) -> jsonb
--     Prices a list of such lines and the bill totals (R8): pricing_version, sale_type, lines, subtotal, discount,
--     additional_charges, before_round, grand_total, round_off, fine_weight_due. round_off is the setting
--     settings.estimate.roundOff that the caller read (private.round_off_setting()).
--   private.default_rate(material, purity, bill_date) -> {rate_per_gram, rate_date, status}   (R2, D4)
--     status is ok (dated the bill date), stale (dated earlier) or missing (no rate dated on or before the bill date).
--   private.list_prices(sku_id, sale_type, bill_date) -> {list_metal_rate, list_labour_rate, rate_status, rate_date}   (R14)
--     Computed by the server from the piece and the daily rates, never from the client.
--   private.price_items(bill_date, sale_type, items jsonb, discount, additional, version) -> jsonb
--     The whole of X7: reads the pieces of the items (sku_id, metal_rate, labour_rate, piroi, other_charges, quantity), builds
--     the lines, prices them with private.price_bill, adds the list prices and the warnings RATE_MISSING and RATE_STALE.
--     create_bill calls it after it has locked the pieces, so the quote and the saved bill are one computation.
--   public.quote_bill(...)  the owner's and the biller's way in: the role check, then private.price_items.
--
-- THE VERSIONS (R13). private.price_line(v, ...) and private.price_bill(v, ...) call private.price_line_v<v> and
-- private.price_bill_v<v>, found by name. Version 1 is below. A later change of a rule is a new pair of functions with the
-- next number (and the same signatures as the pair of version 1); nothing else changes, and the old bills keep their version.
-- A version that has no functions is refused with JV_INVALID_INPUT. A test registers a test-only version 2 inside its own
-- rolled-back transaction.
--
-- THE CAPS (S4) are read from private.limits (max_weight, max_rate, max_amount, max_quantity, max_bill_lines) and checked on the
-- inputs and on every computed amount before anything is stored, so an over-large figure is JV_INVALID_INPUT and never a
-- numeric overflow. An input with more decimals than its column (a trailing zero counts: scale() of the number as sent) is
-- refused too. Numbers are read as numeric from the JSON text and never turned into an approximate type.

-- ---------------------------------------------------------------- the current version, the limits, the setting
create or replace function private.current_pricing_version()
returns integer
language sql
immutable
set search_path = ''
as $$ select 1 $$;
comment on function private.current_pricing_version() is 'R13: the pricing version a new bill gets (bills.pricing_version, quote_bill''s default). Version 1 is the rules of section 8.';

-- A row of private.limits. A missing row is a fault of the installation, not of the input: it must stop the work, because a
-- comparison with an unknown cap would let every value through.
create or replace function private.limit_value(p_name text)
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_value numeric;
begin
  select l.value into v_value from private.limits l where l.name = p_name;
  if v_value is null then
    raise exception 'private.limits has no row named %', p_name using errcode = 'XX000';
  end if;
  return v_value;
end
$$;
comment on function private.limit_value(text) is 'S4, D18: the value of one row of private.limits; raises when the row is missing.';

-- settings.estimate.roundOff (D3). With no estimate row, or a value that is not true or false, the default is on, the
-- prototype's DEFAULT_SETTINGS (settingsStore.ts). The grand total is a whole rupee whatever this says (R8, O12).
create or replace function private.round_off_setting()
returns boolean
language sql
stable
set search_path = ''
as $$
  select coalesce(
    (select case when jsonb_typeof(s.value -> 'roundOff') = 'boolean' then (s.value -> 'roundOff')::boolean end
       from public.settings s
      where s.key = 'estimate'),
    true)
$$;
comment on function private.round_off_setting() is 'R8: whether round_off is kept (settings.estimate.roundOff); on when the setting is absent.';

-- ---------------------------------------------------------------- reading an input (S4)
-- One decimal input of a JSON line: absent or null gives null (the caller decides whether that is allowed). A JSON number is
-- read from its text, so 1.230 keeps its three decimals; a text must be a plain decimal ("12.5", "12.", ".5"), no sign, no
-- exponent, no NaN, with the same white space round it that the browser's trim() removes (the integer copy in
-- src/lib/pricing.ts trims in the same way). Then: not negative, at most p_scale decimals (scale() of the number as sent), at most p_max.
create or replace function private.read_decimal(p_value jsonb, p_field text, p_scale integer, p_max numeric, p_at text default '')
returns numeric
language plpgsql
stable
set search_path = ''
as $$
declare
  v_type text := jsonb_typeof(p_value);
  v_text text;
  v_num numeric;
begin
  if p_value is null or v_type = 'null' then
    return null;
  end if;
  if v_type = 'number' then
    v_num := (p_value #>> '{}')::numeric;
  elsif v_type = 'string' then
    v_text := regexp_replace(
      p_value #>> '{}',
      '^[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+|[ \t\n\v\f\r\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]+$',
      '', 'g');
    if v_text !~ '^-?([0-9]+\.?[0-9]*|\.[0-9]+)$' then
      perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' is not a plain decimal number');
    end if;
    if left(v_text, 1) = '-' then
      perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' must not be negative');
    end if;
    v_num := v_text::numeric;
  else
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' must be a number or a text');
  end if;
  if v_num < 0 then
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' must not be negative');
  end if;
  if scale(v_num) > p_scale then
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' has more than ' || p_scale || ' decimals');
  end if;
  if v_num > p_max then
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' is above the cap of ' || trim_scale(p_max));
  end if;
  return v_num;
end
$$;
comment on function private.read_decimal(jsonb, text, integer, numeric, text) is 'S4: reads one decimal input (JSON number or plain decimal text); not negative, at most p_scale decimals as sent, at most p_max; null when absent.';

-- The quantity: absent or null is 1; otherwise a JSON number that is a whole number from 1 to p_max (R6).
create or replace function private.read_quantity(p_value jsonb, p_field text, p_max numeric, p_at text default '')
returns integer
language plpgsql
stable
set search_path = ''
as $$
declare
  v_num numeric;
begin
  if p_value is null or jsonb_typeof(p_value) = 'null' then
    return 1;
  end if;
  if jsonb_typeof(p_value) <> 'number' then
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' must be a whole number');
  end if;
  v_num := (p_value #>> '{}')::numeric;
  if v_num <> trunc(v_num) then
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' must be a whole number');
  end if;
  if v_num < 1 or v_num > p_max then
    perform private.jv_error('JV_INVALID_INPUT', p_at || p_field || ' must be from 1 to ' || trim_scale(p_max));
  end if;
  return v_num::integer;
end
$$;
comment on function private.read_quantity(jsonb, text, numeric, text) is 'R6, S4: a quantity from 1 to max_quantity; absent means 1.';

-- ---------------------------------------------------------------- version 1 of one line (R3 to R7)
-- NW customer net weight (g), q quantity, r metal rate or piece price, l labour rate, p piroi, o other charges.
--   R3 labour amount   By Weight round(NW x l, 2); Per Piece 0.
--   R4 fine due        NW x q for Wholesale, Silver, By Weight; otherwise 0.
--   R5 metal amount    0 when the fine due is above 0; else By Weight round(NW x r, 2), Per Piece round(r x q, 2).
--   R7 line total      metal + labour + p + o (p and o once per line).
-- round(numeric, n) rounds a tie away from zero; every amount here is not negative, so that is "half up".
create or replace function private.price_line_v1(p_sale_type text, p_line jsonb, p_at text default '')
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_max_weight numeric := private.limit_value('max_weight');
  v_max_rate numeric := private.limit_value('max_rate');
  v_max_quantity numeric := private.limit_value('max_quantity');
  v_max_amount numeric := private.limit_value('max_amount');
  v_material text;
  v_method text;
  v_by_weight boolean;
  v_nw numeric;
  v_q integer;
  v_r numeric;
  v_l numeric := 0;
  v_p numeric;
  v_o numeric;
  v_labour numeric := 0;
  v_fine numeric := 0;
  v_metal numeric;
  v_total numeric;
begin
  if p_sale_type is null or p_sale_type not in ('Retail', 'Semi-Wholesale', 'Wholesale') then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'the sale type must be Retail, Semi-Wholesale or Wholesale');
  end if;
  if jsonb_typeof(p_line) is distinct from 'object' then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'a line must be an object');
  end if;

  v_material := p_line ->> 'material';
  if v_material is null or v_material not in ('Gold', 'Silver') or jsonb_typeof(p_line -> 'material') <> 'string' then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'material must be Gold or Silver');
  end if;
  v_method := p_line ->> 'selling_method';
  if v_method is null or v_method not in ('By Weight', 'Per Piece') or jsonb_typeof(p_line -> 'selling_method') <> 'string' then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'selling_method must be By Weight or Per Piece');
  end if;
  v_by_weight := v_method = 'By Weight';

  v_nw := private.read_decimal(p_line -> 'customer_net_weight', 'customer_net_weight', 3, v_max_weight, p_at);
  if v_nw is null then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'customer_net_weight is required');
  end if;
  v_q := private.read_quantity(p_line -> 'quantity', 'quantity', v_max_quantity, p_at);
  if v_by_weight and v_q <> 1 then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'quantity must be 1 for a piece sold by weight');
  end if;
  v_r := private.read_decimal(p_line -> 'metal_rate', 'metal_rate', 2, v_max_rate, p_at);
  if v_r is null then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'metal_rate is required');
  end if;
  if v_by_weight then
    v_l := private.read_decimal(p_line -> 'labour_rate', 'labour_rate', 2, v_max_rate, p_at);
    if v_l is null then
      perform private.jv_error('JV_INVALID_INPUT', p_at || 'labour_rate is required for a piece sold by weight');
    end if;
  end if;
  v_p := coalesce(private.read_decimal(p_line -> 'piroi', 'piroi', 2, v_max_amount, p_at), 0);
  v_o := coalesce(private.read_decimal(p_line -> 'other_charges', 'other_charges', 2, v_max_amount, p_at), 0);

  if v_by_weight then
    v_labour := round(v_nw * v_l, 2);
  end if;
  if p_sale_type = 'Wholesale' and v_material = 'Silver' and v_by_weight then
    v_fine := v_nw * v_q;
  end if;
  if v_fine > 0 then
    v_metal := 0;
  elsif v_by_weight then
    v_metal := round(v_nw * v_r, 2);
  else
    v_metal := round(v_r * v_q, 2);
  end if;

  if v_metal > v_max_amount then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'the metal amount is above the cap of ' || trim_scale(v_max_amount));
  end if;
  if v_labour > v_max_amount then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'the labour amount is above the cap of ' || trim_scale(v_max_amount));
  end if;
  v_total := v_metal + v_labour + v_p + v_o;
  if v_total > v_max_amount then
    perform private.jv_error('JV_INVALID_INPUT', p_at || 'the line total is above the cap of ' || trim_scale(v_max_amount));
  end if;

  return jsonb_build_object(
    'quantity', v_q,
    'metal_rate', round(v_r, 2),
    'labour_rate', round(v_l, 2),
    'piroi', round(v_p, 2),
    'other_charges', round(v_o, 2),
    'labour_amount', round(v_labour, 2),
    'metal_amount', round(v_metal, 2),
    'fine_weight_due', round(v_fine, 3),
    'item_total', round(v_total, 2));
end
$$;
comment on function private.price_line_v1(text, jsonb, text) is 'R3 to R7, S4: pricing version 1 of one line, over its stored snapshot. Per-line rounding to paise; every cap checked on the inputs and on the amounts.';

-- ---------------------------------------------------------------- version 1 of a bill (R8)
--   subtotal = sum of the line totals; before_round = subtotal - discount + additional, at least 0;
--   grand_total = round(before_round, 0); round_off = grand_total - before_round when the setting is on, else 0.
create or replace function private.price_bill_v1(
  p_sale_type text, p_lines jsonb, p_discount numeric, p_additional numeric, p_round_off boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_max_amount numeric := private.limit_value('max_amount');
  v_max_lines numeric := private.limit_value('max_bill_lines');
  v_count integer;
  v_i integer;
  v_priced jsonb;
  v_out jsonb := '[]'::jsonb;
  v_subtotal numeric := 0;
  v_fine numeric := 0;
  v_discount numeric;
  v_additional numeric;
  v_before numeric;
  v_grand numeric;
  v_round_off numeric;
begin
  if p_sale_type is null or p_sale_type not in ('Retail', 'Semi-Wholesale', 'Wholesale') then
    perform private.jv_error('JV_INVALID_INPUT', 'the sale type must be Retail, Semi-Wholesale or Wholesale');
  end if;
  if p_round_off is null then
    perform private.jv_error('JV_INVALID_INPUT', 'the round-off setting must be true or false');
  end if;
  if jsonb_typeof(p_lines) is distinct from 'array' then
    perform private.jv_error('JV_INVALID_INPUT', 'the lines must be a list');
  end if;
  v_count := jsonb_array_length(p_lines);
  if v_count < 1 or v_count > v_max_lines then
    perform private.jv_error('JV_INVALID_INPUT', 'a bill needs from 1 to ' || trim_scale(v_max_lines) || ' lines');
  end if;

  for v_i in 0 .. v_count - 1 loop
    v_priced := private.price_line_v1(p_sale_type, p_lines -> v_i, 'line ' || (v_i + 1) || ': ');
    v_out := v_out || jsonb_build_array(v_priced);
    v_subtotal := v_subtotal + (v_priced ->> 'item_total')::numeric;
    v_fine := v_fine + (v_priced ->> 'fine_weight_due')::numeric;
  end loop;
  if v_subtotal > v_max_amount then
    perform private.jv_error('JV_INVALID_INPUT', 'the subtotal is above the cap of ' || trim_scale(v_max_amount));
  end if;

  v_discount := coalesce(private.read_decimal(to_jsonb(p_discount), 'discount', 2, v_max_amount), 0);
  v_additional := coalesce(private.read_decimal(to_jsonb(p_additional), 'additional_charges', 2, v_max_amount), 0);

  v_before := v_subtotal - v_discount + v_additional;
  if v_before < 0 then
    perform private.jv_error('JV_INVALID_INPUT', 'the discount is more than the subtotal plus the additional charges');
  end if;
  v_grand := round(v_before, 0);
  if v_grand > v_max_amount then
    perform private.jv_error('JV_INVALID_INPUT', 'the grand total is above the cap of ' || trim_scale(v_max_amount));
  end if;
  if p_round_off then
    v_round_off := v_grand - v_before;
  else
    v_round_off := 0;
  end if;

  return jsonb_build_object(
    'pricing_version', 1,
    'sale_type', p_sale_type,
    'lines', v_out,
    'subtotal', round(v_subtotal, 2),
    'discount', round(v_discount, 2),
    'additional_charges', round(v_additional, 2),
    'before_round', round(v_before, 2),
    'grand_total', round(v_grand, 2),
    'round_off', round(v_round_off, 2),
    'fine_weight_due', round(v_fine, 3));
end
$$;
comment on function private.price_bill_v1(text, jsonb, numeric, numeric, boolean) is 'R8, S4: pricing version 1 of a bill: 1 to 200 lines, subtotal, discount, additional charges, before_round at least 0, a whole-rupee grand total, round_off.';

-- ---------------------------------------------------------------- the dispatch by version (R13)
create or replace function private.price_line(p_version integer, p_sale_type text, p_line jsonb, p_at text default '')
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_version is null or p_version < 1
     or to_regprocedure(format('private.price_line_v%s(text,jsonb,text)', p_version)) is null then
    perform private.jv_error('JV_INVALID_INPUT', 'pricing version ' || coalesce(p_version::text, 'null') || ' is not available');
  end if;
  execute format('select private.price_line_v%s($1, $2, $3)', p_version)
    into v_result using p_sale_type, p_line, coalesce(p_at, '');
  return v_result;
end
$$;
comment on function private.price_line(integer, text, jsonb, text) is 'R12, R13: prices one line by the rules of the given pricing version (calls private.price_line_v<version>). The one entry for create_bill, quote_bill and the nightly re-pricing check.';

create or replace function private.price_bill(
  p_version integer, p_sale_type text, p_lines jsonb, p_discount numeric, p_additional numeric, p_round_off boolean
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_result jsonb;
begin
  if p_version is null or p_version < 1
     or to_regprocedure(format('private.price_bill_v%s(text,jsonb,numeric,numeric,boolean)', p_version)) is null then
    perform private.jv_error('JV_INVALID_INPUT', 'pricing version ' || coalesce(p_version::text, 'null') || ' is not available');
  end if;
  execute format('select private.price_bill_v%s($1, $2, $3, $4, $5)', p_version)
    into v_result using p_sale_type, p_lines, p_discount, p_additional, p_round_off;
  return v_result;
end
$$;
comment on function private.price_bill(integer, text, jsonb, numeric, numeric, boolean) is 'R12, R13: prices a bill by the rules of the given pricing version (calls private.price_bill_v<version>). Pure over its inputs: no table is read.';

-- ---------------------------------------------------------------- the daily rate and the list prices (R2, R14, D4)
-- The row of daily_rates for the material and purity with the latest rate_date not after the bill's date. A rate dated after
-- the bill is never used. status: ok (dated the bill date), stale (dated earlier: still pre-filled, X1 warns RATE_STALE),
-- missing (no such row: the screen asks for a rate, X1 warns RATE_MISSING).
create or replace function private.default_rate(p_material text, p_purity text, p_bill_date date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_rate numeric;
  v_date date;
begin
  if p_bill_date is null then
    perform private.jv_error('JV_INVALID_INPUT', 'the bill date is required');
  end if;
  select r.rate_per_gram, r.rate_date into v_rate, v_date
    from public.daily_rates r
   where r.material = p_material and r.purity = p_purity and r.rate_date <= p_bill_date
   order by r.rate_date desc
   limit 1;
  if not found then
    return jsonb_build_object('rate_per_gram', null, 'rate_date', null, 'status', 'missing');
  end if;
  return jsonb_build_object(
    'rate_per_gram', v_rate,
    'rate_date', v_date,
    'status', case when v_date = p_bill_date then 'ok' else 'stale' end);
end
$$;
comment on function private.default_rate(text, text, date) is 'R2, D4: the daily rate for a material and purity with the latest rate_date not after the bill date, and whether it is ok, stale or missing.';

-- The price the screen should have offered for a piece (R14), from the piece and the daily rates and nothing the client sent.
--   By Weight: list_metal_rate is the daily rate by R2 (null when missing) and list_labour_rate the piece's labour rate for the
--   sale type (labour_retail, labour_semi, labour_wholesale: the three are never blank, R1).
--   Per Piece: list_metal_rate is the piece price for the sale type; the labour rate is unused (R3), so the line is compared
--   on the price only and list_labour_rate is null.
create or replace function private.list_prices(p_sku_id uuid, p_sale_type text, p_bill_date date)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_material text;
  v_purity text;
  v_method text;
  v_price numeric;
  v_rate jsonb;
begin
  if p_sale_type is null or p_sale_type not in ('Retail', 'Semi-Wholesale', 'Wholesale') then
    perform private.jv_error('JV_INVALID_INPUT', 'the sale type must be Retail, Semi-Wholesale or Wholesale');
  end if;
  if p_bill_date is null then
    perform private.jv_error('JV_INVALID_INPUT', 'the bill date is required');
  end if;
  select d.material, d.purity, d.selling_method,
         case p_sale_type
           when 'Retail' then s.labour_retail
           when 'Semi-Wholesale' then s.labour_semi
           else s.labour_wholesale
         end
    into v_material, v_purity, v_method, v_price
    from public.skus s
    join public.designs d on d.id = s.design_id
   where s.id = p_sku_id;
  if not found then
    perform private.jv_error('JV_NOT_FOUND', 'The piece does not exist');
  end if;
  if v_method = 'Per Piece' then
    return jsonb_build_object('list_metal_rate', v_price, 'list_labour_rate', null, 'rate_status', null, 'rate_date', null);
  end if;
  v_rate := private.default_rate(v_material, v_purity, p_bill_date);
  return jsonb_build_object(
    'list_metal_rate', v_rate -> 'rate_per_gram',
    'list_labour_rate', v_price,
    'rate_status', v_rate ->> 'status',
    'rate_date', v_rate -> 'rate_date');
end
$$;
comment on function private.list_prices(uuid, text, date) is 'R14: the list metal rate and list labour rate of a piece for a sale type and a bill date, computed by the server; and the status of the daily rate.';

-- ---------------------------------------------------------------- the whole quote (X7): pieces, prices, list prices, warnings
-- p_items: each { sku_id, metal_rate, labour_rate, piroi, other_charges, quantity } as X1 takes them. The material, the
-- selling method and the net weight come from the piece; the original weight is never read. The pieces are read, not locked.
-- Whether a piece may be billed (R10) and the date rules (Y8) are the business of create_bill, not of a price.
-- A By Weight line whose daily rate is stale or missing adds a warning { code, line_no, sku_id, material, purity [, rate_date] }.
-- A Per Piece line never does: its price is the piece's.
create or replace function private.price_items(
  p_bill_date date, p_sale_type text, p_items jsonb, p_discount numeric, p_additional numeric, p_version integer
)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_max_lines numeric := private.limit_value('max_bill_lines');
  v_count integer;
  v_i integer;
  v_item jsonb;
  v_at text;
  v_sku uuid;
  v_seen uuid[] := '{}';
  v_row record;
  v_lines jsonb := '[]'::jsonb;
  v_snaps jsonb := '[]'::jsonb;
  v_result jsonb;
  v_priced jsonb;
  v_list jsonb;
  v_out jsonb := '[]'::jsonb;
  v_warnings jsonb := '[]'::jsonb;
begin
  if p_bill_date is null then
    perform private.jv_error('JV_INVALID_INPUT', 'the bill date is required');
  end if;
  if p_sale_type is null or p_sale_type not in ('Retail', 'Semi-Wholesale', 'Wholesale') then
    perform private.jv_error('JV_INVALID_INPUT', 'the sale type must be Retail, Semi-Wholesale or Wholesale');
  end if;
  if jsonb_typeof(p_items) is distinct from 'array' then
    perform private.jv_error('JV_INVALID_INPUT', 'the items must be a list');
  end if;
  v_count := jsonb_array_length(p_items);
  if v_count < 1 or v_count > v_max_lines then
    perform private.jv_error('JV_INVALID_INPUT', 'a bill needs from 1 to ' || trim_scale(v_max_lines) || ' lines');
  end if;

  for v_i in 0 .. v_count - 1 loop
    v_item := p_items -> v_i;
    v_at := 'line ' || (v_i + 1) || ': ';
    if jsonb_typeof(v_item) is distinct from 'object' then
      perform private.jv_error('JV_INVALID_INPUT', v_at || 'a line must be an object');
    end if;
    if jsonb_typeof(v_item -> 'sku_id') is distinct from 'string'
       or (v_item ->> 'sku_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      perform private.jv_error('JV_INVALID_INPUT', v_at || 'sku_id must be the id of a piece');
    end if;
    v_sku := (v_item ->> 'sku_id')::uuid;
    if v_sku = any (v_seen) then
      perform private.jv_error('JV_INVALID_INPUT', v_at || 'the same piece is on two lines');
    end if;
    v_seen := v_seen || v_sku;

    select s.id, s.sku_no, s.gross_weight, s.customer_net_weight, d.design_no, d.material, d.purity, d.selling_method,
           c.name as category
      into v_row
      from public.skus s
      join public.designs d on d.id = s.design_id
      join public.categories c on c.id = d.category_id
     where s.id = v_sku;
    if not found then
      perform private.jv_error('JV_NOT_FOUND', v_at || 'the piece does not exist');
    end if;

    v_lines := v_lines || jsonb_build_array(jsonb_build_object(
      'material', v_row.material,
      'selling_method', v_row.selling_method,
      'customer_net_weight', v_row.customer_net_weight,
      'quantity', v_item -> 'quantity',
      'metal_rate', v_item -> 'metal_rate',
      'labour_rate', v_item -> 'labour_rate',
      'piroi', v_item -> 'piroi',
      'other_charges', v_item -> 'other_charges'));
    v_snaps := v_snaps || jsonb_build_array(jsonb_build_object(
      'line_no', v_i + 1,
      'sku_id', v_row.id,
      'design_no', v_row.design_no,
      'sku_no', v_row.sku_no,
      'category', v_row.category,
      'material', v_row.material,
      'purity', v_row.purity,
      'selling_method', v_row.selling_method,
      'gross_weight', v_row.gross_weight,
      'customer_net_weight', v_row.customer_net_weight));
  end loop;

  v_result := private.price_bill(p_version, p_sale_type, v_lines, p_discount, p_additional, private.round_off_setting());

  for v_i in 0 .. v_count - 1 loop
    v_list := private.list_prices((v_snaps -> v_i ->> 'sku_id')::uuid, p_sale_type, p_bill_date);
    v_priced := coalesce(v_result -> 'lines' -> v_i, '{}'::jsonb);
    v_out := v_out || jsonb_build_array(
      (v_snaps -> v_i) || v_priced
      || jsonb_build_object('list_metal_rate', v_list -> 'list_metal_rate', 'list_labour_rate', v_list -> 'list_labour_rate'));
    if v_list ->> 'rate_status' = 'stale' then
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'RATE_STALE', 'line_no', v_i + 1, 'sku_id', v_snaps -> v_i -> 'sku_id',
        'material', v_snaps -> v_i -> 'material', 'purity', v_snaps -> v_i -> 'purity', 'rate_date', v_list -> 'rate_date'));
    elsif v_list ->> 'rate_status' = 'missing' then
      v_warnings := v_warnings || jsonb_build_array(jsonb_build_object(
        'code', 'RATE_MISSING', 'line_no', v_i + 1, 'sku_id', v_snaps -> v_i -> 'sku_id',
        'material', v_snaps -> v_i -> 'material', 'purity', v_snaps -> v_i -> 'purity'));
    end if;
  end loop;

  return v_result || jsonb_build_object('bill_date', p_bill_date, 'lines', v_out, 'warnings', v_warnings);
end
$$;
comment on function private.price_items(date, text, jsonb, numeric, numeric, integer) is 'X7, R12, R14: the quote. Reads the pieces of the items, prices the lines and the bill with private.price_bill, adds the server''s list prices and the RATE_MISSING and RATE_STALE warnings. create_bill calls it after locking the pieces.';

-- ---------------------------------------------------------------- X7: quote_bill
-- Read-only: STABLE, so the database itself refuses a write inside it; no request id, no lock, nothing stored. Security definer
-- because it has to call private.price_items, which authenticated may not run (A3). It checks the role first (A6). It returns
-- the lines, the totals, the list prices and the warnings that create_bill would produce for the same items.
-- Lint 0029 (a security definer function that signed-in users can run) is intentional for this function, like X1 to X12 (A7, X13).
create or replace function public.quote_bill(
  p_bill_date date,
  p_sale_type text,
  p_items jsonb,
  p_discount numeric default 0,
  p_additional numeric default 0,
  p_pricing_version integer default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_role text := (select private.app_role());
begin
  if v_role is null or v_role not in ('owner', 'biller') then
    perform private.jv_error('JV_FORBIDDEN', 'Only the owner and the biller can price a bill');
  end if;
  return private.price_items(
    coalesce(p_bill_date, private.today()), p_sale_type, p_items, p_discount, p_additional,
    coalesce(p_pricing_version, private.current_pricing_version()));
end
$$;
revoke all on function public.quote_bill(date, text, jsonb, numeric, numeric, integer) from public, anon;
grant execute on function public.quote_bill(date, text, jsonb, numeric, numeric, integer) to authenticated;
comment on function public.quote_bill(date, text, jsonb, numeric, numeric, integer) is 'X7: prices a bill without saving it (owner and biller). Returns the lines, the totals, the list prices and the warnings that create_bill would produce, from the same private.price_bill. Read-only. Callable by signed-in users by design (advisor lint 0029 is intentional, A7).';
