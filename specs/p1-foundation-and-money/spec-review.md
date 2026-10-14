# Spec review: P1 foundation and money (spec.md, DRAFT 1, 523 lines)
Reviewer: fresh agent (did not write the spec; the spec was not edited)   Date: 14 October 2026
Read: all of spec.md; the prototype files it cites; findings.json (156 rows) and QA streams T1-T7; Playbook 3.1 and 7; PLAN P1/P2; SDD-ledger; Review.md Addendum A.
Done: 45 prototype citations checked against the code; 22 official pages fetched on 14 Oct 2026; the spec's numbers recomputed with exact decimals; one 200,000-case rounding simulation.
Limits: no database was available here, so SQL behaviour rests on the official docs fetched, not on execution. Legal points were not verified (not legal advice).
Totals: 0 Critical, 4 High, 12 Medium, 5 Low. The skeleton is sound; the High items are design gaps, not wrong ideas.

## Checklist answers
1. **Testable?** Mostly. Every R, Y, K, L, X and S rule has a test ID, and the 69 tests add up (16+17+9+15+6+4+2).
   - No test exists for: U3, U4, U9, H5, H6, B5, B6, A1's event trigger, D5 case-insensitive uniqueness, D10 "walk-in never archived", X6 "opening values owner only", X8 500-piece cap, X9 "a Sold piece cannot be changed", Y3 tie-break order, Y6 "never changes an existing allocation / oldest receipt first", Z1 on `record_payment` and `settle_fine`, L4 barcode and `OB-` formats and the 1 January rollover, C4 overlap / hidden tab / paging, C11, privileges inside schema `private`.
   - Orphans: T-E04 (print layout; no print requirement, it is P3-T1) and I8's cite of T-D14 (T-D14 tests `audit_log`, so "a broken row makes the check say Problem" has no test).
   - Not testable as worded: C13, H6, B5.
2. **Unsupported statements?** Few. Weak or unsourced:
   - pg_cron time zone (the spec admits it); "30 daily and 12 monthly copies by a lifecycle rule" (no R2 lifecycle source cited; not checked here).
   - The session values 12 h / 14 days, and "effective length is timeout plus token expiry" (not on the sessions page).
   - A1's "example in docs #4" (that page only links to it; the example is on /postgres/event-triggers and exists); U6's workaround (the troubleshooting page shows the bug, not the fix); the cash-rule reading (Q4).
3. **Contradictions?** Yes.
   - Inside the spec: D11 vs R8 (negative `round_off`, F8); A4 table vs A4 paragraph (`sku_private` insert, F7); S7/T-D07 vs P3 (object delete, F16); R8 wording vs R8 formula vs T-A08; I6 vs D15 (opening bills have no lines, F4); I8 vs T-D14; C4 "nothing is deleted, so no removed rows" vs A4 (archived rows vanish from biller and staff, F3); P2 (path needs `design_id`) vs X8/C11 (the function creates the id, F16); section 10 intro "Each is `security definer`" vs X7 (invoker); the reading guide (l.12) says every `[NEEDS CLARIFICATION]` is collected in section 16, but U9 and H6 are not.
   - Against QA: CMP-08 marked Closed though per-transaction and per-event are not built (F9); QA DAT-16 expects "The ₹500 advance ... shown as customer credit", the spec auto-applies it (T-B07).
   - Against PLAN: block vs "a warning" (P2-T2); one public bucket vs public + private (P1-T7); "No open clarification marker" (P1-T1); Pro on 7 Oct (decision 3) vs about 2 Nov (B1).
4. **Legal/tax flagged for the CA?** Mostly yes (bill type, NW label, fine, BIS, thresholds, document types). Not enough:
   - Z1/Z2 decide default behaviour in code (hard block with a free-text override; PAN at "₹2,00,000 or more").
   - QA CMP-08 says "per person per day, per transaction, or per event such as a wedding order plus its final bill"; only per day is built, yet section 14 says Closed.
   - CMP-07 (silver supplied "on fine" missing from the document value) is mapped to O15/O16, which do not mention it.
   - The company is "Pvt Ltd" (businessConfig.ts): ask the CA about audit-trail and retention rules for books kept in software (not verified by me). Calendar-year numbering (L4) vs financial year is not flagged.
