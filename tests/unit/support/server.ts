// A fake JewelVault server for the unit tests of the poller (WEB04), spoken to through the REAL API client by a stubbed `fetch`.
//
// It answers what the poller and the hydrate ask for: `GET /v1/auth/me`, `GET /v1/sync/<resource>` (keyset pages, `next` when a page is full, `server_time`) and
// `POST /v1/sync/poll` (all the resources of one call, `role`, a 403 for the whole call when the role may not read one of them, as the built API does). Rows
// carry the exact six-decimal stamps of the wire. A row can be stored as committed late (`visibleAt`): it has its stamp from the start, but no read sees it
// before then, which is what a 20-second transaction does to a poll.
//
// The server's clock is the (faked) clock of the test: `now()` is 100 s at the start and moves with `vi.advanceTimersByTimeAsync`, so one advance moves the poller's
// timers and the server together. Stamps are `stampAt(seconds)`, seconds on that same line.
import { vi } from 'vitest';
import { createApiClient, type ApiClient } from '@/lib/api/client';
import type { SyncResource } from '@/lib/api/types';
import { createRowCache, type RowCache } from '@/lib/cache/cache';
import { bindToSession, createHydrator, resourcesFor, type Hydrator } from '@/lib/cache/hydrate';
import { formatStamp } from '@/lib/cache/stamp';
import { createSessionStore, type AuthRole, type SessionStore } from '@/lib/authStore';

/** 2026-10-15 09:00:00 UTC in microseconds: the zero of `stampAt`. */
const ZERO_MICROS = Date.UTC(2026, 9, 15, 9, 0, 0) * 1000;

/** The exact stamp text `seconds` after 09:00:00 (fractions of a second kept to the microsecond). */
export function stampAt(seconds: number): string {
  return formatStamp(ZERO_MICROS + Math.round(seconds * 1_000_000));
}

const KEY_FIELD: Partial<Record<SyncResource, string>> = {
  settings: 'setting_key',
  'sku-private': 'sku_id',
};
const keyField = (resource: SyncResource) => KEY_FIELD[resource] ?? 'id';

type Row = Record<string, unknown>;
interface Stored {
  row: Row;
  /** Server seconds from which reads see the row; undefined: always. */
  visibleAt?: number;
}

