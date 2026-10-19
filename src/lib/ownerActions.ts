// The owner's actions without the screens (spec C13, X4, X5, X10, X11, X12, K3, K5, K6, Y8, Y10; task WEB11). Everything the dialogs and the billing screen work out is here, so that it can
// be tested without a browser:
//
//   - THE REQUESTS. `buildReasonBody` (cancel X5, void X4: a reason of 3 to 500 characters once trimmed), `buildRefundBody` (X11), `buildOpeningBody` (X12) and `buildReissueBody` (X10: the
//     corrected bill WITHOUT its customer, which cannot change, with the reason). Money goes out as text with two decimals and silver with three, so the same form typed two ways is the
//     same body (and so the same Idempotency-Key, see moneyServer); a blank optional field is left out; the sentence for what is wrong is given before any call is made.
//   - THE ANSWERS. `savedCancelFrom`, `savedVoidFrom`, `savedRefundFrom` and `savedOpeningFrom` turn the rows an answer returned into what the dialog shows. Nothing is added up here that the
//     API did not send: a figure is a sum of the allocation rows or receipts of the answer, in whole paise and milligrams (never a float), or a figure the API sent (the advance left).
//     `reissueAsCreated` makes the answer of X10 look like the answer of X1, so that the billing screen shows the corrected bill with the code it already has.
//   - THE WORDS. `ownerActionFailure` and `reissueFailure` give the plain sentence for each error code of the five actions (C13), with the reason and the figures the API names: "void the
//     refund first" and how much was handed back, a refund above the advance, a walk-in advance, an opening bill that cannot be re-issued. A refusal before any write ends "Nothing was
//     changed."; an outcome that is not known says "Could not confirm that this was saved." and that the books are being read again (C17). The general sentences are src/lib/api/errorMap.ts.
//
// This file makes no network call and keeps nothing between calls.
import type {
  CancelBillResponse,
  CreateBillResponse,
  IssueRefundResponse,
  OpeningBalanceResponse,
  ReceiptAllocationRow,
  ReissueBillResponse,
  VoidReceiptResponse,
} from './api/types';
import { NOTHING_CHANGED } from './api/errorMap';
import {
  PAYMENT_MODES,
  billSaveFailure,
  inr,
  type BillBody,
  type PaymentMode,
  type SaveFailure,
} from './billing';
import { NOTES_MAX, REFERENCE_MAX, typedUnits } from './payments';
import { assertBusinessDate, formatGrams, formatRupees, parseGrams, parseRupees } from './pricing';

// ------------------------------------------------------------------------------------------------ the five actions

export const OWNER_ACTIONS = ['cancel', 'reissue', 'void', 'refund', 'opening'] as const;
export type OwnerAction = (typeof OWNER_ACTIONS)[number];

/** X4 and X5: the reason is 3 to 500 characters once trimmed (the API's rule, D11 and D13 are VARCHAR(500)). */
export const REASON_MIN = 3;
export const REASON_MAX = 500;

// ------------------------------------------------------------------------------------------------ the requests

export interface ReasonBody {
  reason: string;
}

/** The body of a cancel (X5) or a void (X4), or the sentence that says what is wrong with the reason. */
export function buildReasonBody(text: string): { body: ReasonBody } | { error: string } {
  const reason = text.trim();
  if (reason.length < REASON_MIN)
    return { error: `Give a reason of at least ${REASON_MIN} characters.` };
  if (reason.length > REASON_MAX)
    return { error: `The reason can have at most ${REASON_MAX} characters.` };
  return { body: { reason } };
}

export interface RefundBody {
  amount: string;
  mode: PaymentMode;
  reference?: string;
  notes?: string;
}

export interface RefundInput {
  /** What is typed: rupees. */
  amount: string;
  mode: string;
  reference: string;
  notes: string;
}

/** The body of a refund (X11), or the sentence that says what to fix first. The date is left out on purpose: a refund is dated today (Y8). */
export function buildRefundBody(input: RefundInput): { body: RefundBody } | { error: string } {
  const paise = typedUnits(input.amount, 2, 'amount');
  if (typeof paise === 'string') return { error: paise };
  if (paise <= 0) return { error: 'The amount must be more than 0.' };
  if (!(PAYMENT_MODES as readonly string[]).includes(input.mode))
    return { error: 'Choose the payment mode.' };
  const reference = input.reference.trim();
  if (reference.length > REFERENCE_MAX)
    return { error: `The reference can have at most ${REFERENCE_MAX} characters.` };
  const notes = input.notes.trim();
  if (notes.length > NOTES_MAX)
    return { error: `The notes can have at most ${NOTES_MAX.toLocaleString('en-IN')} characters.` };
  return {
    body: {
      amount: formatRupees(paise),
      mode: input.mode as PaymentMode,
      ...(reference === '' ? {} : { reference }),
      ...(notes === '' ? {} : { notes }),
    },
  };
}

