// The billing screen without the screen (spec C5 (b), C6, C12, R1 to R10, Z1 to Z3; task WEB08). Everything the screen works out is here, so that it can be tested without a browser:
//
//   - THE LINES. A line keeps what the person typed, as text (`BillingItem`); nothing is a floating-point number. The defaults are the ones of the spec: the labour rate of the piece for the
//     bill's sale type (R1, `defaultLabourRate`), the sale type of the customer (R9, `saleTypeForCustomer`), the daily rate of the piece's material and purity dated on or before the bill
//     date (R2, `defaultMetalRate`), and for a Per Piece piece the piece price for the sale type.
//   - THE PREVIEW. The live total is `priceBill` of src/lib/pricing.ts (C12): the same file the API runs, in paise and milligrams. The saved bill always shows the API's figures; the
//     preview is only what the screen expects.
//   - THE REQUEST. `buildBillBody` makes the body of X1 `POST /v1/bills` from what is on the screen. Money goes out as text with two decimals, so the same cart is the same body (and the
//     same Idempotency-Key, see moneyServer.createBill).
//   - THE ANSWER. `savedBillFrom` turns the rows X1 returned into the figures the screen shows after the save, and says where the preview was not the same (C12).
//   - THE WORDS. `billSaveFailure` gives the plain sentence for each error code of the save (C13), with the pieces named for JV_PIECE_UNAVAILABLE.
//
// This file makes no network call and keeps nothing between calls.
import type { BillWarning, CreateBillResponse } from './api/types';
import type { Sku } from './mockData';
import {
  PricingError,
  assertBusinessDate,
  defaultLabourRate,
  defaultMetalRate,
  formatGrams,
  formatRupees,
  parseRupees,
  priceBill,
  priceLine,
  saleTypeForCustomer,
  parseGrams,
  type DailyRateLike,
  type PriceLineInput,
  type PricedBill,
  type PricedLine,
  type SaleType,
} from './pricing';

export type { SaleType };

/** K5: the walk-in customer, written by the seed. A bill with no customer chosen is a bill of this row. */
export const WALK_IN_ID = '00000000-0000-4000-8000-000000000001';

/** D13: the five modes of a money receipt. There is no Credit: a bill that is not paid in full simply has no receipt for the rest (Y2). */
export const PAYMENT_MODES = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'] as const;
export type PaymentMode = (typeof PAYMENT_MODES)[number];

/** The most payment rows one bill takes (the API's own limit; the spec gives no number). */
export const MAX_PAYMENT_ROWS = 10;

/** R10: these two are billed only after the person has been asked (`confirm_held`). */
export const HELD_STATUSES = ['Reserved', 'On Approval'] as const;
export type HeldStatus = (typeof HELD_STATUSES)[number];

/** Z3 and D10: five capital letters, four digits, one capital letter. */
export const PAN_PATTERN = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
/** Z1: the owner's reason for cash over the limit. */
export const CASH_REASON_MIN = 10;
export const CASH_REASON_MAX = 500;

// ------------------------------------------------------------------------------------------------ text of money

/** A number made from the API's text (at most 15 significant digits) as the exact text it came from: 353 gives "353.00", 2.15 gives "2.15". */
export function rupeesText(value: number): string {
  return formatRupees(parseRupees(value));
}

/** Paise as rupees for the screen: ₹2,45,106.40 (with paise) or ₹2,57,612 (a whole rupee amount, no paise). No floating point: the whole rupees are an integer. */
export function inr(paise: number, withPaise = true): string {
  const negative = paise < 0;
  const absolute = Math.abs(paise);
  const rupees = Math.trunc(absolute / 100);
  const cents = String(absolute % 100).padStart(2, '0');
  const whole = rupees.toLocaleString('en-IN');
  return `${negative ? '-' : ''}₹${whole}${withPaise ? `.${cents}` : ''}`;
}

/** The round-off line: +0.34 or -0.40. */
export function signedRupees(paise: number): string {
  return `${paise > 0 ? '+' : ''}${formatRupees(paise)}`;
}

