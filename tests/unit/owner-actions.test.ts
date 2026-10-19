// WEB11 (PT-W11, unit half; spec C13, X4, X5, X10, X11, X12, K3, K6, Y8, Y10): the owner's actions without the screens, in src/lib/ownerActions.ts.
//
//   - the bodies: a reason of 3 to 500 characters once trimmed (X4, X5, X10), a refund (amount above 0, one of the five modes, no date: it is today), an opening balance (at least one
//     figure above 0, a date up to today, an advance never for the walk-in) and the re-issue body (the corrected bill without its customer, with the reason);
//   - the money goes out as text, never a number (S3), and the same screen typed two ways makes the same body (so the same Idempotency-Key);
//   - the answers: what the dialog shows once the API has answered, worked out from the rows of the answer (the money a cancel released and how much of it went to other bills, the
//     bills a void re-opened, the advance a refund left, the bill and receipts an opening balance made);
//   - the re-issue answer is shown by the billing screen as a saved bill (`reissueAsCreated`).
//
// The words of a refusal are in tests/unit/error-map.test.ts.
//
// Run: npm test -- tests/unit/owner-actions.test.ts      (or: npm test -- -t PT-W11)
import { describe, expect, it } from 'vitest';
import type {
  BillSummaryRow,
  CancelBillResponse,
  IssueRefundResponse,
  OpeningBalanceResponse,
  ReissueBillResponse,
  VoidReceiptResponse,
} from '@/lib/api/types';
import type { BillBody } from '@/lib/billing';
import {
  REASON_MAX,
  REASON_MIN,
  buildOpeningBody,
  buildReasonBody,
  buildRefundBody,
  buildReissueBody,
  reissueAsCreated,
  savedCancelFrom,
  savedOpeningFrom,
  savedRefundFrom,
  savedVoidFrom,
} from '@/lib/ownerActions';
import { allocationRow, billRow, id, receiptRow, summaryRow } from './support/money-rows';
import { skuRow } from './support/rows';

describe('PT-W11 the reason of a cancel, a void and a re-issue (X4, X5, X10: 3 to 500 characters once trimmed)', () => {
  it('trims the text and sends it as the reason', () => {
    expect(buildReasonBody('  wrong rate on line 2  ')).toEqual({
      body: { reason: 'wrong rate on line 2' },
    });
  });

  it('refuses fewer than 3 characters (after trimming) and more than 500, before any call, in words', () => {
    expect(REASON_MIN).toBe(3);
    expect(REASON_MAX).toBe(500);
    for (const text of ['', '  ', 'ab', '  ab  ']) {
      const built = buildReasonBody(text);
      expect(built, text).toHaveProperty('error');
      expect((built as { error: string }).error).toMatch(/at least 3 characters/);
    }
    expect(buildReasonBody('abc')).toEqual({ body: { reason: 'abc' } });
    expect(buildReasonBody('x'.repeat(500))).toHaveProperty('body');
    const long = buildReasonBody('x'.repeat(501));
    expect((long as { error: string }).error).toMatch(/at most 500 characters/);
  });
});

describe('PT-W11 the refund (X11): money handed back out of the advance', () => {
  it('builds the body with the amount as two-decimal text, the mode, and the reference and notes only when typed; no date and no bill', () => {
    expect(buildRefundBody({ amount: '300', mode: 'Cash', reference: '', notes: '' })).toEqual({
      body: { amount: '300.00', mode: 'Cash' },
    });
    expect(
      buildRefundBody({ amount: ' 125.5 ', mode: 'UPI', reference: ' UTR1 ', notes: ' returned ' })
    ).toEqual({ body: { amount: '125.50', mode: 'UPI', reference: 'UTR1', notes: 'returned' } });
  });

  it('refuses a blank, zero, negative, too precise or unreadable amount and a mode that is not one of the five, before any call', () => {
    const error = (amount: string, mode = 'Cash') =>
      (buildRefundBody({ amount, mode, reference: '', notes: '' }) as { error: string }).error;
    expect(error('')).toMatch(/enter the amount/i);
    expect(error('0')).toMatch(/more than 0/);
    expect(error('-5')).toMatch(/negative|more than 0/);
    expect(error('1.005')).toMatch(/at most 2 decimals/);
    expect(error('abc')).toMatch(/must be a number/);
    expect(error('10', 'Credit')).toMatch(/payment mode/i);
  });
});

