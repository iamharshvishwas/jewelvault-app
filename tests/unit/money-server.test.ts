// WEB07 (spec C3, C6, L5): the network side of the money store, `src/lib/cache/moneyServer.ts`. appStore.ts must import no client (C9, tests/unit/memory-reads.test.ts), so the two things the
// money side asks the server for live here and appStore reads what they leave in memory:
//   - X6 create_customer: a fresh Idempotency-Key for each customer the person saves, the SAME key for a retry of that action, one request for a double click, the returned row merged
//   - the customer ledger (V3): loaded per customer when a customer card opens, in pages the server's cap allows, and loaded again when that customer's `updated_at` changes
// The fake server is tests/unit/support/money-server.ts, spoken to through the REAL client.
import { describe, expect, it } from 'vitest';
import { createApiClient } from '@/lib/api/client';
import { createRowCache } from '@/lib/cache/cache';
import { createMoneyServer } from '@/lib/cache/moneyServer';
import { at } from './support/rows';
import { customerRow, id } from './support/money-rows';
import { FakeMoneyApi, ledgerRow } from './support/money-server';

function world() {
  const server = new FakeMoneyApi();
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch as unknown as typeof fetch,
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
  return { server, api, cache, money, logout, hooks };
}

const ledgerCalls = (server: FakeMoneyApi) =>
  server.seen.filter((c) => c.method === 'GET' && c.path === `/v1/customers/${id.priya}/ledger`);

const some = (n: number, customer = id.priya) =>
  Array.from({ length: n }, (_, i) => ledgerRow(i + 1, customer));

describe('the ledger of a customer is loaded when the card opens (C3, V3)', () => {
  it("reads every page the server's cap allows and keeps the rows in the order the server sent them", async () => {
    const { server, money } = world();
    server.ledgers.set(id.priya, some(2500));
    server.ledgerCap = 1000;
    expect(money.ledgerState(id.priya).state).toBe('idle');
    const loading = money.loadLedger(id.priya);
    expect(money.ledgerState(id.priya).state).toBe('loading');
    await loading;
    expect(money.ledgerState(id.priya)).toEqual({ state: 'ready', message: null });
    expect(money.ledgerRows(id.priya)).toHaveLength(2500);
    expect(money.ledgerRows(id.priya)[0].id).toBe(some(1)[0].id);
    expect(money.ledgerRows(id.priya)[2499].description).toBe('Invoice JV-2500');
    const calls = ledgerCalls(server);
    expect(calls).toHaveLength(3);
    expect(calls[0].query).toEqual({ limit: '1000' });
    expect(calls[1].query.after).toBeTruthy();
    expect(calls[2].query.after).not.toBe(calls[1].query.after);
    // a read, not a save: no key, no CSRF header
    expect(calls[0].key).toBeNull();
  });

  it('a customer with no events has an empty ledger and one call', async () => {
    const { server, money } = world();
    await money.loadLedger(id.priya);
    expect(money.ledgerRows(id.priya)).toEqual([]);
    expect(money.ledgerState(id.priya).state).toBe('ready');
    expect(ledgerCalls(server)).toHaveLength(1);
  });

  it('a second request for the same customer while one is on its way joins it', async () => {
    const { server, money } = world();
    server.ledgers.set(id.priya, some(3));
    await Promise.all([money.loadLedger(id.priya), money.loadLedger(id.priya)]);
    expect(ledgerCalls(server)).toHaveLength(1);
  });

  it('a failed load says so in plain words and keeps no half-read ledger; asking again works', async () => {
    const { server } = world();
    server.ledgers.set(id.priya, some(1500));
    server.ledgerCap = 1000;
    const real = server.fetch;
    let calls = 0;
    // the second page fails
    server.ledgerFailure = null;
    const failing = async (input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls === 2) server.ledgerFailure = 500;
      return real(input, init);
    };
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: failing as unknown as typeof fetch,
    });
    const cache = createRowCache();
    cache.merge('customers', [customerRow(id.priya)]);
    const broken = createMoneyServer({ api, cache, registerLogoutHook: () => () => undefined });
    await broken.loadLedger(id.priya);
    expect(broken.ledgerState(id.priya).state).toBe('failed');
    expect(broken.ledgerState(id.priya).message).toBeTruthy();
    expect(broken.ledgerRows(id.priya)).toEqual([]);
    await broken.loadLedger(id.priya);
    expect(broken.ledgerState(id.priya).state).toBe('ready');
    expect(broken.ledgerRows(id.priya)).toHaveLength(1500);
  });
});

