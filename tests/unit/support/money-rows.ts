// Rows of the money side the way the API sends them (src/lib/api/types.ts), for the unit tests of WEB07: customers, bills, bill-summary (V1), bill-items,
// receipts, receipt-allocations and customer-balances (V2). Money and weight are text, ids are lower-case UUIDs and every stamp is the exact six-decimal text.
//
// `shop()` is one small book whose V1 figures are worked out BY HAND in the comment above each bill, from the definition of V1 (db/queries/V1_bill_summary.sql):
//   received = the sum of the LIVE allocations' money (released_at null AND the receipt active), pending = grand_total - received (0 for a cancelled bill),
//   fine_settled = the sum of the live allocations' fine grams, fine_pending = fine_due - fine_settled, and payment_status
//   Cancelled / Paid (nothing pending, no fine pending) / Partial (some money or fine received) / Pending.
// The tests compare what `getInvoices()` says with these hand figures and with the row of V1, so a store that works the figures out again cannot pass by luck.
import type {
  BillItemRow,
  BillRow,
  BillSummaryRow,
  CustomerBalanceRow,
  CustomerRow,
  ReceiptAllocationRow,
  ReceiptRow,
} from '@/lib/api/types';
import { at, uuid } from './rows';

export const id = {
  priya: uuid(5001),
  walkin: uuid(5002),
  gone: uuid(5003),
  userAsha: uuid(901),
};

const stamps = (sec: number, micros = 0) => ({
  created_at: at(sec, micros),
  updated_at: at(sec, micros),
  created_by: id.userAsha,
  updated_by: id.userAsha,
});

export const customerRow = (
  key: string,
  over: Partial<CustomerRow> & { n?: number } = {}
): CustomerRow => ({
  id: key,
  name: 'Priya Sharma',
  mobile: '9876543210',
  customer_type: 'Retail',
  email: 'priya@example.test',
  address: '12 Johari Bazaar, Jaipur',
  gst_number: null,
  pan: null,
  notes: null,
  is_walkin: false,
  archived_at: null,
  ...stamps(5),
  ...over,
});

export const balanceRow = (
  key: string,
  over: Partial<CustomerBalanceRow> = {}
): CustomerBalanceRow => ({
  id: key,
  billed: '0.00',
  total_purchases: '0.00',
  received: '0.00',
  refunded: '0.00',
  allocated: '0.00',
  outstanding: '0.00',
  advance: '0.00',
  balance: '0.00',
  fine_billed: '0.000',
  fine_received: '0.000',
  fine_allocated: '0.000',
  fine_outstanding: '0.000',
  fine_advance: '0.000',
  fine_balance: '0.000',
  last_purchase: null,
  updated_at: at(6),
  ...over,
});

export const billRow = (n: number, customerId: string, over: Partial<BillRow> = {}): BillRow => ({
  id: uuid(6000 + n),
  bill_no: `JV-${String(n).padStart(4, '0')}`,
  customer_id: customerId,
  bill_date: '2026-10-15',
  doc_type: 'estimate',
  sale_type: 'Retail',
  status: 'active',
  cancel_reason: null,
  cancelled_at: null,
  cancelled_on: null,
  cancelled_by: null,
  reissue_of: null,
  pricing_version: 1,
  subtotal: '0.00',
  discount: '0.00',
  additional_charges: '0.00',
  gst_percent: '0.00',
  gst_amount: '0.00',
  grand_total: '0.00',
  round_off: '0.00',
  fine_weight_due: '0.000',
  notes: null,
  cash_override_reason: null,
  ...stamps(10 + n),
  ...over,
});

export const summaryRow = (
  bill: BillRow,
  figures: Pick<
    BillSummaryRow,
    'received' | 'pending' | 'fine_settled' | 'fine_pending' | 'payment_status' | 'item_count'
  >,
  over: Partial<BillSummaryRow> = {}
): BillSummaryRow => ({
  id: bill.id,
  bill_no: bill.bill_no,
  customer_id: bill.customer_id,
  bill_date: bill.bill_date,
  doc_type: bill.doc_type,
  sale_type: bill.sale_type,
  status: bill.status,
  reissue_of: bill.reissue_of,
  grand_total: bill.grand_total,
  fine_due: bill.fine_weight_due,
  created_at: bill.created_at,
  updated_at: bill.updated_at,
  ...figures,
  ...over,
});

