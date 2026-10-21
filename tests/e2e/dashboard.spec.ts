import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB12 (T-B15 E2E half; spec C14, V5, V4, I11, I12): the dashboard, the reports, the customer card and the three evening figures take their figures from the same selectors over the derived
// reads, so on the same data they agree, and with the database's own V1, V2 and V4 (run in the lane's container). The owner's dashboard line shows each reason and turns red or amber as the
// API computes (readHealth, API12/API32/API35).
//
//   THE DAY (all bills dated today in India, except Asha's, dated the first day of last month; figures worked out by hand)
//     Meera   W12-0001 10,000 (lines 9,000 gold ring + 1,500 silver anklet, a 500 discount) paid 4,000 cash | W12-0002 3,000 CANCELLED | OB-0001 5,000 dues | OB-0002 800 dues CANCELLED
//     Dev     W12-0003 20,000 (gold necklace) paid 19,000 by UPI | W12-0004 2,000 (5 silver anklets) paid 1,000 by UPI
//     Asha    W12-0005 1,000 (last month) paid 1,500 cash, 200 handed back in cash: an advance of 300
//     Walk-in W12-0006 900 (1 silver anklet) unpaid
//     sales today 10,000 + 20,000 + 2,000 + 900 = 32,900 in 4 bills, the same for the month; cancelled 3,000 in 1 bill (OB-0002 is on no line)
//     outstanding 11,000 (Meera) + 2,000 (Dev) + 0 + 900 = 13,900 on five bills (6,000 + 5,000 + 1,000 + 1,000 + 900)
//     cash book of today: Cash in 4,000 + 1,500, out 200, net 5,300 | UPI in 19,000 + 1,000, net 20,000 -> collected 25,300; UPI share 79.1 %, Cash 20.9 %
//     the lines of the month: Anklet 4,400 (7 pieces), Necklace 20,000, Ring 9,000 = 33,400; the bills' own discount -500 makes the 32,900
//
// The rows are written as root (the billing screen that makes bills is proved in billing.spec.ts) and the payments, the cancels, the refund and the opening dues through the API's own routes
// by the owner's session, so every row is one the API made. Everything the tests made is taken out again: the volume case of hydrate.spec.ts refuses a lane that holds a bill, a receipt or a
// counter that moved with no bill behind it. Rows are made early in the day or relative to the clock, never at a fixed hour (the earlier lesson: a test that seeds 12:30 fails before 12:30).
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/dashboard.spec.ts

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
function derivedQuery(name: 'V1_bill_summary' | 'V2_customer_balances' | 'V4_daily_totals') {
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

/** The business date (Asia/Kolkata) `daysAgo` days before today, as the API works it out. */
function kolkataDate(daysAgo = 0): string {
  return new Date(Date.now() + 19_800_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}
/** The first day of last month (always in another month than today). */
function lastMonthFirst(): string {
  const today = kolkataDate();
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  return month === 1 ? `${year - 1}-12-01` : `${year}-${String(month - 1).padStart(2, '0')}-01`;
}
const monthStart = () => `${kolkataDate().slice(0, 7)}-01`;

// ------------------------------------------------------------------------------------------------ the book of the tests

const WALK_IN = '00000000-0000-4000-8000-000000000001';
const ids = {
  meera: randomUUID(),
  dev: randomUUID(),
  asha: randomUUID(),
  designGold: randomUUID(),
  designSilver: randomUUID(),
  pieceGold: randomUUID(),
  pieceSilver: randomUUID(),
  bills: {
    m1: randomUUID(),
    m2: randomUUID(),
    d1: randomUUID(),
    d2: randomUUID(),
    a1: randomUUID(),
    w1: randomUUID(),
  },
};
const NAMES = { meera: 'W12 Meera', dev: 'W12 Dev', asha: 'W12 Asha' };

function fixtureSql(): string {
  const today = kolkataDate();
  const customer = (id: string, name: string, mobile: string) =>
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${id}', '${name}', '${mobile}', 'Retail');`;
  // each bill is made a few minutes before now, one minute apart, so that it is never later than the payments made after it
  const bill = (
    id: string,
    number: string,
    customerId: string,
    date: string,
    subtotal: string,
    discount: string,
    grand: string,
    minutesAgo: number
  ) =>
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, discount, grand_total, created_at) VALUES ` +
    `('${id}', '${number}', '${customerId}', '${date}', 'Retail', ${subtotal}, ${discount}, ${grand}, ` +
    (date === today
      ? `UTC_TIMESTAMP(6) - INTERVAL ${minutesAgo} MINUTE`
      : `TIMESTAMP('${date}', '12:00:00')`) +
    `);`;
  const line = (
    billId: string,
    no: number,
    sku: 'gold' | 'silver',
    category: string,
    method: 'By Weight' | 'Per Piece',
    quantity: number,
    total: string
  ) =>
    `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
    `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) VALUES ` +
    `('${randomUUID()}', '${billId}', ${no}, '${sku === 'gold' ? ids.pieceGold : ids.pieceSilver}', '${sku === 'gold' ? 'W12-DG' : 'W12-DS'}', '${sku === 'gold' ? 'W12-SG' : 'W12-SS'}', ` +
    `'${category}', '${sku === 'gold' ? 'Gold' : 'Silver'}', '${sku === 'gold' ? '22K' : '925'}', '${method}', 10.000, 9.000, ${quantity}, ` +
    `1.00, 0.00, 0.00, 0.00, 0.00, ${total}, 0.000, ${total}, 1.00, NULL);`;
  return [
    customer(ids.meera, NAMES.meera, '9000120001'),
    customer(ids.dev, NAMES.dev, '9000120002'),
    customer(ids.asha, NAMES.asha, '9000120003'),
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.designGold}', 'W12-DG', 'W12 gold ring', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.designSilver}', 'W12-DS', 'W12 silver anklet', id, 'Silver', '925', 'Per Piece' FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.pieceGold}', '${ids.designGold}', 'W12-SG', 'W12BG', 10.000, 9.000, 'In Stock');`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.pieceSilver}', '${ids.designSilver}', 'W12-SS', 'W12BS', 10.000, 9.000, 'In Stock');`,
    bill(ids.bills.m1, 'W12-0001', ids.meera, today, '10500.00', '500.00', '10000.00', 9),
    line(ids.bills.m1, 1, 'gold', 'Ring', 'By Weight', 1, '9000.00'),
    line(ids.bills.m1, 2, 'silver', 'Anklet', 'Per Piece', 1, '1500.00'),
    bill(ids.bills.m2, 'W12-0002', ids.meera, today, '3000.00', '0.00', '3000.00', 8),
    line(ids.bills.m2, 1, 'gold', 'Ring', 'By Weight', 1, '3000.00'),
    bill(ids.bills.d1, 'W12-0003', ids.dev, today, '20000.00', '0.00', '20000.00', 7),
    line(ids.bills.d1, 1, 'gold', 'Necklace', 'By Weight', 1, '20000.00'),
    bill(ids.bills.d2, 'W12-0004', ids.dev, today, '2000.00', '0.00', '2000.00', 6),
    line(ids.bills.d2, 1, 'silver', 'Anklet', 'Per Piece', 5, '2000.00'),
    bill(ids.bills.a1, 'W12-0005', ids.asha, lastMonthFirst(), '1000.00', '0.00', '1000.00', 5),
    line(ids.bills.a1, 1, 'gold', 'Ring', 'By Weight', 1, '1000.00'),
    bill(ids.bills.w1, 'W12-0006', WALK_IN, today, '900.00', '0.00', '900.00', 4),
    line(ids.bills.w1, 1, 'silver', 'Anklet', 'Per Piece', 1, '900.00'),
    // what the money services do on every bill (D23): the customer gets a new `updated_at`, which is how the polls find the change
    `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name LIKE 'W12 %' OR id = '${WALK_IN}';`,
  ].join(' ');
}

/** Everything these tests made, gone again. The delete order follows the foreign keys. */
async function cleanLane() {
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12 %') OR bill_id IN (SELECT id FROM bills WHERE bill_no LIKE 'W12-%'); ` +
      `DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12 %'); ` +
      `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE bill_no LIKE 'W12-%' OR customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12 %')); ` +
      `DELETE FROM bills WHERE bill_no LIKE 'W12-%' OR customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12 %'); ` +
      `DELETE FROM customers WHERE name LIKE 'W12 %'; ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W12-%'; DELETE FROM designs WHERE design_no LIKE 'W12-%'; ` +
      // the rows of the dashboard line: the nightly checks, the backup log and the two reminders of the settings
      `DELETE FROM check_runs; DELETE FROM backup_runs; DELETE FROM settings WHERE setting_key IN ('last_download', 'last_pulled');`
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
const fullName = (who: E2eLogin) => who.fullName;

