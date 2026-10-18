'use client';

// The first hydrate behind the loading gate (spec C2, C3, U7, U8). Task WEB03.
//
// After a login, at start-up and after a change of role, every resource the role may read is loaded into the cache (cache.ts) by
// GET /v1/sync/<resource>. A page holds at most 1,000 rows and `next` is where the following page starts: the loader asks again from the
// cursor the server hands back, so it advances by the rows it RECEIVED and a server that caps its pages lower than the page asked for (500, the
// T-F03 case) is followed to the end. It stops when `next` is null. The tables of the stock side go first, the money side after them, and
// three tables at a time are in flight, so one browser never crowds the API's pool of 8 connections.
//
// The gate (AppLayout) shows no data page until the load of THIS role and THIS session epoch is whole. While it runs it shows "3 of 8 tables"; if
// any page fails it shows the plain message and a retry button, and what had arrived is thrown away: there is never sample data and never a
// half-filled list behind the gate (D20). A retry starts again from the first page.
//
// The first poll after a hydrate (WEB04) starts from the `server_time` of the hydrate's FIRST page minus 30 seconds, not from the stamp of the last row
// (C3): a row stamped but not yet committed when its page was read would otherwise be lost for good. Several tables are asked for at once here, so
// the first page is the one asked for earliest: `firstServerTime` is the earliest `server_time` of the first pages, and `pollFrom` is that minus
// 30 s as the exact six-decimal text. The poller must not start before the state is 'ready'.
//
// U8: the logout hook of the session store (registered below, once) resets this loader and empties the cache; a load that is still running is
// aborted, and a page that arrives after the reset is not merged.
import { useSyncExternalStore } from 'react';
import { api as siteApi, isApiError, type ApiClient } from '@/lib/api/client';
import type { SyncNext, SyncPage, SyncResource, SyncRows } from '@/lib/api/types';
import {
  PREVIEW_MODE,
  registerLogoutHook,
  reviewRole as siteReviewRole,
  type AuthRole,
  type RoleReview,
} from '@/lib/authStore';
import { CacheDataError, rowCache, type RowCache } from './cache';
import { StampError, stampMicros, stampMinusSeconds } from './stamp';

/** C3: a page holds at most 1,000 rows (the API's constant; asking for more is refused). */
export const HYDRATE_PAGE_ROWS = 1000;
/** C3, C4: the first poll starts this many seconds before the first page of the hydrate was read. */
export const FIRST_POLL_OVERLAP_S = 30;
/** Tables in flight at once. */
export const HYDRATE_CONCURRENCY = 3;
/** A table of more than this many pages is a server that does not end: stop. (2,000 pages is two million rows.) */
const MAX_PAGES_PER_TABLE = 2000;

const COULD_NOT_LOAD = 'The data could not be loaded. Try again.';

// ------------------------------------------------------------------------------------------------ what each role reads (A4, C3)

/** The stock side: loaded first. */
export const STOCK_SIDE: readonly SyncResource[] = [
  'settings',
  'daily-rates',
  'categories',
  'subcategories',
  'designs',
  'skus',
  'sku-private',
];
/** The money side, after the stock side and the people. */
export const MONEY_SIDE: readonly SyncResource[] = [
  'customers',
  'bills',
  'bill-summary',
  'bill-items',
  'receipts',
  'receipt-allocations',
  'customer-balances',
];
const HYDRATE_ORDER: readonly SyncResource[] = [...STOCK_SIDE, 'users', ...MONEY_SIDE];

// The roles of the permission matrix of the API (A4, C3): the owner reads all 15; the biller all but the owner-only weight; staff the stock, the
// categories, the rates, the settings and the people. A role is asked for nothing it may not read, because the API answers the whole call
// 403 for one resource it forbids. tests/e2e/hydrate.spec.ts checks this table against the real API for each role.
const NOT_READ: Record<AuthRole, readonly SyncResource[]> = {
  owner: [],
  biller: ['sku-private'],
  staff: ['sku-private', ...MONEY_SIDE],
};

/** The resources a role loads, the stock side first. */
export function resourcesFor(role: AuthRole): SyncResource[] {
  return HYDRATE_ORDER.filter((resource) => !NOT_READ[role].includes(resource));
}

// ------------------------------------------------------------------------------------------------ the state

export type HydrateStatus = 'idle' | 'loading' | 'ready' | 'error';

