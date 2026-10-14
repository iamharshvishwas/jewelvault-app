# Tasks: P1 foundation and money (the JewelVault backend)

Generated on 2026-10-14 from `_build/p1-plan/plan_data.py` by `build_plan.py`, which also checks every requirement and test of `spec.md` (813 lines) against these tasks, that each test can pass in the task that introduces it, and that every existing file path exists. Days are Claude-days, plus or minus 30 percent (plan section 4). `[P]` marks a task that can run beside the one before it in its lane. "Tests" are spec tests first written (and seen failing) in that task; "extends" are spec tests that task completes a part of; "plan tests" are checks the plan adds because the spec has no test ID for them.

## Database

- DB01 Test harness: per-agent local stacks, helpers, fixtures, one verify command | depends on: - | days: 1.1 | test: T-F04 ; plan tests: PT-H1 harness smoke (pgTAP and two-connection) | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB02 Privileges, schemas, profiles and roles | depends on: DB01 | days: 1.0 | test: T-D01, T-D02, T-D06, T-D10, T-D11, T-D13, T-D15, T-D16, T-D17, T-D20, T-E09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB03 Reference and stock tables with their access rules | depends on: DB02 | days: 1.2 | test: T-C07, T-D05, T-D19, T-D22, T-F02, T-F05 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB04 Customers, bills, receipts and allocations: tables and access rules | depends on: DB03 | days: 1.0 | test: T-B01, T-B06, T-C02, T-D07, T-D08 ; extends T-F02 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB05 Counters, idempotency, audit, touch triggers, seeds | depends on: DB04 | days: 1.0 | test: T-D04, T-D14 ; extends T-F02, T-D03 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB06 [P] Stock functions: create_design and set_sku_status | depends on: DB05 | days: 1.0 | test: T-A02, T-C03, T-C17, T-F01 ; extends T-C08, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB07 [P] Photo storage: bucket and policies | depends on: DB03 | days: 0.5 | test: T-D21 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB08 Pricing functions, quote_bill and the parity test | depends on: DB03, FE01 | days: 1.3 | test: T-A01, T-A04, T-A05, T-A07, T-A08, T-A09, T-A10, T-A11, T-A13, T-A14, T-A16, T-A18, T-A19 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB09a The write prologue and create_customer | depends on: DB05, DB02 | days: 0.6 | test: T-F06 ; extends T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB09b create_bill core without payments (private.create_bill_core) | depends on: DB09a, DB08 | days: 1.2 | test: T-A03, T-A06, T-A15, T-A17, T-B16, T-B24, T-C01, T-C04, T-C05, T-C06, T-C08, T-D03 ; extends T-A10, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB10a private.rebalance for money and silver | depends on: DB09b | days: 0.9 | test: T-B26 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB10b record_payment | depends on: DB10a | days: 1.0 | test: T-B04, T-B05, T-B22, T-C09 ; extends T-B01, T-B06, T-B17, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB16 Views V1 to V4 | depends on: DB04, DB05 | days: 1.2 | test: T-B02, T-B15, T-B17, T-D18 ; extends T-B05 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB11 Cash limit and PAN rules, and the payment rows of a bill (the private helpers only) | depends on: DB10b | days: 0.7 | test: T-A12, T-B03, T-B07 ; extends T-B01 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB12 [P] settle_fine | depends on: DB11, DB16 | days: 0.7 | test: T-B11, T-B12, T-B13, T-B23 ; extends T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB13 void_receipt and cancel_bill | depends on: DB11, DB16 | days: 0.9 | test: T-B08, T-B09, T-B10 ; extends T-B17, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB14a reissue_bill | depends on: DB13, DB11, DB09b | days: 1.0 | test: T-B19, T-B25 ; extends T-B17, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB14b add_opening_balance | depends on: DB10b, DB16, DB13, DB11 | days: 0.7 | test: T-B21, T-F07 ; extends T-B17, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB15 issue_refund (first to leave if the calendar slips) | depends on: DB13, DB16 | days: 0.4 | test: T-B20 ; extends T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB17a Invariants I1 to I7, I10 and I13, with the mutation helper | depends on: DB16, DB09b | days: 1.0 | test: - ; extends T-B18 ; plan tests: PT-I1 mutation half of T-B18: one damaged row per invariant | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB17b Nightly job, review line, backup heartbeat and the dashboard summary function | depends on: DB17a, DB05 | days: 0.8 | test: T-B18 ; extends T-B24, T-C05 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB18a Two-session interleavings with the test hook | depends on: DB14a, DB14b, DB15, DB12, DB17a | days: 1.0 | test: T-C10, T-C11, T-C12, T-C13, T-C14 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB18c Lock timeout, role timeout and the stress run | depends on: DB18a | days: 0.7 | test: T-C15 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB18b Random sequences of operations and the function-by-role matrix | depends on: DB14a, DB14b, DB15, DB12, DB17a | days: 1.2 | test: T-B14, T-D09 | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB19 [P] Import and opening data script | depends on: DB14b, DB17b, DB21a, PL03 | days: 1.2 | test: T-C16 | rollback: The import runs in one transaction per batch against local or dev: a failed batch rolls back; a wrong finished batch is undone by listing its rows through `import_batch_id` and cancelling them (opening rows by X5 and X4), or by wiping dev. Production is only ever imported after the reconciliation matches (IM8).

## Platform

- DB20a [P] Backup job: encrypted dump, photo mirror, heartbeat | depends on: DB05, PL02, DB21a | days: 1.2 | test: T-R01 | rollback: Stop the scheduler entry and delete the R2 test objects the job wrote (the bucket is Harsh's, empty before the job). Nothing else depends on the job until DB20b.
- DB20b Restore drill 1 and the runbook | depends on: DB20a, DB17b, FE05, DB21a, PL01 | days: 0.7 | test: T-R02 | rollback: The drill restores into the free dev project, which is wiped before and after; the real database is not touched. A failed drill is a finding, not a rollback.
- DB21a [P] Dev project gets the migrations merged so far (early) | depends on: DB05, PL01 | days: 0.3 | test: - | rollback: Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).
- DB21 Platform checks on the cloud dev project | depends on: DB18b, DB21a, PL01, PL02, FE06 | days: 0.6 | test: - ; extends T-D11, T-D12, T-D17 | rollback: Dev project: restore the dump taken at the start of the task (the project holds test data only). Cloudflare preview: delete the preview deployment. Production is not touched.

## Front end