// ------------------------------------------------------------------------------------------------ the lines

export interface RateNote {
  /** 'ok': the daily rate of the bill date. 'stale': an older rate (the API warns RATE_STALE). 'missing': no rate (RATE_MISSING), the person is asked for one. 'piece': a Per Piece price. */
  status: 'ok' | 'stale' | 'missing' | 'piece';
  /** The date of the rate used, for 'ok' and 'stale'. */
  date: string | null;
}

/** One line of the bill as the person has it on the screen: the piece, and the text of each figure that can be changed. */
export interface BillingItem {
  id: string;
  sku: Sku;
  /** Rupees per gram of net weight for a By Weight piece, the piece price for a Per Piece piece. */
  metalRate: string;
  /** Rupees per gram of net weight (By Weight). A Per Piece line has no labour of its own (R3) and sends none. */
  labour: string;
  piroi: string;
  otherCharges: string;
  /** A whole number from 1 to 1,000; 1 for a By Weight piece (R6). */
  quantity: string;
  /** Where the metal rate came from when it was filled in (R2). */
  rate: RateNote;
  /** The text the default put in `metalRate`: a line whose `metalRate` still equals it follows the bill date when the date changes. */
  rateDefault: string;
  /** The status the piece had when the person confirmed it (R10); null for an In Stock piece. */
  heldStatus: HeldStatus | null;
}

export interface LineContext {
  saleType: SaleType;
  billDate: string;
  rates: readonly DailyRateLike[];
}

const labourDefault = (sku: Sku, saleType: SaleType): string => {
  const rate = defaultLabourRate(sku, saleType);
  return rate === null ? '' : rupeesText(rate);
};

/** R2: the default metal rate and what it was made from. For a Per Piece piece the price for the sale type (R1). */
function metalDefault(sku: Sku, context: LineContext): { text: string; note: RateNote } {
  if (sku.sellingMethod === 'Per Piece') {
    return { text: labourDefault(sku, context.saleType), note: { status: 'piece', date: null } };
  }
  const found = defaultMetalRate(context.rates, sku.material, sku.purity, context.billDate);
  if (found.ratePaise === null) return { text: '', note: { status: 'missing', date: null } };
  return {
    text: formatRupees(found.ratePaise),
    note: { status: found.status, date: found.rateDate },
  };
}

export function newBillingItem(
  sku: Sku,
  context: LineContext,
  heldStatus: HeldStatus | null = null
): BillingItem {
  const metal = metalDefault(sku, context);
  return {
    id: `bitem-${sku.id}`,
    sku,
    metalRate: metal.text,
    labour: labourDefault(sku, context.saleType),
    piroi: rupeesText(sku.piroi),
    otherCharges: '0',
    quantity: '1',
    rate: metal.note,
    rateDefault: metal.text,
    heldStatus,
  };
}

/** R1, R9: the bill's sale type changed: every line takes the labour rate of its piece for the new type, and a Per Piece line the piece price for it. */
export function withSaleType(items: readonly BillingItem[], context: LineContext): BillingItem[] {
  return items.map((item) => {
    const labour = labourDefault(item.sku, context.saleType);
    if (item.sku.sellingMethod !== 'Per Piece') return { ...item, labour };
    return { ...item, labour, metalRate: labour, rateDefault: labour };
  });
}

/** R2: the bill date changed. A By Weight line whose rate is still the one the default filled in follows the date; a rate the person typed is left alone. */
export function withBillDate(items: readonly BillingItem[], context: LineContext): BillingItem[] {
  return items.map((item) => {
    if (item.sku.sellingMethod === 'Per Piece' || item.metalRate !== item.rateDefault) return item;
    const metal = metalDefault(item.sku, context);
    return { ...item, metalRate: metal.text, rateDefault: metal.text, rate: metal.note };
  });
}

/** R9: choosing a customer sets the bill's sale type to the customer's; with no customer the type stays. The biller may change it afterwards. */
export function saleTypeAfterChoosing(
  customer: { customerType?: SaleType | null } | null,
  current: SaleType
): SaleType {
  return saleTypeForCustomer(customer, current);
}

