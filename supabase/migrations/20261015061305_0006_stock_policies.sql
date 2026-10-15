-- 0006 stock policies (task DB03). Spec: A3 step 4, A4, A5, A7, A9, A10, D4, D9, S4, S7.
-- Tests: supabase/tests/database/020_stock_access.test.sql (every cell of the matrix for owner, biller, staff and anon).
--
-- The grants and row rules of the seven tables of 0004 and 0005. Migration 0001 took every default right away, so nothing
-- here is reachable until it is granted, one table and one column list at a time (A3 step 4). Three things hold throughout:
--
--   * Reading is wide (A9): every active user reads every row, archived rows included (an update that reads columns also
--     applies the SELECT policy, A4). A login that is not active, or has no profile, has no role and reads nothing (A10).
--     sku_private is the exception: only the owner reads it, so who can read the original weight is a table rule (D9).
--   * Writing is narrow: a column right lists what can be inserted or updated, so everything else (status, archived_at and
--     sold_bill_id of a piece, the numbers, the import batch, the stamps) is refused with 42501; nobody has DELETE (S7), and
--     nobody can insert a design or a piece directly (create_design, X8, and the import do).
--   * The role comes from private.app_role(), called as (select private.app_role()) so that Postgres runs it once per
--     statement. A policy calls built-in functions only (S4: it runs as the caller, who may not execute anything else in
--     private), so the daily-rate policies write the business date inline: (clock_timestamp() at time zone 'Asia/Kolkata')::date.
--     One policy per command on each table (advisor lint 0006).
--
-- The person columns (updated_by, created_by, confirmed_by) are granted so that a value a client sends is accepted and
-- replaced by the trigger of 0003 (T-D05, T-D22); they cannot be used to claim somebody else's work.
--
-- Where a role has a column right but no policy that lets it through (a biller updating a design, say), an UPDATE changes no
-- row and raises no error; where it has no column right the statement fails with 42501.

-- ---------------------------------------------------------------- D3: settings (owner S, I, U; biller and staff S)
grant select on public.settings to authenticated;
grant insert (key, value, updated_by) on public.settings to authenticated;
grant update (value, updated_by) on public.settings to authenticated;

create policy settings_select on public.settings
  for select to authenticated
  using ((select private.app_role()) is not null);
create policy settings_insert on public.settings
  for insert to authenticated
  with check ((select private.app_role()) = 'owner');
create policy settings_update on public.settings
  for update to authenticated
  using ((select private.app_role()) = 'owner')
  with check ((select private.app_role()) = 'owner');

-- ---------------------------------------------------------------- D4: daily_rates
-- owner: S, I for any date up to today, U on a row dated today (the rate only: not its date, material or purity);
-- biller: S, and I for today only, once per material and purity (the unique key); staff: S. The date of "today" is written
-- inline in the policies because a policy cannot call private.today() (S4): the business day in Asia/Kolkata.
grant select on public.daily_rates to authenticated;
grant insert (material, purity, rate_per_gram, rate_date, confirmed_by) on public.daily_rates to authenticated;
grant update (rate_per_gram, confirmed_by) on public.daily_rates to authenticated;

create policy daily_rates_select on public.daily_rates
  for select to authenticated
  using ((select private.app_role()) is not null);
create policy daily_rates_insert on public.daily_rates
  for insert to authenticated
  with check (
    ((select private.app_role()) = 'owner' and rate_date <= (clock_timestamp() at time zone 'Asia/Kolkata')::date)
    or ((select private.app_role()) = 'biller' and rate_date = (clock_timestamp() at time zone 'Asia/Kolkata')::date)
  );
create policy daily_rates_update on public.daily_rates
  for update to authenticated
  using ((select private.app_role()) = 'owner' and rate_date = (clock_timestamp() at time zone 'Asia/Kolkata')::date)
  with check ((select private.app_role()) = 'owner' and rate_date = (clock_timestamp() at time zone 'Asia/Kolkata')::date);

