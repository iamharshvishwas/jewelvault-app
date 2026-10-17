// WEB04: the poller (spec C3, C4, C7, C17, C18, U6): one POST /v1/sync/poll every 8 seconds and at once after a write, a cursor per resource taken from the data
// and moved only when every page of the poll has arrived, the 30-second overlap, the offline banner and "Waking up…", and what a 401, a 403 and another role do.
// The unit halves of T-E02, T-E03, T-E07 and of the poll clauses of T-E01; the browser halves are tests/e2e/poll.spec.ts.
//
// Everything is the real code except the server and the clock: the real API client (so the banner, the retries of "Waking up" and the 401 hook are the real
// ones), the real session store, hydrate, cache and poller, over a fake server (tests/unit/support/server.ts) that speaks the wire and keeps the clock of the test,
// so one `advanceTimersByTimeAsync` moves the poller's timers and the server's time together.
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { createApiClient, nextPollDelayMs } from '@/lib/api/client';
import { resourcesFor } from '@/lib/cache/hydrate';
import { clampPollIntervalMs, createPoller, type PollerDeps } from '@/lib/cache/poll';
import type { AuthRole } from '@/lib/authStore';
import {
  FakeServer,
  balanceOf,
  billSummaryOf,
  customerOf,
  designOf,
  gatewayPage,
  jsonResponse,
  makeWorld,
  refusal,
  seedShop,
  settingOf,
  settle,
  skuOf,
  stampAt,
  type Seen,
} from './support/server';

