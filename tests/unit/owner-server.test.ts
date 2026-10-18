// WEB11 (spec C5 (b), C6, C13, C17, L5; plan test PT-W11, unit half): the network side of the owner's actions, `cancelBill` (X5), `voidReceipt` (X4), `reissueBill` (X10), `issueRefund`
// (X11) and `addOpeningBalance` (X12) in src/lib/cache/moneyServer.ts, and `saveCancel` / `saveVoid` / ... of appStore.ts.
//
//   T-E06  (unit half) one Idempotency-Key for each user action: a double click is one request; pressing the button again after a call that did not end well sends the SAME key and the
//          server answers what it stored (one cancel); another reason is another action
//   C5 (b) nothing is put in memory before the API has answered, and then only the rows the function returned
//   C17    the client says when a write is over, success or not (the poller then polls at once and brings the customer's bill_summary and customer_balances rows), also for an owner action
//          that ended unconfirmed
//   U8     a logout forgets the keys and throws away an answer that was on its way
//
// The fake server is tests/unit/support/owner-server.ts, spoken to through the REAL client.
import { afterEach, describe, expect, it } from 'vitest';
import { createApiClient, isApiError, type ApiError } from '@/lib/api/client';
import { createRowCache } from '@/lib/cache/cache';
import { createMoneyServer } from '@/lib/cache/moneyServer';
import type {
  CancelBillResponse,
  IssueRefundResponse,
  OpeningBalanceResponse,
  ReissueBillResponse,
  VoidReceiptResponse,
} from '@/lib/api/types';
import type { ReissueBody } from '@/lib/ownerActions';
import { FakeOwnerApi, type OwnerAnswer, type OwnerCall } from './support/owner-server';
import {
  allocationRow,
  billRow,
  customerRow,
  id,
  itemRow,
  receiptRow,
  summaryRow,
} from './support/money-rows';
import { skuRow } from './support/rows';

const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// Priya's books: JV-0021 (1,000.00) had received 600.00 by receipt R1; JV-0022 (700.00) is older and unpaid.
const b21 = billRow(21, id.priya, { bill_no: 'JV-0021', grand_total: '1000.00' });
const b22 = billRow(22, id.priya, { bill_no: 'JV-0022', grand_total: '700.00' });
const r1 = receiptRow(1, id.priya, { amount: '600.00' });

const cancelled21 = {
  ...b21,
  status: 'cancelled' as const,
  cancel_reason: 'wrong customer',
  cancelled_on: '2026-10-16',
  updated_at: '2026-10-16T10:00:00.000000Z',
};
const cancelAnswer: CancelBillResponse = {
  bill: cancelled21,
  skus: [{ ...skuRow(1, 1), status: 'In Stock' }],
  released_allocations: [
    allocationRow(1, r1, b21, {
      amount: '600.00',
      released_at: '2026-10-16T10:00:00.000000Z',
      updated_at: '2026-10-16T10:00:00.000000Z',
    }),
  ],
  allocations: [
    allocationRow(2, r1, b22, {
      amount: '600.00',
      created_at: '2026-10-16T10:00:00.000000Z',
      updated_at: '2026-10-16T10:00:00.000000Z',
    }),
  ],
};
const voidedR1 = {
  ...r1,
  status: 'voided' as const,
  void_reason: 'bounced',
  voided_on: '2026-10-16',
  updated_at: '2026-10-16T10:00:00.000000Z',
};
const voidAnswer: VoidReceiptResponse = {
  receipt: voidedR1,
  allocations: [],
  bills: [
    summaryRow(b21, {
      received: '0.00',
      pending: '1000.00',
      fine_settled: '0.000',
      fine_pending: '0.000',
      payment_status: 'Pending',
      item_count: 1,
    }),
  ],
};
const refund = receiptRow(4, id.priya, { kind: 'refund', amount: '300.00', mode: 'Cash' });
const refundAnswer: IssueRefundResponse = { receipt: refund, advance: '200.00' };
const opening = billRow(30, id.priya, {
  bill_no: 'OB-0001',
  doc_type: 'opening_balance',
  grand_total: '1000.00',
});
const openingReceipt = receiptRow(5, id.priya, {
  amount: '400.00',
  is_opening: true,
  mode: 'Other',
});
const openingAnswer: OpeningBalanceResponse = {
  bill: opening,
  receipts: [openingReceipt],
  allocations: [allocationRow(3, openingReceipt, opening, { amount: '400.00' })],
};
const fresh = billRow(23, id.priya, {
  bill_no: 'JV-0023',
  reissue_of: b21.id,
  grand_total: '900.00',
});
const reissueAnswer: ReissueBillResponse = {
  old_bill: cancelled21,
  new_bill: fresh,
  items: [itemRow(fresh, 1)],
  receipts: [],
  allocations: [allocationRow(4, r1, fresh, { amount: '600.00' })],
  released_allocations: cancelAnswer.released_allocations,
  warnings: [],
  advance_applied: '600.00',
};

