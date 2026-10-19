import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB16 (PLAN.md P3-T2, the part that stays; spec D4, R2, Y8; plan test PT-W16): the stale-rate guard on the screen, in a real browser against the real API of a lane.
//   - with no rate dated today the first bill of the day asks for confirmation: the billing screen names the purity, the last rate and the day it comes from, Save waits, the rate on the line
//     stays editable; "Confirm today's rates" writes a rate dated today (confirmed_by is the person), the line that follows the default takes it and the saved bill has no warning
//   - "Bill with the rates as they are" writes nothing: the bill saves and carries RATE_STALE (a rate dated before the bill) or RATE_MISSING (no rate at all) as the API says
//   - it asks once: the next bill of the day, and a bill that somebody else made today (a poll), do not ask
//   - a biller confirms today's rates from the billing screen too; a rate dated today asks nothing
//   - the rate card of the dashboard shows the real date of every rate (the prototype's "Last updated" always said today)
//
// The pieces, rates and the other browser's bill are written as root in the lane's container; the bills are made by the screen. Rows are `W16...` and are removed after each test.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/rates.spec.ts

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

/** `2026-10-12` as the rate card and the guard write it: `12 Oct 2026`. */
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// ------------------------------------------------------------------------------------------------ the book of the tests

/**
 * The pieces (all `W16-...`, 1.000 g net, labour 300 retail, no piroi): A1 and A2 22K gold, B1 24K gold, C1 20K gold.
 * No rate exists before a test writes it: `rate(purity, price, daysAgo)`.
 */
const PIECES = [
  { key: 'A1', purity: '22K' },
  { key: 'A2', purity: '22K' },
  { key: 'B1', purity: '24K' },
  { key: 'C1', purity: '20K' },
] as const;
const sku = (key: string) => `W16-${key}`;

function fixtureSql(): string {
  const category = `(SELECT id FROM categories WHERE name = 'Ring')`;
  const designs = new Map<string, string>(PIECES.map((p) => [p.purity, randomUUID()]));
  return [
    ...[...designs].map(
      ([purity, id]) =>
        `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) VALUES ('${id}', 'W16-${purity}', 'W16 ${purity}', ${category}, 'Gold', '${purity}', 'By Weight');`
    ),
    ...PIECES.map(
      (p) =>
        `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, piroi, labour_retail, labour_semi, labour_wholesale, status) VALUES ('${randomUUID()}', '${designs.get(p.purity)}', '${sku(p.key)}', 'W16BC-${p.key}', 1.200, 1.000, 0.00, 300.00, 280.00, 260.00, 'In Stock');`
    ),
  ].join(' ');
}

const rate = (purity: string, price: string, daysAgo: number) =>
  laneSql(
    `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES (UUID(), 'Gold', '${purity}', ${price}, '${kolkata(-daysAgo)}');`
  );

