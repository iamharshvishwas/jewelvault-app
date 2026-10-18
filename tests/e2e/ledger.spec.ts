import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB10 (PT-W10): the saved estimate, the customer card and the customer's ledger on the API, in a real browser against the real API of a lane (spec C1, C14, I4, K1, V1 to V3, Y8, C15).
//   PT-W10  after a bill, a part payment and a fine settlement the rows of the ledger, the estimate and the card show the same pending, advance and silver figures, and the last running
//           balance equals the card's balance; the estimate has no date editor and no edit mode
//   and every kind of row V3 has (Opening, Invoice, Cancellation, Payment, Opening advance, Fine, Refund, Void), made by the real functions of the API, on screen as V3 has them
//
// Every figure on a screen is compared with the derived queries of the API checkout (db/queries/V1, V2 and V3, run in the lane's container) AND with figures worked out by hand in the
// comments. The bills are written as root (the billing screen that makes them is proved in billing.spec.ts); the payment and the silver settlement of the first test are made through the
// payment panel, the rest (opening balances, a void, a cancel, a refund) through the API's own routes by the owner's session, so every ledger row is one the API made.
// Everything the tests made is taken out again: the volume case of hydrate.spec.ts refuses a lane that holds a bill, a receipt or a counter that moved with no bill behind it.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/ledger.spec.ts

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/** SQL as root in the lane's container. The password never leaves the container: the shell inside it reads it from its own environment. */
async function laneSql(sql: string): Promise<string[][]> {
  const { stdout } = await execFileAsync(
    'docker',
    [
      'exec',
      laneContainer(),
      'sh',
      '-c',
      'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" jv_lane -N -B -e "$1"',
      'sh',
      sql,
    ],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  return stdout
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));
}

/** A query of the API checkout (db/queries/<name>.sql) as one statement: the comment lines are taken out, the way the API's read layer does. */
function derivedQuery(name: 'V1_bill_summary' | 'V2_customer_balances' | 'V3_customer_ledger') {
  const dir = process.env.JV_API_DIR;
  if (!dir) throw new Error('JV_API_DIR is not set.');
  const text = readFileSync(path.join(dir, 'db', 'queries', `${name}.sql`), 'utf8');
  return text
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .trim()
    .replace(/;\s*$/, '');
}

/** V1 of one bill as the database works it out: bill, grand total, received, pending, silver due, settled and pending, status. */
const v1Of = async (billNo: string) =>
  (
    await laneSql(
      `SELECT bill_no, grand_total, received, pending, fine_due, fine_settled, fine_pending, payment_status FROM (${derivedQuery('V1_bill_summary')}) v WHERE bill_no = '${billNo}'`
    )
  )[0];

/** V2 of one customer: billed, purchases, received, refunded, outstanding, advance, balance, silver outstanding, silver advance, silver balance. */
const v2Of = async (name: string) =>
  (
    await laneSql(
      `SELECT billed, total_purchases, received, refunded, outstanding, advance, balance, fine_outstanding, fine_advance, fine_balance FROM (${derivedQuery('V2_customer_balances')}) v ` +
        `WHERE id = (SELECT id FROM customers WHERE name = '${name}')`
    )
  )[0];

/** V3 of one customer in its order key: kind, debit, credit, balance, silver in, silver out, silver balance. Not ordered by the random id alone: the key is the API's own. */
const v3Of = async (name: string) =>
  laneSql(
    `SELECT kind, debit, credit, balance, fine_debit, fine_credit, fine_balance FROM (${derivedQuery('V3_customer_ledger')}) v ` +
      `WHERE customer_id = (SELECT id FROM customers WHERE name = '${name}') ORDER BY entry_date, entry_at, kind_rank, id`
  );

// ------------------------------------------------------------------------------------------------ the book of the tests

