import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// The three clean-ups of 19 October (spec C8, U8, T-E05; the screens of WEB06 and WEB10), in a real browser against the real API of a lane:
//
//   1  the owner-only original weight on the design page: the button and the column are the OWNER's. A biller and a staff user have neither, and the owner's weight is nowhere on their page.
//   2  the design page and the scan screen show the design and the piece that the address or the scanned code names, read from the cache: an address with no design, or with one that is not in the
//      stock, says so and shows no other design; "View Design" opens the design of the piece, not the newest design; no sample text (the made-up design SET-00572, "Quick demo scans").
//   3  no `jaishri.*` key is read or written during a session, the hidden Order Book's included (its store kept orders in `jaishri.orders.v1`); local storage, session storage and IndexedDB hold
//      nothing of the application's.
//
// The rows are written as root in the lane's container: two designs, three pieces (one of them Sold) and the owner's weights of two of them. They are relative to the clock (the newest design is
// the one an address with no design used to fall back to), and everything the tests made is taken out again.
//
// Run: E2E=1 LANE=a JV_LANE_NAMESPACE=c1 JV_LANE_PORT_BASE=34300 PORT=5090 JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/role-and-detail.spec.ts

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

/** The owner's weights: no other figure of the pages is one of these. */
const OWNER_WEIGHT = { a1: '7.123', b1: '8.001' };
const ids = {
  customer: randomUUID(),
  bill: randomUUID(),
  designA: randomUUID(),
  designB: randomUUID(),
  a1: randomUUID(),
  a2: randomUUID(),
  b1: randomUUID(),
};
const PREFIX = 'CL19';
const DESIGN_A = { no: `${PREFIX}-A`, name: `${PREFIX} alpha ring` };
const DESIGN_B = { no: `${PREFIX}-B`, name: `${PREFIX} beta chain` };
const PIECE = {
  a1: { no: `${PREFIX}-A-1`, barcode: `${PREFIX}BA1` },
  a2: { no: `${PREFIX}-A-2`, barcode: `${PREFIX}BA2` }, // Sold
  b1: { no: `${PREFIX}-B-1`, barcode: `${PREFIX}BB1` },
};

function kolkataDate(): string {
  return new Date(Date.now() + 19_800_000).toISOString().slice(0, 10);
}

function fixtureSql(): string {
  const design = (id: string, no: string, name: string, hoursAgo: number) =>
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method, created_at) ` +
    `SELECT '${id}', '${no}', '${name}', id, 'Gold', '22K', 'By Weight', UTC_TIMESTAMP(6) - INTERVAL ${hoursAgo} HOUR FROM categories ORDER BY name LIMIT 1;`;
  const piece = (
    id: string,
    designId: string,
    p: { no: string; barcode: string },
    gross: string,
    net: string,
    status: string,
    soldBill: string | null = null
  ) =>
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status, sold_bill_id) VALUES ` +
    `('${id}', '${designId}', '${p.no}', '${p.barcode}', ${gross}, ${net}, '${status}', ${soldBill ? `'${soldBill}'` : 'NULL'});`;
  return [
    // B is the newest design: the one the page used to show whenever the address named no design, or one that is not there
    // a piece can be Sold only on a bill (chk_skus_sold): a bill of one customer, with no lines, written as root
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${ids.customer}', '${PREFIX} Customer', '9000190001', 'Retail');`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, discount, grand_total, created_at) VALUES ` +
      `('${ids.bill}', '${PREFIX}-0001', '${ids.customer}', '${kolkataDate()}', 'Retail', 1.00, 0.00, 1.00, UTC_TIMESTAMP(6) - INTERVAL 5 MINUTE);`,
    design(ids.designA, DESIGN_A.no, DESIGN_A.name, 2),
    design(ids.designB, DESIGN_B.no, DESIGN_B.name, 1),
    piece(ids.a1, ids.designA, PIECE.a1, '12.000', '11.500', 'In Stock'),
    piece(ids.a2, ids.designA, PIECE.a2, '13.000', '12.500', 'Sold', ids.bill),
    piece(ids.b1, ids.designB, PIECE.b1, '14.000', '13.500', 'In Stock'),
    `INSERT INTO sku_private (sku_id, original_net_weight) VALUES ('${ids.a1}', ${OWNER_WEIGHT.a1}), ('${ids.b1}', ${OWNER_WEIGHT.b1});`,
    // the one line of that bill, for the Sold piece
    `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
      `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) VALUES ` +
      `('${randomUUID()}', '${ids.bill}', 1, '${ids.a2}', '${DESIGN_A.no}', '${PIECE.a2.no}', 'Ring', 'Gold', '22K', 'By Weight', 13.000, 12.500, 1, ` +
      `1.00, 0.00, 0.00, 0.00, 0.00, 1.00, 0.000, 1.00, 1.00, NULL);`,
  ].join(' ');
}

/** Everything these tests made, gone again. */
async function cleanLane() {
  await laneSql(
    `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE bill_no LIKE '${PREFIX}-%'); ` +
      `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE sku_no LIKE '${PREFIX}-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE '${PREFIX}-%'; DELETE FROM designs WHERE design_no LIKE '${PREFIX}-%'; ` +
      `DELETE FROM bills WHERE bill_no LIKE '${PREFIX}-%'; DELETE FROM customers WHERE name LIKE '${PREFIX} %';`
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

