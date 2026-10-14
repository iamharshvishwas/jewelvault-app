/**
 * The one set of selectors (spec V5 and C14): the dashboard, the reports and the customer card compute their
 * figures here, from the derived views of spec section 11, so they cannot disagree. One function per figure.
 *
 * INPUT. The rows of the views as the cache holds them, with the camelCase names of the view columns
 * (`bill_no` is `billNo`, `bill_date` is `billDate`, `fine_pending` is `finePending`, `money_in` is
 * `moneyIn`, ...): `BillSummaryRow` is V1 `bill_summary`, `CustomerBalanceRow` is V2 `customer_balances`,
 * `DailyTotalRow` is V4 `daily_totals`. Only the columns a figure needs are listed; other columns of a row
 * are ignored. Amounts arrive as JSON numbers or as text (`numeric(14,2)` in rupees, `numeric(12,3)` in
 * grams); they are read exactly (`parseRupees`, `parseGrams`), never by float arithmetic.
 *
 * OUTPUT. Money in whole paise and weight in whole milligrams, as in `pricing.ts` (`formatRupees` and
 * `formatGrams` turn them into exact text; the screens format for display). Sums are added in BigInt and
 * handed back only if they are exact safe integers; otherwise the call throws, so a figure is exact or refused,
 * never rounded. A row that holds something that is not a number throws a `PricingError` naming the column.
 *
 * DATES. A business date is the Asia/Kolkata calendar day (S5), written YYYY-MM-DD, and a month YYYY-MM.
 * `businessDateOf` turns an instant into its business date; the figures take dates as arguments and never
 * read the clock, so a caller (and a test) decides what "today" is.
 *
 * WHAT IS A SALE (V5, C14). Sales are the bills with `status = 'active'` whose `docType` is not
 * `opening_balance`, grouped by `billDate`. A cancelled bill is shown on its own line (count and value), is
 * not a sale and so leaves the day it was billed on. An opening-balance bill is dues brought forward, not a
 * sale: it is left out of sales, and a cancelled opening-balance bill is not a cancelled sale either. Opening
 * dues are still dues: they count in outstanding and in the pending list.
 */
import {
  PricingError,
  assertBusinessDate,
  parseGrams,
  parseRupees,
  type DecimalInput,
} from './pricing';

export type DocType = 'estimate' | 'tax_invoice' | 'bill_of_supply' | 'opening_balance';
export type BillStatus = 'active' | 'cancelled';
export type PayMode = 'Cash' | 'UPI' | 'Card' | 'Bank Transfer' | 'Other';

/** V1 `bill_summary`: one row per bill. */
export interface BillSummaryRow {
  id: string;
  billNo: string;
  customerId: string;
  /** Business date, YYYY-MM-DD. */
  billDate: string;
  docType: DocType;
  status: BillStatus;
  grandTotal: DecimalInput;
  /** Money pending (0 for a cancelled bill). */
  pending: DecimalInput;
  /** Silver pending in grams (0 for a cancelled bill). */
  finePending: DecimalInput;
}

/** V2 `customer_balances`: one row per customer, the walk-in customer included. */
export interface CustomerBalanceRow {
  /** The customer's id. */
  id: string;
  totalPurchases: DecimalInput;
  received: DecimalInput;
  outstanding: DecimalInput;
  advance: DecimalInput;
  /** `outstanding - advance`; negative when the customer holds an advance. */
  balance: DecimalInput;
  fineOutstanding: DecimalInput;
  fineAdvance: DecimalInput;
  fineBalance: DecimalInput;
  /** Business date of the latest active, non-opening bill, or null. */
  lastPurchase: string | null;
}

/** V4 `daily_totals`: one row per business date and payment mode that had activity. */
export interface DailyTotalRow {
  businessDate: string;
  mode: PayMode;
  moneyIn: DecimalInput;
  moneyOut: DecimalInput;
  /** `moneyIn - moneyOut`. */
  net: DecimalInput;
}

export interface SalesFigure {
  count: number;
  totalPaise: number;
}

export interface PendingBill {
  billId: string;
  billNo: string;
  customerId: string;
  billDate: string;
  pendingPaise: number;
  finePendingMg: number;
  /** Whole business days from the bill date to today; never below 0. */
  daysOld: number;
}

/** A range of business dates, both ends included; an end left out is open. */
export interface DateRange {
  from?: string;
  to?: string;
}

export interface ModeTotal {
  mode: string;
  moneyInPaise: number;
  moneyOutPaise: number;
  netPaise: number;
}

/** The owner's evening check (V4): today's Cash net, today's UPI net and the total outstanding. */
export interface EveningFigures {
  businessDate: string;
  cashNetPaise: number;
  upiNetPaise: number;
  outstandingPaise: number;
}

