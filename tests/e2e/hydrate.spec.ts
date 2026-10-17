import { execFileSync } from 'node:child_process';
import { expect, test, type Page, type Request, type Route } from '@playwright/test';
import { e2eLane, e2eLogin, type E2eLogin, type E2eRole } from './global-setup';

// WEB03: the first hydrate behind the loading gate, in a real browser against the real API of a lane (spec C2, C3, C8, C9, U7, U8).
//   T-E05  after a session no business data is in browser storage (the old jaishri.* keys are neither read nor wiped); a failed load shows an error with
//          a retry and never sample data; logout empties memory and stops the load; nothing is shown until the load is whole, with "3 of 8 tables" while it runs
//   T-F03  (clause) 2,500 pieces all load in the browser, also with the API's page cap lowered to 500 (the cursor advances by the rows received)
//   T-E01  (clause) the loading gate shows the owner the rate card right after login (after the hydrate)
//   PT-W3  2,500 pieces, 2,000 customers (more than 1,500 rows of another resource) and the stock side arrive in full with progress shown
// The 10-second budget on a 4G profile is a measurement on the staging app (OPS04); the time of this run on this computer is attached to the test.
//
// The page cap of the API is a test seam of the API's own tests (registerSyncRoutes({ maxRows })); the lane's API is the built server, so the cap is lowered the other
// way round here: the browser's request is sent on with `limit=500`, and the API's answer (500 rows, `next` set) goes back to the page that asked for 1,000. That is
// exactly what a server with a cap of 500 answers.
//
// The volumes (`npm run seed:volume -- <lane>` of the API checkout) go into the lane's database for the tests that need them and are taken out again afterwards, so the
// specs that run later see the lane as the harness made it.
//
// Run: LANE=b JV_API_DIR=<checkout of jewelvault-api> E2E=1 npx playwright test tests/e2e/hydrate.spec.ts

const ROLES: readonly E2eRole[] = ['owner', 'biller', 'staff'];
/** The 15 sync resources of the API (A4), in the address form. */
const SYNC_RESOURCES = [
  'users',
  'settings',
  'daily-rates',
  'categories',
  'subcategories',
  'designs',
  'skus',
  'sku-private',
  'customers',
  'bills',
  'bill-summary',
  'bill-items',
  'receipts',
  'receipt-allocations',
  'customer-balances',
] as const;

// ------------------------------------------------------------------------------------------------ the page

/** The sidebar of the application (a page may have a second `aside`, like the inventory's filters, after it). */
const aside = (page: Page) => page.locator('aside').first();
/** No part of the application is on screen: no sidebar at all. */
const noApp = (page: Page) => expect(page.locator('aside')).toHaveCount(0);
const progress = (page: Page) => page.getByTestId('hydrate-progress');

async function openLoginScreen(page: Page) {
  await page.goto('/');
  await expect(page.getByLabel('Email')).toBeVisible();
}

async function submitLogin(page: Page, who: E2eLogin) {
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
}

/** Signs in through the screen; the caller says what to wait for (the gate, the app). */
async function signInAs(page: Page, who: E2eLogin) {
  await openLoginScreen(page);
  await submitLogin(page, who);
}

/** The application is on screen: the gate has opened and the sidebar names the person. */
async function expectApp(page: Page, who: E2eLogin, timeout = 60_000) {
  await expect(aside(page)).toContainText(who.fullName, { timeout });
}

/** Logs out through the screen and waits until the API has answered the logout. */
async function logout(page: Page) {
  const answered = page.waitForResponse(
    (response) =>
      response.url().endsWith('/v1/auth/logout') && response.request().method() === 'POST'
  );
  await aside(page).getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.getByLabel('Email')).toBeVisible();
  await answered;
}

interface SyncCall {
  resource: string;
  /** What the page asked for (before any change the test made on the way). */
  limit: string | null;
  updatedAfter: string | null;
  status: number | null;
}

