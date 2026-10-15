-- 0010 audit log, touch triggers, run logs and the polling indexes (task DB05). Spec: L1, L2, D16, D17, D19, D23, A4, S6.
-- Tests: supabase/tests/database/040_audit_counters.test.sql (T-D14, the touches of T-E07, the indexes of D19, T-D03, T-D04) and
--        supabase/tests/database/020_stock_access.test.sql (the three tables join the lists of T-F02).
--
-- Four things, all about reading what happened:
--   * audit_log (D16) and the trigger that fills it for the 13 tables of L1; the owner reads it, nobody writes it through the
--     API (L2). check_runs and backup_runs (D17), the same: the owner reads, the database owner's connection writes.
--   * the touch triggers of D23: the screens poll by updated_at (C4), but a balance changes when a row other than the
--     customer's own changes, so a receipt, an allocation or a bill moves updated_at on the customer and on the bills it affects.
--   * the indexes of D19 that the polling filter and the policies use (the ones DB03 and DB04 already made are not made again).
-- The three new tables have row-level security in this file (S9) and an explicit grant (A3 step 4).

-- ---------------------------------------------------------------- D16: audit_log
-- One row for every insert and update of the 13 audited tables (the trigger below). row_id is the key of the row as text (the
-- id; the key of a setting; the piece of an original weight). actor is auth.uid() and actor_role the role of that user's
-- profile; a write by somebody who is not signed in (the database owner: the import, a repair, the seeds) has no actor and the
-- role import (IM2). The log is append-only (L2): no API role holds INSERT, UPDATE, DELETE or TRUNCATE on it, and there is no
-- policy for those commands, so a granted right would still change no row. Only the owner reads it; for everybody else the
-- table is empty. The audit trigger writes it as the database owner.
create table public.audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default clock_timestamp(),
  actor uuid,
  actor_role text,
  table_name text not null,
  row_id text not null,
  action text not null constraint audit_log_action_check check (action in ('insert', 'update')),
  old_row jsonb,
  new_row jsonb
);
alter table public.audit_log enable row level security;
create index audit_log_table_name_row_id_idx on public.audit_log (table_name, row_id);
comment on table public.audit_log is 'D16, L1, L2: one row for each insert and update of the 13 audited tables, with the old and the new row as JSON. Append-only; the owner reads it, nobody writes it through the API.';

grant select on public.audit_log to authenticated;
create policy audit_log_select on public.audit_log
  for select to authenticated
  using ((select private.app_role()) = 'owner');

-- ---------------------------------------------------------------- D17: check_runs and backup_runs
-- check_runs: one row for each run of the nightly checks (I8): ok, and the counts per invariant in details. backup_runs: one
-- row for each step of the backup job (B2), written over the job's own database connection after each run: kind is the step,
-- bytes the size it produced, detail what the owner reads in her weekly check (bucket size, R2 usage). Both are read by the
-- owner only (A4); the dashboard's red light (I12) reads them through a function of DB17b.
create table public.check_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default clock_timestamp(),
  ok boolean not null,
  details jsonb
);
alter table public.check_runs enable row level security;
comment on table public.check_runs is 'D17, I8: one row for each run of the nightly checks. The owner reads it.';

create table public.backup_runs (
  id bigint generated always as identity primary key,
  ran_at timestamptz not null default clock_timestamp(),
  kind text not null constraint backup_runs_kind_check check (kind in ('db_dump', 'photo_copy', 'restore_drill')),
  ok boolean not null,
  bytes bigint constraint backup_runs_bytes_check check (bytes >= 0),
  detail jsonb
);
alter table public.backup_runs enable row level security;
comment on table public.backup_runs is 'D17, B2: one row for each step of the backup job (db_dump, photo_copy, restore_drill). The owner reads it.';

grant select on public.check_runs to authenticated;
grant select on public.backup_runs to authenticated;
create policy check_runs_select on public.check_runs
  for select to authenticated
  using ((select private.app_role()) = 'owner');
create policy backup_runs_select on public.backup_runs
  for select to authenticated
  using ((select private.app_role()) = 'owner');

