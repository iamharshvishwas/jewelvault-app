-- 0007 money tables (task DB04). Spec: D10 to D15, D21, K1, K5, S3, S4, S6, S7, Y2, Y4, D22.
-- Tests: supabase/tests/database/030_money_tables.test.sql (T-B01, T-B06, T-C02, T-D07, T-D08 and the money part of T-F02),
--        supabase/tests/database/020_stock_access.test.sql (every cap literal below against private.limits).
--
-- The five tables the ledger rests on: customers, bills, bill_items, receipts and receipt_allocations. Their access rules
-- (grants, policies and the archive guard) are in 0008; this file makes the tables, their checks and keys, and the two
-- triggers every table has. Nothing here is reachable through the API until 0008 grants it (migration 0001 took every
-- default right away), and 0008 grants no write right on a bill, a line, a receipt or an allocation to anybody (K1, S7).
--
-- Money is numeric(14,2), a weight numeric(12,3), a rate numeric(12,2) (S3); no float exists. The caps of S4 are literals in
-- the CHECKs (a CHECK that called private.limits would fail for the role doing the update), and test T-F02 compares each
-- with its row of private.limits. A bill's own fine weight is a sum over up to 200 lines and has no cap of its own.
--
-- Every foreign key is ON DELETE RESTRICT and has an index that starts with its columns in the key's order (advisor lint
-- 0001). Where a D19 index doubles as the key's index it is made here under the name D19 would give it, so DB05 does not
-- make it twice: bills (customer_id, bill_date), receipts (customer_id); bill_items (bill_id) and the two
-- receipt_allocations (bill_id) and (receipt_id) are the first columns of the unique and composite-key indexes below.
--
-- The columns that name a person (created_by, updated_by) are set from auth.uid() by private.force_person_columns and the
-- two stamps by private.set_updated_at (both made in 0003), whatever a client sends (S6, D22). cancelled_by and voided_by are
-- set by the functions that cancel and void (S6). None of the person columns has a foreign key (0002 says why).

-- ---------------------------------------------------------------- D10, K5: customers
-- name is 1 to 120 characters and not blank. mobile is ten digits, or + and 7 to 15 digits for a foreign number, spaces and
-- dashes already removed by the screen; it may be blank only for an imported customer (whom the screen asks for the number
-- when selected, O33) and for the walk-in, who is not a named customer (D10: "required for a named customer"). The walk-in is
-- one row (a unique partial index; DB05 seeds it with a fixed id), is never archived and never holds a PAN; the same rule is
-- in the archive guard of 0008, which says so in words. A PAN is five capitals, four digits and a capital (Z3); it is
-- optional. No balance column exists: outstanding, advance and the fine figures are derived (V1 to V3).
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null
    constraint customers_name_not_blank check (btrim(name) <> '')
    constraint customers_name_length check (char_length(name) between 1 and 120),
  mobile text,
  customer_type text not null default 'Retail'
    constraint customers_customer_type_check check (customer_type in ('Retail', 'Semi-Wholesale', 'Wholesale')),
  email text,
  address text,
  gst_number text,
  pan text constraint customers_pan_format check (pan ~ '^[A-Z]{5}[0-9]{4}[A-Z]$'),
  notes text,
  is_walkin boolean not null default false,
  archived_at timestamptz,
  import_batch_id uuid references private.import_batches (id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  updated_by uuid,
  constraint customers_mobile_format check (
    (mobile is not null and mobile ~ '^([0-9]{10}|\+[0-9]{7,15})$')
    or ((mobile is null or btrim(mobile) = '') and (import_batch_id is not null or is_walkin))
  ),
  constraint customers_walkin_rules check (not is_walkin or (pan is null and archived_at is null))
);
alter table public.customers enable row level security;
create unique index customers_one_walkin_key on public.customers (is_walkin) where is_walkin;
create index customers_import_batch_id_idx on public.customers (import_batch_id) where import_batch_id is not null;
comment on table public.customers is 'D10: a customer. Exactly one row is the walk-in. No balance column: balances are derived. Written by create_customer (X6) and the import; edited directly only in the columns of A5; archived only by the owner and only at a zero balance (K4).';