const ids = {
  meera: randomUUID(),
  asha: randomUUID(),
  dev: randomUUID(),
  gita: randomUUID(),
  design: randomUUID(),
  piece: randomUUID(),
  bills: {
    m1: randomUUID(), // W10-0001 Meera 3,000.00 with 6.000 g of silver due
    a1: randomUUID(), // W10-0002 Asha 1,000.00
    d1: randomUUID(), // W10-0003 Dev 2,000.00
    d2: randomUUID(), // W10-0004 Dev 1,500.00, cancelled in the third test
  },
};
const NAMES = { meera: 'W10 Meera', asha: 'W10 Asha', dev: 'W10 Dev', gita: 'W10 Gita' };

/** The date a bill of the fixture carries (written by the database's own CURDATE()). */
const billDateOf = async (billNo: string) =>
  (await laneSql(`SELECT bill_date FROM bills WHERE bill_no = '${billNo}'`))[0][0];

/** The business date (Asia/Kolkata) `daysAgo` days before today, as the API works it out. */
function kolkataDate(daysAgo = 0): string {
  return new Date(Date.now() + 19_800_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}
/** The way the screens write a business date. */
const dateShown = (day: string) => new Date(`${day}T12:00:00.000Z`).toLocaleDateString('en-IN');

function fixtureSql(): string {
  const customer = (id: string, name: string, type: string, mobile: string) =>
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${id}', '${name}', '${mobile}', '${type}');`;
  // each bill is made at a minute of its own, around noon UTC (the same calendar day in every time zone a browser can be in), so that the order key of V3 never has to fall back to the random id
  const bill = (
    id: string,
    number: string,
    customerId: string,
    daysAgo: number,
    money: string,
    type: string,
    fine = '0.000'
  ) =>
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total, fine_weight_due, created_at) VALUES ` +
    `('${id}', '${number}', '${customerId}', CURDATE() - INTERVAL ${daysAgo} DAY, '${type}', ${money}, ${money}, ${fine}, ` +
    `TIMESTAMP(CURDATE() - INTERVAL ${daysAgo} DAY, '12:0${daysAgo}:00'));`;
  return [
    customer(ids.meera, NAMES.meera, 'Wholesale', '9000100001'),
    customer(ids.asha, NAMES.asha, 'Retail', '9000100002'),
    customer(ids.dev, NAMES.dev, 'Retail', '9000100003'),
    customer(ids.gita, NAMES.gita, 'Retail', '9000100004'),
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.design}', 'W10-D1', 'W10 silver anklet', id, 'Silver', '925', 'By Weight' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.piece}', '${ids.design}', 'W10-S1', 'W10BC1', 124.500, 120.000, 'In Stock');`,
    bill(ids.bills.m1, 'W10-0001', ids.meera, 1, '3000.00', 'Wholesale', '6.000'),
    `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
      `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) VALUES ` +
      `('${randomUUID()}', '${ids.bills.m1}', 1, '${ids.piece}', 'W10-D1', 'W10-S1', 'Anklet', 'Silver', '925', 'By Weight', 124.500, 120.000, 1, 25.00, 0.00, 0.00, 0.00, 0.00, 3000.00, 6.000, 3000.00, 25.00, NULL);`,
    bill(ids.bills.a1, 'W10-0002', ids.asha, 1, '1000.00', 'Retail'),
    bill(ids.bills.d1, 'W10-0003', ids.dev, 3, '2000.00', 'Retail'),
    bill(ids.bills.d2, 'W10-0004', ids.dev, 2, '1500.00', 'Retail'),
    // what the money services do on every bill (D23): the customer gets a new `updated_at`, which is how the polls find the change
    `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name LIKE 'W10 %';`,
  ].join(' ');
}

/** Everything these tests made, gone again. The delete order follows the foreign keys. */
async function cleanLane() {
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W10 %'); ` +
      `DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W10 %'); ` +
      `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W10 %')); ` +
      `DELETE FROM bills WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W10 %'); ` +
      `DELETE FROM customers WHERE name LIKE 'W10 %'; ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W10-%'; DELETE FROM designs WHERE design_no LIKE 'W10-%';`
  );
  // X12 makes the counter row of the opening series (and moves it); deleting the opening bills does not take it away. The API's seed-volume tool, which the volume case of hydrate.spec.ts
  // runs, refuses a counter that moved with no number issued above its seed (invariant I5): the row goes again when no opening bill of a function is left, as a fresh lane has it.
  await laneSql(
    `DELETE FROM sys_counters WHERE series = 'opening' AND NOT EXISTS ` +
      `(SELECT 1 FROM bills b WHERE b.doc_type = 'opening_balance' AND b.import_batch_id IS NULL)`
  );
}

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();