/** Everything these tests made, gone again. The delete order follows the foreign keys; the bills are found by their lines. */
async function cleanLane() {
  const bills = (await laneSql(`SELECT DISTINCT bill_id FROM bill_items WHERE sku_no LIKE 'W16-%'`))
    .map((r) => `'${r[0]}'`)
    .join(', ');
  const list = bills === '' ? "''" : bills;
  await laneSql(
    `DELETE FROM receipt_allocations WHERE bill_id IN (${list}); ` +
      `DELETE FROM bill_items WHERE bill_id IN (${list}); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W16-%'; ` +
      `DELETE FROM bills WHERE id IN (${list}) OR bill_no LIKE 'W16-%'; ` +
      `DELETE FROM designs WHERE design_no LIKE 'W16-%'; ` +
      `DELETE FROM daily_rates WHERE material = 'Gold' AND purity IN ('20K', '22K', '24K');`
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

const metalRateOf = async (key: string) =>
  (await laneSql(`SELECT metal_rate FROM bill_items WHERE sku_no = '${sku(key)}'`))[0]?.[0];
const countBills = async () =>
  Number(
    (
      await laneSql(`SELECT COUNT(DISTINCT bill_id) FROM bill_items WHERE sku_no LIKE 'W16-%'`)
    )[0][0]
  );
const ratesOf = (purity: string, date: string) =>
  laneSql(
    `SELECT rate_per_gram, confirmed_by IS NOT NULL FROM daily_rates WHERE material = 'Gold' AND purity = '${purity}' AND rate_date = '${date}'`
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

test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterEach(async () => {
  await cleanLane();
});

// ------------------------------------------------------------------------------------------------ PT-W16

test.describe('PT-W16: a rate not confirmed today asks for confirmation before the first bill of the day', () => {
  test.describe.configure({ timeout: 120_000 });

  test('no rate dated today: the first bill asks, Save waits, the line stays editable; confirming writes a rate dated today and the line takes it', async ({
    page,
  }) => {
    await rate('22K', '6800.00', 3);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A1');

    // the question names the purity, the last rate and the day it comes from
    await expect(guard(page)).toBeVisible();
    await expect(guard(page)).toContainText('before the first bill of the day');
    await expect(guard(page)).toContainText('Gold 22K');
    await expect(guard(page)).toContainText(`last set ${dayLabel(kolkata(-3))}`);
    await expect(guard(page)).toContainText('₹6,800.00');
    await expect(page.getByTestId('rate-guard-gold-22k')).toHaveValue('6800.00');
    // Save waits for the answer, but nothing on the line is locked
    await expect(save(page)).toBeDisabled();
    await expect(lineRate(page, 'A1')).toHaveValue('6800.00');
    await expect(lineRate(page, 'A1')).toBeEnabled();

    // confirm a new rate for today
    await page.getByTestId('rate-guard-gold-22k').fill('7000.50');
    await page.getByTestId('rate-guard-confirm').click();
    await expect(guard(page)).toHaveCount(0);
    await expect(lineRate(page, 'A1')).toHaveValue('7000.50'); // the line followed the default
    await expect(page.getByTestId('rate-note')).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    expect(await ratesOf('22K', kolkata())).toEqual([['7000.50', '1']]); // dated today, and a person confirmed it

    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toHaveCount(0);
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await metalRateOf('A1')).toBe('7000.50');
  });

  test('a rate dated before the bill shows RATE_STALE and still saves: billing with the rates as they are writes no rate, and the line is editable all along', async ({
    page,
  }) => {
    await rate('22K', '6800.00', 3);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await expect(guard(page)).toBeVisible();

    // the line can be changed while the question is open
    await lineRate(page, 'A1').fill('6900');
    await expect(lineRate(page, 'A1')).toHaveValue('6900');
    await expect(save(page)).toBeDisabled();

    await page.getByTestId('rate-guard-skip').click();
    await expect(guard(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    expect(await ratesOf('22K', kolkata())).toEqual([]); // nothing was written
    await lineRate(page, 'A1').fill('6850'); // still editable after the answer
    await expect(lineRate(page, 'A1')).toHaveValue('6850');

    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toBeVisible();
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await metalRateOf('A1')).toBe('6850.00');
    expect(await countBills()).toBe(1);
  });

  test('it asks once: the next bill of the day does not ask, even for another stale purity, and still carries RATE_STALE', async ({
    page,
  }) => {
    await rate('22K', '6800.00', 3);
    await rate('24K', '7500.00', 2);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await expect(guard(page)).toBeVisible();
    // the first bill confirms the 22K rate (the person has not "billed as it is", so the second bill is not spared by that answer: it is spared because it is not the first bill)
    await page.getByTestId('rate-guard-confirm').click();
    await expect(guard(page)).toHaveCount(0);
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });

    await page.getByRole('button', { name: 'New Sale' }).click();
    await addPiece(page, 'B1'); // 24K: its rate is two days old
    await expect(page.getByTestId('rate-note')).toContainText('older than the bill date');
    await expect(guard(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toBeVisible();
    expect(await countBills()).toBe(2);
  });

  test('a rate dated today asks nothing', async ({ page }) => {
    await rate('22K', '6920.00', 0);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await expect(lineRate(page, 'A1')).toHaveValue('6920.00');
    await expect(guard(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
  });

  test('a bill that somebody else made today (a poll brings it) closes the question: it is no longer the first bill of the day', async ({
    page,
  }) => {
    await rate('22K', '6800.00', 3);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await expect(guard(page)).toBeVisible();
    await laneSql(
      `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) ` +
        `SELECT UUID(), 'W16-X1', id, '${kolkata()}', 'Retail', 1000.00, 1000.00 FROM customers WHERE is_walkin = 1;`
    );
    await expect(guard(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(save(page)).toBeEnabled();
  });

  test('no rate at all asks too: the rate can be typed in the question, and the lines take it; billing as it is keeps RATE_MISSING and the line editable', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'C1'); // 20K gold: no rate
    await expect(guard(page)).toContainText('Gold 20K');
    await expect(guard(page)).toContainText('No rate has been set yet');
    await expect(page.getByTestId('rate-guard-gold-20k')).toHaveValue('');
    await expect(save(page)).toBeDisabled();
    await page.getByTestId('rate-guard-gold-20k').fill('6000');
    await page.getByTestId('rate-guard-confirm').click();
    await expect(guard(page)).toHaveCount(0);
    await expect(lineRate(page, 'C1')).toHaveValue('6000.00');
    expect(await ratesOf('20K', kolkata())).toEqual([['6000.00', '1']]);
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await metalRateOf('C1')).toBe('6000.00');
  });

  test('billing with a missing rate as it is: the line asks for a rate, accepts one, and the saved bill says RATE_MISSING', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'C1');
    await page.getByTestId('rate-guard-skip').click();
    await expect(page.getByTestId('rate-note')).toContainText(
      'No daily rate for Gold 20K: enter one'
    );
    await expect(save(page)).toBeDisabled();
    await lineRate(page, 'C1').fill('6000');
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-missing')).toBeVisible();
    expect(await ratesOf('20K', kolkata())).toEqual([]);
  });

  test("a biller confirms today's rate from the billing screen (Y8: the biller enters today's rate)", async ({
    page,
  }) => {
    await rate('22K', '6800.00', 1);
    const biller = e2eLogin('biller');
    await open(page, biller);
    await addPiece(page, 'A1');
    await expect(guard(page)).toBeVisible();
    await page.getByTestId('rate-guard-gold-22k').fill('6850');
    await page.getByTestId('rate-guard-confirm').click();
    await expect(guard(page)).toHaveCount(0);
    await expect(lineRate(page, 'A1')).toHaveValue('6850.00');
    expect(await ratesOf('22K', kolkata())).toEqual([['6850.00', '1']]);
  });

  test('a refusal of the rate is shown in plain words and nothing is written (an amount that is not a rate)', async ({
    page,
  }) => {
    await rate('22K', '6800.00', 3);
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await page.getByTestId('rate-guard-gold-22k').fill('abc');
    await page.getByTestId('rate-guard-confirm').click();
    await expect(page.getByTestId('rate-guard-error')).toContainText('must be an amount above 0');
    await expect(guard(page)).toBeVisible();
    expect(await ratesOf('22K', kolkata())).toEqual([]);
    await expect(save(page)).toBeDisabled();
  });
});

// ------------------------------------------------------------------------------------------------ the rate card

test.describe('PT-W16: the rate card shows the real date of every rate it shows', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a rate of today says so, an older one says when it was last set and that it is not confirmed today, a purity with none says so; "Last updated" is the newest rate\'s day, not today', async ({
    page,
  }) => {
    await rate('22K', '6800.00', 2);
    await rate('24K', '7500.00', 5);
    await open(page, e2eLogin('owner'), '/', '');
    const card = page.locator('section', { hasText: 'Daily Metal Rates' });
    await expect(card).toBeVisible();
    await expect(page.getByTestId('rate-date-gold-22k')).toContainText(
      `Last set ${dayLabel(kolkata(-2))} · not confirmed today`
    );
    await expect(page.getByTestId('rate-date-gold-22k')).toHaveAttribute('data-state', 'stale');
    await expect(page.getByTestId('rate-date-gold-24k')).toContainText(
      `Last set ${dayLabel(kolkata(-5))}`
    );
    await expect(page.getByTestId('rate-date-gold-20k')).toContainText('No rate yet');
    await expect(card).toContainText(`Last updated: ${dayLabel(kolkata(-2))}`);
    await expect(card).not.toContainText(`Last updated: ${dayLabel(kolkata())}`);

    // typing today's rate and saving it makes it "Set today"
    await page.getByTestId('rate-gold-22k').fill('7000');
    await page.getByRole('button', { name: 'Save Rates' }).click();
    await expect(page.getByTestId('rate-date-gold-22k')).toContainText('Set today', {
      timeout: 20_000,
    });
    await expect(card).toContainText(`Last updated: ${dayLabel(kolkata())}`);
  });
});