/** Opens a page of the site as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, url = '/') {
  await page.goto(url);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(fullName(who), { timeout: 60_000 });
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

/** The day, made by the API's own functions through the owner's session: opening dues, a cancel of each kind, the payments, a refund. */
async function makeTheDay(page: Page) {
  const today = kolkataDate();
  const ok = (answer: { status: number }, status = 201) => expect(answer.status).toBe(status);

  const opening = await apiCall(page, `/v1/customers/${ids.meera}/opening-balance`, {
    dues: '5000.00',
    as_of: today,
  });
  ok(opening);
  const second = await apiCall(page, `/v1/customers/${ids.meera}/opening-balance`, {
    dues: '800.00',
    as_of: today,
  });
  ok(second);
  const secondId = (second.body as { bill: { id: string } }).bill.id;
  ok(await apiCall(page, `/v1/bills/${secondId}/cancel`, { reason: 'wrong figure' }), 200);
  ok(await apiCall(page, `/v1/bills/${ids.bills.m2}/cancel`, { reason: 'wrong customer' }), 200);

  ok(
    await apiCall(page, `/v1/customers/${ids.meera}/payments`, {
      amount: '4000.00',
      mode: 'Cash',
      bill_id: ids.bills.m1,
    })
  );
  ok(
    await apiCall(page, `/v1/customers/${ids.dev}/payments`, {
      amount: '19000.00',
      mode: 'UPI',
      bill_id: ids.bills.d1,
    })
  );
  ok(
    await apiCall(page, `/v1/customers/${ids.dev}/payments`, {
      amount: '1000.00',
      mode: 'UPI',
      bill_id: ids.bills.d2,
    })
  );
  ok(
    await apiCall(page, `/v1/customers/${ids.asha}/payments`, {
      amount: '1500.00',
      mode: 'Cash',
      bill_id: ids.bills.a1,
    })
  );
  ok(await apiCall(page, `/v1/customers/${ids.asha}/refunds`, { amount: '200.00', mode: 'Cash' }));
}

