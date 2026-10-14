# Spec review 2, money half: P1 foundation and money (spec.md, DRAFT 2, 727 lines)
Reviewer: fresh agent (did not write the spec; the spec was not edited)   Date: 14 October 2026
Version: line numbers (l.nnn) are those of the 727-line Draft 2 I read; a copy is `spec-draft2-as-reviewed.md`. spec.md has since grown to 761 lines; I did not review those edits.
Scope: Part B sections 8 to 13; the Part A rules they use (S3 to S8, D4, D10 to D15, D17, D18, D23, A4 to A6, L3 to L6, C4, C5); tests A, B, C; money rows of section 14; open items O1 to O3, O6 to O9, O12 to O14, O22 to O27.
Read: Draft 2 in full; spec-review.md; Playbook 3.1 and 4; ledger; PLAN P1/P2; the 22 prototype citations of Part B (BillingPOSClient, BillingItemsTable, BillingSummaryPanel, appStore, AddDesignClient, designStore); QA T2, T3, T5, T7 (BIL-04/12, LED-04 to 07, DAT-14/16, CMP-06 to 08); the Supabase "timeouts" page.
Done, on one throwaway PostgreSQL 17.11 in Docker (container removed at the end; my scripts stay in `/private/tmp/claude-501/-Users-harshvishwas-Desktop-Claude-ota-platform/f4ae9f37-a19d-41c9-a1cc-eeff49c3f651/scratchpad/rm/`: model.sql, fuzz.sql, lk_setup.sql and others):
- A SQL model of the money half as Draft 2 words it (D11 to D15, Y1 to Y10, K3, X1 to X5, X10 to X12, V1 to V4, I3, I4, I10, plus a V4 tie-out and a closed-day check), driven by random operations: 1,305 sequences of 200 to 400 operations covering cancel, void of every receipt kind, re-issue, refund, opening balances, fine_silver, fine_cash, named-bill payments, advances, the walk-in and back-dated entries.
- Two-session tests of the idempotency insert, the customer lock and the timeouts; a lock-order stress with pgbench (18,267 transactions); exact-decimal recomputation of the pricing tests and a 200,000-bill rounding simulation.
Totals: 0 Critical, 1 High, 8 Medium, 7 Low. The skeleton holds: in the model, with RM-1 and RM-2 fixed, no sequence broke V1 to V4, I3, I4 or I10. Both breaks come from refunds.

## Checklist answers (Playbook 3.1, money scope)
1. **Testable?** Every R, K, Y, X, V, I and Z rule has a test. Gaps: tests that cannot fail, missing cases, no clock hook (RM-8, RM-9, RM-15).
2. **Unsupported?** X0.7 and C4 rely on `statement_timeout` working from inside a function; it does not (RM-6). R7's "about 0.8 percent" is the round-1 figure; I reproduced it (0.756 percent).
3. **Contradictions?** Part B against Part A: D13 `request_id unique` vs X1(i) and X12 (RM-5); C4/X0.7 vs S8 (RM-6, RM-16); S4 vs T-A09 (RM-12); L5 "once per user action" vs C5(b) "fresh p_request_id" (RM-16). Inside Part B: K6 vs X10 and the function count in 18.3 (RM-16). With QA: none new (DAT-16, CMP-08 are flagged O23, O14). With PLAN: P2-T1 says "create a customer with an opening balance"; Draft 1's X6 did that in one call, Draft 2 needs X6 then X12 and 18.3 does not list the change.
4. **Legal/tax for the CA?** Mostly yes (Z1 to Z3, O2, O14, O15, O20). Not marked `[CA]`: refunds of money received against an estimate (X11) and silver settled in cash (Y1). Z2 refuses a walk-in bill at exactly 2,00,000 although research row 19 says the PAN rule applies to sales "exceeding" 2 lakh; section 13 does flag "at or above, or above" for the CA, but Z2 is a hard block.
5. **Built for unconfirmed cases not in section 16?** The walk-in holding an advance (RM-3); sales leaving the day a cancelled bill was made on (V5) and a void shown on its own day (Y7) are visible behaviours with no open item.
6. **Scope?** Inside P1+P2; X11 is named first to leave M1; the effort re-estimate is flagged (18.3 item 9).

## Findings
Format: RM<n> | severity | spec line or ID | title. Class: **small** = a defect the spec itself mandates (fix at once); **choice** = design or visible behaviour for Harsh (and the CA where marked).

