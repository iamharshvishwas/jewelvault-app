import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { compact, readMadePdf } from '../unit/support/pdf-read';
import { clearLoginCounters } from './clear-counters';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';
import { pressDownloadPdf, sharedCalls, stubShare } from './pdf-file';
import { PHONE, expectNoSidewaysScroll, expectTappable, shoot } from './phone';
import { roomInTheMinute } from './pacing';
import { countIn, readPdf } from './pdf-text';

// FB-D2 (Siddhi #6): the ready-stock catalogue, a screen of the designs that have a piece In Stock, by category, with the first photo, printed or saved as a PDF, in a real browser against the real API
// of a lane.
//   the owner opens /stock-catalogue, chooses `Ring`, and the page shows each In Stock ring with its photo (an img on the API's photo address, loaded), its number, purity, gross-weight range and number of
//   pieces; the PDF Chromium makes of it has the number of each In Stock ring, no ring that is Sold out, no chain (not chosen), no price and no original weight; the biller and the staff open it too
// PDF-S2 (PDF-6): Download PDF makes the catalogue as a PDF file in the browser (src/lib/pdf/cataloguePdf.ts), with the photos the page fetches from the API (another origin): chosen `Ring`, the file is
//   `Stock Catalogue - Ring - {DD-MM-YYYY}.pdf` and holds the In Stock ring with the API's own photo and nothing else; slow photos are counted on the screen and Stop ends it with nothing saved; a photo
//   that answers 404 is `No photo` while the others arrive, and when every photo answers 404 no file is saved and the make-failed words show; Share hands over one PDF file of the same name; at
//   375 x 812 the buttons take a tap; the biller and the staff have Download PDF too
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

/**
 * A 1 x 1 gold baseline JPEG (`image/jpeg`), as the shop's photos are (the website's canvas writes JPEGs): a real picture the browser draws and pdfmake can open (PDF-6). The 1 x 1 PNG it
 * replaces was cut short (its picture data is not the length its chunk says): a browser drew it, but the PDF would have shown `No photo`.
 */
const JPEG_HEX =
  'FFD8FFE000104A46494600010100000100010000FFDB004300080606070605080707070909080A0C140D0C0B0B0C1912130F141D1A1F1E1D1A1C1C20242E2720222C231C1C2837292C30313434341F27393D38323C2E333432' +
  'FFDB0043010909090C0B0C180D0D1832211C213232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232323232FFC00011080001000103011100021101031101' +
  'FFC40014000100000000000000000000000000000006FFC40014100100000000000000000000000000000000FFC4001501010100000000000000000000000000000506FFC40014110100000000000000000000000000000000' +
  'FFDA000C03010002110311003F00408336FFD9';

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
          `('${photoId}', '${kind}', '${designId}', 'image/jpeg', ${JPEG_HEX.length / 2}, UNHEX(SHA2(UNHEX('${JPEG_HEX}'), 256)), UNHEX('${JPEG_HEX}'));`
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

/** Stands in for the browser's print dialog: it counts the calls and notes how many pictures of the sheet were not yet loaded at the time of the call. It fires no `afterprint`. */
async function stubPrint(page: Page) {
  await page.evaluate(() => {
    const mine = window as unknown as { __printCalls: number; __printIncomplete: number };
    mine.__printCalls = 0;
    mine.__printIncomplete = -1;
    window.print = () => {
      mine.__printCalls += 1;
      mine.__printIncomplete = [
        ...document.querySelectorAll<HTMLImageElement>('.print-catalogue-sheet img'),
      ].filter((img) => !(img.complete && img.naturalWidth > 0)).length;
    };
  });
}
const printCalls = (page: Page) =>
  page.evaluate(() => (window as unknown as { __printCalls: number }).__printCalls);
