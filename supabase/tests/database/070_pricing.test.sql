-- T-A01, T-A04, T-A05, T-A07, T-A08, T-A09 (the pricing inputs), T-A10, T-A11, T-A13, T-A16, T-A18 and T-A19: the pricing
-- functions of migration 0015. DB08. (T-A14 is the parity test in tests/db/parity.test.ts.)
--
-- Spec lines: S3, S4, R1 to R8, R12, R13, R14, X7, D4. Everything runs in this transaction and is rolled back.
--
-- What is proved here:
--   * the pure functions private.price_line and private.price_bill (version 1) over jsonb, without any bill or piece:
--     the worked example, the fine rule, quantity, piroi and other charges once per line, the round-off setting,
--     per-line paise rounding, and every cap and every refusal of S4 (always a JV_INVALID_INPUT, never a numeric overflow);
--   * private.default_rate and private.list_prices, and the read-only public.quote_bill (owner and biller only), which
--     prices real pieces with the daily rates and returns the warnings RATE_MISSING and RATE_STALE;
--   * the dispatch by pricing version (R13), the test-only version 2 being made inside this rolled-back transaction.
--
-- The expected figures of T-A19 were worked out by hand and checked with an independent oracle (Python's decimal module,
-- rounding half up), not with the code under test. The helpers in pg_temp catch an error and report it, so a function that
-- does not exist yet makes the assertions fail one by one instead of stopping the file. They are granted to public so that
-- they can be called while a role is impersonated.
begin;
select plan(339);

-- ---------------------------------------------------------------- helpers
-- 'ok' when the statement ran, else the error message.
create function pg_temp.try(p_sql text) returns text language plpgsql as $f$
begin
  execute p_sql;
  return 'ok';
exception when others then
  return sqlerrm;
end
$f$;

-- One bill line as the pricing functions read it. A null argument leaves the key out (an absent value).
create function pg_temp.ln(
  p_material text, p_method text, p_nw numeric, p_q numeric, p_r numeric, p_l numeric,
  p_p numeric default null, p_o numeric default null
) returns jsonb language plpgsql as $f$
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'material', p_material, 'selling_method', p_method, 'customer_net_weight', p_nw, 'quantity', p_q,
    'metal_rate', p_r, 'labour_rate', p_l, 'piroi', p_p, 'other_charges', p_o));
end
$f$;

-- A valid base line (By Weight, or Per Piece) with one key replaced by the JSON text p_value, or left out when it is null.
create function pg_temp.mut(p_key text, p_value text default null, p_method text default 'By Weight') returns jsonb
language plpgsql as $f$
declare
  v_base jsonb := case p_method
    when 'By Weight' then '{"material": "Gold", "selling_method": "By Weight", "customer_net_weight": 10.000, "metal_rate": 6920, "labour_rate": 353}'::jsonb
    else '{"material": "Gold", "selling_method": "Per Piece", "customer_net_weight": 5.000, "metal_rate": 1200}'::jsonb
  end;
begin
  if p_value is null then
    return v_base - p_key;
  end if;
  return v_base || jsonb_build_object(p_key, p_value::jsonb);
end
$f$;

-- Prices one line / one bill. The error, if there is one, comes back as {"error": message}.
create function pg_temp.pl(p_line jsonb, p_sale text default 'Retail') returns jsonb language plpgsql as $f$
begin
  return private.price_line(1, p_sale, p_line);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

create function pg_temp.pb(
  p_lines jsonb, p_discount numeric default 0, p_additional numeric default 0, p_sale text default 'Retail',
  p_round boolean default true
) returns jsonb language plpgsql as $f$
begin
  return private.price_bill(1, p_sale, p_lines, p_discount, p_additional, p_round);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

-- 'ok' or the error message of pricing one line / one bill.
create function pg_temp.tl(p_line jsonb, p_sale text default 'Retail') returns text language plpgsql as $f$
begin
  perform private.price_line(1, p_sale, p_line);
  return 'ok';
exception when others then
  return sqlerrm;
end
$f$;

create function pg_temp.tb(
  p_lines jsonb, p_discount numeric default 0, p_additional numeric default 0, p_sale text default 'Retail',
  p_round boolean default true
) returns text language plpgsql as $f$
begin
  perform private.price_bill(1, p_sale, p_lines, p_discount, p_additional, p_round);
  return 'ok';
exception when others then
  return sqlerrm;
end
$f$;

-- quote_bill as the current role; an error comes back as {"error": message}.
create function pg_temp.qb(
  p_date date, p_sale text, p_items jsonb, p_discount numeric default 0, p_additional numeric default 0,
  p_version integer default null
) returns jsonb language plpgsql as $f$
begin
  return public.quote_bill(p_date, p_sale, p_items, p_discount, p_additional, p_version);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

-- One quote item.
create function pg_temp.qi(
  p_sku text, p_r numeric, p_l numeric default null, p_p numeric default null, p_o numeric default null,
  p_q numeric default null
) returns jsonb language plpgsql as $f$
begin
  return jsonb_strip_nulls(jsonb_build_object(
    'sku_id', p_sku, 'metal_rate', p_r, 'labour_rate', p_l, 'piroi', p_p, 'other_charges', p_o, 'quantity', p_q));
end
$f$;

-- private.default_rate, private.list_prices and the version-taking pricing calls, with the error as {"error": message}.
create function pg_temp.dr(p_material text, p_purity text, p_date date) returns jsonb language plpgsql as $f$
begin
  return private.default_rate(p_material, p_purity, p_date);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

create function pg_temp.lp(p_sku text, p_sale text, p_date date) returns jsonb language plpgsql as $f$
begin
  return private.list_prices(p_sku::uuid, p_sale, p_date);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

create function pg_temp.plv(p_version integer, p_sale text, p_line jsonb) returns jsonb language plpgsql as $f$
begin
  return private.price_line(p_version, p_sale, p_line);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

create function pg_temp.pbv(p_version integer, p_sale text, p_lines jsonb) returns jsonb language plpgsql as $f$
begin
  return private.price_bill(p_version, p_sale, p_lines, 0, 0, true);
exception when others then
  return jsonb_build_object('error', sqlerrm);
end
$f$;

-- Results of calls made while a role is impersonated are kept in a setting of the transaction (a temporary table could not
-- be made by anon) and read back by any role.
create function pg_temp.keep(p_name text, p_value jsonb) returns void language plpgsql as $f$
begin
  perform set_config('jv.q_' || p_name, p_value::text, true);
end
$f$;

create function pg_temp.got(p_name text) returns jsonb language plpgsql as $f$
begin
  return current_setting('jv.q_' || p_name)::jsonb;
end
$f$;

grant execute on function
  pg_temp.keep(text, jsonb), pg_temp.got(text), pg_temp.dr(text, text, date), pg_temp.lp(text, text, date),
  pg_temp.plv(integer, text, jsonb), pg_temp.pbv(integer, text, jsonb),
  pg_temp.try(text), pg_temp.ln(text, text, numeric, numeric, numeric, numeric, numeric, numeric),
  pg_temp.mut(text, text, text), pg_temp.pl(jsonb, text), pg_temp.pb(jsonb, numeric, numeric, text, boolean),
  pg_temp.tl(jsonb, text), pg_temp.tb(jsonb, numeric, numeric, text, boolean),
  pg_temp.qb(date, text, jsonb, numeric, numeric, integer), pg_temp.qi(text, numeric, numeric, numeric, numeric, numeric)
  to public;

-- ---------------------------------------------------------------- 0. the functions exist (R12, X7)
select has_function('private', 'price_line', array['integer', 'text', 'jsonb', 'text'], 'R12: private.price_line(version, sale type, line, position) exists');
select has_function('private', 'price_bill', array['integer', 'text', 'jsonb', 'numeric', 'numeric', 'boolean'], 'R12: private.price_bill(version, sale type, lines, discount, additional, round-off) exists');
select has_function('private', 'default_rate', array['text', 'text', 'date'], 'R2: private.default_rate(material, purity, bill date) exists');
select has_function('private', 'list_prices', array['uuid', 'text', 'date'], 'R14: private.list_prices(piece, sale type, bill date) exists');
select has_function('public', 'quote_bill', array['date', 'text', 'jsonb', 'numeric', 'numeric', 'integer'], 'X7: public.quote_bill exists');

-- ---------------------------------------------------------------- 1. T-A01 the worked example (R1 to R8)
-- NW 35.42 g, rate 6,920, labour 353 per gram, piroi 2.15, Retail, By Weight.
create temp table t01 as
  select pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'By Weight', 35.42, null, 6920, 353, 2.15))) as r;
select is((select r -> 'lines' -> 0 ->> 'metal_amount' from t01), '245106.40', 'T-A01: metal amount 245,106.40');
select is((select r -> 'lines' -> 0 ->> 'labour_amount' from t01), '12503.26', 'T-A01: labour amount 12,503.26');
select is((select r -> 'lines' -> 0 ->> 'item_total' from t01), '257611.81', 'T-A01: line total 257,611.81');
select is((select r ->> 'subtotal' from t01), '257611.81', 'T-A01: subtotal 257,611.81');
select is((select r ->> 'grand_total' from t01), '257612.00', 'T-A01: grand total 257,612');
select is((select r ->> 'round_off' from t01), '0.19', 'T-A01: round-off 0.19');
select is((select r ->> 'fine_weight_due' from t01), '0.000', 'T-A01: no fine on a Retail gold line');
select is((select r ->> 'pricing_version' from t01), '1', 'R13: the bill says it was priced by version 1');
select is((select r -> 'lines' -> 0 ->> 'piroi' from t01), '2.15', 'T-A01: the piroi is kept on the line');

