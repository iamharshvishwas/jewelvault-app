import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB16 (PT-W16; spec D4, R2, T-A17; PLAN.md P3-T2, the part that stays): the stale-rate guard on the screen, in a real browser against the real API of a lane.
//   PT-W16  with no rate dated today the first bill asks for confirmation (the rate card, for today, on the billing screen), and nothing is billed at an unconfirmed rate by accident;
//           a rate dated before the bill still saves, and the saved bill shows RATE_STALE (a purity with no rate at all: RATE_MISSING); the line stays editable with the warning on it;
//           the rate card shows the rate rows with their real dates.
//
// The pieces and the rates are written as root in the lane's container (their screens are other tasks') and everything a test made is taken out again, the bill-number counters
// it moved included (the API's invariant I5 would otherwise fail the volume case of hydrate.spec.ts). The daily rates a test confirms through the screen are removed too: the rows
// of the purities used here (Gold 18K, 20K, 22K, 24K and Silver 925) are deleted at the start and at the end, and no other spec leaves one behind.
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

/** A business date the way the rate card writes it: 17 Oct 2026. */
const dayLabel = (date: string) =>
  new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });

// ------------------------------------------------------------------------------------------------ the book of the tests

/**
 * The pieces (all `W16-...`):
 *   A1 to A4  a small gold piece of 22K: 1.000 g, labour 300 (retail), no piroi: at 7,000 a gram a retail bill of 7,300
 *   B1, B2    the same in 20K
 *   C1        the same in 24K
 *   S1        the same in silver 925
 *   P1        a Per Piece piece (22K) at 1,200, piroi 10
 */
const PIECES = [
  ...['A1', 'A2', 'A3', 'A4'].map((key) => ({ key, design: 'D22', net: '1.000' })),
  ...['B1', 'B2'].map((key) => ({ key, design: 'D20', net: '1.000' })),
  { key: 'C1', design: 'D24', net: '1.000' },
  { key: 'S1', design: 'DSV', net: '1.000' },
  { key: 'P1', design: 'DPP', net: '0.000' },
];
const sku = (key: string) => `W16-${key}`;
const designIds = {
  D22: randomUUID(),
  D20: randomUUID(),
  D24: randomUUID(),
  DSV: randomUUID(),
  DPP: randomUUID(),
};

function fixtureSql(): string {
  const category = `(SELECT id FROM categories WHERE name = 'Ring')`;
  const design = (key: keyof typeof designIds, material: string, purity: string, method: string) =>
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) VALUES ('${designIds[key]}', 'W16-${key}', 'W16 ${key}', ${category}, '${material}', '${purity}', '${method}');`;
  const piece = (p: (typeof PIECES)[number]) =>
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, piroi, labour_retail, labour_semi, labour_wholesale, status) VALUES ('${randomUUID()}', '${designIds[p.design as keyof typeof designIds]}', '${sku(p.key)}', 'W16BC-${p.key}', ${p.net === '0.000' ? '0.000' : '1.200'}, ${p.net}, ${p.key === 'P1' ? '10.00' : '0.00'}, ${p.key === 'P1' ? '1200.00' : '300.00'}, ${p.key === 'P1' ? '1100.00' : '280.00'}, ${p.key === 'P1' ? '1000.00' : '260.00'}, 'In Stock');`;
  return [
    design('D22', 'Gold', '22K', 'By Weight'),
    design('D20', 'Gold', '20K', 'By Weight'),
    design('D24', 'Gold', '24K', 'By Weight'),
    design('DSV', 'Silver', '925', 'By Weight'),
    design('DPP', 'Gold', '22K', 'Per Piece'),
    ...PIECES.map(piece),
  ].join(' ');
}

/** Rates written as root: [material, purity, rate, days from today]. */
const setRates = (rates: Array<[string, string, string, number]>) =>
  laneSql(
    rates
      .map(
        ([material, purity, rate, days]) =>
          `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES (UUID(), '${material}', '${purity}', ${rate}, '${kolkata(days)}');`
      )
      .join(' ')
  );