5. **Built for unconfirmed cases?** Yes:
   - Advance auto-applied to the oldest bill (Y6, T-B07): Siddhi never asked.
   - What cancel and re-issue does with the payment (F2).
   - Biller reads every customer's PAN/GST/mobile and the whole ledger, edits customers, sets any price (A9, A4, F12): not in O1-O21.
   - Walk-in on credit (O6) and the cash hard block (O14) are flagged but built. Piroi unit, fine formula and BIS are flagged correctly (O1, O2, O16).
6. **Scope?** Inside P1+P2, out-of-scope items named (1.1, 17). Leaks:
   - The import (P3-T4) is relied on (D15, O17, O18, "existing piece codes") but not specified (F4).
   - T-E04 tests P3-T1; section 14 files UI-03/UI-04 (printout cut off) under "M2" though P3-T1 fixes them in M1.
   - The stale-rate guard (P3-T2) is pulled in, which is fine, but it is only a screen rule (F14).

## Findings
Format: F<n> | severity | status | spec line or ID | title. Status is "open" for all (nothing is fixed or ruled yet).

**F1 | High | open | X1 l.298, X2-X5, Y6, I3, I4, T-C09 | Only `record_payment` locks the customer; the other money functions race with it**
- Wrong: X2 alone locks the customer row. X1 reads the customer without a lock; X3, X4, X5 say nothing. Every function then runs the Y6 rebalance over "unallocated receipt amounts".
- Case A: an advance of 300 exists; two `create_bill` for that customer run together. Both rebalances see 300 unallocated and both allocate it: allocations are 600 on a 300 receipt (I3 breaks; both bills look part-paid; outstanding understated).
- Case B: `record_payment` of 100 runs beside `create_bill`. The payment stays an advance while the new bill shows 700 pending: Y6's post-condition is false and V1 sums to 700 against V2 outstanding 600. I4 compares V2 with V3 only, so the nightly check stays green. The walk-in customer is shared by every anonymous sale (K5), so same-customer concurrency is routine there.
- Evidence: l.298 "read the customer (must exist, not archived) and lock the piece rows FOR UPDATE in id order"; l.299 "Locks the customer row FOR UPDATE (payments for one customer are serialised)"; PostgREST page "Every transaction uses the PostgreSQL default isolation level: READ COMMITTED."; PostgreSQL "a SELECT query sees a snapshot of the database as of the instant the query begins to run."
- Fix: state one global lock order in section 10: customer row FOR UPDATE, then that customer's bills and receipts by id, then pieces by id (X9 too), then the counter row last (take the number after the overpayment and cash-limit checks; the counter lock lasts to commit). Require it in X1-X6. Add T-C10 (`create_bill` with `record_payment`), T-C11 (two `create_bill`, same customer, with an advance), T-C12 (void with payment). Add the Y6 post-condition and "sum of V1 pending = V2 outstanding" as invariant I10.

**F2 | High | open | K1, K3, X5, Y6, K4, V4 | The only correction path (cancel, then re-issue) has no defined payment carry-over, and no refund path exists**
- Wrong: if the customer has any older pending bill, the cancelled bill's money moves to that bill at once and the re-issued bill starts unpaid. If the biller re-enters the payment on the re-issue, receipts double (cash counted twice in Z1 and V4). Nothing links a re-issue to the cancelled bill.
- Wrong: handing money back is possible only by `void_receipt`, which rewrites the original day's cash total (V4 groups by `paid_on`). The same holds for fine: a cancelled silver bill leaves silver (or `fine_cash` grams) as a fine advance with no way out. A customer with an advance can never be archived (K4). Siddhi has not confirmed any of this.
- Evidence: X5 "Applies K3, then rebalances the customer (Y6)"; K3 "the receipts stay active (the money was received), so the customer holds an advance until it is applied (Y6)".
- Fix: add an open item with a default: `create_bill` takes `p_reissue_of` (a cancelled bill of the same customer) and re-allocates that bill's released receipt amounts to the new bill before the rebalance; `cancel_bill` skips the rebalance when a re-issue follows; add receipt kind `refund` dated today (or state that void is the refund and accept the retroactive cash change). Add T-B19: cancel then re-issue with and without older dues, plus a refund.