-- ---------------------------------------------------------------- 2. fixtures: users, designs, pieces, rates
-- Gold 22K (By Weight), Gold 18K, Gold 24K (no rate row at all), Silver 925, Silver 999 (all By Weight), a Per Piece gold
-- design and a Per Piece silver design. The rates: Gold 22K 7,000 today and 6,900 three days ago; Gold 18K 5,800 yesterday;
-- Silver 925 90 ten days ago.
do $fx$
declare
  v_today date := private.today();
  v_d22 uuid; v_d18 uuid; v_d24 uuid; v_s925 uuid; v_s999 uuid; v_pp uuid; v_spp uuid;
begin
  perform set_config('jv.today', v_today::text, true);
  perform set_config('jv.owner', tests.make_user('owner')::text, true);
  perform set_config('jv.biller', tests.make_user('biller')::text, true);
  perform set_config('jv.staff', tests.make_user('staff')::text, true);
  perform set_config('jv.inactive', tests.make_user('inactive')::text, true);

  v_d22 := tests.make_design(jsonb_build_object('material', 'Gold', 'purity', '22K', 'selling_method', 'By Weight'));
  v_d18 := tests.make_design(jsonb_build_object('material', 'Gold', 'purity', '18K', 'selling_method', 'By Weight'));
  v_d24 := tests.make_design(jsonb_build_object('material', 'Gold', 'purity', '24K', 'selling_method', 'By Weight'));
  v_s925 := tests.make_design(jsonb_build_object('material', 'Silver', 'purity', '925', 'selling_method', 'By Weight'));
  v_s999 := tests.make_design(jsonb_build_object('material', 'Silver', 'purity', '999', 'selling_method', 'By Weight'));
  v_pp := tests.make_design(jsonb_build_object('material', 'Gold', 'purity', '22K', 'selling_method', 'Per Piece'));
  v_spp := tests.make_design(jsonb_build_object('material', 'Silver', 'purity', '925', 'selling_method', 'Per Piece'));
  perform set_config('jv.d22', v_d22::text, true);

  perform set_config('jv.p_example', tests.make_piece(v_d22, jsonb_build_object('gross_weight', 40, 'customer_net_weight', 35.420, 'labour_retail', 353, 'labour_semi', 330, 'labour_wholesale', 300))::text, true);
  perform set_config('jv.p_18', tests.make_piece(v_d18, jsonb_build_object('gross_weight', 20, 'customer_net_weight', 5.000, 'labour_retail', 400, 'labour_semi', 380, 'labour_wholesale', 360))::text, true);
  perform set_config('jv.p_24', tests.make_piece(v_d24, jsonb_build_object('gross_weight', 20, 'customer_net_weight', 8.000, 'labour_retail', 500, 'labour_semi', 450, 'labour_wholesale', 420))::text, true);
  perform set_config('jv.p_s925', tests.make_piece(v_s925, jsonb_build_object('gross_weight', 20, 'customer_net_weight', 13.900, 'labour_retail', 60, 'labour_semi', 50, 'labour_wholesale', 40))::text, true);
  perform set_config('jv.p_s999', tests.make_piece(v_s999, jsonb_build_object('gross_weight', 20, 'customer_net_weight', 13.900, 'labour_retail', 60, 'labour_semi', 50, 'labour_wholesale', 40))::text, true);
  perform set_config('jv.p_pp', tests.make_piece(v_pp, jsonb_build_object('gross_weight', 20, 'customer_net_weight', 5.000, 'labour_retail', 1200, 'labour_semi', 1100, 'labour_wholesale', 1000))::text, true);
  perform set_config('jv.p_spp', tests.make_piece(v_spp, jsonb_build_object('gross_weight', 20, 'customer_net_weight', 5.000, 'labour_retail', 1200, 'labour_semi', 1200, 'labour_wholesale', 1200))::text, true);

  perform tests.make_rate(jsonb_build_object('material', 'Gold', 'purity', '22K', 'rate_per_gram', 7000.00, 'rate_date', v_today));
  perform tests.make_rate(jsonb_build_object('material', 'Gold', 'purity', '22K', 'rate_per_gram', 6900.00, 'rate_date', v_today - 3));
  perform tests.make_rate(jsonb_build_object('material', 'Gold', 'purity', '18K', 'rate_per_gram', 5800.00, 'rate_date', v_today - 1));
  perform tests.make_rate(jsonb_build_object('material', 'Silver', 'purity', '925', 'rate_per_gram', 90.00, 'rate_date', v_today - 10));
exception when others then
  raise notice 'fixtures failed: % (%)', sqlerrm, sqlstate;
end
$fx$;

-- the estimate setting: round-off on (the tests below change it where they need to)
insert into public.settings (key, value) values ('estimate', '{"roundOff": true}'::jsonb)
  on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------- 3. T-A01 again, through quote_bill (the owner)
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q01', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  jsonb_build_array(pg_temp.qi(current_setting('jv.p_example'), 6920, 353, 2.15))));
select tests.reset_role();
select is((pg_temp.got('q01') -> 'lines' -> 0 ->> 'metal_amount'), '245106.40', 'T-A01: through quote_bill, metal amount 245,106.40');
select is((pg_temp.got('q01') -> 'lines' -> 0 ->> 'labour_amount'), '12503.26', 'T-A01: through quote_bill, labour amount 12,503.26');
select is((pg_temp.got('q01') -> 'lines' -> 0 ->> 'item_total'), '257611.81', 'T-A01: through quote_bill, line total 257,611.81');
select is((pg_temp.got('q01') ->> 'grand_total'), '257612.00', 'T-A01: through quote_bill, grand total 257,612');
select is((pg_temp.got('q01') ->> 'round_off'), '0.19', 'T-A01: through quote_bill, round-off 0.19 (the setting is on)');
select is((pg_temp.got('q01') -> 'warnings'), '[]'::jsonb, 'T-A01: a gold piece with today''s rate has no warning');
select is((pg_temp.got('q01') -> 'lines' -> 0 ->> 'sku_id'), current_setting('jv.p_example'), 'X7: the line names its piece');
select is((pg_temp.got('q01') -> 'lines' -> 0 ->> 'design_no') is not null and (pg_temp.got('q01') -> 'lines' -> 0 ->> 'sku_no') is not null, true, 'X7: the line carries the design number and the piece number (the snapshot of D12)');
select is((pg_temp.got('q01') -> 'lines' -> 0 ->> 'customer_net_weight'), '35.420', 'X7: the line carries the net weight taken from the piece');
select is((pg_temp.got('q01') ->> 'bill_date'), current_setting('jv.today'), 'X7: the quote says which date it priced for');
select is((pg_temp.got('q01') ->> 'sale_type'), 'Retail', 'X7: and for which sale type');
select tests.reset_role();

-- ---------------------------------------------------------------- 4. T-A04 wholesale silver By Weight (R4, R5)
-- NW 13.9 g, labour 40 per gram: metal 0, labour 556.00, fine due 13.900, grand total 556.
create temp table t04 as
  select pg_temp.pl(pg_temp.ln('Silver', 'By Weight', 13.9, null, 85, 40), 'Wholesale') as wh,
         pg_temp.pl(pg_temp.ln('Silver', 'By Weight', 13.9, null, 85, 40), 'Semi-Wholesale') as semi,
         pg_temp.pl(pg_temp.ln('Silver', 'By Weight', 13.9, null, 85, 40), 'Retail') as retail,
         pg_temp.pl(pg_temp.ln('Gold', 'By Weight', 13.9, null, 6920, 40), 'Wholesale') as gold,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Silver', 'By Weight', 13.9, null, 85, 40)), 0, 0, 'Wholesale') as bill;
select is((select wh ->> 'metal_amount' from t04), '0.00', 'T-A04: wholesale silver By Weight has metal 0');
select is((select wh ->> 'labour_amount' from t04), '556.00', 'T-A04: labour 556.00');
select is((select wh ->> 'fine_weight_due' from t04), '13.900', 'T-A04: fine due 13.900');
select is((select wh ->> 'item_total' from t04), '556.00', 'T-A04: line total 556.00');
select is((select bill ->> 'grand_total' from t04), '556.00', 'T-A04: grand total 556');
select is((select bill ->> 'fine_weight_due' from t04), '13.900', 'T-A04: the bill''s fine due is the sum of its lines''');
select is((select semi ->> 'fine_weight_due' from t04), '0.000', 'T-A04: Semi-Wholesale silver gives fine 0');
select is((select semi ->> 'metal_amount' from t04), '1181.50', 'T-A04: and keeps the metal amount (13.9 x 85)');
select is((select retail ->> 'fine_weight_due' from t04), '0.000', 'T-A04: Retail silver gives fine 0');
select is((select gold ->> 'fine_weight_due' from t04), '0.000', 'T-A04: Wholesale gold gives fine 0');
select is((select gold ->> 'metal_amount' from t04), '96188.00', 'T-A04: and keeps the metal amount (13.9 x 6,920)');
-- the same through quote_bill: a 925 piece and a 999 piece price alike (purity changes nothing)
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q04a', pg_temp.qb(current_setting('jv.today')::date, 'Wholesale',
  jsonb_build_array(pg_temp.qi(current_setting('jv.p_s925'), 85, 40))));
select pg_temp.keep('q04b', pg_temp.qb(current_setting('jv.today')::date, 'Wholesale',
  jsonb_build_array(pg_temp.qi(current_setting('jv.p_s999'), 85, 40))));
