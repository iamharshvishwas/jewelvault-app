// FB-D3 (Siddhi #7): the outstanding list and the 60-day payment alert.
//   - `overdueCustomers(bills, customers, today, days = 60)`: a customer is listed when one of their bills has money pending (V1) and its bill_date is MORE than `days` days before today (the
//     Asia/Kolkata business date). The amount is what is pending on those old bills, in whole paise as a bigint; the date and the days are of the oldest. Cancelled bills are not pending (V1), an
//     opening-balance bill is (old dues), the walk-in customer is never listed, and the list is the oldest first.
//   - `outstandingRows(balances, bills, customers, asOf)`: the customers who owe money or silver (V2), with the age of their oldest pending bill; the rows of the CSV
//     `Customer,Mobile,Outstanding (Rs),Fine due (g),Oldest pending bill,Days`, written through the one formula guard of downloadCsv.
//   - the store's readers (`getOverdueCustomers`, `getOutstandingRows`) read V1, V2 and the customers from memory and the Asia/Kolkata clock: at 23:59 in India a bill is 60 days old and not listed, at
//     00:01 it is 61 and listed.
//
// Every figure is worked out by hand in the comment above its rows; the pure functions are given rows built here, the readers rows of the real cache.
//
// Run: npm test -- tests/unit/outstanding.test.ts      (or: npm test -- -t FB-D3)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  businessDateOf,
  outstandingRows,
  overdueCustomers,
  type BillSummaryRow,
  type CustomerBalanceRow,
  type CustomerContact,
} from '@/lib/selectors';
import { outstandingCsvRows } from '@/lib/outstandingExport';
import { dayLabel } from '@/lib/rateGuard';
import { downloadCsv } from '@/lib/exportUtils';
import { at, uuid } from './support/rows';
import { balanceRow, billRow, customerRow, summaryRow } from './support/money-rows';
import { parseCsv } from './support/csv';

// ================================================================================================ rows made here

