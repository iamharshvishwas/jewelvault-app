# Spec review 3, money half: check of the fixes to RM-1 to RM-16 (spec.md, 784 lines)
Reviewer: fresh agent (same reviewer as round 2; the spec was not edited)   Date: 14 October 2026
Read: spec-money-fixes.diff and spec-foundation-fixes.diff in full, and the changed text in context (X0 items 3 to 8, S4, S5, R1, R2, R14, K5, K6, Y1 to Y10, X1 to X5, X10, X12, V4, I3 to I13, Z1 to Z3, tests A, B, C, O-items, 18.5, 18.6). Line numbers are those of the 784-line spec.md.
Done on one throwaway PostgreSQL 17.11 in Docker (container removed at the end; scripts in `/private/tmp/claude-501/-Users-harshvishwas-Desktop-Claude-ota-platform/f4ae9f37-a19d-41c9-a1cc-eeff49c3f651/scratchpad/rm/`: model3.sql, fuzz3.sql, hook3.sql, runcase2.sh): the round-2 model rebuilt with every fix switchable, a two-session experiment on the test hook, three walk-in days, a row-damage test for I13.
Totals: 0 Critical, 0 High, 2 Medium, 5 Low (RM3-1 to RM3-7). Of the sixteen round-2 findings, twelve are resolved, two nearly (RM-9, RM-13) and two only partly (RM-8, RM-14). No money rule needs to change.

## Status of RM-1 to RM-16 (changed lines only)
| Finding | Status | Evidence |
|---|---|---|
| RM-1 | RESOLVED | Y6 l.319 "applies in total at most the customer's `advance` of V2", Y5 l.318, T-B20 l.512. Fix off: 57 of 80 sequences end in a negative advance (I10); on: 0 of 698 |
| RM-2 | RESOLVED | X4 l.347 and Y7 l.320 refuse a void that would leave the advance below 0. Off: 26 of 80 fail; on: 0 of 698 (the refusal fired 561 times in those runs) |
| RM-3 | RESOLVED | K5 l.309, X2 l.345, X5 l.348, X12 l.355, I10 l.383, T-B17 l.509. Off: 75 of 80 leave the walk-in an advance; on: 0 of 698. A shop day still works, see (3) |
| RM-4 | RESOLVED | I11 l.384 (walk-in cash total and bill count), O14 l.616; no test for the new I11 lines (RM3-4) |
| RM-5 | RESOLVED | D13 l.129 "A receipt has no `request_id` of its own"; T-B03 l.495 (two rows), T-B21 l.513 (two advances) |
| RM-6 | RESOLVED | X0 item 7 l.342 (`SET lock_timeout` clause, role bound), C4 l.214, S8 l.99; small leftovers in RM3-2 (d) and RM3-7 |
| RM-7 | RESOLVED | I5 l.378 (`seed_value + 1`), IM3/IM4 l.256-257 (same `private.rebalance`). On: 0 of 698 fail. Seed off: 80 of 80 fail; rebalance off: 49 of 80 fail with "advance and outstanding both above 0". Old I5 text after one X12 and one X1: "JV-2026 runs 2..2", new text holds |
| RM-8 | PARTLY | X0 item 8 l.343 and T-C09 to T-C14 use a hook, but the tests still pass without the customer lock: RM3-1, RM3-2 |
| RM-9 | MOSTLY | T-A02, T-A03, T-A04, T-A09, T-A15, T-B03, T-B14, T-B17, T-B20, T-B21, T-D05 extended. T-A15 "takes no row lock" is testable in one session (measured: `xmax` = my xid after `FOR UPDATE`, 0 otherwise). Gaps: RM3-4 |
| RM-10 | RESOLVED | X0 item 3 l.338 names X10; item 4 l.339 says nothing more is locked (round 2: the customer-first order gave 0 deadlocks in 18,267 transactions, bill-first 24 percent) |
| RM-11, RM-12 | RESOLVED | S4 l.95: decimals rule and a 1,000,000,000 cap on every payment, refund, discount, additional charge, opening balance and `fine_cash` amount; T-A09 l.478 |
| RM-13 | MOSTLY | V4 l.367 (a voided opening receipt adds nothing), I3 l.376, I6 l.379, I13 l.386. Old V4 text: 41 of 60 sequences fail I13; new text: 0 of 698. Left: RM3-3, RM3-7 |
| RM-14 | PARTLY | R14 l.297 (Per Piece on price), X1 l.344 (labour_rate required for By Weight), I11 l.384; the biller-set baseline is untouched: RM3-5 |
| RM-15, RM-16 | RESOLVED | S5 l.96 (`private.now_ts()`); K6 l.310, X10 l.353, 18.3 item 3 l.726, L5 l.204, R1/R2 l.284-285, Z1 l.396, Y3 l.316 |