-- ---------------------------------------------------------------- L1: the audit trigger
-- AFTER INSERT OR UPDATE, for each row, so it sees the row as the BEFORE triggers left it (the stamps and the person columns).
-- An update that changes nothing but updated_at is not written (D23): the touch triggers below move updated_at on the
-- customers and bills a payment affects and must add no noise. updated_by is left out of the comparison too, because
-- private.force_person_columns sets it to the signed-in user on every update (DB02): a touch made by somebody else would
-- otherwise look like a change. The argument of the trigger is the column that holds the row's key.
-- Security definer, because the signed-in role has no right on audit_log and may not execute private functions.
create or replace function private.write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid uuid := auth.uid();
  v_old jsonb;
  v_new jsonb := to_jsonb(new);
  v_key text := coalesce(tg_argv[0], 'id');
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    if (v_old - 'updated_at' - 'updated_by') = (v_new - 'updated_at' - 'updated_by') then
      return null;
    end if;
  end if;
  insert into public.audit_log (at, actor, actor_role, table_name, row_id, action, old_row, new_row)
  values (
    private.now_ts(),
    v_uid,
    case when v_uid is null then 'import' else coalesce((select private.app_role()), 'unknown') end,
    tg_table_name,
    v_new ->> v_key,
    lower(tg_op),
    v_old,
    v_new
  );
  return null;
end
$$;
revoke all on function private.write_audit() from public, anon, authenticated;
comment on function private.write_audit() is 'L1, D16, D23: trigger function. Writes one audit_log row for an insert or update; skips an update that changes nothing but updated_at (and updated_by). The argument names the key column.';

create trigger profiles_audit after insert or update on public.profiles
  for each row execute function private.write_audit('id');
create trigger settings_audit after insert or update on public.settings
  for each row execute function private.write_audit('key');
create trigger daily_rates_audit after insert or update on public.daily_rates
  for each row execute function private.write_audit('id');
create trigger categories_audit after insert or update on public.categories
  for each row execute function private.write_audit('id');
create trigger subcategories_audit after insert or update on public.subcategories
  for each row execute function private.write_audit('id');
create trigger designs_audit after insert or update on public.designs
  for each row execute function private.write_audit('id');
create trigger skus_audit after insert or update on public.skus
  for each row execute function private.write_audit('id');
create trigger sku_private_audit after insert or update on public.sku_private
  for each row execute function private.write_audit('sku_id');
create trigger customers_audit after insert or update on public.customers
  for each row execute function private.write_audit('id');
create trigger bills_audit after insert or update on public.bills
  for each row execute function private.write_audit('id');
create trigger bill_items_audit after insert or update on public.bill_items
  for each row execute function private.write_audit('id');
create trigger receipts_audit after insert or update on public.receipts
  for each row execute function private.write_audit('id');
create trigger receipt_allocations_audit after insert or update on public.receipt_allocations
  for each row execute function private.write_audit('id');

-- ---------------------------------------------------------------- D23: the touch triggers (for polling)
-- A balance is derived from bills, receipts and allocations, so when a payment or a cancel changes one of them the customer's
-- own row does not change, and a screen that polls customers by updated_at would never hear of it. The customer and the bills
-- affected are "touched": an UPDATE that sets updated_at, which the BEFORE trigger private.set_updated_at stamps from the clock
-- seam (S6) like any other update. The touch changes nothing else, so the audit trigger above writes nothing for it. The
-- statement-level triggers read the rows the statement changed from a transition table and touch every customer and bill in one
-- UPDATE each, so a rebalance that writes twenty allocations touches the customer once, not twenty times.
--
--   * receipts (insert, update, so also a void): the customer, and the bills its allocations paid;
--   * receipt_allocations (insert, update, so also a release): the customer, and the bill the allocation is on;
--   * bills: an insert touches the customer; so does an update of status (a cancel, with or without money allocated).
-- A touch does not touch anything else, so the chain stops here (touching a bill does not run the receipt triggers).
-- The customer comes first, as in the lock order of X0. Security definer, because they write tables the caller may not.
create or replace function private.touch_after_receipts()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.customers c
     set updated_at = private.now_ts()
   where c.id in (select r.customer_id from new_rows r);
  update public.bills b
     set updated_at = private.now_ts()
   where b.id in (
     select a.bill_id from public.receipt_allocations a where a.receipt_id in (select r.id from new_rows r));
  return null;
