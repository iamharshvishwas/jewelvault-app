import { execFile, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page } from '@playwright/test';
import QRCode from 'qrcode';
import { clearLoginCounters } from './clear-counters';
import { e2eLogin, type E2eLogin } from './global-setup';
import { roomInTheMinute } from './pacing';

// FB-B2 (Siddhi #9): the phone camera reads the tag, on the scan screen and on the billing screen, in a real browser against the real API of a lane.
//   - Chromium's fake camera plays a short video of the QR of a piece's barcode (what the tag's QR carries). The video is made inside the run, in a temporary folder, from a PNG of the QR
//     with ffmpeg (a .y4m of a few megabytes is never committed); without ffmpeg the camera tests are skipped, with the reason.
//   - /scan-detail (owner): "Scan with camera" -> the piece's design number appears. /billing-pos (owner): the same button -> the line is on the bill.
//   - each is run twice: with the browser's own reader (BarcodeDetector, where this Chromium has one) and with @zxing/browser (BarcodeDetector removed from the page)
//   - the camera refused: the message "Camera not available — type the code" and the typed box still works, on both screens (Review Focus 4)
//
// The piece is written as root in the lane's container (the screens that make pieces are other tasks') and taken out again.
//
// Run: E2E=1 LANE=b JV_API_DIR=<checkout of jewelvault-api> npx playwright test tests/e2e/scan-camera.spec.ts

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

// ------------------------------------------------------------------------------------------------ the piece the camera reads

const DESIGN_NO = 'FBB-D1';
const SKU_NO = 'FBB-D1-001';
const BARCODE = 'FBBBC-D1-001';

async function cleanLane() {
  await laneSql(
    `DELETE FROM skus WHERE sku_no LIKE 'FBB-%'; DELETE FROM designs WHERE design_no LIKE 'FBB-%';`
  );
}

async function fixture() {
  const design = randomUUID();
  await laneSql(
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) ` +
      `SELECT '${design}', '${DESIGN_NO}', 'FBB camera ring', id, 'Gold', '22K', 'By Weight' FROM categories WHERE name = 'Ring'; ` +
      `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) ` +
      `VALUES ('${randomUUID()}', '${design}', '${SKU_NO}', '${BARCODE}', 5.500, 5.000, 'In Stock');`
  );
}

// ------------------------------------------------------------------------------------------------ the fake camera

/** ffmpeg: on the PATH, or where Homebrew puts it. */
function findFfmpeg(): string | null {
  for (const candidate of ['ffmpeg', '/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg']) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // not there
    }
  }
  return null;
}
const FFMPEG = findFfmpeg();

/** Where this worker's fake-camera video goes: a temporary folder of its own, made in `beforeAll` and removed in `afterAll`. */
const CAMERA_DIR = path.join(os.tmpdir(), `jv-fbb-scan-camera-${process.pid}`);
const CAMERA_FILE = path.join(CAMERA_DIR, 'qr.y4m');

/** The QR of the piece's barcode, as a PNG, then as a 640x480 video of two seconds (Chromium plays the file over and over). */
async function makeCameraVideo(text: string) {
  mkdirSync(CAMERA_DIR, { recursive: true });
  const png = path.join(CAMERA_DIR, 'qr.png');
  writeFileSync(
    png,
    await QRCode.toBuffer(text, { errorCorrectionLevel: 'M', margin: 4, width: 600 })
  );
  await execFileAsync(
    FFMPEG as string,
    [
      '-y',
      '-loglevel',
      'error',
      '-loop',
      '1',
      '-i',
      png,
      '-t',
      '2',
      '-r',
      '10',
      '-vf',
      'scale=480:480,pad=640:480:80:0:white',
      '-pix_fmt',
      'yuv420p',
      CAMERA_FILE,
    ],
    { timeout: 60_000 }
  );
  expect(existsSync(CAMERA_FILE)).toBe(true);
}

// ------------------------------------------------------------------------------------------------ the pages

const aside = (page: Page) => page.locator('aside').first();

/** Opens a page of the application as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, target: string, ready: () => Promise<void>) {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(aside(page)).toContainText(who.fullName, { timeout: 60_000 });
  await ready();
}

const openScan = (page: Page) =>
  open(page, e2eLogin('owner'), '/scan-detail', () =>
    expect(page.getByRole('heading', { name: 'Scan Article' })).toBeVisible({ timeout: 60_000 })
  );
const openBilling = (page: Page) =>
  open(page, e2eLogin('owner'), '/billing-pos', () =>
    expect(page.getByRole('heading', { name: 'New Estimate' })).toBeVisible({ timeout: 60_000 })
  );

const SCAN_BOX = 'Enter SKU number or barcode';
const BILL_BOX = 'Enter SKU number or scan barcode...';
const row = (page: Page) => page.locator(`tr[data-sku="${SKU_NO}"]`);
const DENIED = 'Camera not available — type the code';

// Chromium's fake camera plays the video, and the fake permission answer says yes (a headless Chromium cannot ask). The tests of a refused camera make the page's own camera call fail, as a
// person's "Block" does.
test.use({
  launchOptions: {
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-video-capture=${CAMERA_FILE}`,
    ],
  },
});
test.beforeAll(async () => {
  if (FFMPEG) await makeCameraVideo(BARCODE);
});
test.afterAll(() => {
  rmSync(CAMERA_DIR, { recursive: true, force: true });
});