export interface OpeningBody {
  dues?: string;
  fine_due?: string;
  advance?: string;
  fine_advance?: string;
  as_of: string;
}

export interface OpeningInput {
  /** What the customer owed on the day (rupees), the silver they owed (grams), what they had paid in advance (rupees) and the silver they had paid in advance (grams): typed text, blank is none. */
  dues: string;
  fineDue: string;
  advance: string;
  fineAdvance: string;
  asOf: string;
  /** The customer is the walk-in: it stands for many people and never holds an advance (K5). */
  walkIn: boolean;
}

/** One optional figure: blank or 0 is left out; anything else is its text with the scale of the column, or the sentence that says what is wrong. */
function optionalFigure(
  text: string,
  scale: 2 | 3,
  what: string
): { value: string | null } | { error: string } {
  if (text.trim() === '') return { value: null };
  const units = typedUnits(text, scale, what);
  if (typeof units === 'string') return { error: units };
  if (units === 0) return { value: null };
  return { value: scale === 2 ? formatRupees(units) : formatGrams(units) };
}

/** The body of an opening balance (X12), or the sentence that says what to fix first. At least one figure above 0 is needed. */
export function buildOpeningBody(input: OpeningInput): { body: OpeningBody } | { error: string } {
  const dues = optionalFigure(input.dues, 2, 'dues');
  if ('error' in dues) return dues;
  const fineDue = optionalFigure(input.fineDue, 3, 'silver due');
  if ('error' in fineDue) return fineDue;
  const advance = optionalFigure(input.advance, 2, 'advance');
  if ('error' in advance) return advance;
  const fineAdvance = optionalFigure(input.fineAdvance, 3, 'silver advance');
  if ('error' in fineAdvance) return fineAdvance;
  try {
    assertBusinessDate(input.asOf, 'asOf');
  } catch {
    return { error: 'Choose the date these figures are dated.' };
  }
  if (
    dues.value === null &&
    fineDue.value === null &&
    advance.value === null &&
    fineAdvance.value === null
  )
    return {
      error: 'Enter at least one figure above 0: dues, silver due, advance or silver advance.',
    };
  if (input.walkIn && (advance.value !== null || fineAdvance.value !== null))
    return {
      error:
        'The walk-in customer cannot hold an advance, because it stands for many different people. Enter the dues only, or choose a named customer.',
    };
  return {
    body: {
      ...(dues.value === null ? {} : { dues: dues.value }),
      ...(fineDue.value === null ? {} : { fine_due: fineDue.value }),
      ...(advance.value === null ? {} : { advance: advance.value }),
      ...(fineAdvance.value === null ? {} : { fine_advance: fineAdvance.value }),
      as_of: input.asOf,
    },
  };
}

export type ReissueBody = Omit<BillBody, 'customer_id'> & { reason: string };

/**
 * The body of a re-issue (X10): the corrected bill as the billing screen built it, without its customer (the customer is the old bill's and cannot change, K6; the API refuses even the old
 * bill's own id), and the reason.
 */
export function buildReissueBody(
  bill: BillBody,
  reasonText: string
): { body: ReissueBody } | { error: string } {
  const reason = buildReasonBody(reasonText);
  if ('error' in reason) return reason;
  const { customer_id: _customerCannotChange, ...rest } = bill;
  return { body: { reason: reason.body.reason, ...rest } };
}

// ------------------------------------------------------------------------------------------------ the answers

const sumPaise = (rows: readonly ReceiptAllocationRow[]): number =>
  rows.reduce((total, row) => total + parseRupees(row.amount), 0);
const sumFineMg = (rows: readonly ReceiptAllocationRow[]): number =>
  rows.reduce((total, row) => total + parseGrams(row.fine_grams), 0);

/** The rows by bill, with their money, in the order the bills first appear (rows with no money are left out). */
function moneyByBill(
  rows: readonly ReceiptAllocationRow[]
): Array<{ billId: string; paise: number }> {
  const byBill = new Map<string, number>();
  for (const row of rows) {
    const paise = parseRupees(row.amount);
    if (paise > 0) byBill.set(row.bill_id, (byBill.get(row.bill_id) ?? 0) + paise);
  }
  return [...byBill].map(([billId, paise]) => ({ billId, paise }));
}

