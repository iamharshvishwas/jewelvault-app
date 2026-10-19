import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
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
  // what the money services do on every bill (D23): the customer gets a new `updated_at`, which is how the polls find the change
  sql.push(`UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name LIKE 'W13 %';`);
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
});