// ------------------------------------------------------------------------------------------------ the preview

const LABEL: Record<string, string> = {
  metalRatePaise: 'metal rate',
  labourRatePaise: 'labour rate',
  piroiPaise: 'piroi',
  otherChargesPaise: 'other charges',
  quantity: 'quantity',
  customerNetWeightMg: 'weight',
  discountPaise: 'discount',
  additionalChargesPaise: 'additional charges',
  metalAmountPaise: 'metal amount',
  labourAmountPaise: 'labour amount',
  itemTotalPaise: 'line total',
  subtotalPaise: 'subtotal',
  grandTotalPaise: 'bill total',
};

/** What pricing.ts refused, in plain words. The field name of the refusal (`lines[2].metalRatePaise`) is turned into a label and never shown. */
function plainPricingError(error: PricingError): string {
  const name = /([A-Za-z]+)$/.exec(error.field)?.[1] ?? '';
  const label = LABEL[name] ?? 'figure';
  if (error.message.includes('more than the subtotal'))
    return 'The discount is more than the subtotal plus the additional charges.';
  if (error.message.includes('above the cap'))
    return `The ${label} is more than the system allows.`;
  if (error.message.includes('must be 1 for a By Weight')) return 'A By Weight piece is sold once.';
  return `The ${label} is not accepted.`;
}

/** Text typed by the person to paise, or the sentence that says what is wrong with it. A blank is `blank` (an error unless the figure is optional). */
function money(text: string, what: string, blank: 'error' | 'zero'): number | string {
  const typed = text.trim();
  if (typed === '') return blank === 'zero' ? 0 : `Enter the ${what}.`;
  try {
    return parseRupees(typed, { field: what });
  } catch (error) {
    if (!(error instanceof PricingError)) throw error;
    if (error.message.includes('more than 2 decimals'))
      return `The ${what} can have at most 2 decimals.`;
    if (error.message.includes('negative')) return `The ${what} cannot be negative.`;
    if (error.message.includes('too large')) return `The ${what} is too large.`;
    return `The ${what} must be a number.`;
  }
}

/** One line of the bill as pricing.ts takes it, or the sentence that says what is missing. */
function lineInput(item: BillingItem): { input: PriceLineInput } | { error: string } {
  const sku = item.sku;
  const byWeight = sku.sellingMethod === 'By Weight';
  const rate = money(item.metalRate, byWeight ? 'metal rate per gram' : 'piece price', 'error');
  if (typeof rate === 'string') {
    return {
      error:
        item.rate.status === 'missing' && item.metalRate.trim() === ''
          ? `No daily rate is set for ${sku.material} ${sku.purity} for this date: enter the rate.`
          : rate,
    };
  }
  const labour = byWeight ? money(item.labour, 'labour rate per gram', 'error') : 0;
  if (typeof labour === 'string') return { error: labour };
  const piroi = money(item.piroi, 'piroi', 'zero');
  if (typeof piroi === 'string') return { error: piroi };
  const other = money(item.otherCharges, 'other charges', 'zero');
  if (typeof other === 'string') return { error: other };
  const typedQuantity = item.quantity.trim();
  if (!/^\d+$/.test(typedQuantity)) return { error: 'The quantity must be a whole number.' };
  const quantity = Number(typedQuantity);
  if (quantity < 1 || quantity > 1000) return { error: 'The quantity must be from 1 to 1,000.' };
  if (byWeight && quantity !== 1) return { error: 'A By Weight piece is sold once.' };
  let weightMg: number;
  try {
    weightMg = parseGrams(sku.customerNetWeight, { field: 'weight' });
  } catch {
    return { error: 'The weight of this piece is not a number.' };
  }
  return {
    input: {
      material: sku.material,
      sellingMethod: sku.sellingMethod,
      customerNetWeightMg: weightMg,
      quantity,
      metalRatePaise: rate,
      labourRatePaise: byWeight ? labour : null,
      piroiPaise: piroi,
      otherChargesPaise: other,
    },
  };
}

