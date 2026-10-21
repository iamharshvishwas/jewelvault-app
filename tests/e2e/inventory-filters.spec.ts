import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import { e2eLogin, type E2eLogin } from './global-setup';

// The filter panel of the Inventory screen, in a real browser against the real API of a lane (found on staging on 21 Oct 2026: ticking anything in FILTERS changed nothing).
//   - ticking Gold changes the count of designs on the screen, in the line under the title and next to the sort box, to the number of gold designs of the database; Clear (1) puts it back;
//   - inside one section the ticks are OR, across sections they are AND; the status, the place and the weight are about ONE piece (a design whose in-stock piece is in the Vault and whose
//     Sold piece is in the Workshop is not "In Stock in the Workshop"); a design whose pieces are all Sold is under Sold and not under In Stock;
//   - the search box finds a design by number, name, piece number and barcode, in any case; the weight range is the gross weight of a piece, both ends included;
//   - nothing passing the filter says "No design matches these filters" (and not "No designs yet"), with a button that clears them;
//   - a change of the filter takes the grid back to page 1; the table view shows the same designs as the grid.
//
// The designs and pieces are made directly in the lane's database as root (poll.spec.ts and stock-edit.spec.ts do the same) and taken out again after the tests. Their numbers all start
// with INVF-, and the tests that count exactly type that into the search box first, so a lane that holds other stock does not change the answers.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/inventory-filters.spec.ts

const execFileAsync = promisify(execFile);
const owner = e2eLogin('owner');

// ------------------------------------------------------------------------------------------------ the page

/** The sidebar of the application (the inventory has a second `aside`, the filters, after it). */
const aside = (page: Page) => page.locator('aside').first();

async function openInventory(page: Page, who: E2eLogin) {
  await page.goto('/inventory-management');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
  await expect(page.getByLabel('Search designs and SKUs')).toBeVisible();
}

/** "N designs · M SKUs · K in stock", the line under the title. */
const headerLine = (page: Page) => page.getByText(/^\d+ designs? · \d+ SKUs? · \d+ in stock$/);
/** "N designs", next to the sort box. */
const toolbarCount = (page: Page) => page.getByText(/^\d+ designs?$/);
const line = (designs: number, skus: number, inStock: number) =>
  `${designs} design${designs === 1 ? '' : 's'} · ${skus} SKU${skus === 1 ? '' : 's'} · ${inStock} in stock`;

const search = (page: Page) => page.getByLabel('Search designs and SKUs');
const option = (page: Page, name: string) => page.getByRole('checkbox', { name, exact: true });
const clearButton = (page: Page) => page.getByRole('button', { name: /^Clear \(\d+\)$/ });
const noMatch = (page: Page) => page.getByText('No design matches these filters');

/** Opens a collapsed section of the panel (Purity and Location start closed). */
async function openSection(page: Page, label: string) {
  const header = page.getByRole('button', { name: label, exact: true });
  await header.click();
}

/** The design numbers on the screen, in the grid or in the table. */
async function shownNumbers(page: Page): Promise<string[]> {
  const cells = page.locator('div.jewel-card p.font-mono, tbody a.font-mono');
  const all = await cells.allTextContents();
  return all.map((text) => text.trim()).filter((text) => text.startsWith('INVF-'));
}

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/** SQL as root in the lane's container. The password never leaves the container: the shell inside it reads it from its own environment. */
async function laneSql(sql: string): Promise<string> {
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
  return stdout;
}

const designSql = (no: string, name: string, material: string, purity: string, category: number) =>
  `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) ` +
  `SELECT UUID_v4(), '${no}', '${name}', id, '${material}', '${purity}', 'By Weight' FROM categories ORDER BY name LIMIT 1 OFFSET ${category};`;

const pieceSql = (
  designNo: string,
  skuNo: string,
  barcode: string,
  gross: number,
  location: string,
  status: string
) =>
  `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, location, status) ` +
  `SELECT UUID_v4(), id, '${skuNo}', '${barcode}', ${gross.toFixed(3)}, ${(gross - 0.5).toFixed(3)}, '${location}', '${status}' FROM designs WHERE design_no = '${designNo}';`;

/** A piece sold: a bill of the walk-in customer, and the piece Sold on it (what the bill function does). */
const sellSql = (skuNo: string, billNo: string) =>
  `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) ` +
  `SELECT UUID_v4(), '${billNo}', id, CURDATE(), 'Retail', 1000.00 FROM customers WHERE is_walkin = 1; ` +
  `UPDATE skus SET status = 'Sold', sold_bill_id = (SELECT id FROM bills WHERE bill_no = '${billNo}') WHERE sku_no = '${skuNo}';`;

async function cleanStock() {
  await laneSql(
    `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE sku_no LIKE 'INVF-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'INVF-%'; DELETE FROM bills WHERE bill_no LIKE 'INVF-%'; ` +
      `DELETE FROM designs WHERE design_no LIKE 'INVF-%'`
  );
}

