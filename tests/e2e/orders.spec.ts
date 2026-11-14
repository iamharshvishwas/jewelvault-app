import { spawn } from 'node:child_process';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { PHONE, expectNoSidewaysScroll, expectTappable, shoot } from './phone';
import { roomInTheMinute } from './pacing';

// FB-F1 (FB-D8, Siddhi #13): the Order Book and its dashboard card, in a real browser against the real API of a lane (FB-E1: POST /v1/orders, PATCH /v1/orders/:id, the photo upload under
// the order, the sync resource `orders`).
//   - a biller makes an order for a customer, with a photo (resized in the browser by the Add Design resizer and uploaded under the order's id), due tomorrow (Asia/Kolkata): it is on the
//     dashboard card of a second browser (the owner's) within 10 seconds, with the customer's name; marked In progress, Ready, then Delivered, it leaves that card; a delivered order offers no
//     status button but the owner's Cancel, and no Add photo (F-extra-5)
//   - staff see the list and the card with the order number, description, date, status and photo, and no customer, no New order and no status button (ruling A4, F-extra-1)
//   - nothing under jaishri.* in browser storage
//   - at 375 x 812 the Order Book, its form and the card render with no sideways scroll and their controls take a tap (F-extra-6); the bottom bar's Orders button is inside the screen
//
// The customer is written as root in the lane's container (the screen that makes customers is proved in billing.spec.ts). Everything the test made is taken out again: the orders, their photos,
// the customer and the counter row of the order series, so the volume case of hydrate.spec.ts finds the lane as the harness made it.
//
// Run: E2E=1 LANE=b JV_LANE_NAMESPACE=fbf JV_LANE_PORT_BASE=34800 PORT=5500 JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/orders.spec.ts

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/** SQL as root in the lane's container (the password stays inside it); the statements go in through standard input. */
function laneSql(sql: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'exec',
      '-i',
      laneContainer(),
      'sh',
      '-c',
      'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" jv_lane -N -B',
    ]);
    let out = '';
    let err = '';
    child.stdout.on('data', (chunk) => (out += chunk));
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0)
        return reject(
          new Error(`the lane's database refused the SQL (${code}): ${err.slice(0, 500)}`)
        );
      resolve(
        out
          .split('\n')
          .filter((line) => line !== '')
          .map((line) => line.split('\t'))
      );
    });
    child.stdin.end(sql);
  });
}

const CUSTOMER = { name: 'FBF Order Customer', mobile: '9000550001' };
const OF_THE_TEST = `customer_id IN (SELECT id FROM customers WHERE name LIKE 'FBF %')`;

async function cleanLane() {
  await laneSql(
    `DELETE FROM orders WHERE ${OF_THE_TEST}; ` +
      // an order photo is a design_photos row with order_id set; with its order gone (or never made) it goes too
      `DELETE FROM design_photos WHERE order_id IS NOT NULL AND order_id NOT IN (SELECT id FROM orders); ` +
      `DELETE FROM customers WHERE name LIKE 'FBF %'; ` +
      // the counter row of the order series: gone when no order is left, as a fresh lane has it
      `DELETE FROM sys_counters WHERE series LIKE 'order:%' AND NOT EXISTS (SELECT 1 FROM orders);`
  );
}

test.beforeAll(async () => {
  await cleanLane();
  await laneSql(
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES (UUID(), '${CUSTOMER.name}', '${CUSTOMER.mobile}', 'Retail');`
  );
});
test.afterAll(async () => {
  await cleanLane();
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM orders), (SELECT COUNT(*) FROM customers WHERE name LIKE 'FBF %'), ` +
      `(SELECT COUNT(*) FROM design_photos WHERE order_id IS NOT NULL), (SELECT COUNT(*) FROM sys_counters WHERE series LIKE 'order:%')`
  );
  expect(left).toEqual(['0', '0', '0', '0']);
});
test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});

// ------------------------------------------------------------------------------------------------ the page

/** The Asia/Kolkata business date `days` from today, as the API and the card count it. */
function kolkataDate(days = 0): string {
  return new Date(Date.now() + 19_800_000 + days * 86_400_000).toISOString().slice(0, 10);
}

async function open(page: Page, who: E2eLogin, url = '/') {
  await page.goto(url);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.locator('aside').first()).toContainText(who.fullName, { timeout: 60_000 });
}

/** A second browser: its own context (its own cookie and memory), signed in as `who`. */
async function secondBrowser(browser: Browser, who: E2eLogin, url = '/') {
  const context = await browser.newContext();
  const page = await context.newPage();
  await roomInTheMinute(page);
  await open(page, who, url);
  return { page, close: () => context.close() };
}

