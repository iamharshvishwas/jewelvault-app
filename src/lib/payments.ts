// The payment and silver-fine panel without the panel (spec X2, X3, Y3, Y5, SF1, SF2, Z1, Z2, K5, C5 (b), C13; task WEB09). Everything the panel works out is here, so that it can be tested
// without a browser:
//
//   - THE REQUEST. `buildPaymentBody` makes the body of X2 `POST /v1/customers/{id}/payments` and `buildFineBody` the body of X3 `POST /v1/customers/{id}/fine-settlements` from what
//     the person typed. Money goes out as text with two decimals and grams with three, so the same payment typed two ways is the same body (and so the same Idempotency-Key, see
//     moneyServer.recordPayment); a blank optional field is left out; the sentence for what is wrong is given before any call is made.
//   - THE FIGURE. `cashEquivalentPaise` is the amount of a fine settled in cash, round(grams x rate, 2) half up, in whole paise (BigInt), the API's own rule (X3).
//   - THE ANSWER. `savedPaymentFrom` and `savedFineFrom` turn the rows X2 and X3 returned into the parts the panel shows: each bill and what it received, what is kept as advance, what
//     fine is left. Nothing is added up here that the API did not send: a part is an allocation row, the advance and the fine remaining are the API's figures (Y5, SF2).
//   - THE WORDS. `paymentSaveFailure` gives the plain sentence for each error code of the two saves (C13), with the figures named where the API sends them.
//
// This file makes no network call and keeps nothing between calls.
import type { ReceiptAllocationRow, RecordPaymentResponse, SettleFineResponse } from './api/types';
import { CASH_REASON_MAX, CASH_REASON_MIN, PAYMENT_MODES, inr, type PaymentMode } from './billing';
import type { Invoice } from './mockData';
import {
  LIMITS,
  PricingError,
  formatGrams,
  formatRupees,
  parseGrams,
  parseRupees,
} from './pricing';

/** The most characters of a reference; the API takes 120. */
export const REFERENCE_MAX = 120;
/** The most characters of a note; the API takes 10,000. */
export const NOTES_MAX = 10_000;

// ------------------------------------------------------------------------------------------------ the request

export interface RecordPaymentBody {
  amount: string;
  mode: PaymentMode;
  bill_id?: string;
  reference?: string;
  notes?: string;
  cash_override_reason?: string;
}

export interface SettleFineBody {
  grams: string;
  mode: 'Silver' | 'Cash';
  silver_rate?: string;
  bill_id?: string;
  reference?: string;
  notes?: string;
  cash_override_reason?: string;
}

export interface PaymentInput {
  /** What is typed: rupees. */
  amount: string;
  mode: string;
  /** The bill named, or blank for oldest first. */
  billId: string;
  reference: string;
  notes: string;
  /** Z1: the owner's reason for cash over the limit; blank is none. Only the owner's screen passes one. */
  cashOverrideReason: string;
}

export interface FineInput {
  /** What is typed: grams. */
  grams: string;
  mode: 'Silver' | 'Cash';
  /** What is typed: rupees a gram. Used for Cash only. */
  silverRate: string;
  billId: string;
  reference: string;
  notes: string;
  cashOverrideReason: string;
}

/** Typed text to whole units (paise or milligrams), or the sentence that says what is wrong with it. A blank is "Enter the ...". */
export function typedUnits(text: string, scale: 2 | 3, what: string): number | string {
  const typed = text.trim();
  if (typed === '') return `Enter the ${what}.`;
  try {
    return scale === 2 ? parseRupees(typed, { field: what }) : parseGrams(typed, { field: what });
  } catch (error) {
    if (!(error instanceof PricingError)) throw error;
    if (error.message.includes('decimals'))
      return `The ${what} can have at most ${scale} decimals.`;
    if (error.message.includes('negative')) return `The ${what} cannot be negative.`;
    if (error.message.includes('too large')) return `The ${what} is too large.`;
    return `The ${what} must be a number.`;
  }
}

