import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// FB-A1 (Siddhi's phone list #1, #2, #3): the ☰ of the top bar was dead on a phone. Under 1024 px it now opens the same Sidebar as a drawer, in a real browser at 375 x 812 against the
// real API of a lane.
//   - the owner taps Open menu: a dialog named Menu appears with the whole owner menu; a tap on Saved Estimates goes to /estimate and the drawer is gone;
//   - Escape closes it; a tap on the dark backdrop closes it;
//   - a long menu: every group open, the last Settings link (Business Settings) is reached by scrolling the drawer and a tap on it opens /settings?tab=business (the drawer is not stuck
//     behind or in front of anything that would eat the tap); once it has closed, the Sale button of the bottom bar is tappable;
//   - a biller's drawer has New Estimate and Customers & Ledger and no Settings;
//   - from 1280 px up there is no ☰, and the sidebar is the desktop one.
// FB-A2: estimates on a phone. The bottom bar has an Estimates button (owner and biller); an estimate opened at 375 px shows its owner buttons, Cancel and Re-issue, whole and inside the
// screen (they used to run off the right edge); a biller sees the estimate and no Cancel.
//
// The estimate these tests open (customer "FBA Priya", FBA-0001) is written as root in the lane's container, as owner-actions.spec.ts does, and taken out again afterwards.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/mobile-menu.spec.ts

const execFileAsync = promisify(execFile);
const owner = e2eLogin('owner');
const biller = e2eLogin('biller');

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/** SQL as root in the lane's container. The password never leaves the container: the shell inside it reads it from its own environment. */
async function laneSql(sql: string): Promise<void> {
  await execFileAsync(
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
}

const fixture = { design: randomUUID(), customer: randomUUID(), bill: randomUUID() };

/** One live estimate: 1.000 g of 22K gold at 6,920 with labour 300 a gram, 7,220.00, nothing received. */
async function makeEstimate() {
  await cleanEstimate();
  await laneSql(
    [
      `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) SELECT '${fixture.design}', 'FBA-D1', 'FBA gold ring', id, 'Gold', '22K', 'By Weight' FROM categories WHERE name = 'Ring';`,
      `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${fixture.customer}', 'FBA Priya', '9000440001', 'Retail');`,
      `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, piroi, labour_retail, labour_semi, labour_wholesale, status) VALUES ('${randomUUID()}', '${fixture.design}', 'FBA-S1', 'FBABC1', 1.200, 1.000, 0.00, 300.00, 280.00, 260.00, 'In Stock');`,
      `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) VALUES ('${fixture.bill}', 'FBA-0001', '${fixture.customer}', CURDATE(), 'Retail', 7220.00, 7220.00);`,
      `INSERT INTO bill_items (id, bill_id, line_no, sku_id, design_no, sku_no, category, material, purity, selling_method, gross_weight, customer_net_weight, quantity, ` +
        `metal_rate, labour_rate, labour_amount, piroi, other_charges, metal_amount, fine_weight_due, item_total, list_metal_rate, list_labour_rate) ` +
        `SELECT '${randomUUID()}', '${fixture.bill}', 1, s.id, 'FBA-D1', s.sku_no, 'Ring', 'Gold', '22K', 'By Weight', 1.200, 1.000, 1, 6920.00, 300.00, 300.00, 0.00, 0.00, 6920.00, 0.000, 7220.00, 6920.00, 300.00 ` +
        `FROM skus s WHERE s.sku_no = 'FBA-S1';`,
      `UPDATE skus SET status = 'Sold', sold_bill_id = '${fixture.bill}' WHERE sku_no = 'FBA-S1';`,
      // what the money services do on every write: the customer gets a new `updated_at`, which is how the polls find a change
      `UPDATE customers SET updated_at = CURRENT_TIMESTAMP(6) WHERE name = 'FBA Priya';`,
    ].join(' ')
  );
}

/** The delete order follows the foreign keys. */
async function cleanEstimate() {
  await laneSql(
    `DELETE FROM bill_items WHERE bill_id IN (SELECT id FROM bills WHERE bill_no LIKE 'FBA-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'FBA-%'; ` +
      `DELETE FROM bills WHERE bill_no LIKE 'FBA-%'; ` +
      `DELETE FROM designs WHERE design_no LIKE 'FBA-%'; ` +
      `DELETE FROM customers WHERE name = 'FBA Priya';`
  );
}

test.use({ viewport: { width: 375, height: 812 } });
// a first request to the dev server compiles the page, and the sign-in loads all the data
test.setTimeout(120_000);

test.beforeEach(async () => {
  await clearLoginCounters();
});

// ------------------------------------------------------------------------------------------------ the page

/** Signs in on the login screen and waits for the top bar: the data gate has opened. */
async function openApp(page: Page, who: E2eLogin, target = '/') {
  // every sign-in loads all the data, and the API allows one person 300 calls a minute: wait for room, so that this spec does not use up the minute of the spec that runs after it
  await roomInTheMinute(page, 100);
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible({ timeout: 60_000 });
}

const menuButton = (page: Page) => page.getByRole('button', { name: 'Open menu' });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Menu' });

async function openMenu(page: Page): Promise<Locator> {
  await menuButton(page).click();
  await expect(drawer(page)).toBeVisible();
  return drawer(page);
}

/** Opens every group of the drawer (the drawer starts with them open; this makes the test the same if that changes). */
async function expandEveryGroup(menu: Locator) {
  for (;;) {
    const closed = menu.locator('button[aria-expanded="false"]');
    if ((await closed.count()) === 0) return;
    await closed.first().click();
  }
}

// ------------------------------------------------------------------------------------------------ FB-A1

test.describe('FB-A1 the phone menu', () => {
  test('the owner opens the menu, taps Saved Estimates and lands on /estimate with the drawer gone', async ({
    page,
  }) => {
    await openApp(page, owner);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
    const menu = await openMenu(page);
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'true');
    for (const label of ['Customers & Ledger', 'Saved Estimates', 'Reports']) {
      await expect(menu.getByRole('link', { name: label })).toBeVisible();
    }
    await menu.getByRole('link', { name: 'Saved Estimates' }).click();
    await expect(page).toHaveURL(/\/estimate$/);
    await expect(drawer(page)).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Saved Estimates' })).toBeVisible();
    await expect(menuButton(page)).toHaveAttribute('aria-expanded', 'false');
  });

  test('Escape closes the drawer', async ({ page }) => {
    await openApp(page, owner);
    await openMenu(page);
    await page.keyboard.press('Escape');
    await expect(drawer(page)).toHaveCount(0);
    // and it opens again
    await openMenu(page);
  });

  test('a tap on the backdrop closes the drawer', async ({ page }) => {
    await openApp(page, owner);
    await openMenu(page);
    // the panel is 288 px wide at this width: x = 350 is the dark part beside it
    await page.mouse.click(350, 400);
    await expect(drawer(page)).toHaveCount(0);
  });

  test('the Close menu button of the drawer closes it', async ({ page }) => {
    await openApp(page, owner);
    const menu = await openMenu(page);
    await menu.getByRole('button', { name: 'Close menu' }).last().click();
    await expect(drawer(page)).toHaveCount(0);
  });

  test('with every group open the long owner menu scrolls and its last link, Business Settings, opens its tab; the Sale button is tappable after the drawer closes', async ({
    page,
  }) => {
    await openApp(page, owner);
    const menu = await openMenu(page);
    await expandEveryGroup(menu);
    // Review Focus 3: the menu is longer than the screen, so it must scroll inside the drawer
    const nav = menu.locator('nav');
    const sizes = await nav.evaluate((el) => ({ scroll: el.scrollHeight, shown: el.clientHeight }));
    expect(sizes.scroll).toBeGreaterThan(sizes.shown);
    const last = menu.getByRole('link', { name: 'Business Settings' });
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    await last.click();
    await expect(page).toHaveURL(/\/settings\?tab=business$/);
    await expect(drawer(page)).toHaveCount(0);
    // nothing of the drawer is left over the bottom bar
    await page.getByRole('link', { name: 'Sale', exact: true }).click();
    await expect(page).toHaveURL(/\/billing-pos/);
  });

  test('a biller drawer has New Estimate and Customers & Ledger and no Settings', async ({
    page,
  }) => {
    await openApp(page, biller);
    const menu = await openMenu(page);
    await expect(menu.getByRole('link', { name: 'New Estimate' })).toBeVisible();
    await expect(menu.getByRole('link', { name: 'Customers & Ledger' })).toBeVisible();
    await expandEveryGroup(menu);
    await expect(menu.getByText('Settings')).toHaveCount(0);
    await expect(menu.getByText('Reports')).toHaveCount(0);
  });

  test('from 1280 px up there is no ☰ and the sidebar is the desktop one', async ({ page }) => {
    await openApp(page, owner);
    await page.setViewportSize({ width: 1280, height: 800 });
    await expect(menuButton(page)).toBeHidden();
    await expect(page.getByRole('button', { name: 'Collapse sidebar' })).toBeVisible();
    await expect(drawer(page)).toHaveCount(0);
  });
});

