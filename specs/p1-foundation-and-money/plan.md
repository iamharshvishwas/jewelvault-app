# Plan: P1 foundation and money (the JewelVault backend)

Status: **DRAFT 3**, written on Wednesday 14 October 2026 against `spec.md` (785 lines). Draft 1 was reviewed by a fresh agent (`plan-review.md`: 0 Critical, 5 High, 12 Medium, 6 Low, verdict pass with fixes); draft 2 answered every finding (section 11) and its changed lines were re-checked (`plan-review-2.md`: 0 Critical, 1 High, 7 Medium, 4 Low, pass with fixes); this draft answers those (section 11.1). Tasks, tests and the checks are generated from `_build/p1-plan/plan_data.py`, so this file and `tasks.md` cannot drift from the spec.
Maps to: `PLAN.md` tasks P1-T4 to P1-T10, P2-T1 to P2-T3 and the data side of P3-T4. Not in this plan: the printed estimate and the print shell (P3-T1), the rate card by purity and the stale-rate guard (P3-T2), regression, acceptance, training and drills (P3-T5 to P3-T8), and everything in M2.

## 1. Design: the simplest approach that meets the spec

- **Database first.** Every money, stock and access rule is SQL: constraints, row-level security, and eleven writing functions plus one read-only function (spec section 10). The screens call those functions and read through the cache of spec section 5. This is the order Harsh asked for ("pehle Backend"): DB01 to DB05 need nothing from anyone but a green light.
- **Forward-only migrations**, one concern per file. Section 2 gives the *expected* order; the real file version is a timestamp made by `supabase migration new` in the order the orchestrator merges them, because the CLI refuses a lower version after a higher one has been applied. A later change to a function is a new file that replaces it (`create or replace function`).
- **Test tools.** pgTAP (`supabase test db`) for single-session database tests, each inside a transaction that is rolled back; Vitest over two `pg` connections for the two-session tests (locks, concurrency, parity with `pricing.ts`); Playwright for browser tests; small scripts for BUILD checks; written drill logs for DRILL tests. **Every test is written first and seen failing for the right reason** (Playbook 3.3). Where the spec has no test ID for a screen, the plan adds a named plan test (`PT-...`) so the rule still holds.
- **Local first, one stack per agent.** The database tests run on the local Supabase stack in Docker (Supabase CLI pinned to one exact version, Postgres 17.11). `scripts/lane.mjs` gives each agent its own never-committed stack (project id and port block per lane, main 443xx, a 453xx, b 463xx, c 473xx: valid ports below the 49152 dynamic range) because two stacks with the same ports cannot run together and Harsh's other project already uses 543xx. The database tests and the browser tests run serially inside a lane. The free cloud dev project is used only for what needs the real platform (DB20b, DB21).
- **Three agents at most at once.** Agent A (the database, in order), agent B (the front end, and the pricing functions DB08 while it waits for the stock tables), agent C (side tasks and the three reviews; every review is a fresh invocation, never the author). Each agent works in its own `git worktree` of `Client/jewelvault-app` on its own branch (`p1-db`, `p1-fe`, `p1-side`); only the orchestrator merges to `main`, locally, renumbers migration versions, regenerates the lockfile and edits the spec and the ledger. Nothing is pushed or pulled. `npm run verify` is the gate before anything is called ready to push.
- **One owner per function.** A public money function is edited only by the agent that first creates it, with its final signature from its first migration (parameters that a later task activates are accepted and inert until then; adding a parameter later would create an overload that PostgREST refuses). What a later task adds, it adds in a private helper that the public function already calls (`private.apply_payments`, `private.cash_rules_check`, `private.rebalance(customer, first_bill)`), so two agents never `create or replace` the same function. A bug found in another agent's function goes to the orchestrator, who sends it to the owner. `npm run verify` after every merge is the net.
- **One local commit per task.** Message: what changed, the spec IDs it covers, the QA IDs it closes. After each commit the orchestrator says which branch and commit are ready for Harsh to push.
- **Applying to the cloud.** Dev (free project in Harsh's existing free organisation, test data only, also the restore-drill target): at DB20b and DB21, with a dump taken first. Production (its own Pro organisation): only after the money gate (RV2), a fresh dump and Harsh's explicit go; credentials come from his password manager and are never pasted in chat. Claude creates no account anywhere.

### 1.1 What the spikes of 14 October showed (local Supabase, CLI 2.120, Postgres 17.11, in scratch folders; the plan and spec reviewers ran more)

These are facts the harness and the migrations rely on; each was run, not read. The scratch scripts are not in the repository.

| Fact | Result |
|---|---|
| Starting | `supabase start` with the unneeded services excluded took 421 seconds the first time (newer images) and 32 to 59 seconds after; five services use about 350 MB; `supabase test db` runs pgTAP in 2 to 13 seconds; `db reset` took 43 seconds. Two stacks on the same ports cannot run together. |
| The role and user of a test | `set local role authenticated` plus `set_config('request.jwt.claims', '{"sub":"<uuid>","role":"authenticated"}', true)` makes `auth.uid()` return the uuid. A bare `auth.users` row works for pgTAP but the local Auth service cannot log such a user in (its token columns must be set); end-to-end logins are created through the Auth admin API. |
| Default privileges (why spec A3 is needed) | A new function in `public` is executable by `anon` and `authenticated`, a new table is selectable by both with row-level security off. The four statements on the securing-your-api page (all `in schema public`) fix tables and sequences but **not functions**; only `alter default privileges for role postgres revoke execute on functions from public` (global form) does, and existing functions must be revoked from `public` too. |
| A `CHECK` that calls a private function | Every `UPDATE` of that row by a role that may not execute the function fails with "permission denied for function", even for another column. So the caps are literals in the `CHECK`s. |
| Timeouts | `set local lock_timeout` inside a function works; `set local statement_timeout` inside a function does not shorten the call already running. The platform's role settings are 3 seconds for `anon` and 8 seconds for `authenticated`; we set 15 seconds for `authenticated`. |
| Schema `private` | Without `grant usage` the signed-in role gets "permission denied for schema private"; with usage but after `revoke ... from public` on the function it gets "permission denied for function". |
| `pg_cron` | `create extension pg_cron` works; `cron.timezone` is GMT, so `30 20 * * *` is 02:00 in Asia/Kolkata; a job whose command is `begin isolation level repeatable read; ...; commit;` runs in one snapshot. The hosted project is checked in DB21. |
| Advisor | `supabase db advisors --local --fail-on error` runs in about a second and exits 1 on an RLS-off table; it did not report lints 0028 and 0029, so a grant assertion covers them locally and the hosted advisor in DB21. |
| Other | `pg_graphql` is not installed locally; a bucket row can be inserted into `storage.buckets`; a `customer_id` filter is applied before the window sums of a ledger view; `clock_timestamp()` differs inside one transaction and `now()` does not; `round()` is half away from zero; a profile trigger with a fallback name creates a profile for a login made without metadata; `supabase stop --no-backup` leaves the Docker volume count unchanged. |


## 2. Data model and rules

The tables, columns, checks and access rules are those of spec sections 2 and 3; the functions are those of sections 8 to 13. They are not repeated here. This is the **expected** order in which they reach the database (the file version is a timestamp set at merge time):

| Migration (expected order) | Concern | Task | Spec |
|---|---|---|---|
| 0001_privileges_schemas | schema `private`; default privileges (global form for functions); the event trigger for row-level security; the role's `statement_timeout` | DB02 | A1 A3 S1 A11 |
| 0002_profiles_roles | `profiles`, `private.app_role()`, new-user trigger, own-role trigger, `activate_user` | DB02 | D1 D2 A8 A10 U3 |
| 0003_common_triggers | `set_updated_at`, forced person columns, `jv_error`, `today()`, `now_ts()`, `import_batches`, `limits` | DB02 | S5 S6 D22 S8 D18 |
| 0004_reference_tables | `settings`, `daily_rates`, `categories`, `subcategories` | DB03 | D3 D4 D5 |
| 0005_stock_tables | `designs`, `skus`, `sku_private`, their checks and weight rules | DB03 | D6 D7 D8 D9 |
| 0006_stock_policies | policies and column grants for 0004 and 0005 | DB03 | A4 A5 |
| 0007_money_tables | `customers`, `bills`, `bill_items`, `receipts`, `receipt_allocations`; the foreign keys back to `skus` and `import_batches` | DB04 | D10 to D15 D21 |
| 0008_money_policies | read-only policies, customer update grants, archive guards | DB04 | A4 A5 K4 K5 S7 |
| 0009_private_tables | `counters`, `idempotency` | DB05 | D18 |
| 0010_audit_touch | `audit_log` and triggers, touch triggers, `check_runs`, `backup_runs`, indexes | DB05 | D16 D17 D19 D23 L1 L2 |
| 0011_numbering_helpers | `next_number`, number formats, idempotency helpers | DB05 | L3 L4 L5 |
| 0012_seeds | `seed_defaults()`: settings keys, categories, the walk-in customer | DB05 | D20 |
| 0013_stock_functions | `create_design`, `set_sku_status` | DB06 | X8 X9 |
| 0014_photo_storage | bucket and storage policies | DB07 | P1 P3 |
| 0015_pricing | `price_line`, `price_bill`, rates, list prices, `quote_bill` | DB08 | R1 to R14 X7 |
| 0016_write_prologue_customer | write prologue helpers, `create_customer` | DB09a | X6 |
| 0017_create_bill | `create_bill_core`, `create_bill` without payments | DB09b | X1 |
| 0018_rebalance | `rebalance` for money and silver | DB10a | Y3 Y6 Y9 |
| 0019_record_payment | `record_payment` | DB10b | X2 |
| 0020_views | `bill_summary`, `customer_balances`, `customer_ledger`, `daily_totals` (tables only, so they can come early) | DB16 | V1 to V4 |
| 0021_cash_rules_bill_payments | `create or replace` of `apply_payments` and `cash_rules_check` (the private helpers the public functions already call) | DB11 | Z1 to Z4 |
| 0022_settle_fine | `settle_fine` | DB12 | X3 |
| 0023_void_cancel | `void_receipt`, `cancel_bill` | DB13 | X4 X5 |
| 0024_reissue | `reissue_bill` | DB14a | X10 |
| 0025_opening_balance | `add_opening_balance` | DB14b | X12 |
| 0026_refund | `issue_refund` | DB15 | X11 |
| 0027_invariants | `run_invariants` | DB17a | I1 to I7 I10 |
| 0028_nightly | `nightly`, dashboard function, guarded `pg_cron` schedule | DB17b | I8 I11 I12 |
| 0029_import_helpers | `seed_counters` and the import helpers | DB19 | IM1 to IM4 |

Forward references are removed on purpose: `private.import_batches`, `today()`, `now_ts()` and the profile triggers are made in 0003; `skus.sold_bill_id` and the `import_batch_id` keys are added in 0007 when their targets exist; the caps are literals in the `CHECK`s of 0005 and 0007 and are compared with `private.limits` (0009) by T-F02. A lane that merges `main` runs `npm run db:reset`. Seeds on an empty project are the rows of D20 only, made by `private.seed_defaults()`. `supabase/seeds/` is **local only** (guard, test helpers) and refuses to run on a stack whose JWT secret is not the published local default; test logins for the browser tests are created through the Auth admin API, never in committed SQL.

## 3. Tests

The spec defines 103 tests (section 15). A test is **introduced** in the task where everything it exercises exists (the generator checks this against the dependency graph); a task that **extends** it writes a part of it, before or after the introducing task (for example every function task adds its row to T-D09, and T-E01 is written in FE02 and FE03 and completed in FE04); clauses that a later task owns are listed in `plan_data.py` and checked; a catalogue-based test (T-D01, T-D10, T-D15) is written once and covers every table or function added after it. The plan adds named plan tests (`PT-...`) where the spec has none.

| Task | Title | Tests introduced | Extends | Plan tests |
|---|---|---|---|---|
| DB01 | Test harness: per-agent local stacks, helpers, fixtures, one verify command | T-F04 | - | PT-H1 harness smoke (pgTAP and two-connection) |
| DB02 | Privileges, schemas, profiles and roles | T-D01, T-D02, T-D06, T-D10, T-D11, T-D13, T-D15, T-D16, T-D17, T-D20, T-E09 | - | - |
| DB03 | Reference and stock tables with their access rules | T-C07, T-D05, T-D19, T-D22, T-F02, T-F05 | - | - |
| DB04 | Customers, bills, receipts and allocations: tables and access rules | T-B01, T-B06, T-C02, T-D07, T-D08 | T-F02 | - |
| DB05 | Counters, idempotency, audit, touch triggers, seeds | T-D04, T-D14 | T-F02, T-D03 | - |
| DB06 | Stock functions: create_design and set_sku_status | T-A02, T-C03, T-C17, T-F01 | T-C08, T-D09 | - |
| DB07 | Photo storage: bucket and policies | T-D21 | - | - |
| DB08 | Pricing functions, quote_bill and the parity test | T-A01, T-A04, T-A05, T-A07, T-A08, T-A09, T-A10, T-A11, T-A13, T-A14, T-A16, T-A18, T-A19 | - | - |
| DB09a | The write prologue and create_customer | T-F06 | T-D09 | - |
| DB09b | create_bill core without payments (private.create_bill_core) | T-A03, T-A06, T-A15, T-A17, T-B16, T-B24, T-C01, T-C04, T-C05, T-C06, T-C08, T-D03 | T-A10, T-D09 | - |
| DB10a | private.rebalance for money and silver | T-B26 | - | - |
| DB10b | record_payment | T-B04, T-B05, T-B22, T-C09 | T-B01, T-B06, T-B17, T-D09 | - |
| DB16 | Views V1 to V4 | T-B02, T-B15, T-B17, T-D18 | T-B05 | - |
| DB11 | Cash limit and PAN rules, and the payment rows of a bill (the private helpers only) | T-A12, T-B03, T-B07 | T-B01 | - |
| DB12 | settle_fine | T-B11, T-B12, T-B13, T-B23 | T-D09 | - |
| DB13 | void_receipt and cancel_bill | T-B08, T-B09, T-B10 | T-B17, T-D09 | - |
| DB14a | reissue_bill | T-B19, T-B25 | T-B17, T-D09 | - |
| DB14b | add_opening_balance | T-B21, T-F07 | T-B17, T-D09 | - |
| DB15 | issue_refund (first to leave if the calendar slips) | T-B20 | T-D09 | - |
| DB17a | Invariants I1 to I7, I10 and I13, with the mutation helper | - | T-B18 | PT-I1 mutation half of T-B18: one damaged row per invariant |
| DB17b | Nightly job, review line, backup heartbeat and the dashboard summary function | T-B18 | T-B24, T-C05 | - |
| DB18a | Two-session interleavings with the test hook | T-C10, T-C11, T-C12, T-C13, T-C14 | - | - |
| DB18c | Lock timeout, role timeout and the stress run | T-C15 | - | - |
| DB18b | Random sequences of operations and the function-by-role matrix | T-B14, T-D09 | - | - |
| DB19 | Import and opening data script | T-C16 | - | - |
| DB20a | Backup job: encrypted dump, photo mirror, heartbeat | T-R01 | - | - |
| DB20b | Restore drill 1 and the runbook | T-R02 | - | - |
| DB21 | Platform checks on the cloud dev project | - | T-D11, T-D12, T-D17 | - |
| FE01 | Integer pricing copy and the shared selectors | - | T-A02, T-A03, T-A14 | PT-F1 unit tests of pricing.ts and selectors.ts |
| FE02 | Supabase client, session gate, login and roles | T-E08 | T-D06, T-E01 | - |
| FE03 | Hydrate the stock side behind the loading gate | T-E05 | T-E01 | PT-F3 stock hydrate pages 2,500 pieces |
| FE04 | Polling, merging, offline banner and ordinary edits (stock side) | T-E01, T-E03 | T-E05 | PT-F4 two browsers see a stock change within 10 seconds |
| FE04b | Money side of the cache: customers, bills, receipts and the views | T-E02, T-E07, T-F03 | - | - |
| FE05 | Stock functions and photos from the screens | - | T-D21 | PT-F5 Add Design with photos end to end; staff has no original-weight field |
| FE06 | Hosting headers and build checks | T-D12 | - | - |
| FE07a | Billing screen on create_bill, with customer creation | T-E06 | T-A03 | - |
| FE07b | Payment and silver-fine panels | - | - | PT-F7 receive payment, advance shown, settle fine in silver and in cash |
| FE08 | Estimate view and the customer ledger | - | - | PT-F8 customer card, saved estimates and ledger agree on the same data |
| FE09 | Cancel, re-issue, void, refund and opening-balance screens; the error map | - | T-E04, T-E07 | PT-F9 owner actions work end to end and a biller sees none; PT-F9b cancelling an unpaid bill changes the other browser's outstanding within 10 seconds; PT-U9 the error map covers every JV_ code (unit) |
| FE10a | The owner's dashboard line and the shared selectors on dashboard, reports and customer card | T-R03 | T-B15 | - |
| FE10b | Daily rate entry (owner and biller) | - | - | PT-F10 a rate for today can be entered; yesterday's cannot by a biller |
| FE11 | Download everything, and hiding what is not ready | T-E04 | - | - |

**Suites.** `npm run db:test` (pgTAP), `npm run db:test:2` (Vitest over two connections, serial), `npm test` (unit), `npm run test:e2e` (Playwright against the lane's stack, timing tests on the static `out/`), `npm run db:check` (migrations applied twice), `npm run build:check` (build output), `supabase db advisors --local --fail-on error`, plus the drill logs in `docs/`. `npm run verify` runs them all. A task is done only when every suite that existed before it is still green.

## 4. Tasks

The full text of each task is in `tasks.md`; this is the list. **The unit.** A Claude-day is the planning unit of `PLAN.md`: the work an implementer is expected to finish in one focused working day, tests and commit included. It is not elapsed time and it is untested: the only task measured so far (P0-T2, planned 1.0) took about 25 minutes of agent time, while the orchestrator's merging, the review loops and any waiting for Harsh are not in the unit at all. The plan keeps 1 unit = 1 working day as the cap and measures the real factor early (the tripwire of section 5). Days are estimated from the spec lines each task covers, plus or minus 30 percent. `[P]` marks a task that can run beside the one before it in its lane.

| Task | Agent | Title | Depends on | Days | PLAN.md task |
|---|---|---|---|---|---|
| DB01 | A | Test harness: per-agent local stacks, helpers, fixtures, one verify command | - | 1.1 | P1-T4 (start), P0-T2 leftovers |
| DB02 | A | Privileges, schemas, profiles and roles | DB01 | 1.0 | P1-T4 |
| DB03 | A | Reference and stock tables with their access rules | DB02 | 1.2 | P1-T4 (slice 1) |
| DB04 | A | Customers, bills, receipts and allocations: tables and access rules | DB03 | 1.0 | P1-T4 (slice 2) |
| DB05 | A | Counters, idempotency, audit, touch triggers, seeds | DB04 | 1.0 | P1-T4 (slice 2), P1-T9 (part) |
| DB06 [P] | C | Stock functions: create_design and set_sku_status | DB05 | 1.0 | P1-T4/P1-T6 (stock saves) |
| DB07 [P] | C | Photo storage: bucket and policies | DB03 | 0.5 | P1-T7 |
| DB08 | B | Pricing functions, quote_bill and the parity test | DB03, FE01 | 1.3 | P2-T1 |
| DB09a | A | The write prologue and create_customer | DB05, DB02 | 0.6 | P2-T1 |
| DB09b | A | create_bill core without payments (private.create_bill_core) | DB09a, DB08 | 1.2 | P2-T1 |
| DB10a | A | private.rebalance for money and silver | DB09b | 0.9 | P2-T1 |
| DB10b | A | record_payment | DB10a | 1.0 | P2-T1 |
| DB16 | C | Views V1 to V4 | DB04, DB05 | 1.2 | P2-T1 |
| DB11 | C | Cash limit and PAN rules, and the payment rows of a bill (the private helpers only) | DB10b | 0.7 | P2-T1 |
| DB12 [P] | C | settle_fine | DB11, DB16 | 0.7 | P2-T1 |
| DB13 | A | void_receipt and cancel_bill | DB11, DB16 | 0.9 | P2-T1 |
| DB14a | A | reissue_bill | DB13, DB11, DB09b | 1.0 | P2-T1 |
| DB14b | C | add_opening_balance | DB10b, DB16, DB13, DB11 | 0.7 | P2-T1, P3-T4 (data side) |
| DB15 | C | issue_refund (first to leave if the calendar slips) | DB13, DB16 | 0.4 | P2-T1 |
| DB17a | A | Invariants I1 to I7, I10 and I13, with the mutation helper | DB16, DB09b | 1.0 | P1-T9 (part) |
| DB17b | A | Nightly job, review line, backup heartbeat and the dashboard summary function | DB17a, DB05 | 0.8 | P1-T9 (part) |
| DB18a | A | Two-session interleavings with the test hook | DB14a, DB14b, DB15, DB12, DB17a | 1.0 | P2-T1, P2-T3 (prepared) |
| DB18c | A | Lock timeout, role timeout and the stress run | DB18a | 0.7 | P2-T1, P2-T3 (prepared) |
| DB18b | C | Random sequences of operations and the function-by-role matrix | DB14a, DB14b, DB15, DB12, DB17a | 1.2 | P2-T1, P2-T3 (prepared) |
| DB19 [P] | C | Import and opening data script | DB14b, DB17b, DB21a, PL03 | 1.2 | P3-T4 (data side) |
| DB20a [P] | C | Backup job: encrypted dump, photo mirror, heartbeat | DB05, PL02, DB21a | 1.2 | P1-T9 |
| DB20b | C | Restore drill 1 and the runbook | DB20a, DB17b, FE05, DB21a, PL01 | 0.7 | P1-T9 |
| DB21a [P] | C | Dev project gets the migrations merged so far (early) | DB05, PL01 | 0.3 | P1-T4 |
| DB21 | C | Platform checks on the cloud dev project | DB18b, DB21a, PL01, PL02, FE06 | 0.6 | P1-T4 (advisors), P1-T9 |
| FE01 [P] | B | Integer pricing copy and the shared selectors | - | 1.0 | P2-T1/P2-T2 |
| FE02 | B | Supabase client, session gate, login and roles | DB02 | 1.4 | P1-T5 |
| FE03 | B | Hydrate the stock side behind the loading gate | FE02, DB03, DB05 | 1.0 | P1-T6 (part) |
| FE04 | B | Polling, merging, offline banner and ordinary edits (stock side) | FE03, DB05 | 1.2 | P1-T6 (part) |
| FE04b | B | Money side of the cache: customers, bills, receipts and the views | FE04, DB16, DB10b | 0.8 | P1-T6 (part), P2-T2 |
| FE05 | B | Stock functions and photos from the screens | FE04, DB06, DB07 | 1.0 | P1-T6/P1-T7 |
| FE06 [P] | C | Hosting headers and build checks | DB01, FE02, FE03 | 0.7 | P1-T8 |
| FE07a | B | Billing screen on create_bill, with customer creation | FE04b, FE01, DB11, DB09a | 1.2 | P2-T2 |
| FE07b | B | Payment and silver-fine panels | FE07a, DB12, DB10b | 0.9 | P2-T2 |
| FE08 | B | Estimate view and the customer ledger | FE07b, DB16 | 0.8 | P2-T2 |
| FE09 | B | Cancel, re-issue, void, refund and opening-balance screens; the error map | FE08, DB13, DB14a, DB14b, DB15 | 1.2 | P2-T2 |
| FE10a | B | The owner's dashboard line and the shared selectors on dashboard, reports and customer card | FE04b, DB17b, FE01, DB20a | 0.9 | P2-T2, P1-T9 (part) |
| FE10b [P] | B | Daily rate entry (owner and biller) | FE04, DB03 | 0.5 | P3-T2 (write path only) |
| FE11 | B | Download everything, and hiding what is not ready | FE09 | 0.8 | P3-T3 (part), P1-T9 (part) |
| RV1 | C | Implementation review 1: access and security (fresh agent) | DB04, DB05, DB06, DB07, FE02, FE06 | 0.5 | P1-T10 |
| RV2 | A | Implementation review 2: the money core, with a mutation check (fresh agent) | DB18b, DB18c | 1.0 | P2-T3 |
| RV3 | A | Implementation review 3: end to end (fresh agent) | FE11, FE10a, FE10b, DB21, RV2, DB20b | 0.5 | P2-T3 |
| CL | A | Close-out: stop the stacks, remove worktrees and branches that are merged, update the README and the ledger | RV3 | 0.2 | - |
| PL01 [P] | Harsh | Harsh: Supabase decisions (free dev project, organisations, access path) | - | 0.2 | P0-T3 |
| PL02 [P] | Harsh | Harsh: Cloudflare R2 bucket and keys, a private GitHub repository, the backup scheduler | - | 0.4 | P0-T3 |
| PL03 [P] | Harsh | Harsh and Siddhi: business answers, her data, devices, a runbook tester | - | 0.4 | P0-T1, P0-T5 |
| PL04 [P] | Harsh | Harsh, at go-live: the production database password for one session, and his go | - | 0.1 | P3-T8 |

**Totals:** 23.3 days of database work, 2.8 platform, 13.4 front end, 2.2 reviews and close-out: **41.7 Claude-days** in 48 tasks, against about 17.5 for the same scope in `PLAN.md`. 12 of the 43 implementer tasks are over one day (none over 1.5). The growth over `PLAN.md` comes from what the reviews added: eleven writing functions instead of six, 103 tests instead of about 40, two-session and mutation tests, refunds, re-issue, opening balances, the import path, the dashboard line, per-agent stacks and a proper harness.

## 5. Order, agents and the schedule

```
Agent A (database)      : DB01 > DB02 > DB03 > DB04 > DB05 > DB09a > DB09b > DB10a > DB10b > DB13 > DB14a > DB17a > DB17b > DB18a > DB18c > RV2 > RV3 > CL
Agent B (front end)     : FE01 > FE02 > DB08 > FE03 > FE04 > FE05 > FE10b > FE04b > FE07a > FE07b > FE08 > FE09 > FE10a > FE11
Agent C (side, reviews) : DB07 > DB06 > DB16 > FE06 > RV1 > DB21a > DB11 > DB12 > DB14b > DB15 > DB20a > DB18b > DB19 > DB20b > DB21
Harsh                   : PL01, PL02, PL03 (none blocks DB01 to DB05; assumed done by working day 6)
```

If every task had its own agent, the longest chain of dependencies would be **15.4 Claude-days** (DB01 > DB02 > DB03 > DB04 > DB05 > DB09a > DB09b > DB10a > DB10b > FE04b > FE07a > FE07b > FE08 > FE09 > FE11 > RV3 > CL). With three agents and the order above, the last task (CL) finishes on working day **17.3**; agent A is busy 16.1 days, agent B 14.0 and agent C 11.6. Counting Monday to Saturday with Tuesday 20 October (Dussehra) off, one Claude-day per working day, starting Thursday 15 October (the two dates are: Sundays off / Sundays 18 Oct, 25 Oct and 1 Nov worked):

| Task | Title | Finishes (working day) | Date |
|---|---|---|---|
| DB05 | Counters, idempotency, audit, touch triggers, seeds | 5.3 | Thu 22 Oct / Wed 21 Oct |
| DB09b | create_bill core without payments (private.create_bill_core) | 7.1 | Sat 24 Oct / Fri 23 Oct |
| DB10b | record_payment | 9.0 | Mon 26 Oct / Sat 24 Oct |
| DB16 | Views V1 to V4 | 7.5 | Sat 24 Oct / Fri 23 Oct |
| DB11 | Cash limit and PAN rules, and the payment rows of a bill (the private helpers only) | 9.7 | Tue 27 Oct / Sun 25 Oct |
| DB14a | reissue_bill | 11.6 | Thu 29 Oct / Tue 27 Oct |
| DB17b | Nightly job, review line, backup heartbeat and the dashboard summary function | 13.4 | Sat 31 Oct / Thu 29 Oct |
| DB18b | Random sequences of operations and the function-by-role matrix | 14.1 | Mon 02 Nov / Fri 30 Oct |
| RV2 | Implementation review 2: the money core, with a mutation check (fresh agent) | 16.1 | Wed 04 Nov / Sun 01 Nov |
| FE09 | Cancel, re-issue, void, refund and opening-balance screens; the error map | 13.9 | Sat 31 Oct / Thu 29 Oct |
| FE11 | Download everything, and hiding what is not ready | 15.6 | Tue 03 Nov / Sat 31 Oct |
| DB21 | Platform checks on the cloud dev project | 16.6 | Wed 04 Nov / Sun 01 Nov |
| RV3 | Implementation review 3: end to end (fresh agent) | 17.1 | Thu 05 Nov / Mon 02 Nov |

**What moves it.** Everything below is computed by the same scheduler.

| Case | Last task finishes | Date (Sundays off / worked) |
|---|---|---|
| The plan as drawn | day 17.3 | Thu 05 Nov / Mon 02 Nov |
| Harsh's three tasks done on day 10 instead of 6 | day 18.6 | Fri 06 Nov / Tue 03 Nov |
| The plan's own allowance of one day in five (20 percent slip) | day 20.8 | Mon 09 Nov / Thu 05 Nov |
| A 30 percent slip (the size of the estimate's own error) | day 22.5 | Wed 11 Nov / Sat 07 Nov |
| Cut items 1 to 3 of section 6 applied | day 17.0 | Wed 04 Nov / Sun 01 Nov |

**Two tripwires.** (1) DB05 (counters, audit, touch triggers) is planned to finish on working day 5.3, Thu 22 Oct / Wed 21 Oct: DB01 to DB05 are the first real measurement of the unit, but they are mostly configuration, so a fast result there proves little. (2) DB10b (`record_payment`) is planned to finish on working day 9.0, Mon 26 Oct / Sat 24 Oct: DB09a to DB10b are 3.8 planned days of real money functions with two-session tests, and that is the measurement to trust. If either took more than 20 percent longer than planned, the orchestrator tells Harsh that go-live moves; if the second took far less, the schedule above is pessimistic.

**What the schedule does not include.** After RV3 `PLAN.md` still needs regression, acceptance by Siddhi's two staff, training and drill 2 (P3-T5 to P3-T8, about 2.7 days) and the fix loop; P3-T1 to P3-T3 (print, rate card, hide screens) and DB19's real data run in the lanes of agents B and C when they are idle (14.0 and 11.6 busy days out of 17.3) but are not scheduled here. `PLAN.md` rule 4 (no change between Thu 29 Oct and Wed 11 Nov) has to be re-cut: this plan's money gate lands around working day 14, after that date. **The honest reading for Harsh:** a go-live on 12 to 16 November is possible only if Sundays are worked, no task slips by more than about 20 percent, and Harsh's own tasks are done by about 21 October; it has no slack. If the tripwire shows a slip, the date to give Siddhi is the week of 16 to 20 November.

## 6. Budget and cut line

Budget: the days above, from Thursday 15 October, with the three agents running. If a gate is late, cut in this order, one item at a time, and tell Harsh each time. Prices are in critical-path days, computed by the scheduler:

1. **DB15 (refund, X11) and its form in FE09**: a mistaken receipt is voided instead.
2. **The review line and list-price report** (I11, R14 reporting): the columns stay, the report goes (half of DB17b).
3. **The export half of FE11 ("Download everything", spec B3)**: allowed only if the spec and the ledger first defer B3 to M2 and Claude, not Harsh, makes the export for the first weeks (Harsh is not asked to run SQL).

Cutting 1 to 3 together brings the last task from day 17.3 to day 17.0, a saving of **0.3 day**: the cut line is a last resort, not a plan, because the critical chain runs through agent A's concurrency and review tail and agent B's screens, not through these items. The one lever on B's tail is to hide the Reports screen instead of rewiring it to the selectors (about 0.4 day of FE10a, O32). Moving the pricing functions (DB08) to agent B, which was idle, and the views (DB16) to agent C right after DB06 are already in the schedule and are not cuts.

**Never cut:** the lock order and idempotency (DB09a, DB09b, DB18a), row-level security and the owner-only weight, the cash and PAN rules (DB11), the invariants and the nightly check (DB17a, DB17b), the backup job and restore drills 1 and 2 (DB20a, DB20b, P3-T8), her data and the reconciliation (DB19), the reviews RV1 and RV2, hiding the unfinished screens (C15), T-B14 with three seeds and T-C15's stress run. If the cuts are not enough, the answer is a later go-live, not a thinner safety net.

## 7. Rollback and applying changes

- **Per task (local):** `git revert` the commit, then `npm run db:reset` in that agent's lane. The local databases hold nothing of value.
- **Tasks that change something outside the repository** have their own rollback in `tasks.md`: the backup job (DB20a: stop the scheduler entry, delete the test objects), the restore drill (DB20b: the target is the wiped dev project), the platform checks and the first preview deployment (DB21: restore the pre-apply dump, delete the preview), the import (DB19: roll back the batch, or list its rows by `import_batch_id` and cancel them).
- **Cloud dev:** a dump is taken before every apply. A bad migration is fixed forward with a new migration, or by restoring that dump.
- **Production:** never touched by a task. After RV2, a fresh dump and Harsh's go, the migrations are applied in version order from a clean checkout of `main`; the first real data goes in only after restore drill 1 has passed and after the reconciliation of DB19 matches. A wrong migration on production is fixed forward; if data is damaged, restore from the nightly dump (spec B4).
- **Front end:** redeploy the previous Cloudflare build.
- **Close-out (CL):** the stacks are stopped, and merged worktrees and branches are removed only after Harsh agrees.

## 8. Risks and what the plan does about them

| Risk | What the plan does |
|---|---|
| The unit is wrong in either direction (P0-T2 took 25 minutes against 1.0 planned; the orchestrator's merge and review time is not in the unit) | Two tripwires (DB05 and, the one to trust, DB10b) measure the real factor; go-live is re-dated if it is above 1.2. |
| The schedule has no slack for Diwali week and the P3 tasks that follow | Section 5 says so; the cut line of section 6 and a later date are the only remedies; no safety net is traded for time. |
| Three implementers, an orchestrator and fresh reviewers re-running growing suites hit the session usage limit (it hit the QA run: Playbook 8, PLAN.md risk 12) | Prompts stay bounded, results are written to files after every step, heavy suites run once per task (`npm run verify` at merge, not after every edit), and an agent resumes from its saved file instead of repeating work. |
| Stacks collide (ports, project ids) or leak Docker volumes | One stack per agent with its own project id and port block; `db:stop --no-backup` on request; the volume count is compared before and after (it stayed 182 in every spike); CL stops everything. |
| Two-session tests are flaky | DB18a runs every concurrency suite three times in a row before it counts; waits use the lock timeout, never sleeps; the reset helper sets `lock_timeout` and ends leaked sessions. |
| A migration conflict between agents | Only the orchestrator merges and sets migration versions; agents append to named blocks in shared files (`package.json`, `seeds/10_test_helpers.sql`); the lockfile is regenerated at merge. |
| `pg_cron`, the Auth password settings, the Storage limits and lints 0028 and 0029 behave differently on the hosted project | They are listed as open items of spec section 0 and settled in DB21; locally the same facts were measured (section 1.1). |
| The Supabase CLI or its images change under the lanes | The `supabase` package is pinned to one exact version; `api.auto_expose_new_tables` is set explicitly; DB21 reads the hosted project's value. |
| Siddhi's sheets arrive late or in an odd shape | DB19 is built against a sample sheet in the layout agreed in PL03; her real data only changes the mapping file. |
| An open business item (O1, O2, O9, O12, O14, O22, O23, O24, O32) is answered differently | Each is isolated behind one function or constant (pricing version, `private.limits`); the defaults stand until Harsh writes an answer in the ledger. |
| Harsh's three tasks are late | Only DB20a (needs PL02), DB20b and DB21 (need PL01 and PL02) wait for him; section 5 shows the cost of day 10 instead of day 6. |

## 9. Gates and reviews

| Gate | When | Review | Passes when |
|---|---|---|---|
| G-A, access gate | after RV1 (DB04 to DB07 and FE02 merged) | RV1 | All D tests that exist by then pass; the local advisor exits 0; the function-by-role rows of the functions built so far pass; no secret, source map or hard-coded login in the repo or the build |
| G-M, money gate (PLAN.md G4) | after DB18b | RV2 | All A, B and C tests pass three times in a row; a reviewer's one-rule-at-a-time mutations each fail a test |
| G-E, end-to-end gate | after FE11, DB21 and RV2 | RV3 | The whole suite is green on the static build; a hand-run billing day works; restore drill 1 is logged under 2 hours |

## 10. What this plan needs from Harsh, and when

- **Now:** a green light to start DB01 (nothing to buy; local only), and his choice of date plan (A or B), which decides what he tells Siddhi about 16 and 31 October. Section 5 gives him the numbers.
- **By about 21 October (working day 6):** PL01 (a yes to a free `jewelvault-dev` project in his existing free organisation, three test logins he creates there, and how Claude reaches it) and PL02 (Cloudflare account with an R2 bucket and keys, a private GitHub repository, the backup scheduler: recommended a GitHub scheduled workflow with `age` encryption). These two gate DB20a, DB20b and DB21 only.
- **At go-live (PL04):** the production database password for one session through his password manager, his go after RV2, and the production organisation and project.
- **Before the money gate:** PL03, the answers to the open items that change code, and the days Siddhi's testers are free in the week of Dhanteras, Diwali and Bhai Dooj; defaults stand otherwise. Production will live in its own Pro organisation (Supabase bills per organisation: a free project inside the Pro organisation costs about US$10 a month), owned by him until Siddhi takes it over.
- **Downloads:** FE02 installs Playwright's Chromium (about 170 MB) on this Mac; nothing else is downloaded outside the usual npm packages.
- **Before production:** Supabase Pro on, Siddhi's stock list, balances and staff list, a go from him.

## 11. How draft 2 answers the plan review

| Finding | Answer |
|---|---|
| PR-1 | Added the missing edges (FE03 and FE04 no longer read money views; FE04b does after DB16; DB20 split; DB15 after DB13; DB19 after DB17b; FE06 until FE02); the money views moved right after record_payment so later tasks have them |
| PR-2 | Tests are introduced where they can pass and extended later (sections 3, tasks.md); T-F02 starts in DB03; T-D09 rows come with each function task; the generator checks the dependency graph |
| PR-3 | Per-agent stacks and ports (`scripts/lane.mjs`), serial DB and E2E tests, a reset helper with `lock_timeout`, `db:reset --local`, a separate Vitest config (DB01) |
| PR-4 | Cut line rewritten and priced in critical-path days; drill 2 and the cash rules are never cut; B3 can be cut only after a spec change (section 6) |
| PR-5 | Section 5 no longer says "a few days to spare"; it shows the slip cases, a tripwire and the date to give Siddhi if it trips |
| PR-6 | Nine tasks split or re-sized; 12 tasks are over one day, none over 1.5; the generator warns above 1.2 |
| PR-7 | Logins are created through the Auth admin API in the browser tests' setup; `!.env*.example` in `.gitignore`; the seed guard refuses a non-local JWT secret |
| PR-8 | File paths corrected and checked against the repository; shared files have named owners; seeds split into `supabase/seeds/*.sql` |
| PR-9 | Section 2 is the expected order; versions are timestamps set at merge; DB21 applies what is merged and not yet applied |
| PR-10 | `import_batches`, `today()` and the profile triggers moved to 0003; foreign keys added where their targets exist; caps are literals (spec S4 now says so) |
| PR-11 | FE10a (dashboard line and selectors), FE10b (rate entry) and the customer, PAN and retry work in FE07a added |
| PR-12 | Clock seam `private.now_ts()`, fixtures and generators, `seed_defaults()`, `npm run verify` and `tests/README.md` in DB01 and DB05; password length in the config |
| PR-13 | The advisor runs locally from DB02; DB21 is one late platform task; G-A no longer waits for the cloud |
| PR-14 | Plan tests (PT-...) for FE05, FE07b, FE08, FE09, FE10b; the error-map unit test is in FE09 |
| PR-15 | PL01 to PL03 now name the organisation layout and cost, the access path, the scheduler, the encryption custody, the sheet layout, the runbook tester and the download |
| PR-16 | Harsh-dependent work moved behind work that needs nobody; DB08 moved to agent B; every review is a fresh invocation |
| PR-17 | Rollbacks per task for external state; spec edits only through the orchestrator; usage-limit risk added; timing tests on the static build; a close-out task |
| PR-18 to PR-23 | Coverage sentence, A9 and S8 citations, the global A3 recipe in DB02, the nightly snapshot command in DB17b, the X0 prologue in every writing function, pinned CLI and `auto_expose_new_tables`, customer update grants in DB04 |

### 11.1 Second plan review (`plan-review-2.md`, PR2-1 to PR2-12)

| Finding | Answer |
|---|---|
| PR2-1 | Port blocks are 443xx, 453xx, 463xx and 473xx (valid and below the dynamic range); `.lanes/` is git-ignored; DB01's done-when starts all four lanes |
| PR2-2 | DB21a gives dev the merged migrations early; DB19, DB20a and DB20b depend on it; DB20b loads sample data and photos first; DB21 extends T-D12 |
| PR2-3 | `private.limits` moved to 0003 so the pricing functions need no later task; DB14b depends on DB13 and DB11; DB19 depends on PL03; RV1 on FE06 |
| PR2-4 | `TEST_CLAUSES` in `plan_data.py`: nine clauses with a named owner, checked by the generator; seven tasks gained an `extends` line |
| PR2-5 | One owner per function, final signatures from the first migration, later work through private helpers the public function already calls (section 1); DB11 now replaces helpers only |
| PR2-6 | `tests/db/hook.ts` and `tests/db/rpc.ts` in DB01; DB10b re-priced to 1.0; DB18a split into DB18a (interleavings, 1.0) and DB18c (timeouts and stress, 0.7) |
| PR2-7 | T-C08's X9 clause is extended in DB06, so DB09b no longer waits for it; the views (DB16) moved to agent C right after DB06 |
| PR2-8 | Second tripwire at DB10b, the lever on B's tail, the C15 sentence back in "Never cut", the testers' dates in PL03, the cut line priced honestly |
| PR2-9 | The local advisor runs at `--level warn --fail-on warn` and `auto_expose_new_tables` is `true` locally (the worst case) |
| PR2-10 | The money prologue and the stock prologue are two separate sentences matching X0 items 7 and 8 |
| PR2-11 | Section 3 says that extending a test means writing a part of it, before or after the task that introduces it |
| PR2-12 | FE10a files, the static Playwright project in FE04b, `db:stop --no-backup` in CL, the free-project slot in PL01, PL04 for the production apply |

## Appendix: coverage, generated

Every one of the 172 requirement IDs of the spec that a task can build is cited by at least one task (P6 is exempt: the monthly sweep of unused photos is M2 (spec P6 says so)); every one of the 103 tests is introduced by exactly one task and can pass there. The checks ran when this file was written and are repeated by `build_plan.py` after any change to the spec.

| Requirement | Task(s) |
|---|---|
| S1 | DB02 |
| S2 | DB05 |
| S3 | DB03 |
| S4 | DB03 |
| S5 | DB02 |
| S6 | DB02 |
| S7 | DB04, FE11 |
| S8 | DB05, DB18c |
| S9 | DB01 |
| S10 | DB02 |
| D1 | DB02 |
| D2 | DB02 |
| D3 | DB03 |
| D4 | DB03 |
| D5 | DB03 |
| D6 | DB03 |
| D7 | DB03 |
| D8 | DB03 |
| D9 | DB03 |
| D10 | DB04 |
| D11 | DB04 |
| D12 | DB04 |
| D13 | DB04 |
| D14 | DB04 |
| D15 | DB04 |
| D16 | DB05 |
| D17 | DB05 |
| D18 | DB02, DB05 |
| D19 | DB05 |
| D20 | DB05 |
| D21 | DB04 |
| D22 | DB02 |
| D23 | DB05 |
| A1 | DB02 |
| A2 | DB02 |
| A3 | DB02 |
| A4 | DB03 |
| A5 | DB03 |
| A6 | DB09a |
| A7 | DB21 |
| A8 | DB02 |
| A9 | FE02 |
| A10 | DB02 |
| A11 | DB02 |
| U1 | FE02 |
| U2 | DB02 |
| U3 | DB02 |
| U4 | FE02 |
| U5 | FE02 |
| U6 | FE02 |
| U7 | FE02 |
| U8 | FE02 |
| U9 | DB21 |
| U10 | FE02 |
| P1 | DB07 |
| P2 | DB06, FE05 |
| P3 | DB07 |
| P4 | DB03 |
| P5 | DB20a |
| P6 | exempt |
| L1 | DB05 |
| L2 | DB05 |
| L3 | DB05 |
| L4 | DB05, FE07a |
| L5 | DB05, DB18a |
| L6 | DB05 |
| C1 | FE03 |
| C2 | FE03 |
| C3 | FE04b |
| C4 | FE04 |
| C5 | FE04 |
| C6 | FE04 |
| C7 | FE04 |
| C8 | FE03 |
| C9 | FE03 |
| C10 | FE03 |
| C11 | DB06 |
| C12 | FE01 |
| C13 | FE09 |
| C14 | FE10a |
| C15 | FE11 |
| C16 | FE02 |
| C17 | FE04b |
| C18 | FE04 |
| B1 | DB20a |
| B2 | DB20a |
| B3 | FE11 |
| B4 | DB20b |
| B5 | DB20b |
| B6 | DB20a |
| H1 | FE06 |
| H2 | FE06 |
| H3 | FE06 |
| H4 | FE06 |
| H5 | DB01 |
| H6 | PL03 |
| IM1 | DB19 |
| IM2 | DB19 |
| IM3 | DB19 |
| IM4 | DB19 |
| IM5 | DB14b |
| IM6 | DB19 |
| IM7 | DB19 |
| IM8 | DB19 |
| R1 | DB06, DB08 |
| R2 | DB08 |
| R3 | DB08 |
| R4 | DB08 |
| R5 | DB08 |
| R6 | DB08 |
| R7 | DB08 |
| R8 | DB08 |
| R9 | DB09b, FE07a |
| R10 | DB09b |
| R11 | DB16 |
| R12 | DB08 |
| R13 | DB08 |
| R14 | DB08 |
| K1 | DB04 |
| K2 | DB09b |
| K3 | DB13 |
| K4 | DB04 |
| K5 | DB04, FE08 |
| K6 | DB14a |
| Y1 | DB11 |
| Y2 | DB04 |
| Y3 | DB10a |
| Y4 | DB04 |
| Y5 | DB10b |
| Y6 | DB10a |
| Y7 | DB13 |
| Y8 | DB09b |
| Y9 | DB10a |
| Y10 | DB15 |
| SF1 | DB12 |
| SF2 | DB12 |
| SF3 | DB12 |
| X0 | DB09a, DB09b, DB18a |
| X1 | DB09b |
| X2 | DB10b |
| X3 | DB12 |
| X4 | DB13 |
| X5 | DB13 |
| X6 | DB09a |
| X7 | DB08 |
| X8 | DB06 |
| X9 | DB06 |
| X10 | DB14a |
| X11 | DB15 |
| X12 | DB14b |
| X13 | DB18b |
| V1 | DB16 |
| V2 | DB16 |
| V3 | DB16 |
| V4 | DB16 |
| V5 | FE10a |
| I1 | DB17a |
| I2 | DB17a |
| I3 | DB17a |
| I4 | DB17a |
| I5 | DB17a |
| I6 | DB17a |
| I7 | DB17a |
| I8 | DB17b |
| I9 | DB17a |
| I10 | DB17a |
| I11 | DB17b |
| I12 | DB17b |
| I13 | DB17a |
| Z1 | DB11 |
| Z2 | DB11 |
| Z3 | DB11 |
| Z4 | DB11 |
