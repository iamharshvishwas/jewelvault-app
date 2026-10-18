// WEB11 (PT-W11, unit half: "a biller sees none"; spec A4, X4, X5, X10, X11, X12, K1, K6, S7): the owner's actions are on the screens for the owner of a real build and for nobody else.
//
//   - the Cancel and Re-issue buttons of a bill (the Invoices tab and the estimate): Cancel on every live bill, Re-issue on a live estimate (not on dues brought forward), neither on a
//     cancelled bill; a cancelled bill says when and why, and which bill replaced it;
//   - the Void button on each live receipt of the Payments tab and on each live refund; a voided one is tagged Voided and has no button;
//   - "Hand Money Back" and "Opening Balance" on the customer card;
//   - a biller, a staff user, a person whose role is not known yet, and an owner in a PREVIEW build see none of them (the buttons are not drawn at all).
//
// The screens are drawn on the server side of React (`renderToStaticMarkup`) over the real store, filled with the rows of `shop()` (tests/unit/support/money-rows.ts); the role is the one
// thing stood in for. The API is the wall (tests/e2e/owner-actions.spec.ts proves a biller's call is refused); this proves the screens do not offer what would be refused.
//
// Run: npm test -- tests/unit/owner-screens.test.ts      (or: npm test -- -t PT-W11)
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ReactElement } from 'react';
import type { LedgerEntry } from '@/lib/mockData';
import { billRow, fill, id, receiptRow, type Shop } from './support/money-rows';

const address = vi.hoisted(() => ({ search: '' }));
vi.mock('next/navigation', () => ({
  useSearchParams: () => new URLSearchParams(address.search),
  usePathname: () => '/estimate',
  useRouter: () => ({ push: () => undefined, replace: () => undefined }),
}));

type Who = 'owner' | 'biller' | 'staff' | null;

async function load(who: Who, { preview = false } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  vi.doMock('@/lib/authStore', async (importOriginal) => ({
    ...(await importOriginal<typeof import('@/lib/authStore')>()),
    useSession: () => ({ role: who }),
  }));
  const [react, dom, cache, app, actions, list, tab, detail, estimate] = await Promise.all([
    import('react'),
    import('react-dom/server'),
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
    import('@/components/owner/OwnerBillActions'),
    import('@/app/customer-ledger/components/CustomerInvoiceList'),
    import('@/app/customer-ledger/components/CustomerPaymentsTab'),
    import('@/app/customer-ledger/components/CustomerDetail'),
    import('@/app/estimate/components/EstimateViewClient'),
  ]);
  const book: Shop = fill(cache.rowCache);
  // a live refund of Priya's, so that the Refunds list has a row
  const refund = receiptRow(90, id.priya, { kind: 'refund', amount: '300.00', mode: 'Cash' });
  cache.rowCache.merge('receipts', [refund]);
  const draw = (element: ReactElement) => dom.renderToStaticMarkup(element);
  const el = react.createElement;
  const entry = (receiptId: string, over: Partial<LedgerEntry> = {}): LedgerEntry => ({
    id: `3:${receiptId}`,
    customerId: id.priya,
    date: '2026-10-15T12:00:00.000Z',
    type: 'Payment',
    description: 'Payment (Cash)',
    debit: 0,
    credit: 100,
    balance: 0,
    reference: '',
    paymentId: receiptId,
    ...over,
  });
  return {
    book,
    refund,
    app,
    billActions: (billId: string) => draw(el(actions.default, { billId })),
    invoiceList: () =>
      draw(el(list.default, { invoices: app.getBillsOfCustomer(id.priya).reverse() })),
    paymentsTab: (entries: LedgerEntry[], refunds: LedgerEntry[], voided: string[] = []) =>
      draw(el(tab.default, { entries, refunds, voided: new Set(voided) })),
    card: () => {
      // a preview build reads its own sample customers, so the card is given one of its own there
      const customer = preview
        ? {
            id: id.priya,
            name: 'Priya Sharma',
            mobile: '9876543210',
            customerType: 'Retail' as const,
            email: '',
            address: '',
            gstNumber: '',
            notes: '',
            totalPurchases: 0,
            totalReceived: 0,
            outstanding: 0,
            outstandingSilverFine: 0,
            lastPurchase: '',
            createdAt: '2026-10-15T09:00:00.000Z',
          }
        : app.getCustomers().find((c) => c.id === id.priya);
      if (!customer) throw new Error('Priya is not in memory');
      return draw(el(detail.default, { customer }));
    },
    estimate: (billId: string) => {
      address.search = `id=${billId}`;
      return draw(el(estimate.default, {}));
    },
    entry,
  };
}

