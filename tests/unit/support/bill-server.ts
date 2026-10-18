// A fake of X1 `POST /v1/bills` (WEB08), spoken to through the REAL API client by a stubbed `fetch`. It keeps the rules the screen relies on: a repeat of an Idempotency-Key answers the
// stored result with `Idempotent-Replay: true` and makes nothing new, the same key with another body is refused (L5), a call without the CSRF header or without a key is refused, and
// the figures are the ones `priceBill` of src/lib/pricing.ts works out (the API runs the same file, C12), unless a test says the server answers otherwise.
//
// What a test can do to the call: lose the answer AFTER the bill was saved (`dropAnswers`), answer a proxy's 502 page BEFORE anything is saved (`gatewayBefore`) or AFTER it was
// (`gatewayAfter`), refuse with an S8 code before anything is saved (`refuse`), hold the call until the test lets it go (`hold`), and change the answer (`transform`).
import type {
  BillItemRow,
  BillRow,
  CreateBillResponse,
  ReceiptAllocationRow,
  ReceiptRow,
} from '@/lib/api/types';
import type { BillBody } from '@/lib/billing';
import { parseRupees, priceBill, formatRupees, formatGrams } from '@/lib/pricing';
import { allocationRow, billRow, itemRow, receiptRow } from './money-rows';
import { at } from './rows';

export interface PieceFact {
  sku_no: string;
  material: 'Gold' | 'Silver';
  purity: string;
  selling_method: 'By Weight' | 'Per Piece';
  /** Milligrams. */
  weightMg: number;
}

export interface BillCall {
  method: string;
  path: string;
  key: string | null;
  body: BillBody | undefined;
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
) => json(status, { error: { code, message, details }, request_id: 'req-bill' });
const proxyPage = () =>
  new Response('<html><body><h1>502 Bad Gateway</h1></body></html>', {
    status: 502,
    headers: { 'content-type': 'text/html' },
  });

export class FakeBillApi {
  readonly seen: BillCall[] = [];
  /** The bills the server holds (a count of the table). */
  readonly bills: CreateBillResponse[] = [];
  /** key -> the body it was first used with and the answer it got. */
  readonly stored = new Map<string, { body: string; answer: CreateBillResponse }>();
  /** What the server knows about each piece (the locked rows of X1). */
  readonly pieces = new Map<string, PieceFact>();
  /** The next N calls are saved and then the connection fails: no answer arrives. */
  dropAnswers = 0;
  /** The next N calls get a proxy's 502 page before the API has seen them (the app is waking up). */
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
  /** Changes the answer of a bill that was just saved (the server answers otherwise than the preview). */
  transform: ((answer: CreateBillResponse) => CreateBillResponse) | null = null;
  /** The cash round-off setting the server prices with. */
  roundOffSetting = true;
  private n = 0;

  count(path = '/v1/bills'): number {
    return this.seen.filter((c) => c.method === 'POST' && c.path === path).length;
  }