select tests.reset_role();
select is((pg_temp.got('q04a') ->> 'grand_total'), '556.00', 'T-A04: a 925 silver piece, Wholesale, grand total 556');
select is((pg_temp.got('q04a') ->> 'fine_weight_due'), '13.900', 'T-A04: a 925 silver piece, fine due 13.900');
select is((pg_temp.got('q04b') ->> 'grand_total'), '556.00', 'T-A04: a 999 silver piece, the same grand total');
select is((pg_temp.got('q04b') ->> 'fine_weight_due'), '13.900', 'T-A04: a 999 silver piece, the same fine due');
select is((pg_temp.got('q04a') -> 'lines' -> 0 ->> 'metal_amount'), '0.00', 'T-A04: no metal amount on the 925 piece');

-- ---------------------------------------------------------------- 5. T-A05 wholesale silver Per Piece (R4)
-- The price is kept and fine is 0 (QA BIL-06): 2 pieces at 1,200.
create temp table t05 as
  select pg_temp.pl(pg_temp.ln('Silver', 'Per Piece', 5, 2, 1200, null), 'Wholesale') as r;
select is((select r ->> 'metal_amount' from t05), '2400.00', 'T-A05: 2 pieces at 1,200 give metal 2,400.00');
select is((select r ->> 'fine_weight_due' from t05), '0.000', 'T-A05: fine due 0');
select is((select r ->> 'labour_amount' from t05), '0.00', 'T-A05: a Per Piece line has no labour amount (R3)');
select is((select r ->> 'item_total' from t05), '2400.00', 'T-A05: line total 2,400.00');
select is((select r ->> 'quantity' from t05), '2', 'T-A05: the quantity is kept on the line (R6)');
select is((select r ->> 'labour_rate' from t05), '0.00', 'T-A05: the unused labour rate of a Per Piece line is 0.00');

-- ---------------------------------------------------------------- 6. T-A07 piroi and other charges once per line (R7)
create temp table t07 as
  select pg_temp.pl(pg_temp.ln('Gold', 'Per Piece', 5, 3, 1200, null, 10, 5), 'Retail') as pp,
         pg_temp.pl(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1200, null, 10, 5), 'Retail') as one,
         pg_temp.pl(pg_temp.ln('Gold', 'By Weight', 10, null, 100, 20, 7.25, 3.50), 'Retail') as bw;
select is((select pp ->> 'metal_amount' from t07), '3600.00', 'T-A07: Per Piece, quantity 3 at 1,200, metal 3,600.00');
select is((select pp ->> 'item_total' from t07), '3615.00', 'T-A07: piroi 10 and other charges 5 are added once, not three times');
select is((select pp ->> 'piroi' from t07), '10.00', 'T-A07: the piroi is saved as sent, not multiplied');
select is((select pp ->> 'other_charges' from t07), '5.00', 'T-A07: the other charges likewise');
select is((select one ->> 'item_total' from t07), '1215.00', 'T-A07: quantity 1 gives 1,215.00');
select is((select bw ->> 'item_total' from t07), '1210.75', 'T-A07: By Weight 10 g x 100 + 10 g x 20 + 7.25 + 3.50');

-- ---------------------------------------------------------------- 7. T-A08 before_round must be at least 0 (R8)
-- One Per Piece line of 1,000.00 (subtotal 1,000.00).
select is(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000, null)), 1000.01),
  'JV_INVALID_INPUT: the discount is more than the subtotal plus the additional charges',
  'T-A08: a discount of 1,000.01 on 1,000.00 is rejected');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000, null)), 1000.00) ->> 'grand_total', '0.00',
  'T-A08: a discount equal to the subtotal gives grand total 0');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000, null)), 1000.00) ->> 'round_off', '0.00',
  'T-A08: and round-off 0');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000, null)), 1050.00, 50.00) ->> 'grand_total', '0.00',
  'T-A08: a discount equal to subtotal plus additional gives grand total 0');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000, null)), 1050.01, 50.00),
  'JV_INVALID_INPUT:%', 'T-A08: one paisa more is rejected');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000, null)), 1000.00, 50.00) ->> 'grand_total', '50.00',
  'T-A08: a discount below subtotal plus additional leaves the rest');

-- ---------------------------------------------------------------- 8. T-A10 round-off on and off (R8, D11)
create temp table t10 as
  select pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.50, null)), 0, 0, 'Retail', true) as h_on,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.50, null)), 0, 0, 'Retail', false) as h_off,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.49, null)), 0, 0, 'Retail', true) as d_on,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.49, null)), 0, 0, 'Retail', false) as d_off,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.40, null)), 0, 0, 'Retail', true) as n_on,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.40, null)), 0, 0, 'Retail', false) as n_off,
         pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 5, 1, 1000.00, null)), 0, 0, 'Retail', true) as whole;
select is((select h_on ->> 'grand_total' from t10), '1001.00', 'T-A10: 1,000.50 gives 1,001 (round-off on)');
select is((select h_off ->> 'grand_total' from t10), '1001.00', 'T-A10: 1,000.50 gives 1,001 (round-off off: the grand total is a whole rupee either way)');
select is((select d_on ->> 'grand_total' from t10), '1000.00', 'T-A10: 1,000.49 gives 1,000 (round-off on)');
select is((select d_off ->> 'grand_total' from t10), '1000.00', 'T-A10: 1,000.49 gives 1,000 (round-off off)');
select is((select n_on ->> 'grand_total' from t10), '1000.00', 'T-A10: 1,000.40 gives 1,000');
select is((select n_on ->> 'round_off' from t10), '-0.40', 'T-A10: round_off is stored negative for 1,000.40 (-0.40)');
select is((select h_on ->> 'round_off' from t10), '0.50', 'T-A10: round_off 0.50 for 1,000.50');
select is((select d_on ->> 'round_off' from t10), '-0.49', 'T-A10: round_off -0.49 for 1,000.49');
select is((select n_off ->> 'round_off' from t10), '0.00', 'T-A10: round_off is 0 when the setting is off');
select is((select h_off ->> 'round_off' from t10), '0.00', 'T-A10: ... also for 1,000.50');
select is((select whole ->> 'round_off' from t10), '0.00', 'T-A10: a whole-rupee total has round_off 0');
select is((select n_on ->> 'before_round' from t10), '1000.40', 'R8: before_round is reported');
-- the same through quote_bill: the setting estimate.roundOff decides
update public.settings set value = '{"roundOff": false}'::jsonb where key = 'estimate';
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q10off', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1000.40))));
select tests.reset_role();
update public.settings set value = '{"roundOff": true}'::jsonb where key = 'estimate';
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q10on', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1000.40))));
select tests.reset_role();
delete from public.settings where key = 'estimate';
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q10absent', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1000.40))));
select tests.reset_role();
select is((pg_temp.got('q10off') ->> 'round_off'), '0.00', 'T-A10: quote_bill with estimate.roundOff off: round_off 0');
select is((pg_temp.got('q10off') ->> 'grand_total'), '1000.00', 'T-A10: ... and the grand total is still a whole rupee');
select is((pg_temp.got('q10on') ->> 'round_off'), '-0.40', 'T-A10: quote_bill with estimate.roundOff on: round_off -0.40');
select is((pg_temp.got('q10absent') ->> 'round_off'), '-0.40', 'T-A10: with no estimate setting at all the default is on (the prototype''s DEFAULT_SETTINGS)');
insert into public.settings (key, value) values ('estimate', '{"roundOff": true}'::jsonb)
  on conflict (key) do update set value = excluded.value;

-- ---------------------------------------------------------------- 9. T-A11 paise are exact (S3)
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'By Weight', 4.6, null, 92.50, 0))) ->> 'subtotal', '425.50',
  'T-A11: 4.6 g x 92.50 = 425.50');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'By Weight', 4.6, null, 92.50, 0))) ->> 'grand_total', '426.00',
  'T-A11: grand total 426 (a tie goes up)');
-- 300 random bills of 1 to 6 lines. The expected figures are whole paise worked out with integer arithmetic (bigint): a
-- product of milligrams and paise per gram is paise times 1,000, so (x + 500) / 1000 is "round half up".
select setseed(0.2026);
create temp table t11l as
  select b as bill, n as line,
         (random() * 100000)::bigint as nw, (random() * 1000000)::bigint as r, (random() * 100000)::bigint as l,
         (random() * 50000)::bigint as p, (random() * 50000)::bigint as o
    from generate_series(1, 300) b cross join lateral generate_series(1, 1 + (b % 6)) n;
create temp table t11b as
  select bill,
         sum((nw * r + 500) / 1000 + (nw * l + 500) / 1000 + p + o)::bigint as exp_sub,
         pg_temp.pb(jsonb_agg(pg_temp.ln('Gold', 'By Weight', round(nw::numeric / 1000, 3), null, round(r::numeric / 100, 2),
                                         round(l::numeric / 100, 2), round(p::numeric / 100, 2), round(o::numeric / 100, 2)) order by line)) as res
    from t11l group by bill;
select is((select count(*) from t11b)::int, 300, 'T-A11: 300 random bills were priced');
select is((select count(*) from t11b where res ? 'error')::int, 0, 'T-A11: none of them was refused');
select is(
  (select count(*) from t11b where (res ->> 'subtotal')::numeric * 100 is distinct from exp_sub)::int, 0,
  'T-A11: the subtotal of every random bill equals the integer sum of its lines (no drift)');
select is(
  (select count(*) from t11b where (res ->> 'grand_total')::numeric * 100 is distinct from ((exp_sub + 50) / 100) * 100)::int, 0,
  'T-A11: the grand total of every random bill is the subtotal rounded half up to a rupee');
select is(
  (select count(*) from t11b where (res ->> 'round_off')::numeric * 100 is distinct from ((exp_sub + 50) / 100) * 100 - exp_sub)::int, 0,
  'T-A11: and round_off is the grand total minus the subtotal');

