import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { noteApiCall, roomInTheMinute } from './pacing';

// WEB09 (PT-W9): the payment and silver-fine panel of the customer ledger on record_payment (X2) and settle_fine (X3), in a real browser against the real API of a lane
// (spec C5 (b), C6, C7, C13, C17, L5, Y3, Y5, SF1, SF2, Z1, Z2, K5, O52).
//   PT-W9   receive 600 on a bill of 1,000 (named); an unnamed payment goes oldest first and the remainder is shown as an advance; the cash limit message for a biller at 2,00,000;
//           silver fine settled in silver and in cash at a rate
//   T-E02   (clause) after a payment the other browser's pending and balance change
//   T-E07   (clause) a payment moves the pending of a bill on the other browser
//   C17     after the write the screen reads the customer's books at once (a poll starts within the second, before the next timed poll)
//   T-E06   (clause) a double click on Record makes one receipt; a dropped answer then Save again sends the SAME key and the server replays; a changed payment is another action
//   T-E03   (clause) a gateway error then a normal reply shows "Waking up…" and a money call retried meanwhile with the same key saves once; offline disables Save
//   and the messages: JV_CASH_LIMIT (biller, owner with a reason, walk-in), the walk-in rules (K5: the bill is named, no more than its pending / its fine), JV_FINE_EXCEEDS with the maximum
//
// The bills are written as root in the lane's container (the billing screen that makes them is WEB08's and is proved in billing.spec.ts); the receipts and allocations are made by
// the API through the panel. Everything the tests made is taken out again (the volume case of hydrate.spec.ts needs an empty lane).
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/payments.spec.ts

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

const WALK_IN = '00000000-0000-4000-8000-000000000001';
const ids = {
  priya: randomUUID(),
  silver: randomUUID(),
  cash: randomUUID(),
  bills: {
    p1: randomUUID(), // W09-0001  700.00, the older bill of Priya
    p2: randomUUID(), // W09-0002 1,000.00, the newer one
    s1: randomUUID(), // W09-0201 2,500.00 and 25.000 g of silver, the older bill of the silver customer
    s2: randomUUID(), // W09-0202 1,000.00 and 5.000 g of silver
    c1: randomUUID(), // W09-0301 1,000.00
    w1: randomUUID(), // W09-0100 500.00, the walk-in
    w2: randomUUID(), // W09-0101 100.00 and 5.000 g of silver, the walk-in
    w3: randomUUID(), // W09-0102 2,50,000.00, the walk-in
  },
};
const NAMES = { priya: 'W09 Priya', silver: 'W09 Silver', cash: 'W09 Cash' };

function fixtureSql(): string {
  const bill = (
    id: string,
    number: string,
    customer: string,
    daysAgo: number,
    money: string,
    type: string,
    fine = '0.000'
  ) =>
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total, fine_weight_due) VALUES ` +
    `('${id}', '${number}', '${customer}', CURDATE() - INTERVAL ${daysAgo} DAY, '${type}', ${money}, ${money}, ${fine});`;
  const customer = (id: string, name: string, type: string, mobile: string) =>
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${id}', '${name}', '${mobile}', '${type}');`;
  return [
    customer(ids.priya, NAMES.priya, 'Retail', '9000090001'),
    customer(ids.silver, NAMES.silver, 'Wholesale', '9000090002'),
    customer(ids.cash, NAMES.cash, 'Retail', '9000090003'),
    bill(ids.bills.p1, 'W09-0001', ids.priya, 2, '700.00', 'Retail'),
    bill(ids.bills.p2, 'W09-0002', ids.priya, 1, '1000.00', 'Retail'),
    bill(ids.bills.s1, 'W09-0201', ids.silver, 1, '2500.00', 'Wholesale', '25.000'),
    bill(ids.bills.s2, 'W09-0202', ids.silver, 0, '1000.00', 'Wholesale', '5.000'),
    bill(ids.bills.c1, 'W09-0301', ids.cash, 0, '1000.00', 'Retail'),
    bill(ids.bills.w1, 'W09-0100', WALK_IN, 0, '500.00', 'Retail'),
    bill(ids.bills.w2, 'W09-0101', WALK_IN, 0, '100.00', 'Wholesale', '5.000'),
    bill(ids.bills.w3, 'W09-0102', WALK_IN, 0, '250000.00', 'Retail'),
  ].join(' ');
}