- FE01 [P] Integer pricing copy and the shared selectors | depends on: - | days: 1.0 | test: - ; extends T-A02, T-A03, T-A14 ; plan tests: PT-F1 unit tests of pricing.ts and selectors.ts | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE02 Supabase client, session gate, login and roles | depends on: DB02 | days: 1.4 | test: T-E08 ; extends T-D06, T-E01 | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE03 Hydrate the stock side behind the loading gate | depends on: FE02, DB03, DB05 | days: 1.0 | test: T-E05 ; extends T-E01 ; plan tests: PT-F3 stock hydrate pages 2,500 pieces | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE04 Polling, merging, offline banner and ordinary edits (stock side) | depends on: FE03, DB05 | days: 1.2 | test: T-E01, T-E03 ; extends T-E05 ; plan tests: PT-F4 two browsers see a stock change within 10 seconds | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE04b Money side of the cache: customers, bills, receipts and the views | depends on: FE04, DB16, DB10b | days: 0.8 | test: T-E02, T-E07, T-F03 | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE05 Stock functions and photos from the screens | depends on: FE04, DB06, DB07 | days: 1.0 | test: - ; extends T-D21 ; plan tests: PT-F5 Add Design with photos end to end; staff has no original-weight field | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE06 [P] Hosting headers and build checks | depends on: DB01, FE02, FE03 | days: 0.7 | test: T-D12 | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE07a Billing screen on create_bill, with customer creation | depends on: FE04b, FE01, DB11, DB09a | days: 1.2 | test: T-E06 ; extends T-A03 | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE07b Payment and silver-fine panels | depends on: FE07a, DB12, DB10b | days: 0.9 | test: - ; plan tests: PT-F7 receive payment, advance shown, settle fine in silver and in cash | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE08 Estimate view and the customer ledger | depends on: FE07b, DB16 | days: 0.8 | test: - ; plan tests: PT-F8 customer card, saved estimates and ledger agree on the same data | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE09 Cancel, re-issue, void, refund and opening-balance screens; the error map | depends on: FE08, DB13, DB14a, DB14b, DB15 | days: 1.2 | test: - ; extends T-E04, T-E07 ; plan tests: PT-F9 owner actions work end to end and a biller sees none; PT-F9b cancelling an unpaid bill changes the other browser's outstanding within 10 seconds; PT-U9 the error map covers every JV_ code (unit) | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE10a The owner's dashboard line and the shared selectors on dashboard, reports and customer card | depends on: FE04b, DB17b, FE01, DB20a | days: 0.9 | test: T-R03 ; extends T-B15, T-E04 | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE10b [P] Daily rate entry (owner and biller) | depends on: FE04, DB03 | days: 0.5 | test: - ; plan tests: PT-F10 a rate for today can be entered; yesterday's cannot by a biller | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).
- FE11 Download everything, and hiding what is not ready | depends on: FE09 | days: 0.8 | test: T-E04 | rollback: `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

## Reviews and close-out

- RV1 Implementation review 1: access and security (fresh agent) | depends on: DB04, DB05, DB06, DB07, FE02, FE06 | days: 0.5 | test: - | rollback: Nothing to roll back (a review only reads).
- RV2 Implementation review 2: the money core, with a mutation check (fresh agent) | depends on: DB18b, DB18c | days: 1.0 | test: - | rollback: Nothing to roll back (a review only reads).
- RV3 Implementation review 3: end to end (fresh agent) | depends on: FE11, FE10a, FE10b, DB21, RV2, DB20b | days: 0.5 | test: - | rollback: Nothing to roll back (a review only reads).
- CL Close-out: stop the stacks, remove worktrees and branches that are merged, update the README and the ledger | depends on: RV3 | days: 0.2 | test: - | rollback: Nothing to roll back; worktrees and branches are removed only after RV3 and Harsh's say-so.

## Harsh and Siddhi

- PL01 [P] Harsh: Supabase decisions (free dev project, organisations, access path) | depends on: - | days: 0.2 | test: - | rollback: Nothing to roll back.
- PL02 [P] Harsh: Cloudflare R2 bucket and keys, a private GitHub repository, the backup scheduler | depends on: - | days: 0.4 | test: - | rollback: Nothing to roll back.
- PL03 [P] Harsh and Siddhi: business answers, her data, devices, a runbook tester | depends on: - | days: 0.4 | test: - | rollback: Nothing to roll back.
- PL04 [P] Harsh, at go-live: the production database password for one session, and his go | depends on: - | days: 0.1 | test: - | rollback: Nothing to roll back.

## What each task does

### DB01 Test harness: per-agent local stacks, helpers, fixtures, one verify command

- **Agent:** A   **PLAN.md task:** P1-T4 (start), P0-T2 leftovers   **Days:** 1.1   **Depends on:** -
- **Spec lines:** S9, H5
- **Tests first written here:** T-F04   **Extends:** -   **Plan tests:** PT-H1 harness smoke (pgTAP and two-connection)
- **Do:** `supabase/config.toml` (project id `jewelvault`, main port block 443xx because Harsh's other project uses the default 543xx on this Mac, `api.schemas = ["public"]`, `api.auto_expose_new_tables = true` (the worst case, so the access tests prove the revokes of 0001; the hosted setting is read in DB21), `api.max_rows = 1000`, `auth.enable_signup = false`, `auth.minimum_password_length = 10`, `[db.seed] sql_paths = ["./seeds/*.sql"]`). `scripts/lane.mjs`: for a lane (main, a, b, c) it writes a never-committed work folder `.lanes/<lane>/` holding the committed config with its own project id (`jv-<lane>`) and its own port block (main 443xx, a 453xx, b 463xx, c 473xx: valid ports below the 49152 dynamic range), links to `migrations`, `tests` and `seeds`, and writes `.env.local` (API URL, database URL, publishable key, dev-server port). npm scripts `db:start`, `db:stop` (`--no-backup` only on request), `db:reset` (`--local`), `db:test` (always after a reset, because `supabase test db` neither migrates nor re-seeds), `db:test:2`, `db:check` (migrations applied twice give the same schema), `verify` (typecheck, lint, unit, db:check, db:test, db:test:2, build, build check: the full gates before anything is called ready to push; its lint step covers only the files changed since the merge base with `main`, because the prototype's 1,221 existing lint findings are not this phase's to fix, and a step whose script does not exist yet prints "skipped (task X)" and is named in the report). Seeds, local only: `00_guard.sql` aborts unless `app.settings.jwt_secret` is the published local default (so it cannot run on a hosted project); `10_test_helpers.sql` creates the `tests` schema: `make_user(role)` (an `auth.users` row with every token column set, for pgTAP), `as_user(uuid)`, `set_clock(timestamptz)` (replaces `private.now_ts()` inside the test's own rolled-back transaction), fixture builders (design, piece, customer, rate, and bill once the functions exist), bulk generators (2,500 pieces, 1,500 rows, 3,000 bills), and `reset_business_data()` (catalogue-driven; sets `lock_timeout`, ends leaked backends, then calls `private.seed_defaults()`). Tests: `tests/db/vitest.config.ts` (serial files), `tests/db/pg.ts` (two connections, `withRole`), `tests/db/hook.ts` (replace `private.test_pause` with an advisory-lock wait, and mutate and restore a function to prove a test fails without a lock), `tests/db/rpc.ts` (a real login through the Auth admin API and calls over HTTP, needed to see the role's 15-second timeout), Playwright `workers: 1`, `fullyParallel: false`, dev-server port from `PORT`. `package.json` pins the exact `supabase` CLI version and adds `pg` and `@types/pg`; `.gitignore` gets `!.env*.example` and `.lanes/`; `tests/README.md` documents the harness.
- **Files:** +supabase/config.toml, +scripts/lane.mjs, +supabase/seeds/00_guard.sql, +supabase/seeds/10_test_helpers.sql, +supabase/tests/database/000_smoke.test.sql, +tests/db/vitest.config.ts, +tests/db/pg.ts, +tests/db/hook.ts, +tests/db/rpc.ts, +tests/README.md, +scripts/check-migrations.sh, playwright.config.ts, package.json, .gitignore
- **Done when:** A cold `LANE=a npm run db:start` brings up a stack in under 5 minutes and all four lanes (main, a, b, c) run at the same time without a port clash; the smoke tests pass in both lanes; `db:check` passes on an empty set of migrations; the guard seed refuses to run against a stack whose JWT secret is not the local default; `npm run verify` runs end to end.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB02 Privileges, schemas, profiles and roles

- **Agent:** A   **PLAN.md task:** P1-T4   **Days:** 1.0   **Depends on:** DB01
- **Spec lines:** S1, S5, S6, S10, A1, A2, A3, A8, A10, A11, D1, D2, D18, D22, U2, U3
- **Tests first written here:** T-D01, T-D02, T-D06, T-D10, T-D11, T-D13, T-D15, T-D16, T-D17, T-D20, T-E09   **Extends:** -   **Plan tests:** -
- **Do:** Migrations 0001 to 0003. 0001: schema `private`; the A3 recipe in its tested order, with the global `alter default privileges for role postgres revoke execute on functions from public` (the schema-scoped form alone leaves new functions callable), existing functions revoked from `public` as well, the `private` schema rules, and the event trigger that enables row-level security on any table later created in `public` or `private`; `alter role authenticated set statement_timeout = '15s'` with `notify pgrst, 'reload config'` (a `set local` inside a function does not shorten the call already running). 0002: `profiles` (a login made without metadata gets the part of the email before the @ as its name), `private.app_role()`, the new-user trigger (inactive staff), the trigger that stops anyone changing their own `role` or `active`, `private.activate_user(email, role, full_name)`. 0003: `set_updated_at()` (`clock_timestamp()`), `force_person_columns()`, `private.jv_error(code, text)`, `private.today()` and `private.now_ts()` (the clock seam), `private.import_batches` and `private.limits` with the caps and thresholds (created early so later foreign keys and the pricing functions have a target), and the triggers attached to `profiles`. T-D11 here is the local advisor, `supabase db advisors --local --level warn --fail-on warn`, run inside `npm run verify` (the `tests` helpers carry an explicit search path so they do not trip lint 0011), plus a pgTAP assertion that no function is executable by `anon` and only the named ones by `authenticated`. T-D13 is a Vitest call to the local Auth API with sign-up off.
- **Files:** +supabase/migrations/*_0001_privileges_schemas.sql, +supabase/migrations/*_0002_profiles_roles.sql, +supabase/migrations/*_0003_common_triggers.sql, +supabase/tests/database/010_privileges.test.sql, +supabase/tests/database/011_profiles.test.sql, +tests/db/auth.test.ts
- **Done when:** The listed tests pass; the local advisor exits 0; a function created after 0001 is not executable by `anon` or `authenticated` until it is granted; the catalogue-based tests (T-D01, T-D10, T-D15) cover every later table and function.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB03 Reference and stock tables with their access rules

- **Agent:** A   **PLAN.md task:** P1-T4 (slice 1)   **Days:** 1.2   **Depends on:** DB02
- **Spec lines:** D3, D4, D5, D6, D7, D8, D9, A4, A5, P4, S3, S4
- **Tests first written here:** T-C07, T-D05, T-D19, T-D22, T-F02, T-F05   **Extends:** -   **Plan tests:** -
- **Do:** Migrations 0004 to 0006: `settings`, `daily_rates`, `categories`, `subcategories`, `designs`, `skus`, `sku_private` with the checks of D6 to D9 (Sold and Archived tied to their columns, no `data:` photo value using built-in functions only, S3 types), the caps of S4 as literals in the `CHECK`s, the weight rules of D7 (O37) as a trigger, the trigger that refuses a `selling_method` change while pieces exist, and the policies and column grants of A4 and A5 for these tables (all read roles see archived rows; the biller inserts a rate only dated today (the date written inline in the policy, because a policy cannot call a `private` function); staff may set `archived_at` on a design). `skus.sold_bill_id` is added in DB04 when `bills` exists. T-F02 starts here (including the comparison of every cap literal with `private.limits`) and is extended in DB04 and DB05.
- **Files:** +supabase/migrations/*_0004_reference_tables.sql, +supabase/migrations/*_0005_stock_tables.sql, +supabase/migrations/*_0006_stock_policies.sql, +supabase/tests/database/020_stock_access.test.sql
- **Done when:** Every cell of the A4 and A5 matrix for these tables is proved for owner, biller, staff and anon, including the owner-only weight table.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB04 Customers, bills, receipts and allocations: tables and access rules

- **Agent:** A   **PLAN.md task:** P1-T4 (slice 2)   **Days:** 1.0   **Depends on:** DB03
- **Spec lines:** D10, D11, D12, D13, D14, D15, D21, K1, K4, K5, S7, Y2, Y4
- **Tests first written here:** T-B01, T-B06, T-C02, T-D07, T-D08   **Extends:** T-F02   **Plan tests:** -
- **Do:** Migrations 0007 and 0008: the five tables with the checks of D10 to D15 (receipt `kind` ties to its other columns, no `Credit`, no `request_id` on receipts, composite foreign keys that make a cross-customer allocation impossible, exactly one walk-in row, `reissue_of` unique, negative `round_off` allowed, the mobile rule of D10), `alter table skus add constraint` for `sold_bill_id`, the `import_batch_id` foreign keys, read-only policies for bills, lines, receipts and allocations, no write grant to any API role and no `DELETE` anywhere, the owner's and the biller's `UPDATE` on the customer content columns (the owner alone on `archived_at`), and the trigger that refuses archiving a customer with a balance (K4).
- **Files:** +supabase/migrations/*_0007_money_tables.sql, +supabase/migrations/*_0008_money_policies.sql, +supabase/tests/database/030_money_tables.test.sql
- **Done when:** A direct insert, update or delete by any API role on a money table fails; a cross-customer allocation cannot be inserted even as the table owner; a biller can edit a customer's name and not archive them (a case of T-D04 is added in DB05).
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB05 Counters, idempotency, audit, touch triggers, seeds

- **Agent:** A   **PLAN.md task:** P1-T4 (slice 2), P1-T9 (part)   **Days:** 1.0   **Depends on:** DB04
- **Spec lines:** S2, S8, L1, L2, L3, L4, L5, L6, D16, D17, D18, D19, D20, D23
- **Tests first written here:** T-D04, T-D14   **Extends:** T-F02, T-D03   **Plan tests:** -
- **Do:** Migrations 0009 to 0012: `private.counters` (with `seed_value`) and `idempotency` (`limits` is already there from 0003); `private.next_number(series)` (insert on conflict do update, with the skip-existing check per series up to 100 tries); the format helpers of L4; `private.idem_begin(request_id, fn, args_hash)` (insert first, wait for an in-flight twin, return the stored result or refuse a different payload); `audit_log` and its triggers on the 13 tables (an update of `updated_at` alone writes nothing); the touch triggers of D23 including a bill's `status` update; `check_runs` and `backup_runs`; the indexes of D19 on every polled table; `private.seed_defaults()` (settings keys including `data_epoch`, categories, the walk-in customer, no sample data), used by the seed migration and by `tests.reset_business_data()`. T-F02 is extended with the check that every cap literal in a `CHECK` equals `private.limits`.
- **Files:** +supabase/migrations/*_0009_private_tables.sql, +supabase/migrations/*_0010_audit_touch.sql, +supabase/migrations/*_0011_numbering_helpers.sql, +supabase/migrations/*_0012_seeds.sql, +supabase/tests/database/040_audit_counters.test.sql
- **Done when:** Counters never repeat or skip across a rolled-back insert; an update of only `updated_at` writes no audit row; cancelling an unpaid bill moves the customer's `updated_at`.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB06 Stock functions: create_design and set_sku_status

- **Agent:** C   **PLAN.md task:** P1-T4/P1-T6 (stock saves)   **Days:** 1.0   **Depends on:** DB05
- **Spec lines:** R1, X8, X9, P2, C11
- **Tests first written here:** T-A02, T-C03, T-C17, T-F01   **Extends:** T-C08, T-D09   **Plan tests:** -
- **Do:** Migration 0013: `create_design` (screen-made design id, up to 500 pieces, blank-rate rule of R1, owner-only weight, series from L3) and `set_sku_status` (no `Sold`; archive sets `archived_at`), definer functions with the A6 pattern. The blank-rate rule of R1 is the DB half of T-A02, and leaving Archived clearing `archived_at` is the X9 clause of T-C08. The stock function follows X0 items 1, 2, 5 and 6 only: `SET lock_timeout = '5s'` as a clause, the idempotency insert first through `private.idem_begin` (DB05; it does not wait for the money helpers of DB09a), the role check, the pieces by id and the number counter last; it takes no customer lock and has no test hook.
- **Files:** +supabase/migrations/*_0013_stock_functions.sql, +supabase/tests/database/050_stock_functions.test.sql
- **Done when:** A design with 3 groups of pieces is created in one call; staff passing the original weight gets JV_FORBIDDEN; 501 pieces are refused; the function-by-role rows for X8 and X9 are proved.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB07 Photo storage: bucket and policies

- **Agent:** C   **PLAN.md task:** P1-T7   **Days:** 0.5   **Depends on:** DB03
- **Spec lines:** P1, P3
- **Tests first written here:** T-D21   **Extends:** -   **Plan tests:** -
- **Do:** Migration 0014: bucket `design-photos` (public read, 2 MB, jpeg, webp, png) and the policies of P3 written with one policy per command on `storage.objects` using `private.app_role()`: owner and staff insert only, only the owner overwrites or deletes, a biller and anon cannot add or list. The upload half of T-D21 (a real 5 MB file refused) runs in FE05.
- **Files:** +supabase/migrations/*_0014_photo_storage.sql, +supabase/tests/database/060_storage.test.sql
- **Done when:** The policy tests pass on the local storage schema and the local advisor still exits 0.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB08 Pricing functions, quote_bill and the parity test

- **Agent:** B   **PLAN.md task:** P2-T1   **Days:** 1.3   **Depends on:** DB03, FE01
- **Spec lines:** R1, R2, R3, R4, R5, R6, R7, R8, R12, R13, R14, X7
- **Tests first written here:** T-A01, T-A04, T-A05, T-A07, T-A08, T-A09, T-A10, T-A11, T-A13, T-A14, T-A16, T-A18, T-A19   **Extends:** -   **Plan tests:** -
- **Do:** Migration 0015: `private.price_line` and `private.price_bill` (version 1), `private.default_rate`, `private.list_prices`, the S4 caps on inputs and on computed amounts, per-line paise rounding, the `before_round >= 0` rule, the round-off setting, the `RATE_MISSING` and `RATE_STALE` warnings, and the read-only `quote_bill` (a definer function with a role check) taking a `p_pricing_version`. Pure functions over `jsonb`, so they are tested without bills. The 200-input parity test compares them with `src/lib/pricing.ts` from FE01.
- **Files:** +supabase/migrations/*_0015_pricing.sql, +supabase/tests/database/070_pricing.test.sql, +tests/db/parity.test.ts
- **Done when:** All 13 listed pricing tests pass; the worked example gives 257,612; every error is a JV_ code, never a numeric overflow.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB09a The write prologue and create_customer

- **Agent:** A   **PLAN.md task:** P2-T1   **Days:** 0.6   **Depends on:** DB05, DB02
- **Spec lines:** X0, X6, A6
- **Tests first written here:** T-F06   **Extends:** T-D09   **Plan tests:** -
- **Do:** Migration 0016: the shared prologue helpers (`private.begin_write`) that every writing function calls, and `create_customer` with the mobile rule and never the walk-in; the empty `private.test_pause(name)` that every writing function calls once after reading the customer's state, which the test database replaces with an advisory-lock wait (X0 item 8); and `SET lock_timeout = '5s'` as a clause of every function. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0016_write_prologue_customer.sql, +supabase/tests/database/075_customer.test.sql
- **Done when:** A repeated request id returns the stored customer; the same id with other arguments is refused; categories, the walk-in and the mobile rule are proved (T-F06).
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB09b create_bill core without payments (private.create_bill_core)

- **Agent:** A   **PLAN.md task:** P2-T1   **Days:** 1.2   **Depends on:** DB09a, DB08
- **Spec lines:** X0, X1, K2, R9, R10, Y8
- **Tests first written here:** T-A03, T-A06, T-A15, T-A17, T-B16, T-B24, T-C01, T-C04, T-C05, T-C06, T-C08, T-D03   **Extends:** T-A10, T-D09   **Plan tests:** -
- **Do:** Migration 0017: `private.create_bill_core` (shared later by `reissue_bill`) and `create_bill` with its final signature from the start (`p_payments`, `p_confirm_held`, `p_cash_override_reason` accepted but inert until DB11, which fills in the private helpers `private.cash_rules_check` and `private.apply_payments` that `create_bill` already calls as stubs) through steps (a) to (d), (f) to (h) and (k) of X1 (fixtures insert designs and pieces directly as the table owner, so this task does not wait for `create_design`): the customer lock, pieces locked by id, the billable-status rule, pricing, the number taken last, a conditional update of the pieces, list prices stored (Per Piece compared on price only), `labour_rate` required for By Weight and ignored for Per Piece, an absent `piroi` or `other_charges` as 0, the 200-line cap and the date rules for biller and owner. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0017_create_bill.sql, +supabase/tests/database/080_create_bill.test.sql, +tests/db/concurrent_bill.test.ts
- **Done when:** T-C04 (two sessions, one winner) and T-C05 (same request id twice) pass; a failed bill leaves no piece Sold and uses no number; the original weight is in no bill line.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB10a private.rebalance for money and silver

- **Agent:** A   **PLAN.md task:** P2-T1   **Days:** 0.9   **Depends on:** DB09b
- **Spec lines:** Y3, Y6, Y9
- **Tests first written here:** T-B26   **Extends:** -   **Plan tests:** -
- **Do:** Migration 0018: `private.rebalance(p_customer uuid, p_first_bill uuid default null)` with its final signature (the named bill goes first, DB14a): oldest bill first by date, created time and id; oldest receipt first by paid date, created time and id; fine grams the same way; applies in total at most the customer's `advance` of V2 (received - allocated - refunded), so refunded money is never spent twice; never edits an existing allocation; plus a test helper `tests.assert_i10(customer)` that recomputes the post-condition from the base tables, including the walk-in clause.
- **Files:** +supabase/migrations/*_0018_rebalance.sql, +supabase/tests/database/085_rebalance.test.sql
- **Done when:** After every operation the post-condition of I10 holds (the helper is reused by every later money task).
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB10b record_payment

- **Agent:** A   **PLAN.md task:** P2-T1   **Days:** 1.0   **Depends on:** DB10a
- **Spec lines:** X2, Y5
- **Tests first written here:** T-B04, T-B05, T-B22, T-C09   **Extends:** T-B01, T-B06, T-B17, T-D09   **Plan tests:** -
- **Do:** Migration 0019: `record_payment` with its final signature (including `p_cash_override_reason`, passed to the stub `private.cash_rules_check` that DB11 fills in) and the named bill first, the advance kept for the remainder, the checks on a bad named bill, the tie-break orders, and for the walk-in customer a payment that does not name its bill, or that is above that bill's pending, refused (K5). Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0019_record_payment.sql, +supabase/tests/database/090_payment.test.sql, +tests/db/concurrent_payment.test.ts
- **Done when:** Two concurrent payments never apply the same pending amount twice; an `opening_balance` row is paid first.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB16 Views V1 to V4

- **Agent:** C   **PLAN.md task:** P2-T1   **Days:** 1.2   **Depends on:** DB04, DB05
- **Spec lines:** V1, V2, V3, V4, R11
- **Tests first written here:** T-B02, T-B15, T-B17, T-D18   **Extends:** T-B05   **Plan tests:** -
- **Do:** Migration 0020: the four `security_invoker` views with `id` and `updated_at` and the ledger order key, grants for owner and biller only, and a plan check that a filter on one customer is applied before the window sums.
- **Files:** +supabase/migrations/*_0020_views.sql, +supabase/tests/database/150_views.test.sql
- **Done when:** The last ledger balance equals `customer_balances.balance` on a mixed data set; the walk-in's dues are in the outstanding total.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB11 Cash limit and PAN rules, and the payment rows of a bill (the private helpers only)

- **Agent:** C   **PLAN.md task:** P2-T1   **Days:** 0.7   **Depends on:** DB10b
- **Spec lines:** Y1, Z1, Z2, Z3, Z4
- **Tests first written here:** T-A12, T-B03, T-B07   **Extends:** T-B01   **Plan tests:** -
- **Do:** Migration 0021: `create or replace` of the private helpers `private.apply_payments` (steps (e), (i) and (j) of X1: payment rows, overpayment check, advance applied by the rebalance) and `private.cash_rules_check` (the cash and PAN rules of section 13, used by X1, X2 and later X3 and X10; the public functions of DB09b and DB10b are not edited): per-day total for a named customer, owner-only written reason, walk-in rule, PAN pattern and `PAN_MISSING`.
- **Files:** +supabase/migrations/*_0021_cash_rules_bill_payments.sql, +supabase/tests/database/100_cash_rules.test.sql
- **Done when:** 1,99,999.99 passes and 2,00,000 stops a biller; the owner with a reason passes; the walk-in is refused without override.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB12 settle_fine

- **Agent:** C   **PLAN.md task:** P2-T1   **Days:** 0.7   **Depends on:** DB11, DB16
- **Spec lines:** X3, SF1, SF2, SF3
- **Tests first written here:** T-B11, T-B12, T-B13, T-B23   **Extends:** T-D09   **Plan tests:** -
- **Do:** Migration 0022: `settle_fine` for silver and for cash at the day's rate, oldest first, the named bill first, never above the fine outstanding (JV_FINE_EXCEEDS), the cash rules applied to `fine_cash`. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0022_settle_fine.sql, +supabase/tests/database/110_fine.test.sql
- **Done when:** A fine settled in cash is in the Cash row of `daily_totals` and does not reduce rupees owed.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB13 void_receipt and cancel_bill

- **Agent:** A   **PLAN.md task:** P2-T1   **Days:** 0.9   **Depends on:** DB11, DB16
- **Spec lines:** X4, X5, K3, Y7
- **Tests first written here:** T-B08, T-B09, T-B10   **Extends:** T-B17, T-D09   **Plan tests:** -
- **Do:** Migration 0023: both functions with the lock order of X0 (find, lock the customer, re-read), release of allocations on cancel, pieces back to In Stock, the rebalance after each (so waiting money pays a re-opened bill), JV_ALREADY_VOID and JV_BILL_CANCELLED, the void refused with JV_NOT_ALLOWED when the advance after it would be below 0 (money already refunded), and a walk-in bill with live allocations refused by `cancel_bill` (K5). T-B09 uses a fine settlement made as a fixture row; `settle_fine` itself is exercised again in T-B14. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0023_void_cancel.sql, +supabase/tests/database/120_void_cancel.test.sql
- **Done when:** A voided payment restores bill pending and customer outstanding exactly, and the ledger shows a Void row on the day of the void.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB14a reissue_bill

- **Agent:** A   **PLAN.md task:** P2-T1   **Days:** 1.0   **Depends on:** DB13, DB11, DB09b
- **Spec lines:** X10, K6
- **Tests first written here:** T-B19, T-B25   **Extends:** T-B17, T-D09   **Plan tests:** -
- **Do:** Migration 0024: `reissue_bill` on top of `private.create_bill_core`: union piece lock by id, cancel without a rebalance, new bill with `reissue_of`, rebalance with the new bill first for money and silver, then the new payments, carried-over money counted in the overpayment check. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0024_reissue.sql, +supabase/tests/database/130_reissue.test.sql
- **Done when:** A re-issue with and without older dues leaves received money counted once, and the ledger lists Cancellation, Invoice, Payment in that order.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB14b add_opening_balance

- **Agent:** C   **PLAN.md task:** P2-T1, P3-T4 (data side)   **Days:** 0.7   **Depends on:** DB10b, DB16, DB13, DB11
- **Spec lines:** X12, IM5
- **Tests first written here:** T-B21, T-F07   **Extends:** T-B17, T-D09   **Plan tests:** -
- **Do:** Migration 0025: `add_opening_balance` (the `OB-` bill, `is_opening` receipts of the right kind, a rebalance so an advance and dues net off, an advance refused for the walk-in). T-F07 closes here because every number format now exists. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0025_opening_balance.sql, +supabase/tests/database/135_opening.test.sql
- **Done when:** Opening rows stay out of sales, daily cash and the cash limit; a wrong figure is fixed by cancelling and adding a new one.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB15 issue_refund (first to leave if the calendar slips)

- **Agent:** C   **PLAN.md task:** P2-T1   **Days:** 0.4   **Depends on:** DB13, DB16
- **Spec lines:** X11, Y10
- **Tests first written here:** T-B20   **Extends:** T-D09   **Plan tests:** -
- **Do:** Migration 0026: `issue_refund` under the customer lock, never above the advance, voidable by X4, money out in V3 and V4. Every money function follows the X0 prologue of spec section 10: it is created with `SET lock_timeout = '5s'` as a clause of `CREATE FUNCTION` (so the limit also covers the idempotency insert) and catches 55P03 to raise JV_BUSY; the idempotency insert comes first (L5), then the role check, the customer row lock, the call of `private.test_pause('<function>.after_read')` once the customer's state is read, and the number counter last. It is owned by the agent that first creates it, with its final signature from the first migration; another task changes it only through the private helper it calls.
- **Files:** +supabase/migrations/*_0026_refund.sql, +supabase/tests/database/140_refund.test.sql
- **Done when:** A refund above the advance is refused; voiding it restores the advance.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB17a Invariants I1 to I7, I10 and I13, with the mutation helper

- **Agent:** A   **PLAN.md task:** P1-T9 (part)   **Days:** 1.0   **Depends on:** DB16, DB09b
- **Spec lines:** I1, I2, I3, I4, I5, I6, I7, I9, I10, I13
- **Tests first written here:** -   **Extends:** T-B18   **Plan tests:** PT-I1 mutation half of T-B18: one damaged row per invariant
- **Do:** Migration 0027: `private.run_invariants()` (one query per invariant returning the offending rows, with I5 counting from `seed_value + 1` and I6 using the bill's pricing version and `fine_weight_due`; I10 includes the walk-in clause; I13 is the cash book tie-out against V4) and the mutation helper that damages exactly one row inside a rolled-back transaction (a constraint may be dropped inside it).
- **Files:** +supabase/migrations/*_0027_invariants.sql, +supabase/tests/database/160_invariants.test.sql
- **Done when:** With no damage the check returns nothing; each of I1 to I7, I10 and I13 is named when its row is damaged.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB17b Nightly job, review line, backup heartbeat and the dashboard summary function

- **Agent:** A   **PLAN.md task:** P1-T9 (part)   **Days:** 0.8   **Depends on:** DB17a, DB05
- **Spec lines:** I8, I11, I12
- **Tests first written here:** T-B18   **Extends:** T-B24, T-C05   **Plan tests:** -
- **Do:** Migration 0028: `private.nightly()` (invariants, the review counts of I11 including the walk-in's cash total and bill count, `fine_cash` rates away from the day's silver rate and sale-type changes, the idempotency clean-up of L6, one `check_runs` row), the owner-only function that returns the dashboard line (books, age of the last good dump and photo copy, review counts, red after 26 hours), and the schedule: `create extension pg_cron` and a job whose command is `begin isolation level repeatable read; select private.nightly(); commit;` (tested: the job then runs in one snapshot); the job's existence is asserted, never skipped silently.
- **Files:** +supabase/migrations/*_0028_nightly.sql, +supabase/tests/database/165_nightly.test.sql
- **Done when:** T-B18 passes in full: the nightly run writes `ok = false` with the details when a row is damaged; the dashboard function turns red after 26 hours without a good dump.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB18a Two-session interleavings with the test hook

- **Agent:** A   **PLAN.md task:** P2-T1, P2-T3 (prepared)   **Days:** 1.0   **Depends on:** DB14a, DB14b, DB15, DB12, DB17a
- **Spec lines:** X0, L5
- **Tests first written here:** T-C10, T-C11, T-C12, T-C13, T-C14   **Extends:** -   **Plan tests:** -
- **Do:** Vitest over two `pg` connections, using the test hook (`private.test_pause`, X0 item 8) so that each interleaving really happens and the same test fails when the customer lock is removed (`tests/db/hook.ts` mutates and restores the function): creating a bill beside a payment; two bills with one advance of 300; a void beside a payment; cancel and re-issue beside new work; two identical requests in flight. Each suite runs three times in a row before it counts.
- **Files:** +tests/db/concurrency.test.ts
- **Done when:** All five scenarios pass three times in a row, each fails without its lock, and `tests.assert_i10` holds after each.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB18c Lock timeout, role timeout and the stress run

- **Agent:** A   **PLAN.md task:** P2-T1, P2-T3 (prepared)   **Days:** 0.7   **Depends on:** DB18a
- **Spec lines:** S8
- **Tests first written here:** T-C15   **Extends:** -   **Plan tests:** -
- **Do:** A lock held for more than 5 seconds gives JV_BUSY and the retry with the same request id succeeds; a call past the role's 15-second timeout is cancelled (seen through `tests/db/rpc.ts`, a real login over HTTP, because `set role` does not show the role setting); a stress run of 8 sessions and 200 mixed calls over 3 customers (the walk-in among them) and 12 pieces with no deadlock (40P01) and I1 to I10 true.
- **Files:** +tests/db/timeouts_stress.test.ts
- **Done when:** The three scenarios pass three times in a row.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB18b Random sequences of operations and the function-by-role matrix

- **Agent:** C   **PLAN.md task:** P2-T1, P2-T3 (prepared)   **Days:** 1.2   **Depends on:** DB14a, DB14b, DB15, DB12, DB17a
- **Spec lines:** X13
- **Tests first written here:** T-B14, T-D09   **Extends:** -   **Plan tests:** -
- **Do:** A seeded driver that runs 200 random operations over all eleven writing functions, for three seeds, after which `run_invariants()` must be empty and the ledger balance must equal the customer balance; the full function-by-role matrix (T-D09, completing the rows added by each function task); the comments marking lint 0029 on every callable function.
- **Files:** +tests/db/random_sequences.test.ts, +supabase/tests/database/170_function_matrix.test.sql
- **Done when:** Both suites pass three times in a row (flaky timing is a finding); the matrix covers every function and role.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB19 Import and opening data script

- **Agent:** C   **PLAN.md task:** P3-T4 (data side)   **Days:** 1.2   **Depends on:** DB14b, DB17b, DB21a, PL03
- **Spec lines:** IM1, IM2, IM3, IM4, IM6, IM7, IM8
- **Tests first written here:** T-C16   **Extends:** -   **Plan tests:** -
- **Do:** `scripts/import/`: reads Siddhi's stock list and customer balances in the column layout agreed in PL03, one transaction per batch (under 20 seconds, ending with the re-stamp and `data_epoch` of C4), explicit numbers, `import_batches`, `private.seed_counters()`, mobile normalisation, a dry-run flag, a reconciliation printout, opening bills and advances through the same SQL as X12 and a call of `private.rebalance(customer)` for every customer given opening rows (the import runs as the database owner and cannot pass X12's role check; I10 must hold afterwards), a one-page runbook for the day Harsh runs it. First against local, then dev. Migration 0029 holds the helpers.
- **Files:** +scripts/import/import.mjs, +supabase/migrations/*_0029_import_helpers.sql, +supabase/tests/database/180_import.test.sql, +docs/import-runbook.md
- **Done when:** Counts and totals match the sample sheet; a code typed in either case finds the piece; new numbers continue after the imported ones and I5 stays green after an X12 call.
- **Rollback:** The import runs in one transaction per batch against local or dev: a failed batch rolls back; a wrong finished batch is undone by listing its rows through `import_batch_id` and cancelling them (opening rows by X5 and X4), or by wiping dev. Production is only ever imported after the reconciliation matches (IM8).

### DB20a Backup job: encrypted dump, photo mirror, heartbeat

- **Agent:** C   **PLAN.md task:** P1-T9   **Days:** 1.2   **Depends on:** DB05, PL02, DB21a
- **Spec lines:** B1, B2, B6, P5
- **Tests first written here:** T-R01   **Extends:** -   **Plan tests:** -
- **Do:** `scripts/backup/`: a full `supabase db dump` (roles, schema, data) over the session pooler string, encrypted with a public key (`age`) so the job never holds the decryption key, 30 daily and 12 monthly copies in R2, an incremental mirror of the photo bucket, bucket size and R2 usage in `backup_runs.detail`, one `backup_runs` row per step over its own connection; the scheduler chosen with Harsh in PL02 (recommended: a GitHub scheduled workflow, because a sleeping Mac is not a nightly job).
- **Files:** +scripts/backup/backup.mjs, +docs/backup.md
- **Done when:** The dump and the photo mirror exist in R2 and are readable; a failed run is visible in `backup_runs`.
- **Rollback:** Stop the scheduler entry and delete the R2 test objects the job wrote (the bucket is Harsh's, empty before the job). Nothing else depends on the job until DB20b.

### DB20b Restore drill 1 and the runbook

- **Agent:** C   **PLAN.md task:** P1-T9   **Days:** 0.7   **Depends on:** DB20a, DB17b, FE05, DB21a, PL01
- **Spec lines:** B4, B5
- **Tests first written here:** T-R02   **Extends:** -   **Plan tests:** -
- **Do:** Apply the migrations merged since DB21a to dev, load the sample data and 25 sample photos (uploaded through the Storage API with a test login), then drop the schemas and test users of the free dev project (B4) and restore the latest dump into it in the Supabase order, re-apply the migrations for the customisations, upload the photos from R2 through the Storage API, tick the runbook's settings list, run the nightly check, time it against the 2-hour limit. Write the 2-page runbook; a fresh agent that did not write it follows it (T-R02), and Harsh reads its one page.
- **Files:** +docs/runbook.md, +docs/restore-drill-1.md
- **Done when:** Row counts of our tables equal; `auth.users` and object counts equal; 20 photos open; settings list ticked; nightly check passes; under 2 hours.
- **Rollback:** The drill restores into the free dev project, which is wiped before and after; the real database is not touched. A failed drill is a finding, not a rollback.

### DB21a Dev project gets the migrations merged so far (early)

- **Agent:** C   **PLAN.md task:** P1-T4   **Days:** 0.3   **Depends on:** DB05, PL01
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** Take a dump, apply every migration merged so far to the free dev project (Supabase connector or CLI) so that the backup job (DB20a), the import's dev run (DB19) and the restore drill (DB20b) have a real source; check the free-project slot (two across all organisations) first. Test logins on dev are created by Harsh; Claude creates no accounts.
- **Files:** +docs/platform-checks.md
- **Done when:** The dev project has the merged schema; the early advisor run on it is clean.
- **Rollback:** Local: `git revert` the task's commit, then `npm run db:reset` rebuilds the lane's database from the remaining migrations. Cloud dev and production are never touched by this task; migrations are forward-only, so a bad one that reached dev is fixed by a new migration or by restoring the dump taken before the apply (DB21).

### DB21 Platform checks on the cloud dev project

- **Agent:** C   **PLAN.md task:** P1-T4 (advisors), P1-T9   **Days:** 0.6   **Depends on:** DB18b, DB21a, PL01, PL02, FE06
- **Spec lines:** A7, U9
- **Tests first written here:** -   **Extends:** T-D11, T-D12, T-D17   **Plan tests:** -
- **Do:** Take a dump, apply every merged migration not yet applied to the free dev project (Supabase connector or CLI), then check what only the hosted platform shows: the advisor for lints 0028 and 0029, the Auth password settings and leaked-password protection, the `pg_cron` zone, the storage limits, the hosted `max_rows`, `auto_expose_new_tables`, an introspection query as anon over the real API, and a first preview deployment of the static site on Cloudflare, whose `curl -I` is the header half of T-D12. The orchestrator writes the answers into the spec's research table. Test logins on dev are created by Harsh; Claude creates no accounts.
- **Files:** +docs/platform-checks.md
- **Done when:** The hosted advisor shows no ERROR, no 0011, no 0028, and 0029 only on the named functions; open items (a) to (g) of spec section 0 are answered or re-scheduled.
- **Rollback:** Dev project: restore the dump taken at the start of the task (the project holds test data only). Cloudflare preview: delete the preview deployment. Production is not touched.

### FE01 Integer pricing copy and the shared selectors

- **Agent:** B   **PLAN.md task:** P2-T1/P2-T2   **Days:** 1.0   **Depends on:** -
- **Spec lines:** C12
- **Tests first written here:** -   **Extends:** T-A02, T-A03, T-A14   **Plan tests:** PT-F1 unit tests of pricing.ts and selectors.ts
- **Do:** `src/lib/pricing.ts` (money in paise, weight in milligrams, BigInt for products so 100,000 g times a rate of 100,000,000 cannot overflow) and `src/lib/selectors.ts` (sales, outstanding, evening figures, customer card, one function per figure) with unit tests, including the screen-side labour-rate defaults of R1 (Wholesale and Semi-Wholesale chains: the UNIT half of T-A02 and T-A03). The parity test against the database runs in DB08.
- **Files:** +src/lib/pricing.ts, +src/lib/selectors.ts, +tests/unit/pricing.test.ts, +tests/unit/selectors.test.ts
- **Done when:** The unit tests pass on the worked example and on edge values (cap, half-paise, zero).
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE02 Supabase client, session gate, login and roles

- **Agent:** B   **PLAN.md task:** P1-T5   **Days:** 1.4   **Depends on:** DB02
- **Spec lines:** U1, U4, U5, U6, U7, U8, U10, C16, A9
- **Tests first written here:** T-E08   **Extends:** T-D06, T-E01   **Plan tests:** -
- **Do:** `src/lib/supabase/client.ts` (URL and publishable key only), `useSession`, one module-level gate (loading, login, app) in `AppLayout.tsx`, `LoginScreen.tsx` with no hint, role-based routes and menus, the 12-hour idle logout, logout that empties memory and stops pollers, the hard-coded logins removed from `authStore.ts`. First use of Playwright: its Chromium (`npx playwright install chromium`, about 170 MB) is installed, and the global setup creates the three test logins through the local Auth admin API and activates them (no password in committed SQL). The E2E half of T-D06 (`updateUser` with a role) runs here.
- **Files:** +src/lib/supabase/client.ts, src/lib/authStore.ts, src/components/AppLayout.tsx, src/components/LoginScreen.tsx, src/app/layout.tsx, src/app/page.tsx, +tests/e2e/global-setup.ts, +tests/e2e/login.spec.ts
- **Done when:** A login per role works; 20 login and logout cycles do not hang; the Owner sees the rate card right after login; `admin123` is gone from `out/`.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE03 Hydrate the stock side behind the loading gate

- **Agent:** B   **PLAN.md task:** P1-T6 (part)   **Days:** 1.0   **Depends on:** FE02, DB03, DB05
- **Spec lines:** C1, C2, C8, C9, C10
- **Tests first written here:** T-E05   **Extends:** T-E01   **Plan tests:** PT-F3 stock hydrate pages 2,500 pieces
- **Do:** The stores keep their exports and read from memory; hydrate of stock, settings, categories, rates and profiles in pages of 1,000 by primary key, each next page starting after the rows already received, until an empty page, with progress and an error state with retry; no business data in browser storage; no sample-data fallback. Money tables come in FE04b.
- **Files:** src/lib/designStore.ts, src/lib/settingsStore.ts, src/lib/catalogStore.ts, +src/lib/cache/hydrate.ts, +tests/e2e/hydrate.spec.ts
- **Done when:** 2,500 pieces load; a failed load shows an error, never sample data; browser storage holds only the Auth session.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE04 Polling, merging, offline banner and ordinary edits (stock side)

- **Agent:** B   **PLAN.md task:** P1-T6 (part)   **Days:** 1.2   **Depends on:** FE03, DB05
- **Spec lines:** C4, C5, C6, C7, C18
- **Tests first written here:** T-E01, T-E03   **Extends:** T-E05   **Plan tests:** PT-F4 two browsers see a stock change within 10 seconds
- **Do:** Cursors by (`updated_at`, `id`) kept as exact text, 30-second overlap, keyset pages, cursor moved only after a complete poll, 8-second and 30-second hidden-tab cadence, merge by `id`, the `data_epoch` re-hydrate; pending rows ignore polled copies; ordinary edits send only changed fields with the stale check; offline banner with back-off; each poll reads the user's own profile row and logs out on a change.
- **Files:** +src/lib/cache/poll.ts, +src/lib/cache/writes.ts, +src/components/OfflineBanner.tsx, +tests/e2e/two-browsers.spec.ts
- **Done when:** A change on one browser shows on the other within 10 seconds; a user deactivated while signed in is logged out at the next poll.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE04b Money side of the cache: customers, bills, receipts and the views

- **Agent:** B   **PLAN.md task:** P1-T6 (part), P2-T2   **Days:** 0.8   **Depends on:** FE04, DB16, DB10b
- **Spec lines:** C3, C17
- **Tests first written here:** T-E02, T-E07, T-F03   **Extends:** -   **Plan tests:** -
- **Do:** Hydrate and poll customers, `bill_summary`, `bill_items`, receipts, allocations and `customer_balances` per role; the ledger loaded per customer; the money re-read after any write (C17). The 20-second slow writer, the 40-second import procedure (re-stamp, then `data_epoch`), the 1,500-row poll and a server `max_rows` of 500 run here (the cancel-an-unpaid-bill case is PT-F9b in FE09); timing tests run on the static `out/`, not on `next dev` (this task owns the Playwright project for it: build with the lane's environment, serve `out/`, wait for it).
- **Files:** src/lib/appStore.ts, +src/lib/cache/money.ts, +tests/e2e/polling.spec.ts, +playwright.static.config.ts
- **Done when:** A payment on one browser changes the pending on the other; the first hydrate of the M1 volumes is under 10 seconds on the static build.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE05 Stock functions and photos from the screens

- **Agent:** B   **PLAN.md task:** P1-T6/P1-T7   **Days:** 1.0   **Depends on:** FE04, DB06, DB07
- **Spec lines:** P2
- **Tests first written here:** -   **Extends:** T-D21   **Plan tests:** PT-F5 Add Design with photos end to end; staff has no original-weight field
- **Do:** Add Design and Edit Stock call `create_design` and `set_sku_status`; the screen makes the design id, resizes to 1200 px and a 320 px thumbnail, uploads, then saves only paths; no number is shown before saving.
- **Files:** src/app/add-design/components, src/app/edit-stock/components, +src/lib/photos.ts, +tests/e2e/stock.spec.ts
- **Done when:** A design with photos is created end to end; a 5 MB file and a non-image are refused by the real bucket.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE06 Hosting headers and build checks

- **Agent:** C   **PLAN.md task:** P1-T8   **Days:** 0.7   **Depends on:** DB01, FE02, FE03
- **Spec lines:** H1, H2, H3, H4
- **Tests first written here:** T-D12   **Extends:** -   **Plan tests:** -
- **Do:** `public/_headers` (HSTS, nosniff, referrer policy, frame ban, permissions policy, CSP in report-only first), `scripts/check-build.mjs` that fails on `sb_secret_`, `service_role`, `postgres://`, `admin123`, `staff123`, any `.map` file, `dangerouslySetInnerHTML` or `innerHTML` in `src/`, or an `api.max_rows` other than 1000 in the config. The Cloudflare preview is deployed in DB21 (it needs PL02).
- **Files:** +public/_headers, +scripts/check-build.mjs, package.json
- **Done when:** The check fails when a forbidden string is planted and passes on the clean static build (the hard-coded logins went in FE02).
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE07a Billing screen on create_bill, with customer creation

