import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB07: the money-side cache in a real browser against the real API of a lane (spec C1, C3, C6, C11, C14, L5).
//   - the customer card shows, for a book written straight into the lane's database, the figures of V1, V2 and V3 as the DATABASE works them out (the V1, V2 and V3 queries of
//     the API checkout are run in the lane's container and compared with the screen): received, pending, status and fine pending of every bill, the customer's outstanding, the
//     ledger rows and the closing balance
//   - a payment written into the database meanwhile (what another browser's payment will be) moves the invoice, the customer's outstanding and the ledger within one poll
//   - a double click on "Save Customer" of the billing screen's search panel makes one customer; with the answer dropped after the server saved, pressing Save again sends the SAME
//     Idempotency-Key, the server answers the stored result (Idempotent-Replay) and there is still one customer
//   - the customer ledger's own "Add Customer" does the same and opens the card, whose empty ledger is read from the server
//   - nothing of this is kept in browser storage (C8)
//
// The bills, receipts and allocations are written as root in the lane's container because the money screens that make them come with WEB08 and WEB09; the unit tests
// (tests/unit/invoice-shape.test.ts, money-server.test.ts, money-ledger.test.ts) cover the same figures on rows built by hand.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/money-cache.spec.ts

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

const SQL_CLIENT = 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" jv_lane -N -B';

/** SQL as root in the lane's container, to the end. The password never leaves the container: the shell inside it reads it from its own environment. */
async function laneSql(sql: string): Promise<string[][]> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', laneContainer(), 'sh', '-c', `${SQL_CLIENT} -e "$1"`, 'sh', sql],
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

// ------------------------------------------------------------------------------------------------ the book of the tests

const PRIYA = { name: 'W07 Priya', mobile: '9876501234' };
const ids = {
  customer: randomUUID(),
  designGold: randomUUID(),
  designSilver: randomUUID(),
  pieceGold: randomUUID(),
  pieceSilver: randomUUID(),
  bill1: randomUUID(),
  bill2: randomUUID(),
  bill3: randomUUID(),
  receipt: [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()],
};