end
$$;
revoke all on function private.touch_after_receipts() from public, anon, authenticated;
comment on function private.touch_after_receipts() is 'D23: statement trigger function. Touches the customers of the receipts that changed and the bills their allocations paid.';

create or replace function private.touch_after_allocations()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.customers c
     set updated_at = private.now_ts()
   where c.id in (select a.customer_id from new_rows a);
  update public.bills b
     set updated_at = private.now_ts()
   where b.id in (select a.bill_id from new_rows a);
  return null;
end
$$;
revoke all on function private.touch_after_allocations() from public, anon, authenticated;
comment on function private.touch_after_allocations() is 'D23: statement trigger function. Touches the customers and the bills of the allocations that changed.';

create or replace function private.touch_after_bills()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.customers c
     set updated_at = private.now_ts()
   where c.id in (select b.customer_id from new_rows b);
  return null;
end
$$;
revoke all on function private.touch_after_bills() from public, anon, authenticated;
comment on function private.touch_after_bills() is 'D23: statement trigger function. Touches the customers of the bills that were inserted.';

create or replace function private.touch_customer_of_bill()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.customers c
     set updated_at = private.now_ts()
   where c.id = new.customer_id;
  return null;
end
$$;
revoke all on function private.touch_customer_of_bill() from public, anon, authenticated;
comment on function private.touch_customer_of_bill() is 'D23: trigger function. Touches the customer of a bill whose status changed (a cancel, also one with nothing allocated).';

create trigger receipts_touch_after_insert after insert on public.receipts
  referencing new table as new_rows for each statement execute function private.touch_after_receipts();
create trigger receipts_touch_after_update after update on public.receipts
  referencing new table as new_rows for each statement execute function private.touch_after_receipts();
create trigger receipt_allocations_touch_after_insert after insert on public.receipt_allocations
  referencing new table as new_rows for each statement execute function private.touch_after_allocations();
create trigger receipt_allocations_touch_after_update after update on public.receipt_allocations
  referencing new table as new_rows for each statement execute function private.touch_after_allocations();
create trigger bills_touch_after_insert after insert on public.bills
  referencing new table as new_rows for each statement execute function private.touch_after_bills();
-- Not a statement trigger: a transition table cannot be combined with a column list, and only a change of status matters.
create trigger bills_touch_customer_on_status after update of status on public.bills
  for each row when (old.status is distinct from new.status) execute function private.touch_customer_of_bill();

-- ---------------------------------------------------------------- D19: the indexes
-- Every table the screens poll gets (updated_at, primary key): the filter is "after the cursor", ordered by the same pair
-- (C4). Already made by DB03 and DB04, so not made again: skus (design_id), bills (customer_id, bill_date), receipts
-- (customer_id), and the indexes that start with the columns of bill_items (bill_id) and receipt_allocations (bill_id) and
-- (receipt_id) (the unique (bill_id, line_no) and the two composite-key indexes). skus (status) is for the filters on the
-- inventory screen. audit_log (table_name, row_id) is above, with the table.
create index bills_updated_at_id_idx on public.bills (updated_at, id);
create index skus_status_idx on public.skus (status);
create index skus_updated_at_id_idx on public.skus (updated_at, id);
create index designs_updated_at_id_idx on public.designs (updated_at, id);
create index sku_private_updated_at_sku_id_idx on public.sku_private (updated_at, sku_id);
create index bill_items_updated_at_id_idx on public.bill_items (updated_at, id);
create index receipt_allocations_updated_at_id_idx on public.receipt_allocations (updated_at, id);
create index daily_rates_updated_at_id_idx on public.daily_rates (updated_at, id);
create index settings_updated_at_key_idx on public.settings (updated_at, key);
create index categories_updated_at_id_idx on public.categories (updated_at, id);
create index subcategories_updated_at_id_idx on public.subcategories (updated_at, id);
create index profiles_updated_at_id_idx on public.profiles (updated_at, id);
create index receipts_updated_at_id_idx on public.receipts (updated_at, id);
create index customers_updated_at_id_idx on public.customers (updated_at, id);
