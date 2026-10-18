// The network side of the money store (spec C3, C6, C11, L5; task WEB07).
//
// `appStore.ts` keeps the prototype's names and its synchronous reads, and must import no client (C9: the screens that re-read it every second make no network call, and
// tests/unit/memory-reads.test.ts reads its imports). The two things the money side has to ask the server for are here instead, and appStore reads what they leave in memory:
//
//   CREATING A CUSTOMER (X6, `POST /v1/customers`). One Idempotency-Key for each customer the person saves, made by the client. The same key is sent again when the person
//   presses Save again for the SAME customer after a call that did not end well (the answer was lost, the server was busy, the form was refused): the server then answers the
//   stored result and makes nothing new (L5). A double click, the same customer asked for while the first call is on its way, joins that call: one request. A customer with
//   other details is another action and gets a key of its own. The returned row is merged into the cache as it is, so the id and the stamps are the server's (C11).
//
//   CREATING A BILL (X1, `POST /v1/bills`, WEB08). The same rule for the bill the person saves: ONE Idempotency-Key for each user action, where the action is the bill as it is
//   on the screen (its body, made the same way every time). A double click joins the call on its way; pressing Save again for the SAME bill after a call that did not end well sends
//   the SAME key, so a bill whose answer was lost is answered from the server's store and never made twice (L5, C6); any change to the cart is another action and a key of its own.
//   The rows X1 returns (the bill, its lines, the receipts and the allocations of the payment rows) are merged as they are, and only when the server has answered (C5 (b)): a piece
//   never shows Sold and a bill never shows saved before that (the pieces and the bill's figures V1 arrive with the poll the client makes at once after every write).
//
//   THE LEDGER OF A CUSTOMER (V3, `GET /v1/customers/{id}/ledger`). Not part of the hydrate: loaded when a customer card opens (`watchLedger`), in pages of up to 1,000 events
//   that follow the server's own cursor, and loaded again when that customer's `updated_at` changes (every bill, receipt, cancel and void moves it, D23). The rows are kept as the
//   server sent them, with the running balance it worked out; nothing is added up here.
//
// A logout (U8) forgets all of it: the ledgers, the remembered key, and any load still on its way is thrown away when it arrives.
import { api as siteApi, isApiError, type ApiClient } from '@/lib/api/client';
import type { CreateBillResponse, CreateCustomerResponse, CustomerRow } from '@/lib/api/types';
import type { BillBody } from '@/lib/billing';
import { registerLogoutHook as siteRegisterLogoutHook } from '@/lib/authStore';
import { rowCache, type RowCache } from './cache';

/** The customer as X6 takes it: the names of the API. A blank optional text is left out; `name` and `mobile` are required. */
export interface NewCustomerBody {
  name: string;
  mobile: string;
  customer_type?: string;
  email?: string;
  address?: string;
  gst_number?: string;
  pan?: string;
  notes?: string;
}

/** One event of V3, the way `GET /v1/customers/{id}/ledger` sends it. */
export interface LedgerWireRow {
  customer_id: string;
  entry_date: string;
  entry_at: string;
  kind_rank: number;
  id: string;
  kind: string;
  description: string;
  debit: string;
  credit: string;
  fine_debit: string;
  fine_credit: string;
  balance: string;
  fine_balance: string;
}

interface LedgerPage {
  rows: LedgerWireRow[];
  next: { after: string } | null;
}

export type LedgerLoadState = 'idle' | 'loading' | 'ready' | 'failed';
export interface LedgerState {
  state: LedgerLoadState;
  /** The plain sentence of the failure, when `state` is 'failed'. */
  message: string | null;
}

export interface MoneyServerDeps {
  api: Pick<ApiClient, 'get' | 'post'>;
  cache: RowCache;
  /** The session's way of hearing about a logout (U8). Returns the way to stop. */
  registerLogoutHook: (hook: () => void) => () => void;
}

export interface MoneyServer {
  /** X6. Resolves with the row the server made (or answered again), already merged into the cache. Rejects with the client's ApiError. */
  createCustomer(input: NewCustomerBody): Promise<CustomerRow>;
  /**
   * X1. Resolves with the answer (the bill, its lines, the receipts, the allocations, the warnings, `advance_applied`), whose rows are merged into the cache first. Rejects with the
   * client's ApiError, whose `message` is the plain C13 text and whose `idempotencyKey` is kept for the next press of Save for the same bill.
   */
  createBill(input: BillBody): Promise<CreateBillResponse>;
  /** The person started over (a new sale, a discard): the key of the bill that could not be confirmed is forgotten, so the next bill gets a key of its own. */
  forgetBill(): void;
  /** Reads the whole ledger of the customer now. A second call while one is on its way joins it. Never rejects: a failure is `ledgerState`. */
  loadLedger(customerId: string): Promise<void>;
  /** A customer card is open: load the ledger and keep it current. Returns the way to stop (twice is once). */
  watchLedger(customerId: string): () => void;
  /** The events of the ledger as sent. The same array until the ledger is read again; empty before the first read and after a logout. */
  ledgerRows(customerId: string): readonly LedgerWireRow[];
  ledgerState(customerId: string): LedgerState;
  /** The customers whose ledger holds events. */
  loadedLedgers(): string[];
  /** A logout: forget everything. */
  reset(): void;
  /** Resolves when no load is on its way (for tests and for a screen that wants to wait). */
  idle(): Promise<void>;
  dispose(): void;
}

