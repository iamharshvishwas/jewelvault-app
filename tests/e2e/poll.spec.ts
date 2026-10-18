import { execFile, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import {
  expect,
  test,
  type BrowserContext,
  type Locator,
  type Page,
  type Request,
} from '@playwright/test';
import { e2eLane, e2eLogin, type E2eLogin, type E2eRole } from './global-setup';

// WEB04: the poller in a real browser against the real API of a lane (spec C3, C4, C7, C18, U6).
//   T-E02  (two browsers) a stock change on one shows on the other within 10 seconds; a piece sold on one shows Sold on the other
//   T-E07  a row committed late by a 20-second transaction run directly on the database still arrives; a 1,500-row poll arrives in full through paging;
//          two rows with the same updated_at at a page edge are both received; a row stamped at the start of a 40-second import transaction still arrives
//          (the import ends as IM1 says); a hydrate slowed to 40 seconds with a transaction that commits 4 seconds after the first page still ends with that
//          row on screen; a hidden tab polls every 30 seconds and at once when shown; the browser polls every 8 seconds
//   T-E03  with the network cut the banner appears and Save is disabled and both clear after reconnect; a gateway error followed by a normal reply shows
//          "Waking up…" and then clears
//   T-E01  (poll clauses) a user deactivated while signed in is logged out at the next poll; a user demoted from owner to biller while signed in (admin door)
//          loses sku_private from memory within one poll, and the screen calls `me` once and does not loop
//   T-E05  (clause) logout stops the poller
//
// "The other browser" cannot be made to change something by a screen yet (the writes come with WEB05 to WEB09), so the change is made where the owner of the
// shop's other browser would make it: rows written directly in the lane's database as root (a stock change, a sold piece, a long transaction), and the admin
// door for a user. The halves that need a money screen are proved where the screen is: "after a payment the other browser's pending and balance change" in
// payments.spec.ts (WEB09), "a money call retried meanwhile with the same key saves once" in billing.spec.ts (WEB08) and payments.spec.ts (WEB09); "cancelling an
// unpaid bill changes the other browser's outstanding" waits for the owner's screens of WEB11. The unit tests (tests/unit/poll.test.ts) already prove that the touched
// bill-summary and customer-balances rows reach memory.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/poll.spec.ts

const execFileAsync = promisify(execFile);

// ------------------------------------------------------------------------------------------------ the page

/** The sidebar of the application (a page may have a second `aside`, like the inventory's filters, after it). */
const aside = (page: Page) => page.locator('aside').first();

async function openLoginScreen(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
}

async function submitLogin(page: Page, who: E2eLogin) {
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** The application is on screen: the gate has opened and the sidebar names the person. */
async function expectApp(page: Page, who: E2eLogin, timeout = 60_000) {
  await expect(aside(page)).toContainText(who.fullName, { timeout });
}

async function signInAs(page: Page, who: E2eLogin) {
  await openLoginScreen(page);
  await submitLogin(page, who);
  await expectApp(page, who);
}

/** Signs in and opens the inventory: the cards of the designs are what these tests read. */
async function openInventory(page: Page, who: E2eLogin) {
  await signInAs(page, who);
  await page.goto('/inventory-management');
  await expectApp(page, who);
}

/** The card of a design in the inventory grid. */
const card = (page: Page, designNo: string): Locator =>
  page.locator('div.jewel-card').filter({ hasText: designNo });

const banner = (page: Page) => page.getByTestId('connection-banner');
const saveRates = (page: Page) => page.getByRole('button', { name: 'Save Rates' });

// ------------------------------------------------------------------------------------------------ what the browser asks the API

interface PollCall {
  /** Milliseconds on this computer's clock when the request left the browser. */
  at: number;
  resources: string[];
  /** The cursors of the request as sent. */
  cursors: Record<string, { updated_at: string; key?: string | null } | null>;
  limit: number | undefined;
}

/** Every `POST /v1/sync/poll` the page sends. */
function trackPolls(page: Page): PollCall[] {
  const { apiUrl } = e2eLane();
  const calls: PollCall[] = [];
  page.on('request', (request: Request) => {
    if (request.method() !== 'POST' || request.url() !== `${apiUrl}/v1/sync/poll`) return;
    const body = request.postDataJSON() as { cursors: PollCall['cursors']; limit?: number };
    calls.push({
      at: Date.now(),
      resources: Object.keys(body.cursors),
      cursors: body.cursors,
      limit: body.limit,
    });
  });
  return calls;
}

/** Every first page of the hydrate (a `GET /v1/sync/<resource>` with no cursor), by resource. */
function trackHydratePages(page: Page): string[] {
  const { apiUrl } = e2eLane();
  const pages: string[] = [];
  page.on('request', (request: Request) => {
    if (request.method() !== 'GET' || !request.url().startsWith(`${apiUrl}/v1/sync/`)) return;
    const url = new URL(request.url());
    if (!url.searchParams.has('updated_after')) pages.push(url.pathname.slice('/v1/sync/'.length));
  });
  return pages;
}

/** Every `GET /v1/auth/me` the page sends. */
function trackMe(page: Page): number[] {
  const { apiUrl } = e2eLane();
  const calls: number[] = [];
  page.on('request', (request: Request) => {
    if (request.method() === 'GET' && request.url() === `${apiUrl}/v1/auth/me`)
      calls.push(Date.now());
  });
  return calls;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The CORS headers a made-up answer needs so that the browser hands it to the page. */
const corsHeaders = () => ({
  'access-control-allow-origin': e2eLane().webOrigin,
  'access-control-allow-credentials': 'true',
});

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

const SQL_CLIENT = 'exec mariadb -uroot -p"$MARIADB_ROOT_PASSWORD" jv_lane -N -B';

/** SQL as root in the lane's container, to the end. The password never leaves the container: the shell inside it reads it from its own environment. */
async function laneSql(sql: string): Promise<string> {
  const { stdout } = await execFileAsync(
    'docker',
    ['exec', laneContainer(), 'sh', '-c', `${SQL_CLIENT} -e "$1"`, 'sh', sql],
    { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }
  );
  return stdout;
}

/**
 * A transaction that stays open while the test does other things: statements are written to the SQL client as they are wanted, and the client runs each as it
 * reads it (the test that shows it: another connection sees nothing of the rows until `COMMIT`).
 */
function openTransaction() {
  const child: ChildProcessWithoutNullStreams = spawn(
    'docker',
    ['exec', '-i', laneContainer(), 'sh', '-c', SQL_CLIENT],
    { stdio: ['pipe', 'pipe', 'pipe'] }
  );
  let errors = '';
  child.stderr.on('data', (chunk: Buffer) => (errors += chunk.toString()));
  const closed = new Promise<void>((resolve, reject) => {
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(`the SQL client ended with ${code}: ${errors}`))
    );
  });
  return {
    run: (sql: string) => void child.stdin.write(`${sql}\n`),
    /** Ends the input; resolves when the client has run everything. */
    finish: async () => {
      child.stdin.end();
      await closed;
    },
  };
}

const designSql = (designNo: string, name: string) =>
  `INSERT INTO designs (id, design_no, name, category_id, material, purity, selling_method) ` +
  `SELECT UUID_v4(), '${designNo}', '${name}', id, 'Gold', '22K', 'By Weight' FROM categories ORDER BY name LIMIT 1;`;

const pieceSql = (designNo: string, skuNo: string, barcode: string) =>
  `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) ` +
  `SELECT UUID_v4(), id, '${skuNo}', '${barcode}', 12.500, 11.250, 'In Stock' FROM designs WHERE design_no = '${designNo}';`;

/** A piece sold: a bill of the walk-in customer, and the piece Sold on it (what the bill function will do in WEB09). */
const sellSql = (skuNo: string, billNo: string) =>
  `INSERT INTO bills (id, bill_no, customer_id, bill_date, sale_type, grand_total) ` +
  `SELECT UUID_v4(), '${billNo}', id, CURDATE(), 'Retail', 1000.00 FROM customers WHERE is_walkin = 1; ` +
  `UPDATE skus SET status = 'Sold', sold_bill_id = (SELECT id FROM bills WHERE bill_no = '${billNo}') WHERE sku_no = '${skuNo}';`;

/** Everything these tests made, gone again, and the setting data_epoch as the harness left it. */
async function cleanLane(epoch: string | null) {
  await laneSql(
    `DELETE FROM sku_private WHERE sku_id IN (SELECT id FROM skus WHERE sku_no LIKE 'POLL-%'); ` +
      `DELETE FROM skus WHERE sku_no LIKE 'POLL-%'; DELETE FROM bills WHERE bill_no LIKE 'POLL-%'; ` +
      `DELETE FROM designs WHERE design_no LIKE 'POLL-%'` +
      (epoch === null
        ? ''
        : `; UPDATE settings SET value = '${epoch}' WHERE setting_key = 'data_epoch'`)
  );
}

// ------------------------------------------------------------------------------------------------ users made through the admin door

interface MadeUser extends E2eLogin {
  id: string;
}

async function admin(method: 'GET' | 'POST', path: string, body?: unknown) {
  const { apiUrl, adminToken } = e2eLane();
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${adminToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json().catch(() => null)) as unknown };
}

