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
//   RECEIVING A PAYMENT (X2, `POST /v1/customers/{id}/payments`) AND SETTLING SILVER FINE (X3, `.../fine-settlements`, WEB09). The same rule again, with the customer in the path: ONE
//   Idempotency-Key for each user action, where the action is the customer and the body as `buildPaymentBody` / `buildFineBody` make it. A double click joins the call on its way; pressing
//   Save again for the SAME payment after a call that did not end well (a lost answer, a gateway error, a refusal such as the cash limit) sends the SAME key, so a payment whose answer was
//   lost is answered from the server's store and never made twice (L5, C6); a payment with any other detail (another amount, a reason added), or for another customer, is another action and
//   a key of its own. Once a payment was made, the next one has a new key even when it is the same: it is a second payment. The panel being closed forgets the keys of calls that could not
//   be confirmed (`forgetPaymentTries`): the books have been read again by then, and the person sees whether the payment is there before keying it again (C13). The rows X2 and X3 return
//   (the receipt and its allocations) are merged as they are, and only when the server has answered (C5 (b)); the figures of V1 and V2 come with the poll the client makes at once after
//   every write (C17).
//
//   THE OWNER'S ACTIONS (WEB11): CANCELLING A BILL (X5 `POST /v1/bills/{id}/cancel`), VOIDING A RECEIPT (X4 `.../receipts/{id}/void`), RE-ISSUING A BILL (X10 `.../bills/{id}/reissue`), HANDING
//   MONEY BACK (X11 `.../customers/{id}/refunds`) AND ADDING AN OPENING BALANCE (X12 `.../customers/{id}/opening-balance`). The same rule once more: ONE Idempotency-Key for each user action, the
//   action being the path (the bill, the receipt or the customer is in it) and the body (the reason, the figures, the corrected bill); a double click joins the call on its way; pressing the
//   button again after a call that did not end well sends the SAME key (an answer lost on its way is answered from the server's store: one cancel, one void, one refund); a changed reason or
//   figure is another action. What the answer returned is merged as it is, only when the server has answered: the bill, the pieces back in stock, the allocation rows the call released and the
//   ones the rebalance made, the receipt, the new bill and its lines; the figures of V1 and V2 come with the poll the client makes at once after EVERY write, also one that ended unconfirmed
//   (C13, C17: "Could not confirm that this was saved." and the books are read again).
//
//   THE LEDGER OF A CUSTOMER (V3, `GET /v1/customers/{id}/ledger`). Not part of the hydrate: loaded when a customer card opens (`watchLedger`), in pages of up to 1,000 events
//   that follow the server's own cursor, and loaded again when that customer's `updated_at` changes (every bill, receipt, cancel and void moves it, D23). The rows are kept as the
//   server sent them, with the running balance it worked out; nothing is added up here.
//
// A logout (U8) forgets all of it: the ledgers, the remembered key, and any load still on its way is thrown away when it arrives.
import { api as siteApi, isApiError, type ApiClient } from '@/lib/api/client';
import type {
  CancelBillResponse,
  CreateBillResponse,
  CreateCustomerResponse,
  CustomerRow,
  IssueRefundResponse,
  OpeningBalanceResponse,
  ReceiptAllocationRow,
  ReceiptRow,
  RecordPaymentResponse,
  ReissueBillResponse,
  SettleFineResponse,
  VoidReceiptResponse,
} from '@/lib/api/types';
import type { BillBody } from '@/lib/billing';
import type { OpeningBody, ReasonBody, RefundBody, ReissueBody } from '@/lib/ownerActions';
import type { RecordPaymentBody, SettleFineBody } from '@/lib/payments';
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
  /**
   * X2. Resolves with the answer (the receipt, its allocations and `advance_remaining`), whose rows are merged into the cache first. Rejects with the client's ApiError, whose `message` is
   * the plain C13 text and whose `idempotencyKey` is kept for the next press of Save for the same payment.
   */
  recordPayment(customerId: string, input: RecordPaymentBody): Promise<RecordPaymentResponse>;
  /** X3. The same for a silver-fine settlement (the receipt, its allocations and `fine_remaining`). */
  settleFine(customerId: string, input: SettleFineBody): Promise<SettleFineResponse>;
  /** The payment panel was closed: the keys of payments and settlements that could not be confirmed are forgotten, so the next one gets a key of its own. */
  forgetPaymentTries(): void;
  /**
   * X5. Resolves with the answer (the cancelled bill, the pieces back in stock, the allocation rows the cancel released and the ones the rebalance made), merged into the cache first.
   * Rejects with the client's ApiError (`message` is the plain C13 text, `idempotencyKey` is kept for the next press for the same bill and reason).
   */
  cancelBill(customerId: string, billId: string, input: ReasonBody): Promise<CancelBillResponse>;
  /** X4. The voided receipt and the allocation rows of the rebalance are merged; the affected bills' figures (V1) come with the poll. */
  voidReceipt(
    customerId: string,
    receiptId: string,
    input: ReasonBody
  ): Promise<VoidReceiptResponse>;
  /** X10. The old bill (cancelled), the new bill and its lines, the new payments and the carried-over and released allocation rows are merged. */
  reissueBill(customerId: string, billId: string, input: ReissueBody): Promise<ReissueBillResponse>;
  /** X11. The refund receipt is merged; the advance left (V2) comes with the poll and in the answer. */
  issueRefund(customerId: string, input: RefundBody): Promise<IssueRefundResponse>;
  /** X12. The opening bill (when there are dues), the opening advances and the allocation rows of the rebalance are merged. */
  addOpeningBalance(customerId: string, input: OpeningBody): Promise<OpeningBalanceResponse>;
  /** A dialog of the owner was closed: the keys of actions that could not be confirmed are forgotten, so the next one gets a key of its own. */
  forgetOwnerTries(): void;
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

  // ---- X2 and X3, and the owner's X4, X5, X10, X11, X12
  const paying = new Map<string, Promise<unknown>>();
  /** The actions whose last call did not end well: the action (path and body) -> the key it used. Pressing the button again for the same action sends the same key. */
  const failedTries = new Map<string, string>();
  const MOST_TRIES = 20;

  function remember(action: string, key: string): void {
    failedTries.delete(action);
    failedTries.set(action, key);
    while (failedTries.size > MOST_TRIES)
      failedTries.delete(failedTries.keys().next().value as string);
  }

  /**
   * One money call with a key for each action: the action is the path and the body (the customer, the bill or the receipt is in the path, so one key never serves two). A double click joins
   * the call on its way; a call that did not end well leaves its key for the next press of the same action. `merge` puts what the function returned into memory, only when the server has
   * answered (C5 (b)) and only if no logout came meanwhile; V1 and V2 come with the poll that follows every write (C17).
   */
  function keyedCall<Answer>(
    path: string,
    customerId: string,
    body: object,
    merge: (answer: Answer) => void
  ): Promise<Answer> {
    const action = stableJson({ path, body });
    const joined = paying.get(action);
    if (joined) return joined as Promise<Answer>; // a double click: the same action
    const reuse = failedTries.get(action);
    const mine = generation;
    const call = (async () => {
      try {
        const answer = await api.post<Answer>(path, body, {
          idempotent: true,
          idempotencyKey: reuse,
          context: { customerId },
        });
        if (mine === generation) {
          merge(answer);
          failedTries.delete(action);
        }
        return answer;
      } catch (error) {
        // the key travels on the error (L5): the next press of the button for this action sends it again
        if (mine === generation && isApiError(error) && error.idempotencyKey)
          remember(action, error.idempotencyKey);
        throw error;
      } finally {
        paying.delete(action);
      }
    })();
    paying.set(action, call);
    return call;
  }

  const mergeReceipt = (answer: { receipt: ReceiptRow; allocations: ReceiptAllocationRow[] }) => {
    cache.merge('receipts', [answer.receipt]);
    cache.merge('receipt-allocations', answer.allocations);
  };

  const recordPayment = (customerId: string, input: RecordPaymentBody) =>
    keyedCall<RecordPaymentResponse>(
      `/v1/customers/${customerId}/payments`,
      customerId,
      input,
      mergeReceipt
    );
  const settleFine = (customerId: string, input: SettleFineBody) =>
    keyedCall<SettleFineResponse>(
      `/v1/customers/${customerId}/fine-settlements`,
      customerId,
      input,
      mergeReceipt
    );

  const cancelBill = (customerId: string, billId: string, input: ReasonBody) =>
    keyedCall<CancelBillResponse>(`/v1/bills/${billId}/cancel`, customerId, input, (answer) => {
      cache.merge('bills', [answer.bill]);
      cache.merge('skus', answer.skus);
      cache.merge('receipt-allocations', [...answer.released_allocations, ...answer.allocations]);
    });
  const voidReceipt = (customerId: string, receiptId: string, input: ReasonBody) =>
    keyedCall<VoidReceiptResponse>(
      `/v1/receipts/${receiptId}/void`,
      customerId,
      input,
      mergeReceipt
    );
  const reissueBill = (customerId: string, billId: string, input: ReissueBody) =>
    keyedCall<ReissueBillResponse>(`/v1/bills/${billId}/reissue`, customerId, input, (answer) => {
      cache.merge('bills', [answer.old_bill, answer.new_bill]);
      cache.merge('bill-items', answer.items);
      cache.merge('receipts', answer.receipts);
      cache.merge('receipt-allocations', [...answer.released_allocations, ...answer.allocations]);
    });
  const issueRefund = (customerId: string, input: RefundBody) =>
    keyedCall<IssueRefundResponse>(
      `/v1/customers/${customerId}/refunds`,
      customerId,
      input,
      (answer) => {
        cache.merge('receipts', [answer.receipt]);
      }
    );
  const addOpeningBalance = (customerId: string, input: OpeningBody) =>
    keyedCall<OpeningBalanceResponse>(
      `/v1/customers/${customerId}/opening-balance`,
      customerId,
      input,
      (answer) => {
        if (answer.bill) cache.merge('bills', [answer.bill]);
        cache.merge('receipts', answer.receipts);
        cache.merge('receipt-allocations', answer.allocations);
      }
    );

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
    paying.clear();
    failedTries.clear();
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
    recordPayment,
    settleFine,
    forgetPaymentTries: () => {
      failedTries.clear();
    },
    cancelBill,
    voidReceipt,
    reissueBill,
    issueRefund,
    addOpeningBalance,
    forgetOwnerTries: () => {
      failedTries.clear();
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