**F3 | High | open | C1, C3, C4, V1-V3, A4 | The cache contract does not say how derived figures reach the screens, and polling can miss rows**
- Wrong (a): C4 polls "each table group" by `updated_at`, but V1-V3 have no `updated_at` and change when only receipts or allocations change (a payment inserts allocations; `bills.updated_at` and `customers.updated_at` do not move), so polled tables never show the new pending or balance. The spec leaves a choice between re-reading unbounded views every cycle and recomputing in the browser (a third copy of money logic, against C12/C14).
- Wrong (b): "owner reads all" (C3) includes `audit_log` (a row per insert/update on 13 tables), so login time grows without bound; there is no hydrate time budget.
- Wrong (c): C4 "polling never needs to find removed rows" is false for rows RLS hides. A4 shows biller and staff only non-archived designs and pieces, so an archived row just stops arriving and stays in their memory.
- Wrong (d): `api.max_rows` also caps views and functions (CLI config: "from a view, table, or function"). A poll after the laptop slept, or after the import, can hit 1,000 rows; nothing says polls page, that `last_seen` advances only after a complete result, or how ties on equal `updated_at` at a page edge are handled.
- Wrong (e): if the trigger uses `now()` (usual), `updated_at` is the transaction start, so a transaction that waits on a lock for over 30 s commits rows older than the overlap. The origin of `last_seen` (server or client clock) is unspecified.
- Wrong (f): A5's stale check `WHERE updated_at = <loaded value>` fails forever if the screen turns the value into a JS Date (milliseconds) instead of keeping the API's microsecond string. An optimistic row (C5a) vs an older polled row "keeping the later `updated_at`" can flicker back.
- Fix: per view, say how it is kept fresh: ledger loaded per customer on demand; bill and customer cards from a small `changed_since(ts)` RPC, or `updated_at` bump triggers on bills and customers when allocations or receipts change. Owner hydrate excludes `audit_log` and `check_runs` (lazy, paged). All read roles may SELECT archived rows (hide in the UI). Polls use keyset paging on (`updated_at`, `id`), advance `last_seen` only past a complete result, take server time from the API and stamp with `clock_timestamp()`. Keep `updated_at` as the raw string. Extend T-E02 with a 20 s slow transaction and a 1,500-row poll; add a hydrate time budget.

**F4 | High | open | D15, X6, L3, L4, I5, I6, V2, C14, O17, O18 | Opening data and the import (PLAN P3-T4) cannot be built from this spec**
- Wrong (a): P3-T4's acceptance is "A code typed on the billing screen finds its piece", which needs her own piece codes and design numbers. But L3/L4 make `sku_no`, `barcode` and `design_no` only from counters, A4 grants no insert, and X8 has no code parameter. Nothing says how a privileged import writes explicit numbers, seeds counters past the imported maxima (else the first new design hits a unique violation), or why I5 ("contiguous from 1") still holds. O17/O18 speak of "old bills in memory", but D15 imports one dues bill per customer.
- Wrong (b): an opening bill has no lines, so I6 ("equal a fresh run of `private.price_bill` over its stored lines") fails for every one on the first nightly run.
- Wrong (c): V2 keeps opening bills out of `total_purchases`, but no rule keeps them out of sales by day or month (C14, V4), so the dues show as a sale on the cut-over day.
- Wrong (d): X6 creates an opening bill only at customer creation and only for dues above 0: no correction of a wrong figure, no opening for an existing customer, no opening advance (customer credit).
- Evidence: PLAN P3-T4 "keeping her existing piece codes so that typing a code finds the piece".
- Fix: add a short "Import" section: an owner-only, audited path (definer functions or a documented postgres-role script) that takes explicit numbers; counter seeding plus a test; I5/I6 and the sales selectors exclude `doc_type = 'opening_balance'`; an owner-only `add_opening_balance(customer, dues, fine, advance)`; settle O17/O18.

**F5 | Medium | open | L5, X1 steps 1 and 12, C6, T-C05, T-E06 | Repeat-safety checks first, stores last, and ignores the payload**
- Wrong: two identical requests in flight both pass step 1. The second waits on the piece or customer lock, then returns `JV_PIECE_UNAVAILABLE` (bill) or fails on the primary key at the end and rolls back (payment). The user sees "Could not save. Nothing was changed." for something that was saved: the dropped-response retry C6 is meant for. T-C05/T-E06 repeat only sequentially. A repeat with the same id but a different cart silently returns the first result.
- Fix: first statement `insert into private.idempotency (request_id, fn, actor, args_hash) ... on conflict do nothing`; if nothing was inserted, return the stored result when the hash matches, else `JV_INVALID_INPUT`. Add a two-session T-C05b and a retention rule for the table.

