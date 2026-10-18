// WEB07 (spec C3, V3): `getLedgerForCustomer(customerId)` keeps its name and its synchronous read. The ledger of a customer is loaded from the server when the customer card opens
// (appStore `watchCustomerLedger`, which follows the customer's `updated_at`), and the entries are the prototype's `LedgerEntry` shape made from the rows of V3: the running balance
// and the fine balance are the server's, and nothing is added up again here.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { at } from './support/rows';
import { customerRow, fill, id, shop } from './support/money-rows';
import { FakeMoneyApi, ledgerRow, type LedgerWireRow } from './support/money-server';

async function load({ preview = false } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'https://api.example.test');
  const server = new FakeMoneyApi();
  vi.stubGlobal('fetch', server.fetch);
  const [cache, app] = await Promise.all([import('@/lib/cache/cache'), import('@/lib/appStore')]);
  return { server, cache: cache.rowCache, app };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** The ledger of the shop in money-rows.ts as V3 sends it: one row per event, with the running balances. */
function priyaLedger(book = shop()): LedgerWireRow[] {
  const [partial, silver, cancelled] = book.bills;
  const opening = book.bills[5];
  const [cash, upi, , , bank, fineSilver] = book.receipts;
  const row = (over: Partial<LedgerWireRow>) =>
    ledgerRow(1, id.priya, { entry_at: at(200), ...over });
  return [
    row({
      id: opening.id,
      kind_rank: 1,
      kind: 'Opening',
      entry_date: '2026-10-01',
      description: 'Opening balance OB-0001',
      debit: '20000.00',
      balance: '20000.00',
    }),
    row({
      id: partial.id,
      kind_rank: 1,
      kind: 'Invoice',
      description: 'Invoice JV-0001',
      debit: '257612.00',
      balance: '277612.00',
    }),
    row({
      id: cash.id,
      kind_rank: 3,
      kind: 'Payment',
      description: 'Payment (Cash)',
      debit: '0.00',
      credit: '100000.00',
      balance: '177612.00',
    }),
    row({
      id: upi.id,
      kind_rank: 3,
      kind: 'Payment',
      description: 'Payment (UPI)',
      debit: '0.00',
      credit: '57612.00',
      balance: '120000.00',
    }),
    row({
      id: silver.id,
      kind_rank: 1,
      kind: 'Invoice',
      description: 'Invoice JV-0002',
      debit: '40000.00',
      fine_debit: '25.000',
      balance: '160000.00',
      fine_balance: '25.000',
    }),
    row({
      id: bank.id,
      kind_rank: 3,
      kind: 'Payment',
      description: 'Payment (Bank Transfer)',
      debit: '0.00',
      credit: '40000.00',
      balance: '120000.00',
      fine_balance: '25.000',
    }),
    row({
      id: fineSilver.id,
      kind_rank: 3,
      kind: 'Fine',
      description: 'Silver received 10.000 g',
      debit: '0.00',
      fine_credit: '10.000',
      balance: '120000.00',
      fine_balance: '15.000',
    }),
    row({
      id: cancelled.id,
      kind_rank: 1,
      kind: 'Invoice',
      description: 'Invoice JV-0003',
      debit: '5000.00',
      balance: '125000.00',
      entry_date: '2026-10-15',
    }),
    row({
      id: cancelled.id,
      kind_rank: 2,
      kind: 'Cancellation',
      description: 'Cancelled JV-0003',
      debit: '0.00',
      credit: '5000.00',
      balance: '120000.00',
      entry_date: '2026-10-16',
    }),
    row({
      id: book.receipts[3].id,
      kind_rank: 5,
      kind: 'Void',
      description: 'Void of payment',
      debit: '8000.00',
      credit: '0.00',
      balance: '128000.00',
      entry_date: '2026-10-16',
    }),
    row({
      id: book.receipts[7].id,
      kind_rank: 4,
      kind: 'Refund',
      description: 'Refund (Cash)',
      debit: '300.00',
      credit: '0.00',
      balance: '128300.00',
    }),
  ];
}

