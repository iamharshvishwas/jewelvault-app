// The derived reads of spec section 11 as the selectors want them (task WEB12; spec C14, V5).
//
// The dashboard, the reports and the customer card compute their figures with `src/lib/selectors.ts` over the rows of V1 (bill_summary), V2 (customer_balances), V4 (daily_totals) and the
// lines of the bills. The cache holds those rows in the API's own shape (snake_case, money as text); the selectors read camelCase rows. This file is the one place where one becomes the other,
// and nothing in it works a figure out: a row is renamed, never added up, rounded or parsed (the selectors read the text exactly).
//
// The readers over the cache are memoized by the version of the resources they read (`rowCache.versionOf`), so a screen that asks every second makes the rows once per change.
// This file imports no client (C9): the screens that re-read the stores every second read it, and tests/unit/memory-reads.test.ts reads their imports.
import type {
  BillItemRow,
  BillSummaryRow as BillSummaryWire,
  CustomerBalanceRow as CustomerBalanceWire,
  DailyTotalWire,
} from '@/lib/api/types';
import { rowCache } from './cache/cache';
import type {
  BillSummaryRow,
  CustomerBalanceRow,
  DailyTotalRow,
  DocType,
  PayMode,
  SoldLine,
} from './selectors';

/** V1 as the selectors read it. */
export const billSummaryOf = (row: BillSummaryWire): BillSummaryRow => ({
  id: row.id,
  billNo: row.bill_no,
  customerId: row.customer_id,
  billDate: row.bill_date,
  docType: row.doc_type as DocType,
  status: row.status,
  grandTotal: row.grand_total,
  pending: row.pending,
  finePending: row.fine_pending,
});

/** V2 as the selectors read it. */
export const customerBalanceOf = (row: CustomerBalanceWire): CustomerBalanceRow => ({
  id: row.id,
  totalPurchases: row.total_purchases,
  received: row.received,
  outstanding: row.outstanding,
  advance: row.advance,
  balance: row.balance,
  fineOutstanding: row.fine_outstanding,
  fineAdvance: row.fine_advance,
  fineBalance: row.fine_balance,
  lastPurchase: row.last_purchase,
});

/** V4 as the selectors read it. */
export const dailyTotalOf = (row: DailyTotalWire): DailyTotalRow => ({
  businessDate: row.business_date,
  mode: row.mode as PayMode,
  moneyIn: row.money_in,
  moneyOut: row.money_out,
  net: row.net,
});

/** A line of a bill as the Sales report's split reads it. */
export const soldLineOf = (row: BillItemRow): SoldLine => ({
  billId: row.bill_id,
  category: row.category,
  material: row.material,
  quantity: row.quantity,
  itemTotal: row.item_total,
});

/** A customer whose V2 row has not arrived (the hydrate is still on its way): nothing is owed and nothing is made up. */
export const emptyBalanceOf = (customerId: string): CustomerBalanceRow => ({
  id: customerId,
  totalPurchases: '0.00',
  received: '0.00',
  outstanding: '0.00',
  advance: '0.00',
  balance: '0.00',
  fineOutstanding: '0.000',
  fineAdvance: '0.000',
  fineBalance: '0.000',
  lastPurchase: null,
});

interface Memo<T> {
  version: string;
  value: readonly T[];
}
let bills: Memo<BillSummaryRow> | null = null;
let customers: Memo<CustomerBalanceRow> | null = null;
let lines: Memo<SoldLine> | null = null;

/** Every row of V1 in memory, in the selectors' shape. The same array until a bill-summary row changes. */
export function billSummaryRows(): readonly BillSummaryRow[] {
  const version = rowCache.versionOf('bill-summary');
  if (bills === null || bills.version !== version) {
    bills = { version, value: rowCache.rows('bill-summary').map(billSummaryOf) };
  }
  return bills.value;
}

/** Every row of V2 in memory (every customer, the walk-in and the archived ones included: an archived customer owes nothing, K4). */
export function customerBalanceRows(): readonly CustomerBalanceRow[] {
  const version = rowCache.versionOf('customer-balances');
  if (customers === null || customers.version !== version) {
    customers = { version, value: rowCache.rows('customer-balances').map(customerBalanceOf) };
  }
  return customers.value;
}

/** Every line of every bill in memory. */
export function soldLineRows(): readonly SoldLine[] {
  const version = rowCache.versionOf('bill-items');
  if (lines === null || lines.version !== version) {
    lines = { version, value: rowCache.rows('bill-items').map(soldLineOf) };
  }
  return lines.value;
}
