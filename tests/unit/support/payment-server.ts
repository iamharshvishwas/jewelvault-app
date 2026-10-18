// A fake of X2 `POST /v1/customers/{id}/payments` and X3 `POST /v1/customers/{id}/fine-settlements` (WEB09), spoken to through the REAL API client by a stubbed `fetch`. It keeps the
// rules the screen relies on: a repeat of an Idempotency-Key answers the stored result with `Idempotent-Replay: true` and makes nothing new, the same key with another body or for
// another customer is refused (L5, the key is claimed with the path id), a call without the CSRF header or without a key is refused, a payment is allocated to the named bill first and
// then oldest first (Y3) and what is left is kept as an advance (Y5), a fine is allocated the same way in grams and may not be more than is owed (SF2), and the walk-in must name its
// bill (K5, O52).
//
// What a test can do to the call: lose the answer AFTER it was saved (`dropAnswers`), answer a proxy's 502 page BEFORE anything is saved (`gatewayBefore`) or AFTER it was
// (`gatewayAfter`), refuse with an S8 code before anything is saved (`refuse`), and hold the call until the test lets it go (`hold`).
import type {
  BillRow,
  ReceiptAllocationRow,
  ReceiptRow,
  RecordPaymentResponse,
  SettleFineResponse,
} from '@/lib/api/types';
import type { RecordPaymentBody, SettleFineBody } from '@/lib/payments';
import { formatGrams, formatRupees, parseGrams, parseRupees } from '@/lib/pricing';
import { allocationRow, billRow, receiptRow } from './money-rows';

export interface OpenBill {
  row: BillRow;
  /** Paise still to pay. */
  pending: number;
  /** Milligrams of silver still to settle. */
  finePending: number;
}

export interface PaymentCall {
  method: string;
  path: string;
  key: string | null;
  body: Record<string, string | undefined> | undefined;
  header: Record<string, string>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
export const refusal = (
  code: string,
  status: number,
  details: Record<string, unknown> = {},
  message = 'made up by the test'
) => json(status, { error: { code, message, details }, request_id: 'req-pay' });
const proxyPage = () =>
  new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });

const PATH = /^\/v1\/customers\/([0-9a-f-]{36})\/(payments|fine-settlements)$/;

export class FakePaymentApi {
  readonly seen: PaymentCall[] = [];
  /** Every receipt the server holds, in the order made. */
  readonly receipts: ReceiptRow[] = [];
  readonly allocations: ReceiptAllocationRow[] = [];
  /** key -> the path and body it was first used with, and the answer it got. */
  readonly stored = new Map<string, { path: string; body: string; answer: unknown }>();
  /** The open bills of each customer, oldest first. */
  readonly bills = new Map<string, OpenBill[]>();
  /** The customers that are the walk-in (K5). */
  readonly walkIns = new Set<string>();
  /** Money a customer holds that no bill needed (paise). */
  readonly advance = new Map<string, number>();
  /** The next N calls are saved and then the connection fails: no answer arrives. */
  dropAnswers = 0;
  /** The next N calls get a proxy's 502 page before the API has seen them. */
  gatewayBefore = 0;
  /** The next N calls are saved, and then a proxy's 502 page comes back instead of the answer. */
  gatewayAfter = 0;
  /** The next N calls are refused with this code before anything is saved. */
  refuse: {
    code: string;
    status: number;
    details?: Record<string, unknown>;
    times: number;
  } | null = null;
  /** Holds each call until this promise is settled (a slow server). */
  hold: Promise<void> | null = null;
  private n = 0;

  /** Opens a bill of `customerId` with money and/or silver to pay; returns it. */
  openBill(customerId: string, number: number, pendingPaise: number, finePendingMg = 0): OpenBill {
    const row = billRow(number, customerId, { bill_no: `JV-${String(number).padStart(4, '0')}` });
    const bill = { row, pending: pendingPaise, finePending: finePendingMg };
    this.bills.set(customerId, [...(this.bills.get(customerId) ?? []), bill]);
    return bill;
  }