/** Everything JavaScript can read that the browser keeps: both Web Storage areas and the names of the IndexedDB databases. */
async function browserStorage(page: Page) {
  return page.evaluate(async () => {
    const dump = (store: Storage) => {
      const entries: Record<string, string> = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) as string;
        entries[key] = store.getItem(key) ?? '';
      }
      return entries;
    };
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return {
      local: dump(window.localStorage),
      session: dump(window.sessionStorage),
      databases: databases.map((d) => d.name ?? ''),
    };
  });
}

// The API lets one person make 300 calls a minute (A13) and makes a login wait after five in 15 minutes; every test of this file signs in, so each waits for room in the minute and starts from
// clean login counters (tests/e2e/pacing.ts, clear-counters.ts).
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
  // the lane is as it was found: none of this file's rows
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM designs WHERE design_no LIKE '${PREFIX}-%'), (SELECT COUNT(*) FROM skus WHERE sku_no LIKE '${PREFIX}-%'), (SELECT COUNT(*) FROM sku_private), ` +
      `(SELECT COUNT(*) FROM bills WHERE bill_no LIKE '${PREFIX}-%'), (SELECT COUNT(*) FROM customers WHERE name LIKE '${PREFIX} %')`
  );
  expect(left).toEqual(['0', '0', '0', '0', '0']);
});

const designPage = (id: string) => `/design-detail?id=${id}`;
const WEIGHT = (value: string) => new RegExp(`\\b${value.replace('.', '\\.')}\\b`);

// ------------------------------------------------------------------------------------------------ 1: the owner-only weight

test.describe('CL19-1 E2E: the original weight on the design page is the owner’s', () => {
  test.describe.configure({ timeout: 240_000 });

  test('the owner has the button; it shows and hides the column with the weight of each piece', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), designPage(ids.designA));
    const main = page.getByRole('main');
    await expect(main).toContainText(PIECE.a1.no, { timeout: 60_000 });
    await expect(page.getByTestId('design-number')).toHaveText(DESIGN_A.no);
    const toggle = main.getByRole('button', { name: /Original NW/ });
    await expect(toggle).toBeVisible();
    // hidden until asked for
    await expect(main.getByRole('columnheader', { name: /Orig\. NW/ })).toHaveCount(0);
    await expect(main).not.toContainText(WEIGHT(OWNER_WEIGHT.a1));
    await toggle.click();
    await expect(main.getByRole('columnheader', { name: /Orig\. NW/ })).toBeVisible();
    await expect(main).toContainText(`${OWNER_WEIGHT.a1} g`);
    // the Sold piece has no weight of its own in the book: a dash, never a weight of another piece
    await expect(main).not.toContainText(WEIGHT(OWNER_WEIGHT.b1));
    await toggle.click();
    await expect(main.getByRole('columnheader', { name: /Orig\. NW/ })).toHaveCount(0);
    await expect(main).not.toContainText(WEIGHT(OWNER_WEIGHT.a1));
  });

  for (const role of ['biller', 'staff'] as const) {
    test(`${role}: the design and its pieces are there; no button, no column, and the owner's weight is nowhere on the page`, async ({
      page,
    }) => {
      await open(page, e2eLogin(role), designPage(ids.designA));
      const main = page.getByRole('main');
      await expect(main).toContainText(PIECE.a1.no, { timeout: 60_000 });
      await expect(main).toContainText(PIECE.a2.no);
      await expect(page.getByTestId('design-number')).toHaveText(DESIGN_A.no);
      await expect(main.getByRole('button', { name: /Original NW/ })).toHaveCount(0);
      await expect(main.getByRole('columnheader', { name: /Orig\. NW/ })).toHaveCount(0);
      await expect(main).not.toContainText(/Admin Only|Admin View/);
      for (const weight of Object.values(OWNER_WEIGHT))
        await expect(main).not.toContainText(WEIGHT(weight));
    });
  }
});