const printIncomplete = (page: Page) =>
  page.evaluate(() => (window as unknown as { __printIncomplete: number }).__printIncomplete);

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
    // Wave 2 fix 2: on the screen a photo is lazy and decoded off the main thread (a big shop does not fetch every photo at once)
    await expect(image).toHaveAttribute('loading', 'lazy');
    await expect(image).toHaveAttribute('decoding', 'async');
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true);
    // no price, no original weight, on the screen
    const screenText = (await page.getByRole('main').innerText()).replace(/\s+/g, ' ');
    expect(screenText).not.toContain('₹');
    expect(screenText).not.toContain(ORIGINAL_WEIGHT);

    // print: the button gets the sheet ready (the full pictures, eager), waits for them and then asks the browser to print; the paper is what Chromium lays out in print media
    await stubPrint(page);
    await page.getByRole('button', { name: 'Print', exact: true }).click();
    await expect.poll(() => printCalls(page)).toBe(1);
    // the print waited for the pictures: every one of them was loaded when the browser was asked
    expect(await printIncomplete(page), 'pictures not yet loaded when the print was asked').toBe(0);
    // the paper has the full picture (M3: a thumbnail is soft on paper), loaded eagerly
    await expect(image).toHaveAttribute('src', `${apiUrl}/v1/photos/${ids.ringPhoto}/full`);
    await expect(image).toHaveAttribute('loading', 'eager');
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
    // when the print is over the screen goes back to the thumbnail, lazy
    await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
    await expect(image).toHaveAttribute('src', `${apiUrl}/v1/photos/${ids.ringPhoto}/thumb`);
    await expect(image).toHaveAttribute('loading', 'lazy');
  });

  // a photo that cannot be had must not stop a paper: the print is asked for all the same
  test('a photo that fails to load does not hold the print back', async ({ page }) => {
    const { apiUrl } = e2eLane();
    await page.route(`${apiUrl}/v1/photos/*/full`, (route) => route.abort());
    await openCatalogue(page, e2eLogin('owner'));
    await stubPrint(page);
    await page.getByRole('button', { name: 'Print', exact: true }).click();
    await expect.poll(() => printCalls(page), { timeout: 10_000 }).toBe(1);
    await expect(card(page, 'W16-R1').locator('img')).toHaveAttribute(
      'src',
      `${apiUrl}/v1/photos/${ids.ringPhoto}/full`
    );
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
      await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
      // and it is in the menu, under Inventory
      await expect(
        page.locator('aside').getByRole('link', { name: 'Stock Catalogue (PDF)' })
      ).toBeVisible();
    });
  }
});