- **Agent:** B   **PLAN.md task:** P2-T2   **Days:** 1.2   **Depends on:** FE04b, FE01, DB11, DB09a
- **Spec lines:** L4, R9
- **Tests first written here:** T-E06   **Extends:** T-A03   **Plan tests:** -
- **Do:** The billing screen calls `create_customer` and `create_bill` with a fresh request id, shows a saving state, never marks a piece Sold before the answer, shows "Number assigned when saved", `PAN_MISSING` (and saves the PAN on the customer), `RATE_MISSING`, `RATE_STALE` and "Advance adjusted"; live totals from `pricing.ts`; one automatic retry of JV_BUSY or a deadlock with the same request id.
- **Files:** src/app/billing-pos/components/BillingPOSClient.tsx, src/app/billing-pos/components/BillingSummaryPanel.tsx, src/app/billing-pos/components/BillingItemsTable.tsx, src/app/billing-pos/components/CustomerSearchPanel.tsx, src/lib/appStore.ts
- **Done when:** The saved figures equal the live preview on the worked example; a double click and a dropped response with a retry both create one bill.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE07b Payment and silver-fine panels

- **Agent:** B   **PLAN.md task:** P2-T2   **Days:** 0.9   **Depends on:** FE07a, DB12, DB10b
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** PT-F7 receive payment, advance shown, settle fine in silver and in cash
- **Do:** Receive payment (named bill or oldest first, the advance shown) and settle fine, both through the functions with the same retry rule and the cash-limit message with the owner's reason box.
- **Files:** src/app/customer-ledger/components
- **Done when:** A payment and a fine settlement made on the screen match the database; a biller at the cash limit sees the message and cannot pass.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE08 Estimate view and the customer ledger

