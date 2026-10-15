-- 0005 stock tables (task DB03). Spec: D6, D7, D8, D9, P4, S3, S4, S6, D22, O37, A5.
-- Tests: supabase/tests/database/020_stock_access.test.sql (T-F02, T-F05 and the rest of the matrix).
--
-- designs (what a thing is), skus (one physical piece of it) and sku_private (the owner-only original weight). Material,
-- purity and selling method live on the design and nowhere else; a piece has none of its own, so changing a design's
-- material changes what every piece shows (T-F01). Their access rules (grants and policies) are in 0006.
--
-- Two columns are plain uuids for now. skus.sold_bill_id gets its foreign key to bills in DB04 (0007), when bills exists;
-- the import_batch_id of designs and skus gets its foreign key to private.import_batches in the same migration, with the ones
-- of customers and bills (D21). Their CHECK (Sold if and only if a bill) is here, as D8 asks.
--
-- Every cap of S4 is a literal in a CHECK (weights 100,000 g, a rate or a piece price 100,000,000, a line amount such as
-- piroi 1,000,000,000) and a row of private.limits; test T-F02 compares the two from the catalogue.

-- ---------------------------------------------------------------- D6: designs
-- design_no is unique ignoring case. primary_image_path and image_paths hold storage paths only: a value that starts with
-- data: (an inline image) is refused (P4). The array is joined with a control character that no path contains, so the one
-- pattern tests every element for the start of the string. built-in functions only, as S4 asks of a CHECK.
create table public.designs (
  id uuid primary key default gen_random_uuid(),
  design_no text not null constraint designs_design_no_not_blank check (btrim(design_no) <> ''),
  name text,
  category_id uuid not null references public.categories (id) on delete restrict,
  subcategory_id uuid references public.subcategories (id) on delete restrict,
  material text not null constraint designs_material_not_blank check (btrim(material) <> ''),
  purity text not null constraint designs_purity_not_blank check (btrim(purity) <> ''),
  selling_method text not null constraint designs_selling_method_check check (selling_method in ('By Weight', 'Per Piece')),
  description text,
  notes text,
  tags text[] not null default '{}',
  primary_image_path text constraint designs_primary_image_path_no_data check (primary_image_path !~* '^\s*data:'),
  image_paths text[] not null default '{}'
    constraint designs_image_paths_no_data check (array_to_string(image_paths, chr(1)) !~* ('(^|' || chr(1) || ')\s*data:')),
  archived_at timestamptz,
  import_batch_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  updated_by uuid
);
alter table public.designs enable row level security;
create unique index designs_design_no_lower_key on public.designs (lower(design_no));
create index designs_category_id_idx on public.designs (category_id);
create index designs_subcategory_id_idx on public.designs (subcategory_id);
comment on table public.designs is 'D6: a design. Material, purity and selling method live here and only here. Written by create_design (X8) and the import; edited directly only in the columns of A5.';

