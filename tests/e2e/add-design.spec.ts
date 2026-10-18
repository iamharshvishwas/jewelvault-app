import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { expect, test, type Page, type Request } from '@playwright/test';
import { e2eLane, e2eLogin, type E2eLogin } from './global-setup';

// WEB06: Add Design with photos, create_design (X8) and set_sku_status (X9) from the screens, in a real browser against the real API of a lane (spec P2, P3, P4, X8, X9, D9,
// C6, C7, C11, C13).
//   PT-W6  Add Design with three photos end to end: each picture is resized in the browser (longest side 1000 px, JPEG quality 72, a thumbnail of 320 px), both kinds are uploaded
//          under one id BEFORE create_design is called, a fourth photo is refused with a plain message, the photos open in the gallery from the API, a staff login has no
//          original-weight field and the owner has one, the pieces carry the numbers the API assigned, and a double click on Save makes one design
//   T-C01  (clause) the browser sends the design's id and its photos' ids and no number, barcode, status or location of its own making
//   T-D03  (clause) a staff body holds no original weight, and no weight row is made for staff; the owner's weight is kept
//   X9     a status change and an Archive from the stock screen are one call each, shown after the API has answered; a Sold piece cannot be changed
//
// The four photos are Siddhi's product photos from Client/design/ (960 x 1280). Where that folder is not there, pictures are drawn in the browser.
// Everything these tests make is taken out of the lane's database again (as root, in the lane's own container).
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/add-design.spec.ts

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------------------------------------ the page

const aside = (page: Page) => page.locator('aside').first();

async function submitLogin(page: Page, who: E2eLogin) {
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

async function expectApp(page: Page, who: E2eLogin, timeout = 60_000) {
  await expect(aside(page)).toContainText(who.fullName, { timeout });
}

/** Opens a page of the application as a person (the login screen first, so the memory is the one of a fresh start). */
async function open(page: Page, who: E2eLogin, target: string) {
  await page.goto(target);
  await expect(page.getByLabel('Email')).toBeVisible();
  await submitLogin(page, who);
  await expectApp(page, who);
}

const saveDesign = (page: Page) => page.getByRole('button', { name: /Save Design/ });

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

const rows = (text: string): string[][] =>
  text
    .trim()
    .split('\n')
    .filter((line) => line !== '')
    .map((line) => line.split('\t'));

const NAME = 'WEB06';
/** The ids of the designs a test used, and of every photo it uploaded, so that cleaning takes out what a failed save left too. */
const usedDesignIds = new Set<string>();

async function cleanDesigns() {
  const ids = [...usedDesignIds].map((id) => `'${id}'`).join(', ') || "''";
  const mine = `SELECT id FROM designs WHERE name LIKE '${NAME} %' OR design_no LIKE '${NAME}-%'`;
  await laneSql(
    `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE design_id IN (${mine})); ` +
      `DELETE FROM skus WHERE design_id IN (${mine}); ` +
      `DELETE FROM design_photos WHERE design_id IN (${ids}) OR design_id IN (${mine}); ` +
      `DELETE FROM designs WHERE id IN (${mine})`
  );
}

test.afterEach(async () => {
  await cleanDesigns();
  usedDesignIds.clear();
});

// ------------------------------------------------------------------------------------------------ the photos

const PHOTO_DIR = path.resolve(__dirname, '../../../design');
const PHOTO_FILES = existsSync(PHOTO_DIR)
  ? readdirSync(PHOTO_DIR)
      .filter((name) => /\.jpe?g$/i.test(name))
      .sort()
      .map((name) => path.join(PHOTO_DIR, name))
  : [];

type UploadBuffer = { name: string; mimeType: string; buffer: Buffer };

/** Four pictures: Siddhi's photos when they are there, else four drawn in the browser (960 x 1280, like hers). */
async function fourPhotos(page: Page): Promise<string[] | UploadBuffer[]> {
  if (PHOTO_FILES.length >= 4) return PHOTO_FILES.slice(0, 4);
  const drawn = await page.evaluate(async () => {
    const out: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 1280;
      const context = canvas.getContext('2d') as CanvasRenderingContext2D;
      const gradient = context.createLinearGradient(0, 0, 960, 1280);
      gradient.addColorStop(0, `hsl(${i * 70}, 70%, 55%)`);
      gradient.addColorStop(1, `hsl(${i * 70 + 120}, 70%, 25%)`);
      context.fillStyle = gradient;
      context.fillRect(0, 0, 960, 1280);
      context.fillStyle = '#fff';
      context.font = '120px sans-serif';
      context.fillText(`Photo ${i + 1}`, 120, 640);
      out.push(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
    }
    return out;
  });
  return drawn.map((data, i) => ({
    name: `drawn-${i + 1}.jpg`,
    mimeType: 'image/jpeg',
    buffer: Buffer.from(data, 'base64'),
  }));
}

/** The size of a JPEG, from its first start-of-frame marker. */
function jpegSize(bytes: Buffer): { width: number; height: number } {
  expect([...bytes.subarray(0, 3)], 'a JPEG starts FF D8 FF').toEqual([0xff, 0xd8, 0xff]);
  let at = 2;
  while (at < bytes.length) {
    if (bytes[at] !== 0xff) throw new Error('not a JPEG marker');
    const marker = bytes[at + 1];
    const length = bytes.readUInt16BE(at + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: bytes.readUInt16BE(at + 5), width: bytes.readUInt16BE(at + 7) };
    }
    at += 2 + length;
  }
  throw new Error('no frame header in the JPEG');
}