/** A real JPEG drawn by the browser itself (960 x 1280), for the photo input. */
async function aPhoto(page: Page) {
  const data = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = 960;
    canvas.height = 1280;
    const context = canvas.getContext('2d') as CanvasRenderingContext2D;
    context.fillStyle = '#c59b3c';
    context.fillRect(0, 0, 960, 1280);
    context.fillStyle = '#fff';
    context.font = '120px sans-serif';
    context.fillText('Order', 200, 640);
    return canvas.toDataURL('image/jpeg', 0.9).split(',')[1];
  });
  return { name: 'order.jpg', mimeType: 'image/jpeg', buffer: Buffer.from(data, 'base64') };
}

/** Everything JavaScript can read that the browser keeps: both Web Storage areas and the names of the IndexedDB databases. */
async function browserStorage(page: Page) {
  return page.evaluate(async () => {
    const keys = (store: Storage) =>
      Array.from({ length: store.length }, (_, i) => store.key(i) ?? '');
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return {
      keys: [...keys(window.localStorage), ...keys(window.sessionStorage)],
      databases: databases.map((d) => d.name ?? ''),
    };
  });
}

/** Makes an order on the open Order Book: the customer by mobile, the words, the date, the photos. Resolves with the number the API gave. */
async function makeOrder(
  page: Page,
  entries: { description: string; date: string; photo?: boolean }
): Promise<string> {
  await page.getByRole('button', { name: 'New order' }).click();
  const form = page.getByTestId('new-order-form');
  await form.getByPlaceholder('Search by mobile or name...').fill(CUSTOMER.mobile);
  await form.getByRole('button', { name: new RegExp(CUSTOMER.name) }).click();
  await expect(form).toContainText(CUSTOMER.name);
  await form.getByLabel('Description').fill(entries.description);
  await form.getByLabel('Delivery date').fill(entries.date);
  if (entries.photo) {
    await form.getByTestId('order-photo-input').setInputFiles(await aPhoto(page));
    await expect(form.getByTestId('order-photo-tile')).toHaveCount(1, { timeout: 30_000 });
  }
  await form.getByRole('button', { name: 'Save order' }).click();
  const notice = page.getByTestId('order-notice');
  await expect(notice).toBeVisible({ timeout: 30_000 });
  const number = /Order (ORD-\d{4}-\d{4,}) saved\./.exec((await notice.textContent()) ?? '')?.[1];
  expect(number, 'the API gave the order its number').toBeTruthy();
  return number as string;
}

const card = (page: Page, orderNo: string) =>
  page.locator(`[data-testid="order-card"][data-order-no="${orderNo}"]`);
const dueRow = (page: Page, orderNo: string) =>
  page.getByTestId('orders-due-row').filter({ hasText: orderNo });

// ------------------------------------------------------------------------------------------------ the cases