describe('PT-W11 the opening balance (X12): what a customer owed or had paid on the first day', () => {
  const input = {
    dues: '',
    fineDue: '',
    advance: '',
    fineAdvance: '',
    asOf: '2026-10-01',
    walkIn: false,
  };

  it('sends only the figures typed, as text (money with two decimals, silver with three), and the date', () => {
    expect(
      buildOpeningBody({ ...input, dues: '1000', fineDue: '2.5', advance: '', fineAdvance: '' })
    ).toEqual({
      body: { dues: '1000.00', fine_due: '2.500', as_of: '2026-10-01' },
    });
    expect(buildOpeningBody({ ...input, advance: '500.5', fineAdvance: '1' })).toEqual({
      body: { advance: '500.50', fine_advance: '1.000', as_of: '2026-10-01' },
    });
  });

  it('needs at least one figure above 0 (all blank or 0 is refused before any call)', () => {
    for (const blank of [{}, { dues: '0' }, { dues: '0.00', advance: '0' }]) {
      const built = buildOpeningBody({ ...input, ...blank });
      expect((built as { error: string }).error).toMatch(/at least one/i);
    }
  });

  it('refuses a negative, too precise or unreadable figure, and a missing or future date', () => {
    const error = (over: Partial<typeof input>) =>
      (buildOpeningBody({ ...input, dues: '5', ...over }) as { error: string }).error;
    expect(error({ dues: '-1' })).toMatch(/cannot be negative/);
    expect(error({ dues: '1.234' })).toMatch(/at most 2 decimals/);
    expect(error({ fineDue: '1.2345' })).toMatch(/at most 3 decimals/);
    expect(error({ advance: 'x' })).toMatch(/must be a number/);
    expect(error({ asOf: '' })).toMatch(/date/i);
    expect(error({ asOf: '2026-13-40' })).toMatch(/date/i);
  });

  it('the walk-in holds no advance: an advance or a silver advance is refused on the screen, dues are allowed', () => {
    expect(
      (buildOpeningBody({ ...input, walkIn: true, advance: '5' }) as { error: string }).error
    ).toMatch(/walk-in/i);
    expect(
      (buildOpeningBody({ ...input, walkIn: true, fineAdvance: '5' }) as { error: string }).error
    ).toMatch(/walk-in/i);
    expect(buildOpeningBody({ ...input, walkIn: true, dues: '5' })).toHaveProperty('body');
  });
});

describe('PT-W11 the re-issue body (X10): the corrected bill without its customer, with the reason', () => {
  const bill: BillBody = {
    customer_id: id.priya,
    sale_type: 'Retail',
    bill_date: '2026-10-15',
    items: [
      {
        sku_id: id.walkin,
        metal_rate: '100.00',
        labour_rate: '10.00',
        piroi: '0.00',
        other_charges: '0.00',
        quantity: 1,
      },
    ],
    discount: '0.00',
    additional_charges: '0.00',
    payments: [{ mode: 'UPI', amount: '100.00' }],
  };

  it("has no customer_id (the customer cannot change; the API refuses even the old bill's own), and has the trimmed reason", () => {
    const built = buildReissueBody(bill, '  wrong weight  ');
    expect(built).toHaveProperty('body');
    const body = (built as { body: Record<string, unknown> }).body;
    expect(body).not.toHaveProperty('customer_id');
    expect(body.reason).toBe('wrong weight');
    expect(body.items).toEqual(bill.items);
    expect(body.payments).toEqual(bill.payments);
    expect(body.sale_type).toBe('Retail');
    expect(bill.customer_id).toBe(id.priya); // the input was not changed
  });

  it('refuses a reason of fewer than 3 characters before any call', () => {
    expect((buildReissueBody(bill, 'ab') as { error: string }).error).toMatch(
      /at least 3 characters/
    );
  });
});

