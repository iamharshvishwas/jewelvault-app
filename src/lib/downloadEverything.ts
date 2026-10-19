// Download everything: the zip of the books (spec B3, C15, O53; tests T-E04, T-R05, T-D03; task WEB12b). Pure: rows in, bytes out, no browser API and no store.
//
// WHAT IT MAKES. One zip of CSV files built in the browser from the cache after a fresh poll (the flow is src/lib/cache/downloadServer.ts): customers, bills, bill items, receipts,
// allocations, stock (designs and pieces), daily rates, categories, sub-categories, settings and the users' names and roles, plus `MANIFEST.csv` with the date and the row count of every file.
// It is a readable copy of the books that the owner and her accountant can open if Hostinger is gone: it is not a database restore, and it holds no photos and no audit log.
//
// THE NAMES. A file is named by the TABLE whose rows it holds (the twelve names of `DOWNLOAD_FILES` are the keys of `counts` in `POST /v1/owner/download-record`, API35), and its header row is
// the DATABASE column names (the lists are the API's READ_COLUMNS, src/permissions/matrix.ts). That is the contract with the Mac tool `scripts/zip-balances.mjs` (T-R05's drill), which rebuilds
// every customer's balance from `customers.csv`, `bills.csv`, `receipts.csv` and `receipt_allocations.csv` by these names and refuses a zip with the name of the column that is missing.
// A null is an empty cell; a yes/no flag is 1 or 0 as in the database; a JSON column (tags, photo ids, a setting's value) is JSON text; money and weight are the exact text the books have.
//
// WHAT IT LEAVES OUT. Each file has an explicit list of columns, so a field a row happens to carry is never copied: a user row gives its id, name, role, active flag and stamp, and never an
// e-mail address or a hash. The owner-only original weight is the last column of `skus.csv` for the owner and does not exist for anybody else (D9, D12, T-D03): the piece's weight lives in
// its own table (`sku_private`), so it is joined here by the piece's id, and the other roles' rows for it are never read.
//
// THE FORMULA GUARD. A text cell that starts with =, +, -, @, a tab or a carriage return gets a single quote in front (`guardFormula` of exportUtils, the one guard of downloadCsv, downloadExcel
// and this zip, RV1-9); a number is not touched. Which cells are numbers is decided by the COLUMN, not by what the text looks like: money, weight and counts are numbers (a signed one such as
// a round-off of -0.40 stays a number), and a number column that holds anything else is guarded like text.
import type { AuthRole } from '@/lib/authStore';
import type { SyncResource } from '@/lib/api/types';
import { csvQuote, guardFormula } from './exportUtils';
import { createZip } from './zipFile';

/** B3: the twelve files, named by table. A record names every one of them and no other (API35). */
export const DOWNLOAD_FILES = [
  'customers',
  'bills',
  'bill_items',
  'receipts',
  'receipt_allocations',
  'designs',
  'skus',
  'daily_rates',
  'categories',
  'subcategories',
  'settings',
  'users',
] as const;
export type DownloadFile = (typeof DOWNLOAD_FILES)[number];

type Kind = 'text' | 'number' | 'flag' | 'json';
type Column = string | { name: string; kind: Kind };
const n = (name: string): Column => ({ name, kind: 'number' });
const flag = (name: string): Column => ({ name, kind: 'flag' });
const json = (name: string): Column => ({ name, kind: 'json' });

const STAMPS = ['created_at', 'updated_at', 'created_by', 'updated_by'];

interface FileSpec {
  /** The sync resource whose rows fill the file. */
  resource: SyncResource;
  columns: readonly Column[];
  /** The order of the rows: the fields compared in turn (as text), the key last. */
  order: readonly string[];
}

