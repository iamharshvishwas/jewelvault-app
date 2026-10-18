// WEB09 (spec X2, X3, Y3, Y5, SF1, SF2, Z1, Z2, K5, C5 (b), C13; plan test PT-W9, unit half): the payment and silver-fine panel without the panel, in src/lib/payments.ts.
//
//   the request   `buildPaymentBody` (X2) and `buildFineBody` (X3) make the body from what is typed: money and grams are exact text, there is no Credit mode, a blank optional field is
//                 left out, the owner's reason is sent only for cash and only by the owner, and the sentence for whatever is wrong is given before any call is made
//   the figure    `cashEquivalentPaise`: round(grams x rate, 2) half up in whole paise, never in floating point (the API's rule: 1.005 g at 1.00 is 1.01)
//   the answer    `savedPaymentFrom` and `savedFineFrom` turn the rows X2 and X3 returned into each part the screen shows: the bill, the advance remaining, the fine remaining
//   the words     `paymentSaveFailure`: the plain sentence for JV_CASH_LIMIT (a biller: "the owner enters this payment"; the owner: a reason of 10 characters; the walk-in), JV_OVERPAYMENT,
//                 JV_FINE_EXCEEDS (with the maximum), the bad bill_id, and an outcome that is not known (T-E04 clause, C13)
import { describe, expect, it } from 'vitest';
import { ApiError } from '@/lib/api/client';
import type { ReceiptAllocationRow, ReceiptRow } from '@/lib/api/types';
import { WALK_IN_ID } from '@/lib/billing';
import {
  buildFineBody,
  buildPaymentBody,
  cashEquivalentPaise,
  paymentSaveFailure,
  savedFineFrom,
  savedPaymentFrom,
} from '@/lib/payments';
import { allocationRow, billRow, id, receiptRow } from './support/money-rows';

const BILL = '00000000-0000-4000-8000-0000000b0001';

const typed = (over: Partial<Parameters<typeof buildPaymentBody>[0]> = {}) => ({
  amount: '600',
  mode: 'UPI',
  billId: '',
  reference: '',
  notes: '',
  cashOverrideReason: '',
  ...over,
});

const typedFine = (over: Partial<Parameters<typeof buildFineBody>[0]> = {}) => ({
  grams: '10',
  mode: 'Silver' as const,
  silverRate: '',
  billId: '',
  reference: '',
  notes: '',
  cashOverrideReason: '',
  ...over,
});

const bodyOf = <T>(made: { body: T } | { error: string }): T => {
  if (!('body' in made)) throw new Error(`expected a body, got: ${made.error}`);
  return made.body;
};
const errorOf = (made: { body: unknown } | { error: string }): string => {
  if (!('error' in made)) throw new Error('expected an error');
  return made.error;
};

function apiError(
  code: string,
  details: Record<string, unknown> = {},
  over: { message?: string; write?: boolean; status?: number } = {}
) {
  return new ApiError({
    code,
    status: over.status ?? 409,
    message: over.message ?? `plain message of ${code}`,
    details,
    write: over.write ?? true,
    idempotencyKey: 'k-1',
  });
}