/** The text fields every body has: the named bill, the reference and the notes, left out when blank. */
function commonFields(input: {
  billId: string;
  reference: string;
  notes: string;
}): { error: string } | { fields: { bill_id?: string; reference?: string; notes?: string } } {
  const reference = input.reference.trim();
  if (reference.length > REFERENCE_MAX)
    return { error: `The reference can have at most ${REFERENCE_MAX} characters.` };
  const notes = input.notes.trim();
  if (notes.length > NOTES_MAX)
    return { error: `The notes can have at most ${NOTES_MAX.toLocaleString('en-IN')} characters.` };
  const billId = input.billId.trim();
  return {
    fields: {
      ...(billId === '' ? {} : { bill_id: billId }),
      ...(reference === '' ? {} : { reference }),
      ...(notes === '' ? {} : { notes }),
    },
  };
}

/** Z1: the owner's reason, or the sentence that says it is not acceptable; blank is none. */
function reasonField(text: string): { error: string } | { reason?: string } {
  const reason = text.trim();
  if (reason === '') return {};
  if (reason.length < CASH_REASON_MIN || reason.length > CASH_REASON_MAX)
    return {
      error: `The reason for cash over the limit must be ${CASH_REASON_MIN} to ${CASH_REASON_MAX} characters.`,
    };
  return { reason };
}

/** The body of X2 from what is on the screen, or the sentence that says what to fix first. Nothing is sent from here. */
export function buildPaymentBody(
  input: PaymentInput
): { body: RecordPaymentBody } | { error: string } {
  const paise = typedUnits(input.amount, 2, 'amount');
  if (typeof paise === 'string') return { error: paise };
  if (paise <= 0) return { error: 'The amount must be more than 0.' };
  if (paise > LIMITS.maxAmountPaise) return { error: 'The amount is more than the system allows.' };
  const mode = PAYMENT_MODES.find((m) => m === input.mode);
  if (!mode)
    return {
      error: `Choose how the money was paid: ${PAYMENT_MODES.slice(0, -1).join(', ')} or ${PAYMENT_MODES[PAYMENT_MODES.length - 1]}.`,
    };
  const common = commonFields(input);
  if ('error' in common) return common;
  // the reason explains cash over the limit and nothing else, so it goes out with a Cash payment only
  const reason = mode === 'Cash' ? reasonField(input.cashOverrideReason) : {};
  if ('error' in reason) return reason;
  return {
    body: {
      amount: formatRupees(paise),
      mode,
      ...common.fields,
      ...(reason.reason ? { cash_override_reason: reason.reason } : {}),
    },
  };
}

/** The body of X3 from what is on the screen, or the sentence that says what to fix first. A Silver settlement has no rate (the API refuses one). */
export function buildFineBody(input: FineInput): { body: SettleFineBody } | { error: string } {
  const mg = typedUnits(input.grams, 3, 'grams');
  if (typeof mg === 'string') return { error: mg };
  if (mg <= 0) return { error: 'The grams must be more than 0.' };
  if (mg > LIMITS.maxWeightMg) return { error: 'The grams are more than the system allows.' };
  let rate: string | null = null;
  if (input.mode === 'Cash') {
    const paise = typedUnits(input.silverRate, 2, 'silver rate');
    if (typeof paise === 'string') return { error: paise };
    if (paise <= 0) return { error: 'The silver rate must be more than 0.' };
    if (paise > LIMITS.maxRatePaise)
      return { error: 'The silver rate is more than the system allows.' };
    rate = formatRupees(paise);
  }
  const common = commonFields(input);
  if ('error' in common) return common;
  const reason = input.mode === 'Cash' ? reasonField(input.cashOverrideReason) : {};
  if ('error' in reason) return reason;
  return {
    body: {
      grams: formatGrams(mg),
      mode: input.mode,
      ...(rate === null ? {} : { silver_rate: rate }),
      ...common.fields,
      ...(reason.reason ? { cash_override_reason: reason.reason } : {}),
    },
  };
}

