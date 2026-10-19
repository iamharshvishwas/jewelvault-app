'use client';

import type {
  BillItemRow,
  BillRow,
  CancelBillResponse,
  CreateBillResponse,
  CustomerBalanceRow,
  CustomerRow,
  IssueRefundResponse,
  OpeningBalanceResponse,
  ReceiptRow,
  RecordPaymentResponse,
  ReissueBillResponse,
  SettleFineResponse,
  SyncResource,
  VoidReceiptResponse,
} from '@/lib/api/types';
import type { BillBody } from './billing';
import type { OpeningBody, ReasonBody, RefundBody, ReissueBody } from './ownerActions';
import type { RecordPaymentBody, SettleFineBody } from './payments';
import { rowCache, savingNotAvailable } from './cache/cache';
import { booksServer, type DailyTotalsView, type HealthView } from './cache/booksServer';
import { SaveError, editRow } from './cache/edit';
import { moneyServer, type LedgerLoadState, type LedgerWireRow } from './cache/moneyServer';
import { stampMicros } from './cache/stamp';
import {
  MOCK_CUSTOMERS,
  MOCK_HEALTH,
  MOCK_INVOICES,
  MOCK_LEDGER,
  MOCK_REVIEW,
  type Customer,
  type CustomerType,
  type Invoice,
  type InvoiceItem,
  type LedgerEntry,
  type LedgerKind,
  type Material,
  type Payment,
  type Purity,
  type SellingMethod,
} from './mockData';
import { getSettings } from './settingsStore';
import { PREVIEW_MODE } from './previewMode';
import {
  billSummaryRows,
  customerBalanceOf,
  customerBalanceRows,
  dailyTotalOf,
  emptyBalanceOf,
  soldLineRows,
} from './books';
import {
  businessDateOf,
  businessMonthOf,
  cancelledForDate,
  cancelledForMonth,
  customerCard,
  customersWithDues,
  eveningFigures,
  lineTotalsByCategory,
  lineTotalsByMetal,
  lineTotalsByMonth,
  paymentModeTotals,
  pendingBills,
  salesForDate,
  salesForMonth,
  shareOfTotal,
  totalFineOutstanding,
  totalOutstanding,
  type BillSummaryRow as SelectorBillRow,
  type CustomerBalanceRow as SelectorBalanceRow,
  type CustomerCard,
  type DailyTotalRow,
  type LineTotal,
  type ModeTotal,
  type MonthLines,
  type SalesFigure,
  type SoldLine,
} from './selectors';

// The money-side store keeps its names and its synchronous reads. Task WEB07 changes where the data comes from:
//   - in a real build (spec C1, C3, C8, C9) customers, invoices and the ledger are made from the rows the hydrate and the poll put in memory (src/lib/cache): customers and
//     customer-balances (V2), bills, bill-summary (V1), bill-items, receipts and receipt-allocations. `getInvoices()` is the same array until a row it is made of changes. Every
//     figure comes from the server as it was saved: the received, pending, status and fine pending of an invoice are the row of V1, the figures of a customer the row of V2, and the
//     ledger is the one V3 gave when the customer card opened; nothing is added up again here. Nothing is read from or written to browser storage, and before the loading gate has
//     opened (or after a logout) memory is empty and so are the lists: never sample data (D20). A customer is made by X6 (`addCustomer`); every other change cannot be saved yet
//     (WEB08 to WEB11 put each kind of save on the API), so the writing functions say so and change nothing, rather than show a change that is not saved;
//   - in a preview build (src/lib/previewMode.ts, until WEB15) the store is the prototype's: sample data, kept in this browser only.
// This file imports no client (C9, tests/unit/memory-reads.test.ts): the two calls it needs, X6 and the ledger, are in src/lib/cache/moneyServer.ts.
// The shapes are the prototype's (src/lib/mockData.ts): amounts are numbers made from the API's text, for display; money is never worked out from them.
const CUSTOMER_KEY = 'jaishri.customers.v1';
const INVOICE_KEY = 'jaishri.invoices.v1';
const LEDGER_KEY = 'jaishri.ledger.v1';

function canUseStorage() {
  return (
    PREVIEW_MODE && typeof window !== 'undefined' && typeof window.localStorage !== 'undefined'
  );
}

function readStored<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback;
  const saved = window.localStorage.getItem(key);
  if (!saved) return fallback;
  try {
    return JSON.parse(saved) as T;
  } catch {
    return fallback;
  }
}

function writeStored<T>(key: string, value: T) {
  if (canUseStorage()) window.localStorage.setItem(key, JSON.stringify(value));
}

function persistAppStore() {
  writeStored(CUSTOMER_KEY, _customers);
  writeStored(INVOICE_KEY, _invoices);
  writeStored(LEDGER_KEY, _ledger);
}

function normalizeCustomer(customer: Customer): Customer {
  return {
    ...customer,
    customerType: customer.customerType ?? 'Retail',
    outstandingSilverFine: customer.outstandingSilverFine ?? 0,
  };
}

function normalizeInvoice(invoice: Invoice): Invoice {
  const fineWeightDue =
    invoice.fineWeightDue ??
    invoice.items.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled =
    invoice.fineWeightSettled ??
    Math.max(0, fineWeightDue - (invoice.fineWeightPending ?? fineWeightDue));
  return recalculateInvoice({
    ...invoice,
    saleType: invoice.saleType ?? 'Retail',
    amountDue: invoice.amountDue ?? invoice.grandTotal,
    fineWeightDue,
    fineWeightSettled,
    fineWeightPending: Math.max(0, fineWeightDue - fineWeightSettled),
  });
}

function recalculateInvoice(invoice: Invoice): Invoice {
  const amountReceived = invoice.payments.reduce((total, payment) => total + payment.amount, 0);
  const pendingAmount = Math.max(0, invoice.grandTotal - amountReceived);
  const fineWeightDue =
    invoice.fineWeightDue ??
    invoice.items.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled =
    invoice.fineWeightSettled ??
    Math.max(0, fineWeightDue - (invoice.fineWeightPending ?? fineWeightDue));
  const fineWeightPending = Math.max(0, fineWeightDue - fineWeightSettled);
  const status: Invoice['status'] =
    pendingAmount <= 0 && fineWeightPending <= 0
      ? 'Paid'
      : amountReceived > 0 || fineWeightSettled > 0
        ? 'Partial'
        : 'Pending';
  return {
    ...invoice,
    amountReceived,
    pendingAmount,
    fineWeightDue,
    fineWeightSettled,
    fineWeightPending,
    amountDue: invoice.amountDue ?? invoice.grandTotal,
    status,
  };
}

function recalculateCustomer(customerId: string) {
  const invoices = _invoices.filter(
    (invoice) => invoice.customerId === customerId && invoice.status !== 'Cancelled'
  );
  const totalPurchases = invoices.reduce((total, invoice) => total + invoice.grandTotal, 0);
  const outstandingSilverFine = invoices.reduce(
    (total, invoice) => total + (invoice.fineWeightPending ?? 0),
    0
  );
  const totalReceived = _ledger
    .filter((entry) => entry.customerId === customerId && entry.type === 'Payment')
    .reduce((total, entry) => total + entry.credit, 0);
  const lastPurchase =
    invoices
      .map((invoice) => invoice.date)
      .sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0] || '';

  _customers = _customers.map((customer) =>
    customer.id === customerId
      ? {
          ...customer,
          totalPurchases,
          totalReceived,
          outstanding: Math.max(0, totalPurchases - totalReceived),
          outstandingSilverFine,
          lastPurchase: lastPurchase || customer.lastPurchase,
        }
      : customer
  );
}

function recalculateLedgerBalances(customerId: string) {
  let balance = 0;
  let fineBalance = 0;
  _ledger = _ledger.map((entry) => {
    if (entry.customerId !== customerId) return entry;
    balance = balance + entry.debit - entry.credit;
    fineBalance = fineBalance + (entry.fineDebit ?? 0) - (entry.fineCredit ?? 0);
    return { ...entry, balance, fineBalance };
  });
}

// ── the money side made from memory (a real build) ───────────────────────────────

const NO_IMAGE = '/assets/images/no_image.png';
/** India has no daylight saving time: the business date (S5) of an instant is its UTC time plus five and a half hours. */
const INDIA_OFFSET_MS = 19_800_000;

const num = (text: string | null | undefined): number => {
  const n = Number(text);
  return Number.isFinite(n) ? n : 0;
};
/** The stamp as the millisecond ISO text the screens' `new Date(...)` reads everywhere; the exact text stays in the cache. */
const toIso = (stamp: string): string =>
  /^.{19}\.\d{6}Z$/.test(stamp) ? `${stamp.slice(0, 23)}Z` : stamp;
const microsOf = (stamp: string): number => {
  try {
    return stampMicros(stamp);
  } catch {
    return 0;
  }
};
/** A business date (YYYY-MM-DD) as an instant that `new Date(...)` and `.slice(0, 10)` read as the same day in any time zone. */
const businessNoon = (date: string): string => `${date}T12:00:00.000Z`;
const indiaDateOf = (micros: number): string =>
  new Date(Math.floor(micros / 1000) + INDIA_OFFSET_MS).toISOString().slice(0, 10);

