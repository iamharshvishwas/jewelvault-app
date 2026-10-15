-- 0012 seeds on an empty project (task DB05). Spec: D20, D3, D5, D10, K5.
-- Tests: supabase/tests/database/040_audit_counters.test.sql (section 10) and tests/db/numbering.test.ts (tests.reset_business_data).
--
-- What an empty project starts with, and nothing else (D20): the settings rows of the prototype's DEFAULT_SETTINGS, the
-- categories with their prefixes and subcategories (DEFAULT_CATEGORIES, DEFAULT_CATEGORY_PREFIXES, DEFAULT_SUBCATEGORY_LIST),
-- and the walk-in customer. NO SAMPLE DATA, EVER: the prototype replaced stored data it could not read with MOCK_* records and
-- the next save erased the real ones (appStore.ts:105, designStore.ts:11-20). This function holds no such record, and it
-- inserts with ON CONFLICT DO NOTHING, so calling it again changes nothing and never overwrites what the owner has edited.
--
-- It is called twice in this project's life: at the end of this migration (production gets the migrations alone, and the same
-- rows, DB21), and by tests.reset_business_data() after it has emptied the tables. Everything it writes is audited like any
-- other write, with no actor and the role import (the database owner's connection, L1).
--
-- The values are the prototype's, with these changes of D3: the default gold and silver rates are daily_rates rows now, not
-- settings (so estimate holds the number prefix, the round-off flag and the footer note); the users list is profiles; and the
-- locations are a key of their own (EditStockClient.tsx:13), the first being the location of a new piece (X8).

create or replace function private.seed_defaults()
returns void
language plpgsql
set search_path = ''
as $$
begin
  -- D3: one row per key, never one blob. data_epoch is a timestamp as text that bulk database work changes (C4).
  insert into public.settings (key, value) values
    ('business', jsonb_build_object(
      'legalName', 'Jaishri Gold Palace Pvt Ltd',
      'displayName', 'Jaishri Gold Palace',
      'location', 'Main Showroom',
      'ownerName', 'Jaishri Admin',
      'phone', '',
      'address', '',
      'gstin', '',
      'tagline', 'Gold, silver, barcode inventory and POS')),
    ('estimate', jsonb_build_object(
      'prefix', 'JV',
      'roundOff', true,
      'footerNote', 'This is an estimate only. GST is not charged on this document.')),
    ('taxes', jsonb_build_object(
      'gstEnabled', false,
      'gstPercent', 0,
      'estimateTaxPercent', 0)),
    ('tag_template', jsonb_build_object(
      'widthMm', 52,
      'heightMm', 28,
      'fontSize', 10,
      'barcodeHeightMm', 8,
      'showBusinessName', true,
      'showDesignNumber', true,
      'showCategory', true,
      'showMaterial', true,
      'showCustomerNetWeight', true,
      'showGrossWeight', true,
      'showPiroi', true,
      'copiesPerSku', 1)),
    ('numbering', jsonb_build_object(
      'designPadding', 5,
      'skuPadding', 3,
      'barcodePrefix', 'BC',
      'categoryPrefixes', jsonb_build_object(
        'Necklace Set', 'SET', 'Pendant Set', 'PSET', 'Ring', 'RING', 'Earrings', 'ER', 'Bangles', 'BNG',
        'Bracelet', 'BRC', 'Chain', 'CHN', 'Pendant', 'PEND', 'Kada', 'KADA', 'Anklet', 'ANK',
        'Payal', 'PAY', 'Mangalsutra', 'MNG', 'Nose Pin', 'NP', 'Brooch', 'BRO', 'Other', 'OTH'))),
    ('materials', jsonb_build_array(
      jsonb_build_object('name', 'Gold', 'purities', jsonb_build_array('18K', '20K', '22K', '24K')),
      jsonb_build_object('name', 'Silver', 'purities', jsonb_build_array('800', '925', '999')))),
    ('locations', jsonb_build_array('Main Showroom', 'Jaishri Vault', 'Workshop', 'Exhibition')),
    ('custom_fields', jsonb_build_array(
      jsonb_build_object('id', 'cf-hallmark', 'label', 'Hallmark', 'type', 'Text', 'appliesTo', 'SKU', 'required', false),
      jsonb_build_object('id', 'cf-supplier', 'label', 'Supplier', 'type', 'Text', 'appliesTo', 'Design', 'required', false))),
    ('data_epoch', to_jsonb(to_char(private.now_ts() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')))
  on conflict (key) do nothing;

  -- D5: the 15 categories and their prefixes, and four subcategories each. The subcategories go only to the categories this
  -- call made, so a second call neither repeats them nor brings back one the owner has switched off.
  with new_categories as (
    insert into public.categories (name, prefix) values
      ('Necklace Set', 'SET'), ('Pendant Set', 'PSET'), ('Ring', 'RING'), ('Earrings', 'ER'), ('Bangles', 'BNG'),
      ('Bracelet', 'BRC'), ('Chain', 'CHN'), ('Pendant', 'PEND'), ('Kada', 'KADA'), ('Anklet', 'ANK'),
      ('Payal', 'PAY'), ('Mangalsutra', 'MNG'), ('Nose Pin', 'NP'), ('Brooch', 'BRO'), ('Other', 'OTH')
    on conflict do nothing
    returning id
  )
  insert into public.subcategories (category_id, name)
  select c.id, s.name
    from new_categories c
   cross join (values ('Kundan'), ('Casting'), ('Jadau'), ('Handmade')) s (name)
  on conflict do nothing;

  -- D10, K5: the walk-in customer, one row with a fixed id, no mobile (it is not a named customer), no PAN, never archived.
  -- No conflict target: a walk-in that already exists under another id is the one walk-in (the unique partial index).
  insert into public.customers (id, name, mobile, customer_type, is_walkin)
  values ('00000000-0000-4000-8000-000000000001', 'Walk-in Customer', null, 'Retail', true)
  on conflict do nothing;
end
$$;
revoke all on function private.seed_defaults() from public, anon, authenticated;
comment on function private.seed_defaults() is 'D20: the rows of an empty project: the settings keys, the 15 categories with their prefixes and subcategories, the walk-in customer. No sample data. Safe to call twice; used by this migration and by tests.reset_business_data().';

select private.seed_defaults();