/** Opens the customer ledger as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin) {
  await page.goto('/customer-ledger');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'Customer Ledger' })).toBeVisible();
}

async function openCard(page: Page, name: string) {
  await page.getByPlaceholder('Search customers...').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function openPanel(page: Page, name: string) {
  await page.getByRole('button', { name: 'Receive Payment', exact: true }).click();
  await expect(page.getByTestId('payment-panel')).toContainText(name);
}

/** A call to the API by the signed-in person's own session (the cookie is HttpOnly: only the page can send it). The answer is the status and the body. */
async function apiCall(page: Page, route: string, body: unknown) {
  const { apiUrl } = e2eLane();
  return page.evaluate(
    async ({ url, payload, key }) => {
      const response = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          'x-jv-client': 'web',
          'idempotency-key': key,
        },
        body: JSON.stringify(payload),
      });
      return {
        status: response.status,
        body: (await response.json().catch(() => null)) as unknown,
      };
    },
    { url: `${apiUrl}${route}`, payload: body, key: randomUUID() }
  );
}

// ---- reading the screens

/** A figure of the card ("Outstanding" ...) by its test id. */
const card = (page: Page, key: string) => page.getByTestId(key);

type Cells = string[];
const cellsOf = (page: Page, testId: string): Promise<Cells[]> =>
  page
    .getByTestId(testId)
    .evaluateAll((rows) =>
      rows.map((row) =>
        [...row.querySelectorAll('td')].map((cell) =>
          (cell.textContent ?? '').replace(/\s+/g, ' ').trim()
        )
      )
    );

// ---- the way the screens write the database's text (independent of the application's own formatter)

const indian = (text: string) => {
  const n = Math.abs(Number(text));
  return new Intl.NumberFormat('en-IN', {
    minimumFractionDigits: Number.isInteger(n) ? 0 : 2,
    maximumFractionDigits: 2,
  }).format(n);
};
/** An amount: ₹22,000 or ₹1,000.50 (a minus sign in front for a negative one). */
const rupees = (text: string) => `${Number(text) < 0 ? '-' : ''}₹${indian(text)}`;
/** A running balance: the rupees owed, or the advance held in words. */
const balance = (text: string) =>
  Number(text) < 0 ? `₹${indian(text)} advance` : `₹${indian(text)}`;
/** The debit or credit column: a dash for nothing. */
const column = (text: string) => (Number(text) === 0 ? '—' : `₹${indian(text)}`);
/** The silver columns: a dash for nothing, else grams. */
const silver = (text: string) => (Number(text) === 0 ? '-' : `${text} g`);
const silverBalance = (text: string) =>
  Number(text) < 0 ? `${text.slice(1)} g advance` : `${text} g`;
const KIND_SHOWN: Record<string, string> = {
  Invoice: 'Invoice',
  Opening: 'Opening balance',
  Cancellation: 'Cancellation',
  Payment: 'Payment',
  'Opening advance': 'Opening advance',
  Fine: 'Fine',
  Refund: 'Refund',
  Void: 'Void',
};