**F6 | Medium | open | A3, A6, A7, S1, X7, T-D02 | Grant rules cover existing objects only; schema `private`, the views and the exposed schemas are loose**
- Wrong: A3's one-time `revoke ... on all tables` leaves later migrations exposed wherever default privileges still grant. `authenticated` needs USAGE on `private` for policies and `quote_bill`, but nothing revokes the PUBLIC EXECUTE default on `private.next_number`, `activate_user`, `run_invariants`, `price_*`, or enables RLS on private tables; T-D02 tests `public` only. Views V1-V4 are not in the A4 matrix (no grants; who may read `daily_totals`?). S1 says exposed schemas are "public only", but no config line or test narrows the default.
- Evidence: securing-your-api page shows `ALTER DEFAULT PRIVILEGES` revokes, says "New tables, functions, and sequences now require explicit grants before Data API roles can access them", and that existing projects auto-grant new `public` objects to `anon`, `authenticated`, `service_role`, so open item (b) is answerable. CLI config: `api.schemas` default `["public", "storage", "graphql_public"]`. Functions page: a definer function owned by `postgres` "bypasses Row Level Security".
- Fix: first migration revokes default privileges (SQL from that page) for tables, functions, sequences. Revoke all on `private` objects from public/anon/authenticated, then grant only EXECUTE on what RLS needs. Add the views to A4 (owner, biller; staff none). Set `api.schemas = ["public"]`. Extend T-D02 to `private` and to GraphQL introspection.

**F7 | Medium | open | A4 l.136-150, A5 l.151, D4 l.103, D9 | The access matrix contradicts itself and has RLS bugs**
- Wrong (a): A4 gives owner S,I,U on `sku_private`; the paragraph below says inserts into `sku_private` are "not granted to any API role". With O5 (staff cannot enter the hidden weight) the owner must add weights later, and no function does.
- Wrong (b): `skus.archived_at` is not a content column and X9 sets status only, so nobody can archive a piece, yet A5 has a trigger on "archiving a Sold piece". `status = 'Archived'` and `archived_at` are not tied.
- Wrong (c): for UPDATE, the SELECT policy is applied as "Filter existing row & check new row" when a WHERE or RETURNING reads columns (PostgreSQL CREATE POLICY, table 300 note [a]). A5's stale check reads `updated_at`. Staff sees only non-archived designs (A4), so staff setting `archived_at` makes a new row that fails the SELECT policy and the update errors.
- Wrong (d): `daily_rates`: owner has S,I only and D4 is unique per (date, material, purity), so a mistyped rate for today cannot be corrected by anyone except Harsh in SQL, and a biller can insert today's row first. `confirmed_by`, `updated_by`, `created_by` are client-supplied unless forced.
- Fix: (a) owner-only `set_original_weight`, or grant insert and fix the paragraph; (b) CHECK `(status = 'Archived') = (archived_at is not null)` and archive through X9 or a definer function; (c) let every read role SELECT archived rows and filter in the UI; (d) owner UPDATE on today's rate (audited) or append-only rates, latest `created_at` wins; force every `*_by` column from `auth.uid()` by trigger. One test per point.

**F8 | Medium | open | D11 l.116, R8 l.259, R3, R5, I7, T-A10 | `round_off` is declared non-negative but is negative about half the time; per-line rounding is new**
- Wrong: D11 lists `round_off` among "money, not negative"; R8 defines `round_off = grand_total - before_round`, which is -0.40 for 1,000.40 (computed). I7 "No negative amount ... exists in any table" would flag it. R8's wording "a discount larger than the subtotal is rejected" disagrees with its own formula (a discount up to subtotal + additional passes; T-A08 follows the formula).
- Wrong: R3/R5 round every line to paise; the prototype does not (floats until `Math.round`, BillingSummaryPanel.tsx:149). Simulation: 1,545 of 200,000 random 1-8 line bills (0.77%) differ by Rs 1 from the prototype. This is not a QA-proven bug, so it goes beyond "freeze the rules".
- Fix: D11 allows negative `round_off` (I7 excludes it); state R8's test once (`before_round >= 0`); record per-line paise rounding as a ruling by Harsh and say so in R3.