test.describe('FB-F1: the Order Book on the dashboard (Siddhi #13)', () => {
  test.describe.configure({ mode: 'serial', timeout: 240_000 });

  let orderNo = '';
  const description = 'FBF gold ring, size 14, 22K';

  test('a biller makes an order with a photo due tomorrow: on the owner’s dashboard card in another browser within 10 seconds; Ready then Delivered takes it off the card', async ({
    page,
    browser,
  }) => {
    const { apiUrl } = e2eLane();
    const uploads: string[] = [];
    page.on('request', (request) => {
      const url = request.url();
      if (request.method() === 'PUT' && url.startsWith(`${apiUrl}/v1/orders/`))
        uploads.push(new URL(url).searchParams.get('kind') ?? '');
    });
    const other = await secondBrowser(browser, e2eLogin('owner'));
    try {
      await expect(other.page.getByTestId('orders-due-panel')).toBeVisible();
      await expect(dueRow(other.page, 'FBF')).toHaveCount(0);

      await open(page, e2eLogin('biller'), '/order-book');
      await expect(page.getByRole('heading', { name: 'Order Book', level: 1 })).toBeVisible();
      orderNo = await makeOrder(page, { description, date: kolkataDate(1), photo: true });
      const saved = Date.now();
      expect(uploads, 'the photo went up under the order: full, then thumb').toEqual([
        'full',
        'thumb',
      ]);

      // the biller's list: the order, the customer, Open, tomorrow, the photo loaded from the API
      const mine = card(page, orderNo);
      await expect(mine).toContainText(description);
      await expect(mine).toContainText(CUSTOMER.name);
      await expect(mine.getByTestId('order-status')).toHaveText('Open');
      await expect(mine).toContainText('Due tomorrow');
      const photo = mine.getByTestId('order-photo');
      await expect(photo).toHaveCount(1);
      await expect(photo).toHaveAttribute(
        'src',
        new RegExp(`^${apiUrl}/v1/photos/[0-9a-f-]{36}/thumb$`)
      );
      await expect
        .poll(() => photo.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true);

      // the other browser hears of it by its poll (every 8 seconds): within 10 seconds of the save
      const row = dueRow(other.page, orderNo);
      await expect(row).toBeVisible({ timeout: 10_000 });
      expect(Date.now() - saved).toBeLessThanOrEqual(10_000);
      await expect(row).toContainText(CUSTOMER.name);
      await expect(row).toContainText('Due tomorrow');
      await expect(row).toContainText('Open');

      // the chain: one forward step at a time, never a step back
      await expect(mine.getByRole('button', { name: 'Mark In progress' })).toBeVisible();
      await expect(mine.getByRole('button', { name: 'Mark Open' })).toHaveCount(0);
      await mine.getByRole('button', { name: 'Mark In progress' }).click();
      await expect(mine.getByTestId('order-status')).toHaveText('In progress');
      await mine.getByRole('button', { name: 'Mark Ready' }).click();
      await expect(mine.getByTestId('order-status')).toHaveText('Ready');
      await expect(row).toContainText('Ready', { timeout: 10_000 });
      await mine.getByRole('button', { name: 'Mark Delivered' }).click();
      await expect(mine.getByTestId('order-status')).toHaveText('Delivered');

      // delivered: off the card of the other browser; no status button for the biller, and no Add photo
      await expect(row).toHaveCount(0, { timeout: 10_000 });
      await expect(mine.getByRole('button')).toHaveCount(0);
      await expect(mine.getByTestId('order-add-photo')).toHaveCount(0);
      await expect(mine).not.toContainText('Due tomorrow');

      // the owner may still cancel a delivered order (the plan's one exception), and nothing else
      await other.page.goto('/order-book');
      const owners = card(other.page, orderNo);
      await expect(owners.getByRole('button')).toHaveText(['Cancel order']);
      await expect(owners.getByTestId('order-add-photo')).toHaveCount(0);

      // the API's own row agrees
      const [stored] = await laneSql(
        `SELECT status, delivery_date, JSON_LENGTH(photo_ids) FROM orders WHERE order_no = '${orderNo}'`
      );
      expect(stored).toEqual(['delivered', kolkataDate(1), '1']);

      // nothing of the application in browser storage, in either browser: no jaishri.* key, no database
      for (const p of [page, other.page]) {
        const held = await browserStorage(p);
        expect(held.keys.filter((key) => key.startsWith('jaishri.'))).toEqual([]);
        expect(held.databases).toEqual([]);
      }
    } finally {
      await other.close();
    }
  });

  test('staff see the list and the card: number, description, date, status and photo, and no customer, no New order, no status button', async ({
    page,
  }) => {
    // an order still due, for the card (the first one is delivered)
    const biller = await secondBrowser(
      page.context().browser() as Browser,
      e2eLogin('biller'),
      '/order-book'
    );
    let due = '';
    try {
      due = await makeOrder(biller.page, {
        description: 'FBF silver anklet pair',
        date: kolkataDate(0),
      });
    } finally {
      await biller.close();
    }

    await open(page, e2eLogin('staff'));
    const row = dueRow(page, due);
    await expect(row).toBeVisible();
    await expect(row).toContainText('Due today');
    await expect(page.getByTestId('orders-due-panel')).not.toContainText(CUSTOMER.name);

    await page.goto('/order-book');
    await expect(page.getByRole('heading', { name: 'Order Book', level: 1 })).toBeVisible();
    await expect(page.getByRole('button', { name: 'New order' })).toHaveCount(0);
    const first = card(page, orderNo);
    await expect(first).toContainText(description);
    await expect(first.getByTestId('order-status')).toHaveText('Delivered');
    await expect(first.getByTestId('order-photo')).toHaveCount(1);
    await expect(card(page, due)).toContainText('FBF silver anklet pair');
    const main = page.getByRole('main');
    await expect(main).not.toContainText(CUSTOMER.name);
    await expect(main).not.toContainText(CUSTOMER.mobile);
    await expect(main.getByTestId('order-customer')).toHaveCount(0);
    await expect(main.getByTestId('order-card').getByRole('button')).toHaveCount(0);
    await expect(main.getByTestId('order-add-photo')).toHaveCount(0);
    // the tabs filter by status
    await page
      .getByTestId('order-tab')
      .filter({ hasText: /^Delivered/ })
      .click();
    await expect(card(page, orderNo)).toBeVisible();
    await expect(card(page, due)).toHaveCount(0);
    // in the menu
    await expect(page.locator('aside').getByRole('link', { name: 'Order Book' })).toBeVisible();
  });
});