-- ---------------------------------------------------------------- D5: categories and subcategories
-- owner: S, I, U; biller: S; staff: S, I ("add categories", section 1.3). A subcategory cannot be moved to another category.
grant select on public.categories to authenticated;
grant insert (name, prefix, active, created_by, updated_by) on public.categories to authenticated;
grant update (name, prefix, active, updated_by) on public.categories to authenticated;

create policy categories_select on public.categories
  for select to authenticated
  using ((select private.app_role()) is not null);
create policy categories_insert on public.categories
  for insert to authenticated
  with check ((select private.app_role()) in ('owner', 'staff'));
create policy categories_update on public.categories
  for update to authenticated
  using ((select private.app_role()) = 'owner')
  with check ((select private.app_role()) = 'owner');

grant select on public.subcategories to authenticated;
grant insert (category_id, name, active, created_by, updated_by) on public.subcategories to authenticated;
grant update (name, active, updated_by) on public.subcategories to authenticated;

create policy subcategories_select on public.subcategories
  for select to authenticated
  using ((select private.app_role()) is not null);
create policy subcategories_insert on public.subcategories
  for insert to authenticated
  with check ((select private.app_role()) in ('owner', 'staff'));
create policy subcategories_update on public.subcategories
  for update to authenticated
  using ((select private.app_role()) = 'owner')
  with check ((select private.app_role()) = 'owner');

-- ---------------------------------------------------------------- D6, A5: designs
-- S for every active user; U for the owner and staff on the content columns of A5 and archived_at. material, purity and
-- selling_method are in the column right too, because the owner may change them; the trigger guard_design_update (0005) turns
-- staff back (JV_FORBIDDEN), refuses a selling method change while pieces are not archived, and refuses to archive a design
-- with pieces that are not archived (JV_NOT_ALLOWED). No insert right: create_design (X8) and the import write designs.
grant select on public.designs to authenticated;
grant update (
  name, description, notes, tags, primary_image_path, image_paths, category_id, subcategory_id, archived_at,
  material, purity, selling_method
) on public.designs to authenticated;

create policy designs_select on public.designs
  for select to authenticated
  using ((select private.app_role()) is not null);
create policy designs_update on public.designs
  for update to authenticated
  using ((select private.app_role()) in ('owner', 'staff'))
  with check ((select private.app_role()) in ('owner', 'staff'));

-- ---------------------------------------------------------------- D7, A5: skus
-- S for every active user; U for the owner and staff on the twelve content columns. status, archived_at and sold_bill_id
-- change only through the functions (set_sku_status, X9, and the bill functions); sku_no, barcode and design_id never change.
-- A stock edit sends only the changed fields and "where updated_at = <the value as it was read>", so a stale edit changes
-- nothing (T-C07). No insert right: create_design (X8) and the import write pieces.
grant select on public.skus to authenticated;
grant update (
  gross_weight, customer_net_weight, stones, stone_weight, kundan, kundan_weight, piroi,
  labour_retail, labour_semi, labour_wholesale, location, notes
) on public.skus to authenticated;

create policy skus_select on public.skus
  for select to authenticated
  using ((select private.app_role()) is not null);
create policy skus_update on public.skus
  for update to authenticated
  using ((select private.app_role()) in ('owner', 'staff'))
  with check ((select private.app_role()) in ('owner', 'staff'));

-- ---------------------------------------------------------------- D9: sku_private (owner S, I, U; nobody else)
-- The grant is to authenticated, which is every signed-in role; the policies are what keep a biller and staff out, so for
-- them the table is empty and every write is refused. anon has no right at all.
grant select on public.sku_private to authenticated;
grant insert (sku_id, original_net_weight, created_by, updated_by) on public.sku_private to authenticated;
grant update (original_net_weight, updated_by) on public.sku_private to authenticated;

create policy sku_private_select on public.sku_private
  for select to authenticated
  using ((select private.app_role()) = 'owner');
create policy sku_private_insert on public.sku_private
  for insert to authenticated
  with check ((select private.app_role()) = 'owner');
create policy sku_private_update on public.sku_private
  for update to authenticated
  using ((select private.app_role()) = 'owner')
  with check ((select private.app_role()) = 'owner');