  count(path?: string): number {
    return this.seen.filter(
      (c) => c.method === 'POST' && (path === undefined || c.path.endsWith(path))
    ).length;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const header: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      header[name.toLowerCase()] = value;
    });
    const call: PaymentCall = {
      method,
      path: url.pathname,
      key: header['idempotency-key'] ?? null,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      header,
    };
    this.seen.push(call);
    const found = PATH.exec(url.pathname);
    if (method === 'POST' && found) return this.handle(call, found[1], found[2]);
    return refusal('JV_NOT_FOUND', 404);
  };

  private async handle(call: PaymentCall, customerId: string, kind: string): Promise<Response> {
    if (this.hold) await this.hold;
    if (call.header['x-jv-client'] !== 'web') return refusal('JV_CSRF', 403);
    if (call.key === null || call.body === undefined)
      return refusal('JV_INVALID_INPUT', 422, { field: 'idempotency_key' });
    if (this.gatewayBefore > 0) {
      this.gatewayBefore -= 1;
      return proxyPage();
    }
    if (this.refuse && this.refuse.times > 0) {
      this.refuse.times -= 1;
      return refusal(this.refuse.code, this.refuse.status, this.refuse.details ?? {});
    }
    // the server compares the body, not the order its keys were written in
    const text = JSON.stringify(Object.entries(call.body).sort(([a], [b]) => a.localeCompare(b)));
    const before = this.stored.get(call.key);
    if (before) {
      // the key is claimed with the body and the path id: another body, or another customer, is a different action
      if (before.body !== text || before.path !== call.path)
        return refusal('JV_INVALID_INPUT', 422, { field: 'idempotency_key' });
      return json(201, before.answer, { 'idempotent-replay': 'true' });
    }
    const made =
      kind === 'payments'
        ? this.pay(customerId, call.body as unknown as RecordPaymentBody)
        : this.settle(customerId, call.body as unknown as SettleFineBody);
    if (made instanceof Response) return made;
    this.stored.set(call.key, { path: call.path, body: text, answer: made });
    if (this.dropAnswers > 0) {
      this.dropAnswers -= 1;
      throw new TypeError('Failed to fetch'); // saved, and the answer never arrives
    }
    if (this.gatewayAfter > 0) {
      this.gatewayAfter -= 1;
      return proxyPage();
    }
    return json(201, made);
  }

  // ---- X2
  private pay(customerId: string, body: RecordPaymentBody): RecordPaymentResponse | Response {
    const open = (this.bills.get(customerId) ?? []).filter((b) => b.pending > 0);
    const amount = parseRupees(body.amount);
    const named = body.bill_id ? open.find((b) => b.row.id === body.bill_id) : undefined;
    if (body.bill_id && !named) return refusal('JV_INVALID_INPUT', 422, { field: 'bill_id' });
    if (this.walkIns.has(customerId)) {
      if (!named) return refusal('JV_OVERPAYMENT', 409, { field: 'bill_id' });
      if (amount > named.pending)
        return refusal('JV_OVERPAYMENT', 409, {
          field: 'amount',
          pending: formatRupees(named.pending),
        });
    }
    this.n += 1;
    const receipt = receiptRow(this.n, customerId, {
      kind: 'money',
      mode: body.mode,
      amount: body.amount,
      paid_on: '2026-10-15',
      reference: body.reference ?? null,
      notes: body.notes ?? null,
      cash_override_reason: body.cash_override_reason ?? null,
    });
    this.receipts.push(receipt);
    let left = amount;
    const allocations: ReceiptAllocationRow[] = [];
    const order = named ? [named, ...open.filter((b) => b !== named)] : open;
    for (const bill of order) {
      if (left <= 0) break;
      const take = Math.min(left, bill.pending);
      bill.pending -= take;
      left -= take;
      const row = allocationRow(this.n * 10 + allocations.length, receipt, bill.row, {
        amount: formatRupees(take),
      });
      allocations.push(row);
    }
    this.allocations.push(...allocations);
    this.advance.set(customerId, (this.advance.get(customerId) ?? 0) + left);
    return { receipt, allocations, advance_remaining: formatRupees(left) };
  }

  // ---- X3
  private settle(customerId: string, body: SettleFineBody): SettleFineResponse | Response {
    if (body.mode === 'Silver' && body.silver_rate != null)
      return refusal('JV_INVALID_INPUT', 422, { field: 'silver_rate' });
    if (body.mode === 'Cash' && body.silver_rate == null)
      return refusal('JV_INVALID_INPUT', 422, { field: 'silver_rate' });
    const open = (this.bills.get(customerId) ?? []).filter((b) => b.finePending > 0);
    const grams = parseGrams(body.grams);
    const named = body.bill_id ? open.find((b) => b.row.id === body.bill_id) : undefined;
    if (body.bill_id && !named) return refusal('JV_INVALID_INPUT', 422, { field: 'bill_id' });
    const owed = open.reduce((n, b) => n + b.finePending, 0);
    if (this.walkIns.has(customerId)) {
      if (!named) return refusal('JV_FINE_EXCEEDS', 409, { field: 'bill_id' });
      if (grams > named.finePending)
        return refusal('JV_FINE_EXCEEDS', 409, {
          field: 'grams',
          max_grams: formatGrams(named.finePending),
        });
    } else if (grams > owed) {
      return refusal('JV_FINE_EXCEEDS', 409, { field: 'grams', max_grams: formatGrams(owed) });
    }
    this.n += 1;
    const cash = body.mode === 'Cash';
    const rate = cash ? parseRupees(body.silver_rate as string) : 0;
    const amount = cash ? Math.floor((grams * rate + 500) / 1000) : 0;
    const receipt = receiptRow(this.n, customerId, {
      kind: cash ? 'fine_cash' : 'fine_silver',
      mode: cash ? 'Cash' : null,
      amount: formatRupees(amount),
      fine_grams: body.grams,
      silver_rate: cash ? (body.silver_rate as string) : null,
      paid_on: '2026-10-15',
      cash_override_reason: body.cash_override_reason ?? null,
    });
    this.receipts.push(receipt);
    let left = grams;
    const allocations: ReceiptAllocationRow[] = [];
    const order = named ? [named, ...open.filter((b) => b !== named)] : open;
    for (const bill of order) {
      if (left <= 0) break;
      const take = Math.min(left, bill.finePending);
      bill.finePending -= take;
      left -= take;
      allocations.push(
        allocationRow(this.n * 10 + allocations.length, receipt, bill.row, {
          amount: '0.00',
          fine_grams: formatGrams(take),
        })
      );
    }
    this.allocations.push(...allocations);
    const remaining = (this.bills.get(customerId) ?? []).reduce((n, b) => n + b.finePending, 0);
    return { receipt, allocations, fine_remaining: formatGrams(remaining) };
  }
}
