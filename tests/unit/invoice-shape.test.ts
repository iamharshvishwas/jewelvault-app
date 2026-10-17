// WEB07 (spec C1, C3, C6, C11, C14): the money-side store `appStore` keeps its exported names and its synchronous reads, and answers from the rows the hydrate and the poll put
// in memory (customers, bills, bill-summary, bill-items, receipts, receipt-allocations, customer-balances). `getInvoices()` gives the prototype's `Invoice` shape with the
// four derived figures TAKEN from V1 (`received`, `pending`, `payment_status`, `fine_pending`), never worked out again from the lines and payments. A customer is made by X6
// with a fresh Idempotency-Key; a double click and a retry after a lost answer make one customer.
//
// The fixture is tests/unit/support/money-rows.ts: six bills of one customer with the V1 figures worked out by hand in its comment. The browser halves (the same figures on the
// screens of a lane API, and the real search panel clicked twice) are tests/e2e/money-cache.spec.ts.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { at } from './support/rows';
import {
  allocationRow,
  balanceRow,
  customerRow,
  fill,
  id,
  shop,
  type Shop,
} from './support/money-rows';
import { FakeMoneyApi } from './support/money-server';

async function load({ preview = false } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const [cache, app] = await Promise.all([import('@/lib/cache/cache'), import('@/lib/appStore')]);
  return { cache: cache.rowCache, app };
}

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

type Loaded = Awaited<ReturnType<typeof load>>;

function invoiceOf(app: Loaded['app'], billNo: string) {
  const found = app.getInvoices().find((invoice) => invoice.invoiceNumber === billNo);
  if (!found) throw new Error(`no invoice ${billNo} in getInvoices()`);
  return found;
}

