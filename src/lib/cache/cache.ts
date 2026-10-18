// The memory of the website: every row the role may read, by resource and id (spec C2, C3, C4, C8, C9).
//
// The hydrate (hydrate.ts) fills it behind the loading gate; the poll of WEB04 and the writes of WEB05 and later merge into it. Rows are the
// API's own, with money and weight as text; the stores (designStore, catalogStore, settingsStore, and WEB07's) read them and make the shapes
// the screens know. Nothing here is ever written to localStorage, sessionStorage or IndexedDB (C8): this is a Map in the page and goes with it.
//
// MERGE (C4): a row is kept by its key, and an incoming copy replaces the stored one only when its `updated_at` is not older, the two stamps
// compared as microsecond numbers parsed from the exact text (stamp.ts). A copy with the same stamp replaces it too: it is the same row read a
// second time, and for the derived resources (bill-summary, customer-balances) the later read is the one worked out last.
//
// PENDING (C4, C5 (a)): an ordinary edit marks its row with `hold` for as long as its write is in flight. A copy of that row that arrives in a poll
// (`merge(..., { polled: true })`) is kept aside and not shown: it must not undo the edit under the person's hands. When the last hold on the row ends the
// copy that waited is let in by the same rule as any other (the greater `updated_at` stays), so the write's own answer, which has a newer stamp, wins, and a
// failed write that was rolled back falls back to what somebody else saved meanwhile. The screen's own merges (the optimistic row, the returned row, the
// rollback) are never held back.
//
// CLEAR (U8): the logout hook of the session empties every resource at once. The versions move, so every view made from the rows is made again.
// Holds and the copies that waited go with it: nothing of the old session comes back.
import { SYNC_RESOURCES, type SyncResource, type SyncRows } from '@/lib/api/types';
import { stampMicros } from './stamp';

/** The key of each resource's rows (C3): `id` except for settings and sku-private; customer-balances is keyed by the customer's id, which is its `id`. */
export const KEY_FIELD: Readonly<Record<SyncResource, string>> = {
  users: 'id',
  settings: 'setting_key',
  'daily-rates': 'id',
  categories: 'id',
  subcategories: 'id',
  designs: 'id',
  skus: 'id',
  'sku-private': 'sku_id',
  customers: 'id',
  bills: 'id',
  'bill-summary': 'id',
  'bill-items': 'id',
  receipts: 'id',
  'receipt-allocations': 'id',
  'customer-balances': 'id',
};

/** A row the API sent that cannot be kept: no key, or no stamp this screen can read. The message names the resource, never the row. */
export class CacheDataError extends Error {
  constructor(resource: string, what: string) {
    super(`A row of ${resource} has ${what}`);
    this.name = 'CacheDataError';
  }
}

/** The error of a change that the screen cannot save yet (WEB05 and later put each kind of save on the API). Shown by the screen's own handler as a message. */
export function savingNotAvailable(what: string): Error {
  return new Error(
    `${what} cannot be saved yet: this part of the application is not connected to the server, so nothing was changed.`
  );
}

interface Entry {
  row: object;
  micros: number;
}

export interface MergeOptions {
  /** The rows come from a poll: a copy of a row an ordinary edit holds is kept aside until the edit ends (C4, C5 (a)). */
  polled?: boolean;
}

export interface RowCache {
  /**
   * Keeps each row unless a newer copy of its key is held already. Returns how many rows were stored (new or replaced). Throws a CacheDataError for a row it cannot key or order.
   * With `polled`, a row that is held (`hold`) is not stored: its copy waits for the end of the hold.
   */
  merge<R extends SyncResource>(
    resource: R,
    rows: readonly SyncRows[R][],
    options?: MergeOptions
  ): number;
  /**
   * C5 (a): an ordinary edit of this row is in flight. Polled copies of the row wait until the returned function is called (twice is the same as once); two edits of one row
   * hold it until both have ended. A logout drops every hold.
   */
  hold(resource: SyncResource, key: string): () => void;
  /** Is an ordinary edit of this row in flight? */
  isHeld(resource: SyncResource, key: string): boolean;
  get<R extends SyncResource>(resource: R, key: string): SyncRows[R] | undefined;
  /** Every row of the resource. The same array until the resource changes. */
  rows<R extends SyncResource>(resource: R): readonly SyncRows[R][];
  count(resource: SyncResource): number;
  /** Rows held in all. */
  size(): number;
  /** Empties every resource (U8). */
  clear(): void;
  /** Moves on every `clear`: a write that was on its way when the session ended compares it with the one it started in, and puts nothing back (U8). */
  generation(): number;
  /** A text that changes when any of these resources changes: what a view made from them is cached by. */
  versionOf(...resources: SyncResource[]): string;
  /** Called once after each change (a merge that stored something, a clear that emptied something). Returns the way to stop. */
  subscribe(listener: () => void): () => void;
}