test.beforeEach(async ({ page }) => {
  await clearLoginCounters();
  await roomInTheMinute(page);
  await cleanLane();
  await fixture();
});
test.afterEach(async () => {
  await cleanLane();
});

// ------------------------------------------------------------------------------------------------ the camera reads the tag

for (const reader of [
  'the browser reader (BarcodeDetector, if this Chromium has one)',
  '@zxing/browser',
] as const) {
  const zxing = reader === '@zxing/browser';

  test.describe(`FB-B2: the fake camera shows the QR of a piece, read with ${reader}`, () => {
    test.describe.configure({ timeout: 180_000 });
    test.skip(!FFMPEG, 'ffmpeg is not installed here, so the fake-camera video cannot be made');
    test.use({ permissions: ['camera'] });

    test.beforeEach(async ({ page }) => {
      if (zxing) {
        // this page has no BarcodeDetector: the scanner chooses @zxing/browser
        await page.addInitScript(() => {
          delete (window as unknown as { BarcodeDetector?: unknown }).BarcodeDetector;
        });
      }
    });

    /** The native reader is only tested where this Chromium has one that reads Code 128 and QR. */
    async function skipWithoutNativeReader(page: Page) {
      if (zxing) return;
      const formats = await page.evaluate(async () => {
        const detector = (
          window as unknown as {
            BarcodeDetector?: { getSupportedFormats(): Promise<string[]> };
          }
        ).BarcodeDetector;
        return detector ? await detector.getSupportedFormats() : null;
      });
      test.skip(
        !formats || !formats.includes('qr_code') || !formats.includes('code_128'),
        'this Chromium has no BarcodeDetector that reads QR and Code 128, so the native path cannot run here'
      );
    }

    test('/scan-detail (owner): "Scan with camera" shows the piece, with its design number', async ({
      page,
    }) => {
      await openScan(page);
      await skipWithoutNativeReader(page);
      await page.getByRole('button', { name: /Scan with camera/ }).click();
      await expect(page.getByTestId('camera-scanner')).toBeVisible();
      const main = page.getByRole('main');
      await expect(main).toContainText('Available in Inventory', { timeout: 60_000 });
      await expect(main).toContainText(DESIGN_NO);
      await expect(main).toContainText(SKU_NO);
      // the camera is let go once the piece is shown
      await expect(page.getByTestId('camera-scanner')).toHaveCount(0);
    });

    test('/billing-pos (owner): "Scan with camera" adds the line once, as a scan would, and Stop closes the camera', async ({
      page,
    }) => {
      await openBilling(page);
      await skipWithoutNativeReader(page);
      await page.getByRole('button', { name: /Scan with camera/ }).click();
      await expect(page.getByTestId('camera-scanner')).toBeVisible();
      await expect(row(page)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('scan-added')).toContainText(BARCODE);
      // the code stays in front of the camera: it is read once, the line is not added again and no "already on this bill" is said
      await page.waitForTimeout(3_000);
      await expect(row(page)).toHaveCount(1);
      await expect(page.getByTestId('scan-refused')).toHaveCount(0);
      await page.getByRole('button', { name: 'Stop' }).click();
      await expect(page.getByTestId('camera-scanner')).toHaveCount(0);
      await expect(row(page)).toHaveCount(1);
    });
  });
}

