/**
 * Unit tests for src/lib/selectors.ts (task FE01, plan test PT-F1; spec V5 and C14, UNIT half of T-B15).
 *
 * "The module has a unit test over a fixed data set that checks every figure" (V5). The data set below is
 * small enough to follow by hand and rich enough to hit every rule: an opening-balance bill (not a sale), a
 * cancelled bill and a cancelled opening bill (not sales), a walk-in customer, a customer with an advance, a
 * customer with silver fine due, a customer with nothing, a bill in the previous month, a business day that
 * differs between UTC and India. It is consistent in the way the database guarantees (I10): for every
 * customer the pending of their active bills equals their outstanding, balance = outstanding - advance, and
 * total purchases = the sum of their active non-opening bills (a test below checks this, so the fixture
 * itself cannot be wrong without a failure).
 *
 * Every expected figure was computed independently in Python with the `decimal` module, not by the code
 * under test. Money is in paise and weight in milligrams, so every expected number is an integer.
 *
 * BigInt literals (10n) do not type-check with this repository's target (ES2017), so BigInt(...) is used.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PricingError, type DecimalInput } from '@/lib/pricing';
import {
  businessDateOf,
  businessMonthOf,
  cancelledForDate,
  cancelledForMonth,
  cancelledInRange,
  cashNetForDate,
  customerCard,
  customersWithDues,
  eveningFigures,
  paymentModeTotals,
  pendingBills,
  salesForDate,
  salesForMonth,
  salesInRange,
  totalCollected,
  totalFineOutstanding,
  totalOutstanding,
  upiNetForDate,
  type BillStatus,
  type BillSummaryRow,
  type CustomerBalanceRow,
  type DailyTotalRow,
  type DocType,
  type PayMode,
} from '@/lib/selectors';

// ---------------------------------------------------------------------------------------------------------
// the fixed data set (views V1, V2 and V4 of spec section 11, in the camelCase form the cache gives)
// ---------------------------------------------------------------------------------------------------------

/** One row of bill_summary (V1). Numbers arrive as text or as JSON numbers; both are used on purpose. */
function bill(
  id: string,
  billNo: string,
  customerId: string,
  billDate: string,
  docType: DocType,
  status: BillStatus,
  grandTotal: DecimalInput,
  pending: DecimalInput,
  finePending: DecimalInput = '0.000'
): BillSummaryRow {
  return { id, billNo, customerId, billDate, docType, status, grandTotal, pending, finePending };
}

const BILLS: BillSummaryRow[] = [
  // c1 (Retail): a bill from September, a paid bill, an unpaid bill, a cancelled bill
  bill('b0', 'JV-2026-0001', 'c1', '2026-09-30', 'estimate', 'active', 9999.99, '0.00'),
  bill('b1', 'JV-2026-0002', 'c1', '2026-10-01', 'estimate', 'active', '150000.00', 0),
  bill('b2', 'JV-2026-0003', 'c1', '2026-10-12', 'estimate', 'active', '250000.00', 250000),
  bill('b7', 'JV-2026-0010', 'c1', '2026-10-14', 'estimate', 'cancelled', '70000.00', '0.00'),
  // c2 (Wholesale silver): one part paid, one with silver fine due
  bill('b3', 'JV-2026-0004', 'c2', '2026-10-13', 'estimate', 'active', '120000.00', '20000.00'),
  bill(
    'b4',
    'JV-2026-0005',
    'c2',
    '2026-10-13',
    'estimate',
    'active',
    '556.00',
    '556.00',
    '13.900'
  ),
  // c3: paid in full, and has an advance of 30,000
  bill('b5', 'JV-2026-0006', 'c3', '2026-10-05', 'estimate', 'active', '50000.00', '0.00'),
  // the walk-in customer: one unpaid bill today
  bill('b6', 'JV-2026-0007', 'walkin', '2026-10-14', 'estimate', 'active', '999.00', '999.00'),
  // c4: dues brought forward (an opening-balance bill) and a cancelled opening-balance bill
  bill('ob1', 'OB-0001', 'c4', '2026-10-01', 'opening_balance', 'active', '5000.00', '5000.00'),
  bill('ob2', 'OB-0002', 'c4', '2026-10-14', 'opening_balance', 'cancelled', '1000.00', '0.00'),
];

