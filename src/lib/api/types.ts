// The shapes the API sends and takes (NODE-DESIGN section 4, spec S3, S8, A4, C3, C4). Types only, except the two lists at the top.
//
// Where the BUILT API differs from NODE-DESIGN, this file follows the built API (docs/handoffs.md of jewelvault-api: API05, API11, API18):
//   - every sync answer carries `server_time` (the design had it on the poll only);
//   - `users` rows carry `updated_at` (C3 orders every resource by it);
//   - flags (`active`, `is_walkin`, `is_opening`) are JSON booleans, JSON columns (`settings.value`, `designs.tags`, `designs.photo_ids`) are parsed
//     JSON, `item_count` is a JSON number, and `stones` and `kundan` of a piece are whole numbers (counts, not weights);
//   - `me` carries `pricing_sha256` (a hash, or null when the API cannot say), the login answer does not.
// The rows of the writing functions X1 to X12 are the design's (4.3); only X7 is built so far. Check each against the API when its screen is built.
//
// Wire format of values (S3, S5): money and weight are DECIMAL TEXT ("257612.00", "35.420"), never a JSON number; ids are lower-case UUID text; a
// timestamp is UTC text with six decimals ("2026-10-15T09:41:12.123456Z"), kept and sent back as the exact text; a business date is "YYYY-MM-DD".

/** Rupees or a rate as text: "257612.00". */
export type MoneyText = string;
/** Grams as text: "35.420". */
export type WeightText = string;
export type UuidText = string;
/** UTC with microseconds: "2026-10-15T09:41:12.123456Z". Never go through a Date: it cuts the microseconds. */
export type TimestampText = string;
/** A business date in Asia/Kolkata: "2026-10-15". */
export type DateText = string;

export type Role = 'owner' | 'biller' | 'staff';

// ------------------------------------------------------------------------------------------------ errors (S8, NODE-DESIGN 4.5)

/** Every code the API answers with. A code that is not here is treated like JV_INTERNAL by the client. */
export const ERROR_CODES = [
  'JV_INVALID_INPUT',
  'JV_FORBIDDEN',
  'JV_NOT_FOUND',
  'JV_PIECE_UNAVAILABLE',
  'JV_CUSTOMER_ARCHIVED',
  'JV_OVERPAYMENT',
  'JV_CASH_LIMIT',
  'JV_FINE_EXCEEDS',
  'JV_BILL_CANCELLED',
  'JV_ALREADY_VOID',
  'JV_NOT_ALLOWED',
  'JV_STALE',
  'JV_UNAUTHENTICATED',
  'JV_SESSION_EXPIRED',
  'JV_BAD_LOGIN',
  'JV_PASSWORD_CHANGE_REQUIRED',
  'JV_CSRF',
  'JV_RATE_LIMITED',
  'JV_PAYLOAD_TOO_LARGE',
  'JV_UNSUPPORTED_MEDIA_TYPE',
  'JV_BUSY',
  'JV_UNAVAILABLE',
  'JV_INTERNAL',
] as const;
export type ApiErrorCode = (typeof ERROR_CODES)[number];

/** Codes the CLIENT makes up for an answer that has no S8 body. */
export type ClientErrorCode =
  /** the request got no answer: offline, refused, or cut after the time limit */
  | 'NETWORK'
  /** a gateway error or a reply that is not JSON, still there after 30 seconds of retries */
  | 'GATEWAY'
  /** the API answered with a money or weight value as a JSON number, or otherwise not in the agreed shape */
  | 'BAD_RESPONSE';

export interface ErrorBody {
  error: { code: string; message: string; details: Record<string, unknown> };
  request_id: string;
}

// ------------------------------------------------------------------------------------------------ session calls (NODE-DESIGN 2.5; handoff API05)

export interface SessionUser {
  id: UuidText;
  email: string;
  full_name: string;
  role: Role;
  must_change_password: boolean;
}

export interface SessionLife {
  /** The idle limit of the session, in seconds. */
  idle_timeout_s: number;
  /** When the session ends whatever the person does. */
  absolute_expires_at: TimestampText;
}

/** `POST /v1/auth/login` and `POST /v1/auth/change-password`. */
export interface LoginResponse extends SessionLife {
  user: SessionUser;
}