- **Agent:** B   **PLAN.md task:** P2-T2   **Days:** 0.8   **Depends on:** FE07b, DB16
- **Spec lines:** K5
- **Tests first written here:** -   **Extends:** -   **Plan tests:** PT-F8 customer card, saved estimates and ledger agree on the same data
- **Do:** The read-only estimate view without the date editor and edit mode, and the customer ledger from `customer_ledger` loaded per customer, with the walk-in's dues in the totals.
- **Files:** src/app/estimate/components, src/app/customer-ledger/components
- **Done when:** The ledger's last balance equals the customer card; a bill cannot be edited or re-dated on screen.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE09 Cancel, re-issue, void, refund and opening-balance screens; the error map

- **Agent:** B   **PLAN.md task:** P2-T2   **Days:** 1.2   **Depends on:** FE08, DB13, DB14a, DB14b, DB15
- **Spec lines:** C13
- **Tests first written here:** -   **Extends:** T-E04, T-E07   **Plan tests:** PT-F9 owner actions work end to end and a biller sees none; PT-F9b cancelling an unpaid bill changes the other browser's outstanding within 10 seconds; PT-U9 the error map covers every JV_ code (unit)
- **Do:** Owner-only actions with a reason box, the re-issue flow that opens the corrected bill with the old lines, the refund and the opening-balance forms, and one table that maps each JV_ code to a plain message.
- **Files:** src/app/estimate/components, src/app/customer-ledger/components, +src/lib/errors.ts, +tests/e2e/owner-actions.spec.ts, +tests/unit/errors.test.ts
- **Done when:** Each owner action works end to end on the local stack; a biller does not see them.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE10a The owner's dashboard line and the shared selectors on dashboard, reports and customer card

