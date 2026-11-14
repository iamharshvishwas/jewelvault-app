import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { PHONE, expectNoSidewaysScroll, expectTappable, shoot } from './phone';
import { roomInTheMinute } from './pacing';
import { countIn, readPdf } from './pdf-text';

// FB-D2 (Siddhi #6): the ready-stock catalogue, a screen of the designs that have a piece In Stock, by category, with the first photo, printed or saved as a PDF, in a real browser against the real API
// of a lane.
//   the owner opens /stock-catalogue, chooses `Ring`, and the page shows each In Stock ring with its photo (an img on the API's photo address, loaded), its number, purity, gross-weight range and number of
//   pieces; the PDF Chromium makes of it has the number of each In Stock ring, no ring that is Sold out, no chain (not chosen), no price and no original weight; the biller and the staff open it too
//
// The designs and pieces are written as root in the lane's container (the screens that make them are proved in add-design.spec.ts). The category is the seeded `Ring` (the lane's seed has the singular
// name; the brief's "Rings" is the same category). Everything the test made is taken out again.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/stock-catalogue.spec.ts

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

// ------------------------------------------------------------------------------------------------ the stock of the test

/** A 1 x 1 PNG: the smallest real picture the API will serve (`image/png`). */
const PNG_HEX =
  '89504E470D0A1A0A0000000D49484452000000010000000108060000001F15C4890000000D49444154789C6300010000000500010D0A2DB40000000049454E44AE426082';

const ids = {
  ring: randomUUID(),
  soldRing: randomUUID(),
  chain: randomUUID(),
  ringPhoto: randomUUID(),
  chainPhoto: randomUUID(),
  customer: randomUUID(),
  bill: randomUUID(),
  firstRingPiece: randomUUID(),
};
/** The owner's own weight of the first ring: it must be nowhere on the page or on the paper. */
const ORIGINAL_WEIGHT = '9.876';

function fixtureSql(): string {
  const photo = (photoId: string, designId: string) =>
    ['full', 'thumb']
      .map(
        (kind) =>
          `INSERT INTO design_photos (id, kind, design_id, mime, byte_size, sha256, bytes) VALUES ` +
          `('${photoId}', '${kind}', '${designId}', 'image/png', ${PNG_HEX.length / 2}, UNHEX(SHA2(UNHEX('${PNG_HEX}'), 256)), UNHEX('${PNG_HEX}'));`
      )
      .join(' ');
  const design = (
    id: string,
    no: string,
    name: string,
    category: string,
    purity: string,
    photoId?: string
  ) =>
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method, photo_ids, primary_photo_id) ` +
    `SELECT '${id}', '${no}', '${name}', id, 'Gold', '${purity}', 'By Weight', ${photoId ? `JSON_ARRAY('${photoId}')` : `JSON_ARRAY()`}, ${photoId ? `'${photoId}'` : 'NULL'} FROM categories WHERE name = '${category}';`;
  const piece = (designId: string, sku: string, gross: string, status: string, id = randomUUID()) =>
    `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status${status === 'Sold' ? ', sold_bill_id' : ''}) VALUES ` +
    `('${id}', '${designId}', '${sku}', '${sku.replace(/-/g, '')}', ${gross}, ${(Number(gross) - 0.5).toFixed(3)}, '${status}'${status === 'Sold' ? `, '${ids.bill}'` : ''});`;
  return [
    `INSERT INTO customers (id, name, mobile, customer_type) VALUES ('${ids.customer}', 'W16 Catalogue Customer', '9000160001', 'Retail');`,
    `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, subtotal, grand_total) VALUES ('${ids.bill}', 'W16-0001', '${ids.customer}', CURDATE(), 'Retail', 1000.00, 1000.00);`,
    design(ids.ring, 'W16-R1', 'W16 gold ring', 'Ring', '22K', ids.ringPhoto),
    design(ids.soldRing, 'W16-R2', 'W16 sold out ring', 'Ring', '22K'),
    design(ids.chain, 'W16-C1', 'W16 gold chain', 'Chain', '18K', ids.chainPhoto),
    photo(ids.ringPhoto, ids.ring),
    photo(ids.chainPhoto, ids.chain),
    piece(ids.ring, 'W16-R1-001', '12.500', 'In Stock', ids.firstRingPiece),
    piece(ids.ring, 'W16-R1-002', '10.250', 'In Stock'),
    piece(ids.ring, 'W16-R1-003', '40.000', 'Sold'),
    piece(ids.soldRing, 'W16-R2-001', '9.000', 'Sold'),
    piece(ids.soldRing, 'W16-R2-002', '9.500', 'Sold'),
    piece(ids.chain, 'W16-C1-001', '20.125', 'In Stock'),
    `INSERT INTO sku_private (sku_id, original_net_weight) VALUES ('${ids.firstRingPiece}', ${ORIGINAL_WEIGHT});`,
    `UPDATE designs SET updated_at = CURRENT_TIMESTAMP(6) WHERE design_no LIKE 'W16-%'; UPDATE skus SET updated_at = CURRENT_TIMESTAMP(6) WHERE sku_no LIKE 'W16-%';`,
  ].join(' ');
}

async function cleanLane() {
  await laneSql(
    `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE sku_no LIKE 'W16-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'W16-%'; ` +
      `DELETE FROM bills WHERE bill_no LIKE 'W16-%'; ` +
      `DELETE FROM customers WHERE name LIKE 'W16 %'; ` +
      `DELETE FROM design_photos WHERE design_id IN (SELECT id FROM designs WHERE design_no LIKE 'W16-%'); ` +
      `DELETE FROM designs WHERE design_no LIKE 'W16-%';`
  );
}