const itemSql = (
  billId: string,
  skuId: string,
  designNo: string,
  skuNo: string,
  category: string,
  material: string,
  purity: string,
  weights: [gross: string, net: string],
  money: { rate: string; labour: string; metal: string; total: string; fine: string }
) =>
  `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
  `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) VALUES ` +
  `('${randomUUID()}', '${billId}', 1, '${skuId}', '${designNo}', '${skuNo}', '${category}', '${material}', '${purity}', 'By Weight', ${weights[0]}, ${weights[1]}, 1, ` +
  `${money.rate}, ${money.labour === '0.00' ? '0.00' : '353.00'}, ${money.labour}, 0.00, 0.00, ${money.metal}, ${money.fine}, ${money.total}, ${money.rate}, NULL);`;

/**
 * Priya's book, written as root (hand figures; V1 is asked of the database as well):
 *   W07-0001 257612.00 (245106.40 metal + 12505.26 labour + 0.34 round-off): cash 100000.00 and UPI 57612.00 -> received 157612.00, pending 100000.00, Partial
 *   W07-0002  40000.00 Wholesale, 25.000 g of silver due: bank transfer 40000.00 and 10.000 g of silver -> received 40000.00, pending 0.00, fine pending 15.000, Partial
 *   W07-0003  12000.00: nothing paid -> Pending
 */
function bookSql(): string {
  const { customer, bill1, bill2, bill3, receipt } = ids;
  const allocation = (r: string, b: string, amount: string, fine: string) =>
    `INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, fine_grams) VALUES ('${randomUUID()}', '${r}', '${b}', '${customer}', ${amount}, ${fine});`;
  return [
    `INSERT INTO customers (id, name, mobile, customer_type, address) VALUES ('${customer}', '${PRIYA.name}', '${PRIYA.mobile}', 'Retail', '12 Johari Bazaar, Jaipur');`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.designGold}', 'W07-D1', 'W07 gold ring', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.designSilver}', 'W07-D2', 'W07 silver anklet', id, 'Silver', '925', 'By Weight' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.pieceGold}', '${ids.designGold}', 'W07-G1', 'W07BC1', 38.100, 35.420, 'In Stock');`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.pieceSilver}', '${ids.designSilver}', 'W07-S1', 'W07BC2', 124.500, 120.000, 'In Stock');`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, round_off, grand_total, notes) VALUES ('${bill1}', 'W07-0001', '${customer}', CURDATE(), 'Retail', 257611.66, 0.34, 257612.00, 'Bridal set');`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total, fine_weight_due) VALUES ('${bill2}', 'W07-0002', '${customer}', CURDATE(), 'Wholesale', 40000.00, 40000.00, 25.000);`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) VALUES ('${bill3}', 'W07-0003', '${customer}', CURDATE(), 'Retail', 12000.00, 12000.00);`,
    itemSql(bill1, ids.pieceGold, 'W07-D1', 'W07-G1', 'Ring', 'Gold', '22K', ['38.100', '35.420'], {
      rate: '6920.00',
      labour: '12505.26',
      metal: '245106.40',
      total: '257611.66',
      fine: '0.000',
    }),
    itemSql(
      bill2,
      ids.pieceSilver,
      'W07-D2',
      'W07-S1',
      'Anklet',
      'Silver',
      '925',
      ['124.500', '120.000'],
      {
        rate: '333.33',
        labour: '0.00',
        metal: '40000.00',
        total: '40000.00',
        fine: '25.000',
      }
    ),
    itemSql(bill3, ids.pieceGold, 'W07-D1', 'W07-G1', 'Ring', 'Gold', '22K', ['38.100', '35.420'], {
      rate: '6920.00',
      labour: '0.00',
      metal: '12000.00',
      total: '12000.00',
      fine: '0.000',
    }),
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, reference) VALUES ('${receipt[0]}', '${customer}', 'money', 'Cash', 100000.00, CURDATE(), 'CASH-1');`,
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, reference) VALUES ('${receipt[1]}', '${customer}', 'money', 'UPI', 57612.00, CURDATE(), 'UPI-7788');`,
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES ('${receipt[2]}', '${customer}', 'money', 'Bank Transfer', 40000.00, CURDATE());`,
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, fine_grams, paid_on) VALUES ('${receipt[3]}', '${customer}', 'fine_silver', NULL, 0.00, 10.000, CURDATE());`,
    allocation(receipt[0], bill1, '100000.00', '0.000'),
    allocation(receipt[1], bill1, '57612.00', '0.000'),
    allocation(receipt[2], bill2, '40000.00', '0.000'),
    allocation(receipt[3], bill2, '0.00', '10.000'),
    touchSql(),
  ].join(' ');
}

/** What the money services do on every receipt or bill (D23): the bills and the customer get a new `updated_at`, which is how the polls find the change. */
function touchSql(): string {
  return (
    `UPDATE bills SET updated_at = CURRENT_TIMESTAMP(6) WHERE customer_id = '${ids.customer}'; ` +
    `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = '${ids.customer}';`
  );
}

/** A payment of 12000.00 on W07-0003, the way another browser's payment will arrive. */
const paySql = () =>
  `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, reference) VALUES ('${ids.receipt[4]}', '${ids.customer}', 'money', 'Cash', 12000.00, CURDATE(), 'CASH-LATE'); ` +
  `INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount, fine_grams) VALUES ('${randomUUID()}', '${ids.receipt[4]}', '${ids.bill3}', '${ids.customer}', 12000.00, 0.000); ` +
  touchSql();