describe('T-E04 clause (C1): getInvoices() returns the Invoice shape on the rows of the cache', () => {
  it('holds nothing before the hydrate: no sample invoice, no sample customer, no sample ledger', async () => {
    const { app } = await load();
    expect(app.getInvoices()).toEqual([]);
    expect(app.getCustomers()).toEqual([]);
    expect(app.getLedger()).toEqual([]);
    expect(app.getLedgerForCustomer(id.priya)).toEqual([]);
    expect(app.getInvoiceById('JV-0001')).toBeUndefined();
  });

  it('one bill comes back camelCase with its lines, its payments and every header figure (JV-0001)', async () => {
    const { cache, app } = await load();
    const book = fill(cache);
    const invoice = invoiceOf(app, 'JV-0001');
    expect(invoice).toMatchObject({
      id: book.by.partial.bill.id,
      invoiceNumber: 'JV-0001',
      customerId: id.priya,
      customerName: 'Priya Sharma',
      customerMobile: '9876543210',
      subtotal: 257611.66,
      discount: 0,
      additionalCharges: 0,
      gst: 0,
      gstPercent: 0,
      roundOff: 0.34,
      grandTotal: 257612,
      amountDue: 257612,
      saleType: 'Retail',
      fineWeightDue: 0,
      notes: 'Bridal set',
      createdBy: 'Asha Verma',
    });
    expect(invoice.items).toHaveLength(2);
    // sorted by line_no, whatever order the cache holds them in
    expect(invoice.items.map((item) => item.skuNumber)).toEqual([
      'RING-00001-001',
      'SET-00572-001',
    ]);
    expect(invoice.items[0]).toEqual({
      id: book.items.find((i) => i.bill_id === invoice.id && i.line_no === 1)?.id,
      designNumber: 'RING-00001',
      skuNumber: 'RING-00001-001',
      material: 'Gold',
      purity: '22K',
      grossWeight: 38.1,
      customerNetWeight: 35.42,
      metalRate: 6920,
      labour: 12505.26,
      piroi: 0,
      otherCharges: 0,
      metalAmount: 245106.4,
      fineWeightDue: 0,
      itemTotal: 257611.66,
      sellingMethod: 'By Weight',
      imageRef: '/assets/images/no_image.png',
      category: 'Ring',
      taxRate: 0,
      taxAmount: 0,
    });
    // the payments are the receipts that are allocated to the bill and live: cash and UPI; the released and the voided one are not here
    expect(invoice.payments).toEqual([
      {
        id: book.receipts[0].id,
        mode: 'Cash',
        amount: 100000,
        date: expect.stringMatching(/^2026-10-15T/),
        reference: 'CASH-1',
        notes: '',
      },
      {
        id: book.receipts[1].id,
        mode: 'UPI',
        amount: 57612,
        date: expect.stringMatching(/^2026-10-15T/),
        reference: 'UPI-7788',
        notes: 'second part',
      },
    ]);
  });

  // the figures worked out by hand in tests/unit/support/money-rows.ts
  const HAND: Array<
    [
      name: keyof Shop['by'],
      billNo: string,
      received: number,
      pending: number,
      status: string,
      finePending: number,
    ]
  > = [
    ['partial', 'JV-0001', 157612, 100000, 'Partial', 0],
    ['silver', 'JV-0002', 40000, 0, 'Partial', 15],
    ['cancelled', 'JV-0003', 0, 0, 'Cancelled', 0],
    ['pending', 'JV-0004', 0, 12000, 'Pending', 0],
    ['paid', 'JV-0005', 3000, 0, 'Paid', 0],
  ];

  it.each(HAND)(
    '%s (%s): amountReceived, pendingAmount, status and fineWeightPending are the figures of V1',
    async (name, billNo, received, pending, status, finePending) => {
      const { cache, app } = await load();
      const book = fill(cache);
      const invoice = invoiceOf(app, billNo);
      // by hand
      expect(invoice.amountReceived).toBe(received);
      expect(invoice.pendingAmount).toBe(pending);
      expect(invoice.status).toBe(status);
      expect(invoice.fineWeightPending).toBe(finePending);
      // and equal to the row of V1 that came from the server, field for field
      const v1 = book.by[name].summary;
      expect(invoice.amountReceived).toBe(Number(v1.received));
      expect(invoice.pendingAmount).toBe(Number(v1.pending));
      expect(invoice.status).toBe(v1.payment_status);
      expect(invoice.fineWeightPending).toBe(Number(v1.fine_pending));
      expect(invoice.fineWeightSettled).toBe(Number(v1.fine_settled));
      expect(invoice.fineWeightDue).toBe(Number(v1.fine_due));
    }
  );

  it('a cancelled bill shows nothing received and nothing pending, and no payment (its allocation was released)', async () => {
    const { cache, app } = await load();
    fill(cache);
    const invoice = invoiceOf(app, 'JV-0003');
    expect(invoice.status).toBe('Cancelled');
    expect(invoice.payments).toEqual([]);
    expect(invoice.amountReceived).toBe(0);
  });

  it('a silver bill carries what is owed in fine: due 25.000 g, settled 10.000 g, pending 15.000 g, and the silver receipt is not a money payment', async () => {
    const { cache, app } = await load();
    fill(cache);
    const invoice = invoiceOf(app, 'JV-0002');
    expect(invoice).toMatchObject({
      saleType: 'Wholesale',
      fineWeightDue: 25,
      fineWeightSettled: 10,
      fineWeightPending: 15,
    });
    expect(invoice.items[0]).toMatchObject({
      material: 'Silver',
      purity: '925',
      fineWeightDue: 25,
    });
    expect(invoice.payments.map((p) => [p.mode, p.amount])).toEqual([['Bank Transfer', 40000]]);
  });

  it('negative control: the figures follow the V1 row and are not worked out again from the payments', async () => {
    const { cache, app } = await load();
    const book = fill(cache);
    // the server says something the payments do not add up to (a poll brought a newer V1 row)
    cache.merge('bill-summary', [
      {
        ...book.by.partial.summary,
        received: '1.00',
        pending: '257611.00',
        payment_status: 'Pending',
        updated_at: at(500),
      },
    ]);
    const invoice = invoiceOf(app, 'JV-0001');
    expect(invoice.amountReceived).toBe(1);
    expect(invoice.pendingAmount).toBe(257611);
    expect(invoice.status).toBe('Pending');
    // while the two payments of the allocations still add up to 157612: nothing was added up here
    expect(invoice.payments.reduce((sum, p) => sum + p.amount, 0)).toBe(157612);
  });

  it('a bill whose V1 row has not arrived is left out: the store makes up no figure', async () => {
    const { cache, app } = await load();
    const book = shop();
    fill(cache, { ...book, summaries: book.summaries.filter((s) => s.bill_no !== 'JV-0004') });
    expect(app.getInvoices().map((i) => i.invoiceNumber)).not.toContain('JV-0004');
    expect(app.getInvoices()).toHaveLength(4);
    cache.merge('bill-summary', [book.by.pending.summary]);
    expect(app.getInvoices().map((i) => i.invoiceNumber)).toContain('JV-0004');
  });

  it('the date is the business date: the instant it was made when that is the same Indian day, else noon of the bill date', async () => {
    const { cache, app } = await load();
    fill(cache);
    // JV-0001 was made at 09:00:11 UTC = 14:30 in India, the day it is dated
    expect(invoiceOf(app, 'JV-0001').date).toBe('2026-10-15T09:00:11.000Z');
    // JV-0004 is dated the 14th but made on the 15th: the date on the paper wins
    expect(invoiceOf(app, 'JV-0004').date).toBe('2026-10-14T12:00:00.000Z');
    expect(invoiceOf(app, 'JV-0004').date.slice(0, 10)).toBe('2026-10-14');
  });

  it('is the same array until a row it is made of changes, and made again when one does', async () => {
    const { cache, app } = await load();
    const book = fill(cache);
    const first = app.getInvoices();
    expect(app.getInvoices()).toBe(first);
    cache.merge('designs', []); // nothing stored: no new version
    expect(app.getInvoices()).toBe(first);
    cache.merge('receipts', [{ ...book.receipts[0], reference: 'CASH-1B', updated_at: at(600) }]);
    const second = app.getInvoices();
    expect(second).not.toBe(first);
    expect(invoiceOf(app, 'JV-0001').payments[0].reference).toBe('CASH-1B');
    // a customer's new name reaches the invoices that show it
    cache.merge('customers', [
      { ...book.customers[0], name: 'Priya Sharma-Rao', updated_at: at(610) },
    ]);
    expect(invoiceOf(app, 'JV-0001').customerName).toBe('Priya Sharma-Rao');
  });

  it('is emptied by a logout (the cache is cleared) and shows nothing of the old session', async () => {
    const { cache, app } = await load();
    fill(cache);
    expect(app.getInvoices().length).toBeGreaterThan(0);
    cache.clear();
    expect(app.getInvoices()).toEqual([]);
    expect(app.getCustomers()).toEqual([]);
  });

  it('getInvoiceById finds a bill by its id and by its number', async () => {
    const { cache, app } = await load();
    const book = fill(cache);
    expect(app.getInvoiceById(book.by.silver.bill.id)?.invoiceNumber).toBe('JV-0002');
    expect(app.getInvoiceById('JV-0002')?.id).toBe(book.by.silver.bill.id);
    expect(app.getInvoiceById('JV-9999')).toBeUndefined();
  });

  it('a bill with a fraction of a rupee or of a gram keeps the exact text figures for display only (no float sum is made)', async () => {
    const { cache, app } = await load();
    const book = shop();
    fill(cache, {
      ...book,
      summaries: book.summaries.map((s) =>
        s.bill_no === 'JV-0001' ? { ...s, received: '0.10', pending: '257611.90' } : s
      ),
    });
    const invoice = invoiceOf(app, 'JV-0001');
    expect(invoice.amountReceived).toBe(0.1);
    expect(invoice.pendingAmount).toBe(257611.9);
  });
});