export interface CustomerCard {
  customerId: string;
  totalPurchasesPaise: number;
  receivedPaise: number;
  outstandingPaise: number;
  advancePaise: number;
  /** Signed: negative when the customer holds an advance. */
  balancePaise: number;
  fineOutstandingMg: number;
  fineAdvanceMg: number;
  /** Signed. */
  fineBalanceMg: number;
  lastPurchase: string | null;
  /** Sales bills: active, not an opening-balance bill. */
  billCount: number;
  /** Cancelled sales bills (a cancelled opening-balance bill is not one). */
  cancelledBillCount: number;
  /** Active bills with money or silver pending, opening-balance bills included. */
  pendingBillCount: number;
}

// ---------------------------------------------------------------------------------------------------------
// reading rows exactly, adding exactly
// ---------------------------------------------------------------------------------------------------------

const ZERO = BigInt(0);
const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);

/** Money of a view row, in paise. Balances can be negative. */
const paiseOf = (value: DecimalInput, column: string) =>
  parseRupees(value, { field: column, signed: true });

/** Weight of a view row, in milligrams. */
const mgOf = (value: DecimalInput, column: string) =>
  parseGrams(value, { field: column, signed: true });

/** A sum made in BigInt: handed back as a number only if it is an exact safe integer. */
function exact(total: bigint, name: string): number {
  if (total > MAX_SAFE || total < -MAX_SAFE) {
    throw new PricingError(name, 'is too large to add exactly');
  }
  return Number(total);
}

// ---------------------------------------------------------------------------------------------------------
// business dates (S5)
// ---------------------------------------------------------------------------------------------------------

/** India has no daylight saving time; its offset from UTC has been +05:30 since 1945. */
const INDIA_OFFSET_MS = 19800000;
const MS_PER_DAY = 86400000;
const BUSINESS_MONTH = /^(\d{4})-(0[1-9]|1[0-2])$/;