/** Everything these tests made, gone again. The delete order follows the foreign keys. */
async function cleanLane() {
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W07 %'); ` +
      `DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W07 %'); ` +
      `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE bill_no LIKE 'W07-%'); ` +
      `DELETE FROM bills WHERE bill_no LIKE 'W07-%'; ` +
      `DELETE FROM customers WHERE name LIKE 'W07 %'; ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W07-%'; DELETE FROM designs WHERE design_no LIKE 'W07-%'`
  );
}

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();

async function signInAs(page: Page, who: E2eLogin) {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
}

/** The way the screens write a whole number of rupees (`toLocaleString('en-IN')`). */
const inr = (text: string) =>
  new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Number(text));

const customersCount = async (name: string) =>
  Number((await laneSql(`SELECT COUNT(*) FROM customers WHERE name = '${name}'`))[0][0]);

const customerSaves = (page: Page) => {
  const { apiUrl } = e2eLane();
  const requests: Request[] = [];
  const responses: Response[] = [];
  page.on('request', (request) => {
    if (request.method() === 'POST' && request.url() === `${apiUrl}/v1/customers`)
      requests.push(request);
  });
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && response.url() === `${apiUrl}/v1/customers`)
      responses.push(response);
  });
  return { requests, responses };
};

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// The API lets one person make 300 calls a minute (A13); the volume test below makes about a hundred, so every test of this file waits for
// room in the minute and starts from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});

test.beforeAll(async () => {
  await cleanLane();
});
test.afterEach(async () => {
  await cleanLane();
});

// ------------------------------------------------------------------------------------------------ the figures of the database on the customer card

test.describe('T-E04 clause (C1, C3, C14): the customer card shows the figures of V1, V2 and V3 as the database works them out', () => {
  test.describe.configure({ timeout: 180_000 });

  test('invoices, customer and ledger equal the derived queries; a payment written meanwhile moves all three within one poll', async ({
    page,
  }) => {
    await laneSql(bookSql());
    const owner = e2eLogin('owner');
    await signInAs(page, owner);
    await page.goto('/customer-ledger');
    await expect(aside(page)).toContainText(owner.fullName);

    // the customer is in the list, with the outstanding V2 gives (money only: 100000 + 12000)
    const v2 = (
      await laneSql(
        `SELECT outstanding, fine_outstanding, total_purchases, received FROM (${derivedQuery('V2_customer_balances')}) v WHERE id = '${ids.customer}'`
      )
    )[0];
    expect(Number(v2[0])).toBe(112000); // by hand
    const listItem = page.locator('button', { hasText: PRIYA.name });
    await expect(listItem).toContainText(`₹${(Number(v2[0]) / 1000).toFixed(1)}K`);
    await listItem.click();
    await expect(page.getByRole('heading', { name: PRIYA.name })).toBeVisible();

    // INVOICES: the four figures of every bill are the row of V1
    await page.getByRole('button', { name: 'Invoices' }).click();
    const v1Rows = await laneSql(
      `SELECT bill_no, grand_total, received, pending, payment_status, fine_pending FROM (${derivedQuery('V1_bill_summary')}) v WHERE bill_no LIKE 'W07-%' ORDER BY bill_no`
    );
    expect(v1Rows.map((r) => [r[0], r[2], r[3], r[4], r[5]])).toEqual([
      ['W07-0001', '157612.00', '100000.00', 'Partial', '0.000'], // by hand
      ['W07-0002', '40000.00', '0.00', 'Partial', '15.000'],
      ['W07-0003', '0.00', '12000.00', 'Pending', '0.000'],
    ]);
    for (const [billNo, grand, received, pending, status, finePending] of v1Rows) {
      const row = page.locator('tbody tr').filter({ hasText: billNo });
      await expect(row, `${billNo} is listed`).toHaveCount(1);
      await expect(row).toContainText(`₹${inr(grand)}`);
      await expect(row).toContainText(`₹${inr(received)}`);
      await expect(row).toContainText(status);
      if (Number(pending) > 0) await expect(row).toContainText(`₹${inr(pending)}`);
      if (Number(finePending) > 0)
        await expect(row).toContainText(`${Number(finePending).toFixed(3)} g fine`);
    }

    // LEDGER: one row per event of V3 and the closing balance of V3
    await page.getByRole('button', { name: 'Ledger' }).click();
    const v3 = await laneSql(
      `SELECT kind, debit, credit, balance, fine_balance FROM (${derivedQuery('V3_customer_ledger')}) v WHERE customer_id = '${ids.customer}' ORDER BY entry_date, entry_at, kind_rank, id`
    );
    expect(v3).toHaveLength(7); // 3 bills, 3 money receipts, 1 silver receipt
    const closing = v3[v3.length - 1];
    expect(closing[3]).toBe('112000.00'); // by hand: 309612 billed - 197612 paid
    await expect(page.locator('tbody tr')).toHaveCount(7);
    const footer = page.locator('tfoot tr');
    await expect(footer).toContainText(`₹${inr(closing[3])}`);
    await expect(footer).toContainText(`${Number(closing[4]).toFixed(3)} g`);

    // ANOTHER BROWSER'S PAYMENT: written into the database now; the poll brings the touched rows, the card moves, the ledger is read again
    await laneSql(paySql());
    await expect(page.locator('tbody tr')).toHaveCount(8, { timeout: 30_000 });
    await expect(page.locator('tfoot tr')).toContainText('₹1,00,000');
    await expect(listItem).toContainText('₹100.0K');
    await page.getByRole('button', { name: 'Invoices' }).click();
    const paid = page.locator('tbody tr').filter({ hasText: 'W07-0003' });
    await expect(paid).toContainText('Paid');
    const v1After = await laneSql(
      `SELECT received, pending, payment_status FROM (${derivedQuery('V1_bill_summary')}) v WHERE bill_no = 'W07-0003'`
    );
    expect(v1After[0]).toEqual(['12000.00', '0.00', 'Paid']);
    await expect(paid).toContainText(`₹${inr('12000')}`);

    // C8: nothing of the books is kept in the browser
    const stored = await page.evaluate(() => ({
      local: Object.keys(window.localStorage),
      session: Object.keys(window.sessionStorage),
    }));
    expect(stored).toEqual({ local: [], session: [] });
  });
});

