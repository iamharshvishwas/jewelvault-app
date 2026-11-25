// FB-F1 (FB-D8, Siddhi #13): the Order Book's store on the row cache. `src/lib/orderStore.ts` used to keep the orders in the page (and, before 19 October, in the browser's local storage under
// `jaishri.orders.v1`). It now reads the `orders` rows the hydrate and the poll put in memory, like every other book, and writes through the API of Lane E (FB-E1):
//   POST  /v1/orders                                     { order_id, customer_id, description, delivery_date?, notes?, photo_ids? } + Idempotency-Key     201 { order }
//   PATCH /v1/orders/:id                                 { expected_updated_at, changes: { status | photo_ids } }                                        200 { row }
//   PUT   /v1/orders/:order_id/photos/:photo_id?kind=    raw bytes, full then thumb                                                                       201
// Nothing is read from or written to browser storage, the old key included.
//
//   - `ordersDue(today)`: the orders due today, tomorrow, the day after, or overdue (the Asia/Kolkata business day the caller gives), never a delivered or cancelled one
//   - `orderActions(status, who)`: only the forward step of open -> in_progress -> ready -> delivered and Cancel; a delivered order is cancelled only by a person who may change a closed order (the owner); a person who may not edit orders (staff) gets none (F-extra-2)
//   - staff never get a customer's name or mobile (ruling A4, F-extra-1): the store does not look the customer up for them
//   - no photo on a delivered or cancelled order (F-extra-5)
//
// Run: npm test -- tests/unit/order-store.test.ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OrderRow } from '@/lib/api/types';
import { ORDER_CHAIN, ORDER_STATUS_LABEL, orderActions } from '@/lib/orderStatus';
import { holderFor } from './support/access';
import { at, uuid } from './support/rows';

const API = 'http://localhost:4229';
const SRC = path.resolve(__dirname, '../../src');

function orderRow(n: number, over: Partial<OrderRow> = {}): OrderRow {
  return {
    id: uuid(5000 + n),
    order_no: `ORD-2026-${String(n).padStart(4, '0')}`,
    customer_id: uuid(3001),
    description: `Order ${n}`,
    delivery_date: null,
    status: 'open',
    photo_ids: [],
    notes: null,
    created_at: at(0),
    updated_at: at(n),
    created_by: null,
    updated_by: null,
    ...over,
  };
}

const customerRow = (n: number, name: string, mobile: string) => ({
  id: uuid(3000 + n),
  name,
  mobile,
  customer_type: 'Retail',
  email: null,
  address: null,
  gst_number: null,
  pan: null,
  notes: null,
  is_walkin: false,
  archived_at: null,
  created_at: at(0),
  updated_at: at(1),
  created_by: null,
  updated_by: null,
});

/** A storage that records every touch, so a test can say "never touched". */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const touched: string[] = [];
  return {
    touched,
    api: {
      getItem: (key: string) => (touched.push(`get ${key}`), data.get(key) ?? null),
      setItem: (key: string, value: string) => (touched.push(`set ${key}`), data.set(key, value)),
      removeItem: (key: string) => (touched.push(`remove ${key}`), data.delete(key)),
      clear: () => (touched.push('clear'), data.clear()),
      key: (i: number) => Array.from(data.keys())[i] ?? null,
      get length() {
        return data.size;
      },
    },
  };
}

interface Call {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: Record<string, any> | undefined; // eslint-disable-line @typescript-eslint/no-explicit-any
  bytes: Blob | undefined;
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** A fake of Lane E's order routes, spoken to through the REAL API client by a stubbed `fetch`. */
function fakeOrdersApi() {
  const calls: Call[] = [];
  let next: Response | null = null;
  const fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? 'GET',
      path: url.pathname,
      query: Object.fromEntries(url.searchParams.entries()),
      headers: Object.fromEntries(
        Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [
          k.toLowerCase(),
          v,
        ])
      ),
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      bytes: init.body instanceof Blob ? init.body : undefined,
    };
    calls.push(call);
    if (next) {
      const answer = next;
      next = null;
      return answer;
    }
    const parts = call.path.split('/').filter(Boolean);
    if (call.method === 'PUT' && parts[1] === 'orders' && parts[3] === 'photos') {
      return json(201, { photo_id: parts[4], order_id: parts[2], kind: call.query.kind });
    }
    if (call.method === 'POST' && call.path === '/v1/orders') {
      const b = call.body ?? {};
      return json(201, {
        order: orderRow(1, {
          id: b.order_id,
          customer_id: b.customer_id,
          description: b.description,
          delivery_date: b.delivery_date ?? null,
          notes: b.notes ?? null,
          photo_ids: b.photo_ids ?? [],
          updated_at: at(100),
        }),
      });
    }
    if (call.method === 'PATCH' && parts[1] === 'orders') {
      return json(200, {
        row: orderRow(9, { id: parts[2], ...call.body?.changes, updated_at: at(200) }),
      });
    }
    return json(404, { error: { code: 'JV_NOT_FOUND', message: 'no route', details: {} } });
  };
  return {
    calls,
    fetch,
    refuseNext: (response: Response) => {
      next = response;
    },
  };
}