/** The Asia/Kolkata calendar day of an instant: YYYY-MM-DD. The computer's own time zone plays no part. */
export function businessDateOf(instant: Date | number): string {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  if (typeof ms !== 'number' || !Number.isFinite(ms)) {
    throw new PricingError('instant', 'is not a valid time');
  }
  const local = new Date(ms + INDIA_OFFSET_MS);
  if (Number.isNaN(local.getTime())) throw new PricingError('instant', 'is not a valid time');
  const year = String(local.getUTCFullYear()).padStart(4, '0');
  const month = String(local.getUTCMonth() + 1).padStart(2, '0');
  const day = String(local.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/** The month of a business date: '2026-10-14' gives '2026-10'. */
export function businessMonthOf(businessDate: string): string {
  return assertBusinessDate(businessDate, 'businessDate').slice(0, 7);
}

function assertBusinessMonth(value: unknown, field: string): string {
  if (typeof value !== 'string' || !BUSINESS_MONTH.test(value) || Number(value.slice(0, 4)) < 1) {
    throw new PricingError(field, 'must be a month written YYYY-MM');
  }
  return value;
}

/** Day number of a business date (days since 1 January 1970), exact. */
function dayNumber(businessDate: string, field: string): number {
  assertBusinessDate(businessDate, field);
  const probe = new Date(0);
  probe.setUTCFullYear(
    Number(businessDate.slice(0, 4)),
    Number(businessDate.slice(5, 7)) - 1,
    Number(businessDate.slice(8, 10))
  );
  return probe.getTime() / MS_PER_DAY; // a whole number: the time of day is midnight UTC
}

// ---------------------------------------------------------------------------------------------------------
// V5: sales and cancelled bills
// ---------------------------------------------------------------------------------------------------------

const isSale = (row: BillSummaryRow) =>
  row.status === 'active' && row.docType !== 'opening_balance';
const isCancelledSale = (row: BillSummaryRow) =>
  row.status === 'cancelled' && row.docType !== 'opening_balance';

/** Count and value (the grand totals) of the bills that pass `accept` and whose bill date passes `inPeriod`. */
function figureOf(
  bills: readonly BillSummaryRow[],
  accept: (row: BillSummaryRow) => boolean,
  inPeriod: (billDate: string) => boolean
): SalesFigure {
  let count = 0;
  let total = ZERO;
  for (const row of bills) {
    if (!accept(row) || !inPeriod(row.billDate)) continue;
    count += 1;
    total += BigInt(paiseOf(row.grandTotal, 'grandTotal'));
  }
  return { count, totalPaise: exact(total, 'totalPaise') };
}

const onDate = (date: string) => (billDate: string) => billDate === date;
const inMonth = (month: string) => (billDate: string) => billDate.slice(0, 7) === month;
const inRange = (fromDate: string, toDate: string) => (billDate: string) =>
  fromDate <= billDate && billDate <= toDate;

/** Sales of one business date: count and value in paise. */
export function salesForDate(bills: readonly BillSummaryRow[], date: string): SalesFigure {
  return figureOf(bills, isSale, onDate(assertBusinessDate(date, 'date')));
}

/** Sales of one month ('2026-10'). */
export function salesForMonth(bills: readonly BillSummaryRow[], month: string): SalesFigure {
  return figureOf(bills, isSale, inMonth(assertBusinessMonth(month, 'month')));
}

/** Sales between two business dates, both included. A range that ends before it starts holds nothing. */
export function salesInRange(
  bills: readonly BillSummaryRow[],
  fromDate: string,
  toDate: string
): SalesFigure {
  return figureOf(
    bills,
    isSale,
    inRange(assertBusinessDate(fromDate, 'fromDate'), assertBusinessDate(toDate, 'toDate'))
  );
}

/** Cancelled bills of one business date, on their own line: count and value. Not sales. */
export function cancelledForDate(bills: readonly BillSummaryRow[], date: string): SalesFigure {
  return figureOf(bills, isCancelledSale, onDate(assertBusinessDate(date, 'date')));
}

/** Cancelled bills of one month. */
export function cancelledForMonth(bills: readonly BillSummaryRow[], month: string): SalesFigure {
  return figureOf(bills, isCancelledSale, inMonth(assertBusinessMonth(month, 'month')));
}

/** Cancelled bills between two business dates, both included. */
export function cancelledInRange(
  bills: readonly BillSummaryRow[],
  fromDate: string,
  toDate: string
): SalesFigure {
  return figureOf(
    bills,
    isCancelledSale,
    inRange(assertBusinessDate(fromDate, 'fromDate'), assertBusinessDate(toDate, 'toDate'))
  );
}

// ---------------------------------------------------------------------------------------------------------
// outstanding
// ---------------------------------------------------------------------------------------------------------

/** Total outstanding: the sum of V2 `outstanding` over every customer (walk-in and opening dues included). */
export function totalOutstanding(customers: readonly CustomerBalanceRow[]): number {
  let total = ZERO;
  for (const row of customers) total += BigInt(paiseOf(row.outstanding, 'outstanding'));
  return exact(total, 'totalPaise');
}

/** Total silver fine outstanding, in milligrams: the sum of V2 `fineOutstanding`. */
export function totalFineOutstanding(customers: readonly CustomerBalanceRow[]): number {
  let total = ZERO;
  for (const row of customers) total += BigInt(mgOf(row.fineOutstanding, 'fineOutstanding'));
  return exact(total, 'totalMg');
}

/** How many customers owe money. */
export function customersWithDues(customers: readonly CustomerBalanceRow[]): number {
  return customers.filter((row) => paiseOf(row.outstanding, 'outstanding') > 0).length;
}

/**
 * The active bills with money pending, oldest first (bill date, then bill number), with their age in
 * business days at `today`. As coded, a bill with only silver pending is not listed; its fine is shown on
 * the row of a bill that also has money pending and in the totals above.
 */
export function pendingBills(bills: readonly BillSummaryRow[], today: string): PendingBill[] {
  const todayNumber = dayNumber(today, 'today');
  const pending: PendingBill[] = [];
  for (const row of bills) {
    if (row.status !== 'active') continue;
    const pendingPaise = paiseOf(row.pending, 'pending');
    if (pendingPaise <= 0) continue;
    pending.push({
      billId: row.id,
      billNo: row.billNo,
      customerId: row.customerId,
      billDate: row.billDate,
      pendingPaise,
      finePendingMg: mgOf(row.finePending, 'finePending'),
      daysOld: Math.max(0, todayNumber - dayNumber(row.billDate, 'billDate')),
    });
  }
  const order = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return pending.sort(
    (a, b) =>
      order(a.billDate, b.billDate) || order(a.billNo, b.billNo) || order(a.billId, b.billId)
  );
}

// ---------------------------------------------------------------------------------------------------------
// V4: payments by mode, the cash book of a day, the evening check
// ---------------------------------------------------------------------------------------------------------

const KNOWN_MODES: readonly string[] = ['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other'];

/**
 * Money in, money out and net per payment mode over a range of business dates (both ends included; an end
 * left out is open). The five modes of V4 are always listed, in a fixed order, with zeros when there is
 * nothing; a mode this code does not know is listed after them, so no money is ever dropped.
 */
export function paymentModeTotals(rows: readonly DailyTotalRow[], range?: DateRange): ModeTotal[] {
  const from = range?.from === undefined ? undefined : assertBusinessDate(range.from, 'from');
  const to = range?.to === undefined ? undefined : assertBusinessDate(range.to, 'to');
  const sums = new Map<string, { in: bigint; out: bigint; net: bigint }>();
  for (const mode of KNOWN_MODES) sums.set(mode, { in: ZERO, out: ZERO, net: ZERO });
  for (const row of rows) {
    if (
      (from !== undefined && row.businessDate < from) ||
      (to !== undefined && row.businessDate > to)
    ) {
      continue;
    }
    let sum = sums.get(row.mode);
    if (sum === undefined) {
      sum = { in: ZERO, out: ZERO, net: ZERO };
      sums.set(row.mode, sum);
    }
    sum.in += BigInt(paiseOf(row.moneyIn, 'moneyIn'));
    sum.out += BigInt(paiseOf(row.moneyOut, 'moneyOut'));
    sum.net += BigInt(paiseOf(row.net, 'net'));
  }
  const unknown = Array.from(sums.keys())
    .filter((mode) => !KNOWN_MODES.includes(mode))
    .sort();
  return [...KNOWN_MODES, ...unknown].map((mode) => {
    const sum = sums.get(mode) as { in: bigint; out: bigint; net: bigint };
    return {
      mode,
      moneyInPaise: exact(sum.in, 'moneyInPaise'),
      moneyOutPaise: exact(sum.out, 'moneyOutPaise'),
      netPaise: exact(sum.net, 'netPaise'),
    };
  });
}

/** Total collected over a range: money in minus money out (refunds and voids included), all modes. */
export function totalCollected(rows: readonly DailyTotalRow[], range?: DateRange): number {
  let total = ZERO;
  for (const mode of paymentModeTotals(rows, range)) total += BigInt(mode.netPaise);
  return exact(total, 'totalPaise');
}

function netOfModeOnDate(rows: readonly DailyTotalRow[], date: string, mode: PayMode): number {
  assertBusinessDate(date, 'date');
  let total = ZERO;
  for (const row of rows) {
    if (row.businessDate === date && row.mode === mode) total += BigInt(paiseOf(row.net, 'net'));
  }
  return exact(total, 'netPaise');
}

/** The Cash net of a business date (V4): money in minus money out in the Cash mode. */
export function cashNetForDate(rows: readonly DailyTotalRow[], date: string): number {
  return netOfModeOnDate(rows, date, 'Cash');
}

/** The UPI net of a business date (V4). */
export function upiNetForDate(rows: readonly DailyTotalRow[], date: string): number {
  return netOfModeOnDate(rows, date, 'UPI');
}

/** The owner's evening check (V4): the day's Cash net, the day's UPI net and the total outstanding. */
export function eveningFigures(
  rows: readonly DailyTotalRow[],
  customers: readonly CustomerBalanceRow[],
  date: string
): EveningFigures {
  return {
    businessDate: assertBusinessDate(date, 'date'),
    cashNetPaise: cashNetForDate(rows, date),
    upiNetPaise: upiNetForDate(rows, date),
    outstandingPaise: totalOutstanding(customers),
  };
}

// ---------------------------------------------------------------------------------------------------------
// the customer card
// ---------------------------------------------------------------------------------------------------------

/**
 * The figures of one customer's card: the V2 row of the customer, and the counts of their bills from V1.
 * `bills` may hold every customer's rows; only this customer's are looked at.
 */
export function customerCard(
  balance: CustomerBalanceRow,
  bills: readonly BillSummaryRow[]
): CustomerCard {
  let billCount = 0;
  let cancelledBillCount = 0;
  let pendingBillCount = 0;
  for (const row of bills) {
    if (row.customerId !== balance.id) continue;
    if (isSale(row)) billCount += 1;
    if (isCancelledSale(row)) cancelledBillCount += 1;
    if (
      row.status === 'active' &&
      (paiseOf(row.pending, 'pending') > 0 || mgOf(row.finePending, 'finePending') > 0)
    ) {
      pendingBillCount += 1;
    }
  }
  return {
    customerId: balance.id,
    totalPurchasesPaise: paiseOf(balance.totalPurchases, 'totalPurchases'),
    receivedPaise: paiseOf(balance.received, 'received'),
    outstandingPaise: paiseOf(balance.outstanding, 'outstanding'),
    advancePaise: paiseOf(balance.advance, 'advance'),
    balancePaise: paiseOf(balance.balance, 'balance'),
    fineOutstandingMg: mgOf(balance.fineOutstanding, 'fineOutstanding'),
    fineAdvanceMg: mgOf(balance.fineAdvance, 'fineAdvance'),
    fineBalanceMg: mgOf(balance.fineBalance, 'fineBalance'),
    lastPurchase: balance.lastPurchase,
    billCount,
    cancelledBillCount,
    pendingBillCount,
  };
}