export interface HydrateState {
  status: HydrateStatus;
  /** The role and the session epoch this state is for (null while idle). The gate opens only for the role and epoch of the session. */
  role: AuthRole | null;
  epoch: number | null;
  tablesDone: number;
  tablesTotal: number;
  rowsLoaded: number;
  /** The plain message of a failed load, or null. */
  error: string | null;
  /** The earliest `server_time` of the first pages, once the load is whole. */
  firstServerTime: string | null;
  /** `firstServerTime` minus 30 seconds: where the first poll starts (C3). */
  pollFrom: string | null;
}

const IDLE: HydrateState = {
  status: 'idle',
  role: null,
  epoch: null,
  tablesDone: 0,
  tablesTotal: 0,
  rowsLoaded: 0,
  error: null,
  firstServerTime: null,
  pollFrom: null,
};

/** "3 of 8 tables" (C2). */
export function progressText(state: Pick<HydrateState, 'tablesDone' | 'tablesTotal'>): string {
  return `${state.tablesDone} of ${state.tablesTotal} tables`;
}

/** C2, U7: may the page body be shown? Only when the load that is whole is the load of this role in this session epoch. */
export function isGateOpen(state: HydrateState, role: AuthRole | null, epoch: number): boolean {
  return state.status === 'ready' && role !== null && state.role === role && state.epoch === epoch;
}

// ------------------------------------------------------------------------------------------------ the loader

export interface HydrateDeps {
  api: Pick<ApiClient, 'syncPage'>;
  cache: RowCache;
  /** A 403 from a page: ask the session whether the role changed (U6). Default: the site's `reviewRole`. */
  reviewRole?: () => Promise<RoleReview>;
  /** A preview build has no API: the stores hold sample data and the gate is open. */
  preview?: boolean;
  pageLimit?: number;
  concurrency?: number;
}

export interface Hydrator {
  getState(): HydrateState;
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  /** Loads everything `role` may read, for this session epoch. Asked again for the same role and epoch (every page asks), it does nothing; an error waits for `retry`. */
  start(role: AuthRole, epoch: number): void;
  /** The retry button: empties what had arrived and loads again from the first page. */
  retry(): void;
  /** U8: stops a load that is running, empties the cache, closes the gate. */
  reset(): void;
  /** Resolves when the load that is running has ended, however it ended. */
  settled(): Promise<void>;
}

interface Job {
  role: AuthRole;
  epoch: number;
  controller: AbortController;
  /** Work stops: a reset, a newer load, or a failure of one table. */
  stopped: boolean;
  rows: number;
  tablesDone: number;
  first: { micros: number; text: string } | null;
  reviewed: boolean;
  done: Promise<void>;
}