**F9 | Medium | open | Z1, Z2, K5, X2, X3, D13, O6, O14 | Cash limit: no way to pass the reason, the walk-in pools strangers, the block is bypassable**
- Wrong (a): Z1 requires a reason, but X2 and X3 have no `p_cash_override_reason` and receipts have no column (Z1: "on a receipt in its notes"), so `record_payment` cannot get past `JV_CASH_LIMIT`.
- Wrong (b): the walk-in is ONE customer row for all anonymous buyers. The limit adds different people's cash, Y3 can pay one stranger's bill with another's money, and Z2 would save a PAN into the shared row.
- Wrong (c): any biller can bypass by typing 10 characters, so it is a log, not a control; it is also stronger than PLAN P2-T2's "a warning". QA CMP-08 wants per person per day, per transaction or per event; only per day is built.
- Fix: add the parameter to X2/X3 and a `cash_override_reason` column on receipts; require a named customer for credit and for cash at or above the threshold; PAN only on named customers; owner approval instead of free text, or warn-only until the CA rules; add the per-event question to O14; change CMP-08 to "partly closed".

**F10 | Medium | open | I1-I9, T-B14, section 15 | The safety net is not itself tested, and the money tests miss concurrency**
- Wrong: no test mutates a row to see each invariant fire (PLAN P1-T9 wants "a deliberately broken test row makes the nightly check say Problem"; I8 cites T-D14, which tests `audit_log`). Y6's post-condition, "never changes an existing allocation" and "sum of V1 pending = V2 outstanding" appear only in T-B05/T-B07, not in I1-I7; T-B14 is single-session. Concurrency covers two pairs (T-C04, T-C09). The other missing tests are in Q1.
- Do the money tests close the 13 critical themes? On paper yes for themes 3 to 12 at single-session level; not for theme 1 (concurrency) or LED-02/LED-04 once cancel, void and rebalance combine.
- Fix: add T-B18 (mutate one row per invariant, expect Problem), I10, T-C10 to T-C13 (F1, F5) and the missing tests of Q1; give T-E04 a requirement or move it to P3-T1.

**F11 | Medium | open | I6, R4, R7, O1, O2, O9, O12 | A later rule change breaks the nightly check on every old bill**
- Wrong: I6 re-prices stored lines with the current `private.price_bill`. O1/O2/O9/O12 are open "kept as coded" rules that will plausibly change after go-live (fine formula [CA], piroi unit). The first change makes I6 fail for all earlier bills or forces rewriting history.
- Fix: `bills.pricing_version smallint`; keep old versions of `price_line`/`price_bill`; I6 and `quote_bill` use the bill's version; one T-A15 case per version.

**F12 | Medium | open | X1, A4, A5, A9, R8, T-A08 | Unconfirmed power over prices and customer data (insider risk, a new role)**
- Wrong: X1 takes `metal_rate`, `labour_rate`, `piroi`, `other_charges` and `discount` from the caller and keeps no list price, so the owner cannot see sales below list by a biller; a 100% discount is allowed (grand total 0). Staff can edit `customer_net_weight`, `piroi` and the labour rates of any In Stock piece (A5). The biller reads every customer's PAN, GST and mobile and the whole ledger, and may edit customers (A9, A4). None of this is in O1-O21.
- Fix: store `list_metal_rate` and `list_labour_rate` per line (from `daily_rates` and the piece); add a "sold below list" line to the owner's check; add open items for biller read breadth and discount authority (default: as specified); optional owner approval above a discount percentage.

**F13 | Medium | open | A4 l.143, D6, D7, T-F01 | Changing a design's selling method silently reprices every piece**
- Wrong: the owner may change `selling_method` (the fix for QA INV-02). For By Weight, `labour_*` is Rs per gram; for Per Piece it is the piece price (D7, EditStockClient.tsx:17-23). Switching turns Rs 353/g into a Rs 353 piece. T-F01 tests only that the change propagates.
- Fix: refuse a `selling_method` change while any non-archived piece exists, or require new rates in the same call; test it.

**F14 | Medium | open | D4, R2, X1, T-A13; AddDesignClient.tsx:110-111 | 'Custom' purity and the rate guard**
- Wrong: the Add Design form offers 'Custom' for gold and silver (`GOLD_PURITIES = ['18K', '20K', '22K', '24K', 'Custom']`), saved as that literal. D4/R2 default the rate from `daily_rates` by (material, purity), so a Custom piece (or 20K/925 without a row) has no default; whether `metal_rate` is optional in X1 is unstated. T-A13 says pieces "take their own rates", which cannot be a database test if the client supplies the rate. The stale-rate guard is a screen rule; `create_bill` never looks at the rate date.
- Fix: remove 'Custom' or require the biller to type the rate; make `metal_rate` required in X1; return a `RATE_STALE` warning from `create_bill` (like `PAN_MISSING`); say which rate a backdated bill defaults to.