/** Every sync page the browser asks the lane's API for (the poll is not a page), in the order asked, with the status it got. */
function trackSync(page: Page): SyncCall[] {
  const { apiUrl } = e2eLane();
  const calls: SyncCall[] = [];
  const mine = new Map<Request, SyncCall>();
  page.on('request', (request) => {
    if (!request.url().startsWith(`${apiUrl}/v1/sync/`)) return;
    const url = new URL(request.url());
    const resource = url.pathname.slice('/v1/sync/'.length);
    if (resource === 'poll') return;
    const call: SyncCall = {
      resource,
      limit: url.searchParams.get('limit'),
      updatedAfter: url.searchParams.get('updated_after'),
      status: null,
    };
    mine.set(request, call);
    calls.push(call);
  });
  page.on('response', (response) => {
    const call = mine.get(response.request());
    if (call) call.status = response.status();
  });
  return calls;
}

const resourcesOf = (calls: readonly SyncCall[]) =>
  Array.from(new Set(calls.map((c) => c.resource))).sort();

/** Everything JavaScript can read that the browser keeps: both Web Storage areas and the names of the IndexedDB databases. */
async function browserStorage(page: Page) {
  return page.evaluate(async () => {
    const dump = (store: Storage) => {
      const entries: Record<string, string> = {};
      for (let i = 0; i < store.length; i += 1) {
        const key = store.key(i) as string;
        entries[key] = store.getItem(key) ?? '';
      }
      return entries;
    };
    const databases = typeof indexedDB.databases === 'function' ? await indexedDB.databases() : [];
    return {
      local: dump(window.localStorage),
      session: dump(window.sessionStorage),
      databases: databases.map((d) => d.name ?? ''),
    };
  });
}

// ------------------------------------------------------------------------------------------------ the API, from this process

/** A call to the lane's API the way the site makes it, from this process (an Origin and X-JV-Client; the cookie when given). */
async function asSite(
  method: 'GET' | 'POST',
  path: string,
  options: { body?: unknown; cookie?: string } = {}
) {
  const { apiUrl, webOrigin } = e2eLane();
  const headers: Record<string, string> = { origin: webOrigin };
  if (method !== 'GET') headers['x-jv-client'] = 'web';
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  if (options.cookie) headers.cookie = options.cookie;
  const response = await fetch(`${apiUrl}${path}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const setCookie = response.headers.getSetCookie?.()[0];
  return {
    status: response.status,
    json: (await response.json().catch(() => null)) as unknown,
    cookie: setCookie ? setCookie.split(';')[0] : null,
  };
}

/** The session cookie of a login made from this process. */
async function apiSession(who: E2eLogin): Promise<string> {
  const login = await asSite('POST', '/v1/auth/login', {
    body: { email: who.email, password: who.password },
  });
  expect(login.status, 'the login of the oracle').toBe(200);
  return login.cookie ?? '';
}

/** Every row of a resource, read through the API's own pages by a loop that has nothing to do with the website's. */
async function allRows(
  cookie: string,
  resource: string,
  limit = 1000
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  let after = '';
  for (;;) {
    const page = await asSite('GET', `/v1/sync/${resource}?limit=${limit}${after}`, { cookie });
    expect(page.status, `the oracle's read of ${resource}`).toBe(200);
    const body = page.json as {
      rows: Array<Record<string, unknown>>;
      next: { updated_at: string; key: string } | null;
    };
    rows.push(...body.rows);
    if (!body.next) return rows;
    after = `&updated_after=${encodeURIComponent(body.next.updated_at)}&after_key=${encodeURIComponent(body.next.key)}`;
  }
}

// ------------------------------------------------------------------------------------------------ the lane's database (the container of this lane only)

function laneContainer(): string {
  const lane = process.env.LANE ?? '';
  const namespace = process.env.JV_LANE_NAMESPACE;
  return namespace ? `jv-mariadb-${namespace}-${lane}` : `jv-mariadb-${lane}`;
}

/** SQL as root in the lane's container. The password never leaves the container: the shell inside it reads it from its own environment. */
function laneSql(sql: string): string {
  return execFileSync(
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
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
  );
}

const today = () => new Date().toISOString().slice(0, 10);