describe('PT-W9 (unit half; X2, Y2, D13): the body of record_payment', () => {
  it('money goes out as text with two decimals, the mode as chosen, and a blank optional field is left out', () => {
    expect(bodyOf(buildPaymentBody(typed()))).toEqual({ amount: '600.00', mode: 'UPI' });
    expect(bodyOf(buildPaymentBody(typed({ amount: '1250.5', mode: 'Bank Transfer' })))).toEqual({
      amount: '1250.50',
      mode: 'Bank Transfer',
    });
    // typed with spaces and the Indian grouping a person might use: only digits and one point are a number
    expect(bodyOf(buildPaymentBody(typed({ amount: ' 600 ' }))).amount).toBe('600.00');
  });

  it('the same payment typed two ways is the same body (so it is the same user action and the same key)', () => {
    const a = bodyOf(buildPaymentBody(typed({ amount: '600' })));
    const b = bodyOf(buildPaymentBody(typed({ amount: '600.00' })));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('a named bill, a reference and a note are sent trimmed; blank ones are not', () => {
    expect(
      bodyOf(buildPaymentBody(typed({ billId: BILL, reference: ' UTR-1 ', notes: ' part ' })))
    ).toEqual({
      amount: '600.00',
      mode: 'UPI',
      bill_id: BILL,
      reference: 'UTR-1',
      notes: 'part',
    });
  });

  it('there is no Credit mode: it is refused before any call, with the five modes named', () => {
    const message = errorOf(buildPaymentBody(typed({ mode: 'Credit' })));
    expect(message).toMatch(/Cash, UPI, Card, Bank Transfer or Other/);
  });

  it('an amount that is blank, zero, negative, fractional beyond paise, not a number or too large is refused in words', () => {
    expect(errorOf(buildPaymentBody(typed({ amount: '' })))).toMatch(/Enter the amount/);
    expect(errorOf(buildPaymentBody(typed({ amount: '0' })))).toMatch(/more than 0/);
    expect(errorOf(buildPaymentBody(typed({ amount: '0.00' })))).toMatch(/more than 0/);
    expect(errorOf(buildPaymentBody(typed({ amount: '-5' })))).toMatch(/cannot be negative/);
    expect(errorOf(buildPaymentBody(typed({ amount: '10.005' })))).toMatch(/at most 2 decimals/);
    expect(errorOf(buildPaymentBody(typed({ amount: 'abc' })))).toMatch(/must be a number/);
    expect(errorOf(buildPaymentBody(typed({ amount: '1000000001' })))).toMatch(
      /more than the system allows/
    );
    expect(bodyOf(buildPaymentBody(typed({ amount: '1000000000' }))).amount).toBe('1000000000.00');
  });

  it('a reference of more than 120 characters is refused (the API takes 120)', () => {
    expect(errorOf(buildPaymentBody(typed({ reference: 'x'.repeat(121) })))).toMatch(/120/);
    expect(bodyOf(buildPaymentBody(typed({ reference: 'x'.repeat(120) }))).reference).toHaveLength(
      120
    );
  });

  it('the reason for cash over the limit goes out only for Cash, and must be 10 to 500 characters', () => {
    const reason = 'Wedding order, the family paid in cash';
    expect(
      bodyOf(buildPaymentBody(typed({ mode: 'Cash', cashOverrideReason: reason })))
        .cash_override_reason
    ).toBe(reason);
    // not cash: a reason has nothing to explain, and is not sent (the API refuses it from a biller)
    expect(
      'cash_override_reason' in
        bodyOf(buildPaymentBody(typed({ mode: 'UPI', cashOverrideReason: reason })))
    ).toBe(false);
    expect(
      errorOf(buildPaymentBody(typed({ mode: 'Cash', cashOverrideReason: 'too short' })))
    ).toMatch(/10 to 500 characters/);
    expect(
      errorOf(buildPaymentBody(typed({ mode: 'Cash', cashOverrideReason: 'x'.repeat(501) })))
    ).toMatch(/10 to 500 characters/);
  });
});

describe('PT-W9 (unit half; X3, SF1, SF2, T-B13): the body of settle_fine', () => {
  it('a silver settlement is grams with three decimals and the mode Silver, with no rate', () => {
    expect(bodyOf(buildFineBody(typedFine()))).toEqual({ grams: '10.000', mode: 'Silver' });
    expect(bodyOf(buildFineBody(typedFine({ grams: '2.5' }))).grams).toBe('2.500');
  });

  it('a rate typed for a Silver settlement is not sent (the API refuses a rate there)', () => {
    const body = bodyOf(buildFineBody(typedFine({ silverRate: '80' })));
    expect('silver_rate' in body).toBe(false);
  });

  it('a cash settlement needs a rate above 0, sent with two decimals', () => {
    expect(
      bodyOf(buildFineBody(typedFine({ mode: 'Cash', grams: '5', silverRate: '80' })))
    ).toEqual({
      grams: '5.000',
      mode: 'Cash',
      silver_rate: '80.00',
    });
    expect(errorOf(buildFineBody(typedFine({ mode: 'Cash', silverRate: '' })))).toMatch(
      /Enter the silver rate/
    );
    expect(errorOf(buildFineBody(typedFine({ mode: 'Cash', silverRate: '0' })))).toMatch(
      /more than 0/
    );
  });

  it('grams that are blank, zero, negative or have more than 3 decimals are refused in words', () => {
    expect(errorOf(buildFineBody(typedFine({ grams: '' })))).toMatch(/Enter the grams/);
    expect(errorOf(buildFineBody(typedFine({ grams: '0' })))).toMatch(/more than 0/);
    expect(errorOf(buildFineBody(typedFine({ grams: '0.000' })))).toMatch(/more than 0/);
    expect(errorOf(buildFineBody(typedFine({ grams: '-1' })))).toMatch(/cannot be negative/);
    expect(errorOf(buildFineBody(typedFine({ grams: '1.2345' })))).toMatch(/at most 3 decimals/);
  });

  it('a named bill and the owner reason (cash only) are sent as for a payment', () => {
    const body = bodyOf(
      buildFineBody(
        typedFine({
          mode: 'Cash',
          silverRate: '80',
          billId: BILL,
          cashOverrideReason: 'Owner agreed with the family',
        })
      )
    );
    expect(body.bill_id).toBe(BILL);
    expect(body.cash_override_reason).toBe('Owner agreed with the family');
    const silver = bodyOf(
      buildFineBody(typedFine({ cashOverrideReason: 'Owner agreed with the family' }))
    );
    expect('cash_override_reason' in silver).toBe(false);
  });
});

describe('PT-W9 (unit half; SF1, Y3): the cash equivalent of a fine is round(grams x rate, 2), half up, in whole paise', () => {
  it('worked by hand', () => {
    expect(cashEquivalentPaise('5', '80')).toBe(40000); // 5 g at 80.00 = 400.00
    expect(cashEquivalentPaise('10.000', '77.50')).toBe(77500);
    expect(cashEquivalentPaise('1.005', '1.00')).toBe(101); // 1.005 rounds half up to 1.01 (the API's own example)
    expect(cashEquivalentPaise('0.001', '0.49')).toBe(0); // 0.00049 rupee: the API refuses an amount of 0.00
    expect(cashEquivalentPaise('0.001', '5.00')).toBe(1); // 0.005 rupee is half a paisa: half up is 0.01
    expect(cashEquivalentPaise('0.010', '50.00')).toBe(50);
    expect(cashEquivalentPaise('2.345', '81.37')).toBe(19081); // 190.81265 rounds to 190.81
  });

  it('does not lose a digit where a float would: 99999.999 g at 99999999.99 is exact', () => {
    // 99,999,999 mg x 9,999,999,999 paise = 999,999,989,900,000,001 (more than 2^53, so a float would be wrong); a thousandth of it, half up, is 999,999,989,900,000 paise
    expect(cashEquivalentPaise('99999.999', '99999999.99')).toBe(999999989900000);
  });

  it('is null for what is not a grams or a rate', () => {
    expect(cashEquivalentPaise('', '80')).toBeNull();
    expect(cashEquivalentPaise('5', '')).toBeNull();
    expect(cashEquivalentPaise('abc', '80')).toBeNull();
    expect(cashEquivalentPaise('1.2345', '80')).toBeNull();
    expect(cashEquivalentPaise('-1', '80')).toBeNull();
  });
});

// ------------------------------------------------------------------------------------------------ the answer

const bill1 = billRow(1, id.priya, { bill_no: 'JV-0001' });
const bill2 = billRow(2, id.priya, { bill_no: 'JV-0002' });
const pay = (n: number, over: Partial<ReceiptRow> = {}) =>
  receiptRow(n, id.priya, { amount: '2000.00', mode: 'UPI', ...over });
const alloc = (
  n: number,
  receipt: ReceiptRow,
  bill: typeof bill1,
  over: Partial<ReceiptAllocationRow> = {}
) => allocationRow(n, receipt, bill, over);

describe('PT-W9 (unit half; X2, Y3, Y5): the parts of a payment, from the rows X2 returned', () => {
  it('600 on a bill of 1,000: one part, nothing kept as advance', () => {
    const receipt = pay(1, { amount: '600.00' });
    const saved = savedPaymentFrom({
      receipt,
      allocations: [alloc(1, receipt, bill1, { amount: '600.00' })],
      advance_remaining: '0.00',
    });
    expect(saved.receiptId).toBe(receipt.id);
    expect(saved.amount).toBe(60000);
    expect(saved.mode).toBe('UPI');
    expect(saved.parts).toEqual([{ billId: bill1.id, paise: 60000 }]);
    expect(saved.adjusted).toEqual([]);
    expect(saved.advanceRemaining).toBe(0);
  });

  it('2,000 against 1,000 and 700 (oldest first): two parts in the order the API made them and 300 kept as advance', () => {
    const receipt = pay(2);
    const saved = savedPaymentFrom({
      receipt,
      allocations: [
        alloc(1, receipt, bill1, { amount: '1000.00' }),
        alloc(2, receipt, bill2, { amount: '700.00' }),
      ],
      advance_remaining: '300.00',
    });
    expect(saved.parts).toEqual([
      { billId: bill1.id, paise: 100000 },
      { billId: bill2.id, paise: 70000 },
    ]);
    expect(saved.advanceRemaining).toBe(30000);
  });

  it('two allocations to the same bill are one part; a released allocation is not a part', () => {
    const receipt = pay(3, { amount: '500.00' });
    const saved = savedPaymentFrom({
      receipt,
      allocations: [
        alloc(1, receipt, bill1, { amount: '200.00' }),
        alloc(2, receipt, bill1, { amount: '100.00' }),
        alloc(3, receipt, bill2, { amount: '50.00', released_at: '2026-10-15T09:00:00.000000Z' }),
      ],
      advance_remaining: '200.00',
    });
    expect(saved.parts).toEqual([{ billId: bill1.id, paise: 30000 }]);
  });

  it('allocations of OTHER receipts are the rebalance applying an older advance: shown as adjusted, not as a part of this payment', () => {
    const receipt = pay(4, { amount: '100.00' });
    const older = pay(40, { amount: '300.00' });
    const saved = savedPaymentFrom({
      receipt,
      allocations: [
        alloc(1, receipt, bill1, { amount: '100.00' }),
        alloc(2, older, bill2, { amount: '300.00' }),
      ],
      advance_remaining: '0.00',
    });
    expect(saved.parts).toEqual([{ billId: bill1.id, paise: 10000 }]);
    expect(saved.adjusted).toEqual([{ billId: bill2.id, paise: 30000 }]);
  });

  it('a payment that went wholly to advance has no part and shows the advance', () => {
    const receipt = pay(5, { amount: '500.00' });
    const saved = savedPaymentFrom({ receipt, allocations: [], advance_remaining: '500.00' });
    expect(saved.parts).toEqual([]);
    expect(saved.advanceRemaining).toBe(50000);
  });
});

describe('PT-W9 (unit half; X3, SF2): the parts of a fine settlement, from the rows X3 returned', () => {
  const fine = (n: number, over: Partial<ReceiptRow> = {}) =>
    receiptRow(n, id.priya, {
      kind: 'fine_silver',
      mode: null,
      amount: '0.00',
      fine_grams: '10.000',
      ...over,
    });

  it("10 g in silver: one part in grams, no amount, the fine remaining is the API's figure", () => {
    const receipt = fine(1);
    const saved = savedFineFrom({
      receipt,
      allocations: [alloc(1, receipt, bill1, { amount: '0.00', fine_grams: '10.000' })],
      fine_remaining: '15.000',
    });
    expect(saved.kind).toBe('fine_silver');
    expect(saved.grams).toBe(10000);
    expect(saved.amount).toBe(0);
    expect(saved.silverRate).toBeNull();
    expect(saved.parts).toEqual([{ billId: bill1.id, mg: 10000 }]);
    expect(saved.fineRemaining).toBe(15000);
  });

  it("5 g in cash at 80: the amount and the rate are the receipt's", () => {
    const receipt = fine(2, {
      kind: 'fine_cash',
      mode: 'Cash',
      amount: '400.00',
      fine_grams: '5.000',
      silver_rate: '80.00',
    });
    const saved = savedFineFrom({
      receipt,
      allocations: [alloc(2, receipt, bill1, { amount: '0.00', fine_grams: '5.000' })],
      fine_remaining: '10.000',
    });
    expect(saved.kind).toBe('fine_cash');
    expect(saved.amount).toBe(40000);
    expect(saved.silverRate).toBe(8000);
    expect(saved.grams).toBe(5000);
    expect(saved.fineRemaining).toBe(10000);
  });

  it('grams over two bills are two parts, oldest first as the API made them', () => {
    const receipt = fine(3, { fine_grams: '12.000' });
    const saved = savedFineFrom({
      receipt,
      allocations: [
        alloc(1, receipt, bill1, { amount: '0.00', fine_grams: '7.000' }),
        alloc(2, receipt, bill2, { amount: '0.00', fine_grams: '5.000' }),
      ],
      fine_remaining: '0.000',
    });
    expect(saved.parts).toEqual([
      { billId: bill1.id, mg: 7000 },
      { billId: bill2.id, mg: 5000 },
    ]);
    expect(saved.fineRemaining).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ the words

describe('T-E04 (clause) and Z1, Z2 (screen half): the words of a refused payment', () => {
  const biller = { role: 'biller', walkIn: false, kind: 'payment' as const };
  const owner = { role: 'owner', walkIn: false, kind: 'payment' as const };
  const limit = {
    limit: '200000.00',
    cash_today: '150000.00',
    this_call: '60000.00',
    date: '2026-10-15',
  };

  it('JV_CASH_LIMIT for a biller: both figures, "The owner enters this payment", nothing was changed, and no field for a reason', () => {
    const found = paymentSaveFailure(apiError('JV_CASH_LIMIT', limit), biller);
    expect(found.message).toContain('₹2,00,000');
    expect(found.message).toContain('₹1,50,000.00 already today');
    expect(found.message).toContain('₹60,000.00 in this payment');
    expect(found.message).toContain('The owner enters this payment.');
    expect(found.message).toContain('Nothing was changed.');
    expect(found.cashLimit).toEqual({ ownerMayGiveReason: false });
    expect(found.unconfirmed).toBe(false);
  });

  it('JV_CASH_LIMIT for the owner: asks for a reason of at least 10 characters and offers the field', () => {
    const found = paymentSaveFailure(apiError('JV_CASH_LIMIT', limit), owner);
    expect(found.message).toMatch(/reason of at least 10 characters/);
    expect(found.message).not.toContain('The owner enters this payment');
    expect(found.cashLimit).toEqual({ ownerMayGiveReason: true });
  });

  it('JV_CASH_LIMIT for a fine settled in cash names the settlement, not a payment', () => {
    const found = paymentSaveFailure(apiError('JV_CASH_LIMIT', limit), { ...biller, kind: 'fine' });
    expect(found.message).toContain('in this settlement');
    expect(found.message).toContain('The owner enters this payment.');
  });

  it('JV_CASH_LIMIT for the walk-in: "Select or create the customer", for everybody, no field for a reason', () => {
    const details = { limit: '200000.00', this_call: '200000.00', date: '2026-10-15' };
    for (const role of ['biller', 'owner']) {
      const found = paymentSaveFailure(apiError('JV_CASH_LIMIT', details), {
        role,
        walkIn: true,
        kind: 'payment',
      });
      expect(found.message).toContain('Select or create the customer');
      expect(found.message).toContain('Nothing was changed.');
      expect(found.cashLimit).toBeNull();
    }
  });

  it("JV_OVERPAYMENT for the walk-in: an unnamed bill, and more than the named bill's pending (with that figure)", () => {
    const noBill = paymentSaveFailure(apiError('JV_OVERPAYMENT', { field: 'bill_id' }), {
      role: 'biller',
      walkIn: true,
      kind: 'payment',
    });
    expect(noBill.message).toMatch(/must name the bill/);
    expect(noBill.message).toContain('Nothing was changed.');
    const tooMuch = paymentSaveFailure(
      apiError('JV_OVERPAYMENT', { field: 'amount', pending: '400.00' }),
      { role: 'biller', walkIn: true, kind: 'payment' }
    );
    expect(tooMuch.message).toContain('₹400.00');
    expect(tooMuch.message).toContain('Nothing was changed.');
  });

  it("JV_FINE_EXCEEDS names the maximum, in grams; for the walk-in it is that bill's maximum; with no bill named it asks for one", () => {
    const fine = { role: 'biller', walkIn: false, kind: 'fine' as const };
    const named = paymentSaveFailure(
      apiError('JV_FINE_EXCEEDS', { field: 'grams', max_grams: '15.000' }),
      fine
    );
    expect(named.message).toContain('15.000 g');
    expect(named.message).toContain('Nothing was changed.');
    const none = paymentSaveFailure(
      apiError('JV_FINE_EXCEEDS', { field: 'grams', max_grams: '0.000' }),
      fine
    );
    expect(none.message).toMatch(/no silver fine is owed/i);
    const walkIn = paymentSaveFailure(
      apiError('JV_FINE_EXCEEDS', { field: 'grams', max_grams: '4.000' }),
      { ...fine, walkIn: true }
    );
    expect(walkIn.message).toContain('4.000 g');
    expect(walkIn.message).toMatch(/that bill/);
    const unnamed = paymentSaveFailure(apiError('JV_FINE_EXCEEDS', { field: 'bill_id' }), {
      ...fine,
      walkIn: true,
    });
    expect(unnamed.message).toMatch(/must name the bill/);
  });

  it('a bad bill_id (foreign, cancelled, paid, unknown or only silver pending) is one plain sentence, for a payment and for a fine', () => {
    const invalid = apiError(
      'JV_INVALID_INPUT',
      { field: 'bill_id' },
      {
        status: 422,
        message: 'bill_id must be an active bill of this customer with money still to pay',
      }
    );
    const payment = paymentSaveFailure(invalid, biller);
    expect(payment.message).toMatch(/money still to pay/);
    expect(payment.message).not.toContain('bill_id');
    expect(payment.message).toContain('Nothing was changed.');
    const fine = paymentSaveFailure(invalid, { ...biller, kind: 'fine' });
    expect(fine.message).toMatch(/silver fine still to settle/);
    expect(fine.message).not.toContain('bill_id');
  });

  it('a silver rate or grams the API will not take is said in words, never as a field name', () => {
    const rate = paymentSaveFailure(
      apiError(
        'JV_INVALID_INPUT',
        { field: 'silver_rate' },
        { status: 422, message: 'silver_rate is required for a settlement in Cash' }
      ),
      { ...biller, kind: 'fine' }
    );
    expect(rate.message).toMatch(/silver rate/i);
    expect(rate.message).not.toContain('silver_rate');
    const grams = paymentSaveFailure(
      apiError(
        'JV_INVALID_INPUT',
        { field: 'grams' },
        { status: 422, message: 'grams is too small for this silver rate' }
      ),
      { ...biller, kind: 'fine' }
    );
    expect(grams.message).toMatch(/grams/i);
    expect(grams.message).not.toMatch(/\bgrams is\b/);
  });

  it('a biller who is somehow refused the reason is told the owner enters the payment', () => {
    const found = paymentSaveFailure(
      apiError('JV_FORBIDDEN', { field: 'cash_override_reason' }, { status: 403 }),
      biller
    );
    expect(found.message).toContain('Only the owner can give a reason');
    expect(found.message).toContain('Nothing was changed.');
  });

  it('an outcome that is not known says it could not be confirmed and tells the person to press Save again (the same key goes out)', () => {
    const lost = new ApiError({
      code: 'NETWORK',
      status: 0,
      message: 'Could not confirm that this was saved.',
      write: true,
      idempotencyKey: 'k-2',
    });
    const found = paymentSaveFailure(lost, biller);
    expect(found.unconfirmed).toBe(true);
    expect(found.message).toContain('Could not confirm that this was saved.');
    expect(found.message).toContain('Press Save again');
    expect(found.message).toContain('a second one is never made');
  });

  it("every other code keeps the client's plain message; something that is not an API error gets a generic sentence", () => {
    const archived = paymentSaveFailure(apiError('JV_CUSTOMER_ARCHIVED'), biller);
    expect(archived.message).toBe('plain message of JV_CUSTOMER_ARCHIVED');
    expect(archived.unconfirmed).toBe(false);
    expect(paymentSaveFailure(new Error('boom'), biller).message).toBe('boom');
    expect(paymentSaveFailure('x', biller).message).toBe('The payment could not be saved.');
    expect(paymentSaveFailure('x', { ...biller, kind: 'fine' }).message).toBe(
      'The settlement could not be saved.'
    );
  });
});

describe('K5 (screen half): the walk-in is the fixed customer of the seed', () => {
  it("the id the screens compare with is the seed's", () => {
    expect(WALK_IN_ID).toBe('00000000-0000-4000-8000-000000000001');
  });
});
