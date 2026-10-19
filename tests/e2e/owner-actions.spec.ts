import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import {
  expect,
  test,
  type Browser,
  type BrowserContext,
  type Page,
  type Request,
  type Response,
} from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB11 (PT-W11): the owner's screens in a real browser against the real API of a lane: cancel a bill (X5), re-issue a bill (X10), void a receipt (X4), hand money back (X11), add an
// opening balance (X12), and the error map (spec C5 (b), C6, C13, C17, L5, K1, K3, K6, Y7, Y10, A4).
//   PT-W11  each action works end to end for the owner and is absent for a biller (and the API refuses the biller's own call); "void the refund first" is explained and works in its order;
//           a refund above the advance says by how much; an opening balance makes the opening bill and nets an advance off; a re-issue starts from the old bill, locks the customer, moves
//           the money it had received to the new bill and cancels the old one
//   T-E07   (clause) cancelling an unpaid bill changes the other browser's outstanding within 10 seconds
//   T-E04   (clause) the plain messages on screen: a refusal says that nothing was changed; JV_INTERNAL and a JV_BUSY that fails again say "Could not confirm that this was saved." and the
//           customer's books are read again at once; the detail goes to the console only
//   T-E06   (clause) a double click is one request; an answer lost after the server saved is answered from its store when the button is pressed again (the same key, one cancel)
//
// The bills, receipts and pieces are written as root in the lane's container (the screens that make them are proved in billing.spec.ts and payments.spec.ts); every ACTION under test is the
// screen's own call to the real API. Everything the tests made is taken out again: the volume case of hydrate.spec.ts needs a lane with no bill, receipt or counter that moved on its own.
//
// Run: E2E=1 LANE=a JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/owner-actions.spec.ts

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

// ------------------------------------------------------------------------------------------------ the book of the tests

/**
 * The customers (all `W11 ...`) and their books, worked out by hand:
 *   Priya   W11-0001  7,220.00 for piece W11-S1 (1.000 g of 22K gold at 6,920 + labour 300), nothing paid. Outstanding 7,220.
 *   Meera   W11-0009  700.00, nothing paid (the older bill); W11-0010  1,000.00 with 600.00 received by UPI (receipt M1). Outstanding 700 + 400 = 1,100.
 *   Dev     W11-0020  1,000.00 with 500.00 received by UPI (receipt D1). Outstanding 500.
 *   Gita    no bill. Receipt G1 500.00 UPI (an advance) and REFUND G2 300.00 Cash: advance 500 - 300 = 200.
 *   Asha    no bill. Receipt A1 500.00 UPI: advance 500.
 *   Ravi    nothing at all.
 *   Sita    W11-0030  7,220.00 for piece W11-S2 with 5,000.00 received by UPI (receipt S1): outstanding 2,220.
 *   Lata    W11-0040  1,000.00, nothing paid. Outstanding 1,000 (the other browser's case).
 */
const ids = {
  design: randomUUID(),
  rate: randomUUID(),
  customers: {
    priya: randomUUID(),
    meera: randomUUID(),
    dev: randomUUID(),
    gita: randomUUID(),
    asha: randomUUID(),
    ravi: randomUUID(),
    sita: randomUUID(),
    lata: randomUUID(),
  },
  bills: {
    p1: randomUUID(),
    m0: randomUUID(),
    m1: randomUUID(),
    d1: randomUUID(),
    s1: randomUUID(),
    l1: randomUUID(),
  },
  receipts: {
    m1: randomUUID(),
    d1: randomUUID(),
    g1: randomUUID(),
    g2: randomUUID(),
    a1: randomUUID(),
    s1: randomUUID(),
  },
};
const NAMES = {
  priya: 'W11 Priya',
  meera: 'W11 Meera',
  dev: 'W11 Dev',
  gita: 'W11 Gita',
  asha: 'W11 Asha',
  ravi: 'W11 Ravi',
  sita: 'W11 Sita',
  lata: 'W11 Lata',
};

/** The business date (Asia/Kolkata) `daysAgo` days before today, as the API works it out. */
function kolkata(daysAgo = 0): string {
  return new Date(Date.now() + 19_800_000 - daysAgo * 86_400_000).toISOString().slice(0, 10);
}