test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
});
test.beforeAll(async () => {
  await cleanLane();
  await laneSql(fixtureSql());
});
test.afterAll(async () => {
  await cleanLane();
  const [left] = await laneSql(
    `SELECT (SELECT COUNT(*) FROM designs WHERE design_no LIKE 'W16-%'), (SELECT COUNT(*) FROM skus WHERE sku_no LIKE 'W16-%'), ` +
      `(SELECT COUNT(*) FROM bills WHERE bill_no LIKE 'W16-%'), (SELECT COUNT(*) FROM design_photos WHERE design_id IN ('${ids.ring}', '${ids.chain}'))`
  );
  expect(left).toEqual(['0', '0', '0', '0']);
});

// ------------------------------------------------------------------------------------------------ the page

async function openCatalogue(page: Page, who: E2eLogin) {
  await page.goto('/stock-catalogue');
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Stock Catalogue', level: 1 })).toBeVisible({
    timeout: 60_000,
  });
  // the designs arrive with the hydrate: the screen has the stock when its cards are there
  await expect(page.getByTestId('catalogue-card').first()).toBeVisible({ timeout: 60_000 });
}

/** What Chromium prints of the page as it is on screen now (with JV_PRINT_PDF_DIR set the PDF is also written there, to look at it). */
async function printed(page: Page, name: string) {
  const pdf = await page.pdf({ preferCSSPageSize: true, printBackground: true });
  const dir = process.env.JV_PRINT_PDF_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, `catalogue-${name}.pdf`), pdf);
  }
  return readPdf(pdf);
}

const card = (page: Page, designNo: string) =>
  page.getByTestId('catalogue-card').filter({ hasText: designNo });

