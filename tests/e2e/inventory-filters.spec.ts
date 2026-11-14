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
//   - a change of the filter takes the grid back to page 1; the table view shows the same designs as the grid;
//   - the sort box orders the designs, in the grid and in the table, and the order does not move when a filter takes designs out of it (newest and oldest are the design's created_at,
//     the weight is the gross weight of all its pieces added up);
//   - the grid/table switch in the header and the one above the grid are one switch;
//   - under 1024 px wide (375 and 768 tested) a "Filters" button opens the same panel, with the same ticks, and says how many are set; from 1024 px up the panel is always there.
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
  // the line under the title is on every screen size; the panel itself is hidden under 1024 px
  await expect(headerLine(page)).toBeVisible();
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
    await expect(toolbarCount(page)).toHaveText(`${all.d} designs`);
    await expect(clearButton(page)).toHaveCount(0);

    await option(page, 'Gold').check();
    await expect(headerLine(page)).toHaveText(line(gold.d, gold.s, gold.i));
    await expect(toolbarCount(page)).toHaveText(`${gold.d} designs`);
    await expect(clearButton(page)).toHaveText('Clear (1)');

    await clearButton(page).click();
    await expect(option(page, 'Gold')).not.toBeChecked();
    await expect(headerLine(page)).toHaveText(line(all.d, all.s, all.i));
    await expect(toolbarCount(page)).toHaveText(`${all.d} designs`);
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

// ------------------------------------------------------------------------------------------------ the sort box, the two switches, small screens

/** The same stock, with a created_at of its own for each design (a day each, not in the order of the numbers), and G05 moved to the second category. */
const DAYS: Record<string, number> = {
  'INVF-G01': 5,
  'INVF-G02': 3,
  'INVF-G03': 9,
  'INVF-G04': 1,
  'INVF-G05': 7,
  'INVF-G06': 2,
  'INVF-G07': 8,
  'INVF-G08': 4,
  'INVF-G09': 6,
  'INVF-G10': 10,
  'INVF-S01': 0,
  'INVF-S02': 11,
};
const NEWEST = Object.keys(DAYS).sort((a, b) => DAYS[b] - DAYS[a]);
const BY_NUMBER = Object.keys(DAYS).sort();
// weights of all the pieces together: G01 to G09 are 11 to 19 g, G10 is 5 + 30, S01 is 20, S02 is 50
const BY_WEIGHT = [
  'INVF-S02',
  'INVF-G10',
  'INVF-S01',
  'INVF-G09',
  'INVF-G08',
  'INVF-G07',
  'INVF-G06',
  'INVF-G05',
  'INVF-G04',
  'INVF-G03',
  'INVF-G02',
  'INVF-G01',
];

async function makeDatedStock() {
  await makeStock();
  const dates = Object.entries(DAYS)
    .map(
      ([no, day]) =>
        `UPDATE designs SET created_at = TIMESTAMP('2026-09-01 10:00:00') + INTERVAL ${day} DAY WHERE design_no = '${no}';`
    )
    .join(' ');
  await laneSql(
    dates +
      ` UPDATE designs SET category_id = (SELECT id FROM categories ORDER BY name LIMIT 1 OFFSET 1) WHERE design_no = 'INVF-G05';`
  );
}

const sortBox = (page: Page) => page.getByRole('combobox').first();
const headerGrid = (page: Page) => page.getByRole('button', { name: 'Grid view' });
const headerTable = (page: Page) => page.getByRole('button', { name: 'Table view' });
const toolbarGrid = (page: Page) => page.getByRole('button', { name: 'Show as grid' });
const toolbarTable = (page: Page) => page.getByRole('button', { name: 'Show as table' });