-- ---------------------------------------------------------------- D7, D8: skus (a physical piece)
-- gross_weight left blank on the screen is stored as 0 (the prototype's default); the three labour rates are never blank
-- (R1). For a By Weight design the labour rates mean rupees per gram of net weight, for a Per Piece design the piece price,
-- so both are capped like a rate or a piece price. piroi is a line amount (S4, BN-2). The ten statuses are as coded
-- (mockData.ts); Sold goes with a bill and Archived with a date, in both directions (D8).
create table public.skus (
  id uuid primary key default gen_random_uuid(),
  design_id uuid not null references public.designs (id) on delete restrict,
  sku_no text not null constraint skus_sku_no_not_blank check (btrim(sku_no) <> ''),
  barcode text not null constraint skus_barcode_not_blank check (btrim(barcode) <> ''),
  gross_weight numeric(12, 3) not null default 0
    constraint skus_gross_weight_check check (gross_weight >= 0 and gross_weight <= 100000),
  customer_net_weight numeric(12, 3) not null
    constraint skus_customer_net_weight_check check (customer_net_weight >= 0 and customer_net_weight <= 100000),
  stones integer not null default 0 constraint skus_stones_check check (stones >= 0),
  stone_weight numeric(12, 3) not null default 0
    constraint skus_stone_weight_check check (stone_weight >= 0 and stone_weight <= 100000),
  kundan integer not null default 0 constraint skus_kundan_check check (kundan >= 0),
  kundan_weight numeric(12, 3) not null default 0
    constraint skus_kundan_weight_check check (kundan_weight >= 0 and kundan_weight <= 100000),
  piroi numeric(12, 2) not null default 0 constraint skus_piroi_check check (piroi >= 0 and piroi <= 1000000000),
  labour_retail numeric(12, 2) not null
    constraint skus_labour_retail_check check (labour_retail >= 0 and labour_retail <= 100000000),
  labour_semi numeric(12, 2) not null
    constraint skus_labour_semi_check check (labour_semi >= 0 and labour_semi <= 100000000),
  labour_wholesale numeric(12, 2) not null
    constraint skus_labour_wholesale_check check (labour_wholesale >= 0 and labour_wholesale <= 100000000),
  status text not null default 'In Stock'
    constraint skus_status_check check (status in (
      'In Stock', 'Reserved', 'On Approval', 'Sold', 'Returned', 'Repair', 'Transferred', 'Missing', 'Damaged', 'Archived')),
  location text,
  notes text,
  sold_bill_id uuid,
  archived_at timestamptz,
  import_batch_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  updated_by uuid,
  constraint skus_sold_ties_bill check ((status = 'Sold') = (sold_bill_id is not null)),
  constraint skus_archived_ties_date check ((status = 'Archived') = (archived_at is not null))
);
alter table public.skus enable row level security;
create unique index skus_sku_no_lower_key on public.skus (lower(sku_no));
create unique index skus_barcode_lower_key on public.skus (lower(barcode));
create index skus_design_id_idx on public.skus (design_id);
comment on table public.skus is 'D7, D8: a physical piece. status and archived_at change only through set_sku_status (X9), Sold only through the bill functions; sku_no, barcode and design_id never change.';

-- ---------------------------------------------------------------- D9: sku_private
-- The original (hidden) net weight is a separate table so that who can read it is a table rule, not a screen rule: only the
-- owner can read, insert or update it (0006).
create table public.sku_private (
  sku_id uuid primary key references public.skus (id) on delete restrict,
  original_net_weight numeric(12, 3) not null
    constraint sku_private_original_net_weight_check check (original_net_weight >= 0 and original_net_weight <= 100000),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  updated_by uuid
);
alter table public.sku_private enable row level security;
comment on table public.sku_private is 'D9: the owner-only original net weight of a piece. Only the owner reads, inserts or updates it.';

-- ---------------------------------------------------------------- D7, O37: the weight rules of a piece
-- A trigger rather than a CHECK, because the By Weight rule reads the design. It runs on insert and when a weight is
-- changed, and not on a status-only update or an edit of other columns (O37): a piece that already breaks the rule can still
-- be reserved or sold. A customer net weight above the gross weight is refused when a gross weight is recorded (a blank
-- gross weight is stored as 0 and allowed); for a By Weight design a customer net weight of 0 is refused (a Per Piece
-- piece may weigh 0). Security definer, because it reads designs and raises through private.jv_error, which the signed-in
-- role may not execute.
create or replace function private.check_sku_weights()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_method text;
begin
  if tg_op = 'UPDATE'
     and new.gross_weight is not distinct from old.gross_weight
     and new.customer_net_weight is not distinct from old.customer_net_weight then
    return new;
  end if;
  if new.gross_weight > 0 and new.customer_net_weight > new.gross_weight then
    perform private.jv_error('JV_INVALID_INPUT', 'The customer net weight cannot be more than the gross weight');
  end if;
  select d.selling_method into v_method from public.designs d where d.id = new.design_id;
  if v_method = 'By Weight' and new.customer_net_weight = 0 then
    perform private.jv_error('JV_INVALID_INPUT', 'A piece sold by weight needs a customer net weight above 0');
  end if;
  return new;
end
$$;
comment on function private.check_sku_weights() is 'D7, O37: trigger function. Refuses a net weight above a recorded gross weight and, for a By Weight design, a net weight of 0, when a weight is inserted or changed.';

create trigger skus_check_weights
  before insert or update of gross_weight, customer_net_weight on public.skus
  for each row execute function private.check_sku_weights();

-- D7: sku_no, barcode and design_id never change after creation. The column grants of 0006 already keep the API roles from
-- them; this keeps everybody else (the database owner, a function) from them too.
create or replace function private.protect_sku_identity()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.sku_no is distinct from old.sku_no
     or new.barcode is distinct from old.barcode
     or new.design_id is distinct from old.design_id then
    perform private.jv_error('JV_NOT_ALLOWED', 'The number, the barcode and the design of a piece never change');
  end if;
  return new;
end
$$;
comment on function private.protect_sku_identity() is 'D7: trigger function. Refuses a change of sku_no, barcode or design_id.';

create trigger skus_protect_identity
  before update of sku_no, barcode, design_id on public.skus
  for each row execute function private.protect_sku_identity();

-- ---------------------------------------------------------------- D6, A5: the rules of a design's update
-- Column grants cannot tell the owner from staff (both are the database role authenticated), so the trigger does:
--   * staff cannot change a design's material, purity or selling method (A5): JV_FORBIDDEN. Somebody who is not signed in
--     (the database owner: an import, a repair) is not a user and may;
--   * the selling method cannot change while the design has a piece that is not archived, because the piece rates mean
--     rupees per gram for By Weight and a piece price for Per Piece (D6): JV_NOT_ALLOWED;
--   * a design with a piece that is not archived cannot be archived (A5): JV_NOT_ALLOWED.
-- Security definer, because it reads skus and raises through private.jv_error, which the signed-in role may not execute.
create or replace function private.guard_design_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (new.material is distinct from old.material
      or new.purity is distinct from old.purity
      or new.selling_method is distinct from old.selling_method)
     and auth.uid() is not null
     and (select private.app_role()) is distinct from 'owner' then
    perform private.jv_error('JV_FORBIDDEN', 'Only the owner can change the material, purity or selling method of a design');
  end if;
  if new.selling_method is distinct from old.selling_method
     and exists (select 1 from public.skus s where s.design_id = old.id and s.status <> 'Archived') then
    perform private.jv_error('JV_NOT_ALLOWED', 'The selling method cannot change while the design has pieces that are not archived');
  end if;
  if new.archived_at is not null and old.archived_at is null
     and exists (select 1 from public.skus s where s.design_id = old.id and s.status <> 'Archived') then
    perform private.jv_error('JV_NOT_ALLOWED', 'A design with pieces that are not archived cannot be archived');
  end if;
  return new;
end
$$;
comment on function private.guard_design_update() is 'D6, A5: trigger function. Staff cannot change material, purity or selling method; the selling method cannot change, and the design cannot be archived, while it has pieces that are not archived.';

create trigger designs_guard_update
  before update of material, purity, selling_method, archived_at on public.designs
  for each row execute function private.guard_design_update();

-- ---------------------------------------------------------------- S6, D22: the stamps and the person columns
create trigger designs_force_person_columns
  before insert or update on public.designs
  for each row execute function private.force_person_columns();
create trigger designs_set_updated_at
  before insert or update on public.designs
  for each row execute function private.set_updated_at();

create trigger skus_force_person_columns
  before insert or update on public.skus
  for each row execute function private.force_person_columns();
create trigger skus_set_updated_at
  before insert or update on public.skus
  for each row execute function private.set_updated_at();

create trigger sku_private_force_person_columns
  before insert or update on public.sku_private
  for each row execute function private.force_person_columns();
create trigger sku_private_set_updated_at
  before insert or update on public.sku_private
  for each row execute function private.set_updated_at();