function answers(call: OwnerCall): OwnerAnswer {
  if (call.path.endsWith('/cancel')) return { status: 200, body: cancelAnswer };
  if (call.path.endsWith('/void')) return { status: 200, body: voidAnswer };
  if (call.path.endsWith('/refunds')) return { status: 201, body: refundAnswer };
  if (call.path.endsWith('/opening-balance')) return { status: 201, body: openingAnswer };
  if (call.path.endsWith('/reissue')) return { status: 201, body: reissueAnswer };
  return { refuse: { code: 'JV_NOT_FOUND', status: 404 } };
}

function world() {
  const server = new FakeOwnerApi(answers);
  const api = createApiClient({
    baseUrl: 'https://api.example.test',
    fetch: server.fetch as unknown as typeof fetch,
    sleep: async () => undefined,
  });
  const cache = createRowCache();
  const hooks: Array<() => void> = [];
  const money = createMoneyServer({
    api,
    cache,
    registerLogoutHook: (hook) => {
      hooks.push(hook);
      return () => void hooks.splice(hooks.indexOf(hook), 1);
    },
  });
  const logout = () => hooks.forEach((hook) => hook());
  cache.merge('customers', [customerRow(id.priya)]);
  cache.merge('bills', [b21, b22]);
  cache.merge('receipts', [r1]);
  cache.merge('skus', [{ ...skuRow(1, 1), status: 'Sold' }]);
  cache.merge('receipt-allocations', [allocationRow(1, r1, b21, { amount: '600.00' })]);
  const writes: number[] = [];
  api.onWriteFinished(() => writes.push(Date.now()));
  return { server, api, cache, money, logout, writes };
}

const failure = async (promise: Promise<unknown>): Promise<ApiError> => {
  try {
    await promise;
  } catch (error) {
    if (isApiError(error) || (error instanceof Error && error.name === 'ApiError'))
      return error as ApiError;
    throw error;
  }
  throw new Error('the call was expected to fail');
};

const reason = (text = 'wrong customer') => ({ reason: text });

afterEach(() => undefined);

describe('PT-W11 (unit half) each owner action is one POST with a key of its own, the CSRF header and a JSON body of text', () => {
  it('X5 cancel: POST /v1/bills/{id}/cancel with {reason}, the customer in the context', async () => {
    const { server, money } = world();
    const answer = await money.cancelBill(id.priya, b21.id, reason());
    const call = server.seen[0];
    expect(call.method).toBe('POST');
    expect(call.path).toBe(`/v1/bills/${b21.id}/cancel`);
    expect(call.key).toMatch(KEY);
    expect(call.header['x-jv-client']).toBe('web');
    expect(call.header['content-type']).toBe('application/json');
    expect(call.body).toEqual({ reason: 'wrong customer' });
    expect(answer.bill.status).toBe('cancelled');
  });

  it('X4 void: POST /v1/receipts/{id}/void with {reason}', async () => {
    const { server, money } = world();
    await money.voidReceipt(id.priya, r1.id, reason('bounced'));
    expect(server.seen[0].path).toBe(`/v1/receipts/${r1.id}/void`);
    expect(server.seen[0].body).toEqual({ reason: 'bounced' });
  });

  it('X10 re-issue: POST /v1/bills/{id}/reissue with the corrected bill and the reason, and no customer_id', async () => {
    const { server, money } = world();
    const body: ReissueBody = {
      reason: 'wrong rate',
      sale_type: 'Retail',
      bill_date: '2026-10-15',
      items: [
        {
          sku_id: id.walkin,
          metal_rate: '100.00',
          piroi: '0.00',
          other_charges: '0.00',
          quantity: 1,
        },
      ],
      discount: '0.00',
      additional_charges: '0.00',
    };
    await money.reissueBill(id.priya, b21.id, body);
    expect(server.seen[0].path).toBe(`/v1/bills/${b21.id}/reissue`);
    expect(server.seen[0].body).toEqual(body);
    expect(server.seen[0].body).not.toHaveProperty('customer_id');
  });

  it('X11 refund: POST /v1/customers/{id}/refunds; X12 opening balance: POST /v1/customers/{id}/opening-balance', async () => {
    const { server, money } = world();
    await money.issueRefund(id.priya, { amount: '300.00', mode: 'Cash' });
    await money.addOpeningBalance(id.priya, {
      dues: '1000.00',
      advance: '400.00',
      as_of: '2026-10-01',
    });
    expect(server.seen.map((c) => c.path)).toEqual([
      `/v1/customers/${id.priya}/refunds`,
      `/v1/customers/${id.priya}/opening-balance`,
    ]);
    expect(server.seen[1].body).toEqual({
      dues: '1000.00',
      advance: '400.00',
      as_of: '2026-10-01',
    });
    expect(new Set(server.seen.map((c) => c.key)).size).toBe(2);
  });
});