// ------------------------------------------------------------------------------------------------ what the browser sends

interface Sent {
  method: string;
  path: string;
  kind: string | null;
  contentType: string;
  headers: Record<string, string>;
  json: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
  /** The API's answer to an upload: `{photo_id, design_id, kind, mime, byte_size, sha256}`. (A page's binary body is not readable by the test; the answer and the stored bytes are.) */
  answer: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Every call that writes business data (not a poll, not a session call), in the order the browser sent it. */
function trackWrites(page: Page): Sent[] {
  const { apiUrl } = e2eLane();
  const sent: Sent[] = [];
  const photoPath = /^\/v1\/designs\/([0-9a-f-]{36})\/photos\//;
  const byRequest = new Map<Request, Sent>();
  page.on('response', async (response) => {
    const entry = byRequest.get(response.request());
    if (entry && entry.method === 'PUT') entry.answer = await response.json().catch(() => null);
  });
  page.on('request', (request: Request) => {
    const url = request.url();
    if (!url.startsWith(apiUrl) || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const parsed = new URL(url);
    if (parsed.pathname.startsWith('/v1/auth/') || parsed.pathname === '/v1/sync/poll') return;
    const upload = photoPath.test(parsed.pathname);
    const designId = photoPath.exec(parsed.pathname)?.[1];
    if (designId) usedDesignIds.add(designId);
    const entry: Sent = {
      method: request.method(),
      path: parsed.pathname,
      kind: parsed.searchParams.get('kind'),
      contentType: request.headers()['content-type'] ?? '',
      headers: request.headers(),
      json: upload ? null : request.postDataJSON(),
      answer: null,
    };
    sent.push(entry);
    byRequest.set(request, entry);
    if (!upload && parsed.pathname === '/v1/designs') {
      const id = (request.postDataJSON() as { design_id?: string } | null)?.design_id;
      if (id) usedDesignIds.add(id);
    }
  });
  return sent;
}

/** What the picture-to-JPEG step was asked for (quality, canvas size), recorded in the page. */
async function recordEncoding(page: Page) {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.toBlob;
    const calls: Array<{
      type: string;
      quality: number | undefined;
      width: number;
      height: number;
    }> = [];
    (window as unknown as { __toBlob: typeof calls }).__toBlob = calls;
    HTMLCanvasElement.prototype.toBlob = function (callback, type, quality) {
      calls.push({ type: String(type), quality, width: this.width, height: this.height });
      return original.call(this, callback, type, quality);
    };
  });
}