export function createRowCache(): RowCache {
  const tables = new Map<SyncResource, Map<string, Entry>>();
  const versions = new Map<SyncResource, number>();
  const lists = new Map<SyncResource, { version: number; rows: readonly object[] }>();
  const listeners = new Set<() => void>();
  /** Edits in flight, by resource and key (how many). */
  const holds = new Map<SyncResource, Map<string, number>>();
  /** The newest polled copy of each held row, waiting for the end of the hold. */
  const waiting = new Map<SyncResource, Map<string, Entry>>();
  /** Moves on every clear: a release that belongs to an earlier session does nothing. */
  let generation = 0;

  const versionNow = (resource: SyncResource) => versions.get(resource) ?? 0;
  const table = (resource: SyncResource): Map<string, Entry> => {
    let held = tables.get(resource);
    if (!held) {
      held = new Map();
      tables.set(resource, held);
    }
    return held;
  };
  const tell = () => {
    for (const listener of Array.from(listeners)) listener();
  };

  /** The one rule: a copy goes in unless a newer one is held already (an equal stamp lets the later copy in). */
  function store(held: Map<string, Entry>, key: string, entry: Entry): boolean {
    const before = held.get(key);
    if (before && before.micros > entry.micros) return false;
    held.set(key, entry);
    return true;
  }

  const isHeld = (resource: SyncResource, key: string) => (holds.get(resource)?.get(key) ?? 0) > 0;

  function merge<R extends SyncResource>(
    resource: R,
    rows: readonly SyncRows[R][],
    options: MergeOptions = {}
  ): number {
    const field = KEY_FIELD[resource];
    const held = table(resource);
    let stored = 0;
    try {
      for (const row of rows) {
        if (row === null || typeof row !== 'object')
          throw new CacheDataError(resource, 'no content');
        const record = row as unknown as Record<string, unknown>;
        const key = record[field];
        if (typeof key !== 'string' || key === '')
          throw new CacheDataError(resource, `no ${field}`);
        let micros: number;
        try {
          micros = stampMicros(record.updated_at as string);
        } catch {
          throw new CacheDataError(resource, 'no readable updated_at');
        }
        const entry: Entry = { row: row as object, micros };
        if (options.polled && isHeld(resource, key)) {
          // an edit of this row is in flight: keep the newest polled copy aside, show nothing
          let aside = waiting.get(resource);
          if (!aside) waiting.set(resource, (aside = new Map()));
          store(aside, key, entry);
          continue;
        }
        if (store(held, key, entry)) stored += 1;
      }
    } finally {
      // also when a later row of the batch is refused: what was stored before it is in memory, so the versions must say so
      if (stored > 0) {
        versions.set(resource, versionNow(resource) + 1);
        tell();
      }
    }
    return stored;
  }

  function hold(resource: SyncResource, key: string): () => void {
    let counts = holds.get(resource);
    if (!counts) holds.set(resource, (counts = new Map()));
    counts.set(key, (counts.get(key) ?? 0) + 1);
    const mine = generation;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (mine !== generation) return; // the session it belonged to has ended
      const now = (counts.get(key) ?? 1) - 1;
      if (now > 0) {
        counts.set(key, now);
        return;
      }
      counts.delete(key);
      const aside = waiting.get(resource);
      const copy = aside?.get(key);
      if (!aside || !copy) return;
      aside.delete(key);
      if (store(table(resource), key, copy)) {
        versions.set(resource, versionNow(resource) + 1);
        tell();
      }
    };
  }

  return {
    merge,
    hold,
    isHeld,
    get: (resource, key) => tables.get(resource)?.get(key)?.row as never,
    rows: (resource) => {
      const version = versionNow(resource);
      const listed = lists.get(resource);
      if (listed && listed.version === version) return listed.rows as never;
      const rows = Array.from(tables.get(resource)?.values() ?? [], (entry) => entry.row);
      lists.set(resource, { version, rows });
      return rows as never;
    },
    count: (resource) => tables.get(resource)?.size ?? 0,
    size: () => {
      let total = 0;
      for (const held of tables.values()) total += held.size;
      return total;
    },
    clear: () => {
      generation += 1;
      holds.clear();
      waiting.clear();
      let emptied = false;
      for (const resource of SYNC_RESOURCES) {
        const held = tables.get(resource);
        if (held && held.size > 0) {
          held.clear();
          emptied = true;
        }
        // every version moves, empty or not: a view made from an empty resource is made again too
        versions.set(resource, versionNow(resource) + 1);
      }
      lists.clear();
      if (emptied) tell();
    },
    generation: () => generation,
    versionOf: (...resources) => resources.map((resource) => versionNow(resource)).join('.'),
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

/** The memory of this page load: one cache for the whole site. */
export const rowCache: RowCache = createRowCache();