-- ---------------------------------------------------------------- 10. T-A19 per-line paise rounding (R7)
-- Twenty lines, nine bills, worked out by hand. Each line is By Weight, Gold, Retail: metal = round(NW x r, 2), labour =
-- round(NW x l, 2), total = metal + labour + piroi + other charges. Bills A to E change the grand total by Rs 1 against
-- the unrounded sum (the prototype''s way): A, B, C go up (two lines each that round up past a half), D and E go down (three lines
-- that round down just under a half).
--   A  0.995 x 50.50 = 50.2475 -> 50.25, twice: 100.50 -> 101; unrounded 100.495 -> 100
--   B  3.712 x 17.73 = 65.81376 -> 65.81, 3.816 x 78.01 = 297.68616 -> 297.69: 363.50 -> 364; unrounded 363.49992 -> 363
--   C  0.487 x 98.66 = 48.04742 -> 48.05, 2.425 x 69.05 = 167.44625 -> 167.45: 215.50 -> 216; unrounded 215.49367 -> 215
--   D  3.001 x 93.08 = 279.33308, 5.521 x 73.04 = 403.25384, 6.324 x 63.87 = 403.91388 -> 279.33, 403.25, 403.91: 1,086.49
--      -> 1,086; unrounded 1,086.5008 -> 1,087
--   E  0.685 x 32.08 = 21.9748, 5.269 x 3.51 = 18.49419, 4.795 x 95.94 = 460.0323 -> 21.97, 18.49, 460.03: 500.49 -> 500;
--      unrounded 500.50129 -> 501
--   F to I: with labour, piroi and other charges; the grand total does not move. Lines H1 and I2 show that the metal and the
--      labour amount are each rounded to the paisa before they are added: H1 0.075 and 0.045 give 0.08 + 0.05 = 0.13 (added
--      first and then rounded: 0.12); I2 1,189.617 and 75.717 give 1,189.62 + 75.72 = 1,265.34 (added first: 1,265.33).
create temp table t19 (bill text, n int, nw numeric, r numeric, l numeric, p numeric, o numeric, metal text, labour text, total text);
insert into t19 values
  ('A', 1, 0.995, 50.50, 0.00, 0.00, 0.00, '50.25', '0.00', '50.25'),
  ('A', 2, 0.995, 50.50, 0.00, 0.00, 0.00, '50.25', '0.00', '50.25'),
  ('B', 1, 3.712, 17.73, 0.00, 0.00, 0.00, '65.81', '0.00', '65.81'),
  ('B', 2, 3.816, 78.01, 0.00, 0.00, 0.00, '297.69', '0.00', '297.69'),
  ('C', 1, 0.487, 98.66, 0.00, 0.00, 0.00, '48.05', '0.00', '48.05'),
  ('C', 2, 2.425, 69.05, 0.00, 0.00, 0.00, '167.45', '0.00', '167.45'),
  ('D', 1, 3.001, 93.08, 0.00, 0.00, 0.00, '279.33', '0.00', '279.33'),
  ('D', 2, 5.521, 73.04, 0.00, 0.00, 0.00, '403.25', '0.00', '403.25'),
  ('D', 3, 6.324, 63.87, 0.00, 0.00, 0.00, '403.91', '0.00', '403.91'),
  ('E', 1, 0.685, 32.08, 0.00, 0.00, 0.00, '21.97', '0.00', '21.97'),
  ('E', 2, 5.269, 3.51, 0.00, 0.00, 0.00, '18.49', '0.00', '18.49'),
  ('E', 3, 4.795, 95.94, 0.00, 0.00, 0.00, '460.03', '0.00', '460.03'),
  ('F', 1, 7.777, 13.33, 5.55, 1.00, 0.50, '103.67', '43.16', '148.33'),
  ('F', 2, 3.333, 6.66, 2.22, 0.00, 0.00, '22.20', '7.40', '29.60'),
  ('G', 1, 12.345, 678.90, 3.21, 0.00, 0.00, '8381.02', '39.63', '8420.65'),
  ('G', 2, 0.999, 0.99, 0.99, 0.00, 0.00, '0.99', '0.99', '1.98'),
  ('H', 1, 1.500, 0.05, 0.03, 0.00, 0.00, '0.08', '0.05', '0.13'),
  ('H', 2, 0.015, 100.00, 0.50, 0.00, 0.00, '1.50', '0.01', '1.51'),
  ('I', 1, 35.420, 6920.00, 353.00, 2.15, 0.00, '245106.40', '12503.26', '257611.81'),
  ('I', 2, 7.050, 168.74, 10.74, 0.00, 0.00, '1189.62', '75.72', '1265.34');
create temp table t19b (bill text primary key, subtotal text, grand text, unrounded text);
insert into t19b values
  ('A', '100.50', '101.00', '100'), ('B', '363.50', '364.00', '363'), ('C', '215.50', '216.00', '215'),
  ('D', '1086.49', '1086.00', '1087'), ('E', '500.49', '500.00', '501'), ('F', '177.93', '178.00', '178'),
  ('G', '8422.63', '8423.00', '8423'), ('H', '1.64', '2.00', '2'), ('I', '258877.15', '258877.00', '258877');
create temp table t19r as
  select bill, pg_temp.pb((select jsonb_agg(pg_temp.ln('Gold', 'By Weight', x.nw, null, x.r, x.l, x.p, x.o) order by x.n) from t19 x where x.bill = b.bill)) as res
    from t19b b;
select is(
  (select (r.res -> 'lines' -> (x.n - 1) ->> 'metal_amount') || '/' || (r.res -> 'lines' -> (x.n - 1) ->> 'labour_amount') || '/' || (r.res -> 'lines' -> (x.n - 1) ->> 'item_total')
     from t19r r where r.bill = x.bill),
  x.metal || '/' || x.labour || '/' || x.total,
  'T-A19: bill ' || x.bill || ' line ' || x.n || ': metal ' || x.metal || ', labour ' || x.labour || ', total ' || x.total)
  from t19 x order by x.bill, x.n;
select is((r.res ->> 'subtotal') || ' -> ' || (r.res ->> 'grand_total'), b.subtotal || ' -> ' || b.grand,
  'T-A19: bill ' || b.bill || ' subtotal ' || b.subtotal || ', grand total ' || b.grand)
  from t19r r join t19b b using (bill) order by b.bill;
select is(
  (select count(*)::int from t19b b join t19r r using (bill) where (r.res ->> 'grand_total')::numeric <> b.unrounded::numeric),
  5, 'T-A19: five of the nine bills have a grand total Rs 1 away from the unrounded sum (A, B, C up; D, E down)');
select is(
  (select count(*)::int from t19b b where abs(b.grand::numeric - b.unrounded::numeric) = 1), 5,
  'T-A19: and by exactly Rs 1');
select is(
  (select count(*)::int from t19r r cross join lateral jsonb_array_elements(r.res -> 'lines') l
    where (l ->> 'metal_amount') ~ '^[0-9]+\.[0-9]{2}$' and (l ->> 'labour_amount') ~ '^[0-9]+\.[0-9]{2}$' and (l ->> 'item_total') ~ '^[0-9]+\.[0-9]{2}$'),
  20, 'T-A19: every one of the twenty line amounts has exactly two decimals');
-- the unrounded sum, worked out in the test with exact numerics and no per-line rounding, disagrees with the function on five bills
select is(
  (select count(*)::int from t19r r
    where (r.res ->> 'grand_total')::numeric <>
          (select round(sum(x.nw * x.r + x.nw * x.l + x.p + x.o), 0) from t19 x where x.bill = r.bill)),
  5, 'T-A19: recomputed without per-line rounding, five grand totals would be different');