const encodings = (page: Page) =>
  page.evaluate(
    () =>
      (
        window as unknown as {
          __toBlob: Array<{ type: string; quality: number; width: number; height: number }>;
        }
      ).__toBlob
  );

// ------------------------------------------------------------------------------------------------ the screen

/** Step 2 and 3 of Add Design with the entries of the tests. Returns with the Save button in view. */
async function fillDesign(
  page: Page,
  options: {
    name: string;
    owner: boolean;
    groups?: Array<{
      gross: string;
      net: string;
      original?: string;
      retail?: string;
      pieces: string;
    }>;
  }
) {
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByTestId('design-number-preview')).toHaveText('Number assigned when saved');
  await page.getByLabel('Design Name').fill(options.name);
  await page.getByTestId('category-select').selectOption({ label: 'Ring' });
  await page.getByTestId('subcategory-select').selectOption({ label: 'Kundan' });
  await page.getByRole('button', { name: /^🥇\s*Gold$/ }).click();
  await page.getByRole('button', { name: '22K', exact: true }).click();
  await page.getByRole('button', { name: /By Weight/ }).click();
  await page.getByLabel('Tags / Keywords').fill('bridal, kundan');
  await page.getByRole('button', { name: 'Continue' }).click();

  const groups = options.groups ?? [
    { gross: '12.5', net: '11.25', original: '10.125', retail: '353', pieces: '2' },
  ];
  await expect(page.getByTestId('sku-count-preview')).toContainText('1 piece will be made');
  if (groups.length > 1)
    await page
      .getByRole('button', { name: String(groups.length), exact: true })
      .first()
      .click();
  const boxes = page.getByTestId('piece-group');
  await expect(boxes).toHaveCount(groups.length);
  for (const [at, group] of groups.entries()) {
    const box = boxes.nth(at);
    await box.getByLabel('Pieces with this weight').fill(group.pieces);
    await box.getByLabel('Gross Weight (g)').fill(group.gross);
    await box.getByLabel('Customer Net Wt (g)').fill(group.net);
    if (group.retail) await box.getByLabel(/^Retail Labour/).fill(group.retail);
    if (group.original) await box.getByLabel(/Original Net Wt/).fill(group.original);
  }
}

// ================================================================================================ PT-W6