afterEach(() => {
  vi.doUnmock('@/lib/authStore');
  vi.unstubAllEnvs();
  address.search = '';
});

const count = (html: string, testId: string): number =>
  (html.match(new RegExp(`data-testid="${testId}"`, 'g')) ?? []).length;

const NOT_THE_OWNER: Array<[string, Who]> = [
  ['a biller', 'biller'],
  ['a staff user', 'staff'],
  ['a person whose role is not known', null],
];

describe('PT-W11 the owner has Cancel and Re-issue on a bill; the others have none (X5, X10, K1, K6)', () => {
  it('a live estimate: both buttons, and Re-issue goes to the billing screen with the bill in the address', async () => {
    const w = await load('owner');
    const html = w.billActions(w.book.by.pending.bill.id);
    expect(count(html, 'cancel-bill')).toBe(1);
    expect(count(html, 'reissue-bill')).toBe(1);
    expect(html).toContain(`href="/billing-pos?reissue=${w.book.by.pending.bill.id}"`);
  });

  it('dues brought forward (an opening balance) can be cancelled (IM5) but not re-issued: it has no lines to correct', async () => {
    const w = await load('owner');
    const html = w.billActions(w.book.by.opening.bill.id);
    expect(count(html, 'cancel-bill')).toBe(1);
    expect(count(html, 'reissue-bill')).toBe(0);
  });

  it('a cancelled bill, a bill that is not in memory and a bill of nobody have no button', async () => {
    const w = await load('owner');
    expect(w.billActions(w.book.by.cancelled.bill.id)).toBe('');
    expect(w.billActions('00000000-0000-4000-8000-0000000000ff')).toBe('');
  });

  for (const [name, who] of NOT_THE_OWNER) {
    it(`${name} sees no Cancel and no Re-issue anywhere: not on one bill, not on the Invoices tab, not on the estimate`, async () => {
      const w = await load(who);
      expect(w.billActions(w.book.by.pending.bill.id)).toBe('');
      const invoices = w.invoiceList();
      expect(invoices).toContain('data-testid="invoice-row"'); // the list itself is there
      expect(count(invoices, 'cancel-bill')).toBe(0);
      expect(count(invoices, 'reissue-bill')).toBe(0);
      const estimate = w.estimate(w.book.by.pending.bill.id);
      expect(estimate).toContain('data-testid="estimate-number"');
      expect(count(estimate, 'cancel-bill')).toBe(0);
      expect(count(estimate, 'reissue-bill')).toBe(0);
    });
  }

  it('an owner in a PREVIEW build sees none: there is no server to send them to', async () => {
    const w = await load('owner', { preview: true });
    expect(w.billActions(w.book.by.pending.bill.id)).toBe('');
  });

  it("the Invoices tab: Cancel on every live bill (five of Priya's six), Re-issue on every live estimate (four: not the opening balance), none on the cancelled bill", async () => {
    const w = await load('owner');
    const html = w.invoiceList();
    expect(count(html, 'invoice-row')).toBe(6);
    expect(count(html, 'cancel-bill')).toBe(5);
    expect(count(html, 'reissue-bill')).toBe(4);
  });

  it('the estimate has the buttons for the owner on a live bill, and says when, why and by whom a bill was cancelled', async () => {
    const w = await load('owner');
    expect(count(w.estimate(w.book.by.pending.bill.id), 'cancel-bill')).toBe(1);
    const cancelled = w.estimate(w.book.by.cancelled.bill.id);
    expect(count(cancelled, 'cancel-bill')).toBe(0);
    expect(cancelled).toContain('data-testid="estimate-cancelled"');
    expect(cancelled).toContain('Reason: wrong customer');
    expect(cancelled).toContain('Cancelled on');
  });

  it('a cancelled bill names the bill that replaced it, and the new bill names the one it replaces (K6)', async () => {
    const w = await load('biller');
    const fresh = billRow(77, id.priya, {
      bill_no: 'JV-0077',
      reissue_of: w.book.by.cancelled.bill.id,
      grand_total: '5000.00',
    });
    const { rowCache } = await import('@/lib/cache/cache');
    rowCache.merge('bills', [fresh]);
    rowCache.merge('bill-summary', [
      {
        ...w.book.by.pending.summary,
        id: fresh.id,
        bill_no: 'JV-0077',
        reissue_of: w.book.by.cancelled.bill.id,
      },
    ]);
    const old = w.estimate(w.book.by.cancelled.bill.id);
    expect(old).toContain('data-testid="estimate-reissued-as"');
    expect(old).toContain('JV-0077');
    const replacement = w.estimate(fresh.id);
    expect(replacement).toContain('data-testid="estimate-reissue-of"');
    expect(replacement).toContain(w.book.by.cancelled.bill.bill_no);
  });
});