function fineByBill(rows: readonly ReceiptAllocationRow[]): Array<{ billId: string; mg: number }> {
  const byBill = new Map<string, number>();
  for (const row of rows) {
    const mg = parseGrams(row.fine_grams);
    if (mg > 0) byBill.set(row.bill_id, (byBill.get(row.bill_id) ?? 0) + mg);
  }
  return [...byBill].map(([billId, mg]) => ({ billId, mg }));
}

export interface SavedCancel {
  billId: string;
  billNo: string;
  /** Pieces that went back to stock. */
  pieces: number;
  /** The money (paise) the bill had received that the cancel released, how much of it the rebalance applied to other bills, and how much is held as the customer's advance. */
  releasedPaise: number;
  appliedPaise: number;
  keptPaise: number;
  /** The same for the silver (milligrams). */
  releasedFineMg: number;
  appliedFineMg: number;
  keptFineMg: number;
  parts: Array<{ billId: string; paise: number }>;
  fineParts: Array<{ billId: string; mg: number }>;
}

/** What the cancel dialog shows once X5 has answered. */
export function savedCancelFrom(response: CancelBillResponse): SavedCancel {
  const releasedPaise = sumPaise(response.released_allocations);
  const appliedPaise = sumPaise(response.allocations);
  const releasedFineMg = sumFineMg(response.released_allocations);
  const appliedFineMg = sumFineMg(response.allocations);
  return {
    billId: response.bill.id,
    billNo: response.bill.bill_no,
    pieces: response.skus.length,
    releasedPaise,
    appliedPaise,
    keptPaise: Math.max(0, releasedPaise - appliedPaise),
    releasedFineMg,
    appliedFineMg,
    keptFineMg: Math.max(0, releasedFineMg - appliedFineMg),
    parts: moneyByBill(response.allocations),
    fineParts: fineByBill(response.allocations),
  };
}

export interface SavedVoid {
  receiptId: string;
  kind: string;
  amountPaise: number;
  fineMg: number;
  /** The bills the void touched, with the figures V1 gave after the call. */
  bills: Array<{ billId: string; billNo: string; pendingPaise: number; finePendingMg: number }>;
  /** Money the rebalance applied to bills with what the void freed (an advance that had been waiting). */
  appliedElsewherePaise: number;
}

/** What the void dialog shows once X4 has answered. */
export function savedVoidFrom(response: VoidReceiptResponse): SavedVoid {
  return {
    receiptId: response.receipt.id,
    kind: response.receipt.kind,
    amountPaise: parseRupees(response.receipt.amount),
    fineMg: parseGrams(response.receipt.fine_grams),
    bills: response.bills.map((bill) => ({
      billId: bill.id,
      billNo: bill.bill_no,
      pendingPaise: parseRupees(bill.pending),
      finePendingMg: parseGrams(bill.fine_pending),
    })),
    appliedElsewherePaise: sumPaise(response.allocations),
  };
}

export interface SavedRefund {
  receiptId: string;
  amountPaise: number;
  mode: string;
  /** The advance the customer still holds after the refund, as the API worked it out. */
  advanceLeftPaise: number;
}

export function savedRefundFrom(response: IssueRefundResponse): SavedRefund {
  return {
    receiptId: response.receipt.id,
    amountPaise: parseRupees(response.receipt.amount),
    mode: response.receipt.mode ?? '',
    advanceLeftPaise: parseRupees(response.advance),
  };
}

export interface SavedOpening {
  billId: string | null;
  billNo: string | null;
  duesPaise: number;
  fineDueMg: number;
  advancePaise: number;
  fineAdvanceMg: number;
  /** What the rebalance netted off: an advance and dues of one customer cancel each other. */
  nettedPaise: number;
  nettedFineMg: number;
}

export function savedOpeningFrom(response: OpeningBalanceResponse): SavedOpening {
  return {
    billId: response.bill?.id ?? null,
    billNo: response.bill?.bill_no ?? null,
    duesPaise: response.bill ? parseRupees(response.bill.grand_total) : 0,
    fineDueMg: response.bill ? parseGrams(response.bill.fine_weight_due) : 0,
    advancePaise: response.receipts
      .filter((receipt) => receipt.kind === 'money')
      .reduce((total, receipt) => total + parseRupees(receipt.amount), 0),
    fineAdvanceMg: response.receipts
      .filter((receipt) => receipt.kind === 'fine_silver')
      .reduce((total, receipt) => total + parseGrams(receipt.fine_grams), 0),
    nettedPaise: sumPaise(response.allocations),
    nettedFineMg: sumFineMg(response.allocations),
  };
}