/** Everything these tests made, gone again. The delete order follows the foreign keys. Receipts reach the walk-in only through their allocations to its W09 bills. */
async function cleanLane() {
  const bills = (await laneSql(`SELECT id FROM bills WHERE bill_no LIKE 'W09-%'`)).map(
    (r) => `'${r[0]}'`
  );
  const billList = bills.length > 0 ? bills.join(', ') : "''";
  const receipts = (
    await laneSql(
      `SELECT DISTINCT receipt_id FROM receipt_allocations WHERE bill_id IN (${billList}) ` +
        `UNION SELECT id FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W09 %')`
    )
  ).map((r) => `'${r[0]}'`);
  const receiptList = receipts.length > 0 ? receipts.join(', ') : "''";
  await laneSql(
    `DELETE FROM receipt_allocations WHERE bill_id IN (${billList}) OR receipt_id IN (${receiptList}); ` +
      `DELETE FROM receipts WHERE id IN (${receiptList}); ` +
      `DELETE FROM bills WHERE id IN (${billList}); ` +
      `DELETE FROM customers WHERE name LIKE 'W09 %';`
  );
}

/** The receipts of a customer by name, oldest first: kind, mode, amount, fine grams, silver rate, the owner's reason. */
const receiptsOf = (name: string) =>
  laneSql(
    `SELECT r.kind, IFNULL(r.mode, '-'), r.amount, r.fine_grams, IFNULL(r.silver_rate, '-'), IFNULL(r.cash_override_reason, '-') ` +
      `FROM receipts r JOIN customers c ON c.id = r.customer_id WHERE c.name = '${name}' AND r.status = 'active' ORDER BY r.created_at, r.id`
  );

/** The allocations to the bills `W09-<prefix>%`: bill number, money, fine grams. The allocations of one call carry one stamp, so a tie is broken by the bill number (the older bill has the lower one), never by the random id. */
const allocationsOf = (prefix: string) =>
  laneSql(
    `SELECT b.bill_no, a.amount, a.fine_grams FROM receipt_allocations a JOIN bills b ON b.id = a.bill_id ` +
      `WHERE b.bill_no LIKE 'W09-${prefix}%' AND a.released_at IS NULL ORDER BY a.created_at, b.bill_no`
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
const PROXY_PAGE = '<html><body><h1>502 Bad Gateway</h1></body></html>';

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

/** The text of a figure tile of the customer card ("Outstanding", "Silver Fine Due"). */
const tile = (page: Page, label: string) =>
  page.locator('p', { hasText: new RegExp(`^${label}$`) }).locator('xpath=following-sibling::p');

const typeSelect = (page: Page) => page.getByTestId('payment-type');
const amount = (page: Page) => page.getByTestId('payment-amount');
const mode = (page: Page) => page.getByTestId('payment-mode');
const bill = (page: Page) => page.getByTestId('payment-bill');
const grams = (page: Page) => page.getByTestId('fine-grams');
const rate = (page: Page) => page.getByTestId('fine-rate');
const reason = (page: Page) => page.getByTestId('cash-reason');
const save = (page: Page) => page.getByTestId('save-payment');
const failed = (page: Page) => page.getByTestId('payment-error');
const paymentSaved = (page: Page) => page.getByTestId('payment-saved');
const fineSaved = (page: Page) => page.getByTestId('fine-saved');
const banner = (page: Page) => page.getByTestId('connection-banner');

/** The calls the page makes to X2 and X3 of a customer, and the answers. */
function moneyCalls(page: Page, customerId: string) {
  const { apiUrl } = e2eLane();
  const requests: Request[] = [];
  const responses: Response[] = [];
  const isMine = (url: string) =>
    url === `${apiUrl}/v1/customers/${customerId}/payments` ||
    url === `${apiUrl}/v1/customers/${customerId}/fine-settlements`;
  page.on('request', (request) => {
    if (request.method() === 'POST' && isMine(request.url())) requests.push(request);
  });
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && isMine(response.url())) responses.push(response);
  });
  return { requests, responses };
}

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute
// and starts from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterEach(async () => {
  await cleanLane();
});