describe('PT-W11 (unit half) C5 (b): nothing is put in memory before the API has answered, and then only what the function returned', () => {
  it('a cancel changes nothing while the call is on its way; then the bill, the pieces and both kinds of allocation row are in memory', async () => {
    const { server, money, cache } = world();
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = money.cancelBill(id.priya, b21.id, reason());
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(cache.get('bills', b21.id)?.status).toBe('active');
    expect(cache.get('skus', cancelAnswer.skus[0].id)?.status).toBe('Sold');
    release();
    await call;
    expect(cache.get('bills', b21.id)?.status).toBe('cancelled');
    expect(cache.get('bills', b21.id)?.cancel_reason).toBe('wrong customer');
    expect(cache.get('skus', cancelAnswer.skus[0].id)?.status).toBe('In Stock');
    // the released row replaced the live one; the rebalance's row is new
    expect(
      cache.get('receipt-allocations', cancelAnswer.released_allocations[0].id)?.released_at
    ).not.toBeNull();
    expect(cache.get('receipt-allocations', cancelAnswer.allocations[0].id)?.bill_id).toBe(b22.id);
  });

  it('a void puts the voided receipt and the rebalance rows in memory', async () => {
    const { money, cache } = world();
    await money.voidReceipt(id.priya, r1.id, reason('bounced'));
    expect(cache.get('receipts', r1.id)?.status).toBe('voided');
    expect(cache.get('receipts', r1.id)?.void_reason).toBe('bounced');
  });

  it('a re-issue puts both bills, the new lines, the carried and released rows in memory', async () => {
    const { money, cache } = world();
    await money.reissueBill(id.priya, b21.id, {
      reason: 'wrong rate',
      sale_type: 'Retail',
      bill_date: '2026-10-15',
      items: [],
      discount: '0.00',
      additional_charges: '0.00',
    });
    expect(cache.get('bills', b21.id)?.status).toBe('cancelled');
    expect(cache.get('bills', fresh.id)?.reissue_of).toBe(b21.id);
    expect(cache.count('bill-items')).toBe(1);
    expect(cache.get('receipt-allocations', reissueAnswer.allocations[0].id)?.bill_id).toBe(
      fresh.id
    );
    expect(
      cache.get('receipt-allocations', reissueAnswer.released_allocations[0].id)?.released_at
    ).not.toBeNull();
  });

  it('a refund puts the refund receipt in memory; an opening balance its bill, receipts and allocations (a call with no dues has no bill)', async () => {
    const { money, cache } = world();
    await money.issueRefund(id.priya, { amount: '300.00', mode: 'Cash' });
    expect(cache.get('receipts', refund.id)?.kind).toBe('refund');
    await money.addOpeningBalance(id.priya, {
      dues: '1000.00',
      advance: '400.00',
      as_of: '2026-10-01',
    });
    expect(cache.get('bills', opening.id)?.doc_type).toBe('opening_balance');
    expect(cache.get('receipts', openingReceipt.id)?.is_opening).toBe(true);
    expect(cache.count('receipt-allocations')).toBe(2);
  });

  it('an opening balance of an advance alone has no bill and merges without one', async () => {
    const server = new FakeOwnerApi(() => ({
      status: 201,
      body: { bill: null, receipts: [openingReceipt], allocations: [] },
    }));
    const api = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: server.fetch as unknown as typeof fetch,
      sleep: async () => undefined,
    });
    const cache = createRowCache();
    const money = createMoneyServer({ api, cache, registerLogoutHook: () => () => undefined });
    const answer = await money.addOpeningBalance(id.priya, {
      advance: '400.00',
      as_of: '2026-10-01',
    });
    expect(answer.bill).toBeNull();
    expect(cache.count('bills')).toBe(0);
    expect(cache.count('receipts')).toBe(1);
  });

  it('a refusal merges nothing and leaves the books as they were', async () => {
    const { server, money, cache } = world();
    server.refuse = {
      code: 'JV_NOT_ALLOWED',
      status: 409,
      details: { reason: 'void_the_refund_first', short_by: '300.00' },
      times: 1,
    };
    const error = await failure(money.voidReceipt(id.priya, r1.id, reason('bounced')));
    expect(error.code).toBe('JV_NOT_ALLOWED');
    expect(error.details).toMatchObject({ reason: 'void_the_refund_first', short_by: '300.00' });
    expect(error.nothingChanged).toBe(true);
    expect(cache.get('receipts', r1.id)?.status).toBe('active');
  });
});

