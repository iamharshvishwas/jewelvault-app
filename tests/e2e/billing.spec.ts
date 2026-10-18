import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Page, type Request, type Response } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { noteApiCall, roomInTheMinute } from './pacing';

// WEB08: the billing screen on quote_bill and create_bill, in a real browser against the real API of a lane (spec C5 (b), C6, C7, C12, C13, L5, R1, R2, R9, R10, Y2, Z1, Z3).
//   T-E06  a double click on Save creates one bill; a dropped response and a retry create one bill (the same Idempotency-Key, the server replays); the same bill in two tabs is saved once
//   T-E03  (clause) with the network cut Save is disabled; a gateway error followed by a normal reply shows "Waking up…" and a money call retried meanwhile with the same key saves once
//   T-A14  (screen half) the screen disables Save on bills when pricing_sha256 of `me` differs from the build's own
//   T-A03  (UNIT half, on the screen) choosing a customer sets the sale type and the default labour rate follows it
//   T-A01  (screen half) the worked example (35.42 g, 6,920, labour 353, piroi 2.15) saves a bill of 257,612 and the screen's preview equals the saved figure
//   T-C06  (screen half) two billers saving the same piece: one success, one message naming the piece
//   and the messages and prompts of the screen: JV_CASH_LIMIT (biller and owner), JV_OVERPAYMENT, PAN_MISSING and the PAN prompt, "Advance adjusted", RATE_MISSING and RATE_STALE, a
//   held piece asks for confirmation (confirm_held), no Credit row, the saved figures replace the preview and a notice says where they differ, a new customer then a bill
//
// The pieces, the customers and the rates are written as root in the lane's container (their screens are other tasks') and everything a test made is taken out again, the
// bill-number counters it moved included (the API's invariant I5 would otherwise fail the volume case of hydrate.spec.ts).
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/billing.spec.ts

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
 * The pieces (all `W08-...`):
 *   S1 to S8   a small gold piece: 1.000 g, labour 300 (retail) 280 (semi) 260 (wholesale), no piroi: at 6,920 a gram a retail bill of 7,220
 *   G1 to G6   the worked example of the spec: 35.420 g, piroi 2.15, labour 353 / 340 / 320: a retail bill of 257,612
 *   P1, P2     a Per Piece piece at 1,200 (retail) 1,100 (semi) 1,000 (wholesale), piroi 10
 *   H1         a Reserved piece, H2 a piece in Repair (never billed)
 *   R1         22K-purity-less: a 20K gold piece (no daily rate), R2 a 24K gold piece (its rate is two days old)
 * The rates: 22K gold 6,920 today, 24K gold 7,500 two days ago. The customers: Priya (Retail, no PAN), Wholesale, Semi, and Advance (Retail, holding an advance of 3,000).
 */
const PIECES: Array<{
  key: string;
  design: 'D1' | 'D2' | 'D3' | 'D4';
  net: string;
  gross: string;
  piroi: string;
  labour: [string, string, string];
  status?: string;
}> = [
  ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({
    key: `S${n}`,
    design: 'D1' as const,
    net: '1.000',
    gross: '1.200',
    piroi: '0.00',
    labour: ['300.00', '280.00', '260.00'] as [string, string, string],
  })),
  ...[1, 2, 3, 4, 5, 6].map((n) => ({
    key: `G${n}`,
    design: 'D1' as const,
    net: '35.420',
    gross: '38.100',
    piroi: '2.15',
    labour: ['353.00', '340.00', '320.00'] as [string, string, string],
  })),
  ...[1, 2].map((n) => ({
    key: `P${n}`,
    design: 'D2' as const,
    net: '0.000',
    gross: '0.000',
    piroi: '10.00',
    labour: ['1200.00', '1100.00', '1000.00'] as [string, string, string],
  })),
  {
    key: 'H1',
    design: 'D1',
    net: '1.000',
    gross: '1.200',
    piroi: '0.00',
    labour: ['300.00', '280.00', '260.00'],
    status: 'Reserved',
  },
  {
    key: 'H2',
    design: 'D1',
    net: '1.000',
    gross: '1.200',
    piroi: '0.00',
    labour: ['300.00', '280.00', '260.00'],
    status: 'Repair',
  },
  {
    key: 'R1',
    design: 'D3',
    net: '1.000',
    gross: '1.200',
    piroi: '0.00',
    labour: ['300.00', '280.00', '260.00'],
  },
  {
    key: 'R2',
    design: 'D4',
    net: '1.000',
    gross: '1.200',
    piroi: '0.00',
    labour: ['300.00', '280.00', '260.00'],
  },
];

const sku = (key: string) => `W08-${key}`;
const designIds = { D1: randomUUID(), D2: randomUUID(), D3: randomUUID(), D4: randomUUID() };
const customerIds = {
  priya: randomUUID(),
  wholesale: randomUUID(),
  semi: randomUUID(),
  advance: randomUUID(),
};
const CUSTOMERS = {
  priya: 'W08 Priya',
  wholesale: 'W08 Wholesale',
  semi: 'W08 Semi',
  advance: 'W08 Advance',
};

