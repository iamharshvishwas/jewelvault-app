// WEB03: the first hydrate behind the loading gate (spec C2, C3, U8): every resource the role may read is loaded by GET /v1/sync/<resource>
// in pages that follow the cursor the server hands back (so a page cap lower than the page asked for works too), with progress, an error that
// can be retried, and no data at all when it fails. The unit halves of T-E05, T-F03 and T-E01 of PT-W3; the browser halves are
// tests/e2e/hydrate.spec.ts. Time and the API are fakes; the cache, the stamps and the session store are the real ones.
import { describe, expect, it, vi } from 'vitest';
import { createSessionStore, type SessionApi } from '@/lib/authStore';
import { createRowCache } from '@/lib/cache/cache';
import {
  FIRST_POLL_OVERLAP_S,
  HYDRATE_PAGE_ROWS,
  bindToSession,
  createHydrator,
  isGateOpen,
  progressText,
  resourcesFor,
  type HydrateState,
  type Hydrator,
} from '@/lib/cache/hydrate';
import { SYNC_RESOURCES, type SyncResource } from '@/lib/api/types';
import {
  apiError,
  at,
  categoryRow,
  designRow,
  fakeApi,
  manyRows,
  settingRow,
  skuPrivateRow,
  skuRow,
  userRow,
  uuid,
  type FakeApiOptions,
} from './support/rows';

/** A hydrate over a fake API; `settled()` waits for the load that is running. */
function setup(options: FakeApiOptions, extra: Partial<Parameters<typeof createHydrator>[0]> = {}) {
  const cache = createRowCache();
  const { api, calls } = fakeApi(options);
  const hydrator = createHydrator({ api, cache, ...extra });
  return { cache, calls, hydrator };
}

/** A small shop: every resource of an owner has a row. */
const smallShop = (): FakeApiOptions['tables'] => ({
  users: [userRow(1)],
  settings: [
    settingRow('business', { displayName: 'Shop' }),
    settingRow('numbering', { designPadding: 5 }),
  ],
  'daily-rates': [],
  categories: [categoryRow(1, 'Ring', 'RING')],
  subcategories: [],
  designs: [designRow(1), designRow(2)],
  skus: [skuRow(1, 1), skuRow(2, 1), skuRow(3, 2)],
  'sku-private': [skuPrivateRow(1), skuPrivateRow(2), skuPrivateRow(3)],
  customers: [],
  bills: [],
  'bill-summary': [],
  'bill-items': [],
  receipts: [],
  'receipt-allocations': [],
  'customer-balances': [],
});

describe('T-E05 which resources a role loads (C3, A4)', () => {
  it('the owner loads all 15, the biller all but sku-private, staff the 7 of the stock side and the people', () => {
    expect(resourcesFor('owner')).toHaveLength(15);
    expect([...resourcesFor('owner')].sort()).toEqual([...SYNC_RESOURCES].sort());
    expect(resourcesFor('biller')).toHaveLength(14);
    expect(resourcesFor('biller')).not.toContain('sku-private');
    expect([...resourcesFor('staff')].sort()).toEqual(
      ['categories', 'daily-rates', 'designs', 'settings', 'skus', 'subcategories', 'users'].sort()
    );
  });

  it('the stock side comes first, the money side after it', () => {
    const owner = resourcesFor('owner');
    const stock: SyncResource[] = [
      'settings',
      'daily-rates',
      'categories',
      'subcategories',
      'designs',
      'skus',
      'sku-private',
    ];
    const money: SyncResource[] = [
      'customers',
      'bills',
      'bill-summary',
      'bill-items',
      'receipts',
      'receipt-allocations',
      'customer-balances',
    ];
    expect(owner.slice(0, 7)).toEqual(stock);
    for (const resource of money)
      expect(owner.indexOf(resource)).toBeGreaterThan(owner.indexOf('skus'));
  });
});