async function world() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  vi.stubEnv('NEXT_PUBLIC_API_URL', API);
  const local = fakeStorage({ 'jaishri.orders.v1': JSON.stringify([{ id: 'order-legacy' }]) });
  const session = fakeStorage();
  vi.stubGlobal('window', { localStorage: local.api, sessionStorage: session.api });
  const server = fakeOrdersApi();
  vi.stubGlobal('fetch', server.fetch);
  const [cacheModule, orders] = await Promise.all([
    import('@/lib/cache/cache'),
    import('@/lib/orderStore'),
  ]);
  const cache = cacheModule.rowCache;
  const put = (resource: Parameters<typeof cache.merge>[0], rows: readonly object[]) =>
    cache.merge(resource, rows as never);
  return { cache, orders, server, put, touched: () => [...local.touched, ...session.touched] };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const jpeg = () =>
  new Blob([new Uint8Array([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5])], { type: 'image/jpeg' });
const photo = (n: number) => ({
  photoId: uuid(7000 + n),
  full: jpeg(),
  thumb: jpeg(),
  stored: { full: null, thumb: null },
});

// ================================================================================================ Step 1: ordersDue

describe('FB-F1 ordersDue(today): due in 2 days or overdue, and not delivered or cancelled', () => {
  const today = '2026-11-14';
  const rows = [
    orderRow(1, { delivery_date: '2026-11-14' }), // today
    orderRow(2, { delivery_date: '2026-11-15', status: 'in_progress' }), // tomorrow
    orderRow(3, { delivery_date: '2026-11-16', status: 'ready' }), // the day after
    orderRow(4, { delivery_date: '2026-11-17' }), // three days out: not yet
    orderRow(5, { delivery_date: '2026-11-10' }), // overdue
    orderRow(6, { delivery_date: '2026-11-14', status: 'delivered' }),
    orderRow(7, { delivery_date: '2026-11-13', status: 'cancelled' }),
    orderRow(8, { delivery_date: null }), // no date: never due
  ];

  it('includes delivery today, tomorrow, the day after and overdue, the most overdue first', async () => {
    const { orders } = await world();
    const due = orders.ordersDue(today, { rows });
    expect(due.map((o) => o.orderNo)).toEqual([
      'ORD-2026-0005',
      'ORD-2026-0001',
      'ORD-2026-0002',
      'ORD-2026-0003',
    ]);
    expect(due.map((o) => o.daysLeft)).toEqual([-4, 0, 1, 2]);
  });

  it('excludes delivered and cancelled orders, an order three days out and one with no date', async () => {
    const { orders } = await world();
    const numbers = orders.ordersDue(today, { rows }).map((o) => o.orderNo);
    for (const n of ['0004', '0006', '0007', '0008'])
      expect(numbers).not.toContain(`ORD-2026-${n}`);
  });

  it('counts calendar days across a month and a year end (no clock, no time zone of the computer)', async () => {
    const { orders } = await world();
    const turn = [
      orderRow(1, { delivery_date: '2027-01-01' }),
      orderRow(2, { delivery_date: '2027-01-02' }),
      orderRow(3, { delivery_date: '2026-12-01' }),
    ];
    expect(orders.ordersDue('2026-12-31', { rows: turn }).map((o) => o.daysLeft)).toEqual([
      -30, 1, 2,
    ]);
  });

  it('reads the orders in memory when no rows are given', async () => {
    const { orders, put } = await world();
    put('orders', rows);
    expect(orders.ordersDue(today)).toHaveLength(4);
  });
});

// ================================================================================================ F-extra-2: the chain of statuses