// ---- the database's own figures (V1, V2 and V4 run in the lane's container: independent of the application's code)

const db = {
  /** Count and total of the sales of a date range: active bills that are not opening-balance bills. */
  sales: async (from: string, to: string) =>
    (
      await laneSql(
        `SELECT COUNT(*), COALESCE(SUM(grand_total), 0) FROM (${derivedQuery('V1_bill_summary')}) v ` +
          `WHERE v.status = 'active' AND v.doc_type <> 'opening_balance' AND v.bill_date BETWEEN '${from}' AND '${to}'`
      )
    )[0],
  /** Count and total of the cancelled bills of a date range, the cancelled opening-balance bills not among them. */
  cancelled: async (from: string, to: string) =>
    (
      await laneSql(
        `SELECT COUNT(*), COALESCE(SUM(grand_total), 0) FROM (${derivedQuery('V1_bill_summary')}) v ` +
          `WHERE v.status = 'cancelled' AND v.doc_type <> 'opening_balance' AND v.bill_date BETWEEN '${from}' AND '${to}'`
      )
    )[0],
  /** The total outstanding and the number of customers who owe: V2. */
  owed: async () =>
    (
      await laneSql(
        `SELECT COALESCE(SUM(outstanding), 0), COALESCE(SUM(outstanding > 0), 0) FROM (${derivedQuery('V2_customer_balances')}) v`
      )
    )[0],
  /** The net of a mode over a date range: V4. */
  net: async (mode: string, from: string, to: string) =>
    (
      await laneSql(
        `SELECT COALESCE(SUM(net), 0) FROM (${derivedQuery('V4_daily_totals')}) v WHERE v.mode = '${mode}' AND v.business_date BETWEEN '${from}' AND '${to}'`
      )
    )[0][0],
  /** Money in and money out of a mode over a date range. */
  flow: async (mode: string, from: string, to: string) =>
    (
      await laneSql(
        `SELECT COALESCE(SUM(money_in), 0), COALESCE(SUM(money_out), 0) FROM (${derivedQuery('V4_daily_totals')}) v WHERE v.mode = '${mode}' AND v.business_date BETWEEN '${from}' AND '${to}'`
      )
    )[0],
};

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
const billsText = (count: number) => `${count} ${count === 1 ? 'bill' : 'bills'}`;
const dayShown = (day: string) =>
  new Date(`${day}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute and
// starts from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
  await cleanLane();
});
test.afterEach(async () => {
  await cleanLane();
});
test.afterAll(async () => {
  // the lane is as it was found: none of this file's customers, bills or receipts, no opening counter that moved with no opening bill behind it (hydrate.spec's volume case refuses one),
  // and none of the rows of the dashboard line
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE 'W12 %'), ` +
      `(SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W12-%' OR doc_type = 'opening_balance'), ` +
      `(SELECT COUNT(*) FROM receipts), (SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W12-%'), ` +
      `(SELECT COUNT(*) FROM sys_counters WHERE series = 'opening'), ` +
      `(SELECT COUNT(*) FROM check_runs), (SELECT COUNT(*) FROM backup_runs), ` +
      `(SELECT COUNT(*) FROM settings WHERE setting_key IN ('last_download', 'last_pulled'))`
  );
  expect(left).toEqual(['0', '0', '0', '0', '0', '0', '0', '0']);
});

// ------------------------------------------------------------------------------------------------ T-B15: the same figures everywhere