/** Two daily rates (a gold and a silver one), as the owner's rate card would read them. */
function insertRates() {
  laneSql(
    `INSERT INTO daily_rates (id, material, purity, rate_per_gram, rate_date) VALUES ` +
      `(UUID_v4(), 'Gold', '22K', '7350.00', '${today()}'), (UUID_v4(), 'Silver', '925', '88.50', '${today()}')`
  );
}
const removeRates = () => laneSql(`DELETE FROM daily_rates WHERE rate_date = '${today()}'`);

// ------------------------------------------------------------------------------------------------ the S8 refusal a failing page gets

const refusal = (code: string, status: number) => ({
  status,
  contentType: 'application/json',
  headers: {
    'access-control-allow-origin': e2eLane().webOrigin,
    'access-control-allow-credentials': 'true',
  },
  body: JSON.stringify({
    error: { code, message: 'made up by the test', details: {} },
    request_id: 'req-test',
  }),
});

const syncResourceOf = (route: Route): string => {
  const url = new URL(route.request().url());
  return url.pathname.startsWith('/v1/sync/') ? url.pathname.slice('/v1/sync/'.length) : '';
};

// ------------------------------------------------------------------------------------------------ T-E05

test.describe('T-E05: the data gate (C2, C8, U7, U8)', () => {
  test.describe.configure({ timeout: 120_000 });

  test('after a session nothing is in browser storage, and the old jaishri.* keys are neither read nor wiped', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await openLoginScreen(page);
    // what the prototype left in this browser: if the new build read it, it would show on the screens
    const legacy: Record<string, string> = {
      'jaishri.designs.v1': JSON.stringify([
        {
          id: 'legacy-design',
          designNumber: 'OLD-00001',
          designName: 'Old sample necklace',
          skus: [],
        },
      ]),
      'jaishri.customers.v1': JSON.stringify([
        { id: 'legacy-customer', name: 'Old Sample Customer', mobile: '0' },
      ]),
      'jaishri.categories.v1': JSON.stringify(['Old sample category']),
      'jaishri.settings.v1': JSON.stringify({ estimate: { defaultGoldRate: 1234 } }),
    };
    await page.evaluate((keys) => {
      for (const [key, value] of Object.entries(keys)) window.localStorage.setItem(key, value);
    }, legacy);

    await submitLogin(page, owner);
    await expectApp(page, owner);
    const routes = [
      '/inventory-management',
      '/settings',
      '/add-design',
      '/print-tags',
      '/customer-ledger',
      '/reports',
      '/',
    ];
    for (const route of routes) {
      await page.goto(route);
      await expectApp(page, owner);
      const text = await page.locator('main').innerText();
      for (const old of [
        'OLD-00001',
        'Old sample necklace',
        'Old Sample Customer',
        'Old sample category',
      ]) {
        expect(text, `${route} shows ${old}`).not.toContain(old);
      }
    }
    const during = await browserStorage(page);
    expect(
      during.local,
      'localStorage holds the old keys exactly as they were, and nothing else'
    ).toEqual(legacy);
    expect(during.session).toEqual({});
    expect(during.databases).toEqual([]);

    await logout(page);
    const after = await browserStorage(page);
    expect(after.local).toEqual(legacy);
    expect(after.session).toEqual({});
    expect(after.databases).toEqual([]);
    expect(await page.evaluate(() => document.cookie)).toBe(''); // the session cookie cannot be read by the page (U12)
  });

  test('a failed load shows the error and a retry button, never sample data or an empty list, and the retry opens the app', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    let failing = true;
    let refused = 0;
    await page.route(`${apiUrl}/v1/sync/designs*`, async (route) => {
      if (!failing) return route.continue();
      refused += 1;
      return route.fulfill(refusal('JV_INTERNAL', 500));
    });
    await signInAs(page, owner);

    const alert = page.getByRole('alert').filter({ hasText: 'Something went wrong on the server' });
    await expect(alert).toBeVisible({ timeout: 60_000 });
    await expect(page.getByRole('heading', { name: 'The data could not be loaded' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Try again' })).toBeVisible();
    // nothing of the application, no sample data, no empty list
    await noApp(page);
    const body = await page.locator('body').innerText();
    for (const sample of [
      'Jaishri Bridal Kundan Necklace Set',
      'SET-00572',
      'Meera Sharma',
      'No designs yet',
      'Daily Metal Rates',
    ]) {
      expect(body, sample).not.toContain(sample);
    }
    expect(await browserStorage(page)).toEqual({ local: {}, session: {}, databases: [] });

    // a retry that fails again is the same screen; one that works opens the application
    await page.getByRole('button', { name: 'Try again' }).click();
    await expect(alert).toBeVisible();
    await expect.poll(() => refused).toBeGreaterThanOrEqual(2);
    failing = false;
    await page.getByRole('button', { name: 'Try again' }).click();
    await expectApp(page, owner);
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toBeVisible();
  });

  test('a page that never arrives (no connection) is the same error, and Sign out leaves for the login screen', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    await page.route(`${apiUrl}/v1/sync/customers*`, (route) => route.abort('failed'));
    await signInAs(page, owner);
    await expect(
      page.getByRole('alert').filter({ hasText: 'No connection to the server' })
    ).toBeVisible({ timeout: 60_000 });
    await noApp(page);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByLabel('Email')).toBeVisible();
  });

  test('no data page is shown until every table has arrived, and the gate says "3 of 8 tables" while it works', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    let releaseAll: () => void = () => undefined;
    let releaseCustomers: () => void = () => undefined;
    const holdAll = new Promise<void>((resolve) => (releaseAll = resolve));
    const holdCustomers = new Promise<void>((resolve) => (releaseCustomers = resolve));
    await page.route(`${apiUrl}/v1/sync/*`, async (route) => {
      const resource = syncResourceOf(route);
      if (resource === 'poll') return route.continue();
      await (resource === 'customers' ? holdCustomers : holdAll);
      return route.continue();
    });
    await signInAs(page, owner);

    // nothing has arrived: the count is 0 of the owner's 15 tables, and not a word of the application is on screen
    await expect(progress(page)).toHaveText('0 of 15 tables', { timeout: 60_000 });
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '0');
    await noApp(page);
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toHaveCount(0);

    // every table but one has arrived: 14 of 15, and still no application
    releaseAll();
    await expect(progress(page)).toHaveText('14 of 15 tables');
    await expect(page.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '14');
    await noApp(page);
    await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toHaveCount(0);

    releaseCustomers();
    await expectApp(page, owner);
    await expect(progress(page)).toHaveCount(0);
  });

  test('each role loads exactly the tables the API lets it read, in pages of 1,000 from the start, and every page is answered', async ({
    page,
  }) => {
    // the oracle: what the API says to each role, one resource at a time
    const allowed: Record<E2eRole, string[]> = { owner: [], biller: [], staff: [] };
    for (const role of ROLES) {
      const cookie = await apiSession(e2eLogin(role));
      for (const resource of SYNC_RESOURCES) {
        const answer = await asSite('GET', `/v1/sync/${resource}?limit=1`, { cookie });
        expect([200, 403], `${role} ${resource}`).toContain(answer.status);
        if (answer.status === 200) allowed[role].push(resource);
      }
      allowed[role].sort();
    }
    expect(allowed.owner).toHaveLength(15);
    expect(allowed.biller).not.toContain('sku-private');
    expect(allowed.staff).not.toContain('customers');

    const calls = trackSync(page);
    await openLoginScreen(page);
    for (const role of ROLES) {
      const who = e2eLogin(role);
      calls.length = 0;
      await submitLogin(page, who);
      await expectApp(page, who);
      expect(resourcesOf(calls), `${role} loads`).toEqual(allowed[role]);
      expect(
        calls.every((c) => c.status === 200),
        `${role}: every page answered 200`
      ).toBe(true);
      expect(
        calls.every((c) => c.limit === '1000'),
        `${role}: pages of 1,000`
      ).toBe(true);
      expect(calls.filter((c) => c.updatedAfter === null).length).toBe(allowed[role].length); // an empty lane: one page for each table
      await logout(page);
    }
  });

  test('the owner sees the rate card right after the gate, with the rate from memory; the biller and the staff do not (T-E01)', async ({
    page,
  }) => {
    insertRates();
    try {
      const owner = e2eLogin('owner');
      await signInAs(page, owner);
      await expectApp(page, owner);
      // no wait and no reload: the card is there as soon as the application is
      await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toBeVisible({
        timeout: 2000,
      });
      await expect(page.getByLabel('Gold Rate (per gram)')).toHaveValue('7350');
      await expect(page.getByLabel('Silver Rate (per gram)')).toHaveValue('88.5');
      await logout(page);

      for (const role of ['biller', 'staff'] as const) {
        const who = e2eLogin(role);
        await submitLogin(page, who);
        await expectApp(page, who);
        await expect(page.getByRole('heading', { name: 'Daily Metal Rates' })).toHaveCount(0);
        await logout(page);
      }
    } finally {
      removeRates();
    }
  });

  test('a page that reads the settings while it renders has them as soon as the gate opens (C9)', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    await signInAs(page, owner);
    await expectApp(page, owner);
    await page.goto('/settings?tab=business');
    await expectApp(page, owner);
    // `useState(() => getSettings())`: the seeded business name is in the form on the first render after the gate
    await expect(page.getByLabel('Display name')).toHaveValue('Jaishri Gold Palace', {
      timeout: 2000,
    });
    await expect(page.getByLabel('Legal name')).toHaveValue('Jaishri Gold Palace Pvt Ltd');
    await page.goto('/settings?tab=categories');
    await expectApp(page, owner);
    await expect(page.getByText('Necklace Set').first()).toBeVisible();
  });

  test('a session that ends while the load runs (a 401) empties memory, stops the load, shows the login screen once, and a new login loads everything again', async ({
    page,
    context,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    const calls = trackSync(page);
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    let holding = true;
    await page.route(`${apiUrl}/v1/sync/designs*`, async (route) => {
      if (holding) await held;
      return route.continue();
    });
    await signInAs(page, owner);
    await expect.poll(() => calls.some((c) => c.resource === 'designs')).toBe(true);

    // the person's session is ended on the server while the designs are still on their way (a logout in another tab, a deactivation)
    const cookie = (await context.cookies()).find((c) => c.name === '__Host-jv_session');
    expect(cookie, 'the session cookie is in the browser').toBeDefined();
    const ended = await asSite('POST', '/v1/auth/logout', {
      cookie: `${cookie?.name}=${cookie?.value}`,
    });
    expect(ended.status).toBe(200);
    holding = false;
    release();

    // the next page gets a 401: the login screen opens, and nothing more is asked for
    await expect(page.getByLabel('Email')).toBeVisible({ timeout: 30_000 });
    await noApp(page);
    const asked = calls.length;
    await page.waitForTimeout(1000);
    expect(calls).toHaveLength(asked);
    expect(await browserStorage(page)).toEqual({ local: {}, session: {}, databases: [] });

    // a new login loads every table again from the first page
    calls.length = 0;
    await submitLogin(page, owner);
    await expectApp(page, owner);
    expect(resourcesOf(calls)).toEqual([...SYNC_RESOURCES].sort());
    expect(calls.filter((c) => c.updatedAfter === null)).toHaveLength(15);
  });
});