// ---- the answers

const AT = '2026-10-15';
const bill1 = billRow(21, id.priya, { bill_no: 'JV-0021', grand_total: '1000.00' });
const bill2 = billRow(22, id.priya, { bill_no: 'JV-0022', grand_total: '700.00' });

describe('PT-W11 what a cancel shows once the API has answered (X5)', () => {
  const receipt = receiptRow(1, id.priya, { amount: '600.00' });
  // JV-0021 had received 600.00 from R1 (released by the cancel); 400.00 of it was applied to the older bill JV-0022, the other 200.00 is held as the customer's advance
  const released = [
    allocationRow(1, receipt, bill1, {
      amount: '600.00',
      released_at: '2026-10-15 10:00:00.000000',
    }),
  ];
  const rebalance = [allocationRow(2, receipt, bill2, { amount: '400.00' })];
  const response: CancelBillResponse = {
    bill: { ...bill1, status: 'cancelled', cancel_reason: 'wrong customer' },
    skus: [skuRow(1, 1), skuRow(2, 1)],
    released_allocations: released,
    allocations: rebalance,
  };

  it('says how much money the bill had received, how much of it went to other bills and how much is kept as advance', () => {
    const saved = savedCancelFrom(response);
    expect(saved.billNo).toBe('JV-0021');
    expect(saved.pieces).toBe(2);
    expect(saved.releasedPaise).toBe(60000);
    expect(saved.appliedPaise).toBe(40000);
    expect(saved.keptPaise).toBe(20000);
    expect(saved.parts.map((p) => [p.billId, p.paise])).toEqual([[bill2.id, 40000]]);
  });

  it('a bill with nothing received releases nothing', () => {
    const saved = savedCancelFrom({
      ...response,
      skus: [skuRow(1, 1)],
      released_allocations: [],
      allocations: [],
    });
    expect(saved.pieces).toBe(1);
    expect(saved.releasedPaise).toBe(0);
    expect(saved.appliedPaise).toBe(0);
    expect(saved.keptPaise).toBe(0);
  });

  it('counts the silver the cancel released and re-applied in milligrams (never a float)', () => {
    const silver = receiptRow(3, id.priya, {
      kind: 'fine_silver',
      amount: '0.00',
      fine_grams: '2.500',
    });
    const saved = savedCancelFrom({
      ...response,
      skus: [],
      released_allocations: [
        allocationRow(5, silver, bill1, { amount: '0.00', fine_grams: '2.500' }),
      ],
      allocations: [allocationRow(6, silver, bill2, { amount: '0.00', fine_grams: '1.250' })],
    });
    expect(saved.releasedFineMg).toBe(2500);
    expect(saved.appliedFineMg).toBe(1250);
    expect(saved.keptFineMg).toBe(1250);
  });
});

describe('PT-W11 what a void shows once the API has answered (X4)', () => {
  const receipt = receiptRow(2, id.priya, {
    amount: '300.00',
    status: 'voided',
    void_reason: 'bounced',
  });
  const reopened = (bill: ReturnType<typeof billRow>, pending: string): BillSummaryRow =>
    summaryRow(bill, {
      received: '0.00',
      pending,
      fine_settled: '0.000',
      fine_pending: '0.000',
      payment_status: 'Pending',
      item_count: 1,
    });

  it('names the receipt and each bill the void touched with the pending the API now reports', () => {
    const response: VoidReceiptResponse = {
      receipt,
      allocations: [],
      bills: [reopened(bill1, '1000.00'), reopened(bill2, '700.00')],
    };
    const saved = savedVoidFrom(response);
    expect(saved.receiptId).toBe(receipt.id);
    expect(saved.amountPaise).toBe(30000);
    expect(saved.bills.map((b) => [b.billNo, b.pendingPaise])).toEqual([
      ['JV-0021', 100000],
      ['JV-0022', 70000],
    ]);
    expect(saved.appliedElsewherePaise).toBe(0);
  });

  it('adds up what the rebalance applied to other bills when the void freed money that was waiting as an advance', () => {
    const response: VoidReceiptResponse = {
      receipt,
      allocations: [
        allocationRow(9, receiptRow(8, id.priya, { amount: '500.00' }), bill1, {
          amount: '250.00',
        }),
      ],
      bills: [reopened(bill1, '750.00')],
    };
    expect(savedVoidFrom(response).appliedElsewherePaise).toBe(25000);
  });
});