// the columns are those of READ_COLUMNS in the API (src/permissions/matrix.ts); the kind of a column is its database type (DECIMAL, INT and BIGINT are numbers, TINYINT(1) a flag, JSON json)
const SPECS: Readonly<Record<DownloadFile, FileSpec>> = {
  customers: {
    resource: 'customers',
    columns: [
      'id',
      'name',
      'mobile',
      'customer_type',
      'email',
      'address',
      'gst_number',
      'pan',
      'notes',
      flag('is_walkin'),
      'archived_at',
      ...STAMPS,
    ],
    order: ['created_at', 'id'],
  },
  bills: {
    resource: 'bills',
    columns: [
      'id',
      'bill_no',
      'customer_id',
      'bill_date',
      'doc_type',
      'sale_type',
      'status',
      'cancel_reason',
      'cancelled_at',
      'cancelled_on',
      'cancelled_by',
      'reissue_of',
      n('pricing_version'),
      n('subtotal'),
      n('discount'),
      n('additional_charges'),
      n('gst_percent'),
      n('gst_amount'),
      n('grand_total'),
      n('round_off'),
      n('fine_weight_due'),
      'notes',
      'cash_override_reason',
      ...STAMPS,
    ],
    order: ['created_at', 'id'],
  },
  bill_items: {
    resource: 'bill-items',
    columns: [
      'id',
      'bill_id',
      n('line_no'),
      'sku_id',
      'design_no',
      'sku_no',
      'category',
      'material',
      'purity',
      'selling_method',
      n('gross_weight'),
      n('customer_net_weight'),
      n('quantity'),
      n('metal_rate'),
      n('labour_rate'),
      n('labour_amount'),
      n('piroi'),
      n('other_charges'),
      n('metal_amount'),
      n('fine_weight_due'),
      n('item_total'),
      n('tax_rate'),
      n('tax_amount'),
      n('list_metal_rate'),
      n('list_labour_rate'),
      'created_at',
      'updated_at',
    ],
    order: ['created_at', 'id'],
  },
  receipts: {
    resource: 'receipts',
    columns: [
      'id',
      'customer_id',
      'kind',
      'mode',
      n('amount'),
      n('fine_grams'),
      n('silver_rate'),
      'paid_on',
      'reference',
      'notes',
      flag('is_opening'),
      'cash_override_reason',
      'status',
      'void_reason',
      'voided_at',
      'voided_on',
      'voided_by',
      ...STAMPS,
    ],
    order: ['created_at', 'id'],
  },
  receipt_allocations: {
    resource: 'receipt-allocations',
    columns: [
      'id',
      'receipt_id',
      'bill_id',
      'customer_id',
      n('amount'),
      n('fine_grams'),
      'released_at',
      'created_at',
      'updated_at',
    ],
    order: ['created_at', 'id'],
  },
  designs: {
    resource: 'designs',
    columns: [
      'id',
      'design_no',
      'name',
      'category_id',
      'subcategory_id',
      'material',
      'purity',
      'selling_method',
      'description',
      'notes',
      json('tags'),
      'primary_photo_id',
      json('photo_ids'),
      'archived_at',
      ...STAMPS,
    ],
    order: ['created_at', 'id'],
  },
  skus: {
    resource: 'skus',
    columns: [
      'id',
      'design_id',
      'sku_no',
      'barcode',
      n('gross_weight'),
      n('customer_net_weight'),
      n('stones'),
      n('stone_weight'),
      n('kundan'),
      n('kundan_weight'),
      n('piroi'),
      n('labour_retail'),
      n('labour_semi'),
      n('labour_wholesale'),
      'status',
      'location',
      'notes',
      'sold_bill_id',
      'archived_at',
      ...STAMPS,
    ],
    order: ['created_at', 'id'],
  },
  daily_rates: {
    resource: 'daily-rates',
    columns: [
      'id',
      'material',
      'purity',
      n('rate_per_gram'),
      'rate_date',
      'confirmed_by',
      ...STAMPS,
    ],
    order: ['created_at', 'id'],
  },
  categories: {
    resource: 'categories',
    columns: ['id', 'name', 'prefix', flag('active'), ...STAMPS],
    order: ['created_at', 'id'],
  },
  subcategories: {
    resource: 'subcategories',
    columns: ['id', 'category_id', 'name', flag('active'), ...STAMPS],
    order: ['created_at', 'id'],
  },
  settings: {
    resource: 'settings',
    columns: ['setting_key', json('value'), ...STAMPS],
    order: ['setting_key'],
  },
  users: {
    resource: 'users',
    columns: ['id', 'full_name', 'role', flag('active'), 'updated_at'],
    order: ['full_name', 'id'],
  },
};

/** The owner-only weight: a column of skus.csv for the owner, joined from the piece's private row (D9, D12). */
export const OWNER_ONLY_COLUMN = 'original_net_weight';

/** The books are not in memory (the load has not finished, or the session ended): a zip of nothing would look like a copy and be none. */
export class DownloadBooksNotLoaded extends Error {
  constructor() {
    super(
      'The books are not loaded yet, so there is nothing to download. Wait for the screen to finish loading and try again.'
    );
    this.name = 'DownloadBooksNotLoaded';
  }
}