test.describe('T-B15 E2E: dashboard, reports, customer cards and the three evening figures agree on the same data', () => {
  test.describe.configure({ timeout: 300_000 });

  test("the dashboard: sales, the cancelled line, the outstanding, the pending list and the evening check are the hand figures and the database's V1, V2 and V4", async ({
    page,
  }) => {
    await laneSql(fixtureSql());
    await open(page, e2eLogin('owner'));
    await makeTheDay(page);
    await page.goto('/');
    const today = kolkataDate();

    // THE DATABASE (V1, V2, V4 run in the container) says, and so does the hand work in the comment above
    expect(await db.sales(today, today)).toEqual(['4', '32900.00']);
    expect(await db.cancelled(today, today)).toEqual(['1', '3000.00']); // OB-0002, cancelled, is a cancelled opening bill: on no line
    expect(await db.owed()).toEqual(['13900.00', '3']);
    expect(await db.net('Cash', today, today)).toBe('5300.00');
    expect(await db.net('UPI', today, today)).toBe('20000.00');

    // THE KPIs
    await expect(page.getByTestId('kpi-today-sales')).toHaveText('₹32,900', { timeout: 60_000 });
    await expect(page.getByTestId('kpi-today-bills')).toHaveText('4 bills');
    await expect(page.getByTestId('kpi-month-sales')).toHaveText('₹32,900');
    await expect(page.getByTestId('kpi-month-tile')).toHaveText('₹32,900');
    await expect(page.getByTestId('kpi-cancelled-today')).toHaveText(
      'Cancelled today: 1 bill · ₹3,000'
    );
    await expect(page.getByTestId('kpi-outstanding')).toHaveText('₹13,900');
    // the screen is the database
    await expect(page.getByTestId('kpi-today-sales')).toHaveText(rupees('32900.00'));
    await expect(page.getByTestId('kpi-outstanding')).toHaveText(rupees('13900.00'));

    // THE EVENING CHECK: today's Cash net, today's UPI net, the total outstanding
    await expect(page.getByTestId('evening-date')).toHaveText(dayShown(today));
    await expect(page.getByTestId('evening-cash')).toHaveText('₹5,300', { timeout: 30_000 });
    await expect(page.getByTestId('evening-upi')).toHaveText('₹20,000');
    await expect(page.getByTestId('evening-outstanding')).toHaveText('₹13,900');
    await expect(page.getByTestId('evening-cash')).toHaveText(
      rupees(await db.net('Cash', today, today))
    );
    await expect(page.getByTestId('evening-upi')).toHaveText(
      rupees(await db.net('UPI', today, today))
    );

    // THE PENDING PAYMENTS: five bills, the opening dues among them and the cancelled ones not, adding up to the outstanding of the tile
    const rows = page.getByTestId('pending-row');
    await expect(rows).toHaveCount(5);
    const text = (await rows.allInnerTexts()).join('\n');
    expect(text).toContain('OB-0001');
    expect(text).not.toContain('W12-0002');
    expect(text).not.toContain('OB-0002');
    expect(await page.getByTestId('pending-amount').allInnerTexts()).toEqual(
      expect.arrayContaining(['₹6,000', '₹5,000', '₹1,000', '₹900'])
    );
    await expect(page.getByTestId('pending-total')).toHaveText('₹13,900');
    await expect(page.getByTestId('pending-total')).toHaveText(
      await page.getByTestId('kpi-outstanding').innerText()
    );
    await expect(page.getByTestId('pending-total')).toHaveText(
      await page.getByTestId('evening-outstanding').innerText()
    );
  });

  test("the Reports: Sales and Payments show the dashboard's figures, the table adds up to the sales, the list adds up to the outstanding", async ({
    page,
  }) => {
    await laneSql(fixtureSql());
    await open(page, e2eLogin('owner'));
    await makeTheDay(page);
    await page.goto('/reports');
    const today = kolkataDate();
    const from = monthStart();

    // SALES
    await page.getByRole('main').getByRole('button', { name: 'Sales', exact: true }).click();
    const dbSales = await db.sales(from, today);
    const dbCancelled = await db.cancelled(from, today);
    expect(dbSales).toEqual(['4', '32900.00']);
    await expect(page.getByTestId('rs-total')).toHaveText(rupees(dbSales[1]), { timeout: 60_000 });
    await expect(page.getByTestId('rs-invoices')).toHaveText(dbSales[0]);
    await expect(page.getByTestId('rs-cancelled')).toHaveText(
      `${billsText(Number(dbCancelled[0]))} · ${rupees(dbCancelled[1])}`
    );
    await expect(page.getByTestId('rs-gold')).toHaveText('₹29,000');
    await expect(page.getByTestId('rs-silver')).toHaveText('₹4,400');
    const cats = await page
      .getByTestId('rs-cat-row')
      .evaluateAll((rows) =>
        rows.map((row) =>
          [...row.querySelectorAll('td')].slice(0, 3).map((c) => (c.textContent ?? '').trim())
        )
      );
    expect(cats).toEqual([
      ['Anklet', '7', '₹4,400'],
      ['Necklace', '1', '₹20,000'],
      ['Ring', '1', '₹9,000'],
    ]);
    // 4,400 + 20,000 + 9,000 = 33,400; the bills' own discount (500) makes the sales figure
    await expect(page.getByTestId('rs-adjustment-row').locator('td').nth(2)).toHaveText('-₹500');
    await expect(page.getByTestId('rs-total-row').locator('td').nth(2)).toHaveText('₹32,900');
    // the same sales as the dashboard's month
    await page.goto('/');
    await expect(page.getByTestId('kpi-month-sales')).toHaveText(rupees(dbSales[1]), {
      timeout: 60_000,
    });
    await page.goto('/reports');

    // PAYMENTS
    await page.getByRole('main').getByRole('button', { name: 'Payments', exact: true }).click();
    const cash = await db.flow('Cash', from, today);
    const upi = await db.flow('UPI', from, today);
    expect(cash).toEqual(['5500.00', '200.00']); // in 4,000 + 1,500, out 200
    expect(upi).toEqual(['20000.00', '0.00']);
    await expect(page.getByTestId('rp-collected')).toHaveText('₹25,300', { timeout: 60_000 });
    await expect(page.getByTestId('rp-outstanding')).toHaveText(rupees((await db.owed())[0]));
    await expect(page.getByTestId('rp-customers')).toHaveText((await db.owed())[1]);
    await expect(page.getByTestId('rp-upi')).toHaveText('79.1%'); // 20,000 of 25,300
    const modes = await page
      .getByTestId('rp-mode-row')
      .evaluateAll((rows) =>
        rows.map((row) => [...row.querySelectorAll('td')].map((c) => (c.textContent ?? '').trim()))
      );
    expect(modes).toEqual([
      ['Cash', '₹5,500', '₹200', '₹5,300', '20.9%'],
      ['UPI', '₹20,000', '₹0', '₹20,000', '79.1%'],
    ]);
    await expect(page.getByTestId('rp-out-row')).toHaveCount(5);
    await expect(page.getByTestId('rp-list-total')).toHaveText('₹13,900');
    await expect(page.getByTestId('rp-list-total')).toHaveText(
      await page.getByTestId('rp-outstanding').innerText()
    );
  });

  test("the customer cards and the header of the ledger: purchases, received, outstanding, the advance, the bill counts; the cards add up to the dashboard's outstanding", async ({
    page,
  }) => {
    await laneSql(fixtureSql());
    await open(page, e2eLogin('owner'));
    await makeTheDay(page);
    await page.goto('/customer-ledger');
    await expect(page.getByRole('heading', { name: 'Customer Ledger' })).toBeVisible({
      timeout: 60_000,
    });
    const owed = await db.owed();
    await expect(page.getByTestId('ledger-total-outstanding')).toHaveText(rupees(owed[0]), {
      timeout: 30_000,
    });

    const openCard = async (name: string) => {
      await page.getByPlaceholder('Search customers...').fill(name);
      await page.getByRole('button', { name: new RegExp(name) }).click();
      await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
    };
    const card = (key: string) => page.getByTestId(key);

    // MEERA: purchases 10,000 (the opening dues are not purchases), received 4,000, outstanding 6,000 + 5,000 = 11,000; 1 bill, 1 cancelled (W12-0002; OB-0002 is not one), 2 pending
    await openCard(NAMES.meera);
    await expect(card('cs-purchases')).toHaveText('₹10,000');
    await expect(card('cs-received')).toHaveText('₹4,000');
    await expect(card('cs-outstanding')).toHaveText('₹11,000');
    await expect(card('cs-advance')).toHaveText('₹0');
    await expect(card('cs-balance')).toHaveText('₹11,000');
    await expect(card('cs-bills')).toHaveText('1 bill · 1 cancelled · 2 pending');

    // DEV: purchases 22,000, received 20,000, outstanding 2,000
    await openCard(NAMES.dev);
    await expect(card('cs-purchases')).toHaveText('₹22,000');
    await expect(card('cs-received')).toHaveText('₹20,000');
    await expect(card('cs-outstanding')).toHaveText('₹2,000');
    await expect(card('cs-bills')).toHaveText('2 bills · 0 cancelled · 2 pending');

    // ASHA: 1,000 billed last month, 1,500 paid, 200 handed back: an advance of 300
    await openCard(NAMES.asha);
    await expect(card('cs-outstanding')).toHaveText('₹0');
    await expect(card('cs-advance')).toHaveText('₹300');
    await expect(card('cs-balance')).toHaveText('₹300 advance');
    await expect(card('cs-bills')).toHaveText('1 bill · 0 cancelled · 0 pending');

    // THE CARDS ADD UP: 11,000 + 2,000 + 0 + the walk-in's 900 = the outstanding of the dashboard
    await openCard('Walk-in');
    await expect(card('cs-outstanding')).toHaveText('₹900');
    expect(11000 + 2000 + 0 + 900).toBe(Number(owed[0]));
  });

  test('a payment made now moves the evening check, the outstanding and the sales report within a poll, with no reload', async ({
    page,
  }) => {
    await laneSql(fixtureSql());
    await open(page, e2eLogin('owner'));
    await makeTheDay(page);
    await page.goto('/');
    await expect(page.getByTestId('evening-cash')).toHaveText('₹5,300', { timeout: 60_000 });
    await expect(page.getByTestId('kpi-outstanding')).toHaveText('₹13,900');

    // 1,000 in cash on Dev's W12-0003 (1,000 pending): the cash goes up by 1,000, the outstanding down by 1,000
    const paid = await apiCall(page, `/v1/customers/${ids.dev}/payments`, {
      amount: '1000.00',
      mode: 'Cash',
      bill_id: ids.bills.d1,
    });
    expect(paid.status).toBe(201);
    await expect(page.getByTestId('evening-cash')).toHaveText('₹6,300', { timeout: 45_000 });
    await expect(page.getByTestId('evening-upi')).toHaveText('₹20,000');
    await expect(page.getByTestId('evening-outstanding')).toHaveText('₹12,900', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('kpi-outstanding')).toHaveText('₹12,900');
    await expect(page.getByTestId('pending-total')).toHaveText('₹12,900');
    expect(await db.net('Cash', kolkataDate(), kolkataDate())).toBe('6300.00');

    // and cancelling a bill moves the cancelled line and the sales: W12-0004 (2,000) is cancelled
    const cancelled = await apiCall(page, `/v1/bills/${ids.bills.d2}/cancel`, {
      reason: 'wrong piece',
    });
    expect(cancelled.status).toBe(200);
    await expect(page.getByTestId('kpi-today-sales')).toHaveText('₹30,900', { timeout: 45_000 });
    await expect(page.getByTestId('kpi-cancelled-today')).toHaveText(
      'Cancelled today: 2 bills · ₹5,000'
    );
    expect(await db.sales(kolkataDate(), kolkataDate())).toEqual(['3', '30900.00']);
  });

  test('a biller sees no sales, no outstanding, no evening check and no health line on the dashboard', async ({
    page,
  }) => {
    await laneSql(fixtureSql());
    await open(page, e2eLogin('biller'));
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 60_000 });
    // the stock tiles are there (the grid is drawn), the owner's are not
    await expect(page.getByText('Total Designs').first()).toBeVisible();
    for (const id of [
      'kpi-today-sales',
      'kpi-month-sales',
      'kpi-outstanding',
      'kpi-cancelled-today',
      'evening-check',
      'health-line',
    ]) {
      await expect(page.getByTestId(id)).toHaveCount(0);
    }
  });
});

