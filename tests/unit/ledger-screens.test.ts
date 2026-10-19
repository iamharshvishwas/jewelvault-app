// WEB10 (PT-W10): the estimate and the customer card read the money side from memory, read-only, and agree with the ledger (spec C1, C14, K1, Y8, V1 to V3; I4, I10).
//   - the ledger table lists one row per event of V3 (Invoice, Opening, Cancellation, Payment, Opening advance, Fine, Refund, Void) with the SERVER's running balance and silver balance on
//     the row, and its foot is the last row, which is the customer's balance of V2 (I4)
//   - the card shows V2: outstanding, advance, balance, silver fine due and silver fine balance; the invoice list shows V1 for every bill of the customer, the opening-balance bill and the
//     cancelled one included, so that the pending of the bills adds up to the outstanding of the card
//   - the saved estimate is read-only: no date editor and no edit mode (K1, Y8, C15), in the list and on the bill
//   - the three agree on the same data: the pending of the estimate, the card and the last balance of the ledger
//
// The screens are drawn on the server side of React (`renderToStaticMarkup`) over the real store, filled with rows built BY HAND (the comment above each customer works the figures out
// from the definitions of V1 to V3), so a screen that worked a figure out for itself, or took it from the wrong row, cannot pass by luck.
//
// Run: npm test -- tests/unit/ledger-screens.test.ts      (or: npm test -- -t PT-W10)
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import { at, uuid } from './support/rows';
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
import { FakeMoneyApi, ledgerRow, type LedgerWireRow } from './support/money-server';

// the estimate reads its bill from the address; the test says which
const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  usePathname: () => '/estimate',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

const SRC = path.resolve(__dirname, '../../src');

// ================================================================================================ the books, worked out by hand
//
// MEERA (Wholesale), dues. Bills: OB-0001 20,000.00 brought forward (1 Oct, nothing paid), JV-0012 3,000.00 with 6.000 g of silver due (5 Oct), JV-0013 1,000.00 (6 Oct, cancelled on 7 Oct).
// Receipts: R1 cash 1,000.00 on JV-0012; R2 silver 2.500 g on JV-0012; R3 UPI 800.00 on OB-0001 (7 Oct), VOIDED on 8 Oct.
//   V1  OB-0001  received 0.00    pending 20000.00  Pending          JV-0012  received 1000.00  pending 2000.00  fine settled 2.500  fine pending 3.500  Partial
//       JV-0013  Cancelled, 0.00 and 0.00 (the cancel released its money)
//   V2  billed = active bills = 20000.00 + 3000.00 = 23000.00; total_purchases = 3000.00 (the opening bill is not a sale); received = 1000.00 (R3 is void);
//       allocated = 1000.00; outstanding = 23000.00 - 1000.00 = 22000.00; advance = 0.00; balance = billed - received + refunded = 22000.00
//       fine: billed 6.000, received 2.500, allocated 2.500, outstanding 3.500, advance 0.000, balance 3.500
//   V3  8 events (below); the last balance is 22000.00 and the last silver balance 3.500, equal to V2 (I4)
//       the pending of the bills 20000.00 + 2000.00 + 0.00 = 22000.00 = V2 outstanding
//
// ASHA (Retail), an advance. Bill JV-0014 4,000.00 (4 Oct). Receipts: R4 opening advance 5,000.00 (2 Oct), R5 cash 2,000.00 (3 Oct), R6 REFUND cash 1,000.00 (5 Oct).
//   V1  JV-0014  received 4000.00 (from R4)  pending 0.00  Paid
//   V2  billed 4000.00; total_purchases 4000.00; received = 5000.00 + 2000.00 = 7000.00; refunded 1000.00; allocated 4000.00; outstanding 0.00;
//       advance = received - allocated - refunded = 2000.00; balance = billed - received + refunded = -2000.00 (= outstanding - advance)
//   V3  4 events (below); the last balance is -2000.00

const meera = uuid(5101);
const asha = uuid(5102);

interface Book extends Shop {
  /** The ledger of each customer: V3 rows in their order key. */
  ledgers: Map<string, LedgerWireRow[]>;
}