// ------------------------------------------------------------------------------------------------ PT-W9: an amount

test.describe('PT-W9, T-E02, T-E07 (clauses): receive a payment', () => {
  test.describe.configure({ timeout: 150_000 });

  test("600 on a named bill of 1,000: the result names the bill, and the OTHER browser's pending and balance change within 10 seconds", async ({
    page,
    browser,
  }) => {
    const { apiUrl } = e2eLane();
    const other = await browser.newContext();
    try {
      const second = await other.newPage();
      second.on('request', (request) => {
        if (request.url().startsWith(apiUrl)) noteApiCall();
      });
      await open(page, e2eLogin('owner'));
      await open(second, e2eLogin('biller'));
      await openCard(second, NAMES.priya);
      await second.getByRole('button', { name: 'Invoices' }).click();
      await expect(tile(second, 'Outstanding')).toHaveText('₹1,700');
      const pending2 = second
        .getByRole('row', { name: /W09-0002/ })
        .locator('td')
        .nth(5);
      await expect(pending2).toHaveText('₹1,000'); // the pending of the bill, before

      const { requests } = moneyCalls(page, ids.priya);
      await openCard(page, NAMES.priya);
      await openPanel(page, NAMES.priya);
      await bill(page).selectOption(ids.bills.p2); // the newer bill: a named bill goes first, not the oldest
      await amount(page).fill('600');
      await mode(page).selectOption('UPI');
      await save(page).click();

      await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
      const savedAt = Date.now();
      // each part: the bill and its money, from the rows the API returned
      const parts = page.getByTestId('payment-part');
      await expect(parts).toHaveCount(1);
      await expect(parts.first()).toContainText('W09-0002');
      await expect(parts.first()).toContainText('₹600.00');
      await expect(page.getByTestId('payment-advance')).toHaveCount(0); // nothing kept as advance
      expect(requests).toHaveLength(1);
      expect(requests[0].url()).toBe(`${apiUrl}/v1/customers/${ids.priya}/payments`);
      expect(requests[0].headers()['idempotency-key']).toMatch(KEY);
      expect(requests[0].postDataJSON()).toEqual({
        amount: '600.00',
        mode: 'UPI',
        bill_id: ids.bills.p2,
      });
      await expect(page.getByTestId('payment-remaining')).toContainText('₹1,100.00', {
        timeout: 10_000,
      });

      expect(await receiptsOf(NAMES.priya)).toEqual([
        ['money', 'UPI', '600.00', '0.000', '-', '-'],
      ]);
      expect(await allocationsOf('0')).toEqual([['W09-0002', '600.00', '0.000']]);

      // the other browser: the customer's balance and the bill's pending, within 10 seconds of the payment
      await expect(tile(second, 'Outstanding')).toHaveText('₹1,100', { timeout: 10_000 });
      await expect(pending2).toHaveText('₹400', { timeout: 10_000 });
      expect(Date.now() - savedAt).toBeLessThan(15_000);
    } finally {
      await other.close();
    }
  });

  test('an unnamed payment of 2,000 goes oldest first and the remainder is shown as an advance', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await expect(bill(page)).toHaveValue(''); // "apply to oldest outstanding" is the default
    await amount(page).fill('2000');
    await save(page).click();
    await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
    const parts = page.getByTestId('payment-part');
    await expect(parts).toHaveCount(2);
    await expect(parts.nth(0)).toContainText('W09-0001'); // the older bill first
    await expect(parts.nth(0)).toContainText('₹700.00');
    await expect(parts.nth(1)).toContainText('W09-0002');
    await expect(parts.nth(1)).toContainText('₹1,000.00');
    await expect(page.getByTestId('payment-advance')).toContainText('₹300.00');
    expect(await allocationsOf('0')).toEqual([
      ['W09-0001', '700.00', '0.000'],
      ['W09-0002', '1000.00', '0.000'],
    ]);
    expect(await receiptsOf(NAMES.priya)).toEqual([['money', 'UPI', '2000.00', '0.000', '-', '-']]);
    // the books of the customer, read again at once: nothing outstanding, 300 held as advance
    await expect(page.getByTestId('payment-remaining')).toContainText('₹0.00', { timeout: 10_000 });
    await expect(page.getByTestId('payment-books-advance')).toContainText('₹300.00', {
      timeout: 10_000,
    });
  });

  test('the mode list has the five modes and no Credit', async ({ page }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    const options = await mode(page).locator('option').allTextContents();
    expect(options).toEqual(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']);
  });

  test('C17: the books are read at once after the write, not at the next timed poll', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const polls: number[] = [];
    let lastPollDone = 0;
    const isPoll = (url: string, method: string) =>
      method === 'POST' && url === `${apiUrl}/v1/sync/poll`;
    page.on('request', (request) => {
      if (isPoll(request.url(), request.method())) polls.push(Date.now());
    });
    page.on('response', (response) => {
      if (isPoll(response.url(), response.request().method())) lastPollDone = Date.now();
    });
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('300');
    // wait for a timed poll to have just run, so that the next timed one is 8 seconds away, and press Record at once
    const mark = Date.now();
    await expect.poll(() => lastPollDone, { timeout: 20_000 }).toBeGreaterThan(mark);
    const answered = page.waitForResponse(
      (response) =>
        response.url() === `${apiUrl}/v1/customers/${ids.priya}/payments` &&
        response.request().method() === 'POST'
    );
    await save(page).click();
    await answered;
    const x2At = Date.now();
    await expect(page.getByTestId('payment-remaining')).toContainText('₹1,400.00', {
      timeout: 6_000,
    });
    const shownAfter = Date.now() - x2At;
    const pollAfter = polls.filter((at) => at >= x2At - 200);
    expect(pollAfter.length).toBeGreaterThan(0);
    expect(pollAfter[0] - x2At, 'a poll starts within 2 seconds of the answer').toBeLessThan(2_000);
    expect(shownAfter, 'the new figure is on screen well before the next timed poll').toBeLessThan(
      6_000
    );
  });
});