// ------------------------------------------------------------------------------------------------ one customer, whatever the person's fingers and the network do

const SAVE_ERROR = 'customer-save-error';

test.describe('WEB07 done-when (C6, L5): creating a customer from the billing screen makes one customer', () => {
  test.describe.configure({ timeout: 120_000 });

  async function openAddForm(page: Page, name: string, mobile: string) {
    await signInAs(page, e2eLogin('owner'));
    await page.goto('/billing-pos');
    await page.getByRole('button', { name: 'Add Customer' }).click();
    await page.getByPlaceholder('Customer name').fill(name);
    await page.getByPlaceholder('Mobile number').fill(mobile);
  }

  test('a double click on Save Customer is one request and one customer, and the customer is selected', async ({
    page,
  }) => {
    const { requests } = customerSaves(page);
    const { apiUrl } = e2eLane();
    // a slow server, so that the second click lands while the first call is on its way
    await page.route(`${apiUrl}/v1/customers`, async (route) => {
      if (route.request().method() === 'POST') await sleep(1500);
      await route.continue();
    });
    await openAddForm(page, 'W07 Double', '9000011111');
    await page.getByRole('button', { name: 'Save Customer' }).dblclick();
    await expect(page.getByText('W07 Double').first()).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('button', { name: 'Change' })).toBeVisible(); // the customer is selected
    await sleep(1500);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers()['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(await customersCount('W07 Double')).toBe(1);
  });

  test('the answer is lost after the server saved: Save again sends the same key, the server replays, and there is still one customer', async ({
    page,
  }) => {
    const { requests, responses } = customerSaves(page);
    const { apiUrl } = e2eLane();
    let dropped = false;
    await page.route(`${apiUrl}/v1/customers`, async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      if (!dropped) {
        dropped = true;
        await route.fetch(); // the server gets it, saves it and answers ...
        return route.abort('connectionreset'); // ... and the answer never reaches the page
      }
      return route.continue();
    });
    await openAddForm(page, 'W07 Dropped', '9000022222');
    const save = page.getByRole('button', { name: 'Save Customer' });
    await save.click();
    await expect(page.getByTestId(SAVE_ERROR)).toContainText(
      'Could not confirm that this was saved'
    );
    expect(await customersCount('W07 Dropped')).toBe(1); // it was saved; the screen did not know

    await save.click(); // the same action again
    await expect(page.getByRole('button', { name: 'Change' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('W07 Dropped').first()).toBeVisible();
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
    const last = responses[responses.length - 1];
    expect(last.status()).toBe(201);
    expect(last.headers()['idempotent-replay']).toBe('true');
    expect(await customersCount('W07 Dropped')).toBe(1);
  });

  test('a refusal says so in plain words and the form can be fixed and saved again', async ({
    page,
  }) => {
    await openAddForm(page, 'W07 Refused', '12345'); // not a mobile number the API takes
    await page.getByRole('button', { name: 'Save Customer' }).click();
    await expect(page.getByTestId(SAVE_ERROR)).toContainText(/Nothing was changed|mobile/i);
    expect(await customersCount('W07 Refused')).toBe(0);
    await page.getByPlaceholder('Mobile number').fill('9000033333');
    await page.getByRole('button', { name: 'Save Customer' }).click();
    await expect(page.getByRole('button', { name: 'Change' })).toBeVisible({ timeout: 15_000 });
    expect(await customersCount('W07 Refused')).toBe(1);
  });
});

test.describe('WEB07: the customer ledger screen makes a customer the same way and opens its card', () => {
  test.describe.configure({ timeout: 120_000 });

  test('Add Customer: one customer, its card opens and reads its (empty) ledger from the server', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const ledgerCalls: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        /\/v1\/customers\/[0-9a-f-]{36}\/ledger/.test(request.url())
      )
        ledgerCalls.push(request.url());
    });
    await page.route(`${apiUrl}/v1/customers`, async (route) => {
      if (route.request().method() === 'POST') await sleep(1000);
      await route.continue();
    });
    await signInAs(page, e2eLogin('owner'));
    await page.goto('/customer-ledger');
    await page.getByRole('button', { name: '+ Add Customer' }).click();
    await page.getByPlaceholder('e.g. Priya Sharma').fill('W07 Modal');
    await page.getByPlaceholder('10-digit mobile number').fill('9000044444');
    await page.getByRole('button', { name: 'Add Customer', exact: true }).dblclick();
    await expect(page.getByRole('heading', { name: 'W07 Modal' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('No ledger entries yet')).toBeVisible();
    await expect.poll(() => ledgerCalls.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(1);
    expect(ledgerCalls[0]).toContain('limit=1000');
    expect(await customersCount('W07 Modal')).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ the volumes of C2

// The volumes are written with SQL into THIS lane's container, not with the API's `npm run seed:volume`: that command ignores JV_LANE_NAMESPACE and would fill the lane of the
// same name in the real namespace, which belongs to somebody else.
const BUSY = randomUUID();
const BUSY_EVENTS = 2600;
const BULK_CUSTOMERS = 1998;

/** 2,000 customers with the walk-in and the busy one, and a customer with 2,600 bills and 2,600 receipts (5,200 events: six pages of a ledger). Money is whole rupees. */
const volumeSql = () =>
  [
    `INSERT INTO customers (id, name, mobile) VALUES ('${BUSY}', 'W07 Busy Customer', '9000000001');`,
    `INSERT INTO customers (id, name, mobile) SELECT UUID_v4(), CONCAT('W07 Bulk ', seq), CONCAT('9', LPAD(seq + 1000, 9, '0')) FROM seq_1_to_${BULK_CUSTOMERS};`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, doc_type, sale_type, subtotal, grand_total, created_at, updated_at) ` +
      `SELECT UUID_v4(), CONCAT('W07-B', LPAD(seq, 5, '0')), '${BUSY}', DATE_ADD('2026-01-01', INTERVAL (seq MOD 250) DAY), 'estimate', 'Retail', 1000 + seq, 1000 + seq, ` +
      `TIMESTAMPADD(SECOND, seq, '2026-01-01 05:00:00'), TIMESTAMPADD(SECOND, seq, '2026-01-01 05:00:00') FROM seq_1_to_${BUSY_EVENTS};`,
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at, updated_at) ` +
      `SELECT UUID_v4(), '${BUSY}', 'money', 'UPI', 900 + seq, DATE_ADD('2026-01-01', INTERVAL (seq MOD 250) DAY), ` +
      `TIMESTAMPADD(SECOND, seq, '2026-01-01 05:00:01'), TIMESTAMPADD(SECOND, seq, '2026-01-01 05:00:01') FROM seq_1_to_${BUSY_EVENTS};`,
  ].join(' ');

test.describe('WEB07 at the volumes of C2 (2,000 customers, a customer with 5,200 events): the card reads its whole ledger in pages', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  test('the list, the total and the ledger of the busy customer equal V2 and V3, in as many pages as the cap needs', async ({
    page,
  }) => {
    await laneSql(volumeSql());
    const v3 = await laneSql(
      `SELECT balance, fine_balance FROM (${derivedQuery('V3_customer_ledger')}) v WHERE customer_id = '${BUSY}' ORDER BY entry_date, entry_at, kind_rank, id`
    );
    expect(v3).toHaveLength(2 * BUSY_EVENTS); // by hand
    const closing = v3[v3.length - 1];
    const v2 = (
      await laneSql(`SELECT SUM(outstanding) FROM (${derivedQuery('V2_customer_balances')}) v`)
    )[0];

    const { apiUrl } = e2eLane();
    const ledgerCalls: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'GET' &&
        request.url().startsWith(`${apiUrl}/v1/customers/${BUSY}/ledger`)
      )
        ledgerCalls.push(request.url());
    });
    const owner = e2eLogin('owner');
    await signInAs(page, owner);
    await page.goto('/customer-ledger');

    // 2,000 customers, and the total of V2's outstanding in the header
    await expect(page.getByText(/2000 customers/)).toBeVisible({ timeout: 60_000 });
    const header = (
      await page
        .getByText(/total outstanding/)
        .first()
        .innerText()
    ).replace(/,/g, '');
    const shown = Number(/₹\s*([\d.]+)\s*total outstanding/.exec(header)?.[1]);
    expect(Math.abs(shown - Number(v2[0]))).toBeLessThan(0.01);

    const started = Date.now();
    await page.getByPlaceholder('Search customers...').fill('W07 Busy');
    await page.locator('button', { hasText: 'W07 Busy Customer' }).first().click();
    await expect(page.locator('tbody tr')).toHaveCount(v3.length, { timeout: 60_000 });
    const tookMs = Date.now() - started;
    expect(tookMs, 'the whole ledger is on screen within a few seconds').toBeLessThan(15_000);
    // pages of up to 1,000 events: 5,200 events are five full pages and a sixth with 200
    expect(ledgerCalls).toHaveLength(Math.floor(v3.length / 1000) + 1);
    await expect(page.locator('tfoot tr')).toContainText(
      `₹${Number(closing[0]).toLocaleString('en-IN')}`
    );
    await expect(page.locator('tfoot tr')).toContainText(`${Number(closing[1]).toFixed(3)} g`);
  });
});