/**
 * SF1, X3: the amount of a fine settled in cash, round(grams x rate, 2) with .5 rounded up, in whole paise. Whole milligrams times whole paise has three decimals more than a paisa,
 * which are dropped half up; the product can pass 2^53, so it is BigInt. Null when the grams or the rate are not a number the API takes, or the result is not a safe integer.
 */
export function cashEquivalentPaise(gramsText: string, rateText: string): number | null {
  let mg: number;
  let paise: number;
  try {
    mg = parseGrams(gramsText.trim());
    paise = parseRupees(rateText.trim());
  } catch {
    return null;
  }
  const amount = (BigInt(mg) * BigInt(paise) + BigInt(500)) / BigInt(1000);
  return amount > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(amount);
}

// ------------------------------------------------------------------------------------------------ the bills a payment can name

export type SettlementKind = 'money' | 'fine';

/** Y3: the bills a payment (money) or a settlement (fine) may name: not cancelled, and with something of that kind still pending. The order given is kept (oldest first). */
export function payableBills(bills: readonly Invoice[], kind: SettlementKind): Invoice[] {
  return bills.filter(
    (bill) =>
      bill.status !== 'Cancelled' &&
      (kind === 'money' ? bill.pendingAmount > 0 : (bill.fineWeightPending ?? 0) > 0)
  );
}

/** The line of the drop-down for one bill: its number and what is pending on it. */
export function billOptionLabel(bill: Invoice, kind: SettlementKind): string {
  return kind === 'money'
    ? `${bill.invoiceNumber} · ${inr(parseRupees(bill.pendingAmount))} pending`
    : `${bill.invoiceNumber} · ${formatGrams(parseGrams(bill.fineWeightPending ?? 0))} g fine pending`;
}

// ------------------------------------------------------------------------------------------------ the answer

/** What one bill received from the call: paise (money) or milligrams (fine). */
export interface BillPart {
  billId: string;
  paise: number;
}
export interface FinePart {
  billId: string;
  mg: number;
}

function parts<T extends { billId: string }>(
  rows: readonly ReceiptAllocationRow[],
  value: (row: ReceiptAllocationRow) => number,
  make: (billId: string, total: number) => T
): T[] {
  const totals = new Map<string, number>();
  for (const row of rows) {
    if (row.released_at !== null) continue;
    const amount = value(row);
    if (amount > 0) totals.set(row.bill_id, (totals.get(row.bill_id) ?? 0) + amount);
  }
  return [...totals].map(([billId, total]) => make(billId, total));
}

export interface SavedPayment {
  receiptId: string;
  /** Paise. */
  amount: number;
  mode: string;
  /** The bills this payment went to, in the order the API allocated them (Y3: the named bill first, then oldest first). */
  parts: BillPart[];
  /** An older advance of the customer's that the API applied to a bill meanwhile (Y6): "Advance adjusted". */
  adjusted: BillPart[];
  /** Paise: what is left of THIS payment, kept as an advance (Y5). The API's figure. */
  advanceRemaining: number;
}

const exact = (text: string): number => parseRupees(text, { signed: true });
const money = (row: ReceiptAllocationRow): number => exact(row.amount);
const silver = (row: ReceiptAllocationRow): number => parseGrams(row.fine_grams);

/** The parts of a payment from the rows X2 returned. */
export function savedPaymentFrom(response: RecordPaymentResponse): SavedPayment {
  const { receipt } = response;
  const own = response.allocations.filter((row) => row.receipt_id === receipt.id);
  const rest = response.allocations.filter((row) => row.receipt_id !== receipt.id);
  const make = (billId: string, paise: number): BillPart => ({ billId, paise });
  return {
    receiptId: receipt.id,
    amount: exact(receipt.amount),
    mode: receipt.mode ?? '',
    parts: parts(own, money, make),
    adjusted: parts(rest, money, make),
    advanceRemaining: exact(response.advance_remaining),
  };
}

