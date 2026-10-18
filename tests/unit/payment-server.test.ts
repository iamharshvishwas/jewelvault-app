// WEB09 (spec C5 (b), C6, C7, C17, L5; plan test PT-W9, unit half): the network side of the payment and silver-fine panels, `recordPayment` (X2) and `settleFine` (X3) in
// src/lib/cache/moneyServer.ts, and `savePayment` / `saveFineSettlement` / `getBillsOfCustomer` / `getCustomerBooks` of appStore.ts.
//
//   T-E06  (unit half) one Idempotency-Key for each user action: a double click is one request; pressing Save again for the same payment after a call that did not end well sends the
//          SAME key and the server answers the stored payment (one receipt); another payment is another action; a second identical payment after the first was made is a new one
//   C5 (b) nothing is put in memory before the API has answered, and then only the rows X2 and X3 returned (the receipt and its allocations)
//   C17    (C4) the client says when a write is over, success or not: the poller polls at once and brings that customer's bill_summary and customer_balances rows
//   T-E03  (clause) a gateway error followed by a normal reply shows "Waking up…" and the call is retried with the same key: one receipt
//
// The fake server is tests/unit/support/payment-server.ts, spoken to through the REAL client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, isApiError, type ApiError } from '@/lib/api/client';
import { createRowCache } from '@/lib/cache/cache';
import { createMoneyServer } from '@/lib/cache/moneyServer';
import type { RecordPaymentBody, SettleFineBody } from '@/lib/payments';
import { FakePaymentApi } from './support/payment-server';
import { customerRow, fill, id } from './support/money-rows';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const other = '00000000-0000-4000-8000-0000000c0002';

const pay = (amount = '600.00', over: Partial<RecordPaymentBody> = {}): RecordPaymentBody => ({
  amount,
  mode: 'UPI',
  ...over,
});
const fine = (grams = '10.000', over: Partial<SettleFineBody> = {}): SettleFineBody => ({
  grams,
  mode: 'Silver',
  ...over,
});

function world(options: { sleeps?: Array<() => void> } = {}) {
  const server = new FakePaymentApi();
  // Priya owes 1,000.00 (oldest, JV-0001) and 700.00 (JV-0002), and 25.000 g of silver on the second
  server.openBill(id.priya, 1, 100000);
  server.openBill(id.priya, 2, 70000, 25000);
  server.openBill(other, 3, 50000, 5000);
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch as unknown as typeof fetch,
    // the waits of "Waking up…" cost no time here; a test may look at the banner while the client waits
    sleep: async () => {
      for (const look of options.sleeps ?? []) look();
    },
  });
  const cache = createRowCache();
  const hooks: Array<() => void> = [];
  const money = createMoneyServer({
    api,
    cache,
    registerLogoutHook: (hook) => {
      hooks.push(hook);
      return () => void hooks.splice(hooks.indexOf(hook), 1);
    },
  });
  const logout = () => hooks.forEach((hook) => hook());
  cache.merge('customers', [customerRow(id.priya), customerRow(other, { name: 'Other' })]);
  const writes: number[] = [];
  api.onWriteFinished(() => writes.push(Date.now()));
  return { server, api, cache, money, logout, writes };
}

// an ApiError of the client this file imported, or of a fresh copy of the modules (the store cases reset them): told by its name
const failure = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error) || (error instanceof Error && error.name === 'ApiError'))
      return error as ApiError;
    throw error;
  }
  throw new Error('the call was expected to fail');
};

// ------------------------------------------------------------------------------------------------ T-E06