function books(): Book {
  const bOpening = billRow(11, meera, {
    bill_no: 'OB-0001',
    doc_type: 'opening_balance',
    sale_type: 'Wholesale',
    grand_total: '20000.00',
    bill_date: '2026-10-01',
  });
  const bSilver = billRow(12, meera, {
    bill_no: 'JV-0012',
    sale_type: 'Wholesale',
    subtotal: '3000.00',
    grand_total: '3000.00',
    fine_weight_due: '6.000',
    bill_date: '2026-10-05',
  });
  const bCancelled = billRow(13, meera, {
    bill_no: 'JV-0013',
    status: 'cancelled',
    cancel_reason: 'wrong customer',
    cancelled_at: at(60),
    cancelled_on: '2026-10-07',
    subtotal: '1000.00',
    grand_total: '1000.00',
    bill_date: '2026-10-06',
  });
  const bAsha = billRow(14, asha, {
    bill_no: 'JV-0014',
    subtotal: '4000.00',
    grand_total: '4000.00',
    bill_date: '2026-10-04',
  });

  const sOpening = summaryRow(bOpening, {
    received: '0.00',
    pending: '20000.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Pending',
    item_count: 0,
  });
  const sSilver = summaryRow(bSilver, {
    received: '1000.00',
    pending: '2000.00',
    fine_settled: '2.500',
    fine_pending: '3.500',
    payment_status: 'Partial',
    item_count: 1,
  });
  const sCancelled = summaryRow(bCancelled, {
    received: '0.00',
    pending: '0.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Cancelled',
    item_count: 1,
  });
  const sAsha = summaryRow(bAsha, {
    received: '4000.00',
    pending: '0.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Paid',
    item_count: 1,
  });

  const r1 = receiptRow(1, meera, {
    mode: 'Cash',
    amount: '1000.00',
    paid_on: '2026-10-05',
    reference: 'CASH-1',
  });
  const r2 = receiptRow(2, meera, {
    kind: 'fine_silver',
    mode: null,
    amount: '0.00',
    fine_grams: '2.500',
    paid_on: '2026-10-05',
  });
  const r3 = receiptRow(3, meera, {
    mode: 'UPI',
    amount: '800.00',
    paid_on: '2026-10-07',
    reference: 'UPI-9',
    status: 'voided',
    void_reason: 'keyed twice',
    voided_at: at(70),
    voided_on: '2026-10-08',
  });
  const r4 = receiptRow(4, asha, {
    mode: null,
    amount: '5000.00',
    paid_on: '2026-10-02',
    is_opening: true,
    reference: 'Opening advance',
  });
  const r5 = receiptRow(5, asha, { mode: 'Cash', amount: '2000.00', paid_on: '2026-10-03' });
  const r6 = receiptRow(6, asha, {
    kind: 'refund',
    mode: 'Cash',
    amount: '1000.00',
    paid_on: '2026-10-05',
  });

  const allocations = [
    allocationRow(1, r1, bSilver, { amount: '1000.00' }),
    allocationRow(2, r2, bSilver, { fine_grams: '2.500' }),
    allocationRow(3, r3, bOpening, { amount: '800.00' }), // the receipt is void: it does not count
    allocationRow(4, r4, bAsha, { amount: '4000.00' }),
  ];

  const balances = [
    balanceRow(meera, {
      billed: '23000.00',
      total_purchases: '3000.00',
      received: '1000.00',
      refunded: '0.00',
      allocated: '1000.00',
      outstanding: '22000.00',
      advance: '0.00',
      balance: '22000.00',
      fine_billed: '6.000',
      fine_received: '2.500',
      fine_allocated: '2.500',
      fine_outstanding: '3.500',
      fine_advance: '0.000',
      fine_balance: '3.500',
      last_purchase: '2026-10-05',
    }),
    balanceRow(asha, {
      billed: '4000.00',
      total_purchases: '4000.00',
      received: '7000.00',
      refunded: '1000.00',
      allocated: '4000.00',
      outstanding: '0.00',
      advance: '2000.00',
      balance: '-2000.00',
      last_purchase: '2026-10-04',
    }),
  ];

  const meeraRow = (n: number, over: Partial<LedgerWireRow>) =>
    ledgerRow(n, meera, { entry_at: at(200 + n), ...over });
  const ashaRow = (n: number, over: Partial<LedgerWireRow>) =>
    ledgerRow(n, asha, { entry_at: at(300 + n), ...over });
  const ledgers = new Map<string, LedgerWireRow[]>([
    [
      meera,
      [
        meeraRow(1, {
          id: bOpening.id,
          kind: 'Opening',
          kind_rank: 1,
          entry_date: '2026-10-01',
          description: 'Opening balance OB-0001',
          debit: '20000.00',
          balance: '20000.00',
        }),
        meeraRow(2, {
          id: bSilver.id,
          kind: 'Invoice',
          kind_rank: 1,
          entry_date: '2026-10-05',
          description: 'Invoice JV-0012',
          debit: '3000.00',
          fine_debit: '6.000',
          balance: '23000.00',
          fine_balance: '6.000',
        }),
        meeraRow(3, {
          id: r1.id,
          kind: 'Payment',
          kind_rank: 3,
          entry_date: '2026-10-05',
          description: 'Payment (Cash)',
          debit: '0.00',
          credit: '1000.00',
          balance: '22000.00',
          fine_balance: '6.000',
        }),
        meeraRow(4, {
          id: r2.id,
          kind: 'Fine',
          kind_rank: 3,
          entry_date: '2026-10-05',
          description: 'Silver received 2.500 g',
          debit: '0.00',
          fine_credit: '2.500',
          balance: '22000.00',
          fine_balance: '3.500',
        }),
        meeraRow(5, {
          id: bCancelled.id,
          kind: 'Invoice',
          kind_rank: 1,
          entry_date: '2026-10-06',
          description: 'Invoice JV-0013',
          debit: '1000.00',
          balance: '23000.00',
          fine_balance: '3.500',
        }),
        meeraRow(6, {
          id: bCancelled.id,
          kind: 'Cancellation',
          kind_rank: 2,
          entry_date: '2026-10-07',
          description: 'Cancelled JV-0013',
          debit: '0.00',
          credit: '1000.00',
          balance: '22000.00',
          fine_balance: '3.500',
        }),
        meeraRow(7, {
          id: r3.id,
          kind: 'Payment',
          kind_rank: 3,
          entry_date: '2026-10-07',
          description: 'Payment (UPI)',
          debit: '0.00',
          credit: '800.00',
          balance: '21200.00',
          fine_balance: '3.500',
        }),
        meeraRow(8, {
          id: r3.id,
          kind: 'Void',
          kind_rank: 5,
          entry_date: '2026-10-08',
          description: 'Void of payment',
          debit: '800.00',
          credit: '0.00',
          balance: '22000.00',
          fine_balance: '3.500',
        }),
      ],
    ],
    [
      asha,
      [
        ashaRow(1, {
          id: r4.id,
          kind: 'Opening advance',
          kind_rank: 3,
          entry_date: '2026-10-02',
          description: 'Opening advance (Other)',
          debit: '0.00',
          credit: '5000.00',
          balance: '-5000.00',
        }),
        ashaRow(2, {
          id: r5.id,
          kind: 'Payment',
          kind_rank: 3,
          entry_date: '2026-10-03',
          description: 'Payment (Cash)',
          debit: '0.00',
          credit: '2000.00',
          balance: '-7000.00',
        }),
        ashaRow(3, {
          id: bAsha.id,
          kind: 'Invoice',
          kind_rank: 1,
          entry_date: '2026-10-04',
          description: 'Invoice JV-0014',
          debit: '4000.00',
          balance: '-3000.00',
        }),
        ashaRow(4, {
          id: r6.id,
          kind: 'Refund',
          kind_rank: 4,
          entry_date: '2026-10-05',
          description: 'Refund (Cash)',
          debit: '1000.00',
          credit: '0.00',
          balance: '-2000.00',
        }),
      ],
    ],
  ]);

  return {
    customers: [
      customerRow(meera, { name: 'Meera Jain', customer_type: 'Wholesale', mobile: '9000100001' }),
      customerRow(asha, { name: 'Asha Rao', mobile: '9000100002' }),
    ],
    balances,
    bills: [bOpening, bSilver, bCancelled, bAsha],
    summaries: [sOpening, sSilver, sCancelled, sAsha],
    items: [
      itemRow(bSilver, 1, {
        material: 'Silver',
        purity: '925',
        design_no: 'ANK-00007',
        sku_no: 'ANK-00007-002',
        category: 'Anklet',
        customer_net_weight: '120.000',
        gross_weight: '124.500',
        metal_rate: '25.00',
        labour_rate: '0.00',
        labour_amount: '0.00',
        metal_amount: '3000.00',
        item_total: '3000.00',
        fine_weight_due: '6.000',
      }),
      itemRow(bCancelled, 1, { item_total: '1000.00', metal_amount: '1000.00' }),
      itemRow(bAsha, 1, { item_total: '4000.00', metal_amount: '4000.00' }),
    ],
    receipts: [r1, r2, r3, r4, r5, r6],
    allocations,
    by: {} as Shop['by'],
    ledgers,
  };
}

