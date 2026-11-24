import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { compact, readMadePdf } from '../unit/support/pdf-read';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
import { PHONE, expectNoSidewaysScroll, expectTappable, shoot } from './phone';
import { roomInTheMinute } from './pacing';
import { countIn, readPdf, squash, type PdfPage } from './pdf-text';

// WEB13 (PT-W13): the printed estimate and the tag page, printed by Chromium and read back (PLAN.md P3-T1; QA UI-03, UI-04; the layout is outside the spec, the figures are the API's).
//   PT-W13  an automatic print check prints 1, 6 and 40 items and finds "Grand Total" on the last page every time; the tag printout has no app bars
//   and: the totals block (Subtotal ... Pending) is whole on the last page for every length from 1 to 40 lines, the header row comes back on every page that holds lines, every line is
//        on the paper exactly once, the shop's name, address and phone are the Settings' (blank ones are not printed), a Per Piece line with quantity 3 says so, and 42 tags all print.
//
// "Printed" means `page.pdf()`: Chromium lays the page out in print media at the size the page's CSS asks for (A5 landscape for the estimate, A4 for the tags) and cuts it into pages. The text
// of each page is read back by tests/e2e/pdf-text.ts. That needs a headless browser (Playwright's default); `--headed` cannot make a PDF.
//
// The bills are written as root in the lane's container (the billing screen that makes them is WEB08's and is proved in billing.spec.ts); the pieces are shared by all of them. Everything the
// tests made, and the two Settings values they change, is put back (the volume case of hydrate.spec.ts needs a lane without bills, pieces or counters).
//
//   FB-D1 (Siddhi #4): a customer's ledger of 1, 30 and 120 rows printed from the customer card: the customer's name on the first page, `Balance` with the right figure on the last, every row once,
//        the header row on every page that holds rows, and no word of the side bar or the top bar on any page.
//
//   PDF-S1 (PDF-4): Download PDF on the saved estimate saves a real PDF file (made in the browser, src/lib/pdf), named after the bill and its customer, in which every row of the print's
//        table and of its totals (read off the page) is found word for word; Share hands the share menu that same file; Stop, Send PDF and a share that fails; the fonts are fetched only
//        after the tap; the buttons on a phone.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/print.spec.ts

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/**
 * SQL as root in the lane's container. The password never leaves the container: the shell inside it reads it from its own environment. The statements go in through standard input, not on the
 * command line: the fixture is several hundred lines of bills and does not fit an argument list.
 */
function laneSql(sql: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      laneContainer(),
      'sh',
      '-c',
      'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" jv_lane -N -B',
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(`the lane's database refused the SQL (${code}): ${err.slice(0, 500)}`)
        );
      resolve(
        out
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t'))
      );
    });
    child.stdin.end(sql);
  });
}

const sqlText = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

// ------------------------------------------------------------------------------------------------ the books of the tests

const pad = (n: number, width: number) => String(n).padStart(width, '0');
/** Paise as the database's text: 1050000 -> "10500.00". */
const rupees = (paise: bigint) => `${paise / BigInt(100)}.${pad(Number(paise % BigInt(100)), 2)}`;
/** Milligrams as the database's text: 11500 -> "11.500". */
const grams = (mg: bigint) => `${mg / BigInt(1000)}.${pad(Number(mg % BigInt(1000)), 3)}`;

/** One line of a bill, in the units the database works in (paise and milligrams); the amounts are worked out as pricing.ts does (R3 to R7) and are whole rupees. */
interface Line {
  sku: string;
  method: 'By Weight' | 'Per Piece';
  material: 'Gold' | 'Silver';
  purity: string;
  grossMg: bigint;
  netMg: bigint;
  quantity: number;
  /** By Weight: the rate per gram. Per Piece: the price of one piece. */
  ratePaise: bigint;
  /** By Weight only: the labour per gram. */
  labourRatePaise: bigint;
  piroiPaise: bigint;
  otherPaise: bigint;
  /** A Wholesale silver line: the silver is owed back, so there is no metal amount (R4, R5). */
  fine: boolean;
}

function lineFigures(line: Line) {
  const byWeight = line.method === 'By Weight';
  const labour = byWeight ? (line.netMg * line.labourRatePaise) / BigInt(1000) : BigInt(0);
  const fineMg = line.fine ? line.netMg * BigInt(line.quantity) : BigInt(0);
  const metal = line.fine
    ? BigInt(0)
    : byWeight
      ? (line.netMg * line.ratePaise) / BigInt(1000)
      : line.ratePaise * BigInt(line.quantity);
  return { labour, fineMg, metal, total: metal + labour + line.piroiPaise + line.otherPaise };
}

/** The pieces the bills sell: W13-S001 to W13-S040, all in one design. A bill takes the first n of them. */
const PIECES = Array.from({ length: 40 }, (_, i) => `W13-S${pad(i + 1, 3)}`);
const TAGS = Array.from({ length: 42 }, (_, i) => `W13-T${pad(i + 1, 2)}`);

/** A gold piece by weight: 10.000 g to 19.000 g net, a little over in gross; a piroi on every third line and other charges on every fifth. */
function goldLine(i: number): Line {
  return {
    sku: PIECES[i],
    method: 'By Weight',
    material: 'Gold',
    purity: '22K',
    grossMg: BigInt(10_500 + (i % 7) * 1_500),
    netMg: BigInt(10_000 + (i % 7) * 1_500),
    quantity: 1,
    ratePaise: BigInt(700_000),
    labourRatePaise: BigInt(45_000),
    piroiPaise: i % 3 === 0 ? BigInt(2_000) : BigInt(0),
    otherPaise: i % 5 === 0 ? BigInt(5_000) : BigInt(0),
    fine: false,
  };
}

const silverLine = (i: number, fine: boolean): Line => ({
  sku: PIECES[i],
  method: 'By Weight',
  material: 'Silver',
  purity: '925',
  grossMg: BigInt(60_500 + i * 1_000),
  netMg: BigInt(60_000 + i * 1_000),
  quantity: 1,
  ratePaise: BigInt(9_000),
  labourRatePaise: BigInt(1_500),
  piroiPaise: BigInt(0),
  otherPaise: BigInt(0),
  fine,
});

interface Bill {
  number: string;
  customer: 'retail' | 'wholesale';
  saleType: 'Retail' | 'Wholesale';
  lines: Line[];
  discountPaise: bigint;
  additionalPaise: bigint;
  /** Money received on the bill (one cash receipt, allocated in full); BigInt(0) = none. */
  receivedPaise: bigint;
}

/** The bills of the sweep (every length from 1 to 40 lines), the two silver ones and the one with a quantity. */
function books(): Bill[] {
  const retail = (number: string, lines: Line[], extra: Partial<Bill> = {}): Bill => ({
    number,
    customer: 'retail',
    saleType: 'Retail',
    lines,
    discountPaise: BigInt(0),
    additionalPaise: BigInt(0),
    receivedPaise: BigInt(0),
    ...extra,
  });
  const sweep = Array.from({ length: 40 }, (_, k) => {
    const n = k + 1;
    // a discount, a charge and a part payment on the 6- and 40-line bills: the totals block is at its tallest
    const extra: Partial<Bill> =
      n === 6
        ? {
            discountPaise: BigInt(50_000),
            additionalPaise: BigInt(25_000),
            receivedPaise: BigInt(1_000_000),
          }
        : n === 40
          ? {
              discountPaise: BigInt(50_000),
              additionalPaise: BigInt(25_000),
              receivedPaise: BigInt(2_000_000),
            }
          : {};
    return retail(
      `W13-P${pad(n, 2)}`,
      Array.from({ length: n }, (_, i) => goldLine(i)),
      extra
    );
  });
  const wholesale: Bill = {
    number: 'W13-WS06',
    customer: 'wholesale',
    saleType: 'Wholesale',
    lines: Array.from({ length: 6 }, (_, i) => silverLine(i, true)),
    discountPaise: BigInt(0),
    additionalPaise: BigInt(0),
    receivedPaise: BigInt(0),
  };
  const retailSilver = retail(
    'W13-RS03',
    Array.from({ length: 3 }, (_, i) => silverLine(i, false))
  );
  // a quantity of 3 on a Per Piece line (R6): the price of one piece, three of them
  const quantity = retail('W13-QTY3', [
    goldLine(0),
    {
      sku: PIECES[1],
      method: 'Per Piece',
      material: 'Gold',
      purity: '22K',
      grossMg: BigInt(2_000),
      netMg: BigInt(1_800),
      quantity: 3,
      ratePaise: BigInt(150_000),
      labourRatePaise: BigInt(0),
      piroiPaise: BigInt(0),
      otherPaise: BigInt(0),
      fine: false,
    },
    goldLine(2),
  ]);
  return [...sweep, wholesale, retailSilver, quantity];
}