function fixtureSql(): string {
  const category = `(SELECT id FROM categories WHERE name = 'Ring')`;
  const design = (key: keyof typeof designIds, material: string, purity: string, method: string) =>
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) VALUES ('${designIds[key]}', 'W08-${key}', 'W08 ${key}', ${category}, '${material}', '${purity}', '${method}');`;
  const piece = (p: (typeof PIECES)[number]) =>
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, piroi, labour_retail, labour_semi, labour_wholesale, status) VALUES ('${randomUUID()}', '${designIds[p.design]}', '${sku(p.key)}', 'W08BC-${p.key}', ${p.gross}, ${p.net}, ${p.piroi}, ${p.labour[0]}, ${p.labour[1]}, ${p.labour[2]}, '${p.status ?? 'In Stock'}');`;
  const customer = (key: keyof typeof customerIds, type: string, mobile: string) =>
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${customerIds[key]}', '${CUSTOMERS[key]}', '${mobile}', '${type}');`;
  return [
    design('D1', 'Gold', '22K', 'By Weight'),
    design('D2', 'Gold', '22K', 'Per Piece'),
    design('D3', 'Gold', '20K', 'By Weight'),
    design('D4', 'Gold', '24K', 'By Weight'),
    ...PIECES.map(piece),
    customer('priya', 'Retail', '9000000001'),
    customer('wholesale', 'Wholesale', '9000000002'),
    customer('semi', 'Semi-Wholesale', '9000000003'),
    customer('advance', 'Retail', '9000000004'),
    // the advance: 3,000 received and not allocated to any bill
    `INSERT INTO receipts (id, customer_id, kind, mode, amount, paid_on) VALUES ('${randomUUID()}', '${customerIds.advance}', 'money', 'UPI', 3000.00, '${kolkata()}');`,
    `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE id = '${customerIds.advance}';`,
    `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES (UUID(), 'Gold', '22K', 6920.00, '${kolkata()}');`,
    `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES (UUID(), 'Gold', '24K', 7500.00, '${kolkata(-2)}');`,
  ].join(' ');
}

/** Everything these tests made, gone again. The delete order follows the foreign keys; the bills are found by their lines, because the walk-in's bills belong to no customer of ours. */
async function cleanLane() {
  const bills = (
    await laneSql(`SELECT DISTINCT bill_id FROM bill_items WHERE sku_no LIKE 'W08-%'`)
  ).map((r) => `'${r[0]}'`);
  const billList = bills.length > 0 ? bills.join(', ') : "''";
  const receipts = (
    await laneSql(
      `SELECT DISTINCT receipt_id FROM receipt_allocations WHERE bill_id IN (${billList}) ` +
        `UNION SELECT id FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W08 %')`
    )
  ).map((r) => `'${r[0]}'`);
  const receiptList = receipts.length > 0 ? receipts.join(', ') : "''";
  await laneSql(
    `DELETE FROM receipt_allocations WHERE bill_id IN (${billList}) OR receipt_id IN (${receiptList}); ` +
      `DELETE FROM receipts WHERE id IN (${receiptList}); ` +
      `DELETE FROM bill_items WHERE bill_id IN (${billList}); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W08-%'; ` +
      `DELETE FROM bills WHERE id IN (${billList}); ` +
      `DELETE FROM designs WHERE design_no LIKE 'W08-%'; ` +
      `DELETE FROM customers WHERE name LIKE 'W08 %'; ` +
      `DELETE FROM daily_rates WHERE (material = 'Gold' AND purity IN ('22K', '24K'));`
  );
  // X1 makes a row of sys_counters for the series of its bill numbers (and moves it), and deleting the bills does not take it away. The API's seed-volume tool, which the volume case of
  // hydrate.spec.ts runs, inserts that row itself and then checks invariant I5 (a counter that moved with no number issued above its seed is a fault): a series with no bill left is
  // removed again, as a fresh lane has it.
  await laneSql(
    `DELETE FROM sys_counters WHERE series LIKE 'bill:%' AND NOT EXISTS (` +
      `SELECT 1 FROM bills b WHERE b.import_batch_id IS NULL AND sys_counters.series = CONCAT('bill:', ` +
      `SUBSTRING(b.bill_no, 1, CHAR_LENGTH(b.bill_no) - CHAR_LENGTH(SUBSTRING_INDEX(b.bill_no, '-', -2)) - 1), ` +
      `':', SUBSTRING_INDEX(SUBSTRING_INDEX(b.bill_no, '-', -2), '-', 1)))`
  );
}

/** The bills these tests made: number, customer's name, grand total, status. */
const billsMade = async () =>
  laneSql(
    `SELECT b.bill_no, c.name, b.grand_total, b.status FROM bills b JOIN customers c ON c.id = b.customer_id ` +
      `WHERE b.id IN (SELECT bill_id FROM bill_items WHERE sku_no LIKE 'W08-%') ORDER BY b.created_at`
  );
const countBills = async () => (await billsMade()).length;
const pieceStatus = async (key: string) =>
  (await laneSql(`SELECT status FROM skus WHERE sku_no = '${sku(key)}'`))[0]?.[0];

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();
const KEY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The CORS headers a made-up answer needs so that the browser hands it to the page. */
const corsHeaders = () => ({
  'access-control-allow-origin': e2eLane().webOrigin,
  'access-control-allow-credentials': 'true',
});
const PROXY_PAGE = '<html><body><h1>502 Bad Gateway</h1></body></html>';