describe('PT-W11 the owner has Void on each live receipt and each live refund; the others have none (X4, Y7, S7)', () => {
  it('the owner: Void on a live receipt, none on a voided one (tagged Voided), and a Refunds list with its own Void', async () => {
    const w = await load('owner');
    const live = w.book.receipts.find((r) => r.status === 'active');
    const gone = w.book.receipts.find((r) => r.status === 'voided');
    if (!live || !gone) throw new Error('the book needs a live and a voided receipt');
    const html = w.paymentsTab(
      [w.entry(live.id), w.entry(gone.id)],
      [
        w.entry(w.refund.id, {
          id: `4:${w.refund.id}`,
          type: 'Adjustment',
          kind: 'Refund',
          debit: 300,
          credit: 0,
          description: 'Refund (Cash)',
        }),
      ],
      [gone.id]
    );
    expect(count(html, 'payment-row')).toBe(2);
    expect(count(html, 'void-receipt')).toBe(1); // the live one only
    expect(count(html, 'voided-tag')).toBe(1);
    expect(count(html, 'refund-row')).toBe(1);
    expect(count(html, 'void-refund')).toBe(1);
    expect(html).toContain('Action');
  });

  for (const [name, who] of NOT_THE_OWNER) {
    it(`${name} sees the receipts and the refunds and no Void and no Action column`, async () => {
      const w = await load(who);
      const live = w.book.receipts.find((r) => r.status === 'active');
      if (!live) throw new Error('the book needs a live receipt');
      const html = w.paymentsTab(
        [w.entry(live.id)],
        [w.entry(w.refund.id, { id: `4:${w.refund.id}`, kind: 'Refund', debit: 300, credit: 0 })]
      );
      expect(count(html, 'payment-row')).toBe(1);
      expect(count(html, 'refund-row')).toBe(1);
      expect(count(html, 'void-receipt')).toBe(0);
      expect(count(html, 'void-refund')).toBe(0);
      expect(html).not.toContain('Action');
    });
  }

  it("an owner in a PREVIEW build keeps the prototype's Delete, and no Void", async () => {
    const w = await load('owner', { preview: true });
    const html = w.paymentsTab([w.entry(w.book.receipts[0].id)], []);
    expect(count(html, 'void-receipt')).toBe(0);
    expect(html).toContain('Delete');
  });
});

describe("PT-W11 the customer card: Hand Money Back (X11) and Opening Balance (X12) are the owner's (A4)", () => {
  it('the owner sees both buttons beside Receive Payment', async () => {
    const w = await load('owner');
    const html = w.card();
    expect(count(html, 'open-refund')).toBe(1);
    expect(count(html, 'open-opening')).toBe(1);
    expect(html).toContain('Receive Payment');
  });

  for (const [name, who] of NOT_THE_OWNER) {
    it(`${name} sees Receive Payment and neither of them`, async () => {
      const w = await load(who);
      const html = w.card();
      expect(html).toContain('Receive Payment');
      expect(count(html, 'open-refund')).toBe(0);
      expect(count(html, 'open-opening')).toBe(0);
    });
  }

  it('an owner in a PREVIEW build sees neither', async () => {
    const w = await load('owner', { preview: true });
    const html = w.card();
    expect(count(html, 'open-refund')).toBe(0);
    expect(count(html, 'open-opening')).toBe(0);
  });
});