describe('C14: an opening-balance bill is dues brought forward, not a sale', () => {
  it('is not one of getInvoices() (the estimate lists, the sales figures), but it is a pending payment and the bill can still be found by its number', async () => {
    const { cache, app } = await load();
    fill(cache);
    expect(app.getInvoices().map((i) => i.invoiceNumber)).not.toContain('OB-0001');
    expect(app.getInvoiceById('OB-0001')?.pendingAmount).toBe(20000);
    const pending = app.computePendingPayments();
    expect(pending.map((p) => p.invoiceNumber).sort()).toEqual(['JV-0001', 'JV-0004', 'OB-0001']);
    expect(pending.find((p) => p.invoiceNumber === 'OB-0001')?.amount).toBe(20000);
  });

  it("today's sales do not hold it", async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-01T06:00:00Z'));
    const { cache, app } = await load();
    fill(cache);
    // the only bill dated the 1st is the opening one
    expect(app.computeDashboardStats().todaySales).toBe(0);
  });
});

describe('getCustomers() on the rows of customers and customer-balances (V2)', () => {
  it('gives the prototype customer with the saved figures of V2, and hides an archived customer', async () => {
    const { cache, app } = await load();
    fill(cache);
    const customers = app.getCustomers();
    expect(customers.map((c) => c.name).sort()).toEqual(['Priya Sharma', 'Walk-in']);
    const priya = customers.find((c) => c.id === id.priya);
    expect(priya).toEqual({
      id: id.priya,
      name: 'Priya Sharma',
      mobile: '9876543210',
      customerType: 'Retail',
      email: 'priya@example.test',
      address: '12 Johari Bazaar, Jaipur',
      gstNumber: '',
      notes: '',
      totalPurchases: 317612,
      totalReceived: 200612,
      outstanding: 132000,
      outstandingSilverFine: 15,
      lastPurchase: '2026-10-15T12:00:00.000Z',
      createdAt: '2026-10-15T09:00:05.000Z',
    });
  });

  it('the walk-in customer has no mobile number: an empty text, not null (the search reads mobile.includes)', async () => {
    const { cache, app } = await load();
    fill(cache);
    const walkin = app.getCustomers().find((c) => c.id === id.walkin);
    expect(walkin?.mobile).toBe('');
    expect(() => app.getCustomers().filter((c) => c.mobile.includes('98'))).not.toThrow();
  });

  it('a customer whose V2 row has not arrived shows zeros, not a made-up figure; the row arriving updates it', async () => {
    const { cache, app } = await load();
    const book = shop();
    fill(cache, { ...book, balances: [] });
    expect(app.getCustomers().find((c) => c.id === id.priya)).toMatchObject({
      outstanding: 0,
      totalPurchases: 0,
      lastPurchase: '',
    });
    cache.merge('customer-balances', [
      balanceRow(id.priya, { outstanding: '10.50', total_purchases: '99.00', updated_at: at(70) }),
    ]);
    expect(app.getCustomers().find((c) => c.id === id.priya)).toMatchObject({
      outstanding: 10.5,
      totalPurchases: 99,
    });
  });

  it('the newest customer first, as the prototype listed a new one at the top', async () => {
    const { cache, app } = await load();
    fill(cache);
    cache.merge('customers', [
      customerRow('00000000-0000-4000-8000-000000009999', {
        name: 'Newest',
        created_at: '2026-10-16T08:00:00.000000Z',
        updated_at: '2026-10-16T08:00:00.000000Z',
      }),
    ]);
    expect(app.getCustomers()[0].name).toBe('Newest');
  });

  it('an allocation whose receipt is not in memory yet is left out of the payments: it might be a voided one', async () => {
    const { cache, app } = await load();
    const book = fill(cache);
    cache.merge('receipt-allocations', [
      allocationRow(
        98,
        { ...book.receipts[0], id: '00000000-0000-4000-8000-0000000000aa' },
        book.by.pending.bill,
        {
          amount: '5.00',
        }
      ),
    ]);
    expect(invoiceOf(app, 'JV-0004').payments).toEqual([]);
  });
});