describe('T-E05 the first hydrate (C2)', () => {
  it('asks for every resource of the role, the first page without a cursor and with the page size of the API (1,000)', async () => {
    const { hydrator, calls, cache } = setup({ tables: smallShop() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('ready');
    expect(new Set(calls.map((c) => c.resource))).toEqual(new Set(resourcesFor('owner')));
    for (const call of calls) {
      expect(call.updatedAfter).toBeUndefined();
      expect(call.afterKey).toBeUndefined();
      expect(call.limit).toBe(HYDRATE_PAGE_ROWS);
    }
    expect(HYDRATE_PAGE_ROWS).toBe(1000);
    expect(cache.count('designs')).toBe(2);
    expect(cache.count('skus')).toBe(3);
    expect(cache.count('sku-private')).toBe(3);
    expect(cache.count('settings')).toBe(2);
  });

  it('a biller never asks for sku-private and staff never ask for the money side', async () => {
    const biller = setup({ tables: smallShop() });
    biller.hydrator.start('biller', 1);
    await biller.hydrator.settled();
    expect(biller.calls.map((c) => c.resource)).not.toContain('sku-private');
    const staff = setup({ tables: smallShop() });
    staff.hydrator.start('staff', 1);
    await staff.hydrator.settled();
    expect(new Set(staff.calls.map((c) => c.resource))).toEqual(new Set(resourcesFor('staff')));
    expect(staff.hydrator.getState().tablesTotal).toBe(7);
  });

  it('shows progress: "0 of 15 tables" at the start, one more table each time one is whole, "15 of 15" at the end', async () => {
    const { hydrator } = setup({ tables: smallShop() });
    const seen: HydrateState[] = [];
    hydrator.subscribe(() => seen.push(hydrator.getState()));
    hydrator.start('owner', 1);
    expect(hydrator.getState().status).toBe('loading');
    expect(progressText(hydrator.getState())).toBe('0 of 15 tables');
    await hydrator.settled();
    expect(progressText(hydrator.getState())).toBe('15 of 15 tables');
    const done = seen.map((s) => s.tablesDone);
    expect(done).toEqual([...done].sort((a, b) => a - b)); // never goes back
    expect(new Set(done)).toEqual(new Set(Array.from({ length: 16 }, (_, i) => i)));
    expect(Math.max(...seen.map((s) => s.rowsLoaded))).toBe(12);
    expect(progressText({ tablesDone: 3, tablesTotal: 8 })).toBe('3 of 8 tables');
  });

  it('counts the rows it has loaded', async () => {
    const { hydrator } = setup({ tables: smallShop() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    // users 1 + settings 2 + categories 1 + designs 2 + skus 3 + sku-private 3
    expect(hydrator.getState().rowsLoaded).toBe(12);
  });

  it('is ready only when every table is whole: while one is still on its way the gate stays shut (C2)', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { hydrator } = setup({
      tables: smallShop(),
      before: async (call) => {
        if (call.resource === 'customers') await held;
      },
    });
    hydrator.start('owner', 1);
    await vi.waitFor(() => expect(hydrator.getState().tablesDone).toBeGreaterThan(5));
    expect(hydrator.getState().status).toBe('loading');
    expect(isGateOpen(hydrator.getState(), 'owner', 1)).toBe(false);
    release();
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('ready');
    expect(isGateOpen(hydrator.getState(), 'owner', 1)).toBe(true);
  });

  it('starting the same session twice is one load (the page layout asks again on every page)', async () => {
    const { hydrator, calls } = setup({ tables: smallShop() });
    hydrator.start('owner', 1);
    hydrator.start('owner', 1);
    await hydrator.settled();
    const count = calls.length;
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(calls).toHaveLength(count);
    expect(hydrator.getState().status).toBe('ready');
  });

  it('a new epoch (a login, a change of role) loads again from nothing', async () => {
    const { hydrator, calls, cache } = setup({ tables: smallShop() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    const first = calls.length;
    hydrator.start('biller', 2);
    expect(cache.size()).toBe(0); // the owner's data is gone before the biller's arrives
    await hydrator.settled();
    expect(calls.length).toBeGreaterThan(first);
    expect(hydrator.getState()).toMatchObject({ status: 'ready', role: 'biller', epoch: 2 });
    expect(cache.count('sku-private')).toBe(0);
    expect(isGateOpen(hydrator.getState(), 'owner', 1)).toBe(false);
  });

  it('opens the gate only for the role and the epoch it was loaded for', () => {
    const ready: HydrateState = {
      status: 'ready',
      role: 'owner',
      epoch: 3,
      tablesDone: 15,
      tablesTotal: 15,
      rowsLoaded: 1,
      error: null,
      firstServerTime: null,
      pollFrom: null,
    };
    expect(isGateOpen(ready, 'owner', 3)).toBe(true);
    expect(isGateOpen(ready, 'owner', 4)).toBe(false);
    expect(isGateOpen(ready, 'biller', 3)).toBe(false);
    expect(isGateOpen({ ...ready, status: 'loading' }, 'owner', 3)).toBe(false);
    expect(isGateOpen({ ...ready, status: 'error' }, 'owner', 3)).toBe(false);
    expect(isGateOpen({ ...ready, status: 'idle', role: null, epoch: null }, 'owner', 3)).toBe(
      false
    );
  });
});

describe('T-F03 the cursor advances by the rows received, so a page cap lower than the page asked for works (C3)', () => {
  const skus = manyRows<'skus'>(2500, (i) =>
    skuRow(i + 1, 1 + (i % 600), { updated_at: at(10 + Math.floor(i / 4), i) })
  );

  it('2,500 pieces all load in pages of 1,000', async () => {
    const { hydrator, cache, calls } = setup({ tables: { ...smallShop(), skus } });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(cache.count('skus')).toBe(2500);
    expect(calls.filter((c) => c.resource === 'skus')).toHaveLength(3);
  });

  it('2,500 pieces all load also when the API caps its pages at 500 (it answers 500 rows when 1,000 were asked for)', async () => {
    const { hydrator, cache, calls } = setup({ tables: { ...smallShop(), skus }, cap: 500 });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('ready');
    expect(cache.count('skus')).toBe(2500);
    const skuCalls = calls.filter((c) => c.resource === 'skus');
    expect(skuCalls.every((c) => c.limit === 1000)).toBe(true); // it kept asking for the page of the API...
    expect(skuCalls).toHaveLength(6); // ...and followed what it got: five full pages of 500, then the empty one that ends the load
    // negative control: a loader that took "fewer rows than asked for" to mean "the last page" would have stopped after 500
    const first = skuCalls[0];
    expect(first.updatedAfter).toBeUndefined();
    expect(skuCalls[1].updatedAfter).toBeDefined();
    expect(skuCalls[1].afterKey).toBeDefined();
  });

  it('1,500 rows of another resource arrive in full with the stock side (PT-W3)', async () => {
    const customers = manyRows<'customers'>(1500, (i) => ({
      id: uuid(5000 + i),
      name: `Customer ${i}`,
      mobile: null,
      customer_type: 'Retail',
      email: null,
      address: null,
      gst_number: null,
      pan: null,
      notes: null,
      is_walkin: false,
      archived_at: null,
      created_at: at(0),
      updated_at: at(20, i),
      created_by: null,
      updated_by: null,
    }));
    const { hydrator, cache } = setup({ tables: { ...smallShop(), skus, customers }, cap: 500 });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(cache.count('skus')).toBe(2500);
    expect(cache.count('customers')).toBe(1500);
  });

  it('two rows with the same updated_at at the edge of a page are both received (the key breaks the tie)', async () => {
    const same = at(10, 5);
    const designs = [1, 2, 3, 4, 5].map((n) => designRow(n, { updated_at: same }));
    const { hydrator, cache } = setup({ tables: { ...smallShop(), designs }, cap: 2 });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(cache.count('designs')).toBe(5);
  });

  it('a row changed while the load runs is received again at the end of the order, and the newer copy is the one kept (C3)', async () => {
    const designs = [1, 2, 3, 4].map((n) =>
      designRow(n, { name: `old ${n}`, updated_at: at(10 + n) })
    );
    const tables = { ...smallShop(), designs };
    const { hydrator, cache } = setup({
      tables,
      cap: 2,
      before: (call) => {
        // after the first page of designs went out, design 1 is changed: its stamp now sorts after all the others
        if (call.resource === 'designs' && call.updatedAfter !== undefined) {
          tables.designs = tables.designs.map((d) =>
            d.id === uuid(301) ? { ...d, name: 'new 1', updated_at: at(40) } : d
          );
        }
      },
    });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(cache.count('designs')).toBe(4);
    expect(cache.get('designs', uuid(301))?.name).toBe('new 1');
  });

  it('stops with an error rather than loop when the server hands back the cursor it was given', async () => {
    const designs = [1, 2, 3].map((n) => designRow(n, { updated_at: at(10 + n) }));
    const { api, calls } = fakeApi({ tables: { ...smallShop(), designs }, cap: 1 });
    const stuck = {
      syncPage: async (...args: Parameters<typeof api.syncPage>) => {
        const page = await api.syncPage(...args);
        if (args[0] === 'designs' && args[1]?.updatedAfter !== undefined) {
          return {
            ...page,
            next: { updated_at: args[1].updatedAfter, key: args[1].afterKey ?? '' },
          };
        }
        return page;
      },
    } as unknown as typeof api;
    const cache = createRowCache();
    const hydrator = createHydrator({ api: stuck, cache });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('error');
    expect(calls.filter((c) => c.resource === 'designs').length).toBeLessThan(10);
  });

  it('stops with an error when a page says there is more but holds no row', async () => {
    const { api } = fakeApi({ tables: smallShop() });
    const odd = {
      syncPage: async (...args: Parameters<typeof api.syncPage>) => {
        const page = await api.syncPage(...args);
        return args[0] === 'skus'
          ? { ...page, rows: [], next: { updated_at: at(5), key: uuid(1) } }
          : page;
      },
    } as unknown as typeof api;
    const hydrator = createHydrator({ api: odd, cache: createRowCache() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('error');
  });
});

describe('T-E05 the first poll starts from the first page of the hydrate minus 30 seconds (C3)', () => {
  it('the overlap is 30 seconds', () => {
    expect(FIRST_POLL_OVERLAP_S).toBe(30);
  });

  it('is the server_time of the earliest page asked for, minus 30 s, as six-decimal text', async () => {
    // the fake clock rises by a second with each call: the first call of the load is the one at second 100
    const { hydrator } = setup({ tables: smallShop() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().firstServerTime).toBe(at(100));
    expect(hydrator.getState().pollFrom).toBe(at(70));
  });

  it('takes the earliest first page even when that page is the last to arrive (the pages of different tables overlap in time)', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { hydrator } = setup({
      tables: smallShop(),
      before: async (call) => {
        if (call.resource === 'settings') await held; // asked for first, answered last
      },
    });
    hydrator.start('owner', 1);
    await vi.waitFor(() => expect(hydrator.getState().tablesDone).toBeGreaterThan(8));
    release();
    await hydrator.settled();
    expect(hydrator.getState().firstServerTime).toBe(at(100));
    expect(hydrator.getState().pollFrom).toBe(at(70));
  });

  it('is nothing until the load is whole, and again nothing after a reset', async () => {
    const { hydrator } = setup({ tables: smallShop() });
    expect(hydrator.getState().pollFrom).toBeNull();
    hydrator.start('owner', 1);
    expect(hydrator.getState().pollFrom).toBeNull();
    await hydrator.settled();
    expect(hydrator.getState().pollFrom).not.toBeNull();
    hydrator.reset();
    expect(hydrator.getState().pollFrom).toBeNull();
    expect(hydrator.getState().firstServerTime).toBeNull();
  });

  it('a server_time that is not the exact stamp text is a failed load, not a guess', async () => {
    const { api } = fakeApi({ tables: smallShop() });
    const odd = {
      syncPage: async (...args: Parameters<typeof api.syncPage>) => ({
        ...(await api.syncPage(...args)),
        server_time: '2026-10-15T09:00:00Z',
      }),
    } as unknown as typeof api;
    const hydrator = createHydrator({ api: odd, cache: createRowCache() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('error');
  });
});

describe('T-E05 a failed load shows an error with a retry and never sample data or an empty list (C2, D20)', () => {
  it('a failed page is an error state with the plain message, and none of the rows that had arrived stays in memory', async () => {
    const { hydrator, cache } = setup({
      tables: smallShop(),
      before: (call) => {
        if (call.resource === 'skus') throw apiError('JV_INTERNAL', 500);
      },
    });
    hydrator.start('owner', 1);
    await hydrator.settled();
    const state = hydrator.getState();
    expect(state.status).toBe('error');
    expect(state.error).toBe('plain message of JV_INTERNAL');
    expect(cache.size()).toBe(0);
    expect(isGateOpen(state, 'owner', 1)).toBe(false);
  });

  it("an error that is not the API's (a network failure, a bug) gets a plain sentence, never its own text", async () => {
    const { hydrator } = setup({
      tables: smallShop(),
      before: (call) => {
        if (call.resource === 'designs') throw new TypeError('secret detail of a bug');
      },
    });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('error');
    expect(hydrator.getState().error).toBe('The data could not be loaded. Try again.');
    expect(hydrator.getState().error).not.toContain('secret');
  });

  it('retry loads everything again from the first page, and the gate opens when it works', async () => {
    let fail = true;
    const { hydrator, calls, cache } = setup({
      tables: smallShop(),
      before: (call) => {
        if (fail && call.resource === 'skus') throw apiError('JV_BUSY', 503);
      },
    });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('error');
    const callsBefore = calls.length;
    fail = false;
    hydrator.retry();
    expect(hydrator.getState().status).toBe('loading');
    expect(progressText(hydrator.getState())).toBe('0 of 15 tables');
    await hydrator.settled();
    expect(hydrator.getState()).toMatchObject({
      status: 'ready',
      error: null,
      role: 'owner',
      epoch: 1,
    });
    expect(cache.count('skus')).toBe(3);
    const again = calls.slice(callsBefore);
    expect(new Set(again.map((c) => c.resource))).toEqual(new Set(resourcesFor('owner')));
    expect(again.every((c) => c.updatedAfter === undefined)).toBe(true); // from the start, not from where it stopped
  });

  it('start() does not quietly retry an error: only the retry button does', async () => {
    const { hydrator, calls } = setup({
      tables: smallShop(),
      before: (call) => {
        if (call.resource === 'designs') throw apiError('JV_INTERNAL', 500);
      },
    });
    hydrator.start('owner', 1);
    await hydrator.settled();
    const count = calls.length;
    hydrator.start('owner', 1); // the layout asks again on a new page
    await hydrator.settled();
    expect(calls).toHaveLength(count);
    expect(hydrator.getState().status).toBe('error');
  });

  it('a 403 asks the session once; when the role has changed it says nothing and the load starts again with the new role', async () => {
    const holder: { hydrator?: Hydrator } = {};
    // the session store runs the hooks (here: the reset) and then opens the gate again with a new epoch
    const reviewRole = vi.fn(async () => {
      holder.hydrator?.reset();
      return 'changed' as const;
    });
    const { hydrator, cache } = setup(
      { tables: smallShop(), forbidden: ['customers'] },
      { reviewRole }
    );
    holder.hydrator = hydrator;
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(reviewRole).toHaveBeenCalledTimes(1);
    expect(hydrator.getState().status).toBe('idle');
    expect(hydrator.getState().error).toBeNull();
    expect(cache.size()).toBe(0);
  });

  it('a 403 for a role that has not changed is an error with a retry', async () => {
    const reviewRole = vi.fn(async () => 'same' as const);
    const { hydrator } = setup({ tables: smallShop(), forbidden: ['customers'] }, { reviewRole });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(reviewRole).toHaveBeenCalledTimes(1);
    expect(hydrator.getState().status).toBe('error');
    expect(hydrator.getState().error).toBe('plain message of JV_FORBIDDEN');
  });
});

describe('T-E05 logout empties memory and stops the load (U8)', () => {
  it('reset() during a load aborts it: the pages that are still on their way are not merged and nothing more is asked for', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { hydrator, cache, calls } = setup({
      tables: smallShop(),
      before: async (call) => {
        if (call.resource === 'designs') await held;
      },
    });
    hydrator.start('owner', 1);
    await vi.waitFor(() => expect(calls.some((c) => c.resource === 'designs')).toBe(true));
    hydrator.reset();
    expect(hydrator.getState().status).toBe('idle');
    expect(cache.size()).toBe(0);
    const asked = calls.length;
    release();
    await hydrator.settled();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(calls).toHaveLength(asked);
    expect(cache.size()).toBe(0);
    expect(hydrator.getState().status).toBe('idle');
  });

  it('reset() after the load empties every resource and closes the gate', async () => {
    const { hydrator, cache } = setup({ tables: smallShop() });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(cache.size()).toBeGreaterThan(0);
    hydrator.reset();
    expect(cache.size()).toBe(0);
    for (const resource of SYNC_RESOURCES) expect(cache.count(resource), resource).toBe(0);
    expect(isGateOpen(hydrator.getState(), 'owner', 1)).toBe(false);
  });

  it('a late error from a load that was reset is not shown', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const { hydrator, calls } = setup({
      tables: smallShop(),
      before: async (call) => {
        if (call.resource === 'designs') {
          await held;
          throw apiError('JV_INTERNAL', 500);
        }
      },
    });
    hydrator.start('owner', 1);
    await vi.waitFor(() => expect(calls.some((c) => c.resource === 'designs')).toBe(true));
    hydrator.reset();
    release();
    await hydrator.settled();
    expect(hydrator.getState().status).toBe('idle');
    expect(hydrator.getState().error).toBeNull();
  });

  it('a session that ends (logout, 401, another person, a change of role) runs the hook the hydrate registered: memory is empty and the load is over', async () => {
    const api: SessionApi = {
      login: async () => {
        throw new Error('not used');
      },
      me: async () => {
        throw new Error('not used');
      },
      logout: async () => ({ ok: true }),
      activity: async () => ({ ok: true }),
      changePassword: async () => {
        throw new Error('not used');
      },
      onUnauthorized: () => () => undefined,
    };
    const session = createSessionStore({ api, host: null });
    const { hydrator, cache } = setup({ tables: smallShop() });
    bindToSession(hydrator, session.registerLogoutHook);
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(cache.size()).toBeGreaterThan(0);
    await session.signOut();
    expect(cache.size()).toBe(0);
    expect(hydrator.getState().status).toBe('idle');
  });

  it('registers one hook and gives the way to take it away again', () => {
    const hooks = new Set<() => void>();
    const register = (hook: () => void) => {
      hooks.add(hook);
      return () => hooks.delete(hook);
    };
    const { hydrator } = setup({ tables: smallShop() });
    const unbind = bindToSession(hydrator, register);
    expect(hooks.size).toBe(1);
    unbind();
    expect(hooks.size).toBe(0);
  });
});

describe('T-E05 how many tables are asked for at once', () => {
  it("no more than three, so the API's pool of 8 connections is never crowded by one browser", async () => {
    let inFlight = 0;
    let most = 0;
    const { hydrator } = setup({
      tables: smallShop(),
      before: async () => {
        inFlight += 1;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
      },
    });
    hydrator.start('owner', 1);
    await hydrator.settled();
    expect(most).toBeGreaterThan(1);
    expect(most).toBeLessThanOrEqual(3);
  });
});
