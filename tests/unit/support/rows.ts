// Rows the way the API sends them (src/lib/api/types.ts), for the unit tests of the cache, the hydrate and the stock stores (WEB03).
// Money and weight are text, ids are lower-case UUIDs and every stamp is the exact six-decimal text.
import { ApiError, type ApiClient } from '@/lib/api/client';
import type {
  CategoryRow,
  DailyRateRow,
  DesignRow,
  SettingRow,
  SkuPrivateRow,
  SkuRow,
  SubcategoryRow,
  SyncNext,
  SyncPage,
  SyncResource,
  SyncRows,
  UserRow,
} from '@/lib/api/types';

/** A stamp: `seconds` after 2026-10-15 09:00:00 UTC and `micros` microseconds. Under 15 hours. */
export function at(seconds: number, micros = 0): string {
  const h = 9 + Math.floor(seconds / 3600);
  const m = Math.floor(seconds / 60) % 60;
  const s = seconds % 60;
  const two = (n: number) => String(n).padStart(2, '0');
  return `2026-10-15T${two(h)}:${two(m)}:${two(s)}.${String(micros).padStart(6, '0')}Z`;
}

export const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

const stamps = (sec: number, micros = 0) => ({
  created_at: at(0),
  updated_at: at(sec, micros),
  created_by: null,
  updated_by: null,
});

export const userRow = (n: number, over: Partial<UserRow> = {}): UserRow => ({
  id: uuid(900 + n),
  full_name: `Person ${n}`,
  role: 'owner',
  active: true,
  updated_at: at(1),
  ...over,
});

export const settingRow = (key: string, value: unknown, sec = 1): SettingRow => ({
  setting_key: key,
  value,
  ...stamps(sec),
});

export const rateRow = (n: number, over: Partial<DailyRateRow> = {}): DailyRateRow => ({
  id: uuid(800 + n),
  material: 'Gold',
  purity: '22K',
  rate_per_gram: '7350.00',
  rate_date: '2026-10-15',
  confirmed_by: null,
  ...stamps(1),
  ...over,
});

export const categoryRow = (
  n: number,
  name: string,
  prefix: string,
  over: Partial<CategoryRow> = {}
): CategoryRow => ({
  id: uuid(100 + n),
  name,
  prefix,
  active: true,
  ...stamps(1),
  ...over,
});

export const subcategoryRow = (
  n: number,
  categoryN: number,
  name: string,
  over: Partial<SubcategoryRow> = {}
): SubcategoryRow => ({
  id: uuid(200 + n),
  category_id: uuid(100 + categoryN),
  name,
  active: true,
  ...stamps(1),
  ...over,
});

export const designRow = (n: number, over: Partial<DesignRow> = {}): DesignRow => ({
  id: uuid(300 + n),
  design_no: `RING-${String(n).padStart(5, '0')}`,
  name: `Design ${n}`,
  category_id: uuid(101),
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
  ...stamps(2),
  ...over,
});

export const skuRow = (n: number, designN: number, over: Partial<SkuRow> = {}): SkuRow => ({
  id: uuid(1000 + n),
  design_id: uuid(300 + designN),
  sku_no: `RING-${String(designN).padStart(5, '0')}-${String(n).padStart(3, '0')}`,
  barcode: `BC${String(100000 + n)}`,
  gross_weight: '12.500',
  customer_net_weight: '11.250',
  stones: 3,
  stone_weight: '0.500',
  kundan: 2,
  kundan_weight: '0.250',
  piroi: '150.00',
  labour_retail: '353.00',
  labour_semi: '325.00',
  labour_wholesale: '300.00',
  status: 'In Stock',
  location: 'Main Showroom',
  notes: null,
  sold_bill_id: null,
  archived_at: null,
  ...stamps(3),
  ...over,
});

export const skuPrivateRow = (n: number, weight = '10.125'): SkuPrivateRow => ({
  sku_id: uuid(1000 + n),
  original_net_weight: weight,
  ...stamps(3),
});

// ------------------------------------------------------------------------------------------------ a fake API for the hydrate

const plain = (code: string, status: number) =>
  new ApiError({ code, status, message: `plain message of ${code}`, write: false });

export interface FakeCall {
  resource: SyncResource;
  updatedAfter: string | undefined;
  afterKey: string | undefined;
  limit: number | undefined;
}

export interface FakeApiOptions {
  /** The API's own page cap: fewer rows than asked come back, with `next` (the T-F03 case). Default 1,000. */
  cap?: number;
  /** Rows of each resource; the key of a row is its `id`, `setting_key` or `sku_id`. */
  tables: Partial<Record<SyncResource, readonly object[]>>;
  /** Resources this role may not read: a 403 JV_FORBIDDEN. */
  forbidden?: readonly SyncResource[];
  /** Runs before each page is answered; throw an ApiError to fail it, or await to slow it down. */
  before?: (call: FakeCall, n: number) => Promise<void> | void;
}

const keyOf = (resource: SyncResource, row: object): string => {
  const record = row as Record<string, unknown>;
  const field =
    resource === 'settings' ? 'setting_key' : resource === 'sku-private' ? 'sku_id' : 'id';
  return String(record[field]);
};

/** The `syncPage` of the API: ordered by (updated_at, key), `next` when the page was full, `server_time` rising by a second with every call. */
export function fakeApi(options: FakeApiOptions) {
  const cap = options.cap ?? 1000;
  const calls: FakeCall[] = [];
  let serverSeconds = 100;
  const api = {
    syncPage: async (
      resource: SyncResource,
      query: { updatedAfter?: string; afterKey?: string; limit?: number; signal?: AbortSignal } = {}
    ): Promise<SyncPage<never>> => {
      const call: FakeCall = {
        resource,
        updatedAfter: query.updatedAfter,
        afterKey: query.afterKey,
        limit: query.limit,
      };
      calls.push(call);
      const serverTime = at(serverSeconds++);
      await options.before?.(call, calls.length);
      if (query.signal?.aborted) throw new DOMException('aborted', 'AbortError');
      if (options.forbidden?.includes(resource)) throw plain('JV_FORBIDDEN', 403);
      const all = [...(options.tables[resource] ?? [])].sort((a, b) => {
        const x = a as { updated_at: string };
        const y = b as { updated_at: string };
        return x.updated_at < y.updated_at
          ? -1
          : x.updated_at > y.updated_at
            ? 1
            : keyOf(resource, a) < keyOf(resource, b)
              ? -1
              : 1;
      });
      const after = query.updatedAfter;
      const rest = all.filter((row) => {
        if (after === undefined) return true;
        const stampOf = (row as { updated_at: string }).updated_at;
        if (stampOf !== after) return stampOf > after;
        return query.afterKey === undefined || keyOf(resource, row) > query.afterKey;
      });
      const size = Math.min(query.limit ?? cap, cap);
      const rows = rest.slice(0, size);
      const last = rows[rows.length - 1] as { updated_at: string } | undefined;
      const next: SyncNext | null =
        rows.length === size && last
          ? { updated_at: last.updated_at, key: keyOf(resource, last) }
          : null;
      return { rows: rows as never[], next, server_time: serverTime };
    },
  } as unknown as Pick<ApiClient, 'syncPage'>;
  return { api, calls };
}

/** A table of `count` rows whose stamps rise: row i is stamped i seconds after the first. */
export function manyRows<R extends SyncResource>(
  count: number,
  make: (i: number) => SyncRows[R]
): SyncRows[R][] {
  return Array.from({ length: count }, (_, i) => make(i));
}

export { plain as apiError };