describe('getLedgerForCustomer() on the ledger the server sent (V3)', () => {
  it("is empty until the card has loaded it, then gives the prototype LedgerEntry shape with the server's running balances", async () => {
    const { server, cache, app } = await load();
    fill(cache);
    server.ledgers.set(id.priya, priyaLedger());
    expect(app.getLedgerForCustomer(id.priya)).toEqual([]);
    await app.loadLedgerForCustomer(id.priya);
    const entries = app.getLedgerForCustomer(id.priya);
    expect(entries).toHaveLength(11);

    const invoice = entries.find((e) => e.description === 'Invoice JV-0001');
    expect(invoice).toEqual({
      id: `1:${shop().bills[0].id}`,
      customerId: id.priya,
      date: '2026-10-15T12:00:00.000Z',
      type: 'Invoice',
      kind: 'Invoice', // the kind V3 gave the row (WEB10): the ledger table names the row by it
      description: 'Invoice JV-0001',
      debit: 257612,
      credit: 0,
      balance: 277612,
      fineDebit: 0,
      fineCredit: 0,
      fineBalance: 0,
      reference: 'JV-0001',
      invoiceId: shop().bills[0].id,
    });
    const payment = entries.find((e) => e.description === 'Payment (UPI)');
    expect(payment).toMatchObject({
      type: 'Payment',
      credit: 57612,
      debit: 0,
      balance: 120000,
      reference: 'UPI-7788',
      paymentId: shop().receipts[1].id,
    });
    expect(payment?.invoiceId).toBeUndefined();
    const fine = entries.find((e) => e.description === 'Silver received 10.000 g');
    expect(fine).toMatchObject({ type: 'Payment', fineCredit: 10, fineBalance: 15, credit: 0 });
  });

  it("every entry has an id of its own, also the invoice and the cancellation of one bill (they share the bill's id in V3)", async () => {
    const { server, cache, app } = await load();
    fill(cache);
    server.ledgers.set(id.priya, priyaLedger());
    await app.loadLedgerForCustomer(id.priya);
    const entries = app.getLedgerForCustomer(id.priya);
    expect(new Set(entries.map((e) => e.id)).size).toBe(entries.length);
    const cancelled = shop().bills[2];
    expect(entries.filter((e) => e.invoiceId === cancelled.id)).toHaveLength(2);
  });

  it("maps every kind of V3 to one of the prototype's types", async () => {
    const { server, cache, app } = await load();
    fill(cache);
    server.ledgers.set(id.priya, priyaLedger());
    await app.loadLedgerForCustomer(id.priya);
    const typeOf = (text: string) =>
      app.getLedgerForCustomer(id.priya).find((e) => e.description.startsWith(text))?.type;
    expect(typeOf('Invoice JV-0001')).toBe('Invoice');
    expect(typeOf('Opening balance')).toBe('Invoice'); // dues brought forward are a debit of the same kind
    expect(typeOf('Cancelled JV-0003')).toBe('Return');
    expect(typeOf('Payment (Cash)')).toBe('Payment');
    expect(typeOf('Silver received')).toBe('Payment');
    expect(typeOf('Refund')).toBe('Adjustment');
    expect(typeOf('Void of')).toBe('Adjustment');
  });

  it("the order is the server's order, not sorted again, and the figures are not added up (a balance the rows do not add up to is shown as sent)", async () => {
    const { server, cache, app } = await load();
    fill(cache);
    const rows = priyaLedger();
    rows[2] = { ...rows[2], balance: '1.00' };
    server.ledgers.set(id.priya, rows);
    await app.loadLedgerForCustomer(id.priya);
    const entries = app.getLedgerForCustomer(id.priya);
    expect(entries.map((e) => e.description)).toEqual(rows.map((r) => r.description));
    expect(entries[2].balance).toBe(1);
  });

  it('is the same array until the ledger is read again or the receipts and bills it names change', async () => {
    const { server, cache, app } = await load();
    const book = fill(cache);
    server.ledgers.set(id.priya, priyaLedger(book));
    await app.loadLedgerForCustomer(id.priya);
    const first = app.getLedgerForCustomer(id.priya);
    expect(app.getLedgerForCustomer(id.priya)).toBe(first);
    cache.merge('receipts', [
      { ...book.receipts[1], reference: 'UPI-CHANGED', updated_at: at(900) },
    ]);
    const second = app.getLedgerForCustomer(id.priya);
    expect(second).not.toBe(first);
    expect(second.find((e) => e.description === 'Payment (UPI)')?.reference).toBe('UPI-CHANGED');
  });

  it('getLedger() is the entries of the ledgers that are loaded; a customer that was never opened has none', async () => {
    const { server, cache, app } = await load();
    fill(cache);
    cache.merge('customers', [
      customerRow('00000000-0000-4000-8000-0000000000cc', { name: 'Other' }),
    ]);
    server.ledgers.set(id.priya, priyaLedger());
    expect(app.getLedger()).toEqual([]);
    await app.loadLedgerForCustomer(id.priya);
    expect(app.getLedger()).toHaveLength(11);
    expect(app.getLedgerForCustomer('00000000-0000-4000-8000-0000000000cc')).toEqual([]);
  });

  it("a card that opens loads the ledger, follows the customer's stamp, and stops when it closes", async () => {
    const { server, cache, app } = await load();
    fill(cache);
    server.ledgers.set(id.priya, priyaLedger());
    const stop = app.watchCustomerLedger(id.priya);
    expect(app.getLedgerStatus(id.priya).state).toBe('loading');
    await vi.waitFor(() => expect(app.getLedgerStatus(id.priya).state).toBe('ready'));
    expect(app.getLedgerForCustomer(id.priya)).toHaveLength(11);
    server.ledgers.set(id.priya, [
      ...priyaLedger(),
      ledgerRow(99, id.priya, { description: 'Payment (Cash)', kind: 'Payment', kind_rank: 3 }),
    ]);
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(990) })]);
    await vi.waitFor(() => expect(app.getLedgerForCustomer(id.priya)).toHaveLength(12));
    stop();
    server.ledgers.set(id.priya, []);
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(995) })]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(app.getLedgerForCustomer(id.priya)).toHaveLength(12);
  });

  it('a ledger that could not be loaded says so (the card shows it) and is empty, never the old ledger or a sample', async () => {
    const { server, cache, app } = await load();
    fill(cache);
    server.ledgerFailure = 500;
    await app.loadLedgerForCustomer(id.priya);
    const status = app.getLedgerStatus(id.priya);
    expect(status.state).toBe('failed');
    expect(status.message).toMatch(/Could not|try again/i);
    expect(app.getLedgerForCustomer(id.priya)).toEqual([]);
  });
});

describe("preview build: the ledger is the prototype's own, kept in this browser", () => {
  it('reads its sample ledger and calls no server', async () => {
    const { server, app } = await load({ preview: true });
    const first = app.getCustomers()[0];
    expect(Array.isArray(app.getLedgerForCustomer(first.id))).toBe(true);
    await app.loadLedgerForCustomer(first.id);
    const stop = app.watchCustomerLedger(first.id);
    expect(app.getLedgerStatus(first.id).state).toBe('ready');
    stop();
    expect(server.seen).toEqual([]);
  });
});