## (1) The model with the fixed rules
Round-2 SQL model plus: Y6 pool, X4 refusal, the walk-in rules in X2/X5/X10/X12, numbered bills with `seed_value`, an import that calls the same rebalance, V4 with opening voids adding nothing, I5 (new text), I10 walk-in clause, I13. Three customers (one is the walk-in); the clock starts on 28 December, so almost every sequence crosses into a new year series.
- **Fixes on: 698 sequences** (400 x 200 operation slots, 98 x 400, 200 x 200 without an import): **114,321 accepted operations**, 18,596 refused with a JV code, 7,975 day advances, 2,743 refunds, 5,524 walk-in void-then-cancel flows. **0 failures** of I3, I4, I5, I10, I13, V2's outstanding/advance/balance relation or the closed-day check.
- Each fix switched off alone (80 sequences each, table above); with this mix a single 200-operation sequence catches a missing pool limit 71 percent of the time, the walk-in rule 94, the import rebalance 61, the void refusal only 33. Three seeds (T-B14) would miss the void refusal about 31 percent of the time, so the explicit T-B20 case matters; keep it.

## (3) Does the walk-in rule make a shop day impossible? No, but it adds steps (scripts, checks green)
- A 5,000 cash sale returned the same day: X5 alone is refused; void the receipt, then cancel: walk-in advance 0, V4 shows 5,000 in and 5,000 out on the day.
- Re-issue: 5,000 up to 5,500 with 500 more works; 5,000 down to 4,800 is refused ("surplus over the new bill") until the receipts are voided, then it works.
- Part-paid bill (6,000 of 10,000): a later 4,000 works, 5,000 is refused (`JV_OVERPAYMENT`); cancelling it needs the void first.
- Weak points: one unnamed walk-in receipt of 6,000 paid two strangers' bills (4,000 and 2,000); cancelling the first needs that receipt voided, which re-opens the second stranger's bill too (RM3-6).

## (4) Does the hook make T-C09 to T-C14 fail when the customer lock is removed? (48 two-session runs)
Method: hook replaced and committed, one gate per session, controller releases S1 or S2 first. With the lock the tests passed in every case and order (valid implementation is green).
| Test | Lock removed, hook | Reading |
|---|---|---|
| T-C09 two payments | FAIL in both orders ("bill over-allocated") | detects |
| T-C10 bill beside payment | FAIL only if S2 is released first (S1 first: PASS) | order-dependent |
| T-C11 two bills, advance 300 | PASS in both orders | cannot detect (RM3-1) |
| T-C12 void beside payment | FAIL only if S2 first | order-dependent; row has no hook text |
| T-C13 cancel beside payment or bill, re-issue beside payment | FAIL in both orders | detects; row has no hook text |
| T-C14 identical requests | PASS (not about the customer lock); FAIL when the idempotency row is stored last | right |
Replacement made "inside the test's own session" (not committed) or no hook: every case PASSES without the lock.

## Findings
**RM3-1 | Medium | T-C11 l.533, X0 items 6 and 8 | Two `create_bill` cannot show a missing customer lock**
- The bill number is taken before the rebalance and held to commit, so the second call waits on the counter, never reaches the hook (measured with the lock removed: one session at the hook, one waiting on another lock). With the number from a sequence instead, the same test FAILS ("money receipt over-allocated", 600 on a 300 receipt).
- Fix: build the test from `create_bill` beside `record_payment`, `void_receipt` or `cancel_bill` (a writer that takes no number); keep the 300 advance. Class: small.