function fixtureSql(): string {
  const customer = (key: keyof typeof ids.customers, type: string, mobile: string) =>
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${ids.customers[key]}', '${NAMES[key]}', '${mobile}', '${type}');`;
  const piece = (n: number) =>
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, piroi, labour_retail, labour_semi, labour_wholesale, status) VALUES ` +
    `('${randomUUID()}', '${ids.design}', 'W11-S${n}', 'W11BC${n}', 1.200, 1.000, 0.00, 300.00, 280.00, 260.00, 'In Stock');`;
  // a piece is sold when its bill exists (the bill is the piece's foreign key)
  const sold = (skuNo: string, billId: string) =>
    `UPDATE skus SET status = 'Sold', sold_bill_id = '${billId}' WHERE sku_no = '${skuNo}';`;
  const bill = (
    id: string,
    number: string,
    customerKey: keyof typeof ids.customers,
    daysAgo: number,
    total: string
  ) =>
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total, created_at) VALUES ` +
    `('${id}', '${number}', '${ids.customers[customerKey]}', CURDATE() - INTERVAL ${daysAgo} DAY, 'Retail', ${total}, ${total}, TIMESTAMP(CURDATE() - INTERVAL ${daysAgo} DAY, '00:0${daysAgo}:00'));`;
  // a line of 1.000 g of 22K gold at 6,920 with labour 300 a gram: 7,220.00
  const line = (billId: string, skuNo: string) =>
    `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
    `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) ` +
    `SELECT '${randomUUID()}', '${billId}', 1, s.id, 'W11-D1', s.sku_no, 'Ring', 'Gold', '22K', 'By Weight', 1.200, 1.000, 1, 6920.00, 300.00, 300.00, 0.00, 0.00, 6920.00, 0.000, 7220.00, 6920.00, 300.00 ` +
    `FROM skus s WHERE s.sku_no = '${skuNo}';`;
  const receipt = (
    id: string,
    customerKey: keyof typeof ids.customers,
    kind: string,
    mode: string,
    amount: string,
    daysAgo = 0
  ) =>
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on, created_at) VALUES ('${id}', '${ids.customers[customerKey]}', '${kind}', '${mode}', ${amount}, ` +
    `CURDATE() - INTERVAL ${daysAgo} DAY, TIMESTAMP(CURDATE() - INTERVAL ${daysAgo} DAY, '00:1${daysAgo}:00'));`; // early in the day (a bill 00:0x, a receipt 00:1x), so that whatever the test makes at the time it runs is later (12:xx made the order depend on the hour the suite ran at)
  const allocation = (
    receiptId: string,
    billId: string,
    customerKey: keyof typeof ids.customers,
    amount: string
  ) =>
    `INSERT INTO receipt_allocations (id, receipt_id, bill_id, customer_id, amount) VALUES ('${randomUUID()}', '${receiptId}', '${billId}', '${ids.customers[customerKey]}', ${amount});`;
  return [
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${ids.design}', 'W11-D1', 'W11 gold ring', id, 'Gold', '22K', 'By Weight' FROM categories WHERE name = 'Ring';`,
    `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES ('${ids.rate}', 'Gold', '22K', 6920.00, '${kolkata()}');`,
    customer('priya', 'Retail', '9000110001'),
    customer('meera', 'Retail', '9000110002'),
    customer('dev', 'Retail', '9000110003'),
    customer('gita', 'Retail', '9000110004'),
    customer('asha', 'Retail', '9000110005'),
    customer('ravi', 'Retail', '9000110006'),
    customer('sita', 'Retail', '9000110007'),
    customer('lata', 'Retail', '9000110008'),
    // pieces: S1 is sold on Priya's bill, S2 on Sita's, S3 to S6 are in stock
    ...[1, 2, 3, 4, 5, 6].map(piece),
    bill(ids.bills.p1, 'W11-0001', 'priya', 1, '7220.00'),
    line(ids.bills.p1, 'W11-S1'),
    bill(ids.bills.m0, 'W11-0009', 'meera', 3, '700.00'),
    bill(ids.bills.m1, 'W11-0010', 'meera', 2, '1000.00'),
    bill(ids.bills.d1, 'W11-0020', 'dev', 1, '1000.00'),
    bill(ids.bills.s1, 'W11-0030', 'sita', 1, '7220.00'),
    line(ids.bills.s1, 'W11-S2'),
    bill(ids.bills.l1, 'W11-0040', 'lata', 1, '1000.00'),
    sold('W11-S1', ids.bills.p1),
    sold('W11-S2', ids.bills.s1),
    receipt(ids.receipts.m1, 'meera', 'money', 'UPI', '600.00', 1),
    allocation(ids.receipts.m1, ids.bills.m1, 'meera', '600.00'),
    receipt(ids.receipts.d1, 'dev', 'money', 'UPI', '500.00', 0),
    allocation(ids.receipts.d1, ids.bills.d1, 'dev', '500.00'),
    receipt(ids.receipts.g1, 'gita', 'money', 'UPI', '500.00', 2),
    receipt(ids.receipts.g2, 'gita', 'refund', 'Cash', '300.00', 1),
    receipt(ids.receipts.a1, 'asha', 'money', 'UPI', '500.00', 0),
    receipt(ids.receipts.s1, 'sita', 'money', 'UPI', '5000.00', 0),
    allocation(ids.receipts.s1, ids.bills.s1, 'sita', '5000.00'),
    // what the money services do on every write (D23): the customer gets a new `updated_at`, which is how the polls find a change
    `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name LIKE 'W11 %';`,
  ].join(' ');
}

/**
 * Everything these tests made, gone again. The delete order follows the foreign keys. A re-issue and an opening balance make bills and counters of their own: every bill and receipt of a
 * `W11 ` customer goes, and so does the series row of a counter that moved with no bill behind it (the volume case of hydrate.spec.ts refuses one, invariant I5).
 */
async function cleanLane() {
  const own = `SELECT id FROM customers WHERE name LIKE 'W11 %'`;
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id IN (${own}); ` +
      `DELETE FROM receipts WHERE customer_id IN (${own}); ` +
      `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE customer_id IN (${own})); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W11-%'; ` +
      // a re-issue points back at the bill it replaces (a foreign key): the new bill goes first
      `DELETE FROM bills WHERE reissue_of IS NOT NULL AND customer_id IN (${own}); ` +
      `DELETE FROM bills WHERE customer_id IN (${own}); ` +
      `DELETE FROM designs WHERE design_no LIKE 'W11-%'; ` +
      `DELETE FROM customers WHERE name LIKE 'W11 %'; ` +
      `DELETE FROM daily_rates WHERE id = '${ids.rate}';`
  );
  await laneSql(
    `DELETE FROM sys_counters WHERE series LIKE 'bill:%' AND NOT EXISTS (` +
      `SELECT 1 FROM bills b WHERE b.import_batch_id IS NULL AND sys_counters.series = CONCAT('bill:', ` +
      `SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1), ` +
      `':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1)))`
  );
  await laneSql(
    `DELETE FROM sys_counters WHERE series = 'opening' AND NOT EXISTS ` +
      `(SELECT 1 FROM bills b WHERE b.doc_type = 'opening_balance' AND b.import_batch_id IS NULL)`
  );
}

// ---- what the database says (ordered by something that cannot tie: the rows of one call share one stamp, so the bill number or the amount breaks a tie, never the random id)

/** A bill: status, cancel reason, grand total, replaced-bill number. */
const billOf = async (billNo: string) =>
  (
    await laneSql(
      `SELECT b.status, IFNULL(b.cancel_reason, '-'), b.grand_total, IFNULL((SELECT o.bill_no FROM bills o WHERE o.id = b.reissue_of), '-') ` +
        `FROM bills b WHERE b.bill_no = '${billNo}'`
    )
  )[0];
const pieceStatus = async (skuNo: string) =>
  (await laneSql(`SELECT status FROM skus WHERE sku_no = '${skuNo}'`))[0]?.[0];