- **Agent:** B   **PLAN.md task:** P2-T2, P1-T9 (part)   **Days:** 0.9   **Depends on:** FE04b, DB17b, FE01, DB20a
- **Spec lines:** C14, V5
- **Tests first written here:** T-R03   **Extends:** T-B15, T-E04   **Plan tests:** -
- **Do:** The owner's dashboard line (books OK at 02:00, age of the last good dump and photo copy, yesterday's review counts, red after 26 hours) from the dashboard function of DB17b; the dashboard, `ReportsClient.tsx` and the customer card read their figures through `selectors.ts` instead of the inline filters in `appStore.ts`; the Reports date controls and export buttons are hidden in M1 (O32).
- **Files:** src/app/page.tsx, src/app/components, src/app/customer-ledger/components, src/app/reports/components, src/lib/appStore.ts, +tests/unit/dashboard-line.test.ts
- **Done when:** Dashboard, reports and customer card give the same figure for the same data; the line turns red in the test when the clock is moved 26 hours.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE10b Daily rate entry (owner and biller)

- **Agent:** B   **PLAN.md task:** P3-T2 (write path only)   **Days:** 0.5   **Depends on:** FE04, DB03
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** PT-F10 a rate for today can be entered; yesterday's cannot by a biller
- **Do:** The daily rate card writes `daily_rates` rows through the ordinary-edit path (a biller dated today only, the owner today or earlier), so the rate warnings of the billing screen have data. The rate card by purity and the stale-rate guard stay in P3-T2.
- **Files:** src/app/components, src/lib/settingsStore.ts
- **Done when:** A rate entered on the screen is saved and read back; that it is the default on the next bill is checked in FE07a.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### FE11 Download everything, and hiding what is not ready