const ids = {
  retail: randomUUID(),
  wholesale: randomUUID(),
  design: randomUUID(),
  tagDesign: randomUUID(),
  pieces: new Map(PIECES.map((sku) => [sku, randomUUID()] as const)),
};
const NAMES = { retail: 'W13 Retail Customer', wholesale: 'W13 Wholesale Customer' };

function fixtureSql(): string {
  const sql: string[] = [];
  sql.push(
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${ids.retail}', '${NAMES.retail}', '9000130001', 'Retail');`,
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${ids.wholesale}', '${NAMES.wholesale}', '9000130002', 'Wholesale');`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.design}', 'W13-D1', 'W13 gold ring', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.tagDesign}', 'W13-D2', 'W13 tag ring', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1;`
  );
  const pieces = PIECES.map(
    (sku, i) =>
      `('${ids.pieces.get(sku)}', '${ids.design}', '${sku}', 'W13B${pad(i + 1, 3)}', 12.500, 12.000, 'In Stock')`
  );
  sql.push(
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ${pieces.join(', ')};`
  );
  const tags = TAGS.map(
    (sku, i) =>
      `('${randomUUID()}', '${ids.tagDesign}', '${sku}', 'W13TB${pad(i + 1, 3)}', 5.500, 5.000, 'In Stock')`
  );
  sql.push(
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ${tags.join(', ')};`
  );

  for (const bill of books()) {
    const billId = randomUUID();
    const figures = bill.lines.map(lineFigures);
    const subtotal = figures.reduce((sum, f) => sum + f.total, BigInt(0));
    const grand = subtotal - bill.discountPaise + bill.additionalPaise;
    const fineMg = figures.reduce((sum, f) => sum + f.fineMg, BigInt(0));
    const customer = bill.customer === 'retail' ? ids.retail : ids.wholesale;
    sql.push(
      `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, discount, additional_charges, grand_total, fine_weight_due) VALUES ` +
        `('${billId}', '${bill.number}', '${customer}', CURDATE(), '${bill.saleType}', ${rupees(subtotal)}, ${rupees(bill.discountPaise)}, ${rupees(bill.additionalPaise)}, ${rupees(grand)}, ${grams(fineMg)});`
    );
    const rows = bill.lines.map((line, i) => {
      const f = figures[i];
      return (
        `('${randomUUID()}', '${billId}', ${i + 1}, '${ids.pieces.get(line.sku)}', 'W13-D1', '${line.sku}', 'Ring', '${line.material}', '${line.purity}', '${line.method}', ` +
        `${grams(line.grossMg)}, ${grams(line.netMg)}, ${line.quantity}, ${rupees(line.ratePaise)}, ${rupees(line.labourRatePaise)}, ${rupees(f.labour)}, ${rupees(line.piroiPaise)}, ` +
        `${rupees(line.otherPaise)}, ${rupees(f.metal)}, ${grams(f.fineMg)}, ${rupees(f.total)}, ${rupees(line.ratePaise)}, NULL)`
      );
    });
    sql.push(
      `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
        `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) VALUES ${rows.join(', ')};`
    );
    if (bill.receivedPaise > BigInt(0)) {
      const receiptId = randomUUID();
      sql.push(
        `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES ('${receiptId}', '${customer}', 'money', 'Cash', ${rupees(bill.receivedPaise)}, CURDATE());`,
        `INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, fine_grams) VALUES ('${randomUUID()}', '${receiptId}', '${billId}', '${customer}', ${rupees(bill.receivedPaise)}, 0.000);`
      );
    }
  }
  sql.push(ledgerFixtureSql());
  // what the money services do on every bill (D23): the customer gets a new `updated_at`, which is how the polls find the change
  sql.push(`UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name LIKE 'W13 %';`);
  return sql.join(' ');
}

// ------------------------------------------------------------------------------------------------ FB-D1: the customers whose ledgers are printed

/**
 * Three customers with a ledger of 1, 30 and 120 rows of V3: a bill with nothing paid; 15 bills each followed by a payment; 60 bills each followed by a payment. A bill is one row and a payment is one row,
 * on the day of the bill (the bills are 1 to 59 days old), the payment an hour after the bill. Bill j is 1,000 + 10 j rupees and payment j is 500 + j rupees (whole rupees, so the figures are exact).
 */
const LEDGERS = [
  { key: 'one', name: 'W13 Ledger One', mobile: '9000130011', bills: 1, payments: 0 },
  { key: 'thirty', name: 'W13 Ledger Thirty', mobile: '9000130012', bills: 15, payments: 15 },
  {
    key: 'hundred',
    name: 'W13 Ledger Hundred Twenty',
    mobile: '9000130013',
    bills: 60,
    payments: 60,
  },
] as const;
type LedgerKey = (typeof LEDGERS)[number]['key'];
const ledgerIds = new Map(LEDGERS.map((l) => [l.key, randomUUID()] as const));
const billNoOf = (key: LedgerKey, j: number) => `W13-L${key[0].toUpperCase()}-${pad(j, 3)}`;
const billRupees = (j: number) => 1000 + 10 * j;
const paymentRupees = (j: number) => 500 + j;

/** What the customer owes at the end of the ledger, in rupees: the bills less the payments. */
function ledgerBalance(ledger: (typeof LEDGERS)[number]): number {
  let balance = 0;
  for (let j = 1; j <= ledger.bills; j++) balance += billRupees(j);
  for (let j = 1; j <= ledger.payments; j++) balance -= paymentRupees(j);
  return balance;
}

function ledgerFixtureSql(): string {
  const sql: string[] = [];
  for (const ledger of LEDGERS) {
    const customer = ledgerIds.get(ledger.key)!;
    sql.push(
      `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${customer}', '${ledger.name}', '${ledger.mobile}', 'Retail');`
    );
    const bills: string[] = [];
    const receipts: string[] = [];
    const allocations: string[] = [];
    for (let j = 1; j <= ledger.bills; j++) {
      const day = `CURDATE() - INTERVAL ${ledger.bills - j} DAY`;
      const billId = randomUUID();
      bills.push(
        `('${billId}', '${billNoOf(ledger.key, j)}', '${customer}', ${day}, 'Retail', ${billRupees(j)}.00, ${billRupees(j)}.00, 0.000, TIMESTAMP(${day}, '12:00:00'))`
      );
      if (j <= ledger.payments) {
        const receiptId = randomUUID();
        receipts.push(
          `('${receiptId}', '${customer}', 'money', 'Cash', ${paymentRupees(j)}.00, ${day}, TIMESTAMP(${day}, '13:00:00'))`
        );
        allocations.push(
          `('${randomUUID()}', '${receiptId}', '${billId}', '${customer}', ${paymentRupees(j)}.00, 0.000)`
        );
      }
    }
    sql.push(
      `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total, fine_weight_due, created_at) VALUES ${bills.join(', ')};`
    );
    if (receipts.length > 0)
      sql.push(
        `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at) VALUES ${receipts.join(', ')};`,
        `INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, fine_grams) VALUES ${allocations.join(', ')};`
      );
  }
  return sql.join(' ');
}

/** Everything these tests made, gone again. The delete order follows the foreign keys. */
async function cleanLane() {
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W13 %'); ` +
      `DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W13 %'); ` +
      `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W13 %')); ` +
      `DELETE FROM bills WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W13 %'); ` +
      `DELETE FROM customers WHERE name LIKE 'W13 %'; ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W13-%'; DELETE FROM designs WHERE design_no LIKE 'W13-%';`
  );
}