describe('PT-W11 (unit half) T-E06: one Idempotency-Key for each action', () => {
  it('a double click is ONE request and one key, and both clicks get the same answer', async () => {
    const { server, money } = world();
    const [first, second] = await Promise.all([
      money.cancelBill(id.priya, b21.id, reason()),
      money.cancelBill(id.priya, b21.id, reason()),
    ]);
    expect(server.count()).toBe(1);
    expect(server.made).toBe(1);
    expect(second).toBe(first);
  });

  it('the answer is lost after the server saved: the person reads "Could not confirm that this was saved.", presses again, the SAME key is sent and the server replays (one cancel)', async () => {
    const { server, money, cache } = world();
    server.dropAnswers = 1;
    const lost = await failure(money.cancelBill(id.priya, b21.id, reason()));
    expect(lost.code).toBe('NETWORK');
    expect(lost.message).toBe('Could not confirm that this was saved.');
    expect(lost.unconfirmed).toBe(true);
    expect(lost.idempotencyKey).toMatch(KEY);
    expect(server.made).toBe(1); // it was done; the screen did not know
    expect(cache.get('bills', b21.id)?.status).toBe('active'); // and so shows nothing

    const again = await money.cancelBill(id.priya, b21.id, reason());
    const keys = server.seen.map((c) => c.key);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(keys[0]);
    expect(again.bill.id).toBe(b21.id);
    expect(server.made).toBe(1); // still one
    expect(cache.get('bills', b21.id)?.status).toBe('cancelled');
  });

  it('a gateway page after the save is the same: the same key, one effect', async () => {
    const { server, money } = world();
    server.gatewayAfter = 6; // the first try and the five waking-up retries all meet the page: the call ends unconfirmed
    const lost = await failure(money.voidReceipt(id.priya, r1.id, reason('bounced')));
    expect(lost.unconfirmed).toBe(true);
    await money.voidReceipt(id.priya, r1.id, reason('bounced'));
    const keys = new Set(server.seen.map((c) => c.key));
    expect(keys.size).toBe(1);
    expect(server.made).toBe(1);
  });

  it('another reason is another action and gets a key of its own', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.cancelBill(id.priya, b21.id, reason('wrong customer')));
    await money.cancelBill(id.priya, b21.id, reason('wrong rate'));
    const [first, second] = server.seen.map((c) => c.key);
    expect(second).not.toBe(first);
  });

  it('the same refund for another customer, and the same reason on another bill, are other actions', async () => {
    const { server, money } = world();
    await money.issueRefund(id.priya, { amount: '100.00', mode: 'Cash' });
    await money.issueRefund('00000000-0000-4000-8000-0000000c0002', {
      amount: '100.00',
      mode: 'Cash',
    });
    await money.cancelBill(id.priya, b21.id, reason());
    await money.cancelBill(id.priya, b22.id, reason());
    expect(new Set(server.seen.map((c) => c.key)).size).toBe(4);
  });

  it('once an action was done the next identical one is a new action (a second refund of 100.00 is a second refund)', async () => {
    const { server, money } = world();
    await money.issueRefund(id.priya, { amount: '100.00', mode: 'Cash' });
    await money.issueRefund(id.priya, { amount: '100.00', mode: 'Cash' });
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
    expect(server.made).toBe(2);
  });

  it('a refusal then pressing again sends the same key (the claim was rolled back with the refusal, so it is harmless)', async () => {
    const { server, money } = world();
    server.refuse = {
      code: 'JV_NOT_ALLOWED',
      status: 409,
      details: { reason: 'more_than_advance', advance: '0.00', short_by: '100.00' },
      times: 1,
    };
    await failure(money.issueRefund(id.priya, { amount: '100.00', mode: 'Cash' }));
    await money.issueRefund(id.priya, { amount: '100.00', mode: 'Cash' });
    expect(server.seen[1].key).toBe(server.seen[0].key);
  });

  it('closing the dialog forgets the keys of calls that could not be confirmed', async () => {
    const { server, money } = world();
    server.dropAnswers = 1;
    await failure(money.cancelBill(id.priya, b21.id, reason()));
    money.forgetOwnerTries();
    await money.cancelBill(id.priya, b21.id, reason());
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
  });
});