create trigger customers_force_person_columns
  before insert or update on public.customers
  for each row execute function private.force_person_columns();
create trigger customers_set_updated_at
  before insert or update on public.customers
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D11, K1: bills
-- A bill is created active and can only become cancelled (cancel_reason, cancelled_at and cancelled_by are all present
-- exactly when it is). The grand total is a whole rupee by R8, but the column keeps paise; round_off may be negative (R8).
-- reissue_of is unique: a cancelled bill is replaced once (K6). request_id is unique when given; a bill made outside a request
-- (an import, a fixture) has none. (id, customer_id) is unique so that an allocation can name both and never touch another
-- customer's bill (D14, Y4). doc_type tax_invoice and bill_of_supply are reserved for decision 4; opening_balance is D15.
-- The sale type is one of the customer types (R9). GST is 0 for an estimate as coded; the table only keeps it not negative.
-- No API role writes this table (0008): the functions of Part B do, and the import.
create table public.bills (
  id uuid primary key default gen_random_uuid(),
  bill_no text not null
    constraint bills_bill_no_not_blank check (btrim(bill_no) <> ''),
  customer_id uuid not null references public.customers (id) on delete restrict,
  bill_date date not null,
  doc_type text not null
    constraint bills_doc_type_check check (doc_type in ('estimate', 'tax_invoice', 'bill_of_supply', 'opening_balance')),
  sale_type text not null
    constraint bills_sale_type_check check (sale_type in ('Retail', 'Semi-Wholesale', 'Wholesale')),
  status text not null default 'active'
    constraint bills_status_check check (status in ('active', 'cancelled')),
  cancel_reason text constraint bills_cancel_reason_not_blank check (btrim(cancel_reason) <> ''),
  cancelled_at timestamptz,
  cancelled_by uuid,
  reissue_of uuid references public.bills (id) on delete restrict,
  pricing_version smallint not null default 1
    constraint bills_pricing_version_check check (pricing_version >= 1),
  subtotal numeric(14, 2) not null default 0
    constraint bills_subtotal_check check (subtotal >= 0 and subtotal <= 1000000000),
  discount numeric(14, 2) not null default 0
    constraint bills_discount_check check (discount >= 0 and discount <= 1000000000),
  additional_charges numeric(14, 2) not null default 0
    constraint bills_additional_charges_check check (additional_charges >= 0 and additional_charges <= 1000000000),
  gst_percent numeric(5, 2) not null default 0
    constraint bills_gst_percent_check check (gst_percent >= 0),
  gst_amount numeric(14, 2) not null default 0
    constraint bills_gst_amount_check check (gst_amount >= 0),
  grand_total numeric(14, 2) not null default 0
    constraint bills_grand_total_check check (grand_total >= 0 and grand_total <= 1000000000),
  round_off numeric(14, 2) not null default 0,
  fine_weight_due numeric(12, 3) not null default 0
    constraint bills_fine_weight_due_check check (fine_weight_due >= 0),
  notes text,
  cash_override_reason text constraint bills_cash_override_reason_not_blank check (btrim(cash_override_reason) <> ''),
  import_batch_id uuid references private.import_batches (id) on delete restrict,
  request_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  constraint bills_bill_no_key unique (bill_no),
  constraint bills_id_customer_id_key unique (id, customer_id),
  constraint bills_reissue_of_key unique (reissue_of),
  constraint bills_request_id_key unique (request_id),
  constraint bills_reissue_not_self check (reissue_of is distinct from id),
  constraint bills_cancel_columns check (
    (status = 'cancelled') = (cancel_reason is not null)
    and (status = 'cancelled') = (cancelled_at is not null)
    and (status = 'cancelled') = (cancelled_by is not null)
  )
);
alter table public.bills enable row level security;
create index bills_customer_id_bill_date_idx on public.bills (customer_id, bill_date);
create index bills_import_batch_id_idx on public.bills (import_batch_id) where import_batch_id is not null;
comment on table public.bills is 'D11: a bill (estimate, opening balance). Read-only for every API role (K1): only the functions of Part B and the import write it. Created active; can only become cancelled, once.';