let warn: MockInstance<typeof console.warn>;
beforeEach(() => {
  vi.useFakeTimers({
    now: Date.UTC(2026, 9, 15, 9, 0, 0),
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  vi.useRealTimers();
  warn.mockRestore();
});

/** A shop, a session, a hydrate and a poller. Nothing has run: `await settle()` lets the person in, the hydrate finish and the first poll go. */
function boot(
  over: Partial<PollerDeps> = {},
  options: { role?: AuthRole; prepare?: (server: FakeServer) => void } = {}
) {
  const server = new FakeServer();
  server.role = options.role ?? 'owner';
  seedShop(server);
  options.prepare?.(server);
  const w = makeWorld(server);
  const poller = createPoller({
    api: w.api,
    cache: w.cache,
    hydrator: w.hydrator,
    session: w.session,
    page: w.page,
    ...over,
  });
  return { ...w, poller };
}

/** The first request of each poll (a poll that pages sends more requests: those name fewer resources). */
const rounds = (server: FakeServer) =>
  server.polls().filter((p) => Object.keys(p.cursors ?? {}).length > 1);
/** When each round started, in seconds on the server's clock. */
const times = (server: FakeServer) => rounds(server).map((p) => Math.round(p.at * 1000) / 1000);
const cursorOf = (seen: Seen, resource: string) => (seen.cursors ?? {})[resource];

// ------------------------------------------------------------------------------------------------ T-E07: the cursors

describe('T-E07 the first poll and the cursors (C3, C4)', () => {
  it("the first poll starts at the server_time of the hydrate's first page minus 30 seconds, six decimals, no key, for every resource of the role", async () => {
    const t = boot();
    await settle();
    expect(t.hydrator.getState().status).toBe('ready');
    expect(t.hydrator.getState().pollFrom).toBe(stampAt(70)); // the first page was read at 100 s
    const first = rounds(t.server)[0];
    expect(Object.keys(first.cursors ?? {}).sort()).toEqual([...resourcesFor('owner')].sort());
    for (const resource of resourcesFor('owner')) {
      const cursor = cursorOf(first, resource);
      expect(cursor, resource).toEqual({ updated_at: stampAt(70) });
      expect(Object.keys(cursor ?? {})).toEqual(['updated_at']); // no key: the server reads `updated_at >= ?`
      expect(cursor?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    }
    expect(first.limit).toBe(1000);
    expect(t.poller.getState().polls).toBe(1);
  });

  it('a biller asks for 14 resources and staff for 7: never one the role may not read', async () => {
    const biller = boot({}, { role: 'biller' });
    await settle();
    expect(Object.keys(rounds(biller.server)[0].cursors ?? {})).toHaveLength(14);
    expect(rounds(biller.server)[0].cursors).not.toHaveProperty('sku-private');
    const staff = boot({}, { role: 'staff' });
    await settle();
    expect(Object.keys(rounds(staff.server)[0].cursors ?? {}).sort()).toEqual(
      [...resourcesFor('staff')].sort()
    );
  });

  it('after a poll the cursor of a resource is the greatest updated_at received minus 30 seconds; a resource with no news keeps its place', async () => {
    const t = boot();
    await settle(12); // 112 s
    t.server.put('designs', designOf(3, t.server.stamp()));
    await settle(4); // the poll of 116 s brings it
    expect(t.cache.get('designs', designOf(3, '').id as string)).toBeDefined();
    await settle(8); // 124 s
    const last = rounds(t.server).at(-1) as Seen;
    expect(cursorOf(last, 'designs')).toEqual({ updated_at: stampAt(82) }); // 112 - 30
    expect(cursorOf(last, 'skus')).toEqual({ updated_at: stampAt(70) });
    expect(cursorOf(last, 'settings')).toEqual({ updated_at: stampAt(70) });
  });

  it('merges by id and keeps the row with the greater updated_at: an older copy that comes in a poll changes nothing', async () => {
    const t = boot();
    await settle();
    const newer = designOf(1, stampAt(105), { name: 'newer' });
    t.server.put('designs', newer);
    await settle(8);
    expect(t.cache.get('designs', newer.id as string)).toMatchObject({ name: 'newer' });
    // a stale copy (stamp 90) sent by a server that is behind: the overlap brings old copies back from time to time
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll') return undefined;
      t.server.onRequest = undefined;
      return jsonResponse(200, {
        results: { designs: { rows: [designOf(1, stampAt(90), { name: 'stale' })], next: null } },
        server_time: stampAt(t.server.now()),
        role: 'owner',
      });
    };
    await settle(8);
    expect(t.cache.get('designs', newer.id as string)).toMatchObject({ name: 'newer' });
  });
});

describe('T-E07 paging (C3, C4)', () => {
  it('a 1,500-row poll arrives in full: the second request names only the resource that was full, with the cursor the server gave', async () => {
    const t = boot();
    await settle();
    const before = t.cache.count('skus');
    for (let i = 0; i < 1500; i += 1)
      t.server.put('skus', skuOf(100 + i, 1, stampAt(101 + i / 1000)));
    await settle(8);
    expect(t.cache.count('skus')).toBe(before + 1500);
    const forSkus = t.server.polls().filter((p) => Object.keys(p.cursors ?? {}).join() === 'skus');
    expect(forSkus).toHaveLength(1);
    const cursor = forSkus[0].cursors?.skus;
    expect(cursor?.updated_at).toBe(stampAt(101 + 999 / 1000)); // the last row of the first page
    expect(cursor?.key).toBe(skuOf(1099, 1, '').id); // and its key
    expect(t.poller.getState().failures).toBe(0);
  });

  it('two rows with the same updated_at at the edge of a page are both received: the cursor between pages carries the key', async () => {
    const t = boot();
    await settle();
    t.server.cap = 2; // pages of two
    const same = stampAt(105);
    for (let n = 3; n <= 7; n += 1) t.server.put('designs', designOf(n, same));
    await settle(8);
    for (let n = 3; n <= 7; n += 1)
      expect(t.cache.get('designs', designOf(n, '').id as string), `design ${n}`).toBeDefined();
    const pages = t.server.polls().filter((p) => Object.keys(p.cursors ?? {}).join() === 'designs');
    expect(pages.length).toBe(2); // 2 + 2 + 1 rows: the first request, then two more
    for (const page of pages) {
      expect(page.cursors?.designs?.updated_at).toBe(same);
      expect(page.cursors?.designs?.key).toBeTruthy();
    }
  });

  it('moves a cursor only when every page of the poll has arrived: a page that fails leaves them where they were and puts nothing of the poll in memory', async () => {
    const t = boot();
    await settle();
    const before = t.cache.count('skus');
    for (let i = 0; i < 1500; i += 1)
      t.server.put('skus', skuOf(100 + i, 1, stampAt(101 + i / 1000)));
    let failed = false;
    t.server.onRequest = (seen) => {
      if (seen.kind === 'poll' && !failed && Object.keys(seen.cursors ?? {}).join() === 'skus') {
        failed = true;
        throw new TypeError('fetch failed'); // the second page of the poll never arrives
      }
      return undefined;
    };
    await settle(8); // 108 s: page one is read, page two fails
    expect(failed).toBe(true);
    expect(t.poller.getState().failures).toBe(1);
    expect(t.cache.count('skus')).toBe(before); // not even the first 1,000
    await settle(8); // 116 s: the poll is made again, from the old cursors
    const all = rounds(t.server);
    expect(cursorOf(all[1], 'skus')).toEqual({ updated_at: stampAt(70) });
    expect(cursorOf(all[2], 'skus')).toEqual({ updated_at: stampAt(70) }); // not moved by the failed poll
    expect(t.cache.count('skus')).toBe(before + 1500);
    expect(t.poller.getState().failures).toBe(0);
    await settle(8); // 124 s: now they have moved
    expect(cursorOf(rounds(t.server).at(-1) as Seen, 'skus')).toEqual({
      updated_at: stampAt(101 + 1499 / 1000 - 30),
    });
  });

  it('follows a server whose pages hold fewer rows than asked for (a cap of 500)', async () => {
    const t = boot();
    await settle();
    t.server.cap = 500;
    for (let i = 0; i < 1200; i += 1)
      t.server.put('skus', skuOf(100 + i, 1, stampAt(101 + i / 1000)));
    await settle(8);
    expect(t.cache.count('skus')).toBe(3 + 1200);
  });

  it('stops with a failure rather than ask for ever when the server hands back the cursor it was given', async () => {
    const t = boot();
    await settle();
    t.server.cap = 1;
    t.server.put('designs', designOf(3, stampAt(105)));
    t.server.put('designs', designOf(4, stampAt(106)));
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll' || Object.keys(seen.cursors ?? {}).join() !== 'designs')
        return undefined;
      const stuck = seen.cursors?.designs;
      return jsonResponse(200, {
        results: {
          designs: {
            rows: [designOf(3, stampAt(105))],
            next: { updated_at: stuck?.updated_at, key: stuck?.key ?? '' },
          },
        },
        server_time: stampAt(t.server.now()),
        role: 'owner',
      });
    };
    await settle(8);
    expect(t.poller.getState().failures).toBe(1);
    expect(t.poller.getState().notice).toBeTruthy();
    expect(t.server.polls().length).toBeLessThan(10);
  });
});

describe('T-E07 rows that commit late (C3, C4)', () => {
  it('a row committed 20 seconds after it was stamped still arrives (the 30-second overlap)', async () => {
    const t = boot();
    await settle();
    // stamped now (100 s), committed at 120 s; in between another design is received, which moves the cursor of designs
    t.server.put('designs', designOf(3, stampAt(100)), 120);
    await settle(12);
    t.server.put('designs', designOf(4, t.server.stamp()));
    await settle(30); // up to 142 s
    expect(t.cache.get('designs', designOf(4, '').id as string)).toBeDefined();
    expect(t.cache.get('designs', designOf(3, '').id as string)).toBeDefined();
  });

  it('negative control: a row committed 40 seconds late is NOT found by the cursor alone (that is why IM1 ends with a new data_epoch)', async () => {
    const t = boot();
    await settle();
    t.server.put('designs', designOf(3, stampAt(100)), 140); // a 40-second import transaction, stamped at its start
    await settle(31); // 131 s
    t.server.put('designs', designOf(4, t.server.stamp())); // a normal edit that moves the cursor past the import's stamp
    await settle(80); // up to 211 s
    expect(t.cache.get('designs', designOf(4, '').id as string)).toBeDefined();
    expect(t.cache.get('designs', designOf(3, '').id as string)).toBeUndefined();
  });

  it('a row stamped at the start of a 40-second import transaction still arrives when the import ends as IM1 says: a new data_epoch makes the screen hydrate again', async () => {
    const t = boot();
    await settle();
    t.server.put('designs', designOf(3, stampAt(100)), 140); // stamped at its start, committed at 140 s
    await settle(31);
    t.server.put('designs', designOf(4, t.server.stamp()));
    await settle(8);
    const hydratesBefore = t.server.seen.filter((s) => s.kind === 'sync' && !s.updatedAfter).length;
    // the import ends: its rows are re-stamped just before COMMIT and the setting data_epoch changes, all at 140 s
    t.server.put(
      'settings',
      settingOf('data_epoch', { epoch: '2026-10-15 09:02:20.000000' }, stampAt(140)),
      140
    );
    await settle(8); // the poll at 148 s sees the setting
    await settle(); // and the hydrate that follows
    const hydratesAfter = t.server.seen.filter((s) => s.kind === 'sync' && !s.updatedAfter).length;
    expect(hydratesAfter).toBe(hydratesBefore + resourcesFor('owner').length);
    expect(t.cache.get('designs', designOf(3, '').id as string)).toBeDefined();
    expect(t.hydrator.getState().status).toBe('ready');
    // the poller goes on from the NEW hydrate: its first poll starts 30 seconds before that hydrate's first page
    const newest = rounds(t.server).at(-1) as Seen;
    expect(cursorOf(newest, 'designs')).toEqual({ updated_at: t.hydrator.getState().pollFrom });
  });

  it('a change to another setting does not make the screen hydrate again', async () => {
    const t = boot();
    await settle();
    const syncs = t.server.count('sync');
    t.server.put(
      'settings',
      settingOf(
        'numbering',
        { designPadding: 6, skuPadding: 3, barcodePrefix: 'BC' },
        t.server.stamp()
      )
    );
    await settle(16);
    expect(t.server.count('sync')).toBe(syncs);
  });

  it('a hydrate slowed to 40 seconds, while a row stamped before its first page commits 4 seconds after it, still ends with that row (C3)', async () => {
    const t = boot();
    // the last table of the hydrate is held for 40 seconds
    t.server.onRequest = (seen) => {
      if (seen.kind === 'sync' && seen.resource === 'customer-balances') {
        return new Promise((resolve) => setTimeout(() => resolve(undefined), 40_000));
      }
      return undefined;
    };
    t.server.put('settings', settingOf('late_row', { x: 1 }, stampAt(99)), 104); // stamped before the first page (100 s), committed at 104 s
    await settle(30);
    expect(t.hydrator.getState().status).toBe('loading');
    expect(t.cache.get('settings', 'late_row')).toBeUndefined(); // the page of settings was read at 100 s: it did not have it
    await settle(10); // 140 s: the hydrate ends and the poll starts
    expect(t.hydrator.getState().status).toBe('ready');
    expect(t.hydrator.getState().pollFrom).toBe(stampAt(70));
    expect(t.cache.get('settings', 'late_row')).toBeDefined();

    // negative control: a poll that started 30 seconds before the END of the hydrate (the last row's stamp, or the last page's server_time) would have missed it
    const naive = await t.server.fetch('https://api.example.test/v1/sync/poll', {
      method: 'POST',
      body: JSON.stringify({ cursors: { settings: { updated_at: stampAt(140 - 30) } } }),
    });
    const body = (await naive.json()) as {
      results: { settings: { rows: Array<{ setting_key: string }> } };
    };
    expect(body.results.settings.rows.map((r) => r.setting_key)).not.toContain('late_row');
  });
});

describe('T-E07 a pending row ignores polled copies (C4, C5 (a))', () => {
  it('a copy of a row that an ordinary edit holds is let in when the write ends, if it is still the newer one', async () => {
    const t = boot();
    await settle();
    const design = designOf(1, '').id as string;
    const release = t.cache.hold('designs', design);
    t.server.change('designs', design, { name: 'changed by somebody else' }, stampAt(105));
    t.server.put('designs', designOf(3, stampAt(105))); // another row of the same poll
    await settle(8);
    expect(t.cache.get('designs', design)).toMatchObject({ name: 'Design 1' }); // not touched while the edit is in flight
    expect(t.cache.get('designs', designOf(3, '').id as string)).toBeDefined(); // others are
    release();
    expect(t.cache.get('designs', design)).toMatchObject({ name: 'changed by somebody else' });
  });
});

// ------------------------------------------------------------------------------------------------ T-E02: what the other browser shows

describe('T-E02 a change made by somebody else reaches memory within one poll (C4, C9, C17)', () => {
  it('a stock change and a piece sold on one browser are in the memory of the other at its next poll (at most 8 seconds)', async () => {
    const t = boot();
    await settle();
    const sku = skuOf(1, 1, '').id as string;
    t.server.change('skus', sku, { location: 'Jaishri Vault' });
    await settle(8);
    expect(t.cache.get('skus', sku)).toMatchObject({ location: 'Jaishri Vault' });
    const bill = '00000000-0000-4000-0006-000000000001';
    t.server.change('skus', sku, { status: 'Sold', sold_bill_id: bill });
    await settle(8);
    expect(t.cache.get('skus', sku)).toMatchObject({ status: 'Sold', sold_bill_id: bill });
  });

  it('after a payment the pending of the bill and the balance of the customer change in the other browser: the touched base rows come with their new figures', async () => {
    const t = boot(
      {},
      {
        prepare: (server) => {
          server.put('customers', customerOf(1, stampAt(40)));
          server.put('bill-summary', billSummaryOf(1, '10000.00', stampAt(40)));
          server.put('customer-balances', balanceOf(1, '10000.00', stampAt(40)));
        },
      }
    );
    await settle();
    const bill = billSummaryOf(1, '', '').id as string;
    const customer = balanceOf(1, '', '').id as string;
    expect(t.cache.get('bill-summary', bill)).toMatchObject({ outstanding: '10000.00' });
    // a payment of 4,000 on the other browser: the touch moves the updated_at of the bill and of the customer (D23)
    const stamp = t.server.stamp();
    t.server.change('bill-summary', bill, { outstanding: '6000.00', allocated: '4000.00' }, stamp);
    t.server.change(
      'customer-balances',
      customer,
      { outstanding: '6000.00', received: '4000.00' },
      stamp
    );
    await settle(8);
    expect(t.cache.get('bill-summary', bill)).toMatchObject({
      outstanding: '6000.00',
      allocated: '4000.00',
    });
    expect(t.cache.get('customer-balances', customer)).toMatchObject({
      outstanding: '6000.00',
      received: '4000.00',
    });
  });
});

// ------------------------------------------------------------------------------------------------ T-E07: when polls happen

describe('T-E07 when it polls (C4)', () => {
  it('polls every 8 seconds, and never two at once: a slow poll is followed by the next as soon as it ends', async () => {
    const t = boot();
    await settle();
    await settle(24);
    expect(times(t.server)).toEqual([100, 108, 116, 124]);

    // a poll that takes 12 seconds
    let hold: (() => void) | undefined;
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll') return undefined;
      t.server.onRequest = undefined;
      return new Promise((resolve) => {
        hold = () => resolve(undefined);
        setTimeout(() => resolve(undefined), 12_000);
      });
    };
    await settle(8); // 132 s: the slow poll started
    expect(hold).toBeDefined();
    await settle(8); // 140 s: still waiting for it, and no second poll was started
    expect(rounds(t.server)).toHaveLength(5);
    await settle(4); // 144 s: it ends; the next one starts at once
    expect(times(t.server)).toEqual([100, 108, 116, 124, 132, 144]);
  });

  it('the interval is a setting of 5 to 10 seconds: it is cut to that range', async () => {
    expect(clampPollIntervalMs(8000)).toBe(8000);
    expect(clampPollIntervalMs(5000)).toBe(5000);
    expect(clampPollIntervalMs(10_000)).toBe(10_000);
    expect(clampPollIntervalMs(1000)).toBe(5000);
    expect(clampPollIntervalMs(60_000)).toBe(10_000);
    expect(clampPollIntervalMs(Number.NaN)).toBe(8000);
  });

  it('polls on the interval it is given', async () => {
    const t = boot({ intervalMs: 5000 });
    await settle();
    await settle(15);
    expect(times(t.server)).toEqual([100, 105, 110, 115]);
  });

  it('an interval outside 5 to 10 seconds is cut to it', async () => {
    const t = boot({ intervalMs: 600_000 });
    await settle();
    await settle(30);
    expect(times(t.server)).toEqual([100, 110, 120, 130]);
  });

  it('a hidden tab polls every 30 seconds, and at once when it is shown', async () => {
    const t = boot();
    await settle(); // 100 s
    t.page.hide();
    await settle(29);
    expect(times(t.server)).toEqual([100]); // nothing at 108, 116, 124
    await settle(1); // 130 s
    expect(times(t.server)).toEqual([100, 130]);
    await settle(25); // 155 s, still hidden
    t.page.show(); // at once
    await settle(0);
    expect(times(t.server)).toEqual([100, 130, 155]);
    await settle(8);
    expect(times(t.server)).toEqual([100, 130, 155, 163]); // and every 8 seconds again
  });

  it('a tab that is hidden before the first poll still gets it at once', async () => {
    const t = boot();
    t.page.hide();
    await settle();
    expect(times(t.server)).toEqual([100]);
    expect(t.poller.getState().polls).toBe(1);
  });

  it('polls at once after any write the screen made, and a write during a poll is followed by exactly one more', async () => {
    const t = boot();
    await settle();
    expect(times(t.server)).toEqual([100]);
    await settle(3); // 103 s
    await t.api.post('/v1/test-write', { x: 1 });
    await settle();
    expect(times(t.server)).toEqual([100, 103]);
    // the next scheduled poll is 8 seconds after the one that was made at once
    await settle(7);
    expect(times(t.server)).toEqual([100, 103]);
    await settle(1);
    expect(times(t.server)).toEqual([100, 103, 111]);

    // a write while a poll is in flight: one more poll right after it, not two
    let release: (() => void) | undefined;
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll') return undefined;
      t.server.onRequest = undefined;
      return new Promise((resolve) => (release = () => resolve(undefined)));
    };
    await settle(8); // 119 s: the poll starts and is held
    await t.api.post('/v1/test-write', { x: 2 });
    await t.api.post('/v1/test-write', { x: 3 });
    expect(rounds(t.server)).toHaveLength(4);
    release?.();
    await settle();
    expect(times(t.server)).toEqual([100, 103, 111, 119, 119]);
  });

  it('a poll is not a write: it does not start another poll', async () => {
    const t = boot();
    await settle(24);
    expect(times(t.server)).toEqual([100, 108, 116, 124]);
  });

  it('a failed write also starts a poll: the screen may now be behind', async () => {
    const t = boot();
    await settle();
    t.server.onRequest = (seen) =>
      seen.path === '/v1/test-write'
        ? jsonResponse(500, {
            error: { code: 'JV_INTERNAL', message: 'x', details: {} },
            request_id: 'r',
          })
        : undefined;
    await t.api.post('/v1/test-write', { x: 1 }).catch(() => undefined);
    await settle();
    expect(rounds(t.server)).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ T-E03: offline and waking up

describe('T-E03 with the network cut: the banner, Save off, back-off 8, 16, 30 seconds (C7)', () => {
  it('a poll that cannot reach the server shows the offline banner and keeps the screen on memory; polling backs off 8, 16, then 30 seconds; one good poll clears the banner', async () => {
    const t = boot();
    let down = true;
    t.server.onRequest = (seen) => {
      if (seen.kind === 'poll' && down) throw new TypeError('fetch failed');
      return undefined;
    };
    const shown: string[] = [];
    t.api.subscribeConnection(() => shown.push(t.api.getConnectionStatus()));
    await settle();
    expect(t.api.getConnectionStatus()).toBe('offline');
    expect(t.cache.count('designs')).toBe(2); // reads continue from memory
    expect(t.poller.getState().failures).toBe(1);
    await settle(170); // 270 s
    down = false;
    await settle(200);
    // 100 fails, then +8, +16, +30, +30 ... until the network is back
    const seenTimes = times(t.server);
    expect(seenTimes.slice(0, 5)).toEqual([100, 108, 124, 154, 184]);
    expect(seenTimes[5] - seenTimes[4]).toBe(30);
    expect(t.api.getConnectionStatus()).toBe('ok');
    expect(shown).toEqual(['offline', 'ok']);
    expect(t.poller.getState().failures).toBe(0);
    // and the pace is 8 seconds again
    const last = seenTimes.slice(-3);
    expect(last[2] - last[1]).toBe(8);
  });

  it('the back-off is the one of the client: 8, 16, 30 and then 30', () => {
    expect([1, 2, 3, 4, 10].map(nextPollDelayMs)).toEqual([8000, 16000, 30000, 30000, 30000]);
  });

  it('the network coming back (the browser says online) polls at once instead of waiting out the back-off', async () => {
    const t = boot();
    let down = true;
    t.server.onRequest = (seen) => {
      if (seen.kind === 'poll' && down) throw new TypeError('fetch failed');
      return undefined;
    };
    await settle(40); // 100 fails, 108 fails, 124 fails: the next is at 154
    expect(t.api.getConnectionStatus()).toBe('offline');
    down = false;
    t.page.emit();
    await settle();
    expect(t.api.getConnectionStatus()).toBe('ok');
    expect(times(t.server).at(-1)).toBe(140);
  });

  it('a reply that is a server error (not a lost connection) also backs off, and the screen says it once', async () => {
    const t = boot();
    t.server.onRequest = (seen) =>
      seen.kind === 'poll'
        ? jsonResponse(500, {
            error: { code: 'JV_INTERNAL', message: 'x', details: {} },
            request_id: 'r',
          })
        : undefined;
    await settle(30);
    expect(t.api.getConnectionStatus()).toBe('ok'); // the server answered: it is not offline
    expect(t.poller.getState().failures).toBeGreaterThanOrEqual(2);
    expect(t.poller.getState().notice).toContain('Something went wrong on the server');
    t.server.onRequest = undefined;
    await settle(60);
    expect(t.poller.getState().failures).toBe(0);
    expect(t.poller.getState().notice).toBeNull();
  });
});

describe('T-E03 a gateway error followed by a normal reply shows "Waking up…" and then clears (C7, H7)', () => {
  it('the poll that gets an HTML page from a proxy is retried, shows the banner, and the next normal reply clears it', async () => {
    const t = boot();
    let tries = 0;
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll') return undefined;
      tries += 1;
      return tries <= 2 ? gatewayPage() : undefined; // two bad replies, then the app is awake
    };
    const shown: string[] = [];
    t.api.subscribeConnection(() => shown.push(t.api.getConnectionStatus()));
    await settle(0);
    expect(t.api.getConnectionStatus()).toBe('waking');
    await settle(1); // the second try, 1 second later: still asleep
    expect(t.api.getConnectionStatus()).toBe('waking');
    await settle(2); // the third, 2 seconds after: awake
    expect(t.api.getConnectionStatus()).toBe('ok');
    expect(shown).toEqual(['waking', 'ok']);
    expect(tries).toBe(3);
    expect(t.poller.getState()).toMatchObject({ failures: 0, polls: 1 });
  });

  it('a reply that is not JSON at all counts the same way', async () => {
    const t = boot();
    let tries = 0;
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll') return undefined;
      tries += 1;
      return tries === 1
        ? new Response('Service starting', {
            status: 200,
            headers: { 'content-type': 'text/plain' },
          })
        : undefined;
    };
    await settle(0);
    expect(t.api.getConnectionStatus()).toBe('waking');
    await settle(1);
    expect(t.api.getConnectionStatus()).toBe('ok');
  });

  it('a gateway that stays down for 30 seconds is a failed poll: the banner stays and the poller backs off', async () => {
    const t = boot();
    t.server.onRequest = (seen) => (seen.kind === 'poll' ? gatewayPage() : undefined);
    await settle(31);
    expect(t.api.getConnectionStatus()).toBe('waking');
    expect(t.poller.getState().failures).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ T-E01: the poll halves

describe('T-E01 a user deactivated while signed in is logged out at the next poll (A10, U6, C18)', () => {
  it('the next poll is a 401: memory is emptied, the poller stops, the login screen is up once, and nothing more is asked', async () => {
    const t = boot();
    await settle();
    expect(t.cache.size()).toBeGreaterThan(0);
    const audit = new Map([['row-1', 1]]); // a store of the owner's audit data, as WEB10 will register one
    t.session.registerLogoutHook(() => audit.clear());
    t.server.active = false; // the owner deactivates the person from the admin door
    await settle(8);
    expect(t.session.getState().status).toBe('signedOut');
    expect(t.cache.size()).toBe(0);
    expect(audit.size).toBe(0);
    expect(t.poller.getState().status).toBe('stopped');
    const asked = t.server.seen.length;
    await settle(300);
    expect(t.server.seen.length).toBe(asked); // no loop, no further call
    expect(t.server.count('me')).toBe(1); // `me` is for a 403, not for a 401
    expect(t.page.listenerCount()).toBe(0);
  });
});

describe('T-E01 a demoted owner loses sku_private and the audit data within one poll, and the screen calls me once and does not loop (U6, C4, C18)', () => {
  it("owner to biller: the poll is refused 403, `me` is asked once, memory is emptied and the biller's hydrate starts without sku-private", async () => {
    const t = boot();
    await settle();
    expect(t.cache.count('sku-private')).toBe(3);
    const audit = new Map([['row-1', 1]]);
    t.session.registerLogoutHook(() => audit.clear());
    const epoch = t.session.getState().epoch;
    const mes = t.server.count('me');
    t.server.role = 'biller'; // the owner demotes the person from the admin door
    await settle(8); // the next poll
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.session.getState()).toMatchObject({
      status: 'signedIn',
      role: 'biller',
      epoch: epoch + 1,
    });
    await settle(); // the hydrate of the biller
    expect(t.cache.count('sku-private')).toBe(0);
    expect(audit.size).toBe(0);
    expect(t.hydrator.getState()).toMatchObject({ status: 'ready', role: 'biller' });
    // no loop: five minutes on, `me` has been asked once for the change and the poll goes on as a biller
    await settle(300);
    expect(t.server.count('me')).toBe(mes + 1);
    const after = rounds(t.server).slice(-5);
    for (const round of after) {
      expect(Object.keys(round.cursors ?? {})).toHaveLength(14);
      expect(round.cursors).not.toHaveProperty('sku-private');
    }
    expect(t.poller.getState().failures).toBe(0);
  });

  it("staff to biller: the poll is answered, but its `role` is another than the session's: `me` is asked once and the screen hydrates again", async () => {
    const t = boot({}, { role: 'staff' });
    await settle();
    expect(Object.keys(rounds(t.server)[0].cursors ?? {})).toHaveLength(7);
    const mes = t.server.count('me');
    t.server.role = 'biller';
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.session.getState()).toMatchObject({ status: 'signedIn', role: 'biller' });
    await settle();
    expect(t.hydrator.getState()).toMatchObject({
      status: 'ready',
      role: 'biller',
      tablesTotal: 14,
    });
    await settle(120);
    expect(t.server.count('me')).toBe(mes + 1);
  });

  it('a 403 for a role that has not changed shows the error once, backs off, and does not ask `me` again for every 403', async () => {
    const t = boot();
    await settle();
    const mes = t.server.count('me');
    t.server.forbidden.add('customers'); // the server refuses a resource the screen had been allowed to read
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.session.getState()).toMatchObject({ status: 'signedIn', role: 'owner' });
    expect(t.poller.getState().notice).toBe('You are not allowed to do this.');
    expect(t.cache.count('designs')).toBe(2); // memory is kept: reads go on
    await settle(120); // 8, 16, 30 seconds apart: 403 each time, `me` not asked again
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.poller.getState().failures).toBeGreaterThanOrEqual(3);
    // the server allows it again: one good poll clears the notice, and a later 403 is looked at again
    t.server.forbidden.clear();
    await settle(31);
    expect(t.poller.getState()).toMatchObject({ failures: 0, notice: null });
    t.server.forbidden.add('customers');
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 2);
  });

  it('if `me` cannot be reached the 403 is a failed poll, and the next 403 asks again (nothing was learnt)', async () => {
    const t = boot();
    await settle();
    const mes = t.server.count('me');
    t.server.forbidden.add('customers');
    t.server.onRequest = (seen) => {
      if (seen.kind === 'me') throw new TypeError('fetch failed');
      return undefined;
    };
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 1);
    expect(t.session.getState().status).toBe('signedIn');
    expect(t.poller.getState().failures).toBe(1);
    await settle(8);
    expect(t.server.count('me')).toBe(mes + 2); // one `me` for each 403, no more
    expect(t.session.getState().role).toBe('owner');
  });

  it('a person whose `me` is refused with a 401 while the 403 is looked at ends at the login screen, with nothing left', async () => {
    const t = boot();
    await settle();
    t.server.role = 'biller';
    t.server.onRequest = (seen) =>
      seen.kind === 'me' ? refusal('JV_UNAUTHENTICATED', 401) : undefined;
    await settle(8);
    expect(t.session.getState().status).toBe('signedOut');
    expect(t.cache.size()).toBe(0);
    expect(t.poller.getState().status).toBe('stopped');
    const asked = t.server.seen.length;
    await settle(120);
    expect(t.server.seen.length).toBe(asked);
  });
});

