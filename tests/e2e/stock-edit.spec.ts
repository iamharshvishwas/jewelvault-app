import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { e2eLane, e2eLogin, type E2eLogin, type E2eRole } from './global-setup';

// WEB05: the stock-side stores on the API, in a real browser against the real API of a lane (spec C5 (a), C8, C11, A5, D3, D4, Y8).
//   PT-W5  a piece edit shows at once and persists after reload; it goes out as ONE write for each row that changed, with only the changed fields and the exact
//          updated_at text; a stale edit in a second browser shows the reload message and changed nothing; staff cannot edit settings or see the original weight;
//          a biller can enter today's rate and not yesterday's; the owner's settings are one row for each section, saved on their own; a new category comes back
//          from the server
//   T-E05  (clause) after a session no business data is in browser storage
//   T-C01  (clause) the browser sends no id and no number of its own making, and shows only the ones the server gave
//   T-E03  (clause) the Save control of the edit screen is off while the banner "Offline: changes cannot be saved" shows
//
// The pieces these tests edit are made directly in the lane's database as root (poll.spec.ts does the same), and taken out again after each test; the settings, the rates
// and the categories a test changes are put back.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/stock-edit.spec.ts

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
async function open(page: Page, who: E2eLogin, path: string) {
  await page.goto(path);
  await expect(page.getByLabel('Email')).toBeVisible();
  await submitLogin(page, who);
  await expectApp(page, who);
}

/** Logs out through the sidebar and waits for the server's answer (the login screen comes at once). */
async function logout(page: Page) {
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/auth/logout') && response.request().method() === 'POST'
  );
  await aside(page).getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
  await answered;
}

const saveChanges = (page: Page) => page.getByRole('button', { name: 'Save Changes' });
const piece = (page: Page, skuNo: string): Locator => page.getByTestId(`piece-${skuNo}`);

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

/** The `updated_at` of a row as the API writes it on the wire: UTC, six decimals, a Z. */
async function wireStamp(table: string, where: string): Promise<string> {
  return (
    await laneSql(
      `SELECT DATE_FORMAT(updated_at, '%Y-%m-%dT%H:%i:%s.%fZ') FROM ${table} WHERE ${where}`
    )
  ).trim();
}

const DESIGN_NO = 'WEB05-00001';
const PIECE_1 = 'WEB05-00001-001';
const PIECE_2 = 'WEB05-00001-002';

/** A design of the first category with two pieces; the owner's weight is entered for the first. Returns the id of the design. */
async function makeStock(): Promise<string> {
  await cleanStock();
  await laneSql(
    `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) ` +
      `SELECT UUID_v4(), '${DESIGN_NO}', 'Edit test design', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1; ` +
      `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, location, status) ` +
      `SELECT UUID_v4(), id, '${PIECE_1}', 'W5B00001', 12.500, 11.250, 'Main Showroom', 'In Stock' FROM designs WHERE design_no = '${DESIGN_NO}'; ` +
      `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, location, status) ` +
      `SELECT UUID_v4(), id, '${PIECE_2}', 'W5B00002', 8.000, 7.500, 'Workshop', 'In Stock' FROM designs WHERE design_no = '${DESIGN_NO}'; ` +
      `INSERT INTO sku_private (sku_id, original_net_weight) SELECT id, 10.125 FROM skus WHERE sku_no = '${PIECE_1}';`
  );
  return (await laneSql(`SELECT id FROM designs WHERE design_no = '${DESIGN_NO}'`)).trim();
}

async function cleanStock() {
  await laneSql(
    `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE sku_no LIKE 'WEB05-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'WEB05-%'; DELETE FROM designs WHERE design_no LIKE 'WEB05-%'`
  );
}

// ------------------------------------------------------------------------------------------------ the calls of a person, from this test (not from a page)

/** The Asia/Kolkata business date `daysAgo` days before today. */
function businessDate(daysAgo = 0): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() - daysAgo * 86_400_000));
}