/** The rows of customer_balances (V2). c5 has never bought anything. */
const CUSTOMERS: CustomerBalanceRow[] = [
  {
    id: 'c1',
    totalPurchases: '409999.99',
    received: '159999.99',
    outstanding: '250000.00',
    advance: '0.00',
    balance: '250000.00',
    fineOutstanding: '0.000',
    fineAdvance: '0.000',
    fineBalance: '0.000',
    lastPurchase: '2026-10-12',
  },
  {
    id: 'c2',
    totalPurchases: 120556,
    received: '100000.00',
    outstanding: '20556.00',
    advance: '0.00',
    balance: '20556.00',
    fineOutstanding: '13.900',
    fineAdvance: '0.000',
    fineBalance: '13.900',
    lastPurchase: '2026-10-13',
  },
  {
    id: 'c3',
    totalPurchases: '50000.00',
    received: '80000.00',
    outstanding: '0.00',
    advance: '30000.00',
    balance: '-30000.00',
    fineOutstanding: '0.000',
    fineAdvance: '2.500',
    fineBalance: '-2.500',
    lastPurchase: '2026-10-05',
  },
  {
    id: 'walkin',
    totalPurchases: '999.00',
    received: '0.00',
    outstanding: '999.00',
    advance: '0.00',
    balance: '999.00',
    fineOutstanding: '0.000',
    fineAdvance: '0.000',
    fineBalance: '0.000',
    lastPurchase: '2026-10-14',
  },
  {
    id: 'c4',
    totalPurchases: '0.00',
    received: '0.00',
    outstanding: '5000.00',
    advance: '0.00',
    balance: '5000.00',
    fineOutstanding: '0.000',
    fineAdvance: '0.000',
    fineBalance: '0.000',
    lastPurchase: null,
  },
  {
    id: 'c5',
    totalPurchases: '0.00',
    received: '0.00',
    outstanding: '0.00',
    advance: '0.00',
    balance: '0.00',
    fineOutstanding: '0.000',
    fineAdvance: '0.000',
    fineBalance: '0.000',
    lastPurchase: null,
  },
];

function day(
  businessDate: string,
  mode: PayMode,
  moneyIn: DecimalInput,
  moneyOut: DecimalInput,
  net: DecimalInput
): DailyTotalRow {
  return { businessDate, mode, moneyIn, moneyOut, net };
}

/** The rows of daily_totals (V4): one per business date and mode that had activity. */
const DAILY: DailyTotalRow[] = [
  day('2026-10-14', 'Cash', '50000.00', '2000.00', '48000.00'),
  day('2026-10-14', 'UPI', '30000.00', '0.00', '30000.00'),
  day('2026-10-14', 'Card', '1000.00', '0.00', '1000.00'),
  day('2026-10-14', 'Other', 500.5, 0, 500.5),
  day('2026-10-13', 'Cash', '10000.50', '0.00', '10000.50'),
  day('2026-10-13', 'UPI', '5000.00', '1000.00', '4000.00'),
  day('2026-10-13', 'Bank Transfer', '100000.00', '0.00', '100000.00'),
  day('2026-09-30', 'Cash', '9999.99', '0.00', '9999.99'),
];

const TODAY = '2026-10-14';

function thrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

function expectInvalid(fn: () => unknown, field: string) {
  const error = thrown(fn);
  expect(error, `expected JV_INVALID_INPUT for ${field} but got ${String(error)}`).toBeInstanceOf(
    PricingError
  );
  expect((error as PricingError).code).toBe('JV_INVALID_INPUT');
  expect((error as PricingError).field).toBe(field);
}

// ---------------------------------------------------------------------------------------------------------
// business dates (S5): the business day is the Asia/Kolkata calendar day
// ---------------------------------------------------------------------------------------------------------

describe('business date and month (S5, T-B16 UNIT side)', () => {
  it.each([
    // [instant in UTC, India business date]
    ['2026-10-14T00:00:00Z', '2026-10-14'],
    ['2026-10-13T18:29:59.999Z', '2026-10-13'], // 23:59:59.999 in India
    ['2026-10-13T18:30:00.000Z', '2026-10-14'], // midnight in India
    ['2026-10-13T20:00:00Z', '2026-10-14'], // still the 13th in UTC, already the 14th in India
    ['2026-10-14T18:00:00Z', '2026-10-14'], // 23:30 in India
    ['2026-09-30T18:00:00Z', '2026-09-30'], // 23:30 on 30 September in India
    ['2026-09-30T19:00:00Z', '2026-10-01'], // 00:30 on 1 October in India: the next month
    ['2026-12-31T18:29:59Z', '2026-12-31'],
    ['2026-12-31T18:30:00Z', '2027-01-01'], // a new year in India
    ['2028-02-28T18:30:00Z', '2028-02-29'], // leap day
    ['2027-02-28T18:30:00Z', '2027-03-01'], // no leap day
    ['1999-12-31T18:30:00Z', '2000-01-01'],
  ])('%s is the business day %s', (instant, expected) => {
    expect(businessDateOf(new Date(instant))).toBe(expected);
    expect(businessDateOf(Date.parse(instant))).toBe(expected);
  });

  it('agrees with the platform time zone database on 600 seeded random instants', () => {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    let state = 20261014;
    const next = () => {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      return state / 4294967296;
    };
    const from = Date.UTC(2020, 0, 1);
    const to = Date.UTC(2036, 0, 1);
    for (let i = 0; i < 600; i++) {
      const ms = from + Math.floor(next() * (to - from));
      const parts = Object.fromEntries(
        formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value])
      );
      expect(businessDateOf(ms)).toBe(`${parts.year}-${parts.month}-${parts.day}`);
    }
  });

  it('refuses something that is not an instant', () => {
    expectInvalid(() => businessDateOf(NaN), 'instant');
    expectInvalid(() => businessDateOf(new Date('nonsense')), 'instant');
    expectInvalid(() => businessDateOf(Infinity), 'instant');
  });

  it('takes the month of a business date', () => {
    expect(businessMonthOf('2026-10-14')).toBe('2026-10');
    expect(businessMonthOf('2026-09-30')).toBe('2026-09');
    expect(businessMonthOf('2027-01-01')).toBe('2027-01');
  });

  it('refuses a date that is not a real calendar date', () => {
    for (const bad of [
      '',
      '2026-10',
      '14-10-2026',
      '2026-13-01',
      '2026-02-30',
      '2027-02-29',
      '2026-10-1',
      '0000-01-01', // there is no year 0
      '2026-00-10',
      '2026-10-00',
    ]) {
      expectInvalid(() => businessMonthOf(bad), 'businessDate');
    }
    expect(businessMonthOf('2028-02-29')).toBe('2028-02');
  });
});