const PAY_MODES: ReadonlySet<string> = new Set(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']);
const payModeOf = (mode: string | null): Payment['mode'] =>
  mode !== null && PAY_MODES.has(mode) ? (mode as Payment['mode']) : 'Other';

function groupBy<T>(rows: readonly T[], key: (row: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = groups.get(k);
    if (list) list.push(row);
    else groups.set(k, [row]);
  }
  return groups;
}

function customerFromRow(row: CustomerRow, balance: CustomerBalanceRow | undefined): Customer {
  // the figures are the row of V2 as the server worked them out; a customer whose row has not arrived shows zeros (nothing is made up)
  return {
    id: row.id,
    name: row.name,
    mobile: row.mobile ?? '',
    customerType: row.customer_type,
    email: row.email ?? '',
    address: row.address ?? '',
    gstNumber: row.gst_number ?? '',
    notes: row.notes ?? '',
    totalPurchases: num(balance?.total_purchases),
    totalReceived: num(balance?.received),
    outstanding: num(balance?.outstanding),
    outstandingSilverFine: num(balance?.fine_outstanding),
    lastPurchase: balance?.last_purchase ? businessNoon(balance.last_purchase) : '',
    createdAt: toIso(row.created_at),
  };
}

let customersView: { version: string; value: Customer[] } | null = null;

function currentCustomers(): Customer[] {
  const version = rowCache.versionOf('customers', 'customer-balances');
  if (customersView && customersView.version === version) return customersView.value;
  const made = rowCache
    .rows('customers')
    .filter((row) => row.archived_at === null)
    .map((row) => ({
      customer: customerFromRow(row, rowCache.get('customer-balances', row.id)),
      created: microsOf(row.created_at),
    }));
  // the newest first: the prototype put a new customer at the front of its list
  made.sort((a, b) => b.created - a.created || a.customer.id.localeCompare(b.customer.id));
  const value = made.map((m) => m.customer);
  customersView = { version, value };
  return value;
}

function itemFromRow(row: BillItemRow): InvoiceItem {
  return {
    id: row.id,
    designNumber: row.design_no,
    skuNumber: row.sku_no,
    material: row.material as Material,
    purity: row.purity as Purity,
    grossWeight: num(row.gross_weight),
    customerNetWeight: num(row.customer_net_weight),
    metalRate: num(row.metal_rate),
    labour: num(row.labour_amount),
    piroi: num(row.piroi),
    otherCharges: num(row.other_charges),
    metalAmount: num(row.metal_amount),
    fineWeightDue: num(row.fine_weight_due),
    itemTotal: num(row.item_total),
    quantity: row.quantity,
    sellingMethod: row.selling_method as SellingMethod,
    // photos are WEB06's: until then every line shows the placeholder image
    imageRef: NO_IMAGE,
    category: row.category,
    taxRate: num(row.tax_rate),
    taxAmount: num(row.tax_amount),
  };
}

/** The date of an invoice: the instant it was made when that is the business day it is dated, else noon of the day on the paper (a back-dated bill). */
function invoiceDate(bill: BillRow): string {
  const made = microsOf(bill.created_at);
  return made > 0 && indiaDateOf(made) === bill.bill_date
    ? toIso(bill.created_at)
    : businessNoon(bill.bill_date);
}

interface InvoiceView {
  /** Every bill, the opening-balance bills too: dues brought forward are still dues (C14). */
  all: Invoice[];
  /** The sales: every bill except an opening-balance one. This is `getInvoices()`. */
  sales: Invoice[];
  byKey: Map<string, Invoice>;
}
const INVOICE_RESOURCES = [
  'users',
  'customers',
  'bills',
  'bill-summary',
  'bill-items',
  'receipts',
  'receipt-allocations',
] as const;
let invoicesView: { version: string; value: InvoiceView } | null = null;

function buildInvoices(): InvoiceView {
  const people = new Map(rowCache.rows('users').map((u) => [u.id, u.full_name]));
  const customers = new Map(rowCache.rows('customers').map((c) => [c.id, c]));
  const itemsOf = groupBy(rowCache.rows('bill-items'), (i) => i.bill_id);
  const allocationsOf = groupBy(rowCache.rows('receipt-allocations'), (a) => a.bill_id);
  const receipts = new Map<string, ReceiptRow>(rowCache.rows('receipts').map((r) => [r.id, r]));

  const made: Array<{ invoice: Invoice; created: number; opening: boolean }> = [];
  for (const bill of rowCache.rows('bills')) {
    const summary = rowCache.get('bill-summary', bill.id);
    // the figures of a bill are the row of V1; until it has arrived the bill is not shown, rather than shown with a figure made up here
    if (!summary) continue;
    const customer = customers.get(bill.customer_id);
    const items = (itemsOf.get(bill.id) ?? [])
      .slice()
      .sort((a, b) => a.line_no - b.line_no)
      .map(itemFromRow);

    // a payment is a LIVE allocation of money to this bill: not released, and its receipt not voided (the same rule as V1)
    const paid: Array<{ payment: Payment; paidOn: string; created: number }> = [];
    for (const allocation of allocationsOf.get(bill.id) ?? []) {
      if (allocation.released_at !== null || num(allocation.amount) <= 0) continue;
      const receipt = receipts.get(allocation.receipt_id);
      if (!receipt || receipt.status !== 'active') continue;
      paid.push({
        payment: {
          id: receipt.id,
          mode: payModeOf(receipt.mode),
          amount: num(allocation.amount),
          date: businessNoon(receipt.paid_on),
          reference: receipt.reference ?? '',
          notes: receipt.notes ?? '',
        },
        paidOn: receipt.paid_on,
        created: microsOf(receipt.created_at),
      });
    }
    paid.sort(
      (a, b) =>
        a.paidOn.localeCompare(b.paidOn) ||
        a.created - b.created ||
        a.payment.id.localeCompare(b.payment.id)
    );

    const subtotal = num(bill.subtotal);
    const discount = num(bill.discount);
    const invoice: Invoice = {
      id: bill.id,
      invoiceNumber: bill.bill_no,
      customerId: bill.customer_id,
      customerName: customer?.name ?? '',
      customerMobile: customer?.mobile ?? '',
      items,
      payments: paid.map((p) => p.payment),
      subtotal,
      discount,
      // a percentage for the screens that print one; the bill has none of its own
      discountPercent: subtotal > 0 ? (discount / subtotal) * 100 : 0,
      additionalCharges: num(bill.additional_charges),
      gst: num(bill.gst_amount),
      gstPercent: num(bill.gst_percent),
      roundOff: num(bill.round_off),
      grandTotal: num(bill.grand_total),
      // the four derived figures of C1 are the row of V1, not added up from the lines and payments above
      amountReceived: num(summary.received),
      pendingAmount: num(summary.pending),
      status: summary.payment_status as Invoice['status'],
      saleType: bill.sale_type,
      fineWeightDue: num(summary.fine_due),
      fineWeightSettled: num(summary.fine_settled),
      fineWeightPending: num(summary.fine_pending),
      amountDue: num(bill.grand_total),
      date: invoiceDate(bill),
      createdBy: (bill.created_by && people.get(bill.created_by)) || '',
      notes: bill.notes ?? '',
    };
    const opening = bill.doc_type === 'opening_balance';
    // dues brought forward have no lines and are not a sale: the screens say so (WEB10)
    if (opening) invoice.openingBalance = true;
    made.push({ invoice, created: microsOf(bill.created_at), opening });
  }
  // the newest first: the prototype put a new invoice at the front of its list
  made.sort(
    (a, b) =>
      b.created - a.created || b.invoice.invoiceNumber.localeCompare(a.invoice.invoiceNumber)
  );
  const all = made.map((m) => m.invoice);
  const sales = made.filter((m) => !m.opening).map((m) => m.invoice);
  const byKey = new Map<string, Invoice>();
  for (const invoice of all) {
    byKey.set(invoice.id, invoice);
    if (!byKey.has(invoice.invoiceNumber)) byKey.set(invoice.invoiceNumber, invoice);
  }
  return { all, sales, byKey };
}

function currentInvoices(): InvoiceView {
  const version = rowCache.versionOf(...INVOICE_RESOURCES);
  if (invoicesView && invoicesView.version === version) return invoicesView.value;
  const value = buildInvoices();
  invoicesView = { version, value };
  return value;
}

/** The lists the reports and the dashboard read: the prototype's own in a preview, the cache's in a real build. */
const customerList = (): Customer[] => (PREVIEW_MODE ? _customers : currentCustomers());
const salesInvoices = (): Invoice[] => (PREVIEW_MODE ? _invoices : currentInvoices().sales);
/** The sales (V5): every bill that is neither an opening-balance bill nor cancelled. `salesInvoices()` keeps the cancelled ones (the estimate lists show them as Cancelled). */
const soldInvoices = (): Invoice[] => salesInvoices().filter((inv) => inv.status !== 'Cancelled');

// the ledger of V3: one row per event of a customer, with the server's running balances. V3's `id` is the id of the bill or receipt, so the invoice and the cancellation of one
// bill share it: the entry's own id is the rank of the event and that id.
const LEDGER_TYPE: Readonly<Record<string, LedgerEntry['type']>> = {
  Invoice: 'Invoice',
  Opening: 'Invoice', // dues brought forward are a debit of the same kind
  Cancellation: 'Return',
  Payment: 'Payment',
  'Opening advance': 'Payment',
  Fine: 'Payment',
  Refund: 'Adjustment',
  Void: 'Adjustment',
};
const LEDGER_KINDS: ReadonlySet<string> = new Set<LedgerKind>([
  'Invoice',
  'Opening',
  'Cancellation',
  'Payment',
  'Opening advance',
  'Fine',
  'Refund',
  'Void',
]);
const EMPTY_LEDGER: LedgerEntry[] = [];
const ledgerMemo = new Map<
  string,
  { rows: readonly LedgerWireRow[]; version: string; entries: LedgerEntry[] }
>();

function ledgerEntryOf(row: LedgerWireRow): LedgerEntry {
  const onBill = row.kind_rank === 1 || row.kind_rank === 2;
  let reference = '';
  let silverRate: number | undefined;
  if (onBill) {
    reference = rowCache.get('bills', row.id)?.bill_no ?? '';
  } else {
    const receipt = rowCache.get('receipts', row.id);
    reference = receipt?.reference ?? '';
    if (receipt?.silver_rate != null) silverRate = num(receipt.silver_rate);
  }
  return {
    id: `${row.kind_rank}:${row.id}`,
    customerId: row.customer_id,
    date: businessNoon(row.entry_date),
    type: LEDGER_TYPE[row.kind] ?? 'Adjustment',
    // the kind V3 gave the row; the ledger table names the row by it (a kind this build does not know keeps the type above)
    ...(LEDGER_KINDS.has(row.kind) ? { kind: row.kind as LedgerKind } : {}),
    description: row.description,
    debit: num(row.debit),
    credit: num(row.credit),
    balance: num(row.balance),
    fineDebit: num(row.fine_debit),
    fineCredit: num(row.fine_credit),
    fineBalance: num(row.fine_balance),
    reference,
    ...(silverRate !== undefined ? { silverRate } : {}),
    ...(onBill ? { invoiceId: row.id } : { paymentId: row.id }),
  };
}

function ledgerOfCustomer(customerId: string): LedgerEntry[] {
  const rows = moneyServer.ledgerRows(customerId);
  if (rows.length === 0) {
    ledgerMemo.delete(customerId);
    return EMPTY_LEDGER;
  }
  const version = rowCache.versionOf('bills', 'receipts');
  const memo = ledgerMemo.get(customerId);
  if (memo && memo.rows === rows && memo.version === version) return memo.entries;
  const entries = rows.map(ledgerEntryOf);
  ledgerMemo.set(customerId, { rows, version, entries });
  return entries;
}

/** A real build cannot save a money change yet (X6 apart): say so, change nothing. A preview changes its own sample data. */
function assertWritable(what: string): void {
  if (!PREVIEW_MODE) throw savingNotAvailable(what);
}

// ── Customer Store ────────────────────────────────────────────────────────────

let _customers: Customer[] = readStored(CUSTOMER_KEY, [...MOCK_CUSTOMERS]).map(normalizeCustomer);
let _customerSeq = 1;

export function getCustomers(): Customer[] {
  return customerList();
}

type NewCustomer = Omit<
  Customer,
  | 'id'
  | 'createdAt'
  | 'customerType'
  | 'totalPurchases'
  | 'totalReceived'
  | 'outstanding'
  | 'outstandingSilverFine'
  | 'lastPurchase'
> & { customerType?: CustomerType };

/**
 * Saves a new customer: X6 with a fresh Idempotency-Key, the returned row merged into memory (its id and stamps are the server's, C11). Resolves with the customer; rejects with the
 * client's error, whose message says plainly what happened. Pressing Save again for the same customer after a call that did not end well sends the same key, and a double click is
 * one request, so a customer is made once (C6, L5). A preview builds the prototype's own local customer.
 */
export async function addCustomer(data: NewCustomer): Promise<Customer> {
  if (PREVIEW_MODE) return addCustomerLocal(data);
  const row = await moneyServer.createCustomer({
    name: data.name,
    mobile: data.mobile,
    customer_type: data.customerType,
    email: data.email,
    address: data.address,
    gst_number: data.gstNumber,
    notes: data.notes,
  });
  return customerFromRow(row, rowCache.get('customer-balances', row.id));
}

/**
 * Saves a bill: X1 `POST /v1/bills` with a fresh Idempotency-Key (C5 (b), C6, L5). Nothing is put in memory before the server has answered; then the rows it returned are. Pressing Save
 * again for the same bill after a call that did not end well sends the same key, and a double click is one request, so a bill is made once. Resolves with the whole answer; rejects
 * with the client's error (`code`, `details`, a `message` in plain words). A preview build has no server: its screen saves the prototype's own invoice.
 */
export function saveBill(body: BillBody): Promise<CreateBillResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A bill'));
  return moneyServer.createBill(body);
}

