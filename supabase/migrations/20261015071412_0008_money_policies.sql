-- 0008 money policies (task DB04). Spec: A3 step 4, A4, A5, A7, A9, A10, D10, K1, K4, K5, S7.
-- Tests: supabase/tests/database/030_money_tables.test.sql (every cell of the matrix for these tables for owner, biller,
--        staff and anon; T-D07, T-D08, T-C02), and supabase/tests/database/020_stock_access.test.sql (the policy list).
--
-- The grants and row rules of the five tables of 0007. Migration 0001 took every default right away, so nothing here is
-- reachable until it is granted, one table and one column list at a time (A3 step 4). Three things hold throughout:
--
--   * Reading is wide (A9): the owner and the biller read every row of all five tables, archived customers, cancelled bills
--     and voided receipts included (an update that reads columns also applies the SELECT policy, A4). Staff and anon read
--     nothing from them. A login that is not active, or has no profile, has no role and reads nothing (A10).
--   * Writing is narrow, and for four of the five tables it does not exist: bills, bill_items, receipts and receipt_allocations
--     are granted SELECT and nothing else, to nobody. Only the functions of Part B (security definer, owned by the database
--     owner) and the import write them, so a number, a snapshot or a balance cannot be forged by a client (K1). Customers have
--     no insert right either (create_customer, X6, and the import write them); the one write right is the column list of A5.
--     Nobody has DELETE anywhere (S7): rows are archived, voided or cancelled.
--   * The role comes from private.app_role(), called as (select private.app_role()) so that Postgres runs it once per
--     statement. One policy per command on each table (advisor lint 0006).
--
-- Where a role has a column right but no policy lets it through (staff updating a customer, say), an UPDATE changes no row
-- and raises no error; where it has no column right the statement fails with 42501.

-- ---------------------------------------------------------------- D10, A5: customers (owner S, U; biller S, U; staff none)
-- The eight content columns of A5 and archived_at. Column grants cannot tell the owner from the biller (both are the database
-- role authenticated), so the trigger below turns the biller back from archived_at. is_walkin, import_batch_id, the stamps and
-- the person columns are not granted: the triggers of 0007 set the person columns whatever a client sends (D22).
grant select on public.customers to authenticated;
grant update (name, mobile, customer_type, email, address, gst_number, pan, notes, archived_at) on public.customers to authenticated;

create policy customers_select on public.customers
  for select to authenticated
  using ((select private.app_role()) in ('owner', 'biller'));
create policy customers_update on public.customers
  for update to authenticated
  using ((select private.app_role()) in ('owner', 'biller'))
  with check ((select private.app_role()) in ('owner', 'biller'));

-- ---------------------------------------------------------------- D11 to D14, K1: bills, bill_items, receipts, receipt_allocations
-- Select only, for the owner and the biller. No insert, update or delete right and no such policy, for anyone.
grant select on public.bills to authenticated;
grant select on public.bill_items to authenticated;
grant select on public.receipts to authenticated;
grant select on public.receipt_allocations to authenticated;

create policy bills_select on public.bills
  for select to authenticated
  using ((select private.app_role()) in ('owner', 'biller'));
create policy bill_items_select on public.bill_items
  for select to authenticated
  using ((select private.app_role()) in ('owner', 'biller'));
create policy receipts_select on public.receipts
  for select to authenticated
  using ((select private.app_role()) in ('owner', 'biller'));
create policy receipt_allocations_select on public.receipt_allocations
  for select to authenticated
  using ((select private.app_role()) in ('owner', 'biller'));