/** The business settings the tests change (name, address, phone), read before and written back after. */
interface Business {
  legalName: string;
  address: string;
  phone: string;
}
async function readBusiness(): Promise<Business> {
  const [row] = await laneSql(
    `SELECT JSON_VALUE(value, '$.legalName'), JSON_VALUE(value, '$.address'), JSON_VALUE(value, '$.phone') FROM settings WHERE setting_key = 'business'`
  );
  // a JSON null or an empty text comes back as "NULL" or ""
  const text = (value: string | undefined) =>
    value === undefined || value === 'NULL' ? '' : value;
  return { legalName: text(row?.[0]), address: text(row?.[1]), phone: text(row?.[2]) };
}
async function writeBusiness(business: Business) {
  await laneSql(
    `UPDATE settings SET value = JSON_SET(value, '$.legalName', ${sqlText(business.legalName)}, '$.address', ${sqlText(business.address)}, '$.phone', ${sqlText(business.phone)}) WHERE setting_key = 'business'`
  );
}

// ------------------------------------------------------------------------------------------------ the page

/** Opens a page of the site as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, path: string, ready: () => Promise<void>) {
  await page.goto(path);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await ready();
}

const openEstimates = (page: Page, who: E2eLogin) =>
  open(page, who, '/estimate', () =>
    expect(page.getByRole('heading', { name: 'Saved Estimates' })).toBeVisible({ timeout: 60_000 })
  );

/** Opens one saved estimate the way a person does: find it in the list, press View. */
async function openEstimate(page: Page, billNo: string) {
  if (await page.getByTestId('estimate-number').isVisible()) {
    await page.getByRole('main').getByRole('link', { name: 'Saved Estimates' }).click();
  }
  await page.getByPlaceholder(/Search estimate number/).fill(billNo);
  await page
    .getByTestId('estimate-row')
    .filter({ hasText: billNo })
    .getByRole('link', { name: 'View' })
    .click();
  await expect(page.getByTestId('estimate-number')).toHaveText(billNo);
  // the figures of V1 arrive with the bills (a bill whose summary has not arrived is not listed), so the sheet is whole when it shows
  await expect(page.getByTestId('estimate-grand-total')).not.toHaveText('');
}

/** The words the application's bars show, read off the screen before printing, without the ones the page itself also holds. */
async function barWords(page: Page): Promise<string[]> {
  const words = await page.evaluate(() => {
    const clean = (text: string | null) => (text ?? '').replace(/\s+/g, ' ').trim();
    const main = clean(document.querySelector('main')?.textContent ?? '');
    const bars = [
      ...document.querySelectorAll('aside a, aside button, header a, header button, nav a'),
    ];
    return bars
      .map((el) => clean(el.textContent))
      .filter((text) => text.length >= 4 && !main.includes(text));
  });
  return [...new Set(words)];
}

let saved = 0;
/** What Chromium prints of the page as it is on screen now. With JV_PRINT_PDF_DIR set the PDFs are also written there, to look at them. */
async function printed(page: Page): Promise<PdfPage[]> {
  const bars = await barWords(page);
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const dir = process.env.JV_PRINT_PDF_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    const name = test.info().title.replace(/\W+/g, '-').slice(0, 50);
    writeFileSync(path.join(dir, `${pad(++saved, 3)}-${name}.pdf`), pdf);
  }
  const pages = readPdf(pdf);
  expect(pages.length, 'the PDF could not be read').toBeGreaterThan(0);
  // no app bar on any page of anything that is printed: not one word of the side bar or the top bar (read off the screen) is on the paper
  expect(bars.length, 'the bars were read off the screen').toBeGreaterThan(3);
  for (const [i, page] of pages.entries()) {
    for (const word of bars) {
      expect(countIn(page, word), `"${word}" (an app bar) on page ${i + 1}`).toBe(0);
    }
  }
  return pages;
}

// ---- what is on the paper

// The paper is A4 for both: the page rule `@page { size: A4; margin: 8mm }` of src/styles/tailwind.css. (The estimate's sheet used to ask for an A5 landscape page by name, which Chromium never
// honoured for a box taken out of the flow: the paper was A4 and the sheet a 198 x 136 mm box at its top. The paper stays A4, as printed today; the box is gone.)
const A4 = { width: 595.28, height: 841.89 };

/** The lines of the totals block, in the order they are printed. */
const TOTALS = [
  'Subtotal',
  'Discount',
  'Additional Charges',
  'GST',
  'Grand Total',
  'Received',
  'Pending',
];

/** Index of the last line of the page that starts with the label (white space ignored), or -1. */
function lastLineOf(page: PdfPage, label: string): number {
  const wanted = squash(label);
  for (let i = page.lines.length - 1; i >= 0; i--) {
    if (squash(page.lines[i]).startsWith(wanted)) return i;
  }
  return -1;
}

/** The header row of the lines (Design, SKU, ...): a line that starts with those two words. */
const hasHeaderRow = (page: PdfPage) =>
  page.lines.some((line) => squash(line).toUpperCase().startsWith('DESIGNSKU'));

/**
 * The rules of a printed estimate, for any number of lines:
 *   - the paper is A4, and no page is empty
 *   - every line of the bill is on the paper exactly once
 *   - the header row is on every page that holds lines
 *   - the last page holds the last line, not the totals alone
 *   - "Grand Total" is printed once, on the last page, and the whole totals block is there with it, in order
 */
function checkEstimate(pages: PdfPage[], skus: string[], extraTotals: string[] = []) {
  for (const [i, page] of pages.entries()) {
    expect(page.width, `page ${i + 1} width`).toBeCloseTo(A4.width, 0);
    expect(page.height, `page ${i + 1} height`).toBeCloseTo(A4.height, 0);
    expect(page.lines.length, `page ${i + 1} is empty`).toBeGreaterThan(0);
  }
  for (const sku of skus) {
    const times = pages.reduce((sum, page) => sum + countIn(page, sku), 0);
    expect(times, `${sku} is on the paper once`).toBe(1);
  }
  for (const [i, page] of pages.entries()) {
    if (skus.some((sku) => countIn(page, sku) > 0)) {
      expect(hasHeaderRow(page), `page ${i + 1} holds lines and so the header row`).toBe(true);
    }
  }
  const last = pages[pages.length - 1];
  // the totals never stand alone on a page: the last page holds at least the last line of the bill
  expect(
    skus.length === 0 || countIn(last, skus[skus.length - 1]) > 0,
    'the last page holds the last line, not only the totals'
  ).toBe(true);
  const grandTotals = pages.map((page) => countIn(page, 'Grand Total'));
  expect(
    grandTotals.reduce((a, b) => a + b, 0),
    'Grand Total is printed once'
  ).toBe(1);
  expect(grandTotals[pages.length - 1], 'Grand Total is on the last page').toBe(1);
  const wanted = [...TOTALS.slice(0, 5), ...extraTotals, ...TOTALS.slice(5)];
  const at = wanted.map((label) => lastLineOf(last, label));
  expect(at, `the totals block is whole on the last page (${wanted.join(', ')})`).not.toContain(-1);
  expect(at, 'in the order of the sheet').toEqual([...at].sort((a, b) => a - b));
}

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute and
// starts from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});

