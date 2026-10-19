// WEB08 (spec C5 (b), C6, C7, L5): the network side of the billing screen, `createBill` in src/lib/cache/moneyServer.ts, and `saveBill` / `saveCustomerPan` of appStore.ts.
//
//   T-E06  (unit half) one Idempotency-Key for each user action: a double click is one request; pressing Save again for the same bill after a call that did not end well sends the
//          SAME key and the server answers the stored bill (one bill); a bill that was changed is another action and has a key of its own
//   C5 (b) nothing is put in memory before the API has answered, and then only the rows X1 returned
//   T-E03  (clause) a gateway error followed by a normal reply shows "Waking up…" and the call is retried with the same key: one bill
//   Z3     the PAN a bill asked for is an ordinary edit of the customer; the customer was touched by the bill, so a stale answer is retried once on the current row
//
// The fake server is tests/unit/support/bill-server.ts, spoken to through the REAL client.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient, isApiError, type ApiError } from '@/lib/api/client';
import { createRowCache } from '@/lib/cache/cache';
import { createMoneyServer } from '@/lib/cache/moneyServer';
import { newBillingItem, buildBillBody, type BillBody } from '@/lib/billing';
import type { Sku } from '@/lib/mockData';
import { FakeBillApi, refusal } from './support/bill-server';
import { FakeEditServer } from './support/editServer';
import { customerRow, id } from './support/money-rows';
import { at, uuid } from './support/rows';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// ------------------------------------------------------------------------------------------------ a piece and a bill

const sku = (n: number, over: Partial<Sku> = {}): Sku => ({
  id: uuid(1000 + n),
  skuNumber: `RING-00001-${String(n).padStart(3, '0')}`,
  designId: uuid(300),
  designNumber: 'RING-00001',
  grossWeight: 38.1,
  originalNetWeight: 0,
  customerNetWeight: 35.42,
  stones: 0,
  stoneWeight: 0,
  kundan: 0,
  kundanWeight: 0,
  piroi: 2.15,
  labour: 353,
  retailLabour: 353,
  semiWholesaleLabour: 340,
  wholesaleLabour: 320,
  status: 'In Stock',
  location: 'Main Showroom',
  barcode: `BC${n}`,
  createdAt: '2026-10-15T09:00:00.000Z',
  createdBy: '',
  notes: '',
  sellingMethod: 'By Weight',
  purity: '22K',
  material: 'Gold',
  category: 'Ring',
  subcategory: '',
  ...over,
});

/** The body of the worked example (35.42 g at 6,920, labour 353, piroi 2.15) for piece number `n`, with an optional payment. */
function body(n = 1, over: { rate?: string; pay?: string } = {}): BillBody {
  const line = {
    ...newBillingItem(sku(n), {
      saleType: 'Retail',
      billDate: '2026-10-15',
      rates: [{ material: 'Gold', purity: '22K', ratePerGram: '6920.00', rateDate: '2026-10-15' }],
    }),
    metalRate: over.rate ?? '6920.00',
  };
  const made = buildBillBody({
    customerId: id.priya,
    saleType: 'Retail',
    billDate: '2026-10-15',
    items: [line],
    discount: '',
    additionalCharges: '',
    notes: '',
    payments: over.pay ? [{ id: 'p', mode: 'UPI', amount: over.pay }] : [],
    cashOverrideReason: '',
  });
  if (!('body' in made)) throw new Error(made.error);
  return made.body;
}