// ------------------------------------------------------------------------------------------------ FB-A2

test.describe('FB-A2 estimates on a phone', () => {
  test.beforeAll(async () => {
    await makeEstimate();
  });
  test.afterAll(async () => {
    await cleanEstimate();
  });

  const estimatesTab = (page: Page) => page.getByRole('link', { name: 'Estimates', exact: true });

  test('the owner reaches Estimates from the bottom bar and sees Cancel and Re-issue whole, inside the screen', async ({
    page,
  }) => {
    await openApp(page, owner);
    await estimatesTab(page).click();
    await expect(page).toHaveURL(/\/estimate$/);
    await expect(page.getByRole('heading', { name: 'Saved Estimates' })).toBeVisible();
    await page.getByRole('link', { name: 'FBA-0001' }).click();
    await expect(page.getByTestId('estimate-number')).toHaveText('FBA-0001');

    const cancel = page.getByRole('button', { name: 'Cancel' });
    const reissue = page.getByRole('link', { name: 'Re-issue' });
    const print = page.getByRole('button', { name: 'Print', exact: true });
    const back = page.getByRole('link', { name: 'Saved Estimates' });
    for (const control of [cancel, reissue, print, back]) {
      await expect(control).toBeVisible();
      const box = await control.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
      // a button stays one line: squeezed into one row at this width they wrapped their words onto two and three lines
      expect(box!.height).toBeLessThanOrEqual(44);
    }
    // the screen itself does not scroll sideways
    const sideways = await page.locator('main').evaluate((el) => el.scrollWidth - el.clientWidth);
    expect(sideways).toBeLessThanOrEqual(0);
  });

  test('a biller reaches Estimates from the bottom bar and sees the estimate and no Cancel', async ({
    page,
  }) => {
    await openApp(page, biller);
    await estimatesTab(page).click();
    await expect(page).toHaveURL(/\/estimate$/);
    await page.getByRole('link', { name: 'FBA-0001' }).click();
    await expect(page.getByTestId('estimate-number')).toHaveText('FBA-0001');
    await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
    await expect(page.getByTestId('owner-bill-actions')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Cancel' })).toHaveCount(0);
  });
});