export interface SavedFine {
  receiptId: string;
  kind: 'fine_silver' | 'fine_cash';
  /** Milligrams settled. */
  grams: number;
  /** Paise: the cash equivalent of a settlement in cash, 0 for silver. */
  amount: number;
  /** Paise a gram, for a settlement in cash. */
  silverRate: number | null;
  parts: FinePart[];
  adjusted: FinePart[];
  /** Milligrams: the customer's fine outstanding after the call (SF2). The API's figure. */
  fineRemaining: number;
}

/** The parts of a silver settlement from the rows X3 returned. */
export function savedFineFrom(response: SettleFineResponse): SavedFine {
  const { receipt } = response;
  const own = response.allocations.filter((row) => row.receipt_id === receipt.id);
  const rest = response.allocations.filter((row) => row.receipt_id !== receipt.id);
  const make = (billId: string, mg: number): FinePart => ({ billId, mg });
  return {
    receiptId: receipt.id,
    kind: receipt.kind === 'fine_cash' ? 'fine_cash' : 'fine_silver',
    grams: parseGrams(receipt.fine_grams),
    amount: exact(receipt.amount),
    silverRate: receipt.silver_rate === null ? null : exact(receipt.silver_rate),
    parts: parts(own, silver, make),
    adjusted: parts(rest, silver, make),
    fineRemaining: parseGrams(response.fine_remaining),
  };
}

// ------------------------------------------------------------------------------------------------ the words of a failed save (C13)

export interface PaymentFailure {
  /** The plain sentence for the person. */
  message: string;
  /** JV_CASH_LIMIT: the screen offers the owner the field for a reason. */
  cashLimit: { ownerMayGiveReason: boolean } | null;
  /** The outcome is not known: the same action can be saved again with the same key (L5). */
  unconfirmed: boolean;
}