// ------------------------------------------------------------------------------------------------ U8: the poller stops with the session

describe('T-E05 (clause) logout stops the poller (U8)', () => {
  it('a logout stops the polling and removes what it listened to; a poll that was on its way is not merged', async () => {
    const t = boot();
    await settle();
    expect(t.page.listenerCount()).toBeGreaterThan(0);
    let release: (() => void) | undefined;
    t.server.onRequest = (seen) => {
      if (seen.kind !== 'poll') return undefined;
      t.server.onRequest = undefined;
      return new Promise((resolve) => (release = () => resolve(undefined)));
    };
    t.server.put('designs', designOf(3, stampAt(105)));
    await settle(8); // the poll is held
    await t.session.signOut();
    expect(t.cache.size()).toBe(0);
    release?.();
    await settle(0);
    expect(t.cache.size()).toBe(0); // the answer arrived after the logout: not merged
    const asked = t.server.polls().length;
    await settle(120);
    expect(t.server.polls().length).toBe(asked);
    expect(t.poller.getState().status).toBe('stopped');
    expect(t.page.listenerCount()).toBe(0);
  });

  it('a new login starts the poller again, from the new hydrate', async () => {
    const t = boot();
    await settle();
    await t.session.signOut();
    await settle(30);
    const asked = t.server.polls().length;
    expect(await t.session.signIn('person@jv.test', 'a password for the test')).toEqual({
      error: null,
    });
    await settle();
    expect(t.hydrator.getState().status).toBe('ready');
    expect(t.server.polls().length).toBe(asked + 1);
    const again = rounds(t.server).at(-1) as Seen;
    expect(cursorOf(again, 'designs')).toEqual({ updated_at: t.hydrator.getState().pollFrom });
    await settle(8);
    expect(t.server.polls().length).toBe(asked + 2);
  });

  it('dispose() takes everything away', async () => {
    const t = boot();
    await settle();
    t.poller.dispose();
    expect(t.page.listenerCount()).toBe(0);
    const asked = t.server.polls().length;
    await settle(60);
    expect(t.server.polls().length).toBe(asked);
  });
});