// ------------------------------------------------------------------------------------------------ T-F03, PT-W3: the volumes

interface Oracle {
  designs: number;
  skus: number;
  inStock: number;
  customers: number;
  firstDesignId: string;
  originalWeight: string;
  firstDesignSkus: number;
}

test.describe('T-F03, PT-W3: 2,500 pieces, 2,000 customers and the stock side arrive in full, with progress shown', () => {
  test.describe.configure({ mode: 'serial', timeout: 180_000 });

  let oracle: Oracle;
  let countersBefore: string[] = [];

  test.beforeAll(async () => {
    test.setTimeout(300_000);
    const lane = process.env.LANE ?? '';
    const apiDir = process.env.JV_API_DIR ?? '';
    countersBefore = laneSql('SELECT series FROM sys_counters').split('\n').filter(Boolean);
    // the API checkout's own command, which refuses a database that is not empty; it reads the lane's database password from Docker in memory
    const keep = ['PATH', 'HOME', 'TMPDIR', 'LANG', 'JV_LANE_NAMESPACE', 'JV_LANE_PORT_BASE'];
    const env = Object.fromEntries(
      keep.filter((n) => process.env[n] !== undefined).map((n) => [n, process.env[n] as string])
    ) as NodeJS.ProcessEnv;
    execFileSync('npm', ['run', '--silent', 'seed:volume', '--', lane], {
      cwd: apiDir,
      env,
      stdio: 'pipe',
      timeout: 240_000,
    });

    // what the shop holds, counted through the API by a loop of its own
    const cookie = await apiSession(e2eLogin('owner'));
    const designs = await allRows(cookie, 'designs');
    const skus = await allRows(cookie, 'skus');
    const customers = await allRows(cookie, 'customers');
    const privates = await allRows(cookie, 'sku-private');
    const first = designs[0] as { id: string };
    // the screen lists a design's pieces by piece number: its first row is the first by that order
    const ofFirst = (
      skus.filter((s) => s.design_id === first.id) as Array<{ id: string; sku_no: string }>
    ).sort((a, b) => a.sku_no.localeCompare(b.sku_no));
    const weight = privates.find((p) => p.sku_id === ofFirst[0].id) as {
      original_net_weight: string;
    };
    oracle = {
      designs: designs.length,
      skus: skus.length,
      inStock: skus.filter((s) => s.status === 'In Stock').length,
      customers: customers.length,
      firstDesignId: first.id,
      originalWeight: weight.original_net_weight,
      firstDesignSkus: ofFirst.length,
    };
  });

  test.afterAll(() => {
    // the lane goes back to what the harness made: its users and sessions stay, the shop goes. (root, in this lane's container; nothing here is Delete for the API's own user.)
    const keepSeries = countersBefore.map((s) => `'${s.replace(/'/g, "''")}'`).join(',');
    laneSql(
      'SET FOREIGN_KEY_CHECKS=0; ' +
        'TRUNCATE receipt_allocations; TRUNCATE receipts; TRUNCATE bill_items; TRUNCATE bills; TRUNCATE sku_private; TRUNCATE skus; TRUNCATE designs; ' +
        'DELETE FROM customers WHERE is_walkin = 0; TRUNCATE sys_import_batches; ' +
        `DELETE FROM sys_counters ${keepSeries ? `WHERE series NOT IN (${keepSeries})` : ''}; ` +
        `UPDATE settings SET value = JSON_OBJECT('epoch', '1970-01-01 00:00:00.000000') WHERE setting_key = 'data_epoch'; ` +
        'SET FOREIGN_KEY_CHECKS=1'
    );
  });

  /** Counts what the inventory header says: "600 designs · 2500 SKUs · 400 in stock". */
  async function expectInventory(page: Page) {
    await expect(
      page.getByText(`${oracle.designs} designs · ${oracle.skus} SKUs · ${oracle.inStock} in stock`)
    ).toBeVisible({ timeout: 60_000 });
  }

  const pagesOf = (rows: number, size: number) => Math.floor(rows / size) + 1; // a page that is exactly full costs one more, empty, call

  test('the volumes are what C2 says: 2,500 pieces and 2,000 customers (the walk-in is one)', () => {
    expect(oracle.skus).toBe(2500);
    expect(oracle.customers).toBe(2000);
    expect(oracle.designs).toBe(600);
  });

  test('2,500 pieces all load, in pages of 1,000, with progress shown; the screens that count them agree', async ({
    page,
  }, testInfo) => {
    const owner = e2eLogin('owner');
    const calls = trackSync(page);
    // the progress, as the page showed it: every text the gate had
    await page.addInitScript(() => {
      const seen: string[] = [];
      (window as unknown as { __progress: string[] }).__progress = seen;
      new MutationObserver(() => {
        const text = document.querySelector('[data-testid="hydrate-progress"]')?.textContent;
        if (text && seen[seen.length - 1] !== text) seen.push(text);
      }).observe(document, { subtree: true, childList: true, characterData: true });
    });
    await openLoginScreen(page);
    const started = Date.now();
    await submitLogin(page, owner);
    await expectApp(page, owner, 120_000);
    const seconds = (Date.now() - started) / 1000;
    testInfo.annotations.push({
      type: 'hydrate-seconds-on-this-computer',
      description: seconds.toFixed(1),
    });
    console.info(
      `hydrate of the volumes, login click to application: ${seconds.toFixed(1)} s (the 4G budget is measured on staging, OPS04)`
    );

    const shown = await page.evaluate(
      () => (window as unknown as { __progress: string[] }).__progress
    );
    expect(shown.length).toBeGreaterThan(0);
    const done = shown.map((text) => Number(/^(\d+) of 15 tables$/.exec(text)?.[1]));
    expect(done.every((n) => Number.isInteger(n))).toBe(true);
    expect(done).toEqual([...done].sort((a, b) => a - b)); // the count only goes up

    const skuCalls = calls.filter((c) => c.resource === 'skus');
    expect(skuCalls).toHaveLength(pagesOf(oracle.skus, 1000));
    expect(skuCalls.every((c) => c.limit === '1000' && c.status === 200)).toBe(true);
    expect(calls.filter((c) => c.resource === 'customers')).toHaveLength(
      pagesOf(oracle.customers, 1000)
    );
    expect(calls.every((c) => c.status === 200)).toBe(true);

    await page.goto('/inventory-management');
    await expectApp(page, owner);
    await expectInventory(page);
  });

  test("2,500 pieces all load also when the API's page cap is 500: the page asked for 1,000, got 500 and followed the cursor", async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const { apiUrl } = e2eLane();
    const calls = trackSync(page);
    const sentOn: Array<{ resource: string; limit: string | null }> = [];
    await page.route(`${apiUrl}/v1/sync/*`, async (route) => {
      const url = new URL(route.request().url());
      const resource = syncResourceOf(route);
      if (resource === 'poll') return route.continue();
      url.searchParams.set('limit', '500'); // a server whose pages hold 500 rows at most
      sentOn.push({ resource, limit: url.searchParams.get('limit') });
      const response = await route.fetch({ url: url.toString() });
      return route.fulfill({ response });
    });
    await signInAs(page, owner);
    await expectApp(page, owner, 120_000);

    const skuCalls = calls.filter((c) => c.resource === 'skus');
    expect(skuCalls.every((c) => c.limit === '1000')).toBe(true); // the page still asked for its 1,000...
    expect(skuCalls).toHaveLength(pagesOf(oracle.skus, 500)); // ...and followed what it was given: five full pages of 500, then the empty one
    expect(calls.filter((c) => c.resource === 'customers')).toHaveLength(
      pagesOf(oracle.customers, 500)
    );
    expect(calls.filter((c) => c.resource === 'designs')).toHaveLength(
      pagesOf(oracle.designs, 500)
    );
    expect(calls.every((c) => c.status === 200)).toBe(true);
    expect(sentOn.length).toBe(calls.length);

    await page.goto('/inventory-management');
    await expectApp(page, owner);
    await expectInventory(page);
  });

  test('the owner-only weight is in memory for the owner alone, and a logout empties it: the next person on the same screen does not get it', async ({
    page,
  }) => {
    const owner = e2eLogin('owner');
    const biller = e2eLogin('biller');
    const design = `/design-detail?id=${oracle.firstDesignId}`;
    const toggle = page.getByRole('button', { name: 'Show Original NW (Admin)' });
    const originalColumn = page.locator('td.text-amber-700');

    await signInAs(page, owner);
    await expectApp(page, owner, 120_000);
    await page.goto(design);
    await expectApp(page, owner, 120_000);
    await toggle.click();
    await expect(originalColumn).toHaveCount(oracle.firstDesignSkus);
    // the figure of the first piece is the one the API holds for the owner, shown with three decimals
    await expect(originalColumn.first()).toContainText(
      `${Number(oracle.originalWeight).toFixed(3)} g`
    );

    // the same screen, another person, no reload: the owner's rows are gone from memory, the biller's own load did not ask for them
    const calls = trackSync(page);
    await logout(page);
    await submitLogin(page, biller);
    await expectApp(page, biller, 120_000);
    expect(calls.map((c) => c.resource)).not.toContain('sku-private');
    await expect(page.getByText('Physical SKUs')).toContainText(`${oracle.firstDesignSkus} pieces`);
    await toggle.click();
    await expect(originalColumn).toHaveCount(oracle.firstDesignSkus);
    for (const text of await originalColumn.allInnerTexts()) expect(text.trim()).toBe('—');
  });
});
