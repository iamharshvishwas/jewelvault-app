import { PREVIEW_MODE } from './previewMode';

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
}

export interface LedgerEntry {
  id: string;
  customerId: string;
  date: string;
  type: 'Invoice' | 'Payment' | 'Credit' | 'Return' | 'Adjustment';
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

// ── Mock Designs ──────────────────────────────────────────────────────────────

// WEB03 (D20): the sample records are made only in a preview build (the flag of src/lib/previewMode.ts). In every other build MOCK_DESIGNS and MOCK_CUSTOMERS are
// empty, so no store can fall back to them. The sample code itself is still in the bundle of a normal build (the build does not know the flag when it is unset),
// but nothing calls it. WEB15 deletes the samples together with the preview switch.
export const MOCK_DESIGNS: Design[] = PREVIEW_MODE ? sampleDesigns() : [];

function sampleDesigns(): Design[] {
  return [
    {
      id: 'design-set-00572',
      designNumber: 'SET-00572',
      designName: 'Jaishri Bridal Kundan Necklace Set',
      category: 'Necklace Set',
      subcategory: 'Bridal',
      material: 'Gold',
      purity: '22K',
      sellingMethod: 'By Weight',
      description: 'Premium bridal necklace set with kundan and stone work.',
      notes: 'Seeded local Jaishri showroom stock.',
      tags: ['bridal', 'kundan', 'wedding'],
      images: ['/assets/images/no_image.png'],
      primaryImage: '/assets/images/no_image.png',
      createdAt: new Date(Date.now() - 16 * 86400000).toISOString(),
      createdBy: 'Jaishri Admin',
      labour: 353,
      retailLabour: 353,
      semiWholesaleLabour: 325,
      wholesaleLabour: 300,
      piroi: 2.15,
      skus: [
        {
          id: 'sku-set-00572-001',
          skuNumber: 'SET-00572-001',
          designId: 'design-set-00572',
          designNumber: 'SET-00572',
          grossWeight: 48.63,
          originalNetWeight: 34.9,
          customerNetWeight: 35.42,
          stones: 42,
          stoneWeight: 0,
          kundan: 18,
          kundanWeight: 0,
          piroi: 2.15,
          labour: 353,
          retailLabour: 353,
          semiWholesaleLabour: 325,
          wholesaleLabour: 300,
          status: 'In Stock',
          location: 'Main Showroom',
          barcode: 'BC-SET-00572-001',
          createdAt: new Date(Date.now() - 16 * 86400000).toISOString(),
          createdBy: 'Jaishri Admin',
          notes: 'Demo tag printing and billing stock.',
          sellingMethod: 'By Weight',
          purity: '22K',
          material: 'Gold',
          category: 'Necklace Set',
          subcategory: 'Bridal',
        },
        {
          id: 'sku-set-00572-002',
          skuNumber: 'SET-00572-002',
          designId: 'design-set-00572',
          designNumber: 'SET-00572',
          grossWeight: 47.925,
          originalNetWeight: 34.35,
          customerNetWeight: 34.86,
          stones: 40,
          stoneWeight: 0,
          kundan: 18,
          kundanWeight: 0,
          piroi: 2.1,
          labour: 359,
          retailLabour: 359,
          semiWholesaleLabour: 332,
          wholesaleLabour: 305,
          status: 'Reserved',
          location: 'Jaishri Vault',
          barcode: 'BC-SET-00572-002',
          createdAt: new Date(Date.now() - 15 * 86400000).toISOString(),
          createdBy: 'Jaishri Admin',
          notes: 'Reserved sample SKU.',
          sellingMethod: 'By Weight',
          purity: '22K',
          material: 'Gold',
          category: 'Necklace Set',
          subcategory: 'Bridal',
        },
      ],
    },
    {
      id: 'design-ring-00821',
      designNumber: 'RING-00821',
      designName: 'Jaishri Classic Silver Ring',
      category: 'Ring',
      subcategory: 'Band',
      material: 'Silver',
      purity: '925',
      sellingMethod: 'By Weight',
      description: 'Classic 925 silver ring for daily wear.',
      notes: 'Seeded silver stock.',
      tags: ['silver', 'ring'],
      images: ['/assets/images/no_image.png'],
      primaryImage: '/assets/images/no_image.png',
      createdAt: new Date(Date.now() - 44 * 86400000).toISOString(),
      createdBy: 'Jaishri Admin',
      labour: 61,
      retailLabour: 61,
      semiWholesaleLabour: 53,
      wholesaleLabour: 45,
      piroi: 0.45,
      skus: [
        {
          id: 'sku-ring-00821-001',
          skuNumber: 'RING-00821-001',
          designId: 'design-ring-00821',
          designNumber: 'RING-00821',
          grossWeight: 14.35,
          originalNetWeight: 13.5,
          customerNetWeight: 13.9,
          stones: 0,
          stoneWeight: 0,
          kundan: 0,
          kundanWeight: 0,
          piroi: 0.45,
          labour: 61,
          retailLabour: 61,
          semiWholesaleLabour: 53,
          wholesaleLabour: 45,
          status: 'In Stock',
          location: 'Main Showroom',
          barcode: 'BC-RING-00821-001',
          createdAt: new Date(Date.now() - 44 * 86400000).toISOString(),
          createdBy: 'Jaishri Admin',
          notes: 'Silver billing test SKU.',
          sellingMethod: 'By Weight',
          purity: '925',
          material: 'Silver',
          category: 'Ring',
          subcategory: 'Band',
        },
      ],
    },
  ];
}

// ── Mock Customers ────────────────────────────────────────────────────────────

export const MOCK_CUSTOMERS: Customer[] = PREVIEW_MODE ? sampleCustomers() : [];

function sampleCustomers(): Customer[] {
  return [
    {
      id: 'cust-jaishri-001',
      name: 'Meera Sharma',
      mobile: '9876543210',
      customerType: 'Retail',
      email: 'meera@example.com',
      address: 'Jaipur, Rajasthan',
      gstNumber: '',
      notes: 'Regular bridal customer.',
      totalPurchases: 0,
      totalReceived: 0,
      outstanding: 0,
      outstandingSilverFine: 0,
      lastPurchase: new Date(Date.now() - 10 * 86400000).toISOString(),
      createdAt: new Date(Date.now() - 120 * 86400000).toISOString(),
    },
  ];
}

// ── Mock Invoices ─────────────────────────────────────────────────────────────

export const MOCK_INVOICES: Invoice[] = [];

// ── Mock Ledger ───────────────────────────────────────────────────────────────

export const MOCK_LEDGER: LedgerEntry[] = [];

// ── Dashboard Stats ───────────────────────────────────────────────────────────

export const DASHBOARD_STATS = {
  totalDesigns: 0,
  totalSkus: 0,
  inStock: 0,
  reserved: 0,
  onApproval: 0,
  sold: 0,
  goldStockWeight: 0,
  silverStockWeight: 0,
  goldStockCount: 0,
  silverStockCount: 0,
  todaySales: 0,
  monthSales: 0,
  totalOutstanding: 0,
  approvalDue: 0,
  ageingOver90: 0,
};

export const DAILY_SALES_DATA: { day: string; sales: number; invoices: number }[] = [];

export const CATEGORY_DATA: { name: string; value: number; fill: string }[] = [];

export const RECENT_ACTIVITY: {
  id: string;
  type: string;
  description: string;
  time: string;
  amount: number;
}[] = [];

export const PENDING_PAYMENTS: {
  id: string;
  customerName: string;
  mobile: string;
  invoiceNumber: string;
  amount: number;
  daysOld: number;
}[] = [];

export const APPROVAL_DUE: {
  id: string;
  customerName: string;
  mobile: string;
  skuNumber: string;
  designNumber: string;
  issuedDate: string;
  expectedReturn: string;
  overdueDays: number;
}[] = [];

export const AGEING_STOCK: {
  id: string;
  designNumber: string;
  skuNumber: string;
  category: string;
  material: string;
  days: number;
  grossWeight: number;
}[] = [];

// ── Report Data ───────────────────────────────────────────────────────────────

export const MONTHLY_SALES_DATA: { month: string; goldSales: number; silverSales: number }[] = [];

export const CATEGORY_SALES_DATA: { category: string; count: number; value: number }[] = [];

export const PAYMENT_MODE_DATA: { mode: string; value: number; amount: number; fill: string }[] =
  [];

export const AGEING_REPORT_DATA: { bucket: string; count: number; weight: number }[] = [];