/** The receipts of a customer: kind, mode, amount, status, void reason, oldest first (ties on the amount). */
const receiptsOf = (name: string) =>
  laneSql(
    `SELECT r.kind, IFNULL(r.mode, '-'), r.amount, r.status, IFNULL(r.void_reason, '-'), IFNULL(r.reference, '-') FROM receipts r ` +
      `JOIN customers c ON c.id = r.customer_id WHERE c.name = '${name}' ORDER BY r.created_at, r.amount`
  );
/** The allocations of a customer: bill number, amount, live or released; the live ones first, then by bill number (the rows of one call share one stamp, so never the random id). */
const allocationsOf = (name: string) =>
  laneSql(
    `SELECT b.bill_no, a.amount, IF(a.released_at IS NULL, 'live', 'released') FROM receipt_allocations a JOIN bills b ON b.id = a.bill_id ` +
      `JOIN customers c ON c.id = a.customer_id WHERE c.name = '${name}' ORDER BY 3, b.bill_no, a.amount`
  );
const billsOfCustomer = (name: string) =>
  laneSql(
    `SELECT b.bill_no, b.doc_type, b.status, b.grand_total, b.fine_weight_due, b.bill_date FROM bills b JOIN customers c ON c.id = b.customer_id ` +
      `WHERE c.name = '${name}' ORDER BY b.bill_no`
  );

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The CORS headers a made-up answer needs so that the browser hands it to the page. */
const corsHeaders = () => ({
  'access-control-allow-origin': e2eLane().webOrigin,
  'access-control-allow-credentials': 'true',
});

/** Opens the customer ledger as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, target = '/customer-ledger') {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
}

async function openLedger(page: Page, who: E2eLogin) {
  await open(page, who);
  await expect(page.getByRole('heading', { name: 'Customer Ledger' })).toBeVisible();
}

async function openCard(page: Page, name: string) {
  await page.getByPlaceholder('Search customers...').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('heading', { name, level: 2 })).toBeVisible();
}

async function openTab(page: Page, label: 'Ledger' | 'Invoices' | 'Payments') {
  await page.getByRole('button', { name: new RegExp(`^${label}`) }).click();
}

/** The figures of the customer card by their test ids ("cs-outstanding", "cs-advance", "cs-fine"). */
const tile = (page: Page, key: string) => page.getByTestId(key);
/** The row of the Invoices tab of a bill. */
const invoiceRow = (page: Page, billNo: string) =>
  page.getByTestId('invoice-row').filter({ hasText: billNo });
const cancelDialog = (page: Page) => page.getByTestId('cancel-dialog');
const voidDialog = (page: Page) => page.getByTestId('void-dialog');
const banner = (page: Page) => page.getByTestId('connection-banner');

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
        body: (await response.json().catch(() => null)) as { error?: { code?: string } } | null,
      };
    },
    { url: `${apiUrl}${route}`, payload: body, key: randomUUID() }
  );
}

/** The calls the page makes to a path of the API (a request and its answer). */
function callsTo(page: Page, matches: (url: string, method: string) => boolean) {
  const requests: Request[] = [];
  const responses: Response[] = [];
  page.on('request', (request) => {
    if (matches(request.url(), request.method())) requests.push(request);
  });
  page.on('response', (response) => {
    if (matches(response.url(), response.request().method())) responses.push(response);
  });
  return { requests, responses };
}
const isCancel = (url: string, method: string) =>
  method === 'POST' && /\/v1\/bills\/[0-9a-f-]+\/cancel$/.test(url);
const isPoll = (url: string, method: string) =>
  method === 'POST' && url === `${e2eLane().apiUrl}/v1/sync/poll`;

/** Holds every poll of the page until `release()`: the page's memory stays as it is, so a case can be set up where the screen is out of date. */
async function holdPolls(page: Page): Promise<() => void> {
  const { apiUrl } = e2eLane();
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`${apiUrl}/v1/sync/poll`, async (route) => {
    await gate;
    await route.fallback();
  });
  return release;
}

/** Opens the Invoices tab of a customer and cancels a bill with a reason; returns when the dialog shows its answer. */
async function cancelBill(page: Page, billNo: string, reason: string) {
  await openTab(page, 'Invoices');
  await invoiceRow(page, billNo).getByTestId('cancel-bill').click();
  await expect(cancelDialog(page)).toBeVisible();
  await page.getByTestId('cancel-reason').fill(reason);
  await page.getByTestId('cancel-confirm').click();
}

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute and starts
// from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
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
  // the lane is as it was found: none of this file's customers, bills, receipts or pieces, and no counter that moved with no bill behind it
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE 'W11 %'), ` +
      `(SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W11-%' OR doc_type = 'opening_balance' OR reissue_of IS NOT NULL), ` +
      `(SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W11-%'), ` +
      `(SELECT COUNT(*) FROM sys_counters WHERE series = 'opening' OR series LIKE 'bill:%')`
  );
  expect(left).toEqual(['0', '0', '0', '0']);
});

/** A second browser: its own context, signed in as `who` on the customer ledger. */
async function secondBrowser(
  browser: Browser,
  who: E2eLogin
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  const page = await context.newPage();
  await roomInTheMinute(page);
  await openLedger(page, who);
  return { context, page };
}

// ------------------------------------------------------------------------------------------------ PT-W11: cancel (X5)