/** The person started over (a new sale, a discard): the next bill gets a key of its own. */
export function forgetBillTry(): void {
  if (!PREVIEW_MODE) moneyServer.forgetBill();
}

/**
 * Z3: the PAN a customer gave when a bill asked for it. An ordinary edit of a content column (A5): the customer's row is held, shown at once, and replaced by the row the server
 * returns. A bill touches its customer (D23), so the stamp in memory can be the one from before the bill; a stale answer brings the current row, and the same PAN is sent once more
 * on it (only this one field is written, so nothing the other person changed is undone). Throws a SaveError whose `message` is the plain text.
 */
export async function saveCustomerPan(customerId: string, pan: string): Promise<void> {
  if (PREVIEW_MODE) return;
  const edit = () => editRow({ resource: 'customers', id: customerId, changes: { pan } });
  try {
    await edit();
  } catch (error) {
    if (error instanceof SaveError && error.stale) await edit();
    else throw error;
  }
}

/**
 * Receives a payment: X2 `POST /v1/customers/{id}/payments` with a fresh Idempotency-Key (C5 (b), C6, L5). Nothing is put in memory before the server has answered; then the receipt and
 * the allocations it returned are, and the poll that follows the write brings the customer's V1 and V2 figures (C17). Pressing Save again for the same payment after a call that did not
 * end well sends the same key, and a double click is one request, so a payment is made once. Resolves with the whole answer (`advance_remaining` is what is left of THIS payment);
 * rejects with the client's error (`code`, `details`, a `message` in plain words). A preview build has no server: its panel saves the prototype's own payment.
 */
export function savePayment(
  customerId: string,
  body: RecordPaymentBody
): Promise<RecordPaymentResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A payment'));
  return moneyServer.recordPayment(customerId, body);
}

/** Settles silver fine: X3 `POST /v1/customers/{id}/fine-settlements`, in silver or in cash at a rate, with the same rules as `savePayment` (`fine_remaining` is the customer's fine after the call). */
export function saveFineSettlement(
  customerId: string,
  body: SettleFineBody
): Promise<SettleFineResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A silver settlement'));
  return moneyServer.settleFine(customerId, body);
}

/** The payment panel was closed: the next payment or settlement gets a key of its own, even when it is the same as one that could not be confirmed. */
export function forgetPaymentTries(): void {
  if (!PREVIEW_MODE) moneyServer.forgetPaymentTries();
}

// ── The owner's actions (WEB11) ───────────────────────────────────────────────

/**
 * Cancels a bill: X5 `POST /v1/bills/{id}/cancel` with a reason of 3 to 500 characters. The rules of `savePayment` hold: a key for each action, a double click is one request, pressing the
 * button again after a call that did not end well sends the same key, nothing is put in memory before the server has answered, and then the bill, the pieces back in stock and the allocation
 * rows of the cancel and of the rebalance are. A preview build has no server.
 */
export function saveCancel(
  customerId: string,
  billId: string,
  body: ReasonBody
): Promise<CancelBillResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A cancellation'));
  return moneyServer.cancelBill(customerId, billId, body);
}

/** Voids a receipt: X4 `POST /v1/receipts/{id}/void` with a reason. The receipt is never deleted (S7): it stays, tagged Voided, and the bills it paid owe that money again. */
export function saveVoid(
  customerId: string,
  receiptId: string,
  body: ReasonBody
): Promise<VoidReceiptResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A void'));
  return moneyServer.voidReceipt(customerId, receiptId, body);
}

/** Re-issues a bill: X10 `POST /v1/bills/{id}/reissue` with the corrected bill (no customer) and the reason. The old bill is cancelled and the money it had received moves to the new one. */
export function saveReissue(
  customerId: string,
  billId: string,
  body: ReissueBody
): Promise<ReissueBillResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A re-issue'));
  return moneyServer.reissueBill(customerId, billId, body);
}

/** Hands money back out of the customer's advance: X11 `POST /v1/customers/{id}/refunds`. */
export function saveRefund(customerId: string, body: RefundBody): Promise<IssueRefundResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('A refund'));
  return moneyServer.issueRefund(customerId, body);
}

/** Adds what a customer owed or had paid on the first day: X12 `POST /v1/customers/{id}/opening-balance`. */
export function saveOpeningBalance(
  customerId: string,
  body: OpeningBody
): Promise<OpeningBalanceResponse> {
  if (PREVIEW_MODE) return Promise.reject(savingNotAvailable('An opening balance'));
  return moneyServer.addOpeningBalance(customerId, body);
}

/** A dialog of the owner was closed: the next action gets a key of its own, even when it is the same as one that could not be confirmed. */
export function forgetOwnerTries(): void {
  if (!PREVIEW_MODE) moneyServer.forgetOwnerTries();
}

export interface BillRef {
  id: string;
  billNo: string;
}