/** `GET /v1/auth/me`. `pricing_sha256` is the SHA-256 of the API's copy of pricing.ts (C12). */
export interface MeResponse extends LoginResponse {
  pricing_sha256: string | null;
}

/** `logout` and `activity`. */
export interface OkResponse {
  ok: true;
}

// ------------------------------------------------------------------------------------------------ rows of the sync resources (A4, C3; READ_COLUMNS of the API)

interface Stamps {
  created_at: TimestampText;
  updated_at: TimestampText;
  created_by: UuidText | null;
  updated_by: UuidText | null;
}

export type SaleType = 'Retail' | 'Semi-Wholesale' | 'Wholesale';
export type Material = 'Gold' | 'Silver';
export type SellingMethod = 'By Weight' | 'Per Piece';
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

export interface UserRow {
  id: UuidText;
  full_name: string;
  role: Role;
  active: boolean;
  updated_at: TimestampText;
}

export interface SettingRow extends Stamps {
  setting_key: string;
  /** The owner's own JSON. */
  value: unknown;
}

export interface DailyRateRow extends Stamps {
  id: UuidText;
  material: Material;
  purity: string;
  rate_per_gram: MoneyText;
  rate_date: DateText;
  confirmed_by: UuidText | null;
}

export interface CategoryRow extends Stamps {
  id: UuidText;
  name: string;
  prefix: string;
  active: boolean;
}

export interface SubcategoryRow extends Stamps {
  id: UuidText;
  category_id: UuidText;
  name: string;
  active: boolean;
}

export interface DesignRow extends Stamps {
  id: UuidText;
  design_no: string;
  name: string | null;
  category_id: UuidText;
  subcategory_id: UuidText | null;
  material: Material;
  purity: string;
  selling_method: SellingMethod;
  description: string | null;
  notes: string | null;
  tags: string[];
  primary_photo_id: UuidText | null;
  photo_ids: UuidText[];
  archived_at: TimestampText | null;
}

export interface SkuRow extends Stamps {
  id: UuidText;
  design_id: UuidText;
  sku_no: string;
  barcode: string;
  gross_weight: WeightText;
  customer_net_weight: WeightText;
  stones: number;
  stone_weight: WeightText;
  kundan: number;
  kundan_weight: WeightText;
  piroi: MoneyText;
  labour_retail: MoneyText;
  labour_semi: MoneyText;
  labour_wholesale: MoneyText;
  status: SkuStatus;
  location: string | null;
  notes: string | null;
  sold_bill_id: UuidText | null;
  archived_at: TimestampText | null;
}

/** Owner only: the weight the owner keeps private. */
export interface SkuPrivateRow extends Stamps {
  sku_id: UuidText;
  original_net_weight: WeightText;
}

export interface CustomerRow extends Stamps {
  id: UuidText;
  name: string;
  mobile: string | null;
  customer_type: SaleType;
  email: string | null;
  address: string | null;
  gst_number: string | null;
  pan: string | null;
  notes: string | null;
  is_walkin: boolean;
  archived_at: TimestampText | null;
}

export interface BillRow extends Stamps {
  id: UuidText;
  bill_no: string;
  customer_id: UuidText;
  bill_date: DateText;
  doc_type: string;
  sale_type: SaleType;
  status: 'active' | 'cancelled';
  cancel_reason: string | null;
  cancelled_at: TimestampText | null;
  cancelled_on: DateText | null;
  cancelled_by: UuidText | null;
  reissue_of: UuidText | null;
  pricing_version: number;
  subtotal: MoneyText;
  discount: MoneyText;
  additional_charges: MoneyText;
  gst_percent: MoneyText;
  gst_amount: MoneyText;
  grand_total: MoneyText;
  round_off: MoneyText;
  fine_weight_due: WeightText;
  notes: string | null;
  cash_override_reason: string | null;
}