- **Agent:** B   **PLAN.md task:** P3-T3 (part), P1-T9 (part)   **Days:** 0.8   **Depends on:** FE09
- **Spec lines:** B3, C15, S7
- **Tests first written here:** T-E04   **Extends:** -   **Plan tests:** -
- **Do:** The owner's button that builds one zip of CSV files from the cache with formula-safe cells; Order Book, the public catalogue, the sample Audit and Sales tabs and the estimate edit mode are not reachable; the "Reset Defaults" and "Delete All Inventory" buttons are removed (nobody deletes, S7); Settings' Users tab becomes a read-only list of `profiles` with a note that Harsh makes changes (D3, U3, QA SEC-04); `getInvoices()` keeps its shape.
- **Files:** src/app/settings/components, src/lib/exportUtils.ts, +tests/e2e/hidden.spec.ts
- **Done when:** The zip opens and holds the six files; a cell that starts with `=` is written as text; the hidden routes return the not-found page.
- **Rollback:** `git revert` the task's commit; the static site has no data of its own. A bad deployment is rolled back by redeploying the previous Cloudflare build (DB21 records how).

### RV1 Implementation review 1: access and security (fresh agent)

- **Agent:** C   **PLAN.md task:** P1-T10   **Days:** 0.5   **Depends on:** DB04, DB05, DB06, DB07, FE02, FE06
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** A fresh reviewer reads the diff against the spec, re-runs all D tests that exist by then, breaks one policy on purpose and expects a failure, and checks that no secret, source map or hard-coded login is in the repo or the build.
- **Files:** +specs/p1-foundation-and-money/impl-review-1.md
- **Done when:** No finding open (Playbook 4). Gate G-A.
- **Rollback:** Nothing to roll back (a review only reads).