// The stock (12 designs, 13 pieces), all in the first category unless said:
//   INVF-G01 to INVF-G09   Gold 22K, one piece each, In Stock, Main Showroom, 11 to 19 g
//   INVF-G10               Gold 18K, two pieces: In Stock in the Jaishri Vault (5 g) and Sold in the Workshop (30 g)
//   INVF-S01               Silver 925, SECOND category, one piece In Stock, Main Showroom, 20 g, barcode INVFBARC01
//   INVF-S02               Silver 925, SECOND category, one piece, Sold, Main Showroom, 50 g
async function makeStock() {
  await cleanStock();
  const parts: string[] = [];
  for (let i = 1; i <= 9; i += 1) {
    const no = `INVF-G0${i}`;
    parts.push(
      designSql(no, `Filter gold ${i}`, 'Gold', '22K', 0),
      pieceSql(no, `${no}-1`, `INVFB-G0${i}`, 10 + i, 'Main Showroom', 'In Stock')
    );
  }
  parts.push(
    designSql('INVF-G10', 'Filter gold ten', 'Gold', '18K', 0),
    pieceSql('INVF-G10', 'INVF-G10-1', 'INVFB-G101', 5, 'Jaishri Vault', 'In Stock'),
    pieceSql('INVF-G10', 'INVF-G10-2', 'INVFB-G102', 30, 'Workshop', 'In Stock'),
    sellSql('INVF-G10-2', 'INVF-BILL-1'),
    designSql('INVF-S01', 'Filter silver one', 'Silver', '925', 1),
    pieceSql('INVF-S01', 'INVF-S01-1', 'INVFBARC01', 20, 'Main Showroom', 'In Stock'),
    designSql('INVF-S02', 'Filter silver two', 'Silver', '925', 1),
    pieceSql('INVF-S02', 'INVF-S02-1', 'INVFB-S02', 50, 'Main Showroom', 'In Stock'),
    sellSql('INVF-S02-1', 'INVF-BILL-2')
  );
  await laneSql(parts.join(' '));
}

// ------------------------------------------------------------------------------------------------ the tests