**F15 | Medium | open | B1, B2, B4, I8, T-R01, T-R02 | Backup failure is invisible and the restore scope is undefined**
- Wrong: B2 says a failed run shows "(the nightly check line, I8, or an email)", but I8 runs inside the database and cannot know that an external dump failed; no heartbeat is specified. "12 monthly copies by a lifecycle rule" needs a second prefix and a copy job (R2 lifecycle deletes by age; not checked). Dump scope is open: `profiles.id` references `auth.users`, so users must be in the dump, but B4 asks for "equal row counts in every table" without listing schemas. RPO 24 h is stated and never accepted by Siddhi. B1's date (about 2 Nov) differs from PLAN decision 3 (7 Oct).
- Fix: the dump job writes a `backup_runs` heartbeat through the API; the dashboard shows its age and goes red after 26 h; list the schemas dumped (auth, public, private, storage metadata) and the restore order; add a monthly prefix; add RPO as an open item for Siddhi.

**F16 | Medium | open | P1-P3, S7, X8, C11, T-D15 | Photo paths need an id that does not exist yet; storage rules are not written**
- Wrong: P2 paths are `designs/<design_id>/<uuid>.jpg`, but the screen uploads first (PLAN P1-T7) and X8 creates the id (S2, C11). P3 lets owner and staff delete objects while S7 says "No API role ... has DELETE on any table". No policy SQL is given. Any staff user can delete or overwrite any photo, and the R2 copy is up to 24 h old. PLAN wants a public and a private bucket; the spec has one.
- Evidence: access-control page: overwriting needs INSERT plus "additionally grant SELECT and UPDATE"; listing of public buckets is not documented.
- Fix: upload to `pending/<request_id>/` and pass the paths to X8 (they are plain text), or let X8 take a client `p_design_id`; staff insert only, owner delete; write the policy SQL; extend T-D15 with overwrite, delete and list.

**F17 | Low | open | U4 l.165, T-E01 | The 12-hour "inactivity timeout" does not log out an open counter tab**
- Wrong: the sessions page defines it as ending "sessions that haven't been refreshed within the timeout duration". A tab left open refreshes its token every hour, so it never goes inactive; only the 14-day time-box bites. T-E01 has no timeout test.
- Fix: reword U4; if Siddhi wants an idle logout, build the screen's 12 h idle logout for Pro as well; add a drill step.

**F18 | Low | open | V3 l.315, L4 l.186, Y8, T-B16 | Ordering ties and number/date mismatch**
- Wrong: V3 orders by (`entry_date`, `entry_at`, `id`). If `entry_at` is `created_at` (default `now()`, the transaction start), the invoice row and the payment rows of one `create_bill` tie and fall back to a random uuid, so a payment can list before its invoice. The bill number's year comes from save time, so an owner's backdated bill carries the new year; no test covers 23:59:59 on 31 Dec vs 00:00:01 on 1 Jan.
- Fix: add an event-order key to V3; state the year basis (save time, `bill_date`, or financial year [CA]); add the rollover test.

**F19 | Low | open | S4 l.85, T-A09 | Caps stop inputs but not computed amounts**
- Wrong: weight 100,000 g times rate 100,000,000 is 10^13, above `numeric(14,2)` and above the "any amount" cap of 10^9, so the user gets a Postgres overflow error, not `JV_INVALID_INPUT`.
- Fix: cap `metal_amount`, `labour_amount`, line total, subtotal and grand total, raise `JV_INVALID_INPUT`, test at the edges.

**F20 | Low | open | sections 0, 10, 14, 16; PLAN | Traceability and wording slips**
- Wrong: DAT-14 (High, "Settlement accounting loses or misplaces silver and cash") is never cited, though F2, Y1 and Y7 cover it; UI-03/UI-04 filed as M2; X10 and the section 10 intro disagree about X7; U9 and H6 are not in section 16; row 1 quotes "All functions access is PUBLIC by default" from the troubleshooting page, not the functions guide; `private.current_role()` shares its name with the SQL keyword CURRENT_ROLE (schema-qualified use should parse; not run here); A7 "only WARN allowed is 0029" may fail on auth-setting warnings the lint page does not list (not verified); PLAN differences are in Q3.
- Fix: add DAT-14 to the Y1/Y7/F2 rows; correct the M2 line; move U9/H6 to section 16; fix the citations; rename the helper (for example `private.app_role()`); whitelist known non-schema advisor warnings in T-D11.

**F21 | Low | open | R1, R3, U7, X6, X8, D10 | "As coded" statements that do not match the code**
- Six mismatches (M1 to M6 below). None changes the design; each needs one sentence in the spec.