// ================================================================================================ the world: the real store over the fake server, the screens over the store

async function load() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const server = new FakeMoneyApi();
  vi.stubGlobal('fetch', server.fetch);
  const [react, dom, cache, app, table, invoiceList, detail, estimate] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
    import('@/app/customer-ledger/components/CustomerLedgerTable'),
    import('@/app/customer-ledger/components/CustomerInvoiceList'),
    import('@/app/customer-ledger/components/CustomerDetail'),
    import('@/app/estimate/components/EstimateViewClient'),
  ]);
  const book = books();
  fill(cache.rowCache, book);
  for (const [customerId, rows] of book.ledgers) server.ledgers.set(customerId, rows);
  const draw = (element: ReactElement) => dom.renderToStaticMarkup(element);
  const el = react.createElement;
  /** The ledger of a customer as the card holds it once loaded. */
  const ledgerOf = async (customerId: string) => {
    await app.loadLedgerForCustomer(customerId);
    return app.getLedgerForCustomer(customerId);
  };
  return {
    book,
    server,
    app,
    cache: cache.rowCache,
    ledgerOf,
    ledgerTable: async (customerId: string) =>
      draw(el(table.default, { entries: await ledgerOf(customerId) })),
    invoiceList: (customerId: string) =>
      draw(el(invoiceList.default, { invoices: app.getBillsOfCustomer(customerId).reverse() })),
    card: async (customerId: string) => {
      await app.loadLedgerForCustomer(customerId);
      const customer = app.getCustomers().find((c) => c.id === customerId);
      if (!customer) throw new Error('the customer is not in memory');
      return draw(el(detail.default, { customer }));
    },
    estimate: (billId: string | null) => {
      address.search = billId ? `id=${billId}` : '';
      return draw(el(estimate.default, {}));
    },
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  address.search = '';
});

// ================================================================================================ reading the markup

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

/** The cells of every `<tr data-testid=...>` of the markup, as plain text. */
function rowsOf(html: string, testId: string): string[][] {
  const rows = new RegExp(`<tr[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</tr>`, 'g');
  return [...html.matchAll(rows)].map((row) =>
    [...row[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)].map((cell) => plain(cell[1]))
  );
}