function world(options: { sleeps?: Array<() => void> } = {}) {
  const server = new FakeBillApi();
  for (let n = 1; n <= 4; n += 1) {
    const piece = sku(n);
    server.pieces.set(piece.id, {
      sku_no: piece.skuNumber,
      material: 'Gold',
      purity: '22K',
      selling_method: 'By Weight',
      weightMg: 35420,
    });
  }
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
  cache.merge('customers', [customerRow(id.priya)]);
  return { server, api, cache, money, logout };
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

describe('T-E06 (unit half; C6, L5): one Idempotency-Key for each user action', () => {
  it('a fresh key for a bill, carried with the CSRF header, a JSON body of text, and the customer to re-read', async () => {
    const { server, money } = world();
    const answer = await money.createBill(body());
    expect(answer.bill.bill_no).toBe('JV-0001');
    expect(server.count()).toBe(1);
    const call = server.seen[0];
    expect(call.key).toMatch(KEY);
    expect(call.header['x-jv-client']).toBe('web');
    expect(call.header['content-type']).toBe('application/json');
    expect(call.body?.items[0].metal_rate).toBe('6920.00');
    expect(server.bills).toHaveLength(1);
  });

  it('a double click is ONE request, one key and one bill, and both clicks get the same answer', async () => {
    const { server, money } = world();
    const [first, second] = await Promise.all([money.createBill(body()), money.createBill(body())]);
    expect(server.count()).toBe(1);
    expect(server.bills).toHaveLength(1);
    expect(second).toBe(first);
  });

  it('the answer is lost after the server saved: Save again sends the SAME key, the server replays, and there is still ONE bill', async () => {
    const { server, money, cache } = world();
    server.dropAnswers = 1;
    const lost = await failure(money.createBill(body()));
    expect(lost.code).toBe('NETWORK');
    expect(lost.message).toBe('Could not confirm that this was saved.');
    expect(lost.idempotencyKey).toMatch(KEY);
    expect(server.bills).toHaveLength(1); // it was saved; the screen did not know
    expect(cache.count('bills')).toBe(0); // and so shows nothing

    const again = await money.createBill(body()); // the same bill, pressed again
    const keys = server.seen.map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(again.bill.id).toBe(server.bills[0].bill.id);
    expect(server.bills).toHaveLength(1);
    expect(cache.count('bills')).toBe(1);
  });

  it('a bill that was changed is another action: its key is new, and the first bill is not asked for again', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.createBill(body(1)));
    const keyOfFirst = server.seen[0].key;
    await money.createBill(body(2, { pay: '1000' })); // another piece and a payment: not the same bill
    expect(server.seen[1].key).toMatch(KEY);
    expect(server.seen[1].key).not.toBe(keyOfFirst);
    expect(server.bills).toHaveLength(2); // the first was saved and its answer lost; the second is a bill of its own
  });

  it('after a bill was saved the next bill, even an identical one, has a key of its own', async () => {
    const { server, money } = world();
    await money.createBill(body());
    await failure(money.createBill(body())); // the same piece again: refused by the server
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
  });

  it('a new sale forgets the key of a bill that could not be confirmed', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.createBill(body()));
    money.forgetBill();
    await failure(money.createBill(body())); // a new key: the server has the piece on a bill already, and says so
    expect(server.seen[1].key).toMatch(KEY);
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
  });

  it('a refusal before any write keeps the key for the same bill, and the retry is answered as a first call (nothing was used up)', async () => {
    const { server, money } = world();
    server.refuse = {
      code: 'JV_CASH_LIMIT',
      status: 409,
      details: { limit: '200000.00' },
      times: 1,
    };
    const refused = await failure(money.createBill(body()));
    expect(refused.code).toBe('JV_CASH_LIMIT');
    expect(refused.nothingChanged).toBe(true);
    expect(server.bills).toHaveLength(0);
    await money.createBill(body());
    expect(server.seen[1].key).toBe(server.seen[0].key);
    expect(server.bills).toHaveLength(1);
  });

  it('a piece sold meanwhile is refused with the pieces named, nothing is merged, and the person can take it off and save', async () => {
    const { server, money, cache } = world();
    await money.createBill(body(1)); // another biller's bill
    cache.clear();
    const refused = await failure(money.createBill(body(1)));
    expect(refused.code).toBe('JV_PIECE_UNAVAILABLE');
    expect(refused.details).toMatchObject({
      pieces: [{ sku_no: 'RING-00001-001', status: 'Sold' }],
    });
    expect(cache.count('bills')).toBe(0);
    expect(server.bills).toHaveLength(1);
    await money.createBill(body(2)); // without that piece
    expect(server.bills).toHaveLength(2);
  });
});

