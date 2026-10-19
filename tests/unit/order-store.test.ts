// The clean-up of 19 October for the hidden Order Book's store (spec C8, U8; test T-E05): `src/lib/orderStore.ts` kept the orders in the browser's local storage under `jaishri.orders.v1`. No
// screen of this application keeps business data in browser storage now: the store holds its orders in memory, for the life of the page, and reads and writes no key, the old one included (the
// old keys are neither read nor wiped, C8). The Order Book itself stays closed to every role (tests/unit/hidden-screens.test.ts) and is built for real in M2, on the API like the other books.
//
// The store reads its flag and its storage when it loads, so each case imports a fresh copy of it over a fake `window`.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';

/** A storage that records every touch, so a test can say "never touched". */
function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  const touched: string[] = [];
  const api = {
    getItem: (key: string) => {
      touched.push(`get ${key}`);
      return data.has(key) ? (data.get(key) as string) : null;
    },
    setItem: (key: string, value: string) => {
      touched.push(`set ${key}`);
      data.set(key, String(value));
    },
    removeItem: (key: string) => {
      touched.push(`remove ${key}`);
      data.delete(key);
    },
    clear: () => {
      touched.push('clear');
      data.clear();
    },
    key: (i: number) => Array.from(data.keys())[i] ?? null,
    get length() {
      return data.size;
    },
  };
  return { api, data, touched };
}

const OLD_KEY = 'jaishri.orders.v1';
const OLD_ORDERS = JSON.stringify([{ id: 'order-legacy', orderNumber: 'ORD-2025-0001' }]);

/** A fresh copy of the store, in a browser whose local storage holds the old key. */
async function load() {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_PREVIEW_MODE', '');
  const local = fakeStorage({ [OLD_KEY]: OLD_ORDERS });
  const session = fakeStorage();
  vi.stubGlobal('window', { localStorage: local.api, sessionStorage: session.api });
  const orders = await import('@/lib/orderStore');
  return { orders, local, session, touched: () => [...local.touched, ...session.touched] };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const entry = (over: Record<string, unknown> = {}) => ({
  customerId: 'c-1',
  customerName: 'Asha',
  customerMobile: '9000000001',
  itemDetails: 'A kundan set',
  category: 'Necklace Set',
  material: 'Gold',
  purity: '22K',
  size: '',
  imageUrl: '',
  estimatedTotal: 100000,
  advanceAmount: 25000,
  approxDeliveryDate: '2026-11-20',
  status: 'Pending' as const,
  notes: '',
  ...over,
});

describe('CL19-3 the hidden Order Book store keeps nothing in browser storage', () => {
  it('loading it, and a session of adding, changing and removing orders, touches no storage at all: not local, not session, and the old key is neither read nor written nor wiped', async () => {
    const w = await load();
    expect(w.touched()).toEqual([]); // loading the module reads nothing
    w.orders.getOrders();
    const first = w.orders.addOrder(entry());
    w.orders.updateOrder(first.id, { status: 'Ready', advanceAmount: 30000 });
    w.orders.getOrders();
    w.orders.getNextOrderNumber();
    w.orders.removeOrder(first.id);
    w.orders.getOrders();
    expect(w.touched()).toEqual([]);
    expect(w.local.data.get(OLD_KEY)).toBe(OLD_ORDERS);
    expect(w.local.data.size).toBe(1);
    expect(w.session.data.size).toBe(0);
  });

  it('the orders live in memory for the life of the page, with the numbers and balances the screen showed', async () => {
    const w = await load();
    expect(w.orders.getOrders()).toEqual([]); // the old key's order is not shown
    const year = new Date().getFullYear();
    const a = w.orders.addOrder(entry());
    const b = w.orders.addOrder(entry({ customerName: 'Meera', advanceAmount: 120000 }));
    expect(a.orderNumber).toBe(`ORD-${year}-0001`);
    expect(b.orderNumber).toBe(`ORD-${year}-0002`);
    expect(a.balanceAmount).toBe(75000);
    expect(b.balanceAmount).toBe(0); // an advance above the estimate leaves no balance, never a negative one
    expect(w.orders.getOrders().map((o) => o.customerName)).toEqual(['Meera', 'Asha']);
    w.orders.updateOrder(a.id, { status: 'Delivered', advanceAmount: 100000 });
    const changed = w.orders.getOrders().find((o) => o.id === a.id);
    expect(changed?.status).toBe('Delivered');
    expect(changed?.balanceAmount).toBe(0);
    w.orders.removeOrder(b.id);
    expect(w.orders.getOrders().map((o) => o.id)).toEqual([a.id]);
  });

  it('a new page (a fresh copy of the store) starts empty, whatever the old key holds', async () => {
    const first = await load();
    first.orders.addOrder(entry());
    const second = await load();
    expect(second.orders.getOrders()).toEqual([]);
    expect(second.touched()).toEqual([]);
  });

  it('the file names no browser storage and no jaishri.* key (the parser sees code, not comments)', () => {
    const file = path.resolve(__dirname, '../../src/lib/orderStore.ts');
    const source = ts.createSourceFile(
      file,
      readFileSync(file, 'utf8'),
      ts.ScriptTarget.ES2022,
      true,
      ts.ScriptKind.TS
    );
    const identifiers = new Set<string>();
    const strings: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isIdentifier(node)) identifiers.add(node.text);
      else if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
        strings.push(node.text);
      ts.forEachChild(node, visit);
    };
    visit(source);
    for (const name of ['localStorage', 'sessionStorage', 'indexedDB', 'openDatabase', 'caches'])
      expect(identifiers.has(name), name).toBe(false);
    expect(strings.filter((s) => s.includes('jaishri.'))).toEqual([]);
  });
});