/** The text of the first element with this `data-testid`. */
function textOf(html: string, testId: string): string {
  const found = new RegExp(`<(\\w+)[^>]*data-testid="${testId}"[^>]*>([\\s\\S]*?)</\\1>`).exec(
    html
  );
  if (!found) throw new Error(`no element has data-testid="${testId}"`);
  return plain(found[2]);
}

/** Rupees in whole paise from the text a screen shows: '₹22,000', '₹1,000.50', '-₹500', '₹2,000 advance' (the word "advance" makes it negative). */
function paiseOfShown(text: string): number {
  const match = /^(-?)₹([\d,]+)(?:\.(\d{2}))?( advance)?$/.exec(text.trim());
  if (!match) throw new Error(`not an amount: "${text}"`);
  const paise = Number(match[2].replace(/,/g, '')) * 100 + Number(match[3] ?? 0);
  return match[1] === '-' || match[4] ? -paise : paise;
}
const paiseOfText = (text: string) => Math.round(Number(text) * 100);
const dateShown = (day: string) => new Date(`${day}T12:00:00.000Z`).toLocaleDateString('en-IN');

// ================================================================================================ how a figure is written

describe('PT-W10 one way to write a figure on all three screens (C14)', () => {
  it('rupees: the Indian grouping, paise only when there are some, the minus in front', async () => {
    const view = await import('@/lib/ledgerView');
    expect(view.rupeesShown(0)).toBe('₹0');
    expect(view.rupeesShown(1700)).toBe('₹1,700');
    expect(view.rupeesShown(257612)).toBe('₹2,57,612');
    expect(view.rupeesShown(1000.5)).toBe('₹1,000.50');
    expect(view.rupeesShown(0.3)).toBe('₹0.30');
    expect(view.rupeesShown(0.1 + 0.2)).toBe('₹0.30'); // a float that is not quite 0.3 is still 30 paise
    expect(view.rupeesShown(-40)).toBe('-₹40');
    expect(view.rupeesShown(-0.5)).toBe('-₹0.50');
  });

  it('a balance below zero is an advance, in words; zero and above is what is owed', async () => {
    const view = await import('@/lib/ledgerView');
    expect(view.balanceShown(2000)).toBe('₹2,000');
    expect(view.balanceShown(0)).toBe('₹0');
    expect(view.balanceShown(-500)).toBe('₹500 advance');
    expect(view.balanceShown(-0.5)).toBe('₹0.50 advance');
    expect(view.fineBalanceShown(3.5)).toBe('3.500 g');
    expect(view.fineBalanceShown(0)).toBe('0.000 g');
    expect(view.fineBalanceShown(-1)).toBe('1.000 g advance');
    expect(view.gramsShown(15)).toBe('15.000 g');
  });

  it('totals are added in paise and milligrams: 0.1 + 0.2 is 0.3 and 1.005 + 1.005 is 2.01 g', async () => {
    const view = await import('@/lib/ledgerView');
    expect(view.sumRupees([0.1, 0.2])).toBe(0.3);
    expect(view.sumRupees([20000, 3000, 1000, 800])).toBe(24800);
    expect(view.sumGrams([1.005, 1.005])).toBe(2.01);
    expect(view.sumGrams([])).toBe(0);
  });

  it('every kind of V3 has its words; an entry with no kind keeps the prototype type; the payments tab keeps money and silver received', async () => {
    const view = await import('@/lib/ledgerView');
    const label = (kind: string) =>
      view.ledgerKindLabel({ kind: kind as never, type: 'Adjustment' });
    expect(
      [
        'Invoice',
        'Opening',
        'Cancellation',
        'Payment',
        'Opening advance',
        'Fine',
        'Refund',
        'Void',
      ].map(label)
    ).toEqual([
      'Invoice',
      'Opening balance',
      'Cancellation',
      'Payment',
      'Opening advance',
      'Fine',
      'Refund',
      'Void',
    ]);
    expect(view.ledgerKindLabel({ type: 'Return' })).toBe('Return');
    const isPayment = (kind: string) =>
      view.isPaymentEntry({ kind: kind as never, type: 'Adjustment' });
    expect(
      [
        'Invoice',
        'Opening',
        'Cancellation',
        'Payment',
        'Opening advance',
        'Fine',
        'Refund',
        'Void',
      ].filter(isPayment)
    ).toEqual(['Payment', 'Opening advance', 'Fine']);
    expect(view.isPaymentEntry({ type: 'Payment' })).toBe(true);
    expect(view.isPaymentEntry({ type: 'Invoice' })).toBe(false);
  });
});

// ================================================================================================ the ledger table