// ------------------------------------------------------------------------------------------------ 2: the real design and piece

test.describe('CL19-2 E2E: the design page and the scan screen show what the address and the scanned code name', () => {
  test.describe.configure({ timeout: 240_000 });

  test('each design shows itself and its own pieces, with its own category in the breadcrumb, and no sample text', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), designPage(ids.designA));
    const main = page.getByRole('main');
    await expect(page.getByTestId('design-number')).toHaveText(DESIGN_A.no, { timeout: 60_000 });
    await expect(main).toContainText(DESIGN_A.name);
    await expect(main).toContainText(PIECE.a1.no);
    await expect(main).toContainText(PIECE.a2.no);
    await expect(main).not.toContainText(PIECE.b1.no);
    await page.goto(designPage(ids.designB));
    await expect(page.getByTestId('design-number')).toHaveText(DESIGN_B.no, { timeout: 60_000 });
    await expect(main).toContainText(DESIGN_B.name);
    await expect(main).toContainText(PIECE.b1.no);
    await expect(main).not.toContainText(PIECE.a1.no);
    // the breadcrumb ends with the design's own number and names its category
    const category = (
      await laneSql(
        `SELECT c.name FROM designs d JOIN categories c ON c.id = d.category_id WHERE d.id = '${ids.designB}'`
      )
    )[0][0];
    const crumbs = main.getByTestId('design-breadcrumb');
    await expect(crumbs).toContainText(category);
    await expect(crumbs).toContainText(DESIGN_B.no);
    await expect(main).not.toContainText('SET-00572');
    await expect(main).not.toContainText('Necklace Set');
  });

  test('an address with no design says so, and one that names a design that is not there says that: neither shows another design', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/design-detail');
    const main = page.getByRole('main');
    await expect(main.getByTestId('design-none')).toBeVisible({ timeout: 60_000 });
    await expect(main).not.toContainText(PREFIX);
    await expect(main.getByTestId('design-number')).toHaveCount(0);
    await page.goto(designPage(randomUUID()));
    await expect(main.getByTestId('design-missing')).toBeVisible({ timeout: 60_000 });
    await expect(main).not.toContainText(PREFIX);
    await expect(main.getByTestId('design-number')).toHaveCount(0);
    await expect(main.getByRole('link', { name: /Inventory/ }).first()).toBeVisible();
  });

  test('the scan screen: a piece in stock, a sold piece and a code that is nothing; View Design opens the design of the piece', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/scan-detail');
    const main = page.getByRole('main');
    const input = page.getByPlaceholder('Enter SKU number or barcode');
    await expect(input).toBeVisible({ timeout: 60_000 });
    // no made-up sample on the screen: no demo scans, no example from the prototype
    await expect(main).not.toContainText('Quick demo scans');
    await expect(main).not.toContainText('SET-00572');
    await expect(main.getByRole('button', { name: /RING-00821|ER-00341/ })).toHaveCount(0);

    // a piece in stock, found by its number (and the type of letters does not matter)
    await input.fill(PIECE.b1.no.toLowerCase());
    await main.getByRole('button', { name: 'Search' }).click();
    await expect(main).toContainText('Available in Inventory');
    await expect(main).toContainText(PIECE.b1.no);
    await expect(main).toContainText(DESIGN_B.name);
    const view = main.getByRole('link', { name: 'View Design' });
    await expect(view).toHaveAttribute('href', designPage(ids.designB));
    await view.click();
    await expect(page.getByTestId('design-number')).toHaveText(DESIGN_B.no, { timeout: 60_000 });

    // a sold piece, found by its barcode, links to ITS design (the older one)
    await page.goto('/scan-detail');
    await page.getByPlaceholder('Enter SKU number or barcode').fill(PIECE.a2.barcode);
    await main.getByRole('button', { name: 'Search' }).click();
    await expect(main).toContainText('This SKU is Already Sold');
    await expect(main).toContainText(PIECE.a2.no);
    const viewSold = main.getByRole('link', { name: 'View Design' });
    await expect(viewSold).toHaveAttribute('href', designPage(ids.designA));
    await viewSold.click();
    await expect(page.getByTestId('design-number')).toHaveText(DESIGN_A.no, { timeout: 60_000 });

    // a code that is nothing
    await page.goto('/scan-detail');
    await page.getByPlaceholder('Enter SKU number or barcode').fill('NOT-A-PIECE-9');
    await main.getByRole('button', { name: 'Search' }).click();
    await expect(main).toContainText('SKU Not Found');
    await expect(main).not.toContainText(PREFIX);
  });
});