/** Every design number of the filtered list, page 1 then page 2, in the order shown. */
async function allPages(page: Page): Promise<string[]> {
  const first = await shownNumbers(page);
  const next = page.getByRole('button', { name: '2', exact: true });
  if ((await next.count()) === 0) return first;
  await next.click();
  await expect(page.getByText(/^Showing 9/)).toBeVisible();
  const second = await shownNumbers(page);
  await page.getByRole('button', { name: '1', exact: true }).click();
  await expect(page.getByText(/^Showing 1–8/)).toBeVisible();
  return [...first, ...second];
}

test.describe.serial('the sort box', () => {
  test.beforeAll(makeDatedStock);
  test.afterAll(cleanStock);

  test('orders the designs in the grid and in the table, by created_at, number, category and total gross weight', async ({
    page,
  }) => {
    await openInventory(page, owner);
    await search(page).fill('INVF-');
    await expect(headerLine(page)).toHaveText(line(12, 13, 11));

    // the box opens on Newest First, and the grid shows it
    await expect(sortBox(page)).toHaveValue('sort-newest');
    await expect.poll(() => allPages(page)).toEqual(NEWEST);

    await sortBox(page).selectOption('sort-oldest');
    await expect.poll(() => allPages(page)).toEqual([...NEWEST].reverse());

    await sortBox(page).selectOption('sort-design');
    await expect.poll(() => allPages(page)).toEqual(BY_NUMBER);

    // category: the first category (G01 to G10 but G05, by number), then the second (G05, S01, S02)
    await sortBox(page).selectOption('sort-category');
    await expect
      .poll(() => allPages(page))
      .toEqual([
        ...BY_NUMBER.filter((n) => n !== 'INVF-G05' && n.startsWith('INVF-G')),
        'INVF-G05',
        'INVF-S01',
        'INVF-S02',
      ]);

    await sortBox(page).selectOption('sort-weight');
    await expect.poll(() => allPages(page)).toEqual(BY_WEIGHT);

    // the table is the same order as the grid
    await page.getByRole('button', { name: 'Show as table' }).click();
    await expect.poll(() => allPages(page)).toEqual(BY_WEIGHT);
    await sortBox(page).selectOption('sort-newest');
    await expect.poll(() => allPages(page)).toEqual(NEWEST);
  });

  test('a change of the order goes back to page 1, and a filter takes designs out of the order without moving the others', async ({
    page,
  }) => {
    await openInventory(page, owner);
    await search(page).fill('INVF-');
    await sortBox(page).selectOption('sort-weight');
    await page.getByRole('button', { name: '2', exact: true }).click();
    await expect(page.getByText('Showing 9–12 of 12')).toBeVisible();
    await sortBox(page).selectOption('sort-oldest');
    await expect(page.getByText('Showing 1–8 of 12')).toBeVisible();

    // Silver takes out the gold designs: the two that are left keep their place in the order (oldest first: S01, S02)
    await option(page, 'Silver').check();
    await expect.poll(() => shownNumbers(page)).toEqual(['INVF-S01', 'INVF-S02']);
    await sortBox(page).selectOption('sort-weight');
    await expect.poll(() => shownNumbers(page)).toEqual(['INVF-S02', 'INVF-S01']);
    await option(page, 'Silver').uncheck();
    await expect.poll(() => allPages(page)).toEqual(BY_WEIGHT);
  });
});