create trigger bills_force_person_columns
  before insert or update on public.bills
  for each row execute function private.force_person_columns();
create trigger bills_set_updated_at
  before insert or update on public.bills
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D12: bill_items
-- A snapshot taken at sale time (design number, piece number, category name, material, purity, selling method, the two
-- weights) and the priced values; it never holds the original weight (D9). Quantity is stored (BIL-05). list_metal_rate and
-- list_labour_rate are the prices the server offered (R14, I11); they are null when there was nothing to offer (no daily rate
-- row, RATE_MISSING; a Per Piece line compares on its price only; a line from the import). A bill has 1 to 200 lines, so the
-- line number is 1 to 200 and unique within the bill; a piece is on a bill once. A piece may be on the lines of several bills
-- over time (cancelled, returned to stock, sold again); that it is on only one active bill is invariant I2.
create table public.bill_items (
  id uuid primary key default gen_random_uuid(),
  bill_id uuid not null references public.bills (id) on delete restrict,
  line_no integer not null
    constraint bill_items_line_no_check check (line_no >= 1 and line_no <= 200),
  sku_id uuid not null references public.skus (id) on delete restrict,
  design_no text not null constraint bill_items_design_no_not_blank check (btrim(design_no) <> ''),
  sku_no text not null constraint bill_items_sku_no_not_blank check (btrim(sku_no) <> ''),
  category text not null constraint bill_items_category_not_blank check (btrim(category) <> ''),
  material text not null constraint bill_items_material_check check (material in ('Gold', 'Silver')),
  purity text not null constraint bill_items_purity_not_blank check (btrim(purity) <> ''),
  selling_method text not null constraint bill_items_selling_method_check check (selling_method in ('By Weight', 'Per Piece')),
  gross_weight numeric(12, 3) not null default 0
    constraint bill_items_gross_weight_check check (gross_weight >= 0 and gross_weight <= 100000),
  customer_net_weight numeric(12, 3) not null
    constraint bill_items_customer_net_weight_check check (customer_net_weight >= 0 and customer_net_weight <= 100000),
  quantity integer not null
    constraint bill_items_quantity_check check (quantity >= 1 and quantity <= 1000),
  metal_rate numeric(12, 2) not null
    constraint bill_items_metal_rate_check check (metal_rate >= 0 and metal_rate <= 100000000),
  labour_rate numeric(12, 2) not null default 0
    constraint bill_items_labour_rate_check check (labour_rate >= 0 and labour_rate <= 100000000),
  labour_amount numeric(14, 2) not null default 0
    constraint bill_items_labour_amount_check check (labour_amount >= 0 and labour_amount <= 1000000000),
  piroi numeric(14, 2) not null default 0
    constraint bill_items_piroi_check check (piroi >= 0 and piroi <= 1000000000),
  other_charges numeric(14, 2) not null default 0
    constraint bill_items_other_charges_check check (other_charges >= 0 and other_charges <= 1000000000),
  metal_amount numeric(14, 2) not null default 0
    constraint bill_items_metal_amount_check check (metal_amount >= 0 and metal_amount <= 1000000000),
  fine_weight_due numeric(12, 3) not null default 0
    constraint bill_items_fine_weight_due_check check (fine_weight_due >= 0),
  item_total numeric(14, 2) not null
    constraint bill_items_item_total_check check (item_total >= 0 and item_total <= 1000000000),
  tax_rate numeric(5, 2) not null default 0
    constraint bill_items_tax_rate_check check (tax_rate >= 0),
  tax_amount numeric(14, 2) not null default 0
    constraint bill_items_tax_amount_check check (tax_amount >= 0),
  list_metal_rate numeric(12, 2)
    constraint bill_items_list_metal_rate_check check (list_metal_rate >= 0 and list_metal_rate <= 100000000),
  list_labour_rate numeric(12, 2)
    constraint bill_items_list_labour_rate_check check (list_labour_rate >= 0 and list_labour_rate <= 100000000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint bill_items_bill_id_line_no_key unique (bill_id, line_no),
  constraint bill_items_bill_id_sku_id_key unique (bill_id, sku_id)
);
alter table public.bill_items enable row level security;
create index bill_items_sku_id_idx on public.bill_items (sku_id);
comment on table public.bill_items is 'D12: a line of a bill, with the snapshot of the piece at sale time (never the original weight), the priced values, the quantity and the list prices. Read-only for every API role.';

create trigger bill_items_set_updated_at
  before insert or update on public.bill_items
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D13, Y2: receipts
-- kind is money, fine_silver, fine_cash or refund, and the checks tie it to the other columns:
--   money        mode Cash, UPI, Card, Bank Transfer or Other; amount above 0; no fine grams; no silver rate
--   refund       the same: money handed back, never allocated
--   fine_cash    mode Cash; amount above 0 (it is money received); grams above 0; a silver rate above 0
--   fine_silver  no mode; amount 0; grams above 0; no silver rate
-- There is no Credit mode and no request_id: one request can make several receipts (D13). An opening advance (is_opening,
-- D15) is money with mode Other or silver with no mode. A voided receipt carries its reason, time and person together.
-- Each rule is its own constraint so that a refusal names the rule. Every condition is written so that a null cannot pass a CHECK
-- (a CHECK that evaluates to null is accepted, so each branch says "is not null" before it compares).
create table public.receipts (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references public.customers (id) on delete restrict,
  kind text not null
    constraint receipts_kind_check check (kind in ('money', 'fine_silver', 'fine_cash', 'refund')),
  mode text
    constraint receipts_mode_check check (mode in ('Cash', 'UPI', 'Card', 'Bank Transfer', 'Other')),
  amount numeric(14, 2) not null default 0
    constraint receipts_amount_cap check (amount >= 0 and amount <= 1000000000),
  fine_grams numeric(12, 3) not null default 0
    constraint receipts_fine_grams_cap check (fine_grams >= 0 and fine_grams <= 100000),
  silver_rate numeric(12, 2)
    constraint receipts_silver_rate_cap check (silver_rate >= 0 and silver_rate <= 100000000),
  paid_on date not null,
  reference text,
  notes text,
  is_opening boolean not null default false,
  cash_override_reason text constraint receipts_cash_override_reason_not_blank check (btrim(cash_override_reason) <> ''),
  status text not null default 'active'
    constraint receipts_status_check check (status in ('active', 'voided')),
  void_reason text constraint receipts_void_reason_not_blank check (btrim(void_reason) <> ''),
  voided_at timestamptz,
  voided_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  constraint receipts_id_customer_id_key unique (id, customer_id),
  constraint receipts_mode_by_kind check (
    (kind in ('money', 'refund') and mode is not null)
    or (kind = 'fine_cash' and mode is not null and mode = 'Cash')
    or (kind = 'fine_silver' and mode is null)
  ),
  constraint receipts_amount_by_kind check (
    (kind in ('money', 'refund', 'fine_cash') and amount > 0)
    or (kind = 'fine_silver' and amount = 0)
  ),
  constraint receipts_fine_grams_by_kind check (
    (kind in ('fine_silver', 'fine_cash') and fine_grams > 0)
    or (kind in ('money', 'refund') and fine_grams = 0)
  ),
  constraint receipts_silver_rate_by_kind check (
    (kind = 'fine_cash' and silver_rate is not null and silver_rate > 0)
    or (kind <> 'fine_cash' and silver_rate is null)
  ),
  constraint receipts_opening_kind check (
    not is_opening or (kind = 'money' and mode is not null and mode = 'Other') or kind = 'fine_silver'
  ),
  constraint receipts_void_columns check (
    (status = 'voided') = (void_reason is not null)
    and (status = 'voided') = (voided_at is not null)
    and (status = 'voided') = (voided_by is not null)
  )
);
alter table public.receipts enable row level security;
create index receipts_customer_id_idx on public.receipts (customer_id);
comment on table public.receipts is 'D13: money received, silver received, silver settled in cash, or money handed back (refund). No Credit mode, no request_id. Read-only for every API role; voided, never deleted.';

create trigger receipts_force_person_columns
  before insert or update on public.receipts
  for each row execute function private.force_person_columns();
create trigger receipts_set_updated_at
  before insert or update on public.receipts
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D14, Y4: receipt_allocations
-- The customer is written again here so that two composite keys, (receipt_id, customer_id) and (bill_id, customer_id), make
-- it impossible for a receipt to touch another customer's bill: the pair must exist in receipts and in bills, and the table
-- owner is held by a foreign key like everybody else. A money allocation carries amount and a fine allocation carries
-- fine_grams (its amount is 0); the row must hold something. A released allocation (released_at set when the bill is
-- cancelled) no longer counts. A refund is never allocated (the functions; invariant I3 reads the rows).
create table public.receipt_allocations (
  id uuid primary key default gen_random_uuid(),
  receipt_id uuid not null,
  bill_id uuid not null,
  customer_id uuid not null,
  amount numeric(14, 2) not null default 0
    constraint receipt_allocations_amount_check check (amount >= 0 and amount <= 1000000000),
  fine_grams numeric(12, 3) not null default 0
    constraint receipt_allocations_fine_grams_check check (fine_grams >= 0 and fine_grams <= 100000),
  released_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint receipt_allocations_not_both_zero check (amount > 0 or fine_grams > 0),
  constraint receipt_allocations_receipt_customer_fkey
    foreign key (receipt_id, customer_id) references public.receipts (id, customer_id) on delete restrict,
  constraint receipt_allocations_bill_customer_fkey
    foreign key (bill_id, customer_id) references public.bills (id, customer_id) on delete restrict
);
alter table public.receipt_allocations enable row level security;
create index receipt_allocations_receipt_id_customer_id_idx on public.receipt_allocations (receipt_id, customer_id);
create index receipt_allocations_bill_id_customer_id_idx on public.receipt_allocations (bill_id, customer_id);
comment on table public.receipt_allocations is 'D14: how much of a receipt (money or grams) pays a bill, of the same customer by two composite keys. Read-only for every API role.';

create trigger receipt_allocations_set_updated_at
  before insert or update on public.receipt_allocations
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D8, D21: the keys back to skus and the import batches
-- DB03 made skus.sold_bill_id and the import_batch_id of designs and skus as plain columns, because their targets did not
-- exist yet. The targets exist now. The indexes are partial (most rows have no bill and no batch), which advisor lint 0001
-- accepts as the index of a foreign key.
alter table public.skus
  add constraint skus_sold_bill_id_fkey foreign key (sold_bill_id) references public.bills (id) on delete restrict;
create index skus_sold_bill_id_idx on public.skus (sold_bill_id) where sold_bill_id is not null;

alter table public.skus
  add constraint skus_import_batch_id_fkey foreign key (import_batch_id) references private.import_batches (id) on delete restrict;
create index skus_import_batch_id_idx on public.skus (import_batch_id) where import_batch_id is not null;

alter table public.designs
  add constraint designs_import_batch_id_fkey foreign key (import_batch_id) references private.import_batches (id) on delete restrict;
create index designs_import_batch_id_idx on public.designs (import_batch_id) where import_batch_id is not null;