-- ---------------------------------------------------------------- K4, K5, A5: archiving a customer
-- Runs before an update that names archived_at. It does three things, in this order:
--   * a biller (or anyone signed in who is not the owner) cannot archive a customer or bring one back: JV_FORBIDDEN. Somebody
--     who is not signed in (the database owner: an import, a repair) is not a user and passes this step, as in 0005;
--   * the walk-in can never be archived: JV_NOT_ALLOWED (the CHECK customers_walkin_rules of 0007 holds it as well);
--   * a customer is archived only when outstanding, advance, fine outstanding and fine advance are all zero: JV_NOT_ALLOWED
--     naming the figures. This holds for everybody, the database owner included: it is a rule of the books, not of a role.
-- The four figures are those of V2, read from the base tables (the views are made later, DB16):
--   outstanding      = active bills - live allocations            (a live allocation is not released and on an active receipt)
--   advance          = active money receipts - live allocations - active refunds
--   fine outstanding = fine due of active bills - live fine allocations
--   fine advance     = grams of active silver and cash-fine receipts - live fine allocations
-- Opening-balance bills and opening advances count like any other. Security definer, because it reads bills and receipts
-- whatever the caller may read and raises through private.jv_error, which the signed-in role may not execute.
create or replace function private.guard_customer_update()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_billed numeric;
  v_fine_billed numeric;
  v_received numeric;
  v_refunded numeric;
  v_fine_received numeric;
  v_allocated numeric;
  v_fine_allocated numeric;
  v_outstanding numeric;
  v_advance numeric;
  v_fine_outstanding numeric;
  v_fine_advance numeric;
begin
  if new.archived_at is not distinct from old.archived_at then
    return new;
  end if;

  if auth.uid() is not null and (select private.app_role()) is distinct from 'owner' then
    perform private.jv_error('JV_FORBIDDEN', 'Only the owner can archive a customer or bring one back');
  end if;

  if new.archived_at is null then
    return new;
  end if;

  if old.is_walkin then
    perform private.jv_error('JV_NOT_ALLOWED', 'The walk-in customer can never be archived');
  end if;

  select
    coalesce((select sum(b.grand_total) from public.bills b where b.customer_id = old.id and b.status = 'active'), 0),
    coalesce((select sum(b.fine_weight_due) from public.bills b where b.customer_id = old.id and b.status = 'active'), 0),
    coalesce((select sum(r.amount) from public.receipts r where r.customer_id = old.id and r.status = 'active' and r.kind = 'money'), 0),
    coalesce((select sum(r.amount) from public.receipts r where r.customer_id = old.id and r.status = 'active' and r.kind = 'refund'), 0),
    coalesce((select sum(r.fine_grams) from public.receipts r where r.customer_id = old.id and r.status = 'active' and r.kind in ('fine_silver', 'fine_cash')), 0),
    coalesce((select sum(a.amount) from public.receipts r join public.receipt_allocations a on a.receipt_id = r.id
               where r.customer_id = old.id and r.status = 'active' and a.released_at is null), 0),
    coalesce((select sum(a.fine_grams) from public.receipts r join public.receipt_allocations a on a.receipt_id = r.id
               where r.customer_id = old.id and r.status = 'active' and a.released_at is null), 0)
    into v_billed, v_fine_billed, v_received, v_refunded, v_fine_received, v_allocated, v_fine_allocated;

  v_outstanding := v_billed - v_allocated;
  v_advance := v_received - v_allocated - v_refunded;
  v_fine_outstanding := v_fine_billed - v_fine_allocated;
  v_fine_advance := v_fine_received - v_fine_allocated;

  if v_outstanding <> 0 or v_advance <> 0 or v_fine_outstanding <> 0 or v_fine_advance <> 0 then
    perform private.jv_error('JV_NOT_ALLOWED', format(
      'A customer can be archived only when nothing is owed either way. Outstanding %s, advance %s, fine outstanding %s g, fine advance %s g',
      v_outstanding, v_advance, v_fine_outstanding, v_fine_advance));
  end if;
  return new;
end
$$;
revoke all on function private.guard_customer_update() from public, anon, authenticated;
comment on function private.guard_customer_update() is 'K4, K5, A5: trigger function. Only the owner archives a customer or brings one back; the walk-in is never archived; a customer with an outstanding, advance, fine outstanding or fine advance that is not zero is not archived.';

create trigger customers_guard_update
  before update of archived_at on public.customers
  for each row execute function private.guard_customer_update();