export interface FailureContext {
  /** The signed-in role. Only the owner may give a reason for cash over the limit (Z1). */
  role: string | null;
  /** The customer is the walk-in (K5). */
  walkIn: boolean;
  /** A payment (X2) or a silver settlement (X3). */
  kind: 'payment' | 'fine';
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

/** A money figure of the details as the screen writes it: ₹2,00,000 for a whole figure of the limit, ₹1,50,000.00 for an amount. */
const rupeesDetail = (
  details: Record<string, unknown> | undefined,
  key: string,
  withPaise: boolean
): string | null => {
  const value = textDetail(details, key);
  if (value === null) return null;
  try {
    return inr(parseRupees(value), withPaise);
  } catch {
    return null;
  }
};

const NOTHING_CHANGED = 'Nothing was changed.';

/** The sentence for the person for whatever the save threw. A refusal before any write ends "Nothing was changed." (the client's message already does). */
export function paymentSaveFailure(error: unknown, context: FailureContext): PaymentFailure {
  const none = { cashLimit: null, unconfirmed: false };
  const fine = context.kind === 'fine';
  if (!isErrorLike(error)) {
    return {
      ...none,
      message:
        error instanceof Error
          ? error.message
          : fine
            ? 'The settlement could not be saved.'
            : 'The payment could not be saved.',
    };
  }
  const details = error.details;
  const field = textDetail(details, 'field');
  switch (error.code) {
    case 'JV_CASH_LIMIT': {
      const limit = rupeesDetail(details, 'limit', false) ?? '₹2,00,000';
      if (context.walkIn || textDetail(details, 'cash_today') === null) {
        return {
          ...none,
          message: `Select or create the customer: cash of ${limit} or more cannot be taken for the walk-in customer. ${NOTHING_CHANGED}`,
        };
      }
      const today = rupeesDetail(details, 'cash_today', true);
      const thisCall = rupeesDetail(details, 'this_call', true);
      const owner = context.role === 'owner';
      return {
        ...none,
        cashLimit: { ownerMayGiveReason: owner },
        message:
          `Cash from this customer today would reach the limit of ${limit}` +
          (today && thisCall
            ? ` (${today} already today, ${thisCall} in ${fine ? 'this settlement' : 'this payment'})`
            : '') +
          '. ' +
          (owner
            ? `Give a reason of at least ${CASH_REASON_MIN} characters and save again, or take part of it by UPI, card or bank transfer.`
            : 'The owner enters this payment.') +
          ` ${NOTHING_CHANGED}`,
      };
    }
    case 'JV_OVERPAYMENT': {
      if (field === 'bill_id') {
        return {
          ...none,
          message: `A payment for the walk-in customer must name the bill it pays. Choose the bill and save again. ${NOTHING_CHANGED}`,
        };
      }
      const pending = rupeesDetail(details, 'pending', true);
      if (field === 'amount' && pending) {
        return {
          ...none,
          message: `A payment for the walk-in customer cannot be more than the ${pending} pending on the bill it pays. Lower the amount and save again. ${NOTHING_CHANGED}`,
        };
      }
      return { ...none, message: error.message };
    }
    case 'JV_FINE_EXCEEDS': {
      if (field === 'bill_id') {
        return {
          ...none,
          message: `A silver settlement for the walk-in customer must name the bill it settles. Choose the bill and save again. ${NOTHING_CHANGED}`,
        };
      }
      const max = textDetail(details, 'max_grams');
      if (max !== null) {
        let nothingOwed = false;
        try {
          nothingOwed = parseGrams(max) === 0;
        } catch {
          return { ...none, message: error.message };
        }
        const where = context.walkIn ? 'on that bill' : 'by this customer';
        return {
          ...none,
          message: nothingOwed
            ? `No silver fine is owed ${where}, so nothing can be settled. ${NOTHING_CHANGED}`
            : `That is more silver fine than is owed: at most ${max} g can be settled${context.walkIn ? ' on that bill' : ''}. Lower the grams and save again. ${NOTHING_CHANGED}`,
        };
      }
      return { ...none, message: error.message };
    }
    case 'JV_INVALID_INPUT': {
      switch (field) {
        case 'bill_id':
          return {
            ...none,
            message: `That bill cannot take this ${fine ? 'settlement' : 'payment'}: choose one of this customer's bills with ${fine ? 'silver fine still to settle' : 'money still to pay'}. ${NOTHING_CHANGED}`,
          };
        case 'silver_rate':
          return {
            ...none,
            message: `Enter the silver rate in rupees a gram; it must be more than 0. ${NOTHING_CHANGED}`,
          };
        case 'grams':
          return {
            ...none,
            message: `The grams are not accepted: they must be more than 0 with at most 3 decimals, and at this silver rate they must come to at least ₹0.01. ${NOTHING_CHANGED}`,
          };
        case 'amount':
          return {
            ...none,
            message: `The amount is not accepted: it must be more than 0 with at most 2 decimals. ${NOTHING_CHANGED}`,
          };
        case 'paid_on':
          return {
            ...none,
            message: `The date of the payment is not accepted. ${NOTHING_CHANGED}`,
          };
        default:
          return { ...none, message: error.message };
      }
    }
    case 'JV_FORBIDDEN': {
      if (field === 'cash_override_reason') {
        return {
          ...none,
          message: `Only the owner can give a reason for cash over the limit; the owner enters this payment. ${NOTHING_CHANGED}`,
        };
      }
      return { ...none, message: error.message };
    }
    default: {
      const unconfirmed = error.unconfirmed === true;
      return {
        ...none,
        unconfirmed,
        message: unconfirmed
          ? `${error.message} Press Save again: if the ${fine ? 'settlement' : 'payment'} was made it is shown, and a second one is never made.`
          : error.message,
      };
    }
  }
}
