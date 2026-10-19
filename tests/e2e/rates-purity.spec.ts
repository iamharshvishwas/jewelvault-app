import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { noteApiCall, roomInTheMinute } from './pacing';

// WEB17 (PLAN.md P3-T2, the part that is cut first; spec D4, R2, R14, T-A13; plan test PT-W17): the rate card holds a Gold rate for each purity (24K, 22K, 20K, 18K) and a new bill takes the
// rate of its piece's material and purity, and the line can still be edited. In a real browser, against the real API of a lane.
//   - the owner types a rate for each of the four purities on the rate card; the billing screen gives each piece the rate of ITS purity (no purity takes another's); the 18K line is changed by
//     hand and the bill keeps what was typed while the API's list price of every line is the card's rate of that purity
//   - a back-dated bill takes the rate of its own day, purity by purity (22K and 18K), and a line the person typed does not move when the date does
//   - a rate that arrives AFTER the piece was scanned (the owner types it on the card in another browser, a poll brings it) fills the line that waited for it and replaces the stale rate it
//     started from; a line the person typed keeps what was typed
//
// Everything this spec makes is `W17...` or a `daily_rates` row it wrote, and is removed after each test; the lane's `daily_rates` is put back as it was found. The bills are made by the screen.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/rates-purity.spec.ts

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