/** Everything these tests made, gone again. The bills are found by their lines. */
async function cleanLane() {
  const bills = (
    await laneSql(`SELECT DISTINCT bill_id FROM bill_items WHERE sku_no LIKE 'W16-%'`)
  ).map((r) => `'${r[0]}'`);
  const billList = bills.length > 0 ? bills.join(', ') : "''";
  await laneSql(
    `DELETE FROM receipt_allocations WHERE bill_id IN (${billList}); ` +
      `DELETE FROM bill_items WHERE bill_id IN (${billList}); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W16-%'; ` +
      `DELETE FROM bills WHERE id IN (${billList}); ` +
      `DELETE FROM designs WHERE design_no LIKE 'W16-%'; ` +
      `DELETE FROM daily_rates WHERE (material = 'Gold' AND purity IN ('18K', '20K', '22K', '24K')) OR (material = 'Silver' AND purity = '925');`
  );
  // X1 makes a row of sys_counters for the series of its bill numbers (and moves it), and deleting the bills does not take it away. The API's seed-volume tool, which the volume case of
  // hydrate.spec.ts runs, inserts that row itself and then checks invariant I5: a series with no bill left is removed again, as a fresh lane has it.
  await laneSql(
    `DELETE FROM sys_counters WHERE series LIKE 'bill:%' AND NOT EXISTS (` +
      `SELECT 1 FROM bills b WHERE b.import_batch_id IS NULL AND sys_counters.series = CONCAT('bill:', ` +
      `SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1), ` +
      `':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1)))`
  );
}

/** The lines these tests billed: piece, rate on the line, the list rate the API recorded. */
const linesBilled = async () =>
  laneSql(
    `SELECT sku_no, metal_rate, list_metal_rate FROM bill_items WHERE sku_no LIKE 'W16-%' ORDER BY sku_no`
  );
const ratesOf = async (material: string, purity: string) =>
  laneSql(
    `SELECT rate_date, rate_per_gram FROM daily_rates WHERE material = '${material}' AND purity = '${purity}' ORDER BY rate_date`
  );
const countBills = async () =>
  (await laneSql(`SELECT COUNT(DISTINCT bill_id) FROM bill_items WHERE sku_no LIKE 'W16-%'`))[0][0];

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();