-- ---------------------------------------------------------------- 11. T-A09 refusals and defaults of the inputs (S4)
-- Every refusal is JV_INVALID_INPUT: never a numeric overflow, never another error.
select alike(pg_temp.tl(l), 'JV_INVALID_INPUT:%' || f || '%', 'T-A09: refused: ' || d)
  from (values
    -- weights
    (pg_temp.mut('customer_net_weight', '-0.001'), 'a negative weight', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', '100000.001'), 'a weight above 100,000 g', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', '1.2345'), 'a weight with 4 decimals', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', '1.2300'), 'a weight sent as 1.2300 (a trailing zero counts)', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight'), 'a weight that is absent', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', 'null'), 'a weight that is null', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', '"abc"'), 'a weight that is text but not a number', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', 'true'), 'a weight that is true', 'customer_net_weight'),
    (pg_temp.mut('customer_net_weight', '"-1"'), 'a negative weight sent as text', 'customer_net_weight'),
    -- metal rate (a rate, or the price of a piece)
    (pg_temp.mut('metal_rate', '-0.01'), 'a negative metal rate', 'metal_rate'),
    (pg_temp.mut('metal_rate', '100000000.01'), 'a metal rate above 100,000,000', 'metal_rate'),
    (pg_temp.mut('metal_rate', '6920.123'), 'a metal rate with 3 decimals', 'metal_rate'),
    (pg_temp.mut('metal_rate', '1.230'), 'a metal rate sent as 1.230 (a trailing zero counts)', 'metal_rate'),
    (pg_temp.mut('metal_rate'), 'a metal rate that is absent (it is required, X1)', 'metal_rate'),
    (pg_temp.mut('metal_rate', 'null'), 'a metal rate that is null', 'metal_rate'),
    (pg_temp.mut('metal_rate', '"1e3"'), 'a metal rate in exponent notation sent as text', 'metal_rate'),
    (pg_temp.mut('metal_rate', '"NaN"'), 'a metal rate NaN', 'metal_rate'),
    (pg_temp.mut('metal_rate', '[1]'), 'a metal rate that is a list', 'metal_rate'),
    (pg_temp.mut('metal_rate', '-0.01', 'Per Piece'), 'a negative piece price', 'metal_rate'),
    (pg_temp.mut('metal_rate', '100000000.01', 'Per Piece'), 'a piece price above 100,000,000', 'metal_rate'),
    (pg_temp.mut('metal_rate', null, 'Per Piece'), 'a piece price that is absent', 'metal_rate'),
    -- labour rate
    (pg_temp.mut('labour_rate', '-1'), 'a negative labour rate', 'labour_rate'),
    (pg_temp.mut('labour_rate', '100000000.01'), 'a labour rate above 100,000,000', 'labour_rate'),
    (pg_temp.mut('labour_rate', '353.005'), 'a labour rate with 3 decimals', 'labour_rate'),
    (pg_temp.mut('labour_rate', '1.230'), 'a labour rate sent as 1.230', 'labour_rate'),
    (pg_temp.mut('labour_rate'), 'a By Weight line without a labour rate', 'labour_rate'),
    (pg_temp.mut('labour_rate', 'null'), 'a By Weight line with a null labour rate', 'labour_rate'),
    -- piroi and other charges (line amounts)
    (pg_temp.mut('piroi', '-0.01'), 'a negative piroi', 'piroi'),
    (pg_temp.mut('piroi', '1000000000.01'), 'a piroi above 1,000,000,000', 'piroi'),
    (pg_temp.mut('piroi', '2.155'), 'a piroi with 3 decimals', 'piroi'),
    (pg_temp.mut('piroi', '2.150'), 'a piroi sent as 2.150', 'piroi'),
    (pg_temp.mut('other_charges', '-5'), 'negative other charges', 'other_charges'),
    (pg_temp.mut('other_charges', '1000000000.01'), 'other charges above 1,000,000,000', 'other_charges'),
    (pg_temp.mut('other_charges', '0.001'), 'other charges with 3 decimals', 'other_charges'),
    -- quantity
    (pg_temp.mut('quantity', '0', 'Per Piece'), 'quantity 0', 'quantity'),
    (pg_temp.mut('quantity', '-1', 'Per Piece'), 'a negative quantity', 'quantity'),
    (pg_temp.mut('quantity', '1001', 'Per Piece'), 'quantity 1,001', 'quantity'),
    (pg_temp.mut('quantity', '1.5', 'Per Piece'), 'quantity 1.5', 'quantity'),
    (pg_temp.mut('quantity', '"2"', 'Per Piece'), 'a quantity sent as text', 'quantity'),
    (pg_temp.mut('quantity', '2'), 'quantity 2 on a By Weight line', 'quantity'),
    -- the piece itself
    (pg_temp.mut('material', '"Platinum"'), 'a material that is neither Gold nor Silver', 'material'),
    (pg_temp.mut('material'), 'a missing material', 'material'),
    (pg_temp.mut('selling_method', '"By Piece"'), 'a selling method that is neither By Weight nor Per Piece', 'selling_method'),
    (pg_temp.mut('selling_method'), 'a missing selling method', 'selling_method'),
    ('[]'::jsonb, 'a line that is not an object', 'object'),
    ('null'::jsonb, 'a line that is null', 'object')
  ) as t(l, d, f);

select is(pg_temp.tl(l), 'ok', 'T-A09: accepted: ' || d)
  from (values
    (pg_temp.mut('customer_net_weight', '1.230'), 'a weight sent as 1.230 (3 decimals are right for a weight)'),
    (pg_temp.mut('customer_net_weight', '0'), 'a weight of 0'),
    (pg_temp.mut('customer_net_weight', '100000'), 'a weight of exactly 100,000 g'),
    (pg_temp.mut('customer_net_weight', '"12.5"'), 'a weight sent as text'),
    (pg_temp.mut('customer_net_weight', '" 12.5 "'), 'a weight sent as text with spaces round it'),
    (pg_temp.mut('metal_rate', '0'), 'a metal rate of 0'),
    (pg_temp.ln('Gold', 'Per Piece', 0, 1, 100000000, null), 'a metal rate (a piece price) of exactly 100,000,000'),
    (pg_temp.mut('metal_rate', '1.5'), 'a metal rate with one decimal'),
    (pg_temp.mut('metal_rate', '"6920.50"'), 'a metal rate sent as text'),
    (pg_temp.mut('metal_rate', '"6920."'), 'a metal rate sent as 6920. (a point and no decimals)'),
    (pg_temp.mut('metal_rate', '".5"'), 'a metal rate sent as .5'),
    (pg_temp.mut('metal_rate', '1e3'), 'a metal rate sent as the JSON number 1e3 (it is 1000)'),
    (pg_temp.mut('labour_rate', '0'), 'a labour rate of 0'),
    (pg_temp.ln('Gold', 'By Weight', 0.001, null, 6920, 100000000), 'a labour rate of exactly 100,000,000'),
    (pg_temp.mut('piroi', 'null'), 'a null piroi (absent)'),
    (pg_temp.mut('other_charges', '0.01'), 'other charges of 0.01'),
    (pg_temp.mut('quantity', 'null'), 'a null quantity (absent: 1)'),
    (pg_temp.mut('quantity', '1'), 'quantity 1 on a By Weight line'),
    (pg_temp.mut('quantity', '1.0'), 'quantity sent as 1.0 (a whole number)'),
    (pg_temp.mut('quantity', '1000', 'Per Piece'), 'quantity 1,000 on a Per Piece line'),
    (pg_temp.mut('labour_rate', null, 'Per Piece'), 'a Per Piece line without a labour rate'),
    (pg_temp.mut('labour_rate', '-5', 'Per Piece'), 'a Per Piece line with a labour rate that would be refused on a By Weight line (it is ignored, R3)'),
    (pg_temp.mut('labour_rate', '"abc"', 'Per Piece'), 'a Per Piece line with a labour rate that is not a number (ignored)')
  ) as t(l, d);
-- a piroi or other charges of exactly 1,000,000,000 is within the cap when nothing else is on the line
select is(pg_temp.tl(pg_temp.ln('Gold', 'Per Piece', 0, 1, 0, null, 1000000000, 0)), 'ok', 'T-A09: a piroi of exactly 1,000,000,000 is accepted');
select is(pg_temp.tl(pg_temp.ln('Gold', 'Per Piece', 0, 1, 0, null, 0, 1000000000)), 'ok', 'T-A09: other charges of exactly 1,000,000,000 are accepted');

-- the defaults: an absent piroi, other_charges and quantity mean 0, 0 and 1
create temp table t09 as
  select pg_temp.pl(pg_temp.mut('quantity'))              as bw_absent,
         pg_temp.pl(pg_temp.mut('quantity', 'null'))      as bw_null,
         pg_temp.pl(pg_temp.mut('quantity', null, 'Per Piece')) as pp_absent;
select is((select bw_absent ->> 'quantity' from t09), '1', 'T-A09: an absent quantity is 1');
select is((select bw_absent ->> 'piroi' from t09), '0.00', 'T-A09: an absent piroi is 0');
select is((select bw_absent ->> 'other_charges' from t09), '0.00', 'T-A09: absent other charges are 0');
select is((select bw_null ->> 'quantity' from t09), '1', 'T-A09: a null quantity is 1');
select is((select pp_absent ->> 'item_total' from t09), '1200.00', 'T-A09: a Per Piece line with the quantity absent is priced for one piece');

-- the bill level inputs
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), -0.01), 'JV_INVALID_INPUT:%', 'T-A09: a negative discount is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 1000000000.01), 'JV_INVALID_INPUT:%', 'T-A09: a discount above 1,000,000,000 is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 10.005), 'JV_INVALID_INPUT:%', 'T-A09: a discount with 3 decimals is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 1.230), 'JV_INVALID_INPUT:%', 'T-A09: a discount sent as 1.230 is refused (a trailing zero counts)');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, -0.01), 'JV_INVALID_INPUT:%', 'T-A09: negative additional charges are refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, 1000000000.01), 'JV_INVALID_INPUT:%', 'T-A09: additional charges above 1,000,000,000 are refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, 0.001), 'JV_INVALID_INPUT:%', 'T-A09: additional charges with 3 decimals are refused');
select is(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, 5.50), 'ok', 'T-A09: additional charges of 5.50 are fine');
select is(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), null, null), 'ok', 'T-A09: an absent (null) discount and additional charges are 0');
select is(pg_temp.pb(jsonb_build_array(pg_temp.mut('quantity')), null, null) ->> 'discount', '0.00', 'T-A09: ... and are reported as 0.00');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 'NaN'::numeric), 'JV_INVALID_INPUT:%', 'T-A09: a discount that is not a number (NaN) is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 'Infinity'::numeric), 'JV_INVALID_INPUT:%', 'T-A09: a discount of infinity is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, '-Infinity'::numeric), 'JV_INVALID_INPUT:%', 'T-A09: additional charges of minus infinity are refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, 0, 'Platinum'), 'JV_INVALID_INPUT:%', 'T-A09: a sale type that is not one of the three is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, 0, null), 'JV_INVALID_INPUT:%', 'T-A09: a null sale type is refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity')), 0, 0, 'Retail', null), 'JV_INVALID_INPUT:%', 'T-A09: a null round-off setting is refused');
select alike(pg_temp.tl(pg_temp.mut('quantity'), 'Platinum'), 'JV_INVALID_INPUT:%', 'T-A09: price_line refuses a sale type that is not one of the three');
select alike(pg_temp.tb('{"a": 1}'::jsonb), 'JV_INVALID_INPUT:%', 'T-A09: lines that are not a list are refused');
select alike(pg_temp.tb('[]'::jsonb), 'JV_INVALID_INPUT:%', 'T-A09: a bill with no lines is refused');
select alike(pg_temp.tb(null), 'JV_INVALID_INPUT:%', 'T-A09: null lines are refused');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.mut('quantity'), pg_temp.mut('metal_rate', '-1'))), 'JV_INVALID_INPUT: line 2:%', 'T-A09: the message names the line that was wrong');

