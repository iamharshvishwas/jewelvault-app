// WEB08 (spec C5 (b), C6, C12, R1 to R10, Z1 to Z3): the billing screen without the screen, `src/lib/billing.ts`.
//
//   T-A03  (UNIT half) choosing a customer sets the bill's sale type, and the default labour rate follows it (R1, R9)
//   R2     the default metal rate is the daily rate of the piece's material and purity dated on or before the bill date; no rate asks the person for one
//   T-A14  (screen half, the figures) the live total is `priceBill` of pricing.ts: the worked example is 257,612; what is typed is exact, never a floating-point number
//   C6     the body of X1 is the same text for the same bill however it was typed (so the same bill is the same action and the same Idempotency-Key)
//   C12    the saved figures replace the preview, and the places where they differ are reported
//   C13    each error code of a save has a plain sentence; JV_PIECE_UNAVAILABLE names the pieces
//   Z3     a PAN is five capital letters, four digits, one capital letter
import { describe, expect, it } from 'vitest';
import {
  CASH_REASON_MIN,
  PAYMENT_MODES,
  WALK_IN_ID,
  billSaveFailure,
  buildBillBody,
  inr,
  isPan,
  newBillingItem,
  normalisePan,
  previewBill,
  saleTypeAfterChoosing,
  savedBillFrom,
  signedRupees,
  withBillDate,
  withSaleType,
  type BillingItem,
  type LineContext,
  type PaymentEntry,
  type SaleType,
} from '@/lib/billing';
import { ApiError } from '@/lib/api/client';
import type { CreateBillResponse } from '@/lib/api/types';
import type { Sku } from '@/lib/mockData';
import { priceBill } from '@/lib/pricing';
import { FakeBillApi } from './support/bill-server';
import { allocationRow, receiptRow } from './support/money-rows';
import { uuid } from './support/rows';

// ------------------------------------------------------------------------------------------------ what the screen holds

let counter = 0;
/** A piece the way the stores make it (numbers made from the API's text). The worked example of the spec: NW 35.42 g, labour 353 a gram, piroi 2.15. */
function sku(over: Partial<Sku> = {}): Sku {
  counter += 1;
  return {
    id: uuid(1000 + counter),
    skuNumber: `RING-00001-${String(counter).padStart(3, '0')}`,
    designId: uuid(300),
    designNumber: 'RING-00001',
    grossWeight: 38.1,
    originalNetWeight: 0,
    customerNetWeight: 35.42,
    stones: 0,
    stoneWeight: 0,
    kundan: 0,
    kundanWeight: 0,
    piroi: 2.15,
    labour: 353,
    retailLabour: 353,
    semiWholesaleLabour: 340,
    wholesaleLabour: 320,
    status: 'In Stock',
    location: 'Main Showroom',
    barcode: `BC${counter}`,
    createdAt: '2026-10-15T09:00:00.000Z',
    createdBy: '',
    notes: '',
    sellingMethod: 'By Weight',
    purity: '22K',
    material: 'Gold',
    category: 'Ring',
    subcategory: '',
    ...over,
  };
}

const RATES = [
  { material: 'Gold', purity: '22K', ratePerGram: '6920.00', rateDate: '2026-10-15' },
  { material: 'Gold', purity: '22K', ratePerGram: '6800.00', rateDate: '2026-10-10' },
  { material: 'Gold', purity: '24K', ratePerGram: '7500.00', rateDate: '2026-10-12' },
  { material: 'Silver', purity: '925', ratePerGram: '88.00', rateDate: '2026-10-15' },
];
const context = (saleType: SaleType = 'Retail', billDate = '2026-10-15'): LineContext => ({
  saleType,
  billDate,
  rates: RATES,
});
const item = (over: Partial<Sku> = {}, ctx = context()): BillingItem =>
  newBillingItem(sku(over), ctx);
const preview = (items: BillingItem[], over: Partial<Parameters<typeof previewBill>[0]> = {}) =>
  previewBill({
    items,
    saleType: 'Retail',
    discount: '',
    additionalCharges: '',
    roundOffSetting: true,
    ...over,
  });

// ------------------------------------------------------------------------------------------------ T-A03, UNIT half