let business: Business;
test.beforeAll(async () => {
  business = await readBusiness();
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterAll(async () => {
  await cleanLane();
  await writeBusiness(business);
  // the lane is as it was found: none of this file's customers, bills, receipts or pieces (hydrate.spec's volume case refuses them)
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE 'W13 %'), (SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W13-%'), ` +
      `(SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W13-%'), (SELECT COUNT(*) FROM designs WHERE design_no LIKE 'W13-%'), ` +
      `(SELECT COUNT(*) FROM receipts), (SELECT COUNT(*) FROM sys_counters WHERE series = 'opening')`
  );
  expect(left).toEqual(['0', '0', '0', '0', '0', '0']);
  expect(await readBusiness()).toEqual(business);
});

const lines = (bill: Bill) => bill.lines.map((l) => l.sku);
const bill = (number: string) => books().find((b) => b.number === number)!;

// ------------------------------------------------------------------------------------------------ PT-W13: the estimate

test.describe('PT-W13: the printed estimate flows over as many pages as it needs', () => {
  test.describe.configure({ timeout: 240_000 });

  test('the print shell: no app bars, no fixed height (print media)', async ({ page }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-P06');
    // on screen the application has its side bar, its top bar and a shell of the height of the window
    await expect(page.locator('aside').first()).toBeVisible();
    await expect(page.locator('header').first()).toBeVisible();
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('aside:visible, header:visible, nav:visible')).toHaveCount(0);
    // nothing clips the sheet: the page is as tall as the sheet, whatever the height of the window
    const heights = await page.evaluate(() => {
      const sheet = document.querySelector('.print-estimate-sheet') as HTMLElement;
      const style = getComputedStyle(sheet);
      return {
        maxHeight: style.maxHeight,
        overflow: style.overflow,
        position: style.position,
        page: document.documentElement.scrollHeight,
        sheet: sheet.getBoundingClientRect().height,
        window: window.innerHeight,
      };
    });
    expect(heights.maxHeight).toBe('none');
    expect(heights.overflow).toBe('visible');
    expect(heights.position).not.toBe('absolute');
    expect(heights.page, 'the document is at least as tall as the sheet').toBeGreaterThanOrEqual(
      Math.floor(heights.sheet)
    );
    await page.emulateMedia({ media: null });
  });

  test('1 item: one page, with Grand Total on it', async ({ page }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-P01');
    const pages = await printed(page);
    expect(pages).toHaveLength(1);
    checkEstimate(pages, lines(bill('W13-P01')));
  });

  test('6 items (a bridal sale): every line, the header row and the whole totals block, Grand Total on the last page', async ({
    page,
  }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-P06');
    const pages = await printed(page);
    checkEstimate(pages, lines(bill('W13-P06')));
    // the part payment as the API has it: 10,000 received
    const last = pages[pages.length - 1];
    expect(squash(last.lines[lastLineOf(last, 'Received')])).toBe('Received₹10,000');
  });

  test('40 items: more than one page, the header row on each, Grand Total once, on the last', async ({
    page,
  }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-P40');
    const pages = await printed(page);
    expect(pages.length).toBeGreaterThanOrEqual(2);
    checkEstimate(pages, lines(bill('W13-P40')));
    // the lines run in order over the pages: the first page holds the first line, the last the 40th
    expect(countIn(pages[0], 'W13-S001')).toBe(1);
    expect(countIn(pages[pages.length - 1], 'W13-S040')).toBe(1);
    // the customer and the shop are on the first page, not repeated
    expect(countIn(pages[0], NAMES.retail)).toBe(1);
    expect(pages.slice(1).reduce((sum, p) => sum + countIn(p, NAMES.retail), 0)).toBe(0);
  });

  test('every length from 1 to 40 lines: the totals block is never cut, wherever the lines end', async ({
    page,
  }) => {
    test.setTimeout(900_000);
    await openEstimates(page, e2eLogin('owner'));
    const pageCounts: number[] = [];
    for (let n = 1; n <= 40; n++) {
      const number = `W13-P${pad(n, 2)}`;
      await test.step(number, async () => {
        await openEstimate(page, number);
        const pages = await printed(page);
        pageCounts.push(pages.length);
        checkEstimate(pages, lines(bill(number)));
      });
    }
    // the sweep reaches past one page, so that the end of the lines meets the foot of a page at least once
    expect(Math.max(...pageCounts)).toBeGreaterThan(Math.min(...pageCounts));
    test.info().annotations.push({
      type: 'sweep',
      description: `pages by length 1 to 40: ${pageCounts.join(' ')}`,
    });
  });

  test('a Wholesale silver bill with silver due: the two Fine rows are in the block, the wide table fits', async ({
    page,
  }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-WS06');
    const pages = await printed(page);
    checkEstimate(pages, lines(bill('W13-WS06')), ['Fine Due', 'Fine Pending']);
    // the Labour/g and Labour Total columns of the wholesale sheet are both on the paper
    expect(squash(pages[0].text).toUpperCase()).toContain('LABOUR/G');
    expect(squash(pages[0].text).toUpperCase()).toContain('LABOURTOTAL');
  });

  test('a Retail silver bill (the short table of four columns) prints whole', async ({ page }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-RS03');
    const pages = await printed(page);
    expect(pages).toHaveLength(1);
    checkEstimate(pages, lines(bill('W13-RS03')));
  });

  test('a Per Piece line with a quantity of 3 says so on the paper', async ({ page }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');
    const pages = await printed(page);
    checkEstimate(pages, lines(bill('W13-QTY3')));
    const text = pages.map((p) => p.lines.join('\n')).join('\n');
    expect(squash(text).toUpperCase()).toContain('QTY');
    // the line of the Per Piece piece: its quantity (3) is in the row, and the total is 3 x 1,500 = 4,500
    const row = pages.flatMap((p) => p.lines).find((line) => squash(line).includes('W13-S002'));
    expect(row, 'the row of W13-S002').toBeDefined();
    expect(squash(row ?? '')).toContain('₹4,500');
    expect((row ?? '').split(/\s+/)).toContain('3');
  });

  test('the shop name, address and phone are the Settings (a blank one is not printed)', async ({
    page,
  }) => {
    await writeBusiness({
      legalName: 'W13 Test Jewellers Pvt Ltd',
      address: '12 Sarafa Bazaar\nUjjain 456006',
      phone: '+91 99999 13013',
    });
    try {
      await openEstimates(page, e2eLogin('owner'));
      await openEstimate(page, 'W13-P01');
      const written = await printed(page);
      const first = written[0];
      expect(countIn(first, 'W13 Test Jewellers Pvt Ltd')).toBe(1);
      expect(countIn(first, '12 Sarafa Bazaar')).toBe(1);
      expect(countIn(first, 'Ujjain 456006')).toBe(1);
      expect(countIn(first, '+91 99999 13013')).toBe(1);
      // the name is the Settings', not the constant of the prototype
      expect(countIn(first, 'Jaishri Gold Palace')).toBe(0);
    } finally {
      await writeBusiness(business);
    }
    // the poll brings the restored Settings in; blank address and phone print nothing
    await page.reload();
    await expect(page.getByLabel('Email')).toBeHidden({ timeout: 60_000 });
    await expect(page.getByTestId('estimate-number')).toHaveText('W13-P01', { timeout: 60_000 });
    const blank = await printed(page);
    expect(countIn(blank[0], business.legalName)).toBeGreaterThan(0);
    expect(countIn(blank[0], 'Sarafa')).toBe(0);
    expect(countIn(blank[0], '99999')).toBe(0);
    expect(countIn(blank[0], 'Phone')).toBe(0);
  });
});

// ------------------------------------------------------------------------------------------------ PT-W13: the tag page

// JsBarcode ships no types for its inner modules: its own CODE128 encoder and symbol table are read the way node reads them (the same as tests/unit/tag-barcode.test.ts).
const nodeRequire = createRequire(__filename);
const code128Encoder = nodeRequire('jsbarcode/bin/barcodes').default.CODE128 as new (
  text: string,
  options: Record<string, unknown>
) => { encode(): { data: string } };
const { BARS: CODE128_BARS, STOP: CODE128_STOP } = nodeRequire(
  'jsbarcode/bin/barcodes/CODE128/constants'
) as { BARS: number[]; STOP: number };

/** How many modules the Code 128 of `text` is wide. */
const code128Modules = (text: string) => new code128Encoder(text, {}).encode().data.length;

/** Reads a Code 128 symbol back (one character per module, '1' dark): start, data (sets A, B and C), check symbol, stop. Garbage gives no text and a failed check, never a pass. */
function decodeCode128(bits: string): { text: string; checkOk: boolean } {
  const stop = String(CODE128_BARS[CODE128_STOP]);
  if (!bits.endsWith(stop) || (bits.length - stop.length) % 11 !== 0)
    return { text: '', checkOk: false };
  const valueOf = new Map(CODE128_BARS.map((pattern, value) => [String(pattern), value]));
  const values: number[] = [];
  for (let at = 0; at < bits.length - stop.length; at += 11) {
    const value = valueOf.get(bits.slice(at, at + 11));
    if (value === undefined) return { text: '', checkOk: false };
    values.push(value);
  }
  const start = values[0];
  if (![103, 104, 105].includes(start) || values.length < 3) return { text: '', checkOk: false };
  const check = values[values.length - 1];
  let set = start === 103 ? 'A' : start === 104 ? 'B' : 'C';
  let sum = start;
  let text = '';
  values.slice(1, -1).forEach((value, i) => {
    sum += value * (i + 1);
    if (value === 99) set = 'C';
    else if (value === 100) set = 'B';
    else if (value === 101) set = 'A';
    else if (set === 'C') text += String(value).padStart(2, '0');
    else if (set === 'B') text += String.fromCharCode(value + 32);
    else text += String.fromCharCode(value < 64 ? value + 32 : value - 64);
  });
  return { text, checkOk: sum % 103 === check };
}

