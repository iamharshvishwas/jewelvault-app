-- 0004 reference tables (task DB03). Spec: D3, D4, D5, S3, S4, S6, D22, T-F02.
-- Tests: supabase/tests/database/020_stock_access.test.sql.
--
-- The four tables the stock and billing screens read first: settings, daily_rates, categories, subcategories. Their access
-- rules (grants and policies) are in 0006; this file makes the tables, their checks and the two triggers every table has.
--
-- Every column that names a person (updated_by, confirmed_by, created_by) is set from auth.uid() by private.force_person_columns
-- and the two stamps by private.set_updated_at (both made in 0003), whatever a client sends (S6, D22). The caps of S4 are
-- written as literals in the CHECKs, because a CHECK that called private.limits would fail for the role doing the update
-- (it may not execute it); test T-F02 reads them from the catalogue and compares them with private.limits.

-- ---------------------------------------------------------------- D3: settings
-- One row per key (the primary key), never one blob. The keys are listed in D3; the rows are made by private.seed_defaults()
-- (DB05). value is any JSON: data_epoch, for one, is a text.
create table public.settings (
  key text primary key constraint settings_key_not_blank check (btrim(key) <> ''),
  value jsonb not null,
  updated_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.settings enable row level security;
comment on table public.settings is 'D3: one row per key (business, estimate, taxes, tag_template, numbering, materials, locations, custom_fields, data_epoch). The owner writes, every active user reads.';

create trigger settings_force_person_columns
  before insert or update on public.settings
  for each row execute function private.force_person_columns();
create trigger settings_set_updated_at
  before insert or update on public.settings
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D4: daily_rates
-- One rate per (date, material, purity). The rate a bill pre-fills is the row with the latest rate_date not after the bill's
-- date (R2); who may add or correct a row is decided by the policies in 0006. A purity with no row (Custom) needs a typed rate.
-- The cap on rate_per_gram is the one of S4 for a rate (100,000,000), a literal here and a row in private.limits (max_rate).
create table public.daily_rates (
  id uuid primary key default gen_random_uuid(),
  material text not null constraint daily_rates_material_check check (material in ('Gold', 'Silver')),
  purity text not null constraint daily_rates_purity_not_blank check (btrim(purity) <> ''),
  rate_per_gram numeric(12, 2) not null
    constraint daily_rates_rate_check check (rate_per_gram > 0 and rate_per_gram <= 100000000),
  rate_date date not null,
  confirmed_by uuid,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint daily_rates_date_material_purity_key unique (rate_date, material, purity)
);
alter table public.daily_rates enable row level security;
comment on table public.daily_rates is 'D4: the day''s rate per gram for a material and purity. The owner adds a rate for any date up to today and corrects today''s; a biller adds today''s once per material and purity.';

create trigger daily_rates_force_person_columns
  before insert or update on public.daily_rates
  for each row execute function private.force_person_columns();
create trigger daily_rates_set_updated_at
  before insert or update on public.daily_rates
  for each row execute function private.set_updated_at();

-- ---------------------------------------------------------------- D5: categories and subcategories
-- The name is unique ignoring case (the unique index on lower(name)); the prefix is 2 to 6 capitals or digits and starts the
-- design numbers of the category (L3). active is the switch the screens use; nothing is deleted (S7).
create table public.categories (
  id uuid primary key default gen_random_uuid(),
  name text not null constraint categories_name_not_blank check (btrim(name) <> ''),
  prefix text not null constraint categories_prefix_check check (prefix ~ '^[A-Z0-9]{2,6}$'),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  updated_by uuid
);
alter table public.categories enable row level security;
create unique index categories_name_lower_key on public.categories (lower(name));
comment on table public.categories is 'D5: stock categories. The name is unique ignoring case; the prefix is 2 to 6 capitals or digits.';

create trigger categories_force_person_columns
  before insert or update on public.categories
  for each row execute function private.force_person_columns();
create trigger categories_set_updated_at
  before insert or update on public.categories
  for each row execute function private.set_updated_at();

-- The unique index starts with category_id, so it is also the index of the foreign key (advisor lint 0001, D19).
create table public.subcategories (
  id uuid primary key default gen_random_uuid(),
  category_id uuid not null references public.categories (id) on delete restrict,
  name text not null constraint subcategories_name_not_blank check (btrim(name) <> ''),
  active boolean not null default true,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  created_by uuid,
  updated_by uuid
);
alter table public.subcategories enable row level security;
create unique index subcategories_category_name_lower_key on public.subcategories (category_id, lower(name));
comment on table public.subcategories is 'D5: subcategories of a category. The name is unique within its category, ignoring case.';

create trigger subcategories_force_person_columns
  before insert or update on public.subcategories
  for each row execute function private.force_person_columns();
create trigger subcategories_set_updated_at
  before insert or update on public.subcategories
  for each row execute function private.set_updated_at();