describe('PT-W11 (unit half) C17 / C13: the client says when an owner action is over, however it ended, so the poller reads the books at once', () => {
  it('after a success, a refusal and an unconfirmed outcome the write-finished hook runs once each (the poll that follows brings V1 and V2 of the customer)', async () => {
    const { server, money, writes } = world();
    await money.cancelBill(id.priya, b21.id, reason());
    expect(writes).toHaveLength(1);
    server.refuse = { code: 'JV_ALREADY_VOID', status: 409, times: 1 };
    await failure(money.voidReceipt(id.priya, r1.id, reason('bounced')));
    expect(writes).toHaveLength(2);
    server.dropAnswers = 1;
    await failure(money.issueRefund(id.priya, { amount: '5.00', mode: 'Cash' }));
    expect(writes).toHaveLength(3);
  });

  it('an unconfirmed outcome names the customer for the re-read (the hook has the customer id)', async () => {
    const { server, money, api } = world();
    const seen: Array<string | undefined> = [];
    api.onUnconfirmedSave((save) => seen.push(save.customerId));
    server.dropAnswers = 1;
    await failure(money.cancelBill(id.priya, b21.id, reason()));
    expect(seen).toEqual([id.priya]);
  });
});

describe('PT-W11 (unit half) U8: a logout forgets the keys and throws away an answer that was on its way', () => {
  it('after a logout the same action gets a new key', async () => {
    const { server, money, logout } = world();
    server.dropAnswers = 1;
    await failure(money.cancelBill(id.priya, b21.id, reason()));
    logout();
    await money.cancelBill(id.priya, b21.id, reason());
    expect(server.seen[1].key).not.toBe(server.seen[0].key);
  });

  it('an answer that arrives after a logout is not merged', async () => {
    const { server, money, cache, logout } = world();
    let release: () => void = () => undefined;
    server.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const call = money.cancelBill(id.priya, b21.id, reason());
    await new Promise((resolve) => setTimeout(resolve, 5));
    logout();
    cache.clear();
    release();
    await call;
    expect(cache.count('bills')).toBe(0);
  });
});

describe('PT-W11 (unit half) a caller who is not the owner is refused by the API (the screens do not offer the actions; the API is the wall)', () => {
  it('JV_FORBIDDEN is a refusal before any write: "Nothing was changed."', async () => {
    const { server, money } = world();
    server.role = 'biller';
    const error = await failure(money.cancelBill(id.priya, b21.id, reason()));
    expect(error.code).toBe('JV_FORBIDDEN');
    expect(error.message).toContain('Nothing was changed.');
    expect(server.made).toBe(0);
  });
});