describe('C5 (b): a bill never shows saved before the API says so, and then only what the function returned', () => {
  it('nothing is in memory while the call is on its way', async () => {
    const { server, money, cache } = world();
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const call = money.createBill(body(1, { pay: '1000' }));
    await vi.waitFor(() => expect(server.count()).toBe(1));
    expect(cache.count('bills')).toBe(0);
    expect(cache.count('bill-items')).toBe(0);
    expect(cache.count('receipts')).toBe(0);
    release();
    await call;
  });

  it('then the bill, its lines, the receipts and the allocations of the payment rows are merged as returned', async () => {
    const { money, cache } = world();
    const answer = await money.createBill(body(1, { pay: '1000' }));
    expect(cache.get('bills', answer.bill.id)).toEqual(answer.bill);
    expect(cache.count('bill-items')).toBe(1);
    expect(cache.count('receipts')).toBe(1);
    expect(cache.count('receipt-allocations')).toBe(1);
    expect(cache.count('bill-summary')).toBe(0); // V1 and the pieces come with the poll that follows every write
    expect(cache.count('skus')).toBe(0);
  });

  it('a failed save puts nothing in memory', async () => {
    const { server, money, cache } = world();
    server.refuse = { code: 'JV_OVERPAYMENT', status: 409, details: {}, times: 1 };
    await failure(money.createBill(body()));
    expect(cache.size()).toBe(1); // the customer the case started with
  });

  it('a logout while the call is on its way: nothing is put back, and the key is forgotten (U8)', async () => {
    const { server, money, cache, logout } = world();
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const call = money.createBill(body());
    await vi.waitFor(() => expect(server.count()).toBe(1));
    logout();
    release();
    await call;
    expect(cache.count('bills')).toBe(0);
    // a lost answer after a logout leaves no key behind either
    server.hold = null;
    server.dropAnswers = 1;
    await failure(money.createBill(body(2)));
    logout();
    await failure(money.createBill(body(2))); // a key of its own: the piece is on a bill already, and the server says so
    expect(server.seen[server.seen.length - 1].key).not.toBe(
      server.seen[server.seen.length - 2].key
    );
  });
});

// ------------------------------------------------------------------------------------------------ T-E03

describe('T-E03 (clause; C7, L5): a money call retried during "Waking up…" with the same key saves once', () => {
  it("a proxy's 502 page before the API has seen the call: the banner says Waking up…, the retry carries the same key, one bill, and the banner clears", async () => {
    const seen: string[] = [];
    const w = world({ sleeps: [() => seen.push(w.api.getConnectionStatus())] });
    w.server.gatewayBefore = 2;
    const answer = await w.money.createBill(body());
    expect(seen).toEqual(['waking', 'waking']);
    expect(w.api.getConnectionStatus()).toBe('ok');
    expect(w.server.count()).toBe(3);
    expect(new Set(w.server.seen.map((c) => c.key)).size).toBe(1);
    expect(w.server.bills).toHaveLength(1);
    expect(answer.bill.id).toBe(w.server.bills[0].bill.id);
  });

  it("the bill was saved and THEN the proxy answered 502: the retry with the same key is answered from the server's store, still one bill", async () => {
    const seen: string[] = [];
    const w = world({ sleeps: [() => seen.push(w.api.getConnectionStatus())] });
    w.server.gatewayAfter = 1;
    const answer = await w.money.createBill(body(1, { pay: '500' }));
    expect(seen).toEqual(['waking']);
    expect(w.server.count()).toBe(2);
    expect(w.server.seen[1].key).toBe(w.server.seen[0].key);
    expect(w.server.bills).toHaveLength(1);
    expect(w.server.bills[0].receipts).toHaveLength(1);
    expect(answer.receipts).toHaveLength(1);
  });

  it('a gateway that stays down ends as "could not confirm" and keeps the key for the next Save', async () => {
    const w = world();
    w.server.gatewayBefore = 99;
    const down = await failure(w.money.createBill(body()));
    expect(down.code).toBe('GATEWAY');
    expect(down.message).toBe('Could not confirm that this was saved.');
    w.server.gatewayBefore = 0;
    await w.money.createBill(body());
    expect(new Set(w.server.seen.map((c) => c.key)).size).toBe(1);
    expect(w.server.bills).toHaveLength(1);
  });
});