/** What the screens need to know about a bill beyond its figures: whether it can still be cancelled or re-issued, why it was cancelled, and which bill replaced it or it replaces (K6). */
export interface BillFacts {
  id: string;
  billNo: string;
  customerId: string;
  status: 'active' | 'cancelled';
  /** 'estimate', or 'opening_balance' for dues brought forward. */
  docType: string;
  cancelReason: string | null;
  /** The business day it was cancelled on (a date), or null. */
  cancelledOn: string | null;
  /** The bill this one replaces, when it is a re-issue. */
  reissueOf: BillRef | null;
  /** The bill that replaced this one, when it was re-issued. */
  reissuedAs: BillRef | null;
}

/** The facts of a bill, from the bill's own row (a cancel or a re-issue shows here as soon as the answer is merged). Null in a preview build and while the row has not arrived. */
export function getBillFacts(billId: string): BillFacts | null {
  if (PREVIEW_MODE) return null;
  const bill = rowCache.get('bills', billId);
  if (!bill) return null;
  const refOf = (row: BillRow | undefined): BillRef | null =>
    row ? { id: row.id, billNo: row.bill_no } : null;
  return {
    id: bill.id,
    billNo: bill.bill_no,
    customerId: bill.customer_id,
    status: bill.status,
    docType: bill.doc_type,
    cancelReason: bill.cancel_reason,
    cancelledOn: bill.cancelled_on,
    reissueOf: bill.reissue_of ? refOf(rowCache.get('bills', bill.reissue_of)) : null,
    reissuedAs: refOf(rowCache.rows('bills').find((row) => row.reissue_of === bill.id)),
  };
}

/** The bill and its lines exactly as saved (text of money and weight), for the billing screen to start a corrected bill from. Null in a preview build and while the rows have not arrived. */
export function getBillSource(billId: string): { bill: BillRow; lines: BillItemRow[] } | null {
  if (PREVIEW_MODE) return null;
  const bill = rowCache.get('bills', billId);
  if (!bill) return null;
  const lines = rowCache
    .rows('bill-items')
    .filter((row) => row.bill_id === billId)
    .sort((a, b) => a.line_no - b.line_no);
  return { bill, lines };
}

export interface ReceiptFacts {
  id: string;
  customerId: string;
  /** 'money', 'refund', 'fine_cash' or 'fine_silver'. */
  kind: string;
  status: 'active' | 'voided';
  voidReason: string | null;
  voidedOn: string | null;
}

/** The facts of a receipt from its own row (a void shows here as soon as the answer is merged). Null in a preview build and while the row has not arrived. */
export function getReceiptFacts(receiptId: string): ReceiptFacts | null {
  if (PREVIEW_MODE) return null;
  const receipt = rowCache.get('receipts', receiptId);
  if (!receipt) return null;
  return {
    id: receipt.id,
    customerId: receipt.customer_id,
    kind: receipt.kind,
    status: receipt.status,
    voidReason: receipt.void_reason,
    voidedOn: receipt.voided_on,
  };
}

/**
 * The bills a payment or a fine settlement can name (Y3), oldest first (bill date, then the time it was made): EVERY bill of the customer, the opening-balance bill (dues brought
 * forward) and the cancelled one included, with the figures of V1; the panel keeps those with something pending. Unlike `getInvoices()` this is not the list of sales.
 */
export function getBillsOfCustomer(customerId: string): Invoice[] {
  if (PREVIEW_MODE)
    return _invoices
      .filter((invoice) => invoice.customerId === customerId)
      .sort((a, b) => a.date.localeCompare(b.date));
  const order = (invoice: Invoice) => {
    const row = rowCache.get('bills', invoice.id);
    return { date: row?.bill_date ?? '', made: microsOf(row?.created_at ?? ''), id: invoice.id };
  };
  return currentInvoices()
    .all.filter((invoice) => invoice.customerId === customerId)
    .map((invoice) => ({ invoice, key: order(invoice) }))
    .sort(
      (a, b) =>
        a.key.date.localeCompare(b.key.date) ||
        a.key.made - b.key.made ||
        a.key.id.localeCompare(b.key.id)
    )
    .map((entry) => entry.invoice);
}

export interface CustomerBooks {
  /** V2 `outstanding`, the exact text of the row. */
  outstanding: string;
  /** V2 `advance`: money received that no bill needed. */
  advance: string;
  /** V2 `balance`, signed: `outstanding - advance`, and the last running balance of the customer's ledger (I4). */
  balance: string;
  /** V2 `fine_outstanding`, grams. */
  fineOutstanding: string;
  /** V2 `fine_balance`, grams, signed: the last running silver balance of the ledger. */
  fineBalance: string;
}

/** The customer's V2 figures as the server worked them out, or null while the row has not arrived (nothing is made up). A preview build has none. */
export function getCustomerBooks(customerId: string): CustomerBooks | null {
  if (PREVIEW_MODE) return null;
  const row = rowCache.get('customer-balances', customerId);
  return row
    ? {
        outstanding: row.outstanding,
        advance: row.advance,
        balance: row.balance,
        fineOutstanding: row.fine_outstanding,
        fineBalance: row.fine_balance,
      }
    : null;
}

/** The number of a bill (an answer names bills by id), or null when it is not in memory. */
export function billNumberOf(billId: string): string | null {
  if (PREVIEW_MODE)
    return _invoices.find((invoice) => invoice.id === billId)?.invoiceNumber ?? null;
  return rowCache.get('bills', billId)?.bill_no ?? null;
}

function addCustomerLocal(data: NewCustomer): Customer {
  const customer: Customer = {
    ...data,
    customerType: data.customerType ?? 'Retail',
    id: `cust-${Date.now()}-${_customerSeq++}`,
    createdAt: new Date().toISOString(),
    totalPurchases: 0,
    totalReceived: 0,
    outstanding: 0,
    outstandingSilverFine: 0,
    lastPurchase: new Date().toISOString(),
  };
  _customers = [customer, ..._customers];
  persistAppStore();
  return customer;
}

export function updateCustomer(id: string, updates: Partial<Customer>): void {
  assertWritable('A change to a customer');
  _customers = _customers.map((c) => (c.id === id ? { ...c, ...updates } : c));
  persistAppStore();
}

export function removeCustomer(id: string): void {
  assertWritable('Removing a customer');
  _customers = _customers.filter((c) => c.id !== id);
  _invoices = _invoices.filter((invoice) => invoice.customerId !== id);
  _ledger = _ledger.filter((entry) => entry.customerId !== id);
  persistAppStore();
}

// ── Invoice Store ─────────────────────────────────────────────────────────────

let _invoices: Invoice[] = readStored(INVOICE_KEY, [...MOCK_INVOICES]).map(normalizeInvoice);
let _invoiceSeq = _invoices.length + 1;

/** The sales, in the prototype's `Invoice` shape. An opening-balance bill is dues brought forward, not a sale (C14): it is in the ledger, in the customer's dues and in `getInvoiceById`. */
export function getInvoices(): Invoice[] {
  return salesInvoices();
}

/** The bills that count as sales: not cancelled and not dues brought forward (V5, C14). For the lists of what was sold. */
export function getSoldInvoices(): Invoice[] {
  return soldInvoices();
}

export function getInvoiceById(id: string): Invoice | undefined {
  if (PREVIEW_MODE)
    return _invoices.find((invoice) => invoice.id === id || invoice.invoiceNumber === id);
  return currentInvoices().byKey.get(id);
}

export function getNextInvoiceNumber(): string {
  // the number is the server's, given when the bill is saved; the cache never makes one up (C11)
  if (!PREVIEW_MODE) return 'Number assigned when saved';
  const year = new Date().getFullYear();
  const seq = String(_invoiceSeq).padStart(4, '0');
  const prefix = getSettings().estimate.prefix || 'JV';
  return `${prefix}-${year}-${seq}`;
}

export function addInvoice(invoice: Invoice): void {
  assertWritable('A new bill');
  if (_invoices.some((inv) => inv.invoiceNumber === invoice.invoiceNumber)) {
    throw new Error(`Invoice number already exists: ${invoice.invoiceNumber}`);
  }
  const normalizedInvoice = recalculateInvoice(invoice);
  _invoices = [normalizedInvoice, ..._invoices];
  _invoiceSeq++;

  // Update customer stats
  const customer = _customers.find((c) => c.id === normalizedInvoice.customerId);
  if (customer) {
    const received = normalizedInvoice.payments.reduce((a, p) => a + p.amount, 0);
    updateCustomer(normalizedInvoice.customerId, {
      totalPurchases: customer.totalPurchases + normalizedInvoice.grandTotal,
      totalReceived: customer.totalReceived + received,
      outstanding: customer.outstanding + normalizedInvoice.pendingAmount,
      outstandingSilverFine:
        (customer.outstandingSilverFine ?? 0) + (normalizedInvoice.fineWeightPending ?? 0),
      lastPurchase: normalizedInvoice.date,
    });
  }

  // Add ledger entry for invoice
  addLedgerEntry({
    customerId: normalizedInvoice.customerId,
    date: normalizedInvoice.date,
    type: 'Invoice',
    description: `Invoice ${normalizedInvoice.invoiceNumber} - ${normalizedInvoice.items.length} item(s)`,
    debit: normalizedInvoice.grandTotal,
    credit: 0,
    fineDebit: normalizedInvoice.fineWeightDue ?? 0,
    reference: normalizedInvoice.invoiceNumber,
    invoiceId: normalizedInvoice.id,
  });

  // Add ledger entries for payments
  for (const pmt of normalizedInvoice.payments) {
    if (pmt.amount > 0) {
      addLedgerEntry({
        customerId: normalizedInvoice.customerId,
        date: normalizedInvoice.date,
        type: 'Payment',
        description: `Payment via ${pmt.mode} against ${normalizedInvoice.invoiceNumber}`,
        debit: 0,
        credit: pmt.amount,
        reference: pmt.reference || normalizedInvoice.invoiceNumber,
        paymentId: pmt.id,
        invoiceId: normalizedInvoice.id,
      });
    }
  }

  recalculateCustomer(normalizedInvoice.customerId);
  persistAppStore();
}

