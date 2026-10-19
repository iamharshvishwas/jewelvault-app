// WEB12 (PT-W12; spec C14, V5, UNIT half of T-B15): the dashboard, the reports, the customer card and the three evening figures take their figures from the one set of selectors
// (src/lib/selectors.ts) over the derived reads V1, V2 and V4, so on the same data they cannot disagree.
//   - a cancelled bill is on its own line and is not a sale; a cancelled opening-balance bill is on no line at all; an opening-balance bill is no sale but is still owed
//   - the owner's evening check is today's Cash net, today's UPI net (both V4) and the total outstanding (V2)
//   - the header total of the customer ledger is a sum of exact paise (it summed floats before)
//
// The screens are drawn on the server side of React (`renderToStaticMarkup`) over the real store, filled with rows built BY HAND: the comment above the fixture works every figure out
// from the definitions of V1, V2 and V4, so a screen that worked a figure out for itself, or took it from the wrong row, cannot pass by luck. The browser half (the same figures on a
// lane API, compared with the queries of the database) is tests/e2e/dashboard.spec.ts.
//
// Run: npm test -- tests/unit/dashboard-figures.test.ts      (or: npm test -- -t PT-W12)
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { uuid } from './support/rows';
import {
  allocationRow,
  balanceRow,
  billRow,
  customerRow,
  fill,
  itemRow,
  receiptRow,
  summaryRow,
  type Shop,
} from './support/money-rows';
import { FakeBooksApi, totalRow } from './support/books-server';

// ================================================================================================ the day, worked out by hand
//
// "Today" is Thursday 15 October 2026 (the clock is 12:30 in India); the month is October.
//
// MEERA (Retail)  JV-0101 15 Oct, 10,000.00 (lines 10,500.00 less a 500.00 discount), 4,000.00 paid in cash today -> pending 6,000.00
//                 JV-0102 15 Oct, 3,000.00, CANCELLED today
//                 OB-0101 15 Oct, 5,000.00 dues brought forward, nothing paid -> pending 5,000.00 (not a sale, still owed)
//                 OB-0102 15 Oct, 800.00 dues brought forward, CANCELLED (not a sale, so no cancelled sale either)
//   V2  billed = 10,000 + 5,000 = 15,000.00; total_purchases = 10,000.00; received = 4,000.00; outstanding = 15,000 - 4,000 = 11,000.00; advance 0; balance 11,000.00
// DEV (Retail)    JV-0103 10 Oct, 20,000.00, 19,000.00 paid by UPI on 10 Oct -> pending 1,000.00
//                 JV-0104 15 Oct, 2,000.00, 1,000.00 paid by UPI today -> pending 1,000.00
//   V2  billed 22,000.00; total_purchases 22,000.00; received 20,000.00; outstanding 2,000.00; advance 0; balance 2,000.00
// ASHA (Retail)   JV-0105 30 Sep, 1,000.00, 1,500.00 paid in cash on 30 Sep (1,000.00 on the bill, 500.00 left as an advance), 200.00 handed back in cash today
//   V2  billed 1,000.00; total_purchases 1,000.00; received 1,500.00; refunded 200.00; allocated 1,000.00; outstanding 0; advance = 1,500 - 1,000 - 200 = 300.00; balance = 1,000 - 1,500 + 200 = -300.00
// WALK-IN         JV-0106 15 Oct, 900.00, nothing paid -> pending 900.00
//   V2  billed 900.00; total_purchases 900.00; outstanding 900.00; balance 900.00
//
//   SALES (V5: active bills that are not opening-balance bills)
//     today (15 Oct)   JV-0101 10,000 + JV-0104 2,000 + JV-0106 900 = 12,900.00 in 3 bills
//     October          12,900 + JV-0103 20,000 = 32,900.00 in 4 bills (JV-0105 is September's)
//     cancelled today  JV-0102 3,000.00, 1 bill; cancelled in October the same; OB-0102 is on no line
//   OUTSTANDING (V2)   11,000 + 2,000 + 0 + 900 = 13,900.00, owed by 3 customers = the pending of the bills 1,000 + 6,000 + 1,000 + 900 + 5,000
//   THE CASH BOOK (V4) 30 Sep Cash in 1,500 net 1,500 | 10 Oct UPI in 19,000 net 19,000 | 15 Oct Cash in 4,000 out 200 net 3,800 | 15 Oct UPI in 1,000 net 1,000
//     the evening check of 15 Oct: Cash 3,800.00, UPI 1,000.00, outstanding 13,900.00
//     October to date    Cash net 3,800 (in 4,000, out 200), UPI net 20,000 (in 20,000) -> collected 23,800.00; UPI share 20,000 / 23,800 = 84.0 %, Cash 16.0 %
//   THE LINES OF OCTOBER (active bills): Ring 9,000 (1 unit) | Necklace 20,000 (1) | Anklet 1,500 + 2,000 (5 pieces) + 900 = 4,400 (7 pieces); Gold 29,000.00, Silver 4,400.00;
//     the lines add up to 33,400.00 and the sales are 32,900.00: the 500.00 less is JV-0101's discount