/** Opens a page of the application as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, target = '/billing-pos') {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
  await expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible();
}

async function addPiece(page: Page, key: string) {
  await page.getByPlaceholder('Enter SKU number or scan barcode...').fill(sku(key));
  await page.keyboard.press('Enter');
  await expect(page.locator(`tr[data-sku="${sku(key)}"]`)).toBeVisible();
}

async function chooseCustomer(page: Page, name: string) {
  await page.getByPlaceholder('Search by mobile or name...').fill(name);
  await page.getByRole('button', { name: new RegExp(name) }).click();
  await expect(page.getByRole('button', { name: 'Change' })).toBeVisible();
}

const save = (page: Page) => page.getByTestId('save-bill');
const saved = (page: Page) => page.getByTestId('bill-saved');
const saveError = (page: Page) => page.getByTestId('bill-save-error');
const banner = (page: Page) => page.getByTestId('connection-banner');
const grandTotal = (page: Page) => page.getByTestId('grand-total');
const lineInput = (page: Page, label: string, key: string) =>
  page.getByLabel(`${label} ${sku(key)}`);

/** The requests the page makes to X1 and the answers it gets. */
function billCalls(page: Page) {
  const { apiUrl } = e2eLane();
  const requests: Request[] = [];
  const responses: Response[] = [];
  const isBill = (url: string) => url === `${apiUrl}/v1/bills`;
  page.on('request', (request) => {
    if (request.method() === 'POST' && isBill(request.url())) requests.push(request);
  });
  page.on('response', (response) => {
    if (response.request().method() === 'POST' && isBill(response.url())) responses.push(response);
  });
  return { requests, responses };
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

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

// ------------------------------------------------------------------------------------------------ T-E06

test.describe('T-E06 (C5 (b), C6, L5): one bill for one user action', () => {
  test.describe.configure({ timeout: 120_000 });

  test('a double click on Save creates ONE bill, from one request with one key; the bill shows as saved only after the API has answered', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = billCalls(page);
    // a slow server, so that the second click lands while the first call is on its way
    await page.route(`${apiUrl}/v1/bills`, async (route) => {
      if (route.request().method() === 'POST') await sleep(1500);
      await route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await save(page).dblclick();
    await expect(save(page)).toContainText('Saving Estimate');
    await expect(save(page)).toBeDisabled(); // C6
    await expect(saved(page)).toHaveCount(0); // a bill never shows saved before the API says so
    await expect(saved(page)).toBeVisible({ timeout: 20_000 });
    await sleep(1500);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers()['idempotency-key']).toMatch(KEY);
    expect(await countBills()).toBe(1);
    expect(await pieceStatus('S1')).toBe('Sold');
  });

  test('the answer is lost after the server saved: Save again sends the SAME key, the server replays, and there is still ONE bill', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests, responses } = billCalls(page);
    let dropped = false;
    await page.route(`${apiUrl}/v1/bills`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (!dropped) {
        dropped = true;
        await route.fetch(); // the server gets it, saves it and answers ...
        return route.abort('connectionreset'); // ... and the answer never reaches the page
      }
      return route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await save(page).click();
    await expect(saveError(page)).toContainText('Could not confirm that this was saved', {
      timeout: 30_000,
    });
    await expect(saveError(page)).toContainText('Press Save again');
    await expect(saved(page)).toHaveCount(0); // the screen does not know, and does not say saved
    expect(await countBills()).toBe(1); // it was saved; the screen did not know

    await expect(save(page)).toBeEnabled();
    await save(page).click(); // the same action again
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    expect(requests.length).toBeGreaterThanOrEqual(2);
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toMatch(KEY);
    const last = responses[responses.length - 1];
    expect(last.status()).toBe(201);
    expect(last.headers()['idempotent-replay']).toBe('true');
    expect(await countBills()).toBe(1);
  });

  test('a bill that was changed after a lost answer is another action: it gets a key of its own', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests } = billCalls(page);
    let dropped = false;
    await page.route(`${apiUrl}/v1/bills`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (!dropped) {
        dropped = true;
        return route.abort('connectionreset'); // nothing reaches the server
      }
      return route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await save(page).click();
    await expect(saveError(page)).toContainText('Could not confirm that this was saved', {
      timeout: 30_000,
    });
    await lineInput(page, 'Piroi', 'S1').fill('5'); // another bill
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    const keys = requests.map((r) => r.headers()['idempotency-key']);
    expect(keys).toHaveLength(2);
    expect(keys[1]).toMatch(KEY);
    expect(keys[1]).not.toBe(keys[0]);
    expect(await countBills()).toBe(1);
  });

  test('the same bill in two tabs is saved once: one tab shows the bill, the other names the piece', async ({
    page,
    context,
  }) => {
    await open(page, e2eLogin('owner'));
    const second = await context.newPage();
    const { apiUrl } = e2eLane();
    second.on('request', (request) => {
      if (request.url().startsWith(apiUrl)) noteApiCall();
    });
    await second.goto('/billing-pos');
    await expect(second.getByRole('heading', { name: 'New Estimate' })).toBeVisible({
      timeout: 60_000,
    });
    await addPiece(page, 'S1');
    await addPiece(second, 'S1');
    await Promise.all([save(page).click(), save(second).click()]);
    await expect
      .poll(async () => (await saved(page).count()) + (await saved(second).count()), {
        timeout: 30_000,
      })
      .toBe(1);
    const loser = (await saved(page).count()) === 1 ? second : page;
    await expect(saveError(loser)).toContainText(sku('S1'));
    await expect(saveError(loser)).toContainText('Nothing was changed');
    expect(await countBills()).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ T-C06

test.describe('T-C06 (screen half; K2): two billers saving the same piece', () => {
  test.describe.configure({ timeout: 150_000 });

  test('one success and one message that names the piece; the piece is marked on the line and the bill can be saved without it', async ({
    browser,
  }) => {
    const { apiUrl } = e2eLane();
    const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
    try {
      const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
      for (const p of [a, b])
        p.on('request', (request) => {
          if (request.url().startsWith(apiUrl)) noteApiCall();
        });
      await open(a, e2eLogin('biller'));
      await open(b, e2eLogin('owner'));
      for (const p of [a, b]) {
        await addPiece(p, 'S2');
        await addPiece(p, 'S3');
      }
      await Promise.all([save(a).click(), save(b).click()]);
      await expect
        .poll(async () => (await saved(a).count()) + (await saved(b).count()), { timeout: 30_000 })
        .toBe(1);
      const loser = (await saved(a).count()) === 1 ? b : a;
      await expect(saveError(loser)).toContainText(sku('S2'));
      await expect(saveError(loser)).toContainText(sku('S3'));
      await expect(saveError(loser)).toContainText('cannot be billed');
      await expect(saveError(loser)).toContainText('Nothing was changed');
      await expect(loser.getByTestId('piece-refused')).toHaveCount(2);
      expect(await countBills()).toBe(1);

      // take them off and the screen is back to what it was: a bill with a piece the other person did not sell
      await loser.getByRole('button', { name: `Remove ${sku('S2')}` }).click();
      await loser.getByRole('button', { name: `Remove ${sku('S3')}` }).click();
      await addPiece(loser, 'S4');
      await expect(loser.getByTestId('piece-refused')).toHaveCount(0);
      await save(loser).click();
      await expect(saved(loser)).toBeVisible({ timeout: 30_000 });
      expect(await countBills()).toBe(2);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });
});

// ------------------------------------------------------------------------------------------------ T-E03

test.describe('T-E03 (clause; C7, L5): offline, and "Waking up…" with a money call retried', () => {
  test.describe.configure({ timeout: 150_000 });

  test('with the network cut the banner appears and Save is disabled; both clear after reconnect', async ({
    page,
    context,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await expect(save(page)).toBeEnabled();
    await context.setOffline(true);
    await expect(banner(page)).toHaveText('Offline: changes cannot be saved', { timeout: 20_000 });
    await expect(save(page)).toBeDisabled();
    await expect(save(page)).toHaveAttribute('title', 'Offline: changes cannot be saved');
    // the screen still reads from memory
    await expect(page.locator(`tr[data-sku="${sku('S1')}"]`)).toBeVisible();
    await context.setOffline(false);
    await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(save(page)).toBeEnabled();
    expect(await countBills()).toBe(0);
  });

  test('a gateway error before the API saw the call, then a normal reply: "Waking up…", the retry carries the same key, and the bill is saved once', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests, responses } = billCalls(page);
    let bad = 0;
    await page.route(`${apiUrl}/v1/bills`, async (route) => {
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
    await addPiece(page, 'S1');
    await save(page).click();
    await expect(banner(page)).toHaveText('Waking up…', { timeout: 15_000 });
    await expect(save(page)).toBeDisabled();
    await expect(saved(page)).toBeVisible({ timeout: 40_000 });
    await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
    expect(bad).toBe(2);
    expect(requests).toHaveLength(3);
    expect(new Set(requests.map((r) => r.headers()['idempotency-key'])).size).toBe(1);
    expect(responses[responses.length - 1].status()).toBe(201);
    expect(await countBills()).toBe(1);
  });

  test("the bill WAS saved and then the proxy answered 502: the retry with the same key is answered from the server's store, still one bill", async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const { requests, responses } = billCalls(page);
    let bad = 0;
    await page.route(`${apiUrl}/v1/bills`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (bad < 1) {
        bad += 1;
        await route.fetch(); // the API saves it ...
        return route.fulfill({
          // ... and a proxy in front of it answers with its page
          status: 502,
          contentType: 'text/html',
          headers: corsHeaders(),
          body: PROXY_PAGE,
        });
      }
      return route.fallback();
    });
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await save(page).click();
    await expect(banner(page)).toHaveText('Waking up…', { timeout: 15_000 });
    await expect(saved(page)).toBeVisible({ timeout: 40_000 });
    expect(requests).toHaveLength(2);
    expect(requests[1].headers()['idempotency-key']).toBe(requests[0].headers()['idempotency-key']);
    expect(responses[responses.length - 1].headers()['idempotent-replay']).toBe('true');
    expect(await countBills()).toBe(1);
  });
});

// ------------------------------------------------------------------------------------------------ T-A14

test.describe('T-A14 (screen half; C12): Save on bills is off when the API prices with another pricing.ts', () => {
  test.describe.configure({ timeout: 120_000 });

  test("pricing_sha256 of `me` differs from the build's own: a banner, Save disabled; with the right hash it is enabled", async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    await page.route(`${apiUrl}/v1/auth/me`, async (route) => {
      const response = await route.fetch();
      const body = await response.json();
      await route.fulfill({ response, json: { ...body, pricing_sha256: 'f'.repeat(64) } });
    });
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await expect(page.getByTestId('pricing-banner')).toContainText(
      'do not work out bills the same way'
    );
    await expect(save(page)).toBeDisabled();
    await expect(save(page)).toHaveAttribute('title', /do not work out bills the same way/);
    // the rest of the screen still works: the live total is there, other Save controls are not affected
    await expect(grandTotal(page)).toHaveText('₹7,220');

    // negative control: the same screen with the API's real hash
    await page.unroute(`${apiUrl}/v1/auth/me`);
    await page.reload();
    await expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByTestId('pricing-banner')).toHaveCount(0);
    await addPiece(page, 'S1');
    await expect(save(page)).toBeEnabled();
  });
});

// ------------------------------------------------------------------------------------------------ T-A03, T-A01

test.describe('T-A03 (UNIT half on the screen; R1, R9): choosing a customer sets the sale type and the labour rate follows', () => {
  test.describe.configure({ timeout: 120_000 });

  test('Wholesale, Semi-Wholesale and Retail customers; a rate the person typed is kept until the type changes', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await expect(lineInput(page, 'Labour rate', 'S1')).toHaveValue('300.00');

    await chooseCustomer(page, CUSTOMERS.wholesale);
    await expect(
      page.getByRole('button', { name: 'Wholesale', pressed: true, exact: true })
    ).toBeVisible();
    await expect(lineInput(page, 'Labour rate', 'S1')).toHaveValue('260.00');
    await expect(page.getByTestId('item-total')).toHaveText('₹7,180.00'); // 6,920 + 260

    await page.getByRole('button', { name: 'Change' }).click();
    await chooseCustomer(page, CUSTOMERS.semi);
    await expect(
      page.getByRole('button', { name: 'Semi-Wholesale', pressed: true, exact: true })
    ).toBeVisible();
    await expect(lineInput(page, 'Labour rate', 'S1')).toHaveValue('280.00');

    // the biller may change the type by hand; the labour rate follows that too
    await page.getByRole('button', { name: 'Retail', pressed: false, exact: true }).click();
    await expect(lineInput(page, 'Labour rate', 'S1')).toHaveValue('300.00');
    await lineInput(page, 'Labour rate', 'S1').fill('310');
    await expect(page.getByTestId('item-total')).toHaveText('₹7,230.00');
    // choosing a customer of the SAME type leaves a typed rate alone
    await page.getByRole('button', { name: 'Change' }).click();
    await chooseCustomer(page, CUSTOMERS.priya); // Retail
    await expect(lineInput(page, 'Labour rate', 'S1')).toHaveValue('310');
  });

  test('a Per Piece line is the piece price of the sale type times the quantity, and the quantity is saved on the bill (R5, R6)', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'P1');
    await expect(lineInput(page, 'Metal rate', 'P1')).toHaveValue('1200.00');
    await lineInput(page, 'Quantity', 'P1').fill('3');
    await expect(page.getByTestId('item-total')).toHaveText('₹3,610.00'); // 3 x 1,200 + piroi 10 once
    await chooseCustomer(page, CUSTOMERS.wholesale);
    await expect(lineInput(page, 'Metal rate', 'P1')).toHaveValue('1000.00');
    await expect(page.getByTestId('item-total')).toHaveText('₹3,010.00');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    expect(
      (
        await laneSql(`SELECT quantity, item_total FROM bill_items WHERE sku_no = '${sku('P1')}'`)
      )[0]
    ).toEqual(['3', '3010.00']);
  });
});