export interface LinePreview {
  /** The sentence that says why this line cannot be priced, or null. */
  error: string | null;
  priced: PricedLine | null;
}

export interface BillPreview {
  lines: LinePreview[];
  /** The priced bill, or null when there is no line yet or something cannot be priced. */
  bill: PricedBill | null;
  /** Why there is no bill total (the first problem, with the piece's number), or null. This is also why Save is off. */
  error: string | null;
}

export interface PreviewInput {
  items: readonly BillingItem[];
  saleType: SaleType;
  discount: string;
  additionalCharges: string;
  /** `settings.estimate.roundOff`. */
  roundOffSetting: boolean;
}

/** C12: the live total, by the same `priceBill` the API runs. */
export function previewBill(input: PreviewInput): BillPreview {
  const lines: LinePreview[] = [];
  const inputs: PriceLineInput[] = [];
  let error: string | null = null;
  for (const item of input.items) {
    const made = lineInput(item);
    if ('error' in made) {
      lines.push({ error: made.error, priced: null });
      error ??= `${item.sku.skuNumber}: ${made.error}`;
      continue;
    }
    try {
      lines.push({ error: null, priced: priceLine(made.input, input.saleType) });
      inputs.push(made.input);
    } catch (thrown) {
      if (!(thrown instanceof PricingError)) throw thrown;
      const sentence = plainPricingError(thrown);
      lines.push({ error: sentence, priced: null });
      error ??= `${item.sku.skuNumber}: ${sentence}`;
    }
  }
  if (error !== null || input.items.length === 0) return { lines, bill: null, error };

  const discount = money(input.discount, 'discount', 'zero');
  if (typeof discount === 'string') return { lines, bill: null, error: discount };
  const additional = money(input.additionalCharges, 'additional charges', 'zero');
  if (typeof additional === 'string') return { lines, bill: null, error: additional };
  try {
    const bill = priceBill({
      saleType: input.saleType,
      lines: inputs,
      discountPaise: discount,
      additionalChargesPaise: additional,
      roundOffSetting: input.roundOffSetting,
    });
    return { lines, bill, error: null };
  } catch (thrown) {
    if (!(thrown instanceof PricingError)) throw thrown;
    return { lines, bill: null, error: plainPricingError(thrown) };
  }
}

// ------------------------------------------------------------------------------------------------ the payments and the request

export interface PaymentEntry {
  id: string;
  mode: PaymentMode;
  /** What is typed; blank or 0 is no payment. */
  amount: string;
}

/** The paise of the payment rows that count (an amount above 0), or the sentence that says what is wrong with one. */
export function paymentsTotal(payments: readonly PaymentEntry[]): number | string {
  let total = 0;
  for (const payment of payments) {
    const paise = money(payment.amount, 'payment amount', 'zero');
    if (typeof paise === 'string') return paise;
    total += paise;
  }
  return total;
}

export interface BillBody {
  customer_id: string;
  sale_type: SaleType;
  bill_date: string;
  items: Array<{
    sku_id: string;
    metal_rate: string;
    labour_rate?: string;
    piroi: string;
    other_charges: string;
    quantity: number;
  }>;
  discount: string;
  additional_charges: string;
  notes?: string;
  payments?: Array<{ mode: PaymentMode; amount: string }>;
  confirm_held?: string[];
  cash_override_reason?: string;
}

export interface BillRequestInput {
  /** The customer chosen; null is the walk-in. */
  customerId: string | null;
  saleType: SaleType;
  billDate: string;
  items: readonly BillingItem[];
  discount: string;
  additionalCharges: string;
  notes: string;
  payments: readonly PaymentEntry[];
  /** Z1: the owner's reason for cash over the limit; blank is none. Only the owner's screen sends it (a biller who sends it is refused). */
  cashOverrideReason: string;
}