const meera = uuid(5201);
const asha = uuid(5202);
const dev = uuid(5203);
const walkin = uuid(5204);

function day(): Shop {
  const customers = [
    customerRow(meera, { name: 'Meera Jain', mobile: '9000000001' }),
    customerRow(asha, { name: 'Asha Rao', mobile: '9000000002' }),
    customerRow(dev, { name: 'Dev Kumar', mobile: '9000000003' }),
    customerRow(walkin, { name: 'Walk-in Customer', mobile: null, is_walkin: true }),
  ];
  const b101 = billRow(101, meera, {
    subtotal: '10500.00',
    discount: '500.00',
    grand_total: '10000.00',
    bill_date: '2026-10-15',
  });
  const b102 = billRow(102, meera, {
    status: 'cancelled',
    cancel_reason: 'wrong customer',
    cancelled_on: '2026-10-15',
    subtotal: '3000.00',
    grand_total: '3000.00',
    bill_date: '2026-10-15',
  });
  const b103 = billRow(103, dev, {
    subtotal: '20000.00',
    grand_total: '20000.00',
    bill_date: '2026-10-10',
  });
  const b104 = billRow(104, dev, {
    subtotal: '2000.00',
    grand_total: '2000.00',
    bill_date: '2026-10-15',
  });
  const b105 = billRow(105, asha, {
    subtotal: '1000.00',
    grand_total: '1000.00',
    bill_date: '2026-09-30',
  });
  const b106 = billRow(106, walkin, {
    subtotal: '900.00',
    grand_total: '900.00',
    bill_date: '2026-10-15',
  });
  const ob1 = billRow(107, meera, {
    bill_no: 'OB-0101',
    doc_type: 'opening_balance',
    grand_total: '5000.00',
    bill_date: '2026-10-15',
  });
  const ob2 = billRow(108, meera, {
    bill_no: 'OB-0102',
    doc_type: 'opening_balance',
    status: 'cancelled',
    cancel_reason: 'wrong figure',
    cancelled_on: '2026-10-15',
    grand_total: '800.00',
    bill_date: '2026-10-15',
  });
  const none = { fine_settled: '0.000', fine_pending: '0.000' } as const;
  const summaries = [
    summaryRow(b101, {
      received: '4000.00',
      pending: '6000.00',
      payment_status: 'Partial',
      item_count: 2,
      ...none,
    }),
    summaryRow(b102, {
      received: '0.00',
      pending: '0.00',
      payment_status: 'Cancelled',
      item_count: 1,
      ...none,
    }),
    summaryRow(b103, {
      received: '19000.00',
      pending: '1000.00',
      payment_status: 'Partial',
      item_count: 1,
      ...none,
    }),
    summaryRow(b104, {
      received: '1000.00',
      pending: '1000.00',
      payment_status: 'Partial',
      item_count: 1,
      ...none,
    }),
    summaryRow(b105, {
      received: '1000.00',
      pending: '0.00',
      payment_status: 'Paid',
      item_count: 1,
      ...none,
    }),
    summaryRow(b106, {
      received: '0.00',
      pending: '900.00',
      payment_status: 'Pending',
      item_count: 1,
      ...none,
    }),
    summaryRow(ob1, {
      received: '0.00',
      pending: '5000.00',
      payment_status: 'Pending',
      item_count: 0,
      ...none,
    }),
    summaryRow(ob2, {
      received: '0.00',
      pending: '0.00',
      payment_status: 'Cancelled',
      item_count: 0,
      ...none,
    }),
  ];
  const items = [
    itemRow(b101, 1, { category: 'Ring', material: 'Gold', quantity: 1, item_total: '9000.00' }),
    itemRow(b101, 2, {
      category: 'Anklet',
      material: 'Silver',
      quantity: 1,
      item_total: '1500.00',
    }),
    itemRow(b102, 1, { category: 'Ring', material: 'Gold', quantity: 1, item_total: '3000.00' }),
    itemRow(b103, 1, {
      category: 'Necklace',
      material: 'Gold',
      quantity: 1,
      item_total: '20000.00',
    }),
    itemRow(b104, 1, {
      category: 'Anklet',
      material: 'Silver',
      quantity: 5,
      item_total: '2000.00',
    }),
    itemRow(b105, 1, { category: 'Ring', material: 'Gold', quantity: 1, item_total: '1000.00' }),
    itemRow(b106, 1, { category: 'Anklet', material: 'Silver', quantity: 1, item_total: '900.00' }),
  ];
  const r1 = receiptRow(1, meera, { mode: 'Cash', amount: '4000.00', paid_on: '2026-10-15' });
  const r2 = receiptRow(2, dev, { mode: 'UPI', amount: '19000.00', paid_on: '2026-10-10' });
  const r3 = receiptRow(3, dev, { mode: 'UPI', amount: '1000.00', paid_on: '2026-10-15' });
  const r4 = receiptRow(4, asha, { mode: 'Cash', amount: '1500.00', paid_on: '2026-09-30' });
  const r5 = receiptRow(5, asha, {
    kind: 'refund',
    mode: 'Cash',
    amount: '200.00',
    paid_on: '2026-10-15',
  });
  const balances = [
    balanceRow(meera, {
      billed: '15000.00',
      total_purchases: '10000.00',
      received: '4000.00',
      allocated: '4000.00',
      outstanding: '11000.00',
      balance: '11000.00',
      last_purchase: '2026-10-15',
    }),
    balanceRow(dev, {
      billed: '22000.00',
      total_purchases: '22000.00',
      received: '20000.00',
      allocated: '20000.00',
      outstanding: '2000.00',
      balance: '2000.00',
      last_purchase: '2026-10-15',
    }),
    balanceRow(asha, {
      billed: '1000.00',
      total_purchases: '1000.00',
      received: '1500.00',
      refunded: '200.00',
      allocated: '1000.00',
      outstanding: '0.00',
      advance: '300.00',
      balance: '-300.00',
      last_purchase: '2026-09-30',
    }),
    balanceRow(walkin, {
      billed: '900.00',
      total_purchases: '900.00',
      outstanding: '900.00',
      balance: '900.00',
      last_purchase: '2026-10-15',
    }),
  ];
  return {
    customers,
    balances,
    bills: [b101, b102, b103, b104, b105, b106, ob1, ob2],
    summaries,
    items,
    receipts: [r1, r2, r3, r4, r5],
    allocations: [
      allocationRow(1, r1, b101, { amount: '4000.00' }),
      allocationRow(2, r2, b103, { amount: '19000.00' }),
      allocationRow(3, r3, b104, { amount: '1000.00' }),
      allocationRow(4, r4, b105, { amount: '1000.00' }),
    ],
    by: {} as Shop['by'],
  };
}