describe('PT-W10 the ledger table: one row per event of V3, with the running balances of the server', () => {
  it('lists the eight events of Meera in the order of V3, each named in plain words', async () => {
    const w = await load();
    const html = await w.ledgerTable(meera);
    const rows = rowsOf(html, 'ledger-row');
    expect(rows.map((r) => r[1])).toEqual([
      'Opening balance',
      'Invoice',
      'Payment',
      'Fine',
      'Invoice',
      'Cancellation',
      'Payment',
      'Void',
    ]);
    expect(rows.map((r) => r[2])).toEqual([
      'Opening balance OB-0001',
      'Invoice JV-0012',
      'Payment (Cash)',
      'Silver received 2.500 g',
      'Invoice JV-0013',
      'Cancelled JV-0013',
      'Payment (UPI)',
      'Void of payment',
    ]);
    expect(rows[0][0]).toBe(dateShown('2026-10-01'));
    expect(rows[5][0]).toBe(dateShown('2026-10-07')); // a cancellation is dated the day it was cancelled
    expect(rows[7][0]).toBe(dateShown('2026-10-08')); // and a void the day of the void
  });

  it('names the bill or the receipt on each row (the reference), and leaves it empty where there is none', async () => {
    const w = await load();
    const rows = rowsOf(await w.ledgerTable(meera), 'ledger-row');
    expect(rows.map((r) => r[3])).toEqual([
      'OB-0001',
      'JV-0012',
      'CASH-1',
      '', // a silver receipt with no reference
      'JV-0013',
      'JV-0013',
      'UPI-9',
      'UPI-9',
    ]);
  });

  it('shows on EVERY row the debit, credit, balance and silver columns of that row of V3 (a balance taken from the row above would fail here)', async () => {
    const w = await load();
    const rows = rowsOf(await w.ledgerTable(meera), 'ledger-row');
    // [debit, credit, balance, fine in, fine out, fine balance], worked out by hand in the comment at the top
    expect(rows.map((r) => r.slice(4))).toEqual([
      ['₹20,000', '—', '₹20,000', '-', '-', '0.000 g'],
      ['₹3,000', '—', '₹23,000', '6.000 g', '-', '6.000 g'],
      ['—', '₹1,000', '₹22,000', '-', '-', '6.000 g'],
      ['—', '—', '₹22,000', '-', '2.500 g', '3.500 g'],
      ['₹1,000', '—', '₹23,000', '-', '-', '3.500 g'],
      ['—', '₹1,000', '₹22,000', '-', '-', '3.500 g'],
      ['—', '₹800', '₹21,200', '-', '-', '3.500 g'],
      ['₹800', '—', '₹22,000', '-', '-', '3.500 g'],
    ]);
    // and against the rows the server sent, one by one
    const sent = w.book.ledgers.get(meera) ?? [];
    rows.forEach((row, i) => {
      expect(paiseOfShown(row[6]), `balance of row ${i + 1}`).toBe(paiseOfText(sent[i].balance));
      expect(row[9], `silver balance of row ${i + 1}`).toBe(`${sent[i].fine_balance} g`);
    });
  });

  it('the foot is the last row: the closing balance and silver balance, and exact totals of the debit and credit columns', async () => {
    const w = await load();
    const html = await w.ledgerTable(meera);
    const [foot] = rowsOf(html, 'ledger-total');
    // 20000 + 3000 + 1000 + 800 debited, 1000 + 1000 + 800 credited
    expect(foot).toEqual([
      'Current Balance',
      '₹24,800',
      '₹2,800',
      '₹22,000',
      '6.000 g',
      '2.500 g',
      '3.500 g',
    ]);
    const rows = rowsOf(html, 'ledger-row');
    expect(foot[3]).toBe(rows[rows.length - 1][6]);
    expect(foot[6]).toBe(rows[rows.length - 1][9]);
  });

  it("an advance is a negative balance and reads as one: '₹5,000 advance', down to the closing '₹2,000 advance'", async () => {
    const w = await load();
    const html = await w.ledgerTable(asha);
    const rows = rowsOf(html, 'ledger-row');
    expect(rows.map((r) => r[1])).toEqual(['Opening advance', 'Payment', 'Invoice', 'Refund']);
    expect(rows.map((r) => r[6])).toEqual([
      '₹5,000 advance',
      '₹7,000 advance',
      '₹3,000 advance',
      '₹2,000 advance',
    ]);
    // the refund is money out, a debit
    expect(rows[3].slice(4, 6)).toEqual(['₹1,000', '—']);
    expect(rowsOf(html, 'ledger-total')[0][3]).toBe('₹2,000 advance');
  });

  it('paise are shown, whole rupees are not padded: ₹1,000.50 and ₹1,000', async () => {
    const w = await load();
    const sent = w.book.ledgers.get(meera) ?? [];
    sent[1] = { ...sent[1], debit: '3000.50', balance: '23000.50' };
    const rows = rowsOf(await w.ledgerTable(meera), 'ledger-row');
    expect(rows[1][4]).toBe('₹3,000.50');
    expect(rows[1][6]).toBe('₹23,000.50');
    expect(rows[2][5]).toBe('₹1,000');
  });

  it('an empty ledger says so', async () => {
    const w = await load();
    expect(plain(await w.ledgerTable(uuid(5199)))).toContain('No ledger entries yet');
  });

  it('an entry with no kind still shows the prototype type', async () => {
    const w = await load();
    const html = (await import('react-dom/server')).renderToStaticMarkup(
      (await import('react')).createElement(
        (await import('@/app/customer-ledger/components/CustomerLedgerTable')).default,
        {
          entries: [
            {
              id: 'x',
              customerId: meera,
              date: '2026-10-01T12:00:00.000Z',
              type: 'Return',
              description: 'Returned ring',
              debit: 0,
              credit: 500,
              balance: 0,
              reference: 'R-1',
            },
          ],
        }
      )
    );
    expect(rowsOf(html, 'ledger-row')[0][1]).toBe('Return');
    expect(w.app).toBeDefined();
  });
});