describe('T-E06 (unit half; C6, L5): one Idempotency-Key for each payment', () => {
  it('a fresh key, the CSRF header, a JSON body of text, and the customer in the path', async () => {
    const { server, money } = world();
    const answer = await money.recordPayment(id.priya, pay());
    const call = server.seen[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/v1/customers/${id.priya}/payments`);
    expect(call.key).toMatch(KEY);
    expect(call.header['x-jv-client']).toBe('web');
    expect(call.header['content-type']).toBe('application/json');
    expect(call.body).toEqual({ amount: '600.00', mode: 'UPI' });
    expect(answer.advance_remaining).toBe('0.00');
    expect(server.receipts).toHaveLength(1);
  });

  it('a double click is ONE request, one key and one receipt, and both clicks get the same answer', async () => {
    const { server, money } = world();
    const [first, second] = await Promise.all([
      money.recordPayment(id.priya, pay()),
      money.recordPayment(id.priya, pay()),
    ]);
    expect(server.count()).toBe(1);
    expect(server.receipts).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('the answer is lost after the server saved: Save again sends the SAME key, the server replays, and there is still ONE receipt', async () => {
    const { server, money, cache } = world();
    server.dropAnswers = 1;
    const lost = await failure(money.recordPayment(id.priya, pay()));
    expect(lost.code).toBe('NETWORK');
    expect(lost.message).toBe('Could not confirm that this was saved.');
    expect(lost.idempotencyKey).toMatch(KEY);
    expect(server.receipts).toHaveLength(1); // it was saved; the screen did not know
    expect(cache.count('receipts')).toBe(0); // and so shows nothing

    const again = await money.recordPayment(id.priya, pay()); // the same payment, pressed again
    const keys = server.seen.map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(again.receipt.id).toBe(server.receipts[0].id);
    expect(server.receipts).toHaveLength(1);
    expect(cache.count('receipts')).toBe(1);
  });

  it('the same payment typed another way ("600" and "600.00" are one body) is the same action', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay('600.00')));
    await money.recordPayment(id.priya, { mode: 'UPI', amount: '600.00' }); // keys written in another order
    expect(server.seen[1].key).toBe(server.seen[0].key);
    expect(server.receipts).toHaveLength(1);
  });

  it('a payment that was changed is another action: its key is new', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay('600.00')));
    await money.recordPayment(id.priya, pay('650.00'));
    expect(server.seen[1].key).toMatch(KEY);
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
    expect(server.receipts).toHaveLength(2); // the first was saved and its answer lost; the second is a payment of its own
  });

  it('after a payment was made, the next one, even an identical one, has a key of its own (a second payment of 600 is a second payment)', async () => {
    const { server, money } = world();
    await money.recordPayment(id.priya, pay());
    await money.recordPayment(id.priya, pay());
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
    expect(server.receipts).toHaveLength(2);
  });

  it('the panel being closed forgets the key of a payment that could not be confirmed', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay()));
    money.forgetPaymentTries();
    await money.recordPayment(id.priya, pay());
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
  });

  it('a refusal before any write keeps the key for the same payment, and the retry is answered as a first call (nothing was used up)', async () => {
    const { server, money } = world();
    server.refuse = {
      code: 'JV_CASH_LIMIT',
      status: 409,
      details: { limit: '200000.00' },
      times: 1,
    };
    const refused = await failure(money.recordPayment(id.priya, pay('600.00', { mode: 'Cash' })));
    expect(refused.code).toBe('JV_CASH_LIMIT');
    expect(refused.nothingChanged).toBe(true);
    expect(server.receipts).toHaveLength(0);
    await money.recordPayment(id.priya, pay('600.00', { mode: 'Cash' }));
    expect(server.seen[1].key).toBe(server.seen[0].key);
    expect(server.receipts).toHaveLength(1);
  });

  it('the owner adding a reason after a cash-limit refusal is another action: a key of its own', async () => {
    const { server, money } = world();
    server.refuse = { code: 'JV_CASH_LIMIT', status: 409, details: {}, times: 1 };
    await failure(money.recordPayment(id.priya, pay('600.00', { mode: 'Cash' })));
    await money.recordPayment(
      id.priya,
      pay('600.00', { mode: 'Cash', cash_override_reason: 'Wedding order, paid in cash' })
    );
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
    expect(server.receipts[0].cash_override_reason).toBe('Wedding order, paid in cash');
  });

  it('the same payment for ANOTHER customer is another action: one key never pays two customers', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay()));
    await money.recordPayment(other, pay()); // the same body, the other customer
    expect(server.seen[1].path).toBe(`/v1/customers/${other}/payments`);
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
    expect(server.receipts).toHaveLength(2);
    expect(server.receipts.map((r) => r.customer_id)).toEqual([id.priya, other]);
  });

  it('a payment and a silver settlement do not share a key', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay()));
    await money.settleFine(id.priya, fine());
    expect(server.seen[1].path).toBe(`/v1/customers/${id.priya}/fine-settlements`);
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
  });
});

// ------------------------------------------------------------------------------------------------ X2 rules the screen relies on

describe('PT-W9 (unit half; X2, Y3, Y5, K5): what the API returns for a payment is what the screen shows', () => {
  it('600 on a named bill of 1,000: one allocation, nothing kept as advance', async () => {
    const { server, money } = world();
    const first = server.bills.get(id.priya)![0];
    const answer = await money.recordPayment(id.priya, pay('600.00', { bill_id: first.row.id }));
    expect(answer.allocations.map((a) => [a.bill_id, a.amount])).toEqual([
      [first.row.id, '600.00'],
    ]);
    expect(answer.advance_remaining).toBe('0.00');
  });

  it('2,000 with no bill named goes oldest first and the remainder is the advance', async () => {
    const { server, money } = world();
    const [oldest, next] = server.bills.get(id.priya)!;
    const answer = await money.recordPayment(id.priya, pay('2000.00'));
    expect(answer.allocations.map((a) => [a.bill_id, a.amount])).toEqual([
      [oldest.row.id, '1000.00'],
      [next.row.id, '700.00'],
    ]);
    expect(answer.advance_remaining).toBe('300.00');
  });

  it('the walk-in without a named bill is refused with JV_OVERPAYMENT on bill_id, nothing is saved and nothing is merged', async () => {
    const { server, money, cache } = world();
    server.walkIns.add(other);
    const before = cache.count('receipts');
    const refused = await failure(money.recordPayment(other, pay()));
    expect(refused.code).toBe('JV_OVERPAYMENT');
    expect(refused.details).toMatchObject({ field: 'bill_id' });
    expect(server.receipts).toHaveLength(0);
    expect(cache.count('receipts')).toBe(before);
  });
});

// ------------------------------------------------------------------------------------------------ C5 (b)

describe('C5 (b): a payment never shows saved before the API says so, and then only what the function returned', () => {
  it('nothing is in memory while the call is on its way', async () => {
    const { server, money, cache } = world();
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const call = money.recordPayment(id.priya, pay());
    await vi.waitFor(() => expect(server.count()).toBe(1));
    expect(cache.count('receipts')).toBe(0);
    expect(cache.count('receipt-allocations')).toBe(0);
    release();
    await call;
  });

  it('then the receipt and the allocations are merged as returned; V1 and V2 are not made up (they arrive with the poll)', async () => {
    const { money, cache } = world();
    const answer = await money.recordPayment(id.priya, pay('2000.00'));
    expect(cache.get('receipts', answer.receipt.id)).toEqual(answer.receipt);
    expect(cache.count('receipt-allocations')).toBe(2);
    expect(cache.count('bill-summary')).toBe(0);
    expect(cache.count('customer-balances')).toBe(0);
  });

  it('a failed save puts nothing in memory', async () => {
    const { server, money, cache } = world();
    server.refuse = { code: 'JV_OVERPAYMENT', status: 409, details: {}, times: 1 };
    await failure(money.recordPayment(id.priya, pay()));
    expect(cache.size()).toBe(2); // the two customers the case started with
  });

  it('a logout while the call is on its way: nothing is put back, and the key is forgotten (U8)', async () => {
    const { server, money, cache, logout } = world();
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const call = money.recordPayment(id.priya, pay());
    await vi.waitFor(() => expect(server.count()).toBe(1));
    logout();
    release();
    await call;
    expect(cache.count('receipts')).toBe(0);
    // a lost answer after a logout leaves no key behind either
    server.hold = null;
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay('650.00')));
    logout();
    await money.recordPayment(id.priya, pay('650.00'));
    expect(server.seen[server.seen.length - 1].key).not.toBe(
      server.seen[server.seen.length - 2].key
    );
  });
});

// ------------------------------------------------------------------------------------------------ C17

describe('C17 (C4): after any write that touches money the client says so, success or not, so that the poller reads the customer at once', () => {
  it('a payment that was made: the write-finished hook runs once', async () => {
    const { money, writes } = world();
    await money.recordPayment(id.priya, pay());
    expect(writes).toHaveLength(1);
  });

  it('a payment that was refused: it runs once, too (the person must see the books as they are)', async () => {
    const { server, money, writes } = world();
    server.refuse = { code: 'JV_CASH_LIMIT', status: 409, details: {}, times: 1 };
    await failure(money.recordPayment(id.priya, pay()));
    expect(writes).toHaveLength(1);
  });

  it('a payment whose answer was lost: it runs once, so the books are read to see whether it was saved', async () => {
    const { server, money, writes } = world();
    server.dropAnswers = 1;
    await failure(money.recordPayment(id.priya, pay()));
    expect(writes).toHaveLength(1);
  });

  it('a silver settlement: it runs once', async () => {
    const { money, writes } = world();
    await money.settleFine(id.priya, fine());
    expect(writes).toHaveLength(1);
  });

  it('a double click is one call and one hook run', async () => {
    const { money, writes } = world();
    await Promise.all([money.recordPayment(id.priya, pay()), money.recordPayment(id.priya, pay())]);
    expect(writes).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ T-E03

describe('T-E03 (clause; C7, L5): a money call retried during "Waking up…" with the same key saves once', () => {
  it("a proxy's 502 page before the API has seen the call: the banner says Waking up…, the retry carries the same key, one receipt, and the banner clears", async () => {
    const seen: string[] = [];
    const w = world({ sleeps: [() => seen.push(w.api.getConnectionStatus())] });
    w.server.gatewayBefore = 2;
    const answer = await w.money.recordPayment(id.priya, pay());
    expect(seen).toEqual(['waking', 'waking']);
    expect(w.api.getConnectionStatus()).toBe('ok');
    expect(w.server.count()).toBe(3);
    expect(new Set(w.server.seen.map((c) => c.key)).size).toBe(1);
    expect(w.server.receipts).toHaveLength(1);
    expect(answer.receipt.id).toBe(w.server.receipts[0].id);
  });

  it("the payment was saved and THEN the proxy answered 502: the retry with the same key is answered from the server's store, still one receipt", async () => {
    const seen: string[] = [];
    const w = world({ sleeps: [() => seen.push(w.api.getConnectionStatus())] });
    w.server.gatewayAfter = 1;
    const answer = await w.money.recordPayment(id.priya, pay('500.00'));
    expect(seen).toEqual(['waking']);
    expect(w.server.count()).toBe(2);
    expect(w.server.seen[1].key).toBe(w.server.seen[0].key);
    expect(w.server.receipts).toHaveLength(1);
    expect(answer.allocations).toHaveLength(1);
  });

  it('a gateway that stays down ends as "could not confirm" and keeps the key for the next Save', async () => {
    const w = world();
    w.server.gatewayBefore = 99;
    const down = await failure(w.money.recordPayment(id.priya, pay()));
    expect(down.code).toBe('GATEWAY');
    expect(down.message).toBe('Could not confirm that this was saved.');
    w.server.gatewayBefore = 0;
    await w.money.recordPayment(id.priya, pay());
    expect(new Set(w.server.seen.map((c) => c.key)).size).toBe(1);
    expect(w.server.receipts).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ X3

describe('T-E06 (unit half) and T-B11, T-B12, T-B13 (screen half): settle_fine', () => {
  it('10 g in silver: the path, a fresh key, the body of text, the fine remaining of the API, and the rows merged', async () => {
    const { server, money, cache } = world();
    const answer = await money.settleFine(id.priya, fine('10.000'));
    const call = server.seen[0];
    expect(call.path).toBe(`/v1/customers/${id.priya}/fine-settlements`);
    expect(call.key).toMatch(KEY);
    expect(call.body).toEqual({ grams: '10.000', mode: 'Silver' });
    expect(answer.fine_remaining).toBe('15.000');
    expect(cache.get('receipts', answer.receipt.id)).toEqual(answer.receipt);
    expect(cache.count('receipt-allocations')).toBe(1);
  });

  it('5 g in cash at 80.00: a fine_cash receipt of 400.00 at the rate', async () => {
    const { money } = world();
    const answer = await money.settleFine(
      id.priya,
      fine('5.000', { mode: 'Cash', silver_rate: '80.00' })
    );
    expect(answer.receipt.kind).toBe('fine_cash');
    expect(answer.receipt.amount).toBe('400.00');
    expect(answer.receipt.silver_rate).toBe('80.00');
    expect(answer.fine_remaining).toBe('20.000');
  });

  it('more than is owed is JV_FINE_EXCEEDS with the maximum, nothing is saved, and the key is kept for the same grams', async () => {
    const { server, money, cache } = world();
    const refused = await failure(money.settleFine(id.priya, fine('30.000')));
    expect(refused.code).toBe('JV_FINE_EXCEEDS');
    expect(refused.details).toMatchObject({ max_grams: '25.000' });
    expect(refused.nothingChanged).toBe(true);
    expect(server.receipts).toHaveLength(0);
    expect(cache.count('receipts')).toBe(0);
    await failure(money.settleFine(id.priya, fine('30.000')));
    expect(server.seen[1].key).toBe(server.seen[0].key);
    await money.settleFine(id.priya, fine('25.000')); // lowered: another action
    expect(server.seen[2].key).not.toBe(server.seen[0].key);
  });

  it("the walk-in must name the bill: refused without one, accepted with it and only up to that bill's fine", async () => {
    const { server, money } = world();
    server.walkIns.add(other);
    const unnamed = await failure(money.settleFine(other, fine('1.000')));
    expect(unnamed.code).toBe('JV_FINE_EXCEEDS');
    expect(unnamed.details).toMatchObject({ field: 'bill_id' });
    const billId = server.bills.get(other)![0].row.id;
    const tooMuch = await failure(money.settleFine(other, fine('6.000', { bill_id: billId })));
    expect(tooMuch.details).toMatchObject({ field: 'grams', max_grams: '5.000' });
    const answer = await money.settleFine(other, fine('5.000', { bill_id: billId }));
    expect(answer.fine_remaining).toBe('0.000');
  });

  it('the answer is lost after the server saved: Save again sends the SAME key, one receipt', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.settleFine(id.priya, fine()));
    await money.settleFine(id.priya, fine());
    expect(server.seen[1].key).toBe(server.seen[0].key);
    expect(server.receipts).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ appStore

async function storeWorld({ preview = false } = {}) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', preview ? '1' : '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4229');
  const server = new FakePaymentApi();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    server.fetch(input, init)
  );
  const [cacheModule, app] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
  ]);
  return { server, cache: cacheModule.rowCache, app };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('appStore.savePayment and saveFineSettlement (C5 (b), L5)', () => {
  it('send X2 and X3 and merge what they return; the same payment pressed again after a lost answer is the same key', async () => {
    const w = await storeWorld();
    w.server.openBill(id.priya, 1, 100000, 5000);
    w.server.dropAnswers = 1;
    const lost = await failure(w.app.savePayment(id.priya, pay()));
    expect(lost.idempotencyKey).toMatch(KEY);
    const saved = await w.app.savePayment(id.priya, pay());
    expect(w.server.seen[1].key).toBe(w.server.seen[0].key);
    expect(w.server.receipts).toHaveLength(1);
    expect(w.cache.get('receipts', saved.receipt.id)).toEqual(saved.receipt);
    const settled = await w.app.saveFineSettlement(id.priya, fine('2.000'));
    expect(settled.fine_remaining).toBe('3.000');
    w.app.forgetPaymentTries();
  });

  it("a preview build has no server: both reject, and the panel saves the prototype's own entry", async () => {
    const w = await storeWorld({ preview: true });
    await expect(w.app.savePayment(id.priya, pay())).rejects.toThrow(/cannot be saved yet/);
    await expect(w.app.saveFineSettlement(id.priya, fine())).rejects.toThrow(/cannot be saved yet/);
    expect(w.server.seen).toHaveLength(0);
  });
});

describe('the lists the panel chooses a bill from (Y3): getBillsOfCustomer', () => {
  it('holds every bill of the customer, the opening-balance bill and the cancelled one included, oldest first; V1 decides what is pending', async () => {
    const w = await storeWorld();
    fill(w.cache);
    const bills = w.app.getBillsOfCustomer(id.priya);
    expect(bills.map((b) => b.invoiceNumber)).toEqual([
      'OB-0001', // 2026-10-01
      'JV-0004', // 2026-10-14
      'JV-0001', // 2026-10-15 (made first)
      'JV-0002',
      'JV-0003',
      'JV-0005',
    ]);
    // the sales list of the customer card leaves the opening-balance bill out (C14); the panel must not
    expect(w.app.getInvoices().some((i) => i.invoiceNumber === 'OB-0001')).toBe(false);
    const pending = Object.fromEntries(bills.map((b) => [b.invoiceNumber, b.pendingAmount]));
    expect(pending['OB-0001']).toBe(20000);
    expect(pending['JV-0004']).toBe(12000);
    expect(pending['JV-0003']).toBe(0);
  });

  it('is empty for a customer with no bills and before the hydrate', async () => {
    const w = await storeWorld();
    expect(w.app.getBillsOfCustomer(id.priya)).toEqual([]);
    fill(w.cache);
    expect(w.app.getBillsOfCustomer('00000000-0000-4000-8000-00000000dead')).toEqual([]);
  });
});

describe("getCustomerBooks: the customer's V2 figures as the server worked them out", () => {
  it('gives the outstanding, the advance, the balance and the silver outstanding and balance as the exact text of the row', async () => {
    const w = await storeWorld();
    const book = fill(w.cache);
    const row = book.balances.find((b) => b.id === id.priya)!;
    const books = w.app.getCustomerBooks(id.priya);
    expect(books).toEqual({
      outstanding: row.outstanding,
      advance: row.advance,
      balance: row.balance, // WEB10: the card shows it, and it is the last running balance of the ledger (I4)
      fineOutstanding: row.fine_outstanding,
      fineBalance: row.fine_balance,
    });
  });

  it('is null when the row has not arrived yet (nothing is made up)', async () => {
    const w = await storeWorld();
    expect(w.app.getCustomerBooks(id.priya)).toBeNull();
  });
});

describe('billNumberOf: the number of a bill the answer names', () => {
  it('is the number in memory, or null for a bill that is not there', async () => {
    const w = await storeWorld();
    const book = fill(w.cache);
    expect(w.app.billNumberOf(book.by.pending.bill.id)).toBe('JV-0004');
    expect(w.app.billNumberOf('00000000-0000-4000-8000-00000000dead')).toBeNull();
  });
});