export function createHydrator(deps: HydrateDeps): Hydrator {
  const { api, cache } = deps;
  const preview = deps.preview ?? false;
  const pageLimit = deps.pageLimit ?? HYDRATE_PAGE_ROWS;
  const concurrency = Math.max(1, deps.concurrency ?? HYDRATE_CONCURRENCY);
  const listeners = new Set<() => void>();
  let state: HydrateState = IDLE;
  let current: Job | null = null;

  function setState(next: HydrateState): void {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  }

  function stop(job: Job | null): void {
    if (!job) return;
    job.stopped = true;
    job.controller.abort();
  }

  /** One table, page by page, following the cursor the server hands back. */
  async function loadTable(job: Job, resource: SyncResource): Promise<void> {
    let cursor: SyncNext | null = null;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_PAGES_PER_TABLE)
        throw new CacheDataError(resource, 'more pages than any shop has');
      const answer: SyncPage<SyncRows[SyncResource]> = await api.syncPage(resource, {
        updatedAfter: cursor?.updated_at,
        afterKey: cursor?.key,
        limit: pageLimit,
        signal: job.controller.signal,
      });
      if (job.stopped) return; // the person left, or another table failed: this page is not wanted
      if (!answer || !Array.isArray(answer.rows))
        throw new CacheDataError(resource, 'no list of rows');
      const seen = stampMicros(answer.server_time); // a StampError when the API's clock is not the exact text
      if (page === 0 && (job.first === null || seen < job.first.micros)) {
        job.first = { micros: seen, text: answer.server_time };
      }
      cache.merge(resource, answer.rows);
      job.rows += answer.rows.length;
      if (current === job) setState({ ...state, rowsLoaded: job.rows });
      const next = answer.next;
      if (!next) return;
      // `next` must move forward: a server that hands back the cursor it was given, or says there is more on an empty page, would be asked for ever
      const stuck =
        answer.rows.length === 0 ||
        (cursor !== null && next.updated_at === cursor.updated_at && next.key === cursor.key);
      if (stuck) throw new CacheDataError(resource, 'a cursor that does not move');
      cursor = next;
    }
  }

  async function run(job: Job): Promise<void> {
    const queue = resourcesFor(job.role);
    const worker = async (): Promise<void> => {
      for (;;) {
        if (job.stopped) return;
        const resource = queue.shift();
        if (!resource) return;
        await loadTable(job, resource);
        if (job.stopped) return;
        job.tablesDone += 1;
        if (current === job) setState({ ...state, tablesDone: job.tablesDone });
      }
    };
    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
    } catch (error) {
      stop(job); // the tables still running stop too
      await fail(job, error);
      return;
    }
    if (current !== job || job.stopped) return;
    const first = job.first;
    setState({
      ...state,
      status: 'ready',
      tablesDone: job.tablesDone,
      rowsLoaded: job.rows,
      error: null,
      firstServerTime: first ? first.text : null,
      pollFrom: first ? stampMinusSeconds(first.text, FIRST_POLL_OVERLAP_S) : null,
    });
  }

  async function fail(job: Job, error: unknown): Promise<void> {
    if (current !== job) return; // the person left, or a newer load took over: a late error is nobody's business
    // U6: a 403 for a role that has just been changed is not an error to show; the session asks `me` (once) and, when the role is another, runs the hooks
    // (this loader is reset) and opens the gate again, which starts the load of the new role.
    if (isApiError(error) && error.code === 'JV_FORBIDDEN' && !job.reviewed) {
      job.reviewed = true;
      const review = deps.reviewRole ?? siteReviewRole;
      try {
        await review();
      } catch {
        // the answer is only used to find out whether the role changed; the error below is shown either way
      }
      if (current !== job) return;
    }
    cache.clear(); // no half-filled list behind the gate, and nothing that could be taken for data
    setState({
      ...state,
      status: 'error',
      error: messageOf(error),
      firstServerTime: null,
      pollFrom: null,
    });
  }

  function messageOf(error: unknown): string {
    if (isApiError(error)) return error.message;
    // the details go to the console, never to the screen: a name and a message that holds no value
    if (error instanceof CacheDataError || error instanceof StampError) {
      console.warn('The data could not be loaded:', error.name, error.message);
    } else {
      console.warn(
        'The data could not be loaded:',
        error instanceof Error ? error.name : typeof error
      );
    }
    return COULD_NOT_LOAD;
  }

  function begin(role: AuthRole, epoch: number): void {
    stop(current);
    cache.clear();
    const job: Job = {
      role,
      epoch,
      controller: new AbortController(),
      stopped: false,
      rows: 0,
      tablesDone: 0,
      first: null,
      reviewed: false,
      done: Promise.resolve(),
    };
    current = job;
    setState({
      status: 'loading',
      role,
      epoch,
      tablesDone: 0,
      tablesTotal: resourcesFor(role).length,
      rowsLoaded: 0,
      error: null,
      firstServerTime: null,
      pollFrom: null,
    });
    job.done = run(job);
  }

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start: (role, epoch) => {
      if (preview) return;
      if (state.status !== 'idle' && state.role === role && state.epoch === epoch) return;
      begin(role, epoch);
    },
    retry: () => {
      if (preview || state.status !== 'error' || state.role === null || state.epoch === null)
        return;
      begin(state.role, state.epoch);
    },
    reset: () => {
      stop(current);
      current = null;
      cache.clear();
      if (state !== IDLE) setState(IDLE);
    },
    settled: () => (current ? current.done : Promise.resolve()),
  };
}

// ------------------------------------------------------------------------------------------------ the session

/**
 * U8: registers the one logout hook of the cache. Every end of a session (a logout, the idle logout, any 401, another person signing in, a change of
 * role) runs it: the load that is running stops, the memory is emptied and the gate closes. Returns the way to take the hook away again.
 */
export function bindToSession(
  hydrator: Pick<Hydrator, 'reset'>,
  register: (hook: () => void) => () => void
): () => void {
  return register(() => hydrator.reset());
}

// ------------------------------------------------------------------------------------------------ the loader of the site

/** The loader of this page load, over the site's API client and the site's cache. */
export const hydrator: Hydrator = createHydrator({
  api: siteApi,
  cache: rowCache,
  reviewRole: siteReviewRole,
  preview: PREVIEW_MODE,
});
bindToSession(hydrator, registerLogoutHook);

export const startHydrate = hydrator.start;
export const retryHydrate = hydrator.retry;
export const getHydrateState = hydrator.getState;

/** For the loading gate of the layout. The server and the first client render say "idle", so the HTML matches. */
export function useHydrate(): HydrateState {
  return useSyncExternalStore(hydrator.subscribe, hydrator.getState, () => IDLE);
}