export const itemRow = (
  bill: BillRow,
  lineNo: number,
  over: Partial<BillItemRow> = {}
): BillItemRow => ({
  id: uuid(7000 + Number(bill.id.slice(-4)) * 10 + lineNo),
  bill_id: bill.id,
  line_no: lineNo,
  sku_id: uuid(1000 + lineNo),
  design_no: 'RING-00001',
  sku_no: `RING-00001-${String(lineNo).padStart(3, '0')}`,
  category: 'Ring',
  material: 'Gold',
  purity: '22K',
  selling_method: 'By Weight',
  gross_weight: '38.100',
  customer_net_weight: '35.420',
  quantity: 1,
  metal_rate: '6920.00',
  labour_rate: '353.00',
  labour_amount: '12505.26',
  piroi: '0.00',
  other_charges: '0.00',
  metal_amount: '245106.40',
  fine_weight_due: '0.000',
  item_total: '257611.66',
  tax_rate: '0.00',
  tax_amount: '0.00',
  list_metal_rate: '6920.00',
  list_labour_rate: '353.00',
  created_at: bill.created_at,
  updated_at: bill.updated_at,
  ...over,
});

export const receiptRow = (
  n: number,
  customerId: string,
  over: Partial<ReceiptRow> = {}
): ReceiptRow => ({
  id: uuid(8000 + n),
  customer_id: customerId,
  kind: 'money',
  mode: 'Cash',
  amount: '0.00',
  fine_grams: '0.000',
  silver_rate: null,
  paid_on: '2026-10-15',
  reference: null,
  notes: null,
  is_opening: false,
  cash_override_reason: null,
  status: 'active',
  void_reason: null,
  voided_at: null,
  voided_on: null,
  voided_by: null,
  ...stamps(20 + n),
  ...over,
});

export const allocationRow = (
  n: number,
  receipt: ReceiptRow,
  bill: BillRow,
  over: Partial<ReceiptAllocationRow> = {}
): ReceiptAllocationRow => ({
  id: uuid(9000 + n),
  receipt_id: receipt.id,
  bill_id: bill.id,
  customer_id: bill.customer_id,
  amount: '0.00',
  fine_grams: '0.000',
  released_at: null,
  created_at: receipt.created_at,
  updated_at: receipt.updated_at,
  ...over,
});

export interface Shop {
  customers: CustomerRow[];
  balances: CustomerBalanceRow[];
  bills: BillRow[];
  summaries: BillSummaryRow[];
  items: BillItemRow[];
  receipts: ReceiptRow[];
  allocations: ReceiptAllocationRow[];
  /** The bills by name, for the assertions. */
  by: Record<
    'partial' | 'silver' | 'cancelled' | 'pending' | 'opening' | 'paid',
    { bill: BillRow; summary: BillSummaryRow }
  >;
}

/**
 * Priya's book, six bills (hand figures, V1):
 *   JV-0001 PARTIAL   grand 257612.00 = 245106.40 + 12505.26 + round-off 0.34. Live allocations: cash 100000.00 (receipt 1) and UPI 57612.00 (receipt 2) -> received 157612.00,
 *                     pending 100000.00, Partial. A third allocation (receipt 3, 9000.00) is RELEASED, and a fourth (receipt 4, 8000.00) belongs to a VOIDED receipt: neither counts.
 *   JV-0002 SILVER    grand 40000.00, fine due 25.000 g. Live: cash 40000.00 (receipt 5) and 10.000 g of silver (receipt 6) -> received 40000.00, pending 0.00, fine settled 10.000,
 *                     fine pending 15.000, Partial (money paid, silver still owed).
 *   JV-0003 CANCELLED grand 5000.00, cancelled: V1 shows 0 received, 0 pending, Cancelled. Its allocation (receipt 7, 5000.00) was released by the cancel.
 *   JV-0004 PENDING   grand 12000.00, nothing paid -> received 0.00, pending 12000.00, Pending.
 *   JV-0005 PAID      grand 3000.00, cash 3000.00 (receipt 8) -> received 3000.00, pending 0.00, Paid.
 *   OB-0001 OPENING   doc_type opening_balance, no lines, grand 20000.00 brought forward, nothing paid -> pending 20000.00, Pending. Not a sale (C14).
 * Also a walk-in customer (no mobile) and an archived customer.
 */