// ---------------------------------------------------------------------------------------------------------
// V5: sales
// ---------------------------------------------------------------------------------------------------------

describe('V5 sales: active bills that are not opening-balance bills, by bill date', () => {
  it('sales for a business date', () => {
    expect(salesForDate(BILLS, '2026-10-14')).toEqual({ count: 1, totalPaise: 99900 }); // only the walk-in bill
    expect(salesForDate(BILLS, '2026-10-13')).toEqual({ count: 2, totalPaise: 12055600 });
    expect(salesForDate(BILLS, '2026-10-12')).toEqual({ count: 1, totalPaise: 25000000 });
    expect(salesForDate(BILLS, '2026-09-30')).toEqual({ count: 1, totalPaise: 999999 });
  });

  it('an opening-balance bill is not a sale: 1 October has the paid bill only, not the 5,000 of dues', () => {
    expect(salesForDate(BILLS, '2026-10-01')).toEqual({ count: 1, totalPaise: 15000000 });
  });

  it('a date with no bills is zero, not an error', () => {
    expect(salesForDate(BILLS, '2026-10-02')).toEqual({ count: 0, totalPaise: 0 });
    expect(salesForDate([], '2026-10-02')).toEqual({ count: 0, totalPaise: 0 });
  });

  it('a cancelled bill leaves the day it was billed on (b7, 70,000, billed 14 October, is not a sale)', () => {
    const withoutCancelled = BILLS.filter((row) => row.id !== 'b7');
    expect(salesForDate(BILLS, TODAY)).toEqual(salesForDate(withoutCancelled, TODAY));
  });

  it('sales for a month', () => {
    expect(salesForMonth(BILLS, '2026-10')).toEqual({ count: 6, totalPaise: 57155500 });
    expect(salesForMonth(BILLS, '2026-09')).toEqual({ count: 1, totalPaise: 999999 });
    expect(salesForMonth(BILLS, '2026-11')).toEqual({ count: 0, totalPaise: 0 });
  });

  it('sales for a range of dates, both ends included', () => {
    expect(salesInRange(BILLS, '2026-10-05', '2026-10-13')).toEqual({
      count: 4,
      totalPaise: 42055600,
    });
    expect(salesInRange(BILLS, '2026-10-13', '2026-10-13')).toEqual(
      salesForDate(BILLS, '2026-10-13')
    );
    expect(salesInRange(BILLS, '2026-10-01', '2026-10-31')).toEqual(
      salesForMonth(BILLS, '2026-10')
    );
  });

  it('a range that ends before it starts holds nothing', () => {
    expect(salesInRange(BILLS, '2026-10-14', '2026-10-01')).toEqual({ count: 0, totalPaise: 0 });
  });

  it('any other document type is a sale too (only the opening-balance type is not)', () => {
    const rows = [
      bill('t1', 'T-1', 'c1', '2026-10-20', 'tax_invoice', 'active', '100.00', '0.00'),
      bill('t2', 'T-2', 'c1', '2026-10-20', 'bill_of_supply', 'active', '50.50', '0.00'),
      bill('t3', 'OB-9', 'c1', '2026-10-20', 'opening_balance', 'active', '999.00', '999.00'),
    ];
    expect(salesForDate(rows, '2026-10-20')).toEqual({ count: 2, totalPaise: 15050 });
  });

  it('reads money as exact decimals from text or from numbers (no float drift)', () => {
    const rows = [
      bill('x1', 'X-1', 'c1', '2026-10-20', 'estimate', 'active', 0.1, 0),
      bill('x2', 'X-2', 'c1', '2026-10-20', 'estimate', 'active', 0.2, 0),
      bill('x3', 'X-3', 'c1', '2026-10-20', 'estimate', 'active', '0.30', 0),
    ];
    expect(salesForDate(rows, '2026-10-20')).toEqual({ count: 3, totalPaise: 60 });
  });

  it('names the field of a row that is not a number', () => {
    const broken = [{ ...BILLS[2], grandTotal: 'abc' }];
    expectInvalid(() => salesForDate(broken, '2026-10-12'), 'grandTotal');
    const tooPrecise = [{ ...BILLS[2], grandTotal: '10.005' }];
    expectInvalid(() => salesForDate(tooPrecise, '2026-10-12'), 'grandTotal');
  });

  it('refuses a date, a month or a range that is not valid', () => {
    expectInvalid(() => salesForDate(BILLS, '2026-13-01'), 'date');
    expectInvalid(() => salesForDate(BILLS, '14/10/2026'), 'date');
    expectInvalid(() => salesForMonth(BILLS, '2026-10-14'), 'month');
    expectInvalid(() => salesForMonth(BILLS, '2026-13'), 'month');
    expectInvalid(() => salesInRange(BILLS, 'x', '2026-10-14'), 'fromDate');
    expectInvalid(() => salesInRange(BILLS, '2026-10-14', 'x'), 'toDate');
  });

  it('never returns a number it cannot hold exactly', () => {
    const huge = (id: string) =>
      bill(id, id, 'c1', '2026-10-20', 'estimate', 'active', '90000000000000.00', '0.00');
    expect(salesForDate([huge('h1')], '2026-10-20')).toEqual({
      count: 1,
      totalPaise: 9000000000000000,
    });
    expectInvalid(() => salesForDate([huge('h1'), huge('h2')], '2026-10-20'), 'totalPaise');
  });
});