// ------------------------------------------------------------------------------------------------ PT-W9: the cash limit

test.describe('Z1, Z2, T-B23 (screen half): cash at the limit', () => {
  test.describe.configure({ timeout: 150_000 });

  test('a biller at 2,00,000 in cash: "The owner enters this payment", nothing is saved, and the screen has no way round it', async ({
    page,
  }) => {
    const { requests } = moneyCalls(page, ids.cash);
    await open(page, e2eLogin('biller'));
    await openCard(page, NAMES.cash);
    await openPanel(page, NAMES.cash);
    await amount(page).fill('200000');
    await mode(page).selectOption('Cash');
    await save(page).click();
    await expect(failed(page)).toContainText('The owner enters this payment', { timeout: 30_000 });
    await expect(failed(page)).toContainText('₹2,00,000');
    await expect(failed(page)).toContainText('Nothing was changed');
    await expect(reason(page)).toHaveCount(0); // a biller cannot give a reason
    await expect(paymentSaved(page)).toHaveCount(0);
    expect(requests).toHaveLength(1);
    expect(await receiptsOf(NAMES.cash)).toEqual([]);
    // below the limit the same screen takes the payment
    await amount(page).fill('199999');
    await save(page).click();
    await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
    expect(await receiptsOf(NAMES.cash)).toEqual([
      ['money', 'Cash', '199999.00', '0.000', '-', '-'],
    ]);
  });

  test('the owner at 2,00,000 in cash: a field for a reason of 10 characters appears, a short one is refused before any call, and the reason is saved on the receipt', async ({
    page,
  }) => {
    const { requests } = moneyCalls(page, ids.cash);
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.cash);
    await openPanel(page, NAMES.cash);
    await amount(page).fill('200000');
    await mode(page).selectOption('Cash');
    await expect(reason(page)).toHaveCount(0);
    await save(page).click();
    await expect(failed(page)).toContainText('reason of at least 10 characters', {
      timeout: 30_000,
    });
    await expect(failed(page)).not.toContainText('The owner enters this payment');
    await expect(reason(page)).toBeVisible();
    expect(requests).toHaveLength(1);
    expect(await receiptsOf(NAMES.cash)).toEqual([]);

    await reason(page).fill('too short');
    await save(page).click();
    await expect(failed(page)).toContainText('10 to 500 characters');
    expect(requests).toHaveLength(1); // refused on the screen, nothing sent

    await reason(page).fill('Wedding order, the family paid in cash');
    await save(page).click();
    await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
    expect(requests).toHaveLength(2);
    expect(requests[1].postDataJSON()).toMatchObject({
      amount: '200000.00',
      mode: 'Cash',
      cash_override_reason: 'Wedding order, the family paid in cash',
    });
    // another action: a key of its own
    expect(requests[1].headers()['idempotency-key']).not.toBe(
      requests[0].headers()['idempotency-key']
    );
    expect(await receiptsOf(NAMES.cash)).toEqual([
      ['money', 'Cash', '200000.00', '0.000', '-', 'Wedding order, the family paid in cash'],
    ]);
    // 1,000 went to the bill, the rest is the advance
    await expect(page.getByTestId('payment-advance')).toContainText('₹1,99,000.00');
  });

  test('the walk-in at the limit: "Select or create the customer", for the owner too', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, 'Walk-in Customer');
    await openPanel(page, 'Walk-in Customer');
    await bill(page).selectOption(ids.bills.w3);
    await amount(page).fill('200000');
    await mode(page).selectOption('Cash');
    await save(page).click();
    await expect(failed(page)).toContainText('Select or create the customer', { timeout: 30_000 });
    await expect(failed(page)).toContainText('Nothing was changed');
    await expect(reason(page)).toHaveCount(0);
    expect(await allocationsOf('0102')).toEqual([]);
  });
});