/** The body of X1 from what is on the screen, or the sentence that says what to fix first. Nothing is sent from here. */
export function buildBillBody(input: BillRequestInput): { body: BillBody } | { error: string } {
  if (input.items.length === 0) return { error: 'Add at least one item to the bill.' };
  if (input.items.length > 200) return { error: 'A bill has at most 200 items.' };
  try {
    assertBusinessDate(input.billDate, 'billDate');
  } catch {
    return { error: 'Choose the date of the bill.' };
  }
  const items: BillBody['items'] = [];
  for (const item of input.items) {
    const made = lineInput(item);
    if ('error' in made) return { error: `${item.sku.skuNumber}: ${made.error}` };
    const line = made.input;
    const byWeight = item.sku.sellingMethod === 'By Weight';
    items.push({
      sku_id: item.sku.id,
      metal_rate: formatRupees(line.metalRatePaise),
      ...(byWeight && line.labourRatePaise != null
        ? { labour_rate: formatRupees(line.labourRatePaise) }
        : {}),
      piroi: formatRupees(line.piroiPaise ?? 0),
      other_charges: formatRupees(line.otherChargesPaise ?? 0),
      quantity: line.quantity ?? 1,
    });
  }
  const discount = money(input.discount, 'discount', 'zero');
  if (typeof discount === 'string') return { error: discount };
  const additional = money(input.additionalCharges, 'additional charges', 'zero');
  if (typeof additional === 'string') return { error: additional };

  if (input.payments.length > MAX_PAYMENT_ROWS)
    return { error: `A bill takes at most ${MAX_PAYMENT_ROWS} payment rows.` };
  const payments: NonNullable<BillBody['payments']> = [];
  for (const payment of input.payments) {
    const paise = money(payment.amount, 'payment amount', 'zero');
    if (typeof paise === 'string') return { error: paise };
    if (paise > 0) payments.push({ mode: payment.mode, amount: formatRupees(paise) });
  }
  const reason = input.cashOverrideReason.trim();
  if (reason !== '' && (reason.length < CASH_REASON_MIN || reason.length > CASH_REASON_MAX))
    return {
      error: `The reason for cash over the limit must be ${CASH_REASON_MIN} to ${CASH_REASON_MAX} characters.`,
    };
  const held = input.items.filter((item) => item.heldStatus !== null).map((item) => item.sku.id);
  const notes = input.notes.trim();

  const body: BillBody = {
    customer_id: input.customerId ?? WALK_IN_ID,
    sale_type: input.saleType,
    bill_date: input.billDate,
    items,
    discount: formatRupees(discount),
    additional_charges: formatRupees(additional),
    ...(notes === '' ? {} : { notes }),
    ...(payments.length === 0 ? {} : { payments }),
    ...(held.length === 0 ? {} : { confirm_held: held }),
    ...(reason === '' ? {} : { cash_override_reason: reason }),
  };
  return { body };
}

// ------------------------------------------------------------------------------------------------ the answer

export interface SavedLine {
  skuId: string;
  skuNo: string;
  metalAmount: number;
  labourAmount: number;
  fineWeightDueMg: number;
  total: number;
}

/** What the screen shows once the API has answered: the API's figures, not the preview's (C12). All amounts in paise. */
export interface SavedBill {
  billId: string;
  billNo: string;
  customerId: string;
  customerName: string;
  billDate: string;
  saleType: SaleType;
  subtotal: number;
  discount: number;
  additionalCharges: number;
  roundOff: number;
  grandTotal: number;
  fineWeightDueMg: number;
  lines: SavedLine[];
  /** The money the customer paid with this bill (its payment rows). */
  received: number;
  /** "Advance adjusted" (O23): money the customer already held that the rebalance applied to this bill. */
  advanceApplied: number;
  /** What is still to pay on this bill: its grand total less every live allocation to it. */
  pending: number;
  warnings: BillWarning[];
  /** The places where the preview was not the saved figure, in words. Empty when the screen was right. */
  differences: string[];
}

const exact = (text: string): number => parseRupees(text, { signed: true });