describe('T-A03 (UNIT half, R1, R9): choosing a customer sets the sale type, and the default labour rate follows it', () => {
  it("a customer's type becomes the bill's sale type; no customer leaves it as it is", () => {
    expect(saleTypeAfterChoosing({ customerType: 'Wholesale' }, 'Retail')).toBe('Wholesale');
    expect(saleTypeAfterChoosing({ customerType: 'Semi-Wholesale' }, 'Wholesale')).toBe(
      'Semi-Wholesale'
    );
    expect(saleTypeAfterChoosing({ customerType: 'Retail' }, 'Wholesale')).toBe('Retail');
    expect(saleTypeAfterChoosing(null, 'Semi-Wholesale')).toBe('Semi-Wholesale');
  });

  it("a new line takes the piece's labour rate for the sale type, and every line follows when the type changes", () => {
    const first = item({}, context('Retail'));
    expect(first.labour).toBe('353.00');
    const wholesale = withSaleType([first], context('Wholesale'));
    expect(wholesale[0].labour).toBe('320.00');
    const semi = withSaleType(wholesale, context('Semi-Wholesale'));
    expect(semi[0].labour).toBe('340.00');
    expect(withSaleType(semi, context('Retail'))[0].labour).toBe('353.00');
    expect(item({}, context('Wholesale')).labour).toBe('320.00');
  });

  it('a blank rate falls to the next one in the chain of R1, and a rate of 0 is a rate', () => {
    const noWholesale = sku({ wholesaleLabour: undefined });
    expect(newBillingItem(noWholesale, context('Wholesale')).labour).toBe('340.00'); // semi
    const onlyRetail = sku({ wholesaleLabour: undefined, semiWholesaleLabour: undefined });
    expect(newBillingItem(onlyRetail, context('Semi-Wholesale')).labour).toBe('353.00');
    const zero = sku({ wholesaleLabour: 0 });
    expect(newBillingItem(zero, context('Wholesale')).labour).toBe('0.00');
  });

  it('a Per Piece piece takes the piece price of the sale type as its rate, and it follows the type', () => {
    const ring = item(
      {
        sellingMethod: 'Per Piece',
        retailLabour: 1200,
        semiWholesaleLabour: 1100,
        wholesaleLabour: 1000,
      },
      context('Retail')
    );
    expect(ring.metalRate).toBe('1200.00');
    expect(ring.rate.status).toBe('piece');
    expect(withSaleType([ring], context('Wholesale'))[0].metalRate).toBe('1000.00');
  });

  it('a sale type change leaves the metal rate of a By Weight line alone', () => {
    const typed = { ...item(), metalRate: '7000' };
    expect(withSaleType([typed], context('Wholesale'))[0].metalRate).toBe('7000');
  });
});

// ------------------------------------------------------------------------------------------------ R2

describe('R2: the default metal rate is the latest daily rate of the metal and purity dated on or before the bill date', () => {
  it('takes the rate of the day, and says nothing is wrong', () => {
    const line = item();
    expect(line.metalRate).toBe('6920.00');
    expect(line.rate).toEqual({ status: 'ok', date: '2026-10-15' });
  });

  it('takes the latest earlier rate when the day has none, and says it is stale', () => {
    const line = item({ purity: '24K' }); // 7500 dated 12 Oct
    expect(line.metalRate).toBe('7500.00');
    expect(line.rate).toEqual({ status: 'stale', date: '2026-10-12' });
  });

  it('has no rate for a purity with no row: the field is blank and the line cannot be priced until one is typed', () => {
    const line = item({ purity: '20K' });
    expect(line.metalRate).toBe('');
    expect(line.rate.status).toBe('missing');
    const shown = preview([line]);
    expect(shown.bill).toBeNull();
    expect(shown.lines[0].error).toBe(
      'No daily rate is set for Gold 20K for this date: enter the rate.'
    );
    expect(shown.error).toBe(`${line.sku.skuNumber}: ${shown.lines[0].error}`);
    const typed = preview([{ ...line, metalRate: '6000' }]);
    expect(typed.bill).not.toBeNull();
  });

  it('a rate dated after the bill date is not used', () => {
    expect(item({}, context('Retail', '2026-10-11')).metalRate).toBe('6800.00'); // the 10 Oct rate
    expect(item({}, context('Retail', '2026-10-09')).rate.status).toBe('missing');
  });

  it('a line that still has its default follows the bill date; a rate the person typed does not', () => {
    const untouched = item();
    const typed = { ...item(), metalRate: '6955' };
    const moved = withBillDate([untouched, typed], context('Retail', '2026-10-11'));
    expect(moved[0].metalRate).toBe('6800.00');
    expect(moved[0].rate).toEqual({ status: 'stale', date: '2026-10-10' });
    expect(moved[1].metalRate).toBe('6955');
  });
});