test.describe('FB-D2: the ready-stock catalogue by category as a PDF', () => {
  test.describe.configure({ timeout: 180_000 });

  test('the owner chooses Ring: the In Stock rings with their photos, printed as a PDF with no sold-out design, no chain, no price and no original weight', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    await openCatalogue(page, e2eLogin('owner'));

    // every category with stock is offered; before one is chosen the page shows them all
    await expect(
      page.getByTestId('catalogue-category').filter({ hasText: /^Ring$/ })
    ).toBeVisible();
    await expect(
      page.getByTestId('catalogue-category').filter({ hasText: /^Chain$/ })
    ).toBeVisible();
    await expect(card(page, 'W16-C1')).toBeVisible();
    await expect(card(page, 'W16-R1')).toBeVisible();

    // choose Ring: the chain goes, the ring stays
    await page
      .getByTestId('catalogue-category')
      .filter({ hasText: /^Ring$/ })
      .click();
    await expect(card(page, 'W16-C1')).toHaveCount(0);
    await expect(card(page, 'W16-R2')).toHaveCount(0); // every piece of it is Sold
    const ring = card(page, 'W16-R1');
    await expect(ring).toHaveCount(1);
    await expect(ring).toContainText('W16 gold ring');
    await expect(ring).toContainText('22K');
    await expect(ring).toContainText('10.250 - 12.500 g'); // the Sold piece of 40 g is not in the range
    await expect(ring).toContainText('2 pieces in stock');
    // the photo: an img on the API's photo address, and it has loaded
    const image = ring.locator('img');
    await expect(image).toHaveAttribute('src', `${apiUrl}/v1/photos/${ids.ringPhoto}/thumb`);
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    // no price, no original weight, on the screen
    const screenText = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
    expect(screenText).not.toContain('₹');
    expect(screenText).not.toContain(ORIGINAL_WEIGHT);

    // print: the button asks the browser to print; the paper is what Chromium lays out in print media
    await page.evaluate(() => {
      const mine = window as unknown as { __printCalls: number };
      mine.__printCalls = 0;
      window.print = () => {
        mine.__printCalls += 1;
      };
    });
    await page.getByRole('button', { name: 'Print / Save PDF' }).click();
    expect(
      await page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls)
    ).toBe(1);
    const bars = await page.evaluate(() =>
      [...document.querySelectorAll('aside a, aside button, header a, header button, nav a')]
        .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
        .filter(
          (text) =>
            text.length >= 4 && !(document.querySelector('main')?.textContent ?? '').includes(text)
        )
    );
    const pages = await printed(page, 'ring');
    expect(pages.length).toBeGreaterThan(0);
    expect(bars.length, 'the bars were read off the screen').toBeGreaterThan(3);
    const all = (needle: string) => pages.reduce((sum, one) => sum + countIn(one, needle), 0);
    expect(all('W16-R1'), 'the In Stock ring is on the paper once').toBe(1);
    expect(all('W16 gold ring')).toBe(1);
    expect(all('2 pieces in stock')).toBe(1);
    expect(all('10.250 - 12.500 g')).toBe(1);
    expect(all('W16-R2'), 'the sold-out ring is not on the paper').toBe(0);
    expect(all('W16-C1'), 'the chain was not chosen').toBe(0);
    expect(all('₹'), 'no price on the paper').toBe(0);
    expect(all(ORIGINAL_WEIGHT), 'no original weight on the paper').toBe(0);
    for (const word of bars) expect(all(word), `"${word}" (an app bar) on the paper`).toBe(0);
    expect(countIn(pages[0], 'Ring')).toBeGreaterThan(0); // the category heading
  });

  test('choosing both categories prints both, and clearing the choice shows every category again', async ({
    page,
  }) => {
    await openCatalogue(page, e2eLogin('owner'));
    await page
      .getByTestId('catalogue-category')
      .filter({ hasText: /^Ring$/ })
      .click();
    await page
      .getByTestId('catalogue-category')
      .filter({ hasText: /^Chain$/ })
      .click();
    await expect(card(page, 'W16-R1')).toHaveCount(1);
    await expect(card(page, 'W16-C1')).toHaveCount(1);
    const chain = card(page, 'W16-C1');
    await expect(chain).toContainText('18K');
    await expect(chain).toContainText('20.125 g');
    await expect(chain).toContainText('1 piece in stock');
    const pages = await printed(page, 'ring-and-chain');
    expect(pages.reduce((sum, one) => sum + countIn(one, 'W16-C1'), 0)).toBe(1);
    expect(pages.reduce((sum, one) => sum + countIn(one, 'W16-R1'), 0)).toBe(1);
    // the chain is listed before the ring (by category)
    expect(pages[0].compact.indexOf('W16-C1')).toBeLessThan(pages[0].compact.indexOf('W16-R1'));
    // Clear: nothing chosen, every category with stock is shown again
    await page.getByRole('button', { name: 'Clear' }).click();
    await expect(
      page.getByText('No category chosen: every category with stock is shown.')
    ).toBeVisible();
    await expect(card(page, 'W16-R1')).toHaveCount(1);
    await expect(card(page, 'W16-C1')).toHaveCount(1);
    await expect(card(page, 'W16-R2')).toHaveCount(0);
  });

  for (const role of ['biller', 'staff'] as const) {
    test(`the ${role} can open it too`, async ({ page }) => {
      await openCatalogue(page, e2eLogin(role));
      await expect(card(page, 'W16-R1')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Print / Save PDF' })).toBeVisible();
      // and it is in the menu, under Inventory
      await expect(
        page.locator('aside').getByRole('link', { name: 'Stock Catalogue (PDF)' })
      ).toBeVisible();
    });
  }
});

// FB-D fix: the phone width of the plan, 375 x 812. The screen renders, the category chip and Print / Save PDF take a tap, the cards are whole inside the screen and the page does not scroll sideways.
test.describe('FB-D fix: the catalogue at 375 x 812', () => {
  test.use({ viewport: PHONE });
  test.describe.configure({ timeout: 180_000 });

  test('renders, the chips and Print / Save PDF are tappable, the photo is whole inside the screen, no sideways scroll', async ({
    page,
  }) => {
    await openCatalogue(page, e2eLogin('owner'));
    await expect(card(page, 'W16-R1')).toBeVisible();
    const chip = page.getByTestId('catalogue-category').filter({ hasText: /^Ring$/ });
    await expectTappable(chip);
    await chip.click(); // a real tap, not only a trial
    await expect(card(page, 'W16-C1')).toHaveCount(0);
    const ring = card(page, 'W16-R1');
    await ring.scrollIntoViewIfNeeded();
    const box = (await ring.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(PHONE.width);
    const image = ring.locator('img');
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    await expectTappable(page.getByRole('button', { name: 'Print / Save PDF' }));
    await expectNoSidewaysScroll(page);
    await shoot(page, 'stock-catalogue');
  });
});