// ------------------------------------------------------------------------------------------------ K5: the walk-in

test.describe('K5, O52 (screen half): the walk-in names its bill', () => {
  test.describe.configure({ timeout: 150_000 });

  test("a payment: refused without the bill, refused above that bill's pending (with the figure), taken for exactly the pending", async ({
    page,
  }) => {
    await open(page, e2eLogin('biller'));
    await openCard(page, 'Walk-in Customer');
    await openPanel(page, 'Walk-in Customer');
    await amount(page).fill('100');
    await save(page).click();
    await expect(failed(page)).toContainText('must name the bill', { timeout: 30_000 });
    await expect(failed(page)).toContainText('Nothing was changed');

    await bill(page).selectOption(ids.bills.w1);
    await amount(page).fill('600');
    await save(page).click();
    await expect(failed(page)).toContainText('₹500.00', { timeout: 30_000 });
    await expect(failed(page)).toContainText('Nothing was changed');
    expect(await allocationsOf('0100')).toEqual([]);

    await amount(page).fill('500');
    await save(page).click();
    await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
    expect(await allocationsOf('0100')).toEqual([['W09-0100', '500.00', '0.000']]);
    await expect(page.getByTestId('payment-advance')).toHaveCount(0); // the walk-in never holds an advance
  });

  test("a silver settlement: refused without the bill, refused above that bill's fine (with the maximum), taken up to it", async ({
    page,
  }) => {
    await open(page, e2eLogin('biller'));
    await openCard(page, 'Walk-in Customer');
    await openPanel(page, 'Walk-in Customer');
    await typeSelect(page).selectOption('Fine Silver');
    await grams(page).fill('1');
    await save(page).click();
    await expect(failed(page)).toContainText('must name the bill', { timeout: 30_000 });

    await bill(page).selectOption(ids.bills.w2);
    await grams(page).fill('6');
    await save(page).click();
    await expect(failed(page)).toContainText('5.000 g', { timeout: 30_000 });
    await expect(failed(page)).toContainText('Nothing was changed');

    await grams(page).fill('5');
    await save(page).click();
    await expect(fineSaved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fine-remaining')).toContainText('0.000 g');
    expect(await allocationsOf('0101')).toEqual([['W09-0101', '0.00', '5.000']]);
  });
});

// ------------------------------------------------------------------------------------------------ PT-W9: silver fine

test.describe('PT-W9, T-B11, T-B12 (screen half): settle the silver fine', () => {
  test.describe.configure({ timeout: 150_000 });

  test('10 g in silver, then 5 g in cash at a rate: each part, the cash equivalent, and the fine remaining of the API', async ({
    page,
  }) => {
    const { requests } = moneyCalls(page, ids.silver);
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.silver);
    await expect(tile(page, 'Silver Fine Due')).toHaveText('30.000 g');
    await openPanel(page, NAMES.silver);
    await typeSelect(page).selectOption('Fine Silver');
    await grams(page).fill('10');
    await save(page).click();
    await expect(fineSaved(page)).toBeVisible({ timeout: 30_000 });
    expect(requests[0].url()).toBe(
      `${e2eLane().apiUrl}/v1/customers/${ids.silver}/fine-settlements`
    );
    expect(requests[0].postDataJSON()).toEqual({ grams: '10.000', mode: 'Silver' });
    await expect(page.getByTestId('fine-part')).toHaveCount(1);
    await expect(page.getByTestId('fine-part').first()).toContainText('W09-0201'); // oldest first
    await expect(page.getByTestId('fine-part').first()).toContainText('10.000 g');
    await expect(page.getByTestId('fine-remaining')).toContainText('20.000 g');
    expect(await receiptsOf(NAMES.silver)).toEqual([
      ['fine_silver', '-', '0.00', '10.000', '-', '-'],
    ]);

    // the person closes the panel and settles 5 g in cash at 80 a gram
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await openPanel(page, NAMES.silver);
    await typeSelect(page).selectOption('Fine Cash');
    await grams(page).fill('5');
    await rate(page).fill('80');
    await expect(page.getByTestId('fine-cash-equivalent')).toContainText('₹400.00');
    await save(page).click();
    await expect(fineSaved(page)).toBeVisible({ timeout: 30_000 });
    expect(requests[1].postDataJSON()).toEqual({
      grams: '5.000',
      mode: 'Cash',
      silver_rate: '80.00',
    });
    await expect(page.getByTestId('fine-cash')).toContainText('₹400.00');
    await expect(page.getByTestId('fine-remaining')).toContainText('15.000 g');
    expect(await receiptsOf(NAMES.silver)).toEqual([
      ['fine_silver', '-', '0.00', '10.000', '-', '-'],
      ['fine_cash', 'Cash', '400.00', '5.000', '80.00', '-'],
    ]);
    expect(await allocationsOf('02')).toEqual([
      ['W09-0201', '0.00', '10.000'],
      ['W09-0201', '0.00', '5.000'],
    ]);
    // a fine settled in cash is money received but does not reduce the rupees owed (T-B12); the silver still owed is the API's figure
    await expect(tile(page, 'Outstanding')).toHaveText('₹3,500', { timeout: 10_000 });
    await expect(tile(page, 'Silver Fine Due')).toHaveText('15.000 g', { timeout: 10_000 });
  });

  test('more than is owed: the message names the maximum, nothing is saved; lowering the grams saves', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.silver);
    await openPanel(page, NAMES.silver);
    await typeSelect(page).selectOption('Fine Silver');
    await grams(page).fill('31');
    await save(page).click();
    await expect(failed(page)).toContainText('30.000 g', { timeout: 30_000 });
    await expect(failed(page)).toContainText('Nothing was changed');
    expect(await receiptsOf(NAMES.silver)).toEqual([]);
    await grams(page).fill('30');
    await save(page).click();
    await expect(fineSaved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('fine-remaining')).toContainText('0.000 g');
  });

  test('a named bill is settled first: 3 g on the newer bill, not the oldest', async ({ page }) => {
    await open(page, e2eLogin('biller'));
    await openCard(page, NAMES.silver);
    await openPanel(page, NAMES.silver);
    await typeSelect(page).selectOption('Fine Silver');
    await bill(page).selectOption(ids.bills.s2);
    await grams(page).fill('3');
    await save(page).click();
    await expect(fineSaved(page)).toBeVisible({ timeout: 30_000 });
    expect(await allocationsOf('02')).toEqual([['W09-0202', '0.00', '3.000']]);
  });

  test('a cash settlement without a rate is refused on the screen; the rate is what the person typed', async ({
    page,
  }) => {
    const { requests } = moneyCalls(page, ids.silver);
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.silver);
    await openPanel(page, NAMES.silver);
    await typeSelect(page).selectOption('Fine Cash');
    await grams(page).fill('2');
    await save(page).click();
    await expect(failed(page)).toContainText('silver rate');
    expect(requests).toHaveLength(0);
    await rate(page).fill('0');
    await save(page).click();
    await expect(failed(page)).toContainText('more than 0');
    expect(requests).toHaveLength(0);
  });
});

