-- 0009 private tables (task DB05). Spec: D18, L3, L5, L6, S2.
-- Tests: supabase/tests/database/040_audit_counters.test.sql (the tables, T-C01 at the counter level) and
--        tests/db/numbering.test.ts (two sessions at one counter, two identical requests in flight, T-C14).
--
-- The two private tables the writing functions lean on. private.limits and private.import_batches, the other two of D18, were
-- made in 0003 so that later keys and functions had a target. Nothing here is reachable through the API: migration 0001 took
-- every default right in private away, and the row-level security below has no policy at all, so even a granted right would
-- see no row (A1, A3). The functions that use the tables are in 0011.

-- ---------------------------------------------------------------- D18, L3: counters
-- One row per number series: bill:<PREFIX>:<YYYY>, opening, design:<CATEGORY PREFIX>, sku:<design_no>. last_value is the
-- number issued last; private.next_number takes the next one with INSERT ... ON CONFLICT DO UPDATE in the transaction of the
-- row it numbers (L3), so the row lock serialises two callers and a rolled-back transaction rolls the counter back: no gap, no
-- repeat. seed_value is the number a series was seeded to after an import (private.seed_counters, IM3): the numbers issued by
-- a function are contiguous from seed_value + 1 (invariant I5). A series nobody seeded has seed_value 0.
create table private.counters (
  series text primary key constraint counters_series_not_blank check (btrim(series) <> ''),
  last_value bigint not null default 0 constraint counters_last_value_check check (last_value >= 0),
  seed_value bigint not null default 0 constraint counters_seed_value_check check (seed_value >= 0)
);
alter table private.counters enable row level security;
comment on table private.counters is 'D18, L3: the last number issued in each series, and the number the series was seeded to after an import. Not reachable through the API.';

-- ---------------------------------------------------------------- D18, L5, L6: idempotency
-- One row per request that created something. The first statement of every writing function inserts the row (through
-- private.idem_begin); if the row was already there the request is a repeat, and the function answers with the result stored
-- in it. fn, actor and args_hash say what the request was, so the same id used for another function, by another caller or with
-- another payload (another cart) is refused rather than answered with the first result. result is stored in the same
-- transaction as the rows it describes, so a request that failed leaves no row and can be sent again. The nightly job deletes
-- rows older than 90 days (L6, DB17b), which is what the index on created_at is for.
create table private.idempotency (
  request_id uuid primary key,
  fn text not null,
  actor uuid,
  args_hash text not null,
  result jsonb,
  created_at timestamptz not null default clock_timestamp()
);
alter table private.idempotency enable row level security;
create index idempotency_created_at_idx on private.idempotency (created_at);
comment on table private.idempotency is 'D18, L5: one row per request that created something: which function, which caller, a hash of the arguments, and the stored result. Rows older than 90 days are deleted by the nightly job (L6). Not reachable through the API.';