### RV2 Implementation review 2: the money core, with a mutation check (fresh agent)

- **Agent:** A   **PLAN.md task:** P2-T3   **Days:** 1.0   **Depends on:** DB18b, DB18c
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** A fresh reviewer breaks one money rule at a time (each lock, the rebalance, a view formula, an invariant, each cap) and expects a test to fail; re-runs the access tests; reads the diff against sections 8 to 13.
- **Files:** +specs/p1-foundation-and-money/impl-review-2.md
- **Done when:** No finding open. Gate G-M (gate G4 of PLAN.md).
- **Rollback:** Nothing to roll back (a review only reads).

### RV3 Implementation review 3: end to end (fresh agent)

- **Agent:** A   **PLAN.md task:** P2-T3   **Days:** 0.5   **Depends on:** FE11, FE10a, FE10b, DB21, RV2, DB20b
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** A fresh reviewer runs the whole suite on the static build, one real billing day by hand (bill, part payment, fine, void, cancel, re-issue, refund) and reads the restore drill log.
- **Files:** +specs/p1-foundation-and-money/impl-review-3.md
- **Done when:** No finding open. Gate G-E; the phase may close.
- **Rollback:** Nothing to roll back (a review only reads).

### CL Close-out: stop the stacks, remove worktrees and branches that are merged, update the README and the ledger