## As-coded check (45 citations)
Match as cited (43): BillingPOSClient 34-39, 41-44, 46-51, 53-55 (and :54 piroi), 85, 98-100, 158-161; appStore 62-63, 105, 144, 154-159, 253-275, 350-397, 399-460, 441-455, 462-518; BillingSummaryPanel 95-115 (no quantity in the snapshot), 137, 149, 163-167, 285; AddDesignClient 37-64 (1200 px, JPEG 0.82, data URL), 1104-1141, 1124-1127, 1160-1164; EditStockClient 17-23, 62-65, 152-154; authStore 13-16; mockData 1-2, 63-78; settingsStore 36-82, 109; DashboardRateCard 25; designStore 11-20; BillingItemsTable 99, 144; EstimateViewClient 49-84 (Per Piece metal = rate, so BIL-05 confirmed); ReceivePaymentPanel 52; 16 files use `setInterval` (C9 says 16); store files total 1,408 lines (spec 1,400); importer counts 15/18/1/7/7/11 vs spec 15/17/1/6/6/11 (the extra file in three stores is a lib file). Two more have a wrong detail (M1, M2).
- M1 (R1, l.252): the spec states one fallback chain; the code has three. At creation wholesale blank -> retail (AddDesignClient.tsx:1126-1127). At billing Wholesale = wholesale ?? semi ?? retail ?? labour (BillingPOSClient.tsx:29). For legacy data semi = round((retail + wholesale) / 2, 2) (designStore.ts:45). The import (P3-T4) will meet the other two.
- M2 (U7, l.168): `app/page.tsx:17-23` reads the session in a mount effect, not synchronously, and the symptom is a missing rate card right after login (HomePage's state never updates after AppLayout's login), not "after a refresh". The cause (two separate session reads) is right; the fix is unchanged.
- M3 (X8, l.305): location "from `settings.business.location`" is not as coded; the code uses the constant `BUSINESS_LOCATION` (AddDesignClient.tsx:1129, 'Main Showroom'). The settings default is the same constant (settingsStore.ts:138). EditStockClient.tsx:13 also fixes a list of four locations (not in the spec).
- M4 (R3, R5): per-line `round(...,2)` is not coded (F8).
- M5 (D10, X6): the prototype requires name and mobile (CustomerSearchPanel.tsx:42-44); the spec is silent on mobile.
- M6 (C11, L4): the draft shows the next bill number (BillingPOSClient.tsx:70, 224) and Add Design shows the next design number (AddDesignClient.tsx:1018, designStore.ts:176); with counters neither exists before save. A visible change, not listed. The Estimate screen's date editor and edit mode (EstimateViewClient.tsx:113-159, `updateInvoiceDate`, `updateInvoice`) must also go (K1, Y8).

## Sources (spec section 0)
- Confirmed: #1 (the quoted sentence is on the troubleshooting page; the functions guide says "By default, any role can run a database function", shows both revokes, and "you must set the `search_path`"); #2 (all quotes exact); #3 (0028 and 0029 WARN; 0010, 0013, 0002, 0015 ERROR; 0011, 0003 WARN; "suppress" allowed); #7 ("READ COMMITTED"; rollback; nothing on locking); #8 (UPDATE waits, then re-checks WHERE; ON CONFLICT DO UPDATE "one of those two outcomes is guaranteed"); #9 (security_invoker); #10 ("last 7 days of daily backups"; "Database backups do not include objects you store via the Storage API"; PITR about $100 a month with a Small compute add-on; deleting a project deletes its backups); #11 (7 days; paid plans cannot be paused); #13 (public bucket bypasses access control for reads; max size and content types are bucket-level); #15 (Pages static export `npx next build` -> `out`, updated 25 Aug 2026; vinext note; `_headers` not applied to Functions, 100 rules, 2,000 characters a line; R2 10 GB-month, 1 M Class A, 10 M Class B, egress free); H6 (Next.js 16.3.0 docs: Chrome 111+).
- Partly: #4 (`(select auth.uid())`, editable user metadata and security_invoker are on the RLS page; the event-trigger example is not, it is on /event-triggers and `postgres` may create it; the "enable RLS yourself" sentence is not verbatim); #5 (the Pro-only note covers time-box, inactivity and single session; "timeout plus token expiry" not shown; inactivity is refresh-based, F17); #6 (max_rows 1000, enable_signup, jwt_expiry 3600 confirmed; timebox and inactivity default none; password settings absent, as the spec says); #12 (the deadlock bug is stated; the workaround is not); #14 (8 jobs and 10 minutes are "we recommend", not limits; time zone not stated, so open item (a) is right).
- Not confirmed: pg_cron time zone; password length and leaked-password settings (the passwords page has neither); R2 lifecycle for monthly copies; Workers static-assets headers page; `supabase test db --linked`. Open item (b) is now answerable (F6).

