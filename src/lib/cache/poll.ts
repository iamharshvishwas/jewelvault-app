'use client';

// The poller: how a screen learns what other people did (spec C3, C4, C7, C17, C18, U6). Task WEB04.
//
// After the first hydrate (hydrate.ts) one request, `POST /v1/sync/poll`, carries a cursor for each resource the role may read and brings back the rows that changed. It runs
//   - every 8 seconds (a setting, 5 to 10), counted from the start of one poll to the start of the next, never two at once;
//   - at once after any write the screen made (the client says when a write is over, `onWriteFinished`; a write that ends while a poll is on its way is followed by exactly one more);
//   - every 30 seconds while the tab is hidden, and at once when it is shown again (and at once when the browser says the network is back);
//   - after a failed poll, 8, 16 and then 30 seconds later (`nextPollDelayMs`), until one poll works.
//
// CURSORS (C3, C4). The cursor of a resource is the greatest `updated_at` the screen has fully received, taken from the data and never from this computer's clock; the first poll
// starts from the `server_time` of the hydrate's FIRST page (hydrate.ts keeps it). Every poll asks for rows from that stamp minus the 30-second OVERLAP, written as the exact
// six-decimal text and without a key (the server then reads `updated_at >= ?`), because a row can be stamped up to 20 seconds before the transaction that holds it commits (S12), and
// a poll in between would otherwise never see it. A page that is full comes with `next`: the poll asks again for those resources only, from the (stamp, key) the server gave, until
// none is full. The cursors move ONLY when every page of the poll has arrived, and the rows are merged then, all at once: a poll whose second page fails leaves memory and cursors as
// they were and is made again from the start. Merging is by id and keeps the greater `updated_at` (cache.ts); a row that an ordinary edit holds ignores the polled copy (C5 (a)).
//
// The overlap does not cover bulk work outside the API (an import, a repair script): that work ends with one statement that re-stamps what it changed and a new value of the setting
// `data_epoch` (IM1). A screen that sees `data_epoch` change hydrates again from the start (`hydrator.reset()` then `start()`), behind the loading gate.
//
// WHO IS ASKING (U6, C18). Every answer carries the caller's role as the database says it now. When it is not the role of the session, or when the poll is refused with a 403 (a role
// that lost a resource it was reading), the poller asks `reviewRole()` ONCE: 'changed' means memory has been emptied (the owner-only data, `sku_private` and the audit data included)
// and the gate has opened again with the new role, so this poller ends and a new one starts with the new hydrate; 'ended' means the login screen is up; 'same' means the person is who
// they were: the error is shown once, polling backs off and the next 403 does not ask `me` again until a poll works; 'unknown' (`me` could not be asked) is a failed poll, and the next
// 403 asks again. A 401 needs nothing from here: the client's hook ends the session, runs the logout hooks and this poller stops with them.
//
// THE BANNER (C7). The client owns it: a network failure or JV_UNAVAILABLE is 'offline' ("Offline: changes cannot be saved"), a gateway error or a reply that is not JSON is 'waking'
// ("Waking up…") and is retried by the client for up to 30 seconds, and any answer from the API clears it. Reads go on from memory; every Save control is off while there is a banner
// (`useSavingAllowed`). This poller only has to keep trying.
//
// Nothing here is kept in browser storage (C8).
import { useSyncExternalStore } from 'react';
import {
  POLL_INTERVAL_MS,
  api as siteApi,
  isApiError,
  nextPollDelayMs,
  type ApiClient,
} from '@/lib/api/client';
import type { PollRequest, SyncResource, SyncRows } from '@/lib/api/types';
import {
  getSessionState,
  registerLogoutHook,
  reviewRole as siteReviewRole,
  type AuthRole,
  type RoleReview,
  type SessionStore,
} from '@/lib/authStore';
import { CacheDataError, KEY_FIELD, rowCache, type RowCache } from './cache';
import {
  hydrator as siteHydrator,
  resourcesFor,
  type HydrateState,
  type Hydrator,
} from './hydrate';
import { StampError, stampMicros, stampMinusSeconds } from './stamp';