// ------------------------------------------------------------------------------------------------ the dashboard line

/** The line of the dashboard, read by its test ids. */
const line = (page: Page) => ({
  root: page.getByTestId('health-line'),
  headline: page.getByTestId('health-headline'),
  books: page.getByTestId('health-books'),
  fact: (id: string) => page.getByTestId(`health-${id}`),
  reason: (code: string) => page.getByTestId(`health-reason-${code}`),
});

/** The Asia/Kolkata clock time (HH:MM) and day of an instant, worked out here and not by the application. */
function kolkata(isoUtc: string): { time: string; date: string } {
  const local = new Date(Date.parse(isoUtc) + 19_800_000).toISOString();
  return { time: local.slice(11, 16), date: local.slice(0, 10) };
}

/** A healthy night: the check ran 3 hours ago, a backup and a photo copy 4 hours ago; the system started 5 days ago. */
const HEALTHY_SQL = (reviewDate: string) =>
  [
    `INSERT INTO check_runs (ran_at, ok, details) VALUES (UTC_TIMESTAMP(6) - INTERVAL 5 DAY, 1, JSON_OBJECT('date', '${kolkataDate(5)}'));`,
    `INSERT INTO check_runs (ran_at, ok, details) VALUES (UTC_TIMESTAMP(6) - INTERVAL 3 HOUR, 1, JSON_OBJECT('date', '${kolkataDate()}', 'review', ` +
      `JSON_OBJECT('date', '${reviewDate}', 'counts', JSON_OBJECT('discount_over', 2, 'cancellations', 1, 'refunds', 3, 'walkin_bills', 4), ` +
      `'walkin', JSON_OBJECT('cash_total', '4500.50', 'bills', 4), 'lists', JSON_OBJECT())));`,
    `INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (UTC_TIMESTAMP(6) - INTERVAL 5 DAY, 'db_dump', 1, 1000, JSON_OBJECT());`,
    `INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (UTC_TIMESTAMP(6) - INTERVAL 4 HOUR, 'db_dump', 1, 2000, ` +
      `JSON_OBJECT('folder', JSON_OBJECT('files', 12, 'bytes', 5242880, 'free_bytes', 1000000)));`,
    `INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (UTC_TIMESTAMP(6) - INTERVAL 4 HOUR, 'photo_copy', 1, 0, ` +
      `JSON_OBJECT('folder', JSON_OBJECT('files', 12, 'bytes', 5242880, 'free_bytes', 1000000)));`,
  ].join(' ');