/** The rows of V3 as the ledger table shows them: type, debit, credit, balance, silver in, silver out, silver balance. */
const ledgerShown = (v3: string[][]) =>
  v3.map(([kind, debit, credit, running, fineIn, fineOut, fineRunning]) => [
    KIND_SHOWN[kind],
    column(debit),
    column(credit),
    balance(running),
    silver(fineIn),
    silver(fineOut),
    silverBalance(fineRunning),
  ]);

/** What the ledger table on the screen holds: the same seven columns of every row, and the foot. */
async function ledgerOnScreen(page: Page) {
  const rows = (await cellsOf(page, 'ledger-row')).map((cells) => [cells[1], ...cells.slice(4)]);
  const foot = (await cellsOf(page, 'ledger-total'))[0];
  return { rows, foot };
}

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute and
// starts from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterEach(async () => {
  await cleanLane();
});
test.afterAll(async () => {
  // the lane is as it was found: none of this file's customers, bills or receipts, and no opening counter that moved with no opening bill behind it (hydrate.spec's volume case refuses one)
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE 'W10 %'), ` +
      `(SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W10-%' OR doc_type = 'opening_balance'), ` +
      `(SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W10-%'), ` +
      `(SELECT COUNT(*) FROM sys_counters WHERE series = 'opening')`
  );
  expect(left).toEqual(['0', '0', '0', '0']);
});

// ------------------------------------------------------------------------------------------------ PT-W10