/** C4: a poll asks for rows from the cursor minus this many seconds. */
export const POLL_OVERLAP_S = 30;
/** C3, C4: the pages of a poll hold at most 1,000 rows of a resource (the API's constant). */
export const POLL_PAGE_ROWS = 1000;
/** C4: "every 8 seconds (a setting, 5 to 10)". */
export const POLL_MIN_INTERVAL_MS = 5000;
export const POLL_MAX_INTERVAL_MS = 10_000;
/** C4: a hidden tab polls every 30 seconds. */
export const HIDDEN_POLL_INTERVAL_MS = 30_000;
/** A poll of more pages than any shop has is a server that does not end: stop. */
const MAX_PAGES_PER_POLL = 2000;

const COULD_NOT_REFRESH = 'The latest changes could not be loaded.';

/** The setting of C4 cut to its range: 5 to 10 seconds, 8 when it is not a number. */
export function clampPollIntervalMs(ms: number): number {
  if (!Number.isFinite(ms)) return POLL_INTERVAL_MS;
  return Math.min(POLL_MAX_INTERVAL_MS, Math.max(POLL_MIN_INTERVAL_MS, ms));
}

// ------------------------------------------------------------------------------------------------ the page

/** What the poller needs to know about the tab: is it hidden, and tell me when that changes or the network comes back. */
export interface PollHost {
  isHidden(): boolean;
  subscribe(listener: () => void): () => void;
}

/** The tab of the page, or none on the server (the static pages are built there). */
export function browserPollHost(): PollHost | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return {
    isHidden: () => document.visibilityState === 'hidden',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener);
      window.addEventListener('online', listener);
      return () => {
        document.removeEventListener('visibilitychange', listener);
        window.removeEventListener('online', listener);
      };
    },
  };
}

// ------------------------------------------------------------------------------------------------ the state

export interface PollState {
  /** 'stopped': no session or no hydrate behind it; 'idle': waiting for the next poll; 'polling': a poll is on its way. */
  status: 'stopped' | 'idle' | 'polling';
  /** Polls that failed in a row. */
  failures: number;
  /** The plain sentence for a failed poll that is not a lost connection (the banner says those), or null. */
  notice: string | null;
  /** Polls that completed (every page) since the poller started for this session. */
  polls: number;
  /** The `server_time` of the last poll that completed. */
  lastServerTime: string | null;
}

const STOPPED: PollState = {
  status: 'stopped',
  failures: 0,
  notice: null,
  polls: 0,
  lastServerTime: null,
};

export interface PollerDeps {
  api: Pick<ApiClient, 'poll' | 'onWriteFinished'>;
  cache: RowCache;
  hydrator: Pick<Hydrator, 'getState' | 'subscribe' | 'reset' | 'start'>;
  session: Pick<SessionStore, 'getState' | 'reviewRole' | 'registerLogoutHook'>;
  /** Default: the tab of the page. `null`: none (always visible). */
  page?: PollHost | null;
  /** C4's setting; default 8 seconds, cut to 5 to 10. */
  intervalMs?: number;
  hiddenIntervalMs?: number;
  pageLimit?: number;
}

export interface Poller {
  getState(): PollState;
  /** For useSyncExternalStore. */
  subscribe(listener: () => void): () => void;
  /** Polls at once (after a write); when a poll is on its way, one more follows it. Does nothing when there is nothing to poll. */
  pollNow(): void;
  /** Resolves when the poll that is on its way has ended. */
  idle(): Promise<void>;
  /** Stops and lets go of everything this poller listens to. */
  dispose(): void;
}

interface Stamp {
  micros: number;
  text: string;
}

interface Job {
  role: AuthRole;
  epoch: number;
  pollFrom: string;
  controller: AbortController;
  stopped: boolean;
  /** The greatest `updated_at` fully received of each resource; the cursor is this minus the overlap. */
  high: Map<SyncResource, Stamp>;
  /** The value of the setting `data_epoch` as the hydrate left it. */
  epochToken: string | null;
  failures: number;
  running: boolean;
  /** A write ended during the poll: one more follows it. */
  again: boolean;
  /** A 403 for a role that had not changed has been looked at; do not ask `me` again until a poll works. */
  forbiddenSettled: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  /** When the last poll started (ms). */
  startedAt: number;
  inflight: Promise<void>;
  offPage: (() => void) | null;
}

type Outcome = { kind: 'ok' } | { kind: 'stopped' } | { kind: 'failed'; notice: string | null };

/** The value of `data_epoch` as a text to compare (C4, IM1); null when the row is not there. */
function epochTokenOf(cache: RowCache): string | null {
  const row = cache.get('settings', 'data_epoch');
  return row === undefined ? null : JSON.stringify(row.value ?? null);
}

