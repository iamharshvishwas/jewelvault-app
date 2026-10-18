// A fake of the two money-side calls WEB07 makes that the sync fake (server.ts) does not know: X6 `POST /v1/customers` and `GET /v1/customers/:id/ledger`.
// It is spoken to through the REAL API client by a stubbed `fetch`, and it keeps the rule that matters: a repeat of an Idempotency-Key answers the stored result and makes
// nothing new (L5), and the same key with another body is refused, as the built API does. A response can be dropped AFTER the work was saved (the connection fails
// while the answer is on its way), which is the case the retry with the same key exists for.
import type { CustomerRow } from '@/lib/api/types';
import { at, uuid } from './rows';

export interface SeenCall {
  method: string;
  path: string;
  query: Record<string, string>;
  key: string | null;
  body: Record<string, unknown> | undefined;
  header: Record<string, string>;
}

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

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const refusal = (code: string, status: number, message = 'made up by the test') =>
  json(status, { error: { code, message, details: {} }, request_id: 'req-money' });

export class FakeMoneyApi {
  readonly seen: SeenCall[] = [];
  /** The customers the server holds (what a count of the table would say). */
  readonly customers: CustomerRow[] = [];
  /** key -> the body it was first used with and the answer it got. */
  readonly stored = new Map<string, { body: string; row: CustomerRow }>();
  /** The next N answers to X6 are lost after the work was saved: the call fails with no answer. */
  dropAnswers = 0;
  /** The next N calls to X6 fail with this status and code BEFORE anything is saved. */
  refuse: { code: string; status: number; times: number } | null = null;
  /** Holds each X6 call until this promise is settled (a slow server). */
  hold: Promise<void> | null = null;
  /** The ledger of every customer: V3 rows in the order key. */
  readonly ledgers = new Map<string, LedgerWireRow[]>();
  /** The server's cap on a ledger page. */
  ledgerCap = 1000;
  /** Fails the next ledger call with this status. */
  ledgerFailure: number | null = null;
  private clock = 100;

  /** A stamp that rises with every call. */
  private stamp(): string {
    this.clock += 1;
    return at(this.clock);
  }

  count(path: string, method = 'POST'): number {
    return this.seen.filter((c) => c.path === path && c.method === method).length;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const header: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      header[name.toLowerCase()] = value;
    });
    const call: SeenCall = {
      method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      key: header['idempotency-key'] ?? null,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      header,
    };
    this.seen.push(call);

    if (method === 'POST' && url.pathname === '/v1/customers') return this.createCustomer(call);

    const ledger = /^\/v1\/customers\/([0-9a-f-]{36})\/ledger$/.exec(url.pathname);
    if (method === 'GET' && ledger) {
      if (this.ledgerFailure !== null) {
        const status = this.ledgerFailure;
        this.ledgerFailure = null;
        return refusal('JV_INTERNAL', status);
      }
      const all = this.ledgers.get(ledger[1]) ?? [];
      const limit = Math.min(Number(call.query.limit ?? this.ledgerCap), this.ledgerCap);
      // the token is the index of the next row: the real one is opaque, and so is this
      const from = call.query.after ? Number(Buffer.from(call.query.after, 'base64url')) : 0;
      const rows = all.slice(from, from + limit);
      const next =
        rows.length === limit && from + limit <= all.length
          ? { after: Buffer.from(String(from + limit)).toString('base64url') }
          : null;
      return json(200, { rows, next });
    }
    return refusal('JV_NOT_FOUND', 404);
  };

  private async createCustomer(call: SeenCall): Promise<Response> {
    if (this.hold) await this.hold;
    if (call.header['x-jv-client'] !== 'web') return refusal('JV_CSRF', 403);
    if (call.key === null) return refusal('JV_INVALID_INPUT', 422, 'Idempotency-Key is required');
    if (this.refuse && this.refuse.times > 0) {
      this.refuse.times -= 1;
      return refusal(this.refuse.code, this.refuse.status);
    }
    const body = call.body ?? {};
    if (typeof body.name !== 'string' || body.name === '' || typeof body.mobile !== 'string')
      return refusal('JV_INVALID_INPUT', 422, 'name and mobile are required');
    const text = JSON.stringify(body);
    const before = this.stored.get(call.key);
    if (before) {
      if (before.body !== text)
        return refusal('JV_INVALID_INPUT', 422, 'This key was used for another request.');
      return json(201, { customer: before.row }, { 'idempotent-replay': 'true' });
    }
    const n = this.customers.length + 1;
    const stamp = this.stamp();
    const row: CustomerRow = {
      id: uuid(6500 + n),
      name: body.name,
      mobile: body.mobile,
      customer_type: (body.customer_type as CustomerRow['customer_type']) ?? 'Retail',
      email: (body.email as string | undefined) ?? null,
      address: (body.address as string | undefined) ?? null,
      gst_number: (body.gst_number as string | undefined) ?? null,
      pan: (body.pan as string | undefined) ?? null,
      notes: (body.notes as string | undefined) ?? null,
      is_walkin: false,
      archived_at: null,
      created_at: stamp,
      updated_at: stamp,
      created_by: uuid(901),
      updated_by: uuid(901),
    };
    this.customers.push(row);
    this.stored.set(call.key, { body: text, row });
    if (this.dropAnswers > 0) {
      this.dropAnswers -= 1;
      throw new TypeError('Failed to fetch'); // saved, and the answer never arrives
    }
    return json(201, { customer: row });
  }
}

/** A ledger row the way V3 is sent. */
export function ledgerRow(
  n: number,
  customerId: string,
  over: Partial<LedgerWireRow> = {}
): LedgerWireRow {
  return {
    customer_id: customerId,
    entry_date: '2026-10-15',
    entry_at: at(100 + n),
    kind_rank: 1,
    id: uuid(6000 + n),
    kind: 'Invoice',
    description: `Invoice JV-${String(n).padStart(4, '0')}`,
    debit: '1000.00',
    credit: '0.00',
    fine_debit: '0.000',
    fine_credit: '0.000',
    balance: '1000.00',
    fine_balance: '0.000',
    ...over,
  };
}