-- ---------------------------------------------------------------- 12. T-A18 computed amounts are capped (S4)
-- 100,000 g at a rate of 100,000,000: 10^13, an amount, not an overflow.
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 100000000, 0)), 'JV_INVALID_INPUT:%',
  'T-A18: 100,000 g at a metal rate of 100,000,000 is JV_INVALID_INPUT');
select is(
  pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 100000000, 0)) ~ '^JV_INVALID_INPUT: ' and pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 100000000, 0)) !~* 'overflow',
  true, 'T-A18: ... and not a numeric overflow');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 0, 100000000)), 'JV_INVALID_INPUT:%',
  'T-A18: 100,000 g at a labour rate of 100,000,000 is JV_INVALID_INPUT');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.01, 0)), 'JV_INVALID_INPUT:%',
  'T-A18: a metal amount of 1,000,001,000 is refused');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 0, 10000.01)), 'JV_INVALID_INPUT:%',
  'T-A18: a labour amount of 1,000,001,000 is refused');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'Per Piece', 5, 1000, 100000000, null)), 'JV_INVALID_INPUT:%',
  'T-A18: 1,000 pieces at 100,000,000 each is refused');
select is(pg_temp.pl(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.00, 0)) ->> 'item_total', '1000000000.00',
  'T-A18: a line total of exactly 1,000,000,000 is accepted');
select is(pg_temp.pl(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.00, 0)) ->> 'metal_amount', '1000000000.00',
  'T-A18: ... the metal amount being exactly the cap');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.00, 0, 0.01, 0)), 'JV_INVALID_INPUT:%',
  'T-A18: one paisa more (a piroi of 0.01) is refused');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.00, 0, 0, 0.01)), 'JV_INVALID_INPUT:%',
  'T-A18: one paisa more (other charges of 0.01) is refused');
select is(pg_temp.pl(pg_temp.ln('Gold', 'By Weight', 100000, null, 9999.99, 0.01, 0, 0)) ->> 'item_total', '1000000000.00',
  'T-A18: metal 999,999,000.00 plus labour 1,000.00 is exactly 1,000,000,000.00 and passes');
select alike(pg_temp.tl(pg_temp.ln('Gold', 'By Weight', 100000, null, 9999.99, 0.02, 0, 0)), 'JV_INVALID_INPUT:%',
  'T-A18: metal 999,999,000.00 plus labour 2,000.00 is over the cap by 1,000.00 and is refused');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.00, 0)), 0, 0.40) ->> 'grand_total', '1000000000.00',
  'T-A18: a subtotal of 1,000,000,000 and 0.40 of additional charges rounds to a grand total of exactly 1,000,000,000: accepted');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'By Weight', 100000, null, 10000.00, 0)), 0, 0.50), 'JV_INVALID_INPUT:%',
  'T-A18: 0.50 of additional charges makes the grand total 1,000,000,001: refused');
-- 6 pieces at 100,000,000 (the rate cap) are 600,000,000; 4 are 400,000,000
select alike(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 1, 6, 100000000, null), pg_temp.ln('Gold', 'Per Piece', 1, 6, 100000000, null))),
  'JV_INVALID_INPUT:%', 'T-A18: two lines of 600,000,000 each: a subtotal of 1,200,000,000 is refused');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 1, 6, 100000000, null), pg_temp.ln('Gold', 'Per Piece', 1, 4, 100000000, null))) ->> 'subtotal', '1000000000.00',
  'T-A18: two lines that make exactly 1,000,000,000: accepted');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 1, 6, 100000000, null), pg_temp.ln('Gold', 'Per Piece', 1, 4, 100000000, null, 0.01, 0))),
  'JV_INVALID_INPUT: the subtotal is above the cap%', 'T-A18: and one paisa more is refused (the subtotal)');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 1, 10, 100000000, null)), 0, 1000000000), 'JV_INVALID_INPUT: the grand total is above the cap%',
  'T-A18: a grand total of 2,000,000,000 is refused');
select is(pg_temp.pb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 1, 10, 100000000, null)), 1000000000.00, 0) ->> 'grand_total', '0.00',
  'T-A18: a discount of exactly 1,000,000,000 is accepted');
select alike(pg_temp.tb(jsonb_build_array(pg_temp.ln('Gold', 'Per Piece', 1, 10, 100000000, null)), 1000000000.01, 1000000000), 'JV_INVALID_INPUT: discount is above the cap%',
  'T-A18: a discount of 1,000,000,000.01 is refused even when subtotal plus additional charges would cover it');
-- the cap comes from private.limits, which the functions read
select is((select value from private.limits where name = 'max_amount'), 1000000000::numeric, 'S4: private.limits.max_amount is the cap the functions read');
-- a money path never meets a float
select is(
  (select count(*) filter (where pg_get_functiondef(p.oid) ~* '\m(real|double precision|float4|float8|float)\M') = 0 and count(*) >= 8
     from pg_proc p
    where p.pronamespace in ('private'::regnamespace, 'public'::regnamespace)
      and p.proname in ('price_line', 'price_bill', 'price_line_v1', 'price_bill_v1', 'default_rate', 'list_prices', 'quote_bill', 'price_items', 'read_decimal')),
  true, 'S3: the pricing functions exist and none of them mentions real, double precision or float');

-- ---------------------------------------------------------------- 13. T-A16 a bill of 40 lines, 200 accepted, 201 rejected (S4)
create temp table t16 as
  select pg_temp.pb((select jsonb_agg(pg_temp.ln('Gold', 'By Weight', (i * 1.5)::numeric(12, 3), null, 1000 + i, 10 + i, 0.25, 0.05) order by i) from generate_series(1, 40) i)) as r;
select is((select jsonb_array_length(r -> 'lines') from t16), 40, 'T-A16: the 40-line bill has 40 priced lines');
select ok(
  (select (r ->> 'subtotal')::numeric is not null and (r ->> 'subtotal')::numeric = (select sum((x ->> 'item_total')::numeric) from jsonb_array_elements(r -> 'lines') x) from t16),
  'T-A16: a 40-line bill totals the sum of its lines');
select is(
  (select (r ->> 'subtotal')::numeric from t16),
  (select sum(round(i * 1.5 * (1000 + i), 2) + round(i * 1.5 * (10 + i), 2) + 0.25 + 0.05) from generate_series(1, 40) i),
  'T-A16: ... which is the sum worked out again in the test');
select is((select r ->> 'fine_weight_due' from t16), '0.000', 'T-A16: no fine on Retail gold');
select is(
  pg_temp.tb((select jsonb_agg(pg_temp.ln('Gold', 'Per Piece', 1, 1, 100, null)) from generate_series(1, 200))),
  'ok', 'T-A16: 200 lines are accepted');
select alike(
  pg_temp.tb((select jsonb_agg(pg_temp.ln('Gold', 'Per Piece', 1, 1, 100, null)) from generate_series(1, 201))),
  'JV_INVALID_INPUT:%', 'T-A16: 201 lines are rejected');
select is(
  (select (pg_temp.pb((select jsonb_agg(pg_temp.ln('Gold', 'Per Piece', 1, 1, 100, null)) from generate_series(1, 200))) ->> 'subtotal')),
  '20000.00', 'T-A16: 200 lines of 100 make 20,000.00');
-- through quote_bill, with real pieces
insert into public.skus (design_id, sku_no, barcode, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale)
  select current_setting('jv.d22')::uuid, 'T16-' || g, 'T16-BC-' || g, 10, 2.5, 100, 100, 100 from generate_series(1, 201) g;
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q16ok', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  (select jsonb_agg(pg_temp.qi(s.id::text, 7000, 100) order by s.sku_no) from (select * from public.skus where sku_no ~ '^T16-([1-9]|[1-9][0-9]|1[0-9][0-9]|200)$') s)));
select pg_temp.keep('q16bad', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  (select jsonb_agg(pg_temp.qi(s.id::text, 7000, 100) order by s.sku_no) from (select * from public.skus where sku_no ~ '^T16-') s)));
select pg_temp.keep('q16unknown', pg_temp.qb(current_setting('jv.today')::date, 'Retail',
  (select jsonb_agg(pg_temp.qi(gen_random_uuid()::text, 7000, 100)) from generate_series(1, 201))));
select tests.reset_role();
select is(jsonb_array_length(pg_temp.got('q16ok') -> 'lines'), 200, 'T-A16: quote_bill prices 200 pieces');
select is((pg_temp.got('q16ok') ->> 'subtotal'), '3550000.00', 'T-A16: ... 200 x (2.5 g x 7,000 + 2.5 g x 100) = 3,550,000.00');
select alike((pg_temp.got('q16bad') ->> 'error'), 'JV_INVALID_INPUT:%', 'T-A16: quote_bill rejects 201 pieces');
select alike((pg_temp.got('q16unknown') ->> 'error'), 'JV_INVALID_INPUT:%', 'T-A16: ... before it looks any of them up (unknown pieces would be JV_NOT_FOUND)');

