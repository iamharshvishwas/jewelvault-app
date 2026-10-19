// The flow behind the owner's "Download everything" button (spec B3, I12, O53; task WEB12b). The zip itself is made by src/lib/downloadEverything.ts; this file is what happens around it.
//
//   1. A FRESH POLL. The zip is built from memory, so memory must be as new as the press: a poll that starts AFTER the press and completes. A poll that was already on its way when the
//      button was pressed started earlier and may have missed a row written since, so the flow waits for the one behind it. If the poll fails, or does not finish within the time allowed,
//      nothing is made: a copy of the books that might be a few minutes old is the one thing this button must not hand over without saying so.
//   2. THE FILES. `buildDownload` from the cache rows (the owner's role decides the owner-only weight), the zip handed to the browser as a file.
//   3. THE RECORD. `POST /v1/owner/download-record` with the business date and the number of rows of each of the twelve files (API35). The API compares each count with its own count of the
//      table, give or take the rows made in the last two minutes, and only then stores `last_download` (one audit row). A count that does not match is JV_INVALID_INPUT and changes nothing.
//   4. THE LINE. `reloadHealth` reads the dashboard line again, so the card and the line count from today.
//
// The file is saved BEFORE the record is posted: a record the API refuses leaves a file that is a good copy anyway and the old date on the card (the person is told both), whereas the other
// order could record a download for a file the browser never saved. The state lives here, at module level, so a download that is running goes on when the person leaves the dashboard, and
// the card shows it again when she comes back. A logout forgets it (U8).
//
// This file talks to the client, so, like moneyServer.ts and booksServer.ts, the stores that the screens re-read every second do not import it (C9).
import { api as siteApi, isApiError, type ApiClient } from '@/lib/api/client';
import type { DownloadRecordResponse } from '@/lib/api/types';
import {
  getSessionState,
  registerLogoutHook as siteRegisterLogoutHook,
  type AuthRole,
} from '@/lib/authStore';
import { DownloadBooksNotLoaded, buildDownload } from '@/lib/downloadEverything';
import { saveFile } from '@/lib/exportUtils';
import { businessDateOf } from '@/lib/selectors';
import { booksServer } from './booksServer';
import { rowCache, type RowCache } from './cache';
import { hydrator as siteHydrator, type Hydrator } from './hydrate';
import { poller as siteInstancePoller, type Poller } from './poll';

export type DownloadState =
  | { status: 'idle' }
  /** `step` says what is being done; `text` is the sentence for the card. */
  | { status: 'working'; step: 'poll' | 'files' | 'record'; text: string }
  | { status: 'done'; filename: string; date: string; files: number; rows: number }
  /** `fileSaved`: the zip is on the person's computer although the record was not made. */
  | { status: 'failed'; message: string; fileSaved: boolean };

export interface DownloadServerDeps {
  api: Pick<ApiClient, 'post'>;
  cache: RowCache;
  poller: Pick<Poller, 'getState' | 'subscribe' | 'pollNow'>;
  hydrator: Pick<Hydrator, 'getState'>;
  /** The role of the signed-in person, or null. */
  role: () => AuthRole | null;
  /** Hands the zip to the browser as a file. May throw. */
  save: (zip: Uint8Array<ArrayBuffer>, filename: string) => void;
  now: () => Date;
  /** Reads the dashboard line again (the card and the line reset). Never rejects. */
  reloadHealth: () => Promise<void>;
  registerLogoutHook: (hook: () => void) => () => void;
  /** How long a fresh poll may take before the flow gives up. */
  pollTimeoutMs?: number;
}

export interface DownloadServer {
  /** Runs the whole flow. A second press while one is running joins it (one file, one record). Never rejects: the result is the state. */
  run(): Promise<DownloadState>;
  getState(): DownloadState;
  /** For `useSyncExternalStore`. */
  subscribe(listener: () => void): () => void;
  /** The person has read the result: back to idle. Does nothing while a download is running. */
  dismiss(): void;
}

/** A fresh poll may take as long as a slow connection needs for a whole shop's changes since the last one; after this the flow gives up. */
export const FRESH_POLL_TIMEOUT_MS = 60_000;

const MESSAGES = {
  owner: 'Only the owner can use Download everything.',
  loading: 'The books are still loading. Wait until the screen has finished loading and try again.',
  poll: 'The screen could not be brought up to date, so no file was made. Check the connection and try again.',
  files:
    'The files could not be made, so nothing was saved or recorded. Try again, and tell Harsh if it happens again.',
  save: 'The browser would not save the file, so nothing was recorded. Try again.',
  recordDiffers:
    'The file was saved to your computer, but it was not recorded: the books changed while it was being made. Delete that file, wait a moment and press the button again.',
  recordFailed:
    'The file was saved to your computer, but it could not be recorded, so the date above is still the old one.',
} as const;