/** The saved bill from the rows X1 returned. `preview` is what the screen showed before the save; any figure that is not the same is reported in `differences`. */
export function savedBillFrom(
  response: CreateBillResponse,
  preview: BillPreview | null,
  items: readonly BillingItem[],
  customerName: string
): SavedBill {
  const { bill } = response;
  const lines: SavedLine[] = response.items
    .slice()
    .sort((a, b) => a.line_no - b.line_no)
    .map((row) => ({
      skuId: row.sku_id,
      skuNo: row.sku_no,
      metalAmount: exact(row.metal_amount),
      labourAmount: exact(row.labour_amount),
      fineWeightDueMg: parseGrams(row.fine_weight_due),
      total: exact(row.item_total),
    }));
  const grandTotal = exact(bill.grand_total);
  const received = response.receipts.reduce(
    (sum, receipt) => (receipt.kind === 'money' ? sum + exact(receipt.amount) : sum),
    0
  );
  const allocated = response.allocations
    .filter((allocation) => allocation.bill_id === bill.id && allocation.released_at === null)
    .reduce((sum, allocation) => sum + exact(allocation.amount), 0);
  const saved: SavedBill = {
    billId: bill.id,
    billNo: bill.bill_no,
    customerId: bill.customer_id,
    customerName,
    billDate: bill.bill_date,
    saleType: bill.sale_type,
    subtotal: exact(bill.subtotal),
    discount: exact(bill.discount),
    additionalCharges: exact(bill.additional_charges),
    roundOff: exact(bill.round_off),
    grandTotal,
    fineWeightDueMg: parseGrams(bill.fine_weight_due),
    lines,
    received,
    advanceApplied: exact(response.advance_applied),
    pending: Math.max(0, grandTotal - allocated),
    warnings: response.warnings,
    differences: [],
  };
  saved.differences = differencesFromPreview(saved, preview, items);
  return saved;
}

function differencesFromPreview(
  saved: SavedBill,
  preview: BillPreview | null,
  items: readonly BillingItem[]
): string[] {
  if (preview?.bill == null) return [];
  const bill = preview.bill;
  const found: string[] = [];
  const compare = (label: string, savedPaise: number, previewPaise: number, rupees = true) => {
    if (savedPaise !== previewPaise)
      found.push(
        rupees
          ? `${label}: ${inr(savedPaise)} saved, ${inr(previewPaise)} in the preview`
          : `${label}: ${formatGrams(savedPaise)} g saved, ${formatGrams(previewPaise)} g in the preview`
      );
  };
  compare('Grand total', saved.grandTotal, bill.grandTotalPaise);
  compare('Subtotal', saved.subtotal, bill.subtotalPaise);
  compare('Round off', saved.roundOff, bill.roundOffPaise);
  compare('Silver fine due', saved.fineWeightDueMg, bill.fineWeightDueMg, false);
  for (const line of saved.lines) {
    const at = items.findIndex((item) => item.sku.id === line.skuId);
    const priced = at >= 0 ? preview.lines[at]?.priced : null;
    if (!priced) {
      found.push(`${line.skuNo}: not in the preview`);
      continue;
    }
    compare(line.skuNo, line.total, priced.itemTotalPaise);
  }
  return found;
}

// ------------------------------------------------------------------------------------------------ the words of a failed save (C13)

export interface SaveFailure {
  /** The plain sentence for the person. */
  message: string;
  /** JV_CASH_LIMIT: the screen offers the owner the field for a reason. */
  cashLimit: { ownerMayGiveReason: boolean } | null;
  /** JV_PIECE_UNAVAILABLE: the pieces (ids) that cannot be billed, to mark their lines. */
  pieceIds: string[];
  /** The outcome is not known: the same bill can be saved again with the same key (L5). */
  unconfirmed: boolean;
}

interface ErrorLike {
  code: string;
  message: string;
  details?: Record<string, unknown>;
  unconfirmed?: boolean;
}

const isErrorLike = (value: unknown): value is ErrorLike =>
  value instanceof Error && typeof (value as { code?: unknown }).code === 'string';

const textDetail = (details: Record<string, unknown> | undefined, key: string): string | null => {
  const value = details?.[key];
  return typeof value === 'string' ? value : null;
};