export function updateInvoiceDate(invoiceId: string, date: string): void {
  assertWritable('A change of date');
  const normalizedDate = date
    ? new Date(`${date}T12:00:00`).toISOString()
    : new Date().toISOString();
  const invoice = getInvoiceById(invoiceId);
  if (!invoice) throw new Error('Estimate not found.');

  _invoices = _invoices.map((inv) =>
    inv.id === invoice.id ? { ...inv, date: normalizedDate } : inv
  );
  _ledger = _ledger.map((entry) =>
    entry.invoiceId === invoice.id || entry.reference === invoice.invoiceNumber
      ? { ...entry, date: normalizedDate }
      : entry
  );
  recalculateLedgerBalances(invoice.customerId);
  recalculateCustomer(invoice.customerId);
  persistAppStore();
}

export function updateInvoice(invoiceId: string, updates: Partial<Invoice>): Invoice {
  assertWritable('A change to a bill');
  const current = getInvoiceById(invoiceId);
  if (!current) throw new Error('Estimate not found.');

  const mergedItems = (updates.items ?? current.items).map((item) => {
    const metalAmount = Number(item.metalAmount) || 0;
    const labour = Number(item.labour) || 0;
    const piroi = Number(item.piroi) || 0;
    const otherCharges = Number(item.otherCharges) || 0;
    return {
      ...item,
      grossWeight: Number(item.grossWeight) || 0,
      customerNetWeight: Number(item.customerNetWeight) || 0,
      metalRate: Number(item.metalRate) || 0,
      labour,
      piroi,
      otherCharges,
      metalAmount,
      fineWeightDue: Number(item.fineWeightDue) || 0,
      itemTotal: metalAmount + labour + piroi + otherCharges,
      taxRate: 0,
      taxAmount: 0,
    };
  });

  const subtotal = mergedItems.reduce((total, item) => total + item.itemTotal, 0);
  const discount = Number(updates.discount ?? current.discount) || 0;
  const additionalCharges = Number(updates.additionalCharges ?? current.additionalCharges) || 0;
  const beforeRoundOff = Math.max(0, subtotal - discount + additionalCharges);
  const roundOff = getSettings().estimate.roundOff
    ? Math.round(beforeRoundOff) - beforeRoundOff
    : 0;
  const fineWeightDue = mergedItems.reduce((total, item) => total + (item.fineWeightDue ?? 0), 0);
  const fineWeightSettled = Math.min(current.fineWeightSettled ?? 0, fineWeightDue);
  const normalized = recalculateInvoice({
    ...current,
    ...updates,
    items: mergedItems,
    subtotal,
    discount,
    discountPercent: subtotal > 0 ? (discount / subtotal) * 100 : 0,
    additionalCharges,
    gst: 0,
    gstPercent: 0,
    roundOff,
    grandTotal: Math.round(beforeRoundOff + roundOff),
    fineWeightDue,
    fineWeightSettled,
    fineWeightPending: Math.max(0, fineWeightDue - fineWeightSettled),
    amountDue: Math.round(beforeRoundOff + roundOff),
  });

  _invoices = _invoices.map((invoice) => (invoice.id === current.id ? normalized : invoice));
  _ledger = _ledger.filter(
    (entry) => entry.invoiceId !== current.id && entry.reference !== current.invoiceNumber
  );

  addLedgerEntry({
    customerId: normalized.customerId,
    date: normalized.date,
    type: 'Invoice',
    description: `Invoice ${normalized.invoiceNumber} - ${normalized.items.length} item(s)`,
    debit: normalized.grandTotal,
    credit: 0,
    fineDebit: normalized.fineWeightDue ?? 0,
    reference: normalized.invoiceNumber,
    invoiceId: normalized.id,
  });

  for (const pmt of normalized.payments) {
    if (pmt.amount > 0) {
      addLedgerEntry({
        customerId: normalized.customerId,
        date: pmt.date,
        type: 'Payment',
        description: `Payment via ${pmt.mode} against ${normalized.invoiceNumber}`,
        debit: 0,
        credit: pmt.amount,
        reference: pmt.reference || normalized.invoiceNumber,
        paymentId: pmt.id,
        invoiceId: normalized.id,
      });
    }
  }

  recalculateLedgerBalances(current.customerId);
  if (normalized.customerId !== current.customerId)
    recalculateLedgerBalances(normalized.customerId);
  recalculateCustomer(current.customerId);
  if (normalized.customerId !== current.customerId) recalculateCustomer(normalized.customerId);
  persistAppStore();
  return normalized;
}

// ── Ledger Store ──────────────────────────────────────────────────────────────

let _ledger: LedgerEntry[] = readStored(LEDGER_KEY, [...MOCK_LEDGER]);
let _ledgerSeq = 1;

/** The entries of the ledgers that have been loaded (a real build loads one customer's ledger when the customer card opens). */
export function getLedger(): LedgerEntry[] {
  if (PREVIEW_MODE) return _ledger;
  return moneyServer.loadedLedgers().flatMap(ledgerOfCustomer);
}

/** The ledger of one customer, from memory. Empty until `watchCustomerLedger` / `loadLedgerForCustomer` has read it. */
export function getLedgerForCustomer(customerId: string): LedgerEntry[] {
  if (PREVIEW_MODE) return _ledger.filter((e) => e.customerId === customerId);
  return ledgerOfCustomer(customerId);
}

/** The customer card is open: read the customer's ledger and read it again whenever the customer's `updated_at` changes (C3). Returns the way to stop. */
export function watchCustomerLedger(customerId: string): () => void {
  return PREVIEW_MODE ? () => undefined : moneyServer.watchLedger(customerId);
}

/** Reads the customer's ledger now (the "Try again" of a ledger that could not be loaded). Never rejects: see `getLedgerStatus`. */
export function loadLedgerForCustomer(customerId: string): Promise<void> {
  return PREVIEW_MODE ? Promise.resolve() : moneyServer.loadLedger(customerId);
}

export function getLedgerStatus(customerId: string): {
  state: LedgerLoadState;
  message: string | null;
} {
  return PREVIEW_MODE ? { state: 'ready', message: null } : moneyServer.ledgerState(customerId);
}

export function addLedgerEntry(entry: Omit<LedgerEntry, 'id' | 'balance' | 'fineBalance'>): void {
  assertWritable('A ledger entry');
  // Compute running balance for this customer
  const existing = _ledger.filter((e) => e.customerId === entry.customerId);
  const prevBalance = existing.length > 0 ? existing[existing.length - 1].balance : 0;
  const prevFineBalance =
    existing.length > 0 ? (existing[existing.length - 1].fineBalance ?? 0) : 0;
  const balance = prevBalance + entry.debit - entry.credit;
  const fineBalance = prevFineBalance + (entry.fineDebit ?? 0) - (entry.fineCredit ?? 0);

  const newEntry: LedgerEntry = {
    ...entry,
    id: `ledger-${Date.now()}-${_ledgerSeq++}`,
    balance,
    fineBalance,
  };
  _ledger = [..._ledger, newEntry];
  persistAppStore();
}

// ── Payment Recording ─────────────────────────────────────────────────────────

export function recordPayment(
  customerId: string,
  payment: Omit<Payment, 'id'>,
  invoiceId?: string
): void {
  assertWritable('A payment');
  const pmt: Payment = {
    ...payment,
    id: `pmt-${Date.now()}`,
  };

  // Update invoice if specified
  if (invoiceId) {
    _invoices = _invoices.map((inv) => {
      if (inv.id !== invoiceId) return inv;
      const newReceived = inv.amountReceived + pmt.amount;
      const newPending = Math.max(0, inv.grandTotal - newReceived);
      const newStatus: Invoice['status'] =
        newPending <= 0 ? 'Paid' : newReceived > 0 ? 'Partial' : 'Pending';
      return {
        ...inv,
        payments: [...inv.payments, pmt],
        amountReceived: newReceived,
        pendingAmount: newPending,
        status: newStatus,
      };
    });
  }

  // Update customer outstanding
  const customer = _customers.find((c) => c.id === customerId);
  if (customer) {
    updateCustomer(customerId, {
      totalReceived: customer.totalReceived + pmt.amount,
      outstanding: Math.max(0, customer.outstanding - pmt.amount),
    });
  }

  // Add ledger entry
  addLedgerEntry({
    customerId,
    date: pmt.date,
    type: 'Payment',
    description: `Payment received via ${pmt.mode}${pmt.notes ? ' — ' + pmt.notes : ''}`,
    debit: 0,
    credit: pmt.amount,
    reference: pmt.reference || '',
    paymentId: pmt.id,
    invoiceId,
  });

  persistAppStore();
}