test.describe('PT-W11: the owner cancels a bill (X5, K3)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('an unpaid bill: a reason of fewer than 3 characters is refused on the screen; then the bill is cancelled, its piece is back in stock, and the card, the list and the estimate say so', async ({
    page,
  }) => {
    const { requests } = callsTo(page, isCancel);
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹7,220');
    await openTab(page, 'Invoices');
    await expect(invoiceRow(page, 'W11-0001').getByTestId('reissue-bill')).toBeVisible();

    await invoiceRow(page, 'W11-0001').getByTestId('cancel-bill').click();
    await expect(cancelDialog(page)).toContainText('Cancel W11-0001');
    await page.getByTestId('cancel-reason').fill('ab');
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('cancel-error')).toContainText('at least 3 characters');
    expect(requests).toHaveLength(0); // refused on the screen, before any call
    expect((await billOf('W11-0001'))[0]).toBe('active');

    await page.getByTestId('cancel-reason').fill('  wrong customer entered  ');
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('cancel-result')).toContainText('W11-0001 is cancelled');
    await expect(page.getByTestId('cancel-pieces')).toContainText('1 piece is back in stock');
    expect(requests).toHaveLength(1);
    expect(requests[0].headers()['idempotency-key']).toMatch(KEY);
    expect(requests[0].postDataJSON()).toEqual({ reason: 'wrong customer entered' });
    expect(await billOf('W11-0001')).toEqual([
      'cancelled',
      'wrong customer entered',
      '7220.00',
      '-',
    ]);
    expect(await pieceStatus('W11-S1')).toBe('In Stock');

    await page.getByTestId('cancel-close').click();
    await expect(invoiceRow(page, 'W11-0001')).toContainText('Cancelled');
    await expect(invoiceRow(page, 'W11-0001').getByTestId('cancel-bill')).toHaveCount(0);
    await expect(invoiceRow(page, 'W11-0001').getByTestId('reissue-bill')).toHaveCount(0);
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹0');

    // the estimate says when and why
    await invoiceRow(page, 'W11-0001').getByRole('link', { name: 'View' }).click();
    await expect(page.getByTestId('estimate-cancelled')).toBeVisible();
    await expect(page.getByTestId('estimate-cancel-reason')).toContainText(
      'Reason: wrong customer entered'
    );
    await expect(page.getByTestId('estimate-cancelled-on')).toContainText('Cancelled on');
    await expect(page.getByTestId('cancel-bill')).toHaveCount(0);
  });

  test("a bill with money on it: the money it had received is applied to the customer's older bill, and the answer says so", async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.meera);
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹1,100'); // 700 + (1,000 - 600)
    await cancelBill(page, 'W11-0010', 'duplicate bill');
    await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
    // 600.00 was received on W11-0010; the cancel releases it and the rebalance gives it to W11-0009 (700 -> 100 pending)
    await expect(page.getByTestId('cancel-released')).toContainText('₹600 received on this bill');
    await expect(page.getByTestId('cancel-released')).toContainText('₹600 went to W11-0009');
    expect(await allocationsOf(NAMES.meera)).toEqual([
      ['W11-0009', '600.00', 'live'],
      ['W11-0010', '600.00', 'released'],
    ]);
    await page.getByTestId('cancel-close').click();
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹100');
    await expect(invoiceRow(page, 'W11-0009')).toContainText('Partial');
  });

  test("T-E07 (clause): cancelling an unpaid bill changes the other browser's outstanding within 10 seconds", async ({
    page,
    browser,
  }) => {
    const owner = e2eLogin('owner');
    await openLedger(page, owner);
    await openCard(page, NAMES.lata);
    const other = await secondBrowser(browser, e2eLogin('biller'));
    try {
      await openCard(other.page, NAMES.lata);
      await expect(tile(page, 'cs-outstanding')).toHaveText('₹1,000');
      await expect(tile(other.page, 'cs-outstanding')).toHaveText('₹1,000');

      await cancelBill(page, 'W11-0040', 'wrong bill');
      await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
      // the clock starts when the owner's answer is on screen: the other browser's next poll must bring the customer's new figures
      await expect(tile(other.page, 'cs-outstanding')).toHaveText('₹0', { timeout: 10_000 });
      await openTab(other.page, 'Invoices');
      await expect(invoiceRow(other.page, 'W11-0040')).toContainText('Cancelled', {
        timeout: 10_000,
      });
      // and that browser (a biller) has no button
      await expect(other.page.getByTestId('cancel-bill')).toHaveCount(0);
    } finally {
      await other.context.close();
    }
  });

  test('a double click on the confirm button is ONE request (T-E06)', async ({ page }) => {
    const { requests } = callsTo(page, isCancel);
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.lata);
    await openTab(page, 'Invoices');
    await invoiceRow(page, 'W11-0040').getByTestId('cancel-bill').click();
    await page.getByTestId('cancel-reason').fill('wrong bill');
    await page.getByTestId('cancel-confirm').dblclick();
    await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
    await sleep(1500);
    expect(requests).toHaveLength(1);
    expect((await billOf('W11-0040'))[0]).toBe('cancelled');
  });

  test('a press that gets past the disabled button (changed by hand in the page) is still ONE request: the dialog ignores it, and the money server would join it (T-E06, C6)', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = callsTo(page, isCancel);
    await page.route(`${apiUrl}/v1/bills/*/cancel`, async (route) => {
      if (route.request().method() === 'POST') await sleep(1500); // a slow server: the call is on its way while the presses come
      await route.fallback();
    });
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.lata);
    await cancelBill(page, 'W11-0040', 'wrong bill');
    await expect(page.getByTestId('cancel-confirm')).toBeDisabled();
    // the browser's own protection is taken away, as a script, a held key or a slow render could: two more presses reach the handler while the call is on its way
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="cancel-confirm"]') as HTMLButtonElement;
      button.removeAttribute('disabled');
      button.click();
      button.click();
    });
    await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
    await sleep(1500);
    expect(requests).toHaveLength(1);
    expect((await billOf('W11-0040'))[0]).toBe('cancelled');
  });

  test('the answer is lost after the server saved: the person reads "Could not confirm that this was saved.", the books are read again at once (the card already shows the cancel), and pressing again sends the SAME key and is answered from the store', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests, responses } = callsTo(page, isCancel);
    let dropped = false;
    await page.route(`${apiUrl}/v1/bills/*/cancel`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (!dropped) {
        dropped = true;
        await route.fetch(); // the server gets it, cancels the bill and answers ...
        return route.abort('connectionreset'); // ... and the answer never reaches the page
      }
      return route.fallback();
    });
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.lata);
    await cancelBill(page, 'W11-0040', 'wrong bill');
    await expect(page.getByTestId('cancel-error')).toContainText(
      'Could not confirm that this was saved',
      { timeout: 30_000 }
    );
    await expect(page.getByTestId('cancel-error')).toHaveAttribute('data-unconfirmed', 'true');
    await expect(page.getByTestId('cancel-done')).toHaveCount(0); // the screen does not know, and does not say so
    const [first] = await billOf('W11-0040');
    expect(first).toBe('cancelled'); // it was done; the screen did not know
    // the customer's books are read again at once, so the card already shows what happened, behind the dialog
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹0', { timeout: 10_000 });
    const cancelledAt = (
      await laneSql(`SELECT cancelled_at FROM bills WHERE bill_no = 'W11-0040'`)
    )[0][0];

    await page.getByTestId('cancel-confirm').click(); // the same action again
    await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(KEY);
    const last = responses[responses.length - 1];
    expect(last.status()).toBe(200);
    expect(last.headers()['idempotent-replay']).toBe('true');
    // one cancel: the stamp of the cancel is the first call's
    expect((await laneSql(`SELECT cancelled_at FROM bills WHERE bill_no = 'W11-0040'`))[0][0]).toBe(
      cancelledAt
    );
  });

  test('a bill already cancelled in the other browser is refused in words: "This bill is already cancelled. Nothing was changed."', async ({
    page,
    browser,
  }) => {
    const owner = e2eLogin('owner');
    const release = await holdPolls(page); // this browser does not hear of the cancel
    await openLedger(page, owner);
    await openCard(page, NAMES.lata);
    await openTab(page, 'Invoices');
    await invoiceRow(page, 'W11-0040').getByTestId('cancel-bill').click();
    await page.getByTestId('cancel-reason').fill('wrong bill');

    const other = await secondBrowser(browser, owner);
    try {
      const done = await apiCall(other.page, `/v1/bills/${ids.bills.l1}/cancel`, {
        reason: 'seen first',
      });
      expect(done.status).toBe(200);
    } finally {
      await other.context.close();
    }
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('cancel-error')).toHaveText(
      'This bill is already cancelled. Nothing was changed.',
      { timeout: 30_000 }
    );
    expect(await billOf('W11-0040')).toEqual(['cancelled', 'seen first', '1000.00', '-']);
    release();
  });

  test('JV_INTERNAL: the person reads only "Could not confirm that this was saved."; the code, the status and the request id go to the console and the details of the server go nowhere; the books are read again at once', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const warnings: string[] = [];
    page.on('console', (message) => {
      if (message.type() === 'warning') warnings.push(message.text());
    });
    let failures = 0;
    await page.route(`${apiUrl}/v1/bills/*/cancel`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      failures += 1;
      return route.fulfill({
        status: 500,
        headers: { ...corsHeaders(), 'content-type': 'application/json' },
        body: JSON.stringify({
          error: {
            code: 'JV_INTERNAL',
            message: 'ER_DUP_ENTRY secret-detail at uq_bills_no',
            details: { sql: 'INSERT INTO secret_table' },
          },
          request_id: 'req-detail-0001',
        }),
      });
    });
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.lata);
    // when each call to X5 and each poll left the browser
    const sent: Array<{ what: 'cancel' | 'poll'; at: number }> = [];
    page.on('request', (request) => {
      if (isCancel(request.url(), request.method())) sent.push({ what: 'cancel', at: Date.now() });
      if (isPoll(request.url(), request.method())) sent.push({ what: 'poll', at: Date.now() });
    });
    await cancelBill(page, 'W11-0040', 'wrong bill');
    const error = page.getByTestId('cancel-error');
    await expect(error).toContainText('Could not confirm that this was saved.', {
      timeout: 30_000,
    });
    await expect(error).not.toContainText(/JV_|ER_DUP|secret|req-detail|INSERT/);
    await expect(page.locator('body')).not.toContainText(/ER_DUP|secret-detail|req-detail-0001/);
    expect(failures).toBe(1); // a JV_INTERNAL is not retried by the client
    const logged = warnings.join('\n');
    expect(logged).toContain('JV_INTERNAL');
    expect(logged).toContain('req-detail-0001');
    expect(logged).not.toContain('secret-detail');
    expect(logged).not.toContain('secret_table');
    expect(logged).not.toContain('wrong bill'); // the body of the call is never logged
    // C17: the customer's books are read again at once: a poll leaves within three seconds of the failed call
    const cancelAt = sent.find((s) => s.what === 'cancel')?.at ?? 0;
    expect(cancelAt).toBeGreaterThan(0);
    await expect
      .poll(
        () => sent.some((s) => s.what === 'poll' && s.at >= cancelAt && s.at - cancelAt < 3_000),
        {
          timeout: 5_000,
        }
      )
      .toBe(true);
    expect((await billOf('W11-0040'))[0]).toBe('active'); // and the server really did nothing
  });

  test('JV_BUSY twice (the one automatic retry fails too): "Could not confirm that this was saved."; pressing again gets through with the same key', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = callsTo(page, isCancel);
    let busy = 2;
    await page.route(`${apiUrl}/v1/bills/*/cancel`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (busy > 0) {
        busy -= 1;
        return route.fulfill({
          status: 503,
          headers: { ...corsHeaders(), 'content-type': 'application/json', 'retry-after': '1' },
          body: JSON.stringify({
            error: { code: 'JV_BUSY', message: 'The server is busy.', details: {} },
            request_id: 'req-busy',
          }),
        });
      }
      return route.fallback();
    });
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.lata);
    await cancelBill(page, 'W11-0040', 'wrong bill');
    await expect(page.getByTestId('cancel-error')).toContainText(
      'Could not confirm that this was saved.',
      { timeout: 30_000 }
    );
    expect(requests).toHaveLength(2); // the call and its one automatic retry
    expect((await billOf('W11-0040'))[0]).toBe('active');
    await page.getByTestId('cancel-confirm').click();
    await expect(page.getByTestId('cancel-done')).toBeVisible({ timeout: 30_000 });
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
    expect((await billOf('W11-0040'))[0]).toBe('cancelled');
  });

  test('offline: the confirm button is disabled while the banner shows, and nothing is sent', async ({
    page,
  }) => {
    const { requests } = callsTo(page, isCancel);
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.lata);
    await openTab(page, 'Invoices');
    await invoiceRow(page, 'W11-0040').getByTestId('cancel-bill').click();
    await page.getByTestId('cancel-reason').fill('wrong bill');
    await page.context().setOffline(true);
    try {
      await expect(banner(page)).toHaveText('Offline: changes cannot be saved', {
        timeout: 20_000,
      });
      await expect(page.getByTestId('cancel-confirm')).toBeDisabled();
      expect(requests).toHaveLength(0);
    } finally {
      await page.context().setOffline(false);
    }
    await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(page.getByTestId('cancel-confirm')).toBeEnabled();
  });
});