test.describe('PT-W6 Add Design with photos', () => {
  test('the owner adds a design with three photos: resized in the browser, both kinds uploaded before create_design, a fourth refused, numbers from the API, one design for a double click', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    const writes = trackWrites(page);
    await recordEncoding(page);
    await open(page, owner, '/add-design');
    const files = await fourPhotos(page);

    // ---- step 1: four pictures chosen, three kept, the fourth refused in plain words
    await page.getByTestId('photo-input').setInputFiles(files);
    const tiles = page.getByTestId('photo-tile');
    await expect(tiles).toHaveCount(3, { timeout: 60_000 });
    await expect(page.getByTestId('photo-notice')).toContainText(
      'A design can have at most 3 photos. 1 photo was not added.'
    );
    await expect(page.getByTestId('photo-notice')).not.toContainText(/JV_|undefined/);
    // the previews are the 320 px thumbnails, in this page's memory, not text in a row (P4)
    for (let i = 0; i < 3; i += 1) {
      const preview = tiles.nth(i).locator('img');
      await expect(preview).toHaveAttribute('src', /^blob:/);
      await expect
        .poll(() => preview.evaluate((img: HTMLImageElement) => img.naturalHeight))
        .toBe(320);
    }
    // the second photo is the primary; the third is turned
    await tiles.nth(1).getByTitle('Set as primary').click({ force: true });
    await expect(tiles.nth(1)).toContainText('Primary');
    await tiles.nth(2).getByTitle('Rotate').click({ force: true });
    await expect
      .poll(() =>
        tiles
          .nth(2)
          .locator('img')
          .evaluate((img: HTMLImageElement) => img.naturalWidth)
      )
      .toBe(320); // turned: the thumbnail is 320 px wide now, and 240 high

    // ---- steps 2 and 3, then Save with a double click
    await fillDesign(page, {
      name: `${NAME} owner design`,
      owner: true,
      groups: [
        { gross: '12.5', net: '11.25', original: '10.125', retail: '353', pieces: '2' },
        { gross: '8', net: '7', pieces: '1' },
      ],
    });
    await expect(page.getByTestId('sku-count-preview')).toContainText('3 pieces will be made');
    await saveDesign(page).dblclick();
    await expect(page.getByTestId('created-design-number')).toBeVisible({ timeout: 60_000 });

    // ---- what went to the API: six uploads (full, then thumb, for each photo) and ONE create_design, last
    const calls = writes.map(
      (w) =>
        `${w.method} ${w.path.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, '<id>')}${w.kind ? `?kind=${w.kind}` : ''}`
    );
    expect(calls).toEqual([
      'PUT /v1/designs/<id>/photos/<id>?kind=full',
      'PUT /v1/designs/<id>/photos/<id>?kind=thumb',
      'PUT /v1/designs/<id>/photos/<id>?kind=full',
      'PUT /v1/designs/<id>/photos/<id>?kind=thumb',
      'PUT /v1/designs/<id>/photos/<id>?kind=full',
      'PUT /v1/designs/<id>/photos/<id>?kind=thumb',
      'POST /v1/designs',
    ]);
    const uploads = writes.filter((w) => w.method === 'PUT');
    const create = writes[6];
    const designId = create.json?.design_id as string;
    expect(designId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    const photoIds = [0, 2, 4].map((i) => uploads[i].path.split('/')[5]);
    for (const [at, id] of photoIds.entries()) {
      expect(uploads[at * 2].path).toBe(`/v1/designs/${designId}/photos/${id}`);
      expect(uploads[at * 2 + 1].path).toBe(`/v1/designs/${designId}/photos/${id}`); // both kinds under one id
    }
    expect(new Set(photoIds).size).toBe(3);
    for (const upload of uploads) {
      expect(upload.contentType).toBe('image/jpeg');
      expect(upload.headers['x-jv-client']).toBe('web');
      expect(upload.answer).toMatchObject({
        design_id: designId,
        mime: 'image/jpeg',
        kind: upload.kind,
      });
      expect(upload.answer?.byte_size).toBeGreaterThan(1000);
      expect(upload.answer?.byte_size).toBeLessThan(2 * 1024 * 1024);
    }
    // what the API holds: the sizes (longest side 1000 px for the full picture and 320 px for the thumbnail; the third photo was turned, so it is landscape) and the very bytes sent
    const held = await Promise.all(
      uploads.map(async (u, at) => {
        const response = await fetch(
          `${apiUrl}/v1/photos/${photoIds[Math.floor(at / 2)]}/${u.kind}`
        );
        expect(response.status).toBe(200);
        const bytes = Buffer.from(await response.arrayBuffer());
        expect(bytes.length).toBe(u.answer?.byte_size);
        return bytes;
      })
    );
    expect(held.map((bytes) => jpegSize(bytes))).toEqual([
      { width: 750, height: 1000 },
      { width: 240, height: 320 },
      { width: 750, height: 1000 },
      { width: 240, height: 320 },
      { width: 1000, height: 750 },
      { width: 320, height: 240 },
    ]);
    // quality 72, asked of the browser for every picture it wrote (each of the 3 photos once for the first pass, and the turned one again)
    const asked = await encodings(page);
    expect(asked.length).toBeGreaterThanOrEqual(8);
    for (const call of asked) {
      expect(call.type).toBe('image/jpeg');
      expect(call.quality).toBe(0.72);
    }

    // ---- create_design carries ids and entries only (T-C01), and the key
    expect(create.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    expect(create.json?.design).toEqual({
      category_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      subcategory_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: `${NAME} owner design`,
      material: 'Gold',
      purity: '22K',
      selling_method: 'By Weight',
      tags: ['bridal', 'kundan'],
      photo_ids: photoIds,
      primary_photo_id: photoIds[1],
    });
    expect(create.json?.pieces).toEqual([
      {
        pieces: 2,
        gross_weight: '12.500',
        original_net_weight: '10.125',
        customer_net_weight: '11.250',
        labour_retail: '353.00',
      },
      { pieces: 1, gross_weight: '8.000', customer_net_weight: '7.000' },
    ]);
    const text = JSON.stringify(create.json);
    for (const name of [
      'design_no',
      'sku_no',
      'barcode',
      'status',
      'location',
      'created_at',
      'updated_at',
      'images',
    ])
      expect(text, name).not.toContain(`"${name}"`);
    expect(text).not.toContain('data:');
    expect(text).not.toContain('blob:');

    // ---- the double click made one design
    expect(writes.filter((w) => w.path === '/v1/designs')).toHaveLength(1);
    expect(
      rows(await laneSql(`SELECT COUNT(*) FROM designs WHERE name = '${NAME} owner design'`))[0][0]
    ).toBe('1');

    // ---- the numbers on the screen are the ones the API assigned, and the database has them
    const [[designNo, primary, photoJson]] = rows(
      await laneSql(
        `SELECT design_no, primary_photo_id, photo_ids FROM designs WHERE id = '${designId}'`
      )
    );
    await expect(page.getByTestId('created-design-number')).toHaveText(designNo);
    expect(designNo).toMatch(/^RING-\d{5}$/);
    expect(primary).toBe(photoIds[1]);
    expect(JSON.parse(photoJson)).toEqual(photoIds);
    const stored = rows(
      await laneSql(
        `SELECT sku_no, barcode, status, location, gross_weight, customer_net_weight, labour_retail, labour_semi, labour_wholesale FROM skus WHERE design_id = '${designId}' ORDER BY sku_no`
      )
    );
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r[0])).toEqual(
      [1, 2, 3].map((n) => `${designNo}-${String(n).padStart(3, '0')}`)
    );
    expect(stored.map((r) => r[1])).toEqual(stored.map((r) => `BC-${r[0]}`));
    expect(stored.map((r) => r[2])).toEqual(['In Stock', 'In Stock', 'In Stock']);
    expect(stored.every((r) => r[3] === 'Main Showroom')).toBe(true);
    // R1: a blank rate is filled by the API (semi and wholesale take the retail rate; a blank retail rate is 0.00)
    expect(stored.map((r) => r.slice(6))).toEqual([
      ['353.00', '353.00', '353.00'],
      ['353.00', '353.00', '353.00'],
      ['0.00', '0.00', '0.00'],
    ]);
    await expect(page.getByTestId('created-piece')).toHaveCount(3);
    for (const [at, r] of stored.entries()) {
      await expect(page.getByTestId('created-piece').nth(at)).toContainText(r[0]);
      await expect(page.getByTestId('created-piece').nth(at)).toContainText(r[1]);
    }
    // D9: the owner's weight is kept for the pieces of the first group
    expect(
      rows(
        await laneSql(
          `SELECT s.sku_no, p.original_net_weight FROM sku_private p JOIN skus s ON s.id = p.sku_id WHERE s.design_id = '${designId}' ORDER BY s.sku_no`
        )
      )
    ).toEqual([
      [stored[0][0], '10.125'],
      [stored[1][0], '10.125'],
    ]);
    // P2: both kinds of every photo are in the database under the design's id
    expect(
      rows(
        await laneSql(
          `SELECT id, kind, mime FROM design_photos WHERE design_id = '${designId}' ORDER BY id, kind`
        )
      ).length
    ).toBe(6);

    // ---- the photos open in the gallery from the API (public read, immutable)
    const reads: Array<{ url: string; status: number; cache: string | null; type: string | null }> =
      [];
    page.on('response', (response) => {
      if (response.url().startsWith(`${apiUrl}/v1/photos/`))
        reads.push({
          url: response.url(),
          status: response.status(),
          cache: response.headers()['cache-control'] ?? null,
          type: response.headers()['content-type'] ?? null,
        });
    });
    await page.goto(`/design-detail?id=${designId}`);
    await expectApp(page, owner);
    const main = page.getByTestId('gallery-main');
    const naturalSize = (locator: ReturnType<Page['locator']>) =>
      locator.evaluate((img: HTMLImageElement) => `${img.naturalWidth}x${img.naturalHeight}`);
    // the primary photo (the second) comes first, from the API's own address
    await expect(main).toHaveAttribute('src', `${apiUrl}/v1/photos/${photoIds[1]}/full`);
    await expect.poll(() => naturalSize(main)).toBe('750x1000');
    await page.getByRole('button', { name: 'Next picture' }).click();
    await expect(main).toHaveAttribute('src', `${apiUrl}/v1/photos/${photoIds[0]}/full`);
    await expect.poll(() => naturalSize(main)).toBe('750x1000');
    await page.getByRole('button', { name: 'Next picture' }).click();
    await expect(main).toHaveAttribute('src', `${apiUrl}/v1/photos/${photoIds[2]}/full`);
    await expect.poll(() => naturalSize(main)).toBe('1000x750'); // the turned one
    // the strip shows the 320 px thumbnails
    const strip = page.getByTestId('gallery-thumb');
    await expect(strip).toHaveCount(3);
    await expect(strip.first()).toHaveAttribute('src', `${apiUrl}/v1/photos/${photoIds[1]}/thumb`);
    await expect.poll(() => naturalSize(strip.first())).toBe('240x320');
    expect(reads.length).toBeGreaterThanOrEqual(4);
    for (const read of reads) {
      expect(read.status, read.url).toBe(200);
      expect(read.type).toBe('image/jpeg');
      expect(read.cache).toBe('public, max-age=31536000, immutable');
    }

    // ---- the list shows the thumbnail of the primary photo
    await page.goto('/inventory-management');
    await expectApp(page, owner);
    const listed = page.locator(`img[src="${apiUrl}/v1/photos/${photoIds[1]}/thumb"]`).first();
    await expect(listed).toBeVisible();
    await expect.poll(() => naturalSize(listed)).toBe('240x320');
  });

  test('a staff login has no original-weight field, sends none, and no weight row is made', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const staff = e2eLogin('staff');
    const writes = trackWrites(page);
    await open(page, staff, '/add-design');
    await fillDesign(page, {
      name: `${NAME} staff design`,
      owner: false,
      groups: [{ gross: '5', net: '4.5', retail: '300', pieces: '2' }],
    });
    // D9: the field is not on a staff screen (it is not hidden: it is not there)
    await expect(page.getByText('Original Net Wt')).toHaveCount(0);
    await expect(page.getByLabel(/Original Net Wt/)).toHaveCount(0);
    await saveDesign(page).click();
    await expect(page.getByTestId('created-design-number')).toBeVisible({ timeout: 60_000 });

    const create = writes.find((w) => w.path === '/v1/designs');
    expect(writes.map((w) => w.method)).toEqual(['POST']); // no photo was added
    expect(JSON.stringify(create?.json)).not.toContain('original_net_weight');
    expect(create?.json?.design).not.toHaveProperty('photo_ids');
    const designId = create?.json?.design_id as string;
    expect(
      rows(
        await laneSql(
          `SELECT COUNT(*) FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE design_id = '${designId}')`
        )
      )[0][0]
    ).toBe('0');
    const [[designNo, createdBy]] = rows(
      await laneSql(
        `SELECT d.design_no, u.email FROM designs d JOIN users u ON u.id = d.created_by WHERE d.id = '${designId}'`
      )
    );
    await expect(page.getByTestId('created-design-number')).toHaveText(designNo);
    expect(createdBy).toBe(staff.email);
    await expect(page.getByTestId('created-piece')).toHaveCount(2);
  });

  test('a refused entry is told in plain words naming the group, nothing is made, and the corrected entry saves without sending the photo again', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const owner = e2eLogin('owner');
    const writes = trackWrites(page);
    await open(page, owner, '/add-design');
    const files = await fourPhotos(page);
    await page.getByTestId('photo-input').setInputFiles(files.slice(0, 1));
    await expect(page.getByTestId('photo-tile')).toHaveCount(1, { timeout: 60_000 });
    // the net weight is above the gross weight (D7): the API refuses it
    await fillDesign(page, {
      name: `${NAME} refused design`,
      owner: true,
      groups: [{ gross: '5', net: '9', retail: '300', pieces: '1' }],
    });
    await saveDesign(page).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Group 1' });
    await expect(alert).toContainText(/customer net weight/i, { timeout: 60_000 });
    await expect(alert).not.toContainText(/pieces\[|JV_/);
    expect(
      rows(
        await laneSql(`SELECT COUNT(*) FROM designs WHERE name = '${NAME} refused design'`)
      )[0][0]
    ).toBe('0');
    // Save is on again, and the picture is still there
    await expect(saveDesign(page)).toBeEnabled();
    const attempt = writes.filter((w) => w.path === '/v1/designs');
    expect(attempt).toHaveLength(1);
    const uploadsBefore = writes.filter((w) => w.method === 'PUT').length;
    expect(uploadsBefore).toBe(2);

    // corrected: the same design id, and no upload again
    await page.getByTestId('piece-group').first().getByLabel('Customer Net Wt (g)').fill('4');
    await saveDesign(page).click();
    await expect(page.getByTestId('created-design-number')).toBeVisible({ timeout: 60_000 });
    expect(writes.filter((w) => w.method === 'PUT')).toHaveLength(2);
    const posts = writes.filter((w) => w.path === '/v1/designs');
    expect(posts).toHaveLength(2);
    expect(posts[1].json?.design_id).toBe(posts[0].json?.design_id);
    expect(
      rows(
        await laneSql(`SELECT COUNT(*) FROM designs WHERE name = '${NAME} refused design'`)
      )[0][0]
    ).toBe('1');
  });
});