describe('V5 cancelled bills: their own line (count and value), apart from sales', () => {
  it('cancelled bills for a business date, a month and a range', () => {
    expect(cancelledForDate(BILLS, '2026-10-14')).toEqual({ count: 1, totalPaise: 7000000 });
    expect(cancelledForMonth(BILLS, '2026-10')).toEqual({ count: 1, totalPaise: 7000000 });
    expect(cancelledInRange(BILLS, '2026-10-01', '2026-10-13')).toEqual({
      count: 0,
      totalPaise: 0,
    });
    expect(cancelledForMonth(BILLS, '2026-09')).toEqual({ count: 0, totalPaise: 0 });
  });

  it('a cancelled opening-balance bill is not a cancelled sale (ob2, 1,000)', () => {
    // 14 October holds b7 (a cancelled sale, 70,000.00) and ob2 (a cancelled opening bill, 1,000.00)
    expect(cancelledForDate(BILLS, '2026-10-14').totalPaise).toBe(7000000);
    expect(cancelledForDate(BILLS, '2026-10-14').count).toBe(1);
  });

  it('a date with no cancelled bill is zero', () => {
    expect(cancelledForDate(BILLS, '2026-10-02')).toEqual({ count: 0, totalPaise: 0 });
  });

  it('sales and cancelled bills never share a bill', () => {
    const month = '2026-10';
    const active = BILLS.filter(
      (row) => row.status === 'active' && row.docType !== 'opening_balance'
    );
    const cancelled = BILLS.filter(
      (row) => row.status === 'cancelled' && row.docType !== 'opening_balance'
    );
    expect(salesForMonth(BILLS, month).count + cancelledForMonth(BILLS, month).count).toBe(
      active.filter((row) => row.billDate.startsWith(month)).length +
        cancelled.filter((row) => row.billDate.startsWith(month)).length
    );
  });
});

// ---------------------------------------------------------------------------------------------------------
// outstanding and the pending list
// ---------------------------------------------------------------------------------------------------------

describe('outstanding: the sum of customer_balances (V2), walk-in and opening dues included', () => {
  it('total outstanding', () => {
    // 250,000 + 20,556 + 0 + 999 (walk-in) + 5,000 (opening dues) + 0
    expect(totalOutstanding(CUSTOMERS)).toBe(27655500);
  });

  it('total silver fine outstanding, in milligrams', () => {
    expect(totalFineOutstanding(CUSTOMERS)).toBe(13900);
  });

  it('customers with dues', () => {
    expect(customersWithDues(CUSTOMERS)).toBe(4); // c1, c2, walk-in, c4
  });

  it('an empty list is zero', () => {
    expect(totalOutstanding([])).toBe(0);
    expect(totalFineOutstanding([])).toBe(0);
    expect(customersWithDues([])).toBe(0);
  });

  it('names the field of a row that is not a number, and refuses a sum it cannot hold exactly', () => {
    expectInvalid(() => totalOutstanding([{ ...CUSTOMERS[0], outstanding: 'n/a' }]), 'outstanding');
    expectInvalid(
      () => totalFineOutstanding([{ ...CUSTOMERS[0], fineOutstanding: '1.2345' }]),
      'fineOutstanding'
    );
    const big = (id: string) => ({ ...CUSTOMERS[0], id, outstanding: '90000000000000.00' });
    expectInvalid(() => totalOutstanding([big('a'), big('b')]), 'totalPaise');
  });
});