**RM-1 | High | Y6 l.318, Y5, V2 l.363, Y10, X11 l.352 | The rebalance spends refunded money a second time**
- Wrong: V2 says `advance = received - allocated - refunded`, but Y6 applies "the customer's unallocated receipt amounts" and Y5 defines an advance as "an unallocated part of an active receipt", that is per receipt: `amount` minus live allocations. A refund belongs to no receipt, so the refunded part still looks unallocated. X11's "rebalances (nothing to apply)" is true only until the next bill.
- Evidence (model, Y6 as written): Ravi pays 2,000 (advance); the owner refunds 500; Ravi buys 1,800 and pays nothing. Result: the bill shows received 1,800, pending 0 ("Paid"); V2 outstanding 0, advance -300, balance +300; I10 "negative figure". The shop is owed 300 and every pending figure says 0. With the pool limited to V2's advance: pending 300, advance 0, all invariants true.
- Evidence (random driver): Y6 as written fails I10 in 298 of 300 sequences (shortest: 5 operations); with refunds switched off it fails in 0 of 120, so refunds are the whole cause. T-B14 would find it (fail first), but two engineers would repair it two ways.
- Fix: Y6 applies in total at most V2's `advance`, oldest receipt first. Add a T-B20 case: advance 2,000, refund 500, bill 1,800 unpaid gives pending 300, advance 0. Class: small.

**RM-2 | Medium | X4 l.345, Y7, Y10, I10 | Voiding a payment that was already refunded makes the advance negative; X4 has no rule**
- Evidence (RM-1 fixed): pay 2,000, refund 500, void the 2,000: received 0, refunded 500, advance -500, balance +500, outstanding 0; the nightly check goes red after two ordinary owner actions. Driver: 198 of 300 sequences fail, every one on a `void_receipt` after a refund; with the guard below, 0 of 585.
- Fix: X4 raises `JV_NOT_ALLOWED` ("void the refund first") when the advance after the void would be below 0; a payment that bounced after a refund is booked as dues with X12. Add to T-B20. Class: choice (recommended default: refuse).

**RM-3 | Medium | K3 l.306, Y6, X2, K5, O6 | The walk-in row is one customer for many strangers, so their money and dues mix**
- Evidence: stranger A pays 5,000 for a bill; the goods come back (X5); stranger B buys 3,000 and pays nothing. B's bill shows received 3,000, pending 0, and the walk-in keeps an advance of 2,000. Z2 fixed only the cash limit (the rest of round-1 F9b); O6 asks about walk-in credit, not the walk-in advance.
- Fix: the walk-in never holds an advance: X5 and X10 on a walk-in bill with receipts refuse unless a refund is made in the same call, and X2 on the walk-in takes no more than its pending dues. Add to O6 and T-B17. Class: choice (Harsh, Siddhi).

**RM-4 | Medium | Z2 l.394, O14, I11 | Z2 is bypassed by splitting; the biller picks walk-in or named**
- Wrong: for the walk-in "cash is never added up over a day". Two walk-in bills of 1,50,000, both paid in cash on one day, trigger neither `JV_CASH_LIMIT` (each payment is under 2,00,000), nor the refusal (each bill is under 2,00,000), nor `PAN_MISSING`: 3,00,000 of cash from one payer, which a named customer would have stopped. This is what remains of round-1 F9b.
- Fix: put the walk-in's cash total and bill count for the day in the I11 review line and on the dashboard, and ask the CA (O14) whether cash above a lower figure (for example 50,000) needs a named customer with a mobile number. Class: choice (Harsh, CA).