/** The answer of X10 in the shape of the answer of X1: the new bill is "the bill". The old bill and the released rows are merged into memory by the money server. */
export function reissueAsCreated(response: ReissueBillResponse): CreateBillResponse {
  return {
    bill: response.new_bill,
    items: response.items,
    receipts: response.receipts,
    allocations: response.allocations,
    warnings: response.warnings,
    advance_applied: response.advance_applied,
  };
}

// ------------------------------------------------------------------------------------------------ the words of a failed action (C13)

export interface ActionFailure {
  /** The plain sentence for the person. */
  message: string;
  /** The outcome is not known: the screen reads the customer's books again at once, and the same action can be sent again with the same key (L5). */
  unconfirmed: boolean;
}

export interface ActionContext {
  action: Exclude<OwnerAction, 'reissue'>;
  /** The customer is the walk-in (K5). */
  walkIn?: boolean;
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

/** A money figure of the details as the screen writes it: ₹300 for a whole figure, ₹300.50 for one with paise. */
const rupeesDetail = (details: Record<string, unknown> | undefined, key: string): string | null => {
  const value = textDetail(details, key);
  if (value === null) return null;
  try {
    const paise = parseRupees(value);
    return inr(paise, paise % 100 !== 0);
  } catch {
    return null;
  }
};

const gramsDetail = (details: Record<string, unknown> | undefined, key: string): string | null => {
  const value = textDetail(details, key);
  if (value === null) return null;
  try {
    return `${formatGrams(parseGrams(value))} g`;
  } catch {
    return null;
  }
};

const done = (text: string): string => `${text} ${NOTHING_CHANGED}`;

const WHAT: Record<OwnerAction, { thing: string; doing: string; only: string }> = {
  cancel: { thing: 'bill', doing: 'cancelling a bill', only: 'cancel a bill' },
  reissue: { thing: 'bill', doing: 're-issuing a bill', only: 're-issue a bill' },
  void: { thing: 'receipt', doing: 'voiding a receipt', only: 'void a receipt' },
  refund: { thing: 'customer', doing: 'handing money back', only: 'hand money back' },
  opening: {
    thing: 'customer',
    doing: 'adding an opening balance',
    only: 'add an opening balance',
  },
};

const REASON_SENTENCE = `Give a reason of ${REASON_MIN} to ${REASON_MAX} characters.`;

/** What an unconfirmed outcome tells the person: the books are read again at once (C17), and pressing the button again never does the thing twice (L5). */
const unconfirmedHelp = (error: ErrorLike): string =>
  `${error.message} The books are being read again: look at the customer's bills and receipts, and if it is not there press the button again. It is never done twice.`;

/** The sentences that depend on the code and on what the API named in `details` (`field`, `reason`, the figures); null when the general sentence is the right one. */
function specificRefusal(
  error: ErrorLike,
  context: { action: OwnerAction; walkIn: boolean }
): string | null {
  const { action } = context;
  const details = error.details;
  const field = textDetail(details, 'field');
  const reason = textDetail(details, 'reason');
  switch (error.code) {
    case 'JV_FORBIDDEN':
      if (reason === 'inactive') return error.message;
      return done(`Only the owner can ${WHAT[action].only}.`);
    case 'JV_NOT_FOUND':
      return done(`That ${WHAT[action].thing} was not found.`);
    case 'JV_CUSTOMER_ARCHIVED':
      return done(
        `This customer is archived. Bring the customer back before ${WHAT[action].doing}.`
      );
    case 'JV_BILL_CANCELLED':
      return done(
        action === 'reissue'
          ? 'This bill was already cancelled or re-issued, so it cannot be re-issued again.'
          : 'This bill is already cancelled.'
      );
    case 'JV_ALREADY_VOID':
      return done('This receipt is already void.');
    case 'JV_UNAVAILABLE':
      // the start-up check failed: no request was served
      return done(error.message);
    case 'JV_INVALID_INPUT':
      if (field === 'reason') return done(REASON_SENTENCE);
      if (action === 'refund') {
        if (field === 'amount')
          return done(
            'The amount is not accepted: it must be more than 0, with at most 2 decimals.'
          );
        if (field === 'mode') return done('Choose the payment mode.');
        if (field === 'paid_on') return done('The date is not accepted.');
        if (field === 'reference')
          return done(`The reference can have at most ${REFERENCE_MAX} characters.`);
      }
      if (action === 'opening') return openingRefusal(field);
      return null;
    case 'JV_NOT_ALLOWED':
      return notAllowed(action, reason, details, context.walkIn);
    default:
      return null;
  }
}

/** JV_INVALID_INPUT of X12 by the field the API named. */
function openingRefusal(field: string | null): string | null {
  if (field === 'dues')
    return done('Enter at least one figure above 0: dues, silver due, advance or silver advance.');
  if (field === 'as_of') return done('The date is not accepted: choose a day up to today.');
  const labels: Record<string, [string, number]> = {
    fine_due: ['silver due', 3],
    advance: ['advance', 2],
    fine_advance: ['silver advance', 3],
  };
  const found = field === null ? undefined : labels[field];
  return found
    ? done(
        `The ${found[0]} is not accepted: it must be 0 or more, with at most ${found[1]} decimals.`
      )
    : null;
}

function notAllowed(
  action: OwnerAction,
  reason: string | null,
  details: Record<string, unknown> | undefined,
  walkIn: boolean
): string | null {
  switch (reason) {
    case 'void_the_refund_first': {
      const short = rupeesDetail(details, 'short_by');
      return done(
        `${short ? `${short} of this payment` : 'The money of this payment'} was already handed back to the customer, so it cannot be voided yet. Void the refund first, then void this payment.`
      );
    }
    case 'void_its_receipts_first': {
      if (action === 'reissue') {
        const money = rupeesDetail(details, 'surplus');
        const silver = gramsDetail(details, 'fine_surplus');
        const extra = [money && `${money} of money`, silver && `${silver} of silver`]
          .filter(Boolean)
          .join(' and ');
        return done(
          `The money or silver already received on this walk-in bill${extra ? ` (${extra} more than the corrected bill)` : ''} has nowhere else to go. Void those receipts first, then re-issue the bill.`
        );
      }
      return done(
        'This bill of the walk-in customer has money or silver received on it. Void those receipts first, then cancel the bill.'
      );
    }
    case 'not_an_estimate':
      return done(
        'This is dues brought forward (an opening balance), not an estimate, so it cannot be re-issued. Cancel it and add a new opening balance.'
      );
    case 'more_than_advance': {
      const advance = rupeesDetail(details, 'advance');
      const short = rupeesDetail(details, 'short_by');
      const none = textDetail(details, 'advance');
      let held = false;
      try {
        held = none !== null && parseRupees(none) > 0;
      } catch {
        held = false;
      }
      if (!held)
        return done(
          walkIn
            ? 'The walk-in customer never holds an advance, so there is nothing to hand back.'
            : 'The customer holds no advance, so there is nothing to hand back.'
        );
      return done(
        `The customer holds ${advance ?? 'less'} in advance, so at most that can be handed back${short ? `; this refund is ${short} too much` : ''}.`
      );
    }
    case 'walkin_holds_no_advance':
      return done(
        'The walk-in customer cannot hold an advance, because it stands for many different people. Enter the dues only, or choose a named customer.'
      );
    default:
      return null;
  }
}

/** The sentence for the person for whatever a cancel, a void, a refund or an opening balance threw. A refusal before any write ends "Nothing was changed." (the client's message already does). */
export function ownerActionFailure(error: unknown, context: ActionContext): ActionFailure {
  if (!isErrorLike(error))
    return { unconfirmed: false, message: done('The action could not be completed.') };
  const specific = specificRefusal(error, {
    action: context.action,
    walkIn: context.walkIn === true,
  });
  if (specific !== null) return { unconfirmed: false, message: specific };
  const unconfirmed = error.unconfirmed === true;
  return { unconfirmed, message: unconfirmed ? unconfirmedHelp(error) : error.message };
}

export interface ReissueFailureContext {
  /** The signed-in role. Only the owner may give a reason for cash over the limit (Z1). */
  role: string | null;
  /** The old bill is the walk-in's (K5). */
  walkIn: boolean;
}

/**
 * The sentence for the person for whatever a re-issue threw. The corrected bill is saved like a new one, so the words of the billing screen (a piece that is no longer available, an
 * overpayment, the cash limit) are used as they are; what is X10's own is said here.
 */
export function reissueFailure(error: unknown, context: ReissueFailureContext): SaveFailure {
  if (isErrorLike(error)) {
    const specific = specificRefusal(error, { action: 'reissue', walkIn: context.walkIn });
    if (specific !== null)
      return { message: specific, cashLimit: null, pieceIds: [], unconfirmed: false };
  }
  const found = billSaveFailure(error, { role: context.role, walkIn: context.walkIn });
  if (found.unconfirmed && isErrorLike(error)) return { ...found, message: unconfirmedHelp(error) };
  return found;
}