async function openTags(page: Page, who: E2eLogin) {
  await open(page, who, '/print-tags', () =>
    expect(page.getByRole('heading', { name: 'Print Tags' })).toBeVisible({ timeout: 60_000 })
  );
  // only this file's pieces: the search narrows the list and the print (the printout follows the filter)
  await page.getByPlaceholder(/Search SKU, design/).fill('W13-T');
  await expect(page.getByRole('button', { name: /Print 42 Tags/ })).toBeVisible();
  // the QR codes are drawn after the page: print when every one has its picture
  await expect(page.locator('.tag-qr-empty')).toHaveCount(0);
}

function checkTags(pages: PdfPage[]) {
  for (const [i, page] of pages.entries()) {
    expect(page.width, `page ${i + 1} width`).toBeCloseTo(A4.width, 0);
    expect(page.height, `page ${i + 1} height`).toBeCloseTo(A4.height, 0);
  }
  // every one of the 42 tags is on the paper (a tag shows its piece number twice: 84 times in all), the first on the first page, the last on the last
  for (const sku of TAGS) {
    const times = pages.reduce((sum, page) => sum + countIn(page, sku), 0);
    expect(times, `${sku} is on the tag`).toBe(2);
  }
  expect(countIn(pages[0], TAGS[0])).toBeGreaterThan(0);
  expect(countIn(pages[pages.length - 1], TAGS[41])).toBeGreaterThan(0);
  expect(pages.length, '42 tags of 58 x 28 mm do not fit on one A4 page').toBeGreaterThan(1);
  // no page without a tag
  for (const [i, page] of pages.entries()) {
    expect(
      TAGS.some((sku) => countIn(page, sku) > 0),
      `page ${i + 1} holds tags`
    ).toBe(true);
  }
}

test.describe('PT-W13: the tag printout has no app bars and runs over as many pages as it needs', () => {
  test.describe.configure({ timeout: 240_000 });

  test('42 tags: all of them, on more than one page, with no bar of the application (owner)', async ({
    page,
  }) => {
    await openTags(page, e2eLogin('owner'));
    // in print media the bars are not displayed at all
    await page.emulateMedia({ media: 'print' });
    await expect(page.locator('aside:visible, header:visible, nav:visible')).toHaveCount(0);
    await page.emulateMedia({ media: null });
    checkTags(await printed(page));
  });

  test('the same for the inventory staff, who are the people who print tags', async ({ page }) => {
    await openTags(page, e2eLogin('staff'));
    checkTags(await printed(page));
  });

  // FB-B1 (Siddhi #9): the tag carries a real Code 128 (drawn by JsBarcode), next to the QR; the old bars drawn from the letters' bits are gone.
  // FB-B final fix: the Code 128 carries the PIECE NUMBER (`W13-T01`), the shorter text, so its bars are wider on a 58 mm tag; the QR and the words above the bars keep the barcode (`W13TB001`).
  test('FB-B1: every tag has exactly one real Code 128 svg that decodes to its piece number, a QR beside it, and none of the old fake bars', async ({
    page,
  }) => {
    await openTags(page, e2eLogin('owner'));
    const codes = page.locator('.print-tag-wrap svg[data-testid="tag-code128"]');
    await expect(codes).toHaveCount(42);
    for (const wrap of await page.locator('.print-tag-wrap').all()) {
      await expect(wrap.locator('svg[data-testid="tag-code128"]')).toHaveCount(1);
      await expect(wrap.locator('.tag-qr')).toHaveCount(1);
    }
    // drawn: the first tag's svg holds bars
    await expect(codes.first().locator('rect').first()).toBeAttached();

    // read the bars of every tag back, module by module (a rect in the svg's group is a run of dark modules, the first rect is the white background; the viewBox is the width in modules), and decode them as a scanner would
    const tags = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.print-tag-wrap')).map((wrap) => {
        const svg = wrap.querySelector('svg[data-testid="tag-code128"]') as SVGElement;
        const modules = Number(svg.getAttribute('viewBox')?.split(' ')[2]);
        const bits = new Array<string>(modules).fill('0');
        svg.querySelectorAll('g rect').forEach((rect) => {
          const x = Number(rect.getAttribute('x'));
          const width = Number(rect.getAttribute('width'));
          for (let at = x; at < x + width; at += 1) bits[at] = '1';
        });
        return {
          bits: bits.join(''),
          piece: wrap.querySelector('.tag-sku')?.textContent ?? '',
          words: wrap.querySelector('.tag-code-text')?.textContent ?? '',
          qr: wrap.querySelector('img.tag-qr')?.getAttribute('alt') ?? '',
        };
      })
    );
    expect(tags).toHaveLength(42);
    const seen = new Set<string>();
    for (const tag of tags) {
      const where = `the tag of ${tag.piece}`;
      expect(TAGS, where).toContain(tag.piece);
      const scanned = decodeCode128(tag.bits);
      expect(scanned.checkOk, `${where}: a good check symbol`).toBe(true);
      expect(scanned.text, `${where}: its Code 128 carries the piece number`).toBe(tag.piece);
      // the barcode of the piece is `W13TB` + the number of the tag; it is not what the bars say, but it is in words above them and in the QR
      expect(tag.words, `${where}: the barcode in words`).toMatch(/^W13TB\d{3}$/);
      expect(scanned.text, `${where}: not the barcode string`).not.toBe(tag.words);
      expect(tag.qr, `${where}: the QR carries the barcode`).toBe(`QR code ${tag.words}`);
      expect(
        tag.bits.length,
        `${where}: fewer modules than the barcode string would take`
      ).toBeLessThan(code128Modules(tag.words));
      seen.add(scanned.text);
    }
    expect(seen.size, 'all 42 tags carry their own piece number').toBe(42);
    // the old fake bars
    await expect(page.locator('.tag-barcode-bars, .tag-barcode-bars span')).toHaveCount(0);
    // and the business name is the Settings', no longer the fixed "JGP"
    await expect(page.locator('.tag-business', { hasText: /^JGP$/i })).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------------------------ FB-B fix: every tag size

// The Settings let the shop set the tag's height (from 13 mm) and the barcode's height to anything. The barcode end of the tag stacks its text, Code 128, QR and number: it must stay inside the
// tag at every size, always with a Code 128 a scanner can read (4 mm or more), keeping the QR and the second piece number only where they fit. The default tag is as FB-B1 made it.
test.describe('FB-B fix: the barcode end of the tag fits every tag size the Settings allow', () => {
  test.describe.configure({ timeout: 300_000 });

  /** The tag template of the lane, as text, to write back. */
  const readTemplate = async () =>
    (await laneSql(`SELECT value FROM settings WHERE setting_key = 'tag_template'`))[0][0];
  const writeTemplate = (heightMm: number, barcodeHeightMm: number) =>
    laneSql(
      `UPDATE settings SET value = JSON_SET(value, '$.heightMm', ${heightMm}, '$.barcodeHeightMm', ${barcodeHeightMm}) WHERE setting_key = 'tag_template'`
    );

  /** What the browser laid out for every tag on the page. */
  const layoutOfTags = (page: Page) =>
    page.evaluate(() => {
      const mm = (px: number) => (px * 25.4) / 96;
      return Array.from(document.querySelectorAll('.print-tag-wrap')).map((wrap) => {
        const end = wrap.querySelector('.print-tag-barcode') as HTMLElement;
        const svg = end.querySelector('svg[data-testid="tag-code128"]') as SVGElement;
        const outer = wrap.getBoundingClientRect();
        const inner = end.getBoundingClientRect();
        const children = Array.from(end.children).map((child) => child.getBoundingClientRect());
        return {
          tagMm: mm(outer.height),
          overflowPx: end.scrollHeight - end.clientHeight,
          lowestChildOverTagPx: Math.max(...children.map((c) => c.bottom)) - outer.bottom,
          highestChildUnderTagPx: outer.top - Math.min(...children.map((c) => c.top)),
          childrenOutsideEndPx: Math.max(
            ...children.map((c) => Math.max(c.bottom - inner.bottom, inner.top - c.top))
          ),
          codeMm: mm(svg.getBoundingClientRect().height),
          codeWidthMm: mm(svg.getBoundingClientRect().width),
          bars: svg.querySelectorAll('rect').length,
          qr: end.querySelectorAll('.tag-qr').length,
          number: end.querySelectorAll('.tag-barcode-number').length,
          codes: end.querySelectorAll('svg[data-testid="tag-code128"]').length,
        };
      });
    });

  test('13 to 40 mm high and a tall barcode: nothing leaves the tag, a Code 128 (4 mm or more) on every tag, the QR only where it fits, the 28 mm tag as before', async ({
    page,
  }) => {
    const original = await readTemplate();
    try {
      const sizes: Array<{ height: number; barcode: number; qr: boolean | null }> = [
        { height: 13, barcode: 8, qr: false },
        { height: 16, barcode: 8, qr: false },
        { height: 20, barcode: 8, qr: false },
        { height: 24, barcode: 8, qr: null }, // either: the layout decides
        { height: 28, barcode: 8, qr: true }, // the default, as FB-B1 made it
        { height: 28, barcode: 30, qr: true }, // a barcode taller than the room is cut to it
        { height: 40, barcode: 8, qr: true },
      ];
      let first = true;
      for (const size of sizes) {
        await writeTemplate(size.height, size.barcode);
        if (first) {
          await openTags(page, e2eLogin('owner'));
          first = false;
        } else {
          await page.reload();
          await expect(page.getByRole('heading', { name: 'Print Tags' })).toBeVisible({
            timeout: 60_000,
          });
          await page.getByPlaceholder(/Search SKU, design/).fill('W13-T');
          await expect(page.getByRole('button', { name: /Print 42 Tags/ })).toBeVisible();
          await expect(page.locator('.tag-qr-empty')).toHaveCount(0);
        }
        const tags = await layoutOfTags(page);
        const where = `tag ${size.height} mm, barcode ${size.barcode} mm`;
        expect(tags, where).toHaveLength(42);
        for (const tag of tags) {
          expect(tag.tagMm, `${where}: the tag is the size asked for`).toBeCloseTo(
            Math.max(size.height, 13),
            0
          );
          expect(tag.codes, `${where}: one Code 128`).toBe(1);
          expect(tag.bars, `${where}: the Code 128 is drawn`).toBeGreaterThan(10);
          expect(tag.codeMm, `${where}: a Code 128 a scanner can read`).toBeGreaterThanOrEqual(3.9);
          expect(tag.codeWidthMm, `${where}: and wide enough`).toBeGreaterThanOrEqual(18);
          expect(tag.overflowPx, `${where}: the barcode end does not overflow`).toBeLessThanOrEqual(
            1
          );
          expect(tag.lowestChildOverTagPx, `${where}: nothing below the tag`).toBeLessThanOrEqual(
            0.5
          );
          expect(tag.highestChildUnderTagPx, `${where}: nothing above the tag`).toBeLessThanOrEqual(
            0.5
          );
          expect(
            tag.childrenOutsideEndPx,
            `${where}: nothing outside the barcode end`
          ).toBeLessThanOrEqual(0.5);
          if (size.qr !== null) expect(tag.qr > 0, `${where}: the QR`).toBe(size.qr);
        }
      }

      // the smallest tag on paper: every tag is there with its Code 128 and its barcode in words, none cut off
      await writeTemplate(13, 8);
      await page.reload();
      await page.getByPlaceholder(/Search SKU, design/).fill('W13-T');
      await expect(page.getByRole('button', { name: /Print 42 Tags/ })).toBeVisible();
      const pages = await printed(page);
      for (let i = 1; i <= 42; i += 1) {
        const words = `W13TB${pad(i, 3)}`;
        const times = pages.reduce((sum, p) => sum + countIn(p, words), 0);
        expect(times, `${words} is on the paper once`).toBe(1);
      }
    } finally {
      await laneSql(
        `UPDATE settings SET value = ${sqlText(original)} WHERE setting_key = 'tag_template'`
      );
    }
  });
});

// ------------------------------------------------------------------------------------------------ FB-D1: the ledger on paper

/** The way the screens write a business date (the Asia/Kolkata day of the instant). */
const dateShown = (instant: number) =>
  new Date(
    `${new Date(instant + 19_800_000).toISOString().slice(0, 10)}T12:00:00.000Z`
  ).toLocaleDateString('en-IN');
/** ₹1,23,456 as the screens write whole rupees. */
const inr = (rupees: number) => `₹${new Intl.NumberFormat('en-IN').format(rupees)}`;

async function openLedger(page: Page, who: E2eLogin, ledger: (typeof LEDGERS)[number]) {
  await open(page, who, '/customer-ledger', () =>
    expect(page.getByRole('heading', { name: 'Customer Ledger' })).toBeVisible({ timeout: 60_000 })
  );
  await page.getByPlaceholder('Search customers...').fill(ledger.name);
  await page.getByRole('button', { name: new RegExp(ledger.name) }).click();
  await expect(page.getByRole('heading', { name: ledger.name, level: 2 })).toBeVisible();
  // the ledger is read from the server once the card is open: every row of it is on the screen before anything is printed
  await expect(page.getByTestId('ledger-row')).toHaveCount(ledger.bills + ledger.payments, {
    timeout: 60_000,
  });
}

/**
 * Presses Print / Save PDF the way a person does. The print dialog is the browser's own, so `window.print` is a stub that counts the calls (page.pdf() below is what Chromium lays out in print
 * media). The stub fires no `afterprint`, so the sheet that the press mounted stays in the page for the PDF.
 */
async function pressPrint(page: Page) {
  await page.evaluate(() => {
    const mine = window as unknown as { __printCalls: number };
    mine.__printCalls = 0;
    window.print = () => {
      mine.__printCalls += 1;
    };
  });
  await page.getByRole('button', { name: 'Print / Save PDF' }).click();
  expect(
    await page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)
  ).toBe(1);
}