// ------------------------------------------------------------------------------------------------ appStore: saveBill, saveCustomerPan

let counter = 0;
async function storeWorld() {
  vi.resetModules();
  counter += 1;
  vi.stubEnv('NEXT_PUBLIC_API_URL', 'http://localhost:4229');
  const bills = new FakeBillApi();
  const edits = new FakeEditServer();
  vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) =>
    String(input).includes('/v1/bills') ? bills.fetch(input, init) : edits.fetch(input, init)
  );
  const [cacheModule, app] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/appStore'),
  ]);
  return { bills, edits, cache: cacheModule.rowCache, app, counter };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('appStore.saveBill (C5 (b), L5)', () => {
  it('sends X1 and merges what it returns; the same bill pressed again after a lost answer is the same key', async () => {
    const w = await storeWorld();
    const piece = sku(1);
    w.bills.pieces.set(piece.id, {
      sku_no: piece.skuNumber,
      material: 'Gold',
      purity: '22K',
      selling_method: 'By Weight',
      weightMg: 35420,
    });
    w.bills.dropAnswers = 1;
    const lost = await failure(w.app.saveBill(body()));
    expect(lost.idempotencyKey).toMatch(KEY);
    const saved = await w.app.saveBill(body());
    expect(w.bills.seen[1].key).toBe(w.bills.seen[0].key);
    expect(w.bills.bills).toHaveLength(1);
    expect(w.cache.get('bills', saved.bill.id)).toEqual(saved.bill);
    w.app.forgetBillTry();
  });
});

describe('Z3: saveCustomerPan', () => {
  const customer = customerRow(id.priya, { updated_at: at(5, 100) });

  it('writes the PAN as an ordinary edit of the customer, with only that field and the stamp the row has', async () => {
    const w = await storeWorld();
    w.cache.merge('customers', [customer]);
    w.edits.seed('customers', { ...customer });
    await w.app.saveCustomerPan(id.priya, 'ABCDE1234F');
    expect(w.edits.calls).toHaveLength(1);
    expect(w.edits.calls[0].method).toBe('PATCH');
    expect(w.edits.calls[0].path).toBe(`/v1/customers/${id.priya}`);
    expect(w.edits.calls[0].body).toEqual({
      expected_updated_at: customer.updated_at,
      changes: { pan: 'ABCDE1234F' },
    });
    expect(w.cache.get('customers', id.priya)?.pan).toBe('ABCDE1234F');
  });

  it('a bill touches its customer, so the stamp in memory can be old: the stale answer is retried ONCE on the current row', async () => {
    const w = await storeWorld();
    w.cache.merge('customers', [customer]);
    w.edits.seed('customers', { ...customer });
    const touchedAt = w.edits.changeElsewhere('customers', id.priya, {}).updated_at; // the bill's touch
    await w.app.saveCustomerPan(id.priya, 'ABCDE1234F');
    expect(w.edits.calls).toHaveLength(2);
    expect(w.edits.calls[0].body?.expected_updated_at).toBe(customer.updated_at);
    expect(w.edits.calls[1].body).toEqual({
      expected_updated_at: touchedAt,
      changes: { pan: 'ABCDE1234F' },
    });
    expect(w.cache.get('customers', id.priya)?.pan).toBe('ABCDE1234F');
  });

  it('a refusal that is not "stale" is not retried and says why', async () => {
    const w = await storeWorld();
    w.cache.merge('customers', [customer]);
    w.edits.seed('customers', { ...customer });
    w.edits.refuseNext(refusal('JV_INVALID_INPUT', 422, {}, 'pan is not a PAN'));
    await expect(w.app.saveCustomerPan(id.priya, 'ABCDE1234F')).rejects.toThrow(
      /PAN|not accepted/i
    );
    expect(w.edits.calls).toHaveLength(1);
    expect(w.cache.get('customers', id.priya)?.pan).toBeNull(); // rolled back
  });
});