describe('pending payments list (dashboard panel and Payments report)', () => {
  it('lists the active bills with money pending, oldest first, with their age in days', () => {
    expect(pendingBills(BILLS, TODAY)).toEqual([
      {
        billId: 'ob1',
        billNo: 'OB-0001',
        customerId: 'c4',
        billDate: '2026-10-01',
        pendingPaise: 500000,
        finePendingMg: 0,
        daysOld: 13,
      },
      {
        billId: 'b2',
        billNo: 'JV-2026-0003',
        customerId: 'c1',
        billDate: '2026-10-12',
        pendingPaise: 25000000,
        finePendingMg: 0,
        daysOld: 2,
      },
      {
        billId: 'b3',
        billNo: 'JV-2026-0004',
        customerId: 'c2',
        billDate: '2026-10-13',
        pendingPaise: 2000000,
        finePendingMg: 0,
        daysOld: 1,
      },
      {
        billId: 'b4',
        billNo: 'JV-2026-0005',
        customerId: 'c2',
        billDate: '2026-10-13',
        pendingPaise: 55600,
        finePendingMg: 13900,
        daysOld: 1,
      },
      {
        billId: 'b6',
        billNo: 'JV-2026-0007',
        customerId: 'walkin',
        billDate: '2026-10-14',
        pendingPaise: 99900,
        finePendingMg: 0,
        daysOld: 0,
      },
    ]);
  });

  it('counts the age in business days and never goes below zero', () => {
    expect(pendingBills(BILLS, '2026-10-20').map((row) => row.daysOld)).toEqual([19, 8, 7, 7, 6]);
    expect(pendingBills(BILLS, '2026-09-01').map((row) => row.daysOld)).toEqual([0, 0, 0, 0, 0]);
    expect(pendingBills(BILLS, '2027-10-14')[0].daysOld).toBe(378); // across a year end
  });

  it('leaves out a cancelled bill, a paid bill, and a bill that has only silver pending (as coded)', () => {
    const rows = [
      bill('p1', 'P-1', 'c1', '2026-10-10', 'estimate', 'cancelled', '10.00', '10.00'),
      bill('p2', 'P-2', 'c1', '2026-10-10', 'estimate', 'active', '10.00', '0.00'),
      bill('p3', 'P-3', 'c1', '2026-10-10', 'estimate', 'active', '10.00', '0.00', '5.000'),
      bill('p4', 'P-4', 'c1', '2026-10-10', 'estimate', 'active', '10.00', '0.01'),
    ];
    expect(pendingBills(rows, TODAY).map((row) => row.billId)).toEqual(['p4']);
  });

  it('puts bills of the same date in bill number order, so the list is stable', () => {
    // the ids sort the opposite way to the bill numbers, so only the bill number can put them right
    const rows = [
      bill('a-id', 'JV-2026-0002', 'c1', '2026-10-10', 'estimate', 'active', '10.00', '10.00'),
      bill('c-id', 'JV-2026-0003', 'c1', '2026-10-09', 'estimate', 'active', '10.00', '10.00'),
      bill('z-id', 'JV-2026-0001', 'c1', '2026-10-10', 'estimate', 'active', '10.00', '10.00'),
    ];
    expect(pendingBills(rows, TODAY).map((row) => row.billNo)).toEqual([
      'JV-2026-0003',
      'JV-2026-0001',
      'JV-2026-0002',
    ]);
  });

  it('refuses a "today" that is not a calendar date', () => {
    expectInvalid(() => pendingBills(BILLS, 'today'), 'today');
  });
});

// ---------------------------------------------------------------------------------------------------------
// V4: payments by mode and the evening figures
// ---------------------------------------------------------------------------------------------------------