test.describe('PT-W10: a bill, a part payment and a silver settlement: the ledger, the estimate and the card agree', () => {
  test.describe.configure({ timeout: 240_000 });

  test('Meera: 3,000 and 6 g of silver billed, 1,000 paid, 2.5 g of silver received: pending 2,000, silver 3.5 g, balance 2,000 on all three', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.meera);

    // before: the bill only (by hand: owes 3,000 and 6 g)
    await expect(card(page, 'cs-outstanding')).toHaveText('₹3,000');
    await expect(card(page, 'cs-advance')).toHaveText('₹0');
    await expect(card(page, 'cs-balance')).toHaveText('₹3,000');
    await expect(card(page, 'cs-fine')).toHaveText('6.000 g');
    await expect(page.getByTestId('ledger-row')).toHaveCount(1);

    // a part payment through the panel: 1,000 by UPI on the bill, then 2.5 g of silver received
    await openPanel(page, NAMES.meera);
    await page.getByTestId('payment-amount').fill('1000');
    await page.getByTestId('payment-mode').selectOption('UPI');
    await page.getByTestId('save-payment').click();
    await expect(page.getByTestId('payment-saved')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('payment-remaining')).toContainText('₹2,000.00', {
      timeout: 15_000,
    });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await openPanel(page, NAMES.meera);
    await page.getByTestId('payment-type').selectOption('Fine Silver');
    await page.getByTestId('fine-grams').fill('2.5');
    await page.getByTestId('save-payment').click();
    await expect(page.getByTestId('fine-saved')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fine-remaining')).toContainText('3.500 g');
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // BY HAND: billed 3,000 and 6.000 g; received 1,000; silver received 2.500 g; so outstanding 2,000, advance 0, balance 2,000, silver outstanding 3.500 g, silver balance 3.500 g
    const v2 = await v2Of(NAMES.meera);
    expect(v2).toEqual([
      '3000.00', // billed
      '3000.00', // total_purchases
      '1000.00', // received
      '0.00', // refunded
      '2000.00', // outstanding
      '0.00', // advance
      '2000.00', // balance
      '3.500', // fine_outstanding
      '0.000', // fine_advance
      '3.500', // fine_balance
    ]);
    expect(await v1Of('W10-0001')).toEqual([
      'W10-0001',
      '3000.00',
      '1000.00',
      '2000.00',
      '6.000',
      '2.500',
      '3.500',
      'Partial',
    ]);

    // THE CARD is V2
    await expect(card(page, 'cs-purchases')).toHaveText(rupees(v2[1]));
    await expect(card(page, 'cs-received')).toHaveText(rupees(v2[2]));
    await expect(card(page, 'cs-outstanding')).toHaveText(rupees(v2[4]), { timeout: 15_000 });
    await expect(card(page, 'cs-advance')).toHaveText(rupees(v2[5]));
    await expect(card(page, 'cs-balance')).toHaveText(balance(v2[6]));
    await expect(card(page, 'cs-fine')).toHaveText(`${v2[7]} g`);
    await expect(card(page, 'cs-fine-balance')).toHaveText(silverBalance(v2[9]));

    // THE LEDGER is V3, row by row, and its last balance is the card's balance
    const v3 = await v3Of(NAMES.meera);
    expect(v3.map((r) => r[0])).toEqual(['Invoice', 'Payment', 'Fine']);
    expect(v3.map((r) => r[3])).toEqual(['3000.00', '2000.00', '2000.00']); // by hand
    expect(v3.map((r) => r[6])).toEqual(['6.000', '6.000', '3.500']);
    await expect
      .poll(async () => (await ledgerOnScreen(page)).rows, { timeout: 20_000 })
      .toEqual(ledgerShown(v3));
    const { rows, foot } = await ledgerOnScreen(page);
    const last = rows[rows.length - 1];
    expect(foot[3]).toBe(last[3]); // the foot is the last row
    expect(foot[3]).toBe(await card(page, 'cs-balance').innerText()); // and the card's balance
    expect(foot[6]).toBe(await card(page, 'cs-fine-balance').innerText());
    expect(foot[3]).toBe(balance(v2[6]));

    // THE INVOICES: the bill, with the figures of V1
    await page.getByRole('button', { name: 'Invoices' }).click();
    const bill = page.getByTestId('invoice-row').filter({ hasText: 'W10-0001' });
    await expect(bill).toHaveCount(1);
    await expect(bill).toContainText('₹1,000'); // received
    await expect(bill).toContainText('₹2,000'); // pending
    await expect(bill).toContainText('3.500 g fine');
    await expect(bill).toContainText('Partial');

    // THE ESTIMATE of the bill: the same pending, the same silver, no date editor, no edit mode
    await bill.getByRole('link', { name: 'View' }).click();
    await expect(page.getByTestId('estimate-number')).toHaveText('W10-0001');
    const v1 = await v1Of('W10-0001');
    await expect(page.getByTestId('estimate-status')).toHaveText(v1[7]);
    await expect(page.getByTestId('estimate-grand-total')).toHaveText(rupees(v1[1]));
    await expect(page.getByTestId('estimate-received')).toHaveText(rupees(v1[2]));
    await expect(page.getByTestId('estimate-pending')).toHaveText(rupees(v1[3]));
    await expect(page.getByTestId('estimate-fine-due')).toHaveText(`${v1[4]} g`);
    await expect(page.getByTestId('estimate-fine-pending')).toHaveText(`${v1[6]} g`);
    await expect(page.locator('input[type="date"]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Edit Estimate|Save Changes/ })).toHaveCount(0);
    // the one customer, one bill: the bill's pending IS the customer's outstanding and the ledger's balance
    expect(await page.getByTestId('estimate-pending').innerText()).toBe(foot[3]);
  });

  test('Asha: 1,000 billed and 1,500 paid: the bill is paid, 500 stays as an advance on the card and as the closing balance of the ledger', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.asha);
    await expect(card(page, 'cs-outstanding')).toHaveText('₹1,000');

    await openPanel(page, NAMES.asha);
    await page.getByTestId('payment-amount').fill('1500');
    await page.getByTestId('save-payment').click();
    await expect(page.getByTestId('payment-saved')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('payment-advance')).toContainText('₹500.00');
    await page.getByRole('button', { name: 'Close', exact: true }).click();

    // BY HAND: billed 1,000, received 1,500, allocated 1,000: outstanding 0, advance 500, balance 1,000 - 1,500 = -500
    expect(await v2Of(NAMES.asha)).toEqual([
      '1000.00',
      '1000.00',
      '1500.00',
      '0.00',
      '0.00',
      '500.00',
      '-500.00',
      '0.000',
      '0.000',
      '0.000',
    ]);
    await expect(card(page, 'cs-outstanding')).toHaveText('₹0', { timeout: 15_000 });
    await expect(card(page, 'cs-advance')).toHaveText('₹500');
    await expect(card(page, 'cs-balance')).toHaveText('₹500 advance');
    const v3 = await v3Of(NAMES.asha);
    expect(v3.map((r) => r[3])).toEqual(['1000.00', '-500.00']); // by hand
    await expect
      .poll(async () => (await ledgerOnScreen(page)).rows, { timeout: 20_000 })
      .toEqual(ledgerShown(v3));
    expect((await ledgerOnScreen(page)).foot[3]).toBe('₹500 advance');

    await page.getByRole('button', { name: 'Invoices' }).click();
    await page
      .getByTestId('invoice-row')
      .filter({ hasText: 'W10-0002' })
      .getByRole('link', { name: 'View' })
      .click();
    await expect(page.getByTestId('estimate-status')).toHaveText('Paid');
    await expect(page.getByTestId('estimate-received')).toHaveText('₹1,000');
    await expect(page.getByTestId('estimate-pending')).toHaveText('₹0');
  });
});

