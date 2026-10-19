// The shapes of the screens: a design with its pieces, a customer, a bill, a ledger entry. The stores (designStore, appStore) make them from the rows in memory (src/lib/cache);
// weights and amounts are numbers made from the API's text, for display only. The file used to hold the prototype's sample data as well (WEB15 deleted it with the preview
// build); the name stays so that the screens' imports stay as they are. It has no code: nothing here exists at run time.

export type SkuStatus =
  | 'In Stock'
  | 'Reserved'
  | 'On Approval'
  | 'Sold'
  | 'Returned'
  | 'Repair'
  | 'Transferred'
  | 'Missing'
  | 'Damaged'
  | 'Archived';

export type Material = 'Gold' | 'Silver';
export type Purity = '18K' | '20K' | '22K' | '24K' | '800' | '925' | '999';
export type SellingMethod = 'By Weight' | 'Per Piece';
export type CustomerType = 'Retail' | 'Semi-Wholesale' | 'Wholesale';

export interface Sku {
  id: string;
  skuNumber: string;
  designId: string;
  designNumber: string;
  grossWeight: number;
  originalNetWeight: number;
  customerNetWeight: number;
  stones: number;
  stoneWeight: number;
  kundan: number;
  kundanWeight: number;
  piroi: number;
  labour: number;
  retailLabour?: number;
  semiWholesaleLabour?: number;
  wholesaleLabour?: number;
  status: SkuStatus;
  location: string;
  barcode: string;
  createdAt: string;
  createdBy: string;
  notes: string;
  sellingMethod: SellingMethod;
  purity: Purity;
  material: Material;
  category: string;
  subcategory: string;
}

export interface Design {
  id: string;
  designNumber: string;
  designName: string;
  category: string;
  subcategory: string;
  material: Material;
  purity: Purity;
  sellingMethod: SellingMethod;
  description: string;
  notes: string;
  tags: string[];
  /** The full pictures (the gallery), the primary one first. */
  images: string[];
  /** The 320 px thumbnails of the same photos, in the same order (the strip under the gallery); absent in the sample data. */
  thumbs?: string[];
  /** What a list shows for the design: the thumbnail of the primary photo, or the placeholder. */
  primaryImage: string;
  skus: Sku[];
  createdAt: string;
  createdBy: string;
  labour: number;
  retailLabour?: number;
  semiWholesaleLabour?: number;
  wholesaleLabour?: number;
  piroi: number;
}

export interface Customer {
  id: string;
  name: string;
  mobile: string;
  customerType: CustomerType;
  email: string;
  address: string;
  gstNumber: string;
  notes: string;
  totalPurchases: number;
  totalReceived: number;
  outstanding: number;
  outstandingSilverFine: number;
  lastPurchase: string;
  createdAt: string;
}

export interface InvoiceItem {
  id: string;
  designNumber: string;
  skuNumber: string;
  material: Material;
  purity: Purity;
  grossWeight: number;
  customerNetWeight: number;
  metalRate: number;
  labour: number;
  piroi: number;
  otherCharges: number;
  metalAmount: number;
  fineWeightDue?: number;
  itemTotal: number;
  /** How many pieces the line sold (R6: a Per Piece line may be more than one; a By Weight line is always 1). Absent on a line of the prototype's sample data, which means one. */
  quantity?: number;
  sellingMethod: SellingMethod;
  imageRef: string;
  category: string;
  taxRate: number;
  taxAmount: number;
}

export interface Payment {
  id: string;
  mode: 'Cash' | 'UPI' | 'Card' | 'Bank Transfer' | 'Credit' | 'Other';
  amount: number;
  date: string;
  reference: string;
  notes: string;
}

export interface Invoice {
  id: string;
  invoiceNumber: string;
  customerId: string;
  customerName: string;
  customerMobile: string;
  items: InvoiceItem[];
  payments: Payment[];
  subtotal: number;
  discount: number;
  discountPercent: number;
  additionalCharges: number;
  gst: number;
  gstPercent: number;
  roundOff: number;
  grandTotal: number;
  amountReceived: number;
  pendingAmount: number;
  status: 'Paid' | 'Partial' | 'Pending' | 'Cancelled';
  saleType?: CustomerType;
  fineWeightDue?: number;
  fineWeightSettled?: number;
  fineWeightPending?: number;
  amountDue?: number;
  date: string;
  createdBy: string;
  notes: string;
  /** True for the dues brought forward (an opening-balance bill: no lines, not a sale, C14). Absent for every other bill. */
  openingBalance?: boolean;
}

/** The kind V3 gives a row of the ledger (spec section 11): the words of the ledger table come from it. */
export type LedgerKind =
  | 'Invoice'
  | 'Opening'
  | 'Cancellation'
  | 'Payment'
  | 'Opening advance'
  | 'Fine'
  | 'Refund'
  | 'Void';

export interface LedgerEntry {
  id: string;
  customerId: string;
  date: string;
  type: 'Invoice' | 'Payment' | 'Credit' | 'Return' | 'Adjustment';
  /** The kind of the row of V3 this entry was made from. */
  kind?: LedgerKind;
  description: string;
  debit: number;
  credit: number;
  balance: number;
  fineDebit?: number;
  fineCredit?: number;
  fineBalance?: number;
  silverRate?: number;
  reference: string;
  paymentId?: string;
  invoiceId?: string;
}