export interface BillItemRow {
  id: UuidText;
  bill_id: UuidText;
  line_no: number;
  sku_id: UuidText;
  design_no: string;
  sku_no: string;
  category: string;
  material: Material;
  purity: string;
  selling_method: SellingMethod;
  gross_weight: WeightText;
  customer_net_weight: WeightText;
  quantity: number;
  metal_rate: MoneyText;
  labour_rate: MoneyText;
  labour_amount: MoneyText;
  piroi: MoneyText;
  other_charges: MoneyText;
  metal_amount: MoneyText;
  fine_weight_due: WeightText;
  item_total: MoneyText;
  tax_rate: MoneyText;
  tax_amount: MoneyText;
  list_metal_rate: MoneyText;
  list_labour_rate: MoneyText | null;
  created_at: TimestampText;
  updated_at: TimestampText;
}

export type ReceiptKind = 'money' | 'refund' | 'fine_cash' | 'fine_silver';

export interface ReceiptRow extends Stamps {
  id: UuidText;
  customer_id: UuidText;
  kind: ReceiptKind;
  mode: string | null;
  amount: MoneyText;
  fine_grams: WeightText;
  silver_rate: MoneyText | null;
  paid_on: DateText;
  reference: string | null;
  notes: string | null;
  is_opening: boolean;
  cash_override_reason: string | null;
  status: 'active' | 'voided';
  void_reason: string | null;
  voided_at: TimestampText | null;
  voided_on: DateText | null;
  voided_by: UuidText | null;
}

export interface ReceiptAllocationRow {
  id: UuidText;
  receipt_id: UuidText;
  bill_id: UuidText;
  customer_id: UuidText;
  amount: MoneyText;
  fine_grams: WeightText;
  released_at: TimestampText | null;
  created_at: TimestampText;
  updated_at: TimestampText;
}

/** V1, derived: the figures of one bill. */
export interface BillSummaryRow {
  id: UuidText;
  bill_no: string;
  customer_id: UuidText;
  bill_date: DateText;
  doc_type: string;
  sale_type: SaleType;
  status: 'active' | 'cancelled';
  reissue_of: UuidText | null;
  grand_total: MoneyText;
  received: MoneyText;
  pending: MoneyText;
  fine_due: WeightText;
  fine_settled: WeightText;
  fine_pending: WeightText;
  payment_status: string;
  item_count: number;
  created_at: TimestampText;
  updated_at: TimestampText;
}

/** V2, derived: the books of one customer (keyed by the customer's id). */
export interface CustomerBalanceRow {
  id: UuidText;
  billed: MoneyText;
  total_purchases: MoneyText;
  received: MoneyText;
  refunded: MoneyText;
  allocated: MoneyText;
  outstanding: MoneyText;
  advance: MoneyText;
  balance: MoneyText;
  fine_billed: WeightText;
  fine_received: WeightText;
  fine_allocated: WeightText;
  fine_outstanding: WeightText;
  fine_advance: WeightText;
  fine_balance: WeightText;
  last_purchase: DateText | null;
  updated_at: TimestampText;
}

/** The name of a resource in the address `/v1/sync/<resource>` and in a poll, and the row it gives. */
export interface SyncRows {
  users: UserRow;
  settings: SettingRow;
  'daily-rates': DailyRateRow;
  categories: CategoryRow;
  subcategories: SubcategoryRow;
  designs: DesignRow;
  skus: SkuRow;
  'sku-private': SkuPrivateRow;
  customers: CustomerRow;
  bills: BillRow;
  'bill-summary': BillSummaryRow;
  'bill-items': BillItemRow;
  receipts: ReceiptRow;
  'receipt-allocations': ReceiptAllocationRow;
  'customer-balances': CustomerBalanceRow;
}
export type SyncResource = keyof SyncRows;

export const SYNC_RESOURCES: readonly SyncResource[] = [
  'users',
  'settings',
  'daily-rates',
  'categories',
  'subcategories',
  'designs',
  'skus',
  'sku-private',
  'customers',
  'bills',
  'bill-summary',
  'bill-items',
  'receipts',
  'receipt-allocations',
  'customer-balances',
];

// ------------------------------------------------------------------------------------------------ the read side (NODE-DESIGN 4.2; handoff API11)

/** The cursor the client sends: the exact text of a timestamp, with the key when it has one (a cursor without a key reads `updated_at >= ?`). */
export interface SyncCursor {
  updated_at: TimestampText;
  key?: string | null;
}