// ------------------------------------------------------------------------------------------------ PT-W11: void (X4)

test.describe('PT-W11: the owner voids a receipt (X4, Y7, Y10)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('a payment on a bill: voided with a reason, tagged Voided, and the bill owes the money again', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.dev);
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹500');
    await openTab(page, 'Payments');
    await expect(page.getByTestId('payment-row')).toHaveCount(1);
    await page.getByTestId('void-receipt').click();
    await expect(voidDialog(page)).toContainText('stays in the books, tagged Voided');
    await page.getByTestId('void-reason').fill('x');
    await page.getByTestId('void-confirm').click();
    await expect(page.getByTestId('void-error')).toContainText('at least 3 characters');
    await page.getByTestId('void-reason').fill('cheque bounced');
    await page.getByTestId('void-confirm').click();
    await expect(page.getByTestId('void-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('void-bills')).toContainText('W11-0020');
    await expect(page.getByTestId('void-bills')).toContainText('₹1,000 is pending');
    expect(await receiptsOf(NAMES.dev)).toEqual([
      ['money', 'UPI', '500.00', 'voided', 'cheque bounced', '-'],
    ]);
    await page.getByTestId('void-close').click();
    await expect(page.getByTestId('voided-tag')).toBeVisible();
    await expect(page.getByTestId('void-receipt')).toHaveCount(0);
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹1,000');
  });

  test('"void the refund first": a payment whose money was handed back is refused with how much; the refund is voided from the Refunds list; then the payment can be voided', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.gita);
    await expect(tile(page, 'cs-advance')).toHaveText('₹200'); // 500 received - 300 handed back
    await openTab(page, 'Payments');
    await expect(page.getByTestId('refunds-list')).toBeVisible();
    await expect(page.getByTestId('refund-row')).toHaveCount(1);

    // the dialog already says that a refund has to be voided first
    await page.getByTestId('void-receipt').click();
    await expect(voidDialog(page)).toContainText('void that refund first');
    await page.getByTestId('void-reason').fill('entered twice');
    await page.getByTestId('void-confirm').click();
    const refused = page.getByTestId('void-error');
    await expect(refused).toContainText('Void the refund first', { timeout: 30_000 });
    await expect(refused).toContainText('₹300');
    await expect(refused).toContainText('Nothing was changed.');
    await expect(refused).toHaveAttribute('data-unconfirmed', 'false');
    expect((await receiptsOf(NAMES.gita)).map((r) => r[3])).toEqual(['active', 'active']);
    await page.getByRole('button', { name: 'Keep it' }).click();

    // void the refund: the advance is back to 500
    await page.getByTestId('void-refund').click();
    await page.getByTestId('void-reason').fill('refund was a mistake');
    await page.getByTestId('void-confirm').click();
    await expect(page.getByTestId('void-done')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('void-close').click();
    await expect(tile(page, 'cs-advance')).toHaveText('₹500');

    // now the payment can go
    await page.getByTestId('void-receipt').click();
    await page.getByTestId('void-reason').fill('entered twice');
    await page.getByTestId('void-confirm').click();
    await expect(page.getByTestId('void-done')).toBeVisible({ timeout: 30_000 });
    await page.getByTestId('void-close').click();
    await expect(tile(page, 'cs-advance')).toHaveText('₹0');
    expect((await receiptsOf(NAMES.gita)).map((r) => r[3])).toEqual(['voided', 'voided']);
  });
});