describe('V4 payments by mode', () => {
  it('totals each mode over all dates, in a fixed mode order', () => {
    expect(paymentModeTotals(DAILY)).toEqual([
      { mode: 'Cash', moneyInPaise: 7000049, moneyOutPaise: 200000, netPaise: 6800049 },
      { mode: 'UPI', moneyInPaise: 3500000, moneyOutPaise: 100000, netPaise: 3400000 },
      { mode: 'Card', moneyInPaise: 100000, moneyOutPaise: 0, netPaise: 100000 },
      { mode: 'Bank Transfer', moneyInPaise: 10000000, moneyOutPaise: 0, netPaise: 10000000 },
      { mode: 'Other', moneyInPaise: 50050, moneyOutPaise: 0, netPaise: 50050 },
    ]);
  });

  it('can be limited to a range of business dates, both ends included', () => {
    const october = paymentModeTotals(DAILY, { from: '2026-10-01', to: '2026-10-31' });
    expect(october[0]).toEqual({
      mode: 'Cash',
      moneyInPaise: 6000050,
      moneyOutPaise: 200000,
      netPaise: 5800050,
    });
    expect(paymentModeTotals(DAILY, { from: '2026-09-30', to: '2026-09-30' })[0]).toEqual({
      mode: 'Cash',
      moneyInPaise: 999999,
      moneyOutPaise: 0,
      netPaise: 999999,
    });
    expect(paymentModeTotals(DAILY, { from: '2026-10-14' }).map((row) => row.netPaise)).toEqual([
      4800000, 3000000, 100000, 0, 50050,
    ]);
    expect(paymentModeTotals(DAILY, { to: '2026-09-30' }).map((row) => row.netPaise)).toEqual([
      999999, 0, 0, 0, 0,
    ]);
  });

  it('keeps all five modes, with zeros, when there is nothing in the range', () => {
    const empty = paymentModeTotals(DAILY, { from: '2030-01-01', to: '2030-01-31' });
    expect(empty.map((row) => row.mode)).toEqual(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']);
    expect(
      empty.every((row) => row.moneyInPaise === 0 && row.moneyOutPaise === 0 && row.netPaise === 0)
    ).toBe(true);
    expect(paymentModeTotals([]).map((row) => row.netPaise)).toEqual([0, 0, 0, 0, 0]);
  });

  it('never drops money of a mode it does not know; it comes after the known modes', () => {
    const rows = [...DAILY, day('2026-10-14', 'Cheque' as PayMode, '700.00', '0.00', '700.00')];
    const totals = paymentModeTotals(rows);
    expect(totals).toHaveLength(6);
    expect(totals[5]).toEqual({
      mode: 'Cheque',
      moneyInPaise: 70000,
      moneyOutPaise: 0,
      netPaise: 70000,
    });
    expect(totalCollected(rows)).toBe(20350099 + 70000);
  });

  it('total collected is the net of money in and money out over the range', () => {
    expect(totalCollected(DAILY)).toBe(20350099);
    expect(totalCollected(DAILY, { from: '2026-10-01', to: '2026-10-31' })).toBe(19350100);
    expect(totalCollected([])).toBe(0);
  });

  it('refuses a range with a date that is not valid', () => {
    expectInvalid(() => paymentModeTotals(DAILY, { from: '1 Oct' }), 'from');
    expectInvalid(() => paymentModeTotals(DAILY, { to: '2026-02-30' }), 'to');
  });

  it('names the field of a row that is not a number', () => {
    expectInvalid(() => paymentModeTotals([day('2026-10-14', 'Cash', 'x', '0', '0')]), 'moneyIn');
    expectInvalid(
      () => paymentModeTotals([day('2026-10-14', 'Cash', '1', '1.234', '0')]),
      'moneyOut'
    );
    expectInvalid(() => paymentModeTotals([day('2026-10-14', 'Cash', '1', '0', '')]), 'net');
  });
});

describe('V4 the owner evening check: today Cash net, today UPI net, total outstanding', () => {
  it('cash net and UPI net for a business date', () => {
    expect(cashNetForDate(DAILY, '2026-10-14')).toBe(4800000);
    expect(upiNetForDate(DAILY, '2026-10-14')).toBe(3000000);
    expect(cashNetForDate(DAILY, '2026-10-13')).toBe(1000050);
    expect(upiNetForDate(DAILY, '2026-10-13')).toBe(400000); // 5,000 in, 1,000 out
  });

  it('is zero for a day with no rows', () => {
    expect(cashNetForDate(DAILY, '2026-10-15')).toBe(0);
    expect(upiNetForDate(DAILY, '2026-10-15')).toBe(0);
    expect(cashNetForDate([], '2026-10-15')).toBe(0);
  });

  it('only counts the Cash and UPI modes: Card, Bank Transfer and Other have their own rows', () => {
    expect(cashNetForDate(DAILY, '2026-10-13')).not.toBe(1000050 + 10000000);
    expect(upiNetForDate(DAILY, '2026-10-14')).not.toBe(3000000 + 100000);
  });

  it('puts the three figures together', () => {
    expect(eveningFigures(DAILY, CUSTOMERS, '2026-10-14')).toEqual({
      businessDate: '2026-10-14',
      cashNetPaise: 4800000,
      upiNetPaise: 3000000,
      outstandingPaise: 27655500,
    });
    expect(eveningFigures(DAILY, CUSTOMERS, '2026-10-13')).toEqual({
      businessDate: '2026-10-13',
      cashNetPaise: 1000050,
      upiNetPaise: 400000,
      outstandingPaise: 27655500,
    });
  });

  it('takes the business day from a real instant: just after midnight in India is the new day', () => {
    const justAfterMidnight = businessDateOf(Date.parse('2026-10-13T18:31:00Z'));
    expect(justAfterMidnight).toBe('2026-10-14');
    expect(eveningFigures(DAILY, CUSTOMERS, justAfterMidnight).cashNetPaise).toBe(4800000);
  });

  it('refuses a business date that is not valid', () => {
    expectInvalid(() => cashNetForDate(DAILY, '14-10-2026'), 'date');
    expectInvalid(() => eveningFigures(DAILY, CUSTOMERS, ''), 'date');
  });
});

// ---------------------------------------------------------------------------------------------------------
// the customer card
// ---------------------------------------------------------------------------------------------------------

describe('the customer card', () => {
  const card = (id: string) => {
    const row = CUSTOMERS.find((customer) => customer.id === id);
    if (!row) throw new Error(`no fixture customer ${id}`);
    return customerCard(row, BILLS);
  };

  it('a customer with an unpaid bill (c1, the cancelled bill is counted on its own)', () => {
    expect(card('c1')).toEqual({
      customerId: 'c1',
      totalPurchasesPaise: 40999999,
      receivedPaise: 15999999,
      outstandingPaise: 25000000,
      advancePaise: 0,
      balancePaise: 25000000,
      fineOutstandingMg: 0,
      fineAdvanceMg: 0,
      fineBalanceMg: 0,
      lastPurchase: '2026-10-12',
      billCount: 3,
      cancelledBillCount: 1,
      pendingBillCount: 1,
    });
  });

  it('a wholesale silver customer with fine due (c2), read from a number and from text', () => {
    expect(card('c2')).toEqual({
      customerId: 'c2',
      totalPurchasesPaise: 12055600,
      receivedPaise: 10000000,
      outstandingPaise: 2055600,
      advancePaise: 0,
      balancePaise: 2055600,
      fineOutstandingMg: 13900,
      fineAdvanceMg: 0,
      fineBalanceMg: 13900,
      lastPurchase: '2026-10-13',
      billCount: 2,
      cancelledBillCount: 0,
      pendingBillCount: 2,
    });
  });

  it('a customer who holds an advance (c3): the balance and the fine balance are negative', () => {
    expect(card('c3')).toEqual({
      customerId: 'c3',
      totalPurchasesPaise: 5000000,
      receivedPaise: 8000000,
      outstandingPaise: 0,
      advancePaise: 3000000,
      balancePaise: -3000000,
      fineOutstandingMg: 0,
      fineAdvanceMg: 2500,
      fineBalanceMg: -2500,
      lastPurchase: '2026-10-05',
      billCount: 1,
      cancelledBillCount: 0,
      pendingBillCount: 0,
    });
  });

  it('dues brought forward (c4): not a purchase, not a bill count, but pending; a cancelled opening bill is no cancelled sale', () => {
    expect(card('c4')).toEqual({
      customerId: 'c4',
      totalPurchasesPaise: 0,
      receivedPaise: 0,
      outstandingPaise: 500000,
      advancePaise: 0,
      balancePaise: 500000,
      fineOutstandingMg: 0,
      fineAdvanceMg: 0,
      fineBalanceMg: 0,
      lastPurchase: null,
      billCount: 0,
      cancelledBillCount: 0,
      pendingBillCount: 1,
    });
  });

  it('the walk-in customer is a customer like any other', () => {
    const walkIn = card('walkin');
    expect(walkIn.outstandingPaise).toBe(99900);
    expect(walkIn.advancePaise).toBe(0);
    expect(walkIn.billCount).toBe(1);
  });

  it('a customer who never bought anything has an all-zero card', () => {
    expect(card('c5')).toEqual({
      customerId: 'c5',
      totalPurchasesPaise: 0,
      receivedPaise: 0,
      outstandingPaise: 0,
      advancePaise: 0,
      balancePaise: 0,
      fineOutstandingMg: 0,
      fineAdvanceMg: 0,
      fineBalanceMg: 0,
      lastPurchase: null,
      billCount: 0,
      cancelledBillCount: 0,
      pendingBillCount: 0,
    });
  });

  it('a bill with only silver pending counts as pending on the card, though it is not in the pending list', () => {
    const silverOnly = [
      bill('f1', 'F-1', 'c2', '2026-10-10', 'estimate', 'active', '500.00', '0.00', '2.500'),
      bill('f2', 'F-2', 'c2', '2026-10-11', 'estimate', 'active', '500.00', '0.00', '0.000'),
    ];
    expect(customerCard(CUSTOMERS[1], silverOnly)).toMatchObject({
      billCount: 2,
      pendingBillCount: 1,
    });
    expect(pendingBills(silverOnly, TODAY)).toEqual([]);
  });

  it('only looks at the bills of that customer', () => {
    expect(
      customerCard(
        CUSTOMERS[1],
        BILLS.filter((row) => row.customerId === 'c2')
      )
    ).toEqual(card('c2'));
    expect(customerCard(CUSTOMERS[1], [])).toMatchObject({ billCount: 0, pendingBillCount: 0 });
  });

  it('names the field of a row that is not a number', () => {
    expectInvalid(() => customerCard({ ...CUSTOMERS[0], received: '1,000' }, BILLS), 'received');
    expectInvalid(
      () => customerCard({ ...CUSTOMERS[0], fineBalance: '0.0005' }, BILLS),
      'fineBalance'
    );
  });
});

// ---------------------------------------------------------------------------------------------------------
// T-B15 UNIT: every screen gets the same figure from the same data
// ---------------------------------------------------------------------------------------------------------

describe('T-B15 UNIT: dashboard, reports, customer card and evening figures agree on the same data', () => {
  const card = (id: string) =>
    customerCard(CUSTOMERS.find((c) => c.id === id) as CustomerBalanceRow, BILLS);

  it('the data set itself is consistent the way the database guarantees (I10 and V2)', () => {
    for (const customer of CUSTOMERS) {
      const mine = BILLS.filter((row) => row.customerId === customer.id && row.status === 'active');
      const pending = mine.reduce((sum, row) => sum + Math.round(Number(row.pending) * 100), 0);
      expect(pending, `pending of ${customer.id}`).toBe(card(customer.id).outstandingPaise);
      const purchases = mine
        .filter((row) => row.docType !== 'opening_balance')
        .reduce((sum, row) => sum + Math.round(Number(row.grandTotal) * 100), 0);
      expect(purchases, `purchases of ${customer.id}`).toBe(card(customer.id).totalPurchasesPaise);
      const view = card(customer.id);
      expect(view.balancePaise).toBe(view.outstandingPaise - view.advancePaise);
      expect(view.fineBalanceMg).toBe(view.fineOutstandingMg - view.fineAdvanceMg);
    }
  });

  it('total outstanding is the same on the dashboard, in the evening check, on every card and in the pending list', () => {
    const total = totalOutstanding(CUSTOMERS);
    expect(eveningFigures(DAILY, CUSTOMERS, TODAY).outstandingPaise).toBe(total);
    expect(CUSTOMERS.reduce((sum, customer) => sum + card(customer.id).outstandingPaise, 0)).toBe(
      total
    );
    expect(pendingBills(BILLS, TODAY).reduce((sum, row) => sum + row.pendingPaise, 0)).toBe(total);
  });

  it('silver fine outstanding is the same in total, on the cards and in the pending list', () => {
    const total = totalFineOutstanding(CUSTOMERS);
    expect(CUSTOMERS.reduce((sum, customer) => sum + card(customer.id).fineOutstandingMg, 0)).toBe(
      total
    );
    expect(pendingBills(BILLS, TODAY).reduce((sum, row) => sum + row.finePendingMg, 0)).toBe(total);
  });

  it('sales of a month equal the sum of its days, and a range over the month', () => {
    let count = 0;
    let total = 0;
    for (let dayOfMonth = 1; dayOfMonth <= 31; dayOfMonth++) {
      const date = `2026-10-${String(dayOfMonth).padStart(2, '0')}`;
      const figure = salesForDate(BILLS, date);
      count += figure.count;
      total += figure.totalPaise;
    }
    expect(salesForMonth(BILLS, '2026-10')).toEqual({ count, totalPaise: total });
    expect(salesInRange(BILLS, '2026-10-01', '2026-10-31')).toEqual({ count, totalPaise: total });
  });

  it('all sales ever equal the total purchases of all customers (V2 total_purchases)', () => {
    const everything = salesInRange(BILLS, '0001-01-01', '9999-12-31');
    const purchases = CUSTOMERS.reduce(
      (sum, customer) => sum + card(customer.id).totalPurchasesPaise,
      0
    );
    expect(everything.totalPaise).toBe(purchases);
    expect(everything.totalPaise).toBe(58155499); // 571,555.00 in October + 9,999.99 in September
  });

  it('the cash book of a day is the same figure in the evening check and in the payment report', () => {
    for (const date of ['2026-10-13', '2026-10-14']) {
      const cash = paymentModeTotals(DAILY, { from: date, to: date })[0];
      expect(cash.mode).toBe('Cash');
      expect(cash.netPaise).toBe(cashNetForDate(DAILY, date));
      expect(eveningFigures(DAILY, CUSTOMERS, date).cashNetPaise).toBe(cash.netPaise);
    }
  });

  it('is deterministic and does not change its input', () => {
    const frozenBills = Object.freeze(BILLS.map((row) => Object.freeze({ ...row })));
    const frozenCustomers = Object.freeze(CUSTOMERS.map((row) => Object.freeze({ ...row })));
    const frozenDaily = Object.freeze(DAILY.map((row) => Object.freeze({ ...row })));
    const first = [
      salesForMonth(frozenBills, '2026-10'),
      pendingBills(frozenBills, TODAY),
      eveningFigures(frozenDaily, frozenCustomers, TODAY),
      paymentModeTotals(frozenDaily),
    ];
    const second = [
      salesForMonth(frozenBills, '2026-10'),
      pendingBills(frozenBills, TODAY),
      eveningFigures(frozenDaily, frozenCustomers, TODAY),
      paymentModeTotals(frozenDaily),
    ];
    expect(second).toEqual(first);
  });
});

// ---------------------------------------------------------------------------------------------------------
// C12 / S3: no floating point in the money path
// ---------------------------------------------------------------------------------------------------------

describe('S3: the selectors do their money sums in integers', () => {
  const source = readFileSync(
    fileURLToPath(new URL('../../src/lib/selectors.ts', import.meta.url)),
    'utf8'
  );
  const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

  it('uses no floating-point rounding or parsing', () => {
    const forbidden =
      /\b(parseFloat|toFixed|toPrecision|Math\.(round|floor|ceil|trunc|fround|pow|sqrt|exp|log))\b/;
    expect(code).not.toMatch(forbidden);
  });

  it('adds with BigInt, so a total is exact or refused, never rounded', () => {
    expect(code).toContain('BigInt(');
  });
});