## Numbers recomputed (exact decimals)
- Worked example and T-A01: 35.42 x 6,920 = 245,106.40; 35.42 x 353 = 12,503.26; + 2.15 = 257,611.81; rounds to 257,612. Correct, and equal to QA TC-03.
- T-A06: 1,200 x 3 = 3,600.00 correct. T-A10: 1,000.50 -> 1,001 correct (1,000.49 -> 1,000). T-A11: 4.6 x 92.50 = 425.50 -> 426 correct. T-A12: 1,99,999.99 is below 2,00,000, correct.
- T-A04 and T-A05 carry no figures; add one (NW 13.9 g, labour 40/g: labour 556.00, fine 13.900, grand total 556). T-A08 "equal gives 0" follows the formula, not R8's wording.
- No expected value is wrong. The T-A10 note "`round_off` shown only when on" collides with D11 (F8).

## Implementability: where two engineers would build different things
1. X1 `metal_rate`: required, or null = "use today's rate"? (T-A13 implies the second.)
2. Y6 "oldest receipt first": by `paid_on` or `created_at`? Y3 with a named bill that is paid, cancelled or another customer's: ignore or error?
3. C4 `last_seen`: server or client time? Do polls page? What does the screen do with an optimistic row?
4. R8: test `discount > subtotal` or `before_round < 0`?
5. A8 "never change own role": trigger, policy or column grant? (A policy cannot see columns.)
6. L4: year basis for backdated bills; format after 9,999 bills.
7. B2: scheduler, dump scope, and what "visible the next morning" means (F15).
8. A4: view grants; `status` vs `archived_at` for pieces (F7).
9. Z1: which column holds the reason for a receipt (F9).
10. S8: how non-`JV_` errors (unique, deadlock 40P01) reach the user, and whether a retry reuses `p_request_id` automatically.
11. C3: what "owner reads all" means for `audit_log`, `check_runs`, `customer_ledger` (F3).

## Confirmed (no issue found)
- Worked example, T-A06, T-A10, T-A11, T-A12 figures; 69 tests and money core 42; open items numbered O1-O21.
- All 22 Critical IDs and 36 of 46 High IDs appear in the spec. The 10 absent High IDs: INV-05, INV-06, INV-07, UI-01, UI-02, UI-03, UI-04, UI-06, UI-07 (M2 or P3-T1) and DAT-14 (covered in substance, F20).
- Design choices I attacked and could not break: separate `sku_private` table; no direct writes to bills and receipts; composite foreign keys (D14); derived balances; `security_invoker` views (RLS page: views "bypass RLS by default"); counters by `INSERT ... ON CONFLICT`; piece locks plus conditional update (K2 holds under READ COMMITTED); polling over Realtime; static export with `_headers`.
- Audit triggers cannot leak the original weight: `audit_log` is owner-only (A4), `bill_items` snapshots exclude it (D12), `create_design` rejects it from non-owners (X8). No role can forge a bill number or status through the API (no insert or update grants; `status` is not a content column). `anon` cannot execute public functions once A6 is applied (F6 covers future objects).
- Screens checked against the hydrate sets: biller dashboard KPIs (bills, customers, designs are all readable), tag printing (pieces and `tag_template`), estimate print (bill, items, customer, `settings.business`), customer card (V2, V3). One gap: "created by" names, because profiles are "S own" only.
- `service_role` appears in the installed `@supabase/auth-js` 2.114.0 only in JSDoc comments (GoTrueAdminApi.js:310) and not in ota-platform's `.next/static`, so H3's string check is plausible; it must still run on the real build.

## Verdict: pass with fixes
Fix before the plan is written: F1 to F4 (High), then F5 to F16 (Medium) in the same pass; F17 to F21 (Low) may be fixed or ruled in the ledger. Questions only Siddhi or her CA can answer (F2 payment carry-over, F9 cash block, F12 biller powers, F15 RPO) need entries in section 16 with a default. Draft 2 needs a re-review of the changed lines only (Playbook 4).