// ------------------------------------------------------------------------------------------------ the preview (C12)

describe('T-A14 (screen half: the figures, C12): the live total is pricing.ts, exact', () => {
  it('the worked example of the spec: 35.42 g at 6,920, labour 353, piroi 2.15 is a bill of 257,612', () => {
    const line = { ...item(), metalRate: '6920', labour: '353', piroi: '2.15' };
    const shown = preview([line]);
    expect(shown.error).toBeNull();
    const priced = shown.lines[0].priced;
    expect(priced?.metalAmountPaise).toBe(24510640); // 245,106.40
    expect(priced?.labourAmountPaise).toBe(1250326); // 12,503.26
    expect(priced?.itemTotalPaise).toBe(25761181); // 257,611.81
    expect(shown.bill?.subtotalPaise).toBe(25761181);
    expect(shown.bill?.grandTotalPaise).toBe(25761200); // 257,612
    expect(shown.bill?.roundOffPaise).toBe(19);
    expect(inr(shown.bill?.grandTotalPaise ?? 0, false)).toBe('₹2,57,612');
    expect(inr(25761181)).toBe('₹2,57,611.81');
  });

  it('is exactly what priceBill gives for the same figures', () => {
    const line = { ...item(), metalRate: '6920', labour: '353', piroi: '2.15' };
    const direct = priceBill({
      saleType: 'Retail',
      roundOffSetting: true,
      lines: [
        {
          material: 'Gold',
          sellingMethod: 'By Weight',
          customerNetWeightMg: 35420,
          metalRatePaise: 692000,
          labourRatePaise: 35300,
          piroiPaise: 215,
        },
      ],
    });
    expect(preview([line]).bill).toEqual(direct);
  });

  it('a discount and additional charges are taken off and added exactly; round-off follows the setting', () => {
    const line = { ...item(), metalRate: '6920' };
    const shown = preview([line], { discount: '1000.50', additionalCharges: '25' });
    expect(shown.bill?.beforeRoundPaise).toBe(25761181 - 100050 + 2500);
    expect(preview([line], { roundOffSetting: false }).bill?.roundOffPaise).toBe(0);
    expect(signedRupees(19)).toBe('+0.19');
    expect(signedRupees(-40)).toBe('-0.40');
  });

  it('a silver piece of a Wholesale bill is silver fine due and has no metal amount (R4, R5)', () => {
    const silver = item({ material: 'Silver', purity: '925', customerNetWeight: 120 });
    const shown = preview([silver], { saleType: 'Wholesale' });
    expect(shown.lines[0].priced?.fineWeightDueMg).toBe(120000);
    expect(shown.lines[0].priced?.metalAmountPaise).toBe(0);
    expect(shown.bill?.fineWeightDueMg).toBe(120000);
  });

  it('says in plain words what cannot be priced, and never lets a wrong figure into the total', () => {
    const line = item();
    expect(preview([{ ...line, metalRate: '' }]).lines[0].error).toBe(
      'Enter the metal rate per gram.'
    );
    expect(preview([{ ...line, metalRate: '6920.555' }]).lines[0].error).toBe(
      'The metal rate per gram can have at most 2 decimals.'
    );
    expect(preview([{ ...line, metalRate: '-5' }]).lines[0].error).toBe(
      'The metal rate per gram cannot be negative.'
    );
    expect(preview([{ ...line, labour: '' }]).lines[0].error).toBe(
      'Enter the labour rate per gram.'
    );
    expect(preview([{ ...line, quantity: '2' }]).lines[0].error).toBe(
      'A By Weight piece is sold once.'
    );
    expect(preview([{ ...line, piroi: 'abc' }]).lines[0].error).toBe('The piroi must be a number.');
    expect(preview([{ ...line, metalRate: '999999999' }]).lines[0].error).toBe(
      'The metal rate is more than the system allows.'
    );
    expect(preview([{ ...line, metalRate: '1e3' }]).bill).toBeNull();
    const toohigh = preview([{ ...line, metalRate: '6920' }], { discount: '999999999' });
    expect(toohigh.bill).toBeNull();
    expect(toohigh.error).toBe(
      'The discount is more than the subtotal plus the additional charges.'
    );
  });

  it('a Per Piece line is the price times the quantity; piroi and other charges once (R5, R7)', () => {
    const piece = item({
      sellingMethod: 'Per Piece',
      retailLabour: 1200,
      customerNetWeight: 0,
      piroi: 10,
    });
    const line = { ...piece, quantity: '3', otherCharges: '5.5' };
    const shown = preview([line]);
    expect(shown.lines[0].priced?.itemTotalPaise).toBe(360000 + 1000 + 550);
    expect(preview([{ ...line, quantity: '0' }]).lines[0].error).toBe(
      'The quantity must be from 1 to 1,000.'
    );
    expect(preview([{ ...line, quantity: '2.5' }]).lines[0].error).toBe(
      'The quantity must be a whole number.'
    );
  });

  it('an empty bill has no total and no complaint', () => {
    expect(preview([])).toEqual({ lines: [], bill: null, error: null });
  });
});