export function settleSilverFine(
  customerId: string,
  grams: number,
  mode: 'Silver' | 'Cash',
  silverRate?: number,
  invoiceId?: string
): void {
  assertWritable('A silver settlement');
  const fineCredit = Math.max(0, Number(grams) || 0);
  if (fineCredit <= 0) throw new Error('Fine grams must be greater than 0.');
  if (mode === 'Cash' && (!silverRate || silverRate <= 0))
    throw new Error('Silver rate is required for cash fine settlement.');

  let remaining = fineCredit;
  const eligible = [..._invoices]
    .filter(
      (invoice) =>
        invoice.customerId === customerId &&
        invoice.status !== 'Cancelled' &&
        (invoice.fineWeightPending ?? 0) > 0
    )
    .sort((a, b) => {
      if (invoiceId && a.id === invoiceId) return -1;
      if (invoiceId && b.id === invoiceId) return 1;
      return new Date(a.date).getTime() - new Date(b.date).getTime();
    });

  if (eligible.length === 0) throw new Error('No silver fine is pending for this customer.');

  for (const invoice of eligible) {
    if (remaining <= 0) break;
    const pendingFine = invoice.fineWeightPending ?? 0;
    const applied = Math.min(pendingFine, remaining);
    remaining -= applied;
    _invoices = _invoices.map((inv) =>
      inv.id === invoice.id
        ? recalculateInvoice({
            ...inv,
            fineWeightSettled: (inv.fineWeightSettled ?? 0) + applied,
            fineWeightPending: Math.max(0, (inv.fineWeightPending ?? 0) - applied),
          })
        : inv
    );
  }

  const settled = fineCredit - remaining;
  if (settled <= 0) throw new Error('Unable to apply silver fine settlement.');
  const amountEquivalent = mode === 'Cash' ? settled * (silverRate ?? 0) : 0;

  addLedgerEntry({
    customerId,
    date: new Date().toISOString(),
    type: 'Payment',
    description:
      mode === 'Cash'
        ? `Silver fine settled by cash - ${settled.toFixed(3)} g @ ₹${Number(silverRate).toLocaleString('en-IN')}/g`
        : `Silver fine received - ${settled.toFixed(3)} g`,
    debit: 0,
    credit: 0,
    fineCredit: settled,
    silverRate: mode === 'Cash' ? silverRate : undefined,
    reference:
      mode === 'Cash'
        ? `Fine cash equivalent ₹${Math.round(amountEquivalent).toLocaleString('en-IN')}`
        : 'Silver fine received',
    invoiceId,
  });

  recalculateLedgerBalances(customerId);
  recalculateCustomer(customerId);
  persistAppStore();
}

export function deleteRecordedPayment(ledgerEntryId: string): void {
  assertWritable('Deleting a payment');
  const entry = _ledger.find((item) => item.id === ledgerEntryId && item.type === 'Payment');
  if (!entry) throw new Error('Payment entry not found.');

  if ((entry.fineCredit ?? 0) > 0) {
    let remaining = entry.fineCredit ?? 0;
    const affected = [..._invoices]
      .filter(
        (invoice) =>
          invoice.customerId === entry.customerId &&
          (entry.invoiceId ? invoice.id === entry.invoiceId : (invoice.fineWeightDue ?? 0) > 0)
      )
      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

    for (const invoice of affected) {
      if (remaining <= 0) break;
      const pending = invoice.fineWeightPending ?? 0;
      const due = invoice.fineWeightDue ?? 0;
      const canRestore = Math.max(0, due - pending);
      const restored = Math.min(canRestore, remaining);
      remaining -= restored;
      _invoices = _invoices.map((inv) =>
        inv.id === invoice.id
          ? recalculateInvoice({
              ...inv,
              fineWeightSettled: Math.max(0, (inv.fineWeightSettled ?? 0) - restored),
              fineWeightPending: pending + restored,
            })
          : inv
      );
    }
  }

  _invoices = _invoices.map((invoice) => {
    if (entry.invoiceId && invoice.id !== entry.invoiceId) return invoice;

    let removed = false;
    const payments = invoice.payments.filter((payment) => {
      const exactMatch = entry.paymentId && payment.id === entry.paymentId;
      const fallbackMatch =
        !entry.paymentId &&
        invoice.customerId === entry.customerId &&
        payment.amount === entry.credit &&
        payment.reference === entry.reference &&
        Math.abs(new Date(payment.date).getTime() - new Date(entry.date).getTime()) < 2000;

      if (!removed && (exactMatch || fallbackMatch)) {
        removed = true;
        return false;
      }
      return true;
    });

    return payments.length !== invoice.payments.length
      ? recalculateInvoice({ ...invoice, payments })
      : invoice;
  });

  _ledger = _ledger.filter((item) => item.id !== ledgerEntryId);
  recalculateLedgerBalances(entry.customerId);
  recalculateCustomer(entry.customerId);
  persistAppStore();
}

// ── The figures: one set of selectors over V1, V2 and V4 (WEB12; spec C14, V5) ──────────────────────────────

// The dashboard, the reports and the customer card take their figures from `src/lib/selectors.ts` over the derived reads, so on the same data they cannot disagree:
//   V1 bill_summary (the `bill-summary` rows in memory), V2 customer_balances (`customer-balances`), the lines of the bills (`bill-items`) and V4 daily_totals (the cash book,
//   read from the API by src/lib/cache/booksServer.ts because it is not a sync resource). Sales are active bills that are not opening-balance bills; a cancelled bill is on its own line;
//   an opening-balance bill is no sale but is still owed. Money is whole paise from the selectors up to the screen; `ledgerView.ts` writes it.
// A preview build has no server: the same selectors run over rows made from the prototype's sample data (the `preview*` functions below, the only place the prototype's numbers are
// turned into rows: they are rounded to the paise because the prototype added up floats).

import { getDesigns } from './designStore';

const previewRupees = (n: number): string => (Number.isFinite(n) ? n.toFixed(2) : '0.00');
const previewGrams = (n: number): string => (Number.isFinite(n) ? n.toFixed(3) : '0.000');
const previewDay = (stamp: string): string => {
  const ms = Date.parse(stamp);
  return Number.isNaN(ms) ? stamp.slice(0, 10) : businessDateOf(ms);
};

function previewBillRows(): SelectorBillRow[] {
  return _invoices.map((invoice) => {
    const cancelled = invoice.status === 'Cancelled';
    return {
      id: invoice.id,
      billNo: invoice.invoiceNumber,
      customerId: invoice.customerId,
      billDate: previewDay(invoice.date),
      docType: invoice.openingBalance ? 'opening_balance' : 'estimate',
      status: cancelled ? 'cancelled' : 'active',
      grandTotal: previewRupees(invoice.grandTotal),
      pending: cancelled ? '0.00' : previewRupees(invoice.pendingAmount),
      finePending: cancelled ? '0.000' : previewGrams(invoice.fineWeightPending ?? 0),
    };
  });
}

function previewBalanceRow(customer: Customer): SelectorBalanceRow {
  const fine = previewGrams(customer.outstandingSilverFine ?? 0);
  return {
    id: customer.id,
    totalPurchases: previewRupees(customer.totalPurchases),
    received: previewRupees(customer.totalReceived),
    outstanding: previewRupees(customer.outstanding),
    advance: '0.00',
    balance: previewRupees(customer.outstanding),
    fineOutstanding: fine,
    fineAdvance: '0.000',
    fineBalance: fine,
    lastPurchase: customer.lastPurchase ? previewDay(customer.lastPurchase) : null,
  };
}

function previewLineRows(): SoldLine[] {
  return _invoices.flatMap((invoice) =>
    invoice.items.map((item) => ({
      billId: invoice.id,
      category: item.category,
      material: item.material,
      quantity: 1,
      itemTotal: previewRupees(item.itemTotal),
    }))
  );
}

/** The prototype's payments as a cash book: money in on the day of each payment, by mode. */
function previewDailyTotals(from: string, to: string): DailyTotalsView {
  const sums = new Map<string, { date: string; mode: string; cents: number }>();
  for (const invoice of _invoices) {
    for (const payment of invoice.payments) {
      const date = previewDay(payment.date);
      if (date < from || date > to) continue;
      const key = `${date}|${payment.mode}`;
      const sum = sums.get(key) ?? { date, mode: payment.mode, cents: 0 };
      sum.cents += Math.round(payment.amount * 100);
      sums.set(key, sum);
    }
  }
  const text = (cents: number) => (cents / 100).toFixed(2);
  const rows = Array.from(sums.values()).map((sum) => ({
    business_date: sum.date,
    mode: sum.mode,
    money_in: text(sum.cents),
    money_out: '0.00',
    net: text(sum.cents),
  }));
  return { rows, state: 'ready', message: null, loaded: true };
}

/** V1 for the selectors. The same array until a bill-summary row changes. */
const billRows = (): readonly SelectorBillRow[] =>
  PREVIEW_MODE ? previewBillRows() : billSummaryRows();
/** V2 for the selectors: every customer. */
const balanceRows = (): readonly SelectorBalanceRow[] =>
  PREVIEW_MODE ? _customers.map(previewBalanceRow) : customerBalanceRows();
/** The lines of the bills for the Sales report's split. */
const lineRows = (): readonly SoldLine[] => (PREVIEW_MODE ? previewLineRows() : soldLineRows());

/** Today's business date (S5): the Asia/Kolkata day of the browser's clock, whatever time zone the computer is in. */
const businessTodayNow = (): string => businessDateOf(Date.now());

/** A figure made from memory once for each change of the resources it reads and each day (a screen that asks every second costs nothing between changes). A preview has no versions and makes it each time. */
function memoOf<T>(resources: SyncResource[], make: (today: string) => T): () => T {
  let held: { key: string; value: T } | null = null;
  return () => {
    const today = businessTodayNow();
    if (PREVIEW_MODE) return make(today);
    const key = `${rowCache.versionOf(...resources)}|${today}`;
    if (held === null || held.key !== key) held = { key, value: make(today) };
    return held.value;
  };
}