describe('a real build cannot save a money change yet: it says so and changes nothing (WEB08 to WEB11 put each kind of save on the API)', () => {
  it('every writing function throws and the lists stay as they were', async () => {
    const { cache, app } = await load();
    fill(cache);
    const before = app.getInvoices();
    const customers = app.getCustomers();
    const invoice = invoiceOf(app, 'JV-0004');
    const writes: Array<[string, () => unknown]> = [
      ['addInvoice', () => app.addInvoice({ ...invoice, id: 'new', invoiceNumber: 'JV-NEW' })],
      ['updateInvoice', () => app.updateInvoice(invoice.id, { notes: 'changed' })],
      ['updateInvoiceDate', () => app.updateInvoiceDate(invoice.id, '2026-10-01')],
      ['updateCustomer', () => app.updateCustomer(id.priya, { name: 'X' })],
      ['removeCustomer', () => app.removeCustomer(id.priya)],
      [
        'recordPayment',
        () =>
          app.recordPayment(id.priya, {
            mode: 'Cash',
            amount: 100,
            date: '2026-10-15',
            reference: '',
            notes: '',
          }),
      ],
      ['settleSilverFine', () => app.settleSilverFine(id.priya, 1, 'Silver')],
      ['deleteRecordedPayment', () => app.deleteRecordedPayment('x')],
      [
        'addLedgerEntry',
        () =>
          app.addLedgerEntry({
            customerId: id.priya,
            date: '2026-10-15',
            type: 'Payment',
            description: 'x',
            debit: 0,
            credit: 1,
            reference: '',
          }),
      ],
    ];
    for (const [name, write] of writes) expect(write, name).toThrow(/cannot be saved yet/);
    expect(app.getInvoices()).toBe(before);
    expect(app.getCustomers()).toBe(customers);
  });

  it('the next invoice number is not made up: the server gives it when the bill is saved (C11)', async () => {
    const { cache, app } = await load();
    fill(cache);
    expect(app.getNextInvoiceNumber()).toBe('Number assigned when saved');
  });

  it('touches no browser storage', async () => {
    vi.resetModules();
    const touched: string[] = [];
    const storage = {
      getItem: (k: string) => {
        touched.push(`get ${k}`);
        return null;
      },
      setItem: (k: string) => {
        touched.push(`set ${k}`);
      },
      removeItem: (k: string) => {
        touched.push(`remove ${k}`);
      },
    };
    vi.stubGlobal('window', { localStorage: storage });
    const { cache, app } = await load();
    fill(cache);
    app.getInvoices();
    app.getCustomers();
    expect(touched).toEqual([]);
  });
});