**RM3-2 | Medium | X0 item 8 l.343, T-C09 to T-C14 l.531-536 | The hook text does not yet make the tests fail without the lock**
- (a) "`create or replace`, inside the test's own session": a second connection does not see an uncommitted replacement; every case passed. Say: committed before the sessions start, restored after (DB2 already cleans up).
- (b) One shared gate gives a result that depends on the release order (T-C10, T-C12). Say: one gate per session, S1 held at the hook, S2 released first.
- (c) The allocation must use what was read before the hook; with a re-read after it, T-C10 PASSES without the lock. Say so.
- (d) The hook sits in functions with `SET lock_timeout = '5s'`; a plain advisory-lock wait is cut off after the limit (measured: error 55P03 at 1 s with a 1 s clause, which X0.7 turns into `JV_BUSY`). Say: hold less than 5 s or poll with `pg_try_advisory_lock`.
- (e) T-C12 and T-C13 are unchanged (no hook text) although 18.6 says T-C09 to T-C14 use it; plain runs pass. Add the scenarios above. Class: small.

**RM3-3 | Low | T-B18 l.510, I13 l.386, l.390 | No damaged row can fire I13**
- Eight single-row damages (change an amount, clear `voided_on`, un-void, clear `is_opening`, move a date, change a kind, delete a refund, change a mode) left I13 green: both sides read the same rows. Only the old V4 text fires it ("Other = -400.00 but receipts say 0"). Fix: T-B18 for I13 says "replaces V4 with the old definition inside the transaction". Class: small.

**RM3-4 | Low | T-B24 l.516, T-A17, T-B13 | New rules without a test**
- T-B24 is unchanged: the walk-in line, the `fine_cash` rate flag, the sale-type flag and "Per Piece on price only" (I11, R14) are untested; `labour_rate` required for By Weight and the defaults for absent `piroi`, `other_charges`, `quantity` (X1), a zero payment row ignored and a 0.00 `fine_cash` refused (Y3) have no case. Class: small.

**RM3-5 | Low | R14, I11 l.384, O26 l.628 | The biller-set baseline and the "day's silver rate"**
- A biller adds today's rate (O4), so the list a line is compared with can come from the same person; the fix added three review items but not "rates entered by a biller that move more than `rate_flag_percent`". "The day's silver rate" is undefined when silver has 800, 925 and 999 rows. Class: choice (Harsh), O26.

**RM3-6 | Low | K5 l.309, X5, X2 | Walk-in friction (an option, not a defect)**
- Cancel and a downward re-issue use a void as the refund; a receipt that spans two strangers' bills voids both. An unnamed walk-in payment still goes to the oldest walk-in bill, which may be another stranger's. Option: for the walk-in, X2 needs a named bill and no more than its pending; X5 takes a refund mode and records the refund in the same call. Class: choice (Harsh, Siddhi), O6.

**RM3-7 | Low | wording leftovers**
- (i) Section 13 intro lists the constants without `rate_flag_percent` (D18 and I11 have it). (ii) 18.3 item 7 says I1 to I7 and I10 (I13 now). (iii) Y7 and V4 send the reader to O3 for "a back-dated receipt changes an earlier day", but O3 does not say it. (iv) X10 has no walk-in sentence (only K5). (v) Z3 says `JV_INVALID_INPUT`, D10 says a `CHECK`: a direct edit gives a raw check error. (vi) S5: defaults and triggers keep `clock_timestamp()`, so a faked clock mixes fake dates with real stamps. (vii) T-C15: `set local role authenticated` does not apply the role's `statement_timeout` (measured: `show` gives 0, a 2.2 s sleep ran under a 1 s role setting), so "cancelled at 15 s" needs one API call; test `pg_roles.rolconfig` in DB2. (viii) X0 item 8 says "each writing function"; X6, X8, X9 have no customer state. Class: small.

## Confirmed in this round
- Every fix does what it says in the model; the five switches each break something when turned off, so tests built on them have teeth. The year-rollover series, the import, the walk-in flows and V4's closed-day rule all stayed green.
- No contradiction between S4, S5, R14, X1, Y3, Y5 to Y7, K5, K6, X4, X5, X10, X12, I3, I6, I10, I11, I13 and the tests, apart from the small ones in RM3-7.
- X0 items 3, 4 and 7 contradict nothing in the new text; the hook is empty in production and `private.test_pause` stays unreachable (A3).
## Limits
- A model of money only (no pieces, RLS, screens, PostgREST); concurrency on a small schema that follows X0, not the real functions; the Supabase role timeout comes from its docs page. Legal points not checked. 698 sequences is evidence, not proof.
## Verdict: pass with fixes
Fix RM3-1 and RM3-2 (test text only) before the plan's task list; RM3-3 to RM3-7 may be fixed or ruled in the ledger (RM3-5 and RM3-6 need Harsh). No money rule needs to change, and the 698 clean sequences give no reason to hold the plan back.