// ================================================================================================ the invoice list

describe('PT-W10 the invoice list: every bill of the customer with the figures of V1', () => {
  it('lists the opening-balance bill and the cancelled one too, newest first, with received, pending and status of V1', async () => {
    const w = await load();
    const rows = rowsOf(w.invoiceList(meera), 'invoice-row');
    // Invoice No., Date, Items, Grand Total, Received, Pending, Status, (View)
    expect(rows.map((r) => r[0])).toEqual(['JV-0013', 'JV-0012', 'OB-0001']);
    const by = Object.fromEntries(rows.map((r) => [r[0], r]));
    expect(by['JV-0012'].slice(3, 7)).toEqual([
      '₹3,000',
      '₹1,000',
      '₹2,000 3.500 g fine',
      'Partial',
    ]);
    expect(by['OB-0001'].slice(3, 7)).toEqual(['₹20,000', '₹0', '₹20,000', 'Pending']);
    expect(by['JV-0013'].slice(3, 7)).toEqual(['₹1,000', '₹0', 'Nil', 'Cancelled']);
  });

  it('marks the opening balance as dues brought forward, not as an invoice of items', async () => {
    const w = await load();
    const rows = rowsOf(w.invoiceList(meera), 'invoice-row');
    const opening = rows.find((r) => r[0] === 'OB-0001');
    expect(opening?.[2]).toBe('Opening balance');
    expect(rows.find((r) => r[0] === 'JV-0012')?.[2]).toBe('1 item');
  });

  it('the pending of the bills adds up to the outstanding of V2 (22,000.00 = 20,000.00 + 2,000.00 + 0.00)', async () => {
    const w = await load();
    const rows = rowsOf(w.invoiceList(meera), 'invoice-row');
    const pending = rows
      .map((r) => r[5])
      .map((text) => (text === 'Nil' ? 0 : paiseOfShown(text.replace(/ [\d.]+ g fine$/, ''))))
      .reduce((a, b) => a + b, 0);
    const v2 = w.book.balances.find((b) => b.id === meera);
    expect(pending).toBe(paiseOfText(v2?.outstanding ?? ''));
  });

  it("each bill links to its estimate by the bill's id", async () => {
    const w = await load();
    const html = w.invoiceList(meera);
    for (const bill of w.book.bills.filter((b) => b.customer_id === meera))
      expect(html).toContain(`href="/estimate?id=${bill.id}"`);
  });
});

// ================================================================================================ the customer card

describe('PT-W10 the customer card shows the figures of V2', () => {
  it('Meera owes: outstanding, advance, balance and silver, exactly as V2 holds them', async () => {
    const w = await load();
    const html = await w.card(meera);
    expect(textOf(html, 'cs-purchases')).toBe('₹3,000');
    expect(textOf(html, 'cs-received')).toBe('₹1,000');
    expect(textOf(html, 'cs-outstanding')).toBe('₹22,000');
    expect(textOf(html, 'cs-advance')).toBe('₹0');
    expect(textOf(html, 'cs-balance')).toBe('₹22,000');
    expect(textOf(html, 'cs-fine')).toBe('3.500 g');
    expect(textOf(html, 'cs-fine-balance')).toBe('3.500 g');
    expect(textOf(html, 'cs-last')).toBe(dateShown('2026-10-05'));
  });

  it('Asha holds an advance: no outstanding, an advance of 2,000 and a balance of 2,000 advance', async () => {
    const w = await load();
    const html = await w.card(asha);
    expect(textOf(html, 'cs-outstanding')).toBe('₹0');
    expect(textOf(html, 'cs-advance')).toBe('₹2,000');
    expect(textOf(html, 'cs-balance')).toBe('₹2,000 advance');
    expect(textOf(html, 'cs-fine')).toBe('0.000 g');
    expect(textOf(html, 'cs-fine-balance')).toBe('0.000 g');
  });

  it("the last running balance of the ledger on the card IS the card's balance (I4), for the debtor and for the holder of an advance", async () => {
    const w = await load();
    for (const customerId of [meera, asha]) {
      const html = await w.card(customerId);
      const [foot] = rowsOf(html, 'ledger-total');
      expect(foot[3], customerId).toBe(textOf(html, 'cs-balance'));
      expect(foot[6], customerId).toBe(textOf(html, 'cs-fine-balance'));
      const v2 = w.book.balances.find((b) => b.id === customerId);
      expect(paiseOfShown(textOf(html, 'cs-balance'))).toBe(paiseOfText(v2?.balance ?? ''));
      // always balance = outstanding - advance (V2)
      expect(
        paiseOfShown(textOf(html, 'cs-outstanding')) - paiseOfShown(textOf(html, 'cs-advance'))
      ).toBe(paiseOfShown(textOf(html, 'cs-balance')));
    }
  });

  it('the ledger tab counts its events', async () => {
    const w = await load();
    expect(plain(await w.card(meera))).toMatch(/Ledger\s*8\b/);
    expect(plain(await w.card(asha))).toMatch(/Ledger\s*4\b/);
  });

  it('the card offers no delete of a customer or of a payment (they cannot be saved: a payment is voided, WEB11)', async () => {
    const w = await load();
    const html = await w.card(meera);
    expect(plain(html)).not.toContain('Delete Customer');
    expect(plain(html)).not.toMatch(/\bDelete\b/);
  });
});