-- ---------------------------------------------------------------- 14. T-A13 list prices and the daily rates (D4, R2, R14)
-- Today: Gold 22K 7,000 (today) and 6,900 (3 days ago); Gold 18K 5,800 (yesterday); Silver 925 90 (10 days ago); nothing for 24K.
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date) ->> 'rate_per_gram', '7000.00', 'T-A13: today the 22K rate is the one dated today');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date) ->> 'status', 'ok', 'T-A13: ... and it is not stale');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 1) ->> 'rate_per_gram', '6900.00', 'T-A13: a bill dated yesterday gets the latest rate not after it (3 days ago)');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 1) ->> 'status', 'stale', 'T-A13: ... and that is stale');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 3) ->> 'rate_per_gram', '6900.00', 'T-A13: a bill backdated 3 days gets that day''s rate');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 3) ->> 'status', 'ok', 'T-A13: ... and it is not stale');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 3) ->> 'rate_date', (current_setting('jv.today')::date - 3)::text, 'T-A13: the date of the rate used is reported');
select is(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 4) ->> 'status', 'missing', 'T-A13: a bill dated before every rate has no rate (a later rate is never used)');
select ok(pg_temp.dr('Gold', '22K', current_setting('jv.today')::date - 4) -> 'rate_per_gram' = 'null'::jsonb, 'T-A13: ... and the rate is null');
select is(pg_temp.dr('Gold', '18K', current_setting('jv.today')::date) ->> 'rate_per_gram', '5800.00', 'T-A13: 18K has its own rate');
select is(pg_temp.dr('Gold', '18K', current_setting('jv.today')::date) ->> 'status', 'stale', 'T-A13: 18K''s rate is from yesterday: stale');
select is(pg_temp.dr('Gold', '24K', current_setting('jv.today')::date) ->> 'status', 'missing', 'T-A13: 24K has no rate at all: missing');
select is(pg_temp.dr('Silver', '925', current_setting('jv.today')::date) ->> 'rate_per_gram', '90.00', 'T-A13: Silver 925 has its rate from 10 days ago');
select is(pg_temp.dr('Silver', '22K', current_setting('jv.today')::date) ->> 'status', 'missing', 'T-A13: the material counts: there is no Silver 22K rate');
select is(pg_temp.dr('Gold', '925', current_setting('jv.today')::date) ->> 'status', 'missing', 'T-A13: nor a Gold 925 rate');

select is(pg_temp.lp(current_setting('jv.p_example'), 'Retail', current_setting('jv.today')::date) ->> 'list_metal_rate', '7000.00', 'T-A13: the list metal rate of a 22K piece is the 22K rate of the day');
select is(pg_temp.lp(current_setting('jv.p_18'), 'Retail', current_setting('jv.today')::date) ->> 'list_metal_rate', '5800.00', 'T-A13: an 18K piece gets the 18K rate, not the 22K one');
select is(pg_temp.lp(current_setting('jv.p_example'), 'Retail', current_setting('jv.today')::date - 3) ->> 'list_metal_rate', '6900.00', 'T-A13: a backdated bill gets the rate of that date');
select is(pg_temp.lp(current_setting('jv.p_example'), 'Retail', current_setting('jv.today')::date) ->> 'list_labour_rate', '353.00', 'R14: the list labour rate is the piece''s Retail rate');
select is(pg_temp.lp(current_setting('jv.p_example'), 'Semi-Wholesale', current_setting('jv.today')::date) ->> 'list_labour_rate', '330.00', 'R14: Semi-Wholesale: the semi rate');
select is(pg_temp.lp(current_setting('jv.p_example'), 'Wholesale', current_setting('jv.today')::date) ->> 'list_labour_rate', '300.00', 'R14: Wholesale: the wholesale rate');
select ok(pg_temp.lp(current_setting('jv.p_24'), 'Retail', current_setting('jv.today')::date) -> 'list_metal_rate' = 'null'::jsonb, 'T-A13: no daily rate: the list metal rate is null');
select is(pg_temp.lp(current_setting('jv.p_24'), 'Retail', current_setting('jv.today')::date) ->> 'rate_status', 'missing', 'T-A13: ... and the status says missing');
select is(pg_temp.lp(current_setting('jv.p_pp'), 'Retail', current_setting('jv.today')::date) ->> 'list_metal_rate', '1200.00', 'R14: a Per Piece piece: the list metal rate is the piece price for the sale type (Retail)');
select is(pg_temp.lp(current_setting('jv.p_pp'), 'Semi-Wholesale', current_setting('jv.today')::date) ->> 'list_metal_rate', '1100.00', 'R14: ... Semi-Wholesale');
select is(pg_temp.lp(current_setting('jv.p_pp'), 'Wholesale', current_setting('jv.today')::date) ->> 'list_metal_rate', '1000.00', 'R14: ... Wholesale');
select ok(pg_temp.lp(current_setting('jv.p_pp'), 'Retail', current_setting('jv.today')::date) -> 'list_labour_rate' = 'null'::jsonb, 'R14: a Per Piece line is compared on the price only: no list labour rate');
select alike(pg_temp.try(format('select private.list_prices(%L::uuid, ''Retail'', current_date)', gen_random_uuid())), 'JV_NOT_FOUND:%', 'R14: a piece that does not exist is JV_NOT_FOUND');
select alike(pg_temp.try(format('select private.list_prices(%L::uuid, ''Platinum'', current_date)', current_setting('jv.p_pp'))), 'JV_INVALID_INPUT:%', 'R14: a sale type that is not one of the three is refused');

-- the same through quote_bill, as the owner: the list prices and the warnings
select tests.as_user(current_setting('jv.owner')::uuid);
select pg_temp.keep('q13', pg_temp.qb(current_setting('jv.today')::date, 'Retail', jsonb_build_array(
  pg_temp.qi(current_setting('jv.p_example'), 7000, 353),   -- 22K, today's rate: no warning
  pg_temp.qi(current_setting('jv.p_18'), 5800, 400),        -- 18K, yesterday's rate: stale
  pg_temp.qi(current_setting('jv.p_24'), 8000, 500),        -- 24K, no rate: missing
  pg_temp.qi(current_setting('jv.p_s925'), 90, 60),         -- silver 925, 10 days old: stale
  pg_temp.qi(current_setting('jv.p_pp'), 1200)              -- Per Piece: never a rate warning
)));
select pg_temp.keep('q13back', pg_temp.qb(current_setting('jv.today')::date - 3, 'Retail', jsonb_build_array(
  pg_temp.qi(current_setting('jv.p_example'), 6900, 353),   -- backdated: the 3-day-old rate is that day's rate
  pg_temp.qi(current_setting('jv.p_18'), 5800, 400)         -- no 18K rate dated that day or before
)));
select pg_temp.keep('q13whole', pg_temp.qb(current_setting('jv.today')::date, 'Wholesale', jsonb_build_array(
  pg_temp.qi(current_setting('jv.p_pp'), 1000),
  pg_temp.qi(current_setting('jv.p_example'), 7000, 300)
)));
select tests.reset_role();
select is((pg_temp.got('q13') -> 'lines' -> 0 ->> 'list_metal_rate'), '7000.00', 'T-A13: quote_bill: the 22K line''s list metal rate');
select is((pg_temp.got('q13') -> 'lines' -> 1 ->> 'list_metal_rate'), '5800.00', 'T-A13: quote_bill: the 18K line''s own list metal rate');
select is((pg_temp.got('q13') -> 'lines' -> 3 ->> 'list_metal_rate'), '90.00', 'T-A13: quote_bill: the silver 925 line''s list metal rate');
select ok((pg_temp.got('q13') -> 'lines' -> 2 -> 'list_metal_rate') = 'null'::jsonb, 'T-A13: quote_bill: the 24K line has no list metal rate');
select is((pg_temp.got('q13') -> 'lines' -> 0 ->> 'list_labour_rate'), '353.00', 'R14: quote_bill: the list labour rate of the 22K line');
select is((pg_temp.got('q13') -> 'lines' -> 4 ->> 'list_metal_rate'), '1200.00', 'R14: quote_bill: the Per Piece line''s list metal rate is its price');
select ok((pg_temp.got('q13') -> 'lines' -> 4 -> 'list_labour_rate') = 'null'::jsonb, 'R14: quote_bill: ... and it has no list labour rate');
select is(jsonb_array_length(pg_temp.got('q13') -> 'warnings'), 3, 'R2: three warnings: two stale, one missing');
select is((pg_temp.got('q13') -> 'warnings' -> 0 ->> 'code'), 'RATE_STALE', 'R2: the first is RATE_STALE (the 18K line)');
select is((pg_temp.got('q13') -> 'warnings' -> 0 ->> 'line_no'), '2', 'R2: ... on line 2');
select is((pg_temp.got('q13') -> 'warnings' -> 0 ->> 'rate_date'), (current_setting('jv.today')::date - 1)::text, 'R2: ... with the date of the rate used');
select is((pg_temp.got('q13') -> 'warnings' -> 1 ->> 'code'), 'RATE_MISSING', 'R2: the second is RATE_MISSING (the 24K line)');
select is((pg_temp.got('q13') -> 'warnings' -> 1 ->> 'line_no'), '3', 'R2: ... on line 3');
select is((pg_temp.got('q13') -> 'warnings' -> 1 ->> 'purity'), '24K', 'R2: ... naming the purity');
select is((pg_temp.got('q13') -> 'warnings' -> 2 ->> 'code'), 'RATE_STALE', 'R2: the third is RATE_STALE (the silver line)');
select is((pg_temp.got('q13') -> 'warnings' -> 2 ->> 'line_no'), '4', 'R2: ... on line 4');
select is((pg_temp.got('q13') -> 'lines' -> 4 ->> 'item_total'), '1200.00', 'R2: a warning does not stop the pricing (the bill still saves, T-A17)');
select is((pg_temp.got('q13back') -> 'lines' -> 0 ->> 'list_metal_rate'), '6900.00', 'T-A13: a backdated quote: the 22K line gets the rate of that date');
select is((pg_temp.got('q13back') -> 'warnings' -> 0 ->> 'code'), 'RATE_MISSING', 'T-A13: a backdated quote: the 18K line has no rate dated that day or before');
select is(jsonb_array_length(pg_temp.got('q13back') -> 'warnings'), 1, 'T-A13: ... and that is its only warning (the 22K rate is dated that day)');
select is((pg_temp.got('q13whole') -> 'lines' -> 0 ->> 'list_metal_rate'), '1000.00', 'R14: a Wholesale quote: the Per Piece list price is the wholesale price');
select is((pg_temp.got('q13whole') -> 'lines' -> 1 ->> 'list_labour_rate'), '300.00', 'R14: ... and the By Weight list labour rate is the wholesale rate');