async function asSite(
  path: string,
  options: { body?: unknown; cookie?: string } = {}
): Promise<{ status: number; json: unknown; cookie: string | null }> {
  const { apiUrl, webOrigin } = e2eLane();
  const headers: Record<string, string> = { origin: webOrigin, 'x-jv-client': 'web' };
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${apiUrl}${path}`, {
    method: 'POST',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const setCookie = response.headers.getSetCookie?.()[0];
  return {
    status: response.status,
    json: await response.json().catch(() => null),
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

/** A user of the given role of our own (made, signed in once, given a password of their own: no change-password gate), so that a test can deactivate or demote them. */
async function makeSettledUser(role: E2eRole, tag: string): Promise<MadeUser> {
  const email = `${tag}-${randomBytes(4).toString('hex')}@jv-e2e.test`;
  const fullName = `E2E ${tag}`;
  const made = await admin('POST', '/admin/v1/users', { email, full_name: fullName, role });
  expect(made.status, 'the admin door made the user').toBe(201);
  const body = made.json as { user: { id: string }; temporary_password: string };
  const login = await asSite('/v1/auth/login', {
    body: { email, password: body.temporary_password },
  });
  expect(login.status, 'the first login with the temporary password').toBe(200);
  const password = `${randomBytes(12).toString('base64url')}-Aa1`;
  const changed = await asSite('/v1/auth/change-password', {
    cookie: login.cookie ?? '',
    body: { current_password: body.temporary_password, new_password: password },
  });
  expect(changed.status, 'the password change').toBe(200);
  await asSite('/v1/auth/logout', { cookie: login.cookie ?? '' });
  return { id: body.user.id, email, fullName, password };
}

// ------------------------------------------------------------------------------------------------ the tests

let epochBefore: string | null = null;

test.beforeAll(async () => {
  epochBefore =
    (await laneSql(`SELECT value FROM settings WHERE setting_key = 'data_epoch'`)).trim() || null;
  await cleanLane(null);
});

test.afterEach(async () => {
  await cleanLane(epochBefore);
});

// ---- T-E02

test.describe('T-E02: a change made by somebody else shows on the other browser within 10 seconds (C4, C9)', () => {
  test.describe.configure({ timeout: 150_000 });

  test('a stock change and a piece sold on one show on the other: two browsers, the owner and the biller', async ({
    browser,
  }) => {
    const owner = e2eLogin('owner');
    const biller = e2eLogin('biller');
    const contexts: BrowserContext[] = [await browser.newContext(), await browser.newContext()];
    try {
      const [a, b] = await Promise.all(contexts.map((c) => c.newPage()));
      await openInventory(a, owner);
      await openInventory(b, biller);
      await expect(a.getByText('No designs yet')).toBeVisible();
      await expect(b.getByText('No designs yet')).toBeVisible();

      // a design and its piece are put in stock
      await laneSql(
        designSql('POLL-00001', 'Poll test design') +
          pieceSql('POLL-00001', 'POLL-00001-001', 'PB00001001')
      );
      for (const page of [a, b]) {
        await expect(card(page, 'POLL-00001')).toBeVisible({ timeout: 10_000 });
        await expect(card(page, 'POLL-00001').getByText('In Stock')).toBeVisible();
        await expect(card(page, 'POLL-00001')).toContainText('1 SKU');
      }

      // the piece is sold: Sold on both, within 10 seconds
      await laneSql(sellSql('POLL-00001-001', 'POLL-B-0001'));
      for (const page of [a, b]) {
        await expect(card(page, 'POLL-00001').getByText('Sold')).toBeVisible({ timeout: 10_000 });
        await expect(card(page, 'POLL-00001').getByText('In Stock')).toHaveCount(0);
      }
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });

  // The money halves: a payment moving the pending of a bill and the balance of the customer on the other browser is proved in payments.spec.ts (WEB09: T-E02 and T-E07 clauses,
  // through the real panel and the real X2); cancelling an unpaid bill comes with the owner's screens of WEB11.
  test.fixme("cancelling an unpaid bill changes the other browser's outstanding within 10 seconds (WEB11)", () =>
    undefined);
});

// ---- T-E07

test.describe('T-E07: polling (C3, C4)', () => {
  test.describe.configure({ timeout: 180_000 });

  test('the browser polls every 8 seconds, one request at a time, for the 15 resources of the owner, from 30 seconds before the first page', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const polls = trackPolls(page);
    await signInAs(page, owner);
    await expect.poll(() => polls.length, { timeout: 60_000 }).toBeGreaterThanOrEqual(4);
    expect(polls[0].resources).toHaveLength(15);
    expect(polls[0].limit).toBe(1000);
    const gaps = polls.slice(1, 4).map((call, i) => call.at - polls[i].at);
    for (const gap of gaps) {
      expect(gap).toBeGreaterThanOrEqual(7500);
      expect(gap).toBeLessThanOrEqual(9500);
    }
    // the cursor is a stamp with six decimals and no key; the first poll starts before any row of today (30 s before the hydrate)
    for (const cursor of Object.values(polls[0].cursors)) {
      expect(cursor?.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
      expect(cursor && 'key' in cursor).toBe(false);
    }
  });

  test('a row committed late by a 20-second transaction run directly on the database still arrives', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await openInventory(page, owner);
    await expect(page.getByText('No designs yet')).toBeVisible();
    // stamped now, committed 20 seconds later; ten seconds in, another design is saved normally, which moves the cursor of the designs forward
    const late = laneSql(
      `START TRANSACTION; ${designSql('POLL-LATE', 'Committed late')} DO SLEEP(20); COMMIT;`
    );
    await sleep(10_000);
    await laneSql(designSql('POLL-NORMAL', 'Committed at once'));
    await expect(card(page, 'POLL-NORMAL')).toBeVisible({ timeout: 10_000 });
    await expect(card(page, 'POLL-LATE')).toHaveCount(0);
    await late;
    await expect(card(page, 'POLL-LATE')).toBeVisible({ timeout: 10_000 });
  });

  test('a 1,500-row poll arrives in full through paging (the rows share one updated_at, so the page edge cuts through a tie)', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const polls = trackPolls(page);
    await openInventory(page, owner);
    await expect(page.getByText('No designs yet')).toBeVisible();
    const before = polls.length;
    await laneSql(
      designSql('POLL-BULK', 'Bulk') +
        `INSERT INTO skus (id, design_id, sku_no, barcode, gross_weight, customer_net_weight, status) ` +
        `SELECT UUID_v4(), d.id, CONCAT('POLL-BULK-', LPAD(seq, 4, '0')), CONCAT('PBK', LPAD(seq, 6, '0')), 5.000, 4.500, 'In Stock' ` +
        `FROM seq_1_to_1500 s JOIN designs d ON d.design_no = 'POLL-BULK';`
    );
    await expect(card(page, 'POLL-BULK')).toContainText('1500 SKUs', { timeout: 15_000 });
    // the poll asked again for the one resource that was full, from the cursor the server gave (a stamp and a key)
    const more = polls.slice(before).filter((call) => call.resources.join() === 'skus');
    expect(more.length).toBeGreaterThanOrEqual(1);
    expect(more[0].cursors.skus?.key).toBeTruthy();
    expect(more[0].limit).toBe(1000);
  });

  test('two rows with the same updated_at at the edge of a page are both received', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    await openInventory(page, owner);
    await expect(page.getByText('No designs yet')).toBeVisible();
    // pages of ONE row: whatever is received comes one row at a time, so two rows with the same stamp are split by the page edge
    const asked: Array<{ resources: string[]; key: string | null | undefined }> = [];
    await page.route(`${apiUrl}/v1/sync/poll`, async (route) => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const body = request.postDataJSON() as { limit?: number; cursors: PollCall['cursors'] };
      asked.push({ resources: Object.keys(body.cursors), key: body.cursors.designs?.key });
      const response = await route.fetch({ postData: JSON.stringify({ ...body, limit: 1 }) });
      return route.fulfill({ response });
    });
    await laneSql(
      designSql('POLL-TIE-1', 'Tie one') +
        designSql('POLL-TIE-2', 'Tie two') +
        `UPDATE designs SET updated_at = NOW(6) WHERE design_no IN ('POLL-TIE-1', 'POLL-TIE-2');`
    );
    const stamps = (
      await laneSql(
        `SELECT COUNT(DISTINCT updated_at) FROM designs WHERE design_no LIKE 'POLL-TIE-%'`
      )
    ).trim();
    expect(stamps, 'the two rows carry one updated_at').toBe('1');
    await expect(card(page, 'POLL-TIE-1')).toBeVisible({ timeout: 15_000 });
    await expect(card(page, 'POLL-TIE-2')).toBeVisible({ timeout: 15_000 });
    expect(asked.some((call) => call.resources.join() === 'designs' && call.key)).toBe(true);
  });

  test('a row stamped at the start of a 40-second import transaction still arrives: the import ends as IM1 says, with a new data_epoch, and the screen hydrates again', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const owner = e2eLogin('owner');
    const hydrated = trackHydratePages(page);
    await openInventory(page, owner);
    await expect(page.getByText('No designs yet')).toBeVisible();
    const pagesBefore = hydrated.length;
    // The import: stamped at its start, 40 seconds long, ending with one statement that re-stamps what it changed and a new value of data_epoch, then COMMIT
    const importing = laneSql(
      `START TRANSACTION; ${designSql('POLL-IMPORT', 'Imported')} DO SLEEP(40); ` +
        `UPDATE designs SET updated_at = NOW(6) WHERE design_no = 'POLL-IMPORT'; ` +
        `UPDATE settings SET value = JSON_OBJECT('epoch', DATE_FORMAT(NOW(6), '%Y-%m-%d %H:%i:%s.%f')) WHERE setting_key = 'data_epoch'; COMMIT;`
    );
    // thirty-odd seconds in, another design is saved the ordinary way: the cursor of the designs is now past the start of the import
    await sleep(33_000);
    await laneSql(designSql('POLL-ORDINARY', 'Ordinary'));
    await expect(card(page, 'POLL-ORDINARY')).toBeVisible({ timeout: 10_000 });
    await importing;
    await expect(card(page, 'POLL-IMPORT')).toBeVisible({ timeout: 20_000 });
    // data_epoch changed: the screen hydrated again, all 15 tables from their first page
    expect(hydrated.length - pagesBefore).toBeGreaterThanOrEqual(15);
    await expectApp(page, owner);
  });

  test('a hydrate slowed to 40 seconds, while a transaction stamped before its first page commits 4 seconds after it, still ends with that row on screen', async ({
    page,
  }) => {
    test.setTimeout(240_000);
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    await openLoginScreen(page);
    // the last table of the hydrate is held for 40 seconds; the page of designs that the hydrate reads is looked at, to know whether it had the row
    let firstPageAt = 0;
    let designsHadTheRow: boolean | null = null;
    await page.route(`${apiUrl}/v1/sync/*`, async (route) => {
      const url = new URL(route.request().url());
      const resource = url.pathname.slice('/v1/sync/'.length);
      if (resource === 'poll') return route.fallback();
      if (firstPageAt === 0) firstPageAt = Date.now();
      if (resource === 'customer-balances') await sleep(40_000);
      if (resource === 'designs' && designsHadTheRow === null) {
        const response = await route.fetch();
        designsHadTheRow = (await response.text()).includes('POLL-SLOW');
        return route.fulfill({ response });
      }
      return route.fallback();
    });
    // the row is stamped now, before anything is read, and its transaction stays open
    const tx = openTransaction();
    tx.run(`START TRANSACTION; ${designSql('POLL-SLOW', 'Committed after the first page')}`);
    await sleep(1500);
    const loginAt = Date.now();
    await submitLogin(page, owner);
    await expect.poll(() => firstPageAt, { timeout: 60_000 }).toBeGreaterThan(0);
    await sleep(4000);
    tx.run('COMMIT;');
    await tx.finish();
    // the hydrate (about 40 seconds) ends; the first poll starts from 30 seconds before its first page, which is before the row's stamp. The row is not in the hydrate
    // (the designs were read within a second of the start, four seconds before the commit): if it is on screen it came with the poll. Moving to the inventory through the
    // sidebar keeps memory (a reload would hydrate again from the database and prove nothing).
    await expectApp(page, owner, 90_000);
    expect(Date.now() - loginAt, 'the hydrate took about 40 seconds').toBeGreaterThanOrEqual(
      38_000
    );
    expect(designsHadTheRow, "the hydrate's page of designs was read before the commit").toBe(
      false
    );
    await aside(page).locator('a[href="/inventory-management"]').first().click();
    await expect(page.getByText(/\d+ designs? · \d+ SKUs?/)).toBeVisible();
    await expect(card(page, 'POLL-SLOW')).toBeVisible({ timeout: 20_000 });
  });

  test('a hidden tab polls every 30 seconds, and at once when it is shown', async ({ page }) => {
    const owner = e2eLogin('owner');
    const polls = trackPolls(page);
    await signInAs(page, owner);
    await expect.poll(() => polls.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);
    const hide = () =>
      page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'hidden',
        });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    const show = () =>
      page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', {
          configurable: true,
          get: () => 'visible',
        });
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
        document.dispatchEvent(new Event('visibilitychange'));
      });
    await hide();
    const hiddenAt = Date.now();
    const base = polls.length;
    await sleep(22_000);
    expect(polls.length, 'no poll in the first 22 seconds of a hidden tab').toBe(base);
    await expect.poll(() => polls.length, { timeout: 15_000 }).toBe(base + 1);
    const gap = polls[base].at - polls[base - 1].at;
    expect(gap).toBeGreaterThanOrEqual(28_000);
    expect(gap).toBeLessThanOrEqual(33_000);
    expect(polls[base].at - hiddenAt).toBeLessThan(31_000);
    // shown again: a poll at once, not after the rest of the 30 seconds
    const shownAt = Date.now();
    await show();
    await expect.poll(() => polls.length, { timeout: 5000 }).toBe(base + 2);
    expect(polls[base + 1].at - shownAt).toBeLessThan(3000);
  });
});

// ---- T-E03

test.describe('T-E03: offline and "Waking up…" (C7)', () => {
  test.describe.configure({ timeout: 150_000 });

  test('with the network cut a banner appears and Save is disabled while the screen keeps reading from memory; both clear after reconnect', async ({
    page,
    context,
  }) => {
    const owner = e2eLogin('owner');
    await signInAs(page, owner);
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toBeVisible();
    await expect(banner(page)).toHaveCount(0);
    await expect(saveRates(page)).toBeEnabled();

    await context.setOffline(true);
    // the next poll cannot reach the server (within 8 seconds)
    await expect(banner(page)).toHaveText('Offline: changes cannot be saved', { timeout: 15_000 });
    await expect(saveRates(page)).toBeDisabled();
    await expect(saveRates(page)).toHaveAttribute('title', 'Offline: changes cannot be saved');
    // reads continue from memory
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toBeVisible();
    await expect(aside(page)).toContainText(owner.fullName);

    await context.setOffline(false);
    await expect(banner(page)).toHaveCount(0, { timeout: 20_000 });
    await expect(saveRates(page)).toBeEnabled();
  });

  test('a gateway error followed by a normal reply shows "Waking up…" and then clears', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    await signInAs(page, owner);
    await expect(saveRates(page)).toBeEnabled();
    // the next four polls are answered by a proxy in front of a sleeping app (an HTML page with a 502); the client retries 1, 2 and 4 seconds apart
    let bad = 0;
    await page.route(`${apiUrl}/v1/sync/poll`, async (route) => {
      if (route.request().method() !== 'POST') return route.fallback();
      if (bad < 4) {
        bad += 1;
        return route.fulfill({
          status: 502,
          contentType: 'text/html',
          headers: corsHeaders(),
          body: '<html><body><h1>502 Bad Gateway</h1></body></html>',
        });
      }
      return route.fallback();
    });
    await expect(banner(page)).toHaveText('Waking up…', { timeout: 15_000 });
    await expect(saveRates(page)).toBeDisabled();
    await expect(banner(page)).toHaveAttribute('data-state', 'waking');
    // the app is awake: the next reply is normal and the banner clears
    await expect(banner(page)).toHaveCount(0, { timeout: 30_000 });
    await expect(saveRates(page)).toBeEnabled();
    expect(bad).toBe(4);
  });

  // A money call retried while the banner is up, with the same Idempotency-Key, saves once: proved on X1 in billing.spec.ts (WEB08) and on X2 in payments.spec.ts (WEB09).
});

// ---- T-E01 and T-E05: the session

test.describe('T-E01: the session at the next poll (A10, U6, C18)', () => {
  test.describe.configure({ timeout: 150_000 });

  test('a user deactivated while signed in is logged out at the next poll: the login screen opens once, memory is empty, no more calls are made', async ({
    page,
  }) => {
    const user = await makeSettledUser('biller', 'deactivated');
    const polls = trackPolls(page);
    await signInAs(page, user);
    await expect.poll(() => polls.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const answer = await admin('POST', `/admin/v1/users/${user.id}/deactivate`);
    expect(answer.status, 'the admin door deactivated the user').toBe(200);
    const at = Date.now();
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 15_000 });
    expect(Date.now() - at, 'within one poll interval (8 seconds) and a little').toBeLessThan(
      12_000
    );
    await expect(page.locator('aside')).toHaveCount(0);
    // the poller stopped with the session (T-E05): nothing more is asked
    const asked = polls.length;
    await sleep(12_000);
    expect(polls.length).toBe(asked);
  });

  test('a user demoted from owner to biller while signed in loses sku_private from memory within one poll; the screen calls `me` once and does not loop', async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const user = await makeSettledUser('owner', 'demoted');
    const { apiUrl } = e2eLane();
    await laneSql(
      designSql('POLL-DEMO', 'Demotion') +
        pieceSql('POLL-DEMO', 'POLL-DEMO-001', 'PBDEMO001') +
        `INSERT INTO sku_private (sku_id, original_net_weight) SELECT id, 10.125 FROM skus WHERE sku_no = 'POLL-DEMO-001';`
    );
    const designId = (await laneSql(`SELECT id FROM designs WHERE design_no = 'POLL-DEMO'`)).trim();
    const polls = trackPolls(page);
    const mes = trackMe(page);
    const hydrated = trackHydratePages(page);
    await signInAs(page, user);
    await page.goto(`/design-detail?id=${designId}`);
    await expectApp(page, user);

    // the owner sees the owner-only weight of the piece
    const toggle = page.getByRole('button', { name: 'Show Original NW (Admin)' });
    const originalColumn = page.locator('td.text-amber-700');
    await toggle.click();
    await expect(originalColumn).toHaveCount(1);
    await expect(originalColumn.first()).toContainText('10.125 g');
    expect(hydrated).toContain('sku-private');
    await expect.poll(() => polls.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(2);

    // demoted through the admin door; within one poll the screen hydrates as a biller
    const meBefore = mes.length;
    const pollsBefore = polls.length;
    hydrated.length = 0;
    const answer = await admin('POST', `/admin/v1/users/${user.id}/role`, { role: 'biller' });
    expect(answer.status, 'the admin door changed the role').toBe(200);
    const at = Date.now();
    await expect(aside(page)).toContainText('Biller', { timeout: 20_000 });
    await expectApp(page, user);
    expect(Date.now() - at, 'within one poll interval and a little').toBeLessThan(15_000);
    // the owner-only data is gone from memory: the same screen, no reload, shows the piece without it
    await expect(page.getByText('Physical SKUs')).toContainText('1 pieces');
    await toggle.click();
    await expect(originalColumn).toHaveCount(1);
    expect((await originalColumn.first().innerText()).trim()).toBe('—');
    expect(hydrated).not.toContain('sku-private');
    expect(hydrated.length, "the biller's 14 tables").toBe(14);

    // `me` once for the change, and no loop: a minute later it is still once, and the polls go on, as a biller
    await sleep(20_000);
    expect(mes.length - meBefore).toBe(1);
    const asBiller = polls
      .slice(pollsBefore)
      .filter((call) => !call.resources.includes('sku-private'));
    expect(asBiller.length).toBeGreaterThanOrEqual(2);
    for (const call of asBiller) expect(call.resources).toHaveLength(14);
    await expect(page.locator('main').getByRole('alert')).toHaveCount(0);
    void apiUrl;
  });

  test('a logout stops the poller: nothing is asked afterwards (T-E05)', async ({ page }) => {
    const owner = e2eLogin('owner');
    const polls = trackPolls(page);
    await signInAs(page, owner);
    await expect.poll(() => polls.length, { timeout: 30_000 }).toBeGreaterThanOrEqual(1);
    const answered = page.waitForResponse(
      (response) =>
        response.url().endsWith('/v1/auth/logout') && response.request().method() === 'POST'
    );
    await aside(page).getByRole('button', { name: 'Logout', exact: true }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
    await answered;
    const asked = polls.length;
    await sleep(12_000);
    expect(polls.length).toBe(asked);
  });
});
