// The two reads of the books that are not sync resources (spec C3, V4, I11, I12; task WEB12).
//
// `appStore.ts` must import no client (C9: the screens that re-read it every second make no network call, tests/unit/memory-reads.test.ts), so the network side of the money figures is
// here, as the ledger of a customer is in moneyServer.ts, and the store reads what this leaves in memory.
//
//   THE CASH BOOK (V4, `GET /v1/daily-totals?from=&to=`). Not part of the hydrate: the evening check of the dashboard and the Payments report ask for a range of business dates, and keep it
//   current. The owner reads up to 400 days in one call, the biller today and yesterday (O25); the screens ask for the day or the month, never for more. A range that is watched is read
//   when the first screen watches it, and again whenever the receipts in memory change (a payment, a refund, a void, a bill with payment rows: every one of them is a `receipts` row, and the
//   client polls at once after every write, C17). A read that fails keeps the rows of the earlier read, says why, and waits for the next change of the receipts or a "Try again".
//
//   THE DASHBOARD LINE (`GET /v1/dashboard/health` and the newest row of `GET /v1/health/checks?limit=1`, the owner only). Read when the dashboard opens and every few minutes while it
//   is watched: the line changes at the pace of the nightly jobs, not of the shop. The first call is the line itself (the API works out the level and the reasons); the second brings the
//   review counts of the last check (I11) and is allowed to fail on its own without taking the line away.
//
// Nothing is worked out here. A logout (U8) forgets all of it, and a read that was on its way is thrown away when it arrives.
import { api as siteApi, isApiError, type ApiClient } from '@/lib/api/client';
import type {
  CheckRunWire,
  DailyTotalWire,
  DailyTotalsResponse,
  DashboardHealth,
  HealthChecksResponse,
  ReviewWire,
} from '@/lib/api/types';
import { registerLogoutHook as siteRegisterLogoutHook } from '@/lib/authStore';
import { rowCache, type RowCache } from './cache';

export type LoadState = 'idle' | 'loading' | 'ready' | 'failed';

/** What a watched range of the cash book holds right now. A new object whenever something in it changes. */
export interface DailyTotalsView {
  rows: readonly DailyTotalWire[];
  state: LoadState;
  /** The plain sentence of the failure, when the last read failed. */
  message: string | null;
  /** The range has been read at least once: `rows` are then the answer of a read, and a reload in progress ('loading') still shows them. */
  loaded: boolean;
}

/** What the dashboard line holds right now. */
export interface HealthView {
  state: LoadState;
  message: string | null;
  health: DashboardHealth | null;
  /** The review line of the last nightly check; null before it is read, or when the check carries none. */
  review: ReviewWire | null;
  /** When the second call failed: the line is shown without the review counts and says so. */
  reviewMessage: string | null;
}

export interface BooksServerDeps {
  api: Pick<ApiClient, 'get'>;
  cache: RowCache;
  /** The session's way of hearing about a logout (U8). Returns the way to stop. */
  registerLogoutHook: (hook: () => void) => () => void;
  /** Test seam: the timer of the dashboard line's refresh. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

export interface BooksServer {
  /** The cash book of the range as last read; empty and idle before the first read. */
  dailyTotals(from: string, to: string): DailyTotalsView;
  /** A screen shows this range: read it, and keep it current. Returns the way to stop (twice is once). */
  watchDailyTotals(from: string, to: string): () => void;
  /** Reads the range now. A second call while one is on its way joins it. Never rejects: a failure is in the view. */
  reloadDailyTotals(from: string, to: string): Promise<void>;
  healthView(): HealthView;
  /** The dashboard shows the line: read it, and read it again every few minutes. Returns the way to stop. */
  watchHealth(): () => void;
  /** Reads the line now (after a Download everything, WEB12b). Never rejects. */
  reloadHealth(): Promise<void>;
  /** Called after every change of what this holds; returns the way to stop. For `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** Moves on with every change of what this holds. */
  version(): number;
  reset(): void;
  /** Resolves when no read is on its way. */
  idle(): Promise<void>;
  dispose(): void;
}