test.describe('T-A01 (screen half; C12): the worked example, and the saved figure replaces the preview', () => {
  test.describe.configure({ timeout: 120_000 });

  test('35.42 g at 6,920, labour 353, piroi 2.15 saves a bill of 257,612, and the preview equals the saved figure', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await chooseCustomer(page, CUSTOMERS.priya);
    await addPiece(page, 'G1');
    // the defaults: the day's rate of 22K gold, the retail labour of the piece, its piroi
    await expect(lineInput(page, 'Metal rate', 'G1')).toHaveValue('6920.00');
    await expect(lineInput(page, 'Labour rate', 'G1')).toHaveValue('353.00');
    await expect(lineInput(page, 'Piroi', 'G1')).toHaveValue('2.15');
    // the preview is pricing.ts
    await expect(page.getByTestId('item-total')).toHaveText('₹2,57,611.81');
    await expect(grandTotal(page)).toHaveText('₹2,57,612');
    await expect(grandTotal(page)).toHaveAttribute('data-source', 'preview');
    await expect(page.getByTestId('round-off')).toHaveText('+0.19');

    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    // the saved figure is the API's, and it is the preview's
    await expect(grandTotal(page)).toHaveAttribute('data-source', 'saved');
    await expect(grandTotal(page)).toHaveText('₹2,57,612');
    await expect(page.getByTestId('item-total')).toHaveText('₹2,57,611.81');
    await expect(page.getByTestId('figures-differ')).toHaveCount(0);
    await expect(page.getByTestId('saved-bill-no')).toHaveText(/^JV-/);
    expect(
      (
        await laneSql(
          `SELECT b.grand_total, b.subtotal, b.round_off, i.metal_amount, i.labour_amount, i.item_total ` +
            `FROM bills b JOIN bill_items i ON i.bill_id = b.id WHERE i.sku_no = '${sku('G1')}'`
        )
      )[0]
    ).toEqual(['257612.00', '257611.81', '0.19', '245106.40', '12503.26', '257611.81']);
    // the pieces and the bill's own figures come with the poll that follows the write: View Estimate opens
    await expect(page.getByRole('link', { name: 'View Estimate' })).toBeVisible({
      timeout: 20_000,
    });
  });

  test('when the API answers with other figures the screen shows the SAVED ones and a notice says where they differ', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    await page.route(`${apiUrl}/v1/bills`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      const response = await route.fetch();
      const body = await response.json();
      body.bill.grand_total = '7221.00';
      body.bill.round_off = '1.00';
      body.items[0].item_total = '7220.50';
      await route.fulfill({ response, json: body });
    });
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await expect(grandTotal(page)).toHaveText('₹7,220');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(grandTotal(page)).toHaveAttribute('data-source', 'saved');
    await expect(grandTotal(page)).toHaveText('₹7,221');
    await expect(page.getByTestId('item-total')).toHaveText('₹7,220.50');
    const notice = page.getByTestId('figures-differ');
    await expect(notice).toContainText('not the same as the preview');
    await expect(notice).toContainText('Grand total: ₹7,221.00 saved, ₹7,220.00 in the preview');
    await expect(notice).toContainText(`${sku('S1')}: ₹7,220.50 saved, ₹7,220.00 in the preview`);
  });
});