/** The cash book of a range of business dates (V4), as last read. A real build reads it from the API when a screen watches it; a preview makes it from its sample payments. */
export function getDailyTotals(from: string, to: string): DailyTotalsView {
  return PREVIEW_MODE ? previewDailyTotals(from, to) : booksServer.dailyTotals(from, to);
}

/** A screen shows this range of the cash book: read it, and read it again when the receipts change. Returns the way to stop. */
export function watchDailyTotals(from: string, to: string): () => void {
  return PREVIEW_MODE ? () => undefined : booksServer.watchDailyTotals(from, to);
}

/** Reads the range now (the "Try again" of a cash book that could not be read). Never rejects: see the view. */
export function reloadDailyTotals(from: string, to: string): Promise<void> {
  return PREVIEW_MODE ? Promise.resolve() : booksServer.reloadDailyTotals(from, to);
}

/** The cash book changed (a read began or ended): for `useSyncExternalStore`. */
export function subscribeBooks(listener: () => void): () => void {
  return PREVIEW_MODE ? () => undefined : booksServer.subscribe(listener);
}
export function booksVersion(): number {
  return PREVIEW_MODE ? 0 : booksServer.version();
}

/** The owner's dashboard line as last read from the API (a preview build shows a made-up healthy night). */
export function getHealthView(): HealthView {
  if (PREVIEW_MODE) {
    return {
      state: 'ready',
      message: null,
      health: MOCK_HEALTH,
      review: MOCK_REVIEW,
      reviewMessage: null,
    };
  }
  return booksServer.healthView();
}

/** The dashboard shows the line: read it, and read it again every few minutes. Returns the way to stop. */
export function watchHealth(): () => void {
  return PREVIEW_MODE ? () => undefined : booksServer.watchHealth();
}

/** Reads the line now (the "Try again" of a line that could not be read; WEB12b calls it after a Download everything). Never rejects. */
export function reloadHealth(): Promise<void> {
  return PREVIEW_MODE ? Promise.resolve() : booksServer.reloadHealth();
}

const cashRowsOf = (view: DailyTotalsView): DailyTotalRow[] => view.rows.map(dailyTotalOf);
/** The cash book can be shown: it has been read and the last read did not fail. A reload in progress shows the rows of the read before it. */
const cashBookShown = (view: DailyTotalsView): boolean =>
  view.state === 'ready' || (view.state === 'loading' && view.loaded);

export interface TotalOutstanding {
  /** The sum of V2 `outstanding` over every customer, the walk-in and opening dues included. */
  outstandingPaise: number;
  customersWithDues: number;
  fineOutstandingMg: number;
}

const outstandingMemo = memoOf<TotalOutstanding>(['customer-balances'], () => {
  const rows = balanceRows();
  return {
    outstandingPaise: totalOutstanding(rows),
    customersWithDues: customersWithDues(rows),
    fineOutstandingMg: totalFineOutstanding(rows),
  };
});

/** What the customers owe in all (V2): the Outstanding of the dashboard, the Payments report, the evening check and the header of the customer ledger. */
export function computeOutstanding(): TotalOutstanding {
  return outstandingMemo();
}

export interface PendingPayment {
  /** The bill's id. */
  id: string;
  customerId: string;
  customerName: string;
  mobile: string;
  invoiceNumber: string;
  amountPaise: number;
  finePendingMg: number;
  /** Whole business days from the bill date to today. */
  daysOld: number;
}

const pendingMemo = memoOf<PendingPayment[]>(['bill-summary', 'customers'], (today) => {
  const people = new Map<string, { name: string; mobile: string }>();
  if (PREVIEW_MODE) {
    for (const c of _customers) people.set(c.id, { name: c.name, mobile: c.mobile });
  } else {
    for (const c of rowCache.rows('customers'))
      people.set(c.id, { name: c.name, mobile: c.mobile ?? '' });
  }
  // opening-balance dues are dues: they are in this list although they are not sales; a cancelled bill is not (its pending is 0)
  return pendingBills(billRows(), today).map((bill) => ({
    id: bill.billId,
    customerId: bill.customerId,
    customerName: people.get(bill.customerId)?.name ?? '',
    mobile: people.get(bill.customerId)?.mobile ?? '',
    invoiceNumber: bill.billNo,
    amountPaise: bill.pendingPaise,
    finePendingMg: bill.finePendingMg,
    daysOld: bill.daysOld,
  }));
});

/** The bills with money pending, oldest first (V1 through `pendingBills`). */
export function computePendingPayments(): PendingPayment[] {
  return pendingMemo();
}

interface SalesBoard {
  today: string;
  month: string;
  todaySales: SalesFigure;
  monthSales: SalesFigure;
  cancelledToday: SalesFigure;
  cancelledMonth: SalesFigure;
}
const salesBoardMemo = memoOf<SalesBoard>(['bill-summary'], (today) => {
  const bills = billRows();
  const month = businessMonthOf(today);
  return {
    today,
    month,
    todaySales: salesForDate(bills, today),
    monthSales: salesForMonth(bills, month),
    cancelledToday: cancelledForDate(bills, today),
    cancelledMonth: cancelledForMonth(bills, month),
  };
});

export interface SalesReport {
  /** The month the report covers (this month so far): '2026-10'. */
  month: string;
  /** V5: the sales of the month (active bills that are not opening-balance bills). */
  sales: SalesFigure;
  /** The cancelled bills of the month, on their own line. Not sales. */
  cancelled: SalesFigure;
  /** The lines of the sales by metal and by category. */
  metals: LineTotal[];
  categories: LineTotal[];
  /** What the lines add up to. */
  linesPaise: number;
  /** The sales less the lines: the discount, other charges, tax and round-off, which belong to the bill and not to a line. Negative when discounts are larger. */
  adjustmentPaise: number;
  /** Gold and silver line totals month by month. */
  monthly: MonthLines[];
}

const salesReportMemo = memoOf<SalesReport>(['bill-summary', 'bill-items'], (today) => {
  const bills = billRows();
  const lines = lineRows();
  const month = businessMonthOf(today);
  const sales = salesForMonth(bills, month);
  const categories = lineTotalsByCategory(lines, bills, month);
  const linesPaise = categories.reduce((sum, row) => sum + row.totalPaise, 0);
  return {
    month,
    sales,
    cancelled: cancelledForMonth(bills, month),
    metals: lineTotalsByMetal(lines, bills, month),
    categories,
    linesPaise,
    adjustmentPaise: sales.totalPaise - linesPaise,
    monthly: lineTotalsByMonth(lines, bills),
  };
});

/** The Sales report: this month so far, from V5 and the lines (the same sales figure as the dashboard's month). */
export function computeSalesReport(): SalesReport {
  return salesReportMemo();
}