/** The page size asked for; the server's cap may give fewer and the cursor carries on (C3). */
export const LEDGER_PAGE_ROWS = 1000;
const EMPTY: readonly LedgerWireRow[] = Object.freeze([]);
const COULD_NOT_LOAD = 'The ledger could not be loaded. Try again.';

interface Slot {
  rows: readonly LedgerWireRow[];
  state: LedgerLoadState;
  message: string | null;
  /** The customer's `updated_at` (exact text) when the last read began: a different stamp now means the ledger is out of date. */
  readAt: string | null;
  inflight: Promise<void> | null;
  /** How many open cards watch this ledger. */
  watchers: number;
}

/** The body as the person gave it, cleaned: trimmed text, no blank optional text. Refuses a blank name or mobile before any call. */
function cleanBody(input: NewCustomerBody): NewCustomerBody {
  const body: Record<string, string> = {};
  for (const [name, value] of Object.entries(input)) {
    if (typeof value !== 'string') continue;
    const text = value.trim();
    if (text !== '') body[name] = text;
  }
  if (!body.name) throw new Error('The customer needs a name.');
  if (!body.mobile) throw new Error('The customer needs a mobile number.');
  return body as unknown as NewCustomerBody;
}

/** JSON with the keys of every object in order and nothing undefined: the same text for the same request however it was put together. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = Object.keys(record)
      .filter((name) => record[name] !== undefined)
      .sort()
      .map((name) => `${JSON.stringify(name)}:${stableJson(record[name])}`);
    return `{${parts.join(',')}}`;
  }
  return JSON.stringify(value);
}

/** The same text for the same customer whatever order the keys were written in. */
function stableText(body: NewCustomerBody): string {
  const record = body as unknown as Record<string, string>;
  return JSON.stringify(
    Object.keys(record)
      .sort()
      .map((name) => [name, record[name]])
  );
}