/** A business date in the shop's time zone, `days` from today. */
function kolkata(days = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

// ------------------------------------------------------------------------------------------------ the book of the tests

/**
 * The pieces (all `W17-...`, 1.000 g net, labour 300 a gram retail, no piroi): one of each Gold purity, and a second 22K one. One gram keeps a walk-in's bill of four pieces far under the limit
 * above which the API wants a customer (JV_CASH_LIMIT): the line total is the rate plus 300.
 */
const PIECES = [
  { key: 'A24', purity: '24K' },
  { key: 'A22', purity: '22K' },
  { key: 'B22', purity: '22K' },
  { key: 'A20', purity: '20K' },
  { key: 'A18', purity: '18K' },
] as const;
const PURITIES = ['24K', '22K', '20K', '18K'] as const;
const sku = (key: string) => `W17-${key}`;

function fixtureSql(): string {
  const category = `(SELECT id FROM categories WHERE name = 'Ring')`;
  const designs = new Map<string, string>(PURITIES.map((purity) => [purity, randomUUID()]));
  return [
    ...[...designs].map(
      ([purity, id]) =>
        `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) VALUES ('${id}', 'W17-${purity}', 'W17 ${purity}', ${category}, 'Gold', '${purity}', 'By Weight');`
    ),
    ...PIECES.map(
      (p) =>
        `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, piroi, labour_retail, labour_semi, labour_wholesale, status) VALUES ('${randomUUID()}', '${designs.get(p.purity)}', '${sku(p.key)}', 'W17BC-${p.key}', 1.200, 1.000, 0.00, 300.00, 280.00, 260.00, 'In Stock');`
    ),
  ].join(' ');
}

/** A rate written as root, `daysAgo` days before today: somebody else's, or yesterday's, that was there before the test began. */
const rate = (purity: string, price: string, daysAgo: number) =>
  laneSql(
    `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES (UUID(), 'Gold', '${purity}', ${price}, '${kolkata(-daysAgo)}');`
  );

/** The ids of the rates the lane held when the test began: whatever else is there when it ends is the test's and goes. */
let ratesBefore: string[] = [];

/** Everything these tests made, gone again. The delete order follows the foreign keys; the bills are found by their lines. */
async function cleanLane() {
  const bills = (await laneSql(`SELECT DISTINCT bill_id FROM bill_items WHERE sku_no LIKE 'W17-%'`))
    .map((r) => `'${r[0]}'`)
    .join(', ');
  const list = bills === '' ? "''" : bills;
  await laneSql(
    `DELETE FROM receipt_allocations WHERE bill_id IN (${list}); ` +
      `DELETE FROM bill_items WHERE bill_id IN (${list}); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W17-%'; ` +
      `DELETE FROM bills WHERE id IN (${list}) OR bill_no LIKE 'W17-%'; ` +
      `DELETE FROM designs WHERE design_no LIKE 'W17-%';`
  );
  // (a UUID column compared with '' is not "different", it is unknown, so an empty list is a plain delete of everything)
  await laneSql(
    ratesBefore.length === 0
      ? `DELETE FROM daily_rates;`
      : `DELETE FROM daily_rates WHERE id NOT IN (${ratesBefore.map((id) => `'${id}'`).join(', ')});`
  );
  // X1 makes a row of sys_counters for the series of its bill numbers (and moves it), and deleting the bills does not take it away: a series with no bill left is removed again, as a fresh
  // lane has it (the API's invariant I5, as in tests/e2e/billing.spec.ts)
  await laneSql(
    `DELETE FROM sys_counters WHERE series LIKE 'bill:%' AND NOT EXISTS (` +
      `SELECT 1 FROM bills b WHERE b.import_batch_id IS NULL AND sys_counters.series = CONCAT('bill:', ` +
      `SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1), ` +
      `':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1)))`
  );
}

/** What the bill's lines hold, in the order they were put on the bill: the piece, its purity (the snapshot), the rate the bill used and the list price the API took. */
const billLines = () =>
  laneSql(
    `SELECT sku_no, purity, metal_rate, list_metal_rate FROM bill_items WHERE sku_no LIKE 'W17-%' ORDER BY bill_id, line_no`
  );
const billDates = async () =>
  (
    await laneSql(
      `SELECT DISTINCT b.bill_date FROM bills b JOIN bill_items i ON i.bill_id = b.id WHERE i.sku_no LIKE 'W17-%'`
    )
  ).map((r) => r[0]);
const ratesOf = () =>
  laneSql(
    `SELECT purity, rate_per_gram, confirmed_by IS NOT NULL FROM daily_rates WHERE material = 'Gold' AND rate_date = '${kolkata()}' ORDER BY purity`
  );

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();

/** Signs in and opens a page of the application (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, target = '/billing-pos', heading = 'New Estimate') {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
  if (heading) await expect(page.getByRole('heading', { name: heading })).toBeVisible();
}

async function addPiece(page: Page, key: string) {
  await page.getByPlaceholder('Enter SKU number or scan barcode...').fill(sku(key));
  await page.keyboard.press('Enter');
  await expect(page.locator(`tr[data-sku="${sku(key)}"]`)).toBeVisible();
}

const save = (page: Page) => page.getByTestId('save-bill');
const saved = (page: Page) => page.getByTestId('bill-saved');
const guard = (page: Page) => page.getByTestId('rate-guard');
const lineRate = (page: Page, key: string) => page.getByLabel(`Metal rate ${sku(key)}`);
const lineTotal = (page: Page, key: string) =>
  page.locator(`tr[data-sku="${sku(key)}"]`).getByTestId('item-total');
const billDate = (page: Page) => page.locator('input[type="date"]').first();
const card = (page: Page) => page.locator('section', { hasText: 'Daily Metal Rates' });
const cardRate = (page: Page, purity: string) =>
  page.getByTestId(`rate-gold-${purity.toLowerCase()}`);

/** The owner's rate card: types these rates (purity, text) and saves them. */
async function typeOnTheCard(page: Page, rates: Array<[string, string]>) {
  await expect(card(page)).toBeVisible();
  for (const [purity, text] of rates) await cardRate(page, purity).fill(text);
  await page.getByRole('button', { name: 'Save Rates' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Rates saved' })).toBeVisible({
    timeout: 30_000,
  });
}

test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
  ratesBefore = (await laneSql(`SELECT id FROM daily_rates`)).map((r) => r[0]);
  // the tests write every Gold rate they use: a rate of these purities left by another spec would be taken for theirs
  expect(
    await laneSql(
      `SELECT COUNT(*) FROM daily_rates WHERE material = 'Gold' AND purity IN ('24K', '22K', '20K', '18K')`
    ),
    'another spec left Gold rates in the lane'
  ).toEqual([['0']]);
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterEach(async () => {
  await cleanLane();
});

// ------------------------------------------------------------------------------------------------ PT-W17

test.describe("PT-W17: a new bill takes the rate for its piece's purity (24K, 22K, 20K, 18K) and the line can still be edited", () => {
  test.describe.configure({ timeout: 150_000 });

  test("the owner types a rate for each purity on the rate card; each piece of a new bill takes the rate of its own purity, the 18K line is changed by hand, and the API's list price of every line is the card's", async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await open(page, owner, '/', '');
    // one field for each of the four Gold purities
    for (const purity of PURITIES) await expect(cardRate(page, purity)).toBeVisible();
    await typeOnTheCard(page, [
      ['24K', '7500'],
      ['22K', '6920'],
      ['20K', '6300.5'],
      ['18K', '5700'],
    ]);
    // one row for each, dated today, each confirmed by a person (the API forces confirmed_by)
    expect(await ratesOf()).toEqual([
      ['18K', '5700.00', '1'],
      ['20K', '6300.50', '1'],
      ['22K', '6920.00', '1'],
      ['24K', '7500.00', '1'],
    ]);

    await page.goto('/billing-pos');
    await expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible();
    for (const key of ['A24', 'A22', 'A20', 'A18']) await addPiece(page, key);
    // every piece has the rate of its own purity, and the screen has nothing to say about them
    await expect(lineRate(page, 'A24')).toHaveValue('7500.00');
    await expect(lineRate(page, 'A22')).toHaveValue('6920.00');
    await expect(lineRate(page, 'A20')).toHaveValue('6300.50');
    await expect(lineRate(page, 'A18')).toHaveValue('5700.00');
    await expect(page.getByTestId('rate-note')).toHaveCount(0);
    await expect(guard(page)).toHaveCount(0);
    // 1 g at the rate, plus labour 300 a gram
    await expect(lineTotal(page, 'A22')).toHaveText('₹7,220.00');
    await expect(lineTotal(page, 'A18')).toHaveText('₹6,000.00');

    // the line can still be edited: the 18K piece is sold for 5,650 a gram; the other lines do not move
    await expect(lineRate(page, 'A18')).toBeEditable();
    await lineRate(page, 'A18').fill('5650');
    await expect(lineRate(page, 'A18')).toHaveValue('5650');
    await expect(lineTotal(page, 'A18')).toHaveText('₹5,950.00');
    await expect(lineRate(page, 'A22')).toHaveValue('6920.00');
    await expect(lineTotal(page, 'A22')).toHaveText('₹7,220.00');

    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toHaveCount(0);
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    // the bill used what the screen showed; the list price the API took for every line is the card's rate of that line's purity (R14), also for the line that was changed
    expect(await billLines()).toEqual([
      [sku('A24'), '24K', '7500.00', '7500.00'],
      [sku('A22'), '22K', '6920.00', '6920.00'],
      [sku('A20'), '20K', '6300.50', '6300.50'],
      [sku('A18'), '18K', '5650.00', '5700.00'],
    ]);
  });

  test('a back-dated bill takes the rate of its own day for 22K and for 18K, a rate that was typed does not move with the date, and the API took the same rates', async ({
    page,
  }) => {
    await rate('22K', '6920.00', 0);
    await rate('18K', '5700.00', 0);
    await rate('22K', '6800.00', 3);
    await rate('18K', '5500.00', 3);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A22');
    await addPiece(page, 'A18');
    await expect(lineRate(page, 'A22')).toHaveValue('6920.00');
    await expect(lineRate(page, 'A18')).toHaveValue('5700.00');

    // three days back: the rate of that day, purity by purity
    await billDate(page).fill(kolkata(-3));
    await expect(lineRate(page, 'A22')).toHaveValue('6800.00');
    await expect(lineRate(page, 'A18')).toHaveValue('5500.00');
    await expect(page.getByTestId('rate-note')).toHaveCount(0);

    // a rate typed on the 22K line stays when the date moves; the 18K line, which was only defaulted, follows
    await expect(lineRate(page, 'A22')).toBeEditable();
    await lineRate(page, 'A22').fill('6790');
    await billDate(page).fill(kolkata());
    await expect(lineRate(page, 'A18')).toHaveValue('5700.00');
    await expect(lineRate(page, 'A22')).toHaveValue('6790');
    await billDate(page).fill(kolkata(-3));
    await expect(lineRate(page, 'A18')).toHaveValue('5500.00');
    await expect(lineRate(page, 'A22')).toHaveValue('6790');

    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toHaveCount(0);
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await billDates()).toEqual([kolkata(-3)]);
    expect(await billLines()).toEqual([
      [sku('A22'), '22K', '6790.00', '6800.00'],
      [sku('A18'), '18K', '5500.00', '5500.00'],
    ]);
  });

  test('a rate that arrives after the piece was scanned (the owner types it on the card in another browser) fills the line that waited for it and replaces the stale rate; a rate that was typed stays', async ({
    page,
    browser,
  }) => {
    const { apiUrl } = e2eLane();
    await rate('22K', '6800.00', 3); // the last 22K rate is from three days ago; there is no 18K rate at all
    const other = await browser.newContext();
    try {
      const owner = await other.newPage();
      owner.on('request', (request) => {
        if (request.url().startsWith(apiUrl)) noteApiCall();
      });
      await open(page, e2eLogin('biller'));
      await addPiece(page, 'A22');
      await addPiece(page, 'B22');
      await addPiece(page, 'A18');
      await expect(lineRate(page, 'B22')).toBeEditable();
      await lineRate(page, 'B22').fill('6900'); // the person's own rate for this piece
      await expect(lineRate(page, 'A22')).toHaveValue('6800.00'); // the stale rate it started from
      await expect(lineRate(page, 'A18')).toHaveValue(''); // nothing to start from
      await expect(guard(page)).toContainText('Gold 22K');
      await expect(guard(page)).toContainText('Gold 18K');
      await expect(save(page)).toBeDisabled();

      // the owner sets today's rates; the biller's screen hears of them with its next poll
      await open(owner, e2eLogin('owner'), '/', '');
      await typeOnTheCard(owner, [
        ['22K', '6950'],
        ['18K', '5700'],
      ]);

      await expect(guard(page)).toHaveCount(0, { timeout: 40_000 });
      await expect(lineRate(page, 'A22')).toHaveValue('6950.00'); // the line that was on its default follows the rate of today
      await expect(lineRate(page, 'A18')).toHaveValue('5700.00'); // the line that waited for a rate has it
      await expect(lineRate(page, 'B22')).toHaveValue('6900'); // the rate the person typed is left alone
      await expect(page.getByTestId('rate-note')).toHaveCount(0);
      await expect(save(page)).toBeEnabled();

      await save(page).click();
      await expect(saved(page)).toBeVisible({ timeout: 30_000 });
      await expect(page.getByTestId('warning-rate-stale')).toHaveCount(0);
      await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
      expect(await billLines()).toEqual([
        [sku('A22'), '22K', '6950.00', '6950.00'],
        [sku('B22'), '22K', '6900.00', '6950.00'],
        [sku('A18'), '18K', '5700.00', '5700.00'],
      ]);
    } finally {
      await other.close();
    }
  });
});