// ------------------------------------------------------------------------------------------------ no camera, or a camera refused (Review Focus 4)

test.describe('FB-B2: the camera is refused or there is none: a plain message, and the typed box still works', () => {
  test.describe.configure({ timeout: 180_000 });

  test.describe('permission refused', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
    });

    test('/scan-detail: the message, then a typed code shows the piece', async ({ page }) => {
      await openScan(page);
      await page.getByRole('button', { name: /Scan with camera/ }).click();
      await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED), {
        timeout: 30_000,
      });
      await page.getByPlaceholder(SCAN_BOX).fill(BARCODE);
      await page.getByRole('main').getByRole('button', { name: 'Search' }).click();
      await expect(page.getByRole('main')).toContainText(DESIGN_NO);
      await expect(page.getByRole('main')).toContainText('Available in Inventory');
    });

    test('/billing-pos: the message, then a typed code adds the line', async ({ page }) => {
      await openBilling(page);
      await page.getByRole('button', { name: /Scan with camera/ }).click();
      await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED), {
        timeout: 30_000,
      });
      await page.getByPlaceholder(BILL_BOX).fill(BARCODE);
      await page.keyboard.press('Enter');
      await expect(row(page)).toBeVisible();
    });
  });

  test.describe('no camera on the device (a desktop with none, or a page that is not secure)', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
      });
    });

    test('/billing-pos: the same message, and a typed piece number adds the line', async ({
      page,
    }) => {
      await openBilling(page);
      await page.getByRole('button', { name: /Scan with camera/ }).click();
      await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED));
      await page.getByPlaceholder(BILL_BOX).fill(SKU_NO);
      await page.keyboard.press('Enter');
      await expect(row(page)).toBeVisible();
    });

    test('/scan-detail: the same message, and a typed piece number shows the piece', async ({
      page,
    }) => {
      await openScan(page);
      await page.getByRole('button', { name: /Scan with camera/ }).click();
      await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED));
      await page.getByPlaceholder(SCAN_BOX).fill(SKU_NO);
      await page.getByRole('main').getByRole('button', { name: 'Search' }).click();
      await expect(page.getByRole('main')).toContainText(DESIGN_NO);
    });
  });
});

// ------------------------------------------------------------------------------------------------ FB-B fix 1: a hand-over that fails still says "type the code"

test.describe('FB-B fix: the browser reader never answers and @zxing/browser cannot be loaded (offline): the message, not a dead picture', () => {
  test.describe.configure({ timeout: 180_000 });
  test.skip(!FFMPEG, 'ffmpeg is not installed here, so the fake-camera video cannot be made');
  test.use({ permissions: ['camera'] });

  test.beforeEach(async ({ page }) => {
    // a BarcodeDetector that is there, reads the formats, and never answers a look
    await page.addInitScript(() => {
      (window as unknown as { BarcodeDetector: unknown }).BarcodeDetector = class {
        static getSupportedFormats() {
          return Promise.resolve(['code_128', 'qr_code']);
        }
        detect() {
          return new Promise(() => undefined);
        }
      };
    });
  });

  /** From here on no script of the site can be fetched: the code of @zxing/browser, loaded when it is first needed, does not arrive. */
  const goOffline = (page: Page) =>
    page.route(
      (url) => url.pathname.startsWith('/_next/static/'),
      (route) => route.abort('failed')
    );

  test('/billing-pos: after the first look gets no answer the message appears, the camera is let go, and the typed box works', async ({
    page,
  }) => {
    await openBilling(page);
    await goOffline(page);
    await page.getByRole('button', { name: /Scan with camera/ }).click();
    await expect(page.getByTestId('camera-scanner')).toBeVisible();
    await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED), {
      timeout: 30_000,
    });
    await expect(page.getByTestId('camera-scanner')).toHaveCount(0);
    await page.getByPlaceholder(BILL_BOX).fill(BARCODE);
    await page.keyboard.press('Enter');
    await expect(row(page)).toBeVisible();
  });

  test('/scan-detail: the same message, and a typed code shows the piece', async ({ page }) => {
    await openScan(page);
    await goOffline(page);
    await page.getByRole('button', { name: /Scan with camera/ }).click();
    await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED), {
      timeout: 30_000,
    });
    await page.getByPlaceholder(SCAN_BOX).fill(BARCODE);
    await page.getByRole('main').getByRole('button', { name: 'Search' }).click();
    await expect(page.getByRole('main')).toContainText(DESIGN_NO);
  });
});