// ================================================================================================ X9

test.describe('X9 a status change and an Archive from the stock screen', () => {
  const DESIGN_NO = 'WEB06-X9';
  const pieces = [`${DESIGN_NO}-001`, `${DESIGN_NO}-002`, `${DESIGN_NO}-003`];

  async function makeStock(): Promise<string> {
    await cleanDesigns();
    await laneSql(
      `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) ` +
        `SELECT UUID_v4(), '${DESIGN_NO}', '${NAME} status design', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1; ` +
        pieces
          .map(
            (no, i) =>
              `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, location, status) ` +
              `SELECT UUID_v4(), id, '${no}', 'W6X0000${i}', 10.000, 9.000, 'Main Showroom', 'In Stock' FROM designs WHERE design_no = '${DESIGN_NO}';`
          )
          .join(' ') +
        ` INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) ` +
        `SELECT UUID_v4(), 'WEB06-BILL', id, CURDATE(), 'Retail', 1000.00 FROM customers WHERE is_walkin = 1; ` +
        `UPDATE skus SET status = 'Sold', sold_bill_id = (SELECT id FROM bills WHERE bill_no = 'WEB06-BILL') WHERE sku_no = '${pieces[2]}';`
    );
    return (await laneSql(`SELECT id FROM designs WHERE design_no = '${DESIGN_NO}'`)).trim();
  }

  test.afterEach(async () => {
    await laneSql(
      `DELETE FROM skus WHERE sku_no LIKE 'WEB06-%'; DELETE FROM bills WHERE bill_no = 'WEB06-BILL'`
    );
  });

  test('choosing a status and pressing Archive are one call each, shown after the API has answered; a Sold piece cannot be changed; changes not saved block it', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const staff = e2eLogin('staff');
    const designId = await makeStock();
    const writes = trackWrites(page);
    await open(page, staff, `/edit-stock?id=${designId}`);
    const piece = (no: string) => page.getByTestId(`piece-${no}`);
    const statusOf = async (no: string) =>
      (await laneSql(`SELECT status FROM skus WHERE sku_no = '${no}'`)).trim();
    const status = (no: string) => page.getByLabel(`Status of ${no}`);

    // a Sold piece shows Sold, cannot be changed here, and has no Archive
    await expect(status(pieces[2])).toHaveValue('Sold');
    await expect(status(pieces[2])).toBeDisabled();
    await expect(piece(pieces[2]).getByRole('button', { name: 'Archive' })).toHaveCount(0);
    // Sold is not a choice for a piece that is not Sold
    await expect(status(pieces[0]).locator('option', { hasText: 'Sold' })).toHaveCount(0);

    // a status: one call with the piece and the status, an Idempotency-Key, and the piece shows it when the API has answered
    await status(pieces[0]).selectOption('Repair');
    await expect(
      page.getByRole('status').filter({ hasText: `${pieces[0]} is now Repair.` })
    ).toBeVisible();
    await expect(status(pieces[0])).toHaveValue('Repair');
    expect(await statusOf(pieces[0])).toBe('Repair');
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('POST');
    expect(writes[0].path).toBe('/v1/skus/status');
    expect(writes[0].headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
    const firstId = (await laneSql(`SELECT id FROM skus WHERE sku_no = '${pieces[0]}'`)).trim();
    expect(writes[0].json).toEqual({ sku_ids: [firstId], status: 'Repair' });

    // Archive: asks first, then one call; archived_at is set by the API
    page.once('dialog', (dialog) => void dialog.accept());
    await piece(pieces[1]).getByRole('button', { name: 'Archive' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: `${pieces[1]} is now Archived.` })
    ).toBeVisible();
    expect(await statusOf(pieces[1])).toBe('Archived');
    expect(
      rows(
        await laneSql(`SELECT archived_at IS NOT NULL FROM skus WHERE sku_no = '${pieces[1]}'`)
      )[0][0]
    ).toBe('1');
    await expect(piece(pieces[1]).getByRole('button', { name: 'Archive' })).toHaveCount(0);
    expect(writes).toHaveLength(2);
    expect(writes[1].json?.status).toBe('Archived');

    // an Archived piece comes back by choosing another status: archived_at is cleared
    await status(pieces[1]).selectOption('In Stock');
    await expect(
      page.getByRole('status').filter({ hasText: `${pieces[1]} is now In Stock.` })
    ).toBeVisible();
    expect(
      rows(
        await laneSql(`SELECT status, archived_at IS NULL FROM skus WHERE sku_no = '${pieces[1]}'`)
      )[0]
    ).toEqual(['In Stock', '1']);

    // changes that are not saved yet block the status (the stamp they were started from must stay the API's)
    await piece(pieces[0]).getByLabel('Remarks').fill('typed');
    await expect(status(pieces[0])).toBeDisabled();
    await expect(piece(pieces[0]).getByRole('button', { name: 'Archive' })).toBeDisabled();
    await page.getByRole('button', { name: 'Save Changes' }).click();
    await expect(page.getByText('Stock saved.')).toBeVisible();
    await expect(status(pieces[0])).toBeEnabled();
  });

  test('a Sold piece that was sold meanwhile is refused by the API in plain words and nothing changes', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const owner = e2eLogin('owner');
    const designId = await makeStock();
    const writes = trackWrites(page);
    await open(page, owner, `/edit-stock?id=${designId}`);
    const piece = page.getByTestId(`piece-${pieces[0]}`);
    // the piece is sold behind the screen's back (a bill on another computer); the screen has not heard of it yet
    // (a poll that is never answered: the screen hears nothing until the test ends, and the connection banner does not change)
    await page.route('**/v1/sync/poll', () => undefined);
    await laneSql(
      `UPDATE skus SET status = 'Sold', sold_bill_id = (SELECT id FROM bills WHERE bill_no = 'WEB06-BILL') WHERE sku_no = '${pieces[0]}'`
    );
    await page.getByLabel(`Status of ${pieces[0]}`).selectOption('Repair');
    const alert = page.getByRole('alert').filter({ hasText: 'Sold' });
    await expect(alert).toContainText(/cannot be changed/i, { timeout: 30_000 });
    await expect(alert).not.toContainText(/JV_/);
    expect(writes).toHaveLength(1);
    expect((await laneSql(`SELECT status FROM skus WHERE sku_no = '${pieces[0]}'`)).trim()).toBe(
      'Sold'
    );
    await expect(piece).toBeVisible();
  });
});
