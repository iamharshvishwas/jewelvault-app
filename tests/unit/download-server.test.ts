import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/lib/api/client';
import type { AuthRole } from '@/lib/authStore';
import { createRowCache, type RowCache } from '@/lib/cache/cache';
import {
  createDownloadServer,
  type DownloadServer,
  type DownloadServerDeps,
} from '@/lib/cache/downloadServer';
import type { HydrateState } from '@/lib/cache/hydrate';
import type { PollState } from '@/lib/cache/poll';
import { DOWNLOAD_FILES } from '@/lib/downloadEverything';
import { parseCsv } from './support/csv';
import { billRow, customerRow } from './support/money-rows';
import { categoryRow, settingRow, userRow, uuid } from './support/rows';
import { readZipText } from './support/zip';

// T-E04 / T-R05 (the screen half of Download everything, B3; task WEB12b): the flow behind the owner's button. It brings the screen up to date with a FRESH poll (one that starts after the press),
// builds the zip from memory as it is after that poll, hands the file to the browser, then posts the record `{date, counts}` (API35), then reads the dashboard line again. Every refusal is a plain
// sentence and says whether the file was saved. The real browser and the real API are tests/e2e/hidden-and-download.spec.ts.

// ---------------------------------------------------------------------------------------------- the pieces, made by hand

function fakePoller(order: string[]) {
  let state: PollState = {
    status: 'idle',
    failures: 0,
    notice: null,
    polls: 3,
    lastServerTime: null,
  };
  const listeners = new Set<() => void>();
  const set = (patch: Partial<PollState>) => {
    state = { ...state, ...patch };
    for (const l of Array.from(listeners)) l();
  };
  /** What the next polls do, in order: 'ok' completes one, 'fail' fails one, 'hang' never ends. */
  const script: Array<'ok' | 'fail' | 'hang'> = [];
  /** Runs when a poll completes ok (a poll brings in the rows other people wrote). */
  let onOk: () => void = () => {};
  const step = () => {
    const next = script.shift() ?? 'ok';
    if (next === 'hang') return;
    queueMicrotask(() => {
      if (next === 'ok') {
        onOk();
        set({ status: 'idle', polls: state.polls + 1, failures: 0 });
      } else
        set({
          status: 'idle',
          failures: state.failures + 1,
          notice: 'The latest changes could not be loaded.',
        });
    });
  };
  return {
    getState: () => state,
    subscribe: (l: () => void) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    pollNow: vi.fn(() => {
      order.push('poll');
      // a poll on its way ends first, and one more follows it (the real poller: `again`)
      if (state.status === 'polling') {
        step();
        queueMicrotask(() => {
          set({ status: 'polling' });
          step();
        });
        return;
      }
      set({ status: 'polling' });
      step();
    }),
    set,
    script,
    onOk: (fn: () => void) => {
      onOk = fn;
    },
  };
}

const OK_ROLE: AuthRole = 'owner';

interface Rig {
  server: DownloadServer;
  cache: RowCache;
  poller: ReturnType<typeof fakePoller>;
  order: string[];
  saved: Array<{ zip: Uint8Array; filename: string }>;
  posts: Array<{ path: string; body: unknown }>;
  hydrate: { current: HydrateState['status'] };
  role: { current: AuthRole | null };
  postAnswer: { current: () => Promise<unknown> };
  logoutHooks: Array<() => void>;
  deps: DownloadServerDeps;
}