test.describe("T-B18 / T-R03 / T-R05 E2E: the owner's dashboard line turns red and amber as the API computes", () => {
  test.describe.configure({ timeout: 240_000 });

  test('a lane where no night has run: red, with the three "never" reasons and nothing made up', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'red');
    await expect(line(page).headline).toHaveText('Problem');
    await expect(line(page).books).toContainText('Books: Not checked yet');
    await expect(line(page).fact('backup')).toContainText('None yet');
    await expect(line(page).fact('photos')).toContainText('None yet');
    await expect(line(page).fact('folder')).toContainText('Not recorded yet');
    await expect(line(page).fact('download')).toContainText('No record yet');
    for (const code of ['check_never', 'dump_never', 'photo_copy_never']) {
      await expect(line(page).reason(code)).toHaveAttribute('data-tone', 'red');
    }
    await expect(line(page).fact('backup')).toHaveAttribute('data-tone', 'red');
    // no review line: the check has not run
    await expect(page.getByTestId('health-review')).toHaveCount(0);
  });

  test("a healthy night: green, Books OK at the time of the check, the ages, the sizes, the days and yesterday's review counts", async ({
    page,
  }) => {
    const reviewDate = kolkataDate(1);
    await laneSql(HEALTHY_SQL(reviewDate));
    const [[checkAt]] = await laneSql(
      `SELECT DATE_FORMAT(ran_at, '%Y-%m-%dT%H:%i:%s.000Z') FROM check_runs ORDER BY ran_at DESC, id DESC LIMIT 1`
    );
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'green');
    await expect(line(page).headline).toHaveText('All well');
    // Books: OK at the time the check ran, in India (the day is named when it was not today)
    const check = kolkata(checkAt);
    const when = check.date === kolkataDate() ? check.time : `${check.time} on `;
    await expect(line(page).books).toContainText(`Books: OK at ${when}`);
    await expect(line(page).fact('backup')).toContainText('4 hours ago');
    await expect(line(page).fact('photos')).toContainText('4 hours ago');
    await expect(line(page).fact('database')).toContainText(/\d+ (KB|MB) of 2 GB/);
    await expect(line(page).fact('folder')).toContainText('5 MB · 12 files');
    // no Download everything yet and no pull: counted from the first night and the first backup, 5 days
    await expect(line(page).fact('download')).toContainText(
      'Not done yet · 5 days since the first night'
    );
    await expect(line(page).fact('pull')).toContainText(
      'Not reported yet · 5 days since the first backup'
    );
    for (const id of ['backup', 'photos', 'database', 'folder', 'download', 'pull']) {
      await expect(line(page).fact(id)).toHaveAttribute('data-tone', 'ok');
    }
    await expect(page.getByTestId('health-reasons')).toHaveCount(0);
    // yesterday's review: the non-zero counts and the walk-in's cash
    await expect(page.getByTestId('health-review')).toContainText(
      `yesterday, ${dayShown(reviewDate)}`
    );
    await expect(page.getByTestId('review-discount_over')).toContainText('2');
    await expect(page.getByTestId('review-cancellations')).toContainText('1');
    await expect(page.getByTestId('review-refunds')).toContainText('3');
    await expect(page.getByTestId('review-walkin_bills')).toContainText('4');
    await expect(page.getByTestId('review-voids')).toHaveCount(0);
    await expect(page.getByTestId('review-walkin-cash')).toHaveText('₹4,500.50');
  });

  test('red together with amber: the check found a problem, the backup and the photo copy are 30 hours old, Download everything is 30 days old and the pull 12 days', async ({
    page,
  }) => {
    await laneSql(HEALTHY_SQL(kolkataDate(1)));
    await laneSql(
      `UPDATE check_runs SET ok = 0 WHERE ran_at > UTC_TIMESTAMP(6) - INTERVAL 1 DAY; ` +
        `UPDATE backup_runs SET ran_at = UTC_TIMESTAMP(6) - INTERVAL 30 HOUR WHERE kind IN ('db_dump', 'photo_copy') AND ran_at > UTC_TIMESTAMP(6) - INTERVAL 1 DAY; ` +
        `INSERT INTO settings (setting_key, value) VALUES ('last_download', JSON_OBJECT('at', DATE_FORMAT(UTC_TIMESTAMP(6) - INTERVAL 30 DAY, '%Y-%m-%dT%H:%i:%s.000000Z'), 'counts', JSON_OBJECT())); ` +
        `INSERT INTO settings (setting_key, value) VALUES ('last_pulled', JSON_OBJECT('at', DATE_FORMAT(UTC_TIMESTAMP(6) - INTERVAL 12 DAY, '%Y-%m-%dT%H:%i:%s.000000Z')));`
    );
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'red');
    await expect(line(page).headline).toHaveText('Problem');
    await expect(line(page).books).toContainText('Books: Problem found at');
    await expect(line(page).books).toHaveAttribute('data-tone', 'red');
    await expect(line(page).fact('backup')).toContainText('30 hours ago');
    for (const code of ['check_problem', 'dump_stale', 'photo_copy_stale']) {
      await expect(line(page).reason(code)).toHaveAttribute('data-tone', 'red');
    }
    for (const code of ['download_amber', 'pulled_amber']) {
      await expect(line(page).reason(code)).toHaveAttribute('data-tone', 'amber');
    }
    await expect(line(page).fact('download')).toContainText('30 days ago');
    await expect(line(page).fact('download')).toHaveAttribute('data-tone', 'amber');
    await expect(line(page).fact('pull')).toContainText('12 days ago');
    await expect(line(page).fact('pull')).toHaveAttribute('data-tone', 'amber');
  });

  test('amber only: Download everything 28 days old and the pull 11 days old turn a healthy line amber, not red', async ({
    page,
  }) => {
    await laneSql(HEALTHY_SQL(kolkataDate(1)));
    await laneSql(
      `INSERT INTO settings (setting_key, value) VALUES ('last_download', JSON_OBJECT('at', DATE_FORMAT(UTC_TIMESTAMP(6) - INTERVAL 28 DAY, '%Y-%m-%dT%H:%i:%s.000000Z'), 'counts', JSON_OBJECT())); ` +
        `INSERT INTO settings (setting_key, value) VALUES ('last_pulled', JSON_OBJECT('at', DATE_FORMAT(UTC_TIMESTAMP(6) - INTERVAL 11 DAY, '%Y-%m-%dT%H:%i:%s.000000Z')));`
    );
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'amber');
    await expect(line(page).headline).toHaveText('Reminder');
    await expect(line(page).reason('download_amber')).toHaveText(
      'It is time to use Download everything.'
    );
    await expect(line(page).reason('pulled_amber')).toBeVisible();
    await expect(line(page).fact('download')).toContainText('28 days ago');
    // nothing is red: the books, the backup and the photo copy are fine
    for (const id of ['backup', 'photos', 'database', 'folder']) {
      await expect(line(page).fact(id)).toHaveAttribute('data-tone', 'ok');
    }
    await expect(page.locator('[data-testid^="health-reason-"][data-tone="red"]')).toHaveCount(0);
  });

  test('red: Download everything 36 days old, and the file count of the backup folder fell without a prune', async ({
    page,
  }) => {
    await laneSql(HEALTHY_SQL(kolkataDate(1)));
    await laneSql(
      // an earlier good night recorded 20 files; tonight's records 12 and pruned none
      `INSERT INTO backup_runs (ran_at, kind, ok, bytes, detail) VALUES (UTC_TIMESTAMP(6) - INTERVAL 30 HOUR, 'db_dump', 1, 2000, ` +
        `JSON_OBJECT('folder', JSON_OBJECT('files', 20, 'bytes', 9000000, 'free_bytes', 1000000))); ` +
        `INSERT INTO settings (setting_key, value) VALUES ('last_download', JSON_OBJECT('at', DATE_FORMAT(UTC_TIMESTAMP(6) - INTERVAL 36 DAY, '%Y-%m-%dT%H:%i:%s.000000Z'), 'counts', JSON_OBJECT()));`
    );
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'red');
    await expect(line(page).reason('backup_files_fell')).toHaveAttribute('data-tone', 'red');
    await expect(line(page).reason('download_red')).toHaveAttribute('data-tone', 'red');
    await expect(line(page).fact('folder')).toHaveAttribute('data-tone', 'red');
    await expect(line(page).fact('download')).toHaveAttribute('data-tone', 'red');
    await expect(line(page).fact('download')).toContainText('36 days ago');
  });

  test('RV3a words: the four reasons about the backup folder, the photo copies and the clock arrive as plain sentences in the API order, and the folder says it cannot be used', async ({
    page,
  }) => {
    // The lane's own night is healthy; the health body is then made to carry what an API with RV3a sends for a broken folder, a damaged and a repaired photo copy and a clock that is ahead.
    // The words and the colours are the website's, so the body is written here, not worked out by the lane's API (which may be older than RV3a): every other field is the lane's own.
    await laneSql(HEALTHY_SQL(kolkataDate(1)));
    await page.route('**/v1/dashboard/health', async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as { now: string };
      await route.fulfill({
        response,
        json: {
          ...body,
          level: 'red',
          reasons: [
            'backup_folder_unusable',
            'backup_photos_damaged',
            'backup_clock_ahead',
            'backup_photos_repaired',
          ],
          folder_probe: { ok: false, code: 'ENOENT', where: 'folder', at: body.now },
          photo_files: { repaired: 2, repaired_at: body.now, damaged: 1, damaged_at: body.now },
          clock_ahead: { last_at: body.now, hours: 3 },
        },
      });
    });
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'red');
    await expect(line(page).headline).toHaveText('Problem');
    // the sentences, in the order the API gave the codes
    await expect(page.locator('[data-testid^="health-reason-"]')).toHaveText([
      'The backup folder is missing or cannot be written to. Tell Harsh.',
      'A photo copy in the backup folder is damaged. Tell Harsh.',
      'A backup is dated in the future, so its age cannot be trusted. Tell Harsh.',
      'Photo copies were missing from the backup folder and have been copied again. Tell Harsh.',
    ]);
    for (const code of ['backup_folder_unusable', 'backup_photos_damaged', 'backup_clock_ahead']) {
      await expect(line(page).reason(code)).toHaveAttribute('data-tone', 'red');
    }
    await expect(line(page).reason('backup_photos_repaired')).toHaveAttribute('data-tone', 'amber');
    // the fact each reason belongs to takes its colour; the folder says it cannot be used instead of its last size
    await expect(line(page).fact('folder')).toContainText('Cannot be used');
    for (const id of ['folder', 'photos', 'backup']) {
      await expect(line(page).fact(id)).toHaveAttribute('data-tone', 'red');
    }
    await expect(line(page).fact('database')).toHaveAttribute('data-tone', 'ok');
    await expect(line(page).root).not.toContainText('Something needs a look');
  });

  test('red: the nightly check is 30 hours old (the job stopped)', async ({ page }) => {
    await laneSql(HEALTHY_SQL(kolkataDate(1)));
    await laneSql(
      `UPDATE check_runs SET ran_at = UTC_TIMESTAMP(6) - INTERVAL 30 HOUR WHERE ran_at > UTC_TIMESTAMP(6) - INTERVAL 1 DAY;`
    );
    await open(page, e2eLogin('owner'));
    await expect(line(page).root).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'red');
    await expect(line(page).reason('check_stale')).toHaveAttribute('data-tone', 'red');
    await expect(line(page).books).toHaveAttribute('data-tone', 'red');
    // the books were OK when the check last ran: the line says when, and does not say "Problem" about the books themselves
    await expect(line(page).books).toContainText('Books: OK at');
  });

  test('a failure to read the line is said in words, with Try again, and the line comes back when the API answers', async ({
    page,
  }) => {
    await laneSql(HEALTHY_SQL(kolkataDate(1)));
    let refuse = true;
    await page.route('**/v1/dashboard/health', async (route) => {
      if (refuse) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          headers: {
            'access-control-allow-origin': e2eLane().webOrigin,
            'access-control-allow-credentials': 'true',
          },
          body: JSON.stringify({
            error: { code: 'JV_INTERNAL', message: 'Something went wrong.', details: {} },
            request_id: 'req-e2e',
          }),
        });
      } else {
        await route.continue();
      }
    });
    await open(page, e2eLogin('owner'));
    await expect(page.getByTestId('health-error')).toBeVisible({ timeout: 60_000 });
    await expect(line(page).root).toHaveAttribute('data-level', 'unknown');
    refuse = false;
    await page.getByTestId('health-retry').click();
    await expect(line(page).root).toHaveAttribute('data-level', 'green', { timeout: 30_000 });
    await expect(page.getByTestId('health-error')).toHaveCount(0);
  });
});