const rupeesDetail = (details: Record<string, unknown> | undefined, key: string): string | null => {
  const value = textDetail(details, key);
  if (value === null) return null;
  try {
    return inr(parseRupees(value), false);
  } catch {
    return null;
  }
};

export interface FailureContext {
  /** The signed-in role. Only the owner may give a reason for cash over the limit (Z1). */
  role: string | null;
  /** No customer was chosen: the bill is the walk-in's (K5). */
  walkIn: boolean;
}

const UNCONFIRMED_HELP =
  'Press Save again: if the bill was made it is shown, and a second one is never made.';

/** The sentence for the person for whatever the save threw. A refusal before any write ends "Nothing was changed." (the client's message already does). */
export function billSaveFailure(error: unknown, context: FailureContext): SaveFailure {
  const none = { cashLimit: null, pieceIds: [] as string[], unconfirmed: false };
  if (!isErrorLike(error)) {
    return {
      ...none,
      message: error instanceof Error ? error.message : 'The bill could not be saved.',
    };
  }
  const details = error.details;
  switch (error.code) {
    case 'JV_CASH_LIMIT': {
      const limit = rupeesDetail(details, 'limit') ?? '₹2,00,000';
      if (context.walkIn || textDetail(details, 'cash_today') === null) {
        return {
          ...none,
          message: `Select or create the customer: cash of ${limit} or more cannot be taken for the walk-in customer. Nothing was changed.`,
        };
      }
      const today = rupeesDetail(details, 'cash_today');
      const thisBill = rupeesDetail(details, 'this_call');
      const owner = context.role === 'owner';
      return {
        ...none,
        cashLimit: { ownerMayGiveReason: owner },
        message:
          `Cash from this customer today would reach the limit of ${limit}` +
          (today && thisBill ? ` (${today} already today, ${thisBill} on this bill)` : '') +
          '. ' +
          (owner
            ? `Give a reason of at least ${CASH_REASON_MIN} characters and save again, or take part of it by UPI, card or bank transfer.`
            : 'The owner enters this payment.') +
          ' Nothing was changed.',
      };
    }
    case 'JV_OVERPAYMENT': {
      const paid = rupeesDetail(details, 'payments_total');
      const total = rupeesDetail(details, 'grand_total');
      return {
        ...none,
        message:
          (paid && total
            ? `The payments add up to ${paid}, which is more than the bill of ${total}. `
            : 'The payments are more than the bill. ') +
          'Lower a payment and save again. Nothing was changed.',
      };
    }
    case 'JV_PIECE_UNAVAILABLE': {
      const pieces = Array.isArray(details?.pieces)
        ? (details.pieces as Array<Record<string, unknown>>)
        : [];
      const named = pieces
        .map((piece) => {
          const number = typeof piece.sku_no === 'string' ? piece.sku_no : null;
          const status = typeof piece.status === 'string' ? piece.status : null;
          return number === null ? null : status ? `${number} (${status})` : number;
        })
        .filter((text): text is string => text !== null);
      const ids = Array.isArray(details?.sku_ids)
        ? (details.sku_ids as unknown[]).filter((id): id is string => typeof id === 'string')
        : [];
      return {
        ...none,
        pieceIds: ids,
        message:
          named.length > 0
            ? `${named.length === 1 ? 'This piece' : 'These pieces'} cannot be billed: ${named.join(', ')}. It was sold or changed by someone else. Remove ${named.length === 1 ? 'it' : 'them'} from the bill and save again. Nothing was changed.`
            : `${error.message}`,
      };
    }
    default: {
      const unconfirmed = error.unconfirmed === true;
      return {
        ...none,
        unconfirmed,
        message: unconfirmed ? `${error.message} ${UNCONFIRMED_HELP}` : error.message,
      };
    }
  }
}

// ------------------------------------------------------------------------------------------------ the PAN prompt (Z3)

/** What the person typed as a PAN: capital letters, no spaces. */
export function normalisePan(text: string): string {
  return text.replace(/\s+/g, '').toUpperCase();
}

export function isPan(text: string): boolean {
  return PAN_PATTERN.test(text);
}