function rig(over: Partial<DownloadServerDeps> = {}): Rig {
  const cache = createRowCache();
  cache.merge('users', [userRow(1)]);
  cache.merge('settings', [settingRow('data_epoch', 1)]);
  cache.merge('customers', [customerRow(uuid(5101), { name: 'Meera Shah' })]);
  cache.merge('categories', [categoryRow(1, 'Ring', 'RING')]);
  const order: string[] = [];
  const poller = fakePoller(order);
  const saved: Rig['saved'] = [];
  const posts: Rig['posts'] = [];
  const hydrate = { current: 'ready' as HydrateState['status'] };
  const role = { current: OK_ROLE as AuthRole | null };
  const logoutHooks: Array<() => void> = [];
  const postAnswer = {
    current: async () => ({
      last_download: { at: '2026-10-19T06:30:00.000Z', by: uuid(901), counts: {} },
    }),
  };
  const deps: DownloadServerDeps = {
    api: {
      post: (async (path: string, body: unknown) => {
        order.push('post');
        posts.push({ path, body });
        return postAnswer.current();
      }) as unknown as DownloadServerDeps['api']['post'],
    },
    cache,
    poller,
    hydrator: { getState: () => ({ status: hydrate.current }) as HydrateState },
    role: () => role.current,
    save: (zip, filename) => {
      order.push('save');
      saved.push({ zip, filename });
    },
    now: () => new Date(Date.UTC(2026, 9, 19, 6, 30, 0)), // 12:00 in India on 19 Oct
    reloadHealth: async () => {
      order.push('reloadHealth');
    },
    registerLogoutHook: (hook) => {
      logoutHooks.push(hook);
      return () => undefined;
    },
    pollTimeoutMs: 5000,
    ...over,
  };
  return {
    server: createDownloadServer(deps),
    cache,
    poller,
    order,
    saved,
    posts,
    hydrate,
    role,
    postAnswer,
    logoutHooks,
    deps,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const csvOf = (zip: Uint8Array, name: string) => parseCsv(readZipText(zip).get(name) ?? '');

describe('T-E04 / T-R05 the happy path: a fresh poll, the zip from memory, the file, the record, the line', () => {
  it('does these things in this order, once each', async () => {
    const r = rig();
    const state = await r.server.run();
    expect(r.order).toEqual(['poll', 'save', 'post', 'reloadHealth']);
    expect(state.status).toBe('done');
    expect(r.server.getState()).toBe(state);
  });

  it('builds the zip from memory AFTER the poll: a row the poll brought in is in the file and in the count', async () => {
    const r = rig();
    r.poller.onOk(() => {
      r.cache.merge('customers', [customerRow(uuid(5102), { name: 'Brought by the poll' })]);
    });
    await r.server.run();
    const customers = csvOf(r.saved[0].zip, 'customers.csv');
    expect(customers.rows.map((row) => row[customers.header.indexOf('name')]).sort()).toEqual([
      'Brought by the poll',
      'Meera Shah',
    ]);
    expect((r.posts[0].body as { counts: Record<string, number> }).counts.customers).toBe(2);
  });

  it('saves the zip under its name and posts to the record route of the owner: the business date and the twelve counts by table, whole numbers, nothing else', async () => {
    const r = rig();
    await r.server.run();
    expect(r.saved).toHaveLength(1);
    expect(r.saved[0].filename).toBe('download-everything-2026-10-19.zip');
    expect(r.posts).toHaveLength(1);
    expect(r.posts[0].path).toBe('/v1/owner/download-record');
    const body = r.posts[0].body as { date: string; counts: Record<string, number> };
    expect(Object.keys(body).sort()).toEqual(['counts', 'date']);
    expect(body.date).toBe('2026-10-19');
    expect(Object.keys(body.counts).sort()).toEqual([...DOWNLOAD_FILES].sort());
    for (const value of Object.values(body.counts)) expect(Number.isInteger(value)).toBe(true);
    // the counts are the rows of the files, which are the numbers in MANIFEST.csv
    const manifest = csvOf(r.saved[0].zip, 'MANIFEST.csv');
    for (const [name, rows] of manifest.rows)
      expect(Number(rows)).toBe(body.counts[name.replace(/\.csv$/, '')]);
    expect(body.counts.customers).toBe(1);
    expect(body.counts.categories).toBe(1);
    expect(body.counts.bills).toBe(0);
  });

  it("the business date is the Asia/Kolkata one, not the computer's: 19:00 UTC on the 19th is already the 20th in India", async () => {
    const r = rig({ now: () => new Date(Date.UTC(2026, 9, 19, 19, 0, 0)) });
    await r.server.run();
    expect((r.posts[0].body as { date: string }).date).toBe('2026-10-20');
    expect(r.saved[0].filename).toBe('download-everything-2026-10-20.zip');
  });

  it('says what was done, with the name of the file', async () => {
    const r = rig();
    const state = await r.server.run();
    expect(state).toMatchObject({
      status: 'done',
      filename: 'download-everything-2026-10-19.zip',
      date: '2026-10-19',
    });
  });
});

describe('T-E04 a FRESH poll: one that starts after the press', () => {
  it('when a poll is already on its way, that poll is not enough: the zip waits for the one behind it', async () => {
    const r = rig();
    r.poller.set({ status: 'polling' });
    let polls = 0;
    r.poller.onOk(() => {
      polls += 1;
      // only the second poll sees the new customer, as a poll that started before the press would not
      if (polls === 2)
        r.cache.merge('customers', [customerRow(uuid(5103), { name: 'Written just now' })]);
    });
    await r.server.run();
    expect(polls).toBe(2);
    const customers = csvOf(r.saved[0].zip, 'customers.csv');
    expect(customers.rows.map((row) => row[customers.header.indexOf('name')])).toContain(
      'Written just now'
    );
  });

  it('a poll that fails means no file, no record: the screen could not be brought up to date', async () => {
    const r = rig();
    r.poller.script.push('fail');
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: false });
    expect((state as { message: string }).message).toMatch(/brought up to date|up to date/i);
    expect(r.saved).toEqual([]);
    expect(r.posts).toEqual([]);
    expect(r.order).not.toContain('reloadHealth');
  });

  it('a poll that never ends is given up after the time allowed', async () => {
    const r = rig();
    r.poller.script.push('hang');
    const running = r.server.run();
    await vi.advanceTimersByTimeAsync(5000);
    const state = await running;
    expect(state).toMatchObject({ status: 'failed', fileSaved: false });
    expect(r.saved).toEqual([]);
    expect(r.posts).toEqual([]);
  });
});