// ------------------------------------------------------------------------------------------------ PT-W11: refund (X11)

test.describe('PT-W11: the owner hands money back out of the advance (X11, Y10)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('more than the advance is refused with the figures; then 300 of 500 is handed back, and the card and the Refunds list show it', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.asha);
    await expect(tile(page, 'cs-advance')).toHaveText('₹500');
    await page.getByTestId('open-refund').click();
    await expect(page.getByTestId('refund-books')).toContainText('Advance held ₹500');
    await expect(page.getByTestId('refund-amount')).toHaveValue('500.00');

    await page.getByTestId('refund-amount').fill('0');
    await page.getByTestId('refund-save').click();
    await expect(page.getByTestId('refund-error')).toContainText('more than 0'); // on the screen, before any call

    await page.getByTestId('refund-amount').fill('800');
    await page.getByTestId('refund-save').click();
    const refused = page.getByTestId('refund-error');
    await expect(refused).toContainText('₹500 in advance', { timeout: 30_000 });
    await expect(refused).toContainText('₹300 too much');
    await expect(refused).toContainText('Nothing was changed.');
    expect((await receiptsOf(NAMES.asha)).filter((r) => r[0] === 'refund')).toHaveLength(0);

    await page.getByTestId('refund-amount').fill('300');
    await page.getByTestId('refund-mode').selectOption('UPI');
    await page.getByTestId('refund-reference').fill('UTR-77');
    await page.getByTestId('refund-save').click();
    await expect(page.getByTestId('refund-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('refund-result')).toContainText('₹300 handed back');
    await expect(page.getByTestId('refund-result')).toContainText('still holds ₹200 in advance');
    expect(await receiptsOf(NAMES.asha)).toEqual([
      ['money', 'UPI', '500.00', 'active', '-', '-'],
      ['refund', 'UPI', '300.00', 'active', '-', 'UTR-77'],
    ]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(tile(page, 'cs-advance')).toHaveText('₹200', { timeout: 15_000 });
    await openTab(page, 'Payments');
    await expect(page.getByTestId('refund-row')).toHaveCount(1, { timeout: 15_000 });
  });

  test('a customer who holds no advance has nothing to hand back, and says so before anything is sent', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.ravi);
    await page.getByTestId('open-refund').click();
    await expect(page.getByTestId('refund-books')).toContainText('holds no advance');
    await page.getByTestId('refund-amount').fill('10');
    await page.getByTestId('refund-save').click();
    await expect(page.getByTestId('refund-error')).toContainText('no advance', { timeout: 30_000 });
    await expect(page.getByTestId('refund-error')).toContainText('Nothing was changed.');
    expect(await receiptsOf(NAMES.ravi)).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ PT-W11: opening balance (X12)

test.describe('PT-W11: the owner adds an opening balance (X12, D15, IM5)', () => {
  test.describe.configure({ timeout: 240_000 });

  test('dues and silver due make an opening bill dated as chosen; an advance added afterwards nets off against them', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.ravi);
    await page.getByTestId('open-opening').click();
    await page.getByTestId('opening-save').click();
    await expect(page.getByTestId('opening-error')).toContainText('at least one figure');

    const day = kolkata(3);
    await page.getByTestId('opening-dues').fill('1000');
    await page.getByTestId('opening-fine-due').fill('2.5');
    await page.getByTestId('opening-date').fill(day);
    await page.getByTestId('opening-save').click();
    await expect(page.getByTestId('opening-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('opening-result')).toContainText('OB-');
    await expect(page.getByTestId('opening-result')).toContainText(
      '₹1,000 dues and 2.500 g silver'
    );
    const [bill] = await billsOfCustomer(NAMES.ravi);
    expect(bill.slice(1)).toEqual(['opening_balance', 'active', '1000.00', '2.500', day]);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹1,000', { timeout: 15_000 });
    await expect(tile(page, 'cs-fine')).toHaveText('2.500 g');
    await openTab(page, 'Invoices');
    await expect(
      page.getByTestId('invoice-row').filter({ hasText: 'Opening balance' })
    ).toHaveCount(1);
    // an opening balance can be cancelled but not re-issued
    await expect(page.getByTestId('cancel-bill')).toHaveCount(1);
    await expect(page.getByTestId('reissue-bill')).toHaveCount(0);

    // an advance of 400 nets off against the dues
    await page.getByTestId('open-opening').click();
    await page.getByTestId('opening-advance').fill('400');
    await page.getByTestId('opening-save').click();
    await expect(page.getByTestId('opening-done')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('opening-result')).toContainText('₹400 advance');
    await expect(page.getByTestId('opening-result')).toContainText(
      'Netted off against the dues: ₹400'
    );
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹600', { timeout: 15_000 });
    await expect(tile(page, 'cs-advance')).toHaveText('₹0');
  });

  test('the walk-in customer holds no advance: its form takes dues only', async ({ page }) => {
    const [[walkInName]] = await laneSql(`SELECT name FROM customers WHERE is_walkin = 1`);
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, walkInName);
    await page.getByTestId('open-opening').click();
    await expect(page.getByTestId('opening-panel')).toContainText('holds no advance');
    await expect(page.getByTestId('opening-advance')).toBeDisabled();
    await expect(page.getByTestId('opening-fine-advance')).toBeDisabled();
    await expect(page.getByTestId('opening-dues')).toBeEnabled();
  });
});

// ------------------------------------------------------------------------------------------------ PT-W11: re-issue (X10)

test.describe('PT-W11: the owner re-issues a bill (X10, K6)', () => {
  test.describe.configure({ timeout: 300_000 });

  test('the billing screen starts from the old bill with the customer locked; the corrected bill replaces it, the money received moves to it, and the old bill says who replaced it', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('owner'));
    await openCard(page, NAMES.sita);
    await expect(tile(page, 'cs-outstanding')).toHaveText('₹2,220'); // 7,220 - 5,000
    await openTab(page, 'Invoices');
    await invoiceRow(page, 'W11-0030').getByTestId('reissue-bill').click();

    // the billing screen in re-issue mode
    await expect(page.getByRole('heading', { name: 'Re-issue W11-0030' })).toBeVisible();
    await expect(page.getByTestId('reissue-customer')).toContainText(NAMES.sita);
    await expect(page.getByTestId('reissue-customer')).toContainText('cannot change');
    await expect(page.getByRole('button', { name: 'Change' })).toHaveCount(0);
    await expect(page.getByPlaceholder('Search by mobile or name...')).toHaveCount(0);
    await expect(page.locator('tr[data-sku="W11-S2"]')).toBeVisible();
    await expect(page.getByLabel('Metal rate W11-S2')).toHaveValue('6920.00');
    await expect(page.getByLabel('Labour rate W11-S2')).toHaveValue('300.00');
    await expect(page.getByTestId('grand-total')).toHaveText('₹7,220');

    // a reason is needed; the screen says so before any call
    const reissueCalls = callsTo(
      page,
      (url, method) => method === 'POST' && url.endsWith('/reissue')
    );
    await page.getByLabel('Labour rate W11-S2').fill('400');
    await expect(page.getByTestId('grand-total')).toHaveText('₹7,320');
    await page.getByTestId('save-bill').click();
    await expect(page.getByTestId('bill-save-error')).toContainText('at least 3 characters');
    expect(reissueCalls.requests).toHaveLength(0);

    await page.getByTestId('reissue-reason').fill('labour was entered wrongly');
    await page.getByTestId('save-bill').click();
    await expect(page.getByTestId('bill-saved')).toBeVisible({ timeout: 60_000 });
    expect(reissueCalls.requests).toHaveLength(1);
    expect(reissueCalls.requests[0].headers()['idempotency-key']).toMatch(KEY);
    const body = reissueCalls.requests[0].postDataJSON() as Record<string, unknown>;
    expect(body.reason).toBe('labour was entered wrongly');
    expect(body).not.toHaveProperty('customer_id'); // the customer cannot change
    const newNo = (await page.getByTestId('saved-bill-no').textContent()) ?? '';
    expect(newNo).not.toBe('');
    await expect(page.getByTestId('reissue-saved')).toContainText('W11-0030 is cancelled');
    await expect(page.getByTestId('grand-total')).toHaveText('₹7,320');
    // the money already received moved to the new bill: 5,000 carried, 2,320 to pay
    await expect(page.getByTestId('advance-adjusted')).toContainText('₹5,000');
    await expect(page.getByTestId('pending')).toHaveText('₹2,320');

    // the books
    expect(await billOf('W11-0030')).toEqual([
      'cancelled',
      'labour was entered wrongly',
      '7220.00',
      '-',
    ]);
    expect(await billOf(newNo)).toEqual(['active', '-', '7320.00', 'W11-0030']);
    expect(await allocationsOf(NAMES.sita)).toEqual([
      [newNo, '5000.00', 'live'],
      ['W11-0030', '5000.00', 'released'],
    ]);
    expect(await pieceStatus('W11-S2')).toBe('Sold');
    expect(
      (
        await laneSql(
          `SELECT b.bill_no FROM skus s JOIN bills b ON b.id = s.sold_bill_id WHERE s.sku_no = 'W11-S2'`
        )
      )[0][0]
    ).toBe(newNo);

    // the old estimate says who replaced it; the new one says whom it replaces
    await page.getByRole('link', { name: 'View Estimate' }).click();
    await expect(page.getByTestId('estimate-reissue-of')).toContainText('W11-0030');
    await page.goto(`/estimate?id=${ids.bills.s1}`);
    await expect(page.getByTestId('estimate-cancelled')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('estimate-reissued-as')).toContainText(newNo);
    await expect(page.getByTestId('estimate-cancel-reason')).toContainText(
      'labour was entered wrongly'
    );
    // a bill can be re-issued once: asking again gives a sentence, not a form
    await page.goto(`/billing-pos?reissue=${ids.bills.s1}`);
    await expect(page.getByTestId('reissue-refused')).toContainText(
      'already cancelled and re-issued',
      {
        timeout: 60_000,
      }
    );
    await expect(page.getByTestId('save-bill')).toHaveCount(0);
  });

  test('a piece sold on another bill still cannot be put on the corrected bill; a piece of the old bill can be scanned again; Discard goes back to the estimate', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), `/billing-pos?reissue=${ids.bills.p1}`);
    await expect(page.getByRole('heading', { name: 'Re-issue W11-0001' })).toBeVisible({
      timeout: 60_000,
    });
    // remove the line, then scan its piece again: it is Sold, but the old bill sold it, so the cancel frees it
    await page.getByLabel('Remove W11-S1').click();
    await expect(page.locator('tr[data-sku="W11-S1"]')).toHaveCount(0);
    await page.getByPlaceholder('Enter SKU number or scan barcode...').fill('W11-S1');
    await page.keyboard.press('Enter');
    await expect(page.locator('tr[data-sku="W11-S1"]')).toBeVisible();
    // a piece that is Sold on another bill is refused as on any bill
    await page.getByPlaceholder('Enter SKU number or scan barcode...').fill('W11-S2');
    await page.keyboard.press('Enter');
    await expect(page.getByText('already sold')).toBeVisible();
    await expect(page.locator('tr[data-sku="W11-S2"]')).toHaveCount(0);
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(page).toHaveURL(new RegExp(`/estimate\\?id=${ids.bills.p1}`));
    expect((await billOf('W11-0001'))[0]).toBe('active'); // nothing was changed
  });
});