export interface Seen {
  kind: 'me' | 'sync' | 'poll' | 'logout' | 'other';
  method: string;
  path: string;
  resource?: SyncResource;
  /** The query of a sync page, or the body of a poll. */
  updatedAfter?: string;
  afterKey?: string;
  limit?: number;
  cursors?: Record<string, { updated_at: string; key?: string | null } | null>;
  /** Server seconds when it was answered. */
  at: number;
  n: number;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
export { json as jsonResponse };
export const refusal = (code: string, status: number) =>
  json(status, {
    error: { code, message: 'made up by the test', details: {} },
    request_id: 'req-t',
  });
/** What a proxy in front of a sleeping app answers. */
export const gatewayPage = () =>
  new Response('<html><body>502 Bad Gateway</body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });

export class FakeServer {
  role: AuthRole = 'owner';
  /** A user who is not active gets a 401 on every call (A10). */
  active = true;
  /** The API's own cap on the rows of a page. */
  cap = 1000;
  /** Resources nobody may read: a 403 for a call that names one (a test of the "same role" case). */
  forbidden = new Set<SyncResource>();
  /** Runs before each call is answered: return a Response to answer with it, throw to fail the call, await to hold it; undefined lets it through. */
  onRequest?: (seen: Seen) => Response | undefined | Promise<Response | undefined>;
  readonly seen: Seen[] = [];
  readonly tables = new Map<SyncResource, Stored[]>();
  private readonly t0 = Date.now();

  /** The server's clock in seconds (100 at the start of the test). */
  now(): number {
    return 100 + (Date.now() - this.t0) / 1000;
  }

  /** A stamp for a row changed `ago` seconds before now (a negative number is the future). */
  stamp(ago = 0): string {
    return stampAt(this.now() - ago);
  }

  /** Stores a row (replacing the one with the same key). `visibleAt`: it is committed only then. */
  put(resource: SyncResource, row: Row, visibleAt?: number): Row {
    const list = this.tables.get(resource) ?? [];
    const field = keyField(resource);
    const at = list.findIndex((s) => s.row[field] === row[field]);
    const stored: Stored = { row, visibleAt };
    if (at >= 0) list[at] = stored;
    else list.push(stored);
    this.tables.set(resource, list);
    return row;
  }

  putMany(resource: SyncResource, rows: readonly Row[]): void {
    for (const row of rows) this.put(resource, row);
  }

  /** Changes fields of a stored row and gives it a stamp. */
  change(resource: SyncResource, key: string, fields: Row, stamp = this.stamp()): void {
    const field = keyField(resource);
    const stored = (this.tables.get(resource) ?? []).find((s) => s.row[field] === key);
    if (!stored) throw new Error(`no ${resource} row ${key}`);
    stored.row = { ...stored.row, ...fields, updated_at: stamp };
  }

  /** Removes a row from the store (a test that needs a clean table; the real API never deletes). */
  drop(resource: SyncResource, key: string): void {
    const field = keyField(resource);
    this.tables.set(
      resource,
      (this.tables.get(resource) ?? []).filter((s) => s.row[field] !== key)
    );
  }

  count(kind: Seen['kind']): number {
    return this.seen.filter((s) => s.kind === kind).length;
  }

  polls(): Seen[] {
    return this.seen.filter((s) => s.kind === 'poll');
  }

  private page(
    resource: SyncResource,
    after: { updatedAt: string; key?: string | null } | null,
    limit: number
  ) {
    const field = keyField(resource);
    const now = this.now();
    const visible = (this.tables.get(resource) ?? [])
      .filter((s) => s.visibleAt === undefined || s.visibleAt <= now)
      .map((s) => s.row);
    visible.sort((a, b) => {
      const x = a.updated_at as string;
      const y = b.updated_at as string;
      if (x !== y) return x < y ? -1 : 1;
      return String(a[field]) < String(b[field]) ? -1 : 1;
    });
    const rest = visible.filter((row) => {
      if (after === null) return true;
      const stamp = row.updated_at as string;
      if (stamp !== after.updatedAt) return stamp > after.updatedAt;
      // a cursor without a key reads `updated_at >= ?` (API11); with a key, strictly after it
      return after.key == null || String(row[field]) > after.key;
    });
    const size = Math.min(limit, this.cap);
    const rows = rest.slice(0, size);
    const last = rows[rows.length - 1];
    const next =
      rows.length === size && last
        ? { updated_at: last.updated_at as string, key: String(last[field]) }
        : null;
    return { rows, next };
  }

  /** The `fetch` the client is given. */
  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const body =
      typeof init.body === 'string'
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : undefined;
    const seen: Seen = {
      kind: 'other',
      method,
      path: url.pathname,
      at: this.now(),
      n: this.seen.length + 1,
    };
    if (url.pathname === '/v1/auth/me') seen.kind = 'me';
    else if (url.pathname === '/v1/auth/logout') seen.kind = 'logout';
    else if (url.pathname === '/v1/sync/poll') {
      seen.kind = 'poll';
      seen.cursors = (body?.cursors ?? {}) as Seen['cursors'];
      seen.limit = body?.limit as number | undefined;
    } else if (url.pathname.startsWith('/v1/sync/')) {
      seen.kind = 'sync';
      seen.resource = url.pathname.slice('/v1/sync/'.length) as SyncResource;
      seen.updatedAfter = url.searchParams.get('updated_after') ?? undefined;
      seen.afterKey = url.searchParams.get('after_key') ?? undefined;
      seen.limit = url.searchParams.has('limit')
        ? Number(url.searchParams.get('limit'))
        : undefined;
    }
    this.seen.push(seen);
    const override = await this.onRequest?.(seen);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    if (override) return override;
    if (!this.active) return refusal('JV_UNAUTHENTICATED', 401);

    const user = {
      id: '00000000-0000-4000-8000-000000000001',
      email: 'person@jv.test',
      full_name: 'Test person',
      role: this.role,
      must_change_password: false,
    };
    const life = { idle_timeout_s: 43200, absolute_expires_at: '2026-10-30T00:00:00.000000Z' };
    if (url.pathname === '/v1/auth/login') return json(200, { user, ...life });
    if (seen.kind === 'me') return json(200, { user, ...life, pricing_sha256: null });
    if (seen.kind === 'logout') return json(200, { ok: true });
    if (seen.kind === 'sync') {
      const resource = seen.resource as SyncResource;
      if (!resourcesFor(this.role).includes(resource) || this.forbidden.has(resource))
        return refusal('JV_FORBIDDEN', 403);
      const after = seen.updatedAfter ? { updatedAt: seen.updatedAfter, key: seen.afterKey } : null;
      const { rows, next } = this.page(resource, after, seen.limit ?? this.cap);
      return json(200, { rows, next, server_time: stampAt(this.now()) });
    }
    if (seen.kind === 'poll') {
      const asked = Object.keys(seen.cursors ?? {}) as SyncResource[];
      const readable = resourcesFor(this.role);
      if (asked.some((r) => !readable.includes(r) || this.forbidden.has(r)))
        return refusal('JV_FORBIDDEN', 403);
      const serverTime = stampAt(this.now()); // before any page is read (C4)
      const results: Record<string, unknown> = {};
      for (const resource of asked) {
        const cursor = (seen.cursors ?? {})[resource];
        const after = cursor ? { updatedAt: cursor.updated_at, key: cursor.key } : null;
        results[resource] = this.page(resource, after, seen.limit ?? this.cap);
      }
      return json(200, { results, server_time: serverTime, role: this.role });
    }
    // a write the screen made (any POST that is not one of the above): the poller is to run at once after it
    if (url.pathname === '/v1/test-write') return json(200, { ok: true });
    return refusal('JV_NOT_FOUND', 404);
  };
}

// ------------------------------------------------------------------------------------------------ rows for the resources a poll test changes

const base = {
  created_at: stampAt(0),
  created_by: null,
  updated_by: null,
};
const uid = (prefix: number, n: number) =>
  `00000000-0000-4000-${String(prefix).padStart(4, '0')}-${String(n).padStart(12, '0')}`;

export const designOf = (n: number, stamp: string, over: Row = {}): Row => ({
  id: uid(3, n),
  design_no: `RING-${String(n).padStart(5, '0')}`,
  name: `Design ${n}`,
  category_id: uid(1, 1),
  subcategory_id: null,
  material: 'Gold',
  purity: '22K',
  selling_method: 'By Weight',
  description: null,
  notes: null,
  tags: [],
  primary_photo_id: null,
  photo_ids: [],
  archived_at: null,
  ...base,
  updated_at: stamp,
  ...over,
});

export const skuOf = (n: number, designN: number, stamp: string, over: Row = {}): Row => ({
  id: uid(4, n),
  design_id: uid(3, designN),
  sku_no: `RING-${String(designN).padStart(5, '0')}-${String(n).padStart(3, '0')}`,
  barcode: `BC${100000 + n}`,
  gross_weight: '12.500',
  customer_net_weight: '11.250',
  stones: 0,
  stone_weight: '0.000',
  kundan: 0,
  kundan_weight: '0.000',
  piroi: '150.00',
  labour_retail: '353.00',
  labour_semi: '325.00',
  labour_wholesale: '300.00',
  status: 'In Stock',
  location: 'Main Showroom',
  notes: null,
  sold_bill_id: null,
  archived_at: null,
  ...base,
  updated_at: stamp,
  ...over,
});

export const skuPrivateOf = (n: number, stamp: string): Row => ({
  sku_id: uid(4, n),
  original_net_weight: '10.125',
  ...base,
  updated_at: stamp,
});

export const categoryOf = (n: number, name: string, prefix: string, stamp: string): Row => ({
  id: uid(1, n),
  name,
  prefix,
  active: true,
  ...base,
  updated_at: stamp,
});

export const settingOf = (key: string, value: unknown, stamp: string): Row => ({
  setting_key: key,
  value,
  ...base,
  updated_at: stamp,
});

export const userOf = (n: number, role: AuthRole, stamp: string): Row => ({
  id: uid(9, n),
  full_name: `Person ${n}`,
  role,
  active: true,
  updated_at: stamp,
});

export const customerOf = (n: number, stamp: string): Row => ({
  id: uid(5, n),
  name: `Customer ${n}`,
  mobile: '9876543210',
  customer_type: 'Retail',
  email: null,
  address: null,
  gst_number: null,
  pan: null,
  notes: null,
  is_walkin: false,
  archived_at: null,
  ...base,
  updated_at: stamp,
});

export const billSummaryOf = (n: number, pending: string, stamp: string): Row => ({
  id: uid(6, n),
  customer_id: uid(5, 1),
  bill_no: `JV-${n}`,
  bill_date: '2026-10-15',
  grand_total: '10000.00',
  status: 'active',
  allocated: '0.00',
  outstanding: pending,
  fine_weight_due: '0.000',
  item_count: 1,
  updated_at: stamp,
});

export const balanceOf = (n: number, outstanding: string, stamp: string): Row => ({
  id: uid(5, n),
  billed: '10000.00',
  received: '0.00',
  refunded: '0.00',
  allocated: '0.00',
  outstanding,
  advance: '0.00',
  balance: outstanding,
  fine_billed: '0.000',
  fine_received: '0.000',
  fine_allocated: '0.000',
  fine_outstanding: '0.000',
  fine_advance: '0.000',
  fine_balance: '0.000',
  last_purchase: null,
  updated_at: stamp,
});

/** A small shop for an owner: the data_epoch setting, a category, two designs and three pieces, all stamped a minute before the test starts. */
export function seedShop(server: FakeServer, over: { epoch?: string } = {}): void {
  const old = stampAt(40);
  server.put(
    'settings',
    settingOf('data_epoch', { epoch: over.epoch ?? '1970-01-01 00:00:00.000000' }, old)
  );
  server.put(
    'settings',
    settingOf('numbering', { designPadding: 5, skuPadding: 3, barcodePrefix: 'BC' }, old)
  );
  server.put('categories', categoryOf(1, 'Ring', 'RING', old));
  server.put('users', userOf(1, 'owner', old));
  server.put('designs', designOf(1, old));
  server.put('designs', designOf(2, old));
  server.put('skus', skuOf(1, 1, old));
  server.put('skus', skuOf(2, 1, old));
  server.put('skus', skuOf(3, 2, old));
  server.put('sku-private', skuPrivateOf(1, old));
  server.put('sku-private', skuPrivateOf(2, old));
  server.put('sku-private', skuPrivateOf(3, old));
}

// ------------------------------------------------------------------------------------------------ the page of the poller tests

/** A stand-in for the window: `hidden` is the tab being in the background; `emit` says the page was shown or hidden, or the network came back. */
export class FakePage {
  hidden = false;
  private readonly listeners = new Set<() => void>();
  isHidden = () => this.hidden;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  show() {
    this.hidden = false;
    this.emit();
  }
  hide() {
    this.hidden = true;
    this.emit();
  }
  emit() {
    for (const listener of Array.from(this.listeners)) listener();
  }
  listenerCount = () => this.listeners.size;
}

export interface World {
  server: FakeServer;
  api: ApiClient;
  cache: RowCache;
  session: SessionStore;
  hydrator: Hydrator;
  page: FakePage;
  logoutHooks: number;
}

/** The session store over the real client and the fake server, with a stand-in for the layout that starts the hydrate when the person is in. The poller is added by the test. */
export function makeWorld(server: FakeServer = new FakeServer()): World {
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch as unknown as typeof fetch,
  });
  const input = new EventTarget();
  const visibility = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const session = createSessionStore({ api, host: { input, visibility }, preview: false });
  const cache = createRowCache();
  const hydrator = createHydrator({ api, cache, reviewRole: session.reviewRole });
  bindToSession(hydrator, session.registerLogoutHook);
  // AppLayout: `useEffect(() => { if (status === 'signedIn' && role) startHydrate(role, epoch) })`
  session.subscribe(() => {
    const s = session.getState();
    if (s.status === 'signedIn' && s.role) hydrator.start(s.role, s.epoch);
  });
  return { server, api, cache, session, hydrator, page: new FakePage(), logoutHooks: 0 };
}

/** Lets the session ask `me`, the hydrate run and (if there is one) the first poll start; the clock moves on by `seconds` (default none). */
export async function settle(seconds = 0): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000);
}