// FB-D fix: the phone width of the plan, 375 x 812. The screen renders, the category chip and Print take a tap, the cards are whole inside the screen and the page does not scroll sideways.
test.describe('FB-D fix: the catalogue at 375 x 812', () => {
  test.use({ viewport: PHONE });
  test.describe.configure({ timeout: 180_000 });

  test('renders, the chips and Print are tappable, the photo is whole inside the screen, no sideways scroll', async ({
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
    await expectTappable(page.getByRole('button', { name: 'Print', exact: true }));
    await expectNoSidewaysScroll(page);
    await shoot(page, 'stock-catalogue');
  });
});

// ------------------------------------------------------------------------------------------------ PDF-S2: the catalogue as a PDF file

/** Today's business date (India) as the file name writes it, DD-MM-YYYY: the screen's `useBusinessToday`, by the same clock. */
function businessDay(): string {
  const [year, month, day] = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
    .format(new Date())
    .split('-');
  return `${day}-${month}-${year}`;
}

/** The names the Ring catalogue may have: the day is read before and after the PDF is made, in case midnight in India falls in between. */
const ringFileNames = (before: string, after: string) =>
  [...new Set([before, after])].map((day) => `Stock Catalogue - Ring - ${day}.pdf`);

async function chooseRing(page: Page) {
  await page
    .getByTestId('catalogue-category')
    .filter({ hasText: /^Ring$/ })
    .click();
  await expect(card(page, 'W16-C1')).toHaveCount(0);
  await expect(card(page, 'W16-R1')).toHaveCount(1);
}

test.describe('PDF-S2: the stock catalogue as a PDF file', () => {
  test.describe.configure({ timeout: 240_000 });

  test('Ring chosen, Download PDF: the file is named after Ring and the day, and holds the In Stock ring with the photo fetched from the API, no sold-out design, no chain, no price, no original weight', async ({
    page,
  }) => {
    const { apiUrl, webOrigin } = e2eLane();
    const thumb = `${apiUrl}/v1/photos/${ids.ringPhoto}/thumb`;
    await openCatalogue(page, e2eLogin('owner'));
    await chooseRing(page);
    // the screen has drawn the ring's thumbnail already (an img, no CORS): the PDF's own fetch of it must still be answered for the site's origin
    await expect
      .poll(() =>
        card(page, 'W16-R1')
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0)
      )
      .toBe(true);
    const fetched: { status: number; allowOrigin: string | null }[] = [];
    page.on('response', (response) => {
      if (response.url() === thumb && response.request().resourceType() === 'fetch') {
        fetched.push({
          status: response.status(),
          allowOrigin: response.headers()['access-control-allow-origin'] ?? null,
        });
      }
    });
    await expect(page.getByTestId('catalogue-pdf-download')).toHaveText('Download PDF');

    const before = businessDay();
    const { name, bytes } = await pressDownloadPdf(page, 'catalogue-pdf');
    expect(ringFileNames(before, businessDay())).toContain(name);
    expect(new TextDecoder('latin1').decode(bytes.slice(0, 5))).toBe('%PDF-');

    const pdf = await readMadePdf(bytes);
    const text = compact(pdf.pages.join('\n'));
    expect(text, 'the In Stock ring').toContain('W16-R1');
    expect(text).toContain(compact('W16 gold ring'));
    expect(text).toContain(compact('Gross 10.250 - 12.500 g'));
    expect(text).toContain(compact('2 pieces in stock'));
    expect(text, 'the sold-out ring').not.toContain('W16-R2');
    expect(text, 'the chain was not chosen').not.toContain('W16-C1');
    expect(text, 'no price').not.toContain('₹');
    expect(text, 'no original weight').not.toContain(ORIGINAL_WEIGHT);
    expect(text, 'the ring has its photo').not.toContain(compact('No photo'));
    // the ring's photo is in the file, once, and it is the API's own picture byte for byte (pdfmake stores a JPEG as it is)
    expect(pdf.imageCount).toBe(1);
    expect(Buffer.from(bytes).indexOf(Buffer.from(JPEG_HEX, 'hex'))).toBeGreaterThan(0);
    // the page fetched it from the API, across origins, and the API answered for the site
    expect(fetched).toEqual([{ status: 200, allowOrigin: webOrigin }]);

    // the buttons are back, and nothing went wrong
    await expect(page.getByTestId('catalogue-pdf-download')).toBeEnabled();
    await expect(page.getByTestId('catalogue-pdf-progress')).toHaveCount(0);
    await expect(page.getByTestId('catalogue-pdf-error')).toHaveCount(0);
  });

  test('slow photos: the busy words count them, Stop ends it, nothing is saved and Download PDF is back', async ({
    page,
  }) => {
    const { apiUrl } = e2eLane();
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    await openCatalogue(page, e2eLogin('owner'));
    await chooseRing(page);
    // every thumbnail is held back 2 seconds from now on
    await page.route(`${apiUrl}/v1/photos/*/thumb`, async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      // the page may have stopped asking by then
      await route.continue().catch(() => {});
    });

    await page.getByTestId('catalogue-pdf-download').click();
    const progress = page.getByTestId('catalogue-pdf-progress');
    await expect(progress).toHaveText('Making PDF… photos 0 of 1');
    await expect(progress).toHaveAttribute('role', 'status');
    const stop = page.getByTestId('catalogue-pdf-stop');
    await expect(stop).toHaveText('Stop');
    await stop.click();
    await expect(progress).toHaveCount(0);
    await expect(stop).toHaveCount(0);

    // the photo arrives (or not) after Stop: no PDF comes of it
    await page.waitForTimeout(3_000);
    expect(downloads, 'no file is saved after Stop').toBe(0);
    await expect(page.getByTestId('catalogue-pdf-download')).toBeEnabled();
    await expect(page.getByTestId('catalogue-pdf-error')).toHaveCount(0);
  });

  test('a photo the API answers 404 while the others arrive: the PDF is saved all the same, with No photo in its place', async ({
    page,
  }) => {
    const { apiUrl, webOrigin } = e2eLane();
    await openCatalogue(page, e2eLogin('owner'));
    await chooseRing(page);
    await page
      .getByTestId('catalogue-category')
      .filter({ hasText: /^Chain$/ })
      .click();
    await expect(card(page, 'W16-C1')).toHaveCount(1);
    // the ring's photo is a real 404 for the site (with the CORS header), not a network error; the chain's photo arrives
    await page.route(`${apiUrl}/v1/photos/${ids.ringPhoto}/thumb`, (route) =>
      route.fulfill({
        status: 404,
        headers: { 'access-control-allow-origin': webOrigin },
        contentType: 'application/json',
        body: '{"error":{"code":"JV_NOT_FOUND"}}',
      })
    );

    const before = businessDay();
    const { name, bytes } = await pressDownloadPdf(page, 'catalogue-pdf');
    expect(
      [...new Set([before, businessDay()])].map(
        (day) => `Stock Catalogue - Ring, Chain - ${day}.pdf`
      )
    ).toContain(name);
    const pdf = await readMadePdf(bytes);
    const text = compact(pdf.pages.join('\n'));
    expect(text).toContain('W16-R1');
    expect(text).toContain(compact('2 pieces in stock'));
    expect(text, 'the ring whose photo failed').toContain(compact('No photo'));
    expect(text).toContain('W16-C1');
    // the chain's photo is in the file, the API's own picture byte for byte
    expect(pdf.imageCount).toBeGreaterThanOrEqual(1);
    expect(Buffer.from(bytes).indexOf(Buffer.from(JPEG_HEX, 'hex'))).toBeGreaterThan(0);
    await expect(page.getByTestId('catalogue-pdf-error')).toHaveCount(0);
  });

  test('every photo the API answers 404: no file is saved, the make-failed words show, and Download PDF is back', async ({
    page,
  }) => {
    const { apiUrl, webOrigin } = e2eLane();
    let downloads = 0;
    page.on('download', () => (downloads += 1));
    await openCatalogue(page, e2eLogin('owner'));
    await chooseRing(page);
    await page.route(`${apiUrl}/v1/photos/*/thumb`, (route) =>
      route.fulfill({
        status: 404,
        headers: { 'access-control-allow-origin': webOrigin },
        contentType: 'application/json',
        body: '{"error":{"code":"JV_NOT_FOUND"}}',
      })
    );

    const download = page.getByTestId('catalogue-pdf-download');
    await download.click();
    const error = page.getByTestId('catalogue-pdf-error');
    await expect(error).toHaveText('The PDF could not be made. Please try again.', {
      timeout: 120_000,
    });
    await expect(error).toHaveAttribute('role', 'alert');
    await expect(page.getByTestId('catalogue-pdf-progress')).toHaveCount(0);
    await expect(download).toBeEnabled();
    // a moment more: still no file (a paper of `No photo` cards only is never saved)
    await page.waitForTimeout(1_500);
    expect(downloads, 'no file is saved').toBe(0);
  });

  test('Share hands the share menu one PDF file, with the same name as Download PDF gives', async ({
    page,
  }) => {
    await stubShare(page);
    await openCatalogue(page, e2eLogin('owner'));
    await chooseRing(page);
    const { name } = await pressDownloadPdf(page, 'catalogue-pdf');

    const share = page.getByTestId('catalogue-pdf-share');
    await expect(share).toHaveText('Share');
    await share.click();
    await expect.poll(async () => (await sharedCalls(page)).length, { timeout: 120_000 }).toBe(1);
    const [call] = await sharedCalls(page);
    expect(call.title).toBe('Stock Catalogue');
    expect(call.files).toHaveLength(1);
    expect(call.files[0].name).toBe(name);
    expect(call.files[0].type).toBe('application/pdf');
    expect(call.files[0].size).toBeGreaterThan(1000);
    // shared: the buttons are as they were
    await expect(share).toBeVisible();
    await expect(page.getByTestId('catalogue-pdf-send')).toHaveCount(0);
    await expect(page.getByTestId('catalogue-pdf-error')).toHaveCount(0);
  });

  test.describe('at 375 x 812', () => {
    test.use({ viewport: PHONE });

    test('the chips, Download PDF, Share and Print take a tap, no sideways scroll', async ({
      page,
    }) => {
      await stubShare(page);
      await openCatalogue(page, e2eLogin('owner'));
      const controls = [
        page.getByTestId('catalogue-category').filter({ hasText: /^Ring$/ }),
        page.getByTestId('catalogue-category').filter({ hasText: /^Chain$/ }),
        page.getByTestId('catalogue-pdf-download'),
        page.getByTestId('catalogue-pdf-share'),
        page.getByRole('button', { name: 'Print', exact: true }),
      ];
      for (const control of controls) {
        await expectTappable(control);
        // one line each (FB-A2): a word that wraps makes a button two lines tall
        expect((await control.boundingBox())!.height).toBeLessThanOrEqual(44);
      }
      await expectNoSidewaysScroll(page);
      await page.evaluate(() => document.querySelector('main')?.scrollTo(0, 0));
      await shoot(page, 'catalogue-pdf-buttons');
    });
  });

  for (const role of ['biller', 'staff'] as const) {
    test(`the ${role} has Download PDF too`, async ({ page }) => {
      await openCatalogue(page, e2eLogin(role));
      const download = page.getByTestId('catalogue-pdf-download');
      await expect(download).toHaveText('Download PDF');
      await expect(download).toBeEnabled();
      await expect(page.getByRole('button', { name: 'Print', exact: true })).toBeVisible();
    });
  }
});