- **Agent:** A   **PLAN.md task:** -   **Days:** 0.2   **Depends on:** RV3
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** Stop every lane stack with `db:stop --no-backup`, remove the merged worktrees and branches only after Harsh agrees, record the final commit ready to push.
- **Files:** README.md, +SDD-ledger.md
- **Done when:** Docker holds no JewelVault volume and no stale worktree; the ledger has the phase's last row.
- **Rollback:** Nothing to roll back; worktrees and branches are removed only after RV3 and Harsh's say-so.

### PL01 Harsh: Supabase decisions (free dev project, organisations, access path)

- **Agent:** Harsh   **PLAN.md task:** P0-T3   **Days:** 0.2   **Depends on:** -
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** Say yes to a free `jewelvault-dev` project in his existing free organisation (it also serves as the restore-drill target; Claude creates it only after he confirms the cost line); check that the free-project slot is available (two across all organisations); agree that production lives in its own Pro organisation, owned by him until Siddhi takes it over (Supabase bills per organisation, so a free project inside the Pro organisation would cost about US$10 a month); create three test logins on dev in the dashboard; say how Claude reaches dev (the Supabase connector he already authorised, or an access token and the database password kept in his password manager, never in chat).
- **Files:** -
- **Done when:** The project exists and Claude can apply migrations to it.
- **Rollback:** Nothing to roll back.

### PL02 Harsh: Cloudflare R2 bucket and keys, a private GitHub repository, the backup scheduler

- **Agent:** Harsh   **PLAN.md task:** P0-T3   **Days:** 0.4   **Depends on:** -
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** Create the Cloudflare account and an R2 bucket with keys, and a private GitHub repository for the scheduled backup workflow (recommended: a GitHub scheduled workflow with the Supabase session-pooler string and `age` encryption, the private key held by Harsh and by the owner separately); keys stay in his password manager. Name who owns each account.
- **Files:** -
- **Done when:** A test object can be written to and read from the bucket.
- **Rollback:** Nothing to roll back.

### PL03 Harsh and Siddhi: business answers, her data, devices, a runbook tester

- **Agent:** Harsh   **PLAN.md task:** P0-T1, P0-T5   **Days:** 0.4   **Depends on:** -
- **Spec lines:** H6
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** Answer the open items that change code (O1, O2, O9, O12, O14, O22, O23, O24, O32); send the data request and agree the column layout of her stock and balance sheets; name the testers and the days they are free in the week of Dhanteras, Diwali and Bhai Dooj; list the counter devices and browsers (Chrome 111 or newer); accept that a fresh agent follows the runbook for T-R02 while he reads its one page.
- **Files:** -
- **Done when:** Each answer is written in the ledger with the date; defaults stand until then.
- **Rollback:** Nothing to roll back.

### PL04 Harsh, at go-live: the production database password for one session, and his go

- **Agent:** Harsh   **PLAN.md task:** P3-T8   **Days:** 0.1   **Depends on:** -
- **Spec lines:** -
- **Tests first written here:** -   **Extends:** -   **Plan tests:** -
- **Do:** Before the first production apply Harsh gives Claude the production database password through his password manager for one session (never in chat, never stored), says go after RV2 and a fresh dump, and creates the production organisation and project.
- **Files:** -
- **Done when:** Production has the schema and no test data; the password is not written anywhere.
- **Rollback:** Nothing to roll back.