describe('PT-W11 what a refund and an opening balance show once the API has answered (X11, X12)', () => {
  it('the refund shows the amount handed back and the advance the customer still holds, as the API sent them', () => {
    const response: IssueRefundResponse = {
      receipt: receiptRow(4, id.priya, { kind: 'refund', amount: '300.00', mode: 'Cash' }),
      advance: '200.00',
    };
    const saved = savedRefundFrom(response);
    expect(saved.amountPaise).toBe(30000);
    expect(saved.mode).toBe('Cash');
    expect(saved.advanceLeftPaise).toBe(20000);
  });

  it('the opening balance shows the opening bill (when there are dues), the advances recorded and what the rebalance netted off', () => {
    const opening = billRow(30, id.priya, {
      bill_no: 'OB-0001',
      doc_type: 'opening_balance',
      grand_total: '1000.00',
      fine_weight_due: '2.500',
    });
    const money = receiptRow(5, id.priya, { amount: '400.00', is_opening: true, mode: 'Other' });
    const silver = receiptRow(6, id.priya, {
      kind: 'fine_silver',
      amount: '0.00',
      fine_grams: '1.000',
      is_opening: true,
    });
    const response: OpeningBalanceResponse = {
      bill: opening,
      receipts: [money, silver],
      allocations: [
        allocationRow(1, money, opening, { amount: '400.00' }),
        allocationRow(2, silver, opening, { amount: '0.00', fine_grams: '1.000' }),
      ],
    };
    const saved = savedOpeningFrom(response);
    expect(saved.billNo).toBe('OB-0001');
    expect(saved.duesPaise).toBe(100000);
    expect(saved.fineDueMg).toBe(2500);
    expect(saved.advancePaise).toBe(40000);
    expect(saved.fineAdvanceMg).toBe(1000);
    expect(saved.nettedPaise).toBe(40000);
    expect(saved.nettedFineMg).toBe(1000);
  });

  it('an advance alone has no bill', () => {
    const money = receiptRow(5, id.priya, { amount: '400.00', is_opening: true, mode: 'Other' });
    const saved = savedOpeningFrom({ bill: null, receipts: [money], allocations: [] });
    expect(saved.billNo).toBeNull();
    expect(saved.duesPaise).toBe(0);
    expect(saved.advancePaise).toBe(40000);
  });
});

describe('PT-W11 the re-issue answer is a saved bill for the billing screen (X10)', () => {
  it('the new bill is the bill, and the old one, the released and the carried rows stay in the answer', () => {
    const old = { ...bill1, status: 'cancelled' as const };
    const fresh = billRow(23, id.priya, { bill_no: 'JV-0023', reissue_of: bill1.id });
    const answer: ReissueBillResponse = {
      old_bill: old,
      new_bill: fresh,
      items: [],
      receipts: [],
      allocations: [],
      released_allocations: [],
      warnings: [],
      advance_applied: '600.00',
    };
    const created = reissueAsCreated(answer);
    expect(created.bill).toBe(fresh);
    expect(created.advance_applied).toBe('600.00');
    expect(created).not.toHaveProperty('old_bill');
  });
});

// keep the unused constant honest: the date the fixtures share
void AT;