test.describe('FB-D1: a customer ledger prints (or is saved) as a PDF', () => {
  test.describe.configure({ timeout: 240_000 });

  // Wave 2 fix 1: the sheet is a second copy of every row, so it is in the page only while something is printing (a ledger of thousands of rows is not drawn twice for a sheet nobody prints).
  test('the card open and nothing printing: the print sheet is not in the page', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'), LEDGERS[1]);
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(0);
    await expect(page.getByTestId('ledger-print-row')).toHaveCount(0);
    // the card's own table is the only table of rows on the screen
    await expect(page.locator('tbody tr')).toHaveCount(LEDGERS[1].bills + LEDGERS[1].payments);
  });

  // A print that catches the card before its sheet is drawn is the card as it is on the screen, not a blank page: the card hides its parts for paper only when its sheet is in the page. (page.pdf()
  // fires `beforeprint` itself, as the browser's print does, so the sheet is drawn for it; the state without the sheet is looked at here in print media, where `beforeprint` is not fired.)
  test('a print with no sheet in the page shows the card, and with the sheet in the page shows only the sheet', async ({
    page,
  }) => {
    const { name } = LEDGERS[1];
    await openLedger(page, e2eLogin('owner'), LEDGERS[1]);
    await page.emulateMedia({ media: 'print' });
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(0);
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    await expect(page.getByTestId('ledger-row').first()).toBeVisible();
    // the sheet comes in, and then the card gives way to it
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page.getByTestId('ledger-print-sheet')).toBeVisible();
    await expect(page.getByTestId('ledger-print-row').first()).toBeVisible();
    await expect(page.getByRole('heading', { name, level: 2 })).toBeHidden();
    await expect(page.getByTestId('ledger-row').first()).toBeHidden();
    // and it goes again with the print
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(0);
    await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    await page.emulateMedia({ media: null });
  });

  test("the browser's own print (Ctrl/Cmd+P, the menu) brings the sheet in and takes it out again", async ({
    page,
  }) => {
    const rows = LEDGERS[1].bills + LEDGERS[1].payments;
    await openLedger(page, e2eLogin('owner'), LEDGERS[1]);
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(0);
    await page.evaluate(() => window.dispatchEvent(new Event('beforeprint')));
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(1);
    await expect(page.getByTestId('ledger-print-row')).toHaveCount(rows);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(0);
    // and the button's own print goes the same way: the sheet is there at the call, and gone at the `afterprint`
    await pressPrint(page);
    await expect(page.getByTestId('ledger-print-row')).toHaveCount(rows);
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(page.getByTestId('ledger-print-sheet')).toHaveCount(0);
  });

  for (const ledger of LEDGERS) {
    const rows = ledger.bills + ledger.payments;
    test(`${rows} ledger ${rows === 1 ? 'row' : 'rows'}: the customer first, the Balance last, every row once, no application bar`, async ({
      page,
    }) => {
      await openLedger(page, e2eLogin('owner'), ledger);
      // the button asks the browser to print, and the sheet is in the page for it (the print dialog itself is the browser's; the PDF is what Chromium lays out in print media)
      await pressPrint(page);
      await expect(page.getByTestId('ledger-print-row')).toHaveCount(rows);
      // on the screen the sheet is not seen
      await expect(page.getByTestId('ledger-print-row').first()).toBeHidden();

      const pages = await printed(page);
      for (const [i, one] of pages.entries()) {
        expect(one.width, `page ${i + 1} width`).toBeCloseTo(A4.width, 0);
        expect(one.height, `page ${i + 1} height`).toBeCloseTo(A4.height, 0);
      }
      // the customer, their mobile, the shop and the day, on the first page
      expect(countIn(pages[0], ledger.name), 'the customer is named on page 1').toBeGreaterThan(0);
      expect(countIn(pages[0], ledger.mobile)).toBeGreaterThan(0);
      expect(countIn(pages[0], business.legalName || 'Jaishri Gold Palace')).toBeGreaterThan(0);
      expect(countIn(pages[0], `As of ${dateShown(Date.now())}`)).toBe(1);

      // every row of the ledger is on the paper exactly once, in order, and the header row is on every page that holds rows
      for (let j = 1; j <= ledger.bills; j++) {
        const number = billNoOf(ledger.key, j);
        expect(
          pages.reduce((sum, one) => sum + countIn(one, `Invoice ${number}`), 0),
          `${number} is on the paper once`
        ).toBe(1);
      }
      const rowPages = pages.filter((one) => countIn(one, 'Invoice W13-L') > 0);
      for (const one of rowPages)
        expect(hasLedgerHeader(one), 'the header row is on a page of rows').toBe(true);
      if (rows > 60)
        expect(pages.length, '120 rows run over more than one page').toBeGreaterThan(1);

      // the Balance, with the right figure, on the last page; the totals are not alone on it (the last row is there too)
      const last = pages[pages.length - 1];
      const owed = ledgerBalance(ledger);
      expect(
        squash(last.lines[lastLineOf(last, 'Balance')] ?? ''),
        'Balance on the last page'
      ).toBe(`Balance${inr(owed)}`);
      expect(
        last.lines.filter((line) => /^\d{2}\/\d{2}\/\d{4}/.test(squash(line))).length,
        'the totals are not alone on the last page: a row of the ledger is there too'
      ).toBeGreaterThan(0);
      // and nowhere else
      expect(pages.slice(0, -1).reduce((sum, one) => sum + lastLineOf(one, 'Balance') + 1, 0)).toBe(
        0
      );
      const debit = Array.from({ length: ledger.bills }, (_, j) => billRupees(j + 1)).reduce(
        (a, b) => a + b,
        0
      );
      expect(squash(last.lines[lastLineOf(last, 'Total Debit')] ?? '')).toBe(
        `TotalDebit${inr(debit)}`
      );
      expect(lastLineOf(last, 'Total Credit')).toBeGreaterThan(-1);
      expect(lastLineOf(last, 'Silver Fine Balance')).toBeGreaterThan(-1);
    });
  }

  test('the same sheet prints from the other tabs of the card, and the biller can print too', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('biller'), LEDGERS[0]);
    await page.getByRole('button', { name: /^Invoices/ }).click();
    await pressPrint(page);
    const pages = await printed(page);
    expect(countIn(pages[0], LEDGERS[0].name)).toBeGreaterThan(0);
    expect(countIn(pages[0], `Invoice ${billNoOf('one', 1)}`)).toBe(1);
  });
});