export function createMoneyServer(deps: MoneyServerDeps): MoneyServer {
  const { api, cache } = deps;

  /** Moves on at every logout: work that began before it is thrown away when it ends. */
  let generation = 0;

  // ---- X6
  const creating = new Map<string, Promise<CustomerRow>>();
  /** The customer whose last call did not end well and the key it used: pressing Save again for the same customer sends the same key. */
  let lastTry: { body: string; key: string } | null = null;

  function createCustomer(input: NewCustomerBody): Promise<CustomerRow> {
    let body: NewCustomerBody;
    try {
      body = cleanBody(input);
    } catch (error) {
      return Promise.reject(error); // refused before any call, as a rejection like every other failure
    }
    const text = stableText(body);
    const joined = creating.get(text);
    if (joined) return joined; // a double click: the same action
    const reuse = lastTry !== null && lastTry.body === text ? lastTry.key : undefined;
    const mine = generation;
    const call = (async () => {
      try {
        const answer = await api.post<CreateCustomerResponse>('/v1/customers', body, {
          idempotent: true,
          idempotencyKey: reuse,
        });
        if (mine === generation) {
          cache.merge('customers', [answer.customer]);
          if (lastTry !== null && lastTry.body === text) lastTry = null;
        }
        return answer.customer;
      } catch (error) {
        // the key travels on the error (L5): the next press of Save for this customer sends it again
        if (mine === generation && isApiError(error) && error.idempotencyKey)
          lastTry = { body: text, key: error.idempotencyKey };
        throw error;
      } finally {
        creating.delete(text);
      }
    })();
    creating.set(text, call);
    return call;
  }

  // ---- X1
  const billing = new Map<string, Promise<CreateBillResponse>>();
  /** The bill whose last call did not end well and the key it used: pressing Save again for the same bill sends the same key. */
  let lastBillTry: { body: string; key: string } | null = null;

  function createBill(input: BillBody): Promise<CreateBillResponse> {
    const text = stableJson(input);
    const joined = billing.get(text);
    if (joined) return joined; // a double click: the same action
    const reuse = lastBillTry !== null && lastBillTry.body === text ? lastBillTry.key : undefined;
    const mine = generation;
    const call = (async () => {
      try {
        const answer = await api.post<CreateBillResponse>('/v1/bills', input, {
          idempotent: true,
          idempotencyKey: reuse,
          context: { customerId: input.customer_id },
        });
        if (mine === generation) {
          // C5 (b): only now, and only what the function returned. The pieces' Sold and the bill's V1 figures come with the poll that follows every write.
          cache.merge('bills', [answer.bill]);
          cache.merge('bill-items', answer.items);
          cache.merge('receipts', answer.receipts);
          cache.merge('receipt-allocations', answer.allocations);
          if (lastBillTry !== null && lastBillTry.body === text) lastBillTry = null;
        }
        return answer;
      } catch (error) {
        // the key travels on the error (L5): the next press of Save for this bill sends it again
        if (mine === generation && isApiError(error) && error.idempotencyKey)
          lastBillTry = { body: text, key: error.idempotencyKey };
        throw error;
      } finally {
        billing.delete(text);
      }
    })();
    billing.set(text, call);
    return call;
  }

  // ---- the ledgers
  const slots = new Map<string, Slot>();
  const pending = new Set<Promise<void>>();
  let unsubscribe: (() => void) | null = null;

  const slotOf = (customerId: string): Slot => {
    let slot = slots.get(customerId);
    if (!slot) {
      slot = {
        rows: EMPTY,
        state: 'idle',
        message: null,
        readAt: null,
        inflight: null,
        watchers: 0,
      };
      slots.set(customerId, slot);
    }
    return slot;
  };
  const stampOf = (customerId: string): string | null =>
    cache.get('customers', customerId)?.updated_at ?? null;

  /** A watched ledger that has never been read, or was read at another stamp of its customer, is read now. A failed one waits for a new stamp. */
  function check(customerId: string): void {
    const slot = slots.get(customerId);
    if (!slot || slot.watchers === 0 || slot.inflight) return;
    if (slot.state === 'idle' || slot.readAt !== stampOf(customerId)) void loadLedger(customerId);
  }

  function checkAll(): void {
    for (const [customerId, slot] of slots) if (slot.watchers > 0) check(customerId);
  }

  function loadLedger(customerId: string): Promise<void> {
    const slot = slotOf(customerId);
    if (slot.inflight) return slot.inflight;
    const mine = generation;
    const readAt = stampOf(customerId); // before the read: a change during it is seen as a change
    slot.state = 'loading';
    slot.message = null;
    const run = (async () => {
      const rows: LedgerWireRow[] = [];
      let after: string | undefined;
      try {
        for (;;) {
          const page = await api.get<LedgerPage>(`/v1/customers/${customerId}/ledger`, {
            query: { after, limit: LEDGER_PAGE_ROWS },
          });
          if (mine !== generation) return;
          rows.push(...page.rows);
          if (!page.next) break;
          if (page.next.after === after) throw new Error('The ledger did not move on.');
          after = page.next.after;
        }
        slot.rows = rows;
        slot.state = 'ready';
        slot.message = null;
      } catch (error) {
        if (mine !== generation) return;
        // a reload that fails keeps the ledger that was read before; a first read that fails holds nothing
        slot.state = 'failed';
        slot.message = isApiError(error) ? error.message : COULD_NOT_LOAD;
      } finally {
        if (mine === generation) {
          slot.readAt = readAt;
          slot.inflight = null;
        }
      }
      check(customerId); // the customer moved on while this was read: once more
    })();
    slot.inflight = run;
    pending.add(run);
    void run.finally(() => pending.delete(run));
    return run;
  }

  function watchLedger(customerId: string): () => void {
    const slot = slotOf(customerId);
    slot.watchers += 1;
    unsubscribe ??= cache.subscribe(checkAll);
    check(customerId);
    const watched = generation;
    let stopped = false;
    return () => {
      if (stopped) return;
      stopped = true;
      if (watched !== generation) return; // a logout already forgot it
      slot.watchers = Math.max(0, slot.watchers - 1);
      if (![...slots.values()].some((s) => s.watchers > 0)) {
        unsubscribe?.();
        unsubscribe = null;
      }
    };
  }

  function reset(): void {
    generation += 1;
    slots.clear();
    creating.clear();
    lastTry = null;
    billing.clear();
    lastBillTry = null;
    unsubscribe?.();
    unsubscribe = null;
  }

  const offLogout = deps.registerLogoutHook(reset);

  return {
    createCustomer,
    createBill,
    forgetBill: () => {
      lastBillTry = null;
    },
    loadLedger,
    watchLedger,
    ledgerRows: (customerId) => slots.get(customerId)?.rows ?? EMPTY,
    ledgerState: (customerId) => {
      const slot = slots.get(customerId);
      return { state: slot?.state ?? 'idle', message: slot?.message ?? null };
    },
    loadedLedgers: () => [...slots].filter(([, slot]) => slot.rows.length > 0).map(([id]) => id),
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

/** The money server of this page load, over the site's client, cache and session. */
export const moneyServer: MoneyServer = createMoneyServer({
  api: siteApi,
  cache: rowCache,
  registerLogoutHook: siteRegisterLogoutHook,
});