export function shop(): Shop {
  const priya = customerRow(id.priya);
  const walkin = customerRow(id.walkin, {
    name: 'Walk-in',
    mobile: null,
    is_walkin: true,
    email: null,
    address: null,
    ...stamps(1),
  });
  const gone = customerRow(id.gone, {
    name: 'Old customer',
    archived_at: at(30),
    ...stamps(2),
  });

  const partialBill = billRow(1, id.priya, {
    subtotal: '257611.66',
    round_off: '0.34',
    grand_total: '257612.00',
    notes: 'Bridal set',
    bill_date: '2026-10-15',
  });
  const silverBill = billRow(2, id.priya, {
    sale_type: 'Wholesale',
    subtotal: '40000.00',
    grand_total: '40000.00',
    fine_weight_due: '25.000',
  });
  const cancelledBill = billRow(3, id.priya, {
    status: 'cancelled',
    cancel_reason: 'wrong customer',
    cancelled_at: at(40),
    cancelled_on: '2026-10-16',
    subtotal: '5000.00',
    grand_total: '5000.00',
  });
  const pendingBill = billRow(4, id.priya, {
    subtotal: '12000.00',
    discount: '500.00',
    additional_charges: '100.00',
    grand_total: '12000.00',
    bill_date: '2026-10-14',
  });
  const paidBill = billRow(5, id.priya, { subtotal: '3000.00', grand_total: '3000.00' });
  const openingBill = billRow(6, id.priya, {
    bill_no: 'OB-0001',
    doc_type: 'opening_balance',
    grand_total: '20000.00',
    bill_date: '2026-10-01',
  });

  const partial = summaryRow(partialBill, {
    received: '157612.00',
    pending: '100000.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Partial',
    item_count: 2,
  });
  const silver = summaryRow(silverBill, {
    received: '40000.00',
    pending: '0.00',
    fine_settled: '10.000',
    fine_pending: '15.000',
    payment_status: 'Partial',
    item_count: 1,
  });
  const cancelled = summaryRow(cancelledBill, {
    received: '0.00',
    pending: '0.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Cancelled',
    item_count: 1,
  });
  const pending = summaryRow(pendingBill, {
    received: '0.00',
    pending: '12000.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Pending',
    item_count: 1,
  });
  const paid = summaryRow(paidBill, {
    received: '3000.00',
    pending: '0.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Paid',
    item_count: 1,
  });
  const opening = summaryRow(openingBill, {
    received: '0.00',
    pending: '20000.00',
    fine_settled: '0.000',
    fine_pending: '0.000',
    payment_status: 'Pending',
    item_count: 0,
  });

  const items = [
    itemRow(partialBill, 1),
    itemRow(partialBill, 2, {
      design_no: 'SET-00572',
      sku_no: 'SET-00572-001',
      category: 'Necklace Set',
      material: 'Gold',
      purity: '22K',
      metal_amount: '0.00',
      labour_amount: '0.00',
      item_total: '0.00',
      metal_rate: '0.00',
      labour_rate: '0.00',
      customer_net_weight: '0.000',
      gross_weight: '0.000',
    }),
    itemRow(silverBill, 1, {
      material: 'Silver',
      purity: '925',
      design_no: 'ANK-00007',
      sku_no: 'ANK-00007-002',
      category: 'Anklet',
      customer_net_weight: '120.000',
      gross_weight: '124.500',
      metal_rate: '95.00',
      labour_rate: '0.00',
      labour_amount: '0.00',
      metal_amount: '40000.00',
      item_total: '40000.00',
      fine_weight_due: '25.000',
    }),
    itemRow(cancelledBill, 1, { item_total: '5000.00', metal_amount: '5000.00' }),
    itemRow(pendingBill, 1, { item_total: '12000.00', metal_amount: '12000.00' }),
    itemRow(paidBill, 1, { item_total: '3000.00', metal_amount: '3000.00' }),
  ];
  // the items of the second line of bill 1 are sorted after the first by line_no, whatever order the cache holds them in
  items.reverse();

  const r1 = receiptRow(1, id.priya, { mode: 'Cash', amount: '100000.00', reference: 'CASH-1' });
  const r2 = receiptRow(2, id.priya, {
    mode: 'UPI',
    amount: '57612.00',
    reference: 'UPI-7788',
    notes: 'second part',
    paid_on: '2026-10-15',
  });
  const r3 = receiptRow(3, id.priya, { mode: 'Cash', amount: '9000.00' });
  const r4 = receiptRow(4, id.priya, {
    mode: 'Cash',
    amount: '8000.00',
    status: 'voided',
    void_reason: 'keyed twice',
    voided_at: at(50),
    voided_on: '2026-10-16',
  });
  const r5 = receiptRow(5, id.priya, { mode: 'Bank Transfer', amount: '40000.00' });
  const r6 = receiptRow(6, id.priya, {
    kind: 'fine_silver',
    mode: null,
    amount: '0.00',
    fine_grams: '10.000',
  });
  const r7 = receiptRow(7, id.priya, { mode: 'Cash', amount: '5000.00' });
  const r8 = receiptRow(8, id.priya, { mode: 'Card', amount: '3000.00' });

  const allocations = [
    allocationRow(1, r1, partialBill, { amount: '100000.00' }),
    allocationRow(2, r2, partialBill, { amount: '57612.00' }),
    allocationRow(3, r3, partialBill, { amount: '9000.00', released_at: at(41) }),
    allocationRow(4, r4, partialBill, { amount: '8000.00' }),
    allocationRow(5, r5, silverBill, { amount: '40000.00' }),
    allocationRow(6, r6, silverBill, { fine_grams: '10.000' }),
    allocationRow(7, r7, cancelledBill, { amount: '5000.00', released_at: at(40) }),
    allocationRow(8, r8, paidBill, { amount: '3000.00' }),
  ];

  const balances = [
    balanceRow(id.priya, {
      billed: '337612.00',
      total_purchases: '317612.00',
      received: '200612.00',
      allocated: '200612.00',
      outstanding: '132000.00',
      fine_billed: '25.000',
      fine_received: '10.000',
      fine_allocated: '10.000',
      fine_outstanding: '15.000',
      last_purchase: '2026-10-15',
    }),
    balanceRow(id.walkin),
    balanceRow(id.gone),
  ];

  return {
    customers: [priya, walkin, gone],
    balances,
    bills: [partialBill, silverBill, cancelledBill, pendingBill, paidBill, openingBill],
    summaries: [partial, silver, cancelled, pending, paid, opening],
    items,
    receipts: [r1, r2, r3, r4, r5, r6, r7, r8],
    allocations,
    by: {
      partial: { bill: partialBill, summary: partial },
      silver: { bill: silverBill, summary: silver },
      cancelled: { bill: cancelledBill, summary: cancelled },
      pending: { bill: pendingBill, summary: pending },
      paid: { bill: paidBill, summary: paid },
      opening: { bill: openingBill, summary: opening },
    },
  };
}

/** Puts a shop into a cache, resource by resource, the way the hydrate does. */
export function fill(
  cache: {
    merge: (resource: never, rows: never) => number;
  },
  book: Shop = shop(),
  users: readonly object[] = [
    { id: id.userAsha, full_name: 'Asha Verma', role: 'biller', active: true, updated_at: at(1) },
  ]
): Shop {
  const put = (resource: string, rows: readonly object[]) =>
    (cache.merge as unknown as (r: string, rows: readonly object[]) => number)(resource, rows);
  put('users', users);
  put('customers', book.customers);
  put('customer-balances', book.balances);
  put('bills', book.bills);
  put('bill-summary', book.summaries);
  put('bill-items', book.items);
  put('receipts', book.receipts);
  put('receipt-allocations', book.allocations);
  return book;
}