// ================================================================================================ the estimate

describe('PT-W10 the saved estimate is read-only and shows the figures of V1', () => {
  it('a bill with money and silver pending: status, received, pending and the silver, as V1 has them', async () => {
    const w = await load();
    const html = w.estimate(w.book.bills[1].id);
    expect(textOf(html, 'estimate-number')).toBe('JV-0012');
    expect(textOf(html, 'estimate-status')).toBe('Partial');
    expect(textOf(html, 'estimate-grand-total')).toBe('₹3,000');
    expect(textOf(html, 'estimate-received')).toBe('₹1,000');
    expect(textOf(html, 'estimate-pending')).toBe('₹2,000');
    expect(textOf(html, 'estimate-fine-due')).toBe('6.000 g');
    expect(textOf(html, 'estimate-fine-pending')).toBe('3.500 g');
    expect(html).toContain('ANK-00007'); // the line is on the paper
  });

  it("shows the bill's date as plain text, not as a field", async () => {
    const w = await load();
    const html = w.estimate(w.book.bills[1].id);
    expect(plain(html)).toContain(dateShown('2026-10-05'));
    expect(html).not.toMatch(/type="date"/);
  });

  it('has no edit mode: no Edit Estimate, Save Changes or Cancel button and no input or text area on the bill', async () => {
    const w = await load();
    const html = w.estimate(w.book.bills[1].id);
    expect(plain(html)).not.toMatch(/Edit Estimate|Save Changes/);
    expect(html).not.toMatch(/<(input|textarea|select)\b/);
    // what is left to press: back to the list, and print
    const buttons = [...html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g)].map((b) =>
      plain(b[1])
    );
    expect(buttons).toEqual(['Print / Save PDF']);
  });

  it('the list of saved estimates has no date field either (only the search box), and lists the sales, not the opening balance', async () => {
    const w = await load();
    const html = w.estimate(null);
    expect(html).not.toMatch(/type="date"/);
    expect([...html.matchAll(/<input[^>]*>/g)]).toHaveLength(1); // the search box
    const numbers = rowsOf(html, 'estimate-row').map((r) => r[0]);
    expect(numbers.sort()).toEqual(['JV-0012', 'JV-0013', 'JV-0014']);
    const dates = rowsOf(html, 'estimate-row').map((r) => r[1]);
    expect(dates).toContain(dateShown('2026-10-05'));
  });

  it('a cancelled bill says Cancelled and owes nothing (V1 released its money)', async () => {
    const w = await load();
    const html = w.estimate(w.book.bills[2].id);
    expect(textOf(html, 'estimate-status')).toBe('Cancelled');
    expect(textOf(html, 'estimate-pending')).toBe('₹0');
    expect(textOf(html, 'estimate-received')).toBe('₹0');
  });

  it('the dues brought forward open as an opening balance, with no lines', async () => {
    const w = await load();
    const html = w.estimate(w.book.bills[0].id);
    expect(textOf(html, 'estimate-number')).toBe('OB-0001');
    expect(textOf(html, 'estimate-pending')).toBe('₹20,000');
    expect(plain(html)).toContain('Opening balance');
  });

  it('a bill that is not in memory says so and links back to the list', async () => {
    const w = await load();
    const html = w.estimate(uuid(404));
    expect(plain(html)).toContain('No Estimate Found');
    expect(html).toContain('href="/estimate"');
  });
});

// ================================================================================================ the three agree