/** Signs in as a role of the lane and makes calls with that session, as the site would (its Origin, X-JV-Client). */
async function asRole(role: E2eRole) {
  const { apiUrl, webOrigin } = e2eLane();
  const who = e2eLogin(role);
  const headers = { origin: webOrigin, 'x-jv-client': 'web', 'content-type': 'application/json' };
  const login = await fetch(`${apiUrl}/v1/auth/login`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ email: who.email, password: who.password }),
  });
  expect(login.status, `${role} signs in`).toBe(200);
  const cookie = (login.headers.getSetCookie?.()[0] ?? '').split(';')[0];
  return {
    call: async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { ...headers, cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return { status: response.status, json: (await response.json().catch(() => null)) as any }; // eslint-disable-line @typescript-eslint/no-explicit-any
    },
    end: async () => {
      await fetch(`${apiUrl}/v1/auth/logout`, { method: 'POST', headers: { ...headers, cookie } });
    },
  };
}

// ------------------------------------------------------------------------------------------------ what the browser sends and keeps

interface Write {
  method: string;
  path: string;
  body: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/** Every call that writes business data (not a poll, not a session call). */
function trackWrites(page: Page): Write[] {
  const { apiUrl } = e2eLane();
  const writes: Write[] = [];
  page.on('request', (request) => {
    const url = request.url();
    if (!url.startsWith(apiUrl) || ['GET', 'HEAD', 'OPTIONS'].includes(request.method())) return;
    const path = url.slice(apiUrl.length);
    if (path.startsWith('/v1/auth/') || path === '/v1/sync/poll') return;
    writes.push({ method: request.method(), path, body: request.postDataJSON() });
  });
  return writes;
}

/** T-C01: nothing in a write names an id, a number, a barcode or a stamp of the browser's own making. */
function expectNothingMadeUp(writes: Write[]) {
  const forbidden = [
    'id',
    'design_no',
    'sku_no',
    'barcode',
    'created_at',
    'updated_at',
    'created_by',
    'updated_by',
    'status',
  ];
  for (const write of writes) {
    const flat = [...Object.keys(write.body ?? {}), ...Object.keys(write.body?.changes ?? {})];
    for (const name of forbidden)
      expect(flat, `${write.method} ${write.path} names ${name}`).not.toContain(name);
  }
}

async function browserStorage(page: Page) {
  return page.evaluate(async () => {
    const dump = (store: Storage) =>
      Object.fromEntries(
        Array.from({ length: store.length }, (_, i) => store.key(i) ?? '').map((k) => [
          k,
          store.getItem(k),
        ])
      );
    const databases = (await indexedDB.databases?.()) ?? [];
    return {
      local: dump(window.localStorage),
      session: dump(window.sessionStorage),
      databases: databases.map((d) => d.name),
    };
  });
}

// ------------------------------------------------------------------------------------------------ the tests

let designId = '';

test.beforeEach(async () => {
  designId = await makeStock();
});

test.afterEach(async () => {
  await cleanStock();
});

test.describe('PT-W5: an ordinary edit of the stock (C5 (a), A5)', () => {
  test.describe.configure({ timeout: 180_000 });

  test('a piece edit shows at once, goes out as one write for each row with only the changed fields and the exact updated_at text, and persists after a reload', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    const writes = trackWrites(page);
    const designStamp = await wireStamp('designs', `design_no = '${DESIGN_NO}'`);
    const pieceStamp = await wireStamp('skus', `sku_no = '${PIECE_1}'`);
    expect(designStamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/);

    await open(page, owner, `/edit-stock?id=${designId}`);
    await expect(page.getByRole('heading', { name: 'Edit Existing Stock' })).toBeVisible();
    // the screen holds the design as the server has it
    await expect(piece(page, PIECE_1).getByLabel('Customer Net Wt (g)')).toHaveValue('11.25');

    // the design's write waits at the door, so that what is on screen before the server answers can be looked at
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    await page.route(`${apiUrl}/v1/designs/**`, async (route) => {
      await gate;
      await route.continue();
    });

    await page.getByLabel('Design Name').fill('Edited design name');
    await piece(page, PIECE_1).getByLabel('Customer Net Wt (g)').fill('10.5');
    await piece(page, PIECE_1).getByLabel('Remarks').fill('checked by the owner');
    await piece(page, PIECE_2).getByLabel('Gross Weight (g)').fill('9');
    await saveChanges(page).click();

    // AT ONCE: the inventory (which reads memory) shows the new name and the new total of the gross weights, though no write has been answered
    await page.getByRole('link', { name: 'Back' }).click();
    const card = page.locator('div.jewel-card').filter({ hasText: DESIGN_NO });
    await expect(card).toContainText('Edited design name', { timeout: 5000 });
    await expect(card).toContainText('21.500g GW'); // 12.5 + 9
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([`PATCH /v1/designs/${designId}`]);

    release();
    await expect.poll(() => writes.length, { timeout: 20_000 }).toBe(3);
    await expect
      .poll(
        async () => laneSql(`SELECT customer_net_weight FROM skus WHERE sku_no = '${PIECE_1}'`),
        {
          timeout: 20_000,
        }
      )
      .toBe('10.500\n');

    // one write for each row that changed, the design first; only the changed fields; the stamp of the row as the page loaded it, as the exact text
    const [designWrite, firstPiece, secondPiece] = writes;
    expect(designWrite.body).toEqual({
      expected_updated_at: designStamp,
      changes: { name: 'Edited design name' },
    });
    expect(firstPiece.path).toMatch(/^\/v1\/skus\//);
    expect(firstPiece.body).toEqual({
      expected_updated_at: pieceStamp,
      changes: { customer_net_weight: '10.500', notes: 'checked by the owner' },
    });
    expect(secondPiece.body?.changes).toEqual({ gross_weight: '9.000' });
    expectNothingMadeUp(writes);

    // it persists: opening the page again (a fresh load) brings it back from the server
    await page.goto(`/edit-stock?id=${designId}`);
    await expectApp(page, owner);
    await expect(page.getByLabel('Design Name')).toHaveValue('Edited design name');
    await expect(piece(page, PIECE_1).getByLabel('Customer Net Wt (g)')).toHaveValue('10.5');
    await expect(piece(page, PIECE_1).getByLabel('Remarks')).toHaveValue('checked by the owner');
    await expect(piece(page, PIECE_2).getByLabel('Gross Weight (g)')).toHaveValue('9');
    // and the server's row is the screen's: the stamps moved
    expect(await wireStamp('skus', `sku_no = '${PIECE_1}'`)).not.toBe(pieceStamp);
  });

  test('a refusal puts the old values back and shows the reason; the row is not changed', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const writes = trackWrites(page);
    await open(page, owner, `/edit-stock?id=${designId}`);
    // a customer net weight above the gross weight is refused by the API (D7)
    await piece(page, PIECE_1).getByLabel('Customer Net Wt (g)').fill('99');
    await saveChanges(page).click();
    const alert = page.getByRole('alert').filter({ hasText: 'Nothing was changed.' });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('customer_net_weight');
    expect(writes).toHaveLength(1);
    expect(await laneSql(`SELECT customer_net_weight FROM skus WHERE sku_no = '${PIECE_1}'`)).toBe(
      '11.250\n'
    );
    // memory is back: the inventory and the design page do not show 99 either
    await page.getByRole('link', { name: 'Back' }).click();
    await expect(page.locator('div.jewel-card').filter({ hasText: DESIGN_NO })).toContainText(
      '20.500g GW'
    );
  });

  test("a stale edit in a second browser shows the reload message, changes nothing, and shows the other browser's version", async ({
    browser,
  }) => {
    const owner = e2eLogin('owner');
    const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
    try {
      const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
      await open(a, owner, `/edit-stock?id=${designId}`);
      await open(b, owner, `/edit-stock?id=${designId}`);

      // A starts an edit ...
      await piece(a, PIECE_1).getByLabel('Customer Net Wt (g)').fill('9.5');
      // ... and B saves the same piece first
      await piece(b, PIECE_1).getByLabel('Remarks').fill('from the other browser');
      await saveChanges(b).click();
      await expect(b.getByRole('status').filter({ hasText: 'Stock saved.' })).toBeVisible();

      // A presses Save: its stamp is the one it started from, so the server answers 409 and the page reloads the piece
      await saveChanges(a).click();
      const alert = a.getByRole('alert').filter({ hasText: 'This was changed by someone else' });
      await expect(alert).toHaveText(
        'This was changed by someone else. The latest version has been loaded. Nothing was changed.'
      );
      await expect(piece(a, PIECE_1).getByLabel('Remarks')).toHaveValue('from the other browser');
      await expect(piece(a, PIECE_1).getByLabel('Customer Net Wt (g)')).toHaveValue('11.25');
      expect(
        await laneSql(`SELECT customer_net_weight FROM skus WHERE sku_no = '${PIECE_1}'`)
      ).toBe('11.250\n');
      // A's page is whole again: the Save control is off until the next change, and the next change saves
      await expect(saveChanges(a)).toBeDisabled();
      await piece(a, PIECE_1).getByLabel('Customer Net Wt (g)').fill('9.5');
      await saveChanges(a).click();
      await expect(a.getByRole('status').filter({ hasText: 'Stock saved.' })).toBeVisible();
      expect(
        await laneSql(`SELECT customer_net_weight FROM skus WHERE sku_no = '${PIECE_1}'`)
      ).toBe('9.500\n');
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });

  test('the Save control is off while the banner "Offline: changes cannot be saved" shows (C7)', async ({
    page,
    context,
  }) => {
    const owner = e2eLogin('owner');
    await open(page, owner, `/edit-stock?id=${designId}`);
    await piece(page, PIECE_1).getByLabel('Remarks').fill('typed while offline');
    await expect(saveChanges(page)).toBeEnabled();
    await context.setOffline(true);
    // the next poll cannot reach the server (within 8 seconds)
    await expect(page.getByTestId('connection-banner')).toHaveText(
      'Offline: changes cannot be saved',
      { timeout: 20_000 }
    );
    await expect(saveChanges(page)).toBeDisabled();
    await expect(saveChanges(page)).toHaveAttribute('title', 'Offline: changes cannot be saved');
    // what was typed is still there, and comes back to life with the connection
    await expect(piece(page, PIECE_1).getByLabel('Remarks')).toHaveValue('typed while offline');
    await context.setOffline(false);
    await expect(page.getByTestId('connection-banner')).toHaveCount(0, { timeout: 30_000 });
    await expect(saveChanges(page)).toBeEnabled();
  });
});

test.describe('PT-W5: who may do what (A5, A4, D9)', () => {
  test.describe.configure({ timeout: 120_000 });

  test("staff edit stock but cannot change a design's material, see the original weight or open the settings; the owner sees the weight", async ({
    page,
  }) => {
    const staff = e2eLogin('staff');
    const writes = trackWrites(page);
    await open(page, staff, `/edit-stock?id=${designId}`);
    await expect(piece(page, PIECE_1).getByLabel('Customer Net Wt (g)')).toBeVisible();
    await expect(page.getByText('Original Net Wt (g)')).toHaveCount(0);
    await expect(page.getByLabel('Material')).toBeDisabled();
    await expect(page.getByLabel('Purity')).toBeDisabled();
    await expect(page.getByLabel('Selling Method')).toBeDisabled();
    // staff do edit stock
    await piece(page, PIECE_1).getByLabel('Remarks').fill('staff note');
    await saveChanges(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Stock saved.' })).toBeVisible();
    expect(writes.map((w) => w.body?.changes)).toEqual([{ notes: 'staff note' }]);
    // the settings are not theirs
    await page.goto('/settings');
    await expect(page.getByText('Not available for your role')).toBeVisible();
    // and the API says the same to a staff session that asks directly
    const staffCalls = await asRole('staff');
    try {
      const put = await staffCalls.call('PUT', '/v1/settings/business', { value: { phone: '1' } });
      expect(put.status).toBe(403);
      expect(put.json.error.code).toBe('JV_FORBIDDEN');
      const rate = await staffCalls.call('POST', '/v1/daily-rates', {
        material: 'Gold',
        purity: '22K',
        rate_per_gram: '7000.00',
        rate_date: businessDate(),
      });
      expect(rate.status).toBe(403);
      const material = await staffCalls.call('PATCH', `/v1/designs/${designId}`, {
        expected_updated_at: await wireStamp('designs', `design_no = '${DESIGN_NO}'`),
        changes: { material: 'Silver' },
      });
      expect(material.status).toBe(403);
    } finally {
      await staffCalls.end();
    }

    // the owner sees the original weight, and it is the one the server holds
    await logout(page);
    const owner = e2eLogin('owner');
    await open(page, owner, `/edit-stock?id=${designId}`);
    await expect(piece(page, PIECE_1).getByLabel('Original Net Wt (g)')).toHaveValue('10.125');
    await expect(page.getByLabel('Material')).toBeEnabled();
  });

  test('a biller cannot open the stock editor or the settings', async ({ page }) => {
    const biller = e2eLogin('biller');
    await open(page, biller, '/edit-stock');
    await expect(page.getByText('Not available for your role')).toBeVisible();
    await page.goto('/settings');
    await expect(page.getByText('Not available for your role')).toBeVisible();
  });
});

test.describe('PT-W5: settings are one row for each section (D3, A4)', () => {
  test.describe.configure({ timeout: 180_000 });
  let before = '';

  test.beforeEach(async () => {
    before = await laneSql(
      `SELECT setting_key, value FROM settings WHERE setting_key IN ('business', 'estimate', 'numbering')`
    );
  });

  test.afterEach(async () => {
    // put the three sections back as the lane made them
    for (const line of before.trim().split('\n')) {
      const [key, ...rest] = line.split('\t');
      await laneSql(
        `UPDATE settings SET value = '${rest.join('\t').replaceAll("'", "''")}' WHERE setting_key = '${key}'`
      );
    }
  });

  test('a section is saved with its own button as ONE PUT of { value }; nothing is sent while typing; a refusal shows the reason and keeps what was typed; it persists after a reload', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const writes = trackWrites(page);
    await open(page, owner, '/settings?tab=business');
    await expect(page.getByLabel('Phone')).toBeVisible();
    await page.getByLabel('Phone').fill('0141-2222');
    await page.getByLabel('Address').fill('Johari Bazaar, Jaipur');
    expect(writes, 'nothing is sent while typing').toEqual([]);
    await page.getByRole('button', { name: 'Save Business Settings' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Business settings saved.' })
    ).toBeVisible();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual(['PUT /v1/settings/business']);
    // the body is { value } and nothing else: no stale stamp, the last write wins
    expect(Object.keys(writes[0].body ?? {})).toEqual(['value']);
    expect(writes[0].body?.value).toMatchObject({
      phone: '0141-2222',
      address: 'Johari Bazaar, Jaipur',
      displayName: 'Jaishri Gold Palace',
    });

    // a value the API refuses (a bill prefix with a space) shows its reason, and the screen keeps what was typed
    await page.getByRole('button', { name: 'Estimate Settings' }).click();
    await page.getByLabel('Estimate prefix').fill('BAD PREFIX');
    await page.getByRole('button', { name: 'Save Estimate Settings' }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Nothing was changed.' })).toBeVisible();
    await expect(page.getByLabel('Estimate prefix')).toHaveValue('BAD PREFIX');
    expect(await laneSql(`SELECT value FROM settings WHERE setting_key = 'estimate'`)).toContain(
      '"prefix":"JV"'
    );

    // a good one
    await page.getByLabel('Estimate prefix').fill('jv2');
    await page.getByRole('button', { name: 'Save Estimate Settings' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Estimate settings saved.' })
    ).toBeVisible();
    // the business section, the estimate section that was refused, and the estimate section that was saved
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'PUT /v1/settings/business',
      'PUT /v1/settings/estimate',
      'PUT /v1/settings/estimate',
    ]);
    // the estimate row holds no rate (the rates are daily_rates rows) and the numbering holds no category prefixes (they are categories)
    expect(Object.keys(writes[2].body?.value).sort()).toEqual(['footerNote', 'prefix', 'roundOff']);
    const estimate = await laneSql(`SELECT value FROM settings WHERE setting_key = 'estimate'`);
    expect(estimate).toContain('"prefix":"JV2"');
    expect(estimate).not.toContain('defaultGoldRate');
    expectNothingMadeUp(writes);

    // persists
    await page.goto('/settings?tab=business');
    await expectApp(page, owner);
    await expect(page.getByLabel('Phone')).toHaveValue('0141-2222');
    await page.getByRole('button', { name: 'Numbering' }).click();
    await page.getByLabel('SKU serial padding').fill('4');
    await page.getByRole('button', { name: 'Save Numbering' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Numbering saved.' })).toBeVisible();
    expect(
      await laneSql(`SELECT value FROM settings WHERE setting_key = 'numbering'`)
    ).not.toContain('categoryPrefixes');
    expect(await laneSql(`SELECT value FROM settings WHERE setting_key = 'numbering'`)).toContain(
      '"skuPadding":4'
    );
  });

  test('the users are shown and not edited here: logins belong to the admin tool', async ({
    page,
  }) => {
    await open(page, e2eLogin('owner'), '/settings?tab=users');
    await expect(page.locator('section').getByText('Test owner')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Add User' })).toHaveCount(0);
  });
});

test.describe('PT-W5: categories and sub-categories (D5, A5, C11)', () => {
  test.describe.configure({ timeout: 180_000 });

  test.afterEach(async () => {
    await laneSql(
      `DELETE FROM subcategories WHERE category_id IN (SELECT id FROM categories WHERE name LIKE 'WEB05 %'); DELETE FROM categories WHERE name LIKE 'WEB05 %'; ` +
        `UPDATE subcategories SET active = 1`
    );
  });

  test('a new category and sub-category come back from the server with their own ids; a rename and a removal are ordinary edits; a removed name comes back as the same row', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const writes = trackWrites(page);
    await open(page, owner, '/settings?tab=categories');

    await page.getByPlaceholder('Add category').fill('WEB05 Anklet');
    await page.getByLabel('Prefix of the new category').fill('WB5');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(page.getByRole('status').filter({ hasText: 'Category saved.' })).toBeVisible();
    expect(writes).toHaveLength(1);
    expect(writes[0]).toMatchObject({ method: 'POST', path: '/v1/categories' });
    // the browser names the name and the prefix and nothing else: the id, the stamps and the person are the server's
    expect(writes[0].body).toEqual({ name: 'WEB05 Anklet', prefix: 'WB5' });
    const made = (await laneSql(`SELECT id, prefix FROM categories WHERE name = 'WEB05 Anklet'`))
      .trim()
      .split('\t');
    expect(made[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(made[1]).toBe('WB5');
    await expect(page.getByText('WEB05 Anklet').first()).toBeVisible();

    // a prefix the API will not take is refused before any call
    await page.getByPlaceholder('Add category').fill('WEB05 Bad');
    await page.getByLabel('Prefix of the new category').fill('B');
    await page.getByRole('button', { name: 'Save', exact: true }).first().click();
    await expect(
      page.getByRole('alert').filter({ hasText: '2 to 6 capital letters or digits' })
    ).toBeVisible();
    expect(writes).toHaveLength(1);

    // a sub-category of the new category
    await page.getByLabel('Category of the sub-categories').selectOption('WEB05 Anklet');
    await page.getByPlaceholder('e.g. Antique, Bridal, Daily Wear').fill('Plain');
    await page.getByRole('button', { name: 'Add Subcategory' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Subcategory saved.' })).toBeVisible();
    expect(writes[1]).toMatchObject({ method: 'POST', path: '/v1/subcategories' });
    expect(Object.keys(writes[1].body ?? {}).sort()).toEqual(['category_id', 'name']);
    await expect(page.getByText('Plain', { exact: true })).toBeVisible();

    // rename: an ordinary edit with the exact stamp of the row
    const subStamp = await wireStamp('subcategories', `name = 'Plain'`);
    await page.getByRole('button', { name: 'Edit', exact: true }).click();
    await page.locator('input.flex-1').fill('Plain 2');
    await page.getByRole('button', { name: 'Save', exact: true }).last().click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Subcategory updated.' })
    ).toBeVisible();
    expect(writes[2].body).toEqual({ expected_updated_at: subStamp, changes: { name: 'Plain 2' } });
    await expect(page.getByText('Plain 2', { exact: true })).toBeVisible();

    // removal is active = 0 (nothing is deleted)
    page.once('dialog', (dialog) => void dialog.accept());
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Subcategory deleted.' })
    ).toBeVisible();
    expect(await laneSql(`SELECT active FROM subcategories WHERE name = 'Plain 2'`)).toBe('0\n');
    await expect(page.getByText('Plain 2', { exact: true })).toHaveCount(0);

    // the same name again brings the row back
    await page.getByPlaceholder('e.g. Antique, Bridal, Daily Wear').fill('Plain 2');
    await page.getByRole('button', { name: 'Add Subcategory' }).click();
    await expect(page.getByText('Plain 2', { exact: true })).toBeVisible();
    expect(
      await laneSql(`SELECT COUNT(*), MAX(active) FROM subcategories WHERE name = 'Plain 2'`)
    ).toBe('1\t1\n');
    expectNothingMadeUp(writes);

    // and it all persists
    await page.reload();
    await expectApp(page, owner);
    await expect(page.getByText('WEB05 Anklet').first()).toBeVisible();
  });
});

test.describe('PT-W5: the daily rates (D4, R2, Y8)', () => {
  test.describe.configure({ timeout: 180_000 });

  test.beforeEach(async () => {
    await laneSql(`DELETE FROM daily_rates`);
  });
  test.afterEach(async () => {
    await laneSql(`DELETE FROM daily_rates`);
  });

  test("the owner enters today's rate, then an earlier day's, and corrects today's; each purity is a row of its own", async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const writes = trackWrites(page);
    await open(page, owner, '/');
    const gold22 = page.getByLabel('Gold 22K rate (per gram)');
    await expect(gold22).toBeVisible();
    await expect(gold22).toHaveValue('');
    await gold22.fill('7345.5');
    await page.getByLabel('Silver 925 rate (per gram)').fill('88');
    await page.getByRole('button', { name: 'Save Rates' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Rates saved' })).toBeVisible();
    expect(writes.map((w) => `${w.method} ${w.path}`)).toEqual([
      'POST /v1/daily-rates',
      'POST /v1/daily-rates',
    ]);
    expect(writes[0].body).toEqual({
      material: 'Gold',
      purity: '22K',
      rate_per_gram: '7345.50',
      rate_date: businessDate(),
    });
    expect(
      await laneSql(
        `SELECT material, purity, rate_per_gram, rate_date FROM daily_rates ORDER BY material`
      )
    ).toBe(`Gold\t22K\t7345.50\t${businessDate()}\nSilver\t925\t88.00\t${businessDate()}\n`);
    // the rate shows as the server stored it, and an unchanged rate is not sent again
    await expect(gold22).toHaveValue('7345.50');

    // an earlier day: the owner may (Y8), the rate card shows the last rate to start from
    await page.getByLabel('Rates for').fill(businessDate(1));
    await expect(gold22).toHaveValue('');
    await gold22.fill('7300');
    await page.getByRole('button', { name: 'Save Rates' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Rates saved' })).toBeVisible();
    expect(
      await laneSql(`SELECT rate_per_gram FROM daily_rates WHERE rate_date = '${businessDate(1)}'`)
    ).toBe('7300.00\n');
    // the rate of an earlier day is not corrected from here
    await expect(gold22).toBeDisabled();

    // today's rate is corrected in place: one PATCH with the exact stamp
    await page.getByLabel('Rates for').fill(businessDate());
    const stamp = await wireStamp(
      'daily_rates',
      `rate_date = '${businessDate()}' AND purity = '22K'`
    );
    await expect(gold22).toHaveValue('7345.50');
    await gold22.fill('7350');
    const before = writes.length;
    await page.getByRole('button', { name: 'Save Rates' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Rates saved' })).toBeVisible();
    expect(
      writes.slice(before).map((w) => `${w.method} ${w.path.replace(/[0-9a-f-]{36}/, ':id')}`)
    ).toEqual(['PATCH /v1/daily-rates/:id']);
    expect(writes[before].body).toEqual({
      expected_updated_at: stamp,
      changes: { rate_per_gram: '7350.00' },
    });
    expect(
      await laneSql(
        `SELECT COUNT(*) FROM daily_rates WHERE rate_date = '${businessDate()}' AND purity = '22K'`
      )
    ).toBe('1\n');
    expect(
      await laneSql(
        `SELECT rate_per_gram FROM daily_rates WHERE rate_date = '${businessDate()}' AND purity = '22K'`
      )
    ).toBe('7350.00\n');
    expectNothingMadeUp(writes);
  });

  test("a biller can enter today's rate and not yesterday's, and cannot correct one (the API decides; the dashboard's rate card is the owner's, spec 1.3)", async () => {
    const biller = await asRole('biller');
    try {
      const yesterday = await biller.call('POST', '/v1/daily-rates', {
        material: 'Gold',
        purity: '22K',
        rate_per_gram: '7000.00',
        rate_date: businessDate(1),
      });
      expect(yesterday.status).toBe(422);
      expect(yesterday.json.error.code).toBe('JV_INVALID_INPUT');
      expect(await laneSql(`SELECT COUNT(*) FROM daily_rates`)).toBe('0\n');

      const today = await biller.call('POST', '/v1/daily-rates', {
        material: 'Gold',
        purity: '22K',
        rate_per_gram: '7000.00',
        rate_date: businessDate(),
      });
      expect(today.status).toBe(201);
      expect(today.json.row.rate_date).toBe(businessDate());
      expect(today.json.row.rate_per_gram).toBe('7000.00');

      const correction = await biller.call('PATCH', `/v1/daily-rates/${today.json.row.id}`, {
        expected_updated_at: today.json.row.updated_at,
        changes: { rate_per_gram: '7100.00' },
      });
      expect(correction.status).toBe(403);
      expect(await laneSql(`SELECT rate_per_gram FROM daily_rates`)).toBe('7000.00\n');
    } finally {
      await biller.end();
    }
  });
});

test.describe("T-E05 and T-C01: nothing in the browser's storage, and nothing made up", () => {
  test.describe.configure({ timeout: 180_000 });

  test('after a session of edits no business data is in local storage, session storage or IndexedDB, and the old jaishri.* keys are neither read nor wiped', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await page.goto('/');
    await page.evaluate(() =>
      window.localStorage.setItem('jaishri.designs.v1', JSON.stringify([{ id: 'legacy-design' }]))
    );
    await open(page, owner, `/edit-stock?id=${designId}`);
    await expect(page.getByLabel('Design Name')).toHaveValue('Edit test design'); // not the legacy design
    await piece(page, PIECE_1).getByLabel('Remarks').fill('a note');
    await saveChanges(page).click();
    await expect(page.getByRole('status').filter({ hasText: 'Stock saved.' })).toBeVisible();
    await page.goto('/settings?tab=business');
    await expectApp(page, owner);
    const storage = await browserStorage(page);
    // the page's own legacy key is exactly as it was (IM7 reads it once, nothing else touches it) and nothing else is there
    expect(storage.local).toEqual({
      'jaishri.designs.v1': JSON.stringify([{ id: 'legacy-design' }]),
    });
    expect(storage.session).toEqual({});
    expect(storage.databases).toEqual([]);
  });
});