// ------------------------------------------------------------------------------------------------ PT-W11: a biller sees none

test.describe("PT-W11: a biller sees none of these actions, and the API refuses the biller's own call (A4)", () => {
  test.describe.configure({ timeout: 240_000 });

  test('the card has Receive Payment and nothing else; the lists and the estimate have no button; the re-issue address gives a sentence; a call made by hand is 403', async ({
    page,
  }) => {
    await openLedger(page, e2eLogin('biller'));
    await openCard(page, NAMES.sita);
    await expect(page.getByRole('button', { name: 'Receive Payment', exact: true })).toBeVisible();
    await expect(page.getByTestId('open-refund')).toHaveCount(0);
    await expect(page.getByTestId('open-opening')).toHaveCount(0);

    await openTab(page, 'Invoices');
    await expect(page.getByTestId('invoice-row')).toHaveCount(1);
    await expect(page.getByTestId('cancel-bill')).toHaveCount(0);
    await expect(page.getByTestId('reissue-bill')).toHaveCount(0);

    await openTab(page, 'Payments');
    await expect(page.getByTestId('payment-row')).toHaveCount(1);
    await expect(page.getByTestId('void-receipt')).toHaveCount(0);

    await invoiceTabLinkToEstimate(page);
    await expect(page.getByTestId('estimate-number')).toContainText('W11-0030');
    await expect(page.getByTestId('cancel-bill')).toHaveCount(0);
    await expect(page.getByTestId('reissue-bill')).toHaveCount(0);

    // the address of a re-issue is not a way in
    await page.goto(`/billing-pos?reissue=${ids.bills.s1}`);
    await expect(page.getByTestId('reissue-refused')).toContainText('Only the owner can re-issue', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('save-bill')).toHaveCount(0);

    // and the wall is the API: the biller's own calls are refused and change nothing
    const cancel = await apiCall(page, `/v1/bills/${ids.bills.s1}/cancel`, { reason: 'trying it' });
    expect(cancel.status).toBe(403);
    expect(cancel.body?.error?.code).toBe('JV_FORBIDDEN');
    const voided = await apiCall(page, `/v1/receipts/${ids.receipts.s1}/void`, {
      reason: 'trying it',
    });
    expect(voided.status).toBe(403);
    const refund = await apiCall(page, `/v1/customers/${ids.customers.asha}/refunds`, {
      amount: '10.00',
      mode: 'Cash',
    });
    expect(refund.status).toBe(403);
    const opening = await apiCall(page, `/v1/customers/${ids.customers.ravi}/opening-balance`, {
      dues: '10.00',
      as_of: kolkata(),
    });
    expect(opening.status).toBe(403);
    expect((await billOf('W11-0030'))[0]).toBe('active');
    expect((await receiptsOf(NAMES.sita))[0][3]).toBe('active');
    expect(await receiptsOf(NAMES.ravi)).toEqual([]);
  });
});

/** From the Invoices tab of the open card to the estimate of its first bill. */
async function invoiceTabLinkToEstimate(page: Page) {
  await openTab(page, 'Invoices');
  await page.getByTestId('invoice-row').first().getByRole('link', { name: 'View' }).click();
}