const isConnectivity = (code: string) =>
  code === 'NETWORK' || code === 'GATEWAY' || code === 'JV_UNAVAILABLE';

// ------------------------------------------------------------------------------------------------ the poller

export function createPoller(deps: PollerDeps): Poller {
  const { api, cache, hydrator, session } = deps;
  const interval = clampPollIntervalMs(deps.intervalMs ?? POLL_INTERVAL_MS);
  const hiddenInterval = deps.hiddenIntervalMs ?? HIDDEN_POLL_INTERVAL_MS;
  const pageLimit = deps.pageLimit ?? POLL_PAGE_ROWS;
  const page = deps.page === undefined ? browserPollHost() : deps.page;
  const listeners = new Set<() => void>();
  let state: PollState = STOPPED;
  let job: Job | null = null;

  const now = () => Date.now();
  const hidden = () => page?.isHidden() ?? false;

  function setState(patch: Partial<PollState>): void {
    const next = { ...state, ...patch };
    if (
      next.status === state.status &&
      next.failures === state.failures &&
      next.notice === state.notice &&
      next.polls === state.polls &&
      next.lastServerTime === state.lastServerTime
    )
      return;
    state = next;
    for (const listener of Array.from(listeners)) listener();
  }

  // ---- when the hydrate is whole for the person who is in, a job runs; when it is not, none does
  function sync(): void {
    const h: HydrateState = hydrator.getState();
    const s = session.getState();
    const open =
      h.status === 'ready' &&
      s.status === 'signedIn' &&
      s.role !== null &&
      h.role === s.role &&
      h.epoch === s.epoch &&
      h.pollFrom !== null &&
      h.firstServerTime !== null;
    if (!open) {
      stopJob();
      return;
    }
    if (
      job &&
      !job.stopped &&
      job.role === h.role &&
      job.epoch === h.epoch &&
      job.pollFrom === h.pollFrom
    )
      return;
    startJob(h);
  }

  function startJob(h: HydrateState): void {
    stopJob();
    if (h.role === null || h.epoch === null || h.pollFrom === null || h.firstServerTime === null)
      return;
    const first: Stamp = { micros: stampMicros(h.firstServerTime), text: h.firstServerTime };
    const mine: Job = {
      role: h.role,
      epoch: h.epoch,
      pollFrom: h.pollFrom,
      controller: new AbortController(),
      stopped: false,
      high: new Map(resourcesFor(h.role).map((resource) => [resource, first])),
      epochToken: epochTokenOf(cache),
      failures: 0,
      running: false,
      again: false,
      forbiddenSettled: false,
      timer: null,
      startedAt: 0,
      inflight: Promise.resolve(),
      offPage: null,
    };
    job = mine;
    mine.offPage = page ? page.subscribe(onPage) : null;
    setState({ ...STOPPED, status: 'idle' });
    void tick(mine); // the first poll does not wait: the hydrate may have taken a long time
  }

  function stopJob(): void {
    const was = job;
    job = null;
    if (was) {
      was.stopped = true;
      was.controller.abort();
      if (was.timer !== null) clearTimeout(was.timer);
      was.timer = null;
      was.offPage?.();
      was.offPage = null;
    }
    setState(STOPPED);
  }

  // ---- the tab was hidden or shown, or the network came back
  function onPage(): void {
    const mine = job;
    if (!mine || mine.stopped) return;
    if (hidden()) {
      // the next poll is 30 seconds after the last one, not 8
      if (!mine.running && mine.failures === 0) schedule(mine);
      return;
    }
    pollNow(); // shown again, or the network is back: no waiting
  }

  // ---- the loop
  function clearTimer(mine: Job): void {
    if (mine.timer !== null) clearTimeout(mine.timer);
    mine.timer = null;
  }

  /** The next poll: `interval` after the last one started (8 s, 30 s while hidden), or the back-off after the last one ended when polls are failing. */
  function schedule(mine: Job): void {
    clearTimer(mine);
    const base = hidden() ? hiddenInterval : interval;
    const due =
      mine.failures > 0
        ? now() + Math.max(nextPollDelayMs(mine.failures), hidden() ? hiddenInterval : 0)
        : mine.startedAt + base;
    const wait = Math.max(0, due - now());
    if (wait === 0) {
      void tick(mine); // a poll that took longer than the interval: the next one is due already
      return;
    }
    mine.timer = setTimeout(() => {
      mine.timer = null;
      void tick(mine);
    }, wait);
  }

  function pollNow(): void {
    const mine = job;
    if (!mine || mine.stopped) return;
    void tick(mine);
  }

  async function tick(mine: Job): Promise<void> {
    if (mine.stopped) return;
    if (mine.running) {
      mine.again = true; // a write ended during this poll: its rows may not be in it
      return;
    }
    clearTimer(mine);
    mine.running = true;
    mine.again = false;
    mine.startedAt = now();
    setState({ status: 'polling' });
    const run = (async () => {
      let outcome: Outcome;
      try {
        outcome = await pollOnce(mine);
      } catch (error) {
        outcome = await failed(mine, error);
      }
      if (mine.stopped) return;
      if (outcome.kind === 'ok') {
        mine.failures = 0;
        mine.forbiddenSettled = false;
        setState({ status: 'idle', failures: 0, notice: null });
      } else if (outcome.kind === 'failed') {
        mine.failures += 1;
        setState({ status: 'idle', failures: mine.failures, notice: outcome.notice });
      }
    })();
    mine.inflight = run;
    await run;
    mine.running = false;
    if (mine.stopped) return;
    if (mine.again) {
      void tick(mine);
      return;
    }
    schedule(mine);
  }

  // ---- one poll: every page, then the merge, then the cursors
  async function pollOnce(mine: Job): Promise<Outcome> {
    const resources = resourcesFor(mine.role);
    const staged = new Map<SyncResource, object[]>(resources.map((r) => [r, []]));
    let ask: PollRequest['cursors'] = {};
    for (const resource of resources) {
      const from = mine.high.get(resource) as Stamp;
      ask[resource] = { updated_at: stampMinusSeconds(from.text, POLL_OVERLAP_S) };
    }
    let serverTime = '';
    for (let n = 0; ; n += 1) {
      if (n >= MAX_PAGES_PER_POLL) throw new CacheDataError('poll', 'more pages than any shop has');
      const answer = await api.poll(ask, pageLimit, { signal: mine.controller.signal });
      if (mine.stopped) return { kind: 'stopped' };
      if (
        !answer ||
        typeof answer !== 'object' ||
        typeof answer.results !== 'object' ||
        !answer.results
      )
        throw new CacheDataError('poll', 'no results');
      if (n === 0) {
        stampMicros(answer.server_time); // a StampError when the API's clock is not the exact text
        serverTime = answer.server_time;
      }
      // U6, C4, C18: every answer carries the caller's role as the database says it now
      if (answer.role !== session.getState().role) return review(mine, null);
      const nextAsk: PollRequest['cursors'] = {};
      for (const resource of Object.keys(ask) as SyncResource[]) {
        const result = (answer.results as Record<string, { rows?: unknown; next?: unknown }>)[
          resource
        ];
        const rows = result?.rows ?? [];
        if (!Array.isArray(rows)) throw new CacheDataError(resource, 'no list of rows');
        (staged.get(resource) as object[]).push(...(rows as object[]));
        const next = result?.next as { updated_at: string; key: string } | null | undefined;
        if (!next) continue;
        // `next` must move forward: a server that hands back the cursor it was given, or says there is more on an empty page, would be asked for ever
        const given = ask[resource];
        const stuck =
          rows.length === 0 ||
          (given !== null &&
            given !== undefined &&
            next.updated_at === given.updated_at &&
            next.key === given.key);
        if (stuck) throw new CacheDataError(resource, 'a cursor that does not move');
        nextAsk[resource] = { updated_at: next.updated_at, key: next.key };
      }
      if (Object.keys(nextAsk).length === 0) break;
      ask = nextAsk;
    }
    return commit(mine, staged, serverTime);
  }

  /** Every page has arrived: merge, move the cursors, look at `data_epoch`. */
  function commit(mine: Job, staged: Map<SyncResource, object[]>, serverTime: string): Outcome {
    // read every row before any is stored: a row this screen cannot key or order fails the whole poll, with nothing half in memory
    const greatest = new Map<SyncResource, Stamp>();
    for (const [resource, rows] of staged) {
      const field = KEY_FIELD[resource];
      for (const row of rows) {
        const record = row as Record<string, unknown> | null;
        if (record === null || typeof record !== 'object')
          throw new CacheDataError(resource, 'no content');
        if (typeof record[field] !== 'string' || record[field] === '')
          throw new CacheDataError(resource, `no ${field}`);
        let micros: number;
        try {
          micros = stampMicros(record.updated_at as string);
        } catch {
          throw new CacheDataError(resource, 'no readable updated_at');
        }
        const best = greatest.get(resource);
        if (!best || micros > best.micros)
          greatest.set(resource, { micros, text: record.updated_at as string });
      }
    }
    for (const [resource, rows] of staged) {
      if (rows.length > 0)
        cache.merge(resource, rows as unknown as SyncRows[typeof resource][], { polled: true });
      if (mine.stopped) return { kind: 'stopped' };
    }
    for (const [resource, stamp] of greatest) {
      const held = mine.high.get(resource);
      if (!held || stamp.micros > held.micros) mine.high.set(resource, stamp);
    }
    setState({ polls: state.polls + 1, lastServerTime: serverTime });
    if (epochTokenOf(cache) !== mine.epochToken) {
      // IM1: bulk work outside the API ended with a new data_epoch: what the cursors cannot be trusted to bring is loaded again from the start, behind the loading gate
      const { role, epoch } = mine;
      hydrator.reset();
      hydrator.start(role, epoch);
      return { kind: 'stopped' };
    }
    return { kind: 'ok' };
  }

  // ---- a failed poll
  async function failed(mine: Job, error: unknown): Promise<Outcome> {
    if (mine.stopped) return { kind: 'stopped' }; // the person left, or this poller was replaced: not a failure
    if (isApiError(error)) {
      // U6: a 401 is the session gate's (the client ran its hook before throwing); nothing to do here
      if (error.status === 401) return { kind: 'stopped' };
      // U6, C18: a 403 for something the screen had been allowed to read: ask `me` once
      if (error.code === 'JV_FORBIDDEN' && !mine.forbiddenSettled)
        return review(mine, error.message);
      return { kind: 'failed', notice: isConnectivity(error.code) ? null : error.message };
    }
    // the detail goes to the console, never to the screen: a name and a message that holds no value
    if (error instanceof CacheDataError || error instanceof StampError) {
      console.warn('The latest changes could not be loaded:', error.name, error.message);
    } else {
      console.warn(
        'The latest changes could not be loaded:',
        error instanceof Error ? error.name : typeof error
      );
    }
    return { kind: 'failed', notice: COULD_NOT_REFRESH };
  }

  /** Asks the session whether the role changed (once) and says what the poll does next. `refusal` is the sentence of the 403, when there was one. */
  async function review(mine: Job, refusal: string | null): Promise<Outcome> {
    let result: RoleReview;
    try {
      result = await session.reviewRole();
    } catch {
      result = 'unknown';
    }
    if (mine.stopped) return { kind: 'stopped' };
    switch (result) {
      case 'changed': // memory is empty, the gate is open again with the new role: this poller ends with the hydrate and a new one starts with the next
      case 'ended': // the login screen is up
        return { kind: 'stopped' };
      case 'same':
        mine.forbiddenSettled = refusal !== null; // show the error once; do not ask `me` for every 403
        return { kind: 'failed', notice: refusal };
      default:
        return { kind: 'failed', notice: null }; // `me` could not be asked: nothing was learnt, the next 403 asks again
    }
  }

  // ---- wiring
  const offHydrate = hydrator.subscribe(sync);
  const offLogout = session.registerLogoutHook(stopJob); // U8
  const offWrite = api.onWriteFinished(pollNow); // C4: at once after any write
  sync();

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    pollNow,
    idle: () => (job ? job.inflight : Promise.resolve()),
    dispose: () => {
      offHydrate();
      offLogout();
      offWrite();
      stopJob();
    },
  };
}

// ------------------------------------------------------------------------------------------------ the poller of the site

/** The poller of this page load, over the site's client, cache, hydrate and session. Importing this file starts it (it waits for a hydrate to be ready). */
export const poller: Poller = createPoller({
  api: siteApi,
  cache: rowCache,
  hydrator: siteHydrator,
  session: { getState: getSessionState, reviewRole: siteReviewRole, registerLogoutHook },
});

/** Polls at once. A screen that wrote something calls nothing: the client tells the poller when a write is over. */
export const pollNow = poller.pollNow;
export const getPollState = poller.getState;

/** For the banner. The server and the first client render say "stopped", so the HTML matches. */
export function usePollState(): PollState {
  return useSyncExternalStore(poller.subscribe, poller.getState, () => STOPPED);
}