test.describe.serial('the grid/table switch', () => {
  test.beforeAll(makeStock);
  test.afterAll(cleanStock);

  test('the switch in the header and the one above the grid are one switch, and the screen opens on the grid again after it is left', async ({
    page,
  }) => {
    await openInventory(page, owner);
    await search(page).fill('INVF-');
    const pressed = async (grid: boolean) => {
      for (const button of [headerGrid(page), toolbarGrid(page)])
        await expect(button).toHaveAttribute('aria-pressed', String(grid));
      for (const button of [headerTable(page), toolbarTable(page)])
        await expect(button).toHaveAttribute('aria-pressed', String(!grid));
    };
    await pressed(true);
    await expect(page.locator('tbody tr')).toHaveCount(0);

    await headerTable(page).click(); // the header's own button
    await pressed(false);
    await expect(page.locator('tbody tr')).toHaveCount(8);

    await toolbarGrid(page).click(); // the one above the grid
    await pressed(true);
    await expect(page.locator('tbody tr')).toHaveCount(0);
    expect(await shownNumbers(page)).toHaveLength(8);

    await toolbarTable(page).click();
    await pressed(false);
    await headerGrid(page).click();
    await pressed(true);

    // away and back, without a reload: the grid again
    await headerTable(page).click();
    await aside(page).getByRole('link', { name: 'Dashboard' }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(headerLine(page)).toHaveCount(0);
    const designs = aside(page).getByRole('link', { name: 'Designs' });
    if (!(await designs.isVisible()))
      await aside(page).getByRole('button', { name: 'Inventory' }).click();
    await designs.click();
    await expect(headerLine(page)).toBeVisible();
    await pressed(true);
  });
});

test.describe.serial('small screens', () => {
  test.beforeAll(makeStock);
  test.afterAll(cleanStock);

  for (const [name, width, height] of [
    ['a phone, 375 px', 375, 812],
    ['a tablet, 768 px', 768, 1024],
  ] as const) {
    test(`on ${name} a Filters button opens the same panel, with the same ticks and a count`, async ({
      page,
    }) => {
      await page.setViewportSize({ width, height });
      await openInventory(page, owner);
      const button = page.getByRole('button', { name: /^Filters/ });

      // closed: the button, no panel
      await expect(button).toBeVisible();
      await expect(button).toHaveAttribute('aria-expanded', 'false');
      await expect(button).toHaveText('Filters');
      await expect(search(page)).toBeHidden();
      await expect(option(page, 'Gold')).toBeHidden();

      // open: the panel is on the screen, not wider than it
      await button.click();
      await expect(button).toHaveAttribute('aria-expanded', 'true');
      await expect(search(page)).toBeVisible();
      const box = await page
        .getByRole('complementary')
        .filter({ has: search(page) })
        .boundingBox();
      expect(box, 'the panel has a box').not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);

      // the same state as the big panel: a tick changes the count, the search and the weight work
      await search(page).fill('INVF-');
      await expect(headerLine(page)).toHaveText(line(12, 13, 11));
      await option(page, 'Gold').check();
      await expect(headerLine(page)).toHaveText(line(10, 11, 10));
      await expect(button).toHaveText('Filters (2)'); // the tick and the search
      await page.getByLabel('Minimum gross weight in grams').fill('25');
      await expect(headerLine(page)).toHaveText(line(1, 2, 1)); // G10 (its 30 g piece)
      await expect(button).toHaveText('Filters (3)');

      // closed again: the panel goes, the filter stays, and so does the count on the button
      await button.click();
      await expect(search(page)).toBeHidden();
      await expect(button).toHaveText('Filters (3)');
      await expect(headerLine(page)).toHaveText(line(1, 2, 1));
      expect(await shownNumbers(page)).toEqual(['INVF-G10']);

      // the page does not scroll sideways: every design card is inside the screen
      const cards = page.locator('div.jewel-card p.font-mono');
      const right = await cards.evaluateAll((els) =>
        Math.max(...els.map((e) => e.getBoundingClientRect().right))
      );
      expect(right).toBeLessThanOrEqual(width);

      // open and clear: everything is back
      await button.click();
      await clearButton(page).click();
      await expect(button).toHaveText('Filters');
      await expect(search(page)).toHaveValue('');
    });
  }

  test('from 1024 px up there is no Filters button and the panel is always there', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await openInventory(page, owner);
    await expect(page.getByRole('button', { name: /^Filters/ })).toBeHidden();
    await expect(search(page)).toBeVisible();
    await expect(option(page, 'Gold')).toBeVisible();
  });
});