// ------------------------------------------------------------------------------------------------ the request

const billInput = (
  items: BillingItem[],
  over: Partial<Parameters<typeof buildBillBody>[0]> = {}
) => ({
  customerId: uuid(5001) as string | null,
  saleType: 'Retail' as SaleType,
  billDate: '2026-10-15',
  items,
  discount: '',
  additionalCharges: '',
  notes: '',
  payments: [] as PaymentEntry[],
  cashOverrideReason: '',
  ...over,
});

describe('the body of X1 (C5 (b), L5, D13, Z1, R10)', () => {
  it("is text for every money figure with two decimals, whole counts, and no weight (the piece is the server's)", () => {
    const line = { ...item(), metalRate: '6920', labour: '353', piroi: '2.15' };
    const made = buildBillBody(billInput([line], { notes: ' Bridal set ' }));
    expect(made).toEqual({
      body: {
        customer_id: uuid(5001),
        sale_type: 'Retail',
        bill_date: '2026-10-15',
        items: [
          {
            sku_id: line.sku.id,
            metal_rate: '6920.00',
            labour_rate: '353.00',
            piroi: '2.15',
            other_charges: '0.00',
            quantity: 1,
          },
        ],
        discount: '0.00',
        additional_charges: '0.00',
        notes: 'Bridal set',
      },
    });
  });

  it("a Per Piece line sends no labour rate; a bill with no customer is the walk-in's", () => {
    const piece = item({ sellingMethod: 'Per Piece', retailLabour: 1200 });
    const made = buildBillBody(billInput([{ ...piece, quantity: '2' }], { customerId: null }));
    if (!('body' in made)) throw new Error(made.error);
    expect(made.body.customer_id).toBe(WALK_IN_ID);
    expect(made.body.items[0]).toEqual({
      sku_id: piece.sku.id,
      metal_rate: '1200.00',
      piroi: '2.15',
      other_charges: '0.00',
      quantity: 2,
    });
    expect('labour_rate' in made.body.items[0]).toBe(false);
  });

  it('the same bill typed differently is the same body, so it is the same action (C6)', () => {
    const a = { ...item(), metalRate: '6920.5', labour: '353', piroi: '2.1' };
    const b = { ...a, id: a.id, metalRate: '6920.50', labour: '353.00', piroi: '2.10' };
    expect(buildBillBody(billInput([a]))).toEqual(buildBillBody(billInput([b])));
    const c = { ...a, metalRate: '6921' };
    expect(buildBillBody(billInput([c]))).not.toEqual(buildBillBody(billInput([a])));
  });

  it('the payment rows are the five modes, a blank or zero row is no payment, and there is no Credit', () => {
    expect(PAYMENT_MODES).toEqual(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']);
    expect(PAYMENT_MODES as readonly string[]).not.toContain('Credit');
    const line = item();
    const made = buildBillBody(
      billInput([line], {
        payments: [
          { id: 'p1', mode: 'UPI', amount: '' },
          { id: 'p2', mode: 'Cash', amount: '5000.5' },
          { id: 'p3', mode: 'Card', amount: '0' },
          { id: 'p4', mode: 'Bank Transfer', amount: '100' },
        ],
      })
    );
    if (!('body' in made)) throw new Error(made.error);
    expect(made.body.payments).toEqual([
      { mode: 'Cash', amount: '5000.50' },
      { mode: 'Bank Transfer', amount: '100.00' },
    ]);
    const unpaid = buildBillBody(
      billInput([line], { payments: [{ id: 'p', mode: 'UPI', amount: '' }] })
    );
    if (!('body' in unpaid)) throw new Error(unpaid.error);
    expect('payments' in unpaid.body).toBe(false); // a bill left unpaid has no receipt (Y2)
  });

  it("names the held pieces the person confirmed (R10) and the owner's reason for cash (Z1), and nothing else", () => {
    const held = newBillingItem(sku({ status: 'Reserved' }), context(), 'Reserved');
    const plain = item();
    const made = buildBillBody(
      billInput([held, plain], { cashOverrideReason: '  Wedding, known family  ' })
    );
    if (!('body' in made)) throw new Error(made.error);
    expect(made.body.confirm_held).toEqual([held.sku.id]);
    expect(made.body.cash_override_reason).toBe('Wedding, known family');
    const none = buildBillBody(billInput([plain]));
    if (!('body' in none)) throw new Error(none.error);
    expect('confirm_held' in none.body).toBe(false);
    expect('cash_override_reason' in none.body).toBe(false);
  });

  it("a bill takes at most 10 payment rows (the API's own limit): the screen says so before any call", () => {
    const line = item();
    const rows = (n: number): PaymentEntry[] =>
      Array.from({ length: n }, (_, i) => ({ id: `p${i}`, mode: 'Cash' as const, amount: '1' }));
    const ten = buildBillBody(billInput([line], { payments: rows(10) }));
    expect('body' in ten && ten.body.payments?.length).toBe(10);
    expect(buildBillBody(billInput([line], { payments: rows(11) }))).toEqual({
      error: 'A bill takes at most 10 payment rows.',
    });
  });

  it('refuses before any call: no item, a line that cannot be priced, a reason that is too short, a payment that is not a number, no date', () => {
    expect(buildBillBody(billInput([]))).toEqual({ error: 'Add at least one item to the bill.' });
    const line = item({ purity: '20K' });
    expect(buildBillBody(billInput([line]))).toEqual({
      error: `${line.sku.skuNumber}: No daily rate is set for Gold 20K for this date: enter the rate.`,
    });
    const good = item();
    const short = buildBillBody(
      billInput([good], { cashOverrideReason: 'x'.repeat(CASH_REASON_MIN - 1) })
    );
    expect('error' in short && short.error).toMatch(/10 to 500 characters/);
    expect(
      buildBillBody(billInput([good], { payments: [{ id: 'p', mode: 'Cash', amount: 'ten' }] }))
    ).toEqual({ error: 'The payment amount must be a number.' });
    expect(buildBillBody(billInput([good], { billDate: '' }))).toEqual({
      error: 'Choose the date of the bill.',
    });
  });
});

// ------------------------------------------------------------------------------------------------ the answer

/** A saved bill built the way the API does (the fake runs priceBill), for the cart of one worked-example line. */
function savedFor(
  lines: BillingItem[],
  options: {
    payments?: PaymentEntry[];
    transform?: (a: CreateBillResponse) => CreateBillResponse;
  } = {}
) {
  const server = new FakeBillApi();
  for (const line of lines)
    server.pieces.set(line.sku.id, {
      sku_no: line.sku.skuNumber,
      material: line.sku.material,
      purity: line.sku.purity,
      selling_method: line.sku.sellingMethod,
      weightMg: Math.round(line.sku.customerNetWeight * 1000),
    });
  if (options.transform) server.transform = options.transform;
  const made = buildBillBody(billInput(lines, { payments: options.payments ?? [] }));
  if (!('body' in made)) throw new Error(made.error);
  return { made, server };
}

describe('C12: the saved figures replace the preview, and a notice says where they differ', () => {
  it("a saved bill that equals the preview has no differences; its figures are the API's rows", async () => {
    const line = { ...item(), metalRate: '6920', labour: '353', piroi: '2.15' };
    const shown = preview([line]);
    const { made, server } = savedFor([line], {
      payments: [{ id: 'p', mode: 'UPI', amount: '100000' }],
    });
    const call = await server.fetch('https://api.test/v1/bills', {
      method: 'POST',
      headers: { 'X-JV-Client': 'web', 'Idempotency-Key': uuid(1) },
      body: JSON.stringify(made.body),
    });
    const answer = (await call.json()) as CreateBillResponse;
    const saved = savedBillFrom(answer, shown, [line], 'Priya');
    expect(saved.grandTotal).toBe(25761200);
    expect(saved.lines).toHaveLength(1);
    expect(saved.lines[0].total).toBe(25761181);
    expect(saved.received).toBe(10000000);
    expect(saved.pending).toBe(25761200 - 10000000);
    expect(saved.advanceApplied).toBe(0);
    expect(saved.differences).toEqual([]);
    expect(saved.billNo).toBe(answer.bill.bill_no);
  });

  it("when the server's figures are not the preview's the saved ones are shown and each difference is named", async () => {
    const line = { ...item(), metalRate: '6920', labour: '353', piroi: '2.15' };
    const shown = preview([line]);
    const { made, server } = savedFor([line], {
      transform: (a) => ({
        ...a,
        bill: { ...a.bill, grand_total: '257613.00', round_off: '1.19' },
        items: a.items.map((i) => ({ ...i, item_total: '257612.00' })),
      }),
    });
    const call = await server.fetch('https://api.test/v1/bills', {
      method: 'POST',
      headers: { 'X-JV-Client': 'web', 'Idempotency-Key': uuid(2) },
      body: JSON.stringify(made.body),
    });
    const saved = savedBillFrom((await call.json()) as CreateBillResponse, shown, [line], 'Priya');
    expect(saved.grandTotal).toBe(25761300); // the saved figure, not the preview's 257,612
    expect(saved.differences).toEqual([
      'Grand total: ₹2,57,613.00 saved, ₹2,57,612.00 in the preview',
      'Round off: ₹1.19 saved, ₹0.19 in the preview',
      `${line.sku.skuNumber}: ₹2,57,612.00 saved, ₹2,57,611.81 in the preview`,
    ]);
  });

  it('"Advance adjusted" is advance_applied, and what is pending counts every live allocation to the bill', async () => {
    const line = { ...item(), metalRate: '6920', labour: '353', piroi: '2.15' };
    const { made, server } = savedFor([line], {
      transform: (a) => ({
        ...a,
        advance_applied: '50000.00',
        // the rebalance applied money the customer held to this bill: an allocation of a receipt of an earlier day
        allocations: [
          ...a.allocations,
          allocationRow(77, receiptRow(77, a.bill.customer_id), a.bill, { amount: '50000.00' }),
        ],
      }),
    });
    const call = await server.fetch('https://api.test/v1/bills', {
      method: 'POST',
      headers: { 'X-JV-Client': 'web', 'Idempotency-Key': uuid(3) },
      body: JSON.stringify(made.body),
    });
    const saved = savedBillFrom(
      (await call.json()) as CreateBillResponse,
      preview([line]),
      [line],
      'P'
    );
    expect(saved.advanceApplied).toBe(5000000);
    expect(saved.received).toBe(0);
    expect(saved.pending).toBe(25761200 - 5000000);
  });
});

// ------------------------------------------------------------------------------------------------ the words

const apiError = (
  code: string,
  details: Record<string, unknown> = {},
  over: { unconfirmed?: boolean; write?: boolean; message?: string } = {}
) =>
  new ApiError({
    code,
    status: 409,
    message: over.message ?? `plain message of ${code}`,
    details,
    write: over.write ?? true,
    idempotencyKey: uuid(9),
  });

describe('C13: each error code of a save has a plain sentence', () => {
  const biller = { role: 'biller', walkIn: false };
  const owner = { role: 'owner', walkIn: false };

  it('JV_CASH_LIMIT: a biller is told the owner enters the payment; the owner is asked for a reason', () => {
    const details = {
      limit: '200000.00',
      cash_today: '150000.00',
      this_call: '60000.00',
      date: '2026-10-15',
    };
    const forBiller = billSaveFailure(apiError('JV_CASH_LIMIT', details), biller);
    expect(forBiller.cashLimit).toEqual({ ownerMayGiveReason: false });
    expect(forBiller.message).toBe(
      'Cash from this customer today would reach the limit of ₹2,00,000 (₹1,50,000 already today, ₹60,000 on this bill). The owner enters this payment. Nothing was changed.'
    );
    const forOwner = billSaveFailure(apiError('JV_CASH_LIMIT', details), owner);
    expect(forOwner.cashLimit).toEqual({ ownerMayGiveReason: true });
    expect(forOwner.message).toContain('Give a reason of at least 10 characters and save again');
    expect(forOwner.message.endsWith('Nothing was changed.')).toBe(true);
  });

  it('JV_CASH_LIMIT for the walk-in says to select or create the customer, with no way round it', () => {
    const walkIn = billSaveFailure(
      apiError('JV_CASH_LIMIT', { limit: '200000.00', this_call: '200000.00', date: '2026-10-15' }),
      { role: 'owner', walkIn: true }
    );
    expect(walkIn.cashLimit).toBeNull();
    expect(walkIn.message).toBe(
      'Select or create the customer: cash of ₹2,00,000 or more cannot be taken for the walk-in customer. Nothing was changed.'
    );
  });

  it('JV_OVERPAYMENT gives both figures and says nothing was changed', () => {
    const found = billSaveFailure(
      apiError('JV_OVERPAYMENT', {
        field: 'payments',
        grand_total: '1000.00',
        payments_total: '1500.00',
      }),
      biller
    );
    expect(found.message).toBe(
      'The payments add up to ₹1,500, which is more than the bill of ₹1,000. Lower a payment and save again. Nothing was changed.'
    );
  });

  it('JV_PIECE_UNAVAILABLE names every piece and says to take it off the bill', () => {
    const found = billSaveFailure(
      apiError('JV_PIECE_UNAVAILABLE', {
        sku_ids: [uuid(1), uuid(2)],
        pieces: [
          { sku_id: uuid(1), sku_no: 'RING-00001-001', status: 'Sold' },
          { sku_id: uuid(2), sku_no: 'RING-00001-002', status: 'Reserved' },
        ],
      }),
      biller
    );
    expect(found.pieceIds).toEqual([uuid(1), uuid(2)]);
    expect(found.message).toBe(
      'These pieces cannot be billed: RING-00001-001 (Sold), RING-00001-002 (Reserved). It was sold or changed by someone else. Remove them from the bill and save again. Nothing was changed.'
    );
    const one = billSaveFailure(
      apiError('JV_PIECE_UNAVAILABLE', {
        sku_ids: [uuid(1)],
        pieces: [{ sku_id: uuid(1), sku_no: 'RING-00001-001', status: 'Sold' }],
      }),
      biller
    );
    expect(one.message.startsWith('This piece cannot be billed: RING-00001-001 (Sold).')).toBe(
      true
    );
  });

  it('an outcome that is not known says so and tells the person to press Save again; a refusal is left as the client worded it', () => {
    const unknown = billSaveFailure(
      new ApiError({
        code: 'NETWORK',
        status: 0,
        message: 'Could not confirm that this was saved.',
        write: true,
        idempotencyKey: uuid(9),
      }),
      biller
    );
    expect(unknown.unconfirmed).toBe(true);
    expect(unknown.message).toBe(
      'Could not confirm that this was saved. Press Save again: if the bill was made it is shown, and a second one is never made.'
    );
    const refused = billSaveFailure(
      apiError(
        'JV_CUSTOMER_ARCHIVED',
        {},
        { message: 'This customer is archived. Nothing was changed.' }
      ),
      biller
    );
    expect(refused).toMatchObject({
      message: 'This customer is archived. Nothing was changed.',
      unconfirmed: false,
      cashLimit: null,
      pieceIds: [],
    });
    expect(billSaveFailure(new Error('boom'), biller).message).toBe('boom');
  });
});

// ------------------------------------------------------------------------------------------------ Z3

describe('Z3: a PAN is five capital letters, four digits, one capital letter', () => {
  it('accepts the shape and nothing else', () => {
    for (const good of ['ABCDE1234F', 'AAAAA0000A']) expect(isPan(good)).toBe(true);
    for (const bad of [
      '',
      'abcde1234f',
      'ABCDE12345',
      'ABCD1234FG',
      'ABCDE1234',
      'ABCDE1234FF',
      'ABCDE 1234F',
    ])
      expect(isPan(bad)).toBe(false);
  });
  it('what is typed is made capitals with no spaces before it is checked', () => {
    expect(normalisePan(' abcde 1234f ')).toBe('ABCDE1234F');
    expect(isPan(normalisePan(' abcde 1234f '))).toBe(true);
  });
});