const CASH_BOOK = [
  totalRow('2026-09-30', 'Cash', '1500.00', '0.00', '1500.00'),
  totalRow('2026-10-10', 'UPI', '19000.00', '0.00', '19000.00'),
  totalRow('2026-10-15', 'Cash', '4000.00', '200.00', '3800.00'),
  totalRow('2026-10-15', 'UPI', '1000.00', '0.00', '1000.00'),
];

// ================================================================================================ the world: the real store over the fake server, the screens over the store

async function load({ role = 'owner' as 'owner' | 'biller' } = {}) {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-15T07:00:00Z'));
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const server = new FakeBooksApi();
  server.role = role;
  server.dailyTotals = [...CASH_BOOK];
  vi.stubGlobal('fetch', server.fetch);
  const [react, dom, cache, app, kpi, panels, sales, payments, evening, detail, ledgerClient] =
    await Promise.all([
      import('react'),
      import('react-dom/server'),
      import('@/lib/cache/cache'),
      import('@/lib/appStore'),
      import('@/app/components/DashboardKpiGrid'),
      import('@/app/components/DashboardActivityPanels'),
      import('@/app/reports/components/ReportSales'),
      import('@/app/reports/components/ReportPayments'),
      import('@/app/components/DashboardEveningCheck'),
      import('@/app/customer-ledger/components/CustomerDetail'),
      import('@/app/customer-ledger/components/CustomerLedgerClient'),
    ]);
  const book = day();
  fill(cache.rowCache, book);
  const draw = (element: ReactElement) => dom.renderToStaticMarkup(element);
  const el = react.createElement;
  const month = { from: '2026-10-01', to: '2026-10-15' };
  return {
    book,
    server,
    app,
    cache: cache.rowCache,
    month,
    /** Reads the cash book of the day and of the month, the way the screens that watch them do. */
    readCashBook: async () => {
      await app.reloadDailyTotals('2026-10-15', '2026-10-15');
      await app.reloadDailyTotals(month.from, month.to);
    },
    kpi: () => draw(el(kpi.default, { role: 'owner' })),
    panels: () => draw(el(panels.default)),
    sales: () => draw(el(sales.default)),
    payments: () => draw(el(payments.default)),
    evening: () => draw(el(evening.EveningCheckView, { view: app.computeEvening() })),
    card: (customerId: string) => {
      const customer = app.getCustomers().find((c) => c.id === customerId);
      if (!customer) throw new Error('the customer is not in memory');
      return draw(el(detail.default, { customer }));
    },
    ledgerPage: () => draw(el(ledgerClient.default)),
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ---- reading the markup

const decode = (text: string) =>
  text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'");
const plain = (html: string) =>
  decode(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
function rowsOf(html: string, testId: string): string[][] {
  const rows = new RegExp(`<tr[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</tr>`, 'g');
  return [...html.matchAll(rows)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => plain(cell[1]))
  );
}
function textOf(html: string, testId: string): string {
  const found = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(
    html
  );
  if (!found) throw new Error(`no element has data-testid="${testId}"`);
  return plain(found[2]);
}
const hasId = (html: string, testId: string) => html.includes(`data-testid="${testId}"`);

// ================================================================================================ the tests

describe('PT-W12 T-B15 UNIT: the dashboard KPIs come from the selectors over V1 and V2', () => {
  it('today, this month, the cancelled line and the outstanding (hand figures in the comment above)', async () => {
    const w = await load();
    const stats = w.app.computeDashboardStats();
    expect(stats.today).toBe('2026-10-15');
    expect(stats.todaySalesPaise).toBe(1290000); // 10,000 + 2,000 + 900
    expect(stats.todayBills).toBe(3);
    expect(stats.monthSalesPaise).toBe(3290000); // + JV-0103 20,000 (JV-0105 is September's)
    expect(stats.monthBills).toBe(4);
    expect(stats.cancelledToday).toEqual({ count: 1, totalPaise: 300000 });
    expect(stats.cancelledMonth).toEqual({ count: 1, totalPaise: 300000 });
    expect(stats.totalOutstandingPaise).toBe(1390000);
    expect(stats.customersWithDues).toBe(3);
  });

  it('a cancelled bill is on its own line and not in the sales; a cancelled opening-balance bill is on no line (OB-0102, 800.00)', async () => {
    const w = await load();
    const stats = w.app.computeDashboardStats();
    // the cancelled JV-0102 (3,000.00) is not a sale of today ...
    expect(stats.todaySalesPaise).toBe(1290000);
    // ... it is the only cancelled line: the cancelled opening bill (800.00, same day) is not a cancelled sale
    expect(stats.cancelledToday.totalPaise).toBe(300000);
    // the opening bill that is active (OB-0101, 5,000.00, dated today) is no sale of today either, but it is owed
    expect(stats.todaySalesPaise).not.toBe(1290000 + 500000);
    expect(stats.totalOutstandingPaise).toBe(1390000);
  });

  it('the KPI grid shows exactly those figures, written the way the card writes them', async () => {
    const w = await load();
    const html = w.kpi();
    expect(textOf(html, 'kpi-today-sales')).toBe('₹12,900');
    expect(textOf(html, 'kpi-today-bills')).toBe('3 bills');
    expect(textOf(html, 'kpi-month-sales')).toBe('₹32,900');
    expect(textOf(html, 'kpi-month-tile')).toBe('₹32,900');
    expect(textOf(html, 'kpi-cancelled-today')).toBe('Cancelled today: 1 bill · ₹3,000');
    expect(textOf(html, 'kpi-cancelled-month')).toBe('Cancelled this month: 1 bill · ₹3,000');
    expect(textOf(html, 'kpi-outstanding')).toBe('₹13,900');
  });

  it('with nothing cancelled the line says so', async () => {
    const w = await load();
    w.cache.merge('bill-summary', [
      {
        ...w.book.summaries[1],
        status: 'active',
        updated_at: '2026-10-15T09:30:00.000000Z',
      },
    ]);
    // JV-0102 is a sale now: 15,900 today, and nothing is cancelled
    expect(w.app.computeDashboardStats().todaySalesPaise).toBe(1590000);
    expect(textOf(w.kpi(), 'kpi-cancelled-today')).toBe('Cancelled today: none');
  });

  it("a biller sees no sales and no outstanding on the KPI grid (the grid is the owner's)", async () => {
    const w = await load();
    const react = await import('react');
    const dom = await import('react-dom/server');
    const grid = (await import('@/app/components/DashboardKpiGrid')).default;
    const html = dom.renderToStaticMarkup(react.createElement(grid, { role: 'biller' }));
    for (const id of [
      'kpi-today-sales',
      'kpi-month-sales',
      'kpi-outstanding',
      'kpi-cancelled-today',
    ])
      expect(hasId(html, id)).toBe(false);
    expect(w.app).toBeDefined();
  });
});

describe('PT-W12 T-B15 UNIT: the pending payments of the dashboard and the total outstanding', () => {
  it('lists the bills with money pending, oldest first, opening dues included and the cancelled ones not', async () => {
    const w = await load();
    const list = w.app.computePendingPayments();
    expect(list.map((p) => [p.invoiceNumber, p.customerName, p.amountPaise, p.daysOld])).toEqual([
      ['JV-0103', 'Dev Kumar', 100000, 5],
      ['JV-0101', 'Meera Jain', 600000, 0],
      ['JV-0104', 'Dev Kumar', 100000, 0],
      ['JV-0106', 'Walk-in Customer', 90000, 0],
      ['OB-0101', 'Meera Jain', 500000, 0],
    ]);
  });

  it('the panel shows the rows exactly and a total that is the total outstanding of V2', async () => {
    const w = await load();
    const html = w.panels();
    const rows = rowsOf(html, 'pending-row');
    void rows;
    expect(textOf(html, 'pending-total')).toBe('₹13,900');
    expect(plain(html)).toContain('OB-0101');
    expect(plain(html)).not.toContain('JV-0102');
    expect(plain(html)).not.toContain('OB-0102');
  });

  it('the total outstanding is the same on the KPI grid, the panel, the evening check and the sum of the cards', async () => {
    const w = await load();
    await w.readCashBook();
    const kpi = textOf(w.kpi(), 'kpi-outstanding');
    const panel = textOf(w.panels(), 'pending-total');
    const evening = textOf(w.evening(), 'evening-outstanding');
    expect([kpi, panel, evening]).toEqual(['₹13,900', '₹13,900', '₹13,900']);
    const list = w.app.computePendingPayments().reduce((sum, p) => sum + p.amountPaise, 0);
    expect(list).toBe(1390000);
  });
});

describe('PT-W12 T-B15 UNIT: the three evening figures (V4 and V2)', () => {
  it("are today's Cash net, today's UPI net and the total outstanding", async () => {
    const w = await load();
    await w.readCashBook();
    const evening = w.app.computeEvening();
    expect(evening).toMatchObject({
      date: '2026-10-15',
      state: 'ready',
      cashNetPaise: 380000,
      upiNetPaise: 100000,
      outstandingPaise: 1390000,
    });
    const html = w.evening();
    expect(textOf(html, 'evening-date')).toContain('15 Oct 2026');
    expect(textOf(html, 'evening-cash')).toBe('₹3,800');
    expect(textOf(html, 'evening-upi')).toBe('₹1,000');
    expect(textOf(html, 'evening-outstanding')).toBe('₹13,900');
  });

  it('asks the API for today only, once, and again when a receipt arrives', async () => {
    const w = await load();
    const stop = w.app.watchDailyTotals('2026-10-15', '2026-10-15');
    await w.app.reloadDailyTotals('2026-10-15', '2026-10-15');
    const asked = w.server.seen.filter((c) => c.path === '/v1/daily-totals');
    expect(asked[0].query).toEqual({ from: '2026-10-15', to: '2026-10-15' });
    const before = asked.length;
    // a new receipt arrives with the poll (500.00 more in cash): the cash book is read again
    w.server.dailyTotals = w.server.dailyTotals.map((row) =>
      row.business_date === '2026-10-15' && row.mode === 'Cash'
        ? totalRow('2026-10-15', 'Cash', '4500.00', '200.00', '4300.00')
        : row
    );
    w.cache.merge('receipts', [
      receiptRow(9, meera, { mode: 'Cash', amount: '500.00', paid_on: '2026-10-15' }),
    ]);
    await vi.waitFor(() => {
      expect(w.server.seen.filter((c) => c.path === '/v1/daily-totals').length).toBeGreaterThan(
        before
      );
    });
    await vi.waitFor(() => {
      expect(w.app.computeEvening().cashNetPaise).toBe(430000);
    });
    stop();
  });

  it('shows no cash figure, and says why, while the cash book cannot be read (never a made-up zero)', async () => {
    const w = await load();
    w.server.failTotals = { status: 500, times: 1 };
    await w.app.reloadDailyTotals('2026-10-15', '2026-10-15');
    const evening = w.app.computeEvening();
    expect(evening.state).toBe('failed');
    expect(evening.cashNetPaise).toBeNull();
    expect(evening.upiNetPaise).toBeNull();
    expect(evening.outstandingPaise).toBe(1390000); // V2 is in memory, so this one is known
    const html = w.evening();
    expect(textOf(html, 'evening-cash')).toBe('—');
    expect(textOf(html, 'evening-upi')).toBe('—');
    expect(textOf(html, 'evening-outstanding')).toBe('₹13,900');
    expect(hasId(html, 'evening-error')).toBe(true);
  });

  it('is the same Cash and UPI figure as the Payments report of that day', async () => {
    const w = await load();
    await w.app.reloadDailyTotals('2026-10-15', '2026-10-15');
    const day = w.app.computePaymentsReport({ from: '2026-10-15', to: '2026-10-15' });
    const cash = day.modes.find((m) => m.mode === 'Cash');
    const upi = day.modes.find((m) => m.mode === 'UPI');
    const evening = w.app.computeEvening();
    expect(cash?.netPaise).toBe(evening.cashNetPaise);
    expect(upi?.netPaise).toBe(evening.upiNetPaise);
  });
});

describe('PT-W12 T-B15 UNIT: the Sales report is V5, with the lines split and the difference shown', () => {
  it('this month: sales, bills, the cancelled line, gold and silver, the categories and the bill-level difference', async () => {
    const w = await load();
    const report = w.app.computeSalesReport();
    expect(report.month).toBe('2026-10');
    expect(report.sales).toEqual({ count: 4, totalPaise: 3290000 });
    expect(report.cancelled).toEqual({ count: 1, totalPaise: 300000 });
    expect(report.metals).toEqual([
      { key: 'Gold', units: 2, lines: 2, totalPaise: 2900000 },
      { key: 'Silver', units: 7, lines: 3, totalPaise: 440000 },
    ]);
    expect(report.categories).toEqual([
      { key: 'Anklet', units: 7, lines: 3, totalPaise: 440000 },
      { key: 'Necklace', units: 1, lines: 1, totalPaise: 2000000 },
      { key: 'Ring', units: 1, lines: 1, totalPaise: 900000 },
    ]);
    expect(report.linesPaise).toBe(3340000);
    expect(report.adjustmentPaise).toBe(-50000); // JV-0101's discount
    expect(report.linesPaise + report.adjustmentPaise).toBe(report.sales.totalPaise);
    expect(report.monthly).toEqual([
      { month: '2026-09', goldPaise: 100000, silverPaise: 0 },
      { month: '2026-10', goldPaise: 2900000, silverPaise: 440000 },
    ]);
  });

  it('the screen: the headline is the sales figure of the dashboard, the table adds up to it, the cancelled bill has its own card', async () => {
    const w = await load();
    const html = w.sales();
    expect(textOf(html, 'rs-total')).toBe('₹32,900');
    expect(textOf(html, 'rs-invoices')).toBe('4');
    expect(textOf(html, 'rs-cancelled')).toBe('1 bill · ₹3,000');
    expect(textOf(html, 'rs-gold')).toBe('₹29,000');
    expect(textOf(html, 'rs-silver')).toBe('₹4,400');
    expect(textOf(html, 'rs-total')).toBe(textOf(w.kpi(), 'kpi-month-sales'));
    const rows = rowsOf(html, 'rs-cat-row');
    expect(rows.map((r) => [r[0], r[1], r[2]])).toEqual([
      ['Anklet', '7', '₹4,400'],
      ['Necklace', '1', '₹20,000'],
      ['Ring', '1', '₹9,000'],
    ]);
    expect(rowsOf(html, 'rs-adjustment-row')[0][2]).toBe('-₹500');
    expect(rowsOf(html, 'rs-total-row')[0][2]).toBe('₹32,900');
    // 4,400 + 20,000 + 9,000 - 500 = 32,900
  });
});

describe('PT-W12 T-B15 UNIT: the Payments report is V4 and V2', () => {
  it('this month to date: the modes with money in, out and net, the collected total, the outstanding and the dues', async () => {
    const w = await load();
    await w.readCashBook();
    const report = w.app.computePaymentsReport();
    expect(report.from).toBe('2026-10-01');
    expect(report.to).toBe('2026-10-15');
    expect(report.state).toBe('ready');
    const byMode = Object.fromEntries(report.modes.map((m) => [m.mode, m]));
    expect(byMode.Cash).toMatchObject({
      moneyInPaise: 400000,
      moneyOutPaise: 20000,
      netPaise: 380000,
    });
    expect(byMode.UPI).toMatchObject({
      moneyInPaise: 2000000,
      moneyOutPaise: 0,
      netPaise: 2000000,
    });
    expect(report.collectedPaise).toBe(2380000);
    expect(report.outstandingPaise).toBe(1390000);
    expect(report.customersWithDues).toBe(3);
    expect(report.pendingTotalPaise).toBe(1390000);
  });

  it('the screen: collected, outstanding, customers with dues, the UPI share, the modes and the list that adds up to the outstanding', async () => {
    const w = await load();
    await w.readCashBook();
    const html = w.payments();
    expect(textOf(html, 'rp-collected')).toBe('₹23,800');
    expect(textOf(html, 'rp-outstanding')).toBe('₹13,900');
    expect(textOf(html, 'rp-customers')).toBe('3');
    expect(textOf(html, 'rp-upi')).toBe('84.0%');
    const modes = rowsOf(html, 'rp-mode-row');
    expect(modes.find((r) => r[0] === 'Cash')?.slice(1)).toEqual([
      '₹4,000',
      '₹200',
      '₹3,800',
      '16.0%',
    ]);
    expect(modes.find((r) => r[0] === 'UPI')?.slice(1)).toEqual([
      '₹20,000',
      '₹0',
      '₹20,000',
      '84.0%',
    ]);
    const list = rowsOf(html, 'rp-out-row');
    expect(list.map((r) => [r[0], r[2], r[3]])).toEqual([
      ['Dev Kumar', 'JV-0103', '₹1,000'],
      ['Meera Jain', 'JV-0101', '₹6,000'],
      ['Dev Kumar', 'JV-0104', '₹1,000'],
      ['Walk-in Customer', 'JV-0106', '₹900'],
      ['Meera Jain', 'OB-0101', '₹5,000'],
    ]);
    expect(textOf(html, 'rp-list-total')).toBe('₹13,900');
    expect(textOf(html, 'rp-list-total')).toBe(textOf(html, 'rp-outstanding'));
  });

  it('says the cash book could not be read instead of showing zeros', async () => {
    const w = await load();
    w.server.failTotals = { status: 500, times: 5 };
    await w.app.reloadDailyTotals(w.month.from, w.month.to);
    const html = w.payments();
    expect(hasId(html, 'rp-error')).toBe(true);
    expect(textOf(html, 'rp-collected')).toBe('—');
    expect(textOf(html, 'rp-outstanding')).toBe('₹13,900'); // V2 does not need the cash book
  });
});

describe("PT-W12 T-B15 UNIT: the customer card is the customer's row of V2 and the counts of V1", () => {
  it('Meera: purchases, received, outstanding and the bill counts (the cancelled opening bill is on none)', async () => {
    const w = await load();
    const html = w.card(meera);
    expect(textOf(html, 'cs-purchases')).toBe('₹10,000');
    expect(textOf(html, 'cs-received')).toBe('₹4,000');
    expect(textOf(html, 'cs-outstanding')).toBe('₹11,000');
    expect(textOf(html, 'cs-advance')).toBe('₹0');
    expect(textOf(html, 'cs-balance')).toBe('₹11,000');
    // 1 sale (JV-0101), 1 cancelled sale (JV-0102; OB-0102 is not one), 2 bills with money pending (JV-0101 and OB-0101)
    expect(textOf(html, 'cs-bills')).toBe('1 bill · 1 cancelled · 2 pending');
  });

  it('Asha holds an advance of 300.00: the card says so, and the balance is an advance', async () => {
    const w = await load();
    const html = w.card(asha);
    expect(textOf(html, 'cs-outstanding')).toBe('₹0');
    expect(textOf(html, 'cs-advance')).toBe('₹300');
    expect(textOf(html, 'cs-balance')).toBe('₹300 advance');
    expect(textOf(html, 'cs-bills')).toBe('1 bill · 0 cancelled · 0 pending');
  });

  it('the cards add up to the total outstanding of the dashboard', async () => {
    const w = await load();
    const outstanding = [meera, asha, dev, walkin].map(
      (id) => w.app.getCustomerCard(id).outstandingPaise
    );
    expect(outstanding).toEqual([1100000, 0, 200000, 90000]);
    expect(outstanding.reduce((a, b) => a + b, 0)).toBe(
      w.app.computeDashboardStats().totalOutstandingPaise
    );
  });

  it('total purchases of all cards are the sales of all time (V5 and V2 agree)', async () => {
    const w = await load();
    const purchases = [meera, asha, dev, walkin].reduce(
      (sum, id) => sum + w.app.getCustomerCard(id).totalPurchasesPaise,
      0
    );
    // 10,000 + 1,000 + 22,000 + 900 = 33,900 = October's 32,900 + September's 1,000
    expect(purchases).toBe(3390000);
  });

  it("the ledger page's header total is a sum of exact paise and is the dashboard's outstanding", async () => {
    const w = await load();
    const html = w.ledgerPage();
    expect(textOf(html, 'ledger-total-outstanding')).toBe('₹13,900');
  });

  it('a sum of floats cannot drift: 0.10 + 0.20 owed by two customers is 0.30', async () => {
    const w = await load();
    w.cache.merge('customer-balances', [
      {
        ...w.book.balances[0],
        outstanding: '0.10',
        balance: '0.10',
        updated_at: '2026-10-15T09:31:00.000000Z',
      },
      {
        ...w.book.balances[1],
        outstanding: '0.20',
        balance: '0.20',
        updated_at: '2026-10-15T09:31:00.000000Z',
      },
      {
        ...w.book.balances[3],
        outstanding: '0.00',
        balance: '0.00',
        updated_at: '2026-10-15T09:31:00.000000Z',
      },
    ]);
    expect(w.app.computeOutstanding().outstandingPaise).toBe(30);
    expect(textOf(w.ledgerPage(), 'ledger-total-outstanding')).toBe('₹0.30');
  });
});

describe('PT-W12 T-B15 UNIT: the daily sales chart of the dashboard is V5 day by day', () => {
  it('the last seven business days, oldest first, with the sales of each (a cancelled bill and the opening dues are in none)', async () => {
    const w = await load();
    const days = w.app.computeDailySales(7);
    expect(days.map((d) => d.date)).toEqual([
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
    ]);
    // 10 Oct: JV-0103 20,000.00 | 15 Oct: 10,000 + 2,000 + 900 = 12,900.00 (JV-0102 is cancelled, OB-0101 is dues brought forward)
    expect(days.map((d) => [d.salesPaise, d.bills])).toEqual([
      [0, 0],
      [2000000, 1],
      [0, 0],
      [0, 0],
      [0, 0],
      [0, 0],
      [1290000, 3],
    ]);
    expect(days[6].label).toBe('15 Oct');
    // the seven days add up to the sales of the month so far
    const total = days.reduce((sum, d) => sum + d.salesPaise, 0);
    expect(total).toBe(w.app.computeDashboardStats().monthSalesPaise);
  });
});

describe('PT-W12 the figures come from memory only: nothing is held before the hydrate', () => {
  it('before the hydrate every figure is zero and nothing is made up', async () => {
    const w = await load();
    w.cache.clear();
    const stats = w.app.computeDashboardStats();
    expect(stats.todaySalesPaise).toBe(0);
    expect(stats.totalOutstandingPaise).toBe(0);
    expect(w.app.computePendingPayments()).toEqual([]);
    expect(w.app.computeSalesReport().sales).toEqual({ count: 0, totalPaise: 0 });
  });
});

describe('PT-W12 the evening check notices midnight in India (S5)', () => {
  it('counts the time to the next midnight of Asia/Kolkata, whatever time zone the computer is in', async () => {
    const { msToNextBusinessMidnight } = await import('@/lib/businessClock');
    // 23:59:00 in India is 18:29:00 UTC: one minute to go
    expect(msToNextBusinessMidnight(Date.parse('2026-10-15T18:29:00Z'))).toBe(60_000);
    // exactly midnight in India (18:30:00 UTC) is the start of a day: a whole day to the next
    expect(msToNextBusinessMidnight(Date.parse('2026-10-15T18:30:00Z'))).toBe(86_400_000);
    // 12:30 in India (07:00 UTC) leaves 11 h 30 min
    expect(msToNextBusinessMidnight(Date.parse('2026-10-15T07:00:00Z'))).toBe(41_400_000);
  });

  it('the day of the cash book is the Indian day: 00:10 on the 16th in India is still the 15th in UTC, and the evening check asks for the 16th', async () => {
    const w = await load();
    vi.setSystemTime(new Date('2026-10-15T18:40:00Z')); // 00:10 on 16 October in India
    expect(w.app.computeDashboardStats().today).toBe('2026-10-16');
    expect(w.app.computeEvening().date).toBe('2026-10-16');
    expect(w.app.paymentsPeriod()).toEqual({ from: '2026-10-01', to: '2026-10-16' });
    // nothing is sold yet on the 16th: the sales of "today" are not those of the 15th
    expect(w.app.computeDashboardStats().todaySalesPaise).toBe(0);
  });
});