const TODAY = '2026-11-14';
/** The business date `n` days before TODAY. */
const daysBefore = (n: number): string => {
  const d = new Date(`${TODAY}T12:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
};

const meera = uuid(5701);
const asha = uuid(5702);
const dev = uuid(5703);
const walkIn = uuid(5704);

const people: CustomerContact[] = [
  { id: meera, name: 'Meera Jain', mobile: '9000170001', isWalkIn: false },
  { id: asha, name: 'Asha Rao', mobile: '+919000170002', isWalkIn: false },
  { id: dev, name: 'Dev Sethi', mobile: null, isWalkIn: false },
  { id: walkIn, name: 'Walk-in', mobile: null, isWalkIn: true },
];

let n = 0;
function bill(
  customerId: string,
  billDate: string,
  over: Partial<BillSummaryRow> = {}
): BillSummaryRow {
  n += 1;
  return {
    id: uuid(5800 + n),
    billNo: `W17-${String(n).padStart(4, '0')}`,
    customerId,
    billDate,
    docType: 'estimate',
    status: 'active',
    grandTotal: '1000.00',
    pending: '1000.00',
    finePending: '0.000',
    ...over,
  };
}

const ids = (rows: Array<{ customerId: string }>) => rows.map((r) => r.customerId);

// ================================================================================================ overdueCustomers

describe('FB-D3 overdueCustomers: who has a payment pending for more than 60 days', () => {
  it('a bill 61 days old with Rs 1 pending is listed with 61 days; 60 days old is not (it is not MORE than 60)', () => {
    const sixtyOne = overdueCustomers(
      [bill(meera, daysBefore(61), { pending: '1.00' })],
      people,
      TODAY
    );
    expect(sixtyOne).toHaveLength(1);
    expect(sixtyOne[0]).toEqual({
      customerId: meera,
      name: 'Meera Jain',
      mobile: '9000170001',
      pendingPaise: BigInt(100),
      oldestPendingBillDate: daysBefore(61),
      daysPending: 61,
    });
    expect(typeof sixtyOne[0].pendingPaise).toBe('bigint');
    expect(
      overdueCustomers([bill(meera, daysBefore(60), { pending: '1.00' })], people, TODAY)
    ).toEqual([]);
    expect(
      overdueCustomers([bill(meera, daysBefore(59), { pending: '1.00' })], people, TODAY)
    ).toEqual([]);
  });

  it('a bill paid in full is not listed, however old; one with only silver pending is not (the rule is money pending)', () => {
    const rows = [
      bill(meera, daysBefore(200), { pending: '0.00' }),
      bill(asha, daysBefore(200), { pending: '0.00', finePending: '3.000' }),
    ];
    expect(overdueCustomers(rows, people, TODAY)).toEqual([]);
  });

  it('the walk-in customer is never listed, however old and however much is pending on their bills', () => {
    expect(
      overdueCustomers([bill(walkIn, daysBefore(300), { pending: '5000.00' })], people, TODAY)
    ).toEqual([]);
  });

  it('a cancelled bill is not listed; an opening-balance bill is (old dues are dues)', () => {
    const cancelled = bill(meera, daysBefore(90), { status: 'cancelled', pending: '0.00' });
    // a cancelled bill whose row still says money pending is not pending either (V1 gives a cancelled bill 0, and the status is looked at too)
    const cancelledWithMoney = bill(asha, daysBefore(90), {
      status: 'cancelled',
      pending: '700.00',
    });
    const opening = bill(dev, daysBefore(75), { docType: 'opening_balance', pending: '20000.00' });
    const listed = overdueCustomers([cancelled, cancelledWithMoney, opening], people, TODAY);
    expect(ids(listed)).toEqual([dev]);
    expect(listed[0]).toMatchObject({ pendingPaise: BigInt(2_000_000), daysPending: 75 });
  });

  it("a customer's amount is the money pending on their old bills; a newer pending bill adds nothing, the oldest gives the date and the days", () => {
    // Meera: 800.50 pending on a bill 100 days old, 1,200.25 on one 70 days old, and 3,000.00 on one 10 days old (not overdue)
    const rows = [
      bill(meera, daysBefore(70), { pending: '1200.25' }),
      bill(meera, daysBefore(10), { pending: '3000.00' }),
      bill(meera, daysBefore(100), { pending: '800.50' }),
    ];
    const [row] = overdueCustomers(rows, people, TODAY);
    expect(row.pendingPaise).toBe(BigInt(80_050 + 120_025)); // 2,000.75
    expect(row.oldestPendingBillDate).toBe(daysBefore(100));
    expect(row.daysPending).toBe(100);
  });

  it('sorted with the oldest first; the number of days is a parameter (30 here)', () => {
    const rows = [
      bill(asha, daysBefore(65), { pending: '10.00' }),
      bill(meera, daysBefore(120), { pending: '20.00' }),
      bill(dev, daysBefore(40), { pending: '30.00' }),
    ];
    expect(ids(overdueCustomers(rows, people, TODAY))).toEqual([meera, asha]);
    expect(ids(overdueCustomers(rows, people, TODAY, 30))).toEqual([meera, asha, dev]);
    expect(ids(overdueCustomers(rows, people, TODAY, 100))).toEqual([meera]);
  });

  it('a customer whose row is not in memory is still listed (their money is owed), without a name', () => {
    const stranger = uuid(5799);
    const [row] = overdueCustomers(
      [bill(stranger, daysBefore(80), { pending: '5.00' })],
      people,
      TODAY
    );
    expect(row).toMatchObject({ customerId: stranger, name: '', mobile: '', daysPending: 80 });
  });

  it('a date that is not a business date is refused, never guessed', () => {
    expect(() => overdueCustomers([], people, '14/11/2026')).toThrow();
  });
});

// ================================================================================================ the Asia/Kolkata day

describe('FB-D3 the Asia/Kolkata day: 23:59 and 00:01', () => {
  // a bill dated 15 Sep 2026: on 14 Nov it is 60 days old, on 15 Nov 61
  const old = [bill(meera, '2026-09-15', { pending: '1.00' })];

  it('at 23:59 in India the bill is 60 days old and not listed; at 00:01 it is 61 and listed', () => {
    const before = businessDateOf(Date.parse('2026-11-14T18:29:00.000Z')); // 23:59 IST on the 14th
    const after = businessDateOf(Date.parse('2026-11-14T18:31:00.000Z')); // 00:01 IST on the 15th
    expect(before).toBe('2026-11-14');
    expect(after).toBe('2026-11-15');
    expect(overdueCustomers(old, people, before)).toEqual([]);
    const [row] = overdueCustomers(old, people, after);
    expect(row.daysPending).toBe(61);
  });

  it("the computer's own time zone plays no part: 18:29 UTC is the 14th and 18:31 UTC the 15th in India, even where it is still the 14th", () => {
    expect(businessDateOf(Date.parse('2026-11-14T23:59:00.000-08:00'))).toBe('2026-11-15');
    expect(businessDateOf(Date.parse('2026-11-14T00:01:00.000+05:30'))).toBe('2026-11-14');
  });
});

// ================================================================================================ outstandingRows

function balance(customerId: string, outstanding: string, fine = '0.000'): CustomerBalanceRow {
  return {
    id: customerId,
    totalPurchases: outstanding,
    received: '0.00',
    outstanding,
    advance: '0.00',
    balance: outstanding,
    fineOutstanding: fine,
    fineAdvance: '0.000',
    fineBalance: fine,
    lastPurchase: null,
  };
}

describe('FB-D3 outstandingRows: the customers who owe, as of now', () => {
  it('lists customers with money or silver outstanding (V2), with the age of the oldest bill still pending, oldest first; nobody who owes nothing, nobody who holds an advance, never the walk-in', () => {
    const balances = [
      balance(meera, '3500.50', '3.500'),
      balance(asha, '0.00', '12.250'), // silver only
      balance(dev, '0.00'), // owes nothing
      balance(walkIn, '900.00'),
    ];
    const bills = [
      bill(meera, daysBefore(10), { pending: '500.50' }),
      bill(meera, daysBefore(74), { pending: '3000.00', finePending: '3.500' }),
      bill(asha, daysBefore(20), { pending: '0.00', finePending: '12.250' }),
      bill(dev, daysBefore(300), { pending: '0.00' }),
      bill(walkIn, daysBefore(5), { pending: '900.00' }),
    ];
    const rows = outstandingRows(balances, bills, people, TODAY);
    expect(ids(rows)).toEqual([meera, asha]);
    expect(rows[0]).toEqual({
      customerId: meera,
      name: 'Meera Jain',
      mobile: '9000170001',
      outstandingPaise: BigInt(350_050),
      fineDueMg: BigInt(3500),
      oldestPendingBillDate: daysBefore(74),
      daysPending: 74,
    });
    // Asha owes silver only: her oldest pending bill is the one with silver pending
    expect(rows[1]).toMatchObject({
      outstandingPaise: BigInt(0),
      fineDueMg: BigInt(12_250),
      oldestPendingBillDate: daysBefore(20),
      daysPending: 20,
    });
  });

  it('a cancelled bill does not give the date; a customer with no pending bill in memory has no date and no days', () => {
    const rows = outstandingRows(
      [balance(meera, '100.00'), balance(dev, '50.00')],
      [bill(meera, daysBefore(90), { status: 'cancelled', pending: '0.00' })],
      people,
      TODAY
    );
    expect(rows.map((r) => [r.customerId, r.oldestPendingBillDate, r.daysPending])).toEqual([
      [meera, null, null],
      [dev, null, null],
    ]);
  });

  it('the opening-balance dues count: the oldest pending bill can be the dues brought forward', () => {
    const [row] = outstandingRows(
      [balance(dev, '20000.00')],
      [bill(dev, daysBefore(400), { docType: 'opening_balance', pending: '20000.00' })],
      people,
      TODAY
    );
    expect(row).toMatchObject({ outstandingPaise: BigInt(2_000_000), daysPending: 400 });
  });
});

// ================================================================================================ the CSV

describe('FB-D3 the CSV of the outstanding list', () => {
  let saved: Array<{ blob: Blob; filename: string }> = [];
  beforeEach(() => {
    saved = [];
    let current: Blob | null = null;
    vi.stubGlobal('window', { setTimeout: () => 0 });
    vi.stubGlobal('document', {
      createElement: () => ({
        href: '',
        download: '',
        click() {
          if (current) saved.push({ blob: current, filename: this.download });
        },
        remove() {},
      }),
      body: { appendChild() {} },
    });
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob) => {
      current = blob as Blob;
      return 'blob:test';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const rowsOfList = () =>
    outstandingRows(
      [balance(meera, '3500.50', '3.500'), balance(asha, '1200.00'), balance(dev, '40.05')],
      [
        bill(meera, daysBefore(74), { pending: '3500.50', finePending: '3.500' }),
        bill(asha, daysBefore(61), { pending: '1200.00' }),
      ],
      [...people.slice(0, 2), { id: dev, name: '=HYPERLINK("x")', mobile: null, isWalkIn: false }],
      TODAY
    );

  it('has the columns of the brief, in that order, with the money in rupees and the silver in grams as exact text', () => {
    const csv = outstandingCsvRows(rowsOfList());
    expect(Object.keys(csv[0])).toEqual([
      'Customer',
      'Mobile',
      'Outstanding (Rs)',
      'Fine due (g)',
      'Oldest pending bill',
      'Days',
    ]);
    expect(csv[0]).toEqual({
      Customer: 'Meera Jain',
      Mobile: '9000170001',
      'Outstanding (Rs)': '3500.50',
      'Fine due (g)': '3.500',
      'Oldest pending bill': daysBefore(74),
      Days: 74,
    });
    expect(csv[1]).toMatchObject({
      'Outstanding (Rs)': '1200.00',
      'Fine due (g)': '0.000',
      Days: 61,
    });
    // no date known: an empty cell, not a made-up one
    expect(csv[2]).toMatchObject({
      'Outstanding (Rs)': '40.05',
      'Oldest pending bill': '',
      Days: '',
    });
  });

  it('is written by downloadCsv: the header line of the brief, a +91 mobile and a formula-looking name with the single quote in front, the file named for the day', async () => {
    downloadCsv(`Outstanding list ${TODAY}`, outstandingCsvRows(rowsOfList()));
    expect(saved).toHaveLength(1);
    expect(saved[0].filename).toBe('outstanding-list-2026-11-14.csv');
    const text = await saved[0].blob.text();
    expect(text.replace(/^﻿/, '').split('\r\n')[0]).toBe(
      'Customer,Mobile,Outstanding (Rs),Fine due (g),Oldest pending bill,Days'
    );
    const parsed = parseCsv(text);
    expect(parsed.rows).toHaveLength(3);
    // Asha's mobile starts with a plus: a spreadsheet would read it as a formula, so it is written as text
    const ashaRow = parsed.rows.find((r) => r[0] === 'Asha Rao');
    expect(ashaRow?.[1]).toBe("'+919000170002");
    // and a name that is a formula is text too
    expect(parsed.rows.map((r) => r[0])).toContain('\'=HYPERLINK("x")');
    for (const [cell] of parsed.rows) expect(cell).not.toMatch(/^[=+\-@\t\r]/);
  });
});

// ================================================================================================ the readers over the store

type Role = 'owner' | 'biller';

async function world(now: string) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const [cache, app] = await Promise.all([import('@/lib/cache/cache'), import('@/lib/appStore')]);
  const rowCache = cache.rowCache as unknown as {
    merge: (resource: string, rows: readonly object[]) => number;
  };
  const owed = billRow(1, meera, {
    bill_no: 'W17-0001',
    bill_date: '2026-09-15',
    grand_total: '250.00',
  });
  const paid = billRow(2, asha, {
    bill_no: 'W17-0002',
    bill_date: '2026-08-01',
    grand_total: '900.00',
  });
  rowCache.merge('users', [
    { id: uuid(901), full_name: 'Asha Verma', role: 'biller', active: true, updated_at: at(1) },
  ]);
  rowCache.merge('customers', [
    customerRow(meera, { name: 'Meera Jain', mobile: '9000170001' }),
    customerRow(asha, { name: 'Asha Rao', mobile: '9000170002' }),
    customerRow(walkIn, { name: 'Walk-in', mobile: null, is_walkin: true }),
  ]);
  rowCache.merge('bills', [owed, paid]);
  rowCache.merge('bill-summary', [
    summaryRow(owed, {
      received: '0.00',
      pending: '250.00',
      fine_settled: '0.000',
      fine_pending: '0.000',
      payment_status: 'Pending',
      item_count: 1,
    }),
    summaryRow(paid, {
      received: '900.00',
      pending: '0.00',
      fine_settled: '0.000',
      fine_pending: '0.000',
      payment_status: 'Paid',
      item_count: 1,
    }),
  ]);
  rowCache.merge('customer-balances', [
    balanceRow(meera, { outstanding: '250.00', balance: '250.00' }),
    balanceRow(asha),
  ]);
  return app;
}

afterEach(() => {
  vi.useRealTimers();
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('FB-D3 the store reads the books and the Asia/Kolkata clock', () => {
  it('23:59 in India on 14 Nov: the bill of 15 Sep is 60 days old, nobody is listed; 00:01 on the 15th: it is 61, Meera is', async () => {
    const app = await world('2026-11-14T18:29:00.000Z');
    expect(app.getOverdueCustomers()).toEqual([]);
    vi.setSystemTime(new Date('2026-11-14T18:31:00.000Z'));
    const [row] = app.getOverdueCustomers();
    expect(row).toMatchObject({
      customerId: meera,
      name: 'Meera Jain',
      mobile: '9000170001',
      pendingPaise: BigInt(25_000),
      oldestPendingBillDate: '2026-09-15',
      daysPending: 61,
    });
    // the one who paid in full is not there, and nor is the walk-in
    expect(app.getOverdueCustomers().map((r) => r.customerId)).toEqual([meera]);
  });

  it('the outstanding list as of now is the customer card figure (V2) with the age of the oldest pending bill', async () => {
    const app = await world('2026-11-15T10:00:00.000Z');
    const rows = app.getOutstandingRows();
    expect(rows).toEqual([
      {
        customerId: meera,
        name: 'Meera Jain',
        mobile: '9000170001',
        outstandingPaise: BigInt(25_000),
        fineDueMg: BigInt(0),
        oldestPendingBillDate: '2026-09-15',
        daysPending: 61,
      },
    ]);
  });
});

// ================================================================================================ the dashboard card

describe('FB-D3 the dashboard card "Payment pending over 60 days"', () => {
  const plain = (html: string) =>
    html
      .replace(/<[^>]*>/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim();

  async function draw(now: string, { role, extra = 0 }: { role?: Role; extra?: number } = {}) {
    await world(now);
    if (extra > 0) await moreOverdue(extra);
    if (role) {
      vi.doMock('@/lib/authStore', async (importOriginal) => ({
        ...(await importOriginal<typeof import('@/lib/authStore')>()),
        useSession: () => ({ role }),
      }));
    }
    const panel = await import('@/app/components/DashboardOverduePanel');
    return renderToStaticMarkup(React.createElement(panel.default));
  }

  /** `count` more customers, each with a bill of 100.00 pending that is 105 days old on 2026-11-15, on top of Meera of the world. */
  async function moreOverdue(count: number) {
    const cache = await import('@/lib/cache/cache');
    const rowCache = cache.rowCache as unknown as {
      merge: (resource: string, rows: readonly object[]) => number;
    };
    const customers = [];
    const bills = [];
    const summaries = [];
    for (let i = 0; i < count; i++) {
      const id = uuid(6100 + i);
      customers.push(customerRow(id, { name: `Overdue ${i + 1}`, mobile: `90001701${10 + i}` }));
      const owed = billRow(20 + i, id, {
        bill_no: `W17-X${i + 1}`,
        bill_date: '2026-08-01',
        grand_total: '100.00',
      });
      bills.push(owed);
      summaries.push(
        summaryRow(owed, {
          received: '0.00',
          pending: '100.00',
          fine_settled: '0.000',
          fine_pending: '0.000',
          payment_status: 'Pending',
          item_count: 1,
        })
      );
    }
    rowCache.merge('customers', customers);
    rowCache.merge('bills', bills);
    rowCache.merge('bill-summary', summaries);
  }

  it("lists the overdue customer with the amount, the oldest bill date and the days, and the name opens that customer's ledger", async () => {
    const html = await draw('2026-11-15T10:00:00.000Z');
    expect(plain(html)).toContain('Payment pending over 60 days');
    expect(html).toContain('data-testid="overdue-count"');
    expect(plain(/data-testid="overdue-count"[^>]*>([\s\S]*?)<\/span>/.exec(html)![1])).toBe(
      '1 customer'
    );
    const row = /<tr[^>]*data-testid="overdue-row"[^>]*>([\s\S]*?)<\/tr>/.exec(html)![1];
    expect(plain(row)).toBe(`Meera Jain 9000170001 ₹250 ${dayLabel('2026-09-15')} 61 days`);
    expect(row).toContain(`href="/customer-ledger?customer=${meera}"`);
    // the customer who paid in full and the walk-in are not on the card
    expect(plain(html)).not.toContain('Asha Rao');
    expect(plain(html)).not.toContain('Walk-in');
  });

  it('says so when nobody is overdue (60 days old exactly is not overdue)', async () => {
    const html = await draw('2026-11-14T10:00:00.000Z');
    expect(plain(html)).toContain('No customer has a payment pending for more than 60 days.');
    expect(html).not.toContain('data-testid="overdue-row"');
  });

  // Wave 2 fix 2 (M2): the card lists ten; the rest is "And N more", and where the whole list is depends on who is looking. The owner has it in Reports, Payments; the biller cannot open
  // Reports, so the biller is told to ask the owner.
  it('over ten customers, the owner is told where the whole list is: Reports, Payments', async () => {
    const html = await draw('2026-11-15T10:00:00.000Z', { role: 'owner', extra: 11 });
    expect(plain(/data-testid="overdue-count"[^>]*>([\s\S]*?)<\/span>/.exec(html)![1])).toBe(
      '12 customers'
    );
    expect(html.match(/data-testid="overdue-row"/g)).toHaveLength(10);
    expect(plain(/data-testid="overdue-more"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1])).toBe(
      'And 2 more. The owner has the whole list in Reports, Payments.'
    );
  });

  it('over ten customers, the biller, who cannot open Reports, is told to ask the owner', async () => {
    const html = await draw('2026-11-15T10:00:00.000Z', { role: 'biller', extra: 11 });
    expect(html.match(/data-testid="overdue-row"/g)).toHaveLength(10);
    const more = plain(/data-testid="overdue-more"[^>]*>([\s\S]*?)<\/p>/.exec(html)![1]);
    expect(more).toBe('And 2 more. Ask the owner for the full list.');
    expect(plain(html)).not.toContain('Reports');
  });

  it('up to ten customers there is no "And N more" line, for either of them', async () => {
    for (const role of ['owner', 'biller'] as const) {
      const html = await draw('2026-11-15T10:00:00.000Z', { role, extra: 9 });
      expect(html.match(/data-testid="overdue-row"/g)).toHaveLength(10);
      expect(html).not.toContain('data-testid="overdue-more"');
    }
  });

  it('is for the owner and the biller: the dashboard draws it for those two roles and not for the staff', () => {
    const page = readFileSync(path.resolve(__dirname, '../../src/app/page.tsx'), 'utf8');
    expect(page).toMatch(
      /\(role === 'owner' \|\| role === 'biller'\) && <DashboardOverduePanel \/>/
    );
  });
});

describe('FB-D3 the Payments report has the download', () => {
  it('a button "Download outstanding list (CSV)" that goes through downloadCsv and the outstanding rows', () => {
    const source = readFileSync(
      path.resolve(__dirname, '../../src/app/reports/components/ReportPayments.tsx'),
      'utf8'
    );
    expect(source).toContain('Download outstanding list (CSV)');
    expect(source).toMatch(
      /downloadCsv\(`Outstanding list \$\{businessDateOf\(Date\.now\(\)\)\}`, outstandingCsvRows\(owing\)\)/
    );
  });
});