// ------------------------------------------------------------------------------------------------ every kind of row

test.describe('PT-W10: every kind of row of V3, made by the API, as the ledger shows it', () => {
  test.describe.configure({ timeout: 300_000 });

  test('Dev (opening dues, two bills, a payment voided, a bill cancelled) and Gita (an opening advance, a refund)', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));

    // Dev: dues of 5,000 brought forward five days ago (Opening), 1,000 paid (Payment), that receipt voided (Void), the bill of 1,500 cancelled (Cancellation)
    const opening = await apiCall(page, `/v1/customers/${ids.dev}/opening-balance`, {
      dues: '5000.00',
      as_of: kolkataDate(5),
    });
    expect(opening.status).toBe(201);
    const payment = await apiCall(page, `/v1/customers/${ids.dev}/payments`, {
      amount: '1000.00',
      mode: 'UPI',
    });
    expect(payment.status).toBe(201);
    const receiptId = (payment.body as { receipt: { id: string } }).receipt.id;
    const voided = await apiCall(page, `/v1/receipts/${receiptId}/void`, { reason: 'keyed twice' });
    expect(voided.status).toBe(200);
    const cancelled = await apiCall(page, `/v1/bills/${ids.bills.d2}/cancel`, {
      reason: 'wrong customer',
    });
    expect(cancelled.status).toBe(200);
    // Gita: an advance of 2,000 brought forward four days ago (Opening advance), 500 handed back (Refund)
    const advance = await apiCall(page, `/v1/customers/${ids.gita}/opening-balance`, {
      advance: '2000.00',
      as_of: kolkataDate(4),
    });
    expect(advance.status).toBe(201);
    const refund = await apiCall(page, `/v1/customers/${ids.gita}/refunds`, {
      amount: '500.00',
      mode: 'Cash',
    });
    expect(refund.status).toBe(201);

    // ---- Dev. BY HAND: billed = opening 5,000 + 2,000 (the 1,500 bill is cancelled) = 7,000; the receipt is void so nothing is received: outstanding 7,000, balance 7,000
    const devNumber = (
      await laneSql(
        `SELECT bill_no FROM bills WHERE customer_id = '${ids.dev}' AND doc_type = 'opening_balance'`
      )
    )[0][0];
    const devV2 = await v2Of(NAMES.dev);
    expect(devV2.slice(0, 7)).toEqual([
      '7000.00',
      '2000.00',
      '0.00',
      '0.00',
      '7000.00',
      '0.00',
      '7000.00',
    ]);
    const devV3 = await v3Of(NAMES.dev);
    expect(devV3.map((r) => r[0])).toEqual([
      'Opening',
      'Invoice',
      'Invoice',
      'Payment',
      'Void',
      'Cancellation',
    ]);
    expect(devV3.map((r) => r[3])).toEqual([
      '5000.00',
      '7000.00',
      '8500.00',
      '7500.00',
      '8500.00',
      '7000.00',
    ]); // by hand: +5000, +2000, +1500, -1000, +1000, -1500

    await openCard(page, NAMES.dev);
    await expect
      .poll(async () => (await ledgerOnScreen(page)).rows, { timeout: 30_000 })
      .toEqual(ledgerShown(devV3));
    const dev = await ledgerOnScreen(page);
    expect(dev.rows.map((r) => r[0])).toEqual([
      'Opening balance',
      'Invoice',
      'Invoice',
      'Payment',
      'Void',
      'Cancellation',
    ]);
    // the dates: the opening on the day it is dated, a cancel and a void on the day they were done
    const dates = (await cellsOf(page, 'ledger-row')).map((cells) => cells[0]);
    expect(dates[0]).toBe(dateShown(kolkataDate(5)));
    expect(dates[1]).toBe(dateShown(await billDateOf('W10-0003')));
    expect(dates[4]).toBe(dateShown(kolkataDate(0)));
    expect(dates[5]).toBe(dateShown(kolkataDate(0)));
    await expect(card(page, 'cs-outstanding')).toHaveText(rupees(devV2[4]), { timeout: 20_000 });
    await expect(card(page, 'cs-advance')).toHaveText(rupees(devV2[5]));
    await expect(card(page, 'cs-balance')).toHaveText(balance(devV2[6]));
    expect(dev.foot[3]).toBe(await card(page, 'cs-balance').innerText());

    // the bills of Dev: the dues brought forward, the sale and the cancelled bill, each with V1
    await page.getByRole('button', { name: 'Invoices' }).click();
    await expect(page.getByTestId('invoice-row')).toHaveCount(3);
    const pending = async () =>
      (await cellsOf(page, 'invoice-row')).map((cells) => [cells[0], cells[5], cells[6]]);
    expect(await pending()).toEqual(
      expect.arrayContaining([
        [devNumber, '₹5,000', 'Pending'],
        ['W10-0003', '₹2,000', 'Pending'],
        ['W10-0004', 'Nil', 'Cancelled'],
      ])
    );
    for (const billNo of [devNumber, 'W10-0003', 'W10-0004']) {
      const v1 = await v1Of(billNo);
      const row = page.getByTestId('invoice-row').filter({ hasText: billNo });
      await expect(row).toContainText(v1[7]);
      if (Number(v1[3]) > 0) await expect(row).toContainText(rupees(v1[3]));
    }
    // the sum of the pending of the bills (V1) is the outstanding of the card (V2)
    const pendingOfBills = (
      await Promise.all([devNumber, 'W10-0003', 'W10-0004'].map((billNo) => v1Of(billNo)))
    ).reduce((sum, v1) => sum + Math.round(Number(v1[3]) * 100), 0);
    expect(pendingOfBills).toBe(Math.round(Number(devV2[4]) * 100));

    // the estimate of the cancelled bill
    await page
      .getByTestId('invoice-row')
      .filter({ hasText: 'W10-0004' })
      .getByRole('link', { name: 'View' })
      .click();
    await expect(page.getByTestId('estimate-status')).toHaveText('Cancelled');
    await expect(page.getByTestId('estimate-pending')).toHaveText('₹0');
    await expect(page.locator('input[type="date"]')).toHaveCount(0);

    // ---- Gita. BY HAND: received 2,000 (opening advance), refunded 500: advance 1,500, balance 0 - 2,000 + 500 = -1,500
    await page.goBack(); // client-side: the memory stays
    await expect(page.getByRole('heading', { name: 'Customer Ledger' })).toBeVisible();
    await openCard(page, NAMES.gita);
    const gitaV2 = await v2Of(NAMES.gita);
    expect(gitaV2.slice(0, 7)).toEqual([
      '0.00',
      '0.00',
      '2000.00',
      '500.00',
      '0.00',
      '1500.00',
      '-1500.00',
    ]);
    const gitaV3 = await v3Of(NAMES.gita);
    expect(gitaV3.map((r) => r[0])).toEqual(['Opening advance', 'Refund']);
    expect(gitaV3.map((r) => r[3])).toEqual(['-2000.00', '-1500.00']);
    await expect
      .poll(async () => (await ledgerOnScreen(page)).rows, { timeout: 30_000 })
      .toEqual(ledgerShown(gitaV3));
    const gita = await ledgerOnScreen(page);
    expect(gita.rows.map((r) => r[3])).toEqual(['₹2,000 advance', '₹1,500 advance']);
    expect(gita.foot[3]).toBe('₹1,500 advance');
    await expect(card(page, 'cs-advance')).toHaveText('₹1,500', { timeout: 20_000 });
    await expect(card(page, 'cs-balance')).toHaveText('₹1,500 advance');
    await expect(card(page, 'cs-outstanding')).toHaveText('₹0');
  });
});