// ------------------------------------------------------------------------------------------------ the messages and prompts

test.describe('C13, Z1 to Z3, Y2, R2, R10: what the screen says', () => {
  test.describe.configure({ timeout: 150_000 });

  test('JV_CASH_LIMIT for a biller: the owner enters this payment; nothing is saved and there is no way round it on this screen', async ({
    page,
  }) => {
    await open(page, e2eLogin('biller'));
    await chooseCustomer(page, CUSTOMERS.priya);
    await addPiece(page, 'G2');
    await page.getByLabel('Payment mode 1').selectOption('Cash');
    await page.getByLabel('Payment amount 1').fill('250000');
    await save(page).click();
    await expect(saveError(page)).toContainText('would reach the limit of ₹2,00,000');
    await expect(saveError(page)).toContainText('The owner enters this payment');
    await expect(saveError(page)).toContainText('Nothing was changed');
    await expect(page.getByTestId('cash-reason')).toHaveCount(0);
    expect(await countBills()).toBe(0);
    // part of it by UPI is under the limit: the same screen saves it
    await page.getByLabel('Payment amount 1').fill('150000');
    await page.getByRole('button', { name: '+ Add Mode' }).click();
    await page.getByLabel('Payment mode 2').selectOption('UPI');
    await page.getByLabel('Payment amount 2').fill('100000');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    expect(await countBills()).toBe(1);
  });

  test('JV_CASH_LIMIT for the owner: a field for the reason (10 characters or more) appears, and the reason is saved on the bill', async ({
    page,
  }) => {
    const { requests } = billCalls(page);
    await open(page, e2eLogin('owner'));
    await chooseCustomer(page, CUSTOMERS.priya);
    await addPiece(page, 'G3');
    await page.getByLabel('Payment mode 1').selectOption('Cash');
    await page.getByLabel('Payment amount 1').fill('250000');
    await save(page).click();
    await expect(saveError(page)).toContainText('would reach the limit of ₹2,00,000');
    await expect(saveError(page)).toContainText('Give a reason of at least 10 characters');
    const reason = page.getByTestId('cash-reason');
    await expect(reason).toBeVisible();
    expect(requests).toHaveLength(1);
    await reason.fill('too short'); // 9 characters: refused on the screen, no call
    await save(page).click();
    await expect(saveError(page)).toContainText('10 to 500 characters');
    expect(requests).toHaveLength(1);
    await reason.fill('Wedding order, known family, paid at the counter');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    expect(requests).toHaveLength(2);
    expect(requests[1].headers()['idempotency-key']).not.toBe(
      requests[0].headers()['idempotency-key']
    ); // another body: another action
    expect(
      (
        await laneSql(
          `SELECT cash_override_reason FROM bills WHERE id IN (SELECT bill_id FROM bill_items WHERE sku_no = '${sku('G3')}')`
        )
      )[0][0]
    ).toBe('Wedding order, known family, paid at the counter');
  });

  test('JV_OVERPAYMENT: both figures are named, nothing is saved, and lowering the payment saves the bill', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S4');
    await page.getByLabel('Payment amount 1').fill('50000');
    await expect(page.getByTestId('overpaid')).toBeVisible();
    await save(page).click();
    await expect(saveError(page)).toContainText(
      'The payments add up to ₹50,000, which is more than the bill of ₹7,220'
    );
    await expect(saveError(page)).toContainText('Nothing was changed');
    expect(await countBills()).toBe(0);
    await page.getByLabel('Payment amount 1').fill('5000');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('received')).toHaveText('₹5,000');
    await expect(page.getByTestId('pending')).toHaveText('₹2,220');
    expect(
      (
        await laneSql(
          `SELECT COUNT(*) FROM receipts WHERE amount = 5000.00 AND customer_id = '00000000-0000-4000-8000-000000000001'`
        )
      )[0][0]
    ).toBe('1');
  });

  test('"Advance adjusted: ₹X" is the advance the customer held, applied to the new bill by the API', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await chooseCustomer(page, CUSTOMERS.advance);
    await addPiece(page, 'S6');
    await expect(grandTotal(page)).toHaveText('₹7,220');
    await expect(page.getByTestId('advance-adjusted')).toHaveCount(0);
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('advance-adjusted')).toHaveText('Advance adjusted: ₹3,000');
    await expect(page.getByTestId('received')).toHaveText('₹0');
    await expect(page.getByTestId('pending')).toHaveText('₹4,220');
  });

  test('PAN_MISSING: a bill of 2,00,000 or more for a customer with no PAN is saved, and the screen asks for the PAN, checks it, and saves it on the customer', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await chooseCustomer(page, CUSTOMERS.priya);
    await addPiece(page, 'G4');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    const prompt = page.getByTestId('pan-prompt');
    await expect(prompt).toContainText('PAN needed');
    await expect(prompt).toContainText(CUSTOMERS.priya);
    await page.getByLabel('PAN', { exact: true }).fill('abcde 1234');
    await prompt.getByRole('button', { name: 'Save PAN' }).click();
    await expect(page.getByTestId('pan-error')).toContainText('ten characters');
    await page.getByLabel('PAN', { exact: true }).fill('abcde 1234f');
    await prompt.getByRole('button', { name: 'Save PAN' }).click();
    await expect(page.getByTestId('pan-saved')).toContainText(CUSTOMERS.priya);
    await expect(prompt).toHaveCount(0);
    expect(
      (await laneSql(`SELECT pan FROM customers WHERE name = '${CUSTOMERS.priya}'`))[0][0]
    ).toBe('ABCDE1234F');
    // the bill is still the one that was saved
    expect(await countBills()).toBe(1);
  });

  test('the PAN prompt can be skipped: a buyer may give a declaration on paper, and the bill is saved either way', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await chooseCustomer(page, CUSTOMERS.priya);
    await addPiece(page, 'G5');
    await save(page).click();
    await expect(page.getByTestId('pan-prompt')).toBeVisible({ timeout: 30_000 });
    await page.getByRole('button', { name: 'Skip' }).click();
    await expect(page.getByTestId('pan-prompt')).toHaveCount(0);
    await expect(saved(page)).toBeVisible();
    expect(
      (await laneSql(`SELECT pan FROM customers WHERE name = '${CUSTOMERS.priya}'`))[0][0]
    ).toBe('NULL');
  });

  test('a bill under the threshold asks for no PAN; the walk-in at the threshold is told to select or create the customer', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'G6'); // 257,612 for the walk-in
    await save(page).click();
    await expect(saveError(page)).toContainText('Select or create the customer');
    await expect(saveError(page)).toContainText('Nothing was changed');
    expect(await countBills()).toBe(0);
    await page.getByRole('button', { name: `Remove ${sku('G6')}` }).click();
    await addPiece(page, 'S7');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pan-prompt')).toHaveCount(0);
  });

  test('there is no Credit row; a bill left unpaid has no receipt', async ({ page }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    const modes = await page.getByLabel('Payment mode 1').locator('option').allTextContents();
    expect(modes).toEqual(['Cash', 'UPI', 'Card', 'Bank Transfer', 'Other']);
    await save(page).click(); // nothing paid
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('pending')).toHaveText('₹7,220');
    expect(
      (
        await laneSql(
          `SELECT COUNT(*) FROM receipt_allocations WHERE bill_id IN (SELECT bill_id FROM bill_items WHERE sku_no = '${sku('S1')}')`
        )
      )[0][0]
    ).toBe('0');
  });

  test('RATE_MISSING: no daily rate for the purity asks for one and Save waits; the API still warns on the saved bill', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'R1'); // 20K gold: no rate
    await expect(lineInput(page, 'Metal rate', 'R1')).toHaveValue('');
    await expect(page.getByTestId('rate-note')).toContainText(
      'No daily rate for Gold 20K: enter one'
    );
    await expect(save(page)).toBeDisabled();
    await expect(page.getByTestId('line-error')).toContainText('No daily rate is set for Gold 20K');
    await lineInput(page, 'Metal rate', 'R1').fill('6000');
    await expect(save(page)).toBeEnabled();
    await expect(grandTotal(page)).toHaveText('₹6,300'); // 6,000 + labour 300
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-missing')).toBeVisible();
  });

  test('RATE_STALE: the latest rate is older than the bill date, the line says so, and the API warns on the saved bill', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'R2'); // 24K gold: 7,500 from two days ago
    await expect(lineInput(page, 'Metal rate', 'R2')).toHaveValue('7500.00');
    await expect(page.getByTestId('rate-note')).toContainText('older than the bill date');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('warning-rate-stale')).toBeVisible();
    await expect(page.getByTestId('warning-rate-missing')).toHaveCount(0);
  });

  test('a Reserved piece asks for confirmation (confirm_held); a piece in Repair is never billed', async ({
    page,
  }) => {
    const { requests } = billCalls(page);
    await open(page, e2eLogin('owner'));
    const scan = page.getByPlaceholder('Enter SKU number or scan barcode...');
    await scan.fill(sku('H2'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scan-refused')).toContainText(
      `${sku('H2')} is Repair and cannot be billed`
    );
    await expect(page.locator(`tr[data-sku="${sku('H2')}"]`)).toHaveCount(0);

    await scan.fill(sku('H1'));
    await page.keyboard.press('Enter');
    const ask = page.getByTestId('scan-confirm');
    await expect(ask).toContainText(`${sku('H1')} is Reserved`);
    await expect(page.locator(`tr[data-sku="${sku('H1')}"]`)).toHaveCount(0); // not added yet
    await ask.getByRole('button', { name: "Don't add" }).click();
    await expect(page.locator(`tr[data-sku="${sku('H1')}"]`)).toHaveCount(0);

    await scan.fill(sku('H1'));
    await page.keyboard.press('Enter');
    await page.getByTestId('scan-confirm').getByRole('button', { name: 'Bill it anyway' }).click();
    await expect(page.locator(`tr[data-sku="${sku('H1')}"]`)).toBeVisible();
    await expect(page.getByTestId('held-badge')).toContainText('Reserved');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    expect(requests[0].postDataJSON().confirm_held).toHaveLength(1);
    expect(await pieceStatus('H1')).toBe('Sold');
    expect(await pieceStatus('H2')).toBe('Repair');
  });

  test('after the bill is saved the piece shows Sold (the poll after the write brings it), and New Sale starts afresh', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S1');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    // the bill's figures and the piece come in the same poll: once the estimate can be opened the piece is Sold in memory
    await expect(page.getByRole('link', { name: 'View Estimate' })).toBeVisible({
      timeout: 20_000,
    });
    await page.getByRole('button', { name: 'New Sale' }).last().click();
    await expect(saved(page)).toHaveCount(0);
    await expect(page.getByText('No items added yet')).toBeVisible();
    await expect(save(page)).toBeDisabled();
    await page.getByPlaceholder('Enter SKU number or scan barcode...').fill(sku('S1'));
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('scan-refused')).toContainText('already sold');
    await expect(page.locator(`tr[data-sku="${sku('S1')}"]`)).toHaveCount(0);
  });

  test('Discard starts afresh: the items, the message of a refused save and the payments are gone', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await addPiece(page, 'S4');
    await page.getByLabel('Payment amount 1').fill('50000');
    await save(page).click();
    await expect(saveError(page)).toContainText('more than the bill');
    await page.getByRole('button', { name: 'Discard' }).click();
    await expect(saveError(page)).toHaveCount(0);
    await expect(page.getByText('No items added yet')).toBeVisible();
    await expect(page.getByLabel('Payment amount 1')).toHaveValue('');
    expect(await countBills()).toBe(0);
  });

  test('a new customer then a bill: X6 and X1 each with a key of their own, the customer is selected, and the sale type follows', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    const keys: string[] = [];
    page.on('request', (request) => {
      if (
        request.method() === 'POST' &&
        [`${apiUrl}/v1/customers`, `${apiUrl}/v1/bills`].includes(request.url())
      )
        keys.push(`${request.url().split('/').pop()}:${request.headers()['idempotency-key']}`);
    });
    await open(page, e2eLogin('owner'));
    await page.getByRole('button', { name: 'Add Customer' }).click();
    await page.getByPlaceholder('Customer name').fill('W08 Fresh');
    await page.getByPlaceholder('Mobile number').fill('9000000099');
    await page.locator('select').first().selectOption('Wholesale');
    await page.getByRole('button', { name: 'Save Customer' }).click();
    await expect(page.getByRole('button', { name: 'Change' })).toBeVisible({ timeout: 20_000 });
    await expect(
      page.getByRole('button', { name: 'Wholesale', pressed: true, exact: true })
    ).toBeVisible();
    await addPiece(page, 'S8');
    await expect(lineInput(page, 'Labour rate', 'S8')).toHaveValue('260.00');
    await save(page).click();
    await expect(saved(page)).toBeVisible({ timeout: 30_000 });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^customers:[0-9a-f-]{36}$/);
    expect(keys[1]).toMatch(/^bills:[0-9a-f-]{36}$/);
    expect(keys[0].split(':')[1]).not.toBe(keys[1].split(':')[1]);
    expect((await billsMade())[0].slice(1)).toEqual(['W08 Fresh', '7180.00', 'active']);
  });
});