// ------------------------------------------------------------------------------------------------ FB-B fix 3: a phone, 375 x 812

test.describe('FB-B fix: the camera on a phone (375 x 812)', () => {
  test.describe.configure({ timeout: 180_000 });
  test.use({ viewport: { width: 375, height: 812 }, hasTouch: true, permissions: ['camera'] });

  /** Nothing of the page is wider than the phone, and the element lies inside it. */
  async function fitsThePhone(page: Page, testId: string) {
    const box = await page.getByTestId(testId).boundingBox();
    expect(box, `${testId} is drawn`).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    const wide = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth
    );
    expect(wide, 'no sideways scroll').toBeLessThanOrEqual(1);
  }

  test.describe('the camera works', () => {
    test.skip(!FFMPEG, 'ffmpeg is not installed here, so the fake-camera video cannot be made');

    test('/billing-pos: the button is tappable, the picture fits the phone, the line is added, Stop closes it', async ({
      page,
    }) => {
      await openBilling(page);
      const button = page.getByRole('button', { name: /Scan with camera/ });
      await button.scrollIntoViewIfNeeded();
      const size = await button.boundingBox();
      expect(size!.height, 'a finger can hit it').toBeGreaterThanOrEqual(28);
      await button.tap();
      await expect(page.getByTestId('camera-scanner')).toBeVisible();
      await fitsThePhone(page, 'camera-scanner');
      await expect(row(page)).toBeVisible({ timeout: 60_000 });
      await expect(page.getByTestId('scan-added')).toContainText(BARCODE);
      await page.getByRole('button', { name: 'Stop' }).tap();
      await expect(page.getByTestId('camera-scanner')).toHaveCount(0);
    });

    test('/scan-detail: the button, the picture and the piece fit the phone', async ({ page }) => {
      await openScan(page);
      await page.getByRole('button', { name: /Scan with camera/ }).tap();
      await expect(page.getByTestId('camera-scanner')).toBeVisible();
      await fitsThePhone(page, 'camera-scanner');
      await expect(page.getByRole('main')).toContainText(DESIGN_NO, { timeout: 60_000 });
      const wide = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth
      );
      expect(wide, 'no sideways scroll').toBeLessThanOrEqual(1);
    });
  });

  test.describe('the camera is refused', () => {
    test.beforeEach(async ({ page }) => {
      await page.addInitScript(() => {
        navigator.mediaDevices.getUserMedia = () =>
          Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
      });
    });

    test('/billing-pos: the message fits the phone and the typed box still adds the line', async ({
      page,
    }) => {
      await openBilling(page);
      await page.getByRole('button', { name: /Scan with camera/ }).tap();
      await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED), {
        timeout: 30_000,
      });
      await fitsThePhone(page, 'camera-unavailable');
      await page.getByPlaceholder(BILL_BOX).fill(BARCODE);
      await page.keyboard.press('Enter');
      await expect(row(page)).toBeVisible();
    });

    test('/scan-detail: the message fits the phone and the typed box still shows the piece', async ({
      page,
    }) => {
      await openScan(page);
      await page.getByRole('button', { name: /Scan with camera/ }).tap();
      await expect(page.getByTestId('camera-unavailable')).toHaveText(new RegExp(DENIED), {
        timeout: 30_000,
      });
      await fitsThePhone(page, 'camera-unavailable');
      // the phone's keyboard sends Enter ("Go"); the Search button shows only its icon at this width
      await page.getByPlaceholder(SCAN_BOX).fill(BARCODE);
      await page.keyboard.press('Enter');
      await expect(page.getByRole('main')).toContainText(DESIGN_NO);
    });
  });
});