/** The header row of the ledger sheet: a line that starts with Date and Type. */
const hasLedgerHeader = (one: PdfPage) =>
  one.lines.some((line) => squash(line).toUpperCase().startsWith('DATETYPE'));

// FB-D fix: the phone width of the plan, 375 x 812. A customer's card opens, Print / Save PDF and the buttons beside it are whole inside the screen and take a tap (the tap calls the browser's
// print), and the page does not scroll sideways.
test.describe('FB-D fix: the customer ledger and its Print / Save PDF at 375 x 812', () => {
  test.use({ viewport: PHONE });
  test.describe.configure({ timeout: 240_000 });

  test('the card and its buttons fit the phone, Print / Save PDF takes a tap, no sideways scroll', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'), LEDGERS[1]);
    await page.evaluate(() => {
      const mine = window as unknown as { __printCalls: number };
      mine.__printCalls = 0;
      window.print = () => {
        mine.__printCalls += 1;
      };
    });
    const print = page.getByRole('button', { name: 'Print / Save PDF' });
    for (const name of ['Receive Payment', 'Hand Money Back', 'Opening Balance']) {
      await expectTappable(page.getByRole('button', { name, exact: true }));
    }
    await expectTappable(print);
    await expectNoSidewaysScroll(page);
    await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
    await page.getByRole('heading', { name: LEDGERS[1].name, level: 2 }).scrollIntoViewIfNeeded();
    await shoot(page, 'ledger-card');
    await print.click();
    expect(
      await page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)
    ).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ PDF-S1: the estimate as a PDF file

/** What the share menu of the page was handed: one entry per call of `navigator.share`. */
interface SharedCall {
  title: string;
  files: { name: string; type: string; size: number }[];
}

/**
 * A share menu that is always there: `navigator.canShare` says yes to PDF files, and `navigator.share` keeps what it was handed on `window.__shared` and answers as `answers` says, one call
 * after the other: `ok`, or the name of the DOMException it throws (`NotAllowedError`: the browser refused the tap). Once the answers run out it answers `ok`. Put in before the page opens.
 */
async function stubShare(page: Page, answers: string[] = []) {
  await page.addInitScript((answers) => {
    const mine = window as unknown as { __shared: SharedCall[] };
    mine.__shared = [];
    const left = [...answers];
    const pdfsOnly = (data?: ShareData) =>
      (data?.files ?? []).length > 0 &&
      (data?.files ?? []).every((file) => file.type === 'application/pdf');
    Object.defineProperty(Navigator.prototype, 'canShare', {
      configurable: true,
      value: (data?: ShareData) => pdfsOnly(data),
    });
    Object.defineProperty(Navigator.prototype, 'share', {
      configurable: true,
      value: async (data: ShareData) => {
        mine.__shared.push({
          title: data.title ?? '',
          files: (data.files ?? []).map((file) => ({
            name: file.name,
            type: file.type,
            size: file.size,
          })),
        });
        const answer = left.shift() ?? 'ok';
        if (answer !== 'ok') throw new DOMException('the stub says no', answer);
      },
    });
  }, answers);
}

const sharedCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __shared: SharedCall[] }).__shared);

/** Presses Download PDF and waits for the file the browser saves. With JV_PRINT_PDF_DIR set the file is also written there, to look at it. */
async function pressDownloadPdf(page: Page): Promise<{ name: string; bytes: Uint8Array }> {
  const saving = page.waitForEvent('download', { timeout: 120_000 });
  await page.getByTestId('estimate-pdf-download').click();
  const download = await saving;
  const bytes = new Uint8Array(readFileSync(await download.path()));
  const dir = process.env.JV_PRINT_PDF_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `pdf-${download.suggestedFilename()}`), bytes);
  }
  return { name: download.suggestedFilename(), bytes };
}

/**
 * The print's table and totals as the page holds them, a row to an entry: every row of `.print-estimate-lines` (the words of its `th` or `td` cells) and every line of
 * `.print-estimate-totals`, with the white space taken out. The table is hidden on the screen (it is the paper's), but it is in the page.
 */
async function printRows(page: Page): Promise<{ lines: string[]; totals: string[] }> {
  const rows = await page.evaluate(() => ({
    lines: [...document.querySelectorAll('.print-estimate-lines tr')].map((row) =>
      [...row.querySelectorAll('th, td')].map((cell) => cell.textContent ?? '').join(' ')
    ),
    totals: [...document.querySelectorAll('.print-estimate-totals > div')].map(
      (line) => line.textContent ?? ''
    ),
  }));
  return { lines: rows.lines.map(compact), totals: rows.totals.map(compact) };
}