/** The dashboard line is read again this often while it is on a screen. */
export const HEALTH_REFRESH_MS = 5 * 60 * 1000;

const EMPTY_ROWS: readonly DailyTotalWire[] = Object.freeze([]);
const EMPTY_TOTALS: DailyTotalsView = Object.freeze({
  rows: EMPTY_ROWS,
  state: 'idle',
  message: null,
  loaded: false,
}) as DailyTotalsView;
const COULD_NOT_LOAD_TOTALS = "Today's cash book could not be loaded. Try again.";
const COULD_NOT_LOAD_HEALTH = 'The health of the books could not be loaded. Try again.';
const COULD_NOT_LOAD_REVIEW = "Yesterday's review could not be loaded.";

interface TotalsSlot {
  view: DailyTotalsView;
  /** The version of the receipts in memory when the last read began: another version now means the rows may be out of date. */
  readAt: string | null;
  inflight: Promise<void> | null;
  watchers: number;
}

/** The newest nightly check's review line, if it carries one. */
function reviewOf(row: CheckRunWire | undefined): ReviewWire | null {
  const review = row?.details?.review;
  return review && typeof review === 'object' ? review : null;
}

export function createBooksServer(deps: BooksServerDeps): BooksServer {
  const { api, cache } = deps;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as never));
  let generation = 0;
  let counter = 0;
  const listeners = new Set<() => void>();
  const pending = new Set<Promise<void>>();
  let unsubscribeCache: (() => void) | null = null;

  const changed = () => {
    counter += 1;
    for (const listener of Array.from(listeners)) listener();
  };
  const track = (run: Promise<void>) => {
    pending.add(run);
    void run.finally(() => pending.delete(run));
  };

  // ---- the cash book
  const totals = new Map<string, TotalsSlot>();
  const keyOf = (from: string, to: string) => `${from}..${to}`;
  const slotOf = (from: string, to: string): TotalsSlot => {
    const key = keyOf(from, to);
    let slot = totals.get(key);
    if (!slot) {
      slot = { view: EMPTY_TOTALS, readAt: null, inflight: null, watchers: 0 };
      totals.set(key, slot);
    }
    return slot;
  };
  const receiptsNow = () => cache.versionOf('receipts');

  function checkTotals(from: string, to: string): void {
    const slot = totals.get(keyOf(from, to));
    if (!slot || slot.watchers === 0 || slot.inflight) return;
    if (slot.view.state === 'idle' || slot.readAt !== receiptsNow()) void reloadTotals(from, to);
  }
  function checkAllTotals(): void {
    for (const [key, slot] of totals) {
      if (slot.watchers === 0) continue;
      const [from, to] = key.split('..');
      checkTotals(from, to);
    }
  }

  function reloadTotals(from: string, to: string): Promise<void> {
    const slot = slotOf(from, to);
    if (slot.inflight) return slot.inflight;
    const mine = generation;
    const readAt = receiptsNow(); // before the read: a receipt that arrives during it is seen as a change
    slot.view = { ...slot.view, state: 'loading', message: null };
    changed();
    const run = (async () => {
      try {
        const answer = await api.get<DailyTotalsResponse>('/v1/daily-totals', {
          query: { from, to },
        });
        if (mine !== generation) return;
        slot.view = { rows: answer.rows, state: 'ready', message: null, loaded: true };
      } catch (error) {
        if (mine !== generation) return;
        // a reload that fails keeps the rows of the read before it
        slot.view = {
          rows: slot.view.rows,
          state: 'failed',
          message: isApiError(error) ? error.message : COULD_NOT_LOAD_TOTALS,
          loaded: slot.view.loaded,
        };
      } finally {
        if (mine === generation) {
          slot.readAt = readAt;
          slot.inflight = null;
          changed();
        }
      }
      checkTotals(from, to); // the receipts moved on while this was read: once more
    })();
    slot.inflight = run;
    track(run);
    return run;
  }

  function watchTotals(from: string, to: string): () => void {
    const slot = slotOf(from, to);
    slot.watchers += 1;
    unsubscribeCache ??= cache.subscribe(checkAllTotals);
    checkTotals(from, to);
    const watched = generation;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (watched !== generation) return; // a logout already forgot it
      slot.watchers = Math.max(0, slot.watchers - 1);
      if (![...totals.values()].some((s) => s.watchers > 0)) {
        unsubscribeCache?.();
        unsubscribeCache = null;
      }
    };
  }

  // ---- the dashboard line
  let health: HealthView = {
    state: 'idle',
    message: null,
    health: null,
    review: null,
    reviewMessage: null,
  };
  let healthInflight: Promise<void> | null = null;
  let healthWatchers = 0;
  let healthTimer: unknown = null;

  function scheduleHealth(): void {
    if (healthTimer !== null || healthWatchers === 0) return;
    healthTimer = setTimer(() => {
      healthTimer = null;
      void reloadHealth().then(scheduleHealth);
    }, HEALTH_REFRESH_MS);
  }
  function stopHealthTimer(): void {
    if (healthTimer !== null) clearTimer(healthTimer);
    healthTimer = null;
  }

  function reloadHealth(): Promise<void> {
    if (healthInflight) return healthInflight;
    const mine = generation;
    health = { ...health, state: 'loading', message: null };
    changed();
    const run = (async () => {
      try {
        const line = await api.get<DashboardHealth>('/v1/dashboard/health');
        if (mine !== generation) return;
        let review: ReviewWire | null = health.review;
        let reviewMessage: string | null = null;
        try {
          const checks = await api.get<HealthChecksResponse>('/v1/health/checks', {
            query: { limit: 1 },
          });
          if (mine !== generation) return;
          review = reviewOf(checks.check_runs[0]);
        } catch (error) {
          if (mine !== generation) return;
          reviewMessage = isApiError(error) ? error.message : COULD_NOT_LOAD_REVIEW;
        }
        health = { state: 'ready', message: null, health: line, review, reviewMessage };
      } catch (error) {
        if (mine !== generation) return;
        // a reload that fails keeps the line of the read before it, and says that it could not be renewed
        health = {
          ...health,
          state: 'failed',
          message: isApiError(error) ? error.message : COULD_NOT_LOAD_HEALTH,
        };
      } finally {
        if (mine === generation) {
          healthInflight = null;
          changed();
        }
      }
    })();
    healthInflight = run;
    track(run);
    return run;
  }

  function watchHealth(): () => void {
    healthWatchers += 1;
    if (health.state === 'idle') void reloadHealth().then(scheduleHealth);
    else scheduleHealth();
    const watched = generation;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (watched !== generation) return;
      healthWatchers = Math.max(0, healthWatchers - 1);
      if (healthWatchers === 0) stopHealthTimer();
    };
  }

  function reset(): void {
    generation += 1;
    totals.clear();
    health = { state: 'idle', message: null, health: null, review: null, reviewMessage: null };
    healthInflight = null;
    healthWatchers = 0;
    stopHealthTimer();
    unsubscribeCache?.();
    unsubscribeCache = null;
    changed();
  }

  const offLogout = deps.registerLogoutHook(reset);

  return {
    dailyTotals: (from, to) => totals.get(keyOf(from, to))?.view ?? EMPTY_TOTALS,
    watchDailyTotals: watchTotals,
    reloadDailyTotals: reloadTotals,
    healthView: () => health,
    watchHealth,
    reloadHealth,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    version: () => counter,
    reset,
    idle: async () => {
      while (pending.size > 0) await Promise.allSettled([...pending]);
    },
    dispose: () => {
      offLogout();
      reset();
    },
  };
}

/** The books server of this page load, over the site's client, cache and session. */
export const booksServer: BooksServer = createBooksServer({
  api: siteApi,
  cache: rowCache,
  registerLogoutHook: siteRegisterLogoutHook,
});