test.describe.serial('the filter panel of the inventory', () => {
  test.beforeAll(async () => {
    const categories = (await laneSql('SELECT name FROM categories ORDER BY name LIMIT 2'))
      .split('\n')
      .filter(Boolean);
    expect(categories.length, 'the lane has two categories to make stock in').toBe(2);
    await makeStock();
  });

  test.afterAll(async () => {
    await cleanStock();
  });

  test('ticking Gold changes the count of designs to the gold designs of the database, and Clear puts it back', async ({
    page,
  }) => {
    const count = async (where: string) =>
      Number((await laneSql(`SELECT COUNT(*) FROM designs WHERE ${where}`)).trim());
    const pieces = async (where: string) =>
      Number(
        (
          await laneSql(
            `SELECT COUNT(*) FROM skus s JOIN designs d ON d.id = s.design_id WHERE ${where}`
          )
        ).trim()
      );
    const all = {
      d: await count('1=1'),
      s: await pieces('1=1'),
      i: await pieces(`s.status = 'In Stock'`),
    };
    const gold = {
      d: await count(`material = 'Gold'`),
      s: await pieces(`d.material = 'Gold'`),
      i: await pieces(`d.material = 'Gold' AND s.status = 'In Stock'`),
    };
    expect(
      gold.d,
      'the stock holds gold and something else, so the tick has something to change'
    ).toBeLessThan(all.d);

    await openInventory(page, owner);
    await expect(headerLine(page)).toHaveText(line(all.d, all.s, all.i));
    await expect(toolbarCount(page)).toHaveText(`${all.d} design${all.d === 1 ? '' : 's'}`);
    await expect(clearButton(page)).toHaveCount(0);

    await option(page, 'Gold').check();
    await expect(headerLine(page)).toHaveText(line(gold.d, gold.s, gold.i));
    await expect(toolbarCount(page)).toHaveText(`${gold.d} designs`);
    await expect(clearButton(page)).toHaveText('Clear (1)');

    await clearButton(page).click();
    await expect(option(page, 'Gold')).not.toBeChecked();
    await expect(headerLine(page)).toHaveText(line(all.d, all.s, all.i));
    await expect(toolbarCount(page)).toHaveText(`${all.d} design${all.d === 1 ? '' : 's'}`);
    await expect(clearButton(page)).toHaveCount(0);
  });

  test('OR inside a section, AND across sections, and the header follows', async ({ page }) => {
    await openInventory(page, owner);
    await search(page).fill('INVF-');
    await expect(headerLine(page)).toHaveText(line(12, 13, 11));

    await option(page, 'Gold').check();
    await expect(headerLine(page)).toHaveText(line(10, 11, 10));
    await option(page, 'Silver').check(); // Gold or Silver: both
    await expect(headerLine(page)).toHaveText(line(12, 13, 11));
    await option(page, 'Gold').uncheck();
    await expect(headerLine(page)).toHaveText(line(2, 2, 1));

    // Silver AND the first category: nothing (the silver designs are in the second)
    const first = (await laneSql('SELECT name FROM categories ORDER BY name LIMIT 1')).trim();
    const second = (
      await laneSql('SELECT name FROM categories ORDER BY name LIMIT 1 OFFSET 1')
    ).trim();
    await option(page, first).check();
    await expect(noMatch(page)).toBeVisible();
    await expect(page.getByText('No designs yet')).toHaveCount(0);
    await expect(toolbarCount(page)).toHaveText('0 designs');
    await expect(headerLine(page)).toHaveText(line(0, 0, 0));
    // the first category OR the second, with Silver: both silver designs
    await option(page, second).check();
    await expect(headerLine(page)).toHaveText(line(2, 2, 1));
    await expect(clearButton(page)).toHaveText('Clear (4)'); // Silver, two categories and the search

    // the button of the message clears everything
    await option(page, second).uncheck();
    await expect(noMatch(page)).toBeVisible();
    await page.getByRole('button', { name: 'Clear filters' }).click();
    await expect(noMatch(page)).toHaveCount(0);
    await expect(clearButton(page)).toHaveCount(0);
    await expect(search(page)).toHaveValue('');
    await expect(headerLine(page)).not.toHaveText(line(0, 0, 0));
  });

  test('status, place and weight are about one piece; a design that is all Sold is under Sold and not In Stock', async ({
    page,
  }) => {
    await openInventory(page, owner);
    await search(page).fill('INVF-');

    await option(page, 'Sold').check(); // G10 (one Sold piece) and S02 (all Sold)
    await expect(headerLine(page)).toHaveText(line(2, 3, 1));
    await option(page, 'Sold').uncheck();

    await option(page, 'In Stock').check(); // everything but S02, which is all Sold
    await expect(headerLine(page)).toHaveText(line(11, 12, 11));

    await openSection(page, 'Location');
    await option(page, 'Workshop').check(); // G10's Workshop piece is Sold, its in-stock piece is in the Vault
    await expect(noMatch(page)).toBeVisible();
    await option(page, 'In Stock').uncheck();
    await expect(headerLine(page)).toHaveText(line(1, 2, 1)); // Sold or not, a piece in the Workshop: G10
    await option(page, 'Workshop').uncheck();

    await option(page, 'Jaishri Vault').check();
    await expect(headerLine(page)).toHaveText(line(1, 2, 1));
    await option(page, 'Jaishri Vault').uncheck();

    // the weight: both ends included, one piece (G10 has pieces of 5 g and 30 g, 35 g together)
    await page.getByLabel('Minimum gross weight in grams').fill('25');
    await page.getByLabel('Maximum gross weight in grams').fill('40');
    await expect(headerLine(page)).toHaveText(line(1, 2, 1));
    await page.getByLabel('Minimum gross weight in grams').fill('31');
    await page.getByLabel('Maximum gross weight in grams').fill('49');
    await expect(noMatch(page)).toBeVisible();
    await page.getByLabel('Minimum gross weight in grams').fill('19');
    await page.getByLabel('Maximum gross weight in grams').fill('20');
    await expect(headerLine(page)).toHaveText(line(2, 2, 2)); // G09 (19 g) and S01 (20 g)
    await expect(clearButton(page)).toHaveText('Clear (2)'); // the search and the weight range
  });

  test('the search finds a design by number, name, piece number and barcode, in any case', async ({
    page,
  }) => {
    await openInventory(page, owner);
    await search(page).fill('invf-g05');
    await expect(headerLine(page)).toHaveText(line(1, 1, 1));
    await search(page).fill('FILTER SILVER');
    await expect(headerLine(page)).toHaveText(line(2, 2, 1));
    await search(page).fill('invf-g10-2');
    await expect(headerLine(page)).toHaveText(line(1, 2, 1));
    await search(page).fill('invfbarc01');
    await expect(headerLine(page)).toHaveText(line(1, 1, 1));
    expect(await shownNumbers(page)).toEqual(['INVF-S01']);
    await search(page).fill('no design has this text');
    await expect(noMatch(page)).toBeVisible();
    await expect(page.getByText('No designs yet')).toHaveCount(0);
  });

  test('a change of filter goes back to page 1, and the table shows the same designs as the grid', async ({
    page,
  }) => {
    await openInventory(page, owner);
    await search(page).fill('INVF-');
    await expect(page.getByText('Showing 1–8 of 12')).toBeVisible();
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByText('Showing 9–12 of 12')).toBeVisible();

    await option(page, 'Gold').check(); // 10 designs: two pages, and the page is 1 again, not 2
    await expect(page.getByText('Showing 1–8 of 10')).toBeVisible();
    const gridPage1 = await shownNumbers(page);
    expect(gridPage1).toHaveLength(8);
    expect(gridPage1.every((no) => no.startsWith('INVF-G'))).toBe(true);

    await page.getByRole('button', { name: 'Show as table' }).click();
    await expect.poll(() => shownNumbers(page)).toEqual(gridPage1);
    await option(page, 'Silver').check(); // Gold or Silver: 12 again; the table follows
    await expect(page.getByText('Showing 1–8 of 12')).toBeVisible();
    await option(page, 'Gold').uncheck();
    await expect(toolbarCount(page)).toHaveText('2 designs');
    await expect
      .poll(async () => (await shownNumbers(page)).sort())
      .toEqual(['INVF-S01', 'INVF-S02']);
  });
});
