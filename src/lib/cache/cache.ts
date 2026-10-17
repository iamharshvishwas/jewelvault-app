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
// CLEAR (U8): the logout hook of the session empties every resource at once. The versions move, so every view made from the rows is made again.
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

export interface RowCache {
  /** Keeps each row unless a newer copy of its key is held already. Returns how many rows were stored (new or replaced). Throws a CacheDataError for a row it cannot key or order. */
  merge<R extends SyncResource>(resource: R, rows: readonly SyncRows[R][]): number;
  get<R extends SyncResource>(resource: R, key: string): SyncRows[R] | undefined;
  /** Every row of the resource. The same array until the resource changes. */
  rows<R extends SyncResource>(resource: R): readonly SyncRows[R][];
  count(resource: SyncResource): number;
  /** Rows held in all. */
  size(): number;
  /** Empties every resource (U8). */
  clear(): void;
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

  function merge<R extends SyncResource>(resource: R, rows: readonly SyncRows[R][]): number {
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
        const before = held.get(key);
        if (before && before.micros > micros) continue; // a newer copy is held already
        held.set(key, { row: row as object, micros });
        stored += 1;
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

  return {
    merge,
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