test.describe('PDF-S1: the estimate as a PDF file', () => {
  test.describe.configure({ timeout: 240_000 });

  test('Download PDF saves a PDF file named after the bill and its customer', async ({ page }) => {
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');
    await expect(page.getByTestId('estimate-pdf-download')).toHaveText('Download PDF');
    const { name, bytes } = await pressDownloadPdf(page);
    expect(name).toBe(`W13-QTY3 - ${NAMES.retail}.pdf`);
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');
    // the buttons are back, and nothing went wrong
    await expect(page.getByTestId('estimate-pdf-download')).toBeEnabled();
    await expect(page.getByTestId('estimate-pdf-progress')).toHaveCount(0);
    await expect(page.getByTestId('estimate-pdf-error')).toHaveCount(0);
    // the screen's own print is still there, under its new name
    await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toHaveCount(0);
  });

  // The PDF is drawn again in code (src/lib/pdf/estimatePdf.ts), so it is held to the print: what the print shows of the lines and the totals, read off the page, is in the file.
  // The PDF draws the table's headings in capitals, as the print's CSS does, while the page's own words are mixed case: the two are compared in capitals.
  for (const number of ['W13-QTY3', 'W13-WS06']) {
    test(`${number}: every row of the print's table and totals is in the PDF, word for word`, async ({
      page,
    }) => {
      await openEstimates(page, e2eLogin('owner'));
      await openEstimate(page, number);
      const print = await printRows(page);
      const fine = number === 'W13-WS06' ? 2 : 0;
      expect(print.lines, 'the header row and every line').toHaveLength(
        1 + bill(number).lines.length
      );
      expect(print.totals, 'the totals block').toHaveLength(TOTALS.length + fine);

      const { bytes } = await pressDownloadPdf(page);
      const pdf = await readMadePdf(bytes);
      const text = compact(pdf.pages.join('\n')).toUpperCase();
      for (const row of [...print.lines, ...print.totals]) {
        expect(text, `the PDF holds "${row}"`).toContain(row.toUpperCase());
      }
      // the bill's own columns are among them: the Qty of the Per Piece line, the two labour columns of the Wholesale table
      if (number === 'W13-QTY3') expect(print.lines[0].toUpperCase()).toContain('QTY');
      if (number === 'W13-WS06') {
        expect(print.lines[0].toUpperCase()).toContain('LABOUR/GLABOURTOTAL');
        expect(print.totals.some((row) => row.startsWith('FineDue'))).toBe(true);
      }
    });
  }

  test('Share hands the share menu one PDF file, with the same name', async ({ page }) => {
    await stubShare(page);
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');
    const share = page.getByTestId('estimate-pdf-share');
    await expect(share).toHaveText('Share');
    await share.click();
    await expect.poll(async () => (await sharedCalls(page)).length, { timeout: 120_000 }).toBe(1);
    const [call] = await sharedCalls(page);
    expect(call.title).toBe('Estimate W13-QTY3');
    expect(call.files).toHaveLength(1);
    expect(call.files[0].name).toBe(`W13-QTY3 - ${NAMES.retail}.pdf`);
    expect(call.files[0].type).toBe('application/pdf');
    expect(call.files[0].size).toBeGreaterThan(1000);
    // shared: the buttons are as they were
    await expect(share).toBeVisible();
    await expect(page.getByTestId('estimate-pdf-send')).toHaveCount(0);
    await expect(page.getByTestId('estimate-pdf-error')).toHaveCount(0);
  });

  test('where the browser cannot share a file there is no Share button, and Download PDF still works', async ({
    page,
  }) => {
    await page.addInitScript(() => {
      const proto = Navigator.prototype as unknown as Record<string, unknown>;
      delete proto.share;
      delete proto.canShare;
    });
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');
    expect(await page.evaluate(() => 'share' in navigator || 'canShare' in navigator)).toBe(false);
    await expect(page.getByTestId('estimate-pdf-download')).toBeVisible();
    await expect(page.getByTestId('estimate-pdf-share')).toHaveCount(0);
    const { name } = await pressDownloadPdf(page);
    expect(name).toBe(`W13-QTY3 - ${NAMES.retail}.pdf`);
    await expect(page.getByTestId('estimate-pdf-share')).toHaveCount(0);
  });

  test('the fonts are fetched only after the tap: none with the page, the Latin pair with the first PDF', async ({
    page,
  }) => {
    const fonts: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.startsWith('/fonts/')) fonts.push(pathname);
    });
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');
    expect(fonts, 'no font before the tap').toEqual([]);
    await pressDownloadPdf(page);
    expect(fonts).toContain('/fonts/NotoSans-Regular.ttf');
    expect(fonts).toContain('/fonts/NotoSans-Bold.ttf');
    // nothing on this bill is Hindi, so the Hindi pair is not fetched
    expect(fonts.filter((font) => font.includes('Devanagari'))).toEqual([]);
  });

  test('Stop while the PDF is being made: the buttons come back and nothing is saved', async ({
    page,
  }) => {
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    // the fonts are held, so the PDF stays in the making until the test lets them go
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    await page.route('**/fonts/*.ttf', async (route) => {
      await held;
      await route.continue();
    });
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');

    await page.getByTestId('estimate-pdf-download').click();
    await expect(page.getByTestId('estimate-pdf-progress')).toHaveText('Making PDF…');
    await expect(page.getByTestId('estimate-pdf-progress')).toHaveAttribute('role', 'status');
    const stop = page.getByTestId('estimate-pdf-stop');
    await expect(stop).toHaveText('Stop');
    await stop.click();
    await expect(page.getByTestId('estimate-pdf-progress')).toHaveCount(0);
    await expect(stop).toHaveCount(0);
    await expect(page.getByTestId('estimate-pdf-download')).toBeEnabled();

    // the fonts arrive after Stop: the stopped PDF is not saved, and the next tap saves one file
    release();
    const { name } = await pressDownloadPdf(page);
    expect(name).toBe(`W13-QTY3 - ${NAMES.retail}.pdf`);
    await page.waitForTimeout(1_500);
    expect(downloads, 'one file: the stopped PDF was never saved').toBe(1);
  });

  test('a share the browser refuses (a slow make) leaves Send PDF, and one more tap shares; a share that fails says so', async ({
    page,
  }) => {
    await stubShare(page, ['NotAllowedError', 'ok', 'DataError']);
    await openEstimates(page, e2eLogin('owner'));
    await openEstimate(page, 'W13-QTY3');

    await page.getByTestId('estimate-pdf-share').click();
    const send = page.getByTestId('estimate-pdf-send');
    await expect(send).toHaveText('Send PDF', { timeout: 120_000 });
    await expect(page.getByTestId('estimate-pdf-share')).toHaveCount(0);
    await send.click();
    await expect.poll(async () => (await sharedCalls(page)).length).toBe(2);
    await expect(send).toHaveCount(0);
    await expect(page.getByTestId('estimate-pdf-share')).toBeVisible();
    const calls = await sharedCalls(page);
    expect(calls[1].files.map((file) => file.name)).toEqual([`W13-QTY3 - ${NAMES.retail}.pdf`]);
    expect(calls[1].files[0].size).toBe(calls[0].files[0].size);

    // the third share fails for a reason of its own: the person is told, and Download PDF is still there
    await page.getByTestId('estimate-pdf-share').click();
    const error = page.getByTestId('estimate-pdf-error');
    await expect(error).toHaveText('The PDF could not be shared. Please use Download PDF.', {
      timeout: 120_000,
    });
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('estimate-pdf-download')).toBeEnabled();
    // a new PDF takes the message away
    await pressDownloadPdf(page);
    await expect(error).toHaveCount(0);
  });

  test.describe('at 375 x 812', () => {
    test.use({ viewport: PHONE });

    test('Download PDF, Share, Print and the bar beside them take a tap, no sideways scroll', async ({
      page,
    }) => {
      await stubShare(page);
      await openEstimates(page, e2eLogin('owner'));
      await openEstimate(page, 'W13-QTY3');
      const controls = [
        page.getByTestId('estimate-pdf-download'),
        page.getByTestId('estimate-pdf-share'),
        page.getByRole('button', { name: 'Print', exact: true }),
        page.getByRole('main').getByRole('link', { name: 'Saved Estimates' }),
        page.getByTestId('reissue-bill'),
        page.getByTestId('cancel-bill'),
      ];
      for (const control of controls) {
        await expectTappable(control);
        // a button stays one line (FB-A2): squeezed into a row, words used to wrap onto two and three lines
        expect((await control.boundingBox())!.height).toBeLessThanOrEqual(44);
      }
      await expectNoSidewaysScroll(page);
      await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
      await shoot(page, 'estimate-pdf-buttons');
    });
  });
});