describe('T-E04 the refusals before anything is made', () => {
  it.each(['biller', 'staff', null] as const)(
    'a %s is told that only the owner can do this, and nothing is polled, saved or posted',
    async (role) => {
      const r = rig();
      r.role.current = role;
      const state = await r.server.run();
      expect(state).toMatchObject({ status: 'failed', fileSaved: false });
      expect((state as { message: string }).message).toMatch(/only the owner/i);
      expect(r.order).toEqual([]);
    }
  );

  it('while the books are still loading nothing is made', async () => {
    const r = rig();
    r.hydrate.current = 'loading';
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: false });
    expect((state as { message: string }).message).toMatch(/loading|loaded/i);
    expect(r.order).toEqual([]);
  });

  it('an empty memory is not zipped: the books are not loaded', async () => {
    const r = rig();
    r.cache.clear();
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: false });
    expect((state as { message: string }).message).toMatch(/not loaded/i);
    expect(r.saved).toEqual([]);
    expect(r.posts).toEqual([]);
  });

  it('a browser that will not save the file stops the record: nothing is recorded for a file that does not exist', async () => {
    const r = rig({
      save: () => {
        throw new Error('blocked');
      },
    });
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: false });
    expect(r.posts).toEqual([]);
  });
});

describe('T-E04 / T-R05 a record the API refuses leaves the old date, and the person is told the file was saved', () => {
  it('counts that do not match (JV_INVALID_INPUT on counts.customers): the file is saved, the record is not, the line is not reloaded as if it were', async () => {
    const r = rig();
    r.postAnswer.current = async () => {
      throw new ApiError({
        code: 'JV_INVALID_INPUT',
        status: 422,
        message: 'does not match the books',
        details: { field: 'counts.customers' },
        write: true,
      });
    };
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: true });
    const message = (state as { message: string }).message;
    expect(message).toMatch(/saved/i);
    expect(message).toMatch(/not recorded|could not be recorded|was not recorded/i);
    expect(r.saved).toHaveLength(1);
    expect(r.order).not.toContain('reloadHealth');
  });

  it('a lost connection on the record says the same, with the plain sentence of the connection', async () => {
    const r = rig();
    r.postAnswer.current = async () => {
      throw new ApiError({
        code: 'NETWORK',
        status: 0,
        message: 'Could not reach the server. Check the connection.',
        write: true,
      });
    };
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: true });
    expect((state as { message: string }).message).toContain('Could not reach the server');
  });

  it("an error that is not the API's (a bug) still ends in a sentence, not a stuck button", async () => {
    const r = rig();
    r.postAnswer.current = async () => {
      throw new TypeError('x is undefined');
    };
    const state = await r.server.run();
    expect(state).toMatchObject({ status: 'failed', fileSaved: true });
    expect((state as { message: string }).message).not.toContain('undefined');
  });
});

describe('T-E04 one run at a time, and a clean slate after a logout', () => {
  it('a double click is one run: one poll, one file, one record', async () => {
    const r = rig();
    const first = r.server.run();
    const second = r.server.run();
    expect(second).toBe(first);
    await first;
    expect(r.saved).toHaveLength(1);
    expect(r.posts).toHaveLength(1);
  });

  it('the state moves through the steps for the screen: working with a sentence, then done; a new press after a result starts again', async () => {
    const r = rig();
    const seen: string[] = [];
    r.server.subscribe(() => seen.push(r.server.getState().status));
    expect(r.server.getState().status).toBe('idle');
    await r.server.run();
    expect(seen).toContain('working');
    expect(seen[seen.length - 1]).toBe('done');
    await r.server.run();
    expect(r.saved).toHaveLength(2);
  });

  it('a logout forgets the result: the next person starts from idle', async () => {
    const r = rig();
    await r.server.run();
    expect(r.server.getState().status).toBe('done');
    for (const hook of r.logoutHooks) hook();
    expect(r.server.getState().status).toBe('idle');
  });

  it("a result can be put away by the person (the card's dismiss)", async () => {
    const r = rig();
    r.poller.script.push('fail');
    await r.server.run();
    expect(r.server.getState().status).toBe('failed');
    r.server.dismiss();
    expect(r.server.getState().status).toBe('idle');
  });
});

describe('T-E04 the billing rows in the file are the books of the cache (a bill, to be sure)', () => {
  it('bills.csv holds the bill in memory', async () => {
    const r = rig();
    r.cache.merge('bills', [billRow(1, uuid(5101), { grand_total: '1500.00' })]);
    await r.server.run();
    const bills = csvOf(r.saved[0].zip, 'bills.csv');
    expect(bills.rows).toHaveLength(1);
    expect(bills.rows[0][bills.header.indexOf('grand_total')]).toBe('1500.00');
  });
});