describe('PT-W10 the card, the estimate and the ledger agree on the same data', () => {
  it('Meera: the pending of her estimates, the outstanding on her card and the last balance of her ledger are one figure', async () => {
    const w = await load();
    const card = await w.card(meera);
    const pendingOfBills = w.book.bills
      .filter((b) => b.customer_id === meera)
      .map((b) => paiseOfShown(textOf(w.estimate(b.id), 'estimate-pending')))
      .reduce((a, b) => a + b, 0);
    expect(pendingOfBills).toBe(paiseOfShown(textOf(card, 'cs-outstanding')));
    expect(pendingOfBills).toBe(paiseOfShown(rowsOf(card, 'ledger-total')[0][3]));
    // the silver: pending on the estimates = the card = the ledger's last silver balance
    const finePending = w.book.bills
      .filter((b) => b.customer_id === meera)
      .map((b) => w.estimate(b.id))
      .map((html) =>
        html.includes('data-testid="estimate-fine-pending"')
          ? textOf(html, 'estimate-fine-pending')
          : '0.000 g'
      )
      .map((text) => Math.round(Number(text.replace(' g', '')) * 1000))
      .reduce((a, b) => a + b, 0);
    expect(finePending).toBe(3500);
    expect(`${(finePending / 1000).toFixed(3)} g`).toBe(textOf(card, 'cs-fine'));
    expect(textOf(card, 'cs-fine')).toBe(rowsOf(card, 'ledger-total')[0][6]);
  });

  it('Asha: the bill is paid, the card holds the advance, the ledger ends on the same advance', async () => {
    const w = await load();
    const card = await w.card(asha);
    const estimate = w.estimate(w.book.bills[3].id);
    expect(textOf(estimate, 'estimate-status')).toBe('Paid');
    expect(textOf(estimate, 'estimate-pending')).toBe('₹0');
    expect(textOf(card, 'cs-advance')).toBe('₹2,000');
    expect(rowsOf(card, 'ledger-total')[0][3]).toBe('₹2,000 advance');
  });

  it('a payment that arrives (the poll puts the new receipt, its allocation, V1 and V2 in memory and the ledger is read again) moves all three at once', async () => {
    const w = await load();
    // 2,000.00 more on JV-0012, paid in cash on 9 Oct: JV-0012 pending 0.00, outstanding 20,000.00, balance 20,000.00
    const r7 = receiptRow(7, meera, { mode: 'Cash', amount: '2000.00', paid_on: '2026-10-09' });
    w.cache.merge('receipts', [r7]);
    w.cache.merge('receipt-allocations', [
      allocationRow(7, r7, w.book.bills[1], { amount: '2000.00' }),
    ]);
    w.cache.merge('bill-summary', [
      {
        ...w.book.summaries[1],
        received: '3000.00',
        pending: '0.00',
        payment_status: 'Partial',
        updated_at: at(400),
      },
    ]);
    w.cache.merge('customer-balances', [
      {
        ...w.book.balances[0],
        received: '3000.00',
        allocated: '3000.00',
        outstanding: '20000.00',
        balance: '20000.00',
        updated_at: at(400),
      },
    ]);
    w.server.ledgers.set(meera, [
      ...(w.book.ledgers.get(meera) ?? []),
      ledgerRow(9, meera, {
        entry_at: at(409),
        id: r7.id,
        kind: 'Payment',
        kind_rank: 3,
        entry_date: '2026-10-09',
        description: 'Payment (Cash)',
        debit: '0.00',
        credit: '2000.00',
        balance: '20000.00',
        fine_balance: '3.500',
      }),
    ]);
    const card = await w.card(meera);
    const estimate = w.estimate(w.book.bills[1].id);
    expect(textOf(estimate, 'estimate-pending')).toBe('₹0');
    expect(textOf(card, 'cs-outstanding')).toBe('₹20,000');
    expect(rowsOf(card, 'ledger-total')[0][3]).toBe('₹20,000');
    expect(rowsOf(card, 'ledger-row')).toHaveLength(9);
  });
});

// ================================================================================================ source: nothing of the date editor or the edit mode is left

function codeWords(file: string) {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.ES2022,
    true,
    ts.ScriptKind.TSX
  );
  const identifiers = new Set<string>();
  const strings: string[] = [];
  const jsx: Array<{ tag: string; attributes: Record<string, string> }> = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node)) identifiers.add(node.text);
    else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      strings.push(node.text);
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      const attributes: Record<string, string> = {};
      for (const p of node.attributes.properties)
        if (ts.isJsxAttribute(p))
          attributes[p.name.getText(source)] =
            p.initializer?.getText(source).replace(/^"|"$/g, '') ?? 'true';
      jsx.push({ tag: node.tagName.getText(source), attributes });
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return { identifiers, strings, jsx };
}

describe('PT-W10 the estimate screen holds no date editor and no edit mode (K1, Y8, C15; T-E04)', () => {
  const file = path.join(SRC, 'app/estimate/components/EstimateViewClient.tsx');

  it('it neither reads nor calls the writers of a bill, and keeps no draft', () => {
    const { identifiers } = codeWords(file);
    for (const name of [
      'updateInvoice',
      'updateInvoiceDate',
      'startEditing',
      'cancelEditing',
      'saveDraft',
      'setDraft',
      'editing',
      'recalculateEstimateDraft',
      'handleDateChange',
    ])
      expect(identifiers.has(name), name).toBe(false);
  });

  it('it has no date input anywhere in its markup, and no text for editing', () => {
    const { jsx, strings } = codeWords(file);
    expect(jsx.filter((e) => e.attributes.type === 'date')).toEqual([]);
    expect(strings.filter((s) => /Edit Estimate|Save Changes/.test(s))).toEqual([]);
  });

  it('the customer screens have no date input either', () => {
    for (const name of ['CustomerDetail', 'CustomerInvoiceList', 'CustomerLedgerTable']) {
      const { jsx } = codeWords(path.join(SRC, `app/customer-ledger/components/${name}.tsx`));
      expect(
        jsx.filter((e) => e.attributes.type === 'date'),
        name
      ).toEqual([]);
    }
  });

  it('the shared numbers on the three screens come from one module (no private toLocaleString of a rupee amount)', () => {
    for (const name of ['CustomerDetail', 'CustomerInvoiceList', 'CustomerLedgerTable']) {
      const text = readFileSync(
        path.join(SRC, `app/customer-ledger/components/${name}.tsx`),
        'utf8'
      );
      expect(text, name).not.toMatch(/toLocaleString\('en-IN'/);
    }
    expect(readFileSync(file, 'utf8')).not.toMatch(/toLocaleString\('en-IN'/);
  });
});