// ------------------------------------------------------------------------------------------------ T-E06 and T-E03

test.describe('T-E06, T-E03 (clauses; C5 (b), C6, C7, L5): one payment for one user action', () => {
  test.describe.configure({ timeout: 150_000 });

  test('a double click on Record makes ONE receipt, from one request with one key; the payment shows as recorded only after the API has answered', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = moneyCalls(page, ids.priya);
    await page.route(`${apiUrl}/v1/customers/${ids.priya}/payments`, async (route) => {
      if (route.request().method() === 'POST') await sleep(1500);
      await route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('600');
    await save(page).dblclick();
    await expect(save(page)).toContainText('Recording');
    await expect(save(page)).toBeDisabled(); // C6
    await expect(paymentSaved(page)).toHaveCount(0); // never optimistic
    await expect(paymentSaved(page)).toBeVisible({ timeout: 20_000 });
    await sleep(1500);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers()['idempotency-key']).toMatch(KEY);
    expect(await receiptsOf(NAMES.priya)).toHaveLength(1);
  });

  test('a second press that gets past the disabled button (changed by hand in the page) is still ONE request: the panel ignores it, and the client would join it', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = moneyCalls(page, ids.priya);
    await page.route(`${apiUrl}/v1/customers/${ids.priya}/payments`, async (route) => {
      if (route.request().method() === 'POST') await sleep(1500);
      await route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('600');
    await save(page).click();
    await expect(save(page)).toBeDisabled();
    // the browser's own protection is taken away, as a script, a held key or a slow render could: two more presses reach the panel's handler while the call is on its way
    await page.evaluate(() => {
      const button = document.querySelector('[data-testid="save-payment"]') as HTMLButtonElement;
      button.removeAttribute('disabled');
      button.click();
      button.click();
    });
    await expect(paymentSaved(page)).toBeVisible({ timeout: 20_000 });
    await sleep(1500);
    expect(requests).toHaveLength(1);
    expect(await receiptsOf(NAMES.priya)).toHaveLength(1);
  });

  test('the answer is lost after the server saved: Save again sends the SAME key, the server replays, and there is still ONE receipt', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests, responses } = moneyCalls(page, ids.priya);
    let dropped = false;
    await page.route(`${apiUrl}/v1/customers/${ids.priya}/payments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (!dropped) {
        dropped = true;
        await route.fetch(); // the server gets it, saves it and answers ...
        return route.abort('connectionreset'); // ... and the answer never reaches the page
      }
      return route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('600');
    await save(page).click();
    await expect(failed(page)).toContainText('Could not confirm that this was saved', {
      timeout: 30_000,
    });
    await expect(failed(page)).toContainText('Press Save again');
    await expect(paymentSaved(page)).toHaveCount(0); // the screen does not know, and does not say so
    expect(await receiptsOf(NAMES.priya)).toHaveLength(1); // it was saved; the screen did not know
    // the books are read at once, so the customer's outstanding already shows the payment
    await expect(page.getByTestId('payment-books')).toContainText('₹1,100.00', { timeout: 10_000 });

    await expect(save(page)).toBeEnabled();
    await save(page).click(); // the same action again
    await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(keys.length).toBeGreaterThanOrEqual(2);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(KEY);
    const last = responses[responses.length - 1];
    expect(last.status()).toBe(201);
    expect(last.headers()['idempotent-replay']).toBe('true');
    expect(await receiptsOf(NAMES.priya)).toHaveLength(1);
  });

  test('a payment that was changed after a lost answer is another action: it gets a key of its own', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = moneyCalls(page, ids.priya);
    let dropped = false;
    await page.route(`${apiUrl}/v1/customers/${ids.priya}/payments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (!dropped) {
        dropped = true;
        return route.abort('connectionreset'); // nothing reaches the server
      }
      return route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('600');
    await save(page).click();
    await expect(failed(page)).toContainText('Could not confirm that this was saved', {
      timeout: 30_000,
    });
    await amount(page).fill('650'); // another payment
    await save(page).click();
    await expect(paymentSaved(page)).toBeVisible({ timeout: 30_000 });
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(KEY);
    expect(keys[1]).not.toBe(keys[0]);
    expect(await receiptsOf(NAMES.priya)).toEqual([['money', 'UPI', '650.00', '0.000', '-', '-']]);
  });

  test('a gateway error before the API saw the call, then a normal reply: "Waking up…", the retry carries the same key, and the payment is saved once', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests, responses } = moneyCalls(page, ids.priya);
    let bad = 0;
    await page.route(`${apiUrl}/v1/customers/${ids.priya}/payments`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (bad < 2) {
        bad += 1;
        return route.fulfill({
          status: 502,
          contentType: 'text/html',
          headers: corsHeaders(),
          body: PROXY_PAGE,
        });
      }
      return route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('600');
    await save(page).click();
    await expect(banner(page)).toHaveText('Waking up…', { timeout: 15_000 });
    await expect(save(page)).toBeDisabled();
    await expect(paymentSaved(page)).toBeVisible({ timeout: 40_000 });
    await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
    expect(bad).toBe(2);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.headers()['idempotency-key'])).size).toBe(1);
    expect(responses[responses.length - 1].status()).toBe(201);
    expect(await receiptsOf(NAMES.priya)).toHaveLength(1);
  });

  test('with the network cut the banner appears and Record is disabled; both clear after reconnect', async ({
    page,
    context,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.priya);
    await openPanel(page, NAMES.priya);
    await amount(page).fill('600');
    await expect(save(page)).toBeEnabled();
    await context.setOffline(true);
    await expect(banner(page)).toHaveText('Offline: changes cannot be saved', { timeout: 20_000 });
    await expect(save(page)).toBeDisabled();
    await expect(save(page)).toHaveAttribute('title', 'Offline: changes cannot be saved');
    await context.setOffline(false);
    await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(save(page)).toBeEnabled();
    expect(await receiptsOf(NAMES.priya)).toEqual([]);
  });

  test('a customer who is archived by somebody else meanwhile: the payment is refused in words and nothing is recorded', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await openCard(page, NAMES.cash);
    await openPanel(page, NAMES.cash);
    await amount(page).fill('100');
    await laneSql(
      `UPDATE customers SET archived_at = CURRENT_TIMESTAMP(6) WHERE id = '${ids.cash}'`
    );
    await save(page).click();
    await expect(failed(page)).toContainText('archived', { timeout: 30_000 });
    await expect(failed(page)).toContainText('Nothing was changed');
    expect(await receiptsOf(NAMES.cash)).toEqual([]);
  });
});