// ------------------------------------------------------------------------------------------------ read-only

test.describe('PT-W10 / T-E04 / C15: a saved bill cannot be edited or re-dated, by the owner or by a biller', () => {
  test.describe.configure({ timeout: 240_000 });

  for (const role of ['owner', 'biller'] as const) {
    test(`${role}: the list of estimates and the bill have no date editor and no edit mode, the dates are text`, async ({
      page,
    }) => {
      // nothing that writes money is ever sent from these screens
      const sent: string[] = [];
      page.on('request', (request) => {
        if (request.method() !== 'GET' && /\/v1\/(bills|receipts|customers)/.test(request.url()))
          sent.push(`${request.method()} ${request.url()}`);
      });
      await open(page, e2eLogin(role));
      await aside(page).getByRole('link', { name: 'Saved Estimates' }).click();
      await expect(page.getByRole('heading', { name: 'Saved Estimates' })).toBeVisible();
      const billDate = dateShown(await billDateOf('W10-0001'));
      const row = page.getByTestId('estimate-row').filter({ hasText: 'W10-0001' });
      await expect(row).toHaveCount(1);
      expect((await cellsOf(page, 'estimate-row')).find((c) => c[0] === 'W10-0001')?.[1]).toBe(
        billDate
      );
      await expect(page.locator('input[type="date"]')).toHaveCount(0);

      await row.getByRole('link', { name: 'View' }).click();
      await expect(page.getByTestId('estimate-number')).toHaveText('W10-0001');
      await expect(page.locator('input[type="date"]')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /Edit Estimate|Save Changes/ })).toHaveCount(0);
      await expect(page.locator('main input, main textarea, main select')).toHaveCount(0);
      await expect(page.getByText(billDate).first()).toBeVisible();
      // the one thing to press besides the way back: print
      await expect(page.getByRole('button', { name: /Print/ })).toBeVisible();
      expect(sent).toEqual([]);
    });
  }

  test('the customer card offers no delete of a customer or of a payment (a payment is voided, WEB11)', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.meera);
    await expect(page.getByRole('button', { name: 'Delete Customer' })).toHaveCount(0);
    await page.getByRole('button', { name: 'Payments' }).click();
    await expect(page.getByRole('button', { name: 'Delete', exact: true })).toHaveCount(0);
    await expect(page.getByText('No payments recorded yet.')).toBeVisible();
  });
});