// ------------------------------------------------------------------------------------------------ 3: nothing in the browser's storage

test.describe('CL19-3 E2E: no jaishri.* key is read or written, and the browser holds nothing of the application’s', () => {
  test.describe.configure({ timeout: 240_000 });

  test('a session through the dashboard, the detail screens and the closed Order Book touches no jaishri.* key; the old order key is neither read nor wiped', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const touches: string[] = [];
    await page.exposeFunction('noteStorage', (what: string) => touches.push(what));
    await page.goto('/');
    // what the prototype's Order Book left in this browser: the new build must not read it, show it or wipe it
    const legacy = JSON.stringify([{ id: 'legacy-order', orderNumber: 'OLD-ORDER-0001' }]);
    await page.evaluate((value) => window.localStorage.setItem('jaishri.orders.v1', value), legacy);
    // every touch of Web Storage from here on is noted, by name, whatever code makes it
    await page.addInitScript(() => {
      const note = (what: string) => {
        try {
          (window as unknown as { noteStorage?: (s: string) => void }).noteStorage?.(what);
        } catch {
          // a page that cannot note is a page that cannot be checked; the storage dump below still stands
        }
      };
      for (const name of ['getItem', 'setItem', 'removeItem'] as const) {
        const original = Storage.prototype[name] as (...args: string[]) => unknown;
        Storage.prototype[name] = function (this: Storage, ...args: string[]) {
          note(`${name} ${args[0]}`);
          return original.apply(this, args);
        } as never;
      }
      const clear = Storage.prototype.clear;
      Storage.prototype.clear = function (this: Storage) {
        note('clear');
        return clear.call(this);
      };
    });

    await open(page, owner, '/order-book'); // closed to every role: the gate does not draw the screen
    await expect(page.getByText('Not available for your role')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('OLD-ORDER-0001')).toHaveCount(0);
    for (const route of [
      '/',
      designPage(ids.designA),
      '/scan-detail',
      '/inventory-management',
      '/order-book',
    ]) {
      await page.goto(route);
      await expect(aside(page)).toContainText(owner.fullName, { timeout: 60_000 });
    }
    // the noting works (the list below is not empty-handed because nothing was watching): a read made by the test itself is in it
    await page.evaluate(() => window.localStorage.getItem('cl19-probe'));
    expect(touches).toContain('getItem cl19-probe');
    expect(touches.filter((what) => /jaishri\./.test(what))).toEqual([]);
    const during = await browserStorage(page);
    expect(during.local).toEqual({ 'jaishri.orders.v1': legacy });
    expect(during.session).toEqual({});
    expect(during.databases).toEqual([]);
  });

  test('a biller and a staff user leave nothing in storage either', async ({ browser }) => {
    for (const role of ['biller', 'staff'] as const) {
      const context = await browser.newContext();
      const page = await context.newPage();
      try {
        await roomInTheMinute(page);
        await open(page, e2eLogin(role), designPage(ids.designA));
        await expect(page.getByTestId('design-number')).toHaveText(DESIGN_A.no, {
          timeout: 60_000,
        });
        const during = await browserStorage(page);
        expect(during.local).toEqual({});
        expect(during.session).toEqual({});
        expect(during.databases).toEqual([]);
      } finally {
        await context.close();
      }
    }
  });
});