// F-extra-6: the phone width of the plan, 375 x 812.
test.describe('FB-F1: the Order Book and the card at 375 x 812', () => {
  test.use({ viewport: PHONE });
  test.describe.configure({ timeout: 240_000 });

  test('the list, the new order form and the dashboard card: no sideways scroll, every control tappable, the form usable', async ({
    page,
  }) => {
    // the owner: the longest bottom bar (six buttons) and the same screen as the biller's
    await open(page, e2eLogin('owner'));
    await expect(page.getByTestId('orders-due-panel')).toBeVisible();
    // the bottom bar has Orders, inside the screen, as every other button of it
    const bar = page.locator('nav.fixed').last();
    // every button of the bar is whole inside the screen (by its box: in a dev build the Next.js dev overlay's corner sits over the bar's first button, which a real build does not have)
    const links = await bar.getByRole('link').all();
    expect(links).toHaveLength(6);
    for (const link of links) {
      const box = (await link.boundingBox())!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    }
    await expectTappable(bar.getByRole('link', { name: 'Orders', exact: true }));
    await expectNoSidewaysScroll(page);
    // the top bar fits too: nothing of it runs past the right edge, hidden behind the column (a tap that scrolls the column would shift the whole screen sideways)
    const header = page.locator('header').first();
    expect(await header.evaluate((el) => el.scrollWidth - el.clientWidth)).toBeLessThanOrEqual(0);
    for (const control of await header.locator('a:visible, button:visible').all()) {
      const box = (await control.boundingBox())!;
      expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    }
    await bar.getByRole('link', { name: 'Orders', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Order Book', level: 1 })).toBeVisible();

    // the form, filled and saved on the phone
    await expectTappable(page.getByRole('button', { name: 'New order' }));
    await page.getByRole('button', { name: 'New order' }).click();
    const form = page.getByTestId('new-order-form');
    await expectTappable(form.getByPlaceholder('Search by mobile or name...'));
    await expectTappable(form.getByLabel('Description'));
    await expectTappable(form.getByLabel('Delivery date'));
    await expectTappable(form.getByText('Add photo'));
    await expectTappable(form.getByRole('button', { name: 'Save order' }));
    await expectNoSidewaysScroll(page);
    await shoot(page, 'order-form');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    const number = await makeOrder(page, {
      description:
        'FBF phone order: a long description that must wrap inside the card on a narrow phone screen',
      date: kolkataDate(2),
      photo: true,
    });

    const mine = card(page, number);
    await mine.scrollIntoViewIfNeeded();
    const box = (await mine.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    await expectTappable(mine.getByRole('button', { name: 'Mark In progress' }));
    await expectTappable(mine.getByRole('button', { name: 'Cancel order' }));
    await expectTappable(mine.getByText('Add photo'));
    for (const tab of await page.getByTestId('order-tab').all()) {
      await tab.scrollIntoViewIfNeeded();
      await tab.click({ trial: true });
    }
    await expectNoSidewaysScroll(page);
    await shoot(page, 'order-book');

    // a cancel asks once more, then the order is Cancelled and takes no photo
    await mine.getByRole('button', { name: 'Cancel order' }).click();
    await expectTappable(mine.getByRole('button', { name: 'Yes, cancel the order' }));
    await mine.getByRole('button', { name: 'Yes, cancel the order' }).click();
    await expect(mine.getByTestId('order-status')).toHaveText('Cancelled');
    await expect(mine.getByTestId('order-add-photo')).toHaveCount(0);

    // the dashboard card on the phone
    await page.goto('/');
    const panel = page.getByTestId('orders-due-panel');
    await expect(panel).toBeVisible();
    const rows = page.getByTestId('orders-due-row');
    await expect(rows.first()).toBeVisible();
    const cardBox = (await panel.boundingBox())!;
    expect(cardBox.x + cardBox.width).toBeLessThanOrEqual(PHONE.width);
    await expectTappable(rows.first().getByRole('link'));
    await expectNoSidewaysScroll(page);
    await shoot(page, 'orders-due');
  });
});