**RM-5 | Medium | D13 l.129, D11, X1(i) l.342, X10, X12 l.353 | `request_id uuid unique` on receipts breaks a bill with two payment modes**
- Wrong: X1(i) inserts "one `money` receipt ... per payment row"; X12 inserts a receipt "for each advance" (money and silver); X10 repeats X1(i). Each would carry the same `p_request_id`, so the second insert fails (reproduced on a table with the same constraint: `duplicate key value violates unique constraint`) and the biller sees "Could not save". The prototype's "+ Add Mode" and QA TC-25 use several rows; no test in section 15 uses two payment rows.
- Fix: drop `receipts.request_id` (L5's table already guards repeats) or make it unique together with the line number. Add a two-row test to T-B03 and a two-advance test to T-B21. Class: small.

**RM-6 | Medium | X0 l.341 (items 1 and 7), C4 l.214, S8 l.99 | The timeout rule does not do what C4 relies on**
- Evidence (PostgreSQL 17.11): `set local statement_timeout = '1s'` in a function body followed by `pg_sleep(3)` finished after 3.0 s; a function-level `SET statement_timeout = '15s'` under an outer 2 s limit was cancelled at 2.0 s, and a clause of 1 s under a 20 s limit did not fire. The running call keeps the limit it started with. On Supabase that is the role limit (docs page: `authenticated` 8 s); the docs' function-level example (3 s of work under a 4 s clause under an 8 s role limit) never tests the clause.
- Evidence: `lock_timeout` set in the body works for later waits (1 s), but item 1 (the idempotency insert) runs before item 7: a duplicate request waited the full 5 s; with `SET lock_timeout` as a CREATE FUNCTION clause it stopped at 1 s.
- C4's conclusion still holds, for a different reason: every `updated_at` a function writes is stamped after that function's last lock wait (customer, pieces, counter), so the commit lag is CPU time, not 15 s. Say that instead of "statement_timeout".
- Fix: `SET lock_timeout = '5s'` in each CREATE FUNCTION; delete `statement_timeout = '15s'` from X0.7 and C4 and name the role limit as the whole-call bound; make S8 say JV_BUSY (as X0.7 does); add to T-C15 that a call over the role limit rolls back. Class: small.

**RM-7 | Medium | I5 l.376, IM3/IM4 l.255-256, X12, A6 | I5 and I10 are not import-proof**
- Wrong: I5 wants numbers "contiguous from 1" among bills with no import batch, while IM3 seeds the counter at the highest imported number. After the import the first X12 bill is `OB-` N+1, so the nightly check goes red on the first correction or new customer.
- Wrong: X12 starts with the role check (A6), which the import (database owner, no profile) cannot pass. If the import inserts rows itself, nothing nets a customer's imported dues against an imported advance and I10 fails on night one (IM4 lists I5, I6, sales and cash, not I10).
- Fix: I5 "contiguous from the first number in the series that has no import batch"; one `private.rebalance(customer)` used by X12 and by the import; add I10 to IM4 and to T-C16. Class: small.

**RM-8 | Medium | T-C09 to T-C14, X0 | The concurrency tests would pass with the lock removed**
- Evidence (model): two simultaneous `create_bill` for a customer holding a 300 advance, customer lock removed, no hook: 0 of 120 trials broke I3 (and 0 of 120 with the lock). With a pause between the read and the insert the break is certain: 600 allocated on a 300 receipt without the lock, 300 with it.
- "Hold the customer row lock in session 1" does not prove the lock either: the call waited 2.96 s with the explicit lock removed, because the bill insert's foreign key takes a key-share lock on the same row. T-C14 ("in flight at the same moment") has the same problem.
- Fix: T-C09 to T-C14 use a pause hook, `private.test_pause(name)`, a no-op in production and replaced inside the test database by an advisory-lock wait, at "after the read, before the allocation". Add one stress run (8 sessions, 200 mixed calls, 3 customers including the walk-in, 12 pieces; no 40P01; I1 to I10 true) and say what T-C15's randomised run contains. Class: small.

**RM-9 | Medium | section 15 A, B, C | Missing and weak money tests**
- No test for: refund then bill (RM-1); void after refund (RM-2); a bill with two payment rows (RM-5); X12 with money and silver advances; a voided opening advance in V4 (RM-13); the walk-in advance (RM-3); X7 "writes nothing, takes no locks" (T-A15 compares output only); fine = 0 for Semi-Wholesale silver and Wholesale gold, and a named 925 piece in T-A04 (a purity-based mutation passes if the piece has no purity); a biller inserting a rate for another date (D4, T-D05); the PAN pattern, which T-A12 files under `create_bill` but Z3 puts on the customer row.
- Weak: T-A02 and T-A03 test screen fallbacks inside DB tests; T-A15 has one version, so version handling cannot fail; T-B14 states no operation mix or oracle (the driver found RM-1 in 99 percent and RM-2 in 66 percent of seeds, so three seeds do find them if the mix includes refunds and voids). Class: small.

**RM-10 | Low | X0 item 3 l.337 and item 4 | X10 is missing from "find the customer, lock it, re-read"**
- X10 gets only the old bill id, so it cannot lock the customer before reading, exactly like X4 and X5, yet the sentence names only those two. Evidence: with the spec's order, 18,267 pgbench transactions (12 and 24 clients) gave 0 deadlocks; with X10 locking the old bill first, 139 of 573 deadlocked (24 percent). Fix: name X10 in the sentence. Item 4 ("rows it changes, by id") cannot be followed for the rebalance and is redundant under item 3; say so. Class: small.

**RM-11 | Low | S3, S4, X1, X2, I6 | Inputs with more decimals than the column are priced unrounded and stored rounded**
- Evidence: a rate of 6,920.005 on 35.42 g prices the metal at 245,106.58, but the column keeps 6,920.01 and the I6 re-run gives 245,106.75, a difference of 0.17, so the nightly check cries wolf. The same applies to discount, payments and `fine_cash`. Fix: S4: more than 2 decimals on a rate or amount, or more than 3 on a weight, raises `JV_INVALID_INPUT`; add to T-A09. Class: small.

**RM-12 | Low | S4 l.95, T-A09 | Draft 2 dropped the cap on typed amounts**
- Draft 1: "any amount is at most 1,000,000,000". Draft 2 caps only line amount, line total, subtotal and grand total, yet T-A09 still expects payment, discount, additional and piroi caps. Payments, refunds, opening balances and `fine_cash` (grams x rate can exceed 10^12) can still reach the `numeric(14,2)` overflow ("less than 10^12", measured) and give a raw error. Fix: restore the clause for every amount a person types or a function computes. Class: small.

**RM-13 | Low | V4 l.365, Y7, I3 l.374, I6 l.377 | Small gaps in the views and invariants**
- V4: "a voided receipt adds the reverse amount on the day of the void" read literally also reverses a voided opening advance that V4 never counted (model: a phantom -400 in the Other row); say "except `is_opening`". V4/Y7 also say a closed day "never changes", which holds for voids but not for the owner's back-dated receipts and refunds (Y8); say so under O3.
- I3: "no live allocation points to ... a voided receipt" is empty, because a live allocation by definition has an active receipt; drop it or define it as `released_at is null` only. I6 checks lines, subtotal, grand total and round_off but not `bills.fine_weight_due` = sum of the lines, which V2 `fine_billed` uses.
- Add I13: for each mode, the sum of V4 `net` equals active money and `fine_cash` receipts (not opening) minus active refunds. The model passed it in every run, so it is cheap and guards the void-day logic. Class: small.

**RM-14 | Low | R14 l.296, I11, X1 l.342, X3 | List-price report: baseline and optional fields**
- A biller may add today's rate (O4), so the "list" a line is compared with can be set by the same person. For Per Piece lines `labour_rate` is unused (R3) but `list_labour_rate` is the piece price, so a client sending 0 makes every Per Piece line "below list". X1 says only `metal_rate` is required: are `labour_rate`, `piroi`, `other_charges` optional (null = list)? The `fine_cash` rate is typed and never reviewed; a sale type different from the customer's (R9) is not reviewed.
- Fix: compare Per Piece on the price only; require `labour_rate` for By Weight; add to I11 the rates entered by a biller that move more than a set percent, `fine_cash` rates away from the day's silver rate, and sale-type changes. Class: choice (Harsh), O26.

**RM-15 | Low | T-B16, T-F07, T-B25, S5 | DB tests cannot set the time**
- "A bill saved at 23:30 and one at 00:30" and "23:59:59 on 31 December" need a clock the test controls; S5 uses `now()`. Fix: `private.today()` and `private.now_ist()` read an override that exists only in the test database and is unreachable from the API. Class: small.

**RM-16 | Low | wording and counts | Small contradictions and open words**
- K6 ("a cancelled bill can be re-issued only once", error `JV_NOT_ALLOWED`) vs X10 (the old bill must be `active`, so a repeat meets a cancelled bill; the code is unspecified, X5 uses `JV_BILL_CANCELLED`).
- 18.3 item 3: "twelve callable functions (X1 to X6, X8 to X12) and one read-only function (X7)" is eleven writers plus X7 (twelve callable); the round-2 brief repeats the slip. T-D09 should list twelve.
- L5 "once per user action" vs C5(b) "fresh p_request_id": the new-customer flow calls X6 then X1; say one id per call. S8 says a lock timeout is a generic 55P03 while X0.7 says JV_BUSY.
- R2 labels the by-purity, by-date default "(as coded, BillingPOSClient.tsx:98-100)", but the code reads one settings rate per material (`estimateSettings.defaultGoldRate`, line 100); it is the BIL-10 fix. R1 omits the Semi-Wholesale order (semi, wholesale, retail, labour).
- Z1's "(X1 and X10 for the cash payment rows, X2, X3 for fine_cash)" reads as if X2 skipped cash payments; say X2 for Cash payments, X3 for fine_cash, X10 through X1's rules.
- Y3 "something pending": money or fine for the named bill in X2? A payment row of amount 0 (the screen's default row) is ignored or rejected? `fine_cash` with `round(grams x rate, 2)` = 0.00 violates D13 `amount > 0` and gives a raw error. Class: small.

## (a) Round-1 findings in scope
| Finding | Status | Evidence |
|---|---|---|
| F1 | PARTLY | X0 item 3 "takes this lock before it reads anything" is necessary and sufficient for case A (measured 600 vs 300 allocated); no cycle in 18,267 transactions. Open: Y6's post-condition is false with refunds (RM-1), timeouts (RM-6), tests cannot fail (RM-8), X10 (RM-10) |
| F2 | PARTLY | Re-issue keeps the money ("the new bill first", overpayment counts what was carried), refund (X11) and "a void shows ... on the day it is done" all verified in the model. Open: RM-1, RM-2, K6 wording; silver stays credit (O24) |
| F5 | RESOLVED | L5 "first statement ... ON CONFLICT DO NOTHING": the overlapped copy waited 2 s and returned `{"bill_id": 1, "replayed": true}`, one row; another cart refused; a failed first request left no row. Open: RM-5, RM-6 |
| F8 | RESOLVED | D11 "round_off ... may be negative"; R8 "`before_round` must be at least 0"; I7 excludes it; -0.40 for 1,000.40 verified; R7 calls per-line rounding new (O22) |
| F9 | PARTLY | `p_cash_override_reason` on X1 to X3 and X10, `cash_override_reason` on bills and receipts, owner-only override and the walk-in rule exist; CMP-08 "partly closed" is right. Open: RM-3, RM-4 |
| F10 | PARTLY | T-B18 (mutation, I1 to I7 and I10), I10 and T-C10 to T-C15 added. Open: RM-8, RM-9 |
| F11 | RESOLVED | R13 `pricing_version`, I6 "for the bill's `pricing_version`", X7 `p_pricing_version`. T-A15 cannot test a second version (RM-9); I6 omits `fine_weight_due` (RM-13) |
| F12 | PARTLY | R14 server list prices, I11, O25, O26. Open: RM-14 |
| F14 | RESOLVED | R2 "required by X1", RATE_MISSING and RATE_STALE, O27, T-A17 |
| F18 | RESOLVED | V3 order key (entry_date, entry_at, kind_rank, id): the last running balance equalled V2 `balance` in every run; L4 year basis and O31 stated; the rollover test needs RM-15 |
| F19 | RESOLVED | S4 caps computed amounts, T-A18; but see RM-12 |
| AC1, AC4 | RESOLVED | R1 states three chains; R7 "Per-line rounding to paise ... is new", O22 |
| Q1, Q2, Q4, Q9 | RESOLVED | `metal_rate` required; oldest receipt by `paid_on`, `created_at`, `id` and a bad named bill is `JV_INVALID_INPUT`; `before_round >= 0`; `cash_override_reason` on bills and receipts |
| Q10 | PARTLY | generic message and one retry with the same id (S8); S8 and X0.7 disagree on JV_BUSY (RM-16) |

## As-coded check, Part B (22 citations)
All match except two: R2's by-purity, by-date default is labelled "as coded" (RM-16), and R1 omits the Semi-Wholesale chain. Matches include BillingPOSClient 28-32, 34-39, 41-44, 46-51, 53-55, 98-100, 158-161; BillingItemsTable 99, 144; BillingSummaryPanel 95-115, 137, 149, 285; appStore 62-63, 154-159, 253-275, 350-397, 441-455, 462-518; designStore 45; AddDesignClient 1124-1127. R8's "Math.round whether or not the setting is on" is true (BillingSummaryPanel.tsx:149, appStore.ts:271).

## Numbers recomputed (SQL numeric, exact)
T-A01: 35.42 x 6,920 = 245,106.40; 35.42 x 353 = 12,503.26; + 2.15 = 257,611.81; rounds to 257,612 (also QA TC-03; QA TC-09 513,431.40 -> 513,431, round-off -0.40). T-A04: 13.9 x 40 = 556.0 (state "piroi and other charges 0"). T-A05: 2 x 1,200 = 2,400.00. T-A06: 3 x 1,200 = 3,600.00. T-A10: 1,000.50 -> 1,001; 1,000.49 -> 1,000; 1,000 - 1,000.40 = -0.40. T-A11: 4.6 x 92.50 = 425.50 -> 426; in floating point 4.6 x 92.5 = 425.49999999999994, which rounds to 425, so the test fails a float build (good). T-A12: 1,99,999.99 is below 2,00,000. Per-line rounding: 200,000 random bills (1 to 8 lines) differ by Rs 1 from the float prototype on 1,512 = 0.756 percent. No expected value is wrong. 10^13 overflows `numeric(14,2)`.

## Implementability: where two engineers would differ
Y6 with refunds (RM-1); `request_id` on receipts (RM-5); which X1 item fields are optional (RM-14); Y3 "something pending" for X2 and a zero payment row (RM-16); how a test creates an interleaving (RM-8) or sets the clock (RM-15); whether the import calls the rebalance (RM-7).

## Confirmed (attacked and could not break)
- Lock order: each of the eleven writers (X1 to X6, X8 to X12) takes idempotency, customer, (uncontended customer rows), pieces by id, counter last; after the counter nothing contended is taken; X8 and X9 take no customer lock, so the wait-for graph has no cycle. pgbench, 3 customers, 12 pieces, shared counters: 11,261 + 7,006 transactions, 0 deadlocks. The customer lock removes the lost allocation of case A.
- Idempotency insert-then-read is correct under READ COMMITTED for overlapping identical requests, a failing first request and a different cart (3 cases).
- Counter `INSERT ... ON CONFLICT DO UPDATE`: 2,424 transactions, 30 percent rolled back, 16 clients: 1,671 numbers, contiguous, none repeated.
- V1 to V4 formulas, I3, I4, I10, a V4 tie-out and a closed-day check: 0 violations in 300 sequences of 200 and 285 of 400 operations once RM-1 and RM-2 are fixed; Y6 as written was also clean over 120 sequences without refunds. Y6 is run by X1, X2, X3, X4, X5, X10, X11 and X12.
- Pricing: R3 to R8 agree with the prototype lines; per-line paise rounding, negative `round_off` and I6 define the same totals; R13 is enough for a rule change (old bills keep their version).
- Z1: it sums Cash and `fine_cash` of one customer and one `paid_on` across X1, X2, X3 and X10 under the customer lock, ignores refunds and opening rows, and only the owner can override; splitting one day's cash across functions or receipt kinds does not get round it (the limit is per day by design, O14; only the walk-in gets round it, RM-4).
- Pieces after each path (read, not run): X5 returns only pieces whose `sold_bill_id` is the bill; X10 releases and re-sells in one transaction with locks by id; X11 touches no pieces. Money after each path was run in the model.
- Dates: among the function inputs only `p_bill_date`, `p_paid_on` and `p_as_of` carry a date, and Y8 limits them; no path lets a biller back-date (the exception is `daily_rates.rate_date`, RM-9).

## Limits
- No Supabase or PostgREST: timeouts were measured on vanilla PostgreSQL 17.11; the Supabase role limits come from its docs page, and how PostgREST applies them per request was not verified (its page answered HTTP 429).
- The model is my reading of Draft 2 and covers money only (no pieces, cash limit, RLS, polling, screens); where the text is open I took the literal reading (Y6 "as written") and tried the fix. Concurrency used a small schema that follows X0, not the real functions.
- Legal points not verified. `pricing.ts`, Part A screens and the cache were not reviewed. Docker: one container (`jv-rev-pg`, data on tmpfs, so no anonymous volume), removed with `docker rm -fv`.

## Verdict: pass with fixes
Fix RM-1 at once (one sentence plus one test), then RM-5, RM-6, RM-7, RM-8, RM-9 in the same pass; ask Harsh about RM-2, RM-3, RM-4 and RM-14 (recommended defaults given). The Low items may be fixed or ruled in the ledger. Then re-review only the changed lines (Playbook 4).