-- ---------------------------------------------------------------- 15. quote_bill: who may call it, what it reads (X7, A6)
select is(
  (select p.provolatile from pg_proc p where p.oid = to_regprocedure('public.quote_bill(date, text, jsonb, numeric, numeric, integer)')),
  's', 'X7: quote_bill is STABLE, so the database itself refuses a write inside it');
select is(
  (select p.prosecdef from pg_proc p where p.oid = to_regprocedure('public.quote_bill(date, text, jsonb, numeric, numeric, integer)')),
  true, 'A6: quote_bill is security definer (it calls private.price_bill, which authenticated may not run)');
select is(
  (select p.proconfig from pg_proc p where p.oid = to_regprocedure('public.quote_bill(date, text, jsonb, numeric, numeric, integer)')),
  array['search_path=""'], 'A6: ... with an empty search_path');
select is(has_function_privilege('authenticated', to_regprocedure('public.quote_bill(date, text, jsonb, numeric, numeric, integer)'), 'EXECUTE'), true, 'A6: authenticated may run quote_bill');
select is(has_function_privilege('anon', to_regprocedure('public.quote_bill(date, text, jsonb, numeric, numeric, integer)'), 'EXECUTE'), false, 'A6: anon may not');
select is(
  (select count(*)::int from pg_proc p
    where p.pronamespace = 'private'::regnamespace
      and (p.proname like 'price\_%' or p.proname like 'list\_%' or p.proname like 'read\_%'
           or p.proname in ('default_rate', 'limit_value', 'round_off_setting', 'current_pricing_version'))
      and (has_function_privilege('authenticated', p.oid, 'EXECUTE') or has_function_privilege('anon', p.oid, 'EXECUTE')
           or has_function_privilege('public', p.oid, 'EXECUTE'))),
  0, 'A3: no function of the pricing code in private can be run by authenticated, anon or PUBLIC');
select ok(
  (select count(*) from pg_proc p where p.pronamespace = 'private'::regnamespace and p.proname in ('price_line', 'price_bill', 'price_line_v1', 'price_bill_v1', 'price_items', 'default_rate', 'list_prices')) = 7,
  'A3: ... and there are the seven of them to check');

select tests.as_user(current_setting('jv.biller')::uuid);
select pg_temp.keep('q15biller', pg_temp.qb(current_setting('jv.today')::date, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200))));
select tests.as_user(current_setting('jv.staff')::uuid);
select pg_temp.keep('q15staff', pg_temp.qb(current_setting('jv.today')::date, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200))));
select tests.as_user(current_setting('jv.inactive')::uuid);
select pg_temp.keep('q15inactive', pg_temp.qb(current_setting('jv.today')::date, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200))));
select tests.as_anon();
select pg_temp.keep('q15anon', pg_temp.qb(current_setting('jv.today')::date, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200))));
select tests.reset_role();
select is((pg_temp.got('q15biller') ->> 'grand_total'), '1200.00', 'X7: the biller may quote');
select alike((pg_temp.got('q15staff') ->> 'error'), 'JV_FORBIDDEN:%', 'X7: staff may not (JV_FORBIDDEN)');
select alike((pg_temp.got('q15inactive') ->> 'error'), 'JV_FORBIDDEN:%', 'X7: a login that is not active may not (JV_FORBIDDEN)');
select alike((pg_temp.got('q15anon') ->> 'error'), 'permission denied%', 'X7: anon cannot even call it');

select tests.as_user(current_setting('jv.owner')::uuid);
-- no date: today
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_example'), 7000, 353))) ->> 'bill_date', current_setting('jv.today'), 'X7: no bill date means today (Asia/Kolkata)');
-- the inputs of quote_bill
select alike(pg_temp.qb(null, 'Platinum', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: a sale type that is not one of the three is refused');
select alike(pg_temp.qb(null, 'Retail', '[]'::jsonb) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: no items is refused');
select alike(pg_temp.qb(null, 'Retail', null) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: null items are refused');
select alike(pg_temp.qb(null, 'Retail', '{"sku_id": 1}'::jsonb) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: items that are not a list are refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(1)) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: an item that is not an object is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi('not-a-uuid', 1200))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: a piece id that is not a uuid is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array('{"metal_rate": 1200}'::jsonb)) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: an item with no piece id is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(gen_random_uuid()::text, 1200))) ->> 'error', 'JV_NOT_FOUND:%', 'X7: a piece that does not exist is JV_NOT_FOUND');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200), pg_temp.qi(current_setting('jv.p_pp'), 1200))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: the same piece on two lines is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_example'), null, 353))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: an item with no metal rate is refused (metal_rate is required)');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_example'), 7000, null))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: a By Weight item with no labour rate is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_example'), 7000, 353, null, null, 2))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: a By Weight item with quantity 2 is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200, null, null, null, 1001))) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: quantity 1,001 is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200)), -1) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: a negative discount is refused');
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200)), 1200.01) ->> 'error', 'JV_INVALID_INPUT:%', 'X7: a discount that makes the total negative is refused');
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200, null, 10, 5, 3)), 100, 50) ->> 'grand_total', '3565.00', 'X7: 3 pieces at 1,200, piroi 10, other 5, discount 100, additional 50 = 3,565');
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200, null, 10, 5, 3)), 100, 50) ->> 'discount', '100.00', 'X7: the quote reports the discount');
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200, null, 10, 5, 3)), 100, 50) ->> 'additional_charges', '50.00', 'X7: and the additional charges');
select tests.reset_role();

-- the original weight is nowhere in a quote
select is((pg_temp.got('q01') ? 'lines') and not (pg_temp.got('q01')::text ~* 'original'), true, 'D12: no original weight in a quote');

-- ---------------------------------------------------------------- 16. R13 the dispatch by pricing version
select alike(pg_temp.try('select private.price_line(2, ''Retail'', ''{}''::jsonb)'), 'JV_INVALID_INPUT:%', 'R13: version 2 is not available yet: price_line refuses it');
select alike(pg_temp.try('select private.price_bill(2, ''Retail'', ''[]''::jsonb, 0, 0, true)'), 'JV_INVALID_INPUT:%', 'R13: ... and price_bill');
select alike(pg_temp.try('select private.price_bill(0, ''Retail'', ''[]''::jsonb, 0, 0, true)'), 'JV_INVALID_INPUT:%', 'R13: version 0 is refused');
select alike(pg_temp.try('select private.price_bill(-1, ''Retail'', ''[]''::jsonb, 0, 0, true)'), 'JV_INVALID_INPUT:%', 'R13: a negative version is refused');
select alike(pg_temp.try('select private.price_bill(null, ''Retail'', ''[]''::jsonb, 0, 0, true)'), 'JV_INVALID_INPUT:%', 'R13: a null version is refused');
select tests.as_user(current_setting('jv.owner')::uuid);
select alike(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200)), 0, 0, 2) ->> 'error', 'JV_INVALID_INPUT:%', 'R13: quote_bill with version 2: refused while it does not exist');
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200)), 0, 0, 1) ->> 'pricing_version', '1', 'R13: quote_bill with version 1');
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200))) ->> 'pricing_version', '1', 'R13: quote_bill with no version uses the current one (1)');
select tests.reset_role();
-- a test-only version 2, registered inside this transaction: the dispatch finds it by its name
create function private.price_line_v2(p_sale_type text, p_line jsonb, p_at text) returns jsonb
  language sql stable set search_path = '' as $f$ select jsonb_build_object('version', 2, 'sale_type', p_sale_type) $f$;
create function private.price_bill_v2(p_sale_type text, p_lines jsonb, p_discount numeric, p_additional numeric, p_round_off boolean) returns jsonb
  language sql stable set search_path = '' as $f$ select jsonb_build_object('version', 2, 'lines', p_lines, 'grand_total', '7.00') $f$;
select is(pg_temp.plv(2, 'Wholesale', '{}'::jsonb), '{"version": 2, "sale_type": "Wholesale"}'::jsonb, 'R13: a version 2 made in the transaction is found by price_line');
select is(pg_temp.pbv(2, 'Retail', '[1]'::jsonb) ->> 'grand_total', '7.00', 'R13: ... and by price_bill');
select is(pg_temp.pbv(1, 'Retail', jsonb_build_array(pg_temp.mut('quantity'))) ->> 'pricing_version', '1', 'R13: version 1 is unchanged beside it');
select tests.as_user(current_setting('jv.owner')::uuid);
select is(pg_temp.qb(null, 'Retail', jsonb_build_array(pg_temp.qi(current_setting('jv.p_pp'), 1200)), 0, 0, 2) ->> 'version', '2', 'R13: quote_bill passes the version on: its figures come from version 2');
select tests.reset_role();

select * from finish();
rollback;