describe('FB-F1 the status buttons follow the plan chain (F-extra-2)', () => {
  it('open -> in_progress -> ready -> delivered, one forward step at a time, and Cancel', () => {
    const biller = holderFor('biller');
    const owner = holderFor('owner');
    expect(orderActions('open', biller).map((a) => a.to)).toEqual(['in_progress', 'cancelled']);
    expect(orderActions('in_progress', biller).map((a) => a.to)).toEqual(['ready', 'cancelled']);
    expect(orderActions('ready', biller).map((a) => a.to)).toEqual(['delivered', 'cancelled']);
    expect(orderActions('ready', owner).map((a) => a.label)).toEqual([
      'Mark Delivered',
      'Cancel order',
    ]);
  });

  it('delivered -> cancelled needs the tick for a closed order (the owner has it, the biller has not); a cancelled order has no button; staff get none', () => {
    expect(orderActions('delivered', holderFor('owner')).map((a) => a.to)).toEqual(['cancelled']);
    expect(orderActions('delivered', holderFor('biller'))).toEqual([]);
    expect(orderActions('cancelled', holderFor('owner'))).toEqual([]);
    for (const status of Object.keys(ORDER_CHAIN) as Array<keyof typeof ORDER_CHAIN>)
      expect(orderActions(status, holderFor('staff'))).toEqual([]);
  });

  it('no backward step is offered, though the API allows one (one table to change: ORDER_CHAIN)', () => {
    const owner = holderFor('owner');
    expect(orderActions('ready', owner).map((a) => a.to)).not.toContain('in_progress');
    expect(orderActions('in_progress', owner).map((a) => a.to)).not.toContain('open');
  });

  it('the words of the five statuses', () => {
    expect(ORDER_STATUS_LABEL).toEqual({
      open: 'Open',
      in_progress: 'In progress',
      ready: 'Ready',
      delivered: 'Delivered',
      cancelled: 'Cancelled',
    });
  });
});

// ================================================================================================ the list from memory

describe('FB-F1 the list is read from memory; staff never get a customer (F-extra-1)', () => {
  it('the owner and the biller see the customer name and mobile', async () => {
    const { orders, put } = await world();
    put('customers', [customerRow(1, 'Meera Shah', '9876500001')]);
    put('orders', [orderRow(1, { delivery_date: '2026-11-15', notes: 'Size 14' })]);
    const [one] = orders.getOrders({ withCustomers: true });
    expect(one).toMatchObject({
      orderNo: 'ORD-2026-0001',
      customerName: 'Meera Shah',
      customerMobile: '9876500001',
      description: 'Order 1',
      deliveryDate: '2026-11-15',
      status: 'open',
      statusLabel: 'Open',
      notes: 'Size 14',
    });
  });

  it('staff get no name and no mobile, even when a customer row is in memory: the store does not look it up', async () => {
    const { orders, put, cache } = await world();
    put('customers', [customerRow(1, 'Meera Shah', '9876500001')]);
    put('orders', [orderRow(1)]);
    const get = vi.spyOn(cache, 'get');
    const [one] = orders.getOrders({ withCustomers: false });
    expect(one.customerName).toBeNull();
    expect(one.customerMobile).toBeNull();
    expect(get.mock.calls.filter(([resource]) => resource === 'customers')).toEqual([]);
    expect(JSON.stringify(orders.ordersDue('2026-11-14', { withCustomers: false }))).not.toContain(
      'Meera'
    );
  });

  it('nearest delivery first, an order with no date last', async () => {
    const { orders, put } = await world();
    put('orders', [
      orderRow(1, { delivery_date: null }),
      orderRow(2, { delivery_date: '2026-11-20' }),
      orderRow(3, { delivery_date: '2026-11-16' }),
    ]);
    expect(orders.getOrders().map((o) => o.orderNo)).toEqual([
      'ORD-2026-0003',
      'ORD-2026-0002',
      'ORD-2026-0001',
    ]);
  });
});

// ================================================================================================ the writes