/** Opens the billing screen as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, target = '/billing-pos') {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
}
async function openBilling(page: Page, who: E2eLogin) {
  await open(page, who);
  await expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible();
}

async function addPiece(page: Page, key: string) {
  await page.getByPlaceholder('Enter SKU number or scan barcode...').fill(sku(key));
  await page.keyboard.press('Enter');
  await expect(page.locator(`tr[data-sku="${sku(key)}"]`)).toBeVisible();
}

const save = (page: Page) => page.getByTestId('save-bill');
const saved = (page: Page) => page.getByTestId('bill-saved');
const grandTotal = (page: Page) => page.getByTestId('grand-total');
const guard = (page: Page) => page.getByTestId('rate-guard');
const acknowledged = (page: Page) => page.getByTestId('rate-guard-ack');
const hold = (page: Page) => page.getByTestId('rate-guard-hold');
const lineInput = (page: Page, label: string, key: string) =>
  page.getByLabel(`${label} ${sku(key)}`);
const confirmButton = (page: Page) =>
  guard(page).getByRole('button', { name: "Confirm today's rates" });
const skipButton = (page: Page) => guard(page).getByTestId('rate-guard-skip');

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

// ------------------------------------------------------------------------------------------------ PT-W16: the first bill of the day asks

test.describe('PT-W16 (D4, R2): a rate not confirmed today asks for confirmation before the first bill of the day', () => {
  test.describe.configure({ timeout: 120_000 });

  test('with no rate dated today the first bill asks; Save waits; confirming writes the rate for today as the biller and the line takes it', async ({
    page,
  }) => {
    const biller = e2eLogin('biller');
    await setRates([['Gold', '22K', '6900.00', -2]]);
    await openBilling(page, biller);
    await expect(guard(page)).toHaveCount(0); // no piece yet: nothing to ask about

    await addPiece(page, 'A1');
    await expect(guard(page)).toBeVisible();
    await expect(guard(page)).toContainText('Gold 22K');
    await expect(page.getByTestId('rate-gold-22k-state')).toHaveText(
      `Rate of ${dayLabel(kolkata(-2))}, not confirmed today`
    );
    await expect(guard(page).getByTestId('rate-gold-22k')).toHaveValue('6900.00'); // the last rate, to start from
    await expect(save(page)).toBeDisabled(); // the first bill of the day waits for the answer
    await expect(hold(page)).toBeVisible();
    // nothing was written on its own: the rate shown is not a rate of today until the person says so
    expect(await ratesOf('Gold', '22K')).toEqual([[kolkata(-2), '6900.00']]);

    await guard(page).getByTestId('rate-gold-22k').fill('7000');
    await confirmButton(page).click();
    await expect(guard(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(hold(page)).toHaveCount(0);
    expect(await ratesOf('Gold', '22K')).toEqual([
      [kolkata(-2), '6900.00'],
      [kolkata(), '7000.00'],
    ]);
    const who = await laneSql(
      `SELECT u.email FROM daily_rates r JOIN users u ON u.id = r.confirmed_by WHERE r.rate_date = '${kolkata()}' AND r.purity = '22K'`
    );
    expect(who).toEqual([[biller.email]]); // confirmed_by is the person who confirmed it (S6)

    // the line took the rate that was confirmed, and says nothing about an old rate
    await expect(lineInput(page, 'Metal rate', 'A1')).toHaveValue('7000.00');
    await expect(page.getByTestId('rate-note')).toHaveCount(0);
    await expect(grandTotal(page)).toHaveText('₹7,300'); // 7,000 + labour 300
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toHaveCount(0);
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await linesBilled()).toEqual([[sku('A1'), '7000.00', '7000.00']]);

    // it was the first bill of the day: the second does not ask
    await page.getByRole('button', { name: 'New Sale' }).last().click();
    await addPiece(page, 'A2');
    await expect(guard(page)).toHaveCount(0);
    await expect(acknowledged(page)).toHaveCount(0);
    await expect(lineInput(page, 'Metal rate', 'A2')).toHaveValue('7000.00');
    await expect(save(page)).toBeEnabled();
  });

  test('a purity that never had a rate asks too, with nothing to start from; the rate typed becomes the rate of today and the line takes it', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '7000.00', 0]]); // another purity being confirmed does not confirm this one
    await openBilling(page, e2eLogin('owner'));
    await addPiece(page, 'B1'); // 20K gold
    await expect(guard(page)).toBeVisible();
    await expect(guard(page)).toContainText('Gold 20K');
    await expect(page.getByTestId('rate-gold-20k-state')).toHaveText('No rate yet');
    await expect(guard(page).getByTestId('rate-gold-20k')).toHaveValue('');
    await expect(save(page)).toBeDisabled();

    await confirmButton(page).click(); // nothing typed: nothing is sent
    await expect(guard(page).getByRole('alert')).toContainText('Gold 20K');
    expect(await ratesOf('Gold', '20K')).toEqual([]);

    await guard(page).getByTestId('rate-gold-20k').fill('6100');
    await confirmButton(page).click();
    await expect(guard(page)).toHaveCount(0, { timeout: 20_000 });
    expect(await ratesOf('Gold', '20K')).toEqual([[kolkata(), '6100.00']]);
    await expect(lineInput(page, 'Metal rate', 'B1')).toHaveValue('6100.00');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await linesBilled()).toEqual([[sku('B1'), '6100.00', '6100.00']]);
  });

  test('a rate that is already dated today asks nothing; neither does a Per Piece line, which has no daily rate', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '7000.00', 0]]);
    await openBilling(page, e2eLogin('biller'));
    await addPiece(page, 'A1');
    await addPiece(page, 'P1');
    await expect(guard(page)).toHaveCount(0);
    await expect(acknowledged(page)).toHaveCount(0);
    await expect(hold(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toHaveCount(0);
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
  });

  test('a bill of a Per Piece line alone asks nothing even when no rate has ever been entered', async ({
    page,
  }) => {
    await openBilling(page, e2eLogin('biller'));
    await addPiece(page, 'P1');
    await expect(guard(page)).toHaveCount(0);
    await expect(hold(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
  });

  test('a bill dated before today is not asked: its own date is what counts, and the line says when that rate is old', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '6900.00', -3]]);
    await openBilling(page, e2eLogin('owner'));
    await page.locator('input[type="date"]').first().fill(kolkata(-1));
    await addPiece(page, 'A1');
    await expect(guard(page)).toHaveCount(0);
    await expect(page.getByTestId('rate-note')).toContainText('older than the bill date');
    await expect(save(page)).toBeEnabled();
  });

  test('a rate somebody else confirms meanwhile ends the question: the next poll brings it, and the line takes it', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '6900.00', -2]]);
    await openBilling(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await expect(guard(page)).toBeVisible();
    await expect(lineInput(page, 'Metal rate', 'A1')).toHaveValue('6900.00');
    await setRates([['Gold', '22K', '7100.00', 0]]); // the other person, on another screen
    await expect(guard(page)).toHaveCount(0, { timeout: 40_000 });
    await expect(lineInput(page, 'Metal rate', 'A1')).toHaveValue('7100.00');
    await expect(page.getByTestId('rate-note')).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
  });

  test('if the API refuses the confirmation the guard says so and stays: the bill is not made at a rate nobody confirmed', async ({
    page,
  }) => {
    const { apiUrl, webOrigin } = e2eLane();
    await setRates([['Gold', '22K', '6900.00', -2]]);
    let refuse = true;
    await page.route(`${apiUrl}/v1/daily-rates`, async (route) => {
      if (route.request().method() !== 'POST' || !refuse) return route.fallback();
      return route.fulfill({
        status: 403,
        contentType: 'application/json',
        headers: {
          'access-control-allow-origin': webOrigin,
          'access-control-allow-credentials': 'true',
        },
        body: JSON.stringify({
          error: { code: 'JV_FORBIDDEN', message: 'made up by the test', details: {} },
          request_id: 'req-test',
        }),
      });
    });
    await openBilling(page, e2eLogin('biller'));
    await addPiece(page, 'A1');
    await confirmButton(page).click();
    await expect(guard(page).getByRole('alert')).toBeVisible();
    await expect(guard(page)).toBeVisible();
    await expect(save(page)).toBeDisabled();
    expect(await ratesOf('Gold', '22K')).toEqual([[kolkata(-2), '6900.00']]);
    expect(await countBills()).toBe('0');

    refuse = false; // the person tries again
    await confirmButton(page).click();
    await expect(guard(page)).toHaveCount(0, { timeout: 20_000 });
    expect(await ratesOf('Gold', '22K')).toHaveLength(2);
  });
});

// ------------------------------------------------------------------------------------------------ PT-W16: a stale or missing rate still saves, with its warning, and the line stays editable

test.describe('PT-W16 (T-A17, R2): a rate dated before the bill shows RATE_STALE and still saves; the line stays editable', () => {
  test.describe.configure({ timeout: 120_000 });

  test('billing without confirming: the line says the rate is old, the saved bill carries RATE_STALE, and nothing was written to the rates', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '6900.00', -2]]);
    await openBilling(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await expect(save(page)).toBeDisabled();
    await skipButton(page).click();
    await expect(guard(page)).toHaveCount(0);
    await expect(acknowledged(page)).toBeVisible();
    await expect(acknowledged(page)).toContainText('Gold 22K');
    await expect(hold(page)).toHaveCount(0);
    await expect(save(page)).toBeEnabled();
    await expect(page.getByTestId('rate-note')).toContainText('older than the bill date');
    await expect(lineInput(page, 'Metal rate', 'A1')).toHaveValue('6900.00');

    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toBeVisible();
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
    expect(await linesBilled()).toEqual([[sku('A1'), '6900.00', '6900.00']]);
    expect(await ratesOf('Gold', '22K')).toEqual([[kolkata(-2), '6900.00']]); // billing is not confirming
  });

  test('after the warning the line can still be edited: the rate typed is the rate billed, and the API still warns', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '6900.00', -2]]);
    await openBilling(page, e2eLogin('biller'));
    await addPiece(page, 'A1');
    await skipButton(page).click();
    await expect(page.getByTestId('rate-note')).toContainText('older than the bill date');

    const rate = lineInput(page, 'Metal rate', 'A1');
    await expect(rate).toBeEnabled();
    await rate.fill('7123');
    await expect(grandTotal(page)).toHaveText('₹7,423'); // 7,123 + labour 300
    await expect(page.getByTestId('rate-note')).toHaveCount(0); // it is the person's rate now
    await lineInput(page, 'Labour rate', 'A1').fill('310');
    await expect(grandTotal(page)).toHaveText('₹7,433');
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    // the line is what was typed; the list price is the daily rate the API found, and it is old
    await expect(page.getByTestId('warning-rate-stale')).toBeVisible();
    expect(await linesBilled()).toEqual([[sku('A1'), '7123.00', '6900.00']]);
  });

  test('no rate at all: billing without confirming asks for a rate on the line, and the saved bill carries RATE_MISSING', async ({
    page,
  }) => {
    await openBilling(page, e2eLogin('owner'));
    await addPiece(page, 'B1'); // 20K gold: no rate ever
    await skipButton(page).click();
    await expect(acknowledged(page)).toContainText('Gold 20K');
    await expect(lineInput(page, 'Metal rate', 'B1')).toHaveValue('');
    await expect(page.getByTestId('rate-note')).toContainText('No daily rate for Gold 20K');
    await expect(save(page)).toBeDisabled(); // a bill needs a rate: the line asks for one
    await expect(page.getByTestId('line-error')).toContainText('No daily rate is set for Gold 20K');
    await lineInput(page, 'Metal rate', 'B1').fill('6000');
    await expect(save(page)).toBeEnabled();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-missing')).toBeVisible();
    expect(await linesBilled()).toEqual([[sku('B1'), '6000.00', '0.00']]);
    expect(await ratesOf('Gold', '20K')).toEqual([]);
  });

  test('the answer "bill without confirming" holds for the rest of the visit: the next bill does not ask again, and the note offers the confirmation', async ({
    page,
  }) => {
    await setRates([['Gold', '22K', '6900.00', -2]]);
    await openBilling(page, e2eLogin('owner'));
    await addPiece(page, 'A1');
    await skipButton(page).click();
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'New Sale' }).last().click();
    await addPiece(page, 'A2');
    await expect(guard(page)).toHaveCount(0);
    await expect(acknowledged(page)).toBeVisible();
    await expect(save(page)).toBeEnabled();
    // a purity that was not answered still asks
    await addPiece(page, 'C1');
    await expect(guard(page)).toContainText('Gold 24K');
    await expect(guard(page)).not.toContainText('Gold 22K');
    await expect(save(page)).toBeDisabled();
    // the person changes their mind about 22K: the note takes the answer back
    await acknowledged(page).getByRole('button', { name: 'Ask me again' }).click();
    await expect(guard(page)).toContainText('Gold 22K');
    await expect(guard(page)).toContainText('Gold 24K');
  });
});

// ------------------------------------------------------------------------------------------------ PT-W16: the rate card shows the rate rows with their real dates

test.describe('PT-W16 (D4): the rate card shows the rate rows with their real dates', () => {
  test.describe.configure({ timeout: 120_000 });

  test('each purity says whether its rate is confirmed today or of which day it is, and the card names what is not confirmed', async ({
    page,
  }) => {
    await setRates([
      ['Gold', '22K', '7000.00', 0],
      ['Gold', '24K', '7500.00', -2],
    ]);
    await open(page, e2eLogin('owner'), '/');
    await expect(page.getByTestId('rate-gold-22k-state')).toHaveText('Confirmed today', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('rate-gold-24k-state')).toHaveText(
      `Rate of ${dayLabel(kolkata(-2))}, not confirmed today`
    );
    await expect(page.getByTestId('rate-gold-18k-state')).toHaveText('No rate yet');
    await expect(page.getByTestId('rate-silver-925-state')).toHaveText('No rate yet');
    // "Last updated" is the newest real date, today because 22K has a rate of today; the card also lists what is missing
    await expect(page.getByText(`Last updated: ${dayLabel(kolkata())}`)).toBeVisible();
    // what has an old rate and none for today is named; a purity that never had a rate says so on its own row
    await expect(page.getByTestId('rate-unconfirmed')).toHaveText('Not confirmed today: Gold 24K');

    // the same card on another day: the owner picks the day two days ago, where 24K has its row and 22K does not
    await page.getByLabel('Rates for').fill(kolkata(-2));
    await expect(page.getByTestId('rate-gold-24k-state')).toHaveText(
      `Rate of ${dayLabel(kolkata(-2))}`
    );
    await expect(page.getByText(`Last updated: ${dayLabel(kolkata(-2))}`)).toBeVisible();
  });

  test('a rate typed on the card is dated today and is the one the billing screen uses', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/');
    await page.getByTestId('rate-gold-22k').fill('7050');
    await page.getByRole('button', { name: 'Save Rates' }).click();
    await expect(page.getByTestId('rate-gold-22k-state')).toHaveText('Confirmed today', {
      timeout: 20_000,
    });
    expect(await ratesOf('Gold', '22K')).toEqual([[kolkata(), '7050.00']]);
    await page.goto('/billing-pos');
    await expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible({
      timeout: 60_000,
    });
    await addPiece(page, 'A1');
    await expect(guard(page)).toHaveCount(0);
    await expect(lineInput(page, 'Metal rate', 'A1')).toHaveValue('7050.00');
  });
});