// ------------------------------------------------------------------------------------------------ the client's hook for "any write"

describe('T-E02 the client tells when a write has finished (C4: at once after any write the screen made)', () => {
  function client() {
    const calls: Array<{ method: string; path: string; status: number }> = [];
    const fetchStub = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = new URL(String(input));
      const fail = url.pathname.includes('fail');
      const status = fail ? 500 : 200;
      calls.push({ method: init.method ?? 'GET', path: url.pathname, status });
      return new Response(
        JSON.stringify(
          fail
            ? { error: { code: 'JV_INTERNAL', message: 'x', details: {} }, request_id: 'r' }
            : { ok: true }
        ),
        { status, headers: { 'content-type': 'application/json' } }
      );
    });
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetchStub as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    return { api, calls };
  }

  it('runs after a write that worked, after one that failed, and not after a read or a call that saves nothing', async () => {
    const { api } = client();
    const seen = vi.fn();
    api.onWriteFinished(seen);
    await api.get('/v1/something');
    await api.post('/v1/poll-like', {}, { readOnly: true });
    expect(seen).not.toHaveBeenCalled();
    await api.post('/v1/designs', { x: 1 });
    expect(seen).toHaveBeenCalledTimes(1);
    await api.patch('/v1/designs/1', { x: 1 });
    await api.put('/v1/settings/x', { value: {} });
    expect(seen).toHaveBeenCalledTimes(3);
    await expect(api.post('/v1/fail', { x: 1 })).rejects.toThrow();
    expect(seen).toHaveBeenCalledTimes(4);
  });

  it('runs once after the write is over, not once for each try; a hook that throws does not break the call; the way to stop works', async () => {
    const { api } = client();
    const first = vi.fn(() => {
      throw new Error('a broken hook');
    });
    const second = vi.fn();
    const off = api.onWriteFinished(first);
    api.onWriteFinished(second);
    await expect(api.post('/v1/designs', { x: 1 })).resolves.toEqual({ ok: true });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(1);
    off();
    await api.post('/v1/designs', { x: 2 });
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).toHaveBeenCalledTimes(2);
  });
});