describe('FB-F1 the writes go to the API of FB-E1', () => {
  it('a new order uploads each photo (full, then thumb) under the order id, then ONE create with an Idempotency-Key, and the answer goes into memory', async () => {
    const { orders, server, cache } = await world();
    const orderId = uuid(6001);
    const made = await orders.createOrder({
      orderId,
      customerId: uuid(3001),
      description: '  Gold ring, size 14  ',
      deliveryDate: '2026-11-15',
      notes: '',
      photos: [photo(1)],
    });
    expect(
      server.calls.map((c) => `${c.method} ${c.path}${c.query.kind ? `?${c.query.kind}` : ''}`)
    ).toEqual([
      `PUT /v1/orders/${orderId}/photos/${uuid(7001)}?full`,
      `PUT /v1/orders/${orderId}/photos/${uuid(7001)}?thumb`,
      'POST /v1/orders',
    ]);
    const create = server.calls[2];
    expect(create.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.body).toEqual({
      order_id: orderId,
      customer_id: uuid(3001),
      description: 'Gold ring, size 14',
      delivery_date: '2026-11-15',
      photo_ids: [uuid(7001)],
    });
    // no status, no number, no money: the API makes the first two and an order holds none of the third
    expect(Object.keys(create.body ?? {})).not.toContain('status');
    expect(made.order_no).toBe('ORD-2026-0001');
    expect(cache.get('orders', orderId)?.description).toBe('Gold ring, size 14');
  });

  it('a description is required, and a fourth photo is refused, before anything is sent', async () => {
    const { orders, server } = await world();
    const base = {
      orderId: uuid(6002),
      customerId: uuid(3001),
      description: 'Chain',
      deliveryDate: '',
      notes: '',
      photos: [],
    };
    await expect(orders.createOrder({ ...base, description: '   ' })).rejects.toThrow(
      /description/i
    );
    await expect(orders.createOrder({ ...base, customerId: '' })).rejects.toThrow(/customer/i);
    await expect(
      orders.createOrder({ ...base, photos: [photo(1), photo(2), photo(3), photo(4)] })
    ).rejects.toThrow(/at most 3 photos/);
    expect(server.calls).toEqual([]);
  });

  it('a change of status is one PATCH with the exact stamp of the row and only the status', async () => {
    const { orders, server, put, cache } = await world();
    put('orders', [orderRow(1, { status: 'in_progress', updated_at: at(5, 123456) })]);
    await orders.setOrderStatus(uuid(5001), 'ready');
    expect(server.calls).toHaveLength(1);
    expect(server.calls[0]).toMatchObject({
      method: 'PATCH',
      path: `/v1/orders/${uuid(5001)}`,
      body: { expected_updated_at: at(5, 123456), changes: { status: 'ready' } },
    });
    expect(cache.get('orders', uuid(5001))?.status).toBe('ready');
  });

  it('a photo is added at the end of the list: uploaded under the order, then the PATCH of photo_ids', async () => {
    const { orders, server, put } = await world();
    put('orders', [orderRow(1, { photo_ids: [uuid(7009)] })]);
    await orders.addOrderPhoto(uuid(5001), photo(2));
    expect(server.calls.map((c) => c.method)).toEqual(['PUT', 'PUT', 'PATCH']);
    expect(server.calls[2].body?.changes).toEqual({ photo_ids: [uuid(7009), uuid(7002)] });
  });

  it('no photo is added to a delivered or a cancelled order, nor a fourth one (F-extra-5)', async () => {
    const { orders, server, put } = await world();
    put('orders', [
      orderRow(1, { status: 'delivered' }),
      orderRow(2, { status: 'cancelled' }),
      orderRow(3, { photo_ids: [uuid(7101), uuid(7102), uuid(7103)] }),
    ]);
    expect(orders.canAddPhoto(orders.getOrders()[0])).toBe(false);
    await expect(orders.addOrderPhoto(uuid(5001), photo(1))).rejects.toThrow(/delivered/);
    await expect(orders.addOrderPhoto(uuid(5002), photo(1))).rejects.toThrow(/cancelled/);
    await expect(orders.addOrderPhoto(uuid(5003), photo(1))).rejects.toThrow(/at most 3 photos/);
    expect(server.calls).toEqual([]);
  });

  it("a fourth photo refused by the API is said in an order's words", async () => {
    const { orders, server, put } = await world();
    put('orders', [orderRow(1)]);
    server.refuseNext(
      json(409, {
        error: {
          code: 'JV_NOT_ALLOWED',
          message: 'full',
          details: { reason: 'order_full', field: 'order_id' },
        },
      })
    );
    const error = await orders.addOrderPhoto(uuid(5001), photo(1)).catch((e: unknown) => e);
    expect(orders.orderSaveMessage(error)).toBe('An order can have at most 3 photos.');
  });
});

// ================================================================================================ no browser storage

describe('FB-F1 no browser storage: the old jaishri.orders.v1 is neither read nor written nor wiped', () => {
  it('reading and writing the orders touch no storage', async () => {
    const { orders, put, touched } = await world();
    put('orders', [orderRow(1)]);
    orders.getOrders();
    orders.ordersDue('2026-11-14');
    await orders.setOrderStatus(uuid(5001), 'in_progress');
    expect(touched()).toEqual([]);
  });

  it('the source names no storage at all (comments do not count)', () => {
    const file = path.join(SRC, 'lib/orderStore.ts');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const names: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) names.push(node.text);
      if (ts.isStringLiteralLike(node)) names.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(sf);
    for (const word of ['localStorage', 'sessionStorage', 'indexedDB'])
      expect(names).not.toContain(word);
    expect(names.some((n) => n.startsWith('jaishri.'))).toBe(false);
  });
});