describe('preview build: the prototype keeps its own sample data and local behaviour', () => {
  it('starts from the sample customers and still makes a customer locally', async () => {
    const { app } = await load({ preview: true });
    const before = app.getCustomers().length;
    expect(before).toBeGreaterThan(0);
    const made = await app.addCustomer({
      name: 'Local',
      mobile: '9000000000',
      email: '',
      address: '',
      gstNumber: '',
      notes: '',
    });
    expect(made.id).toMatch(/^cust-/);
    expect(app.getCustomers()).toHaveLength(before + 1);
    expect(app.getNextInvoiceNumber()).toMatch(/-\d{4}-\d{4}$/);
  });
});

describe('creating a customer: X6 with a fresh Idempotency-Key, one customer on a double click and after a lost answer (C6, L5, WEB07 done-when)', () => {
  const person = {
    name: 'Meena Joshi',
    mobile: '9811122233',
    customerType: 'Wholesale' as const,
    email: '',
    address: 'Chandni Chowk',
    gstNumber: '',
    notes: '',
  };

  async function withServer() {
    const server = new FakeMoneyApi();
    vi.stubGlobal('fetch', server.fetch);
    const loaded = await load();
    return { server, ...loaded };
  }
  const keysOf = (server: FakeMoneyApi) =>
    server.seen.filter((c) => c.path === '/v1/customers').map((c) => c.key);

  it('sends the X6 body (blank optional text left out), a UUID key and the CSRF header, and applies the returned row at once', async () => {
    const { server, app } = await withServer();
    const made = await app.addCustomer(person);
    expect(server.count('/v1/customers')).toBe(1);
    const call = server.seen[0];
    expect(call.body).toEqual({
      name: 'Meena Joshi',
      mobile: '9811122233',
      customer_type: 'Wholesale',
      address: 'Chandni Chowk',
    });
    expect(call.key).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(call.header['x-jv-client']).toBe('web');
    // the id is the server's, never made up here (C11), and the customer is in the list at once
    expect(made.id).toBe(server.customers[0].id);
    expect(made).toMatchObject({ name: 'Meena Joshi', customerType: 'Wholesale', outstanding: 0 });
    expect(app.getCustomers().map((c) => c.id)).toContain(made.id);
  });

  it('a second customer later gets a key of its own', async () => {
    const { server, app } = await withServer();
    await app.addCustomer(person);
    await app.addCustomer({ ...person, mobile: '9811122244' });
    const [first, second] = keysOf(server);
    expect(first).not.toBe(second);
    expect(server.customers).toHaveLength(2);
  });

  it('a double click (the same customer asked for twice before the first answer) is one request and one customer', async () => {
    const { server, app } = await withServer();
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const first = app.addCustomer(person);
    const second = app.addCustomer({ ...person });
    release();
    const [a, b] = await Promise.all([first, second]);
    expect(server.count('/v1/customers')).toBe(1);
    expect(server.customers).toHaveLength(1);
    expect(a.id).toBe(b.id);
    expect(app.getCustomers().filter((c) => c.name === 'Meena Joshi')).toHaveLength(1);
  });

  it('negative control: two different customers asked for together are two requests', async () => {
    const { server, app } = await withServer();
    await Promise.all([
      app.addCustomer(person),
      app.addCustomer({ ...person, mobile: '9811122244' }),
    ]);
    expect(server.count('/v1/customers')).toBe(2);
    expect(new Set(keysOf(server)).size).toBe(2);
  });

  it('the answer is dropped after the server saved: the call says it could not confirm, and the same customer asked again sends the SAME key and still makes one customer', async () => {
    const { server, app } = await withServer();
    server.dropAnswers = 1;
    const failure = await app.addCustomer(person).then(
      () => null,
      (error: unknown) => error as { message: string; unconfirmed: boolean; idempotencyKey: string }
    );
    expect(failure?.unconfirmed).toBe(true);
    expect(failure?.message).toMatch(/Could not confirm that this was saved/);
    expect(server.customers).toHaveLength(1); // it was saved; the screen does not know

    const made = await app.addCustomer(person);
    const [first, second] = keysOf(server);
    expect(second).toBe(first);
    expect(failure?.idempotencyKey).toBe(first);
    expect(server.customers).toHaveLength(1); // the replay made nothing new
    expect(made.id).toBe(server.customers[0].id);
    expect(app.getCustomers().filter((c) => c.name === 'Meena Joshi')).toHaveLength(1);
  });

  it('negative control: without the reuse the same lost answer makes two customers', async () => {
    const { server, app } = await withServer();
    server.dropAnswers = 1;
    await app.addCustomer(person).catch(() => undefined);
    // a different person pressing Save for a customer with other details is another action: a new key, a new customer
    await app.addCustomer({ ...person, mobile: '9811122255' });
    const [first, second] = keysOf(server);
    expect(second).not.toBe(first);
    expect(server.customers).toHaveLength(2);
  });

  it('after a success the same details are a new action (a new key), and after a refusal the form changed is a new action too', async () => {
    const { server, app } = await withServer();
    server.refuse = { code: 'JV_INVALID_INPUT', status: 422, times: 1 };
    const refused = await app.addCustomer(person).then(
      () => null,
      (error: unknown) => error as { message: string; unconfirmed: boolean }
    );
    expect(refused?.unconfirmed).toBe(false);
    expect(refused?.message).toMatch(/Nothing was changed/);
    expect(server.customers).toHaveLength(0);
    // the person fixes the mobile number: another body, another key
    await app.addCustomer({ ...person, mobile: '9811122299' });
    const [first, second] = keysOf(server);
    expect(second).not.toBe(first);
    // the same details again after a success are a second customer, with a third key
    await app.addCustomer({ ...person, mobile: '9811122299' });
    expect(new Set(keysOf(server)).size).toBe(3);
    expect(server.customers).toHaveLength(2);
  });

  it('a retry after a refusal with the form unchanged sends the same key (the refused call used none up)', async () => {
    const { server, app } = await withServer();
    server.refuse = { code: 'JV_INTERNAL', status: 500, times: 1 };
    await app.addCustomer(person).catch(() => undefined);
    await app.addCustomer(person);
    const keys = keysOf(server);
    expect(new Set(keys).size).toBe(1);
    expect(server.customers).toHaveLength(1);
  });
});