// ---------------------------------------------------------------------------------------------- cells

const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;

/** One cell as text, already guarded: what goes between the commas. */
function cellText(kind: Kind, value: unknown): string {
  if (value === null || value === undefined) return '';
  switch (kind) {
    case 'number':
      if (typeof value === 'number') return Number.isFinite(value) ? String(value) : '';
      // a money or weight text of the books; anything that is not a plain number is not trusted to be one
      return typeof value === 'string' && PLAIN_NUMBER.test(value)
        ? value
        : guardFormula(String(value));
    case 'flag':
      return value === true ? '1' : value === false ? '0' : guardFormula(String(value));
    case 'json':
      return guardFormula(JSON.stringify(value));
    default:
      return guardFormula(value);
  }
}

const NEWLINE = '\r\n';
const BOM = '﻿';

function csvLine(cells: readonly string[]): string {
  return cells.map(csvQuote).join(',');
}

const nameOf = (column: Column) => (typeof column === 'string' ? column : column.name);
const kindOf = (column: Column): Kind => (typeof column === 'string' ? 'text' : column.kind);

function compareRows(
  order: readonly string[],
  a: Record<string, unknown>,
  b: Record<string, unknown>
): number {
  for (const field of order) {
    const x = String(a[field] ?? '');
    const y = String(b[field] ?? '');
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------- the build

export interface DownloadInput {
  /** The role of the person: the owner-only weight is written for the owner and for nobody else. */
  role: AuthRole;
  /** The rows of a resource as the cache holds them. */
  rows: (resource: SyncResource) => readonly object[];
  /** The business date (Asia/Kolkata, YYYY-MM-DD) of the moment: in the file name, the manifest and the record. */
  date: string;
  /** The moment, for the date of the files inside the zip. */
  modified: Date;
}

export interface BuiltDownload {
  zip: Uint8Array<ArrayBuffer>;
  filename: string;
  date: string;
  /** Rows of each file, keyed by table: the body of the record (API35). */
  counts: Record<DownloadFile, number>;
}

/** The name the zip is saved under. */
export function downloadFilename(date: string): string {
  return `download-everything-${date}.zip`;
}

export function buildDownload(input: DownloadInput): BuiltDownload {
  const { role, rows, date, modified } = input;
  // the signed-in person is always among the users and the shop always has settings: if either is missing, the load did not finish
  if (rows('users').length === 0 || rows('settings').length === 0)
    throw new DownloadBooksNotLoaded();

  const encoder = new TextEncoder();
  const counts = {} as Record<DownloadFile, number>;
  const entries: Array<{ name: string; data: Uint8Array }> = [];

  for (const file of DOWNLOAD_FILES) {
    const spec = SPECS[file];
    const columns: Column[] = [...spec.columns];
    const privateWeight = new Map<string, unknown>();
    if (file === 'skus' && role === 'owner') {
      columns.push(n(OWNER_ONLY_COLUMN));
      for (const row of rows('sku-private') as Array<Record<string, unknown>>)
        privateWeight.set(String(row.sku_id), row.original_net_weight);
    }
    const sorted = [...(rows(spec.resource) as Array<Record<string, unknown>>)].sort((a, b) =>
      compareRows(spec.order, a, b)
    );
    const lines = [csvLine(columns.map((c) => guardFormula(nameOf(c))))];
    for (const row of sorted) {
      lines.push(
        csvLine(
          columns.map((c) => {
            const name = nameOf(c);
            const value =
              file === 'skus' && name === OWNER_ONLY_COLUMN
                ? privateWeight.get(String(row.id))
                : row[name];
            return cellText(kindOf(c), value);
          })
        )
      );
    }
    counts[file] = sorted.length;
    entries.push({
      name: `${file}.csv`,
      data: encoder.encode(`${BOM}${lines.join(NEWLINE)}${NEWLINE}`),
    });
  }

  const manifest = [
    csvLine(['file', 'rows', 'date']),
    ...DOWNLOAD_FILES.map((file) => csvLine([`${file}.csv`, String(counts[file]), date])),
  ];
  entries.push({
    name: 'MANIFEST.csv',
    data: encoder.encode(`${BOM}${manifest.join(NEWLINE)}${NEWLINE}`),
  });

  return { zip: createZip(entries, modified), filename: downloadFilename(date), date, counts };
}