export interface DaySales {
  /** The business date, YYYY-MM-DD. */
  date: string;
  /** '15 Oct'. */
  label: string;
  /** V5 sales of the day in whole paise: active bills that are not opening-balance bills. */
  salesPaise: number;
  bills: number;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/** The sales of each of the last `days` business days, today last (the chart of the dashboard). Each day is `salesForDate`, so a cancelled bill and dues brought forward are in none. */
export function computeDailySales(days = 7): DaySales[] {
  const bills = billRows();
  const now = Date.now();
  const out: DaySales[] = [];
  for (let back = days - 1; back >= 0; back--) {
    const date = businessDateOf(now - back * 86_400_000);
    const figure = salesForDate(bills, date);
    out.push({
      date,
      label: `${Number(date.slice(8, 10))} ${MONTH_NAMES[Number(date.slice(5, 7)) - 1]}`,
      salesPaise: figure.totalPaise,
      bills: figure.count,
    });
  }
  return out;
}

export interface PaymentsPeriod {
  from: string;
  to: string;
}

/** The days the Payments report covers: the first of this month to today. The cash book of that range is what a screen watches. */
export function paymentsPeriod(): PaymentsPeriod {
  const to = businessTodayNow();
  return { from: `${businessMonthOf(to)}-01`, to };
}

export interface PaymentsReport extends PaymentsPeriod {
  /** The state of the cash book read: modes and `collectedPaise` mean nothing unless it is 'ready' (or a reload of a good read). */
  state: DailyTotalsView['state'];
  message: string | null;
  shown: boolean;
  /** Money in, money out and net of the five modes (V4) over the period, refunds and voids included. */
  modes: ModeTotal[];
  /** Each mode's net as a share of the total collected, one decimal, or null when nothing was collected. */
  shares: Record<string, string | null>;
  collectedPaise: number;
  outstandingPaise: number;
  customersWithDues: number;
  /** The bills with money pending and what they add up to (equal to `outstandingPaise`, I10). */
  pending: PendingPayment[];
  pendingTotalPaise: number;
}

/** The Payments report: the cash book of the period (V4), what is owed (V2) and the bills it is owed on (V1). */
export function computePaymentsReport(period: PaymentsPeriod = paymentsPeriod()): PaymentsReport {
  const view = getDailyTotals(period.from, period.to);
  const shown = cashBookShown(view);
  const modes = paymentModeTotals(shown ? cashRowsOf(view) : [], period);
  const collectedPaise = modes.reduce((sum, mode) => sum + mode.netPaise, 0);
  const owed = computeOutstanding();
  const pending = computePendingPayments();
  return {
    ...period,
    state: view.state,
    message: view.message,
    shown,
    modes,
    shares: Object.fromEntries(
      modes.map((m) => [m.mode, shareOfTotal(m.netPaise, collectedPaise)])
    ),
    collectedPaise,
    outstandingPaise: owed.outstandingPaise,
    customersWithDues: owed.customersWithDues,
    pending,
    pendingTotalPaise: pending.reduce((sum, p) => sum + p.amountPaise, 0),
  };
}

export interface EveningView {
  /** The business date the cash figures are for: today. */
  date: string;
  /** The state of the cash book of the day. */
  state: DailyTotalsView['state'];
  message: string | null;
  /** Today's Cash net and UPI net (V4), or null while the cash book cannot be shown. */
  cashNetPaise: number | null;
  upiNetPaise: number | null;
  /** The sum of V2 `outstanding`: from memory, always known. */
  outstandingPaise: number;
}

/** The owner's evening check (V4, C14): today's Cash net, today's UPI net and the total outstanding. */
export function computeEvening(date: string = businessTodayNow()): EveningView {
  const view = getDailyTotals(date, date);
  if (cashBookShown(view)) {
    const figures = eveningFigures(cashRowsOf(view), balanceRows(), date);
    return {
      date,
      state: view.state,
      message: view.message,
      cashNetPaise: figures.cashNetPaise,
      upiNetPaise: figures.upiNetPaise,
      outstandingPaise: figures.outstandingPaise,
    };
  }
  return {
    date,
    state: view.state,
    message: view.message,
    cashNetPaise: null,
    upiNetPaise: null,
    outstandingPaise: computeOutstanding().outstandingPaise,
  };
}

/**
 * The figures of one customer's card: V2 and the counts of V1 (`customerCard`). In a real build they are read from the customer's rows in memory, and a customer whose V2 row has not
 * arrived has an all-zero card (nothing is made up). A preview build makes the row from the sample customer it is given.
 */
export function getCustomerCard(who: Customer | string): CustomerCard {
  const customerId = typeof who === 'string' ? who : who.id;
  if (PREVIEW_MODE) {
    const sample = typeof who === 'string' ? _customers.find((c) => c.id === who) : who;
    return customerCard(
      sample ? previewBalanceRow(sample) : emptyBalanceOf(customerId),
      previewBillRows().filter((row) => row.customerId === customerId)
    );
  }
  const row = rowCache.get('customer-balances', customerId);
  return customerCard(
    row ? customerBalanceOf(row) : emptyBalanceOf(customerId),
    billRows().filter((bill) => bill.customerId === customerId)
  );
}

// ── Dashboard Stats (computed) ────────────────────────────────────────────────

export function computeDashboardStats() {
  const designs = getDesigns();
  const allSkus = designs.flatMap((d) => d.skus);

  const totalDesigns = designs.length;
  const totalSkus = allSkus.length;
  const inStock = allSkus.filter((s) => s.status === 'In Stock').length;
  const reserved = allSkus.filter((s) => s.status === 'Reserved').length;
  const onApproval = allSkus.filter((s) => s.status === 'On Approval').length;
  const sold = allSkus.filter((s) => s.status === 'Sold').length;

  const goldInStock = allSkus.filter((s) => s.material === 'Gold' && s.status === 'In Stock');
  const silverInStock = allSkus.filter((s) => s.material === 'Silver' && s.status === 'In Stock');
  const goldStockWeight = goldInStock.reduce((a, s) => a + s.customerNetWeight, 0);
  const silverStockWeight = silverInStock.reduce((a, s) => a + s.customerNetWeight, 0);

  // sales, the cancelled line and what is owed: the selectors over V1 and V2 (C14, V5), in whole paise
  const board = salesBoardMemo();
  const owed = computeOutstanding();

  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  const ageingOver90 = allSkus.filter(
    (s) => s.status === 'In Stock' && now - new Date(s.createdAt).getTime() > ninetyDaysMs
  ).length;

  return {
    totalDesigns,
    totalSkus,
    inStock,
    reserved,
    onApproval,
    sold,
    goldStockWeight,
    silverStockWeight,
    goldStockCount: goldInStock.length,
    silverStockCount: silverInStock.length,
    today: board.today,
    todaySalesPaise: board.todaySales.totalPaise,
    todayBills: board.todaySales.count,
    monthSalesPaise: board.monthSales.totalPaise,
    monthBills: board.monthSales.count,
    cancelledToday: board.cancelledToday,
    cancelledMonth: board.cancelledMonth,
    totalOutstandingPaise: owed.outstandingPaise,
    customersWithDues: owed.customersWithDues,
    approvalDue: onApproval,
    ageingOver90,
  };
}

export function computeApprovalDue() {
  const designs = getDesigns();
  return designs.flatMap((d) =>
    d.skus
      .filter((s) => s.status === 'On Approval')
      .map((s) => ({
        id: s.id,
        customerName: '—',
        mobile: '—',
        skuNumber: s.skuNumber,
        designNumber: s.designNumber,
        issuedDate: s.createdAt.slice(0, 10),
        expectedReturn: '—',
        overdueDays: 0,
      }))
  );
}

export function computeAgeingStock() {
  const designs = getDesigns();
  const now = Date.now();
  const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000;
  return designs.flatMap((d) =>
    d.skus
      .filter(
        (s) => s.status === 'In Stock' && now - new Date(s.createdAt).getTime() > ninetyDaysMs
      )
      .map((s) => ({
        id: s.id,
        designNumber: s.designNumber,
        skuNumber: s.skuNumber,
        category: d.category,
        material: s.material,
        days: Math.floor((now - new Date(s.createdAt).getTime()) / (1000 * 60 * 60 * 24)),
        grossWeight: s.grossWeight,
      }))
  );
}

export function computeRecentActivity() {
  const activities: {
    id: string;
    type: string;
    description: string;
    time: string;
    amount: number;
  }[] = [];

  // a cancelled bill is not a sale (V5): it is not "recent activity" of the shop's sales
  const recentInvoices = [...soldInvoices()]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, 3);

  for (const inv of recentInvoices) {
    activities.push({
      id: `act-inv-${inv.id}`,
      type: 'sale',
      description: `Invoice ${inv.invoiceNumber} — ${inv.customerName}`,
      time: new Date(inv.date).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }),
      amount: inv.grandTotal,
    });
  }

  const recentDesigns = getDesigns().slice(0, 2);
  for (const d of recentDesigns) {
    activities.push({
      id: `act-design-${d.id}`,
      type: 'stock',
      description: `Design ${d.designNumber} added — ${d.skus.length} SKU(s)`,
      time: new Date(d.createdAt).toLocaleTimeString('en-IN', {
        hour: '2-digit',
        minute: '2-digit',
      }),
      amount: 0,
    });
  }

  return activities.slice(0, 5);
}

export function computeCategoryStockData() {
  const designs = getDesigns();
  const categoryMap: Record<string, number> = {};
  for (const d of designs) {
    const inStock = d.skus.filter((s) => s.status === 'In Stock').length;
    if (inStock > 0) {
      categoryMap[d.category] = (categoryMap[d.category] || 0) + inStock;
    }
  }
  const COLORS = [
    '#D4A843',
    '#B8902E',
    '#9B7A28',
    '#7D6422',
    '#C4A030',
    '#E8C060',
    '#F0D080',
    '#A89020',
  ];
  return Object.entries(categoryMap).map(([name, value], i) => ({
    name,
    value,
    fill: COLORS[i % COLORS.length],
  }));
}

/** Gold and silver sales month by month for the charts (rupees, for display only): the lines of the sales (V5) added up in paise by the selectors. */
export function computeMonthlySalesData() {
  const label = (month: string) =>
    new Date(`${month}-15T12:00:00Z`).toLocaleString('en-IN', {
      month: 'short',
      year: '2-digit',
      timeZone: 'UTC',
    });
  return lineTotalsByMonth(lineRows(), billRows()).map((row) => ({
    month: label(row.month),
    goldSales: row.goldPaise / 100,
    silverSales: row.silverPaise / 100,
  }));
}

export function computeCategorySalesData() {
  const catMap: Record<string, { count: number; value: number }> = {};
  for (const inv of soldInvoices()) {
    for (const item of inv.items) {
      if (!catMap[item.category]) catMap[item.category] = { count: 0, value: 0 };
      catMap[item.category].count += 1;
      catMap[item.category].value += item.itemTotal;
    }
  }
  return Object.entries(catMap).map(([category, data]) => ({ category, ...data }));
}

export function computePaymentModeData() {
  const modeMap: Record<string, number> = {};
  for (const inv of soldInvoices()) {
    for (const pmt of inv.payments) {
      modeMap[pmt.mode] = (modeMap[pmt.mode] || 0) + pmt.amount;
    }
  }
  const total = Object.values(modeMap).reduce((a, v) => a + v, 0);
  const COLORS: Record<string, string> = {
    Cash: '#22c55e',
    UPI: '#3b82f6',
    Card: '#8b5cf6',
    'Bank Transfer': '#f59e0b',
    Credit: '#ef4444',
    Other: '#94a3b8',
  };
  return Object.entries(modeMap).map(([mode, amount]) => ({
    mode,
    value: total > 0 ? Math.round((amount / total) * 100) : 0,
    amount,
    fill: COLORS[mode] || '#94a3b8',
  }));
}