function recordFailure(error: unknown): string {
  if (isApiError(error)) {
    const field = typeof error.details.field === 'string' ? error.details.field : '';
    if (error.code === 'JV_INVALID_INPUT' && field.startsWith('counts'))
      return MESSAGES.recordDiffers;
    return `${MESSAGES.recordFailed} ${error.message}`.trim();
  }
  return `${MESSAGES.recordFailed} Try again.`;
}

export function createDownloadServer(deps: DownloadServerDeps): DownloadServer {
  const { api, cache, poller, hydrator } = deps;
  const pollTimeoutMs = deps.pollTimeoutMs ?? FRESH_POLL_TIMEOUT_MS;
  const listeners = new Set<() => void>();
  let state: DownloadState = { status: 'idle' };
  let running: Promise<DownloadState> | null = null;
  let generation = 0;

  function set(next: DownloadState): void {
    state = next;
    for (const listener of Array.from(listeners)) listener();
  }

  /** A poll that starts after this call has completed: true. A poll that fails, a poller that stops, or the time running out: false. */
  function freshPoll(): Promise<boolean> {
    const first = poller.getState();
    if (first.status === 'stopped') return Promise.resolve(false);
    // a poll on its way started before the press: its answer can miss a row written since, so the one behind it is the fresh one
    const target = first.polls + (first.status === 'polling' ? 2 : 1);
    const failuresBefore = first.failures;
    return new Promise<boolean>((resolve) => {
      let finished = false;
      let off: () => void = () => undefined;
      const timer = setTimeout(() => finish(false), pollTimeoutMs);
      function finish(ok: boolean) {
        if (finished) return;
        finished = true;
        off();
        clearTimeout(timer);
        resolve(ok);
      }
      off = poller.subscribe(() => {
        const now = poller.getState();
        if (now.status === 'stopped') finish(false);
        else if (now.polls >= target) finish(true);
        else if (now.failures > failuresBefore) finish(false);
      });
      poller.pollNow();
    });
  }

  async function flow(mine: number): Promise<DownloadState> {
    const alive = () => mine === generation;
    const stop = (message: string, fileSaved = false): DownloadState => ({
      status: 'failed',
      message,
      fileSaved,
    });

    const role = deps.role();
    if (role !== 'owner') return stop(MESSAGES.owner);
    if (hydrator.getState().status !== 'ready') return stop(MESSAGES.loading);

    set({ status: 'working', step: 'poll', text: 'Bringing the screen up to date…' });
    if (!(await freshPoll()) || !alive()) return stop(MESSAGES.poll);

    set({ status: 'working', step: 'files', text: 'Making the files…' });
    const moment = deps.now();
    let built;
    try {
      built = buildDownload({
        role,
        rows: (resource) => cache.rows(resource),
        date: businessDateOf(moment),
        modified: moment,
      });
    } catch (error) {
      return stop(error instanceof DownloadBooksNotLoaded ? error.message : MESSAGES.files);
    }
    try {
      deps.save(built.zip, built.filename);
    } catch {
      return stop(MESSAGES.save);
    }

    set({ status: 'working', step: 'record', text: 'Recording the download…' });
    try {
      await api.post<DownloadRecordResponse>('/v1/owner/download-record', {
        date: built.date,
        counts: built.counts,
      });
    } catch (error) {
      return stop(recordFailure(error), true);
    }
    if (alive()) await deps.reloadHealth();
    return {
      status: 'done',
      filename: built.filename,
      date: built.date,
      files: Object.keys(built.counts).length,
      rows: Object.values(built.counts).reduce((sum, count) => sum + count, 0),
    };
  }

  function run(): Promise<DownloadState> {
    if (running) return running;
    const mine = generation;
    const call = flow(mine)
      .catch((): DownloadState => ({ status: 'failed', message: MESSAGES.files, fileSaved: false }))
      .then((result) => {
        if (mine === generation) set(result);
        return mine === generation ? result : state;
      })
      .finally(() => {
        if (running === call) running = null;
      });
    running = call;
    return call;
  }

  const offLogout = deps.registerLogoutHook(() => {
    generation += 1; // a run that is still on its way finds out and writes nothing
    running = null;
    set({ status: 'idle' });
  });
  void offLogout;

  return {
    run,
    getState: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dismiss() {
      if (state.status === 'done' || state.status === 'failed') set({ status: 'idle' });
    },
  };
}

/** The download of this page load, over the site's client, cache, poller, loader and session. */
export const downloadServer: DownloadServer = createDownloadServer({
  api: siteApi,
  cache: rowCache,
  poller: siteInstancePoller,
  hydrator: siteHydrator,
  role: () => getSessionState().role,
  save: (zip, filename) => saveFile(zip, 'application/zip', filename, 60_000),
  now: () => new Date(),
  reloadHealth: () => booksServer.reloadHealth(),
  registerLogoutHook: siteRegisterLogoutHook,
});