describe("the ledger is loaded again when the customer's updated_at changes (C3)", () => {
  it('watching loads at once; an unrelated change does not load again; a newer stamp of that customer does', async () => {
    const { server, cache, money } = world();
    server.ledgers.set(id.priya, some(2));
    const stop = money.watchLedger(id.priya);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);
    expect(money.ledgerRows(id.priya)).toHaveLength(2);

    // another resource, another customer: nothing to read again
    cache.merge('categories', [
      {
        id: 'c',
        name: 'Ring',
        prefix: 'R',
        active: true,
        created_at: at(1),
        updated_at: at(1),
        created_by: null,
        updated_by: null,
      },
    ]);
    cache.merge('customers', [
      customerRow('00000000-0000-4000-8000-0000000000bb', { name: 'Other', updated_at: at(60) }),
    ]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);
    // the same customer row again (a poll's overlap brings it again with the same stamp)
    cache.merge('customers', [customerRow(id.priya)]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);

    // a payment moved the customer's stamp: the ledger is read again and holds the new row
    server.ledgers.set(id.priya, some(3));
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(70) })]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(2);
    expect(money.ledgerRows(id.priya)).toHaveLength(3);
    stop();
  });

  it('negative control: a ledger nobody watches is not read again when the customer changes', async () => {
    const { server, cache, money } = world();
    server.ledgers.set(id.priya, some(2));
    await money.loadLedger(id.priya);
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(70) })]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);
  });

  it('a change that arrives while the ledger is being read is read again afterwards, once, however many changes there were', async () => {
    const { server, cache, money } = world();
    server.ledgers.set(id.priya, some(2));
    const stop = money.watchLedger(id.priya);
    // while the first read is in flight three polls bring the customer again
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(70) })]);
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(71) })]);
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(72) })]);
    server.ledgers.set(id.priya, some(4));
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(2);
    expect(money.ledgerRows(id.priya)).toHaveLength(4);
    stop();
  });

  it('two cards of one customer share one load, and the load stops following the customer when the last one closes', async () => {
    const { server, cache, money } = world();
    server.ledgers.set(id.priya, some(2));
    const stopA = money.watchLedger(id.priya);
    const stopB = money.watchLedger(id.priya);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);
    stopA();
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(70) })]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(2); // B still watches
    stopB();
    stopB(); // twice is once
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(80) })]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(2);
  });

  it('a failed read is not tried again for every poll, but is tried again when the customer changes', async () => {
    const { server, cache, money } = world();
    server.ledgers.set(id.priya, some(2));
    server.ledgerFailure = 500;
    const stop = money.watchLedger(id.priya);
    await money.idle();
    expect(money.ledgerState(id.priya).state).toBe('failed');
    cache.merge('categories', []); // nothing changed
    cache.merge('customers', [customerRow(id.priya)]); // same stamp
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(70) })]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(2);
    expect(money.ledgerState(id.priya).state).toBe('ready');
    stop();
  });

  it('a logout empties every ledger and stops the watching; a read that was on its way is thrown away', async () => {
    const { server, cache, money, logout } = world();
    server.ledgers.set(id.priya, some(2));
    const stop = money.watchLedger(id.priya);
    logout(); // while the first read is still in flight
    await money.idle();
    expect(money.ledgerRows(id.priya)).toEqual([]);
    expect(money.ledgerState(id.priya).state).toBe('idle');
    cache.merge('customers', [customerRow(id.priya, { updated_at: at(70) })]);
    await money.idle();
    expect(ledgerCalls(server)).toHaveLength(1);
    stop();

    await money.loadLedger(id.priya);
    expect(money.ledgerRows(id.priya)).toHaveLength(2);
    logout();
    expect(money.ledgerRows(id.priya)).toEqual([]);
  });
});

describe('creating a customer (X6) forgets its key at a logout (U8)', () => {
  const body = { name: 'Meena Joshi', mobile: '9811122233' };

  it("a person who signs in next does not repeat the first one's key", async () => {
    const { server, money, logout } = world();
    server.dropAnswers = 1;
    await money.createCustomer(body).catch(() => undefined);
    logout();
    server.stored.clear();
    server.customers.length = 0;
    await money.createCustomer(body);
    const keys = server.seen.filter((c) => c.path === '/v1/customers').map((c) => c.key);
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('a double click joins the call that is on its way, whatever order the keys of the body are written in', async () => {
    const { server, money } = world();
    let release!: () => void;
    server.hold = new Promise<void>((resolve) => (release = resolve));
    const a = money.createCustomer({ name: 'Meena Joshi', mobile: '9811122233' });
    const b = money.createCustomer({ mobile: '9811122233', name: 'Meena Joshi' });
    release();
    await Promise.all([a, b]);
    expect(server.count('/v1/customers')).toBe(1);
  });

  it("the returned row is merged into the cache with the server's own id and stamps", async () => {
    const { server, cache, money } = world();
    const row = await money.createCustomer(body);
    expect(row.id).toBe(server.customers[0].id);
    expect(cache.get('customers', row.id)).toEqual(server.customers[0]);
  });

  it('an invalid mobile number or a missing name never reaches the server', async () => {
    const { server, money } = world();
    await expect(money.createCustomer({ name: '  ', mobile: '9811122233' })).rejects.toThrow(
      /name/i
    );
    await expect(money.createCustomer({ name: 'A', mobile: '' })).rejects.toThrow(/mobile/i);
    expect(server.count('/v1/customers')).toBe(0);
  });
});