/** The cursor the server hands back when a page was full. */
export interface SyncNext {
  updated_at: TimestampText;
  key: string;
}

/** `GET /v1/sync/<resource>?updated_after=&after_key=&limit=`. */
export interface SyncPage<Row> {
  rows: Row[];
  next: SyncNext | null;
  /** The API's clock when the page was read: the first poll after a hydrate starts from this minus 30 seconds. */
  server_time: TimestampText;
}

/** `POST /v1/sync/poll`. */
export interface PollRequest {
  limit?: number;
  cursors: Partial<Record<SyncResource, SyncCursor | null>>;
}

export interface PollResponse {
  results: { [R in SyncResource]?: { rows: SyncRows[R][]; next: SyncNext | null } };
  server_time: TimestampText;
  /** The caller's role as the database says it now (C4, C18). */
  role: Role;
}

// ------------------------------------------------------------------------------------------------ the writing functions (NODE-DESIGN 4.3; only X7 is built)

export type BillWarning = 'PAN_MISSING' | 'RATE_MISSING' | 'RATE_STALE';

/** X1 `POST /v1/bills` (201). */
export interface CreateBillResponse {
  bill: BillRow;
  items: BillItemRow[];
  receipts: ReceiptRow[];
  allocations: ReceiptAllocationRow[];
  warnings: BillWarning[];
  advance_applied: MoneyText;
}

/** X10 `POST /v1/bills/{id}/reissue` (201). */
export interface ReissueBillResponse extends Omit<CreateBillResponse, 'bill'> {
  old_bill: BillRow;
  new_bill: BillRow;
}

/** X2 `POST /v1/customers/{id}/payments` (201). */
export interface RecordPaymentResponse {
  receipt: ReceiptRow;
  allocations: ReceiptAllocationRow[];
  advance_remaining: MoneyText;
}

/** X3 `POST /v1/customers/{id}/fine-settlements` (201). */
export interface SettleFineResponse {
  receipt: ReceiptRow;
  allocations: ReceiptAllocationRow[];
  fine_remaining: WeightText;
}

/** X4 `POST /v1/receipts/{id}/void` (200). */
export interface VoidReceiptResponse {
  receipt: ReceiptRow;
  allocations: ReceiptAllocationRow[];
  bills: BillRow[];
}

/** X5 `POST /v1/bills/{id}/cancel` (200). */
export interface CancelBillResponse {
  bill: BillRow;
  skus: SkuRow[];
  released_allocations: ReceiptAllocationRow[];
}

/** X6 `POST /v1/customers` (201). */
export interface CreateCustomerResponse {
  customer: CustomerRow;
}

/** X8 `POST /v1/designs` (201). `sku_private` is there only for a caller who may enter the original weight (the owner), one row for each piece that has one (D9). */
export interface CreateDesignResponse {
  design: DesignRow;
  skus: SkuRow[];
  sku_private?: SkuPrivateRow[];
}

/** X9 `POST /v1/skus/status` (200). */
export interface SetSkuStatusResponse {
  skus: SkuRow[];
}

/** X11 `POST /v1/customers/{id}/refunds` (201). */
export interface IssueRefundResponse {
  receipt: ReceiptRow;
  advance: MoneyText;
}

/** X12 `POST /v1/customers/{id}/opening-balance` (201). */
export interface OpeningBalanceResponse {
  bill: BillRow;
  receipts: ReceiptRow[];
  allocations: ReceiptAllocationRow[];
}

/** X7 `POST /v1/bills/quote` (200, read-only; handoff API18). The figures are the API's own pricing.ts. */
export interface QuoteBillResponse {
  pricing_version: number;
  bill_date: DateText;
  sale_type: SaleType;
  lines: Array<Record<string, MoneyText | WeightText | number | string>>;
  totals: {
    subtotal: MoneyText;
    discount: MoneyText;
    additional_charges: MoneyText;
    grand_total: MoneyText;
    round_off: MoneyText;
    fine_weight_due: WeightText;
  };
  list_prices: Array<{
    line_no: number;
    sku_id: UuidText;
    list_metal_rate: MoneyText;
    list_labour_rate: MoneyText | null;
    metal_rate_date: DateText | null;
  }>;
  warnings: string[];
}