  readonly fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const header: Record<string, string> = {};
    new Headers(init.headers).forEach((value, name) => {
      header[name.toLowerCase()] = value;
    });
    const call: BillCall = {
      method,
      path: url.pathname,
      key: header['idempotency-key'] ?? null,
      body: typeof init.body === 'string' ? (JSON.parse(init.body) as BillBody) : undefined,
      header,
    };
    this.seen.push(call);
    if (method === 'POST' && url.pathname === '/v1/bills') return this.createBill(call);
    return refusal('JV_NOT_FOUND', 404);
  };

  private async createBill(call: BillCall): Promise<Response> {
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
    const text = JSON.stringify(call.body);
    const before = this.stored.get(call.key);
    if (before) {
      if (before.body !== text)
        return refusal('JV_INVALID_INPUT', 422, { field: 'idempotency_key' });
      return json(201, before.answer, { 'idempotent-replay': 'true' });
    }
    // a piece that is on a bill already cannot be billed again (K2, R10)
    const sold = new Set(this.bills.flatMap((b) => b.items.map((i) => i.sku_id)));
    const clash = call.body.items.filter((i) => sold.has(i.sku_id));
    if (clash.length > 0) {
      return refusal('JV_PIECE_UNAVAILABLE', 409, {
        sku_ids: clash.map((i) => i.sku_id),
        pieces: clash.map((i) => ({
          sku_id: i.sku_id,
          sku_no: this.pieces.get(i.sku_id)?.sku_no ?? '?',
          status: 'Sold',
        })),
      });
    }
    let answer = this.make(call.body, call.key);
    if (this.transform) answer = this.transform(answer);
    this.bills.push(answer);
    this.stored.set(call.key, { body: text, answer });
    if (this.dropAnswers > 0) {
      this.dropAnswers -= 1;
      throw new TypeError('Failed to fetch'); // saved, and the answer never arrives
    }
    if (this.gatewayAfter > 0) {
      this.gatewayAfter -= 1;
      return proxyPage();
    }
    return json(201, answer);
  }

  /** The answer of X1 for a body: the figures are the shared pricing.ts's, the rows have the shape of the API's. */
  private make(body: BillBody, key: string): CreateBillResponse {
    this.n += 1;
    const priced = priceBill({
      saleType: body.sale_type,
      roundOffSetting: this.roundOffSetting,
      discountPaise: parseRupees(body.discount),
      additionalChargesPaise: parseRupees(body.additional_charges),
      lines: body.items.map((item) => {
        const piece = this.pieces.get(item.sku_id);
        if (!piece) throw new Error(`the fake does not know the piece ${item.sku_id}`);
        return {
          material: piece.material,
          sellingMethod: piece.selling_method,
          customerNetWeightMg: piece.weightMg,
          quantity: item.quantity,
          metalRatePaise: parseRupees(item.metal_rate),
          labourRatePaise: item.labour_rate ? parseRupees(item.labour_rate) : null,
          piroiPaise: parseRupees(item.piroi),
          otherChargesPaise: parseRupees(item.other_charges),
        };
      }),
    });
    const bill: BillRow = billRow(this.n, body.customer_id, {
      bill_date: body.bill_date,
      sale_type: body.sale_type,
      subtotal: formatRupees(priced.subtotalPaise),
      discount: formatRupees(priced.discountPaise),
      additional_charges: formatRupees(priced.additionalChargesPaise),
      round_off: formatRupees(priced.roundOffPaise),
      grand_total: formatRupees(priced.grandTotalPaise),
      fine_weight_due: formatGrams(priced.fineWeightDueMg),
      notes: body.notes ?? null,
      cash_override_reason: body.cash_override_reason ?? null,
      created_at: at(60 + this.n),
      updated_at: at(60 + this.n),
    });
    const items: BillItemRow[] = body.items.map((item, i) => {
      const line = priced.lines[i];
      const piece = this.pieces.get(item.sku_id) as PieceFact;
      return itemRow(bill, i + 1, {
        sku_id: item.sku_id,
        sku_no: piece.sku_no,
        selling_method: piece.selling_method,
        material: piece.material,
        purity: piece.purity,
        quantity: line.quantity,
        metal_rate: item.metal_rate,
        labour_rate: item.labour_rate ?? '0.00',
        labour_amount: formatRupees(line.labourAmountPaise),
        metal_amount: formatRupees(line.metalAmountPaise),
        piroi: item.piroi,
        other_charges: item.other_charges,
        item_total: formatRupees(line.itemTotalPaise),
        fine_weight_due: formatGrams(line.fineWeightDueMg),
      });
    });
    const receipts: ReceiptRow[] = [];
    const allocations: ReceiptAllocationRow[] = [];
    (body.payments ?? []).forEach((payment, i) => {
      const receipt = receiptRow(this.n * 10 + i, body.customer_id, {
        mode: payment.mode,
        amount: payment.amount,
        paid_on: body.bill_date,
      });
      receipts.push(receipt);
      allocations.push(allocationRow(this.n * 10 + i, receipt, bill, { amount: payment.amount }));
    });
    void key;
    return {
      bill,
      items,
      receipts,
      allocations,
      warnings: [],
      advance_applied: '0.00',
    };
  }
}
